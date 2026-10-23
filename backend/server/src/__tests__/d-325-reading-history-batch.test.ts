import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetCreateInput, AssetReading, AssetRule, YoursReadRequest } from '@recued/contracts';
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
  const put = (id: string, patch: Partial<AssetCreateInput> = {}, time = at) => work.writeAsset({ ...base, id, name: `Fixture ${id}`, ...patch }, time);
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
  return { db, work, rows, service, put, seed, measure, pause };
};
const historyReads = (sql: string[]) => sql.filter(statement => /\b(?:FROM|JOIN) asset_reading_history\b/u.test(statement));
const batchSql = (sql: string) => /^\s*WITH reading_requested\b/u.test(sql);
const streamSql = (sql: string) => /\breading_stream_candidates AS\b/u.test(sql);
const pageModes: Array<{ name: string; request: YoursReadRequest }> = [
  { name: 'ordinary', request: { include_asset_summaries: true } },
  { name: 'sphere', request: { asset_sphere: 'personal', include_asset_summaries: true } },
  { name: 'detail', request: { asset_id: 'a', include_asset_summaries: true } },
];

describe('bounded reading histories for filtered asset summaries', () => {
  it('matches individual histories across pairs, limits, query statistics, duplicate, absent and quoted ids', async () => {
    const f = fixture(); const ids = Array.from({ length: 201 }, (_, index) => `asset-${index}`); ids.push("asset-'quoted?", 'asset-漢');
    f.db.transaction(() => {
      for (const [index, id] of ids.entries()) for (const field of ['meter', 'other']) {
        for (let n = (index === 0 ? 145 : 7) - 1; n >= 0; n--) f.seed(id, field, sample(n, at - n * 1000, field === 'other' ? 'kWh' : 'km'));
      }
    })();
    const requests = [...ids.flatMap(asset_id => ['meter', 'other'].map(field => ({ asset_id, field }))),
      { asset_id: 'absent', field: 'meter' }, { asset_id: ids[0]!, field: 'absent' }, { asset_id: ids[0]!, field: 'meter' }];
    for (const analyze of [false, true]) {
      if (analyze) f.db.exec('ANALYZE');
      for (const limit of [undefined, 0, 1, 7, 10001]) {
        const expected = new Map<string, Map<string, AssetReading[]>>();
        for (const { asset_id, field } of requests) {
          let fields = expected.get(asset_id); if (!fields) { fields = new Map(); expected.set(asset_id, fields); }
          fields.set(field, f.work.assetReadingHistory(asset_id, field, limit));
        }
        const read = await f.measure(() => f.work.assetReadingHistories(requests, limit));
        expect(read.value).toEqual(expected); expect([...read.value.keys()]).toEqual([...expected.keys()]);
        for (const id of expected.keys()) expect([...read.value.get(id)!.keys()]).toEqual([...expected.get(id)!.keys()]);
        expect(historyReads(read.sql)).toHaveLength(3); expect(read.sql.every(batchSql)).toBe(true);
        const plans = f.db.prepare(`EXPLAIN QUERY PLAN ${read.sql[0]}`).all() as Array<{ detail: string }>;
        expect(plans.some(row => /SEARCH history USING INTEGER PRIMARY KEY/u.test(row.detail))).toBe(true);
        expect(plans.some(row => /COVERING INDEX.+asset_id=\? AND field=\?/u.test(row.detail))).toBe(true);
        expect(plans.some(row => /^SCAN (?:history|asset_reading_history)\b/u.test(row.detail))).toBe(false);
      }
    }
    f.db.prepare('UPDATE asset_reading_history SET value=? WHERE asset_id=? AND field=? AND as_of=?').run('{', ids[0]!, 'meter', at - 144000);
    expect(f.work.assetReadingHistories([{ asset_id: ids[0]!, field: 'meter' }]).get(ids[0]!)?.get('meter')).toHaveLength(100);
    const empty = await f.measure(() => f.work.assetReadingHistories([])); expect(empty.value.size).toBe(0); expect(empty.sql).toEqual([]);
  });

  it('returns independent samples and reads corrections, additions and deletions on the next call', () => {
    const f = fixture(); f.put('a'); f.put('b'); f.seed('a', 'meter', sample(1)); f.seed('a', 'other', sample(2)); f.seed('b', 'meter', sample(3));
    const requests = [{ asset_id: 'a', field: 'meter' }, { asset_id: 'a', field: 'other' }, { asset_id: 'b', field: 'meter' }, { asset_id: 'absent', field: 'meter' }];
    const first = f.work.assetReadingHistories(requests);
    first.get('a')!.get('meter')![0]!.evidence[0]!.id = 'changed';
    expect(first.get('a')?.get('other')?.[0]?.evidence[0]?.id).toBe('file:fixture:sample');
    expect(f.work.assetReadingHistory('a', 'meter')[0]?.evidence[0]?.id).toBe('file:fixture:sample');
    f.seed('a', 'meter', sample(5)); f.seed('a', 'meter', sample(6, at + 1)); f.work.deleteAsset('b');
    const next = f.work.assetReadingHistories(requests);
    for (const { asset_id, field } of requests) expect(next.get(asset_id)?.get(field)).toEqual(f.work.assetReadingHistory(asset_id, field));
    expect(next.get('a')?.get('meter')?.map(row => row.value)).toEqual([6, 5]); expect(next.get('b')?.get('meter')).toEqual([]);
    expect(first.get('a')?.get('meter')?.[0]?.value).toBe(1);
  });

  it('uses one history cursor across bounded summary batches for a large library with empty histories', async () => {
    const f = fixture(); const ids: string[] = [];
    f.db.transaction(() => { for (let index = 0; index < 401; index++) ids.unshift(f.put(`asset-${String(index).padStart(4, '0')}`,
      { readings: { meter: null }, rules: [rule] }, at + index).id); })();
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', include_asset_summaries: true, offset: 211, limit: 5 }));
    expect(read.value.total_assets).toBe(401); expect(read.value.assets.map(asset => asset.id)).toEqual(ids.slice(211, 216));
    expect(read.value.asset_summaries).toEqual(ids.slice(211, 216).map(asset_id => ({ asset_id, open_tasks: 0, active_rules: 1, next_due: null,
      missing: [{ path: 'readings.meter', reason: 'unknown' }] })));
    expect(historyReads(read.sql)).toHaveLength(1); expect(historyReads(read.sql).every(streamSql)).toBe(true);
  });

  it('reads only active enabled objective fields after sphere filtering, with batched sphere-only summaries on the page', async () => {
    const f = fixture(); const personal: string[] = []; const eligible: string[] = [];
    f.db.transaction(() => { for (let index = 0; index < 401; index++) {
      const id = `asset-${String(index).padStart(4, '0')}`; const sphere = index % 3 === 1 ? 'personal' as const : 'professional' as const;
      f.put(id, { sphere, status: index === 394 ? 'retired' : 'active', readings: { meter: null },
        rules: index === 391 ? [rule, { ...rule, id: 'second' }] : [{ ...rule, enabled: index !== 397 }] }, at + index);
      if (sphere === 'personal') { personal.unshift(id); if (![394, 397].includes(index)) eligible.unshift(id); }
    } })();
    const histories = vi.spyOn(f.work, 'assetReadingHistories');
    const read = await f.measure(() => f.service.snapshot({ asset_sphere: 'personal', asset_filter: 'missing_facts', include_asset_summaries: true }));
    expect(read.value.total_assets).toBe(eligible.length); expect(read.value.assets.map(asset => asset.id)).toEqual(eligible.slice(0, 50));
    const queries = historyReads(read.sql); expect(queries).toHaveLength(1); expect(queries.every(streamSql)).toBe(true);
    expect([...new Set(histories.mock.calls.flatMap(([requests]) => requests.map(request => request.asset_id)))].sort()).toEqual([...eligible].sort());
    const page = await f.measure(() => f.service.snapshot({ asset_sphere: 'personal', include_asset_summaries: true, limit: 1 }));
    expect(page.value.assets.map(asset => asset.id)).toEqual(personal.slice(0, 1));
    expect(historyReads(page.sql)).toHaveLength(1); expect(historyReads(page.sql).every(batchSql)).toBe(true);
    const empty = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', search: 'no-fixture-match' }));
    expect(empty.value.total_assets).toBe(0); expect(historyReads(empty.sql)).toEqual([]);
  });
  it('batches only returned projected assets, with duplicate fields, inherited locations and bounded chunks', async () => {
    const f = fixture(); f.put('parent', { sphere: 'personal', readings: { parent_only: null }, anchors: [{ kind: 'place', name: 'Home' }],
      rules: [{ ...rule, id: 'parent_only', when: objective({ field: 'parent_only' }) }] });
    const fuel: AssetRule = { ...rule, id: 'fuel', when: objective({ field: 'fuel', unit: 'L', target: 5, direction: 'falling' }) };
    const ids: string[] = []; const quoted = "asset-'漢?";
    f.db.transaction(() => { for (let index = 0; index < 241; index++) {
      const id = index === 120 ? quoted : `asset-${String(index).padStart(4, '0')}`; ids.unshift(id);
      f.put(id, { belongs_to: 'parent', status: index % 37 === 0 ? 'retired' : index % 11 === 0 ? 'lent' : 'active',
        readings: { meter: index % 5 === 0 ? null : sample(50, at - 2 * DAY), fuel: sample(8, at - 2 * DAY, 'L'), ignored: null },
        rules: [rule, { ...rule, id: 'duplicate_meter' }, fuel, { ...rule, id: 'disabled', enabled: false, when: objective({ field: 'ignored' }) }] }, at + index);
      f.seed(id, 'meter', sample(40, at - 3 * DAY)); f.seed(id, 'fuel', sample(12, at - 3 * DAY, 'L'));
      if (index % 31 === 0) f.db.prepare("UPDATE data_asset SET sync_state='stale_unreachable' WHERE id=?").run(id);
    } })();
    const cases: Array<{ request: YoursReadRequest; page: string[] }> = [
      { request: { search: 'Fixture asset-', include_asset_summaries: true, offset: 31, limit: 120 }, page: ids.slice(31, 151) },
      { request: { search: 'Fixture asset-', asset_sphere: 'personal', include_asset_summaries: true, offset: 31, limit: 120 }, page: ids.slice(31, 151) },
      { request: { asset_id: quoted, include_asset_summaries: true }, page: [quoted] },
      { request: { search: 'no-fixture-match', include_asset_summaries: true }, page: [] },
    ];
    const batches = vi.spyOn(f.work, 'assetReadingHistories'); const individual = vi.spyOn(f.work, 'assetReadingHistory');
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE');
      for (const { request, page } of cases) {
        const expected = page.map(id => f.work.readAssetEffective(id)!);
        const summaries = expected.map(asset => summarizeYoursAsset(asset, { work: f.work, occurrences: [], now: at, timeZone: 'UTC' }));
        batches.mockClear(); individual.mockClear();
        const read = await f.measure(() => f.service.snapshot(request));
        expect(read.value.assets).toEqual(expected); expect(read.value.asset_summaries).toEqual(summaries); expect(individual).not.toHaveBeenCalled();
        const requests = batches.mock.calls.flatMap(([pairs]) => pairs);
        const eligible = expected.filter(asset => ['active', 'lent'].includes(asset.status));
        expect(requests).toEqual(eligible.flatMap(asset => ['meter', 'meter', 'fuel'].map(field => ({ asset_id: asset.id, field }))));
        expect(historyReads(read.sql)).toHaveLength(Math.ceil(eligible.length * 2 / 200)); expect(historyReads(read.sql).every(batchSql)).toBe(true);
        expect(read.value.assets.every(asset => asset.sphere === 'personal' && asset.anchors.some(anchor => anchor.kind === 'place' && anchor.name === 'Home'))).toBe(true);
      }
    }
    batches.mockClear(); individual.mockClear();
    const plain = await f.measure(() => f.service.snapshot({ search: 'Fixture asset-', limit: 2 }));
    expect(plain.value.asset_summaries).toBeUndefined(); expect(historyReads(plain.sql)).toEqual([]); expect(batches).not.toHaveBeenCalled(); expect(individual).not.toHaveBeenCalled();
  });

  it('keeps complete forecast and recovery summaries, including the sample cap before clock filtering', async () => {
    const f = fixture(); const short = { ...rule, when: objective({ target: 60 }) };
    f.put('crossed', { readings: { meter: sample(110, at - DAY) }, rules: [rule] });
    f.put('forecast', { readings: { meter: sample(50, at - 2 * DAY) }, rules: [short] }); f.seed('forecast', 'meter', sample(40, at - 3 * DAY));
    f.put('recovered', { readings: { meter: sample(50) }, rules: [{ ...rule, when: objective({ mode: 'condition' }) }] });
    f.seed('recovered', 'meter', sample(60, at - DAY));
    f.put('bounded', { readings: { meter: sample(50, at - 2 * DAY) }, rules: [short] }); f.seed('bounded', 'meter', sample(40, at - 3 * DAY));
    for (let n = 1; n <= 100; n++) f.seed('bounded', 'meter', sample(50 + n, at - 2 * DAY + n));
    f.put('mixed-units', { readings: { meter: sample(50, at - 2 * DAY) }, rules: [short] });
    f.seed('mixed-units', 'meter', sample(40, at - 3 * DAY)); f.seed('mixed-units', 'meter', sample(900, at - 2.5 * DAY, 'mi'));
    f.put('unit-bounded', { readings: { meter: sample(50, at - 2 * DAY) }, rules: [short] }); f.seed('unit-bounded', 'meter', sample(40, at - 3 * DAY));
    for (let n = 1; n <= 100; n++) f.seed('unit-bounded', 'meter', sample(50 + n, at - 2 * DAY - n * 1000, 'mi'));
    f.put('missing', { readings: { meter: null }, rules: [rule] });
    f.service.spheres.setSource('work:recued.asset', 'personal');
    const expected = () => f.work.listAssets().map(asset => summarizeYoursAsset(asset, { work: f.work, occurrences: f.rows.byAsset(asset.id), now: at, timeZone: 'UTC' }));
    for (const analyze of [false, true]) {
      if (analyze) f.db.exec('ANALYZE');
      for (const filter of ['overdue', 'missing_facts'] as const) {
        const summaries = expected().filter(summary => filter === 'overdue' ? summary.next_due?.state === 'overdue' : summary.missing.length > 0);
        const read = await f.measure(() => f.service.snapshot({ asset_filter: filter, include_asset_summaries: true }));
        expect(read.value.assets.map(asset => asset.id)).toEqual(summaries.map(summary => summary.asset_id));
        expect(read.value.asset_summaries).toEqual(summaries); expect(read.value.asset_filter?.unavailable).toBe(0);
        expect(historyReads(read.sql)).toHaveLength(1); expect(historyReads(read.sql).every(streamSql)).toBe(true);
      }
      const requests: YoursReadRequest[] = [{ include_asset_summaries: true }, { asset_sphere: 'personal', include_asset_summaries: true },
        { asset_id: 'forecast', include_asset_summaries: true }];
      for (const request of requests) {
        const summaries = expected().filter(summary => !request.asset_id || summary.asset_id === request.asset_id);
        const read = await f.measure(() => f.service.snapshot(request));
        expect(read.value.asset_summaries).toEqual(summaries); expect(historyReads(read.sql)).toHaveLength(1); expect(historyReads(read.sql).every(batchSql)).toBe(true);
      }
    }
    expect(expected().find(summary => summary.asset_id === 'bounded')?.next_due).toBeNull();
    expect(expected().find(summary => summary.asset_id === 'forecast')?.next_due).toMatchObject({ on: '2026-10-16', estimated: true });
    expect(expected().find(summary => summary.asset_id === 'mixed-units')?.next_due).toMatchObject({ on: '2026-10-16', estimated: true });
    expect(expected().find(summary => summary.asset_id === 'unit-bounded')?.next_due).toBeNull();
  });

  for (const failure of ['prepare', 'execution', 'corrupt'] as const) it(`falls back after a ${failure} history failure and isolates unavailable summaries`, async () => {
    const f = fixture(); f.put('good', { readings: { meter: null }, rules: [rule] });
    f.put('unreadable', { readings: { meter: sample(50) }, rules: [rule] });
    f.service.spheres.setSource('work:recued.asset', 'personal');
    f.seed('unreadable', 'meter', sample(40, at - DAY));
    f.db.prepare('UPDATE asset_reading_history SET value=? WHERE asset_id=? AND as_of=?').run('{', 'unreadable', at - DAY);
    if (failure !== 'corrupt') {
      const prepare = f.db.prepare.bind(f.db);
      vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
        if (!batchSql(sql)) return prepare(sql);
        if (failure === 'prepare') throw new Error('Fixture history prepare failure');
        const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementation(() => { throw new Error('Fixture history execution failure'); });
        return statement;
      });
    }
    const individual = vi.spyOn(f.work, 'assetReadingHistory'); const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', include_asset_summaries: true }));
    expect(read.value.assets.map(asset => asset.id)).toEqual(['good']); expect(read.value.asset_filter).toEqual({ kind: 'missing_facts', unavailable: 1 });
    expect(individual).toHaveBeenCalledTimes(2); expect(warning).toHaveBeenCalledTimes(1);
    expect(historyReads(read.sql).filter(sql => !batchSql(sql) && !streamSql(sql))).toHaveLength(2);
    expect(historyReads(read.sql).filter(streamSql)).toHaveLength(1);
    const requests: YoursReadRequest[] = [{ include_asset_summaries: true }, { asset_sphere: 'personal', include_asset_summaries: true },
      { asset_id: 'unreadable', include_asset_summaries: true }];
    for (const request of requests) {
      individual.mockClear(); warning.mockClear();
      const page = await f.measure(() => f.service.snapshot(request));
      expect(page.value.assets.map(asset => asset.id)).toEqual(request.asset_id ? ['unreadable'] : ['good', 'unreadable']);
      expect(page.value.total_assets).toBe(2); expect(page.value.asset_filter).toBeUndefined();
      expect(page.value.asset_summaries?.map(summary => summary.asset_id)).toEqual(request.asset_id ? [] : ['good']);
      expect(individual).toHaveBeenCalledTimes(request.asset_id ? 1 : 2); expect(warning).toHaveBeenCalledTimes(1);
    }
  });

  for (const failure of ['execution', 'corrupt'] as const) it(`discards earlier chunks after a later ${failure} failure and falls back across fields`, async () => {
    const f = fixture(); const ids: string[] = [];
    f.service.spheres.setSource('work:recued.asset', 'personal');
    const fuel: AssetRule = { ...rule, id: 'fuel', when: objective({ field: 'fuel', unit: 'L' }) };
    f.db.transaction(() => { for (let index = 0; index < 101; index++) {
      const id = `asset-${String(index).padStart(4, '0')}`; ids.unshift(id);
      f.put(id, { readings: { meter: null, fuel: null }, rules: [rule, fuel] }, at + index);
      f.seed(id, 'meter', sample(1)); f.seed(id, 'fuel', sample(2, at, 'L'));
    } })();
    // This pair is in the second chunk, after 200 pairs have decoded successfully.
    f.db.prepare('UPDATE asset_reading_history SET value=? WHERE asset_id=? AND field=?').run('{', ids.at(-1)!, 'fuel');
    const prepare = f.db.prepare.bind(f.db); let chunks = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (batchSql(sql) && ++chunks === 2 && failure === 'execution') {
        vi.spyOn(statement, 'all').mockImplementation(() => { throw new Error('Fixture later history execution failure'); });
      }
      return statement;
    });
    const individual = vi.spyOn(f.work, 'assetReadingHistory'); const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', include_asset_summaries: true, offset: 97, limit: 3 }));
    expect(chunks).toBe(2); expect(individual).toHaveBeenCalledTimes(202); expect(warning).toHaveBeenCalledTimes(1);
    expect(read.value.total_assets).toBe(100); expect(read.value.assets.map(asset => asset.id)).toEqual(ids.slice(97, 100));
    expect(read.value.asset_filter).toEqual({ kind: 'missing_facts', unavailable: 1 });
    expect(read.value.asset_summaries).toEqual(ids.slice(97, 100).map(asset_id => ({ asset_id, open_tasks: 0, active_rules: 2, next_due: null,
      missing: [{ path: 'readings.fuel', reason: 'unknown' }, { path: 'readings.meter', reason: 'unknown' }] })));
    expect(historyReads(read.sql).filter(sql => !batchSql(sql) && !streamSql(sql))).toHaveLength(202);
    expect(historyReads(read.sql).filter(streamSql)).toHaveLength(1);
    for (const request of [{ include_asset_summaries: true, limit: 101 },
      { asset_sphere: 'personal' as const, include_asset_summaries: true, limit: 101 }]) {
      chunks = 0; individual.mockClear(); warning.mockClear();
      const page = await f.service.snapshot(request);
      expect(chunks).toBe(2); expect(individual).toHaveBeenCalledTimes(202); expect(warning).toHaveBeenCalledTimes(1);
      expect(page.assets.map(asset => asset.id)).toEqual(ids); expect(page.total_assets).toBe(101); expect(page.asset_filter).toBeUndefined();
      expect(page.asset_summaries).toEqual(ids.slice(0, -1).map(asset_id => ({ asset_id, open_tasks: 0, active_rules: 2, next_due: null,
        missing: [{ path: 'readings.fuel', reason: 'unknown' }, { path: 'readings.meter', reason: 'unknown' }] })));
    }
  });

  for (const mode of [{ name: 'attention', request: { asset_filter: 'overdue' as const, include_asset_summaries: true } }, ...pageModes]) it(`reads history edits after refresh and keeps no cache for ${mode.name} summaries`, async () => {
    const f = fixture(); const short = { ...rule, when: objective({ target: 60 }) };
    f.service.spheres.setSource('work:recued.asset', 'personal');
    f.put('a', { readings: { meter: sample(50, at - 2 * DAY) }, rules: [short] }); f.seed('a', 'meter', sample(40, at - 3 * DAY));
    const first = f.service.snapshot(mode.request);
    f.seed('a', 'meter', sample(49, at - 3 * DAY)); const before = await first;
    if (mode.name === 'attention') expect(before.assets).toEqual([]);
    else expect(before.asset_summaries?.[0]?.next_due?.state).toBe('upcoming');
    const second = f.service.snapshot(mode.request);
    f.seed('a', 'meter', sample(40, at - 3 * DAY));
    const read = await second; expect(read.assets.map(asset => asset.id)).toEqual(['a']);
    expect(read.asset_summaries?.[0]?.next_due).toMatchObject({ on: '2026-10-16', state: 'overdue', estimated: true });
  });

  for (const mode of pageModes) it(`retains the ${mode.name} forecast through delivery and reads changed history on the next snapshot`, async () => {
    const f = fixture(); f.service.spheres.setSource('work:recued.asset', 'personal');
    f.put('a', { readings: { meter: sample(50, at - 2 * DAY) }, rules: [{ ...rule, when: objective({ target: 60 }) }] });
    f.seed('a', 'meter', sample(40, at - 3 * DAY)); const p = f.pause(); const reading = f.service.snapshot(mode.request);
    try {
      await p.entered.promise; f.seed('a', 'meter', sample(49, at - 3 * DAY));
      p.release.resolve(); const first = await reading;
      expect(first.asset_summaries?.[0]?.next_due).toMatchObject({ on: '2026-10-16', state: 'overdue', estimated: true });
      const next = await f.service.snapshot(mode.request); expect(next.asset_summaries?.[0]?.next_due?.state).toBe('upcoming');
      expect(first.asset_summaries?.[0]?.next_due?.state).toBe('overdue');
    } finally { p.release.resolve(); await reading; }
  });
});
