/** D-137 P1.4 — Webclient chat-state reducer (pure).
 *
 *  The webclient is display + HID per D-148 § A.4. The chat surface
 *  consumes the per-pair broadcast bus (D-121 / § Wire A) and renders
 *  state in real time:
 *
 *    - `chat.token_streamed`     → append delta to in-flight assistant
 *    - `chat.tool_call_started`  → push a tool_call row (status: started)
 *    - `chat.tool_call_completed`→ patch the matching row's status
 *      and, when plan-linked, update the original approval receipt
 *    - `chat.plan_proposed`      → push a plan-approval card (P3 § A.11)
 *    - `chat.plan_resolved`      → flip the matching card to its
 *      approved / cancelled terminal state
 *    - `chat.transparency`       → push a transparency-stream entry
 *    - `chat.message_complete`   → replace the in-flight turn with the
 *      authoritative ChatMessage row from the server
 *    - `chat.data_diagnosis_resolved` → patch an owner-confirmed safe-check
 *      closure onto the exact durable assistant message
 *    - `chat.session_changed`    → patch picker / model_pref / title /
 *      archived on the in-memory session record
 *
 *  Pure reducer: the same `(state, event)` → same next state. No
 *  network, no clock, no side effects. The renderer wires this up to
 *  the WS broadcast subscriber + drives re-renders on every update.
 *
 *  Storage discipline per D-148 § A.4.1 — none of this state persists
 *  to IDB. Chat history and reviewed action records live on the server
 *  (encrypted per-pair via the `chat` sub-DEK). The webclient pulls both
 *  via `chat.session.get` at session open / reconnect, then lets broadcast
 *  events keep the view in sync until the user closes the tab.
 */

import {
  classForTransparencyEventKind,
  isChatDataDiagnosisResolutionStatus,
  isChatModelHint,
  isChatModelSourceId,
  isChatToolCallRecord,
  isTransparencyEventKind,
  renderTransparencyTemplate,
  type ChatMessage,
  type ChatModelRoutingLayer,
  type ChatPickerTarget,
  type ChatPlanExecutionReceipt,
  type ChatPlanProposal,
  type ChatPlanRecord,
  type ChatPlanStatus,
  type ChatHistoryCursor,
  type ChatSession,
  type ChatSessionChangedField,
  type ChatToolCall,
  type ChatToolCallRecord,
  type ServerEvent,
  type ToolTier,
  type TransparencyEvent,
  type TransparencyEventKind,
} from '@recued/contracts';

/** In-flight tool-call shape — kept distinct from the authoritative
 *  `ChatToolCall` (which carries server-supplied `started_at` /
 *  `completed_at`). The reducer tracks the per-event state without
 *  inventing timestamps locally (Codex P1.4 review P2 fold — pure
 *  reducer takes no clock). The authoritative ChatMessage that lands
 *  on `chat.message_complete` carries the real timestamps; this shape
 *  is ephemeral during streaming only. */
export interface InFlightToolCall {
  tool_name: string;
  tier: ChatToolCall['tier'];
  args: unknown;
  status: 'started' | 'ok' | 'error';
  result_ref?: string;
  reason?: ChatToolCall['reason'];
  /** D-182 — underlying error line for the activity row (status === 'error'). */
  detail?: ChatToolCall['detail'];
}

/** One in-flight turn — built up incrementally from broadcast
 *  events until `chat.message_complete`. The scaffold is created by
 *  whichever signal lands FIRST: the turn's first broadcast event
 *  (adoption — the production case, since the `chat.send` ack resolves
 *  only after the whole turn broadcast) or the ack's
 *  `beginInFlightTurn`. Once the matching `message_complete` fires the
 *  authoritative ChatMessage replaces the scaffold. */
export interface InFlightTurn {
  /** Server-assigned id from the `chat.send` ack. */
  turn_id: string;
  /** Accumulated assistant text from `chat.token_streamed` deltas. */
  assistant_content: string;
  /** Per-tool-call entries — keyed by tool_name in arrival order. */
  tool_calls: InFlightToolCall[];
  /** Most-recent transparency events for the per-turn drawer. */
  transparency: ReadonlyArray<{
    kind: string;
    payload: unknown;
  }>;
  /** Additional concurrent turns in the same session. Kept on the primary
   *  scaffold as an optional compatibility extension so existing single-turn
   *  state snapshots remain byte-for-byte unchanged. */
  siblings?: ReadonlyArray<InFlightTurn>;
}

/** PB7 failure paint — one user-visible notice per FAILED turn,
 *  projected from § B.15 failure-class transparency events (which must
 *  bypass visibility hiding). Lives on `ChatThreadState` (not the
 *  in-flight scaffold) because `chat.message_complete` discards the
 *  scaffold — the notice must survive to render against the completed
 *  message. Latest failure event per turn wins: the executor emits the
 *  dedicated `engine.decoder_unavailable` AFTER the accounting
 *  `engine.budget_exceeded`, so the painted copy tells the failure
 *  story rather than "request budget reached". Ephemeral by design —
 *  hydration resets it (history reloads paint no stale failures; the
 *  audit log holds the durable record). */
export interface TurnFailureNotice {
  turn_id: string;
  /** Stamped when `chat.message_complete` lands for the turn — links
   *  the notice to the persisted assistant message row for rendering. */
  message_id?: string;
  kind: TransparencyEventKind;
  /** Recued-voiced line from the contracts template registry. */
  text: string;
  /** True when the failure points at model-source configuration — the
   *  renderer appends the Settings → AI / Models link. */
  settings_link: boolean;
}

/** D-137 P3 § A.11 — one interactive plan-approval card per proposed
 *  write plan. Projected from `chat.plan_proposed` and resolved by
 *  `chat.plan_resolved` (broadcast) or the approve / cancel rpc
 *  response (optimistic local apply — same shape, same helper). Lives
 *  on `ChatThreadState` (not the in-flight scaffold) for the same
 *  reason as `TurnFailureNotice`: the proposing turn COMPLETES while
 *  the plan stays pending — the gated tool errors `awaiting_approval`,
 *  the assistant's "needs your approval" text lands, and the card must
 *  keep rendering (and stay clickable) against the persisted message.
 *  Hydration reconstructs it from the server's durable action record; live
 *  events then advance the same card without relying on tab memory. */
export interface PlanApprovalCard {
  plan_id: string;
  turn_id: string;
  /** The uncertain consumed action this fresh proposal follows. Correlation
   * only: this card always needs its own approval. */
  retry_of_plan_id?: string;
  /** Stamped when `chat.message_complete` lands for the turn — links
   *  the card to the persisted assistant message row for rendering. */
  message_id?: string;
  tool: string;
  tier: ToolTier;
  /** Resolved tool args at proposal time — rendered read-only for
   *  review. Arg EDITING is deliberately absent: the rpc contract
   *  carries `edited_args` but the server ignores it today, and the
   *  `args_hash` gate binds an approval to exactly the reviewed
   *  payload (§ A.11 edit flow is a later slice). */
  args: unknown;
  /** Server-computed exact-payload hash, used only to compare a fresh retry
   * proposal with its origin without making claims from display text. */
  args_hash?: string;
  status: ChatPlanStatus;
  /** Authoritative lifecycle of the ONE dispatch that consumed this
   *  approval. It is driven only by plan-linked tool events from the
   *  server; accepting a continuation message never writes this field. */
  execution?: PlanExecutionReceipt;
  /** True when reconstructed from `chat.session.get`, not a live event. Used
   * to avoid announcing historical receipts as new activity. */
  recovered?: boolean;
  /** False only when encrypted reviewed args could not be recovered. Exact-
   * payload actions are disabled in that state. */
  payload_available?: boolean;
}

/** Execution receipt for a consumed one-time approval. `held` is distinct
 *  from `completed`: the tool dispatch returned successfully but paused at
 *  a deeper confirmation gate, so no final effect may be claimed. */
export type PlanExecutionReceipt = ChatPlanExecutionReceipt;

export interface ChatThreadState {
  quoted_replies_available?: boolean;
  session: ChatSession | null;
  /** Authoritative message log — replaces on `chat.message_complete`,
   *  loaded initially via `chat.session.get` rpc. */
  messages: ChatMessage[];
  /** Optional in-flight turn — adopted from the turn's FIRST broadcast
   *  event (or created at the `chat.send` ack, whichever lands first)
   *  and cleared by the matching `chat.message_complete`. */
  inflight: InFlightTurn | null;
  /** PB7 — per-turn failure notices (latest failure event per turn).
   *  Session-tab-lifetime only; see `TurnFailureNotice`. */
  turn_failures: ReadonlyArray<TurnFailureNotice>;
  /** § A.11 — plan-approval cards in proposal order. Keyed by
   *  `plan_id`; a turn can hold several (two write tools gated in one
   *  turn). Recovered from durable server records on hydration. */
  plan_cards: ReadonlyArray<PlanApprovalCard>;
  /** Older messages exist behind the loaded window. False on a server that
   *  does not window, because it already sent everything. */
  has_more_before: boolean;
  /** Where the next older page resumes; null when there is none to ask for. */
  oldest_cursor: ChatHistoryCursor | null;
  /** A message link can land in the middle of a conversation. */
  has_more_after: boolean;
  newest_cursor: ChatHistoryCursor | null;
  /** Start of a separately recovered recent window. Paging can stop once
   * the anchored window reaches it; broadcasts alone cannot prove that gap. */
  latest_window_start: ChatHistoryCursor | null;
  /** Route-side scaffold handling — turn ids whose
   *  `chat.message_complete` already landed, or whose scaffold was
   *  discarded because the queue stopped the turn without an answer
   *  (`discardInFlightTurn`). In production the
   *  `chat.send` ack resolves only AFTER the whole turn broadcast, so
   *  without this memory the post-ack `beginInFlightTurn` would
   *  scaffold an already-finished turn and render a dangling empty
   *  assistant bubble. Capped FIFO (`COMPLETED_TURN_MEMORY`);
   *  session-tab-lifetime only (hydration resets). */
  completed_turn_ids: ReadonlyArray<string>;
  /** Durable call records by `run_id`.
   *
   *  ⛔ THE LIVE THREAD HOLDS NO TOOL ROWS. A turn arrives as its user and
   *  assistant messages; its calls show only as the assistant's activity rows.
   *  So the `tool_call` broadcasts — "it is waiting", then "it finished" when an
   *  approval lands minutes later — found no message to update and were dropped,
   *  and the thread said "queued" for good. Keyed by `run_id`, which the
   *  assistant's own `tool_calls` carry, so the activity row can read them.
   *  Optional so a state built before this field reads as "nothing known". */
  tool_call_records?: Readonly<Record<string, ChatToolCallRecord>>;
}

const TERMINAL_TOOL_CALL_STATES: ReadonlyArray<ChatToolCallRecord['state']> =
  ['succeeded', 'failed', 'interrupted'];

/** Keep the newest record per run, never letting a late "running" or "held"
 *  undo a settlement — the same two guards as a tool row's own update. Returns
 *  the SAME object when nothing changed, so a caller can skip a state copy. */
export const rememberToolCallRecords = (
  records: Readonly<Record<string, ChatToolCallRecord>> | undefined,
  calls: Iterable<ChatToolCallRecord>,
): Readonly<Record<string, ChatToolCallRecord>> | undefined => {
  let next = records;
  for (const call of calls) {
    if (call.run_id === undefined) continue;
    const prior = next?.[call.run_id];
    if (prior !== undefined && (call.updated_at < prior.updated_at
      || (TERMINAL_TOOL_CALL_STATES.includes(prior.state)
        && !TERMINAL_TOOL_CALL_STATES.includes(call.state)))) continue;
    next = { ...(next ?? {}), [call.run_id]: call };
  }
  return next;
};

const toolCallRecordsOf = (messages: readonly ChatMessage[]): ChatToolCallRecord[] =>
  messages.flatMap((message) => message.tool_call !== undefined ? [message.tool_call] : []);

/** How many completed turn ids the reducer remembers. Sends are
 *  serialized per tab (the route's `sending` flag), so the guard only
 *  genuinely needs the most recent few — the cap exists to bound a
 *  long-lived tab, not to be reached. */
const COMPLETED_TURN_MEMORY = 50;

export const initialChatThreadState = (): ChatThreadState => ({
  session: null,
  messages: [],
  inflight: null,
  turn_failures: [],
  plan_cards: [],
  completed_turn_ids: [],
  has_more_before: false,
  oldest_cursor: null,
  has_more_after: false,
  newest_cursor: null,
  latest_window_start: null,
});

export type ChatThreadSnapshot =
  ChatSession & {
    quoted_replies_available?: boolean;
    messages: ChatMessage[];
    plans?: ReadonlyArray<ChatPlanRecord>;
    /** ⛔ ABSENT MEANS COMPLETE, NOT UNKNOWN — the opposite of
     *  `busy_session_ids`, and the difference is load-bearing. A server older
     *  than the window omits this because it knows nothing about it, AND
     *  because it handed over the entire conversation; a current server omits
     *  it when the caller asked for everything. Both mean the same thing, so
     *  reading absence as "complete" is correct here rather than a guess. */
    has_more?: boolean;
    /** Where an older page resumes. Only ever present beside `has_more`. */
    oldest_cursor?: ChatHistoryCursor;
    has_more_after?: boolean;
    newest_cursor?: ChatHistoryCursor;
  };

const compareHistoryCursors = (a: ChatHistoryCursor, b: ChatHistoryCursor): number =>
  a.ts - b.ts || (a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0);
const messageCursor = (message: ChatMessage): ChatHistoryCursor => ({
  ts: message.ts, message_id: message.id,
});

/** Apply fresh server history. Recovery from an old message link also reads
 * the recent tail, so durable completions survive without losing the target.
 * Keep the intervening gap explicit until pagination joins the two windows. */
export const hydrateThreadFromSnapshot = (
  state: ChatThreadState,
  snapshot: ChatThreadSnapshot,
  latestSnapshot?: ChatThreadSnapshot,
): ChatThreadState => {
  // A complete newer read is authoritative even for rows removed between reads.
  if (latestSnapshot !== undefined && latestSnapshot.has_more !== true) {
    return hydrateThreadFromSnapshot(state, latestSnapshot);
  }
  const { messages: latestMessages, plans = [], quoted_replies_available, ...session } = latestSnapshot ?? snapshot;
  const messages = latestSnapshot === undefined ? latestMessages : [
    ...new Map([...snapshot.messages, ...latestMessages].map(message => [message.id, message])).values(),
  ].sort((a, b) => compareHistoryCursors(messageCursor(a), messageCursor(b)));
  const latestStart = latestSnapshot?.messages[0];
  const latestWindowStart = latestStart === undefined ? null : messageCursor(latestStart);
  const gap = snapshot.has_more_after === true && (
    latestWindowStart === null || snapshot.newest_cursor === undefined
    || compareHistoryCursors(snapshot.newest_cursor, latestWindowStart) < 0
  );
  const before = latestWindowStart !== null && snapshot.messages[0] !== undefined
    && compareHistoryCursors(latestWindowStart, messageCursor(snapshot.messages[0])) <= 0
    ? latestSnapshot! : snapshot;
  // 🔑 DURABLE COMPLETION, recovered from the history itself. This used to be
  // `[]` and could only ever be refilled by live `chat.message_complete`
  // events — so a turn that finished while the socket was down was, to this
  // tab, a turn that never finished: `settlePendingSend` had nothing to match
  // and the composer stayed on "Sending…" for good.
  //
  // ⛔ ASSISTANT ROWS ONLY. The user row is written at turn START, before the
  // model runs, and bears the same `turn_id` — counting it would call every
  // in-flight turn complete the moment it began.
  const completedTurnIds: string[] = [];
  const seenTurnIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const turnId = message.turn_id;
    if (typeof turnId !== 'string' || turnId.length === 0) continue;
    if (seenTurnIds.has(turnId)) continue;
    seenTurnIds.add(turnId);
    completedTurnIds.push(turnId);
  }
  return {
    session,
    quoted_replies_available: quoted_replies_available === true,
    messages: messages.slice(),
    inflight: null,
    turn_failures: [],
    plan_cards: plans.map((record) => ({
      plan_id: record.plan.plan_id,
      turn_id: record.plan.turn_id,
      ...(record.plan.retry_of_plan_id !== undefined
        ? { retry_of_plan_id: record.plan.retry_of_plan_id }
        : {}),
      ...(record.message_id !== undefined
        ? { message_id: record.message_id }
        : {}),
      tool: record.plan.tool,
      tier: record.plan.tier,
      args: record.plan.args,
      args_hash: record.plan.args_hash,
      status: record.plan.status,
      ...(record.execution !== undefined
        ? { execution: record.execution }
        : {}),
      recovered: true,
      payload_available: record.payload_available,
    })),
    has_more_before: before.has_more === true,
    oldest_cursor: before.oldest_cursor ?? null,
    has_more_after: gap,
    newest_cursor: (gap ? snapshot : latestSnapshot ?? snapshot).newest_cursor ?? null,
    latest_window_start: gap ? latestWindowStart : null,
    // Same cap and same end as the live path: newest kept, oldest dropped.
    completed_turn_ids: completedTurnIds.slice(-COMPLETED_TURN_MEMORY),
    ...withToolCallRecords(
      state.session?.id === session.id ? state.tool_call_records : undefined,
      messages,
    ),
  };
};

const withToolCallRecords = (
  records: Readonly<Record<string, ChatToolCallRecord>> | undefined,
  messages: readonly ChatMessage[],
): { tool_call_records?: Readonly<Record<string, ChatToolCallRecord>> } => {
  const next = rememberToolCallRecords(records, toolCallRecordsOf(messages));
  return next === undefined ? {} : { tool_call_records: next };
};

/** Put an older page in FRONT of what is already loaded.
 *
 *  ⛔ Deduplicates on id rather than trusting the cursor. The page and the
 *  thread are read at different moments, and a turn completing in between adds
 *  rows — a paged read is not a snapshot of one instant. Dropping anything
 *  already on screen is cheaper than reasoning about when that can happen.
 *
 *  ⚠ `completed_turn_ids` is deliberately NOT extended from an older page. It
 *  exists to stop a just-acked turn scaffolding a bubble for work already
 *  finished, which is a question about the RECENT tail; feeding it ancient
 *  turn ids would push the recent ones out of a 50-entry FIFO. */
export const prependOlderMessages = (
  state: ChatThreadState,
  older: readonly ChatMessage[],
  next: { has_more: boolean; oldest_cursor: ChatHistoryCursor | null },
): ChatThreadState => {
  const known = new Set(state.messages.map((message) => message.id));
  const fresh = older.filter((message) => !known.has(message.id));
  return {
    ...state,
    messages: [...fresh, ...state.messages],
    has_more_before: next.has_more,
    oldest_cursor: next.oldest_cursor,
    ...withToolCallRecords(state.tool_call_records, fresh),
  };
};

/** Fill the gap after an anchored window while preserving live messages that
 * arrived at the tail during the read. The cursor tracks the contiguous page,
 * not the latest broadcast, so intervening history cannot be skipped. */
export const appendNewerMessages = (
  state: ChatThreadState,
  newer: readonly ChatMessage[],
  next: { has_more_after: boolean; newest_cursor: ChatHistoryCursor | null },
): ChatThreadState => {
  const known = new Set(state.messages.map((message) => message.id));
  const fresh = newer.filter((message) => !known.has(message.id));
  const reachedLatestWindow = state.latest_window_start !== null
    && next.newest_cursor !== null
    && compareHistoryCursors(next.newest_cursor, state.latest_window_start) >= 0;
  const hasMoreAfter = next.has_more_after && !reachedLatestWindow;
  return {
    ...state,
    ...withToolCallRecords(state.tool_call_records, fresh),
    messages: [...state.messages, ...fresh].sort((a, b) =>
      a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    has_more_after: hasMoreAfter,
    newest_cursor: next.newest_cursor,
    latest_window_start: hasMoreAfter ? state.latest_window_start : null,
  };
};

/** Create the in-flight turn at the `chat.send` ack. Route-side
 *  scaffold handling makes this a CONFIRMATION, not the sole creation
 *  point: a no-op when the turn already completed (production
 *  ack-after-run — `message_complete` precedes the ack) or when the
 *  turn's first broadcast event already adopted a scaffold. A different
 *  concurrent turn is preserved as a primary or sibling scaffold; the local
 *  ack adopts another sibling rather than displacing another tab's work.
 *  Under an ack-before-run server this is the creation point again and
 *  adoption never fires — both orderings work. */
export const beginInFlightTurn = (
  state: ChatThreadState,
  turn_id: string,
): ChatThreadState => {
  if (state.completed_turn_ids.includes(turn_id)) return state;
  if (state.inflight !== null && state.inflight.turn_id === turn_id) {
    return state;
  }
  if (state.inflight?.siblings?.some((turn) => turn.turn_id === turn_id)) return state;
  return replaceInflightTurn(state, {
    turn_id,
    assistant_content: '',
    tool_calls: [],
    transparency: [],
  });
};

/** Closed-list discriminator for *chat-thread*-scoped broadcast events.
 *  These are the per-turn / per-session variants the thread reducer
 *  consumes — distinct from the broader `ChatBroadcastEventKind` set
 *  (which also includes per-pair setting events such as
 *  `chat.default_model_pref_changed`, absorbed elsewhere). Keep
 *  tightly scoped — adding a kind = D-137 substrate change.
 *
 *  D-167 chat provider-threading — `chat.default_model_pref_changed` is
 *  BOTH a Settings event (the model-default panel absorbs it) AND a
 *  thread event: an open chat that INHERITS the global default must
 *  re-render its header badge to the new layer without a reload. */
type ChatThreadBroadcastEventKind =
  | 'chat.token_streamed'
  | 'chat.tool_call_started'
  | 'chat.tool_call_completed'
  | 'chat.plan_proposed'
  | 'chat.plan_resolved'
  | 'chat.transparency'
  | 'chat.message_complete'
  | 'chat.data_diagnosis_resolved'
  | 'chat.session_changed'
  | 'chat.default_model_pref_changed';

const CHAT_THREAD_EVENT_KINDS: ReadonlySet<ChatThreadBroadcastEventKind> = new Set([
  'chat.token_streamed',
  'chat.tool_call_started',
  'chat.tool_call_completed',
  'chat.plan_proposed',
  'chat.plan_resolved',
  'chat.transparency',
  'chat.message_complete',
  'chat.data_diagnosis_resolved',
  'chat.session_changed',
  'chat.default_model_pref_changed',
]);

export const isChatThreadEvent = (
  event: ServerEvent,
): event is Extract<ServerEvent, { kind: ChatThreadBroadcastEventKind }> =>
  CHAT_THREAD_EVENT_KINDS.has(event.kind as ChatThreadBroadcastEventKind);

type PlanExecutionEvent =
  | Extract<ServerEvent, { kind: 'chat.tool_call_started' }>
  | Extract<ServerEvent, { kind: 'chat.tool_call_completed' }>;

const samePlanExecutionReceipt = (
  left: PlanExecutionReceipt | undefined,
  right: PlanExecutionReceipt,
): boolean => {
  if (
    left === undefined
    || left.status !== right.status
    || left.turn_id !== right.turn_id
  ) return false;
  if (left.status === 'running' && right.status === 'running') return true;
  if (left.status === 'unknown' && right.status === 'unknown') return true;
  if (left.status === 'completed' && right.status === 'completed') {
    return (
      left.result_ref === right.result_ref
      && left.run_id === right.run_id
    );
  }
  if (left.status === 'held' && right.status === 'held') {
    return (
      left.result_ref === right.result_ref
      && left.hold_kind === right.hold_kind
      && left.run_id === right.run_id
    );
  }
  if (left.status === 'failed' && right.status === 'failed') {
    return (
      left.reason === right.reason
      && left.detail === right.detail
      && left.run_id === right.run_id
    );
  }
  return false;
};

const planExecutionReceiptFromEvent = (
  event: PlanExecutionEvent,
): PlanExecutionReceipt => {
  if (event.kind === 'chat.tool_call_started') {
    return { status: 'running', turn_id: event.turn_id };
  }
  if (event.status === 'error') {
    return {
      status: 'failed',
      turn_id: event.turn_id,
      reason: event.reason,
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
      ...(event.run_id !== undefined ? { run_id: event.run_id } : {}),
    };
  }
  if (event.run_held !== undefined) {
    return {
      status: 'held',
      turn_id: event.turn_id,
      result_ref: event.result_ref,
      hold_kind: event.run_held,
      ...(event.run_id !== undefined ? { run_id: event.run_id } : {}),
    };
  }
  return {
    status: 'completed',
    turn_id: event.turn_id,
    result_ref: event.result_ref,
    ...(event.run_id !== undefined ? { run_id: event.run_id } : {}),
  };
};

/** Project a plan-linked tool event onto the original approval card. The
 *  server adds `plan_id` only after consuming that exact approval. Terminal
 *  receipts never regress to `running` on a late/replayed start event. */
const applyPlanExecutionEvent = (
  state: ChatThreadState,
  event: PlanExecutionEvent,
): ChatThreadState => {
  if (event.plan_id === undefined) return state;
  const index = state.plan_cards.findIndex((card) => card.plan_id === event.plan_id);
  if (index === -1) return state;
  const existing = state.plan_cards[index];
  if (existing === undefined || existing.status === 'cancelled') return state;
  if (
    event.kind === 'chat.tool_call_started'
    && existing.execution !== undefined
    && existing.execution.status !== 'running'
  ) return state;

  let execution = planExecutionReceiptFromEvent(event);
  // A terminal lifecycle replay from an older producer can legitimately omit
  // the newer optional run address. Never let that erase a durable address
  // already recovered from the plan snapshot for the same one-time dispatch.
  const existingRunId =
    existing.execution?.status === 'completed'
    || existing.execution?.status === 'held'
    || existing.execution?.status === 'failed'
      ? existing.execution.run_id
      : undefined;
  if (
    existingRunId !== undefined
    && existing.execution?.status === execution.status
    && existing.execution.turn_id === execution.turn_id
    && (
      execution.status === 'completed'
      || execution.status === 'held'
      || execution.status === 'failed'
    )
    && execution.run_id === undefined
  ) {
    execution = { ...execution, run_id: existingRunId };
  }
  if (
    existing.status === 'approved'
    && samePlanExecutionReceipt(existing.execution, execution)
  ) return state;

  const copy = state.plan_cards.slice();
  copy[index] = {
    ...existing,
    // A plan-linked lifecycle event proves the approval was consumed. This
    // repairs a client that saw the proposal but missed the resolution event.
    status: 'approved',
    execution,
    recovered: false,
    payload_available: existing.payload_available ?? true,
  };
  return { ...state, plan_cards: copy };
};

/** Pure reducer over the chat-thread broadcast event kinds. Returns
 *  the unchanged state when the event belongs to a different session
 *  or the in-flight turn id mismatches (rare race; reducer just
 *  drops). */
export const reduceChatThreadEvent = (
  state: ChatThreadState,
  event: ServerEvent,
): ChatThreadState => {
  if (!isChatThreadEvent(event)) return state;

  // Session_changed targets the session record specifically; the
  // session_id discriminator + field discriminator drive the patch.
  if (event.kind === 'chat.session_changed') {
    if (event.field === 'tool_call') {
      const call = event.value;
      if (event.session_id !== state.session?.id || !isChatToolCallRecord(call)
        || call.session_id !== event.session_id) return state;
      const records = rememberToolCallRecords(state.tool_call_records, [call]);
      const known = records === state.tool_call_records
        ? state : { ...state, tool_call_records: records };
      const index = known.messages.findIndex(message => message.id === call.message_id);
      const message = known.messages[index];
      const prior = message?.tool_call;
      if (!prior || prior.turn_id !== call.turn_id
          || call.updated_at < prior.updated_at
          || (['succeeded', 'failed', 'interrupted'].includes(prior.state)
            && ['running', 'held'].includes(call.state))) return known;
      const messages = [...known.messages];
      messages[index] = { ...message!, tool_call: call };
      return { ...known, messages };
    }
    return applySessionChanged(state, event);
  }

  // D-167 chat provider-threading — the per-pair global default changed.
  // NOT session-scoped (carries no session_id); handled BEFORE the
  // session_id gate below. Applies to the open session only when it
  // INHERITS the default (an explicit per-session override is sticky).
  if (event.kind === 'chat.default_model_pref_changed') {
    return applyDefaultModelPrefChanged(state, event);
  }

  // All other kinds carry a session_id. Drop events for other sessions.
  if (!state.session || event.session_id !== state.session.id) return state;

  if (event.kind === 'chat.data_diagnosis_resolved') {
    const index = state.messages.findIndex(
      (message) => message.id === event.message_id,
    );
    if (index === -1) return state;
    const current = state.messages[index];
    if (
      current.role !== 'assistant'
      || current.data_diagnosis?.intent !== 'safe_check'
      || !isChatDataDiagnosisResolutionStatus(event.resolution?.status)
      || typeof event.resolution.resolved_at !== 'number'
      || !Number.isFinite(event.resolution.resolved_at)
    ) return state;
    if (
      current.data_diagnosis_resolution !== undefined
      && current.data_diagnosis_resolution.resolved_at
        >= event.resolution.resolved_at
    ) return state;
    const messages = state.messages.slice();
    messages[index] = {
      ...current,
      data_diagnosis_resolution: event.resolution,
    };
    return { ...state, messages };
  }

  if (event.kind === 'chat.message_complete') {
    return applyMessageComplete(state, event);
  }

  // § A.11 — plan-approval cards live on ChatThreadState, NOT the
  // in-flight scaffold (the proposing turn completes while the plan
  // stays pending), so both plan kinds resolve scaffold-independently
  // — same discipline as the PB7 failure projection. The card is the
  // canonical § A.11 paint; no transparency narrative is pushed (the
  // activity block would double-paint an interaction surface that,
  // unlike narrative, must not be hideable behind the § B.8.9 prefs).
  if (event.kind === 'chat.plan_proposed') {
    // Insert-only upsert: the orchestrator re-emits the proposed
    // broadcast for reconnect / multi-client coherence while the plan
    // is still pending, and a late replay must not flip an
    // already-resolved card back to 'proposed'.
    if (state.plan_cards.some((c) => c.plan_id === event.plan_id)) {
      return state;
    }
    return {
      ...state,
      plan_cards: [
        ...state.plan_cards,
        {
          plan_id: event.plan_id,
          turn_id: event.turn_id,
          ...(event.retry_of_plan_id !== undefined
            ? { retry_of_plan_id: event.retry_of_plan_id }
            : {}),
          tool: event.tool,
          tier: event.tier,
          args: event.args,
          ...(event.args_hash !== undefined
            ? { args_hash: event.args_hash }
            : {}),
          status: 'proposed',
          recovered: false,
          payload_available: true,
        },
      ],
    };
  }
  if (event.kind === 'chat.plan_resolved') {
    return applyPlanResolution(state, event.plan);
  }

  const baseState =
    event.kind === 'chat.tool_call_started'
    || event.kind === 'chat.tool_call_completed'
      ? applyPlanExecutionEvent(state, event)
      : state;

  // PB7 — failure-class transparency projects into `turn_failures`
  // BEFORE scaffold resolution, keyed by the event's own turn_id, so a
  // failure records even when the scaffold cannot exist (completed turn
  // replay, single-slot held by a different turn). The drawer capture
  // below rides the resolved scaffold like every other turn event.
  if (event.kind === 'chat.transparency') {
    const failure = projectFailureNotice(event.turn_id, event.event);
    const base: ChatThreadState =
      failure === null
        ? state
        : {
            ...state,
            turn_failures: upsertTurnFailure(state.turn_failures, failure),
          };
    const inflight = inflightForTurnEvent(base, event.turn_id);
    if (inflight === null) return base;
    return replaceInflightTurn(base, {
      ...inflight,
      transparency: [
        ...inflight.transparency,
        { kind: 'transparency', payload: event.event },
      ],
    });
  }

  // The remaining 3 kinds ride the resolved (possibly just-adopted)
  // scaffold; `inflightForTurnEvent` returns null for the drop cases.
  const inflight = inflightForTurnEvent(baseState, event.turn_id);
  if (inflight === null) return baseState;

  if (event.kind === 'chat.token_streamed') {
    return replaceInflightTurn(baseState, {
      ...inflight,
      assistant_content: inflight.assistant_content + event.delta,
    });
  }
  if (event.kind === 'chat.tool_call_started') {
    return replaceInflightTurn(baseState, {
      ...inflight,
      tool_calls: [
        ...inflight.tool_calls,
        {
          tool_name: event.tool_name,
          tier: event.tier,
          args: event.args,
          status: 'started',
        },
      ],
    });
  }
  if (event.kind === 'chat.tool_call_completed') {
    // One completion finishes ONE dispatch: patch only the first
    // matching started row, so a turn that starts the same tool twice
    // before the first completion doesn't mark both rows done. The
    // wire event carries no call id — first-started is the dispatch
    // order the orchestrator's tool loop completes in.
    const completedIndex = inflight.tool_calls.findIndex(
      (tc) => tc.tool_name === event.tool_name && tc.status === 'started',
    );
    const updated: InFlightToolCall[] = inflight.tool_calls.map((tc, i) => {
      if (i !== completedIndex) return tc;
      if (event.status === 'ok') {
        return {
          ...tc,
          status: 'ok' as const,
          result_ref: event.result_ref,
        };
      }
      return {
        ...tc,
        status: 'error' as const,
        reason: event.reason,
        // D-182 — keep the underlying error line (previously dropped) for the row.
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
      };
    });
    return replaceInflightTurn(baseState, { ...inflight, tool_calls: updated });
  }
  return baseState;
};

/** Route-side scaffold handling — resolve which in-flight scaffold a
 *  turn-scoped event applies to:
 *
 *    - an existing primary or sibling scaffold when its turn matches;
 *    - NULL when the turn already completed (late replay after
 *      `message_complete` must not resurrect a scaffold);
 *    - otherwise a FRESH scaffold for the event's turn — ADOPTION. In
 *      production the `chat.send` ack resolves after the whole turn
 *      broadcast, so the first broadcast event is the earliest the
 *      client can learn a turn started; adopting here is what makes
 *      live streaming + the drawer paint at all. Under an
 *      ack-before-run server the ack-created scaffold matches first
 *      and adoption never fires — order-agnostic by construction. */
const inflightForTurnEvent = (
  state: ChatThreadState,
  turn_id: string,
): InFlightTurn | null => {
  if (state.inflight !== null) {
    if (state.inflight.turn_id === turn_id) return state.inflight;
    const sibling = state.inflight.siblings?.find((turn) => turn.turn_id === turn_id);
    if (sibling) return sibling;
  }
  if (state.completed_turn_ids.includes(turn_id)) return null;
  return {
    turn_id,
    assistant_content: '',
    tool_calls: [],
    transparency: [],
  };
};

/** Replace/adopt one scaffold without displacing its concurrent siblings. */
const replaceInflightTurn = (
  state: ChatThreadState,
  updated: InFlightTurn,
): ChatThreadState => {
  const { siblings: _nested, ...flatUpdated } = updated;
  void _nested;
  if (state.inflight === null) return { ...state, inflight: flatUpdated };
  if (state.inflight.turn_id === updated.turn_id) {
    const siblings = state.inflight.siblings;
    return {
      ...state,
      inflight: siblings && siblings.length > 0
        ? { ...flatUpdated, siblings }
        : flatUpdated,
    };
  }
  const siblings = state.inflight.siblings ?? [];
  const found = siblings.some((turn) => turn.turn_id === updated.turn_id);
  const nextSiblings = found
    ? siblings.map((turn) => turn.turn_id === updated.turn_id ? flatUpdated : turn)
    : [...siblings, flatUpdated];
  return {
    ...state,
    inflight: { ...state.inflight, siblings: nextSiblings },
  };
};

/** PB7 — project a transparency payload into a failure notice, or null
 *  for non-failure-class / malformed payloads. Total: a payload that
 *  claims a failure kind but breaks its template still yields a notice
 *  with generic copy (the turn DID fail — the paint must not vanish on
 *  a payload quirk). */
const projectFailureNotice = (
  turn_id: string,
  payload: unknown,
): TurnFailureNotice | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const kind = (payload as { kind?: unknown }).kind;
  if (!isTransparencyEventKind(kind)) return null;
  if (classForTransparencyEventKind(kind) !== 'failure') return null;
  let text = '';
  try {
    text = renderTransparencyTemplate(payload as TransparencyEvent);
  } catch {
    /* malformed payload — fall through to the generic line */
  }
  if (text.trim().length === 0) text = 'this turn failed';
  return {
    turn_id,
    kind,
    text,
    settings_link:
      kind === 'engine.decoder_unavailable' &&
      (payload as { reason?: unknown }).reason === 'no_source',
  };
};

/** § A.11 — apply a resolved plan (approved / cancelled) to the card
 *  list. Shared by the `chat.plan_resolved` broadcast branch and the
 *  route's OPTIMISTIC apply of the approve / cancel rpc response —
 *  whichever lands first wins, the other no-ops (status-equal replay
 *  returns the same state object so the route's identity check skips
 *  the re-render). A client that never saw the proposal (joined late)
 *  materializes the card directly in its resolved state from the
 *  authoritative `ChatPlanProposal`. A `'proposed'` status is refused
 *  — resolutions never downgrade. */
export const applyPlanResolution = (
  state: ChatThreadState,
  plan: ChatPlanProposal,
): ChatThreadState => {
  if (!state.session || plan.session_id !== state.session.id) return state;
  if (plan.status === 'proposed') return state;
  const index = state.plan_cards.findIndex((c) => c.plan_id === plan.plan_id);
  if (index === -1) {
    return {
      ...state,
      plan_cards: [
        ...state.plan_cards,
        {
          plan_id: plan.plan_id,
          turn_id: plan.turn_id,
          ...(plan.retry_of_plan_id !== undefined
            ? { retry_of_plan_id: plan.retry_of_plan_id }
            : {}),
          tool: plan.tool,
          tier: plan.tier,
          args: plan.args,
          args_hash: plan.args_hash,
          status: plan.status,
        },
      ],
    };
  }
  const existing = state.plan_cards[index];
  if (existing.status === plan.status) return state;
  const copy = state.plan_cards.slice();
  copy[index] = { ...existing, status: plan.status };
  return { ...state, plan_cards: copy };
};

/** Latest failure per turn wins — replace the turn's existing entry in
 *  place (stable order), append otherwise. */
const upsertTurnFailure = (
  failures: ReadonlyArray<TurnFailureNotice>,
  next: TurnFailureNotice,
): ReadonlyArray<TurnFailureNotice> => {
  const index = failures.findIndex((f) => f.turn_id === next.turn_id);
  if (index === -1) return [...failures, next];
  const copy = failures.slice();
  copy[index] = next;
  return copy;
};

const applyMessageComplete = (
  state: ChatThreadState,
  event: Extract<ServerEvent, { kind: 'chat.message_complete' }>,
): ChatThreadState => {
  if (!state.session) return state;
  // The wire-level `event.final` is typed `unknown` (the events
  // contract doesn't ratchet ChatMessage's shape into the broadcast
  // union — keeps the events.ts surface narrow). Treat as ChatMessage
  // at the chat-channel boundary; defend against malformed payloads
  // by dropping the event if the row lacks an id.
  const final = event.final as ChatMessage;
  if (!final || typeof final.id !== 'string') return state;
  // Replace in-flight with authoritative server message; refuse to
  // dupe if final.id already exists (broadcast replay).
  const exists = state.messages.some((m) => m.id === final.id);
  const nextMessages: ChatMessage[] = exists
    ? state.messages
    : [...state.messages, final];
  // PB7 — link the turn's failure notice (if any) to the persisted
  // message row so the renderer can keep painting it after the
  // in-flight scaffold is discarded. Replay-safe: an already-stamped
  // notice is left untouched.
  const turn_failures = state.turn_failures.some(
    (f) => f.turn_id === event.turn_id && f.message_id === undefined,
  )
    ? state.turn_failures.map((f) =>
        f.turn_id === event.turn_id && f.message_id === undefined
          ? { ...f, message_id: final.id }
          : f,
      )
    : state.turn_failures;
  // § A.11 — same linkage for the turn's plan-approval cards: the
  // proposing turn completes with the plan still pending, and the
  // card must keep rendering (and stay clickable) under the persisted
  // assistant message.
  const plan_cards = state.plan_cards.some(
    (c) => c.turn_id === event.turn_id && c.message_id === undefined,
  )
    ? state.plan_cards.map((c) =>
        c.turn_id === event.turn_id && c.message_id === undefined
          ? { ...c, message_id: final.id }
          : c,
      )
    : state.plan_cards;
  // Route-side scaffold handling — remember the completion (deduped,
  // capped FIFO) so the late `chat.send` ack cannot re-scaffold this
  // turn, and clear the scaffold TURN-MATCHED: a completion broadcast
  // for some other turn (multi-tab session) must not tear down the
  // slot owner's live scaffold.
  return {
    ...state,
    messages: nextMessages,
    inflight: withoutInflightTurn(state.inflight, event.turn_id),
    turn_failures,
    plan_cards,
    completed_turn_ids: rememberCompletedTurn(state.completed_turn_ids, event.turn_id),
  };
};

/** Deduped, capped FIFO: newest kept, oldest dropped. */
const rememberCompletedTurn = (
  ids: ReadonlyArray<string>,
  turn_id: string,
): ReadonlyArray<string> =>
  ids.includes(turn_id) ? ids : [...ids, turn_id].slice(-COMPLETED_TURN_MEMORY);

/** The scaffolds without one turn's. A sibling is promoted when the primary
 *  goes; the SAME object comes back when the turn has no scaffold. */
const withoutInflightTurn = (
  inflight: InFlightTurn | null,
  turn_id: string,
): InFlightTurn | null => {
  if (inflight === null) return null;
  const siblings = inflight.siblings ?? [];
  if (inflight.turn_id === turn_id) {
    const [promoted, ...rest] = siblings;
    if (!promoted) return null;
    return rest.length > 0 ? { ...promoted, siblings: rest } : promoted;
  }
  const remaining = siblings.filter((turn) => turn.turn_id !== turn_id);
  if (remaining.length === siblings.length) return inflight;
  const { siblings: _drop, ...primary } = inflight;
  void _drop;
  return remaining.length > 0 ? { ...primary, siblings: remaining } : primary;
};

/** Retire the scaffold of a turn the queue stopped without an answer
 *  (`cancelled`, `failed`, `interrupted`).
 *
 *  ⛔ WHAT IT SHOWED WAS NEVER SAVED. Chat streams the settled answer before
 *  the closing brief, but only a completed turn writes the assistant row, and
 *  a stopped one sends no `chat.message_complete` and no retraction. Kept, the
 *  scaffold read as a normal reply until a reload removed it, and "Try again"
 *  then showed the new saved answer with the old copy beneath it.
 *
 *  Remembered like a completion, so a late or replayed event for the turn
 *  cannot raise it again. Its failure notice, if one painted under the
 *  scaffold, moves to the turn's own message: failure notices are
 *  user-must-see, and with the scaffold gone nothing else would paint it.
 *
 *  Identity when the turn has no scaffold. A queue snapshot lists the latest
 *  64 turns, and old stopped turns must not crowd the completed-turn memory. */
export const discardInFlightTurn = (
  state: ChatThreadState,
  turn_id: string,
): ChatThreadState => {
  const inflight = withoutInflightTurn(state.inflight, turn_id);
  if (inflight === state.inflight) return state;
  const asked = state.messages.find(
    (message) => message.role === 'user' && message.turn_id === turn_id,
  );
  const turn_failures = asked !== undefined && state.turn_failures.some(
    (f) => f.turn_id === turn_id && f.message_id === undefined,
  )
    ? state.turn_failures.map((f) =>
        f.turn_id === turn_id && f.message_id === undefined
          ? { ...f, message_id: asked.id }
          : f,
      )
    : state.turn_failures;
  return {
    ...state,
    inflight,
    turn_failures,
    completed_turn_ids: rememberCompletedTurn(state.completed_turn_ids, turn_id),
  };
};

const applySessionChanged = (
  state: ChatThreadState,
  event: Extract<ServerEvent, { kind: 'chat.session_changed' }>,
): ChatThreadState => {
  if (!state.session || event.session_id !== state.session.id) return state;
  if (event.field === 'attachments') {
    const value = event.value as { file_id?: unknown; deleted?: unknown } | undefined;
    if (!value || typeof value.file_id !== 'string' || value.deleted !== true) return state;
    return { ...state, messages: state.messages.map(message => ({ ...message,
      ...(message.attachments ? { attachments: message.attachments.map(file => file.source_file_id === value.file_id
        || file.file_id === value.file_id ? { ...file, availability: 'deleted' as const } : file) } : {}) })) };
  }
  if (event.field === 'message') {
    const message = event.value as ChatMessage | undefined;
    if (!message || typeof message.id !== 'string' || message.session_id !== state.session.id
      || typeof message.content !== 'string' || !Number.isFinite(message.ts)
      || !['user', 'assistant'].includes(message.role)) return state;
    if (state.messages.some((row) => row.id === message.id)) return state;
    return { ...state, messages: [...state.messages, message].sort((a, b) =>
      a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
  }
  return {
    ...state,
    session: patchSessionField(state.session, event.field, event.value),
  };
};

/** D-167 chat provider-threading — apply a global-default change to the
 *  open thread. An overridden session keeps its explicit layer; only an
 *  inherited session (`overridden !== true`) re-renders to the new default,
 *  dropping any stale provider/model_id (an inherited session carries the
 *  bare layer — Q1: tier only). */
const applyDefaultModelPrefChanged = (
  state: ChatThreadState,
  event: Extract<ServerEvent, { kind: 'chat.default_model_pref_changed' }>,
): ChatThreadState => {
  if (!state.session) return state;
  if (state.session.model_routing.overridden === true) return state;
  return {
    ...state,
    session: {
      ...state.session,
      // § A.14 slot-aware chat routing — an inherited session adopts the
      // default's layer + slot hint (drops any stale provider/model_id).
      model_routing: {
        current: event.layer,
        ...(isChatModelHint(event.model_hint)
          ? { model_hint: event.model_hint }
          : {}),
        ...(isChatModelSourceId(event.source_id)
          ? { source_id: event.source_id }
          : {}),
        overridden: false,
      },
    },
  };
};

const patchSessionField = (
  session: ChatSession,
  field: ChatSessionChangedField,
  value: unknown,
): ChatSession => {
  switch (field) {
    case 'picker':
      if (value && typeof value === 'object' && 'current' in value) {
        return {
          ...session,
          picker_state: { current: (value as { current: ChatPickerTarget }).current },
        };
      }
      return session;
    case 'model_pref':
      if (value && typeof value === 'object' && 'current' in value) {
        const patch = value as {
          current: ChatModelRoutingLayer;
          model_hint?: unknown;
          source_id?: unknown;
          overridden?: boolean;
        };
        // D-167 + § A.14 — REPLACE model_routing wholesale (do not spread the
        // prior shape). A set (override) / clear (revert to inherit) broadcast
        // carries the effective layer + § A.14 slot hint + the `overridden`
        // flag; the server drops any prior provider/model_id, so the open tab
        // must drop them too rather than keep stale values.
        return {
          ...session,
          model_routing: {
            current: patch.current,
            ...(isChatModelHint(patch.model_hint)
              ? { model_hint: patch.model_hint }
              : {}),
            ...(isChatModelSourceId(patch.source_id)
              ? { source_id: patch.source_id }
              : {}),
            ...(typeof patch.overridden === 'boolean'
              ? { overridden: patch.overridden }
              : {}),
          },
        };
      }
      return session;
    case 'title':
      if (typeof value === 'string' && value.length > 0) {
        return { ...session, title: value };
      }
      return session;
    case 'archived':
      if (typeof value === 'boolean') {
        return { ...session, archived: value };
      }
      return session;
    default:
      return session;
  }
};
