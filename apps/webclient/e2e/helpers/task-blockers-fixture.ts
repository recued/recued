import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { RECUED_BUILTIN_SOURCE_ID, WORK_ENTITY_KINDS, type Task, type WorkEntityGetRpcResponse, type WorkEntityListRpcResponse, type WorkEntitySourceFreshness } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers } from '../../../../backend/server/src/work-entity-crud-handler.js';

/** The task list, dependency reads, edits and completion use real owner CRUD
 * handlers and SQLite. Transport faults and source freshness are controlled. */
export const installTaskBlockersFixture = async (page: Page) => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  await page.clock.install({ time: new Date(now) });
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), bus = createWarehouseEventBus(), resolver = createWorkEntityResolver(store);
  for (const kind of WORK_ENTITY_KINDS) store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind, source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now });
  store.registerSource({ id: 'imported.task', top_tier_kind: 'task', source_kind: 'builtin', source_label: 'Imported', write_capable: false, registered_at: now });
  store.writeTask({ id: 'blocker-open', source_id: 'recued.task', title: 'Review launch', done: false }, now);
  store.writeTask({ id: 'blocker-done', source_id: 'imported.task', title: 'Approve launch', done: true }, now);
  store.writeTask({ id: 'owner-one', source_id: 'recued.task', title: 'Ship launch', body: 'Keep the launch notes.', done: false,
    due_at: now + 3600000, blocks_task_ids: ['blocker-open', 'blocker-done'] }, now);
  store.writeTask({ id: 'owner-two', source_id: 'recued.task', title: 'Ship follow-up', done: false,
    due_at: now + 7200000, blocks_task_ids: ['blocker-open'] }, now);
  const handlers = makeWorkEntityCrudHandlers({ store, resolver, dispatchers: createWorkEntityDispatchers({ store, resolver, bus, now: () => now + 1000 }) })!.handlers;
  const client = { instance_id: 'task-blockers-browser', client_kind: 'webclient' } as never;
  const reads: string[] = [], mutations: Array<{ method: string; args: Record<string, unknown> }> = [];
  const failed = new Set<string>(), held = new Set<string>(), releases = new Map<string, () => void>();
  const freshness = new Map<string, Partial<WorkEntitySourceFreshness>>();
  let ownerFreshness: WorkEntitySourceFreshness | undefined;
  await page.exposeFunction('__taskBlockersRpc', async (method: string, raw: Record<string, unknown>) => {
    const args = raw ?? {};
    try {
      if (method === 'work_entity.source.list') return { result: { sources: store.listSources() } };
      if (method === 'collection.listInstances') return { result: { instances: [] } };
      if (method === 'yours.today') return { error: { code: 'unknown_method', message: 'No proactive fixture.' } };
      if (method === 'yours.spheres') return { result: { placements: (args.refs as Array<{ collection: string; id: string }>).map(ref => ({ ref, sphere: 'professional', reason: 'Work task' })) } };
      const handler = handlers[method as keyof typeof handlers]; if (!handler) return undefined;
      const isTask = method === 'work_entity.get' && args.kind === 'task', id = String(args.id);
      if (isTask) { reads.push(id); if (failed.has(id)) throw new Error('Task source unavailable.'); }
      if (method === 'work_entity.upsert' || method === 'work_entity.task.mark_done') mutations.push({ method, args: structuredClone(args) });
      let result: unknown = await handler(args as never, client);
      if (method === 'work_entity.list' && args.kind === 'task' && ownerFreshness) {
        const list: WorkEntityListRpcResponse = { ...(result as WorkEntityListRpcResponse), source_freshness: [ownerFreshness] }; result = list;
      }
      if (isTask && freshness.has(id)) {
        const value = result as WorkEntityGetRpcResponse;
        result = { ...value, source_freshness: { source_id: value.entity?.source_id ?? 'recued.task', state: 'local', ...freshness.get(id) } };
      }
      if (isTask && held.delete(id)) await new Promise<void>(done => { releases.set(id, done); });
      return { result };
    } catch (error) { return { error: { code: String((error as { code?: string }).code ?? 'unavailable'), message: error instanceof Error ? error.message : String(error) } }; }
  });
  await page.addInitScript(() => Object.assign(window, { __connectionsFixture: (method: string, args: unknown) =>
    (window as unknown as { __taskBlockersRpc(method: string, args: unknown): Promise<unknown> }).__taskBlockersRpc(method, args) }));
  return { reads, mutations, task: (id = 'owner-one') => store.readTask(id)!,
    update: (id: string, patch: Partial<Task>) => store.writeTask({ ...store.readTask(id)!, ...patch }, now + 1000),
    remove: (id: string) => store.deleteTask(id, { tombstone: true }),
    fail: (id: string, value: boolean) => { if (value) failed.add(id); else failed.delete(id); },
    fresh: (id: string, value: Partial<WorkEntitySourceFreshness>) => freshness.set(id, value),
    ownerFresh: (value: WorkEntitySourceFreshness) => { ownerFreshness = value; },
    hold: (id: string) => held.add(id), waiting: (id: string) => releases.has(id),
    release: (id: string) => { const done = releases.get(id); releases.delete(id); done?.(); },
    dispose() { for (const done of releases.values()) done(); releases.clear(); bus.dispose(); db.close(); } };
};
