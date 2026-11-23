import { describe, expect, it, vi } from 'vitest';
import type { SourceRegistration, WorkEntity, WorkEntityProjectItem } from '@recued/contracts';
import { createProjectTaskActions } from '../project-task-actions.js';
import type { DataTaskMarkDoneCaller, DataWorkEntityGetCaller, WorkEntitySourceListCaller } from '../bootstrap-data-route.js';

type Task = Extract<WorkEntity, { _kind: 'task' }>;
const project: Extract<WorkEntity, { _kind: 'project' }> = { _kind: 'project', id: 'p', title: 'Launch', state: 'active',
  source_id: 'recued.project', sync_state: 'live', conflict_policy: 'recued_wins', created_at: 10, updated_at: 10,
  last_seen_at: 10, last_activity_at: 10, related_contact_ids: [] };
const task: Task = { _kind: 'task', id: 'a', title: 'Ship it', body: 'Keep this body', done: false, parent_project_id: 'p',
  source_id: 'recued.task', source_record_id: 'provider-a', sync_state: 'live', conflict_policy: 'recued_wins',
  created_at: 10, updated_at: 10, last_seen_at: 10, blocks_task_ids: [] };
const source: SourceRegistration = { id: 'recued.task', top_tier_kind: 'task', source_kind: 'builtin', source_label: 'Tasks', write_capable: true, registered_at: 10 };
const rig = () => {
  let currentTask = structuredClone(task), currentProject = structuredClone(project);
  let items: WorkEntityProjectItem[] = [{ id: task.id, title: task.title, excerpt: '', done: false, source_id: task.source_id,
    source_record_id: task.source_record_id, created_at: task.created_at, source_label: 'Tasks', updated_at: 10, stale: false, pending_write: false }];
  const get = vi.fn<DataWorkEntityGetCaller>(async args => ({ entity: structuredClone(args.kind === 'task' ? currentTask : currentProject) }));
  const listSources = vi.fn<WorkEntitySourceListCaller>(async () => ({ sources: [source] }));
  const complete = vi.fn<DataTaskMarkDoneCaller>(async args => {
    currentTask = { ...currentTask, done: args.done }; return { entity: structuredClone(currentTask) };
  });
  const confirmed = vi.fn(async (entity: Task) => { items = items.map(item => item.id === entity.id ? { ...item, done: entity.done } : item); });
  const controller = createProjectTaskActions({ project: () => project, items: () => items, ready: () => true,
    sources: () => [source], get, listSources, complete, confirmed, changed: vi.fn(), begin: vi.fn() });
  return { controller, get, listSources, complete, confirmed,
    task: () => currentTask, setTask: (next: Task) => { currentTask = next; },
    setProject: (next: typeof project) => { currentProject = next; } };
};
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('project inline task changes', () => {
  it('completes and reopens with explicit lifecycle writes while preserving newer task fields', async () => {
    const r = rig(); r.setTask({ ...r.task(), title: 'Changed elsewhere', body: 'A newer body', due_at: 123 });
    await r.controller.change('a', true); await r.controller.change('a', false);
    expect(r.complete.mock.calls.map(([args]) => args)).toEqual([{ id: 'a', done: true }, { id: 'a', done: false }]);
    expect(r.task()).toMatchObject({ title: 'Changed elsewhere', body: 'A newer body', due_at: 123, done: false });
    expect(r.controller.feedback()).toMatchObject({ state: 'confirmed', message: 'Task reopened.' });
    expect(r.listSources).toHaveBeenCalledTimes(2);
  });

  it('confirms an already achieved state from the current task without another write', async () => {
    const r = rig(); r.setTask({ ...r.task(), done: true }); await r.controller.change('a', true);
    expect(r.complete).not.toHaveBeenCalled(); expect(r.confirmed).toHaveBeenCalledOnce();
    expect(r.controller.feedback()).toMatchObject({ state: 'confirmed', message: 'Task is completed.' });
  });

  it.each(['task identity', 'project identity', 'project link', 'source identity'] as const)('rejects a changed %s before dispatch', async field => {
    const r = rig();
    if (field === 'task identity') r.setTask({ ...r.task(), created_at: 11 });
    if (field === 'source identity') r.setTask({ ...r.task(), source_record_id: 'replacement' });
    if (field === 'project link') r.setTask({ ...r.task(), parent_project_id: 'other' });
    if (field === 'project identity') r.setProject({ ...project, created_at: 11 });
    await r.controller.change('a', true);
    expect(r.complete).not.toHaveBeenCalled(); expect(r.controller.feedback()).toMatchObject({ state: 'failed', message: expect.stringContaining('changed') });
  });

  it('rechecks revoked and read-through permissions rather than trusting the visible source', async () => {
    const r = rig(); r.listSources.mockResolvedValue({ sources: [{ ...source, write_capable: false }] });
    await r.controller.change('a', true); expect(r.complete).not.toHaveBeenCalled();
    r.listSources.mockResolvedValue({ sources: [{ ...source, sync_posture: 'read_through' }] });
    await r.controller.retry(); expect(r.complete).not.toHaveBeenCalled();
    r.listSources.mockResolvedValue({ sources: [source] }); await r.controller.retry();
    expect(r.complete).toHaveBeenCalledOnce(); expect(r.controller.feedback()?.state).toBe('confirmed');
  });

  it('checks a lost reply before allowing retry and confirms the applied result without writing again', async () => {
    const r = rig(), save = r.complete.getMockImplementation()!;
    r.complete.mockImplementation(async args => { await save(args); throw new Error('Lost reply'); });
    await r.controller.change('a', true); expect(r.controller.feedback()?.state).toBe('unconfirmed');
    await r.controller.retry(); await r.controller.change('a', true); expect(r.complete).toHaveBeenCalledOnce();
    await r.controller.retry(true); expect(r.complete).toHaveBeenCalledOnce();
    expect(r.controller.feedback()?.state).toBe('confirmed'); expect(r.confirmed).toHaveBeenCalledOnce();
  });

  it('permits an explicit retry only after a check proves that an unconfirmed change is not set', async () => {
    const r = rig(), save = r.complete.getMockImplementation()!;
    r.complete.mockRejectedValueOnce(new Error('No reply'));
    await r.controller.change('a', true); await r.controller.retry(true);
    expect(r.controller.feedback()?.state).toBe('failed'); expect(r.complete).toHaveBeenCalledOnce();
    r.complete.mockImplementation(save); await r.controller.retry();
    expect(r.complete).toHaveBeenCalledTimes(2); expect(r.task().done).toBe(true);
  });

  it('keeps provider-pending or mismatched receipts unconfirmed and checks without resending', async () => {
    const r = rig(); r.complete.mockImplementation(async args => {
      const pending: Task = { ...r.task(), done: args.done, pending_write: { staged_at: 11, operation: 'update', dirty_fields: ['done'], state: 'awaiting_verify' } };
      r.setTask(pending); return { entity: pending };
    });
    await r.controller.change('a', true); await r.controller.retry(true);
    expect(r.controller.feedback()?.state).toBe('unconfirmed'); expect(r.complete).toHaveBeenCalledOnce();
    const confirmed = { ...r.task() }; delete confirmed.pending_write; r.setTask(confirmed);
    await r.controller.retry(true); expect(r.controller.feedback()?.state).toBe('confirmed'); expect(r.complete).toHaveBeenCalledOnce();
    const mismatch = rig(); mismatch.complete.mockResolvedValue({ entity: { ...task, done: true, source_record_id: 'wrong-row' } });
    await mismatch.controller.change('a', true); expect(mismatch.controller.feedback()?.state).toBe('unconfirmed');
    expect(mismatch.confirmed).not.toHaveBeenCalled();
  });

  it('prevents duplicate clicks while checking and never dispatches after disposal', async () => {
    const r = rig(), gate = deferred<void>(), original = r.get.getMockImplementation()!;
    r.get.mockImplementation(async args => { await gate.promise; return original(args); });
    const pending = r.controller.change('a', true); void r.controller.change('a', true);
    expect(r.controller.busy()).toBe(true); expect(r.get).toHaveBeenCalledTimes(2);
    r.controller.dispose(); gate.resolve(); await pending;
    expect(r.complete).not.toHaveBeenCalled(); expect(r.confirmed).not.toHaveBeenCalled();
  });

  it('does not publish a late write result into an overview that has been disposed', async () => {
    const r = rig(), gate = deferred<{ entity: Task }>(), entered = deferred<void>();
    r.complete.mockImplementation(() => { entered.resolve(); return gate.promise; });
    const pending = r.controller.change('a', true); await entered.promise; r.controller.dispose();
    gate.resolve({ entity: { ...task, done: true } }); await pending;
    expect(r.complete).toHaveBeenCalledOnce(); expect(r.confirmed).not.toHaveBeenCalled();
  });

  it('does not turn a verified write into uncertainty when the subsequent list refresh fails', async () => {
    const r = rig(); r.confirmed.mockRejectedValue(new Error('List unavailable')); await r.controller.change('a', true);
    expect(r.controller.feedback()).toMatchObject({ state: 'confirmed', message: expect.stringContaining('could not be refreshed') });
    await r.controller.retry(); expect(r.complete).toHaveBeenCalledOnce();
  });
});
