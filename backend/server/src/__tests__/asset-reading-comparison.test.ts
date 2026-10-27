import { describe, expect, it } from 'vitest';
import { type AssetFactContext, type AssetFactContextNode, type AssetRule } from '@recued/contracts';
import { compareDeclaredAssetTarget } from '../asset-reading-comparison.js';
const at = Date.parse('2026-10-26T12:00:00Z');
const field = { kind: 'field' as const, asset_id: 'asset', group: 'readings' as const, field: 'level' };
const rule = { kind: 'rule' as const, asset_id: 'asset', rule_id: 'limit' };
const fixture = (value = 12.1, target = 20.3) => {
  const config: AssetRule = { id: rule.rule_id, title: 'Level limit', enabled: true, muted: false, pinned: true, consequence: 'routine',
    when: { kind: 'objective', field: field.field, target, unit: 'm', direction: 'rising', mode: 'condition', lead_days: 0 },
    reaction: { notify: true, occurrence: 'action', emit: false }, expiry_policy: 'strict_expire', schedule: { before: [], on_day: true } };
  const input: Extract<AssetFactContextNode, { kind: 'field' }> = { kind: 'field', ref: field, label: 'Level', value: { value, unit: 'm', as_of: at - 86400000 }, known: true, source: null };
  const node: Extract<AssetFactContextNode, { kind: 'rule' }> = { kind: 'rule', ref: rule, title: config.title, rule: config };
  const graph: AssetFactContext = { root: rule, asset: { id: 'asset', name: 'Gauge' }, nodes: [node, input], edges: [{ kind: 'uses', from: rule, to: field }],
    read_at: at, freshness: 'current', completeness: 'complete', omitted: [], missing: [] };
  return { graph, node, input, compare: () => compareDeclaredAssetTarget(graph, node) };
};

describe('saved reading and declared target comparison', () => {
  it('compares below, equal and above without using direction as a forecast or changing the declared target', () => {
    const below = fixture(); expect(below.compare()).toMatchObject({ kind: 'compared', relation: 'below', difference: '8.2', value: 12.1, target: 20.3, observed_at: at - 86400000 });
    const equal = fixture(0, -0); expect(equal.compare()).toMatchObject({ kind: 'compared', relation: 'equal', difference: '0' });
    const above = fixture(37.4, 28.2);
    if (above.node.rule.when.kind !== 'objective') throw new Error('fixture');
    above.node.rule.when.direction = 'falling'; above.node.rule.when.mode = 'usage'; above.node.rule.when.every = 10;
    expect(above.compare()).toMatchObject({ kind: 'compared', relation: 'above', difference: '9.2', target: 28.2 });
  });
  it('keeps decimal, signed, very small and overflowing differences exact rather than rounding binary arithmetic', () => {
    for (const [value, target, difference] of [[0.3, 0.1, '0.2'], [-1.2, -0.9, '0.3'], [0.30000000000000004, 0.3, '0.00000000000000004'],
      [3e-100, 1e-100, '2e-100'], [1e308, -1e308, '2e+308']] as const) expect(fixture(value, target).compare()).toMatchObject({ kind: 'compared', difference });
    expect(fixture(1e100, 1e-100).compare()).toMatchObject({ kind: 'compared', relation: 'above', difference: undefined });
  });
  it('requires the returned native uses edge and the exact asset/field identity, never a matching label alone', () => {
    const missing = fixture(); missing.graph.edges = []; expect(missing.compare()).toMatchObject({ kind: 'unavailable', reason: 'unreturned_input' });
    const other = fixture(); other.input.ref = { ...field, asset_id: 'other' }; expect(other.compare()).toMatchObject({ kind: 'unavailable', reason: 'unreturned_input' });
    const wrong = fixture(); wrong.input.ref = { ...field, field: 'other' }; expect(wrong.compare()).toMatchObject({ kind: 'unavailable', reason: 'unreturned_input' });
  });
  it('never turns unknown, omitted, malformed, mismatched-unit or future inputs into a comparison', () => {
    const check = (edit: (f: ReturnType<typeof fixture>) => void, reason: string) => { const f = fixture(); edit(f); expect(f.compare()).toMatchObject({ kind: 'unavailable', reason }); };
    check(f => { f.input.known = false; f.input.value = { value: 0, unit: 'm', as_of: at }; }, 'unknown');
    check(f => { f.input.value_omitted = true; }, 'omitted');
    check(f => { f.input.value = '12.1 meters'; }, 'invalid_reading');
    check(f => { f.input.value = { value: 12.1, unit: 'ft', as_of: at }; }, 'unit_mismatch');
    check(f => { f.input.value = { value: 12.1, unit: 'm', as_of: at + 1 }; }, 'future');
    check(f => { f.input.future = true; }, 'future');
    check(f => { f.input.value = { value: Number.NaN, unit: 'm', as_of: at }; }, 'invalid_reading');
    check(f => { f.graph.read_at = Number.NaN; }, 'invalid_reading');
  });
});
