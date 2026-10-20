import { AsyncLocalStorage } from 'node:async_hooks';

/** Host-owned execution lineage. Never constructed from recipe or wire data. */
export interface RunAbortContext {
  readonly run_id?: string;
  readonly signal?: AbortSignal;
  /** Manual owner stops, including ancestors; excludes recipe deadlines. */
  readonly owner_signal?: AbortSignal;
}

const contexts = new AsyncLocalStorage<RunAbortContext>();

export const currentRunAbortContext = (): RunAbortContext | undefined => contexts.getStore();

/** A root entry can be launched by a timer/event retaining another run's
 * asynchronous context. It owns its cancellation independently of that run. */
export const withoutRunAbortContext = <T>(run: () => T): T => contexts.exit(run);

/** A nested run retains ancestor deadlines while keeping its own stop handle.
 * Returning from the callback restores the caller's asynchronous context. */
export const withRunAbortContext = <T>(context: RunAbortContext, run: () => T): T => {
  const parentSignal = contexts.getStore()?.signal;
  const signal = context.signal && parentSignal && context.signal !== parentSignal
    ? AbortSignal.any([parentSignal, context.signal])
    : context.signal ?? parentSignal;
  return contexts.run({ ...context, signal }, run);
};
