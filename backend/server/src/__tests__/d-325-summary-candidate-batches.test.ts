import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateAssetRuleClock, type AssetCreateInput, type AssetRule } from '@recued/contracts';
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

const at = Date.parse('2026-10-17T12:00Z');
const base = { source_id: 'recued.asset', source: { kind: 'owner' as const, ref: 'fixture-owner' } };
const rule = (field: string): AssetRule => ({ id: `usage_${field}`, title: `Review ${field}`, enabled: true, muted: true, pinned: false,
  consequence: 'routine', expiry_policy: 'escalate_overdue', when: { kind: 'objective', field, target: 100, unit: 'km', direction: 'rising', mode: 'usage', lead_days: 0 },
  reaction: { notify: false, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } });
const rules = [rule('meter'), rule('spare')];
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const fixture = () => {
  let measured: string[] | undefined;
  const db = new Database(':memory:', { verbose(sql) { measured?.push(String(sql)); } });
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work); const rows = createAssetOccurrenceStore(db);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => at, timeZone: () => 'UTC' });
  const service = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db), now: () => at, timeZone: () => 'UTC' });
  disposals.push(async () => { await service.stop(); db.close(); });
  const put = (id: string, patch: Partial<AssetCreateInput> = {}, time = at) => work.writeAsset({ ...base, id, name: `Fixture ${id}`, readings: { meter: null, spare: null }, rules, ...patch }, time);
  const seed = (count: number, professional: (index: number) => boolean = index => index % 5 < 2) => {
    const selected: string[] = [];
    db.transaction(() => { for (let index = 0; index < count; index++) {
      const id = index === 120 ? "asset-'quoted?" : index === 121 ? 'asset-漢' : `asset-${String(index).padStart(4, '0')}`;
      const chosen = professional(index); const asset = put(id, { sphere: chosen ? 'professional' : 'personal' }, at + index);
      if (chosen) selected.unshift(id);
      if (index % 17 === 0) {
        const commitment_id = `task:${id}`;
        work.writeCommitment({ id: commitment_id, source_id: 'recued.commitment', direction: 'outbound', statement: `Review ${id}`, derivation: 'user_declared',
          lifecycle_state: index % 34 === 0 ? 'pending' : 'fulfilled', promised_for_at: at - 2 * 86400000 }, at);
        rows.ensure({ id: `occ:${id}`, asset_id: id, rule_id: rules[0]!.id, cycle: evaluateAssetRuleClock(asset, rules[0]!, { now: at, timeZone: 'UTC' }).cycle,
          commitment_id, question: false, trigger_kind: 'rule', created_at: at });
      }
    } })();
    return selected;
  };
  const expected = (ids: readonly string[]) => ({ assets: ids.map(id => work.readAssetEffective(id)!), summaries: ids.map(id => summarizeYoursAsset(work.readAsset(id)!,
    { work, occurrences: rows.byAsset(id), now: at, timeZone: 'UTC' })) });
  const measure = async <T>(read: () => Promise<T>) => {
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
  return { db, work, service, put, seed, expected, measure, pause };
};
const receiptList = (sql: string) => sql === 'SELECT * FROM asset_occurrences ORDER BY created_at,id';
const receiptBatch = (sql: string) => /^SELECT \* FROM asset_occurrences WHERE subject_kind='asset' AND asset_id IN/u.test(sql);
const historyBatch = (sql: string) => /^WITH reading_requested\b/u.test(sql);
const historyStream = (sql: string) => /\breading_stream_candidates AS\b/u.test(sql);

describe('summary batches filled from sphere-selected candidates', () => {
  it('bounds full batches and the final tail while preserving full assets, clocks and task summaries', async () => {
    const f = fixture(); const ids = f.seed(1003); const page = ids.slice(197, 247); const expected = f.expected(page);
    const histories = vi.spyOn(f.work, 'assetReadingHistories');
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE'); histories.mockClear();
      const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional', include_asset_summaries: true, offset: 197, limit: 50 }));
      expect(read.value.total_assets).toBe(402); expect(read.value.assets).toEqual(expected.assets); expect(read.value.asset_summaries).toEqual(expected.summaries);
      expect(read.value.asset_filter).toEqual({ kind: 'missing_facts', unavailable: 0 });
      expect(read.sql.filter(receiptBatch)).toEqual([]); expect(read.sql.filter(receiptList)).toHaveLength(2);
      expect(histories.mock.calls.map(([requests]) => requests.length)).toEqual([400, 400, 4]);
      expect(histories.mock.calls.flatMap(([requests]) => requests)).toEqual(ids.flatMap(asset_id => ['meter', 'spare'].map(field => ({ asset_id, field }))));
      expect(read.sql.filter(historyStream)).toHaveLength(1); expect(read.sql.filter(historyBatch)).toEqual([]);
    }
  });

  it('flushes a partial batch after several raw pages with no candidates and an exact raw-page boundary', async () => {
    const f = fixture(); const ids = f.seed(1000, index => index >= 950); const page = ids.slice(45, 50); const expected = f.expected(page);
    const histories = vi.spyOn(f.work, 'assetReadingHistories');
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional', include_asset_summaries: true, offset: 45, limit: 10 }));
    expect(read.value.total_assets).toBe(50); expect(read.value.assets).toEqual(expected.assets); expect(read.value.asset_summaries).toEqual(expected.summaries);
    expect(read.sql.filter(receiptBatch)).toEqual([]); expect(read.sql.filter(historyStream)).toHaveLength(1); expect(read.sql.filter(historyBatch)).toEqual([]);
    expect(histories.mock.calls.map(([requests]) => requests)).toEqual([ids.flatMap(asset_id => ['meter', 'spare'].map(field => ({ asset_id, field })))]);
  });

  it('processes an exact full batch once after empty leading and trailing scan pages', async () => {
    const f = fixture(); const ids = f.seed(1000, index => index >= 300 && index < 500); const expected = f.expected(ids.slice(197));
    const histories = vi.spyOn(f.work, 'assetReadingHistories');
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional', include_asset_summaries: true, offset: 197, limit: 5 }));
    expect(read.value.total_assets).toBe(200); expect(read.value.assets).toEqual(expected.assets); expect(read.value.asset_summaries).toEqual(expected.summaries);
    expect(read.value.asset_filter).toEqual({ kind: 'missing_facts', unavailable: 0 });
    expect(read.sql.filter(receiptBatch)).toEqual([]); expect(read.sql.filter(historyStream)).toHaveLength(1); expect(read.sql.filter(historyBatch)).toEqual([]);
    expect(histories.mock.calls.map(([requests]) => requests)).toEqual([ids.flatMap(asset_id => ['meter', 'spare'].map(field => ({ asset_id, field })))]);
  });

  for (const failed of ['receipts', 'histories'] as const) it(`retains individual summary fallback when packed ${failed} reads fail`, async () => {
    const f = fixture(); const ids = f.seed(1003); const page = ids.slice(197, 202); const expected = f.expected(page);
    const prepare = f.db.prepare.bind(f.db); let lists = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (failed === 'receipts' && receiptList(sql) && ++lists === 2) throw new Error('Fixture shared list failure');
      if (failed === 'histories' && historyStream(sql)) throw new Error('Fixture native history stream failure');
      if (failed === 'receipts' ? receiptBatch(sql) : historyBatch(sql)) throw new Error(`Fixture ${failed} batch failure`);
      return prepare(sql);
    });
    const read = await f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional', include_asset_summaries: true, offset: 197, limit: 5 });
    expect(read.total_assets).toBe(402); expect(read.assets).toEqual(expected.assets); expect(read.asset_summaries).toEqual(expected.summaries);
    expect(read.asset_filter).toEqual({ kind: 'missing_facts', unavailable: 0 });
  });

  for (const failed of ['receipts', 'histories'] as const) it(`isolates a later packed ${failed} execution failure and still processes the tail`, async () => {
    const f = fixture(); const ids = f.seed(1003); const expected = f.expected(ids.slice(197, 402));
    const prepare = f.db.prepare.bind(f.db); const individual = vi.spyOn(f.work, 'assetReadingHistory'); let attempts = 0; let lists = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (failed === 'receipts' && receiptList(sql) && ++lists === 2) throw new Error('Fixture shared list failure');
      if (failed === 'histories' && historyStream(sql)) throw new Error('Fixture native history stream failure');
      const statement = prepare(sql);
      if ((failed === 'receipts' ? receiptBatch(sql) : historyBatch(sql)) && ++attempts === (failed === 'receipts' ? 2 : 3)) {
        vi.spyOn(statement, 'all').mockImplementationOnce(() => { throw new Error(`Fixture later ${failed} execution failure`); });
      }
      return statement;
    });
    const request = { asset_filter: 'missing_facts' as const, asset_sphere: 'professional' as const, include_asset_summaries: true, offset: 197, limit: 200 };
    const page = await f.service.snapshot(request);
    expect(page.total_assets).toBe(402); expect(page.assets).toEqual(expected.assets.slice(0, 200)); expect(page.asset_summaries).toEqual(expected.summaries.slice(0, 200));
    expect(page.asset_filter).toEqual({ kind: 'missing_facts', unavailable: 0 }); expect(attempts).toBe(failed === 'receipts' ? 3 : 4);
    expect(individual).toHaveBeenCalledTimes(failed === 'histories' ? 400 : 0);
    attempts = 0; lists = 0; individual.mockClear();
    const tail = await f.service.snapshot({ ...request, offset: 397, limit: 10 });
    expect(tail.total_assets).toBe(402); expect(tail.assets).toEqual(expected.assets.slice(200)); expect(tail.asset_summaries).toEqual(expected.summaries.slice(200));
    expect(tail.asset_filter).toEqual({ kind: 'missing_facts', unavailable: 0 }); expect(attempts).toBe(failed === 'receipts' ? 3 : 4);
    expect(individual).toHaveBeenCalledTimes(failed === 'histories' ? 400 : 0);
  });

  it('isolates an unreadable summary at a packed boundary without shifting pagination or dropping the tail', async () => {
    const f = fixture(); const ids = f.seed(1003); const bad = ids[199]!;
    f.db.prepare('INSERT INTO asset_reading_history(asset_id,field,as_of,value) VALUES(?,?,?,?)').run(bad, 'meter', at - 86400000, '{');
    const page = ids.filter(id => id !== bad).slice(197, 202); const expected = f.expected(page); const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional', include_asset_summaries: true, offset: 197, limit: 5 });
    expect(result.total_assets).toBe(401); expect(result.assets).toEqual(expected.assets); expect(result.asset_summaries).toEqual(expected.summaries);
    expect(result.asset_filter).toEqual({ kind: 'missing_facts', unavailable: 1 }); expect(warning).toHaveBeenCalledTimes(1);
  });

  it('backfills a missing selected projection across a packed boundary while retaining the raw match count', async () => {
    const f = fixture(); const ids = f.seed(1003); const missing = ids[199]!; const page = ids.filter(id => id !== missing).slice(197, 202); const expected = f.expected(page);
    const batch = f.work.readAssetsEffective; const point = f.work.readAssetEffective;
    vi.spyOn(f.work, 'readAssetsEffective').mockImplementation(keys => { const result = batch(keys); if (keys.length <= 5) result.delete(missing); return result; });
    const individual = vi.spyOn(f.work, 'readAssetEffective').mockImplementation((id, canReadParent) => id === missing ? null : point(id, canReadParent));
    const result = await f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional', include_asset_summaries: true, offset: 197, limit: 5 });
    expect(result.total_assets).toBe(402); expect(result.assets).toEqual(expected.assets); expect(result.asset_summaries).toEqual(expected.summaries);
    expect(individual.mock.calls.map(([id]) => id)).toEqual([missing]); expect(result.sphere_placements.filter(row => row.ref.collection === 'asset').map(row => row.ref.id)).toEqual(page);
  });

  it('retains selection placements through delivery and reads an owner change on the next snapshot', async () => {
    const f = fixture(); const ids = f.seed(1003); const page = ids.slice(197, 200); const expected = f.expected(page); const p = f.pause();
    const reading = f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional', include_asset_summaries: true, offset: 197, limit: 3 });
    try {
      await p.entered.promise; f.put(page[0]!, { sphere: 'personal' }); f.service.spheres.setItem({ collection: 'asset', id: page[0]! }, 'personal');
      p.release.resolve(); const first = await reading;
      expect(first.total_assets).toBe(402); expect(first.assets).toEqual(expected.assets); expect(first.asset_summaries).toEqual(expected.summaries);
      expect(first.sphere_placements.filter(row => row.ref.collection === 'asset').map(row => row.sphere)).toEqual(['professional', 'professional', 'professional']);
      const next = await f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional', limit: 3 });
      expect(next.total_assets).toBe(401); expect(next.assets.some(row => row.id === page[0])).toBe(false); expect(first.assets).toEqual(expected.assets);
    } finally { p.release.resolve(); await reading; }
  });

  it('keeps ordinary and sphere-only summary lookups on the returned page', async () => {
    const f = fixture(); f.seed(1003); const batches = vi.spyOn(f.work, 'assetReadingHistories'); const individual = vi.spyOn(f.work, 'assetReadingHistory');
    for (const request of [{ include_asset_summaries: true, limit: 2 }, { asset_sphere: 'professional' as const, include_asset_summaries: true, limit: 2 }]) {
      batches.mockClear(); individual.mockClear(); const read = await f.measure(() => f.service.snapshot(request));
      expect(read.value.assets).toHaveLength(2); expect(batches).toHaveBeenCalledTimes(1); expect(individual).not.toHaveBeenCalled();
      expect(batches.mock.calls[0]?.[0]).toEqual(read.value.assets.flatMap(asset => ['meter', 'spare'].map(field => ({ asset_id: asset.id, field }))));
      expect(read.sql.filter(receiptBatch)).toEqual([]); expect(read.sql.filter(historyBatch)).toHaveLength(1);
    }
  });

  it('still processes every candidate for counts when the requested page is beyond the end', async () => {
    const f = fixture(); f.seed(1003); const histories = vi.spyOn(f.work, 'assetReadingHistories');
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional', include_asset_summaries: true, offset: 999 }));
    expect(read.value.total_assets).toBe(402); expect(read.value.assets).toEqual([]); expect(read.value.asset_summaries).toEqual([]);
    expect(read.sql.filter(receiptBatch)).toEqual([]); expect(read.sql.filter(receiptList)).toHaveLength(2); expect(histories.mock.calls.flatMap(([requests]) => requests)).toHaveLength(804);
  });
});
