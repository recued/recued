import { describe, expect, it, vi } from 'vitest';
import type { WorkEntity, WorkEntityProjectItemsRpcResponse } from '@recued/contracts';
import { renderProjectOverview, type ProjectOverviewProps } from '@recued/ui-shared/work-entity-page';
import { createProjectWork, type ProjectItemsCaller } from '../project-work.js';

const project: Extract<WorkEntity, { _kind: 'project' }> = { _kind: 'project', id: 'p', title: 'Launch', state: 'active',
  source_id: 'recued.project', sync_state: 'live', conflict_policy: 'recued_wins', created_at: 1, updated_at: 1,
  last_seen_at: 1, last_activity_at: 1, related_contact_ids: [] };
const reply = (title: string): WorkEntityProjectItemsRpcResponse => ({ project_id: 'p', kind: 'task', offset: 0,
  total: 1, open_tasks: 1, items: [{ id: 't', title, excerpt: '', source_id: 'recued.task', source_label: 'Recued',
    updated_at: 1, stale: false, pending_write: false, done: false }] });

describe('project work read ownership', () => {
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
  });
});
