import { describe, expect, it, vi } from 'vitest';
import type { WorkEntity, WorkEntityProjectItemsRpcRequest, WorkEntityProjectItemsRpcResponse } from '@recued/contracts';
import { renderProjectOverview, type ProjectOverviewProps } from '@recued/ui-shared/work-entity-page';
import { createProjectWork, type ProjectItemsCaller } from '../project-work.js';

const project: Extract<WorkEntity, { _kind: 'project' }> = { _kind: 'project', id: 'p', title: 'Launch', state: 'active',
  source_id: 'recued.project', sync_state: 'live', conflict_policy: 'recued_wins', created_at: 1, updated_at: 1,
  last_seen_at: 1, last_activity_at: 1, related_contact_ids: [] };
const reply = (title: string): WorkEntityProjectItemsRpcResponse => ({ project_id: 'p', kind: 'task', offset: 0,
  total: 1, open_tasks: 1, items: [{ id: 't', title, excerpt: '', source_id: 'recued.task', source_label: 'Recued',
    updated_at: 1, stale: false, pending_write: false, done: false }] });
const searchReply = (args: WorkEntityProjectItemsRpcRequest, title: string): WorkEntityProjectItemsRpcResponse => ({
  ...reply(title), kind: args.kind, offset: args.offset ?? 0, query: args.query ?? '',
  ...(args.kind === 'task' ? { task_completion: args.task_completion ?? 'all', total_tasks: 1 } : {}),
  ...(args.kind === 'commitment' ? { commitment_status: args.commitment_status ?? 'open' } : {}),
  items: reply(title).items.map(item => ({ ...item, ...(args.kind === 'commitment' ? { commitment: {
    direction: 'inbound' as const, lifecycle_state: 'pending' as const, due_status: 'no_deadline' as const } } : {}) })),
});

describe('project work read ownership', () => {
  it('applies one query to every section, retires older replies and isolates an independently failed search', async () => {
    const pending: Array<{ args: WorkEntityProjectItemsRpcRequest; resolve(value: WorkEntityProjectItemsRpcResponse): void; reject(error: Error): void }> = [];
    const work = createProjectWork(project, args => new Promise((resolve, reject) => pending.push({ args, resolve, reject })), vi.fn());
    work.setDraftQuery('older'); const older = work.applyQuery(); work.setDraftQuery(' current '); const current = work.applyQuery();
    for (const item of pending.slice(3)) item.resolve(searchReply(item.args, 'Current result'));
    await current; for (const item of pending.slice(0, 3)) item.resolve(searchReply(item.args, 'Retired result')); await older;
    expect(work.query).toBe('current'); expect(work.draftQuery).toBe('current');
    for (const section of Object.values(work.sections)) expect(section.items[0]?.title).toBe('Current result');
    work.setDraftQuery('new query'); const failed = work.applyQuery();
    pending[6]!.resolve({ ...searchReply(pending[6]!.args, 'Wrong query'), query: 'current' });
    pending[7]!.reject(new Error('Notes interrupted'));
    pending[8]!.resolve(searchReply(pending[8]!.args, 'Current commitment')); await failed;
    expect(work.sections.task).toMatchObject({ items: [], error: expect.stringContaining('could not be confirmed') });
    expect(work.sections.note).toMatchObject({ items: [], error: 'Notes interrupted' });
    expect(work.sections.commitment.items[0]?.title).toBe('Current commitment'); work.dispose();
  });

  it('does not present legacy unfiltered pages as search matches and restores browsing when search is cleared', async () => {
    const caller: ProjectItemsCaller = async args => ({ ...searchReply(args, 'Unfiltered row'), query: undefined });
    const work = createProjectWork(project, caller, vi.fn()); work.setDraftQuery('needle'); await work.applyQuery();
    for (const section of Object.values(work.sections)) expect(section).toMatchObject({ items: [], search_supported: false,
      error: expect.stringContaining('Update your Recued server to search') });
    work.setDraftQuery(''); await work.applyQuery(); expect(work.sections.note.items[0]?.title).toBe('Unfiltered row'); work.dispose();
  });

  it('refills the confirmed loaded prefix when completing a matching task removes it from an open search', async () => {
    type Task = Extract<WorkEntity, { _kind: 'task' }>;
    const rows: Task[] = Array.from({ length: 31 }, (_, index) => ({ _kind: 'task', id: `t-${index}`, title: 'Needle task', body: '', done: false,
      source_id: 'recued.task', parent_project_id: 'p', created_at: 1, updated_at: 1, last_seen_at: 1, sync_state: 'live', conflict_policy: 'recued_wins', blocks_task_ids: [] }));
    const source = { id: 'recued.task', top_tier_kind: 'task' as const, source_kind: 'builtin' as const, source_label: 'Tasks', write_capable: true, registered_at: 1 };
    const caller: ProjectItemsCaller = async args => {
      const matching = rows.filter(row => args.task_completion !== 'open' || !row.done), offset = args.offset ?? 0;
      return { project_id: 'p', kind: args.kind, query: args.query ?? '', offset, total: args.kind === 'task' ? matching.length : 0,
        ...(args.kind === 'task' ? { task_completion: args.task_completion ?? 'all', open_tasks: rows.filter(row => !row.done).length, total_tasks: rows.length } : {}),
        ...(args.kind === 'commitment' ? { commitment_status: 'open' as const } : {}),
        items: args.kind === 'task' ? matching.slice(offset, offset + (args.limit ?? 10)).map(row => ({ id: row.id, title: row.title, excerpt: '',
          source_id: row.source_id, source_label: 'Tasks', stale: false, pending_write: false, updated_at: 1, created_at: 1, done: row.done })) : [] };
    };
    const work = createProjectWork(project, caller, vi.fn(), { sources: () => [source], listSources: async () => ({ sources: [source] }),
      get: async args => ({ entity: args.kind === 'project' ? project : rows.find(row => row.id === args.id) ?? null }),
      complete: async args => { const row = rows.find(row => row.id === args.id)!; row.done = args.done; return { entity: { ...row } }; } });
    work.setTaskCompletion('open'); work.setDraftQuery('needle'); await work.applyQuery(); await work.load('task');
    expect(work.sections.task.items).toHaveLength(20); await work.taskActions.change('t-19', true);
    expect(work.sections.task.items).toHaveLength(20); expect(work.sections.task.items.at(-1)?.id).toBe('t-20');
    expect(work.query).toBe('needle'); expect(work.taskCompletion).toBe('open');
    expect(work.sections.task).toMatchObject({ total: 30, total_tasks: 31, open_tasks: 30 }); work.dispose();
  });

  it('retires an outstanding-only page when All is selected and never shows it under the new scope', async () => {
    const pending: Array<(value: WorkEntityProjectItemsRpcResponse) => void> = [];
    const caller = vi.fn<ProjectItemsCaller>(() => new Promise(resolve => pending.push(resolve)));
    const work = createProjectWork(project, caller, () => {});
    const old = work.load('commitment');
    work.setCommitmentStatus('all');
    const item = { ...reply('Already finished').items[0]!, commitment: { direction: 'inbound' as const,
      lifecycle_state: 'fulfilled' as const, due_status: 'not_due' as const } };
    pending[1]!({ project_id: 'p', kind: 'commitment', offset: 0, total: 1, commitment_status: 'all', items: [item] });
    await vi.waitFor(() => expect(work.sections.commitment.loading).toBe(false));
    pending[0]!({ project_id: 'p', kind: 'commitment', offset: 0, total: 0, commitment_status: 'open', items: [] });
    await old;
    expect(work.commitmentStatus).toBe('all');
    expect(work.sections.commitment.items).toEqual([item]);
    expect(caller.mock.calls.map(([args]) => args.commitment_status)).toEqual(['open', 'all']);
  });

  it('retires older replacement reads and ignores replies after the overview is disposed', async () => {
    const pending: Array<(value: WorkEntityProjectItemsRpcResponse) => void> = [];
    const caller: ProjectItemsCaller = () => new Promise(resolve => pending.push(resolve));
    const changed = vi.fn();
    const work = createProjectWork(project, caller, changed);
    const older = work.load('task'); const current = work.load('task', true);
    pending[1]!(reply('Current')); await current;
    pending[0]!(reply('Old')); await older;
    expect(work.sections.task.items[0]?.title).toBe('Current');
    const retired = work.load('task', true); work.dispose(); const paints = changed.mock.calls.length;
    pending[2]!(reply('Retired')); await retired;
    expect(work.sections.task.items[0]?.title).toBe('Current');
    expect(changed).toHaveBeenCalledTimes(paints);
  });

  it('retains confirmed items when a reply belongs to another project and isolates a failed section', async () => {
    const caller = vi.fn<ProjectItemsCaller>().mockResolvedValueOnce(reply('Confirmed'))
      .mockResolvedValueOnce({ ...reply('Wrong project'), project_id: 'other' })
      .mockRejectedValueOnce(new Error('Notes unavailable'));
    const work = createProjectWork(project, caller, () => {});
    await work.load('task'); await work.load('task', true); await work.load('note');
    expect(work.sections.task).toMatchObject({ items: [{ title: 'Confirmed' }], total: 1, error: expect.stringContaining('could not be confirmed') });
    expect(work.sections.note).toMatchObject({ items: [], error: 'Notes unavailable' });
    expect(work.sections.note.total).toBeUndefined();
  });

  it('filters before paging while keeping full-project counts and retires a previous scope', async () => {
    const pending: Array<(value: WorkEntityProjectItemsRpcResponse) => void> = [];
    const caller = vi.fn<ProjectItemsCaller>(() => new Promise(resolve => pending.push(resolve)));
    const work = createProjectWork(project, caller, () => {});
    const old = work.load('task'); work.setTaskCompletion('completed');
    const completed = { ...reply('Finished'), task_completion: 'completed' as const, total: 1, total_tasks: 25, open_tasks: 24,
      items: [{ ...reply('Finished').items[0]!, done: true }] };
    pending[1]!(completed); await vi.waitFor(() => expect(work.sections.task.loading).toBe(false));
    pending[0]!({ ...reply('Late unfiltered'), task_completion: 'all', total_tasks: 1 }); await old;
    expect(work.sections.task).toMatchObject({ items: [{ title: 'Finished', done: true }], total: 1, total_tasks: 25, open_tasks: 24 });
    expect(caller.mock.calls.map(([args]) => args.task_completion)).toEqual(['all', 'completed']);
    const html = renderProjectOverview({ project, sections: work.sections, editing: false, source_label: 'Recued',
      can_edit: true, can_create_task: true, can_create_note: true, task_completion: work.taskCompletion });
    expect(html).toContain('24 open · 1 completed tasks');
    expect(html).not.toContain('NaN');
  });

  it('does not display unfiltered or mismatched replies as a filtered task page', async () => {
    const caller = vi.fn<ProjectItemsCaller>().mockResolvedValue(reply('Legacy task'));
    const work = createProjectWork(project, caller, () => {}); await work.load('task');
    expect(work.sections.task).toMatchObject({ task_filters: false, items: [{ title: 'Legacy task' }] });
    work.setTaskCompletion('open'); await vi.waitFor(() => expect(work.sections.task.loading).toBe(false));
    expect(work.sections.task).toMatchObject({ items: [], task_filters: false, error: expect.stringContaining('Update your Recued server') });
    caller.mockResolvedValue({ ...reply('Wrong completion'), task_completion: 'open', total_tasks: 1 });
    work.setTaskCompletion('completed'); await vi.waitFor(() => expect(work.sections.task.loading).toBe(false));
    expect(work.sections.task.items).toEqual([]); expect(work.sections.task.error).toContain('could not be confirmed');
  });

  it('retains a confirmed completion when refreshing its page fails and labels the old counts honestly', async () => {
    const task: Extract<WorkEntity, { _kind: 'task' }> = { _kind: 'task', id: 't', title: 'Ship', done: false,
      source_id: 'recued.task', parent_project_id: 'p', created_at: 1, updated_at: 1, last_seen_at: 1,
      sync_state: 'live', conflict_policy: 'recued_wins', blocks_task_ids: [] };
    const caller = vi.fn<ProjectItemsCaller>().mockResolvedValueOnce({ ...reply('Ship'), task_completion: 'all', total_tasks: 1,
      items: [{ ...reply('Ship').items[0]!, created_at: 1 }] }).mockRejectedValueOnce(new Error('List unavailable'));
    const source = { id: 'recued.task', top_tier_kind: 'task' as const, source_kind: 'builtin' as const, source_label: 'Tasks', write_capable: true, registered_at: 1 };
    const work = createProjectWork(project, caller, () => {}, { sources: () => [source], listSources: async () => ({ sources: [source] }),
      get: async args => ({ entity: args.kind === 'project' ? project : task }), complete: async () => ({ entity: { ...task, done: true } }) });
    await work.load('task'); await work.taskActions.change('t', true);
    expect(work.taskActions.feedback()?.state).toBe('confirmed');
    expect(work.sections.task).toMatchObject({ items: [{ id: 't', done: true }], open_tasks: 1, error: 'List unavailable' });
    const html = renderProjectOverview({ project, sections: work.sections, editing: false, source_label: 'Recued',
      can_edit: true, can_create_task: true, can_create_note: true });
    expect(html).toContain('Task counts are from the last successful read.');
  });

  it('on a server that cannot list project work, says to update it instead of offering a retry', async () => {
    const older = Object.assign(new Error('Unknown rpc method: work_entity.project.items'), { code: 'unknown_method' });
    const work = createProjectWork(project, vi.fn<ProjectItemsCaller>().mockRejectedValue(older), () => {});
    await work.load('task'); await work.load('note');
    expect(work.sections.task).toMatchObject({ unsupported: true, loading: false });
    expect(work.sections.task.error).toBeUndefined();
    const html = renderProjectOverview({ project: project as unknown as ProjectOverviewProps['project'], sections: work.sections,
      editing: false, source_label: 'Recued', can_edit: true, can_create_task: true, can_create_note: true });
    expect(html).toContain("Update your Recued server to list this project's tasks.");
    expect(html).toContain("Update your Recued server to list this project's notes.");
    expect(html).not.toContain('Unknown rpc method');
    expect(html).not.toContain('project-work-retry');
    expect(html).not.toContain('role="alert"');
    const olderCommitments = createProjectWork(project, vi.fn<ProjectItemsCaller>().mockRejectedValue(
      Object.assign(new Error('Choose a project and either tasks or notes.'), { code: 'bad_request' })), () => {});
    await olderCommitments.load('commitment');
    expect(olderCommitments.sections.commitment).toMatchObject({ unsupported: true, loading: false });
    expect(olderCommitments.sections.commitment.error).toBeUndefined();
  });
});


describe('project task deadline clock', () => {
  it('keeps a whole-day deadline current until the viewer day ends, including a 25-hour day', () => {
    vi.stubEnv('TZ', 'America/New_York');
    try {
      const props: ProjectOverviewProps = { project, source_label: 'Recued', editing: false, can_edit: true,
        can_create_task: true, can_create_note: true, sections: {
          task: { loading: false, total: 1, open_tasks: 1, items: [{ ...reply('Finish today').items[0]!, due_at: Date.parse('2026-11-01T00:00:00Z') }] },
          note: { loading: false, items: [] }, commitment: { loading: false, items: [] },
        } };
      const beforeMidnight = renderProjectOverview({ ...props, now: Date.parse('2026-11-02T04:59:59.999Z') });
      expect(beforeMidnight).toContain('Open · Due 2026-11-01');
      expect(beforeMidnight).not.toContain('Overdue');
      expect(renderProjectOverview({ ...props, now: Date.parse('2026-11-02T05:00:00Z') })).toContain('Overdue');
    } finally { vi.unstubAllEnvs(); }
  });
});
