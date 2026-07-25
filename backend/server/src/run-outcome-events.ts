/** D-179 P4 — run-outcome bus events.
 *
 *  `run.completed` / `run.failed` as warehouse-bus trigger sources
 *  (spec § 8.4, fork (d)): handler dishes subscribe to outcomes
 *  generally instead of riding payload conventions. Bus emission only
 *  — no engine change; the execute handler calls `emitRunOutcome` at
 *  its terminal-outcome sites.
 *
 *  Path family (non-`data`, see `RUN_OUTCOME_PLATFORM`):
 *      run.<recipe_id>.<dish_id>.<completed|failed>
 *  so a pipeline's failure handler subscribes
 *  `run.<kickoff-recipe>.*.failed` (any dish) or pins a standing dish
 *  (`run.<recipe>.<dsh_…>.failed`). Ephemeral dish ids (`dsh:eph:…`)
 *  appear verbatim — unmatchable by literal, covered by `*`.
 *
 *  Suppressions (documented, deliberate):
 *  - `run_mode: 'backfill'` runs — the D-120 precedent (backfill
 *    cursor loops must not fan out per-iteration handler fires).
 *  - trigger-gate skips and durable approval pauses — neither is an
 *    outcome (the resumed run emits when it terminates).
 *  - the run-outcome event of a run dispatched by trigger T never
 *    re-fires T itself (`origin_trigger_id` guard in the dispatcher)
 *    — breaks the accidental direct self-loop while leaving staged
 *    chains (kickoff → handler → next) intact. */

import {
  RUN_OUTCOME_PLATFORM,
  type WarehouseEventBus,
} from '@recued/warehouse-events';

export interface RunOutcomeInput {
  recipe_id: string;
  /** Standing or ephemeral dish id — always present post-P1 (the run
   *  derives an ephemeral id when no dish is bound). */
  dish_id: string;
  /** Lifecycle run id (the paused anchor's id on resumes — one
   *  logical run, one outcome event). */
  run_id: string;
  outcome: 'completed' | 'failed';
  at: number;
  /** Engine duration; absent on pre-engine failures (policy deny). */
  duration_ms?: number;
  /** First error message on `failed`; absent on `completed`. */
  error?: string;
  /** The trigger that dispatched this run, when trigger-dispatched —
   *  the dispatcher's direct-self-loop guard key. */
  origin_trigger_id?: string;
}

/** Emit a run-outcome event. Best-effort — never throws into the
 *  response path (the bus already swallows listener errors; this
 *  guards the emit itself). */
export const emitRunOutcome = (
  bus: Pick<WarehouseEventBus, 'emit'> | undefined,
  input: RunOutcomeInput,
): void => {
  if (!bus) return;
  try {
    bus.emit({
      platform: RUN_OUTCOME_PLATFORM,
      slug: input.recipe_id,
      entity_type: input.dish_id,
      event_kind: input.outcome,
      record_id: input.run_id,
      at: input.at,
      // Outcome detail rides `record` so recipes read
      // `{{context.event.payload.record.error}}` etc. without a new
      // payload field on the trigger wire shape.
      record: {
        recipe_id: input.recipe_id,
        dish_id: input.dish_id,
        run_id: input.run_id,
        outcome: input.outcome,
        ...(input.duration_ms !== undefined ? { duration_ms: input.duration_ms } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.origin_trigger_id !== undefined
          ? { origin_trigger_id: input.origin_trigger_id }
          : {}),
      },
    });
  } catch { /* best-effort — outcome events never break the run path */ }
};

/** Pull the dispatching trigger id off the run's caller context (the
 *  event-trigger dispatcher rides `context.event.trigger_id`). */
export const originTriggerIdFromContext = (
  context: Record<string, unknown> | undefined,
): string | undefined => {
  const event = context?.event;
  if (typeof event !== 'object' || event === null) return undefined;
  const trigger_id = (event as { trigger_id?: unknown }).trigger_id;
  return typeof trigger_id === 'string' ? trigger_id : undefined;
};
