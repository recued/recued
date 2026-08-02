/**
 * Full-app webclient render harness (Playwright e2e, "Path B" — fake transport).
 *
 * The whole PWA — every IA route — dispatches INSIDE the paired bootstrap, so a
 * cold staging load (no paired recued-server) only ever shows the pair-form
 * (staging-smoke.spec covers that). The REAL end-to-end (a booted server + the
 * pair→WS handshake) lives in internal benchmarks
 * and produces the populated screenshots; that rig proves the data-render path.
 *
 * This harness is the REPEATABLE, server-free twin: it boots the SAME app the
 * bootstrap dispatches — `bootstrapWebclient` — but against the deterministic
 * fakes the `src/__tests__/webclient-bootstrap.test.ts` suite already proves
 * boot the full shell (a paired in-memory local store, an echo token store, a
 * loopback WS transport, a manual hash source). No crypto pairing, no network,
 * no server. It's the jsdom bootstrap acceptance lifted into a real Chromium —
 * real CSS, real layout, screenshottable — so `full-app.spec.ts` can drive each
 * route hash and assert it MOUNTS + RENDERS without throwing.
 *
 * Scope, honestly: the fake transport answers the small set of reads needed to
 * render the deterministic first-run Chat and Connections landings, the empty
 * recipe handoff, one populated Attention queue, and one populated run →
 * affected record verification journey.
 * Other route rpcs stay pending, so those routes render their real shell +
 * loading placeholders. Mount + real-browser render + client-side interaction
 * is exactly what this proves; the broad populated visual pass remains
 * render.mjs's job. The
 * route-root marker (`data-recued-<route>-route`) is stamped synchronously by
 * every route the instant it mounts — before any rpc — so it is the durable
 * "this route mounted" signal (the same contract the unit suite asserts).
 *
 * `window.__app` exposes the drive hooks the spec uses:
 *   - `ready`          — true once `bootstrapWebclient` resolved.
 *   - `setHash(hash)`  — drive navigation (fires the hash listener → re-mount).
 *   - `activeRoute()`  — the bootstrap's tracked active route id.
 *   - `fireMessage(m)` — inject an inbound WS frame (e.g. a server_heartbeat).
 *   - `releaseServerControlResponses()` — settle held pause/restart RPCs.
 */
import {
  bootstrapWebclient,
  type WebclientHandle,
  type WebclientHashSource,
} from '../../src/webclient-bootstrap.js';
import {
  queueStartupRecoveryForNextAttempt,
  runBootstrapWithPairFallback,
  type PairFallbackBootstrapDeps,
} from '../../src/boot/pair-fallback-bootstrap.js';
import {
  consumeStartupReloadRecovery,
  requestStartupRecoveryReload,
} from '../../src/boot/startup-reload-recovery.js';
import {
  armRecoveryReentry,
  armReplacementServerRecoveryReentry,
  armSafeStopRecoveryReentry,
  consumeRecoveryReentryState,
  retireRecoveryReentry,
  scrubRecoveryReentryAddress,
} from '../../src/boot/recovery-reentry.js';
import {
  COLD_START_CREDENTIAL_SETTLE_MS,
  announceColdStartCredentialCheck,
  inspectColdStartCredentials,
  startColdStartCredentialRepair,
} from '../../src/boot/cold-start-credential-repair.js';
import { createBrowserPairTabConvergence } from '../../src/boot/pair-tab-convergence.js';
import {
  openPersistentStorageWithRecovery,
  PersistentStorageStartupError,
} from '../../src/boot/persistent-storage-startup.js';
import {
  mountSecureAccessHandoff,
  type MountedSecureAccessHandoff,
} from '../../src/boot/secure-access-handoff.js';
import {
  INSECURE_CONTEXT_SPLASH_MESSAGE,
} from '../../src/boot/secure-context-guard.js';
import { parsePairEntryHandoff } from '../../src/boot/secure-access-resume.js';
import type {
  WebclientLocalKey,
  WebclientLocalStorage,
  WebclientTokenRecord,
} from '@recued/contracts';
import {
  createIndexedDbWebclientLocalStore,
  createInMemoryWebclientLocalStore,
  type IndexedDbKeyValue,
  type WebclientLocalStore,
  type WebclientProfileAwareStore,
} from '../../src/storage/local-store.js';
import type {
  WebclientTokenStore,
  WebclientTokenAad,
} from '../../src/storage/token-store.js';
import {
  RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
  RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
} from '../../src/shell/recovery-intent-continuation.js';
import {
  WebclientReauthRequiredError,
  type WebclientWsState,
  type WebclientWsTransport,
} from '../../src/realtime/ws-client.js';

// ──────────────────────────────────────────────────────────────────
// Fakes — ported verbatim from webclient-bootstrap.test.ts (the shapes
// that suite proves boot the full app). Only the import depth changed
// (`../` → `../../src/`); the semantics are identical so the browser boot
// matches the jsdom acceptance byte-for-byte.
// ──────────────────────────────────────────────────────────────────

const FIXED_NOW = 1_700_000_000_000;

const sampleToken = (token_id = 'tok-abc'): WebclientTokenRecord => ({
  token_id,
  ciphertext_b64: 'ZmFrZS1jaXBoZXJ0ZXh0', // base64('fake-ciphertext')
  iv_b64: 'ZmFrZS1pdg==', // base64('fake-iv')
  issued_at: FIXED_NOW,
});

const buildPairedStore = (): WebclientProfileAwareStore =>
  createInMemoryWebclientLocalStore({
    server_url: 'wss://alice.recued.cloud:8443/ws',
    server_public_key: 'spki-base64',
    webclient_token: sampleToken(),
    pair_metadata: {
      paired_at: FIXED_NOW,
      server_passport_fingerprint: 'fp',
      server_handle_at_pair: 'alice',
      instance_id: 'browser-demo',
    },
    cert_pin_state: null,
  });

/** Durable same-origin profile store for the deliberate-switch browser
 * journey. A document reload must observe the selected target; the ordinary
 * in-memory harness intentionally resets and therefore cannot prove that. */
const SERVER_SWITCH_PROFILE_STORAGE_KEY =
  'recued.e2e.server-switch-profile-store.v1';
const buildServerSwitchProfileStore = (): WebclientProfileAwareStore => {
  const read = (): Record<string, unknown> => {
    const raw = window.localStorage.getItem(SERVER_SWITCH_PROFILE_STORAGE_KEY);
    if (raw === null) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  if (window.localStorage.getItem(SERVER_SWITCH_PROFILE_STORAGE_KEY) === null) {
    window.localStorage.setItem(
      SERVER_SWITCH_PROFILE_STORAGE_KEY,
      JSON.stringify({
        server_url: 'wss://alice.recued.cloud:8443/ws',
        server_public_key: 'spki-base64',
        webclient_token: sampleToken(),
        pair_metadata: {
          paired_at: FIXED_NOW,
          server_passport_fingerprint: 'fp',
          server_handle_at_pair: 'alice',
          instance_id: 'browser-demo',
        },
        cert_pin_state: null,
      }),
    );
  }
  const write = (value: Record<string, unknown>): void => {
    window.localStorage.setItem(
      SERVER_SWITCH_PROFILE_STORAGE_KEY,
      JSON.stringify(value),
    );
  };
  const kv: IndexedDbKeyValue = {
    async get(key) { return read()[key]; },
    async set(key, value) { write({ ...read(), [key]: value }); },
    async delete(key) {
      const next = read();
      delete next[key];
      write(next);
    },
    async clear() {
      window.localStorage.removeItem(SERVER_SWITCH_PROFILE_STORAGE_KEY);
    },
    async keys() { return Object.keys(read()); },
  };
  return createIndexedDbWebclientLocalStore(kv, { lockProvider: null });
};

/** Same-origin durable-store stand-in used only by the multi-tab journey. Each
 * page owns a fresh WebclientLocalStore facade while the serialized record is
 * shared by Chromium, matching separate tabs over one IndexedDB database. */
const MULTI_TAB_PAIR_STORAGE_KEY = 'recued.e2e.multi-tab-pair-state';
const MULTI_TAB_TRANSITION_STAGE_KEY =
  'recued.e2e.multi-tab-transition-stage';
const MULTI_TAB_TRANSITION_RELEASE_KEY =
  'recued.e2e.multi-tab-transition-release';
const MULTI_TAB_TAKEOVER_REQUEST_COUNT_KEY =
  'recued.e2e.multi-tab-takeover-request-count';
const buildMultiTabPairStore = (): WebclientLocalStore => {
  const params = new URLSearchParams(window.location.search);
  const pairTransitionPaused =
    (
      params.get('journey') === 'multi-tab-transition'
      || params.get('journey') === 'multi-tab-credentials'
    )
    && params.get('pause_pair') === '1';
  const pairTransitionFailsOnce =
    params.get('journey') === 'multi-tab-transition'
    && params.get('fail_pair_once') === '1';
  let pairTransitionInterrupted = false;
  const read = (): Partial<WebclientLocalStorage> => {
    const raw = window.localStorage.getItem(MULTI_TAB_PAIR_STORAGE_KEY);
    if (raw === null) return {};
    try {
      return JSON.parse(raw) as Partial<WebclientLocalStorage>;
    } catch {
      return {};
    }
  };
  const write = (data: Partial<WebclientLocalStorage>): void => {
    window.localStorage.setItem(
      MULTI_TAB_PAIR_STORAGE_KEY,
      JSON.stringify(data),
    );
  };
  return {
    async get<K extends WebclientLocalKey>(key: K) {
      return (read()[key] ?? null) as WebclientLocalStorage[K] | null;
    },
    async set<K extends WebclientLocalKey>(
      key: K,
      value: WebclientLocalStorage[K],
    ) {
      write({ ...read(), [key]: value });
      // Hold the source tab after the first pair-finalize write. A cold third
      // tab/reload then starts against real shared partial state while the
      // source still owns the browser's pair-finalize Web Lock.
      if (
        key === 'pair_metadata'
        && pairTransitionPaused
        && window.localStorage.getItem(MULTI_TAB_TRANSITION_STAGE_KEY) === null
      ) {
        window.localStorage.setItem(
          MULTI_TAB_TRANSITION_STAGE_KEY,
          'pair_metadata',
        );
        const deadline = Date.now() + 15_000;
        while (
          window.localStorage.getItem(MULTI_TAB_TRANSITION_RELEASE_KEY) !== '1'
        ) {
          if (Date.now() >= deadline) {
            throw new Error(
              'full-app multi-tab transition harness: pair release timed out',
            );
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
        }
      }
      // Model a tab/network/storage interruption AFTER `/auth/pair` succeeded
      // and after several local fields landed. The page-local latch lets this
      // same tab's local-only retry complete while the shared partial record
      // remains visible to sibling/cold-arrival tabs.
      if (
        key === 'server_url'
        && pairTransitionFailsOnce
        && !pairTransitionInterrupted
      ) {
        pairTransitionInterrupted = true;
        throw new Error(
          'full-app multi-tab transition harness: local save interrupted once',
        );
      }
    },
    async remove(key) {
      const data = read();
      delete data[key];
      write(data);
    },
    async inspect() {
      const data = read();
      return {
        server_url: data.server_url ?? null,
        webclient_token: data.webclient_token ?? null,
        server_public_key: data.server_public_key ?? null,
        pair_metadata: data.pair_metadata ?? null,
        cert_pin_state: data.cert_pin_state ?? null,
      };
    },
    async clear() {
      window.localStorage.removeItem(MULTI_TAB_PAIR_STORAGE_KEY);
    },
  };
};

const buildFakeTokenStore = (): WebclientTokenStore => ({
  async wrap({ token_id }) {
    return sampleToken(token_id);
  },
  async unwrap(record: WebclientTokenRecord, _aad: WebclientTokenAad) {
    return `bearer-${record.token_id}`;
  },
});

interface FakeTransportControls {
  transport: WebclientWsTransport;
  setServerAvailable(available: boolean): void;
  forceReauth(): void;
  rpcCallCount(method: string): number;
  releaseServerControlResponses(): number;
  fireState(state: WebclientWsState): void;
  fireMessage(message: unknown): void;
}

const buildFakeTransport = (
  initialAiConfigured = true,
  withChatSession = false,
  delayAiRead = false,
  oauthConfigured = false,
  firstSyncDemo = false,
  connectedSourceReadyDemo = false,
  connectedSourceAnswerDemo = false,
  verificationJourneyDemo = false,
  attentionDemo = false,
  holdServerControlResponse = false,
  resolveContractsReads = false,
): FakeTransportControls => {
  const states = new Set<(s: WebclientWsState) => void>();
  const messages = new Set<(m: unknown) => void>();
  const rpcCallCounts = new Map<string, number>();
  const heldServerControlResponses: Array<() => void> = [];
  let serverAvailable = true;
  let rejectNextOpenForReauth = false;
  const llmConfig: Record<string, unknown> = initialAiConfigured
    ? {
        slot_1: {
          provider: 'openai',
          model: 'gpt-4.1-mini',
          has_key: true,
        },
      }
    : {};
  let defaultSourceId: 'slot_1' | 'slot_2' | 'free_pool' | null =
    initialAiConfigured ? 'slot_1' : null;
  let mailConnected = connectedSourceReadyDemo || connectedSourceAnswerDemo;
  let serverPaused = false;
  let mailListReads = 0;
  let sourceAnswerSessionCreated = false;
  let sourceAnswerSendCount = 0;
  const sourceAnswerMessages: Array<Record<string, unknown>> = [];
  const sourceAnswerSession = {
    id: 'chat_source_1',
    title: 'Using my work mailbox',
    created_at: FIXED_NOW,
    last_active_at: FIXED_NOW,
    archived: false,
    picker_state: { current: 'self' as const },
    model_routing: {
      current: 'byok' as const,
      provider: 'openai',
      model_id: 'gpt-4.1-mini',
      model_hint: 'fast' as const,
      source_id: 'slot_1' as const,
      overridden: false,
    },
  };
  const mailInstances = (): ReadonlyArray<Record<string, unknown>> => {
    if (
      !firstSyncDemo
      && !connectedSourceReadyDemo
      && !connectedSourceAnswerDemo
    ) return [];
    mailListReads += 1;
    if (!mailConnected) return [];
    return [{
      slug: 'work',
      adapter_type: 'gmail',
      auth_state: 'healthy',
      // Initial route list = read 1; post-enroll refresh = read 2 (pending);
      // two quiet panel polls keep the pending state observable, then ready.
      last_synced_at:
        connectedSourceReadyDemo
        || connectedSourceAnswerDemo
        || mailListReads >= 4
        ? FIXED_NOW
        : null,
      send_capable: false,
      account_email: 'person@example.com',
    }];
  };
  const sourceAnswerMailRecord = {
    record_id: 'mail-1',
    received_at: FIXED_NOW - 20_000,
    modified_at: FIXED_NOW - 10_000,
    hot_fields: {
      subject: 'Quarterly planning',
      from: 'lead@example.com',
      folder: 'inbox',
      is_read: false,
    },
    size_bytes: 42,
    source_id: 'provider-mail-1',
    body_inline: 'Please review the quarterly plan before Friday.',
  };
  const verificationRun = {
    run_id: 'run-verify',
    recipe_id: 'calendar/schedule-review',
    name: 'Schedule customer review',
    started_at: FIXED_NOW - 4_000,
    finished_at: FIXED_NOW - 2_000,
    duration_ms: 2_000,
    origin: {
      actor: 'user_self',
      label: 'user_self',
      channel: 'user',
    },
    status: 'in_doubt',
    policy_result: 'released-after-approval',
    links: [{
      entity_id: 'calendar:event-1',
      kind: 'execution.write',
      ts: FIXED_NOW - 2_500,
    }],
  };
  const verificationRunDetail = {
    audit: {
      run_id: verificationRun.run_id,
      recipe_id: verificationRun.recipe_id,
      recipe_hash: 'hash-verification-run',
      started_at: verificationRun.started_at,
      finished_at: verificationRun.finished_at,
      duration_ms: verificationRun.duration_ms,
      status: verificationRun.status,
      origin: verificationRun.origin,
      trigger_source: 'manual',
      instance_id: 'server-verification',
      errors: [],
    },
    approvals: {
      checkpoints: [],
      outcome: 'allow',
    },
    errors: [],
    links: verificationRun.links,
    gateway: {
      policy_result: verificationRun.policy_result,
      per_call_trace: [],
    },
  };
  const verificationCalendarRecord = {
    record_id: 'event-1',
    received_at: FIXED_NOW - 3_000,
    modified_at: FIXED_NOW - 2_000,
    hot_fields: {
      summary: 'Customer review',
      start_at: FIXED_NOW + 86_400_000,
      end_at: FIXED_NOW + 90_000_000,
      location: 'Video call',
    },
    size_bytes: 96,
    source_id: 'provider-event-1',
    body_inline: 'Review the launch plan with the customer success team.',
  };
  const attentionApproval = {
    approval_id: 'approval-attention-1',
    recipe_id: 'crm/update-contact',
    step_id: 'update-company',
    ingredient_slug: 'hubspot-contact-update',
    risk_tier: 'write',
    description: 'Update Acme\'s account owner in HubSpot',
    resolved_input: {
      company: 'Acme',
      owner: 'Jordan Lee',
    },
    created_at: FIXED_NOW - 2_000,
    timeout_at: FIXED_NOW + 300_000,
    initiator_instance: 'browser-demo',
  };
  const attentionAsk = {
    ask_id: 'ask-attention-1',
    title: 'Send the customer follow-up?',
    text: 'This will send one email to customer@example.com.',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    created_at: FIXED_NOW - 1_000,
  };
  return {
    transport: {
      async open() {
        if (rejectNextOpenForReauth) {
          rejectNextOpenForReauth = false;
          throw new WebclientReauthRequiredError(
            'saved bearer rejected by the server',
          );
        }
        // Mirror the production transport's handshake-complete signal so the
        // connection controller and Account status render a `connected` frame.
        // Recovery acceptance can hold the server unavailable across the client's
        // automatic re-open attempts; a resolved open without a connected
        // frame leaves the real status controller on its offline path.
        if (!serverAvailable) return;
        for (const l of [...states]) l('connected');
      },
      async close() {
        /* no-op */
      },
      async send(payload) {
        const rpc = payload as {
          type?: unknown;
          request_id?: unknown;
          method?: unknown;
          args?: unknown;
        };
        if (
          rpc.type !== 'rpc'
          || typeof rpc.request_id !== 'string'
          || typeof rpc.method !== 'string'
        ) {
          return;
        }
        rpcCallCounts.set(
          rpc.method,
          (rpcCallCounts.get(rpc.method) ?? 0) + 1,
        );
        let result: unknown = rpc.method === 'chat.sessions.list'
          ? {
              sessions: withChatSession
                ? [
                    {
                      id: 'chat_1',
                      title: 'Planning chat',
                      created_at: FIXED_NOW - 2_000,
                      last_active_at: FIXED_NOW - 1_000,
                      message_count: 1,
                      archived: false,
                      picker_state: { current: 'self' },
                      model_routing: {
                        current: 'byok',
                        provider: 'openai',
                        overridden: false,
                      },
                    },
                  ]
                : [],
            }
          : rpc.method === 'chat.session.get' && withChatSession
            ? {
                id: 'chat_1',
                title: 'Planning chat',
                created_at: FIXED_NOW - 2_000,
                last_active_at: FIXED_NOW - 1_000,
                archived: false,
                picker_state: { current: 'self' },
                model_routing: {
                  current: 'byok',
                  provider: 'openai',
                  model_id: 'gpt-4.1-mini',
                  overridden: false,
                },
                messages: [],
              }
            : rpc.method === 'server.getLLMConfig'
              ? { config: { ...llmConfig } }
              : rpc.method === 'chat.default_model_pref.get'
                ? { source_id: defaultSourceId, updated_at: FIXED_NOW }
                : rpc.method === 'prefs.get'
                  ? { prefs: {} }
                  : rpc.method === 'recipe.list'
                    ? { recipes: [] }
                    : rpc.method === 'auto_run.list'
                      ? { entries: [] }
                      : rpc.method === 'collection.mail.list'
                        ? { instances: mailInstances() }
                        : rpc.method === 'collection.calendar.list'
                          ? { instances: [] }
                          : rpc.method === 'collection.listInstances'
                            ? { instances: [] }
                            : rpc.method === 'server.getOAuthClientConfig' && firstSyncDemo
                              ? {
                                  gmail: { client_id: 'GOOGLE-CID' },
                                  gcal: { client_id: 'GOOGLE-CID' },
                                  graph: { client_id: 'MICROSOFT-CID' },
                                }
                              : rpc.method === 'server.getOAuthAppConfig'
                              ? oauthConfigured || firstSyncDemo
                                ? {
                                    google: {
                                      client_id: 'GOOGLE-CID',
                                      has_secret: true,
                                      source: 'stored',
                                    },
                                    microsoft: {
                                      client_id: 'MICROSOFT-CID',
                                      has_secret: true,
                                      source: 'env',
                                    },
                                  }
                                : {
                                    google: {
                                      client_id: null,
                                      has_secret: false,
                                      source: null,
                                    },
                                    microsoft: {
                                      client_id: null,
                                      has_secret: false,
                                      source: null,
                                    },
                                  }
                              : undefined;
        if (rpc.method === 'chat.sessions.list' && connectedSourceAnswerDemo) {
          result = {
            sessions: sourceAnswerSessionCreated
              ? [{
                  ...sourceAnswerSession,
                  message_count: sourceAnswerMessages.length,
                }]
              : [],
          };
        }
        if (
          rpc.method === 'chat.session.get'
          && connectedSourceAnswerDemo
          && sourceAnswerSessionCreated
        ) {
          result = {
            ...sourceAnswerSession,
            messages: [...sourceAnswerMessages],
          };
        }
        if (rpc.method === 'chat.session.create' && connectedSourceAnswerDemo) {
          sourceAnswerSessionCreated = true;
          result = { session_id: sourceAnswerSession.id };
        }
        if (rpc.method === 'chat.send' && withChatSession) {
          result = { turn_id: 'turn_plan_continue_1' };
        }
        if (
          rpc.method === 'chat.data_diagnosis.resolve'
          && withChatSession
        ) {
          const status = (
            rpc.args as { status?: unknown }
          ).status;
          result = {
            resolution: {
              status,
              resolved_at: FIXED_NOW + 5_000,
            },
          };
        }
        if (
          (rpc.method === 'chat.plan.approve'
            || rpc.method === 'chat.plan.cancel')
          && withChatSession
        ) {
          const planId = (rpc.args as { plan_id?: unknown }).plan_id;
          result = {
            plan: {
              plan_id:
                typeof planId === 'string' ? planId : 'plan_email_1',
              session_id: 'chat_1',
              turn_id: 'turn_plan_1',
              tool: 'mail.send',
              tier: 2,
              classification: 'write',
              args: {
                to: 'mary@example.com',
                subject: 'Quarterly planning follow-up',
                body: 'Thanks for the update. I’ll review this before Friday.',
              },
              args_hash: 'e2e-plan-hash',
              status:
                rpc.method === 'chat.plan.approve'
                  ? 'approved'
                  : 'cancelled',
              created_at: FIXED_NOW + 1,
              resolved_at: FIXED_NOW + 2,
            },
          };
        }
        if (rpc.method === 'chat.send' && connectedSourceAnswerDemo) {
          sourceAnswerSendCount += 1;
          const args = rpc.args as {
            session_id?: unknown;
            message?: unknown;
          };
          if (
            typeof args.session_id === 'string'
            && typeof args.message === 'string'
          ) {
            sourceAnswerMessages.push({
              id: `msg_source_user_${sourceAnswerSendCount}`,
              session_id: args.session_id,
              role: 'user',
              content: args.message,
              target_server: 'self',
              picker_at_send: {
                display_name: 'This server',
                signature: {
                  server_kind: 'recued',
                  version: 'test',
                  instance_id: 'server-source-answer',
                },
              },
              model_used: {
                provider: 'openai',
                model_id: 'gpt-4.1-mini',
              },
              contributor: 'user',
              ts: FIXED_NOW + sourceAnswerSendCount,
            });
          }
          result = { turn_id: `turn_source_${sourceAnswerSendCount}` };
        }
        if (
          rpc.method === 'collection.listInstances'
          && connectedSourceAnswerDemo
        ) {
          result = {
            instances: [
              {
                slug: 'personal',
                platform: 'mail',
                adapter_type: 'gmail',
                caps: {},
                auth_state: 'healthy',
                last_synced_at: FIXED_NOW,
              },
              {
                slug: 'work',
                platform: 'mail',
                adapter_type: 'gmail',
                caps: {},
                auth_state: 'healthy',
                last_synced_at: FIXED_NOW,
              },
            ],
          };
        }
        if (rpc.method === 'collection.list' && connectedSourceAnswerDemo) {
          const args = rpc.args as { platform?: unknown; slug?: unknown };
          result = {
            records:
              args.platform === 'mail' && args.slug === 'work'
                ? [sourceAnswerMailRecord]
                : [],
          };
        }
        if (rpc.method === 'collection.get' && connectedSourceAnswerDemo) {
          const args = rpc.args as {
            platform?: unknown;
            slug?: unknown;
            record_id?: unknown;
          };
          result = {
            record:
              args.platform === 'mail'
              && args.slug === 'work'
              && args.record_id === sourceAnswerMailRecord.record_id
                ? sourceAnswerMailRecord
                : null,
          };
        }
        if (verificationJourneyDemo) {
          if (rpc.method === 'execution.list') {
            result = { runs: [verificationRun] };
          } else if (rpc.method === 'execution.get') {
            const args = rpc.args as { run_id?: unknown };
            result = {
              run:
                args.run_id === verificationRun.run_id
                  ? verificationRunDetail
                  : null,
            };
          } else if (rpc.method === 'execution.active') {
            result = { entries: [], lanes: [] };
          } else if (
            rpc.method === 'collection.contract.session_grant.list'
          ) {
            result = { grants: [] };
          } else if (rpc.method === 'collection.listInstances') {
            result = {
              instances: [{
                slug: 'work',
                platform: 'calendar',
                adapter_type: 'gcal',
                caps: {},
                auth_state: 'healthy',
                last_synced_at: FIXED_NOW,
              }],
            };
          } else if (rpc.method === 'collection.list') {
            const args = rpc.args as {
              platform?: unknown;
              slug?: unknown;
            };
            result = {
              records:
                args.platform === 'calendar' && args.slug === 'work'
                  ? [verificationCalendarRecord]
                  : [],
            };
          } else if (rpc.method === 'collection.get') {
            const args = rpc.args as {
              platform?: unknown;
              slug?: unknown;
              record_id?: unknown;
            };
            result = {
              record:
                args.platform === 'calendar'
                && args.slug === 'work'
                && args.record_id === verificationCalendarRecord.record_id
                  ? verificationCalendarRecord
                  : null,
            };
          } else if (rpc.method === 'data.timeline') {
            result = { entries: [] };
          }
        }
        if (attentionDemo) {
          if (rpc.method === 'approval.list') {
            result = { approvals: [attentionApproval] };
          } else if (rpc.method === 'approval.subscribe') {
            result = { approvals: [attentionApproval], seq: 1 };
          } else if (rpc.method === 'notification.pending_asks') {
            result = { asks: [attentionAsk] };
          } else if (rpc.method === 'chat.plans.pending.list') {
            result = { plans: [] };
          }
        }
        if (rpc.method === 'passport.fetch') {
          result = {
            passport: {
              identity: {
                server_public_key: 'spki-base64',
                current_handle: 'alice',
              },
              network: {},
            },
          };
        }
        if (rpc.method === 'server.setPaused') {
          const active = (rpc.args as { active?: unknown }).active === true;
          serverPaused = active;
          result = {
            ok: true,
            active_since: serverPaused ? FIXED_NOW : null,
          };
        }
        if (rpc.method === 'server.requestRestart') {
          result = { accepted: true };
        }
        if (
          rpc.method === 'collection.contract.listContracts'
          && resolveContractsReads
        ) {
          result = { contracts: [], next_cursor: null, total: 0 };
        }
        if (rpc.method === 'server.setLLMSlot') {
          const args = rpc.args as {
            slot_key?: unknown;
            slot?: unknown;
          };
          if (
            (args.slot_key === 'slot_1' || args.slot_key === 'slot_2')
            && args.slot !== null
            && typeof args.slot === 'object'
          ) {
            const slot = args.slot as Record<string, unknown>;
            const { api_key: apiKey, ...redacted } = slot;
            llmConfig[args.slot_key] = {
              ...redacted,
              has_key: typeof apiKey === 'string' && apiKey.length > 0,
            };
          } else if (args.slot_key === 'slot_1' || args.slot_key === 'slot_2') {
            llmConfig[args.slot_key] = null;
          }
          result = { ok: true };
        }
        if (rpc.method === 'chat.default_model_pref.set') {
          const sourceId = (rpc.args as { source_id?: unknown }).source_id;
          if (
            sourceId === 'slot_1'
            || sourceId === 'slot_2'
            || sourceId === 'free_pool'
          ) {
            defaultSourceId = sourceId;
          }
          result = { source_id: defaultSourceId, updated_at: FIXED_NOW + 1 };
        }
        if (rpc.method === 'collection.mail.enrollOAuth' && firstSyncDemo) {
          mailConnected = true;
          result = { ok: true, account_key_prefix: 'gmail.work' };
        }
        if (result === undefined) return;
        // rpc-conn registers the pending request before transport.send. One
        // harness mode deliberately lets the AI-config read settle on a later
        // network tick so the setup-return focus test covers the real race.
        const respond = (): void => {
          for (const listener of [...messages]) {
            listener({
              type: 'rpc_result',
              request_id: rpc.request_id,
              result,
            });
          }
        };
        if (
          holdServerControlResponse
          && (
            rpc.method === 'server.setPaused'
            || rpc.method === 'server.requestRestart'
          )
        ) {
          heldServerControlResponses.push(respond);
          return;
        }
        if (delayAiRead && rpc.method === 'server.getLLMConfig') {
          setTimeout(respond, 40);
        } else {
          queueMicrotask(respond);
        }
      },
      onMessage(listener) {
        messages.add(listener);
        return () => messages.delete(listener);
      },
      onState(listener) {
        states.add(listener);
        return () => states.delete(listener);
      },
    },
    setServerAvailable: (available) => {
      serverAvailable = available;
    },
    forceReauth: () => {
      rejectNextOpenForReauth = true;
      for (const listener of [...states]) listener('closed');
    },
    rpcCallCount: (method) => rpcCallCounts.get(method) ?? 0,
    releaseServerControlResponses: () => {
      const pending = heldServerControlResponses.splice(0);
      for (const respond of pending) respond();
      return pending.length;
    },
    fireState: (state) => {
      for (const listener of [...states]) listener(state);
    },
    fireMessage: (msg) => {
      if (
        connectedSourceAnswerDemo
        && msg !== null
        && typeof msg === 'object'
        && (msg as { type?: unknown }).type === 'server_event'
      ) {
        const event = (msg as { event?: unknown }).event;
        if (
          event !== null
          && typeof event === 'object'
          && (event as { kind?: unknown }).kind === 'chat.message_complete'
        ) {
          const final = (event as { final?: unknown }).final;
          if (
            final !== null
            && typeof final === 'object'
            && typeof (final as { id?: unknown }).id === 'string'
            && !sourceAnswerMessages.some(
              (message) => message.id === (final as { id: string }).id,
            )
          ) {
            sourceAnswerMessages.push(final as Record<string, unknown>);
          }
        }
      }
      for (const l of [...messages]) l(msg);
    },
  };
};

interface BrowserHashSource extends WebclientHashSource {
  setHash(hash: string): void;
}

// A REAL bridge to `window.location.hash` + the native `hashchange` event —
// i.e. what the production webclient hash source does. In a real Chromium this
// is both faithful AND makes anchor navigation (the drawer's `<a href="#data">`
// links) work for free: clicking one updates `location.hash`, the browser fires
// `hashchange`, and the bootstrap's listener re-mounts. `setHash` (the Playwright
// drive hook) just sets `location.hash`, which fires the same event — so a route
// change lands whether it was driven programmatically or by a real click. The
// unit suite's isolated fake hash source can't observe href navigation, which is
// why it only ever drives via `setHash`; here the bridge covers both paths.
const buildBrowserHashSource = (): BrowserHashSource => {
  const listeners = new Set<(h: string) => void>();
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash;
    for (const l of [...listeners]) l(hash);
  });
  return {
    getHash: () => window.location.hash,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setHash(hash) {
      // Fires the native `hashchange` → the registered listeners above.
      window.location.hash = hash;
    },
  };
};

// ──────────────────────────────────────────────────────────────────
// Window drive bridge
// ──────────────────────────────────────────────────────────────────

interface FullAppHooks {
  ready: boolean;
  setHash(hash: string): void;
  activeRoute(): string;
  setServerAvailable(available: boolean): void;
  forceReauth(): void;
  rpcCallCount(method: string): number;
  releaseServerControlResponses?(): number;
  fireState(state: WebclientWsState): void;
  fireMessage(message: unknown): void;
  /** Multi-tab journey diagnostic: proves the passive sibling never POSTed. */
  pairSubmitCount?(): number;
  /** Multi-tab journey diagnostic: proves a takeover uses only its fresh code. */
  lastPairingCode?(): string | null;
  /** Replacement-server journey diagnostic: proves only the newly generated
   * key reached the current server. */
  lastRecoveryKey?(): string | null;
  /** Credential-repair diagnostic: proves convergence never clears access. */
  credentialClearCount?(): number;
  /** Startup-triage diagnostic: proves retries never pair or double-submit. */
  startupAttemptCount?(): number;
  /** Captures only the explicit, reviewable diagnostic copy operation. */
  startupDiagnosticText?(): string | null;
}

declare global {
  interface Window {
    __app: FullAppHooks;
  }
}

const root = document.getElementById('root');
if (root === null) throw new Error('full-app harness: #root missing');

const searchParams = new URLSearchParams(window.location.search);
const boundedVerificationJourney =
  searchParams.get('journey') === 'bounded-verification';
const startupFailureJourney =
  searchParams.get('journey') === 'startup-failure';
const startupReloadRecoveryRequested =
  consumeStartupReloadRecovery(window.sessionStorage);
const recoveryReentryState =
  consumeRecoveryReentryState(window.sessionStorage);
const recoveryReentryRequested = recoveryReentryState !== null;
const safeStopReentryRequested = recoveryReentryState === 'safe_stop';
const replacementServerReentryRequested =
  recoveryReentryState === 'replacement_server';
if (recoveryReentryRequested) {
  scrubRecoveryReentryAddress({ document });
  if (safeStopReentryRequested) {
    armSafeStopRecoveryReentry(window.sessionStorage);
  } else if (replacementServerReentryRequested) {
    armReplacementServerRecoveryReentry(window.sessionStorage);
  } else {
    armRecoveryReentry(window.sessionStorage);
  }
}
const startupReloadRemainsFailed =
  searchParams.get('startup_reload_still_fails') === '1';
const STARTUP_FAILURE_RESOLVED_SESSION_KEY =
  'recued.e2e.startup-failure-resolved';
if (
  startupFailureJourney
  && startupReloadRecoveryRequested
  && !startupReloadRemainsFailed
) {
  // Harness-only external-state model: the explicit reload represents the
  // browser/server condition recovering. Keep it healthy for later ordinary
  // reloads so the product marker's no-replay behavior remains observable.
  window.sessionStorage.setItem(
    STARTUP_FAILURE_RESOLVED_SESSION_KEY,
    '1',
  );
}
const startupFailureResolved =
  startupFailureJourney
  && !startupReloadRemainsFailed
  && window.sessionStorage.getItem(
    STARTUP_FAILURE_RESOLVED_SESSION_KEY,
  ) === '1';
const multiTabPairJourney =
  searchParams.get('journey') === 'multi-tab-pair';
const multiTabCredentialJourney =
  searchParams.get('journey') === 'multi-tab-credentials';
const multiTabTransitionJourney =
  searchParams.get('journey') === 'multi-tab-transition';
const requestedSiblingTakeoverDelayMs = Number.parseInt(
  searchParams.get('takeover_delay_ms') ?? '',
  10,
);
const siblingTakeoverDelayMs =
  Number.isFinite(requestedSiblingTakeoverDelayMs)
  && requestedSiblingTakeoverDelayMs >= 0
    ? requestedSiblingTakeoverDelayMs
    : undefined;
const requestedRecoveryOwnerDelayMs = Number.parseInt(
  searchParams.get('recovery_owner_delay_ms') ?? '',
  10,
);
const siblingRecoveryOwnerDelayMs =
  Number.isFinite(requestedRecoveryOwnerDelayMs)
  && requestedRecoveryOwnerDelayMs >= 0
    ? requestedRecoveryOwnerDelayMs
    : undefined;
const requestedRecoveryOwnerHeartbeatMs = Number.parseInt(
  searchParams.get('recovery_owner_heartbeat_ms') ?? '',
  10,
);
const recoveryOwnerHeartbeatMs =
  Number.isFinite(requestedRecoveryOwnerHeartbeatMs)
  && requestedRecoveryOwnerHeartbeatMs > 0
    ? requestedRecoveryOwnerHeartbeatMs
    : undefined;
const requestedPairResponseDelayMs = Number.parseInt(
  searchParams.get('pair_response_delay_ms') ?? '',
  10,
);
const pairResponseDelayMs =
  Number.isFinite(requestedPairResponseDelayMs)
  && requestedPairResponseDelayMs > 0
    ? Math.min(requestedPairResponseDelayMs, 5_000)
    : 0;
const interruptedPairTransitionJourney =
  multiTabTransitionJourney
  && searchParams.get('fail_pair_once') === '1';
const requestedSiblingStartupFailures = Number.parseInt(
  searchParams.get('fail_sibling_startup_attempts') ?? '0',
  10,
);
const siblingConvergedStartupFailureJourney =
  interruptedPairTransitionJourney
  && Number.isFinite(requestedSiblingStartupFailures)
  && requestedSiblingStartupFailures > 0
  && searchParams.get('keep') === 'arrival tab';
const multiTabJourney =
  multiTabPairJourney
  || multiTabCredentialJourney
  || multiTabTransitionJourney;
const durableServerProfilesJourney =
  searchParams.get('server_profiles') === 'multiple';
const localStore = multiTabJourney
  ? buildMultiTabPairStore()
  : durableServerProfilesJourney
    ? buildServerSwitchProfileStore()
    : buildPairedStore();
const profileStore = multiTabJourney
  ? undefined
  : localStore as WebclientProfileAwareStore;
const tokenStore = buildFakeTokenStore();
const requestedColdStartupFailures = Number.parseInt(
  searchParams.get('startup_failure_attempts') ?? '2',
  10,
);
let pairedAppBootstrapFailuresRemaining =
  startupFailureJourney && !startupFailureResolved
  ? Math.max(
      1,
      Number.isFinite(requestedColdStartupFailures)
        ? requestedColdStartupFailures
        : 2,
    )
  : siblingConvergedStartupFailureJourney
    ? requestedSiblingStartupFailures
    : 0;
let startupBootstrapAttemptCount = 0;
let lastStartupDiagnostic: string | null = null;
const startupDiagnosticWriter = async (summary: string): Promise<void> => {
  lastStartupDiagnostic = summary;
};
const startupDiagnosticNow = (): Date =>
  new Date('2026-07-27T21:00:00.000Z');
const startupFailure = (): Error => {
  switch (searchParams.get('startup_failure_kind')) {
    case 'server':
      return Object.assign(
        new Error('full-app harness: server did not answer startup'),
        { code: 'server_offline' },
      );
    case 'storage':
      return Object.assign(
        new Error('full-app harness: later browser storage read failed'),
        { name: 'InvalidStateError' },
      );
    default:
      return new Error(
        'full-app harness: paired application startup interrupted',
      );
  }
};
const bootstrapWithStartupFault: typeof bootstrapWebclient = async (
  options,
) => {
  startupBootstrapAttemptCount += 1;
  if (pairedAppBootstrapFailuresRemaining > 0) {
    pairedAppBootstrapFailuresRemaining -= 1;
    throw startupFailure();
  }
  return bootstrapWebclient(options);
};
const transport = buildFakeTransport(
  searchParams.get('ai') !== 'empty',
  searchParams.get('chat') === 'session',
  searchParams.get('slow_ai') === '1',
  searchParams.get('oauth') === 'ready',
  searchParams.get('connection') === 'first-sync',
  searchParams.get('connection') === 'source-ready',
  searchParams.get('connection') === 'source-answer',
  searchParams.get('journey') === 'verification',
  searchParams.get('attention') === 'pending',
  searchParams.get('server_control_response') === 'hold',
  boundedVerificationJourney,
);
// Real `location.hash` bridge — the harness page loads with no fragment, so the
// bootstrap resolves the default landing (chat); the spec drives every other
// route via `window.__app.setHash` (and the drawer test via real anchor clicks).
const hashSource = buildBrowserHashSource();
const reauthJourney = searchParams.get('journey') === 'reauth';
const credentialRepairJourney =
  searchParams.get('journey') === 'credential-corruption';
const partialStateJourney =
  searchParams.get('journey') === 'partial-local-state';
const credentialRepairReloadRecovers =
  searchParams.get('credential_reload_recovers') === '1';
const CREDENTIAL_REPAIR_RESOLVED_SESSION_KEY =
  'recued.e2e.credential-repair-resolved';
if (
  (credentialRepairJourney || partialStateJourney)
  && startupReloadRecoveryRequested
  && credentialRepairReloadRecovers
) {
  // Harness-only external state: the explicit reload models a transient key
  // access failure clearing, or a sibling finishing the interrupted save.
  // Keep the pair healthy for a later ordinary reload so the startup receipt's
  // one-shot behavior remains observable.
  window.sessionStorage.setItem(
    CREDENTIAL_REPAIR_RESOLVED_SESSION_KEY,
    '1',
  );
}
const credentialRepairResolved =
  (credentialRepairJourney || partialStateJourney)
  && credentialRepairReloadRecovers
  && window.sessionStorage.getItem(
    CREDENTIAL_REPAIR_RESOLVED_SESSION_KEY,
  ) === '1';
const persistentStorageJourney =
  searchParams.get('journey') === 'persistent-storage';
const persistentStorageReloadRecovers =
  searchParams.get('storage_reload_recovers') === '1';
const PERSISTENT_STORAGE_RESOLVED_SESSION_KEY =
  'recued.e2e.persistent-storage-resolved';
if (
  persistentStorageJourney
  && startupReloadRecoveryRequested
  && persistentStorageReloadRecovers
) {
  // Harness-only external state: after the explicit product reload, model the
  // browser releasing its storage blocker and keep it healthy for later
  // ordinary reloads so the product receipt's one-shot behavior is observable.
  window.sessionStorage.setItem(
    PERSISTENT_STORAGE_RESOLVED_SESSION_KEY,
    '1',
  );
}
const persistentStorageResolved =
  persistentStorageJourney
  && persistentStorageReloadRecovers
  && window.sessionStorage.getItem(
    PERSISTENT_STORAGE_RESOLVED_SESSION_KEY,
  ) === '1';
const secureAccessJourney = searchParams.get('journey') === 'secure-access';
const SECURE_ACCESS_PAIRED_SESSION_KEY =
  'recued.e2e.secure-access-pair-persisted';
const secureAccessPairedReload =
  secureAccessJourney
  && window.sessionStorage.getItem(SECURE_ACCESS_PAIRED_SESSION_KEY) === '1';

let pairSubmitCount = 0;
let lastPairingCode: string | null = null;
let lastRecoveryKey: string | null = null;
let credentialClearCount = 0;
const requestedRecoveryRejections = Number.parseInt(
  searchParams.get('reject_recovery_attempts') ?? '0',
  10,
);
let recoveryRejectionsRemaining =
  !recoveryReentryRequested
  && Number.isFinite(requestedRecoveryRejections)
  && requestedRecoveryRejections > 0
    ? Math.min(requestedRecoveryRejections, 3)
    : 0;
const clearCredentialStore = async (): Promise<void> => {
  credentialClearCount += 1;
  await localStore.clear();
};
const installRecoveryPairFetch = (
  journey: string,
  expectedUrl = 'https://alice.recued.cloud:8443/auth/pair',
): void => {
  const replacementPairUrl =
    'https://replacement.recued.cloud:9443/auth/pair';
  const allowReplacementServer =
    searchParams.get('replacement_server') === '1';
  window.fetch = async (input, init): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const replacementServer =
      allowReplacementServer && url === replacementPairUrl;
    if (url !== expectedUrl && !replacementServer) {
      throw new Error(`full-app ${journey} harness: unexpected fetch ${url}`);
    }
    pairSubmitCount += 1;
    try {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { code?: unknown; recoveryKey?: unknown }
        : null;
      lastPairingCode = typeof body?.code === 'string' ? body.code : null;
      lastRecoveryKey = typeof body?.recoveryKey === 'string'
        ? body.recoveryKey
        : null;
    } catch {
      lastPairingCode = null;
      lastRecoveryKey = null;
    }
    if (recoveryRejectionsRemaining > 0) {
      recoveryRejectionsRemaining -= 1;
      return new Response(JSON.stringify({
        error: {
          code: 'recovery_key_invalid',
          message: 'Simulated recovery-key rejection.',
        },
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const recoveryPassport = {
      identity: {
        server_public_key: replacementServer
          ? 'spki-replacement-verified'
          : 'spki-base64',
        current_handle: replacementServer ? 'harbor' : 'alice',
      },
      network: {},
    };
    const requestedPostPairFailures = Number.parseInt(
      searchParams.get('fail_startup_attempts') ?? '0',
      10,
    );
    if (
      searchParams.get('fail_startup_once') === '1'
      || requestedPostPairFailures > 0
    ) {
      // `/auth/pair` has succeeded and its response will be persisted. Fail
      // only the configured application bootstrap attempts so the browser
      // exercises durable-access startup retries rather than another pairing
      // request.
      pairedAppBootstrapFailuresRemaining = Math.max(
        searchParams.get('fail_startup_once') === '1' ? 1 : 0,
        requestedPostPairFailures,
      );
    }
    // Harness-only observation window for simultaneous takeover tests. The
    // request counter advances before this pause, so Playwright can identify
    // the one lock owner while the losing tab is still visibly queued.
    if (pairResponseDelayMs > 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, pairResponseDelayMs);
      });
    }
    const requestedTakeoverFailures = Number.parseInt(
      searchParams.get('fail_takeover_attempts')
        ?? (searchParams.get('fail_first_takeover_globally') === '1'
          ? '1'
          : '0'),
      10,
    );
    if (
      Number.isFinite(requestedTakeoverFailures)
      && requestedTakeoverFailures > 0
    ) {
      // Both contenders opt into one shared failure budget. The exclusive Web
      // Lock makes this increment serial: whichever tab owns the first request
      // fails, and the already-queued contender can visibly inherit the baton.
      const prior = Number.parseInt(
        window.localStorage.getItem(MULTI_TAB_TAKEOVER_REQUEST_COUNT_KEY)
          ?? '0',
        10,
      );
      const attempt = Number.isFinite(prior) ? prior + 1 : 1;
      window.localStorage.setItem(
        MULTI_TAB_TAKEOVER_REQUEST_COUNT_KEY,
        String(attempt),
      );
      if (attempt <= requestedTakeoverFailures) {
        return new Response(JSON.stringify({
          error: {
            code: 'invalid_code',
            message: `Simulated expired takeover code ${attempt}.`,
          },
        }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({
      token: 'fresh-recovery-bearer',
      token_id: 'tok-repaired',
      passport: recoveryPassport,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
};

void (async (): Promise<void> => {
  try {
    if (
      profileStore !== undefined
      && searchParams.get('server_profiles') === 'multiple'
    ) {
      const originalId = await profileStore.activeProfileId();
      const officeId = await profileStore.ensureProfile(
        'wss://office.recued.cloud:9443/ws',
      );
      await profileStore.set('server_public_key', 'office-spki-base64');
      await profileStore.set('webclient_token', sampleToken('tok-office'));
      await profileStore.set('pair_metadata', {
        paired_at: FIXED_NOW,
        server_passport_fingerprint: 'fp-office',
        server_handle_at_pair: 'office',
        instance_id: 'browser-office',
      });
      await profileStore.set('cert_pin_state', null);
      await profileStore.renameProfile(officeId, 'Office server');
      if (originalId !== null) await profileStore.switchProfile(originalId);
    }
    if (boundedVerificationJourney && profileStore !== undefined) {
      const profileId = await profileStore.activeProfileId();
      if (profileId === null) {
        throw new Error(
          'full-app bounded-verification harness: active profile missing',
        );
      }
      if (window.sessionStorage.getItem(
        RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      ) === null) {
        window.sessionStorage.setItem(
          RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
          JSON.stringify({
            v: 1,
            profile_id: profileId,
            landing_hash: '#contracts',
            intent: 'choose_again',
            paused_at: FIXED_NOW,
          }),
        );
      }
      if (window.sessionStorage.getItem(
        RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
      ) === null) {
        window.sessionStorage.setItem(
          RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
          JSON.stringify({
            v: 2,
            profile_id: profileId,
            landing_hash: '#contracts',
            intent: 'choose_again',
            paused_at: FIXED_NOW,
            review_target: 'area',
            state: 'interrupted',
            interruption_count: 2,
            last_interruption: 'connection',
          }),
        );
      }
    }
    if (multiTabJourney) {
      const journey = multiTabPairJourney
        ? 'multi-tab-pair'
        : multiTabCredentialJourney
          ? 'multi-tab-credentials'
          : 'multi-tab-transition';
      if (multiTabPairJourney) {
        installRecoveryPairFetch(
          journey,
          `${window.location.origin}/auth/pair`,
        );
      } else {
        installRecoveryPairFetch(journey);
      }
      const handleRef: { current: WebclientHandle | null } = {
        current: null,
      };
      const pairEntry = parsePairEntryHandoff(window.location.href);
      let pairCompletedInAnotherTabAtStartup = false;
      let healthyPairAvailableAtStartup = false;
      if (multiTabTransitionJourney) {
        const credentialConvergence = createBrowserPairTabConvergence({
          document,
          pollMs: null,
        });
        const stopCredentialAnnouncement =
          announceColdStartCredentialCheck(document);
        const health = await (async () => {
          try {
            return await inspectColdStartCredentials({
              localStore,
              tokenStore,
              credentialConvergence,
              settleMs: COLD_START_CREDENTIAL_SETTLE_MS,
            });
          } finally {
            stopCredentialAnnouncement();
            credentialConvergence?.close();
          }
        })();
        if (health.kind !== 'continue') {
          if (
            !interruptedPairTransitionJourney
            || health.kind !== 'partial'
          ) {
            throw new Error(
              `full-app ${journey} harness: cold arrival resolved as ${health.kind}`,
            );
          }
          // A third tab that arrives after the source lock was released sees
          // the honest partial repair surface. Keep it subscribed so the
          // source's in-memory local retry can retire this stale diagnosis and
          // return the tab to its exact route automatically.
          const repairConvergence = createBrowserPairTabConvergence({
            document,
          });
          startColdStartCredentialRepair({
            root,
            localStore,
            tokenStore,
            transport:
              transport.transport as PairFallbackBootstrapDeps['transport'],
            handleRef,
            cryptoKeysWiper: async () => undefined,
            credentialStoreWiper: clearCredentialStore,
            credentialConvergence: repairConvergence,
            target: { kind: 'partial', partial: health.partial },
            returnHash: window.location.hash || '#chat',
            reloadAttempted: startupReloadRecoveryRequested,
            ...(recoveryReentryRequested
              ? { recoveryReentry: true as const }
              : {}),
            ...(recoveryReentryRequested && safeStopReentryRequested
              ? { safeStopReentry: true as const }
              : {}),
            ...(recoveryReentryRequested && replacementServerReentryRequested
              ? { replacementServerReentry: true as const }
              : {}),
            reload: () => requestStartupRecoveryReload({
              storage: window.sessionStorage,
              reload: () => window.location.reload(),
            }),
            ...(siblingConvergedStartupFailureJourney
              ? {
                  runBootstrap: (deps) =>
                    runBootstrapWithPairFallback({
                      ...deps,
                      bootstrap: bootstrapWithStartupFault,
                      startupDiagnosticWriter,
                      startupDiagnosticNow,
                      startupOnlineStatus: () => true,
                    }),
                }
              : {}),
            ...(pairEntry.active && !recoveryReentryRequested
              ? { deeplinkSeed: pairEntry.seed }
              : {}),
            document,
          });
          window.__app = {
            ready: true,
            setHash: (hash) => hashSource.setHash(hash),
            activeRoute: () => handleRef.current?.activeRoute() ?? 'pairing',
            setServerAvailable: (available) =>
              transport.setServerAvailable(available),
            forceReauth: () => transport.forceReauth(),
            rpcCallCount: (method) => transport.rpcCallCount(method),
            fireState: (state) => transport.fireState(state),
            fireMessage: (message) => transport.fireMessage(message),
            pairSubmitCount: () => pairSubmitCount,
            lastPairingCode: () => lastPairingCode,
            lastRecoveryKey: () => lastRecoveryKey,
            credentialClearCount: () => credentialClearCount,
            startupAttemptCount: () => startupBootstrapAttemptCount,
            startupDiagnosticText: () => lastStartupDiagnostic,
          };
          return;
        }
        pairCompletedInAnotherTabAtStartup =
          health.pairCompletedInAnotherTab === true;
        healthyPairAvailableAtStartup =
          health.healthyPairAvailable === true;
      }
      const recoveryReentryUnresolved =
        recoveryReentryRequested
        && !healthyPairAvailableAtStartup;
      if (recoveryReentryRequested && healthyPairAvailableAtStartup) {
        retireRecoveryReentry(window.sessionStorage);
      }
      const bootstrapDeps: PairFallbackBootstrapDeps = {
        root,
        localStore,
        tokenStore,
        transport:
          transport.transport as PairFallbackBootstrapDeps['transport'],
        handleRef,
        cryptoKeysWiper: async () => undefined,
        ...(pairEntry.active && !recoveryReentryRequested
          ? { deeplinkSeed: pairEntry.seed }
          : {}),
        ...(recoveryReentryUnresolved
          ? {
              reauthRecovery: {
                returnHash: window.location.hash || '#chat',
                recoveryReentry: true as const,
                ...(safeStopReentryRequested
                  ? { safeStopReentry: true as const }
                  : {}),
                ...(replacementServerReentryRequested
                  ? { replacementServerReentry: true as const }
                  : {}),
              },
            }
          : {}),
        ...(pairCompletedInAnotherTabAtStartup
          ? { silentCredentialConvergence: true }
          : {}),
        ...(siblingTakeoverDelayMs !== undefined
          ? { siblingTakeoverDelayMs }
          : {}),
        ...(siblingRecoveryOwnerDelayMs !== undefined
          ? { siblingRecoveryOwnerDelayMs }
          : {}),
        ...(recoveryOwnerHeartbeatMs !== undefined
          ? { recoveryOwnerHeartbeatMs }
          : {}),
        ...(siblingConvergedStartupFailureJourney
          ? {
              bootstrap: bootstrapWithStartupFault,
              startupDiagnosticWriter,
              startupDiagnosticNow,
              startupOnlineStatus: () => true,
            }
          : {}),
        document,
      };
      if (
        startupReloadRecoveryRequested
        && !pairCompletedInAnotherTabAtStartup
      ) {
        queueStartupRecoveryForNextAttempt(bootstrapDeps, 'reload');
      }
      const outcome = await runBootstrapWithPairFallback(bootstrapDeps);
      if (outcome.kind === 'mounted') {
        document.getElementById('webclient-boot-splash')?.remove();
      } else if (outcome.kind !== 'pair-form') {
        throw new Error(
          `full-app ${journey} harness: boot ended as ${outcome.kind}`,
        );
      }
      window.__app = {
        ready: true,
        setHash: (hash) => hashSource.setHash(hash),
        activeRoute: () => handleRef.current?.activeRoute() ?? 'pairing',
        setServerAvailable: (available) =>
          transport.setServerAvailable(available),
        forceReauth: () => transport.forceReauth(),
        rpcCallCount: (method) => transport.rpcCallCount(method),
        fireState: (state) => transport.fireState(state),
        fireMessage: (message) => transport.fireMessage(message),
        pairSubmitCount: () => pairSubmitCount,
        lastPairingCode: () => lastPairingCode,
        lastRecoveryKey: () => lastRecoveryKey,
        credentialClearCount: () => credentialClearCount,
        startupAttemptCount: () => startupBootstrapAttemptCount,
        startupDiagnosticText: () => lastStartupDiagnostic,
      };
      return;
    }

    if (secureAccessJourney && !secureAccessPairedReload) {
      root.innerHTML = `
        <div class="webclient-boot-splash" id="webclient-boot-splash">
          <div class="webclient-boot-splash-brand">Recued</div>
          <div id="webclient-boot-splash-message">Loading…</div>
        </div>
      `;
      let secureArrivalTarget: string | null = null;
      await new Promise<void>((resolve) => {
        let handoff!: MountedSecureAccessHandoff;
        handoff = mountSecureAccessHandoff({
          issue: {
            kind: 'insecure_context',
            message: INSECURE_CONTEXT_SPLASH_MESSAGE,
          },
          location: {
            protocol: 'http:',
            hostname: '192.168.1.42',
            port: '4319',
            pathname: window.location.pathname,
            search: window.location.search,
            hash: window.location.hash,
          },
          copyText: () => true,
          replaceLocation: (target) => {
            document.documentElement.setAttribute(
              'data-secure-access-target',
              target,
            );
            secureArrivalTarget = target;
            // Model the production cross-origin `location.replace` on this
            // same-origin harness: the blocked entry becomes the secure
            // arrival, so Back cannot traverse to the handoff page.
            const arrival = new URL(target);
            window.history.replaceState(
              window.history.state,
              '',
              `${window.location.pathname}${arrival.search}${arrival.hash}`,
            );
            handoff.dispose();
            resolve();
          },
          onReload: () => {
            handoff.dispose();
            resolve();
          },
          document,
        });
      });
      const arrivalTarget = secureArrivalTarget as string | null;
      if (arrivalTarget !== null) {
        installRecoveryPairFetch('secure-access');
        await localStore.clear();
        const handleRef: { current: WebclientHandle | null } = {
          current: null,
        };
        let currentPairEntryUrl = arrivalTarget;
        const pairEntry = parsePairEntryHandoff(arrivalTarget);
        const outcome = await runBootstrapWithPairFallback({
          root,
          localStore,
          tokenStore,
          transport:
            transport.transport as PairFallbackBootstrapDeps['transport'],
          handleRef,
          cryptoKeysWiper: async () => undefined,
          ...(pairEntry.active ? { deeplinkSeed: pairEntry.seed } : {}),
          // The harness models a cross-origin arrival without actually asking
          // Playwright to leave its local server. Keep URL cleanup observable
          // against that simulated secure page while production uses history.
          currentUrl: () => currentPairEntryUrl,
          replaceUrl: (target) => {
            currentPairEntryUrl = target;
            document.documentElement.removeAttribute(
              'data-secure-access-target',
            );
            document.documentElement.setAttribute(
              'data-secure-access-clean-target',
              target,
            );
            const cleanTarget = new URL(target);
            window.history.replaceState(
              window.history.state,
              '',
              `${window.location.pathname}${cleanTarget.search}${cleanTarget.hash}`,
            );
            // `onAfterPair` cleans only after durable pairing has finalized.
            // This marker lets an actual Playwright reload model the next
            // runtime reading that paired state from IndexedDB.
            window.sessionStorage.setItem(
              SECURE_ACCESS_PAIRED_SESSION_KEY,
              '1',
            );
          },
          document,
        });
        if (outcome.kind !== 'pair-form') {
          throw new Error(
            `full-app secure-arrival harness: expected pair form, got ${outcome.kind}`,
          );
        }
        window.__app = {
          ready: true,
          setHash: (hash) => hashSource.setHash(hash),
          activeRoute: () => handleRef.current?.activeRoute() ?? 'pairing',
          setServerAvailable: (available) =>
            transport.setServerAvailable(available),
          forceReauth: () => transport.forceReauth(),
          rpcCallCount: (method) => transport.rpcCallCount(method),
          fireState: (state) => transport.fireState(state),
          fireMessage: (message) => transport.fireMessage(message),
        };
        return;
      }
    }

    if (persistentStorageJourney) {
      root.innerHTML = `
        <div class="webclient-boot-splash" id="webclient-boot-splash">
          <div class="webclient-boot-splash-brand">Recued</div>
          <div id="webclient-boot-splash-message">Loading…</div>
        </div>
      `;
      let storageOpenAttempts = 0;
      await openPersistentStorageWithRecovery({
        document,
        reloadAttempted: startupReloadRecoveryRequested,
        reload: () => requestStartupRecoveryReload({
          storage: window.sessionStorage,
          reload: () => window.location.reload(),
        }),
        openStorage: async () => {
          storageOpenAttempts += 1;
          if (persistentStorageResolved) return true;
          if (storageOpenAttempts === 1) {
            throw new PersistentStorageStartupError(
              'blocked',
              'simulated older Recued tab',
            );
          }
          if (storageOpenAttempts === 2) {
            throw Object.assign(new Error('simulated browser quota'), {
              name: 'QuotaExceededError',
            });
          }
          return true;
        },
      });
      if (startupReloadRecoveryRequested) {
        const handleRef: { current: WebclientHandle | null } = {
          current: null,
        };
        const bootstrapDeps: PairFallbackBootstrapDeps = {
          root,
          localStore,
          tokenStore,
          transport:
            transport.transport as PairFallbackBootstrapDeps['transport'],
          handleRef,
          cryptoKeysWiper: async () => undefined,
          bootstrap: (options) => bootstrapWebclient({
            ...options,
            exposureProfile: 'community-shareable',
            hashSource,
            now: () => FIXED_NOW,
            enableReachabilityDoctor: true,
            enablePassportFetchVerify: false,
          }),
          document,
        };
        queueStartupRecoveryForNextAttempt(bootstrapDeps, 'reload');
        const outcome = await runBootstrapWithPairFallback(bootstrapDeps);
        if (outcome.kind !== 'mounted' || handleRef.current === null) {
          throw new Error(
            `full-app persistent-storage reload harness: recovery boot ended as ${outcome.kind}`,
          );
        }
        document.getElementById('webclient-boot-splash')?.remove();
        const handle = handleRef.current;
        window.__app = {
          ready: true,
          setHash: (hash) => hashSource.setHash(hash),
          activeRoute: () => handle.activeRoute(),
          setServerAvailable: (available) =>
            transport.setServerAvailable(available),
          forceReauth: () => transport.forceReauth(),
          rpcCallCount: (method) => transport.rpcCallCount(method),
          fireState: (state) => transport.fireState(state),
          fireMessage: (message) => transport.fireMessage(message),
        };
        return;
      }
    }

    if (credentialRepairJourney || partialStateJourney) {
      root.innerHTML = `
        <div class="webclient-boot-splash" id="webclient-boot-splash">
          <div class="webclient-boot-splash-brand">Recued</div>
          <div id="webclient-boot-splash-message">Loading…</div>
        </div>
      `;
      if (credentialRepairResolved) {
        const handleRef: { current: WebclientHandle | null } = {
          current: null,
        };
        const bootstrapDeps: PairFallbackBootstrapDeps = {
          root,
          localStore,
          tokenStore,
          transport:
            transport.transport as PairFallbackBootstrapDeps['transport'],
          handleRef,
          cryptoKeysWiper: async () => undefined,
          bootstrap: (options) => bootstrapWebclient({
            ...options,
            exposureProfile: 'community-shareable',
            hashSource,
            now: () => FIXED_NOW,
            enableReachabilityDoctor: true,
            enablePassportFetchVerify: false,
          }),
          document,
        };
        if (startupReloadRecoveryRequested) {
          queueStartupRecoveryForNextAttempt(bootstrapDeps, 'reload');
        }
        const outcome = await runBootstrapWithPairFallback(bootstrapDeps);
        if (outcome.kind !== 'mounted' || handleRef.current === null) {
          throw new Error(
            `full-app credential-repair reload harness: recovery boot ended as ${outcome.kind}`,
          );
        }
        document.getElementById('webclient-boot-splash')?.remove();
        const handle = handleRef.current;
        window.__app = {
          ready: true,
          setHash: (hash) => hashSource.setHash(hash),
          activeRoute: () => handle.activeRoute(),
          setServerAvailable: (available) =>
            transport.setServerAvailable(available),
          forceReauth: () => transport.forceReauth(),
          rpcCallCount: (method) => transport.rpcCallCount(method),
          fireState: (state) => transport.fireState(state),
          fireMessage: (message) => transport.fireMessage(message),
        };
        return;
      }
      installRecoveryPairFetch(
        partialStateJourney ? 'partial-local-state' : 'credential-repair',
      );
      if (partialStateJourney) {
        await localStore.remove('webclient_token');
        await localStore.remove('server_public_key');
      }
      let freshLocalKeyReady = false;
      const unreadableTokenStore: WebclientTokenStore = {
        wrap: tokenStore.wrap.bind(tokenStore),
        async unwrap(record, aad) {
          if (!freshLocalKeyReady) {
            throw new WebclientReauthRequiredError(
              'saved credential cannot be decrypted',
            );
          }
          return tokenStore.unwrap(record, aad);
        },
      };
      const repairTokenStore = credentialRepairJourney
        ? unreadableTokenStore
        : tokenStore;
      const health = await inspectColdStartCredentials({
        localStore,
        tokenStore: repairTokenStore,
      });
      if (credentialRepairJourney && health.kind !== 'unreadable') {
        throw new Error(
          'full-app credential-repair harness: expected unreadable credentials',
        );
      }
      if (partialStateJourney && health.kind !== 'partial') {
        throw new Error(
          'full-app partial-state harness: expected incomplete credentials',
        );
      }
      if (health.kind === 'continue') {
        throw new Error('full-app local repair harness: missing repair target');
      }
      const handleRef: { current: WebclientHandle | null } = {
        current: null,
      };
      const pairDeeplink = parsePairEntryHandoff(window.location.href);
      startColdStartCredentialRepair({
        root,
        localStore,
        tokenStore: repairTokenStore,
        transport:
          transport.transport as PairFallbackBootstrapDeps['transport'],
        handleRef,
        cryptoKeysWiper: async () => {
          freshLocalKeyReady = true;
        },
        credentialStoreWiper: clearCredentialStore,
        target: health.kind === 'unreadable'
          ? { kind: 'unreadable', pair: health.pair }
          : { kind: 'partial', partial: health.partial },
        returnHash: window.location.hash || '#chat',
        reloadAttempted: startupReloadRecoveryRequested,
        reload: () => requestStartupRecoveryReload({
          storage: window.sessionStorage,
          reload: () => window.location.reload(),
        }),
        ...(pairDeeplink.active
          ? { deeplinkSeed: pairDeeplink.seed }
          : {}),
        document,
      });

      window.__app = {
        ready: true,
        setHash: (hash) => hashSource.setHash(hash),
        activeRoute: () =>
          handleRef.current?.activeRoute() ?? 'credential-repair',
        setServerAvailable: (available) =>
          transport.setServerAvailable(available),
        forceReauth: () => transport.forceReauth(),
        rpcCallCount: (method) => transport.rpcCallCount(method),
        fireState: (state) => transport.fireState(state),
        fireMessage: (message) => transport.fireMessage(message),
        pairSubmitCount: () => pairSubmitCount,
        credentialClearCount: () => credentialClearCount,
      };
      return;
    }

    if (reauthJourney) {
      installRecoveryPairFetch('reauth');
      const handleRef: { current: WebclientHandle | null } = {
        current: null,
      };
      const outcome = await runBootstrapWithPairFallback({
        root,
        localStore,
        tokenStore,
        transport:
          transport.transport as PairFallbackBootstrapDeps['transport'],
        handleRef,
        cryptoKeysWiper: async () => undefined,
        ...(searchParams.get('fail_startup_once') === '1'
          || Number.parseInt(
            searchParams.get('fail_startup_attempts') ?? '0',
            10,
          ) > 0
          ? { bootstrap: bootstrapWithStartupFault }
          : {}),
        startupDiagnosticWriter,
        startupDiagnosticNow,
        document,
      });
      if (outcome.kind !== 'mounted' || handleRef.current === null) {
        throw new Error(
          `full-app reauth harness: initial boot ended as ${outcome.kind}`,
        );
      }
      document.getElementById('webclient-boot-splash')?.remove();

      window.__app = {
        ready: true,
        setHash: (hash) => hashSource.setHash(hash),
        activeRoute: () => handleRef.current?.activeRoute() ?? 'pairing',
        setServerAvailable: (available) =>
          transport.setServerAvailable(available),
        forceReauth: () => transport.forceReauth(),
        rpcCallCount: (method) => transport.rpcCallCount(method),
        fireState: (state) => transport.fireState(state),
        fireMessage: (message) => transport.fireMessage(message),
        pairSubmitCount: () => pairSubmitCount,
        startupDiagnosticText: () => lastStartupDiagnostic,
      };
      return;
    }

    if (startupFailureJourney) {
      const handleRef: { current: WebclientHandle | null } = {
        current: null,
      };
      const bootstrapDeps: PairFallbackBootstrapDeps = {
        root,
        localStore,
        tokenStore,
        transport:
          transport.transport as PairFallbackBootstrapDeps['transport'],
        handleRef,
        cryptoKeysWiper: async () => undefined,
        bootstrap: bootstrapWithStartupFault,
        startupOnlineStatus: () => true,
        startupDiagnosticWriter,
        startupDiagnosticNow,
        document,
      };
      if (startupReloadRecoveryRequested) {
        queueStartupRecoveryForNextAttempt(bootstrapDeps, 'reload');
      }
      const outcome = await runBootstrapWithPairFallback(bootstrapDeps);
      const shouldMount = startupFailureResolved;
      if (shouldMount && outcome.kind !== 'mounted') {
        throw new Error(
          `full-app startup-reload harness: recovery boot ended as ${outcome.kind}`,
        );
      }
      if (!shouldMount && outcome.kind !== 'failed') {
        throw new Error(
          `full-app startup-failure harness: initial boot ended as ${outcome.kind}`,
        );
      }
      if (outcome.kind === 'mounted') {
        document.getElementById('webclient-boot-splash')?.remove();
      }
      window.__app = {
        ready: true,
        setHash: (hash) => hashSource.setHash(hash),
        activeRoute: () =>
          handleRef.current?.activeRoute() ?? 'startup-recovery',
        setServerAvailable: (available) =>
          transport.setServerAvailable(available),
        forceReauth: () => transport.forceReauth(),
        rpcCallCount: (method) => transport.rpcCallCount(method),
        fireState: (state) => transport.fireState(state),
        fireMessage: (message) => transport.fireMessage(message),
        pairSubmitCount: () => pairSubmitCount,
        startupAttemptCount: () => startupBootstrapAttemptCount,
        startupDiagnosticText: () => lastStartupDiagnostic,
      };
      return;
    }

    if (durableServerProfilesJourney && profileStore !== undefined) {
      // Profile switching is coordinated by the production pair-fallback
      // host, not by bootstrapWebclient alone: that host owns the long-lived
      // credential-free BroadcastChannel observer and distinguishes an active
      // profile change from replacement credentials within one profile.
      const handleRef: { current: WebclientHandle | null } = { current: null };
      const outcome = await runBootstrapWithPairFallback({
        root,
        localStore,
        profileStore,
        tokenStore,
        transport:
          transport.transport as PairFallbackBootstrapDeps['transport'],
        handleRef,
        cryptoKeysWiper: async () => undefined,
        bootstrap: (options) => bootstrapWebclient({
          ...options,
          exposureProfile: 'community-shareable',
          hashSource,
          now: () => FIXED_NOW,
          enableReachabilityDoctor: true,
          enablePassportFetchVerify: false,
        }),
        document,
      });
      if (outcome.kind !== 'mounted' || handleRef.current === null) {
        throw new Error(
          `full-app server-profile harness: boot ended as ${outcome.kind}`,
        );
      }
      document.getElementById('webclient-boot-splash')?.remove();
      window.__app = {
        ready: true,
        setHash: (hash) => hashSource.setHash(hash),
        activeRoute: () => handleRef.current?.activeRoute() ?? 'pairing',
        setServerAvailable: (available) =>
          transport.setServerAvailable(available),
        forceReauth: () => transport.forceReauth(),
        rpcCallCount: (method) => transport.rpcCallCount(method),
        releaseServerControlResponses: () =>
          transport.releaseServerControlResponses(),
        fireState: (state) => transport.fireState(state),
        fireMessage: (message) => transport.fireMessage(message),
      };
      return;
    }

    const handle = await bootstrapWebclient({
      root,
      localStore,
      ...(profileStore !== undefined ? { profileStore } : {}),
      tokenStore,
      transport: transport.transport,
      exposureProfile: 'community-shareable',
      hashSource,
      document,
      now: () => FIXED_NOW,
      // Match the production pair-fallback composition: recovery deep links
      // can land on Settings -> Server -> Reachability. The cloud probe stays
      // inert until its explicit button is clicked, so this adds no network
      // dependency to the deterministic harness.
      enableReachabilityDoctor: true,
      // Bespoke composition, no server to answer `passport.fetch` — the interface
      // documents opting out here for exactly this case (the verify pipeline is a
      // fire-and-forget round-trip that has nothing to talk to on the fake).
      enablePassportFetchVerify: false,
    });

    document.getElementById('webclient-boot-splash')?.remove();

    window.__app = {
      ready: true,
      setHash: (hash) => hashSource.setHash(hash),
      activeRoute: () => handle.activeRoute(),
      setServerAvailable: (available) =>
        transport.setServerAvailable(available),
      forceReauth: () => transport.forceReauth(),
      rpcCallCount: (method) => transport.rpcCallCount(method),
      releaseServerControlResponses: () =>
        transport.releaseServerControlResponses(),
      fireState: (state) => transport.fireState(state),
      fireMessage: (message) => transport.fireMessage(message),
    };
  } catch (err) {
    // Surface a boot failure as an uncaught error so the spec's `pageerror` gate
    // reports the real message — an unhandled rejection would otherwise manifest
    // only as a vague `waitForFunction(() => __app.ready)` timeout.
    setTimeout(() => {
      throw err;
    });
  }
})();
