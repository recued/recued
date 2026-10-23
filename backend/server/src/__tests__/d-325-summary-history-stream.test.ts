import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetCreateInput, AssetReading, AssetRule, YoursReadRequest } from '@recued/contracts';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel, type NotificationSettings, type PendingAsk } from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { summarizeYoursAsset } from '../situations/asset-summary.js';

const at = Date.parse('2026-10-17T12:00Z'); const DAY = 86400000;
const base = { source_id: 'recued.asset', source: { kind: 'owner' as const, ref: 'fixture-owner' } };
const objective = (patch: Partial<Extract<AssetRule['when'], { kind: 'objective' }>> = {}): Extract<AssetRule['when'], { kind: 'objective' }> =>
  ({ kind: 'objective', field: 'meter', target: 100, unit: 'km', direction: 'rising', mode: 'usage', lead_days: 0, ...patch });
const rule: AssetRule = { id: 'usage', title: 'Service', enabled: true, muted: true, pinned: false, consequence: 'routine', expiry_policy: 'escalate_overdue',
  when: objective(),
  reaction: { notify: false, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } };
const sample = (value: number, as_of = at, unit = 'km'): AssetReading => ({ value, unit, as_of, evidence: [{ collection: 'file', id: 'file:fixture:sample' }] });
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
const gate = () => {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const fixture = () => {
  let measured: string[] | undefined;
  const db = new Database(':memory:', { verbose(sql) { if (measured) { if (typeof sql !== 'string') throw new Error('Missing SQL trace'); measured.push(sql); } } });
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const rows = createAssetOccurrenceStore(db);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => at, timeZone: () => 'UTC' });
  const service = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db), now: () => at, timeZone: () => 'UTC' });
  disposals.push(async () => { await service.stop(); db.close(); });
  const fuel: AssetRule = { ...rule, id: 'fuel', when: objective({ field: 'fuel', unit: 'L' }) };
  const put = (id: string, patch: Partial<AssetCreateInput> = {}, time = at) => work.writeAsset({ ...base, id, name: `Fixture ${id}`, rules: [rule, { ...rule, id: 'duplicate' }, fuel], readings: { meter: null, fuel: null }, ...patch }, time);
  const seed = (asset_id: string, field: string, reading: AssetReading) => db.prepare('INSERT INTO asset_reading_history(asset_id,field,as_of,value) VALUES(?,?,?,?) ON CONFLICT(asset_id,field,as_of) DO UPDATE SET value=excluded.value')
    .run(asset_id, field, reading.as_of, JSON.stringify(reading));
  const measure = async <T>(read: () => T | Promise<T>) => {
    const sql: string[] = []; measured = sql;
    try { return { value: await read(), sql }; } finally { measured = undefined; }
  };
  const pause = () => {
    const entered = gate(); const release = gate();
    const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
      channels: [createUiChannel({ busSink: () => {} })] });
    service.bind({ ...block, async getReminderDestinations() { entered.resolve(); await release.promise; return { destinations: [], issues: [] }; } });
    return { entered, release };
  };
  const retained = async (request: YoursReadRequest) => {
    const scope = work.withAssetReadingHistories; work.withAssetReadingHistories = (_query, read) => read();
    try { return await service.snapshot(request); } finally { work.withAssetReadingHistories = scope; }
  };
  const all = () => {
    const assets: Asset[] = [];
    for (let offset = 0; ; offset += 200) { const page = work.listAssets({ limit: 200, offset }); assets.push(...page); if (page.length < 200) return assets; }
  };
  const seedAssets = (size: number) => db.transaction(() => { for (let n = 0; n < size; n++) {
    const id = `asset-${String(n).padStart(4, '0')}`;
    put(id, { readings: { meter: n % 3 ? sample(50, at - 2 * DAY) : null, fuel: n % 4 ? sample(10, at - 2 * DAY, 'L') : null } }, at + n);
    seed(id, 'meter', sample(40, at - 3 * DAY)); seed(id, 'fuel', sample(14, at - 3 * DAY, 'L'));
  } })();
  const capture = () => {
    const statements: Database.Statement[] = []; const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(sql => { const statement = prepare(sql); if (streamSql(sql)) statements.push(statement); return statement; });
    return statements;
  };
  return { db, work, rows, service, put, seed, measure, pause, retained, all, seedAssets, capture };
};
const streamSql = (sql: string) => /^WITH reading_stream_candidates\b/u.test(sql);
const batchSql = (sql: string) => /^WITH reading_requested\b/u.test(sql);
const requestsFor = (assets: readonly Asset[]) => assets.flatMap(asset => ['active', 'lent'].includes(asset.status)
  ? asset.rules.flatMap(rule => rule.enabled && rule.when.kind === 'objective' ? [{ asset_id: asset.id, field: rule.when.field }] : []) : []);
const individual = (work: ReturnType<typeof createWorkEntityStore>, requests: ReturnType<typeof requestsFor>, limit?: number) => {
  const result = new Map<string, Map<string, AssetReading[]>>();
  for (const { asset_id, field } of requests) {
    let fields = result.get(asset_id); if (!fields) { fields = new Map(); result.set(asset_id, fields); }
    fields.set(field, work.assetReadingHistory(asset_id, field, limit));
  }
  return result;
};

describe('request-scoped summary reading histories', () => {
  it('streams more than 1000 assets through one indexed query, retaining pair order, limits and independent samples', async () => {
    const f = fixture(); f.seedAssets(1001);
    const odd = "field-'漢?";
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.rules[0].when.field',?) WHERE id='asset-0500'").run(odd);
    f.seed('asset-0500', odd, sample(8));
    for (let n = 0; n < 145; n++) f.seed('asset-0999', 'meter', sample(n, at - n * 1000, n % 3 ? 'km' : 'mi'));
    f.db.prepare('UPDATE asset_reading_history SET value=? WHERE asset_id=? AND field=? AND as_of=?').run('{', 'asset-0999', 'meter', at - 144000);
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE');
      const assets = f.all(); const groups = Array.from({ length: Math.ceil(assets.length / 200) }, (_, n) => requestsFor(assets.slice(n * 200, (n + 1) * 200)));
      const expected = groups.map(requests => individual(f.work, requests));
      const read = await f.measure(() => f.work.withAssetReadingHistories({}, () => groups.map(requests => f.work.assetReadingHistories(requests))));
      expect(read.value).toEqual(expected); expect(read.sql.filter(streamSql)).toHaveLength(1); expect(read.sql.filter(batchSql)).toEqual([]);
      expect(read.value.flatMap(map => [...map.values()].flatMap(fields => [...fields.values()])).every(samples => samples.length <= 100)).toBe(true);
      const plans = f.db.prepare(`EXPLAIN QUERY PLAN ${read.sql.find(streamSql)!}`).all() as Array<{ detail: string }>;
      expect(plans.some(row => /SEARCH history USING INTEGER PRIMARY KEY/u.test(row.detail))).toBe(true);
      expect(plans.some(row => /COVERING INDEX.+asset_id=\? AND field=\?/u.test(row.detail))).toBe(true);
      expect(plans.some(row => /^SCAN (?:history|asset_reading_history)\b/u.test(row.detail))).toBe(false);
      expect(plans.some(row => row.detail === 'USE TEMP B-TREE FOR ORDER BY')).toBe(false);
      expect(plans.some(row => /MATERIALIZE reading_stream_candidates/u.test(row.detail))).toBe(false);
      expect(plans.some(row => /USING INDEX idx_asset_summary_history_order/u.test(row.detail))).toBe(true);
    }
  });

  it('opens only for requested pairs, permits nested reads and closes a partially consumed stream', async () => {
    const f = fixture(); f.seedAssets(401); const statements = f.capture(); const assets = f.all();
    const empty = await f.measure(() => f.work.withAssetReadingHistories({}, () => f.work.assetReadingHistories([])));
    expect(empty.value.size).toBe(0); expect(empty.sql).toEqual([]); expect(statements).toEqual([]);
    f.work.withAssetReadingHistories({}, () => {
      const pairs = requestsFor(assets.slice(0, 1)); const result = f.work.assetReadingHistories(pairs);
      expect(result.size).toBe(1); expect(statements).toHaveLength(1); expect(statements[0]!.busy).toBe(true);
      expect(f.work.readAssetsEffective([assets[0]!.id]).get(assets[0]!.id)?.id).toBe(assets[0]!.id);
    });
    expect(statements[0]!.busy).toBe(false);
    const error = new Error('Fixture synchronous consumer failure');
    expect(() => f.work.withAssetReadingHistories({}, () => { f.work.assetReadingHistories(requestsFor(assets.slice(0, 1))); throw error; })).toThrow(error);
    expect(statements[1]!.busy).toBe(false);
  });

  it('retains custom limits and restores nested scopes without advancing the outer cursor', async () => {
    const f = fixture(); f.seedAssets(401); const assets = f.all(); const first = requestsFor(assets.slice(0, 1)); const later = requestsFor(assets.slice(1, 2));
    const limits = [0, 1, 7, 10001]; const expected = limits.map(limit => individual(f.work, first, limit));
    const read = await f.measure(() => f.work.withAssetReadingHistories({}, () => {
      expect(limits.map(limit => f.work.assetReadingHistories(first, limit))).toEqual(expected);
      expect(f.work.assetReadingHistories(first)).toEqual(individual(f.work, first));
      expect(f.work.withAssetReadingHistories({}, () => f.work.assetReadingHistories(first))).toEqual(individual(f.work, first));
      expect(f.work.assetReadingHistories(later)).toEqual(individual(f.work, later));
    }));
    expect(read.sql.filter(streamSql)).toHaveLength(2);
    expect(read.sql.filter(batchSql)).toHaveLength(4);
  });

  for (const asset_filter of ['missing_facts', 'overdue'] as const) for (const offset of [0, 197, 9999]) {
    it(`preserves complete ${asset_filter} snapshots and exact history requests at offset ${offset} with optional summaries`, async () => {
      const f = fixture(); f.seedAssets(601); const histories = vi.spyOn(f.work, 'assetReadingHistories');
      for (const include_asset_summaries of [false, true]) {
        const request = { asset_filter, offset, limit: 13, include_asset_summaries, search: 'Fixture asset-' };
        histories.mockClear(); const expected = await f.retained(request); const calls = structuredClone(histories.mock.calls); histories.mockClear();
        const read = await f.measure(() => f.service.snapshot(request));
        expect(read.value).toEqual(expected); expect(histories.mock.calls).toEqual(calls);
        expect(read.sql.filter(streamSql)).toHaveLength(1); expect(read.sql.filter(batchSql)).toEqual([]);
      }
    });
  }

  it('leaves ordinary, detail and sphere-only reads on their existing history path', async () => {
    const f = fixture(); f.put('target', { sphere: 'personal' });
    for (const request of [{}, { asset_id: 'target' }, { asset_sphere: 'personal' as const }]) {
      const read = await f.measure(() => f.service.snapshot({ ...request, include_asset_summaries: true }));
      expect(read.value.assets.map(asset => asset.id)).toEqual(['target']); expect(read.sql.filter(streamSql)).toEqual([]);
      expect(read.sql.filter(batchSql)).toHaveLength(1);
    }
    const empty = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', search: 'no-match' }));
    expect(empty.value.total_assets).toBe(0); expect(empty.sql.filter(streamSql)).toEqual([]);
  });

  it('matches literal Unicode name/class searches and raw visibility across active and stale assets', async () => {
    const f = fixture();
    for (const id of ['active', 'stale', 'deleted', 'hidden', 'retired']) f.put(id, { name: 'ÉCOLE 100%_[x]? 漢', class_id: 'class_special', status: id === 'retired' ? 'retired' : 'active' });
    f.db.prepare("UPDATE data_asset SET sync_state='stale_unreachable' WHERE id='stale'").run();
    f.db.prepare("UPDATE data_asset SET sync_state='tombstoned' WHERE id='hidden'").run();
    f.db.prepare("UPDATE data_asset SET deleted_at=1 WHERE id='deleted'").run();
    for (const search of [' ÉcOlE ', '%_[x]?', 'CLASS_SPECIAL', 'missing-match']) {
      const requests = requestsFor(f.work.listAssets({ search })); const expected = individual(f.work, requests);
      const read = await f.measure(() => f.work.withAssetReadingHistories({ search }, () => f.work.assetReadingHistories(requests)));
      expect(read.value).toEqual(expected); expect(read.sql.filter(streamSql)).toHaveLength(requests.length ? 1 : 0);
      expect(read.sql.filter(batchSql)).toEqual([]);
    }
  });

  it('retains nullable legacy identities and projection backfill while deferring unsupported history identities', async () => {
    const f = fixture(); f.put('valid', {}, at + 1); f.put('legacy', {}, at + 2); f.db.prepare("UPDATE data_asset SET id=NULL WHERE id='legacy'").run();
    const request = { asset_filter: 'missing_facts' as const, include_asset_summaries: true, limit: 1 };
    const expected = await f.retained(request); expect(expected.total_assets).toBe(2); expect(expected.assets.map(asset => asset.id)).toEqual(['valid']);
    const read = await f.measure(() => f.service.snapshot(request)); expect(read.value).toEqual(expected); expect(read.sql.filter(streamSql)).toEqual([]);
    f.db.prepare("UPDATE data_asset SET id='repaired' WHERE id IS NULL").run();
    const repaired = await f.retained(request); const next = await f.measure(() => f.service.snapshot(request));
    expect(next.value).toEqual(repaired); expect(next.sql.filter(streamSql)).toHaveLength(1);
  });

  it('honors delegating history wrappers and replacement list or history implementations', async () => {
    const f = fixture(); f.seedAssets(201); const original = f.work.assetReadingHistories;
    const delegated = vi.spyOn(f.work, 'assetReadingHistories').mockImplementation((requests, limit) => original(requests, limit));
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', include_asset_summaries: true }));
    expect(delegated).toHaveBeenCalledTimes(2); expect(read.sql.filter(streamSql)).toHaveLength(1); delegated.mockRestore();
    const list = f.work.listByKind; const replaced = vi.spyOn(f.work, 'listByKind').mockImplementation((kind, query) => list(kind, query));
    const fallback = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts' }));
    expect(fallback.value.total_assets).toBe(read.value.total_assets); expect(fallback.sql.filter(streamSql)).toEqual([]); replaced.mockRestore();
    const custom = vi.spyOn(f.work, 'assetReadingHistories').mockImplementation(requests => individual(f.work, requests as ReturnType<typeof requestsFor>));
    const customized = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts' }));
    expect(customized.value.total_assets).toBe(read.value.total_assets); expect(customized.sql.filter(streamSql)).toEqual([]); expect(custom).toHaveBeenCalledTimes(2);
  });

  it('falls back for out-of-order, absent or non-rule requests rather than fabricating empty histories', () => {
    const f = fixture(); f.seedAssets(4); f.seed('asset-0002', 'other', sample(99)); const assets = f.all();
    for (const requests of [[{ asset_id: 'asset-0002', field: 'other' }], [{ asset_id: 'absent', field: 'meter' }],
      requestsFor(assets).reverse()]) {
      const expected = individual(f.work, requests);
      expect(f.work.withAssetReadingHistories({}, () => f.work.assetReadingHistories(requests))).toEqual(expected);
      expect(f.work.assetReadingHistories(requests)).toEqual(expected);
    }
  });

  for (const failure of ['prepare', 'execution', 'later'] as const) it(`retains batch fallback after ${failure} stream failure without changing snapshots or unavailable counts`, async () => {
    const f = fixture(); f.seedAssets(601); const request = { asset_filter: 'missing_facts' as const, include_asset_summaries: true, offset: 3, limit: 13 };
    const expected = await f.retained(request); const prepare = f.db.prepare.bind(f.db); const statements: Database.Statement[] = []; let failed = false; let closed = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (streamSql(sql) && failure === 'prepare') { failed = true; throw new Error('Fixture history stream prepare failure'); }
      const statement = prepare(sql);
      if (streamSql(sql)) {
        statements.push(statement); const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
          if (failure === 'execution') { failed = true; throw new Error('Fixture history stream execution failure'); }
          const cursor = iterate(...params); let reads = 0;
          return { next() { if (++reads === 900) { failed = true; throw new Error('Fixture later history stream failure'); } return cursor.next(); },
            return() { closed++; return cursor.return?.() ?? { done: true, value: undefined }; }, [Symbol.iterator]() { return this; } };
        });
      }
      return statement;
    });
    expect(await f.service.snapshot(request)).toEqual(expected); expect(failed).toBe(true);
    expect(statements.every(statement => !statement.busy)).toBe(true); expect(closed).toBe(failure === 'later' ? 1 : 0);
  });

  it('replays selection with ordinary histories after stream cleanup fails', async () => {
    const f = fixture(); f.seedAssets(401); const request = { asset_filter: 'missing_facts' as const, include_asset_summaries: true, offset: 3, limit: 13 };
    const expected = await f.retained(request); const prepare = f.db.prepare.bind(f.db); const statements: Database.Statement[] = []; let closed = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (streamSql(sql)) {
        statements.push(statement); const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
          const cursor = iterate(...params);
          return { next() { return cursor.next(); }, return() { cursor.return?.(); closed++; throw new Error('Fixture history cleanup failure'); }, [Symbol.iterator]() { return this; } };
        });
      }
      return statement;
    });
    const read = await f.measure(() => f.service.snapshot(request)); expect(read.value).toEqual(expected);
    expect(closed).toBe(1); expect(statements[0]!.busy).toBe(false); expect(read.sql.filter(batchSql).length).toBeGreaterThan(0);
    expect(read.sql.filter(sql => /^SELECT \* FROM data_asset\b/u.test(sql) && /ORDER BY updated_at DESC,id ASC$/u.test(sql))).toHaveLength(2);
  });

  for (const corrupt of ['history', 'rules'] as const) it(`isolates later corrupt ${corrupt} without poisoning earlier batches`, async () => {
    const f = fixture(); f.seedAssets(401);
    if (corrupt === 'history') f.db.prepare("UPDATE asset_reading_history SET value='{' WHERE asset_id='asset-0001' AND field='meter'").run();
    else f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.rules',NULL) WHERE id='asset-0001'").run();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = { asset_filter: 'missing_facts' as const, include_asset_summaries: true, offset: 3, limit: 13 };
    const expected = await f.retained(request); expect(expected.asset_filter?.unavailable).toBe(1);
    const statements = f.capture(); expect(await f.service.snapshot(request)).toEqual(expected); expect(statements.every(statement => !statement.busy)).toBe(true);
  });

  it('ignores unrelated and disabled fields, legacy kind exclusions and duplicate JSON keys', async () => {
    const f = fixture(); f.seedAssets(401);
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$._kind','note','$.rules',NULL) WHERE id='asset-0200'").run();
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.deleted_at',1) WHERE id='asset-0201'").run();
    const hidden = f.db.prepare("SELECT asset_summary_history_fields(data_blob,status,sync_state,deleted_at) AS fields FROM data_asset WHERE id='asset-0201'").get() as { fields: string };
    expect(hidden.fields).toBe('[]');
    const row = f.db.prepare("SELECT data_blob FROM data_asset WHERE id='asset-0300'").get() as { data_blob: string };
    f.db.prepare("UPDATE data_asset SET data_blob=? WHERE id='asset-0300'").run(row.data_blob.replace('"rules":[', '"rules":null,"rules":['));
    f.seed('asset-0300', 'unused', sample(5)); f.db.prepare("UPDATE asset_reading_history SET value='{' WHERE field='unused'").run();
    const request = { asset_filter: 'missing_facts' as const, include_asset_summaries: true };
    const expected = await f.retained(request); const read = await f.measure(() => f.service.snapshot(request));
    expect(read.value).toEqual(expected); expect(read.value.asset_filter?.unavailable).toBe(0); expect(read.sql.filter(streamSql)).toHaveLength(1);
  });

  it('does not decode a later corrupt history before an earlier point-projection error', async () => {
    const f = fixture(); f.seedAssets(401); f.db.prepare("UPDATE asset_reading_history SET value='{' WHERE asset_id='asset-0000'").run();
    const error = new Error('Fixture original point projection failure');
    vi.spyOn(f.work, 'readAssetsEffective').mockImplementation(() => { throw error; }); vi.spyOn(f.work, 'readAssetEffective').mockImplementation(() => { throw error; });
    const request = { asset_filter: 'missing_facts' as const, limit: 1 };
    await expect(f.retained(request)).rejects.toBe(error); const statements = f.capture(); await expect(f.service.snapshot(request)).rejects.toBe(error);
    expect(statements).toHaveLength(1); expect(statements[0]!.busy).toBe(false);
  });

  it('preserves a pending projection error when closing the history cursor also fails', async () => {
    const f = fixture(); f.seedAssets(401); const error = new Error('Fixture projection failure'); const prepare = f.db.prepare.bind(f.db); const statements: Database.Statement[] = [];
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (streamSql(sql)) {
        statements.push(statement); const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
          const cursor = iterate(...params);
          return { next() { return cursor.next(); }, return() { cursor.return?.(); throw new Error('Fixture cleanup failure'); }, [Symbol.iterator]() { return this; } };
        });
      }
      return statement;
    });
    vi.spyOn(f.work, 'readAssetsEffective').mockImplementation(() => { throw error; }); vi.spyOn(f.work, 'readAssetEffective').mockImplementation(() => { throw error; });
    await expect(f.service.snapshot({ asset_filter: 'missing_facts', limit: 1 })).rejects.toBe(error);
    expect(statements).toHaveLength(1); expect(statements[0]!.busy).toBe(false);
  });

  it('closes before delivery waits and sees corrected, added and deleted histories on the next request', async () => {
    const f = fixture(); f.seedAssets(401); const request = { asset_filter: 'overdue' as const, include_asset_summaries: true, limit: 3 };
    const expected = await f.retained(request); const statements = f.capture(); const pause = f.pause(); const pending = f.service.snapshot(request);
    try {
      await pause.entered.promise; expect(statements).toHaveLength(1); expect(statements[0]!.busy).toBe(false);
      f.db.prepare("DELETE FROM asset_reading_history WHERE asset_id='asset-0400'").run(); f.seed('asset-0399', 'meter', sample(49, at - 3 * DAY));
      f.seed('asset-0398', 'fuel', sample(15, at - 4 * DAY, 'L')); pause.release.resolve();
      const first = await pending; expect(first.assets).toEqual(expected.assets); expect(first.asset_summaries).toEqual(expected.asset_summaries);
      const later = await f.retained(request); expect(await f.service.snapshot(request)).toEqual(later);
      expect(first.asset_summaries).toEqual(expected.asset_summaries);
    } finally { pause.release.resolve(); await pending; }
  });
});
