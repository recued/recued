/** D-133 P2 — Registry entry + realtime event wiring.
 *
 *  Covers the `confidence_drift_signal` topic registration plus the
 *  `enrichment_drift_detected` ServerEvent variant + its broadcast /
 *  Read-default subscription wiring. */

import { describe, it, expect } from 'vitest';
import {
  ENRICHMENT_REGISTRY,
  isEnrichmentTopic,
  getEnrichmentDefinition,
} from '../enrichment-registry.js';
import {
  ALL_BROADCAST_EVENT_KINDS,
  BROADCAST_EVENT_KIND_SET,
  type ServerEvent,
} from '../events.js';
import { DEFAULT_SUBSCRIPTIONS } from '../pairing.js';

describe('D-133 P2 — confidence_drift_signal registry entry', () => {
  it('topic is registered + recognised by the predicate', () => {
    expect(isEnrichmentTopic('confidence_drift_signal')).toBe(true);
    expect('confidence_drift_signal' in ENRICHMENT_REGISTRY).toBe(true);
  });

  it('shape is derived_entity (one row per source topic, not per record)', () => {
    const def = getEnrichmentDefinition('confidence_drift_signal');
    expect(def.shape).toBe('derived_entity');
  });

  it('policy is independent (no source-collection cascade)', () => {
    const def = getEnrichmentDefinition('confidence_drift_signal');
    expect(def.policy).toBe('independent');
  });

  it('producer_kind is housekeeping (rides D-123 harness)', () => {
    const def = getEnrichmentDefinition('confidence_drift_signal');
    expect(def.producer_kind).toBe('housekeeping');
  });

  it('default_trust_state is auto (deterministic, zero-cost)', () => {
    const def = getEnrichmentDefinition('confidence_drift_signal');
    expect(def.default_trust_state).toBe('auto');
  });

  it('default_pool_policy is free_only (zero AI calls)', () => {
    const def = getEnrichmentDefinition('confidence_drift_signal');
    expect(def.default_pool_policy).toBe('free_only');
  });

  it('value_schema accepts a well-formed drift signal', () => {
    const def = getEnrichmentDefinition('confidence_drift_signal');
    const result = def.value_schema({
      source_topic: 'purpose',
      psi: 0.18,
      severity: 'moderate',
      baseline_window: { start_at: 1000, end_at: 2000, sample_count: 500 },
      recent_window: { start_at: 9000, end_at: 10000, sample_count: 50 },
      baseline_distribution: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      recent_distribution: [0.2, 0.1, 0.1, 0.1, 0.1, 0.1, 0.05, 0.05, 0.1, 0.1],
      computed_at: 10000,
    });
    expect(result.ok).toBe(true);
  });

  it('value_schema rejects missing source_topic', () => {
    const def = getEnrichmentDefinition('confidence_drift_signal');
    const result = def.value_schema({
      psi: 0.05,
      severity: 'none',
      baseline_window: { start_at: 0, end_at: 1, sample_count: 100 },
      recent_window: { start_at: 0, end_at: 1, sample_count: 30 },
      baseline_distribution: [],
      recent_distribution: [],
      computed_at: 1,
    });
    expect(result.ok).toBe(false);
  });

  it('value_schema rejects severity outside the closed enum', () => {
    const def = getEnrichmentDefinition('confidence_drift_signal');
    const result = def.value_schema({
      source_topic: 'purpose',
      psi: 0.05,
      severity: 'critical',
      baseline_window: { start_at: 0, end_at: 1, sample_count: 100 },
      recent_window: { start_at: 0, end_at: 1, sample_count: 30 },
      baseline_distribution: [0.1],
      recent_distribution: [0.1],
      computed_at: 1,
    });
    expect(result.ok).toBe(false);
  });

  it('value_schema accepts an optional dismissed_at field', () => {
    const def = getEnrichmentDefinition('confidence_drift_signal');
    const result = def.value_schema({
      source_topic: 'purpose',
      psi: 0.31,
      severity: 'significant',
      baseline_window: { start_at: 0, end_at: 1, sample_count: 100 },
      recent_window: { start_at: 0, end_at: 1, sample_count: 30 },
      baseline_distribution: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      recent_distribution: [0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0],
      computed_at: 1,
      dismissed_at: 2,
    });
    expect(result.ok).toBe(true);
  });
});

describe('D-133 P2 — enrichment_drift_detected ServerEvent', () => {
  it('is registered in ALL_BROADCAST_EVENT_KINDS (alphabetical)', () => {
    expect(ALL_BROADCAST_EVENT_KINDS).toContain('enrichment_drift_detected');
    expect(BROADCAST_EVENT_KIND_SET.has('enrichment_drift_detected')).toBe(true);
  });

  it('default subscriptions include the drift event', () => {
    expect(DEFAULT_SUBSCRIPTIONS).toContain('enrichment_drift_detected');
  });

  it('event payload narrows severity to moderate | significant only', () => {
    const event: Extract<ServerEvent, { kind: 'enrichment_drift_detected' }> = {
      kind: 'enrichment_drift_detected',
      source_topic: 'purpose',
      psi: 0.31,
      severity: 'significant',
      computed_at: 12345,
      cursor: 1,
    };
    // Compile-time + runtime assertion that the narrowed union holds.
    expect(event.severity).toBe('significant');
    // @ts-expect-error — 'none' is intentionally not assignable to severity here.
    const _bad: typeof event.severity = 'none';
    void _bad;
  });
});
