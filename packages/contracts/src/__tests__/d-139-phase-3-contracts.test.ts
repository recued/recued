/** D-139 Phase 3 — contracts smoke tests for the deterministic
 *  deal-level enrichment registry entries + value schemas.
 *
 *  Covers:
 *    - Three new topic registrations (engagement_velocity_signal +
 *      inbound_outbound_ratio + last_meaningful_touch).
 *    - Each topic declares the full Pass-4 D-136 substrate
 *      annotations (temporal_class × identity_aggregation ×
 *      lifecycle_policy + compression_class + producer_kind +
 *      default_trust_state + default_pool_policy + valid_scopes +
 *      aggregates_from listing all per-type engagement scopes).
 *    - Value schemas validator-pass on canonical inputs and reject
 *      malformed shapes per the per-field contracts.
 *    - Enum closed-list exports for trajectory + bucket.
 *
 *  Spec: D-139 § A.9.1 + § P3 acceptance + § P3
 *  contracts. */

import { describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  ENGAGEMENT_VELOCITY_TRAJECTORIES,
  INBOUND_OUTBOUND_BUCKETS,
  isEnrichmentTopic,
  type EngagementVelocitySignalValue,
  type EngagementVelocityTrajectory,
  type InboundOutboundBucket,
  type InboundOutboundRatioValue,
  type LastMeaningfulTouchValue,
} from '../index.js';

const HUBSPOT_DEAL = 'connection.api.hubspot.deal' as const;
const SALESFORCE_OPP = 'connection.api.salesforce.opportunity' as const;

// Codex P2 #1 fold — closed list now includes `salesforce.voice_call`
// alongside `salesforce.call_history` (Pass-5 R5.11 dual-schema —
// either may register at probe time depending on org config; topic
// load is probe-independent so registry includes BOTH).
const FULL_AGGREGATES_FROM = [
  'connection.api.hubspot.email',
  'connection.api.hubspot.meeting',
  'connection.api.hubspot.note',
  'connection.api.hubspot.call',
  'connection.api.hubspot.task',
  'connection.api.salesforce.task',
  'connection.api.salesforce.event',
  'connection.api.salesforce.email_message',
  'connection.api.salesforce.voice_call',
  'connection.api.salesforce.call_history',
];

describe('D-139 P3 — engagement_velocity_signal topic registration', () => {
  it('topic resolves via isEnrichmentTopic', () => {
    expect(isEnrichmentTopic('engagement_velocity_signal')).toBe(true);
  });
  it('carries aggregate_window × scenario × forward_only lifecycle per § A.9.1', () => {
    const def = ENRICHMENT_REGISTRY.engagement_velocity_signal;
    expect(def).toBeDefined();
    expect(def.temporal_class).toBe('aggregate_window');
    expect(def.identity_aggregation).toBe('scenario');
    expect(def.lifecycle_policy).toBe('forward_only');
  });
  it('valid_scopes covers HubSpot deal + Salesforce opportunity', () => {
    const def = ENRICHMENT_REGISTRY.engagement_velocity_signal;
    expect(def.valid_scopes).toEqual([HUBSPOT_DEAL, SALESFORCE_OPP]);
  });
  it('aggregates_from enumerates all per-type engagement scopes', () => {
    const def = ENRICHMENT_REGISTRY.engagement_velocity_signal;
    expect([...(def.aggregates_from ?? [])].sort()).toEqual(
      [...FULL_AGGREGATES_FROM].sort(),
    );
  });
  it('default trust state = auto + pool policy = free_only (deterministic, zero token)', () => {
    const def = ENRICHMENT_REGISTRY.engagement_velocity_signal;
    expect(def.default_trust_state).toBe('auto');
    expect(def.default_pool_policy).toBe('free_only');
  });
  it('producer_kind = housekeeping + policy = aggregate', () => {
    // ⛔ WAS `'reactive'` until slice 3 (2026-09-09). `producer_kind` is not
    // a taxonomy of when a signal "feels" live — it decides which execution
    // mode owns the topic, and Settings → Housekeeping renders a reactive
    // entry as "live, N events processed" with NO Run-Now affordance. This
    // topic is now produced by a REGISTERED housekeeping task
    // (`engagementVelocitySignalTask`), so `'reactive'` had become a claim
    // about the substrate that the substrate contradicted — the owner would
    // have been shown a row they could not run.
    //
    // Trust is unaffected either way: `resolveEnrichmentTrustDefault` gives
    // a deterministic topic `'auto'` under both kinds.
    const def = ENRICHMENT_REGISTRY.engagement_velocity_signal;
    expect(def.producer_kind).toBe('housekeeping');
    expect(def.policy).toBe('aggregate');
  });
  it('aggregate window is 90d (full fold) + axis event_time per § A.9.1 + Codex P2 #2 fold', () => {
    // Pre-fold the registry declared 30d (the recent window) but the
    // producer reads 90d of inputs (recent 30d + baseline 60d). Codex
    // P2 #2 fold aligns the registry annotation with the producer's
    // actual fold window so substrate-side dependency tracking is
    // consistent.
    const def = ENRICHMENT_REGISTRY.engagement_velocity_signal;
    expect(def.aggregate_window_axis).toBe('event_time');
    expect(def.aggregate_window_ms).toBe(90 * 24 * 60 * 60 * 1000);
  });
  it('value_schema validates a well-formed value', () => {
    const def = ENRICHMENT_REGISTRY.engagement_velocity_signal;
    const v: EngagementVelocitySignalValue = {
      trajectory: 'accelerating',
      weighted_recent: 8.5,
      weighted_baseline: 6.0,
      total_recent: 9,
      total_baseline: 6,
      cursor_at: 1714867200000,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema rejects unknown trajectory + negative counts', () => {
    const def = ENRICHMENT_REGISTRY.engagement_velocity_signal;
    expect(def.value_schema!({ trajectory: 'pulsing', weighted_recent: 0, weighted_baseline: 0, total_recent: 0, total_baseline: 0, cursor_at: 0 }).ok).toBe(false);
    expect(def.value_schema!({ trajectory: 'steady', weighted_recent: -1, weighted_baseline: 0, total_recent: 0, total_baseline: 0, cursor_at: 0 }).ok).toBe(false);
    expect(def.value_schema!({ trajectory: 'steady', weighted_recent: 0, weighted_baseline: 0, total_recent: -1, total_baseline: 0, cursor_at: 0 }).ok).toBe(false);
  });
  it('ENGAGEMENT_VELOCITY_TRAJECTORIES enumerates accelerating / steady / decaying', () => {
    expect([...ENGAGEMENT_VELOCITY_TRAJECTORIES].sort()).toEqual([
      'accelerating',
      'decaying',
      'steady',
    ]);
    const x: EngagementVelocityTrajectory = 'steady';
    expect(ENGAGEMENT_VELOCITY_TRAJECTORIES).toContain(x);
  });
});

describe('D-139 P3 — inbound_outbound_ratio topic registration', () => {
  it('topic resolves via isEnrichmentTopic', () => {
    expect(isEnrichmentTopic('inbound_outbound_ratio')).toBe(true);
  });
  it('carries aggregate_window × scenario × forward_only lifecycle', () => {
    const def = ENRICHMENT_REGISTRY.inbound_outbound_ratio;
    expect(def.temporal_class).toBe('aggregate_window');
    expect(def.identity_aggregation).toBe('scenario');
    expect(def.lifecycle_policy).toBe('forward_only');
  });
  it('valid_scopes covers HubSpot deal + Salesforce opportunity', () => {
    const def = ENRICHMENT_REGISTRY.inbound_outbound_ratio;
    expect(def.valid_scopes).toEqual([HUBSPOT_DEAL, SALESFORCE_OPP]);
  });
  it('aggregates_from enumerates all per-type engagement scopes', () => {
    const def = ENRICHMENT_REGISTRY.inbound_outbound_ratio;
    expect([...(def.aggregates_from ?? [])].sort()).toEqual(
      [...FULL_AGGREGATES_FROM].sort(),
    );
  });
  it('default trust state = auto + pool policy = free_only', () => {
    const def = ENRICHMENT_REGISTRY.inbound_outbound_ratio;
    expect(def.default_trust_state).toBe('auto');
    expect(def.default_pool_policy).toBe('free_only');
  });
  it('aggregate window is 90d full window + axis event_time', () => {
    const def = ENRICHMENT_REGISTRY.inbound_outbound_ratio;
    expect(def.aggregate_window_axis).toBe('event_time');
    expect(def.aggregate_window_ms).toBe(90 * 24 * 60 * 60 * 1000);
  });
  it('value_schema validates a well-formed value', () => {
    const def = ENRICHMENT_REGISTRY.inbound_outbound_ratio;
    const v: InboundOutboundRatioValue = {
      inbound_count: 4,
      outbound_count: 8,
      ratio: 2.0,
      bucket: 'rep_pushing',
      cursor_at: 1714867200000,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema rejects unknown bucket', () => {
    const def = ENRICHMENT_REGISTRY.inbound_outbound_ratio;
    expect(def.value_schema!({ inbound_count: 0, outbound_count: 0, ratio: 0, bucket: 'silent', cursor_at: 0 }).ok).toBe(false);
  });
  it('value_schema rejects negative counts + ratio', () => {
    const def = ENRICHMENT_REGISTRY.inbound_outbound_ratio;
    expect(def.value_schema!({ inbound_count: -1, outbound_count: 0, ratio: 0, bucket: 'mutual', cursor_at: 0 }).ok).toBe(false);
    expect(def.value_schema!({ inbound_count: 0, outbound_count: -1, ratio: 0, bucket: 'mutual', cursor_at: 0 }).ok).toBe(false);
    expect(def.value_schema!({ inbound_count: 0, outbound_count: 0, ratio: -0.5, bucket: 'mutual', cursor_at: 0 }).ok).toBe(false);
  });
  it('INBOUND_OUTBOUND_BUCKETS enumerates rep_pushing / mutual / prospect_pulling', () => {
    expect([...INBOUND_OUTBOUND_BUCKETS].sort()).toEqual([
      'mutual',
      'prospect_pulling',
      'rep_pushing',
    ]);
    const x: InboundOutboundBucket = 'mutual';
    expect(INBOUND_OUTBOUND_BUCKETS).toContain(x);
  });
});

describe('D-139 P3 — last_meaningful_touch topic registration', () => {
  it('topic resolves via isEnrichmentTopic', () => {
    expect(isEnrichmentTopic('last_meaningful_touch')).toBe(true);
  });
  it('carries time_bound × scenario × historical lifecycle per § A.9.1', () => {
    const def = ENRICHMENT_REGISTRY.last_meaningful_touch;
    expect(def.temporal_class).toBe('time_bound');
    expect(def.identity_aggregation).toBe('scenario');
    expect(def.lifecycle_policy).toBe('historical');
  });
  it('as_of_field is last_touch_at — bistemporal stamping anchors on the touch event_at', () => {
    const def = ENRICHMENT_REGISTRY.last_meaningful_touch;
    expect(def.as_of_field).toBe('last_touch_at');
  });
  it('valid_scopes covers HubSpot deal + Salesforce opportunity', () => {
    const def = ENRICHMENT_REGISTRY.last_meaningful_touch;
    expect(def.valid_scopes).toEqual([HUBSPOT_DEAL, SALESFORCE_OPP]);
  });
  it('aggregates_from enumerates all per-type engagement scopes', () => {
    const def = ENRICHMENT_REGISTRY.last_meaningful_touch;
    expect([...(def.aggregates_from ?? [])].sort()).toEqual(
      [...FULL_AGGREGATES_FROM].sort(),
    );
  });
  it('default trust state = auto + pool policy = free_only', () => {
    const def = ENRICHMENT_REGISTRY.last_meaningful_touch;
    expect(def.default_trust_state).toBe('auto');
    expect(def.default_pool_policy).toBe('free_only');
  });
  it('value_schema validates a well-formed value with a found touch', () => {
    const def = ENRICHMENT_REGISTRY.last_meaningful_touch;
    const v: LastMeaningfulTouchValue = {
      last_touch_at: 1714780800000,
      vendor: 'hubspot',
      entity: 'email',
      authorship: 'crm_user',
      direction: 'outbound',
      cursor_at: 1714867200000,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema validates the no-touch shape (last_touch_at = 0 + all-null per-touch fields)', () => {
    const def = ENRICHMENT_REGISTRY.last_meaningful_touch;
    const v: LastMeaningfulTouchValue = {
      last_touch_at: 0,
      vendor: null,
      entity: null,
      authorship: null,
      direction: null,
      cursor_at: 1714867200000,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema rejects last_touch_at > 0 with null vendor (drift guard)', () => {
    const def = ENRICHMENT_REGISTRY.last_meaningful_touch;
    expect(def.value_schema!({
      last_touch_at: 1714780800000,
      vendor: null,
      entity: 'email',
      authorship: 'user',
      direction: 'outbound',
      cursor_at: 1714867200000,
    }).ok).toBe(false);
  });
  it('value_schema rejects unknown authorship + direction enum values', () => {
    const def = ENRICHMENT_REGISTRY.last_meaningful_touch;
    expect(def.value_schema!({
      last_touch_at: 1714780800000,
      vendor: 'hubspot',
      entity: 'email',
      authorship: 'imposter',
      direction: 'outbound',
      cursor_at: 0,
    }).ok).toBe(false);
    expect(def.value_schema!({
      last_touch_at: 1714780800000,
      vendor: 'hubspot',
      entity: 'email',
      authorship: 'user',
      direction: 'sideways',
      cursor_at: 0,
    }).ok).toBe(false);
  });
  it('value_schema rejects last_touch_at < 0', () => {
    const def = ENRICHMENT_REGISTRY.last_meaningful_touch;
    expect(def.value_schema!({
      last_touch_at: -1,
      vendor: null,
      entity: null,
      authorship: null,
      direction: null,
      cursor_at: 0,
    }).ok).toBe(false);
  });
});

describe('D-139 P3 — registry-load D-136 substrate gates', () => {
  it('all four deal-level topics declare temporal × identity × lifecycle (no missing fields)', () => {
    const topics = [
      'engagement_silence_duration',
      'engagement_velocity_signal',
      'inbound_outbound_ratio',
      'last_meaningful_touch',
    ] as const;
    for (const topic of topics) {
      const def = ENRICHMENT_REGISTRY[topic];
      expect(def.temporal_class, `${topic}.temporal_class`).toBeDefined();
      expect(def.identity_aggregation, `${topic}.identity_aggregation`).toBeDefined();
      expect(def.lifecycle_policy, `${topic}.lifecycle_policy`).toBeDefined();
      expect(def.compression_class, `${topic}.compression_class`).toBeDefined();
      expect(def.producer_kind, `${topic}.producer_kind`).toBeDefined();
      expect(def.default_trust_state, `${topic}.default_trust_state`).toBeDefined();
      expect(def.default_pool_policy, `${topic}.default_pool_policy`).toBeDefined();
      expect(def.valid_scopes, `${topic}.valid_scopes`).toBeDefined();
      expect(def.aggregates_from, `${topic}.aggregates_from`).toBeDefined();
    }
  });
  it('all three new P3 topics carry compression_class = derived', () => {
    expect(ENRICHMENT_REGISTRY.engagement_velocity_signal.compression_class).toBe('derived');
    expect(ENRICHMENT_REGISTRY.inbound_outbound_ratio.compression_class).toBe('derived');
    expect(ENRICHMENT_REGISTRY.last_meaningful_touch.compression_class).toBe('derived');
  });
  it('all three new P3 topics declare aggregate_window_fold input fingerprint composition (when applicable)', () => {
    // engagement_velocity + inbound_outbound carry the
    // aggregate_window_fold marker; last_meaningful_touch uses
    // time_bound semantics so the input-fingerprint composition is
    // implicit (per-record source hash via cursor advance).
    expect(ENRICHMENT_REGISTRY.engagement_velocity_signal.inputFingerprintComposition).toBe('aggregate_window_fold');
    expect(ENRICHMENT_REGISTRY.inbound_outbound_ratio.inputFingerprintComposition).toBe('aggregate_window_fold');
  });
  it('Codex P2 #5 fold — all four D-139 deal-level topics declare populates_coverage: true (§ A.9.3)', () => {
    expect(ENRICHMENT_REGISTRY.engagement_silence_duration.populates_coverage).toBe(true);
    expect(ENRICHMENT_REGISTRY.engagement_velocity_signal.populates_coverage).toBe(true);
    expect(ENRICHMENT_REGISTRY.inbound_outbound_ratio.populates_coverage).toBe(true);
    expect(ENRICHMENT_REGISTRY.last_meaningful_touch.populates_coverage).toBe(true);
  });
  it('Codex P2 #1 fold — all four D-139 topics enumerate the full per-type engagement scope set (10 scopes incl. salesforce.voice_call)', () => {
    const expected = [...FULL_AGGREGATES_FROM].sort();
    expect([...(ENRICHMENT_REGISTRY.engagement_silence_duration.aggregates_from ?? [])].sort()).toEqual(expected);
    expect([...(ENRICHMENT_REGISTRY.engagement_velocity_signal.aggregates_from ?? [])].sort()).toEqual(expected);
    expect([...(ENRICHMENT_REGISTRY.inbound_outbound_ratio.aggregates_from ?? [])].sort()).toEqual(expected);
    expect([...(ENRICHMENT_REGISTRY.last_meaningful_touch.aggregates_from ?? [])].sort()).toEqual(expected);
  });
});
