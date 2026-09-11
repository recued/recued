import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import type { ChatDispatchResult, ExecutionSource } from '@recued/contracts';
import { createChatToolCallTracker } from './storage/chat-tool-call-store.js';

interface ToolCallContext {
  active: boolean;
  run_id?: string;
  bind: (run_id: string, recipe_id: string) => void;
  progress: (run_id: string, at: number, stalled: boolean) => boolean | undefined;
}
const context = new AsyncLocalStorage<ToolCallContext>();
// Internal bookkeeping only; never add persistence plumbing to a model result.
const savedResults = new WeakMap<ChatDispatchResult, string>();
const savedFailures = new WeakMap<object, ChatDispatchResult>();
export const markChatToolCallSaved = (result: ChatDispatchResult, message_id: string): void => {
  savedResults.set(result, message_id);
};
export const savedChatToolCallId = (result: ChatDispatchResult): string | undefined => savedResults.get(result);
export const rememberChatToolCallFailure = (error: unknown, result: ChatDispatchResult): object => {
  // A provider can reject several concurrent calls with the same Error.
  // Give the tool loop a unique envelope so their saved origins cannot alias.
  const failure = new Error(error instanceof Error ? error.message : String(error), { cause: error });
  savedFailures.set(failure, result);
  return failure;
};
export const chatToolCallFailureResult = (error: unknown): ChatDispatchResult | undefined =>
  error !== null && typeof error === 'object' ? savedFailures.get(error) : undefined;

export const withChatToolCallContext = async <T>(
  callbacks: Pick<ToolCallContext, 'bind' | 'progress'>,
  run: () => Promise<T>,
): Promise<T> => {
  const state: ToolCallContext = { ...callbacks, active: true };
  try { return await context.run(state, run); }
  finally { state.active = false; }
};

/** Called at the actual run registration, after duplicate-run attachment has
 * selected its leader. Nested child runs cannot replace the outer run's id. */
export const bindChatToolCallRun = (
  run_id: string,
  recipe_id: string,
): ((at: number, stalled: boolean) => boolean | undefined) | undefined => {
  const state = context.getStore();
  if (!state?.active || state.run_id !== undefined) return undefined;
  state.bind(run_id, recipe_id);
  state.run_id = run_id;
  return (at, stalled) => {
    if (state.active) return state.progress(run_id, at, stalled);
    return undefined;
  };
};

/** Observe an already-authorized resume, without restoring an old async
 * context or providing any authority to restart work. */
export const observeResumedChatToolCall = (
  db: Database.Database | undefined,
  source: ExecutionSource | undefined,
  run_id: string,
) => {
  if (!db || source?.channel !== 'chat' || source.actor !== 'user_self'
    || source.contract_id !== undefined) return undefined;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages'").get()) return undefined;
  const tracker = createChatToolCallTracker(db);
  const ids = tracker.resumeRun(source.chat_session_id, run_id);
  if (ids.length === 0) return undefined;
  return {
    progress: (at: number, stalled: boolean): boolean => {
      let changed = false;
      for (const id of ids) changed = tracker.progress(id, run_id, at, stalled) || changed;
      return changed;
    },
    hold: (): void => {
      try { for (const id of ids) tracker.hold(id); }
      catch (error) { console.error('[chat] resumed call hold persistence failed', error); }
    },
    interrupt: (): void => {
      try { for (const id of ids) tracker.interrupt(id); }
      catch (error) { console.error('[chat] resumed call interruption persistence failed', error); }
    },
  };
};

/** Engine hold markers, including their agent-facing projection. A pause is
 * an acknowledgement; it must never close the dispatch/result pair. */
export const isNonTerminalToolResult = (result: unknown): boolean => {
  if (!result || typeof result !== 'object') return false;
  const envelope = result as {
    run_held?: unknown; awaiting_approval?: unknown; awaiting_peer?: unknown; result?: unknown;
  };
  if (envelope.run_held !== undefined && envelope.run_held !== null) return true;
  if (envelope.awaiting_approval === true || envelope.awaiting_peer === true) return true;
  const inner = envelope.result;
  if (!inner || typeof inner !== 'object') return false;
  const projected = inner as { awaiting_approval?: unknown; awaiting_peer?: unknown };
  return projected.awaiting_approval === true || projected.awaiting_peer === true;
};
