/** Request-local correlation for trusted deterministic verification producers.
 *
 * The context is established around the internal registry dispatch, so deep
 * server-side verifiers can attribute a fact to the exact chat turn without
 * accepting model-authored correlation fields.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface ExecutionCaseVerificationContext {
  session_id: string;
  turn_id: string;
}

interface StoredVerificationContext extends ExecutionCaseVerificationContext {
  active: boolean;
}

const storage = new AsyncLocalStorage<StoredVerificationContext>();

export const runWithExecutionCaseVerificationContext = async <T>(
  context: ExecutionCaseVerificationContext,
  run: () => Promise<T>,
): Promise<T> => {
  const stored = { ...context, active: true };
  try {
    return await storage.run(stored, run);
  } finally {
    // Async resources detached by a dispatcher inherit the object. Closing it
    // prevents later background work from being misattributed to this turn.
    stored.active = false;
  }
};

export const currentExecutionCaseVerificationContext = (
): ExecutionCaseVerificationContext | undefined => {
  const stored = storage.getStore();
  return stored?.active
    ? { session_id: stored.session_id, turn_id: stored.turn_id }
    : undefined;
};
