/** Server-side ingredient executor for headless recipe execution.
 *
 *  Wires the ingredient dispatch layer with adapters that work in Node:
 *  - HTTP: full support (fetch is global in Node 18+)
 *  - MCP: full support (JSON-RPC over HTTP)
 *  - LLM: full support when BYOK API keys are configured
 *  - DOM: unsupported (no browser) — throws INGREDIENT_ADAPTER_ALL_FAILED
 *  - Chat: unsupported (no browser) — throws INGREDIENT_ADAPTER_ALL_FAILED
 *
 *  Vault resolution:
 *  Server-side vault is populated from two sources, merged over the encrypted
 *  VaultStore (highest priority first):
 *  1. Per-request overrides (vault field in POST /execute body)
 *  2. Environment variables: RECUED_VAULT_{key}=value
 *
 *  There is no vault-file source. `--vault-file` was specified to carry
 *  publisher-scoped credentials at startup -- the one thing env cannot express,
 *  since a variable name is a single flat token -- but it was never implemented
 *  and no argument parser reads it. `mergeVault`'s first parameter is still
 *  named `fileVault` from that design; both production call sites pass the
 *  VaultStore-loaded credentials into it.
 */

import { IngredientError, createConnectionAdapter, createConnectionApiHandler, createConnectionMcpHandler, createConnectionNotificationHandler, createIngredientExecutor, createKernelAdapter, executeHTTP, executeMCP, withIngredientCache } from '@recued/ingredients';
import type { ConnectionAdapterDeps, ConnectionAdapterStore, ConnectionApiHandlerDeps, ConnectionAuditEmission, ConnectionMcpHandlerDeps, ConnectionNotificationHandlerDeps, IngredientCacheOptions, IngredientExecutor, Adapter, ResolvedCall } from '@recued/ingredients';
import { createAdapterRegistry } from '@recued/engine';
import { createBridgeDomAdapter } from './bridges/dom-adapter.js';
import {
  executeLLM, createDefaultRegistry, createQuotaTracker,
  executeEmbedding, createDefaultEmbeddingsRegistry, isEmbeddingsManifest, LLMError,
  type ContentPart, type LLMConfig, type QuotaTracker, type TokenUsage,
} from '@recued/llm';
import { tokenUsageToReport } from './chat-token-usage.js';
import type { RunTokenUsageSink } from './run-token-usage.js';
import { isBatchCapableAISlug, isTempFileRef } from '@recued/contracts';
import type { ChunkedUploadAuditInfo, ConnectionKind, ExecutionSource, GatewayCallAudit, TempFileRef, WebChatTab } from '@recued/contracts';
import type { CacheStore } from '@recued/cache';
import type { NamespaceStores } from '@recued/contracts';
import { CONNECTION_GATEWAY_AUDIT_SOURCE, resolveDeep } from '@recued/contracts';
import { readConfinedTempFile } from './execution/run-scratch.js';
import type { ActivityAction, AuditLogStore } from '@recued/storage';
import type { ManifestRegistry } from './manifest-loader.js';
import { asManifestLoader } from './manifest-loader.js';
import type { WsServerHandle } from './ws-server.js';
import { assertPreapprovalOrdinaryRun, currentPreapprovalIo } from './preapproval-io-context.js';
import { describeProcessBinding } from './process-binding-identity.js';
import { preapprovalHash } from './preapproval-invocations.js';
import { buildStdioMcpEnvironment } from './mcp-stdio-spawner.js';
export { resolveLLMConfigFromEnv } from './llm-env.js';
export { resolveVaultFromEnv, mergeVault } from './vault-env.js';

const reviewedMcpDeps = (deps: ConnectionMcpHandlerDeps): ConnectionMcpHandlerDeps => ({
  ...deps,
  beforeConnect: async call => {
    await deps.beforeConnect?.(call);
    assertPreapprovalOrdinaryRun();
    await currentPreapprovalIo()?.validateProvider('mcp', call);
  },
  processIdentity: spec => preapprovalHash([deps.processIdentity?.(spec) ?? null, currentPreapprovalIo()
    ? describeProcessBinding({ ...spec, env: buildStdioMcpEnvironment(spec.env) }) : null]),
  beforeRequest: async call => {
    await deps.beforeRequest?.(call);
    assertPreapprovalOrdinaryRun();
    await currentPreapprovalIo()?.beforeProvider('mcp', call);
  },
});
const reviewedApiDeps = (deps: ConnectionApiHandlerDeps): ConnectionApiHandlerDeps => ({
  ...deps,
  readFileBytes: async recordId => {
    const reviewed = currentPreapprovalIo();
    if (reviewed) {
      const file = await reviewed.readHttpFile(recordId);
      return { bytes: Buffer.from(file.bytes_b64, 'base64'), filename: file.filename, mime_type: file.mime_type };
    }
    if (!deps.readFileBytes) throw new IngredientError('SERVER_NOT_REACHABLE', 'The upload file reader is unavailable.', {});
    return deps.readFileBytes(recordId);
  },
  beforeRequest: async (call, target) => {
    await deps.beforeRequest?.(call, target);
    assertPreapprovalOrdinaryRun();
    await currentPreapprovalIo()?.beforeProvider('http', call, target);
  },
});
const reviewedHttp: Adapter = call => executeHTTP(call,
  async () => { assertPreapprovalOrdinaryRun(); await currentPreapprovalIo()?.beforeProvider('http', call); });

/** D-172 P5 / N.8 — the Gateway-gated `file.read` surface, narrowed to what
 *  the ai-* multimodal overload needs (base64 bytes + MIME + name). The
 *  per-request execute handler (`handleExecute`) supplies an implementation
 *  that composes the run's `data-file-read` admission (the SAME
 *  `(channel × actor × contract_id)` probe a first-class `data-file-read`
 *  ingredient dispatch runs) IN FRONT of the audited `file.read` byte read
 *  (A.8 / I-4) — server-executor never reads the CAS directly, and a
 *  non-admit verdict fails closed (no bytes). The full `FileReadResponse`
 *  (record_id / size / blob_hash) satisfies this structurally. */
export type FileReadFn = (
  record_id: string,
) => Promise<{ bytes_b64: string; mime_type: string; filename: string }>;

export interface ServerExecutorConfig {
  manifests: ManifestRegistry;
  /** Base vault entries from env vars / vault file. */
  vault?: Record<string, unknown>;
  /** LLM configuration (slot_1, optional slot_2, free_pool, etc.). */
  llmConfig?: LLMConfig;
  /** D-174 R28 — per-use LIVE config resolver (from the LLM substrate). When
   *  set, the AI adapter reads config through this at call time (a cheap
   *  decrypted-SQLite read) instead of the boot `llmConfig` snapshot, so a
   *  slot saved after boot — chat OR embeddings — applies without a restart.
   *  Falls back to `llmConfig` when absent (tests / out-of-tree wiring). */
  resolveLlmConfig?: () => LLMConfig | undefined;
  /** Free-pool quota tracker. Long-lived across runs so daily counters +
   *  round-robin cursor persist. Default: in-memory. Inject a persisted
   *  tracker to survive process restarts. */
  llmQuota?: QuotaTracker;
  /** Tab probe for web-chat availability. Default: empty set — the
   *  server does NOT run web-chat by default. See the module header
   *  for the rationale (add a free-pool API key or a BYOK slot instead).
   *  The hook stays injectable for tests / out-of-tree wiring. */
  llmTabProbe?: () => Promise<Set<WebChatTab>>;
  /** Whether this server has a web-chat LLM adapter wired. Default: false.
   *  With the default, `buildAvailability` excludes all web-chat
   *  candidates from match, preflight surfaces "no web-chat on server"
   *  as an actionable issue, and users configure a free-pool key or a
   *  BYOK slot to run AI on schedule. */
  llmWebChatSupported?: boolean;
  /** WebSocket handle — enables chat ingredient delegation to extensions. */
  wsServer?: WsServerHandle;
  /** Token budget check. Returns true if over budget. */
  checkTokenBudget?: (expectedTokens: number) => boolean;
  /** Token usage reporter. Called after each LLM call. */
  onTokenUsage?: (tokens: number) => void;
  /** D-250 § D — run-scoped usage accumulator behind `AuditEntry.total_usage`.
   *
   *  ⛔ SEPARATE FROM `onTokenUsage`, AND THE SPLIT IS THE POINT. That hook
   *  feeds `llm_config`'s daily counter, which exists to answer a hot-path GATE
   *  question (`isOverBudget`) and therefore collapses every call to one
   *  scalar. This one retains the full report per run so the anchor can carry
   *  it. Two jobs, two shapes — fusing them would force the gate to pay for
   *  attribution it never reads, or the anchor to accept a total it cannot
   *  attribute. Both are called for the same provider result. */
  runTokenUsage?: RunTokenUsageSink;
  /** Optional cache store. When set, createBoundExecutor wraps with
   *  withIngredientCache so HTTP/AI/warehouse reads memoize under the
   *  canonical cacheKey format. Omit for tests or ephemeral servers. */
  cacheStore?: CacheStore;
  /** Pair-scoped instance id used as the cache-key salt. Required when
   *  cacheStore is set; ignored otherwise. */
  instanceId?: string;
  /** Optional default cache byte budget. Triggers LRU eviction on write
   *  when the store exceeds this. */
  cacheMaxBytes?: number;
  /** Kernel dispatchers for the D-103 shared-* ingredient family. The
   *  server runtime wires these to direct in-process store calls. Left
   *  undefined → kernel ingredient calls surface SERVER_NOT_REACHABLE. */
  kernelDispatchers?: import('@recued/ingredients').KernelDispatchers;
  /** D-125 P3.1 — connection store reference. The connection adapter
   *  looks up enrolled records at dispatch time via `.get(kind, name)`.
   *  Server passes the SQLite-backed store from `bin.ts`; absent in
   *  dbless harnesses, in which case the registry slot stays at D-126's
   *  kind-named `unsupported('connection')` default and any
   *  `kind: 'connection'` ingredient fails with
   *  `INGREDIENT_ADAPTER_ALL_FAILED` naming the unwired store. (This read
   *  "surfaces `KIND_NOT_YET_IMPLEMENTED` until P4 wires per-kind
   *  handlers" — P4.1/4.2/4.3 all shipped.) */
  connectionStore?: ConnectionAdapterStore;
  /** D-125 P3.2 — audit sink for connection adapter dispatch. When
   *  wired, every adapter call lands one `connection_<kind>` activity
   *  row with the structured detail per `ConnectionAuditDetail`. The
   *  `intent` column is filled from the wrapper manifest's `permission`
   *  field (resolved via the local manifest registry at emission time).
   *  Absent → adapter emits nothing (silent no-op); recipe execution
   *  unaffected. */
  auditLog?: AuditLogStore;
  /** Synchronous, run-local observation of the same host-measured connection
   * telemetry sent to the durable audit log. Used by gated-action settlement
   * to count multi-request acts without trusting provider result JSON. The
   * observer is isolated from dispatch and from the durable audit sink: a
   * throw is swallowed and cannot suppress either one. */
  observeConnectionAudit?: (emission: ConnectionAuditEmission) => void;
  /** D-125 P4.1 — `connection.api` per-kind handler deps. Boot site
   *  (`bin.ts`) closes over `decodeAuthFromStorage` + `encodeAuthForStorage`
   *  + the connection sub-DEK to build `decodeAuth` / `persistAuth`
   *  callbacks. Absent → the api kind stays at the P3.1 placeholder
   *  (`INGREDIENT_ADAPTER_ALL_FAILED` with `kind: 'connection.api'`)
   *  so dbless harnesses + key-uninitialized states surface a clean
   *  diagnostic instead of silently calling out with broken auth. */
  connectionApi?: ConnectionApiHandlerDeps;
  /** D-125 P4.2 — `connection.mcp` per-kind handler deps. Boot site
   *  closes over `decodeAuthFromStorage` + the same connection sub-DEK
   *  used by P4.1. Pool entries scoped per-handler-instance with
   *  `MCP_CLIENT_IDLE_TIMEOUT_MS` reaping. SSE uses Streamable HTTP POST;
   *  websocket and stdio use the injected Node connector/spawner. */
  connectionMcp?: ConnectionMcpHandlerDeps;
  /** D-177 P2b — pre-dispatch gate threaded onto the connection adapter
   *  (`ConnectionAdapterDeps.gateDispatch`). The boot site closes over
   *  the chat MCP-tool annotation store to enforce the per-tool
   *  classification on `connection-mcp-read` / `connection-mcp-write`
   *  kernel dispatches (and to pin their `connection_kind` to `'mcp'`)
   *  at dispatch depth — the engine-side belt-and-suspenders under the
   *  policy verdict, so a recipe binding the slug directly can't
   *  launder a write-classified tool through the read-tier surface.
   *  Absent → no gate (dbless harnesses), matching every other optional
   *  dep here. */
  connectionGateDispatch?: ConnectionAdapterDeps['gateDispatch'];
  /** D-125 P4.3 — `connection.notification` per-kind handler deps. Boot
   *  site closes over `decodeAuthFromStorage` (slack / telegram bearer
   *  token decode) + an `emitInApp` callback wrapping the realtime
   *  `EventBus.emit({ kind: 'notification.notify', ... })` for in-app
   *  delivery. ⚠ It named the bare `'notification'` kind until 2026-09-17, which
   *  NO client subscribes to — the send was counted as delivered and dropped at
   *  the fan-out. P4.3 ships slack / telegram / in-app; email throws
   *  `NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED` until SMTP lands in a
   *  follow-on. Absent → notification kind stays at the P3.1
   *  placeholder (`INGREDIENT_ADAPTER_ALL_FAILED` with
   *  `kind: 'connection.notification'`). */
  connectionNotification?: ConnectionNotificationHandlerDeps;
  /** D-169 P0 follow-on — late-bound bridge dispatcher accessor. When
   *  wired, the executor's `dom` adapter slot consumes
   *  `BridgeDispatcher.dispatch(...)` (via `createBridgeDomAdapter`)
   *  instead of falling through to the registry's default
   *  `unsupported('dom', ...)` placeholder. The accessor is invoked on
   *  every dispatch — the WS server constructs the dispatcher AFTER the
   *  executor is built, so this slot stays callable through the boot
   *  ordering (the boot site publishes the live handle once `attachWebSocket`
   *  returns). Absent → DOM ingredient calls surface `ROLE_RESTRICTION`
   *  on this runtime, matching the pre-D-169 server posture. */
  bridgeDispatcherRef?: () => import('./bridges/dispatcher.js').BridgeDispatcher | undefined;
  /** D-172 P5 / N.8 — Gateway-gated `file.read` for the ai-* multimodal
   *  overload. When wired, a contracted ai-* call whose `llm.data` is a
   *  `data.file` ref (`{ file_ref }` or a resolved file record) has its bytes
   *  fetched through this fn, rendered as a `ContentPart`, and routed to a
   *  modality-capable model. Absent → the overload is inert (a file-ref
   *  `llm.data` is stringified as before — no regression). `handleExecute`
   *  injects this PER-REQUEST (`createBoundExecutor` path): it composes the
   *  run's `data-file-read` admission (reusing the `evaluateAdmission` probe)
   *  in front of the audited byte read, so an actor DENIED `data-file-read`
   *  cannot exfiltrate file bytes via an ai-* `llm.data` (A.8/I-4); raw
   *  `handleFileRead` would bypass the egress gate. The boot config leaves
   *  this unset — the per-request site owns the `(channel × actor ×
   *  contract_id)` context the gate needs. */
  fileRead?: FileReadFn;
}

/** D-125 P3.2 — JSON-encoded shape inside the activity entry's `detail`
 *  field for `connection_<kind>` rows. Consumers parse via
 *  `JSON.parse(entry.detail ?? '{}')` and match on this shape. The
 *  activity entry's `target` carries the connection record `name`; the
 *  `action` carries the kind discriminator (`connection_api` /
 *  `connection_mcp` / `connection_notification`); the `timestamp` is
 *  the call start time so the row sorts by dispatch start, not
 *  emission completion.
 *
 *  `intent` carries the wrapper ingredient's `permission` field —
 *  e.g. `'notification_send'` for `slack-post`, `'hubspot_read'` for
 *  `ticket-reader-hubspot`, `'connection.direct'` for the kernel
 *  direct-access ingredient. Empty string when the manifest declares
 *  no permission (forward-compat — pre-D-125 wrappers haven't been
 *  migrated to declare per-call permissions yet, so the field is
 *  optional in the manifest layer). */
export interface ConnectionAuditDetail {
  subtype?: string;
  status: 'ok' | 'error';
  duration_ms: number;
  bytes_in?: number;
  bytes_out?: number;
  /** SHA-256 of one-shot upload content; bytes are never logged. */
  content_sha256?: string;
  /** D-217 § 6.3 — partial-egress honesty for a MULTI-REQUEST act. Present only
   *  on a chunked upload.
   *
   *  ⛔ A failed upload is not a no-op: a walk that stopped at chunk k already
   *  sent k chunks to a third party. `bytes_out` carries the volume; this
   *  carries the shape around it, without which a reader cannot tell a complete
   *  upload from an abandoned one that moved the same bytes. ⚠ And `outcome` is
   *  what keeps § 8.1 alive past this boundary — `committed` and
   *  `committed_unconfirmed` are both `status: 'ok'`, so the distinction the
   *  poll ruling turns on exists only in this field. */
  chunked_upload?: ChunkedUploadAuditInfo;
  error?: { code: string; message: string };
  intent: string;
  /** D-117 follow-on (post-D-127) — engine-supplied recipe identity.
   *  Mirrors `MailSendAuditDetail.recipe_id` / `step_id`: present when
   *  the adapter received a populated `call.stepMeta`, absent for
   *  direct-rpc callers (Settings → Connections probe, kernel
   *  `connection` invoked via MCP agent, tests). Both fields are either
   *  set together (engine path) or omitted together (direct path). */
  recipe_id?: string;
  step_id?: string;
  /** D-128 P6 — platform-reference enrichment scope this call is
   *  operating against (`connection.api.<vendor>.<entity>` for vendor
   *  reconcilers; closed-list scopes pass through but offer no
   *  forensic value beyond the existing `target` connection-name
   *  field). Stamped by the harness / vendor Ds via
   *  `call.stepMeta.platform_scope`; absent for direct-rpc callers and
   *  recipes that don't operate on a specific enrichment scope. Lets
   *  forensic queries filter `connection_*` rows by data scope —
   *  "every HubSpot deal API call this week" — without joining
   *  recipe_id back through the recipe-row catalogue. */
  platform_scope?: string;
}

const ACTION_FOR_CONNECTION_KIND: Record<ConnectionKind, ActivityAction> = {
  api: 'connection_api',
  mcp: 'connection_mcp',
  notification: 'connection_notification',
};

const newConnectionAuditId = (now: number): string =>
  `cn-${now}-${Math.random().toString(36).slice(2, 8)}`;

/** Build the audit emitter wired into the connection adapter. Closes
 *  over the manifest registry to look up `manifest.permission` for
 *  `intent` at emission time without changing the adapter signature
 *  (the adapter stays storage-dep-free). The lookup tolerates a
 *  missing manifest (e.g. ingredient uninstalled mid-call) by surfacing
 *  empty intent — the row still lands, just without the wrapper
 *  attribution. Emission errors are swallowed by the adapter's own
 *  best-effort try/catch wrapper, so a back-pressured audit log can't
 *  break dispatch.
 *
 *  Exported so tests can pin the translation contract (ConnectionAudit
 *  Emission → ActivityEntry) without spinning up the whole executor. */
export const createConnectionAuditEmitter = (
  manifests: ManifestRegistry,
  auditLog?: AuditLogStore,
  observe?: (emission: ConnectionAuditEmission) => void,
): (emission: ConnectionAuditEmission) => Promise<void> =>
  async (emission) => {
    try {
      observe?.(emission);
    } catch {
      // A projection observer is no more authoritative over dispatch than the
      // audit store. Keep it from suppressing the durable row as well.
    }
    if (auditLog === undefined) return;
    const action = ACTION_FOR_CONNECTION_KIND[emission.kind];
    const manifest = manifests.get(emission.slug);
    const intent = (manifest as { permission?: string } | undefined)?.permission ?? '';
    // Empty strings on `recipe_id` / `step_id` are treated as absent so
    // a half-populated stepMeta from a malformed engine call doesn't
    // pollute the audit row with `""` values that would later look
    // queryable but never match.
    const recipe_id =
      typeof emission.recipe_id === 'string' && emission.recipe_id.length > 0
        ? emission.recipe_id
        : undefined;
    const step_id =
      typeof emission.step_id === 'string' && emission.step_id.length > 0
        ? emission.step_id
        : undefined;
    // D-128 P6 — platform_scope mirrors the recipe_id / step_id
    // empty-string-as-absent convention so a half-populated stepMeta
    // doesn't leave queryable-but-never-matching `""` values on the
    // audit row. Vendor reconcilers (D-129+) populate; direct-rpc
    // callers leave absent.
    const platform_scope =
      typeof emission.platform_scope === 'string' && emission.platform_scope.length > 0
        ? emission.platform_scope
        : undefined;
    const detail: ConnectionAuditDetail = {
      ...(emission.subtype !== undefined ? { subtype: emission.subtype } : {}),
      status: emission.status,
      duration_ms: emission.duration_ms,
      ...(emission.bytes_in !== undefined ? { bytes_in: emission.bytes_in } : {}),
      ...(emission.bytes_out !== undefined ? { bytes_out: emission.bytes_out } : {}),
      ...(emission.content_sha256 !== undefined
        ? { content_sha256: emission.content_sha256 }
        : {}),
      ...(emission.chunked_upload !== undefined
        ? { chunked_upload: emission.chunked_upload }
        : {}),
      ...(emission.error !== undefined ? { error: emission.error } : {}),
      intent,
      ...(recipe_id !== undefined ? { recipe_id } : {}),
      ...(step_id !== undefined ? { step_id } : {}),
      ...(platform_scope !== undefined ? { platform_scope } : {}),
    };
    await auditLog.logActivity({
      activity_id: newConnectionAuditId(emission.ts),
      timestamp: emission.ts,
      action,
      target: emission.name,
      detail: JSON.stringify(detail),
    });
  };

/** D-165 P0 — JSON-encoded `detail` shape for `connection_gateway`
 *  activity rows. The activity entry's `target` carries the connection
 *  record `name`; `action` is `connection_gateway`; `timestamp` is the
 *  emission time. `source` is the constant `'connection.gateway'`
 *  provenance the spec mandates; the remaining fields are the resolved
 *  (catalog-derived) operation policy from `GatewayCallAudit`. */
export interface ConnectionGatewayAuditDetail {
  source: typeof CONNECTION_GATEWAY_AUDIT_SOURCE;
  ingredient_id: string;
  operation_id: string;
  operation_group: string | null;
  risk_tier: string;
  approval: string;
  /** D-211 §2 — present when a stored owner-override `approval` was below-floor
   *  at resolve — a hand-stored row, or an rpc-legal ingredient-wide ruling
   *  clamped per-op — and the resolver clamped it fail-closed AT the floor:
   *  carries the stored (below-floor) value so the Runs surface can warn.
   *  Carried verbatim from `GatewayCallAudit`. */
  approval_clamped_from?: string;
  outcome: 'success' | 'failed';
  surface_kind?: string;
  approval_id?: string;
  failure_mode?: string;
  duration_ms?: number;
  recipe_id?: string;
  step_id?: string;
  /** D-182 §6/§10 step 7 — op-level audit identity, carried verbatim from the
   *  `GatewayCallAudit` event into the DURABLE row. Present whether or not a
   *  recipe was the origin: a raw op the LLM calls without a recipe (§8) lands
   *  one of these rows with `recipe_id` / `step_id` ABSENT and `origin_unit_id`
   *  / `execution_source` carrying the recipe-independent attribution +
   *  grouping. No synthetic recipe is fabricated — the row is op-level by
   *  construction (`action: 'connection_gateway'`, `target: connection_name`).
   *  Absent on dispatch paths that wire no source onto `ExecutionContext`. */
  execution_source?: ExecutionSource;
  origin_unit_id?: string;
  canonical_arg_hash?: string;
  /** D-165 P3.path-picker (Slice 3b) — present ONLY on a
   *  `path_scope_violation` outcome: the connection's canonical sub-resource
   *  path, the call's canonical target path, the template, and the
   *  `checkPathScope` reason. Carried verbatim from `GatewayCallAudit.path_-
   *  scope` so the DURABLE row holds the forensic detail the spec mandates
   *  (D-165:933`), not just the in-memory event. */
  path_scope?: GatewayCallAudit['path_scope'];
}

const newGatewayAuditId = (now: number): string =>
  `gw-${now}-${Math.random().toString(36).slice(2, 8)}`;

/** Build the gateway audit sink wired into the engine's
 *  `ExecutionContext.onGatewayCall` (D-165 P0, Invariant 5). Translates a
 *  `GatewayCallAudit` into one `connection_gateway` activity row carrying
 *  `source: 'connection.gateway'` + the resolved operation policy. The
 *  engine wraps every catalog-form call's success / failure / gate-deny in
 *  a call to this sink. Fire-and-forget: `logActivity` rejections are
 *  swallowed so a back-pressured audit log can't break a recipe run (the
 *  engine's own `onGatewayCall` guard already swallows synchronous
 *  throws). Exported so tests can pin the `GatewayCallAudit → ActivityEntry`
 *  translation without spinning up the whole handler. */
export const createGatewayAuditEmitter = (
  auditLog: AuditLogStore,
  now: () => number = Date.now,
): ((event: GatewayCallAudit) => void) =>
  (event) => {
    const ts = now();
    const detail: ConnectionGatewayAuditDetail = {
      source: CONNECTION_GATEWAY_AUDIT_SOURCE,
      ingredient_id: event.ingredient_id,
      operation_id: event.operation_id,
      operation_group: event.operation_group,
      risk_tier: event.risk_tier,
      approval: event.approval,
      // D-211 §2 — fire-and-forget like every sibling field (hot path): the
      // fail-closed clamp marker rides the same best-effort emit.
      ...(event.approval_clamped_from !== undefined
        ? { approval_clamped_from: event.approval_clamped_from }
        : {}),
      outcome: event.outcome,
      ...(event.surface_kind !== undefined ? { surface_kind: event.surface_kind } : {}),
      ...(event.approval_id !== undefined ? { approval_id: event.approval_id } : {}),
      ...(event.failure_mode !== undefined ? { failure_mode: event.failure_mode } : {}),
      ...(event.duration_ms !== undefined ? { duration_ms: event.duration_ms } : {}),
      ...(event.recipe_id !== undefined ? { recipe_id: event.recipe_id } : {}),
      ...(event.step_id !== undefined ? { step_id: event.step_id } : {}),
      // D-182 §6/§10 step 7 — carry the op-level audit identity into the DURABLE
      // row so a recipe-less raw-op call is attributable (execution_source) +
      // groupable (origin_unit_id) without a recipe.
      ...(event.execution_source !== undefined ? { execution_source: event.execution_source } : {}),
      ...(event.origin_unit_id !== undefined ? { origin_unit_id: event.origin_unit_id } : {}),
      ...(event.canonical_arg_hash !== undefined ? { canonical_arg_hash: event.canonical_arg_hash } : {}),
      // D-165 P3.path-picker (Slice 3b) — carry the path-scope forensic detail
      // into the DURABLE row (only set on a `path_scope_violation`).
      ...(event.path_scope !== undefined ? { path_scope: event.path_scope } : {}),
    };
    void auditLog
      .logActivity({
        activity_id: newGatewayAuditId(ts),
        timestamp: ts,
        action: 'connection_gateway',
        target: event.connection_name,
        detail: JSON.stringify(detail),
      })
      .catch(() => {
        /* audit back-pressure never breaks dispatch */
      });
  };

/** D-172 P5 — derive the `data.file` record id from an ai-* `llm.data` value.
 *  Two accepted shapes: an explicit `{ file_ref: '<record_id>' }` wrapper, or
 *  a resolved `data.file` record — identified by a `record_id` PLUS a
 *  file-specific storage marker (`storage_ref` or `blob_hash`). The storage
 *  marker is load-bearing: mail / calendar / contact records also carry
 *  `record_id` + `hot_fields`, so keying on `hot_fields` alone would
 *  mis-detect a resolved non-file record as a file and (once `fileRead` is
 *  wired) break those existing ai-* recipes. Anything else (a string, an
 *  array, a non-file record) is NOT a file ref → null (text path unchanged). */
export const extractFileRecordId = (data: unknown): string | null => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.file_ref === 'string' && d.file_ref.length > 0) return d.file_ref;
  if (
    typeof d.record_id === 'string'
    && d.record_id.length > 0
    && (d.storage_ref !== undefined || typeof d.blob_hash === 'string')
  ) {
    return d.record_id;
  }
  return null;
};

/** D-185 Slice 2 — narrow an ai-* `llm.data` to a `temp` file ref (a prior
 *  `storage:'temp'` cli op's run-scoped output, e.g. an ffmpeg-extracted audio
 *  fed straight to an audio-capable model). The ASYMMETRIC union means
 *  `extractFileRecordId` returns null for a `temp` object (its `file_ref` is not
 *  a string) — so the CAS `data-file-read` admission probe in `execute-handler`
 *  never fires for a `temp` ref, which is correct: a `temp` ref carries no
 *  Gateway `file.read` gate (the producing op was already gated, D-185 §3.2).
 *  The read is instead confined to the producing run's scratch root. Anything
 *  not a `temp` ref → null (the CAS / text paths are unchanged). */
export const extractTempFileRef = (data: unknown): TempFileRef | null => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const fileRef = (data as Record<string, unknown>).file_ref;
  return isTempFileRef(fileRef) ? fileRef : null;
};

/** D-172 P5 — map a `file.read` result to a provider-neutral `ContentPart`.
 *  `media_class` follows N.1: image/* → image, audio/* → audio, else
 *  document. */
export const fileToContentPart = (file: { bytes_b64: string; mime_type: string }): ContentPart => {
  const mime = file.mime_type && file.mime_type.length > 0 ? file.mime_type : 'application/octet-stream';
  const type: ContentPart['type'] = mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('audio/')
      ? 'audio'
      : 'document';
  return { type, source: { kind: 'base64', media_type: mime, data: file.bytes_b64 } };
};

/** D-172 P5 / N.8 — resolve an ai-* `llm.data` file ref into multimodal
 *  content parts. Returns a rewritten input carrying `llm.content_parts` (the
 *  media) + a textual `llm.data` placeholder (so the contracted prompt
 *  builder has its required field and the model gets a human-readable hint).
 *  No-op (returns the input unchanged) when: the slug doesn't take a single
 *  `llm.data` (only the batch-capable contracted set qualifies — `ai-compare`
 *  / `ai-prompt` route their payload elsewhere), the caller already supplied
 *  `llm.content_parts`, or `llm.data` is not a file ref. The byte read goes
 *  through the Gateway-gated `fileRead` (A.8/I-4) — never the CAS directly.
 *  Exported for unit testing. */
export const resolveAiFileRef = async (
  slug: string,
  input: Record<string, unknown>,
  fileRead?: FileReadFn,
  run_id?: string,
): Promise<Record<string, unknown>> => {
  if (!isBatchCapableAISlug(slug)) return input;
  if (input['llm.content_parts'] !== undefined) return input;
  // D-185 Slice 2 — a `temp` ref resolves UNCONDITIONALLY (no Gateway file.read
  // gate; the producing op was already gated, §3.2), confined to THIS run's
  // scratch root so a hand-crafted `{ backing:'temp', path }` can't escape it.
  // Checked BEFORE the CAS branch so it works even when the gated `fileRead` is
  // unwired (an ungated channel).
  const temp = extractTempFileRef(input['llm.data']);
  if (temp) {
    const file = readConfinedTempFile(temp, run_id ?? '');
    const part = fileToContentPart(file);
    return {
      ...input,
      'llm.data': `[${part.type}: ${file.filename}]`,
      'llm.content_parts': [part],
    };
  }
  // CAS ref — needs the Gateway-gated `fileRead` (A.8/I-4); inert without it.
  if (!fileRead) return input;
  const recordId = extractFileRecordId(input['llm.data']);
  if (!recordId) return input;
  const file = await fileRead(recordId);
  const part = fileToContentPart(file);
  return {
    ...input,
    'llm.data': `[${part.type}: ${file.filename}]`,
    'llm.content_parts': [part],
  };
};

/** Build an LLM adapter that conforms to the Adapter signature.
 *  Re-loads the manifest from the registry since executeLLM needs it
 *  for slug-based routing (contracted vs uncontracted prompts).
 *
 *  The server uses the default adapter registry — anthropic / openai /
 *  openai-compatible / google. Scheduled/headless AI on the server routes
 *  through a free-pool API key or a BYOK slot. */
const createLLMAdapter = (
  manifests: ManifestRegistry,
  llmConfig: LLMConfig | undefined,
  quota: QuotaTracker,
  tabProbe: () => Promise<Set<WebChatTab>>,
  webChatSupported: boolean,
  checkBudget?: (expected: number) => boolean,
  reportUsage?: (tokens: number) => void,
  fileRead?: FileReadFn,
  resolveLlmConfig?: () => LLMConfig | undefined,
  runTokenUsage?: RunTokenUsageSink,
): Adapter => {
  const adapters = createDefaultRegistry();
  const embeddingsAdapters = createDefaultEmbeddingsRegistry();
  return async (resolved) => {
    // D-250 § D — ONE sink for both consumers of a provider result, so a future
    // call path cannot wire the budget counter and forget the anchor (or the
    // reverse). The two branches are independent: either may be unwired.
    // ⚠ `run_id` comes off `stepMeta`, which `prefetch.ts` / `step-runner.ts`
    // populate from `ctx.run_id`. A dispatcher that supplies no run id records
    // nothing — the sink drops it rather than bucketing it under a shared key.
    const emitUsage = (usage: TokenUsage): void => {
      reportUsage?.(usage.total_tokens);
      const run_id = resolved.stepMeta?.run_id;
      if (runTokenUsage !== undefined && run_id !== undefined) {
        runTokenUsage.record(run_id, tokenUsageToReport(usage));
      }
    };
    // Budget enforcement
    if (checkBudget) {
      const hint = (resolved.input['llm.model_hint'] as string) ?? 'quality';
      const expected = hint === 'fast' ? 4000 : 8000;
      if (checkBudget(expected)) {
        throw new Error('AI_TOKEN_BUDGET_EXCEEDED: Daily token budget exhausted. Increase budget via `recued llm budget <tokens>` or wait until tomorrow.');
      }
    }
    const manifest = manifests.get(resolved.slug);
    if (!manifest) {
      throw new Error(`LLM adapter: no manifest found for slug '${resolved.slug}'`);
    }
    // D-174 R28 — resolve config PER-USE (a cheap decrypted-SQLite read) so a
    // slot saved after boot applies without a restart; fall back to the boot
    // snapshot when no resolver is wired (tests / out-of-tree). One adapter
    // serves every `kind:'ai'` ingredient, so it gates here when nothing is
    // configured rather than at boot.
    const config = resolveLlmConfig?.() ?? llmConfig;
    if (!config) {
      throw new LLMError(
        'AI_LLM_UNAVAILABLE',
        'No LLM configured. Set up a model in Settings → AI/Models.',
      );
    }
    // D-174 R28 — embeddings ingredients (`kind:'ai'` + `output.vector`, e.g.
    // `ai-embed`) route to the embeddings executor, NOT the chat executor.
    // Branch BEFORE the chat-only file-ref / PII-match logic — embeddings takes
    // the raw text `llm.data`. The vector is returned to the recipe as the step
    // output; the housekeeping `data_enrichment_vector_index` sidecar is a
    // separate path.
    if (isEmbeddingsManifest(manifest)) {
      return executeEmbedding(manifest, resolved.input, {
        config,
        adapters: embeddingsAdapters,
        quota,
        onTokenUsage: emitUsage,
      });
    }
    // D-172 P5 / N.8 — when an ai-* `llm.data` is a `data.file` (CAS) ref and
    // the boot site wired a Gateway-gated `file.read`, resolve it to multimodal
    // content parts before the call. D-185 Slice 2 — a `temp` ref resolves here
    // too (confined to the run's scratch root) EVEN WITHOUT a wired `fileRead`.
    // Inert (input unchanged) when llm.data is not a file ref — no regression on
    // text calls.
    const reviewed = currentPreapprovalIo();
    const input = await resolveAiFileRef(
      resolved.slug,
      resolved.input,
      reviewed ? recordId => reviewed.readAiFile(recordId) : fileRead,
      resolved.stepMeta?.run_id,
    );
    return executeLLM(manifest, input, {
      config,
      adapters,
      quota,
      tabProbe,
      webChatSupported,
      onTokenUsage: emitUsage,
      ...(reviewed ? { matchContext: () => ({ pinSlot: reviewed.aiSlot() }) } : {}),
      beforeComplete: async (request: import('@recued/llm').LLMProviderInvocation) => {
        assertPreapprovalOrdinaryRun(); await reviewed?.beforeAiProvider(resolved, request);
      },
    });
  };
};

/** Default tab-probe — empty. The server doesn't run web-chat; match
 *  uses the pool or BYOK slots instead. Callers that want to revive
 *  the delegation path can inject their own `llmTabProbe`. */
const emptyTabProbe = async (): Promise<Set<WebChatTab>> => new Set();

/** Load vault entries from a JSON file. Top-level object with string values.
 *  Supports nested scoping: { "recued-core": { "hubspot_token": "..." } }. */
export const loadVaultFile = (path: string): Record<string, unknown> => {
  const { readFileSync } = require('node:fs');
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
};

/** Create the server-side ingredient executor.
 *  Returns a function matching the IngredientExecutor signature that
 *  the engine expects. */
/** Build a chat adapter that delegates to a connected extension via WebSocket.
 *  Uses the broadcast → claim → confirm → execute protocol. */
const createChatDelegationAdapter = (wsServer: WsServerHandle): Adapter =>
  async (resolved: ResolvedCall) => wsServer.delegateChat(resolved.slug, resolved.input);

export const createServerExecutor = (
  config: ServerExecutorConfig,
): IngredientExecutor => {
  // Server runtime adapter set: HTTP + MCP universal, AI when LLM
  // slot wired, chat delegated via WS when an extension is paired.
  // DOM omitted — server has no browser. Unsupported kinds get
  // INGREDIENT_ADAPTER_ALL_FAILED placeholders from the factory.
  const adapterRegistry = createAdapterRegistry({
    http: reviewedHttp,
    mcp: executeMCP,
    // D-174 R28 — always wire the AI adapter; it resolves config PER-USE
    // (`resolveLlmConfig`) and surfaces AI_LLM_UNAVAILABLE when nothing is
    // configured, rather than gating on a boot `slot_1` snapshot (which never
    // saw a post-boot slot, and excluded embeddings-only configs entirely).
    ai: createLLMAdapter(
      config.manifests,
      config.llmConfig,
      config.llmQuota ?? createQuotaTracker(),
      config.llmTabProbe ?? emptyTabProbe,
      config.llmWebChatSupported ?? false,
      config.checkTokenBudget,
      config.onTokenUsage,
      config.fileRead,
      config.resolveLlmConfig,
      config.runTokenUsage,
    ),
    chat: config.wsServer ? createChatDelegationAdapter(config.wsServer) : undefined,
    // D-169 P0 follow-on — DOM-ingredient runner consumer. Materialises
    // the `dom` adapter slot when the WS layer has wired a bridge
    // dispatcher accessor. Without `bridgeDispatcherRef`, the slot stays
    // at the registry's default `unsupported('dom', ...)` placeholder
    // (`INGREDIENT_ADAPTER_ALL_FAILED` for kind: 'dom') matching the
    // pre-D-169 server posture. The accessor is invoked per dispatch
    // so the late-bound dispatcher handle from `createWebSocketUpgrade`
    // is picked up after the executor has been built.
    dom: config.bridgeDispatcherRef
      ? createBridgeDomAdapter({
          manifests: config.manifests,
          getDispatcher: config.bridgeDispatcherRef,
        })
      : undefined,
    // D-125 P3.1 — connection adapter shell. Per-kind handlers (api /
    // mcp / notification) ship in P4.x; absent handlers throw
    // `INGREDIENT_ADAPTER_ALL_FAILED` with `kind: 'connection.<kind>'`
    // at dispatch time. Skipping the slot when no store is wired keeps
    // D-126's kind-named `unsupported('connection')` default in place for
    // dbless harnesses — INGREDIENT_ADAPTER_ALL_FAILED naming the unwired
    // store, NOT a "not yet shipped" claim. P3/P4.x all shipped.
    //
    // D-125 P3.2 — `auditLog` (when wired) feeds the per-dispatch
    // emitter that lands one `connection_<kind>` activity row per call.
    // The emitter resolves `intent` from `manifests.get(slug).permission`
    // at emission time (no contract change to ResolvedCall). Audit
    // sink failures are swallowed by the adapter's try/catch — back-
    // pressure can't break recipe runs.
    connection: config.connectionStore
      ? createConnectionAdapter({
          store: config.connectionStore,
          ...(config.auditLog || config.observeConnectionAudit
            ? {
                emitAudit: createConnectionAuditEmitter(
                  config.manifests,
                  config.auditLog,
                  config.observeConnectionAudit,
                ),
              }
            : {}),
          // D-177 P2b — per-tool classification gate for the kernel
          // connection-mcp-{read,write} dispatch surfaces (no-op for
          // every other slug; absent in dbless harnesses).
          ...(config.connectionGateDispatch
            ? { gateDispatch: config.connectionGateDispatch }
            : {}),
          // D-125 P4.1 (api) + P4.2 (mcp) + P4.3 (notification). Each
          // handler is wired only when the boot site supplies its
          // deps; absent deps leave the kind at P3.1's placeholder
          // (clean `INGREDIENT_ADAPTER_ALL_FAILED`).
          handlers: {
            ...(config.connectionApi
              ? { api: createConnectionApiHandler(reviewedApiDeps(config.connectionApi)) }
              : {}),
            ...(config.connectionMcp
              ? { mcp: createConnectionMcpHandler(reviewedMcpDeps(config.connectionMcp)) }
              : {}),
            ...(config.connectionNotification
              ? { notification: createConnectionNotificationHandler(config.connectionNotification) }
              : {}),
          },
        })
      : undefined,
  });
  const kernelAdapter = config.kernelDispatchers
    ? createKernelAdapter(config.kernelDispatchers)
    : undefined;

  return createIngredientExecutor({
    manifestLoader: asManifestLoader(config.manifests),
    adapterRegistry,
    kernelAdapter,
    resolveRefs: undefined,
  });
};

/** Create namespace stores for a single execution.
 *  The `resolveRefs` function is wired into the executor's dispatch layer
 *  so vault/config/context references in ingredient inputs get resolved. */
export const createNamespaceStores = (
  vault: Record<string, unknown>,
  config: Record<string, unknown>,
  context: Record<string, unknown>,
): NamespaceStores => ({
  vault,
  config,
  context,
  meta: {},
  step: {},
});

/** Create an ingredient executor with ref resolution bound to specific stores.
 *  This wraps the base executor to resolve {{vault.*}}, {{config.*}} etc.
 *  in ingredient inputs before they're dispatched to adapters.
 *
 *  When config.cacheStore is set, the returned executor is additionally
 *  wrapped with withIngredientCache using the pair-scoped instance id.
 *  Category + risk_tier policy from derivePolicy determines what gets
 *  memoized; action/write/admin/destructive are bypassed. */
export const createBoundExecutor = (
  config: ServerExecutorConfig,
  stores: NamespaceStores,
  recipeContext?: { recipe_id: string; recipe_ttl: number },
  /** D-145 engine-wiring slice 3b.3 — `withIngredientCache` `onStatus`
   *  observer. Forwarded straight into the L1 ingredient cache so the
   *  commit Gateway can flag an L1-hit commit `cached`. Only consumed
   *  on the cache-enabled branch below (cacheStore + instanceId +
   *  recipeContext all set); ignored otherwise. */
  onCacheStatus?: IngredientCacheOptions['onStatus'],
): IngredientExecutor => {
  // D-103 Phase A: bound executor must also register the kernel adapter
  // when the server wires in-process shared-store dispatchers. Without
  // this, recipes invoked via handleExecute (MCP / rpc / scheduler) hit
  // `INGREDIENT_ADAPTER_ALL_FAILED` on any shared-* step — even though
  // the non-bound createServerExecutor path works fine.
  const adapterRegistry = createAdapterRegistry({
    http: reviewedHttp,
    mcp: executeMCP,
    // D-174 R28 — always wire the AI adapter (per-use config resolution); see
    // createServerExecutor for the rationale.
    ai: createLLMAdapter(
      config.manifests,
      config.llmConfig,
      config.llmQuota ?? createQuotaTracker(),
      config.llmTabProbe ?? emptyTabProbe,
      config.llmWebChatSupported ?? false,
      config.checkTokenBudget,
      config.onTokenUsage,
      config.fileRead,
      config.resolveLlmConfig,
      config.runTokenUsage,
    ),
    chat: config.wsServer ? createChatDelegationAdapter(config.wsServer) : undefined,
    // D-169 P0 follow-on — DOM-ingredient runner consumer. Materialises
    // the `dom` adapter slot when the WS layer has wired a bridge
    // dispatcher accessor. Without `bridgeDispatcherRef`, the slot stays
    // at the registry's default `unsupported('dom', ...)` placeholder
    // (`INGREDIENT_ADAPTER_ALL_FAILED` for kind: 'dom') matching the
    // pre-D-169 server posture. The accessor is invoked per dispatch
    // so the late-bound dispatcher handle from `createWebSocketUpgrade`
    // is picked up after the executor has been built.
    dom: config.bridgeDispatcherRef
      ? createBridgeDomAdapter({
          manifests: config.manifests,
          getDispatcher: config.bridgeDispatcherRef,
        })
      : undefined,
    // D-125 P3.1 — connection adapter shell. Per-kind handlers (api /
    // mcp / notification) ship in P4.x; absent handlers throw
    // `INGREDIENT_ADAPTER_ALL_FAILED` with `kind: 'connection.<kind>'`
    // at dispatch time. Skipping the slot when no store is wired keeps
    // D-126's kind-named `unsupported('connection')` default in place for
    // dbless harnesses — INGREDIENT_ADAPTER_ALL_FAILED naming the unwired
    // store, NOT a "not yet shipped" claim. P3/P4.x all shipped.
    //
    // D-125 P3.2 — `auditLog` (when wired) feeds the per-dispatch
    // emitter that lands one `connection_<kind>` activity row per call.
    // The emitter resolves `intent` from `manifests.get(slug).permission`
    // at emission time (no contract change to ResolvedCall). Audit
    // sink failures are swallowed by the adapter's try/catch — back-
    // pressure can't break recipe runs.
    connection: config.connectionStore
      ? createConnectionAdapter({
          store: config.connectionStore,
          ...(config.auditLog || config.observeConnectionAudit
            ? {
                emitAudit: createConnectionAuditEmitter(
                  config.manifests,
                  config.auditLog,
                  config.observeConnectionAudit,
                ),
              }
            : {}),
          // D-177 P2b — per-tool classification gate for the kernel
          // connection-mcp-{read,write} dispatch surfaces (no-op for
          // every other slug; absent in dbless harnesses).
          ...(config.connectionGateDispatch
            ? { gateDispatch: config.connectionGateDispatch }
            : {}),
          // D-125 P4.1 (api) + P4.2 (mcp) + P4.3 (notification). Each
          // handler is wired only when the boot site supplies its
          // deps; absent deps leave the kind at P3.1's placeholder
          // (clean `INGREDIENT_ADAPTER_ALL_FAILED`).
          handlers: {
            ...(config.connectionApi
              ? { api: createConnectionApiHandler(reviewedApiDeps(config.connectionApi)) }
              : {}),
            ...(config.connectionMcp
              ? { mcp: createConnectionMcpHandler(reviewedMcpDeps(config.connectionMcp)) }
              : {}),
            ...(config.connectionNotification
              ? { notification: createConnectionNotificationHandler(config.connectionNotification) }
              : {}),
          },
        })
      : undefined,
  });
  const kernelAdapter = config.kernelDispatchers
    ? createKernelAdapter(config.kernelDispatchers)
    : undefined;

  const resolveRefs = (obj: Record<string, unknown>) => resolveDeep(obj, stores) as Record<string, unknown>;

  const raw = createIngredientExecutor({
    manifestLoader: asManifestLoader(config.manifests),
    adapterRegistry,
    kernelAdapter,
    resolveRefs,
  });

  if (!config.cacheStore || !config.instanceId || !recipeContext) {
    return raw;
  }

  return withIngredientCache(raw, {
    manifestLoader: async (slug) => config.manifests.get(slug) ?? null,
    store: config.cacheStore,
    recipe_ttl: recipeContext.recipe_ttl,
    recipe_id: recipeContext.recipe_id,
    // D-103: cache key no longer includes instance_id.
    max_bytes: config.cacheMaxBytes,
    resolveRefs,
    // D-145 engine-wiring slice 3b.3 — surface L1 cache hits to the
    // commit Gateway. Conditional spread keeps the option absent when
    // no observer is wired (the cache wrapper's own default).
    ...(onCacheStatus ? { onStatus: onCacheStatus } : {}),
  });
};
