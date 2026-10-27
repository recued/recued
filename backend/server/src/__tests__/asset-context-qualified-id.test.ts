import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qualifyWorkEntityId, type AssetFactContextRequest, type AssetRule } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createAssetFactContextReader, ASSET_CONTEXT_LIMITS } from '../situations/asset-fact-context.js';
import { situationSourceCitations } from '../chat-situation-source-citations.js';
import { situationModelProjection } from '../situations/model-projection.js';
import type { SituationReadContext } from '../situations/query.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const ID = 'asset:one';
const grants = { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true };
const owner: SituationReadContext = { owner: true, grants };
const disposals: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); disposals.splice(0).forEach(close => close()); });
const qualify = (source_id = 'recued.asset', local_id = ID, source_record_id?: string) =>
  qualifyWorkEntityId({ kind: 'asset', source_id, local_id, ...(source_record_id ? { source_record_id } : {}) });
const rule: AssetRule = { id: 'check_length', title: 'Check length', when: { kind: 'objective', field: 'length', target: 30, unit: 'm', direction: 'rising', mode: 'usage', lead_days: 0 },
  enabled: true, muted: false, consequence: 'routine', reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true }, expiry_policy: 'strict_expire', pinned: true };
const fixture = () => {
  let statements: string[] | undefined;
  const db = new Database(':memory:', { verbose: text => { if (typeof text === 'string') statements?.push(text); } });
  disposals.push(() => db.close()); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const write = (id = ID, source_id = 'recued.asset', source_record_id?: string) => work.writeAsset({ id, source_id, ...(source_record_id ? { source_record_id } : {}),
    source: { kind: 'owner', ref: 'owner' }, name: 'Qualified context hose', attributes: { length: 'about 25 meters', zero: 0, clear: false },
    readings: { length: { value: 25, unit: 'm', as_of: 1609459200000, evidence: [{ collection: 'asset', id, field: 'attributes.length', value: 'about 25 meters' }] } }, rules: [rule] }, NOW);
  write();
  const field = { kind: 'field' as const, asset_id: ID, group: 'readings' as const, field: 'length' };
  const read = createAssetFactContextReader({ work, now: () => NOW, snapshot: run => db.transaction(run)() });
  const vendor = (id = 'vendor.asset') => work.registerSource({ ...work.getSource('recued.asset')!, id, source_kind: 'connection', source_label: id, write_capable: false });
  const packet = (asset_id: string, context = owner) => read({ root: { ...field, asset_id } }, context);
  const cite = (asset_id: string) => { const value = packet(asset_id); const result = { clusters: [], omitted: 0, ambiguous: [], fact_context: value };
    return situationSourceCitations(result, situationModelProjection(result)).source_citations; };
  return { db, work, read, field, packet, write, vendor, cite, measure<T>(run: () => T) {
    statements = []; try { const value = run(); return { value, sql: statements }; } finally { statements = undefined; }
  } };
};

describe('qualified asset identity in retained fact context', () => {
  it('returns the raw-id field and rule graphs with canonical references and identical native source versions', () => {
    const f = fixture(); const qualified = qualify();
    expect(f.packet(qualified)).toEqual(f.packet(ID));
    const rawRule: AssetFactContextRequest = { root: { kind: 'rule', asset_id: ID, rule_id: rule.id } };
    expect(f.read({ root: { ...rawRule.root, asset_id: qualified } }, owner)).toEqual(f.read(rawRule, owner));
    expect(f.cite(qualified)).toEqual(f.cite(ID));
    expect(JSON.stringify(f.packet(qualified))).not.toContain('we1:');
  });

  it('uses canonical segment decoding for non-ASCII and delimiter-bearing ids', () => {
    const f = fixture(); const id = 'asset:東京/one%25'; f.write(id);
    expect(f.packet(qualify('recued.asset', id)).root.asset_id).toBe(id);
  });

  it('does not fall back from an absent source-record identity to a colliding local id, or return deleted rows', () => {
    const f = fixture(); const point = vi.spyOn(f.work, 'readAsset');
    expect(() => f.packet(qualify('recued.asset', 'ignored', ID))).toThrow('not available');
    expect(point).not.toHaveBeenCalled();
    f.write(ID, 'recued.asset', 'deleted-record');
    f.db.prepare('UPDATE data_asset SET deleted_at=? WHERE id=?').run(NOW, ID);
    for (const id of [qualify(), qualify('recued.asset', 'ignored', 'deleted-record')])
      expect(() => f.packet(id)).toThrow('not available');
  });

  it('resolves source-record identities without confusing remote and local ids or widening vendor provenance', () => {
    const f = fixture(); f.vendor(); f.write('mirror:one', 'vendor.asset', ID);
    const qualified = qualify('vendor.asset', 'ignored-local-id', ID);
    expect(f.packet(qualified)).toEqual(f.packet('mirror:one'));
    expect(f.packet(qualify('vendor.asset', 'mirror:one')).root.asset_id).toBe('mirror:one');
    expect(f.cite(qualified)).toBeUndefined();
    expect(() => f.packet(qualify('vendor.asset', ID))).toThrow('does not match');
    expect(() => f.packet(qualify('recued.asset', 'mirror:one'))).toThrow('does not match');
    f.write('native:source', 'recued.asset', 'record:東京%/one');
    expect(f.packet(qualify('recued.asset', 'ignored', 'record:東京%/one')).root.asset_id).toBe('native:source');
  });

  it.each([
    'we1:asset:recued.asset:local:', 'we1:asset:recued.asset:local:asset:one',
    'we1:asset:recued.asset:local:%61sset%3Aone', 'we1:asset:recued.asset:source:%zz',
    'we1:asset:recued.asset:guess:asset%3Aone',
    qualifyWorkEntityId({ kind: 'task', source_id: 'recued.asset', local_id: ID }),
  ])('rejects malformed or wrong-kind identity without a value lookup: %s', value => {
    const f = fixture(); const point = vi.spyOn(f.work, 'readAsset'); const metadata = vi.spyOn(f.work, 'getSource');
    expect(() => f.packet(value)).toThrow(); expect(point).not.toHaveBeenCalled(); expect(metadata).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'wrong-kind', 'read-through'] as const)('rejects a %s source without reading a colliding local row', kind => {
    const f = fixture();
    if (kind !== 'unknown') f.work.registerSource({ ...f.work.getSource('recued.asset')!, id: kind,
      ...(kind === 'wrong-kind' ? { top_tier_kind: 'task' as const } : { sync_posture: 'read_through' as const }) });
    const point = vi.spyOn(f.work, 'readAsset');
    expect(() => f.packet(qualify(kind))).toThrow('source is not available'); expect(point).not.toHaveBeenCalled();
  });

  it.each(['verb', 'collection'] as const)('checks the %s grant before all identity metadata and content lookups', key => {
    const f = fixture(); const source = vi.spyOn(f.work, 'getSource'); const identity = vi.spyOn(f.work, 'localIdBySourceIdentity'); const point = vi.spyOn(f.work, 'readAsset');
    const context = { ...owner, grants: { ...grants, ...(key === 'verb' ? { isVerbOpGranted: () => false } : { isCollectionReadGranted: () => false }) } };
    expect(() => f.packet(qualify(), context)).toThrow('permissions'); expect(source).not.toHaveBeenCalled(); expect(identity).not.toHaveBeenCalled(); expect(point).not.toHaveBeenCalled();
  });

  it.each(['local', 'source'] as const)('fences the canonical local id before loading a %s qualified row', kind => {
    const f = fixture(); f.write(ID, 'recued.asset', 'remote:one');
    const point = vi.spyOn(f.work, 'readAsset'); const broad = vi.spyOn(f.work, 'readBySourceIdentity');
    const sphere = vi.fn((ref: { id: string }) => ref.id === ID ? 'professional' as const : 'personal' as const);
    const context: SituationReadContext = { owner: false, grants, spheres: ['personal'], referenceSphere: sphere };
    expect(() => f.packet(qualify('recued.asset', ID, kind === 'source' ? 'remote:one' : undefined), context)).toThrow('permissions');
    expect(point).not.toHaveBeenCalled(); expect(broad).not.toHaveBeenCalled();
    expect(sphere.mock.calls.every(([ref]) => ref.id === ID)).toBe(true);
    expect(f.packet(qualify(), { ...context, spheres: ['professional'] }).root.asset_id).toBe(ID);
  });

  it('rechecks current grants and canonical spheres after relationships are read', () => {
    const f = fixture(); let allowed = true;
    const context: SituationReadContext = { owner: true, grants: { ...grants, isCollectionReadGranted: () => allowed } };
    const read = createAssetFactContextReader({ work: f.work, writers: () => { allowed = false; return []; } });
    expect(() => read({ root: { ...f.field, asset_id: qualify() } }, context)).toThrow('permissions changed');
    let personal = true;
    const scoped: SituationReadContext = { owner: false, grants, spheres: ['personal'], referenceSphere: () => personal ? 'personal' : 'professional' };
    const point = f.work.readAsset.bind(f.work); vi.spyOn(f.work, 'readAsset').mockImplementation(id => { const asset = point(id); personal = false; return asset; });
    expect(() => f.packet(qualify(), scoped)).toThrow('permissions changed');
  });

  it('rejects a changed or misrouted mapping instead of trusting the resolved suffix', () => {
    const f = fixture(); f.write(ID, 'recued.asset', 'remote:one');
    const resolve = f.work.localIdBySourceIdentity.bind(f.work);
    vi.spyOn(f.work, 'localIdBySourceIdentity').mockImplementation((...args) => {
      const id = resolve(...args); f.db.prepare('UPDATE data_asset SET source_record_id=? WHERE id=?').run('changed', ID); return id;
    });
    expect(() => f.packet(qualify('recued.asset', ID, 'remote:one'))).toThrow('does not match');
    f.write('other'); const point = f.work.readAsset.bind(f.work); vi.spyOn(f.work, 'readAsset').mockImplementation(() => point('other'));
    expect(() => f.packet(qualify())).toThrow('does not match');
  });

  it('keeps unknown, zero, false and known-but-omitted semantics on the canonical field', () => {
    const f = fixture(); f.work.writeAsset({ id: ID, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, attributes: { memo: '錄'.repeat(2800) } }, NOW);
    for (const [field, value] of [['zero', 0], ['clear', false]] as const)
      expect(f.read({ root: { kind: 'field', asset_id: qualify(), group: 'attributes', field } }, owner).nodes[0]).toMatchObject({ known: true, value });
    const value = f.read({ root: { kind: 'field', asset_id: qualify(), group: 'attributes', field: 'memo' } }, owner);
    expect(value.nodes[0]).toMatchObject({ known: true, value: null, value_omitted: true }); expect(value.missing).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(ASSET_CONTEXT_LIMITS.bytes);
    const result = { clusters: [], omitted: 0, ambiguous: [], fact_context: value };
    expect(situationSourceCitations(result, situationModelProjection(result)).source_citations?.some(source => source.kind === 'asset_projection' && source.projection.kind === 'field')).toBe(false);
  });

  it.each(['orphaned', 'tombstoned'] as const)('refuses a %s row and cancelled reads', state => {
    const f = fixture(); f.db.prepare('UPDATE data_asset SET sync_state=? WHERE id=?').run(state, ID);
    expect(() => f.packet(qualify())).toThrow('not available');
    const controller = new AbortController(); controller.abort();
    expect(() => f.packet(qualify(), { ...owner, signal: controller.signal })).toThrow('cancelled');
  });

  it('keeps the raw path at one SELECT and bounds qualified metadata reads without writes or scans', () => {
    const f = fixture(); f.write(ID, 'recued.asset', 'remote:one'); const list = vi.spyOn(f.work, 'listAssets');
    for (const [id, selects] of [[ID, 1], [qualify(), 2], [qualify('recued.asset', ID, 'remote:one'), 3]] as const) {
      const result = f.measure(() => f.packet(id)); expect(result.sql.filter(sql => /^SELECT/u.test(sql))).toHaveLength(selects);
      expect(result.sql.filter(sql => /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER)/u.test(sql))).toEqual([]);
    }
    const resolved = f.measure(() => f.work.readBySourceIdentity('asset', 'recued.asset', 'remote:one'));
    expect(resolved.value?.id).toBe(ID); expect(resolved.sql.filter(sql => /^SELECT/u.test(sql))).toHaveLength(2); expect(list).not.toHaveBeenCalled();
  });
});
