import type { Page } from '@playwright/test';
import type { WorkEntity, WorkEntityListRpcRequest, WorkEntityProjectItemsRpcRequest, WorkEntityUpsertRpcRequest } from '@recued/contracts';

export const installProjectOverviewFixture = async (page: Page, failNotes = false): Promise<void> => {
  await page.addInitScript(({ failNotes }) => {
    const now = 1_700_000_000_000;
    const base = (kind: string, id: string) => ({ id, source_id: `recued.${kind}`, sync_state: 'live' as const,
      conflict_policy: 'recued_wins' as const, created_at: now, updated_at: now, last_seen_at: now });
    type PromiseEntity = Extract<WorkEntity, { _kind: 'commitment' }>;
    const promise = (id: string, statement: string, extra: Partial<PromiseEntity> = {}): PromiseEntity => ({
      ...base('commitment', id), _kind: 'commitment', statement, direction: 'inbound', promised_at: now,
      lifecycle_state: 'pending', due_status: 'no_deadline', expiry_policy: 'escalate_overdue', derivation: 'user_declared',
      state_changed_at: now, lifecycle_changed_at: now, due_status_changed_at: now, blocks_task_ids: [], blocks_project_ids: [], ...extra,
    });
    const contactLabels = { client: 'Acme legal' };
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
      { ...base('note', 'readonly-note'), _kind: 'note', source_id: 'remote.note', title: 'Provider reference note', body: 'Read-only source material.', last_user_action_at: now,
        related_project_ids: [], related_contact_ids: [], related_mail_thread_ids: [], related_calendar_event_ids: [] },
      promise('approval', 'Client will approve the launch', { blocks_project_ids: ['launch'], counterparty_contact_id: 'client',
        promised_for_at: now - 86_400_000, due_status: 'overdue' }),
      promise('delivery', 'Send the release package', { direction: 'outbound', blocks_project_ids: ['launch'],
        promised_for_at: now + 86_400_000, due_status: 'not_due' }),
      promise('internal', 'Check the final checklist', { direction: 'internal', blocks_project_ids: ['launch'] }),
      promise('finished', 'Earlier approval received', { blocks_project_ids: ['launch'], lifecycle_state: 'fulfilled' }),
      promise('unlinked', 'Arrange customer training', { blocks_project_ids: ['other'] }),
      promise('readonly', 'Vendor controls this promise', { source_id: 'remote.commitment' }),
    ];
    const sources = ['task', 'note', 'project', 'commitment'].map(kind => ({ id: `recued.${kind}`, top_tier_kind: kind,
      source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now }));
    sources.push({ id: 'remote.project', top_tier_kind: 'project', source_kind: 'connection', source_label: 'Read-only projects', write_capable: false, registered_at: now });
    sources.push({ id: 'remote.commitment', top_tier_kind: 'commitment', source_kind: 'connection', source_label: 'Read-only promises', write_capable: false, registered_at: now });
    sources.push({ id: 'remote.note', top_tier_kind: 'note', source_kind: 'connection', source_label: 'Read-only notes', write_capable: false, registered_at: now });
    const reads: WorkEntityProjectItemsRpcRequest[] = [];
    const writes: Array<Record<string, unknown>> = [];
    let held: (() => void) | undefined;
    let holdPage = false;
    let wrongCreateLink = false;
    let noteFailure = failNotes;
    let failCommitmentRead = false;
    let omitLinkConfirmation = false;
    let holdLinkWrite = false;
    let heldLinkWrite: (() => void) | undefined;
    const controls = { reads, writes,
      holdNextLinkWrite() { holdLinkWrite = true; },
      releaseLinkWrite() { if (!heldLinkWrite) throw new Error('No project link write is waiting.'); const finish = heldLinkWrite; heldLinkWrite = undefined; finish(); },
      confirmLink(id: string) { entities = entities.map(entity => {
        if (entity.id !== id || (entity._kind !== 'task' && entity._kind !== 'note')) return entity;
        const confirmed = { ...entity }; delete confirmed.pending_write; return confirmed;
      }); },
      changeLinks(kind: 'task' | 'note', id: string, projects: string[]) {
        entities = entities.map(entity => entity._kind === kind && entity.id === id
          ? entity._kind === 'task' ? { ...entity, parent_project_id: projects[0] } : { ...entity, related_project_ids: projects } : entity);
      },
      setSourceWritable(kind: 'task' | 'note', value: boolean) { sources.find(source => source.id === `recued.${kind}`)!.write_capable = value; },
      omitNextLinkConfirmation() { omitLinkConfirmation = true; },
      updateFromServer(title: string) {
        entities = entities.map(entity => entity._kind === 'project' && entity.id === 'launch' ? { ...entity, title }
          : entity._kind === 'task' && entity.id === 'task-00' ? { ...entity, done: true } : entity);
      },
      setProjectWritable(value: boolean) { sources.find(source => source.id === 'recued.project')!.write_capable = value; },
      changeNextCreateLink() { wrongCreateLink = true; },
      failNotes(value: boolean) { noteFailure = value; },
      failNextCommitmentRead() { failCommitmentRead = true; },
      holdTaskPage() { holdPage = true; },
      releaseTaskPage() { if (!held) throw new Error('No task page is waiting.'); const finish = held; held = undefined; holdPage = false; finish(); },
    };
    Object.assign(window, { __projectOverview: controls, __connectionsFixture: async (method: string, raw: unknown) => {
      if (method === 'work_entity.source.list') return { result: { sources: structuredClone(sources) } };
      if (method === 'work_entity.list') {
        const args = raw as WorkEntityListRpcRequest;
        const query = args.search?.trim().toLowerCase() ?? '';
        const rows = entities.filter(entity => entity._kind === args.kind && (!args.source_id || entity.source_id === args.source_id)
          && (!query || (entity._kind === 'commitment' ? entity.statement : 'title' in entity ? entity.title ?? '' : '').toLowerCase().includes(query))
          && (entity._kind !== 'commitment' || (!args.commitment_filter || args.commitment_filter.direction === 'all' || entity.direction === args.commitment_filter.direction)
            && (!args.commitment_filter || args.commitment_filter.status === 'all'
              || args.commitment_filter.status === 'open' && entity.lifecycle_state === 'pending'
              || args.commitment_filter.status === 'overdue' && entity.lifecycle_state === 'pending' && entity.due_status === 'overdue'
              || args.commitment_filter.status === 'closed' && entity.lifecycle_state !== 'pending')));
        return { result: { entities: rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100)), total: rows.length, counterparty_labels: contactLabels } };
      }
      if (method === 'work_entity.get') {
        const args = raw as { kind: string; id: string };
        if (args.kind === 'commitment' && failCommitmentRead) {
          failCommitmentRead = false;
          return { error: { code: 'unavailable', message: 'Promise read interrupted.' } };
        }
        return { result: { entity: entities.find(entity => entity._kind === args.kind && entity.id === args.id) ?? null,
          ...(args.kind === 'commitment' ? { counterparty_labels: contactLabels } : {}),
          ...(args.kind === 'project' && args.id === 'other' ? { source_freshness: { source_id: 'remote.project', state: 'stale', last_success_at: now } } : {}) } };
      }
      if (method === 'work_entity.project.items') {
        const args = raw as WorkEntityProjectItemsRpcRequest;
        reads.push(args);
        if (args.kind === 'note' && noteFailure) return { error: { code: 'unavailable', message: 'Notes read interrupted.' } };
        const rows = entities.filter(entity => args.kind === 'task' ? entity._kind === 'task' && entity.parent_project_id === args.project_id
          : args.kind === 'note' ? entity._kind === 'note' && entity.related_project_ids.includes(args.project_id)
            : entity._kind === 'commitment' && entity.blocks_project_ids.includes(args.project_id)
              && (args.commitment_status === 'all' || entity.lifecycle_state === 'pending'));
        rows.sort((a, b) => a._kind === 'commitment' && b._kind === 'commitment'
          ? Number(a.lifecycle_state !== 'pending') - Number(b.lifecycle_state !== 'pending')
            || (a.promised_for_at ?? Infinity) - (b.promised_for_at ?? Infinity) || a.id.localeCompare(b.id)
          : Number(a._kind === 'task' && a.done) - Number(b._kind === 'task' && b.done) || a.id.localeCompare(b.id));
        const offset = args.offset ?? 0, limit = args.limit ?? 10;
        const response = { result: { project_id: args.project_id, kind: args.kind, offset, total: rows.length,
          ...(args.kind === 'task' ? { open_tasks: rows.filter(entity => entity._kind === 'task' && !entity.done).length } : {}),
          ...(args.kind === 'commitment' ? { commitment_status: args.commitment_status ?? 'open' } : {}),
          items: rows.slice(offset, offset + limit).map(entity => ({ id: entity.id,
            title: entity._kind === 'commitment' ? entity.statement : entity._kind === 'task' || entity._kind === 'note' ? entity.title ?? 'Note' : '',
            excerpt: entity._kind === 'task' || entity._kind === 'note' ? entity.body ?? '' : '', source_id: entity.source_id,
            source_label: 'Recued', updated_at: entity.updated_at, stale: false, pending_write: entity.pending_write !== undefined,
            ...(entity._kind === 'task' ? { done: entity.done, ...(entity.due_at !== undefined ? { due_at: entity.due_at } : {}) } : {}),
            ...(entity._kind === 'commitment' ? { commitment: { direction: entity.direction, lifecycle_state: entity.lifecycle_state,
              due_status: entity.due_status, ...(entity.promised_for_at !== undefined ? { promised_for_at: entity.promised_for_at } : {}),
              ...(entity.counterparty_contact_id ? { counterparty_label: contactLabels[entity.counterparty_contact_id as keyof typeof contactLabels] } : {}) } } : {}) })) } };
        if (args.kind === 'task' && args.project_id === 'launch' && offset > 0 && holdPage) return new Promise(resolve => { held = () => resolve(response); });
        return response;
      }
      if (method === 'work_entity.upsert') {
        const args = raw as WorkEntityUpsertRpcRequest;
        writes.push({ method, ...args });
        const id = 'id' in args && args.id ? args.id : `new-${args.kind}-${writes.length}`;
        const existing = entities.find(entity => entity._kind === args.kind && entity.id === id);
        let saved: WorkEntity;
        if (args.kind === 'task') {
          const prior = existing?._kind === 'task' ? existing : undefined;
          saved = { ...base('task', id), done: false, blocks_task_ids: [], ...prior, ...args,
            title: args.title ?? prior?.title ?? '', id, _kind: 'task', updated_at: now + writes.length };
        } else if (args.kind === 'note') {
          const prior = existing?._kind === 'note' ? existing : undefined;
          saved = { ...base('note', id), last_user_action_at: now,
            related_project_ids: [], related_contact_ids: [], related_calendar_event_ids: [], related_mail_thread_ids: [],
            ...prior, ...args, body: args.body ?? prior?.body ?? '', id, _kind: 'note', updated_at: now + writes.length };
        } else if (args.kind === 'project') {
          const prior = existing?._kind === 'project' ? existing : undefined;
          saved = { ...base('project', id), state: 'active', last_activity_at: now, related_contact_ids: [],
            ...prior, ...args, title: args.title ?? prior?.title ?? '', id, _kind: 'project', updated_at: now + writes.length };
        } else if (args.kind === 'commitment') {
          const prior = existing?._kind === 'commitment' ? existing : undefined;
          saved = { ...promise(id, ''), ...prior, ...args, statement: args.statement ?? prior?.statement ?? '',
            id, _kind: 'commitment', updated_at: now + writes.length };
        } else throw new Error(`Project overview fixture cannot save ${args.kind}`);
        if (!existing && saved._kind === 'task' && wrongCreateLink) { saved.parent_project_id = 'other'; wrongCreateLink = false; }
        if (saved._kind === 'project' && args.kind === 'project' && args.target_completion_at === null) delete saved.target_completion_at;
        if (saved._kind === 'task' && args.kind === 'task' && 'clear_due_at' in args && args.clear_due_at) delete saved.due_at;
        if (existing && holdLinkWrite) saved = { ...saved, pending_write: { staged_at: now, operation: 'update',
          dirty_fields: saved._kind === 'task' ? ['parent_project_id'] : ['related_project_ids'], state: 'awaiting_verify' } };
        entities = [...entities.filter(entity => !(entity._kind === args.kind && entity.id === id)), saved];
        if (existing && holdLinkWrite) {
          holdLinkWrite = false;
          return new Promise(resolve => { heldLinkWrite = () => resolve({ result: { entity: saved } }); });
        }
        if (existing && saved._kind === 'note' && omitLinkConfirmation) {
          omitLinkConfirmation = false;
          return { result: { entity: { ...saved, related_project_ids: saved.related_project_ids.filter(project => project !== 'launch') } } };
        }
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
      if (method === 'work_entity.commitment.fulfill' || method === 'work_entity.commitment.cancel') {
        const args = raw as { id: string };
        writes.push({ method, ...args });
        const entity = entities.find(row => row._kind === 'commitment' && row.id === args.id);
        if (!entity || entity._kind !== 'commitment') throw new Error('Missing fixture commitment');
        const saved: PromiseEntity = { ...entity, lifecycle_state: method.endsWith('fulfill') ? 'fulfilled' : 'cancelled', updated_at: now + writes.length };
        entities = entities.map(row => row === entity ? saved : row);
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
  changeLinks(kind: 'task' | 'note', id: string, projects: string[]): void;
  setSourceWritable(kind: 'task' | 'note', value: boolean): void;
  omitNextLinkConfirmation(): void;
  holdNextLinkWrite(): void;
  releaseLinkWrite(): void;
  confirmLink(id: string): void;
  failNotes(value: boolean): void;
  failNextCommitmentRead(): void;
  holdTaskPage(): void;
  updateFromServer(title: string): void;
  setProjectWritable(value: boolean): void;
  changeNextCreateLink(): void;
  releaseTaskPage(): void;
} } }
