import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetCreateInput, AssetReading, AssetRule } from '@recued/contracts';
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
  return { db, work, rows, service, put, seed, measure };
};
const historyReads = (sql: string[]) => sql.filter(statement => /\b(?:FROM|JOIN) asset_reading_history\b/u.test(statement));
const batchSql = (sql: string) => /^\s*WITH reading_requested\b/u.test(sql);

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

  it('uses one history statement per scan page for a large library with empty histories', async () => {
    const f = fixture(); const ids: string[] = [];
    f.db.transaction(() => { for (let index = 0; index < 401; index++) ids.unshift(f.put(`asset-${String(index).padStart(4, '0')}`,
      { readings: { meter: null }, rules: [rule] }, at + index).id); })();
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', include_asset_summaries: true, offset: 211, limit: 5 }));
    expect(read.value.total_assets).toBe(401); expect(read.value.assets.map(asset => asset.id)).toEqual(ids.slice(211, 216));
    expect(read.value.asset_summaries).toEqual(ids.slice(211, 216).map(asset_id => ({ asset_id, open_tasks: 0, active_rules: 1, next_due: null,
      missing: [{ path: 'readings.meter', reason: 'unknown' }] })));
    expect(historyReads(read.sql)).toHaveLength(3); expect(historyReads(read.sql).every(batchSql)).toBe(true);
  });

  it('reads only active enabled objective fields after sphere filtering, with individual sphere-only summaries on the page', async () => {
    const f = fixture(); const personal: string[] = []; const eligible: string[] = [];
    f.db.transaction(() => { for (let index = 0; index < 401; index++) {
      const id = `asset-${String(index).padStart(4, '0')}`; const sphere = index % 3 === 1 ? 'personal' as const : 'professional' as const;
      f.put(id, { sphere, status: index === 394 ? 'retired' : 'active', readings: { meter: null },
        rules: index === 391 ? [rule, { ...rule, id: 'second' }] : [{ ...rule, enabled: index !== 397 }] }, at + index);
      if (sphere === 'personal') { personal.unshift(id); if (![394, 397].includes(index)) eligible.unshift(id); }
    } })();
    const read = await f.measure(() => f.service.snapshot({ asset_sphere: 'personal', asset_filter: 'missing_facts', include_asset_summaries: true }));
    expect(read.value.total_assets).toBe(eligible.length); expect(read.value.assets.map(asset => asset.id)).toEqual(eligible.slice(0, 50));
    const queries = historyReads(read.sql); expect(queries).toHaveLength(2); expect(queries.every(batchSql)).toBe(true);
    expect(queries.flatMap(sql => [...sql.matchAll(/'asset-\d{4}'/gu)].map(match => match[0].slice(1, -1))).sort()).toEqual([...eligible].sort());
    const page = await f.measure(() => f.service.snapshot({ asset_sphere: 'personal', include_asset_summaries: true, limit: 1 }));
    expect(page.value.assets.map(asset => asset.id)).toEqual(personal.slice(0, 1));
    expect(historyReads(page.sql)).toHaveLength(1); expect(historyReads(page.sql).some(batchSql)).toBe(false);
    const empty = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', search: 'no-fixture-match' }));
    expect(empty.value.total_assets).toBe(0); expect(historyReads(empty.sql)).toEqual([]);
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
    const expected = () => f.work.listAssets().map(asset => summarizeYoursAsset(asset, { work: f.work, occurrences: f.rows.byAsset(asset.id), now: at, timeZone: 'UTC' }));
    for (const analyze of [false, true]) {
      if (analyze) f.db.exec('ANALYZE');
      for (const filter of ['overdue', 'missing_facts'] as const) {
        const summaries = expected().filter(summary => filter === 'overdue' ? summary.next_due?.state === 'overdue' : summary.missing.length > 0);
        const read = await f.measure(() => f.service.snapshot({ asset_filter: filter, include_asset_summaries: true }));
        expect(read.value.assets.map(asset => asset.id)).toEqual(summaries.map(summary => summary.asset_id));
        expect(read.value.asset_summaries).toEqual(summaries); expect(read.value.asset_filter?.unavailable).toBe(0);
        expect(historyReads(read.sql)).toHaveLength(1); expect(historyReads(read.sql).every(batchSql)).toBe(true);
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
    expect(historyReads(read.sql).filter(sql => !batchSql(sql))).toHaveLength(2);
  });

  for (const failure of ['execution', 'corrupt'] as const) it(`discards earlier chunks after a later ${failure} failure and falls back across fields`, async () => {
    const f = fixture(); const ids: string[] = [];
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
    expect(historyReads(read.sql).filter(sql => !batchSql(sql))).toHaveLength(202);
  });

  it('reads history edits after the refresh await and keeps no cache between snapshots', async () => {
    const f = fixture(); const short = { ...rule, when: objective({ target: 60 }) };
    f.put('a', { readings: { meter: sample(50, at - 2 * DAY) }, rules: [short] }); f.seed('a', 'meter', sample(40, at - 3 * DAY));
    const first = f.service.snapshot({ asset_filter: 'overdue', include_asset_summaries: true });
    f.seed('a', 'meter', sample(49, at - 3 * DAY)); expect((await first).assets).toEqual([]);
    const second = f.service.snapshot({ asset_filter: 'overdue', include_asset_summaries: true });
    f.seed('a', 'meter', sample(40, at - 3 * DAY));
    const read = await second; expect(read.assets.map(asset => asset.id)).toEqual(['a']);
    expect(read.asset_summaries?.[0]?.next_due).toMatchObject({ on: '2026-10-16', state: 'overdue', estimated: true });
  });
});
