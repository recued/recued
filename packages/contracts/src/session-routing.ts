/** D-153 P7 — Routing classifier + lifecycle states.
 *
 *  D-153's session substrate now has three legs: P1 named the
 *  three-tier session IDs (channel / cognition / correlation), P5
 *  named the *links between* sessions (`predecessor_session_id`), and
 *  P6 named when a session *closes* (the cut models). P7 names what
 *  happens *inside* an open session — the lifecycle states it moves
 *  through, and where a newly-arrived message routes given the state
 *  the session is in.
 *
 *  **Session lifecycle states.** A session moves through a fixed,
 *  monotone-forward sequence (spec lines 557-564):
 *
 *    - `intent_forming`   — the pre-commit input pool is filling;
 *      cognition has not committed an intent yet.
 *    - `intent_committed` — a plan exists and is being dispatched.
 *    - `executing`        — children are in flight.
 *    - `intent_satisfied` — cognition signalled the intent is done;
 *      the session closes shortly (the cognition-driven cut, P6).
 *    - `closed`           — finalized + immutable. The terminal state.
 *
 *  The state index never decreases — a session never moves backward.
 *  A refinement that adjusts an in-flight plan is absorbed *in place*;
 *  it does not regress the lifecycle (the plan grows, the state holds).
 *  `closed` is reachable from every other state — any session can be
 *  cut (P6 debounce / plan-completion) or cancelled (a `switch`
 *  routing) from wherever it sits. `LIFECYCLE_TRANSITIONS` is the
 *  adjacency; `canTransitionLifecycle` is the predicate over it.
 *
 *  **Pre-commit input pool.** While a session is `intent_forming`,
 *  messages accumulate in a pool rather than each forcing a separate
 *  intent — the "quick correction before the assistant responds" case
 *  (spec line 567). The pool has a dual soft cap: `INPUT_POOL_MAX_-
 *  MESSAGES` messages OR `INPUT_POOL_WINDOW_MS` elapsed force the
 *  `intent_forming → intent_committed` transition. `openInputPool`
 *  constructs the pool; `evaluateInputPool` is the pure reducer that
 *  reports when the cap is hit. The forced commit is the deterministic
 *  *upper bound* — a cognition component may commit the pool earlier;
 *  the substrate only enforces the ceiling. With cognition disabled
 *  (the default) the cap is the sole committer, so this is real
 *  deterministic substrate, not a stub.
 *
 *  **Message routing.** Closure (when a session closes — P6) and
 *  routing (where a new message goes) are separate decisions (spec
 *  line 555). `resolveMessageRouting` is the deterministic outer
 *  dispatch over the lifecycle state:
 *
 *    - `intent_forming`                   → `'append_to_pool'`
 *    - `intent_committed` / `executing`   → `'classify'`
 *    - `intent_satisfied` / `closed`      → `'new_session'`
 *
 *  Only the `'classify'` branch needs cognition — the message arrived
 *  mid-flight and the classifier decides whether it is a refinement /
 *  switch / parallel / meta of the in-flight session. The other two
 *  branches are fully deterministic.
 *
 *  **The routing classifier is a typed stub.** Mirroring P6's
 *  cognition-driven cut: the `'classify'` outcome resolves to a
 *  classification only a cognition component can produce ("cheap fast
 *  model, ~50 tokens" — spec line 568). P7 ships the *classifier API*
 *  — `RoutingClassifierInput`, `RoutingClassification`, the
 *  `RoutingClassifier` slot type, the `RoutingDisposition` closed list
 *  — but no classifier *implementation*: there is no `classifyRouting`
 *  function. Per the 2026-05-19 cognition downscope (recued-bench Path
 *  B Stage 4 verdict; cognition is pluggable, DEFAULT DISABLED) no
 *  cognition component runs in the default Recued runtime. What the
 *  substrate *does* ship for routing is the deterministic envelope:
 *  the four `RoutingDisposition` values + `ROUTING_EFFECTS`, the
 *  structural consequence of each disposition (does it open a new
 *  session, does it close the active one). Cognition picks the
 *  disposition; the substrate says what each disposition structurally
 *  does.
 *
 *  **Lifecycle broadcast event.** Spec open question #19 — "closed-list
 *  of session lifecycle events to enumerate" — resolves here: every
 *  lifecycle-state transition is one `session_lifecycle` `ServerEvent`
 *  (defined in `events.ts`, which imports `SessionLifecycleState` from
 *  this file). The closed list of lifecycle *events* is therefore the
 *  closed list of lifecycle *states* — each state-entry broadcasts one
 *  event. A session *opening* is the event with `prev_state: null`; a
 *  session *closing* is the event with `state: 'closed'`. A "transfer"
 *  (the spec's `session.transferred` example) is not a separate event
 *  kind — a transferred-in session simply *opens*, and the "from whom"
 *  data lives on P5's `predecessor_session_id` / P6's
 *  `derived_from_session_id` link. One event kind, no redundancy.
 *
 *  P7 ships substrate-only — the closed lists, the lifecycle adjacency,
 *  the pure pool reducer, the routing resolver, the routing-effect
 *  registry, and the classifier API types land here. Deferred to D-145
 *  (Engine substrate):
 *
 *    - **The session store.** Which session row carries the lifecycle
 *      state + the `InputPoolState`, and at which layer (channel /
 *      cognition), is the Engine's session lifecycle. The substrate
 *      operates on values the caller already holds — same decoupling
 *      P5 / P6 use.
 *    - **Driving the transitions.** *When* the Engine moves a session
 *      forward (pool committed, children dispatched, cognition
 *      signalled) is Engine work; `canTransitionLifecycle` is only the
 *      legal-move predicate and `evaluateInputPool` only the cap
 *      reducer — the tick loop that calls them is D-145's.
 *    - **The classifier implementation.** `RoutingClassifier` is the
 *      typed slot; the cognition component fills it. See the stub note
 *      above.
 *    - **Emitting the broadcast event.** The `session_lifecycle` event
 *      *shape* is in `events.ts`; the Engine emitting it on each
 *      transition is D-145 / D-121 wiring.
 *
 *  Cognition-independent (modulo the typed `RoutingClassifier` stub).
 *  Matches the P1 / P2 / P3 / P5 / P6 / P8 substrate-first pattern.
 *  Self-contained — this file imports nothing.
 *
 *  No tests in this file per the test-after-review workflow; tests
 *  land in a separate post-review step.
 *
 *  Spec: docs/d-153-spec.md § Routing — what happens when a new
 *  message arrives (lines 553-573); phase plan line 653; open
 *  questions #16 (input-pool cap shape) + #19 (lifecycle event
 *  broadcast). */

// ────────────────────────────────────────────────────────────────
// Session lifecycle states
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of session lifecycle states, in forward order
 *  (spec lines 557-564). The array order *is* the monotone
 *  progression — a session's state index never decreases, and
 *  `assertSessionRoutingInvariants` pins every `LIFECYCLE_TRANSITIONS`
 *  edge to move strictly forward in this order.
 *
 *  - `'intent_forming'`   — the pre-commit input pool is filling;
 *    cognition has not committed an intent. Index 0.
 *  - `'intent_committed'` — a plan exists and is dispatching.
 *  - `'executing'`        — children are in flight.
 *  - `'intent_satisfied'` — cognition signalled the intent is done;
 *    closes shortly.
 *  - `'closed'`           — finalized + immutable. The terminal state;
 *    the last index. */
export const SESSION_LIFECYCLE_STATES = [
  'intent_forming',
  'intent_committed',
  'executing',
  'intent_satisfied',
  'closed',
] as const;

/** String-literal union derived from `SESSION_LIFECYCLE_STATES`. */
export type SessionLifecycleState = (typeof SESSION_LIFECYCLE_STATES)[number];

/** Predicate — true when `value` is a known `SessionLifecycleState`. */
export const isSessionLifecycleState = (
  value: unknown,
): value is SessionLifecycleState =>
  typeof value === 'string'
  && (SESSION_LIFECYCLE_STATES as readonly string[]).includes(value);

/** True when a lifecycle state is terminal — the session is finalized
 *  and immutable, and no further transition is legal. `'closed'` is
 *  the sole terminal state; `assertSessionRoutingInvariants` pins that
 *  it is the unique state with an empty `LIFECYCLE_TRANSITIONS` set. */
export const isTerminalLifecycleState = (
  state: SessionLifecycleState,
): boolean => state === 'closed';

// ────────────────────────────────────────────────────────────────
// Lifecycle transitions — the legal-move adjacency
// ────────────────────────────────────────────────────────────────

/** The legal forward transitions out of each lifecycle state. The
 *  adjacency of a monotone-forward state machine: every edge moves
 *  strictly forward in `SESSION_LIFECYCLE_STATES` order, no state
 *  links to itself, and `'closed'` (terminal) has no outgoing edge.
 *
 *  Edge rationale:
 *    - `intent_forming   → intent_committed` — the pool committed
 *      (cognition, or the forced cap); `→ closed` — the session was
 *      cut before any intent committed (an idle chat, a reception
 *      ping that left). It does NOT go straight to `intent_satisfied`
 *      — being "satisfied" presupposes a committed plan.
 *    - `intent_committed → executing` — children were dispatched;
 *      `→ intent_satisfied` — a trivial plan that needs no tool
 *      dispatch (a pure-response intent); `→ closed` — a `switch`
 *      routing cancelled the root, or a cut fired.
 *    - `executing        → intent_satisfied` — children drained and
 *      cognition signalled done; `→ closed` — a `switch` cancelled
 *      mid-execution, or a system channel's plan-completion cut fired.
 *    - `intent_satisfied → closed` — the post-satisfaction close.
 *    - `closed`          — terminal; no outgoing edge.
 *
 *  Frozen at module load. `Record<SessionLifecycleState, …>` makes a
 *  missing state a compile error; `assertSessionRoutingInvariants`
 *  pins the value-level invariants (forward-only, no self-edge,
 *  `closed` uniquely terminal). */
export const LIFECYCLE_TRANSITIONS: Record<
  SessionLifecycleState,
  readonly SessionLifecycleState[]
> = {
  intent_forming: ['intent_committed', 'closed'],
  intent_committed: ['executing', 'intent_satisfied', 'closed'],
  executing: ['intent_satisfied', 'closed'],
  intent_satisfied: ['closed'],
  closed: [],
};

// Freeze each adjacency list *and* the record. Freezing the record
// alone leaves the array values mutable — a frozen-looking registry
// whose graph could still be corrupted in place post-boot, bypassing
// the load-time `assertSessionRoutingInvariants`. Mirrors how
// `ROUTING_EFFECTS` freezes its value objects below.
for (const targets of Object.values(LIFECYCLE_TRANSITIONS)) {
  Object.freeze(targets);
}
Object.freeze(LIFECYCLE_TRANSITIONS);

/** True when a session may legally move from `from` to `to`. A pure
 *  lookup over `LIFECYCLE_TRANSITIONS`. `from === to` is never legal
 *  (no self-edge — appending a message to the `intent_forming` pool
 *  mutates the *pool*, not the lifecycle state); `from === 'closed'`
 *  is never legal (terminal). The Engine (D-145) calls this to gate a
 *  transition before applying it. */
export const canTransitionLifecycle = (
  from: SessionLifecycleState,
  to: SessionLifecycleState,
): boolean => LIFECYCLE_TRANSITIONS[from].includes(to);

// ────────────────────────────────────────────────────────────────
// Pre-commit input pool — the intent_forming accumulator
// ────────────────────────────────────────────────────────────────

/** Soft cap on the count of messages a `intent_forming` input pool
 *  holds before a forced `intent_committed` transition (spec line
 *  567). The pool opens already holding 1 message (the one that
 *  created the session), so 4 further messages reach the cap.
 *
 *  Placeholder value pending bench-task calibration — spec open
 *  question #16. */
export const INPUT_POOL_MAX_MESSAGES = 5;

/** Soft cap on the age (unix-ms) of a `intent_forming` input pool
 *  before a forced `intent_committed` transition (spec line 567).
 *  Measured from `InputPoolState.opened_at`.
 *
 *  Placeholder value pending bench-task calibration — spec open
 *  question #16. */
export const INPUT_POOL_WINDOW_MS = 30_000;

/** Closed enumeration of why the input pool force-committed — the
 *  reason `evaluateInputPool` reports alongside `should_commit`.
 *  Informational: it drives the `session_lifecycle` event copy + the
 *  audit trail, not control flow.
 *
 *  - `'count_cap'`      — the pool reached `INPUT_POOL_MAX_MESSAGES`.
 *  - `'window_elapsed'` — the pool aged past `INPUT_POOL_WINDOW_MS`. */
export const INPUT_POOL_COMMIT_REASONS = ['count_cap', 'window_elapsed'] as const;

/** String-literal union derived from `INPUT_POOL_COMMIT_REASONS`. */
export type InputPoolCommitReason = (typeof INPUT_POOL_COMMIT_REASONS)[number];

/** Predicate — true when `value` is a known `InputPoolCommitReason`. */
export const isInputPoolCommitReason = (
  value: unknown,
): value is InputPoolCommitReason =>
  typeof value === 'string'
  && (INPUT_POOL_COMMIT_REASONS as readonly string[]).includes(value);

/** The cap-relevant state of a `intent_forming` session's input pool,
 *  persisted by the Engine on the session row between evaluations. The
 *  pool's *contents* (the message texts cognition reads) live in the
 *  Engine — the substrate tracks only the two counters the dual cap
 *  needs:
 *    - `opened_at`     — unix-ms the pool opened (the instant the
 *      session-creating message arrived). The window cap measures from
 *      here.
 *    - `message_count` — messages accumulated so far, the pool-creating
 *      message included. The count cap reads this. */
export interface InputPoolState {
  readonly opened_at: number;
  readonly message_count: number;
}

/** Construct the input pool of a freshly-opened `intent_forming`
 *  session. The pool opens already holding the one message that
 *  created the session, so `message_count` starts at 1 — the count
 *  cap then needs `INPUT_POOL_MAX_MESSAGES - 1` further messages.
 *
 *  `now` is the unix-ms the session-creating message arrived; it
 *  becomes `opened_at`, the anchor the window cap measures from. */
export const openInputPool = (now: number): InputPoolState => ({
  opened_at: now,
  message_count: 1,
});

/** The result of one `evaluateInputPool` evaluation. */
export interface InputPoolEvaluation {
  /** The pool state to persist for the next evaluation. */
  readonly next_state: InputPoolState;
  /** True when the pool should force-commit now — a cap was hit and
   *  the Engine should transition the session `intent_forming →
   *  intent_committed`. Always equals `commit_reason !== null`. */
  readonly should_commit: boolean;
  /** Which cap forced the commit, or `null` when neither has. When
   *  both caps are hit in the same evaluation `'count_cap'` wins —
   *  a deterministic tie-break (the count is an exact signal; the
   *  window is a soft one), not a semantic ranking; both are equally
   *  valid force-commit triggers. */
  readonly commit_reason: InputPoolCommitReason | null;
  /** The unix-ms instant the window cap comes due
   *  (`opened_at + INPUT_POOL_WINDOW_MS`). A wake-scheduling hint —
   *  the Engine can sleep until `commit_due_at` instead of polling.
   *  Always a number (the pool always has an `opened_at`); unlike
   *  P6's `cut_at` it is never `null`. */
  readonly commit_due_at: number;
}

/** Evaluate the input pool for a `intent_forming` session — a pure
 *  reducer over the previous `InputPoolState`.
 *
 *  Called both on message arrival (`messages_arrived ≥ 1`) and on a
 *  plain timer tick (`messages_arrived === 0`, to re-check the window
 *  cap). `messages_arrived` is the count of messages that landed since
 *  the previous call; it is coerced to a non-negative integer — a
 *  negative or fractional value is clamped / truncated, and a
 *  non-finite value (`NaN` / `Infinity`) is treated as `0`, so a
 *  malformed count can never pollute `message_count` or force a
 *  spurious commit.
 *
 *  The dual soft cap (spec line 567): the pool force-commits once it
 *  holds `INPUT_POOL_MAX_MESSAGES` messages OR has aged past
 *  `INPUT_POOL_WINDOW_MS`. This is the *forced upper bound* — a
 *  cognition component may commit the pool earlier once the intent is
 *  clear; the substrate only enforces the ceiling. With cognition
 *  disabled (the default) the cap is the sole committer.
 *
 *  `should_commit` is derived from `commit_reason` (a single source of
 *  truth — the two can never disagree). `now` is expected finite
 *  unix-ms; clock skew (`now < opened_at`) simply leaves the window
 *  cap unmet, never a false commit.
 *
 *  Pure — never throws, never mutates the input. */
export const evaluateInputPool = (
  prev: InputPoolState,
  messages_arrived: number,
  now: number,
): InputPoolEvaluation => {
  // A malformed `messages_arrived` (negative, fractional, NaN,
  // Infinity) is coerced to a safe non-negative integer — `Number.is-
  // Finite` rejects NaN/Infinity before `trunc`/`max` clamp the rest.
  const arrived = Number.isFinite(messages_arrived)
    ? Math.max(0, Math.trunc(messages_arrived))
    : 0;
  const message_count = prev.message_count + arrived;
  const commit_due_at = prev.opened_at + INPUT_POOL_WINDOW_MS;

  // count_cap wins the simultaneous case — see `commit_reason` doc.
  let commit_reason: InputPoolCommitReason | null = null;
  if (message_count >= INPUT_POOL_MAX_MESSAGES) {
    commit_reason = 'count_cap';
  } else if (now >= commit_due_at) {
    commit_reason = 'window_elapsed';
  }

  return {
    next_state: { opened_at: prev.opened_at, message_count },
    should_commit: commit_reason !== null,
    commit_reason,
    commit_due_at,
  };
};

// ────────────────────────────────────────────────────────────────
// Message routing — deterministic dispatch on the lifecycle state
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of where a newly-arrived message routes. The
 *  deterministic outer dispatch (spec lines 565-573); only `'classify'`
 *  needs a cognition component.
 *
 *  - `'append_to_pool'` — the session is `intent_forming`; the message
 *    joins the pre-commit input pool.
 *  - `'classify'`       — the session is mid-flight (`intent_committed`
 *    / `executing`); the routing classifier decides whether the
 *    message is a refinement / switch / parallel / meta. The cognition-
 *    dependent branch.
 *  - `'new_session'`    — the session has reached `intent_satisfied` /
 *    `closed`; the message opens a fresh session. */
export const MESSAGE_ROUTINGS = [
  'append_to_pool',
  'classify',
  'new_session',
] as const;

/** String-literal union derived from `MESSAGE_ROUTINGS`. */
export type MessageRouting = (typeof MESSAGE_ROUTINGS)[number];

/** Predicate — true when `value` is a known `MessageRouting`. */
export const isMessageRouting = (value: unknown): value is MessageRouting =>
  typeof value === 'string'
  && (MESSAGE_ROUTINGS as readonly string[]).includes(value);

/** The message routing per lifecycle state (spec lines 565-573).
 *  Exhaustive over `SessionLifecycleState` by the `Record` type;
 *  `assertSessionRoutingInvariants` pins the value-level coverage. */
export const MESSAGE_ROUTING_BY_STATE: Record<
  SessionLifecycleState,
  MessageRouting
> = {
  intent_forming: 'append_to_pool',
  intent_committed: 'classify',
  executing: 'classify',
  intent_satisfied: 'new_session',
  closed: 'new_session',
};

Object.freeze(MESSAGE_ROUTING_BY_STATE);

/** Resolve where a newly-arrived message routes, given the lifecycle
 *  state of the session it arrived against. A pure, total lookup over
 *  `MESSAGE_ROUTING_BY_STATE` — the `Record` is exhaustive by
 *  construction, so this never throws.
 *
 *  A `'classify'` result hands off to the cognition routing classifier
 *  (`RoutingClassifier`); the other two results are fully
 *  deterministic Engine actions. */
export const resolveMessageRouting = (
  state: SessionLifecycleState,
): MessageRouting => MESSAGE_ROUTING_BY_STATE[state];

// ────────────────────────────────────────────────────────────────
// Routing classifier — cognition stub (API only, no implementation)
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of how the routing classifier dispositions a
 *  mid-flight message relative to its in-flight session (spec line
 *  568).
 *
 *  - `'refinement'` — adjusts the in-flight intent ("also include
 *    vegetarian options"); the message merges into the active session
 *    and cognition re-plans. No structural session change.
 *  - `'switch'`     — abandons the in-flight intent ("forget that, do
 *    X instead"); the active session is cancelled and a new one opens.
 *  - `'parallel'`   — an unrelated new intent ("btw also check my
 *    inbox"); a new session opens alongside the active one, which
 *    keeps running.
 *  - `'meta'`       — not an execution input at all ("are you done
 *    yet?"); cognition answers in-chat. No structural session change. */
export const ROUTING_DISPOSITIONS = [
  'refinement',
  'switch',
  'parallel',
  'meta',
] as const;

/** String-literal union derived from `ROUTING_DISPOSITIONS`. */
export type RoutingDisposition = (typeof ROUTING_DISPOSITIONS)[number];

/** Predicate — true when `value` is a known `RoutingDisposition`. */
export const isRoutingDisposition = (
  value: unknown,
): value is RoutingDisposition =>
  typeof value === 'string'
  && (ROUTING_DISPOSITIONS as readonly string[]).includes(value);

/** Input the Engine hands the routing classifier — the message to
 *  classify plus the minimum context to place it against the in-flight
 *  session. A cognition implementation enriches this itself (the
 *  in-flight plan, recent turns) from the commit log + its K/V store;
 *  the substrate's contract is deliberately narrow.
 *
 *  - `message_text`      — the newly-arrived message to disposition.
 *  - `active_session_id` — the in-flight session the message arrived
 *    against — the candidate for refinement / switch.
 *  - `active_state`      — that session's lifecycle state. Always
 *    `'intent_committed'` or `'executing'` — the two states
 *    `resolveMessageRouting` routes to `'classify'`; a message against
 *    any other state never reaches the classifier. */
export interface RoutingClassifierInput {
  readonly message_text: string;
  readonly active_session_id: string;
  readonly active_state: 'intent_committed' | 'executing';
}

/** Output of the routing classifier — the cognition component's
 *  disposition of a mid-flight message, plus optional metadata.
 *
 *  - `disposition` — the routing call; see `RoutingDisposition`.
 *  - `confidence`  — optional classifier confidence in `[0, 1]`. Not
 *    every cognition implementation emits one.
 *  - `reasoning`   — optional short rationale for the audit trail /
 *    UI provenance. */
export interface RoutingClassification {
  readonly disposition: RoutingDisposition;
  readonly confidence?: number;
  readonly reasoning?: string;
}

/** Structural predicate — true when `value` matches `RoutingClassi-
 *  fication`. The classifier output is a cognition component's
 *  product; the Engine narrows it with this before trusting the
 *  disposition. `confidence`, when present, must be a finite number in
 *  `[0, 1]`; `reasoning`, when present, must be a string. */
export const isRoutingClassification = (
  value: unknown,
): value is RoutingClassification => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!isRoutingDisposition(v.disposition)) return false;
  if (
    v.confidence !== undefined
    && (typeof v.confidence !== 'number'
      || !Number.isFinite(v.confidence)
      || v.confidence < 0
      || v.confidence > 1)
  ) {
    return false;
  }
  if (v.reasoning !== undefined && typeof v.reasoning !== 'string') {
    return false;
  }
  return true;
};

/** The routing classifier slot — the typed contract a cognition
 *  component fills. P7 ships this *type* (the classifier API) but no
 *  implementation: there is no `classifyRouting` function in the
 *  substrate. Classifying a mid-flight message is an LLM call ("cheap
 *  fast model, ~50 tokens" — spec line 568), not deterministic Engine
 *  logic, and no cognition component runs in the default Recued
 *  runtime per the 2026-05-19 cognition downscope. The Engine invokes
 *  whatever fills this slot only when the `cognition` middleware is
 *  enabled in the D-160 registry (disabled — D-160 I-4); absent that, a
 *  `'classify'` routing has no resolver and the Engine falls back per
 *  its own policy (D-145). */
export type RoutingClassifier = (
  input: RoutingClassifierInput,
) => Promise<RoutingClassification>;

// ────────────────────────────────────────────────────────────────
// Routing effects — the deterministic consequence of a disposition
// ────────────────────────────────────────────────────────────────

/** The structural session consequence of a `RoutingDisposition`.
 *  Cognition picks the disposition; this is what the disposition then
 *  *does* to the session graph — deterministic, substrate-owned.
 *
 *  - `opens_new_session`     — a fresh session opens for the message.
 *  - `closes_active_session` — the in-flight session is cancelled
 *    (transitioned to `'closed'`).
 *
 *  `closes_active_session` implies `opens_new_session` — the only
 *  disposition that closes the active session is `'switch'`, and a
 *  switch always redirects to a new one; a bare cancel with no
 *  replacement is not a routing disposition. `assertSessionRouting-
 *  Invariants` pins this. */
export interface RoutingEffect {
  readonly opens_new_session: boolean;
  readonly closes_active_session: boolean;
}

/** The structural effect of each routing disposition (spec line 568).
 *
 *    refinement → neither — merges into the active session in place.
 *    switch     → opens + closes — cancel the root, start anew.
 *    parallel   → opens only — a new session beside the active one.
 *    meta       → neither — cognition answers in-chat, nothing moves.
 *
 *  `refinement` and `meta` share the all-`false` effect: both leave
 *  the session graph untouched. They are still distinct dispositions —
 *  cognition's *response* differs (refinement re-plans the in-flight
 *  intent; meta is a plain in-chat answer) — but that difference is
 *  cognition behaviour, not session structure, so it does not surface
 *  in `RoutingEffect`.
 *
 *  Exhaustive over `RoutingDisposition` by the `Record` type; frozen
 *  at module load. */
export const ROUTING_EFFECTS: Record<RoutingDisposition, RoutingEffect> = {
  refinement: { opens_new_session: false, closes_active_session: false },
  switch: { opens_new_session: true, closes_active_session: true },
  parallel: { opens_new_session: true, closes_active_session: false },
  meta: { opens_new_session: false, closes_active_session: false },
};

for (const effect of Object.values(ROUTING_EFFECTS)) Object.freeze(effect);
Object.freeze(ROUTING_EFFECTS);

/** The `RoutingEffect` of a disposition. A pure, total lookup over
 *  `ROUTING_EFFECTS` — the `Record` is exhaustive, so this never
 *  throws. */
export const lookupRoutingEffect = (
  disposition: RoutingDisposition,
): RoutingEffect => ROUTING_EFFECTS[disposition];

// ────────────────────────────────────────────────────────────────
// Boot-time invariant check
// ────────────────────────────────────────────────────────────────

/** Boot-time invariant check over the P7 registries. The `Record`
 *  types already guarantee one entry per state / disposition; this
 *  pins the *value-level* invariants the type system cannot.
 *
 *  Lifecycle invariants, per state:
 *    - every `LIFECYCLE_TRANSITIONS` target is a known lifecycle
 *      state;
 *    - no self-edge — a state never transitions to itself;
 *    - every edge moves strictly forward in `SESSION_LIFECYCLE_STATES`
 *      order (the monotone-forward invariant — a session never
 *      regresses);
 *    - `'closed'` is the unique terminal state — it has an empty
 *      transition set and every other state has a non-empty one;
 *    - `MESSAGE_ROUTING_BY_STATE` holds a known `MessageRouting`.
 *
 *  Routing invariants, per disposition:
 *    - `closes_active_session` implies `opens_new_session` (no bare
 *      cancel — see `RoutingEffect`).
 *
 *  Plus registry-size parity checks (the runtime analog of P6's
 *  `assertCutModelInvariants` size check — the `Record` type forbids a
 *  missing / extra key at compile time; this catches a stale
 *  hand-edit) and the input-pool constant sanity checks.
 *
 *  Runs at module load; also callable from tests. Throws on any
 *  miss. */
export const assertSessionRoutingInvariants = (): void => {
  for (const state of SESSION_LIFECYCLE_STATES) {
    const fromIndex = SESSION_LIFECYCLE_STATES.indexOf(state);
    const targets = LIFECYCLE_TRANSITIONS[state];
    for (const target of targets) {
      if (!isSessionLifecycleState(target)) {
        throw new Error(
          `D-153 P7 LIFECYCLE_TRANSITIONS['${state}'] has unknown target `
          + `'${String(target)}'.`,
        );
      }
      if (target === state) {
        throw new Error(
          `D-153 P7 LIFECYCLE_TRANSITIONS['${state}'] contains a self-edge.`,
        );
      }
      if (SESSION_LIFECYCLE_STATES.indexOf(target) <= fromIndex) {
        throw new Error(
          `D-153 P7 LIFECYCLE_TRANSITIONS['${state}'] → '${target}' is not a `
          + `forward transition — the lifecycle is monotone-forward.`,
        );
      }
    }
    const shouldBeTerminal = isTerminalLifecycleState(state);
    if (shouldBeTerminal !== (targets.length === 0)) {
      throw new Error(
        `D-153 P7 LIFECYCLE_TRANSITIONS['${state}'] breaks the terminal `
        + `invariant: isTerminalLifecycleState=${shouldBeTerminal}, `
        + `transition count=${targets.length}.`,
      );
    }
    if (!isMessageRouting(MESSAGE_ROUTING_BY_STATE[state])) {
      throw new Error(
        `D-153 P7 MESSAGE_ROUTING_BY_STATE['${state}'] is not a known `
        + `MessageRouting.`,
      );
    }
  }

  for (const disposition of ROUTING_DISPOSITIONS) {
    const effect = ROUTING_EFFECTS[disposition];
    if (effect.closes_active_session && !effect.opens_new_session) {
      throw new Error(
        `D-153 P7 ROUTING_EFFECTS['${disposition}'] closes the active `
        + `session without opening a new one — a bare cancel is not a `
        + `routing disposition.`,
      );
    }
  }

  const transitionKeys = Object.keys(LIFECYCLE_TRANSITIONS).length;
  const routingKeys = Object.keys(MESSAGE_ROUTING_BY_STATE).length;
  if (
    transitionKeys !== SESSION_LIFECYCLE_STATES.length
    || routingKeys !== SESSION_LIFECYCLE_STATES.length
  ) {
    throw new Error(
      `D-153 P7 registry size mismatch: SESSION_LIFECYCLE_STATES lists `
      + `${SESSION_LIFECYCLE_STATES.length}; LIFECYCLE_TRANSITIONS has `
      + `${transitionKeys}, MESSAGE_ROUTING_BY_STATE has ${routingKeys}.`,
    );
  }
  const effectKeys = Object.keys(ROUTING_EFFECTS).length;
  if (effectKeys !== ROUTING_DISPOSITIONS.length) {
    throw new Error(
      `D-153 P7 registry size mismatch: ROUTING_DISPOSITIONS lists `
      + `${ROUTING_DISPOSITIONS.length}; ROUTING_EFFECTS has ${effectKeys}.`,
    );
  }

  if (
    !Number.isInteger(INPUT_POOL_MAX_MESSAGES)
    || INPUT_POOL_MAX_MESSAGES <= 0
  ) {
    throw new Error(
      `D-153 P7 INPUT_POOL_MAX_MESSAGES must be a positive integer, got `
      + `${String(INPUT_POOL_MAX_MESSAGES)}.`,
    );
  }
  if (!Number.isFinite(INPUT_POOL_WINDOW_MS) || INPUT_POOL_WINDOW_MS <= 0) {
    throw new Error(
      `D-153 P7 INPUT_POOL_WINDOW_MS must be a positive finite number, got `
      + `${String(INPUT_POOL_WINDOW_MS)}.`,
    );
  }
};

// Boot-time check — fails fast if a registry drifts.
assertSessionRoutingInvariants();
