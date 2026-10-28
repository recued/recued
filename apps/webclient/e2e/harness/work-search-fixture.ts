import { WORK_ENTITY_SEARCH_KINDS, type WorkEntity, type WorkEntitySearchKind, type WorkEntitySearchRpcRequest,
  type WorkEntitySearchRpcResponse, type WorkEntityUpsertRpcRequest } from '@recued/contracts';
import type { BootstrapDataRouteOptions } from '../../src/data/bootstrap-data-route.js';

const NOW = 1_700_000_000_000;
const base = (kind: WorkEntitySearchKind, id: string) => ({ id, source_id: `recued.${kind}`,
  sync_state: 'live' as const, conflict_policy: 'recued_wins' as const, created_at: NOW, updated_at: NOW, last_seen_at: NOW });

/** Native results exercise the production controller/renderers; the real SQLite
 * index and registered-client gate are qualified by the handler tests. */
export const createWorkSearchFixture = (request: <T>(kind: 'work' | 'work-page', query: string, result: () => T) => Promise<T>) => {
  let entities: WorkEntity[] = [
    { ...base('task', 'shared-id'), _kind: 'task', title: 'Kestrel task', body: 'Prepare the task.', done: false, blocks_task_ids: [] },
    { ...base('note', 'shared-id'), _kind: 'note', title: 'Kestrel note', body: '\n  Kestrel saved text 🧾\n<img src=x onerror="throw Error(\'unsafe\')">  \n',
      last_user_action_at: NOW, related_contact_ids: [], related_calendar_event_ids: [], related_mail_thread_ids: [], related_project_ids: [] },
    ...Array.from({ length: 10 }, (_, index): Extract<WorkEntity, { _kind: 'note' }> => ({ ...base('note', `note-${index}`), _kind: 'note',
      title: `Kestrel note ${index}`, body: `Kestrel complete note ${index}.`, last_user_action_at: NOW,
      ...(index === 0 ? { sync_state: 'stale_unreachable' } : {}),
      related_contact_ids: [], related_calendar_event_ids: [], related_mail_thread_ids: [], related_project_ids: [] })),
    { ...base('project', 'project-one'), _kind: 'project', title: 'Kestrel project', description: 'The project brief.',
      state: 'active', last_activity_at: NOW, related_contact_ids: [] },
    { ...base('commitment', 'promise-one'), _kind: 'commitment', statement: 'Kestrel promise', direction: 'outbound',
      promised_at: NOW, lifecycle_state: 'pending', due_status: 'no_deadline', expiry_policy: 'escalate_overdue',
      state_changed_at: NOW, lifecycle_changed_at: NOW, due_status_changed_at: NOW, derivation: 'user_declared',
      blocks_task_ids: [], blocks_project_ids: [] },
  ];
  let failure: WorkEntitySearchKind | undefined;
  const requests: WorkEntitySearchRpcRequest[] = [];
  const writes: WorkEntityUpsertRpcRequest[] = [];
  const search = (args: WorkEntitySearchRpcRequest): WorkEntitySearchRpcResponse => ({
    groups: (args.kind ? [args.kind] : WORK_ENTITY_SEARCH_KINDS).map(kind => {
      const offset = args.offset ?? 0; const limit = args.limit ?? 5;
      if (kind === failure) return { kind, matches: [], offset, more: false, error: 'Notes could not be searched. Try again.' };
      const rows = entities.filter(entity => entity._kind === kind).filter(entity => {
        const text = entity._kind === 'note' || entity._kind === 'task' ? `${entity.title ?? ''} ${entity.body ?? ''}`
          : entity._kind === 'project' ? `${entity.title} ${entity.description ?? ''}` : entity._kind === 'commitment' ? entity.statement : '';
        return args.query.toLowerCase().split(/\s+/).every(word => text.toLowerCase().includes(word));
      });
      return { kind, offset, more: rows.length > offset + limit, matches: rows.slice(offset, offset + limit).map(entity => ({
        id: entity.id, title: entity._kind === 'commitment' ? entity.statement : entity._kind === 'asset' ? entity.name : entity.title ?? 'Note',
        excerpt: entity._kind === 'task' || entity._kind === 'note' ? entity.body ?? '' : '',
        source_id: entity.source_id, source_label: 'Recued', updated_at: entity.updated_at,
        stale: entity.sync_state === 'stale_unreachable', pending_write: entity.pending_write !== undefined,
      })) };
    }),
  });
  const callers: Partial<BootstrapDataRouteOptions> = {
    projectItemsCaller: async args => ({ project_id: args.project_id, kind: args.kind, offset: args.offset ?? 0,
      items: [], total: 0, ...(args.kind === 'task' ? { open_tasks: 0 } : {}) }),
    workEntitySearchCaller: args => {
      requests.push(args);
      const result = search(args);
      return request(args.kind ? 'work-page' : 'work', args.query, () => result);
    },
    workEntitySourceListCaller: async () => ({ sources: WORK_ENTITY_SEARCH_KINDS.map(kind => ({ id: `recued.${kind}`,
      top_tier_kind: kind, source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: NOW })) }),
    workEntityListCaller: async args => ({ entities: entities.filter(entity => entity._kind === args.kind),
      total: entities.filter(entity => entity._kind === args.kind).length }),
    workEntityGetCaller: async args => ({ entity: entities.find(entity => entity._kind === args.kind && entity.id === args.id) ?? null }),
    timelineCaller: async () => ({ entries: [] }),
    workEntityUpsertCaller: async args => {
      writes.push(args);
      const index = entities.findIndex(entity => entity._kind === args.kind && 'id' in args && entity.id === args.id);
      const entity = entities[index];
      if (!entity) throw new Error('Missing fixture entity');
      let saved: WorkEntity = entity;
      if (entity._kind === 'task' && args.kind === 'task') saved = { ...entity, title: args.title ?? entity.title, body: args.body ?? entity.body, updated_at: NOW + 60_000 };
      else if (entity._kind === 'note' && args.kind === 'note') saved = { ...entity, title: args.title ?? entity.title, body: args.body ?? entity.body, updated_at: NOW + 60_000 };
      else if (entity._kind === 'project' && args.kind === 'project') saved = { ...entity, title: args.title ?? entity.title, description: args.description ?? entity.description, updated_at: NOW + 60_000 };
      else if (entity._kind === 'commitment' && args.kind === 'commitment') saved = { ...entity, statement: args.statement ?? entity.statement, updated_at: NOW + 60_000 };
      entities = entities.map((value, position) => position === index ? saved : value);
      return { entity: saved };
    },
  };
  return { callers, requests, writes, fail(kind?: WorkEntitySearchKind) { failure = kind; } };
};
