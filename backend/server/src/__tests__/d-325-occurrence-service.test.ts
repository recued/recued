import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetRule } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createWorkEntityEdgeStore } from '../storage/work-entity-edge-store.js';
import { runDueStatusSweep } from '../work-entity-due-status-sweep.js';
import { createOwnerCompletionWriter } from '../situations/owner-completion.js';
import { makeWorkEntityCrudHandlers } from '../work-entity-crud-handler.js';
import type { WsClient } from '../ws-server.js';

let db: Database.Database; let work: WorkEntityStore; let time: number;
const DAY = 86_400_000;
const source = { kind: 'owner' as const, ref: 'owner:local' };
const rule = (patch: Partial<AssetRule> = {}): AssetRule => ({ id: 'renew', title: 'Renew',
  when: { kind: 'expiry', field: 'expires_on' }, enabled: true, muted: false, pinned: false,
  consequence: 'floor', expiry_policy: 'escalate_overdue', reaction: { notify: true, occurrence: 'action', emit: false },
  schedule: { before: [{ amount: 6, unit: 'months' }], on_day: true, after: { amount: 1, unit: 'months' } }, ...patch });
const put = (patch: Partial<Asset> & { name: string }) => work.writeAsset({ source_id: 'recued.asset', source, ...patch }, time);
const dispatchers = () => createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => time,
  ownerCompletionWrite: createOwnerCompletionWriter(db, work) });
const service = (patch: Partial<Parameters<typeof createAssetOccurrenceService>[0]> = {}) => createAssetOccurrenceService({ db, work,
  dispatchers: dispatchers(), timeZone: () => 'UTC', now: () => time, ...patch });
beforeEach(() => { db = new Database(':memory:'); ensureWorkEntitySchema(db); work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work); time = Date.parse('2026-01-17T12:00Z'); });
afterEach(() => db.close());

describe('D-325 built-in rule occurrences', () => {
  it('records an authenticated Today close atomically, and never trains or advances facts from an ingredient close', async () => {
    const clock = rule({ when: { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } } });
    const asset = put({ name: 'Owner boiler', dates: { serviced_on: '2025-01-17' }, rules: [clock] });
    const core = service(); await core.tick(); const rows = createAssetOccurrenceStore(db); const occurrence = rows.byAsset(asset.id)[0]!;
    const slice = makeWorkEntityCrudHandlers({ store: work, resolver: createWorkEntityResolver(work), dispatchers: dispatchers() })!;
    const close = () => slice.handlers['work_entity.commitment.fulfill']({ id: occurrence.commitment_id! }, { instance_id: 'owner', client_kind: 'webclient' } as WsClient);
    db.exec("CREATE TRIGGER fail_completion BEFORE INSERT ON occurrence_completion_evidence BEGIN SELECT RAISE(ABORT,'receipt failed'); END");
    await expect(close()).rejects.toThrow('receipt failed');
    expect(work.readCommitment(occurrence.commitment_id!)!.lifecycle_state).toBe('pending'); expect(rows.completion(occurrence.id)).toBeNull();
    db.exec('DROP TRIGGER fail_completion');
    await close(); await core.tick();
    expect(rows.completion(occurrence.id)).toMatchObject({ owner_action: true, answered_at: time });
    expect(work.readAsset(asset.id)!.dates.serviced_on).toBe('2026-01-17');
    time += DAY;
    const other = put({ name: 'Recipe boiler', dates: { serviced_on: '2025-01-17' }, rules: [clock] }); await core.tick();
    const untrusted = rows.byAsset(other.id)[0]!;
    await dispatchers().commitmentFulfill({ id: untrusted.commitment_id! }); await core.tick();
    // ⛔ The clock used to stop here for good: no receipt, so no question and no next cycle.
    // It now waits for the owner's actual date.
    expect(rows.completion(untrusted.id)).toEqual({ answered_at: time, reading: null, known: false });
    expect(work.readAsset(other.id)!.dates.serviced_on).toBe('2025-01-17');
    await core.confirmCompletion({ occurrence_id: untrusted.id, on: '2026-01-10' });
    expect(work.readAsset(other.id)!.dates.serviced_on).toBe('2026-01-10');
    time = Date.parse('2026-08-01T12:00Z'); await core.tick();
    const next = rows.byAsset(other.id).find(row => row.id !== untrusted.id)!;
    expect(work.readCommitment(next.commitment_id!)).toMatchObject({ lifecycle_state: 'pending', promised_for_at: Date.parse('2027-01-10') });
  });
  it('accepts a confirmed renewal over an old owner date and never fulfils its future cycle on a receipt retry', async () => {
    const asset = put({ name: 'Passport', dates: { expires_on: '2026-07-01' }, rules: [rule()] });
    const core = service(); await core.tick(); const first = work.listCommitments()[0]!;
    const evidence = { asset_id: asset.id, rule_id: 'renew', on: '2028-07-01', evidence_ref: 'confirmed:renewal', confirmed: true };
    await core.recordRenewal(evidence);
    expect(work.readAsset(asset.id)!.dates.expires_on).toBe('2028-07-01'); expect(work.readCommitment(first.id)!.lifecycle_state).toBe('fulfilled');
    time = Date.parse('2028-01-17T12:00Z'); await core.tick(); const next = work.listCommitments().find(row => row.lifecycle_state === 'pending')!;
    await core.recordRenewal(evidence); expect(work.readCommitment(next.id)!.lifecycle_state).toBe('pending');
    await expect(core.recordRenewal({ ...evidence, evidence_ref: 'different:document' })).rejects.toThrow('later date');
  });
  it('closes the open renewal as done when the owner types a later expiry, and retires it when the date only moves', async () => {
    const asset = put({ name: 'Passport', dates: { expires_on: '2026-07-01' }, rules: [rule()] });
    const core = service(); await core.tick(); const first = work.listCommitments()[0]!;
    work.writeAsset({ id: asset.id, source_id: asset.source_id, source, dates: { expires_on: '2026-07-02' } }, ++time);
    await core.reconcileAsset(asset.id);
    expect(work.readCommitment(first.id)!.lifecycle_state).toBe('cancelled');
    const moved = work.listCommitments().find(row => row.lifecycle_state === 'pending')!;
    expect(moved.promised_for_at).toBe(Date.parse('2026-07-02'));
    work.writeAsset({ id: asset.id, source_id: asset.source_id, source, dates: { expires_on: '2036-07-01' } }, ++time);
    await core.reconcileAsset(asset.id);
    expect(work.readCommitment(moved.id)!.lifecycle_state).toBe('fulfilled');
    expect(work.listCommitments().filter(row => row.lifecycle_state === 'pending')).toEqual([]);
  });
  it('does not fulfil the next interval cycle when the original last-done receipt is replayed', async () => {
    const asset = put({ name: 'Boiler', dates: { serviced_on: '2025-01-01' }, rules: [rule({ when: { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } },
      schedule: { before: [{ amount: 12, unit: 'months' }], on_day: true } })] });
    const core = service(); await core.tick(); const evidence = { asset_id: asset.id, rule_id: 'renew', on: '2026-01-10', evidence_ref: 'confirmed:service', confirmed: true };
    await core.recordLastDone(evidence); const next = work.listCommitments().find(row => row.lifecycle_state === 'pending')!;
    expect(next.promised_for_at).toBe(Date.parse('2027-01-10'));
    await core.recordLastDone(evidence); expect(work.readCommitment(next.id)!.lifecycle_state).toBe('pending');
  });
  it('creates an ordinary commitment with the actual deadline, a stable identity and an ordinary asset edge', async () => {
    const asset = put({ name: 'Passport', dates: { expires_on: '2026-07-01' }, rules: [rule()] });
    await service().reconcileAsset(asset.id);
    const commitment = work.listCommitments()[0]!;
    expect(commitment).toMatchObject({ derivation: 'rule_emitted', promised_for_at: Date.parse('2026-07-01'), lifecycle_state: 'pending', expiry_policy: 'escalate_overdue' });
    expect(createWorkEntityEdgeStore(db).listByOwner('commitment', commitment.id)).toMatchObject([{ target_kind: 'asset', target_local_id: asset.id }]);
    await service().tick(); await service().tick();
    expect(work.listCommitments().map(row => row.id)).toEqual([commitment.id]);
    const nextRule = rule({ schedule: { before: [{ amount: 7, unit: 'months' }], on_day: true } });
    work.writeAsset({ id: asset.id, source_id: asset.source_id, source, rules: [nextRule] }, ++time);
    await service().reconcileAsset(asset.id);
    expect(work.listCommitments()[0]?.id).toBe(commitment.id);
    expect(work.readCommitment(commitment.id)?.promised_for_at).toBe(Date.parse('2026-07-01'));
  });
  it('asks once for unknown last done and keeps no_deadline until a real answer', async () => {
    const asset = put({ name: 'Boiler', dates: { serviced_on: null }, rules: [rule({ when: { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } } })] });
    const core = service(); await core.tick(); await core.tick();
    const question = work.listCommitments()[0]!;
    expect(question.due_status).toBe('no_deadline'); expect(question.promised_for_at).toBeUndefined();
    expect(createAssetOccurrenceStore(db).byAsset(asset.id)).toMatchObject([{ question: true }]);
    await core.recordLastDone({ asset_id: asset.id, rule_id: 'renew', on: '2025-08-20', evidence_ref: 'file:invoice', confirmed: true });
    expect(work.readCommitment(question.id)?.lifecycle_state).toBe('cancelled');
    expect(work.readAsset(asset.id)?.dates.serviced_on).toBe('2025-08-20');
    time = Date.parse('2026-03-01T12:00Z'); await core.tick();
    const next = work.listCommitments().find(row => row.lifecycle_state === 'pending')!;
    expect(next.promised_for_at).toBe(Date.parse('2026-08-20'));
  });
  it('keeps a usage crossing pending, preserves its first due date, and counts the next target from service mileage', async () => {
    const objective = rule({ when: { kind: 'objective', field: 'odometer', unit: 'km', target: 50_000,
      direction: 'rising', mode: 'usage', lead_days: 14, every: 10_000 }, schedule: { before: [], on_day: true } });
    const asset = put({ name: 'Car', readings: { odometer: { value: 50_500, unit: 'km', as_of: time, evidence: [] } }, rules: [objective] });
    const core = service(); await core.tick();
    const occurrence = work.listCommitments()[0]!;
    time += DAY; work.writeAsset({ id: asset.id, source_id: asset.source_id, source, readings: { odometer: { value: 51_000, unit: 'km', as_of: time, evidence: [] } } }, time);
    await core.tick(); expect(work.readCommitment(occurrence.id)).toMatchObject({ lifecycle_state: 'pending', promised_for_at: occurrence.promised_for_at });
    await dispatchers().ownerCommitmentFulfill({ id: occurrence.id }); await core.tick();
    expect(work.readAsset(asset.id)?.rules[0]?.when).toMatchObject({ target: 61_000 });
    expect(work.readCommitment(occurrence.id)?.lifecycle_state).toBe('fulfilled');
  });
  it('does not guess a usage service reading from a later odometer when a recipe closes it without one', async () => {
    // From the Home Assistant tests (2026-10-24): a list no longer closes anything, so a
    // close Recued didn't see the owner make is the way a service reading goes unknown.
    const objective = rule({ when: { kind: 'objective', field: 'odometer', unit: 'km', target: 10_000,
      direction: 'rising', mode: 'usage', lead_days: 14, every: 10_000 } });
    const asset = put({ name: 'Car', readings: { odometer: { value: 11_000, unit: 'km', as_of: time, evidence: [] } }, rules: [objective] });
    const core = service(); await core.tick(); const rows = createAssetOccurrenceStore(db); const occurrence = rows.byAsset(asset.id)[0]!;
    time += 30 * DAY; work.writeAsset({ id: asset.id, source_id: asset.source_id, source, readings: { odometer: { value: 21_000, unit: 'km', as_of: time, evidence: [] } } }, time);
    await dispatchers().commitmentFulfill({ id: occurrence.commitment_id! }); await core.tick();
    expect(rows.completion(occurrence.id)).toMatchObject({ reading: null, known: false });
    expect(work.readAsset(asset.id)!.rules[0]!.when).toMatchObject({ target: 10_000 });
    await expect(core.confirmCompletion({ occurrence_id: occurrence.id, on: '2026-01-20' })).rejects.toThrow('actual service reading');
    await core.confirmCompletion({ occurrence_id: occurrence.id, on: '2026-01-20', reading: { value: 12_000, unit: 'km' } });
    expect(work.readAsset(asset.id)!.rules[0]!.when).toMatchObject({ target: 22_000 });
    expect(work.readAsset(asset.id)!.readings.odometer!.value).toBe(21_000);
  });
  it('closes a condition on recovery, then opens one fresh cycle when it returns', async () => {
    const observation = (active: boolean) => ({ active, certainty: 'confirmed' as const, source: 'owner', as_of: time, evidence: [] });
    const asset = put({ name: 'Porch light', observations: { unavailable: observation(true) },
      rules: [rule({ when: { kind: 'condition', field: 'unavailable', certainty: 'confirmed' } })] });
    const core = service(); await core.tick(); const first = work.listCommitments()[0]!;
    time += 10; work.writeAsset({ id: asset.id, source_id: asset.source_id, source, observations: { unavailable: observation(true) } }, time);
    await core.tick(); expect(work.listCommitments()).toHaveLength(1);
    time += 10; work.writeAsset({ id: asset.id, source_id: asset.source_id, source, observations: { unavailable: observation(false) } }, time);
    await core.tick(); expect(work.readCommitment(first.id)?.lifecycle_state).toBe('fulfilled');
    time += 10; work.writeAsset({ id: asset.id, source_id: asset.source_id, source, observations: { unavailable: observation(true) } }, time);
    await core.tick(); expect(work.listCommitments().filter(row => row.lifecycle_state === 'pending')).toHaveLength(1);
    expect(work.listCommitments()).toHaveLength(2);
  });
  // The opt-in closure count (`clock.closure`) and a closed task's situation come from the
  // close outcome, which only `processClose` queued. An asset that left never reaches it,
  // and the cycle's end then marks the row processed, so these closes were never reported.
  it('reports each task close of an asset that was sold, retired or deleted, including one the owner closed just before', async () => {
    const outcome = vi.fn(); const core = service({ outcome });
    const car = put({ name: 'Car', dates: { expires_on: '2026-02-01' }, rules: [rule()] });
    const bike = put({ name: 'Bike', dates: { expires_on: '2026-02-01' }, rules: [rule()] });
    const phone = put({ name: 'Old phone', dates: { expires_on: '2026-02-01' }, rules: [rule()] });
    await core.tick(); const task = (id: string) => createAssetOccurrenceStore(db).byAsset(id)[0]!.commitment_id!;
    await dispatchers().ownerCommitmentFulfill({ id: task(bike.id) });
    time += DAY;
    work.writeAsset({ id: car.id, source_id: car.source_id, source, status: 'sold' }, time); await core.retireAsset(car.id);
    work.writeAsset({ id: bike.id, source_id: bike.source_id, source, status: 'retired' }, time); await core.retireAsset(bike.id);
    work.deleteAsset(phone.id, { tombstone: true, now: time }); await core.retireAsset(phone.id);
    await core.tick();
    expect(outcome.mock.calls.map(([input]) => [input.asset.name, input.commitment.lifecycle_state]).sort())
      .toEqual([['Bike', 'fulfilled'], ['Car', 'cancelled'], ['Old phone', 'cancelled']]);
    await core.reconcileAsset(car.id); await core.tick(); expect(outcome).toHaveBeenCalledTimes(3);
  });
  // §4.10 — "That's expected" was kept in a setting nothing read, so the flicker kept
  // opening "Review unexplained flicker" however often the owner said it was intended.
  it('closes a condition the owner marked expected, and raises nothing for it until it recovers', async () => {
    const observation = (active: boolean) => ({ active, certainty: 'conditional' as const, source: 'owner', as_of: time, evidence: [] });
    const write = (patch: Partial<Asset>) => work.writeAsset({ id: asset.id, source_id: asset.source_id, source, ...patch }, time);
    const asset = put({ name: 'Porch light', observations: { flickering: observation(true) },
      rules: [rule({ id: 'flicker', when: { kind: 'condition', field: 'flickering', certainty: 'conditional' } })] });
    const core = service(); await core.tick(); const first = work.listCommitments()[0]!;
    expect(first.lifecycle_state).toBe('pending');
    time += 10; write({ settings: { expected_patterns: { flickering: { active: true, at: time } } } });
    await core.tick(); expect(work.readCommitment(first.id)?.lifecycle_state).toBe('cancelled');
    time += 10; write({ observations: { flickering: observation(true) } });
    await core.tick(); expect(work.listCommitments()).toHaveLength(1);
    // Unmarked while still present: acknowledged, as any cancelled condition is, until it recovers.
    time += 10; write({ settings: { expected_patterns: null } });
    time += 10; write({ observations: { flickering: observation(true) } });
    await core.tick(); expect(work.listCommitments()).toHaveLength(1);
    time += 10; write({ observations: { flickering: observation(false) } }); await core.tick();
    time += 10; write({ observations: { flickering: observation(true) } }); await core.tick();
    expect(work.listCommitments().filter(row => row.lifecycle_state === 'pending')).toHaveLength(1);
    expect(work.listCommitments()).toHaveLength(2);
  });
  it('shortens a statement past the commitment limit instead of stopping every clock', async () => {
    // ⛔ `title · name` past 500 characters threw inside tick(), every minute, before
    // any other asset's clock was reached.
    put({ name: 'N'.repeat(200), dates: { expires_on: '2026-02-01' }, rules: [rule({ title: 'T'.repeat(450) })] });
    put({ name: 'Passport', dates: { expires_on: '2026-02-01' }, rules: [rule()] });
    await service().tick();
    const statements = work.listCommitments().map(row => row.statement);
    expect(statements).toHaveLength(2);
    const long = statements.find(text => text.startsWith('T'))!;
    expect(long).toHaveLength(500); expect(long.endsWith('…')).toBe(true);
    expect(statements).toContain('Renew · Passport');
  });
  it('opens a fresh objective occurrence when a recovered condition breaches again', async () => {
    // ⛔ The objective cycle was `field:target`, the same string every episode, so the
    // second breach found the first, closed occurrence and created nothing.
    const objective = rule({ when: { kind: 'objective', field: 'battery', unit: '%', target: 15, direction: 'falling',
      mode: 'condition', lead_days: 0 }, schedule: { before: [], on_day: true } });
    const battery = (value: number) => ({ battery: { value, unit: '%', as_of: time, evidence: [] } });
    const asset = put({ name: 'Smoke alarm', readings: battery(40), rules: [objective] });
    const core = service(); await core.tick(); expect(work.listCommitments()).toHaveLength(0);
    const read = async (value: number) => { time += DAY; work.writeAsset({ id: asset.id, source_id: asset.source_id, source, readings: battery(value) }, time); await core.tick(); };
    await read(12); const first = work.listCommitments()[0]!; expect(first.lifecycle_state).toBe('pending');
    await read(100); expect(work.readCommitment(first.id)?.lifecycle_state).toBe('fulfilled');
    await read(90); expect(work.listCommitments()).toHaveLength(1);
    await read(12);
    expect(work.listCommitments().filter(row => row.lifecycle_state === 'pending')).toHaveLength(1);
    expect(work.listCommitments()).toHaveLength(2);
  });
  it('moves a usage target skipped as not needed to the next one, without inventing a service', async () => {
    const objective = rule({ when: { kind: 'objective', field: 'odometer', unit: 'km', target: 50_000,
      direction: 'rising', mode: 'usage', lead_days: 14, every: 10_000 }, schedule: { before: [], on_day: true } });
    const odometer = (value: number) => ({ odometer: { value, unit: 'km', as_of: time, evidence: [] } });
    const asset = put({ name: 'Car', readings: odometer(50_500), rules: [objective] });
    const core = service(); await core.tick(); const first = work.listCommitments()[0]!;
    await dispatchers().commitmentCancel({ id: first.id }); await core.tick();
    expect(work.listCommitments().filter(row => row.lifecycle_state === 'pending')).toHaveLength(0);
    time += DAY; work.writeAsset({ id: asset.id, source_id: asset.source_id, source, readings: odometer(60_200) }, time); await core.tick();
    const pending = work.listCommitments().filter(row => row.lifecycle_state === 'pending');
    expect(pending).toHaveLength(1); expect(pending[0]!.id).not.toBe(first.id);
    expect(work.readAsset(asset.id)?.rules[0]?.when).toMatchObject({ target: 50_000 });
  });
  it('clears a projected date and returns to no_deadline when newer samples show no usable trend', async () => {
    const start = time;
    const objective = rule({ when: { kind: 'objective', field: 'odometer', unit: 'km', target: 1600,
      direction: 'rising', mode: 'usage', lead_days: 14, lead_value: 100 }, schedule: { before: [], on_day: true } });
    const asset = put({ name: 'Car', readings: { odometer: { value: 1500, unit: 'km', as_of: time, evidence: [] } }, rules: [objective] });
    time += DAY; work.writeAsset({ id: asset.id, source_id: asset.source_id, source, readings: { odometer: { value: 1550, unit: 'km', as_of: time, evidence: [] } } }, time);
    const core = service(); await core.tick(); const occurrence = work.listCommitments()[0]!;
    expect(occurrence.promised_for_at).toBe(Date.parse('2026-01-19')); expect(occurrence.promised_for_at).toBeLessThan(start + 3 * DAY);
    time += DAY; work.writeAsset({ id: asset.id, source_id: asset.source_id, source, readings: { odometer: { value: 1550, unit: 'km', as_of: time, evidence: [] } } }, time);
    await core.tick();
    expect(work.readCommitment(occurrence.id)?.promised_for_at).toBeUndefined();
    expect(work.readCommitment(occurrence.id)?.due_status).toBe('no_deadline');
  });
  it('records late evidence against the asset and advances from its actual date while a strict lapse stays lapsed', async () => {
    const asset = put({ name: 'Filter', dates: { serviced_on: '2025-01-01' }, rules: [rule({ expiry_policy: 'strict_expire',
      when: { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } } })] });
    const core = service(); await core.tick(); const first = work.listCommitments()[0]!;
    runDueStatusSweep({ store: work, now: () => time });
    expect(work.readCommitment(first.id)?.lifecycle_state).toBe('expired');
    await core.recordLastDone({ asset_id: asset.id, rule_id: 'renew', on: '2026-01-10', evidence_ref: 'file:service', confirmed: true });
    expect(work.readAsset(asset.id)?.dates.serviced_on).toBe('2026-01-10');
    expect(work.readCommitment(first.id)?.lifecycle_state).toBe('expired');
    time = Date.parse('2026-08-01T12:00Z'); await core.tick();
    expect(work.listCommitments().find(row => row.lifecycle_state === 'pending')?.promised_for_at).toBe(Date.parse('2027-01-10'));
  });
  it('cancels deleted rules and deleted assets, but muting alone leaves the obligation pending', async () => {
    const asset = put({ name: 'Passport', dates: { expires_on: '2026-07-01' }, rules: [rule()] });
    const withdraw = vi.fn(async () => {}); const core = service({ withdraw }); await core.tick(); const first = work.listCommitments()[0]!;
    work.writeAsset({ id: asset.id, source_id: asset.source_id, source, rules: [rule({ muted: true })] }, ++time);
    await core.tick(); expect(work.readCommitment(first.id)?.lifecycle_state).toBe('pending');
    work.writeAsset({ id: asset.id, source_id: asset.source_id, source, rules: [] }, ++time);
    await core.tick(); expect(work.readCommitment(first.id)?.lifecycle_state).toBe('cancelled'); expect(withdraw).toHaveBeenCalled();
    const other = put({ name: 'Other', dates: { expires_on: '2026-07-01' }, rules: [rule()] });
    await core.tick(); const pending = work.listCommitments().find(row => row.lifecycle_state === 'pending')!;
    work.deleteAsset(other.id, { tombstone: false }); await service().tick();
    expect(work.readCommitment(pending.id)?.lifecycle_state).toBe('cancelled');
  });
  it('retires parts and creates an editable cancel-or-transfer clock for a contract before its notice deadline', async () => {
    const house = put({ name: 'House' }); const part = put({ name: 'Alarm', belongs_to: house.id });
    const contract = put({ name: 'Security contract', belongs_to: house.id, retirement: 'cancel_or_transfer', dates: { renews_on: '2026-06-01' },
      rules: [rule({ id: 'notice', when: { kind: 'expiry', field: 'renews_on', offset: { amount: 1, unit: 'months' } } })] });
    work.writeAsset({ id: house.id, source_id: house.source_id, source, status: 'sold' }, ++time);
    const core = service(); await core.tick(); await service().tick();
    expect(work.readAsset(part.id)?.status).toBe('sold'); expect(work.readAsset(contract.id)?.status).toBe('active');
    const rows = work.listCommitments().filter(row => row.statement.startsWith('Cancel or transfer'));
    expect(rows).toHaveLength(1); expect(rows[0]?.promised_for_at).toBe(Date.parse('2026-05-01'));
    const editable = work.readAsset(contract.id)!;
    expect(editable.rules.some(row => row.id.startsWith('retirement_') && row.enabled)).toBe(true);
    expect(editable.dates.cancel_or_transfer_on).toBe('2026-05-01');
    expect(work.pendingAssetRetirements()).toEqual([]);
  });
});
