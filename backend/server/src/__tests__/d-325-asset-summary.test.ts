import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Asset, AssetRule, AssetRuleWhen } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { summarizeYoursAsset } from '../situations/asset-summary.js';

const T0 = Date.parse('2026-10-17T12:00Z'); const DAY = 86_400_000;
let db: Database.Database; let work: WorkEntityStore;
beforeEach(() => { db = new Database(':memory:'); ensureWorkEntitySchema(db); work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work); });
afterEach(() => db.close());
const rule = (id: string, when: AssetRuleWhen, patch: Partial<AssetRule> = {}): AssetRule => ({
  id, title: id, when, enabled: true, muted: false, pinned: false, consequence: 'routine', expiry_policy: 'escalate_overdue',
  reaction: { notify: false, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true }, ...patch,
});
const put = (input: Omit<Parameters<WorkEntityStore['writeAsset']>[0], 'source_id' | 'source'>, at = T0) =>
  work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, ...input }, at);
const summarize = (asset: Asset, timeZone = 'UTC', now = T0) => summarizeYoursAsset(asset, {
  work, occurrences: createAssetOccurrenceStore(db).byAsset(asset.id), now, timeZone,
});
const runtime = () => {
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => T0 });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => T0, timeZone: () => 'UTC' });
  return { dispatchers, occurrences };
};

describe('D-325 asset card projection', () => {
  it('shows a future clock before a task opens, without writing or requiring unused optional facts', () => {
    const asset = put({ name: 'Passport', dates: { expires_on: '2027-04-17', issued_on: null }, rules: [rule('renew', { kind: 'expiry', field: 'expires_on' })] });
    const before = db.prepare('SELECT total_changes() AS n').get();
    expect(summarize(asset)).toEqual({ asset_id: asset.id, open_tasks: 0, active_rules: 1, missing: [],
      next_due: { on: '2027-04-17', title: 'renew', rule_id: 'renew', state: 'upcoming', estimated: false } });
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(work.listCommitments()).toEqual([]);
  });
  it('deduplicates missing fields across enabled rules and treats zero and clear as known', () => {
    const asset = put({ name: 'Boiler', dates: { serviced_on: null, optional_date: null }, readings: { battery: { value: 0, unit: '%', as_of: T0, evidence: [] }, spare: null },
      observations: { fault: { active: false, certainty: 'confirmed', source: 'owner', as_of: T0, evidence: [] }, optional_condition: null }, rules: [
        rule('service', { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } }),
        rule('check_date', { kind: 'expiry', field: 'serviced_on' }),
        rule('battery', { kind: 'objective', field: 'battery', target: -1, unit: '%', direction: 'falling', mode: 'condition', lead_days: 0 }),
        rule('fault', { kind: 'condition', field: 'fault', certainty: 'confirmed' }),
        rule('disabled', { kind: 'condition', field: 'optional_condition', certainty: 'confirmed' }, { enabled: false }),
      ] });
    expect(summarize(asset)).toMatchObject({ open_tasks: 0, active_rules: 4, next_due: null, missing: [{ path: 'dates.serviced_on', reason: 'unknown' }] });
  });
  it('keeps unknown readings, unknown conditions, future samples and unconfirmed conditions distinct', () => {
    const asset = put({ name: 'Monitor', readings: { battery: null, pressure: { value: 2, unit: 'bar', as_of: T0 + 1, evidence: [] } },
      observations: { leak: null, fault: { active: true, certainty: 'conditional', source: 'owner', as_of: T0, evidence: [] } }, rules: [
        rule('battery', { kind: 'objective', field: 'battery', target: 20, unit: '%', direction: 'falling', mode: 'condition', lead_days: 0 }),
        rule('pressure', { kind: 'objective', field: 'pressure', target: 5, unit: 'bar', direction: 'rising', mode: 'condition', lead_days: 0 }),
        rule('leak', { kind: 'condition', field: 'leak', certainty: 'conditional' }),
        rule('fault', { kind: 'condition', field: 'fault', certainty: 'confirmed' }),
      ] });
    expect(summarize(asset).missing).toEqual([
      { path: 'observations.fault', reason: 'unconfirmed' }, { path: 'observations.leak', reason: 'unknown' },
      { path: 'readings.battery', reason: 'unknown' }, { path: 'readings.pressure', reason: 'future' },
    ]);
    // §4.10 — a condition the owner marked expected needs no confirming.
    const marked = put({ id: asset.id, settings: { expected_patterns: { fault: { active: true, at: T0 } } } }, T0 + 1);
    expect(summarize(marked).missing.map(row => row.path)).not.toContain('observations.fault');
  });
  it('uses the canonical pending task and its edited due day once, and does not resurrect it through a completed clock', async () => {
    const { occurrences, dispatchers } = runtime();
    const asset = put({ name: 'Passport', dates: { expires_on: '2026-10-17' }, rules: [rule('renew', { kind: 'expiry', field: 'expires_on' }, { muted: true })] });
    await occurrences.reconcileAsset(asset.id);
    const task = work.listCommitments()[0]!;
    await dispatchers.commitmentUpdate({ id: task.id, promised_for_at: Date.parse('2026-11-01') });
    expect(summarize(asset)).toMatchObject({ open_tasks: 1, next_due: { on: '2026-11-01', commitment_id: task.id, title: task.statement, state: 'upcoming' } });
    await dispatchers.commitmentFulfill({ id: task.id });
    expect(summarize(asset)).toMatchObject({ open_tasks: 0, next_due: null });
    expect(work.listCommitments()).toHaveLength(1);
  });
  it('counts a pending information question as its existing task without manufacturing a due date', async () => {
    const { occurrences } = runtime();
    const asset = put({ name: 'Boiler', dates: { serviced_on: null }, rules: [rule('service', { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } })] });
    await occurrences.reconcileAsset(asset.id);
    expect(summarize(asset)).toMatchObject({ open_tasks: 1, next_due: null, missing: [{ path: 'dates.serviced_on', reason: 'unknown' }] });
    expect(work.listCommitments()).toHaveLength(1);
    expect(work.listCommitments()[0]?.promised_for_at).toBeUndefined();
  });
  it('advances a cancelled interval through the shared cycle selection instead of showing the skipped deadline', async () => {
    const { occurrences, dispatchers } = runtime();
    const asset = put({ name: 'Boiler', dates: { serviced_on: '2025-10-17' }, rules: [rule('service', { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } })] });
    await occurrences.reconcileAsset(asset.id);
    await dispatchers.commitmentCancel({ id: work.listCommitments()[0]!.id });
    expect(summarize(asset)).toMatchObject({ open_tasks: 0, next_due: { on: '2027-10-17', state: 'upcoming' } });
  });
  it('labels a projected usage date as estimated and a measured crossing as recorded', () => {
    const meter = rule('service', { kind: 'objective', field: 'meter', target: 100, unit: 'km', direction: 'rising', mode: 'usage', lead_days: 0 });
    const first = put({ name: 'Bike', readings: { meter: { value: 40, unit: 'km', as_of: T0 - DAY, evidence: [] } }, rules: [meter] }, T0 - DAY);
    const asset = put({ id: first.id, readings: { meter: { value: 50, unit: 'km', as_of: T0, evidence: [] } } });
    expect(summarize(asset).next_due).toMatchObject({ on: '2026-10-22', estimated: true });
    const reached = put({ id: asset.id, readings: { meter: { value: 100, unit: 'km', as_of: T0, evidence: [] } } });
    expect(summarize(reached).next_due).toMatchObject({ on: '2026-10-17', state: 'today', estimated: false });
  });
  it('does not turn a recovered reading or a lapsed notice into the next obligation', () => {
    const first = put({ name: 'Light', dates: { notice_on: '2026-10-16' }, readings: { battery: { value: 10, unit: '%', as_of: T0 - DAY, evidence: [] } }, rules: [
      rule('notice', { kind: 'expiry', field: 'notice_on' }, { reaction: { notify: true, occurrence: 'notice', emit: false } }),
      rule('battery', { kind: 'objective', field: 'battery', target: 15, unit: '%', direction: 'falling', mode: 'condition', lead_days: 30 }),
    ] }, T0 - DAY);
    const asset = put({ id: first.id, readings: { battery: { value: 25, unit: '%', as_of: T0, evidence: [] } } });
    expect(summarize(asset)).toMatchObject({ next_due: null, missing: [] });
  });
  it('keeps a projected task date marked as estimated until the owner chooses another deadline', async () => {
    const { occurrences, dispatchers } = runtime();
    const meter = rule('service', { kind: 'objective', field: 'meter', target: 100, unit: 'km', direction: 'rising', mode: 'usage', lead_days: 7 });
    const first = put({ name: 'Bike', readings: { meter: { value: 40, unit: 'km', as_of: T0 - DAY, evidence: [] } }, rules: [meter] }, T0 - DAY);
    const asset = put({ id: first.id, readings: { meter: { value: 50, unit: 'km', as_of: T0, evidence: [] } } });
    await occurrences.reconcileAsset(asset.id); const task = work.listCommitments()[0]!;
    expect(summarize(asset)).toMatchObject({ open_tasks: 1, next_due: { on: '2026-10-22', commitment_id: task.id, estimated: true } });
    await dispatchers.commitmentUpdate({ id: task.id, promised_for_at: Date.parse('2026-10-24') });
    expect(summarize(asset)).toMatchObject({ open_tasks: 1, next_due: { on: '2026-10-24', commitment_id: task.id, estimated: false } });
    expect(work.listCommitments()).toHaveLength(1);
  });
  it('keeps the canonical task authoritative until recovery has actually closed it', async () => {
    const { occurrences } = runtime();
    const first = put({ name: 'Boiler', observations: { fault: { active: true, certainty: 'confirmed', source: 'owner', as_of: T0 - 1, evidence: [] } },
      rules: [rule('fault', { kind: 'condition', field: 'fault', certainty: 'confirmed' })] });
    await occurrences.reconcileAsset(first.id);
    const recovered = put({ id: first.id, observations: { fault: { active: false, certainty: 'confirmed', source: 'owner', as_of: T0, evidence: [] } } });
    expect(summarize(recovered)).toMatchObject({ open_tasks: 1, next_due: null });
    await occurrences.reconcileAsset(first.id);
    expect(summarize(recovered).open_tasks).toBe(0);
    expect(work.listCommitments()[0]?.lifecycle_state).toBe('fulfilled');
  });
  it('does not count deleted tasks, other assets or occasions that share an id', async () => {
    const { occurrences } = runtime();
    const asset = put({ name: 'Passport', dates: { expires_on: '2026-10-17' }, rules: [rule('renew', { kind: 'expiry', field: 'expires_on' })] });
    await occurrences.reconcileAsset(asset.id);
    const task = work.listCommitments()[0]!; const rows = createAssetOccurrenceStore(db).byAsset(asset.id);
    const duplicate = [...rows, { ...rows[0]!, id: 'other', asset_id: 'another' }, { ...rows[0]!, id: 'occasion', subject_kind: 'occasion' as const }];
    expect(summarizeYoursAsset(asset, { work, occurrences: duplicate, now: T0, timeZone: 'UTC' }).open_tasks).toBe(1);
    work.deleteCommitment(task.id, { tombstone: true, now: T0 });
    expect(summarize(asset)).toMatchObject({ open_tasks: 0, next_due: null });
  });
  it('classifies dates in the owner time zone and leaves inactive assets without missing-fact prompts', () => {
    const asset = put({ name: 'Passport', dates: { expires_on: '2026-10-17', unknown_on: null }, rules: [
      rule('renew', { kind: 'expiry', field: 'expires_on' }), rule('unknown', { kind: 'expiry', field: 'unknown_on' }),
    ] });
    expect(summarize(asset, 'UTC').next_due?.state).toBe('today');
    expect(summarize(asset, 'Pacific/Auckland').next_due?.state).toBe('overdue');
    expect(summarize({ ...asset, status: 'retired' })).toMatchObject({ active_rules: 0, next_due: null, missing: [] });
  });
});
