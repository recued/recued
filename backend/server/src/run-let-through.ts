/** D-402 slice F5 (§7.10) — a run's record of what let each of its writes through without asking the
 *  owner. Each gate's host records a use where it lets a write through (the pass seam, the pre-approval
 *  admissions, the grant and chain-rule hooks), and the run's response carries the record
 *  (`ExecuteResponse.let_through`): the owner's run page offers "Stop allowing" from it, and the agent
 *  projection says it to the model in words. It never decides anything: it only counts. */

import { RUN_LET_THROUGH_ORDER, type PreapprovalCaller, type RunLetThrough, type RunLetThroughBy } from '@recued/contracts';

export interface RunLetThroughLedger {
  record(by: RunLetThroughBy): void;
  /** The run's record, or undefined when nothing ran without asking. */
  result(): RunLetThrough | undefined;
}

/** `callerOf` is read when the record is: a run knows its caller once its identity is settled. */
export const createRunLetThrough = (callerOf: () => PreapprovalCaller | undefined): RunLetThroughLedger => {
  const counts = new Map<RunLetThroughBy, number>();
  return {
    record: (by) => { counts.set(by, (counts.get(by) ?? 0) + 1); },
    result: () => {
      if (counts.size === 0) return undefined;
      const caller = callerOf();
      return {
        ...(caller !== undefined ? { caller } : {}),
        writes: RUN_LET_THROUGH_ORDER.filter((by) => counts.has(by)).map((by) => ({ by, count: counts.get(by)! })),
      };
    },
  };
};
