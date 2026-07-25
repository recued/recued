/** D-145 PB5 — visible multi-turn AI ↔ Recued loop discipline.
 *
 *  Per § B.6.1-§ B.6.3. Complex requests typically span multiple
 *  AI ↔ Recued tool-call rounds (AI requests context → Recued returns
 *  → AI requests action → Recued performs → ...). The substrate makes
 *  the loop *visible* in the Transparency Stream rather than
 *  collapsing to a single final result.
 *
 *  Discipline:
 *    - Per-round Transparency Stream emission (`recued.multi_turn.round_started`
 *      before each round body, `recued.multi_turn.round_completed` after).
 *    - Tier-budget-aware termination: respects `TIER_PACKET_BUDGETS[tier].max_rounds`
 *      ceiling so audit replay can attribute the round count to a
 *      deterministic engine-side cap.
 *    - Per-round body callback returns a `MultiTurnRoundOutcome` —
 *      `'continue'` keeps looping, `'completed'` exits cleanly,
 *      `'aborted'` exits via orchestrator-side abort.
 *    - Final `recued.multi_turn.loop_terminated` event carries
 *      `total_rounds` + `termination_reason` (closed list:
 *      `completed` / `max_rounds_exhausted` / `aborted`).
 *
 *  Pure-orchestration: the loop body callback is the AI ↔ Recued
 *  exchange + tool-call dispatch; the loop discipline itself is
 *  side-effect-free apart from emitting Transparency Stream events
 *  through the supplied draft. A production policy wires this loop
 *  body to the single synthesis call per round.
 *
 *  Spec: § B.6.1 + § B.6.2 + § B.6.3 + § B.6.13. */

import {
  TIER_PACKET_BUDGETS,
  defaultRedactionForKind,
  type ModelTier,
  type MultiTurnEventKind,
  type MultiTurnTerminationReason,
  type TransparencyEvent,
  type TransparencyEventEnvelope,
} from '@recued/contracts';

import type { PlanDraft } from '../orchestrator/execute-recued-request.js';

/** Outcome of a single round body — drives the loop discipline. */
export type MultiTurnRoundOutcome =
  | { readonly kind: 'continue'; readonly tool_calls_executed: number; readonly alternatives_returned: number }
  | { readonly kind: 'completed'; readonly tool_calls_executed: number; readonly alternatives_returned: number }
  | { readonly kind: 'aborted'; readonly tool_calls_executed: number; readonly alternatives_returned: number; readonly reason?: string };

/** Per-round body callback signature. The body is the AI ↔ Recued
 *  exchange (one synthesis call → tool call dispatch → primitive
 *  call results). PB5 ships the loop discipline; a production policy
 *  wires the body to the synthesis composer. */
export type MultiTurnRoundBody = (round_index: number) => Promise<MultiTurnRoundOutcome>;

export interface RunMultiTurnLoopInput {
  readonly tier: ModelTier;
  readonly body: MultiTurnRoundBody;
  /** Required when caller wants Transparency Stream emission. The
   *  loop discipline routes every event through the draft so audit
   *  replay reconstructs exactly what the user saw. Tests often pass
   *  a stub draft to capture events. */
  readonly draft?: PlanDraft;
  /** Optional override for the per-tier `max_rounds` ceiling. Caller
   *  (Standing Instruction `max_rounds` clamp / pack-installed
   *  recipe-level override) supplies a tighter ceiling; the loop
   *  enforces `min(tier_default, override)`. NEVER raises beyond the
   *  tier default — that's a substrate floor / ceiling distinction
   *  the orchestrator owns. */
  readonly max_rounds_override?: number;
}

export interface RunMultiTurnLoopResult {
  readonly total_rounds: number;
  readonly termination_reason: MultiTurnTerminationReason;
  readonly emitted_event_count: number;
}

/** Closed-list event-kind constants. Aliased from contracts so the
 *  engine-side composer + tests can pin exact strings. */
export const MULTI_TURN_ROUND_STARTED_KIND: MultiTurnEventKind =
  'recued.multi_turn.round_started';
export const MULTI_TURN_ROUND_COMPLETED_KIND: MultiTurnEventKind =
  'recued.multi_turn.round_completed';
export const MULTI_TURN_LOOP_TERMINATED_KIND: MultiTurnEventKind =
  'recued.multi_turn.loop_terminated';

/** PB7 wire-envelope helper — wrap a closed `TransparencyEvent` into
 *  the PB7 `{ event, redaction, emitted_at }` shape. The redaction
 *  tier resolves from the per-kind default (`defaultRedactionForKind`)
 *  so PB5 emitters never have to know about the visibility policy.
 *  Settings filtering happens upstream in the composer when the
 *  envelope flows through `composeTransparencyEvent`; here we just
 *  build the canonical wire shape. */
const wrapAsEnvelope = (event: TransparencyEvent): TransparencyEventEnvelope => ({
  event,
  redaction: defaultRedactionForKind(event.kind),
  emitted_at: Date.now(),
});

/** Build a `recued.multi_turn.round_started` Transparency Stream
 *  envelope. Caller routes through `draft.recordTransparencyEvent`. */
export const buildMultiTurnRoundStartedEvent = (args: {
  round_index: number;
  expected_max_rounds: number;
  tier: ModelTier;
}): TransparencyEventEnvelope =>
  wrapAsEnvelope({
    kind: MULTI_TURN_ROUND_STARTED_KIND,
    round_index: args.round_index,
    expected_max_rounds: args.expected_max_rounds,
    tier: args.tier,
  });

/** Build a `recued.multi_turn.round_completed` Transparency Stream
 *  envelope. Counts only — never includes user content.
 *
 *  Codex P2 #1 fold (§ B.6.2 audit truthfulness): when counts are
 *  unknown (typically the body-throw path in `runMultiTurnLoop` —
 *  the body may have done partial work before throwing, but the
 *  loop has no signal for how much), pass `tool_calls_executed:
 *  undefined` + `alternatives_returned: undefined` to OMIT them
 *  from the payload entirely. The audit reader then renders
 *  "unknown" rather than "0" — distinguishing genuine zero-work
 *  rounds from rounds where the count is unrecoverable. */
export const buildMultiTurnRoundCompletedEvent = (args: {
  round_index: number;
  tool_calls_executed?: number;
  alternatives_returned?: number;
  outcome: 'continue' | 'completed' | 'aborted';
}): TransparencyEventEnvelope =>
  wrapAsEnvelope({
    kind: MULTI_TURN_ROUND_COMPLETED_KIND,
    round_index: args.round_index,
    outcome: args.outcome,
    ...(args.tool_calls_executed !== undefined
      ? { tool_calls_executed: args.tool_calls_executed }
      : {}),
    ...(args.alternatives_returned !== undefined
      ? { alternatives_returned: args.alternatives_returned }
      : {}),
  });

/** Build a `recued.multi_turn.loop_terminated` Transparency Stream
 *  envelope. Carries closed-list `termination_reason`. */
export const buildMultiTurnLoopTerminatedEvent = (args: {
  total_rounds: number;
  termination_reason: MultiTurnTerminationReason;
}): TransparencyEventEnvelope =>
  wrapAsEnvelope({
    kind: MULTI_TURN_LOOP_TERMINATED_KIND,
    total_rounds: args.total_rounds,
    termination_reason: args.termination_reason,
  });

/** Resolve the effective per-loop max-rounds ceiling.
 *
 *  Substrate floor: 1 (always at least one round attempted).
 *  Substrate ceiling: tier default per `TIER_PACKET_BUDGETS`.
 *  Caller override: when supplied + finite + ≥ 1, takes
 *  `min(tier_default, override)`. */
export const resolveMaxRounds = (
  tier: ModelTier,
  override?: number,
): number => {
  const tierMax = TIER_PACKET_BUDGETS[tier].max_rounds;
  if (override === undefined) return tierMax;
  if (!Number.isFinite(override) || override < 1) return tierMax;
  return Math.min(tierMax, Math.floor(override));
};

/** § B.6.1-§ B.6.3 — visible multi-turn loop discipline. Returns
 *  `total_rounds` + `termination_reason` so the orchestrator policy
 *  can stamp the right `PlanStatus` (continue → ok, max_rounds_exhausted
 *  → policy-decided halt with `failure_class: 'cost'` once PB15 lands,
 *  aborted → policy-decided halt with the round-body's reason).
 *
 *  Defensive against:
 *    - Body throws: the loop emits a `loop_terminated` with reason
 *      `aborted` BEFORE re-throwing so the audit trail captures
 *      the partial state.
 *    - Body never returns `completed` / `aborted`: the loop
 *      terminates at `max_rounds` and emits `max_rounds_exhausted`.
 *
 *  PB5 doesn't decide the failure class — that's PB15's job. The
 *  loop's contract is "visible discipline + closed-list termination
 *  reason"; the orchestrator widens. */
export const runMultiTurnLoop = async (
  input: RunMultiTurnLoopInput,
): Promise<RunMultiTurnLoopResult> => {
  const max_rounds = resolveMaxRounds(input.tier, input.max_rounds_override);
  let emitted = 0;

  const emit = (event: TransparencyEventEnvelope): void => {
    if (input.draft) {
      input.draft.recordTransparencyEvent(event);
      emitted += 1;
    }
  };

  let total_rounds = 0;
  let termination_reason: MultiTurnTerminationReason = 'max_rounds_exhausted';

  for (let round_index = 0; round_index < max_rounds; round_index++) {
    emit(
      buildMultiTurnRoundStartedEvent({
        round_index,
        expected_max_rounds: max_rounds,
        tier: input.tier,
      }),
    );
    let outcome: MultiTurnRoundOutcome;
    try {
      outcome = await input.body(round_index);
    } catch (e) {
      // Body throw → loop_terminated with aborted reason. Codex P2 #1
      // fold (§ B.6.2 audit truthfulness): emit the round_completed
      // event with counts OMITTED so audit reader sees "unknown" not
      // "0" — the body may have done partial work before throwing
      // (multiple tool calls actuated before the failure point) and
      // hard-coding 0 would silently under-report the partial round.
      emit(
        buildMultiTurnRoundCompletedEvent({
          round_index,
          outcome: 'aborted',
        }),
      );
      total_rounds = round_index + 1;
      termination_reason = 'aborted';
      emit(
        buildMultiTurnLoopTerminatedEvent({
          total_rounds,
          termination_reason,
        }),
      );
      // Re-throw — orchestrator catches and stamps the right
      // PlanStatus (PB15 widens). PB5 alone surfaces the throw.
      throw e;
    }
    emit(
      buildMultiTurnRoundCompletedEvent({
        round_index,
        tool_calls_executed: outcome.tool_calls_executed,
        alternatives_returned: outcome.alternatives_returned,
        outcome: outcome.kind,
      }),
    );
    total_rounds = round_index + 1;
    if (outcome.kind === 'completed') {
      termination_reason = 'completed';
      break;
    }
    if (outcome.kind === 'aborted') {
      termination_reason = 'aborted';
      break;
    }
    // outcome.kind === 'continue' — loop iterates.
  }

  emit(
    buildMultiTurnLoopTerminatedEvent({
      total_rounds,
      termination_reason,
    }),
  );

  return { total_rounds, termination_reason, emitted_event_count: emitted };
};
