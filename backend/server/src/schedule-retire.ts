/** D-215 slice 1 — schedule retirement: ONE path, two callers.
 *
 *  Retiring a schedule is "delete the row AND dissolve the managed overlay
 *  dish it owns". Two things now trigger it:
 *
 *    1. `schedules.delete` — the owner removing it by hand.
 *    2. A ONE-SHOT schedule whose run SUCCEEDED (D-215 § 5.2). Its intent
 *       is fulfilled; the run record lives in audit, so the pending-intent
 *       row is noise. Before this slice the scheduler only set
 *       `enabled: false` and the row + its dish accumulated forever —
 *       there is no reaper anywhere behind them.
 *
 *  It lives in its own module rather than in `schedule-handler.ts` so the
 *  scheduler can call it without importing the whole rpc handler (and the
 *  ws / event-bus surface it drags in), and so the `managed_by_schedule_id`
 *  dissolve guard is written exactly ONCE. That guard is the load-bearing
 *  part: a schedule may point at a dish it does NOT own (a user-assigned
 *  binding), and retiring the schedule must never delete that dish.
 *
 *  ⚠ Deliberately NOT emitting the `schedule` bus event here — the two
 *  callers emit on different lifecycles (the rpc emits once per call; the
 *  scheduler already emits `fired` earlier in the same tick), so ownership
 *  of the emit stays with them.
 *
 *  Spec: D-215 § 5.3.
 */

import type { ScheduleStore } from './schedule-store.js';
import type { DishStore } from './dish-store.js';
import type { DishContextStore } from './dish-context-store.js';

export interface RetireScheduleDeps {
  store: Pick<ScheduleStore, 'get' | 'delete'>;
  /** Absent ⇒ the row is deleted and no dish is dissolved (legacy/test
   *  path, mirroring `ScheduleHandlerDeps.dishStore`). */
  dishStore?: Pick<DishStore, 'get' | 'delete'>;
  /** Continuity snapshots — cleared alongside a dissolved dish so a
   *  re-minted dish never inherits a dead instance's prior-run state. */
  dishContextStore?: Pick<DishContextStore, 'clear'>;
}

/** Delete a schedule row and dissolve the managed overlay dish it owns.
 *
 *  Returns `false` when the row was already gone — callers decide whether
 *  that is a `not_found` (the rpc) or a no-op (the scheduler, which can
 *  race a concurrent delete). Read-before-delete is required: the row
 *  carries the `dish_id` pointer, and it cannot be read back afterwards. */
export const retireSchedule = (
  deps: RetireScheduleDeps,
  schedule_id: string,
): boolean => {
  const existing = deps.store.get(schedule_id);
  if (!deps.store.delete(schedule_id)) return false;
  // Dissolve ONLY a dish this schedule minted for its own overlay. A
  // user-assigned binding carries no `managed_by_schedule_id` (or carries
  // another owner's) and is never touched.
  if (existing?.dish_id !== undefined && deps.dishStore) {
    const dish = deps.dishStore.get(existing.dish_id);
    if (dish && dish.managed_by_schedule_id === schedule_id) {
      deps.dishStore.delete(existing.dish_id);
      deps.dishContextStore?.clear(existing.dish_id);
    }
  }
  return true;
};
