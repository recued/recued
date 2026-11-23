import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { WORK_ENTITY_KINDS, RECUED_BUILTIN_SOURCE_ID, type Task, type WorkEntityUpsertRpcRequest, type WorkEntitySearchRpcResponse } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers } from '../../../../backend/server/src/work-entity-crud-handler.js';

/** Real SQLite search, reads and dependency writes. Only transport faults
 * and delayed response delivery are simulated. */
export const installWorkTaskPickerFixture = async (page: Page) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), bus = createWarehouseEventBus(), resolver = createWorkEntityResolver(store);
  const now = Date.parse('2026-11-16T12:00:00Z');
  for (const kind of WORK_ENTITY_KINDS) store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind,
    source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now });
  store.registerSource({ id: 'imported.task', top_tier_kind: 'task', source_kind: 'builtin', source_label: 'Imported', write_capable: false });
  store.writeTask({ id: 'task-a', source_id: 'recued.task', title: 'Launch checklist', done: false }, now);
  store.writeTask({ id: 'task-b', source_id: 'imported.task', title: 'Launch checklist', done: true }, now);
  store.writeTask({ id: 'task-c', source_id: 'recued.task', title: 'Café <review>', done: false }, now);
  store.writeTask({ id: 'task-one', source_id: 'recued.task', title: 'Launch review', body: 'Keep these notes.', done: false,
    priority: 'high', due_at: now + 86400000, blocks_task_ids: ['task-a', 'task-b'] }, now);
  const handlers = makeWorkEntityCrudHandlers({ store, resolver, dispatchers: createWorkEntityDispatchers({ store, resolver, bus, now: () => now + 1000 }) })!.handlers;
  const client = { instance_id: 'task-picker-browser', client_kind: 'webclient' } as never;
  const writes: WorkEntityUpsertRpcRequest[] = [], reads: string[] = [];
  const failedNames = new Set<string>(), heldNames = new Set<string>(), releases = new Map<string, () => void>();
  let heldQuery: string | null = null, failedSearch = false, wrongGroup = false, more = false;
  let heldTimeline: string | null = null;
  const timelineReads = new Map<string, number>();
  await page.exposeFunction('__workTaskPickerRpc', async (method: string, raw: Record<string, unknown>) => {
    const args = raw ?? {};
    try {
      if (method === 'work_entity.source.list') return { result: { sources: store.listSources() } };
      if (method === 'data.timeline') {
        const id = String(args.entity_id), count = (timelineReads.get(id) ?? 0) + 1; timelineReads.set(id, count);
        if (heldTimeline === id && count === 2) { heldTimeline = null; await new Promise<void>(done => releases.set('timeline', done)); }
        return { result: { entries: [] } };
      }
      const handler = handlers[method as keyof typeof handlers]; if (!handler) return undefined;
      const isName = method === 'work_entity.get' && args.kind === 'task';
      const isSearch = method === 'work_entity.search' && args.kind === 'task';
      if (isName) reads.push(String(args.id));
      if (isName && failedNames.has(String(args.id))) throw new Error('Task details lookup failed.');
      if (isSearch && failedSearch) throw new Error('The task index is unavailable.');
      if (method === 'work_entity.upsert') writes.push(structuredClone(args) as unknown as WorkEntityUpsertRpcRequest);
      const result = await handler(args as never, client);
      if (isName && heldNames.delete(String(args.id))) await new Promise<void>(done => { releases.set(String(args.id), done); });
      if (isSearch && heldQuery === args.query) { heldQuery = null; await new Promise<void>(done => { releases.set('search', done); }); }
      if (isSearch && (wrongGroup || more)) {
        const response = result as WorkEntitySearchRpcResponse;
        return { result: { groups: response.groups.map(group => ({ ...group, ...(wrongGroup ? { kind: 'project' } : {}), ...(more ? { more: true } : {}) })) } };
      }
      return { result };
    } catch (error) { return { error: { code: String((error as { code?: string }).code ?? 'unavailable'), message: error instanceof Error ? error.message : String(error) } }; }
  });
  await page.addInitScript(() => Object.assign(window, { __connectionsFixture: (method: string, args: unknown) =>
    (window as unknown as { __workTaskPickerRpc(method: string, args: unknown): Promise<unknown> }).__workTaskPickerRpc(method, args) }));
  const update = (id: string, patch: Partial<Task>) => store.writeTask({ ...store.readTask(id)!, ...patch }, now + 1000);
  return { writes, reads, task: () => store.readTask('task-one')!, tasks: () => store.listTasks(), update,
    failName: (id: string, fail: boolean) => { if (fail) failedNames.add(id); else failedNames.delete(id); },
    holdName: (id: string) => { heldNames.add(id); }, holdSearch: (query: string) => { heldQuery = query; },
    holdTimeline: (id: string) => { heldTimeline = id; },
    waiting: (key: string) => releases.has(key), release: (key: string) => { const done = releases.get(key); releases.delete(key); done?.(); },
    failSearch: (fail: boolean) => { failedSearch = fail; }, wrongInventory: (value: boolean) => { wrongGroup = value; }, truncated: () => { more = true; },
    remove: (id: string) => store.deleteTask(id, { tombstone: true }),
    dispose() { for (const done of releases.values()) done(); releases.clear(); bus.dispose(); db.close(); } };
};
