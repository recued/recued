import { describe, expect, it, vi } from 'vitest';
import type { ContactRecord, SourceRegistration, WorkEntity } from '@recued/contracts';
import { createTaskBulkActions, TASK_BULK_LIMIT } from '../task-bulk-actions.js';
import type { DataTaskMarkDoneCaller, DataWorkEntityGetCaller, DataWorkEntityUpsertCaller } from '../bootstrap-data-route.js';

type Task = Extract<WorkEntity, { _kind: 'task' }>;
const source: SourceRegistration = { id: 'recued.task', top_tier_kind: 'task', source_kind: 'builtin', source_label: 'My tasks', write_capable: true, registered_at: 1 };
const projectSource: SourceRegistration = { ...source, id: 'recued.project', top_tier_kind: 'project', source_label: 'Projects', write_capable: false };
type Project = Extract<WorkEntity, { _kind: 'project' }>;
const project = (id: string): Project => ({ _kind: 'project', id, title: 'Project ' + id, state: 'active', source_id: projectSource.id,
  sync_state: 'live', conflict_policy: 'recued_wins', last_seen_at: 1, created_at: 1, updated_at: 1, last_activity_at: 1, related_contact_ids: [] });
const task = (id: string): Task => ({ _kind: 'task', id, title: 'Task ' + id, done: false, due_at: 123456789,
  source_id: source.id, sync_state: 'live', conflict_policy: 'recued_wins', last_seen_at: 1, created_at: 1, updated_at: 1, blocks_task_ids: [] });
const contact = (id: string): ContactRecord => ({ _collection: 'contact', _id: id + '@example.test', email: id + '@example.test', contact_id: 'contact-' + id,
  name: 'Contact ' + id, first_seen: 1, last_interaction: 1, interaction_count: 0, source: 'manual', created_at: 1, updated_at: 1 });
const rig = (tasks = [task('a'), task('b')]) => {
  const stored = new Map(tasks.map(row => [row.id, { ...row }]));
  const projects = new Map(['p1', 'p2'].map(id => [id, project(id)]));
  const contacts = new Map(['one', 'two'].map(id => { const row = contact(id); return [row.email, row]; }));
  const contactGet = vi.fn(async ({ email }: { email: string }) => ({ contact: contacts.get(email) ?? [...contacts.values()].find(row => row.contact_id === email) ?? null }));
  let visible = tasks, currentSources = [source, projectSource], ready = true;
  const get = vi.fn<DataWorkEntityGetCaller>(async ({ kind, id }) => ({ entity: kind === 'project' ? projects.get(id) ?? null : stored.get(id) ?? null }));
  const update = vi.fn<DataWorkEntityUpsertCaller>(async args => {
    if (args.kind !== 'task' || !('id' in args) || typeof args.id !== 'string') throw new Error('Expected a task update.');
    const row = stored.get(args.id!)!;
    const patch = args as { due_at?: number; clear_due_at?: boolean; priority?: Task['priority']; parent_project_id?: string; clear_parent_project?: boolean; assigned_contact_id?: string; clear_assigned_contact?: boolean };
    const next = { ...row, ...(patch.clear_due_at ? { due_at: undefined } : patch.due_at !== undefined ? { due_at: patch.due_at } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.clear_parent_project ? { parent_project_id: undefined } : patch.parent_project_id !== undefined ? { parent_project_id: patch.parent_project_id } : {}),
      ...(patch.clear_assigned_contact ? { assigned_contact_id: undefined } : patch.assigned_contact_id !== undefined ? { assigned_contact_id: patch.assigned_contact_id } : {}) };
    stored.set(row.id, next); return { entity: next };
  });
  const complete = vi.fn<DataTaskMarkDoneCaller>(async ({ id, done }) => {
    const next = { ...stored.get(id)!, done, completed_at: done ? 200 : undefined }; stored.set(id, next); return { entity: next };
  });
  const render = vi.fn(), begin = vi.fn(), settled = vi.fn();
  const controller = createTaskBulkActions({ rows: () => visible, sources: () => currentSources, ready: () => ready, get,
    listSources: async () => ({ sources: currentSources }), update, complete, render, begin, settled, contactGet,
    confirmed: row => { visible = visible.map(old => old.id === row.id ? row : old); } });
  return { controller, stored, projects, contacts, contactGet, get, update, complete, render, begin, settled,
    visible: (rows: Task[]) => { visible = rows; }, sources: (rows: SourceRegistration[]) => { currentSources = rows; },
    ready: (value: boolean) => { ready = value; } };
};

describe('owner-selected task batches', () => {
  it('sets each supported priority across open and completed tasks without replaying other fields', async () => {
    const r = rig([task('a'), { ...task('b'), done: true, completed_at: 100 }]);
    r.controller.handleAction('task-bulk-all'); await r.controller.submit('priority');
    r.controller.setPriority('urgent'); await r.controller.submit('priority'); expect(r.update).not.toHaveBeenCalled();
    expect(r.controller.render()).toContain('Choose Low, Medium, or High priority');
    r.stored.set('a', { ...task('a'), title: 'Updated elsewhere', body: 'Keep new notes', due_at: 999, parent_project_id: 'new-project' });
    for (const priority of ['low', 'medium', 'high'] as const) {
      r.controller.setPriority(priority); await r.controller.submit('priority');
      expect(r.update.mock.calls.slice(-2).map(([args]) => args)).toEqual([
        { kind: 'task', id: 'a', priority }, { kind: 'task', id: 'b', priority },
      ]);
      expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed']);
      expect(r.stored.get('b')).toMatchObject({ done: true, completed_at: 100, priority });
      r.controller.reset(); r.controller.handleAction('task-bulk-all');
    }
    expect(r.stored.get('a')).toMatchObject({ title: 'Updated elsewhere', body: 'Keep new notes', due_at: 999, parent_project_id: 'new-project' });
    expect(r.complete).not.toHaveBeenCalled();
  });

  it('reopens a mixed selection through the lifecycle RPC, skips already-open tasks and protects completed deadlines', async () => {
    const r = rig([task('a'), { ...task('b'), done: true, completed_at: 100 }]);
    r.controller.handleAction('task-bulk-all'); expect([...r.controller.selection().selected_ids]).toEqual(['a', 'b']);
    r.controller.setDate('2030-11-05'); await r.controller.submit('date'); await r.controller.submit('clear');
    expect(r.update).not.toHaveBeenCalled(); expect(r.controller.render()).toContain('Select only unfinished tasks');
    await r.controller.submit('reopen');
    expect(r.complete.mock.calls.map(([args]) => args)).toEqual([{ id: 'b', done: false }]);
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed']);
    expect(r.stored.get('b')).toMatchObject({ done: false, due_at: task('b').due_at }); expect(r.stored.get('b')?.completed_at).toBeUndefined();
    expect(r.update).not.toHaveBeenCalled();
  });

  it('reconciles lost priority replies and source-pending priority changes without a duplicate write', async () => {
    const r = rig(); const save = r.update.getMockImplementation()!;
    r.update.mockImplementation(async args => {
      const result = await save(args);
      if ('id' in args && args.id === 'a') throw new Error('Priority reply lost');
      const pending: Task = { ...(result.entity as Task), pending_write: { staged_at: 200, operation: 'update', dirty_fields: ['priority'], state: 'awaiting_verify' } };
      r.stored.set('b', pending); return { entity: pending };
    });
    r.controller.handleAction('task-bulk-all'); r.controller.setPriority('high'); await r.controller.submit('priority');
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['failed', 'unconfirmed']);
    await r.controller.retry(); await r.controller.retry(true); expect(r.update).toHaveBeenCalledTimes(2);
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'unconfirmed']);
    const confirmed = { ...r.stored.get('b')! }; delete confirmed.pending_write; r.stored.set('b', confirmed);
    await r.controller.retry(true); expect(r.update).toHaveBeenCalledTimes(2);
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed']);
  });

  it('reconciles a lost reopen and refuses to claim an unchanged completion or mismatched priority receipt', async () => {
    const r = rig([{ ...task('a'), done: true }, { ...task('b'), done: true }]); const save = r.complete.getMockImplementation()!;
    r.complete.mockImplementation(async args => {
      if (args.id === 'b') return { entity: r.stored.get('b')! };
      await save(args); throw new Error('Reopen reply lost');
    });
    r.controller.handleAction('task-bulk-all'); await r.controller.submit('reopen');
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['failed', 'unconfirmed']);
    await r.controller.retry(); await r.controller.retry(true); expect(r.complete).toHaveBeenCalledTimes(2);
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'unconfirmed']);
    const priority = rig(); priority.update.mockResolvedValue({ entity: { ...task('a'), priority: 'low' } });
    priority.controller.toggle('a', true); priority.controller.setPriority('high'); await priority.controller.submit('priority');
    expect(priority.controller.snapshot()[0]?.state).toBe('unconfirmed');
    await priority.controller.retry(true); expect(priority.update).toHaveBeenCalledTimes(1);
    expect(priority.controller.snapshot()[0]?.state).toBe('unconfirmed');
  });

  it('rechecks identity and writable Sources for priority and reopen, then freezes the chosen priority during a stopped batch', async () => {
    for (const kind of ['priority', 'reopen'] as const) {
      const r = rig([{ ...task('a'), done: true }, { ...task('b'), done: true }]);
      r.controller.handleAction('task-bulk-all'); r.controller.setPriority('high');
      r.sources([{ ...source, write_capable: false }]); r.stored.set('b', { ...task('b'), created_at: 999 });
      await r.controller.submit(kind); expect(r.update).not.toHaveBeenCalled(); expect(r.complete).not.toHaveBeenCalled();
      expect(r.controller.snapshot().map(row => row.state)).toEqual(['failed', 'failed']);
    }
    const r = rig(); const save = r.update.getMockImplementation()!;
    let release!: () => void; r.update.mockImplementationOnce(async args => { await new Promise<void>(done => { release = done; }); return save(args); });
    r.controller.handleAction('task-bulk-all'); r.controller.setPriority('high'); const run = r.controller.submit('priority');
    await vi.waitFor(() => expect(r.update).toHaveBeenCalledTimes(1)); r.controller.setPriority('low'); r.controller.handleAction('task-bulk-stop');
    release(); await run; expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'failed']);
    await r.controller.retry(); expect(r.update.mock.calls.map(([args]) => args)).toEqual([
      { kind: 'task', id: 'a', priority: 'high' }, { kind: 'task', id: 'b', priority: 'high' },
    ]);
  });

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

describe('selected task project changes', () => {
  it('previews moves and assignments, skips existing links, and patches only project ids across open and completed tasks', async () => {
    const r = rig([{ ...task('a'), parent_project_id: 'p1' }, { ...task('b'), done: true, completed_at: 99 }, { ...task('c'), parent_project_id: 'p2' }]);
    r.controller.handleAction('task-bulk-all'); await r.controller.previewProjects(); await r.controller.submit('project');
    expect(r.update).not.toHaveBeenCalled(); expect(r.controller.render()).toContain('Choose a project by name');
    r.controller.setProject({ id: 'p2', label: 'Stale label' }); await r.controller.previewProjects();
    expect(r.controller.render()).toContain('2 tasks will change · 1 skipped');
    expect(r.controller.render()).toContain('Project p1 · Projects → Project p2 · Projects');
    expect(r.controller.render()).toContain('No project → Project p2 · Projects');
    expect(r.controller.render()).toContain('Already in this project'); expect(r.update).not.toHaveBeenCalled();
    r.stored.set('a', { ...r.stored.get('a')!, title: 'New title', due_at: 456, priority: 'high', body: 'New body' });
    r.controller.setProject({ id: 'p1', label: 'Other project' }); await r.controller.submit('clear');
    expect(r.update).not.toHaveBeenCalled(); await r.controller.submit('project');
    expect(r.update.mock.calls.map(([args]) => args)).toEqual([{ kind: 'task', id: 'a', parent_project_id: 'p2' }, { kind: 'task', id: 'b', parent_project_id: 'p2' }]);
    expect(r.stored.get('a')).toMatchObject({ title: 'New title', due_at: 456, priority: 'high', body: 'New body', parent_project_id: 'p2' });
    expect(r.stored.get('b')).toMatchObject({ done: true, completed_at: 99, due_at: task('b').due_at });
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed', 'skipped']); expect(r.complete).not.toHaveBeenCalled();
  });

  it('removes only reviewed links, including unavailable old projects, while keeping unlinked tasks skipped', async () => {
    const r = rig([{ ...task('a'), parent_project_id: 'p1' }, task('b')]); r.projects.delete('p1');
    r.controller.handleAction('task-bulk-all'); await r.controller.previewProjects(true);
    expect(r.controller.render()).toContain('Unavailable project → No project'); expect(r.controller.render()).toContain('Already has no project');
    r.controller.handleAction('task-bulk-project-back'); expect([...r.controller.selection().selected_ids]).toEqual(['a', 'b']);
    await r.controller.submit('project'); expect(r.update).not.toHaveBeenCalled();
    await r.controller.previewProjects(true); await r.controller.submit('project');
    expect(r.update).toHaveBeenCalledExactlyOnceWith({ kind: 'task', id: 'a', clear_parent_project: true });
    expect(r.stored.get('a')!.parent_project_id).toBeUndefined(); expect(r.stored.get('a')!.due_at).toBe(task('a').due_at);
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'skipped']);
  });

  it('keeps failed destination lookups retryable and does not treat a missing target as removal', async () => {
    const r = rig([{ ...task('a'), parent_project_id: 'p1' }]); r.controller.toggle('a', true); r.controller.setProject({ id: 'p2', label: 'Project p2' });
    r.get.mockRejectedValueOnce(new Error('Project lookup interrupted')); await r.controller.previewProjects();
    await r.controller.submit('project'); expect(r.update).not.toHaveBeenCalled(); expect(r.controller.render()).toContain('Project lookup interrupted');
    r.controller.handleAction('task-bulk-project-retry'); await r.controller.whenSettled();
    expect(r.controller.render()).toContain('1 task will change');
    r.projects.delete('p2'); await r.controller.submit('project'); expect(r.update).not.toHaveBeenCalled();
    expect(r.controller.snapshot()[0]?.state).toBe('failed'); expect(r.stored.get('a')!.parent_project_id).toBe('p1');
    const missing = rig(); missing.controller.toggle('a', true); missing.controller.setProject({ id: 'missing', label: 'Missing' });
    await missing.controller.previewProjects(); await missing.controller.submit('project'); expect(missing.update).not.toHaveBeenCalled();
    expect(missing.controller.render()).toContain('project is unavailable');
  });

  it('skips links changed after review and reconciles a link already at its requested target without writing', async () => {
    const r = rig([task('a'), task('b'), { ...task('c'), parent_project_id: 'p1' }]);
    r.controller.handleAction('task-bulk-all'); r.controller.setProject({ id: 'p2', label: 'Project p2' }); await r.controller.previewProjects();
    r.stored.set('a', { ...task('a'), parent_project_id: 'p1' }); r.stored.set('b', { ...task('b'), parent_project_id: 'p2' });
    r.stored.set('c', task('c')); await r.controller.submit('project');
    expect(r.update).not.toHaveBeenCalled(); expect(r.controller.snapshot().map(row => row.state)).toEqual(['skipped', 'confirmed', 'skipped']);
    const removal = rig([{ ...task('a'), parent_project_id: 'p1' }]); removal.controller.toggle('a', true); await removal.controller.previewProjects(true);
    removal.stored.set('a', { ...task('a'), parent_project_id: 'p2' }); await removal.controller.submit('project');
    expect(removal.update).not.toHaveBeenCalled(); expect(removal.controller.snapshot()[0]?.state).toBe('skipped');
  });

  it('rechecks destination identity between writes and never retries against a recreated or pending destination', async () => {
    const r = rig(); r.controller.handleAction('task-bulk-all'); r.controller.setProject({ id: 'p2', label: 'Project p2' }); await r.controller.previewProjects();
    const save = r.update.getMockImplementation()!;
    r.update.mockImplementationOnce(async args => { const out = await save(args); r.projects.set('p2', { ...project('p2'), created_at: 999 }); return out; });
    await r.controller.submit('project'); expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'failed']);
    await r.controller.retry(); expect(r.update).toHaveBeenCalledTimes(1);
    r.projects.set('p2', { ...project('p2'), pending_write: { staged_at: 2, operation: 'update', dirty_fields: ['title'], state: 'awaiting_verify' } });
    await r.controller.retry(); expect(r.update).toHaveBeenCalledTimes(1);
    r.projects.set('p2', project('p2')); await r.controller.retry(); expect(r.update).toHaveBeenLastCalledWith({ kind: 'task', id: 'b', parent_project_id: 'p2' });
  });

  it('reconciles lost and pending assignment and removal replies without repeating writes', async () => {
    for (const remove of [false, true]) {
      const r = rig([{ ...task('a'), parent_project_id: 'p1' }, { ...task('b'), parent_project_id: 'p1' }]);
      const save = r.update.getMockImplementation()!;
      r.update.mockImplementation(async args => {
        const out = await save(args);
        if ('id' in args && args.id === 'a') throw new Error('Project reply lost');
        const next: Task = { ...(out.entity as Task), pending_write: { staged_at: 2, operation: 'update', dirty_fields: ['parent_project_id'], state: 'awaiting_verify' } };
        r.stored.set('b', next); return { entity: next };
      });
      r.controller.handleAction('task-bulk-all'); r.controller.setProject({ id: 'p2', label: 'Project p2' }); await r.controller.previewProjects(remove); await r.controller.submit('project');
      expect(r.controller.snapshot().map(row => row.state)).toEqual(['failed', 'unconfirmed']);
      await r.controller.retry(); await r.controller.retry(true); expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'unconfirmed']);
      const next = { ...r.stored.get('b')! }; delete next.pending_write; r.stored.set('b', next); await r.controller.retry(true);
      expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed']); expect(r.update).toHaveBeenCalledTimes(2);
      expect(r.stored.get('a')!.parent_project_id).toBe(remove ? undefined : 'p2');
    }
  });

  it('rechecks task access and identity, then retains the frozen project through stop and retry', async () => {
    const blocked = rig(); blocked.controller.handleAction('task-bulk-all'); blocked.controller.setProject({ id: 'p2', label: 'Project p2' }); await blocked.controller.previewProjects();
    blocked.sources([{ ...source, write_capable: false }, projectSource]); blocked.stored.set('b', { ...task('b'), created_at: 999 });
    await blocked.controller.submit('project'); expect(blocked.update).not.toHaveBeenCalled(); expect(blocked.controller.snapshot().map(row => row.state)).toEqual(['failed', 'failed']);
    const r = rig(); const save = r.update.getMockImplementation()!; let release!: () => void;
    r.update.mockImplementationOnce(async args => { await new Promise<void>(done => { release = done; }); return save(args); });
    r.controller.handleAction('task-bulk-all'); r.controller.setProject({ id: 'p2', label: 'Project p2' }); await r.controller.previewProjects();
    const running = r.controller.submit('project'); await vi.waitFor(() => expect(r.update).toHaveBeenCalledTimes(1));
    r.controller.handleAction('task-bulk-stop'); r.controller.setProject({ id: 'p1', label: 'Project p1' }); release(); await running;
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'failed']); await r.controller.retry();
    expect(r.update.mock.calls.map(([args]) => args)).toEqual([{ kind: 'task', id: 'a', parent_project_id: 'p2' }, { kind: 'task', id: 'b', parent_project_id: 'p2' }]);
  });

  it('retires pending previews on back, reset and dispose without repainting or changing a newer preview', async () => {
    const r = rig(); r.controller.toggle('a', true); r.controller.setProject({ id: 'p2', label: 'Project p2' });
    let release!: (value: Awaited<ReturnType<DataWorkEntityGetCaller>>) => void;
    r.get.mockImplementationOnce(() => new Promise(done => { release = done; }));
    const old = r.controller.previewProjects(); expect(r.controller.submit('project')).toBe(old);
    r.controller.handleAction('task-bulk-project-back'); r.controller.setProject({ id: 'p1', label: 'Project p1' }); await r.controller.previewProjects();
    release({ entity: project('p2') }); await old; expect(r.controller.render()).toContain('No project → Project p1 · Projects');
    expect(r.controller.render()).not.toContain('Project p2'); await r.controller.submit('project');
    expect(r.update).toHaveBeenCalledExactlyOnceWith({ kind: 'task', id: 'a', parent_project_id: 'p1' });
    for (const retire of ['reset', 'dispose'] as const) {
      const abandoned = rig(); abandoned.controller.toggle('a', true); abandoned.controller.setProject({ id: 'p2', label: 'Project p2' });
      abandoned.get.mockImplementationOnce(() => new Promise(done => { release = done; })); const pending = abandoned.controller.previewProjects();
      abandoned.controller[retire](); const paints = abandoned.render.mock.calls.length; release({ entity: project('p2') }); await pending;
      expect(abandoned.render).toHaveBeenCalledTimes(paints); await abandoned.controller.submit('project'); expect(abandoned.update).not.toHaveBeenCalled();
    }
  });
});

describe('deadline shifts', () => {
  const day = 86_400_000;
  const a = { ...task('a'), due_at: Date.UTC(2032, 1, 28, 9, 30, 20, 123) };
  const b = { ...task('b'), due_at: Date.UTC(2032, 2, 3, 16) };

  it('previews a week without writing, preserves UTC times and spacing, and skips completed and undated tasks', async () => {
    const r = rig([a, b, { ...task('undated'), due_at: undefined }, { ...task('done'), done: true }]);
    r.controller.handleAction('task-bulk-all'); r.controller.handleAction('task-bulk-shift-week');
    expect(r.controller.render()).toContain('2 tasks will move · 2 skipped');
    expect(r.controller.render()).toContain('2032-02-28 09:30:20.123 UTC → 2032-03-06 09:30:20.123 UTC');
    expect(r.get).not.toHaveBeenCalled(); expect(r.update).not.toHaveBeenCalled();
    r.controller.toggle('a', false); r.controller.setShiftDays('-1');
    await r.controller.submit('clear'); expect(r.update).not.toHaveBeenCalled();
    r.stored.set('a', { ...a, title: 'New title', body: 'New notes', priority: 'high' });
    await r.controller.submit('shift');
    expect(r.update.mock.calls.map(([args]) => args)).toEqual([
      { kind: 'task', id: 'a', due_at: a.due_at + 7 * day }, { kind: 'task', id: 'b', due_at: b.due_at + 7 * day },
    ]);
    expect(r.stored.get('b')!.due_at! - r.stored.get('a')!.due_at!).toBe(b.due_at - a.due_at);
    expect(r.stored.get('a')).toMatchObject({ title: 'New title', body: 'New notes', priority: 'high' });
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed', 'skipped', 'skipped']);
    expect(r.complete).not.toHaveBeenCalled();
  });

  it('validates custom offsets, supports earlier deadlines, and abandons a preview without changing the selection', async () => {
    const r = rig([a]); r.controller.toggle('a', true);
    for (const value of ['', '0', '1.5', 'NaN', 'Infinity', '9007199254740991']) {
      r.controller.setShiftDays(value); r.controller.previewShift();
      expect(r.controller.render()).toContain('Choose a nonzero whole number of days');
    }
    r.controller.setShiftDays('-2'); r.controller.previewShift();
    expect(r.controller.render()).toContain('Shift deadlines 2 days earlier');
    r.controller.handleAction('task-bulk-shift-back');
    expect([...r.controller.selection().selected_ids]).toEqual(['a']); expect(r.get).not.toHaveBeenCalled();
    await r.controller.submit('shift'); expect(r.update).not.toHaveBeenCalled();
    r.controller.previewShift(); await r.controller.submit('shift');
    expect(r.update).toHaveBeenCalledExactlyOnceWith({ kind: 'task', id: 'a', due_at: a.due_at - 2 * day });
  });

  it('shows an all-skipped preview without applying an invalid or missing deadline', async () => {
    const r = rig([{ ...a, due_at: Date.UTC(9999, 11, 31) }, { ...b, due_at: undefined }]);
    r.controller.handleAction('task-bulk-all'); r.controller.handleAction('task-bulk-shift-day');
    expect(r.controller.render()).toContain('0 tasks will move · 2 skipped');
    expect(r.controller.render()).toContain('outside the supported date range');
    expect(r.controller.render()).toContain('No due date to shift');
    await r.controller.submit('shift'); expect(r.get).not.toHaveBeenCalled(); expect(r.update).not.toHaveBeenCalled();
    r.controller.reset(); await r.controller.submit('shift'); expect(r.update).not.toHaveBeenCalled();
  });

  it('reconciles lost and source-pending shift replies against frozen targets without shifting twice', async () => {
    const r = rig([a, b]); const save = r.update.getMockImplementation()!;
    r.update.mockImplementation(async args => {
      const out = await save(args);
      if ('id' in args && args.id === 'a') throw new Error('Deadline reply lost');
      const next: Task = { ...(out.entity as Task), pending_write: { staged_at: 200, operation: 'update', dirty_fields: ['due_at'], state: 'awaiting_verify' } };
      r.stored.set('b', next); return { entity: next };
    });
    r.controller.handleAction('task-bulk-all'); r.controller.handleAction('task-bulk-shift-day'); await r.controller.submit('shift');
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['failed', 'unconfirmed']);
    await r.controller.retry(); await r.controller.retry(true);
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'unconfirmed']);
    const next = { ...r.stored.get('b')! }; delete next.pending_write; r.stored.set('b', next);
    await r.controller.retry(true);
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed']);
    expect(r.update).toHaveBeenCalledTimes(2);
    expect(r.stored.get('a')!.due_at).toBe(a.due_at + day); expect(r.stored.get('b')!.due_at).toBe(b.due_at + day);
  });

  it('leaves deadlines changed or completed after the preview alone, including after an interrupted write', async () => {
    const r = rig([a, b, { ...a, id: 'c' }]);
    r.controller.handleAction('task-bulk-all'); r.controller.handleAction('task-bulk-shift-week');
    r.stored.set('a', { ...a, due_at: a.due_at + 2 * day }); r.stored.set('b', { ...b, done: true });
    r.update.mockRejectedValueOnce(new Error('Interrupted before saving'));
    await r.controller.submit('shift');
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['skipped', 'skipped', 'failed']);
    r.stored.set('c', { ...a, id: 'c', due_at: undefined }); await r.controller.retry();
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(r.update).toHaveBeenCalledTimes(1);
    expect(r.stored.get('a')!.due_at).toBe(a.due_at + 2 * day); expect(r.stored.get('b')!.due_at).toBe(b.due_at);
    expect(r.stored.get('c')!.due_at).toBeUndefined();
  });

  it('rechecks source access and identity before applying, and freezes a stopped task’s target for retry', async () => {
    const blocked = rig([a, b]); blocked.controller.handleAction('task-bulk-all'); blocked.controller.handleAction('task-bulk-shift-day');
    blocked.sources([{ ...source, write_capable: false }]); blocked.stored.set('b', { ...b, created_at: 999 });
    await blocked.controller.submit('shift'); expect(blocked.update).not.toHaveBeenCalled();
    expect(blocked.controller.snapshot().map(row => row.state)).toEqual(['failed', 'failed']);
    const r = rig([a, b]); const save = r.update.getMockImplementation()!;
    let release!: () => void; r.update.mockImplementationOnce(async args => { await new Promise<void>(done => { release = done; }); return save(args); });
    r.controller.handleAction('task-bulk-all'); r.controller.handleAction('task-bulk-shift-week'); const running = r.controller.submit('shift');
    await vi.waitFor(() => expect(r.update).toHaveBeenCalledTimes(1));
    r.controller.handleAction('task-bulk-stop'); r.controller.setShiftDays('1'); release(); await running;
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'failed']);
    await r.controller.retry();
    expect(r.update.mock.calls.map(([args]) => args)).toEqual([
      { kind: 'task', id: 'a', due_at: a.due_at + 7 * day }, { kind: 'task', id: 'b', due_at: b.due_at + 7 * day },
    ]);
  });
});

describe('reviewed task contact assignments', () => {
  const choose = async (r: ReturnType<typeof rig>) => {
    r.controller.setContact({ id: contact('two').email, label: 'Old search label' }); await r.controller.previewContacts();
  };
  it('reviews current names, skips the same stable contact, and changes only assignment across open and completed tasks', async () => {
    const r = rig([{ ...task('a'), assigned_contact_id: contact('one').email }, { ...task('b'), done: true, completed_at: 99 },
      { ...task('c'), assigned_contact_id: contact('two').contact_id }]);
    r.controller.handleAction('task-bulk-all'); await r.controller.previewContacts(); await r.controller.submit('contact');
    expect(r.update).not.toHaveBeenCalled(); expect(r.controller.render()).toContain('Choose a contact');
    await choose(r); expect(r.controller.render()).toContain('2 tasks will change · 1 skipped');
    expect(r.controller.render()).toContain('Contact one · one@example.test → Contact two · two@example.test');
    expect(r.controller.render()).toContain('No assigned contact → Contact two · two@example.test');
    r.stored.set('a', { ...r.stored.get('a')!, title: 'New title', body: 'New notes', priority: 'high', parent_project_id: 'new-project' });
    r.controller.setContact({ id: contact('one').email, label: 'Another contact' }); await r.controller.submit('clear');
    expect(r.update).not.toHaveBeenCalled(); await r.controller.submit('contact');
    expect(r.update.mock.calls.map(([args]) => args)).toEqual(['a', 'b'].map(id => ({ kind: 'task', id, assigned_contact_id: contact('two').email })));
    expect(r.stored.get('a')).toMatchObject({ title: 'New title', body: 'New notes', priority: 'high', parent_project_id: 'new-project' });
    expect(r.stored.get('b')).toMatchObject({ done: true, completed_at: 99, due_at: task('b').due_at });
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed', 'skipped']);
  });

  it('clears unavailable old references explicitly and skips tasks with no assigned contact', async () => {
    const r = rig([{ ...task('a'), assigned_contact_id: 'missing-contact' }, task('b')]);
    r.controller.handleAction('task-bulk-all'); await r.controller.previewContacts(true);
    expect(r.controller.render()).toContain('Unavailable contact → No assigned contact');
    expect(r.controller.render()).toContain('Already has no assigned contact');
    r.controller.handleAction('task-bulk-contact-back'); await r.controller.submit('contact'); expect(r.update).not.toHaveBeenCalled();
    await r.controller.previewContacts(true); await r.controller.submit('contact');
    expect(r.update).toHaveBeenCalledExactlyOnceWith({ kind: 'task', id: 'a', clear_assigned_contact: true });
    expect(r.stored.get('a')?.assigned_contact_id).toBeUndefined(); expect(r.stored.get('a')?.due_at).toBe(task('a').due_at);
  });

  it('requires a resolved destination, retains lookup errors for retry, and never interprets a missing contact as clearing', async () => {
    const r = rig(); r.controller.toggle('a', true); r.controller.setContact({ id: contact('two').email, label: 'Contact two' });
    r.contactGet.mockRejectedValueOnce(new Error('Contact lookup interrupted')); await r.controller.previewContacts();
    await r.controller.submit('contact'); expect(r.update).not.toHaveBeenCalled(); expect(r.controller.render()).toContain('Contact lookup interrupted');
    r.controller.handleAction('task-bulk-contact-retry'); await r.controller.whenSettled(); expect(r.controller.render()).toContain('1 task will change');
    r.controller.handleAction('task-bulk-contact-back'); r.contacts.delete(contact('two').email); await r.controller.previewContacts();
    await r.controller.submit('contact'); expect(r.update).not.toHaveBeenCalled(); expect(r.controller.render()).toContain('contact is unavailable');
  });

  it('refuses deleted, replaced, merged or renamed-address destination identities, including retries', async () => {
    for (const change of ['deleted', 'replaced', 'merged', 'address'] as const) {
      const r = rig(); r.controller.toggle('a', true); await choose(r);
      r.update.mockRejectedValueOnce(new Error('Interrupted before save')); await r.controller.submit('contact'); expect(r.update).toHaveBeenCalledTimes(1);
      const target = contact('two');
      if (change === 'deleted') r.contacts.delete(target.email);
      else r.contacts.set(target.email, { ...target, ...(change === 'replaced' ? { contact_id: 'other-identity' }
        : change === 'merged' ? { merged_into: contact('one').email } : { email: 'new-address@example.test' }) });
      await r.controller.retry(); expect(r.update).toHaveBeenCalledTimes(1); expect(r.controller.snapshot()[0]?.message).toContain('changed identity');
    }
  });

  it('skips assignments changed after review, and checks task identity and source permission before writing', async () => {
    const changed = rig([{ ...task('a'), assigned_contact_id: contact('one').email }]); changed.controller.toggle('a', true); await choose(changed);
    changed.stored.set('a', { ...changed.stored.get('a')!, assigned_contact_id: 'new-choice@example.test' }); await changed.controller.submit('contact');
    expect(changed.controller.snapshot()[0]?.state).toBe('skipped'); expect(changed.update).not.toHaveBeenCalled();
    const r = rig(); r.controller.handleAction('task-bulk-all'); await choose(r); r.sources([{ ...source, write_capable: false }]);
    r.stored.set('b', { ...task('b'), created_at: 999 }); await r.controller.submit('contact');
    expect(r.update).not.toHaveBeenCalled(); expect(r.controller.snapshot().map(row => row.state)).toEqual(['failed', 'failed']);
  });

  for (const remove of [false, true]) it(`reconciles ${remove ? 'clearing' : 'assignment'} after a lost reply or pending confirmation without another write`, async () => {
    const r = rig(['a', 'b'].map(id => ({ ...task(id), assigned_contact_id: contact('one').email }))), save = r.update.getMockImplementation()!;
    r.controller.handleAction('task-bulk-all'); if (remove) await r.controller.previewContacts(true); else await choose(r);
    r.update.mockImplementation(async args => {
      const out = await save(args); if ('id' in args && args.id === 'a') throw new Error('Reply lost');
      const next: Task = { ...out.entity as Task, pending_write: { staged_at: 200, operation: 'update', dirty_fields: ['assigned_contact_id'], state: 'awaiting_verify' } };
      r.stored.set('b', next); return { entity: next };
    });
    await r.controller.submit('contact'); expect(r.controller.snapshot().map(row => row.state)).toEqual(['failed', 'unconfirmed']);
    await r.controller.retry(); await r.controller.retry(true); expect(r.update).toHaveBeenCalledTimes(2);
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'unconfirmed']);
    const next = { ...r.stored.get('b')! }; delete next.pending_write; r.stored.set('b', next);
    await r.controller.retry(true); expect(r.update).toHaveBeenCalledTimes(2); expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'confirmed']);
  });

  it('stops after the current write and retains the reviewed contact on retry', async () => {
    const r = rig(), save = r.update.getMockImplementation()!; let release!: () => void;
    r.update.mockImplementationOnce(async args => { await new Promise<void>(done => { release = done; }); return save(args); });
    r.controller.handleAction('task-bulk-all'); await choose(r); const running = r.controller.submit('contact');
    await vi.waitFor(() => expect(r.update).toHaveBeenCalledTimes(1)); r.controller.handleAction('task-bulk-stop');
    r.controller.setContact({ id: contact('one').email, label: 'Different choice' }); release(); await running;
    expect(r.controller.snapshot().map(row => row.state)).toEqual(['confirmed', 'failed']); await r.controller.retry();
    expect(r.update.mock.calls.map(([args]) => args)).toEqual(['a', 'b'].map(id => ({ kind: 'task', id, assigned_contact_id: contact('two').email })));
  });

  it('retires a delayed preview on Back or dispose without replacing the newer selection', async () => {
    const r = rig(); r.controller.toggle('a', true); r.controller.setContact({ id: contact('two').email, label: 'Contact two' });
    let release!: () => void; r.contactGet.mockImplementationOnce(async () => { await new Promise<void>(done => { release = done; }); return { contact: contact('two') }; });
    const loading = r.controller.previewContacts(); r.controller.handleAction('task-bulk-contact-back');
    r.controller.setContact({ id: contact('one').email, label: 'Contact one' }); release(); await loading;
    expect(r.controller.render()).toContain('aria-label="Task selection"'); await r.controller.previewContacts();
    expect(r.controller.render()).toContain('Contact one · one@example.test'); r.controller.dispose(); await r.controller.submit('contact'); expect(r.update).not.toHaveBeenCalled();
  });
});
