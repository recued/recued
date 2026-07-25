/** Recipe execution handler for the headless server.
 *
 *  POST /execute accepts a recipe (by id or inline) + context, runs
 *  the engine's executeRecipe, and returns the ExecutionResult.
 *
 *  This is the core of recued-server: headless recipe execution
 *  without a browser. HTTP + MCP + LLM ingredients work; DOM + Chat
 *  ingredients will fail with INGREDIENT_ADAPTER_ALL_FAILED.
 */

import { randomUUID } from 'node:crypto';
import { connectionBaseUrlFromConfig } from './connection-base-url.js';
import {
  executeRecipe,
  deriveRunMode,
  assignOwnSafe,
  snapshotContextRecipe,
  type CatalogGrantCall,
  type CatalogGrantMintCall,
  type CatalogSessionGrantHooks,
  type CliInvocationExecutor,
  type ExecutionContext,
  type IngredientExecutor,
  type SharedResolvers,
} from '@recued/engine';
import {
  wrapWithCommitGateway,
  PreflightDeniedError,
  deriveChannelSessionId,
  createCorrelationTracker,
  evaluatePreflightAdmission,
  raiseOnAsk,
  raisePreflightAsk,
  raisePreflightNotify,
  detectTornSaga,
  raiseSagaAsk,
  raisePickAsk,
  type CommitRunIdentity,
  type PreflightAskContext,
  type PreflightNotifier,
  type SagaCompensationPlanRef,
  type SagaNotifier,
  type PickNotifier,
  type SessionGrantGateCall,
  type SessionGrantMintGateCall,
} from '@recued/gateway';
import { isReceptionOriginSource } from './reception-inbox-handler.js';
import type { ReceptionInboxFanoutMode } from '@recued/contracts';
import type {
  AdmissionDecision,
  LaneGovernor,
  OpDurationClassifier,
  QualityDelegationMatchContext,
  QualityGateSwitches,
} from '@recued/contracts';
import { derivePolicy } from '@recued/cache';
import type { SellerCustomerAccessAdmissionStore } from './seller/customer-access-admission.js';
import {
  DIRECT_MCP_TOOL_CALL_BASE_RESERVATION_KEY,
  type CustomerSurfaceUsageSession,
} from './seller/customer-surface-usage.js';
import type {
  Channel,
  Checkpoint,
  ContainerPickDetail,
  CreatePlanDetail,
  Dish,
  EmittedLink,
  RecipeDefinition,
  RecipeError,
  RecipeStep,
  RunDegradation,
  ScanFn,
  ScopedSenderCandidate,
} from '@recued/contracts';
import {
  isContainerPickDetail,
  isCreatePlanDetail,
  collectOperationAuthorityPaths,
  admitByOpRiskWithoutQualityLifts,
  CONTRACTED_DEFAULT_TRUST_CEILING,
  operationPathTemplate,
  deriveDispatchScope,
  computeOpenProjection,
  deriveHeavyOpErrorCategory,
  deriveRunTermination,
  executionSourceContractId,
  executionSourceHasContract,
  isDoorDispatchSource,
  isAIBatchMode,
  isBatchCapableAISlug,
  isCanonicalOpStep,
  isCatalogForm,
  isOwnerDefaultOnlyEntry,
  isOpenProjectionRefusal,
  isOutboundSendSlug,
  kernelOpForBackingSlug,
  originProvenanceFromOptionalSource,
  runAttentionForTriggerSource,
  resolveDeep,
  resolveSessionGrantOffer,
  readOwnerOperationOverride,
  resolveValue,
  RpcError,
  SESSION_GRANT_RISK_TIERS,
  WIRE_AUTHORITY_ARG_PATHS,
  type HandlerSlice,
  type RiskTier,
  type ServerRpcRegistry,
} from '@recued/contracts';
import { ephemeralDishId } from '@recued/contracts';
import { emitRunOutcome, originTriggerIdFromContext } from './run-outcome-events.js';
import type { DishStore } from './dish-store.js';
import type { DishContextStore } from './dish-context-store.js';
import type { InFlightRegistry } from './execution/in-flight-registry.js';
import { cleanupRunScratch } from './execution/run-scratch.js';
import { mergeManifestStepInput } from '@recued/ingredients';
import {
  applyKernelOpRunnability,
  deriveCompensation,
  flattenRecipe,
  hashRecipe,
  serializeFlattenedInsight,
} from '@recued/recipes';
import {
  buildAuditEntry,
  newRunId,
  type AuditLogStore,
  type CheckpointStore,
  type CommitStore,
} from '@recued/storage';
import { stampExecuteResponseAuditRun } from './types.js';
import type {
  ExecuteRequest,
  ExecuteResponse,
  InternalExecuteOverrides,
} from './types.js';
import {
  gateRecipeAgainstPolicy,
  renderPolicyGateDenialSummary,
  type PolicyGateDenial,
} from './policy-gate.js';
import { applyAutoPiiForExecution } from './auto-pii-apply.js';
// D-157 Part C — held-action idempotency. Collapse a re-sent identical
// action onto an existing live hold (no second checkpoint + ask + pending
// write) so an agent loop that resends a held action is harmless.
import {
  awaitInflightHold,
  buildHeldConfigSnapshot,
  buildHeldResponseForRecipe,
  buildHeldTwinResponse,
  claimInflightHold,
  computeHeldActionKey,
  findLiveHeldTwin,
  HELD_DEDUP_CHANNELS,
  type HeldActionIdentity,
  type InflightHoldClaim,
} from './held-action-idempotency.js';
// D-172 P2 (review F2) — the secondary op gated when a `mail-send` carries
// attachments. The per-call admission probe evaluates this slug against the
// same policy cell as the mail-send dispatch, so reading file content out of
// the warehouse via an attachment is policy-gated identically to a first-class
// `data-file-read` ingredient dispatch.
import { DATA_FILE_READ_INGREDIENT_SLUG } from './collections/file/file-read-handler.js';
import { getOrCreateRecipeInsight } from './memory-schema.js';
import { insertLinks } from './memory-links.js';
import type { EventBus } from './events/bus.js';
import {
  emitExecution,
  emitMemoryAudit,
  emitMemoryInsight,
  emitMemoryLink,
} from './events/emit-sites.js';
import type { RecipeStore } from './recipe-store.js';
import type { FileReadFn, ServerExecutorConfig } from './server-executor.js';
import { createBoundExecutor, createGatewayAuditEmitter, createNamespaceStores, extractFileRecordId, mergeVault } from './server-executor.js';
import { createCliInvocationExecutor } from './cli-invocation-executor.js';
import type { ConnectionOperationProfileStore } from './connection-operation-profile.js';
import { resolveCanonicalRecipeForDispatch } from './dispatch-canonical-resolve.js';
import { assertRunTargets } from './targeting-guard.js';
import { buildPickAskInputForSlot, derivePickCandidates } from './pick-candidates.js';
import {
  raiseContainerPickAsk,
  type ContainerPickAskInput,
  type ContainerPickNotifier,
} from './work-entity-container-pick.js';
import {
  raiseCreatePlanAsk,
  type CreatePlanAskInput,
  type CreatePlanNotifier,
} from './work-entity-create-plan.js';
import { buildPackOpResolution } from './pack-inventory.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import {
  deriveBoundConventionFamilies,
  liveVendorRegistry,
} from './connection-convention-families.js';
import type { LocalManifestStore } from './ingredient-authoring/local-manifest-store.js';
import type { OpAdmissionGate } from './op-admission-gate.js';
import { canCreateNewContainerForActor } from './work-entity-write-executor.js';
import type { ContractOverlayResolver } from './policy-contract-overlay.js';
import type { QualityGateResolver } from './quality-gate-resolver.js';
import type { SessionGrantResolver } from './session-grant-resolver.js';
import type { BatchApprovalCoordinator } from './batch-approval.js';
import type { ApprovalResumeAuthorityResolver } from './approval-resume-authority.js';
import {
  buildCommitRunIdentity,
  cacheAwareGatewayInner,
  observeCacheStatus,
} from './commit-gateway-wiring.js';
import type { SharedStore } from './storage/shared-store.js';
import type { AnnotationStore } from './storage/annotation-store.js';
import type { ContactStore } from './storage/contact-store.js';
import type { EnrichmentStore } from './storage/enrichment-store.js';
import { createEnrichmentReader } from './storage/enrichment-resolver.js';
import { createStoredRowOriginResolver } from './stored-root-origin.js';
import type { WsClient } from './ws-server.js';

/** D-153 P2.C — closed set of system-actor channels whose dispatch
 *  path runs through the Engine-boundary policy gate. The first slice
 *  wired `schedule` (scheduler.ts producer); the second wired
 *  `reactive` (auto-run-scheduler.ts producer). All entries here are
 *  `actor: 'system'` channels — no `ContractSnapshot` required because
 *  system actors don't operate under a contract (spec line 391: "no
 *  human or agent presence at dispatch time"). Adding a new
 *  system-actor channel here is one set-entry plus a channel-shaped
 *  `ExecutionSource` at the producer site. */
const POLICY_GATED_SYSTEM_CHANNELS: ReadonlySet<Channel> = new Set([
  'schedule',
  'reactive',
]);

/** D-177 P5b (N.11, codex HIGH fold) — the channels on which `context.event`
 *  is a TRUSTED system-stamped trigger payload (clean origin in the
 *  open-projection walk). These are the server-driven FIRE channels: the
 *  warehouse-bus reactive dispatcher (`triggers/dispatcher.ts`), the
 *  scheduler, the webhook receiver, and idle housekeeping all build the run's
 *  `context.event` from server state, never from model/caller input. Every
 *  other channel (chat / mcp / user / messenger / reception) populates the
 *  same `request.context` from the CALLER — so a `context.event` root there
 *  is model-controlled and must NOT be classed clean (it refuses open and
 *  falls back to the full-payload-pinned exact grant). Today's v1 only seeds
 *  the `('chat','user_self')` offer cell, so open is chat-minted only; this
 *  set makes the gate correct ahead of the non-chat-seed follow-on (N.6). */
const TRUSTED_EVENT_CONTEXT_CHANNELS: ReadonlySet<Channel> = new Set([
  'reactive',
  'schedule',
  'webhook',
  'housekeeping',
]);

const CLI_INVOCATION_EXECUTOR = createCliInvocationExecutor();

// D-182 §8 step 7 — exported so the recipe-less raw-op dispatch
// (`raw-op-dispatch.ts`) resolves a connection's REST base URL identically to
// the recipe catalog-gate path (single source of truth — no divergence).
// D-192 H4 — moved to `./connection-base-url.js` so the Source-sync deps
// composers can resolve the per-connection base URL without a runtime import of
// this large module. Re-exported here for the existing `raw-op-dispatch` importer.
export { connectionBaseUrlFromConfig };

/** D-153 P2.C — closed set of user-actor channels whose dispatch path
 *  runs through the Engine-boundary policy gate under `actor:
 *  'user_self'` (a self-restricted `user_self` — one carrying a
 *  `contract_id`, D-161 N.3 — flows through the same gate, narrowed by
 *  its contract).
 *
 *  Per-cell baselines in `packages/contracts/src/policy-matrix.ts`:
 *    - `(user, user_self)` (line 332): `ALL_KINDS × ALL_RISK_TIERS` —
 *      the user driving their own client. Most permissive cell;
 *      approval only on `destructive` (approval is a separate substrate
 *      check via `requiresApproval`, not the admission gate here).
 *      Adding `'user'` here is observational gating that mostly threads
 *      the source through to the policy gate — the only behavioral
 *      change is the gate's fail-closed posture on missing manifests
 *      (a recipe referencing an unknown ingredient now hard-fails with
 *      `RECIPE_POLICY_DENIED` instead of failing inside `executeRecipe`).
 *      Audit-row persistence of `execution_source` landed separately
 *      in D-145 engine-wiring slice 2 (`AuditEntry.execution_source`).
 *    - `(chat, user_self)` (line 354): admits `read | write | admin`
 *      and hard-denies `destructive` (chat sentences shouldn't be able
 *      to nuke things; Settings → Destructive UI is the only authorised
 *      path).
 *    - `(messenger, user_self)` deliberately mirrors `(chat, user_self)`
 *      ("user sending themselves a command via Slack / Telegram",
 *      policy-matrix.ts) — same admitted tiers, so the flip from the
 *      chat-shaped disguise to the real source changed WHICH cell gates
 *      a messenger dispatch (a store-edited messenger lockdown now
 *      applies), not what the baseline admits.
 *
 *  Like the system set, no `ContractSnapshot` is required — `user_self`
 *  doesn't operate under a contract (spec line 408). The gate runs
 *  against the baseline `(channel × actor)` cell only.
 *
 *  Fifth P2.C slice wired `chat` (chat-orchestrator.ts producer →
 *  registry → chat-tool-handlers' `buildExecuteRequest`); sixth slice
 *  wires `user` (rpc-handler producer below — `makeExecuteHandlers`
 *  resolves the channel-shaped source from the connected `WsClient`).
 *  The messenger execution-source threading slice wires `messenger`:
 *  the D-160 messenger turn driver threads the channel-minted
 *  `(messenger × user_self)` inbound source through `runChatTurn` →
 *  `dispatchTool` → `buildInternalDispatchCtx`, so its Tier 1/2
 *  dispatches arrive here as themselves — previously they rode the
 *  chat-shaped internal ctx and were gated (and session-granted) as
 *  chat. A messenger source that is NOT in this set would skip the
 *  gate entirely (audited-but-ungated — the D-177 P2b failure shape),
 *  which is why the set membership lands in the SAME change as the
 *  producer flip. `(messenger, contracted_user)` stays fail-closed
 *  (FAIL_CLOSED_CELL; no producer mints it today). */
const POLICY_GATED_USER_CHANNELS: ReadonlySet<Channel> = new Set([
  'chat',
  'user',
  'messenger',
]);

/** D-153 P2.C — local-owner fallback identifier for the rpc-driven
 *  `user` ExecutionSource. Recued's `project_single_user_warehouse_-
 *  invariant` (one server == one human identity) means the connected
 *  client's `user_id` is a constant when the client hasn't reported
 *  one via `register`. Multi-tenant deployments would replace this
 *  with the authenticated principal. Mirrors the `LOCAL_CHAT_USER_ID`
 *  + `STDIO_MCP_*` constants in the chat orchestrator + mcp-server. */
const LOCAL_RPC_USER_ID = 'local';

/** D-153 P2.C — fallback `client_token_id` for legacy WS connections.
 *  D-148 § A.2.1 populates `WsClient.client_token_id` from the
 *  structured `<token_id>.<bearer>` upgrade path; pre-A.2.1 raw-bearer
 *  connections leave it undefined. Falls through to `instance_id`
 *  (always present post-register) before this constant — `'unregistered'`
 *  marks the rare pre-register dispatch state for audit traceability. */
const UNREGISTERED_CLIENT_TOKEN_ID = 'unregistered';

/** D-153 P2.C — build the channel-shaped `ExecutionSource` for an
 *  rpc-driven `user` dispatch (the `execute` rpc method below).
 *  Mirrors the chat orchestrator's `buildChatExecutionSource` for the
 *  rpc surface: `actor: 'user_self'` (the local owner driving their
 *  own client). No `ContractSnapshot` is paired because this
 *  unrestricted `'user_self'` carries no `contract_id` (a self-
 *  restricted `user_self` would — D-161 N.4; that path lands with the
 *  full contracts substrate, open question #21). Source identifiers
 *  fall through gracefully so unregistered / legacy clients still
 *  produce an inspectable source. */
const buildRpcUserExecutionSource = (
  client: WsClient,
): import('@recued/contracts').ExecutionSource => ({
  channel: 'user',
  actor: 'user_self',
  user_id: client.user_id ?? LOCAL_RPC_USER_ID,
  client_token_id:
    client.client_token_id ?? client.instance_id ?? UNREGISTERED_CLIENT_TOKEN_ID,
});

/** D-153 P2.C — closed set of contract-bearing channels whose
 *  dispatch path runs through the Engine-boundary policy gate. Each
 *  channel here MUST carry a `ContractSnapshot` on the
 *  `ExecuteRequest` (spec line 429: "every commit with a
 *  contract-scoped actor MUST carry a `contract_snapshot` field");
 *  the producer resolves the snapshot before dispatch.
 *
 *  `mcp` covers all four mcp wire dispatch sites: legacy
 *  `recued_runRecipe` + `recued_ingredient_*` (mcp-server.ts producers,
 *  third P2.C slice), plus registry-routed Tier 1 `recipe.run` + Tier 2
 *  `<publisher>/<recipe_id>` (mcp-server.ts wire boundary → chat-tool-
 *  handlers' `buildExecuteRequest`, fourth P2.C slice). All four paths
 *  share one `(channel: 'mcp', actor: 'contracted_user')` cell.
 *
 *  `reception` covers both D-207 door runners — `reception-recipe-runner.ts`
 *  (the paired submit/drain dispatch) and `reception-manage-runner.ts` (the
 *  on-the-go reschedule). Both already resolved a `ContractSnapshot` and
 *  passed it on the `ExecuteRequest`; only this set entry was missing, so
 *  `evaluateAdmission` resolved to `undefined` and the ONLY call site of
 *  `evaluatePreflightAdmission` — i.e. the D-207 `allowed_tools` allowlist AND
 *  the D-209 trust ceiling — never ran for a paired reception recipe's plain
 *  `{ingredient: …}` steps. Catalog / `op:` steps were unaffected (they gate
 *  unconditionally via `runCatalogOperation`), which is why the core packs
 *  held and the hole stayed invisible: an owner-authored recipe calling a
 *  kernel slug (`mail-send`, `shared-write`, `contact-upsert`) dispatched
 *  ungated, on an anonymous visitor's request. Found by the D-210 code audit
 *  2026-07-20 (finding 1) and proven A/B — the same ungranted `write` step was
 *  refused on `mcp` and executed silently on `reception`.
 *
 *  ⛔ THE DEFERRAL BELOW IS WHAT MADE THIS A BYPASS RATHER THAN A TODO. This
 *  comment used to name `reception` among the channels that "wire in follow-on
 *  slices" — and D-207, D-209 and D-210 were each designed, ratified and built
 *  on the assumption that follow-on had landed. A documented deferral reads as
 *  *handled* to everyone downstream. Any channel named below is UNGATED TODAY;
 *  treat the list as open findings, not as documentation.
 *
 *  `webhook` (D-209 #1 W3) is the SECOND door found in the same state, by
 *  tracing the reception fix's own "who else?" question. `webhook-recipe-runner.ts`
 *  already resolved a `ContractSnapshot` (`buildWebhookContractSnapshot`) and
 *  passed it to `handleExecute`, under a comment asserting that "a contract-bearing
 *  source with no snapshot THROWS at the policy/preflight gates" — behaviour that
 *  never ran, because the channel was in no set. A vendor's POST could therefore
 *  drive a plain `{ingredient: …}` step outside the door's `allowed_tools`, and a
 *  REVOKED door denied nothing. Proven A/B before the fix: the same ungranted
 *  `write` returned `success: true` with the step dispatched.
 *
 *  ⚠ Safe to turn on for a channel whose snapshot is CONDITIONAL: the runner
 *  builds one only when the source carries a `contract_id`, and
 *  `evaluatePreflightAdmission` throws only when `executionSourceHasContract`.
 *  A door-less source (unstamped trigger row) therefore cannot be broken by the
 *  gate switching on — and since the gate did not run AT ALL before, adding a
 *  channel here is neutral-or-stricter by construction, never looser.
 *
 *  Still deferred: `chat` / `messenger` / `user` with `contracted_*` actors —
 *  their producer sites do not resolve `ContractSnapshot`s yet. As with the
 *  messenger slice, membership MUST land in the same change as the producer
 *  flip: a contract-bearing source outside this set skips the gate entirely
 *  (audited-but-ungated — the D-177 P2b failure shape), while one inside it
 *  with no snapshot THROWS at `evaluatePreflightAdmission`.
 *
 *  ⏭ `bridge` needs nothing: it has NO producer minting a `bridge`-channel
 *  `ExecutionSource`. `housekeeping` is handled by its own source-less branch
 *  below and deliberately passes no `execution_source` at all. Those two were
 *  checked when `webhook` was, so this list is now believed complete for
 *  channels that actually produce contract-bearing dispatches. */
const POLICY_GATED_CONTRACT_CHANNELS: ReadonlySet<Channel> = new Set([
  'mcp',
  'reception',
  'webhook',
]);

/** D-172 P2 (review F2 finding A) — true iff a `mail-send` `attachments`
 *  input is attachment-bearing, mirroring EXACTLY what the kernel
 *  `mail-send` case forwards to `MailCollection.send`. The kernel coerces
 *  `attachments` via `coerceStringArray`
 *  (`packages/ingredients/src/kernel.ts`), which accepts a SINGLE STRING
 *  (→ `[string]`) as well as a `string[]`; an empty / absent value is then
 *  dropped (the kernel only forwards when `attachments.length > 0`). So the
 *  F2 secondary `data-file-read` probe must fire for a non-empty STRING or a
 *  non-empty ARRAY — keying on `Array.isArray` alone would let a string
 *  attachment (`attachments: 'file:abc'`) skip the gate and read file bytes
 *  ungated. Element-type checks are deliberately omitted here: `coerceStringArray`
 *  raises `BAD_INPUT` on non-string entries downstream, so a malformed array
 *  never reaches `handleFileRead` — over-matching to "non-empty array" is the
 *  safe (fail-closed-leaning) side. */
const hasMailSendAttachment = (attachments: unknown): boolean =>
  (typeof attachments === 'string' && attachments.length > 0)
  || (Array.isArray(attachments) && attachments.length > 0);

type RunObservabilityWrite =
  | 'audit_append'
  | 'audit_degraded_marker'
  | 'provenance_links';

const serializeLogError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
};

const recordRunDegradation = (
  degraded: RunDegradation[],
  reason: RunDegradation,
): RunDegradation[] => {
  if (!degraded.includes(reason)) degraded.push(reason);
  return [...degraded];
};

const logRunObservabilityWriteFailure = (opts: {
  run_id: string;
  failed_write: RunObservabilityWrite;
  degraded: RunDegradation;
  all_degraded: readonly RunDegradation[];
  error: unknown;
}): void => {
  console.error('[execute-handler] run observability write failed', {
    run_id: opts.run_id,
    failed_write: opts.failed_write,
    degraded: opts.degraded,
    all_degraded: [...opts.all_degraded],
    error: serializeLogError(opts.error),
  });
};

/** D-145 engine-wiring (D-153 P1) — process-lived correlation tracker.
 *  One instance per server process: the ~1-min intent-burst heuristic
 *  has to observe successive `handleExecute` calls to group them, so
 *  the tracker cannot be per-request. Keyed by `channel_session_id`.
 *  Exposed on `_testing` for suite reset. See `createCorrelationTracker`. */
const correlationTracker = createCorrelationTracker();

/** D-145 engine-wiring (D-153 P1 + slice 2) — the commit-substrate
 *  fields the engine derives once per run and stamps on every
 *  audit/commit row the run writes (the success path + the
 *  policy-gate-denial path). `cognition_session_id` is absent by
 *  construction — cognition is pluggable + DEFAULT DISABLED, so a
 *  recipe run opens no cognition window. Slice 2 adds the full
 *  `execution_source` alongside its derived `channel_session_id`:
 *  run-level by construction (one dispatch origin per run), so it is
 *  coherent on the coarse recipe-run row. `commit_kind` is NOT here —
 *  it is per-tool-call and stays undefined on the recipe-run row until
 *  the Gateway dispatch-outbox writes real per-call commits (a later
 *  slice); see D-153 open question #23. */
type CommitSubstrateFields = {
  channel_session_id?: string;
  correlation_id?: string;
  contract_snapshot?: import('@recued/contracts').ContractSnapshot;
  execution_source?: import('@recued/contracts').ExecutionSource;
};

export interface ExecuteHandlerDeps {
  recipeStore: RecipeStore;
  executorConfig: ServerExecutorConfig;
  /** D-181 Slice 2 — the server's singleton two-lane long-op governor. When
   *  provided, the engine acquires a `local-heavy` / `external-io` slot before
   *  each heavy ingredient call (fast-path / ai calls bypass). Omitted ⇒ the
   *  engine's no-op governor ⇒ unbounded heavy concurrency (pre-D-181 behaviour). */
  laneGovernor?: LaneGovernor;
  /** D-181 §10 — the duration-threshold classifier. Threaded onto the engine ctx
   *  so `resolveCallClass` demotes a proven-fast (< 5s) op off the lane and
   *  `invokeGoverned` records each successful call's duration. Omitted ⇒ no
   *  demotion (kind-only classification — pre-§10 behaviour). */
  opDurationClassifier?: OpDurationClassifier;
  /** D-181 slice 4 — the server's in-flight execution registry. When provided
   *  (alongside an `execution_source`), the handler registers the run on start
   *  so it appears on the live active-list (`execution.active`), passes a
   *  per-run abort signal into the engine so the owner can kill it, and reads
   *  the registry's termination marker to stamp the audit anchor `killed` /
   *  flag a `cancelled_before_dispatch`. Omitted ⇒ no live-control surface. */
  inFlightRegistry?: InFlightRegistry;
  /** D-181 slice 4 — the cli-invocation executor to run `kind: service`
   *  catalog subprocess ops with. When provided (the boot path passes one wired
   *  to the in-flight registry, so a running subprocess registers its SIGKILL
   *  handle), it replaces the module-default executor. Omitted (tests) ⇒ the
   *  registry-unaware module singleton — no external kill handle. */
  cliInvocationExecutor?: CliInvocationExecutor;
  /** SMB-finance slice 3 — server-side CAS-ingest sink for a `response_capture`
   *  REST download (storage-gdrive `file.download`). Threaded onto the engine
   *  ctx so the catalog gateway can land the captured body and return a
   *  `file_ref`. Omitted ⇒ a `response_capture` op fails closed
   *  (`no_file_ingestor`). */
  ingestFileDownload?: ExecutionContext['ingestFileDownload'];
  /** D-201 Slice 6B3 — server-only operation-bound callback resolver. The
   *  catalog gateway invokes it only for an operation carrying the trusted
   *  logical-binding declaration; absent means those operations fail closed. */
  operationBoundWebhook?: ExecutionContext['operationBoundWebhook'];
  /** Base vault (from env vars + vault file). Per-request vault
   *  overrides are merged on top. */
  baseVault: Record<string, unknown>;
  /** Server's own instance_id for audit attribution. */
  instanceId?: string;
  /** Server's display name — surfaces as `context.server.name` so
   *  recipes can render it. Optional; falls back to `'recued'`. */
  serverName?: string;
  /** Audit log store. When provided, every execution appends a
   *  redacted audit entry (same format as the extension). */
  auditLog?: AuditLogStore;
  /** Durable `data.shared.*` store (D-103 Phase A). When provided,
   *  recipes referencing `{{data.shared.X}}` pre-fetch through here
   *  via the engine's shared-prefetch resolver. */
  sharedStore?: SharedStore;
  /** D-179 P1 — standing-dish store. When provided, a request carrying
   *  `dish_id` resolves the dish and merges its `config_overlay` OVER
   *  install config before dispatch (dish → install → defaults).
   *  Absent ⇒ `dish_id` requests fail closed (`not_configured`). */
  dishStore?: DishStore;
  /** D-179 P3 — dish-group overlay inheritance. When the bound dish
   *  carries `group_id`, the group's shared `config_overlay` merges
   *  UNDER the dish's own (dish → group → install → defaults). A
   *  dangling `group_id` (manual DB edit — delete detaches) degrades
   *  to no group layer. */
  dishGroupStore?: Pick<import('./dish-group-store.js').DishGroupStore, 'get'>;
  /** D-179 P1 — per-dish `context.recipe.*` continuity snapshots.
   *  Read before dispatch / written at run end for STANDING dishes
   *  only; ephemeral (manual, no `dish_id`) runs carry no continuity. */
  dishContextStore?: DishContextStore;
  /** D-172 P2 follow-up — annotation/link read store for recipe-mode
   *  inline refs such as `{{data.contact.<email>.links.attachment}}`.
   *  Optional so dbless, scheduler-only, and test compositions keep the
   *  prefetcher's existing no-op behavior when no resolver host exists. */
  annotationStore?: AnnotationStore;
  /** D-177 N.11 rule 1 — contact store for the open-projection walk's
   *  per-row stored-cleanliness gate (`createStoredRowOriginResolver`).
   *  Optional: absent ⇒ contact-record roots stay `'stored'` (tainted →
   *  pinned), the pre-follow-on behavior. */
  contactStore?: ContactStore;
  /** D-120 Phase 3 — raw SQLite handle for `recipe_insights` lookup
   *  + `links` writes. When omitted, link emission is skipped (test
   *  / no-DB modes). When present, the handler resolves the
   *  recipe's surrogate insight id pre-execution, buffers
   *  `EmittedLink`s through the engine's `linkSink`, and bulk-
   *  inserts them post-audit-append against the same `run_id`. */
  db?: import('better-sqlite3').Database;
  /** D-121 Phase 6 — realtime broadcast bus. When provided the
   *  handler stamps execution lifecycle (`start` / `complete` /
   *  `error`) + memory (`audit` / `insight` / `link`) events for
   *  subscribed clients. Bus emits are best-effort and never abort
   *  the run; absent → no realtime events emit (engine + audit log
   *  still work). */
  eventBus?: EventBus;
  /** D-179 P4 — warehouse event bus, emit side only. When provided
   *  the handler emits `run.<recipe_id>.<dish_id>.<completed|failed>`
   *  run-outcome events at terminal outcome (see
   *  `run-outcome-events.ts` for the suppression list: backfill
   *  runs, trigger skips, durable pauses). Absent → no outcome
   *  events; run behavior unchanged. */
  warehouseBus?: Pick<import('@recued/warehouse-events').WarehouseEventBus, 'emit'>;
  /** D-125 P6.2 — warehouse-resident enrichment store. When provided
   *  the engine wires `readEnrichmentRow` into every transform
   *  context so `enrichment-or-fetch` can short-circuit through the
   *  cache before falling through to a fetch. Absent → the transform
   *  returns `source: 'no_runtime'` and recipes flow to fallback. */
  enrichmentStore?: EnrichmentStore;
  /** D-165 P0 — per-connection operation-profile store (LOCAL-ONLY).
   *  When provided, catalog-form ingredient calls resolve their grants +
   *  risk/approval overrides through here at dispatch
   *  (`connectionProfileResolver`). Absent → catalog-form calls fail
   *  closed (`no_connection_profile` deny; operations default OFF). The
   *  P1 OAuth pilot seeds it; the full `contract.*` substrate is P2+. */
  connectionOperationProfiles?: ConnectionOperationProfileStore;
  /** D-182 §7.2 — the engine's `cliReachabilityResolver` (pre-built in the boot
   *  composer from the local `contract.*` store). The AUTHORITATIVE `cli`
   *  authorization source (increment 3): a `cli` catalog op authorizes against
   *  this per-(principal × cli-ingredient × risk_tier) allowlist, NOT a
   *  connection profile, so a connection-less by-value cli pack never reaches
   *  `no_connection_profile`. Absent (dbless / unit) ⇒ every cli op fails closed
   *  `cli_reachability_disabled` (reachability defaults OFF — Invariant 3).
   *  Forwarded straight onto the engine ctx. */
  cliReachabilityResolver?: ExecutionContext['cliReachabilityResolver'];
  /** D-182 §8 door-cli authorization path — the cli ingredient slugs a given
   *  reachability PRINCIPAL (a door's `contract_id`, or the owner) has an
   *  `allowed: true` §7.2 grant for, at ANY risk tier. Consumed ONLY by the MCP
   *  snapshot builder (`buildMcpContractSnapshot`); the engine never reads it.
   *
   *  Why it exists: a `cli` ingredient is §8-fenced from raw door exposure, so it
   *  is ungrantable as a `recued_ingredient_<slug>` MCP tool and never enters a
   *  door's per-token grants → never enters `allowed_tools`. A recipe a door
   *  TRIGGERS may still run the binary internally, but the policy gate denies it
   *  `tool_not_in_contract` before the catalog-gateway's per-risk-tier
   *  reachability resolver ever runs. The snapshot unions the principal's granted
   *  cli slugs into `allowed_tools` so a granted door clears the policy gate; the
   *  resolver then enforces the EXACT op risk tier (stricter — a coarse slug-level
   *  admit here can only get the step to the gateway, never past it). The raw
   *  direct call stays refused by the unconditional dispatch backstop. Built in
   *  the boot composer from the SAME `contract.*` store the resolver + grid rpc
   *  use, so the three views can never diverge. Absent (dbless / unit) ⇒ no union
   *  (the unbound owner already admits every slug). */
  cliReachableSlugsForPrincipal?: (principal: string) => ReadonlyArray<string>;
  /** D-165 P3.path-picker (Slice 3b) — the connection-RECORD store, read at
   *  dispatch for a catalog operation's `subresource_path` (the permission
   *  boundary the gateway's `path_scope` enforcement checks the call's target
   *  against, via the engine's `connectionSubresourcePathResolver`). Distinct
   *  from `connectionOperationProfiles`, which carries grant state —
   *  `subresource_path` is a connection-record attribute, so it is resolved off
   *  this store at call time (always fresh). Absent (dbless / unit) ⇒ no
   *  resolver wired ⇒ `checkPathScope` treats every connection as whole-account
   *  (`/`), i.e. path scope is inert until the store is present. */
  connectionStore?: ConnectionStoreSqlite;
  /** D-166 Slice 4d.4 — `contract.*` scan callback (a thin adapter over the
   *  local-only `ContractStore.scan`, built by the composer via
   *  `createContractScanFn`). Threaded onto the engine ctx as `contractScan`,
   *  where the catalog gateway uses it + the run's `actor` to TIGHTEN a catalog
   *  operation's resolution with the user's `contract.override` rows (restrict
   *  only — deny / escalate approval). Absent ⇒ no override layer; the
   *  connection-keyed profile floor stands unchanged (dbless / unit paths). */
  contractScan?: ScanFn;
  /** D-166 contract_definition — the contract-overlay use-resolution resolver
   *  (`createContractOverlayResolver`, built from the same local-only contract
   *  store as `contractScan`). The static `gateRecipeAgainstPolicy` pre-run walk +
   *  the per-call preflight probe gate the `(channel × actor × contract)`
   *  `.<contract_id>` overlay on `isContractActive(now)` + `contractScopeMatches`,
   *  and the gateway's actual-proceed point `recordUse`s an active in-scope contract
   *  once per boundary-crossing dispatch (the `recordDispatchUse` seam). Absent ⇒ no
   *  overlay layer (baseline+snapshot decision stands — additive, exactly as before
   *  a contract is minted). */
  contractOverlay?: ContractOverlayResolver;
  /** D-196 seller-customer admission store. Fresh MCP dispatch composes this at
   *  the HTTP transport; execute deps also carry it so approval-resumed raw MCP
   *  ops re-check customer expiry/grace/status before dispatching a held write. */
  sellerCustomerAdmissionStore?: SellerCustomerAccessAdmissionStore;
  /** D-196 direct-MCP request-local usage session. Only the authenticated MCP
   * transport injects it. The commit Gateway claims the idempotent base unit
   * and customer-controlled D-162 extras at the post-approval proceed point;
   * other execution surfaces omit it and cannot inherit direct-MCP accounting. */
  customerUsage?: CustomerSurfaceUsageSession;
  /** D-196 R2 — approval-time snapshots are evidence, never act-time
   * authority. The preflight resumer invokes this immediately before an
   * approved recipe/raw-op can dispatch, replacing the persisted snapshot with
   * one derived from the current bearer, Seller lifecycle/tier, contract,
   * grants, route, and read fence. Production composition wires it whenever a
   * bearer store exists; a bearer-backed resume with no resolver fails closed. */
  approvalResumeAuthority?: ApprovalResumeAuthorityResolver;
  /** D-187 AMENDMENT 3b — the op-admission gate over the unified grant store. The
   *  per-call admit path queries it AFTER the policy decision: a dispatched op the
   *  governing contract holds an explicit `op` REVOKE for is denied (`op_not_granted`),
   *  even when the policy cell + snapshot would admit. This is how the OWNER's own AI
   *  (`(chat | messenger, user_self)` → the owner contract) is gated and how a standing
   *  contract's `scope.operation_ids` folds into `op` grant entries. Absent ⇒ no op gate
   *  (additive — the baseline+snapshot+overlay decision stands). */
  opAdmissionGate?: OpAdmissionGate;
  /** D-177 P2 — the session-grant resolver (`createSessionGrantResolver`,
   *  built from the same local-only contract store). The commit Gateway's
   *  ask-branch matches a paused-worthy dispatch against live
   *  `grant_kind: 'session'` rows for the run's `channel_session_id` (N.4 —
   *  consume, don't merge: the policy verdict is untouched, deny is never
   *  grant-overridden) and consumes one use at the actual-proceed point. The
   *  handler completes the Gateway's per-call envelope with the run's recipe
   *  identity (`recipe_id` + `hashRecipe`). Absent ⇒ no lookup; every `ask`
   *  holds exactly as pre-D-177 (additive — inert until a grant exists). */
  sessionGrantResolver?: SessionGrantResolver;
  /** D-202 task 4a — the QUALITY-delegation resolver (`createQualityGateResolver`,
   *  over the same local-only contract store + the persisted Switch A/B state).
   *  The commit Gateway's ask-branch, AFTER the authorization session-grant lookup
   *  misses, matches the paused-worthy dispatch against live
   *  `grant_kind: 'quality_delegation'` rows for the run's `(recipe, op)` and, when
   *  one matches (un-paused + whole-document), composes the three-conjunct gate to
   *  skip the per-artifact review — captured authorization stays checked every send
   *  (§12.1). The handler completes the Gateway's per-call envelope with the run's
   *  recipe identity (`recipe_id` + `hashRecipe`, reusing the session-grant memo).
   *  Absent ⇒ no quality check; every `ask` holds exactly as pre-D-202 (additive —
   *  inert until the owner mints a quality delegation). */
  qualityGateResolver?: QualityGateResolver;
  /** D-177 N.11 rule 5 (slice D) — the per-channel-session forwarded-sender
   *  candidate lookup (the 5.d hot-path index, built by the chat
   *  orchestrator as user turns are contributed — `chat-forwarded-sender-
   *  index.ts`). The handler's grant hooks pair it with the gateway-extracted
   *  `destination_emails` on both the match context AND the proceed-point
   *  consume call, so the `'scoped'` arm's containment is evaluated — and
   *  store-re-verified (5.a) — against the live index. Keyed by the FULL
   *  `channel_session_id` (`chat:<session_id>`); non-chat sessions resolve
   *  empty (v1 channel scope, 5.f). Absent ⇒ no candidates ⇒ a scoped grant
   *  never matches (fail closed — exactly the pre-slice-D posture). */
  scopedSenderCandidates?: (
    channel_session_id: string,
  ) => ReadonlyArray<ScopedSenderCandidate>;
  /** D-177 P5a (N.10) — the batch-approval coordinator. A freshly-
   *  checkpointed commit-gateway hold registers here: same-origin-unit
   *  holds JOIN one re-rendered batch ask instead of minting a second;
   *  the first hold creates the row + the v1 ask (P3-compatible). The
   *  coordinator owns the ask raise for registered holds (the returned
   *  ask_id pairs the anchor). Absent ⇒ every hold raises today's
   *  per-hold ask (additive — dbless / harness modes unchanged). */
  batchApprovals?: BatchApprovalCoordinator;
  /** D-145 engine-wiring slice 3b.1 — the D-153 commit store. Threaded
   *  INERT: the Gateway dispatch-outbox (slice 3b.3) is the sole writer,
   *  so this handler neither reads nor writes through the handle today.
   *  Plumbed now so 3b.3 is a wiring-only change. Absent ⇒ no commit log
   *  (no-db / harness modes), exactly as today. */
  commitStore?: CommitStore;
  /** D-157 P1 slice 3 — the preflight checkpoint store. The handler
   *  writes a `Checkpoint` here when the engine returns
   *  `result.awaiting_approval` — the host mints `checkpoint_id` (this
   *  layer owns id-minting + the `run_id`), builds the row from the
   *  engine's `step_state` snapshot, and persists. Absent ⇒ a paused
   *  run is reported in the response but is not durably resumable; the
   *  gateway preflight flow (slice 4) treats a missing checkpoint as
   *  abort-on-approval. */
  checkpointStore?: CheckpointStore;
  /** D-157 P1 slice 4 — the D-158 notification block, threaded as the
   *  narrow `PreflightNotifier` seam. When wired AND the engine paused
   *  on a preflight gate, the handler calls `raisePreflightAsk(...)`
   *  with kind `gateway.preflight`, persists the returned `ask_id` on
   *  the audit anchor alongside `checkpoint_id`, and the matching
   *  `on_answer` handler (registered at boot via
   *  `registerPreflightHandler`) re-instantiates or denies the run.
   *
   *  Absent ⇒ the audit row still carries `commit_status:
   *  'awaiting_approval'` + the `checkpoint_id`, but no
   *  `notification.ask` is raised — the paused run sits durable on
   *  disk + the user has no surface to act on it. This is the
   *  graceful-degradation posture matching D-157 P0's in-doubt leaf
   *  (which also defers the server-side notification-block
   *  construction to a downstream slice). */
  preflightNotifier?: PreflightNotifier;
  /** D-210 Phase C — the owner's inbox device-fanout mode, read fresh at
   *  each raise off the `reception_page` singleton config.
   *
   *  A THUNK, not a value: the setting is editable at any time and this
   *  dep is composed once at boot, so a captured value would pin whatever
   *  was stored the moment the server started and quietly ignore every
   *  later change.
   *
   *  Absent ⇒ every hold raises the actionable ask, byte-identical to
   *  pre-Phase-C. Consulted ONLY for reception-origin holds — see the
   *  scope fence at the raise site. */
  resolveInboxFanoutMode?: () => ReceptionInboxFanoutMode;
  /** R2 step 6 (write-saga) — the D-158 notification block, threaded
   *  as the narrow `SagaNotifier` seam. When wired AND a run
   *  terminal-fails AFTER ≥1 catalog write landed (derived from the
   *  run's commits — `detectTornSaga`), the handler raises ONE
   *  `notification.ask` (kind `gateway.saga`) disclosing the torn
   *  state, with an `undo` option iff a compensation derived. Raise is
   *  best-effort AFTER the audit anchor write: a failure leaves the
   *  torn state visible in the commit log but unsurfaced (same
   *  degradation posture as `preflightNotifier`; a boot sweep for
   *  unsurfaced torn runs is a noted follow-on). Absent ⇒ no saga
   *  detection runs at all. */
  sagaNotifier?: SagaNotifier;
  /** Doc §4 close-out (>1-provider pick) — the D-158 notification
   *  block, threaded as the narrow `PickNotifier` seam. When wired AND
   *  an interactive run arrives with an UNBOUND connection slot that
   *  more than one enrolled connection can serve, the handler raises
   *  ONE `notification.ask` (kind `gateway.pick`) offering the
   *  candidates; the answer dispatches a FRESH gated run with the
   *  binding merged into `config` (re-run, never resume — doc §1.3).
   *  The original request still fails with the typed
   *  `connection_pick_required` error either way, so an AI caller can
   *  simply re-run with `config.<var>` itself. Absent ⇒ no ask is
   *  raised (the typed error alone carries the candidates). Auto-bind
   *  of a SINGLE capable candidate and the headless pinned-target
   *  block do NOT depend on this seam. */
  pickNotifier?: PickNotifier;
  /** D-192 Slice 6b — the D-158 notification block, threaded as the narrow
   *  `ContainerPickNotifier` seam. When wired AND a work-entity create in the run
   *  failed on an AMBIGUOUS vendor container (Linear `team`, an Asana
   *  `workspace`), the handler raises ONE `notification.ask` (kind
   *  `work_entity.container_pick`) offering the containers; the answer persists
   *  the pick as the Source's default and dispatches a FRESH run that re-does the
   *  create (re-run, never resume). The response carries `container_pick_required`
   *  (with the `ask_id` when raised) either way, so a caller can render its own
   *  picker. Absent ⇒ no ask is raised (the step error carries the choice set).
   *  Gated to owner/interactive runs without vault/context (same eligibility as
   *  the connection pick — a persisted request carrying either can't be replayed). */
  containerPickNotifier?: ContainerPickNotifier;
  /** D-192 Slice 6c — the D-158 notification block, threaded as the narrow
   *  `CreatePlanNotifier` seam. When wired AND a work-entity create in the run
   *  DECIDED to create a named vendor container that doesn't exist yet (an Asana
   *  `project` whose `create_op` is granted), the handler raises ONE create-plan
   *  `notification.ask` (kind `work_entity.create_plan`) enumerating the container
   *  create(s) + the pending write; on approval the answer creates the container(s)
   *  and dispatches a FRESH run that re-does the write off the stored selection
   *  (on deny nothing is created). The response carries `create_plan_required` (with
   *  the `ask_id` when raised) either way. Same owner/interactive-without-vault/
   *  context eligibility as the container pick. */
  createPlanNotifier?: CreatePlanNotifier;
  /** D-182 §10 step 8 / R1 (Fix 2) — installed-manifest store, the source of
   *  pack-composition CRM/acct vendors' decomposed entity schemas. The R1
   *  pre-pass builds its convention-family registry from `liveVendorRegistry`
   *  over this store (built-ins + 3rd-party packs), so a connected `acct` vendor
   *  (QuickBooks/Xero ship as pack-composition vendors, NOT built-ins) or a
   *  3rd-party CRM pack vendor actually binds its family. Absent (dbless / unit)
   *  → built-in HubSpot/Salesforce registry only (the fail-safe — today's
   *  behaviour). Same handle the disclosure half reads, so run + disclosure can't
   *  drift. */
  localManifestStore?: Pick<LocalManifestStore, 'listManifests' | 'getEntitySchemas'>;
}

interface CustomerUsageCallerRootKeys {
  readonly config: ReadonlySet<string>;
  readonly context: ReadonlySet<string>;
  readonly vault: ReadonlySet<string>;
}

/** Follow the established D-177 provenance walk through `step.*`, transform,
 * foreach/item, and AI producer edges, but without materializing/pinning live
 * values. Reusing `computeOpenProjection` here made customer control depend on
 * that approval structure's byte/node ceilings: a large caller array could
 * make the projection refuse and be misclassified as seller-owned. This walk
 * needs only static lineage. IO-produced arrays remain an explicit boundary. */
const customerControlsD162Batch = (input: {
  readonly recipe: RecipeDefinition;
  readonly mergedArgs: Record<string, unknown>;
  readonly callerRootKeys: CustomerUsageCallerRootKeys;
  readonly stepId?: string;
  readonly getIngredientKind: (slug: string) => string | undefined;
  readonly getIngredientManifestInput: (
    slug: string,
  ) => Record<string, unknown> | undefined;
}): boolean => {
  const unresolvedData = input.mergedArgs['llm.data'];

  const steps = [
    ...(input.recipe.steps ?? []),
    ...(input.recipe.prefetch_steps ?? []),
    ...(input.recipe.trigger_steps ?? []),
  ];
  const stepIndex = new Map<string, Record<string, unknown>>();
  for (const candidate of steps) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }
    const step = candidate as Record<string, unknown>;
    if (typeof step.id === 'string' && !stepIndex.has(step.id)) {
      stepIndex.set(step.id, step);
    }
  }
  const controlFields = new Set([
    'id', 'transform', 'guard', 'ingredient', 'op', 'skip_when', 'fail_on',
    'cache', 'foreach', 'output', 'optional', 'ingredient_version',
    'timeout_ms', 'on_timeout', 'prompt', 'pii_fields', 'connection',
  ]);
  const seenObjects = new Set<object>();

  const walkValue = (
    value: unknown,
    stepContext: Record<string, unknown> | undefined,
    visitedSteps: ReadonlySet<string>,
  ): boolean => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
        const ref = match[1]!.trim();
        const dot = ref.indexOf('.');
        const namespace = dot < 0 ? ref : ref.slice(0, dot);
        const path = dot < 0 ? '' : ref.slice(dot + 1).replace(/:[a-z_]+$/, '');
        if (
          namespace === 'config'
          || namespace === 'context'
          || namespace === 'vault'
        ) {
          const callerKeys = input.callerRootKeys[namespace];
          if (path.length === 0) return callerKeys.size > 0;
          const key = path.split('.')[0] ?? '';
          if (callerKeys.has(key)) return true;
          continue;
        }
        if (namespace === 'step' || namespace === 'trigger') {
          const producerId = path.split('.')[0] ?? '';
          if (producerId.length === 0 || visitedSteps.has(producerId)) continue;
          const producer = stepIndex.get(producerId);
          if (
            producer !== undefined
            && walkProducingStep(
              producer,
              new Set([...visitedSteps, producerId]),
            )
          ) {
            return true;
          }
          continue;
        }
        if (namespace === 'item' && stepContext !== undefined) {
          const source = stepContext.foreach ?? (
            typeof stepContext.transform === 'string'
              ? stepContext.input
              : undefined
          );
          if (source !== undefined && walkValue(source, stepContext, visitedSteps)) {
            return true;
          }
        }
      }
      return false;
    }
    if (value === null || typeof value !== 'object' || seenObjects.has(value)) {
      return false;
    }
    seenObjects.add(value);
    if (Array.isArray(value)) {
      return value.some((entry) => walkValue(entry, stepContext, visitedSteps));
    }
    return Object.values(value as Record<string, unknown>)
      .some((entry) => walkValue(entry, stepContext, visitedSteps));
  };

  const walkProducingStep = (
    step: Record<string, unknown>,
    visitedSteps: ReadonlySet<string>,
  ): boolean => {
    // Engine foreach wraps the producer result in one entry per source item;
    // that cardinality remains caller-controlled even when each individual
    // entry crosses an IO boundary.
    if (
      step.foreach !== undefined
      && walkValue(step.foreach, step, visitedSteps)
    ) {
      return true;
    }
    // Catalog and ordinary IO outputs are seller/external data boundaries;
    // their internal request args do not turn a returned array into a
    // customer-supplied batch payload.
    if (typeof step.op === 'string') return false;
    if (typeof step.ingredient === 'string') {
      if (input.getIngredientKind(step.ingredient) !== 'ai') return false;
      const authoredInput = step.input;
      if (typeof authoredInput === 'string') {
        return walkValue(authoredInput, step, visitedSteps);
      }
      const stepInput =
        authoredInput !== null
        && typeof authoredInput === 'object'
        && !Array.isArray(authoredInput)
          ? authoredInput as Record<string, unknown>
          : {};
      const merged = mergeManifestStepInput(
        input.getIngredientManifestInput(step.ingredient),
        stepInput,
        { trustedSurfaceDispatch: false },
      );
      return walkValue(merged, step, visitedSteps);
    }
    if (typeof step.transform === 'string' || typeof step.guard === 'string') {
      for (const [key, value] of Object.entries(step)) {
        if (controlFields.has(key)) continue;
        if (walkValue(value, step, visitedSteps)) return true;
      }
      return false;
    }
    return false;
  };

  const gatedStep = input.stepId !== undefined
    ? stepIndex.get(input.stepId)
    : undefined;
  return walkValue(unresolvedData, gatedStep, new Set<string>());
};

const customerControlledD162ExtraUnits = (input: {
  readonly slug: string;
  readonly resolvedInput: Record<string, unknown>;
  readonly customerControlled: boolean;
}): number => {
  if (!isBatchCapableAISlug(input.slug) || !isAIBatchMode(input.resolvedInput)) return 0;
  if (!input.customerControlled) return 0;
  return Math.max((input.resolvedInput['llm.data'] as unknown[]).length - 1, 0);
};

/** Handle recipe execution. Pure handler — takes parsed request,
 *  returns the ExecuteResponse on success or throws `RpcError` for
 *  request-shape problems (missing recipe, recipe_id not found).
 *  Runtime execution errors are carried inside the response's
 *  `success: false` + `errors: [...]` fields, not thrown. */
export const handleExecute = async (
  deps: ExecuteHandlerDeps,
  request: ExecuteRequest,
  /** D-157 server-wiring — internal-only overrides. Only
   *  `PreflightResumer.resumeRun` passes a non-empty object here; wire-
   *  facing dispatchers omit the argument. The fields live OFF
   *  `ExecuteRequest` so they cannot be smuggled through a wire builder
   *  that accidentally spreads incoming args — `run_id` collisions
   *  could otherwise overwrite an unrelated run's audit anchor. */
  internal: InternalExecuteOverrides = {},
): Promise<ExecuteResponse> => {
  // Capture WIRE ownership before dish/install overlays mutate `request.config`.
  // An inline recipe supplied by a direct MCP customer is itself caller-owned;
  // a stored recipe's batch multiplicity is caller-owned only where its ref
  // graph reaches one of these caller-supplied config/context/vault roots.
  const customerUsageCallerRootKeys: CustomerUsageCallerRootKeys = {
    config: new Set(Object.keys(request.config ?? {})),
    context: new Set(Object.keys(request.context ?? {})),
    vault: new Set(Object.keys(request.vault ?? {})),
  };
  const customerUsageInlineRecipe = request.recipe !== undefined;
  // Resolve recipe: inline > by id
  let recipe: RecipeDefinition | null = null;
  let operationBoundWebhookConsumer: ExecutionContext['operationBoundWebhookConsumer'];

  if (request.recipe) {
    recipe = request.recipe as RecipeDefinition;
    if (!recipe.recipe_id || !recipe.steps) {
      throw new RpcError('bad_request', 'Inline recipe must have recipe_id and steps', 400);
    }
  } else if (request.recipe_id) {
    recipe = deps.recipeStore.get(request.recipe_id);
    if (!recipe) {
      throw new RpcError('recipe_not_found', `Recipe '${request.recipe_id}' not found`, 404);
    }
    // D-201 Slice 6B3 audit fold — operation-bound callback authority follows
    // durable store provenance, never the author-controlled recipe body. A
    // missing/throwing metadata lookup leaves only this feature unavailable;
    // ordinary stored and bundled recipes continue through the normal path.
    try {
      const stored = typeof deps.recipeStore.getStored === 'function'
        ? deps.recipeStore.getStored(request.recipe_id)
        : null;
      if (stored) {
        operationBoundWebhookConsumer = stored.pack_slug === null
          ? { kind: 'local_recipe', id: stored.recipe_id }
          : { kind: 'pack_install', id: stored.pack_slug };
      }
    } catch {
      operationBoundWebhookConsumer = undefined;
    }
  } else {
    throw new RpcError('bad_request', 'Either recipe_id or recipe is required', 400);
  }

  // Entity-targeting guard (design § 8) — a caller-initiated run of a
  // TARGETED recipe (one that reads a specific record the caller must
  // supply) with no target blocks here, before any binding/gating work:
  // without this it runs on nothing ({{context.entity_id}} resolves
  // undefined). Machine trigger_sources are exempt inside the guard.
  // Preflight RESUMES skip it: the original dispatch already passed, and
  // `buildResumeInputs` rebuilds config from the anchor but does NOT
  // persist caller context — re-guarding would block the approved resume
  // of a context-targeted run.
  if (internal.resume_from === undefined) assertRunTargets(recipe, request);

  // D-179 P1 — standing-dish resolution. A `dish_id` on the request
  // binds the run to a persisted dish: its `config_overlay` merges OVER
  // the caller's install config (dish → install → defaults) BEFORE the
  // dispatch-resolve / held-action identity / audit snapshot all read
  // `request.config`, so every downstream consumer — including the
  // D-177 action-identity hash basis — sees the post-overlay values.
  // No `dish_id` ⇒ ephemeral dish: an id is derived from the run id for
  // audit attribution only (minted below, next to `run_id`).
  // RESUME runs (`internal.run_id` set — the preflight resumer re-enters
  // under the paused anchor) bind the dish for attribution + continuity
  // ONLY: the anchor's `config_snapshot` already carries the approved
  // post-overlay values, so re-merging a possibly-edited overlay would
  // dispatch values the user never approved. Lookup is best-effort on
  // resume — a dish deleted/disabled mid-pause must not wedge an
  // approved resume (the run degrades to ephemeral attribution).
  let boundDish: Dish | null = null;
  if (request.dish_id !== undefined) {
    if (typeof request.dish_id !== 'string' || request.dish_id.length === 0) {
      throw new RpcError('bad_request', 'dish_id must be a non-empty string', 400);
    }
    const isResume = internal.run_id !== undefined;
    if (!deps.dishStore) {
      if (!isResume) {
        throw new RpcError('not_configured', 'dish dispatch requires a DB-backed server', 501);
      }
    } else {
      const dish = deps.dishStore.get(request.dish_id);
      if (!dish) {
        if (!isResume) {
          throw new RpcError('not_found', `Dish '${request.dish_id}' not found`, 404);
        }
      } else if (dish.recipe_id !== recipe.recipe_id) {
        if (!isResume) {
          throw new RpcError(
            'bad_request',
            `Dish '${dish.dish_id}' instantiates recipe '${dish.recipe_id}', not '${recipe.recipe_id}'`,
            400,
          );
        }
      } else if (!dish.enabled && !isResume) {
        throw new RpcError('dish_disabled', `Dish '${dish.dish_id}' is disabled`, 409);
      } else if (dish.is_default && !isResume) {
        // D-179 — the recipe's install-config dish is a MUTABLE config
        // SOURCE (auto-applied to dishless runs, below), never a dispatch
        // identity: binding a run to it would put a mutable `dish_id` in the
        // audit, so a later `recipe_config.set` would rewrite an audited
        // config. Reject the direct dispatch; the overlay still applies as a
        // base to this recipe's dishless runs.
        throw new RpcError(
          'bad_request',
          `Dish '${dish.dish_id}' is the recipe's default config — applied automatically, not dispatched directly`,
          400,
        );
      } else {
        boundDish = dish;
        if (!isResume) {
          // D-179 P3 — group overlay merges under the dish's own:
          // dish → group → install → defaults.
          const groupOverlay = dish.group_id !== undefined
            ? deps.dishGroupStore?.get(dish.group_id)?.config_overlay ?? {}
            : {};
          if (Object.keys(groupOverlay).length > 0 || Object.keys(dish.config_overlay).length > 0) {
            request = {
              ...request,
              config: { ...(request.config ?? {}), ...groupOverlay, ...dish.config_overlay },
            };
          }
        }
      }
    }
  } else if (deps.dishStore && internal.run_id === undefined) {
    // D-179 — a DISHLESS run (manual, or an automation with no config of
    // its own) applies the recipe's INSTALL config: the overlay on its
    // `is_default` dish, merged as a BASE UNDER the caller's per-run config
    // (defaults < install < request.config). The default dish is a config
    // SOURCE, not a dispatch identity — attribution stays ephemeral, so
    // its `dish_id` never lands in this run's audit and it stays mutable.
    const installDish = deps.dishStore
      .listByRecipe(recipe.recipe_id)
      .find((d) => d.is_default);
    if (installDish && Object.keys(installDish.config_overlay).length > 0) {
      request = {
        ...request,
        config: { ...installDish.config_overlay, ...(request.config ?? {}) },
      };
    }
  }

  // R2 dispatch (internal design notes
  // §3) — a canonical op-step (e.g. `deal.search`) resolves to a concrete vendor binding
  // AT DISPATCH, from the connection the run supplies (its `type:'connection'` variable in
  // `config`), reusing the install-time resolver. This relocates the R1 install-bake to run
  // time so one canonical recipe stays portable instead of being copied per vendor. The
  // engine has no op→ingredient path, so an unresolved op-step must never reach it:
  // FAIL-CLOSED — a recipe with no canonical op-step passes through untouched; one that
  // can't bind (no connection variable / no bound catalog) is rejected here with the
  // precise reason. Inline + persisted recipes flow through the same resolve.
  //
  // Pick-resolution layer (doc §4 close-out) on the ONE actionable failure shape — an
  // UNBOUND slot variable. Candidates = enrolled profiles whose stamped catalog can serve
  // every canonical op the slot declares (tier-1 op-set check; the full resolve below
  // stays the enforcement). Then, per the run's `execution_source`:
  //   - interactive (actor `user_self` / `contracted_user`), 1 candidate → AUTO-BIND it
  //     and resolve again (§1.3 — "the single-target case is N=1"). Authorization-neutral
  //     by construction: the request keeps its ORIGINAL `execution_source` (+ contract
  //     snapshot), so the policy/contract gates run exactly as if the caller had supplied
  //     the binding itself — which it always could (config is caller-writable).
  //   - `user_self`, >1 candidate → raise ONE `gateway.pick` ask (when the notifier is
  //     wired and the request carries no vault/context overrides, which an ask payload
  //     cannot faithfully persist) and throw the typed `connection_pick_required` with
  //     the candidate names — the answer dispatches a FRESH gated run with the binding
  //     merged (re-run, never resume), and the caller can equally re-run with
  //     `config.<var>` itself.
  //   - `contracted_user`, >1 candidate → the typed `connection_pick_required` WITHOUT
  //     candidates and WITHOUT an ask (codex HIGH fold). The ask + the re-run dispatch
  //     under the owner's `user_self` authority — a contract-restricted agent must never
  //     convert "I lack a binding" into an owner-authority run via the owner's routine
  //     disambiguation click (confused deputy), and enrolled connection names are
  //     owner-surface information, not pre-gate disclosure to a contracted caller. The
  //     agent asks ITS principal in-channel and re-runs with `config.<var>`.
  //   - system / anonymous / unattributed: NEVER ask, NEVER auto-bind — throw the typed
  //     `connection_target_unpinned` (the v3 spec §9 pinned-target rule:
  //     targeted-without-a-target → block). A headless binding that floated to whichever
  //     single candidate existed would silently retarget when a second connection
  //     enrolls; pinning keeps automation deterministic over time.
  // A multi-slot recipe converges iteratively — each auto-bind pass or answered ask binds
  // ONE variable; the loop is bounded by the recipe's slot count (`boundVars` guard).
  //
  // D-182 §10 step 8 / R1 — kernel canonical runnability, BEFORE the dispatch /
  // pick-resolution loop. This is the COARSE "is the convention's family bound at
  // all" gate; it composes with — never replaces — the precise per-op pick layer
  // below (a bound family still goes through candidate derivation / auto-bind /
  // pick). When NO vendor in the op's family is bound, the verb-split decides:
  //   - read / search  → the op-step is rewritten to an empty result (the recipe
  //     CONTINUES — downstream-safe) + a pre-run warning surfaced to the owner;
  //   - create / update / delete → fail closed pre-run (a write must never
  //     silently no-op a side effect because no provider is bound).
  // Keyed on the `core.crm.*`/`core.acct.*` form only (`kernelOpRunnability`
  // returns null for a bare `deal.search` / Tier-P op), so the legacy bare-form
  // dispatch + the pick-resolution seal below are untouched. INERT unless the
  // recipe carries a canonical-convention op-step whose family is unbound.
  let runnabilityWarnings: string[] = [];
  {
    const r1 = applyKernelOpRunnability(
      recipe,
      deriveBoundConventionFamilies(
        deps.connectionStore,
        // The LIVE merged registry (built-ins + installed pack-composition vendors)
        // so a connected `acct` vendor (QuickBooks/Xero) or a 3rd-party CRM pack
        // vendor binds its family. Absent store → built-ins only (the fail-safe).
        liveVendorRegistry(deps.localManifestStore),
      ),
    );
    if (!r1.ok) {
      throw new RpcError(
        'connection_required',
        `Recipe '${recipe.recipe_id}' cannot run — ${r1.blocked
          .map((b) => `${b.op}: ${b.warning}`)
          .join(' ')}`,
        400,
        undefined,
        { blocked_ops: r1.blocked.map((b) => b.op) },
      );
    }
    recipe = r1.recipe;
    if (r1.warnings.length > 0) runnabilityWarnings = r1.warnings.map((w) => w.warning);
  }
  {
    const profiles = deps.connectionOperationProfiles;
    let effectiveConfig: Record<string, unknown> = request.config ?? {};
    let autoBound = false;
    const boundVars = new Set<string>();
    // D-182 Slice 4 — the Tier-P `pack_ref → catalog` map a recipe's
    // `<publisher>.<pack>.<op>` op-steps lower against at dispatch (and the pick
    // walk), built once from the installed-pack inventory (`contractScan`) + the
    // live manifest registry. Absent contract scan (db-less / unit) ⇒ undefined ⇒
    // the empty-map fallback (a kernel-only recipe still lowers; a Tier-P op fails
    // closed). INERT on the current corpus (no two-tier op ids until the rewrite).
    //
    // By design the map is the WHOLE installed-pack universe, NOT filtered by the
    // run recipe's `depends_on`: `depends_on` is an INSTALL/AUTHORING-time
    // declared-dependency-cover concern (the §9 Compose validator), not a runtime
    // gate — at dispatch a Tier-P op resolves iff its pack is installed, and the
    // Gateway still enforces grants/reachability per op. So an inline (chat-/door-
    // authored, never-installed) recipe whose op names an installed pack lowers
    // even with no `depends_on` — equivalent to the caller having declared it; the
    // authorization boundary is unchanged.
    const packOpResolution =
      deps.contractScan !== undefined
        ? buildPackOpResolution(
            () => deps.contractScan!('installed_pack', []),
            (slug) => deps.executorConfig.manifests.get(slug),
          )
        : undefined;
    let dispatchResolve = resolveCanonicalRecipeForDispatch(recipe, {
      profiles: profiles ?? { get: () => null },
      manifests: deps.executorConfig.manifests,
      config: effectiveConfig,
      packs: packOpResolution,
    });
    while (
      !dispatchResolve.ok
      && dispatchResolve.unbound_slot !== undefined
      && profiles !== undefined
    ) {
      const { variable } = dispatchResolve.unbound_slot;
      if (boundVars.has(variable)) break; // defensive: never loop on one slot
      const { candidates, operations } = derivePickCandidates(recipe, variable, {
        profiles,
        manifests: deps.executorConfig.manifests,
        packs: packOpResolution,
      });
      const src = request.execution_source;
      const ownerRun = src !== undefined && src.actor === 'user_self';
      const contractedRun = src !== undefined && src.actor === 'contracted_user';

      if (!ownerRun && !contractedRun && candidates.length > 0) {
        // Enrolled connection names are owner-surface information — a
        // webhook / reception error can flow to an EXTERNAL caller, so
        // no non-owner path ever lists them (codex HIGH fold, widened).
        const channel = src !== undefined ? `'${src.channel}' channel` : 'unattributed';
        throw new RpcError(
          'connection_target_unpinned',
          `Recipe '${recipe.recipe_id}' needs a connection for '${variable}' but the run is headless (${channel}) — a pick ask cannot be answered, so the target must be pinned: set config.${variable} to an enrolled connection (Settings → Connections).`,
          400,
          undefined,
          { variable },
        );
      }
      if ((ownerRun || contractedRun) && candidates.length === 1) {
        // Authorization-neutral: the request keeps its ORIGINAL
        // execution_source (+ contract snapshot), so the policy/contract
        // gates run exactly as if the caller had supplied the binding —
        // which it always could (config is caller-writable).
        boundVars.add(variable);
        autoBound = true;
        effectiveConfig = {
          ...effectiveConfig,
          [variable]: candidates[0].connection_name,
        };
        dispatchResolve = resolveCanonicalRecipeForDispatch(recipe, {
          profiles,
          manifests: deps.executorConfig.manifests,
          config: effectiveConfig,
          packs: packOpResolution,
        });
        continue;
      }
      if (contractedRun && candidates.length > 1) {
        // Codex HIGH fold — no ask, no candidate names for a contracted
        // caller: the ask's answer dispatches under the OWNER's authority,
        // so a contract-restricted agent must never convert "I lack a
        // binding" into an owner-authority run via the owner's routine
        // disambiguation click (confused deputy). The agent asks ITS
        // principal in-channel and re-runs with the binding.
        throw new RpcError(
          'connection_pick_required',
          `Recipe '${recipe.recipe_id}' needs a connection for '${variable}' and more than one enrolled connection can serve it. Ask the user which connection to use, then re-run with config.${variable} set to its name.`,
          400,
          undefined,
          { variable },
        );
      }
      if (ownerRun && candidates.length > 1) {
        const candidateNames = candidates.map((c) => c.connection_name);
        let askId: string | undefined;
        if (
          deps.pickNotifier !== undefined
          && request.vault === undefined
          && request.context === undefined
        ) {
          try {
            const askInput = buildPickAskInputForSlot({
              recipe,
              byId: request.recipe === undefined,
              variable,
              config: effectiveConfig,
              candidates,
              operations,
            });
            askId = (await raisePickAsk(deps.pickNotifier, askInput)).ask_id;
          } catch (e) {
            // Best-effort raise — the typed error below still carries the
            // candidates, so the caller can re-run with a binding.
            console.warn(
              `[pick] failed to raise pick ask for '${variable}': `
                + (e instanceof Error ? e.message : String(e)),
            );
          }
        }
        throw new RpcError(
          'connection_pick_required',
          `Recipe '${recipe.recipe_id}' needs a connection for '${variable}' and ${candidates.length} can serve it: ${candidateNames.join(', ')}. Re-run with config.${variable} set to one of them${askId !== undefined ? ', or answer the pick request that was just raised' : ''}.`,
          400,
          undefined,
          {
            variable,
            candidates: candidateNames,
            ...(askId !== undefined ? { ask_id: askId } : {}),
          },
        );
      }
      break; // 0 candidates — the generic resolve failure below owns the message
    }
    if (!dispatchResolve.ok) {
      throw new RpcError(
        'bad_request',
        `Recipe contains a canonical op-step (e.g. "deal.search") that could not be resolved at dispatch: ${dispatchResolve.reason}. Install it into a CRM-conformant pack, or supply its connection at run.`,
        400,
      );
    }
    recipe = dispatchResolve.recipe;
    if (autoBound) {
      // The engine re-resolves each op-step's `{{config.<var>}}` at execute,
      // and the held-action identity + audit snapshots read `request.config`
      // — every downstream consumer must see the auto-bound binding.
      request = { ...request, config: effectiveConfig };
    }
  }

  // § 7 auto-PII — alias classified PII before model egress (llm.pii_fields
  // injection + pii-protect/pii-restore bracket synthesis, verification-
  // gated; see auto-pii-apply.ts). Sits AFTER the dispatch-resolve (the
  // trace classifies the concrete vendor steps that will actually run) and
  // BEFORE every downstream reader of the step list — held-action identity,
  // provenance insight, session-grant hash, open-projection walk, and the
  // engine all see the one protected shape. Deterministic, so resumes and
  // re-sends hash identically.
  recipe = applyAutoPiiForExecution(recipe);

  // Build vault: base (file + env) + request overrides
  const vault = mergeVault(deps.baseVault, {}, request.vault);
  const config = request.config ?? {};

  // ── D-157 Part C — held-action idempotency ──────────────────────────
  // Before doing any work, collapse a re-sent identical action onto an
  // existing LIVE hold. Parts A/B tell an agent a held action is queued
  // and NOT to resend; this makes a resend HARMLESS for a weaker / local
  // model that resends anyway — no second checkpoint + approval ask +
  // pending write, just the same `awaiting_approval` third-state echoed
  // back. Four guards keep the collapse safe (see held-action-idempotency
  // .ts for the full rationale):
  //   - `internal.run_id === undefined` — skip every internal re-entrant
  //     dispatch that reuses a run_id: the RESUME path (which re-enters
  //     under the paused run's own still-`awaiting_approval` anchor and
  //     would otherwise collapse onto itself) AND the reception-workflow
  //     dispatcher (a fresh `reactive` fire per event).
  //   - channel ∈ {chat, mcp} — only the agent-resend surfaces, where the
  //     intent rides in `config`. System / event channels keep a stable
  //     channel_session_id across distinct fires whose input lives in
  //     `context.event.payload` (outside the key) → would false-collapse.
  //   - no caller-supplied `context` / `vault` — per-intent inputs the
  //     identity does not cover (the engine-injected `context.server` is
  //     added later, so a config-only resend still dedups).
  //   - `auditLog` + `checkpointStore` wired — a hold can't exist without
  //     a durable checkpoint store.
  // Runs BEFORE store/provenance/lifecycle setup so a collapse leaves no
  // phantom run. Best-effort: a lookup failure proceeds with a normal run.
  // Spec: D-157; internal design notes
  // (2026-06-08).
  // The dedup identity, computed ONCE when eligible (undefined otherwise) so
  // the entry-time check AND the concurrent-TOCTOU claim at the hold-creation
  // point key on the exact same facets.
  const heldActionIdentity: HeldActionIdentity | undefined =
    internal.run_id === undefined
    && request.context === undefined
    && request.vault === undefined
    && request.execution_source !== undefined
    && HELD_DEDUP_CHANNELS.has(request.execution_source.channel)
    && deps.auditLog !== undefined
    && deps.checkpointStore !== undefined
      ? {
          channel_session_id: deriveChannelSessionId(request.execution_source),
          recipe_id: recipe.recipe_id,
          recipe_hash: hashRecipe(recipe),
          config_snapshot: buildHeldConfigSnapshot(
            recipe.variables as Record<string, unknown> | undefined,
            config,
          ),
        }
      : undefined;
  // `?? undefined` — a `null` key (identity not canonicalizable under the
  // D-177 N.7 hash, e.g. a non-finite config value) degrades to "no in-flight
  // dedup", the same best-effort posture as a twin-lookup failure.
  const heldActionKey =
    heldActionIdentity !== undefined
      ? computeHeldActionKey(heldActionIdentity) ?? undefined
      : undefined;
  // Set when this run becomes the LEADER of an in-flight hold-creation (the
  // concurrent backstop in the awaiting block). `settle`d in the outer try's
  // `finally` with `status: 'durable'` iff the awaiting anchor was written (see
  // `heldActionDurable`), else `status: 'failed'` — releasing any follower.
  let heldClaim: InflightHoldClaim | undefined;
  let heldActionDurable = false;

  // Entry-time collapse — a SEQUENTIAL resend onto a durable live hold.
  if (heldActionIdentity !== undefined) {
    try {
      const twin = await findLiveHeldTwin(
        { auditLog: deps.auditLog!, checkpointStore: deps.checkpointStore! },
        heldActionIdentity,
      );
      if (twin !== null) {
        return buildHeldTwinResponse(twin);
      }
    } catch (e) {
      console.warn(
        `[execute-handler] held-action idempotency lookup failed for recipe `
          + `${recipe.recipe_id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // Server-hosted runs are by definition "on the server" — set
  // `context.server` so recipes that gate `data-*` steps via
  // `{{context.server.available}}` see the right shape. Caller-set
  // value wins (extension WS-relayed runs may want to forward their
  // own snapshot rather than the server self-reporting).
  const baseContext = (request.context ?? {}) as Record<string, unknown>;
  const context = Object.prototype.hasOwnProperty.call(baseContext, 'server')
    ? baseContext
    : { ...baseContext, server: { available: true, name: deps.serverName ?? 'recued' } };

  // Build namespace stores
  const stores = createNamespaceStores(vault, config, context);

  // D-157 server-wiring — seed `stores.step` from the resume payload
  // BEFORE the engine takes the run. The engine's resume mode
  // (`ctx.resumeFrom.gated_step_id`) trusts `stores.step` to already
  // hold every output minted before the gate; `internal.resume_from`
  // is the channel through which `PreflightResumer.resumeRun` plumbs
  // the consumed checkpoint's `step_state`. Seed via `assignOwnSafe`
  // so the checkpoint's keys go through the same prototype-pollution
  // reject list the engine's step-runner uses
  // (`__proto__`/`constructor`/`prototype` — see
  // `packages/engine/src/store-safety.ts`); even a corrupted on-disk
  // checkpoint can never inject prototype pollution into the live
  // namespace store.
  if (internal.resume_from) {
    assignOwnSafe(
      stores.step as Record<string, unknown>,
      internal.resume_from.step_state,
    );
  }

  // D-172 P5 / N.8 activation (I-4) — the bound ingredient executor is built
  // LOWER DOWN (just before `engineExecutor`), AFTER the per-request
  // `data-file-read` admission gate (`evaluateAdmission`) is constructed, so
  // the ai-* multimodal overload's Gateway-gated `fileRead` can be injected
  // onto its LLM adapter. Nothing between here and that build consumes the
  // executor (the L2 step-cache + resolver blocks below read
  // `deps.executorConfig` directly), and the static policy-walk early-return
  // above (`handlePolicyGateDenial`) now skips building a discarded executor.

  // L2 step cache wiring — same CacheStore as L1, distinct key namespace.
  // Pre-load policies + manifest versions for every sequential-step
  // ingredient so the resolvers can stay sync. Manifest version folds
  // into step sourceHashes so v1 → v2 upgrades retire stale entries.
  let stepCache: Parameters<typeof executeRecipe>[0]['stepCache'];
  if (deps.executorConfig.cacheStore) {
    const policyBySlug = new Map<string, { cacheable: boolean; ttl_seconds: number; category?: string }>();
    const versionBySlug = new Map<string, string | number>();
    const seqIngredientSlugs = new Set<string>();
    for (const step of recipe.steps ?? []) {
      const s = step as { ingredient?: string };
      if (typeof s.ingredient === 'string' && !s.ingredient.includes('{{')) {
        seqIngredientSlugs.add(s.ingredient);
      }
    }
    for (const slug of seqIngredientSlugs) {
      const manifest = deps.executorConfig.manifests.get(slug);
      if (!manifest) continue;
      // D-165 P0 — never L2-cache catalog-form ingredients. The step-cache
      // policy is derived from the wrapper's static `category` + `risk_tier`,
      // which is explicitly NOT the policy source for catalog-form (effective
      // risk is per-operation; Invariant 1). Caching here would replay a
      // first run's result before `runStep` reaches the catalog gateway,
      // skipping the grant/preflight/audit the gateway owns (Invariant 5).
      // Omitting the slug leaves `ingredientPolicy(slug)` null → uncached →
      // every catalog call routes through the gateway. (Codex review HIGH#3.)
      if (isCatalogForm(manifest)) continue;
      // Owner-default-only kernel reads must cross the per-dispatch op + scope
      // gates on EVERY run. An L2 hit replays before the commit Gateway, so
      // caching one would let an authorized run warm sensitive output for a
      // later actor whose op or collection grant has since been revoked. Derive
      // the exclusion from the shared grant policy instead of maintaining a
      // second slug list: today this covers accepted FormResponses and raw
      // webhook reads, and automatically follows future owner-only kernel ops.
      const kernelOpId = kernelOpForBackingSlug(slug);
      if (kernelOpId !== undefined && isOwnerDefaultOnlyEntry(kernelOpId)) {
        policyBySlug.set(slug, {
          cacheable: false,
          ttl_seconds: 0,
          category: manifest.category,
        });
        continue;
      }
      // D-172 P5 / N.8 (codex P1 cache-bypass fold) — never L2-cache a
      // batch-capable ai-* step. Its `llm.data` can be a `data.file` ref whose
      // content bytes the LLM adapter reads under the `data-file-read` gate
      // (`resolveAiFileRef`), and the result is otherwise cacheable (category
      // 'ai', risk 'read'). The L2 stepCache short-circuits BEFORE the commit
      // gateway — a hit replays without re-admission (`replayCachedEntry`,
      // engine `execute.ts`) — so a cached file-derived ai result would be
      // served to a LATER actor admitted for the ai-* tool but DENIED
      // `data-file-read`, bypassing the gate. The gateway-boundary probe
      // (`evaluateAdmission`, below) closes the L1/peer path (it runs INSIDE
      // the gateway, after admission); this closes L2. The L1 ingredient cache
      // still serves repeated identical ai-* calls for an ADMITTED actor.
      // Static-slug exclusion (the only L2 lever) — a dynamic `llm.data` file
      // ref can't be seen here, so all batch-capable ai-* drop L2.
      if (isBatchCapableAISlug(slug)) {
        policyBySlug.set(slug, { cacheable: false, ttl_seconds: 0, category: manifest.category });
        continue;
      }
      const p = derivePolicy(manifest.category, manifest.risk_tier, (recipe as { ttl?: number }).ttl ?? 0);
      policyBySlug.set(slug, {
        cacheable: p.enabled,
        ttl_seconds: p.ttl_seconds,
        category: manifest.category,
      });
      if (manifest.version != null) versionBySlug.set(slug, manifest.version);
    }
    stepCache = {
      store: deps.executorConfig.cacheStore,
      ingredientPolicy: (slug: string) => policyBySlug.get(slug) ?? null,
      getIngredientVersion: (slug: string) => versionBySlug.get(slug) ?? null,
    };
  }

  // D-103 Phase A + D-172 P2 follow-up: pre-fetch resolvers for
  // durable `data.shared.*` refs and per-record annotation/link refs.
  // The cache-tier `shared.*` namespace stays local to the ext; server-
  // only runs read the durable tier via the SharedStore below.
  const sharedStore = deps.sharedStore;
  const annotationStore = deps.annotationStore;
  // D-177 N.11 rule 1 — per-row stored-cleanliness lookup for the
  // open-projection walks below (commit-gateway + catalog-gate
  // closures). Reads rows LIVE on each call; built once per run.
  // Undefined when neither store is wired — the walk then classes every
  // `data.*` root `'stored'` (tainted → pinned), the fail-closed
  // pre-follow-on behavior.
  const resolveStoredRowOrigin =
    deps.contactStore || annotationStore
      ? createStoredRowOriginResolver({
          ...(deps.contactStore ? { contactStore: deps.contactStore } : {}),
          ...(annotationStore ? { annotationStore } : {}),
        })
      : undefined;
  const sharedResolvers: SharedResolvers | undefined = sharedStore || annotationStore
    ? {
        ...(sharedStore
          ? {
              dataShared: {
                lookup: async (key: string) => {
                  const row = await sharedStore.read(key);
                  return row?.value ?? null;
                },
              },
            }
          : {}),
        ...(annotationStore
          ? {
              annotationsForRecord: async (collection: string, id: string) =>
                annotationStore.annotationsForRecord(collection, id),
              linksForRecord: async (
                collection: string,
                id: string,
                direction: 'outbound' | 'inbound',
              ) =>
                direction === 'outbound'
                  ? annotationStore.outboundLinks(collection, id)
                  : annotationStore.inboundLinks(collection, id),
            }
          : {}),
      }
    : undefined;

  // D-145 engine-wiring slice 3b.3 — mint the run id up front,
  // unconditionally. It is the audit row's `run_id`, and — when the
  // run dispatches commits — the Gateway's `request_id` (the
  // recipe-run-grouping FK every commit carries; D-153 §
  // Execution-request anchor). The Gateway writes commits *during* the
  // run, so the id must exist before `executeRecipe` starts. Minting
  // it at dispatch time rather than run-finish (the old `newRunId`
  // call inside `buildAuditEntry`) changes no ordering — audit reads
  // sort by `started_at`, never by the `run_id` string.
  //
  // D-157 server-wiring — `internal.run_id` overrides the minted id so
  // `PreflightResumer.resumeRun` resumes under the paused anchor's
  // `run_id`. The resume's terminal audit row then transitions the
  // existing anchor in place (the audit collection's `INSERT OR REPLACE`
  // write resolves the same key), preserving the run-anchor identity
  // end-to-end. The override sits on the internal-only `internal` arg —
  // never on the public `ExecuteRequest` — so a wire-facing dispatcher
  // cannot smuggle a `run_id` that collides with an existing anchor.
  const run_id = internal.run_id ?? newRunId();
  // D-179 P1 — the run's dish attribution. A standing dish keeps its
  // long-life id; a dishless (manual / legacy-dispatch) run derives an
  // ephemeral id from the run id — attribution-only, never persisted.
  const dish_id = boundDish?.dish_id ?? ephemeralDishId(run_id);

  // D-179 P4 — the dispatching trigger id (when trigger-dispatched),
  // stamped onto the run-outcome event so the dispatcher's direct
  // self-loop guard can refuse to re-fire the originating trigger.
  const origin_trigger_id = originTriggerIdFromContext(request.context);

  // D-120 Phase 3 — provenance link emission setup.
  //
  // The engine streams `EmittedLink`s through `linkSink`; the
  // post-audit insert pins them to the run's audit row. Two correlated
  // identifiers gate it, both resolved BEFORE execution starts:
  //
  //   1. `recipe_insight_id` — surrogate FK from `recipe_insights`,
  //      resolved lazily here (via `recipe_hash` from `hashRecipe`)
  //      for inline recipes that bypass `recipeStore.save`.
  //   2. `pre_run_id`        — the link table's `memory_id`. Exactly
  //      `run_id`, surfaced only when provenance is on so `linkSink`
  //      stays unwired (and `lifecycle_run_id` keeps its `inflight:`
  //      fallback) otherwise.
  //
  // Both default to undefined when DB / provenance / opt-out gates
  // them off; `linkSink` then stays unwired and no links land.
  // Idempotent: a recipe with `provenance: false` skips the insight
  // resolution too — no point paying for a row we'll never reference.
  const provenance_enabled =
    deps.db !== undefined && recipe.provenance !== false;
  const recipe_hash_for_links = provenance_enabled ? hashRecipe(recipe) : undefined;
  const recipe_insight_id = provenance_enabled
    ? ensureRecipeInsightId(deps.db!, recipe, recipe_hash_for_links!)
    : undefined;
  const pre_run_id = provenance_enabled && recipe_insight_id !== undefined
    ? run_id
    : undefined;
  const link_buffer: EmittedLink[] = [];
  const linkSink = pre_run_id !== undefined
    ? (link: EmittedLink) => {
        link_buffer.push(link);
      }
    : undefined;

  // D-121 Phase 6 — emit lifecycle `start` once we know the run id.
  // Provenance-disabled runs leave `pre_run_id` undefined; emit a
  // fallback `recipe.recipe_id`-rooted id so the lifecycle event still
  // threads back to the same recipe. `complete` / `error` fire
  // post-execute; cursor order preserves start → complete pairing.
  const lifecycle_run_id = pre_run_id ?? `inflight:${recipe.recipe_id}:${Date.now().toString(36)}`;
  emitExecution(deps.eventBus, {
    recipe_id: recipe.recipe_id,
    run_id: lifecycle_run_id,
    op: 'start',
  });

  // D-153 P2.C — pre-execution policy gate at the Engine dispatch
  // boundary. Three channel sets gate today:
  //  - `POLICY_GATED_SYSTEM_CHANNELS` (schedule + reactive): no
  //    contract snapshot needed; coarse `allowed_kinds ×
  //    allowed_risk_tiers` cell admits.
  //  - `POLICY_GATED_USER_CHANNELS` (chat + user): no contract
  //    snapshot needed (`actor: 'user_self'` per spec line 408); the
  //    same coarse cell admits. The (chat, user_self) cell tightens
  //    further than (user, user_self) — `destructive` is hard-denied
  //    on chat, allowed-with-approval on user.
  //  - `POLICY_GATED_CONTRACT_CHANNELS` (mcp): the producer-resolved
  //    `request.contract_snapshot` is authoritative via
  //    `allowed_tools` per-tool allowlist (spec line 425: "the
  //    contract IS the gate").
  // Other channels still rely on per-channel handlers or are
  // unrestricted at the recipe-runner layer. When the gate denies any
  // ingredient step, the recipe never enters `executeRecipe`: we emit
  // lifecycle `error`, append a failed audit row capturing the denial
  // summary, and return a failure response so the upstream dispatcher
  // (scheduler / auto-run scheduler / chat-orchestrator / mcp-server /
  // rpc execute / API caller) surfaces the deny like any other recipe
  // error.
  const executionSource = request.execution_source;

  // D-145 engine-wiring (D-153 P1 + slice 2) — commit-substrate
  // identity. Derive the run's three-tier session IDs from the typed
  // `ExecutionSource` ONCE here, then stamp the result on every
  // audit/commit row this run writes — the success path below + the
  // policy-gate-denial path. `channel_session_id` is the channel's own
  // boundary; `correlation_id` groups dispatches in that boundary into
  // ~1-min intent bursts (the unit save-as-Recipe operates on).
  // Populating them feeds the P1.B `json_extract` tier indexes that
  // back the `AuditLogStore.listBy*` queries, empty since P1. Slice 2
  // additionally persists the full `execution_source` itself —
  // run-level (one dispatch origin per run), so `actor` + the
  // channel-specific identifying fields stay recoverable. `commit_kind`
  // is deliberately NOT stamped: it is per-tool-call and stays
  // undefined on the recipe-run row until the Gateway dispatch-outbox
  // writes real per-call commits (D-153 open question
  // #23). Absent `execution_source` (dispatch paths whose P2.C slice
  // has not landed) leaves the fields undefined — legacy rows, which
  // the P1.B queries already tolerate. The correlation tracker is hit
  // exactly once per `handleExecute` so one dispatch advances one
  // intent-burst slot regardless of which audit path writes the row.
  const commitFields: CommitSubstrateFields = {};
  // D-145 engine-wiring slice 3b.3 — the commit Gateway's per-run
  // identity. Built from the SAME derived session IDs `commitFields`
  // carries, so a run's commits and its audit row agree. Stays
  // undefined when the dispatch carried no typed `ExecutionSource` (a
  // P2.C slice that has not landed) — the Gateway then degrades to a
  // no-op pass-through and the run writes no commits.
  let runIdentity: CommitRunIdentity | undefined;
  if (executionSource !== undefined) {
    const channel_session_id = deriveChannelSessionId(executionSource);
    const correlation_id = correlationTracker.assign(
      channel_session_id,
      Date.now(),
    );
    commitFields.channel_session_id = channel_session_id;
    commitFields.correlation_id = correlation_id;
    // Slice 2 — persist the full typed source, not just its derived
    // `channel_session_id`. Run-level: one dispatch origin per run.
    commitFields.execution_source = executionSource;
    runIdentity = buildCommitRunIdentity({
      request_id: run_id,
      source: executionSource,
      channel_session_id,
      correlation_id,
      // D-161 N.4 — stamp the snapshot only when the source carries a
      // contract_id (a snapshot on a contract-free commit is incoherent —
      // present iff contract_id is set).
      ...(executionSourceHasContract(executionSource)
        && request.contract_snapshot !== undefined
        ? { contract_snapshot: request.contract_snapshot }
        : {}),
      // D-160 P3 — thread the I-7 loop-bound hop token. Undefined on
      // the pre-O-5 dispatch paths (the channels are not yet wired to
      // `handleExecute`) → `buildCommitRunIdentity` defaults it to `0`,
      // a top-level run.
      dispatch_depth: request.dispatch_depth,
      // R2 step 6 — a saga compensation run links the commit it undoes
      // onto every commit it dispatches. Internal-only channel; absent
      // on every normal run.
      ...(internal.predecessor_commit_id !== undefined
        ? { predecessor_commit_id: internal.predecessor_commit_id }
        : {}),
    });
  }
  // Contract-bearing commits carry the dispatch-time `ContractSnapshot`
  // (spec line 429) so audit + save-as-Recipe stay interpretable after
  // the contract is revoked / version-bumped. The producer resolves it
  // (mcp today); pass it straight through when present. D-161 N.4 — a
  // snapshot belongs on a commit iff its source carries a contract_id, so
  // a snapshot supplied for a contract-free source is dropped; the legacy
  // no-typed-source passthrough is preserved (it writes no commits).
  if (
    request.contract_snapshot !== undefined
    && (executionSource === undefined || executionSourceHasContract(executionSource))
  ) {
    commitFields.contract_snapshot = request.contract_snapshot;
  }

  if (executionSource !== undefined) {
    const isSystemGated = POLICY_GATED_SYSTEM_CHANNELS.has(executionSource.channel);
    const isUserGated = POLICY_GATED_USER_CHANNELS.has(executionSource.channel);
    const isContractGated = POLICY_GATED_CONTRACT_CHANNELS.has(executionSource.channel);
    if (isSystemGated || isUserGated || isContractGated) {
      // D-153 P2.C — pre-execution config-ref resolver. Kernel recipes
      // (notably `run-ingredient`, dispatched by every MCP per-
      // ingredient tool) pin the real ingredient via `config.X` rather
      // than hard-coding it in the recipe. At gate time both the
      // template + the substituted config value are known, so the
      // resolver hands the gate the real slug to evaluate against
      // `allowed_tools` / coarse `allowed_kinds × allowed_risk_tiers`.
      const resolveConfigRef = (template: string): string | undefined => {
        const match = /^\{\{\s*config\.([^}\s]+)\s*\}\}$/.exec(template);
        if (!match) return undefined;
        const value = (request.config as Record<string, unknown> | undefined)?.[match[1]!];
        return typeof value === 'string' ? value : undefined;
      };
      // D-187 slice 5 — the static walk's APPROVAL is op-risk × stage-trust
      // (`admitByOpRisk`, slice 4); the retired `policy_matrix` baseline + per-step
      // `.<contract_id>` overlay cell no longer feed the decision, so the `scan` /
      // overlay-cell resolver args are gone (slice 4 left them unconsumed; slice 5
      // removes the plumbing). The authoritative ACCESS gate (op-admission, Layer 1)
      // fires per-call at the gateway, not in this pre-run walk.
      const gateResult = gateRecipeAgainstPolicy(
        recipe,
        executionSource,
        (slug) => deps.executorConfig.manifests.get(slug) ?? undefined,
        // Snapshot is mandatory for any source carrying a contract_id — the gate
        // throws when contract-bearing + absent (D-161 N.4: a `contracted_user`
        // OR a self-restricted `user_self`). A contract-free source ignores it;
        // passing `undefined` matches the system / unrestricted-user_self path.
        executionSourceHasContract(executionSource) ? request.contract_snapshot : undefined,
        resolveConfigRef,
      );
      if (!gateResult.admit) {
        return await handlePolicyGateDenial({
          deps,
          recipe,
          request,
          denials: gateResult.denials,
          lifecycle_run_id,
          run_id,
          dish_id,
          recipe_insight_id,
          commitFields,
        });
      }
    }
  }

  // D-136 P7.E §A.13.5 — when the recipe was triggered via MCP, gate
  // every enrichment read on the topic's `mcp_exposed` policy. The
  // engine's `readEnrichmentRow` (`enrichment-or-fetch` transform path)
  // wraps via `createEnrichmentReader(..., { gate_mcp_private: true })`;
  // the kernel `enrichment-list` ingredient path picks up the same
  // gate via the threaded `trigger_source` in StepMeta (kernel.ts ➜
  // bin.ts ➜ handleEnrichmentList).
  const isMcpTriggeredRecipe = request.trigger_source === 'mcp';

  // D-157 P1 slice 4 — per-call admission probe. Closes over the run's
  // typed `ExecutionSource` + the manifest registry so the gateway can
  // evaluate `(channel × actor × contract_id)` for the *real* ingredient
  // slug at dispatch time (vs. the static pre-run walk that fires once
  // upstream). Returns `null` when the slug is unknown — the gateway
  // treats null as admit (the dispatch will hit the executor's own
  // missing-manifest path, which is the right surface for that error).
  // The closure is constructed only when the static walk has already
  // run for this source (the same `POLICY_GATED_*` channel sets) so
  // per-call probing stays in lockstep with the static gate.
  const evaluateAdmission:
    | ((
        slug: string,
        input: Record<string, unknown>,
        operationId?: string,
      ) => AdmissionDecision | null)
    | undefined =
    executionSource !== undefined
      && (POLICY_GATED_SYSTEM_CHANNELS.has(executionSource.channel)
        || POLICY_GATED_USER_CHANNELS.has(executionSource.channel)
        || POLICY_GATED_CONTRACT_CHANNELS.has(executionSource.channel))
        ? (() => {
            // Per-slug admission probe — the single primitive both the
            // dispatched tool AND a SECONDARY op (D-172 P2 `data-file-read`,
            // below) run through, so a mail-send carrying attachments is gated
            // on the SAME `(channel × actor × contract_id)` policy the
            // `data-file-read` ingredient dispatch would be. Returns null when
            // the slug is unknown (the gateway treats null as admit — the
            // dispatch hits the executor's own missing-manifest surface).
            const admitOne = (
              slug: string,
              input: Record<string, unknown>,
              // Grant-foundation slice 2a — the dispatch's short `operations`-map
              // key (the Gateway forwards `surface_operation_key` for catalog
              // surface dispatches). Resolved to the DECLARED `operation_id` below
              // (the format a standing contract's `scope.operation_ids` is authored
              // with — codex slice-2a fold) and threaded into the overlay resolve so
              // a standing contract scoped to specific ops admits only those.
              // Absent (a simple-form dispatch, or the secondary `data-file-read`
              // probe below) ⇒ the body derives the op id from the kernel backing
              // slug (slice 2b, `kernelOpForBackingSlug`); only a NON-kernel
              // simple-form slug stays op-unprovable (an op-scoped contract fails
              // closed there).
              operationId?: string,
            ): AdmissionDecision | null => {
              const manifest = deps.executorConfig.manifests.get(slug);
              if (!manifest) return null;
              // D-161 N.4 — a source carrying a contract_id (a `contracted_user`
              // OR a self-restricted `user_self`) forwards its snapshot; the gate
              // throws when contract-bearing + absent. Channel-agnostic, matching
              // the static walk above.
              const hasContract = executionSourceHasContract(executionSource);
              // D-166 contract_definition — resolve the active, in-scope
              // `.<contract_id>` overlay for THIS dispatch (the per-call boundary).
              // `cell` tightens the decision. The use-counter decrement is NOT here
              // anymore: it moved to the gateway's actual-proceed point
              // (`recordDispatchUse`, built below) so an approval-resumed dispatch is
              // counted — the probe can't see that path (see the note after the
              // `evaluatePreflightAdmission` call).
              // Resolve the dispatched op's id for the op-admission gate
              // (`isOpGranted`, below — the overlay no longer takes it; the op axis
              // retired from `resolve` when `contract_grant` became the sole op
              // authority, home #2):
              //  - catalog / surface dispatch (operationId set) → the short
              //    surface op key → its DECLARED `operation_id`
              //    (`manifest.operations[key].operation_id ?? key`, the canonical
              //    pattern — raw-op-dispatch.ts:595, saga-reconciliation.ts:257);
              //  - simple-form dispatch (no surface key) → grant-foundation slice
              //    2b: derive the `core.*` op id from the kernel backing slug
              //    (`mail-send` → `core.mail.send`) so an op-scoped standing
              //    contract can match kernel ops. A non-kernel simple-form slug
              //    stays undefined → the op gate is a no-op (returns granted), so
              //    the policy decision stands unchanged.
              // Catalog vs core.* are mutually exclusive (catalog sets the surface
              // key, core.* leaves it undefined), so the branches never race.
              const overlayOpId =
                operationId !== undefined
                  ? manifest.operations?.[operationId]?.operation_id ?? operationId
                  : kernelOpForBackingSlug(slug);
              // M-ENFORCE-2 — derive the `data.*` / `connection.*` scope path this
              // dispatch targets from the manifest kind + the RESOLVED `input`
              // (`input.connection_kind` for a connection call — the same value the
              // adapter dispatches on). `null` (every non-storage/-connection kind)
              // means "scope axis N/A"; `evaluatePreflightAdmission` then gates it
              // against the snapshot's `scope_restrictions` (slice 5: the per-door
              // collection fence, now derived from `data.<collection>` grant rows).
              const scopePath = deriveDispatchScope(
                { kind: manifest.kind, slug },
                input,
              );
              const ownerOverride = !isCatalogForm(manifest)
                ? readOwnerOperationOverride({
                    scan: deps.contractScan,
                    ingredient_id: slug,
                    operation_id: slug,
                  })
                : undefined;
              const preflightDecision = evaluatePreflightAdmission({
                source: executionSource,
                tool: {
                  slug,
                  kind: manifest.kind,
                  risk_tier: manifest.risk_tier,
                },
                ...(hasContract && request.contract_snapshot !== undefined
                  ? { contract_snapshot: request.contract_snapshot }
                  : {}),
                // M-ENFORCE-2 — the derived `data.*` / `connection.*` scope path,
                // gated against the snapshot's `scope_restrictions` (the per-door
                // collection fence). Rate-limit throttling was the deferred SIBLING
                // axis and is now retired: the policy-matrix retirement removed the
                // cell-level rpm/daily ceiling + the `evaluateRateLimit` primitive.
                // Dispatch volume stays AUDITED (every dispatch writes a commit row),
                // reconstructable from the commit log after the fact.
                ...(scopePath !== null ? { scope_path: scopePath } : {}),
                // D-211 §7.2 — simple-form ingredients are one operation keyed
                // by their slug. Catalog-form dispatch is ruled later by the
                // catalog gateway against the resolved operation id, so never
                // apply an ingredient-level approximation here.
                ...(ownerOverride !== undefined
                  ? { owner_override: ownerOverride }
                  : {}),
              });
              // D-187 AMENDMENT 3b — op-admission grant gate. Layer the unified grant
              // store's `op` entry ON TOP of the policy decision: if the dispatch's
              // governing contract (the owner for `(chat | messenger, user_self)`, a door
              // for a `contracted_user`, none for the contract-free HID / system channels)
              // holds an explicit REVOKE for this op, DENY (`op_not_granted`) — even when
              // the cell + snapshot would admit. The gate can only TIGHTEN: a `deny` stays
              // a deny, and an undefined `overlayOpId` / contract-free source is a no-op
              // (the gate returns granted). The owner is permissive by default + the boot
              // reconcile seeds it complete, so this denies only an explicit owner revoke
              // (or a future door revoke) — behavior-preserving at zero installs.
              // D-188 — the master pause is a COARSER gate than the per-op
              // grant: when the server is paused, every GOVERNED dispatch
              // (owner-AI + doors) is frozen regardless of its grant rows.
              // Checked first so a paused server reads as `server_paused`
              // (its honest reason), never `op_not_granted`. Contract-free
              // sources bypass (see `isFrozenByPause`).
              if (
                preflightDecision.verdict !== 'deny'
                && deps.opAdmissionGate?.isFrozenByPause(executionSource)
              ) {
                return Object.freeze({
                  verdict: 'deny',
                  code: 'server_paused',
                  detail:
                    'server is paused — contracted and AI operations are halted until the owner resumes',
                });
              }
              if (
                preflightDecision.verdict !== 'deny'
                && deps.opAdmissionGate
                && !deps.opAdmissionGate.isOpGranted(executionSource, overlayOpId)
              ) {
                return Object.freeze({
                  verdict: 'deny',
                  code: 'op_not_granted',
                  detail: `operation '${String(overlayOpId)}' is not granted to this dispatch's governing contract (revoked)`,
                });
              }
              return preflightDecision;
            };
            return (
              slug: string,
              input: Record<string, unknown>,
              // Grant-foundation slice 2a/2b — forwarded to `admitOne` for the
              // PRIMARY dispatch. The secondary `data-file-read` probes below
              // pass no surface op key, but `admitOne` now derives the kernel op
              // id from the slug (slice 2b), so they gate as
              // `core.storage.data-file-read` on the op axis — exactly the
              // D-172 I-4 intent (the inner file read is independently
              // op-scopable, not silently op-exempt).
              operationId?: string,
            ): AdmissionDecision | null => {
              // D-172 P2 (review F2) — a `mail-send` carrying `attachments`
              // reads `data.file` content bytes out of the warehouse INSIDE
              // `MailCollection.send` (via the otherwise-ungated
              // `handleFileRead`). That inner read MUST be policy-gated for THIS
              // call's `(channel × actor × contract_id)` scope, exactly as a
              // first-class `data-file-read` ingredient dispatch would be —
              // otherwise an actor granted `mail-send` but DENIED
              // `data-file-read` could exfiltrate arbitrary file bytes by
              // attaching them (D-172 I-4 / A.8: file content leaves the
              // warehouse ONLY through the policy-gated, audited file.read).
              // We compose the gate at the boundary: the mail-send dispatch is
              // admissible only if `data-file-read` is ALSO admissible. A
              // `data-file-read` DENY short-circuits and is returned, so the
              // gateway raises `PreflightDeniedError` BEFORE the inner dispatch
              // ever reaches `MailCollection.send` → `provider.send` is never
              // called (fail-closed). A non-deny `data-file-read` verdict
              // (`'ask'` — unreachable for the `read` tier today, but treated
              // conservatively) likewise blocks the read by surfacing through
              // the send's own decision; only an explicit `data-file-read`
              // ADMIT lets the send fall through to its own admission.
              //
              // Review F2 finding A — the attachment-presence test MUST mirror
              // EXACTLY what the kernel `mail-send` case treats as attachment-
              // bearing: `coerceStringArray` (packages/ingredients/src/kernel.ts)
              // accepts a SINGLE STRING (`attachments: 'file:abc'` → `['file:abc']`)
              // as well as a non-empty array, and forwards it to
              // `MailCollection.send` → `handleFileRead`. A test keyed on
              // `Array.isArray(...)` alone would let a STRING attachment skip this
              // probe and read file bytes ungated. So: a non-empty STRING or a
              // non-empty ARRAY both count as attachment-bearing here.
              if (
                isOutboundSendSlug(slug)
                && slug === 'mail-send'
                && hasMailSendAttachment(input.attachments)
              ) {
                const fileReadDecision = admitOne(
                  DATA_FILE_READ_INGREDIENT_SLUG,
                  // The secondary op's own input shape — a single `record_id`
                  // read. `deriveDispatchScope` ignores the input for a
                  // `storage`-kind op (`data-file-read` resolves to the fixed
                  // `data.file` scope — review F2.B special-case), so the per-ref
                  // record_id is immaterial to the policy cell — one probe covers
                  // every ref, since they all target the same `data-file-read`
                  // scope under the same cell. The gate is the SAME
                  // `evaluatePreflightAdmission` the `data-file-read` ingredient
                  // dispatch runs through: the contract's per-tool `allowed_tools`
                  // (and any `data.file` `scope_restrictions`) decide it.
                  { record_id: '' },
                );
                // Review F2 finding C — a `null` `data-file-read` decision means
                // the `data-file-read` MANIFEST is absent from the registry. We
                // must NOT fall through to the mail-send admission on null: the
                // inbound file collection + `fileReadDeps` register off
                // `cacheBlobs`, INDEPENDENT of manifest loading (and the manifest
                // loader silently skips missing / malformed bundled JSON). So a
                // packaging / registry drift can leave `data.file` READABLE while
                // the gate's secondary probe goes blind — re-opening the F2 hole.
                // Fail CLOSED: if we cannot evaluate the file-read policy, we must
                // not let the attachment read happen. Synthesize a `deny` (reusing
                // the `tool_not_in_contract` code `admitOne` returns when a tool is
                // not grantable) so the gateway raises `PreflightDeniedError`
                // before `MailCollection.send`. On a genuinely file-substrate-less
                // build the send would fail at `MailCollection.send` with
                // `MAIL_SEND_ATTACHMENT_UNRESOLVABLE` anyway (no file-read deps
                // wired) — denying earlier at the gate is the same outcome,
                // fail-closed.
                // The secondary `data-file-read` probe is a HARD precondition for
                // an attachment-bearing mail-send: it must ADMIT outright. Three
                // non-admit verdicts, handled distinctly so each keeps its precise
                // fail-closed cause:
                //
                // Review F2.C — `null` = the `data-file-read` MANIFEST is absent
                // (packaging/registry drift: the file collection + fileReadDeps
                // register off `cacheBlobs`, INDEPENDENT of manifest loading, and
                // the loader silently skips malformed bundles). We can't evaluate
                // the policy, so we must not read → synthesized deny.
                if (fileReadDecision === null) {
                  return {
                    verdict: 'deny',
                    code: 'tool_not_in_contract',
                    detail:
                      `mail-send carries attachments but the '${DATA_FILE_READ_INGREDIENT_SLUG}' ` +
                      `policy could not be evaluated (manifest absent) — refusing the file read fail-closed (D-172 review F2.C)`,
                  };
                }
                // Review F2 (3rd pass, resume-path ask-leak) — an `ask` must NOT
                // be returned verbatim. The gateway would treat it as an ask for
                // the OUTER `mail-send` slug, PAUSE the run, and on resume the
                // mail-send approval grant (`stepMeta.preflight_admitted`, target
                // slug `mail-send`) would satisfy it — a mail-send approval
                // DOUBLING as the `data-file-read` approval, never producing an
                // explicit data-file-read admit. `ask` IS reachable: a contract
                // with `approval_required: ['read']` makes `data-file-read`
                // (risk_tier `read`) ask. Convert it to a synthesized deny so no
                // pausable mail-send ask is ever created — a read that needs
                // approval must be granted to `data-file-read` directly, not ridden
                // on the mail-send approval.
                if (fileReadDecision.verdict === 'ask') {
                  return {
                    verdict: 'deny',
                    code: 'tool_not_in_contract',
                    detail:
                      `mail-send carries attachments but '${DATA_FILE_READ_INGREDIENT_SLUG}' did not admit ` +
                      `(verdict: ask — requires approval) — refusing the file read fail-closed; grant ` +
                      `'${DATA_FILE_READ_INGREDIENT_SLUG}' directly rather than approving it via the mail-send ` +
                      `grant (D-172 review F2 resume-path ask-leak)`,
                  };
                }
                // A genuine `deny` is SAFE returned verbatim: a deny is TERMINAL
                // (the gateway raises `PreflightDeniedError`, no pause/resume), so
                // there is no conflation risk — and verbatim preserves the SPECIFIC
                // cause (allowlist `tool_not_in_contract` or scope
                // `scope_not_in_restrictions` on `data.file`) for the audit/error.
                if (fileReadDecision.verdict !== 'admit') {
                  return fileReadDecision;
                }
              }
              // D-172 P5 / N.8 (codex P1 cache-bypass fold) — the SECOND
              // secondary `data-file-read` op: an `ai-*` call whose `llm.data`
              // resolves to a `data.file` ref. The LLM adapter reads its content
              // bytes (`resolveAiFileRef`) and the ai result is CACHEABLE
              // (category 'ai', risk 'read'), so a later actor admitted for the
              // ai-* tool but DENIED `data-file-read` could be served the prior
              // authorized run's file-derived result from the L1 ingredient
              // cache / peer query WITHOUT reaching the in-adapter gate. Gate it
              // HERE — the gateway boundary runs BEFORE the L1 cache + peer query
              // (it is the OUTERMOST executor wrapper), so a deny short-circuits
              // before any cached file-derived content is served, exactly as the
              // mail-send attachment case above. (The L2 stepCache, which
              // short-circuits before the gateway, is closed by the ai-* L2
              // exclusion in the stepCache wiring.)
              //
              // The gateway passes RAW input (refs resolve in the dispatch
              // layer), so a dynamic `llm.data: '{{step.f}}'` is a template
              // STRING here. Resolve BOTH `llm.data` AND `llm.content_parts`
              // against the run stores (the SAME `resolveDeep` the adapter's
              // resolver uses) and gate on the RESOLVED values, because
              // `resolveAiFileRef` decides whether to read the file off the
              // RESOLVED input:
              //   - a dynamic `llm.data` ref → resolve before the file-ref test,
              //     else dynamic refs (the common authoring shape) slip the gate;
              //   - `content_parts` must be tested RESOLVED too — a ref that
              //     resolves to `undefined` (e.g. `{{context.missing}}`) is
              //     PRESENT raw but absent to the adapter, which then reads the
              //     file. Skipping the gate on the raw-present-but-resolved-absent
              //     `content_parts` would let a denied actor be served a cached
              //     file-derived ai result (same resolved cache key) — the codex
              //     P1 review-2 bypass. So skip ONLY when the RESOLVED
              //     `content_parts` is non-undefined (the adapter then skips the
              //     read → no file content → no probe needed).
              // A non-file `llm.data` (text) resolves to a non-file value →
              // `extractFileRecordId` null → no probe → the ai-* call is admitted
              // on its own merits (a narrow actor's text ai-* is never blocked).
              if (isBatchCapableAISlug(slug)) {
                const resolvedAi = resolveDeep(
                  { d: input['llm.data'], cp: input['llm.content_parts'] },
                  stores,
                ) as { d: unknown; cp: unknown };
                if (resolvedAi.cp === undefined && extractFileRecordId(resolvedAi.d) !== null) {
                  // The same fixed `data.file` scope as the mail-send case
                  // (`deriveDispatchScope` ignores the record_id for `data-file-read`,
                  // review F2.B), so one probe covers the ref.
                  const fileRefDecision = admitOne(DATA_FILE_READ_INGREDIENT_SLUG, { record_id: '' });
                  // Fail-closed handling identical to the mail-send case: `null`
                  // (manifest absent), `'ask'` (grant `data-file-read` directly,
                  // never ride the ai-* grant), and `'deny'` all block the read.
                  if (fileRefDecision === null) {
                    return {
                      verdict: 'deny',
                      code: 'tool_not_in_contract',
                      detail:
                        `ai-* '${slug}' reads a 'data.file' ref but the '${DATA_FILE_READ_INGREDIENT_SLUG}' `
                        + `policy could not be evaluated (manifest absent) — refusing the file read fail-closed `
                        + `(D-172 review F2.C / P1 cache-bypass fold)`,
                    };
                  }
                  if (fileRefDecision.verdict === 'ask') {
                    return {
                      verdict: 'deny',
                      code: 'tool_not_in_contract',
                      detail:
                        `ai-* '${slug}' reads a 'data.file' ref but '${DATA_FILE_READ_INGREDIENT_SLUG}' did not `
                        + `admit (verdict: ask — requires approval) — refusing fail-closed; grant `
                        + `'${DATA_FILE_READ_INGREDIENT_SLUG}' directly rather than via the ai-* grant `
                        + `(D-172 P1 cache-bypass fold)`,
                    };
                  }
                  if (fileRefDecision.verdict !== 'admit') {
                    return fileRefDecision;
                  }
                }
              }
              // D-166 — the use-counter decrement that used to live here (gated on
              // the `'admit'` verdict) moved to the gateway's actual-proceed point
              // via `recordDispatchUse` (built below). The probe never observed the
              // approval-resume path: a paused dispatch re-enters with the SAME
              // `'ask'` verdict and is admitted by the engine's resume grant
              // (`stepMeta.preflight_admitted`) INSIDE the gateway, so the
              // `'admit'`-gated record never fired for it — an undercount. The
              // proceed point IS reached on a resumed-and-approved dispatch, so
              // recording there counts every boundary-crossing dispatch exactly once
              // (success, failure, or in_doubt — spec :253) and never on the static
              // pre-run walk (this probe is the per-dispatch boundary, spec :251; the
              // walk is per-run).
              return admitOne(slug, input, operationId);
            };
          })()
        : executionSource === undefined
          && request.trigger_source === 'housekeeping'
          ? (slug: string): AdmissionDecision | null => {
              const manifest = deps.executorConfig.manifests.get(slug);
              // Catalog-form dispatch performs its operation-specific lookup in
              // catalog-gateway. Preserve every pre-D-211 source-less simple
              // dispatch unless a global exact-operation ruling exists.
              if (!manifest || isCatalogForm(manifest)) return null;
              const ownerOverride = readOwnerOperationOverride({
                scan: deps.contractScan,
                ingredient_id: slug,
                operation_id: slug,
              });
              if (ownerOverride === undefined) return null;
              return admitByOpRiskWithoutQualityLifts({
                slug,
                risk_tier: manifest.risk_tier,
                ceiling: CONTRACTED_DEFAULT_TRUST_CEILING,
                owner_override: ownerOverride,
                offer_owner_override: true,
              });
            }
          : undefined;

  // D-196 — reserve a deferred direct-MCP base +1 at the REAL post-approval
  // proceed point (idempotent with an outer reservation). If the dispatch is a
  // D-162 batch whose multiplicity came from caller-owned wire input — including
  // through a transform/AI/foreach step graph — reserve N-1 more before any effect. The
  // request-local session commits only when the enclosing MCP call completes,
  // so a later run failure/cancellation releases all N.
  const customerUsageForDispatch = deps.customerUsage;
  const reserveDispatchUsage: NonNullable<
    Parameters<typeof wrapWithCommitGateway>[1]['reserveDispatchUsage']
  > | undefined =
    customerUsageForDispatch !== undefined
    && executionSource?.channel === 'mcp'
      ? (slug, unresolvedInput, surfaceOperationKey, stepId): void => {
          const reserveBase = (): void => {
            const admission = customerUsageForDispatch.reserveOnce(
              DIRECT_MCP_TOOL_CALL_BASE_RESERVATION_KEY,
              {
                tool_name: 'direct-mcp-business',
                usage_kind: 'tool_call',
                units: 1,
              },
            );
            if (!admission.admitted) {
              throw new RpcError(
                'usage_limit_exceeded',
                admission.message,
                429,
              );
            }
          };
          if (!isBatchCapableAISlug(slug)) {
            reserveBase();
            return;
          }
          const manifest = deps.executorConfig.manifests.get(slug);
          if (!manifest) {
            reserveBase();
            return;
          }
          const merged = mergeManifestStepInput(manifest.input, unresolvedInput, {
            trustedSurfaceDispatch: surfaceOperationKey !== undefined,
          });
          const customerControlled =
            customerUsageInlineRecipe
            || customerControlsD162Batch({
              recipe,
              mergedArgs: merged,
              callerRootKeys: customerUsageCallerRootKeys,
              ...(stepId !== undefined ? { stepId } : {}),
              getIngredientKind: (s) =>
                deps.executorConfig.manifests.get(s)?.kind,
              getIngredientManifestInput: (s) =>
                deps.executorConfig.manifests.get(s)?.input,
            });
          // Seller-authored literal/IO fan-out is one outer call. Avoid even
          // resolving its values (which can include vault refs) when no caller
          // authority can affect multiplicity.
          if (!customerControlled) {
            reserveBase();
            return;
          }
          const resolved = resolveDeep(merged, stores) as Record<string, unknown>;
          if (
            isAIBatchMode(resolved)
            && (resolved['llm.data'] as unknown[]).length === 0
          ) {
            const marked = customerUsageForDispatch.markZeroUnitReservation(
              DIRECT_MCP_TOOL_CALL_BASE_RESERVATION_KEY,
            );
            if (!marked.admitted) {
              throw new RpcError(
                'usage_limit_exceeded',
                marked.message,
                429,
              );
            }
            return;
          }
          reserveBase();
          const extraUnits = customerControlledD162ExtraUnits({
            slug,
            resolvedInput: resolved,
            customerControlled,
          });
          if (extraUnits === 0) return;
          const admission = customerUsageForDispatch.reserve({
            tool_name: `batch.call:${slug}`,
            usage_kind: 'tool_call',
            units: extraUnits,
          });
          if (!admission.admitted) {
            throw new RpcError(
              'usage_limit_exceeded',
              admission.message,
              429,
            );
          }
        }
      : undefined;

  // D-166 — record one contract use at the gateway's actual-proceed point
  // (the relocation of the decrement OFF the per-call probe above). The
  // closure re-resolves the active, in-scope `.<contract_id>` overlay per
  // slug — a cheap synchronous `contract_definition` store get — and
  // decrements the matched contract's `uses_remaining`. The gateway fires
  // it once per dispatch that crosses the boundary (success, failure, OR
  // in_doubt), so an approval-resumed dispatch (verdict still `'ask'`,
  // admitted via the resume grant) is now counted — closing the undercount
  // the probe-time record left open. Gated to the same (executionSource ×
  // POLICY_GATED channel) set as `evaluateAdmission`, plus an overlay
  // resolver to record against; absent ⇒ nothing to record (additive,
  // exactly as before a contract is minted). `executionSource` +
  // `overlayForUse` are `const`s narrowed by the ternary condition, so the
  // closure captures them non-undefined without `!`.
  const overlayForUse = deps.contractOverlay;
  const recordDispatchUse: ((slug: string) => void) | undefined =
    executionSource !== undefined
    && overlayForUse !== undefined
    && (POLICY_GATED_SYSTEM_CHANNELS.has(executionSource.channel)
      || POLICY_GATED_USER_CHANNELS.has(executionSource.channel)
      || POLICY_GATED_CONTRACT_CHANNELS.has(executionSource.channel))
      ? (slug: string): void => {
          // Meter the contract's use iff the overlay reports this dispatch meterable.
          // No op id is threaded: the metering op axis RETIRED (home #2 —
          // `contract_grant` owns op admission), so `shouldMeterUse` gates on
          // channel×actor×ingredient, not op; the former slice-2a op-id mirror is
          // moot. An op-PRESENT out-of-scope op never reaches here (the op gate
          // denies it before the proceed point). An op-ABSENT dispatch by an
          // op-scoped contract DOES meter — a fail-safe over-count, spec `:253`
          // "every dispatch decrements". (The gateway still passes an `operationId`
          // arg per the seam type; it is ignored.)
          if (overlayForUse.shouldMeterUse(executionSource, slug)) {
            overlayForUse.recordUse(executionSource);
          }
        }
      : undefined;

  // D-177 P2 — the Gateway's session-grant seam (N.4). The Gateway hands its
  // per-call envelope fields (slug / trusted op key / resolved connection /
  // risk tier / P1b hashes / run identity); this closure completes the match
  // context with the run's RECIPE identity — `bound_recipe` pins BOTH halves,
  // so a re-authored recipe (different content hash) fails the match and
  // holds for a fresh approval. `hashRecipe` is deterministic, so it is
  // memoized once per run (every dispatch shares it; computed lazily on the
  // first ask-branch lookup — admit/deny verdicts never pay it). Wired only
  // when a resolver is present (`sessionGrantResolverForRun` is the narrowed
  // const the closures capture, mirroring `overlayForUse` above); absent ⇒
  // the Gateway dep is omitted and every `ask` holds exactly as pre-D-177.
  const sessionGrantResolverForRun = deps.sessionGrantResolver;
  // D-202 task 4a — the narrowed quality-delegation resolver the gateway
  // closure captures (mirroring `sessionGrantResolverForRun`); absent ⇒ the
  // Gateway's quality dep is omitted and every `ask` holds exactly as pre-D-202.
  const qualityGateResolverForRun = deps.qualityGateResolver;
  let runRecipeHashMemo: string | undefined;
  // D-177 P3 — at-most-one-grant-per-approval: a `foreach` gated step
  // re-dispatches per iteration, each carrying the same resume markers, and
  // the one upstream approval mints exactly one grant — the FIRST iteration's
  // envelope (the only coherent `'exact'`-mode choice; multi-item coverage is
  // P5a's batch mode). Per-run closure state, so a fresh run never inherits it.
  let sessionGrantMinted = false;
  // D-177 P5a — per-run claim memo: a `foreach` gated step re-dispatches
  // per iteration, each carrying the SAME `preflight_batch_claim` marker;
  // one member covers the whole gated step (exactly as one approval does
  // today), so the first iteration claims durably and the rest ride it.
  // Per-run closure state — a fresh run (or an agent replay, which is a
  // separate run) never inherits the memo and must claim for itself.
  const claimedBatchMembers = new Set<string>();
  // D-177 N.11 rule 5 (slice D) — the per-session forwarded-sender candidate
  // lookup, paired with the gateway-extracted `destination_emails` on the
  // match context AND the consume call (containment checked at match,
  // RE-VERIFIED at the store — 5.a). Attached only when the dispatch carries
  // destinations (a destination-less envelope can never scoped-match, so the
  // lookup is skipped); a throwing lookup degrades to no candidates (the
  // scoped arm fails closed to ask).
  const scopedCandidatesFor = (
    channel_session_id: string | undefined,
  ): ReadonlyArray<ScopedSenderCandidate> | undefined => {
    if (deps.scopedSenderCandidates === undefined) return undefined;
    if (channel_session_id === undefined) return undefined;
    try {
      return deps.scopedSenderCandidates(channel_session_id);
    } catch {
      return undefined;
    }
  };
  // D-177 N.14 — the door-binding supply: a DOOR dispatch carries its governing
  // contract id into every grant match / mint / consume, where the matcher's
  // asymmetric door clauses bind on it (a bound grant requires equality; a door
  // ctx never matches an unbound grant). Owner / contract-free runs supply
  // nothing — existing user_self grants match byte-identically.
  //
  // N.14.6 — the door families are the reception visitor (`anonymous`) and the
  // DELEGATED mcp bearer. The mcp arm cannot be read off the actor: the channel
  // forces the owner's own stdio client to `contracted_user` + a `contract_id`
  // too, so `isDoorDispatchSource` consults the token. Classify with the SHARED
  // predicate, never by hand here.
  const doorRunSource = runIdentity?.source;
  const doorSourceContractId =
    doorRunSource !== undefined && isDoorDispatchSource(doorRunSource)
      ? executionSourceContractId(doorRunSource)
      : undefined;
  // The owner-vs-door discriminator itself, threaded to the matcher's door
  // clause. Supplied on EVERY mcp dispatch (owner included): absence means
  // "delegated" there, so omitting it would strip the owner's own client of its
  // grants — loudly, which is the failure direction we chose.
  const doorRunMcpTokenId =
    doorRunSource !== undefined && doorRunSource.channel === 'mcp'
      ? doorRunSource.mcp_token_id
      : undefined;
  const sessionGrants:
    | {
        match: (call: SessionGrantGateCall) => string | null;
        consume: (
          contract_id: string,
          call?: {
            canonical_payload_hash?: string;
            pinned_projection_hash?: string;
            destination_emails?: ReadonlyArray<string>;
          },
        ) => boolean;
        claimBatchMember: (
          contract_id: string,
          member_id: string,
          call: { arg_shape_hash: string; canonical_payload_hash: string },
        ) => boolean;
        mint: (call: SessionGrantMintGateCall) => void;
      }
    | undefined =
    sessionGrantResolverForRun !== undefined
      ? {
          match: (call: SessionGrantGateCall): string | null => {
            // Slice D — pair the gateway-extracted destinations with the live
            // per-session sender candidate index (the 5.d containment inputs).
            const candidates =
              call.destination_emails !== undefined
                ? scopedCandidatesFor(call.channel_session_id)
                : undefined;
            return sessionGrantResolverForRun.match({
              ...call,
              ...(candidates !== undefined
                ? { scoped_sender_candidates: candidates }
                : {}),
              // N.14 — the door binding (host-supplied off the run's own
              // source; the gateway call never carries it).
              ...(doorSourceContractId !== undefined
                ? { source_contract_id: doorSourceContractId }
                : {}),
              // N.14.6 — the owner-vs-door discriminator the door clause reads.
              // Supplied for the OWNER's mcp client too: absence classifies as a
              // door, so an omission here would refuse the owner's own grants.
              ...(doorRunMcpTokenId !== undefined
                ? { mcp_token_id: doorRunMcpTokenId }
                : {}),
              recipe_id: recipe.recipe_id,
              recipe_hash: (runRecipeHashMemo ??= hashRecipe(recipe)),
            });
          },
          consume: (
            contract_id: string,
            call?: {
              canonical_payload_hash?: string;
              pinned_projection_hash?: string;
              destination_emails?: ReadonlyArray<string>;
            },
          ): boolean => {
            // Slice D — the store's scoped arm RE-VERIFIES containment at the
            // proceed point (5.a), so the consume call carries the SAME pair:
            // the matched destinations + a FRESH candidate read (the index
            // only grows within a turn, so the match-time candidates remain).
            const candidates =
              call?.destination_emails !== undefined
                ? scopedCandidatesFor(runIdentity?.channel_session_id)
                : undefined;
            // N.14 — the store re-verifies the door binding at the spend
            // (same pairing rule as the scoped candidates above).
            const withDoor =
              doorSourceContractId !== undefined
                ? { ...(call ?? {}), source_contract_id: doorSourceContractId }
                : call;
            return sessionGrantResolverForRun.consume(
              contract_id,
              withDoor !== undefined && candidates !== undefined
                ? { ...withDoor, scoped_sender_candidates: candidates }
                : withDoor,
            );
          },
          claimBatchMember: (
            contract_id: string,
            member_id: string,
            call: { arg_shape_hash: string; canonical_payload_hash: string },
          ): boolean => {
            // The memo deliberately keys on (grant, member) WITHOUT the
            // hashes: a `foreach` gated step's later iterations resolve
            // DIFFERENT per-item args, and one member covers the whole
            // gated step exactly as one approval does today — only the
            // FIRST claim (the dispatch the ask enumerated) is
            // hash-verified; the loop rides the same approval.
            const memo = [contract_id, member_id].join(' ');
            if (claimedBatchMembers.has(memo)) return true;
            const claimed = sessionGrantResolverForRun.claimBatchMember(
              contract_id,
              member_id,
              {
                ...call,
                // N.14.6 — the door binding, host-supplied off the run's own
                // source exactly as `match` / `consume` above. The claim is a
                // SPEND (it burns a member + decrements the budget), so the
                // store re-verifies the binding here too.
                ...(doorSourceContractId !== undefined
                  ? { source_contract_id: doorSourceContractId }
                  : {}),
              },
            );
            if (claimed) claimedBatchMembers.add(memo);
            return claimed;
          },
          mint: (call: SessionGrantMintGateCall): void => {
            if (sessionGrantMinted) return;
            sessionGrantMinted = true;
            sessionGrantResolverForRun.mint({
              ...call,
              // N.14 — a door hold's mint binds the grant to its door.
              ...(doorSourceContractId !== undefined
                ? { source_contract_id: doorSourceContractId }
                : {}),
              recipe_id: recipe.recipe_id,
              recipe_hash: (runRecipeHashMemo ??= hashRecipe(recipe)),
            });
          },
        }
      : undefined;

  // D-202 task 4a — the Gateway's QUALITY-delegation seam. The Gateway hands the
  // coarse `(recipe, op)` envelope (slug + trusted op key); this closure completes
  // it with the run's RECIPE identity — `bound_recipe` pins BOTH halves, so a
  // template edit (different content hash) stops matching and the draft re-surfaces
  // for review (the v1 whole-template reset). Shares the deterministic
  // `runRecipeHashMemo` with the session-grant closure (computed lazily on the first
  // ask-branch lookup). `getSwitches` reads the persisted Switch A/B state live so a
  // kill-switch flip takes effect on the next ask. Wired only when a resolver is
  // present; absent ⇒ the Gateway dep is omitted and every `ask` holds as pre-D-202.
  const qualityDelegations:
    | {
        match: (
          call: Omit<QualityDelegationMatchContext, 'recipe_id' | 'recipe_hash'>,
        ) => boolean;
        getSwitches: () => QualityGateSwitches;
      }
    | undefined =
    qualityGateResolverForRun !== undefined
      ? {
          match: (
            call: Omit<QualityDelegationMatchContext, 'recipe_id' | 'recipe_hash'>,
          ): boolean =>
            qualityGateResolverForRun.match({
              ...call,
              recipe_id: recipe.recipe_id,
              recipe_hash: (runRecipeHashMemo ??= hashRecipe(recipe)),
            }),
          getSwitches: (): QualityGateSwitches =>
            qualityGateResolverForRun.switches(),
        }
      : undefined;

  // D-177 catalog-gate session-grant loop — the catalog gate's match / consume
  // / mint seam (engine `CatalogSessionGrantHooks`). A catalog operation holds
  // at the ENGINE catalog gate (before the commit Gateway, whose read-tier
  // catalog dispatch never reaches its own grant seam), so this is a SEPARATE
  // wiring of the same `sessionGrantResolverForRun`. The catalog gate owns only
  // the per-op envelope (slug / operation_id / connection / tier / hashes); this
  // closure adds the run-level context it lacks — channel / actor / session off
  // `runIdentity`, and the recipe identity — exactly as the commit-gateway
  // closure does for its own gate. All three modes run here: exact, batch
  // (`claimBatchMember` shares the per-run claim memo with the commit-gateway
  // closure — one member covers the whole gated step incl. every `foreach`
  // iteration), and open (`resolveOpenProjection` — the catalog variant of the
  // commit gateway's walk closure, gated on the OP's `authority_args` opt-in).
  // Shares the per-run `sessionGrantMinted` dedup with the commit-gateway
  // closure (one approval ⇒ one grant; the two gates never both mint for one
  // gated step). Wired only when both a resolver and run identity are present.
  const catalogSessionGrants: CatalogSessionGrantHooks | undefined =
    sessionGrantResolverForRun !== undefined && runIdentity !== undefined
      ? {
          match: (call: CatalogGrantCall): string | null => {
            // Slice D — same pairing as the commit-gateway closure: the
            // catalog gate extracted the destinations; the host supplies the
            // live per-session sender candidate index (5.d).
            const candidates =
              call.destination_emails !== undefined
                ? scopedCandidatesFor(runIdentity.channel_session_id)
                : undefined;
            return sessionGrantResolverForRun.match({
              channel: runIdentity.source.channel,
              actor: runIdentity.source.actor,
              channel_session_id: runIdentity.channel_session_id,
              // N.14 — the door binding (off the run's own source).
              ...(doorSourceContractId !== undefined
                ? { source_contract_id: doorSourceContractId }
                : {}),
              // N.14.6 — the owner-vs-door discriminator the door clause reads.
              // Supplied for the OWNER's mcp client too: absence classifies as a
              // door, so an omission here would refuse the owner's own grants.
              ...(doorRunMcpTokenId !== undefined
                ? { mcp_token_id: doorRunMcpTokenId }
                : {}),
              ingredient_slug: call.ingredient_slug,
              operation_id: call.operation_id,
              ...(call.connection_name !== undefined
                ? { connection_name: call.connection_name }
                : {}),
              recipe_id: recipe.recipe_id,
              recipe_hash: (runRecipeHashMemo ??= hashRecipe(recipe)),
              risk_tier: call.risk_tier,
              pre_lift_approval: call.pre_lift_approval,
              arg_shape_hash: call.arg_shape_hash,
              canonical_payload_hash: call.canonical_payload_hash,
              ...(call.open_pinned_projection_hash !== undefined
                ? {
                    open_pinned_projection_hash:
                      call.open_pinned_projection_hash,
                  }
                : {}),
              ...(call.destination_emails !== undefined
                ? { destination_emails: call.destination_emails }
                : {}),
              ...(candidates !== undefined
                ? { scoped_sender_candidates: candidates }
                : {}),
            });
          },
          consume: (
            contract_id: string,
            call?: {
              canonical_payload_hash: string;
              pinned_projection_hash?: string;
              destination_emails?: ReadonlyArray<string>;
            },
          ): boolean => {
            // Slice D — same store-side containment re-verify pairing as the
            // commit-gateway consume closure above (5.a).
            const candidates =
              call?.destination_emails !== undefined
                ? scopedCandidatesFor(runIdentity.channel_session_id)
                : undefined;
            // N.14 — same door-binding re-verify pairing as the
            // commit-gateway consume closure above.
            const withDoor =
              doorSourceContractId !== undefined
                ? { ...(call ?? {}), source_contract_id: doorSourceContractId }
                : call;
            return sessionGrantResolverForRun.consume(
              contract_id,
              withDoor !== undefined && candidates !== undefined
                ? { ...withDoor, scoped_sender_candidates: candidates }
                : withDoor,
            );
          },
          claimBatchMember: (
            contract_id: string,
            member_id: string,
            call: { arg_shape_hash: string; canonical_payload_hash: string },
          ): boolean => {
            // Same memo + semantics as the commit-gateway closure above — the
            // SHARED per-run set, so whichever gate holds the gated step, one
            // member covers it (a `foreach` catalog step's later iterations
            // ride the first claim exactly as one approval covers the loop).
            const memo = [contract_id, member_id].join(' ');
            if (claimedBatchMembers.has(memo)) return true;
            const claimed = sessionGrantResolverForRun.claimBatchMember(
              contract_id,
              member_id,
              {
                ...call,
                // N.14.6 — the door binding, host-supplied off the run's own
                // source exactly as `match` / `consume` above. The claim is a
                // SPEND (it burns a member + decrements the budget), so the
                // store re-verifies the binding here too.
                ...(doorSourceContractId !== undefined
                  ? { source_contract_id: doorSourceContractId }
                  : {}),
              },
            );
            if (claimed) claimedBatchMembers.add(memo);
            return claimed;
          },
          // D-177 catalog open mode (N.11) — the catalog variant of the
          // commit gateway's `resolveOpenProjection` closure. Gated on the
          // OP row's `authority_args` OPT-IN (an undeclared op never
          // offers/matches/mints open — fail closed; presence is the
          // curator's completeness attestation, mirroring the simple-form
          // manifest field). The walk reads the op's args AS DISPATCHED —
          // the same skeleton the catalog hash basis projects, refs
          // unresolved — and pins root values through the SAME live stores +
          // `deferVault` resolution. The authority set is
          // `collectOperationAuthorityPaths` (wire baseline ∪ path_scope
          // tokens ∪ affects_target editable args ∪ the op's declaration) —
          // the very set `hash_exclude_args` may never target (N.2: one
          // authority set, two consumers). Refusals return undefined — the
          // gate treats the dispatch as open-infeasible and everything stays
          // exact.
          resolveOpenProjection: (call) => {
            const manifest = deps.executorConfig.manifests.get(
              call.ingredient_slug,
            );
            const op = manifest?.operations?.[call.operation_id];
            if (!op || op.authority_args === undefined) return undefined;
            const result = computeOpenProjection({
              mergedArgs: call.args,
              // D-177 N.2 — include the binding's path-template target ids so an
              // open grant must pin/classify them too (one authority set, two
              // consumers — must match the publish validator's set).
              authorityPaths: collectOperationAuthorityPaths(
                op,
                operationPathTemplate(manifest, call.operation_id),
              ),
              steps: [
                ...(recipe.steps ?? []),
                ...(recipe.prefetch_steps ?? []),
                ...(recipe.trigger_steps ?? []),
              ],
              ...(call.gated_step_id !== undefined
                ? { gatedStepId: call.gated_step_id }
                : {}),
              // Same channel gate as the commit-gateway closure (codex HIGH
              // fold there): `context.event` is clean only where the
              // warehouse-bus dispatcher stamps it.
              eventContextTrusted:
                executionSource !== undefined
                && TRUSTED_EVENT_CONTEXT_CHANNELS.has(executionSource.channel),
              // D-177 N.14 — `context.reception_submission.*` /
              // `context.reception_order.*` are the reception RUNNER's
              // server-populated door payload ONLY on a reception-channel
              // run; everywhere else the same keys would be caller-populated
              // (the identical laundering hole the event flag above guards)
              // and refuse exactly as before.
              doorSubmissionTrusted:
                executionSource !== undefined
                && executionSource.channel === 'reception',
              resolveRootValue: (ref) =>
                resolveValue(ref, stores, { deferVault: true }),
              resolveArgValue: (value) =>
                resolveDeep(value, stores, { deferVault: true }),
              getIngredientKind: (s) =>
                deps.executorConfig.manifests.get(s)?.kind,
              // D-177 N.11 rule 1 — per-row stored-cleanliness lookup
              // (same closure as the commit-gateway walk below).
              ...(resolveStoredRowOrigin ? { resolveStoredRowOrigin } : {}),
            });
            return isOpenProjectionRefusal(result) ? undefined : result;
          },
          mint: (call: CatalogGrantMintCall): void => {
            if (sessionGrantMinted) return;
            sessionGrantMinted = true;
            sessionGrantResolverForRun.mint({
              channel: runIdentity.source.channel,
              actor: runIdentity.source.actor,
              channel_session_id: runIdentity.channel_session_id,
              // N.14 — a door hold's mint binds the grant to its door.
              ...(doorSourceContractId !== undefined
                ? { source_contract_id: doorSourceContractId }
                : {}),
              ingredient_slug: call.ingredient_slug,
              operation_id: call.operation_id,
              ...(call.connection_name !== undefined
                ? { connection_name: call.connection_name }
                : {}),
              recipe_id: recipe.recipe_id,
              recipe_hash: (runRecipeHashMemo ??= hashRecipe(recipe)),
              risk_tier: call.risk_tier,
              pre_lift_approval: call.pre_lift_approval,
              arg_shape_hash: call.arg_shape_hash,
              canonical_payload_hash: call.canonical_payload_hash,
              ttl_ms: call.ttl_ms,
              max_uses: call.max_uses,
              approved_action_ref: runIdentity.request_id,
              // D-177 catalog open mode — the projection trio recomputed by
              // the gate from the resume dispatch's own walk (absent on an
              // exact mint; the resolver refuses an open mint without them —
              // fail closed).
              ...(call.grant_mode !== undefined
                ? { grant_mode: call.grant_mode }
                : {}),
              ...(call.pinned_projection_hash !== undefined
                ? { pinned_projection_hash: call.pinned_projection_hash }
                : {}),
              ...(call.open_projection !== undefined
                ? { open_projection: call.open_projection }
                : {}),
            });
          },
        }
      : undefined;

  // D-172 P5 / N.8 activation (I-4) — the per-request Gateway-gated `fileRead`
  // for the ai-* multimodal overload. The overload resolves a `data.file` ref
  // in an `ai-*` `llm.data` to its content bytes INSIDE the LLM adapter
  // (`resolveAiFileRef`), which runs PAST the gateway that already admitted
  // the OUTER `ai-*` dispatch. That inner byte read MUST be policy-gated for
  // THIS run's `(channel × actor × contract_id)`, exactly as a first-class
  // `data-file-read` ingredient dispatch is — otherwise an actor granted an
  // `ai-*` tool but DENIED `data-file-read` could exfiltrate arbitrary file
  // bytes by passing `{ file_ref }` as `llm.data` (D-172 I-4 / A.8: file
  // content leaves the warehouse ONLY through the gated, audited file.read).
  //
  // So compose the SAME secondary `data-file-read` admission the F2
  // mail-send-attachment path runs (`evaluateAdmission` → `admitOne`) in
  // FRONT of the byte read, and read through the SAME `handleFileRead` the
  // `data-file-read` kernel ingredient dispatches (the `dataFileRead`
  // dispatcher, wired off `cacheBlobs` + the file registry + auditLog, so the
  // read is audited `file_content_read` identically). Never the raw CAS.
  //
  // Wired ONLY when BOTH a per-request admission gate is live (a POLICY_GATED
  // channel ⇒ `evaluateAdmission` defined) AND the raw file-read dispatcher is
  // present (`cacheBlobs` wired). Either absent ⇒ `fileRead` stays unset ⇒ the
  // overload is INERT (a `{ file_ref }` `llm.data` is stringified as before —
  // no bytes read, no regression). Fail-closed: on a gated channel a non-admit
  // verdict THROWS (no bytes); on an ungated channel there is no admission
  // decision to honour, so we do not read at all (the explicit `data-file-read`
  // ingredient stays available).
  const rawFileRead = deps.executorConfig.kernelDispatchers?.dataFileRead;
  let gatedFileRead: FileReadFn | undefined;
  if (evaluateAdmission !== undefined && rawFileRead !== undefined) {
    // Capture as `const`s narrowed by the `if` guard so the closure holds
    // them non-undefined without `!` (mirrors `overlayForUse` above).
    const admitFileRead = evaluateAdmission;
    const readFileBytes = rawFileRead;
    gatedFileRead = async (record_id: string) => {
      // Reuse the run's admission gate — NOT a reimplementation of the policy.
      // `evaluateAdmission` delegates to `admitOne` for a non-mail-send slug,
      // so this is precisely the `data-file-read` ingredient's own admission
      // for this `(channel × actor × contract_id)`. `deriveDispatchScope`
      // fixes `data-file-read` to the `data.file` scope regardless of
      // `record_id` (review F2.B), so one probe covers the ref.
      const decision = admitFileRead(DATA_FILE_READ_INGREDIENT_SLUG, { record_id });
      // Fail-closed on EVERY non-admit verdict (mirrors F2's three cases):
      //  - `null`  → the `data-file-read` manifest is absent (packaging /
      //    registry drift; the file collection registers off `cacheBlobs`
      //    INDEPENDENT of manifest loading) → policy unevaluable → deny.
      //  - `'ask'` → a read needing approval must be granted to
      //    `data-file-read` directly, never ridden on the `ai-*` grant.
      //  - `'deny'` → terminal.
      // No bytes leave the warehouse ungated.
      if (decision === null || decision.verdict !== 'admit') {
        const verdict = decision === null ? 'unevaluable (manifest absent)' : decision.verdict;
        throw new Error(
          `AI_FILE_READ_DENIED: reading 'data.file' record '${record_id}' into an ai-* step is not `
            + `admissible for this run (channel × actor × contract) — `
            + `'${DATA_FILE_READ_INGREDIENT_SLUG}' verdict: ${verdict}. Grant `
            + `'${DATA_FILE_READ_INGREDIENT_SLUG}' to use file refs in ai-* steps (D-172 I-4 — file content `
            + `leaves the warehouse only through the gated, audited file.read).`,
        );
      }
      const file = await readFileBytes({ record_id });
      return {
        bytes_b64: file.bytes_b64,
        mime_type: file.mime_type,
        filename: file.filename,
      };
    };
  }

  // Create executor with ref resolution bound to these stores. Passing
  // recipeContext enables the cache wrapper when a cacheStore is configured.
  // D-145 engine-wiring slice 3b.3 — `observeCacheStatus` is wired into the
  // L1 ingredient cache's `onStatus` so the commit Gateway can flag an
  // L1-served call `cached`. Inert when no cacheStore is configured.
  // D-172 P5 / N.8 — `fileRead` injected (per-request) onto the LLM adapter
  // only when the gate above produced one; absent ⇒ overload inert.
  const ingredientExecutor = createBoundExecutor(
    {
      ...deps.executorConfig,
      ...(gatedFileRead ? { fileRead: gatedFileRead } : {}),
    },
    stores,
    {
      recipe_id: recipe.recipe_id,
      recipe_ttl: (recipe as unknown as { ttl?: number }).ttl ?? 0,
    },
    observeCacheStatus,
  );

  // D-145 engine-wiring slice 3b.3 — wrap the ingredient executor with
  // the D-153 commit Gateway. Live only when BOTH a typed
  // `ExecutionSource` (→ `runIdentity`) and a `commitStore` are present:
  // the Gateway needs `source` to stamp and a store to write to. Absent
  // either, the engine runs the unwrapped executor exactly as pre-3b.3
  // — the documented graceful-degradation path. The Gateway is the
  // OUTERMOST executor wrapper: it sits outside the L1 ingredient cache
  // (composed inside `createBoundExecutor`), so an L1-served call still
  // produces a commit, flagged `cached` via the cache-aware inner. The
  // L2 step cache (engine-internal) short-circuits before the executor
  // — its hits produce no commit; see `commit-gateway-wiring.ts`.
  //
  // D-157 P1 slice 4 — `evaluateAdmission` is passed alongside so the
  // commit Gateway raises `PreflightRequiredSignal` per call on an
  // `'ask'` verdict BEFORE writing any pending commit (an ask pauses
  // the dispatch — nothing to record).
  //
  // D-166 — `recordDispatchUse` is passed so the gateway decrements the
  // matched contract's use counter at the actual-proceed point (once per
  // boundary-crossing dispatch), counting the approval-resume path the
  // per-call probe could not see.
  const commitGatewayActive =
    runIdentity !== undefined && deps.commitStore !== undefined;
  /** A direct-MCP customer meter must still see the real ingredient boundary
   * when the commit substrate is intentionally absent/degraded. The full
   * Gateway owns the post-approval hook when active; this narrow fallback is
   * used only otherwise, immediately before the underlying dispatch, so D-162
   * multiplicity cannot silently collapse back to the outer +1. */
  const usageAwareFallbackExecutor: IngredientExecutor =
    reserveDispatchUsage !== undefined && !commitGatewayActive
      ? async (slug, input, output, stepOptions, stepMeta) => {
          const usageInput = stepMeta?.surface_dispatch === true
            && stepMeta.surface_dispatch_authority_input !== undefined
            ? stepMeta.surface_dispatch_authority_input as Record<string, unknown>
            : input;
          reserveDispatchUsage(
            slug,
            usageInput,
            stepMeta?.surface_dispatch === true
              ? stepMeta.surface_operation_key
              : undefined,
            stepMeta?.step_id,
          );
          return ingredientExecutor(slug, input, output, stepOptions, stepMeta);
        }
      : ingredientExecutor;

  /** The per-call policy boundary does not depend on commit persistence. The
   * full Gateway owns it when commit wiring is live; this narrow twin keeps an
   * ask/deny authoritative when the commit store or typed source is absent —
   * notably source-less housekeeping consulting a `system` override. */
  const admissionAwareFallbackExecutor: IngredientExecutor =
    evaluateAdmission !== undefined && !commitGatewayActive
      ? async (slug, input, output, stepOptions, stepMeta) => {
          const authorityInput = stepMeta?.surface_dispatch === true
            && stepMeta.surface_dispatch_authority_input !== undefined
            ? stepMeta.surface_dispatch_authority_input as Record<string, unknown>
            : input;
          const decision = evaluateAdmission(
            slug,
            authorityInput,
            stepMeta?.surface_dispatch === true
              ? stepMeta.surface_operation_key
              : undefined,
          );
          if (decision?.verdict === 'deny') {
            throw new PreflightDeniedError(slug, decision.code, decision.detail);
          }
          if (decision?.verdict === 'ask') {
            const resumeApproved =
              stepMeta?.preflight_admitted === true
              && stepMeta.preflight_approved_target?.ingredient_slug === slug;
            if (!resumeApproved) raiseOnAsk(decision, { slug });
          }
          return usageAwareFallbackExecutor(slug, input, output, stepOptions, stepMeta);
        }
      : usageAwareFallbackExecutor;

  const engineExecutor: IngredientExecutor =
    commitGatewayActive
      ? wrapWithCommitGateway(cacheAwareGatewayInner(ingredientExecutor), {
          commitStore: deps.commitStore!,
          identity: runIdentity,
          getIngredientCategory: (slug) =>
            deps.executorConfig.manifests.get(slug)?.category,
          // D-177 P1b — action-identity hash basis (N.2): the SAME
          // manifest-defaults + step-input merge the dispatch layer performs
          // (`mergeManifestStepInput` — a connection wrapper's
          // `connection: '{{config.x}}'` picker lives in MANIFEST defaults,
          // so the bare step input alone would under-pin the target), then
          // resolved against the run's LIVE stores exactly as the dispatch
          // layer will resolve it (`createBoundExecutor` closes its
          // `resolveRefs` over the same `stores`), except `{{vault.*}}` refs
          // stay intact — the secret-free placeholder. Unknown slug → the
          // dispatch is about to fail INGREDIENT_NOT_FOUND anyway; return
          // undefined so no identity is stamped. The Gateway projects +
          // hashes; this closure only merges + resolves.
          resolveArgsForHash: (slug, input, { surfaceDispatch }) => {
            const manifest = deps.executorConfig.manifests.get(slug);
            if (!manifest) return undefined;
            const merged = mergeManifestStepInput(manifest.input, input, {
              trustedSurfaceDispatch: surfaceDispatch,
            });
            return resolveDeep(merged, stores, { deferVault: true }) as Record<
              string,
              unknown
            >;
          },
          // D-177 P1b — op-declared volatile exclusions (N.2). A catalog
          // surface dispatch resolves the OP row's declaration via the
          // threaded short key; a plain dispatch reads the simple-form
          // manifest's. No cross-fallback — each form has exactly one
          // declaration site.
          getHashExcludeArgs: (slug, surfaceOperationKey) => {
            const manifest = deps.executorConfig.manifests.get(slug);
            if (!manifest) return undefined;
            return surfaceOperationKey !== undefined
              ? manifest.operations?.[surfaceOperationKey]?.hash_exclude_args
              : manifest.hash_exclude_args;
          },
          // D-177 N.11 rule 5 (slice D) — the scoped-grant destination
          // extraction's authority set. CATALOG OPS ONLY (5.b — a scoped
          // grant binds an `<entity>.<action>` op; the matcher requires a
          // trusted `operation_id`, which the commit gateway only sets off a
          // surface key), so a plain simple-form dispatch returns undefined
          // and the scoped arm stays fail-closed for it.
          getScopedAuthorityPaths: (slug, surfaceOperationKey) => {
            if (surfaceOperationKey === undefined) return undefined;
            const manifest = deps.executorConfig.manifests.get(slug);
            const op = manifest?.operations?.[surfaceOperationKey];
            return op !== undefined
              ? collectOperationAuthorityPaths(
                  op,
                  operationPathTemplate(manifest, surfaceOperationKey),
                )
              : undefined;
          },
          // D-177 P5b (N.11) — the open-projection walk. Gated on the
          // manifest's `authority_args` OPT-IN (an undeclared manifest
          // never offers/matches/mints `'open'` — fail closed: an
          // unguarded destination arg could otherwise be re-aimed through
          // open's payload freedom). The walk reads the SAME merged
          // unresolved input the hash basis resolves
          // (`mergeManifestStepInput` — manifest-default refs like
          // mail-post's `connection: '{{config.email}}'` classify) and
          // pins root values through the SAME live stores + `deferVault`
          // resolution, so a pinned value and the dispatched value can
          // never diverge. Refusals (unclassifiable root, dynamic key, IO
          // step output, size cap) return undefined — the Gateway treats
          // the dispatch as open-infeasible and everything stays exact.
          resolveOpenProjection: (slug, input, { surfaceDispatch, stepId }) => {
            const manifest = deps.executorConfig.manifests.get(slug);
            if (!manifest || manifest.authority_args === undefined) {
              return undefined;
            }
            const merged = mergeManifestStepInput(manifest.input, input, {
              trustedSurfaceDispatch: surfaceDispatch,
            });
            const result = computeOpenProjection({
              mergedArgs: merged,
              authorityPaths: [
                ...WIRE_AUTHORITY_ARG_PATHS,
                ...manifest.authority_args,
              ],
              steps: [
                ...(recipe.steps ?? []),
                ...(recipe.prefetch_steps ?? []),
                ...(recipe.trigger_steps ?? []),
              ],
              ...(stepId !== undefined ? { gatedStepId: stepId } : {}),
              // codex HIGH fold — `context.event` is a TRUSTED system event
              // (clean) only on the warehouse-bus event-fire channels, where
              // the dispatcher stamps it (`triggers/dispatcher.ts`); on
              // chat / mcp / user / messenger / reception the same
              // `request.context` is caller-populated, so a model could
              // smuggle `context.event.payload.to` as a "clean varying"
              // root. Gate the clean classification on the channel — absent
              // source ⇒ untrusted (fail closed; the walk refuses a
              // `context.event` root → exact, which pins the full payload).
              eventContextTrusted:
                executionSource !== undefined
                && TRUSTED_EVENT_CONTEXT_CHANNELS.has(executionSource.channel),
              // D-177 N.14 — `context.reception_submission.*` /
              // `context.reception_order.*` are the reception RUNNER's
              // server-populated door payload ONLY on a reception-channel
              // run; everywhere else the same keys would be caller-populated
              // (the identical laundering hole the event flag above guards)
              // and refuse exactly as before.
              doorSubmissionTrusted:
                executionSource !== undefined
                && executionSource.channel === 'reception',
              resolveRootValue: (ref) =>
                resolveValue(ref, stores, { deferVault: true }),
              resolveArgValue: (value) =>
                resolveDeep(value, stores, { deferVault: true }),
              getIngredientKind: (s) =>
                deps.executorConfig.manifests.get(s)?.kind,
              // D-177 N.11 rule 1 — per-row stored-cleanliness lookup:
              // a `data.*` root resolving to a row the human authored
              // through their own paired client (`isUserCleanStoredRow`)
              // classifies `stored_user` (clean → varies); every other
              // stored root stays pinned. Live row reads — the per-fire
              // re-walk re-checks the facets at every match.
              ...(resolveStoredRowOrigin ? { resolveStoredRowOrigin } : {}),
            });
            return isOpenProjectionRefusal(result) ? undefined : result;
          },
          ...(evaluateAdmission ? { evaluateAdmission } : {}),
          ...(reserveDispatchUsage ? { reserveDispatchUsage } : {}),
          ...(recordDispatchUse ? { recordDispatchUse } : {}),
          ...(sessionGrants ? { sessionGrants } : {}),
          ...(qualityDelegations ? { qualityDelegations } : {}),
        })
      : admissionAwareFallbackExecutor;

  // D-179 P1 — per-dish `context.recipe.*` continuity. Standing dishes
  // load their prior-run snapshot so `{{context.recipe.<step_id>}}`
  // resolves against THIS dish's last run (ten dishes of one recipe
  // never cross-contaminate). Ephemeral runs carry no continuity.
  const contextRecipeSnapshot =
    boundDish !== null && deps.dishContextStore !== undefined
      ? deps.dishContextStore.get(boundDish.dish_id)
      : null;

  // D-187 AMENDMENT — resolve the recipe's bound-contract read-grant checker ONCE for
  // the MCP-triggered `readEnrichmentRow` reader (`enrichment-or-fetch`). Gated via the
  // overlay (active / grant-kind), the same bound contract the policy gate keys on.
  // Non-MCP triggers don't gate (`gate_mcp_private` false), so skip the resolution; an
  // absent overlay / unbound source ⇒ undefined ⇒ the reader's author-default checker
  // (registry defaults). (The recipe-channel `enrichment-list` + `timeline-read` kernel
  // dispatchers resolve their own per-dispatch contract separately.)
  const readGrantChecker =
    isMcpTriggeredRecipe && executionSource !== undefined
      ? deps.contractOverlay?.resolveReadGrantChecker?.(executionSource)
      : undefined;

  // D-181 slice 4 — register the run on the in-flight active-list (when a
  // registry + execution_source are wired) and mint its kill signal. The
  // owner's `execution.kill` aborts this controller (rejecting the run's queued
  // heavy calls) + SIGKILLs any running subprocess; the registry then carries a
  // `killed` termination marker the anchor build reads below. Unattended vs
  // attended origin mirrors the slice-3 stall monitor (trigger-source derived).
  const killController = new AbortController();
  const registerLiveRun = deps.inFlightRegistry !== undefined && executionSource !== undefined;
  if (registerLiveRun) {
    const sessionId = deriveChannelSessionId(executionSource);
    deps.inFlightRegistry!.registerRun({
      run_id,
      recipe_id: recipe.recipe_id,
      ...(boundDish?.dish_id !== undefined ? { dish_id: boundDish.dish_id } : {}),
      source: executionSource!,
      origin: runAttentionForTriggerSource(request.trigger_source),
      ...(sessionId ? { session_id: sessionId } : {}),
      started_at: Date.now(),
      abort: () => killController.abort(),
    });
  }

  // D-185 Slice 2 — a DURABLE pause (a preflight `ask` that wrote a checkpoint)
  // resumes later as a fresh process invocation under the SAME `run_id`, so the
  // run's `storage:'temp'` files must SURVIVE the pause (a paused-then-resumed
  // run is ONE run). Set only when a checkpoint persisted (below); the run-end
  // `finally` then skips the temp sweep on a resumable pause and lets the
  // terminal invocation reclaim the scratch root.
  let resumablePause = false;
  // R2 step 6 — the checkpoint's `recipe_snapshot` (below) must hash-match
  // this run's audit anchor `recipe_hash` so the resumer can prove the paused
  // recipe was not tampered with. The anchor is stamped from `result.recipe_hash`
  // = `hashRecipe(recipe)` at ENGINE ENTRY (pre-execution). The engine then
  // mutates `recipe` IN PLACE (`parseRecipe`'s D-195 `output.sidebar`→`render`
  // alias normalization runs under `strict: true`), so by pause time the live
  // `recipe` object no longer hashes to the anchor. Snapshot a deep copy taken
  // HERE — the exact state the engine is about to hash — so
  // `hashRecipe(recipe_snapshot) === result.recipe_hash`. Only inline runs
  // (`request.recipe !== undefined`) persist a snapshot, so only they clone.
  const preEngineRecipeSnapshot =
    request.recipe !== undefined ? structuredClone(recipe) : undefined;
  try {
    const result = await executeRecipe({
      recipe,
      stores,
      ...(contextRecipeSnapshot !== null ? { contextRecipeSnapshot } : {}),
      ingredientExecutor: engineExecutor,
      cliInvocationExecutor: deps.cliInvocationExecutor ?? CLI_INVOCATION_EXECUTOR,
      ...(deps.ingestFileDownload ? { ingestFileDownload: deps.ingestFileDownload } : {}),
      ...(deps.operationBoundWebhook
        ? { operationBoundWebhook: deps.operationBoundWebhook }
        : {}),
      ...(operationBoundWebhookConsumer
        ? { operationBoundWebhookConsumer }
        : {}),
      strict: true,
      // D-181 slice 4 — the run id + kill signal for the live active-list /
      // governor. `run_id` labels each gated call's registry entry; the abort
      // signal rejects the run's queued calls when the owner kills it.
      run_id,
      ...(registerLiveRun ? { runAbortSignal: killController.signal } : {}),
      // D-181 Slice 2 — bound heavy calls inline through the two-lane governor.
      ...(deps.laneGovernor ? { laneGovernor: deps.laneGovernor } : {}),
      // D-181 §10 — the duration-threshold classifier (default-gated fast-lane demotion).
      ...(deps.opDurationClassifier ? { opDurationClassifier: deps.opDurationClassifier } : {}),
      manifestGetter: (slug, requestedVersion) =>
        deps.executorConfig.manifests.get(slug, requestedVersion),
      stepCache,
      sharedResolvers,
      ...(linkSink ? { linkSink } : {}),
      ...(deps.enrichmentStore
        ? {
            readEnrichmentRow: createEnrichmentReader(deps.enrichmentStore, {
              gate_mcp_private: isMcpTriggeredRecipe,
              // D-187 AMENDMENT — the recipe's bound-contract read-grant checker
              // (resolved above via the overlay); the reader short-circuits a topic the
              // contract isn't read-granted. Absent ⇒ the reader's author-default checker.
              ...(readGrantChecker ? { readGrantChecker } : {}),
            }),
          }
        : {}),
      // D-165 P0 — catalog-form gateway hooks. `connectionProfileResolver`
      // resolves the local per-connection operation profile (grants +
      // overrides); `onGatewayCall` emits the per-call `connection_gateway`
      // audit row (Invariant 5). Both optional — absent profile store ⇒
      // catalog calls fail closed; absent auditLog ⇒ no gateway audit.
      ...(deps.connectionOperationProfiles
        ? {
            connectionProfileResolver: (connection_name: string) =>
              deps.connectionOperationProfiles!.get(connection_name),
          }
        : {}),
      // D-182 §7.2 — forward the pre-built cli reachability resolver (the
      // AUTHORITATIVE cli authorization source; the boot composer wires it from
      // the local `contract.*` store). Absent ⇒ cli catalog ops fail closed
      // `cli_reachability_disabled` (reachability defaults OFF).
      ...(deps.cliReachabilityResolver
        ? { cliReachabilityResolver: deps.cliReachabilityResolver }
        : {}),
      // D-165 P3.path-picker (Slice 3b) — resolve a connection's stored
      // `subresource_path` so the catalog gateway can enforce an operation's
      // `path_scope`. Reads the connection RECORD (not the grant profile);
      // `'api'` is the catalog dispatch kind (the gateway dispatches catalog
      // ops over the api surface). Absent store ⇒ resolver unwired ⇒ the gate
      // treats every connection as whole-account (`/`).
      ...(deps.connectionStore
        ? {
            connectionSubresourcePathResolver: (connection_name: string) =>
              deps.connectionStore!.get('api', connection_name)?.subresource_path,
            connectionBaseUrlResolver: (connection_name: string) =>
              connectionBaseUrlFromConfig(
                deps.connectionStore!.get('api', connection_name)?.config_json,
              ),
          }
        : {}),
      ...(deps.auditLog ? { onGatewayCall: createGatewayAuditEmitter(deps.auditLog) } : {}),
      // D-177 catalog-gate session-grant loop — the catalog gate's grant seam
      // (absent ⇒ every catalog `ask` holds exactly as pre-loop).
      ...(catalogSessionGrants ? { catalogSessionGrants } : {}),
      ...(typeof request.trigger_source === 'string'
        ? { trigger_source: request.trigger_source }
        : {}),
      // D-166 Slice 4d.3 — thread the execution actor onto the engine ctx so
      // the catalog gateway resolves the `contract.override` scope's required
      // `actor` segment at dispatch (consumed by the override-tightening layer
      // wired via `contractScan` below). Conditional-spread so an absent
      // `execution_source` (legacy dispatch paths) leaves `ctx.actor` unset —
      // the override scope then matches no row and the connection-keyed profile
      // floor stands unchanged.
      ...(executionSource?.actor ? { actor: executionSource.actor } : {}),
      // D-192 6c.2c — thread the create-plan re-run admission (internal-only, set by
      // the create-plan re-run wiring) onto the ctx: the id of the step whose create
      // the confirm approved. `buildStepMeta` admits that step's vendor create past
      // its `'ask'` gate; every other step gates unchanged. Absent on every wire /
      // chat / MCP / recipe run.
      ...(typeof internal.work_entity_write_preadmitted_step_id === 'string'
        && internal.work_entity_write_preadmitted_step_id.length > 0
        ? { work_entity_write_preadmitted_step_id: internal.work_entity_write_preadmitted_step_id }
        : {}),
      // D-182 §6/§10 step 7 — thread the FULL execution source + the run's
      // correlation id onto the engine ctx so the catalog gateway can stamp the
      // op-level audit identity (`execution_source` + `origin_unit_id` via
      // `deriveOriginUnit(source, { run_id, correlation_id })`) onto every
      // `GatewayCallAudit`. `actor` / `contract_id` above stay (their existing
      // policy consumers); these add the channel + per-channel ids the audit +
      // origin-unit derivation need. `correlation_id` rides off `commitFields`
      // (set alongside `execution_source` on the same source-present path).
      // Conditional-spread so a source-less dispatch leaves the audit fields
      // unstamped (legacy direct rpc / dbless tests) — never breaking dispatch.
      ...(executionSource !== undefined ? { execution_source: executionSource } : {}),
      // D-209 #1 — thread the resolved contract snapshot onto the ctx so the
      // catalog gateway's per-op ceiling is PER-DOOR (the snapshot's authored
      // `max_risk_without_approval`), not the flat contracted default. Absent
      // snapshot ⇒ `resolveTrustCeiling` keeps its flat defaults.
      ...(request.contract_snapshot !== undefined
        ? { contract_snapshot: request.contract_snapshot }
        : {}),
      ...(commitFields.correlation_id !== undefined
        ? { correlation_id: commitFields.correlation_id }
        : {}),
      // D-161 P1 — thread the run's contract_id (when contracted) onto
      // the engine ctx alongside `actor`, so kernel write-handlers
      // (`enrichment-upsert` / `data-annotate` / `data-link`) can stamp
      // the `origin_contract_id` half of the origin facet (N.4). Absent
      // for unrestricted / system / no-source runs.
      ...(executionSource !== undefined
        && executionSourceContractId(executionSource) !== undefined
        ? { contract_id: executionSourceContractId(executionSource)! }
        : {}),
      // D-166 Slice 4d.4 — the `contract.*` scan callback. Paired with `actor`
      // above, the catalog gateway composes the user's `contract.override` rows
      // for the dispatched (actor, ingredient, operation) and TIGHTENS the
      // connection-keyed profile-floor resolution (restrict only). Absent (no
      // contract store wired — dbless / unit paths) ⇒ override layer skipped.
      ...(deps.contractScan ? { contractScan: deps.contractScan } : {}),
      // D-157 server-wiring — switch the engine into resume mode when
      // the resumer threaded `resume_from` through `internal`. The
      // engine skips every trigger / prefetch step (their outputs
      // already live on the seeded `stores.step`) and starts the
      // sequential loop at `gated_step_id`; the gated dispatch carries
      // the `StepMeta.preflight_admitted` resume-grant marker that
      // admits the call past the gateway probe.
      ...(internal.resume_from
        ? {
            resumeFrom: {
              gated_step_id: internal.resume_from.gated_step_id,
              // D-165 follow-on (op-identity binding) — carry the approved
              // identity onto the resumed gated step so the catalog gate
              // re-verifies it before honoring `preflight_admitted`.
              ...(internal.resume_from.approved_target !== undefined
                ? { approved_target: internal.resume_from.approved_target }
                : {}),
              // D-173 N.5 — carry the consumed checkpoint's editable-args
              // overrides onto the resumed gated step. The engine shallow-
              // merges them over the gated step's authored args before
              // dispatch (gated step only). This `internal` channel is the
              // boundary: `internal.resume_from` is populated EXCLUSIVELY by
              // `PreflightResumer.resumeRun` off the consumed checkpoint
              // (`buildResumeInputs` reads `checkpoint.arg_overrides`), and
              // the `internal` parameter is off `ExecuteRequest` so no wire
              // dispatcher can smuggle overrides through it (N.5 MUST).
              ...(internal.resume_from.arg_overrides !== undefined
                ? { arg_overrides: internal.resume_from.arg_overrides }
                : {}),
              // D-177 P3 — carry the `allow_session` answer's mint
              // instruction onto the resumed gated step. Same boundary as
              // the siblings: `internal.resume_from` is populated EXCLUSIVELY
              // by `PreflightResumer.resumeRun` off the answer context, and
              // `internal` is off `ExecuteRequest` — no wire dispatcher can
              // mint itself a grant through it (N.5).
              ...(internal.resume_from.session_grant !== undefined
                ? { session_grant: internal.resume_from.session_grant }
                : {}),
              // D-177 P5a — carry the batched approve's member-claim
              // instruction onto the resumed gated step. Same boundary as
              // the siblings: only the batch answer flow populates it
              // (via the resumer), and `internal` is off `ExecuteRequest`
              // — no wire dispatcher can claim itself a member (N.10).
              ...(internal.resume_from.batch_claim !== undefined
                ? { batch_claim: internal.resume_from.batch_claim }
                : {}),
              // § 7 follow-on — the consumed checkpoint's pii-ledger
              // snapshot; the engine hydrates its run store from it so
              // post-gate restores return real values.
              ...(internal.resume_from.pii_ledgers !== undefined
                ? { pii_ledgers: internal.resume_from.pii_ledgers }
                : {}),
            },
          }
        : {}),
    });
    // D-181 slice 4 — the instant the engine returns, consume the run's KILL
    // marker (the only marker `registerLiveRun` now records — `cancel()` no longer
    // writes a run-level marker, §7c) and retire the run from the live active-list
    // — BEFORE any post-engine await (checkpoint persistence / ask raise). This
    // runs synchronously after the `executeRecipe` await resolves, so no concurrent
    // `execution.kill` can interleave to mis-stamp an already-finished or paused
    // run. `completeRun` is idempotent (the `finally` repeats it on the throw
    // path); a kill arriving after this point finds the run retired (`not_found`).
    const consumedTermination = registerLiveRun
      ? deps.inFlightRegistry!.takeTermination(run_id)
      : undefined;
    if (registerLiveRun) deps.inFlightRegistry!.completeRun(run_id);
    // D-181 §7c — derive the run's owner-control termination from the authoritative
    // signals: the registry's `killed` marker (deliberate kill — always honored,
    // even on a run that finished before the abort was observed), OR a genuine
    // failure carrying the engine's `slot_cancelled` step-error marker (a queued
    // call's cancel that actually failed the run). A swallowed cancel leaves no
    // such error, so a run that succeeds / pauses / fails for an unrelated reason
    // is never mislabelled cancelled. Drives `error_category` / `commit_status` /
    // the agent's `run_terminated`.
    const runTermination = deriveRunTermination({
      killed: consumedTermination === 'killed',
      success: result.success,
      errors: result.errors,
    });
    const resultDegraded: RunDegradation[] = [...(result.degraded ?? [])];
    const markResultDegraded = (reason: RunDegradation): RunDegradation[] => {
      const degraded = recordRunDegradation(resultDegraded, reason);
      result.degraded = degraded;
      return degraded;
    };

    // D-192 Slice 6b — a work-entity create in this run failed on an AMBIGUOUS
    // vendor container (the engine coded the halting step `CONTAINER_PICK_REQUIRED`
    // and preserved the choice set onto `details.container_pick`). Surface a
    // terminal `container_pick_required` (like `awaiting_approval` — `success`
    // stays `false`, the create didn't happen, but this is NOT a silent failure),
    // and — for an owner/interactive run without vault/context — raise the D-158
    // pick ask so the user chooses; the answer persists the pick + re-runs the
    // create off the stored selection. A contracted (external MCP) run gets the
    // choice set WITHOUT the owner ask: its answer would dispatch under OWNER
    // authority, so — the same confused-deputy guard the connection pick applies
    // — the agent instead asks its principal and re-runs. Mutually exclusive with
    // `awaiting_approval` (a paused run halts before the create, empty errors).
    // Scans `result.errors` (top-level halting errors — execute.ts pushes a
    // sequential step's error + breaks). A create INSIDE a `foreach` is NOT
    // surfaced (runForeach embeds per-iteration errors in its result array and
    // reports the parent step error as null) — an accepted limitation: the
    // realistic chat path is a single create, and a container pick is a one-time
    // per-Source setup (once stored, later creates auto-resolve). See handover.
    let containerPickRequired:
      | (ContainerPickDetail & { ask_id?: string; can_create_new_container?: boolean })
      | undefined;
    {
      const cpErr = result.errors.find((e) =>
        isContainerPickDetail((e as RecipeError).details?.container_pick),
      );
      if (cpErr !== undefined) {
        const detail = (cpErr as RecipeError).details.container_pick as ContainerPickDetail;
        const src = request.execution_source;
        const ownerRun = src !== undefined && src.actor === 'user_self';
        let cpAskId: string | undefined;
        if (
          deps.containerPickNotifier !== undefined
          && ownerRun
          && request.vault === undefined
          && request.context === undefined
        ) {
          try {
            // `pick_id = run_id` (this failed run's id) → the re-run's
            // deterministic id `container-pick-<run_id>`; a re-dispatch of the
            // same failed run converges on one re-run, distinct create attempts
            // (distinct run ids) get distinct picks.
            const askInput: ContainerPickAskInput = {
              pick_id: run_id,
              ...(request.recipe === undefined
                ? { recipe_id: recipe.recipe_id }
                : { recipe }),
              recipe_label: recipe.recipe_id,
              config: request.config ?? {},
              source_id: detail.source_id,
              dependency_ref: detail.dependency_ref,
              kind: detail.kind,
              options: detail.options,
            };
            cpAskId = (await raiseContainerPickAsk(deps.containerPickNotifier, askInput)).ask_id;
          } catch (e) {
            // Best-effort raise — the response still carries the choice set, so a
            // caller can render its own picker / re-issue with the container.
            console.warn(
              `[container-pick] failed to raise pick ask for '${detail.dependency_ref}': `
                + (e instanceof Error ? e.message : String(e)),
            );
          }
        }
        // S4 — the actor-aware "may this contract create a NEW container in one step?"
        // branch (the op-admission gate + acting source live on this handler). Shared
        // predicate (used by its own tests, so the branch is never a drifting replica):
        // requires BOTH the container create op AND the TARGET write op granted — the
        // fast-track admits the whole plan, so an accurate "you may create a new one"
        // must check both, or it over-promises a create that then falls to not_granted
        // (e.g. a granted container create but a REVOKED task write). No op id / no gate
        // / no source ⇒ false (pick-only, fail-closed).
        const canCreateNewContainer = canCreateNewContainerForActor(
          deps.opAdmissionGate,
          src,
          detail,
        );
        containerPickRequired = {
          ...detail,
          ...(cpAskId !== undefined ? { ask_id: cpAskId } : {}),
          can_create_new_container: canCreateNewContainer,
        };
      }
    }

    // D-192 Slice 6c — a work-entity create in this run DECIDED to create a named
    // vendor container that doesn't exist yet (the engine coded the halting step
    // `CREATE_PLAN_REQUIRED` and preserved the plan onto `details.create_plan`).
    // Surface a terminal `create_plan_required` (like `container_pick_required` —
    // `success` stays `false`, the write didn't happen, but this is NOT a silent
    // failure), and — for an owner/interactive run without vault/context — raise ONE
    // create-plan confirm; the approved answer creates the container(s) + re-runs
    // the write off the stored selection (on deny nothing is created). A contracted
    // (external MCP) run gets the plan WITHOUT the owner ask (its answer would
    // dispatch under OWNER authority — the confused-deputy guard the container pick
    // applies). Same `result.errors` scan + single-create scope as the container
    // pick.
    let createPlanRequired: (CreatePlanDetail & { ask_id?: string }) | undefined;
    {
      const cpErr = result.errors.find((e) =>
        isCreatePlanDetail((e as RecipeError).details?.create_plan),
      );
      if (cpErr !== undefined) {
        const detail = (cpErr as RecipeError).details.create_plan as CreatePlanDetail;
        const src = request.execution_source;
        const ownerRun = src !== undefined && src.actor === 'user_self';
        let cpAskId: string | undefined;
        if (
          deps.createPlanNotifier !== undefined
          && ownerRun
          && request.vault === undefined
          && request.context === undefined
        ) {
          try {
            // `plan_id = run_id` (this failed run's id) → the re-run's deterministic
            // id `create-plan-<run_id>`; a re-dispatch of the same failed run
            // converges on one re-run, distinct create attempts get distinct plans.
            // D-192 6c.2c — the step that raised the plan is the write the confirm
            // approves; carry its id so the approved re-run admits ONLY that step's
            // vendor create (never another `ask`-create in the replayed recipe).
            const raisingStepId = (cpErr as RecipeError).source?.step_id;
            const askInput: CreatePlanAskInput = {
              plan_id: run_id,
              ...(request.recipe === undefined
                ? { recipe_id: recipe.recipe_id }
                : { recipe }),
              config: request.config ?? {},
              source_id: detail.source_id,
              kind: detail.kind,
              plans: detail.plans,
              target_summary: detail.target_summary,
              ...(typeof raisingStepId === 'string' && raisingStepId.length > 0
                ? { raising_step_id: raisingStepId }
                : {}),
            };
            cpAskId = (await raiseCreatePlanAsk(deps.createPlanNotifier, askInput)).ask_id;
          } catch (e) {
            // Best-effort raise — the response still carries the plan, so a caller
            // can render its own confirm / re-issue.
            console.warn(
              `[create-plan] failed to raise create-plan ask for source '${detail.source_id}': `
                + (e instanceof Error ? e.message : String(e)),
            );
          }
        }
        createPlanRequired = {
          ...detail,
          ...(cpAskId !== undefined ? { ask_id: cpAskId } : {}),
        };
      }
    }

    // D-157 P1 slice 3 — persist the preflight checkpoint when the
    // engine paused on a policy `ask`. The engine returns
    // `result.awaiting_approval = { gated_step_id, step_state }` with
    // `success: false` + empty `errors`; we mint `checkpoint_id` here
    // (the host owns id-minting + holds `run_id`) and write a
    // `Checkpoint` row.
    //
    // D-157 P1 slice 4 — once the checkpoint is durable, raise the
    // `notification.ask` (kind `gateway.preflight`) so the user can
    // approve / deny. `raisePreflightAsk` returns `{ ask_id }` which
    // we pair with `checkpoint_id` on the audit anchor (N.4); a boot
    // sweep can then confirm a paused run's ask is still pending in
    // D-158. The audit row's `commit_status` widens to
    // `'awaiting_approval'` for a paused run only when the
    // checkpoint write succeeded — codex BLOCKER fold: an
    // `awaiting_approval` anchor without a `checkpoint_id` would
    // violate A.2's "checkpoint persistence precedes the awaiting
    // anchor" invariant (a boot sweep pairing an awaiting anchor with
    // its checkpoint via `CheckpointStore.get` would find nothing →
    // unresumable ghost). When the checkpoint store is absent OR the
    // write fails, the run is downgraded to a terminal
    // `'failed'` audit row carrying a `CHECKPOINT_WRITE_FAILED` error
    // — the user must re-run from scratch.
    //
    // The `ask` raise is best-effort only *after* both the checkpoint and its
    // awaiting audit anchor are durable: a failure leaves the row with
    // `checkpoint_id` but no
    // `ask_id`; the boot sweep re-raises the ask off the orphaned
    // checkpoint (D-157 § A.3 — the anchor's checkpoint_id is the
    // sweep's anchor for that re-raise). The notifier itself is
    // optional — absent ⇒ the pause is durable but unsurfaced,
    // matching the in-doubt P0 posture (server-side wiring lives in
    // the deferred D-157 server-wiring slice).
    let checkpointId: string | undefined;
    let askId: string | undefined;
    let pauseFailureError: RecipeError | undefined;
    let raisePreflightAskAfterAnchor: (() => Promise<void>) | undefined;
    // Owner termination wins over an engine pause observed in the same turn.
    // A killed run is terminal: it must not leave a resumable checkpoint or
    // surface both `run_terminated` and `awaiting_approval` to callers.
    if (result.awaiting_approval && runTermination === undefined) {
      const awaitingApproval = result.awaiting_approval;
      const gated_step_id = awaitingApproval.gated_step_id;
      // ── D-157 Part C — concurrent TOCTOU backstop ────────────────────
      // The entry check collapses a SEQUENTIAL resend; this collapses a
      // CONCURRENT one — two parallel identical sends both passed the entry
      // check before either's hold was durable (reachable only via parallel
      // identical MCP requests; chat's `recipe.run` is `concurrency_safe:false`
      // → sequential, so the entry check already covers it). Three steps, in a
      // loop so a follower whose leader FAILED re-attempts:
      //   (a) a concurrent leader is creating this hold → AWAIT its outcome:
      //       `status: 'durable'` ⇒ collapse, `status: 'failed'` ⇒ the hold was
      //       not created ⇒ re-loop. Awaiting (not collapsing on bare presence) is what
      //       prevents a false "queued" when the leader fails to persist.
      //   (b) no in-flight leader → a durable twin may have appeared during
      //       this run's engine pass (a leader that finished + released) ⇒
      //       collapse.
      //   (c) atomically claim leadership (sync, no `await` since (b)); a
      //       concurrent claim during (b) loses ⇒ re-loop. The leader settles
      //       its claim in the outer `finally`.
      if (heldActionIdentity !== undefined && heldActionKey !== undefined) {
        let collapse = false;
        let collapsedRunId: string | undefined;
        // Bounded by the in-flight set: each iteration either collapses,
        // becomes the leader, or awaits a distinct leader's settle.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const leader = awaitInflightHold(heldActionKey); // (a)
          if (leader !== null) {
            const outcome = await leader;
            if (outcome.status === 'durable') {
              collapsedRunId = outcome.run_id;
              collapse = true;
              break;
            }
            continue; // leader failed — re-attempt
          }
          let twin = null;
          try {
            twin = await findLiveHeldTwin( // (b)
              { auditLog: deps.auditLog!, checkpointStore: deps.checkpointStore! },
              heldActionIdentity,
            );
          } catch {
            // Best-effort: a lookup failure proceeds to the atomic claim.
          }
          if (twin !== null) {
            collapsedRunId = twin.run_id;
            collapse = true;
            break;
          }
          const claim = claimInflightHold(heldActionKey); // (c)
          if (claim === null) continue; // lost the claim race — re-attempt
          heldClaim = claim; // we lead this hold-creation; settle in `finally`
          break;
        }
        if (collapse) {
          return stampExecuteResponseAuditRun(
            buildHeldResponseForRecipe(recipe.recipe_id, result.recipe_hash),
            collapsedRunId,
          );
        }
      }
      if (!deps.auditLog) {
        // The checkpoint alone is not a resumable run: approval-time
        // idempotency and targeting are anchored in the awaiting audit row.
        // Do not create or surface a hold when that anchor has nowhere to land.
        pauseFailureError = buildPauseFailureError(
          recipe.recipe_id,
          gated_step_id,
          'CHECKPOINT_WRITE_FAILED',
          'preflight gate fired but no audit log is wired — the approval anchor cannot be persisted; re-run after configuring durable storage',
        );
      } else if (!deps.checkpointStore) {
        // No store ⇒ no durable resume substrate; downgrade to a
        // terminal failure. The user re-runs from scratch.
        pauseFailureError = buildPauseFailureError(
          recipe.recipe_id,
          gated_step_id,
          'CHECKPOINT_STORE_UNAVAILABLE',
          'preflight gate fired but no checkpoint store is wired — run cannot be paused durably; re-run after configuring durable storage',
        );
      } else {
        try {
          const preflightContext = {
            ...(awaitingApproval.tool_slug !== undefined
              ? { tool_slug: awaitingApproval.tool_slug }
              : {}),
            ...(awaitingApproval.connection_name !== undefined
              ? { connection_name: awaitingApproval.connection_name }
              : {}),
            ...(awaitingApproval.risk_tier !== undefined
              ? { risk_tier: awaitingApproval.risk_tier }
              : {}),
            ...(awaitingApproval.reason !== undefined
              ? { reason: awaitingApproval.reason }
              : {}),
            ...(awaitingApproval.owner_override_offer !== undefined
              ? { owner_override_offer: awaitingApproval.owner_override_offer }
              : {}),
            ...(awaitingApproval.approval_clamped_from !== undefined
              ? { approval_clamped_from: awaitingApproval.approval_clamped_from }
              : {}),
            ...(awaitingApproval.authorization_provenance !== undefined
              ? {
                  authorization_provenance:
                    awaitingApproval.authorization_provenance,
                }
              : {}),
          };
          const checkpoint: Checkpoint = {
            checkpoint_id: randomUUID(),
            run_id,
            recipe_id: recipe.recipe_id,
            gated_step_id,
            // D-165 follow-on (op-identity binding) — capture the resolved
            // identity the user is approving so resume re-verifies the call
            // before honoring it. The catalog gate surfaces the full triple;
            // a simple-form gate only `ingredient_slug` (absent fields stay
            // off the object). Empty `{}` for a legacy bare pause → the
            // catalog gate re-asks on resume (fail closed).
            approved_target: {
              ...(awaitingApproval.ingredient_slug !== undefined
                ? { ingredient_slug: awaitingApproval.ingredient_slug }
                : {}),
              ...(awaitingApproval.operation_id !== undefined
                ? { operation_id: awaitingApproval.operation_id }
                : {}),
              ...(awaitingApproval.connection_name !== undefined
                ? { connection_name: awaitingApproval.connection_name }
                : {}),
            },
            ...(Object.keys(preflightContext).length > 0
              ? { preflight_context: preflightContext }
              : {}),
            step_state: awaitingApproval.step_state,
            // D-202 Slice 1b — persist the quality-relevance marker so the
            // answer-path resumer can record the owner's reject-driven quality
            // signal (approve → `quality_good`, reject → `quality_bad`) for this
            // `(recipe, op)`. Set only on a `quality_not_delegated` ask; absent
            // on every non-quality pause ⇒ no signal (behaviour-preserving).
            ...(awaitingApproval.quality_relevant !== undefined
              ? { quality_relevant: awaitingApproval.quality_relevant }
              : {}),
            // § 7 follow-on — persist the run's serialized pii ledgers so a
            // fresh-process resume can hydrate its store and restore
            // aliases (absent for the ~all runs that never aliased).
            ...(awaitingApproval.pii_ledgers !== undefined
              ? { pii_ledgers: awaitingApproval.pii_ledgers }
              : {}),
            // R2 step 6 — an INLINE run's recipe is nowhere the resumer
            // could load it from (the R2 transient dispatch is never
            // persisted; a derived saga-compensation recipe likewise), so
            // the checkpoint carries the resolved recipe the engine ran.
            // The resumer hash-verifies it against this anchor's
            // `recipe_hash` before re-instantiating (fail closed on
            // tamper). Use the PRE-ENGINE deep copy (`preEngineRecipeSnapshot`),
            // not the live `recipe`: the engine mutated the live object in
            // place (`output.sidebar`→`render`) after the anchor hash was
            // stamped, so the live object would no longer match. Store-
            // resident runs stay snapshot-free.
            ...(preEngineRecipeSnapshot !== undefined
              ? { recipe_snapshot: preEngineRecipeSnapshot as unknown as Record<string, unknown> }
              : {}),
            // R2 step 6 — a paused saga COMPENSATION run keeps its
            // compensating link durable across the pause: the resumer
            // threads it back so the resumed dispatch's commit still
            // stamps `predecessor_commit_id`.
            ...(internal.predecessor_commit_id !== undefined
              ? { predecessor_commit_id: internal.predecessor_commit_id }
              : {}),
            created_at: Date.now(),
          };
          await deps.checkpointStore.write(checkpoint);
          checkpointId = checkpoint.checkpoint_id;
          // D-185 Slice 2 — the run is durably paused and WILL resume under this
          // same `run_id`; keep its temp scratch alive across the pause.
          resumablePause = true;
          if (deps.preflightNotifier) {
            const preflightNotifier = deps.preflightNotifier;
            // Do not create an actionable ask until the awaiting audit anchor
            // exists. Approval without that anchor is a destructive no-op: the
            // resumer skips it and consumes the checkpoint.
            raisePreflightAskAfterAnchor = async () => {
              try {
                // D-157 server-wiring — the engine surfaces the gateway-
                // attached `(tool_slug, risk_tier, reason)` trio on
                // `awaiting_approval`; forward each field that's present
                // so the ask body renders the structured reason. Absent
                // fields fall back to the bare "Approve a boundary-
                // crossing call?" wording (legacy raise sites).
                //
                // D-177 P3 (N.5) — resolve the session-grant offer for this
                // hold. The pure half (`resolveSessionGrantOffer`) gates on
                // the owner cell's defaults — P4: read off the baseline
                // `contract.policy_matrix` row via `deps.contractScan` (the
                // in-code seed answers when no scan/row, e.g. the dbless
                // harness) — and the hold's tier (read/write/admin, D7). The
                // host-owned clauses here:
                //  - a wired resolver + run identity — without them the resume
                //    dispatch could neither mint nor a future dispatch match,
                //    so offering would promise nothing.
                // D-177 catalog-gate loop — the offer fires for a CATALOG hold
                // (`operation_id` SET on the signal) too: the catalog gate has
                // its own match + mint seam (`catalogSessionGrants`, wired off
                // the SAME resolver + run identity), so a grant minted off a
                // catalog hold absorbs the next catalog ask at that gate. The
                // open-projection upgrade below applies to catalog holds as
                // well since the batch/open slice: the catalog gate runs its
                // own walk (gated on the OP's `authority_args` opt-in) and
                // attaches the preview to its raise — an op without the opt-in
                // carries no preview and its offer stays EXACT. The run is
                // resumable through the normal checkpoint path by construction
                // here (this branch only runs after a durable checkpoint
                // write). Absent offer ⇒ the binary ask.
                const resolvedOffer =
                  deps.sessionGrantResolver !== undefined
                  && runIdentity !== undefined
                  && executionSource !== undefined
                    ? resolveSessionGrantOffer({
                        channel: executionSource.channel,
                        actor: executionSource.actor,
                        risk_tier: awaitingApproval.risk_tier,
                        pre_lift_approval:
                          awaitingApproval.authorization_provenance
                            ?.pre_lift_approval,
                      })
                    : undefined;
                // D-177 P5b (N.11) — upgrade the offer to `grant_mode: 'open'`
                // exactly when the held dispatch's open-projection walk
                // succeeded (the signal carried the preview — feasibility
                // proven on this very dispatch by the same closure the mint
                // and every future match recompute through). A refused walk
                // leaves the offer exact — byte-identical P3. The mode rides
                // the ask payload → answer → resume marker, so the mint
                // executes precisely what the rendered sentence described
                // (rule 7).
                const openPreview = awaitingApproval.open_projection_preview;
                const sessionGrantOffer =
                  resolvedOffer !== undefined
                    ? {
                        ...resolvedOffer,
                        ...(openPreview !== undefined
                          ? { grant_mode: 'open' as const }
                          : {}),
                      }
                    : undefined;
                // D-177 P5a (N.10) — register the hold with the batch
                // coordinator: a same-origin-unit hold JOINs the open batch
                // ask (one re-rendered ask, version bump) instead of minting
                // a second; the first hold of a unit creates the row + the
                // v1 ask (P3-compatible — same options + offer, plus the
                // batch identity + one-item rendering). Scope mirrors the
                // P3 offer: BOTH gates' holds — commit-gateway holds AND,
                // since the batch/open slice, catalog holds (`operation_id`
                // SET; the catalog gate's raise attaches the hashes/preview
                // and its proceed point claims the resumed member) — with
                // run identity present, the P1b hashes present (a
                // non-canonicalizable payload is never a batch member), and
                // a session-grantable tier (the eventual batch grant must
                // be mintable — D7). The coordinator keys the origin unit ×
                // ingredient × operation × connection, so catalog and
                // simple-form holds never share an ask. Anything else, or a
                // coordinator fallback (cap overflow / store failure /
                // close race), raises today's per-hold ask — strictly
                // additive.
                // ── D-210 Phase C — the device-fanout branch ──────────
                // The owner's `inbox_fanout_mode` picks which surface this
                // hold reaches them on. `'notify'` fires a passive
                // heads-up; `'approval'` (the default) raises the durable
                // actionable ask. ONE surface per item, never both.
                //
                // ⛔ SCOPE FENCE (owner ruling): reception-origin holds
                // ONLY. The predicate is the inbox's own visibility filter,
                // not a second derivation — a hold the branch calls
                // reception but the inbox will not list is a hold the owner
                // is notified about and then cannot find. An MCP / chat /
                // agent write is never affected: a Reception page setting
                // must not quietly stop the AI agent's approval cards.
                //
                // ⛔ AND IT SITS ABOVE THE BATCH REGISTRATION, deliberately
                // (owner ruling). Batching is an ASK-side optimization —
                // it exists to ask ONCE for many holds, and its durable
                // row, member claims and payload-version guard all exist to
                // route an ANSWER. With no ask there is nothing to batch.
                // Branching only at the `raisePreflightAsk` line below
                // would let `registerHold` win first, so notify mode would
                // silently do nothing on the main path and the owner would
                // still get an actionable card.
                const notifyOnly =
                  deps.resolveInboxFanoutMode !== undefined
                  && isReceptionOriginSource(executionSource)
                  && deps.resolveInboxFanoutMode() === 'notify';
                if (notifyOnly) {
                  await raisePreflightNotify(preflightNotifier, {
                    checkpoint,
                    context: {
                      recipe_id: recipe.recipe_id,
                      gated_step_id,
                      ...(awaitingApproval.tool_slug !== undefined
                        ? { tool_slug: awaitingApproval.tool_slug }
                        : {}),
                      ...(awaitingApproval.connection_name !== undefined
                        ? { connection_name: awaitingApproval.connection_name }
                        : {}),
                      ...(awaitingApproval.risk_tier !== undefined
                        ? { risk_tier: awaitingApproval.risk_tier }
                        : {}),
                      ...(awaitingApproval.reason !== undefined
                        ? { reason: awaitingApproval.reason }
                        : {}),
                      ...(awaitingApproval.owner_override_offer !== undefined
                        ? { owner_override_offer: awaitingApproval.owner_override_offer }
                        : {}),
                      ...(awaitingApproval.approval_clamped_from !== undefined
                        ? { approval_clamped_from: awaitingApproval.approval_clamped_from }
                        : {}),
                      ...(awaitingApproval.authorization_provenance !== undefined
                        ? {
                            authorization_provenance:
                              awaitingApproval.authorization_provenance,
                          }
                        : {}),
                    },
                  });
                  // `askId` stays undefined — the anchor is deliberately
                  // ask-less, which is exactly what the inbox's no-ask
                  // release path keys on.
                  return;
                }
                let batchAskId: string | undefined;
                if (
                  deps.batchApprovals !== undefined
                  && runIdentity !== undefined
                  && executionSource !== undefined
                  && awaitingApproval.ingredient_slug !== undefined
                  && awaitingApproval.arg_shape_hash !== undefined
                  && awaitingApproval.canonical_payload_hash !== undefined
                  && awaitingApproval.risk_tier !== undefined
                  && awaitingApproval.authorization_provenance !== undefined
                  && (
                    awaitingApproval.authorization_provenance.pre_lift_approval === 'never'
                    || awaitingApproval.authorization_provenance.pre_lift_approval === 'ask'
                  )
                  && (SESSION_GRANT_RISK_TIERS as readonly string[]).includes(
                    awaitingApproval.risk_tier,
                  )
                ) {
                  const registered = await deps.batchApprovals.registerHold({
                    source: executionSource,
                    run_id,
                    correlation_id: runIdentity.correlation_id,
                    channel_session_id: runIdentity.channel_session_id,
                    ingredient_slug: awaitingApproval.ingredient_slug,
                    // Catalog hold — the op key joins the batch key (origin
                    // unit × ingredient × OPERATION × connection, N.10) and
                    // the eventual batch grant's scope.
                    ...(awaitingApproval.operation_id !== undefined
                      ? { operation_id: awaitingApproval.operation_id }
                      : {}),
                    ...(awaitingApproval.connection_name !== undefined
                      ? {
                          connection_name:
                            awaitingApproval.connection_name,
                        }
                      : {}),
                    // Membership in SESSION_GRANT_RISK_TIERS ⊆ RiskTier was
                    // just checked — the narrowing is sound.
                    risk_tier: awaitingApproval.risk_tier as RiskTier,
                    authorization_provenance:
                      awaitingApproval.authorization_provenance,
                    recipe_id: recipe.recipe_id,
                    recipe_hash: result.recipe_hash,
                    arg_shape_hash: awaitingApproval.arg_shape_hash,
                    canonical_payload_hash:
                      awaitingApproval.canonical_payload_hash,
                    ...(awaitingApproval.args_preview !== undefined
                      ? { args_preview: awaitingApproval.args_preview }
                      : {}),
                    checkpoint,
                    ask_context: {
                      ...(awaitingApproval.tool_slug !== undefined
                        ? { tool_slug: awaitingApproval.tool_slug }
                        : {}),
                      // WHICH account the held call lands in — the ask
                      // renders it, so it has to reach the context.
                      ...(awaitingApproval.connection_name !== undefined
                        ? { connection_name: awaitingApproval.connection_name }
                        : {}),
                      ...(awaitingApproval.risk_tier !== undefined
                        ? { risk_tier: awaitingApproval.risk_tier }
                        : {}),
                      ...(awaitingApproval.reason !== undefined
                        ? { reason: awaitingApproval.reason }
                        : {}),
                      ...(awaitingApproval.owner_override_offer !== undefined
                        ? { owner_override_offer: awaitingApproval.owner_override_offer }
                        : {}),
                      ...(awaitingApproval.approval_clamped_from !== undefined
                        ? { approval_clamped_from: awaitingApproval.approval_clamped_from }
                        : {}),
                      ...(awaitingApproval.authorization_provenance !== undefined
                        ? {
                            authorization_provenance:
                              awaitingApproval.authorization_provenance,
                          }
                        : {}),
                      // D-177 P5b — rendering context for the v1 (single-
                      // member) ask's open-grant block; the coordinator
                      // drops it alongside the offer on multi-member
                      // re-renders.
                      ...(openPreview !== undefined
                        ? { open_projection_preview: openPreview }
                        : {}),
                    },
                    ...(sessionGrantOffer !== undefined
                      ? { session_grant_offer: sessionGrantOffer }
                      : {}),
                  });
                  if (registered.kind === 'registered') {
                    batchAskId = registered.ask_id;
                  }
                }
                if (batchAskId !== undefined) {
                  askId = batchAskId;
                } else {
                  const context: PreflightAskContext = {
                    recipe_id: recipe.recipe_id,
                    gated_step_id,
                    ...(awaitingApproval.tool_slug !== undefined
                      ? { tool_slug: awaitingApproval.tool_slug }
                      : {}),
                    ...(awaitingApproval.connection_name !== undefined
                      ? { connection_name: awaitingApproval.connection_name }
                      : {}),
                    ...(awaitingApproval.risk_tier !== undefined
                      ? { risk_tier: awaitingApproval.risk_tier }
                      : {}),
                    ...(awaitingApproval.reason !== undefined
                      ? { reason: awaitingApproval.reason }
                      : {}),
                    ...(awaitingApproval.owner_override_offer !== undefined
                      ? { owner_override_offer: awaitingApproval.owner_override_offer }
                      : {}),
                    ...(awaitingApproval.approval_clamped_from !== undefined
                      ? { approval_clamped_from: awaitingApproval.approval_clamped_from }
                      : {}),
                    ...(awaitingApproval.authorization_provenance !== undefined
                      ? {
                          authorization_provenance:
                            awaitingApproval.authorization_provenance,
                        }
                      : {}),
                    ...(sessionGrantOffer !== undefined
                      ? { session_grant: sessionGrantOffer }
                      : {}),
                    // D-177 P5b — the ask body's pinned/varies lines (rendered
                    // only when the offer carries grant_mode 'open').
                    ...(openPreview !== undefined
                      ? { open_projection_preview: openPreview }
                      : {}),
                  };
                  const { ask_id } = await raisePreflightAsk(
                    preflightNotifier,
                    { checkpoint, context },
                  );
                  askId = ask_id;
                }
              } catch (e) {
                // Ask raise failed — the checkpoint + anchor are durable, so
                // the boot sweep can re-raise. Log + leave `ask_id` undefined.
                console.warn(
                  `[execute-handler] preflight notification.ask raise failed for run ${run_id}: `
                    + (e instanceof Error ? e.message : String(e)),
                );
              }
            };
          }
        } catch (e) {
          // Checkpoint write failed — no durable resume substrate
          // → downgrade to terminal failure.
          console.warn(
            `[execute-handler] preflight checkpoint write failed for run ${run_id}: `
              + (e instanceof Error ? e.message : String(e)),
          );
          pauseFailureError = buildPauseFailureError(
            recipe.recipe_id,
            gated_step_id,
            'CHECKPOINT_WRITE_FAILED',
            `preflight gate fired but checkpoint write failed (${
              e instanceof Error ? e.message : String(e)
            }) — run cannot be resumed; re-run from scratch`,
          );
        }
      }
    }

    // D-179 P1 — persist the standing dish's `context.recipe.*`
    // snapshot for the NEXT run. Non-reactive runs snapshot every run
    // (D-120 Phase 4.5); reactive (`auto_run`) snapshots belong at
    // process-retire boundaries, which the auto-run scheduler owns —
    // skipped here so per-tick writes don't thrash. Best-effort: a
    // failed write degrades to last-successful-snapshot semantics.
    if (
      boundDish !== null
      && deps.dishContextStore !== undefined
      && !result.trigger_skipped
      && !result.awaiting_approval
      && request.trigger_source !== 'auto_run'
    ) {
      try {
        const { snapshot } = snapshotContextRecipe(recipe, stores);
        deps.dishContextStore.set(boundDish.dish_id, snapshot);
      } catch (e) {
        console.warn(
          `[execute-handler] dish continuity snapshot failed for ${boundDish.dish_id}: `
            + (e instanceof Error ? e.message : String(e)),
        );
      }
    }

    // Append the run-level audit entry — the execution-request
    // envelope (recipe id/hash, config, status, errors, session IDs).
    // Per-step / per-tool-call detail is the D-153 commit log's
    // concern; D-145 slice 3b.4 retired `AuditEntry.steps[]`.
    //
    // D-115 silent-skip: when the reactive trigger gate short-circuited
    // the run, we skip audit — "skipped" ticks are not logged. The
    // scheduler still updates its counter via markFinished('skipped');
    // audit surface only carries fires + failures.
    //
    // D-181 slice 4 — `runTermination` was consumed synchronously right after
    // the engine returned (above). `'killed'` overrides the engine's `failed` so
    // the anchor distinguishes a deliberate kill from a self-failure;
    // `'cancelled_before_dispatch'` leaves the anchor `failed` (the rejected
    // acquire failed the gated step) — its display category is a slice-5 concern.
    // D-181 §12 — derive the long-op display category from the structured
    // signals available right here: the in-flight registry's control-
    // termination marker (`killed` / `cancelled_before_dispatch`, consumed
    // above) + any run error's preserved stall telemetry (`details.heavy_op`).
    // Self-gating: undefined on succeeded / awaiting / ordinary-failure runs.
    const heavyOpErrorCategory = deriveHeavyOpErrorCategory({
      ...(runTermination ? { termination: runTermination } : {}),
      errors: pauseFailureError ? [pauseFailureError] : result.errors,
    });
    let auditAnchorWritten = false;
    if (deps.auditLog && !result.trigger_skipped) {
      try {
        let entry = buildAuditEntry({
          recipe_id: result.recipe_id,
          recipe_hash: result.recipe_hash,
          // D-153 P1 — engine boundary maps the synchronous
          // ExecutionResult.success boolean onto the new CommitStatus
          // enum. The non-terminal + cancelled / in_doubt values come
          // from the Gateway dispatch outbox (later P1 substrate).
          //
          // D-157 P1 slice 4 — a paused run carries
          // `'awaiting_approval'` (the run-anchor widening, N.4) so
          // the audit row reflects the engine's pause distinct from
          // a failure — BUT only when the checkpoint write succeeded
          // (codex BLOCKER fold). A paused run whose checkpoint
          // store is absent or whose checkpoint write failed
          // downgrades to a terminal `'failed'` audit row carrying
          // the `CHECKPOINT_*` error — the row never carries
          // `'awaiting_approval'` without a `checkpoint_id`. The
          // `checkpoint_id` below pins the anchor to its resumable state.
          // `ask_id` is added in a follow-up rewrite only after the base anchor
          // succeeds; a checkpoint-only awaiting anchor is intentional and the
          // boot sweep reconciles its missing ask (A.3).
          commit_status: runTermination === 'killed'
            ? 'killed'
            : result.awaiting_approval
              ? (checkpointId !== undefined ? 'awaiting_approval' : 'failed')
              : result.success ? 'succeeded' : 'failed',
          duration_ms: result.duration_ms,
          errors: pauseFailureError ? [pauseFailureError] : result.errors,
          // D-157 server-wiring (codex BLOCKER 3 fold) — capture the
          // EFFECTIVE config the engine resolved `{{config.*}}` refs
          // against, not just the recipe's variable defaults. The
          // paused-anchor resumer reads this row's `config_snapshot`
          // and re-plays the resumed call against it, so the gated
          // step resolves the same `{{config.*}}` values it had when
          // the gate fired. Previous shape (defaults-only) would let
          // a resume dispatch the wrong side effect when the user
          // passed any `request.config` overrides at the original run.
          // D-157 Part C — build the snapshot via the SAME helper the
          // held-action idempotency guard uses for its identity, so the two
          // are provably equal (a re-sent held action's guard-computed
          // identity must match THIS anchor's `config_snapshot` or the dedup
          // silently never fires). The values are unchanged from the prior raw
          // `{...recipe.variables, ...config}`: by audit time the engine has
          // populated `config` (a by-reference store) with each variable's
          // resolved default, so both forms yield resolved values + overrides
          // — but routing through `buildHeldConfigSnapshot` keeps the match
          // independent of that mutation side-effect.
          config_snapshot: buildHeldConfigSnapshot(
            recipe.variables as Record<string, unknown> | undefined,
            config,
          ),
          // Targeting guard follow-on (design § 8 / codex HIGH fold) —
          // a PAUSED run persists its caller context so the resumer
          // replays it: a gated step resolving `{{context.entity_id}}`
          // (or `{{context.event...}}`) must dispatch against the
          // approved values, not undefined. Paused anchors only —
          // terminal rows never carry caller context (page text etc.).
          ...(result.awaiting_approval
            && checkpointId !== undefined
            && request.context !== undefined
            && Object.keys(request.context).length > 0
            ? { context_snapshot: request.context }
            : {}),
          trigger_url: typeof context.url === 'string' ? context.url as string : null,
          trigger_source: request.trigger_source ?? null,
          instance_id: request.instance_id ?? deps.instanceId ?? null,
          // D-120 Phase 3 / D-145 slice 3b.3 — the run id is minted up
          // front (see `run_id` above) and always passed: it keys the
          // audit row, is the provenance link table's `memory_id`, and
          // is the Gateway commits' `request_id` — all three must
          // agree, so `buildAuditEntry` no longer mints its own.
          run_id,
          // D-179 P1 — dish attribution ("which of my 10 repos
          // failed"). Standing dish id, or the run-derived ephemeral id.
          dish_id,
          // D-120 Phase 2 — surrogate FK pointer onto recipe_insights.
          // Populated alongside the run when DB-backed; absent on
          // ext-routed runs where the field is server-only.
          ...(recipe_insight_id !== undefined ? { recipe_insight_id } : {}),
          ...(request.backfill ? { backfill: request.backfill } : {}),
          ...(request.process_id ? { process_id: request.process_id } : {}),
          // D-120 Phase 7.5 — bistemporal stamping. Declarative
          // `recipe.run_mode` wins over trigger-source inference;
          // see `deriveRunMode` for the closed mapping. Stamped on
          // every audit entry so `data.timeline()` event-axis ordering
          // can distinguish backfill (use event_at) from live activity
          // (today is fine).
          run_mode: deriveRunMode(recipe.run_mode, request.trigger_source),
          // D-145 engine-wiring (D-153 P1 + slice 2) — commit-substrate
          // session IDs + `execution_source` + contract snapshot.
          // Derived once above; stamped here so the P1.B
          // `AuditLogStore.listBy*` tier queries see this run. Empty
          // object when `execution_source` was absent.
          ...commitFields,
          // D-157 P1 slice 4 — every `'awaiting_approval'` anchor carries the
          // already-durable checkpoint pointer. `ask_id` is optional on the
          // base append and arrives only after the post-anchor ask succeeds;
          // the boot sweep reconciles a checkpoint-only anchor.
          ...(checkpointId !== undefined ? { checkpoint_id: checkpointId } : {}),
          ...(askId !== undefined ? { ask_id: askId } : {}),
          // D-181 §12 — long-op display category (failed / killed runs only).
          ...(heavyOpErrorCategory !== undefined
            ? { error_category: heavyOpErrorCategory }
            : {}),
        });
        await deps.auditLog.append(entry);
        auditAnchorWritten = true;
        // D-157 Part C — the awaiting anchor is now durable, so
        // `findLiveHeldTwin` will see it: a concurrent follower of this
        // leader can safely collapse. (Settled `status: 'durable'` in the outer
        // `finally`; any earlier-exit path leaves this false → `status: 'failed'`,
        // so the follower re-attempts rather than reporting a phantom hold.)
        if (entry.commit_status === 'awaiting_approval') {
          heldActionDurable = true;
          // The durable anchor is the authorization boundary. Only now may an
          // actionable ask (or batch membership) be created. Persist the ask
          // pointer as a follow-up best-effort rewrite; if that rewrite fails,
          // the already-durable checkpoint + anchor remain safely resumable and
          // the boot sweep can reconcile the missing pointer.
          await raisePreflightAskAfterAnchor?.();
          if (askId !== undefined) {
            const entryWithAsk = { ...entry, ask_id: askId };
            try {
              await deps.auditLog.append(entryWithAsk);
              entry = entryWithAsk;
            } catch (askPointerError) {
              const degraded = markResultDegraded('audit_unwritten');
              logRunObservabilityWriteFailure({
                run_id,
                failed_write: 'audit_append',
                degraded: 'audit_unwritten',
                all_degraded: degraded,
                error: askPointerError,
              });
            }
          }
        }
        // D-121 Phase 6 — memory event for the audit row.
        emitMemoryAudit(deps.eventBus, entry.run_id);
        // The recipe_insight is created the first time we see this
        // recipe-shape hash; emit even on subsequent runs (small,
        // cheap signal — the UI can dedupe on the surrogate id).
        if (recipe_insight_id !== undefined) {
          emitMemoryInsight(deps.eventBus, String(recipe_insight_id));
        }

        // D-120 Phase 3 — persist the buffered link emissions onto
        // the same audit row's `run_id`. Skipped silently when
        // disabled (no DB, opt-out, or empty buffer); the run-time
        // gates above already returned an undefined `linkSink` so
        // `link_buffer` stays empty in that case.
        if (
          deps.db !== undefined &&
          pre_run_id !== undefined &&
          recipe_insight_id !== undefined &&
          link_buffer.length > 0
        ) {
          try {
            const inserted = insertLinks(
              deps.db,
              {
                memory_id: pre_run_id,
                recipe_insight_id,
                // D-161 P1 — propagate this run's origin onto every
                // emitted link (I-6). A recipe run dispatched by an MCP
                // agent / Reception carries that actor; sync / housekeeping
                // / legacy no-source runs resolve to SYSTEM_ORIGIN.
                origin: originProvenanceFromOptionalSource(executionSource),
              },
              link_buffer,
            );
            // D-121 Phase 6 — single memory.link event covers the bulk
            // insert; ID is the audit row's run_id (= memory_id) so
            // viewers can fetch all links for that run on demand.
            if (inserted > 0) emitMemoryLink(deps.eventBus, pre_run_id);
          } catch (e) {
            const degraded = markResultDegraded('provenance_incomplete');
            logRunObservabilityWriteFailure({
              run_id,
              failed_write: 'provenance_links',
              degraded: 'provenance_incomplete',
              all_degraded: degraded,
              error: e,
            });
            try {
              await deps.auditLog.append({ ...entry, degraded });
              emitMemoryAudit(deps.eventBus, entry.run_id);
            } catch (markerError) {
              logRunObservabilityWriteFailure({
                run_id,
                failed_write: 'audit_degraded_marker',
                degraded: 'provenance_incomplete',
                all_degraded: degraded,
                error: markerError,
              });
            }
          }
        }
      } catch (e) {
        const degraded = markResultDegraded('audit_unwritten');
        logRunObservabilityWriteFailure({
          run_id,
          failed_write: 'audit_append',
          degraded: 'audit_unwritten',
          all_degraded: degraded,
          error: e,
        });
        if (
          result.awaiting_approval !== undefined
          && checkpointId !== undefined
          && !auditAnchorWritten
        ) {
          // A checkpoint without its awaiting anchor is not a valid hold. The
          // ask has deliberately not been raised yet, so rollback is confined
          // to the checkpoint and the caller receives a terminal failure.
          const orphanedCheckpointId = checkpointId;
          checkpointId = undefined;
          askId = undefined;
          resumablePause = false;
          heldActionDurable = false;
          pauseFailureError = buildPauseFailureError(
            recipe.recipe_id,
            result.awaiting_approval.gated_step_id,
            'CHECKPOINT_WRITE_FAILED',
            `preflight gate fired but its awaiting audit anchor could not be persisted (${
              e instanceof Error ? e.message : String(e)
            }) — run cannot be resumed; re-run from scratch`,
          );
          try {
            await deps.checkpointStore?.delete(orphanedCheckpointId);
          } catch (cleanupError) {
            console.warn(
              `[execute-handler] failed to delete checkpoint ${orphanedCheckpointId} after awaiting anchor write failure: `
                + (cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
            );
          }
        }
      }
    }

    // D-121 Phase 6 — execution `complete` (or `error` when the
    // result captured engine errors). Skipped runs (trigger gate
    // short-circuit) emit nothing — same convention as audit log.
    //
    // D-157 P1 slice 4 — a successfully paused run (checkpoint
    // wrote) is neither complete nor a genuine error; the run-anchor
    // `'awaiting_approval'` audit row is the authoritative status
    // surface (emitted via the `memory.audit` event below). Sending
    // an `'error'` event here would render in paired clients as
    // "your recipe failed" — misleading. The execution-lifecycle op
    // union stays its closed `start | progress | complete | error`
    // set; widening it to carry `'awaiting_approval'` is the
    // downstream notification-block server-wiring slice's concern.
    //
    // A paused run that DOWNGRADED to terminal failure (no
    // checkpoint store, or checkpoint write failed —
    // `pauseFailureError !== undefined`) emits `'error'` like any
    // other terminal failure.
    const isDurablyPaused =
      runTermination === undefined
      && result.awaiting_approval !== undefined
      && pauseFailureError === undefined;
    if (!result.trigger_skipped && !isDurablyPaused) {
      const terminalSuccess = result.success && !pauseFailureError;
      emitExecution(deps.eventBus, {
        recipe_id: recipe.recipe_id,
        run_id: lifecycle_run_id,
        op: terminalSuccess ? 'complete' : 'error',
      });
      // D-179 P4 — run-outcome trigger source. Backfill runs are
      // suppressed (D-120 precedent — cursor loops must not fan out
      // per-iteration handler fires); the origin trigger id rides the
      // payload so the dispatcher can break direct self-loops.
      if (deriveRunMode(recipe.run_mode, request.trigger_source) !== 'backfill') {
        const firstError = pauseFailureError ?? result.errors[0];
        // The minted `run_id` (the paused anchor's on resumes), NOT
        // `lifecycle_run_id` — the latter degrades to a synthetic
        // `inflight:…` id when provenance is off / db absent, which
        // handlers couldn't join back to the audit row (codex fold).
        emitRunOutcome(deps.warehouseBus, {
          recipe_id: recipe.recipe_id,
          dish_id,
          run_id,
          outcome: terminalSuccess ? 'completed' : 'failed',
          at: Date.now(),
          duration_ms: result.duration_ms,
          ...(terminalSuccess || !firstError ? {} : { error: firstError.message }),
          ...(origin_trigger_id !== undefined ? { origin_trigger_id } : {}),
        });
      }
    }

    // R2 step 6 (write-saga) — torn-saga detection + disclosure. A run
    // that terminal-failed (the 'error' branch above — NOT a durable
    // pause, which is a waiting state, and NOT a trigger skip) is
    // checked against its own commit log: did any catalog WRITE land
    // before it died? If so the run is a torn cross-system saga
    // ("B created, A-delete failed") and the user gets ONE
    // `notification.ask` (kind `gateway.saga`) disclosing the landed
    // writes, with an `undo` option for each write whose inverse the
    // catalog itself declares (`deriveCompensation` — create→delete
    // only; never inferred). The undo dispatches LATER, on the user's
    // answer, as a fresh gated run — nothing here acts on the world.
    //
    // Requires the commit substrate (runIdentity + commitStore — no
    // commits, nothing to detect against) and the notifier. Best-effort
    // AFTER the audit anchor write: a detection/raise failure leaves
    // the torn state visible in the commit log but unsurfaced (logged;
    // a boot re-sweep for unsurfaced torn runs is a noted follow-on).
    // A resumed run re-enters under the SAME run_id (the paused
    // anchor's), so pause→approve→resume→fail still sees every commit
    // of the whole logical run here.
    //
    // One-ask-per-torn-run holds by reachability, not by a durable
    // suppression row: a logical run reaches this hook a second time
    // only by re-entering `handleExecute` under the same `run_id`, and
    // both internal channels guard that — `PreflightResumer.decide`
    // skips terminal anchors (an answer replay after the failure never
    // re-runs), and the saga dispatcher's at-entry anchor check skips
    // any existing compensation run. A wire caller cannot name a
    // `run_id` at all (`InternalExecuteOverrides`). If a future host
    // path re-dispatches terminal run ids, add an asked-run suppression
    // here rather than relaxing those guards.
    if (
      !result.trigger_skipped
      && !isDurablyPaused
      && !(result.success && pauseFailureError === undefined)
      && deps.sagaNotifier !== undefined
      && deps.commitStore !== undefined
      && runIdentity !== undefined
    ) {
      try {
        const commits = await deps.commitStore.listByRun(run_id);
        const saga = detectTornSaga({
          run_id,
          recipe_id: recipe.recipe_id,
          commits,
          getManifest: (slug) =>
            deps.executorConfig.manifests.get(slug) ?? undefined,
        });
        if (saga !== null) {
          const plans = new Map<string, SagaCompensationPlanRef>();
          for (const w of saga.landed_writes) {
            // Only an unambiguous, fully-attributed landed write may
            // derive an undo — ambiguity/drift discloses but never
            // compensates (fail toward disclosure, away from undo).
            if (!w.unambiguous || w.operation_key === '' || w.connection_name === '') {
              continue;
            }
            const manifest = deps.executorConfig.manifests.get(w.catalog_slug);
            if (!manifest) continue;
            const plan = deriveCompensation(
              {
                commit_id: w.commit_id,
                operation_key: w.operation_key,
                operation_id: w.operation_id,
                catalog_slug: w.catalog_slug,
                connection_name: w.connection_name,
                output: w.output,
              },
              manifest,
            );
            if (plan !== null) plans.set(w.commit_id, plan);
          }
          await raiseSagaAsk(deps.sagaNotifier, saga, plans);
        }
      } catch (e) {
        console.warn(
          `[execute-handler] torn-saga detection/raise failed for run ${run_id}: `
            + (e instanceof Error ? e.message : String(e)),
        );
      }
    }

    return stampExecuteResponseAuditRun({
      recipe_id: result.recipe_id,
      recipe_hash: result.recipe_hash,
      // D-157 P1 slice 4 — a pause-downgrade surfaces `success: false`
      // with the substituted error; the engine's `success: false` on
      // a durable pause is faithful (the run didn't complete) and
      // the response leaves it at that.
      success: result.success && pauseFailureError === undefined,
      output: result.output,
      steps: result.steps.map((s) => ({
        id: s.id,
        type: s.type,
        skipped: s.skipped,
        duration_ms: s.duration_ms,
        error: s.error,
      })),
      errors: pauseFailureError ? [pauseFailureError] : result.errors,
      duration_ms: result.duration_ms,
      ...(result.degraded && result.degraded.length > 0 ? { degraded: result.degraded } : {}),
      ...(result.trigger_skipped ? { trigger_skipped: true } : {}),
      ...(result.next_run_at !== undefined ? { next_run_at: result.next_run_at } : {}),
      // D-157 — surface the durable pause as a first-class marker so callers
      // (esp. the chat tool-loop) can tell the model the action is queued for
      // approval, not silently failed. Only when the pause is durable (the
      // checkpoint was written); a downgraded pause stays a terminal failure.
      ...(isDurablyPaused ? { awaiting_approval: true } : {}),
      // D-192 Slice 6b — surface an ambiguous-container create as a first-class
      // marker (the D-158 pick ask was raised; the create re-runs off the pick)
      // so the chat tool-loop tells the model the create is queued behind a
      // choice instead of retrying the bare `success: false`. Carries the choice
      // set (+ `ask_id` when raised) for a UI's own picker.
      ...(containerPickRequired ? { container_pick_required: containerPickRequired } : {}),
      // D-192 Slice 6c — the create-plan confirm marker (one ask enumerating the
      // container create(s) + the pending write; on approval both run).
      ...(createPlanRequired ? { create_plan_required: createPlanRequired } : {}),
      // D-181 § 9 — surface an OWNER-initiated termination (kill / cancel-in-
      // queue, consumed above as `runTermination`) so the agent-facing
      // projection renders a "the user cancelled this" tool result instead of
      // mistaking the resulting `success: false` for a retryable failure.
      // Unset on success / pause / ordinary failure.
      ...(runTermination ? { run_terminated: runTermination } : {}),
      // D-182 §10 step 8 / R1 — pre-run warnings for canonical reads that
      // returned an empty result because their convention's provider is not
      // connected (the recipe ran on empty data). Present only when ≥1 fired.
      ...(runnabilityWarnings.length > 0 ? { runnability_warnings: runnabilityWarnings } : {}),
    }, auditAnchorWritten ? run_id : undefined);
  } catch (e) {
    // Preserve already-coded errors (shouldn't happen from the engine,
    // but keeps the abstraction honest if a deeper layer ever throws one).
    emitExecution(deps.eventBus, {
      recipe_id: recipe.recipe_id,
      run_id: lifecycle_run_id,
      op: 'error',
    });
    if (e instanceof RpcError) throw e;
    throw new RpcError(
      'execution_error',
      e instanceof Error ? e.message : String(e),
      500,
    );
  } finally {
    // D-157 Part C — settle this run's in-flight hold claim (if it led one),
    // releasing any concurrent follower awaiting the outcome. `status:
    // 'durable'` iff the awaiting anchor was written (so the follower
    // collapses); otherwise `status: 'failed'` — the hold did NOT
    // materialise (checkpoint-store error, an early-exit, or a throw), so the
    // follower re-attempts rather than reporting a phantom hold. A no-op when
    // this run never led (the common, uncontended path). `settle` is
    // idempotent + always removes the registry slot.
    heldClaim?.settle(
      heldActionDurable
        ? { status: 'durable', run_id }
        : { status: 'failed' },
    );
    // D-181 slice 4 — drop this run from the live active-list (idempotent;
    // also clears any unconsumed termination marker). The run's heavy-call
    // slots already released on settle via the governor's `finally`.
    if (registerLiveRun) deps.inFlightRegistry!.completeRun(run_id);
    // D-185 Slice 2 — reclaim this run's `storage:'temp'` cli output at the
    // TERMINAL run end (success, throw, killed, or pause-downgraded-to-failure).
    // Every `temp` ref the run produced lives under `runScratchRoot(run_id)`;
    // removing it enforces "a temp ref must not outlive its run" (§3.4). SKIPPED
    // on a resumable pause: that run continues under the same `run_id` in a later
    // invocation, which performs the terminal sweep. Best-effort + idempotent +
    // a no-op when the run produced no temp output (the root never existed).
    if (!resumablePause) cleanupRunScratch(run_id);
  }
};

/** D-157 P1 slice 4 — build a `RecipeError` for a paused run that
 *  downgraded to terminal failure because the durable resume substrate
 *  isn't available (no `checkpointStore` / audit log wired, the checkpoint
 *  write failed, or the awaiting audit anchor could not be persisted). The
 *  audit row's `commit_status` stays `'failed'` rather
 *  than `'awaiting_approval'` so the anchor invariant
 *  ("`awaiting_approval` rows MUST carry `checkpoint_id`") holds.
 *  Surfaced like any other recipe error so the upstream dispatcher
 *  + UI render a normal failure message; the user re-runs from
 *  scratch.
 *
 *  Spec: D-157 § A.2 / N.3 / I-4 (codex BLOCKER fold —
 *  the anchor MUST link its checkpoint when awaiting). */
const buildPauseFailureError = (
  recipe_id: string,
  step_id: string,
  code: 'CHECKPOINT_STORE_UNAVAILABLE' | 'CHECKPOINT_WRITE_FAILED',
  detail: string,
): RecipeError => ({
  error_id: `preflight-${Date.now().toString(36)}-${recipe_id}`,
  code,
  message: detail,
  severity: 'fatal',
  source: {
    recipe_id,
    step_id,
    ingredient_slug: null,
  },
  details: {},
  timestamp: new Date().toISOString(),
  retryable: false,
});

/** D-153 P2.C — assemble the failure-path response when the
 *  pre-execution policy gate denies any ingredient step. Mirrors the
 *  normal failure path: emits lifecycle `error`, appends an audit row
 *  with `commit_status: 'failed'` carrying the deny summary, and
 *  returns a structured ExecuteResponse the upstream dispatcher
 *  (scheduler / API caller) surfaces like any other recipe error.
 *
 *  Audit best-effort: a failed audit append never throws — provenance
 *  emission stays best-effort because the gate already refused
 *  dispatch (no external side-effect happened). */
const handlePolicyGateDenial = async (args: {
  deps: ExecuteHandlerDeps;
  recipe: RecipeDefinition;
  request: ExecuteRequest;
  denials: ReadonlyArray<PolicyGateDenial>;
  lifecycle_run_id: string;
  /** D-145 engine-wiring slice 3b.3 — the run id minted up front by
   *  `handleExecute`, always defined. Keys the denial audit row. (A
   *  denied dispatch writes no commits — the gate refused before
   *  `executeRecipe` — so the Gateway is not involved here; the run id
   *  is needed only for the audit row.) */
  run_id: string;
  /** D-179 P1 — dish attribution for the denial row (standing dish id
   *  or the run-derived ephemeral id, same as the success path). */
  dish_id: string;
  recipe_insight_id: number | undefined;
  /** D-145 engine-wiring (D-153 P1) — commit-substrate identity
   *  derived by `handleExecute`. A denied dispatch is a confirmed
   *  `failed` commit and carries the same session IDs as a normal
   *  run, so the channel-session tier-query surfaces the denial too. */
  commitFields: CommitSubstrateFields;
}): Promise<ExecuteResponse> => {
  const {
    deps,
    recipe,
    request,
    denials,
    lifecycle_run_id,
    run_id,
    dish_id,
    recipe_insight_id,
    commitFields,
  } = args;
  const summary = renderPolicyGateDenialSummary(denials);
  const recipe_hash = hashRecipe(recipe);
  const first = denials[0];
  const policyDenyError = {
    error_id: `policy-${Date.now().toString(36)}-${recipe.recipe_id}`,
    code: 'RECIPE_POLICY_DENIED' as const,
    message: summary,
    severity: 'fatal' as const,
    source: {
      recipe_id: recipe.recipe_id,
      step_id: first ? first.step_id : null,
      ingredient_slug: first ? first.ingredient : null,
    },
    details: { denials },
    timestamp: new Date().toISOString(),
    retryable: false,
  };

  emitExecution(deps.eventBus, {
    recipe_id: recipe.recipe_id,
    run_id: lifecycle_run_id,
    op: 'error',
  });

  // D-179 P4 — a policy-denied dispatch is a terminal failure too: a
  // pipeline's failure handler should hear about it (the gate refused
  // before the engine ran; commit_status 'failed' below agrees).
  if (deriveRunMode(recipe.run_mode, request.trigger_source) !== 'backfill') {
    const origin_trigger_id = originTriggerIdFromContext(request.context);
    // Audit-joinable `run_id`, not `lifecycle_run_id` — see the
    // terminal-site emit (codex fold).
    emitRunOutcome(deps.warehouseBus, {
      recipe_id: recipe.recipe_id,
      dish_id,
      run_id,
      outcome: 'failed',
      at: Date.now(),
      error: summary,
      ...(origin_trigger_id !== undefined ? { origin_trigger_id } : {}),
    });
  }

  let auditAnchorWritten = false;
  if (deps.auditLog) {
    try {
      const entry = buildAuditEntry({
        recipe_id: recipe.recipe_id,
        recipe_hash,
        // D-153 P1 mapping — denied dispatch is a confirmed failure
        // (no external side-effect happened; the gate refused before
        // the engine ran). `'failed'` is the right CommitStatus.
        commit_status: 'failed',
        duration_ms: 0,
        errors: [policyDenyError],
        // D-157 server-wiring (codex BLOCKER 3 fold) — see the matching
        // edit on the success path. Capture effective config, not just
        // recipe defaults, so transparency-surface reads see the same
        // values the gate evaluated against.
        config_snapshot: {
          ...(recipe.variables ?? {}),
          ...(request.config ?? {}),
        },
        trigger_url: null,
        trigger_source: request.trigger_source ?? null,
        instance_id: request.instance_id ?? deps.instanceId ?? null,
        run_id,
        dish_id,
        ...(recipe_insight_id !== undefined ? { recipe_insight_id } : {}),
        ...(request.backfill ? { backfill: request.backfill } : {}),
        ...(request.process_id ? { process_id: request.process_id } : {}),
        run_mode: deriveRunMode(recipe.run_mode, request.trigger_source),
        // D-145 engine-wiring (D-153 P1 + slice 2) — same
        // commit-substrate session IDs + `execution_source` as a
        // normal run, so the channel-session tier-query surfaces the
        // denial alongside successful commits.
        ...commitFields,
      });
      await deps.auditLog.append(entry);
      auditAnchorWritten = true;
      emitMemoryAudit(deps.eventBus, entry.run_id);
    } catch {
      // Audit best-effort — never break the deny-response path.
    }
  }

  return stampExecuteResponseAuditRun({
    recipe_id: recipe.recipe_id,
    recipe_hash,
    success: false,
    output: { render: [], sidebar: [] },
    steps: [],
    errors: [policyDenyError],
    duration_ms: 0,
  }, auditAnchorWritten ? run_id : undefined);
};

/** D-120 Phase 3 — resolve the surrogate `recipe_insights.id` for the
 *  recipe about to execute. Three paths:
 *
 *    1. Row exists from a prior install (`recipeStore.save`) or
 *       boot-time backfill — return its id.
 *    2. Row missing AND flatten produces a payload within the size
 *       cap — insert via `getOrCreateRecipeInsight` and return the
 *       new id. This covers inline POST /execute that bypasses the
 *       install path; the substrate stays consistent (every run
 *       has an insight FK).
 *    3. Row missing AND flatten exceeds the cap (pathological
 *       recipe shape) — return undefined; the caller skips link
 *       emission for the run.
 *
 *  Failure-tolerant: any thrown error degrades to undefined. Link
 *  emission is best-effort substrate, never load-bearing on the
 *  recipe run itself. */
const ensureRecipeInsightId = (
  db: import('better-sqlite3').Database,
  recipe: RecipeDefinition,
  recipe_hash: string,
): number | undefined => {
  try {
    const row = db
      .prepare(`SELECT id FROM recipe_insights WHERE hash = ?`)
      .get(recipe_hash) as { id: number } | undefined;
    if (row) return row.id;
    const flattened = flattenRecipe(recipe);
    const { json, over_cap } = serializeFlattenedInsight(flattened);
    if (over_cap) return undefined;
    return getOrCreateRecipeInsight(db, {
      hash: recipe_hash,
      slug: recipe.recipe_id,
      version: recipe.version,
      flattened: json,
    });
  } catch {
    return undefined;
  }
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type ExecuteMethods = 'execute';

/** D-153 P2.C — build the `ExecuteRequest` for an rpc `execute` call.
 *  Pure shape construction over (rpc args, connected client) so tests
 *  can verify the channel-shaped `execution_source` threading without
 *  spinning the full `handleExecute` pipeline. The rpc handler below
 *  is the sole production caller. */
const buildRpcExecuteRequest = (
  args: Record<string, unknown>,
  client: WsClient,
): ExecuteRequest => ({
  recipe_id: args.recipe_id as string | undefined,
  recipe: args.recipe,
  config: args.config as Record<string, unknown> | undefined,
  context: args.context as Record<string, unknown> | undefined,
  vault: args.vault as Record<string, unknown> | undefined,
  // D-179 P1 — standing-dish dispatch over the rpc wire (overlay merge
  // + audit attribution resolve inside handleExecute).
  dish_id: args.dish_id as string | undefined,
  trigger_source: (args.trigger_source as string | undefined) ?? 'extension_ws',
  instance_id: client.instance_id ?? undefined,
  // D-153 P2.C — channel-shaped `ExecutionSource` resolved at the rpc
  // wire boundary. Threads onto the `ExecuteRequest` so the pre-execute
  // policy gate (`POLICY_GATED_USER_CHANNELS` ➜ `(user, user_self)`
  // cell) evaluates against the baseline coarse `(allowed_kinds ×
  // allowed_risk_tiers)` cell. No `ContractSnapshot` because the rpc
  // surface today is the local owner driving their own client.
  execution_source: buildRpcUserExecutionSource(client),
});

export const makeExecuteHandlers = (
  deps: ExecuteHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ExecuteMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['execute'],
    handlers: {
      'execute': async (args, client) =>
        handleExecute(deps, buildRpcExecuteRequest(args, client)),
    },
  };
};

/** D-153 P2.C — test-only surface exposing the rpc-side
 *  `ExecutionSource` builder + the full `ExecuteRequest` constructor
 *  used by `makeExecuteHandlers`. Production code resolves through
 *  the handler factory; tests verify both helpers in isolation
 *  without depending on the WS or `handleExecute` plumbing. */
export const _testing = {
  buildRpcUserExecutionSource,
  buildRpcExecuteRequest,
  customerControlsD162Batch,
  customerControlledD162ExtraUnits,
  /** D-145 engine-wiring (D-153 P1) — the process-lived correlation
   *  tracker. Suites that drive `handleExecute` repeatedly call
   *  `.reset()` in `beforeEach` so intent-burst grouping doesn't
   *  bleed across tests. */
  correlationTracker,
};
