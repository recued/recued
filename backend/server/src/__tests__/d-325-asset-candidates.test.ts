import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetCreateInput, AssetRule, YoursReadRequest } from '@recued/contracts';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel, type NotificationSettings, type PendingAsk } from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';

const at = Date.parse('2026-10-17T12:00Z');
const base = { source_id: 'recued.asset', source: { kind: 'owner' as const, ref: 'fixture-owner' } };
const rule: AssetRule = { id: 'review', title: 'Review', enabled: true, muted: true, pinned: false, consequence: 'routine', expiry_policy: 'escalate_overdue',
  when: { kind: 'expiry', field: 'review_on' }, reaction: { notify: false, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } };
const candidateSql = (sql: string) => /^SELECT \* FROM data_asset\b/u.test(sql) && /ORDER BY updated_at DESC,id ASC$/u.test(sql);
const listSql = (sql: string) => /^SELECT \* FROM data_asset\b/u.test(sql) && /ORDER BY updated_at DESC,id ASC LIMIT/u.test(sql);
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const fixture = () => {
  let measured: string[] | undefined;
  const db = new Database(':memory:', { verbose(sql) { measured?.push(String(sql)); } }); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => at, timeZone: () => 'UTC' });
  const service = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db), now: () => at, timeZone: () => 'UTC' });
  disposals.push(async () => { await service.stop(); db.close(); });
  const put = (id: string, patch: Partial<AssetCreateInput> = {}, time = at) => work.writeAsset({ ...base, id, name: `Fixture ${id}`, rules: [rule], dates: { review_on: null }, ...patch }, time);
  const seed = (count: number) => db.transaction(() => { for (let n = 0; n < count; n++) put(`asset-${String(n).padStart(4, '0')}`, {}, at + n); })();
  const all = (search?: string) => {
    const assets: Asset[] = [];
    for (let offset = 0; ; offset += 200) {
      const batch = work.listByKind('asset', { search, limit: 200, offset });
      for (const row of batch) { const { _kind, ...asset } = row; if (_kind === 'asset') assets.push(asset as Asset); }
      if (batch.length < 200) return assets;
    }
  };
  const retained = async (request: YoursReadRequest) => {
    const select = work.assetCandidates; work.assetCandidates = () => undefined;
    try { return await service.snapshot(request); } finally { work.assetCandidates = select; }
  };
  const measure = async <T>(read: () => T | Promise<T>) => {
    const sql: string[] = []; measured = sql;
    try { return { value: await read(), sql }; } finally { measured = undefined; }
  };
  const capture = () => {
    const prepare = db.prepare.bind(db); const statements: Database.Statement[] = [];
    vi.spyOn(db, 'prepare').mockImplementation(sql => { const statement = prepare(sql); if (candidateSql(sql)) statements.push(statement); return statement; });
    return statements;
  };
  const pause = () => {
    const entered = gate(); const release = gate();
    const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
      channels: [createUiChannel({ busSink: () => {} })] });
    service.bind({ ...block, async getReminderDestinations() { entered.resolve(); await release.promise; return { destinations: [], issues: [] }; } });
    return { entered, release };
  };
  return { db, work, service, put, seed, all, retained, measure, capture, pause };
};
const collect = (scan: ReturnType<WorkEntityStore['assetCandidates']>) => {
  if (!scan) return undefined;
  const batches: Array<{ assets: Asset[] }> = [];
  try { for (;;) { const next = scan.next(); if (next.done) return { batches, complete: next.value }; batches.push(next.value); } }
  finally { scan.return(false); }
};

describe('streaming attention candidates without a sphere filter', () => {
  it('matches ordinary raw visibility, metadata, ordering and literal Unicode name/class searches before and after ANALYZE', async () => {
    const f = fixture();
    f.put('parent', { name: 'Ancestor', dates: { review_on: '2026-11-01' }, sphere: 'personal', anchors: [{ kind: 'place', name: 'Home' }] });
    f.db.transaction(() => { for (let n = 0; n < 441; n++) {
      const id = n === 40 ? "asset-'漢?" : `asset-${String(n).padStart(4, '0')}`;
      f.put(id, { belongs_to: 'parent', ...(n % 31 === 0 ? { name: 'ÉCOLE 100%_[x]? 漢', class_id: 'class_special' } : {}),
        status: n % 17 === 0 ? 'retired' : n % 13 === 0 ? 'lent' : 'active' }, at + Math.floor(n / 3));
      if (n % 29 === 0) f.db.prepare("UPDATE data_asset SET sync_state='stale_unreachable' WHERE id=?").run(id);
      if (n % 53 === 0) f.db.prepare("UPDATE data_asset SET sync_state='tombstoned' WHERE id=?").run(id);
      if (n % 47 === 0) f.db.prepare('UPDATE data_asset SET deleted_at=1 WHERE id=?').run(id);
    } })();
    const projected = vi.spyOn(f.work, 'readAssetsEffective');
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE');
      for (const search of [undefined, ' ÉcOlE ', '%_[x]?', 'CLASS_SPECIAL', 'missing-match']) {
        const expected = f.all(search); const read = await f.measure(() => collect(f.work.assetCandidates({ search })));
        expect(read.value?.complete).toBe(true); expect(read.value?.batches.flatMap(batch => batch.assets)).toEqual(expected);
        expect(read.value?.batches.every(batch => batch.assets.length > 0 && batch.assets.length <= 200)).toBe(true);
        expect(projected).not.toHaveBeenCalled(); expect(read.sql).toHaveLength(1); expect(read.sql.every(candidateSql)).toBe(true);
      }
    }
  });

  it('opens lazily, streams more than 1000 rows, supports nested reads and closes partial cursors', () => {
    const f = fixture(); f.seed(1201); const statements = f.capture();
    const unopened = f.work.assetCandidates()!; expect(statements).toEqual([]); unopened.return(false); expect(statements).toEqual([]);
    const scan = f.work.assetCandidates()!; const first = scan.next();
    expect(first.done).toBe(false); expect(statements).toHaveLength(1); expect(statements[0]!.busy).toBe(true);
    expect(f.work.readAssetsEffective(['asset-1200']).get('asset-1200')?.id).toBe('asset-1200');
    expect(f.work.assetReadingHistories([{ asset_id: 'asset-1200', field: 'meter' }]).get('asset-1200')?.get('meter')).toEqual([]);
    const batches = first.done ? [] : [first.value];
    for (;;) { const next = scan.next(); if (next.done) { expect(next.value).toBe(true); break; } batches.push(next.value); }
    expect(batches.map(batch => batch.assets.length)).toEqual([200, 200, 200, 200, 200, 200, 1]);
    expect(batches.flatMap(batch => batch.assets.map(asset => asset.id))).toEqual(Array.from({ length: 1201 }, (_, n) => `asset-${String(1200 - n).padStart(4, '0')}`));
    expect(statements[0]!.busy).toBe(false);
    const partial = f.work.assetCandidates()!; partial.next(); expect(statements[1]!.busy).toBe(true);
    partial.return(false); expect(statements[1]!.busy).toBe(false); expect(partial.next()).toEqual({ done: true, value: undefined });
  });

  it('retains full attention results, raw summary facts, history batches and returned projections', async () => {
    const f = fixture(); f.put('parent', { name: 'Ancestor', sphere: 'personal', dates: { review_on: '2026-11-01' }, anchors: [{ kind: 'place', name: 'Home' }] });
    f.db.transaction(() => { for (let n = 0; n < 601; n++) f.put(`asset-${String(n).padStart(4, '0')}`, {
      belongs_to: 'parent', dates: { review_on: n % 3 ? '2026-10-01' : null }, ...(n % 7 === 0 ? { sphere_override: 'professional' as const } : {}) }, at + n); })();
    const histories = vi.spyOn(f.work, 'assetReadingHistories');
    for (const asset_filter of ['missing_facts', 'overdue'] as const) for (const offset of [0, 197, 10000]) for (const include_asset_summaries of [false, true]) {
      const request = { search: 'Fixture asset-', asset_filter, include_asset_summaries, offset, limit: 13 };
      const projected = vi.spyOn(f.work, 'readAssetsEffective');
      histories.mockClear(); const expected = await f.retained(request); const requests = structuredClone(histories.mock.calls);
      const projections = projected.mock.calls.map(([ids]) => [...ids]); histories.mockClear(); projected.mockClear();
      const read = await f.measure(() => f.service.snapshot(request));
      expect(read.value).toEqual(expected); expect(read.sql.filter(candidateSql)).toHaveLength(1); expect(read.sql.filter(listSql)).toEqual([]);
      expect(histories.mock.calls).toEqual(requests); expect(projected.mock.calls.map(([ids]) => [...ids])).toEqual(projections);
      expect(projected.mock.calls.flatMap(([ids]) => [...ids]).every(id => read.value.assets.some(asset => asset.id === id))).toBe(true);
      expect(read.value.asset_filter?.unavailable).toBe(0); projected.mockRestore();
    }
  });

  it('does not change ordinary, detail, sphere-only or sphere-filtered attention reads', async () => {
    const f = fixture(); f.put('target', { sphere: 'personal' });
    for (const request of [{}, { asset_id: 'target' }, { asset_sphere: 'personal' as const }, { asset_sphere: 'personal' as const, asset_filter: 'missing_facts' as const }]) {
      const read = await f.measure(() => f.service.snapshot({ ...request, include_asset_summaries: true }));
      expect(read.sql.filter(candidateSql)).toEqual([]); expect(read.value.assets.map(asset => asset.id)).toEqual(['target']);
    }
  });

  it('defers to a replacement raw list implementation without opening a cursor', async () => {
    const f = fixture(); f.put('first'); f.put('hidden'); const list = f.work.listByKind;
    vi.spyOn(f.work, 'listByKind').mockImplementation((kind, query) => list(kind, query).filter(asset => asset.id !== 'hidden'));
    const direct = await f.measure(() => f.work.assetCandidates()); expect(direct).toEqual({ value: undefined, sql: [] });
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', include_asset_summaries: true }));
    expect(read.value.total_assets).toBe(1); expect(read.value.assets.map(asset => asset.id)).toEqual(['first']); expect(read.sql.filter(candidateSql)).toEqual([]);
  });

  it('preserves legacy kind filtering and strips the raw discriminator while packing across skipped rows', () => {
    const f = fixture(); f.seed(601);
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$._kind','note') WHERE id NOT IN ('asset-0000','asset-0200','asset-0400')").run();
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$._kind','asset') WHERE id='asset-0200'").run();
    const expected = f.all(); expect(expected.map(asset => asset.id)).toEqual(['asset-0400', 'asset-0200', 'asset-0000']);
    const selected = collect(f.work.assetCandidates())!; expect(selected.complete).toBe(true); expect(selected.batches.flatMap(batch => batch.assets)).toEqual(expected);
    expect(selected.batches.flatMap(batch => batch.assets).every(asset => !('_kind' in asset))).toBe(true);
  });

  it('retains nullable legacy identities in raw counts and backfills their missing projections', async () => {
    const f = fixture(); f.put('valid', {}, at + 1); f.put('legacy', {}, at + 2); f.db.prepare('UPDATE data_asset SET id=NULL WHERE id=?').run('legacy');
    const request = { asset_filter: 'missing_facts' as const, include_asset_summaries: true, limit: 1 };
    const expected = await f.retained(request); expect(expected.total_assets).toBe(2); expect(expected.assets.map(asset => asset.id)).toEqual(['valid']);
    const read = await f.measure(() => f.service.snapshot(request)); expect(read.value).toEqual(expected); expect(read.sql.filter(candidateSql)).toHaveLength(1);
  });

  it('preserves raw-page decode errors before projecting a batch packed across legacy kind exclusions', async () => {
    const f = fixture(); f.seed(601);
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$._kind','note') WHERE id='asset-0600'").run();
    f.db.prepare("UPDATE data_asset SET status='retired',data_blob='{' WHERE id='asset-0300'").run();
    const projectionError = new Error('Fixture projection must follow raw-page decoding');
    vi.spyOn(f.work, 'readAssetsEffective').mockImplementation(() => { throw projectionError; });
    const point = vi.spyOn(f.work, 'readAssetEffective').mockImplementation(() => { throw projectionError; });
    const request = { asset_filter: 'missing_facts' as const, limit: 1 };
    await expect(f.retained(request)).rejects.toThrow(SyntaxError); expect(point).not.toHaveBeenCalled();
    const statements = f.capture(); await expect(f.service.snapshot(request)).rejects.toThrow(SyntaxError);
    expect(point).not.toHaveBeenCalled(); expect(statements).toHaveLength(1); expect(statements[0]!.busy).toBe(false);
  });

  it('backfills a missing projection across a 200-candidate boundary without reducing the raw count', async () => {
    const f = fixture(); f.seed(401); const missing = 'asset-0201'; const batch = f.work.readAssetsEffective; const point = f.work.readAssetEffective;
    vi.spyOn(f.work, 'readAssetsEffective').mockImplementation(ids => { const rows = batch(ids); rows.delete(missing); return rows; });
    vi.spyOn(f.work, 'readAssetEffective').mockImplementation(id => id === missing ? null : point(id));
    const request = { asset_filter: 'missing_facts' as const, include_asset_summaries: true, offset: 197, limit: 5 };
    const expected = await f.retained(request); expect(expected.total_assets).toBe(401);
    expect(expected.assets.map(asset => asset.id)).toEqual(['asset-0203', 'asset-0202', 'asset-0200', 'asset-0199', 'asset-0198']);
    expect(await f.service.snapshot(request)).toEqual(expected);
  });

  for (const failure of ['prepare', 'execution', 'later', 'close'] as const) it(`clears partial counts, unavailable summaries and rows after ${failure} cursor failure`, async () => {
    const f = fixture(); f.seed(601); f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.rules',NULL) WHERE id='asset-0600'").run();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = { asset_filter: 'missing_facts' as const, include_asset_summaries: true, offset: 197, limit: 13 };
    const expected = await f.retained(request); expect(expected.total_assets).toBe(600); expect(expected.asset_filter?.unavailable).toBe(1);
    const prepare = f.db.prepare.bind(f.db); const statements: Database.Statement[] = []; let failed = false; let closed = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (candidateSql(sql) && failure === 'prepare') { failed = true; throw new Error('Fixture candidate prepare failure'); }
      const statement = prepare(sql);
      if (candidateSql(sql)) {
        statements.push(statement); const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
          if (failure === 'execution') { failed = true; throw new Error('Fixture candidate execution failure'); }
          const cursor = iterate(...params); let reads = 0;
          return { next() { if (failure === 'later' && ++reads === 231) { failed = true; throw new Error('Fixture later candidate failure'); } return cursor.next(); },
            return() { closed++; const result = cursor.return?.() ?? { done: true, value: undefined };
              if (failure === 'close') { failed = true; throw new Error('Fixture candidate close failure'); } return result; }, [Symbol.iterator]() { return this; } };
        });
      }
      return statement;
    });
    expect(await f.service.snapshot(request)).toEqual(expected); expect(failed).toBe(true);
    expect(closed).toBe(failure === 'later' || failure === 'close' ? 1 : 0); expect(statements.every(statement => !statement.busy)).toBe(true);
  });

  for (const cleanupFails of [false, true]) it(`preserves point-projection errors and closes the cursor when cleanup failure is ${cleanupFails}`, async () => {
    const f = fixture(); f.seed(201); const projectionError = new Error('Fixture individual projection failure');
    const prepare = f.db.prepare.bind(f.db); const statements: Database.Statement[] = []; let closed = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (candidateSql(sql)) {
        statements.push(statement); const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
          const cursor = iterate(...params);
          return { next() { return cursor.next(); }, return() { const result = cursor.return?.() ?? { done: true, value: undefined }; closed++;
            if (cleanupFails) throw new Error('Fixture cleanup failure'); return result; }, [Symbol.iterator]() { return this; } };
        });
      }
      return statement;
    });
    vi.spyOn(f.work, 'readAssetsEffective').mockImplementation(() => { throw new Error('Fixture batch projection failure'); });
    vi.spyOn(f.work, 'readAssetEffective').mockImplementation(() => { throw projectionError; });
    const read = await f.measure(async () => { await expect(f.service.snapshot({ asset_filter: 'missing_facts', limit: 1 })).rejects.toBe(projectionError); });
    expect(closed).toBe(1); expect(statements).toHaveLength(1); expect(statements[0]!.busy).toBe(false); expect(read.sql.filter(listSql)).toEqual([]);
  });

  it('falls back if iterator return fails after completed selection', async () => {
    const f = fixture(); f.put('target'); const request = { asset_filter: 'missing_facts' as const, include_asset_summaries: true };
    const expected = await f.retained(request); const select = f.work.assetCandidates; let closed = 0;
    vi.spyOn(f.work, 'assetCandidates').mockImplementation(query => {
      const cursor = select.call(f.work, query)!;
      vi.spyOn(cursor, 'return').mockImplementation(() => { closed++; throw new Error('Fixture completed iterator return failure'); }); return cursor;
    });
    expect(await f.service.snapshot(request)).toEqual(expected); expect(closed).toBe(1);
  });

  it('closes on a raw decode error', () => {
    const f = fixture(); f.seed(201); f.db.prepare("UPDATE data_asset SET data_blob='{' WHERE id='asset-0000'").run(); const statements = f.capture();
    expect(() => collect(f.work.assetCandidates())).toThrow(SyntaxError); expect(statements).toHaveLength(1); expect(statements[0]!.busy).toBe(false);
  });

  it('closes before delivery awaits and reads changed facts on the next snapshot', async () => {
    const f = fixture(); f.seed(201); const request = { asset_filter: 'missing_facts' as const, include_asset_summaries: true, limit: 1 };
    const expected = await f.retained(request); const statements = f.capture(); const pause = f.pause(); const reading = f.service.snapshot(request);
    try {
      await pause.entered.promise; expect(statements).toHaveLength(1); expect(statements.every(statement => !statement.busy)).toBe(true);
      f.put('asset-0200', { dates: { review_on: '2026-11-01' } }, at + 300); pause.release.resolve();
      const first = await reading; expect(first.assets).toEqual(expected.assets); expect(first.asset_summaries).toEqual(expected.asset_summaries);
      const next = await f.service.snapshot(request); expect(next.total_assets).toBe(200); expect(next.assets[0]?.id).toBe('asset-0199');
      expect(first.assets[0]?.dates.review_on).toBeNull();
    } finally { pause.release.resolve(); await reading; }
  });

  it('keeps earlier batches immutable while a later cursor reads fresh raw facts', () => {
    const f = fixture(); f.put('target'); const first = collect(f.work.assetCandidates())!;
    f.put('target', { dates: { review_on: '2026-11-01' } }, at + 1); const second = collect(f.work.assetCandidates())!;
    expect(first.batches[0]!.assets[0]!.dates.review_on).toBeNull(); expect(second.batches[0]!.assets[0]!.dates.review_on).toBe('2026-11-01');
  });
});
