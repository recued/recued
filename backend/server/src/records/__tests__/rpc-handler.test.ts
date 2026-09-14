import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  RecordsExecutionBinding,
  RecordsPackRef,
  RecordsSchemaSnapshot,
} from '@recued/contracts';
import { makeRecordsRpcHandlers } from '../../records-rpc-handler.js';
import type { WsClient } from '../../ws-server.js';
import { createRecordsStore } from '../store.js';
import { createSavedDataViewStore } from '../../saved-data-view-store.js';

const owner: RecordsPackRef = { publisher: 'publisher.example', pack_slug: 'board' };
const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    job: {
      kind: 'job',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'title', slot: 's1', kind: 'string', required: true, privacy: 'content' },
        { key: 'status', slot: 's2', kind: 'string', required: true },
      ],
    },
  },
};

const binding = (action: RecordsExecutionBinding['action']): RecordsExecutionBinding => ({
  kind: 'core.records',
  action,
  entity: 'job',
  owner,
  pack_version: 1,
  storage_schema_hash: 'a'.repeat(64),
  declaration_hash: 'b'.repeat(64),
  operation_digest: `digest:${action}`,
  ...(action === 'search' ? { filter_fields: ['status'] } : {}),
});

const paired = { instance_id: 'paired-device' } as WsClient;
const unpaired = { instance_id: null } as WsClient;

describe('D-221 Records owner rpc', () => {
  it('refuses an unpaired client on EVERY method, not just the one the surface is named for', async () => {
    // The whole surface is owner-only: it deletes rows, purges namespaces,
    // repairs accounting, and raises global quota. Proving the gate on one
    // read method leaves the fifteen that matter most resting on a convention.
    const db = new Database(':memory:');
    const slice = makeRecordsRpcHandlers({ store: createRecordsStore(db) })!;
    expect(slice.methods).toHaveLength(16);
    for (const method of slice.methods) {
      await expect(
        (slice.handlers[method] as (args: unknown, client: WsClient) => Promise<unknown>)(
          { owner, entity: 'job', id: 'x', confirmation: 'x', event_id: 'x' },
          unpaired,
        ),
        method,
      ).rejects.toMatchObject({ code: 'unauthorized' });
    }
    db.close();
  });

  const dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('reopens saved filters against current data and binds both page directions to their query', async () => {
    const db = new Database(':memory:'); dbs.push(db);
    const store = createRecordsStore(db);
    store.installNamespace({ owner, version: 1, storage_schema_hash: 'a'.repeat(64),
      declaration_hash: 'b'.repeat(64), artifact_digest: 'artifact-1',
      schema: { ...schema, entities: { job: { ...schema.entities.job!, fields: [
        ...schema.entities.job!.fields,
        { key: 'amount', slot: 'dec1', kind: 'decimal', required: true },
        { key: 'paid', slot: 'b1', kind: 'boolean', required: true },
      ] } } }, bindings: { create: binding('create'), search: binding('search') } });
    const create = (id: number) => store.execute({ binding: binding('create'), principal: 'user_self',
      args: { id: `job-${id}`, values: { title: `Job ${id}`, status: id % 2 === 0 ? 'open' : 'closed', amount: `${id}.0000`, paid: false } } });
    for (let i = 0; i < 8; i++) create(i);
    const views = createSavedDataViewStore(db);
    const saved = views.create({ name: 'Open jobs', definition: { tab: 'records', owner, entity: 'job',
      filters: { amount: { op: 'gte', value: '2.0000' }, paid: { op: 'eq', value: false }, status: { op: 'eq', value: 'open' } }, sort: '-amount' } });
    const query = () => {
      const definition = views.get(saved.id)!.definition;
      if (definition.tab !== 'records' || !definition.owner || !definition.entity) throw new Error('Expected Records view');
      return { ...definition, owner: definition.owner, entity: definition.entity, limit: 2 };
    };
    const handlers = makeRecordsRpcHandlers({ store })!.handlers;
    // A saved null comparison must not silently become IS NOT NULL and turn an
    // empty SQL result into every populated row.
    expect((await handlers['records.search']({ ...query(), filters: { amount: { op: 'ne', value: null } } }, paired)).records).toEqual([]);
    expect(() => views.create({ name: 'Null comparison',
      // @ts-expect-error Runtime input can contain a null comparison.
      definition: { tab: 'records', owner, entity: 'job', filters: { amount: { op: 'ne', value: null } } },
    })).toThrow(/Invalid saved view settings/);
    const first = await handlers['records.search'](query(), paired);
    expect(first.records.map(row => row.id)).toEqual(['job-6', 'job-4']);
    expect(first.next_cursor).toBeTruthy();
    const second = await handlers['records.search']({ ...query(), cursor: first.next_cursor }, paired);
    expect(second.records.map(row => row.id)).toEqual(['job-2']);
    expect(second.prev_cursor).toBeTruthy();
    const back = await handlers['records.search']({ ...query(), cursor: second.prev_cursor }, paired);
    expect(back.records.map(row => row.id)).toEqual(['job-6', 'job-4']);
    await expect(handlers['records.search']({ ...query(), sort: 'amount', cursor: first.next_cursor }, paired))
      .rejects.toMatchObject({ code: 'records_cursor_invalid' });
    create(8);
    expect((await handlers['records.search'](query(), paired)).records.map(row => row.id)).toEqual(['job-8', 'job-6']);
    expect(views.get(saved.id)).toEqual(saved);
    expect(saved.definition).not.toHaveProperty('cursor');
  });

  it('is registered-pair only and lists full-ref namespaces without a data.* resolver', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const store = createRecordsStore(db);
    store.installNamespace({
      owner,
      version: 1,
      storage_schema_hash: 'a'.repeat(64),
      declaration_hash: 'b'.repeat(64),
      artifact_digest: 'artifact-1',
      schema,
      bindings: {
        create: binding('create'),
        search: binding('search'),
        delete: binding('delete'),
      },
    });
    const created = store.execute({
      binding: binding('create'),
      args: { id: 'job-1', values: { title: 'Call Alice', status: 'open' } },
      principal: 'user_self',
    }) as { record: { _record: { version: number; revision: number } } };
    const slice = makeRecordsRpcHandlers({ store })!;

    await expect(slice.handlers['records.namespace.list'](undefined, unpaired))
      .rejects.toMatchObject({ code: 'unauthorized' });
    expect(await slice.handlers['records.namespace.list'](undefined, paired))
      .toMatchObject({
        namespaces: [{ owner, state: { state: 'ready', version: 1 } }],
        global_quota: { row_count: 1, outbox_count: 1, reserved_payload_bytes: 0 },
      });
    const nextGlobalQuota = await slice.handlers['records.quota.set_global']({
      row_limit: 2,
      byte_limit: 2_000,
      outbox_limit: 2,
    }, paired);
    expect(nextGlobalQuota).toMatchObject({
      row_limit: 2,
      byte_limit: 2_000,
      outbox_limit: 2,
    });
    expect(await slice.handlers['records.kind.list']({ owner }, paired))
      .toEqual({ kinds: [{ kind: 'job', rows: 1, payload_bytes: expect.any(Number) }] });
    expect(await slice.handlers['records.search']({
      owner,
      entity: 'job',
      filters: { status: 'open' },
    }, paired)).toMatchObject({ records: [{ id: 'job-1', title: 'Call Alice' }] });
    expect(await slice.handlers['records.get']({ owner, entity: 'job', id: 'job-1' }, paired))
      .toMatchObject({
        record: { id: 'job-1', title: 'Call Alice' },
        diagnostics: {
          raw_slots: { s1: 'Call Alice', s2: 'open', r1: null },
          incoming: [],
          outgoing: [],
        },
      });
    const csv = await slice.handlers['records.export']({ owner, format: 'csv' }, paired);
    expect(csv).toMatchObject({
      format: 'recued.records.csv.v1',
      owner,
      version: 1,
      schema,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    if (csv.format !== 'recued.records.csv.v1') throw new Error('expected csv export');
    expect(csv.csv).toContain('"job.title"');
    expect(csv.csv).toContain('"Call Alice"');

    const outbox = await slice.handlers['records.outbox.list']({ owner }, paired);
    expect(outbox).toMatchObject({
      pending: 1,
      delivered: 0,
      dead_letter: 0,
      total_retries: 0,
      events: [{ status: 'pending', event: { id: 'job-1' } }],
    });

    expect(await slice.handlers['records.delete']({
      owner,
      entity: 'job',
      id: 'job-1',
      expected_version: created.record._record.version,
      expected_revision: created.record._record.revision,
    }, paired)).toEqual({ deleted: true, id: 'job-1', revision: 1 });
    expect(store.listOutbox(owner)).toHaveLength(2);
    expect(store.listOutbox(owner).at(-1)).toMatchObject({
      type: 'record.deleted',
      cause: 'owner_delete',
      id: 'job-1',
    });
    const pendingDelete = store.listOutbox(owner, 'pending').at(-1)!;
    await expect(slice.handlers['records.outbox.retire']({
      owner,
      event_id: pendingDelete.event_id,
      confirmation: 'wrong',
    }, paired)).rejects.toMatchObject({ code: 'records_invalid' });
    expect(await slice.handlers['records.outbox.retire']({
      owner,
      event_id: pendingDelete.event_id,
      confirmation: pendingDelete.event_id,
    }, paired)).toEqual({ retired: true });

    await expect(slice.handlers['records.purge']({
      owner,
      confirmation: 'publisher.example/board',
    }, paired)).rejects.toMatchObject({ code: 'records_not_ready' });
    store.orphanNamespace(owner);
    expect(await slice.handlers['records.purge']({
      owner,
      confirmation: 'publisher.example/board',
    }, paired)).toEqual({ rows_deleted: 0, events_deleted: 2 });
    expect(store.getNamespace(owner)).toBeNull();
  });

  it('maps store failures to stable rpc errors and drops cleanly when unwired', async () => {
    expect(makeRecordsRpcHandlers(undefined)).toBeUndefined();
    const db = new Database(':memory:');
    dbs.push(db);
    const slice = makeRecordsRpcHandlers({ store: createRecordsStore(db) })!;
    await expect(slice.handlers['records.kind.list']({ owner }, paired))
      .rejects.toMatchObject({ code: 'records_not_found', status: 404 });
    await expect(slice.handlers['records.get']({
      owner: { publisher: '', pack_slug: 'board' },
      entity: 'job',
      id: 'job-1',
    }, paired)).rejects.toMatchObject({ code: 'bad_request' });
  });
});
