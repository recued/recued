import type { Page } from '@playwright/test';
import type { WorkEntity, WorkEntityProjectItemsRpcRequest, WorkEntityUpsertRpcRequest } from '@recued/contracts';

export const installProjectOverviewFixture = async (page: Page, failNotes = false): Promise<void> => {
  await page.addInitScript(({ failNotes }) => {
    const now = 1_700_000_000_000;
    const base = (kind: string, id: string) => ({ id, source_id: `recued.${kind}`, sync_state: 'live' as const,
      conflict_policy: 'recued_wins' as const, created_at: now, updated_at: now, last_seen_at: now });
    let entities: WorkEntity[] = [
      { ...base('project', 'launch'), _kind: 'project', title: 'Kestrel launch', description: 'Prepare the customer release.', state: 'active', last_activity_at: now, related_contact_ids: [] },
      { ...base('project', 'other'), _kind: 'project', source_id: 'remote.project', title: 'Other project', state: 'paused', last_activity_at: now, related_contact_ids: [] },
      ...Array.from({ length: 14 }, (_, index): Extract<WorkEntity, { _kind: 'task' }> => ({ ...base('task', `task-${String(index).padStart(2, '0')}`),
        _kind: 'task', title: `Launch task ${index}`, body: `Task details ${index}.`, done: index >= 12, parent_project_id: 'launch', blocks_task_ids: [] })),
      ...Array.from({ length: 12 }, (_, index): Extract<WorkEntity, { _kind: 'note' }> => ({ ...base('note', `note-${String(index).padStart(2, '0')}`),
        _kind: 'note', title: `Launch note ${index}`, body: `Complete launch note ${index}.`, last_user_action_at: now,
        related_project_ids: ['launch'], related_contact_ids: [], related_mail_thread_ids: [], related_calendar_event_ids: [] })),
      { ...base('task', 'other-task'), _kind: 'task', title: 'Other project task', parent_project_id: 'other', done: false, blocks_task_ids: [] },
      { ...base('note', 'standalone'), _kind: 'note', title: 'Independent launch note', body: 'Same words, no project link.', last_user_action_at: now,
        related_project_ids: [], related_contact_ids: [], related_mail_thread_ids: [], related_calendar_event_ids: [] },
    ];
    const sources = ['task', 'note', 'project'].map(kind => ({ id: `recued.${kind}`, top_tier_kind: kind,
      source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now }));
    sources.push({ id: 'remote.project', top_tier_kind: 'project', source_kind: 'connection', source_label: 'Read-only projects', write_capable: false, registered_at: now });
    const reads: WorkEntityProjectItemsRpcRequest[] = [];
    const writes: Array<Record<string, unknown>> = [];
    let held: (() => void) | undefined;
    let holdPage = false;
    let wrongCreateLink = false;
    let noteFailure = failNotes;
    const controls = { reads, writes,
      updateFromServer(title: string) {
        entities = entities.map(entity => entity._kind === 'project' && entity.id === 'launch' ? { ...entity, title }
          : entity._kind === 'task' && entity.id === 'task-00' ? { ...entity, done: true } : entity);
      },
      setProjectWritable(value: boolean) { sources.find(source => source.id === 'recued.project')!.write_capable = value; },
      changeNextCreateLink() { wrongCreateLink = true; },
      failNotes(value: boolean) { noteFailure = value; },
      holdTaskPage() { holdPage = true; },
      releaseTaskPage() { if (!held) throw new Error('No task page is waiting.'); const finish = held; held = undefined; holdPage = false; finish(); },
    };
    Object.assign(window, { __projectOverview: controls, __connectionsFixture: async (method: string, raw: unknown) => {
      if (method === 'work_entity.source.list') return { result: { sources: structuredClone(sources) } };
      if (method === 'work_entity.list') {
        const args = raw as { kind: string };
        const rows = entities.filter(entity => entity._kind === args.kind);
        return { result: { entities: rows, total: rows.length } };
      }
      if (method === 'work_entity.get') {
        const args = raw as { kind: string; id: string };
        return { result: { entity: entities.find(entity => entity._kind === args.kind && entity.id === args.id) ?? null,
          ...(args.kind === 'project' && args.id === 'other' ? { source_freshness: { source_id: 'remote.project', state: 'stale', last_success_at: now } } : {}) } };
      }
      if (method === 'work_entity.project.items') {
        const args = raw as WorkEntityProjectItemsRpcRequest;
        reads.push(args);
        if (args.kind === 'note' && noteFailure) return { error: { code: 'unavailable', message: 'Notes read interrupted.' } };
        const rows = entities.filter(entity => args.kind === 'task' ? entity._kind === 'task' && entity.parent_project_id === args.project_id
          : entity._kind === 'note' && entity.related_project_ids.includes(args.project_id));
        rows.sort((a, b) => Number(a._kind === 'task' && a.done) - Number(b._kind === 'task' && b.done) || a.id.localeCompare(b.id));
        const offset = args.offset ?? 0, limit = args.limit ?? 10;
        const response = { result: { project_id: args.project_id, kind: args.kind, offset, total: rows.length,
          ...(args.kind === 'task' ? { open_tasks: rows.filter(entity => entity._kind === 'task' && !entity.done).length } : {}),
          items: rows.slice(offset, offset + limit).map(entity => ({ id: entity.id,
            title: entity._kind === 'task' || entity._kind === 'note' ? entity.title ?? 'Note' : '',
            excerpt: entity._kind === 'task' || entity._kind === 'note' ? entity.body ?? '' : '', source_id: entity.source_id,
            source_label: 'Recued', updated_at: entity.updated_at, stale: false, pending_write: false,
            ...(entity._kind === 'task' ? { done: entity.done, ...(entity.due_at !== undefined ? { due_at: entity.due_at } : {}) } : {}) })) } };
        if (args.kind === 'task' && args.project_id === 'launch' && offset > 0 && holdPage) return new Promise(resolve => { held = () => resolve(response); });
        return response;
      }
      if (method === 'work_entity.upsert') {
        const args = raw as WorkEntityUpsertRpcRequest;
        writes.push({ method, ...args });
        const id = 'id' in args && args.id ? args.id : `new-${args.kind}-${writes.length}`;
        const existing = entities.find(entity => entity._kind === args.kind && entity.id === id);
        const saved = { ...base(args.kind, id), done: false, blocks_task_ids: [], last_user_action_at: now,
          related_project_ids: [], related_contact_ids: [], related_calendar_event_ids: [], related_mail_thread_ids: [],
          ...existing, ...args, id, _kind: args.kind, updated_at: now + writes.length } as WorkEntity;
        if (!existing && saved._kind === 'task' && wrongCreateLink) { saved.parent_project_id = 'other'; wrongCreateLink = false; }
        if (saved._kind === 'project' && args.kind === 'project' && args.target_completion_at === null) delete saved.target_completion_at;
        if (saved._kind === 'task' && args.kind === 'task' && 'clear_due_at' in args && args.clear_due_at) delete saved.due_at;
        entities = [...entities.filter(entity => !(entity._kind === args.kind && entity.id === id)), saved];
        return { result: { entity: saved } };
      }
      if (method === 'work_entity.task.mark_done') {
        const args = raw as { id: string; done: boolean };
        writes.push({ method, ...args });
        const task = entities.find(entity => entity._kind === 'task' && entity.id === args.id);
        if (!task) throw new Error('Missing fixture task');
        const saved = { ...task, done: args.done, updated_at: now + writes.length };
        entities = entities.map(entity => entity === task ? saved : entity);
        return { result: { entity: saved } };
      }
      if (method === 'data.timeline') return { result: { entries: [] } };
      return undefined;
    } });
  }, { failNotes });
};

declare global { interface Window { __projectOverview: {
  reads: WorkEntityProjectItemsRpcRequest[];
  writes: Array<Record<string, unknown>>;
  failNotes(value: boolean): void;
  holdTaskPage(): void;
  updateFromServer(title: string): void;
  setProjectWritable(value: boolean): void;
  changeNextCreateLink(): void;
  releaseTaskPage(): void;
} } }
