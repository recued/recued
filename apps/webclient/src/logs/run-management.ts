import {
  runHistoryOutcomeKind, validRunYield,
  type ActiveExecutionEntry,
  type HeavyOpErrorCategory, type CliFailureReason,
  type RunFeedRow,
  type RunHistoryOutcomeKind,
} from '@recued/contracts';

export interface HistoryOutcome {
  readonly kind: RunHistoryOutcomeKind;
  readonly label: string;
  readonly tone: 'ok' | 'accent' | 'off' | 'neutral';
  readonly note?: string;
}

export { validRunYield };

/** Status remains authoritative. Item counts refine a finished run, never
 * turn a failed, paused or uncertain run into a successful result. */
export const historyOutcome = (row: Pick<RunFeedRow, 'status' | 'run_yield' | 'error_category'>): HistoryOutcome => {
  const kind = runHistoryOutcomeKind(row);
  switch (kind) {
    case 'unknown': return { kind, label: 'Needs checking', tone: 'accent', note: 'The outcome is not confirmed.' };
    case 'waiting-owner': return { kind, label: 'Awaiting approval', tone: 'accent', note: 'Waiting for an approval decision.' };
    case 'waiting-peer': return { kind, label: 'Waiting on a peer', tone: 'accent', note: 'Another server must answer.' };
    case 'active': return { kind, label: 'Running', tone: 'accent' };
    case 'pending': return { kind: 'pending', label: 'Pending', tone: 'neutral' };
    case 'failed': return { kind, label: 'Failed', tone: 'off', note: 'Review before running it again.' };
    case 'cancelled': return row.error_category === 'cancelled_before_dispatch'
      ? { kind, label: 'Cancelled before dispatch', tone: 'neutral', note: 'Earlier steps may have changed items.' }
      : { kind, label: 'Cancelled', tone: 'neutral', note: 'Earlier changes may remain.' };
    case 'stopped': return row.status === 'succeeded'
      ? { kind, label: 'Stopped early', tone: 'neutral', note: 'A recipe stop condition was met.' }
      : { kind, label: 'Stopped by owner', tone: 'neutral', note: 'Earlier changes may remain.' };
    case 'refused':
    case 'partial': {
      const tally = row.run_yield!;
      const stopped = typeof tally.stopped_at === 'string' && tally.stopped_at.length > 0;
      return { kind, label: kind === 'refused' ? 'All items failed' : 'Partial result', tone: 'accent',
        note: `${tally.items_failed} of ${tally.items_total} items failed.${stopped ? ' Ended early.' : ''}` };
    }
    case 'finished': {
      const tally = row.run_yield;
      if (!validRunYield(tally)) return { kind: 'finished', label: 'Finished', tone: 'ok', note: 'Item results were not recorded.' };
      return { kind: 'finished', label: 'Finished', tone: 'ok', ...(tally.items_total > 0
        ? { note: `${tally.items_total} items attempted; no item errors.` } : {}) };
    }
    default: {
      const exhaustive: never = kind;
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

// D-181 slice 5b — display copy for the failed/killed long-op `error_category`
// (§12). The Runs feed + detail surface *why* a run ended without opening the
// audit. Keep the wording neutral + lowercase to match the status glyphs.
export const ERROR_CATEGORY_LABELS: Record<HeavyOpErrorCategory, string> = {
  timeout: 'timed out',
  oom: 'out of memory',
  crashed: 'crashed',
  stalled: 'stalled',
  killed: 'killed',
  cancelled_before_dispatch: 'cancelled before it was sent',
};

// D-182 — display copy for a cli (local-binary) step failure (the feed chip + the
// detail block). Neutral + lowercase to match the status glyphs.
export const CLI_FAILURE_LABELS: Record<CliFailureReason, string> = {
  not_found: 'tool not found',
  spawn_error: 'a tool would not start',
  nonzero_exit: 'tool error',
  timeout: 'tool timed out',
  bad_output: 'bad tool output',
  untested_version: 'tool version not tested',
  broken: 'tool does not start',
};
