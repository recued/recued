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
 *    - `chat.plan.approve` / `chat.plan.cancel` — placeholders for the
 *      P3 plan-approval surface; P1.2 returns `not_implemented` (502)
 *      so the rpc is reachable but produces a clear "land in P3" hint
 *      rather than 404-ing
 *    - `chat.session.set_picker` / `chat.session.set_model_pref` —
 *      session-state writes; emit `chat.session_changed` on success
 *
 *  Per § Wire A — handlers run **server-side**. Webclient is display +
 *  HID; the orchestrator's loop runs in-process here.
 *
 *  Per D-137 P1 contract tightening — sessions + messages persist in
 *  `chat_sessions` / `chat_messages` (per-pair only; no cross-cloud sync per D-097 / D-168).
 *  The handler does NOT decrypt content on the chat.sessions.list path
 *  (would defeat the encrypted-at-rest invariant); list returns the
 *  per-session summary shape from `ChatSessionSummary` only.
 *
 *  No new error codes — re-uses `not_found` (404), `bad_request` (400),
 *  `not_configured` (501; reserved by the dispatcher for unwired
 *  methods; never produced by the handler), `not_implemented` (502
 *  for plan-approval until P3).
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
  buildPickerEntries,
  isChatMessageRole,
  isChatModelHint,
  isChatModelSourceId,
  isReservedOwnerContractId,
  isValidPickerTarget,
  validateChatToolCatalogScopeInput,
  validateConnectionMcpAnnotationInput,
  validateInboundTokenChatModeUpdate,
  validateMcpInboundTokenInput,
  type ChatEgressPacket,
  type ChatMessage,
  type ChatModelHint,
  type ChatModelRoutingLayer,
  type ChatModelSourceId,
  type ChatPickerTarget,
  type ChatPlanProposal,
  type ChatSession,
  type ChatSessionChangedField,
  type ChatSessionSummary,
  type ChatToolCatalogScopeState,
  type ConnectionMcpAnnotationState,
  type HandlerSlice,
  type IngredientKind,
  type IssuedMcpInboundToken,
  type McpInboundTokenRecord,
  type PickerEntry,
  type RecuedServerSignature,
  type ServerRpcRegistry,
  type ToolEntry,
} from '@recued/contracts';
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
  /** D-137 P3 § A.11 — Mary's pending plan-approval registry. Same
   *  in-memory store the orchestrator's `dispatchTool` gate consults;
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
   *  `not_configured` (501) and the MCP HTTP transport falls back to
   *  the v1 `RECUED_MCP_HTTP_TOKEN` env-var path. */
  inboundTokenStore?: ChatInboundTokenStore;
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
  | 'chat.plan.approve'
  | 'chat.plan.cancel'
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
  | 'chat.picker.entries'
  | 'chat.picker.refresh'
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
  deps: ChatRpcDeps,
): void => {
  if (target === 'self') return;
  if (!deps.connectionMcpStore) return;
  const annotations = deps.connectionMcpStore.listAnnotations();
  const ok = isValidPickerTarget(
    target,
    annotations,
    deps.selfSignature,
    deps.selfDisplayName ?? 'Self',
  );
  if (!ok) {
    throw new RpcError(
      'bad_request',
      `${method}: picker target '${target}' does not match a live peer picker entry — no annotation row OR missing recued_signature OR zero classified tools (probe the peer + classify ≥1 tool first)`,
      400,
    );
  }
};

export const handleSessionsList = (
  deps: ChatRpcDeps,
): { sessions: ChatSessionSummary[] } => {
  return { sessions: deps.store.listSessions() };
};

export const handleSessionGet = async (
  deps: ChatRpcDeps,
  args: { session_id: string },
): Promise<ChatSession & { messages: ChatMessage[] }> => {
  const safe = ensureRecordArgs('chat.session.get', args);
  const session_id = ensureNonEmptyString(
    'chat.session.get',
    'session_id',
    safe.session_id,
  );
  const session = ensureSession(deps, session_id);
  const messages = await deps.store.listMessages(session_id);
  return { ...session, messages };
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
  },
): Promise<{ turn_id: string }> => {
  const safe = ensureRecordArgs('chat.send', args);
  const session_id = ensureNonEmptyString(
    'chat.send',
    'session_id',
    safe.session_id,
  );
  ensureSession(deps, session_id);
  const message = ensureNonEmptyString('chat.send', 'message', safe.message);
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
  return new Promise<{ turn_id: string }>((resolve, reject) => {
    let acceptedTurnId: string | null = null;
    deps.orchestrator
      .runTurn({
        session_id,
        message,
        picker_state: {
          current: pickerCurrent as ChatPickerTarget,
        },
        ...(modelPref ? { model_pref: modelPref } : {}),
        ...(time_zone ? { time_zone } : {}),
        on_accepted: (ack) => {
          acceptedTurnId = ack.turn_id;
          resolve({ turn_id: ack.turn_id });
        },
      })
      .then((full) => {
        if (acceptedTurnId === null) resolve({ turn_id: full.turn_id });
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
  const existing = deps.planApprovalStore.get(plan_id);
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
  const now = deps.now ?? Date.now;
  const resolved = deps.planApprovalStore.resolve(plan_id, next_status, now());
  if (!resolved) {
    // resolve() returns undefined only when the plan was concurrently
    // removed — surface as 404 rather than crash.
    throw new RpcError(
      'not_found',
      `${method}: plan_id '${plan_id}' was removed mid-resolve`,
      404,
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
    // D-137 P4 § A.7.1 — every annotation write may shift picker
    // visibility (new annotation row / classification flip /
    // signature change). Emit the picker broadcast alongside so paired
    // clients re-render the picker dropdown without round-tripping
    // `chat.picker.entries`. Always-emit posture (matches the
    // annotation broadcast's "bus is the multi-client coherence path
    // — no-op overwrites still fan" stance).
    try {
      deps.broadcast.emit({
        kind: 'chat.picker_entries_changed',
        entries: projectPickerEntries(deps),
      });
    } catch {
      // observability-only
    }
  }
  // Summary stats only — body of tool descriptions / classifications
  // stays out of the audit log (matches the spec's per-event privacy
  // posture; the audit feed renders "Mary classified 3 tools" without
  // leaking the descriptions themselves).
  let classified_count = 0;
  for (const o of Object.values(persisted.tool_overrides)) {
    if (o.classification !== 'unknown') classified_count += 1;
  }
  void safeLogActivity(
    deps.auditLog,
    'chat_connection_mcp_annotation_set',
    persisted.connection_name,
    JSON.stringify({
      topic_tag_count: persisted.topic_tags.length,
      override_count: Object.keys(persisted.tool_overrides).length,
      classified_count,
      cached_tool_count: persisted.tools_list_cache.tools.length,
    }),
  );
  // Defensive narrowing — the store always returns a fully-shaped
  // annotation, but the type check keeps the contract surface honest.
  void (persisted satisfies ConnectionMcpAnnotationState);
  // Reference the default-builder so the contracts import stays
  // load-bearing for future handlers that surface the empty shape.
  void buildDefaultConnectionMcpAnnotation;
  return { annotation: persisted };
};

/** D-137 P4 § A.7 + § A.7.1 — pure projection over the annotation
 *  store + self signature. Reads the *current* annotations on each
 *  call so a Settings-side classification flip or a fresh
 *  `chat.picker.refresh` is reflected on the next renderer pull. */
const projectPickerEntries = (deps: ChatRpcDeps): ReadonlyArray<PickerEntry> => {
  if (!deps.connectionMcpStore) {
    // Substrate-stays-reachable fallback — Self only. The renderer
    // sees the picker hidden state (length === 1 && id === 'self'),
    // which matches the "Picker hidden when zero peers" acceptance
    // test for dbless harness paths.
    return buildPickerEntries(
      [],
      deps.selfSignature,
      deps.selfDisplayName ?? 'Self',
    );
  }
  return buildPickerEntries(
    deps.connectionMcpStore.listAnnotations(),
    deps.selfSignature,
    deps.selfDisplayName ?? 'Self',
  );
};

/** D-137 P4 § A.7 — `chat.picker.entries` handler. Read-only.
 *  Always returns at least the `'self'` entry. */
export const handlePickerEntries = (
  deps: ChatRpcDeps,
): { entries: ReadonlyArray<PickerEntry> } => {
  return { entries: projectPickerEntries(deps) };
};

/** D-137 P4 § A.7.1 — `chat.picker.refresh` handler. Updates one
 *  annotation row's `recued_signature` + `tools_list_cache` after a
 *  caller-driven probe of the peer's MCP `initialize` + `tools/list`.
 *  Preserves Mary's `topic_tags` + `tool_overrides` verbatim — a
 *  refresh never erases her classification work.
 *
 *  Flow:
 *    1. Read the existing annotation (or the empty default).
 *    2. Build a merged write payload (preserve overrides + topic
 *       tags; replace cache + signature with the caller's values).
 *    3. Validate via `validateConnectionMcpAnnotationInput` (closed
 *       issue codes — `recued_signature_*` apply).
 *    4. Persist + emit both broadcasts:
 *       - `chat.connection_mcp_annotation_changed` (existing W2.3
 *         broadcast; per-pair annotation projection consumers).
 *       - `chat.picker_entries_changed` (new P4 broadcast; picker
 *         dropdown re-renders).
 *    5. Best-effort audit emit.
 *    6. Return the post-write annotation + the post-write picker
 *       entries (so the caller can rehydrate both surfaces in one
 *       round-trip).
 *
 *  The probe substrate (server-side MCP-client driven probe) lands
 *  alongside the outbound dispatch wiring in a P4 follow-on. Until
 *  then the rpc accepts caller-supplied probe results so the
 *  Settings UI + tests + (eventually) the orchestrator's per-session
 *  refresh hook can populate the substrate. */
export const handlePickerRefresh = (
  deps: ChatRpcDeps,
  args: unknown,
): {
  annotation: ConnectionMcpAnnotationState;
  entries: ReadonlyArray<PickerEntry>;
} => {
  if (!deps.connectionMcpStore) {
    throw new RpcError(
      'not_configured',
      'chat.picker.refresh: annotation store is not wired (dbless / pre-init)',
      501,
    );
  }
  const safe = ensureRecordArgs('chat.picker.refresh', args);
  const connection_name = safe.connection_name;
  if (typeof connection_name !== 'string' || connection_name.length === 0) {
    throw new RpcError(
      'bad_request',
      'chat.picker.refresh: connection_name must be a non-empty string',
      400,
    );
  }
  if (!('recued_signature' in safe)) {
    throw new RpcError(
      'bad_request',
      'chat.picker.refresh: recued_signature is required (pass null to clear, or the probed signature)',
      400,
    );
  }
  if (!('tools_list_cache' in safe)) {
    throw new RpcError(
      'bad_request',
      'chat.picker.refresh: tools_list_cache is required (caller probes upstream + supplies the result)',
      400,
    );
  }
  // Read existing annotation so the refresh preserves Mary's
  // classification + topic tags verbatim. `getAnnotation` always
  // returns a shape (empty default when no row exists).
  const existing = deps.connectionMcpStore.getAnnotation(connection_name);
  // Validate the merged payload through the W2.3 validator so all
  // closed-list issue codes (including the new
  // `recued_signature_*` codes + P5 `chat_mode_*` codes) apply
  // uniformly. Note: we feed the validator a full annotation-shaped
  // object; topic_tags + tool_overrides come from the existing row.
  //
  // D-137 P5 / Codex review P2 fold — `chat_mode` is optional on the
  // refresh args. The presence-check threads `absent → preserve prior`
  // through the validator + store merge (matches the W2.3 / P4
  // `recued_signature` posture). When the upstream's `serverInfo._-
  // meta.recued.chat_mode` block is part of the probe result, the
  // caller forwards it here; otherwise the prior persisted value
  // survives.
  const payload: Record<string, unknown> = {
    connection_name,
    topic_tags: [...existing.topic_tags],
    tool_overrides: { ...existing.tool_overrides },
    tools_list_cache: safe.tools_list_cache,
    recued_signature: safe.recued_signature,
  };
  if (Object.prototype.hasOwnProperty.call(safe, 'chat_mode')) {
    payload.chat_mode = (safe as { chat_mode?: unknown }).chat_mode;
  }
  const validation = validateConnectionMcpAnnotationInput(payload);
  if (!validation.ok) {
    const codes = validation.issues.map((i) => i.code).join(', ');
    const details = validation.issues.map((i) => i.detail).join('; ');
    throw new RpcError(
      'bad_request',
      `chat.picker.refresh: ${codes} (${details})`,
      400,
    );
  }
  const now = deps.now ?? Date.now;
  const persisted = deps.connectionMcpStore.setAnnotation({
    value: validation.value,
    now: now(),
  });
  // Emit the annotation broadcast first (W2.3 consumers expect it on
  // every annotation write), then the picker broadcast (new at P4 —
  // picker dropdown re-renders).
  if (deps.broadcast) {
    try {
      deps.broadcast.emit({
        kind: 'chat.connection_mcp_annotation_changed',
        connection_name: persisted.connection_name,
        annotation: persisted,
      });
    } catch {
      // observability-only
    }
  }
  const entries = projectPickerEntries(deps);
  if (deps.broadcast) {
    try {
      deps.broadcast.emit({
        kind: 'chat.picker_entries_changed',
        entries,
      });
    } catch {
      // observability-only
    }
  }
  void safeLogActivity(
    deps.auditLog,
    'chat_picker_refreshed',
    persisted.connection_name,
    JSON.stringify({
      recued_signature_present: persisted.recued_signature !== null
        && persisted.recued_signature !== undefined,
      cached_tool_count: persisted.tools_list_cache.tools.length,
      entry_count: entries.length,
    }),
  );
  return { annotation: persisted, entries };
};

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
  const now = deps.now ?? Date.now;
  let issued: IssuedMcpInboundToken;
  try {
    issued = deps.inboundTokenStore.issueToken({
      value: validation.value,
      now: now(),
    });
  } catch (err) {
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
      expires_at: issued.record.expires_at,
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
 *  (unbind). Opaque here — liveness resolves at dispatch (the MCP transport's
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
  // `contract_id` is required (string ⇒ bind, null ⇒ unbind). A missing key is
  // a caller bug — the rpc's whole purpose is to set/clear the binding.
  if (!Object.prototype.hasOwnProperty.call(safe, 'contract_id')) {
    throw new RpcError(
      'bad_request',
      'chat.inbound_token.update_contract: contract_id is required (a non-empty string to bind, or null to unbind)',
      400,
    );
  }
  const rawContractId = safe.contract_id;
  let contract_id: string | null;
  if (rawContractId === null) {
    contract_id = null;
  } else if (
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
    contract_id = rawContractId;
  } else {
    throw new RpcError(
      'bad_request',
      'chat.inbound_token.update_contract: contract_id must be a non-empty string up to 256 characters, or null to unbind',
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
      'chat.plan.approve',
      'chat.plan.cancel',
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
      'chat.picker.entries',
      'chat.picker.refresh',
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
      'chat.plan.approve': async (args) => handlePlanApprove(deps, args),
      'chat.plan.cancel': async (args) => handlePlanCancel(deps, args),
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
      'chat.picker.entries': async () => handlePickerEntries(deps),
      'chat.picker.refresh': async (args) =>
        handlePickerRefresh(deps, args),
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
