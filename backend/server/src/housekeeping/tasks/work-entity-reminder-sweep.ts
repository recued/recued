/** D-269 — housekeeping task wrapping `runReminderSweep`.
 *
 *  Mirrors the due-status sweep's wrapper: one pass per cycle, the ledger built
 *  once and reused, the cycle's clock taking precedence.
 *
 *  ⚠ Registered only when the notification block is wired, because this sweep's
 *  whole output is a `notify` — unlike the due-status sweep, which still does
 *  useful work (advancing `due_status`) with no bus attached. **A reminder sweep
 *  with nowhere to deliver is not a degraded feature, it is a no-op**, and
 *  registering it anyway would burn a housekeeping slot to do nothing. */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';

import { runReminderSweep, type ReminderSweepDeps } from '../../work-entity-reminder-sweep.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';

export interface BuildWorkEntityReminderSweepTaskOptions {
  deps: ReminderSweepDeps;
}

export const buildWorkEntityReminderSweepTask = (
  opts: BuildWorkEntityReminderSweepTaskOptions,
): HousekeepingTaskInstance => ({
  meta: {
    id: 'work-entity-reminder-sweep',
    description:
      'Remind the owner about a task, promise, booking or calendar event, at the '
      + 'per-kind offset they set. The only surface that TELLS a person — the '
      + 'due-status sweep emits bus events, which drive recipes, not people.',
    interruptible: true,
    kind: 'core',
    tags: ['kind:core', 'domain:work', 'surface:deterministic'],
  },

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    runReminderSweep({ ...opts.deps, now: ctx.now });
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});
