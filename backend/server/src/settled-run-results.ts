/** What the owner's own held run returned, once an approval let it finish.
 *
 * A run the owner starts from a page and that stops at an approval answers that
 * page "held". The approval is given somewhere else — the attention tray,
 * another device — and the run resumes on the server, where its result went
 * nowhere: the page went on saying "held for approval" and the recipe's own
 * result card was never seen on that path.
 *
 * This keeps what `execute` would have answered, so a page still waiting can
 * read it with `execution.get`. In memory and for a while only: it is a
 * courtesy to an open page, not a record. The run's durable outcome is its audit
 * row and its receipts; after a restart, or once this lets go, the page keeps
 * the note it had.
 *
 * ⚠ Only runs the owner started from a page (`channel: 'user'`). Chat has its
 * own late-result path, and a door, a peer or a schedule has no page waiting. */

import type { ServerExecuteResponse } from '@recued/contracts';
import type { PreflightRunSettled } from './preflight-resumer.js';

/** Enough for every page an owner has open to collect its run. */
export const SETTLED_RUN_RESULTS_MAX = 32;
/** A page that is open gets its run's result within seconds of it settling;
 *  this covers one that was asleep or reconnecting when it did. */
export const SETTLED_RUN_RESULTS_TTL_MS = 30 * 60 * 1_000;

export interface SettledRunResults {
  remember(run_id: string, result: ServerExecuteResponse): void;
  get(run_id: string): ServerExecuteResponse | undefined;
}

export const createSettledRunResults = (opts: {
  max?: number;
  ttlMs?: number;
  now?: () => number;
} = {}): SettledRunResults => {
  const max = opts.max ?? SETTLED_RUN_RESULTS_MAX;
  const ttlMs = opts.ttlMs ?? SETTLED_RUN_RESULTS_TTL_MS;
  const now = opts.now ?? Date.now;
  // Insertion order is age order: `remember` re-inserts, so the first key is
  // always the oldest.
  const entries = new Map<string, { result: ServerExecuteResponse; at: number }>();
  const dropExpired = (): void => {
    const cutoff = now() - ttlMs;
    for (const [run_id, entry] of entries) {
      if (entry.at > cutoff) break;
      entries.delete(run_id);
    }
  };
  return {
    remember(run_id, result) {
      entries.delete(run_id);
      entries.set(run_id, { result, at: now() });
      dropExpired();
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    get(run_id) {
      dropExpired();
      return entries.get(run_id)?.result;
    },
  };
};

const isExecuteResponse = (value: unknown): value is ServerExecuteResponse => {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<Record<keyof ServerExecuteResponse, unknown>>;
  return typeof candidate.recipe_id === 'string'
    && typeof candidate.success === 'boolean'
    && candidate.output !== null
    && typeof candidate.output === 'object'
    && Array.isArray(candidate.steps)
    && Array.isArray(candidate.errors);
};

/** Keep a settled run's result when a page of the owner's is what started it.
 *  A denial settles with no result to show (`{ denied: true, … }`), so it is not
 *  kept: the page reads the run's own record for that. */
export const rememberOwnerPageRun = (
  store: SettledRunResults | undefined,
  settled: PreflightRunSettled,
): void => {
  if (store === undefined) return;
  const source = settled.execution_source as { channel?: unknown } | null | undefined;
  if (source?.channel !== 'user') return;
  if (!isExecuteResponse(settled.result)) return;
  store.remember(settled.run_id, settled.result);
};
