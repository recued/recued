/** D-337 ruling 4, design (a) — a request that waits for the owner's answer to a call it holds.
 *
 *  The owner, of a conversation under a contract: *"the approval is owner's action, but the action
 *  to be approved is under the scope of contract, so basically the approval "partially" pause th
 *  conversation ( that piece is held, until owner approves then it passed back to the model of that
 *  session for it to invoke the resume context. because only the model knows what is the
 *  responsible tool called is for and what to use with it before passing back to user)"*.
 *
 *  The one conversation under a contract is the LLM gateway's, and it lives in one HTTP request:
 *  the customer's app holds the history and each completion is its own session. So the request is
 *  what waits. A call held for the owner's approval keeps its dispatch open until the run settles
 *  (`wait`, fed every settled run by the server's run-settled listener), and then returns what the
 *  call would have returned had it not waited (`settledHeldCallResult`): the model that made the
 *  call takes the next step and answers. The owner chose this *"with (b) later for slow
 *  approvals"*: past the request's limit the model is told the call waits, and its outcome
 *  reaches the conversation's next request (design (b), `ports/llm-gateway/held-calls.ts`).
 *
 *  The action stays within the contract: the resume re-reads it when the owner answers
 *  (`approvalResumeAuthority`, `admitBoundInboundToken`), and the model's next call re-reads it
 *  again (`assert_live_authority`).
 *
 *  ⚠ A run that pauses again at a later step is still waiting: such a settlement is passed over,
 *  and the wait goes on for the next one, within the same limit. */

import type { ChatDispatchResult } from '@recued/contracts';
import { HELD_WRITE_EXPIRED_MESSAGE } from './chat-held-writes.js';
import { HELD_RESULT_REFUSED_DETAIL, heldResultOutcomeOf } from './chat-held-results.js';
import { isNonTerminalToolResult } from './chat-tool-call-context.js';
import { wrapRecipeRunResult } from './chat-tool-handlers.js';
import type { PreflightRunSettled } from './preflight-resumer.js';
import type { ExecuteResponse } from './types.js';

/** A settlement nobody waits on yet is kept this long: a wait that begins just after its run
 *  settled (an answer given before the dispatch got back to wait) still finds it. */
export const HELD_RUN_SETTLED_KEEP_MS = 5 * 60_000;
/** And at most this many of them. */
export const HELD_RUN_SETTLED_KEEP_MAX = 256;

export interface HeldRunWaiters {
  /** The run's settlement once it settles, or `undefined` once `until` passes or `signal` aborts
   *  (the caller went away). */
  wait(run_id: string, until: number, signal?: AbortSignal): Promise<PreflightRunSettled | undefined>;
  /** Told each settled run, from the server's run-settled listener. */
  settled(settled: PreflightRunSettled): void;
}

export interface HeldRunWaitersOptions {
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export const createHeldRunWaiters = (options: HeldRunWaitersOptions = {}): HeldRunWaiters => {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer
    ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const waiting = new Map<string, Set<(settled: PreflightRunSettled) => void>>();
  // Insertion order is age order: a settlement is re-inserted when told again.
  const recent = new Map<string, { readonly settled: PreflightRunSettled; readonly at: number }>();
  const forget = (at: number): void => {
    for (const [run_id, entry] of recent) {
      if (at - entry.at < HELD_RUN_SETTLED_KEEP_MS && recent.size <= HELD_RUN_SETTLED_KEEP_MAX) break;
      recent.delete(run_id);
    }
  };
  return {
    settled(settled) {
      if (settled.run_id.length === 0 || isNonTerminalToolResult(settled.result)) return;
      const waiters = waiting.get(settled.run_id);
      if (waiters !== undefined && waiters.size > 0) {
        waiting.delete(settled.run_id);
        for (const resolve of waiters) resolve(settled);
        return;
      }
      const at = now();
      recent.delete(settled.run_id);
      recent.set(settled.run_id, { settled, at });
      forget(at);
    },
    wait(run_id, until, signal) {
      const at = now();
      forget(at);
      const known = recent.get(run_id);
      if (known !== undefined) {
        recent.delete(run_id);
        return Promise.resolve(known.settled);
      }
      if (until <= at || signal?.aborted === true) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        let done = false;
        const finish = (settled: PreflightRunSettled | undefined): void => {
          if (done) return;
          done = true;
          clearTimer(timer);
          signal?.removeEventListener('abort', onAbort);
          const set = waiting.get(run_id);
          set?.delete(onSettled);
          if (set !== undefined && set.size === 0) waiting.delete(run_id);
          resolve(settled);
        };
        const onSettled = (settled: PreflightRunSettled): void => finish(settled);
        const onAbort = (): void => finish(undefined);
        const timer = setTimer(() => finish(undefined), until - at);
        signal?.addEventListener('abort', onAbort, { once: true });
        const set = waiting.get(run_id) ?? new Set<(settled: PreflightRunSettled) => void>();
        set.add(onSettled);
        waiting.set(run_id, set);
      });
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** What a held call returns once its run settles, as the call would have returned had it not
 *  waited: the run's own result (`wrapRecipeRunResult`, as an unheld run's), or a tool's result
 *  for its run (a finisher's); refused or expired, the words the owner's own conversation reads
 *  (`heldResultCall`). The held call's run id stays on it. */
export const settledHeldCallResult = (
  settled: Pick<PreflightRunSettled, 'result' | 'state'>,
  held: ChatDispatchResult,
): ChatDispatchResult => {
  const run = held.run_id !== undefined ? { run_id: held.run_id } : {};
  const outcome = heldResultOutcomeOf(settled);
  if (outcome === 'refused') return { ok: false, reason: 'plan_cancelled', detail: HELD_RESULT_REFUSED_DETAIL, ...run };
  if (outcome === 'expired') return { ok: false, reason: 'plan_cancelled', detail: HELD_WRITE_EXPIRED_MESSAGE, ...run };
  const result = settled.result;
  if (isRecord(result) && typeof result.ok === 'boolean') {
    return { ...(result as unknown as ChatDispatchResult), ...run };
  }
  if (isRecord(result) && typeof result.success === 'boolean') {
    return { ...wrapRecipeRunResult(result as unknown as ExecuteResponse), ...run };
  }
  return { ok: true, result, ...run };
};
