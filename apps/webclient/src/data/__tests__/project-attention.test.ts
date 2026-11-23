import { expect, it, vi } from 'vitest';
import type { WorkEntity, WorkEntityProjectAttentionRpcResponse, ProjectAttentionScope, WorkEntityGetRpcResponse } from '@recued/contracts';
import { createProjectAttention, projectAttentionKey, projectStatusUpdate, type ProjectAttentionCaller } from '../project-attention.js';
import { renderProjectAttention } from '@recued/ui-shared/work-entity-page';
type Project = Extract<WorkEntity, { _kind: 'project' }>;
const project: Project = { _kind: 'project', id: 'p/二?', title: 'Release <team>', state: 'active', source_id: 'recued.project', created_at: 1, updated_at: 1,
  last_seen_at: 1, last_activity_at: 1, related_contact_ids: [], sync_state: 'live', conflict_policy: 'recued_wins' };
const now = Date.parse('2026-10-31T18:00:00Z');
const task: Extract<WorkEntity, { _kind: 'task' }> = { _kind: 'task', id: 't/二?', title: 'Old deadline', source_id: 'recued.task', created_at: 2, updated_at: 2, last_seen_at: 2,
  conflict_policy: 'recued_wins', sync_state: 'live', done: false, parent_project_id: project.id, due_at: now - 100, blocks_task_ids: [] };
const page = (scope?: ProjectAttentionScope, offset = 0): WorkEntityProjectAttentionRpcResponse => ({
  project: { ...project }, as_of: now, checked_at: now, time_zone: 'America/Los_Angeles', upcoming_before: now + 6 * 86_400_000,
  counts: { open_tasks: 16, completed_tasks: 4, overdue_tasks: 12, due_soon_tasks: 2, blocking_commitments: 3 }, coverage: { issues: [], omitted: 0 },
  ...(scope ? { scope } : {}), offset, total: scope ? scope === 'overdue_tasks' ? 12 : scope === 'due_soon_tasks' ? 2 : 3 : 0, more: scope === 'overdue_tasks' && offset === 0,
  items: scope ? Array.from({ length: scope === 'overdue_tasks' ? offset === 0 ? 10 : 2 : scope === 'due_soon_tasks' ? 2 : 3 }, (_, i) => ({
    id: offset + i === 0 ? task.id : 'task-' + (offset + i), title: 'Task ' + (offset + i), source_id: task.source_id, source_label: 'Recued', created_at: 2,
    updated_at: 2, excerpt: '', stale: false, pending_write: false, ...(scope === 'blocking_commitments' ? { commitment: { direction: 'inbound', lifecycle_state: 'pending', due_status: 'no_deadline' } as const } : { done: false, due_at: now - 100 }) })) : [],
});
const setup = () => {
  let current = project, active = true, blocked = false, focus = 'attention-copy';
  const caller = vi.fn<ProjectAttentionCaller>(async args => page(args.scope, args.offset));
  const get = vi.fn(async ({ kind }: { kind: string; id: string }): Promise<WorkEntityGetRpcResponse> => ({ entity: kind === 'project' ? current : task }));
  const open = vi.fn(), beforeLeave = vi.fn(() => true), changed = vi.fn(), write = vi.fn(async (_value: string) => true), selectFallback = vi.fn(), focusAction = vi.fn();
  const model = createProjectAttention({ project: () => current, adopt: p => { current = p; }, caller, get, open, beforeLeave, blocked: () => blocked, changed, active: () => active,
    zone: () => 'America/Los_Angeles', write, focus: focusAction, focused: key => key === focus, selectFallback });
  return { model, caller, get, open, beforeLeave, write, selectFallback, focusAction, changed, setProject: (p: Project) => { current = p; }, leave: () => { active = false; }, block: () => { blocked = true; }, focus: (key: string) => { focus = key; } };
};
const hold = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

it('keeps complete summary totals while paging a chosen scope and reuses the server window', async () => {
  const f = setup(); await f.model.refresh(); expect(f.model.view()?.snapshot?.counts.open_tasks).toBe(16); await f.model.show('overdue_tasks'); await f.model.more();
  expect(f.model.view()?.snapshot?.items).toHaveLength(12); expect(f.model.view()?.snapshot?.counts.overdue_tasks).toBe(12);
  expect(f.caller.mock.calls.at(-1)![0]).toMatchObject({ scope: 'overdue_tasks', offset: 10, limit: 10, as_of: now, project_identity: { source_id: project.source_id, created_at: 1 } });
  f.model.close(); expect(f.model.view()?.scope).toBeUndefined(); expect(f.model.view()?.snapshot?.counts.open_tasks).toBe(16);
});

it('fences a retired project lookup and keeps failed, unsupported or malformed reads distinct from zero work', async () => {
  const f = setup(), held = hold<WorkEntityProjectAttentionRpcResponse>(); f.caller.mockReturnValueOnce(held.promise); const pending = f.model.refresh();
  f.setProject({ ...project, id: 'other' }); held.resolve(page()); await pending; expect(f.model.view()).toBeUndefined();
  const g = setup(); await g.model.refresh(); g.caller.mockRejectedValueOnce(new Error('Interrupted')); await g.model.refresh(); expect(g.model.view()?.phase).toBe('error'); expect(g.model.view()?.snapshot?.counts.open_tasks).toBe(16);
  g.caller.mockResolvedValueOnce({ ...page(), project: { ...project, created_at: 99 } }); await g.model.refresh(); expect(g.model.view()?.error).toContain('could not be confirmed'); expect(g.model.view()?.snapshot?.project.created_at).toBe(1);
  const h = setup(); h.caller.mockRejectedValueOnce(Object.assign(new Error('Older server'), { code: 'unknown_method' })); await h.model.refresh();
  expect(h.model.view()?.phase).toBe('unsupported'); expect(h.model.view()?.snapshot).toBeUndefined(); expect(renderProjectAttention(h.model.view())).toContain('Update your Recued server');
});

it('rejects a repeated or non-advancing page without replacing the last confirmed list', async () => {
  const f = setup(); await f.model.show('overdue_tasks'); const bad = page('overdue_tasks', 10); bad.items[0]!.id = task.id; f.caller.mockResolvedValueOnce(bad); await f.model.more();
  expect(f.model.view()?.phase).toBe('error'); expect(f.model.view()?.snapshot?.items).toHaveLength(10); expect(f.model.view()?.error).toContain('repeated');
});

it('opens only a registered item after checking its current identity, membership and project', async () => {
  const f = setup(); await f.model.show('overdue_tasks'); const row = f.model.view()!.snapshot!.items[0]!, key = projectAttentionKey('task', row);
  await f.model.open('invented'); expect(f.get).not.toHaveBeenCalled(); await f.model.open(key); expect(f.open).toHaveBeenCalledExactlyOnceWith('task', row, { entity: task }, key);
  f.get.mockImplementation(async ({ kind }) => ({ entity: kind === 'project' ? project : { ...task, parent_project_id: 'other' } })); await f.model.open(key); expect(f.open).toHaveBeenCalledOnce(); expect(f.model.view()?.action_error).toContain('no longer matches');
  f.get.mockImplementation(async ({ kind }) => ({ entity: kind === 'project' ? { ...project, created_at: 99 } : task })); await f.model.open(key); expect(f.open).toHaveBeenCalledOnce(); expect(f.model.view()?.action_error).toContain('removed or replaced');
});

it('checks the draft guard again and retires delayed activation when the reader is left', async () => {
  const f = setup(); await f.model.show('overdue_tasks'); const key = projectAttentionKey('task', f.model.view()!.snapshot!.items[0]!);
  const held = hold<WorkEntityGetRpcResponse>(); f.get.mockReturnValueOnce(held.promise); const pending = f.model.open(key); f.leave(); held.resolve({ entity: task }); await pending; expect(f.open).not.toHaveBeenCalled();
  const g = setup(); await g.model.show('overdue_tasks'); const wait = hold<WorkEntityGetRpcResponse>(); g.get.mockReturnValueOnce(wait.promise); const second = g.model.open(key); g.beforeLeave.mockReturnValue(false); wait.resolve({ entity: task }); await second; expect(g.open).not.toHaveBeenCalled();
});

it('copies a saved status update with complete counts and coverage without copying IDs or private record payloads', async () => {
  const f = setup(); const reply = page(); Object.assign(reply.project, { source_extension: { secret: 'private-payload' } }); reply.coverage.issues.push({ kind: 'task', source_label: 'Vendor', reason: 'incomplete' }); f.caller.mockResolvedValueOnce(reply);
  await f.model.refresh(); await f.model.copy(); const value = f.write.mock.calls[0]![0];
  expect(value).toContain('Tasks: 16 open, 4 completed'); expect(value).toContain('Overdue tasks: 12'); expect(value).toContain('Outstanding blocking commitments: 3'); expect(value).toContain('Vendor: saved coverage is incomplete.'); expect(value).toContain('America/Los_Angeles'); expect(value).not.toMatch(/private-payload|p\/二\?|recued.project/);
  expect(f.model.view()?.copy_notice).toBe('Project update copied.'); expect(projectStatusUpdate(reply, true)).toContain('latest refresh failed');
});

it('offers the captured update for manual copying without stealing a newer focus choice', async () => {
  const f = setup(); await f.model.refresh(); f.write.mockResolvedValueOnce(false); await f.model.copy(); expect(f.model.view()?.fallback).toContain('Release <team>'); expect(f.selectFallback).toHaveBeenCalledOnce();
  const held = hold<boolean>(); f.write.mockReturnValueOnce(held.promise); const pending = f.model.copy(); f.focus('search'); held.resolve(false); await pending; expect(f.selectFallback).toHaveBeenCalledOnce();
});
