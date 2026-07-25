/** D-145 PA4 — `work-entity-due-status-sweep` housekeeping task.
 *
 *  Wraps `runDueStatusSweep` (`backend/server/src/work-entity-due-
 *  status-sweep.ts`) as a `kind: 'core'` housekeeping task so the
 *  D-123 scheduler picks it up on the regular idle cadence.
 *
 *  Cursor: `{ kind: 'complete' }` — every step is a fresh sweep at
 *  `now()`. The sweep itself is idempotent on the steady-state set
 *  (rows already at the target due_status skip), so re-firing on the
 *  next idle cycle is cheap when nothing crossed in the interval.
 *
 *  No `onInvalidate` — deadline crossings are time-driven; nothing
 *  about a source-record write changes whether a deadline crossed
 *  in real time.
 *
 *  Spec: `docs/d-145-spec.md` § Phase PA4 + § A.1.3. */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';

import {
  createTaskEmissionLedger,
  runDueStatusSweep,
  type DueStatusSweepDeps,
  type TaskEmissionLedger,
} from '../../work-entity-due-status-sweep.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';

export interface BuildWorkEntityDueStatusSweepTaskOptions {
  /** PA4 sweep deps. The store is required (the task is a no-op if
   *  the work-entity store isn't enrolled — bin.ts elides the
   *  registration in that case). The bus + cascade are wired through
   *  the housekeeping context so the task fires events + cascades
   *  using the same instances that the dispatcher path uses.
   *
   *  Codex P1 fold — the wrapper builds a single
   *  `TaskEmissionLedger` at construction time and reuses it across
   *  sweep cycles so task `due_soon` / `overdue` events stay
   *  steady-state idempotent. Tests can override via
   *  `opts.deps.taskEmissionLedger` for explicit-state assertions. */
  deps: DueStatusSweepDeps;
}

export const buildWorkEntityDueStatusSweepTask = (
  opts: BuildWorkEntityDueStatusSweepTaskOptions,
): HousekeepingTaskInstance => {
  // Build (or accept) the ledger once. The wrapper holds it across
  // cycles; the in-process Map survives until the server restarts.
  // After restart the next sweep's first observation re-emits, but
  // the warehouse-event binder's per-(record_id, event_kind) dedup
  // window catches the immediate re-fire.
  const ledger: TaskEmissionLedger =
    opts.deps.taskEmissionLedger ?? createTaskEmissionLedger();

  return {
    meta: {
      id: 'work-entity-due-status-sweep',
      description:
        'Cross deadlines into due_soon / overdue + emit '
        + 'reactive triggers; flip strict_expire commitments to '
        + 'lifecycle: expired.',
      interruptible: true,
      kind: 'core',
      tags: ['kind:core', 'domain:work', 'surface:deterministic'],
    },

    async step(
      ctx: HousekeepingContext,
      _cursor: HousekeepingCursor,
      _budget_ms: number,
    ): Promise<HousekeepingStepResult> {
      // PA4 — the sweep is a single pass per cycle. With at most a
      // few thousand pending tasks + commitments (paginated 1000 at
      // a time) the sweep runs in well under the smallest
      // housekeeping budget; we don't need a yield path.
      runDueStatusSweep({
        ...opts.deps,
        taskEmissionLedger: ledger,
        // The housekeeping cycle's clock takes precedence — keeps
        // run-to-run determinism when tests inject `ctx.now`.
        now: ctx.now,
      });
      return { status: 'complete', cursor: { kind: 'complete' } };
    },
  };
};
