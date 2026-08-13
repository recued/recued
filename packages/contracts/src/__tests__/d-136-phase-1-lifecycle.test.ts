/** D-136 Phase 1 — Lifecycle / temporal-class / identity-aggregation
 *  validator gates.
 *
 *  Eight gates per spec §A.8. Each test builds a synthetic
 *  EnrichmentDefinition that violates exactly one gate and asserts
 *  `validateLifecycleDefinition` returns the matching issue. The
 *  registry-keyed wrapper `assertEnrichmentLifecycleDefaults` is
 *  exercised separately against ENRICHMENT_REGISTRY in the
 *  classification snapshot test. */

import { describe, expect, it } from 'vitest';

import {
  ALL_ENRICHMENT_SCOPES,
  validateLifecycleDefinition,
  type EnrichmentDefinition,
} from '../index.js';

const baseDef = (
  overrides: Partial<EnrichmentDefinition> = {},
): EnrichmentDefinition => ({
  shape: 'per_record',
  valid_scopes: ['mail'],
  value_schema: () => ({ ok: false, issues: ['stub'] }),
  policy: 'dependent',
  producer_kind: 'housekeeping',
  temporal_class: 'stable_truth',
  identity_aggregation: 'scenario',
  lifecycle_policy: 'recompute_on_drift',
  // D-136 P3 follow-up — §A.14.2 required field
  compression_class: 'derived',
  name: 'test',
  description: 'test',
  user_value: 'test',
  ...overrides,
});

describe('D-136 §A.8 — Gate 1: emits_confidence requires stable_truth', () => {
  it('passes when emits_confidence is true on stable_truth', () => {
    const def = baseDef({
      emits_confidence: true,
      temporal_class: 'stable_truth',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.filter((i) => i.includes('emits_confidence'))).toEqual([]);
  });

  it('rejects emits_confidence on time_bound', () => {
    const def = baseDef({
      emits_confidence: true,
      temporal_class: 'time_bound',
      lifecycle_policy: 'historical',
      as_of_field: 'computed_at',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('PSI is only meaningful on stable_truth'))).toBe(true);
  });

  it('rejects emits_confidence on aggregate_window', () => {
    const def = baseDef({
      emits_confidence: true,
      temporal_class: 'aggregate_window',
      lifecycle_policy: 'forward_only',
      as_of_field: 'computed_at',
      aggregate_window_axis: 'event_time',
      inputFingerprintComposition: 'aggregate_window_fold',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('PSI is only meaningful on stable_truth'))).toBe(true);
  });
});

describe('D-136 §A.8 — Gate 2: non-stable_truth requires as_of_field', () => {
  it('rejects time_bound without as_of_field', () => {
    const def = baseDef({
      temporal_class: 'time_bound',
      lifecycle_policy: 'historical',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('no as_of_field declared'))).toBe(true);
  });

  it('rejects aggregate_window without as_of_field', () => {
    const def = baseDef({
      temporal_class: 'aggregate_window',
      lifecycle_policy: 'forward_only',
      aggregate_window_axis: 'event_time',
      inputFingerprintComposition: 'aggregate_window_fold',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('no as_of_field declared'))).toBe(true);
  });

  it('passes stable_truth without as_of_field', () => {
    const def = baseDef({
      temporal_class: 'stable_truth',
      lifecycle_policy: 'forward_only',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.filter((i) => i.includes('no as_of_field'))).toEqual([]);
  });
});

describe('D-136 §A.8 — Gate 3: time_bound + recompute_on_drift forbidden', () => {
  it('rejects time_bound with recompute_on_drift', () => {
    const def = baseDef({
      temporal_class: 'time_bound',
      lifecycle_policy: 'recompute_on_drift',
      as_of_field: 'computed_at',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('time_bound; recompute_on_drift is forbidden'))).toBe(true);
  });

  it('passes time_bound with historical', () => {
    const def = baseDef({
      temporal_class: 'time_bound',
      lifecycle_policy: 'historical',
      as_of_field: 'computed_at',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.filter((i) => i.includes('recompute_on_drift is forbidden'))).toEqual([]);
  });
});

describe('D-136 §A.8 — Gate 4: aggregate_window + recompute_on_drift requires time-travelable sources', () => {
  it('rejects aggregate_window + recompute_on_drift on non-travelable source', () => {
    const def = baseDef({
      temporal_class: 'aggregate_window',
      lifecycle_policy: 'recompute_on_drift',
      aggregates_from: ['mail'],
      as_of_field: 'computed_at',
      aggregate_window_axis: 'event_time',
      inputFingerprintComposition: 'aggregate_window_fold',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('Replay against original snapshot impossible'))).toBe(true);
  });

  it('passes aggregate_window + recompute_on_drift on audit source', () => {
    const def = baseDef({
      temporal_class: 'aggregate_window',
      lifecycle_policy: 'recompute_on_drift',
      aggregates_from: ['audit'],
      as_of_field: 'computed_at',
      aggregate_window_axis: 'ingestion_time',
      inputFingerprintComposition: 'aggregate_window_fold',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.filter((i) => i.includes('Replay against original snapshot'))).toEqual([]);
  });

  /* ⛔ THE RATCHET THAT WOULD HAVE CAUGHT THE `'memory'` HAZARD.
   *
   * `aggregates_from` members that are NOT scopes (`'audit'`,
   * `'data_enrichment'`) share a value space with `EnrichmentScope`, and the
   * cascade routes on exactly that overlap:
   *     if (!def.aggregates_from.includes(scope)) return;   // enrichment-cascade
   * So a member that is ALSO a scope makes every write of that scope fan into
   * every topic that merely aggregates from it — stale-marking and enqueuing
   * recompute for unrelated topics.
   *
   * That was live until 2026-08-11: the member was spelled `'memory'`, and the
   * obvious name for a future owner-pool scope was also `'memory'`. TypeScript
   * cannot catch the collision — `EnrichmentScope | 'memory'` with `'memory'`
   * already in `EnrichmentScope` collapses to one union with no error. Only an
   * assertion over the VALUES can. */
  it('⛔ a non-scope aggregates_from member must never also be an EnrichmentScope', () => {
    const NON_SCOPE_AGGREGATE_SOURCES = ['audit', 'data_enrichment'] as const;
    for (const member of NON_SCOPE_AGGREGATE_SOURCES) {
      expect(
        (ALL_ENRICHMENT_SCOPES as ReadonlyArray<string>),
        `'${member}' is both an aggregates_from member and a scope — the cascade `
          + `would fan every '${member}' write into every topic aggregating from it`,
      ).not.toContain(member);
    }
  });
});

describe('D-136 §A.8 — Gate 5: ttl requires ttl_days', () => {
  it('rejects ttl policy without ttl_days', () => {
    const def = baseDef({
      temporal_class: 'time_bound',
      lifecycle_policy: 'ttl',
      as_of_field: 'computed_at',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes("lifecycle_policy: 'ttl' but no ttl_days"))).toBe(true);
  });

  it('passes ttl policy with ttl_days', () => {
    const def = baseDef({
      temporal_class: 'time_bound',
      lifecycle_policy: 'ttl',
      ttl_days: 30,
      as_of_field: 'computed_at',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.filter((i) => i.includes('no ttl_days'))).toEqual([]);
  });
});

describe('D-136 §A.8 — Gate 6: perspective requires identity_extractor', () => {
  it('rejects perspective without identity_extractor', () => {
    const def = baseDef({
      identity_aggregation: 'perspective',
      lifecycle_policy: 'forward_only',
      inputFingerprintComposition: 'perspective_fan_in',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('no identity_extractor declared'))).toBe(true);
  });

  it('passes perspective with identity_extractor', () => {
    const def = baseDef({
      identity_aggregation: 'perspective',
      lifecycle_policy: 'forward_only',
      identity_extractor: () => '',
      inputFingerprintComposition: 'perspective_fan_in',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.filter((i) => i.includes('identity_extractor'))).toEqual([]);
  });
});

describe('D-136 §A.8 — Gate 7: aggregate_window requires aggregate_window_axis', () => {
  it('rejects aggregate_window without aggregate_window_axis', () => {
    const def = baseDef({
      temporal_class: 'aggregate_window',
      lifecycle_policy: 'forward_only',
      as_of_field: 'computed_at',
      inputFingerprintComposition: 'aggregate_window_fold',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('no aggregate_window_axis'))).toBe(true);
  });

  it('passes aggregate_window with axis', () => {
    const def = baseDef({
      temporal_class: 'aggregate_window',
      lifecycle_policy: 'forward_only',
      as_of_field: 'computed_at',
      aggregate_window_axis: 'event_time',
      inputFingerprintComposition: 'aggregate_window_fold',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.filter((i) => i.includes('aggregate_window_axis'))).toEqual([]);
  });
});

describe('D-136 §A.8 — Gate 8: aggregate_window OR perspective requires inputFingerprintComposition', () => {
  it('rejects aggregate_window without inputFingerprintComposition', () => {
    const def = baseDef({
      temporal_class: 'aggregate_window',
      lifecycle_policy: 'forward_only',
      as_of_field: 'computed_at',
      aggregate_window_axis: 'event_time',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('inputFingerprintComposition'))).toBe(true);
  });

  it('rejects perspective without inputFingerprintComposition', () => {
    const def = baseDef({
      identity_aggregation: 'perspective',
      lifecycle_policy: 'forward_only',
      identity_extractor: () => '',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('inputFingerprintComposition'))).toBe(true);
  });

  it('passes per-record stable_truth scenario without inputFingerprintComposition', () => {
    const def = baseDef({
      temporal_class: 'stable_truth',
      identity_aggregation: 'scenario',
      lifecycle_policy: 'forward_only',
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.filter((i) => i.includes('inputFingerprintComposition'))).toEqual([]);
  });
});

describe('D-136 §A.8 — composite: clean stable_truth + scenario passes', () => {
  it('returns no issues for purpose-shaped definition', () => {
    const def = baseDef({
      temporal_class: 'stable_truth',
      identity_aggregation: 'scenario',
      lifecycle_policy: 'recompute_on_drift',
      emits_confidence: true,
    });
    const issues = validateLifecycleDefinition('test', def);
    expect(issues).toEqual([]);
  });
});
