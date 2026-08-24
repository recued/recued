/** D-250 § D — attribute housekeeping provider spend to the TASK that spent it.
 *
 *  ⛔ WHY HOUSEKEEPING NEEDED ITS OWN. The recipe engine's usage lands on the run
 *  anchor and the gateway's on the seller rollup; housekeeping had neither, and
 *  its apparent backstop is not one — `housekeeping_state.tokens_consumed_today_*`
 *  is `estimate_per_record_tokens()` x pending rows, a BUDGET ESTIMATE the
 *  planner uses to decide whether to start a cycle. So the one execution mode
 *  designed to run unattended was the one whose real cost nothing recorded.
 *
 *  🔑 A CURRENT-TASK MARKER IS SOUND HERE AND WAS REJECTED FOR RECIPE STEPS —
 *  same idea, opposite verdict, and the difference is concurrency. The recipe
 *  engine runs prefetch steps in PARALLEL (`prefetch.ts`), so "which step is in
 *  flight" has no single answer and per-step attribution via a callback would
 *  silently mis-bill; run scope is the only correct grain there. The scheduler's
 *  task loop is a plain `for (…) { await runTaskStep(…) }` — strictly
 *  sequential, one task in flight at a time — so the marker is exact.
 *  ⚠ IF THAT LOOP EVER GAINS CONCURRENCY, THIS BECOMES WRONG SILENTLY: the
 *  numbers stay plausible and land on the wrong task. Whoever parallelises it
 *  owns this file.
 *
 *  ⚠ NO CAP AND NO PERSISTENCE, deliberately. One entry exists at a time and it
 *  is taken at the end of the task that opened it, so there is nothing to
 *  accumulate; the durable record is the `housekeeping_cycle` audit row the
 *  scheduler already writes.
 */

import { aggregateTokenUsageReports, type TokenUsageReport } from '@recued/contracts';

export interface HousekeepingTaskTokenMeter {
  /** The scheduler opens a task's window. Any prior open window is discarded —
   *  see {@link take}. */
  begin(task_id: string): void;
  /** Fold one provider result into the open window. A call arriving with NO
   *  window open is dropped: it belongs to no task, and attributing it to
   *  whichever task ran last would be a confident wrong number. */
  record(usage: TokenUsageReport): void;
  /** Close the window and return what it accumulated, or `undefined` when the
   *  task made no provider call — which is most tasks, and is why the field is
   *  absent rather than zero on the audit row. */
  take(task_id: string): TokenUsageReport | undefined;
}

export const createHousekeepingTaskTokenMeter = (): HousekeepingTaskTokenMeter => {
  let open: { task_id: string; usage: TokenUsageReport | undefined } | undefined;

  return {
    begin(task_id) {
      // ⚠ An unclosed window means the previous task threw between `begin` and
      // `take`. Dropping it is right: the tokens are real but the row that
      // would have carried them was never written, and carrying them into the
      // NEXT task's total would bill one task for another's work.
      open = { task_id, usage: undefined };
    },

    record(usage) {
      if (open === undefined) return;
      open.usage = aggregateTokenUsageReports(open.usage, usage);
    },

    take(task_id) {
      // ⛔ THE ID IS CHECKED, NOT ASSUMED. A mismatch means begin/take drifted
      // out of step, and returning the open window anyway would attribute one
      // task's spend to another — the exact failure this file exists to avoid.
      if (open === undefined || open.task_id !== task_id) {
        open = undefined;
        return undefined;
      }
      const { usage } = open;
      open = undefined;
      return usage;
    },
  };
};
