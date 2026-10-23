import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetCreateInput, AssetRule, Sphere, YoursReadRequest } from '@recued/contracts';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel, type NotificationSettings, type PendingAsk } from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createSphereStore } from '../storage/sphere-store.js';
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
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const pageSql = (sql: string) => /^WITH RECURSIVE asset_sphere_roots\b/u.test(sql);
const fixture = () => {
  let measured: string[] | undefined;
  const db = new Database(':memory:', { verbose(sql) { if (measured) { if (typeof sql !== 'string') throw new Error('Missing SQL trace'); measured.push(sql); } } }); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => at, timeZone: () => 'UTC' });
  const service = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db), now: () => at, timeZone: () => 'UTC' });
  disposals.push(async () => { await service.stop(); db.close(); });
  const put = (id: string, patch: Partial<AssetCreateInput> = {}, time = at) => work.writeAsset({ ...base, id, name: `Fixture ${id}`, ...patch }, time);
  const measure = async <T>(read: () => T | Promise<T>) => {
    const sql: string[] = []; measured = sql;
    try { return { value: await read(), sql }; } finally { measured = undefined; }
  };
  const all = (search?: string) => {
    const result: Asset[] = [];
    for (let offset = 0; ; offset += 200) {
      const batch = work.listAssets({ search, limit: 200, offset }); result.push(...batch); if (batch.length < 200) return result;
    }
  };
  const pause = () => {
    const entered = gate(); const release = gate();
    const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
      channels: [createUiChannel({ busSink: () => {} })] });
    service.bind({ ...block, async getReminderDestinations() { entered.resolve(); await release.promise; return { destinations: [], issues: [] }; } });
    return { entered, release };
  };
  return { db, work, service, spheres: service.spheres, put, measure, all, pause };
};

describe('counting and paging assets by sphere', () => {
  it('matches individual precedence, inherited facts, visibility, literal Unicode searches and ties before and after ANALYZE', async () => {
    const f = fixture();
    for (const id of ['jira', 'asana-x', 'asana.office', 'linear/team', 'Linear']) f.work.registerSource({ ...f.work.getSource('recued.asset')!, id });
    f.put('parent', { name: 'Ancestor', sphere: 'personal' }); f.put('override-parent', { name: 'Ancestor override', sphere: 'personal', sphere_override: 'professional' });
    f.put('deleted-parent', { name: 'Deleted ancestor', belongs_to: 'parent' });
    f.spheres.setItem({ collection: 'asset', id: 'parent' }, 'professional');
    f.spheres.setSource('work:asana.office', 'personal');
    f.db.transaction(() => { for (let index = 0; index < 441; index++) {
      const id = index === 40 ? "asset-'漢?" : `asset-${String(index).padStart(4, '0')}`;
      f.put(id, { ...(index % 9 === 0 ? { belongs_to: 'parent' } : index % 9 === 1 ? { belongs_to: 'override-parent' }
        : index % 9 === 2 ? { belongs_to: 'deleted-parent' } : {}),
        ...(index % 11 === 0 ? { source_id: ['jira', 'asana-x', 'asana.office', 'linear/team', 'Linear'][index % 5]! } : {}),
        ...(index % 4 === 0 ? { sphere: 'personal' as const } : index % 4 === 1 ? { sphere: 'professional' as const } : {}),
        ...(index % 7 === 0 ? { sphere_override: 'personal' as const } : {}),
        ...(index % 31 === 0 ? { name: 'ÉCOLE 100%_[x]? 漢', class_id: 'class_special' } : {}),
        status: index % 17 === 0 ? 'retired' : index % 13 === 0 ? 'lent' : 'active' }, at + Math.floor(index / 3));
      if (index % 10 === 0) f.spheres.setSource(`asset:${id}`, 'professional');
      if (index % 15 === 0) f.spheres.setItem({ collection: 'asset', id }, 'professional');
      if (index % 29 === 0) f.db.prepare("UPDATE data_asset SET sync_state='stale_unreachable' WHERE id=?").run(id);
      if (index % 53 === 0) f.db.prepare("UPDATE data_asset SET sync_state='tombstoned' WHERE id=?").run(id);
      if (index % 47 === 0) f.db.prepare('UPDATE data_asset SET deleted_at=1 WHERE id=?').run(id);
    } })();
    f.db.prepare('UPDATE data_asset SET deleted_at=1 WHERE id=?').run('deleted-parent');
    f.put('orphan'); f.db.prepare('UPDATE data_asset SET belongs_to=? WHERE id=?').run('absent', 'orphan');
    const queries = [{ limit: 3, offset: 0 }, { limit: 13, offset: 197 }, { limit: 200, offset: 11 }, { limit: 3, offset: 10000 },
      { search: ' ÉcOlE ', limit: 9, offset: 1 }, { search: '%_[x]?', limit: 200 }, { search: 'CLASS_SPECIAL', limit: 200 }, { search: 'missing-match', limit: 5 }];
    const projection = vi.spyOn(f.work, 'readAssetsEffective');
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE');
      for (const query of queries) {
        const all = f.all(query.search).map(asset => ({ id: asset.id, placement: f.spheres.resolve({ collection: 'asset', id: asset.id }) }));
        for (const sphere of ['personal', 'professional', 'unsorted'] as const) {
          const matching = all.filter(row => (row.placement.sphere ?? 'unsorted') === sphere);
          const page = matching.slice(query.offset ?? 0, (query.offset ?? 0) + query.limit); projection.mockClear();
          const read = await f.measure(() => f.spheres.assetPage(sphere, query));
          expect(read.value).toEqual({ ids: page.map(row => row.id), total: matching.length, placements: new Map(page.map(row => [row.id, row.placement])) });
          expect(projection).not.toHaveBeenCalled(); expect(read.sql).toHaveLength(1); expect(read.sql.every(pageSql)).toBe(true);
        }
      }
    }
  });

  it('keeps selection to one statement beyond 1000 rows, including empty pages, without projecting off-page assets', async () => {
    const f = fixture(); f.db.transaction(() => { for (let index = 0; index < 1201; index++) f.put(`asset-${String(index).padStart(4, '0')}`,
      { sphere: index % 2 ? 'professional' : 'personal' }, at + index); })();
    const projection = vi.spyOn(f.work, 'readAssetsEffective');
    for (const offset of [0, 597, 10000]) {
      const read = await f.measure(() => f.spheres.assetPage('personal', { limit: 200, offset }));
      const ids = Array.from({ length: 601 }, (_, n) => `asset-${String(1200 - n * 2).padStart(4, '0')}`).slice(offset, offset + 200);
      expect(read.value?.ids).toEqual(ids); expect(read.value?.total).toBe(601); expect(read.sql).toHaveLength(1); expect(read.sql.every(pageSql)).toBe(true);
    }
    expect(projection).not.toHaveBeenCalled();
  });

  it('preserves complete service results while projecting only the selected page', async () => {
    const f = fixture(); f.put('parent', { name: 'Ancestor', sphere: 'personal', anchors: [{ kind: 'place', name: 'Home' }] });
    f.db.transaction(() => { for (let index = 0; index < 441; index++) f.put(`asset-${String(index).padStart(4, '0')}`,
      { belongs_to: 'parent', rules: [rule], dates: { review_on: index % 3 ? '2026-10-01' : null } }, at + index); })();
    const requests: YoursReadRequest[] = [{ search: 'Fixture asset-', asset_sphere: 'personal', limit: 13, offset: 197, include_asset_summaries: true },
      { search: 'Fixture asset-', asset_sphere: 'personal', limit: 200, offset: 3 }, { asset_sphere: 'professional', include_asset_summaries: true },
      { asset_sphere: 'personal', offset: 10000, include_asset_summaries: true }];
    for (const request of requests) {
      const fallback = vi.spyOn(f.spheres, 'assetPage').mockReturnValue(undefined); let expected;
      try { expected = await f.service.snapshot(request); } finally { fallback.mockRestore(); }
      const projected = vi.spyOn(f.work, 'readAssetsEffective'); const listed = vi.spyOn(f.work, 'listByKind');
      const read = await f.measure(() => f.service.snapshot(request));
      expect(read.value).toEqual(expected); expect(read.sql.filter(pageSql)).toHaveLength(1);
      expect(listed.mock.calls.filter(([kind]) => kind === 'asset')).toEqual([]);
      expect(projected.mock.calls.map(([ids]) => ids)).toEqual(read.value.assets.length ? [read.value.assets.map(asset => asset.id)] : []);
      projected.mockRestore(); listed.mockRestore();
    }
  });

  it('reads parent, item, override and source changes on the next selection without mutating old placements', () => {
    const f = fixture(); f.put('parent', { sphere: 'personal' }); f.put('child', { belongs_to: 'parent' }); f.put('loose');
    const first = f.spheres.assetPage('personal')!; expect(first.ids).toEqual(['child', 'parent']);
    f.work.writeAsset({ ...base, id: 'parent', sphere: 'professional' }, at + 1);
    f.spheres.setItem({ collection: 'asset', id: 'child' }, 'personal'); f.spheres.setSource('work:recued.asset', 'professional');
    expect(f.spheres.assetPage('personal')?.ids).toEqual(['child']); expect(f.spheres.assetPage('professional')?.total).toBe(2);
    f.spheres.setItem({ collection: 'asset', id: 'child' }, null); f.spheres.setSource('work:recued.asset', null);
    expect(f.spheres.assetPage('professional')?.ids).toEqual(['parent', 'child']); expect(f.spheres.assetPage('unsorted')?.ids).toEqual(['loose']);
    expect(first.placements.get('child')).toMatchObject({ sphere: 'personal', pinned: false });
  });

  it('leaves custom origin callbacks, replacement resolvers and stores without work to the existing scan', async () => {
    const f = fixture(); f.put('a'); const origin = vi.fn(() => ({ source: 'calendar:team:room', sphere: 'professional' as Sphere }));
    const custom = createSphereStore(f.db, f.work, undefined, origin); const absent = createSphereStore(f.db);
    const replacement = { ...f.spheres, resolveAssets: vi.fn(f.spheres.resolveAssets) };
    const read = await f.measure(() => [custom.assetPage('personal'), absent.assetPage('personal'), replacement.assetPage('personal')]);
    expect(read.value).toEqual([undefined, undefined, undefined]); expect(read.sql).toEqual([]); expect(origin).not.toHaveBeenCalled();
  });

  for (const legacy of ['cycle', 'deep', 'root-json', 'parent-json', 'deleted-parent-json', 'hidden-column', 'null-anchor'] as const) {
    it(`retains the existing projection reader for ${legacy} legacy data`, () => {
      const f = fixture(); f.put('parent', { name: 'Ancestor', sphere: 'personal' }); f.put('target', { belongs_to: 'parent' });
      if (legacy === 'cycle') f.db.prepare('UPDATE data_asset SET belongs_to=? WHERE id=?').run('target', 'parent');
      if (legacy === 'deep') { let prior = 'parent'; for (let index = 0; index < 66; index++) {
        const id = `ancestor-${index}`; f.put(id, { name: `Ancestor ${index}` }); f.db.prepare('UPDATE data_asset SET belongs_to=? WHERE id=?').run(id, prior); prior = id;
      } }
      if (legacy === 'root-json') f.db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run('{', 'target');
      if (legacy === 'parent-json' || legacy === 'deleted-parent-json') f.db.prepare(`UPDATE data_asset SET data_blob=?${legacy === 'deleted-parent-json' ? ',deleted_at=1' : ''} WHERE id=?`).run('{', 'parent');
      if (legacy === 'hidden-column' || legacy === 'null-anchor') {
        const data = JSON.parse((f.db.prepare('SELECT data_blob FROM data_asset WHERE id=?').get('target') as { data_blob: string }).data_blob);
        f.db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run(JSON.stringify({ ...data, ...(legacy === 'hidden-column' ? { sphere: 'professional' } : { anchors: [null] }) }), 'target');
      }
      expect(f.spheres.assetPage('personal', { search: 'Fixture target' })).toBeUndefined();
    });
  }

  it('lets a pin shield an unreadable ancestor when its asset is not selected', () => {
    const f = fixture(); f.put('parent', { name: 'Ancestor', sphere: 'personal' }); f.put('target', { belongs_to: 'parent' });
    f.spheres.setItem({ collection: 'asset', id: 'target' }, 'professional'); f.db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run('{', 'parent');
    expect(f.spheres.assetPage('personal', { search: 'Fixture target' })).toEqual({ ids: [], total: 0, placements: new Map() });
    expect(f.spheres.assetPage('professional', { search: 'Fixture target' })?.ids).toEqual(['target']);
  });

  for (const id of ['target', 'parent']) for (const anchors of ['null', '{}']) it(`keeps scan errors for duplicate ${id} anchor keys ending in ${anchors}`, async () => {
    const f = fixture(); f.put('parent', { name: 'Ancestor', sphere: 'personal' }); f.put('target', { belongs_to: 'parent' });
    const blob = (f.db.prepare('SELECT data_blob FROM data_asset WHERE id=?').get(id) as { data_blob: string }).data_blob;
    const data = JSON.stringify({ ...JSON.parse(blob), anchors: [] });
    const key = id === 'parent' ? '"\\u0061nchors"' : '"anchors"';
    f.db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run(data.replace('"anchors":[]', `"anchors":[],${key}:${anchors}`), id);
    // SQLite's path lookup sees the first anchors; JSON.parse sees the last.
    const request = { asset_sphere: 'professional' as const, search: 'Fixture target' };
    const fallback = vi.spyOn(f.spheres, 'assetPage').mockReturnValue(undefined);
    try { await expect(f.service.snapshot(request)).rejects.toThrow(TypeError); } finally { fallback.mockRestore(); }
    expect(f.spheres.assetPage('professional', { search: request.search })).toBeUndefined();
    await expect(f.service.snapshot(request)).rejects.toThrow(TypeError);
  });

  for (const failure of ['prepare', 'execution'] as const) it(`falls back without changing the complete result after selection ${failure} failure`, async () => {
    const f = fixture(); for (let index = 0; index < 5; index++) f.put(`asset-${index}`, { sphere: 'personal' }, at + index);
    const request = { asset_sphere: 'personal' as const, include_asset_summaries: true, limit: 3, offset: 1 };
    const fallback = vi.spyOn(f.spheres, 'assetPage').mockReturnValue(undefined); let expected;
    try { expected = await f.service.snapshot(request); } finally { fallback.mockRestore(); }
    const prepare = f.db.prepare.bind(f.db); let failed = false;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (pageSql(sql)) { failed = true; if (failure === 'prepare') throw new Error('Fixture selection failure');
        const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementation(() => { throw new Error('Fixture selection failure'); }); return statement; }
      return prepare(sql);
    });
    expect(await f.service.snapshot(request)).toEqual(expected); expect(failed).toBe(true);
  });

  it('falls back to scan backfilling when a selected projection is missing', async () => {
    const f = fixture(); for (let index = 0; index < 6; index++) f.put(`asset-${index}`, { sphere: 'personal' }, at + index);
    const readBatch = f.work.readAssetsEffective; const readPoint = f.work.readAssetEffective;
    vi.spyOn(f.work, 'readAssetsEffective').mockImplementation((ids, scanned) => { const result = readBatch(ids, scanned); if (!scanned) result.delete('asset-5'); return result; });
    vi.spyOn(f.work, 'readAssetEffective').mockImplementation((id, canReadParent) => id === 'asset-5' ? null : readPoint(id, canReadParent));
    const result = await f.service.snapshot({ asset_sphere: 'personal', limit: 3, include_asset_summaries: true });
    expect(result.total_assets).toBe(6); expect(result.assets.map(asset => asset.id)).toEqual(['asset-4', 'asset-3', 'asset-2']);
    expect(result.asset_summaries?.map(summary => summary.asset_id)).toEqual(['asset-4', 'asset-3', 'asset-2']);
  });

  it('keeps the selected placement and inherited facts through delivery, then reads changes on the next snapshot', async () => {
    const f = fixture(); f.put('parent', { name: 'Ancestor', sphere: 'personal', anchors: [{ kind: 'place', name: 'Home' }] }); f.put('target', { belongs_to: 'parent' });
    const p = f.pause(); const reading = f.service.snapshot({ asset_sphere: 'personal', search: 'Fixture target', include_asset_summaries: true });
    try {
      await p.entered.promise; f.spheres.setItem({ collection: 'asset', id: 'target' }, 'professional');
      f.work.writeAsset({ ...base, id: 'parent', sphere: 'professional', anchors: [{ kind: 'place', name: 'Office' }] }, at + 1);
      p.release.resolve(); const first = await reading;
      expect(first.total_assets).toBe(1); expect(first.assets[0]).toMatchObject({ sphere: 'personal', anchors: [{ kind: 'place', name: 'Home' }] });
      expect(first.sphere_placements[0]).toMatchObject({ sphere: 'personal', pinned: false });
      expect((await f.service.snapshot({ asset_sphere: 'personal', search: 'Fixture target' })).total_assets).toBe(0);
      const next = await f.service.snapshot({ asset_sphere: 'professional', search: 'Fixture target' });
      expect(next.assets[0]).toMatchObject({ sphere: 'professional', anchors: [{ kind: 'place', name: 'Office' }] });
      expect(next.sphere_placements[0]).toMatchObject({ sphere: 'professional', pinned: true });
      expect(first.assets[0]?.sphere).toBe('personal');
    } finally { p.release.resolve(); await reading; }
  });
});
