/** D-201 Slice 10N — the value an approved step returned before a restart
 *  stopped its run, kept for the next start to finish the run with.
 *  D-201 Slice 10R — with every later step that had finished, and the run's
 *  alias ledgers then. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuditEntry } from '@recued/storage';
import type { Checkpoint } from '@recued/contracts';
import {
  createApprovalRestartContinuationStore,
  createHeldRunPass,
  sweepApprovalRestartContinuations,
  sweepHeldApprovalRuns,
} from '../storage/approval-restart-continuation-store.js';

const dbs: Database.Database[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()!.close();
});
const open = () => {
  const db = new Database(':memory:');
  dbs.push(db);
  return db;
};

describe('D-201 Slice 10N — approval restart continuations', () => {
  it('keeps a value per answered checkpoint, across store handles, until it is removed', () => {
    const db = open();
    const store = createApprovalRestartContinuationStore(db, () => 7);
    store.put({ checkpoint_id: 'cp-1', run_id: 'run-1', gated_step_id: 'refund', value: { closed: true, n: [1, 2] }, later: [] });
    // The next start opens its own handle on the same database.
    const reopened = createApprovalRestartContinuationStore(db);
    expect(reopened.get('cp-1')).toEqual({
      checkpoint_id: 'cp-1', run_id: 'run-1', gated_step_id: 'refund', value: { closed: true, n: [1, 2] }, later: [], created_at: 7,
    });
    expect(reopened.get('cp-2')).toBeNull();
    reopened.delete('cp-1');
    expect(store.get('cp-1')).toBeNull();
  });

  it('tells a null value from no value', () => {
    const store = createApprovalRestartContinuationStore(open());
    store.put({ checkpoint_id: 'null', run_id: 'run-1', gated_step_id: 's', value: null, later: [] });
    store.put({ checkpoint_id: 'absent', run_id: 'run-1', gated_step_id: 's', value: undefined, later: [] });
    expect(store.get('null')).toMatchObject({ value: null });
    expect(Object.hasOwn(store.get('absent')!, 'value')).toBe(true);
    expect(store.get('absent')!.value).toBeUndefined();
  });

  it('replaces the value a second stop keeps, and refuses a row with no identity', () => {
    const store = createApprovalRestartContinuationStore(open());
    store.put({ checkpoint_id: 'cp-1', run_id: 'run-1', gated_step_id: 's', value: 1, later: [] });
    store.put({ checkpoint_id: 'cp-1', run_id: 'run-1', gated_step_id: 's', value: 2, later: [{ step_id: 'next', skipped: false, value: 3 }] });
    expect(store.get('cp-1')).toMatchObject({ value: 2, later: [{ step_id: 'next', skipped: false, value: 3 }] });
    expect(() => store.put({ checkpoint_id: '', run_id: 'run-1', gated_step_id: 's', value: 1, later: [] })).toThrow();
  });
});

describe('D-201 Slice 10R — every finished step, and the alias ledgers', () => {
  it('keeps each later step as it came out, in order: a value, a skip, a null, and no value at all', () => {
    const store = createApprovalRestartContinuationStore(open());
    store.put({
      checkpoint_id: 'cp-1', run_id: 'run-1', gated_step_id: 'remove', value: null,
      later: [
        { step_id: 'create', skipped: false, value: { id: 'deal-2' } },
        { step_id: 'notify', skipped: true },
        { step_id: 'cleared', skipped: false, value: null },
        { step_id: 'nothing', skipped: false },
      ],
      pii_ledgers: { sid: 4, ledger_seq: 2 } as never,
    });
    const kept = store.get('cp-1')!;
    expect(kept.later).toEqual([
      { step_id: 'create', skipped: false, value: { id: 'deal-2' } },
      { step_id: 'notify', skipped: true },
      { step_id: 'cleared', skipped: false, value: null },
      { step_id: 'nothing', skipped: false },
    ]);
    expect(Object.hasOwn(kept.later![3]!, 'value')).toBe(false);
    expect(kept.pii_ledgers).toEqual({ sid: 4, ledger_seq: 2 });
  });

  it('reads a row from before 10R, or with a malformed list, as not knowing what ran after the step', () => {
    const db = open();
    const store = createApprovalRestartContinuationStore(db);
    // As a 10N server wrote it: the approved step's value alone.
    db.prepare(`INSERT INTO approval_restart_continuations
      (checkpoint_id, run_id, gated_step_id, value_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run('old', 'run-1', 'refund', JSON.stringify({ value: { closed: true } }), 1);
    db.prepare(`INSERT INTO approval_restart_continuations
      (checkpoint_id, run_id, gated_step_id, value_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run('bent', 'run-1', 'refund', JSON.stringify({ value: 1, later: [{ step_id: 2 }] }), 1);
    expect(store.get('old')).toMatchObject({ value: { closed: true }, later: undefined });
    expect(store.get('bent')!.later).toBeUndefined();
  });

  it('lists what it keeps, and the start sweeps a row whose checkpoint is gone', async () => {
    const store = createApprovalRestartContinuationStore(open());
    store.put({ checkpoint_id: 'live', run_id: 'run-1', gated_step_id: 's', value: 1, later: [] });
    store.put({ checkpoint_id: 'gone', run_id: 'run-2', gated_step_id: 's', value: 1, later: [] });
    store.put({ checkpoint_id: 'unreadable', run_id: 'run-3', gated_step_id: 's', value: 1, later: [] });
    expect(store.list().sort()).toEqual(['gone', 'live', 'unreadable']);
    const removed = await sweepApprovalRestartContinuations({
      continuations: store,
      hasCheckpoint: async (id) => {
        if (id === 'unreadable') throw new Error('checkpoint store unavailable');
        return id === 'live';
      },
    });
    // Only a row whose checkpoint is provably gone goes; a failed read keeps it.
    expect(removed).toBe(1);
    expect(store.list().sort()).toEqual(['live', 'unreadable']);
  });
});

describe('D-201 Slice 10W — the row first, an unsent stop, and a run held for its try again', () => {
  const checkpoint = { checkpoint_id: 'cp-held', run_id: 'run-held', gated_step_id: 'close', step_state: { read: { ok: true } } } as unknown as Checkpoint;
  const anchor = { run_id: 'run-held', recipe_id: 'refund', commit_status: 'awaiting_approval', checkpoint_id: 'cp-held' } as unknown as AuditEntry;
  const held = (store: ReturnType<typeof createApprovalRestartContinuationStore>, runId = 'run-held', checkpointId = 'cp-held') =>
    store.put({
      checkpoint_id: checkpointId,
      run_id: runId,
      gated_step_id: 'close',
      value: { closed: true },
      later: [{ step_id: 'tell_one', skipped: false, value: { sent: 1 } }],
      held: { checkpoint, anchor, approved_returned: true, step_in_doubt: 'tell_two' },
    });

  it('keeps an unsent stop and its paused record, and reads them back', () => {
    const store = createApprovalRestartContinuationStore(open(), () => 3);
    store.put({ checkpoint_id: 'cp-1', run_id: 'run-1', gated_step_id: 'close', value: undefined, later: [], unsent: true, paused_anchor: anchor });
    expect(store.get('cp-1')).toEqual({
      checkpoint_id: 'cp-1', run_id: 'run-1', gated_step_id: 'close', value: undefined, later: [], unsent: true,
      paused_anchor: anchor, created_at: 3,
    });
  });

  it('keeps a held run whole, finds it by its run, and leaves it out of the checkpoint sweep', async () => {
    const db = open();
    const store = createApprovalRestartContinuationStore(db, () => 5);
    held(store);
    store.put({ checkpoint_id: 'cp-kept', run_id: 'run-kept', gated_step_id: 'close', value: 1, later: [] });
    expect(store.getHeldForRun('run-held')).toEqual({
      checkpoint_id: 'cp-held', run_id: 'run-held', gated_step_id: 'close', value: { closed: true },
      later: [{ step_id: 'tell_one', skipped: false, value: { sent: 1 } }],
      held: { checkpoint, anchor, approved_returned: true, step_in_doubt: 'tell_two' },
      created_at: 5,
    });
    expect(store.getHeldForRun('run-kept')).toBeNull();
    expect(store.list()).toEqual(['cp-kept']);
    expect(store.listHeld()).toEqual([{ checkpoint_id: 'cp-held', run_id: 'run-held' }]);
    // Its checkpoint is gone by design: the answer's sweep never drops it.
    await sweepApprovalRestartContinuations({ continuations: store, hasCheckpoint: async () => false });
    expect(store.getHeldForRun('run-held')).not.toBeNull();
    expect(store.get('cp-kept')).toBeNull();
  });

  it('moves a held row to another ask in one write: a fault leaves it where it was, never both (D-201 Slice 10AK, 10AI finding 15)', () => {
    const db = open();
    const store = createApprovalRestartContinuationStore(db, () => 5);
    held(store);
    const moved = {
      checkpoint_id: 'cp-asked',
      run_id: 'run-held',
      gated_step_id: 'close_again',
      value: undefined,
      later: [],
      held: { checkpoint, anchor, approved_returned: false, step_in_doubt: 'close_again' },
    };
    // A value that cannot be written fails inside the transaction: the row
    // stays where it was, and nothing is written at the ask.
    expect(() => store.move('cp-held', { ...moved, value: { amount: 10n } })).toThrow();
    expect(store.get('cp-held')?.held).toMatchObject({ step_in_doubt: 'tell_two' });
    expect(store.get('cp-asked')).toBeNull();
    // So does a delete that fails after the write: the write is undone with it.
    db.exec(`CREATE TRIGGER busy BEFORE DELETE ON approval_restart_continuations
      BEGIN SELECT RAISE(ABORT, 'the database is busy'); END`);
    expect(() => store.move('cp-held', moved)).toThrow('the database is busy');
    expect(store.get('cp-asked')).toBeNull();
    expect(store.listHeld()).toEqual([{ checkpoint_id: 'cp-held', run_id: 'run-held' }]);
    db.exec('DROP TRIGGER busy');
    store.move('cp-held', moved);
    expect(store.get('cp-held')).toBeNull();
    expect(store.getHeldForRun('run-held')).toMatchObject({ checkpoint_id: 'cp-asked', held: { step_in_doubt: 'close_again' } });
    expect(store.listHeld()).toEqual([{ checkpoint_id: 'cp-asked', run_id: 'run-held' }]);
    // To the row's own ask, it is replaced.
    store.move('cp-asked', { ...moved, held: { ...moved.held, failed: true } });
    expect(store.listHeld()).toEqual([{ checkpoint_id: 'cp-asked', run_id: 'run-held' }]);
    expect(store.get('cp-asked')?.held?.failed).toBe(true);
  });

  it('reads a held row that does not read whole as no held row', () => {
    const db = open();
    const store = createApprovalRestartContinuationStore(db);
    held(store);
    db.prepare('UPDATE approval_restart_continuations SET value_json = ? WHERE checkpoint_id = ?')
      .run(JSON.stringify({ value: 1, later: [], held: { checkpoint, approved_returned: true } }), 'cp-held');
    expect(store.get('cp-held')?.held).toBeUndefined();
  });

  it("the start drops a held run whose delivery no longer waits, and releases what it kept; one still open stays", () => {
    const store = createApprovalRestartContinuationStore(open());
    held(store, 'run-closed', 'cp-closed');
    held(store, 'run-open', 'cp-open');
    const released: string[] = [];
    expect(sweepHeldApprovalRuns({
      continuations: store,
      stillHeld: (runId) => runId === 'run-open',
      release: (runId) => { released.push(runId); },
    })).toBe(1);
    expect(released).toEqual(['run-closed']);
    expect(store.getHeldForRun('run-closed')).toBeNull();
    expect(store.getHeldForRun('run-open')).not.toBeNull();
  });
});

describe('D-201 Slice 10AB — a failed try again, a kept run by its run, and the outbox pass', () => {
  const checkpoint = { checkpoint_id: 'cp-held', run_id: 'run-held', gated_step_id: 'close', step_state: {} } as unknown as Checkpoint;
  const anchor = { run_id: 'run-held', recipe_id: 'refund', commit_status: 'awaiting_approval', checkpoint_id: 'cp-held' } as unknown as AuditEntry;

  it('keeps a held run that failed, and the step it failed at, and a progress unknown, and reads them back', () => {
    const store = createApprovalRestartContinuationStore(open());
    store.put({
      checkpoint_id: 'cp-held', run_id: 'run-held', gated_step_id: 'close', value: 1, later: [],
      held: { checkpoint, anchor, approved_returned: true, step_in_doubt: 'tell_three', failed: true, progress_unknown: true },
    });
    expect(store.getHeldForRun('run-held')?.held).toEqual({
      checkpoint, anchor, approved_returned: true, step_in_doubt: 'tell_three', failed: true, progress_unknown: true,
    });
  });

  it('tells a run kept for the next start from a held one and from none (10AA finding 6)', () => {
    const store = createApprovalRestartContinuationStore(open());
    store.put({ checkpoint_id: 'cp-kept', run_id: 'run-kept', gated_step_id: 'close', value: 1, later: [] });
    store.put({
      checkpoint_id: 'cp-held', run_id: 'run-held', gated_step_id: 'close', value: 1, later: [],
      held: { checkpoint, anchor, approved_returned: true, step_in_doubt: 'tell_two' },
    });
    expect(store.hasKeptForRun('run-kept')).toBe(true);
    expect(store.hasKeptForRun('run-held')).toBe(false);
    expect(store.hasKeptForRun('run-none')).toBe(false);
    const pass = createHeldRunPass({ continuations: store, stillHeld: () => true, release: () => undefined });
    expect(pass.hasKeptRun('run-kept')).toBe(true);
    expect(pass.hasKeptRun('run-held')).toBe(false);
  });

  it("the outbox pass sweeps held runs whose dead letter is gone; with no store it keeps and holds nothing (10AA finding 14)", () => {
    const store = createApprovalRestartContinuationStore(open());
    store.put({
      checkpoint_id: 'cp-held', run_id: 'run-held', gated_step_id: 'close', value: 1, later: [],
      held: { checkpoint, anchor, approved_returned: true, step_in_doubt: 'tell_two' },
    });
    const released: string[] = [];
    const open_ = new Set(['run-held']);
    const pass = createHeldRunPass({
      continuations: store,
      stillHeld: (runId) => open_.has(runId),
      release: (runId) => { released.push(runId); },
    });
    expect(pass.sweep()).toBe(0);
    open_.delete('run-held');
    expect(pass.sweep()).toBe(1);
    expect(released).toEqual(['run-held']);
    expect(store.getHeldForRun('run-held')).toBeNull();
    const none = createHeldRunPass({ continuations: undefined, stillHeld: () => false, release: () => { throw new Error('never'); } });
    expect(none.sweep()).toBe(0);
    expect(none.hasKeptRun('run-kept')).toBe(false);
  });
});

describe('D-201 Slice 10BC (10AY finding 9) — a held row marked behind the run', () => {
  const checkpoint = { checkpoint_id: 'cp-held', run_id: 'run-held', gated_step_id: 'close', step_state: {} } as unknown as Checkpoint;
  const anchor = { run_id: 'run-held', recipe_id: 'refund', commit_status: 'awaiting_approval', checkpoint_id: 'cp-held' } as unknown as AuditEntry;
  it('marks a held row and writes nothing else; a kept row, or none, is not marked', () => {
    const db = open();
    const store = createApprovalRestartContinuationStore(db, () => 7);
    store.put({
      checkpoint_id: 'cp-held', run_id: 'run-held', gated_step_id: 'close', value: { closed: true },
      later: [{ step_id: 'tell_one', skipped: false, value: { sent: 1 } }],
      held: { checkpoint, anchor, approved_returned: true, step_in_doubt: 'tell_two' },
    });
    store.put({ checkpoint_id: 'cp-kept', run_id: 'run-kept', gated_step_id: 'close', value: 1, later: [] });
    const before = store.get('cp-held')!;
    expect(store.markLaterRunAgain('cp-held')).toBe(true);
    expect(store.markLaterRunAgain('cp-kept')).toBe(false);
    expect(store.markLaterRunAgain('cp-none')).toBe(false);
    // Another handle reads the mark, and every other field as it was.
    const reopened = createApprovalRestartContinuationStore(db);
    expect(reopened.get('cp-held')).toEqual({ ...before, held: { ...before.held, later_run_again: true } });
    expect(reopened.get('cp-held')?.held?.later_run_again).toBe(true);
    expect(reopened.get('cp-kept')).not.toHaveProperty('held');
    // Marked again, it stays as it is.
    expect(store.markLaterRunAgain('cp-held')).toBe(true);
    expect(store.get('cp-held')).toEqual(reopened.get('cp-held'));
  });

  it('marks a row whose values the next row could not store: the mark stores none of them again', () => {
    const store = createApprovalRestartContinuationStore(open());
    store.put({
      checkpoint_id: 'cp-held', run_id: 'run-held', gated_step_id: 'close', value: 1, later: [],
      held: { checkpoint, anchor, approved_returned: true, step_in_doubt: 'tell_one' },
    });
    // A value JSON cannot hold refuses the row that would carry it.
    expect(() => store.put({
      checkpoint_id: 'cp-held', run_id: 'run-held', gated_step_id: 'close', value: 1,
      later: [{ step_id: 'tell_one', skipped: false, value: 10n }],
      held: { checkpoint, anchor, approved_returned: true, step_in_doubt: 'tell_two' },
    })).toThrow();
    expect(store.markLaterRunAgain('cp-held')).toBe(true);
    expect(store.get('cp-held')?.held).toMatchObject({ step_in_doubt: 'tell_one', later_run_again: true });
  });
});

describe('D-201 Slice 10BO (10BM findings 2 and 7) — a kept row past a skipped step, and a row written ahead', () => {
  const checkpoint = { checkpoint_id: 'cp-held', run_id: 'run-held', gated_step_id: 'close', step_state: {} } as unknown as Checkpoint;
  const anchor = { run_id: 'run-held', recipe_id: 'refund', commit_status: 'awaiting_approval', checkpoint_id: 'cp-held' } as unknown as AuditEntry;
  it('keeps a row for the next start past a skipped step as one, and a held row written ahead as one, across handles', () => {
    const db = open();
    const store = createApprovalRestartContinuationStore(db, () => 9);
    store.put({ checkpoint_id: 'cp-kept', run_id: 'run-kept', gated_step_id: 'close', value: null, later: [], approved_skipped: true });
    store.put({ checkpoint_id: 'cp-plain', run_id: 'run-plain', gated_step_id: 'close', value: 1, later: [] });
    store.put({
      checkpoint_id: 'cp-held', run_id: 'run-held', gated_step_id: 'close', value: { closed: true }, later: [],
      held: { checkpoint, anchor, approved_returned: true, step_in_doubt: 'tell_one', receipt_unsettled: true },
    });
    const reopened = createApprovalRestartContinuationStore(db);
    expect(reopened.get('cp-kept')).toEqual({
      checkpoint_id: 'cp-kept', run_id: 'run-kept', gated_step_id: 'close', value: null, later: [],
      approved_skipped: true, created_at: 9,
    });
    expect(reopened.get('cp-plain')).not.toHaveProperty('approved_skipped');
    expect(reopened.get('cp-held')?.held).toMatchObject({ receipt_unsettled: true });
    // A mark behind the run keeps it.
    expect(reopened.markLaterRunAgain('cp-held')).toBe(true);
    expect(reopened.get('cp-held')?.held).toMatchObject({ receipt_unsettled: true, later_run_again: true });
  });
});
