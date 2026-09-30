/** D-215 slice 1 — schedule retirement: ONE path, two callers.
 *
 *  Two things retire a schedule:
 *
 *    1. `schedules.delete` — the owner removing it by hand.
 *    2. A ONE-SHOT schedule whose run SUCCEEDED (D-215 § 5.2). Its intent
 *       is fulfilled; the run record lives in audit, so the pending-intent
 *       row is noise, and there is no reaper anywhere behind it.
 *
 *  D-319 — a schedule belongs to a dish and owns none: retiring it deletes
 *  the row and leaves its dish, whose settings, other schedules and triggers
 *  go on. (Until D-319 a schedule with settings of its own minted a managed
 *  dish, and retiring dissolved it.)
 *
 *  It lives in its own module rather than in `schedule-handler.ts` so the
 *  scheduler can call it without importing the whole rpc handler (and the
 *  ws / event-bus surface it drags in).
 *
 *  ⚠ Deliberately NOT emitting the `schedule` bus event here — the two
 *  callers emit on different lifecycles (the rpc emits once per call; the
 *  scheduler already emits `fired` earlier in the same tick), so ownership
 *  of the emit stays with them.
 *
 *  Spec: D-215 § 5.3, D-319 § 4.3.
 */

import type { ScheduleStore } from './schedule-store.js';

export interface RetireScheduleDeps {
  store: Pick<ScheduleStore, 'delete'>;
}

/** Delete a schedule row. Returns `false` when it was already gone — callers
 *  decide whether that is a `not_found` (the rpc) or a no-op (the scheduler,
 *  which can race a concurrent delete). */
export const retireSchedule = (
  deps: RetireScheduleDeps,
  schedule_id: string,
): boolean => deps.store.delete(schedule_id);
