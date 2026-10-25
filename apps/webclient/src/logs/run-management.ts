import {
  runYieldIsTotalRefusal,
  type ActiveExecutionEntry,
  type RunFeedRow,
  type RunYield,
} from '@recued/contracts';

export interface HistoryOutcome {
  readonly kind: 'finished' | 'partial' | 'refused' | 'stopped' | 'failed'
    | 'unknown' | 'waiting-owner' | 'waiting-peer' | 'active' | 'pending' | 'cancelled';
  readonly label: string;
  readonly tone: 'ok' | 'accent' | 'off' | 'neutral';
  readonly note?: string;
}

export const validRunYield = (value: RunYield | undefined): value is RunYield =>
  value != null && [value.steps_run, value.steps_skipped, value.items_total, value.items_failed]
    .every(count => Number.isSafeInteger(count) && count >= 0)
  && value.items_failed <= value.items_total;

/** Status remains authoritative. Item counts refine a finished run, never
 * turn a failed, paused or uncertain run into a successful result. */
export const historyOutcome = (row: Pick<RunFeedRow, 'status' | 'run_yield' | 'error_category'>): HistoryOutcome => {
  switch (row.status) {
    case 'in_doubt': return { kind: 'unknown', label: 'Needs checking', tone: 'accent', note: 'The outcome is not confirmed.' };
    case 'awaiting_approval': return { kind: 'waiting-owner', label: 'Awaiting approval', tone: 'accent', note: 'Waiting for an approval decision.' };
    case 'awaiting_peer': return { kind: 'waiting-peer', label: 'Waiting on a peer', tone: 'accent', note: 'Another server must answer.' };
    case 'running': return { kind: 'active', label: 'Running', tone: 'accent' };
    case 'pending': return { kind: 'pending', label: 'Pending', tone: 'neutral' };
    case 'failed': {
      if (row.error_category === 'killed') return { kind: 'stopped', label: 'Stopped by owner', tone: 'neutral', note: 'Earlier changes may remain.' };
      if (row.error_category === 'cancelled_before_dispatch') return { kind: 'cancelled', label: 'Cancelled before dispatch', tone: 'neutral', note: 'Earlier steps may have changed items.' };
      return { kind: 'failed', label: 'Failed', tone: 'off', note: 'Review before running it again.' };
    }
    case 'cancelled': return { kind: 'cancelled', label: 'Cancelled', tone: 'neutral', note: 'Earlier changes may remain.' };
    case 'killed': return { kind: 'stopped', label: 'Stopped by owner', tone: 'neutral', note: 'Earlier changes may remain.' };
    case 'succeeded': {
      const tally = row.run_yield;
      if (!validRunYield(tally)) return { kind: 'finished', label: 'Finished', tone: 'ok', note: 'Item results were not recorded.' };
      const stopped = typeof tally.stopped_at === 'string' && tally.stopped_at.length > 0;
      if (runYieldIsTotalRefusal(tally)) {
        return { kind: 'refused', label: 'All items failed', tone: 'accent', note: `${tally.items_failed} of ${tally.items_total} items failed.${stopped ? ' Ended early.' : ''}` };
      }
      if (tally.items_failed > 0) {
        return { kind: 'partial', label: 'Partial result', tone: 'accent', note: `${tally.items_failed} of ${tally.items_total} items failed.${stopped ? ' Ended early.' : ''}` };
      }
      if (stopped) return { kind: 'stopped', label: 'Stopped early', tone: 'neutral', note: 'A recipe stop condition was met.' };
      return { kind: 'finished', label: 'Finished', tone: 'ok', ...(tally.items_total > 0
        ? { note: `${tally.items_total} items attempted; no item errors.` } : {}) };
    }
    default: {
      const exhaustive: never = row.status;
      return exhaustive;
    }
  }
};

/** These are registry entries, not a count of distinct recipe runs. Queued
 * calls can share a run id with work already holding a slot. */
export const activeWorkGroups = (entries: ReadonlyArray<ActiveExecutionEntry>) => {
  const inProgress: ActiveExecutionEntry[] = [];
  const queued: ActiveExecutionEntry[] = [];
  for (const entry of entries) {
    (entry.entry_kind === 'queued-call' || entry.state === 'waiting_slot'
      ? queued : inProgress).push(entry);
  }
  return {
    inProgress, queued,
    stalled: entries.filter(entry => entry.progress.stalled).length,
  };
};
