import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssetRule, AssetRuleWhen, SituationWindow } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createAssetClockStore } from '../storage/asset-clock-store.js';
import { buildSituationSources } from '../situations/sources.js';
import { situationDue } from '../situations/query.js';
import { createReminderStore } from '../storage/reminder-store.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-17T12:00Z');
let db: Database.Database; let work: WorkEntityStore; let time: number;
beforeEach(() => { db = new Database(':memory:'); ensureWorkEntitySchema(db); work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work); time = T0; });
afterEach(() => db.close());
const rule = (id: string, when: AssetRuleWhen, extra: Partial<AssetRule> = {}): AssetRule => ({ id, title: id, enabled: true, muted: false, pinned: false,
  consequence: 'routine', expiry_policy: 'strict_expire', when, reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true }, ...extra });
const put = (input: Omit<Parameters<WorkEntityStore['writeAsset']>[0], 'source_id' | 'source'>) =>
  work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, ...input }, time);
const dispatchers = () => createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => time });
const service = (zone = 'UTC') => createAssetOccurrenceService({ db, work, dispatchers: dispatchers(), now: () => time, timeZone: () => zone });
const state = (id: string) => db.prepare('SELECT dirty,zone,evaluated_at FROM asset_clock_state WHERE asset_id=?').get(id) as { dirty: number; zone: string | null; evaluated_at: number | null } | undefined;
/** What the live asset source would select by time, through the query's own selector. */
const dueAssets = async (window: SituationWindow, commitments: boolean, zone = 'UTC'): Promise<string[]> => {
  const source = buildSituationSources({ db, work, reminders: createReminderStore(db), calendars: () => [], now: () => time, timeZone: () => zone })
    .find(item => item.collection === 'asset')!;
  const facts = await source.read({ time: window, surface: 'tool' }, undefined, { owner: true,
    grants: { isVerbOpGranted: () => true, isCollectionReadGranted: collection => commitments || collection !== 'commitment', isTopicReadGranted: () => true } });
  return [...new Set(facts.filter(fact => situationDue(fact, window)).map(fact => fact.ref.id))].sort();
};

describe('D-325 §6.3 stored asset act-by index', () => {
  it('marks an asset dirty on every write until it is evaluated, and forgets one no read can walk', async () => {
    const before = put({ name: 'Written before the index', dates: {}, rules: [] });
    const clocks = createAssetClockStore(db);
    expect(state(before.id)).toMatchObject({ dirty: 1 });
    const occurrences = service();
    const asset = put({ name: 'Passport', dates: { expires_on: '2027-05-05' }, rules: [rule('renew', { kind: 'expiry', field: 'expires_on' })] });
    expect(state(asset.id)).toMatchObject({ dirty: 1, zone: null });
    await occurrences.reconcileAsset(asset.id);
    expect(state(asset.id)).toEqual({ dirty: 0, zone: 'UTC', evaluated_at: T0 });
    expect(clocks.rows(asset.id)).toEqual([{ rule_id: 'renew', title: 'renew', cycle: '2027-05-05', act_by_at: Date.parse('2027-05-05'), lapses_at: null, when_from: null, when_to: null }]);
    // An update through the upsert path, and a reading saved on its own.
    work.writeAsset({ id: asset.id, source_id: asset.source_id, source: { kind: 'owner', ref: 'owner' }, name: 'Passport (Ana)' }, time);
    expect(state(asset.id)?.dirty).toBe(1);
    await occurrences.reconcileAsset(asset.id);
    db.prepare('INSERT INTO asset_reading_history(asset_id,field,as_of,value) VALUES(?,?,?,?)').run(asset.id, 'odometer', T0, '{}');
    expect(state(asset.id)?.dirty).toBe(1);
    await occurrences.reconcileAsset(asset.id);
    work.deleteAsset(asset.id, { tombstone: true, now: time });
    expect(state(asset.id)).toBeUndefined(); expect(clocks.rows(asset.id)).toEqual([]);
    await occurrences.reconcileAsset(asset.id);
    expect(state(asset.id)).toBeUndefined();
    const other = put({ name: 'Bike', dates: { expires_on: '2027-01-01' }, rules: [rule('renew', { kind: 'expiry', field: 'expires_on' })] });
    await occurrences.reconcileAsset(other.id);
    work.deleteAsset(other.id, { now: time });
    expect(state(other.id)).toBeUndefined(); expect(clocks.rows(other.id)).toEqual([]);
  });

  it('rewrites nothing when an evaluation changes nothing, and treats rows from another zone as unevaluated', async () => {
    const clocks = createAssetClockStore(db);
    const asset = put({ name: 'Deed', dates: { expires_on: '2029-01-01' }, rules: [rule('renew', { kind: 'expiry', field: 'expires_on' })] });
    await service().tick();
    time = T0 + DAY; await service().tick();
    expect(state(asset.id)).toEqual({ dirty: 0, zone: 'UTC', evaluated_at: T0 });
    const near = { from: time, to: time + 14 * DAY, now: time };
    expect(clocks.candidates({ ...near, zone: 'UTC' })).toEqual([]);
    expect(clocks.candidates({ ...near, zone: 'Europe/London' })).toEqual([asset.id]);
    await service('Europe/London').tick();
    expect(clocks.candidates({ ...near, zone: 'Europe/London' })).toEqual([]);
    // Written after the last evaluation: no rows yet, so it is read regardless.
    const fresh = put({ name: 'Visa', dates: { expires_on: '2026-10-20' }, rules: [rule('renew', { kind: 'expiry', field: 'expires_on' })] });
    expect(clocks.rows(fresh.id)).toEqual([]);
    expect(clocks.candidates({ ...near, zone: 'Europe/London' })).toEqual([fresh.id]);
    // Evaluated, then moved near without a reconcile: its stored row is stale.
    work.writeAsset({ id: asset.id, source_id: asset.source_id, source: { kind: 'owner', ref: 'owner' }, dates: { expires_on: '2026-10-25' } }, time);
    expect(clocks.rows(asset.id)[0]?.act_by_at).toBe(Date.parse('2029-01-01'));
    expect(clocks.candidates({ ...near, zone: 'Europe/London' }).sort()).toEqual([asset.id, fresh.id].sort());
  });

  it('keeps every asset the live source finds due among its candidates, as time passes and in either view', async () => {
    const clocks = createAssetClockStore(db);
    const ids: Record<string, string> = {};
    const add = (name: string, input: Omit<Parameters<WorkEntityStore['writeAsset']>[0], 'source_id' | 'source' | 'name'>) => { ids[name] = put({ name, ...input }).id; };
    add('passport', { dates: { expires_on: '2027-05-05' }, rules: [rule('renew', { kind: 'expiry', field: 'expires_on' }, { schedule: { before: [{ amount: 6, unit: 'months' }], on_day: true } })] });
    add('deed', { dates: { expires_on: '2029-01-01' }, rules: [rule('renew', { kind: 'expiry', field: 'expires_on' })] });
    add('boiler', { dates: { serviced_on: '2025-11-20' }, rules: [rule('service', { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } },
      { schedule: { before: [{ amount: 1, unit: 'months' }], on_day: true } })] });
    add('alarm', { dates: { tested_on: null }, rules: [rule('test', { kind: 'interval', field: 'tested_on', every: { amount: 6, unit: 'months' } })] });
    const notice = { reaction: { notify: true, occurrence: 'notice' as const, emit: false } };
    add('laptop', { dates: { warranty_ends: '2026-10-07' }, rules: [rule('warranty', { kind: 'expiry', field: 'warranty_ends' }, notice)] });
    add('phone', { dates: { warranty_ends: '2026-10-22' }, rules: [rule('warranty', { kind: 'expiry', field: 'warranty_ends' }, notice)] });
    add('basement', { dates: {}, observations: { leak: { active: true, certainty: 'confirmed', as_of: T0 - 3_600_000, evidence: [], source: 'owner' } },
      rules: [rule('leak', { kind: 'condition', field: 'leak', certainty: 'confirmed' })] });
    add('car', { dates: {}, readings: { odometer: { value: 10_000, unit: 'km', as_of: T0 - 100 * DAY, evidence: [] } },
      rules: [rule('service', { kind: 'objective', field: 'odometer', target: 20_000, unit: 'km', direction: 'rising', mode: 'usage', lead_days: 14, every: 10_000 })] });
    work.writeAsset({ id: ids.car!, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, readings: { odometer: { value: 15_000, unit: 'km', as_of: T0 - DAY, evidence: [] } } }, time);
    add('tyres', { dates: {}, readings: { tread: { value: 6, unit: 'mm', as_of: T0 - 200 * DAY, evidence: [] } },
      rules: [rule('tread', { kind: 'objective', field: 'tread', target: 3, unit: 'mm', direction: 'falling', mode: 'condition', lead_days: 30 }, notice)] });
    work.writeAsset({ id: ids.tyres!, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, readings: { tread: { value: 4, unit: 'mm', as_of: T0 - DAY, evidence: [] } } }, time);
    // Dated ahead: its clock is empty until the reading's time, then already crossed.
    add('generator', { dates: {}, readings: { hours: { value: 150, unit: 'h', as_of: T0 + 3 * DAY, evidence: [] } },
      rules: [rule('service', { kind: 'objective', field: 'hours', target: 100, unit: 'h', direction: 'rising', mode: 'usage', lead_days: 2 })] });
    // A cancelled cycle: the owner's view skips ahead, a reader without commitments still sees cycle one.
    add('bike', { dates: { serviced_on: '2024-10-01' }, rules: [rule('service', { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } })] });
    const occurrences = service(); await occurrences.tick();
    const missed = work.listCommitments().find(row => row.statement === 'service · bike')!;
    await dispatchers().commitmentCancel({ id: missed.id }); await occurrences.tick();
    expect(await dueAssets({ from: T0, to: T0 + 14 * DAY }, true)).not.toContain(ids.bike);
    expect(await dueAssets({ from: T0, to: T0 + 14 * DAY }, false)).toContain(ids.bike);

    // The rows were computed at T0. Nothing is evaluated again below.
    let checked = 0;
    for (const at of [T0, T0 + 2 * DAY, T0 + 4 * DAY, T0 + 30 * DAY, T0 + 120 * DAY, T0 - 2 * DAY]) {
      time = at;
      const midnight = Date.parse(new Date(at).toISOString().slice(0, 10));
      for (const window of [{ from: at, to: at }, { from: at, to: at + DAY }, { from: at, to: at + 14 * DAY }, { from: at, to: at + 60 * DAY },
        { from: at, to: at + 400 * DAY }, { from: at - 12 * DAY, to: at - 9 * DAY }, { from: midnight, to: midnight + DAY - 1 }]) {
        const candidates = clocks.candidates({ ...window, now: at, zone: 'UTC' });
        for (const commitments of [true, false]) {
          const due = await dueAssets(window, commitments);
          expect({ at: new Date(at).toISOString(), window, commitments, missing: due.filter(id => !candidates.includes(id)) })
            .toEqual({ at: new Date(at).toISOString(), window, commitments, missing: [] });
          checked += due.length;
        }
      }
    }
    expect(checked).toBeGreaterThan(80);
    // The index narrows: a far deadline, a later lead and a lapsed notice stay out of the next fortnight.
    time = T0;
    const fortnight = clocks.candidates({ from: T0, to: T0 + 14 * DAY, now: T0, zone: 'UTC' });
    expect(fortnight).toEqual(expect.arrayContaining([ids.boiler, ids.alarm, ids.phone, ids.basement, ids.generator, ids.bike]));
    for (const name of ['passport', 'deed', 'laptop', 'car']) expect(fortnight).not.toContain(ids[name]);
    // A lapsed notice still meets a window over its own day.
    expect(clocks.candidates({ from: T0 - 12 * DAY, to: T0 - 9 * DAY, now: T0, zone: 'UTC' })).toContain(ids.laptop);
    expect(await dueAssets({ from: T0 - 12 * DAY, to: T0 - 9 * DAY }, true)).toContain(ids.laptop);
  });
});
