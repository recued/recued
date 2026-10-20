import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Asset, AssetRule } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';

let db: Database.Database;
let store: WorkEntityStore;
const owner = { kind: 'owner' as const, ref: 'owner:local' };
const base = { source_id: 'recued.asset', source: owner };
const allowBattery = (asset: Asset, at: number) => store.allowAssetAutomaticUpdates({ id: asset.id, path: 'readings.battery',
  expected: { value: asset.readings.battery!, source: asset.field_sources['readings.battery']! } }, at);
const expiry = (patch: Partial<AssetRule> = {}): AssetRule => ({
  id: 'renew', title: 'Renew passport', when: { kind: 'expiry', field: 'expires_on' },
  enabled: true, muted: false, consequence: 'floor', pinned: false,
  reaction: { notify: true, occurrence: 'action', emit: true }, expiry_policy: 'escalate_overdue',
  schedule: { before: [{ amount: 6, unit: 'months' }], on_day: true, after: { amount: 1, unit: 'months' } }, ...patch,
});
beforeEach(() => { db = new Database(':memory:'); ensureWorkEntitySchema(db); store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store); });
afterEach(() => db.close());

describe('D-325 asset persistence', () => {
  it('is a real work kind, roundtrips optional identifying text, searches its name, and does not age out', () => {
    const asset = store.writeAsset({ ...base, name: 'Kestrel ring 04', document_number: '00123 / anything the owner enters',
      dates: { expires_on: null }, attributes: { story: 'A gift', value_unknown: null } }, 10);
    expect(store.readByKind('asset', asset.id)).toMatchObject({ _kind: 'asset', name: asset.name, document_number: asset.document_number });
    expect(createWorkEntityResolver(store).searchByText('asset', 'Kestrel rings', 10).map(row => row.id)).toEqual([asset.id]);
    expect(store.listByKind('asset')[0]?.id).toBe(asset.id);
    expect(store.countByKind('asset')).toBe(1);
    expect(store.listAssets({ search: 'ring' })).toHaveLength(1);
    expect(store.readAsset(asset.id)?.dates.expires_on).toBeNull();
    expect(store.readAsset(asset.id)?.field_sources).not.toHaveProperty('dates.expires_on');
  });
  it('ranks each field independently and does not overwrite the owner with an extraction', () => {
    const asset = store.writeAsset({ ...base, name: 'Passport', dates: { expires_on: '2028-02-29' } }, 10);
    const updated = store.writeAsset({ ...base, id: asset.id, source: { kind: 'extracted', ref: 'mail:renewal' },
      dates: { expires_on: '2027-01-01', issued_on: '2020-04-01' } }, 20);
    expect(updated.dates).toEqual({ expires_on: '2028-02-29', issued_on: '2020-04-01' });
    expect(updated.field_sources['dates.expires_on']).toEqual({ ...owner, at: 10 });
    expect(updated.field_sources['dates.issued_on']?.kind).toBe('extracted');
    expect(store.writeAsset({ ...base, id: asset.id, dates: { expires_on: null } }, 30).dates.expires_on).toBeNull();
  });
  it('validates the resulting rule before committing, keeps its identity on edits, and does not restore an owner-deleted rule', () => {
    const asset = store.writeAsset({ ...base, name: 'Passport', dates: { expires_on: '2028-02-29' }, rules: [expiry()] }, 10);
    expect(() => store.writeAsset({ ...base, id: asset.id, rules: [expiry({ when: { kind: 'expiry', field: 'no_such_date' } })] }, 20)).toThrow('no such date');
    expect(store.readAsset(asset.id)).toEqual(asset);
    const edited = store.writeAsset({ ...base, id: asset.id, rules: [expiry({ schedule: { before: [{ amount: 7, unit: 'months' }], on_day: true } })] }, 30);
    expect(edited.rules).toHaveLength(1); expect(edited.rules[0]).toMatchObject({ id: 'renew', pinned: true });
    store.writeAsset({ ...base, id: asset.id, rules: [] }, 40);
    expect(store.writeAsset({ ...base, id: asset.id, source: { kind: 'extracted', ref: 'preset' }, rules: [expiry()] }, 50).rules).toEqual([]);
  });
  it('never activates an extracted rule, and rejects malformed evidence and dangerous open-attribute keys', () => {
    const asset = store.writeAsset({ ...base, source: { kind: 'extracted', ref: 'mail:receipt' }, name: 'Warranty',
      dates: { expires_on: '2028-02-29' }, rules: [expiry({ pinned: true })] });
    expect(asset.rules[0]?.enabled).toBe(false);
    expect(asset.rules[0]?.pinned).toBe(false);
    expect(() => store.writeAsset({ ...base, id: asset.id, readings: { battery: { value: 5, unit: '%', as_of: 1, evidence: ['invented' as never] } } })).toThrow('evidence');
    expect(() => store.writeAsset({ ...base, id: asset.id, attributes: JSON.parse('{"__proto__":{"polluted":true}}') })).toThrow('Reserved');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('enforces one acyclic parent and derives inheritance without pinning copies', () => {
    const house = store.writeAsset({ ...base, name: 'House', sphere: 'personal', audience: 'household', anchors: [{ kind: 'place', name: 'Home' }] });
    const boiler = store.writeAsset({ ...base, name: 'Boiler', belongs_to: house.id });
    expect(store.readAsset(boiler.id)).not.toHaveProperty('sphere');
    expect(store.readAssetEffective(boiler.id)).toMatchObject({ sphere: 'personal', audience: 'household', anchors: house.anchors });
    expect(store.readAssetEffective(boiler.id, () => false)?.anchors).toEqual([]);
    expect(() => store.writeAsset({ ...base, id: house.id, belongs_to: boiler.id })).toThrow('cycle');
    store.writeAsset({ ...base, id: house.id, sphere: 'professional' });
    expect(store.readAssetEffective(boiler.id)?.sphere).toBe('professional');
    store.writeAsset({ ...base, id: boiler.id, sphere_override: 'personal' });
    expect(store.readAssetEffective(boiler.id)?.sphere).toBe('personal');
    store.writeAsset({ ...base, id: boiler.id, sphere_override: null });
    expect(store.readAssetEffective(boiler.id)?.sphere).toBe('professional');
  });
  it('keeps a durable retirement job and removes child pointers, bindings, history and index entries on delete', () => {
    const house = store.writeAsset({ ...base, name: 'House', readings: { battery: { value: 10, unit: '%', as_of: 1, evidence: [] } } });
    const child = store.writeAsset({ ...base, name: 'Part', belongs_to: house.id });
    allowBattery(house, 20);
    store.bindAssetObservations({ id: 'b1', asset_id: house.id, source_ref: 'device:light', actor_ref: 'recipe:health', fields: ['readings.battery'], enabled: true });
    store.writeAsset({ ...base, id: house.id, status: 'sold' }, 3000);
    expect(createWorkEntityStore(db).pendingAssetRetirements()).toEqual([{ asset_id: house.id, status: 'sold', created_at: 3000 }]);
    expect(store.deleteAsset(house.id, { tombstone: true, now: 4000 })).toBe(true);
    expect(store.readAsset(child.id)?.belongs_to).toBeUndefined();
    expect(store.listAssetObservationBindings(house.id)).toEqual([]);
    expect(store.assetReadingHistory(house.id, 'battery')).toEqual([]);
    expect(store.assetObservationHandoffs(house.id)).toEqual([]);
    expect(store.pendingAssetRetirements()).toEqual([]);
    expect(createWorkEntityResolver(store).searchByText('asset', 'House', 10)).toEqual([]);
  });
  it('walks beyond a recent-record page with a monotonic cursor', () => {
    for (let index = 0; index < 510; index += 1) store.writeAsset({ ...base, id: `asset-${String(index).padStart(4, '0')}`, name: `Asset ${index}` }, index);
    const ids: string[] = [];
    for (;;) { const page = store.walkByAssetId(ids.at(-1) ?? '', 100); if (!page.length) break; ids.push(...page.map(row => row.id)); }
    expect(ids).toHaveLength(510); expect(new Set(ids).size).toBe(510); expect(ids[0]).toBe('asset-0000');
  });
});

describe('D-325 source-bound observations', () => {
  const create = () => {
    const asset = store.writeAsset({ ...base, name: 'Porch light', document_number: 'private-number', readings: { battery: null }, observations: { unavailable: null } }, 1);
    store.bindAssetObservations({ id: 'b1', asset_id: asset.id, actor_ref: 'recipe:health', source_ref: 'device:porch', fields: ['readings.battery', 'observations.unavailable'], enabled: true });
    return asset;
  };
  const reading = (value: number, as_of: number) => ({ value, unit: '%', as_of, evidence: [] });
  it('keeps the manual fact and receipt across restart, retries once, and waits for a strictly later authorized sample', () => {
    const original = create(); const asset = store.writeAsset({ ...base, id: original.id, readings: { battery: reading(50, 90) } }, 100);
    const released = allowBattery(asset, 200);
    expect(released.readings).toEqual(asset.readings); expect(released.field_sources).toEqual(asset.field_sources);
    expect(released.automatic_updates).toEqual({ 'readings.battery': 200 });
    expect(allowBattery(asset, 300).automatic_updates).toEqual(released.automatic_updates);
    store = createWorkEntityStore(db);
    expect(store.readAsset(asset.id)?.automatic_updates).toEqual(released.automatic_updates);
    expect(store.assetObservationHandoffs(asset.id)).toEqual([{ id: expect.any(String), path: 'readings.battery', at: 200,
      value: reading(50, 90), source: asset.field_sources['readings.battery'] }]);
    const report = (as_of: number) => store.writeAssetObservations({ binding_id: 'b1', actor_ref: 'recipe:health', readings: { battery: reading(50, as_of) } }, 300);
    expect(report(199).changed_fields).toEqual([]); expect(report(200).changed_fields).toEqual([]);
    expect(store.readAsset(asset.id)?.field_sources['readings.battery']).toEqual(asset.field_sources['readings.battery']);
    // Even an unchanged value hands provenance back and publishes a real update.
    expect(report(201).changed_fields).toEqual(['readings.battery']);
    expect(store.readAsset(asset.id)).toMatchObject({ readings: { battery: reading(50, 201) },
      field_sources: { 'readings.battery': { kind: 'observation', ref: 'device:porch', at: 300 } } });
    expect(store.readAsset(asset.id)?.automatic_updates).toBeUndefined();
    expect(allowBattery(asset, 400).field_sources['readings.battery']?.kind).toBe('observation');
    expect(store.assetObservationHandoffs(asset.id)).toHaveLength(1);
    expect(store.assetObservationHandoffs(asset.id)[0]?.value).toEqual(reading(50, 90));
    expect(store.assetReadingHistory(asset.id, 'battery')).toContainEqual(reading(50, 90));
  });
  it('reclaims a released field with an identical manual entry and rejects the stale handoff even in one clock tick', () => {
    const original = create(); const asset = store.writeAsset({ ...base, id: original.id, readings: { battery: reading(50, 90) } }, 100);
    allowBattery(asset, 200);
    const preset = store.writeAsset({ ...base, id: asset.id, preset_application: true, readings: { battery: reading(50, 90) } }, 250);
    expect(preset.automatic_updates).toEqual({ 'readings.battery': 200 });
    expect(preset.field_sources['readings.battery']).toEqual(asset.field_sources['readings.battery']);
    const reclaimed = store.writeAsset({ ...base, id: asset.id, readings: { battery: reading(50, 90) } }, 100);
    expect(reclaimed.automatic_updates).toBeUndefined();
    expect(reclaimed.field_sources['readings.battery']?.revision).not.toBe(asset.field_sources['readings.battery']?.revision);
    expect(() => allowBattery(asset, 200)).toThrow('field changed');
    const report = () => store.writeAssetObservations({ binding_id: 'b1', actor_ref: 'recipe:health', readings: { battery: reading(30, 401) } }, 500);
    expect(report().changed_fields).toEqual([]);
    allowBattery(reclaimed, 400); expect(report().changed_fields).toEqual(['readings.battery']);
    const carried = store.writeAsset({ ...base, id: asset.id, preset_application: true, readings: { battery: reading(30, 401) } }, 600);
    expect(carried.field_sources['readings.battery']?.kind).toBe('observation');
    expect(store.assetObservationHandoffs(asset.id)).toHaveLength(2);
  });
  it('invalidates stale handoffs for repeated manual samples and clears even when the override was already pinned', () => {
    const original = create();
    const samples = { readings: { battery: reading(50, 90) }, observations: { unavailable: {
      active: true, certainty: 'confirmed' as const, source: owner.ref, as_of: 90, evidence: [] } } };
    const asset = store.writeAsset({ ...base, id: original.id, ...samples }, 100);
    const repeated = store.writeAsset({ ...base, id: asset.id, ...samples }, 100);
    const paths = ['readings.battery', 'observations.unavailable'] as const;
    const expected = (value: Asset, path: typeof paths[number]) => ({
      value: path === 'readings.battery' ? value.readings.battery! : value.observations.unavailable!, source: value.field_sources[path]! });
    for (const path of paths) {
      expect(repeated.field_sources[path]?.revision).not.toBe(asset.field_sources[path]?.revision);
      expect(() => store.allowAssetAutomaticUpdates({ id: asset.id, path, expected: expected(asset, path) }, 200)).toThrow('field changed');
    }
    const empty = { readings: { battery: null }, observations: { unavailable: null } };
    const cleared = store.writeAsset({ ...base, id: asset.id, ...empty }, 250);
    const recleared = store.writeAsset({ ...base, id: asset.id, ...empty }, 250);
    for (const path of paths) {
      expect(recleared.field_sources[path]?.revision).not.toBe(cleared.field_sources[path]?.revision);
      expect(() => store.allowAssetAutomaticUpdates({ id: asset.id, path, expected: expected(cleared, path) }, 300)).toThrow('field changed');
      store.allowAssetAutomaticUpdates({ id: asset.id, path, expected: expected(recleared, path) }, 300);
    }
    expect(store.assetObservationHandoffs(asset.id)).toHaveLength(2);
    expect(store.assetObservationHandoffs(asset.id).every(row => row.value === null)).toBe(true);
  });
  it('releases one field without allowing extraction, unbound fields, another actor or disabled writers to take over', () => {
    const original = create(); const asset = store.writeAsset({ ...base, id: original.id,
      readings: { battery: reading(50, 90), pressure: { value: 2, unit: 'bar', as_of: 90, evidence: [] } } }, 100);
    allowBattery(asset, 200);
    store.writeAsset({ ...base, id: asset.id, source: { kind: 'confirmed_document', ref: 'receipt' }, readings: { battery: reading(10, 250) } }, 250);
    expect(store.readAsset(asset.id)?.readings.battery).toEqual(reading(50, 90));
    const input = { binding_id: 'b1', actor_ref: 'recipe:health', readings: { battery: reading(30, 301) } };
    expect(() => store.writeAssetObservations({ ...input, actor_ref: 'recipe:other' }, 400)).toThrow('binding');
    expect(() => store.writeAssetObservations({ ...input, automatic_updates: { 'readings.battery': 0 } } as never, 400)).toThrow('only observations');
    expect(() => store.writeAssetObservations({ ...input, readings: { other: reading(30, 301) } }, 400)).toThrow('not bound');
    const binding = store.listAssetObservationBindings(asset.id)[0]!;
    store.bindAssetObservations({ ...binding, enabled: false }); expect(() => store.writeAssetObservations(input, 400)).toThrow('binding');
    store.bindAssetObservations({ ...binding, fields: [...binding.fields, 'readings.pressure'] });
    const result = store.writeAssetObservations({ ...input, readings: { ...input.readings, pressure: { value: 5, unit: 'bar', as_of: 301, evidence: [] } } }, 400);
    expect(result.changed_fields).toEqual(['readings.battery']); expect(result.asset.readings.pressure).toEqual(asset.readings.pressure);
    expect(result.asset.field_sources['readings.pressure']).toEqual(asset.field_sources['readings.pressure']);
  });
  it('allows a manually cleared unknown field and keeps its null receipt distinct from a measured zero', () => {
    const original = create(); store.writeAsset({ ...base, id: original.id, readings: { battery: reading(50, 90) } }, 100);
    const cleared = store.writeAsset({ ...base, id: original.id, readings: { battery: null } }, 150);
    allowBattery(cleared, 200);
    expect(store.readAsset(cleared.id)?.readings.battery).toBeNull(); expect(store.assetObservationHandoffs(cleared.id)[0]?.value).toBeNull();
    expect(store.writeAssetObservations({ binding_id: 'b1', actor_ref: 'recipe:health', readings: { battery: reading(0, 201) } }, 300).changed_fields).toEqual(['readings.battery']);
    expect(store.readAsset(cleared.id)?.readings.battery?.value).toBe(0);
  });
  it('rejects stale facts and invalid targets and moves retained handoffs with a merged asset', () => {
    const original = create(); const asset = store.writeAsset({ ...base, id: original.id, readings: { battery: reading(50, 90) } }, 100);
    const input = { id: asset.id, path: 'readings.battery', expected: { value: asset.readings.battery!, source: asset.field_sources['readings.battery']! } };
    for (const path of ['name', 'dates.expires_on', 'readings.missing', 'readings.constructor']) expect(() => store.allowAssetAutomaticUpdates({ ...input, path }, 200)).toThrow();
    expect(() => store.allowAssetAutomaticUpdates({ ...input, expected: { ...input.expected, value: reading(1, 90) } }, 200)).toThrow('field changed');
    allowBattery(asset, 200); const kept = store.writeAsset({ ...base, name: 'Kept light', readings: { battery: null } }, 300);
    store.moveAssetObservations(asset.id, kept.id);
    expect(store.assetObservationHandoffs(asset.id)).toEqual([]); expect(store.assetObservationHandoffs(kept.id)[0]?.value).toEqual(reading(50, 90));
    store.writeAsset({ ...base, id: kept.id, status: 'retired' }, 400);
    expect(() => store.allowAssetAutomaticUpdates({ ...input, id: kept.id }, 500)).toThrow('active local asset');
    store.deleteAsset(kept.id); expect(store.assetObservationHandoffs(kept.id)).toEqual([]);
  });
  it('stamps its bound provenance, writes changes only, and ignores stale observations', () => {
    const asset = create();
    const write = (value: number, as_of: number) => store.writeAssetObservations({ binding_id: 'b1', actor_ref: 'recipe:health', readings: { battery: reading(value, as_of) } }, as_of);
    expect(write(5, 100).changed_fields).toEqual(['readings.battery']);
    expect(store.readAsset(asset.id)?.field_sources['readings.battery']).toMatchObject({ kind: 'observation', ref: 'device:porch' });
    expect(write(5, 200).changed_fields).toEqual([]);
    expect(store.readAsset(asset.id)?.updated_at).toBe(100);
    expect(store.readAsset(asset.id)?.readings.battery?.as_of).toBe(200);
    expect(write(3, 150).changed_fields).toEqual([]);
    expect(write(4, 300).changed_fields).toHaveLength(1);
    expect(write(6, 250).changed_fields).toEqual([]);
    expect(() => write(3, 300)).toThrow('same as-of');
    expect(store.assetReadingHistory(asset.id, 'battery').map(row => row.value)).toEqual([4, 5, 5]);
  });
  it('cannot change arbitrary fields, target another asset, impersonate another recipe, or revive a retired asset', () => {
    const asset = create();
    const input = { binding_id: 'b1', actor_ref: 'recipe:health', readings: { battery: reading(5, 100) } };
    expect(() => store.writeAssetObservations({ ...input, status: 'active' } as never)).toThrow('only observations');
    expect(() => store.writeAssetObservations({ ...input, asset_id: 'another' } as never)).toThrow('only observations');
    expect(() => store.writeAssetObservations({ ...input, actor_ref: 'recipe:other' })).toThrow('binding');
    expect(() => store.writeAssetObservations({ ...input, readings: { odometer: reading(2, 100) } })).toThrow('not bound');
    expect(() => store.writeAssetObservations({ ...input, readings: 1 } as never)).toThrow('field map');
    expect(() => store.writeAssetObservations({ ...input, readings: { battery: { ...reading(5, 100), source: 'forged' } } } as never)).toThrow('Unexpected');
    expect(() => store.writeAssetObservations(input, 99)).toThrow('future as-of');
    store.writeAsset({ ...base, id: asset.id, readings: { battery: reading(50, 90) } }, 90);
    expect(store.writeAssetObservations(input).changed_fields).toEqual([]);
    store.writeAsset({ ...base, id: asset.id, status: 'retired' });
    expect(() => store.writeAssetObservations(input)).toThrow('closed asset');
  });
  it('returns no private asset values from the low-tier dispatcher and emits real before/after once', async () => {
    const asset = create(); const bus = createWarehouseEventBus(); const events: unknown[] = [];
    bus.subscribe('**', event => { events.push(event); });
    const dispatchers = createWorkEntityDispatchers({ store, resolver: createWorkEntityResolver(store), bus, now: () => 100 });
    const input = { binding_id: 'b1', observations: { unavailable: { active: true, certainty: 'confirmed' as const, as_of: 100, evidence: [] } } };
    const result = await dispatchers.assetObserve(input, 'recipe:health');
    expect(result).toEqual({ asset_id: asset.id, changed_fields: ['observations.unavailable'] });
    expect(JSON.stringify(result)).not.toContain('private-number');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ slug: 'asset', prev: { record: { id: asset.id, observations: { unavailable: { source: 'device:porch' } } }, prior: { observations: { unavailable: null } } } });
    await dispatchers.assetObserve(input, 'recipe:health'); expect(events).toHaveLength(1); bus.dispose();
  });
});
