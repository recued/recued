/** D-153 P6 — Cut models per channel.
 *
 *  D-153's three-tier session IDs (channel / cognition / correlation)
 *  name the windows execution happens inside; P5 named the *links*
 *  between sessions; P6 names when a session *closes*.
 *
 *  "When does an open session close?" has three answers — different
 *  channels delegate the decision to different authorities:
 *
 *    - **debounce** — the session closes after the work tree has been
 *      quiescent for a per-channel threshold D. Active-tree-aware: the
 *      countdown starts when the *tree* goes quiet (no child running,
 *      no LLM call pending, no approval open, no work scheduled within
 *      the window), NOT when the user stops typing. A task that runs
 *      five minutes keeps the tree active for five minutes; the
 *      debounce only begins once it finishes.
 *    - **plan-completion** — the session closes once its plan is fully
 *      dispatched and the work tree is quiescent — every planned unit
 *      has run. A webhook / cron / reactive / housekeeping run has a
 *      definite plan; when it drains the session is done. No debounce
 *      timer — the cut fires the instant the plan settles.
 *    - **cognition-driven** — the cognition component signals
 *      intent-satisfied and the Engine closes the session. The
 *      decision is the cognition component's; the substrate provides
 *      no evaluator for it (see the cognition note below).
 *
 *  **Cognition-driven is a typed stub.** Per the 2026-05-19 cognition
 *  downscope (internal benchmarks Path B Stage 4 verdict; cognition is a
 *  pluggable component, DEFAULT DISABLED) no cognition component runs
 *  in the default Recued runtime. `'cognition_driven'` is a member of
 *  `CutAuthority` and `resolveCutAuthority` returns it for a
 *  cognition-eligible channel *when a cognition component is in the
 *  loop* — but the substrate ships no `evaluateCognitionCut`: that cut
 *  fires on the cognition component's intent-satisfied signal, which
 *  is not deterministic Engine logic. While cognition is disabled (the
 *  default) `resolveCutAuthority` always returns a channel's
 *  cognition-independent `base_authority`, and every channel's cut is
 *  decided by `evaluateDebounceCut` / `evaluatePlanCompletionCut`. The
 *  debounce threshold doubles as the safety-net backstop for a
 *  cognition-driven channel — if cognition never signals, the session
 *  still closes on quiescence (spec line 545: chat is "session-end
 *  primary", debounce secondary).
 *
 *  **`derived_from_session_id` — the async-child link.** A session can
 *  schedule work. Work due *within* the debounce window is a
 *  synchronous child — it keeps the session active until it runs. Work
 *  due *beyond* the window is asynchronous — the session would have
 *  closed long before it fires, so the Engine spins it off as an
 *  independent session carrying `derived_from_session_id` back to its
 *  parent, and the parent closes cleanly. `classifyChildScheduling`
 *  draws that line; `isDerivedSession` is the predicate over the link.
 *  This is a sibling of P5's `predecessor_session_id`: predecessor
 *  links a *continuation* (B continues A's topic); derived-from links
 *  a *spin-off* (C is independent async work A scheduled).
 *
 *  P6 ships substrate-only — the closed lists, the per-channel
 *  registry, the pure cut evaluators, the scheduling classifier, and
 *  the derived-session predicate land here. Deferred to D-145 (Engine
 *  substrate):
 *
 *    - **Session lifecycle.** *When* the Engine calls these evaluators
 *      — on a tick, on a tree-state change — plus where the
 *      `DebounceTrackerState` is persisted (the session row) and how a
 *      cut transitions the session to `'closed'`, is Engine work. The
 *      substrate is a set of pure functions the lifecycle drives.
 *    - **The async-child spawn.** Minting the derived session's id +
 *      writing `derived_from_session_id` is the Engine's session
 *      lifecycle; `classifyChildScheduling` only draws the sync /
 *      async line.
 *    - **The cognition cut.** See the cognition note above.
 *
 *  Cognition-independent (modulo the typed `'cognition_driven'` stub).
 *  Matches the P1 / P2 / P3 / P5 / P8 substrate-first pattern.
 *
 *  No tests in this file per the test-after-review workflow; tests
 *  land in a separate post-review step.
 *
 *  Spec: D-153 § Cut models — three modes (lines
 *  535-551). */

import { CHANNELS } from './commits.js';
import type { Channel } from './commits.js';

// ────────────────────────────────────────────────────────────────
// CutAuthority — which authority decides a channel's session close
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of cut authorities — the three answers to "when
 *  does an open session close?".
 *
 *  - `'debounce'`         — close after the work tree is quiescent for
 *    the channel's debounce threshold D. The active-tree-aware quiet
 *    timer; see `evaluateDebounceCut`.
 *  - `'plan_completion'`  — close once the plan is fully dispatched
 *    and the work tree is quiescent; see `evaluatePlanCompletionCut`.
 *    No debounce timer. The authority for the four system channels
 *    (webhook / schedule / reactive / housekeeping).
 *  - `'cognition_driven'` — close on the cognition component's
 *    intent-satisfied signal. The substrate ships no evaluator — the
 *    decision is cognition's. `resolveCutAuthority` returns this only
 *    for a cognition-eligible channel with a cognition component in
 *    the loop; default-disabled per the 2026-05-19 downscope. */
export const CUT_AUTHORITIES = [
  'debounce',
  'plan_completion',
  'cognition_driven',
] as const;

/** String-literal union derived from `CUT_AUTHORITIES`. */
export type CutAuthority = (typeof CUT_AUTHORITIES)[number];

/** Predicate — true when `value` is a known `CutAuthority`. */
export const isCutAuthority = (value: unknown): value is CutAuthority =>
  typeof value === 'string'
  && (CUT_AUTHORITIES as readonly string[]).includes(value);

// ────────────────────────────────────────────────────────────────
// Per-channel debounce thresholds — the registry is the public surface
// ────────────────────────────────────────────────────────────────

/** One minute in milliseconds — the unit the spec states D-thresholds
 *  in. */
const MINUTE_MS = 60_000;

/** Debounce D-thresholds per spec line 545 ("messenger 30 min, chat 30
 *  min, MCP 15 min, reception 5 min, user 10 min"). Module-private —
 *  `CHANNEL_CUT_MODELS` is the surface; read a channel's D from its
 *  model's `debounce_threshold_ms`. */
const DEBOUNCE_USER_MS = 10 * MINUTE_MS;
const DEBOUNCE_CHAT_MS = 30 * MINUTE_MS;
const DEBOUNCE_MCP_MS = 15 * MINUTE_MS;
const DEBOUNCE_MESSENGER_MS = 30 * MINUTE_MS;
const DEBOUNCE_RECEPTION_MS = 5 * MINUTE_MS;

// ────────────────────────────────────────────────────────────────
// ChannelCutModel — the per-channel cut model
// ────────────────────────────────────────────────────────────────

/** The cut model for one channel. Channel-keyed, not (channel × actor)-
 *  keyed: the actor refines *policy* (D-153 P2) but not *when a session
 *  closes* — `(chat, user_self)` and `(chat, contracted_user)` share
 *  the chat cut model.
 *
 *  Fields:
 *    - `channel` — the channel this model governs; equals its
 *      `CHANNEL_CUT_MODELS` key (`assertCutModelInvariants` pins this).
 *    - `base_authority` — the cognition-independent cut authority: the
 *      authority in force when no cognition component is in the loop
 *      (the default per the 2026-05-19 downscope). Never
 *      `'cognition_driven'` — that is only ever a *resolved* authority
 *      (`resolveCutAuthority`), never a baseline.
 *    - `cognition_eligible` — true when a cognition component, plugged
 *      into this channel's policy cell, upgrades the resolved authority
 *      to `'cognition_driven'`. True for `chat` + `messenger` (the
 *      conversational channels); false everywhere else.
 *    - `debounce_threshold_ms` — the quiescence window D. Non-null iff
 *      `base_authority === 'debounce'` (every non-system channel); null
 *      for the four plan-completion channels. For a cognition-eligible
 *      channel the threshold still applies as the *backstop* — if the
 *      cognition component never signals intent-satisfied, the session
 *      still closes on quiescence. */
export interface ChannelCutModel {
  readonly channel: Channel;
  readonly base_authority: CutAuthority;
  readonly cognition_eligible: boolean;
  readonly debounce_threshold_ms: number | null;
}

/** The per-channel cut-model registry. Exhaustive over `Channel` by
 *  construction — the `Record<Channel, …>` type makes a missing
 *  channel a compile error; `assertCutModelInvariants` additionally
 *  pins the value-level invariants at module load.
 *
 *  Per spec § Cut models — three modes (lines 537-545):
 *    - the 5 non-system channels are `debounce` with a per-channel D;
 *      `chat` + `messenger` are additionally `cognition_eligible`;
 *    - the 4 system channels are `plan_completion`, no threshold.
 *
 *  Frozen at module load. Extension requires a new `Channel` value
 *  (decisions-log-worthy per the closed-list extension protocol) plus
 *  a row here. */
export const CHANNEL_CUT_MODELS: Record<Channel, ChannelCutModel> = {
  // The user driving their own client directly (webclient HID). Debounce
  // close after 10 min idle; not a cognition surface.
  user: {
    channel: 'user',
    base_authority: 'debounce',
    cognition_eligible: false,
    debounce_threshold_ms: DEBOUNCE_USER_MS,
  },
  // AI Chat. Cognition-eligible — when a cognition component is in the
  // loop the cut is cognition-driven (session-end primary) and the
  // 30-min debounce is the backstop.
  chat: {
    channel: 'chat',
    base_authority: 'debounce',
    cognition_eligible: true,
    debounce_threshold_ms: DEBOUNCE_CHAT_MS,
  },
  // External AI agent over the MCP surface. The agent IS the cognition;
  // Recued runs none for it — pure debounce, 15 min.
  mcp: {
    channel: 'mcp',
    base_authority: 'debounce',
    cognition_eligible: false,
    debounce_threshold_ms: DEBOUNCE_MCP_MS,
  },
  // User via a connected messenger (Slack / Telegram / …). Cognition-eligible
  // like `chat`; raw messenger (no cognition) debounces at 30 min.
  messenger: {
    channel: 'messenger',
    base_authority: 'debounce',
    cognition_eligible: true,
    debounce_threshold_ms: DEBOUNCE_MESSENGER_MS,
  },
  // Public reception surface. Tightest debounce window — 5 min — for an
  // untrusted-public ingress; not a cognition surface.
  reception: {
    channel: 'reception',
    base_authority: 'debounce',
    cognition_eligible: false,
    debounce_threshold_ms: DEBOUNCE_RECEPTION_MS,
  },
  // Vendor webhook ingestion — a definite plan; closes when its work
  // drains.
  webhook: {
    channel: 'webhook',
    base_authority: 'plan_completion',
    cognition_eligible: false,
    debounce_threshold_ms: null,
  },
  // Cron-driven recipe execution — closes on plan completion.
  schedule: {
    channel: 'schedule',
    base_authority: 'plan_completion',
    cognition_eligible: false,
    debounce_threshold_ms: null,
  },
  // Reactive-trigger-driven recipe execution — closes on plan completion.
  reactive: {
    channel: 'reactive',
    base_authority: 'plan_completion',
    cognition_eligible: false,
    debounce_threshold_ms: null,
  },
  // Idle-driven maintenance — closes on plan completion.
  housekeeping: {
    channel: 'housekeeping',
    base_authority: 'plan_completion',
    cognition_eligible: false,
    debounce_threshold_ms: null,
  },
};

// Freeze each model + the registry — downstream consumers never receive
// a mutable handle.
for (const model of Object.values(CHANNEL_CUT_MODELS)) Object.freeze(model);
Object.freeze(CHANNEL_CUT_MODELS);

/** The `ChannelCutModel` for a channel. Total over `Channel` — the
 *  registry is exhaustive by construction (`Record<Channel, …>`), so
 *  unlike D-153 P2's `lookupPolicy` this never throws. */
export const lookupCutModel = (channel: Channel): ChannelCutModel =>
  CHANNEL_CUT_MODELS[channel];

/** Resolve the cut authority in force for a channel right now.
 *
 *  Returns `'cognition_driven'` iff the channel is `cognition_eligible`
 *  AND a cognition component is in the loop for it (`cognition_in_loop`
 *  true). Otherwise returns the channel's cognition-independent
 *  `base_authority`.
 *
 *  `cognition_in_loop` defaults to `false` — the default Recued runtime
 *  per the 2026-05-19 cognition downscope (no cognition component
 *  runs). With the default this function always returns
 *  `base_authority`, so every channel's cut is decided by
 *  `evaluateDebounceCut` / `evaluatePlanCompletionCut`. The Engine
 *  passes `true` only when the `cognition` middleware is enabled in the
 *  D-160 middleware registry (it ships disabled — D-160 I-4). */
export const resolveCutAuthority = (
  channel: Channel,
  cognition_in_loop = false,
): CutAuthority => {
  const model = CHANNEL_CUT_MODELS[channel];
  if (model.cognition_eligible && cognition_in_loop) {
    return 'cognition_driven';
  }
  return model.base_authority;
};

/** Boot-time invariant check over `CHANNEL_CUT_MODELS`. The
 *  `Record<Channel, …>` type already guarantees one entry per channel;
 *  this pins the *value-level* invariants the type cannot — and re-runs
 *  the channel walk so a `CHANNELS` / registry divergence still throws.
 *
 *  Invariants, per channel:
 *    - the entry's `channel` field equals its registry key;
 *    - `base_authority` is never `'cognition_driven'` (a baseline is
 *      always cognition-independent; cognition-driven is only ever
 *      resolved, never stored);
 *    - the threshold invariant — `debounce_threshold_ms` is a positive
 *      finite number iff `base_authority === 'debounce'`, and `null`
 *      iff `base_authority === 'plan_completion'`;
 *    - a `cognition_eligible` channel is a `'debounce'` channel — the
 *      threshold is its cognition backstop, and a plan-completion
 *      channel has no debounce backstop to be eligible for.
 *
 *  And once over the whole registry — the runtime analog of
 *  policy-matrix.ts's `assertPolicyMatrixCoversAllExecutionSources`
 *  size check: `CHANNEL_CUT_MODELS` has exactly `CHANNELS.length`
 *  entries. The `Record<Channel, …>` type already forbids a missing or
 *  extra key at compile time; the runtime check pins it for a stale
 *  hand-edit.
 *
 *  Runs at module load; also callable from tests. Throws on any miss. */
export const assertCutModelInvariants = (): void => {
  for (const channel of CHANNELS) {
    const model = CHANNEL_CUT_MODELS[channel];
    if (model.channel !== channel) {
      throw new Error(
        `D-153 P6 cut-model for '${channel}' has a mismatched channel field '${model.channel}'.`,
      );
    }
    if (model.base_authority === 'cognition_driven') {
      throw new Error(
        `D-153 P6 cut-model for '${channel}': base_authority must be cognition-independent, got 'cognition_driven'.`,
      );
    }
    const isDebounce = model.base_authority === 'debounce';
    const threshold = model.debounce_threshold_ms;
    const hasThreshold =
      typeof threshold === 'number'
      && Number.isFinite(threshold)
      && threshold > 0;
    if (isDebounce !== hasThreshold) {
      throw new Error(
        `D-153 P6 cut-model for '${channel}' breaks the threshold invariant: `
        + `base_authority='${model.base_authority}', `
        + `debounce_threshold_ms=${String(threshold)}.`,
      );
    }
    if (model.cognition_eligible && !isDebounce) {
      throw new Error(
        `D-153 P6 cut-model for '${channel}' is cognition_eligible but `
        + `base_authority is not 'debounce'.`,
      );
    }
  }
  const registrySize = Object.keys(CHANNEL_CUT_MODELS).length;
  if (registrySize !== CHANNELS.length) {
    throw new Error(
      `D-153 P6 cut-model registry size mismatch: CHANNEL_CUT_MODELS has `
      + `${registrySize} entries; CHANNELS lists ${CHANNELS.length}.`,
    );
  }
};

// Boot-time check — fails fast if the registry drifts.
assertCutModelInvariants();

// ────────────────────────────────────────────────────────────────
// ActiveTreeState — the work-tree activity snapshot
// ────────────────────────────────────────────────────────────────

/** A snapshot of a session's work tree — what the cut evaluators read
 *  to decide whether the tree is busy. The Engine builds this from its
 *  live execution state each time it evaluates a cut. Every counter is
 *  a non-negative integer.
 *
 *  Per spec line 547 ("children running, LLM pending, approvals open,
 *  scheduled-soon work counts as active"):
 *    - `running_children`        — child commits / tasks in flight.
 *    - `pending_llm`             — LLM / cognition calls awaiting a
 *      response.
 *    - `open_approvals`          — approval prompts awaiting a user
 *      decision.
 *    - `scheduled_within_window` — work scheduled to fire *within* the
 *      channel's debounce window (synchronous children — see
 *      `classifyChildScheduling`). Work scheduled beyond the window is
 *      asynchronous and has already been spun off as a derived session,
 *      so it never appears here. */
export interface ActiveTreeState {
  readonly running_children: number;
  readonly pending_llm: number;
  readonly open_approvals: number;
  readonly scheduled_within_window: number;
}

/** True when *any* part of the work tree is active — a child running,
 *  an LLM call pending, an approval open, or synchronous scheduled work
 *  within the window.
 *
 *  Uses `!== 0` (not `> 0`) so a malformed negative counter is treated
 *  as active — fail-safe: a corrupt snapshot keeps the session open
 *  rather than cutting it early. The counters are non-negative integers
 *  by contract; this only governs the degenerate case. */
export const isTreeActive = (tree: ActiveTreeState): boolean =>
  tree.running_children !== 0
  || tree.pending_llm !== 0
  || tree.open_approvals !== 0
  || tree.scheduled_within_window !== 0;

/** True when the work tree is fully quiescent — the complement of
 *  `isTreeActive`. The debounce countdown starts the instant this
 *  becomes true (spec line 547: "timer starts when the tree is
 *  quiescent"). */
export const isTreeQuiescent = (tree: ActiveTreeState): boolean =>
  !isTreeActive(tree);

// ────────────────────────────────────────────────────────────────
// Debounce cut — active-tree-aware quiescence timer
// ────────────────────────────────────────────────────────────────

/** The per-session debounce state the Engine persists between cut
 *  evaluations. One field: `quiescent_since`, the unix-ms instant the
 *  work tree last became quiescent, or `null` while the tree is active.
 *  The Engine stores this on the session row and feeds the previous
 *  value back into the next `evaluateDebounceCut` call. */
export interface DebounceTrackerState {
  readonly quiescent_since: number | null;
}

/** The debounce state of a freshly-opened session — the tree is active
 *  (a session opens because work arrived), so no countdown is running.
 *  The Engine initializes a new session's debounce state to this. */
export const FRESH_DEBOUNCE_STATE: DebounceTrackerState = Object.freeze({
  quiescent_since: null,
});

/** The result of one `evaluateDebounceCut` evaluation. */
export interface DebounceCutEvaluation {
  /** The debounce state to persist for the next evaluation. */
  readonly next_state: DebounceTrackerState;
  /** True when the session should close now — the tree has been
   *  quiescent for at least the debounce threshold. */
  readonly should_cut: boolean;
  /** The unix-ms instant the cut becomes due
   *  (`quiescent_since + threshold`), or `null` while the tree is
   *  active and no countdown is running. A wake-scheduling hint for the
   *  Engine — it can sleep until `cut_at` instead of polling. When
   *  `should_cut` is true `cut_at` is at or before `now`. */
  readonly cut_at: number | null;
}

/** Evaluate the debounce cut for a session — a pure reducer over the
 *  previous `DebounceTrackerState`.
 *
 *  The countdown is *active-tree-aware* (spec line 547): it does not
 *  track when the user went quiet, it tracks when the work *tree* went
 *  quiet. "Suggest dinner" finishes in 30s → tree quiescent → the
 *  window opens → cut at idle+D. "Book dentist" runs 5+ minutes (API
 *  waits, approvals) → tree active throughout → the window never opens
 *  until the task is done.
 *
 *  Transition:
 *    - tree active → `quiescent_since` resets to `null`; no cut.
 *    - tree quiescent, was active → stamp `quiescent_since = now`.
 *    - tree quiescent, was already quiescent → keep the earlier stamp.
 *  The cut fires once `now - quiescent_since >= threshold`.
 *
 *  Also serves as the cognition-driven *backstop*: for a
 *  `'cognition_driven'` channel the Engine still runs this with the
 *  channel's threshold, so a session closes even if the cognition
 *  component never signals intent-satisfied.
 *
 *  `debounce_threshold_ms` is the channel's D
 *  (`ChannelCutModel.debounce_threshold_ms`); a negative threshold is
 *  clamped to 0 (cut as soon as the tree is quiescent). `now` is
 *  expected to be a finite unix-ms value, monotonic across calls for
 *  one session.
 *
 *  Pure — never throws, never mutates the input. */
export const evaluateDebounceCut = (
  prev: DebounceTrackerState,
  tree: ActiveTreeState,
  debounce_threshold_ms: number,
  now: number,
): DebounceCutEvaluation => {
  if (isTreeActive(tree)) {
    return {
      next_state: { quiescent_since: null },
      should_cut: false,
      cut_at: null,
    };
  }
  // Newly quiescent → stamp now; already quiescent → keep the stamp.
  // `??` only substitutes for null/undefined, so a `quiescent_since` of
  // 0 (a valid instant) is preserved.
  const quiescent_since = prev.quiescent_since ?? now;
  const cut_at = quiescent_since + Math.max(0, debounce_threshold_ms);
  return {
    next_state: { quiescent_since },
    should_cut: now >= cut_at,
    cut_at,
  };
};

// ────────────────────────────────────────────────────────────────
// Plan-completion cut — close when planned work drains
// ────────────────────────────────────────────────────────────────

/** Evaluate the plan-completion cut — the authority for the four
 *  event-fire channels (webhook / schedule / reactive / housekeeping).
 *
 *  Returns `true` (close the session) iff the session's plan has been
 *  fully dispatched AND the work tree is quiescent — every planned unit
 *  has run and nothing is in flight. A system run has a definite plan;
 *  when that plan's work drains the session is done. There is no
 *  debounce timer — the cut fires the instant both conditions hold.
 *
 *  `plan_dispatched` is the Engine's signal that it has emitted every
 *  unit of the session's planned work — the recipe walk is complete (or
 *  has halted) and no further top-level step will be dispatched. It is
 *  load-bearing: a snapshot of an empty tree is otherwise ambiguous
 *  between "the plan finished" and "the plan has not started, or is
 *  between two steps" — both have zero in-flight work. While
 *  `plan_dispatched` is `false` the cut never fires, however quiet the
 *  tree.
 *
 *  Quiescence is the full `isTreeQuiescent` check, including
 *  `scheduled_within_window`. A plan-completion session has no debounce
 *  window, so in practice any scheduled work was classified
 *  asynchronous and spun off as a derived session
 *  (`derived_from_session_id`), leaving `scheduled_within_window` at 0;
 *  consulting it anyway keeps the cut correct if a caller has not yet
 *  performed that spin-off.
 *
 *  Stateless — unlike `evaluateDebounceCut` there is no countdown to
 *  track, so this returns a bare boolean.
 *
 *  Pure — never throws. */
export const evaluatePlanCompletionCut = (
  tree: ActiveTreeState,
  plan_dispatched: boolean,
): boolean => plan_dispatched && isTreeQuiescent(tree);

// ────────────────────────────────────────────────────────────────
// Scheduling classification — synchronous vs asynchronous children
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of how a scheduled child relates to its parent
 *  session's lifetime.
 *
 *  - `'synchronous'`  — the child is due within the parent's debounce
 *    window. The parent will still be open when it runs, so the child
 *    keeps the parent's tree active until then.
 *  - `'asynchronous'` — the child is due beyond the window. The parent
 *    would close long before it fires, so the Engine spins the child
 *    off as an independent session carrying `derived_from_session_id`
 *    back to the parent, and the parent closes cleanly. */
export const SCHEDULING_CLASSES = ['synchronous', 'asynchronous'] as const;

/** String-literal union derived from `SCHEDULING_CLASSES`. */
export type SchedulingClass = (typeof SCHEDULING_CLASSES)[number];

/** Predicate — true when `value` is a known `SchedulingClass`. */
export const isSchedulingClass = (value: unknown): value is SchedulingClass =>
  typeof value === 'string'
  && (SCHEDULING_CLASSES as readonly string[]).includes(value);

/** Classify a scheduled child by when it is due relative to its
 *  parent's debounce window (spec lines 549-551).
 *
 *  A child due no later than `reference_at + debounce_threshold_ms` is
 *  `'synchronous'` — it lands inside the window the parent would still
 *  be open for. A child due after that is `'asynchronous'`. An
 *  already-overdue child (`child_due_at <= reference_at`) is always
 *  `'synchronous'` — it is effectively due now.
 *
 *  `reference_at` is the instant the window is measured from — the
 *  point the parent's tree would otherwise begin its debounce
 *  countdown. `debounce_threshold_ms` is the parent channel's D; a
 *  negative value is clamped to 0, so passing 0 (a plan-completion
 *  parent has no window) classifies every strictly-future child as
 *  `'asynchronous'`.
 *
 *  Pure — never throws. */
export const classifyChildScheduling = (
  child_due_at: number,
  reference_at: number,
  debounce_threshold_ms: number,
): SchedulingClass => {
  const window_end = reference_at + Math.max(0, debounce_threshold_ms);
  return child_due_at <= window_end ? 'synchronous' : 'asynchronous';
};

// ────────────────────────────────────────────────────────────────
// Derived sessions — the async-child link
// ────────────────────────────────────────────────────────────────

/** True when a session row is a *derived* session — it carries a
 *  non-empty `derived_from_session_id` naming the parent session that
 *  spun it off as asynchronous work (`classifyChildScheduling` →
 *  `'asynchronous'`).
 *
 *  `derived_from_session_id` is a sibling of P5's
 *  `predecessor_session_id`, and the two are deliberately distinct
 *  edges:
 *    - `predecessor_session_id` — a *continuation*: the new session
 *      continues a prior session's topic (swap / transfer / pick-up).
 *    - `derived_from_session_id` — a *spin-off*: the new session is
 *      independent async work a parent scheduled beyond its debounce
 *      window, letting the parent close cleanly.
 *  A session can carry either edge, both, or neither.
 *
 *  Mirrors P3's `isCompensatingCommit` — a loose row shape, the
 *  predicate is the only primitive, no separate flag. The session row
 *  itself is the Engine's (D-145); the substrate just reads the
 *  field. */
export const isDerivedSession = (
  row: { derived_from_session_id?: string | null },
): boolean =>
  typeof row.derived_from_session_id === 'string'
  && row.derived_from_session_id.length > 0;
