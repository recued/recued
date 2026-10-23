import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetCreateInput, AssetRule, Sphere, YoursReadRequest } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createSphereStore, type AssetSphereBatch, type SphereStore } from '../storage/sphere-store.js';
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
const candidateSql = (sql: string) => /\basset_sphere_candidates AS\b/u.test(sql);
const listSql = (sql: string) => /^SELECT \* FROM data_asset\b/u.test(sql) && /ORDER BY updated_at DESC,id ASC LIMIT/u.test(sql);
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
const fixture = () => {
  let measured: string[] | undefined;
  const db = new Database(':memory:', { verbose(sql) { if (measured) measured.push(String(sql)); } }); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => at, timeZone: () => 'UTC' });
  const service = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db), now: () => at, timeZone: () => 'UTC' });
  disposals.push(async () => { await service.stop(); db.close(); });
  const put = (id: string, patch: Partial<AssetCreateInput> = {}, time = at) => work.writeAsset({ ...base, id, name: `Fixture ${id}`, rules: [rule], dates: { review_on: null }, ...patch }, time);
  const all = (search?: string) => {
    const assets: Asset[] = [];
    for (let offset = 0; ; offset += 200) { const batch = work.listAssets({ search, limit: 200, offset }); assets.push(...batch); if (batch.length < 200) return assets; }
  };
  const measure = async <T>(read: () => T | Promise<T>) => {
    const sql: string[] = []; measured = sql;
    try { return { value: await read(), sql }; } finally { measured = undefined; }
  };
  const retained = async (request: YoursReadRequest) => {
    const fallback = vi.spyOn(service.spheres, 'assetCandidates').mockReturnValue(undefined);
    const pageFallback = vi.spyOn(service.spheres, 'assetPage').mockReturnValue(undefined);
    try { return await service.snapshot(request); } finally { fallback.mockRestore(); pageFallback.mockRestore(); }
  };
  const capture = () => {
    const prepare = db.prepare.bind(db); const statements: Database.Statement[] = [];
    vi.spyOn(db, 'prepare').mockImplementation(sql => { const statement = prepare(sql); if (candidateSql(sql)) statements.push(statement); return statement; });
    return statements;
  };
  return { db, work, service, spheres: service.spheres, put, all, measure, retained, capture };
};
const collect = (scan: ReturnType<SphereStore['assetCandidates']>) => {
  if (!scan) return undefined;
  const batches: AssetSphereBatch[] = [];
  try { for (;;) { const next = scan.next(); if (next.done) return { batches, complete: next.value }; batches.push(next.value); } }
  finally { scan.return(false); }
};

describe('streaming sphere-selected attention candidates', () => {
  it('matches raw rows and individual placement precedence, visibility, ordering and literal searches before and after ANALYZE', async () => {
    const f = fixture();
    for (const id of ['jira', 'asana-x', 'asana.office', 'linear/team', 'Linear']) f.work.registerSource({ ...f.work.getSource('recued.asset')!, id });
    f.put('parent', { name: 'Ancestor', sphere: 'personal', anchors: [{ kind: 'place', name: 'Home' }] });
    f.put('override-parent', { name: 'Ancestor override', sphere: 'personal', sphere_override: 'professional' });
    f.put('deleted-parent', { name: 'Deleted ancestor', belongs_to: 'parent' });
    f.spheres.setItem({ collection: 'asset', id: 'parent' }, 'professional'); f.spheres.setSource('work:asana.office', 'personal');
    f.db.transaction(() => { for (let index = 0; index < 441; index++) {
      const id = index === 40 ? "asset-'漢?" : `asset-${String(index).padStart(4, '0')}`;
      f.put(id, { ...(index % 9 === 0 ? { belongs_to: 'parent' } : index % 9 === 1 ? { belongs_to: 'override-parent' } : index % 9 === 2 ? { belongs_to: 'deleted-parent' } : {}),
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
    const projected = vi.spyOn(f.work, 'readAssetsEffective');
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE');
      for (const search of [undefined, ' ÉcOlE ', '%_[x]?', 'CLASS_SPECIAL', 'missing-match']) {
        const raw = f.all(search); const placements = new Map(raw.map(asset => [asset.id, f.spheres.resolve({ collection: 'asset', id: asset.id })]));
        for (const sphere of ['personal', 'professional', 'unsorted'] as const) {
          const expected = raw.filter(asset => (placements.get(asset.id)?.sphere ?? 'unsorted') === sphere); projected.mockClear();
          const read = await f.measure(() => collect(f.spheres.assetCandidates(sphere, { search })));
          expect(read.value?.complete).toBe(true); expect(read.value?.batches.flatMap(batch => batch.assets)).toEqual(expected);
          expect(read.value?.batches.flatMap(batch => [...batch.placements])).toEqual(expected.map(asset => [asset.id, placements.get(asset.id)]));
          expect(read.value?.batches.every(batch => batch.assets.length > 0 && batch.assets.length <= 200)).toBe(true);
          expect(projected).not.toHaveBeenCalled(); expect(read.sql).toHaveLength(1); expect(read.sql.every(candidateSql)).toBe(true);
        }
      }
    }
  });

  it('uses one lazy cursor for more than 1000 candidates and allows nested history and projection reads', async () => {
    const f = fixture(); f.db.transaction(() => { for (let index = 0; index < 1201; index++) f.put(`asset-${String(index).padStart(4, '0')}`, { sphere: 'professional' }, at + index); })();
    const statements = f.capture(); const prepare = vi.mocked(f.db.prepare);
    const unopened = f.spheres.assetCandidates('professional')!; expect(statements).toEqual([]); unopened.return(false); expect(statements).toEqual([]);
    const scan = f.spheres.assetCandidates('professional')!; const first = scan.next();
    expect(first.done).toBe(false); expect(statements).toHaveLength(1); expect(statements[0]!.busy).toBe(true);
    expect(f.work.readAssetsEffective(['asset-1200']).get('asset-1200')?.id).toBe('asset-1200');
    expect(f.work.assetReadingHistories([{ asset_id: 'asset-1200', field: 'meter' }]).get('asset-1200')?.get('meter')).toEqual([]);
    const batches = first.done ? [] : [first.value];
    for (;;) { const next = scan.next(); if (next.done) { expect(next.value).toBe(true); break; } batches.push(next.value); }
    expect(batches.map(batch => batch.assets.length)).toEqual([200, 200, 200, 200, 200, 200, 1]);
    expect(batches.flatMap(batch => batch.assets.map(asset => asset.id))).toEqual(Array.from({ length: 1201 }, (_, n) => `asset-${String(1200 - n).padStart(4, '0')}`));
    expect(statements[0]!.busy).toBe(false); expect(prepare.mock.calls.filter(([sql]) => candidateSql(sql))).toHaveLength(1);
    const partial = f.spheres.assetCandidates('professional')!; partial.next(); expect(statements[1]!.busy).toBe(true);
    partial.return(false); expect(statements[1]!.busy).toBe(false); expect(partial.next()).toEqual({ done: true, value: undefined });
  });

  for (const sphere of ['personal', 'professional', 'unsorted'] as const) for (const asset_filter of ['missing_facts', 'overdue'] as const) {
    it(`preserves complete ${sphere}/${asset_filter} attention results using one selector and projecting only returned IDs`, async () => {
      const f = fixture(); f.put('parent', { name: 'Ancestor', sphere: 'personal', anchors: [{ kind: 'place', name: 'Home' }] });
      f.db.transaction(() => { for (let index = 0; index < 601; index++) {
        const id = `asset-${String(index).padStart(4, '0')}`;
        f.put(id, { belongs_to: 'parent', dates: { review_on: index % 3 ? '2026-10-01' : null },
          ...(index % 7 === 0 ? { sphere_override: 'professional' as const } : {}) }, at + index);
        if (index % 5 === 0) f.spheres.setItem({ collection: 'asset', id }, 'professional');
      } })();
      for (const offset of [0, 197, 10000]) for (const include_asset_summaries of [false, true]) {
        const request = { search: 'Fixture asset-', asset_sphere: sphere, asset_filter, include_asset_summaries, offset, limit: 13 };
        const expected = await f.retained(request); const projected = vi.spyOn(f.work, 'readAssetsEffective'); const listed = vi.spyOn(f.work, 'listByKind');
        const read = await f.measure(() => f.service.snapshot(request));
        expect(read.value).toEqual(expected); expect(read.sql.filter(candidateSql)).toHaveLength(1); expect(read.sql.filter(listSql)).toEqual([]);
        expect(listed.mock.calls.filter(([kind]) => kind === 'asset')).toEqual([]);
        expect(projected.mock.calls.flatMap(([ids]) => [...ids])).toEqual(read.value.assets.map(asset => asset.id));
        projected.mockRestore(); listed.mockRestore();
      }
    });
  }

  it('defers custom origins, replacement resolvers and stores without work without opening a cursor', async () => {
    const f = fixture(); f.put('target'); const origin = vi.fn(() => ({ source: 'calendar:team:room', sphere: 'professional' as Sphere }));
    const custom = createSphereStore(f.db, f.work, undefined, origin); const absent = createSphereStore(f.db);
    const replaced = { ...f.spheres, resolveAssets: vi.fn(f.spheres.resolveAssets) };
    const read = await f.measure(() => [custom.assetCandidates('personal'), absent.assetCandidates('personal'), replaced.assetCandidates('personal')]);
    expect(read.value).toEqual([undefined, undefined, undefined]); expect(read.sql).toEqual([]); expect(origin).not.toHaveBeenCalled();
  });

  it('ignores a legacy empty parent link even when an empty asset ID exists', () => {
    const f = fixture(); f.put('parent', { name: 'Ancestor', sphere: 'professional' }); f.put('target');
    f.db.prepare('UPDATE data_asset SET id=? WHERE id=?').run('', 'parent');
    f.db.prepare('UPDATE data_asset SET belongs_to=? WHERE id=?').run('', 'target');
    expect(f.spheres.resolve({ collection: 'asset', id: 'target' }).sphere).toBeUndefined();
    const professional = collect(f.spheres.assetCandidates('professional', { search: 'Fixture target' }))!;
    expect(professional).toEqual({ batches: [], complete: true });
    expect(f.spheres.assetPage('professional', { search: 'Fixture target' })?.total).toBe(0);
    const unsorted = collect(f.spheres.assetCandidates('unsorted', { search: 'Fixture target' }))!;
    expect(unsorted.batches.flatMap(batch => batch.assets.map(asset => asset.id))).toEqual(['target']);
  });

  for (const asset_filter of [undefined, 'missing_facts'] as const) it(`retains nullable legacy identity counts and backfills the ${asset_filter ?? 'sphere-only'} page`, async () => {
    const f = fixture(); f.put('valid', { sphere: 'personal' }, at + 1); f.put('legacy', { sphere: 'personal' }, at + 2);
    f.db.prepare('UPDATE data_asset SET id=NULL WHERE id=?').run('legacy');
    const request = { asset_sphere: 'personal' as const, ...(asset_filter ? { asset_filter } : {}), include_asset_summaries: true, limit: 1 };
    const expected = await f.retained(request);
    expect(expected.total_assets).toBe(2); expect(expected.assets.map(asset => asset.id)).toEqual(['valid']);
    expect(await f.service.snapshot(request)).toEqual(expected);
    expect(f.spheres.assetPage('personal')).toBeUndefined();
    const scan = f.spheres.assetCandidates('personal')!;
    expect(scan.next()).toEqual({ done: true, value: false });
  });

  for (const legacy of ['cycle', 'deep', 'root-json', 'parent-json', 'deleted-parent-json', 'hidden-column', 'null-anchor', 'duplicate-root', 'duplicate-parent'] as const) {
    it(`requests the retained scan before yielding any rows for ${legacy}`, () => {
      const f = fixture(); f.put('parent', { name: 'Ancestor', sphere: 'personal' }); f.put('target', { belongs_to: 'parent' });
      if (legacy === 'cycle') f.db.prepare('UPDATE data_asset SET belongs_to=? WHERE id=?').run('target', 'parent');
      if (legacy === 'deep') { let prior = 'parent'; for (let index = 0; index < 66; index++) {
        const id = `ancestor-${index}`; f.put(id, { name: `Ancestor ${index}` }); f.db.prepare('UPDATE data_asset SET belongs_to=? WHERE id=?').run(id, prior); prior = id;
      } }
      if (legacy === 'root-json') f.db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run('{', 'target');
      if (legacy === 'parent-json' || legacy === 'deleted-parent-json') f.db.prepare(`UPDATE data_asset SET data_blob=?${legacy === 'deleted-parent-json' ? ',deleted_at=1' : ''} WHERE id=?`).run('{', 'parent');
      if (legacy === 'hidden-column' || legacy === 'null-anchor' || legacy.startsWith('duplicate-')) {
        const id = legacy === 'duplicate-parent' ? 'parent' : 'target';
        const data = JSON.parse((f.db.prepare('SELECT data_blob FROM data_asset WHERE id=?').get(id) as { data_blob: string }).data_blob);
        let blob = JSON.stringify({ ...data, ...(legacy === 'hidden-column' ? { sphere: 'professional' } : legacy === 'null-anchor' ? { anchors: [null] } : {}) });
        if (legacy.startsWith('duplicate-')) blob = blob.replace('"anchors":[]', '"anchors":[],"\\u0061nchors":null');
        f.db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run(blob, id);
      }
      const statements = f.capture(); const scan = f.spheres.assetCandidates('professional', { search: 'Fixture target' })!;
      expect(scan.next()).toEqual({ done: true, value: false }); expect(statements[0]!.busy).toBe(false);
    });
  }

  it('lets a pin shield an unreadable ancestor when its asset is outside the requested attention sphere', async () => {
    const f = fixture(); f.put('parent', { name: 'Ancestor', sphere: 'personal' }); f.put('target', { belongs_to: 'parent' });
    f.spheres.setItem({ collection: 'asset', id: 'target' }, 'professional'); f.db.prepare('UPDATE data_asset SET deleted_at=1,data_blob=? WHERE id=?').run('{', 'parent');
    const request = { asset_sphere: 'personal' as const, asset_filter: 'missing_facts' as const, search: 'Fixture target' };
    const expected = await f.retained(request); const read = await f.measure(() => f.service.snapshot(request));
    expect(read.value).toEqual(expected); expect(read.value.total_assets).toBe(0); expect(read.sql.filter(candidateSql)).toHaveLength(1); expect(read.sql.filter(listSql)).toEqual([]);
    await expect(f.service.snapshot({ ...request, asset_sphere: 'professional' })).rejects.toThrow(SyntaxError);
  });

  for (const failure of ['prepare', 'execution', 'later', 'close'] as const) it(`restarts the retained scan after ${failure} selection failure without keeping prefix counts, rows or summaries`, async () => {
    const f = fixture(); f.db.transaction(() => { for (let index = 0; index < 601; index++) f.put(`asset-${String(index).padStart(4, '0')}`, { sphere: 'professional' }, at + index); })();
    const data = JSON.parse((f.db.prepare('SELECT data_blob FROM data_asset WHERE id=?').get('asset-0600') as { data_blob: string }).data_blob);
    f.db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run(JSON.stringify({ ...data, rules: null }), 'asset-0600');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = { asset_filter: 'missing_facts' as const, asset_sphere: 'professional' as const, include_asset_summaries: true, offset: 197, limit: 13 };
    const expected = await f.retained(request); expect(expected.total_assets).toBe(600); expect(expected.asset_filter?.unavailable).toBe(1);
    const prepare = f.db.prepare.bind(f.db); let failed = false; let closed = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (candidateSql(sql) && failure === 'prepare') { failed = true; throw new Error('Fixture selection prepare failure'); }
      const statement = prepare(sql);
      if (candidateSql(sql)) {
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
          if (failure === 'execution') { failed = true; throw new Error('Fixture selection execution failure'); }
          const cursor = iterate(...params); let reads = 0;
          return { next() { if (failure === 'later' && ++reads === 201) { failed = true; throw new Error('Fixture later selection failure'); } return cursor.next(); },
            return() { closed++; const result = cursor.return?.() ?? { done: true, value: undefined };
              if (failure === 'close') { failed = true; throw new Error('Fixture selection close failure'); } return result; }, [Symbol.iterator]() { return this; } };
        });
      }
      return statement;
    });
    const result = await f.service.snapshot(request);
    expect(result).toEqual(expected); expect(failed).toBe(true); expect(closed).toBe(failure === 'later' || failure === 'close' ? 1 : 0);
  });

  it('closes the cursor and preserves an individual projection error without retrying it as a selector failure', async () => {
    const f = fixture(); f.put('target', { sphere: 'professional' }); const statements = f.capture(); const listed = vi.spyOn(f.work, 'listByKind');
    const error = new Error('Fixture individual projection error');
    vi.spyOn(f.work, 'readAssetsEffective').mockImplementation(() => { throw new Error('Fixture packed projection error'); });
    vi.spyOn(f.work, 'readAssetEffective').mockImplementation(() => { throw error; });
    await expect(f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional' })).rejects.toBe(error);
    expect(statements).toHaveLength(1); expect(statements[0]!.busy).toBe(false); expect(listed.mock.calls.filter(([kind]) => kind === 'asset')).toEqual([]);
  });

  it('preserves an individual projection error when cancelling the native cursor also throws', async () => {
    const f = fixture(); f.db.transaction(() => { for (let index = 0; index < 201; index++) f.put(`asset-${index}`, { sphere: 'professional' }); })();
    const prepare = f.db.prepare.bind(f.db); const statements: Database.Statement[] = []; let closed = 0;
    const projectionError = new Error('Fixture individual projection failure'); const cleanupError = new Error('Fixture cursor cleanup failure');
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (candidateSql(sql)) {
        statements.push(statement); const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
          const cursor = iterate(...params);
          return { next() { return cursor.next(); }, return() { cursor.return?.(); closed++; throw cleanupError; }, [Symbol.iterator]() { return this; } };
        });
      }
      return statement;
    });
    vi.spyOn(f.work, 'readAssetsEffective').mockImplementation(() => { throw new Error('Fixture packed projection failure'); });
    vi.spyOn(f.work, 'readAssetEffective').mockImplementation(() => { throw projectionError; });
    const listed = vi.spyOn(f.work, 'listByKind');
    await expect(f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional', limit: 1 })).rejects.toBe(projectionError);
    expect(closed).toBe(1); expect(statements[0]!.busy).toBe(false); expect(listed.mock.calls.filter(([kind]) => kind === 'asset')).toEqual([]);
  });

  it('falls back if the candidate iterator return method throws after completed selection', async () => {
    const f = fixture(); f.put('target', { sphere: 'professional' });
    const request = { asset_filter: 'missing_facts' as const, asset_sphere: 'professional' as const, include_asset_summaries: true };
    const expected = await f.retained(request); const select = f.spheres.assetCandidates; let cancelled = 0;
    vi.spyOn(f.spheres, 'assetCandidates').mockImplementation((sphere, query) => {
      const cursor = select.call(f.spheres, sphere, query)!;
      vi.spyOn(cursor, 'return').mockImplementation(() => { cancelled++; throw new Error('Fixture iterator return failure'); });
      return cursor;
    });
    expect(await f.service.snapshot(request)).toEqual(expected); expect(cancelled).toBe(1);
  });

  it('loads fresh raw facts and placements on the next cursor without mutating earlier batches', () => {
    const f = fixture(); f.put('parent', { name: 'Ancestor', sphere: 'personal' }); f.put('target', { belongs_to: 'parent' });
    const first = collect(f.spheres.assetCandidates('personal', { search: 'Fixture target' }))!;
    expect(first.batches[0]!.assets[0]!.sphere).toBeUndefined(); expect(first.batches[0]!.placements.get('target')?.sphere).toBe('personal');
    f.work.writeAsset({ ...base, id: 'parent', sphere: 'professional' }, at + 1);
    expect(collect(f.spheres.assetCandidates('personal', { search: 'Fixture target' }))!.batches).toEqual([]);
    f.spheres.setItem({ collection: 'asset', id: 'target' }, 'personal'); f.put('target', { dates: { review_on: '2026-11-01' } }, at + 1);
    const next = collect(f.spheres.assetCandidates('personal', { search: 'Fixture target' }))!;
    expect(next.batches[0]!.assets[0]!.dates.review_on).toBe('2026-11-01'); expect(next.batches[0]!.placements.get('target')).toMatchObject({ sphere: 'personal', pinned: true });
    expect(first.batches[0]!.assets[0]!.dates.review_on).toBeNull(); expect(first.batches[0]!.placements.get('target')?.pinned).toBe(false);
  });
});
