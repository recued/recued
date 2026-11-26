import { runYieldIsTotalRefusal, type RunFeedRow, type RunYield } from './execution-rpc.js';

export const RUN_SEARCH_OUTCOMES = ['failed', 'partial', 'refused', 'unknown', 'waiting-owner'] as const;
export type RunSearchOutcome = typeof RUN_SEARCH_OUTCOMES[number];
export const RUN_SEARCH_TIME_RANGES = ['24h', '7d', '30d'] as const;
export type RunSearchTimeRange = typeof RUN_SEARCH_TIME_RANGES[number];
/** Durable settings contain relative choices, never resolved times or results. */
export interface RunSearchFilters { outcome?: RunSearchOutcome; time_range?: RunSearchTimeRange }
/** A fixed, acknowledged window is reused for every page of one search. */
export interface RunSearchScope { outcome?: RunSearchOutcome; started_from?: number; started_before?: number }
export type RunHistoryOutcomeKind = RunSearchOutcome | 'finished' | 'stopped' | 'waiting-peer' | 'active' | 'pending' | 'cancelled';
type OutcomeRow = Pick<RunFeedRow, 'status' | 'run_yield' | 'error_category'>;

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const epoch = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15;
export const parseRunSearchFilters = (input: unknown): RunSearchFilters | null => {
  if (!object(input) || Object.keys(input).some(key => !['outcome', 'time_range'].includes(key))
    || Object.hasOwn(input, 'outcome') && input.outcome !== 'all' && !RUN_SEARCH_OUTCOMES.some(value => value === input.outcome)
    || Object.hasOwn(input, 'time_range') && input.time_range !== 'all' && !RUN_SEARCH_TIME_RANGES.some(value => value === input.time_range)) return null;
  return { ...(input.outcome && input.outcome !== 'all' ? { outcome: input.outcome as RunSearchOutcome } : {}),
    ...(input.time_range && input.time_range !== 'all' ? { time_range: input.time_range as RunSearchTimeRange } : {}) };
};
export const parseRunSearchScope = (input: unknown): RunSearchScope | null => {
  if (!object(input) || Object.keys(input).some(key => !['outcome', 'started_from', 'started_before'].includes(key))
    || Object.hasOwn(input, 'outcome') && !RUN_SEARCH_OUTCOMES.some(value => value === input.outcome)
    || Object.hasOwn(input, 'started_from') && !epoch(input.started_from)
    || Object.hasOwn(input, 'started_before') && !epoch(input.started_before)
    || typeof input.started_from === 'number' && typeof input.started_before === 'number' && input.started_from >= input.started_before) return null;
  return { ...(input.outcome ? { outcome: input.outcome as RunSearchOutcome } : {}),
    ...(input.started_from !== undefined ? { started_from: input.started_from as number } : {}),
    ...(input.started_before !== undefined ? { started_before: input.started_before as number } : {}) };
};
export const sameRunSearchScope = (a: RunSearchScope, b: RunSearchScope): boolean =>
  a.outcome === b.outcome && a.started_from === b.started_from && a.started_before === b.started_before;
export const resolveRunSearchScope = (filters: RunSearchFilters, now: number): RunSearchScope => {
  const valid = parseRunSearchFilters(filters);
  if (!valid || !epoch(now) || !epoch(now + 1)) throw Error('The run search dates could not be confirmed.');
  const duration = valid.time_range ? { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 }[valid.time_range] : undefined;
  const scope = { ...(valid.outcome ? { outcome: valid.outcome } : {}),
    ...(duration ? { started_from: now - duration, started_before: now + 1 } : {}) };
  if (!parseRunSearchScope(scope)) throw Error('The run search dates could not be confirmed.');
  return scope;
};
export const validRunYield = (value: RunYield | undefined): value is RunYield =>
  value != null && [value.steps_run, value.steps_skipped, value.items_total, value.items_failed]
    .every(count => Number.isSafeInteger(count) && count >= 0) && value.items_failed <= value.items_total;

/** Item tallies refine a finished run. They cannot turn a failed, waiting or
 * uncertain run into a success, and owner stops remain distinct from errors. */
export const runHistoryOutcomeKind = (row: OutcomeRow): RunHistoryOutcomeKind => {
  switch (row.status) {
    case 'in_doubt': return 'unknown';
    case 'awaiting_approval': return 'waiting-owner';
    case 'awaiting_peer': return 'waiting-peer';
    case 'running': return 'active';
    case 'pending': return 'pending';
    case 'failed': return row.error_category === 'killed' ? 'stopped' : row.error_category === 'cancelled_before_dispatch' ? 'cancelled' : 'failed';
    case 'cancelled': return 'cancelled';
    case 'killed': return 'stopped';
    case 'succeeded':
      if (!validRunYield(row.run_yield)) return 'finished';
      if (runYieldIsTotalRefusal(row.run_yield)) return 'refused';
      if (row.run_yield.items_failed > 0) return 'partial';
      return typeof row.run_yield.stopped_at === 'string' && row.run_yield.stopped_at.length > 0 ? 'stopped' : 'finished';
    default: { const exhaustive: never = row.status; return exhaustive; }
  }
};
export const runMatchesSearchScope = (row: OutcomeRow & Pick<RunFeedRow, 'started_at'>, scope: RunSearchScope): boolean =>
  (!scope.outcome || runHistoryOutcomeKind(row) === scope.outcome)
  && (scope.started_from === undefined || row.started_at >= scope.started_from)
  && (scope.started_before === undefined || row.started_at < scope.started_before);
