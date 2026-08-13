/** Extension ↔ recued-server rpc method registry.
 *
 *  Mirrors the method table in `backend/server/src/ws-server.ts`. When
 *  a new method is added on the server, append an entry here so
 *  callers get compile-time checking. When a method is renamed, change
 *  it here and the caller will fail to compile — forcing an update.
 *
 *  The types are intentionally minimal (request fields only the
 *  server cares about, response fields only the client uses). Richer
 *  domain shapes stay in their own modules (CacheEntry, Schedule, …)
 *  and are re-referenced here.
 */

import type { RpcMethodSpec } from './types.js';
import type { BridgeCapabilityProfile } from '../bridge.js';
import type { Dish, DishGroup, DishLastRun, DishRunRow } from '../dish.js';
import type { CacheEntry } from '../cache.js';
import type {
  RecipeDefinition,
  RecipeInvocation,
  ResolvedOutputSection,
} from '../recipe.js';
import type { RecipeRunnabilityEntry } from '../recipe-runnability.js';
import type { RecipePiiDisclosureEntry } from '../recipe-pii-trace.js';
import type { InstancePrefs } from '../prefs.js';
import type { PressureDetails } from '../pressure.js';
import type { LifecycleStatus } from '../lifecycle.js';
import type { RunAnchorStatus } from '../commits.js';
import type { RunControlTermination } from '../execution-control.js';
import type { QualityGateSwitchStatus } from '../quality-delegation.js';
import type { TriggerTestRequest, TriggerTestResponse } from '../trigger-test.js';
import type {
  OAuthAppConfigSnapshot,
  SetOAuthAppConfigArgs,
  ClearOAuthAppConfigArgs,
} from '../foundational-oauth.js';
import type {
  MirrorSearchRequest,
  MirrorSearchResponse,
  TimelineRequest,
  TimelineResponse,
  TimelineRollup,
} from '../mcp.js';
import type {
  EngagementsResolverArgs,
  EngagementsResolverResult,
} from '../engagement.js';
import type {
  WorkEntityListRpcRequest,
  WorkEntityListRpcResponse,
  WorkEntityGetRpcRequest,
  WorkEntityGetRpcResponse,
  WorkEntityUpsertRpcRequest,
  WorkEntityUpsertRpcResponse,
  WorkEntityDeleteRpcRequest,
  WorkEntityDeleteRpcResponse,
} from '../work-entity-rpc.js';
import type {
  FormResponseGetRpcRequest,
  FormResponseSetStateRpcRequest,
  FormResponseSetStateRpcResponse,
  FormResponseGetRpcResponse,
  FormResponseListQuery,
  FormResponseListRpcResponse,
  FormResponseUpdateRpcRequest,
  FormResponseUpdateRpcResponse,
  FormResponseExportRpcRequest,
  FormResponseExportRpcResponse,
} from '../form-response.js';
import type {
  RecordsExportResponse,
  RecordsExportRequest,
  RecordsGlobalQuotaSetRequest,
  RecordsGlobalQuotaSnapshot,
  RecordsKindSummary,
  RecordsNamespaceView,
  RecordsOutboxListRequest,
  RecordsOutboxOverview,
  RecordsOutboxRetireRequest,
  RecordsOwnerDeleteRequest,
  RecordsOwnerGetResponse,
  RecordsOwnerGetRequest,
  RecordsOwnerSearchRequest,
  RecordsPackRef,
  RecordsPurgeRequest,
  RecordsQuotaSetRequest,
  RecordsQuotaSnapshot,
  RecordsRetentionPolicy,
  RecordsRetentionRunRequest,
  RecordsRetentionSetRequest,
  RecordsSearchResult,
} from '../records.js';
import type {
  CollectionAuthState,
  CollectionHealth,
  CollectionInstanceRow,
  CollectionListQuery,
  CollectionPlatform,
  CollectionRecord,
  CollectionSearchMatch,
  CollectionSearchQuery,
  FileAdapterType,
  FileCollectionCaps,
} from '../collections.js';
import type {
  Annotation,
  AnnotationFilter,
  AnnotationSearchMatch,
  AnnotationSearchQuery,
  Link,
  LinkFilter,
} from '../annotation.js';
import type { ContactContributionView } from '../contact-contribution.js';
import type {
  ContactRecord,
  ContactSource,
  ContactMergeCandidate,
  MailingAddress,
  PlatformIdEntry,
} from '../contact.js';
import type {
  ContactAliasPlatform,
  NetworkDomain,
} from '../contact-identity.js';
import type {
  ContactSourceHealth,
  ContactImportCandidate,
  ContactImportFilePlan,
} from '../contact-sources.js';
import type {
  UpstreamMergeDescribeRequest,
  UpstreamMergeDescribeResponse,
  UpstreamMergeDiscardInput,
  UpstreamMergeDiscardResponse,
  UpstreamMergeListInput,
  UpstreamMergeListResponse,
  UpstreamMergeRequestInput,
  UpstreamMergeRequestResponse,
  UpstreamMergeRetryInput,
  UpstreamMergeRetryResponse,
} from '../upstream-merge.js';
import type {
  ConnectionAuth,
  ConnectionCredentialRejectionCorrection,
  ConnectionCredentialPostSafeStopVerificationSummary,
  ConnectionCredentialRotationActivity,
  ConnectionCredentialRotationOutcome,
  ConnectionCredentialRotationSafeStopAcknowledgement,
  ConnectionCredentialRotationSafeStopSummary,
  ConnectionCredentialVerification,
  ConnectionDataPurgeSummary,
  ConnectionHealth,
  ConnectionKind,
  ConnectionView,
} from '../connection.js';
import type { NotificationDeliveryChannel } from '../notifications.js';
import type { MessageMatchPattern } from '../message-match.js';
import type {
  LocalRecipeWebhookStatus,
  WebhookDeliveryDetailView,
  WebhookDeliveryEventGetRequest,
  WebhookDeliveryEventPayloadView,
  WebhookDeliveryGetRequest,
  WebhookDeliveryListRequest,
  WebhookDeliveryListResponse,
  WebhookDeliveryRetentionPruneRequest,
  WebhookDeliveryRetentionPruneResponse,
  WebhookRejectedDeliveryListRequest,
  WebhookRejectedDeliveryListResponse,
  WebhookIngressCreateRequest,
  WebhookIngressBindingSelection,
  WebhookIngressCredentialRetireRequest,
  WebhookIngressCredentialWriteRequest,
  WebhookIngressCredentialWriteResponse,
  WebhookIngressDisableRequest,
  WebhookIngressEnableRequest,
  WebhookIngressManualConfirmRequest,
  WebhookIngressRegistrationReconcileRequest,
  WebhookIngressRetireRequest,
  WebhookIngressTestDeliveryRequest,
  WebhookIngressTestDeliveryResponse,
  WebhookIngressUpdateRequest,
  WebhookIngressListResponse,
  WebhookIngressView,
} from '../webhook-profiles.js';
import type {
  OperationGroupGrantView,
  McpPackReviewRow,
} from '../ingredient-catalog.js';
import type { Actor, Channel } from '../commits.js';
import type { ProvenanceAttribution } from '../provenance-attribution.js';
import type {
  ExecutionGetRequest,
  ExecutionGetResponse,
  ExecutionListQuery,
  ExecutionListResponse,
} from '../execution-rpc.js';
import type {
  ExecutionActiveRequest,
  ExecutionActiveResponse,
  ExecutionKillRequest,
  ExecutionKillResponse,
  ExecutionCancelRequest,
  ExecutionCancelResponse,
  ExecutionPromoteRequest,
  ExecutionPromoteResponse,
} from '../execution-control.js';
import type {
  UploadCreateRpcRequest,
  UploadCreateRpcResponse,
  UploadProbeRpcRequest,
  UploadProbeRpcResponse,
  UploadFinalizeRpcRequest,
  UploadFinalizeRpcResponse,
  UploadDeleteRpcRequest,
  UploadDeleteRpcResponse,
} from '../upload-frame.js';
import type {
  ArchiveUploadCreateRpcRequest,
  ArchiveUploadCreateRpcResponse,
  ArchiveUploadProbeRpcRequest,
  ArchiveUploadProbeRpcResponse,
  ArchiveUploadFinalizeRpcRequest,
  ArchiveUploadFinalizeRpcResponse,
  ArchiveUploadDeleteRpcRequest,
  ArchiveUploadDeleteRpcResponse,
} from '../archive-upload.js';
import type {
  CatalogIngredientView,
  OverridePolicyInput,
  OverrideView,
} from '../contract-override.js';
import type {
  OwnerOperationIngredientView,
  OwnerOperationPolicyInput,
  OwnerOperationView,
} from '../owner-operation-override.js';
import type {
  ContractDefinitionView,
  ContractListRequest,
  ContractListResponse,
  MintContractRequest,
  SessionGrantListRequest,
  SessionGrantListResponse,
  SessionGrantRevokeRequest,
  SessionGrantView,
  SetContractDoorTypesRequest,
} from '../contract-definition.js';
import type { DelegationRuleSuggestionRow } from '../delegation-suggestion.js';
import type { QualityDelegationSuggestionRow } from '../quality-delegation-suggestion.js';
import type { ScopedGrantSuggestionRow } from '../scoped-grant-suggestion.js';
import type {
  EngagementHealthRequest,
  EngagementHealthResponse,
  ReprobeEngagementCapabilitiesRequest,
  ReprobeEngagementCapabilitiesResponse,
} from '../engagement-rpc.js';
import type { SubscribeRequest, SubscribeAck } from '../events.js';
import type {
  ChatCatalogDeliveryMode,
  ChatModelRoutingLayer,
  ChatModelSourceId,
  ChatPlanRecord,
  ChatPlanProposal,
  IssuedMcpInboundToken,
  McpInboundConcurrencyTier,
  McpInboundTokenRecord,
  ToolEntry,
} from '../chat.js';
import type { CalendarCollectionCaps } from '../calendar.js';
import type {
  ServiceCollectionCaps,
  ServiceEnrollInput,
  ServiceEnrollOutput,
  ServiceInstallOutput,
  ServiceInstanceList,
  ServiceStatus,
  ServiceTemplateList,
  ServiceTemplateListInput,
  ServiceUninstallOutput,
  ServiceUpgradeOutput,
} from '../service.js';
import type { EventTrigger, EventTriggerPattern } from '../triggers.js';
import type { AutoRunStatusEntry } from '../reactive.js';
import type { WatchSourceStatusEntry, WatchStatusEntry } from '../watch.js';
import type {
  ArchiveImportRebind,
  ArchiveJobStatus,
  ArchiveManifest,
  ArchiveRealmRelation,
  ArchiveSchemaCompat,
} from '../archive.js';
import type { RecipeError } from '../errors.js';
import type {
  AuditExportEstimate,
  AuditExportPage,
  AuditExportRequest,
} from './audit-export.js';
import type {
  MemoryListRequest,
  MemoryListResponse,
  MemoryGetRequest,
  MemoryGetResponse,
  MemoryCreateRequest,
  MemoryUpdateRequest,
  MemoryMutationResult,
  MemoryDeleteRequest,
  MemoryDeleteResult,
  MemoryImportRequest,
  MemoryImportResult,
} from './memory.js';
import type {
  ExposurePreset,
  ExposureState,
  PathResolution,
  PathRole,
  RootApexMode,
  TLSDomainCertListEntry,
  TLSDomainCertSource,
  TLSDomainUploadIssue,
  TLSDomainUploadResult,
  NetworkLocalUrlsResponse,
} from '../network.js';
import type {
  KeyHealthView,
  KeyRotateRequest,
  RotationResult,
} from '../d-148-rotation.js';
import type {
  ServerPassportExportOptions,
  ServerPassportHistoryEntry,
  ServerPassportHistoryListArgs,
  ServerPassportImportCommitResult,
  ServerPassportProjection,
} from '../passport.js';
import type {
  ProAuthenticateRequest,
  ProAuthenticateResponse,
  ProCurrentRequest,
  ProCurrentResponse,
  ProSignOutRequest,
  ProSignOutResponse,
} from '../d148-pro-auth.js';
import type {
  HostnameAddRequest,
  HostnameGetRequest,
  HostnameGetResponse,
  HostnameListResponse,
  HostnameMutationResponse,
  HostnameOwnershipProofInput,
  HostnameOwnershipProofResult,
  HostnameRemoveRequest,
  HostnameRemoveResponse,
  HostnameUpdateRequest,
} from '../hostname.js';
import type {
  SellerManualCustomerCloseRequest,
  SellerManualCustomerCloseResponse,
  SellerManualCustomerExtendRequest,
  SellerManualCustomerExtendResponse,
  SellerManualCustomerIssueRequest,
  SellerManualCustomerIssueResponse,
  SellerManualCustomerReissueTokenRequest,
  SellerManualCustomerReissueTokenResponse,
  SellerManualCustomerSwapTierRequest,
  SellerManualCustomerSwapTierResponse,
  SellerManualTierBulkAdjustRequest,
  SellerManualTierBulkAdjustResponse,
  SellerManualTierUpsertRequest,
  SellerManualTierUpsertResponse,
  SellerCreatePassTierRequest,
  SellerCreatePassTierResponse,
  SellerOfferStateTransitionRequest,
  SellerOfferStateTransitionResponse,
  SellerOverview,
  SellerSettingsUpdateRequest,
  SellerSettingsUpdateResponse,
  SellerAcknowledgeLlmGatewayPaidRequest,
  SellerAcknowledgeLlmGatewayPaidResponse,
  SellerStripeSynchronizeRequest,
  SellerStripeSynchronizeResponse,
} from '../seller.js';
import type {
  SellerListOrdersRequest,
  SellerListOrdersResponse,
} from '../seller-order.js';

export type { CacheEntry };

// ────────────────────────────────────────────────────────────────
// server.llm.* — extension reads/writes the server's LLM config
// ────────────────────────────────────────────────────────────────

/** LLM config as seen over the wire. Mirrors `@recued/llm` `LLMConfig`
 *  but kept loosely typed here so contracts doesn't depend on @recued/llm.
 *  Callers cast to LLMConfig at the boundary. */
export type ServerLLMConfig = Record<string, unknown>;

/** A single BYOK slot or free-pool entry as seen over the wire — same
 *  loose contract as `ServerLLMConfig` (validated server-side via
 *  `parseLLMConfig`). Used by the D-174 R28 field-level write rpcs that
 *  edit ONE slot / entry without resending the whole config blob. */
export type ServerLLMSlot = Record<string, unknown>;
export type ServerLLMPoolEntry = Record<string, unknown>;

/** The model-facing surfaces whose system prompt the owner can author from
 *  Settings → AI/Models. `chat` covers owner chat + messenger; `llm_gateway`
 *  is the OpenAI-compatible door, one prompt for every caller. */
export type ServerLlmPromptSurface = 'chat' | 'llm_gateway';

/** Wire role a system prompt can be delivered under. Mirrors `@recued/llm`'s
 *  `LLMMessageRole`; restated here only because contracts must not depend on
 *  @recued/llm. The server validates against the real union on write. */
export type ServerLlmMessageRole = 'system' | 'user' | 'assistant';

/** What the llm_gateway does with a CALLER's OpenAI `system` message.
 *
 *  `context` (default, the pre-existing behaviour) — it reaches the model as
 *  contract-scoped data the model follows, below the owner's authority.
 *  `append` / `replace` promote it to real system instructions, beside or
 *  instead of the owner's role block. `ignore` drops it.
 *
 *  ⚠ Every value operates on the owner's ROLE BLOCK alone. A caller on
 *  `replace` still cannot touch Recued's core or feature text, and none of them
 *  can widen the contract — capability is enforced in code at the Gateway. */
export type ServerLlmCallerSystemPolicy =
  | 'context'
  | 'append'
  | 'replace'
  | 'ignore';

/** One surface's prompt state, as `server.getLlmPrompts` returns it.
 *
 *  ⚠ THE EDITABLE UNIT IS `role_instructions`, NOT THE WHOLE PROMPT. It is
 *  block 1 — who the model is and what to weigh ("You are a dental assistant
 *  for Dr. Chen; check the calendar before answering about appointments"). The
 *  substrate composes Recued's core text (the AIOutput wire contract) and its
 *  feature text (tool mechanics, the approvals posture, the gateway's
 *  contract-scoping lines) AROUND it on every turn, and neither is reachable
 *  from here by the owner OR by a gateway caller.
 *
 *  `always_on_text` is those blocks, shipped so the page can render them
 *  READ-ONLY beneath the editor: an owner should be able to SEE everything else
 *  the model is told. A fence you cannot read is indistinguishable from a fence
 *  that is not there. */
export interface ServerLlmPrompt {
  surface: ServerLlmPromptSurface;
  /** The owner's block 1 in force (their text when authored, else the built-in). */
  role_instructions: string;
  /** The built-in block 1. Pre-fills the editor; what "Reset to default" restores. */
  default_role_instructions: string;
  /** The blocks the owner cannot edit, in the order the model reads them. */
  always_on_text: string[];
  /** The whole composed prompt as it would ship right now. Preview only. */
  composed_preview: string;
  /** Transport knob — which wire role the prompt is delivered under. Unrelated
   *  to the role the owner WRITES in block 1. */
  role: ServerLlmMessageRole;
  default_role: ServerLlmMessageRole;
  /** False once the owner has authored a replacement for block 1. Drives the
   *  "Customised" badge and the reset control. Never gates a write. */
  is_default: boolean;
  /** llm_gateway only — what a caller's own `system` message is allowed to do. */
  caller_system_policy?: ServerLlmCallerSystemPolicy;
}

// ────────────────────────────────────────────────────────────────
// auth.* — encryption state, unlock, migration
// ────────────────────────────────────────────────────────────────

export type ServerAuthState = 'uninitialized' | 'locked' | 'unlocked';

export interface ServerAuthMigrationStatus {
  active: boolean;
  phase?: string;
  progress?: {
    rowsDone: number;
    rowsTotal: number;
    blobsDone: number;
    blobsTotal: number;
  };
  startedAt?: number;
  bundleMissing?: boolean;
}

// ────────────────────────────────────────────────────────────────
// schedules.* — owning-instance schedules
// ────────────────────────────────────────────────────────────────

export interface ServerSchedule {
  schedule_id: string;
  recipe_id: string;
  publisher_id: string;
  /** Absent means legacy recurring cron schedule. */
  mode?: 'recurring' | 'one_shot';
  cron_expression: string;
  /** One-shot schedules fire once at this absolute Unix-ms timestamp. */
  run_at?: number;
  enabled: boolean;
  created_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
  last_status: 'success' | 'error' | 'skipped' | null;
  last_error: string | null;
  instance_id?: string;
  /** D-179 P2 — standing dish this schedule dispatches as. */
  dish_id?: string;
  /** D-179 — the config the schedule's headless fires use, read from the
   *  bound dish at list time (absent ⇒ fires on recipe defaults). Surfaced
   *  so the run modal's per-row Config editor can pre-fill the widgets. */
  config_overlay?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────
// Schema-driven scalar server config
// ────────────────────────────────────────────────────────────────

/** One field in the server's scalar-config schema. The server is the
 *  source of truth for both the shape AND the current value — the
 *  extension renders from this without per-field UI code. Rich
 *  surfaces (LLM pool editor, schedules, vault) keep their bespoke
 *  components; this handles simple budgets / flags / enums / strings. */
export interface ServerConfigField {
  /** Group heading the renderer uses to order fields. Free-form; the
   *  renderer groups fields by this value preserving schema order. */
  section: string;
  /** Stable key used by `server.setConfigField`. Dot-notation
   *  convention (`llm.allow_upgrade_default`) for readability; the
   *  dispatch table on the server maps each key to its storage. */
  key: string;
  /** UI-facing label — "Allow LLM upgrade by default". */
  label: string;
  /** Optional help text rendered beneath the control. */
  description?: string;
  /** Discriminator for the rendered control. */
  type: 'boolean' | 'number' | 'string' | 'enum';
  /** Current value. Literal type depends on `type`; renderer narrows. */
  value: ServerConfigValue;
  /** Required when `type === 'enum'`. Ordered option list. */
  enum?: string[];
  /** For `type: 'number'`. */
  min?: number;
  max?: number;
  integer?: boolean;
}

/** Permitted value kinds. A value of `null` is reserved for
 *  future-proofing optional settings — v1 always returns a concrete
 *  value matching the declared `type`. */
export type ServerConfigValue = boolean | number | string;

/** D-169 P1 N.5 #1 — rich server status snapshot. Sourced from the
 *  `system.status` rpc on side-panel mount + each periodic refresh
 *  tick. The shape is dashboard-shared baseline (D-169 O-7); future
 *  amendments extend it as the webclient server dashboard grows
 *  (whichever client ships next adopts the same rpc).
 *
 *  Field semantics:
 *   - `name` — user-set server display name. Falls back to the
 *      environment-resolved default when unset.
 *   - `version` — server build version string. Matches the
 *      `__RECUED_SERVER_VERSION__` build define; `'unknown'` in
 *      dbless / dev contexts.
 *   - `uptime_seconds` — process uptime at snapshot time. Whole seconds.
 *   - `paired_client_count` — distinct paired-device count (durable;
 *      includes offline pairs). `paired_client_connected` is the
 *      live-WS subset.
 *   - `ws_state` — coarse roster bucket. `'serving'` = ≥ 1 connected
 *      client; `'idle'` = 0 connected; `'offline'` = WS server not
 *      started yet (boot-race / lifecycle-recover window).
 *   - `last_sync_at` — Unix ms of the most recent durable inbound from
 *      any client (register frame / rpc / events.subscribe attach).
 *      Null when nothing has connected since boot.
 *   - `executions_last_hour` / `executions_last_24h` — best-effort
 *      counters over the audit log. The server returns `null` for
 *      either when its memory subsystem isn't wired (dbless).
 *   - `pending_asks` / `schedule_queue_depth` / `recent_error_count`
 *      — best-effort counters; `null` when the backing store isn't
 *      composed.
 *   - `snapshot_at` — Unix ms when the snapshot was assembled. Lets the
 *      side panel age the data without keeping its own clock. */
export interface ServerSystemStatus {
  name: string;
  version: string;
  uptime_seconds: number;
  paired_client_count: number;
  paired_client_connected: number;
  ws_state: 'serving' | 'idle' | 'offline';
  last_sync_at: number | null;
  executions_last_hour: number | null;
  executions_last_24h: number | null;
  pending_asks: number | null;
  schedule_queue_depth: number | null;
  recent_error_count: number | null;
  /** D-212 §7.10 — how the server keyfile is protected at rest.
   *
   *  `'machine'` a platform secret store · `'passphrase'` the operator's
   *  `RECUED_IDENTITY_PASSPHRASE` · `'none'` **UNSEALED** — the key that opens
   *  the warehouse sits readable in the warehouse's own directory, so a copy of
   *  that directory yields everything.
   *
   *  ⛔ `'none'` is NOT `null` and must never render the same way. `null` is the
   *  usual not-wired case this shape uses for counters; `'none'` is a KNOWN and
   *  materially worse posture. §7.10 lets an operator choose unsealed, and the
   *  floor it enforces instead of a refusal is that the choice stays visible —
   *  so a client rendering `'none'` as "—" would remove the only control that
   *  replaced the retracted §7.9 gate. */
  keyfile_sealing: 'machine' | 'passphrase' | 'none' | null;
  snapshot_at: number;
}

/** D-169 P2 — one recent recipe execution, sourced by the bridge side
 *  panel section #2 (N.5 #2) from `execution.recent` on mount + reconnect.
 *  A trimmed projection of the D-120 `AuditEntry` — only the fields the
 *  "recipe results" list renders, so the full audit payload (config
 *  snapshot, per-step results) never crosses to the bridge.
 *
 *   - `run_id` — the audit row's stable id; doubles as the dedup key
 *      against the live `execution` bus frame (which carries the same
 *      `run_id`), so a run that is both in the rpc-fetched slice and the
 *      live buffer merges to one row.
 *   - `status` — the run-anchor lifecycle status (`succeeded` / `failed`
 *      / a non-terminal Gateway value).
 *   - `error_category` — the first error's code when the run failed;
 *      absent on success. */
export interface ServerRecentExecution {
  run_id: string;
  recipe_id: string;
  status: RunAnchorStatus;
  started_at: number;
  duration_ms: number;
  error_category?: string;
  /** D-161 P3 — the run's write-actor lane (derived from the audit row's
   *  `execution_source.actor`; `'system'` when the row carried none). The
   *  default feed foregrounds `user_self`+`system`; this field lets the
   *  client badge / group the outside-actor lanes (agents = `contracted_user`,
   *  reception = `anonymous`) it reached via an explicit `origin_actors`
   *  filter. Additive + optional. */
  origin_actor?: Actor;
  /** D-161 P4 — provenance-honesty attribution for an outside-actor run.
   *  Present ONLY when the run's write-actor is `contracted_user` ("agent
   *  X, under contract Y, asserted this") or `anonymous` ("visitor-
   *  derived"); a derived descriptor rendered at read time from the audit
   *  row's `execution_source` + `contract_snapshot` (O-3 — not a stored
   *  column). Absent on the foregrounded gold-path lane (`user_self` /
   *  `system`): a first-person run renders as the user's own activity,
   *  exactly as today (I-9 / I-10). */
  attribution?: ProvenanceAttribution;
}

/** D-169 P2 — one recent notification the block fired, sourced by the
 *  bridge side panel section #3 (N.5 #3) from `notification.recent`.
 *  Backed by `notification_fired` activity rows: D-169 P2 makes the
 *  block's `notify` durable (it was previously bus-only / ephemeral), so
 *  the historical slice survives a server restart.
 *
 *   - `id` — the activity row's stable id; the dedup key WITHIN the
 *      historical slice. The live `notification.notify` bus frame carries
 *      no durable id (only a monotonic cursor), so a client merging
 *      historical + live rows falls back to `(fired_at, text)` for
 *      cross-source dedup. */
export interface ServerRecentNotification {
  id: string;
  title?: string;
  text: string;
  link_url?: string;
  fired_at: number;
}

/** D-169 P2 — one currently-open ask, sourced by the bridge side panel
 *  section #4 (N.5 #4) from `notification.pending_asks`. A trimmed
 *  projection of the D-158 `PendingAsk`: `@recued/contracts` does not
 *  depend on `@recued/notification`, so the renderable fields are inlined
 *  here (same posture as `ServerPendingApproval`). Slice 2 renders these
 *  read-only; Slice 3 wires the interactive approval card +
 *  `notification.submitAnswer`. `ask_id` is the stable dedup key against
 *  the live `notification.ask` / `notification.ask_closed` bus frames. */
export interface ServerPendingAsk {
  ask_id: string;
  title?: string;
  text: string;
  options: { id: string; label: string }[];
  created_at: number;
  /** D-234 § 234.3 — "read the thing this is about", already absolute.
   *
   *  ⛔ THIS FIELD EXISTS BECAUSE THE PROJECTION IS AN ENUMERATING COPIER.
   *  `handlePendingAsks` rebuilds each ask as a literal, so a message field it
   *  does not NAME is dropped on the way to the in-app card — every messenger
   *  channel appends `link_url` and the `/ask` landing renders it, and the one
   *  surface that would have silently lacked it is the webclient. Mirrors
   *  `NotificationMessage.link_url`; absent when the raiser had no link. */
  link_url?: string;
  /** D-234 § 234.4e — this ask invites a written reason, and whether one is
   *  required. Absent ⇒ the card renders no note field.
   *
   *  ⛔ THE SAME ENUMERATING-COPIER TRAP AS `link_url` ABOVE, one field along.
   *  The server refuses a bare option on a `'required'` ask, so a projection
   *  that dropped this would give the webclient a card whose submit silently
   *  no-ops — the answer looks sent, the ask stays open, and nothing reports a
   *  fault. Naming it here is what makes the client able to collect it at all. */
  note_prompt?: 'optional' | 'required';
  /** D-234 § 234.4f — the document the answerer reads before deciding.
   *
   *  ⛔ THIS RPC IS PAIR-AUTHENTICATED, WHICH IS WHY THE BODY MAY BE HERE AT
   *  ALL. It is the owner's own signed-in surface; the notification that travels
   *  to Slack / Telegram / email carries only `text`, and the bearer
   *  `/ask/<ask_id>` landing renders that same message. Same ask, two
   *  audiences — the question goes everywhere, the document does not. */
  body?: string;
}

/** One row from `pair.list`. Mirrors `PairedInstance` from the server
 *  plus the live `connected` bit joined in from the ws roster. */
export interface ServerPairedDevice {
  instance_id: string;
  display_name: string;
  /** Client surface this device paired as — drives the parenthesized
   *  kind label in the Devices roster (e.g. "Phone (Bridge)"). Mirrors
   *  the server's `ClientKind`; legacy rows with no recorded kind
   *  resolve to `'webclient'` at the store boundary. */
  kind: 'bridge' | 'webclient' | 'cli';
  /** Unix seconds — first successful register for this instance. */
  added_at: number;
  /** Unix seconds — set when `pair.revoke` ran. Null = currently paired. */
  revoked_at: number | null;
  /** Currently holding an open WebSocket to the server. */
  connected: boolean;
  /** Unix seconds of the live WS connection's connected_at. Present
   *  only when `connected: true`. */
  connected_at?: number;
}

// ────────────────────────────────────────────────────────────────
// The registry
// ────────────────────────────────────────────────────────────────

/** Each entry declares `{ request; response }`. Use `void` for no-arg
 *  methods so the typed `Conn` overload can omit the second argument. */
/** Execute response shape. Mirrors `ExecuteResponse` in the server —
 *  redeclared here so contracts doesn't depend on server internals. */
export interface ServerExecuteResponse {
  recipe_id: string;
  recipe_hash: string;
  success: boolean;
  output: {
    render: ResolvedOutputSection[];
    sidebar: ResolvedOutputSection[];
  };
  steps: {
    id: string; type: string; skipped: boolean; duration_ms: number; error: unknown;
    /** Per-item tally for a `foreach` step. A foreach is continue-on-error, so
     *  its failures never reach `error` / `errors[]` / `success` — this is the
     *  only place above the step output where "every item was refused" is
     *  distinguishable from "every item was written". */
    foreach?: { items: number; failed: number };
  }[];
  errors: unknown[];
  duration_ms: number;
  /** D-157 — run paused at the approval gate. Distinct from a terminal failure. */
  awaiting_approval?: boolean;
  /** D-181 — owner-initiated run termination, distinct from recipe failure. */
  run_terminated?: RunControlTermination;
  /** D-182 §10 step 8 / R1 — pre-run warnings for `core.crm.*`/`core.acct.*`
   *  read/search ops whose convention provider was not connected: the op
   *  returned an empty result and the recipe ran on empty data (the recipe
   *  CONTINUES — downstream-safe), so `success` can be `true` while this
   *  discloses the degraded read to the owner. An unbound canonical WRITE fails
   *  closed pre-run (`connection_required`) instead. Present only when ≥1
   *  fired. */
  runnability_warnings?: string[];
}

/** Migration progress snapshot. Mirrors `MigrationResult` from
 *  `backend/server/src/migration/migration-runner.ts`. */
export interface ServerMigrationResult {
  rowsMigrated: number;
  blobsMigrated: number;
  tookMs: number;
}

/** D-119 Phase 10 — server-side pending approval row. The server
 *  emits one of these for each unresolved approval it knows about:
 *  approvals it generated locally (cron / reactive / mcp) AND
 *  approvals proxied from a paired extension's run that the server
 *  is hosting. The shape mirrors `ApprovalPendingRecord` but trims
 *  fields the extension doesn't render (channel handles, etc.). */
export interface ServerPendingApproval {
  approval_id: string;
  recipe_id: string;
  step_id: string;
  ingredient_slug: string;
  /** Risk tier surfaced for the approval prompt — 'write' / 'admin'
   *  / 'destructive'. Mirrors the engine's tier field. */
  risk_tier: 'write' | 'admin' | 'destructive';
  /** Human-readable summary. */
  description: string;
  /** Resolved input payload — what gets sent to the ingredient if
   *  the user approves. */
  resolved_input: Record<string, unknown>;
  /** Epoch ms — server-generated timestamp for sort + age UI. */
  created_at: number;
  /** Epoch ms — when the approval auto-denies if not acted on. */
  timeout_at: number;
  /** Server-resolved instance id of whichever device originated the
   *  approval. Helps the extension show "from your phone" hints when
   *  showing approvals from another paired ext. */
  initiator_instance: string;
}

/** D-119 Phase 10 — first-write-wins resolution outcome. The server
 *  records the first resolution it saw per `approval_id`; subsequent
 *  resolves are no-ops and return `accepted: false` so the caller
 *  knows another device already acted. */
export interface ServerApprovalResolveResult {
  approval_id: string;
  /** True when this resolve was accepted (first writer). False when
   *  another device's resolve already won — caller should reconcile
   *  by re-fetching `approval.list`. */
  accepted: boolean;
  /** Populated when accepted=false — describes who won so the UI can
   *  render "decided on Work Laptop just now". */
  winner_instance?: string;
  winner_decision?: 'approve' | 'reject' | 'cancel';
}

/** D-119 Phase 10 — push event emitted to subscribed clients when
 *  the pending list changes (added or resolved). The subscription
 *  delivers these via the existing pair-WS push channel; clients
 *  refresh `approval.list` on receipt. */
export interface ServerApprovalSubscriptionEvent {
  /** Monotonically increasing per-server. Lets clients detect missed
   *  events (gap → re-fetch full list). */
  seq: number;
  /** Number of pending approvals at the moment the event was
   *  emitted. Drives the Attention counter. */
  pending_count: number;
}

/** D-119 Phase 5 — server-scope recipe list entry. Lighter than the
 *  extension's `InstalledRecipe` because the server doesn't track
 *  upstream-version / last-checked timestamps (those are extension-side
 *  marketplace concerns). The sidebar's server-scope rendering only
 *  needs the recipe definition + identity + provenance. */
export interface ServerRecipeListEntry {
  recipe_id: string;
  publisher_id: string;
  /** Major version of the recipe as installed on the server. Bundled
   *  recipes carry the same `version` field as their definition. */
  version: number;
  /** Hash of the recipe-as-stored. Lets the extension detect drift
   *  between its local mirror and the server's copy. */
  recipe_hash: string;
  /** Full recipe definition — sidebar uses this for name/platform/
   *  trigger rendering. Bigger than necessary on first paint, but
   *  avoids a per-row `recipe.get` round-trip on scope switch. */
  recipe: RecipeDefinition;
  /** Provenance — bundled with the server binary, pushed by the paired
   *  extension, or sent inline through `execute`. */
  source: 'bundled' | 'pair-sync' | 'inline';
  /** Epoch ms — when the recipe was first stored on the server.
   *  Bundled recipes report the server's startup time; pair-synced
   *  recipes report install time; inline recipes report 0 since they
   *  aren't really "installed". */
  installed_at: number;
}

// ────────────────────────────────────────────────────────────────
// shared.* — kernel ingredient dispatch (D-103 Phase A)
// ────────────────────────────────────────────────────────────────

export interface SharedListEntry {
  key: string;
  value: unknown;
}

export interface SharedReadResult {
  found: boolean;
  key: string;
  value?: unknown;
  /** Store-owned CAS token. Null means a legacy LWW row. */
  cas_revision?: number | null;
}

export interface SharedCompareAndSetResult {
  ok: true;
  key: string;
  revision: number;
  created: boolean;
  bytes_written: number;
}

export interface SharedSearchMatch {
  key: string;
  value: unknown;
  rank: number;
}

// ────────────────────────────────────────────────────────────────
// server.* — bootstrap + status + kill switch (D-103 Phase A)
// ────────────────────────────────────────────────────────────────

/** Read-side bootstrap view. Mirrors `[bootstrap]` section of the
 *  server's TOML config file plus a restart-required hint when a
 *  stageBootstrap patch is pending. */
export interface ServerBootstrapView {
  data_path: string;
  bind_host: string;
  bind_port: number;
  mcp_port: number;
  webhook_port: number;
  log_path: string;
  /** True if a previously-staged patch is pending a restart. */
  pending_restart: boolean;
}

export interface ServerBootstrapStageResult {
  valid: boolean;
  /** Populated when `valid === false`. Field path → human message. */
  errors?: Record<string, string>;
  /** True when at least one of the patched fields requires a restart
   *  for the change to take effect. */
  restart_required: boolean;
}

export interface ServerStatus {
  version: string;
  /** Overall storage state — the most-constrained gate wins. `halted`
   *  iff the kill switch is active. Equal to `pressure_details.worst_state`
   *  (duplicated here for callers that want one field, not two). */
  storage_state: 'running' | 'pressure_managed' | 'writes_blocked' | 'halted';
  crash_halt_active: boolean;
  /** D-188 — the master "Pause server" circuit-breaker is engaged. A
   *  distinct axis from `crash_halt_active`: pause halts execution +
   *  doors (gate freeze + scheduler stop + webhook closure) but never
   *  halts storage writes, so `storage_state` is unaffected by pause. */
  paused: boolean;
  /** Per-surface breakdown + worst-state aggregate. Phase B: the shape
   *  mirrors the heartbeat-envelope `pressure_details` field so
   *  renderers consume one type across both inputs. */
  pressure_details: PressureDetails;
}

// ────────────────────────────────────────────────────────────────
// Pressure admin (Phase B)
// ────────────────────────────────────────────────────────────────

/** Response from `server.runPressureReclaim`. */
export interface ServerPressureReclaimResult {
  /** True when a reclaim actually ran. False when debounced (already
   *  ran within the cooldown window and `force` was not set) or
   *  coalesced into an in-flight reclaim whose result arrived first. */
  ran: boolean;
  /** Total bytes reclaimed across every pipeline step on this surface. */
  bytes_freed: number;
  /** Names of the pipeline steps that actually ran. Examples:
   *   `['cache_lru']` — cache surface reclaimed its L1 + L2.
   *   `['audit_age_prune','audit_size_prune']` — audit retention pruner.
   *   `['orphan_cas_sweep']` — shared_store / cache orphan sweep.
   *   `[]` — nothing ran (e.g. surface already at `running`). */
  steps_run: string[];
  /** Populated only when `ran === false`. Distinguishes "already ran"
   *  (`debounced`) from "joined an in-flight reclaim" (`coalesced`)
   *  from "unknown surface" (`no_such_surface`) from "surface not
   *  evictable" (`not_evictable`) or a cascade whose shutdown drain has
   *  already begun (`closed`). */
  reason_if_skipped?:
    | 'debounced'
    | 'coalesced'
    | 'no_such_surface'
    | 'not_evictable'
    | 'closed';
}

export type ServerRpcRegistry = {
  // ── Cache ───────────────────────────────────────────────────────
  //
  // D-103 dropped `cache.invalidate`. TTL + LRU handle expiry; the prior
  // explicit-invalidation design attracted cross-peer security questions
  // that disappeared once instance_id left the cache key, without
  // providing a load-bearing freshness guarantee that TTL doesn't cover.
  'cache.get': RpcMethodSpec<{ key: string }, { entry: CacheEntry | null }>;
  'cache.put': RpcMethodSpec<{ entries: CacheEntry[] }, { accepted: number; skipped: number }>;
  'cache.since': RpcMethodSpec<
    { cursor: number; limit?: number },
    { entries: CacheEntry[]; next_cursor: number | null }
  >;

  // ── Prefs (pair-scoped instance preferences) ────────────────────
  //
  // The extension authors these; the server mirrors per-peer. Both
  // sides read the merged result via `applyPrefsPatch` so unknown
  // keys degrade forward-compatibly. Pair transport only (no cloud,
  // no Pro gate) — each paired extension has its own slot on the
  // server keyed by `instance_id`. See `packages/contracts/src/prefs.ts`
  // for the registry of known keys + defaults.
  'prefs.get': RpcMethodSpec<void, { prefs: InstancePrefs }>;
  'prefs.set': RpcMethodSpec<
    { patch: Partial<InstancePrefs> },
    { prefs: InstancePrefs }
  >;

  // ── Auth ────────────────────────────────────────────────────────
  //
  // Handler presence, not a nullable response, signals "configured".
  // A server without auth deps wired up omits the handler; the
  // dispatcher returns `not_configured` (501) for absent keys. Keep
  // responses non-nullable here so callers don't null-check.
  'auth.state': RpcMethodSpec<void, { state: ServerAuthState }>;
  'auth.init': RpcMethodSpec<
    { password: string },
    { state: ServerAuthState; recoveryKey: string }
  >;
  'auth.unlock': RpcMethodSpec<
    { password?: string; recoveryKey?: string },
    { state: ServerAuthState }
  >;
  'auth.lock': RpcMethodSpec<void, { state: ServerAuthState }>;
  'auth.rotatePassword': RpcMethodSpec<
    { oldPassword: string; newPassword: string },
    { ok: true }
  >;

  // ── Migration ───────────────────────────────────────────────────
  'auth.migrate.prepare': RpcMethodSpec<
    { password: string },
    { recoveryKey: string; bundle: string; verificationId: string; expiresInMs: number }
  >;
  'auth.migrate.commit': RpcMethodSpec<
    { verificationId: string; password: string },
    { state: ServerAuthState; migrated: ServerMigrationResult }
  >;
  'auth.migrate.status': RpcMethodSpec<void, ServerAuthMigrationStatus>;
  'auth.migrate.resume': RpcMethodSpec<
    { password: string; bundle?: string },
    { state: ServerAuthState; migrated: ServerMigrationResult }
  >;

  // ── Schedules ───────────────────────────────────────────────────
  'schedules.list': RpcMethodSpec<{ recipe_id?: string }, { schedules: ServerSchedule[] }>;
  'schedules.create': RpcMethodSpec<
    {
      recipe_id: string;
      publisher_id?: string;
      mode?: 'recurring' | 'one_shot';
      cron_expression?: string;
      run_at?: number;
      enabled?: boolean;
      /** D-179 P2 — standing dish this schedule dispatches as. */
      dish_id?: string;
      /** D-179 — config overlay for the headless fires this schedule
       *  drives. Non-empty + no explicit `dish_id` ⇒ the server mints a
       *  managed dish to hold it (dissolved on `schedules.delete`). */
      config_overlay?: Record<string, unknown>;
      [k: string]: unknown;
    },
    { schedule: ServerSchedule }
  >;
  'schedules.update': RpcMethodSpec<
    {
      schedule_id: string;
      cron_expression?: unknown;
      enabled?: unknown;
      /** D-179 — edit the config the schedule's headless fires use. A
       *  changed overlay mints a new managed dish + dissolves the prior
       *  (immutable — one `dish_id` = one config); `{}` clears. */
      config_overlay?: Record<string, unknown>;
    },
    { schedule: ServerSchedule }
  >;
  'schedules.delete': RpcMethodSpec<{ schedule_id: string }, { deleted: true }>;

  // ── Dishes (D-179 P1 — execution instances) ─────────────────────
  /** List standing dishes, optionally filtered by recipe. Ephemeral
   *  (manual-run) dishes never appear — they are audit-row ids only.
   *
   *  D-215 slice 3 — `last_runs` maps `dish_id` → its newest run, for the
   *  list's last-outcome cell. Resolved in ONE audit scan for the whole
   *  page (`latestByDishes`), never per row. A dish that has never run is
   *  ABSENT from the map, not present with nulls. Omitted entirely when
   *  no audit store is wired, so a caller must treat "no map" and "not in
   *  the map" alike: unknown, render "never run". */
  'dishes.list': RpcMethodSpec<
    { recipe_id?: string },
    { dishes: Dish[]; last_runs?: Record<string, DishLastRun> }
  >;
  /** Mint a standing dish. `is_default: true` claims the recipe's
   *  single default-dish slot (`conflict` when one already exists). */
  'dishes.create': RpcMethodSpec<
    {
      recipe_id: string;
      publisher_id?: string;
      name?: string;
      config_overlay?: Record<string, unknown>;
      enabled?: boolean;
      is_default?: boolean;
      group_id?: string;
      [k: string]: unknown;
    },
    { dish: Dish }
  >;
  'dishes.update': RpcMethodSpec<
    {
      dish_id: string;
      name?: unknown;
      config_overlay?: unknown;
      enabled?: unknown;
      /** `null` detaches the dish from its group. */
      group_id?: unknown;
    },
    { dish: Dish }
  >;
  /** Delete a standing dish + its continuity snapshot. */
  'dishes.delete': RpcMethodSpec<{ dish_id: string }, { deleted: true }>;
  /** D-215 slice 5 — one dish's run history, newest first.
   *
   *  Keyed on `dish_id` ALONE and consulting no dish store, so it keeps
   *  answering for a RETIRED dish (auto-run versioning dissolves the prior
   *  dish on every config change; a one-shot retires itself on success).
   *  An unknown id is an empty list, never an error — "this dish has no
   *  runs" and "this dish is gone" are both legitimate answers here and
   *  the caller distinguishes them by whether `dishes.list` still has the
   *  row. */
  'dishes.history': RpcMethodSpec<
    { dish_id: string; limit?: number },
    { runs: DishRunRow[] }
  >;

  // ── Recipe install config (D-179 — the recipe's default-dish overlay)
  /** Read a recipe's INSTALL config — the overlay on its `is_default`
   *  dish, applied as a base under per-run config for dishless runs. `{}`
   *  when unset. */
  'recipe_config.get': RpcMethodSpec<
    { recipe_id: string },
    { config_overlay: Record<string, unknown> }
  >;
  /** Set a recipe's install config (mutable — the default dish is a config
   *  SOURCE, never dispatched-as, so editing in place is audit-safe).
   *  Find-or-creates the `is_default` dish; an empty `{}` clears it. */
  'recipe_config.set': RpcMethodSpec<
    {
      recipe_id: string;
      publisher_id?: string;
      config_overlay: Record<string, unknown>;
    },
    { config_overlay: Record<string, unknown> }
  >;

  // ── Dish groups (D-179 P3 — workflow containers) ─────────────────
  /** List dish groups with their member dish ids (derived join —
   *  membership lives on the dish row). */
  'dish_groups.list': RpcMethodSpec<
    Record<string, never>,
    { groups: { group: DishGroup; member_dish_ids: string[] }[] }
  >;
  'dish_groups.create': RpcMethodSpec<
    {
      name: string;
      config_overlay?: Record<string, unknown>;
      [k: string]: unknown;
    },
    { group: DishGroup }
  >;
  'dish_groups.update': RpcMethodSpec<
    { group_id: string; name?: unknown; config_overlay?: unknown },
    { group: DishGroup }
  >;
  /** Delete a group. Member dishes are DETACHED (group_id cleared),
   *  never deleted — the group is a container, not an owner. */
  'dish_groups.delete': RpcMethodSpec<
    { group_id: string },
    { deleted: true; detached_dish_ids: string[] }
  >;

  // ── Auto-run (reactive-substrate slice 1) ───────────────────────
  /** Merged per-recipe auto-run status: the definitional
   *  `recipe.auto_run` roster joined with the user-intent settings
   *  store, the persisted circuit-breaker state, and the live
   *  scheduler roster. Closes the D-115-era gap where the only way to
   *  stop an auto-run recipe was uninstalling its pack — auto-run now
   *  presents the same `enabled` arm/disarm model as event-triggers
   *  and schedules. */
  'auto_run.list': RpcMethodSpec<void, { entries: AutoRunStatusEntry[] }>;
  /** Flip the per-recipe auto-run user toggle and/or set its config.
   *  `enabled: true` also clears any tripped circuit (re-arming a recipe
   *  the breaker shut off is the same user gesture as un-pausing it) and
   *  refreshes the scheduler roster so the change takes effect without
   *  restart. `config_overlay`, when provided, is the desired config for
   *  the headless fires: the server keeps it on a managed IMMUTABLE dish
   *  (one `dish_id` = one config), minting a new dish + dissolving the
   *  superseded one whenever it differs — so the audit never shows a
   *  `dish_id` with drifting results; an empty `{}` clears config (fires
   *  on recipe defaults). Both fields optional — omit `enabled` for a
   *  config-only edit. Unknown recipe id or a recipe without `auto_run`
   *  → `not_found`. */
  'auto_run.update': RpcMethodSpec<
    {
      recipe_id: string;
      enabled?: boolean;
      config_overlay?: Record<string, unknown>;
    },
    { entry: AutoRunStatusEntry }
  >;

  // ── Watches (poll-manager / G6 — reactive-substrate slice 2) ─────
  /** Merged watch-key status: poll demand derived from enabled
   *  `data.connection.api.<vendor>.<entity>.…` trigger rows joined
   *  with the user pause toggle, the persisted poll/baseline state,
   *  the reconciler-deference check, and the live loop roster. The
   *  governance read for "which connection-entity pairs does the
   *  server poll on my behalf, how often, for which recipes".
   *
   *  WatchSource generalization (slice 3) — `sources` carries the PUSH
   *  half: every registered push source (webhook receiver, messenger
   *  inbound, reception arrivals) as a `WatchSourceStatusEntry` row, so
   *  the one governance list answers "what feeds my change bus" across
   *  both archetypes. Empty when no push-source providers registered. */
  'watch.list': RpcMethodSpec<
    void,
    { watches: WatchStatusEntry[]; sources: WatchSourceStatusEntry[] }
  >;
  /** Pause / resume one watch key. `enabled: true` also clears the
   *  consecutive-failure counter (re-arming an error-capped watch is
   *  the same user gesture as un-pausing it) and recomputes the loop
   *  roster so the change takes effect without restart. Unknown
   *  watch key → `not_found`. */
  'watch.update': RpcMethodSpec<
    { watch_key: string; enabled: boolean },
    { entry: WatchStatusEntry }
  >;
  /** Run one watch key's poll immediately (the Run-Now affordance —
   *  same gesture class as housekeeping's per-topic Run Now). Awaits
   *  the poll, then returns the refreshed entry so the caller renders
   *  the new `last_poll_at` / `last_status` without a re-list. Unknown
   *  watch key → `not_found`; a key with no armed loop (paused /
   *  deferred to a reconciler / connection gone) → `conflict` naming
   *  why. A poll already in flight is NOT an error — the call AWAITS
   *  it (that poll IS the requested run) and returns the entry it
   *  produced. */
  'watch.run_now': RpcMethodSpec<
    { watch_key: string },
    { entry: WatchStatusEntry }
  >;

  // ── Server LLM config (instance-scoped, independent of extension) ──
  /** Read the paired server's LLM config. Requires unlocked server. */
  'server.getLLMConfig': RpcMethodSpec<void, { config: ServerLLMConfig }>;
  /** Replace the paired server's LLM config atomically. Kept for bulk /
   *  import; per-edit surfaces use the field-level rpcs below so two
   *  surfaces editing different slots don't clobber (last-write-wins). */
  'server.setLLMConfig': RpcMethodSpec<{ config: ServerLLMConfig }, { ok: true }>;
  /** D-174 R28 — field-level write: replace ONE BYOK slot (or clear it
   *  with `null`), leaving the other slot + the free pool untouched. */
  'server.setLLMSlot': RpcMethodSpec<
    { slot_key: 'slot_1' | 'slot_2'; slot: ServerLLMSlot | null },
    { ok: true }
  >;
  /** D-174 R28 Slice C — field-level write: replace the dedicated
   *  embeddings slot (or clear it with `null`), leaving slot_1 / slot_2 +
   *  the free pool untouched. The embeddings slot is a recipe/housekeeping
   *  source only — never a chat model-select option, so it has no slot_key
   *  arg (there is exactly one). */
  'server.setEmbeddingsSlot': RpcMethodSpec<
    { slot: ServerLLMSlot | null },
    { ok: true }
  >;
  /** D-174 R28 — field-level write: add or replace ONE free-pool entry
   *  (matched by `id`), via server-side read-modify-write over the pool
   *  blob so concurrent single-entry edits don't clobber. */
  'server.upsertFreePoolEntry': RpcMethodSpec<
    { entry: ServerLLMPoolEntry },
    { ok: true }
  >;
  /** D-174 R28 — field-level write: remove ONE free-pool entry by `id`.
   *  `removed` is false when no entry matched. */
  'server.removeFreePoolEntry': RpcMethodSpec<
    { id: string },
    { ok: true; removed: boolean }
  >;
  /** D-174 R28 — field-level write: enable/disable ONE free-pool entry
   *  by `id` WITHOUT resending its (redacted) api_key. `found` is false
   *  when no entry matched. */
  'server.setFreePoolEntryEnabled': RpcMethodSpec<
    { id: string; enabled: boolean },
    { ok: true; found: boolean }
  >;
  /** Lever-2 per-slot — field-level write: set ONE LLM source's chat catalog
   *  delivery mode (`full` | `index` | `lean-core`), or `null` to clear just
   *  that source's override (falling back to the smart default / env-global /
   *  `full`). Server-side read-modify-write over the persisted `catalog_modes`
   *  map so it never clobbers the other sources — the field-level counterpart to
   *  the whole-blob `setLLMConfig` (which also carries `catalog_modes` for
   *  import). The chat orchestrator reads the map LIVE, so a write routes the
   *  next turn without a restart. */
  'server.setChatCatalogMode': RpcMethodSpec<
    { source_id: ChatModelSourceId; mode: ChatCatalogDeliveryMode | null },
    { ok: true }
  >;

  // ── Owner-authored system prompts ──────────────────────────────
  /** Read every surface's prompt state — the effective prompt + role AND the
   *  built-in default, so the editor can pre-fill with real text and offer a
   *  reset. */
  'server.getLlmPrompts': RpcMethodSpec<void, { prompts: ServerLlmPrompt[] }>;
  /** Write one surface's ROLE + INSTRUCTIONS (block 1), its wire role, and —
   *  on the gateway — the caller-system-message policy.
   *
   *  `null` on any field CLEARS it: that is the reset-to-default, and it
   *  restores the built-in byte-for-byte (the stored row simply stops existing;
   *  absence IS how the default is expressed). Read live by the chat
   *  orchestrator + the gateway handler, so a save takes effect on the next
   *  turn without a restart.
   *
   *  ⚠ `role_instructions` is block 1 ONLY. Recued's core + feature text are
   *  composed around it and are not writable through this rpc, or any rpc. */
  'server.setLlmPrompt': RpcMethodSpec<
    {
      surface: ServerLlmPromptSurface;
      role_instructions: string | null;
      role: ServerLlmMessageRole | null;
      /** llm_gateway only; ignored on `chat`. */
      caller_system_policy?: ServerLlmCallerSystemPolicy | null;
    },
    { ok: true }
  >;

  // ── Schema-driven server config (scalar settings) ──────────────
  /** Fetch the paired server's scalar config as a flat schema list.
   *  Lets a generic schema-driven renderer handle the long tail of
   *  simple settings (budgets, flags, enums) without per-field UI code
   *  on the extension side. Rich surfaces (LLM pool editor, schedules)
   *  keep their bespoke components. */
  'server.getConfigSchema': RpcMethodSpec<void, { schema: ServerConfigField[] }>;
  /** Apply a single field update. The server looks up the key in the
   *  schema registry and dispatches to the right underlying store. */
  'server.setConfigField': RpcMethodSpec<
    { key: string; value: ServerConfigValue },
    { ok: true }
  >;

  /** D-196 S2 + D-200 Slice 6 — Settings -> Seller cockpit read model.
   *  Owner-only via the paired `server.*` channel; returns access-row metadata,
   *  readiness, aggregate counts, and core-owned outcome offers. Provider
   *  secrets and LLM slot credentials stay on their owning settings surfaces. */
  'server.seller.getOverview': RpcMethodSpec<void, SellerOverview>;
  /** D-207 order-is-the-lifecycle — owner-only list over `core.seller.order`
   *  rows, most-recent-first. The Settings → Seller Orders view groups the flat
   *  result by `sellerOrderBucket(phase)`; `truncated` flags the server clamp so
   *  the owner is never shown a silently capped list. Read-only: order lifecycle
   *  writes stay on the specialized order ops, never this rpc. */
  'server.seller.listOrders': RpcMethodSpec<
    SellerListOrdersRequest,
    SellerListOrdersResponse
  >;
  /** D-200 Slice 6e — owner-only, optimistic offer-state transition. Recipe
   *  operations remain ensure/get/list and cannot activate, pause, or archive. */
  'server.seller.transitionOfferState': RpcMethodSpec<
    SellerOfferStateTransitionRequest,
    SellerOfferStateTransitionResponse
  >;
  /** D-196 S2 — owner-authored seller settings update. Stores grace, sender,
   *  status-policy, and email-policy knobs, returning the refreshed overview. */
  'server.seller.updateSettings': RpcMethodSpec<
    SellerSettingsUpdateRequest,
    SellerSettingsUpdateResponse
  >;
  /** D-196 §4.9 / I-7 — the owner-only, one-time route-rights acknowledgment
   *  recorded at the monetization boundary. A PAID (seller-customer)
   *  `llm_gateway` chat turn fails closed until this is on record; free/standing
   *  turns and `/v1/models` discovery are never gated. The server stamps the
   *  timestamp + current terms version and returns the refreshed overview. */
  'server.seller.acknowledgeLlmGatewayPaid': RpcMethodSpec<
    SellerAcknowledgeLlmGatewayPaidRequest,
    SellerAcknowledgeLlmGatewayPaidResponse
  >;
  /** D-196 S2 — owner-authored manual tier creation/update. This intentionally
   *  does not accept a lifecycle source; the server stamps `manual` so provider
   *  sync jobs cannot be spoofed through the local UI RPC. */
  'server.seller.upsertManualTier': RpcMethodSpec<
    SellerManualTierUpsertRequest,
    SellerManualTierUpsertResponse
  >;
  /** D-196 1d Phase 2 — owner one-click pass-tier seed. Mints a zero-grant
   *  `customer_template` shell for the door and binds a fresh `manual` tier to
   *  it in one call (the three-axis pass: time / llm-limit / tool-limit), so the
   *  owner never hand-authors a template and pastes its id. Stamps `manual`
   *  server-side and refuses a lifecycle source / template id, same anti-spoof
   *  posture as `upsertManualTier`. The owner authors the template's grants in
   *  #contracts afterward (I-1). */
  'server.seller.createPassTier': RpcMethodSpec<
    SellerCreatePassTierRequest,
    SellerCreatePassTierResponse
  >;
  /** D-196 S2 — owner-authored manual customer issue/extend. The request is
   *  deliberately manual-only; provider subscription ids and lifecycle sources
   *  are not accepted through this local UI RPC. */
  'server.seller.issueManualCustomer': RpcMethodSpec<
    SellerManualCustomerIssueRequest,
    SellerManualCustomerIssueResponse
  >;
  /** D-196 S2 — owner-authored manual customer renewal/update without issuing
   *  another token. The server stamps `manual` and accepts either customer_id
   *  or source-qualified coordinates as the target. */
  'server.seller.extendManualCustomer': RpcMethodSpec<
    SellerManualCustomerExtendRequest,
    SellerManualCustomerExtendResponse
  >;
  /** D-196 S2 — owner-authored manual customer tier swap. Reuses the existing
   *  customer contract/token identity while restamping contract permissions
   *  from the selected manual tier template. */
  'server.seller.swapManualCustomerTier': RpcMethodSpec<
    SellerManualCustomerSwapTierRequest,
    SellerManualCustomerSwapTierResponse
  >;
  /** D-196 S2 — owner-authored manual customer closure. Revokes the customer
   *  contract and inbound token through the lifecycle substrate. */
  'server.seller.closeManualCustomer': RpcMethodSpec<
    SellerManualCustomerCloseRequest,
    SellerManualCustomerCloseResponse
  >;
  /** D-196 S2 — owner-authored manual customer token reissue. Preserves the
   *  customer contract/tier row and replaces the bound inbound token with a
   *  fresh bearer for claim redelivery or suspected leaks. */
  'server.seller.reissueManualCustomerToken': RpcMethodSpec<
    SellerManualCustomerReissueTokenRequest,
    SellerManualCustomerReissueTokenResponse
  >;
  /** D-196 S2 — owner-authored manual tier bulk-adjust. Restamps selected or
   *  all open manual customer contracts on the tier from the current tier
   *  template; closed customers are reported but not reopened. */
  'server.seller.bulkAdjustManualTierCustomers': RpcMethodSpec<
    SellerManualTierBulkAdjustRequest,
    SellerManualTierBulkAdjustResponse
  >;
  /** D-196 S4 — owner-clicked Stripe feature bootstrap. Reads the complete
   *  provider feature set through the gated Stripe catalog operation, creates
   *  missing zero-grant template/tier shells, and orphan-flags missing tiers. */
  'server.seller.synchronizeStripeEntitlements': RpcMethodSpec<
    SellerStripeSynchronizeRequest,
    SellerStripeSynchronizeResponse
  >;

  /** D-169 P1 — rich server status snapshot, sourced by the bridge's
   *  side panel section #1 (N.5) on mount + periodic refresh. The
   *  webclient server dashboard adopts the same rpc when it ships
   *  (O-7). Per-pair only; namespace `system.` is in
   *  `MCP_RESERVED_RPC_PREFIXES` — MCP-channel agents don't need to
   *  read host status. */
  'system.status': RpcMethodSpec<void, { status: ServerSystemStatus }>;

  /** D-169 P2 — recent recipe executions for the bridge side panel
   *  section #2 (N.5 #2), fetched on mount + reconnect. A thin read over
   *  the D-120 audit log (`AuditLogStore.listRecent`), projected to
   *  `ServerRecentExecution`. `limit` is server-clamped. Local-UI /
   *  local-bridge only — omitted from `MCP_TOOL_CATALOG`, the same
   *  posture as `system.status` (host-activity reads don't cross to
   *  MCP-channel agents).
   *
   *  D-161 P3 — `origin_actors` selects the actor lane(s). Omitted →
   *  the feed foregrounds the gold-path lane (`user_self`+`system`,
   *  `TIMELINE_DEFAULT_ORIGIN_ACTORS`); pass `['contracted_user']` /
   *  `['anonymous']` to reach the agents / reception lanes. Outside-actor
   *  rows are filtered from the default view, never dropped (I-7). */
  'execution.recent': RpcMethodSpec<
    { limit?: number; origin_actors?: ReadonlyArray<Actor> },
    { executions: ServerRecentExecution[] }
  >;
  /** D-174 Runs/Audit feed for the webclient `#runs` route. Filterable
   *  and cursor-paginated over the audit log; projects rows without
   *  `config_snapshot` or raw source token ids. Local-UI / paired-client
   *  only, omitted from the MCP tool catalog. */
  'execution.list': RpcMethodSpec<
    ExecutionListQuery,
    ExecutionListResponse
  >;
  /** D-174 Runs/Audit detail for one `run_id`. Joins the audit row,
   *  provenance links, redacted checkpoint approvals, run errors, and
   *  the Tier-1 gateway honest-degrade marker. Local-UI / paired-client
   *  only, omitted from the MCP tool catalog. */
  'execution.get': RpcMethodSpec<
    ExecutionGetRequest,
    ExecutionGetResponse
  >;
  /** D-181 slice 4 — the live active-list snapshot (running runs + queued
   *  heavy calls + detached jobs + per-lane occupancy). Distinct from the
   *  D-174 `execution.list` audit feed: this reads the in-flight registry,
   *  not the audit log. Owner-only, session-scoped, reserved out of MCP
   *  (machine consumers don't drive execution control — D-181 §8/§13). */
  'execution.active': RpcMethodSpec<
    ExecutionActiveRequest,
    ExecutionActiveResponse
  >;
  /** D-181 slice 4 — kill a *running* heavy op (SIGKILL a `service`
   *  subprocess / abandon an external-io await). The run terminates in the
   *  `killed` state. Owner-only; re-checks the bridge-approval gate
   *  server-side when the caller is a bridge (fail-closed). Reserved out of
   *  MCP. */
  'execution.kill': RpcMethodSpec<
    ExecutionKillRequest,
    ExecutionKillResponse
  >;
  /** D-181 slice 4 — cancel a *queued* heavy call before it dispatches
   *  (`cancelled_before_dispatch` — the single queue record, §7d). Owner-
   *  only; bridge-approval gated. Reserved out of MCP. */
  'execution.cancel': RpcMethodSpec<
    ExecutionCancelRequest,
    ExecutionCancelResponse
  >;
  /** D-181 slice 4 — promote a queued heavy call to its lane's head (ahead
   *  of a long-running blocker). Touches only the in-memory queue; no run
   *  trail. Owner-only; bridge-approval gated. Reserved out of MCP. */
  'execution.promote': RpcMethodSpec<
    ExecutionPromoteRequest,
    ExecutionPromoteResponse
  >;
  /** D-172 resumable uploads — webclient control plane (the chunk BYTES travel
   *  the dedicated binary `/ws/upload` socket, never rpc). `upload.create`
   *  opens a scratch session bound to (filename, declared_size) + returns the
   *  256-bit `upload_id` capability; the core's disk caps gate it. `scope_key`
   *  is resolved server-side from `ctx.token_instance_id` — never client-set.
   *  Owner-only; reserved out of MCP (`upload.` in MCP_RESERVED_RPC_PREFIXES). */
  'upload.create': RpcMethodSpec<UploadCreateRpcRequest, UploadCreateRpcResponse>;
  /** D-172 — resume probe: returns the persisted offset IFF (filename,
   *  declared_size[, fingerprint]) still match the session, else a fresh-create
   *  signal (`not_found` / `expired` / `file_mismatch`). */
  'upload.probe': RpcMethodSpec<UploadProbeRpcRequest, UploadProbeRpcResponse>;
  /** D-172 — finalize once `offset === declared_size`: streams the scratch into
   *  the CAS + ingests `data.file.received` (`origin: 'webclient_upload'`),
   *  returning the durable `record_id`. Idempotent on the content hash. */
  'upload.finalize': RpcMethodSpec<UploadFinalizeRpcRequest, UploadFinalizeRpcResponse>;
  /** D-172 — explicit cancel (best-effort reap of row + scratch); a crashed
   *  client falls back to the TTL sweeper. */
  'upload.delete': RpcMethodSpec<UploadDeleteRpcRequest, UploadDeleteRpcResponse>;
  /** D-169 P2 — recent fired notifications for the bridge side panel
   *  section #3 (N.5 #3). A thin read over the `notification_fired`
   *  activity rows (`AuditLogStore.listActivities`), projected to
   *  `ServerRecentNotification`. `limit` is server-clamped. Local-UI only
   *  by `MCP_TOOL_CATALOG` omission. */
  'notification.recent': RpcMethodSpec<
    { limit?: number },
    { notifications: ServerRecentNotification[] }
  >;
  /** D-169 P2 — currently-open asks for the bridge side panel section #4
   *  (N.5 #4). A thin read over the D-158 ask store
   *  (`AskStore.listByStatus('open')`), projected to `ServerPendingAsk`.
   *  Local-UI only by `MCP_TOOL_CATALOG` omission. */
  'notification.pending_asks': RpcMethodSpec<
    void,
    { asks: ServerPendingAsk[] }
  >;
  /** D-169 P2 Slice 3 — submit an answer to an open D-158 `ask` from a
   *  client's interactive approval card (the bridge side panel; the
   *  webclient in a Slice-3b follow-on). Funnels into the notification
   *  block's `submitAnswer` — first-answer-wins dedup across every surface
   *  (D-158 I-6). The answer is recorded `via: 'ui'` (the interactive
   *  inbound path; the first-class `bridge` channel is `notify-only`, with
   *  no inbound-reply path). The block's `submitAnswer` is a silent no-op
   *  on an unknown / already-answered ask or an option the ask never
   *  offered, so the rpc always resolves `{ ok: true }` (acknowledges
   *  receipt; the card converges via the `notification.ask_closed` bus
   *  frame + the next history re-fetch). Local-UI / local-bridge only —
   *  omitted from `MCP_TOOL_CATALOG`, the same posture as the sibling
   *  historical-view reads. */
  'notification.submitAnswer': RpcMethodSpec<
    {
      ask_id: string;
      option_id: string;
      /** D-234 § 234.4e — the written reason, when the ask invited one
       *  (`PendingAsk.note_prompt`). DROPPED by the block for an ask that did
       *  not, and REQUIRED — the reply no-ops without it — when the prompt says
       *  `'required'`. Capped at `ASK_NOTE_MAX` on entry. */
      note?: string;
    },
    { ok: true }
  >;

  // ── Paired-device fleet (for the "new device or replace" UX) ──
  /** List every device (ext instance) ever paired with this server for
   *  the caller's account. Rows include revoked history so the picker
   *  can show "retired" devices separately. `connected` is the live
   *  status from the in-RAM ws roster — durable + live joined here so
   *  the caller doesn't have to correlate two RPCs. */
  'pair.list': RpcMethodSpec<void, { devices: ServerPairedDevice[] }>;
  /** Revoke a device from the account. Closes any active ws with the
   *  `instance_revoked` code so the device can self-cleanup, and
   *  marks the durable row revoked so re-pair requires user action. */
  'pair.revoke': RpcMethodSpec<{ instance_id: string }, { ok: true }>;
  /** Enroll-or-verify the realm's recovery-key check. First call
   *  on a fresh server stores a check derived from `recoveryKey`;
   *  every subsequent call must supply the same key (server verifies
   *  by trying to decrypt the stored check + match the sentinel).
   *
   *  Outcomes:
   *    - `enrolled` — first time; the realm is now bound to this key.
   *    - `verified` — prior check existed, supplied key matched.
   *  Failures throw `RpcError` with code:
   *    - `invalid` — supplied string isn't a valid 24-word mnemonic
   *      (BIP39 checksum failed).
   *    - `mismatch` — prior check exists, supplied key didn't match.
   *
   *  The recovery key crosses the wire transiently; the server
   *  derives + stores a sealed check, never the key itself. */
  'pair.registerRecoveryKey': RpcMethodSpec<
    { recoveryKey: string },
    { outcome: 'enrolled' | 'verified' }
  >;

  // ── Bridge capability profile ───────────────────────────────────
  /** D-169 P0 — bridge re-pushes its `BridgeCapabilityProfile` to the
   *  server (closes TR-17). Slice 4's multi-bridge dispatcher pre-filters
   *  on each connected bridge's most-recent `granted_origins`; without a
   *  push on permission change, a bridge that just gained a Chrome host
   *  permission would stay ineligible until the user re-paired. The
   *  bridge invokes this on every (re)connect AND on every
   *  `chrome.permissions.onAdded` / `onRemoved` event, rebuilding the
   *  profile from `chrome.permissions.getAll()` so the canonical state
   *  carries (not deltas — Chrome can fire add+remove in close sequence
   *  during a grant replacement). Reserved for the bridge identity by
   *  construction: the server reads the caller's `client_token_id` from
   *  the authenticated WS context and stamps that as the registry key —
   *  the payload doesn't carry a target id, so a compromised MCP-channel
   *  agent (kept out by `bridge.` reserved-prefix gate) couldn't spoof
   *  another bridge's profile even if the rpc were exposed. */
  'bridge.capabilityProfile.push': RpcMethodSpec<
    { profile: BridgeCapabilityProfile },
    { ok: true }
  >;

  // ── Recipe execution ────────────────────────────────────────────
  /** D-116 — Kitchen "Test trigger" pair-rpc. Runs a single trigger-
   *  phase step against live server-side state (warehouse routes
   *  mail / file / calendar) and returns the resolved
   *  `TriggerTestResult`. Dry-run only — the server writes to its
   *  `triggered_test` table, never the main audit log. Extension-only
   *  watchers (http / dom / recipe / time / webhook) evaluate locally
   *  and never route through this method. */
  'runtime.testTrigger': RpcMethodSpec<TriggerTestRequest, TriggerTestResponse>;

  /** D-116 — User-initiated rearm of an auto-disabled reactive recipe.
   *  Zeros the circuit-breaker counter on the scheduler and mints a
   *  fresh `process_id` so the next tick fires cleanly. Extension UI
   *  buttons forward here when the disabled recipe runs on the paired
   *  server; extension-local recipes call the in-process scheduler
   *  directly without pair-rpc. */
  'runtime.resetCircuit': RpcMethodSpec<{ recipe_id: string }, { ok: true; process_id: string }>;

  /** D-115 Phase 6D — pair-rpc forwarder for the extension's watcher
   *  dispatcher. The extension keeps `time-watcher`, `recipe-watcher`,
   *  and `http-watcher` local (pure), and
   *  forwards `mail-watcher` / `file-watcher` / `calendar-watcher` /
   *  `webhook-watcher` here so the server can answer them off the
   *  warehouse + webhook queue. The server runs the request through
   *  its existing `createWatcherDispatcher`; absent deps surface as
   *  `SERVER_NOT_REACHABLE`. `slug` typing is loose to avoid a
   *  contracts → ingredients import; the server's switch enforces
   *  the closed set. */
  'runtime.runWatcher': RpcMethodSpec<
    { slug: string; args: Record<string, unknown> },
    Record<string, unknown> & { should_run: boolean }
  >;

  /** D-119 Phase 5 — list installed recipes on the server. Backs the
   *  server-scope sidebar (`recipe.list`). Bundled + pair-sync recipes
   *  are returned together; the `source` field lets the UI distinguish
   *  if needed. Inline recipes are excluded — they aren't durably
   *  installed. */
  'recipe.list': RpcMethodSpec<
    void,
    { recipes: ServerRecipeListEntry[] }
  >;

  /** R2 build step 4c.1 — derived recipe runnability (recipe-identity doc
   *  §1.6). Recomputed-on-read (never persisted): for every known recipe,
   *  whether its declared capability dependencies are satisfied by the
   *  CURRENTLY bound providers — `runnable` / `degraded` (optional
   *  unprovided) / `blocked` (hard unprovided), with per-dependency detail
   *  (which providers cover it, which ops no provider grants). Backs the
   *  webclient recipes view's "born blocked — add a provider" disclosure +
   *  the bus-driven re-render (4c.4). The DISCLOSURE layer over the gate, not
   *  enforcement — the D-157 gate already fails closed on an ungranted op.
   *  Per-pair / local-UI only; `recipe.runnability` is NOT in
   *  `MCP_TOOL_CATALOG` (the same posture as `recipe.list`) — runnability
   *  discloses which capabilities have no bound provider, i.e. connection
   *  topology, which stays off the MCP-channel agent surface. Absent deps
   *  (dbless / no connection store) → `not_configured`. */
  'recipe.runnability': RpcMethodSpec<
    void,
    { recipes: RecipeRunnabilityEntry[] }
  >;

  /** § 7 surfacing slice — per-recipe PII posture (the Kitchen-side read).
   *  Recomputed-on-read over every known recipe with the server's canonical
   *  classifier: what the dispatch seam auto-protects at run time, what
   *  still needs the author's hand, plus standing validator findings.
   *  Entries with nothing to disclose are omitted — absence means clean.
   *  DISCLOSURE only — the § 7 dispatch seam does the actual rewriting at
   *  run time regardless of who reads this. Per-pair / local-UI only; NOT
   *  in `MCP_TOOL_CATALOG` (same posture as `recipe.runnability` — PII
   *  flow topology stays off the MCP-channel agent surface; agents get the
   *  posture for recipes THEY save via the `recued_saveRecipe` result). */
  'recipe.pii': RpcMethodSpec<
    void,
    { recipes: RecipePiiDisclosureEntry[] }
  >;

  /** Recipe-editor authoring seam — validate + persist an inline-authored
   *  recipe. Mirrors the MCP `recued_saveRecipe` tool: validates via
   *  `parseRecipe`, ACCEPTS op-step recipes (D-182 — the dispatch path lowers +
   *  runs them; only a definitively-unrunnable op-step is rejected, and an
   *  uncovered Tier-P `depends_on` surfaces as a non-blocking `op_warnings`),
   *  and persists via the recipe store with `source: 'inline'`. Owner-only /
   *  local-UI — NOT in `MCP_TOOL_CATALOG`
   *  (authoring writes stay off the MCP-channel agent surface; the `recipe.`
   *  reserved-prefix gate ratchet-enforces it). The `pii` field discloses the
   *  saved recipe's run-time PII posture (the SAME shape `recued_saveRecipe`
   *  returns — each disclosure line flattened to its rendered message),
   *  omitted when there is nothing to disclose. */
  'recipe.save': RpcMethodSpec<
    {
      recipe: RecipeDefinition;
      publisher_id?: string;
      /** Kitchen-only owner choices. Required exactly when the standalone
       * recipe declares webhook requirements; never read from recipe JSON. */
      webhook_bindings?: ReadonlyArray<WebhookIngressBindingSelection>;
    },
    {
      saved: true;
      recipe_id: string;
      version: number;
      name: string;
      /** D-182 — non-blocking op-step advisories (a Tier-P op the recipe names
       *  but does not declare in `depends_on`). Present only when there is
       *  something to surface; the recipe still saved. Mirrors the
       *  `recued_saveRecipe` tool result. */
      op_warnings?: string[];
      /** Run-time PII posture — same projection `recued_saveRecipe` returns.
       *  Present only when the recipe has something to disclose. */
      pii?: {
        headline?: string;
        auto_protected?: string[];
        warnings?: string[];
        infos?: string[];
      };
      /** Present for a webhook-declaring recipe. A successful save always
       * replaces its authority in the disarmed state. */
      webhook?: LocalRecipeWebhookStatus;
    }
  >;

  /** Recipe-editor authoring seam — validate an inline-authored recipe
   *  without persisting it. Runs the SAME `parseRecipe` walk as
   *  `recipe.save`; returns `ok` (no error-severity issues) plus every
   *  issue mapped to `{ path?, message, severity }`. Never throws — the
   *  editor renders the issue list inline as the author types. Owner-only /
   *  local-UI; off the MCP surface via the `recipe.` reserved prefix. */
  'recipe.validate': RpcMethodSpec<
    { recipe: RecipeDefinition },
    { ok: boolean; issues: Array<{ path?: string; message: string; severity: string }> }
  >;

  /** Secret-free state for a standalone Kitchen recipe's selected webhook
   * ingresses. These methods remain off MCP through the reserved `recipe.`
   * namespace; an authoring agent cannot arm autonomous execution. */
  'recipe.webhook.status': RpcMethodSpec<
    { recipe_id: string },
    { webhook: LocalRecipeWebhookStatus }
  >;

  'recipe.webhook.arm': RpcMethodSpec<
    { recipe_id: string },
    { webhook: LocalRecipeWebhookStatus }
  >;

  'recipe.webhook.disarm': RpcMethodSpec<
    { recipe_id: string },
    { webhook: LocalRecipeWebhookStatus }
  >;

  /** Install seam 5c — install a standalone marketplace recipe BY SLUG (the
   *  terminal action behind `#recipes/install/<id>` after bundle routing). The server fetches the recipe
   *  from the apex install artifact `<domain>/recipes/<slug>.json` (the
   *  CDN-cached, KV-mirrored static file — not the raw DB worker), validates it,
   *  and persists it through `RecipeStore.save(..., 'pair-sync')` with the
   *  marketplace-authoritative `publisher_id` (NOT a client-supplied one — vault
   *  scope is keyed by publisher_id). Matches `recipe.save`'s validate-then-save
   *  shape (the same `parseRecipe` + op-step checks, the same roster-mutation
   *  hook fires) but is sourced from a marketplace fetch rather than inline
   *  authoring; like `recipe.save` it emits no broadcast and provisions no pack
   *  grants (a standalone recipe carries no pack `requires[]`).
   *
   *  Returns the outcome on the result body: a marketplace 404 / validation
   *  failure / fetch error surfaces as `ok: false` so the install dialog renders
   *  targeted copy. A recipe with `metadata.recipe_bundle` returns
   *  `bundle_pack_required` plus the declared pack slug: clients must open the
   *  existing pack detail/consent flow rather than bypassing its atomic install.
   *  Only arg-shape problems reach the rpc error channel as `bad_request`.
   *  Owner-only / local-UI — off the MCP surface via the `recipe.` reserved
   *  prefix. */
  'recipe.installBySlug': RpcMethodSpec<
    { slug: string },
    {
      result:
        | {
            ok: true;
            recipe_id: string;
            version: number;
            name: string;
            publisher_id: string;
            /** Run-time PII posture — same projection `recipe.save` returns.
             *  Present only when the recipe has something to disclose. */
            pii?: {
              headline?: string;
              auto_protected?: string[];
              warnings?: string[];
              infos?: string[];
            };
          }
        | {
            ok: false;
            failure: {
              code:
                | 'not_found'
                | 'validator_rejected'
                | 'fetch_error'
                | 'bundle_pack_required';
              message: string;
              /** Present for `bundle_pack_required`; derived from the already
               *  validated `<publisher>/<pack_slug>` recipe_bundle key. */
              pack_slug?: string;
            };
          };
    }
  >;

  /** D-119 Phase 10 — list every pending approval the server knows
   *  about. Includes server-originated (cron / reactive / mcp) +
   *  pair-proxied approvals. Empty list when nothing's pending. */
  'approval.list': RpcMethodSpec<
    void,
    { approvals: ServerPendingApproval[] }
  >;

  /** D-119 Phase 10 — first-write-wins resolve. The first call to
   *  resolve a given `approval_id` is accepted; subsequent calls
   *  return `accepted: false` with the winner's identity so the
   *  losing client can re-fetch + reconcile. Resolved approvals are
   *  removed from the next `approval.list` snapshot. */
  'approval.resolve': RpcMethodSpec<
    {
      approval_id: string;
      decision: 'approve' | 'reject' | 'cancel';
      /** Optional human note attached to the resolution. */
      note?: string;
    },
    ServerApprovalResolveResult
  >;

  /** D-119 Phase 10 — open the approval-changed push subscription.
   *  The server emits `ServerApprovalSubscriptionEvent` over the pair-
   *  WS push channel whenever the pending list changes. Subscribing
   *  is idempotent — calling twice is a no-op. The subscription
   *  closes when the WS disconnects. Returns the current snapshot so
   *  the caller doesn't need a second `approval.list` round-trip. */
  'approval.subscribe': RpcMethodSpec<
    void,
    {
      /** Initial pending snapshot at subscription time. */
      approvals: ServerPendingApproval[];
      /** Current `seq` counter — clients use this to detect gaps in
       *  later push events. */
      seq: number;
    }
  >;

  /** D-121 Phase 6 — open / refresh the realtime broadcast bus
   *  subscription. Server registers the requested kinds + replays
   *  any events with `cursor > cursor_since` from its ring buffer
   *  (push channel: `{ type: 'server_event', event }`). Closes
   *  automatically when the WS disconnects. Re-issuing this rpc
   *  replaces the previous filter — no separate unsubscribe. */
  'events.subscribe': RpcMethodSpec<SubscribeRequest, SubscribeAck>;

  /** D-148 § A.4.4 — seamless bearer rotation. Issues a fresh bearer +
   *  `token_id` for a targeted client_tokens row + invalidates the
   *  old row, then emits a `token.rotated` broadcast carrying the new
   *  plaintext bearer to every paired subscriber. The targeted client
   *  filters on `target_token_id === stored.token_id` (sibling
   *  clients ignore on mismatch); the matched client wraps + persists
   *  the new bearer locally + reconnects with it.
   *
   *  The bearer plaintext is delivered ONLY via the broadcast — never
   *  in the rpc response. The caller (Settings → Server → Clients →
   *  Rotate) reads `replaced_token_id` + `new_token_id` + `issued_at`
   *  for audit / display; the seamless re-auth path runs on the
   *  targeted client through the broadcast handler.
   *
   *  Failure modes (thrown as `RpcError`):
   *    - `not_found` (404) — no client_tokens row with `token_id`.
   *    - `conflict` (409) — row exists but `revoked_at` is set; can't
   *      rotate an already-revoked token. Caller should issue fresh
   *      via the pair flow.
   *
   *  Reserved for local-UI only — `token.` is in
   *  `MCP_RESERVED_RPC_PREFIXES`. External AI agents must never
   *  drive credential rotation; channel-isolation invariant. */
  'token.rotate': RpcMethodSpec<
    { token_id: string },
    { replaced_token_id: string; new_token_id: string; issued_at: number }
  >;

  /** D-148 § A.6.5 — operator-initiated TLS cert renewal. Delegates to
   *  the per-server `RotationEngine.renewTls(...)` which invokes the
   *  ACME helper (Pro tier) or local certbot/caddy hook (free tier),
   *  signs the resulting `cert_rotation_notice` with the current
   *  `server_identity_key`, and broadcasts the notice on the realtime
   *  bus so pinned clients pick up the next fingerprint over the
   *  overlap window. Default activation lead = 7d per spec § A.6.5;
   *  callers (test harnesses, "renew now" affordance) can shorten via
   *  `rotation_at_offset_ms`.
   *
   *  Surfaces the full `RotationResult` verbatim — the discriminated
   *  union carries `new_fingerprint` + `rotated_at` on success, or a
   *  closed-list `RotationErrorCode` (`key_not_loaded` /
   *  `rotation_in_progress` / `acme_helper_unavailable` /
   *  `subscription_required` / `storage_io_error`) on failure. UI
   *  consumers render the code with the matching remediation hint.
   *
   *  Reserved for local-UI only — `tls.` is in
   *  `MCP_RESERVED_RPC_PREFIXES`. External AI agents must never drive
   *  TLS cert rotation; channel-isolation invariant. */
  'tls.renew': RpcMethodSpec<
    { reason?: string; rotation_at_offset_ms?: number },
    RotationResult
  >;

  /** D-148 § A.6.5 + § A.9 — webclient passport-fetch verify path.
   *
   *  Mints a fresh `support_redacted` passport projection signed with
   *  the current `server_identity_key` and returns it inline. The
   *  webclient calls this rpc on every successful WS reconnect, threads
   *  the result through `verifyPassportCertAttestation`, and uses the
   *  outcome to seed / promote / no-op / re-pair its pinned
   *  `WebclientCertPinState`. Closes the gap between the rotation-notice
   *  handler (which stages a `next_fingerprint` but cannot observe a
   *  TLS cert directly through the browser's `WebSocket` API) and real
   *  promotion of the staged-next to current.
   *
   *  Distinct from a future `passport.export` rpc: this surface is the
   *  internal post-WS-connect health check + NEVER emits the
   *  `passport.exported` high-assurance audit row. The audit row's
   *  semantics is "user-initiated INTENT to export"; a passport-fetch
   *  is a routine cert-pin reconciliation, fires on every reconnect,
   *  and writing an audit row each time would flood the ledger. The
   *  passport projection itself is identical to the support_redacted
   *  shape user-export would mint, signed with the same key over the
   *  same canonical transcript — verifiers can't tell them apart.
   *
   *  Reserved for local-UI only — `passport.` is in
   *  `MCP_RESERVED_RPC_PREFIXES`. External AI agents must never fetch
   *  the passport: the projection carries identity-block fingerprints +
   *  LAN/handle/cert claims that compose part of the server's identity
   *  surface; an MCP-channel mint would let a compromised agent
   *  enumerate the verify substrate. Channel-isolation invariant. */
  'passport.fetch': RpcMethodSpec<
    void,
    { passport: ServerPassportProjection }
  >;

  /** LAN-URL kickstart — the server's locally-reachable URLs (loopback + LAN
   *  interface addresses + the live listen port) for the Settings → Hostnames
   *  "reachable on your network" hint. Reserved out of MCP (`network.`
   *  prefix): like the passport / hostname surfaces, a local-UI read an MCP
   *  agent has no need to make (enumerating the server's bind addresses). */
  'network.local_urls': RpcMethodSpec<
    void,
    NetworkLocalUrlsResponse
  >;

  /** R26.4 Delta 2 (D-148 § A.9 P8) — user-initiated passport export.
   *  UNLIKE `passport.fetch` (internal cert-pin verify, support_redacted
   *  only, NO audit), this is the operator's deliberate export: it takes
   *  a `profile` (`support_redacted` / `enterprise_audit` /
   *  `migration_full`), signs the per-profile projection with
   *  `server_identity_key`, emits the `passport.exported` high-assurance
   *  audit row (records INTENT), and appends a row to the passport
   *  history cache. The webclient renders the signed JSON for the user
   *  to download / share. Reserved for local-UI only — `passport.` is in
   *  `MCP_RESERVED_RPC_PREFIXES` (a compromised MCP agent must never mint
   *  an identity-disclosing passport). `reason` is capped at
   *  `PASSPORT_REASON_MAX_BYTES`; an over-long reason / unknown profile
   *  fails `bad_request`. */
  'passport.export': RpcMethodSpec<
    ServerPassportExportOptions,
    { passport: ServerPassportProjection }
  >;
  /** R26.4 Delta 2 (D-148 § A.9 P8) — list prior passport exports,
   *  newest first, for the Settings → Backup & Recovery history view.
   *  Reads the denormalized history cache (fed by `passport.export`).
   *  Local-UI only (same `passport.` reservation). */
  'passport.history.list': RpcMethodSpec<
    ServerPassportHistoryListArgs,
    { rows: ServerPassportHistoryEntry[] }
  >;
  /** R26.4 Delta 5 (D-148 § A.9 import half) — commit the import of a
   *  `migration_full` passport on a NEW server (model A re-anchor, owner-
   *  ratified 2026-06-25). The server RE-VERIFIES the signature against the
   *  embedded public key (never trusts the client preview), refuses anything
   *  but `migration_full` / a self-import, and records the high-assurance
   *  `passport.imported` provenance row binding old identity → live identity.
   *  Returns the old → new linkage + whether the provisioner-owned handle
   *  re-anchor is still pending. Does NOT mutate the handle store / claim the
   *  handle cloud-side (the pro-convenience provisioner owns that). Reserved
   *  for local-UI only — `passport.` is in `MCP_RESERVED_RPC_PREFIXES` (a
   *  compromised MCP agent must never rewrite the server's identity-
   *  provenance ledger). */
  'passport.import': RpcMethodSpec<
    { passport: ServerPassportProjection },
    ServerPassportImportCommitResult
  >;

  /** R26.4 Delta 3 (D-148 § A.11 / § P7) — Key Health read. Returns the
   *  FULL `KeyHealthBundle` (incl. live `compromise_alert` from the
   *  compromise ledger) + a per-class `availability` map computed from
   *  which rotation hooks are wired on this realm. The Settings → Server
   *  → Key Health page reads this on mount + after every rotation to
   *  render per-class status + enable the reachable actions. Distinct
   *  from `passport.fetch` (support_redacted, status-only, no compromise
   *  flag). Reserved for local-UI only — `key.` is in
   *  `MCP_RESERVED_RPC_PREFIXES`. */
  'key.health': RpcMethodSpec<void, KeyHealthView>;

  /** R26.4 Delta 3 (D-148 § A.11 / § P7) — operator-initiated key
   *  rotation. Dispatches the requested op to the per-server
   *  `RotationEngine` (`server_identity_rotate` / `master_dek_rotate` /
   *  `publisher_identity_rotate` / `webhook_secret_rotate` /
   *  `mark_compromised`). `tls_renew` + `webclient_token_rotate` are
   *  EXCLUDED — they keep their dedicated `tls.renew` / `token.rotate`
   *  surfaces; routing them here would double the path.
   *
   *  Surfaces the full `RotationResult` verbatim — the union carries the
   *  per-op success detail (`new_fingerprint` / `repair_client_ids` /
   *  `reencrypted_blob_count` / `dependents` / `cascade_pending`) or a
   *  closed-list `RotationErrorCode`. On self-host the unwired ops return
   *  `key_not_loaded`; the `key.health` availability map tells the UI to
   *  grey those up front rather than surface the error on click.
   *
   *  `server_identity_rotate` revokes EVERY paired client (including the
   *  caller) — the webclient's `onReauthRequired` funnel wipes local
   *  state + remounts the pair form. Reserved for local-UI only — `key.`
   *  is in `MCP_RESERVED_RPC_PREFIXES`; a compromised AI agent must never
   *  rotate identity / mark a key compromised. Channel-isolation
   *  invariant. */
  'key.rotate': RpcMethodSpec<KeyRotateRequest, RotationResult>;

  /** D-148 § A.5.3 / § A.6.5 — Pro authentication rpc surface.
   *
   *  `pro.authenticate` persists the `pro_subscription_token` bearer
   *  in the per-pair pro-auth store + binds the ACME factory's
   *  `ProAuthResolver`. The token is minted externally (Stripe per
   *  § A.13 future; no cloud-side mint endpoint on the six-family
   *  list); the user pastes it into Settings → Pro.
   *
   *  `pro.signOut` clears the slot + reverts the resolver to `null`.
   *  Next renewal cycle fails as `pro_auth_unavailable` →
   *  `subscription_required` until the user re-authenticates.
   *
   *  `pro.current` reads the current slot for Settings → Pro to
   *  render. NEVER returns the bearer — only a `token_suffix` (last
   *  4 chars) + `authenticated_at`. Display only; verification at
   *  the cloud helper is the bearer round-trip.
   *
   *  Reserved for local-UI only — `pro.` is in
   *  `MCP_RESERVED_RPC_PREFIXES`. External AI agents must never
   *  mutate or read the subscription bearer; channel-isolation
   *  invariant. */
  'pro.authenticate': RpcMethodSpec<
    ProAuthenticateRequest,
    ProAuthenticateResponse
  >;
  'pro.signOut': RpcMethodSpec<ProSignOutRequest, ProSignOutResponse>;
  'pro.current': RpcMethodSpec<ProCurrentRequest, ProCurrentResponse>;

  /** Handled via the `execute` top-level method, not a namespace. */
  'execute': RpcMethodSpec<
    {
      recipe_id?: string;
      recipe?: unknown;
      config?: Record<string, unknown>;
      /** D-222 host-derived output-filter provenance. */
      invocation?: RecipeInvocation;
      context?: Record<string, unknown>;
      vault?: Record<string, unknown>;
      trigger_source?: string;
      /** D-179 P1 — standing dish to run as (overlay + attribution). */
      dish_id?: string;
      [k: string]: unknown;
    },
    ServerExecuteResponse
  >;

  // ── Shared namespaces (D-103 Phase A) ───────────────────────────
  //
  // Ext-side kernel ingredient dispatches durable shared-store operations through the
  // seven `shared.*` methods below. `shared.*` keys route to the cache
  // tier, `data.shared.*` keys route to durable SQLite + content-addressed blobs.
  // Server routes internally by key prefix.
  'shared.write': RpcMethodSpec<
    { key: string; value: unknown; ttl?: number },
    { ok: true; key: string; bytes_written: number }
  >;
  'shared.compare-and-set': RpcMethodSpec<
    { key: string; expected_revision: number | null; value: unknown },
    SharedCompareAndSetResult
  >;
  'shared.read': RpcMethodSpec<
    { key: string },
    SharedReadResult
  >;
  'shared.list': RpcMethodSpec<
    { prefix: string },
    { entries: SharedListEntry[] }
  >;
  'shared.search': RpcMethodSpec<
    { scope: string; query: string },
    { matches: SharedSearchMatch[] }
  >;
  'shared.delete': RpcMethodSpec<
    { key: string },
    { ok: true; key: string }
  >;
  'shared.delete-prefix': RpcMethodSpec<
    { prefix: string },
    { ok: true; prefix: string; deleted: number }
  >;

  // ── Annotation + Link warehouse (D-119 Phase 13) ────────────────
  //
  // Two first-class collections recipes write back to source records
  // via the `data-annotate` / `data-link` kernel ingredients. Per-
  // record refs (`{{data.<col>.<id>.annotations.<key>}}` /
  // `links.<role>`) are populated by the engine's prefetch resolver
  // calling `annotation.forRecord` and `link.forRecord` on every
  // referenced record. Bulk ops back the Warehouse explorer.

  /** Write one annotation. The store stamps `_id`, `_collection`, and
   *  `authored_at` itself; callers supply user-meaningful fields plus
   *  the staleness stamps the engine pre-computes. Returns the stamped
   *  row so callers can chain on `_id`. */
  'annotation.write': RpcMethodSpec<
    {
      target_collection: string;
      target_id: string;
      key: string;
      value: unknown;
      authored_by_recipe_id: string;
      source_record_hash: string;
      recipe_hash: string;
      model_used?: string;
    },
    { annotation: Annotation }
  >;

  /** Bulk read with filter. All filter fields AND together; absent
   *  fields don't restrict. Used by `annotation-list`. */
  'annotation.list': RpcMethodSpec<
    AnnotationFilter,
    { annotations: Annotation[] }
  >;

  /** FTS5 search across annotation values. CAS-stored values (>64 KB)
   *  are not indexed — same documented limit as the shared store. */
  'annotation.search': RpcMethodSpec<
    AnnotationSearchQuery,
    { matches: AnnotationSearchMatch[] }
  >;

  /** Bulk delete by filter. Refuses an empty filter — guards against
   *  accidental table-wipe. */
  'annotation.delete': RpcMethodSpec<
    AnnotationFilter,
    { ok: true; deleted: number }
  >;

  /** Per-record convenience read for the engine's prefetch resolver.
   *  Returns the latest row per `(target_collection, target_id, key)`
   *  triple — populates `{{data.<col>.<id>.annotations.<key>}}`. */
  'annotation.forRecord': RpcMethodSpec<
    { collection: string; id: string },
    { annotations: Annotation[] }
  >;

  /** Write one link. Returns the stamped row. */
  'link.write': RpcMethodSpec<
    {
      from_collection: string;
      from_id: string;
      to_collection: string;
      to_id: string;
      role: string;
      authored_by_recipe_id: string;
    },
    { link: Link }
  >;

  /** Bulk read with filter. */
  'link.list': RpcMethodSpec<
    LinkFilter,
    { links: Link[] }
  >;

  /** Bulk delete by filter. Refuses an empty filter. */
  'link.delete': RpcMethodSpec<
    LinkFilter,
    { ok: true; deleted: number }
  >;

  /** Per-record convenience read for the engine's prefetch resolver.
   *  `direction: 'outbound'` returns links where the record is the
   *  `from` side; `'inbound'` returns links where the record is the
   *  `to` side. Populates `{{data.<col>.<id>.links.<role>}}` (outbound)
   *  and `{{data.<col>.<id>.inbound_links.<role>}}` (inbound). */
  'link.forRecord': RpcMethodSpec<
    { collection: string; id: string; direction: 'outbound' | 'inbound' },
    { links: Link[] }
  >;

  // ── Contact warehouse (D-121 Phase 1) ───────────────────────────
  //
  // `data.contact` is a derived collection — the mail / calendar
  // adapters auto-materialize rows from header / attendee data, so
  // recipes never need to write into it. The rpc surface here covers
  // the manual-entry path (UI) plus convenience reads for warehouse
  // explorer + chat scopes.

  /** Manual upsert. Accepts a user-supplied display name that
   *  overrides any adapter-derived name on subsequent reads. Source
   *  defaults to `'manual'` only when the row is freshly inserted —
   *  a manual edit on a previously-derived row preserves the original
   *  provenance discriminator.
   *
   *  D-145 PA8 follow-on widening: `phone` / `mailing_address` /
   *  `company` forward to the store's merge-substrate fields (already
   *  honored by `ContactStore.upsertManual`). `network_domain` writes
   *  the closed-list multi-value annotation (§ A.4.2) when supplied;
   *  callers omit to leave the existing assignment untouched. */
  'contact.upsert': RpcMethodSpec<
    {
      email: string;
      name?: string;
      last_interaction?: number;
      first_seen?: number;
      /** E.164-canonicalized (caller pre-canonicalizes). Drives D-138
       *  merge predicate. */
      phone?: string;
      /** Structured address; D-138 merge predicate consumes the
       *  `(zip, country)` derived blocking key. */
      mailing_address?: MailingAddress;
      /** Workplace name. Tags `company_source = 'manual'`. */
      company?: string;
      /** Current job title from manual entry/import. */
      title?: string;
      /** Birthday calendar date, including ISO yearless `--MM-DD`. */
      birthday?: string;
      /** Closed-list multi-value annotation. Empty array clears. */
      network_domain?: NetworkDomain[];
    },
    { contact: ContactRecord }
  >;

  /** List with optional filters. `name_contains` is case-insensitive
   *  substring; `source` filters by provenance discriminator; `since`
   *  bounds `last_interaction`; `phone_exact` matches the canonical
   *  phone column exactly. Ordered by `last_interaction DESC`. */
  'contact.list': RpcMethodSpec<
    {
      name_contains?: string;
      source?: ContactSource;
      since?: number;
      /** D-145 PA8 follow-on — exact match on the `phone` column. */
      phone_exact?: string;
      limit?: number;
      offset?: number;
      /** D-226 — ask each installed pack what it has to say about the contacts
       *  on THIS PAGE, in one batched read. Off by default: a list that does
       *  not render the columns must not pay for them. */
      with_rollups?: boolean;
    },
    {
      contacts: ContactRecord[];
      total: number;
      /** D-226 — per-contact, keyed on canonical email, present only when
       *  `with_rollups` was asked for. ⚠ A contact with an entry whose every
       *  rollup is zero is DIFFERENT from a contact with no entry: the first
       *  means the packs answered "nothing", the second that nobody asked. */
      rollups?: Record<string, TimelineRollup[]>;
    }
  >;

  /** D-145 PA8 follow-on — identifier → contact resolver. Accepts
   *  exactly one of `email` / `phone` / `alias` / `platform_id` and
   *  returns the canonical contact_id (when one match resolves), a
   *  confidence in [0, 1], and alternatives when the chat_alias branch
   *  could not collapse to a single candidate. Unblocks the
   *  counterparty-resolution path deferred from PA10 (extract-commitments
   *  -from-mail's `counterparty_email` → `counterparty_contact_id`). */
  'contact.resolve': RpcMethodSpec<
    {
      email?: string;
      phone?: string;
      alias?: string;
      platform_id?: { platform: ContactAliasPlatform; id: string };
    },
    {
      contact_id: string | null;
      confidence: number;
      alternatives: string[];
      /** Hydrated record for the unambiguous match (when contact_id is
       *  non-null). Lets the caller avoid a follow-up `contact.get`
       *  round-trip in the common case. */
      contact?: ContactRecord;
    }
  >;

  /** Fetch one contact or null. */
  'contact.get': RpcMethodSpec<
    { email: string },
    { contact: ContactRecord | null }
  >;

  /** D-205 merge-review item 3 — the PER-SOURCE value view.
   *
   *  Every contribution behind this contact's projected fields, each stamped with
   *  whether it WON its kind. `contact.get` returns only the winner (plus, since
   *  #2a, `projection_provenance` naming who it came from) — so the C-2a ladder was
   *  visible in its OUTCOME but never in its INPUT. Nobody could render *"Company —
   *  Acme Inc., from HubSpot (kept) · Acme Corp, from Google Contacts"*, which is the
   *  view that makes the ladder legible instead of magic.
   *
   *  Rows come from `listProjectionContributions` — the merge GROUP × BOTH
   *  contribution stores, i.e. exactly what the projection resolved over. NOT
   *  `listContactAttributes` (one contact, one store): that would silently drop the
   *  absorbed contact's rows on any merged survivor — and an absorbed row can be the
   *  one that WON — plus every phone row, since a phone is an alias, not an attribute.
   *
   *  ⛔ **The client must never re-rank these.** `winner` is stamped server-side by
   *  `resolveContribution`, the one conflict policy. A client-side ladder is exactly
   *  the bug merge-review item 1 fixed.
   *
   *  Empty array for an unknown contact — a contact with no contributions and a
   *  contact that does not exist are the same answer to "what is behind this record",
   *  and the caller already knows which it is from `contact.get`.
   *
   *  Owner surface, like the rest of the base `contact.*` family: registered-client
   *  gated on the bearer-authed WS channel, and DELIBERATELY NOT in
   *  `MCP_RESERVED_RPC_PREFIXES` — the rpc registry does not bridge to MCP at all
   *  (agents reach the graph through the Tier-1 tool surface, which carries its own
   *  `data.contact` collection-read fence). */
  'contact.contributions': RpcMethodSpec<
    { email: string },
    { contributions: ContactContributionView[] }
  >;

  /** Delete one contact. Cascades through annotation/link rows are
   *  the caller's concern — the spec doesn't auto-cascade because a
   *  user might want to keep the conversation history while pruning
   *  the contact card. */
  'contact.delete': RpcMethodSpec<
    { email: string },
    { ok: true; deleted: boolean }
  >;

  /** D-205 #2c — per-Source health for the contact Sources: the D-145
   *  `SourceRegistration` row joined to its `contact_source_sync_state`
   *  row. Read-only; the Sources strip on `#data/contact` is the sole
   *  consumer.
   *
   *  This is the FIRST reader of `last_cycle`. The runner has persisted
   *  twelve per-cycle counters since D-205 #1, and the only thing that
   *  ever read a contact Source's health was
   *  `source_freshness_degradation` — which selects exactly
   *  `(last_success_at, degraded)` and nothing else. So a leaf that
   *  failed every record on every cycle collapsed to one boolean with
   *  no way to see why. The counts (and `last_error_message`, which
   *  carries the runner's failure SAMPLES) are the diagnosis.
   *
   *  DELIBERATELY NOT in `MCP_RESERVED_RPC_PREFIXES` — matching the base
   *  `contact.*` + sibling `work_entity.source.list` treatment. The MCP
   *  catalog is a closed `recued_*` allowlist, so a `contact.source.*`
   *  name can never bridge onto it; reserving a read the base family
   *  does not reserve would be inconsistent noise. */
  'contact.source.list': RpcMethodSpec<
    void,
    { sources: ReadonlyArray<ContactSourceHealth> }
  >;

  // ── D-205 #5 — selective CRM promotion ──────────────────────────
  //
  // The answer to the cold-start cliff. A CRM is `hydrate_on_match`, so on an
  // empty contact graph it mints ZERO contacts: connect HubSpot with ten
  // thousand records and `#data/contact` stays empty, by design (a CRM is your
  // COMPANY's list — mostly strangers). Correct, and it reads as broken.
  //
  // The strangers are already on disk — the reconcilers mirror every CRM contact
  // into `crm_record_mirror` regardless — and the sync already COUNTS them
  // (`last_cycle.skipped`). So this is not an import; it is a picker over data
  // Recued already holds. The user reaches in and says "this one is mine."
  //
  // ⛔ Both are USER-AUTHORITATIVE and MCP-RESERVED. Promoting a stranger into
  // the personal contact graph is a judgement about who you know — the same class
  // of decision as a merge, and not one an agent may make on your behalf.
  'contact.import.candidates': RpcMethodSpec<
    {
      /** `CONNECTION_SOURCE_ID(vendor, connection_name, 'contact')`. */
      source_id: string;
      /** Case-insensitive substring over name / email / company. */
      query?: string;
      /** Page offset into the (deterministically ordered) stranger list. */
      offset?: number;
      limit?: number;
    },
    {
      candidates: ReadonlyArray<ContactImportCandidate>;
      /** Strangers matching the query — the page is a window onto this. */
      total: number;
      /** Every mirrored record for this Source, stranger or not. The pair
       *  `(total, mirrored)` is what makes the cliff legible: "10,000 records,
       *  9,988 of whom you have never corresponded with". */
      mirrored: number;
    }
  >;
  'contact.import.promote': RpcMethodSpec<
    {
      source_id: string;
      /** The mirror rows to pull in — `CrmRecordMirrorRow.target_id`. */
      target_ids: ReadonlyArray<string>;
    },
    {
      /** Contacts MINTED. */
      created: number;
      /** Records that turned out to already be someone Recued knows — a benign
       *  race (the sync matched them between the list and the promote), not an
       *  error. */
      already_known: number;
      /** Per-record refusals, verbatim. A record with no email cannot be promoted:
       *  the CRM mirror carries no phone-keyed identity to fall back on. */
      failures: ReadonlyArray<string>;
    }
  >;

  // ── D-205 #5c — the manual vCard / CSV import ───────────────────
  //
  // An upload is a BATCH `contact.upsert` — the owner speaking, in bulk. It is NOT
  // a Source (no connection, no sync, no delete diff), so everything it writes
  // lands at the `manual` rung with the singleton `CONTACT_SOURCE_ID_MANUAL`.
  // Contributions upsert on `(contact_id, kind, source_id)`, which is exactly what
  // makes export → edit in a spreadsheet → re-upload work as MODIFY.
  //
  // 🔑 Two rpcs, and no server state between them: `apply` re-parses the SAME bytes
  // and re-derives the SAME plan. **The client sends the FILE; the SERVER decides
  // what it means.**
  'contact.import.file_preview': RpcMethodSpec<
    { text: string },
    ContactImportFilePlan
  >;
  'contact.import.file_apply': RpcMethodSpec<
    {
      text: string;
      /** FALSE lands the ADDs only. That is the whole point of the review: a stale
       *  export's new people are welcome, and its three thousand stale VALUES —
       *  which would land at the top of the ladder and freeze the graph — are not. */
      apply_changes: boolean;
    },
    {
      added: number;
      changed: number;
      /** Existing contacts left untouched (the user declined the changes), plus any
       *  entry whose phone matched more than one contact — never guessed. */
      skipped: number;
      failures: ReadonlyArray<string>;
    }
  >;

  // ── Contact merge substrate (D-138 P1) ──────────────────────────
  //
  // Six rpcs covering the cross-platform reconciliation flow. All
  // local-UI / user-action only — explicitly excluded from the MCP
  // tool catalog and from any recipe-invokable allow-list. Channel
  // isolation is structural: merge decisions are user-authoritative,
  // not automatable by recipes or external AI agents. The MCP catalog
  // ratchet (`@recued/contracts/__tests__/mcp-catalog-ratchet`)
  // asserts the namespace stays excluded; regressions trip CI.

  /** List candidates from the server-internal merge-queue. Defaults
   *  to `status: 'pending'` ordered by `detected_at` descending. */
  'contact.merge.list': RpcMethodSpec<
    { status?: 'pending' | 'merged' | 'rejected'; limit?: number; cursor?: string } | void,
    { candidates: ContactMergeCandidate[]; next_cursor?: string }
  >;

  /** Confirm a merge: survivor absorbs loser(s)' platform_ids; loser
   *  rows get `merged_into` set; annotations + links rewrite to the
   *  survivor at merge transaction time; D-136 `cascadeForIdentity-
   *  Change` fires. For multi-way clusters, pass every candidate id
   *  whose pair is part of the merge — the substrate dedupes the
   *  losers from the candidate-graph edges. */
  'contact.merge.confirm': RpcMethodSpec<
    { candidate_ids: string[]; survivor_email: string },
    { survivor: ContactRecord; losers: ContactRecord[] }
  >;

  /** Mark as different (permanent) — writes one rejection row per
   *  surfaced candidate edge. Multi-way: writes ONLY the rejection
   *  edges that were actually surfaced as candidate rows in the
   *  cluster, NOT the transitive O(N²) closure. */
  'contact.merge.reject': RpcMethodSpec<
    { candidate_ids: string[]; rejected_by?: string },
    { candidates: ContactMergeCandidate[]; rejection_rows_written: number }
  >;

  /** Split a previously-merged contact: redistribute platform_ids;
   *  reverse cascade; adds the split pair to `rejected_pairs`
   *  (durable rejection — same as `reject` but reversed in
   *  intent). */
  'contact.merge.split': RpcMethodSpec<
    {
      merged_email: string;
      platform_id_redistribution: Array<{
        platform_id_entry: PlatformIdEntry;
        target_canonical_email: string;
      }>;
      rejected_by?: string;
    },
    { canonicals: ContactRecord[] }
  >;

  /** Power-user — explicitly remove a rejection edge. Reachable only
   *  from Settings → Contacts → Rejected pairs UI; not auto-callable
   *  from any other surface. */
  'contact.merge.undo_rejection': RpcMethodSpec<
    { email_a: string; email_b: string },
    { contact_a: ContactRecord | null; contact_b: ContactRecord | null }
  >;

  /** A.10 upstream-re-merge resolution. User picks Re-merge (substrate
   *  removes the rejection + queues a fresh merge candidate against
   *  the survivor) or Treat-as-deletion (rejection stays; canonical
   *  row keeps its remaining platform_ids). */
  'contact.merge.resolve_remerge_prompt': RpcMethodSpec<
    { prompt_id: string; resolution: 'remerge' | 'treat_as_deletion' },
    { result: 'queued_merge_candidate' | 'deletion_acknowledged' }
  >;

  /** D-138 P3 — Settings → Contacts → "Scan now". Triggers an
   *  immediate run of the `contact-merge-candidate-scan` housekeeping
   *  task. `mode: 'full'` resets the cursor to 0 first so the scan
   *  walks every non-tombstone contact (covers the install-over-
   *  existing-graph case); `mode: 'delta'` runs from the existing
   *  cursor (equivalent to Settings → Server → Housekeeping → Run
   *  Now for the same task id). The rpc returns once the scan
   *  yields/completes; per-iteration progress streams over the bus
   *  via `kind: 'merge_scan_progress'` so the focus-page renderer
   *  hydrates without per-iteration round-trips. */
  'contact.merge.scan_now': RpcMethodSpec<
    { mode?: 'delta' | 'full' } | void,
    {
      mode: 'delta' | 'full';
      iterated: number;
      surfaced_count: number;
      yield_reason?: 'budget_exhausted' | 'no_work';
    }
  >;

  // ── D-138 P5 — upstream-merge outbox (destructive vendor merge) ─
  //
  // Five rpcs cover the A.7 modal preview + outbox state-machine
  // surface. Local-UI only — `upstream_merge.*` is in
  // `MCP_RESERVED_RPC_PREFIXES` so MCP agents can never trigger a
  // destructive vendor mutation.
  //
  //   - `upstream_merge.describe` — render the modal preview
  //   - `upstream_merge.request`  — second-click confirm fires this;
  //                                 server creates outbox row + drives
  //                                 the state machine
  //   - `upstream_merge.retry`    — user-driven retry on a failed row;
  //                                 creates a fresh outbox row
  //   - `upstream_merge.discard`  — dismiss a failed row from the banner
  //   - `upstream_merge.list`     — surface failed rows for the banner
  'upstream_merge.describe': RpcMethodSpec<
    UpstreamMergeDescribeRequest,
    UpstreamMergeDescribeResponse
  >;

  'upstream_merge.request': RpcMethodSpec<
    UpstreamMergeRequestInput,
    UpstreamMergeRequestResponse
  >;

  'upstream_merge.retry': RpcMethodSpec<
    UpstreamMergeRetryInput,
    UpstreamMergeRetryResponse
  >;

  'upstream_merge.discard': RpcMethodSpec<
    UpstreamMergeDiscardInput,
    UpstreamMergeDiscardResponse
  >;

  'upstream_merge.list': RpcMethodSpec<
    UpstreamMergeListInput | void,
    UpstreamMergeListResponse
  >;

  // ── Connection substrate (D-125 Phase 2.1) ──────────────────────
  //
  // Core rpcs that own the `connection.*` lifecycle: list / enroll /
  // metadata update / verified credential rotation / delete / probe. Server is
  // authoritative — the durable
  // SQLite row lives in `backend/server/src/storage/connection-store
  // .ts`; the ext mirrors via the pair sync wire. Pair sync rides on
  // `contract.connection_record.*` (sync_transport: 'pair' per D-166;
  // D-168 retired the legacy SYNC_OBJECTS cloud route).
  //
  // Read paths return `ConnectionView` — auth-excluded by
  // construction (the projection in `connectionViewFromRow` strips
  // it). Write paths take `ConnectionAuth` plaintext over the secure
  // pair channel; the handler hands it off to storage as opaque
  // ciphertext-shaped bytes. P2.2 wires the actual HKDF sub-DEK
  // (`hkdf("connection-namespace-v1")`) for at-rest + pair-wire
  // confidentiality (D-168 retired cloud sync); until then storage
  // holds an opaque encoding (JSON.stringify + base64) that's still
  // excluded from views.

  /** Enumerate enrolled connections. Optional `kind` filter narrows
   *  to one of the three subspaces (mcp / api / notification). Newest
   *  `updated_at` first — drives the Settings → Connections list. */
  'collection.connection.list': RpcMethodSpec<
    { kind?: ConnectionKind } | void,
    {
      connections: ConnectionView[];
      /** Omitted when empty or unsupported. Entries are ordered by causal
       * insertion, newest first, and remain bounded to current enrolled rows. */
      credential_rotation_safe_stops?: ConnectionCredentialRotationSafeStopSummary[];
      /** Present on current servers, including as an empty array. Unresolved
       * post-ack checks survive reloads/tabs; successful checks are omitted so
       * their all-clear receipt is never replayed. */
      credential_post_safe_stop_verifications?:
        ConnectionCredentialPostSafeStopVerificationSummary[];
    }
  >;

  /** Owner-triggered, read-only setup assistance for an API connection form.
   *  The request deliberately carries NO credentials or free-form connection
   *  values: only a cleaned public HTTPS URL, the selected auth discriminant,
   *  and the closed-list keys of fields currently visible in the form. The
   *  server supplies labels and descriptions from its own catalog before
   *  invoking the owner's AI.
   *
   *  The response is advisory. Nothing is enrolled, no field is applied, and
   *  no provider page is fetched or submitted by this method. */
  'collection.connection.suggestSetup': RpcMethodSpec<
    {
      target_url: string;
      auth_type: ConnectionAuth['type'];
      field_keys: string[];
    },
    {
      shared_context: {
        target_url: string;
        auth_type: ConnectionAuth['type'];
        field_keys: string[];
      };
      guide: {
        provider_name: string;
        overview: string;
        field_suggestions: Array<{
          field_key: string;
          suggested_value?: string;
          guidance: string;
          confidence: 'high' | 'medium' | 'low';
        }>;
        steps: Array<{
          title: string;
          instruction: string;
          field_keys: string[];
        }>;
        cautions: string[];
      };
    }
  >;

  /** Create or replace a connection. ON CONFLICT (kind, name) the row
   *  is replaced in place — `enroll` is idempotent at the rpc layer.
   *  `probe?` carries the honest pre-probe baseline (`unknown`) written
   *  with the row. A host promising "Save and probe" follows a successful
   *  enroll with `collection.connection.probe`; that separation keeps a
   *  failed reachability/auth check from rolling back enrollment. */
  'collection.connection.enroll': RpcMethodSpec<
    {
      name: string;
      kind: ConnectionKind;
      subtype?: string;
      display_name: string;
      publisher_id?: string;
      config: Record<string, unknown>;
      auth: ConnectionAuth;
      /** D-165 P3.path-picker — optional sub-resource scope (default
       *  `/` = whole account). Canonicalized server-side. Omitting it
       *  on a re-enroll preserves the existing scope rather than
       *  widening to `/` (fail-safe). Set at enrollment only; the
       *  update rpc deliberately can't change it (re-scope = new
       *  connection, spec § Sub-resource gating). */
      subresource_path?: string;
      /** granted-scopes — the vendor-granted OAuth scopes from the just-
       *  completed dance (the dialog claims them off `completeVendorOAuth`).
       *  Persisted non-secret so pack-readiness can check coverage. Omitted
       *  on a non-oauth enroll or a token-refresh re-enroll → the existing
       *  set is preserved (never wiped to "unknown"). */
      granted_scopes?: string[];
    },
    {
      connection: ConnectionView;
      probe?: ConnectionHealth;
    }
  >;

  /** Patch non-credential metadata on an existing connection. Identity
   *  (`kind`, `name`) is immutable; credentials use the dedicated verified
   *  rotation rpc below. The handler bumps `updated_at` so sync delta scans
   *  pick up the change. */
  'collection.connection.update': RpcMethodSpec<
    {
      name: string;
      kind: ConnectionKind;
      /** Optional optimistic-concurrency revision from the latest list read. */
      expected_updated_at?: number;
      patch: {
        display_name?: string;
        config?: Record<string, unknown>;
      };
    },
    { connection: ConnectionView }
  >;

  /** Verify a complete replacement credential against the provider before
   *  atomically swapping it into an existing connection. A failed check never
   *  mutates the saved row.
   *  This is a distinct method (rather than an update flag) so an older server
   *  rejects the request before writing anything. */
  'collection.connection.rotateCredentials': RpcMethodSpec<
    {
      /** Browser-minted idempotency key. The server durably claims it before
       * provider I/O so a lost reply can be reconciled without replaying the
       * credential. */
      attempt_id: string;
      name: string;
      kind: ConnectionKind;
      /** Optional optimistic-concurrency revision from the editor's list row. */
      expected_updated_at?: number;
      patch: {
        display_name?: string;
        config?: Record<string, unknown>;
        auth: ConnectionAuth;
      };
      /** Fresh vendor-reported scopes from an OAuth re-authorization. Omitted
       *  for static credentials and manual rotations that do not rescope. */
      granted_scopes?: string[];
      /** Optional trigger edit captured by the same form. Included here so
       *  credentials and triggers cannot report contradictory save outcomes. */
      match_patterns?: MessageMatchPattern[];
    },
    {
      connection: ConnectionView;
      verification: ConnectionCredentialVerification;
    }
  >;

  /** Reconcile a rotation whose reply was lost to a reload or reconnect.
   * Returns only closed lifecycle metadata; neither the candidate nor the
   * previously saved credential is recoverable through this read. */
  'collection.connection.credentialRotationStatus': RpcMethodSpec<
    { attempt_id: string; name: string; kind: ConnectionKind },
    { outcome: ConnectionCredentialRotationOutcome }
  >;

  /** Determine whether this exact connection still has server-owned provider
   * verification in flight and project a still-current bounded safe stop. No
   * attempt id, credential, endpoint value, or provider prose is returned;
   * this read gates sibling takeover and server-authoritative admin handoff. */
  'collection.connection.credentialRotationActivity': RpcMethodSpec<
    { name: string; kind: ConnectionKind },
    { activity: ConnectionCredentialRotationActivity }
  >;

  /** Record an explicit provider/administrator-fix acknowledgement for the
   * exact still-current safe stop. The opaque token supplies the compare-and-
   * set boundary: a newer attempt or rejection yields `superseded` and is
   * never cleared by this stale action. */
  'collection.connection.acknowledgeCredentialRotationSafeStop': RpcMethodSpec<
    {
      name: string;
      kind: ConnectionKind;
      acknowledgement_token: string;
    },
    { acknowledgement: ConnectionCredentialRotationSafeStopAcknowledgement }
  >;

  /** D-192 M4c-UI — read a connection's declared messenger `match_patterns`
   *  (the message→commitment trigger list). A dedicated read because the field
   *  is stripped from `ConnectionView` (`CONNECTION_VIEW_RESERVED_FIELDS` —
   *  server-side funnel config, never recipe-referenceable), so the Settings
   *  pattern editor cannot pre-populate from the list view. Returns `[]` for a
   *  connection with no patterns. Settings-only. */
  'collection.connection.getMatchPatterns': RpcMethodSpec<
    { name: string; kind: ConnectionKind },
    { match_patterns: MessageMatchPattern[] }
  >;

  /** D-192 M4c-UI — set a connection's messenger `match_patterns`. MERGES into
   *  the stored `config_json` (preserving `channel_id` / inbound secrets / all
   *  other config), unlike the wholesale-replace `update`. Re-validates with the
   *  same rule the enroll/update guard uses; an empty array clears the triggers.
   *  Echoes the saved list. Settings-only. */
  'collection.connection.setMatchPatterns': RpcMethodSpec<
    { name: string; kind: ConnectionKind; match_patterns: MessageMatchPattern[] },
    { match_patterns: MessageMatchPattern[] }
  >;

  /** Drop a connection by composite key. `deleted: false` when no
   *  matching row existed — the rpc itself stays 200 OK so callers
   *  can debounce against optimistic deletions.
   *
   *  D-192 source-data-removal — `remove_mirror_data: true` (the opt-in
   *  "also remove the [N] records" checkbox, default off) additionally
   *  hard-deletes the connection's mirrored warehouse records + their
   *  live-derived data (annotations/links/enrichments/edges) via the
   *  per-Source purge; `purged` returns the per-facet counts. Audit /
   *  memory provenance is preserved regardless (spec § 3 "Never" tier). */
  'collection.connection.delete': RpcMethodSpec<
    { name: string; kind: ConnectionKind; remove_mirror_data?: boolean },
    { deleted: boolean; purged?: ConnectionDataPurgeSummary }
  >;

  /** D-192 source-data-removal slice 3c — the "[N] records" preview for the
   *  removal-confirm dialog's "also remove the mirrored data" checkbox. The
   *  read-only COUNT twin of the `delete` purge: sums the primary mirror /
   *  work-entity records the connection owns PLUS its D-190 CRM
   *  platform-reference rows (per-connection `target_id` prefix cut) — the
   *  same quorum `remove_mirror_data: true` would delete, counted not removed.
   *  `count` is the primary-record total (the live-derived cascade —
   *  annotations / links / enrichments / edges — follows the records and is not
   *  surfaced in the label). Read-only, no gate; returns 0 for a non-api /
   *  missing / mirror-less connection. Settings-only. */
  'collection.connection.previewPurge': RpcMethodSpec<
    { name: string; kind: ConnectionKind },
    { count: number }
  >;

  /** D-165 follow-on — grant an operation GROUP on a connection (the
   *  user-facing surface that makes `write→ask` reachable: write/admin/
   *  destructive ops are never auto-granted at enrollment — Invariant 3 —
   *  so a recipe targeting `deal.create` / `contact.update` denies with
   *  `operation_not_granted` until its group is granted here). Persists to
   *  the durable per-connection grant store + re-derives the live operation
   *  profile (read-tier auto-grant ∪ granted groups) so the next gateway
   *  dispatch admits→ask. `group_id` must be a group the connection's catalog
   *  declares (`bad_request` otherwise). Returns the updated grant view. */
  'collection.connection.grantOperationGroup': RpcMethodSpec<
    { name: string; kind: ConnectionKind; group_id: string },
    OperationGroupGrantView
  >;

  /** D-165 follow-on — revoke a previously-granted operation group. Removes
   *  it from the durable grant store + re-derives the profile (the group's
   *  write ops fall back out of `allowed_operations`; read-tier ops stay,
   *  auto-granted). Revoking an ungranted group is a no-op. */
  'collection.connection.revokeOperationGroup': RpcMethodSpec<
    { name: string; kind: ConnectionKind; group_id: string },
    OperationGroupGrantView
  >;

  /** D-165 follow-on — read a connection's operation-group grant view: every
   *  group its catalog declares, each flagged `granted`, plus the resulting
   *  `allowed_operations`. The Settings → Connections grant UI renders from
   *  this. Pure read — no mutation. */
  'collection.connection.listOperationGroups': RpcMethodSpec<
    { name: string; kind: ConnectionKind },
    OperationGroupGrantView
  >;

  // ── D-201 Slices 1 / 5A / 5B2B — owner-only inbound webhooks ─────
  //
  // These methods configure an ingress and its encrypted credential versions.
  // Slice 5A adds manual vendor-confirmation and explicit enable/disable. The
  // entire `webhook.` namespace is MCP-reserved because both its
  // topology reads and credential/lifecycle writes are owner control-plane
  // operations. Slice 5B2B adds content-bounded delivery inspection plus
  // eligibility-only retention and guarded retirement controls.

  'webhook.ingress.list': RpcMethodSpec<
    { include_retired?: boolean } | void,
    WebhookIngressListResponse
  >;

  'webhook.ingress.get': RpcMethodSpec<
    { ingress_id: string },
    { ingress: WebhookIngressView | null }
  >;

  'webhook.ingress.create': RpcMethodSpec<
    WebhookIngressCreateRequest,
    { ingress: WebhookIngressView }
  >;

  'webhook.ingress.update': RpcMethodSpec<
    WebhookIngressUpdateRequest,
    { ingress: WebhookIngressView }
  >;

  'webhook.ingress.credentials.write': RpcMethodSpec<
    WebhookIngressCredentialWriteRequest,
    WebhookIngressCredentialWriteResponse
  >;

  'webhook.ingress.credentials.retire': RpcMethodSpec<
    WebhookIngressCredentialRetireRequest,
    { ingress: WebhookIngressView }
  >;

  'webhook.ingress.manual.confirm': RpcMethodSpec<
    WebhookIngressManualConfirmRequest,
    { ingress: WebhookIngressView }
  >;

  'webhook.ingress.registration.reconcile': RpcMethodSpec<
    WebhookIngressRegistrationReconcileRequest,
    { ingress: WebhookIngressView }
  >;

  'webhook.ingress.enable': RpcMethodSpec<
    WebhookIngressEnableRequest,
    { ingress: WebhookIngressView }
  >;

  'webhook.ingress.disable': RpcMethodSpec<
    WebhookIngressDisableRequest,
    { ingress: WebhookIngressView }
  >;

  'webhook.ingress.test.deliver': RpcMethodSpec<
    WebhookIngressTestDeliveryRequest,
    WebhookIngressTestDeliveryResponse
  >;

  'webhook.ingress.retire': RpcMethodSpec<
    WebhookIngressRetireRequest,
    { ingress: WebhookIngressView }
  >;

  'webhook.delivery.list': RpcMethodSpec<
    WebhookDeliveryListRequest,
    WebhookDeliveryListResponse
  >;

  'webhook.delivery.get': RpcMethodSpec<
    WebhookDeliveryGetRequest,
    { detail: WebhookDeliveryDetailView }
  >;

  'webhook.delivery.event.get': RpcMethodSpec<
    WebhookDeliveryEventGetRequest,
    { event: WebhookDeliveryEventPayloadView }
  >;

  'webhook.delivery.rejected.list': RpcMethodSpec<
    WebhookRejectedDeliveryListRequest,
    WebhookRejectedDeliveryListResponse
  >;

  'webhook.delivery.retention.prune': RpcMethodSpec<
    WebhookDeliveryRetentionPruneRequest,
    WebhookDeliveryRetentionPruneResponse
  >;

  /** D-166 override-write path — author an actor-scoped tightening row at
   *  `(actor, ingredient_id, operation_id?)`. Every field (`denied`,
   *  `approval`, `max_risk_without_approval`, `timeout_ms`, `cache_ttl_ms`)
   *  composes through the existing tightening-only lattice; a net-looser write
   *  is rejected with `contract_write_loosens`.
   *
   *  D-211's owner replacement of pack `{risk, approval}` is deliberately NOT
   *  stored here; the actorless exact-operation `collection.operation.*`
   *  family below owns it. `actor` must be a known Actor kind;
   *  `ingredient_id` a catalog-form ingredient slug;
   *  `operation_id` (when present) a declared operation's fully-qualified id
   *  (`<slug>.<op>`) — omit it for an ingredient-wide override. The `policy`
   *  must set at least one stored field (use `deleteOverride` to clear).
   *  Settings-only (`collection.contract.*`
   *  is reserved out of the MCP catalog). Returns the written row. Reserved
   *  `not_configured` when no contract store / catalog is wired (db-less
   *  harness). */
  'collection.contract.upsertOverride': RpcMethodSpec<
    { actor: Actor; ingredient_id: string; operation_id?: string; policy: OverridePolicyInput },
    OverrideView
  >;

  /** D-166 override-write path — delete an actor-scoped tightening row,
   *  reverting that key to the connection-keyed grant floor. Deleting an absent
   *  override is a no-op (`deleted:false`). Does NOT re-validate
   *  the ingredient/operation against the catalog (an override for a
   *  since-uninstalled ingredient must still be removable). Settings-only. */
  'collection.contract.deleteOverride': RpcMethodSpec<
    { actor: Actor; ingredient_id: string; operation_id?: string },
    { deleted: boolean }
  >;

  /** D-166 override-write path — list authored override rows, optionally
   *  filtered to one `ingredient_id` (the inventory UI's per-ingredient view).
   *  `ingredient_id` is the SECOND key segment (not a scan prefix), so the filter
   *  is applied post-scan over the whole scope — fine at contract storage-scale
   *  (≤ ~175 rows). Pure read. Settings-only. */
  'collection.contract.listOverrides': RpcMethodSpec<
    { ingredient_id?: string } | void,
    { overrides: OverrideView[] }
  >;

  /** D-166 override-write path (Slice A2) — the override picker's catalog
   *  source: every catalog-form ingredient + its declared operations, projected
   *  from the manifest registry (NOT `contract.installed_ingredient`, which is
   *  empty until the D-165 P3 install planner). Drives the Settings → Advanced
   *  ingredient → operation selection; the returned `operation_id` is the
   *  fully-qualified `<slug>.<op>` the UI passes straight to `upsertOverride`.
   *  Pure read. Settings-only. */
  'collection.contract.listCatalogOperations': RpcMethodSpec<
    void,
    { ingredients: CatalogIngredientView[] }
  >;

  /** D-211 — list every loaded pack operation, including the one slug-keyed
   * operation of simple-form ingredients, for the global owner-default editor. */
  'collection.operation.listOperations': RpcMethodSpec<
    void,
    { ingredients: OwnerOperationIngredientView[] }
  >;

  /** D-211 — replace the pack-authored risk and/or approval for one operation
   * globally. This owner action has no actor or contract-id dimension. */
  'collection.operation.upsertOwnerOverride': RpcMethodSpec<
    {
      ingredient_id: string;
      operation_id: string;
      policy: OwnerOperationPolicyInput;
    },
    OwnerOperationView
  >;

  /** D-211 — remove the global owner replacement and return to pack defaults. */
  'collection.operation.deleteOwnerOverride': RpcMethodSpec<
    { ingredient_id: string; operation_id: string },
    { deleted: boolean }
  >;

  /** D-211 — list global owner operation replacements, optionally by ingredient. */
  'collection.operation.listOwnerOverrides': RpcMethodSpec<
    { ingredient_id?: string } | void,
    { overrides: OwnerOperationView[] }
  >;

  /** D-166 contract_id lifecycle — mint a `contract.contract_definition.<id>`
   *  row (the gating piece: until a contract is minted, the use-resolution
   *  overlay over `.<contract_id>` rows is inert). The user supplies
   *  `display_name` + a `scope` (an empty/absent axis is a wildcard) and
   *  optionally `expiry_at` (epoch-ms) / `max_uses` (integer ≥ 1, seeds
   *  `uses_remaining`) / `approved_actions_template`. `minted_by` is stamped
   *  server-side from the authenticated client's display name (provenance);
   *  `contract_id` + `minted_at` are store-generated. The row is authoritative —
   *  mint / list / revoke are real over the contract store immediately. (The
   *  overlay resolver consults a definition by the dispatch's own `contract_id`,
   *  so a minted id governs — and revoke kills — a live dispatch only once the
   *  MCP-token ↔ minted-contract binding lands; that binding is the follow-on, not
   *  this surface.) Returns the minted row + its resolved `lifecycle_state`.
   *  Settings-only (`collection.contract.*` is reserved out of the MCP catalog —
   *  an agent must never mint itself a contract). Reserved `not_configured` when
   *  no contract store is wired (db-less harness). */
  'collection.contract.mintContract': RpcMethodSpec<
    MintContractRequest,
    ContractDefinitionView
  >;

  /** D-166 contract_id lifecycle — revoke a minted contract, stamping
   *  `revoked_at` + `revocation_reason` (→ the contract is inert at the next
   *  gateway dispatch). Idempotent: re-revoking preserves the FIRST revocation's
   *  provenance. `reason` is optional (defaults to a Settings marker). Rejects
   *  `not_found` when `contract_id` names no row. Returns the resulting row + its
   *  (now `revoked`) `lifecycle_state`. Settings-only. */
  'collection.contract.revokeContract': RpcMethodSpec<
    { contract_id: string; reason?: string },
    ContractDefinitionView
  >;

  /** D-187 §6 (step 7 follow-on) — REPLACE an existing contract's level-1
   *  `door_types` IN PLACE (no re-mint, so the `contract_id` + any bound MCP
   *  token survive — a re-mint would change the id and break the binding). The
   *  level-1 door-type axis 3c flips per door (the §3.0 "door on/off" switch).
   *  `door_types` is REQUIRED: `[]` clears the restriction (wildcard), a
   *  non-empty array restricts to those door types. Rejects `bad_request` on a
   *  bad door-type member / the reserved owner id, `not_found` when `contract_id`
   *  names no STANDING contract (a gate-consumed session / delegation grant is
   *  never a door — door types live only on standing contracts). Broadcasts
   *  `contract.contract_definition_changed` (op `update`) so every paired client's
   *  door surface re-lists. Returns the updated row + its `lifecycle_state`.
   *  Settings-only (`collection.contract.*` is reserved out of the MCP catalog). */
  'collection.contract.setDoorTypes': RpcMethodSpec<
    SetContractDoorTypesRequest,
    ContractDefinitionView
  >;

  /** D-166 contract_id lifecycle — list every minted contract, newest first
   *  (`minted_at` descending), each with its server-resolved `lifecycle_state`
   *  (`active` / `revoked` / `expired` / `exhausted`) so the Settings → Privacy →
   *  Contracts UI renders the status pill without a client clock. Pure read.
   *  Settings-only.
   *
   *  D-177 N.13 (P6c — the P6a codex LOW) — optional `grant_kind`
   *  discrimination: `'standing'` returns only standing contracts (rows
   *  carrying no gate-grant kind), `'session'` / `'delegation'` only that
   *  gate-grant family. Absent ⇒ every row (the pre-P6c contract — grant rows
   *  deliberately surface for visibility + revoke). Unknown future
   *  D-196 widens the filter vocabulary so Seller surfaces can ask for
   *  customer templates / instances explicitly. Unknown future `grant_kind`
   *  vocabulary on a JSON row appears ONLY in the unfiltered listing (fail
   *  closed — never misfiled under `'standing'`). `exclude_derived_doors` and
   *  `derived_doors_only` provide complementary paged partitions for ordinary
   *  authored contracts versus server-managed reception/webhook contracts. */
  'collection.contract.listContracts': RpcMethodSpec<
    ContractListRequest | void,
    ContractListResponse
  >;

  /** D-186 Slice C — the live-control "Active passes" list: every ACTIVE
   *  `grant_kind: 'session'` row, projected to a compact render shape
   *  (what it permits · mode · remaining TTL · budget), soonest-expiring
   *  first. `channel_session_id`, when present, narrows to one session (the
   *  future per-chat surface); absent ⇒ every active session grant owner-wide
   *  (the global Runs bubble). Only `active` rows surface — revoked / expired /
   *  exhausted drop off (the "auto-retire" the bubble shows). A session grant
   *  is never a bearer secret (N.3), so the view carries no payload/projection
   *  hashes. Owner-surface only, reserved out of MCP with the rest of
   *  `collection.contract.`. Pure read. */
  'collection.contract.session_grant.list': RpcMethodSpec<
    SessionGrantListRequest | void,
    SessionGrantListResponse
  >;

  /** D-186 Slice C — early-revoke ONE active session grant (the "Active
   *  passes" Revoke button): stamps `revoked_at` so the grant is inert at the
   *  next gate match (future matching ops re-ask). SESSION-SCOPED — rejects
   *  `not_found` when `contract_id` names no row OR names a non-session row (a
   *  standing contract / delegation rule is revoked from Settings → Privacy →
   *  Contracts via `revokeContract`, never here). Revoke is a TIGHTENING, so an
   *  in-flight already-admitted op is unaffected (that is `execution.kill`'s
   *  job). Returns the now-`revoked` view. Broadcasts
   *  `contract.contract_definition_changed` so every paired client's bubble
   *  re-lists. Owner-surface only, reserved out of MCP. */
  'collection.contract.session_grant.revoke': RpcMethodSpec<
    SessionGrantRevokeRequest,
    SessionGrantView
  >;

  /** D-177 N.13 (P6c) — list the staged-trust delegation-rule suggestions
   *  (every state; the "Suggested rules" panel filters/sections —
   *  most-recently-updated first, the suggestion store's order). Suggestions
   *  are NEVER serialized into model-visible context (N.9.1): this read is
   *  owner-surface only, reserved out of MCP with the rest of
   *  `collection.contract.`. Pure read. Reserved `not_configured` when no
   *  contract store is wired (db-less harness). */
  'collection.contract.listDelegationSuggestions': RpcMethodSpec<
    void,
    { suggestions: DelegationRuleSuggestionRow[] }
  >;

  /** D-177 N.13 (P6c) — accept an open delegation-rule suggestion: mint the
   *  `grant_kind: 'delegation'` rule FROM THE STORED SNAPSHOT (what the card
   *  showed — the `SessionGrantOffer` snapshot-at-raise posture; the mint
   *  re-validates the snapshot's tier ∈ `DELEGATION_RULE_RISK_TIERS` and
   *  refuses any session binding), flip the suggestion `state: 'accepted'`,
   *  audit reserve-class `delegation_rule_minted`, and broadcast
   *  `contract.contract_definition_changed` + the suggestion-resolved kind.
   *  `ttl_ms` / `max_uses` TIGHTEN the code-constant bounds
   *  (`DELEGATION_RULE_TTL_MS` 30 d / `DELEGATION_RULE_MAX_USES` 100) —
   *  values above the ceiling reject `bad_request` (a wider rule is
   *  unrepresentable). Idempotent across at-least-once retries: the rule's
   *  `approved_action_ref` anchors on the suggestion `key_hash`, so a retry
   *  returns the already-minted rule instead of minting a twin. Rejects
   *  `not_found` for an unknown key, `bad_request` for a dismissed key
   *  (dismissal is per-key permanent) or a snapshot that cannot mint.
   *  Owner-surface only, reserved out of MCP (an agent must never promote
   *  its own suggestion — N.9.7: only the human mints). */
  'collection.contract.acceptDelegationSuggestion': RpcMethodSpec<
    { key_hash: string; ttl_ms?: number; max_uses?: number },
    { rule: ContractDefinitionView; suggestion: DelegationRuleSuggestionRow }
  >;

  /** D-177 N.13 (P6c) — dismiss an open delegation-rule suggestion: per-key
   *  PERMANENT (the learner never re-opens a dismissed key; `recipe_hash` in
   *  the key re-arms naturally on recipe update via a fresh key). Idempotent
   *  on an already-dismissed key; rejects `not_found` for an unknown key and
   *  `bad_request` for an accepted one (the rule exists — revoke the RULE
   *  via `revokeContract` instead). Broadcasts the suggestion-resolved kind
   *  so every paired client's panel drops the card. Owner-surface only,
   *  reserved out of MCP. */
  'collection.contract.dismissDelegationSuggestion': RpcMethodSpec<
    { key_hash: string },
    { suggestion: DelegationRuleSuggestionRow }
  >;

  /** D-177 N.11 rule 5 (5.c, slice C) — list the utterance-derived
   *  scoped-grant proposals (every state; the card surface filters by state
   *  + session — most-recently-updated first). Proposals are NEVER
   *  serialized into model-visible context (N.9.1): owner-surface only,
   *  reserved out of MCP with the rest of `collection.contract.`. */
  'collection.contract.listScopedGrantSuggestions': RpcMethodSpec<
    void,
    { suggestions: ScopedGrantSuggestionRow[] }
  >;

  /** D-177 N.11 rule 5 (5.c, slice C) — accept an open scoped-grant
   *  proposal: mint the `grant_kind: 'session'` / `grant_mode: 'scoped'`
   *  grant FROM THE STORED SNAPSHOT (what the card showed), bound to the
   *  proposal's chat session + the resolved catalog op + ONE live-validated
   *  connection (single enrolled candidate auto-filled, multiple require
   *  `connection_name`, none ⇒ `bad_request` — unmintable, 5.c). `ttl_ms` /
   *  `max_uses` TIGHTEN the card's bounds (the snapshot TTL / the
   *  `SCOPED_GRANT_MAX_USES_DEFAULT` budget). Idempotent across
   *  at-least-once retries via the grant's `approved_action_ref` anchor.
   *  Returns the rule-7 sentence actually enforced. Owner-surface only,
   *  reserved out of MCP (the model can never accept its own proposal —
   *  N.9.7). */
  'collection.contract.acceptScopedGrantSuggestion': RpcMethodSpec<
    { key_hash: string; connection_name?: string; ttl_ms?: number; max_uses?: number },
    {
      grant: ContractDefinitionView;
      suggestion: ScopedGrantSuggestionRow;
      sentence: string;
    }
  >;

  /** D-177 N.11 rule 5 (5.c, slice C) — dismiss an open scoped-grant
   *  proposal: per-key permanent for the session (a re-utterance of the
   *  same request raises no new card). Idempotent on an already-dismissed
   *  key; `bad_request` for an accepted one (revoke the GRANT via
   *  `revokeContract` instead). Owner-surface only, reserved out of MCP. */
  'collection.contract.dismissScopedGrantSuggestion': RpcMethodSpec<
    { key_hash: string },
    { suggestion: ScopedGrantSuggestionRow }
  >;

  // ── D-202 — quality-delegation suggest→accept + governance ──────
  //
  // The second delegation axis's #contracts surface: the owner accepts/dismisses
  // (Slice 1) learner-surfaced quality-delegation suggestions and lists/revokes
  // the minted grants (coarse (recipe, op) governance, §5). Owner-surface only,
  // reserved out of MCP with the rest of `collection.contract.` (an agent must
  // never promote its own quality suggestion, §12.4).
  /** List every quality-delegation suggestion (all states; the panel sections).
   *  Owner-surface only. */
  'collection.contract.listQualityDelegationSuggestions': RpcMethodSpec<
    void,
    { suggestions: QualityDelegationSuggestionRow[] }
  >;
  /** Accept an open quality-delegation suggestion: mint the
   *  `grant_kind: 'quality_delegation'` grant FROM THE STORED SNAPSHOT (coarse
   *  (recipe, op) grain — no payload identity), flip the suggestion
   *  `state: 'accepted'`, audit reserve-class `quality_delegation_minted`, and
   *  broadcast `contract.contract_definition_changed`. A quality delegation is
   *  STANDING; the OPTIONAL `ttl_ms` self-expires with NO ceiling (the
   *  kill-switch reclaims, not a TTL). Idempotent across at-least-once retries
   *  via the grant's `approved_action_ref` anchor on the suggestion `key_hash`.
   *  Rejects `not_found` for an unknown key, `bad_request` for a dismissed key
   *  or a snapshot that cannot mint. Owner-surface only. */
  'collection.contract.acceptQualityDelegationSuggestion': RpcMethodSpec<
    { key_hash: string; ttl_ms?: number },
    { grant: ContractDefinitionView; suggestion: QualityDelegationSuggestionRow }
  >;
  /** Dismiss an open quality-delegation suggestion: per-key PERMANENT (a fresh
   *  `recipe_hash` re-arms a new key). Idempotent on an already-dismissed key;
   *  `bad_request` for an accepted one (revoke the GRANT via
   *  `revokeQualityDelegation` instead). Owner-surface only. */
  'collection.contract.dismissQualityDelegationSuggestion': RpcMethodSpec<
    { key_hash: string },
    { suggestion: QualityDelegationSuggestionRow }
  >;
  /** List the active quality delegations (the coarse (recipe, op) governance
   *  surface — every state; the panel renders the revoke pill). Owner-surface
   *  only. Pure read. */
  'collection.contract.listQualityDelegations': RpcMethodSpec<
    void,
    { contracts: ContractDefinitionView[] }
  >;
  /** Revoke one quality delegation (a tightening — matching sends return to
   *  quality review). Refuses `bad_request` if the id names a non-quality row.
   *  Broadcasts `contract.contract_definition_changed` (op `revoke`).
   *  Owner-surface only. */
  'collection.contract.revokeQualityDelegation': RpcMethodSpec<
    { contract_id: string; reason?: string },
    ContractDefinitionView
  >;

  // D-187 slice 5 — the per-contract policy-overlay rpc trio
  // (`upsertContractPolicy` / `deleteContractPolicy` / `listContractPolicies`)
  // was DELETED. Its sole job was authoring the per-door `scope_restrictions`
  // read-fence cell; that fence re-homed onto the unified `contract_grant`
  // store (collection-kind grants, authored via `contract.grant.write`), since
  // entity access is a per-CONTRACT Layer-2 concern, not a per-door one.

  /** D-152 hostname registry surface. Settings-only local-UI CRUD over
   *  the free multi-hostname store. Public projections never include
   *  cert blob ids, verification-token hashes, private key PEM, or cert
   *  key material. */
  'collection.hostname.list': RpcMethodSpec<
    void,
    HostnameListResponse
  >;

  /** Read one hostname projection by hostname. Missing rows return
   *  `{ hostname: null }`; malformed hostnames reject with
   *  `invalid_hostname`. */
  'collection.hostname.get': RpcMethodSpec<
    HostnameGetRequest,
    HostnameGetResponse
  >;

  /** Add a hostname row. The server stamps its own stable
   *  `server_identity_id`; callers cannot spoof ownership. */
  'collection.hostname.add': RpcMethodSpec<
    HostnameAddRequest,
    HostnameMutationResponse
  >;

  /** Patch an existing hostname row. Cert-source changes reset BYO
   *  ownership proof unless the caller supplies an explicit status. */
  'collection.hostname.update': RpcMethodSpec<
    HostnameUpdateRequest,
    HostnameMutationResponse
  >;

  /** Remove a hostname row. Idempotent from the UI perspective:
   *  returns whether a row was deleted. */
  'collection.hostname.remove': RpcMethodSpec<
    HostnameRemoveRequest,
    HostnameRemoveResponse
  >;

  /** Apply a cert / HTTP token / DNS TXT proof result to the row.
   *  Expected proof failures return `{ ok: false, code }` rather
   *  than throwing so the Settings flow can render inline guidance. */
  'collection.hostname.verifyOwnership': RpcMethodSpec<
    HostnameOwnershipProofInput,
    HostnameOwnershipProofResult
  >;

  /** Probe an existing connection and persist its fresh health snapshot.
   *  API connections run an authenticated HTTP reachability check; MCP
   *  connections initialize + enumerate tools over SSE, WebSocket, or stdio;
   *  notification connections run their vendor/config readiness check.
   *  Expected auth/reachability failures return `auth_failed` / `unreachable`
   *  as data rather than throwing. */
  'collection.connection.probe': RpcMethodSpec<
    {
      name: string;
      kind: ConnectionKind;
      /** Optional row revision from the Settings list. When supplied, the
       * paired server refuses to check a different row than the one the owner
       * is looking at. */
      expected_updated_at?: number;
    },
    {
      health: ConnectionHealth;
      /** Revision written with this exact health snapshot. Optional on the
       * wire so current clients can degrade safely against an older server. */
      connection_updated_at?: number;
      /** Closed-list, value-free correction returned only when the server
       * authoritatively classified the current saved credential as rejected. */
      credential_correction?: ConnectionCredentialRejectionCorrection;
    }
  >;

  /** D-225 Slice 2 — the pack-detail review screen's data source, and the
   *  middle of the owner's enrollment chain: `#connections → mcp → create →
   *  success` → THIS → adjust risk & approval → Save.
   *
   *  PROBES the server live and projects its `tools/list` into one review row
   *  per tool. Installs NOTHING — this is the form, not the commit.
   *
   *  ⛔ Every row's `stored` value is `write` / `ask`, whatever the server
   *  claims about itself. A tool NAME is not evidence of write-ness and neither
   *  is `annotations.readOnlyHint` (the party a risk tier constrains does not
   *  get to set it), so a hint renders as an attributed badge beside a
   *  suggestion the owner must click — never as the stored default. Save
   *  without reading therefore holds everything. */
  'collection.connection.mcpPackPreview': RpcMethodSpec<
    { name: string; kind: ConnectionKind },
    {
      pack_slug: string;
      connection: { kind: string; name: string };
      rows: McpPackReviewRow[];
    }
  >;

  /** D-225 Slice 2 — the **Save** of the enrollment chain: install the pack
   *  generated from this connection's `tools/list`.
   *
   *  ⛔ Writes NO risk/approval rulings. Those go through
   *  `contract.ownerOperation.*`, which enforces the approval floor and refuses
   *  a risk downgrade without `confirm_risk_downgrade`. A commit path writing
   *  rulings itself would duplicate those gates or bypass them, and bypassing is
   *  how a third party's tools end up auto-running with nobody having confirmed
   *  it. The installed pack is inert — every op `write` + `ask`, every group
   *  `grant_default: off` — until the owner tunes it through that gated path.
   *
   *  ⛔ `reviewed_ops` is a TOCTOU guard. The owner reviewed ONE tool set and is
   *  authorizing THAT one; the server can change between preview and Save. An op
   *  id is a hash of `{name, input_schema}`, so comparing the freshly-probed set
   *  against what was reviewed IS "is this still what I showed you". A
   *  divergence refuses with `conflict` and asks for a re-review. */
  'collection.connection.mcpPackCommit': RpcMethodSpec<
    {
      name: string;
      kind: ConnectionKind;
      reviewed_ops: string[];
      /** D-228 slice 3 — the install-point grant selection, the SAME field an
       *  ordinary `packs.install` carries.
       *
       *  ⛔ Without it a generated MCP pack installed with `packs.install`'s
       *  absent-scope behaviour, whose contract is explicit: *"ABSENT ⇒ fail
       *  closed: grant ONLY the authored read / `approval: ask` defaults"*. So
       *  every MCP connection's writes were ungrantable at the one point the
       *  owner is actually looking at the tool list, and Tier-3 write access had
       *  no install-time consent step at all — it fell back to the per-tool
       *  presentation-store overrides, which is the D-225 defect this decision
       *  exists to remove.
       *
       *  ⚠ ABSENT STILL MEANS READ-ONLY. This adds the ability to grant at
       *  install; it does not change what happens when nothing is chosen. */
      install_scope?: import('../bulk-pack.js').InstallGrantSelection;
    },
    { pack_slug: string; operations: number }
  >;

  /** D-225 Slice 2 — the drift badge. Is this connection's generated pack still
   *  current with what the server publishes?
   *
   *  🔑 Runs with NO probe: the current side is `ConnectionHealth.tool_hashes`
   *  (persisted at the last probe) and the minted side derives from the
   *  installed pack's own bindings, so a connections list can render a badge per
   *  row without touching the network.
   *
   *  ⛔ `unknown` is a distinct status from `current`. A connection never probed
   *  since `tool_hashes` landed has no current side to compare, and reporting
   *  `current` would be a false all-clear on exactly the connections most likely
   *  to have drifted — the ones nobody has looked at.
   *
   *  ⚠ Counts, not names. Resolving a hash back to a tool needs a probe, which
   *  is `mcpPackPreview`'s job. The badge exists to prompt one decision —
   *  "something changed, re-review" — and that is all it should claim to know. */
  'collection.connection.mcpPackStatus': RpcMethodSpec<
    { name: string; kind: ConnectionKind },
    {
      pack_slug: string;
      status: 'no_pack' | 'unknown' | 'current' | 'drifted';
      added: number;
      removed: number;
      last_probed_at?: number;
    }
  >;

  /** D-129 P1.2 — vendor OAuth code-exchange. The enrollment dialog
   *  captures the auth `code` from the vendor's authorize redirect
   *  (P1.3 wires the in-app dance) and pushes it here with the user-
   *  supplied `client_id` + `client_secret` (BYO Developer Portal app
   *  per D-129 spec § A.1). The server exchanges the code for a refresh
   *  token via the vendor provider's `token_endpoint`, then introspects
   *  the freshly-minted access token against the vendor's access-token
   *  metadata endpoint to read the actually-granted scope set.
   *  Returns `{ refresh_token, granted_scopes }` to the caller — the
   *  dialog drops the refresh token into the `auth.refresh_token`
   *  form field and surfaces the granted-scope list as a confirmation
   *  hint before the user clicks Save (which fires
   *  `collection.connection.enroll` to persist).
   *
   *  No connection record is written here — the rpc is pure exchange.
   *  This keeps the OAuth dance composable with the existing enroll
   *  rpc and avoids a half-written row when the user backs out before
   *  Save.
   *
   *  Vendor lookup goes through the `CONNECTION_VENDOR_PROVIDERS`
   *  registry (`getVendorProvider(vendor)`); unknown vendors throw
   *  `bad_request`. Vendors whose `oauth.client_secret_required` is
   *  true (HubSpot) reject calls without `client_secret`. */
  'collection.connection.completeVendorOAuth': RpcMethodSpec<
    {
      vendor: string;
      code: string;
      redirect_uri: string;
      client_id: string;
      client_secret?: string;
      /** R26.2-for-vendors — form-supplied endpoints for a NON-REGISTRY vendor,
       *  mirroring `startVendorOAuth`. Ignored for a registered vendor, which
       *  always uses its registry config so these can never bypass its PKCE /
       *  secret gate / sandbox split.
       *
       *  They exist so a LOOPBACK self-serve flow can finish. `startVendorOAuth`
       *  requires a public HTTPS server URL (its signed state carries one and
       *  the cloud page forwards the code there), which a self-hosted server
       *  reached at `127.0.0.1` does not have — so that path is unreachable and
       *  the browser completes through this pure-exchange rpc instead, after the
       *  same-origin callback page hands it the code. */
      authorize_url?: string;
      token_endpoint?: string;
      /** D-130 P1 — sandbox-mode flag. When `true` and the vendor
       *  declares sandbox OAuth URLs (Salesforce), the code exchange
       *  POSTs to the sandbox token endpoint. Vendors without a
       *  sandbox split (HubSpot) ignore the flag. Defaults to
       *  `false` (production). */
      sandbox?: boolean;
    },
    {
      refresh_token: string;
      granted_scopes: string[];
      /** D-130 P5 — Salesforce stamps the per-org runtime base URL
       *  (`https://mycompany.my.salesforce.com` or
       *  `https://mycompany--sandbox.sandbox.my.salesforce.com`) on
       *  every token + refresh response. The enrollment dialog drops
       *  this into `config.base_url` so subsequent REST + SOQL +
       *  CometD long-poll calls land at the right host. Vendors
       *  without an instance_url field (HubSpot) leave the property
       *  undefined; the dialog falls back to user-typed config. */
      instance_url?: string;
    }
  >;

  /** D-148 § A.12 / D-165 enroll-host #1 — vendor OAuth-start. The
   *  partner to `completeVendorOAuth`: the enrollment dialog calls this
   *  BEFORE redirecting the user to the vendor's consent screen. The
   *  server mints a signed, short-lived `state` token (Ed25519 over
   *  `{ server_url, flow_id, ts }` via `server_identity_key`), stashes
   *  the pending flow (vendor + BYO `client_id`/`client_secret` + chosen
   *  `redirect_uri` + sandbox) keyed by `flow_id`, and returns the
   *  authorize URL plus the server-identity public key.
   *
   *  The webclient opens `authorize_url` in a user-gesture popup and
   *  writes `server_identity_public_key_b64` into `app.recued.com`
   *  sessionStorage under `oauth_jwks_<flow_id>` so the § A.12 static
   *  callback page can verify the state signature before forwarding the
   *  code to `<server_url>/oauth/complete` (slice 2). Tokens never touch
   *  the cloud (I-18) — the exchange runs on the user-server.
   *
   *  `redirect_uri` MUST be one of
   *  `vendorOAuthRedirectChoices(server_url)` — either the cloud
   *  callback (`OAUTH_CLOUD_CALLBACK_URL`) or the user-server's own
   *  `/oauth/complete` — so the authorization code can only land on a
   *  Recued-completable endpoint. Unknown vendor → `bad_request`;
   *  `client_secret`-required vendors (HubSpot / Salesforce) reject
   *  calls without it; an unconfigured server public URL →
   *  `not_configured`. */
  'collection.connection.startVendorOAuth': RpcMethodSpec<
    {
      /** A registered vendor slug (HubSpot/Salesforce/…) OR a free label
       *  for a form-supplied generic connection. When `authorize_url` +
       *  `token_endpoint` are present the handler runs the FORM-SUPPLIED
       *  path (R14 — any BYO OAuth vendor) and `vendor` is only a label;
       *  otherwise it resolves the registry vendor. */
      vendor: string;
      client_id: string;
      client_secret?: string;
      /** The redirect URI the user registered with their BYO vendor
       *  OAuth app. Must match one of
       *  `vendorOAuthRedirectChoices(server_url)`. */
      redirect_uri: string;
      /** D-130 — sandbox-mode flag (Salesforce). Selects the sandbox
       *  authorize URL when the vendor declares one. */
      sandbox?: boolean;
      /** R14 — form-supplied OAuth config for a generic (non-registry)
       *  vendor. When `authorize_url` + `token_endpoint` are both present
       *  the handler synthesizes a provider from these instead of looking
       *  `vendor` up in the registry, so the in-app consent dance runs for
       *  any user-supplied vendor. `scopes` defaults to none. */
      authorize_url?: string;
      token_endpoint?: string;
      scopes?: ReadonlyArray<string>;
    },
    {
      /** Vendor consent URL with the signed `state` embedded. The
       *  webclient opens this in a user-gesture popup. */
      authorize_url: string;
      /** One-time flow id; also the sessionStorage key suffix
       *  (`oauth_jwks_<flow_id>`) + the `/oauth/complete` lookup key. */
      flow_id: string;
      /** SPKI-DER base64 server-identity public key. The webclient
       *  caches this in `app.recued.com` sessionStorage so the static
       *  callback page can verify the `state` signature. */
      server_identity_public_key_b64: string;
      /** D-165 slice 3 — owner-binding nonce (256-bit CSPRNG). Returned
       *  ONLY here, to the originating client; the dialog stashes it and
       *  presents it to `takeVendorOAuthResult` after the completion
       *  broadcast. The `{ flow_id }`-only broadcast reaches every paired
       *  client, so this secret is what stops any OTHER client from
       *  claiming the refresh token. Never appears on the bus or any other
       *  response. */
      claim_secret: string;
    }
  >;

  /** D-165 slice 3 — vendor OAuth result-claim. The owner-bound partner
   *  to `startVendorOAuth` + the `/oauth/complete` callback. Once the
   *  user-server completes the code exchange it stashes the credential in
   *  an in-memory, consume-once result store and fans a
   *  `connection.vendor_oauth_completed` broadcast carrying ONLY
   *  `flow_id` (the bus reaches every paired client of the same user, so
   *  the refresh token never rides it). The originating dialog claims the
   *  credential here by presenting the `claim_secret` the start rpc handed
   *  it: the store consumes + returns the credential on a constant-time
   *  secret match, else returns `{ result: null }` WITHOUT consuming (so a
   *  wrong/racing client that reacted to the same broadcast cannot starve
   *  the legitimate dialog). `null` also covers an absent / already-claimed
   *  / expired flow — the caller treats every `null` as "not mine / not
   *  ready" and falls back to its timeout. Off the MCP catalog via the
   *  reserved `collection.connection.` prefix. */
  'collection.connection.takeVendorOAuthResult': RpcMethodSpec<
    { flow_id: string; claim_secret: string },
    {
      result: {
        refresh_token: string;
        granted_scopes: string[];
        instance_url?: string;
      } | null;
    }
  >;

  /** D-139 P2 — per-entity engagement health surface. Drives Settings
   *  → Connections → HubSpot / Salesforce per-entity health row. The
   *  rpc looks up the connection, infers vendor from `config.vendor`,
   *  iterates the vendor's engagement entities, and projects one row
   *  per entity from the housekeeping_state cycle row + rate-control
   *  store + capability store (D-184 retired the separate runonce row).
   *  See spec § A.8 for the surface description. */
  'collection.connection.engagementHealth': RpcMethodSpec<
    EngagementHealthRequest,
    EngagementHealthResponse
  >;

  /** D-139 P2 — Salesforce-only capability re-probe. Re-runs
   *  `describeSObjects()` + per-channel CDC + PushTopic streamability
   *  probes (Pass-5 R5.10) + dual-schema VoiceCall vs CallHistory pick
   *  (Pass-5 R5.11); persists fresh capability rows; auto-creates
   *  PushTopics for newly-streamable objects via
   *  `pushtopic-soap.ts:ensureEngagementPushTopics`; returns the
   *  fresh capability list + `call_entity_changed` flag. Rejects
   *  HubSpot connections — HubSpot's "capability" surface is the
   *  existing `collection.connection.probe` rpc + the OAuth-scope
   *  set. See spec § A.8. */
  'collection.connection.reprobeEngagementCapabilities': RpcMethodSpec<
    ReprobeEngagementCapabilitiesRequest,
    ReprobeEngagementCapabilitiesResponse
  >;

  // ── Enrichment substrate (D-122 Phase 4.5) ──────────────────────
  //
  // Generic write + governed read into `data.enrichment.*`. Routed
  // through the `enrichment-upsert` + `enrichment-list` kernel
  // ingredients; the server-side store demuxes Shape A vs B per the
  // registry. Mail-get is a separate per-record warehouse read; both
  // surfaces ride the standard rpc envelope.
  'enrichment.upsert': RpcMethodSpec<
    {
      topic: string;
      scope?: 'mail' | 'contact' | 'calendar' | 'file';
      id: string;
      value: unknown;
      authored_by_recipe_id: string;
      source_record_hash?: string;
      recipe_hash?: string;
      /** D-136 P2 — replaces legacy `model_used`. Producer-supplied
       *  ingredient slug (`'ai-classify'`, `'ai-extract'`, …). */
      ingredient_slug?: string;
      /** D-136 P2 — resolved provider model id, populated by the
       *  ForceLayer resolver at producer call time once P3 lands. */
      model_id?: string;
      event_at?: number;
    },
    { _id: string; wrote: true }
  >;
  'enrichment.list': RpcMethodSpec<
    {
      topic: string;
      scope?: 'mail' | 'contact' | 'calendar' | 'file';
      target_id?: string;
      authored_by_recipe_id?: string;
      fresh_only?: boolean;
      limit?: number;
      offset?: number;
    },
    { entries: unknown[]; next_cursor: string | null }
  >;

  /** D-136 §A.11 P7 — quality-vote ingest. The vote consumer routes
   *  per `vote` kind:
   *    - `'wrong' | 'stale'` → enqueue `lifecycle_action_pending = 'recompute'`
   *      (or `'discard'` when the topic's lifecycle_policy disallows
   *      recompute — see store-side routing).
   *    - `'corrected'` → write user-pinned row via `mode: 'pinned'` +
   *      `authored_by` derived from `ENRICHMENT_PINNED_AUTHOR_PREFIX` +
   *      `vote_id`; subsequent recompute checks pin → no-op.
   *    - `'irrelevant'` → persist vote only; UI hides the row.
   *    - `'correct'` → reset `failure_attempt_count` on the row.
   *
   *  Source-vs-client validation matrix runs at the handler:
   *    - `'user_dismissal' | 'user_action'` — paired-client (D-121),
   *      read-tier permission.
   *    - `'explicit_correction'` — paired-client, write-tier;
   *      required for `vote: 'corrected'`.
   *    - `'agent_action'` — MCP-channel agent; handler stamps
   *      `agent_session_id` + `agent_sub_path` per §A.13.7 from the
   *      dispatch envelope. */
  'enrichment.vote.write': RpcMethodSpec<
    {
      topic: string;
      scope?: 'mail' | 'contact' | 'calendar' | 'file';
      target_id?: string;
      enrichment_row_id: string;
      vote: import('../enrichment-registry.js').EnrichmentVoteKind;
      source: import('../enrichment-registry.js').EnrichmentVoteSource;
      /** Required when `vote === 'corrected'`. JSON-serialisable
       *  pinned value the user / agent supplied. */
      corrected_value?: unknown;
      /** D-135 telemetry — recipe id of the dish recipe that
       *  surfaced the row to the voter. Optional. */
      context_recipe_id?: string;
      /** D-136 §A.13.7 — sub-agent identity preserved through swarm
       *  decomposition. Set by the MCP handler when `source ===
       *  'agent_action'`; ignored on user-source votes. */
      agent_session_id?: string;
      agent_sub_path?: string;
    },
    {
      vote_id: string;
      /** Lifecycle action enqueued / cleared on the target row.
       *    - `'recompute'` for `wrong` / `stale` on recompute-eligible
       *      topics.
       *    - `'discard'` for `wrong` / `stale` on TTL / one-shot
       *      topics where recompute is meaningless.
       *    - `'pin_written'` for `corrected` (a new pinned row was
       *      written; original stays).
       *    - `'failure_count_reset'` for `correct`.
       *    - `'noop'` for `irrelevant` (UI suppression only). */
      routing: 'recompute' | 'discard' | 'pin_written' | 'failure_count_reset' | 'noop';
      /** When `routing === 'pin_written'`, the new pinned row id.
       *  Otherwise null. */
      pinned_row_id: string | null;
    }
  >;
  /** D-136 §A.11 P7 — vote unwind. Removes the vote + (when the vote
   *  was `'corrected'`) tombstones the user-pinned row that was
   *  created. Lifecycle clear conditions per Q10 closure (manual_pinned
   *  cleared on explicit unpin or source-cascade-delete only — never
   *  on TTL / drift / producer upgrade). */
  'enrichment.vote.delete': RpcMethodSpec<
    { vote_id: string },
    { ok: true; pin_unwound: boolean }
  >;

  /** D-122 Phase 4.5 — generic outbound notification dispatcher.
   *  Channel slugs route to the existing remote-trigger config
   *  (Slack / Telegram / email — D-099) and the broadcast bus
   *  (in-app — D-121). Per-channel result flows back; recipes branch
   *  on `failed[]` for retry / fallback. Omitted `channels` means
   *  fan out to every supported notification channel.
   *  D-177 N.12 — STAYS a wire method (unlike `collection.mail.send`):
   *  authorization is the deliberate endpoint SETUP (the user enrolls +
   *  assigns + switches on each channel), and the call carries NO
   *  recipient — `text` goes to the switched-on channels whose
   *  destination is the enrolled config. It cannot be aimed at an
   *  arbitrary target, so it is not the per-call-recipient trust-bypass
   *  `collection.mail.send` was. */
  'notification.send': RpcMethodSpec<
    {
      channels?: ReadonlyArray<NotificationDeliveryChannel>;
      text: string;
      title?: string;
      /** Optional deep link surfaced as a tappable / clickable
       *  target alongside the notification body. Renamed from `url`
       *  to avoid collision with the engine-locked HTTP routing key
       *  (`url` is reserved for HTTP-ingredient attestation). */
      link_url?: string;
    },
    {
      delivered_to: Array<NotificationDeliveryChannel>;
      failed: Array<NotificationDeliveryChannel>;
    }
  >;

  /** D-122 Phase 4.5 — single-record warehouse read for mail. Sibling
   *  to the existing `collection.get` but exposes the canonical mail
   *  payload directly (calendar-get's symmetric shape) for foundational
   *  recipes that pipe `mail-watcher` triggers into a body that
   *  references `{{step.record.*}}`. */
  'mail.get': RpcMethodSpec<
    { slug: string; record_id: string },
    { record: unknown | null }
  >;

  // ── Housekeeping execution-mode (D-123 Phase 5) ─────────────────
  //
  // Settings → Server → Housekeeping panel reads + writes. The
  // scheduler instance itself stays server-internal (`backend/server/
  // src/housekeeping/`); these four rpcs are the only wire surface.
  //
  // - `config.read` — current preset + cycle budget + interval +
  //   optional custom-window. Returns `HOUSEKEEPING_DEFAULT_PRESET`
  //   defaults on a fresh DB (singleton row seeded lazily by the
  //   config store).
  // - `config.write` — apply a preset choice. Validates preset enum +
  //   `cycle_budget_ms` clamp + custom-only fields. Non-`custom`
  //   presets ignore caller-supplied budget / interval / window
  //   (overwritten by `HOUSEKEEPING_PRESET_DEFAULTS`).
  // - `status.read` — denormalized join of every registered task's
  //   meta + persisted state. `enrichment` field carries the per-
  //   record token estimate + source-collection size for `kind:
  //   'enrichment'` tasks; `kind: 'core'` tasks omit it.
  // - `task.run_now` — fire one synchronous cycle scoped to a single
  //   task. Bypasses idle-gating but honours the cycle budget; the
  //   `housekeeping_cycle` realtime event still fires after
  //   completion.
  'housekeeping.config.read': RpcMethodSpec<
    void,
    import('../housekeeping.js').HousekeepingConfigRow
  >;
  'housekeeping.config.write': RpcMethodSpec<
    {
      preset: import('../housekeeping.js').HousekeepingPreset;
      cycle_budget_ms?: number;
      cycle_interval_minutes?: number;
      custom_window_start_hour?: number;
      custom_window_end_hour?: number;
      // D-132 P4 — global AI control. Optional — caller-omitted fields
      // preserve the prior persisted values. Pass `null` on
      // `pause_background_ai_until` to clear the pause window.
      allow_byok_background?: boolean;
      pause_background_ai_until?: number | null;
    },
    { ok: true; effective: import('../housekeeping.js').HousekeepingConfigRow }
  >;
  'housekeeping.status.read': RpcMethodSpec<
    void,
    { tasks: ReadonlyArray<import('../housekeeping.js').HousekeepingTaskStatus> }
  >;
  'housekeeping.task.run_now': RpcMethodSpec<
    { task_id: string },
    { ok: true; cycle_result: import('../housekeeping.js').HousekeepingCycleResult }
  >;
  // D-132 P4 — per-topic trust state + pool policy. Drives the
  // Settings → Server → Housekeeping detail-drawer trust radios + the
  // promotion-banner dismiss action.
  'housekeeping.trust.read': RpcMethodSpec<
    void,
    { rows: ReadonlyArray<import('../enrichment-trust.js').EnrichmentTrustRow> }
  >;
  'housekeeping.trust.write': RpcMethodSpec<
    {
      topic: string;
      trust_state?: import('../enrichment-trust.js').EnrichmentTrustState;
      pool_policy?: import('../enrichment-trust.js').EnrichmentPoolPolicy;
    },
    { ok: true; effective: import('../enrichment-trust.js').EnrichmentTrustRow }
  >;
  'housekeeping.trust.dismiss_promotion': RpcMethodSpec<
    { topic: string },
    { ok: true; effective: import('../enrichment-trust.js').EnrichmentTrustRow }
  >;

  /** D-136 §A.12 P7 — topic-reset rpc. Two-step dry-run-then-confirm
   *  pattern: caller invokes once without `confirmation_token` to
   *  receive an impact summary + freshly-minted token; second call
   *  with that token applies the reset. Tokens are server-side state
   *  (in-memory `Map<token, ResetRequest>` with ~5min TTL) so request
   *  args are validated identically across both calls (replay-safe).
   *
   *  Behavior on confirm:
   *    1. Tombstones every non-pinned chain-head row matching
   *       `(topic, scope_filter?)` (sidecars dropped synchronously,
   *       value/meta NULLed, _id + event_at preserved per audit §10.2).
   *    2. Sets `lifecycle_action_pending = 'recompute'` on each
   *       tombstoned row so the next housekeeping cycle re-derives.
   *    3. When `reset_psi_baselines === true` (default for emits_confidence
   *       topics), drops `confidence_drift_signal` rows whose source-topic
   *       equals the reset target.
   *    4. Audit-logs the reset via `auditLog.logActivity` with
   *       `action: 'housekeeping.topic.reset'`.
   *
   *  Permission gate: paired-client (D-121) + write-tier. */
  'housekeeping.topic.reset': RpcMethodSpec<
    {
      topic: string;
      scope_filter?: 'mail' | 'contact' | 'calendar' | 'file';
      /** Default is `true` when the topic emits confidence (D-133) and
       *  `false` otherwise. PSI baselines lose meaning when the
       *  source-topic data has been wiped. */
      reset_psi_baselines?: boolean;
      /** When omitted → dry-run; the response carries a fresh token
       *  + impact summary. When provided → confirm; must match a
       *  prior dry-run for the same topic + scope_filter +
       *  reset_psi_baselines combination, within the TTL window
       *  (~5 minutes), unused since mint. */
      confirmation_token?: string;
    },
    {
      /** Dry-run path: `false`. Confirm path: `true`. */
      applied: boolean;
      /** Set on the dry-run path; null on the confirm path. Single-use
       *  + TTL-bound (server-side state). */
      confirmation_token: string | null;
      /** Wall-clock expiry (epoch ms) of the dry-run token. Null on
       *  confirm. */
      expires_at: number | null;
      /** Echo the request shape back so the UI can render the impact
       *  preview without holding state. */
      topic: string;
      scope_filter: 'mail' | 'contact' | 'calendar' | 'file' | null;
      reset_psi_baselines: boolean;
      /** Pre-flight numbers (dry-run + confirm both populate). */
      impact: {
        rows_to_tombstone: number;
        pinned_protected: number;
        psi_baselines_to_drop: number;
        estimated_recompute_tokens: number;
      };
      /** Confirm-path actuals; on dry-run all fields are zero. */
      applied_summary: {
        rows_tombstoned: number;
        rows_recompute_enqueued: number;
        psi_baselines_dropped: number;
        pinned_skipped: number;
      };
    }
  >;

  /** D-136 §A.13.1 P7.G — Settings UI capstone proxy over the existing
   *  `housekeeping.registry.describe` MCP handler. Mirrors the MCP
   *  output shape but bypasses the `mcp_exposed: 'private'` filter so
   *  the user sees every topic to toggle the override. The per-topic
   *  `mcp_exposed` field still reflects the effective policy (override
   *  > registry default) so the UI can paint the correct check state.
   *  Read-only, no auth gate beyond paired-client. */
  'housekeeping.registry.describe': RpcMethodSpec<
    void,
    import('../mcp.js').RegistryDescribeRpcOutput
  >;

  /** D-145 PA11 — LLM result cache summary stats for the Settings →
   *  Housekeeping per-pair "LLM result cache" card. Aggregates the
   *  per-pair `llm_result_cache` table into total entries / total
   *  hits / per-topic breakdown + surfaces the last `gcDanglingRefs`
   *  task completion timestamp via the housekeeping state store.
   *
   *  Per-topic buckets derive from each row's `result_path` via
   *  `parseEnrichmentPath`; rows that no longer parse bucket under
   *  `_malformed` so the GC surface stays observable from the UI
   *  without a console session.
   *
   *  Read-only, no auth gate beyond paired-client. Returns the
   *  `unsupported` error when `llmResultCache` isn't wired (e.g. the
   *  storage substrate is locked / not yet initialized). */
  'housekeeping.cache.stats': RpcMethodSpec<
    void,
    {
      total_entries: number;
      total_hits: number;
      per_topic: ReadonlyArray<{
        topic: string;
        entry_count: number;
        hit_count: number;
      }>;
      /** Wall-clock epoch ms of the last successful
       *  `llm-result-cache-gc` task completion. Null when the task has
       *  never run on this pair. */
      last_gc_at: number | null;
    }
  >;

  /** D-145 PA11 — Clear-cache action surfaced on the Settings →
   *  Housekeeping "LLM result cache" card. Drops every row in the
   *  per-pair `llm_result_cache` table; the UI's two-stage confirm
   *  pattern is the consent surface. Emits a `housekeeping_cache_clear`
   *  audit row stamped with the requesting paired-client's
   *  `instance_id` so the action is reconstructable post-hoc.
   *
   *  Permission gate: paired-client (D-121 `instance_id` required;
   *  unregistered connections rejected). Returns `unsupported` when
   *  `llmResultCache` isn't wired. */
  'housekeeping.cache.clear': RpcMethodSpec<
    void,
    {
      ok: true;
      /** Number of rows dropped by the clear. Zero when the cache was
       *  already empty (still `ok: true`; the action is idempotent). */
      rows_deleted: number;
    }
  >;

  /** D-136 §A.13.5 P7.G — read every per-topic MCP visibility user
   *  override the user has set. Settings UI calls once on the MCP
   *  panel mount; the response carries explicit overrides only (topics
   *  absent → registry default applies). The Settings UI joins this
   *  with `housekeeping.registry.describe` to render the per-topic
   *  toggle row.
   *
   *  Read-only, no permission gate. */
  'mcp.visibility.read': RpcMethodSpec<
    void,
    {
      overrides: ReadonlyArray<{
        topic: string;
        policy: 'public' | 'private';
        updated_at: number;
      }>;
    }
  >;

  /** D-136 §A.13.5 P7.G — write a single per-topic MCP visibility user
   *  override. Pass `policy: null` to clear the override (revert to
   *  registry default). Idempotent on repeated writes; bumps
   *  `updated_at` on every set.
   *
   *  Permission gate: paired-client (D-121 instance_id required;
   *  unregistered connections rejected). */
  'mcp.visibility.write': RpcMethodSpec<
    {
      topic: string;
      /** `null` = clear the override + fall back to registry default. */
      policy: 'public' | 'private' | null;
    },
    {
      ok: true;
      /** Effective policy after the write — override when set, registry
       *  default otherwise. UI uses this to confirm the new state without
       *  a follow-up read. */
      effective_policy: 'public' | 'private';
    }
  >;

  // ── Settings → Contract grants (grant-foundation slice 3) ───────
  //
  // The unified `(contract × grant)` matrix surface (D-187 amendment
  // `693b7d03`). Read/write a contract's grant ENTRIES — `<operation_id>`
  // (op admission) | `data.<collection>` (collection read) | `enrichment.<topic>`
  // (topic read), one consolidated namespace. The two D-174 R22 transpose UIs
  // read this: `read` = a contract's row, `read_by_entry` = an entry's column.
  // `contract.grant.*` is MCP-reserved (channel isolation) so a contracted agent
  // can never call `write` to widen its own grants — only the owner's paired
  // client configures grants.

  /** Read a contract's UNIFIED grant set (op + collection + topic entries) — the
   *  contract-detail "row". Returns the EXPLICIT stored rows only (entries absent →
   *  the author default applies at the gate); the UI joins with the registry for the
   *  effective view (mirrors `mcp.visibility.read` + `housekeeping.registry.describe`).
   *  Read-only, no permission gate. */
  'contract.grant.read': RpcMethodSpec<
    { contract_id: string },
    {
      grants: ReadonlyArray<{
        entry_key: string;
        granted: boolean;
        set_at: number;
      }>;
    }
  >;

  /** The TRANSPOSE read — which contracts hold a given grant entry (the topic/op-detail
   *  "column"). A whole-scope filtered scan (an owner-surface read, not a gate hot
   *  path). Read-only. */
  'contract.grant.read_by_entry': RpcMethodSpec<
    { entry_key: string },
    {
      contracts: ReadonlyArray<{
        contract_id: string;
        granted: boolean;
        set_at: number;
      }>;
    }
  >;

  /** Grant / revoke / clear one entry for a contract. `granted: true` grants,
   *  `false` records an explicit REVOKE (survives the boot reconcile), `null` clears
   *  the row (revert to the author default). Idempotent.
   *
   *  Permission gate: paired-client (D-121); `contract.grant.*` is MCP-reserved so a
   *  contracted agent can never widen its own grants. */
  'contract.grant.write': RpcMethodSpec<
    {
      contract_id: string;
      entry_key: string;
      /** `null` = clear the row (revert to the author default). */
      granted: boolean | null;
    },
    {
      ok: true;
      /** Stored state after the write — `true`/`false` when set, `null` when cleared.
       *  The effective (author-default-applied) value is a read/gate concern. */
      granted: boolean | null;
    }
  >;

  // ── Settings → Notifications (D-163 Slice C) ────────────────────
  //
  // Settings → Notifications surface. The `@recued/notification` block
  // owns the underlying settings record + readiness probe; these three
  // rpcs are the thin wire surface for the webclient panel. Per spec
  // § N.6 the panel renders one row per channel (5 today: ui / bridge /
  // slack / telegram / email) with a capability badge + readiness state
  // + per-row install/connect CTA when `ready === false`.
  //
  // Per-pair only; the namespace is in `MCP_RESERVED_RPC_PREFIXES`
  // (channel-isolation) so MCP-channel agents cannot mutate user
  // notification policy. Gated on `notificationsDeps` presence so dbless
  // harnesses surface `not_configured`.
  //
  // The three result discriminators (`ui_fixed` / `not_ready` /
  // `too_long`) are expected user-flow branches, NOT error throws — the
  // Settings UI renders them inline (route to install CTA / re-prompt
  // for shorter phrase / etc.). The handler returns them as typed
  // shapes; only `bad_request` / `not_configured` reach the rpc error
  // channel.

  /** D-163 N.6 / A.5 — render model for the Settings → Notifications
   *  panel. One `NotificationChannelToggleView` per channel in fixed
   *  order (`ui` first, then `bridge`, then the credential-backed remote
   *  channels). The render model is computed at read time from the
   *  per-pair `NotificationSettings` record + the injected
   *  `ChannelReadinessProbe`. */
  'notifications.describe': RpcMethodSpec<
    void,
    {
      rows: ReadonlyArray<
        import('../notifications.js').NotificationChannelToggleView
      >;
      /** R31 — the current anti-phishing verification phrase (D-158
       *  P2b-ii), so the panel can render + edit it as a panel-level
       *  setting alongside the channel matrix. Absent when none is set. */
      verification_phrase?: string;
    }
  >;

  /** D-163 N.5 — toggle one channel. `ui` is fixed-on (returns
   *  `ok: false, reason: 'ui_fixed'` — the panel marks the ui row
   *  non-interactive so reaching this branch is defense-in-depth).
   *  Enabling a togglable channel whose readiness backing is absent is
   *  refused with `ok: false, reason: 'not_ready'` so the panel can
   *  route to the install / connect CTA. Disabling is never readiness-
   *  gated. */
  'notifications.set_channel': RpcMethodSpec<
    {
      channel: import('../notifications.js').NotificationChannelName;
      /** R31 — an axis patch (was a single `enabled` boolean). Toggle the
       *  notification and / or approval axis; an absent field preserves
       *  its prior value. An approval patch on a notify-only channel is
       *  refused (`approval_unsupported`). */
      patch: Partial<import('../notifications.js').NotificationChannelModeRow>;
    },
    import('../notifications.js').NotificationSetChannelResult
  >;

  /** D-158 P2b-ii — set or clear the anti-phishing verification phrase
   *  rendered on the email ask landing page. A non-empty trimmed string
   *  sets it; `null` / empty / whitespace-only clears it. An over-length
   *  phrase is refused (`ok: false, reason: 'too_long', max`) so the
   *  Settings UI can cap its input. */
  'notifications.set_verification_phrase': RpcMethodSpec<
    { phrase: string | null },
    import('../notifications.js').NotificationSetVerificationPhraseResult
  >;

  /** D-169 P1 — per-bridge sub-row render model for the Settings →
   *  Notifications page. One row per paired bridge in pair-time order;
   *  returns `[]` when no bridges are paired (or the server isn't wired
   *  with a bridge roster probe). Independent of `notifications.describe`,
   *  which still returns the channel-level toggle (the channel-level
   *  bridge toggle plus the per-bridge sub-rows render together).
   *
   *  Per-pair only; reserved for local-UI (`notifications.` prefix is in
   *  `MCP_RESERVED_RPC_PREFIXES`). An MCP-channel agent must never read /
   *  write per-bridge mode flags (channel-isolation). */
  'notifications.describe_bridges': RpcMethodSpec<
    void,
    {
      rows: ReadonlyArray<import('../notifications.js').NotificationBridgeRow>;
    }
  >;

  /** D-169 P1 — toggle one mode flag (notification + / or approval) on
   *  one paired bridge. `bridge_id` is the durable
   *  `client_tokens.token_id`. An unknown id surfaces
   *  `ok: false, reason: 'bridge_unknown'` so the Settings UI refreshes
   *  its row list (likely an unpair just happened in another tab).
   *  Disabling is never gated; enabling is not readiness-gated past
   *  "bridge exists" (the bridge channel's overall readiness is the
   *  channel-level toggle's gate, D-163 N.5). */
  'notifications.set_bridge_mode': RpcMethodSpec<
    {
      bridge_id: string;
      /** Partial patch — absent fields preserve prior value. */
      patch: Partial<import('../notifications.js').NotificationBridgeModeRow>;
    },
    import('../notifications.js').NotificationSetBridgeModeResult
  >;

  /** D-169 P2 Slice 4 — the CALLER's OWN bridge mode flags, keyed on the
   *  authenticated `WsClient.client_token_id` (no arg — a client can only
   *  ask about itself; the server never trusts a client-supplied id).
   *  Returns `{ modes: null }` when the caller is not a recognised paired
   *  bridge (the webclient, or a token with no bridge row). The bridge
   *  side panel reads this on mount + each periodic refresh to gate its
   *  approval-card rendering on THIS bridge's approval mode (interactive
   *  when ON, read-only when OFF — the Slice 4 client-side gate). Per-pair,
   *  reserved local-UI (`notifications.` prefix is in
   *  `MCP_RESERVED_RPC_PREFIXES`) — an MCP-channel agent must never read a
   *  bridge's mode flags (channel-isolation); the server filters the
   *  roster to the caller's own row so no bridge ever sees another's
   *  modes. */
  'notifications.my_bridge_mode': RpcMethodSpec<
    void,
    {
      modes: import('../notifications.js').NotificationBridgeModeRow | null;
    }
  >;

  // ── Packs (D-145 PA10 follow-on) ────────────────────────────────
  //
  // Atomic bulk-pack install rpc. Accepts a raw `BulkPackManifest` +
  // the set of permissions the user explicitly approved in the Settings
  // → Packs install dialog. The handler parses + validates the manifest,
  // resolves each `recipes[]` entry against the per-pair `RecipeStore`
  // (memory override → SQLite → bundled), and hands the resolved input
  // to `installBulkPackOnServer` — the same engine path foundation
  // packs use at boot.
  //
  // Per-pair only; `packs.` is in `MCP_RESERVED_RPC_PREFIXES`
  // (channel-isolation). A pack install transaction commits recipes +
  // body-content MCP grants in one
  // atomic step — an MCP-channel mutator would let a compromised agent
  // land body-content grants the
  // user never approved, or upsert arbitrary recipes. The Settings UI
  // surfaces `manifest.requires` to the user; the rpc adds
  // `BULK_PACK_INSTALL_PERMISSION` to the granted set automatically
  // (the rpc invocation itself is the install-action consent signal,
  // matching the foundation-pack pre-install path).
  //
  // The handler gates on `packInstallDeps.recipeStore` presence so
  // dbless harnesses surface `not_configured`.
  //
  // The result is the engine's `BulkPackInstallResult` object — `ok: false`
  // paths (`permission_denied` / `version_mismatch` / `unresolved` /
  // `validator_rejected` / `unexpected`) return on the rpc result body,
  // not the error channel; the Settings UI renders each `failure.code`
  // with targeted copy. Only manifest-validator failures + arg-shape
  // problems reach the rpc error channel as `bad_request`.
  /** D-145 PA10 follow-on — install a bulk pack from a raw manifest.
   *  `manifest` is the unparsed JSON the install dialog accepted; the
   *  handler runs `parseBulkPackManifest` against it (errors surface
   *  as `bad_request` with the first issue's path + message).
   *  `granted_permissions` is the closed-list set the user approved in
   *  the dialog — typically equal to `manifest.requires` (the engine
   *  rejects with `permission_denied` if a required entry is missing).
   *  Returns the engine's `BulkPackInstallResult` as the rpc result so
   *  the Settings UI can render targeted failure copy per
   *  `failure.code`. */
  'packs.install': RpcMethodSpec<
    {
      manifest: unknown;
      granted_permissions: ReadonlyArray<string>;
      /** D-182 §7.1 — the install grant dialog's selection (Access × Scope)
       *  for a composition the pack carries by value. Present ⇒ grant the
       *  selected access-tier operation groups on the composition's bound
       *  connection (PLUS its authored read/`approval: ask` defaults). ABSENT
       *  ⇒ fail closed: grant ONLY the authored read/`approval: ask` defaults
       *  (the silent derived read-tier auto-grant is removed). Recipe-only
       *  packs (no composition) ignore it. */
      install_scope?: import('../bulk-pack.js').InstallGrantSelection;
      /** D-194 2b — the connection the owner picked in the install dialog's
       *  "Connect account" section (an existing endpoint-match candidate, or a
       *  freshly-enrolled connection's name). Present ⇒ the composition's grant +
       *  catalog binding bind to THIS connection instead of the authored
       *  `auth.connection` literal (`reSourceGrantConnection`, step 3a). ABSENT ⇒
       *  the authored literal (back-compat) — connect is optional, so a pack
       *  installs unconnected and stays deny-until-granted until the owner
       *  connects later. Recipe-only packs (no composition) ignore it. */
      chosen_connection?: string;
      /** D-201 Slice 4 — explicit owner ingress choices. `pack_slug` scopes
       * selections for transitive dependency installs; the manifest cannot
       * provide or override this array. */
      webhook_bindings?: ReadonlyArray<{
        pack_slug: string;
        binding: string;
        ingress_id: string;
      }>;
      /** D-221 — review anchor returned by packs.list for a Records update. */
      expected_manifest_hash?: string;
    },
    {
      result: import('../bulk-pack.js').BulkPackInstallResultLike;
    }
  >;

  /** Install seam 5c — install a marketplace pack BY SLUG. The server
   *  fetches the manifest from the apex install artifact
   *  `<domain>/packs/<slug>.json` (the CDN-cached, KV-mirrored static file — not
   *  the raw DB worker) and resolves each constituent recipe the same way (from
   *  `<domain>/recipes/<slug>.json`; the by-value `packs.install` resolves
   *  recipes bundled-on-disk only). Both entry points —
   *  the apex `#packs/<slug>` detail/consent handoff and in-app Discover flow —
   *  need this primitive; bundled / foundation packs keep using `packs.install`.
   *
   *  The marketplace-fetched manifest is authoritative (its `publisher` stamps
   *  every installed recipe's `publisher_id` → vault scope), which is why the
   *  marketplace recipe resolver is injected only on THIS path and never on the
   *  by-value path (where a user-supplied manifest's publisher is untrusted).
   *
   *  Returns the engine's `BulkPackInstallResult` on the result body exactly
   *  like `packs.install`; a marketplace 404 / fetch / validation / version
   *  problem surfaces as an `ok: false` failure (`unresolved` / `unexpected` /
   *  `validator_rejected` / `version_mismatch`) so the install dialog renders
   *  targeted copy. Only arg-shape problems reach the rpc error channel as
   *  `bad_request`. Same `packs.` reserved-prefix gate as `packs.install`. */
  'packs.installBySlug': RpcMethodSpec<
    {
      slug: string;
      granted_permissions: ReadonlyArray<string>;
      /** Install seam 5c — forwarded verbatim to `packs.install`'s grant
       *  handling. See `packs.install`'s `install_scope` doc. */
      install_scope?: import('../bulk-pack.js').InstallGrantSelection;
      /** D-194 2b — forwarded verbatim to `packs.install`. See `packs.install`'s
       *  `chosen_connection` doc. */
      chosen_connection?: string;
      /** D-201 Slice 4 — forwarded to the trusted by-value install path. */
      webhook_bindings?: ReadonlyArray<{
        pack_slug: string;
        binding: string;
        ingress_id: string;
      }>;
      /** D-211 audit — hash returned by `packs.resolveBySlug` for the exact
       * marketplace manifest the owner reviewed. Required for an update. */
      expected_manifest_hash?: string;
    },
    {
      result: import('../bulk-pack.js').BulkPackInstallResultLike;
    }
  >;

  /** Add-a-pack (2026-07-01) — manifest-only preview for the install consent
   *  dialog: fetch a marketplace pack's manifest by slug WITHOUT installing, so
   *  the webclient's "Add a pack" flow can render the same consent surface
   *  (recipes / permissions / body-grants / grant picker) it shows for bundled
   *  packs before the owner commits. On confirm the flow calls the trusted
   *  `packs.installBySlug`. Server-fetch (same fixed marketplace host as
   *  `installBySlug`) preserves the marketplace-authoritative trust model — the
   *  webclient never fetches or trusts the manifest itself. Same `packs.`
   *  reserved-prefix gate as the other pack rpcs. `manifest` is null on any
   *  failure (see `PacksResolveResult.failure`). A successful preview also
   *  returns `manifest_review_hash`, which the update path must echo. */
  'packs.resolveBySlug': RpcMethodSpec<
    { slug: string },
    import('../bulk-pack.js').PacksResolveResult
  >;

  /** D-145 PA10 follow-on — list bundled packs the server can offer for
   *  install + their installed state. Reads `community/packs/*.json`
   *  off disk, drops manifests that fail validation (so the panel never
   *  surfaces an un-installable row), and joins each with the per-pair
   *  `RecipeStore` to compute `installed` (true iff every entry in
   *  `manifest.recipes` has a stored recipe row at the manifest's
   *  pinned version whose `pack_slug` names this pack — vendor twin
   *  packs share recipe slugs, so only the twin that currently owns
   *  the binding reports installed). No args — the panel
   *  re-fetches after every install. Per-pair only; `packs.` is in
   *  `MCP_RESERVED_RPC_PREFIXES` so MCP-channel agents cannot enumerate
   *  the pack catalog (read-only enumeration is low-risk, but the
   *  uniform private-prefix discipline keeps the `packs.*` surface a
   *  Settings-UI-only namespace). The forwarded `manifest` lets the
   *  install dialog call `packs.install` without a second `packs.fetch`
   *  round-trip. */
  'packs.list': RpcMethodSpec<
    void,
    import('../bulk-pack.js').PacksListResult
  >;

  /** D-145 PA10 follow-on Slice B — uninstall a bundled pack. Drops every
   *  pack-installed Standing Instruction row whose id starts with
   *  `<pack_slug>:` via `siStore.uninstallPack`, then deletes each
   *  recipe the bundled manifest references from the per-pair
   *  `RecipeStore`. Recipes that pre-existed the install (or have
   *  already been removed by another tab / housekeeping) silently
   *  no-op via `store.delete`'s false return. Body-content grants are
   *  forward-compat — today's server bin does not wire the body-grants
   *  substrate, so the result always reports `removed.body_grants = []`.
   *
   *  Single-argument rpc by design: re-reads the bundled manifest from
   *  `community/packs/<pack_slug>.json` at uninstall time so the
   *  reference list of recipe_ids + SI prefix stays anchored to the
   *  server's view of "what this pack contains" rather than a stale
   *  client-cached manifest. Drift between the bundled manifest at
   *  install time vs uninstall time is a known v1 limitation (the
   *  recipe_ids enumeration leaves orphans when the bundled manifest
   *  changed shape post-install; SI rows are robust because
   *  `uninstallPack` drops by prefix regardless of current manifest
   *  shape).
   *
   *  Channel-isolation invariant: same `packs.` reserved-prefix gate as
   *  `packs.install` + `packs.list`. The D-138 ratchet test already
   *  asserts the prefix; adding `packs.uninstall` inherits the gate
   *  without a ratchet bump. */
  'packs.uninstall': RpcMethodSpec<
    {
      pack_slug: string;
      /** D-221 full-ref disambiguator. Required when same-slug Records packs
       * from multiple publishers are retained/installed. */
      publisher?: string;
      /** Records data lifecycle; omitted means retain/orphan. */
      records_disposition?: 'retain' | 'export' | 'purge';
      expected_records_state_generation?: number;
      /** Exact `<publisher>/<pack_slug>` phrase required for purge. */
      records_purge_confirmation?: string;
    },
    {
      result: import('../bulk-pack.js').BulkPackUninstallResultLike;
    }
  >;

  // ── D-170 — Ingredient-authoring install / uninstall ─────────────
  //
  // The install-integration core (N.14 / N.15 / N.16): the direct-manifest
  // install path. `ingredient.install` takes a `CompositionIngredient` body
  // (bare 1×1 / wide composition) or an app_pack carrying a `composition`
  // content by value; the server validates (decompose + reuse the D-165
  // validators), persists the decomposed catalog + entity-schema bodies to the
  // local manifest store, records `installed_pack` / `installed_ingredient`
  // inventory, and registers the catalog into the live manifest registry so the
  // gateway resolves its operations (N.16). `ingredient.uninstall` reverses it
  // refcount-aware, with an `ingredient_pins` dependency guard (N.14 — new, not
  // inherited from the refcount-only pack uninstall).
  //
  // Per-pair only; `ingredient.` is in `MCP_RESERVED_RPC_PREFIXES`
  // (channel-isolation). Authoring installs a callable capability — an
  // MCP-channel agent must never author / install / uninstall its own
  // capability surface (operations, risk, approval, audit, entity schemas).
  // Settings / Kitchen UI is the sole writer.
  /** D-170 — install a locally-authored composition (or app_pack carrying one)
   *  directly. Validate → decompose → persist bodies + inventory + register for
   *  gateway resolution. Returns a typed `IngredientInstallResult` on the result
   *  body (`ok: false` carries decompose-validate issues); only arg-shape
   *  problems reach the rpc error channel as `bad_request`. */
  'ingredient.install': RpcMethodSpec<
    import('../ingredient-authoring-rpc.js').IngredientInstallArgs,
    import('../ingredient-authoring-rpc.js').IngredientInstallResult
  >;

  /** D-170 — uninstall a locally-authored pack (refcount-aware) or standalone
   *  1×1 ingredient. The `ingredient_pins` guard blocks when an installed recipe
   *  still references a child being removed (override with `force: true`).
   *  Returns a typed `IngredientUninstallResult`; only arg-shape problems reach
   *  the rpc error channel as `bad_request`. */
  'ingredient.uninstall': RpcMethodSpec<
    import('../ingredient-authoring-rpc.js').IngredientUninstallArgs,
    import('../ingredient-authoring-rpc.js').IngredientUninstallResult
  >;

  // D-170 N.4 / N.15 / #2 — the authoring side that precedes install: a
  // per-pair draft store for in-progress compositions + test-before-save
  // preview/decompose.
  // `ingredient.draft.{save,list,get,delete}` persist a (possibly incomplete)
  // `CompositionIngredient`; `ingredient.preview` runs ONE operation through
  // the real gateway connection adapter — a `read` executes (bounded +
  // redacted), every mutation is shown as a redacted request plan and NEVER
  // executed (the safety invariant). Same `ingredient.` reserved-prefix
  // channel-isolation as install.
  /** D-170 — save (create or overwrite) an in-progress composition draft. */
  'ingredient.draft.save': RpcMethodSpec<
    import('../ingredient-authoring-rpc.js').IngredientDraftSaveArgs,
    import('../ingredient-authoring-rpc.js').IngredientDraftSaveResult
  >;

  /** D-170 — list draft summaries (no bodies). */
  'ingredient.draft.list': RpcMethodSpec<
    void,
    import('../ingredient-authoring-rpc.js').IngredientDraftListResult
  >;

  /** D-170 — fetch one draft (full body) by id. */
  'ingredient.draft.get': RpcMethodSpec<
    import('../ingredient-authoring-rpc.js').IngredientDraftGetArgs,
    import('../ingredient-authoring-rpc.js').IngredientDraftGetResult
  >;

  /** D-170 — delete a draft by id. */
  'ingredient.draft.delete': RpcMethodSpec<
    import('../ingredient-authoring-rpc.js').IngredientDraftDeleteArgs,
    import('../ingredient-authoring-rpc.js').IngredientDraftDeleteResult
  >;

  /** D-170 #2 — validate + decompose one composition draft and return the
   *  compiled artifacts plus the review projection shown before install. */
  'ingredient.compose.decompose': RpcMethodSpec<
    import('../ingredient-authoring-rpc.js').CompositionDecomposeArgs,
    import('../ingredient-authoring-rpc.js').CompositionDecomposeResult
  >;

  /** D-170 #4 — validate + decompose one composition draft and persist the
   *  compiled local manifest body through the local manifest store. This is the
   *  local publish half only; marketplace `pack.publish` remains separate. */
  'ingredient.saveAsNew': RpcMethodSpec<
    import('../ingredient-authoring-rpc.js').IngredientSaveAsNewArgs,
    import('../ingredient-authoring-rpc.js').IngredientSaveAsNewResult
  >;

  /** D-170 — preview one operation of a draft through the real connection
   *  adapter (N.4 test-before-save). Reads execute; mutations never do. */
  'ingredient.preview': RpcMethodSpec<
    import('../ingredient-authoring-rpc.js').IngredientPreviewArgs,
    import('../ingredient-authoring-rpc.js').IngredientPreviewResult
  >;

  // ── Settings → Work Entities (D-145 PA11) ───────────────────────
  //
  // Per-kind Source list + enable/disable + mcp_exposed toggle +
  // default-Source pin/clear. Backs `apps/webclient/.../settings/
  // work-entities/` panel rendered via `packages/ui-shared/src/
  // server-settings/work-entities/`. Read consolidates the per-pair
  // Source rows + per-kind defaults so the panel can render the full
  // UI without N+1 round-trips. Writes are column-scoped (one toggle
  // per call) so concurrent writes against the same Source row don't
  // clobber unrelated columns.
  /** D-145 PA11 — read every registered Source + per-kind default in
   *  one round-trip. Drives the Settings panel render; the
   *  `defaults_by_kind` map is the per-kind `prefs.<kind>.last_used_source_id`
   *  surface for the four work-entity kinds. */
  'work_entity.source.list': RpcMethodSpec<
    void,
    {
      sources: ReadonlyArray<import('../source-primitive.js').SourceRegistration>;
      defaults_by_kind: Readonly<
        Partial<
          Record<
            import('../work-entities.js').WorkEntityKind,
            string
          >
        >
      >;
    }
  >;
  /** D-145 PA11 — flip the user-driven enable/disable toggle on one
   *  Source. Returns the post-write Source row so the UI can update
   *  state without a follow-up read. */
  'work_entity.source.set_enabled': RpcMethodSpec<
    { source_id: string; enabled: boolean },
    {
      ok: true;
      effective: import('../source-primitive.js').SourceRegistration;
    }
  >;
  /** D-145 PA11 — flip the per-Source MCP exposure boolean. Layers
   *  underneath the per-(bound contract, topic) read-visibility override
   *  (`contract.enrichment.*`, D-187) at MCP read time. */
  'work_entity.source.set_mcp_exposed': RpcMethodSpec<
    { source_id: string; mcp_exposed: boolean },
    {
      ok: true;
      effective: import('../source-primitive.js').SourceRegistration;
    }
  >;
  /** D-145 PA11 — pin a per-kind default Source. Validates the Source
   *  is registered + matches the kind via the underlying store. */
  'work_entity.source.set_default': RpcMethodSpec<
    {
      kind: import('../work-entities.js').WorkEntityKind;
      source_id: string;
    },
    { ok: true }
  >;
  /** D-145 PA11 — drop the per-kind default. Returns `cleared: true`
   *  when a row was removed; `false` when nothing was pinned. */
  'work_entity.source.clear_default': RpcMethodSpec<
    { kind: import('../work-entities.js').WorkEntityKind },
    { ok: true; cleared: boolean }
  >;

  // ── Work-entity warehouse CRUD (D-174 #22 — Data route) ─────────
  //
  // Local-UI / paired-client entity CRUD over the four own-it kinds
  // (task / note / commitment / project) for the webclient Data
  // surface (D-174 D11). Mirrors the `contact.*` warehouse-CRUD family
  // exactly: registered-client gated (the WS-rpc channel is bearer-
  // authed; MCP-channel agents are on a separate server + reach work-
  // entity writes ONLY through the gateway-gated ingredient catalog),
  // and DELIBERATELY NOT in `MCP_RESERVED_RPC_PREFIXES` — matching the
  // base `contact.*` + sibling `work_entity.source.*` treatment, which
  // are likewise unreserved (the MCP catalog is a closed `recued_*`
  // allowlist; a `work_entity.*` method name can never enter it, so the
  // reserved-prefix ratchet is belt-and-suspenders the base families
  // don't need). Writes route through `createWorkEntityDispatchers` so
  // every upsert/delete fans `emitWorkEntityEvent` (reactive/trigger
  // semantics hold) — the SAME path the ingredient channel uses.
  /** D-174 #22 — list one own-it kind, polymorphic across its Sources
   *  (or scoped via `source_id`). Returns tagged records + a filter-
   *  matched total for pagination. */
  'work_entity.list': RpcMethodSpec<
    WorkEntityListRpcRequest,
    WorkEntityListRpcResponse
  >;
  /** D-174 #22 — read one entity by `(kind, id)`; `null` when no
   *  live/stale row exists. */
  'work_entity.get': RpcMethodSpec<
    WorkEntityGetRpcRequest,
    WorkEntityGetRpcResponse
  >;
  /** D-174 #22 — create (no `id`) or update (`id` present) one entity.
   *  Routes by `(kind, id-presence)` to the matching create/update
   *  dispatcher; the write emits the canonical warehouse event. */
  'work_entity.upsert': RpcMethodSpec<
    WorkEntityUpsertRpcRequest,
    WorkEntityUpsertRpcResponse
  >;
  /** D-174 #22 — delete one entity by `(kind, id)`; default tombstone.
   *  Emits a `deleted` warehouse event through the dispatcher path. */
  'work_entity.delete': RpcMethodSpec<
    WorkEntityDeleteRpcRequest,
    WorkEntityDeleteRpcResponse
  >;

  // ── Accepted intake responses (owner Data browser) ─────────────
  // Immutable summary-list + full-detail reads over the canonical
  // `form_response` store.
  // The handler requires a registered paired client and the namespace is
  // reserved out of MCP: visitor-authored values can contain arbitrary PII.
  'form_response.list': RpcMethodSpec<
    FormResponseListQuery,
    FormResponseListRpcResponse
  >;
  'form_response.get': RpcMethodSpec<
    FormResponseGetRpcRequest,
    FormResponseGetRpcResponse
  >;
  // D-210 A.8 slice 2 — the lifecycle WRITE. Same reservation as its siblings:
  // owner pair-rpc only, out of MCP. A door that could move a visitor's state
  // could decline an applicant.
  'form_response.set_state': RpcMethodSpec<
    FormResponseSetStateRpcRequest,
    FormResponseSetStateRpcResponse
  >;
  'form_response.update': RpcMethodSpec<
    FormResponseUpdateRpcRequest,
    FormResponseUpdateRpcResponse
  >;
  'form_response.export': RpcMethodSpec<
    FormResponseExportRpcRequest,
    FormResponseExportRpcResponse
  >;

  // ── Pack-owned Records owner control plane (D-221) ──────────────
  // Registered-pair only and structurally excluded from MCP. This is the
  // sole read path used by #data; Records deliberately has no `data.*` REF.
  'records.namespace.list': RpcMethodSpec<
    void,
    { namespaces: RecordsNamespaceView[]; global_quota: RecordsGlobalQuotaSnapshot }
  >;
  'records.kind.list': RpcMethodSpec<{ owner: RecordsPackRef }, { kinds: RecordsKindSummary[] }>;
  'records.search': RpcMethodSpec<RecordsOwnerSearchRequest, RecordsSearchResult>;
  'records.get': RpcMethodSpec<RecordsOwnerGetRequest, RecordsOwnerGetResponse>;
  'records.delete': RpcMethodSpec<
    RecordsOwnerDeleteRequest,
    { deleted: true; id: string; revision: number }
  >;
  'records.quota.set': RpcMethodSpec<RecordsQuotaSetRequest, RecordsQuotaSnapshot>;
  'records.quota.set_global': RpcMethodSpec<
    RecordsGlobalQuotaSetRequest,
    RecordsGlobalQuotaSnapshot
  >;
  'records.retention.list': RpcMethodSpec<
    { owner: RecordsPackRef },
    { policies: Record<string, RecordsRetentionPolicy> }
  >;
  'records.retention.set': RpcMethodSpec<RecordsRetentionSetRequest, { ok: true }>;
  'records.retention.run': RpcMethodSpec<
    RecordsRetentionRunRequest,
    { deleted: number; blocked: string[] }
  >;
  'records.export': RpcMethodSpec<RecordsExportRequest, RecordsExportResponse>;
  'records.outbox.list': RpcMethodSpec<RecordsOutboxListRequest, RecordsOutboxOverview>;
  'records.outbox.retire': RpcMethodSpec<RecordsOutboxRetireRequest, { retired: boolean }>;
  'records.purge': RpcMethodSpec<RecordsPurgeRequest, { rows_deleted: number; events_deleted: number }>;
  'records.accounting.audit': RpcMethodSpec<
    { owner: RecordsPackRef },
    { coherent: boolean; expected_rows: number; expected_bytes: number; expected_outbox: number }
  >;
  'records.accounting.repair': RpcMethodSpec<
    { owner: RecordsPackRef },
    RecordsNamespaceView
  >;

  // ── data.timeline read pair-RPC (D-174 #22 — mirror-it drill-down) ─
  //
  // Third isolated channel for the `data.timeline()` primitive,
  // alongside the MCP tool (`recued_dataTimeline`) + the recipe kernel
  // (`timeline-read`): same SELECT, same storage, separate dispatcher;
  // no rpc-envelope / audit-hook collision (the channel-isolation
  // invariant `timeline-recipe-handler.ts` describes). Read-only. The
  // paired-client channel leaves `gateMcpPrivate` OFF — local-UI sees
  // private rows by construction (mirrors the recipe-channel paired-
  // client path); the MCP channel keeps its own gated handler so this
  // does NOT double-expose or weaken the MCP privacy gate. Reuses the
  // canonical `TimelineRequest` / `TimelineResponse` wire shapes.
  'data.timeline': RpcMethodSpec<TimelineRequest, TimelineResponse>;

  // ── data.file.read owner read pair-RPC (D-172 Half-A "open") — the
  //    webclient Files tab opens/downloads a `data.file` record's bytes.
  //    Content read is Gateway-gated ONLY for CONTRACTED channels (an AI
  //    exfiltrating bytes, D-172 I-4 / A.8); the OWNER reading their own file
  //    over the bearer-gated paired WS is not egress, so this mirrors the
  //    `data.timeline` owner-trusted pattern (registered-client boundary, no
  //    contract/egress gate). Reuses the backend `handleFileRead` verbatim.
  'data.file.read': RpcMethodSpec<
    { record_id: string },
    {
      record_id: string;
      bytes_b64: string;
      mime_type: string;
      filename: string;
      size_bytes: number;
      blob_hash: string;
    }
  >;

  // ── data.mirror.search read pair-RPC (D-174 #22 — feeds the mirror
  //    drill-down's name→entity_id picker). Keyword-searches the local
  //    warehouse mirror collections (mail/calendar/file FTS; crm → empty,
  //    no local store) and returns `data.timeline`-ready entity_ids. The
  //    handler lives in the collection slice (it owns the collection
  //    registry it fans out over); the name stays in the `data.*` read
  //    vocabulary it shares with `data.timeline`. Read-only, pair-client. ─
  'data.mirror.search': RpcMethodSpec<MirrorSearchRequest, MirrorSearchResponse>;

  // ── data.contact.engagements read pair-RPC (D-139 P5) ───────────
  //
  // Contact-rooted engagement evidence resolver. Walks the survivor
  // chain + identity-expansion, joins live `data.mail` twins, and
  // returns the FULL `EngagementsResolverRow` shape (body_inline +
  // vendor_raw_timestamp included) to the owner's own paired clients /
  // recipes. External MCP agents reach the same evidence ONLY through
  // the separate `recued_contactEngagementsList` tool, which projects
  // through `projectEngagementRowForMCP` (body stripped by default). The
  // rpc prefix `data.contact.engagements.` is reserved out of the MCP
  // catalog (`MCP_RESERVED_RPC_PREFIXES`) — channel-isolation invariant.
  'data.contact.engagements.list': RpcMethodSpec<
    EngagementsResolverArgs,
    EngagementsResolverResult
  >;

  // ── Bootstrap + status + kill switch (D-103 Phase A) ────────────
  //
  // Bootstrap rpc surfaces the TOML `[bootstrap]` section to the
  // extension. stageBootstrap validates + stores a patch; the server
  // applies it on next restart. requestRestart is a hand-off —
  // supervisor (or the user running the daemon) performs the actual
  // restart.
  'server.getBootstrap': RpcMethodSpec<void, { config: ServerBootstrapView }>;
  'server.stageBootstrap': RpcMethodSpec<
    { patch: Partial<Omit<ServerBootstrapView, 'pending_restart'>> },
    ServerBootstrapStageResult
  >;
  'server.requestRestart': RpcMethodSpec<
    { reason: string },
    { accepted: boolean }
  >;
  'server.getStatus': RpcMethodSpec<void, ServerStatus>;

  // ── Master "Pause server" circuit-breaker (D-188) ───────────────
  //
  // A DISTINCT axis from the kill switch (which is the crash-loop
  // write-halt): pause denies door + owner-AI ops at the op-admission
  // gate + freezes autonomous execution (cron/auto-run/housekeeping/
  // reactive) + closes inbound webhooks, while staying paired-live so
  // the owner can inspect + resume. Owner-only — `server.*` rides the
  // bearer-gated WS and is never MCP-bridged (the catalog is an
  // allowlist), so a contracted agent can never pause/resume the server.
  /** Engage (`{ active: true }`) / release (`{ active: false }`) the
   *  master pause. Audited both ways; `active_since` is the rising-edge
   *  timestamp (null when resumed). */
  'server.setPaused': RpcMethodSpec<
    { active: boolean },
    { ok: true; active_since: number | null }
  >;
  /** Current master-pause state for the pill popover's initial render. */
  'server.getPauseState': RpcMethodSpec<
    void,
    { active: boolean; since?: number }
  >;

  // ── Quality-delegation kill-switch — Switch A/B (D-202 §4) ──────
  //
  // Owner-only (rides the same bearer-gated `server.*` WS, never
  // MCP-bridged, so a contracted agent can never touch it). A
  // GATE-OVERRIDE: pausing suppresses the quality (Switch B) — or, for
  // Switch A, the authorization AND quality — delegation at the gate
  // WITHOUT touching learner state, so it is instantly + losslessly
  // reversible (§12.12). Distinct from the D-188 master pause (which
  // freezes ALL autonomous execution); this only removes the delegation
  // shortcuts, returning affected sends to manual review.
  /** Engage / release one quality kill-switch (`which: 'all'` = Switch A,
   *  both axes → full manual approve; `which: 'quality'` = Switch B, the
   *  quality axis only → per-artifact review). Returns the full post-write
   *  two-switch status. Audited on a real transition. */
  'server.setQualitySwitch': RpcMethodSpec<
    { which: 'all' | 'quality'; active: boolean },
    QualityGateSwitchStatus
  >;
  /** Current two-switch status for the #contracts control's initial render. */
  'server.getQualitySwitches': RpcMethodSpec<void, QualityGateSwitchStatus>;

  /** D-127 wire-up — public OAuth client config probe. Returns the
   *  per-provider client_id this server is configured with so the
   *  extension can construct the authorize URL via `buildGmailOAuthUrl`
   *  / `buildGraphOAuthUrl` and hand it to
   *  `chrome.identity.launchWebAuthFlow`. The captured `code` then flows
   *  back through `collection.mail.enrollOAuth` /
   *  `collection.calendar.enrollOAuth`, which the server exchanges
   *  using its own client_secret (kept server-side).
   *
   *  `null` for a provider means no OAuth app is stored for its issuer on
   *  this server (`server.setOAuthAppConfig` — Connections → Mail /
   *  Calendar) — the extension surfaces a "configure your server first"
   *  hint instead of opening the OAuth popup. This used to also read a
   *  `RECUED_{GMAIL,GCAL,GRAPH}_CLIENT_ID` env fallback; those six vars
   *  were deleted 2026-07-28, so the encrypted store is the only source.
   *  Gmail + Gcal share the Google project's client but we expose them
   *  independently so a server can configure inbound-only (gcal but no
   *  gmail) without conflating the two. */
  'server.getOAuthClientConfig': RpcMethodSpec<
    void,
    {
      gmail: { client_id: string } | null;
      gcal: { client_id: string } | null;
      graph: { client_id: string } | null;
    }
  >;

  // ── BYO OAuth app credentials (UI-entered, per-issuer) ──────────
  //
  // Lets the owner enter their own Google / Microsoft OAuth app
  // client_id + client_secret in the UI instead of `RECUED_*` env vars
  // (stored encrypted server-side; env stays a fallback). `google`
  // covers gmail + gcal; `microsoft` covers graph mail + calendar. The
  // existing `getOAuthClientConfig` above keeps serving the per-provider
  // client_ids for the authorize flow (now store-backed).

  /** Per-issuer status for the setup UI. NEVER returns the client_secret
   *  (write-only) — only `has_secret` + `client_id` + `source`. */
  'server.getOAuthAppConfig': RpcMethodSpec<void, OAuthAppConfigSnapshot>;

  /** Store (or overwrite) an issuer's BYO client_id + client_secret. The
   *  secret is encrypted at rest; a locked server rejects the write. */
  'server.setOAuthAppConfig': RpcMethodSpec<SetOAuthAppConfigArgs, { ok: true }>;

  /** Remove an issuer's stored config — the effective config reverts to
   *  the `RECUED_*` env var if one is set. */
  'server.clearOAuthAppConfig': RpcMethodSpec<ClearOAuthAppConfigArgs, { ok: true }>;

  // ── Pressure admin (Phase B) ────────────────────────────────────
  //
  // Two admin actions under the existing `server.*` cluster. Reads
  // piggyback on `server.getStatus` + heartbeat envelope.
  /** Force a reclaim attempt on a surface. Rate-limited (1 per surface
   *  per `cascade.debounce_window_s`); `force: true` bypasses the
   *  debounce but still respects in-flight coalescing. */
  'server.runPressureReclaim': RpcMethodSpec<
    { surface: string; force?: boolean },
    ServerPressureReclaimResult
  >;
  /** Resume a manually-halted gate. Kill-switch-driven halts (the
   *  crash-loop write-halt) are released via `server.resetCrashLoop`;
   *  this method covers the programmatic-halt case only. */
  'server.setPressureOverride': RpcMethodSpec<
    { surface: string; resume: boolean },
    { ok: true }
  >;

  // ── Lifecycle (D-105 Phase C) ──────────────────────────────────
  //
  // `server.requestRestart` (declared above) is rewired by Phase C to
  // trigger a real drain + supervisor handoff. The three methods
  // below are new: shutdown without restart, live state read, and
  // crash-loop reset. All four compose as one `makeLifecycleHandlers`
  // slice on the existing `composeHandlers` shape.
  /** Begin a graceful drain + exit. Intent=shutdown, so the supervisor
   *  won't respawn (exit 0). `drain_timeout_s` overrides the
   *  configured default for this call only. Idempotent — a second
   *  call while draining returns `{ accepted: false }`. */
  'server.requestShutdown': RpcMethodSpec<
    { reason: string; drain_timeout_s?: number },
    { accepted: boolean }
  >;
  /** Live snapshot of lifecycle state — state, uptime, counters, and
   *  drain progress if one is running. Cheap; reads in-memory state
   *  plus two server_state rows. Remains reachable during `booting`
   *  + `draining` via the dispatcher allowlist. */
  'server.getLifecycleState': RpcMethodSpec<void, LifecycleStatus>;
  /** Admin: clear crash-loop counters and release the kill switch iff
   *  its reason was `crash_loop`. No-op when there's nothing to
   *  clear; still returns `ok: true` with all cleared flags false. */
  'server.resetCrashLoop': RpcMethodSpec<
    void,
    {
      ok: true;
      cleared: {
        restart_count: boolean;
        last_crash: boolean;
        crash_halt: boolean;
      };
    }
  >;

  // ── Warehouse collections (D-106 Phase D) ──────────────────────
  //
  // Kernel ingredients (`email-list`, `email-search`, `email-get`,
  // `file-list`, `file-get`, `webhook-list`, `webhook-get`)
  // dispatch to these rpc methods. Writes are NOT exposed —
  // `data.{email,file,webhook}.*` are read-only namespaces
  // populated by the server-side collection adapters. The writable
  // sibling is `data.shared.*` via `shared-write` (D-103 Phase A).
  /** List records from `(platform, slug)` with hot-field filters +
   *  `received_at` range + pagination. Returns empty `records` when
   *  the collection is registered but empty; `COLLECTION_NOT_FOUND`
   *  when no adapter matches. */
  'collection.list': RpcMethodSpec<
    CollectionListQuery,
    { records: CollectionRecord[] }
  >;
  /** FTS5 search over `body_inline` for `(platform, slug)`. CAS-stored
   *  records are NOT indexed (documented limit; matches Phase A's
   *  `shared_store`). Rank ordering is FTS5 BM25 — lower is better. */
  'collection.search': RpcMethodSpec<
    CollectionSearchQuery,
    { matches: CollectionSearchMatch[] }
  >;
  /** Fetch one record by `record_id`. Returns `{ record: null }` when
   *  the record doesn't exist — `COLLECTION_NOT_FOUND` is reserved for
   *  the `(platform, slug)` pair being unknown. */
  'collection.get': RpcMethodSpec<
    { platform: CollectionPlatform; slug: string; record_id: string },
    { record: CollectionRecord | null }
  >;
  /** Admin: force a retention pass on `(platform, slug)` outside the
   *  normal cron tick. Runs the same age-based pruner as the cascade
   *  reclaim path, so mail/webhook prune by age and file rejects the
   *  call (`retention_days: 0` leaves nothing to prune). Returns the
   *  number of records removed and the total bytes reclaimed. */
  'collection.runRetention': RpcMethodSpec<
    { platform: CollectionPlatform; slug: string },
    { pruned: number; bytes_freed: number }
  >;
  /** List every collection registered on this server along with its
   *  live health snapshot. Cheap — reads the in-RAM registry + the
   *  per-adapter metrics maintained by each provider. Mirrors the
   *  heartbeat envelope's `collections[]` field so callers that
   *  missed a recent heartbeat can re-fetch on demand. */
  'collection.listEndpoints': RpcMethodSpec<
    void,
    { endpoints: CollectionHealth[] }
  >;
  /** OAuth enrollment bridge for Gmail / Graph mail collections.
   *  The extension captures the auth code from the provider's redirect
   *  (provider → chrome-extension://... or a hosted callback page),
   *  then pushes `{ provider, account_slug, code, redirect_uri }` to
   *  the server. The server exchanges the code for refresh + access
   *  tokens and persists them in `account.{provider}.{account_slug}.*`.
   *  This keeps the server off the public-URL path (per D-106 §OAuth)
   *  and reuses the existing extension OAuth popup flow. */
  'collection.mail.enrollOAuth': RpcMethodSpec<
    {
      provider: 'gmail' | 'graph';
      account_slug: string;
      code: string;
      redirect_uri: string;
    },
    { ok: true; account_key_prefix: string }
  >;

  // D-177 N.12 — `collection.mail.send` is NOT a wire rpc method. Outbound
  // mail is a side-effecting action gated at the one enforcement boundary
  // (the gateway, per the contract's per-entity_action policy). The
  // `recued/mail-send` kernel ingredient is the gated entry point; the
  // server's `handleCollectionMailSend` is the gateway's INTERNAL executor
  // (called by the kernel `mailSend` dispatcher AFTER the gate decides),
  // never reachable over the wire. The typed send-input shape lives with
  // the handler + the `mail-compose` payload builder, not here. Removed
  // from `SERVER_RPC_METHODS` + `makeCollectionHandlers`; the d-177-n12
  // ratchet pins the absence.

  /** D-127 wire-up — IMAP+SMTP enrollment from `imap-form.ts` payload.
   *  Persists the row + stashes the IMAP password (and optional SMTP
   *  password) in the pair-local account store; composition root
   *  hydrates a live `data.mail.<slug>` mirror via `createImapProvider`
   *  on the next `startLive` tick. `send_capable: true` iff the form
   *  supplied an SMTP block. */
  'collection.mail.enrollImap': RpcMethodSpec<
    {
      name: string;
      host: string;
      port: number;
      secure: boolean;
      username: string;
      password: string;
      folders: string[];
      smtp?: {
        host: string;
        port?: number;
        secure?: boolean;
        username?: string;
        password?: string;
        from?: string;
      };
      backfill_days?: number;
      retention_days?: number;
      quota_bytes?: number;
    },
    { slug: string; send_capable: boolean }
  >;

  /** D-127 wire-up — enumerate every enrolled `data.mail.<slug>`
   *  instance with `send_capable` + `account_email` surfaced for the
   *  picker / `data.mail.send_capable_instances` resolver. Cheap —
   *  reads from the instance store + the account store's
   *  granted-scope key. Drives the email connection enrollment
   *  dialog's `sender_mail_instance` picker. */
  'collection.mail.list': RpcMethodSpec<
    void,
    {
      instances: Array<
        CollectionInstanceRow & {
          send_capable: boolean;
          account_email: string;
        }
      >;
    }
  >;

  /** D-127 wire-up — drop a `data.mail.<slug>` row + wipe the
   *  associated credentials. Compose root closes the live provider
   *  via `onDeleted`. */
  'collection.mail.delete': RpcMethodSpec<{ slug: string }, { ok: true }>;

  // ── Phase G (D-109) additions ───────────────────────────────────

  // D-120 Phase 7 — unified memory export (per-recipe / local-full /
  // server-full). Paired RPCs: `estimate` populates the dialog's live
  // count + size preview before the user commits; `page` streams the
  // export one page at a time. The first page carries the envelope;
  // subsequent pages omit it. Same wire format on extension and server
  // — only the storage adapter differs underneath. D-157 P0 deleted the
  // legacy `audit.*` read-rpc family (`audit.list` / `audit.get` /
  // `audit.export` / `audit.runs.*` / `audit.commits.by_*`), so this
  // pair is the whole `audit.*` rpc surface.
  'audit.export.estimate': RpcMethodSpec<
    AuditExportRequest,
    AuditExportEstimate
  >;
  'audit.export.page': RpcMethodSpec<
    AuditExportRequest,
    AuditExportPage
  >;

  // ── memory.* — owner-trusted management of the D-120 `data.memory.*`
  //    provenance timeline (D-198). Bearer-`user_self`, NO contract gate
  //    (the owner acting on their own paired server — mirrors `data.timeline`
  //    / `data.file.read`), still audited. `list` is the transparent,
  //    origin-filterable feed (built on `listByAudit(origin_actors)`);
  //    `create`/`update`/`delete` act on the caller's OWN `user_self` entries
  //    (engine/AI/contracted rows are view + redact/retain, origin immutable);
  //    `import` merges `user_self` by id + content-dedups "other". Export
  //    reuses `audit.export.*` above. Handlers land in Slice 1+; the wire
  //    entries are declared here so the whole surface type-checks up front. ─
  'memory.list': RpcMethodSpec<MemoryListRequest, MemoryListResponse>;
  'memory.get': RpcMethodSpec<MemoryGetRequest, MemoryGetResponse>;
  'memory.create': RpcMethodSpec<MemoryCreateRequest, MemoryMutationResult>;
  'memory.update': RpcMethodSpec<MemoryUpdateRequest, MemoryMutationResult>;
  'memory.delete': RpcMethodSpec<MemoryDeleteRequest, MemoryDeleteResult>;
  'memory.import': RpcMethodSpec<MemoryImportRequest, MemoryImportResult>;

  // ── triggers.* — event-driven recipe dispatch (§Recipe triggers) ─
  'triggers.list': RpcMethodSpec<void, { triggers: EventTrigger[] }>;
  'triggers.create': RpcMethodSpec<
    {
      recipe_id: string;
      publisher_id: string;
      pattern: EventTriggerPattern;
      /** D-179 P2 — standing dish to dispatch as (replaces the retired
       *  per-row `config_patch` override). */
      dish_id?: string;
      /** D-179 — config overlay for the headless fires this trigger
       *  drives. Non-empty + no explicit `dish_id` ⇒ the server mints a
       *  managed dish to hold it (dissolved on `triggers.delete`). */
      config_overlay?: Record<string, unknown>;
      watch_interval_ms?: number;
      enabled?: boolean;
    },
    { trigger: EventTrigger }
  >;
  'triggers.update': RpcMethodSpec<
    {
      trigger_id: string;
      enabled?: boolean;
      pattern?: EventTriggerPattern;
      /** D-179 P2 — re-point / detach (null clears) the dish binding. */
      dish_id?: string | null;
      /** D-179 — edit the config the trigger's headless fires use. A
       *  changed overlay mints a new managed dish + dissolves the prior
       *  (immutable — one `dish_id` = one config); `{}` clears. Ignored
       *  when an explicit `dish_id` is in the same call (that wins). */
      config_overlay?: Record<string, unknown>;
      watch_interval_ms?: number | null;
    },
    { trigger: EventTrigger }
  >;
  'triggers.delete': RpcMethodSpec<
    { trigger_id: string },
    { ok: true }
  >;
  /** "Watch this element" — the Browser Bridge dom-watch affordance.
   *  Scaffolds a minimal LOCAL notify recipe from a `(url, selector)`
   *  target and saves it; the declarative event-trigger reconciler arms
   *  the dom watch on save (no explicit `triggers.create`). Idempotent —
   *  the recipe_id is a digest of the target, so `created: false` means a
   *  watch on the same element already existed. Owner-only via the
   *  `triggers.` MCP-reserved prefix. */
  'triggers.createElementWatch': RpcMethodSpec<
    {
      /** Chrome match pattern naming the tab/origin (whitespace-free). */
      url: string;
      /** CSS selector whose text is polled for change. */
      selector: string;
      /** Optional human label; falls back to a host-derived name. */
      label?: string;
    },
    { recipe_id: string; created: boolean }
  >;

  // ── collection.* — write-path extensions ───────────────────────
  /** Force a resync pass on `(platform, slug)` — re-reads the source
   *  and emits `record_created` / `record_updated` / `record_deleted`
   *  events to the warehouse bus. Idempotent; queued if one is in
   *  flight. */
  'collection.resync': RpcMethodSpec<
    { platform: CollectionPlatform; slug: string },
    { ok: true; queued_at: number }
  >;
  /** Delete one record from `(platform, slug)`. Raises
   *  `COLLECTION_RECORD_NOT_FOUND` when the row is absent. Audit-log
   *  entry: `collection_record_deleted` (reserve = false). */
  'collection.deleteRecord': RpcMethodSpec<
    {
      platform: CollectionPlatform;
      slug: string;
      record_id: string;
    },
    { ok: true }
  >;

  // ── collection.file.* — Phase 7 / D-110 enroll family ─────────
  //
  // Named file-adapter instances live in the collection_instances
  // table. Enrollment runs the adapter's probeCaps, writes the row,
  // and (in the caller's composition root) spins up the adapter on
  // the collection registry. Every operation takes a slug — the row
  // is keyed by (platform='file', slug).
  'collection.file.enroll': RpcMethodSpec<
    {
      slug: string;
      adapter_type: FileAdapterType;
      config: Record<string, unknown>;
    },
    {
      instance: CollectionInstanceRow;
      probe_result: FileCollectionCaps;
    }
  >;
  'collection.file.update': RpcMethodSpec<
    {
      slug: string;
      config_patch: Record<string, unknown>;
      reprobe?: boolean;
    },
    {
      instance: CollectionInstanceRow;
      re_probed: boolean;
    }
  >;
  'collection.file.delete': RpcMethodSpec<
    { slug: string },
    { ok: true }
  >;
  /** Force a re-probe on an existing instance, then restart its live adapter
   *  for one bounded rescan. Updates cached caps and auth_state in one shot. */
  'collection.file.resync': RpcMethodSpec<
    { slug: string },
    { ok: true; probe_result: FileCollectionCaps; auth_state: CollectionAuthState }
  >;
  /** Cross-type enumeration of every instance on this server. Returns
   *  the caps + auth_state every caller needs for parseRecipe gating
   *  (the extension's install validator) + UI rendering (Options →
   *  Server → Collections). `type` filter narrows to one platform. */
  'collection.listInstances': RpcMethodSpec<
    { type?: CollectionPlatform },
    { instances: CollectionInstanceRow[] }
  >;

  // ── collection.calendar.* — D-117 enroll family ────────────────
  //
  // Named calendar instances ride on the same `collection_instances`
  // table as file/mail/webhook. Two enrollment flows split by
  // credential style: `enrollOAuth` (gcal/graph) and `enrollBasic`
  // (caldav). All operations are slug-scoped. The server's
  // composition root spins up a live `CalendarCollection` after a
  // successful enroll; the rpc handler does NOT manage adapter
  // lifecycle directly.
  'collection.calendar.enrollOAuth': RpcMethodSpec<
    {
      slug: string;
      adapter: 'gcal' | 'graph';
      oauth_code: string;
      oauth_redirect_uri: string;
      backfill_days?: number;
      expansion_future_days?: number;
      expansion_past_days?: number;
      retention_days?: number;
      quota_bytes?: number;
      poll_seconds?: number;
      calendar_filter?: string[];
    },
    { slug: string; caps: CalendarCollectionCaps }
  >;
  /** Microsoft-only — adopt the calendar lane onto a `graph` grant the MAIL lane
   *  already holds, with no second consent.
   *
   *  🔑 Sound only because Microsoft's mail and calendar adapters are both named
   *  `graph`, so their tokens live under ONE `account.graph.<slug>.*` prefix and
   *  one grant genuinely serves both lanes. An OAuth code is single-use, so the
   *  mail enroll has already spent it; this path probes caps against the stored
   *  tokens and writes the calendar row.
   *
   *  ⛔ NOT a way to skip consent. It requires a mail instance at the SAME slug
   *  (proof a consent happened through the mail lane) AND a refresh token already
   *  at that prefix, and it verifies the grant actually carries the calendar scope
   *  by probing before writing a row. There is deliberately no `gcal` equivalent:
   *  Google's `gmail` / `gcal` prefixes differ, so nothing is shared to adopt. */
  'collection.calendar.attachGraphGrant': RpcMethodSpec<
    {
      /** Must match an existing `mail` instance's slug. */
      slug: string;
      backfill_days?: number;
      expansion_future_days?: number;
      expansion_past_days?: number;
      retention_days?: number;
      quota_bytes?: number;
      poll_seconds?: number;
      calendar_filter?: string[];
    },
    { slug: string; caps: CalendarCollectionCaps }
  >;
  /** CalDAV — basic / app-password. The password is handed over once at
   *  enrollment and stored server-side under `caldav.<slug>.password`
   *  (mirrors the IMAP account-store credential model); the config row
   *  never carries it. `calendar_home_url` is required by the adapter —
   *  `.well-known/caldav` autodiscovery is out of scope. */
  'collection.calendar.enrollBasic': RpcMethodSpec<
    {
      slug: string;
      server_url: string;
      username: string;
      password: string;
      calendar_home_url: string;
      scheduling_outbox_url?: string;
      calendar_filter?: string[];
      probe_rsvp?: boolean;
      backfill_days?: number;
      expansion_future_days?: number;
      expansion_past_days?: number;
      retention_days?: number;
      quota_bytes?: number;
      poll_seconds?: number;
      discover_timeout_ms?: number;
    },
    { slug: string; caps: CalendarCollectionCaps }
  >;
  /** Enumerate calendar instances on this server. */
  'collection.calendar.list': RpcMethodSpec<
    void,
    { instances: CollectionInstanceRow[] }
  >;
  /** Patch retention / quota / expansion / poll cadence. `reprobe:
   *  true` re-runs the cap probe + refreshes the cached caps. Does
   *  NOT re-auth (use `reauth` for that). */
  'collection.calendar.update': RpcMethodSpec<
    {
      slug: string;
      config_patch: Record<string, unknown>;
      reprobe?: boolean;
    },
    { instance: CollectionInstanceRow; re_probed: boolean }
  >;
  /** Drop the instance row + signal the composition root to stop the
   *  live adapter. Adapter-side cleanup (per-instance SQLite tables,
   *  CAS blobs referenced only by this instance) follows in
   *  composition root. */
  'collection.calendar.delete': RpcMethodSpec<
    { slug: string },
    { ok: true }
  >;
  /** Re-probe caps + flip `auth_state`. Probe failure does NOT throw
   *  — returns the existing caps + flips `auth_state` so the UI can
   *  render an "expired / degraded" pill without losing the cached
   *  capability shape. */
  'collection.calendar.resync': RpcMethodSpec<
    { slug: string },
    {
      ok: true;
      caps: CalendarCollectionCaps;
      auth_state: CollectionAuthState;
    }
  >;
  /** OAuth re-consent kickoff. Server returns `{ ok: true }` and the
   *  extension owns the authorize URL construction (mirroring
   *  `collection.mail.enrollOAuth`). CalDAV instances respond with
   *  `not_implemented` — caldav reauth = update the vault key. */
  'collection.calendar.reauth': RpcMethodSpec<
    { slug: string },
    { oauth_url: string } | { ok: true }
  >;

  // ── collection.service.* — D-118 enroll family ─────────────────
  //
  // Service instances (`data.service.<slug>`) are typed process-
  // execution endpoints — `kind: service` templates from the
  // marketplace, bound to user-approved configs. Eight handlers
  // mirror the calendar enrollment shape: list / enroll / install /
  // upgrade / uninstall / update / delete / clear_crash. All on the
  // pair transport (ext ↔ server WS rpc), never via cloud — services
  // are server-local by design (D-097).
  /** Enumerate every enrolled `data.service.*` instance with its
   *  current state + caps. Cheap — reads `collection_instances` +
   *  in-RAM `service_instance_state`. */
  'collection.service.list': RpcMethodSpec<void, ServiceInstanceList>;
  /** Enumerate every `kind: service` template the server's manifest
   *  registry knows about. Powers the enroll-form picker + the
   *  `service_ref` install-time picker. Filters by OS (defaulting to
   *  the server's detected OS) and optionally by `variant_group`.
   *  Returns a self-contained row per template so the picker can
   *  populate caps + config_schema + install_hint without a second
   *  rpc. D-118 Phase 10 follow-up. */
  'collection.service.listTemplates': RpcMethodSpec<
    ServiceTemplateListInput | void,
    ServiceTemplateList
  >;
  /** Create a new instance row. Runs `install_check` synchronously
   *  during enroll; result rides on the response so the UI can
   *  branch directly into install vs ready vs hint paths. Does NOT
   *  run the installer — that's a separate button-driven rpc. */
  'collection.service.enroll': RpcMethodSpec<
    ServiceEnrollInput,
    ServiceEnrollOutput
  >;
  /** Run the template's `install[]` registry entries. Streams stdout
   *  to the extension during execution (out-of-band via dispatch
   *  events); the final response carries the installer exit code +
   *  re-probed `install_check`. Only valid when `caps.install ===
   *  'yes'` — `'hint_only'` returns SERVICE_INSTALL_UNAVAILABLE. */
  'collection.service.install': RpcMethodSpec<
    { slug: string },
    ServiceInstallOutput
  >;
  /** Run the template's `upgrade[]` registry entries. Same streaming
   *  + response shape as `install`. Failure preserves the previous
   *  binary (download kind via `.bak`, PMs via their own rollback). */
  'collection.service.upgrade': RpcMethodSpec<
    { slug: string },
    ServiceUpgradeOutput
  >;
  /** Remove the instance row. `remove_binary: true` ALSO runs the
   *  template's `uninstall[]` entries; `false` (default) leaves the
   *  binary on disk and only drops the row + cleans up the cwd. */
  'collection.service.uninstall': RpcMethodSpec<
    { slug: string; remove_binary?: boolean },
    ServiceUninstallOutput
  >;
  /** Patch the instance config. Validated against the template's
   *  `config_schema`. If the service is running, the supervisor
   *  restarts it (templates that need different semantics declare
   *  config-only fields that don't trigger restart). */
  'collection.service.update': RpcMethodSpec<
    { slug: string; config_patch: Record<string, unknown> },
    { slug: string; caps: ServiceCollectionCaps }
  >;
  /** Drop the instance + cascade `service_instance_state`. Distinct
   *  from `uninstall` — `uninstall` keeps the row + clears the
   *  binary; `delete` clears the row + optionally the binary. UI
   *  prompts for `uninstall_binary` before sending. */
  'collection.service.delete': RpcMethodSpec<
    { slug: string; uninstall_binary?: boolean },
    { deleted: true }
  >;
  /** User clicked `[Clear & retry]` on a `permanently_crashed`
   *  instance. Resets `consecutive_crashes = 0`, flips `auth_state`
   *  to `healthy`, and runs `lifecycle.start`. Returns the post-
   *  reset status snapshot. */
  'collection.service.clear_crash': RpcMethodSpec<
    { slug: string },
    ServiceStatus
  >;
  /** User-driven lifecycle start. Thin wrapper over the dispatcher's
   *  `start` — the same path the `service-start` kernel ingredient
   *  uses inside recipes. Tool-shape templates respond
   *  `SERVICE_OP_NOT_SUPPORTED`. Idempotent: re-issue while running
   *  is a no-op (reconciler dedupes). */
  'collection.service.start': RpcMethodSpec<
    { slug: string },
    {
      state: 'running' | 'unhealthy' | 'failed';
      pid: number | null;
      started_at: number | null;
    }
  >;
  /** User-driven lifecycle stop. Same dispatcher path as
   *  `service-stop`. Tool-shape templates respond
   *  `SERVICE_OP_NOT_SUPPORTED`. */
  'collection.service.stop': RpcMethodSpec<
    { slug: string },
    { state: 'stopped' | 'failed' }
  >;
  /** User-driven restart — `stop` followed by `start`. Composed in
   *  the handler so a single click maps to a single rpc round-trip;
   *  the supervisor's restart-policy stays untouched. */
  'collection.service.restart': RpcMethodSpec<
    { slug: string },
    {
      state: 'running' | 'unhealthy' | 'failed';
      pid: number | null;
      started_at: number | null;
    }
  >;

  // ── server.archive.* — rpc archive flow (closes D-108 #14) ─────
  /** Start an async archive export. Returns a `job_id` immediately;
   *  caller polls `server.archive.status` until `state !== 'running'`.
   *  `recoveryKey` is the user's 24-word mnemonic — it crosses the wire
   *  transiently (same posture as `pair.registerRecoveryKey`; never
   *  persisted) and the server derives the archive encryption key from
   *  it. The export is encrypted under this key, so the same key is
   *  required to import it later. `include_blobs` (default true) bundles
   *  CAS payloads; `include_passport` (default true) embeds a signed
   *  identity passport (`passport.json`) attesting the producing identity.
   *  Either defaults on — only an explicit `false` opts out. */
  'server.archive.export': RpcMethodSpec<
    { include_blobs?: boolean; include_passport?: boolean; recoveryKey: string },
    { job_id: string }
  >;
  /** Poll an in-flight or completed archive export. */
  'server.archive.status': RpcMethodSpec<
    { job_id: string },
    ArchiveJobStatus
  >;
  /** Import an archive on disk at `path`. Triggers drain +
   *  stage-beside-then-atomic-swap restore + restart. `dry_run: true`
   *  decrypts + reads the manifest without writing (also validates the
   *  recovery key + reports the `realm` relation before the destructive
   *  step). `force: true` skips the schema_version compatibility check
   *  (dangerous — only when recovering from a bad upgrade). `recoveryKey`
   *  is the user's 24-word mnemonic — it crosses the wire transiently
   *  (never persisted) and the server derives the archive decryption key
   *  from it; it must match the key the archive was exported under.
   *
   *  Q2 realm-ownership gate: the destructive swap must prove ownership of
   *  the CURRENT server's realm, not merely decrypt the archive. When the
   *  archive's key also matches this realm (`realm: 'same'`) that one key
   *  suffices. When it does not (`realm: 'cross'` — a foreign archive /
   *  different identity) the commit additionally requires `currentRealmKey`
   *  = THIS server's recovery key; absent/wrong → `archive_realm_mismatch`
   *  (403). `realm` is returned on dry_run so the ext can branch the UI. */
  'server.archive.import': RpcMethodSpec<
    {
      path: string;
      recoveryKey: string;
      currentRealmKey?: string;
      force?: boolean;
      dry_run?: boolean;
    },
    {
      manifest: ArchiveManifest;
      restored_at: number | null;
      realm: ArchiveRealmRelation;
      /** M5 S2 — a committing restore mints a fresh bearer for the
       *  import-driving client (whose old bearer the db swap wipes) and
       *  returns it here so the client reconnects without re-pairing. Absent
       *  on dry_run + when no driving-client identity is resolvable. */
      rebind?: ArchiveImportRebind;
      /** M5 S3.0 — db-schema compatibility verdict, present on `dry_run` so the
       *  UI can warn (+ block confirm) BEFORE a destructive commit when the
       *  backup needs a newer server. The commit independently refuses an
       *  `archive_too_new` restore unless `force`. */
      schema_compat?: ArchiveSchemaCompat;
    }
  >;

  // ── server.archive.upload.* — M4b.1 no-SSH migrate (upload → stage) ──
  /** Open a resumable archive-upload session bound to (filename,
   *  declared_size[, fingerprint]) + return the 256-bit `upload_id` capability;
   *  the shared chunk-core's disk caps gate it. `scope_key` is resolved
   *  server-side from `ctx.token_instance_id` — never client-set. The chunk
   *  BYTES ride the dedicated binary `/ws/archive-upload` socket, never rpc.
   *  Owner-only; off MCP by catalog omission (like the sibling archive rpc). */
  'server.archive.upload.create': RpcMethodSpec<
    ArchiveUploadCreateRpcRequest,
    ArchiveUploadCreateRpcResponse
  >;
  /** Resume probe: persisted offset IFF (filename, declared_size[, fingerprint])
   *  still match the session, else a fresh-create signal. */
  'server.archive.upload.probe': RpcMethodSpec<
    ArchiveUploadProbeRpcRequest,
    ArchiveUploadProbeRpcResponse
  >;
  /** Finalize once `offset === declared_size`: STAGES the assembled archive to
   *  `<data>/exports/` under a non-generated name (export GC + `/ws/download`
   *  both ignore it) and returns that `staged_name` for `server.archive.import`.
   *  No `data.file.received` ingest (unlike `upload.finalize`). Idempotent. */
  'server.archive.upload.finalize': RpcMethodSpec<
    ArchiveUploadFinalizeRpcRequest,
    ArchiveUploadFinalizeRpcResponse
  >;
  /** Explicit cancel (best-effort reap of row + scratch); a crashed client
   *  falls back to the shared TTL sweeper. */
  'server.archive.upload.delete': RpcMethodSpec<
    ArchiveUploadDeleteRpcRequest,
    ArchiveUploadDeleteRpcResponse
  >;

  // ── D-145 PB12 — S2S Preview consumer rpc ───────────────────────
  //
  // `s2s_preview.build` runs the substrate `buildRedactedPacket` —
  // strict-pick `fields_visible` per packet_kind, run the per-kind
  // boundary transformation (calendar→free_windows etc.), persist
  // under an opaque access token + clamped expiry, emit the
  // `redacted_packet.built` D-120 audit row. The handler is the
  // S2S Preview consumer surface — peer-MCP-future + D-149 reception
  // both consume the same substrate; the rpc is the local-callable
  // entry point that wraps the substrate call.
  's2s_preview.build': RpcMethodSpec<
    import('../redacted-packets.js').S2SPreviewBuildRequest,
    import('../redacted-packets.js').S2SPreviewBuildResponse
  >;
  // `s2s_preview.consume` validates the access token shape, looks up
  // the persisted packet, checks expiry, returns the packet, and
  // emits the `redacted_packet.accessed` D-120 audit row linking
  // back to the build row via `audit_target_id`.
  's2s_preview.consume': RpcMethodSpec<
    import('../redacted-packets.js').S2SPreviewConsumeRequest,
    import('../redacted-packets.js').S2SPreviewConsumeResponse
  >;

  // ── D-137 P1 — AI Chat (Wire A) ─────────────────────────────────
  //
  // Webclient ↔ server chat orchestration. The server-side chat
  // orchestrator (handler scaffold lands in the next D-137 P1 slice)
  // runs the agent loop; webclient is display + HID per D-148
  // architecture. Closed `CHAT_RPC_METHODS` list in `../chat.ts`
  // mirrors these keys; `SERVER_RPC_METHODS` array below is the
  // dispatcher's known-method list. The substrate-level registry
  // entry is what makes a future `chat.send` request reach a
  // registered handler — without it the WS dispatcher classifies the
  // method as `unknown_method` and the wire is unreachable.
  // Per-method shapes use `unknown` for the request body at P1 — the
  // handler-scaffold slice tightens to concrete request/response
  // shapes alongside the handler implementation.
  'chat.sessions.list': RpcMethodSpec<void, { sessions: unknown[] }>;
  'chat.session.get': RpcMethodSpec<{ session_id: string }, unknown>;
  'chat.session.create': RpcMethodSpec<{ title?: string }, { session_id: string }>;
  'chat.session.delete': RpcMethodSpec<{ session_id: string }, { ok: true }>;
  'chat.session.export': RpcMethodSpec<{ session_id: string }, unknown>;
  'chat.egress.get': RpcMethodSpec<{ session_id: string; message_id: string }, unknown>;
  'chat.send': RpcMethodSpec<
    {
      session_id: string;
      message: string;
      /** D-172 P2 — `data.file` records the owner attached to THIS turn,
       *  already uploaded and finalized (the webclient's resumable upload
       *  returns the `record_id`). Ids only: the bytes went up the binary
       *  `/ws/upload` socket, and reading them back is the separately-gated
       *  `data-file-read`. Absent on a plain text turn.
       *
       *  ⚠ Until this existed, MESSENGER was the only way a file could enter a
       *  chat session — `attachments` was set on exactly one code path. The
       *  model-facing half (the tail marker, `file.search`) was already built
       *  and simply had nothing to see from the webclient. */
      attachments?: Array<{ file_id: string; media_class: string }>;
      picker_state: { current: string };
      model_pref?: { current: string; source_id?: string };
      /** D-193 — the requesting user's IANA timezone (the webclient reads
       *  `Intl…resolvedOptions().timeZone`). Threads to the chat prompt's
       *  current-time anchor so the model resolves "remind me at 3pm" in
       *  the user's zone, not the server's. Absent ⇒ server-local. */
      time_zone?: string;
      /** Correlation for an explicit verify-before-retry turn. The server
       * validates that this names a same-session consumed action with an
       * uncertain outcome; it is never approval authority. */
      retry_of_plan_id?: string;
      /** Explicit conversational lineage to a prior same-session turn. The
       * server resolves the durable root; this id grants no authority. */
      continuation_of_turn_id?: string;
      /** Evidence-only grounding for a guided Data diagnosis. The server
       * validates the same-session consumed action and derives run
       * correlation before stamping it on the durable Chat turn. */
      data_diagnosis?: import('../chat.js').ChatDataDiagnosisRequest;
    },
    {
      turn_id: string;
      /** Echo of the server-normalized durable grounding when this was a
       * guided diagnosis turn. Lets the accepting client paint the same
       * correlation state before the completed message arrives. */
      data_diagnosis?: import('../chat.js').ChatDataDiagnosisContext;
    }
  >;
  /** Persist the owner's explicit closure of a completed safe-check answer.
   * The server validates the exact same-session assistant message and stamps
   * the timestamp; this mutation cannot approve or dispatch a tool. */
  'chat.data_diagnosis.resolve': RpcMethodSpec<
    {
      session_id: string;
      message_id: string;
      status: import('../chat.js').ChatDataDiagnosisResolutionStatus;
    },
    {
      resolution: import('../chat.js').ChatDataDiagnosisResolution;
    }
  >;
  /** Durable, owner-only snapshot for the bell and unified Approvals queue.
   * Pending shells whose exact encrypted payload cannot be recovered remain
   * present with `payload_available: false` so clients can disable approval
   * while retaining safe cancellation. */
  'chat.plans.pending.list': RpcMethodSpec<
    void,
    { plans: ReadonlyArray<ChatPlanRecord> }
  >;
  // D-137 P3 § A.11 — plan-approval rpc: approve / cancel a pending
  // write proposal. Returns the resolved `ChatPlanProposal` (status
  // flipped to `'approved'` / `'cancelled'` + `resolved_at` stamped)
  // so the caller can render the post-resolution card without waiting
  // for the `chat.plan_resolved` broadcast round-trip. `edited_args`
  // on approve is reserved for the per-arg edit flow (the renderer
  // surfaces an editable form per § A.11 "Mary confirms / edits /
  // cancels"); P3 ships the substrate slot without consuming the
  // field — edits land in P4 polish.
  'chat.plan.approve': RpcMethodSpec<
    { plan_id: string; edited_args?: Record<string, unknown> },
    { plan: ChatPlanProposal }
  >;
  'chat.plan.cancel': RpcMethodSpec<
    { plan_id: string },
    { plan: ChatPlanProposal }
  >;
  /** Explicit owner feedback on a completed execution span. The turn is a
   * correlation handle only; the server derives the root and every case key. */
  'chat.execution.feedback': RpcMethodSpec<
    {
      session_id: string;
      turn_id: string;
      kind: import('../execution-case.js').ExecutionCaseFeedbackKind;
      source_plan_id?: string;
    },
    { recorded: boolean }
  >;
  /** Retract one exact owner feedback fact and deterministically recompile the
   * affected closed span. The caller still names no case or feedback row. */
  'chat.execution.feedback.retract': RpcMethodSpec<
    {
      session_id: string;
      turn_id: string;
      kind: import('../execution-case.js').ExecutionCaseFeedbackKind;
      source_plan_id?: string;
    },
    { retracted: boolean }
  >;
  /** Owner-only D-214 compiler/experiment aggregates. Kept `unknown` at the
   * transport boundary because the report is versioned independently and is
   * not a model-facing contract. */
  'chat.execution.diagnostics': RpcMethodSpec<void, unknown>;
  /** D-219 item 2 — WHAT RECUED HAS LEARNED, as the owner sees it.
   *
   *  The arc's asset is a corpus built from what the owner said, and until this
   *  existed they could not see any of it: asked "was that right?", they
   *  answered, a model got a card, and they got nothing they could look at.
   *
   *  ⛔ `flows` is rendered by the SAME function that builds the model-bound
   *  card, so the page cannot drift from the thing it reports on. Owner-only /
   *  local-UI; off MCP through the `chat.execution.` reserved prefix, which is
   *  what keeps an agent from reading (or editing) the owner's precedent. */
  'chat.execution.learned': RpcMethodSpec<
    void,
    { cases: import('../execution-case.js').ExecutionCaseLearnedEntry[] }
  >;
  /** D-219 item 2 — unlearn one case, permanently.
   *
   *  ⛔ Deleting the materialized row would be a NO-OP THAT LOOKS LIKE A FIX: a
   *  case is a projection re-derived from its sources on the next compile, i.e.
   *  the next governed turn. The server removes the source reports and the
   *  owner verdicts recorded against their roots instead.
   *
   *  `removed: false` means no such case — not an error. `cases_remaining` is
   *  the post-rebuild count, so a caller can see when a shared source report
   *  took a second case with it. */
  'chat.execution.forget': RpcMethodSpec<
    { case_id: string },
    { removed: boolean; cases_remaining: number }
  >;
  /** D-219 item 2b — ask the owner's own model to draft a recipe from a case.
   *
   *  ⛔ **DRAFTS, NEVER SAVES.** The result is an unsaved `RecipeDefinition` the
   *  Kitchen opens for review; saving is `recipe.save` and the owner's decision.
   *  Validating a machine-written recipe is exactly the manual authoring path —
   *  there is no separate blessing for one.
   *
   *  ⛔ **MANUAL ONLY.** Nothing reaches this but an owner pressing a button:
   *  no turn, no schedule, no housekeeping cycle. It is a slow call against
   *  their model quota on their own recorded words, so it is theirs to
   *  initiate — `RECIPE_DRAFT_CONFIRMATION` is what the surface must show
   *  first.
   *
   *  ⚠ `request_aliased: false` means the owner's request could not be safely
   *  aliased and was therefore NOT sent — the draft was made from the tool
   *  shape and their instruction alone, and is likely thinner for it. Owner-only
   *  / local-UI; off MCP through the `chat.execution.` reserved prefix. */
  /** D-219 — record that the owner SAVED a recipe drafted from a case.
   *
   *  ⛔ **THE CALLER ASSERTS NEITHER THE KEY NOR THE HASH.** It supplies a
   *  `case_id`; the server resolves the durable `case_key` off the case row and
   *  hashes the stored recipe itself. Otherwise any paired client could claim an
   *  arbitrary recipe came from an arbitrary case.
   *
   *  ⚠ Written AFTER the save, best effort. `recorded: false` means the case or
   *  the recipe could not be found — a forgotten case, or a save under a
   *  different id — and is not an error: the recipe is what mattered, and the
   *  cost of losing this is an annotation. Owner-only / local-UI; off MCP
   *  through the `chat.execution.` reserved prefix. */
  'chat.execution.authored': RpcMethodSpec<
    { case_id: string; recipe_id: string },
    { recorded: boolean }
  >;
  'chat.execution.draft_recipe': RpcMethodSpec<
    { case_id: string; prompt?: string; previous_recipe?: unknown },
    {
      ok: boolean;
      recipe?: import('../recipe.js').RecipeDefinition;
      /** Validator findings — present on failure, and possibly on success. */
      issues: string[];
      /** `unknown_case` | `no_json` | `invalid_recipe`, absent when `ok`. */
      reason?: string;
      request_aliased?: boolean;
    }
  >;
  'chat.session.set_picker': RpcMethodSpec<
    { session_id: string; picker_state: { current: string } },
    { ok: true }
  >;
  'chat.session.set_model_pref': RpcMethodSpec<
    { session_id: string; model_pref: { current: string; source_id?: string } },
    { ok: true }
  >;

  // ── D-167 chat provider-threading — override lifecycle + global default ──
  //
  // `clear_model_pref` drops a session's explicit per-session override so
  // its effective layer reverts to the per-pair global default.
  // `chat.default_model_pref.get` / `.set` read + write the per-pair global
  // chat-model default as a `source_id` (`slot_1` | `slot_2` | `free_pool`) —
  // NOT per-session; applies to every non-overridden session, resolved to a
  // concrete `{layer, model_hint}` at read time against the live LLM config
  // (D-174 R28 Slice A). `.set` validates the source_id + persists + emits
  // `chat.default_model_pref_changed`. `.get` returns `null` when no default
  // is chosen yet (no provider configured). Per-pair only — no cross-cloud
  // sync (per § Must Hold; D-097 / D-168).
  'chat.session.clear_model_pref': RpcMethodSpec<
    { session_id: string },
    { ok: true }
  >;
  'chat.default_model_pref.get': RpcMethodSpec<
    void,
    { source_id: ChatModelSourceId | null; updated_at: number }
  >;
  'chat.default_model_pref.set': RpcMethodSpec<
    { source_id: string },
    { source_id: ChatModelSourceId; updated_at: number }
  >;

  // ── D-137 W2.2 § A.1.1 — Mary's per-kind catalog scope ─────────
  //
  // Per-pair setting (NOT per-session). `get` returns the persisted
  // scope (or the substrate default at first boot); `set` validates +
  // persists + emits `chat.tool_catalog_scope_changed` on the
  // broadcast bus. Per-pair only — no cross-cloud sync (per § Must
  // Hold; D-097 / D-168).
  'chat.tool_catalog.get': RpcMethodSpec<
    void,
    {
      enabled_kinds: readonly string[];
      updated_at: number;
    }
  >;
  'chat.tool_catalog.set': RpcMethodSpec<
    { enabled_kinds: readonly string[] },
    {
      enabled_kinds: readonly string[];
      updated_at: number;
    }
  >;

  // ── D-137 W2.3 § A.1.1 + § A.10 — Mary's per-connection MCP tool
  //                                 annotation rpc ────────────
  //
  // Three methods cover the substrate cleanly: `list` for the Settings
  // → Connections summary view (one row per existing annotation),
  // `get` for a specific connection's annotation row (always returns
  // a shape — the empty default when no row exists yet), and `set`
  // which validates + persists + emits the
  // `chat.connection_mcp_annotation_changed` broadcast. Per-pair only
  // — no cross-cloud sync (per § Must Hold; D-097 / D-168).
  'chat.connection_mcp.list': RpcMethodSpec<
    void,
    {
      annotations: ReadonlyArray<{
        connection_name: string;
        topic_tags: ReadonlyArray<string>;
        tool_overrides: Readonly<Record<string, {
          enabled: boolean;
          classification: 'read' | 'write' | 'unknown';
          custom_topic_tags?: ReadonlyArray<string>;
        }>>;
        tools_list_cache: {
          tools: ReadonlyArray<{
            name: string;
            description?: string;
            input_schema?: unknown;
            destructive_hint?: boolean;
          }>;
          cached_at: number;
        };
        /** D-137 P4 Codex review P3 fold — typed clients need the
         *  field to drive picker visibility from a `list` response.
         *  Optional: absent = legacy row written before P4; null =
         *  generic MCP; object = Recued peer. */
        recued_signature?: {
          server_kind: 'recued';
          version: string;
          instance_id: string;
        } | null;
        /** D-137 P5 § A.7.1 + § A.10 / Codex review P2 fold — Bob's
         *  per-contract chat-mode metadata mirrored from his MCP
         *  server's `serverInfo._meta.recued.chat_mode`. `null` =
         *  chat-mode not offered (substrate default); object stamps
         *  the offered+session_cap state. The picker emitter still
         *  ignores `offered: true` until the Direction C runtime
         *  ships post-D-145 federation. */
        chat_mode?: {
          offered: boolean;
          session_cap?: { per_day: number; concurrent: number };
        } | null;
        updated_at: number;
      }>;
    }
  >;
  'chat.connection_mcp.get': RpcMethodSpec<
    { connection_name: string },
    {
      annotation: {
        connection_name: string;
        topic_tags: ReadonlyArray<string>;
        tool_overrides: Readonly<Record<string, {
          enabled: boolean;
          classification: 'read' | 'write' | 'unknown';
          custom_topic_tags?: ReadonlyArray<string>;
        }>>;
        tools_list_cache: {
          tools: ReadonlyArray<{
            name: string;
            description?: string;
            input_schema?: unknown;
            destructive_hint?: boolean;
          }>;
          cached_at: number;
        };
        /** D-137 P4 Codex review P3 fold — same field as the `list`
         *  variant; typed clients need it on the single-row read
         *  too (Settings → Connections → <name> renders the picker
         *  state from this response). */
        recued_signature?: {
          server_kind: 'recued';
          version: string;
          instance_id: string;
        } | null;
        /** D-137 P5 § A.7.1 + § A.10 / Codex review P2 fold — same
         *  field as the `list` variant; typed clients need it on the
         *  single-row read so the Settings UI surfaces the per-peer
         *  chat-mode state. */
        chat_mode?: {
          offered: boolean;
          session_cap?: { per_day: number; concurrent: number };
        } | null;
        updated_at: number;
      };
    }
  >;
  'chat.connection_mcp.set': RpcMethodSpec<
    {
      connection_name: string;
      topic_tags?: ReadonlyArray<string>;
      tool_overrides?: Record<string, {
        enabled: boolean;
        classification: 'read' | 'write' | 'unknown';
        custom_topic_tags?: ReadonlyArray<string>;
      }>;
      tools_list_cache?: {
        tools: ReadonlyArray<{
          name: string;
          description?: string;
          input_schema?: unknown;
          destructive_hint?: boolean;
        }>;
        cached_at: number;
      };
      /** D-137 P4 § A.3 — when present, updates the annotation's
       *  Recued signature. Explicit `null` clears the prior signature
       *  (peer no longer advertises Recued metadata). */
      recued_signature?: {
        server_kind: 'recued';
        version: string;
        instance_id: string;
      } | null;
      /** D-137 P5 § A.7.1 + § A.10 / Codex review P2 fold — when
       *  present, updates the annotation's chat-mode metadata. The
       *  validator's `absent / null / object` merge posture (parallel
       *  to `recued_signature`) applies: absent ⇒ preserve prior; null
       *  ⇒ clear; object ⇒ replace. */
      chat_mode?: {
        offered: boolean;
        session_cap?: { per_day: number; concurrent: number };
      } | null;
    },
    {
      annotation: {
        connection_name: string;
        topic_tags: ReadonlyArray<string>;
        tool_overrides: Readonly<Record<string, {
          enabled: boolean;
          classification: 'read' | 'write' | 'unknown';
          custom_topic_tags?: ReadonlyArray<string>;
        }>>;
        tools_list_cache: {
          tools: ReadonlyArray<{
            name: string;
            description?: string;
            input_schema?: unknown;
            destructive_hint?: boolean;
          }>;
          cached_at: number;
        };
        recued_signature?: {
          server_kind: 'recued';
          version: string;
          instance_id: string;
        } | null;
        chat_mode?: {
          offered: boolean;
          session_cap?: { per_day: number; concurrent: number };
        } | null;
        updated_at: number;
      };
    }
  >;

  // ── D-137 P4 § A.7 + § A.7.1 — Picker entry projection + refresh ──
  //
  // `chat.picker.entries` is read-only — returns the current
  // `PickerEntry[]` projection (always carries `'self'`; per-peer
  // entries surface per `buildPickerEntries`'s closed-list gates).
  // `chat.picker.refresh` updates one peer's `recued_signature` +
  // `tools_list_cache` after a caller-driven probe. Both writes flow
  // through the `chat.connection_mcp.set` validator; the refresh rpc
  // is a thin wrapper that emits `chat.picker_entries_changed`
  // alongside the existing `chat.connection_mcp_annotation_changed`
  // broadcast.
  'chat.picker.entries': RpcMethodSpec<
    void,
    {
      entries: ReadonlyArray<{
        id: 'self' | string;
        label: string;
        kind: 'self' | 'peer_data' | 'peer_chat';
        signature?: {
          server_kind: 'recued';
          version: string;
          instance_id: string;
        };
        version_delta?: 'same' | 'older' | 'newer' | 'unknown';
        available_tool_count: number;
      }>;
    }
  >;
  'chat.picker.refresh': RpcMethodSpec<
    {
      connection_name: string;
      recued_signature: {
        server_kind: 'recued';
        version: string;
        instance_id: string;
      } | null;
      tools_list_cache: {
        tools: ReadonlyArray<{
          name: string;
          description?: string;
          input_schema?: unknown;
          destructive_hint?: boolean;
        }>;
        cached_at: number;
      };
      /** D-137 P5 § A.7.1 + § A.10 / Codex review P2 fold — when the
       *  upstream advertises `serverInfo._meta.recued.chat_mode` in
       *  its MCP `initialize` response, the probe forwards it here so
       *  Mary's annotation row carries the per-peer chat-mode state.
       *  Optional: absent ⇒ preserve prior; null ⇒ clear (peer no
       *  longer offers chat-mode); object ⇒ stamp fresh probe result. */
      chat_mode?: {
        offered: boolean;
        session_cap?: { per_day: number; concurrent: number };
      } | null;
    },
    {
      annotation: {
        connection_name: string;
        topic_tags: ReadonlyArray<string>;
        tool_overrides: Readonly<Record<string, {
          enabled: boolean;
          classification: 'read' | 'write' | 'unknown';
          custom_topic_tags?: ReadonlyArray<string>;
        }>>;
        tools_list_cache: {
          tools: ReadonlyArray<{
            name: string;
            description?: string;
            input_schema?: unknown;
            destructive_hint?: boolean;
          }>;
          cached_at: number;
        };
        recued_signature?: {
          server_kind: 'recued';
          version: string;
          instance_id: string;
        } | null;
        chat_mode?: {
          offered: boolean;
          session_cap?: { per_day: number; concurrent: number };
        } | null;
        updated_at: number;
      };
      entries: ReadonlyArray<{
        id: 'self' | string;
        label: string;
        kind: 'self' | 'peer_data' | 'peer_chat';
        signature?: {
          server_kind: 'recued';
          version: string;
          instance_id: string;
        };
        version_delta?: 'same' | 'older' | 'newer' | 'unknown';
        available_tool_count: number;
      }>;
    }
  >;

  // ── D-137 P5 follow-on § A.9 — Inbound MCP token registry ──
  //
  // Bob's per-pair inbound token surface. The Settings → MCP Tokens
  // page consumes the full set; the verifier swap-in (replacing the v1
  // `RECUED_MCP_HTTP_TOKEN` env-var path with `verifyBearer`) lands
  // alongside in this slice. Reserved for local-UI only —
  // `chat.inbound_token.` is in `MCP_RESERVED_RPC_PREFIXES` so external
  // MCP agents can never invoke any of these (channel-isolation
  // invariant: a peer must not be able to issue itself a fresh max-
  // grants token, edit grants mid-call, or revoke other peers'
  // tokens).
  //
  // All six handlers persist through `SqliteMcpInboundTokenStore` +
  // emit `chat.inbound_token_changed` on the broadcast bus + emit
  // audit rows from the closed `chat_inbound_token_{issued,grants_-
  // updated,revoked}` set (issuance + revocation are reserve-class +
  // survive retention pruning per `RESERVE_ACTIONS`; grants edit is
  // user-class — settings-style permission breadcrumb).
  //
  // The rpcs accept the wire-untrusted issuance / edit args and route
  // them through `validateMcpInboundTokenInput` (closed 13-code list
  // — `MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES`) so every shape error
  // surfaces as `bad_request` (400) with the joined codes; substrate
  // errors (peer_handle conflict per spec § A.9 "one token per peer
  // initially") raise `bad_request` (400) with the
  // `PEER_HANDLE_CONFLICT_PREFIX` message; `not_configured` (501) when
  // the store isn't wired (dbless harness).
  'chat.inbound_token.list': RpcMethodSpec<
    void,
    { tokens: ReadonlyArray<McpInboundTokenRecord> }
  >;
  'chat.inbound_token.get': RpcMethodSpec<
    { token_id: string },
    { token: McpInboundTokenRecord | null }
  >;
  'chat.inbound_token.issue': RpcMethodSpec<
    {
      label: string;
      peer_handle?: string;
      grants: Readonly<Record<string, boolean>>;
      concurrency_tier: McpInboundConcurrencyTier;
      /** `0` = never expires (substrate sentinel); positive integers
       *  enforce the wall-clock expiry. The validator raises
       *  `expires_at_invalid` on negative / non-integer values. The
       *  Settings → MCP Tokens page defaults to `now() + 1y` per spec
       *  § A.9 ("Optional expiry, default 1 year, configurable"). */
      expires_at: number;
      chat_mode: {
        offered: boolean;
        session_cap?: { per_day: number; concurrent: number };
      } | null;
      /** D-166 P2 token↔contract binding — optional minted `contract_id` to bind
       *  this token to. Every MCP dispatch authenticated by the issued token then
       *  carries it as `ExecutionSource.contract_id`, so the active contract's
       *  overlay governs the call live AND revoking / expiring / exhausting the
       *  contract collapses the token's authorization to nothing (a live
       *  kill-switch). Opaque here — liveness resolves at dispatch, so an id naming
       *  no contract fails closed (denies) rather than being rejected at issuance.
       *  The validator raises `contract_id_invalid` on a non-string / empty / >256
       *  value. */
      contract_id?: string;
    },
    /** The full `IssuedMcpInboundToken` envelope — `record` carries
     *  every persisted field; `bearer_plaintext` is surfaced exactly
     *  once at issuance so Bob can copy it out-of-band before it falls
     *  out of memory. Every subsequent read of the row only returns
     *  the `bearer_hash`. */
    IssuedMcpInboundToken
  >;
  'chat.inbound_token.update_grants': RpcMethodSpec<
    {
      token_id: string;
      /** D-171 slice 2b — `grants` is OPTIONAL (preserve-on-absent). When
       *  present it replaces the whole per-tool grants map; when absent the
       *  token's grants are left untouched. This lets the Chat-row toggle edit
       *  `chat_mode` WITHOUT echoing a (possibly stale) grants snapshot that
       *  would silently roll back a concurrent per-tool edit — and lets slice
       *  2c's grant checklist edit grants without touching chat-mode. At least
       *  one of `grants` / `chat_mode` must be present. */
      grants?: Readonly<Record<string, boolean>>;
      /** D-171 slice 2b — OPTIONAL `chat_mode` (the Chat row's live toggle).
       *  The token value is unchanged — this edits the live token in place so
       *  connected clients keep working (decision 6). Tri-state:
       *    - **absent**  → preserve the token's current `chat_mode` (slice 2c's
       *      per-tool grant checklist edits grants WITHOUT touching chat-mode);
       *    - **`null`**  → clear chat-mode ("not offered");
       *    - **object**  → set `offered` + an optional `session_cap`.
       *  Validated server-side by `validateInboundTokenChatModeUpdate` (the
       *  shared closed-list chat_mode issue codes). */
      chat_mode?: {
        offered: boolean;
        session_cap?: { per_day: number; concurrent: number };
      } | null;
    },
    { token: McpInboundTokenRecord }
  >;
  // D-171 slice 3 — rebind an EXISTING token's `contract_id` in place (no
  // re-issue; the token value is unchanged so connected clients keep working,
  // decision 6). The Advanced sub-panel lazily mints a `contract_definition`
  // (D-166, `collection.contract.mintContract`) when a cap/expiry is turned on,
  // then binds the live token to it via this rpc; turning the limit off rebinds
  // to unbound (`contract_id: null`) before revoking the definition. The bound
  // contract's revoke / expiry / exhaustion is the live kill-switch (the MCP
  // transport resolves liveness per request → collapses the token's authorization
  // to nothing). Reserved local-UI only via the `chat.inbound_token.` prefix.
  'chat.inbound_token.update_contract': RpcMethodSpec<
    {
      token_id: string;
      /** The minted `contract_id` to bind, or `null` to unbind (remove the
       *  cap/expiry envelope). A non-empty string ≤256 chars; opaque here —
       *  liveness resolves at dispatch, so an id naming no contract fails
       *  closed (denies) rather than being rejected at rebind time. */
      contract_id: string | null;
    },
    { token: McpInboundTokenRecord }
  >;
  'chat.inbound_token.revoke': RpcMethodSpec<
    { token_id: string },
    /** `revoked` reflects whether this call mutated the row; idempotent
     *  re-revocation returns `false` + the prior `revoked_at`. The
     *  full record is included so the Settings page can re-render
     *  without a follow-up `get`. */
    { revoked: boolean; token: McpInboundTokenRecord }
  >;
  'chat.inbound_token.delete': RpcMethodSpec<
    { token_id: string },
    { deleted: boolean }
  >;
  // D-171 slice 2c — the live self tool catalog the Permissions → MCP door
  // per-tool grant checklist renders. A read over the orchestrator's
  // `InternalToolRegistry.list()` (Tier 1 + 2 + 3 self tools), surfaced as
  // the canonical `ToolEntry[]` so the webclient's `buildChatInboundTokenDetailModel`
  // can group it by ingredient kind + diff it against the token's grants. The
  // grant keys lower onto the same names the inbound MCP dispatch gate
  // authorises against (`isMcpInboundTokenToolAuthorized`). Reads through the
  // `chat.inbound_token.` reserved prefix → external MCP agents can never
  // enumerate the owner's full tool surface. `not_configured` (501) when the
  // catalog provider isn't wired (dbless harness) — same posture as the rest
  // of the family's store-unwired path.
  'chat.inbound_token.tool_catalog': RpcMethodSpec<
    void,
    { catalog: ReadonlyArray<ToolEntry> }
  >;

  // ── D-148 W3.FU "exposure rpc" — Per-path Exposure state mutators ──
  //
  // The three wire entries that let the webclient page-shell drive the
  // server's `ExposureStateMachine` (substrate landed in W3.5 + W3.9 +
  // W3.10; signing wired in FU6). Every mutation runs the substrate's
  // closed-list validators (DDNS gate, `/ws` lockout phrase, public-MCP
  // acknowledgement) + emits a HIGH_ASSURANCE_AUDIT_KINDS row signed
  // with `server_identity_key` + broadcasts `exposure_changed` to every
  // paired client.
  //
  // The substrate `ExposureMutationResult` is a tagged union of
  // `{ ok: true; state }` and `{ ok: false; error: NetworkErrorCode; ... }`.
  // The wire response normalises the success branch to the post-state
  // (so the caller can rehydrate the Exposure surface without a
  // follow-up read); the error branch flows through `RpcError` so the
  // dispatcher returns the substrate's stable code + the `/ws` lockout
  // gate's `required_phrase` / `active_clients` hints land in
  // `RpcError.message` for the modal renderer to parse.
  //
  // Reserved for local-UI only — `exposure.*` is in
  // `MCP_RESERVED_RPC_PREFIXES` so the MCP-channel agents cannot drive
  // the toggle grid (channel-isolation invariant).
  'exposure.apply_preset': RpcMethodSpec<
    {
      preset: ExposurePreset;
      lockout_confirmation_phrase?: string;
      reason?: string;
    },
    {
      state: ExposureState;
      /** D-148 spec § A.6.6 — number of WS clients drained when this
       *  mutation landed `/ws` in `{ lan: false, public: false }`. 0
       *  when the mutation didn't trigger the lockout drain. Echoed
       *  from the server so the renderer doesn't have to count
       *  itself. */
      clients_disconnected: number;
    }
  >;
  'exposure.set_path_resolution': RpcMethodSpec<
    {
      path: PathRole;
      resolution: PathResolution;
      lockout_confirmation_phrase?: string;
      reason?: string;
    },
    {
      state: ExposureState;
      clients_disconnected: number;
    }
  >;
  'exposure.set_public_mcp_acknowledgement': RpcMethodSpec<
    {
      acknowledge: boolean;
      free_text_confirmation?: string;
      reason?: string;
    },
    {
      state: ExposureState;
      /** Always 0 on this path — public-MCP ack changes never project
       *  `/ws` off. Shape parity with the other two methods so the
       *  client can render the same `clients_disconnected` field
       *  uniformly. */
      clients_disconnected: number;
    }
  >;
  // R26.2 Delta 1 — the read counterpart to the three mutators. The
  // Settings → Server → Exposure grid hydrates its initial state from
  // this on cold load (there is no `state.snapshot` projection wired for
  // exposure, and the `exposure_changed` broadcast only fires on a
  // transition — boot `reapply()` is audit-only, so a freshly-loaded
  // panel would otherwise have nothing to render). Pure read: no audit
  // row, no broadcast. Local-UI only — covered by the `exposure.` prefix
  // in `MCP_RESERVED_RPC_PREFIXES`. Requires a paired caller for parity
  // with the mutators (the surface is operator-only).
  'exposure.get': RpcMethodSpec<
    void,
    {
      state: ExposureState;
      /** R26.2 Delta 2 — the server-global apex (`GET /`) serving mode,
       *  read alongside the grid so the Exposure panel hydrates both in one
       *  call. The picker gates `serve_reception`/`serve_webclient` against
       *  the grid's per-path public bits + the bundle availability. */
      apex_mode: RootApexMode;
    }
  >;
  /** R26.2 Delta 2 — set the apex (`GET /`) serving mode. Cross-validated
   *  against the live exposure resolution: `serve_reception` requires
   *  `/reception` public (else `apex_reception_not_public`), `serve_webclient`
   *  requires the embedded bundle served (else `apex_webclient_unavailable`,
   *  pending Delta 3); an unknown mode is `apex_mode_unknown`. Hot — the root
   *  handler re-reads it per request, no restart. Local-UI only (the
   *  `exposure.` prefix is MCP-reserved). */
  'exposure.set_apex': RpcMethodSpec<
    { apex_mode: RootApexMode },
    { apex_mode: RootApexMode }
  >;

  // D-148 follow-up #4 — BYO cert upload rpc surface for the
  // Settings → Server → TLS Certificates page (W3.8). Wires the W3.6
  // `TLSDomainStore` substrate over the wire. Three methods, mirroring
  // the spec § A.6.3 interface — `upload` + `remove` + `list`. SNI
  // `lookup` stays internal to the public listener (per-handshake,
  // synchronous, never crosses the wire).
  //
  // Reserved for local-UI only — `tls_domain.*` is in
  // `MCP_RESERVED_RPC_PREFIXES`. External AI agents must never drive a
  // cert upload / replace / remove. Channel-isolation invariant.
  //
  // Errors: the upload path surfaces the W3.6 `TLSDomainUploadIssue`
  // closed list (`tls_san_mismatch` / `tls_key_pair_mismatch` /
  // `tls_chain_invalid` / `tls_cert_expired_at_upload`) via the
  // `NetworkErrorCode` taxonomy. `RpcError.details` carries the
  // structured issue array so the upload form can surface each
  // issue's inline copy without parsing the message.
  'tls_domain.upload': RpcMethodSpec<
    {
      domain: string;
      cert_pem: string;
      private_key_pem: string;
      chain_pem?: string;
      source: TLSDomainCertSource;
    },
    TLSDomainUploadResult
  >;
  'tls_domain.remove': RpcMethodSpec<
    { domain: string },
    {
      /** True iff a row was deleted. False when the domain didn't exist
       *  (the substrate is idempotent — delete-missing is a no-op).
       *  Surfaces in the UI so a "removed" toast doesn't fire on a
       *  stale row. */
      removed: boolean;
    }
  >;
  'tls_domain.list': RpcMethodSpec<
    Record<string, never>,
    {
      entries: ReadonlyArray<TLSDomainCertListEntry>;
    }
  >;

  // D-148 follow-up #5 — Pro auto-managed `<handle>.recued.cloud` unbind
  // rpc. Tears down the DDNS subdomain at the cloud helper + removes the
  // auto-managed cert from `SqliteTlsDomainStore` in one transaction.
  // Emits a high-assurance signed `pro_acme_unbound` audit row.
  //
  // Reserved for local-UI only — `pro_acme.` is in
  // `MCP_RESERVED_RPC_PREFIXES`. External AI agents must never drive a
  // handle release; the DDNS subdomain release IS a destructive
  // operator-only action that affects every paired client's
  // server-address pin.
  //
  // Errors: `pro_acme_not_found` (domain doesn't exist OR isn't
  // `pro_acme`-sourced — idempotent retries surface this on the second
  // call), `pro_acme_ddns_release_failed` (cloud-side release failed
  // transient — cert stays in place; user can retry).
  'pro_acme.unbind': RpcMethodSpec<
    { domain: string; reason?: string },
    {
      /** True iff a row was deleted. False when the second-call
       *  idempotent retry observed the row already absent (the first
       *  call completed the teardown). */
      released: boolean;
      /** Canonical lowercase + trimmed domain the substrate operated
       *  against (mirrors `tls_domain.remove`'s W3.6 P2 fold). */
      domain: string;
      /** Handle stem the cloud DDNS release was issued against —
       *  `alice.recued.cloud` → `alice`. Carried in the response so the
       *  renderer can refer to the released handle without re-parsing. */
      handle: string;
    }
  >;

  // ── reception.* — D-149 P3 § A.3 — Public Reception registry ────
  //
  // Reserved admin-only rpc methods over Reception's local stores
  // table. Substrate-side every mutation emits a D-120 high-assurance
  // signed audit row per § N.3 (mirrors `pro_acme.unbind`'s posture);
  // every read + mutation goes through the same `RECEPTION_RPC_METHODS`
  // closed list. Reserved for local-UI only — `reception.` is added to
  // `MCP_RESERVED_RPC_PREFIXES` so external AI agents cannot drive
  // endpoint creation / token rotation / emergency disable through the
  // MCP channel (mirrors `chat.inbound_token.` + `tls_domain.` posture).
  //
  // Channel isolation rationale: a public-facing reception endpoint
  // exposes the user's data to anonymous visitors; an MCP-channel
  // mutation would be catastrophic (e.g., a compromised AI agent could
  // create an endpoint exposing every commitment + then revoke the
  // user's review path). Reserved-prefix gate keeps the AI agent on
  // its assigned channel.
  'reception.endpoints.list': RpcMethodSpec<
    import('../reception-registry.js').ReceptionEndpointsListFilter | void,
    import('../reception-registry.js').ReceptionEndpointsListResult
  >;
  'reception.endpoint.preview_draft': RpcMethodSpec<
    import('../reception-registry.js').ReceptionEndpointPreviewInput,
    import('../reception-registry.js').ReceptionEndpointPreviewResult
  >;
  'reception.endpoint.create': RpcMethodSpec<
    import('../reception-registry.js').ReceptionEndpointCreateInput,
    import('../reception-registry.js').ReceptionEndpointCreateResult
  >;
  'reception.endpoint.rotate_token': RpcMethodSpec<
    import('../reception-registry.js').ReceptionEndpointRotateInput,
    import('../reception-registry.js').ReceptionEndpointRotateResult
  >;
  'reception.endpoint.enable': RpcMethodSpec<
    import('../reception-registry.js').ReceptionEndpointMutationInput,
    { ok: true }
  >;
  'reception.endpoint.disable': RpcMethodSpec<
    import('../reception-registry.js').ReceptionEndpointMutationInput,
    { ok: true }
  >;
  'reception.endpoint.revoke': RpcMethodSpec<
    import('../reception-registry.js').ReceptionEndpointRevokeInput,
    { ok: true }
  >;
  'reception.endpoint.extend': RpcMethodSpec<
    import('../reception-registry.js').ReceptionEndpointExtendInput,
    { ok: true }
  >;
  'reception.endpoint.access_log': RpcMethodSpec<
    import('../reception-registry.js').ReceptionEndpointAccessLogInput,
    import('../reception-registry.js').ReceptionEndpointAccessLogResult
  >;
  'reception.intake_recipe_pair.get': RpcMethodSpec<
    import('../reception-intake-recipe-pair.js').ReceptionIntakeRecipePairGetInput,
    import('../reception-intake-recipe-pair.js').ReceptionIntakeRecipePairGetResult
  >;
  'reception.intake_recipe_pair.bind': RpcMethodSpec<
    import('../reception-intake-recipe-pair.js').ReceptionIntakeRecipePairBindInput,
    import('../reception-intake-recipe-pair.js').ReceptionIntakeRecipePairBindResult
  >;
  'reception.intake_recipe_pair.configure': RpcMethodSpec<
    import('../reception-intake-recipe-pair.js').ReceptionIntakeRecipePairConfigureInput,
    import('../reception-intake-recipe-pair.js').ReceptionIntakeRecipePairConfigureResult
  >;
  'reception.intake_recipe_pair.clear': RpcMethodSpec<
    import('../reception-intake-recipe-pair.js').ReceptionIntakeRecipePairClearInput,
    import('../reception-intake-recipe-pair.js').ReceptionIntakeRecipePairClearResult
  >;
  // D-210 step 2a — the reception RECORD's read surface. Redacted by construction: no
  // visitor values and no ciphertext to recover them from (D-149 § N.6 / D-173 I-3).
  'reception.record.list': RpcMethodSpec<
    import('../reception-record.js').ReceptionRecordListInput | void,
    import('../reception-record.js').ReceptionRecordListResult
  >;
  // D-210 Appendix B — mint an on-the-go reschedule link for one booking.
  'reception.manage.mint': RpcMethodSpec<
    import('../reception-manage.js').ReceptionManageMintInput,
    import('../reception-manage.js').ReceptionManageMintResult
  >;
  'reception.emergency_disable_all': RpcMethodSpec<
    import('../reception-registry.js').ReceptionEmergencyDisableAllInput | void,
    import('../reception-registry.js').ReceptionEmergencyDisableAllResult
  >;
  // D-149 P4 § A.5.1 — reception_page singleton config rpcs. Read +
  // upsert the per-server singleton config; reserved-prefix gate
  // (`reception.`) keeps these off the MCP channel like every other
  // reception rpc.
  'reception.page.get': RpcMethodSpec<
    void,
    import('../reception-page-config.js').ReceptionPageGetResult
  >;
  'reception.page.upsert': RpcMethodSpec<
    import('../reception-page-config.js').ReceptionPageUpsertInput,
    import('../reception-page-config.js').ReceptionPageUpsertResult
  >;
  // D-149 P12 § A.20.5 — Abuse Inbox rpc trio. Aggregates recent
  // operational-access-log rows into abuse-signal clusters + manages
  // the per-server IP block list the path-listener enforces. Reserved
  // for local-UI only — `reception.` is in `MCP_RESERVED_RPC_PREFIXES`.
  'reception.abuse_inbox.list': RpcMethodSpec<
    import('../reception-registry.js').ReceptionAbuseInboxListInput | void,
    import('../reception-registry.js').ReceptionAbuseInboxListResult
  >;
  'reception.abuse_inbox.ban_ip': RpcMethodSpec<
    import('../reception-registry.js').ReceptionAbuseInboxBanIpInput,
    import('../reception-registry.js').ReceptionAbuseInboxBanIpResult
  >;
  'reception.abuse_inbox.unban_ip': RpcMethodSpec<
    import('../reception-registry.js').ReceptionAbuseInboxUnbanIpInput,
    import('../reception-registry.js').ReceptionAbuseInboxUnbanIpResult
  >;
  // D-149 follow-on § A.10 — Templates browser wire. Reads the
  // Foundation-pack `intake_form` template manifests from the installed
  // `recued-core/personal-organizer-foundation` pack so Settings →
  // Reception → Templates projects server-supplied pack content per
  // D-148 § A.4. Reserved-prefix-gated like every other reception rpc.
  'reception.template.list': RpcMethodSpec<
    void,
    import('../reception-registry.js').ReceptionTemplateListResult
  >;
  'reception.compose.propose': RpcMethodSpec<
    import('../reception-registry.js').ReceptionComposeProposeInput,
    import('../reception-registry.js').ReceptionComposeProposeResult
  >;
  // D-173 N.2 — Reception Inbox rpc trio (the review-then-approve inbox
  // over held `approval_required` operations). Admin-only — `reception.`
  // is in `MCP_RESERVED_RPC_PREFIXES`, so an MCP-channel / anonymous-
  // reception caller can never list held visitor requests or drive the
  // boundary-crossing materialize. `approve` is the ONLY writer of
  // `checkpoint.arg_overrides` (the N.5 security boundary). The local
  // `ReceptionInboxRpcRegistry` fragment in `reception-inbox.ts` is the
  // typed source these three mirror.
  'reception.inbox.list': RpcMethodSpec<
    import('../reception-inbox.js').ReceptionInboxListInput | undefined,
    import('../reception-inbox.js').ReceptionInboxListResult
  >;
  'reception.inbox.approve': RpcMethodSpec<
    import('../reception-inbox.js').ReceptionInboxApproveInput,
    import('../reception-inbox.js').ReceptionInboxApproveResult
  >;
  'reception.inbox.reject': RpcMethodSpec<
    import('../reception-inbox.js').ReceptionInboxRejectInput,
    import('../reception-inbox.js').ReceptionInboxRejectResult
  >;

  // ── recued.com account binding (D-175 P5) ───────────────────────
  //
  // The pair-RPC surface for the account ↔ server binding protocol.
  // The webclient relays the Worker-minted binding token over the pair
  // channel (`account.bind`); the server exchanges it with the auth
  // Worker, stores the returned server-scoped credential as identity-
  // root material, and reports state through `account.bindingStatus`.
  // Reserved local-UI only — `account.` is in `MCP_RESERVED_RPC_PREFIXES`
  // (an MCP-channel agent must never relay a binding token, tear down a
  // binding, or read account ownership). Absent deps → every method
  // returns `not_configured` (db-less harness, or a boot before the
  // signing identity is wired).
  /** Receive the relayed binding token, exchange it with the auth
   *  Worker, and store the returned server-scoped credential. A bind
   *  from a DIFFERENT account than the current owner returns `conflict`
   *  unless `confirm_rebind` is set (D-175 D10 — no silent rebind). */
  'account.bind': RpcMethodSpec<
    import('../account-binding.js').AccountBindRelayRequest,
    import('../account-binding.js').AccountBindResult
  >;
  /** Clear the server's account binding (drops the stored credential).
   *  Idempotent — returns `not_bound` when nothing was bound. */
  'account.unbind': RpcMethodSpec<
    void,
    import('../account-binding.js').AccountUnbindResult
  >;
  /** Secret-free current binding state for the webclient / dashboard.
   *  NEVER returns the stored credential. */
  'account.bindingStatus': RpcMethodSpec<
    void,
    import('../account-binding.js').AccountBindingStatusResponse
  >;

  // ── Pro convenience status (D-175 P8) ───────────────────────────
  //
  // Secret-free read of the server's Pro provisioning posture — per
  // convenience item (`<handle>.recued.cloud` DDNS · ACME cert ·
  // reserved handle) the state derived from the account binding + the
  // Pro entitlement resolved OFF the binding credential + a reachability
  // proof. The webclient's Settings → Account "Pro convenience bundle"
  // reads it over the pair channel. Reserved local-UI only —
  // `pro_convenience.` is in `MCP_RESERVED_RPC_PREFIXES` (an MCP-channel
  // agent must never enumerate the Pro provisioning posture). NEVER
  // carries `server_scoped_credential` or the entitlement claim token.
  // Absent deps → `not_configured` (db-less harness, or a boot before the
  // signing identity is wired).
  'pro_convenience.status': RpcMethodSpec<
    void,
    import('../pro-convenience.js').ProConvenienceStatusResponse
  >;

  // ── R27 delta-B — user-initiated DDNS pause/resume ──────────────
  //
  // Owner-only local-UI; `ddns.` is in `MCP_RESERVED_RPC_PREFIXES` (an
  // MCP-channel agent must never pause a user's DDNS publication).
  // `setEnabled` flips the server-local publish flag (gates the update
  // poller) AND signs the cloud `/v1/ddns/pause` verb (the real record
  // pull/restore); `status` reads the local flag. Pause does NOT touch the
  // Pro subscription. Absent deps → `not_configured` (db-less harness, or a
  // boot before the signing identity is wired).
  'ddns.status': RpcMethodSpec<
    void,
    import('../network.js').DdnsEnabledStatus
  >;
  'ddns.setEnabled': RpcMethodSpec<
    import('../network.js').DdnsSetEnabledRequest,
    import('../network.js').DdnsEnabledStatus
  >;

  // ── Supervision (cli-daemon keep-alive) ─────────────────────────
  //
  // Owner-only local-UI; `supervision.` is in `MCP_RESERVED_RPC_PREFIXES`
  // (an MCP-channel agent must never enrol / flip / start / stop a
  // long-running supervised daemon — cloudflared tunnel, ollama serve).
  // `set` enrols/flips/starts/stops one pack daemon op; `list` / `status`
  // read live state. Absent deps → `not_configured` (db-less harness, or a
  // boot before the collection context is composed).
  'supervision.set': RpcMethodSpec<
    import('../supervision.js').SupervisionSetRequest,
    import('../supervision.js').SupervisionDaemonRow | null
  >;
  'supervision.list': RpcMethodSpec<
    void,
    import('../supervision.js').SupervisionListResponse
  >;
  'supervision.status': RpcMethodSpec<
    import('../supervision.js').SupervisionStatusRequest,
    import('../supervision.js').SupervisionDaemonRow | null
  >;

  // ── Release & Update substrate (D-178) ──────────────────────────
  //
  // Owner-only, reserved out of MCP (`update.` in
  // `MCP_RESERVED_RPC_PREFIXES`): a compromised AI agent must never
  // be able to enumerate the update posture nor (later slices) drive
  // an apply / rollback. `update.check` fetches the signed manifest,
  // verifies its minisign signature (I-2), and resolves it against
  // this install LOCALLY (I-1/I-7/I-10). Absent deps / no trusted key
  // → `status: 'not-configured'`.

  /** Fetch + verify + locally resolve the release manifest for this
   *  install. Read-only — never mutates beyond persisting the
   *  anti-replay floor + rollout salt. */
  'update.check': RpcMethodSpec<
    void,
    import('../release-update.js').ReleaseCheckResponse
  >;

  /** Read the effective apply policy (env / user-override / channel default). */
  'update.mode': RpcMethodSpec<
    void,
    import('../release-update.js').UpdateModeStatus
  >;

  /** Set the user apply-policy override. Rejected (`env_locked`) when
   *  `RECUED_SELF_UPDATE` pins the mode. */
  'update.set_mode': RpcMethodSpec<
    { mode: import('../release-update.js').UpdateMode },
    import('../release-update.js').UpdateModeStatus
  >;

  /** Stage + restart into the resolved release (two-phase apply; the
   *  commit lands on the next healthy boot). Owner action — fetches +
   *  verifies (I-2) the SAME signed manifest `update.check` does, then
   *  downloads / verifies / swaps the platform artifact. A major bump
   *  is refused (`major-blocked`, I-4); a delegated channel (docker /
   *  source) returns `not-applicable`. `force` skips the auto-eligible
   *  gate for an owner-initiated apply of an in-cohort non-major. */
  'update.apply': RpcMethodSpec<
    { force?: boolean } | void,
    import('../release-update.js').UpdateApplyResponse
  >;

  /** Roll back the current release to `recued.old` (+ restore the
   *  pre-migration snapshot when one applies) and restart. Owner action,
   *  never consults the manifest (I-10); refused while an apply is in
   *  flight (I-6) or when there is nothing to roll back to. */
  'update.rollback': RpcMethodSpec<
    void,
    import('../release-update.js').UpdateRollbackResponse
  >;

  /** Resolve one opaque receipt returned by an accepted apply/rollback.
   * Read-only and owner-only; returns no version, ledger row, or raw error.
   * `include_closed: true` opts a closure-aware client into the
   * `closed_unresolved` status. Older clients omit it and continue to receive
   * `unknown`, so they cannot mistake a newer closure state for success. */
  'update.operation_status': RpcMethodSpec<
    { operation_id: string; include_closed?: boolean },
    import('../release-update.js').UpdateOperationStatusResponse
  >;

  /** Durably close a permanently unresolvable receipt without asserting that
   * its update/rollback succeeded. The server re-resolves the exact receipt,
   * refuses while any update is in flight, and records the closure in its
   * out-of-database update ledger. Owner-reviewed and owner-only. */
  'update.operation_close': RpcMethodSpec<
    {
      operation_id: string;
      expected_operation: 'update' | 'rollback';
    },
    import('../release-update.js').UpdateOperationClosureResponse
  >;

  // ── cli reachability grid (D-182 §7.2) ──────────────────────────
  //
  // Owner-only, reserved out of MCP (`cli.reachability.` in
  // `MCP_RESERVED_RPC_PREFIXES`): a `cli` op authorizes against a
  // per-(principal × cli-ingredient × risk_tier) reachability allowlist
  // (absent ⇒ denied, fail-closed), NOT a connection profile. This family
  // AUTHORS that allowlist (the "Local tools" grid); a compromised AI agent
  // must never grant itself reachability to a local binary, revoke a cell a
  // recipe depends on, nor enumerate the grid. Absent deps (db-less harness)
  // → `not_configured`.

  /** Every reachability row — the grid's data read (a cheap store scan). */
  'cli.reachability.list': RpcMethodSpec<
    void,
    import('../cli-reachability-rpc.js').CliReachabilityListResponse
  >;

  /** The installed cli-tool universe — the surface's tool rows + per-op toggles
   *  (a cheap derive over the installed manifest snapshot, no store scan).
   *  The "Local tools" surface joins this with `cli.reachability.list` (granted
   *  rows) + `collection.contract.listContracts` (the contract rows). */
  'cli.reachability.universe': RpcMethodSpec<
    void,
    import('../cli-reachability-rpc.js').CliReachabilityUniverseResponse
  >;

  /** Grant (or revoke) one op for a principal (default owner `user_self`):
   *  `allowed: true` admits a recipe run under that principal to reach the cli
   *  ingredient's op; `allowed: false` drops the row (back to the fail-closed
   *  default). Audited. */
  'cli.reachability.set': RpcMethodSpec<
    import('../cli-reachability-rpc.js').CliReachabilitySetRequest,
    import('../cli-reachability-rpc.js').CliReachabilitySetResponse
  >;
};

/** D-148 follow-up #4 — structured details payload on
 *  `tls_domain.upload` errors. Round-trips through
 *  `RpcError.details` so the upload form renders inline per-issue copy
 *  without parsing the message. */
export interface TlsDomainUploadErrorDetails {
  issues: ReadonlyArray<TLSDomainUploadIssue>;
}

/** Runtime-accessible list of every method declared in
 *  `ServerRpcRegistry`. Used by the server-side dispatcher to
 *  disambiguate `unknown_method` (name not in this list) from
 *  `not_configured` (name listed but handler absent at this server).
 *
 *  The `satisfies` clause checks at compile time that this tuple
 *  covers every key in `ServerRpcRegistry`; add a key there and the
 *  compiler requires it here too. */
export const SERVER_RPC_METHODS = [
  'cache.get',
  'cache.put',
  'cache.since',
  'prefs.get',
  'prefs.set',
  'auth.state',
  'auth.init',
  'auth.unlock',
  'auth.lock',
  'auth.rotatePassword',
  'auth.migrate.prepare',
  'auth.migrate.commit',
  'auth.migrate.status',
  'auth.migrate.resume',
  'schedules.list',
  'schedules.create',
  'schedules.update',
  'schedules.delete',
  'dishes.list',
  'dishes.create',
  'dishes.update',
  'dishes.delete',
  'dishes.history',
  'recipe_config.get',
  'recipe_config.set',
  'dish_groups.list',
  'dish_groups.create',
  'dish_groups.update',
  'dish_groups.delete',
  'auto_run.list',
  'auto_run.update',
  'watch.list',
  'watch.update',
  'watch.run_now',
  'server.getLLMConfig',
  'server.setLLMConfig',
  'server.setLLMSlot',
  'server.setEmbeddingsSlot',
  'server.upsertFreePoolEntry',
  'server.removeFreePoolEntry',
  'server.setFreePoolEntryEnabled',
  'server.setChatCatalogMode',
  'server.getLlmPrompts',
  'server.setLlmPrompt',
  'server.getConfigSchema',
  'server.setConfigField',
  'server.seller.getOverview',
  'server.seller.listOrders',
  'server.seller.transitionOfferState',
  'server.seller.updateSettings',
  'server.seller.acknowledgeLlmGatewayPaid',
  'server.seller.upsertManualTier',
  'server.seller.createPassTier',
  'server.seller.issueManualCustomer',
  'server.seller.extendManualCustomer',
  'server.seller.swapManualCustomerTier',
  'server.seller.closeManualCustomer',
  'server.seller.reissueManualCustomerToken',
  'server.seller.bulkAdjustManualTierCustomers',
  'server.seller.synchronizeStripeEntitlements',
  'pair.list',
  'pair.revoke',
  'pair.registerRecoveryKey',
  // D-169 P0 — bridge capability profile push (closes TR-17). Reserved
  // for local-bridge clients via the `bridge.` MCP_RESERVED_RPC_PREFIXES
  // gate; channel-isolation invariant intact.
  'bridge.capabilityProfile.push',
  'recipe.list',
  // R2 build step 4c.1 — derived recipe runnability read surface. Per-pair /
  // local-UI only; NOT in MCP_TOOL_CATALOG (same posture as `recipe.list` —
  // runnability discloses connection/capability topology, which stays off the
  // MCP-channel agent surface).
  'recipe.runnability',
  // § 7 surfacing slice — per-recipe PII posture read surface. Same local-UI
  // posture as `recipe.runnability` (PII flow topology stays off the
  // MCP-channel agent surface).
  'recipe.pii',
  // Recipe-editor authoring seam — validate + persist an inline-authored
  // recipe (mirrors the MCP `recued_saveRecipe` tool). Owner-only / local-UI;
  // NOT in MCP_TOOL_CATALOG (authoring writes stay off the MCP-channel agent
  // surface, ratchet-enforced by the `recipe.` reserved prefix).
  'recipe.save',
  'recipe.validate',
  'recipe.webhook.status',
  'recipe.webhook.arm',
  'recipe.webhook.disarm',
  // Install seam 5c — standalone recipe install BY SLUG. The apex
  // `#recipes/install/<id>` flow resolves bundled rows to pack detail first;
  // this method rejects any bypass. Same `recipe.` reserved-prefix posture as
  // `recipe.save` (off the MCP-channel agent surface).
  'recipe.installBySlug',
  'approval.list',
  'approval.resolve',
  'approval.subscribe',
  'events.subscribe',
  'token.rotate',
  'tls.renew',
  // LAN-URL kickstart — `network.local_urls` (loopback + LAN reachable URLs);
  // local-UI only (`network.` is in `MCP_RESERVED_RPC_PREFIXES`).
  'network.local_urls',
  // D-148 § A.6.5 + § A.9 — webclient passport-fetch verify path;
  // reserved for local-UI only (`passport.` is in
  // `MCP_RESERVED_RPC_PREFIXES`).
  'passport.fetch',
  // R26.4 Delta 2 — user-initiated passport export + history list.
  // Same `passport.` reservation (local-UI only).
  'passport.export',
  'passport.history.list',
  // R26.4 Delta 5 — passport import commit (new-server migration). Same
  // `passport.` reservation (local-UI only; identity-provenance write).
  'passport.import',
  // R26.4 Delta 3 — Key Health read + operator-initiated key rotation;
  // reserved for local-UI only (`key.` is in `MCP_RESERVED_RPC_PREFIXES`).
  'key.health',
  'key.rotate',
  // D-148 § A.5.3 / § A.6.5 — Pro auth rpc surface; reserved for
  // local-UI only (`pro.` is in `MCP_RESERVED_RPC_PREFIXES`).
  'pro.authenticate',
  'pro.signOut',
  'pro.current',
  'execute',
  'runtime.testTrigger',
  'runtime.resetCircuit',
  'runtime.runWatcher',
  'shared.write',
  'shared.compare-and-set',
  'shared.read',
  'shared.list',
  'shared.search',
  'shared.delete',
  'shared.delete-prefix',
  // D-119 Phase 13 — annotation + link warehouse rpc.
  'annotation.write',
  'annotation.list',
  'annotation.search',
  'annotation.delete',
  'annotation.forRecord',
  'link.write',
  'link.list',
  'link.delete',
  'link.forRecord',
  // D-121 Phase 1 — contact warehouse rpc.
  'contact.upsert',
  'contact.list',
  'contact.get',
  'contact.delete',
  // D-145 PA8 follow-on — identifier-keyed resolver (any of email /
  // phone / alias / platform_id → canonical contact_id).
  'contact.resolve',
  // D-205 #2c — per-Source health (the Sources strip on `#data/contact`).
  // The first reader of the runner's twelve per-cycle counters.
  'contact.source.list',
  // D-205 — the per-source value view.
  //
  // 🔴 THIS LINE'S ABSENCE MADE THE SERVER UNBOOTABLE. `3d04a7098` wired the
  // handler and declared the `RpcMethodSpec` above (34 lines of it) but never
  // added the name HERE — and `ws-server.ts:1928` is a boot-time THROW: every
  // wired method must be in `SERVER_RPC_METHOD_SET`, which is built from THIS
  // array. So HEAD refused to start, and the `serve-*` / `bin-router` suites
  // had been red ever since.
  //
  // ⚠ The real defect is structural and still here: the spec interface above
  // and this array are TWO HAND-MAINTAINED COPIES of one closed list, and a
  // subset TYPECHECKS — the type side compiled perfectly while the runtime side
  // was missing an entry, which is the only reason this shipped. The array
  // should be DERIVED from the interface's keys, not restated. Until it is,
  // adding an rpc means editing both, and forgetting one BRICKS THE SERVER
  // rather than failing at the point of use.
  'contact.contributions',
  // D-205 #5 — selective CRM promotion (the cold-start escape hatch).
  // ⛔ MCP-RESERVED: pulling a stranger into the personal contact graph is a
  // judgement about who you know — the same class of decision as a merge.
  'contact.import.candidates',
  'contact.import.promote',
  // D-205 #5c — the manual vCard / CSV import (a batch `contact.upsert`).
  'contact.import.file_preview',
  'contact.import.file_apply',
  // D-138 Phase 1 — contact merge substrate rpc (local-UI only;
  // namespace excluded from MCP catalog by ratchet — see
  // `packages/contracts/src/mcp-tool-catalog.ts`).
  'contact.merge.list',
  'contact.merge.confirm',
  'contact.merge.reject',
  'contact.merge.split',
  'contact.merge.undo_rejection',
  'contact.merge.resolve_remerge_prompt',
  // D-138 P3 — Settings → Contacts → Scan now (housekeeping run-now
  // wrapper that lets the contact-substrate-aware UI dial full vs
  // delta scan).
  'contact.merge.scan_now',
  // D-138 P5 — upstream-merge outbox (destructive vendor merge);
  // namespace excluded from MCP catalog by ratchet.
  'upstream_merge.describe',
  'upstream_merge.request',
  'upstream_merge.retry',
  'upstream_merge.discard',
  'upstream_merge.list',
  // D-125 Phase 2.1 — connection substrate rpc.
  'collection.connection.list',
  // ⛔ D-225 slice 2 declared these THREE in the interface above and wired all
  // three handlers, but never added them HERE — so `SERVER_RPC_METHOD_SET` did
  // not contain them and `ws-server` refused to start: "handler wired for
  // 'collection.connection.mcpPackPreview' which is not in SERVER_RPC_METHOD_SET".
  // HEAD did not boot. The D-225 rpc suite passes 21/21 because it exercises the
  // handler in isolation and never boots a server, so nothing caught it.
  //
  // ⚠ THIS IS THE SECOND TIME, and the comment below already predicted it: the
  // interface and this array are two hand-maintained copies of one closed list,
  // a SUBSET TYPECHECKS, and the type side compiles while the runtime side is
  // short an entry. Deriving this array from the interface's keys is the actual
  // fix; until then every new method is one forgotten line from an unbootable
  // server.
  'collection.connection.mcpPackPreview',
  'collection.connection.mcpPackStatus',
  'collection.connection.mcpPackCommit',
  'collection.connection.suggestSetup',
  'collection.connection.enroll',
  'collection.connection.update',
  'collection.connection.rotateCredentials',
  'collection.connection.credentialRotationStatus',
  'collection.connection.credentialRotationActivity',
  'collection.connection.acknowledgeCredentialRotationSafeStop',
  'collection.connection.delete',
  // D-192 source-data-removal — the read-only "[N] records" removal-preview count.
  'collection.connection.previewPurge',
  'collection.connection.probe',
  // D-192 M4c-UI — messenger match-pattern (trigger) read + merge-write.
  'collection.connection.getMatchPatterns',
  'collection.connection.setMatchPatterns',
  // D-165 follow-on — operation-group grant management (write→ask reachability).
  'collection.connection.grantOperationGroup',
  'collection.connection.revokeOperationGroup',
  'collection.connection.listOperationGroups',
  // D-201 Slices 1 / 5A — owner-only ingress lifecycle + write-only credentials.
  'webhook.ingress.list',
  'webhook.ingress.get',
  'webhook.ingress.create',
  'webhook.ingress.update',
  'webhook.ingress.credentials.write',
  'webhook.ingress.credentials.retire',
  'webhook.ingress.manual.confirm',
  'webhook.ingress.registration.reconcile',
  'webhook.ingress.enable',
  'webhook.ingress.disable',
  'webhook.ingress.test.deliver',
  'webhook.ingress.retire',
  // D-201 Slice 5B2B1 — owner-only accepted delivery inspection.
  'webhook.delivery.list',
  'webhook.delivery.get',
  'webhook.delivery.event.get',
  // D-201 Slice 5B2B2A — content-free rejected-delivery summaries.
  'webhook.delivery.rejected.list',
  // D-201 Slice 5B2B2B1 — owner-triggered, eligibility-respecting retention.
  'webhook.delivery.retention.prune',
  // D-166 override-write path — `contract.override.*` authoring (Settings-only;
  // reserved out of the MCP catalog via `collection.contract.` prefix).
  'collection.contract.upsertOverride',
  'collection.contract.deleteOverride',
  'collection.contract.listOverrides',
  'collection.contract.listCatalogOperations',
  // D-211 global owner operation-default replacements (local owner only).
  'collection.operation.listOperations',
  'collection.operation.upsertOwnerOverride',
  'collection.operation.deleteOwnerOverride',
  'collection.operation.listOwnerOverrides',
  // D-166 contract_id lifecycle — mint / revoke / list contract_definition rows
  // (Settings → Privacy → Contracts; same reserved prefix). D-187 §6 step 7 —
  // setDoorTypes edits the level-1 door types in place (same reserved prefix).
  'collection.contract.mintContract',
  'collection.contract.revokeContract',
  'collection.contract.setDoorTypes',
  'collection.contract.listContracts',
  // D-186 Slice C — live-control "Active passes" list + early-revoke (same
  // reserved prefix — owner-only, never MCP; a grant is never agent-visible).
  'collection.contract.session_grant.list',
  'collection.contract.session_grant.revoke',
  // D-187 slice 5 — the per-contract policy-overlay producer trio was deleted
  // (the read-fence re-homed onto `contract_grant` collection rows).
  // D-177 N.13 (P6c) — staged-trust suggestion surface: list + accept-mint +
  // permanent dismiss (same reserved prefix — owner-only, never MCP; N.9.1/N.9.7).
  'collection.contract.listDelegationSuggestions',
  'collection.contract.acceptDelegationSuggestion',
  'collection.contract.dismissDelegationSuggestion',
  'collection.contract.listQualityDelegationSuggestions',
  'collection.contract.acceptQualityDelegationSuggestion',
  'collection.contract.dismissQualityDelegationSuggestion',
  'collection.contract.listQualityDelegations',
  'collection.contract.revokeQualityDelegation',
  // D-177 N.11 rule 5 (5.c, slice C) — scoped-grant proposal surface (same
  // reserved prefix — owner-only, never MCP).
  'collection.contract.listScopedGrantSuggestions',
  'collection.contract.acceptScopedGrantSuggestion',
  'collection.contract.dismissScopedGrantSuggestion',
  // D-152 — Settings-only multi-hostname registry surface.
  'collection.hostname.list',
  'collection.hostname.get',
  'collection.hostname.add',
  'collection.hostname.update',
  'collection.hostname.remove',
  'collection.hostname.verifyOwnership',
  // D-129 Phase 1.2 — vendor OAuth code-exchange.
  'collection.connection.completeVendorOAuth',
  // D-148 § A.12 / D-165 enroll-host #1 — vendor OAuth-start.
  'collection.connection.startVendorOAuth',
  // D-165 slice 3 — owner-bound vendor OAuth result-claim.
  'collection.connection.takeVendorOAuthResult',
  // D-139 P2 — Connection-page UX rpc surfaces.
  'collection.connection.engagementHealth',
  'collection.connection.reprobeEngagementCapabilities',
  // D-122 Phase 4.5 — enrichment substrate rpc.
  'enrichment.upsert',
  'enrichment.list',
  // D-136 §A.11 P7 — quality-vote ingest + unwind.
  'enrichment.vote.write',
  'enrichment.vote.delete',
  'notification.send',
  'mail.get',
  // D-123 Phase 5 — housekeeping execution-mode rpc.
  'housekeeping.config.read',
  'housekeeping.config.write',
  'housekeeping.status.read',
  'housekeeping.task.run_now',
  // D-132 P4 — per-topic trust state + pool policy + promotion control.
  'housekeeping.trust.read',
  'housekeeping.trust.write',
  'housekeeping.trust.dismiss_promotion',
  // D-136 §A.12 P7 — topic-reset rpc (dry-run then confirm).
  'housekeeping.topic.reset',
  // D-136 §A.13.1 P7.G — Settings UI capstone: WS surface for the
  // enrichment registry catalog so the per-topic detail drawer can
  // render coverage_quality + drift + private-topic state without
  // re-implementing the MCP-side handler.
  'housekeeping.registry.describe',
  // D-145 PA11 — LLM result cache stats + Clear-cache action. Drives
  // the "LLM result cache" summary card on Settings → Housekeeping.
  'housekeeping.cache.stats',
  'housekeeping.cache.clear',
  // D-136 §A.13.5 P7.G — per-pair MCP visibility user override CRUD.
  'mcp.visibility.read',
  'mcp.visibility.write',
  // Grant-foundation slice 3 (D-187 amendment) — the unified (contract × grant)
  // matrix CRUD. `contract.grant.` is MCP-reserved (channel isolation).
  'contract.grant.read',
  'contract.grant.read_by_entry',
  'contract.grant.write',
  // D-163 Slice C — Settings → Notifications surface.
  // Per-pair only; namespace excluded from MCP catalog by ratchet
  // (`notifications.` in MCP_RESERVED_RPC_PREFIXES).
  'notifications.describe',
  'notifications.set_channel',
  'notifications.set_verification_phrase',
  // D-169 P1 — per-bridge sub-row surface for Settings → Notifications.
  // Shares the `notifications.` reserved-prefix ratchet so MCP-channel
  // agents cannot read / write the per-bridge mode flags.
  'notifications.describe_bridges',
  'notifications.set_bridge_mode',
  // D-169 P2 Slice 4 — caller's own bridge mode (self-scoped, ctx-keyed).
  // Shares the `notifications.` reserved-prefix ratchet (MCP-channel
  // agents cannot read per-bridge mode flags). The bridge side panel
  // calls this to gate its approval-card rendering on its own approval
  // mode.
  'notifications.my_bridge_mode',
  // D-169 P1 — rich server status snapshot. Bridge side-panel section
  // #1 (N.5) reads on mount + each periodic refresh; webclient server
  // dashboard adopts the same rpc when it ships (O-7). Reserved local-
  // UI / local-bridge via `system.` prefix in
  // MCP_RESERVED_RPC_PREFIXES.
  'system.status',
  // D-169 P2 — bridge side-panel historical-view reads (N.5 #2/#3/#4),
  // fetched on side-panel mount + bridge reconnect (cursorless re-fetch,
  // spec § A.5 / DL-6). Thin reads over the D-120 audit log + D-158 ask
  // store; local-UI only (omitted from MCP_TOOL_CATALOG, same posture as
  // `system.status`).
  'execution.recent',
  // D-174 Runs/Audit read seam for the webclient `#runs` route.
  'execution.list',
  'execution.get',
  // D-181 slice 4 — long-op live-control surface (active-list read + the
  // three queue/kill mutators). Owner-only; reserved out of MCP via the
  // `execution.` prefix in MCP_RESERVED_RPC_PREFIXES.
  'execution.active',
  'execution.kill',
  'execution.cancel',
  'execution.promote',
  // D-172 resumable uploads — webclient control plane (binary chunks ride the
  // dedicated `/ws/upload` socket, not rpc).
  'upload.create',
  'upload.probe',
  'upload.finalize',
  'upload.delete',
  'notification.recent',
  'notification.pending_asks',
  // D-169 P2 Slice 3 — bridge approval-card submit funnel into the
  // notification block (`submitAnswer`, first-answer-wins dedup). Local-UI
  // only (omitted from MCP_TOOL_CATALOG, same posture as the reads above).
  'notification.submitAnswer',
  // D-145 PA10 follow-on — Settings → Packs install rpc.
  // Per-pair only; namespace excluded from MCP catalog by ratchet
  // (`packs.` in MCP_RESERVED_RPC_PREFIXES) so MCP-channel agents
  // cannot ship attacker-controlled SI rules / body grants / recipes.
  'packs.install',
  // Install seam 5c — pack install BY SLUG from the marketplace (the apex
  // `#packs/<slug>` detail/consent handoff + in-app Discover). Same `packs.`
  // reserved-prefix gate as `packs.install`.
  'packs.installBySlug',
  // Add-a-pack (a3efa387) — manifest-only preview for the paste-a-slug flow.
  // MUST be listed here so the ws-server boot guard accepts its wired handler
  // (`SERVER_RPC_METHOD_SET` derives from this array); same `packs.`
  // reserved-prefix gate keeps it off the MCP catalog.
  'packs.resolveBySlug',
  'packs.list',
  'packs.uninstall',
  // D-170 — ingredient-authoring install / uninstall. Per-pair only;
  // `ingredient.` in MCP_RESERVED_RPC_PREFIXES so MCP-channel agents
  // cannot author / install / uninstall their own capability surface.
  'ingredient.install',
  'ingredient.uninstall',
  // D-170 N.4 / N.15 / #2 — authoring-side draft store +
  // test-before-save preview/decompose.
  // Same `ingredient.` reserved-prefix posture (MCP agents cannot author /
  // preview their own capability surface).
  'ingredient.draft.save',
  'ingredient.draft.list',
  'ingredient.draft.get',
  'ingredient.draft.delete',
  'ingredient.compose.decompose',
  'ingredient.saveAsNew',
  'ingredient.preview',
  // D-145 PA11 — Settings → Work Entities Source management.
  'work_entity.source.list',
  'work_entity.source.set_enabled',
  'work_entity.source.set_mcp_exposed',
  'work_entity.source.set_default',
  'work_entity.source.clear_default',
  // D-174 #22 — work-entity warehouse CRUD + timeline read (Data route).
  'work_entity.list',
  'work_entity.get',
  'work_entity.upsert',
  'work_entity.delete',
  // Accepted visitor intake responses — owner Data browser only.
  'form_response.list',
  'form_response.get',
  'form_response.set_state',
  'form_response.update',
  'form_response.export',
  // D-221 — owner-only pack Records explorer and lifecycle controls.
  'records.namespace.list',
  'records.kind.list',
  'records.search',
  'records.get',
  'records.delete',
  'records.quota.set',
  'records.quota.set_global',
  'records.retention.list',
  'records.retention.set',
  'records.retention.run',
  'records.export',
  'records.outbox.list',
  'records.outbox.retire',
  'records.purge',
  'records.accounting.audit',
  'records.accounting.repair',
  'data.timeline',
  'data.file.read',
  'data.mirror.search',
  'data.contact.engagements.list',
  'server.getBootstrap',
  'server.stageBootstrap',
  'server.requestRestart',
  'server.getStatus',
  'server.setPaused',
  'server.getPauseState',
  'server.setQualitySwitch',
  'server.getQualitySwitches',
  'server.getOAuthClientConfig',
  'server.getOAuthAppConfig',
  'server.setOAuthAppConfig',
  'server.clearOAuthAppConfig',
  'server.runPressureReclaim',
  'server.setPressureOverride',
  'server.requestShutdown',
  'server.getLifecycleState',
  'server.resetCrashLoop',
  'collection.list',
  'collection.search',
  'collection.get',
  'collection.runRetention',
  'collection.listEndpoints',
  'collection.mail.enrollOAuth',
  // D-177 N.12 — `collection.mail.send` is DELIBERATELY ABSENT from the
  // wire method set: outbound mail is a side-effecting action, and every
  // action is gated at the ONE enforcement boundary (the gateway, via the
  // contract's per-entity_action policy). The `recued/mail-send` kernel
  // ingredient is the gated entry point (the outbound-send escalation in
  // `preflight-gate.ts` lifts it to `ask`); the server-side
  // `handleCollectionMailSend` is the gateway's INTERNAL executor, called
  // directly by the kernel `mailSend` dispatcher AFTER the gate decides —
  // never reachable as a wire rpc (no paired client, no MCP). Re-adding it
  // here would re-open a trust-bypass; the d-177-n12 ratchet test fails if
  // it ever returns to the wire surface or the MCP catalog.
  // D-127 wire-up — IMAP enroll + listing for picker resolution
  'collection.mail.enrollImap',
  'collection.mail.list',
  'collection.mail.delete',
  // D-120 Phase 7 — unified memory export pair. D-157 P0 deleted the
  // legacy `audit.*` read-rpc family, leaving these two.
  'audit.export.estimate',
  'audit.export.page',
  // D-198 — owner-trusted memory management over the D-120 data.memory.*
  // store. Handlers wired in Slice 1+; declared here so the surface is
  // complete. In-array-without-handler is boot-safe: ws-server's wire check
  // rejects only a WIRED method missing from the set, never the reverse
  // (db-less harnesses rely on that direction).
  'memory.list',
  'memory.get',
  'memory.create',
  'memory.update',
  'memory.delete',
  'memory.import',
  'triggers.list',
  'triggers.create',
  'triggers.update',
  'triggers.delete',
  'triggers.createElementWatch',
  'collection.resync',
  'collection.deleteRecord',
  // Phase 7 (D-110) — file-adapter enroll family + cross-type list.
  'collection.file.enroll',
  'collection.file.update',
  'collection.file.delete',
  'collection.file.resync',
  'collection.listInstances',
  // D-117 Phase 7 — calendar enroll family.
  'collection.calendar.enrollOAuth',
  // ⚠ Adding a method to the `ServerRpcRegistry` TYPE above is not enough — this
  // runtime list is a second, independent source of truth, and `ws-server.ts`
  // THROWS at wire time for a handler whose method is missing here. A type-only
  // addition therefore typechecks clean, passes every handler unit test, and
  // then refuses to boot the server.
  'collection.calendar.attachGraphGrant',
  'collection.calendar.enrollBasic',
  'collection.calendar.list',
  'collection.calendar.update',
  'collection.calendar.delete',
  'collection.calendar.resync',
  'collection.calendar.reauth',
  // D-118 — service enroll family.
  'collection.service.list',
  'collection.service.listTemplates',
  'collection.service.enroll',
  'collection.service.install',
  'collection.service.upgrade',
  'collection.service.uninstall',
  'collection.service.update',
  'collection.service.delete',
  'collection.service.clear_crash',
  'collection.service.start',
  'collection.service.stop',
  'collection.service.restart',
  'server.archive.export',
  'server.archive.status',
  'server.archive.import',
  // M4b.1 — archive upload control plane (chunk bytes ride the dedicated binary
  // `/ws/archive-upload` socket, not rpc). Owner-only; off MCP by omission.
  'server.archive.upload.create',
  'server.archive.upload.probe',
  'server.archive.upload.finalize',
  'server.archive.upload.delete',
  // D-145 PB12 — S2S Preview consumer rpc. `s2s_preview.build`
  // strict-picks raw input through the per-kind `fields_visible`
  // closed list + per-kind transformation, persists the packet
  // under an opaque access token, emits `redacted_packet.built`
  // audit. `s2s_preview.consume` validates the token, checks
  // expiry, returns the persisted packet, emits
  // `redacted_packet.accessed` audit.
  's2s_preview.build',
  's2s_preview.consume',
  // D-137 P1 — AI Chat (Wire A). Ten methods; mirrors the closed
  // `CHAT_RPC_METHODS` list in `../chat.ts`. Substrate-level
  // registration; the per-method handlers land in the next P1 slice
  // (`backend/server/src/chat-handler.ts`). The contracts-side
  // ratchet (`__tests__/d-137-phase-1-chat.test.ts`) asserts the
  // closed list shape; a ratchet in this file asserts the dispatcher's
  // known-method set carries every chat method.
  'chat.sessions.list',
  'chat.session.get',
  'chat.session.create',
  'chat.session.delete',
  'chat.session.export',
  'chat.egress.get',
  'chat.send',
  'chat.data_diagnosis.resolve',
  'chat.plans.pending.list',
  'chat.plan.approve',
  'chat.plan.cancel',
  'chat.execution.feedback',
  'chat.execution.feedback.retract',
  'chat.execution.diagnostics',
  // D-219 item 2 — the owner-facing corpus view + its unlearn.
  'chat.execution.learned',
  'chat.execution.forget',
  'chat.execution.draft_recipe',
  'chat.execution.authored',
  'chat.session.set_picker',
  'chat.session.set_model_pref',
  // D-167 chat provider-threading — override lifecycle + global default.
  'chat.session.clear_model_pref',
  'chat.default_model_pref.get',
  'chat.default_model_pref.set',
  // D-137 W2.2 § A.1.1 — Mary's per-kind catalog scope.
  'chat.tool_catalog.get',
  'chat.tool_catalog.set',
  // D-137 W2.3 § A.1.1 + § A.10 — Mary's per-connection MCP tool
  // annotation. Three methods; substrate ships persisted-annotation
  // CRUD + broadcast + audit. The MCP probe wiring (which populates
  // `tools_list_cache` automatically) lands in a later slice; until
  // then the rpc accepts caller-supplied descriptors so Settings UI +
  // tests can populate the substrate.
  'chat.connection_mcp.list',
  'chat.connection_mcp.get',
  'chat.connection_mcp.set',
  // D-137 P4 § A.7 + § A.7.1 — Picker projection + refresh. Reuses
  // the per-pair annotation store as its backing; the refresh rpc
  // emits `chat.picker_entries_changed` alongside the existing
  // `chat.connection_mcp_annotation_changed` broadcast so paired
  // clients re-render the picker dropdown without re-querying.
  'chat.picker.entries',
  'chat.picker.refresh',
  // D-137 P5 follow-on § A.9 — Inbound MCP token registry. Six
  // methods; reserved for local-UI only (`chat.inbound_token.` is in
  // `MCP_RESERVED_RPC_PREFIXES`). The verifier swap-in at the MCP
  // HTTP port handler shares the same `SqliteMcpInboundTokenStore`
  // these handlers persist through.
  'chat.inbound_token.list',
  'chat.inbound_token.get',
  'chat.inbound_token.issue',
  'chat.inbound_token.update_grants',
  // D-171 slice 3 — rebind the bound `contract_id` in place (lazy cap/expiry).
  'chat.inbound_token.update_contract',
  'chat.inbound_token.revoke',
  'chat.inbound_token.delete',
  // D-171 slice 2c — the grant checklist's live self tool catalog (read-only;
  // local-UI only via the `chat.inbound_token.` reserved prefix).
  'chat.inbound_token.tool_catalog',
  // D-148 W3.FU — Per-path Exposure state mutators (local-UI only;
  // namespace excluded from MCP catalog by ratchet — see
  // `packages/contracts/src/mcp-tool-catalog.ts`).
  'exposure.apply_preset',
  'exposure.set_path_resolution',
  'exposure.set_public_mcp_acknowledgement',
  // R26.2 Delta 1 — exposure read (cold-load hydration for the grid).
  'exposure.get',
  // R26.2 Delta 2 — apex (`GET /`) serving-mode setter.
  'exposure.set_apex',
  // D-148 follow-up #4 — BYO cert upload rpc surface for the
  // Settings → Server → TLS Certificates page (W3.8). Reserved for
  // local-UI only — `tls_domain.*` is in `MCP_RESERVED_RPC_PREFIXES`.
  'tls_domain.upload',
  'tls_domain.remove',
  'tls_domain.list',
  // D-148 follow-up #5 — Pro auto-managed `<handle>.recued.cloud`
  // unbind rpc. Reserved for local-UI only — `pro_acme.` is in
  // `MCP_RESERVED_RPC_PREFIXES`.
  'pro_acme.unbind',
  // D-149 P3 § A.3 — Public Reception registry rpc surface;
  // reserved for local-UI only — `reception.` is in
  // `MCP_RESERVED_RPC_PREFIXES`. The closed list mirrors
  // `RECEPTION_RPC_METHODS` (a P3 ratchet test asserts both lists
  // agree).
  'reception.endpoints.list',
  'reception.endpoint.preview_draft',
  'reception.endpoint.create',
  'reception.endpoint.rotate_token',
  'reception.endpoint.enable',
  'reception.endpoint.disable',
  'reception.endpoint.revoke',
  'reception.endpoint.extend',
  'reception.endpoint.access_log',
  // D-200 Slice 6g.3 — paired-client intake-form/recipe authoring.
  'reception.intake_recipe_pair.get',
  'reception.intake_recipe_pair.bind',
  'reception.intake_recipe_pair.configure',
  'reception.intake_recipe_pair.clear',
  // D-210 step 2a — the record read surface. Admin-only like every `reception.` method; the
  // reserved prefix keeps it off MCP.
  'reception.record.list',
  // D-210 Appendix B — mint an on-the-go reschedule link. Admin-only; reserved prefix.
  'reception.manage.mint',
  // D-200 Slice 6g.14 — exact-submission recovery remains owner-local.
  'reception.emergency_disable_all',
  // D-149 P4 § A.5.1 — singleton config rpcs (admin-only; `reception.`
  // reserved prefix keeps them off MCP).
  'reception.page.get',
  'reception.page.upsert',
  // D-149 P12 § A.20.5 — Abuse Inbox rpc trio (admin-only; `reception.`
  // reserved prefix keeps them off MCP).
  'reception.abuse_inbox.list',
  'reception.abuse_inbox.ban_ip',
  'reception.abuse_inbox.unban_ip',
  // D-149 follow-on § A.10 — Templates browser wire (admin-only; `reception.`
  // reserved prefix keeps it off MCP).
  'reception.template.list',
  // D-151 P2 — intent-first Compose proposal (admin-only; server-side AI
  // through `executeRecuedRequest`, never webclient-side engine code).
  'reception.compose.propose',
  // D-173 N.2 — Reception Inbox rpc trio (admin-only; `reception.` reserved
  // prefix keeps them off MCP). Routes the review-then-approve inbox;
  // `approve` is the sole `checkpoint.arg_overrides` writer (N.5 boundary).
  'reception.inbox.list',
  'reception.inbox.approve',
  'reception.inbox.reject',
  // D-175 P5 — recued.com account binding pair-RPC. Reserved local-UI
  // only — `account.` is in `MCP_RESERVED_RPC_PREFIXES` (the MCP ratchet
  // asserts the prefix stays reserved).
  'account.bind',
  'account.unbind',
  'account.bindingStatus',
  // D-175 P8 — Pro convenience status. Reserved local-UI only —
  // `pro_convenience.` is in `MCP_RESERVED_RPC_PREFIXES` (the MCP ratchet
  // asserts the prefix stays reserved).
  'pro_convenience.status',
  // R27 delta-B — user-initiated DDNS pause/resume. Reserved local-UI /
  // owner only — `ddns.` is in `MCP_RESERVED_RPC_PREFIXES` (the MCP ratchet
  // asserts the prefix stays reserved).
  'ddns.status',
  'ddns.setEnabled',
  // Supervision (cli-daemon keep-alive) rpc. Reserved local-UI / owner only —
  // `supervision.` is in `MCP_RESERVED_RPC_PREFIXES` (the MCP ratchet asserts
  // the prefix stays reserved).
  'supervision.set',
  'supervision.list',
  'supervision.status',
  // D-178 — release/update rpc. Reserved local-UI / owner only —
  // `update.` is in `MCP_RESERVED_RPC_PREFIXES` (the MCP ratchet asserts
  // the prefix stays reserved).
  'update.check',
  'update.mode',
  'update.set_mode',
  'update.apply',
  'update.rollback',
  'update.operation_status',
  'update.operation_close',
  // D-182 §7.2 — cli reachability grid rpc. Reserved local-UI / owner only —
  // `cli.reachability.` is in `MCP_RESERVED_RPC_PREFIXES` (the MCP ratchet
  // asserts the prefix stays reserved).
  'cli.reachability.list',
  'cli.reachability.universe',
  'cli.reachability.set',
] as const satisfies readonly (keyof ServerRpcRegistry)[];

/** The same list as a Set for O(1) lookup. */
export const SERVER_RPC_METHOD_SET: ReadonlySet<string> = new Set(SERVER_RPC_METHODS);
