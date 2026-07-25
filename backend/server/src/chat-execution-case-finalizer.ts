/** After-turn D-214 server-side strong-signal finalization. */

import type { Middleware } from '@recued/middleware';
import type {
  ExecutionCaseLifecycle,
} from './chat-execution-case-tools.js';

export const EXECUTION_CASE_FINALIZER_MIDDLEWARE_ID =
  'd214-execution-case-finalizer';

export const createExecutionCaseFinalizerSource = (
  getLifecycle: () => ExecutionCaseLifecycle | undefined,
): Middleware => ({
  id: EXECUTION_CASE_FINALIZER_MIDDLEWARE_ID,
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
    }
  },
});
