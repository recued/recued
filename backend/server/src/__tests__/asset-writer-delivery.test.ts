import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetFactContext, AssetWriterDelivery } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { assetContextWriters, createAssetFactContextReader } from '../situations/asset-fact-context.js';
import { situationSourceCitations } from '../chat-situation-source-citations.js';
import { situationModelProjection } from '../situations/model-projection.js';

const NOW = Date.parse('2026-10-26T12:00:00Z'); const ID = 'writer_asset';
const close: Array<() => void> = []; afterEach(() => close.splice(0).forEach(fn => fn()));
const fixture = () => {
  const db = new Database(':memory:'); close.push(() => db.close()); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const create = (id: string) => work.writeAsset({ id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Delivery hose',
    readings: { length: { value: 25, unit: 'm', as_of: NOW - 10000, evidence: [] }, battery: { value: 50, unit: '%', as_of: NOW - 10000, evidence: [] } } }, NOW);
  create(ID); const binding = { id: 'native_binding', asset_id: ID, actor_ref: 'recipe:writer', source_ref: 'private_source', enabled: true, fields: ['readings.length','readings.battery'] };
  work.bindAssetObservations(binding);
  const request = { root: { kind: 'field' as const, asset_id: ID, group: 'readings' as const, field: 'length' } };
  const read = createAssetFactContextReader({ work, writers: assetContextWriters(db, () => 'Installed writer'), now: () => NOW + 1000, snapshot: fn => db.transaction(fn)() });
  const context = (asset_id = ID, field = 'length'): AssetFactContext => read({ root: { ...request.root, asset_id, field } }, { owner: true, all_spheres: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } });
  const delivery = (asset_id = ID, field = 'length'): AssetWriterDelivery | undefined => context(asset_id, field).nodes.find(n => n.kind === 'writer')?.delivery;
  const submit = (value: number, as_of: number, at: number) => work.writeAssetObservations({ binding_id: binding.id, actor_ref: binding.actor_ref, readings: { length: { value, unit: 'm', as_of, evidence: [] } } }, at, `private_run_${at}`);
  const allow = (at: number) => { const asset = work.readAsset(ID)!; work.allowAssetAutomaticUpdates({ id: ID, path: 'readings.length', expected: { value: asset.readings.length!, source: asset.field_sources['readings.length']! } }, at); };
  const versions = () => { const native = { clusters: [], omitted: 0, ambiguous: [], fact_context: context() }; const citations = situationSourceCitations(native, situationModelProjection(native)).source_citations!;
    return Object.fromEntries(citations.filter(c => c.kind === 'asset_projection').map(c => [c.projection.kind,c.read_version])); };
  return { db, work, binding, create, context, delivery, submit, allow, versions };
};

describe('settled native writer submissions', () => {
  it('upgrades an existing vault without inventing receipts from old observation or save timestamps', () => {
    const f = fixture(); const asset = f.work.readAsset(ID); const bindings = f.work.listAssetObservationBindings(ID);
    f.db.exec('DROP TABLE asset_observation_delivery'); ensureWorkEntitySchema(f.db); ensureWorkEntitySchema(f.db);
    expect(f.work.readAsset(ID)).toEqual(asset); expect(f.work.listAssetObservationBindings(ID)).toEqual(bindings);
    expect(f.delivery()).toEqual({ status: 'no_receipt' });
  });

  it('versions an admitted but blocked submission independently of the unchanged field, without exposing private execution locators', () => {
    const f = fixture(); expect(f.delivery()).toEqual({ status: 'no_receipt' }); const before = f.work.readAsset(ID); const versions = f.versions();
    expect(f.submit(26, NOW + 1, NOW + 2).changed_fields).toEqual([]); expect(f.work.readAsset(ID)).toEqual(before);
    expect(f.delivery()).toEqual({ status: 'recorded', last_submission: { at: NOW + 2, observation_at: NOW + 1, outcome: 'manual_priority' } });
    const next = f.versions(); expect(next.field).toBe(versions.field); expect(next.context).not.toBe(versions.context);
    expect(JSON.stringify(f.context())).not.toContain('private_run');
    expect(f.delivery(ID, 'battery')).toEqual({ status: 'no_receipt' });
    expect(f.db.prepare('SELECT run_id FROM asset_observation_delivery').get()).toEqual({ run_id: `private_run_${NOW + 2}` });
    expect(f.context().nodes.filter(n => n.kind === 'writer')).toHaveLength(1);
  });

  it('keeps settled, accepted and observation clocks distinct across handoff, duplicate, stale, confirmation and renewed owner priority', () => {
    const f = fixture(); f.allow(NOW + 10);
    f.submit(26, NOW + 10, NOW + 11); expect(f.delivery()).toMatchObject({ last_submission: { outcome: 'before_handoff' } });
    f.submit(26, NOW + 12, NOW + 13); const accepted = { at: NOW + 13, observation_at: NOW + 12 };
    expect(f.delivery()).toMatchObject({ last_submission: { outcome: 'accepted' }, last_accepted: accepted });
    f.submit(30, NOW + 11, NOW + 14); expect(f.delivery()).toMatchObject({ last_submission: { outcome: 'older_observation' }, last_accepted: accepted });
    f.submit(26, NOW + 12, NOW + 15); expect(f.delivery()).toMatchObject({ last_submission: { outcome: 'unchanged' }, last_accepted: accepted });
    const semanticAt = f.work.readAsset(ID)!.updated_at; f.submit(26, NOW + 16, NOW + 17);
    expect(f.work.readAsset(ID)!.updated_at).toBe(semanticAt); expect(f.delivery()).toMatchObject({ last_submission: { outcome: 'confirmed' }, last_accepted: { at: NOW + 17, observation_at: NOW + 16 } });
    f.work.writeAsset({ id: ID, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, readings: { length: { value: 31, unit: 'm', as_of: NOW + 18, evidence: [] } } }, NOW + 19);
    f.submit(32, NOW + 20, NOW + 21); expect(f.work.readAsset(ID)!.readings.length!.value).toBe(31);
    expect(f.delivery()).toMatchObject({ last_submission: { outcome: 'manual_priority' }, last_accepted: { at: NOW + 17, observation_at: NOW + 16 } });
  });

  it('rolls back receipts and canonical values together, and never records rejected authority as an admitted delivery', () => {
    const f = fixture(); f.allow(NOW + 1); const before = f.work.readAsset(ID);
    expect(() => f.work.writeAssetObservations({ binding_id: f.binding.id, actor_ref: f.binding.actor_ref, readings: { length: { value: 26, unit: 'm', as_of: NOW + 2, evidence: [] }, nope: { value: 1, unit: 'm', as_of: NOW + 2, evidence: [] } } }, NOW + 3)).toThrow(/not bound/);
    expect(f.work.readAsset(ID)).toEqual(before); expect(f.delivery()).toEqual({ status: 'no_receipt' });
    f.db.exec("CREATE TRIGGER refuse_receipt BEFORE INSERT ON asset_observation_delivery BEGIN SELECT RAISE(ABORT,'receipt failed'); END");
    expect(() => f.submit(26,NOW + 2,NOW + 3)).toThrow('receipt failed'); expect(f.work.readAsset(ID)).toEqual(before); expect(f.delivery()).toEqual({ status: 'no_receipt' });
    expect(f.work.assetReadingHistory(ID,'length')).toHaveLength(1); f.db.exec('DROP TRIGGER refuse_receipt');
    f.submit(26,NOW + 2,NOW + 3); const receipt = f.db.prepare('SELECT * FROM asset_observation_delivery').all();
    expect(() => f.work.writeAssetObservations({ binding_id: f.binding.id, actor_ref: 'recipe:other' },NOW + 4)).toThrow(/No enabled/);
    f.work.bindAssetObservations({ ...f.binding,enabled: false }); expect(() => f.submit(27,NOW + 4,NOW + 5)).toThrow(/No enabled/);
    expect(f.db.prepare('SELECT * FROM asset_observation_delivery').all()).toEqual(receipt); expect(f.context().nodes.some(n => n.kind === 'writer')).toBe(false);
  });

  it('moves receipts with their binding, removes merge losers and purges receipts with an asset', () => {
    const f = fixture(); f.submit(26,NOW + 1,NOW + 2); f.create('other_asset');
    f.work.moveAssetObservations(ID,'other_asset'); expect(f.delivery('other_asset')).toMatchObject({ status: 'recorded' }); expect(f.delivery()).toBeUndefined();
    f.work.deleteAsset('other_asset'); expect(f.db.prepare('SELECT COUNT(*) AS n FROM asset_observation_delivery').get()).toEqual({ n: 0 });
    f.create('kept');f.create('duplicate');
    const binding = { ...f.binding,asset_id:'duplicate' };f.work.bindAssetObservations(binding);
    f.work.writeAssetObservations({ binding_id: binding.id,actor_ref: binding.actor_ref,readings: { length: { value: 30,unit: 'm',as_of: NOW + 3,evidence: [] } } },NOW + 4);
    f.work.bindAssetObservations({ ...binding,id:'kept_binding',asset_id:'kept' });f.work.moveAssetObservations('duplicate','kept');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM asset_observation_delivery').get()).toEqual({ n: 0 });expect(f.delivery('kept')).toEqual({ status:'no_receipt' });
  });
});
