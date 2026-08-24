/** D-137 P1.2 — rpc handlers for `chat.*` (Wire A).
 *
 *  Ten methods per the closed `ChatRpcMethod` list:
 *    - `chat.sessions.list` / `chat.session.get` / `chat.session.create`
 *      / `chat.session.delete` / `chat.session.export`
 *    - `chat.send` — fires the orchestrator's `runTurn` and returns
 *      the `turn_id` ack at the turn's COMMIT POINT (ack-before-run:
 *      the user message is durable, the model-bound body still runs);
 *      events stream back via the D-121 broadcast bus (orchestrator
 *      emits per § Wire A; a post-accept shell failure surfaces as
 *      `engine.turn_failed` transparency from the completion watcher)
 *    - `chat.plan.approve` / `chat.plan.cancel` — resolve the shared durable
 *      reviewed-action record and broadcast the terminal plan state
 *    - `chat.session.set_picker` / `chat.session.set_model_pref` —
 *      session-state writes; emit `chat.session_changed` on success
 *
 *  Per § Wire A — handlers run **server-side**. Webclient is display +
 *  HID; the orchestrator's loop runs in-process here.
 *
 *  Per D-137 contract tightening — sessions, messages, and reviewed-action
 *  recovery records persist in the core chat tables (per-pair only; no
 *  cross-cloud sync per D-097 / D-168).
 *  The handler does NOT decrypt content on the chat.sessions.list path
 *  (would defeat the encrypted-at-rest invariant); list returns the
 *  per-session summary shape from `ChatSessionSummary` only.
 *
 *  No new error codes — re-uses `not_found` (404), `bad_request` (400),
 *  `not_configured` (501; reserved by the dispatcher for unwired
 *  methods; plan approval uses it when its store is unwired).
 */

import { randomUUID } from 'node:crypto';
import {
  CHAT_MODEL_ROUTING_LAYER_SET,
  CHAT_MODEL_SOURCE_ID_SET,
  CHAT_SESSION_CHANGED_FIELD_SET,
  CHAT_TOOL_CATALOG_SCOPE_VALIDATION_ISSUE_CODES,
  CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES,
  MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES,
  RpcError,
  buildDefaultConnectionMcpAnnotation,
  isChatDataDiagnosisIntent,
  isChatDataDiagnosisRelationship,
  isChatDataDiagnosisResolutionStatus,
  isChatMessageRole,
  isExecutionCaseFeedbackKind,
  isChatModelHint,
  isChatModelSourceId,
  isReservedOwnerContractId,
  isReservedPublicContractId,
  validateChatToolCatalogScopeInput,
  validateConnectionMcpAnnotationInput,
  validateInboundTokenChatModeUpdate,
  validateMcpInboundTokenInput,
  type ChatEgressPacket,
  type ChatDataDiagnosisContext,
  type ChatDataDiagnosisRequest,
  type ChatDataDiagnosisResolution,
  type ChatMessage,
  type ChatModelHint,
  type ChatModelRoutingLayer,
  type ChatModelSourceId,
  type ChatPickerTarget,
  type ChatPlanProposal,
  type ChatPlanRecord,
  type ChatSession,
  type ChatSessionChangedField,
  type ChatSessionSummary,
  type ChatToolCatalogScopeState,
  type ConnectionMcpAnnotationState,
  type ExecutionCaseLearnedEntry,
  type RecipeDefinition,
  type HandlerSlice,
  type IngredientKind,
  type IssuedMcpInboundToken,
  type McpInboundTokenRecord,
  type RecuedServerSignature,
  type ServerRpcRegistry,
  type ToolEntry,
} from '@recued/contracts';
import type {
  CaseRecipeDraftOutcome,
} from './execution-case-recipe-draft.js';
import { planApproval as planApprovalModule } from '@recued/gateway';
import type { AuditLogStore } from '@recued/storage';
import type { WsClient } from './ws-server.js';
import type { ChatBroadcastEmitter } from './chat-orchestrator.js';
import type { ChatOrchestrator } from './chat-orchestrator.js';
import type { ChatStore } from './storage/chat-store.js';
import type { ChatToolCatalogStore } from './storage/chat-tool-catalog-store.js';
import type { ChatConnectionMcpStore } from './storage/chat-connection-mcp-store.js';
import type { ChatInboundTokenStore } from './storage/chat-inbound-token-store.js';
import { PEER_HANDLE_CONFLICT_PREFIX } from './storage/chat-inbound-token-store.js';
import type {
  ExecutionCaseFeedbackRecorder,
  ExecutionCaseFeedbackTarget,
} from './execution-case-feedback.js';
import type {
  ExecutionCaseLifecycle,
} from './chat-execution-case-tools.js';
import type {
  ExecutionSpanAnchorStore,
} from './storage/execution-span-anchor-store.js';

export interface ChatRpcDeps {
  store: ChatStore;
  /** D-137 W2.2 § A.1.1 — Mary's per-kind catalog scope store. When
   *  absent (dbless test harness, store unavailable), the tool-catalog
   *  rpcs throw `not_configured` (501) so callers see a stable refusal
   *  rather than silent default behaviour. */
  toolCatalogStore?: ChatToolCatalogStore;
  /** D-137 W2.3 § A.1.1 + § A.10 — Mary's per-connection MCP tool
   *  annotation store. When absent, the `chat.connection_mcp.*` rpcs
   *  throw `not_configured` (501) — same posture as the per-kind scope
   *  store. */
  connectionMcpStore?: ChatConnectionMcpStore;
  /** D-228 slice 4 — how many of a peer's tools are reachable as governed pack
   *  operations. The picker's visibility predicate: it used to count tools the
   *  owner had classified in `tool_overrides`, which no longer exists, so a peer
   *  with working tools would otherwise vanish from the scope switcher.
   *
   *  ⚠ Absent ⇒ zero ⇒ no peer surfaces, which is the pre-existing
   *  "nothing classified yet" posture rather than a new failure mode. */
  connectionMcpCoveredToolCount?: (connection_name: string) => number;
  /** D-137 P3 § A.11 — Mary's plan-approval registry. Same store the
   *  orchestrator's `dispatchTool` gate consults;
   *  the rpc handlers flip status on approve / cancel + emit the
   *  resolution broadcast. Optional — when undefined the approve /
   *  cancel rpcs surface `not_configured` (501) the same way the
   *  W2.2 / W2.3 stores do when their backing stores aren't wired. */
  planApprovalStore?: planApprovalModule.PlanApprovalStore;
  /** D-137 P5 follow-on § A.9 — Bob's per-pair inbound MCP token
   *  store. The six `chat.inbound_token.*` rpcs persist through this
   *  store; the verifier swap-in at the MCP HTTP port handler also
   *  consults the same instance via `verifyBearer`. Optional — when
   *  undefined every `chat.inbound_token.*` rpc surfaces
   *  `not_configured` (501) and door bearers are simply REJECTED.
   *  ⚠ There is no env fallback: this used to say the transport "falls
   *  back to the v1 `RECUED_MCP_HTTP_TOKEN` env-var path", which stopped
   *  being true when that path was retired — `wire-mcp-http-transport.ts`
   *  now 401s old env values, so an absent store means no door access at
   *  all, not degraded access. */
  inboundTokenStore?: ChatInboundTokenStore;
  /** D-214 owner-only typed completion-feedback lifecycle. */
  executionCaseFeedbackRecorder?: ExecutionCaseFeedbackRecorder;
  /** D-214 terminal plan resolutions can close a previously deferred span. */
  executionCaseLifecycle?: ExecutionCaseLifecycle;
  /** D-214 explicit conversational-continuation validator. The caller names a
   * same-session prior turn; the server resolves the root internally. */
  executionSpanAnchorStore?: ExecutionSpanAnchorStore;
  /** D-214 privacy cascade. Session deletion removes every derived span/case
   * source before the authoritative chat rows disappear. */
  deleteSessionExecutionCases?: (session_id: string) => Promise<number>;
  /** D-214 owner-only aggregate diagnostics. The producer returns no raw
   * intervention or model-facing records. */
  executionCaseDiagnostics?: () => Promise<unknown>;
  /** D-219 item 2 — what Recued has learned, projected for the owner through
   *  the SAME renderer the model-bound card uses. */
  executionCaseLearned?: () => Promise<ExecutionCaseLearnedEntry[]>;
  /** D-219 item 2 — unlearn one case: its source reports and the owner verdicts
   *  recorded against their roots, then a rebuild. */
  executionCaseForget?: (
    case_id: string,
  ) => Promise<{ removed: boolean; cases_remaining: number }>;
  /** D-219 — record that the owner saved a recipe drafted from a case. The
   *  server resolves the durable key and hashes the recipe; the caller asserts
   *  neither. */
  executionCaseAuthored?: (input: {
    case_id: string;
    recipe_id: string;
  }) => Promise<{ recorded: boolean }>;
  /** D-219 item 2b — draft a recipe from a case with the owner's own model.
   *  ⛔ Drafts, never saves: the Kitchen is where a person decides. */
  executionCaseDraftRecipe?: (input: {
    /** D-219 — the draft being refined. Shape-stripped before it reaches the
     *  model; never trusted as a recipe. */
    previous_recipe?: unknown;
    case_id: string;
    prompt: string;
  }) => Promise<CaseRecipeDraftOutcome>;
  /** D-171 slice 2c — the live self tool catalog source backing
   *  `chat.inbound_token.tool_catalog`. Wired at composition as a thin
   *  closure over the chat orchestrator's `InternalToolRegistry.list()` so
   *  the Permissions → MCP door grant checklist can render the live catalog
   *  + diff it against a token's grants. Read per-call (the registry is
   *  late-bound — installs / connection edits reshape the catalog without a
   *  restart). The provider MUST surface only the inbound-MCP-*grantable*
   *  surface — Tier 1 + 2; Tier 3 (`connection.mcp.*` passthroughs) are
   *  rejected on the inbound wire (`mcp-server.ts`), so the wiring filters
   *  them out (a Tier 3 grant could never make the tool callable). Optional —
   *  when undefined the rpc surfaces `not_configured` (501), the same posture
   *  as the stores above. */
  catalogProvider?: () => ReadonlyArray<ToolEntry>;
  /** D-221 §3.3.3 — preflight one newly allowed external MCP tool before
   * token issuance/grant replacement commits. Production resolves Tier 2
   * recipe tools against the live Records operation inventory.
   *
   */
  preflightExternalToolGrant?: (toolName: string) => void;
  /** Door standing closure, MCP arm — derive the operation closure a token's
   *  granted tools would run, so the owner's tick becomes a bounded list of op
   *  ids rather than an open promise.
   *
   *  ⛔ THE ONLY WAY A CLOSURE IS EVER PRODUCED. The wire carries a boolean;
   *  this computes what it means. Absent ⇒ `standing_closure: true` is REFUSED
   *  (not silently downgraded to off): a token issued as "won't ask" that then
   *  asks every time is a broken promise the owner acted on, and a harness
   *  missing this dep must not be able to mint one.
   *
   *  Production wires the SAME capability derivation the reception door bind
   *  uses, so a door and a token can never disagree about what a recipe does. */
  deriveGrantedToolClosure?: (
    grants: Readonly<Record<string, boolean>>,
  ) => ReadonlyArray<string>;
  /** Mint the limits-carrier contract a newly issued token binds to, returning
   *  its `contract_id`.
   *
   *  ⛔ ALWAYS-CONTRACTED. A token used to be UNBOUND by default: a contract
   *  was minted lazily by the Advanced panel only when the owner switched on a
   *  cap or an expiry, and unbound again when they switched the last one off —
   *  *"a contract exists ONLY while a limit is on"*. That left the common token
   *  with no contract at all, and the wire papering over it by synthesising
   *  `contract_id = mcp_token_id`: an id that names no row, indistinguishable
   *  downstream from a real one. Every token now carries a real contract from
   *  issuance, so lifetime, scope and revocation have exactly one home.
   *
   *  ⚠ CONTRACTED IS NOT BOUNDED. The carrier is minted with no `expiry_at` and
   *  no `max_uses` — absent means unbounded — so this does NOT make a token
   *  limited on its own — a token issued WITHOUT the standing tick carries no
   *  limits, because the owner is the bound when every write asks. What this
   *  removes is the id that pointed at nothing. */
  mintTokenContract?: (input: {
    label: string;
    /** The owner-confirmed closure, minted onto `scope.operation_ids` with
     *  `door_execution_policy.standing_closure`. */
    standingClosureOperationIds?: ReadonlyArray<string>;
    /** `expiry_at` / `max_uses` for the carrier. */
    limits?: { readonly max_uses?: number; readonly expiry_at?: number };
  }) => string;
  /** Revoke a carrier this issuance minted, when the issuance then fails.
   *  Absent ⇒ the orphan is left (best-effort cleanup, never a hard dependency
   *  — the issuance error is what the caller needs to see). */
  revokeTokenContract?: (contractId: string) => void;
  orchestrator: ChatOrchestrator;
  broadcast?: ChatBroadcastEmitter;
  auditLog?: AuditLogStore;
  /** Recued server signature for `picker_at_send` defaults at session
   *  creation. Mirrors the orchestrator's `selfSignature` so a session
   *  created via rpc shares the same identity surface its turns run
   *  under. */
  selfSignature: RecuedServerSignature;
  /** Display name for `selfSignature` rendering. Defaults to `'Self'`. */
  selfDisplayName?: string;
  /** Inject a clock for tests. */
  now?: () => number;
  /** Inject id minting for tests. */
  mintId?: () => string;
  /** D-167 P5 S4 — purge the session's PII alias ledger on delete (spec
   *  §"Alias ledger" — a fresh ledger on resume is the safer privacy
   *  default). A decoupled callback over the orchestrator's RAM-only
   *  `SessionLedgerStore.drop`; absent / no-op when PII is unwired. */
  dropSessionPiiLedger?: (session_id: string) => void;
}

type ChatMethods =
  | 'chat.sessions.list'
  | 'chat.session.get'
  | 'chat.session.create'
  | 'chat.session.delete'
  | 'chat.session.export'
  | 'chat.egress.get'
  | 'chat.send'
  | 'chat.data_diagnosis.resolve'
  | 'chat.plans.pending.list'
  | 'chat.plan.approve'
  | 'chat.plan.cancel'
  | 'chat.execution.feedback'
  | 'chat.execution.feedback.retract'
  | 'chat.execution.diagnostics'
  | 'chat.execution.learned'
  | 'chat.execution.forget'
  | 'chat.execution.draft_recipe'
  | 'chat.execution.authored'
  | 'chat.session.set_picker'
  | 'chat.session.set_model_pref'
  | 'chat.session.clear_model_pref'
  | 'chat.default_model_pref.get'
  | 'chat.default_model_pref.set'
  | 'chat.tool_catalog.get'
  | 'chat.tool_catalog.set'
  | 'chat.connection_mcp.list'
  | 'chat.connection_mcp.get'
  | 'chat.connection_mcp.set'
  | 'chat.inbound_token.list'
  | 'chat.inbound_token.get'
  | 'chat.inbound_token.issue'
  | 'chat.inbound_token.update_grants'
  | 'chat.inbound_token.update_contract'
  | 'chat.inbound_token.revoke'
  | 'chat.inbound_token.delete'
  | 'chat.inbound_token.tool_catalog';

const safeLogActivity = async (
  auditLog: AuditLogStore | undefined,
  action: Parameters<AuditLogStore['logActivity']>[0]['action'],
  target: string,
  detail?: string,
): Promise<void> => {
  if (!auditLog) return;
  try {
    await auditLog.logActivity({
      activity_id: '',
      timestamp: Date.now(),
      action,
      target,
      ...(detail ? { detail } : {}),
    });
  } catch {
    // best-effort — never abort the rpc on audit failure
  }
};

const safeBroadcast = (
  broadcast: ChatBroadcastEmitter | undefined,
  field: ChatSessionChangedField,
  session_id: string,
  value: unknown,
): void => {
  if (!broadcast) return;
  if (!CHAT_SESSION_CHANGED_FIELD_SET.has(field)) return;
  try {
    broadcast.emit({
      kind: 'chat.session_changed',
      session_id,
      field,
      value,
    });
  } catch {
    // observability-only; never abort the rpc on emit failure
  }
};

const ensureSession = (deps: ChatRpcDeps, session_id: string): ChatSession => {
  const session = deps.store.getSession(session_id);
  if (!session) {
    throw new RpcError(
      'not_found',
      `chat: session ${session_id} not found`,
      404,
    );
  }
  return session;
};

const ensureNonEmptyString = (
  method: string,
  field: string,
  value: unknown,
): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RpcError(
      'bad_request',
      `${method}: ${field} is required`,
      400,
    );
  }
  return value;
};

/** § A.14 slot-aware chat routing — validate an OPTIONAL `model_hint`
 *  (the BYOK slot capability hint). Absent/null → `undefined` (the turn
 *  uses its default tier); a present-but-off-list value is a hard
 *  `bad_request` (never silently dropped). */
const ensureOptionalModelHint = (
  method: string,
  value: unknown,
): ChatModelHint | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isChatModelHint(value)) {
    throw new RpcError(
      'bad_request',
      `${method}: model_hint must be one of fast | quality | thinking`,
      400,
    );
  }
  return value;
};

/** Codex P2 fold (D-137 P1.2 review) — args type guard. Most handlers
 *  cast `args` as a structured shape and dereference fields without
 *  validating that `args` is an object first; missing / null / non-
 *  object payloads (callers sending garbage args) would produce
 *  uncoded `TypeError` → 500 `internal` instead of the expected
 *  `bad_request` 400 taxonomy. Match the connection-handler pattern. */
const ensureRecordArgs = (
  method: string,
  args: unknown,
): Record<string, unknown> => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new RpcError(
      'bad_request',
      `${method}: args must be an object`,
      400,
    );
  }
  return args as Record<string, unknown>;
};

/** Codex P2 fold (D-137 P1.2 review) — picker target prefix validator.
 *  Per § A.7 + § A.8 the picker target is either the literal `'self'`
 *  sentinel OR a `connection.mcp.<name>` identifier. Prefix-only gate;
 *  shape correctness check. Full existence validation against the
 *  annotation store (D-137 P4 § A.7.1 — peer must carry a probed
 *  Recued signature + project ≥1 visible tool) lives in
 *  `ensurePeerPickerTargetIsLive` below, which is called by handlers
 *  that mutate session state (`set_picker`, `send`). */
const ensureValidPickerTarget = (
  method: string,
  target: string,
): string => {
  if (target === 'self') return target;
  if (target.startsWith('connection.mcp.') && target.length > 'connection.mcp.'.length) {
    return target;
  }
  throw new RpcError(
    'bad_request',
    `${method}: picker_state.current must be 'self' or 'connection.mcp.<name>'`,
    400,
  );
};

/** D-137 P4 § A.7.1 — strict picker-target validator. Peer targets
 *  MUST correspond to a live `PickerEntry` (annotation row exists +
 *  carries `recued_signature` + projects ≥1 visible tool). Without
 *  this gate, `set_picker` would accept any well-shaped string and
 *  the orchestrator would later dispatch at a peer that doesn't exist
 *  / hasn't been probed / is a generic MCP without Recued metadata.
 *
 *  The annotation-store dep is optional — when absent (dbless test
 *  harness OR pre-store boot) the strict gate degrades to the prefix
 *  check from `ensureValidPickerTarget`. Production wiring always
 *  passes the store; the degraded path is a substrate-stays-reachable
 *  fallback, not a security hole. */
const ensurePeerPickerTargetIsLive = (
  method: string,
  target: string,
  _deps: ChatRpcDeps,
): void => {
  if (target === 'self') return;
  // ⛔ D-228 slice 5 — NO PEER TARGET IS VALID ANY MORE, so this refuses outright
  // instead of consulting a projection that no longer exists. It used to ask
  // `isValidPickerTarget` whether the peer had a live picker entry; the MCP
  // scope-picker is retired (dead on both ends, and its routing purpose is
  // subsumed — a peer's tools are minted into a local pack and reach chat as
  // ordinary `recued_op_*` operations governed by the contract).
  //
  // ⚠ STRICTLY TIGHTER, and deliberately still a REFUSAL rather than a silent
  // coercion to `'self'`: a caller asking to scope a conversation at a peer is
  // asking for something this server no longer does, and answering "fine, I
  // pointed you at yourself" would be a different conversation than the one
  // they asked for.
  throw new RpcError(
    'bad_request',
    `${method}: picker target '${target}' is not available — per-conversation peer `
    + 'scoping was retired. An enrolled MCP connection\'s tools are minted into a '
    + 'pack and are already callable from this conversation as pack operations.',
    400,
  );
};

export const handleSessionsList = (
  deps: ChatRpcDeps,
): { sessions: ChatSessionSummary[] } => {
  return { sessions: deps.store.listSessions() };
};

export const handleSessionGet = async (
  deps: ChatRpcDeps,
  args: { session_id: string },
): Promise<
  ChatSession & {
    messages: ChatMessage[];
    plans: ReadonlyArray<ChatPlanRecord>;
  }
> => {
  const safe = ensureRecordArgs('chat.session.get', args);
  const session_id = ensureNonEmptyString(
    'chat.session.get',
    'session_id',
    safe.session_id,
  );
  const session = ensureSession(deps, session_id);
  const messages = await deps.store.listMessages(session_id);
  const plans =
    deps.planApprovalStore?.listForSession === undefined
      ? []
      : await deps.planApprovalStore.listForSession(session_id);
  return { ...session, messages, plans };
};

/** Route-independent approval-inbox recovery. Unlike `chat.session.get`, this
 * reads only still-proposed plan records across sessions: no message history,
 * no execution resume, and no approval consumption. Unavailable encrypted
 * payloads remain visible as non-executable shells so the owner can safely
 * cancel them. */
export const handlePlansPendingList = async (
  deps: ChatRpcDeps,
): Promise<{ plans: ReadonlyArray<ChatPlanRecord> }> => {
  if (deps.planApprovalStore?.listPendingRecords === undefined) {
    throw new RpcError(
      'not_configured',
      'Durable Chat approval recovery is unavailable.',
      501,
    );
  }
  return {
    plans: await deps.planApprovalStore.listPendingRecords(),
  };
};

/** D-167 transparency — read back the aliased model-bound packets actually
 *  sent for an assistant message (the "what we sent to the LLM" surface, one
 *  per AI call). Lazy: the webclient calls this on expand, not in the message
 *  list. Empty array when nothing was captured (no AI call / pre-egress turn). */
export const handleEgressGet = async (
  deps: ChatRpcDeps,
  args: { session_id: string; message_id: string },
): Promise<{ packets: ChatEgressPacket[] }> => {
  const safe = ensureRecordArgs('chat.egress.get', args);
  const session_id = ensureNonEmptyString(
    'chat.egress.get',
    'session_id',
    safe.session_id,
  );
  const message_id = ensureNonEmptyString(
    'chat.egress.get',
    'message_id',
    safe.message_id,
  );
  ensureSession(deps, session_id);
  const packets = await deps.store.getEgress(session_id, message_id);
  return { packets };
};

export const handleSessionCreate = async (
  deps: ChatRpcDeps,
  args: { title?: string } | void,
): Promise<{ session_id: string }> => {
  const now = deps.now ?? Date.now;
  const mintId = deps.mintId ?? randomUUID;
  const session_id = mintId();
  // void args is the sidebar-create-no-title path; otherwise validate
  // shape per the Codex P2 fold + extract title.
  const safe = args === undefined ? {} : ensureRecordArgs('chat.session.create', args);
  const title =
    typeof safe.title === 'string' && safe.title.trim().length > 0
      ? safe.title
      : undefined;
  deps.store.createSession({
    id: session_id,
    ...(title ? { title } : {}),
    now: now(),
  });
  await safeLogActivity(
    deps.auditLog,
    'chat_session_created',
    session_id,
    JSON.stringify({
      ...(title ? { title } : {}),
      picker: 'self',
      // New sessions inherit the per-pair global chat-model default
      // (D-167 chat provider-threading); log the effective layer.
      model_layer: deps.store.getDefaultModelPref().layer,
      model_layer_inherited: true,
    }),
  );
  return { session_id };
};

export const handleSessionDelete = async (
  deps: ChatRpcDeps,
  args: { session_id: string },
): Promise<{ ok: true }> => {
  const safe = ensureRecordArgs('chat.session.delete', args);
  const session_id = ensureNonEmptyString(
    'chat.session.delete',
    'session_id',
    safe.session_id,
  );
  const session = ensureSession(deps, session_id);
  const messageCount = (await deps.store.listMessages(session_id)).length;
  await deps.deleteSessionExecutionCases?.(session_id);
  const deleted = deps.store.deleteSession(session_id);
  if (!deleted) {
    // Race: session vanished between ensureSession + delete; surface
    // as 404 so the caller knows the post-state.
    throw new RpcError('not_found', `chat: session ${session_id} not found`, 404);
  }
  void session;
  // D-167 P5 S4 — purge the session's PII alias ledger (RAM-only). The
  // session's encrypted rows are gone; its alias mapping must not linger.
  deps.dropSessionPiiLedger?.(session_id);
  await safeLogActivity(
    deps.auditLog,
    'chat_session_deleted',
    session_id,
    JSON.stringify({ message_count_deleted: messageCount }),
  );
  return { ok: true };
};

export interface ChatExportBundle {
  session: ChatSession;
  messages: ChatMessage[];
  format: 'json';
  exported_at: number;
  recued_signature: RecuedServerSignature;
}

export const handleSessionExport = async (
  deps: ChatRpcDeps,
  args: { session_id: string },
): Promise<ChatExportBundle> => {
  const safe = ensureRecordArgs('chat.session.export', args);
  const session_id = ensureNonEmptyString(
    'chat.session.export',
    'session_id',
    safe.session_id,
  );
  const session = ensureSession(deps, session_id);
  const messages = await deps.store.listMessages(session_id);
  const now = deps.now ?? Date.now;
  await safeLogActivity(
    deps.auditLog,
    'chat_export',
    session_id,
    JSON.stringify({ message_count: messages.length, format: 'json' }),
  );
  // Quick filter — drop tool / system roles for export sanity; renderer
  // surfaces them in-app but export is conversation-centric.
  void messages.find((m) => !isChatMessageRole(m.role));
  return {
    session,
    messages,
    format: 'json',
    exported_at: now(),
    recued_signature: deps.selfSignature,
  };
};

export const handleSend = async (
  deps: ChatRpcDeps,
  args: {
    session_id: string;
    message: string;
    picker_state: { current: string };
    model_pref?: { current: string; model_hint?: string; source_id?: string };
    /** D-193 — requesting user's IANA timezone (webclient-supplied). */
    time_zone?: string;
    /** Optional lineage from the webclient's explicit verify-before-retry
     * handoff. The server validates the named action before accepting it. */
    retry_of_plan_id?: string;
    /** Optional explicit continuation of a prior same-session turn. This is a
     * conversational edge only; it carries no dispatch or approval authority. */
    continuation_of_turn_id?: string;
    /** Evidence-only grounding for a guided Data explanation or safe check. */
    data_diagnosis?: ChatDataDiagnosisRequest;
  },
): Promise<{
  turn_id: string;
  data_diagnosis?: ChatDataDiagnosisContext;
}> => {
  const safe = ensureRecordArgs('chat.send', args);
  const session_id = ensureNonEmptyString(
    'chat.send',
    'session_id',
    safe.session_id,
  );
  ensureSession(deps, session_id);
  // D-172 P2 — a turn may be a wordless FILE DROP, mirroring messenger. The
  // message is still required to be a string, and still required to be
  // non-empty when nothing is attached: an empty turn with no file is a
  // no-op the model would be paid to answer.
  const rawMessage = typeof safe.message === 'string' ? safe.message : '';
  // D-172 P2 — attachments the owner added to this turn. Ids only; the bytes
  // went up the binary upload socket and were finalized before this call.
  // ⛔ VALIDATED, NOT TRUSTED: this is untrusted wire input, and a malformed
  // entry that reached the store would produce a message row whose attachment
  // cannot be named — the exact "announces a file it cannot describe" shape the
  // marker refuses. A bad entry is DROPPED rather than rejecting the turn: the
  // person's message is the thing that matters, and failing their whole send
  // over a mangled ref would be the worse trade.
  const attachments = Array.isArray(safe.attachments)
    ? safe.attachments.flatMap((raw) => {
      if (raw === null || typeof raw !== 'object') return [];
      const file_id = (raw as { file_id?: unknown }).file_id;
      const media_class = (raw as { media_class?: unknown }).media_class;
      if (typeof file_id !== 'string' || file_id.length === 0) return [];
      return [{
        file_id,
        media_class: typeof media_class === 'string' && media_class.length > 0
          ? media_class
          : 'other',
      }];
    })
    : [];

  const message = attachments.length > 0
    ? rawMessage
    : ensureNonEmptyString('chat.send', 'message', safe.message);

  const pickerArg = safe.picker_state;
  if (
    !pickerArg
    || typeof pickerArg !== 'object'
    || typeof (pickerArg as { current?: unknown }).current !== 'string'
    || ((pickerArg as { current: string }).current.length === 0)
  ) {
    throw new RpcError(
      'bad_request',
      'chat.send: picker_state.current is required',
      400,
    );
  }
  const pickerCurrent = ensureValidPickerTarget(
    'chat.send',
    (pickerArg as { current: string }).current,
  );
  // D-137 P4 § A.7.1 — strict per-pair gate: peer targets MUST be live
  // picker entries. Substrate-level invariant — without this the
  // orchestrator would later dispatch at an unprobed peer.
  ensurePeerPickerTargetIsLive('chat.send', pickerCurrent, deps);
  let modelPref:
    | {
        current: ChatModelRoutingLayer;
        model_hint?: ChatModelHint;
        source_id?: ChatModelSourceId;
      }
    | undefined;
  const modelArg = safe.model_pref;
  if (modelArg !== undefined && modelArg !== null) {
    if (
      typeof modelArg !== 'object'
      || typeof (modelArg as { current?: unknown }).current !== 'string'
      || !CHAT_MODEL_ROUTING_LAYER_SET.has(
        (modelArg as { current: string }).current as ChatModelRoutingLayer,
      )
    ) {
      throw new RpcError(
        'bad_request',
        `chat.send: model_pref.current must be one of local | free_pool | byok`,
        400,
      );
    }
    const sendHint = ensureOptionalModelHint(
      'chat.send',
      (modelArg as { model_hint?: unknown }).model_hint,
    );
    // D-191 Phase 6 — an OPTIONAL per-turn exact-slot pick, same shape and
    // leniency as `chat.session.set_model_pref` (missing / malformed → no
    // pin, the turn falls back to `model_hint` routing). Previously chat.send
    // dropped this field entirely, so a wire client could override the LAYER
    // per turn but never correct a session-inherited slot pin — the
    // orchestrator's field-wise resolution then mixed the turn's layer with
    // the session's pin (see the layer-consistency clause at the executor's
    // pin site for the unsatisfiable `free_pool`×slot case this minted).
    const sendSourceIdRaw = (modelArg as { source_id?: unknown }).source_id;
    const sendSourceId = isChatModelSourceId(sendSourceIdRaw)
      ? sendSourceIdRaw
      : undefined;
    modelPref = {
      current: (modelArg as { current: string }).current as ChatModelRoutingLayer,
      ...(sendHint ? { model_hint: sendHint } : {}),
      ...(sendSourceId ? { source_id: sendSourceId } : {}),
    };
  }
  // D-193 — the requesting user's IANA timezone (webclient supplies it via
  // `Intl…resolvedOptions().timeZone`). Untrusted; a bad value degrades to
  // server-local in `formatChatCurrentDate`, so accept any non-empty string.
  const timeZoneArg = safe.time_zone;
  const time_zone =
    typeof timeZoneArg === 'string' && timeZoneArg.trim().length > 0
      ? timeZoneArg.trim()
      : undefined;
  let continuation_of_turn_id: string | undefined;
  if (safe.continuation_of_turn_id !== undefined) {
    continuation_of_turn_id = ensureNonEmptyString(
      'chat.send',
      'continuation_of_turn_id',
      safe.continuation_of_turn_id,
    );
    const origin = deps.executionSpanAnchorStore?.getAnchor(
      session_id,
      continuation_of_turn_id,
    );
    if (!origin) {
      throw new RpcError(
        deps.executionSpanAnchorStore ? 'bad_request' : 'not_configured',
        deps.executionSpanAnchorStore
          ? 'chat.send: continuation_of_turn_id must name an anchored prior turn in this session'
          : 'chat.send: conversational continuation history is unavailable',
        deps.executionSpanAnchorStore ? 400 : 501,
      );
    }
  }
  if (
    safe.retry_of_plan_id !== undefined
    && safe.data_diagnosis !== undefined
  ) {
    throw new RpcError(
      'bad_request',
      'chat.send: data diagnosis cannot also request a retry',
      400,
    );
  }
  let retry_of_plan_id: string | undefined;
  if (safe.retry_of_plan_id !== undefined) {
    retry_of_plan_id = ensureNonEmptyString(
      'chat.send',
      'retry_of_plan_id',
      safe.retry_of_plan_id,
    );
    if (deps.planApprovalStore?.listForSession === undefined) {
      throw new RpcError(
        'not_configured',
        'chat.send: verify-before-retry history is unavailable',
        501,
      );
    }
    const records = await deps.planApprovalStore.listForSession(session_id);
    const origin = records.find(
      (record) => record.plan.plan_id === retry_of_plan_id,
    );
    const retryableFailure =
      origin?.execution?.status === 'failed'
      && origin.execution.reason !== 'run_cancelled';
    if (
      origin === undefined
      || origin.plan.status !== 'approved'
      || origin.plan.consumed_at === undefined
      || origin.payload_available !== true
      || (origin.execution?.status !== 'unknown' && !retryableFailure)
    ) {
      throw new RpcError(
        'bad_request',
        'chat.send: retry_of_plan_id must name a recoverable uncertain '
          + 'action in this session',
        400,
      );
    }
  }
  let data_diagnosis: ChatDataDiagnosisContext | undefined;
  if (safe.data_diagnosis !== undefined) {
    const diagnosisArg = safe.data_diagnosis;
    if (
      diagnosisArg === null
      || typeof diagnosisArg !== 'object'
      || Array.isArray(diagnosisArg)
    ) {
      throw new RpcError(
        'bad_request',
        'chat.send: data_diagnosis must be an object',
        400,
      );
    }
    const diagnosis = diagnosisArg as Record<string, unknown>;
    const plan_id = ensureNonEmptyString(
      'chat.send',
      'data_diagnosis.plan_id',
      diagnosis.plan_id,
    );
    const run_id = ensureNonEmptyString(
      'chat.send',
      'data_diagnosis.run_id',
      diagnosis.run_id,
    );
    if (
      diagnosis.intent !== undefined
      && !isChatDataDiagnosisIntent(diagnosis.intent)
    ) {
      throw new RpcError(
        'bad_request',
        'chat.send: data_diagnosis.intent must be explanation or safe_check',
        400,
      );
    }
    if (
      diagnosis.relationship !== undefined
      && !isChatDataDiagnosisRelationship(diagnosis.relationship)
    ) {
      throw new RpcError(
        'bad_request',
        'chat.send: data_diagnosis.relationship must be one of '
          + 'action | involved | derived',
        400,
      );
    }
    if (deps.planApprovalStore?.listForSession === undefined) {
      throw new RpcError(
        'not_configured',
        'chat.send: data diagnosis history is unavailable',
        501,
      );
    }
    const records = await deps.planApprovalStore.listForSession(session_id);
    const origin = records.find((record) => record.plan.plan_id === plan_id);
    if (
      origin === undefined
      || origin.plan.status !== 'approved'
      || origin.plan.consumed_at === undefined
      || origin.execution === undefined
    ) {
      throw new RpcError(
        'bad_request',
        'chat.send: data_diagnosis.plan_id must name a consumed action '
          + 'with execution history in this session',
        400,
      );
    }
    const receiptRunId =
      'run_id' in origin.execution
      && typeof origin.execution.run_id === 'string'
      && origin.execution.run_id.length > 0
        ? origin.execution.run_id
        : undefined;
    if (receiptRunId !== undefined && receiptRunId !== run_id) {
      throw new RpcError(
        'bad_request',
        'chat.send: data_diagnosis.run_id does not match the action receipt',
        400,
      );
    }
    data_diagnosis = {
      kind: 'data_verification',
      plan_id,
      run_id,
      intent: isChatDataDiagnosisIntent(diagnosis.intent)
        ? diagnosis.intent
        : 'explanation',
      run_correlation:
        receiptRunId === run_id ? 'matched' : 'unverified',
      ...(isChatDataDiagnosisRelationship(diagnosis.relationship)
        ? { relationship: diagnosis.relationship }
        : {}),
    };
  }
  // Ack-before-run — resolve the rpc at the turn's COMMIT POINT (the
  // user message durably appended; `on_accepted` fires) instead of at
  // turn completion, so a legitimately-slow model can no longer
  // surface as a misleading `rpc chat.send timeout`. Caller-reason
  // failures (unknown session, a locked vault failing the chat-tail
  // read) still throw BEFORE the seam fires and reject the rpc exactly
  // as before. The detached completion promise is WATCHED, never
  // dropped: a post-accept shell throw can't reject the resolved rpc,
  // so it surfaces as the failure-class `engine.turn_failed`
  // transparency event (the PB7 failure paint renders it under the
  // turn; § B.15 user-must-see) + the error detail in the server log
  // (the event payload is deliberately bare — error text can carry
  // user content). An orchestrator that never fires the seam (a
  // stub / fake in tests) degenerates to the old ack-after-run shape.
  return new Promise<{
    turn_id: string;
    data_diagnosis?: ChatDataDiagnosisContext;
  }>((resolve, reject) => {
    let acceptedTurnId: string | null = null;
    deps.orchestrator
      .runTurn({
        session_id,
        message,
        ...(attachments.length > 0 ? { attachments } : {}),
        picker_state: {
          current: pickerCurrent as ChatPickerTarget,
        },
        ...(modelPref ? { model_pref: modelPref } : {}),
        ...(time_zone ? { time_zone } : {}),
        ...(continuation_of_turn_id
          ? { continuation_of_turn_id }
          : {}),
        ...(retry_of_plan_id ? { retry_of_plan_id } : {}),
        ...(data_diagnosis ? { data_diagnosis } : {}),
        on_accepted: (ack) => {
          acceptedTurnId = ack.turn_id;
          resolve({
            turn_id: ack.turn_id,
            ...(data_diagnosis ? { data_diagnosis } : {}),
          });
        },
      })
      .then((full) => {
        if (acceptedTurnId === null) {
          resolve({
            turn_id: full.turn_id,
            ...(data_diagnosis ? { data_diagnosis } : {}),
          });
        }
      })
      .catch((err) => {
        if (acceptedTurnId === null) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        console.error('[chat] turn failed after accept', err);
        if (deps.broadcast) {
          try {
            deps.broadcast.emit({
              kind: 'chat.transparency',
              session_id,
              turn_id: acceptedTurnId,
              event: { kind: 'engine.turn_failed' },
            });
          } catch {
            // Broadcast failures are observability-only.
          }
        }
      });
  });
};

/** Persist the owner's explicit closure of one completed safe-check answer.
 * The exact assistant row and durable safe-check intent are required; model
 * prose alone can never manufacture a resolution target. Re-selecting the
 * current status is idempotent and preserves its original timestamp. */
export const handleDataDiagnosisResolve = async (
  deps: ChatRpcDeps,
  args: {
    session_id: string;
    message_id: string;
    status: string;
  },
): Promise<{ resolution: ChatDataDiagnosisResolution }> => {
  const safe = ensureRecordArgs('chat.data_diagnosis.resolve', args);
  const session_id = ensureNonEmptyString(
    'chat.data_diagnosis.resolve',
    'session_id',
    safe.session_id,
  );
  const message_id = ensureNonEmptyString(
    'chat.data_diagnosis.resolve',
    'message_id',
    safe.message_id,
  );
  if (!isChatDataDiagnosisResolutionStatus(safe.status)) {
    throw new RpcError(
      'bad_request',
      'chat.data_diagnosis.resolve: status must be resolved, '
        + 'still_uncertain, or needs_new_action',
      400,
    );
  }
  ensureSession(deps, session_id);
  const messages = await deps.store.listMessages(session_id);
  const message = messages.find((candidate) => candidate.id === message_id);
  if (message === undefined) {
    throw new RpcError(
      'not_found',
      `chat.data_diagnosis.resolve: message ${message_id} not found`,
      404,
    );
  }
  if (
    message.role !== 'assistant'
    || message.data_diagnosis?.intent !== 'safe_check'
  ) {
    throw new RpcError(
      'bad_request',
      'chat.data_diagnosis.resolve: message must be a completed safe-check answer',
      400,
    );
  }
  const previousResolution = message.data_diagnosis_resolution;
  if (deps.store.setDataDiagnosisResolution === undefined) {
    if (previousResolution?.status === safe.status) {
      return { resolution: previousResolution };
    }
    throw new RpcError(
      'not_configured',
      'Durable safe-check closure is unavailable.',
      501,
    );
  }
  const priorResolvedAt =
    previousResolution?.resolved_at ?? -1;
  const resolution: ChatDataDiagnosisResolution = {
    status: safe.status,
    // Preserve last-writer ordering even when two owner choices land in the
    // same clock millisecond. Clients can safely ignore a delayed older event.
    resolved_at: Math.max(
      (deps.now ?? Date.now)(),
      priorResolvedAt + 1,
    ),
  };
  const updated = await deps.store.setDataDiagnosisResolution(
    session_id,
    message_id,
    resolution,
  );
  if (updated === null) {
    throw new RpcError(
      'not_found',
      `chat.data_diagnosis.resolve: message ${message_id} not found`,
      404,
    );
  }
  const persistedResolution = updated.data_diagnosis_resolution;
  if (persistedResolution === undefined) {
    throw new RpcError(
      'internal_error',
      'chat.data_diagnosis.resolve: closure was not persisted',
      500,
    );
  }
  const changed =
    previousResolution?.status !== persistedResolution.status
    || previousResolution.resolved_at !== persistedResolution.resolved_at;
  if (changed) {
    try {
      deps.broadcast?.emit({
        kind: 'chat.data_diagnosis_resolved',
        session_id,
        message_id,
        resolution: persistedResolution,
      });
    } catch {
      // Broadcast is best-effort; reload hydration reads the durable closure.
    }
  }
  return { resolution: persistedResolution };
};

/** D-137 P3 § A.11 — shared resolve helper. Validates the rpc args,
 *  looks up the plan, flips status, broadcasts + audits, returns the
 *  resolved plan to the caller. The approve / cancel handlers share
 *  every step except the target status; factoring keeps the per-rpc
 *  body to one line + one explicit status arg. */
const resolvePlanRpc = async (
  deps: ChatRpcDeps,
  method: 'chat.plan.approve' | 'chat.plan.cancel',
  next_status: 'approved' | 'cancelled',
  args: unknown,
): Promise<{ plan: ChatPlanProposal }> => {
  if (!deps.planApprovalStore) {
    throw new RpcError(
      'not_configured',
      `${method}: plan-approval store is not wired (dbless / pre-init)`,
      501,
    );
  }
  const safe = ensureRecordArgs(method, args);
  const plan_id = ensureNonEmptyString(method, 'plan_id', safe.plan_id);
  // Approval must recover the exact reviewed payload before any state change.
  // Cancellation is the safe exception: the durable store may cancel a
  // proposed shell even when corrupt ciphertext made its details unreadable.
  if (next_status === 'approved') {
    const existing = await deps.planApprovalStore.get(plan_id);
    if (!existing) {
      throw new RpcError(
        'not_found',
        `${method}: plan_id '${plan_id}' not found`,
        404,
      );
    }
    if (existing.status !== 'proposed') {
      throw new RpcError(
        'bad_request',
        `${method}: plan_id '${plan_id}' is already resolved (status=${existing.status})`,
        400,
      );
    }
  }
  const now = deps.now ?? Date.now;
  const resolved = await deps.planApprovalStore.resolve(
    plan_id,
    next_status,
    now(),
  );
  if (!resolved) {
    // The plan was removed or its exact reviewed payload became unavailable
    // before approval. Surface a closed 404 rather than mutating blindly.
    throw new RpcError(
      'not_found',
      `${method}: plan_id '${plan_id}' was removed mid-resolve`,
      404,
    );
  }
  if (resolved.status !== next_status) {
    throw new RpcError(
      'bad_request',
      `${method}: plan_id '${plan_id}' is already resolved (status=${resolved.status})`,
      400,
    );
  }
  // Audit + broadcast. Audit failures are best-effort; broadcast
  // failures are best-effort. Neither aborts the rpc — the rpc itself
  // succeeded.
  void safeLogActivity(
    deps.auditLog,
    next_status === 'approved' ? 'chat_plan_approved' : 'chat_plan_cancelled',
    `${resolved.session_id}:${resolved.turn_id}:${resolved.tool}`,
    JSON.stringify({
      plan_id,
      tier: resolved.tier,
      classification: resolved.classification,
    }),
  );
  if (deps.broadcast) {
    try {
      deps.broadcast.emit({
        kind: 'chat.plan_resolved',
        session_id: resolved.session_id,
        turn_id: resolved.turn_id,
        plan: resolved,
      });
    } catch {
      // Broadcast failures are observability-only.
    }
  }
  if (next_status === 'cancelled' && deps.executionCaseLifecycle) {
    try {
      await deps.executionCaseLifecycle.finalizeTurn({
        session_id: resolved.session_id,
        turn_id: resolved.turn_id,
      });
    } catch {
      // Learning is advisory. The cancellation is already durable and must not
      // be rolled back or surfaced as failed because compilation was unavailable.
    }
  }
  return { plan: resolved };
};

export const handlePlanApprove = async (
  deps: ChatRpcDeps,
  args: unknown,
): Promise<{ plan: ChatPlanProposal }> =>
  resolvePlanRpc(deps, 'chat.plan.approve', 'approved', args);

export const handlePlanCancel = async (
  deps: ChatRpcDeps,
  args: unknown,
): Promise<{ plan: ChatPlanProposal }> =>
  resolvePlanRpc(deps, 'chat.plan.cancel', 'cancelled', args);

const executionCaseFeedbackTarget = (
  deps: ChatRpcDeps,
  args: unknown,
  method: 'chat.execution.feedback' | 'chat.execution.feedback.retract',
): ExecutionCaseFeedbackTarget => {
  const safe = ensureRecordArgs(method, args);
  const allowed = new Set([
    'session_id',
    'turn_id',
    'kind',
    'source_plan_id',
  ]);
  if (Object.keys(safe).some((key) => !allowed.has(key))) {
    throw new RpcError(
      'bad_request',
      `${method}: unexpected field`,
      400,
    );
  }
  const session_id = ensureNonEmptyString(
    method,
    'session_id',
    safe.session_id,
  );
  ensureSession(deps, session_id);
  const turn_id = ensureNonEmptyString(method, 'turn_id', safe.turn_id);
  if (!isExecutionCaseFeedbackKind(safe.kind)) {
    throw new RpcError(
      'bad_request',
      `${method}: kind must be accepted, corrected, rejected, or undone`,
      400,
    );
  }
  const source_plan_id = safe.source_plan_id === undefined
    ? undefined
    : ensureNonEmptyString(
        method,
        'source_plan_id',
        safe.source_plan_id,
      );
  return {
    session_id,
    turn_id,
    kind: safe.kind,
    ...(source_plan_id ? { source_plan_id } : {}),
  };
};

const throwExecutionCaseFeedbackTargetError = (
  method: 'chat.execution.feedback' | 'chat.execution.feedback.retract',
  result: {
    ok: false;
    reason: 'span_not_found' | 'plan_not_in_span';
  },
): never => {
  throw new RpcError(
    result.reason === 'span_not_found' ? 'not_found' : 'bad_request',
    result.reason === 'span_not_found'
      ? `${method}: turn is not anchored to this session`
      : `${method}: source_plan_id is not part of the resolved span`,
    result.reason === 'span_not_found' ? 404 : 400,
  );
};

export const handleExecutionCaseFeedback = async (
  deps: ChatRpcDeps,
  args: unknown,
): Promise<{ recorded: boolean }> => {
  const method = 'chat.execution.feedback';
  if (!deps.executionCaseFeedbackRecorder) {
    throw new RpcError(
      'not_configured',
      `${method}: execution-case feedback is not wired`,
      501,
    );
  }
  const result = await deps.executionCaseFeedbackRecorder.record(
    executionCaseFeedbackTarget(deps, args, method),
  );
  if (result.ok) return { recorded: result.recorded };
  return throwExecutionCaseFeedbackTargetError(method, result);
};

export const handleExecutionCaseFeedbackRetract = async (
  deps: ChatRpcDeps,
  args: unknown,
): Promise<{ retracted: boolean }> => {
  const method = 'chat.execution.feedback.retract';
  if (!deps.executionCaseFeedbackRecorder) {
    throw new RpcError(
      'not_configured',
      `${method}: execution-case feedback is not wired`,
      501,
    );
  }
  const result = await deps.executionCaseFeedbackRecorder.retract(
    executionCaseFeedbackTarget(deps, args, method),
  );
  if (result.ok) return { retracted: result.retracted };
  return throwExecutionCaseFeedbackTargetError(method, result);
};

export const handleExecutionCaseDiagnostics = async (
  deps: ChatRpcDeps,
): Promise<unknown> => {
  const method = 'chat.execution.diagnostics';
  if (!deps.executionCaseDiagnostics) {
    throw new RpcError(
      'not_configured',
      `${method}: execution-case diagnostics are not wired`,
      501,
    );
  }
  return deps.executionCaseDiagnostics();
};

export const handleExecutionCaseLearned = async (
  deps: ChatRpcDeps,
): Promise<{ cases: ExecutionCaseLearnedEntry[] }> => {
  const method = 'chat.execution.learned';
  if (!deps.executionCaseLearned) {
    throw new RpcError(
      'not_configured',
      `${method}: execution cases are not wired`,
      501,
    );
  }
  return { cases: await deps.executionCaseLearned() };
};

export const handleExecutionCaseForget = async (
  deps: ChatRpcDeps,
  args: unknown,
): Promise<{ removed: boolean; cases_remaining: number }> => {
  const method = 'chat.execution.forget';
  if (!deps.executionCaseForget) {
    throw new RpcError(
      'not_configured',
      `${method}: execution cases are not wired`,
      501,
    );
  }
  const safe = ensureRecordArgs(method, args);
  const caseId = safe.case_id;
  if (typeof caseId !== 'string' || caseId.trim().length === 0) {
    throw new RpcError('bad_request', `${method}: case_id is required`, 400);
  }
  // ⚠ An unknown id resolves to `removed: false` rather than an error. The
  // owner may be forgetting a case a concurrent turn already superseded, and a
  // failure there would read as "forgetting is broken" for an outcome that is
  // exactly what they asked for.
  return deps.executionCaseForget(caseId);
};

export const handleExecutionCaseAuthored = async (
  deps: ChatRpcDeps,
  args: unknown,
): Promise<{ recorded: boolean }> => {
  const method = 'chat.execution.authored';
  if (!deps.executionCaseAuthored) {
    throw new RpcError(
      'not_configured',
      `${method}: execution cases are not wired`,
      501,
    );
  }
  const safe = ensureRecordArgs(method, args);
  const caseId = safe.case_id;
  const recipeId = safe.recipe_id;
  if (typeof caseId !== 'string' || caseId.trim().length === 0) {
    throw new RpcError('bad_request', `${method}: case_id is required`, 400);
  }
  if (typeof recipeId !== 'string' || recipeId.trim().length === 0) {
    throw new RpcError('bad_request', `${method}: recipe_id is required`, 400);
  }
  return deps.executionCaseAuthored({ case_id: caseId, recipe_id: recipeId });
};

export const handleExecutionCaseDraftRecipe = async (
  deps: ChatRpcDeps,
  args: unknown,
): Promise<{
  ok: boolean;
  recipe?: RecipeDefinition;
  issues: string[];
  reason?: string;
  request_aliased?: boolean;
}> => {
  const method = 'chat.execution.draft_recipe';
  if (!deps.executionCaseDraftRecipe) {
    throw new RpcError(
      'not_configured',
      `${method}: recipe drafting is not wired`,
      501,
    );
  }
  const safe = ensureRecordArgs(method, args);
  const caseId = safe.case_id;
  if (typeof caseId !== 'string' || caseId.trim().length === 0) {
    throw new RpcError('bad_request', `${method}: case_id is required`, 400);
  }
  const prompt = typeof safe.prompt === 'string' ? safe.prompt : '';
  // ⛔ REFINEMENT, and it is only ever a HINT to the model. Whatever arrives
  // here is shape-stripped and re-validated downstream exactly like a first
  // pass, so a caller cannot smuggle a recipe into existence through it — it
  // shortens the model's work, it does not bypass anything.
  const previousRecipe = safe.previous_recipe;
  const result = await deps.executionCaseDraftRecipe({
    case_id: caseId,
    prompt,
    ...(previousRecipe !== undefined && previousRecipe !== null
      ? { previous_recipe: previousRecipe }
      : {}),
  });
  // ⚠ A model that wrote something unusable is not an rpc FAILURE — the owner
  // asked for a draft, and the validator's findings are a better answer than a
  // thrown error with nothing to look at. Only an unwired surface throws.
  return result.ok
    ? {
        ok: true,
        recipe: result.recipe,
        issues: result.issues,
        request_aliased: result.request_aliased,
      }
    : { ok: false, issues: result.issues, reason: result.reason };
};

export const handleSetPicker = (
  deps: ChatRpcDeps,
  args: { session_id: string; picker_state: { current: string } },
): { ok: true } => {
  const safe = ensureRecordArgs('chat.session.set_picker', args);
  const session_id = ensureNonEmptyString(
    'chat.session.set_picker',
    'session_id',
    safe.session_id,
  );
  ensureSession(deps, session_id);
  const pickerArg = safe.picker_state;
  if (
    !pickerArg
    || typeof pickerArg !== 'object'
    || typeof (pickerArg as { current?: unknown }).current !== 'string'
    || ((pickerArg as { current: string }).current.length === 0)
  ) {
    throw new RpcError(
      'bad_request',
      'chat.session.set_picker: picker_state.current is required',
      400,
    );
  }
  const target = ensureValidPickerTarget(
    'chat.session.set_picker',
    (pickerArg as { current: string }).current,
  );
  // D-137 P4 § A.7.1 — strict per-pair gate.
  ensurePeerPickerTargetIsLive('chat.session.set_picker', target, deps);
  deps.store.setPicker(session_id, target as ChatPickerTarget);
  safeBroadcast(deps.broadcast, 'picker', session_id, { current: target });
  return { ok: true };
};

export const handleSetModelPref = (
  deps: ChatRpcDeps,
  args: {
    session_id: string;
    model_pref: { current: string; model_hint?: unknown; source_id?: unknown };
  },
): { ok: true } => {
  const safe = ensureRecordArgs('chat.session.set_model_pref', args);
  const session_id = ensureNonEmptyString(
    'chat.session.set_model_pref',
    'session_id',
    safe.session_id,
  );
  ensureSession(deps, session_id);
  const modelArg = safe.model_pref;
  if (
    !modelArg
    || typeof modelArg !== 'object'
    || typeof (modelArg as { current?: unknown }).current !== 'string'
    || !CHAT_MODEL_ROUTING_LAYER_SET.has(
      (modelArg as { current: string }).current as ChatModelRoutingLayer,
    )
  ) {
    throw new RpcError(
      'bad_request',
      'chat.session.set_model_pref: model_pref.current must be one of free_pool | byok',
      400,
    );
  }
  const currentLayer = (modelArg as { current: string }).current as ChatModelRoutingLayer;
  const modelHint = ensureOptionalModelHint(
    'chat.session.set_model_pref',
    (modelArg as { model_hint?: unknown }).model_hint,
  );
  // D-191 Phase 6 — the EXACT picked slot. Persisted so the turn PINS it at the
  // matcher (fail-closed, INV3). Validated to a `ChatModelSourceId`; a missing /
  // malformed value → no pin (the turn falls back to `model_hint` routing).
  const sourceIdRaw = (modelArg as { source_id?: unknown }).source_id;
  const sourceId = isChatModelSourceId(sourceIdRaw) ? sourceIdRaw : undefined;
  deps.store.setModelPref(session_id, {
    current: currentLayer,
    ...(modelHint ? { model_hint: modelHint } : {}),
    ...(sourceId ? { source_id: sourceId } : {}),
  });
  // `overridden: true` — set_model_pref establishes an explicit per-session
  // override (it now wins over the per-pair global default until cleared).
  safeBroadcast(deps.broadcast, 'model_pref', session_id, {
    current: currentLayer,
    ...(modelHint ? { model_hint: modelHint } : {}),
    ...(sourceId ? { source_id: sourceId } : {}),
    overridden: true,
  });
  return { ok: true };
};

/** D-167 chat provider-threading — drop a session's explicit model-pref
 *  override; the session reverts to inheriting the per-pair global default.
 *  Broadcasts the resulting EFFECTIVE (inherited) layer so clients re-render
 *  the header badge without an rpc round-trip. */
export const handleClearModelPref = (
  deps: ChatRpcDeps,
  args: { session_id: string },
): { ok: true } => {
  const safe = ensureRecordArgs('chat.session.clear_model_pref', args);
  const session_id = ensureNonEmptyString(
    'chat.session.clear_model_pref',
    'session_id',
    safe.session_id,
  );
  ensureSession(deps, session_id);
  deps.store.clearModelPref(session_id);
  const effective = deps.store.getDefaultModelPref();
  safeBroadcast(deps.broadcast, 'model_pref', session_id, {
    current: effective.layer,
    ...(effective.model_hint ? { model_hint: effective.model_hint } : {}),
    overridden: false,
  });
  return { ok: true };
};

/** D-167 / D-174 R28 Slice A — read the per-pair global chat-model default as
 *  the RAW persisted `source_id` (the slot-faithful form the Settings picker
 *  selects by exact id). `null` when no default is chosen yet. The resolved
 *  `{layer, model_hint}` inheritance view lives at `store.getDefaultModelPref`. */
export const handleGetDefaultModelPref = (
  deps: ChatRpcDeps,
): { source_id: ChatModelSourceId | null; updated_at: number } =>
  deps.store.getDefaultModelSourceId();

/** D-167 / D-174 R28 Slice A — write the per-pair global chat-model default as
 *  a `source_id` (`slot_1` | `slot_2` | `free_pool`). Applies to every non-
 *  overridden session (resolved to `{layer, model_hint}` at read time) and
 *  emits `chat.default_model_pref_changed` carrying the new source_id PLUS a
 *  resolved-at-emit `{layer, model_hint}` snapshot (read live, reflecting the
 *  just-persisted source_id) so paired clients refresh Settings + patch every
 *  inherited session's badge. Per-pair only (D-097/D-168). */
export const handleSetDefaultModelPref = (
  deps: ChatRpcDeps,
  args: { source_id: string },
): { source_id: ChatModelSourceId; updated_at: number } => {
  const safe = ensureRecordArgs('chat.default_model_pref.set', args);
  if (
    typeof safe.source_id !== 'string'
    || !isChatModelSourceId(safe.source_id)
  ) {
    throw new RpcError(
      'bad_request',
      'chat.default_model_pref.set: source_id must be one of slot_1 | slot_2 | free_pool',
      400,
    );
  }
  const persisted = deps.store.setDefaultModelSourceId(safe.source_id);
  if (deps.broadcast) {
    // Resolve the just-persisted source_id against the LIVE config for the
    // transient `{layer, model_hint}` snapshot (source_id stays the source of
    // truth; turn-time routing re-resolves live, never off this snapshot).
    const resolved = deps.store.getDefaultModelPref();
    try {
      deps.broadcast.emit({
        kind: 'chat.default_model_pref_changed',
        source_id: persisted.source_id,
        layer: resolved.layer,
        ...(resolved.model_hint ? { model_hint: resolved.model_hint } : {}),
        updated_at: persisted.updated_at,
      });
    } catch {
      // observability-only; never abort the rpc on emit failure
    }
  }
  void safeLogActivity(
    deps.auditLog,
    'chat_default_model_pref_set',
    'chat_default_model_pref',
    JSON.stringify({ source_id: persisted.source_id }),
  );
  return persisted;
};

/** D-137 W2.2 § A.1.1 — Mary's per-kind catalog scope read. Returns
 *  the persisted shape (or the substrate default at first boot). The
 *  store hides corrupted rows behind a default fall-through so the
 *  rpc never surfaces undefined to the Settings page. */
export const handleToolCatalogGet = (
  deps: ChatRpcDeps,
): { enabled_kinds: readonly string[]; updated_at: number } => {
  if (!deps.toolCatalogStore) {
    throw new RpcError(
      'not_configured',
      'chat.tool_catalog.get: tool-catalog store is not wired (dbless / pre-init)',
      501,
    );
  }
  const scope = deps.toolCatalogStore.getScope();
  return {
    enabled_kinds: scope.enabled_kinds,
    updated_at: scope.updated_at,
  };
};

/** D-137 W2.2 § A.1.1 — Mary's per-kind catalog scope write. Validates
 *  via `validateChatToolCatalogScopeInput` first; bad shapes raise
 *  `bad_request` (400) with detail strings carrying the closed-list
 *  issue codes. Persists, emits the `chat.tool_catalog_scope_changed`
 *  broadcast on success. Best-effort audit emit. */
export const handleToolCatalogSet = (
  deps: ChatRpcDeps,
  args: { enabled_kinds: readonly string[] },
): { enabled_kinds: readonly string[]; updated_at: number } => {
  if (!deps.toolCatalogStore) {
    throw new RpcError(
      'not_configured',
      'chat.tool_catalog.set: tool-catalog store is not wired (dbless / pre-init)',
      501,
    );
  }
  ensureRecordArgs('chat.tool_catalog.set', args);
  const validation = validateChatToolCatalogScopeInput(args);
  if (!validation.ok) {
    // Surface every code so callers can map each (the Settings page
    // renders one inline error per code without re-parsing).
    const codes = validation.issues.map((i) => i.code).join(', ');
    const details = validation.issues.map((i) => i.detail).join('; ');
    // Codes is informational — the closed list is also exported for
    // callers that prefer matching against the registry; this `void`
    // reads it so the import stays load-bearing during lint passes.
    void CHAT_TOOL_CATALOG_SCOPE_VALIDATION_ISSUE_CODES;
    throw new RpcError(
      'bad_request',
      `chat.tool_catalog.set: ${codes} (${details})`,
      400,
    );
  }
  const now = deps.now ?? Date.now;
  const persisted = deps.toolCatalogStore.setScope({
    enabled_kinds: validation.enabled_kinds as ReadonlyArray<IngredientKind>,
    now: now(),
  });
  // Broadcast even when the persisted scope is identical to the prior
  // one — the bus is the multi-client coherence path, and a no-op
  // notify is cheap. The Settings page reducer is idempotent.
  if (deps.broadcast) {
    try {
      deps.broadcast.emit({
        kind: 'chat.tool_catalog_scope_changed',
        enabled_kinds: persisted.enabled_kinds,
        updated_at: persisted.updated_at,
      });
    } catch {
      // observability-only; never abort the rpc on emit failure
    }
  }
  void safeLogActivity(
    deps.auditLog,
    'chat_tool_catalog_scope_set',
    'chat_tool_catalog_scope',
    JSON.stringify({
      enabled_kinds: persisted.enabled_kinds,
    }),
  );
  void (persisted satisfies ChatToolCatalogScopeState);
  return {
    enabled_kinds: persisted.enabled_kinds,
    updated_at: persisted.updated_at,
  };
};

/** D-137 W2.3 § A.10 — list every persisted MCP-connection annotation.
 *  Used by Settings → Connections summary + by the chat orchestrator's
 *  Tier 3 catalog projection (orchestrator typically calls the store
 *  directly, but the rpc surface exists for webclient parity). */
export const handleConnectionMcpList = (
  deps: ChatRpcDeps,
): { annotations: ReadonlyArray<ConnectionMcpAnnotationState> } => {
  if (!deps.connectionMcpStore) {
    throw new RpcError(
      'not_configured',
      'chat.connection_mcp.list: annotation store is not wired (dbless / pre-init)',
      501,
    );
  }
  return { annotations: deps.connectionMcpStore.listAnnotations() };
};

/** D-137 W2.3 § A.10 — read one connection's annotation. Returns the
 *  empty default when no row exists yet (the Settings page surfaces
 *  the "no tools classified yet" copy until Mary saves her first batch). */
export const handleConnectionMcpGet = (
  deps: ChatRpcDeps,
  args: { connection_name: string },
): { annotation: ConnectionMcpAnnotationState } => {
  if (!deps.connectionMcpStore) {
    throw new RpcError(
      'not_configured',
      'chat.connection_mcp.get: annotation store is not wired (dbless / pre-init)',
      501,
    );
  }
  const safe = ensureRecordArgs('chat.connection_mcp.get', args);
  const connection_name = safe.connection_name;
  if (typeof connection_name !== 'string' || connection_name.length === 0) {
    throw new RpcError(
      'bad_request',
      'chat.connection_mcp.get: connection_name must be a non-empty string',
      400,
    );
  }
  return {
    annotation: deps.connectionMcpStore.getAnnotation(connection_name),
  };
};

/** D-137 W2.3 § A.10 — persist a per-connection annotation. Validates
 *  the full shape via `validateConnectionMcpAnnotationInput` (closed
 *  issue codes). On success: persists, emits the
 *  `chat.connection_mcp_annotation_changed` broadcast (every call,
 *  including no-op overwrites — the bus is the multi-client coherence
 *  path), emits the audit row. */
export const handleConnectionMcpSet = (
  deps: ChatRpcDeps,
  args: unknown,
): { annotation: ConnectionMcpAnnotationState } => {
  if (!deps.connectionMcpStore) {
    throw new RpcError(
      'not_configured',
      'chat.connection_mcp.set: annotation store is not wired (dbless / pre-init)',
      501,
    );
  }
  ensureRecordArgs('chat.connection_mcp.set', args);
  const validation = validateConnectionMcpAnnotationInput(args);
  if (!validation.ok) {
    const codes = validation.issues.map((i) => i.code).join(', ');
    const details = validation.issues.map((i) => i.detail).join('; ');
    // Read CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES so the
    // import stays load-bearing during lint passes — callers that
    // prefer matching against the registry have a stable import.
    void CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES;
    throw new RpcError(
      'bad_request',
      `chat.connection_mcp.set: ${codes} (${details})`,
      400,
    );
  }
  const now = deps.now ?? Date.now;
  const persisted = deps.connectionMcpStore.setAnnotation({
    value: validation.value,
    now: now(),
  });
  if (deps.broadcast) {
    try {
      deps.broadcast.emit({
        kind: 'chat.connection_mcp_annotation_changed',
        connection_name: persisted.connection_name,
        annotation: persisted,
      });
    } catch {
      // observability-only; never abort the rpc on emit failure
    }
  }
  // Summary stats only — body of tool descriptions / classifications
  // stays out of the audit log (matches the spec's per-event privacy
  // posture; the audit feed renders "Mary classified 3 tools" without
  // leaking the descriptions themselves).
  // ⚠ D-228 slices 4 + 6 — the per-tool counts went with `tool_overrides`, and
  // `cached_tool_count` with `tools_list_cache`. What remains is the whole of
  // what this rpc still carries: the owner's connection-level topic chips. A
  // tool's risk tier is not set here, and its descriptors are not cached here.
  void safeLogActivity(
    deps.auditLog,
    'chat_connection_mcp_annotation_set',
    persisted.connection_name,
    JSON.stringify({ topic_tag_count: persisted.topic_tags.length }),
  );
  // Defensive narrowing — the store always returns a fully-shaped
  // annotation, but the type check keeps the contract surface honest.
  void (persisted satisfies ConnectionMcpAnnotationState);
  // Reference the default-builder so the contracts import stays
  // load-bearing for future handlers that surface the empty shape.
  void buildDefaultConnectionMcpAnnotation;
  return { annotation: persisted };
};

/** ⛔⛔ D-228 slice 5 — THE MCP SCOPE-PICKER HANDLERS ARE RETIRED.
 *
 *  `projectPickerEntries` / `handlePickerEntries` / `handlePickerRefresh` served
 *  a per-conversation scope switch (`Self` / `Bob (data)`) that swapped the chat
 *  catalog wholesale to a peer's tools. It was dead on BOTH ends — no client in
 *  `apps/` consumed `chat.picker.entries` or the broadcast, and `PeerDispatcher`
 *  had ZERO implementors — and its purpose is subsumed: since auto-mint a peer's
 *  tools are minted into a LOCAL pack and reach chat as ordinary `recued_op_*`
 *  operations governed by the contract.
 *
 *  ⚠ `handlePickerRefresh` was the only writer of the annotation's
 *  `recued_signature` / `tools_list_cache` / `chat_mode`. Those are now
 *  writerless and unread — see the note on the retired rpc specs.
 */

/** D-137 P5 follow-on § A.9 — `chat.inbound_token.list`. Returns
 *  every persisted token row in `created_at DESC` order; the Settings
 *  → MCP Tokens table renders newest-first.
 *
 *  Read-only; no broadcast or audit emission (the renderer-side query
 *  isn't a change event). When the store isn't wired (dbless harness)
 *  surfaces `not_configured` (501) — same posture as the W2.2 / W2.3
 *  / P4 stores. */
export const handleInboundTokenList = (
  deps: ChatRpcDeps,
): { tokens: ReadonlyArray<McpInboundTokenRecord> } => {
  if (!deps.inboundTokenStore) {
    throw new RpcError(
      'not_configured',
      'chat.inbound_token.list: inbound-token store is not wired (dbless / pre-init)',
      501,
    );
  }
  return { tokens: deps.inboundTokenStore.listTokens() };
};

/** D-137 P5 follow-on § A.9 — `chat.inbound_token.get`. Returns the
 *  token row by `token_id` or `null` when absent (the renderer paints
 *  a "token not found / removed" empty state on `null`). */
export const handleInboundTokenGet = (
  deps: ChatRpcDeps,
  args: unknown,
): { token: McpInboundTokenRecord | null } => {
  if (!deps.inboundTokenStore) {
    throw new RpcError(
      'not_configured',
      'chat.inbound_token.get: inbound-token store is not wired (dbless / pre-init)',
      501,
    );
  }
  const safe = ensureRecordArgs('chat.inbound_token.get', args);
  const token_id = ensureNonEmptyString(
    'chat.inbound_token.get',
    'token_id',
    safe.token_id,
  );
  return { token: deps.inboundTokenStore.getTokenById(token_id) };
};

/** D-137 P5 follow-on § A.9 — `chat.inbound_token.issue`. Mints a
 *  fresh token + persists + emits the issuance audit row + fans the
 *  `chat.inbound_token_changed` broadcast (`op: 'issue'`). Returns the
 *  full `IssuedMcpInboundToken` envelope — the only rpc that ever
 *  surfaces the bearer plaintext. The plaintext is returned exactly
 *  once; subsequent reads of the row never re-emit it.
 *
 *  Validation flows through `validateMcpInboundTokenInput` (closed
 *  13-code list — `MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES`) so every
 *  shape error surfaces as `bad_request` (400) with the joined codes.
 *  Substrate errors (peer_handle conflict per spec § A.9 "one token
 *  per peer initially") raise `bad_request` (400) with the
 *  `PEER_HANDLE_CONFLICT_PREFIX` message. */
export const handleInboundTokenIssue = async (
  deps: ChatRpcDeps,
  args: unknown,
): Promise<IssuedMcpInboundToken> => {
  if (!deps.inboundTokenStore) {
    throw new RpcError(
      'not_configured',
      'chat.inbound_token.issue: inbound-token store is not wired (dbless / pre-init)',
      501,
    );
  }
  ensureRecordArgs('chat.inbound_token.issue', args);
  const validation = validateMcpInboundTokenInput(args);
  if (!validation.ok) {
    const codes = validation.issues.map((i) => i.code).join(', ');
    const details = validation.issues.map((i) => i.detail).join('; ');
    // Read MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES so the import
    // stays load-bearing during lint passes — callers that prefer
    // matching against the registry have a stable import.
    void MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES;
    throw new RpcError(
      'bad_request',
      `chat.inbound_token.issue: ${codes} (${details})`,
      400,
    );
  }
  for (const [toolName, allowed] of Object.entries(validation.value.grants)) {
    if (!allowed) continue;
    try {
      deps.preflightExternalToolGrant?.(toolName);
    } catch (error) {
      throw new RpcError(
        'bad_request',
        `chat.inbound_token.issue: ${error instanceof Error ? error.message : String(error)}`,
        400,
      );
    }
  }
  // ── Door standing closure, MCP arm ──────────────────────────────────
  // Derive BEFORE minting, and refuse rather than degrade. The closure is
  // minted ONTO THE CONTRACT (scope + door policy), never stored on the token:
  // lifecycle and limitation are the contract's job, the token authenticates.
  let standingClosure: ReadonlyArray<string> | undefined;
  if (validation.value.standing_closure === true) {
    // ⛔ THE LIMIT IS ISSUED WITH THE TICK. A contract cannot be edited after
    // mint — changing a limit re-mints — so a closure minted onto an unbounded
    // contract could never acquire a bound afterwards without losing the
    // closure. One mint carries the closure, the limit and the door policy.
    if (validation.value.contract_limits === undefined) {
      throw new RpcError(
        'bad_request',
        'chat.inbound_token.issue: standing_closure requires contract_limits (max_uses and/or expiry_at) — a token that stops asking is issued with its limit, because the contract carrying the closure cannot be given one later',
        400,
      );
    }
    if (validation.value.contract_id !== undefined) {
      throw new RpcError(
        'bad_request',
        'chat.inbound_token.issue: standing_closure mints its own contract, so contract_id must be omitted — an existing contract cannot be given a closure (no patch rpc; changing a contract re-mints it)',
        400,
      );
    }
    if (!deps.deriveGrantedToolClosure) {
      throw new RpcError(
        'not_configured',
        'chat.inbound_token.issue: standing_closure requires the capability derivation, which is not wired — refusing rather than issuing a token that would ask every time',
        501,
      );
    }
    standingClosure = deps.deriveGrantedToolClosure(validation.value.grants);
    if (standingClosure.length === 0) {
      throw new RpcError(
        'bad_request',
        'chat.inbound_token.issue: standing_closure was requested but the granted tools resolve to no operation closure — grant the recipe this token should run without asking',
        400,
      );
    }
  }
  const now = deps.now ?? Date.now;
  // ⛔ ALWAYS-CONTRACTED — mint the carrier when the caller named none, and
  // REFUSE rather than fall back to an unbound token if the minter is unwired.
  // Falling back is what the synthetic `contract_id` did for two years.
  let boundContractId = validation.value.contract_id;
  // D-248 Amendment 3 (T14 follow-on) — NEITHER RESERVED SENTINEL MAY BE BOUND AT
  // ISSUE EITHER, and this is the SECOND bind path, not the first.
  //
  // ⛔⛔ THE D-187 FENCE ONLY EVER COVERED `update_contract`. `issue` takes a
  // caller-supplied `contract_id` too — the validator checks SHAPE ONLY ("a non-empty
  // string up to 256 characters") — so the owner sentinel was bindable here all along,
  // and fencing only the rebind path would have left the same door open one rpc over.
  // Found by sweeping every writer rather than by reading the one the comment named.
  //
  // ⚠ Only the CALLER-supplied value needs checking: a minted carrier comes from
  // `newId()`, which the store's own factory fences.
  if (boundContractId !== undefined) {
    if (isReservedOwnerContractId(boundContractId)) {
      throw new RpcError(
        'bad_request',
        `chat.inbound_token.issue: contract_id '${boundContractId}' is the reserved owner contract and cannot be bound to a door token`,
        400,
      );
    }
    if (isReservedPublicContractId(boundContractId)) {
      throw new RpcError(
        'bad_request',
        `chat.inbound_token.issue: contract_id '${boundContractId}' is the reserved public-anonymous floor, derived at the gate for an anonymous dispatch — it is not a contract and cannot be bound to a door token`,
        400,
      );
    }
  }
  if (boundContractId === undefined) {
    if (!deps.mintTokenContract) {
      throw new RpcError(
        'not_configured',
        'chat.inbound_token.issue: the contract minter is not wired, and a token is never issued unbound — every token carries a contract so its lifetime and revocation have one home',
        501,
      );
    }
    boundContractId = deps.mintTokenContract({
      label: validation.value.label,
      ...(standingClosure === undefined
        ? {}
        : { standingClosureOperationIds: standingClosure }),
      ...(validation.value.contract_limits === undefined
        ? {}
        : { limits: validation.value.contract_limits }),
    });
  }
  const valueWithContract: typeof validation.value = {
    ...validation.value,
    contract_id: boundContractId,
  };
  // ⚠ Track whether WE minted the carrier: only a contract this call created is
  // ours to clean up. A caller-supplied `contract_id` must survive a failed
  // issuance untouched.
  const mintedHere = validation.value.contract_id === undefined;
  let issued: IssuedMcpInboundToken;
  try {
    issued = deps.inboundTokenStore.issueToken({
      value: valueWithContract,
      now: now(),
    });
  } catch (err) {
    // ⛔ THE CARRIER IS MINTED BEFORE THE TOKEN, so a failed issuance (a
    // peer_handle conflict, a storage error) leaves a LIVE contract bound to
    // nothing. Each retry would leave another. Best-effort revoke — the same
    // orphan cleanup the Advanced panel already does when its rebind fails,
    // and for the same reason.
    if (mintedHere && boundContractId !== undefined) {
      try {
        deps.revokeTokenContract?.(boundContractId);
      } catch {
        // Cleanup only; the issuance error below is what the caller needs.
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith(PEER_HANDLE_CONFLICT_PREFIX)) {
      // Spec § A.9 "Multiple tokens per peer: not supported initially.
      // One token per peer relationship." — friendly 400 instead of a
      // 500 / SQLite UNIQUE constraint violation surfacing through the
      // wire taxonomy. The store's pre-flight check produces this
      // prefix; the partial unique index guards against TOCTOU.
      throw new RpcError(
        'bad_request',
        `chat.inbound_token.issue: ${message} — revoke the prior token first`,
        400,
      );
    }
    throw err;
  }
  // Fan to paired clients first (small payload — record sans bearer);
  // then audit; then return so any in-flight hook failure doesn't
  // delay the rpc response.
  if (deps.broadcast) {
    try {
      deps.broadcast.emit({
        kind: 'chat.inbound_token_changed',
        op: 'issue',
        token_id: issued.record.token_id,
        record: issued.record,
      });
    } catch {
      // observability-only; never abort the rpc on emit failure
    }
  }
  // Summary stats only — bearer plaintext + bearer_hash NEVER enter
  // audit detail. The audit feed renders "Bob issued token <label> to
  // <peer_handle> — N tools granted, expires <date>" without leaking
  // the credential. Reserve-class via `RESERVE_ACTIONS` membership;
  // survives retention pruning.
  let grants_total = 0;
  let grants_allowed_count = 0;
  for (const v of Object.values(issued.record.grants)) {
    grants_total += 1;
    if (v) grants_allowed_count += 1;
  }
  void safeLogActivity(
    deps.auditLog,
    'chat_inbound_token_issued',
    issued.record.token_id,
    JSON.stringify({
      label: issued.record.label,
      ...(issued.record.peer_handle !== undefined
        ? { peer_handle: issued.record.peer_handle }
        : {}),
      concurrency_tier: issued.record.concurrency_tier,
      grants_total,
      grants_allowed_count,
      chat_mode_offered:
        issued.record.chat_mode !== null && issued.record.chat_mode.offered,
    }),
  );
  return issued;
};

/** D-137 P5 follow-on § A.9 — `chat.inbound_token.update_grants`.
 *  Re-writes the per-tool grants map on an existing row + stamps a
 *  fresh `updated_at`. Computes added / removed counts by diffing the
 *  prior + new grants so the audit row carries useful summary stats
 *  ("Bob granted 2 / revoked 1 tool on Mary's token") without leaking
 *  individual tool names.
 *
 *  D-171 slice 2b — `chat_mode` is an OPTIONAL field here (the Chat
 *  row's live toggle). Present (object or `null`) → the token's
 *  chat-mode is rewritten in place; absent → preserved (the per-tool
 *  grant checklist edits grants only). The token's secret value never
 *  changes, so connected clients keep working across the edit
 *  (decision 6). It is validated by `validateInboundTokenChatModeUpdate`
 *  (the shared closed-list chat_mode codes).
 *
 *  Validation pipeline: `args` must be a record with a `token_id` +
 *  `grants` map of `{ [tool]: boolean }`. Per-key / per-value shape is
 *  enforced inline (no need for the full issuance validator since the
 *  other fields don't change). 404 when the token doesn't exist. */
export const handleInboundTokenUpdateGrants = async (
  deps: ChatRpcDeps,
  args: unknown,
): Promise<{ token: McpInboundTokenRecord }> => {
  if (!deps.inboundTokenStore) {
    throw new RpcError(
      'not_configured',
      'chat.inbound_token.update_grants: inbound-token store is not wired (dbless / pre-init)',
      501,
    );
  }
  const safe = ensureRecordArgs('chat.inbound_token.update_grants', args);
  const token_id = ensureNonEmptyString(
    'chat.inbound_token.update_grants',
    'token_id',
    safe.token_id,
  );
  // D-171 slice 2b — `grants` is OPTIONAL (preserve-on-absent). The Chat-row
  // toggle edits chat_mode WITHOUT echoing a (possibly stale) grants snapshot
  // that would silently roll back a concurrent per-tool edit. `undefined` ⇒
  // absent ⇒ preserve; present ⇒ validate + replace the whole map.
  const rawGrants = safe.grants;
  let grants: Record<string, boolean> | undefined;
  if (rawGrants !== undefined) {
    if (
      rawGrants === null
      || typeof rawGrants !== 'object'
      || Array.isArray(rawGrants)
    ) {
      throw new RpcError(
        'bad_request',
        'chat.inbound_token.update_grants: grants must be an object keyed on tool names',
        400,
      );
    }
    const next: Record<string, boolean> = Object.create(null);
    for (const [k, v] of Object.entries(rawGrants as Record<string, unknown>)) {
      if (typeof k !== 'string' || k.length === 0) {
        throw new RpcError(
          'bad_request',
          'chat.inbound_token.update_grants: grants keys must be non-empty strings',
          400,
        );
      }
      if (typeof v !== 'boolean') {
        throw new RpcError(
          'bad_request',
          `chat.inbound_token.update_grants: grants[${k}] must be a boolean`,
          400,
        );
      }
      next[k] = v;
    }
    grants = next;
  }
  // D-171 slice 2b — the OPTIONAL Chat-row toggle. Absent ⇒ preserve;
  // present (object / null) ⇒ rewrite. Reuses the shared chat_mode
  // codes; surface a 400 with the joined codes like the issue handler.
  const chatModeResult = validateInboundTokenChatModeUpdate(safe);
  if (!chatModeResult.ok) {
    const codes = chatModeResult.issues.map((i) => i.code).join(', ');
    const details = chatModeResult.issues.map((i) => i.detail).join('; ');
    throw new RpcError(
      'bad_request',
      `chat.inbound_token.update_grants: ${codes} (${details})`,
      400,
    );
  }
  // At least one editable field must be present — a bare `{ token_id }` is a
  // caller bug, not a meaningful no-op.
  if (grants === undefined && !chatModeResult.present) {
    throw new RpcError(
      'bad_request',
      'chat.inbound_token.update_grants: must include grants and/or chat_mode',
      400,
    );
  }
  // Read prior so the audit summary can include added / removed
  // counts. If the row doesn't exist surface 404 BEFORE the write so
  // the renderer doesn't paint a stale success state.
  const prior = deps.inboundTokenStore.getTokenById(token_id);
  if (!prior) {
    throw new RpcError(
      'not_found',
      `chat.inbound_token.update_grants: token_id '${token_id}' not found`,
      404,
    );
  }
  if (grants !== undefined) {
    for (const [toolName, allowed] of Object.entries(grants)) {
      if (!allowed) continue;
      try {
        deps.preflightExternalToolGrant?.(toolName);
      } catch (error) {
        throw new RpcError(
          'bad_request',
          `chat.inbound_token.update_grants: ${error instanceof Error ? error.message : String(error)}`,
          400,
        );
      }
    }
  }
  const now = deps.now ?? Date.now;
  const updated = deps.inboundTokenStore.updateTokenGrants({
    token_id,
    // Thread each field ONLY when present (preserve-on-absent for both).
    ...(grants !== undefined ? { grants } : {}),
    ...(chatModeResult.present ? { chat_mode: chatModeResult.chat_mode } : {}),
    now: now(),
  });
  if (!updated) {
    // Race: row vanished between getTokenById + updateTokenGrants.
    // Surface as 404 so the caller knows the post-state.
    throw new RpcError(
      'not_found',
      `chat.inbound_token.update_grants: token_id '${token_id}' not found`,
      404,
    );
  }
  await deps.inboundTokenStore.drainAuthorityChanges();
  if (deps.broadcast) {
    try {
      deps.broadcast.emit({
        kind: 'chat.inbound_token_changed',
        op: 'update_grants',
        token_id: updated.token_id,
        record: updated,
      });
    } catch {
      // observability-only
    }
  }
  // Diff prior vs updated grants for the audit summary.
  let grants_added_count = 0;
  let grants_removed_count = 0;
  for (const [k, v] of Object.entries(updated.grants)) {
    const was = prior.grants[k] === true;
    if (v === true && !was) grants_added_count += 1;
    if (v !== true && was) grants_removed_count += 1;
  }
  // Catch the case where a key dropped from the new map entirely (the
  // updateTokenGrants call replaces the map; missing keys imply
  // implicit-deny per the substrate's authorisation predicate). Each
  // disappearance from prior counts as a removal.
  for (const [k, v] of Object.entries(prior.grants)) {
    if (v === true && !(k in updated.grants)) grants_removed_count += 1;
  }
  let grants_total = 0;
  let grants_allowed_count = 0;
  for (const v of Object.values(updated.grants)) {
    grants_total += 1;
    if (v) grants_allowed_count += 1;
  }
  void safeLogActivity(
    deps.auditLog,
    'chat_inbound_token_grants_updated',
    updated.token_id,
    JSON.stringify({
      grants_total,
      grants_allowed_count,
      grants_added_count,
      grants_removed_count,
      // D-171 slice 2b — which fields this call edited (grants is now optional),
      // and is chat-mode now offered? Summary flags only; no session_cap leaks.
      grants_edited: grants !== undefined,
      chat_mode_edited: chatModeResult.present,
      chat_mode_offered:
        updated.chat_mode !== null && updated.chat_mode.offered,
    }),
  );
  return { token: updated };
};

/** D-171 slice 3 — `chat.inbound_token.update_contract`. Rebinds an
 *  EXISTING token's bound `contract_id` IN PLACE (no re-issue). The
 *  Advanced sub-panel's cap/expiry toggles lazily mint a
 *  `contract_definition` (D-166, via `collection.contract.mintContract`)
 *  when a limit is turned ON, then call this to bind the live token to
 *  it; turning a limit OFF rebinds to unbound (`contract_id: null`) before
 *  revoking the definition. The token's bearer value is unchanged, so
 *  connected clients keep working across the rebind (decision 6) — the
 *  only column that moves is the bound contract, so the next MCP dispatch
 *  resolves liveness against the new (or no) contract.
 *
 *  `contract_id` is REQUIRED: a non-empty string ≤256 (bind) or `null`
 *  ⛔ `null` is REFUSED — a token is always contracted. Opaque here — liveness
 *  resolves at dispatch (the MCP transport's
 *  per-request `isContractLive`), so binding an id that names no contract
 *  fails closed (denies) rather than being rejected at rebind time. 404 when
 *  the token doesn't exist. */
export const handleInboundTokenUpdateContract = async (
  deps: ChatRpcDeps,
  args: unknown,
): Promise<{ token: McpInboundTokenRecord }> => {
  if (!deps.inboundTokenStore) {
    throw new RpcError(
      'not_configured',
      'chat.inbound_token.update_contract: inbound-token store is not wired (dbless / pre-init)',
      501,
    );
  }
  const safe = ensureRecordArgs('chat.inbound_token.update_contract', args);
  const token_id = ensureNonEmptyString(
    'chat.inbound_token.update_contract',
    'token_id',
    safe.token_id,
  );
  // `contract_id` is required. A missing key is a caller bug — the rpc's whole
  // purpose is to set the binding.
  if (!Object.prototype.hasOwnProperty.call(safe, 'contract_id')) {
    throw new RpcError(
      'bad_request',
      'chat.inbound_token.update_contract: contract_id is required (a non-empty string naming the contract to bind)',
      400,
    );
  }
  // ⛔⛔ UNBINDING IS GONE. `null` used to mean "clear the binding", and the
  // Advanced panel sent it whenever the owner switched the last limit off —
  // which left a live token with no contract, only a synthetic `contract_id`
  // naming no row. Turning limits off must REBIND to an unbounded carrier, not
  // strip the contract: the limits are the contract's fields, not its reason to
  // exist. ⚠ Refused here rather than silently coerced, because a caller that
  // still sends `null` believes it is clearing something.
  if (safe.contract_id === null) {
    throw new RpcError(
      'bad_request',
      'chat.inbound_token.update_contract: a token is always contracted — to remove its limits, bind it to a contract minted without expiry_at / max_uses rather than unbinding',
      400,
    );
  }
  const rawContractId = safe.contract_id;
  // ⚠ NOT nullable. The `null` branch is gone with unbinding — the guard above
  // rejects it, so a branch here would be unreachable code advertising a
  // capability that no longer exists. (Codex flagged the earlier version: the
  // docs said null unbinds, the parser kept a null branch, and the guard
  // refused it — three statements, two of them false.)
  let contract_id: string;
  if (
    typeof rawContractId === 'string'
    && rawContractId.length > 0
    && rawContractId.length <= 256
  ) {
    // D-187 AMENDMENT 3b — a door / standing contract may NEVER bind the reserved OWNER
    // sentinel: the owner contract is DERIVED from an owner-AI source at the gate
    // (`resolveGrantGoverningContractId`), never bound to a token. Binding it would let a
    // door claim `OWNER_CONTRACT_ID` and inherit the owner's permissive grant rows —
    // defense in depth alongside the gate-level fence (`gateStandingContractId` never
    // treats a bound id as the always-live owner).
    if (isReservedOwnerContractId(rawContractId)) {
      throw new RpcError(
        'bad_request',
        `chat.inbound_token.update_contract: contract_id '${rawContractId}' is the reserved owner contract and cannot be bound to a door token`,
        400,
      );
    }
    // D-248 Amendment 3 — the PUBLIC sentinel's twin fence, which `contract-definition.ts`
    // claimed ("the fence is kept symmetric with the owner's so the two can never drift")
    // but which had ZERO call sites while the owner's had five. Binding it is not a
    // privilege escalation today — the sentinel has no `contract_definition` row, so the
    // bind falls through `gateGrantGoverningContractId` to the token's own snapshot
    // `allowed_tools` + per-tool checklist exactly as any unknown id would. It is refused
    // because the failure it produces is a SILENT, CONFUSING fallback rather than an
    // answer, and because the sentinel must never become bindable later, when the grant
    // table behind it stops being empty.
    if (isReservedPublicContractId(rawContractId)) {
      throw new RpcError(
        'bad_request',
        `chat.inbound_token.update_contract: contract_id '${rawContractId}' is the reserved public-anonymous floor, derived at the gate for an anonymous dispatch — it is not a contract and cannot be bound to a door token`,
        400,
      );
    }
    contract_id = rawContractId;
  } else {
    throw new RpcError(
      'bad_request',
      'chat.inbound_token.update_contract: contract_id must be a non-empty string up to 256 characters naming the contract to bind',
      400,
    );
  }
  // Read prior so a non-existent token surfaces 404 BEFORE the write (the
  // renderer doesn't paint a stale success state).
  const prior = deps.inboundTokenStore.getTokenById(token_id);
  if (!prior) {
    throw new RpcError(
      'not_found',
      `chat.inbound_token.update_contract: token_id '${token_id}' not found`,
      404,
    );
  }
  const now = deps.now ?? Date.now;
  const updated = deps.inboundTokenStore.updateTokenContract({
    token_id,
    contract_id,
    now: now(),
  });
  if (!updated) {
    // Race: row vanished between getTokenById + updateTokenContract.
    throw new RpcError(
      'not_found',
      `chat.inbound_token.update_contract: token_id '${token_id}' not found`,
      404,
    );
  }
  await deps.inboundTokenStore.drainAuthorityChanges();
  if (deps.broadcast) {
    try {
      deps.broadcast.emit({
        kind: 'chat.inbound_token_changed',
        op: 'update_contract',
        token_id: updated.token_id,
        record: updated,
      });
    } catch {
      // observability-only
    }
  }
  // Summary flags only — `bound` records whether a cap/expiry envelope is now in
  // force; the opaque contract_id is non-secret. No bearer / grant leakage.
  void safeLogActivity(
    deps.auditLog,
    'chat_inbound_token_contract_updated',
    updated.token_id,
    JSON.stringify({
      bound: contract_id !== null,
      ...(contract_id !== null ? { contract_id } : {}),
    }),
  );
  return { token: updated };
};

/** D-137 P5 follow-on § A.9 — `chat.inbound_token.revoke`. Stamps
 *  `revoked_at` on the row so the verifier rejects future calls under
 *  this bearer. Idempotent — re-revoking returns `revoked: false` +
 *  the prior `revoked_at`. The audit row only fires on the FIRST
 *  revoke (matches the partial-unique-index releasing on revoke per
 *  the spec § A.9 "one token per peer" + "Revoking releases the
 *  slot"). 404 when the token never existed. */
export const handleInboundTokenRevoke = async (
  deps: ChatRpcDeps,
  args: unknown,
): Promise<{ revoked: boolean; token: McpInboundTokenRecord }> => {
  if (!deps.inboundTokenStore) {
    throw new RpcError(
      'not_configured',
      'chat.inbound_token.revoke: inbound-token store is not wired (dbless / pre-init)',
      501,
    );
  }
  const safe = ensureRecordArgs('chat.inbound_token.revoke', args);
  const token_id = ensureNonEmptyString(
    'chat.inbound_token.revoke',
    'token_id',
    safe.token_id,
  );
  const prior = deps.inboundTokenStore.getTokenById(token_id);
  if (!prior) {
    throw new RpcError(
      'not_found',
      `chat.inbound_token.revoke: token_id '${token_id}' not found`,
      404,
    );
  }
  const now = deps.now ?? Date.now;
  const revoked = deps.inboundTokenStore.revokeToken({ token_id, now: now() });
  // Re-read so the response carries the post-revoke `revoked_at` /
  // `updated_at`. Idempotent revoke leaves the row unchanged.
  const post = deps.inboundTokenStore.getTokenById(token_id);
  if (!post) {
    // Race: row vanished between revokeToken + getTokenById. Surface
    // as 404 so the caller knows the post-state.
    throw new RpcError(
      'not_found',
      `chat.inbound_token.revoke: token_id '${token_id}' not found`,
      404,
    );
  }
  await deps.inboundTokenStore.drainAuthorityChanges();
  if (revoked && deps.broadcast) {
    // Only fan the broadcast on a state change. Idempotent re-revoke
    // doesn't shift any client-rendered state, so no event.
    try {
      deps.broadcast.emit({
        kind: 'chat.inbound_token_changed',
        op: 'revoke',
        token_id: post.token_id,
        record: post,
      });
    } catch {
      // observability-only
    }
  }
  if (revoked) {
    void safeLogActivity(
      deps.auditLog,
      'chat_inbound_token_revoked',
      post.token_id,
      JSON.stringify({
        label: post.label,
        ...(post.peer_handle !== undefined
          ? { peer_handle: post.peer_handle }
          : {}),
        revoked_at: post.revoked_at,
      }),
    );
  }
  return { revoked, token: post };
};

/** D-137 P5 follow-on § A.9 — `chat.inbound_token.delete`. Hard-
 *  deletes the row. The Settings UI path treats this as a housekeeping
 *  affordance (the preferred path for live tokens is
 *  `chat.inbound_token.revoke` since it preserves the audit
 *  breadcrumb); typical use is clearing test tokens / cleaning up
 *  long-revoked tokens.
 *
 *  No issuance / revocation audit row is emitted on delete (the row is
 *  gone — there's no token to keep auditing about); the prior
 *  `chat_inbound_token_issued` + `chat_inbound_token_revoked` rows
 *  retain the forensic ledger. The broadcast carries `record: null`
 *  since the row no longer exists. */
export const handleInboundTokenDelete = async (
  deps: ChatRpcDeps,
  args: unknown,
): Promise<{ deleted: boolean }> => {
  if (!deps.inboundTokenStore) {
    throw new RpcError(
      'not_configured',
      'chat.inbound_token.delete: inbound-token store is not wired (dbless / pre-init)',
      501,
    );
  }
  const safe = ensureRecordArgs('chat.inbound_token.delete', args);
  const token_id = ensureNonEmptyString(
    'chat.inbound_token.delete',
    'token_id',
    safe.token_id,
  );
  const deleted = deps.inboundTokenStore.deleteToken(token_id);
  // Sweep even when the token row was already absent: a prior crash can leave
  // an inert mailbox fence after the hard-delete committed.
  await deps.inboundTokenStore.drainAuthorityChanges();
  if (deleted && deps.broadcast) {
    try {
      deps.broadcast.emit({
        kind: 'chat.inbound_token_changed',
        op: 'delete',
        token_id,
        record: null,
      });
    } catch {
      // observability-only
    }
  }
  return { deleted };
};

/** D-171 slice 2c — `chat.inbound_token.tool_catalog`. Returns the live
 *  self tool catalog (`ToolEntry[]`) the Permissions → MCP door per-tool
 *  grant checklist renders. A read over the orchestrator's
 *  `InternalToolRegistry.list()` (Tier 1 + 2 + 3 self tools) via the
 *  injected `catalogProvider`; the webclient groups it by ingredient kind
 *  + diffs it against a token's grants. Read per-call so installs /
 *  connection edits reshape the catalog without a restart. 501 when the
 *  provider isn't wired (dbless harness) — mirrors the store-unwired path
 *  on the rest of the family. Read-only; reserved local-UI only via the
 *  `chat.inbound_token.` prefix in `MCP_RESERVED_RPC_PREFIXES`. */
export const handleInboundTokenToolCatalog = (
  deps: ChatRpcDeps,
): { catalog: ReadonlyArray<ToolEntry> } => {
  if (!deps.catalogProvider) {
    throw new RpcError(
      'not_configured',
      'chat.inbound_token.tool_catalog: tool-catalog provider is not wired (dbless / pre-init)',
      501,
    );
  }
  return { catalog: deps.catalogProvider() };
};

export const makeChatHandlers = (
  deps: ChatRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ChatMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
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
      'chat.execution.learned',
      'chat.execution.forget',
      'chat.execution.draft_recipe',
      'chat.execution.authored',
      'chat.session.set_picker',
      'chat.session.set_model_pref',
      'chat.session.clear_model_pref',
      'chat.default_model_pref.get',
      'chat.default_model_pref.set',
      'chat.tool_catalog.get',
      'chat.tool_catalog.set',
      'chat.connection_mcp.list',
      'chat.connection_mcp.get',
      'chat.connection_mcp.set',
      'chat.inbound_token.list',
      'chat.inbound_token.get',
      'chat.inbound_token.issue',
      'chat.inbound_token.update_grants',
      'chat.inbound_token.update_contract',
      'chat.inbound_token.revoke',
      'chat.inbound_token.delete',
      'chat.inbound_token.tool_catalog',
    ],
    handlers: {
      'chat.sessions.list': async () => handleSessionsList(deps),
      'chat.session.get': async (args) =>
        handleSessionGet(deps, args as { session_id: string }),
      'chat.session.create': async (args) =>
        handleSessionCreate(deps, args as { title?: string } | void),
      'chat.session.delete': async (args) =>
        handleSessionDelete(deps, args as { session_id: string }),
      'chat.session.export': async (args) =>
        handleSessionExport(deps, args as { session_id: string }),
      'chat.egress.get': async (args) =>
        handleEgressGet(deps, args as { session_id: string; message_id: string }),
      'chat.send': async (args) =>
        handleSend(
          deps,
          args as Parameters<typeof handleSend>[1],
        ),
      'chat.data_diagnosis.resolve': async (args) =>
        handleDataDiagnosisResolve(
          deps,
          args as Parameters<typeof handleDataDiagnosisResolve>[1],
        ),
      'chat.plans.pending.list': async () =>
        handlePlansPendingList(deps),
      'chat.plan.approve': async (args) => handlePlanApprove(deps, args),
      'chat.plan.cancel': async (args) => handlePlanCancel(deps, args),
      'chat.execution.feedback': async (args) =>
        handleExecutionCaseFeedback(deps, args),
      'chat.execution.feedback.retract': async (args) =>
        handleExecutionCaseFeedbackRetract(deps, args),
      'chat.execution.diagnostics': async () =>
        handleExecutionCaseDiagnostics(deps),
      'chat.execution.learned': async () =>
        handleExecutionCaseLearned(deps),
      'chat.execution.forget': async (args) =>
        handleExecutionCaseForget(deps, args),
      'chat.execution.draft_recipe': async (args) =>
        handleExecutionCaseDraftRecipe(deps, args),
      'chat.execution.authored': async (args) =>
        handleExecutionCaseAuthored(deps, args),
      'chat.session.set_picker': async (args) =>
        handleSetPicker(
          deps,
          args as { session_id: string; picker_state: { current: string } },
        ),
      'chat.session.set_model_pref': async (args) =>
        handleSetModelPref(
          deps,
          args as { session_id: string; model_pref: { current: string } },
        ),
      'chat.session.clear_model_pref': async (args) =>
        handleClearModelPref(deps, args as { session_id: string }),
      'chat.default_model_pref.get': async () =>
        handleGetDefaultModelPref(deps),
      'chat.default_model_pref.set': async (args) =>
        handleSetDefaultModelPref(deps, args as { source_id: string }),
      'chat.tool_catalog.get': async () => handleToolCatalogGet(deps),
      'chat.tool_catalog.set': async (args) =>
        handleToolCatalogSet(
          deps,
          args as { enabled_kinds: readonly string[] },
        ),
      'chat.connection_mcp.list': async () => handleConnectionMcpList(deps),
      'chat.connection_mcp.get': async (args) =>
        handleConnectionMcpGet(
          deps,
          args as { connection_name: string },
        ),
      'chat.connection_mcp.set': async (args) =>
        handleConnectionMcpSet(deps, args),
      'chat.inbound_token.list': async () => handleInboundTokenList(deps),
      'chat.inbound_token.get': async (args) =>
        handleInboundTokenGet(deps, args),
      'chat.inbound_token.issue': async (args) =>
        handleInboundTokenIssue(deps, args),
      'chat.inbound_token.update_grants': async (args) =>
        handleInboundTokenUpdateGrants(deps, args),
      'chat.inbound_token.update_contract': async (args) =>
        handleInboundTokenUpdateContract(deps, args),
      'chat.inbound_token.revoke': async (args) =>
        handleInboundTokenRevoke(deps, args),
      'chat.inbound_token.delete': async (args) =>
        handleInboundTokenDelete(deps, args),
      'chat.inbound_token.tool_catalog': async () =>
        handleInboundTokenToolCatalog(deps),
    },
  };
};
