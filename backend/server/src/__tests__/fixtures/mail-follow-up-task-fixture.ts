import { RECUED_BUILTIN_SOURCE_ID, WORK_ENTITY_KINDS, type WorkEntity, type Task } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createMailFollowUpFixture } from './mail-follow-up-fixture.js';
import { ensureWorkEntitySchema, createWorkEntityStore } from '../../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../work-entity-ingredients.js';
import { handleWorkEntityUpsert, makeWorkEntityCrudHandlers, type WorkEntityCrudRpcDeps } from '../../work-entity-crud-handler.js';
import type { MailFollowUpTaskRead } from '../../mail-follow-up-task-read.js';
import { createMailFollowUpTaskWriter } from '../../mail-follow-up-task-create.js';
import type { WsClient } from '../../ws-server.js';

/** Canonical task store, resolver, event-emitting completion dispatcher and
 * encrypted watch storage. The mail records remain the controlled sync source. */
export const createMailFollowUpTaskFixture = async (ownerToken?: () => string) => {
  let deps: WorkEntityCrudRpcDeps, stale = false, unavailable = false, afterRead: (() => Promise<void>) | undefined;
  const snapshot = (id: string): MailFollowUpTaskRead => {
    if (unavailable) throw Error('Task source unavailable');
    const entity = deps.resolver.readEntity('task', id), source = entity ? deps.store.getSource(entity.source_id) : null;
    const [freshness] = entity ? deps.resolver.sourceFreshness('task', { source_id: entity.source_id }) ?? [] : [];
    return { entity, source, ...(stale && entity ? { source_freshness: { source_id: entity.source_id, state: 'stale' as const } }
      : freshness ? { source_freshness: freshness } : {}) };
  };
  const f = createMailFollowUpFixture(ownerToken, { current: snapshot, create: createMailFollowUpTaskWriter(() => deps ?? null), read: async id => {
    const result = snapshot(id); const hook = afterRead; afterRead = undefined; await hook?.(); return result;
  } });
  ensureWorkEntitySchema(f.db); const taskStore = createWorkEntityStore(f.db);
  for (const kind of WORK_ENTITY_KINDS) taskStore.registerSource({ id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind,
    source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: f.now() });
  const resolver = createWorkEntityResolver(taskStore), bus = createWarehouseEventBus();
  deps = { store: taskStore, resolver, dispatchers: createWorkEntityDispatchers({ store: taskStore, resolver, bus, now: f.now }) };
  const client = { client_kind: 'webclient', instance_id: 'task-watch-browser', client_token_id: 'paired-owner' } as WsClient;
  const workHandlers = makeWorkEntityCrudHandlers(deps)!.handlers;
  const createTask = async (title: string): Promise<Extract<WorkEntity, { _kind: 'task' }>> => {
    const result = await handleWorkEntityUpsert(deps, { kind: 'task', title, due_at: f.now() + 3600000 });
    if (result.entity._kind !== 'task') throw Error('Expected task'); return result.entity;
  };
  const task = await createTask('Get revised estimate');
  const complete = (id = task.id) => workHandlers['work_entity.task.mark_done']({ id, done: true }, client);
  return { ...f, taskStore, task, createTask, complete, client, workHandlers, deps, bus,
    snapshot, stale: (value: boolean) => { stale = value; }, unavailable: (value: boolean) => { unavailable = value; },
    afterTaskRead: (hook: () => Promise<void>) => { afterRead = hook; },
    currentTask: (id = task.id): Task | null => taskStore.readTask(id),
  };
};
