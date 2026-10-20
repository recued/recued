import { IngredientError } from '@recued/ingredients';
import { currentRunAbortContext } from './run-abort-context.js';

const assertActive = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new IngredientError('run_killed', 'The run stopped before provider dispatch.');
};

/** Pooled transports consult the dispatching run, rather than their opener. */
export const assertProviderHandoffActive = (): void => assertActive(currentRunAbortContext()?.signal);

/** Invocation callbacks retain their fence even after leaving the host scope.
 * This is admission only: never abort a provider request already in flight. */
export const captureProviderHandoffFence = (): (() => void) => {
  const signal = currentRunAbortContext()?.signal;
  return () => assertActive(signal);
};
