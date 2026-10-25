import { describe, expect, it } from 'vitest';
import type { ActiveExecutionEntry, RunAnchorStatus, RunYield } from '@recued/contracts';
import { activeWorkGroups, historyOutcome } from '../logs/run-management.js';

const tally = (total: number, failed: number, stopped_at?: string | null): RunYield => ({
  steps_run: 2, steps_skipped: 1, items_total: total, items_failed: failed,
  ...(stopped_at === undefined ? {} : { stopped_at }),
});
const outcome = (status: RunAnchorStatus, run_yield?: RunYield) => historyOutcome({
  status, ...(run_yield === undefined ? {} : { run_yield }),
});

describe('History outcomes', () => {
  it('separates a successful finish, partial result, all refused and recipe stop', () => {
    expect(outcome('succeeded', tally(12, 0)).kind).toBe('finished');
    expect(outcome('succeeded', tally(12, 3))).toMatchObject({ kind: 'partial', label: 'Partial result', note: '3 of 12 items failed.' });
    expect(outcome('succeeded', tally(12, 12))).toMatchObject({ kind: 'refused', label: 'All items failed' });
    expect(outcome('succeeded', tally(0, 0, 'nothing_new'))).toMatchObject({ kind: 'stopped', label: 'Stopped early' });
  });

  it('keeps old, zero, and malformed tallies distinct', () => {
    expect(outcome('succeeded').note).toBe('Item results were not recorded.');
    expect(outcome('succeeded', tally(0, 0))).not.toHaveProperty('note');
    for (const value of [tally(2, 3), tally(2.5, 1), tally(Number.NaN, 0), tally(4, -1)]) {
      expect(outcome('succeeded', value)).toMatchObject({ kind: 'finished', note: 'Item results were not recorded.' });
    }
  });

  for (const [status, kind] of [
    ['failed', 'failed'], ['in_doubt', 'unknown'], ['awaiting_approval', 'waiting-owner'],
    ['awaiting_peer', 'waiting-peer'], ['running', 'active'], ['pending', 'pending'],
    ['cancelled', 'cancelled'], ['killed', 'stopped'],
  ] as const) {
    it(`keeps ${status} authoritative even when item counters are present`, () => {
      for (const yieldInfo of [tally(12, 0), tally(12, 3), tally(12, 12), tally(0, 0, 'stop')]) {
        expect(outcome(status, yieldInfo).kind).toBe(kind);
      }
    });
  }

  it('retains an early-stop qualifier alongside partial results', () => {
    expect(outcome('succeeded', tally(12, 3, 'stop')).note).toBe('3 of 12 items failed. Ended early.');
  });
});

describe('Active registry groups', () => {
  it('keeps entry order and distinct queued calls sharing a run id', () => {
    const base = { run_id: 'run-shared', progress: { stalled: false } };
    const running = { ...base, entry_kind: 'run', state: 'running' } as ActiveExecutionEntry;
    const queued = { ...base, entry_kind: 'queued-call', state: 'waiting_slot', queued_call_id: 'queue-one' } as ActiveExecutionEntry;
    const detached = { ...base, run_id: 'detached', entry_kind: 'detached-job', state: 'detached', progress: { stalled: true } } as ActiveExecutionEntry;
    const stopping = { ...base, run_id: 'stopping', entry_kind: 'run', state: 'stopping' } as ActiveExecutionEntry;
    const groups = activeWorkGroups([running, queued, detached, stopping]);
    expect(groups.inProgress).toEqual([running, detached, stopping]);
    expect(groups.queued).toEqual([queued]);
    expect(groups.stalled).toBe(1);
  });

  it('reports an empty snapshot without inventing work', () => {
    expect(activeWorkGroups([])).toEqual({ inProgress: [], queued: [], stalled: 0 });
  });
});


it('distinguishes recorded owner stops and pre-dispatch cancellation from execution failure', () => {
  expect(historyOutcome({ status: 'failed', error_category: 'killed' }).kind).toBe('stopped');
  expect(historyOutcome({ status: 'failed', error_category: 'cancelled_before_dispatch' }).kind).toBe('cancelled');
  expect(historyOutcome({ status: 'failed', error_category: 'timeout' }).kind).toBe('failed');
});
