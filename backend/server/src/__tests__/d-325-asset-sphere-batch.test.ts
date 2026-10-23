import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetRule } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { createSphereStore, type SpherePlacement } from '../storage/sphere-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { summarizeYoursAsset } from '../situations/asset-summary.js';
import { createSituationStore } from '../storage/situation-store.js';

let db: Database.Database; let work: WorkEntityStore; let measured: string[] | undefined;
const base = { source_id: 'recued.asset', source: { kind: 'owner' as const, ref: 'fixture-owner' } };
const write = (id: string, extra: Partial<Parameters<WorkEntityStore['writeAsset']>[0]> = {}) => work.writeAsset({ ...base, id, name: id, ...extra });
const measure = <T>(read: () => T) => {
  const sql: string[] = []; measured = sql;
  try { return { value: read(), sql }; } finally { measured = undefined; }
};
beforeEach(() => {
  db = new Database(':memory:', { verbose(statement) { if (measured) { if (typeof statement !== 'string') throw new Error('Missing SQL trace'); measured.push(statement); } } });
  ensureWorkEntitySchema(db); work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
const ancestrySql = (sql: string) => /^WITH RECURSIVE ancestry\b/u.test(sql);
const combinedSql = (sql: string) => /^WITH asset_placement_requested\b/u.test(sql);
const separatePlacementSql = (sql: string) => /^SELECT id,sphere,source FROM sphere_items\b/u.test(sql)
  || /^SELECT source,sphere FROM sphere_sources\b/u.test(sql);

describe('batched asset sphere resolution', () => {
  it('keeps pin, override, asset, source and inherited precedence, and reads changes on the next call', () => {
    const spheres = createSphereStore(db, work);
    work.registerSource({ ...work.getSource('recued.asset')!, id: 'fixture.work' });
    work.registerSource({ ...work.getSource('recued.asset')!, id: 'linear.fixture' });
    write('parent', { sphere: 'personal' }); write('child', { belongs_to: 'parent' }); write('grandchild', { belongs_to: 'child' });
    write('override', { belongs_to: 'parent', sphere_override: 'professional' });
    write('placed', { sphere: 'personal' }); spheres.setSource('asset:placed', 'professional');
    write('pinned', { sphere_override: 'personal' }); spheres.setItem({ collection: 'asset', id: 'pinned' }, 'professional');
    write('source', { source_id: 'fixture.work', sphere: 'personal' }); spheres.setSource('work:fixture.work', 'professional');
    write('automatic', { source_id: 'linear.fixture' }); write('loose');
    const expected = new Map<string, SpherePlacement>([
      ...['parent', 'child', 'grandchild'].map(id => [id, { sphere: 'personal', reason: 'from: source or relationship', pinned: false, source: 'work:recued.asset' }] as const),
      ['override', { sphere: 'professional', reason: 'placed by you', pinned: true, source: 'work:recued.asset' }],
      ['placed', { sphere: 'professional', reason: 'from: asset placement', pinned: false, source: 'asset:placed' }],
      ['pinned', { sphere: 'professional', reason: 'placed by you', pinned: true, source: 'work:recued.asset' }],
      ['source', { sphere: 'professional', reason: 'from: work:fixture.work', pinned: false, source: 'work:fixture.work' }],
      ['automatic', { sphere: 'professional', reason: 'from: source or relationship', pinned: false, source: 'work:linear.fixture' }],
      ['loose', { reason: 'unsorted', pinned: false, source: 'work:recued.asset' }],
    ]);
    const ids = [...expected.keys()]; const first = spheres.resolveAssets(ids);
    expect(first).toEqual(expected);
    expect(spheres.resolveAssets(ids, work.listAssets({ limit: 200 }))).toEqual(expected);
    for (const id of ids) expect(first.get(id)).toEqual(spheres.resolve({ collection: 'asset', id }));
    // A parent's placement does not rewrite the child's inherited facts.
    spheres.setItem({ collection: 'asset', id: 'parent' }, 'professional');
    expect(spheres.resolveAssets(['parent', 'child']).get('child')?.sphere).toBe('personal');
    work.writeAsset({ ...base, id: 'parent', sphere: 'professional' });
    expect(spheres.resolveAssets(['child', 'grandchild']).get('grandchild')?.sphere).toBe('professional');
    expect(first.get('child')?.sphere).toBe('personal');
    spheres.setSource('work:recued.asset', 'professional');
    expect(spheres.resolveAssets(['loose']).get('loose')?.sphere).toBe('professional');
    spheres.setSource('work:recued.asset', null); spheres.setItem({ collection: 'asset', id: 'pinned' }, null);
    expect(spheres.resolveAssets(['loose', 'pinned']).get('loose')?.sphere).toBeUndefined();
    expect(spheres.resolveAssets(['pinned']).get('pinned')?.sphere).toBe('personal');
  });

  it('preserves custom origins, calendar fallbacks, absent assets and operation without a work store', () => {
    const origin = () => ({ source: 'calendar:team:room', sphere: 'professional' as const });
    const spheres = createSphereStore(db, work, undefined, origin);
    write('own', { sphere: 'personal' }); write('override', { sphere_override: 'personal' });
    spheres.setSource('calendar:team', 'personal'); spheres.setSource('asset:missing-placed', 'professional');
    spheres.setItem({ collection: 'asset', id: 'missing-pinned' }, 'professional');
    const ids = ['own', 'override', 'missing', 'missing-placed', 'missing-pinned'];
    const result = spheres.resolveAssets(ids);
    expect(spheres.resolveAssets(ids, work.listAssets({ limit: 200 }))).toEqual(result);
    expect(result.get('own')).toEqual({ sphere: 'personal', reason: 'from: calendar:team:room', pinned: false, source: 'calendar:team:room' });
    expect(result.get('override')).toEqual({ sphere: 'personal', reason: 'placed by you', pinned: true, source: 'work:recued.asset' });
    expect(result.get('missing-placed')?.sphere).toBe('professional'); expect(result.get('missing-pinned')?.pinned).toBe(true);
    for (const id of ids) expect(result.get(id)).toEqual(spheres.resolve({ collection: 'asset', id }));
    const withoutWork = createSphereStore(db, undefined, undefined, origin);
    const fallback = withoutWork.resolveAssets(ids);
    expect(withoutWork.resolveAssets(ids, work.listAssets({ limit: 200 }))).toEqual(fallback);
    for (const id of ids) expect(fallback.get(id)).toEqual(withoutWork.resolve({ collection: 'asset', id }));
  });

  it('projects inherited owner facts without sharing mutable output or changing scoped parent reads', () => {
    const parent = write('parent', { sphere: 'personal', audience: 'household', anchors: [{ kind: 'place', name: 'Home' }], exact_address: 'Fixture address' });
    write('child', { belongs_to: 'parent' }); write('sibling', { belongs_to: 'parent' }); write('grandchild', { belongs_to: 'child' });
    const ids = ['grandchild', 'child', 'parent', 'sibling', 'absent', 'child']; const result = work.readAssetsEffective(ids);
    const scanned = ['parent', 'child', 'sibling', 'grandchild'].map(id => work.readAsset(id)!); const before = structuredClone(scanned);
    const reused = measure(() => work.readAssetsEffective(ids.filter(id => id !== 'absent'), scanned));
    expect(reused.value).toEqual(result); expect(reused.sql).toEqual([]); expect(scanned).toEqual(before);
    expect([...result.keys()]).toEqual(['grandchild', 'child', 'parent', 'sibling']);
    for (const id of result.keys()) expect(result.get(id)).toEqual(work.readAssetEffective(id));
    expect(result.get('child')).toMatchObject({ sphere: 'personal', audience: 'household', anchors: parent.anchors,
      exact_address: 'Fixture address', inherited_fields: { sphere: 'parent', audience: 'parent', anchors: 'parent', exact_address: 'parent' } });
    Object.assign(result.get('child')!.anchors[0]!, { name: 'Changed' });
    expect(result.get('sibling')?.anchors).toEqual(parent.anchors); expect(result.get('parent')?.anchors).toEqual(parent.anchors);
    Object.assign(reused.value.get('child')!.anchors[0]!, { name: 'Changed reuse' });
    expect(reused.value.get('sibling')?.anchors).toEqual(parent.anchors); expect(reused.value.get('parent')?.anchors).toEqual(parent.anchors); expect(scanned).toEqual(before);
    expect(work.readAssetsEffective(['child']).get('child')?.anchors).toEqual(parent.anchors);
    const scoped = work.readAssetEffective('grandchild', () => false)!;
    expect(scoped.sphere).toBeUndefined(); expect(scoped.audience).toBeUndefined(); expect(scoped.anchors).toEqual([]); expect(scoped.exact_address).toBeUndefined();
    work.writeAsset({ ...base, id: 'parent', sphere: 'professional' });
    expect(work.readAssetsEffective(['grandchild']).get('grandchild')?.sphere).toBe('professional');
  });

  it('matches ordinary reads for legacy missing, deleted and cyclic parents without following deleted ancestors', () => {
    write('ancestor', { sphere: 'personal' }); write('deleted', { belongs_to: 'ancestor' }); write('child', { belongs_to: 'deleted' });
    db.prepare('UPDATE data_asset SET deleted_at=1 WHERE id=?').run('deleted');
    write('orphan'); db.prepare('UPDATE data_asset SET belongs_to=? WHERE id=?').run('absent', 'orphan');
    write('cycle-a', { sphere_override: 'professional' }); write('cycle-b');
    db.prepare('UPDATE data_asset SET belongs_to=? WHERE id=?').run('cycle-a', 'cycle-b');
    db.prepare('UPDATE data_asset SET belongs_to=? WHERE id=?').run('cycle-b', 'cycle-a');
    const ids = ['child', 'deleted', 'orphan', 'cycle-a', 'cycle-b'];
    const result = work.readAssetsEffective(ids); const spheres = createSphereStore(db, work); const placements = spheres.resolveAssets(ids);
    expect(spheres.resolveAssets(ids, work.listAssets({ limit: 200 }))).toEqual(placements);
    const scanned = ['ancestor', ...ids].map(id => work.readAsset(id)!);
    expect(work.readAssetsEffective(ids, scanned)).toEqual(result);
    for (const id of ids) {
      expect(result.get(id)).toEqual(work.readAssetEffective(id));
      expect(placements.get(id)).toEqual(spheres.resolve({ collection: 'asset', id }));
    }
    expect(result.get('child')?.sphere).toBeUndefined(); expect(result.get('deleted')?.sphere).toBe('personal');
    expect(result.get('cycle-b')?.sphere).toBe('professional');
  });

  it('bounds SQL work across more than a thousand assets and does no work for an empty batch', () => {
    const spheres = createSphereStore(db, work); const ids = Array.from({ length: 1001 }, (_, index) => `asset-${index}`);
    db.transaction(() => { for (const [index, id] of ids.entries()) write(id, { sphere: index % 2 ? 'personal' : 'professional' }); })();
    const batch = measure(() => spheres.resolveAssets([...ids, ids[0]!]));
    const ordinary = measure(() => new Map(ids.map(id => [id, spheres.resolve({ collection: 'asset', id })])));
    expect(batch.value).toEqual(ordinary.value); expect(batch.value.size).toBe(1001);
    expect(batch.sql.length).toBeGreaterThan(0); expect(batch.sql.length).toBeLessThanOrEqual(32);
    expect(batch.sql.length).toBeLessThan(ordinary.sql.length / 20);
    expect(batch.sql.every(sql => /^\s*(?:SELECT|WITH)\b/iu.test(sql))).toBe(true);
    const scanned = ids.map(id => work.readAsset(id)!); const before = structuredClone(scanned);
    const reused = measure(() => spheres.resolveAssets([...ids, ids[0]!], scanned));
    expect(reused.value).toEqual(ordinary.value); expect(reused.sql.filter(ancestrySql)).toEqual([]);
    expect(batch.sql.filter(ancestrySql)).toHaveLength(6); expect(reused.sql).toHaveLength(6);
    expect(reused.sql.every(combinedSql)).toBe(true); expect(scanned).toEqual(before);
    const empty = measure(() => [spheres.resolveAssets([]), work.readAssetsEffective([])]);
    expect(empty.value.every(value => value.size === 0)).toBe(true); expect(empty.sql).toEqual([]);
  });

  it('reuses supplied roots and reads missing rows and ancestors without mutating the scan', () => {
    const spheres = createSphereStore(db, work);
    const flat = write("flat-'quoted?", { sphere: 'personal' }); write('parent', { sphere: 'personal' });
    const child = write('child', { belongs_to: 'parent' }); const pinned = write('pinned', { sphere_override: 'personal' });
    write('unscanned', { sphere: 'professional' }); const extra = write('extra');
    spheres.setItem({ collection: 'asset', id: 'pinned' }, 'professional');
    const scanned = [flat, child, pinned, extra]; const before = structuredClone(scanned);
    write('parent', { sphere: 'professional' });
    const ids = [flat.id, child.id, pinned.id, 'unscanned', 'absent', flat.id];
    const expected = new Map(ids.map(id => [id, spheres.resolve({ collection: 'asset', id })]));
    const reads = vi.spyOn(work, 'readAssetsEffective'); const result = spheres.resolveAssets(ids, scanned);
    expect(result).toEqual(expected); expect([...result.keys()]).toEqual([...new Set(ids)]);
    expect(reads.mock.calls.map(([keys]) => keys)).toEqual([[flat.id, 'child', 'unscanned', 'absent']]);
    expect(result.get('child')?.sphere).toBe('professional'); expect(scanned).toEqual(before);
    expect(spheres.resolveAssets(ids)).toEqual(expected);
  });

  it('stops at a missing deleted ancestor but expands it when explicitly requested as a root', () => {
    write('ancestor', { sphere: 'professional' }); write('deleted', { belongs_to: 'ancestor' }); const child = write('child', { belongs_to: 'deleted' });
    db.prepare('UPDATE data_asset SET deleted_at=1 WHERE id=?').run('deleted');
    db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run('{', 'ancestor');
    const expected = work.readAssetEffective('child');
    const result = measure(() => work.readAssetsEffective(['child'], [child]));
    expect(result.value.get('child')).toEqual(expected); expect(result.sql.filter(ancestrySql)).toHaveLength(1);
    const deleted = work.readAsset('deleted')!;
    const complete = measure(() => work.readAssetsEffective(['child'], [child, deleted]));
    expect(complete.value.get('child')).toEqual(expected); expect(complete.sql).toEqual([]);
    expect(() => work.readAssetsEffective(['child', 'deleted'], [child])).toThrow(SyntaxError);
    expect(() => work.readAssetsEffective(['deleted'], [child, deleted])).toThrow(SyntaxError);
  });

  it('bounds missing ancestor frontiers across more than 200 supplied roots', () => {
    const ids = Array.from({ length: 241 }, (_, index) => `child-${index}`);
    db.transaction(() => { for (const [index, id] of ids.entries()) {
      write(`parent-${index}`, { sphere: index % 2 ? 'personal' : 'professional', anchors: [{ kind: 'place', name: `Place ${index}` }] });
      write(id, { belongs_to: `parent-${index}` });
    } })();
    const scanned = ids.map(id => work.readAsset(id)!); const before = structuredClone(scanned);
    const expected = new Map(ids.map(id => [id, work.readAssetEffective(id)!]));
    const result = measure(() => work.readAssetsEffective(ids, scanned));
    expect(result.value).toEqual(expected); expect(scanned).toEqual(before);
    const reads = result.sql.filter(ancestrySql); expect(reads).toHaveLength(2);
    expect(reads.map(sql => [...sql.matchAll(/'parent-\d+'/gu)].length)).toEqual([200, 41]);
  });

  it('distinguishes a deleted missing root from a deleted missing parent in the same query', () => {
    write('hidden-ancestor', { sphere: 'professional' }); write('deleted-parent', { belongs_to: 'hidden-ancestor' });
    const child = write('child', { belongs_to: 'deleted-parent' });
    write('visible-ancestor', { sphere: 'personal', anchors: [{ kind: 'place', name: 'Home' }] });
    write('deleted-root', { belongs_to: 'visible-ancestor' });
    db.prepare('UPDATE data_asset SET deleted_at=1 WHERE id IN (?,?)').run('deleted-parent', 'deleted-root');
    db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run('{', 'hidden-ancestor');
    const ids = ['child', 'deleted-root', 'absent']; const expected = new Map(ids.flatMap(id => {
      const asset = work.readAssetEffective(id); return asset ? [[id, asset] as const] : [];
    }));
    for (const analyzed of [false, true]) {
      if (analyzed) db.exec('ANALYZE');
      const result = measure(() => work.readAssetsEffective(ids, [child]));
      expect(result.value).toEqual(expected); expect(result.sql.filter(ancestrySql)).toHaveLength(1);
      expect(result.value.get('child')?.sphere).toBeUndefined(); expect(result.value.get('deleted-root')?.sphere).toBe('personal');
    }
  });

  for (const failure of ['prepare', 'execution'] as const) it(`discards a partial ancestor batch after a later ${failure} failure and reads fresh facts next time`, () => {
    const ids = Array.from({ length: 201 }, (_, index) => `child-${index}`);
    db.transaction(() => { for (const [index, id] of ids.entries()) {
      write(`parent-${index}`, { sphere: 'personal' }); write(id, { belongs_to: `parent-${index}` });
    } })();
    const scanned = ids.map(id => work.readAsset(id)!); const before = structuredClone(scanned); const prepare = db.prepare.bind(db); let reads = 0;
    const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
      if (ancestrySql(sql) && ++reads === 2) {
        if (failure === 'prepare') throw new Error('Fixture later ancestor failure');
        const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementationOnce(() => { throw new Error('Fixture later ancestor failure'); }); return statement;
      }
      return prepare(sql);
    });
    expect(() => work.readAssetsEffective(ids, scanned)).toThrow('Fixture later ancestor failure');
    expect(reads).toBe(2); expect(scanned).toEqual(before); spy.mockRestore();
    write('parent-0', { sphere: 'professional' });
    const expected = new Map(ids.map(id => [id, work.readAssetEffective(id)!]));
    const result = work.readAssetsEffective(ids, scanned);
    expect(result).toEqual(expected); expect(result.get('child-0')?.sphere).toBe('professional'); expect(scanned).toEqual(before);
  });

  it('reads pin and source changes afresh when reusing the same unchanged raw facts', () => {
    const spheres = createSphereStore(db, work); const scanned = [write('flat', { sphere: 'personal' })];
    const first = spheres.resolveAssets(['flat'], scanned); spheres.setSource('asset:flat', 'professional');
    expect(spheres.resolveAssets(['flat'], scanned).get('flat')).toEqual(spheres.resolve({ collection: 'asset', id: 'flat' }));
    spheres.setItem({ collection: 'asset', id: 'flat' }, 'personal');
    expect(spheres.resolveAssets(['flat'], scanned).get('flat')?.pinned).toBe(true);
    spheres.setItem({ collection: 'asset', id: 'flat' }, null); spheres.setSource('asset:flat', null);
    expect(spheres.resolveAssets(['flat'], scanned)).toEqual(first);
    write('flat', { sphere: 'professional' });
    expect(spheres.resolveAssets(['flat']).get('flat')?.sphere).toBe('professional'); expect(first.get('flat')?.sphere).toBe('personal');
  });

  it('combines bounded metadata reads with custom calendar origins, placement precedence and unusual ids', () => {
    const source = (id: string) => `calendar:team-${id}:room`;
    const spheres = createSphereStore(db, work, undefined, ref => ({ source: source(ref.id), sphere: 'professional' }));
    const ids = Array.from({ length: 241 }, (_, index) => index === 120 ? "asset-'漢?" : `asset-${index}`);
    db.transaction(() => { for (const [index, id] of ids.entries()) {
      write(id, { sphere: 'personal', ...(index % 7 === 0 ? { sphere_override: 'professional' as const } : {}) });
      spheres.setSource(`calendar:team-${id}`, 'professional');
      if (index % 3 === 0) spheres.setSource(source(id), 'personal');
      if (index % 5 === 0) spheres.setSource(`asset:${id}`, 'professional');
      if (index % 11 === 0) spheres.setItem({ collection: 'asset', id }, 'personal');
    } })();
    const scanned = ids.map(id => work.readAsset(id)!); const before = structuredClone(scanned);
    const expected = new Map(ids.map(id => [id, spheres.resolve({ collection: 'asset', id })]));
    for (const analyzed of [false, true]) {
      if (analyzed) db.exec('ANALYZE');
      const result = measure(() => spheres.resolveAssets([...ids, ids[0]!], scanned));
      expect(result.value).toEqual(expected); expect([...result.value.keys()]).toEqual(ids); expect(scanned).toEqual(before);
      expect(result.sql.filter(combinedSql)).toHaveLength(2); expect(result.sql.filter(separatePlacementSql)).toEqual([]);
      expect(result.sql.filter(ancestrySql)).toEqual([]);
    }
  });

  it('keeps pinned broken ancestors unread and retains the stored pin source until the pin is cleared', () => {
    const spheres = createSphereStore(db, work); write('parent', { sphere: 'personal' });
    write('child', { belongs_to: 'parent' }); const flat = write('flat', { sphere: 'personal' });
    spheres.setSource('asset:child', 'professional'); spheres.setItem({ collection: 'asset', id: 'child' }, 'professional');
    const child = write('child', { sphere_override: 'personal' });
    const expected = spheres.resolve({ collection: 'asset', id: 'child' });
    expect(expected.source).toBe('asset:child');
    db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run('{', 'parent');
    const result = measure(() => spheres.resolveAssets(['child', 'flat'], [child, flat]));
    expect(result.value.get('child')).toEqual(expected); expect(result.sql).toHaveLength(1); expect(result.sql.every(combinedSql)).toBe(true);
    spheres.setItem({ collection: 'asset', id: 'child' }, null);
    expect(() => spheres.resolveAssets(['child', 'flat'], [child, flat])).toThrow(SyntaxError);
  });

  it('retains the separate bounded path for partial scan rows and absent roots', () => {
    const spheres = createSphereStore(db, work); const a = write('a', { sphere: 'personal' }); write('b', { sphere: 'professional' });
    spheres.setSource('asset:absent', 'personal'); const ids = ['a', 'absent', 'b'];
    const expected = new Map(ids.map(id => [id, spheres.resolve({ collection: 'asset', id })]));
    for (const scanned of [undefined, [a]]) {
      const result = measure(() => spheres.resolveAssets(ids, scanned));
      expect(result.value).toEqual(expected); expect(result.sql.filter(combinedSql)).toEqual([]);
      expect(result.sql.filter(separatePlacementSql).length).toBeGreaterThan(0);
    }
  });

  it('preserves placement keys shared across asset, origin and calendar fallback lookups', () => {
    const origins = new Map([
      ['asset-a', { source: 'asset:asset-b' }], ['asset-b', { source: 'calendar:team:room' }],
      ['asset-c', { source: 'calendar:team:other' }], ['asset-d', { source: 'calendar:team' }],
    ]);
    const spheres = createSphereStore(db, work, undefined, ref => origins.get(ref.id));
    const ids = [...origins.keys()]; const scanned = ids.map(id => write(id, { sphere: 'personal' }));
    spheres.setSource('asset:asset-b', 'professional'); spheres.setSource('calendar:team', 'professional');
    spheres.setSource('calendar:team:room', 'personal');
    for (const analyzed of [false, true]) {
      if (analyzed) db.exec('ANALYZE');
      spheres.setSource('asset:asset-b', 'professional');
      const expected = new Map([...ids].reverse().map(id => [id, spheres.resolve({ collection: 'asset', id })]));
      const read = measure(() => spheres.resolveAssets([...ids].reverse(), scanned));
      expect(read.value).toEqual(expected); expect([...read.value.keys()]).toEqual([...ids].reverse());
      expect(read.sql).toHaveLength(1); expect(read.sql.every(combinedSql)).toBe(true);
      expect(read.value.get('asset-a')?.sphere).toBe('professional');
      expect(read.value.get('asset-b')?.source).toBe('asset:asset-b');
      expect(read.value.get('asset-c')?.sphere).toBe('professional');
      spheres.setSource('asset:asset-b', null);
      const changed = spheres.resolveAssets(ids, scanned);
      expect(changed).toEqual(new Map(ids.map(id => [id, spheres.resolve({ collection: 'asset', id })])));
      expect(changed.get('asset-a')?.sphere).toBe('personal'); expect(changed.get('asset-b')?.sphere).toBe('personal');
    }
  });

  for (const failure of ['prepare', 'execution'] as const) it(`retains a pin with no stored source and skips its broken ancestor after combined ${failure} fails`, () => {
    const spheres = createSphereStore(db, work); spheres.setItem({ collection: 'asset', id: 'late' }, 'professional');
    write('parent', { sphere: 'personal' }); const child = write('late', { belongs_to: 'parent', sphere_override: 'personal' });
    db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run('{', 'parent');
    const expected = spheres.resolve({ collection: 'asset', id: 'late' });
    expect(expected).toEqual({ sphere: 'professional', reason: 'placed by you', pinned: true });
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(sql => {
      if (combinedSql(sql)) {
        if (failure === 'prepare') throw new Error('Fixture pinned combined failure');
        const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementationOnce(() => { throw new Error('Fixture pinned combined failure'); }); return statement;
      }
      return prepare(sql);
    });
    const result = measure(() => spheres.resolveAssets(['late'], [child]));
    expect(result.value.get('late')).toEqual(expected); expect(result.sql.filter(ancestrySql)).toEqual([]);
    expect(result.sql.filter(separatePlacementSql)).toHaveLength(1);
  });

  for (const failedChunk of [1, 2]) for (const failure of ['prepare', 'execution'] as const) {
    it(`uses separate lookups after combined chunk ${failedChunk} ${failure} fails without dropping earlier results`, () => {
      const spheres = createSphereStore(db, work); const ids = Array.from({ length: 241 }, (_, index) => `asset-${index}`);
      db.transaction(() => { for (const [index, id] of ids.entries()) write(id, { sphere: index % 2 ? 'personal' : 'professional' }); })();
      const scanned = ids.map(id => work.readAsset(id)!); const expected = new Map(ids.map(id => [id, spheres.resolve({ collection: 'asset', id })]));
      const prepare = db.prepare.bind(db); let attempts = 0;
      vi.spyOn(db, 'prepare').mockImplementation(sql => {
        if (combinedSql(sql) && ++attempts === failedChunk) {
          if (failure === 'prepare') throw new Error('Fixture combined placement failure');
          const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementationOnce(() => { throw new Error('Fixture combined placement failure'); }); return statement;
        }
        return prepare(sql);
      });
      const result = measure(() => spheres.resolveAssets(ids, scanned));
      expect(result.value).toEqual(expected); expect(attempts).toBe(2);
      expect(result.sql.filter(separatePlacementSql).length).toBeGreaterThan(0); expect(result.sql.filter(ancestrySql)).toEqual([]);
    });
  }

  for (const failure of ['prepare', 'execution'] as const) it(`retains ancestry ${failure} errors for a mixed scan`, () => {
    const spheres = createSphereStore(db, work); const flat = write('flat', { sphere: 'personal' });
    write('parent', { sphere: 'professional' }); const child = write('child', { belongs_to: 'parent' }); const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(sql => {
      if (ancestrySql(sql) && failure === 'prepare') throw new Error('Fixture ancestry failure');
      const statement = prepare(sql);
      if (ancestrySql(sql)) vi.spyOn(statement, 'all').mockImplementation(() => { throw new Error('Fixture ancestry failure'); });
      return statement;
    });
    expect(() => spheres.resolveAssets(['flat', 'child'], [flat, child])).toThrow('Fixture ancestry failure');
    expect(spheres.resolveAssets(['flat'], [flat]).get('flat')?.sphere).toBe('personal');
  });

  it('limits ancestry reads while retaining selected projections and summaries', async () => {
    const at = Date.parse('2026-10-17T12:00Z');
    const rule: AssetRule = { id: 'review', title: 'Review', enabled: true, muted: true, pinned: false, consequence: 'routine', expiry_policy: 'escalate_overdue',
      when: { kind: 'expiry', field: 'review_on' }, reaction: { notify: false, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } };
    db.transaction(() => { for (let index = 0; index < 601; index++) write(`asset-${index}`, { sphere: 'personal', rules: [rule], dates: { review_on: null } }); })();
    const page = work.listAssets({ limit: 13, offset: 197 }); const expected = page.map(asset => work.readAssetEffective(asset.id)!);
    const summaries = page.map(asset => summarizeYoursAsset(asset, { work, occurrences: [], now: at, timeZone: 'UTC' }));
    const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
    const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => at, timeZone: () => 'UTC' });
    const service = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db), now: () => at, timeZone: () => 'UTC' });
    try {
      for (const asset_filter of [undefined, 'missing_facts'] as const) {
        const sql: string[] = []; measured = sql;
        const result = await service.snapshot({ asset_sphere: 'personal', ...(asset_filter ? { asset_filter } : {}), offset: 197, limit: 13, include_asset_summaries: true });
        measured = undefined;
        expect(result.total_assets).toBe(601); expect(result.assets).toEqual(expected); expect(result.asset_summaries).toEqual(summaries);
        expect(result.sphere_placements.map(row => row.ref.id)).toEqual(page.map(asset => asset.id));
        expect(sql.filter(ancestrySql)).toHaveLength(asset_filter ? 2 : 1);
        expect(sql.filter(combinedSql)).toHaveLength(0);
        expect(sql.filter(statement => /^WITH RECURSIVE asset_sphere_roots\b/u.test(statement))).toHaveLength(1);
        expect(sql.filter(statement => /\basset_sphere_candidates AS\b/u.test(statement))).toHaveLength(asset_filter ? 1 : 0);
        expect(sql.filter(separatePlacementSql)).toEqual([]);
      }
    } finally { measured = undefined; await service.stop(); }
  });
});
