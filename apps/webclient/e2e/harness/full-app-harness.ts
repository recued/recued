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
 * recipe handoff, and one populated run → affected record verification journey.
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
 */
import {
  bootstrapWebclient,
  type WebclientHashSource,
} from '../../src/webclient-bootstrap.js';
import type {
  WebclientLocalKey,
  WebclientLocalStorage,
  WebclientTokenRecord,
} from '@recued/contracts';
import type { WebclientLocalStore } from '../../src/storage/local-store.js';
import type {
  WebclientTokenStore,
  WebclientTokenAad,
} from '../../src/storage/token-store.js';
import type {
  WebclientWsState,
  WebclientWsTransport,
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

const buildPairedStore = (): WebclientLocalStore => {
  const data: Partial<WebclientLocalStorage> = {
    server_url: 'wss://alice.recued.cloud:8443/ws',
    server_public_key: 'spki-base64',
    webclient_token: sampleToken(),
    pair_metadata: {
      paired_at: FIXED_NOW,
      server_passport_fingerprint: 'fp',
      server_handle_at_pair: 'alice',
    },
    cert_pin_state: null,
  };
  return {
    async get<K extends WebclientLocalKey>(key: K) {
      return (data[key] ?? null) as WebclientLocalStorage[K] | null;
    },
    async set<K extends WebclientLocalKey>(key: K, value: WebclientLocalStorage[K]) {
      (data as Record<string, unknown>)[key] = value;
    },
    async remove(key) {
      delete data[key];
    },
    async inspect() {
      return {
        server_url: data.server_url ?? null,
        webclient_token: data.webclient_token ?? null,
        server_public_key: data.server_public_key ?? null,
        pair_metadata: data.pair_metadata ?? null,
        cert_pin_state: data.cert_pin_state ?? null,
      };
    },
    async clear() {
      for (const k of Object.keys(data)) delete (data as Record<string, unknown>)[k];
    },
  };
};

const buildFakeTokenStore = (): WebclientTokenStore => ({
  async wrap() {
    throw new Error('not used');
  },
  async unwrap(record: WebclientTokenRecord, _aad: WebclientTokenAad) {
    return `bearer-${record.token_id}`;
  },
});

interface FakeTransportControls {
  transport: WebclientWsTransport;
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
): FakeTransportControls => {
  const states = new Set<(s: WebclientWsState) => void>();
  const messages = new Set<(m: unknown) => void>();
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
  return {
    transport: {
      async open() {
        // Mirror the production transport's handshake-complete signal so the
        // connection chip / server pill render a `connected` frame.
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
  fireMessage(message: unknown): void;
}

declare global {
  interface Window {
    __app: FullAppHooks;
  }
}

const root = document.getElementById('root');
if (root === null) throw new Error('full-app harness: #root missing');

const localStore = buildPairedStore();
const tokenStore = buildFakeTokenStore();
const searchParams = new URLSearchParams(window.location.search);
const transport = buildFakeTransport(
  searchParams.get('ai') !== 'empty',
  searchParams.get('chat') === 'session',
  searchParams.get('slow_ai') === '1',
  searchParams.get('oauth') === 'ready',
  searchParams.get('connection') === 'first-sync',
  searchParams.get('connection') === 'source-ready',
  searchParams.get('connection') === 'source-answer',
  searchParams.get('journey') === 'verification',
);
// Real `location.hash` bridge — the harness page loads with no fragment, so the
// bootstrap resolves the default landing (chat); the spec drives every other
// route via `window.__app.setHash` (and the drawer test via real anchor clicks).
const hashSource = buildBrowserHashSource();

void (async (): Promise<void> => {
  try {
    const handle = await bootstrapWebclient({
      root,
      localStore,
      tokenStore,
      transport: transport.transport,
      exposureProfile: 'community-shareable',
      hashSource,
      document,
      now: () => FIXED_NOW,
      // Bespoke composition, no server to answer `passport.fetch` — the interface
      // documents opting out here for exactly this case (the verify pipeline is a
      // fire-and-forget round-trip that has nothing to talk to on the fake).
      enablePassportFetchVerify: false,
    });

    window.__app = {
      ready: true,
      setHash: (hash) => hashSource.setHash(hash),
      activeRoute: () => handle.activeRoute(),
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
