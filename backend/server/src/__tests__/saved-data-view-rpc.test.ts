import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { MCP_RESERVED_RPC_PREFIXES, type SavedDataView } from '@recued/contracts';
import { startServer } from '../server.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createSavedDataViewStore } from '../saved-data-view-store.js';
import { createSavedTaskViewReader } from '../saved-data-view-task-reader.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWarehouseEventBus } from '@recued/warehouse-events';

interface Reply { request_id: string; result?: unknown; error?: { code: string; message: string } }
const rpc = (ws: WebSocket, method: string, args: unknown = {}): Promise<Reply> => new Promise((resolve, reject) => {
  const request_id = crypto.randomUUID();
  const timeout = setTimeout(() => { ws.off('message', receive); reject(new Error(`RPC timeout: ${method}`)); }, 5000);
  const receive = (data: WebSocket.RawData): void => {
    const reply: Reply = JSON.parse(data.toString());
    if (reply.request_id !== request_id) return;
    clearTimeout(timeout); ws.off('message', receive); resolve(reply);
  };
  ws.on('message', receive);
  ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
});

it('serves shared saved views over real paired webclient sockets and refuses unpaired callers', async () => {
  const db = new Database(':memory:');
  const tokens = createClientTokenStore(db, { argon2_params: { t: 1, m: 8, p: 1 } });
  ensureWorkEntitySchema(db);
  const workStore = createWorkEntityStore(db);
  const store = createSavedDataViewStore(db, { readTasks: createSavedTaskViewReader(workStore) });
  workStore.registerSource({ id: 'recued.task', top_tier_kind: 'task', source_kind: 'builtin',
    source_label: 'Tasks', write_capable: true });
  const resolver = createWorkEntityResolver(workStore);
  const server = await startServer(0, { clientTokens: tokens, savedDataViewStore: store,
    workEntityCrudDeps: { store: workStore, resolver,
      dispatchers: createWorkEntityDispatchers({ store: workStore, resolver, bus: createWarehouseEventBus() }) } });
  const sockets: WebSocket[] = [];
  const connect = async (instance?: string): Promise<WebSocket> => {
    const token = await tokens.issue({ client_kind: 'webclient', client_label: 'Views test',
      ...(instance === undefined ? {} : { metadata: { instance_id: instance } }) });
    return new Promise((resolve, reject) => {
      const bearer = encodeURIComponent(`${token.token_id}.${token.bearer}`);
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${bearer}`);
      sockets.push(ws); ws.once('open', () => resolve(ws));
      ws.once('error', (error) => reject(new Error(`${instance ?? 'unpaired'}: ${error.message}`)));
    });
  };
  try {
    const first = await connect('browser-one');
    const second = await connect('browser-two');
    const unpaired = await connect();
    for (const method of ['list', 'get', 'create', 'update', 'rename', 'delete']) {
      expect(await rpc(unpaired, `data_views.${method}`)).toMatchObject({ error: { code: 'unauthorized' } });
    }
    const response = await rpc(first, 'data_views.create', { name: 'Acme', definition: { tab: 'contact', query: 'Acme' } });
    expect(response.error).toBeUndefined();
    const { view } = response.result as { view: SavedDataView };
    expect(view.name).toBe('Acme');
    expect(await rpc(second, 'data_views.get', { id: view.id })).toMatchObject({ result: { view } });
    expect(await rpc(second, 'data_views.list')).toMatchObject({ result: { views: [view] } });
    const renamed = await rpc(second, 'data_views.rename', { id: view.id, name: 'Customers', expected_revision: 1 });
    expect(renamed).toMatchObject({ result: { view: { id: view.id, name: 'Customers', revision: 2 } } });
    expect(await rpc(first, 'data_views.update', { id: view.id, expected_revision: 1, definition: { tab: 'contact', query: 'Changed' } }))
      .toMatchObject({ error: { code: 'conflict' } });
    expect(await rpc(first, 'data_views.delete', { id: view.id, expected_revision: 1 })).toMatchObject({ error: { code: 'conflict' } });
    expect(await rpc(second, 'data_views.delete', { id: view.id, expected_revision: 2 })).toMatchObject({ result: { deleted: true } });
    expect(await rpc(first, 'data_views.get', { id: view.id })).toMatchObject({ result: { view: null } });
    expect(await rpc(first, 'data_views.create', { name: 'Wrong', definition: { tab: 'search', query: 'secret', rows: ['private'] } }))
      .toMatchObject({ error: { code: 'bad_request' } });
    expect(store.list()).toEqual([]);
    const definition = { tab: 'task', query: 'invoice', source_id: 'recued.task', booking_lifecycle: 'all',
      task_filters: { completion: 'open', due: 'overdue', sort: 'due_asc' } };
    const taskView = await rpc(first, 'data_views.create', { name: 'Overdue invoices', definition });
    expect(taskView).toMatchObject({ result: { view: { definition } } });
    expect(await rpc(second, 'data_views.list')).toMatchObject({ result: { views: [{ definition }] } });
    const { view: createdTaskView } = taskView.result as { view: SavedDataView };
    const nextWeek = { ...definition, task_filters: { completion: 'open', due: 'next_7_days', sort: 'due_asc' } };
    expect(await rpc(second, 'data_views.update', { id: createdTaskView.id, expected_revision: 1, definition: nextWeek }))
      .toMatchObject({ result: { view: { id: createdTaskView.id, name: 'Overdue invoices', revision: 2, definition: nextWeek } } });
    expect(await rpc(first, 'data_views.get', { id: createdTaskView.id }))
      .toMatchObject({ result: { view: { revision: 2, definition: nextWeek } } });
    expect(await rpc(first, 'data_views.update', { id: createdTaskView.id, expected_revision: 1, definition }))
      .toMatchObject({ error: { code: 'conflict' } });
    expect(await rpc(first, 'data_views.update', { id: createdTaskView.id, expected_revision: 2,
      definition: { ...nextWeek, rows: ['private'] } })).toMatchObject({ error: { code: 'bad_request' } });
    expect(await rpc(first, 'data_views.update', { id: createdTaskView.id }))
      .toMatchObject({ error: { code: 'conflict' } });
    for (let i = 0; i < 102; i++) workStore.writeTask({
      id: `future-${i}`, source_id: 'recued.task', title: 'Invoice later', due_at: 10000,
    }, 10000 + i);
    workStore.writeTask({ id: 'overdue', source_id: 'recued.task', title: 'Invoice now', due_at: 1000 }, 1);
    const taskQuery = { kind: 'task', source_id: 'recued.task', search: 'invoice', limit: 1,
      task_filter: { completion: 'open', sort: 'due_asc', due: { kind: 'overdue', before: 2000 } } };
    expect(await rpc(second, 'work_entity.list', taskQuery)).toMatchObject({
      result: { entities: [{ id: 'overdue' }], total: 1 },
    });
    expect(await rpc(unpaired, 'work_entity.list', taskQuery)).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(unpaired, 'work_entity.task.mark_done', { id: 'overdue', done: true }))
      .toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(first, 'work_entity.task.mark_done', { id: 'overdue', done: true }))
      .toMatchObject({ result: { entity: { _kind: 'task', id: 'overdue', done: true } } });
    expect(await rpc(second, 'work_entity.list', taskQuery)).toMatchObject({ result: { entities: [], total: 0 } });
    expect(await rpc(second, 'work_entity.get', { kind: 'task', id: 'overdue' }))
      .toMatchObject({ result: { entity: { done: true, due_at: 1000 } } });
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('data_views.');
    expect(await rpc(first, 'data_views.update', { id: createdTaskView.id, expected_revision: 2,
      alert: { enabled: true, time_zone: 'America/Los_Angeles' } }))
      .toMatchObject({ result: { view: { revision: 3, definition: nextWeek,
        alert: { enabled: true, status: 'watching', time_zone: 'America/Los_Angeles' } } } });
    expect(await rpc(unpaired, 'data_views.update', { id: createdTaskView.id, expected_revision: 3,
      alert: { enabled: false, time_zone: 'America/Los_Angeles' } }))
      .toMatchObject({ error: { code: 'unauthorized' } });
    expect(await rpc(second, 'data_views.update', { id: createdTaskView.id, expected_revision: 2,
      alert: { enabled: false, time_zone: 'America/Los_Angeles' } }))
      .toMatchObject({ error: { code: 'conflict' } });
    expect(await rpc(second, 'data_views.update', { id: createdTaskView.id, expected_revision: 3,
      alert: { enabled: false, time_zone: 'America/Los_Angeles' } }))
      .toMatchObject({ result: { view: { revision: 4, alert: { enabled: false, status: 'paused' } } } });
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.close(); db.close();
  }
}, 15000);
