import { describe, expect, it } from 'vitest';
import { assetDateAt, evaluateAssetRuleClock, planAssetReminderPoints, shiftAssetDate } from '../asset-rule-clock.js';
import { AssetValidationError } from '../assets.js';
import { validateAsset, validateAssetRule, type Asset, type AssetRule } from '../assets.js';

const rule = (patch: Partial<AssetRule> = {}): AssetRule => ({
  id: 'renew', title: 'Renew passport', enabled: true, muted: false, pinned: false,
  consequence: 'floor', when: { kind: 'expiry', field: 'expires_on' },
  reaction: { notify: true, occurrence: 'action', emit: true }, expiry_policy: 'escalate_overdue',
  schedule: { before: [6, 3, 1].map(amount => ({ amount, unit: 'months' })), on_day: true, after: { amount: 1, unit: 'months' } },
  ...patch,
});
const asset = (patch: Partial<Asset> = {}): Asset => ({
  id: 'a1', name: 'Ana’s passport', status: 'active', source_id: 'recued.asset', last_seen_at: 1,
  sync_state: 'live', conflict_policy: 'recued_wins', created_at: 1, updated_at: 1,
  dates: { expires_on: '2027-05-03', last_done: null }, readings: { odometer: null, battery: null }, observations: { problem: null },
  values: [], anchors: [], attributes: {}, settings: {}, rules: [rule()], field_sources: {}, retirement: 'part', ...patch,
});
const at = (date: string) => ({ now: Date.parse(`${date}T12:00:00Z`), timeZone: 'UTC' });

describe('D-325 typed rules and clocks', () => {
  it('needs no identifying fields and preserves unknown dates/readings', () => {
    expect(() => validateAsset(asset())).not.toThrow();
    expect(() => validateAsset(asset({ dates: { expires_on: '2027-02-29' } }))).toThrow('YYYY-MM-DD');
    expect(() => validateAsset(asset({ dates: { expires_on: null } }))).not.toThrow();
    expect(() => validateAsset(asset({ attributes: { mileage: NaN } }))).toThrow('JSON');
  });
  it('refuses free-text fields, unknown grammar, duplicate rules and subdaily schedules', () => {
    expect(() => validateAssetRule(rule({ when: { kind: 'expiry', field: 'notes' } }), asset())).toThrow('no such date');
    expect(() => validateAssetRule(rule({ when: { kind: 'feed', field: 'expires_on' } as never }), asset())).toThrow('only expiry');
    expect(() => validateAsset(asset({ rules: [rule(), rule()] }))).toThrow('duplicate');
    expect(() => validateAssetRule(rule({ schedule: { before: [], on_day: true, after: { amount: 0, unit: 'days' } } }), asset())).toThrow('whole number');
  });
  it('keeps the true deadline separate from its six-month lead', () => {
    expect(evaluateAssetRuleClock(asset(), rule(), at('2026-11-03'))).toMatchObject({
      cycle: '2027-05-03', due_on: '2027-05-03', act_by: '2026-11-03', active: true,
    });
    expect(evaluateAssetRuleClock(asset(), rule(), at('2026-11-02')).active).toBe(false);
  });
  it('computes real calendar months, leap days, and the owner’s day across UTC midnight', () => {
    expect(shiftAssetDate('2027-01-31', { amount: 1, unit: 'months' })).toBe('2027-02-28');
    expect(shiftAssetDate('2027-01-31', { amount: 2, unit: 'months' })).toBe('2027-03-31');
    expect(shiftAssetDate('2028-02-29', { amount: 12, unit: 'months' })).toBe('2029-02-28');
    expect(assetDateAt(Date.parse('2026-10-18T01:00:00Z'), 'America/Los_Angeles')).toBe('2026-10-17');
    expect(() => assetDateAt(Date.parse('0000-12-31'), 'UTC')).toThrow(AssetValidationError);
    expect(() => assetDateAt(Date.parse('+010000-01-01'), 'UTC')).toThrow(AssetValidationError);
    expect(() => shiftAssetDate('9999-12-31', { amount: Number.MAX_SAFE_INTEGER, unit: 'weeks' })).toThrow(AssetValidationError);
  });
  it('asks once without inventing an interval deadline, then anchors the next cycle to the actual service', () => {
    const interval = rule({ when: { kind: 'interval', field: 'last_done', every: { amount: 12, unit: 'months' } } });
    expect(evaluateAssetRuleClock(asset(), interval, at('2026-10-17'))).toMatchObject({ due_on: null, question: true, active: false });
    const serviced = asset({ dates: { last_done: '2026-10-16' }, rules: [interval] });
    expect(evaluateAssetRuleClock(serviced, interval, at('2026-10-17'))).toMatchObject({ due_on: '2027-10-16', question: false });
    expect(evaluateAssetRuleClock(serviced, interval, { ...at('2028-01-01'), cycle: 2 }).due_on).toBe('2028-10-16');
  });
  it('does not fulfill service when usage crosses its target, and invents no trend from one reading', () => {
    const usage = rule({ when: { kind: 'objective', field: 'odometer', target: 15000, unit: 'km', direction: 'rising', mode: 'usage', lead_days: 30, lead_value: 1000 } });
    const car = asset({ readings: { odometer: { value: 14500, unit: 'km', as_of: Date.parse('2026-10-17T12:00:00Z'), evidence: [] } }, rules: [usage] });
    expect(evaluateAssetRuleClock(car, usage, at('2026-10-17'))).toMatchObject({ due_on: null, active: true, recovered: false });
    car.readings.odometer!.value = 15001;
    expect(evaluateAssetRuleClock(car, usage, at('2026-10-17'))).toMatchObject({ active: true, recovered: false });
  });
  it('projects from two compatible readings and recovers only condition thresholds', () => {
    const battery = rule({ when: { kind: 'objective', field: 'battery', target: 15, unit: '%', direction: 'falling', mode: 'condition', lead_days: 30 } });
    const device = asset({ readings: { battery: { value: 20, unit: '%', as_of: Date.parse('2026-10-17T12:00:00Z'), evidence: [] } }, rules: [battery] });
    const earlier = { value: 25, unit: '%', as_of: Date.parse('2026-10-12T12:00:00Z'), evidence: [] };
    expect(evaluateAssetRuleClock(device, battery, { ...at('2026-10-17'), readings: [earlier] })).toMatchObject({ due_on: '2026-10-22', active: true, recovered: false, estimated: true });
    expect(evaluateAssetRuleClock(device, battery, { ...at('2026-10-17'), readings: [{ ...earlier, value: 10 }] })).toMatchObject({ recovered: true, active: false });
    expect(evaluateAssetRuleClock(device, battery, { ...at('2026-10-17'), readings: [{ ...earlier, unit: 'volts' }] }).due_on).toBeNull();
    device.readings.battery!.value = 10;
    const reached = evaluateAssetRuleClock(device, battery, { ...at('2026-10-17'), readings: [earlier] });
    expect(reached).toMatchObject({ due_on: '2026-10-17', active: true });
    expect(reached.estimated).toBeUndefined();
  });
  it('never promotes conditional observations to confirmed in core', () => {
    const condition = rule({ when: { kind: 'condition', field: 'problem', certainty: 'confirmed' } });
    const device = asset({ observations: { problem: { active: true, certainty: 'conditional', source: 'home-assistant', as_of: 1, evidence: [] } }, rules: [condition] });
    expect(evaluateAssetRuleClock(device, condition, at('2026-10-17')).active).toBe(false);
    device.observations.problem!.certainty = 'confirmed';
    expect(evaluateAssetRuleClock(device, condition, at('2026-10-17')).active).toBe(true);
    device.observations.problem!.active = false;
    expect(evaluateAssetRuleClock(device, condition, at('2026-10-17')).recovered).toBe(true);
  });
  it('collapses elapsed schedule points and computes monthly repeats from the original anchor', () => {
    const plan = planAssetReminderPoints('2027-05-03', rule(), '2027-03-03');
    expect(plan.due).toEqual({ key: 'before:3:months', date: '2027-02-03' });
    expect(plan.next).toEqual({ key: 'before:1:months', date: '2027-04-03' });
    expect(plan.past_keys).toHaveLength(2);
    const overdue = planAssetReminderPoints('2027-01-31', rule(), '2027-03-29');
    expect(overdue.due?.date).toBe('2027-02-28');
    expect(overdue.next?.date).toBe('2027-03-31');
  });
});
