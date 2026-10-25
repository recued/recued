import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assetFactRefKey, type AssetRule, type AssetFactContextRequest } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { ASSET_CONTEXT_LIMITS, createAssetFactContextReader, parseAssetFactContextRequest } from '../situations/asset-fact-context.js';
import type { SituationReadContext } from '../situations/query.js';

const disposals: Array<() => void> = []; afterEach(() => { disposals.splice(0).forEach(close => close()); });
const time = Date.parse('2026-10-23T12:00:00Z');
const grants = { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true };
const owner: SituationReadContext = { owner: true, grants };
const rule = (id: string): AssetRule => ({ id, title: `Inspect ${id}`, when: { kind: 'objective', field: 'hose_length', target: 30, unit: 'm', direction: 'rising', mode: 'condition', lead_days: 0 },
  enabled: true, muted: false, consequence: 'routine', reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true }, expiry_policy: 'escalate_overdue', pinned: true });
const fixture = () => {
  let statements: string[] | undefined;
  const db = new Database(':memory:', { verbose: sql => { if (typeof sql === 'string') statements?.push(sql); } }); ensureWorkEntitySchema(db);
  disposals.push(() => db.close()); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  work.writeAsset({ id: 'asset:one', source_id: 'recued.asset', source: { kind: 'owner', ref: 'paired-owner' }, name: 'Garden pump',
    attributes: { length: 'about 25 meters', nested: { legacy: 'kept in the canonical record' }, zero: 0, clear: false },
    readings: { hose_length: { value: 25, unit: 'm', as_of: time - 60_000, evidence: [
      { collection: 'asset', id: 'asset:one', field: 'attributes.length', value: '25 meters' },
      { collection: 'mail', id: 'mail:private', value: 'private receipt contents' },
    ] } }, rules: [rule('first_rule'), rule('second_rule')] }, time);
  const field = { kind: 'field' as const, asset_id: 'asset:one', group: 'readings' as const, field: 'hose_length' };
  const read = createAssetFactContextReader({ work, now: () => time });
  return { db, work, read, field, measure<T>(fn: () => T) { statements = []; try { const result = fn(); return { result, sql: statements }; } finally { statements = undefined; } } };
};

describe('bounded on-demand asset context', () => {
  it.each(['sold', 'lost', 'retired'] as const)('labels a %s asset while preserving its recorded relationships', status => {
    const f = fixture(); f.work.writeAsset({ id: 'asset:one', source_id: 'recued.asset', source: { kind: 'owner', ref: 'paired-owner' }, status }, time);
    const result = f.measure(() => f.read({ root: f.field }, owner));
    expect(result.result.asset.status).toBe(status);
    expect(result.result.nodes.filter(node => node.kind === 'rule').map(node => node.ref.rule_id)).toEqual(['first_rule', 'second_rule']);
    expect(result.sql.filter(sql => /^(INSERT|UPDATE|DELETE|REPLACE)/u.test(sql))).toEqual([]);
  });

  it('keeps two rules sharing a reading distinct and fetches fresh values without writing projection state', () => {
    const f = fixture(); const scan = vi.spyOn(f.work, 'listAssets');
    const first = f.measure(() => f.read({ root: f.field }, owner));
    expect(first.result.nodes.filter(node => node.kind === 'rule').map(node => node.ref.rule_id)).toEqual(['first_rule', 'second_rule']);
    expect(first.result.edges.filter(edge => edge.kind === 'uses')).toHaveLength(2);
    expect(first.sql.filter(sql => /^SELECT/u.test(sql))).toHaveLength(1);
    expect(first.sql.filter(sql => /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER)/u.test(sql))).toEqual([]); expect(scan).not.toHaveBeenCalled();
    f.work.writeAsset({ id: 'asset:one', source_id: 'recued.asset', source: { kind: 'owner', ref: 'paired-owner' },
      readings: { hose_length: { value: 26, unit: 'm', as_of: time, evidence: [] } } }, time);
    const second = f.read({ root: f.field }, owner);
    expect(second.nodes.find(node => node.kind === 'field')).toMatchObject({ value: { value: 26, unit: 'm', as_of: time } });
    expect(second.edges.filter(edge => edge.kind === 'uses')).toEqual(first.result.edges.filter(edge => edge.kind === 'uses'));
  });

  it('explains a rule using its typed input and distinguishes an unknown from zero or false', () => {
    const f = fixture();
    expect(f.read({ root: { kind: 'rule', asset_id: 'asset:one', rule_id: 'first_rule' } }, owner).nodes[0]).toMatchObject({ kind: 'rule', title: 'Inspect first_rule' });
    for (const [field, value] of [['zero', 0], ['clear', false]] as const) expect(f.read({ root: { kind: 'field', asset_id: 'asset:one', group: 'attributes', field } }, owner).nodes[0]).toMatchObject({ known: true, value });
    f.work.writeAsset({ id: 'asset:one', source_id: 'recued.asset', source: { kind: 'owner', ref: 'paired-owner' }, readings: { hose_length: null } }, time);
    const unknown = f.read({ root: f.field }, owner);
    expect(unknown.missing).toEqual([f.field]); expect(unknown.nodes[0]).toMatchObject({ value: null, known: false });
  });

  it('does not interpret text or legacy objects as a typed measurement', () => {
    const f = fixture();
    const text = f.read({ root: { kind: 'field', asset_id: 'asset:one', group: 'attributes', field: 'length' } }, owner);
    expect(text.nodes[0]).toMatchObject({ kind: 'field', value: 'about 25 meters' }); expect(text.edges).toEqual([]);
    const legacy = f.read({ root: { kind: 'field', asset_id: 'asset:one', group: 'attributes', field: 'nested' } }, owner);
    expect(legacy.nodes[0]).toMatchObject({ known: true, value_omitted: true }); expect(legacy.omitted).toContain('unsupported_value');
  });

  it('refuses denied assets before reading them and does not return denied evidence values or writer identities', () => {
    const f = fixture(); const point = vi.spyOn(f.work, 'readAsset');
    const denied: SituationReadContext = { owner: false, grants: { ...grants, isCollectionReadGranted: () => false }, all_spheres: true };
    expect(() => f.read({ root: f.field }, denied)).toThrow('permissions'); expect(point).not.toHaveBeenCalled();
    const writers = vi.fn(() => [{ id: 'private-writer', name: 'private recipe', fields: ['readings.hose_length'], enabled: true }]);
    const read = createAssetFactContextReader({ work: f.work, writers });
    const scoped = read({ root: f.field }, { owner: false, all_spheres: true, grants: { ...grants, isCollectionReadGranted: collection => collection === 'asset' } });
    expect(JSON.stringify(scoped)).not.toContain('private receipt'); expect(JSON.stringify(scoped)).not.toContain('private-writer'); expect(JSON.stringify(scoped)).not.toContain('mail:private');
    expect(scoped.nodes[0]).toMatchObject({ source: null, source_restricted: true }); expect(writers).not.toHaveBeenCalled(); expect(scoped.completeness).toBe('partial');
  });

  it('applies current spheres to both the root and evidence and reports the same restriction regardless of hidden data', () => {
    const f = fixture(); const scoped: SituationReadContext = { owner: false, grants, spheres: ['personal'], referenceSphere: ref => ref.collection === 'asset' ? 'personal' : 'professional' };
    const packet = f.read({ root: f.field }, scoped);
    expect(packet.nodes.filter(node => node.kind === 'evidence')).toHaveLength(1); expect(packet.omitted).toEqual(['restricted_context']);
    expect(() => f.read({ root: f.field }, { ...scoped, spheres: ['professional'] })).toThrow('permissions');
    expect(() => f.read({ root: f.field }, { owner: false, grants })).toThrow('permissions');
  });

  it('caps the actual UTF-8 packet, requests only a bounded writer page, and returns no dangling edges', () => {
    const f = fixture(); f.work.writeAsset({ id: 'asset:one', source_id: 'recued.asset', source: { kind: 'owner', ref: 'paired-owner' },
      rules: Array.from({ length: 50 }, (_, i) => ({ ...rule(`rule_${i}`), title: `点検 ${i} ${'測'.repeat(100)}` })) }, time);
    const writers = vi.fn((_id: string, _fields: readonly string[], limit: number) => Array.from({ length: limit }, (_, i) => ({ id: `writer-${i}`, name: `Writer ${i}`, fields: ['readings.hose_length'], enabled: true })));
    const packet = createAssetFactContextReader({ work: f.work, writers })({ root: f.field }, owner);
    expect(Buffer.byteLength(JSON.stringify(packet), 'utf8')).toBeLessThanOrEqual(ASSET_CONTEXT_LIMITS.bytes);
    expect(packet.nodes.length).toBeLessThanOrEqual(ASSET_CONTEXT_LIMITS.nodes); expect(packet.edges.length).toBeLessThanOrEqual(ASSET_CONTEXT_LIMITS.edges); expect(packet.completeness).toBe('partial');
    const keys = new Set(packet.nodes.map(node => assetFactRefKey(node.ref)));
    expect(packet.edges.every(edge => keys.has(assetFactRefKey(edge.from)) && keys.has(assetFactRefKey(edge.to)))).toBe(true);
    expect(writers.mock.calls[0]?.[2]).toBeLessThanOrEqual(ASSET_CONTEXT_LIMITS.nodes + 1);
  });

  it('marks an oversized known value as omitted, never as an unknown or an empty relationship result', () => {
    const f = fixture(); f.work.writeAsset({ id: 'asset:one', source_id: 'recued.asset', source: { kind: 'owner', ref: 'paired-owner' }, attributes: { length: '測'.repeat(3000) } }, time);
    const packet = f.read({ root: { kind: 'field', asset_id: 'asset:one', group: 'attributes', field: 'length' } }, owner);
    expect(packet.nodes[0]).toMatchObject({ known: true, value_omitted: true }); expect(packet.missing).toEqual([]); expect(packet.completeness).toBe('partial');
    expect(Buffer.byteLength(JSON.stringify(packet), 'utf8')).toBeLessThanOrEqual(ASSET_CONTEXT_LIMITS.bytes);
  });

  it('rejects stale/deleted roots, malformed references, and cancellation without returning a false empty view', () => {
    const f = fixture(); const aborted = new AbortController(); aborted.abort();
    expect(() => f.read({ root: f.field }, { ...owner, signal: aborted.signal })).toThrow('cancelled');
    expect(() => f.read({ root: { kind: 'rule', asset_id: 'asset:one', rule_id: 'gone' } }, owner)).toThrow('not found');
    for (const root of [{ ...f.field, field: 'constructor' }, { ...f.field, group: 'rules' }, { kind: 'field', asset_id: 'asset:one', group: 'attributes', field: 'document_details' }])
      expect(() => parseAssetFactContextRequest({ root } as AssetFactContextRequest)).toThrow();
    f.work.deleteAsset('asset:one', { tombstone: true }); expect(() => f.read({ root: f.field }, owner)).toThrow('not available');
  });

  it('marks a future observation and an unavailable source instead of implying current knowledge', () => {
    const f = fixture(); f.work.writeAsset({ id: 'asset:one', source_id: 'recued.asset', source: { kind: 'owner', ref: 'paired-owner' },
      readings: { hose_length: { value: 27, unit: 'm', as_of: time + 60_000, evidence: [] } } }, time);
    const future = f.read({ root: f.field }, owner); expect(future.nodes[0]).toMatchObject({ known: true, future: true }); expect(future.missing).toEqual([f.field]);
    f.db.prepare("UPDATE data_asset SET sync_state='stale_unreachable' WHERE id=?").run('asset:one');
    const stale = f.read({ root: f.field }, owner); expect(stale.asset.source_state).toBe('stale_unreachable'); expect(stale.completeness).toBe('partial'); expect(stale.omitted).toContain('source_unavailable');
  });
});
