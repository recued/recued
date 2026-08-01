/** After-turn D-214 server-side finalization, and the D-219 offer lifecycle.
 *
 *  Two hooks on a path that already runs:
 *
 *  - `prompt` (before-turn) — retire an offer whose span the owner has moved
 *    past. This is 9c's answer to *"what becomes of an offer nobody answers"*:
 *    the owner's next request retires the previous one, deterministically,
 *    instead of a housekeeping task inventing a staleness policy and then acting
 *    on stale context.
 *  - `update` (after-turn) — finalize the turn, then ask about it when it is a
 *    fresh candidate.
 *
 *  ⚠ Both halves are best-effort and swallow their own failures. Observation and
 *  learning are advisory end to end (#13/#23): a compiler failure, a locked
 *  vault, or an undeliverable notification costs one span, while a throw here
 *  would cost the user their turn.
 */

import type { Middleware } from '@recued/middleware';
import type {
  ExecutionCaseLifecycle,
} from './chat-execution-case-tools.js';
import type {
  ExecutionCaseOfferLifecycle,
} from './execution-case-offer-lifecycle.js';

export const EXECUTION_CASE_FINALIZER_MIDDLEWARE_ID =
  'd214-execution-case-finalizer';

export const createExecutionCaseFinalizerSource = (
  getLifecycle: () => ExecutionCaseLifecycle | undefined,
  /** D-219 slice 9c. Absent → both halves of the offer lifecycle are a faithful
   *  no-op, exactly as before the offer existed (the D-160 removability
   *  discipline: an unwired dep degrades, it never half-works). */
  getOfferLifecycle?: () => ExecutionCaseOfferLifecycle | undefined,
): Middleware => ({
  id: EXECUTION_CASE_FINALIZER_MIDDLEWARE_ID,
  async prompt(ctx) {
    try {
      await getOfferLifecycle?.()?.retireSupersededOffers({
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
      });
    } catch {
      // A retirement that fails leaves the previous ask open. That is the
      // tolerable direction — the owner can still answer it, and the next turn
      // tries again — and it must never cost the turn about to run.
    }
  },
  async update(ctx) {
    try {
      await getLifecycle()?.finalizeTurn({
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        state: ctx.state,
      });
    } catch {
      // Observation/learning is advisory. A compiler or locked-vault failure
      // drops this source span; it never changes the user-visible turn.
      return;
    }
    try {
      // AFTER finalization, never before: the offer is decided from the
      // observation the finalizer just recorded, and before 9a most turns
      // recorded none at all.
      await getOfferLifecycle?.()?.offerForTurn({
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
      });
    } catch {
      // An unraised offer costs one question, never the turn.
    }
  },
});
