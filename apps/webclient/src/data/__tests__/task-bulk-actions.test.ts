import { describe, expect, it, vi } from 'vitest';
import type { SourceRegistration, WorkEntity } from '@recued/contracts';
import { createTaskBulkActions, TASK_BULK_LIMIT } from '../task-bulk-actions.js';
import type { DataTaskMarkDoneCaller, DataWorkEntityGetCaller, DataWorkEntityUpsertCaller } from '../bootstrap-data-route.js';

type Task = Extract<WorkEntity, { _kind: 'task' }>;
const source: SourceRegistration = { id: 'recued.task', top_tier_kind: 'task', source_kind: 'builtin', source_label: 'My tasks', write_capable: true, registered_at: 1 };
const task = (id: string): Task => ({ _kind: 'task', id, title: 'Task ' + id, done: false, due_at: 123456789,
  source_id: source.id, sync_state: 'live', conflict_policy: 'recued_wins', last_seen_at: 1, created_at: 1, updated_at: 1, blocks_task_ids: [] });
const rig = (tasks = [task('a'), task('b')]) => {
  const stored = new Map(tasks.map(row => [row.id, { ...row }]));
  let visible = tasks, currentSources = [source], ready = true;
  const get = vi.fn<DataWorkEntityGetCaller>(async ({ id }) => ({ entity: stored.get(id) ?? null }));
  const update = vi.fn<DataWorkEntityUpsertCaller>(async args => {
    if (args.kind !== 'task' || !('id' in args) || typeof args.id !== 'string') throw new Error('Expected a task update.');
    const row = stored.get(args.id!)!;
    const patch = args as { due_at?: number; clear_due_at?: boolean };
    const next = { ...row, due_at: patch.clear_due_at ? undefined : patch.due_at };
    stored.set(row.id, next); return { entity: next };
  });
  const complete = vi.fn<DataTaskMarkDoneCaller>(async ({ id, done }) => {
    const next = { ...stored.get(id)!, done }; stored.set(id, next); return { entity: next };
  });
  const render = vi.fn(), begin = vi.fn(), settled = vi.fn();
  const controller = createTaskBulkActions({ rows: () => visible, sources: () => currentSources, ready: () => ready, get,
    listSources: async () => ({ sources: currentSources }), update, complete, render, begin, settled,
    confirmed: row => { visible = visible.map(old => old.id === row.id ? row : old); } });
  return { controller, stored, get, update, complete, render, begin, settled,
    visible: (rows: Task[]) => { visible = rows; }, sources: (rows: SourceRegistration[]) => { currentSources = rows; },
    ready: (value: boolean) => { ready = value; } };
};

describe('owner-selected task batches', () => {
  it('sets an exact whole-day due and clears only that field without replaying stale task content', async () => {
    const r = rig(); r.controller.handleAction('task-bulk-all');
    r.stored.set('a', { ...r.stored.get('a')!, title: 'Changed elsewhere', body: 'Keep this newer body' });
    r.controller.setDate('2026-02-30'); await r.controller.submit('date');
    expect(r.update).not.toHaveBeenCalled(); expect(r.controller.render()).toContain('Choose a valid due date');
    r.controller.setDate('2026-11-01'); await r.controller.submit('date');
    expect(r.update.mock.calls.map(([args]) => args)).toEqual([
      { kind: 'task', id: 'a', due_at: Date.UTC(2026, 10, 1) }, { kind: 'task', id: 'b', due_at: Date.UTC(2026, 10, 1) },
    ]);
    expect(r.stored.get('a')).toMatchObject({ title: 'Changed elsewhere', body: 'Keep this newer body' });
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed']);
    r.controller.reset(); r.controller.handleAction('task-bulk-all'); await r.controller.submit('clear');
    expect(r.update.mock.calls.slice(2).map(([args]) => args)).toEqual([
      { kind: 'task', id: 'a', clear_due_at: true }, { kind: 'task', id: 'b', clear_due_at: true },
    ]);
    expect(r.stored.get('a')?.due_at).toBeUndefined();
  });

  it('continues after a failure, retries only failures, and reconciles a completion whose reply was lost', async () => {
    const r = rig([task('a'), task('b'), task('c')]);
    const save = r.complete.getMockImplementation()!;
    r.complete.mockImplementation(async args => {
      if (args.id === 'b' && !r.complete.mock.calls.slice(0, -1).some(([call]) => call.id === 'b')) throw new Error('Interrupted before write');
      const out = await save(args);
      if (args.id === 'c') {
        r.stored.set('c', { ...r.stored.get('c')!, pending_write: { staged_at: 1, operation: 'update',
          dirty_fields: ['done'], state: 'awaiting_verify' } });
        throw new Error('Reply lost after write');
      }
      return out;
    });
    r.controller.handleAction('task-bulk-all'); await r.controller.submit('complete');
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'failed', 'failed']);
    await r.controller.retry();
    expect(r.complete.mock.calls.map(([args]) => args.id)).toEqual(['a', 'b', 'c', 'b']);
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed', 'unconfirmed']);
    const confirmed = { ...r.stored.get('c')! }; delete confirmed.pending_write; r.stored.set('c', confirmed);
    await r.controller.retry(true);
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(r.begin).toHaveBeenCalledTimes(3); expect(r.settled).toHaveBeenCalledTimes(3);
  });

  it('keeps pending and mismatched receipts unconfirmed, and checks them without dispatching another write', async () => {
    const r = rig(); const save = r.update.getMockImplementation()!;
    r.update.mockImplementation(async args => {
      if (args.kind !== 'task' || !('id' in args) || typeof args.id !== 'string') throw new Error('Expected a task update.');
      const out = await save(args);
      if (args.id === 'a') {
        const pending = { ...(out.entity as Task), pending_write: { staged_at: 1, operation: 'update' as const,
          dirty_fields: ['due_at'], state: 'awaiting_verify' as const } };
        r.stored.set('a', pending); return { entity: pending };
      }
      return { entity: { ...out.entity, id: 'wrong-task', pending_write: { staged_at: 1, operation: 'update',
        dirty_fields: ['due_at'], state: 'awaiting_verify' } } };
    });
    r.controller.handleAction('task-bulk-all'); await r.controller.submit('clear');
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['unconfirmed', 'unconfirmed']);
    expect(r.controller.snapshot()[1]?.message).toContain('did not confirm');
    await r.controller.retry(); expect(r.update).toHaveBeenCalledTimes(2);
    await r.controller.retry(true);
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['unconfirmed', 'confirmed']);
    const confirmed = { ...r.stored.get('a')! }; delete confirmed.pending_write; r.stored.set('a', confirmed);
    await r.controller.retry(true);
    expect(r.update).toHaveBeenCalledTimes(2);
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed']);
  });

  it('rechecks permissions, original identity and deletion before dispatching each selected task', async () => {
    const external = { ...source, id: 'external', source_kind: 'connection' as const };
    const r = rig([{ ...task('a'), source_id: external.id }, task('b'), task('c')]);
    r.sources([source, external]); r.controller.handleAction('task-bulk-all');
    r.sources([source, { ...external, write_capable: false }]);
    r.stored.set('b', { ...task('b'), created_at: 2 }); r.stored.delete('c');
    await r.controller.submit('complete');
    expect(r.complete).not.toHaveBeenCalled();
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['failed', 'failed', 'failed']);
    expect(r.controller.snapshot()[0]?.message).toContain('read-only');
    expect(r.controller.snapshot()[1]?.message).toContain('identity');
  });

  it('leaves a newly pending task retryable when this batch has not written it', async () => {
    const r = rig(); r.controller.handleAction('task-bulk-all');
    r.stored.set('b', { ...task('b'), pending_write: { staged_at: 1, operation: 'update',
      dirty_fields: ['title'], state: 'awaiting_verify' } });
    await r.controller.submit('clear');
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'failed']);
    expect(r.controller.snapshot()[1]?.message).toContain('has not changed this task');
    await r.controller.retry(); expect(r.update).toHaveBeenCalledTimes(1);
    const ready = { ...r.stored.get('b')! }; delete ready.pending_write; r.stored.set('b', ready);
    await r.controller.retry();
    expect(r.update).toHaveBeenLastCalledWith({ kind: 'task', id: 'b', clear_due_at: true });
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed']);
  });

  it('holds one batch in flight, stops before the next task, and retires a disposed read before it can write', async () => {
    const r = rig(); let release!: (value: Awaited<ReturnType<DataTaskMarkDoneCaller>>) => void;
    r.complete.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    r.controller.handleAction('task-bulk-all'); const pending = r.controller.submit('complete');
    await vi.waitFor(() => expect(r.complete).toHaveBeenCalledTimes(1));
    expect(r.controller.submit('complete')).toBe(pending); expect(r.controller.retry()).toBe(pending);
    r.controller.handleAction('task-bulk-stop'); release({ entity: { ...task('a'), done: true } }); await pending;
    expect(r.complete).toHaveBeenCalledTimes(1);
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'failed']);
    expect(r.controller.snapshot()[1]?.message).toContain('Not started');
    const retired = rig(); let answer!: (value: Awaited<ReturnType<DataWorkEntityGetCaller>>) => void;
    retired.get.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    retired.controller.handleAction('task-bulk-all'); const old = retired.controller.submit('complete');
    retired.controller.dispose(); answer({ entity: task('a') }); await old;
    expect(retired.complete).not.toHaveBeenCalled(); expect(retired.settled).not.toHaveBeenCalled();
  });

  it('selects only eligible shown tasks, waits for a current list, and drops selection hidden by a new list', async () => {
    const tasks = Array.from({ length: TASK_BULK_LIMIT + 5 }, (_, i) => task(String(i)));
    const readOnly = { ...source, id: 'read-only', write_capable: false };
    const r = rig([...tasks, { ...task('done'), done: true }, { ...task('readonly'), source_id: readOnly.id }]);
    r.sources([source, readOnly]); r.controller.handleAction('task-bulk-all');
    expect(r.controller.selection().selected_ids.size).toBe(TASK_BULK_LIMIT);
    r.controller.toggle('readonly', true); expect(r.controller.selection().selected_ids.has('readonly')).toBe(false);
    r.visible(tasks.slice(0, 2)); expect([...r.controller.selection().selected_ids]).toEqual(['0', '1']);
    r.ready(false); await r.controller.submit('complete'); expect(r.complete).not.toHaveBeenCalled();
    expect(r.controller.selection()).toMatchObject({ busy: true });
    expect(r.controller.selection().selected_ids.size).toBe(2);
    r.ready(true);
    r.visible([]); expect(r.controller.selection().selected_ids.size).toBe(0);
  });
});
