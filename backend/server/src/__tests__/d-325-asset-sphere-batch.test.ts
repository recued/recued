import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { createSphereStore, type SpherePlacement } from '../storage/sphere-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';

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
afterEach(() => db.close());

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
    expect(result.get('own')).toEqual({ sphere: 'personal', reason: 'from: calendar:team:room', pinned: false, source: 'calendar:team:room' });
    expect(result.get('override')).toEqual({ sphere: 'personal', reason: 'placed by you', pinned: true, source: 'work:recued.asset' });
    expect(result.get('missing-placed')?.sphere).toBe('professional'); expect(result.get('missing-pinned')?.pinned).toBe(true);
    for (const id of ids) expect(result.get(id)).toEqual(spheres.resolve({ collection: 'asset', id }));
    const withoutWork = createSphereStore(db, undefined, undefined, origin);
    const fallback = withoutWork.resolveAssets(ids);
    for (const id of ids) expect(fallback.get(id)).toEqual(withoutWork.resolve({ collection: 'asset', id }));
  });

  it('projects inherited owner facts without sharing mutable output or changing scoped parent reads', () => {
    const parent = write('parent', { sphere: 'personal', audience: 'household', anchors: [{ kind: 'place', name: 'Home' }], exact_address: 'Fixture address' });
    write('child', { belongs_to: 'parent' }); write('sibling', { belongs_to: 'parent' }); write('grandchild', { belongs_to: 'child' });
    const ids = ['grandchild', 'child', 'parent', 'sibling', 'absent', 'child']; const result = work.readAssetsEffective(ids);
    expect([...result.keys()]).toEqual(['grandchild', 'child', 'parent', 'sibling']);
    for (const id of result.keys()) expect(result.get(id)).toEqual(work.readAssetEffective(id));
    expect(result.get('child')).toMatchObject({ sphere: 'personal', audience: 'household', anchors: parent.anchors,
      exact_address: 'Fixture address', inherited_fields: { sphere: 'parent', audience: 'parent', anchors: 'parent', exact_address: 'parent' } });
    Object.assign(result.get('child')!.anchors[0]!, { name: 'Changed' });
    expect(result.get('sibling')?.anchors).toEqual(parent.anchors); expect(result.get('parent')?.anchors).toEqual(parent.anchors);
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
    const empty = measure(() => [spheres.resolveAssets([]), work.readAssetsEffective([])]);
    expect(empty.value.every(value => value.size === 0)).toBe(true); expect(empty.sql).toEqual([]);
  });
});
