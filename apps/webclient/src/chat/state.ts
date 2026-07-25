/** D-137 P1.4 — Webclient chat-state reducer (pure).
 *
 *  The webclient is display + HID per D-148 § A.4. The chat surface
 *  consumes the per-pair broadcast bus (D-121 / § Wire A) and renders
 *  state in real time:
 *
 *    - `chat.token_streamed`     → append delta to in-flight assistant
 *    - `chat.tool_call_started`  → push a tool_call row (status: started)
 *    - `chat.tool_call_completed`→ patch the matching row's status
 *    - `chat.plan_proposed`      → push a plan-approval card (P3 § A.11)
 *    - `chat.plan_resolved`      → flip the matching card to its
 *      approved / cancelled terminal state
 *    - `chat.transparency`       → push a transparency-stream entry
 *    - `chat.message_complete`   → replace the in-flight turn with the
 *      authoritative ChatMessage row from the server
 *    - `chat.session_changed`    → patch picker / model_pref / title /
 *      archived on the in-memory session record
 *
 *  Pure reducer: the same `(state, event)` → same next state. No
 *  network, no clock, no side effects. The renderer wires this up to
 *  the WS broadcast subscriber + drives re-renders on every update.
 *
 *  Storage discipline per D-148 § A.4.1 — none of this state persists
 *  to IDB. Chat history lives on the server (encrypted per-pair via
 *  the `chat` sub-DEK). The webclient pulls history via
 *  `chat.session.get` rpc at session open + lets broadcast events keep
 *  it in sync until the user closes the tab.
 */

import {
  classForTransparencyEventKind,
  isChatModelHint,
  isTransparencyEventKind,
  renderTransparencyTemplate,
  type ChatMessage,
  type ChatModelRoutingLayer,
  type ChatPickerTarget,
  type ChatPlanProposal,
  type ChatPlanStatus,
  type ChatSession,
  type ChatSessionChangedField,
  type ChatToolCall,
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

/** Single in-flight turn — built up incrementally from broadcast
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
 *  Ephemeral by design — hydration resets it (the server-side
 *  `PlanApprovalStore` is in-memory too; a reload fairly drops pending
 *  cards and Mary re-asks). */
export interface PlanApprovalCard {
  plan_id: string;
  turn_id: string;
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
  status: ChatPlanStatus;
}

export interface ChatThreadState {
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
   *  turn). Session-tab-lifetime only; see `PlanApprovalCard`. */
  plan_cards: ReadonlyArray<PlanApprovalCard>;
  /** Route-side scaffold handling — turn ids whose
   *  `chat.message_complete` already landed. In production the
   *  `chat.send` ack resolves only AFTER the whole turn broadcast, so
   *  without this memory the post-ack `beginInFlightTurn` would
   *  scaffold an already-finished turn and render a dangling empty
   *  assistant bubble. Capped FIFO (`COMPLETED_TURN_MEMORY`);
   *  session-tab-lifetime only (hydration resets). */
  completed_turn_ids: ReadonlyArray<string>;
}

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
});

/** Apply a `chat.session.get` rpc snapshot to the thread state. */
export const hydrateThreadFromSnapshot = (
  state: ChatThreadState,
  snapshot: ChatSession & { messages: ChatMessage[] },
): ChatThreadState => ({
  session: { ...snapshot },
  messages: snapshot.messages.slice(),
  inflight: null,
  turn_failures: [],
  plan_cards: [],
  completed_turn_ids: [],
});

/** Create the in-flight turn at the `chat.send` ack. Route-side
 *  scaffold handling makes this a CONFIRMATION, not the sole creation
 *  point: a no-op when the turn already completed (production
 *  ack-after-run — `message_complete` precedes the ack) or when the
 *  turn's first broadcast event already adopted a scaffold. A
 *  DIFFERENT-turn in-flight is still replaced — the local user's
 *  explicit send wins the single slot over an adopted concurrent turn
 *  (e.g. another tab's). Under an ack-before-run server this is the
 *  creation point again and adoption never fires — both orderings work. */
export const beginInFlightTurn = (
  state: ChatThreadState,
  turn_id: string,
): ChatThreadState => {
  if (state.completed_turn_ids.includes(turn_id)) return state;
  if (state.inflight !== null && state.inflight.turn_id === turn_id) {
    return state;
  }
  return {
    ...state,
    inflight: {
      turn_id,
      assistant_content: '',
      tool_calls: [],
      transparency: [],
    },
  };
};

/** Closed-list discriminator for *chat-thread*-scoped broadcast events.
 *  These are the per-turn / per-session variants the thread reducer
 *  consumes — distinct from the broader `ChatBroadcastEventKind` set
 *  (which also includes `chat.tool_catalog_scope_changed`, a Settings-
 *  scoped event the Settings page reducer absorbs separately). Keep
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
  'chat.session_changed',
  'chat.default_model_pref_changed',
]);

export const isChatThreadEvent = (
  event: ServerEvent,
): event is Extract<ServerEvent, { kind: ChatThreadBroadcastEventKind }> =>
  CHAT_THREAD_EVENT_KINDS.has(event.kind as ChatThreadBroadcastEventKind);

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
    return applySessionChanged(state, event);
  }

  // D-167 chat provider-threading — the per-pair global default changed.
  // NOT session-scoped (carries no session_id); handled BEFORE the
  // session_id gate below. Applies to the open session only when it
  // INHERITS the default (an explicit per-session override is sticky).
  if (event.kind === 'chat.default_model_pref_changed') {
    return applyDefaultModelPrefChanged(state, event);
  }

  // All other kinds carry a turn_id + session_id. Drop events for
  // other sessions; drop events for a stale in-flight turn id.
  if (!state.session || event.session_id !== state.session.id) return state;

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
          tool: event.tool,
          tier: event.tier,
          args: event.args,
          status: 'proposed',
        },
      ],
    };
  }
  if (event.kind === 'chat.plan_resolved') {
    return applyPlanResolution(state, event.plan);
  }

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
    return {
      ...base,
      inflight: {
        ...inflight,
        transparency: [
          ...inflight.transparency,
          { kind: 'transparency', payload: event.event },
        ],
      },
    };
  }

  // The remaining 3 kinds ride the resolved (possibly just-adopted)
  // scaffold; `inflightForTurnEvent` returns null for the drop cases.
  const inflight = inflightForTurnEvent(state, event.turn_id);
  if (inflight === null) return state;

  if (event.kind === 'chat.token_streamed') {
    return {
      ...state,
      inflight: {
        ...inflight,
        assistant_content: inflight.assistant_content + event.delta,
      },
    };
  }
  if (event.kind === 'chat.tool_call_started') {
    return {
      ...state,
      inflight: {
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
      },
    };
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
    return {
      ...state,
      inflight: { ...inflight, tool_calls: updated },
    };
  }
  return state;
};

/** Route-side scaffold handling — resolve which in-flight scaffold a
 *  turn-scoped event applies to:
 *
 *    - the active scaffold, when its turn matches;
 *    - NULL when the single slot is held by a DIFFERENT turn (no
 *      stealing — the slot owner keeps streaming; the displaced turn's
 *      failure paint still records via the gate-independent PB7
 *      projection);
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
    return state.inflight.turn_id === turn_id ? state.inflight : null;
  }
  if (state.completed_turn_ids.includes(turn_id)) return null;
  return {
    turn_id,
    assistant_content: '',
    tool_calls: [],
    transparency: [],
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
          tool: plan.tool,
          tier: plan.tier,
          args: plan.args,
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
  const completed_turn_ids = state.completed_turn_ids.includes(event.turn_id)
    ? state.completed_turn_ids
    : [...state.completed_turn_ids, event.turn_id].slice(-COMPLETED_TURN_MEMORY);
  return {
    ...state,
    messages: nextMessages,
    inflight:
      state.inflight !== null && state.inflight.turn_id === event.turn_id
        ? null
        : state.inflight,
    turn_failures,
    plan_cards,
    completed_turn_ids,
  };
};

const applySessionChanged = (
  state: ChatThreadState,
  event: Extract<ServerEvent, { kind: 'chat.session_changed' }>,
): ChatThreadState => {
  if (!state.session || event.session_id !== state.session.id) return state;
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
