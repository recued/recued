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
 *   - `releaseRpcResponses(method)` — settle responses held by `hold_rpc`.
 */
import type {
  PacksUnrunnableResult,
  RegistryDescribeRpcOutput,
  ServerLlmUsageResponse,
} from '@recued/contracts';
import {
  HARNESS_SERVER_FINGERPRINT,
  HARNESS_SERVER_PUBLIC_KEY,
} from './server-identity.js';
import { savedViewsDemoReply } from './saved-data-views.js';
import { recordsBrowseReply } from './records-browse.js';
import { chatHistorySearchReply } from './chat-history-search.js';
import { todayDemoReply, todayEmptyDemoReply } from './today-view.js';
import { chatTurnQueueDemoReply } from './chat-turn-queue.js';
import { workEntityUpsertDemoReply } from './work-entity-upsert.js';
import { recipeSimulationDemoReply } from './recipe-simulation.js';
import { preapprovalDemoReply } from './preapproval.js';
import type { GrantRecipeOpUsageCaller } from '../../src/contracts/contract-grants-panel.js';
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
  ContractDefinitionView,
  WebhookIngressView,
  WebhookProfileRuntimeCapabilityView,
  WebclientLocalKey,
  WebclientLocalStorage,
  WebclientTokenRecord,
  WorkEntityListRpcRequest,
  Task,
} from '@recued/contracts';
// A VALUE import, deliberately. `ExposureState.resolution` is a full
// `Record<PathRole, PathResolution>` table, and `applyPreset` is the contract's
// own pure helper for building one — so the fixture is generated by the same
// code the server uses instead of hand-copied, and cannot drift from it.
import { applyPreset, WEBHOOK_PROFILE_REGISTRY } from '@recued/contracts';
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
// Fakes based on webclient-bootstrap.test.ts, with real public-key bytes
// for the browser's account-binding fingerprint calculation.
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
    server_public_key: HARNESS_SERVER_PUBLIC_KEY,
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
        server_public_key: HARNESS_SERVER_PUBLIC_KEY,
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

const demoRecipeExecuteResult = (
  rawArgs: unknown,
  editableGrid: boolean,
  pagedFilter = false,
  copyable = false,
  json = false,
  recordFields = false,
  aiAnalysis = false,
  linkButtons = false,
  fileArtifact = false,
): unknown => {
  const executeArgs = rawArgs as {
    recipe_id?: unknown;
    config?: {
      payments?: Array<{ amount?: unknown }>;
      status?: unknown;
      cursor?: unknown;
    };
  };
  const resolvedRecipeId = typeof executeArgs.recipe_id === 'string'
    ? executeArgs.recipe_id
    : 'autorun-live-1';
  const submittedAmount = executeArgs.config?.payments?.[0]?.amount;
  const amount = typeof submittedAmount === 'string'
    ? submittedAmount
    : '';
  const status = typeof executeArgs.config?.status === 'string'
    ? executeArgs.config.status
    : 'open';
  const cursor = typeof executeArgs.config?.cursor === 'string'
    ? executeArgs.config.cursor
    : '';
  const secondPage = cursor === 'next-token';
  const render = editableGrid
    ? [{
        type: 'table',
        data: {
          rows: [{
            contract_ref: 'rental_contract/rec_1',
            amount,
          }],
        },
        record_columns: {
          entity: 'receipt',
          columns: [
            { field: 'contract_ref', label: 'Tenancy', kind: 'string' },
            { field: 'amount', label: 'Amount', kind: 'decimal' },
          ],
        },
        table_edit: {
          section_index: 0,
          recipe_hash: `hash-${resolvedRecipeId}`,
          into: 'payments',
          submit: 'Save what arrived',
          rows: 'fixed',
          editable: ['amount'],
          carry: ['contract_ref'],
          hidden: {},
        },
      }]
    : pagedFilter
      ? [{
          type: 'table',
          data: {
            columns: [{ field: 'id', label: 'ID' }],
            rows: [{ id: secondPage ? 'page-two-row' : 'page-one-row' }],
          },
        }, {
          type: 'filter',
          data: {},
          filter: {
            section_index: 1,
            recipe_hash: `hash-${resolvedRecipeId}`,
            fields: ['status'],
            hidden: ['cursor'],
            submit: 'Search jobs',
            definitions: {
              status: { label: 'Status', type: 'text', default: 'open' },
              cursor: '',
            },
            values: { status, cursor },
            paging: secondPage
              ? { prev_cursor: 'previous-token' }
              : { next_cursor: 'next-token' },
          },
        }]
      : copyable
        ? [{
            type: 'copyable',
            label: 'Customer follow-up',
            data: {
              content: 'Send the customer the signed agreement.',
            },
          }]
        : json
          ? [{
              type: 'json',
              label: 'Provider payload',
              data: {
                status: 'ready',
                nested: { count: 2 },
                external_reference:
                  'provider-reference-with-a-deliberately-long-unbroken-value-0123456789-abcdefghijklmnopqrstuvwxyz',
              },
            }]
          : recordFields
            ? [{
                type: 'record_fields',
                label: 'Work order',
                data: { record: { id: 'job_1' } },
                record_fields: {
                  entity: 'job',
                  fields: [
                    {
                      key: 'title',
                      label: 'Title',
                      kind: 'string',
                      present: true,
                      value: 'Replace the circulation pump',
                    },
                    {
                      key: 'external_reference',
                      label: 'External reference',
                      kind: 'string',
                      present: true,
                      value:
                        'providerreference0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
                    },
                    {
                      key: 'contact_name',
                      label: 'Contact name',
                      kind: 'string',
                      present: false,
                    },
                    {
                      key: 'attachments',
                      label: 'Attachments',
                      kind: 'json',
                      present: true,
                      value: [{ id: 'one' }, { id: 'two' }],
                    },
                  ],
                },
              }]
            : aiAnalysis
              ? [
                  {
                    type: 'ai_analysis',
                    label: 'Triage analysis',
                    data: {
                      summary: 'The request is ready for owner review.',
                      category: 'Customer follow-up',
                      confidence: 0.91,
                      reasoning:
                        'Matched providerreference0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ to the active work order.',
                      key_points: [
                        'The customer supplied the requested document.',
                        'The assigned owner still needs to confirm dispatch.',
                      ],
                    },
                  },
                  {
                    type: 'ai_analysis',
                    label: 'Raw model metadata',
                    data: {
                      providerreference:
                        '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
                    },
                  },
                ]
              : linkButtons
                ? [{
                    type: 'link_button',
                    label: 'Next steps',
                    data: [
                      {
                        label:
                          'Open providerreference0123456789abcdefghijklmnopqrstuvwx',
                        url: 'https://example.com/work/job_1',
                        description:
                          'Review providerreference0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ before returning to this result.',
                      },
                      {
                        label: 'View signed receipt',
                        url: 'https://example.com/receipts/job_1',
                        description: 'Opens the immutable receipt in the provider.',
                      },
                    ],
                  }]
                : fileArtifact
                  ? [{
                      type: 'file_artifact',
                      label: 'Generated documents',
                      data: [{
                        title:
                          'providerdocument0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
                        record_id: 'file:abcdef0123456789abcdef0123456789',
                        filename:
                          'providerdocument0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.pdf',
                        mime_type: 'application/pdf',
                        size_bytes: 1_234,
                        sha256: 'a'.repeat(64),
                        generated_at: Date.UTC(2026, 7, 3, 12, 0, 0),
                        generation_mode: 'static',
                        origin: {
                          submission_id:
                            'submission0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
                        },
                        template: {
                          filename: 'customer-agreement-template.md',
                          sha256: 'b'.repeat(64),
                          format: 'markdown',
                        },
                      }],
                    }]
                  : [];
  return {
    recipe_id: resolvedRecipeId,
    recipe_hash: `hash-${resolvedRecipeId}`,
    success: true,
    output: {
      render,
      sidebar: [],
    },
    steps: [{
      id: 'finish',
      type: 'test',
      skipped: false,
      duration_ms: 3,
      error: null,
    }],
    errors: [],
    duration_ms: 7,
    ...(recipeRunFactsDemo
      ? {
          run_facts: {
            steps_run: 34,
            items_total: 1_249,
            provider_calls: 2,
            total_tokens: 13_385,
            duration_ms: 42_000,
          },
        }
      : {}),
  };
};

const WEBHOOK_DEMO_INGRESS_ID = 'whi_browserdemo0123456789abcdef012345';
const WEBHOOK_CREATED_INGRESS_ID = 'whi_browsercreated0123456789abcdef0123';
const WEBHOOK_DEMO_PROFILE_ID = 'generic.raw-body-hmac-sha256.v1';
const WEBHOOK_DEMO_DELIVERIES = [{
  delivery_id: 'whd_browserdemo0123456789abcdef012345',
  event_id: 'whe_browserdemo0123456789abcdef012345',
  provider_event_id: 'evt_browser_demo',
  provider_resource_id: 'resource_browser_demo',
}, {
  delivery_id: 'whd_browserdemo2123456789abcdef012345',
  event_id: 'whe_browserdemo2123456789abcdef012345',
  provider_event_id: 'evt_browser_demo_2',
  provider_resource_id: 'resource_browser_demo_2',
}] as const;

const demoWebhookIngress = (
  intakeState: WebhookIngressView['intake_state'] = 'enabled',
): WebhookIngressView => ({
  ingress_id: WEBHOOK_DEMO_INGRESS_ID,
  public_id: 'browserDemoOpaquePublicId0123456789',
  display_name: 'Signed test deliveries',
  profile_id: WEBHOOK_DEMO_PROFILE_ID,
  environment: 'test',
  paired_connection_id: null,
  registration_target: null,
  registration_mode: 'manual',
  endpoint_url: 'https://hooks.example.test/v1/webhooks/browserDemoOpaquePublicId0123456789',
  remote_endpoint_id: null,
  selected_event_types: ['delivery'],
  registration_state: 'registered',
  intake_state: intakeState,
  configured_fields: ['signature_header', 'signing_secret'],
  missing_required_fields: [],
  active_credential_versions: [{
    version: '1',
    created_at: FIXED_NOW - 86_400_000,
    retired_at: null,
    last_verified_at: FIXED_NOW - 60_000,
  }],
  readiness: {
    credentials_complete: true,
    registration_complete: true,
    registration_endpoint_matches: true,
    event_selection_complete: true,
    local_configuration_complete: true,
    profile_runtime_available: true,
    paired_connection_available: true,
    listener_available: true,
    public_url_available: true,
    public_reachability_enabled: true,
    tls_ready: true,
    clock_ready: true,
    test_delivery_supported: true,
    vault_unlocked: true,
    server_unpaused: true,
    can_enable: true,
    blockers: [],
  },
  health: {
    status: intakeState === 'enabled' ? 'healthy' : 'disabled',
    test_observed_at: null,
    last_delivery_at: FIXED_NOW - 60_000,
    last_error_code: null,
  },
  enabled_at: intakeState === 'enabled' ? FIXED_NOW - 3_600_000 : null,
  created_at: FIXED_NOW - 86_400_000,
  updated_at: FIXED_NOW - 60_000,
});

const WEBHOOK_DEMO_PROFILES: readonly WebhookProfileRuntimeCapabilityView[] = [{
  profile_id: WEBHOOK_DEMO_PROFILE_ID,
  registration_modes:
    WEBHOOK_PROFILE_REGISTRY[WEBHOOK_DEMO_PROFILE_ID].registration_modes,
  deduplication: WEBHOOK_PROFILE_REGISTRY[WEBHOOK_DEMO_PROFILE_ID].deduplication,
}];

const demoCreatedWebhookIngress = (
  displayName: string,
  credentialsComplete: boolean,
): WebhookIngressView => {
  const base = demoWebhookIngress('disabled');
  return {
    ...base,
    ingress_id: WEBHOOK_CREATED_INGRESS_ID,
    public_id: 'browserCreatedOpaquePublicId01234567',
    display_name: displayName,
    endpoint_url: 'https://hooks.example.test/v1/webhooks/browserCreatedOpaquePublicId01234567',
    registration_state: 'manual_pending',
    intake_state: 'draft',
    configured_fields: credentialsComplete
      ? ['signature_header', 'signing_secret']
      : [],
    missing_required_fields: credentialsComplete
      ? []
      : ['signature_header', 'signing_secret'],
    active_credential_versions: credentialsComplete
      ? [{
          version: '1',
          created_at: FIXED_NOW + 120_000,
          retired_at: null,
          last_verified_at: null,
        }]
      : [],
    readiness: {
      ...base.readiness,
      credentials_complete: credentialsComplete,
      registration_complete: false,
      registration_endpoint_matches: false,
      can_enable: false,
      blockers: credentialsComplete
        ? ['registration_incomplete']
        : ['credentials_incomplete', 'registration_incomplete'],
    },
    health: {
      status: 'disabled',
      test_observed_at: null,
      last_delivery_at: null,
      last_error_code: null,
    },
    enabled_at: null,
    created_at: FIXED_NOW + 120_000,
    updated_at: FIXED_NOW + 120_000,
  };
};

interface FakeTransportControls {
  transport: WebclientWsTransport;
  setServerAvailable(available: boolean): void;
  forceReauth(): void;
  rpcCallCount(method: string): number;
  releaseServerControlResponses(): number;
  releaseRpcResponses(method: string): number;
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
  pagedLogsDemo = false,
  attentionDemo = false,
  destructiveApprovalDemo = false,
  attentionPlanDemo = false,
  receptionDemo = false,
  holdServerControlResponse = false,
  resolveContractsReads = false,
  contractReadFailures = 0,
  withTwoAiSlots = false,
  contactsDemo = false,
  longContactTextDemo = false,
  automationRulesDemo = false,
  automationDeleteDemo = false,
  automationScheduleListFailures = 0,
  delayAutomationScheduleListRetry = false,
  contactsPagedDemo = false,
  delayDataPaginationResponse = false,
  delayContactEditResponse = false,
  failContactEditResponse = false,
  workEntitiesPagedDemo = false,
  formResponsesPagedDemo = false,
  recordsDemo = false,
  recordsOrphanedDemo = false,
  recordsNavigationDemo = false,
  delayRecordsDeleteResponse = false,
  delayRecordsExportResponse = false,
  delayRecordsRetireResponse = false,
  delayRecordsOutboxRefreshResponse = false,
  delayRecordsPurgeResponse = false,
  delayRecordsNavigationResponse = false,
  liveControlDemo: boolean | 'interrupted' = false,
  runPaletteDemo = false,
  runPaletteUpdateFails = false,
  imapEnrollFails = false,
  imapEnrollSucceeds = false,
  recipesDemo = false,
  recipesPagedDemo = false,
  contractsPagedDemo = false,
  delayContractsPageResponse = false,
  aiModelsPoolDemo = false,
  aiModelsUsageDemo = false,
  packsDemo = false,
  failPacksDetailListOnce = false,
  failPacksActionRelistOnce = false,
  failPacksRecipeListOnce = false,
  connectionsGrantDemo = false,
  calendarLifecycleDemo = false,
  timelineFocusDemo = false,
  fileDownloadDemo = false,
  delayChatPlanResponse = false,
  delayChatDiagnosisResponse = false,
  connectedSourceCheckDemo = false,
  delayLogsControlResponse = false,
  failLogsControlFollowup = false,
  logsPassesDemo = false,
  delayComposeCommitResponse = false,
  delayReceptionDecisionResponse = false,
  recipesDefaultRunDemo = false,
  delayRecipeConfigResponse = false,
  failRecipeConfigRead = false,
  failChatHistoryActions = false,
  sameSpeedChatSlots = false,
  delayChatModelPreferenceResponse = false,
  failFirstChatSend = false,
  delayLogsRefreshResponse = false,
  delayLogsFeedResponse = false,
  delayAttentionActionResponse = false,
  failFirstApprovalRouteList = false,
  delayApprovalRouteListRetry = false,
  failApprovalResolve = false,
  failAskAnswer = false,
  failAskFollowupList = false,
  failAttentionPlanResolve = false,
  failReceptionRefreshAfterDecision = false,
  delayReceptionRefreshResponse = false,
  failFirstReceptionRecordsLoad = false,
  failReceptionRecordsRetry = false,
  delayReceptionRecordsRetry = false,
  failFirstReceptionResponsesLoad = false,
  failReceptionResponsesRetry = false,
  delayReceptionResponsesRetry = false,
  failFirstReceptionResponseDetailLoad = false,
  failReceptionResponseDetailRetry = false,
  delayReceptionResponseDetailRetry = false,
  failContactUpsert = false,
  delayAutomationScheduleResponse = false,
  failAutomationScheduleUpdate = false,
  delayAutomationScheduleDeleteResponse = false,
  failAutomationScheduleDelete = false,
  notificationsDemo = false,
  delayNotificationsMutation = false,
  failNotificationsMutation = false,
  failFirstNotificationsDescribe = false,
  delayNotificationsRetry = false,
  devicesDemo = false,
  delayDeviceRevoke = false,
  failDeviceRevoke = false,
  deviceListFailures = 0,
  delayDevicesRetry = false,
  accountDemo = false,
  delayAccountBind = false,
  failAccountBind = false,
  accountConflictDemo = false,
  delayAccountRebind = false,
  failAccountRebind = false,
  delayAccountUnbind = false,
  failAccountUnbind = false,
  accountReadFailures = 0,
  delayAccountReadRetry = false,
  delayDefaultModelPreference = false,
  failDefaultModelPreference = false,
  delayByokSlotSave = false,
  failByokSlotSave = false,
  delayByokSlotClear = false,
  failByokSlotClear = false,
  delayEmbeddingsSlotSave = false,
  failEmbeddingsSlotSave = false,
  delayEmbeddingsSlotClear = false,
  failEmbeddingsSlotClear = false,
  delayFreePoolToggle = false,
  failFreePoolToggle = false,
  delayFreePoolAdd = false,
  failFreePoolAdd = false,
  delayFreePoolRemove = false,
  failFreePoolRemove = false,
  delayAiBudgetSave = false,
  failAiBudgetSave = false,
  delayAiPromptSave = false,
  failAiPromptSave = false,
  delayAiPolicyWrite = false,
  failAiPolicyWrite = false,
  delayAiCatalogModeWrite = false,
  failAiCatalogModeWrite = false,
  delayChatSessionOpen = false,
  failChatSessionOpen = false,
  recipesRelatedAutoRunDemo = false,
  delayRecipeConfigSetResponse = false,
  recipeConfigSetFailures = 0,
  collectionListFailures = 0,
  delayCollectionListRetry = false,
  collectionGetFailures = 0,
  delayCollectionGetRetry = false,
  logsDetailFailures = 0,
  delayLogsDetailResponse = false,
  automationDishesDemo = false,
  automationDishHistoryFailures = 0,
  delayAutomationDishHistoryRetry = false,
  runPaletteRecipeListFailures = 0,
  delayRunPaletteRecipeListRetry = false,
  updatesDemo = false,
  failSlowUpdatesCheckRetry = false,
  slowUpdatesApply = false,
): FakeTransportControls => {
  const recipesRouteDemo = recipesDemo || recipesPagedDemo;
  const longRunPaletteTextDemo =
    searchParams.get('run_palette') === 'long' || longAutomationTextDemo;
  const runPaletteRecipeId = longRunPaletteTextDemo
    ? `autorun-${'I'.repeat(240)}`
    : 'autorun-live-1';
  const runPaletteRecipeName = longRunPaletteTextDemo
    ? `Recipe${'N'.repeat(240)}`
    : 'Watch pipeline';
  const chatSessionTitle =
    searchParams.get('chat_title') ?? 'Planning chat';
  const webhooksDemo = searchParams.get('connection') === 'webhooks';
  const delayWebhookTestDelivery =
    searchParams.get('webhook_test_response') === 'slow';
  const delayWebhookTerminalWrite =
    searchParams.get('webhook_terminal_response') === 'slow';
  const states = new Set<(s: WebclientWsState) => void>();
  const messages = new Set<(m: unknown) => void>();
  const rpcCallCounts = new Map<string, number>();
  const heldServerControlResponses: Array<() => void> = [];
  const heldRpcResponses = new Map<string, Array<() => void>>();
  let serverAvailable = true;
  let bridgeNotificationsEnabled = false;
  let pairedBridgeModes = { notification: false, approval: false };
  let notificationVerificationPhrase = 'blue lantern';
  let notificationsDescribeFailuresRemaining = failFirstNotificationsDescribe ? 1 : 0;
  const revokedDeviceIds = new Set<string>();
  let devicesListFailuresRemaining = deviceListFailures;
  let accountOwner: 'old' | 'incoming' | null = accountConflictDemo
    ? 'old'
    : accountBoundDemo
      ? 'incoming'
      : null;
  let accountBindingReadFailuresRemaining = accountReadFailures;
  let accountProReadFailuresRemaining = accountReadFailures;
  let rejectNextOpenForReauth = false;
  let chatSendFailuresRemaining = failFirstChatSend ? 1 : 0;
  let recipeConfigSetFailuresRemaining = recipeConfigSetFailures;
  let collectionListFailuresRemaining = collectionListFailures;
  let collectionGetFailuresRemaining = collectionGetFailures;
  let logsDetailFailuresRemaining = logsDetailFailures;
  let automationDishHistoryFailuresRemaining = automationDishHistoryFailures;
  const delayAutomationDishUpdate =
    searchParams.get('automation_dish_response') === 'slow';
  let runPaletteRecipeListFailuresRemaining = runPaletteRecipeListFailures;
  let webhookDemoIngress = demoWebhookIngress();
  let webhookCreatedIngress: WebhookIngressView | null = null;
  let webhookDemoRetired = false;
  const webhookIngressFor = (ingressId: unknown): WebhookIngressView | null => {
    if (ingressId === WEBHOOK_DEMO_INGRESS_ID) return webhookDemoIngress;
    if (ingressId === WEBHOOK_CREATED_INGRESS_ID) return webhookCreatedIngress;
    return null;
  };
  const storeWebhookIngress = (ingress: WebhookIngressView): void => {
    if (ingress.ingress_id === WEBHOOK_DEMO_INGRESS_ID) {
      webhookDemoIngress = ingress;
    } else if (ingress.ingress_id === WEBHOOK_CREATED_INGRESS_ID) {
      webhookCreatedIngress = ingress;
    }
  };
  // `packs_installed=0` starts the demo pack UNINSTALLED. The install consent
  // dialog (`packs-install-dialog.ts`, 17 live attributes: permissions, body
  // grants, collision groups, owner-operation review, records review) only
  // exists on a pack you do not have, and the only other way there is
  // Uninstall → confirm → Install, which is deeper than the BFS walks. A query
  // param puts the surface one press away instead of four.
  let packsInstalled = searchParams.get('packs_installed') !== '0';
  const contractGrantRows = new Map<string, boolean>();
  let mintedPagedContract: ContractDefinitionView | null = null;
  const contractMintResponse = searchParams.get('contracts_mint_response');
  const recoverContractMint =
    contractMintResponse === 'fail-once-slow-retry';
  const delayContractMintResponse =
    contractMintResponse === 'slow' || recoverContractMint;
  let contractMintFailuresRemaining = recoverContractMint ? 1 : 0;
  const recoverContractPage =
    searchParams.get('contracts_page_response')
      === 'fail-once-slow-retry';
  let contractPageFailuresRemaining = recoverContractPage ? 1 : 0;
  const recoverContractRevoke =
    searchParams.get('contracts_revoke_response')
      === 'fail-once-slow-retry';
  let contractRevokeFailuresRemaining = recoverContractRevoke ? 1 : 0;
  let approvalRouteListFailurePending = failFirstApprovalRouteList;
  let receptionRecordsFailuresRemaining =
    failReceptionRecordsRetry ? 2 : failFirstReceptionRecordsLoad ? 1 : 0;
  let receptionResponsesFailuresRemaining =
    failReceptionResponsesRetry ? 2 : failFirstReceptionResponsesLoad ? 1 : 0;
  let automationScheduleListFailuresRemaining = automationScheduleListFailures;
  let automationWatchRunFailuresRemaining = failFirstAutomationWatchRun ? 1 : 0;
  let receptionResponseDetailFailuresRemaining = failReceptionResponseDetailRetry
    ? 2
    : failFirstReceptionResponseDetailLoad
      ? 1
      : 0;
  const llmConfig: Record<string, unknown> = initialAiConfigured
    ? {
        slot_1: {
          provider: 'openai',
          model: 'gpt-4.1-mini',
          has_key: true,
        },
        ...(withTwoAiSlots
          ? {
              slot_2: {
                provider: 'anthropic',
                model: 'claude-sonnet-test',
                has_key: true,
                ...(sameSpeedChatSlots ? { speed: 'fast' } : {}),
              },
            }
          : {}),
        ...(aiModelsPoolDemo
          ? {
              free_pool: [
                {
                  id: 'groq',
                  type: 'api',
                  provider: 'openai-compatible',
                  model: 'llama-free',
                  has_key: true,
                  enabled: true,
                },
              ],
            }
          : {}),
      }
    : {};
  const defaultPrompt = 'You are Recued. You speak in plain, calm prose.';
  let chatPrompt = defaultPrompt;
  let chatPromptRole: 'system' | 'user' | 'assistant' = 'system';
  let chatPromptIsDefault = true;
  let aiBudget = 5_000;
  let allowByokBackground = false;
  let pauseBackgroundAiUntil: number | null = null;
  let housekeepingUpdatedAt = FIXED_NOW;
  const housekeepingSnapshot = () => ({
    preset: 'balanced' as const,
    cycle_budget_ms: 60_000,
    cycle_interval_minutes: 15,
    allow_byok_background: allowByokBackground,
    pause_background_ai_until: pauseBackgroundAiUntil,
    updated_at: housekeepingUpdatedAt,
  });
  const llmPromptSnapshot = () => ({
    prompts: [
      {
        surface: 'chat',
        role_instructions: chatPrompt,
        default_role_instructions: defaultPrompt,
        always_on_text: ['Emit AIOutput JSON only.', 'Approvals remain enforced.'],
        composed_preview: `${chatPrompt}\n\nEmit AIOutput JSON only.`,
        role: chatPromptRole,
        default_role: 'system',
        is_default: chatPromptIsDefault,
      },
    ],
  });
  let defaultSourceId: 'slot_1' | 'slot_2' | 'free_pool' | null =
    initialAiConfigured ? 'slot_1' : null;
  let mailConnected = connectedSourceReadyDemo
    || connectedSourceAnswerDemo
    || connectedSourceCheckDemo;
  const connectionGrantedGroups = new Set<string>();
  const connectionDemoName = longConnectionTextDemo
    ? `service-${'identity'.repeat(5)}`
    : 'hubspot-work';
  const connectionDemoDisplayName = longConnectionTextDemo
    ? `Connection${'Identity'.repeat(24)}`
    : 'HubSpot work';
  const connectionDemoEndpoint = longConnectionTextDemo
    ? `https://${'endpoint'.repeat(7)}.example.test/v1`
    : undefined;
  const connectionDemoPackSlug = longConnectionTextDemo
    ? `pack-${'identity'.repeat(7)}`
    : 'installed-mail';
  const connectionDemoWriteOperation = longConnectionTextDemo
    ? `hubspot.${'deal'.repeat(12)}.write`
    : 'hubspot.deals.write';
  const packDemoName = longPackTextDemo
    ? `Pack${'N'.repeat(240)}`
    : 'Installed Mail';
  const packDemoDescription = longPackTextDemo
    ? `description-${'content'.repeat(35)}`
    : 'An installed mail workflow pack.';
  const packDemoPublisher = longPackTextDemo
    ? `publisher-${'identity'.repeat(20)}`
    : 'recued-core';
  const packDemoRecipeSlug = longPackTextDemo
    ? `recipe-${'identity'.repeat(30)}`
    : 'installed-mail-digest';
  const packDemoPermission = longPackTextDemo
    ? `permission-${'identity'.repeat(30)}`
    : null;
  const connectionGrantConnection = (): Record<string, unknown> => ({
    name: connectionDemoName,
    kind: 'api',
    display_name: connectionDemoDisplayName,
    vendor: 'hubspot',
    ...(connectionDemoEndpoint === undefined
      ? {}
      : {
          base_url: connectionDemoEndpoint,
          granted_scopes: ['crm.objects.deals.read'],
          bound_pack_slugs: [connectionDemoPackSlug],
        }),
  });
  const connectionGrantView = () => {
    const availableGroups = [
      {
        group_id: `recued-core/${connectionDemoWriteOperation}`,
        operations: [connectionDemoWriteOperation],
        risk_floor: 'write',
      },
      {
        group_id: 'recued-core/hubspot.contacts.write',
        operations: ['hubspot.contacts.write'],
        risk_floor: 'write',
      },
      {
        group_id: 'recued-core/hubspot.deals.read',
        operations: ['hubspot.deals.read'],
        risk_floor: 'read',
      },
    ].map((group) => ({
      ...group,
      granted: connectionGrantedGroups.has(group.group_id),
    }));
    return {
      connection_name: connectionDemoName,
      granted_groups: [...connectionGrantedGroups],
      allowed_operations: [
        'hubspot.deals.read',
        ...availableGroups
          .filter((group) => group.granted)
          .flatMap((group) => group.operations),
      ],
      available_groups: availableGroups,
    };
  };
  let serverPaused = false;
  let contractReadFailuresRemaining = Math.max(
    0,
    Math.floor(contractReadFailures),
  );
  let mailListReads = 0;
  let sourceAnswerSessionCreated = false;
  let sourceAnswerSendCount = 0;
  const liveControlRetiredRunIds = new Set<string>();
  let durableToolReviewed = false;
  const revokedLogsPassIds = new Set<string>();
  const longLogsTextDemo = searchParams.get('logs_text') === 'long';
  const logsPasses = [
    {
      contract_id: 'pass-live-control-1',
      display_name: longLogsTextDemo
        ? `Pass${'P'.repeat(240)}`
        : 'Send reviewed mail',
      grant_mode: 'exact',
      permits: {
        operation_ids: [longLogsTextDemo
          ? `operation.${'O'.repeat(240)}`
          : 'mail.send'],
        connection_names: [longLogsTextDemo
          ? `connection.${'C'.repeat(240)}`
          : 'gmail.work'],
      },
      risk_tier: 'write',
      channel_session_id: 'chat-live-1',
      expiry_at: FIXED_NOW + 300_000,
      remaining_ttl_ms: 300_000,
      uses_remaining: 1,
      max_uses: 1,
      lifecycle_state: 'active',
    },
    {
      contract_id: 'pass-live-control-2',
      display_name: 'Update reviewed contact',
      grant_mode: 'exact',
      permits: {
        operation_ids: ['hubspot.contact.update'],
        connection_names: ['hubspot.work'],
      },
      risk_tier: 'write',
      channel_session_id: 'chat-live-2',
      expiry_at: FIXED_NOW + 300_000,
      remaining_ttl_ms: 300_000,
      uses_remaining: 1,
      max_uses: 1,
      lifecycle_state: 'active',
    },
  ];
  let runPaletteAutoRunEnabled = true;
  let recipesRelatedAutoRunEnabled = true;
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
  const contactDemoName = longContactTextDemo
    ? `Contact${'Identity'.repeat(30)}`
    : 'Mary Rivera';
  const contactDemoEmail = longContactTextDemo
    ? `${'contact'.repeat(8)}@example.test`
    : 'mary@example.test';
  const contactDemoCompany = longContactTextDemo
    ? `Company${'Identifier'.repeat(24)}`
    : 'Northstar';
  const contactDemoRecord = {
    _id: contactDemoEmail,
    _collection: 'contact',
    email: contactDemoEmail,
    name: contactDemoName,
    company: contactDemoCompany,
    first_seen: FIXED_NOW - 86_400_000,
    last_interaction: FIXED_NOW - 3_600_000,
    interaction_count: 7,
    source: 'manual',
    created_at: FIXED_NOW - 86_400_000,
    updated_at: FIXED_NOW - 3_600_000,
  };
  const secondContactDemoRecord = {
    ...contactDemoRecord,
    _id: 'john@example.test',
    email: 'john@example.test',
    name: 'John Chen',
    company: 'Wayfinder',
  };
  const thirdContactDemoRecord = {
    ...contactDemoRecord,
    _id: 'zoe@example.test',
    email: 'zoe@example.test',
    name: 'Zoe Patel',
    company: 'Atlas',
  };
  const contactMergeRecords = {
    'alice.a@example.test': {
      ...contactDemoRecord,
      _id: 'alice.a@example.test',
      email: 'alice.a@example.test',
      name: 'Alice Archer',
      company: 'Northstar Labs',
    },
    'alice.b@example.test': {
      ...contactDemoRecord,
      _id: 'alice.b@example.test',
      email: 'alice.b@example.test',
      name: 'Alice A.',
      company: 'Northstar',
      last_interaction: FIXED_NOW,
    },
  };
  let contactMergeResolved = false;
  const formResponseDemoVisitorEmail = longFormResponseTextDemo
    ? `${'visitor'.repeat(8)}@example.test`
    : undefined;
  const formResponseDemoEndpointId = longFormResponseTextDemo
    ? `Endpoint${'Identifier'.repeat(24)}`
    : 'endpoint-intake';
  const formResponseDemoDefinitionId = longFormResponseTextDemo
    ? `Form${'Definition'.repeat(24)}`
    : 'project-intake';
  const formResponseDemoTemplate = longFormResponseTextDemo
    ? `foundation:intake:Template${'Provider'.repeat(24)}`
    : 'foundation:intake/project-brief';
  const formResponseDemoFieldName = longFormResponseTextDemo
    ? `question_${'identifier'.repeat(24)}`
    : 'project';
  const formResponseDemoFieldLabel = longFormResponseTextDemo
    ? `Question${'Identifier'.repeat(24)}`
    : 'Project';
  const formResponseDemoValue = longFormResponseTextDemo
    ? `Answer${'Provider'.repeat(30)}`
    : undefined;
  const formResponseDemoRecord = (index: number) => ({
    submission_id: `submission-${index}`,
    endpoint_id: formResponseDemoEndpointId,
    form_definition_id: formResponseDemoDefinitionId,
    visitor: {
      email: formResponseDemoVisitorEmail ?? `visitor-${index}@example.test`,
    },
    submitted_at: FIXED_NOW - index * 1_000 - 500,
    accepted_at: FIXED_NOW - index * 1_000,
    updated_at: FIXED_NOW - index * 1_000,
    lifecycle_state: 'received',
    state_changed_at: 0,
    template_ref: formResponseDemoTemplate,
  });
  const workEntityDemoTitles = new Map<number, string>();
  const taskFiltersDemo = new URLSearchParams(location.search).get('task_filters') === '1';
  const workEntityDemoTitle = `WorkEntity${'Identity'.repeat(30)}`;
  const workEntityDemoBody = `Details${'Provider'.repeat(30)}`;
  const workEntityDemoRelationship = `task-${'Related'.repeat(30)}`;
  const workEntityDemoSourceLabel = longWorkEntityTextDemo
    ? `Source${'Provider'.repeat(30)}`
    : 'Recued built-in';
  const workEntityDemoRecord = (index: number): Task & { _kind: 'task' } => ({
    _kind: 'task' as const,
    id: `task-${index}`,
    title: workEntityDemoTitles.get(index)
      ?? (longWorkEntityTextDemo ? workEntityDemoTitle : `Task ${index}`),
    ...(longWorkEntityTextDemo ? { body: workEntityDemoBody } : {}),
    done: false,
    ...(taskFiltersDemo ? [
      { due_at: Date.parse('2026-09-08T12:00:00-07:00') },
      { due_at: Date.parse('2026-09-06T12:00:00-07:00') },
      { done: true, due_at: Date.parse('2026-09-06T10:00:00-07:00'), completed_at: FIXED_NOW },
      { due_at: Date.parse('2026-09-07T12:00:00-07:00') },
      {},
    ][index] : {}),
    source_id: 'recued.task',
    last_seen_at: FIXED_NOW,
    sync_state: 'live' as const,
    conflict_policy: 'recued_wins' as const,
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    blocks_task_ids: longWorkEntityTextDemo
      ? [workEntityDemoRelationship]
      : [],
  });
  const formResponseDemoEdits = new Map<number, {
    values: Record<string, unknown>;
    visitor: Record<string, unknown>;
    lifecycle_state: string;
    state_changed_at: number;
    updated_at: number;
  }>();
  const formResponseDemoDetail = (index: number) => {
    const row = formResponseDemoRecord(index);
    const edit = formResponseDemoEdits.get(index);
    return {
      _id: row.submission_id,
      _collection: 'form_response',
      submission_id: row.submission_id,
      endpoint_id: row.endpoint_id,
      form_definition_id: row.form_definition_id,
      definition_snapshot: {
        form_definition_id: row.form_definition_id,
        fields: [{
          name: formResponseDemoFieldName,
          label: formResponseDemoFieldLabel,
          type: 'text',
        }],
      },
      values: edit?.values ?? {
        [formResponseDemoFieldName]: formResponseDemoValue ?? `Project ${index}`,
      },
      visitor: edit?.visitor ?? row.visitor,
      submitted_at: row.submitted_at,
      accepted_at: row.accepted_at,
      updated_at: edit?.updated_at ?? row.updated_at,
      origin_actor: 'anonymous',
      origin_surface: 'system',
      lifecycle_state: edit?.lifecycle_state ?? row.lifecycle_state,
      state_changed_at: edit?.state_changed_at ?? row.state_changed_at,
      metadata: { template_ref: row.template_ref },
    };
  };
  const formResponseAutomationDemoRecipe = {
    recipe_id: 'project-intake-review',
    publisher_id: 'recued-core',
    version: 1,
    recipe_hash: 'hash-project-intake-review',
    recipe: {
      recipe_id: 'project-intake-review',
      version: 1,
      ttl: 0,
      metadata: {
        name: 'Review project intake',
        description: 'Review an accepted project intake response.',
        author: 'recued-core',
        supported_platforms: [],
        tags: [],
      },
      variables: {},
      prefetch_steps: [],
      steps: [],
      output: { sidebar: [] },
      requires: [],
      event_triggers: [{
        on: 'form_response.accepted',
        where: { form_definition_id: 'project-intake' },
      }],
    },
    source: 'pair-sync',
    installed_at: FIXED_NOW,
  };
  const formResponseAutomationDemoRecipes = [
    formResponseAutomationDemoRecipe,
    {
      ...formResponseAutomationDemoRecipe,
      recipe_id: 'all-intakes-review',
      recipe_hash: 'hash-all-intakes-review',
      recipe: {
        ...formResponseAutomationDemoRecipe.recipe,
        recipe_id: 'all-intakes-review',
        metadata: {
          ...formResponseAutomationDemoRecipe.recipe.metadata,
          name: 'Review every intake',
        },
        event_triggers: [{ on: 'form_response.accepted' }],
      },
    },
  ];
  const memoryDemoOwnId = longMemoryTextDemo
    ? `memory-${'identifier'.repeat(30)}`
    : 'memory-own-1';
  const memoryDemoOwnKind = longMemoryTextDemo
    ? `preference_${'kind'.repeat(24)}`
    : 'preference';
  const memoryDemoOwnSummary = longMemoryTextDemo
    ? `summary-${'identity'.repeat(24)}`
    : 'Concise answers';
  const memoryDemoOwnPreview = longMemoryTextDemo
    ? `preview-${'provider'.repeat(28)}`
    : 'Keep answers concise and direct.';
  const memoryDemoOwnBody = longMemoryTextDemo
    ? `body-${'provider'.repeat(40)}`
    : 'Keep answers concise and direct.';
  const memoryDemoOwnSize = longMemoryTextDemo
    ? memoryDemoOwnBody.length
    : 31;
  const memoryDemoSystemId = longMemoryTextDemo
    ? `system-memory-${'identifier'.repeat(28)}`
    : 'memory-system-1';
  const memoryDemoSystemKind = longMemoryTextDemo
    ? `run_${'kind'.repeat(24)}`
    : 'run';
  const memoryDemoSystemSummary = longMemoryTextDemo
    ? `remembered-${'execution'.repeat(26)}`
    : 'Recipe execution remembered';
  const memoryDemoAgentId = 'memory-agent-1';
  const memoryDemoAgentAttribution = {
    kind: 'agent' as const,
    origin_actor: 'contracted_user' as const,
    agent_id: 'browser-agent',
    contract_id: 'browser-contract',
    label: 'agent browser-agent, under contract browser-contract, asserted this',
  };
  const memoryDemoRunId = longMemoryTextDemo
    ? `run-${'identifier'.repeat(30)}`
    : 'run-memory-1';
  const memoryDemoGetError = longMemoryTextDemo
    ? `memory-${'unavailable'.repeat(28)}`
    : 'Memory entry temporarily unavailable.';
  const memoryDemoDeleteError = longMemoryTextDemo
    ? `delete-${'unavailable'.repeat(28)}`
    : 'Memory delete temporarily unavailable.';
  let recordsDemoDeleted = false;
  let recordsDemoEventRetired = false;
  let recordsDemoPurged = false;
  const recordsDemoPublisher = longRecordsTextDemo
    ? `publisher-${'identity'.repeat(10)}`
    : 'publisher-a';
  const recordsDemoPackSlug = longRecordsTextDemo
    ? `pack-${'identifier'.repeat(10)}`
    : 'same-board';
  const recordsDemoKind = longRecordsTextDemo
    ? `entity_${'kind'.repeat(18)}`
    : 'job';
  const recordsDemoTitleField = longRecordsTextDemo
    ? `field_${'identifier'.repeat(18)}`
    : 'title';
  const recordsDemoRecordId = longRecordsTextDemo
    ? `record-${'identifier'.repeat(30)}`
    : 'job-1';
  const recordsDemoParentId = longRecordsTextDemo
    ? `parent-${'identifier'.repeat(30)}`
    : 'job-0';
  const recordsDemoTitle = longRecordsTextDemo
    ? `title-${'value'.repeat(40)}`
    : 'Prepare quote';
  const recordsDemoParentRef =
    `${recordsDemoKind}/${encodeURIComponent(recordsDemoParentId)}`;
  const recordsDemoRelationshipField = longRecordsTextDemo
    ? `relationship_${'field'.repeat(28)}`
    : 'parent';
  const recordsDemoEventType = longRecordsTextDemo
    ? `record.${'delivery'.repeat(24)}`
    : 'record.updated';
  const recordsDemoDeliveryRecipe = longRecordsTextDemo
    ? `recipe-${'identifier'.repeat(28)}`
    : 'watch-record-updates';
  const recordsDemoDeliveryError = longRecordsTextDemo
    ? `delivery-${'failure'.repeat(32)}`
    : undefined;
  const recordsDemoSchema = {
    decimal_scale: 4,
    entities: {
      [recordsDemoKind]: {
        kind: recordsDemoKind,
        fields: [
          { key: 'id', slot: 'pk', kind: 'id', required: true },
          {
            key: recordsDemoTitleField,
            slot: 's1',
            kind: 'string',
            required: true,
          },
          {
            key: 'customer.email',
            slot: 's2',
            kind: 'string',
            required: true,
            privacy: 'email',
          },
          { key: 'amount', slot: 'dec1', kind: 'decimal', required: true },
          { key: 'parent', slot: 'r1', kind: 'ref', required: false },
        ],
      },
      ...(recordsNavigationDemo
        ? {
            invoice: {
              kind: 'invoice',
              fields: [
                { key: 'id', slot: 'pk', kind: 'id', required: true },
                { key: 'status', slot: 's1', kind: 'string', required: true },
                { key: 'total', slot: 'dec1', kind: 'decimal', required: true },
              ],
            },
          }
        : {}),
    },
  };
  const recordsDemoRecord = {
    id: recordsDemoRecordId,
    [recordsDemoTitleField]: recordsDemoTitle,
    customer: { email: 'alice@example.test' },
    amount: '9.0000',
    parent: recordsDemoParentRef,
    _record: {
      entity: recordsDemoKind,
      version: 3,
      revision: 1,
      created_at: FIXED_NOW - 1_000,
      updated_at: FIXED_NOW,
    },
  };
  const recordsNavigationJob = {
    ...recordsDemoRecord,
    id: 'job-b',
    [recordsDemoTitleField]: 'Review proposal',
    _record: { ...recordsDemoRecord._record, revision: 2 },
  };
  const recordsNavigationInvoice = {
    id: 'invoice-1',
    status: 'open',
    total: '42.0000',
    _record: {
      entity: 'invoice',
      version: 3,
      revision: 1,
      created_at: FIXED_NOW - 2_000,
      updated_at: FIXED_NOW - 1_000,
    },
  };
  const recordsDemoNamespace = (publisher = recordsDemoPublisher) => ({
    owner: { publisher, pack_slug: recordsDemoPackSlug },
    state: recordsOrphanedDemo
      ? {
          state: 'orphaned' as const,
          last_version: 3,
          storage_schema_hash: 'a'.repeat(64),
          declaration_hash: 'b'.repeat(64),
        }
      : {
          state: 'ready' as const,
          version: 3,
          storage_schema_hash: 'a'.repeat(64),
          declaration_hash: 'b'.repeat(64),
        },
    activation_generation: 2,
    state_generation: 4,
    quota: {
      row_count: recordsDemoDeleted ? 0 : 1,
      payload_bytes: recordsDemoDeleted ? 0 : 42,
      row_limit: 100,
      byte_limit: 1_000,
      outbox_count: recordsDemoEventRetired ? 0 : 1,
      outbox_limit: 100,
      data_generation: recordsDemoDeleted ? 2 : 1,
    },
    schema: recordsDemoSchema,
    artifact_digest: 'artifact',
    subscriber_digest: 'subscriber',
    updated_at: FIXED_NOW,
  });
  const recordsDemoDiagnostics = {
    raw_slots: {
      s1: recordsDemoTitle,
      s2: 'alice@example.test',
      dec1: '90000',
      r1: recordsDemoParentRef,
    },
    outgoing: [{
      source_entity: recordsDemoKind,
      source_id: recordsDemoRecordId,
      source_field: 'parent',
      source_slot: 'r1',
      target_entity: recordsDemoKind,
      target_id: recordsDemoParentId,
    }],
    incoming: longRecordsTextDemo
      ? [{
          source_entity: recordsDemoKind,
          source_id: `source-${'identifier'.repeat(30)}`,
          source_field: recordsDemoRelationshipField,
          source_slot: 'r1',
          target_entity: recordsDemoKind,
          target_id: recordsDemoRecordId,
        }]
      : [],
  };
  const longAutomationRecipeId = `automation-${'recipe'.repeat(16)}`;
  const longAutomationEntity = 'invoice'.repeat(24);
  let automationScheduleEnabled = true;
  const automationSchedule = () => ({
    schedule_id: 'schedule-e2e-1',
    recipe_id: 'daily-brief',
    publisher_id: 'recued-core',
    cron_expression: '0 9 * * *',
    enabled: automationScheduleEnabled,
    created_at: FIXED_NOW - 86_400_000,
    last_run_at: FIXED_NOW - 3_600_000,
    next_run_at: FIXED_NOW + 3_600_000,
    last_status: 'success',
    last_error: null,
  });
  const secondAutomationSchedule = {
    ...automationSchedule(),
    schedule_id: 'schedule-e2e-2',
    recipe_id: 'weekly-report',
    cron_expression: '0 16 * * 5',
    created_at: FIXED_NOW - 172_800_000,
  };
  let automationWatchLastPollAt: number | null = null;
  const automationWatch = () => ({
    watch_key: longAutomationTextDemo
      ? `acme/${longAutomationEntity}/${'connection'.repeat(14)}`
      : 'hubspot/deal/main-crm',
    source_id: 'connection-api',
    connection_name: longAutomationTextDemo
      ? `connection-${'identity'.repeat(18)}`
      : 'main-crm',
    vendor: longAutomationTextDemo ? 'acme' : 'hubspot',
    entity: longAutomationTextDemo ? longAutomationEntity : 'deal',
    enabled: true,
    active: true,
    deferred_to: null,
    effective_interval_ms: 900_000,
    subscriber_recipe_ids: [longAutomationTextDemo
      ? longAutomationRecipeId
      : 'deal-watch'],
    last_poll_at: automationWatchLastPollAt,
    last_status: automationWatchLastPollAt === null ? null : 'ok',
    last_error: longAutomationTextDemo
      ? `poll-${'unavailable'.repeat(30)}`
      : null,
    baselined: automationWatchLastPollAt !== null,
    consecutive_failures: 0,
  });
  let automationDishName = 'Morning digest';
  const automationDish = () => ({
    dish_id: 'dish-e2e-1',
    recipe_id: 'daily-brief',
    publisher_id: 'recued-core',
    name: automationDishName,
    is_default: false,
    config_overlay: {},
    enabled: true,
    created_at: FIXED_NOW - 86_400_000,
  });
  const automationDishRun = {
    run_id: 'dish-run-e2e-1',
    started_at: FIXED_NOW - 3_600_000,
    duration_ms: 240,
    commit_status: 'succeeded',
    trigger_source: 'schedule',
    error: null,
  };
  const deletedAutomationSchedules = new Set<string>();
  let recipeRunModalSchedules: Array<Record<string, unknown>> = [];
  let automationRunModalTriggers: Array<Record<string, unknown>> =
    longAutomationTextDemo
      ? [{
          trigger_id: `trigger-${'identity'.repeat(14)}`,
          recipe_id: longAutomationRecipeId,
          publisher_id: 'recued-core',
          pattern: `data.connection.api.acme.${longAutomationEntity}.updated`,
          enabled: true,
          created_at: FIXED_NOW - 86_400_000,
          last_fired_at: FIXED_NOW - 3_600_000,
          last_error: null,
          origin: 'recipe',
          fields: [`record.${'attribute'.repeat(22)}`],
          filter: {
            [`payload.${'segment'.repeat(20)}`]: `expected-${'value'.repeat(34)}`,
          },
        }]
      : [];
  const mailInstances = (): ReadonlyArray<Record<string, unknown>> => {
    if (
      !firstSyncDemo
      && !connectedSourceReadyDemo
      && !connectedSourceAnswerDemo
      && !connectedSourceCheckDemo
      && !imapEnrollSucceeds
    ) return [];
    mailListReads += 1;
    if (!mailConnected) return [];
    return [{
      slug: imapEnrollSucceeds
        ? 'fastmail'
        : longAccountTextDemo
          ? `mailbox-${'identity'.repeat(7)}`
          : 'work',
      adapter_type: imapEnrollSucceeds ? 'imap' : 'gmail',
      auth_state: 'healthy',
      // Initial route list = read 1; post-enroll refresh = read 2 (pending);
      // two quiet panel polls keep the pending state observable, then ready.
      last_synced_at:
        imapEnrollSucceeds
        || connectedSourceReadyDemo
        || connectedSourceAnswerDemo
        || (connectedSourceCheckDemo && mailListReads >= 2)
        || mailListReads >= 4
        ? FIXED_NOW
        : null,
      send_capable: false,
      account_email: imapEnrollSucceeds
        ? 'me@example.com'
        : longAccountTextDemo
          ? `${'account'.repeat(8)}@example.test`
          : 'person@example.com',
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
  const longCollectionMethod = `POST${'Method'.repeat(30)}`;
  const longCollectionRemoteIp = `Remote${'Address'.repeat(30)}`;
  const longCollectionRecordId = `Webhook${'Identifier'.repeat(24)}`;
  const longCollectionSourceId = `Source${'Identifier'.repeat(24)}`;
  const longCollectionBody = `Payload${'Value'.repeat(40)}`;
  const longCollectionRecord = {
    record_id: longCollectionRecordId,
    received_at: FIXED_NOW - 20_000,
    modified_at: FIXED_NOW - 10_000,
    hot_fields: {
      method: longCollectionMethod,
      remote_ip: longCollectionRemoteIp,
      [`Header${'Identifier'.repeat(20)}`]: `Header${'Value'.repeat(40)}`,
    },
    size_bytes: longCollectionBody.length,
    source_id: longCollectionSourceId,
    body_inline: longCollectionBody,
  };
  const longCollectionInstances = [0, 1].map((index) => ({
    slug: `Instance${'Identifier'.repeat(20)}${index}`,
    platform: 'webhook' as const,
    adapter_type: `Adapter${'Provider'.repeat(20)}${index}`,
    caps: {},
    auth_state: 'healthy',
    last_synced_at: FIXED_NOW,
  }));
  const fileDownloadRecord = {
    record_id: 'file:0123456789abcdef0123456789abcdef',
    received_at: FIXED_NOW - 20_000,
    modified_at: FIXED_NOW - 10_000,
    hot_fields: {
      path: '/docs/quarterly-plan.txt',
      size: 5,
      mime_type: 'text/plain',
    },
    size_bytes: 5,
    source_id: 'file:0123456789abcdef0123456789abcdef',
  };
  const longLogsRecipeId =
    `calendar/${'recipe'.repeat(40)}`;
  const verificationRun = {
    run_id: 'run-verify',
    recipe_id: longLogsTextDemo
      ? longLogsRecipeId
      : 'calendar/schedule-review',
    name: longLogsTextDemo
      ? `Run${'N'.repeat(240)}`
      : 'Schedule customer review',
    started_at: FIXED_NOW - 4_000,
    finished_at: FIXED_NOW - 2_000,
    duration_ms: 2_000,
    origin: referenceProvenanceDemo
      ? {
          actor: 'contracted_user' as const,
          label: 'contracted_user',
          channel: 'mcp' as const,
          attribution: {
            kind: 'agent' as const,
            origin_actor: 'contracted_user' as const,
            agent_id: 'browser-agent',
            contract_id: 'browser-contract',
            label: 'agent browser-agent, under contract browser-contract, asserted this',
          },
        }
      : {
          actor: 'user_self' as const,
          label: 'user_self',
          channel: 'user' as const,
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
      recipe_hash: longLogsTextDemo
        ? `hash-${'H'.repeat(240)}`
        : 'hash-verification-run',
      started_at: verificationRun.started_at,
      finished_at: verificationRun.finished_at,
      duration_ms: verificationRun.duration_ms,
      status: verificationRun.status,
      origin: verificationRun.origin,
      trigger_source: longLogsTextDemo
        ? `trigger-${'T'.repeat(240)}`
        : 'manual',
      instance_id: longLogsTextDemo
        ? `server-${'I'.repeat(240)}`
        : 'server-verification',
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
  const olderVerificationRun = {
    ...verificationRun,
    run_id: 'run-verify-older',
    recipe_id: 'crm/sync-account',
    name: 'Sync customer account',
    started_at: FIXED_NOW - 14_000,
    finished_at: FIXED_NOW - 12_000,
    status: 'succeeded',
    policy_result: 'allowed',
    links: [],
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
    recipe_id: searchParams.get('approvals_text') === 'long'
      ? `recipe-${'R'.repeat(240)}`
      : 'crm/update-contact',
    step_id: searchParams.get('approvals_text') === 'long'
      ? `step-${'S'.repeat(240)}`
      : 'update-company',
    ingredient_slug: searchParams.get('approvals_text') === 'long'
      ? `ingredient-${'I'.repeat(240)}`
      : 'hubspot-contact-update',
    risk_tier: destructiveApprovalDemo ? 'destructive' : 'write',
    description: searchParams.get('approvals_text') === 'long'
      ? `Update${'D'.repeat(240)}`
      : 'Update Acme\'s account owner in HubSpot',
    resolved_input: searchParams.get('approvals_text') === 'long'
      ? {
          [`field-${'K'.repeat(120)}`]: `value-${'V'.repeat(240)}`,
        }
      : {
          company: 'Acme',
          owner: 'Jordan Lee',
        },
    created_at: FIXED_NOW - 2_000,
    timeout_at: FIXED_NOW + 300_000,
    initiator_instance: searchParams.get('approvals_text') === 'long'
      ? `browser-${'B'.repeat(240)}`
      : 'browser-demo',
  };
  let attentionApprovalPending = true;
  const attentionAsk = {
    ask_id: 'ask-attention-1',
    title: searchParams.get('approvals_text') === 'long'
      ? `Send${'T'.repeat(240)} (write)`
      : 'Send the customer follow-up?',
    text: searchParams.get('approvals_text') === 'long'
      ? `Destination${'E'.repeat(240)}`
      : 'This will send one email to customer@example.com.',
    options: searchParams.get('approvals_text') === 'long'
      ? [
          { id: 'approve', label: `Approve${'A'.repeat(180)}` },
          { id: 'reject', label: `Reject${'J'.repeat(180)}` },
        ]
      : [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
    created_at: FIXED_NOW - 1_000,
  };
  let attentionAskPending = true;
  const attentionPlan = {
    plan: {
      plan_id: 'plan-attention-1',
      session_id: 'chat-attention-1',
      turn_id: 'turn-attention-1',
      tool: 'mail.send',
      tier: 2,
      classification: 'write',
      args: {
        to: 'customer@example.com',
        subject: 'Follow-up',
      },
      args_hash: 'attention-plan-args-hash',
      status: 'proposed',
      created_at: FIXED_NOW,
    },
    message_id: 'message-attention-1',
    payload_available: true,
  };
  let attentionPlanPending = true;
  const longReceptionTextDemo =
    searchParams.get('reception_text') === 'long';
  const receptionItemTitle = longReceptionTextDemo
    ? `Follow${'T'.repeat(240)}`
    : 'Follow up with Morgan';
  const receptionItemSubtitle = longReceptionTextDemo
    ? `Website${'S'.repeat(220)}`
    : 'Website intake';
  const receptionItemOperation = longReceptionTextDemo
    ? `crm.${'O'.repeat(220)}`
    : 'crm.commitment.create';
  const receptionItemAction = longReceptionTextDemo
    ? `Create${'A'.repeat(220)}`
    : 'Create a commitment';
  const receptionInboxItem = {
    hold_id: 'hold-reception-1',
    operation_id: receptionItemOperation,
    top_tier_kind: 'commitment',
    source: {
      kind: 'intake_form',
      endpoint_id: 'endpoint-reception-1',
      record_ref: 'record-reception-1',
    },
    args: receptionDestinationRecoveryDemo
      ? { title: receptionItemTitle, source_id: 'builtin.commit' }
      : { title: receptionItemTitle },
    arg_schema: {
      fields: [
        {
          key: 'title',
          type: 'string',
          label: 'Title',
          required: true,
        },
        ...(receptionDestinationRecoveryDemo
          ? [{
              key: 'source_id',
              type: 'string',
              label: 'Destination',
              options_source: 'reception_destination_sources',
              affects_target: true,
            }]
          : []),
      ],
    },
    preview: {
      title: receptionItemTitle,
      subtitle: receptionItemSubtitle,
      when: FIXED_NOW - 5_000,
    },
    proposed_action: receptionItemAction,
    status: 'pending',
  };
  const secondReceptionInboxItem = {
    ...receptionInboxItem,
    hold_id: 'hold-reception-2',
    source: {
      kind: 'intake_form',
      endpoint_id: 'endpoint-reception-2',
      record_ref: 'record-reception-2',
    },
    args: { title: 'Prepare the launch brief' },
    preview: {
      title: 'Prepare the launch brief',
      subtitle: 'Partner intake',
      when: FIXED_NOW - 4_000,
    },
  };
  let receptionInboxItems = [
    receptionInboxItem,
    secondReceptionInboxItem,
  ];
  let receptionDecisionAcknowledged = false;
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
        if (
          rpc.method === 'collection.contract.listContracts'
          && (rpc.args as { cursor?: unknown } | undefined)?.cursor !== undefined
        ) {
          const pageReadKey = 'collection.contract.listContracts.cursor';
          rpcCallCounts.set(
            pageReadKey,
            (rpcCallCounts.get(pageReadKey) ?? 0) + 1,
          );
        }
        let result: unknown = rpc.method === 'chat.sessions.list'
          ? {
              sessions: withChatSession
                ? [
                    {
                      id: 'chat_1',
                      title: chatSessionTitle,
                      created_at: FIXED_NOW - 2_000,
                      last_active_at: FIXED_NOW - 1_000,
                      message_count: 1,
                      archived: false,
                      picker_state: { current: 'self' },
                      model_routing: {
                        current: 'byok',
                        provider: 'openai',
                        ...(sameSpeedChatSlots
                          ? {
                              model_hint: 'fast',
                              source_id: 'slot_2',
                              overridden: true,
                            }
                          : { overridden: false }),
                      },
                    },
                  ]
                : [],
            }
          : rpc.method === 'chat.session.get' && withChatSession
            ? {
                id: 'chat_1',
                title: chatSessionTitle,
                created_at: FIXED_NOW - 2_000,
                last_active_at: FIXED_NOW - 1_000,
                archived: false,
                picker_state: { current: 'self' },
                model_routing: {
                  current: 'byok',
                  provider: 'openai',
                  model_id: 'gpt-4.1-mini',
                  ...(sameSpeedChatSlots
                    ? {
                        model_hint: 'fast',
                        source_id: 'slot_2',
                        overridden: true,
                      }
                    : { overridden: false }),
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
        let error: { code: string; message: string } | undefined;
        const chatSearchReply = chatHistorySearchReply(rpc.method, rpc.args);
        if (chatSearchReply !== null) {
          result = chatSearchReply.result;
          error = chatSearchReply.error;
        }
        const savedViewsReply = savedViewsDemoReply(rpc.method, rpc.args);
        if (savedViewsReply !== null) {
          result = savedViewsReply.result;
          error = savedViewsReply.error;
        }
        if (rpc.method === 'collection.searchAll') result = { groups: [] };
        let beforeRpcResponse: (() => void) | null = null;
        if (
          archiveRestorePreviewDemo
          && rpc.method === 'server.archive.import'
          && (rpc.args as { dry_run?: unknown } | undefined)?.dry_run === true
        ) {
          result = {
            manifest: {
              format_version: 1,
              schema_version: 1,
              exported_at: '2026-08-02T12:00:00.000Z',
              record_count: 42,
              tables: { mail: 24, calendar: 18 },
              includes_blobs: true,
              includes_passport: true,
            },
            restored_at: null,
            realm: 'same',
            schema_compat: { status: 'ok', server_schema_version: 1 },
          };
        }
        if (learningCasesDemo && rpc.method === 'chat.execution.learned') {
          result = {
            cases: learningDemoCasePresent
              ? [{
                  case_id: 'learning-case-1',
                  request: ['send the quarterly report'],
                  flows: [{
                    tools_that_may_be_needed: ['file.search', 'mail.send'],
                    outcome: ['You confirmed this was right.'],
                  }],
                  shown_to_model: true,
                  request_observations: 3,
                  last_seen_at: FIXED_NOW,
                }, ...(
                  learningMultipleCasesDemo
                    ? [{
                        case_id: 'learning-case-2',
                        request: ['schedule the weekly inventory digest'],
                        flows: [{
                          tools_that_may_be_needed: ['calendar.create', 'file.search'],
                          outcome: ['You confirmed this was right.'],
                        }],
                        shown_to_model: true,
                        request_observations: 2,
                        last_seen_at: FIXED_NOW - 86_400_000,
                      }]
                    : []
                )]
              : [],
          };
        }
        if (learningCasesDemo && rpc.method === 'chat.execution.forget') {
          if (failLearningForget) {
            result = undefined;
            error = {
              code: 'UNAVAILABLE',
              message: 'Learning history is temporarily unavailable.',
            };
          } else {
            learningDemoCasePresent = false;
            result = { removed: true, cases_remaining: 0 };
          }
        }
        if (
          learningCasesDemo
          && rpc.method === 'chat.execution.draft_recipe'
        ) {
          if (learningDraftHandoffRecoveryDemo) {
            result = {
              ok: true,
              recipe: {
                recipe_id: 'learned-quarterly-report',
                version: 1,
                ttl: 0,
                metadata: {
                  name: 'Quarterly report',
                  description: 'Prepare the quarterly report.',
                  author: 'owner',
                  supported_platforms: [],
                  tags: [],
                },
                variables: {},
                prefetch_steps: [],
                steps: [],
                output: { sidebar: [] },
                requires: [],
              },
              issues: [],
              request_aliased: true,
            };
          } else if (failLearningDraft) {
            result = undefined;
            error = {
              code: 'UNAVAILABLE',
              message: 'Recipe drafting is temporarily unavailable.',
            };
          } else {
            result = {
              ok: false,
              issues: ['The generated recipe was not valid.'],
              reason: 'invalid_recipe',
            };
          }
        }
        if (failChatSessionOpen && rpc.method === 'chat.session.get') {
          error = {
            code: 'UNAVAILABLE',
            message: 'Chat session unavailable.',
          };
        }
        if (rpc.method === 'server.getLlmPrompts') {
          result = llmPromptSnapshot();
        }
        if (rpc.method === 'server.getLLMUsage') {
          // This read participates in the AI page's initial load. Leaving it
          // unanswered times out the connection and blocks later mutations.
          result = {
            day: new Date(FIXED_NOW).toISOString().slice(0, 10),
            sources: [],
            server_tokens_today: 0,
            server_budget_tokens: aiBudget,
          } satisfies ServerLlmUsageResponse;
        }
        if (rpc.method === 'server.getConfigSchema') {
          result = {
            schema: aiModelsUsageDemo
              ? [
                  {
                    section: 'LLM',
                    key: 'llm.budget',
                    label: 'Daily token budget',
                    type: 'number',
                    value: aiBudget,
                    min: 0,
                    integer: true,
                  },
                ]
              : [],
          };
        }
        if (rpc.method === 'housekeeping.config.read') {
          result = housekeepingSnapshot();
        }
        if (housekeepingDemo && rpc.method === 'housekeeping.status.read') {
          result = {
            tasks: [{
              meta: {
                id: 'enrichment.summary',
                description: 'Mail summary digest',
                interruptible: true,
                kind: 'enrichment',
              },
              enrichment: {
                token_estimate_per_record: 600,
                source_collection_count: 50,
                ai_path_available: true,
                scope_read: [{
                  collection: 'data.mail',
                  sample_field_paths: ['subject'],
                  record_count: 50,
                }],
                effective_pool_policy: 'free_then_byok',
                global_byok_allowed: true,
              },
            }, {
              meta: {
                id: 'enrichment.thread_signals',
                description: 'Thread relationship signals',
                interruptible: true,
                kind: 'enrichment',
              },
              enrichment: {
                token_estimate_per_record: 0,
                source_collection_count: 80,
                ai_path_available: true,
                scope_read: [{
                  collection: 'data.mail',
                  sample_field_paths: ['thread_id'],
                  record_count: 80,
                }],
                effective_pool_policy: 'free_then_byok',
                global_byok_allowed: true,
              },
            }],
          };
        }
        if (housekeepingDemo && rpc.method === 'housekeeping.trust.read') {
          result = {
            rows: [{
              topic: 'summary',
              trust_state: 'auto',
              pool_policy: 'free_then_byok',
              manual_run_count: 0,
              promotion_suggested_at: null,
              promotion_dismissed_at: null,
              updated_at: FIXED_NOW,
            }, {
              topic: 'thread_signals',
              trust_state: 'auto',
              pool_policy: 'free_then_byok',
              manual_run_count: 0,
              promotion_suggested_at: null,
              promotion_dismissed_at: null,
              updated_at: FIXED_NOW,
            }],
          };
        }
        if (housekeepingDemo && rpc.method === 'housekeeping.registry.describe') {
          result = {
            topics: [{
              topic: 'summary',
              temporal_class: 'stable_truth',
              identity_aggregation: 'scenario',
              lifecycle_policy: 'forward_only',
              valid_scopes: ['mail'],
              compression_class: 'lossy',
              prompt_bias_hints: [],
              description: 'Mail summary digest',
              ai_surface: true,
              mcp_exposed: 'public',
              coverage: {
                row_count: 50,
                latest_event_at: FIXED_NOW,
                producer_last_run_at: FIXED_NOW,
                producer_failure_rate_24h: 0,
                ai_surface: true,
              },
              coverage_quality: 'high',
              coverage_quality_reasoning: '50 rows, fresh',
            }, {
              topic: 'thread_signals',
              temporal_class: 'stable_truth',
              identity_aggregation: 'scenario',
              lifecycle_policy: 'forward_only',
              valid_scopes: ['mail'],
              compression_class: 'lossless',
              prompt_bias_hints: [],
              description: 'Thread relationship signals',
              ai_surface: false,
              mcp_exposed: 'public',
              coverage: {
                row_count: 80,
                latest_event_at: FIXED_NOW,
                producer_last_run_at: FIXED_NOW,
                producer_failure_rate_24h: 0,
                ai_surface: false,
              },
              coverage_quality: 'high',
              coverage_quality_reasoning: '80 rows, fresh',
            }],
            total_rows_visible: 130,
          };
        }
        if (automationRulesDemo && rpc.method === 'schedules.list') {
          if (automationScheduleListFailuresRemaining > 0) {
            automationScheduleListFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: longAutomationTextDemo
                ? `schedules-${'unavailable'.repeat(36)}`
                : 'Schedules are temporarily unavailable.',
            };
          } else {
            const candidates = automationDeleteDemo
              ? [automationSchedule(), secondAutomationSchedule]
              : [automationSchedule()];
            result = {
              schedules: candidates.filter(
                (schedule) =>
                  !deletedAutomationSchedules.has(schedule.schedule_id),
              ),
            };
          }
        }
        // D-266 — the missed-run card reads this on every Automation load.
        // Empty by default: the demo schedules are not in an outage, and a
        // card the fixtures never asked for would change every existing
        // Automation assertion.
        if (rpc.method === 'schedules.missed') {
          result = { outage_from: null, outage_to: Date.now(), entries: [] };
        }
        if (automationRulesDemo && rpc.method === 'triggers.list') {
          result = { triggers: automationRunModalTriggers };
        }
        if (automationRulesDemo && rpc.method === 'triggers.create') {
          const args = rpc.args as {
            recipe_id?: unknown;
            publisher_id?: unknown;
            pattern?: unknown;
          };
          const trigger = {
            trigger_id: `trigger-run-modal-${automationRunModalTriggers.length + 1}`,
            recipe_id: typeof args.recipe_id === 'string'
              ? args.recipe_id
              : 'autorun-live-1',
            publisher_id: typeof args.publisher_id === 'string'
              ? args.publisher_id
              : 'recued-core',
            pattern: typeof args.pattern === 'string'
              ? args.pattern
              : 'data.mail.**',
            enabled: true,
            created_at: FIXED_NOW,
            last_fired_at: null,
            last_error: null,
            origin: 'user',
          };
          automationRunModalTriggers = [...automationRunModalTriggers, trigger];
          result = { trigger };
        }
        if (automationRulesDemo && rpc.method === 'triggers.update') {
          const args = rpc.args as {
            trigger_id?: unknown;
            enabled?: unknown;
            config_overlay?: unknown;
          };
          const triggerId = typeof args.trigger_id === 'string'
            ? args.trigger_id
            : '';
          automationRunModalTriggers = automationRunModalTriggers.map((trigger) =>
            trigger.trigger_id === triggerId
              ? {
                  ...trigger,
                  ...(typeof args.enabled === 'boolean'
                    ? { enabled: args.enabled }
                    : {}),
                  ...(args.config_overlay !== undefined
                    ? { config_overlay: args.config_overlay }
                    : {}),
                }
              : trigger);
          result = {
            trigger: automationRunModalTriggers.find(
              (trigger) => trigger.trigger_id === triggerId,
            ),
          };
        }
        if (automationRulesDemo && rpc.method === 'triggers.delete') {
          const triggerId = (
            rpc.args as { trigger_id?: unknown }
          ).trigger_id;
          if (typeof triggerId === 'string') {
            automationRunModalTriggers = automationRunModalTriggers.filter(
              (trigger) => trigger.trigger_id !== triggerId,
            );
          }
          result = { ok: true };
        }
        if (automationRulesDemo && rpc.method === 'watch.list') {
          result = { watches: automationWatchDemo ? [automationWatch()] : [] };
        }
        if (automationRulesDemo && rpc.method === 'watch.run_now') {
          if (automationWatchRunFailuresRemaining > 0) {
            automationWatchRunFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: 'Watch run unavailable.',
            };
          } else {
            automationWatchLastPollAt = FIXED_NOW;
            result = { entry: automationWatch() };
          }
        }
        if (automationRulesDemo && rpc.method === 'dishes.list') {
          result = automationDishesDemo
            ? { dishes: [automationDish()], last_runs: {} }
            : { dishes: [], last_runs: {} };
        }
        if (automationDishesDemo && rpc.method === 'dishes.update') {
          const name = (rpc.args as { name?: unknown }).name;
          if (typeof name === 'string') automationDishName = name;
          result = { dish: automationDish() };
        }
        if (automationDishesDemo && rpc.method === 'dishes.history') {
          if (automationDishHistoryFailuresRemaining > 0) {
            automationDishHistoryFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: 'Dish history is temporarily unavailable.',
            };
          } else {
            result = { runs: [automationDishRun] };
          }
        }
        if (automationRulesDemo && rpc.method === 'auth.state') {
          result = { state: 'unlocked' };
        }
        if (automationRulesDemo && rpc.method === 'schedules.update') {
          if (failAutomationScheduleUpdate) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Schedule update unavailable.',
            };
          } else {
            const enabled = (rpc.args as { enabled?: unknown }).enabled;
            if (typeof enabled === 'boolean') automationScheduleEnabled = enabled;
            result = { schedule: automationSchedule() };
          }
        }
        if (automationRulesDemo && rpc.method === 'schedules.delete') {
          if (failAutomationScheduleDelete) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Schedule removal unavailable.',
            };
          } else {
            const scheduleId = (
              rpc.args as { schedule_id?: unknown }
            ).schedule_id;
            if (typeof scheduleId === 'string') {
              deletedAutomationSchedules.add(scheduleId);
            }
            result = { deleted: true };
          }
        }
        if (notificationsDemo && rpc.method === 'notifications.describe') {
          if (notificationsDescribeFailuresRemaining > 0) {
            notificationsDescribeFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: 'Notification channels unavailable.',
            };
          } else {
            result = {
              rows: [
                {
                  channel: 'ui',
                  capability: 'inline',
                  notification: true,
                  approval: true,
                  notification_togglable: false,
                  approval_togglable: false,
                  ready: true,
                },
                {
                  channel: 'bridge',
                  capability: 'notify-only',
                  notification: bridgeNotificationsEnabled,
                  approval: false,
                  notification_togglable: true,
                  approval_togglable: false,
                  ready: true,
                },
              ],
              verification_phrase: notificationVerificationPhrase,
            };
          }
        }
        if (notificationsDemo && rpc.method === 'notifications.describe_bridges') {
          result = {
            rows: [{
              client_token_id: 'bridge-main',
              label: 'Main browser',
              modes: pairedBridgeModes,
              connected: true,
            }],
          };
        }
        if (notificationsDemo && rpc.method === 'notifications.set_channel') {
          if (failNotificationsMutation) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Notification setting unavailable.',
            };
          } else {
            const args = rpc.args as {
              channel?: unknown;
              patch?: { notification?: unknown };
            };
            if (
              args.channel === 'bridge'
              && typeof args.patch?.notification === 'boolean'
            ) {
              bridgeNotificationsEnabled = args.patch.notification;
            }
            result = {
              ok: true,
              settings: {
                ui: true,
                bridge: bridgeNotificationsEnabled,
                slack: { notification: false, approval: false, messenger: false },
                telegram: { notification: false, approval: false, messenger: false },
                whatsapp: { notification: false, approval: false, messenger: false },
                discord: { notification: false, approval: false, messenger: false },
                email: { notification: false, approval: false, messenger: false },
                verification_phrase: notificationVerificationPhrase,
                bridges: {
                  'bridge-main': pairedBridgeModes,
                },
              },
            };
          }
        }
        if (notificationsDemo && rpc.method === 'notifications.set_bridge_mode') {
          if (failNotificationsMutation) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Browser notification setting unavailable.',
            };
          } else {
            const args = rpc.args as {
              bridge_id?: unknown;
              patch?: { notification?: unknown; approval?: unknown };
            };
            if (args.bridge_id === 'bridge-main') {
              pairedBridgeModes = {
                notification: typeof args.patch?.notification === 'boolean'
                  ? args.patch.notification
                  : pairedBridgeModes.notification,
                approval: typeof args.patch?.approval === 'boolean'
                  ? args.patch.approval
                  : pairedBridgeModes.approval,
              };
            }
            result = {
              ok: true,
              settings: {
                ui: true,
                bridge: bridgeNotificationsEnabled,
                slack: { notification: false, approval: false, messenger: false },
                telegram: { notification: false, approval: false, messenger: false },
                whatsapp: { notification: false, approval: false, messenger: false },
                discord: { notification: false, approval: false, messenger: false },
                email: { notification: false, approval: false, messenger: false },
                verification_phrase: notificationVerificationPhrase,
                bridges: { 'bridge-main': pairedBridgeModes },
              },
            };
          }
        }
        if (
          notificationsDemo
          && rpc.method === 'notifications.set_verification_phrase'
        ) {
          if (failNotificationsMutation) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Verification phrase unavailable.',
            };
          } else {
            const phrase = (rpc.args as { phrase?: unknown }).phrase;
            notificationVerificationPhrase = typeof phrase === 'string' ? phrase : '';
            result = {
              ok: true,
              settings: {
                ui: true,
                bridge: bridgeNotificationsEnabled,
                slack: { notification: false, approval: false, messenger: false },
                telegram: { notification: false, approval: false, messenger: false },
                whatsapp: { notification: false, approval: false, messenger: false },
                discord: { notification: false, approval: false, messenger: false },
                email: { notification: false, approval: false, messenger: false },
                verification_phrase: notificationVerificationPhrase,
                bridges: {
                  'bridge-main': pairedBridgeModes,
                },
              },
            };
          }
        }
        if (devicesDemo && rpc.method === 'pair.list') {
          if (devicesListFailuresRemaining > 0) {
            devicesListFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: 'Paired devices unavailable.',
            };
          } else {
            result = {
              devices: [
                {
                  instance_id: 'device-current',
                  display_name: 'This browser',
                  kind: 'webclient',
                  added_at: Math.floor((FIXED_NOW - 86_400_000) / 1_000),
                  revoked_at: null,
                  connected: true,
                  connected_at: Math.floor(FIXED_NOW / 1_000),
                },
                {
                  instance_id: 'device-laptop',
                  display_name: 'Travel laptop',
                  kind: 'webclient',
                  added_at: Math.floor((FIXED_NOW - 172_800_000) / 1_000),
                  revoked_at: revokedDeviceIds.has('device-laptop')
                    ? Math.floor(FIXED_NOW / 1_000)
                    : null,
                  connected: false,
                },
                {
                  instance_id: 'device-desktop',
                  display_name: 'Office desktop',
                  kind: 'bridge',
                  added_at: Math.floor((FIXED_NOW - 259_200_000) / 1_000),
                  revoked_at: revokedDeviceIds.has('device-desktop')
                    ? Math.floor(FIXED_NOW / 1_000)
                    : null,
                  connected: false,
                },
              ],
            };
          }
        }
        if (devicesDemo && rpc.method === 'pair.revoke') {
          const instanceId = (rpc.args as { instance_id?: unknown }).instance_id;
          if (failDeviceRevoke) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Device revoke unavailable.',
            };
          } else {
            if (typeof instanceId === 'string') revokedDeviceIds.add(instanceId);
            result = { ok: true };
          }
        }
        if (accountDemo && rpc.method === 'account.bindingStatus') {
          if (accountBindingReadFailuresRemaining > 0) {
            accountBindingReadFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: 'Account binding status unavailable.',
            };
          } else {
            const boundAccount = accountOwner === 'old'
              ? { id: 'acct-old', handle: 'legacy' }
              : { id: 'acct-main', handle: 'morgan' };
            result = accountOwner !== null
              ? {
                  status: 'bound',
                  binding: {
                    account_id: boundAccount.id,
                    publisher_handle: boundAccount.handle,
                    server_fingerprint: HARNESS_SERVER_FINGERPRINT,
                    bound_at: FIXED_NOW,
                  },
                }
              : { status: 'unbound', binding: null };
          }
        }
        if (accountDemo && rpc.method === 'pro_convenience.status') {
          if (accountProReadFailuresRemaining > 0) {
            accountProReadFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: 'Account plan status unavailable.',
            };
          } else {
            const boundAccount = accountOwner === 'old'
              ? { id: 'acct-old', handle: 'legacy' }
              : { id: 'acct-main', handle: 'morgan' };
            result = accountOwner !== null
              ? {
                  entitlement: 'not_entitled',
                  account_id: boundAccount.id,
                  publisher_handle: boundAccount.handle,
                  items: {
                    handle: { state: 'active' },
                    ddns: { state: 'inactive-free', detail: 'free_account' },
                    acme: { state: 'inactive-free', detail: 'free_account' },
                  },
                }
              : {
                  entitlement: 'unbound',
                  items: {
                    handle: { state: 'awaiting-server', detail: 'no_binding' },
                    ddns: { state: 'awaiting-server', detail: 'no_binding' },
                    acme: { state: 'awaiting-server', detail: 'no_binding' },
                  },
                };
          }
        }
        if (accountDemo && rpc.method === 'account.bind') {
          const confirmRebind = (
            rpc.args as { confirm_rebind?: unknown }
          ).confirm_rebind === true;
          if (
            (confirmRebind && failAccountRebind)
            || (!confirmRebind && failAccountBind)
          ) {
            error = {
              code: 'UNAVAILABLE',
              message: confirmRebind
                ? 'Account rebind unavailable.'
                : 'Account binding unavailable.',
            };
          } else if (
            accountConflictDemo
            && !confirmRebind
          ) {
            result = {
              outcome: 'conflict',
              current_owner: {
                account_id: 'acct-old',
                publisher_handle: 'legacy',
                server_fingerprint: HARNESS_SERVER_FINGERPRINT,
                bound_at: FIXED_NOW - 86_400_000,
              },
              incoming: {
                account_id: 'acct-main',
                publisher_handle: 'morgan',
              },
            };
          } else {
            const previousAccountId = accountOwner === 'old'
              ? 'acct-old'
              : undefined;
            accountOwner = 'incoming';
            result = {
              outcome: previousAccountId === undefined ? 'bound' : 'rebound',
              binding: {
                account_id: 'acct-main',
                publisher_handle: 'morgan',
                server_fingerprint: HARNESS_SERVER_FINGERPRINT,
                bound_at: FIXED_NOW,
              },
              ...(previousAccountId !== undefined
                ? { previous_account_id: previousAccountId }
                : {}),
            };
          }
        }
        if (accountDemo && rpc.method === 'account.unbind') {
          if (failAccountUnbind) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Account disconnect unavailable.',
            };
          } else {
            accountOwner = null;
            result = { outcome: 'unbound' };
          }
        }
        if (
          (workEntitiesPagedDemo || workEntitySourcesDemo)
          && rpc.method === 'work_entity.source.list'
        ) {
          result = {
            sources: workEntitySourcesDemo
              ? [{
                  id: 'recued.task',
                  top_tier_kind: 'task',
                  source_kind: 'builtin',
                  source_label: workEntityDemoSourceLabel,
                  write_capable: true,
                  mcp_exposed: false,
                  enabled: true,
                  registered_at: FIXED_NOW,
                }, {
                  id: 'connection.hubspot.conn-42.task',
                  top_tier_kind: 'task',
                  source_kind: 'connection',
                  source_label: 'HubSpot Tasks',
                  write_capable: true,
                  mcp_exposed: true,
                  enabled: true,
                  registered_at: FIXED_NOW + 1,
                }, {
                  id: 'recued.note',
                  top_tier_kind: 'note',
                  source_kind: 'builtin',
                  source_label: 'Recued built-in',
                  write_capable: true,
                  mcp_exposed: false,
                  enabled: true,
                  registered_at: FIXED_NOW + 2,
                }]
              : [{
                  id: 'recued.task',
                  top_tier_kind: 'task',
                  source_kind: 'builtin',
                  source_label: workEntityDemoSourceLabel,
                  write_capable: true,
                  mcp_exposed: false,
                  enabled: true,
                  registered_at: FIXED_NOW,
                }],
            defaults_by_kind: workEntitySourcesDemo
              ? { task: 'recued.task', note: 'recued.note' }
              : { task: 'recued.task' },
          };
        }
        if (workEntitiesPagedDemo && rpc.method === 'work_entity.list') {
          const args = rpc.args as WorkEntityListRpcRequest;
          const offset = typeof args.offset === 'number' ? args.offset : 0;
          let records = Array.from({ length: taskFiltersDemo ? 5 : 3 }, (_, index) => workEntityDemoRecord(index));
          if (args.kind === 'task') {
            if (args.search) {
              const search = args.search.trim().toLowerCase();
              records = records.filter((row) => row.title.toLowerCase().includes(search)
                || row.body?.toLowerCase().includes(search));
            }
            const filter = args.task_filter;
            if (filter !== undefined) {
              const due = filter.due;
              records = records.filter((row) =>
                (filter.completion === 'all' || row.done === (filter.completion === 'completed'))
                && (due.kind === 'all' || (row.due_at !== undefined && (due.kind === 'overdue'
                  ? !row.done && row.due_at < due.before
                  : row.due_at >= due.from && row.due_at < due.before))));
              if (taskFiltersDemo) records.sort((a, b) =>
                (filter.sort === 'default' ? Number(a.done) - Number(b.done) : 0)
                || (a.due_at ?? Infinity) - (b.due_at ?? Infinity) || a.id.localeCompare(b.id));
            }
          }
          result = {
            entities: records.slice(offset, offset + 1),
            total: records.length,
          };
        }
        if (workEntitiesPagedDemo && rpc.method === 'work_entity.get') {
          const id = (rpc.args as { id?: unknown }).id;
          const match = typeof id === 'string' ? /^task-(\d+)$/.exec(id) : null;
          result = {
            entity: match === null
              ? null
              : workEntityDemoRecord(Number.parseInt(match[1]!, 10)),
          };
        }
        if (workEntitiesPagedDemo && rpc.method === 'work_entity.upsert') {
          const args = rpc.args as { id?: unknown; title?: unknown };
          const match = typeof args.id === 'string'
            ? /^task-(\d+)$/.exec(args.id)
            : null;
          if (match !== null && typeof args.title === 'string') {
            const index = Number.parseInt(match[1]!, 10);
            workEntityDemoTitles.set(index, args.title);
            result = { entity: workEntityDemoRecord(index) };
          }
        }
        if (formResponsesPagedDemo && rpc.method === 'form_response.list') {
          if (receptionResponsesFailuresRemaining > 0) {
            receptionResponsesFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: 'Reception responses unavailable.',
            };
          } else {
            const args = rpc.args as {
              before?: { submission_id?: unknown };
            };
            const previousId = args.before?.submission_id;
            const index = previousId === 'submission-0'
              ? 1
              : previousId === 'submission-1'
                ? 2
                : 0;
            const row = formResponseDemoRecord(index);
            result = {
              responses: [row],
              ...(index < 2
                ? {
                    next_cursor: {
                      accepted_at: row.accepted_at,
                      submission_id: row.submission_id,
                    },
                  }
                : {}),
            };
          }
        }
        if (rpc.method === 'reception.record.list') {
          if (receptionRecordsFailuresRemaining > 0) {
            receptionRecordsFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: 'Reception records unavailable.',
            };
          } else {
            result = { records: [], truncated: false };
          }
        }
        if (formResponsesPagedDemo && rpc.method === 'form_response.get') {
          if (receptionResponseDetailFailuresRemaining > 0) {
            receptionResponseDetailFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: 'Reception response detail unavailable.',
            };
          } else {
            const submissionId = (
              rpc.args as { submission_id?: unknown }
            ).submission_id;
            const match = typeof submissionId === 'string'
              ? /^submission-(\d+)$/.exec(submissionId)
              : null;
            result = {
              response: match === null
                ? null
                : formResponseDemoDetail(Number.parseInt(match[1]!, 10)),
            };
          }
        }
        if (formResponsesPagedDemo && rpc.method === 'form_response.update') {
          const args = rpc.args as {
            submission_id?: unknown;
            values?: unknown;
            visitor?: unknown;
          };
          const match = typeof args.submission_id === 'string'
            ? /^submission-(\d+)$/.exec(args.submission_id)
            : null;
          if (match === null) {
            result = { response: null };
          } else {
            const index = Number.parseInt(match[1]!, 10);
            const current = formResponseDemoDetail(index);
            formResponseDemoEdits.set(index, {
              values: args.values !== null
                  && typeof args.values === 'object'
                  && !Array.isArray(args.values)
                ? args.values as Record<string, unknown>
                : current.values,
              visitor: args.visitor !== null
                  && typeof args.visitor === 'object'
                  && !Array.isArray(args.visitor)
                ? args.visitor as Record<string, unknown>
                : current.visitor,
              lifecycle_state: current.lifecycle_state,
              state_changed_at: current.state_changed_at,
              updated_at: FIXED_NOW + 1_000,
            });
            result = { response: formResponseDemoDetail(index) };
          }
        }
        if (formResponsesPagedDemo && rpc.method === 'form_response.set_state') {
          const args = rpc.args as {
            submission_id?: unknown;
            lifecycle_state?: unknown;
          };
          const match = typeof args.submission_id === 'string'
            ? /^submission-(\d+)$/.exec(args.submission_id)
            : null;
          if (match === null) {
            result = { response: null };
          } else {
            const index = Number.parseInt(match[1]!, 10);
            const current = formResponseDemoDetail(index);
            formResponseDemoEdits.set(index, {
              values: current.values,
              visitor: current.visitor,
              lifecycle_state: typeof args.lifecycle_state === 'string'
                ? args.lifecycle_state
                : current.lifecycle_state,
              state_changed_at: FIXED_NOW + 1_001,
              updated_at: current.updated_at,
            });
            result = { response: formResponseDemoDetail(index) };
          }
        }
        if (formResponsesPagedDemo && rpc.method === 'form_response.export') {
          const format = (rpc.args as { format?: unknown }).format;
          const json = format === 'json';
          result = {
            filename: `form-responses.${json ? 'json' : 'csv'}`,
            mime_type: json ? 'application/json' : 'text/csv',
            content: json
              ? JSON.stringify([{ submission_id: 'submission-0' }])
              : '"submission_id"\r\n"submission-0"',
            record_count: 1,
          };
        }
        if (formResponsesPagedDemo && rpc.method === 'recipe.list') {
          result = { recipes: formResponseAutomationDemoRecipes };
        }
        if (formResponsesPagedDemo && rpc.method === 'execute') {
          result = demoRecipeExecuteResult(rpc.args, false);
        }
        if (memoryRowsDemo && rpc.method === 'memory.list') {
          if (
            memoryListFailuresRemaining > 0
            && (rpcCallCounts.get('memory.list') ?? 0) > 1
          ) {
            memoryListFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: memoryListFailureMessage,
            };
          } else {
            const requestedActors = (
              rpc.args as { origin_actors?: unknown }
            ).origin_actors;
            const includesActor = (actor: string): boolean =>
              !Array.isArray(requestedActors) || requestedActors.includes(actor);
            result = {
              entries: [
                ...(memoryOwnRowPresent && includesActor('user_self')
                  ? [{
                      memory_id: memoryDemoOwnId,
                      origin_actor: 'user_self',
                      kind: memoryDemoOwnKind,
                      summary: memoryDemoOwnSummary,
                      body_preview: memoryDemoOwnPreview,
                      size_bytes: memoryDemoOwnSize,
                      has_body: true,
                      ts: FIXED_NOW - 60_000,
                    }]
                  : []),
                ...(includesActor('system')
                  ? [{
                      memory_id: memoryDemoSystemId,
                      origin_actor: 'system',
                      kind: memoryDemoSystemKind,
                      summary: memoryDemoSystemSummary,
                      ts: FIXED_NOW - 120_000,
                      run_id: memoryDemoRunId,
                      ...(memorySystemRowRedacted ? { redacted: true } : {}),
                    }]
                  : []),
                ...(memoryProvenanceDemo && includesActor('contracted_user')
                  ? [{
                      memory_id: memoryDemoAgentId,
                      origin_actor: 'contracted_user' as const,
                      kind: 'instruction',
                      summary: 'Agent-authored operating note',
                      body_preview: 'Use the verified provider record.',
                      size_bytes: 33,
                      has_body: true,
                      ts: FIXED_NOW - 90_000,
                      attribution: memoryDemoAgentAttribution,
                    }]
                  : []),
              ],
            };
          }
        }
        if (memoryRowsDemo && rpc.method === 'memory.get') {
          const memoryId = (rpc.args as { memory_id?: unknown }).memory_id;
          if (memoryGetFailuresRemaining > 0) {
            memoryGetFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: memoryDemoGetError,
            };
          } else {
            result = memoryId === memoryDemoOwnId && memoryOwnRowPresent
              ? {
                  memory_id: memoryDemoOwnId,
                  origin_actor: 'user_self',
                  kind: memoryDemoOwnKind,
                  summary: memoryDemoOwnSummary,
                  body: memoryDemoOwnBody,
                  size_bytes: memoryDemoOwnSize,
                  ts: FIXED_NOW - 60_000,
                }
              : memoryId === memoryDemoSystemId
                ? {
                    memory_id: memoryDemoSystemId,
                    origin_actor: 'system',
                    kind: memoryDemoSystemKind,
                    summary: memoryDemoSystemSummary,
                    ts: FIXED_NOW - 120_000,
                    run_id: memoryDemoRunId,
                    ...(memorySystemRowRedacted ? { redacted: true } : {}),
                  }
                : memoryProvenanceDemo && memoryId === memoryDemoAgentId
                  ? {
                      memory_id: memoryDemoAgentId,
                      origin_actor: 'contracted_user' as const,
                      kind: 'instruction',
                      summary: 'Agent-authored operating note',
                      body: 'Use the verified provider record.',
                      size_bytes: 33,
                      ts: FIXED_NOW - 90_000,
                      attribution: memoryDemoAgentAttribution,
                    }
                : null;
          }
        }
        if (memoryRowsDemo && rpc.method === 'memory.delete') {
          const memoryId = (rpc.args as { memory_id?: unknown }).memory_id;
          if (memoryDeleteFailuresRemaining > 0) {
            memoryDeleteFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: memoryDemoDeleteError,
            };
          } else if (memoryId === memoryDemoOwnId) {
            memoryOwnRowPresent = false;
            result = {
              memory_id: memoryId,
              deleted: true,
              redacted: false,
            };
          } else {
            memorySystemRowRedacted = true;
            result = {
              memory_id: memoryId,
              deleted: false,
              redacted: true,
            };
          }
        }
        if (recordsDemo && rpc.method === 'records.namespace.list') {
          result = {
            namespaces: recordsDemoPurged
              ? []
              : [
                  recordsDemoNamespace(),
                  ...(recordsNavigationDemo
                    ? [recordsDemoNamespace('publisher-b')]
                    : []),
                ],
            global_quota: {
              row_count: recordsDemoDeleted || recordsDemoPurged ? 0 : 1,
              payload_bytes: recordsDemoDeleted || recordsDemoPurged ? 0 : 42,
              outbox_count: recordsDemoPurged || recordsDemoEventRetired ? 0 : 1,
              reserved_payload_bytes: 0,
              row_limit: 10_000,
              byte_limit: 1_000_000,
              outbox_limit: 1_000,
            },
          };
        }
        if (recordsDemo && rpc.method === 'records.kind.list') {
          result = {
            kinds: [
              {
                kind: recordsDemoKind,
                rows: recordsDemoDeleted ? 0 : 1,
                payload_bytes: recordsDemoDeleted ? 0 : 42,
              },
              ...(recordsNavigationDemo
                ? [{ kind: 'invoice', rows: 1, payload_bytes: 24 }]
                : []),
            ],
          };
        }
        if (recordsDemo && rpc.method === 'records.search') {
          const args = rpc.args as {
            owner?: { publisher?: unknown };
            entity?: unknown;
          };
          result = {
            records: args.entity === 'invoice'
              ? [recordsNavigationInvoice]
              : args.owner?.publisher === 'publisher-b'
                ? [recordsNavigationJob]
                : recordsDemoDeleted ? [] : [recordsDemoRecord],
          };
          if (searchParams.get('records_browse') === '1') {
            result = recordsBrowseReply(rpc.args as Parameters<typeof recordsBrowseReply>[0]);
          }
        }
        if (recordsDemo && rpc.method === 'records.get') {
          const args = rpc.args as { id?: unknown };
          const found = args.id === recordsNavigationInvoice.id
            ? recordsNavigationInvoice
            : args.id === recordsNavigationJob.id
              ? recordsNavigationJob
              : args.id === recordsDemoRecord.id && !recordsDemoDeleted
                ? recordsDemoRecord
                : null;
          result = found === null
            ? { record: null, diagnostics: null }
            : { record: found, diagnostics: recordsDemoDiagnostics };
        }
        if (recordsDemo && rpc.method === 'records.retention.list') {
          result = { policies: { [recordsDemoKind]: { mode: 'keep' } } };
        }
        if (recordsDemo && rpc.method === 'records.outbox.list') {
          result = {
            pending: recordsDemoEventRetired ? 0 : 1,
            delivered: 0,
            dead_letter: recordsDemoEventRetired ? 1 : 0,
            total_retries: 2,
            ...(recordsDemoEventRetired
              ? {}
              : {
                  oldest_pending_at: FIXED_NOW - 60_000,
                  oldest_pending_age_ms: 60_000,
                }),
            events: [{
              event: {
                event_id: 'event-job-1',
                type: recordsDemoEventType,
                owner: {
                  publisher: recordsDemoPublisher,
                  pack_slug: recordsDemoPackSlug,
                },
                entity: recordsDemoKind,
                id: recordsDemoRecordId,
                revision: 1,
                changed_fields: [recordsDemoTitleField],
                activation_generation: 2,
                subscriber_digest: 'subscriber',
                cause: 'recipe',
                created_at: FIXED_NOW - 60_000,
              },
              status: recordsDemoEventRetired ? 'dead_letter' : 'pending',
              retry_count: 2,
              ...(recordsDemoEventRetired
                ? { error: 'Retired by the owner.' }
                : recordsDemoDeliveryError
                  ? { error: recordsDemoDeliveryError }
                  : {}),
              deliveries: longRecordsTextDemo
                ? [{
                    binding_digest: 'binding-long-records-demo',
                    recipe_id: recordsDemoDeliveryRecipe,
                    status: 'pending',
                    retry_count: 2,
                    error: recordsDemoDeliveryError,
                  }]
                : [],
            }],
          };
        }
        if (recordsDemo && rpc.method === 'records.outbox.retire') {
          recordsDemoEventRetired = true;
          result = { retired: true };
        }
        if (recordsDemo && rpc.method === 'records.purge') {
          recordsDemoPurged = true;
          result = { rows_deleted: 1, events_deleted: 1 };
        }
        if (recordsDemo && rpc.method === 'records.delete') {
          recordsDemoDeleted = true;
          result = { deleted: true, id: recordsDemoRecord.id, revision: 1 };
        }
        if (recordsDemo && rpc.method === 'records.export') {
          const args = rpc.args as { entity?: unknown; format?: unknown };
          const common = {
            owner: {
              publisher: recordsDemoPublisher,
              pack_slug: recordsDemoPackSlug,
            },
            version: 3,
            activation_generation: 2,
            data_generation: recordsDemoDeleted ? 2 : 1,
            storage_schema_hash: 'a'.repeat(64),
            declaration_hash: 'b'.repeat(64),
            schema: recordsDemoSchema,
            exported_at: FIXED_NOW,
            digest: 'c'.repeat(64),
          };
          result = args.format === 'csv'
            ? {
                format: 'recued.records.csv.v1',
                ...common,
                csv: `entity,id,${recordsDemoTitleField}\r\n`
                  + `${recordsDemoKind},${recordsDemoRecordId},${recordsDemoTitle}`,
              }
            : {
                format: 'recued.records.v1',
                ...common,
                records: {
                  [recordsDemoKind]: recordsDemoDeleted
                    ? []
                    : [recordsDemoRecord],
                },
              };
        }
        if (liveControlDemo && rpc.method === 'execution.active') {
          if (failLogsControlFollowup && liveControlRetiredRunIds.size > 0) {
            failLogsControlFollowup = false;
            error = {
              code: 'UNAVAILABLE',
              message: 'Active runs could not be refreshed.',
            };
          } else {
            result = {
              entries: [
              {
                entry_kind: 'run',
                run_id: 'run-live-control-1',
                recipe_id: longLogsTextDemo
                  ? `recipe-${'R'.repeat(240)}`
                  : 'daily-brief',
                step_id: longLogsTextDemo
                  ? `step-${'S'.repeat(240)}`
                  : 'summarize',
                lane: longLogsTextDemo
                  ? `lane-${'L'.repeat(240)}`
                  : 'local-heavy',
                state: 'running',
                origin: longLogsTextDemo
                  ? `origin-${'G'.repeat(240)}`
                  : 'attended',
                source: {
                  channel: 'user',
                  actor: 'user_self',
                  user_id: 'owner_1',
                  client_token_id: 'tok_1',
                },
                started_at: FIXED_NOW - 60_000,
                slot_acquired_at: FIXED_NOW - 60_000,
                progress: { contract: 'silent', stalled: false },
                kill: { mechanism: 'sigkill', pid: 4242 },
              },
              {
                entry_kind: 'run',
                run_id: 'run-live-control-2',
                recipe_id: 'weekly-review',
                step_id: 'collect',
                lane: 'local-heavy',
                state: 'running',
                origin: 'attended',
                source: {
                  channel: 'user',
                  actor: 'user_self',
                  user_id: 'owner_1',
                  client_token_id: 'tok_1',
                },
                started_at: FIXED_NOW - 30_000,
                slot_acquired_at: FIXED_NOW - 30_000,
                progress: { contract: 'silent', stalled: false },
                kill: { mechanism: 'sigkill', pid: 4243 },
              },
              ].filter(
                (entry) => liveControlDemo !== 'interrupted' && !liveControlRetiredRunIds.has(entry.run_id),
              ),
              lanes: [],
              ...(liveControlDemo === 'interrupted' ? { tool_calls: durableToolReviewed ? [] : [{
                message_id: 'tool-recovered', session_id: 'chat_1', turn_id: 'turn-recovered',
                tool_name: 'recued/research', run_id: 'run-recovered', state: 'interrupted',
                started_at: FIXED_NOW - 300_000, updated_at: FIXED_NOW - 240_000,
                last_signal_at: FIXED_NOW - 240_000,
              }] } : {}),
            };
          }
        }
        if (liveControlDemo && rpc.method === 'execution.kill') {
          const runId = (rpc.args as { run_id?: unknown }).run_id;
          if (typeof runId === 'string') liveControlRetiredRunIds.add(runId);
          result = { status: 'killed' };
        }
        if (liveControlDemo === 'interrupted' && rpc.method === 'execution.tool_call.dismiss') {
          const args = rpc.args as { session_id: string; message_id: string };
          durableToolReviewed = args.session_id === 'chat_1' && args.message_id === 'tool-recovered';
          result = { dismissed: durableToolReviewed };
        }
        if (
          (runPaletteDemo || recipesRouteDemo || automationRulesDemo)
          && rpc.method === 'recipe.list'
        ) {
          const demoRecipe = {
            recipe_id: runPaletteRecipeId,
            publisher_id: 'recued-core',
            version: 1,
            recipe_hash: `hash-${runPaletteRecipeId}`,
            recipe: {
              recipe_id: runPaletteRecipeId,
              version: 1,
              ttl: 0,
              metadata: {
                name: runPaletteRecipeName,
                description: 'Watch the delivery pipeline.',
                author: 'recued-core',
                supported_platforms: [],
                tags: [],
                ...(recipesRelatedAutoRunDemo
                  ? { recipe_bundle: 'recued-core/pipeline-response' }
                  : {}),
              },
              variables: recipeEditableGridDemo
                ? {
                    payments: {
                      label: 'Payments',
                      type: 'array',
                      default: [],
                    },
                  }
                : recipePagedFilterDemo
                  ? {
                      status: {
                        label: 'Status',
                        type: 'text',
                        default: 'open',
                      },
                      cursor: '',
                    }
                : automationRulesDemo
                  ? {
                    topic: {
                      label: 'Topic',
                      type: 'text',
                      default: '',
                    },
                  }
                : recipesDefaultRunDemo
                  ? { limit: 25 }
                  : {},
              prefetch_steps: [],
              steps: [],
              output: { sidebar: [] },
              requires: [],
              ...(runPaletteDemo || recipesRelatedAutoRunDemo
                ? { auto_run: { interval_ms: 60_000 } }
                : {}),
            },
            source: 'pair-sync',
            installed_at: FIXED_NOW,
          };
          result = {
            recipes: recipesPagedDemo
              ? Array.from({ length: 50 }, (_, index) => {
                  const sequence = String(index + 1).padStart(2, '0');
                  const recipeId = `paged-recipe-${sequence}`;
                  return {
                    ...demoRecipe,
                    recipe_id: recipeId,
                    recipe_hash: `hash-${recipeId}`,
                    recipe: {
                      ...demoRecipe.recipe,
                      recipe_id: recipeId,
                      metadata: {
                        ...demoRecipe.recipe.metadata,
                        name: `Paged recipe ${sequence}`,
                        description: index === 0
                          ? 'Watch the delivery pipeline.'
                          : `Deterministic recipe ${sequence}.`,
                      },
                    },
                  };
                })
              : recipesRelatedAutoRunDemo
                ? [
                    demoRecipe,
                    {
                      ...demoRecipe,
                      recipe_id: 'close-action',
                      recipe_hash: 'hash-close-action',
                      recipe: {
                        ...demoRecipe.recipe,
                        recipe_id: 'close-action',
                        metadata: {
                          ...demoRecipe.recipe.metadata,
                          name: 'Close action',
                          description: 'Close a completed pipeline item.',
                        },
                      },
                    },
                  ]
                : runPaletteDemo
                  ? [
                      demoRecipe,
                      {
                        ...demoRecipe,
                        recipe_id: 'managed-live-1',
                        recipe_hash: 'hash-managed-live-1',
                        recipe: {
                          recipe_id: 'managed-live-1',
                          version: 1,
                          ttl: 0,
                          metadata: {
                            name: 'Review failed runs',
                            description: 'Review failures in Automation.',
                            author: 'recued-core',
                            supported_platforms: [],
                            tags: [],
                          },
                          variables: {},
                          prefetch_steps: [],
                          steps: [],
                          output: { sidebar: [] },
                          requires: [],
                          event_triggers: [{ event: 'execution.failed' }],
                        },
                      },
                    ]
                : [demoRecipe],
          };
        }
        if (
          runPaletteDemo
          && rpc.method === 'recipe.list'
          && runPaletteRecipeListFailuresRemaining > 0
        ) {
          runPaletteRecipeListFailuresRemaining -= 1;
          result = undefined;
          error = {
            code: 'UNAVAILABLE',
            message: 'Recipe inventory is temporarily unavailable.',
          };
        }
        if (
          automationRulesDemo
          && automationRecipeEntriesRecoveryDemo
          && rpc.method === 'recipe.list'
          // Automation resolves display names first, then lazily loads the
          // full recipe bodies used by Add and Dishes Config.
          && (rpcCallCounts.get('recipe.list') ?? 0) === 2
        ) {
          result = undefined;
          error = {
            code: 'UNAVAILABLE',
            message: 'Installed recipes are temporarily unavailable.',
          };
        }
        if (recipesDemo && rpc.method === 'execute') {
          result = demoRecipeExecuteResult(
            rpc.args,
            recipeEditableGridDemo,
            recipePagedFilterDemo,
            recipeCopyableResultDemo,
            recipeJsonResultDemo,
            recipeRecordFieldsResultDemo,
            recipeAiAnalysisResultDemo,
            recipeLinkButtonsResultDemo,
            recipeFileArtifactResultDemo,
          );
        }
        if (recipesDemo && rpc.method === 'recipe_config.get') {
          if (failRecipeConfigRead) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Recipe config is temporarily unavailable.',
            };
          } else {
            result = { config_overlay: {} };
          }
        }
        if (recipesDemo && rpc.method === 'recipe_config.set') {
          if (recipeConfigSetFailuresRemaining > 0) {
            recipeConfigSetFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: 'Recipe config update is temporarily unavailable.',
            };
          } else {
            result = {
              config_overlay: (rpc.args as { config_overlay?: unknown }).config_overlay ?? {},
            };
          }
        }
        if (recipesRouteDemo && rpc.method === 'recipe.runnability') {
          result = { recipes: [] };
        }
        if (recipesRouteDemo && rpc.method === 'recipe.pii') {
          result = { recipes: [] };
        }
        if (recipesRouteDemo && rpc.method === 'chat.inbound_token.tool_catalog') {
          result = { catalog: [] };
        }
        if (recipesRouteDemo && rpc.method === 'collection.connection.list') {
          result = { connections: [] };
        }
        if (
          recipesRouteDemo
          && !webhooksDemo
          && rpc.method === 'webhook.ingress.list'
        ) {
          result = { ingresses: [], profiles: [] };
        }
        if (
          recipesRouteDemo
          && !webhooksDemo
          && rpc.method === 'recipe.webhook.status'
        ) {
          result = {
            webhook: {
              declared: false,
              configured: false,
              armed: false,
              bindings: [],
            },
          };
        }
        if (webhooksDemo && rpc.method === 'webhook.ingress.list') {
          result = {
            ingresses: [
              ...(!webhookDemoRetired ? [webhookDemoIngress] : []),
              ...(webhookCreatedIngress === null ? [] : [webhookCreatedIngress]),
            ],
            profiles: WEBHOOK_DEMO_PROFILES,
          };
        }
        if (webhooksDemo && rpc.method === 'webhook.ingress.create') {
          const args = rpc.args as { display_name?: unknown };
          webhookCreatedIngress = demoCreatedWebhookIngress(
            typeof args.display_name === 'string' ? args.display_name : 'Created webhook',
            false,
          );
          result = { ingress: webhookCreatedIngress };
        }
        if (webhooksDemo && rpc.method === 'webhook.ingress.credentials.write') {
          const args = rpc.args as { ingress_id?: unknown };
          const ingress = webhookIngressFor(args.ingress_id);
          if (ingress !== null) {
            const nextVersion = String(Math.max(
              0,
              ...ingress.active_credential_versions.map((version) =>
                Number(version.version)),
            ) + 1);
            const credentialVersion = {
              version: nextVersion,
              created_at: FIXED_NOW + 120_000,
              retired_at: null,
              last_verified_at: null,
            };
            const updated = {
              ...ingress,
              configured_fields: ['signature_header', 'signing_secret'],
              missing_required_fields: [],
              active_credential_versions: [
                credentialVersion,
                ...ingress.active_credential_versions,
              ],
              readiness: {
                ...ingress.readiness,
                credentials_complete: true,
                can_enable: ingress.readiness.registration_complete,
                blockers: ingress.readiness.blockers.filter((blocker) =>
                  blocker !== 'credentials_incomplete'),
              },
              updated_at: FIXED_NOW + 120_000,
            } satisfies WebhookIngressView;
            storeWebhookIngress(updated);
            result = {
              ingress: updated,
              credential_version: credentialVersion,
            };
          }
        }
        if (webhooksDemo && rpc.method === 'webhook.ingress.credentials.retire') {
          const args = rpc.args as {
            ingress_id?: unknown;
            credential_version?: unknown;
          };
          const ingress = webhookIngressFor(args.ingress_id);
          if (ingress !== null && typeof args.credential_version === 'string') {
            const updated = {
              ...ingress,
              active_credential_versions: ingress.active_credential_versions.filter(
                (version) => version.version !== args.credential_version,
              ),
              updated_at: FIXED_NOW + 150_000,
            } satisfies WebhookIngressView;
            storeWebhookIngress(updated);
            result = { ingress: updated };
          }
        }
        if (webhooksDemo && rpc.method === 'webhook.ingress.manual.confirm') {
          const args = rpc.args as { ingress_id?: unknown };
          const ingress = webhookIngressFor(args.ingress_id);
          if (ingress !== null) {
            const updated = {
              ...ingress,
              registration_state: 'registered',
              intake_state: ingress.intake_state === 'draft'
                ? 'ready'
                : ingress.intake_state,
              readiness: {
                ...ingress.readiness,
                registration_complete: true,
                registration_endpoint_matches: true,
                can_enable: ingress.readiness.credentials_complete,
                blockers: ingress.readiness.blockers.filter((blocker) =>
                  blocker !== 'registration_incomplete'
                  && blocker !== 'registration_endpoint_changed'),
              },
              updated_at: FIXED_NOW + 150_000,
            } satisfies WebhookIngressView;
            storeWebhookIngress(updated);
            result = { ingress: updated };
          }
        }
        if (webhooksDemo && rpc.method === 'webhook.ingress.enable') {
          const args = rpc.args as { ingress_id?: unknown };
          const ingress = webhookIngressFor(args.ingress_id);
          if (ingress !== null) {
            const updated = {
              ...ingress,
              intake_state: 'enabled',
              health: { ...ingress.health, status: 'healthy' },
              enabled_at: FIXED_NOW + 150_000,
              updated_at: FIXED_NOW + 150_000,
            } satisfies WebhookIngressView;
            storeWebhookIngress(updated);
            result = { ingress: updated };
          }
        }
        if (webhooksDemo && rpc.method === 'webhook.ingress.disable') {
          const args = rpc.args as { ingress_id?: unknown };
          const ingress = webhookIngressFor(args.ingress_id);
          if (ingress !== null) {
            const updated = {
              ...ingress,
              intake_state: 'disabled',
              health: { ...ingress.health, status: 'disabled' },
              enabled_at: null,
              updated_at: FIXED_NOW + 150_000,
            } satisfies WebhookIngressView;
            storeWebhookIngress(updated);
            result = { ingress: updated };
          }
        }
        if (webhooksDemo && rpc.method === 'webhook.ingress.retire') {
          const args = rpc.args as { ingress_id?: unknown };
          const ingress = webhookIngressFor(args.ingress_id);
          if (ingress !== null) {
            const retired = {
              ...ingress,
              registration_state: 'retired',
              intake_state: 'retired',
              enabled_at: null,
              updated_at: FIXED_NOW + 180_000,
            } satisfies WebhookIngressView;
            if (retired.ingress_id === WEBHOOK_DEMO_INGRESS_ID) {
              webhookDemoIngress = retired;
              webhookDemoRetired = true;
            } else {
              webhookCreatedIngress = null;
            }
            result = { ingress: retired };
          }
        }
        if (webhooksDemo && rpc.method === 'webhook.ingress.test.deliver') {
          const observedAt = FIXED_NOW + 120_000;
          const args = rpc.args as { ingress_id?: unknown };
          const ingress = webhookIngressFor(args.ingress_id);
          if (ingress !== null) {
            const updated = {
              ...ingress,
              health: {
                ...ingress.health,
                status: 'healthy',
                test_observed_at: observedAt,
                last_delivery_at: observedAt,
              },
              updated_at: observedAt,
            } satisfies WebhookIngressView;
            storeWebhookIngress(updated);
            result = {
              ingress: updated,
              delivery_id: WEBHOOK_DEMO_DELIVERIES[0].delivery_id,
              observed_at: observedAt,
            };
          }
        }
        if (webhooksDemo && rpc.method === 'webhook.delivery.list') {
          result = {
            deliveries: WEBHOOK_DEMO_DELIVERIES.map((fixture, index) => ({
              delivery_id: fixture.delivery_id,
              ingress_id: WEBHOOK_DEMO_INGRESS_ID,
              profile_id: WEBHOOK_DEMO_PROFILE_ID,
              environment: 'test',
              received_at: FIXED_NOW - ((index + 1) * 60_000),
              raw_body_sha256: String(index + 1).repeat(64),
              raw_body_retained: true,
              decoded_content_type: 'application/json',
              decoded_schema_id: 'generic.delivery.v1',
              transport_assurance: 'authenticated',
              minimum_source_truth_policy: 'provider_claimed',
              credential_version: '1',
              admission_method: 'hmac_sha256',
              freshness_checked: true,
              event_count: 1,
              metadata_expires_at: FIXED_NOW + 86_400_000,
            })),
            next_cursor: null,
          };
        }
        if (webhooksDemo && rpc.method === 'webhook.delivery.get') {
          const args = rpc.args as { delivery_id?: unknown };
          const fixture = WEBHOOK_DEMO_DELIVERIES.find((candidate) =>
            candidate.delivery_id === args.delivery_id)
            ?? WEBHOOK_DEMO_DELIVERIES[0];
          const index = WEBHOOK_DEMO_DELIVERIES.indexOf(fixture);
          result = {
            detail: {
              delivery: {
                delivery_id: fixture.delivery_id,
                ingress_id: WEBHOOK_DEMO_INGRESS_ID,
                profile_id: WEBHOOK_DEMO_PROFILE_ID,
                environment: 'test',
                received_at: FIXED_NOW - ((index + 1) * 60_000),
                raw_body_sha256: String(index + 1).repeat(64),
                raw_body_retained: true,
                decoded_content_type: 'application/json',
                decoded_schema_id: 'generic.delivery.v1',
                transport_assurance: 'authenticated',
                minimum_source_truth_policy: 'provider_claimed',
                credential_version: '1',
                admission_method: 'hmac_sha256',
                freshness_checked: true,
                event_count: 1,
                metadata_expires_at: FIXED_NOW + 86_400_000,
              },
              events: [{
                event_id: fixture.event_id,
                delivery_id: fixture.delivery_id,
                ingress_id: WEBHOOK_DEMO_INGRESS_ID,
                event_index: 0,
                provider_event_id: fixture.provider_event_id,
                provider_resource_id: fixture.provider_resource_id,
                provider_event_type: 'delivery',
                provider_occurred_at: FIXED_NOW - 90_000,
                selected_for_dispatch: true,
                dispatch_state: 'dispatched',
                metadata_expires_at: FIXED_NOW + 86_400_000,
                payload_retained: true,
                payload_expires_at: FIXED_NOW + 3_600_000,
              }],
            },
          };
        }
        if (webhooksDemo && rpc.method === 'webhook.delivery.event.get') {
          const args = rpc.args as { event_id?: unknown };
          const fixture = WEBHOOK_DEMO_DELIVERIES.find((candidate) =>
            candidate.event_id === args.event_id)
            ?? WEBHOOK_DEMO_DELIVERIES[0];
          result = {
            event: {
              event: {
                event_id: fixture.event_id,
                delivery_id: fixture.delivery_id,
                ingress_id: WEBHOOK_DEMO_INGRESS_ID,
                event_index: 0,
                provider_event_id: fixture.provider_event_id,
                provider_resource_id: fixture.provider_resource_id,
                provider_event_type: 'delivery',
                provider_occurred_at: FIXED_NOW - 90_000,
                selected_for_dispatch: true,
                dispatch_state: 'dispatched',
                metadata_expires_at: FIXED_NOW + 86_400_000,
                payload_retained: true,
                payload_expires_at: FIXED_NOW + 3_600_000,
              },
              payload_retained: true,
              payload: { id: fixture.provider_event_id, status: 'accepted' },
            },
          };
        }
        if (webhooksDemo && rpc.method === 'webhook.delivery.rejected.list') {
          result = {
            rejections: [{
              rejection_id: 'whr_browserdemo0123456789abcdef012345',
              ingress_id: WEBHOOK_DEMO_INGRESS_ID,
              profile_id: WEBHOOK_DEMO_PROFILE_ID,
              environment: 'test',
              reason_code: 'signature_invalid',
              http_status: 401,
              bucket_started_at: FIXED_NOW - 120_000,
              first_recorded_at: FIXED_NOW - 110_000,
              last_recorded_at: FIXED_NOW - 100_000,
              recorded_attempt_count: 2,
              metadata_prune_eligible_at: FIXED_NOW + 86_400_000,
            }],
            next_cursor: null,
          };
        }
        if (webhooksDemo && rpc.method === 'webhook.delivery.retention.prune') {
          result = {
            result: {
              payloads_deleted: 1,
              outbox_rows_deleted: 1,
              events_deleted: 1,
              deliveries_deleted: 1,
              rejected_summaries_deleted: 1,
            },
          };
        }
        if (recipeDependencyInstallDemo && rpc.method === 'recipe.installBySlug') {
          const slug = (rpc.args as { slug?: unknown }).slug;
          result = failRecipeDependencyInstall
            ? {
                result: {
                  ok: false,
                  failure: {
                    code: 'fetch_error',
                    message: 'Recipe install unavailable.',
                  },
                },
              }
            : {
                result: {
                  ok: true,
                  recipe_id: typeof slug === 'string' ? slug : 'mail-digest',
                  version: 1,
                },
              };
        }
        if (
          (connectionsGrantDemo || longConnectionTextDemo)
          && rpc.method === 'collection.connection.list'
        ) {
          result = {
            connections: [connectionGrantConnection()],
          };
        }
        if (
          connectionsGrantDemo
          && rpc.method === 'collection.connection.listOperationGroups'
        ) {
          result = connectionGrantView();
        }
        if (
          connectionsGrantDemo
          && rpc.method === 'collection.connection.grantOperationGroup'
        ) {
          const groupId = (rpc.args as { group_id?: unknown }).group_id;
          if (typeof groupId === 'string') connectionGrantedGroups.add(groupId);
          result = connectionGrantView();
        }
        if (
          connectionsGrantDemo
          && rpc.method === 'collection.connection.revokeOperationGroup'
        ) {
          const groupId = (rpc.args as { group_id?: unknown }).group_id;
          if (typeof groupId === 'string') connectionGrantedGroups.delete(groupId);
          result = connectionGrantView();
        }
        if (recipesRouteDemo && rpc.method === 'packs.list') {
          result = { packs: [] };
        }
        if (packsDemo && rpc.method === 'packs.resolveBySlug') {
          const requestedSlug = (rpc.args as { slug?: unknown }).slug;
          const slug = typeof requestedSlug === 'string'
            ? requestedSlug
            : 'marketplace-pack';
          if (
            searchParams.get('packs_resolve_response')
              === 'fail-once-slow-retry'
            && (rpcCallCounts.get('packs.resolveBySlug') ?? 0) === 1
          ) {
            error = {
              code: 'UNAVAILABLE',
              message: `Marketplace pack resolution is temporarily unavailable for pack-${'identity'.repeat(30)}.`,
            };
          } else {
            result = {
              manifest: {
                manifest_version: 1,
                slug,
                publisher: packDemoPublisher,
                name: packDemoName,
                description: packDemoDescription,
                version: 2,
                pack_kind: 'capability',
                service_kind: 'workflow',
                tags: [longPackTextDemo
                  ? `tag-${'identity'.repeat(30)}`
                  : 'marketplace'],
                requires: packDemoPermission === null
                  ? []
                  : [packDemoPermission],
                recipes: [{ slug: packDemoRecipeSlug, version: 1 }],
                contents: [{
                  type: 'recipe',
                  slug: packDemoRecipeSlug,
                  version: 1,
                }],
              },
              manifest_review_hash: 'a'.repeat(64),
            };
          }
        }
        if (
          packsDemo
          && failPacksDetailListOnce
          && rpc.method === 'packs.list'
          && (rpcCallCounts.get('packs.list') ?? 0) === 2
        ) {
          error = {
            code: 'UNAVAILABLE',
            message: 'Pack inventory is temporarily unavailable.',
          };
        }
        if (
          packsDemo
          && failPacksActionRelistOnce
          && rpc.method === 'packs.list'
          && (rpcCallCounts.get('packs.list') ?? 0) === 3
        ) {
          error = {
            code: 'UNAVAILABLE',
            message: 'Pack inventory is temporarily unavailable after uninstall.',
          };
        }
        if (packsDemo && rpc.method === 'packs.list' && error === undefined) {
          // ⚠ The DETAIL view needs more of this row than the list does. A row
          // carrying only `manifest.{pack_kind,service_kind,tags}` renders the
          // list fine and then dies on the detail with
          // "pack.recipe_refs is not iterable" — so the shape here mirrors the
          // one `pack-use-click.spec.ts` builds by hand, which is the known-good
          // fixture for a pack whose Use panel actually renders.
          result = {
            packs: [{
              slug: connectionDemoPackSlug,
              version: 1,
              installed: packsInstalled,
              installed_any_version: packsInstalled,
              pre_install: false,
              name: packDemoName,
              description: packDemoDescription,
              publisher: packDemoPublisher,
              recipe_count: packsMultiViewDemo ? 2 : 1,
              requires: packDemoPermission === null ? [] : [packDemoPermission],
              recipe_refs: [
                { slug: packDemoRecipeSlug, version: 1 },
                ...(packsMultiViewDemo
                  ? [{ slug: 'installed-mail-archive', version: 1 }]
                  : []),
              ],
              body_visibility_grant_keys: [],
              body_visibility_grant_count: 0,
              manifest: {
                manifest_version: 1,
                slug: connectionDemoPackSlug,
                publisher: packDemoPublisher,
                name: packDemoName,
                description: packDemoDescription,
                version: 1,
                pack_kind: 'capability',
                service_kind: 'workflow',
                tags: ['mail'],
                requires: packDemoPermission === null ? [] : [packDemoPermission],
                ...(packsInstallConnectionDemo === null
                  ? {}
                  : {
                      connection_requirements: [{
                        authority: 'login.microsoftonline.com',
                        api_base: 'https://graph.microsoft.com/v1.0',
                        vendor: 'onedrive',
                        auth: {
                          type: 'oauth2_refresh' as const,
                          authorize_url: 'https://login.microsoftonline.com/authorize',
                          token_endpoint: 'https://login.microsoftonline.com/token',
                        },
                      }],
                    }),
                recipes: [
                  { slug: packDemoRecipeSlug, version: 1 },
                  ...(packsMultiViewDemo
                    ? [{ slug: 'installed-mail-archive', version: 1 }]
                    : []),
                ],
                contents: [
                  { type: 'recipe', slug: packDemoRecipeSlug, version: 1 },
                  ...(packsMultiViewDemo
                    ? [{
                        type: 'recipe' as const,
                        slug: 'installed-mail-archive',
                        version: 1,
                      }]
                    : []),
                  ...(longConnectionTextDemo
                    ? [{
                        type: 'composition' as const,
                        composition: {
                          schema_version: 1,
                          slug: 'connection-long-catalog',
                          ingredients: [{
                            slug: 'hubspot-api',
                            kind: 'http' as const,
                            http: {
                              base: 'https://api.hubapi.com',
                              connection: 'hubspot',
                            },
                          }],
                          operations: [{
                            op: 'hubspot.deals.write',
                            ingredient: 'hubspot-api',
                            risk: 'write' as const,
                            approval: 'always' as const,
                            bind: {
                              method: 'POST',
                              path: '/crm/v3/objects/deals',
                            },
                            required_scopes: ['crm.objects.deals.write'],
                          }],
                        },
                      }]
                    : []),
                ],
              },
            }],
            installed_versions: packsInstalled
              ? [{ slug: connectionDemoPackSlug, version: 1 }]
              : [],
          };
        }
        if (packsDemo && rpc.method === 'packs.uninstall') {
          if (
            searchParams.get('packs_uninstall_response')
              === 'cleanup-required'
          ) {
            result = {
              result: {
                ok: false,
                removed: { recipes: [], body_grants: [] },
                failure: {
                  code: 'webhook_cleanup_required',
                  message: 'Provider cleanup has not completed.',
                },
              },
            };
          } else {
            packsInstalled = false;
            result = {
              result: {
                ok: true,
                removed: {
                  recipes: [
                    'installed-mail-digest',
                    ...(packsMultiViewDemo ? ['installed-mail-archive'] : []),
                  ],
                  body_grants: [],
                },
                ...(longPackTextDemo
                  ? {
                      would_disable: [{
                        recipe_id: `dependent-${'identity'.repeat(30)}`,
                        before: 'degraded',
                        after: 'blocked',
                      }],
                      would_degrade: [{
                        recipe_id: `optional-${'capability'.repeat(30)}`,
                        before: 'runnable',
                        after: 'degraded',
                      }],
                    }
                  : {}),
              },
            };
          }
        }
        // The pack's recipe, so the detail's Use panel has an operation to
        // render — and the sweep has a button to press. Without it the panel
        // renders an empty pack and the audit's headline surface stays
        // unpressable for a different reason than before.
        if (
          packsDemo
          && failPacksRecipeListOnce
          && rpc.method === 'recipe.list'
          && (rpcCallCounts.get('recipe.list') ?? 0) === 1
        ) {
          error = {
            code: 'UNAVAILABLE',
            message: 'Pack actions are temporarily unavailable.',
          };
        }
        if (packsDemo && rpc.method === 'recipe.list' && error === undefined) {
          const packViewRecipe = (
            recipeId: string,
            name: string,
            description: string,
          ) => ({
            recipe_id: recipeId,
            publisher_id: 'recued-core',
            version: 1,
            recipe_hash: `hash-${recipeId}`,
            pack_slug: 'installed-mail',
            recipe: {
              recipe_id: recipeId,
              version: 1,
              ttl: 0,
              metadata: { name, description },
              steps: recipeRecordFieldsResultDemo
                ? [{
                    id: 'job',
                    transform: 'coalesce',
                    values: ['{{meta.recipe_id}}'],
                  }]
                : [],
              variables: recipeEditableGridDemo
                ? {
                    payments: {
                      label: 'Payments',
                      type: 'array',
                      default: [],
                    },
                  }
                : recipePagedFilterDemo
                  ? {
                      status: {
                        label: 'Status',
                        type: 'text',
                        default: 'open',
                      },
                      cursor: '',
                    }
                  : {},
              output: recipeEditableGridDemo
                || recipePagedFilterDemo
                || recipeCopyableResultDemo
                || recipeJsonResultDemo
                || recipeRecordFieldsResultDemo
                || recipeAiAnalysisResultDemo
                || recipeLinkButtonsResultDemo
                || recipeFileArtifactResultDemo
                ? {
                    render: recipePagedFilterDemo
                      ? [{ type: 'table' }, { type: 'filter' }]
                      : recipeCopyableResultDemo
                        ? [{ type: 'copyable' }]
                        : recipeJsonResultDemo
                          ? [{ type: 'json' }]
                          : recipeRecordFieldsResultDemo
                            ? [{
                                type: 'record_fields',
                                source: 'step.job',
                                entity: 'job',
                              }]
                            : recipeAiAnalysisResultDemo
                              ? [{ type: 'ai_analysis' }]
                              : recipeLinkButtonsResultDemo
                                ? [{ type: 'link_button' }]
                                : recipeFileArtifactResultDemo
                                  ? [{ type: 'file_artifact' }]
                                  : [{ type: 'table' }],
                    sidebar: [],
                  }
                : { render: [], sidebar: [] },
              ...(packsReactiveRecipeDemo
                && recipeId === packDemoRecipeSlug
                ? { auto_run: { interval_ms: 60_000 } }
                : {}),
            },
          });
          result = {
            recipes: packsInstalled
              ? [
                  packViewRecipe(
                    'installed-mail-digest',
                    'Mail digest',
                    'Summarise the unread mail.',
                  ),
                  ...(packsMultiViewDemo
                    ? [packViewRecipe(
                        'installed-mail-archive',
                        'Mail archive',
                        'Review processed mail.',
                      )]
                    : []),
                ]
              : [],
          };
        }
        if (
          packsDemo
          && (
            recipeEditableGridDemo
            || recipePagedFilterDemo
            || recipeCopyableResultDemo
            || recipeJsonResultDemo
            || recipeRecordFieldsResultDemo
            || recipeAiAnalysisResultDemo
            || recipeLinkButtonsResultDemo
            || recipeFileArtifactResultDemo
          )
          && rpc.method === 'execute'
        ) {
          result = demoRecipeExecuteResult(
            rpc.args,
            recipeEditableGridDemo,
            recipePagedFilterDemo,
            recipeCopyableResultDemo,
            recipeJsonResultDemo,
            recipeRecordFieldsResultDemo,
            recipeAiAnalysisResultDemo,
            recipeLinkButtonsResultDemo,
            recipeFileArtifactResultDemo,
          );
        }
        // ⛔ The packs PANEL loads behind one `Promise.all` — `packs.list` plus
        // the supervision, cli-reachability, connection-readiness, owner-
        // operation and install-audience reads (`packs-panel.ts` `refreshRows`).
        // This transport leaves an unrecognised method PENDING FOREVER
        // (`if (result === undefined && error === undefined) return;`), so one
        // unanswered read in that gather pins `#packs/<slug>` at "Loading
        // packs…" — route chrome, no pack, no Use operations, nothing to press.
        // That is why the surface this whole audit was written for could not be
        // swept at all.
        //
        // Answering them EMPTY is the honest fake: the panel needs them to
        // settle, not to carry data, and an empty roster is a real state the
        // panel renders. Gated on `packsDemo` so no other surface's pending
        // state changes. Shapes are the contracts' own response interfaces —
        // `SupervisionListResponse`, `CliReachabilityListResponse`,
        // `CliReachabilityUniverseResponse`, the owner-operation caller types —
        // because a WRONG shape throws inside the panel, which is worse than
        // the hang it replaces.
        if (packsDemo) {
          if (rpc.method === 'packs.unrunnable') {
            result = { findings: [], exact_pack_identities: true } satisfies PacksUnrunnableResult;
          } else if (rpc.method === 'supervision.list') result = { daemons: [] };
          else if (rpc.method === 'cli.reachability.list') result = { rows: [] };
          else if (rpc.method === 'cli.reachability.universe') result = { tools: [] };
          else if (rpc.method === 'collection.operation.listOperations') {
            result = { ingredients: [] };
          } else if (rpc.method === 'collection.operation.listOwnerOverrides') {
            result = { overrides: [] };
          } else if (rpc.method === 'server.seller.getOverview') {
            // ⛔ An ERROR, not a fabricated object. `SellerOverview` requires
            // seven fields; answering `{ tiers: [] }` satisfied the one consumer
            // that made the panel load and then crashed the Seller page with
            // "Cannot read properties of undefined (reading 'length')" on the
            // next navigation. A half-invented shape is worse than an honest
            // failure — the caller that reads the field you did not invent has
            // no way to defend itself, whereas every consumer here already
            // handles a rejection (`Promise.allSettled` + a status guard).
            error = {
              code: 'UNAVAILABLE',
              message: 'No seller backend in the fake transport.',
            };
          } else if (rpc.method === 'collection.contract.listContracts') {
            result = { contracts: [] };
          } else if (rpc.method === 'collection.connection.list') {
            result = {
              connections: longConnectionTextDemo
                ? [connectionGrantConnection()]
                : packsInstallConnectionDemo === 'reuse'
                  ? [{
                      name: 'work-onedrive',
                      kind: 'api',
                      display_name: 'Work OneDrive',
                      base_url: 'https://graph.microsoft.com/v1.0',
                      auth_type: 'oauth2_refresh',
                      granted_scopes: ['Files.Read'],
                    }]
                  : [],
            };
          } else if (rpc.method === 'collection.contract.listCatalogOperations') {
            // `pack-access-controls` gathers these too, then fans out a
            // per-contract grant read — so BOTH must settle or the panel hangs
            // one level deeper than the first fix reached.
            result = { ingredients: [] };
          } else if (
            rpc.method === 'collection.contract.session_grant.list'
            || rpc.method === 'contract.grant.read'
          ) {
            // `contract.grant.read` only became visible once the catalog read
            // above resolved — the per-contract fan-out cannot be reached while
            // its gather is still pending. Each fix unmasks the next layer.
            result = { grants: [] };
          }
        }
        if (recipesRouteDemo && rpc.method === 'schedules.list') {
          result = {
            schedules: recipesDemo ? recipeRunModalSchedules : [],
          };
        }
        if (recipesDemo && rpc.method === 'schedules.create') {
          const args = rpc.args as {
            recipe_id?: unknown;
            publisher_id?: unknown;
            cron_expression?: unknown;
          };
          const schedule = {
            schedule_id: `schedule-run-modal-${recipeRunModalSchedules.length + 1}`,
            recipe_id: typeof args.recipe_id === 'string'
              ? args.recipe_id
              : 'autorun-live-1',
            publisher_id: typeof args.publisher_id === 'string'
              ? args.publisher_id
              : 'recued-core',
            cron_expression: typeof args.cron_expression === 'string'
              ? args.cron_expression
              : '0 9 * * *',
            enabled: true,
            created_at: FIXED_NOW,
            last_run_at: null,
            next_run_at: FIXED_NOW + 3_600_000,
            last_status: null,
            last_error: null,
          };
          recipeRunModalSchedules = [...recipeRunModalSchedules, schedule];
          result = { schedule };
        }
        if (recipesDemo && rpc.method === 'schedules.update') {
          const args = rpc.args as {
            schedule_id?: unknown;
            enabled?: unknown;
          };
          const scheduleId = typeof args.schedule_id === 'string'
            ? args.schedule_id
            : '';
          recipeRunModalSchedules = recipeRunModalSchedules.map((schedule) =>
            schedule.schedule_id === scheduleId
              ? {
                  ...schedule,
                  ...(typeof args.enabled === 'boolean'
                    ? { enabled: args.enabled }
                    : {}),
                }
              : schedule);
          result = {
            schedule: recipeRunModalSchedules.find(
              (schedule) => schedule.schedule_id === scheduleId,
            ),
          };
        }
        if (recipesDemo && rpc.method === 'schedules.delete') {
          const scheduleId = (
            rpc.args as { schedule_id?: unknown }
          ).schedule_id;
          if (typeof scheduleId === 'string') {
            recipeRunModalSchedules = recipeRunModalSchedules.filter(
              (schedule) => schedule.schedule_id !== scheduleId,
            );
          }
          result = { deleted: true };
        }
        if (recipesRouteDemo && rpc.method === 'triggers.list') {
          result = { triggers: [] };
        }
        if (recipesRouteDemo && rpc.method === 'dishes.list') {
          result = { dishes: [], last_runs: {} };
        }
        if (runPaletteDemo && rpc.method === 'auto_run.list') {
          result = {
            entries: [{
              recipe_id: runPaletteRecipeId,
              publisher_id: 'recued-core',
              recipe_name: 'Watch pipeline',
              interval_ms: 60_000,
              dynamic: false,
              enabled: runPaletteAutoRunEnabled,
              auto_disabled: false,
              consecutive_failures: 0,
              last_failure_at: null,
              last_failure_reason: null,
              next_run_at: null,
              last_started_at: null,
              last_finished_at: null,
              config_overlay: {},
              variables: {},
            }],
          };
        }
        if (recipesRelatedAutoRunDemo && rpc.method === 'auto_run.list') {
          result = {
            entries: [
              {
                recipe_id: runPaletteRecipeId,
                publisher_id: 'recued-core',
                recipe_name: runPaletteRecipeName,
                interval_ms: 60_000,
                dynamic: false,
                enabled: true,
                auto_disabled: false,
                consecutive_failures: 0,
                last_failure_at: null,
                last_failure_reason: null,
                next_run_at: null,
                last_started_at: null,
                last_finished_at: null,
                config_overlay: {},
                variables: {},
              },
              {
                recipe_id: 'close-action',
                publisher_id: 'recued-core',
                recipe_name: 'Close action',
                interval_ms: 60_000,
                dynamic: false,
                enabled: recipesRelatedAutoRunEnabled,
                auto_disabled: false,
                consecutive_failures: 0,
                last_failure_at: null,
                last_failure_reason: null,
                next_run_at: null,
                last_started_at: null,
                last_finished_at: null,
                config_overlay: {},
                variables: {},
              },
            ],
          };
        }
        if (runPaletteDemo && rpc.method === 'auto_run.update') {
          if (runPaletteUpdateFails) {
            result = undefined;
            error = {
              code: 'unavailable',
              message: 'Auto-run update is temporarily unavailable.',
            };
          } else {
            const enabled = (rpc.args as { enabled?: unknown }).enabled;
            if (typeof enabled === 'boolean') runPaletteAutoRunEnabled = enabled;
            result = { ok: true };
          }
        }
        if (recipesRelatedAutoRunDemo && rpc.method === 'auto_run.update') {
          const enabled = (rpc.args as { enabled?: unknown }).enabled;
          if (typeof enabled === 'boolean') recipesRelatedAutoRunEnabled = enabled;
          result = {
            entry: {
              recipe_id: 'close-action',
              publisher_id: 'recued-core',
              recipe_name: 'Close action',
              interval_ms: 60_000,
              dynamic: false,
              enabled: recipesRelatedAutoRunEnabled,
              auto_disabled: false,
              consecutive_failures: 0,
              last_failure_at: null,
              last_failure_reason: null,
              next_run_at: null,
              last_started_at: null,
              last_finished_at: null,
              config_overlay: {},
              variables: {},
            },
          };
        }
        if (
          liveControlDemo
          && rpc.method === 'collection.contract.session_grant.list'
        ) {
          result = {
            grants: logsPassesDemo
              ? logsPasses.filter(
                  (grant) => !revokedLogsPassIds.has(grant.contract_id),
                )
              : [],
          };
        }
        if (
          liveControlDemo
          && logsPassesDemo
          && rpc.method === 'collection.contract.session_grant.revoke'
        ) {
          const contractId = (
            rpc.args as { contract_id?: unknown }
          ).contract_id;
          const grant = logsPasses.find(
            (candidate) => candidate.contract_id === contractId,
          );
          if (grant !== undefined) revokedLogsPassIds.add(grant.contract_id);
          result = grant === undefined
            ? undefined
            : { ...grant, lifecycle_state: 'revoked' };
        }
        if (contactsDemo && rpc.method === 'contact.list') {
          const args = rpc.args as {
            name_contains?: unknown;
            offset?: unknown;
          };
          if (contactsPagedDemo) {
            const offset = typeof args.offset === 'number' ? args.offset : 0;
            result = {
              contacts: offset === 0
                ? [contactDemoRecord]
                : offset === 1
                  ? [secondContactDemoRecord]
                  : offset === 2
                    ? [thirdContactDemoRecord]
                    : [],
              total: 3,
              rollups: {},
            };
          } else {
            const query = args.name_contains;
            const matches = typeof query !== 'string'
              || query.trim().length === 0
              || `${contactDemoRecord.name} ${contactDemoRecord.email}`
                .toLowerCase()
                .includes(query.trim().toLowerCase());
            result = {
              contacts: matches ? [contactDemoRecord] : [],
              total: matches ? 1 : 0,
            };
          }
        }
        if (contactsDemo && rpc.method === 'contact.source.list') {
          result = {
            sources: contactPromoteDemo
              ? [{
                  source_id: 'hubspot.work.contact',
                  source_label: 'HubSpot (work)',
                  enabled: true,
                  last_success_at: FIXED_NOW,
                  degraded: false,
                  stale: false,
                  last_error_code: null,
                  last_error_message: null,
                  last_cycle: {
                    hydrated: 12,
                    unchanged: 0,
                    skipped: 2,
                    created: 0,
                    promoted: 0,
                    disconnected: 0,
                    failed_rows: 0,
                    unkeyable: 0,
                    ambiguous: 0,
                    conflicted: 0,
                    repointed: 0,
                    mirror_failed: 0,
                    linked: 12,
                    complete: true,
                  },
                }]
              : [],
          };
        }
        if (contactImportDemo && rpc.method === 'contact.import.file_preview') {
          result = {
            format: 'vcard',
            adds: 2,
            unchanged: 5,
            changes: [{
              email: 'bob@example.test',
              name: 'Bob Smith',
              line: 3,
              fields: [{
                field: 'company',
                from: 'Acme Inc.',
                to: 'Example Corp.',
              }],
            }],
            errors: [],
          };
        }
        if (contactImportDemo && rpc.method === 'contact.import.file_apply') {
          result = {
            added: 2,
            changed: 1,
            skipped: 0,
            failures: [],
          };
        }
        if (contactPromoteDemo && rpc.method === 'contact.import.candidates') {
          result = {
            candidates: [
              {
                target_id: 'hubspot:contact:work:hs_2',
                email: 'carol@acme.test',
                name: 'Carol Jones',
                company: 'Acme',
              },
              {
                target_id: 'hubspot:contact:work:hs_3',
                email: 'dave@acme.test',
                name: 'Dave Lee',
              },
            ],
            total: 2,
            mirrored: 10_000,
          };
        }
        if (contactPromoteDemo && rpc.method === 'contact.import.promote') {
          result = { created: 1, already_known: 0, failures: [] };
        }
        if (
          (contactScanDemo || contactMergeDemo)
          && rpc.method === 'contact.merge.list'
        ) {
          result = {
            candidates: contactMergeDemo && !contactMergeResolved
              ? [{
                  id: 'cand-alice',
                  pair_key: 'alice.a@example.test|alice.b@example.test',
                  email_a: 'alice.a@example.test',
                  email_b: 'alice.b@example.test',
                  matched_fields: ['name', 'company'],
                  detected_at: FIXED_NOW,
                  detected_by: 'housekeeping',
                  status: 'pending',
                }]
              : [],
          };
        }
        if (contactScanDemo && rpc.method === 'contact.merge.scan_now') {
          result = {
            mode: 'full',
            iterated: 42,
            surfaced_count: 1,
            yield_reason: 'no_work',
          };
        }
        if (contactMergeDemo && rpc.method === 'contact.merge.reject') {
          contactMergeResolved = true;
          result = { candidates: [], rejection_rows_written: 1 };
        }
        if (contactsDemo && rpc.method === 'contact.get') {
          const email = (rpc.args as { email?: unknown }).email;
          if (
            failContactEditResponse
            && (rpcCallCounts.get('contact.get') ?? 0) > 1
          ) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Contact editor unavailable.',
            };
          } else {
            result = {
              contact: email === contactDemoRecord.email
                ? contactDemoRecord
                : null,
            };
          }
        }
        if (contactMergeDemo && rpc.method === 'contact.get') {
          const email = (rpc.args as { email?: unknown }).email;
          result = {
            contact: typeof email === 'string'
              ? contactMergeRecords[email as keyof typeof contactMergeRecords] ?? null
              : null,
          };
        }
        if (contactsDemo && rpc.method === 'contact.contributions') {
          result = { contributions: [] };
        }
        if (contactsDemo && rpc.method === 'data.timeline') {
          result = {
            entries: referenceProvenanceDemo
              ? [{
                  ts: FIXED_NOW - 90_000,
                  source: 'memory',
                  kind: 'assertion',
                  payload: { summary: 'Verified provider record' },
                  origin_actor: 'contracted_user',
                  attribution: {
                    kind: 'agent',
                    origin_actor: 'contracted_user',
                    agent_id: 'browser-agent',
                    contract_id: 'browser-contract',
                    label: 'agent browser-agent, under contract browser-contract, asserted this',
                  },
                }]
              : [],
          };
        }
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
          if (chatSendFailuresRemaining > 0) {
            chatSendFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: 'The simulated Chat send was rejected.',
            };
          } else {
            result = { turn_id: 'turn_plan_continue_1' };
          }
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
          if (collectionListFailuresRemaining > 0) {
            collectionListFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: 'Mail records are temporarily unavailable.',
            };
          } else {
            result = {
              records:
                args.platform === 'mail' && args.slug === 'work'
                  ? [sourceAnswerMailRecord]
                  : [],
            };
          }
        }
        if (rpc.method === 'collection.get' && connectedSourceAnswerDemo) {
          const args = rpc.args as {
            platform?: unknown;
            slug?: unknown;
            record_id?: unknown;
          };
          if (collectionGetFailuresRemaining > 0) {
            collectionGetFailuresRemaining -= 1;
            error = {
              code: 'UNAVAILABLE',
              message: 'Mail record detail is temporarily unavailable.',
            };
          } else {
            result = {
              record:
                args.platform === 'mail'
                && args.slug === 'work'
                && args.record_id === sourceAnswerMailRecord.record_id
                  ? sourceAnswerMailRecord
                  : null,
            };
          }
        }
        if (rpc.method === 'collection.listInstances' && longCollectionTextDemo) {
          result = { instances: longCollectionInstances };
        }
        if (rpc.method === 'collection.list' && longCollectionTextDemo) {
          const args = rpc.args as { platform?: unknown; slug?: unknown };
          result = {
            records:
              args.platform === 'webhook'
              && args.slug === longCollectionInstances[0]!.slug
                ? [longCollectionRecord]
                : [],
          };
        }
        if (rpc.method === 'collection.get' && longCollectionTextDemo) {
          const args = rpc.args as {
            platform?: unknown;
            slug?: unknown;
            record_id?: unknown;
          };
          result = {
            record:
              args.platform === 'webhook'
              && args.slug === longCollectionInstances[0]!.slug
              && args.record_id === longCollectionRecord.record_id
                ? longCollectionRecord
                : null,
          };
        }
        if (fileDownloadDemo && rpc.method === 'collection.listInstances') {
          result = {
            instances: [{
              slug: 'inbox',
              platform: 'file',
              adapter_type: 'local',
              caps: {},
              auth_state: 'healthy',
              last_synced_at: FIXED_NOW,
            }],
          };
        }
        if (fileDownloadDemo && rpc.method === 'collection.list') {
          const args = rpc.args as { platform?: unknown; slug?: unknown };
          result = {
            records:
              args.platform === 'file' && args.slug === 'inbox'
                ? [fileDownloadRecord]
                : [],
          };
        }
        if (fileDownloadDemo && rpc.method === 'collection.get') {
          const args = rpc.args as {
            platform?: unknown;
            slug?: unknown;
            record_id?: unknown;
          };
          result = {
            record:
              args.platform === 'file'
              && args.slug === 'inbox'
              && args.record_id === fileDownloadRecord.record_id
                ? fileDownloadRecord
                : null,
          };
        }
        if (fileDownloadDemo && rpc.method === 'data.file.read') {
          const recordId = (rpc.args as { record_id?: unknown }).record_id;
          result = {
            record_id: recordId,
            bytes_b64: 'aGVsbG8=',
            mime_type: 'text/plain',
            filename: 'quarterly-plan.txt',
            size_bytes: 5,
          };
        }
        if (verificationJourneyDemo) {
          if (rpc.method === 'execution.list') {
            const args = rpc.args as { cursor?: unknown };
            result = pagedLogsDemo
              ? args.cursor === undefined
                ? {
                    runs: [verificationRun],
                    next_cursor: {
                      last_started_at: verificationRun.started_at,
                      last_run_id: verificationRun.run_id,
                    },
                  }
                : { runs: [olderVerificationRun] }
              : { runs: [verificationRun] };
          } else if (rpc.method === 'execution.get') {
            const args = rpc.args as { run_id?: unknown };
            if (logsDetailFailuresRemaining > 0) {
              logsDetailFailuresRemaining -= 1;
              error = {
                code: 'UNAVAILABLE',
                message: 'Run detail unavailable.',
              };
            } else {
              result = {
                run:
                  args.run_id === verificationRun.run_id
                    ? verificationRunDetail
                    : null,
              };
            }
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
            if (
              approvalRouteListFailurePending
              && (rpcCallCounts.get('approval.list') ?? 0) > 2
            ) {
              approvalRouteListFailurePending = false;
              error = {
                code: 'BAD_REQUEST',
                message: 'Approval queue is temporarily unavailable.',
              };
            } else {
              result = {
                approvals:
                  !attentionPlanDemo && attentionApprovalPending
                    ? [attentionApproval]
                    : [],
              };
            }
          } else if (rpc.method === 'approval.subscribe') {
            result = {
              approvals:
                !attentionPlanDemo && attentionApprovalPending
                  ? [attentionApproval]
                  : [],
              seq: 1,
            };
          } else if (rpc.method === 'approval.resolve') {
            const approvalId = (
              rpc.args as { approval_id?: unknown }
            ).approval_id;
            if (failApprovalResolve) {
              error = {
                code: 'UNAVAILABLE',
                message: 'The approval decision could not be saved.',
              };
            } else if (approvalId === attentionApproval.approval_id) {
              attentionApprovalPending = false;
              result = { ok: true };
            }
          } else if (rpc.method === 'notification.pending_asks') {
            if (failAskFollowupList && !attentionAskPending) {
              failAskFollowupList = false;
              error = {
                code: 'UNAVAILABLE',
                message: 'The answered ask queue could not be refreshed.',
              };
            } else {
              result = {
                asks:
                  !attentionPlanDemo && attentionAskPending
                    ? [attentionAsk]
                    : [],
              };
            }
          } else if (rpc.method === 'notification.submitAnswer') {
            const askId = (
              rpc.args as { ask_id?: unknown }
            ).ask_id;
            if (failAskAnswer) {
              error = {
                code: 'UNAVAILABLE',
                message: 'The answer could not be submitted.',
              };
            } else if (askId === attentionAsk.ask_id) {
              if (delayAttentionActionResponse) {
                // Keep authoritative list reads pending until the delayed ack
                // is actually delivered. This lets a live queue repaint model
                // the real interval in which the server still owns the ask.
                beforeRpcResponse = () => {
                  attentionAskPending = false;
                };
              } else {
                attentionAskPending = false;
              }
              result = { ok: true };
            }
          } else if (rpc.method === 'chat.plans.pending.list') {
            result = {
              plans:
                attentionPlanDemo && attentionPlanPending
                  ? [attentionPlan]
                  : [],
            };
          } else if (
            rpc.method === 'chat.plan.approve'
            || rpc.method === 'chat.plan.cancel'
          ) {
            if (failAttentionPlanResolve) {
              error = {
                code: 'UNAVAILABLE',
                message: 'The Chat plan decision could not be saved.',
              };
            } else {
              attentionPlanPending = false;
              result = {
                plan: {
                  ...attentionPlan.plan,
                  status:
                    rpc.method === 'chat.plan.approve'
                      ? 'approved'
                      : 'cancelled',
                  resolved_at: FIXED_NOW + 1,
                },
              };
            }
          }
        }
        if (receptionDemo) {
          if (
            receptionDestinationRecoveryDemo
            && rpc.method === 'work_entity.source.list'
          ) {
            if ((rpcCallCounts.get('work_entity.source.list') ?? 0) === 1) {
              error = {
                code: 'UNAVAILABLE',
                message: 'Destination sources are temporarily unavailable.',
              };
            } else {
              result = {
                sources: [{
                  id: 'builtin.task',
                  top_tier_kind: 'task',
                  source_kind: 'builtin',
                  source_label: 'Tasks',
                  write_capable: true,
                  mcp_exposed: false,
                  enabled: true,
                  registered_at: FIXED_NOW,
                }],
                defaults_by_kind: { task: 'builtin.task' },
              };
            }
          } else if (rpc.method === 'reception.inbox.list') {
            if (
              failReceptionRefreshAfterDecision
              && receptionDecisionAcknowledged
            ) {
              error = {
                code: 'UNAVAILABLE',
                message: 'Reception refresh unavailable.',
              };
            } else {
              result = { items: receptionInboxItems };
            }
          } else if (rpc.method === 'reception.inbox.approve') {
            const holdId = (rpc.args as { hold_id?: unknown }).hold_id;
            receptionDecisionAcknowledged = true;
            receptionInboxItems = receptionInboxItems.filter(
              (item) => item.hold_id !== holdId,
            );
            result = {
              hold_id: holdId,
              released: true,
              edited_keys: [],
            };
          } else if (rpc.method === 'reception.inbox.reject') {
            const holdId = (rpc.args as { hold_id?: unknown }).hold_id;
            receptionDecisionAcknowledged = true;
            receptionInboxItems = receptionInboxItems.filter(
              (item) => item.hold_id !== holdId,
            );
            result = { hold_id: holdId, status: 'dismissed' };
          }
        }
        if (rpc.method === 'passport.fetch') {
          result = {
            passport: {
              identity: {
                server_public_key: HARNESS_SERVER_PUBLIC_KEY,
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
          && (resolveContractsReads || contractsPagedDemo)
        ) {
          const cursor = (rpc.args as { cursor?: unknown }).cursor;
          if (contractReadFailuresRemaining > 0) {
            contractReadFailuresRemaining -= 1;
            result = undefined;
            error = {
              code: 'unavailable',
              message: 'private harness current-area failure',
            };
          } else if (
            recoverContractPage
            && cursor === 'contracts-page-2'
            && contractPageFailuresRemaining > 0
          ) {
            contractPageFailuresRemaining -= 1;
            error = {
              code: 'unavailable',
              message: 'Contract page unavailable for cursor '
                + `page_${'P'.repeat(220)}. Retry this page.`,
            };
          } else if (contractsPagedDemo) {
            const contract = (index: number) => ({
              contract_id: `door_paged_${String(index).padStart(2, '0')}`,
              minted_at: FIXED_NOW,
              minted_by: 'user',
              display_name: `Paged contract ${index}`,
              scope: {},
              lifecycle_state: 'active',
            });
            if (cursor === 'contracts-page-2') {
              result = {
                contracts: mintedPagedContract === null
                  ? [contract(26)]
                  : [contract(25), contract(26)],
                next_cursor: null,
                total: mintedPagedContract === null ? 26 : 27,
              };
            } else {
              result = {
                contracts: mintedPagedContract === null
                  ? Array.from({ length: 25 }, (_, index) => contract(index + 1))
                  : [
                      mintedPagedContract,
                      ...Array.from({ length: 24 }, (_, index) => contract(index + 1)),
                    ],
                next_cursor: 'contracts-page-2',
                total: mintedPagedContract === null ? 26 : 27,
              };
            }
          } else {
            result = { contracts: [], next_cursor: null, total: 0 };
          }
        }
        if (
          contractsPagedDemo
          && rpc.method === 'collection.contract.mintContract'
        ) {
          if (contractMintFailuresRemaining > 0) {
            contractMintFailuresRemaining -= 1;
            error = {
              code: 'unavailable',
              message: 'Contract mint unavailable for request '
                + `mint_${'M'.repeat(220)}. Check limits and retry.`,
            };
          } else {
            const args = rpc.args as {
              display_name?: unknown;
              door_types?: unknown;
              max_uses?: unknown;
              expiry_at?: unknown;
            };
            mintedPagedContract = {
              contract_id: 'door_paged_new',
              minted_at: FIXED_NOW,
              minted_by: 'user',
              display_name: typeof args.display_name === 'string'
                ? args.display_name
                : 'New contract',
              scope: {},
              lifecycle_state: 'active',
              ...(Array.isArray(args.door_types)
                ? { door_types: args.door_types }
                : {}),
              ...(typeof args.max_uses === 'number'
                ? { max_uses: args.max_uses }
                : {}),
              ...(typeof args.expiry_at === 'number'
                ? { expiry_at: args.expiry_at }
                : {}),
            } as ContractDefinitionView;
            result = mintedPagedContract;
          }
        }
        if (
          contractsPagedDemo
          && rpc.method === 'collection.contract.revokeContract'
        ) {
          if (contractRevokeFailuresRemaining > 0) {
            contractRevokeFailuresRemaining -= 1;
            error = {
              code: 'unavailable',
              message: 'Contract revoke unavailable for request '
                + `revoke_${'E'.repeat(220)}. Retry from this contract.`,
            };
          } else {
            const contractId = (rpc.args as { contract_id?: unknown }).contract_id;
            result = {
              contract_id: typeof contractId === 'string'
                ? contractId
                : 'door_paged_01',
              minted_at: FIXED_NOW,
              minted_by: 'user',
              display_name: 'Paged contract',
              scope: {},
              lifecycle_state: 'revoked',
            };
          }
        }
        if (
          contractsPagedDemo
          && rpc.method === 'collection.contract.setDoorTypes'
        ) {
          const args = rpc.args as {
            contract_id?: unknown;
            door_types?: unknown;
          };
          result = {
            contract_id: typeof args.contract_id === 'string'
              ? args.contract_id
              : 'door_paged_01',
            minted_at: FIXED_NOW,
            minted_by: 'user',
            display_name: 'Paged contract',
            scope: {},
            lifecycle_state: 'active',
            door_types: Array.isArray(args.door_types)
              ? args.door_types
              : [],
          };
        }
        if (
          contractsPagedDemo
          && rpc.method === 'collection.contract.listCatalogOperations'
        ) {
          result = { ingredients: [] };
        }
        if (
          contractsPagedDemo
          && rpc.method === 'housekeeping.registry.describe'
        ) {
          // Entities now contains enrichment topics; collection fences live in Ops.
          result = {
            topics: [{
              topic: 'summary',
              temporal_class: 'stable_truth',
              identity_aggregation: 'scenario',
              lifecycle_policy: 'forward_only',
              valid_scopes: ['mail'],
              compression_class: 'lossy',
              prompt_bias_hints: [],
              description: 'Mail summary digest',
              ai_surface: true,
              mcp_exposed: 'public',
              coverage: {
                row_count: 0,
                latest_event_at: null,
                producer_last_run_at: null,
                producer_failure_rate_24h: 0,
                ai_surface: true,
              },
              coverage_quality: 'low',
              coverage_quality_reasoning: 'No summaries have been produced yet.',
            }],
            total_rows_visible: 0,
          } satisfies RegistryDescribeRpcOutput;
        }
        if (contractsPagedDemo && rpc.method === 'contract.grant.read') {
          result = {
            grants: [...contractGrantRows].map(([entry_key, granted]) => ({
              entry_key,
              granted,
              set_at: FIXED_NOW,
            })),
          };
        }
        if (
          (contractsPagedDemo || resolveContractsReads)
          && rpc.method === 'contract.recipeOpUsage'
        ) {
          // The grant matrix also awaits recipe usage, even for an empty roster.
          result = {
            operations: [],
            window_days: 30,
            oldest_scanned_at: null,
            underivable: [],
          } satisfies Awaited<ReturnType<GrantRecipeOpUsageCaller>>;
        }
        if (contractsPagedDemo && rpc.method === 'contract.grant.write') {
          const args = rpc.args as {
            entry_key?: unknown;
            granted?: unknown;
          };
          if (typeof args.entry_key === 'string') {
            if (typeof args.granted === 'boolean') {
              contractGrantRows.set(args.entry_key, args.granted);
            } else {
              contractGrantRows.delete(args.entry_key);
            }
          }
          result = {
            ok: true,
            granted: typeof args.granted === 'boolean' ? args.granted : null,
          };
        }
        if (contractsPagedDemo && rpc.method === 'cli.reachability.list') {
          result = { rows: [] };
        }
        if (rpc.method === 'server.setLLMSlot') {
          const args = rpc.args as {
            slot_key?: unknown;
            slot?: unknown;
          };
          const savingSlot = args.slot !== null && typeof args.slot === 'object';
          const clearingSlot = args.slot === null;
          if (failByokSlotSave && savingSlot) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Model slot save unavailable.',
            };
          } else if (failByokSlotClear && clearingSlot) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Model slot clear unavailable.',
            };
          } else if (
            (args.slot_key === 'slot_1' || args.slot_key === 'slot_2')
            && savingSlot
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
        if (rpc.method === 'server.setEmbeddingsSlot') {
          const slot = (rpc.args as { slot?: unknown }).slot;
          const savingSlot = slot !== null && typeof slot === 'object';
          const clearingSlot = slot === null;
          if (failEmbeddingsSlotSave && savingSlot) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Embeddings slot save unavailable.',
            };
          } else if (failEmbeddingsSlotClear && clearingSlot) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Embeddings slot clear unavailable.',
            };
          } else if (savingSlot) {
            const next = slot as Record<string, unknown>;
            const current = llmConfig.embeddings_slot !== null
              && typeof llmConfig.embeddings_slot === 'object'
              ? llmConfig.embeddings_slot as Record<string, unknown>
              : null;
            const { api_key: apiKey, ...redacted } = next;
            const sameContext = current !== null
              && current.provider === redacted.provider
              && current.base_url === redacted.base_url;
            const hasKey =
              (typeof apiKey === 'string' && apiKey.length > 0)
              || (current?.has_key === true && sameContext);
            llmConfig.embeddings_slot = hasKey
              ? { ...redacted, has_key: true }
              : null;
          } else {
            llmConfig.embeddings_slot = null;
          }
          result = { ok: true };
        }
        if (rpc.method === 'server.setConfigField') {
          const args = rpc.args as { key?: unknown; value?: unknown };
          if (args.key === 'llm.budget' && failAiBudgetSave) {
            error = {
              code: 'UNAVAILABLE',
              message: 'AI budget save unavailable.',
            };
          } else if (
            args.key === 'llm.budget'
            && typeof args.value === 'number'
          ) {
            aiBudget = args.value;
          }
          if (error === undefined) result = { ok: true };
        }
        if (rpc.method === 'housekeeping.config.write') {
          if (failAiPolicyWrite) {
            error = {
              code: 'UNAVAILABLE',
              message: 'AI usage policy update unavailable.',
            };
          } else {
            const args = rpc.args as {
              allow_byok_background?: unknown;
              pause_background_ai_until?: unknown;
            };
            if (typeof args.allow_byok_background === 'boolean') {
              allowByokBackground = args.allow_byok_background;
            }
            if (
              args.pause_background_ai_until === null
              || typeof args.pause_background_ai_until === 'number'
            ) {
              pauseBackgroundAiUntil = args.pause_background_ai_until;
            }
            housekeepingUpdatedAt += 1;
            result = { ok: true, effective: housekeepingSnapshot() };
          }
        }
        if (rpc.method === 'server.upsertFreePoolEntry') {
          const entry = (rpc.args as { entry?: unknown }).entry;
          if (failFreePoolAdd) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Free-pool entry save unavailable.',
            };
          } else if (entry !== null && typeof entry === 'object') {
            const nextEntry = entry as Record<string, unknown>;
            const current = Array.isArray(llmConfig.free_pool)
              ? llmConfig.free_pool as Array<Record<string, unknown>>
              : [];
            llmConfig.free_pool = [
              ...current.filter((row) => row.id !== nextEntry.id),
              nextEntry,
            ];
          }
          if (error === undefined) result = { ok: true };
        }
        if (rpc.method === 'server.setFreePoolEntryEnabled') {
          const args = rpc.args as { id?: unknown; enabled?: unknown };
          if (failFreePoolToggle) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Free-pool entry update unavailable.',
            };
          } else {
            let found = false;
            const current = Array.isArray(llmConfig.free_pool)
              ? llmConfig.free_pool as Array<Record<string, unknown>>
              : [];
            llmConfig.free_pool = current.map((entry) => {
              if (entry.id !== args.id || typeof args.enabled !== 'boolean') {
                return entry;
              }
              found = true;
              return { ...entry, enabled: args.enabled };
            });
            result = { ok: true, found };
          }
        }
        if (rpc.method === 'server.setChatCatalogMode') {
          const args = rpc.args as { source_id?: unknown; mode?: unknown };
          if (failAiCatalogModeWrite) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Chat catalog mode update unavailable.',
            };
          } else if (typeof args.source_id === 'string') {
            const current = llmConfig.catalog_modes !== null
              && typeof llmConfig.catalog_modes === 'object'
              ? llmConfig.catalog_modes as Record<string, unknown>
              : {};
            const next = { ...current };
            if (typeof args.mode === 'string') {
              next[args.source_id] = args.mode;
            } else {
              delete next[args.source_id];
            }
            if (Object.keys(next).length > 0) {
              llmConfig.catalog_modes = next;
            } else {
              delete llmConfig.catalog_modes;
            }
            result = { ok: true };
          }
        }
        if (rpc.method === 'server.removeFreePoolEntry') {
          const id = (rpc.args as { id?: unknown }).id;
          if (failFreePoolRemove) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Free-pool entry removal unavailable.',
            };
          } else {
            const current = Array.isArray(llmConfig.free_pool)
              ? llmConfig.free_pool as Array<Record<string, unknown>>
              : [];
            const next = current.filter((entry) => entry.id !== id);
            llmConfig.free_pool = next;
            result = { ok: true, removed: next.length !== current.length };
          }
        }
        if (rpc.method === 'server.setLlmPrompt') {
          const args = rpc.args as {
            surface?: unknown;
            role_instructions?: unknown;
            role?: unknown;
          };
          if (failAiPromptSave) {
            error = {
              code: 'UNAVAILABLE',
              message: 'System prompt save unavailable.',
            };
          } else if (args.surface === 'chat') {
            const authored = typeof args.role_instructions === 'string'
              && args.role_instructions.trim().length > 0;
            chatPrompt = authored
              ? (args.role_instructions as string).trim()
              : defaultPrompt;
            chatPromptRole = authored && (
              args.role === 'user' || args.role === 'assistant'
            )
              ? args.role
              : 'system';
            chatPromptIsDefault = !authored;
          }
          if (error === undefined) result = { ok: true };
        }
        if (rpc.method === 'chat.default_model_pref.set') {
          if (failDefaultModelPreference) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Default model preference unavailable.',
            };
          } else {
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
        }
        if (rpc.method === 'chat.session.set_model_pref') {
          result = { ok: true };
        }
        if (
          failChatHistoryActions
          && (
            rpc.method === 'chat.session.export'
            || rpc.method === 'chat.session.delete'
          )
        ) {
          error = {
            code: 'UNAVAILABLE',
            message: 'The chat history action could not be completed.',
          };
        }
        if (rpc.method === 'contact.upsert') {
          if (failContactUpsert) {
            error = {
              code: 'UNAVAILABLE',
              message: 'Contact save unavailable.',
            };
          } else {
            const args = rpc.args as {
              email?: string;
              name?: string;
              phone?: string;
              company?: string;
            };
            result = {
              contact: {
                id: args.email ?? 'created@example.test',
                canonical_id: args.email ?? 'created@example.test',
                email: args.email ?? 'created@example.test',
                ...(args.name !== undefined ? { name: args.name } : {}),
                ...(args.phone !== undefined ? { phone: args.phone } : {}),
                ...(args.company !== undefined ? { company: args.company } : {}),
                created_at: FIXED_NOW,
                updated_at: FIXED_NOW,
              },
            };
          }
        }
        if (rpc.method === 'collection.mail.enrollOAuth' && firstSyncDemo) {
          mailConnected = true;
          result = { ok: true, account_key_prefix: 'gmail.work' };
        }
        if (calendarLifecycleDemo && rpc.method === 'collection.calendar.list') {
          result = {
            instances: [{
              slug: 'work-calendar',
              platform: 'calendar',
              adapter_type: 'gcal',
              caps: { auth: 'oauth' },
              auth_state: 'expired',
              last_synced_at: FIXED_NOW - 3_600_000,
            }],
          };
        }
        if (calendarLifecycleDemo && rpc.method === 'collection.calendar.resync') {
          result = { ok: true };
        }
        if (calendarLifecycleDemo && rpc.method === 'collection.calendar.reauth') {
          error = {
            code: 'UNAVAILABLE',
            message: 'Calendar sign-in is temporarily unavailable.',
          };
        }
        if (rpc.method === 'collection.mail.enrollImap' && imapEnrollFails) {
          error = {
            code: 'VALIDATION',
            message: 'The mailbox credentials were rejected.',
          };
        }
        if (rpc.method === 'collection.mail.enrollImap' && imapEnrollSucceeds) {
          mailConnected = true;
          result = { slug: 'fastmail', send_capable: false };
        }
        if (updatesDemo && rpc.method === 'update.check') {
          if (
            failSlowUpdatesCheckRetry
            && (rpcCallCounts.get('update.check') ?? 0) === 2
          ) {
            error = {
              code: 'UNAVAILABLE',
              message: 'The update check could not be completed.',
            };
          } else if (slowUpdatesApply) {
            result = {
              status: 'update-available',
              current_version: '26.8.0',
              channel: 'stable',
              available: {
                version: '26.8.1',
                migration: false,
                is_major: false,
                below_min_supported: false,
                in_rollout_cohort: true,
                auto_apply_eligible: true,
                notes_url: 'https://recued.com/notes/26.8.1',
              },
            };
          } else {
            result = {
              status: 'up-to-date',
              current_version: '26.8.0',
              channel: 'stable',
            };
          }
        }
        if (updatesDemo && rpc.method === 'update.mode') {
          result = {
            mode: 'notify',
            source: 'user',
            env_locked: false,
            channel_default: 'auto',
          };
        }
        if (slowUpdatesApply && rpc.method === 'update.apply') {
          result = {
            status: 'deferred',
            detail: 'Waiting for the server to become idle.',
          };
        }
        if (rpc.method === 'collection.mail.delete' && connectedSourceReadyDemo) {
          mailConnected = false;
          result = { ok: true };
        }
        // ── `settle_reads=1` — settle the background reads a route waits on. ──
        //
        // ⛔ An unrecognised method below is left PENDING FOREVER, and a route
        // whose gather includes one renders its shell plus "Loading…" and never
        // its controls. That is invisible to a sweep — a surface with nothing on
        // it reports clean by having nothing to find, so "not audited" and
        // "audited, clean" look identical.
        //
        // These are all simple list reads whose EMPTY answer is a real state
        // the panel renders. Opt-in, so no existing spec's pending state moves;
        // the surface sweep sets it. A shape with required fields is NOT faked
        // here — see `server.seller.getOverview` above for why a half-invented
        // object is worse than an honest failure.
        if (settleBackgroundReads && result === undefined && error === undefined) {
          const empty: Record<string, unknown> = {
            'ingredient.draft.list': { drafts: [] },
            'collection.contract.listDelegationSuggestions': { suggestions: [] },
            'collection.contract.listScopedGrantSuggestions': { suggestions: [] },
            'collection.contract.session_grant.list': { grants: [] },
            'contract.grant.read': { grants: [] },
            'collection.contract.listCatalogOperations': { ingredients: [] },
            'collection.connection.list': { connections: [] },
            'supervision.list': { daemons: [] },
            'cli.reachability.list': { rows: [] },
            'cli.reachability.universe': { tools: [] },
            'collection.operation.listOperations': { ingredients: [] },
            'collection.operation.listOwnerOverrides': { overrides: [] },
          };
          if (empty[rpc.method] !== undefined) result = empty[rpc.method];
          if (rpc.method === 'housekeeping.task.run_now') {
            const taskId = (rpc.args as { task_id?: unknown }).task_id;
            result = {
              ok: true,
              cycle_result: {
                preset: 'balanced',
                duration_ms: 25,
                tasks_stepped: 1,
                tasks_complete: 1,
                tasks_yielded: 0,
                tasks_errored: 0,
                per_task: [{
                  task_id: typeof taskId === 'string' ? taskId : 'unknown',
                  status: 'complete',
                  duration_ms: 25,
                }],
              },
            };
          }
          if (rpc.method === 'housekeeping.topic.reset') {
            const args = rpc.args as {
              topic?: unknown;
              reset_psi_baselines?: unknown;
              confirmation_token?: unknown;
            };
            const topic = typeof args.topic === 'string'
              ? args.topic
              : 'unknown';
            const applied = typeof args.confirmation_token === 'string';
            result = {
              applied,
              confirmation_token: applied ? null : `reset-${topic}-token`,
              expires_at: applied ? null : FIXED_NOW + 300_000,
              topic,
              scope_filter: null,
              reset_psi_baselines:
                typeof args.reset_psi_baselines === 'boolean'
                  ? args.reset_psi_baselines
                  : true,
              impact: {
                rows_to_tombstone: 48,
                pinned_protected: 2,
                psi_baselines_to_drop: 1,
                estimated_recompute_tokens: 28_800,
              },
              applied_summary: applied
                ? {
                    rows_tombstoned: 48,
                    rows_recompute_enqueued: 48,
                    psi_baselines_dropped: 1,
                    pinned_skipped: 2,
                  }
                : {
                    rows_tombstoned: 0,
                    rows_recompute_enqueued: 0,
                    psi_baselines_dropped: 0,
                    pinned_skipped: 0,
                  },
            };
          }
          // ── Settings panel reads, answered as UNAVAILABLE ─────────────────
          //
          // Every Settings section mounts eagerly, and each of these gates a
          // panel that otherwise renders "Loading…" forever — 348 of the
          // webclient's declared attributes sit behind them.
          //
          // ⛔ They are ERRORED, not faked. Their responses are named
          // interfaces with required fields (`AccountBindingStatusResponse`,
          // `DdnsEnabledStatus`, `RegistryDescribeRpcOutput`, `UpdateModeStatus`
          // …), and a half-invented object is worse than an honest failure:
          // `server.seller.getOverview` answered `{ tiers: [] }` unblocked one
          // consumer and then crashed the Seller page on the field it did not
          // invent. An error is a shape that cannot be wrong.
          //
          // This is not a consolation prize. It sweeps each panel's FAILURE
          // branch — and most of the live-drive defects that motivated this
          // audit were failure paths, including one whose error path lived in
          // code the surface never reached.
          // Panels whose shape IS cheap to satisfy get real (empty) data
          // instead of an error, because an error branch renders an error and a
          // Retry — 19 errored reads bought 8 attributes, while the populated
          // Seller and Hostnames panels are 100 between them. Each shape below
          // is copied field-for-field from its contract interface.
          const populated: Record<string, unknown> = {
            // `HostnameListResponse` · `DdnsEnabledStatus` ·
            // `NetworkLocalUrlsResponse`
            'collection.hostname.list': { hostnames: [] },
            'ddns.status': { enabled: true },
            'network.local_urls': { urls: [] },
            // `LearningCasesListCaller` · `LlmResultCacheStatsCaller` ·
            // `NotificationsDescribeCaller`
            'chat.execution.learned': { cases: [] },
            'housekeeping.cache.stats': {
              total_entries: 0, total_hits: 0, per_topic: [],
            },
            'notifications.describe': { rows: [] },
            // ── Contracts → Connect tab (the permissions panel) ────────────
            // `permissions-panel.ts` is NOT a settings panel:
            // `bootstrap-settings-route.ts` sets `const permissions = null`
            // ("Permissions moved to Contracts, D-174 P2") and it mounts as the
            // CONNECT tab of a contract detail. Rows, not empty lists — the
            // panel's attributes are per-token and per-tool controls, and an
            // empty list renders only its heading.
            'chat.inbound_token.list': {
              tokens: [{
                token_id: 'inbound-1',
                bearer_hash: 'hash-inbound-1',
                label: 'Laptop MCP client',
                created_at: FIXED_NOW,
                expires_at: FIXED_NOW + 86_400_000,
                revoked_at: null,
                grants: { 'recued.chat': true },
                concurrency_tier: 3,
                chat_mode: null,
                contract_id: 'door_paged_01',
                updated_at: FIXED_NOW,
              }],
            },
            'chat.inbound_token.tool_catalog': {
              catalog: [{
                name: 'data.timeline',
                tier: 1,
                description: 'Read one entity timeline.',
                arg_schema: {},
                topic_tags: ['data'],
                classification: 'read',
              }, {
                name: 'mail.send',
                tier: 3,
                description: 'Send a mail message.',
                arg_schema: {},
                topic_tags: ['mail'],
                classification: 'write',
              }],
            },
            // ── Privacy / Exposure + Key Health ───────────────────────────
            // Both were ERRORED, which renders an error and a Retry and
            // nothing else — 27 live attributes across the two panels sat
            // behind that. Neither has a dead constant; they were simply
            // never given an answer.
            'exposure.get': {
              state: {
                // Built by the contract's own `applyPreset`, so the table is
                // the real one rather than a hand-copied guess.
                resolution: applyPreset('lan_only', { acknowledged: false }),
                derived_preset_label: 'lan_only',
                public_mcp_acknowledgement: { acknowledged: false },
                last_changed_at: FIXED_NOW,
                changed_by_client_id: 'device-current',
              },
              apex_mode: 'serve_webclient',
            },
            // `KeyHealthView` wraps the seven-member `KeyHealthBundle` plus the
            // server-computed action availability map. Statuses are varied on
            // purpose: one healthy, one warning, one overdue and one
            // compromise-flagged. Three available classes expose repeated
            // rotation controls; managed and unavailable classes cover the
            // other two server-computed action states.
            'key.health': {
              key_health: {
                master_dek: { status: 'healthy', last_rotated_at: FIXED_NOW },
                sub_dek: { status: 'healthy', last_rotated_at: FIXED_NOW },
                server_identity_key: {
                  status: 'warning', last_rotated_at: FIXED_NOW,
                  expiry_warning: true,
                },
                publisher_identity_key: { status: 'healthy' },
                tls_private_key: {
                  status: 'overdue', last_rotated_at: FIXED_NOW,
                  expiry_warning: true,
                },
                webclient_token: { status: 'healthy' },
                webhook_secret: { status: 'warning', compromise_alert: true },
              },
              availability: {
                master_dek: 'available',
                sub_dek: 'unavailable',
                server_identity_key: 'available',
                publisher_identity_key: 'available',
                tls_private_key: 'managed_elsewhere',
                webclient_token: 'managed_elsewhere',
                webhook_secret: 'unavailable',
              },
            },
            // `system.status` → `{ status: ServerSystemStatus }`. Key Health
            // consumes only `keyfile_sealing`, but the rpc contract requires
            // the complete dashboard snapshot. Use the known-unsealed state
            // so the populated sweep reaches the consequence + remediation
            // branch instead of mistaking a missing posture read for safety.
            'system.status': {
              status: {
                name: 'Audit server',
                version: '0.0.0-harness',
                uptime_seconds: 7_200,
                paired_client_count: 2,
                paired_client_connected: 1,
                ws_state: 'serving',
                last_sync_at: FIXED_NOW,
                executions_last_hour: 3,
                executions_last_24h: 12,
                pending_asks: 1,
                schedule_queue_depth: 0,
                recent_error_count: 0,
                keyfile_sealing: 'none',
                snapshot_at: FIXED_NOW,
              },
            },
            // `housekeeping.status.read` → the denormalized task registry.
            // Populate multiple core rows so Server → Maintenance reaches its
            // table, repeated Run-now controls, history, and error branch.
            'housekeeping.status.read': {
              tasks: [{
                meta: {
                  id: 'audit-compaction',
                  description: 'Compact repetitive audit rows',
                  interruptible: true,
                  kind: 'core',
                },
                state: {
                  task_id: 'audit-compaction',
                  cursor: { kind: 'complete' },
                  last_run_at: FIXED_NOW - 60_000,
                  last_run_duration_ms: 420,
                  last_status: 'complete',
                  consecutive_errors: 0,
                },
              }, {
                meta: {
                  id: 'tls-cert-renewal',
                  description: 'Renew expiring TLS certificates',
                  interruptible: true,
                  kind: 'core',
                },
                state: {
                  task_id: 'tls-cert-renewal',
                  cursor: { kind: 'complete' },
                  last_run_at: FIXED_NOW - 3_600_000,
                  last_run_duration_ms: 1_250,
                  last_status: 'error',
                  consecutive_errors: 1,
                  last_error: 'ACME provider unavailable',
                },
              }, {
                meta: {
                  id: 'cache-gc',
                  description: 'Remove expired cache entries',
                  interruptible: true,
                  kind: 'core',
                },
              }],
            },
            'collection.contract.listOverrides': {
              overrides: [{
                actor: 'user_self',
                ingredient_id: 'recued-core/mail-post',
                operation_id: 'send',
                policy: { denied: true },
                written_at: FIXED_NOW,
              }],
            },
            // `SellerOverview` — all SEVEN required fields, because five of
            // them are objects rather than arrays and the page reads into them.
            // This is the shape whose two-field version crashed the Seller page
            // earlier in this audit.
            // ⚠ POPULATED, not empty. An empty directory renders only the
            // shell — the Seller page's attributes describe tiers, customers,
            // usage and offers, so each list needs a ROW to render its columns,
            // chips and per-row actions. Every field is copied from its
            // contract interface and every enum value from that interface's
            // own `as const` vocabulary (`SELLER_LIFECYCLE_SOURCES`,
            // `SELLER_ACCESS_STATES`, `SELLER_USAGE_KINDS`,
            // `SELLER_OVERVIEW_READINESS_*`, `SELLER_OFFER_*`) — an invented
            // enum member would render a row and then fail on the branch that
            // switches over it.
            'server.seller.getOverview': {
              settings: {
                default_grace_hours: 72,
                sender_mail_instance_id: null,
                status_policy_json: {},
                email_policy_json: {},
                llm_gateway_paid_ack_at: null,
                llm_gateway_paid_ack_version: null,
              },
              tiers: [{
                tier_id: 'tier-standard',
                door_id: 'door_paged_01',
                lifecycle_source: 'manual',
                entitlement_key: 'standard',
                display_name: 'Standard',
                template_contract_id: 'door_paged_01',
                external_entitlement_id: null,
                usage_policy_json: {},
                pass_duration_seconds: null,
                customer_status_enabled_default: true,
                active: true,
                created_at: FIXED_NOW,
                updated_at: FIXED_NOW,
              }, {
                tier_id: 'tier-standard-annual',
                door_id: 'door_paged_01',
                lifecycle_source: 'manual',
                entitlement_key: 'standard-annual',
                display_name: 'Standard',
                template_contract_id: 'door_paged_01',
                external_entitlement_id: null,
                usage_policy_json: {},
                pass_duration_seconds: 31_536_000,
                customer_status_enabled_default: true,
                active: true,
                created_at: FIXED_NOW + 1,
                updated_at: FIXED_NOW + 1,
              }, {
                tier_id: 'tier-stripe-standard',
                door_id: 'door_paged_01',
                lifecycle_source: 'stripe',
                entitlement_key: 'standard-stripe',
                display_name: 'Standard',
                template_contract_id: 'door_paged_01',
                external_entitlement_id: 'feature_standard',
                usage_policy_json: {},
                pass_duration_seconds: null,
                customer_status_enabled_default: true,
                active: true,
                created_at: FIXED_NOW + 2,
                updated_at: FIXED_NOW + 2,
              }],
              customers: [{
                customer_id: 'customer-1',
                lifecycle_source: 'manual',
                source_customer_id: 'customer-shared',
                door_id: 'door_paged_01',
                email: 'buyer@example.test',
                tier_id: 'tier-standard',
                contract_id: 'door_paged_01',
                inbound_token_id: null,
                mcp_token_id: null,
                external_subscription_id: null,
                source_status: null,
                current_period_end: null,
                grace_until: null,
                access_state: 'active',
                claim_email_sent_at: null,
                claim_email_marker: null,
                status_email_sent_at: null,
                status_email_marker: null,
                created_at: FIXED_NOW,
                updated_at: FIXED_NOW,
              }, {
                customer_id: 'customer-2',
                lifecycle_source: 'stripe',
                source_customer_id: 'customer-shared',
                door_id: 'door_paged_01',
                email: 'renewal@example.test',
                tier_id: 'tier-stripe-standard',
                contract_id: 'door_customer_02',
                inbound_token_id: 'inbound-customer-2',
                mcp_token_id: null,
                external_subscription_id: 'sub_customer_2',
                source_status: 'active',
                current_period_end: FIXED_NOW + 2_592_000_000,
                grace_until: null,
                access_state: 'active',
                claim_email_sent_at: FIXED_NOW,
                claim_email_marker: 'claim-customer-2',
                status_email_sent_at: null,
                status_email_marker: null,
                created_at: FIXED_NOW + 2,
                updated_at: FIXED_NOW + 2,
              }],
              usage_rollups: [{
                contract_id: 'door_paged_01',
                usage_kind: 'tool_call',
                period_granularity: 'day',
                period_start: FIXED_NOW,
                units: 12,
                created_at: FIXED_NOW,
                updated_at: FIXED_NOW,
              }, {
                contract_id: 'door_paged_01',
                usage_kind: 'chat_turn',
                period_granularity: 'day',
                period_start: FIXED_NOW,
                units: 7,
                created_at: FIXED_NOW,
                updated_at: FIXED_NOW,
              }],
              counts: {
                tiers: 3, active_tiers: 3, customers: 2,
                active_customers: 2, grace_customers: 0, closed_customers: 0,
              },
              readiness: [
                {
                  key: 'manual_lifecycle', state: 'ready',
                  label: 'Manual lifecycle', detail: 'Ready.', href: null,
                },
                {
                  key: 'mail_sender', state: 'needs_setup',
                  label: 'Mail sender', detail: 'Choose a sender.',
                  href: '#settings/notifications',
                },
                {
                  key: 'llm_gateway', state: 'not_wired',
                  label: 'LLM gateway', detail: 'No route configured.',
                  href: '#settings/ai-models',
                },
              ],
              llm_gateway: {
                configured: false,
                config_readable: true,
                default_route: null,
                model_alias: null,
                paid_ack_at: null,
                paid_acknowledged: false,
              },
              offers: [{
                offer_id: 'offer-1',
                kind: 'service',
                display_name: 'Consultation',
                description: 'One hour of advice.',
                pricing_kind: 'fixed',
                amount_minor: 5000,
                currency: 'GBP',
                fulfillment_recipe_id: null,
                fulfillment_config: null,
                checkout_url: null,
                state: 'active',
                created_by_recipe_id: null,
                created_at: FIXED_NOW,
                updated_at: FIXED_NOW,
              }, {
                offer_id: 'offer-2',
                kind: 'service',
                display_name: 'Consultation',
                description: 'Two hours of advice.',
                pricing_kind: 'fixed',
                amount_minor: 9000,
                currency: 'GBP',
                fulfillment_recipe_id: null,
                fulfillment_config: null,
                checkout_url: null,
                state: 'paused',
                created_by_recipe_id: null,
                created_at: FIXED_NOW + 1,
                updated_at: FIXED_NOW + 1,
              }],
            },
            // `SellerListOrdersResponse` — two independently recoverable rows
            // exercise the repeated owner actions that a one-order fixture
            // cannot distinguish in the rendered accessibility tree.
            'server.seller.listOrders': {
              orders: [{
                order_key: 'ord:access:claim-mail-1',
                order_handle: `oh_${'a'.repeat(64)}`,
                offer_id: 'offer-1',
                origin_kind: 'reception_submission',
                origin_ref: 'submission-1',
                phase: 'needs_owner',
                pricing_kind: 'fixed',
                amount_minor: 5000,
                currency: 'GBP',
                fulfillment_recipe_id: null,
                customer_id: 'customer-1',
                entitlement_key: 'standard',
                provider: 'stripe',
                provider_session_id: 'cs_test_1',
                provider_payment_id: 'pi_test_1',
                checkout_url: 'https://example.test/checkout/1',
                fulfillment_config: null,
                artifact_ref: null,
                artifact_hash: null,
                linked_work_entity_kind: null,
                linked_work_entity_id: null,
                error_code: 'claim_mail_undelivered',
                revision: 2,
                created_at: FIXED_NOW,
                updated_at: FIXED_NOW,
                paid_at: FIXED_NOW,
                expires_at: null,
              }, {
                order_key: 'ord:access:claim-mail-2',
                order_handle: `oh_${'b'.repeat(64)}`,
                offer_id: 'offer-1',
                origin_kind: 'reception_submission',
                origin_ref: 'submission-2',
                phase: 'needs_owner',
                pricing_kind: 'fixed',
                amount_minor: 5000,
                currency: 'GBP',
                fulfillment_recipe_id: null,
                customer_id: 'customer-2',
                entitlement_key: 'standard',
                provider: 'stripe',
                provider_session_id: 'cs_test_2',
                provider_payment_id: 'pi_test_2',
                checkout_url: 'https://example.test/checkout/2',
                fulfillment_config: null,
                artifact_ref: null,
                artifact_hash: null,
                linked_work_entity_kind: null,
                linked_work_entity_id: null,
                error_code: 'claim_mail_undelivered',
                revision: 2,
                created_at: FIXED_NOW + 1,
                updated_at: FIXED_NOW + 1,
                paid_at: FIXED_NOW + 1,
                expires_at: null,
              }],
              truncated: false,
            },
          };
          if (result === undefined && populated[rpc.method] !== undefined) {
            result = populated[rpc.method];
          }
          const unavailable = new Set([
            'account.bindingStatus',
            'housekeeping.registry.describe',
            'housekeeping.trust.read',
            'notifications.describe_bridges',
            'pro_convenience.status', 'update.check',
            'update.mode', 'work_entity.source.list',
          ]);
          if (result === undefined && unavailable.has(rpc.method)) {
            error = {
              code: 'UNAVAILABLE',
              message: `No ${rpc.method} backend in the fake transport.`,
            };
          }
        }
        const preapprovalReply = preapprovalDemoReply(rpc.method, rpc.args);
        if (preapprovalReply !== null) { result = preapprovalReply.result; error = preapprovalReply.error; }
        const todayReply: ReturnType<typeof todayDemoReply> = todayDemoReply(rpc.method, rpc.args)
          ?? todayEmptyDemoReply(rpc.method);
        if (todayReply !== null) { result = todayReply.result; error = todayReply.error; }
        // D-265's queue read. Unanswered it never settles, and `sendMessage`
        // awaits it before `chat.send` — see `chat-turn-queue.ts`.
        const queueReply = chatTurnQueueDemoReply(rpc.method, rpc.args);
        if (queueReply !== null) { result = queueReply.result; }
        // Every capture except contact hung on commit without this — see
        // `work-entity-upsert.ts`. Declines under the paged demo, which owns
        // its own stateful answer for the same method.
        const upsertReply = workEntityUpsertDemoReply(rpc.method, rpc.args);
        if (upsertReply !== null) { result = upsertReply.result; }
        const simulationReply = recipeSimulationDemoReply(rpc.method, rpc.args);
        if (simulationReply !== null) { result = simulationReply.result; error = undefined; }
        // `trace_pending=1` — name every read this transport never answers.
        // The list is how a coverage gap stops being archaeology: a route stuck
        // on "Loading…" tells you nothing, the method name tells you exactly
        // what to add.
        if (tracePendingReads && result === undefined && error === undefined) {
          console.warn('[unanswered-rpc]', rpc.method);
        }
        if (result === undefined && error === undefined) return;
        // rpc-conn registers the pending request before transport.send. One
        // harness mode deliberately lets the AI-config read settle on a later
        // network tick so the setup-return focus test covers the real race.
        const respond = (): void => {
          beforeRpcResponse?.();
          beforeRpcResponse = null;
          for (const listener of [...messages]) {
            listener({
              type: 'rpc_result',
              request_id: rpc.request_id,
              ...(error === undefined ? { result } : { error }),
            });
          }
        };
        if (
          new URLSearchParams(location.search).getAll('hold_rpc').includes(rpc.method)
        ) {
          const pending = heldRpcResponses.get(rpc.method) ?? [];
          pending.push(respond);
          heldRpcResponses.set(rpc.method, pending);
          return;
        } else if ((rpc.method === 'data_views.get' && new URLSearchParams(location.search).get('saved_views_get') === 'slow')
          || (['data_views.create', 'data_views.update', 'data_views.rename', 'data_views.delete'].includes(rpc.method)
            && new URLSearchParams(location.search).get('saved_views_write') === 'slow')) {
          setTimeout(respond, 750);
          return;
        } else if (
          delayChatSessionOpen
          && rpc.method === 'chat.session.get'
        ) {
          setTimeout(
            respond,
            recoverContractMint
              && (rpcCallCounts.get('collection.contract.mintContract') ?? 0) === 1
              ? 250
              : 750,
          );
          return;
        } else if (
          delayChatModelPreferenceResponse
          && rpc.method === 'chat.session.set_model_pref'
        ) {
          setTimeout(respond, 250);
          return;
        } else if (
          delayDefaultModelPreference
          && rpc.method === 'chat.default_model_pref.set'
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          delayAiBudgetSave
          && rpc.method === 'server.setConfigField'
          && (rpc.args as { key?: unknown }).key === 'llm.budget'
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          delayAiPromptSave
          && rpc.method === 'server.setLlmPrompt'
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          delayAiPolicyWrite
          && rpc.method === 'housekeeping.config.write'
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          delayAiCatalogModeWrite
          && rpc.method === 'server.setChatCatalogMode'
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          delayFreePoolAdd
          && rpc.method === 'server.upsertFreePoolEntry'
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          delayFreePoolToggle
          && rpc.method === 'server.setFreePoolEntryEnabled'
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          delayFreePoolRemove
          && rpc.method === 'server.removeFreePoolEntry'
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          delayEmbeddingsSlotClear
          && rpc.method === 'server.setEmbeddingsSlot'
          && (rpc.args as { slot?: unknown }).slot === null
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          delayEmbeddingsSlotSave
          && rpc.method === 'server.setEmbeddingsSlot'
          && (rpc.args as { slot?: unknown }).slot !== null
          && typeof (rpc.args as { slot?: unknown }).slot === 'object'
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          delayByokSlotClear
          && rpc.method === 'server.setLLMSlot'
          && (rpc.args as { slot?: unknown }).slot === null
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          delayByokSlotSave
          && rpc.method === 'server.setLLMSlot'
          && (rpc.args as { slot?: unknown }).slot !== null
          && typeof (rpc.args as { slot?: unknown }).slot === 'object'
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          webhooksDemo
          && delayWebhookTestDelivery
          && rpc.method === 'webhook.ingress.test.deliver'
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          webhooksDemo
          && delayWebhookTerminalWrite
          && (rpc.method === 'webhook.ingress.create'
            || rpc.method === 'webhook.ingress.retire')
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          delayRecipeConfigResponse
          && rpc.method === 'recipe_config.get'
        ) {
          setTimeout(respond, 250);
          return;
        } else if (
          delayRecipeConfigSetResponse
          && rpc.method === 'recipe_config.set'
        ) {
          setTimeout(respond, recipeConfigSetDelayMs);
          return;
        } else if (
          connectedSourceAnswerDemo
          && delayCollectionListRetry
          && rpc.method === 'collection.list'
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          connectedSourceAnswerDemo
          && delayCollectionGetRetry
          && rpc.method === 'collection.get'
        ) {
          setTimeout(respond, 750);
          return;
        } else if (
          holdServerControlResponse
          && (
            rpc.method === 'server.setPaused'
            || rpc.method === 'server.requestRestart'
          )
        ) {
          heldServerControlResponses.push(respond);
          return;
        }
        if (
          learningCasesDemo
          && (
            rpc.method === 'chat.execution.forget'
            || rpc.method === 'chat.execution.draft_recipe'
          )
        ) {
          setTimeout(respond, 750);
        } else if (
          (
            recipesDemo
            && (
              rpc.method === 'execute'
              || rpc.method === 'schedules.create'
              || rpc.method === 'schedules.update'
              || rpc.method === 'schedules.delete'
            )
          )
          || (
            packsDemo
            && (recipeEditableGridDemo || recipePagedFilterDemo)
            && rpc.method === 'execute'
          )
          || (formResponsesPagedDemo && rpc.method === 'execute')
        ) {
          setTimeout(
            respond,
            rpc.method === 'execute' ? recipeExecuteDelayMs : 250,
          );
        } else if (
          delayRecipeDependencyInstall
          && rpc.method === 'recipe.installBySlug'
        ) {
          setTimeout(respond, 750);
        } else if (
          (runPaletteDemo || recipesRelatedAutoRunDemo)
          && rpc.method === 'auto_run.update'
        ) {
          setTimeout(respond, autoRunUpdateDelayMs);
        } else if (
          runPaletteDemo
          && delayRunPaletteRecipeListRetry
          && rpc.method === 'recipe.list'
          && (rpcCallCounts.get('recipe.list') ?? 0) > 1
        ) {
          setTimeout(respond, 750);
        } else if (
          automationRulesDemo
          && automationRecipeEntriesRecoveryDemo
          && rpc.method === 'recipe.list'
          && (rpcCallCounts.get('recipe.list') ?? 0) > 2
        ) {
          setTimeout(respond, 750);
        } else if (
          automationRulesDemo
          && (
            rpc.method === 'triggers.create'
            || rpc.method === 'triggers.update'
            || rpc.method === 'triggers.delete'
          )
        ) {
          setTimeout(respond, 250);
        } else if (
          contractsPagedDemo
          && delayContractMintResponse
          && rpc.method === 'collection.contract.mintContract'
        ) {
          setTimeout(respond, 750);
        } else if (
          contractsPagedDemo
          && recoverContractRevoke
          && rpc.method === 'collection.contract.revokeContract'
        ) {
          setTimeout(
            respond,
            (rpcCallCounts.get('collection.contract.revokeContract') ?? 0) > 1
              ? 750
              : 250,
          );
        } else if (
          contractsPagedDemo
          && rpc.method === 'contract.grant.write'
        ) {
          setTimeout(respond, 750);
        } else if (
          packsDemo
          && searchParams.get('packs_resolve_response')
            === 'fail-once-slow-retry'
          && rpc.method === 'packs.resolveBySlug'
        ) {
          setTimeout(
            respond,
            (rpcCallCounts.get('packs.resolveBySlug') ?? 0) > 1 ? 750 : 250,
          );
        } else if (
          packsDemo
          && failPacksActionRelistOnce
          && rpc.method === 'packs.uninstall'
        ) {
          setTimeout(respond, 250);
        } else if (
          packsDemo
          && failPacksRecipeListOnce
          && rpc.method === 'recipe.list'
        ) {
          setTimeout(
            respond,
            (rpcCallCounts.get('recipe.list') ?? 0) > 1 ? 750 : 1_500,
          );
        } else if (
          packsDemo
          && rpc.method === 'packs.list'
        ) {
          setTimeout(respond, 500);
        } else if (
          connectionsGrantDemo
          && (
            rpc.method === 'collection.connection.grantOperationGroup'
            || rpc.method === 'collection.connection.revokeOperationGroup'
          )
        ) {
          setTimeout(respond, 250);
        } else if (
          calendarLifecycleDemo
          && (
            rpc.method === 'collection.calendar.resync'
            || rpc.method === 'collection.calendar.reauth'
          )
        ) {
          setTimeout(respond, 500);
        } else if (
          timelineFocusDemo
          && rpc.method === 'data.timeline'
        ) {
          setTimeout(respond, 2_000);
        } else if (
          fileDownloadDemo
          && rpc.method === 'data.file.read'
        ) {
          setTimeout(respond, 750);
        } else if (
          workEntitiesPagedDemo
          && rpc.method === 'work_entity.get'
        ) {
          setTimeout(respond, 250);
        } else if (
          workEntitiesPagedDemo
          && rpc.method === 'work_entity.upsert'
        ) {
          setTimeout(respond, 750);
        } else if (
          formResponsesPagedDemo
          && rpc.method === 'form_response.export'
        ) {
          setTimeout(respond, 750);
        } else if (
          formResponsesPagedDemo
          && (
            rpc.method === 'form_response.update'
            || rpc.method === 'form_response.set_state'
          )
        ) {
          setTimeout(respond, 250);
        } else if (
          formResponsesPagedDemo
          && rpc.method === 'recipe.list'
        ) {
          setTimeout(respond, 250);
        } else if (
          recordsDemo
          && delayRecordsDeleteResponse
          && rpc.method === 'records.delete'
        ) {
          setTimeout(respond, 750);
        } else if (
          recordsDemo
          && delayRecordsExportResponse
          && rpc.method === 'records.export'
        ) {
          setTimeout(respond, 750);
        } else if (
          recordsDemo
          && delayRecordsRetireResponse
          && rpc.method === 'records.outbox.retire'
        ) {
          setTimeout(respond, 750);
        } else if (
          recordsDemo
          && delayRecordsOutboxRefreshResponse
          && rpc.method === 'records.outbox.list'
          && (rpcCallCounts.get('records.outbox.list') ?? 0) > 1
        ) {
          setTimeout(respond, 750);
        } else if (
          recordsDemo
          && delayRecordsPurgeResponse
          && rpc.method === 'records.purge'
        ) {
          setTimeout(respond, 750);
        } else if (
          recordsDemo
          && recordsNavigationDemo
          && delayRecordsNavigationResponse
          && (
            (
              rpc.method === 'records.kind.list'
              && (rpcCallCounts.get('records.kind.list') ?? 0) > 1
            )
            || (
              rpc.method === 'records.search'
              && (rpcCallCounts.get('records.search') ?? 0) > 1
            )
          )
        ) {
          setTimeout(respond, 750);
        } else if (
          automationRulesDemo
          && delayAutomationScheduleListRetry
          && rpc.method === 'schedules.list'
          && (rpcCallCounts.get('schedules.list') ?? 0) > 1
        ) {
          setTimeout(respond, 750);
        } else if (
          automationRulesDemo
          && delayAutomationScheduleResponse
          && rpc.method === 'schedules.update'
        ) {
          setTimeout(respond, 250);
        } else if (
          automationRulesDemo
          && delayAutomationWatchRun
          && rpc.method === 'watch.run_now'
        ) {
          setTimeout(respond, 750);
        } else if (
          automationRulesDemo
          && delayAutomationWatchRelist
          && rpc.method === 'watch.list'
          && (rpcCallCounts.get('watch.list') ?? 0) > 1
        ) {
          setTimeout(respond, 750);
        } else if (
          automationDishesDemo
          && delayAutomationDishUpdate
          && rpc.method === 'dishes.update'
        ) {
          setTimeout(respond, 750);
        } else if (
          automationDishesDemo
          && delayAutomationDishHistoryRetry
          && rpc.method === 'dishes.history'
          && (rpcCallCounts.get('dishes.history') ?? 0) > 1
        ) {
          setTimeout(respond, 750);
        } else if (
          automationRulesDemo
          && delayAutomationScheduleDeleteResponse
          && rpc.method === 'schedules.delete'
        ) {
          setTimeout(respond, 750);
        } else if (
          notificationsDemo
          && delayNotificationsMutation
          && (
            rpc.method === 'notifications.set_channel'
            || rpc.method === 'notifications.set_bridge_mode'
            || rpc.method === 'notifications.set_verification_phrase'
          )
        ) {
          setTimeout(respond, 750);
        } else if (
          notificationsDemo
          && delayNotificationsRetry
          && rpc.method === 'notifications.describe'
          && (rpcCallCounts.get('notifications.describe') ?? 0) > 1
        ) {
          setTimeout(respond, 750);
        } else if (
          devicesDemo
          && delayDeviceRevoke
          && rpc.method === 'pair.revoke'
        ) {
          setTimeout(respond, 750);
        } else if (
          devicesDemo
          && delayDevicesRetry
          && rpc.method === 'pair.list'
          && (rpcCallCounts.get('pair.list') ?? 0) > 1
        ) {
          setTimeout(respond, 750);
        } else if (
          accountDemo
          && delayAccountBind
          && rpc.method === 'account.bind'
          && (rpc.args as { confirm_rebind?: unknown }).confirm_rebind !== true
        ) {
          setTimeout(respond, 750);
        } else if (
          accountDemo
          && delayAccountRebind
          && rpc.method === 'account.bind'
          && (rpc.args as { confirm_rebind?: unknown }).confirm_rebind === true
        ) {
          setTimeout(respond, 750);
        } else if (
          accountDemo
          && delayAccountUnbind
          && rpc.method === 'account.unbind'
        ) {
          setTimeout(respond, 750);
        } else if (
          accountDemo
          && delayAccountReadRetry
          && (
            rpc.method === 'account.bindingStatus'
            || rpc.method === 'pro_convenience.status'
          )
          && (rpcCallCounts.get(rpc.method) ?? 0) > 1
        ) {
          setTimeout(respond, 750);
        } else if (
          delayChatPlanResponse
          && (
            rpc.method === 'chat.plan.approve'
            || rpc.method === 'chat.plan.cancel'
          )
        ) {
          setTimeout(respond, 250);
        } else if (
          delayChatDiagnosisResponse
          && rpc.method === 'chat.data_diagnosis.resolve'
        ) {
          setTimeout(respond, 250);
        } else if (
          connectedSourceCheckDemo
          && rpc.method === 'collection.mail.list'
        ) {
          setTimeout(respond, 250);
        } else if (
          delayLogsControlResponse
          && (
            rpc.method === 'execution.kill'
            || rpc.method === 'collection.contract.session_grant.revoke'
          )
        ) {
          setTimeout(respond, 250);
        } else if (
          delayLogsRefreshResponse
          && (
            rpc.method === 'execution.active'
            || rpc.method === 'collection.contract.session_grant.list'
          )
        ) {
          setTimeout(respond, 250);
        } else if (
          delayLogsDetailResponse
          && rpc.method === 'execution.get'
        ) {
          setTimeout(respond, 750);
        } else if (
          delayLogsFeedResponse
          && rpc.method === 'execution.list'
          && (rpcCallCounts.get('execution.list') ?? 0) > 1
        ) {
          setTimeout(respond, 750);
        } else if (
          failSlowUpdatesCheckRetry
          && rpc.method === 'update.check'
          && (rpcCallCounts.get('update.check') ?? 0) === 2
        ) {
          setTimeout(respond, 750);
        } else if (slowUpdatesApply && rpc.method === 'update.apply') {
          setTimeout(respond, 750);
        } else if (
          recoverContractPage
          && rpc.method === 'collection.contract.listContracts'
          && (rpc.args as { cursor?: unknown }).cursor !== undefined
        ) {
          setTimeout(
            respond,
            (rpcCallCounts.get('collection.contract.listContracts') ?? 0) > 2
              ? 750
              : 250,
          );
        } else if (
          delayContractsPageResponse
          && rpc.method === 'collection.contract.listContracts'
          && (rpc.args as { cursor?: unknown }).cursor !== undefined
        ) {
          setTimeout(respond, 1_000);
        } else if (
          delayDataPaginationResponse
          && (
            (
              (rpc.method === 'contact.list' || rpc.method === 'work_entity.list')
              && typeof (rpc.args as { offset?: unknown }).offset === 'number'
            )
            || (
              rpc.method === 'form_response.list'
              && (rpc.args as { before?: unknown }).before !== undefined
            )
          )
        ) {
          setTimeout(respond, 1_000);
        } else if (
          delayContactImportApply
          && rpc.method === 'contact.import.file_apply'
        ) {
          setTimeout(respond, 750);
        } else if (
          delayContactImportPromote
          && rpc.method === 'contact.import.promote'
        ) {
          setTimeout(respond, 750);
        } else if (
          delayContactScan
          && rpc.method === 'contact.merge.scan_now'
        ) {
          setTimeout(respond, 750);
        } else if (
          delayContactMergeDecision
          && (
            rpc.method === 'contact.merge.confirm'
            || rpc.method === 'contact.merge.reject'
          )
        ) {
          setTimeout(respond, 750);
        } else if (
          memoryRowsDemo
          && delayMemoryGet
          && rpc.method === 'memory.get'
        ) {
          setTimeout(respond, 750);
        } else if (
          memoryRowsDemo
          && delayMemoryList
          && rpc.method === 'memory.list'
          && (rpcCallCounts.get('memory.list') ?? 0) > 1
        ) {
          setTimeout(respond, 750);
        } else if (
          memoryRowsDemo
          && delayMemoryDelete
          && rpc.method === 'memory.delete'
        ) {
          setTimeout(respond, 750);
        } else if (
          delayContactEditResponse
          && rpc.method === 'contact.get'
          && (rpcCallCounts.get('contact.get') ?? 0) > 1
        ) {
          setTimeout(respond, 750);
        } else if (
          delayAttentionActionResponse
          && (
            rpc.method === 'approval.resolve'
            || rpc.method === 'notification.submitAnswer'
            || rpc.method === 'chat.plan.approve'
            || rpc.method === 'chat.plan.cancel'
          )
        ) {
          setTimeout(respond, attentionActionDelayMs);
        } else if (
          delayApprovalRouteListRetry
          && rpc.method === 'approval.list'
          && (rpcCallCounts.get('approval.list') ?? 0) > 3
        ) {
          setTimeout(respond, 750);
        } else if (
          delayComposeCommitResponse
          && (
            rpc.method === 'contact.upsert'
            || rpc.method === 'work_entity.upsert'
          )
        ) {
          setTimeout(respond, 750);
        } else if (
          delayReceptionRecordsRetry
          && rpc.method === 'reception.record.list'
          && (rpcCallCounts.get('reception.record.list') ?? 0) > 1
        ) {
          setTimeout(respond, 250);
        } else if (
          delayReceptionResponsesRetry
          && rpc.method === 'form_response.list'
          && (rpcCallCounts.get('form_response.list') ?? 0) > 1
        ) {
          setTimeout(respond, 250);
        } else if (
          delayReceptionResponseDetailRetry
          && rpc.method === 'form_response.get'
          && (rpcCallCounts.get('form_response.get') ?? 0) > 1
        ) {
          setTimeout(respond, 250);
        } else if (
          receptionDestinationRecoveryDemo
          && rpc.method === 'work_entity.source.list'
        ) {
          setTimeout(respond, 750);
        } else if (
          delayReceptionRefreshResponse
          && rpc.method === 'reception.inbox.list'
        ) {
          setTimeout(respond, 250);
        } else if (
          delayReceptionDecisionResponse
          && (
            rpc.method === 'reception.inbox.approve'
            || rpc.method === 'reception.inbox.reject'
          )
        ) {
          setTimeout(respond, 250);
        } else if (
          (imapEnrollFails && rpc.method === 'collection.mail.enrollImap')
          || (connectedSourceReadyDemo && rpc.method === 'collection.mail.delete')
        ) {
          // Leave each busy replacement observable in Chromium before the
          // deterministic terminal response exercises its focus handoff.
          setTimeout(
            respond,
            connectedSourceReadyDemo && rpc.method === 'collection.mail.delete'
              ? accountDeleteDelayMs
              : 250,
          );
        } else if (delayAiRead && rpc.method === 'server.getLLMConfig') {
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
    releaseRpcResponses: (method) => {
      const pending = heldRpcResponses.get(method) ?? [];
      heldRpcResponses.delete(method);
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
  /** Settle responses held by `hold_rpc` after pending-state assertions. */
  releaseRpcResponses?(method: string): number;
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
  /** Account fixture diagnostic: proves browser-session sign-out is single-flight. */
  accountSignOutCount?(): number;
  /** Account fixture diagnostic: proves unbound server reads stay local. */
  accountSessionReadCount?(): number;
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
/** Audit knobs, read from module scope rather than threaded through
 *  `buildFakeTransport`'s positional parameter list — the transport body runs
 *  long after this line, and keeping them out of the signature means adding one
 *  cannot collide with unrelated work on that parameter list. */
const settleBackgroundReads = searchParams.get('settle_reads') === '1';
const tracePendingReads = searchParams.get('trace_pending') === '1';
const requestedAttentionActionDelayMs = Number.parseInt(
  searchParams.get('attention_action_delay_ms') ?? '',
  10,
);
const attentionActionDelayMs = Number.isFinite(requestedAttentionActionDelayMs)
  ? Math.min(5_000, Math.max(750, requestedAttentionActionDelayMs))
  : 750;
const requestedAccountDeleteDelayMs = Number.parseInt(
  searchParams.get('account_delete_delay_ms') ?? '',
  10,
);
const accountDeleteDelayMs = Number.isFinite(requestedAccountDeleteDelayMs)
  ? Math.min(5_000, Math.max(250, requestedAccountDeleteDelayMs))
  : 250;
const requestedRecipeExecuteDelayMs = Number.parseInt(
  searchParams.get('recipe_execute_delay_ms') ?? '',
  10,
);
const recipeExecuteDelayMs = Number.isFinite(requestedRecipeExecuteDelayMs)
  ? Math.min(5_000, Math.max(250, requestedRecipeExecuteDelayMs))
  : 250;
const recipeEditableGridDemo =
  searchParams.get('recipe_result') === 'editable-grid';
const recipePagedFilterDemo =
  searchParams.get('recipe_result') === 'paged-filter';
const recipeCopyableResultDemo =
  searchParams.get('recipe_result') === 'copyable';
const recipeJsonResultDemo =
  searchParams.get('recipe_result') === 'json';
const recipeRecordFieldsResultDemo =
  searchParams.get('recipe_result') === 'record-fields';
const recipeAiAnalysisResultDemo =
  searchParams.get('recipe_result') === 'ai-analysis';
const recipeLinkButtonsResultDemo =
  searchParams.get('recipe_result') === 'link-buttons';
const recipeFileArtifactResultDemo =
  searchParams.get('recipe_result') === 'file-artifact';
const recipeRunFactsDemo = searchParams.get('recipe_run_facts') === '1';
const packsMultiViewDemo =
  searchParams.get('packs_app_views') === 'multi';
const packsReactiveRecipeDemo =
  searchParams.get('packs_recipe_reactive') === '1';
const packsInstallConnectionDemo =
  searchParams.get('packs_install_connection');
const requestedAutoRunUpdateDelayMs = Number.parseInt(
  searchParams.get('auto_run_update_delay_ms') ?? '',
  10,
);
const autoRunUpdateDelayMs = Number.isFinite(requestedAutoRunUpdateDelayMs)
  ? Math.min(5_000, Math.max(750, requestedAutoRunUpdateDelayMs))
  : 750;
const requestedRecipeConfigSetDelayMs = Number.parseInt(
  searchParams.get('recipe_config_set_delay_ms') ?? '',
  10,
);
const recipeConfigSetDelayMs = Number.isFinite(requestedRecipeConfigSetDelayMs)
  ? Math.min(5_000, Math.max(750, requestedRecipeConfigSetDelayMs))
  : 750;
const automationWatchResponse = searchParams.get('automation_watch_response');
const automationWatchDemo = automationWatchResponse !== null;
const delayAutomationWatchRun =
  automationWatchResponse === 'slow'
  || automationWatchResponse === 'fail-once-slow';
const failFirstAutomationWatchRun =
  automationWatchResponse === 'fail-once-slow';
const delayAutomationWatchRelist =
  searchParams.get('automation_watch_relist_response') === 'slow';
const archiveRestorePreviewDemo =
  searchParams.get('archive') === 'restore-preview';
const browserClearDemo = searchParams.get('browser_clear');
const slowBrowserClearDemo =
  browserClearDemo === 'slow' || browserClearDemo === 'fail-slow';
const failBrowserClearDemo = browserClearDemo === 'fail-slow';
const browserClearCryptoKeysWiper = async (): Promise<void> => {
  if (!slowBrowserClearDemo) return;
  await new Promise((resolve) => setTimeout(resolve, 750));
  if (failBrowserClearDemo) {
    throw new Error('Browser key storage is temporarily unavailable.');
  }
};
const learningMultipleCasesDemo =
  searchParams.get('privacy') === 'learning-cases-multiple';
const learningCasesDemo = searchParams.get('privacy') === 'learning-cases'
  || learningMultipleCasesDemo;
const failLearningForget =
  searchParams.get('learning_forget_response') === 'fail-slow';
const failLearningDraft =
  searchParams.get('learning_draft_response') === 'fail-slow';
const learningDraftHandoffRecoveryDemo =
  searchParams.get('learning_draft_handoff') === 'fail-once';
const housekeepingDemo = searchParams.get('housekeeping') === 'ready';
const workEntitySourcesDemo =
  searchParams.get('work_entities') === 'multiple-sources';
const longWorkEntityTextDemo = searchParams.get('work_entity_text') === 'long';
const longFormResponseTextDemo =
  searchParams.get('form_response_text') === 'long';
const longCollectionTextDemo = searchParams.get('collection_text') === 'long';
const longRecordsTextDemo = searchParams.get('records_text') === 'long';
const longMemoryTextDemo = searchParams.get('memory_text') === 'long';
const longAccountTextDemo = searchParams.get('account_text') === 'long';
const longConnectionTextDemo = searchParams.get('connection_text') === 'long';
const longPackTextDemo = searchParams.get('pack_text') === 'long';
const longAutomationTextDemo = searchParams.get('automation_text') === 'long';
let learningDraftStashFailuresRemaining = learningDraftHandoffRecoveryDemo
  ? 1
  : 0;
const learningDraftStashStorage = {
  getItem: (key: string): string | null => window.sessionStorage.getItem(key),
  setItem: (key: string, value: string): void => {
    if (learningDraftStashFailuresRemaining > 0) {
      learningDraftStashFailuresRemaining -= 1;
      throw new Error('full-app harness: draft stash is temporarily full');
    }
    window.sessionStorage.setItem(key, value);
  },
  removeItem: (key: string): void => window.sessionStorage.removeItem(key),
};
let learningDemoCasePresent = true;
const automationRecipeEntriesRecoveryDemo =
  searchParams.get('automation_recipe_list_response')
    === 'fail-once-slow-retry';
const receptionDestinationRecoveryDemo =
  searchParams.get('reception_destination_response')
    === 'fail-once-slow-retry';
const contactImportDemo = searchParams.get('data') === 'contact-import';
const delayContactImportApply =
  searchParams.get('contact_import_apply_response') === 'slow';
const contactPromoteDemo = searchParams.get('data') === 'contact-promote';
const delayContactImportPromote =
  searchParams.get('contact_import_promote_response') === 'slow';
const contactScanDemo = searchParams.get('data') === 'contact-scan';
const delayContactScan =
  searchParams.get('contact_scan_response') === 'slow';
const contactMergeDemo = searchParams.get('data') === 'contact-merge';
const delayContactMergeDecision =
  searchParams.get('contact_merge_response') === 'slow';
const memoryRowsDemo = searchParams.get('data') === 'memory-rows';
const memoryProvenanceDemo = searchParams.get('memory_provenance') === '1';
const referenceProvenanceDemo =
  searchParams.get('reference_provenance') === '1';
const memoryDeleteResponse = searchParams.get('memory_delete_response');
const delayMemoryDelete = memoryDeleteResponse === 'slow'
  || memoryDeleteResponse === 'fail-once-slow-retry';
let memoryDeleteFailuresRemaining = memoryDeleteResponse === 'fail-once-slow-retry'
  ? 1
  : 0;
const memoryGetResponse = searchParams.get('memory_get_response');
const delayMemoryGet = memoryGetResponse === 'slow'
  || memoryGetResponse === 'fail-once-slow-retry';
let memoryGetFailuresRemaining = memoryGetResponse === 'fail-once-slow-retry'
  ? 1
  : 0;
const memoryListResponse = searchParams.get('memory_list_response');
const delayMemoryList = memoryListResponse === 'slow'
  || memoryListResponse === 'fail-once-slow-retry'
  || memoryListResponse === 'filter-fail-once-slow-retry';
let memoryListFailuresRemaining = memoryListResponse === 'fail-once-slow-retry'
  || memoryListResponse === 'filter-fail-once-slow-retry'
  ? 1
  : 0;
const memoryListFailureMessage = longMemoryTextDemo
  ? `memory-list-${'unavailable'.repeat(28)}`
  : memoryListResponse === 'filter-fail-once-slow-retry'
    ? 'Memory filter temporarily unavailable.'
    : 'Memory export temporarily unavailable.';
let memoryOwnRowPresent = true;
let memorySystemRowRedacted = false;
const accountReadFailureCount =
  searchParams.get('account') === 'read-fail-twice-slow-retry'
    ? 2
    : searchParams.get('account') === 'read-fail-once-slow-retry'
      ? 1
      : 0;
const accountBoundDemo = searchParams.get('account') === 'bound';
const accountDemo = searchParams.get('account') === 'unbound'
  || searchParams.get('account') === 'conflict'
  || accountBoundDemo
  || accountReadFailureCount > 0;
let accountDemoSessionAuthenticated = true;
let accountDemoSignOutCalls = 0;
let accountDemoSessionCalls = 0;
const delayAccountSignOut = searchParams.get('account_signout_response') === 'slow'
  || searchParams.get('account_signout_response') === 'fail-slow';
const failAccountSignOut =
  searchParams.get('account_signout_response') === 'fail-slow';
const delayRecipeDependencyInstall =
  searchParams.get('recipe_install_response') === 'slow'
  || searchParams.get('recipe_install_response') === 'fail-slow';
const failRecipeDependencyInstall =
  searchParams.get('recipe_install_response') === 'fail-slow';
const recipeDependencyInstallDemo =
  delayRecipeDependencyInstall || failRecipeDependencyInstall;
const accountDemoFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url = String(input);
  let payload: unknown;
  if (url.endsWith('/v1/auth/session')) {
    accountDemoSessionCalls += 1;
    payload = accountDemoSessionAuthenticated
      ? {
          authenticated: true,
          user: { id: 'acct-main', email: 'morgan@example.test' },
          expiresAt: FIXED_NOW + 3_600_000,
          csrfToken: 'csrf-account-demo',
        }
      : {
          authenticated: false,
          user: null,
          expiresAt: 0,
          csrfToken: 'csrf-account-demo-next',
        };
  } else if (url.endsWith('/v1/account/binding/token')) {
    const body: unknown = typeof init?.body === 'string'
      ? JSON.parse(init.body)
      : null;
    if (
      body === null
      || typeof body !== 'object'
      || !('server_fingerprint' in body)
      || body.server_fingerprint !== HARNESS_SERVER_FINGERPRINT
    ) {
      return new Response('Binding token must name the paired server.', { status: 400 });
    }
    payload = {
      binding_token: 'binding-account-demo',
      expires_at: FIXED_NOW + 60_000,
    };
  } else if (url.endsWith('/v1/auth/signout')) {
    accountDemoSignOutCalls += 1;
    if (delayAccountSignOut) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    if (failAccountSignOut) {
      return new Response(JSON.stringify({
        message: 'Account sign out unavailable.',
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    accountDemoSessionAuthenticated = false;
    payload = {
      authenticated: false,
      user: null,
      expiresAt: 0,
      csrfToken: 'csrf-account-demo-next',
    };
  } else {
    return new Response(JSON.stringify({ message: 'Unknown account demo URL.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
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
  searchParams.get('logs') === 'paged',
  searchParams.get('attention') === 'pending'
    || searchParams.get('attention') === 'destructive'
    || searchParams.get('attention') === 'plan',
  searchParams.get('attention') === 'destructive',
  searchParams.get('attention') === 'plan',
  searchParams.get('reception') === 'pending',
  searchParams.get('server_control_response') === 'hold',
  boundedVerificationJourney,
  Number.parseInt(searchParams.get('contract_read_failures') ?? '0', 10),
  searchParams.get('ai') === 'two',
  searchParams.get('data') === 'contacts'
    || searchParams.get('data') === 'contacts-paged'
    || searchParams.get('data') === 'contact-import'
    || searchParams.get('data') === 'contact-promote'
    || searchParams.get('data') === 'contact-scan'
    || searchParams.get('data') === 'contact-merge'
    || searchParams.get('data') === 'timeline',
  searchParams.get('contact_text') === 'long',
  searchParams.get('automation') === 'rules'
    || searchParams.get('automation') === 'delete'
    || searchParams.get('automation') === 'dishes',
  searchParams.get('automation') === 'delete',
  searchParams.get('automation_list_response') === 'fail-twice-slow-retry'
    ? 2
    : searchParams.get('automation_list_response') === 'fail-once-slow-retry'
      ? 1
      : 0,
  searchParams.get('automation_list_response') === 'fail-once-slow-retry'
    || searchParams.get('automation_list_response') === 'fail-twice-slow-retry',
  searchParams.get('data') === 'contacts-paged',
  searchParams.get('data_pagination_response') === 'slow',
  searchParams.get('contact_edit_response') === 'slow'
    || searchParams.get('contact_edit_response') === 'fail-slow',
  searchParams.get('contact_edit_response') === 'fail-slow',
  searchParams.get('data') === 'work-entities-paged',
  searchParams.get('data') === 'form-responses-paged',
  searchParams.get('data') === 'records'
    || searchParams.get('data') === 'records-orphaned'
    || searchParams.get('data') === 'records-navigation',
  searchParams.get('data') === 'records-orphaned',
  searchParams.get('data') === 'records-navigation',
  searchParams.get('records_delete_response') === 'slow',
  searchParams.get('records_export_response') === 'slow',
  searchParams.get('records_retire_response') === 'slow',
  searchParams.get('records_outbox_response') === 'slow',
  searchParams.get('records_purge_response') === 'slow',
  searchParams.get('records_navigation_response') === 'slow',
  searchParams.get('live') === 'interrupted' ? 'interrupted' : searchParams.get('live') === 'running',
  searchParams.get('run_palette') === 'autorun'
    || searchParams.get('run_palette') === 'autorun-fail'
    || searchParams.get('run_palette') === 'inventory-retry'
    || searchParams.get('run_palette') === 'long',
  searchParams.get('run_palette') === 'autorun-fail',
  searchParams.get('connection') === 'imap-fail',
  searchParams.get('connection') === 'imap-success',
  searchParams.get('recipes') === 'installed'
    || searchParams.get('recipes') === 'related-autorun',
  searchParams.get('recipes') === 'paged',
  searchParams.get('contracts') === 'paged',
  searchParams.get('contracts_page_response') === 'slow',
  searchParams.get('ai_pool') === 'entry',
  searchParams.get('ai_usage') === 'ready',
  searchParams.get('packs') === 'installed',
  searchParams.get('packs_response') === 'detail-fail-once-slow-retry',
  searchParams.get('packs_response') === 'uninstall-relist-fail-once',
  searchParams.get('packs_recipe_response') === 'fail-once-slow-retry',
  searchParams.get('connection') === 'grants',
  searchParams.get('connection') === 'calendar-lifecycle',
  searchParams.get('data') === 'timeline',
  searchParams.get('data') === 'file-download',
  searchParams.get('chat_plan_response') === 'slow',
  searchParams.get('chat_diagnosis_response') === 'slow',
  searchParams.get('connection') === 'source-check',
  searchParams.get('logs_control_response') === 'slow',
  searchParams.get('logs_control_followup_response') === 'fail',
  searchParams.get('logs_passes') === 'active',
  searchParams.get('compose_commit_response') === 'slow',
  searchParams.get('reception_decision_response') === 'slow',
  searchParams.get('recipe_default_run') === '1',
  searchParams.get('recipe_config_response') === 'slow'
    || searchParams.get('recipe_config_response') === 'fail-slow',
  searchParams.get('recipe_config_response') === 'fail-slow',
  searchParams.get('chat_history_action_response') === 'fail',
  searchParams.get('chat_model_sources') === 'same-speed-slot-2',
  searchParams.get('chat_model_pref_response') === 'slow',
  searchParams.get('chat_send_response') === 'fail-once',
  searchParams.get('logs_refresh_response') === 'slow',
  searchParams.get('logs_feed_response') === 'slow',
  searchParams.get('attention_action_response') === 'slow',
  searchParams.get('approval_queue_response') === 'fail-once-slow-retry',
  searchParams.get('approval_queue_response') === 'fail-once-slow-retry',
  searchParams.get('approval_resolve_response') === 'fail',
  searchParams.get('ask_answer_response') === 'fail',
  searchParams.get('ask_answer_response') === 'followup-list-fail',
  searchParams.get('plan_resolve_response') === 'fail',
  searchParams.get('reception_refresh_after_decision') === 'fail',
  searchParams.get('reception_refresh_response') === 'slow',
  searchParams.get('reception_records_response') === 'fail-once-slow-retry',
  searchParams.get('reception_records_response') === 'fail-twice-slow-retry',
  searchParams.get('reception_records_response') === 'fail-once-slow-retry'
    || searchParams.get('reception_records_response') === 'fail-twice-slow-retry',
  searchParams.get('reception_responses_response') === 'fail-once-slow-retry',
  searchParams.get('reception_responses_response') === 'fail-twice-slow-retry',
  searchParams.get('reception_responses_response') === 'fail-once-slow-retry'
    || searchParams.get('reception_responses_response') === 'fail-twice-slow-retry',
  searchParams.get('reception_response_detail') === 'fail-once-slow-retry',
  searchParams.get('reception_response_detail') === 'fail-twice-slow-retry',
  searchParams.get('reception_response_detail') === 'fail-once-slow-retry'
    || searchParams.get('reception_response_detail') === 'fail-twice-slow-retry',
  searchParams.get('contact_save_response') === 'fail',
  searchParams.get('automation_schedule_response') === 'slow'
    || searchParams.get('automation_schedule_response') === 'fail-slow',
  searchParams.get('automation_schedule_response') === 'fail-slow',
  searchParams.get('automation_schedule_delete_response') === 'slow'
    || searchParams.get('automation_schedule_delete_response') === 'fail-slow',
  searchParams.get('automation_schedule_delete_response') === 'fail-slow',
  searchParams.get('notifications') === 'ready'
    || searchParams.get('notifications') === 'fail-once-slow-retry',
  searchParams.get('notifications_response') === 'slow'
    || searchParams.get('notifications_response') === 'fail-slow',
  searchParams.get('notifications_response') === 'fail-slow',
  searchParams.get('notifications') === 'fail-once-slow-retry',
  searchParams.get('notifications') === 'fail-once-slow-retry',
  searchParams.get('devices') === 'ready'
    || searchParams.get('devices') === 'fail-once-slow-retry'
    || searchParams.get('devices') === 'fail-twice-slow-retry',
  searchParams.get('device_revoke_response') === 'slow'
    || searchParams.get('device_revoke_response') === 'fail-slow',
  searchParams.get('device_revoke_response') === 'fail-slow',
  searchParams.get('devices') === 'fail-twice-slow-retry'
    ? 2
    : searchParams.get('devices') === 'fail-once-slow-retry'
      ? 1
      : 0,
  searchParams.get('devices') === 'fail-once-slow-retry'
    || searchParams.get('devices') === 'fail-twice-slow-retry',
  accountDemo,
  searchParams.get('account_bind_response') === 'slow'
    || searchParams.get('account_bind_response') === 'fail-slow',
  searchParams.get('account_bind_response') === 'fail-slow',
  searchParams.get('account') === 'conflict',
  searchParams.get('account_rebind_response') === 'slow'
    || searchParams.get('account_rebind_response') === 'fail-slow',
  searchParams.get('account_rebind_response') === 'fail-slow',
  searchParams.get('account_unbind_response') === 'slow'
    || searchParams.get('account_unbind_response') === 'fail-slow',
  searchParams.get('account_unbind_response') === 'fail-slow',
  accountReadFailureCount,
  accountReadFailureCount > 0,
  searchParams.get('ai_default_model_pref_response') === 'slow'
    || searchParams.get('ai_default_model_pref_response') === 'fail-slow',
  searchParams.get('ai_default_model_pref_response') === 'fail-slow',
  searchParams.get('ai_slot_save_response') === 'slow'
    || searchParams.get('ai_slot_save_response') === 'fail-slow',
  searchParams.get('ai_slot_save_response') === 'fail-slow',
  searchParams.get('ai_slot_clear_response') === 'slow'
    || searchParams.get('ai_slot_clear_response') === 'fail-slow',
  searchParams.get('ai_slot_clear_response') === 'fail-slow',
  searchParams.get('ai_embeddings_save_response') === 'slow'
    || searchParams.get('ai_embeddings_save_response') === 'fail-slow',
  searchParams.get('ai_embeddings_save_response') === 'fail-slow',
  searchParams.get('ai_embeddings_clear_response') === 'slow'
    || searchParams.get('ai_embeddings_clear_response') === 'fail-slow',
  searchParams.get('ai_embeddings_clear_response') === 'fail-slow',
  searchParams.get('ai_pool_toggle_response') === 'slow'
    || searchParams.get('ai_pool_toggle_response') === 'fail-slow',
  searchParams.get('ai_pool_toggle_response') === 'fail-slow',
  searchParams.get('ai_pool_add_response') === 'slow'
    || searchParams.get('ai_pool_add_response') === 'fail-slow',
  searchParams.get('ai_pool_add_response') === 'fail-slow',
  searchParams.get('ai_pool_remove_response') === 'slow'
    || searchParams.get('ai_pool_remove_response') === 'fail-slow',
  searchParams.get('ai_pool_remove_response') === 'fail-slow',
  searchParams.get('ai_budget_save_response') === 'slow'
    || searchParams.get('ai_budget_save_response') === 'fail-slow',
  searchParams.get('ai_budget_save_response') === 'fail-slow',
  searchParams.get('ai_prompt_save_response') === 'slow'
    || searchParams.get('ai_prompt_save_response') === 'fail-slow',
  searchParams.get('ai_prompt_save_response') === 'fail-slow',
  searchParams.get('ai_policy_response') === 'slow'
    || searchParams.get('ai_policy_response') === 'fail-slow',
  searchParams.get('ai_policy_response') === 'fail-slow',
  searchParams.get('ai_catalog_mode_response') === 'slow'
    || searchParams.get('ai_catalog_mode_response') === 'fail-slow',
  searchParams.get('ai_catalog_mode_response') === 'fail-slow',
  searchParams.get('chat_session_open_response') === 'slow'
    || searchParams.get('chat_session_open_response') === 'fail-slow',
  searchParams.get('chat_session_open_response') === 'fail-slow',
  searchParams.get('recipes') === 'related-autorun',
  searchParams.get('recipe_config_set_response') === 'slow'
    || searchParams.get('recipe_config_set_response') === 'fail-once-slow-retry',
  searchParams.get('recipe_config_set_response') === 'fail-once-slow-retry'
    ? 1
    : 0,
  searchParams.get('collection_list_response') === 'fail-twice-slow-retry'
    ? 2
    : searchParams.get('collection_list_response') === 'fail-once-slow-retry'
      ? 1
      : 0,
  searchParams.get('collection_list_response') === 'fail-once-slow-retry'
    || searchParams.get('collection_list_response') === 'fail-twice-slow-retry',
  searchParams.get('collection_get_response') === 'fail-thrice-slow-retry'
    ? 3
    : searchParams.get('collection_get_response') === 'fail-twice-slow-retry'
      ? 2
      : searchParams.get('collection_get_response') === 'fail-once-slow-retry'
        ? 1
        : 0,
  searchParams.get('collection_get_response') === 'fail-once-slow-retry'
    || searchParams.get('collection_get_response') === 'fail-twice-slow-retry'
    || searchParams.get('collection_get_response') === 'fail-thrice-slow-retry',
  searchParams.get('logs_detail_response') === 'fail-once-slow-retry'
    ? 1
    : 0,
  searchParams.get('logs_detail_response') === 'fail-once-slow-retry',
  searchParams.get('automation') === 'dishes',
  searchParams.get('automation_history_response') === 'fail-once-slow-retry'
    ? 1
    : 0,
  searchParams.get('automation_history_response') === 'fail-once-slow-retry',
  searchParams.get('run_palette') === 'inventory-retry' ? 1 : 0,
  searchParams.get('run_palette') === 'inventory-retry',
  searchParams.get('updates') === 'ready'
    || searchParams.get('updates') === 'fail-once-slow-retry'
    || searchParams.get('updates') === 'available-slow-apply',
  searchParams.get('updates') === 'fail-once-slow-retry',
  searchParams.get('updates') === 'available-slow-apply',
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
          : HARNESS_SERVER_PUBLIC_KEY,
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
            releaseRpcResponses: (method) => transport.releaseRpcResponses(method),
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
        releaseRpcResponses: (method) => transport.releaseRpcResponses(method),
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
          pairSubmitCount: () => pairSubmitCount,
          lastPairingCode: () => lastPairingCode,
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
            enableReachabilityProbe: true,
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
            enableReachabilityProbe: true,
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
          enableReachabilityProbe: true,
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
        releaseRpcResponses: (method) => transport.releaseRpcResponses(method),
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
      enableReachabilityProbe: true,
      enableDevicesPage: searchParams.get('devices') === 'ready'
        || searchParams.get('devices') === 'fail-once-slow-retry'
        || searchParams.get('devices') === 'fail-twice-slow-retry',
      ...(searchParams.get('devices') === 'ready'
        || searchParams.get('devices') === 'fail-once-slow-retry'
        || searchParams.get('devices') === 'fail-twice-slow-retry'
        ? { currentInstanceId: 'device-current' }
        : {}),
      ...(accountDemo ? { accountBindingFetch: accountDemoFetch } : {}),
      ...(slowBrowserClearDemo
        ? { cryptoKeysWiper: browserClearCryptoKeysWiper }
        : {}),
      ...(learningDraftHandoffRecoveryDemo
        ? { draftStashStorage: learningDraftStashStorage }
        : {}),
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
      releaseRpcResponses: (method) => transport.releaseRpcResponses(method),
      fireState: (state) => transport.fireState(state),
      fireMessage: (message) => transport.fireMessage(message),
      ...(accountDemo
        ? {
            accountSignOutCount: () => accountDemoSignOutCalls,
            accountSessionReadCount: () => accountDemoSessionCalls,
          }
        : {}),
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
