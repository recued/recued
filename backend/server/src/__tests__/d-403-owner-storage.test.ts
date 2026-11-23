/** D-403 slices 1 and 2 (D-403) — what takes space, by kind, and the purge the owner
 *  runs, over the real stores: a Records namespace, the run log with its counter and indexes, the
 *  provenance links and the asset reading history, all in one SQLite database as on a server. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVER_RPC_METHODS, RpcError, type RecordsExecutionBinding } from '@recued/contracts';
import { createAuditLogStore, type ActivityEntry, type AuditEntry, type AuditLogStore } from '@recued/storage';
import { createRecordsStore, type RecordsStore } from '../records/store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { ensureAuditIndexes } from '../audit-indexes.js';
import { ensureAuditUsageCounter, readAuditUsageBytes } from '../audit-usage-counter.js';
import { ensureMemorySchema, getOrCreateRecipeInsight } from '../memory-schema.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { PAUSE_LOCAL_METHODS } from '../pause-rpc-local-methods.js';
import { MCP_RESERVED_RPC_PREFIXES } from '@recued/contracts';
import { createOwnerStorage, type OwnerStorage } from '../owner-storage.js';
import { makeOwnerStorageRpcHandlers } from '../owner-storage-rpc.js';
import type { WsClient } from '../ws-server.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const BODY = { publisher: 'recued-core', pack_slug: 'body-signals' } as const;
const METRICS = 'records:recued-core/body-signals/daily_metric';

const bindingFor = (action: RecordsExecutionBinding['action']): RecordsExecutionBinding => ({
  kind: 'core.records', action, entity: 'daily_metric', owner: BODY, pack_version: 1,
  storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64), operation_digest: `body:${action}`,
});

interface World {
  db: Database.Database; records: RecordsStore; auditLog: AuditLogStore; storage: OwnerStorage;
  work: ReturnType<typeof createWorkEntityStore>; setClock(at: number): void;
  saveRow(id: string, at: number): void; run(id: string, at: number, status?: AuditEntry['commit_status']): Promise<void>;
  link(run: string, at: number): void;
  activity(action: string, at: number): Promise<void>;
}

const world = (): World => {
  let clock = NOW;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const records = createRecordsStore(db, { now: () => clock });
  records.installNamespace({ owner: BODY, version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64),
    artifact_digest: 'artifact:body', schema: { decimal_scale: 4, entities: { daily_metric: { kind: 'daily_metric', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true }, { key: 'metric', slot: 's1', kind: 'string', required: true },
      { key: 'value', slot: 'n1', kind: 'number', required: true }] } } },
    bindings: { create: bindingFor('create'), delete: bindingFor('delete') } });
  const auditLog = createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'audit_entries'), createSQLiteCollection<ActivityEntry>(db, 'audit_activities'));
  ensureAuditIndexes(db);
  ensureAuditUsageCounter(db);
  ensureMemorySchema(db);
  ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const insight = getOrCreateRecipeInsight(db, { hash: 'h', slug: 'sync-mail', version: 1, flattened: '{}' });
  const storage = createOwnerStorage({ db, records, auditLog, now: () => clock,
    packName: (owner) => (owner.pack_slug === 'body-signals' ? 'Body signals' : null),
    gates: () => [{ surface: 'collection:mail:gmail', used: 5_000 }, { surface: 'shared_store', used: 700 }, { surface: 'vault', used: 90 }] });
  return {
    db, records, auditLog, storage, work, setClock: (at) => { clock = at; },
    saveRow: (id, at) => {
      clock = at;
      records.execute({ binding: bindingFor('create'), args: { id, values: { metric: 'sleep_minutes', value: 420 } }, principal: 'owner' });
    },
    run: (id, at, status = 'succeeded') => auditLog.append({ run_id: id, recipe_id: 'sync-mail', recipe_hash: 'h', started_at: at,
      finished_at: at + 10, duration_ms: 10, commit_status: status, config_snapshot: {}, errors: [], trigger_url: null, trigger_source: null, instance_id: null }),
    link: (run, at) => {
      db.prepare('INSERT INTO links (memory_id, entity_id, recipe_insight_id, kind, ts, origin_actor) VALUES (?,?,?,?,?,?)')
        .run(run, `mail:${run}`, insight, 'execution.action', at, 'system');
    },
    activity: (action, at) => auditLog.logActivity({ activity_id: '', timestamp: at, action: action as ActivityEntry['action'], target: 'x', detail: '' }),
  };
};

describe('D-403 slice 1 — what takes space, by kind', () => {
  let w: World;
  beforeEach(() => { w = world(); });
  afterEach(() => w.db.close());

  it('lists each kind in the owner\'s words, with its items, size, oldest item and growth over 30 days', async () => {
    w.saveRow('a', NOW - 90 * DAY); w.saveRow('b', NOW - 10 * DAY);
    await w.run('old', NOW - 60 * DAY); await w.run('new', NOW - 2 * DAY);
    w.setClock(NOW);
    const { kinds, database } = w.storage.read();
    const byKind = Object.fromEntries(kinds.map((kind) => [kind.kind, kind]));
    expect(byKind[METRICS]).toMatchObject({ group: 'records', label: 'Body signals · Daily metric', items: 2, item_words: 'rows',
      oldest_at: NOW - 90 * DAY, added_30d: 1, purge: { by: 'saved', export: 'records' } });
    expect(byKind[METRICS]!.bytes).toBe(w.records.getNamespace(BODY)!.quota.payload_bytes);
    expect(byKind.runs).toMatchObject({ label: 'Run history', items: 2, oldest_at: NOW - 60 * DAY, added_30d: 1,
      bytes: readAuditUsageBytes(w.db), purge: { by: 'started', export: 'runs' } });
    expect(byKind.reading_history).toMatchObject({ items: 0, purge: { by: 'taken' } });
    // The copies from their gates: a size, no count, and why they can't go yet. The vault is not data to purge.
    expect(byKind['mail:gmail']).toMatchObject({ group: 'copies', label: 'Mail copies · gmail', bytes: 5_000, hold: 'resyncs' });
    expect(byKind['mail:gmail']!.items).toBeUndefined();
    expect(byKind.shared).toMatchObject({ group: 'yours', bytes: 700, hold: 'yours' });
    expect(byKind.knowledge).toBeUndefined(); // no knowledge store on this database
    expect(kinds.some((kind) => kind.kind === 'vault')).toBe(false);
    // Grouped as the view shows them: records, then activity, assets, the copies, and the owner's own.
    expect(kinds.map((kind) => kind.group)).toEqual(['records', 'activity', 'assets', 'copies', 'yours']);
    expect(database.file_bytes).toBeGreaterThan(0);
    expect(database.free_bytes).toBeGreaterThanOrEqual(0);
  });

  it('reads once a minute: a second read within it is the first', () => {
    w.saveRow('a', NOW - 90 * DAY);
    w.setClock(NOW);
    const first = w.storage.read();
    w.saveRow('b', NOW - 89 * DAY);
    w.setClock(NOW + 30_000);
    expect(w.storage.read()).toBe(first);
    w.setClock(NOW + 61_000);
    expect(w.storage.read().kinds.find((kind) => kind.kind === METRICS)?.items).toBe(2);
  });
});

describe('D-403 slice 2 — deleting a kind\'s items older than a date', () => {
  let w: World;
  beforeEach(() => { w = world(); });
  afterEach(() => w.db.close());

  it('deletes the Records rows saved before the cutoff, as previewed, and records the purge where no prune reaches it', async () => {
    w.saveRow('a', NOW - 90 * DAY); w.saveRow('b', NOW - 80 * DAY); w.saveRow('c', NOW - 10 * DAY);
    w.setClock(NOW);
    const before = NOW - 30 * DAY;
    const preview = w.storage.preview(METRICS, before);
    expect(preview).toMatchObject({ kind: METRICS, before, items: 2, oldest_at: NOW - 90 * DAY, newest_at: NOW - 80 * DAY });
    expect(w.storage.read().kinds.find((kind) => kind.kind === METRICS)?.items).toBe(3); // a preview deletes nothing
    const result = await w.storage.run(METRICS, before, preview.token);
    expect(result).toMatchObject({ kind: METRICS, deleted: 2, blocked: 0, bytes_freed: preview.bytes });
    expect(['a', 'b', 'c'].map((id) => w.records.ownerGet(BODY, 'daily_metric', id) !== null)).toEqual([false, false, true]);
    // The view shows it at once, not a minute later.
    expect(w.storage.read().kinds.find((kind) => kind.kind === METRICS)?.items).toBe(1);
    const recorded = await w.auditLog.listActivities(10);
    const purge = recorded.find((activity) => activity.action === 'source_data_purged');
    expect(purge).toMatchObject({ target: `storage:${METRICS}` });
    expect(JSON.parse(purge!.detail!)).toMatchObject({ by: 'owner', kind: METRICS, before, deleted: 2, blocked: 0 });
    expect(w.db.prepare(`SELECT json_extract(data, '$.reserve') AS reserve FROM audit_activities
      WHERE json_extract(data, '$.action') = 'source_data_purged'`).get()).toEqual({ reserve: 1 });
  });

  it('takes runs and activities from before the cutoff with each run\'s links, never a reserve row or a run awaiting the owner', async () => {
    await w.run('old', NOW - 60 * DAY); w.link('old', NOW - 60 * DAY);
    await w.run('held', NOW - 60 * DAY, 'awaiting_approval');
    await w.run('new', NOW - 2 * DAY); w.link('new', NOW - 2 * DAY);
    await w.activity('notification_fired', NOW - 60 * DAY);
    await w.activity('audit_retention_prune', NOW - 60 * DAY);
    await w.activity('notification_fired', NOW - 2 * DAY);
    w.setClock(NOW);
    const before = NOW - 30 * DAY;
    const used = readAuditUsageBytes(w.db);
    const preview = w.storage.preview('runs', before);
    expect(preview).toMatchObject({ items: 1, oldest_at: NOW - 60 * DAY, newest_at: NOW - 60 * DAY });
    const result = await w.storage.run('runs', before, preview.token);
    expect(result).toMatchObject({ deleted: 1, blocked: 0 });
    expect(await w.auditLog.get('old')).toBeNull();
    expect(await w.auditLog.get('held')).not.toBeNull();
    expect(await w.auditLog.get('new')).not.toBeNull();
    expect(w.db.prepare('SELECT memory_id FROM links ORDER BY memory_id').all()).toEqual([{ memory_id: 'new' }]);
    const actions = (w.db.prepare(`SELECT json_extract(data, '$.action') AS action, json_extract(data, '$.timestamp') AS at
      FROM audit_activities ORDER BY at, action`).all() as Array<{ action: string; at: number }>).map((row) => `${row.action}@${String((NOW - row.at) / DAY)}`);
    expect(actions).toEqual(['audit_retention_prune@60', 'notification_fired@2', 'source_data_purged@0']);
    // The counter the run log's gate reads: what went, less the purge's own record.
    expect(result.bytes_freed).toBeGreaterThan(0);
    expect(readAuditUsageBytes(w.db)).toBeLessThan(used);
  });

  it('deletes readings taken before the cutoff; the asset keeps its current reading', () => {
    const asset = w.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Bulb' }, NOW - 50 * DAY);
    for (const days of [50, 40, 5]) {
      w.work.writeAsset({ id: asset.id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' },
        readings: { watts: { value: days, unit: 'W', as_of: NOW - days * DAY, evidence: [] } } }, NOW - days * DAY);
    }
    w.setClock(NOW);
    expect(w.work.assetReadingHistory(asset.id, 'watts')).toHaveLength(3);
    const preview = w.storage.preview('reading_history', NOW - 30 * DAY);
    expect(preview).toMatchObject({ items: 2, oldest_at: NOW - 50 * DAY, newest_at: NOW - 40 * DAY });
    return w.storage.run('reading_history', NOW - 30 * DAY, preview.token).then((result) => {
      expect(result).toMatchObject({ deleted: 2, blocked: 0 });
      expect(w.work.assetReadingHistory(asset.id, 'watts').map((reading) => reading.value)).toEqual([5]);
      expect(w.work.readAsset(asset.id)!.readings.watts).toMatchObject({ value: 5 });
    });
  });

  it('binds a run to its preview: the same kind and cutoff, within its minute, and the same count', async () => {
    await w.run('old', NOW - 60 * DAY);
    w.setClock(NOW);
    const before = NOW - 30 * DAY;
    const expired = w.storage.preview('runs', before);
    w.setClock(NOW + 61_000);
    await expect(w.storage.run('runs', before, expired.token)).rejects.toThrow(/expired/);
    const other = w.storage.preview('runs', before);
    await expect(w.storage.run('runs', before - DAY, other.token)).rejects.toThrow(/expired/);
    // A token is spent once, whatever happened to it.
    await expect(w.storage.run('runs', before, other.token)).rejects.toThrow(/expired/);
    const moved = w.storage.preview('runs', before);
    await w.run('older', NOW - 70 * DAY);
    await expect(w.storage.run('runs', before, moved.token)).rejects.toThrow(/changed since the preview \(1, now 2\)/);
    expect(await w.auditLog.get('old')).not.toBeNull();
  });

  it('keeps the last day, and refuses a kind it does not hold or cannot purge yet', () => {
    w.setClock(NOW);
    expect(() => w.storage.preview('runs', NOW - DAY + 1)).toThrow(/keeps the last day/);
    expect(() => w.storage.preview('runs', 0)).toThrow(/epoch ms/);
    expect(() => w.storage.preview('nonsense', NOW - 30 * DAY)).toThrow(/not a kind this server holds/);
    expect(() => w.storage.preview('mail:gmail', NOW - 30 * DAY)).toThrow(/can't be purged here yet/);
    expect(() => w.storage.preview('shared', NOW - 30 * DAY)).toThrow(/can't be purged here yet/);
  });
});

describe('D-403 — the methods: the owner\'s app only', () => {
  let w: World;
  beforeEach(() => { w = world(); });
  afterEach(() => w.db.close());
  const paired = { instance_id: 'owner-phone' } as unknown as WsClient;
  const stranger = {} as unknown as WsClient;

  it('answers a registered paired client, refuses anything else, and maps each refusal to its code', async () => {
    const slice = makeOwnerStorageRpcHandlers({ storage: w.storage })!;
    expect(slice.methods).toEqual(['storage.kinds.read', 'storage.purge.preview', 'storage.purge.run']);
    await expect(slice.handlers['storage.kinds.read']({} as never, stranger)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await slice.handlers['storage.kinds.read']({} as never, paired)).kinds.length).toBeGreaterThan(0);
    const refused = async (method: 'storage.purge.preview' | 'storage.purge.run', args: unknown) => {
      try { await slice.handlers[method](args as never, paired); return undefined; } catch (error) { return error instanceof RpcError ? error.code : String(error); }
    };
    expect(await refused('storage.purge.preview', { kind: 'runs' })).toBe('bad_request');
    expect(await refused('storage.purge.preview', { kind: 'runs', before: NOW - 1 })).toBe('bad_request');
    expect(await refused('storage.purge.preview', { kind: 'nonsense', before: NOW - 30 * DAY })).toBe('not_found');
    expect(await refused('storage.purge.run', { kind: 'runs', before: NOW - 30 * DAY })).toBe('bad_request');
    expect(await refused('storage.purge.run', { kind: 'runs', before: NOW - 30 * DAY, token: 'never-issued' })).toBe('conflict');
  });

  it('is a server method, left open by the pause, and out of reach of every AI app', () => {
    for (const method of ['storage.kinds.read', 'storage.purge.preview', 'storage.purge.run']) {
      expect(SERVER_RPC_METHODS, method).toContain(method);
      expect(PAUSE_LOCAL_METHODS.has(method), method).toBe(true);
      expect(MCP_RESERVED_RPC_PREFIXES.some((prefix) => method.startsWith(prefix)), method).toBe(true);
    }
  });
});
