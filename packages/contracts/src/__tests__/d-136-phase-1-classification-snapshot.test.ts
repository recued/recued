/** D-136 Phase 1 — Classification snapshot.
 *
 *  Locks the (temporal_class, identity_aggregation, lifecycle_policy)
 *  triple for every registered topic against the audit's classification
 *  tables (audit §3-§4 + §23.3). When a future D adds a topic or
 *  amends a classification, this snapshot fails and the author has to
 *  consciously update the table.
 *
 *  Source of truth (do not edit without amending the audit):
 *    - audit §3.1: 5 stable_truth topics
 *    - audit §3.2: 7 time_bound topics
 *    - audit §3.3: 18 aggregate_window topics
 *    - audit §4.1: lifecycle_policy per topic
 *    - audit §23.3: identity_aggregation per topic (17 scenario / 13 perspective)
 *
 *  Locked decisions per audit §26 (audience-filter pass):
 *    - `embedding`           → stable_truth (Q1)
 *    - `topic_cluster`       → aggregate_window (Q1)
 *    - `attribution_signal`  → stable_truth (Q1)
 *
 *  Also asserts the registry-level wrapper
 *  `assertEnrichmentLifecycleDefaults` doesn't throw on any registered
 *  topic — i.e. the entire registry passes every validator gate. */

import { describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  assertEnrichmentLifecycleDefaults,
  type EnrichmentTopic,
  type IdentityAggregation,
  type LifecyclePolicy,
  type TemporalClass,
} from '../index.js';

interface ClassificationRow {
  temporal_class: TemporalClass;
  identity_aggregation: IdentityAggregation;
  lifecycle_policy: Exclude<LifecyclePolicy, 'manual_pinned'>;
}

const EXPECTED_CLASSIFICATIONS: Record<EnrichmentTopic, ClassificationRow> = {
  // ── stable_truth (5) ─────────────────────────────────────────────
  purpose:               { temporal_class: 'stable_truth',     identity_aggregation: 'scenario',    lifecycle_policy: 'recompute_on_drift' },
  summary:               { temporal_class: 'stable_truth',     identity_aggregation: 'scenario',    lifecycle_policy: 'recompute_on_drift' },
  action_items:          { temporal_class: 'stable_truth',     identity_aggregation: 'scenario',    lifecycle_policy: 'recompute_on_drift' },
  embedding:             { temporal_class: 'stable_truth',     identity_aggregation: 'scenario',    lifecycle_policy: 'recompute_on_drift' },
  attribution_signal:    { temporal_class: 'stable_truth',     identity_aggregation: 'scenario',    lifecycle_policy: 'forward_only' },
  transcript:            { temporal_class: 'stable_truth',     identity_aggregation: 'scenario',    lifecycle_policy: 'forward_only' },
  caption:               { temporal_class: 'stable_truth',     identity_aggregation: 'scenario',    lifecycle_policy: 'forward_only' },
  extracted_text:        { temporal_class: 'stable_truth',     identity_aggregation: 'scenario',    lifecycle_policy: 'forward_only' },

  // ── time_bound (15) ──────────────────────────────────────────────
  company:                              { temporal_class: 'time_bound', identity_aggregation: 'perspective', lifecycle_policy: 'historical' },
  role:                                 { temporal_class: 'time_bound', identity_aggregation: 'perspective', lifecycle_policy: 'historical' },
  preparation_notes:                    { temporal_class: 'time_bound', identity_aggregation: 'scenario',    lifecycle_policy: 'ttl' },
  related_threads:                      { temporal_class: 'time_bound', identity_aggregation: 'scenario',    lifecycle_policy: 'ttl' },
  deal_health_score:                    { temporal_class: 'time_bound', identity_aggregation: 'scenario',    lifecycle_policy: 'historical' },
  lifecycle_stage_inferred:             { temporal_class: 'time_bound', identity_aggregation: 'scenario',    lifecycle_policy: 'historical' },
  lifecycle_stage_inferred_salesforce:  { temporal_class: 'time_bound', identity_aggregation: 'scenario',    lifecycle_policy: 'historical' },
  // D-139 P4 — cross-entity time_bound topics (4 scenarios + 1 perspective).
  meeting_to_followup_lag:              { temporal_class: 'time_bound', identity_aggregation: 'scenario',    lifecycle_policy: 'historical' },
  out_of_band_engagement:               { temporal_class: 'time_bound', identity_aggregation: 'scenario',    lifecycle_policy: 'historical' },
  account_reentry_signal:               { temporal_class: 'time_bound', identity_aggregation: 'scenario',    lifecycle_policy: 'historical' },
  multi_account_contact:                { temporal_class: 'time_bound', identity_aggregation: 'perspective', lifecycle_policy: 'historical' },
  // D-139 P5 — AI-surface canary `next_best_action`.
  next_best_action:                     { temporal_class: 'time_bound', identity_aggregation: 'scenario',    lifecycle_policy: 'historical' },
  // D-139 P6.B — post-substrate canary `commitment_tracker`.
  commitment_tracker:                   { temporal_class: 'time_bound', identity_aggregation: 'perspective', lifecycle_policy: 'historical' },

  // ── aggregate_window (23) ────────────────────────────────────────
  contact_timeline_rollup:        { temporal_class: 'aggregate_window', identity_aggregation: 'perspective', lifecycle_policy: 'forward_only' },
  calendar_event_rollup:          { temporal_class: 'aggregate_window', identity_aggregation: 'scenario',    lifecycle_policy: 'ttl' },
  meeting_reschedule_pattern:     { temporal_class: 'aggregate_window', identity_aggregation: 'perspective', lifecycle_policy: 'forward_only' },
  thread_signals:                 { temporal_class: 'aggregate_window', identity_aggregation: 'scenario',    lifecycle_policy: 'forward_only' },
  behavioral_signature:           { temporal_class: 'aggregate_window', identity_aggregation: 'perspective', lifecycle_policy: 'forward_only' },
  reply_patterns:                 { temporal_class: 'aggregate_window', identity_aggregation: 'perspective', lifecycle_policy: 'forward_only' },
  attendee_patterns:              { temporal_class: 'aggregate_window', identity_aggregation: 'perspective', lifecycle_policy: 'forward_only' },
  meeting_frequency:              { temporal_class: 'aggregate_window', identity_aggregation: 'perspective', lifecycle_policy: 'forward_only' },
  connection_health_trend:        { temporal_class: 'aggregate_window', identity_aggregation: 'scenario',    lifecycle_policy: 'recompute_on_drift' },
  connection_last_used_pattern:   { temporal_class: 'aggregate_window', identity_aggregation: 'scenario',    lifecycle_policy: 'recompute_on_drift' },
  connection_optimal_batch_size:  { temporal_class: 'aggregate_window', identity_aggregation: 'scenario',    lifecycle_policy: 'recompute_on_drift' },
  deal_velocity_signal:           { temporal_class: 'aggregate_window', identity_aggregation: 'scenario',    lifecycle_policy: 'forward_only' },
  engagement_score_per_contact:   { temporal_class: 'aggregate_window', identity_aggregation: 'scenario',    lifecycle_policy: 'forward_only' },
  engagement_silence_duration:    { temporal_class: 'time_bound',       identity_aggregation: 'scenario',    lifecycle_policy: 'historical' },
  engagement_velocity_signal:     { temporal_class: 'aggregate_window', identity_aggregation: 'scenario',    lifecycle_policy: 'forward_only' },
  inbound_outbound_ratio:         { temporal_class: 'aggregate_window', identity_aggregation: 'scenario',    lifecycle_policy: 'forward_only' },
  last_meaningful_touch:          { temporal_class: 'time_bound',       identity_aggregation: 'scenario',    lifecycle_policy: 'historical' },
  topic_cluster:                  { temporal_class: 'aggregate_window', identity_aggregation: 'perspective', lifecycle_policy: 'forward_only' },
  working_group:                  { temporal_class: 'aggregate_window', identity_aggregation: 'perspective', lifecycle_policy: 'forward_only' },
  organization:                   { temporal_class: 'aggregate_window', identity_aggregation: 'perspective', lifecycle_policy: 'forward_only' },
  semantic_cluster:               { temporal_class: 'aggregate_window', identity_aggregation: 'perspective', lifecycle_policy: 'forward_only' },
  confidence_drift_signal:        { temporal_class: 'aggregate_window', identity_aggregation: 'perspective', lifecycle_policy: 'historical' },
  // D-139 P4 — cross-entity aggregate_window topics.
  account_engagement_breadth:     { temporal_class: 'aggregate_window', identity_aggregation: 'scenario',    lifecycle_policy: 'forward_only' },
  champion_deal_count:            { temporal_class: 'aggregate_window', identity_aggregation: 'perspective', lifecycle_policy: 'forward_only' },
  // D-139 P5 — AI-surface canary `engagement_sentiment_trend`.
  engagement_sentiment_trend:     { temporal_class: 'aggregate_window', identity_aggregation: 'scenario',    lifecycle_policy: 'forward_only' },

  // ── D-145 PA9 — work-entity producers (8) ───────────────────────
  commitment_followthrough_score:    { temporal_class: 'stable_truth',     identity_aggregation: 'scenario', lifecycle_policy: 'recompute_on_drift' },
  commitment_imbalance:              { temporal_class: 'aggregate_window', identity_aggregation: 'scenario', lifecycle_policy: 'forward_only' },
  outbound_commitment_overdue_count: { temporal_class: 'stable_truth',     identity_aggregation: 'scenario', lifecycle_policy: 'recompute_on_drift' },
  task_completion_velocity:          { temporal_class: 'stable_truth',     identity_aggregation: 'scenario', lifecycle_policy: 'recompute_on_drift' },
  task_signal_density_per_thread:    { temporal_class: 'aggregate_window', identity_aggregation: 'scenario', lifecycle_policy: 'forward_only' },
  project_stall_signal:              { temporal_class: 'stable_truth',     identity_aggregation: 'scenario', lifecycle_policy: 'recompute_on_drift' },
  project_velocity:                  { temporal_class: 'stable_truth',     identity_aggregation: 'scenario', lifecycle_policy: 'recompute_on_drift' },
  note_relevance_decay:              { temporal_class: 'aggregate_window', identity_aggregation: 'scenario', lifecycle_policy: 'forward_only' },

  // ── D-145 PA9 — engine + reliability producers (7) ──────────────
  open_loop_pressure:                { temporal_class: 'stable_truth',     identity_aggregation: 'scenario', lifecycle_policy: 'recompute_on_drift' },
  commitment_reliability_band:       { temporal_class: 'stable_truth',     identity_aggregation: 'scenario', lifecycle_policy: 'recompute_on_drift' },
  preferred_channel_by_contact:      { temporal_class: 'aggregate_window', identity_aggregation: 'scenario', lifecycle_policy: 'forward_only' },
  project_next_action_gap:           { temporal_class: 'stable_truth',     identity_aggregation: 'scenario', lifecycle_policy: 'recompute_on_drift' },
  task_duplicate_candidate:          { temporal_class: 'stable_truth',     identity_aggregation: 'scenario', lifecycle_policy: 'recompute_on_drift' },
  source_freshness_degradation:      { temporal_class: 'stable_truth',     identity_aggregation: 'scenario', lifecycle_policy: 'recompute_on_drift' },
  context_packet_quality:            { temporal_class: 'stable_truth',     identity_aggregation: 'scenario', lifecycle_policy: 'recompute_on_drift' },
};

describe('D-136 P1 — classification snapshot (audit §3-§4 + §23.3)', () => {
  it('every registered topic carries the expected classification triple', () => {
    for (const [topic, expected] of Object.entries(EXPECTED_CLASSIFICATIONS)) {
      const def = ENRICHMENT_REGISTRY[topic as EnrichmentTopic];
      expect(def, `topic '${topic}' missing from ENRICHMENT_REGISTRY`).toBeDefined();
      expect(
        {
          temporal_class: def.temporal_class,
          identity_aggregation: def.identity_aggregation,
          lifecycle_policy: def.lifecycle_policy,
        },
        `topic '${topic}' classification drifted from audit table`,
      ).toEqual(expected);
    }
  });

  it('expected table covers every registered topic (no orphan entries)', () => {
    const registryTopics = new Set(Object.keys(ENRICHMENT_REGISTRY));
    const expectedTopics = new Set(Object.keys(EXPECTED_CLASSIFICATIONS));
    expect(expectedTopics).toEqual(registryTopics);
  });

  it('exactly 19 stable_truth / 15 time_bound / 27 aggregate_window', () => {
    // D-139 P1a.1 added `engagement_silence_duration` (time_bound ×
    // scenario × historical). D-139 P3 adds `engagement_velocity_signal`
    // + `inbound_outbound_ratio` (both aggregate_window × scenario ×
    // forward_only) + `last_meaningful_touch` (time_bound × scenario ×
    // historical). D-139 P4 adds 4 time_bound (meeting_to_followup_lag +
    // out_of_band_engagement + account_reentry_signal scenarios +
    // multi_account_contact perspective) + 2 aggregate_window
    // (account_engagement_breadth scenario + champion_deal_count
    // perspective). D-139 P5 adds 1 aggregate_window
    // (engagement_sentiment_trend) + 1 time_bound (next_best_action) —
    // both AI-surface scenario topics. D-139 P6.B adds
    // `commitment_tracker` (time_bound × perspective × historical) —
    // AI-surface post-substrate canary. D-145 PA9 adds 16 producers:
    // 12 stable_truth (3 emits_confidence work-entity:
    // commitment_followthrough_score / task_completion_velocity /
    // project_velocity + outbound_commitment_overdue_count +
    // project_stall_signal + 7 engine + reliability:
    // open_loop_pressure / commitment_reliability_band /
    // project_next_action_gap / task_duplicate_candidate /
    // source_freshness_degradation / standing_instruction_conflict /
    // context_packet_quality emits_confidence) + 4 aggregate_window
    // (commitment_imbalance + task_signal_density_per_thread +
    // note_relevance_decay + preferred_channel_by_contact). D-172 P6
    // adds file-enrichment declaration-only topics: transcript /
    // caption / extracted_text (stable_truth).
    const counts = { stable_truth: 0, time_bound: 0, aggregate_window: 0 };
    for (const def of Object.values(ENRICHMENT_REGISTRY)) {
      counts[def.temporal_class as TemporalClass] += 1;
    }
    expect(counts).toEqual({ stable_truth: 19, time_bound: 15, aggregate_window: 27 });
  });

  it('exactly 45 scenario / 16 perspective', () => {
    // D-139 P1a.1 — engagement_silence_duration is scenario. D-139 P3
    // adds three more scenario topics (engagement_velocity_signal +
    // inbound_outbound_ratio + last_meaningful_touch). D-139 P4 adds
    // 4 scenarios (meeting_to_followup_lag + out_of_band_engagement +
    // account_engagement_breadth + account_reentry_signal) +
    // 2 perspectives (champion_deal_count + multi_account_contact).
    // D-139 P5 — engagement_sentiment_trend + next_best_action are
    // both scenario. D-139 P6.B — commitment_tracker is perspective
    // (per-contact perspective per spec § A.9.2c). D-145 PA9 — 16
    // producers all scenario per spec § A.7.1 + § A.7.2. D-172 P6
    // adds three file-enrichment scenario topics.
    const counts = { scenario: 0, perspective: 0 };
    for (const def of Object.values(ENRICHMENT_REGISTRY)) {
      counts[def.identity_aggregation as IdentityAggregation] += 1;
    }
    expect(counts).toEqual({ scenario: 45, perspective: 16 });
  });

  it('lifecycle_policy distribution: 26 forward_only / 14 historical / 18 recompute_on_drift / 3 ttl', () => {
    // D-136 P4 — `confidence_drift_signal` flipped from
    // `'recompute_on_drift'` to `'historical'` so PSI trajectory is
    // preserved across cycles. D-139 P1a.1 — engagement_silence_duration
    // adds another historical row. D-139 P3 — engagement_velocity_signal
    // + inbound_outbound_ratio bump forward_only by 2;
    // last_meaningful_touch bumps historical by 1. D-139 P4 — bumps
    // forward_only by 2 (account_engagement_breadth +
    // champion_deal_count) and historical by 4
    // (meeting_to_followup_lag + out_of_band_engagement +
    // account_reentry_signal + multi_account_contact). D-139 P5 —
    // engagement_sentiment_trend bumps forward_only by 1; next_best_action
    // bumps historical by 1. D-139 P6.B — commitment_tracker bumps
    // historical by 1 (post-substrate canary; per-contact perspective).
    // D-145 PA9 — bumps forward_only by 4 (4 aggregate_window
    // producers) + recompute_on_drift by 12 (12 stable_truth producers).
    // D-172 P6 adds three stable_truth file-enrichment topics with
    // forward_only lifecycle.
    const counts = {
      forward_only: 0,
      historical: 0,
      recompute_on_drift: 0,
      ttl: 0,
    };
    for (const def of Object.values(ENRICHMENT_REGISTRY)) {
      const policy = def.lifecycle_policy as keyof typeof counts;
      counts[policy] += 1;
    }
    expect(counts).toEqual({
      forward_only: 26,
      historical: 14,
      recompute_on_drift: 18,
      ttl: 3,
    });
  });
});

describe('D-136 P1 — emits_confidence post-revoke state (D-279 narrowed)', () => {
  // D-136 P5b narrowed PSI eligibility 9→3 (purpose / summary /
  // action_items). D-145 PA9 added 4 PSI-eligible producers per spec
  // § A.7.2: commitment_followthrough_score / task_completion_velocity /
  // project_velocity (work-entity) + context_packet_quality (engine +
  // reliability). That made 7.
  //
  // ⛔⛔ D-279 REMOVED `summary` AND `action_items`, 7 → 5, because the
  // flag claimed a value their producers CANNOT PRODUCE:
  //
  //    summary       persists `AiSummarizeOutput` = { summary, key_points };
  //                  the contracted ai-summarize output has no confidence
  //                  field at all.
  //    action_items  declares `'llm.fields': ['action_items']` — one field —
  //                  and stores `{ action_items }`.
  //
  // `confidenceEmittingEnrichmentTopics()` fed that claim to the D-133
  // drift producer, whose per-topic query filters on
  // `json_extract(value, '$.confidence') IS NOT NULL` — a predicate no row
  // of either topic could ever match. Two of the three topics D-133's own
  // header names as its PSI surfaces were structurally dead.
  //
  // 🔑 A flag is a CLAIM ABOUT THE DATA, and nothing was checking it
  // against the producer that writes the data. `context_packet_quality`
  // stays: it has no producer yet, so its flag is a forward declaration
  // consistent with its D-145 PA9 `confidence_kind` declaration, not a
  // claim contradicted by shipped code.
  const EXPECTED_PSI_TOPICS: ReadonlyArray<EnrichmentTopic> = [
    'purpose',
    'commitment_followthrough_score',
    'task_completion_velocity',
    'project_velocity',
    'context_packet_quality',
  ];

  it('PSI topics post-D-279 = 5 emits_confidence flagged topics', () => {
    const flagged: string[] = [];
    for (const [topic, def] of Object.entries(ENRICHMENT_REGISTRY)) {
      if ((def as { emits_confidence?: boolean }).emits_confidence === true) {
        flagged.push(topic);
      }
    }
    expect(flagged.sort()).toEqual([...EXPECTED_PSI_TOPICS].sort());
  });
});

describe('D-136 P1 — assertEnrichmentLifecycleDefaults passes for every registered topic', () => {
  it('validator throws on no topic in the registry', () => {
    for (const topic of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
      expect(() => assertEnrichmentLifecycleDefaults(topic), `topic '${topic}' fails the lifecycle validator`).not.toThrow();
    }
  });
});
