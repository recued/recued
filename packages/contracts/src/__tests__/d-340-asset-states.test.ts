import { describe, expect, it } from 'vitest';
import { evaluateAssetRuleClock } from '../asset-rule-clock.js';
import { assetConditionHolds, validateAsset, validateAssetRule, type Asset, type AssetCondition, type AssetRule } from '../assets.js';

// D-340 §4 — a state: a condition that holds until its `until`, shown while it holds.
const NIGHT_END = Date.parse('2026-11-06T07:00:00Z');
const MIDNIGHT = Date.parse('2026-11-07T00:00:00Z');
const state = (patch: Partial<AssetRule> = {}): AssetRule => ({
  id: 'short_sleep', title: 'Short night', enabled: true, muted: false, pinned: false, consequence: 'routine',
  when: { kind: 'condition', field: 'short_sleep', certainty: 'confirmed' }, expiry_policy: 'indefinite',
  reaction: { notify: false, occurrence: null, emit: false, state: true }, schedule: { before: [], on_day: true }, ...patch,
});
const condition = (patch: Partial<AssetCondition> = {}): AssetCondition => ({
  active: true, certainty: 'confirmed', as_of: NIGHT_END, until: MIDNIGHT, evidence: [], source: 'recipe:body', ...patch,
});
const asset = (patch: Partial<Asset> = {}): Asset => ({
  id: 'body', name: 'Body', status: 'active', source_id: 'recued.asset', last_seen_at: 1, sync_state: 'live',
  conflict_policy: 'recued_wins', created_at: 1, updated_at: 1, dates: {}, readings: {}, observations: { short_sleep: condition() },
  values: [], anchors: [], attributes: {}, settings: {}, rules: [state()], field_sources: {}, retirement: 'part', ...patch,
});
const clockAt = (now: number, subject = asset(), rule = state()) => evaluateAssetRuleClock(subject, rule, { now, timeZone: 'UTC' });

describe('D-340 states: a condition that holds until its until', () => {
  it('holds while active and before its until, and never after; with no until it holds until cleared', () => {
    expect(assetConditionHolds(condition(), MIDNIGHT - 1)).toBe(true);
    expect(assetConditionHolds(condition(), MIDNIGHT)).toBe(false);
    expect(assetConditionHolds(condition({ active: false }), NIGHT_END)).toBe(false);
    expect(assetConditionHolds(condition({ until: undefined }), MIDNIGHT + 10 * 86_400_000)).toBe(true);
    expect(assetConditionHolds(null, NIGHT_END)).toBe(false);
  });
  it('accepts an until after as-of and refuses one at or before it', () => {
    expect(() => validateAsset(asset())).not.toThrow();
    expect(() => validateAsset(asset({ observations: { short_sleep: condition({ until: NIGHT_END }) } }))).toThrow('until must be a time after as-of');
    expect(() => validateAsset(asset({ observations: { short_sleep: condition({ until: Number.NaN }) } }))).toThrow('until');
  });
  it('lets only a condition rule with nothing under Due and no notification be a state', () => {
    expect(() => validateAssetRule(state(), asset())).not.toThrow();
    for (const reaction of [
      { notify: true, occurrence: null, emit: false, state: true },
      { notify: false, occurrence: 'notice', emit: false, state: true },
      { notify: false, occurrence: 'action', emit: false, state: true },
    ] as const) expect(() => validateAssetRule(state({ reaction }), asset())).toThrow('a state shows a condition while it holds');
    const dated = asset({ dates: { started_on: '2026-11-01' } });
    expect(() => validateAssetRule(state({ when: { kind: 'expiry', field: 'started_on' } }), dated)).toThrow('a state shows a condition');
    expect(() => validateAssetRule(state({ reaction: { notify: false, occurrence: null, emit: false, state: 'yes' as never } }), asset())).toThrow('must be boolean');
  });
  it('reads as recovered once its until passes, so an occurrence it opened closes with no writer', () => {
    expect(clockAt(NIGHT_END + 3_600_000)).toMatchObject({ active: true, recovered: false });
    expect(clockAt(MIDNIGHT)).toMatchObject({ active: false, recovered: true });
    // The same holds for an ordinary condition rule whose writer gave an until.
    const task = state({ reaction: { notify: true, occurrence: 'action', emit: false } });
    expect(clockAt(MIDNIGHT - 1, asset({ rules: [task] }), task)).toMatchObject({ active: true });
    expect(clockAt(MIDNIGHT, asset({ rules: [task] }), task)).toMatchObject({ active: false, recovered: true });
  });
  it('keeps the rule’s certainty: a conditional state does not satisfy a confirmed rule', () => {
    const conditional = asset({ observations: { short_sleep: condition({ certainty: 'conditional' }) } });
    expect(clockAt(NIGHT_END + 1, conditional)).toMatchObject({ active: false, recovered: false });
  });
});
