import {canonicalJSONStringifyStrict} from '@recued/crypto';
import { planApproval } from '@recued/gateway';
/** Project bounded, owner-authorized host records without deciding which work is satisfied. */
import { NON_RETAINABLE_RECALL_TOOL_NAMES, isLocalMutationReceiptSummary, type ChatMessage,
  type ChatPlanExecutionReceipt, type ChatPlanProposal, type InternalToolRegistry } from '@recued/contracts';
import { isNonTerminalToolResult } from './chat-tool-call-context.js';
import { identifierArgumentValues } from './tool-argument-grounding.js';
import { toolNameFromRow } from './chat-tool-row.js';

export interface RequestRecord {
  readonly request_id: string;
  readonly message_id: string;
  readonly text: string;
  readonly received_at: number;
}
export interface InvocationReceipt {
  readonly invocation_id: string;
  readonly completed_for_request_id: string;
  readonly tool_name: string;
  readonly args: unknown;
  /** Absent on a read's receipt in the main turn's copy ({@link withoutCurrentReadResults}). */
  readonly result?: unknown;
  readonly started_at: number;
  readonly completed_at: number;
}
/** A persisted assistant message; its text is not proof of a tool effect or client delivery. */
export interface RecordedReply {
  readonly request_id: string;
  readonly message_id: string;
  readonly text: string;
  readonly recorded_at: number;
}
/** The closing writer runs before the current answer is committed to chat history. */
export interface PreparedReply {
  readonly request_id: string;
  readonly text: string;
}
/** A failed or interrupted invocation is an observed attempt, never a successful effect receipt. */
export interface UnsuccessfulActionAttempt {
  readonly invocation_id: string;
  readonly request_id: string;
  readonly owner_request: RequestRecord;
  readonly tool_name: string;
  readonly args: unknown;
  readonly state: 'failed' | 'interrupted';
  readonly effect_confirmation: 'not_established_by_failed_state';
  readonly started_at: number;
  readonly updated_at: number;
  readonly result_message_id?: string;
  readonly result_recorded_at?: number;
  readonly result_envelope?: unknown;
}
/** Fresh native observations, never a grant or an effect receipt. */
export interface ApprovalEvidenceRows {
  readonly observed_at: number;
  readonly plans: readonly ChatPlanProposal[];
  readonly incomplete: boolean;
}
export interface PendingApprovalRows extends ApprovalEvidenceRows {
  /** Separately bounded; approvals do not become execution receipts. Older
   * readers can omit this observation, which remains unavailable. */
  readonly approved_plans?: readonly ChatPlanProposal[];
  readonly approved_incomplete?: boolean;
}
export type CancelledApprovalRows = ApprovalEvidenceRows;
/** Decrypted native receipts, read afresh from the durable plan store. A receipt
 * describes its original action; it neither contains a tool return nor grants a retry. */
export interface CompletedHeldActionRows {
  readonly observed_at: number;
  readonly records: readonly {
    readonly plan: ChatPlanProposal;
    readonly execution: Extract<ChatPlanExecutionReceipt, { status: 'completed' }>;
    readonly recorded_at: number;
  }[];
  readonly incomplete: boolean;
  /** Approved held writes that ran without a confirmed result: the receipt says `failed` or `unknown`. Absent from
   *  an older reader, whose state is then unavailable. */
  readonly unconfirmed?: readonly {
    readonly plan: ChatPlanProposal;
    readonly execution: Extract<ChatPlanExecutionReceipt, { status: 'failed' | 'unknown' }>;
    readonly recorded_at: number;
  }[];
  readonly unconfirmed_incomplete?: boolean;
}
export interface CompletedHeldActionState {
  readonly observation: 'available' | 'unavailable';
  readonly observed_at: number;
  readonly scope: 'recent_same_session_owner_held_actions';
  readonly incomplete: boolean;
  readonly actions: readonly {
    readonly plan_id: string;
    readonly completed_for_request_id: string;
    readonly owner_request: RequestRecord;
    readonly tool_name: string;
    readonly args: unknown;
    readonly args_hash: string;
    readonly hold_run_id: string;
    readonly target_instance?: string;
    readonly approval_status: 'approved';
    readonly execution_status: 'completed';
    readonly created_at: number;
    readonly approved_at: number;
    readonly consumed_at: number;
    readonly receipt: Omit<Extract<ChatPlanExecutionReceipt, { status: 'completed' }>, 'status' | 'turn_id'> & {
      readonly recorded_at: number;
    };
  }[];
}
export const COMPLETED_HELD_ACTION_LIMITS = { plans: 8, recordBytes: 65_536, storedBytes: 131_072 } as const;
export const completedHeldActionState = (rows: CompletedHeldActionRows | undefined, sessionId: string,
  messages: readonly ChatMessage[], registry: Pick<InternalToolRegistry, 'getByName'>,
  observedAt: number): CompletedHeldActionState => {
  const state = { observation: rows ? 'available' as const : 'unavailable' as const,
    observed_at: rows?.observed_at ?? observedAt, scope: 'recent_same_session_owner_held_actions' as const,
    incomplete: rows?.incomplete ?? true, actions: [] as Array<CompletedHeldActionState['actions'][number]> };
  if (!rows) return state;
  const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  for (const { plan, execution, recorded_at } of rows.records.slice(0, COMPLETED_HELD_ACTION_LIMITS.plans)) {
    if (plan.session_id !== sessionId || !registry.getByName(plan.tool)) continue;
    const owner = messages.find(m => m.session_id === sessionId && m.target_server === 'self'
      && m.role === 'user' && m.turn_id === plan.turn_id);
    if (!owner || plan.status !== 'approved' || !plan.hold?.run_id || plan.hold.lapsed_at !== undefined
      || plan.classification !== 'write' || plan.tier !== 1 || !object(plan.args)
      || execution.status !== 'completed' || execution.turn_id !== plan.turn_id
      || execution.run_id !== undefined && execution.run_id !== plan.hold.run_id
      || !execution.run_id && !execution.local_receipt
      || !time(owner.ts) || !time(plan.created_at) || !time(plan.resolved_at) || !time(plan.consumed_at)
      || !time(recorded_at) || !time(state.observed_at) || owner.ts > plan.created_at
      || plan.created_at > plan.resolved_at || plan.resolved_at > plan.consumed_at
      || plan.consumed_at > recorded_at || recorded_at > state.observed_at
      || execution.local_receipt !== undefined && (!isLocalMutationReceiptSummary(execution.local_receipt)
        || execution.local_receipt.committed_at < plan.consumed_at
        || execution.local_receipt.committed_at > state.observed_at)) {
      state.incomplete = true; continue;
    }
    const { status: _status, turn_id: _turn, ...receipt } = execution;
    const action: CompletedHeldActionState['actions'][number] = {
      plan_id: plan.plan_id, completed_for_request_id: plan.turn_id,
      owner_request: { request_id: plan.turn_id, message_id: owner.id, text: owner.content, received_at: owner.ts },
      tool_name: plan.tool, args: structuredClone(plan.args), args_hash: plan.args_hash,
      hold_run_id: plan.hold.run_id, ...(plan.target_instance ? { target_instance: plan.target_instance } : {}),
      approval_status: 'approved', execution_status: 'completed', created_at: plan.created_at,
      approved_at: plan.resolved_at, consumed_at: plan.consumed_at,
      receipt: { ...receipt, recorded_at },
    };
    if (Buffer.byteLength(JSON.stringify(action), 'utf8') > COMPLETED_HELD_ACTION_LIMITS.recordBytes) {
      state.incomplete = true; continue;
    }
    state.actions.push(action);
  }
  if (rows.records.length > COMPLETED_HELD_ACTION_LIMITS.plans) state.incomplete = true;
  return state;
};
/** An approved held write that ran and has no confirmed result (2026-11-19). It was in no record: `failed` was
 *  skipped and `unknown` only marked the completed list incomplete, so the next turn had only the chat, where the
 *  model had called the attempt a success after a read showed the state it asked for (6 of 6 runs). A read shows the
 *  current state, not what the attempt did. */
export interface UnconfirmedHeldActionState {
  readonly observation: 'available' | 'unavailable';
  readonly observed_at: number;
  readonly scope: 'recent_same_session_owner_held_actions';
  readonly incomplete: boolean;
  readonly actions: readonly {
    readonly plan_id: string;
    readonly attempted_for_request_id: string;
    readonly owner_request: RequestRecord;
    readonly tool_name: string;
    readonly args: unknown;
    readonly hold_run_id: string;
    readonly target_instance?: string;
    readonly approval_status: 'approved';
    readonly execution_status: 'failed' | 'unknown';
    readonly effect_confirmation: 'not_established';
    /** The failure's reason code. Not its detail: that is the tool's message to the turn that handled the failure
     *  (the continuation reads it in its held result), and repeated on every later turn it repeats whatever it says.
     *  Measured: a detail ending "Read the current event before deciding what to do." rode every turn, and two of four
     *  runs then read the event 6 and 10 times in one turn. */
    readonly reason?: string;
    readonly approved_at: number;
    readonly consumed_at: number;
    readonly recorded_at: number;
  }[];
}
export const UNCONFIRMED_HELD_ACTION_LIMITS = { plans: 8, recordBytes: 65_536 } as const;
export const unconfirmedHeldActionState = (rows: CompletedHeldActionRows | undefined, sessionId: string,
  messages: readonly ChatMessage[], registry: Pick<InternalToolRegistry, 'getByName'>,
  observedAt: number): UnconfirmedHeldActionState => {
  const listed = rows?.unconfirmed;
  const state = { observation: listed ? 'available' as const : 'unavailable' as const,
    observed_at: rows?.observed_at ?? observedAt, scope: 'recent_same_session_owner_held_actions' as const,
    incomplete: listed ? rows?.unconfirmed_incomplete === true : true,
    actions: [] as Array<UnconfirmedHeldActionState['actions'][number]> };
  if (!listed) return state;
  const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  for (const { plan, execution, recorded_at } of listed.slice(0, UNCONFIRMED_HELD_ACTION_LIMITS.plans)) {
    if (plan.session_id !== sessionId || !registry.getByName(plan.tool)) continue;
    const owner = messages.find(m => m.session_id === sessionId && m.target_server === 'self'
      && m.role === 'user' && m.turn_id === plan.turn_id);
    const run_id = execution.status === 'failed' ? execution.run_id : undefined;
    if (!owner || plan.status !== 'approved' || !plan.hold?.run_id || plan.hold.lapsed_at !== undefined
      || plan.classification !== 'write' || plan.tier !== 1 || !object(plan.args)
      || (execution.status !== 'failed' && execution.status !== 'unknown') || execution.turn_id !== plan.turn_id
      || run_id !== undefined && run_id !== plan.hold.run_id
      || !time(owner.ts) || !time(plan.created_at) || !time(plan.resolved_at) || !time(plan.consumed_at)
      || !time(recorded_at) || !time(state.observed_at) || owner.ts > plan.created_at
      || plan.created_at > plan.resolved_at || plan.resolved_at > plan.consumed_at
      || plan.consumed_at > recorded_at || recorded_at > state.observed_at) {
      state.incomplete = true; continue;
    }
    const action: UnconfirmedHeldActionState['actions'][number] = {
      plan_id: plan.plan_id, attempted_for_request_id: plan.turn_id,
      owner_request: { request_id: plan.turn_id, message_id: owner.id, text: owner.content, received_at: owner.ts },
      tool_name: plan.tool, args: structuredClone(plan.args), hold_run_id: plan.hold.run_id,
      ...(plan.target_instance ? { target_instance: plan.target_instance } : {}),
      approval_status: 'approved', execution_status: execution.status, effect_confirmation: 'not_established',
      ...(execution.status === 'failed' ? { reason: execution.reason } : {}),
      approved_at: plan.resolved_at, consumed_at: plan.consumed_at, recorded_at,
    };
    if (Buffer.byteLength(JSON.stringify(action), 'utf8') > UNCONFIRMED_HELD_ACTION_LIMITS.recordBytes) {
      state.incomplete = true; continue;
    }
    state.actions.push(action);
  }
  if (listed.length > UNCONFIRMED_HELD_ACTION_LIMITS.plans) state.incomplete = true;
  return state;
};
export interface PendingApprovalState {
  readonly observation: 'available' | 'unavailable';
  readonly observed_at: number;
  readonly scope: 'same_session_registered_tools';
  readonly incomplete: boolean;
  readonly plans: readonly {
    readonly plan_id: string;
    readonly proposed_for_request_id: string;
    readonly owner_request?: RequestRecord;
    readonly tool_name: string;
    readonly args: unknown;
    readonly approval_status: 'awaiting_user_approval';
    readonly execution_on_approval: 'host_resume' | 'later_dispatch';
    readonly effect_confirmation: 'not_established_by_pending_approval';
    readonly created_at: number;
  }[];
}
export const PENDING_APPROVAL_LIMITS = { plans: 16, recordBytes: 65_536, storedBytes: 131_072 } as const;
export interface ApprovedActionState {
  readonly observation: 'available' | 'unavailable';
  readonly observed_at: number;
  readonly scope: 'same_session_approved_not_dispatched';
  readonly incomplete: boolean;
  readonly actions: readonly {
    readonly plan_id: string;
    readonly approved_for_request_id: string;
    readonly owner_request: RequestRecord;
    readonly tool_name: string;
    readonly args: unknown;
    readonly approval_status: 'approved';
    readonly execution_status: 'not_dispatched';
    readonly execution_on_continuation: 'host_resume' | 'later_dispatch';
    readonly effect_confirmation: 'not_established_by_approval';
    readonly created_at: number;
    readonly approved_at: number;
  }[];
}
export const approvedActionState = (rows: PendingApprovalRows | undefined, sessionId: string,
  messages: readonly ChatMessage[], registry: Pick<InternalToolRegistry, 'getByName'>,
  observedAt: number): ApprovedActionState => {
  const plans = rows?.approved_plans;
  const state = { observation: plans ? 'available' as const : 'unavailable' as const,
    observed_at: rows?.observed_at ?? observedAt, scope: 'same_session_approved_not_dispatched' as const,
    incomplete: rows?.approved_incomplete ?? true, actions: [] as Array<ApprovedActionState['actions'][number]> };
  if (!plans) return state;
  for (const plan of plans.slice(0, PENDING_APPROVAL_LIMITS.plans)) {
    if (plan.session_id !== sessionId || !registry.getByName(plan.tool)) continue;
    const owner = messages.find(m => m.session_id === sessionId && m.target_server === 'self'
      && m.role === 'user' && m.turn_id === plan.turn_id);
    if (!owner || plan.status !== 'approved' || plan.consumed_at !== undefined || plan.hold?.lapsed_at !== undefined
      || !object(plan.args) || plan.classification !== 'write' || plan.tier !== 1
      || !Number.isSafeInteger(owner.ts) || !Number.isSafeInteger(plan.created_at)
      || !Number.isSafeInteger(plan.resolved_at) || !Number.isSafeInteger(state.observed_at)
      || owner.ts < 0 || owner.ts > plan.created_at || plan.created_at > plan.resolved_at!
      || plan.resolved_at! > state.observed_at
      || plan.resolved_at! < state.observed_at - planApproval.PLAN_APPROVAL_CONSUMPTION_TTL_MS) { state.incomplete = true; continue; }
    const action: ApprovedActionState['actions'][number] = {
      plan_id: plan.plan_id, approved_for_request_id: plan.turn_id,
      owner_request: { request_id: plan.turn_id, message_id: owner.id, text: owner.content, received_at: owner.ts },
      tool_name: plan.tool, args: structuredClone(plan.args), approval_status: 'approved', execution_status: 'not_dispatched',
      execution_on_continuation: plan.hold ? 'host_resume' : 'later_dispatch',
      effect_confirmation: 'not_established_by_approval', created_at: plan.created_at, approved_at: plan.resolved_at!,
    };
    if (Buffer.byteLength(JSON.stringify(action), 'utf8') > PENDING_APPROVAL_LIMITS.recordBytes) {
      state.incomplete = true; continue;
    }
    state.actions.push(action);
  }
  if (plans.length > PENDING_APPROVAL_LIMITS.plans) state.incomplete = true;
  return state;
};
export const pendingApprovalState = (rows: PendingApprovalRows | undefined, sessionId: string,
  messages: readonly ChatMessage[], registry: Pick<InternalToolRegistry, 'getByName'>,
  observedAt: number): PendingApprovalState => {
  const state = {observation: rows ? 'available' as const : 'unavailable' as const,
    observed_at: rows?.observed_at ?? observedAt, scope: 'same_session_registered_tools' as const,
    incomplete: rows?.incomplete ?? true, plans: [] as Array<PendingApprovalState['plans'][number]>};
  if (!rows) return state;
  for (const plan of rows.plans.slice(0, PENDING_APPROVAL_LIMITS.plans)) {
    if (plan.session_id !== sessionId || !registry.getByName(plan.tool)) continue;
    if (plan.status !== 'proposed' || plan.consumed_at !== undefined || plan.hold?.lapsed_at !== undefined
      || !object(plan.args) || !Number.isFinite(plan.created_at) || plan.created_at > state.observed_at) {
      state.incomplete = true; continue;
    }
    const owner = messages.find(m => m.session_id === sessionId && m.target_server === 'self'
      && m.role === 'user' && m.turn_id === plan.turn_id);
    const row = {plan_id: plan.plan_id, proposed_for_request_id: plan.turn_id,
      ...(owner ? {owner_request:{request_id:plan.turn_id,message_id:owner.id,text:owner.content,received_at:owner.ts}} : {}),
      tool_name:plan.tool, args:structuredClone(plan.args), approval_status:'awaiting_user_approval' as const,
      execution_on_approval:plan.hold ? 'host_resume' as const : 'later_dispatch' as const,
      effect_confirmation:'not_established_by_pending_approval' as const, created_at:plan.created_at};
    if (Buffer.byteLength(JSON.stringify(row),'utf8') > PENDING_APPROVAL_LIMITS.recordBytes) {state.incomplete=true;continue;}
    state.plans.push(row);
  }
  if (rows.plans.length > PENDING_APPROVAL_LIMITS.plans) state.incomplete=true;
  return state;
};

/** A closed proposal is historical status, not a standing prohibition or a new request. */
export interface CancelledApprovalState {
  readonly observation: 'available' | 'unavailable';
  readonly observed_at: number;
  readonly scope: 'recent_same_session_owner_proposals';
  readonly incomplete: boolean;
  readonly plans: readonly {
    readonly plan_id: string;
    readonly proposed_for_request_id: string;
    readonly owner_request: RequestRecord;
    readonly tool_name: string;
    readonly args: unknown;
    readonly approval_status: 'cancelled';
    readonly cancellation_reason: 'cancelled' | 'expired_unanswered';
    readonly target_instance?: string;
    readonly execution_status: 'not_dispatched_by_this_plan';
    readonly created_at: number;
    readonly resolved_at: number;
  }[];
}
export const CANCELLED_APPROVAL_LIMITS = { plans: 8, recordBytes: 65_536, storedBytes: 131_072 } as const;
export const cancelledApprovalState = (rows: CancelledApprovalRows | undefined, sessionId: string,
  messages: readonly ChatMessage[], registry: Pick<InternalToolRegistry, 'getByName'>,
  observedAt: number): CancelledApprovalState => {
  const state = { observation: rows ? 'available' as const : 'unavailable' as const,
    observed_at: rows?.observed_at ?? observedAt, scope: 'recent_same_session_owner_proposals' as const,
    incomplete: rows?.incomplete ?? true, plans: [] as Array<CancelledApprovalState['plans'][number]> };
  if (!rows) return state;
  for (const plan of rows.plans.slice(0, CANCELLED_APPROVAL_LIMITS.plans)) {
    if (plan.session_id !== sessionId || !registry.getByName(plan.tool)) continue;
    // Owner rows come from the authorized history window, not from plan arguments.
    const owner = messages.find(m => m.session_id === sessionId && m.target_server === 'self'
      && m.role === 'user' && m.turn_id === plan.turn_id);
    if (!owner || plan.status !== 'cancelled' || plan.consumed_at !== undefined || !object(plan.args)
      || !Number.isFinite(owner.ts) || !Number.isFinite(plan.created_at) || !Number.isFinite(plan.resolved_at)
      || !Number.isFinite(state.observed_at) || owner.ts > plan.created_at
      || plan.resolved_at! < plan.created_at || plan.resolved_at! > state.observed_at
      || plan.hold?.lapsed_at !== undefined && plan.hold.lapsed_at !== plan.resolved_at) {
      state.incomplete = true; continue;
    }
    const row: CancelledApprovalState['plans'][number] = {
      plan_id: plan.plan_id, proposed_for_request_id: plan.turn_id,
      owner_request: { request_id: plan.turn_id, message_id: owner.id, text: owner.content, received_at: owner.ts },
      tool_name: plan.tool, args: structuredClone(plan.args), approval_status: 'cancelled',
      ...(plan.target_instance ? { target_instance: plan.target_instance } : {}),
      cancellation_reason: plan.hold?.lapsed_at === undefined ? 'cancelled' : 'expired_unanswered',
      execution_status: 'not_dispatched_by_this_plan', created_at: plan.created_at, resolved_at: plan.resolved_at!,
    };
    if (Buffer.byteLength(JSON.stringify(row), 'utf8') > CANCELLED_APPROVAL_LIMITS.recordBytes) {
      state.incomplete = true; continue;
    }
    state.plans.push(row);
  }
  if (rows.plans.length > CANCELLED_APPROVAL_LIMITS.plans) state.incomplete = true;
  return state;
};

export interface RequestExecutionEvidence {
  readonly completed_held_actions?: CompletedHeldActionState;
  readonly unconfirmed_held_actions?: UnconfirmedHeldActionState;
  readonly pending_approvals?: PendingApprovalState;
  readonly approved_actions?: ApprovedActionState;
  readonly cancelled_approvals?: CancelledApprovalState;
  readonly resolved_action_outcomes?: readonly ResolvedActionOutcome[];
  readonly unsuccessful_action_attempts?: readonly UnsuccessfulActionAttempt[];
  readonly current_request: RequestRecord;
  readonly successful_calls_for_current_request: readonly InvocationReceipt[];
  readonly earlier_requests: readonly RequestRecord[];
  readonly successful_actions_for_earlier_requests: readonly InvocationReceipt[];
  readonly recorded_assistant_replies: readonly RecordedReply[];
  readonly prepared_assistant_reply?: PreparedReply;
  readonly coverage?: { readonly scope: 'selected_same_session_requests'; readonly incomplete: boolean };
}
export const REQUEST_EVIDENCE_LIMITS = { turns: 32, recentTurns: 16, rows: 384, rowsPerTurn: 64,
  storageBytes: 524_288, recordBytes: 65_536, packetBytes: 98_304 } as const;
export interface RequestEvidenceWindow {
  readonly messages: readonly ChatMessage[];
  readonly incomplete: boolean;
  readonly excluded_reply_turn_ids: readonly string[];
}
const object = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null;

/** A call row's arguments: `<name>(<json>)`, or the bare `<name>` that `renderToolRow` writes for a call with none
 *  (2026-11-19: both readers below took only the first, so a successful call with no arguments had no receipt, and a
 *  failed one no attempt). Undefined for any other row; JSON that does not parse throws, for the caller's catch. */
const callRowArgs = (content: string, tool_name: string): unknown => {
  if (content === tool_name) return {};
  const prefix = `${tool_name}(`;
  return content.startsWith(prefix) && content.endsWith(')') ? JSON.parse(content.slice(prefix.length, -1)) : undefined;
};

export const requestExecutionEvidence = (messages: readonly ChatMessage[], sessionId: string, turnId: string,
  registry: Pick<InternalToolRegistry, 'getByName'>,
  earlierUserMessages: readonly string[] = [], excludedReplyTurns: readonly string[] = []): RequestExecutionEvidence | undefined => {
  const local = messages.filter(m => m.session_id === sessionId && m.target_server === 'self');
  const users = local.filter(m => m.role === 'user' && m.turn_id !== undefined);
  const requests = new Map(users.map(m => [m.turn_id!, {
    request_id: m.turn_id!, message_id: m.id, text: m.content, received_at: m.ts,
  }]));
  const current = requests.get(turnId);
  // Synthetic continuations and quiet retries may have no persisted user row.
  // They must not fabricate a user request or fail the reader over this optional context.
  if (!current) return undefined;
  const rows = new Map(local.map(m => [m.id, m]));
  const receipts: InvocationReceipt[] = [];
  for (const m of local) {
    const call = m.tool_call;
    if (m.role !== 'tool' || !call || call.state !== 'succeeded'
      || call.message_id !== m.id || call.session_id !== sessionId || call.turn_id !== m.turn_id
      || !requests.has(call.turn_id) || NON_RETAINABLE_RECALL_TOOL_NAMES.has(call.tool_name)) continue;
    const resultRow = rows.get(`${m.id}:result`);
    if (!resultRow || resultRow.role !== 'tool' || resultRow.turn_id !== call.turn_id) continue;
    const resultPrefix = `${call.tool_name}: `;
    if (!resultRow.content.startsWith(resultPrefix)) continue;
    try {
      const args = callRowArgs(m.content, call.tool_name);
      if (args === undefined) continue;
      const envelope = object(JSON.parse(resultRow.content.slice(resultPrefix.length)));
      if (envelope?.ok !== true || envelope.run_failed === true || !Object.hasOwn(envelope, 'result')
        || isNonTerminalToolResult(envelope) || isNonTerminalToolResult(envelope.result)) continue;
      const tool = registry.getByName(call.tool_name);
      if (!tool || call.turn_id !== turnId && tool.classification === 'read') continue;
      receipts.push({ invocation_id: m.id, completed_for_request_id: call.turn_id, tool_name: call.tool_name,
        args, result: envelope.result, started_at: call.started_at, completed_at: resultRow.ts });
    } catch { /* Non-JSON or incompatible historical rows establish no receipt. */ }
  }
  const attempts: UnsuccessfulActionAttempt[] = [];
  for (const m of local) {
    const call = m.tool_call;
    if (m.role !== 'tool' || !call || (call.state !== 'failed' && call.state !== 'interrupted')
      || call.message_id !== m.id || call.session_id !== sessionId || call.turn_id !== m.turn_id
      || !requests.has(call.turn_id) || NON_RETAINABLE_RECALL_TOOL_NAMES.has(call.tool_name)) continue;
    const tool = registry.getByName(call.tool_name), owner = requests.get(call.turn_id)!;
    if (!tool || tool.classification === 'read' || owner.received_at > current.received_at
      || !Number.isFinite(call.started_at) || !Number.isFinite(call.updated_at)
      || call.updated_at < call.started_at || call.started_at < owner.received_at
      || call.turn_id !== turnId && call.updated_at > current.received_at) continue;
    try {
      const args = callRowArgs(m.content, call.tool_name);
      if (args === undefined) continue;
      const attempt: UnsuccessfulActionAttempt = {invocation_id:m.id, request_id:call.turn_id,
        owner_request:owner, tool_name:call.tool_name, args, state:call.state,
        effect_confirmation:'not_established_by_failed_state', started_at:call.started_at, updated_at:call.updated_at};
      const resultRow = rows.get(`${m.id}:result`), resultPrefix = `${call.tool_name}: `;
      if (resultRow?.role === 'tool' && resultRow.turn_id === call.turn_id
        && resultRow.ts >= call.started_at && (call.turn_id === turnId || resultRow.ts <= current.received_at)
        && resultRow.content.startsWith(resultPrefix)) {
        let envelope: unknown;
        try { envelope = JSON.parse(resultRow.content.slice(resultPrefix.length)); } catch { /* unknown result */ }
        // Preserve a recorded envelope without inferring nonexecution from its prose.
        if (object(envelope)) {
          attempts.push({...attempt, result_message_id:resultRow.id, result_recorded_at:resultRow.ts, result_envelope:envelope});
          continue;
        }
      }
      attempts.push(attempt);
    } catch { /* Incompatible historical text cannot become a host attempt record. */ }
  }
  const earlier = receipts.filter(r => r.completed_for_request_id !== turnId);
  const selected = new Set(earlier.map(r => r.completed_for_request_id));
  const unfoldedTexts = new Set(earlierUserMessages);
  for (const request of requests.values()) if (unfoldedTexts.has(request.text)) selected.add(request.request_id);
  // Recall results and their answer text remain in their turn-scoped privacy envelope.
  const recallTurns = new Set([...excludedReplyTurns, ...local.filter(m =>
    m.tool_call && NON_RETAINABLE_RECALL_TOOL_NAMES.has(m.tool_call.tool_name)
    || m.tool_calls?.some(call => NON_RETAINABLE_RECALL_TOOL_NAMES.has(call.tool_name)))
    .map(m => m.turn_id)]);
  const replies = local.filter(m => m.role === 'assistant' && m.target_server === 'self'
    && m.turn_id !== undefined && requests.has(m.turn_id) && !recallTurns.has(m.turn_id)
    && (m.turn_id === turnId || selected.has(m.turn_id)) && m.content.trim().length > 0);
  return { ...(attempts.length ? {unsuccessful_action_attempts:attempts} : {}), current_request: current,
    successful_calls_for_current_request: receipts.filter(r => r.completed_for_request_id === turnId),
    earlier_requests: [...requests.values()].filter(r => r.request_id !== turnId && selected.has(r.request_id)),
    successful_actions_for_earlier_requests: earlier,
    recorded_assistant_replies: replies.map(m => ({ request_id: m.turn_id!, message_id: m.id,
      text: m.content, recorded_at: m.ts })) };
};

/** The records as the main turn reads them (2026-11-19; the owner's "3": trim what the records add). Left out:
 *  earlier assistant replies (the chat tail holds the recent ones, and a reply is never evidence), `coverage` unless
 *  something was left out, and every list and approval state with nothing in it. Measured under Standard, they were
 *  about 40% of the records' 1,685 characters a call. Kept: the earlier owner requests the records select (an
 *  identifier the owner gave there stays grounded), receipts, attempts and outcomes, and each approval state that
 *  holds a plan or could not be read. A turn with none of them sends no records.
 *
 *  ⛔ `current_request` stays whenever records are sent. It was left out too, as the turn's own `user_message` again,
 *  and the model could then not tell that `successful_calls_for_current_request` were this turn's: asked to check a
 *  title, it read the event again and again under "a new request to check an external record's current state needs
 *  a relevant read in that owner turn" (up to 10 reads in one turn; 9 of 18 such turns looped, 0 of 6 before). */
export type ReaderRequestRecords = Partial<Omit<RequestExecutionEvidence, 'recorded_assistant_replies'>>;
export const readerRequestRecords = (evidence: RequestExecutionEvidence): ReaderRequestRecords | undefined => {
  const records: Record<string, unknown> = {};
  for (const field of ['earlier_requests', 'successful_calls_for_current_request', 'successful_actions_for_earlier_requests',
    'unsuccessful_action_attempts', 'resolved_action_outcomes'] as const) {
    const list = evidence[field];
    if (list !== undefined && list.length > 0) records[field] = list;
  }
  const states = [['pending_approvals', evidence.pending_approvals?.plans], ['approved_actions', evidence.approved_actions?.actions],
    ['cancelled_approvals', evidence.cancelled_approvals?.plans], ['completed_held_actions', evidence.completed_held_actions?.actions],
    ['unconfirmed_held_actions', evidence.unconfirmed_held_actions?.actions]] as const;
  for (const [field, entries] of states) {
    const state = evidence[field];
    if (state !== undefined && (state.observation !== 'available' || state.incomplete || (entries?.length ?? 0) > 0)) records[field] = state;
  }
  if (evidence.coverage?.incomplete === true) records.coverage = evidence.coverage;
  return Object.keys(records).length > 0
    ? { current_request: evidence.current_request, ...records } as ReaderRequestRecords : undefined;
};

/** The main turn's copy of the records: a read's receipt for the current request keeps the call and drops its result.
 *  The result is already in the turn's `prior_tool_calls` (or, once folded, in the brief). Repeated here it doubled
 *  every read in the packet (35,336 characters against Standard's 17,516 on the same round, 2026-11-18). It also came
 *  first within the records' byte limit, so a large read could leave no room for the pending, approved and cancelled
 *  states added last. And the closing fold counted it as next-turn content, which it never is: a read leaves the records
 *  once its request is over. A write keeps its result: its receipt is what stops the act being done again. The brief's
 *  own records are built separately and keep every result, since its writer cites them. */
export const withoutCurrentReadResults = (evidence: RequestExecutionEvidence,
  registry: Pick<InternalToolRegistry, 'getByName'>): RequestExecutionEvidence => ({
  ...evidence,
  successful_calls_for_current_request: evidence.successful_calls_for_current_request.map(receipt => {
    if (registry.getByName(receipt.tool_name)?.classification !== 'read') return receipt;
    const { result: _result, ...call } = receipt;
    return call;
  }),
});

/** 2026-11-20 (the owner: "go ahead, take slice 4 too, but with the extra tokens spending does get the job done
 *  correctly, so we are not just looking for a lower cost solution but a correct solution that happens to be lower") —
 *  a browser call's receipt in the main turn's records keeps what ran and how it ended (success, errors and their
 *  codes, the batch's statuses and checks, the steps done, the tab's page, address and title) and leaves out the pages
 *  it read: views, outlines, text, reads, element lists, and the output's `sidebar`, a second copy of its `render`.
 *
 *  ⛔⛔ AFTER A FOLD, THE PAGES IN THESE RECORDS WERE WHAT THE MODEL WENT BACK TO. A receipt carried the call's raw
 *  result: twice (`render` and `sidebar`), without the projection that marks a view current or superseded, and long after
 *  `prior_tool_calls` had been folded into the brief, which keeps no refs. In all five captured post-fold packets of
 *  browser task P, the earlier ref the model then clicked (e43, e47, e22, e56, e44) was in these records 7 to 11 times
 *  and in the turn's own history at most once (recued-bridge-vs-browser-use/results/analysis/
 *  2026-11-20-P-four-way-handoff-386igzlf). An earlier page is exactly what must not outlive its fold.
 *
 *  While the call is in `prior_tool_calls` its pages are there, projected; once folded, the brief and the round the
 *  fold kept carry what the turn needs. The receipt is still what keeps an act from being done again. Measured on the
 *  11-20 Full20: 38 browser receipts held 977,294 characters, 14% of them receipts, and the records averaged 38,000
 *  characters a main call, more than the 26,000 of the turn's history. A tool is the browser's by its name (the
 *  Toolkit's all name a web page or the browser), or by a `browser_` field in its result. */
const BROWSER_TOOL = /^(?:recued-core|kitchen)\/[a-z0-9-]*(?:web|browser)[a-z0-9-]*$/u;
const BROWSER_PAGE_CONTENT: ReadonlySet<string> = new Set(['view', 'outline', 'html', 'text', 'reads', 'sidebar', 'browser_attention',
  'interaction_targets', 'extraction_targets', 'field_evidence', 'entry_view', 'entry_data']);
const isBrowserResult = (tool_name: string, result: unknown): boolean => BROWSER_TOOL.test(tool_name)
  || Object.keys(object(result) ?? {}).some((key) => key.startsWith('browser_'));
const withoutPageContent = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutPageContent);
  const record = object(value);
  return record === null ? value : Object.fromEntries(Object.entries(record).filter(([key]) => !BROWSER_PAGE_CONTENT.has(key))
    .map(([key, entry]) => [key, withoutPageContent(entry)]));
};
const browserReceipt = (receipt: InvocationReceipt): InvocationReceipt =>
  receipt.result === undefined || !isBrowserResult(receipt.tool_name, receipt.result) ? receipt
    : { ...receipt, result: withoutPageContent(receipt.result) };
export const withoutBrowserPages = (evidence: RequestExecutionEvidence): RequestExecutionEvidence => ({
  ...evidence,
  successful_calls_for_current_request: evidence.successful_calls_for_current_request.map(browserReceipt),
  successful_actions_for_earlier_requests: evidence.successful_actions_for_earlier_requests.map(browserReceipt),
});

/** Drop whole records with explicit partial coverage; never truncate a clause into another claim. */
export const boundRequestEvidence = (evidence: RequestExecutionEvidence, incomplete: boolean,
  maxBytes: number = REQUEST_EVIDENCE_LIMITS.packetBytes): RequestExecutionEvidence | undefined => {
  const output = { current_request: evidence.current_request, successful_calls_for_current_request: [] as InvocationReceipt[],
    earlier_requests: [] as RequestRecord[], successful_actions_for_earlier_requests: [] as InvocationReceipt[],
    recorded_assistant_replies: [] as RecordedReply[],
    coverage: { scope: 'selected_same_session_requests' as const, incomplete } };
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size(output) > maxBytes) return undefined;
  const add = <T>(list: T[], value: T): boolean => {
    list.push(value);
    // Reserve the shorter boolean spelling too, so marking omitted records never exceeds the cap.
    if (size(output) + 1 <= maxBytes) return true;
    list.pop(); output.coverage.incomplete = true; return false;
  };
  for (const receipt of evidence.successful_calls_for_current_request) add(output.successful_calls_for_current_request, receipt);
  for (const request of evidence.earlier_requests) add(output.earlier_requests, request);
  const owners = new Set([output.current_request.request_id, ...output.earlier_requests.map(r => r.request_id)]);
  for (const receipt of evidence.successful_actions_for_earlier_requests) {
    if (owners.has(receipt.completed_for_request_id)) add(output.successful_actions_for_earlier_requests, receipt);
    else output.coverage.incomplete = true;
  }
  for (const reply of evidence.recorded_assistant_replies) {
    if (owners.has(reply.request_id)) add(output.recorded_assistant_replies, reply);
    else output.coverage.incomplete = true;
  }
  let result: RequestExecutionEvidence = output;
  if (evidence.prepared_assistant_reply) {
    const prepared = { ...output, prepared_assistant_reply: evidence.prepared_assistant_reply };
    if (size(prepared) <= maxBytes) result = prepared;
    else output.coverage.incomplete = true;
  }
  if (evidence.completed_held_actions) {
    const state = { ...evidence.completed_held_actions, actions: [] as Array<CompletedHeldActionState['actions'][number]> };
    const extended = { ...result, completed_held_actions: state };
    if (size(extended) + 1 <= maxBytes) {
      for (const action of evidence.completed_held_actions.actions) {
        state.actions.push(action);
        if (size(extended) + 2 > maxBytes) { state.actions.pop(); state.incomplete = true; }
      }
      result = extended;
    } else output.coverage.incomplete = true;
  }
  if (evidence.unconfirmed_held_actions) {
    const state = { ...evidence.unconfirmed_held_actions, actions: [] as Array<UnconfirmedHeldActionState['actions'][number]> };
    const extended = { ...result, unconfirmed_held_actions: state };
    if (size(extended) + 1 <= maxBytes) {
      for (const action of evidence.unconfirmed_held_actions.actions) {
        state.actions.push(action);
        if (size(extended) + 2 > maxBytes) { state.actions.pop(); state.incomplete = true; }
      }
      result = extended;
    } else output.coverage.incomplete = true;
  }
  // Resolved observations use spare capacity; existing requests, receipts and replies win.
  if (evidence.resolved_action_outcomes?.length) {
    const records: ResolvedActionOutcome[] = [];
    const extended = {...result,resolved_action_outcomes:records};
    for (const record of evidence.resolved_action_outcomes) {
      records.push(record);
      if (size(extended)+1>maxBytes) {records.pop();output.coverage.incomplete=true;}
    }
    if(records.length)result=extended;
  }
  if (evidence.pending_approvals) {
    const state = {...evidence.pending_approvals, plans:[] as Array<PendingApprovalState['plans'][number]>};
    const extended = {...result,pending_approvals:state};
    if (size(extended)+1 <= maxBytes) {
      for (const plan of evidence.pending_approvals.plans) {
        state.plans.push(plan);
        if (size(extended)+2 > maxBytes) {state.plans.pop();state.incomplete=true;}
      }
      result=extended;
    } else output.coverage.incomplete=true;
  }
  if (evidence.approved_actions) {
    const state = { ...evidence.approved_actions, actions: [] as Array<ApprovedActionState['actions'][number]> };
    const extended = { ...result, approved_actions: state };
    if (size(extended) + 1 <= maxBytes) {
      for (const action of evidence.approved_actions.actions) {
        state.actions.push(action);
        if (size(extended) + 2 > maxBytes) { state.actions.pop(); state.incomplete = true; }
      }
      result = extended;
    } else output.coverage.incomplete = true;
  }
  if (evidence.cancelled_approvals) {
    const state = { ...evidence.cancelled_approvals, plans: [] as Array<CancelledApprovalState['plans'][number]> };
    const extended = { ...result, cancelled_approvals: state };
    if (size(extended) + 1 <= maxBytes) {
      for (const plan of evidence.cancelled_approvals.plans) {
        state.plans.push(plan);
        if (size(extended) + 2 > maxBytes) { state.plans.pop(); state.incomplete = true; }
      }
      result = extended;
    } else output.coverage.incomplete = true;
  }
  return result;
};

/** Only freshly resolved, host-verified completion supplies identifier values.
 * The resolver already checks invocation identity, receipt binding and epoch;
 * these shape checks are defensive, not verification of arbitrary model input.
 * Cached brief sources remain excluded even when they once said completed. */
const completedIdentifierValues = (record: unknown): readonly string[] => {
  const r = object(record), receipt = object(r?.receipt);
  if (!r || r.outcome !== 'completed' || r.resolution !== 'observed'
    || (r.attempt_state !== 'failed' && r.attempt_state !== 'interrupted')
    || !receipt || typeof receipt.receipt_id !== 'string' || !receipt.receipt_id
    || typeof receipt.epoch !== 'string' || !receipt.epoch
    || typeof r.attempt_started_at !== 'number' || !Number.isFinite(r.attempt_started_at)
    || typeof r.observed_at !== 'number' || !Number.isFinite(r.observed_at)
    || typeof receipt.settled_at !== 'number' || !Number.isFinite(receipt.settled_at)
    || receipt.settled_at < r.attempt_started_at || receipt.settled_at > r.observed_at) return [];
  return identifierArgumentValues(r.args);
};

// Recall can contain a stored recall result, whose matches contain another
// stored result. Apply the same provenance rule at every such boundary. The
// limits apply to the internal identifier corpus, never the visible evidence.
const RECALL_GROUNDING_LIMITS = { depth: 6, rowBytes: 65_536, decodedBytes: 262_144, matches: 256 } as const;
interface RecallGroundingBudget { bytes: number; matches: number }

const recallResultForGrounding = (value: unknown, depth: number, budget: RecallGroundingBudget): unknown => {
  const result = object(value);
  if (!result || result.ok !== true || result.run_failed === true || isNonTerminalToolResult(result)
    || !Array.isArray(result.matches)
    || depth > RECALL_GROUNDING_LIMITS.depth) return undefined;
  const matches: Record<string, unknown>[] = [];
  for (const raw of result.matches) {
    if (budget.matches-- <= 0) break;
    const match = object(raw);
    if (!match || (match.source !== 'interaction' && match.source !== 'memory')) continue;
    if (match.source === 'memory') { matches.push(match); continue; }
    if (!['user', 'assistant', 'tool'].includes(String(match.kind)) || typeof match.content !== 'string') continue;
    if (match.kind === 'user') { matches.push(match); continue; }
    // Keep the row's navigation metadata, but a failed invocation, cached brief,
    // incomplete payload or over-budget branch cannot supply identifier text.
    const projected = { ...match, content: '' };
    matches.push(projected);
    // Recalling the assistant's own assertion does not independently source it.
    // Keep navigation metadata so the original record can still be retrieved.
    if (match.kind === 'assistant') continue;
    if (match.completeness !== undefined && match.completeness !== 'complete') continue;
    const name = toolNameFromRow(match.content);
    if (!name || name === 'context.brief' || !match.content.startsWith(`${name}: `)) continue;
    const bytes = Buffer.byteLength(match.content, 'utf8');
    if (bytes > RECALL_GROUNDING_LIMITS.rowBytes || bytes > budget.bytes) continue;
    budget.bytes -= bytes;
    try {
      const envelope = object(JSON.parse(match.content.slice(name.length + 2)));
      if (envelope?.ok !== true || envelope.run_failed === true || !Object.hasOwn(envelope, 'result')
        || isNonTerminalToolResult(envelope) || isNonTerminalToolResult(envelope.result)) continue;
      // Only recall.search has this nested provenance envelope. A business
      // result with a field named "matches" is still an ordinary tool result.
      const payload = name === 'recall.search'
        ? recallResultForGrounding(envelope.result, depth + 1, budget)
        : envelope.result;
      if (payload !== undefined) projected.content = JSON.stringify(payload);
    } catch { /* Unparseable results establish no identifier authority. */ }
  }
  return { ...result, matches };
};

/** Model visibility is not identifier authority. Preserve only the identifiers
 * in current completed native proof; exclude unsuccessful echoes and all cached
 * outcome sources and derived brief clauses. Assistant prose is not independent
 * identifier evidence, including when recalled or cited by a brief. The
 * model-visible packet is unchanged. */
export const withoutUnsuccessfulAttemptEchoes = (body: string): string => {
  let packet: Record<string, any>;
  try { packet = JSON.parse(body); } catch { return body; }
  if (!packet || typeof packet !== 'object') return body;
  let changed = false;
  if (Array.isArray(packet.chat_tail)) {
    const tail = packet.chat_tail.filter((message: unknown) => object(message)?.role !== 'assistant');
    if (tail.length !== packet.chat_tail.length) { packet.chat_tail = tail; changed = true; }
  }
  const context = packet.request_execution_context;
  if (Array.isArray(context?.recorded_assistant_replies)) {
    context.recorded_assistant_replies = context.recorded_assistant_replies.map((reply: unknown) => {
      const record = object(reply);
      return record ? { ...record, text: '' } : reply;
    });
    changed = true;
  }
  if (object(context?.prepared_assistant_reply)) {
    context.prepared_assistant_reply = { ...context.prepared_assistant_reply, text: '' };
    changed = true;
  }
  // A proposal can contain unexecuted model arguments. Neither fresh approval
  // metadata nor cached clauses derived from it supplies identifier authority.
  // Nor does an attempt with no confirmed result: its arguments never completed.
  for (const field of ['pending_approvals', 'approved_actions', 'cancelled_approvals', 'unconfirmed_held_actions']) {
    if (packet.request_execution_context?.[field]) {
      delete packet.request_execution_context[field]; changed = true;
    }
  }
  if (packet.request_execution_context?.resolved_action_outcomes) {
    const outcomes = packet.request_execution_context.resolved_action_outcomes;
    const values = Array.isArray(outcomes) ? outcomes.flatMap(completedIdentifierValues) : [];
    // This internal corpus is never sent to the model. Do not retain owner
    // prose, receipt ids, result payloads, or freeform argument fields here.
    if (values.length) packet.request_execution_context.resolved_action_outcomes = [{identifier_values: values}];
    else delete packet.request_execution_context.resolved_action_outcomes;
    changed = true;
  }
  if (context?.completed_held_actions) {
    const state = object(context.completed_held_actions);
    // Only the fresh native projection supplies these values. Cached clauses,
    // receipt addresses and arbitrary argument prose remain ineligible.
    const values = state?.observation === 'available' && Array.isArray(state.actions)
      ? state.actions.flatMap((value: unknown) => {
        const action = object(value), receipt = object(action?.receipt);
        return action?.execution_status === 'completed' && action.approval_status === 'approved'
          && receipt && (receipt.run_id === action.hold_run_id && typeof receipt.run_id === 'string'
            || isLocalMutationReceiptSummary(receipt.local_receipt)) ? identifierArgumentValues(action.args) : [];
      }) : [];
    if (values.length) context.completed_held_actions = { identifier_values: values };
    else delete context.completed_held_actions;
    changed = true;
  }
  // Recall can return the invocation and its failed reply as historical text.
  // Retrieving the model's old arguments does not independently ground them.
  // Keep navigation metadata, original user records, memory, and successful
  // result payloads; exclude tool-call prose, failures and cached briefs. An
  // unparseable or truncated result needs an original source or a fresh lookup.
  const recallBudget: RecallGroundingBudget = {
    bytes: RECALL_GROUNDING_LIMITS.decodedBytes, matches: RECALL_GROUNDING_LIMITS.matches,
  };
  for (const field of ['prior_tool_calls', 'recall_context']) {
    for (const call of Array.isArray(packet[field]) ? packet[field] : []) {
      if (call?.tool_name !== 'recall.search' || !Object.hasOwn(call, 'result')) continue;
      call.result = call.status !== undefined && call.status !== 'ok'
        ? undefined : recallResultForGrounding(call.result, 0, recallBudget);
      changed = true;
    }
  }
  return changed ? JSON.stringify(packet) : body;
};

/** Optional host read seam. Registered resolvers supply operation truth;
 * neither error prose nor a missing receipt establishes nonexecution. */
export interface ActionOutcomeQuery {
  readonly session_id: string;
  readonly invocation_id: string;
  readonly request_id: string;
  readonly tool_name: string;
  readonly args: unknown;
  readonly started_at: number;
}
export interface ActionOutcomeObservation extends ActionOutcomeQuery {
  readonly outcome: 'completed' | 'not_applied' | 'unknown';
  readonly observed_at: number;
  readonly receipt?: { readonly receipt_id: string; readonly epoch: string;
    readonly settled_at: number; readonly result?: unknown };
}
export type ResolveActionOutcomes = (queries: readonly ActionOutcomeQuery[],
  context: { readonly signal: AbortSignal }) => Promise<readonly ActionOutcomeObservation[]>;
export interface ResolvedActionOutcome {
  readonly invocation_id: string;
  readonly request_id: string;
  readonly owner_request: RequestRecord;
  readonly tool_name: string;
  readonly args: unknown;
  readonly attempt_started_at: number;
  readonly attempt_state: 'failed' | 'interrupted';
  readonly outcome: 'completed' | 'not_applied' | 'unknown';
  readonly resolution: 'observed' | 'unavailable';
  readonly observed_at?: number;
  readonly receipt?: ActionOutcomeObservation['receipt'];
}
export const ACTION_OUTCOME_LIMITS = { queries: 16, queryBytes: 65_536,
  observationBytes: 262_144, recordBytes: 65_536, timeoutMs: 1_000 } as const;

export const resolveRequestActionOutcomes = async (evidence: RequestExecutionEvidence,
  sessionId: string, resolver?: ResolveActionOutcomes,
  options: { now?: () => number; timeoutMs?: number } = {}): Promise<RequestExecutionEvidence> => {
  const {unsuccessful_action_attempts:allAttempts, ...base} = evidence;
  if (!allAttempts?.length) return base;
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value),'utf8');
  const eligible = allAttempts.filter(a => a.request_id === a.owner_request.request_id
    && a.owner_request.received_at <= evidence.current_request.received_at);
  const selected: UnsuccessfulActionAttempt[] = [];
  const queries: ActionOutcomeQuery[] = [];
  let incomplete = eligible.length !== allAttempts.length;
  for (const a of [...eligible].reverse()) {
    const query = {session_id:sessionId,invocation_id:a.invocation_id,request_id:a.request_id,
      tool_name:a.tool_name,args:structuredClone(a.args),started_at:a.started_at};
    if (queries.length >= ACTION_OUTCOME_LIMITS.queries
      || bytes([...queries,query]) > ACTION_OUTCOME_LIMITS.queryBytes) {incomplete=true;continue;}
    queries.push(query);selected.push(a);
  }
  if (!queries.length) return {...base,coverage:{scope:'selected_same_session_requests',incomplete:true}};
  const controller = new AbortController();let timer: ReturnType<typeof setTimeout> | undefined;
  let observations: unknown = null;
  try {
    // A deployment without an operation receipt resolver still carries the
    // attempt as unknown. Missing proof never means the action did not happen.
    if (resolver) {
    observations = await Promise.race([
      Promise.resolve().then(() => resolver(structuredClone(queries),{signal:controller.signal})),
      new Promise<null>(resolve => { timer=setTimeout(() => {controller.abort();resolve(null);},
        Math.max(1,Math.min(ACTION_OUTCOME_LIMITS.timeoutMs,options.timeoutMs??ACTION_OUTCOME_LIMITS.timeoutMs))); }),
    ]);
    }
    if (!Array.isArray(observations) || bytes(observations)>ACTION_OUTCOME_LIMITS.observationBytes) observations=null;
  } catch {observations=null;} finally {if(timer)clearTimeout(timer);}
  const canonical=(value:unknown):string => canonicalJSONStringifyStrict(value);
  const now=(options.now??Date.now)();
  const resolved: ResolvedActionOutcome[] = [];
  for (let i=0;i<queries.length;i++) {
    const query=queries[i]!,a=selected[i]!;
    const record: ResolvedActionOutcome={invocation_id:a.invocation_id,request_id:a.request_id,
      owner_request:structuredClone(a.owner_request),tool_name:a.tool_name,args:structuredClone(a.args),
      attempt_started_at:a.started_at,attempt_state:a.state,outcome:'unknown',resolution:'unavailable'};
    const candidates=Array.isArray(observations)?observations.filter(x=>object(x)?.invocation_id===query.invocation_id):[];
    const x=candidates.length===1?object(candidates[0]):null;
    let valid=false;
    try {
      const receipt=object(x?.receipt);
      valid=!!x && bytes(x)<=ACTION_OUTCOME_LIMITS.recordBytes
        && Object.keys(x).every(k=>['session_id','invocation_id','request_id','tool_name','args','started_at','outcome','observed_at','receipt'].includes(k))
        && canonical({session_id:x.session_id,invocation_id:x.invocation_id,request_id:x.request_id,
          tool_name:x.tool_name,args:x.args,started_at:x.started_at})===canonical(query)
        && typeof x.observed_at==='number' && Number.isFinite(x.observed_at)
        && x.observed_at>=query.started_at && x.observed_at<=now
        && (x.outcome==='unknown' ? x.receipt===undefined
          : (x.outcome==='completed'||x.outcome==='not_applied') && !!receipt
            && Object.keys(receipt).every(k=>['receipt_id','epoch','settled_at','result'].includes(k))
            && typeof receipt.receipt_id==='string' && receipt.receipt_id.length>0 && receipt.receipt_id.length<=512
            && typeof receipt.epoch==='string' && receipt.epoch.length>0 && receipt.epoch.length<=512
            && typeof receipt.settled_at==='number' && receipt.settled_at>=query.started_at
            && receipt.settled_at<=x.observed_at
            && (x.outcome!=='not_applied'||receipt.result===undefined));
    } catch {valid=false;}
    if (valid) {
      const observed=x as unknown as ActionOutcomeObservation;
      resolved.push({...record,outcome:observed.outcome,resolution:'observed',observed_at:observed.observed_at,
        ...(observed.receipt?{receipt:structuredClone(observed.receipt)}:{})});
    } else {incomplete=true;resolved.push(record);}
  }
  return {...base,resolved_action_outcomes:resolved,coverage:{scope:'selected_same_session_requests',
    incomplete:incomplete||base.coverage?.incomplete===true}};
};
