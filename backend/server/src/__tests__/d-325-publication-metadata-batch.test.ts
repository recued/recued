import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createSphereStore } from '../storage/sphere-store.js';

const disposals: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0).reverse()) dispose(); });
const fixture = () => {
  let sql: string[] | undefined;
  const db = new Database(':memory:', { verbose: statement => sql?.push(String(statement)) });
  disposals.push(() => db.close()); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const spheres = createSphereStore(db, work);
  const put = (id: string, patch: Partial<Parameters<typeof work.writeAsset>[0]> = {}) => work.writeAsset({
    id, name: id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, ...patch,
  }, 100);
  const measure = <T>(read: () => T) => {
    const before = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const statements: string[] = []; sql = statements;
    let value: T; try { value = read(); } finally { sql = undefined; }
    return { value, sql: statements, changes: (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n - before };
  };
  const points = (ids: string[]) => new Map(ids.map(id => [id, spheres.resolve({ collection: 'asset', id })]));
  const preload = (ids: string[]) => measure(() => spheres.prefetchAssetPlacements(ids));
  return { db, work, spheres, put, measure, points, preload };
};
const metadataSql = (sql: string) => /^WITH publication_asset_requested\b/u.test(sql);
const ancestrySql = (sql: string) => /^WITH RECURSIVE ancestry\b/u.test(sql);
const separateSql = (sql: string) => /^SELECT id,sphere,source FROM sphere_items\b/u.test(sql);
const sourceSql = (sql: string) => /^SELECT source,sphere FROM sphere_sources\b/u.test(sql);

describe('D-325 native publication placement metadata and root rows', () => {
  for (const count of [0, 1, 2, 199, 200, 201, 401, 1001]) it(`loads metadata and flat roots together for ${count} assets without writes`, () => {
    const f = fixture(), ids = Array.from({ length: count }, (_, i) => `asset-${i}`);
    f.db.transaction(() => ids.forEach((id, i) => f.put(id, { sphere: i % 2 ? 'personal' : 'professional' })))();
    const expected = f.points(ids), read = f.preload([...ids, ...ids.slice(0, 1)]);
    expect(read.sql.filter(metadataSql)).toHaveLength(Math.ceil(count / 200));
    expect(read.sql.filter(ancestrySql)).toEqual([]); expect(read.sql.filter(separateSql)).toEqual([]);
    expect(read.sql.filter(sourceSql)).toHaveLength(Math.floor(count / 200) * 2 + (count % 200 ? 1 : 0));
    expect(read.sql.filter(statement => /^SELECT total_changes\(\) AS writes/u.test(statement))).toHaveLength(count ? 2 : 0);
    expect(read.changes).toBe(0); expect(read.sql.every(statement => /^(?:SELECT|WITH)\b/u.test(statement))).toBe(true);
    if (!count) expect(read.value).toBeUndefined();
    else expect(new Map(ids.map(id => [id, read.value!.read(id)]))).toEqual(expected);
  });

  it('retains placement precedence, absent and unavailable roots, unusual ids and ANALYZE parity', () => {
    const f = fixture(); f.work.registerSource({ ...f.work.getSource('recued.asset')!, id: 'jira.project' });
    f.put('parent', { sphere: 'personal' }); f.put('child', { belongs_to: 'parent' });
    f.put('pin', { sphere_override: 'professional' }); f.spheres.setItem({ collection: 'asset', id: 'pin' }, 'personal');
    f.put('override', { sphere_override: 'personal' }); f.spheres.setSource('asset:override', 'professional');
    f.put("quoted-'漢😀", { sphere: 'personal' }); f.spheres.setSource("asset:quoted-'漢😀", 'professional');
    f.put('automatic', { source_id: 'jira.project' }); f.put('orphan', { sync_state: 'orphaned' });
    f.put('deleted', { sphere: 'personal' }); f.work.deleteAsset('deleted', { tombstone: true });
    f.spheres.setSource('asset:absent', 'personal'); f.spheres.setSource('work:recued.asset', 'professional');
    const ids = ['child', 'pin', 'override', "quoted-'漢😀", 'automatic', 'orphan', 'deleted', 'absent'];
    for (const analyzed of [false, true]) {
      if (analyzed) { f.db.exec('ANALYZE'); f.spheres.setSource('work:recued.asset', null); }
      const expected = f.points(ids), read = f.preload(ids);
      expect(new Map(ids.map(id => [id, read.value!.read(id)]))).toEqual(expected);
      expect(read.sql.filter(metadataSql)).toHaveLength(1); expect(read.sql.filter(separateSql)).toEqual([]); expect(read.changes).toBe(0);
      expect(read.value!.read('absent')?.sphere).toBe('personal'); expect(read.value!.read('pin')?.sphere).toBe('personal');
      expect(read.value!.read('automatic')?.sphere).toBe('professional');
    }
  });

  it('reuses loaded roots and fetches only missing ancestors', () => {
    const f = fixture(); f.put('parent', { sphere: 'professional' }); f.put('a', { belongs_to: 'parent' }); f.put('b', { belongs_to: 'parent' });
    const ids = ['a', 'b'], expected = f.points(ids), read = f.preload(ids);
    expect(new Map(ids.map(id => [id, read.value!.read(id)]))).toEqual(expected);
    const ancestry = read.sql.filter(ancestrySql); expect(ancestry).toHaveLength(1);
    expect(ancestry[0]).toContain("'parent'"); expect(ancestry[0]).not.toContain("'a'"); expect(ancestry[0]).not.toContain("'b'");
    const complete = f.preload(['parent', ...ids]); expect(complete.sql.filter(ancestrySql)).toEqual([]);
    expect(complete.value!.read('a')).toEqual(expected.get('a'));
  });

  it('keeps item pins shielding broken root and parent JSON', () => {
    const f = fixture(); f.put('parent'); f.put('child', { belongs_to: 'parent' }); f.put('broken');
    for (const id of ['child', 'broken']) f.spheres.setItem({ collection: 'asset', id }, 'personal');
    f.db.prepare("UPDATE data_asset SET data_blob='invalid JSON' WHERE id IN ('parent','broken')").run();
    const ids = ['child', 'broken'], expected = f.points(ids), read = f.preload(ids);
    expect(new Map(ids.map(id => [id, read.value!.read(id)]))).toEqual(expected);
    expect(read.sql.filter(metadataSql)).toHaveLength(1); expect(read.sql.filter(ancestrySql)).toEqual([]);
    expect(read.sql.filter(separateSql)).toEqual([]);
  });

  for (const parent of ['parent', 7]) it(`retains the original projection for a legacy blob parent ${parent}`, () => {
    const f = fixture(); f.put(String(parent), { sphere: 'professional' }); f.put('legacy'); f.put('tail');
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.belongs_to',?) WHERE id='legacy'").run(parent);
    const ids = ['legacy', 'tail'], expected = f.points(ids), read = f.preload(ids);
    expect(new Map(ids.map(id => [id, read.value!.read(id)]))).toEqual(expected);
    expect(read.value!.read('legacy')?.sphere).toBe(typeof parent === 'string' ? 'professional' : undefined); expect(read.sql.filter(ancestrySql).length).toBeGreaterThan(0);
  });

  it('retains a legacy sphere override absent from its canonical column', () => {
    const f = fixture(); f.put('legacy'); f.put('tail'); f.spheres.setSource('asset:legacy', 'professional');
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.sphere_override','personal') WHERE id='legacy'").run();
    const ids = ['legacy', 'tail'], expected = f.points(ids), read = f.preload(ids);
    expect(new Map(ids.map(id => [id, read.value!.read(id)]))).toEqual(expected);
    expect(read.value!.read('legacy')?.sphere).toBe('personal'); expect(read.sql.filter(metadataSql)).toHaveLength(1);
  });

  for (const failure of ['prepare', 'execution'] as const) it(`retains bounded reads and pins after metadata ${failure} fails`, () => {
    const f = fixture(); f.put('a'); f.put('b'); f.spheres.setItem({ collection: 'asset', id: 'b' }, 'personal');
    f.db.prepare("UPDATE data_asset SET data_blob='invalid JSON' WHERE id='b'").run();
    const ids = ['a', 'b'], expected = f.points(ids), prepare = f.db.prepare.bind(f.db); let attempted = false;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (!metadataSql(sql)) return prepare(sql);
      attempted = true; if (failure === 'prepare') throw new Error('Fixture metadata failure');
      const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementationOnce(() => { throw new Error('Fixture metadata failure'); }); return statement;
    });
    const read = f.preload(ids); expect(attempted).toBe(true);
    expect(new Map(ids.map(id => [id, read.value!.read(id)]))).toEqual(expected); expect(read.changes).toBe(0);
    expect(read.sql.filter(separateSql).length).toBeGreaterThan(0);
  });

  it('discards incomplete metadata rather than losing a pin or inventing a missing root', () => {
    const f = fixture(); f.put('a'); f.put('b'); f.spheres.setItem({ collection: 'asset', id: 'b' }, 'professional');
    f.db.prepare("UPDATE data_asset SET data_blob='invalid JSON' WHERE id='b'").run();
    const ids = ['a', 'b'], expected = f.points(ids), prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (metadataSql(sql)) { const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementationOnce((...args) => (all(...args) as Array<{ requested_id: string }>).filter(row => row.requested_id !== 'b'));
      } return statement;
    });
    const read = f.preload(ids); expect(read.sql.filter(metadataSql)).toHaveLength(1);
    expect(new Map(ids.map(id => [id, read.value!.read(id)]))).toEqual(expected); expect(read.sql.filter(separateSql).length).toBeGreaterThan(0);
  });

  for (const field of ['hasDefaultAssetProjection', 'readAssetEffective', 'readAssetsEffective'] as const) it(`keeps the separate path for a customized ${field}`, () => {
    const f = fixture(); f.put('a'); f.put('b'); const contexts: boolean[] = [];
    if (field === 'hasDefaultAssetProjection') { const guard = f.work.hasDefaultAssetProjection.bind(f.work);
      f.work.hasDefaultAssetProjection = () => { contexts.push(f.db.inTransaction); return guard(); };
    } else { const value = f.work[field]; Object.defineProperty(f.work, field, { get() { contexts.push(f.db.inTransaction); return value; } }); }
    const ids = ['a', 'b'], expected = f.points(ids), read = f.preload(ids);
    expect(new Map(ids.map(id => [id, read.value!.read(id)]))).toEqual(expected);
    expect(read.sql.filter(metadataSql)).toEqual([]); expect(read.sql.filter(separateSql).length).toBeGreaterThan(0);
    expect(contexts.length).toBeGreaterThan(0); expect(contexts.every(value => !value)).toBe(true);
  });

  it('retains the separate path for ordinary unscanned resolution', () => {
    const f = fixture(); f.put('a'); f.put('b'); const ids = ['a', 'b'], expected = f.points(ids);
    const read = f.measure(() => f.spheres.resolveAssets(ids)); expect(read.value).toEqual(expected);
    expect(read.sql.filter(metadataSql)).toEqual([]); expect(read.sql.filter(separateSql).length).toBeGreaterThan(0);
  });

  it('loads new root and source facts on each publication preload', () => {
    const f = fixture(); f.put('a'); f.put('b'); const first = f.preload(['a', 'b']);
    expect(first.value!.read('b')?.sphere).toBeUndefined();
    f.spheres.setSource('asset:b', 'professional'); f.put('a', { sphere_override: 'personal' });
    const next = f.preload(['a', 'b']); expect(next.value!.read('b')?.sphere).toBe('professional'); expect(next.value!.read('a')?.sphere).toBe('personal');
    expect(first.value!.read('b')?.sphere).toBe('professional'); expect(next.sql.filter(metadataSql)).toHaveLength(1);
  });

  for (const mode of ['asset', 'source'] as const) it(`does not keep ${mode} facts captured before a caller savepoint rollback`, () => {
    const f = fixture(); f.put('target', { sphere: 'personal' });
    if (mode === 'source') f.spheres.setSource('asset:target', 'personal');
    let batch: ReturnType<typeof f.spheres.prefetchAssetPlacements>;
    let observed: ReturnType<typeof f.spheres.resolve> | undefined;
    const ref = { collection: 'asset', id: 'target' };
    f.db.transaction(() => {
      f.put('caller-write');
      const inner = f.db.transaction(() => {
        if (mode === 'asset') f.put('target', { sphere: 'professional' });
        else f.spheres.setSource('asset:target', 'professional');
        batch = f.spheres.prefetchAssetPlacements(['target']);
        expect(f.spheres.resolve(ref).sphere).toBe('professional');
        throw new Error('Fixture savepoint rollback');
      });
      expect(inner).toThrow('Fixture savepoint rollback');
      observed = batch?.read('target') ?? f.spheres.resolve(ref);
    })();
    expect(f.work.readAsset('caller-write')).not.toBeNull();
    expect(f.spheres.resolve(ref).sphere).toBe('personal');
    expect(observed).toEqual(f.spheres.resolve(ref));
  });

  it('deduplicates stored-source keys without materializing full root rows', () => {
    const f = fixture(), ids = Array.from({ length: 200 }, (_, i) => `asset-${i}`);
    f.db.transaction(() => ids.forEach(id => f.put(id)))();
    f.spheres.setSource('work:recued.asset', 'professional'); const expected = f.points(ids);
    const prepare = f.db.prepare.bind(f.db); let query = ''; const sourceKeys: string[] = [];
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (metadataSql(sql)) query = sql;
      const statement = prepare(sql);
      if (sourceSql(sql)) { const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementationOnce((...args) => { sourceKeys.push(...args.map(String)); return all(...args); });
      } return statement;
    });
    const read = f.preload(ids); expect(new Map(ids.map(id => [id, read.value!.read(id)]))).toEqual(expected);
    expect(query).not.toBe('');
    const plan = (prepare('EXPLAIN QUERY PLAN ' + query).all(...ids) as Array<{ detail: string }>).map(row => row.detail);
    expect(plan.filter(detail => /\bSEARCH asset\b/u.test(detail))).toHaveLength(1);
    expect(plan.filter(detail => /\bSEARCH item\b/u.test(detail))).toHaveLength(1);
    expect(plan.some(detail => /MATERIALIZE publication_asset_roots/u.test(detail))).toBe(false);
    expect(sourceKeys).toHaveLength(201); expect(new Set(sourceKeys).size).toBe(201);
    expect(read.sql.filter(sourceSql)).toHaveLength(2);
  });
});
