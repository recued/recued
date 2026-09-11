import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { TaskListFilter, WorkEntityListRpcRequest } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { handleWorkEntityList, type WorkEntityCrudRpcDeps } from '../work-entity-crud-handler.js';

let db: Database.Database;
let store: WorkEntityStore;
let deps: WorkEntityCrudRpcDeps;
const filter: TaskListFilter = { completion: 'all', sort: 'default', due: { kind: 'all' } };
beforeEach(() => {
  db = new Database(':memory:');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  for (const id of ['recued.task', 'connected.task']) store.registerSource({
    id, top_tier_kind: 'task', source_kind: 'builtin', source_label: id, write_capable: true,
  });
  const resolver = createWorkEntityResolver(store);
  deps = { store, resolver, dispatchers: createWorkEntityDispatchers({ store, resolver, bus: createWarehouseEventBus() }) };
});
afterEach(() => db.close());

const write = (id: string, input: Partial<Parameters<WorkEntityStore['writeTask']>[0]> = {}) =>
  store.writeTask({ title: id, source_id: 'recued.task', ...input, id }, 1000);
const list = (input: Omit<WorkEntityListRpcRequest, 'kind'> = {}) =>
  handleWorkEntityList(deps, { kind: 'task', task_filter: filter, ...input });

describe('task Data queries through the real RPC handler, resolver and SQLite store', () => {
  it('finds title and body matches beyond the first page, with literal Unicode and LIKE punctuation', async () => {
    for (let i = 0; i < 205; i++) write(`recent-${i}`, { updated_at: 9000 + i });
    write('title', { title: 'Invoice École_100%', updated_at: 1 });
    write('body', { body: 'Pay invoice école_100% soon', updated_at: 2 });
    write('wildcard-decoy', { title: 'Invoice ÉcoleX100x', updated_at: 0 });
    write('other-source', { title: 'Invoice École_100%', source_id: 'connected.task' });
    const request = { search: '  ÉCOLE_100% ', source_id: 'recued.task', limit: 1 };
    const first = await list(request);
    const second = await list({ ...request, offset: 1 });
    expect(first.entities.map((row) => row.id)).toEqual(['body']);
    expect(second.entities.map((row) => row.id)).toEqual(['title']);
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect((await list({ search: 'ÉCOLE_100%' })).total).toBe(3);
  });

  it('keeps saved task searches longer than the old booking-only 200-character limit usable', async () => {
    const search = 'detail'.repeat(100);
    write('long-body', { body: search });
    expect((await list({ search })).entities.map((row) => row.id)).toEqual(['long-body']);
    await expect(list({ search: 'x'.repeat(2001) })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('orders the entire task set by due date before paging, with stable ties and no-date tasks last', async () => {
    write('recent', { due_at: 8000, updated_at: 9000 });
    write('b', { due_at: 2000, updated_at: 1 });
    write('a', { due_at: 2000, updated_at: 1 });
    write('completed', { done: true, due_at: 1000, completed_at: 1000 });
    write('undated', { updated_at: 20000 });
    const ids: string[] = [];
    for (let offset = 0; offset < 5; offset += 2) {
      const page = await list({ task_filter: { ...filter, sort: 'due_asc' }, offset, limit: 2 });
      expect(page.total).toBe(5);
      ids.push(...page.entities.map((row) => row.id));
    }
    expect(ids).toEqual(['completed', 'a', 'b', 'recent', 'undated']);
    expect((await list({ limit: 2 })).entities.map((row) => row.id)).toEqual(['a', 'b']);
    expect(store.listTasks({ limit: 1 })[0]?.id).toBe('undated');
  });

  it('composes completion, source, query and due range with inclusive start and exclusive end', async () => {
    write('before', { due_at: 999 });
    write('edge-start', { due_at: 1000 });
    write('inside', { due_at: 1999 });
    write('edge-end', { due_at: 2000 });
    write('no-date');
    write('done', { done: true, due_at: 1500 });
    write('remote', { due_at: 1500, source_id: 'connected.task' });
    const request = { source_id: 'recued.task', task_filter: {
      completion: 'open' as const, sort: 'due_asc' as const, due: { kind: 'range' as const, from: 1000, before: 2000 },
    } };
    expect((await list(request)).entities.map((row) => row.id)).toEqual(['edge-start', 'inside']);
    expect((await list({ ...request, search: 'edge' })).total).toBe(1);
    expect((await list({ ...request, task_filter: { ...request.task_filter, completion: 'completed' } })).total).toBe(1);
  });

  it('overdue excludes completed and undated tasks and does not include the exact current instant', async () => {
    write('past', { due_at: 999 });
    write('now', { due_at: 1000 });
    write('done', { due_at: 500, done: true });
    write('undated');
    const overdue: TaskListFilter = { ...filter, due: { kind: 'overdue', before: 1000 } };
    expect((await list({ task_filter: overdue })).entities.map((row) => row.id)).toEqual(['past']);
    expect((await list({ task_filter: { ...overdue, completion: 'completed' } })).total).toBe(0);
  });

  it('excludes read-through residue before both pagination and total', async () => {
    store.registerSource({ id: 'live-only', top_tier_kind: 'task', source_kind: 'connection',
      source_label: 'Read on demand', write_capable: false, sync_posture: 'read_through' });
    for (let i = 0; i < 4; i++) write(`residue-${i}`, { source_id: 'live-only', due_at: 1 });
    write('visible-a', { due_at: 2 });
    write('visible-b', { due_at: 3 });
    const first = await list({ limit: 1 });
    const second = await list({ limit: 1, offset: 1 });
    expect(first.entities.map((row) => row.id)).toEqual(['visible-a']);
    expect(second.entities.map((row) => row.id)).toEqual(['visible-b']);
    expect([first.total, second.total]).toEqual([2, 2]);
  });

  it('rejects malformed task filters and filters sent for a different kind', async () => {
    for (const bad of [null, { ...filter, completion: 'pending' }, { ...filter, due: { kind: 'range', from: 5, before: 2 } }]) {
      const args = { kind: 'task', task_filter: bad } as unknown as WorkEntityListRpcRequest;
      await expect(handleWorkEntityList(deps, args)).rejects.toMatchObject({ code: 'bad_request' });
    }
    await expect(handleWorkEntityList(deps, { kind: 'booking', task_filter: filter }))
      .rejects.toMatchObject({ code: 'bad_request' });
    await expect(list({ booking_lifecycle_states: ['confirmed'] })).rejects.toMatchObject({ code: 'bad_request' });
  });
});
