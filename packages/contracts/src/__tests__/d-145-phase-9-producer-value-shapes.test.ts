/** D-145 PA9 — producer value-shape correctness tests.
 *
 *  Spec § PA9 acceptance: producer correctness with fixture entities,
 *  PSI calibration, cascade invalidation across producers,
 *  source_freshness_degradation hourly cadence + reactive on connection
 *  state change.
 *
 *  PA9's substrate-only deliverable is the registry entries +
 *  declarations (the actual producer compute logic lands in PB).
 *  The fixture-entity tests here exercise the registry-side
 *  value_schema validators against representative valid + invalid
 *  inputs so producer authors at PB get a clear schema contract. */

import { describe, expect, it } from 'vitest';

import {
  COMMITMENT_IMBALANCE_SIGNALS,
  COMMITMENT_RELIABILITY_BANDS,
  D145_PRODUCER_TOPICS,
  ENRICHMENT_REGISTRY,
  PREFERRED_CHANNELS,
  TASK_DEDUPE_CONFIDENCES,
  type EnrichmentTopic,
} from '../index.js';

const validate = (topic: EnrichmentTopic, value: unknown) =>
  ENRICHMENT_REGISTRY[topic].value_schema(value);

describe('D-145 PA9 — value_schema accepts valid inputs', () => {
  it('commitment_followthrough_score accepts {score, sample_count, confidence, computed_at}', () => {
    const result = validate('commitment_followthrough_score', {
      score: 0.85,
      sample_count: 42,
      confidence: 0.78,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('commitment_imbalance accepts inbound_count/outbound_count/imbalance_signal', () => {
    const result = validate('commitment_imbalance', {
      inbound_count: 12,
      outbound_count: 8,
      imbalance_signal: 'inbound_heavy',
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('outbound_commitment_overdue_count accepts {count, oldest_overdue_at, computed_at}', () => {
    const result = validate('outbound_commitment_overdue_count', {
      count: 7,
      oldest_overdue_at: 1715000000000,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('outbound_commitment_overdue_count accepts oldest_overdue_at: null when count is 0', () => {
    const result = validate('outbound_commitment_overdue_count', {
      count: 0,
      oldest_overdue_at: null,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('task_completion_velocity accepts {score, sample_count, confidence, computed_at} (score normalized to 0..1)', () => {
    // PSI-eligible producers emit a 0..1 score field. Velocity-style
    // producers normalize raw counts to a bounded score (e.g.
    // tasks-per-period / max-tasks-per-period); per-producer normalization
    // lands in PB. The schema accepts any finite number; bounded-range
    // assertion lives on the producer.
    const result = validate('task_completion_velocity', {
      score: 0.42,
      sample_count: 40,
      confidence: 0.65,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('task_signal_density_per_thread accepts {density, signal_count, computed_at}', () => {
    const result = validate('task_signal_density_per_thread', {
      density: 0.42,
      signal_count: 5,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('project_stall_signal accepts {stalled, signals, last_activity_at, computed_at}', () => {
    const result = validate('project_stall_signal', {
      stalled: true,
      signals: ['no_open_tasks_30d', 'no_recent_commitment'],
      last_activity_at: 1714000000000,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('project_velocity accepts {score, sample_count, confidence, computed_at}', () => {
    const result = validate('project_velocity', {
      score: 0.7,
      sample_count: 30,
      confidence: 0.8,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('note_relevance_decay accepts {decay_score, last_access_at, computed_at}', () => {
    const result = validate('note_relevance_decay', {
      decay_score: 0.3,
      last_access_at: 1714000000000,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('open_loop_pressure accepts {pressure_score, open_count, age_weighted_score, computed_at}', () => {
    const result = validate('open_loop_pressure', {
      pressure_score: 0.6,
      open_count: 9,
      age_weighted_score: 14.5,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('commitment_reliability_band accepts {band, source_score, computed_at}', () => {
    const result = validate('commitment_reliability_band', {
      band: 'reliable',
      source_score: 0.85,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('preferred_channel_by_contact accepts {preference, score_breakdown, computed_at}', () => {
    const result = validate('preferred_channel_by_contact', {
      preference: 'email_preferred',
      score_breakdown: { email: 0.7, call: 0.2, meeting: 0.1 },
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('project_next_action_gap accepts {gap_present, gap_signals, computed_at}', () => {
    const result = validate('project_next_action_gap', {
      gap_present: true,
      gap_signals: ['no_open_task', 'no_recent_note'],
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('task_duplicate_candidate accepts {duplicate_candidate_set, dedupe_confidence, computed_at}', () => {
    const result = validate('task_duplicate_candidate', {
      duplicate_candidate_set: ['task_a', 'task_b'],
      dedupe_confidence: 'probable',
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('source_freshness_degradation accepts {degraded, reasons, last_seen_at, computed_at}', () => {
    const result = validate('source_freshness_degradation', {
      degraded: true,
      reasons: ['quota_suspended'],
      last_seen_at: 1715000000000,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });

  it('context_packet_quality accepts {score, sample_count, confidence, computed_at}', () => {
    const result = validate('context_packet_quality', {
      score: 0.75,
      sample_count: 60,
      confidence: 0.82,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(true);
  });
});

describe('D-145 PA9 — value_schema rejects malformed inputs', () => {
  it('commitment_followthrough_score rejects missing fields', () => {
    const result = validate('commitment_followthrough_score', {
      score: 0.85,
      // sample_count missing
      confidence: 0.7,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(false);
  });

  it('commitment_imbalance rejects unknown imbalance_signal', () => {
    const result = validate('commitment_imbalance', {
      inbound_count: 5,
      outbound_count: 5,
      imbalance_signal: 'mostly_aligned',
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(false);
  });

  it('commitment_reliability_band rejects unknown band', () => {
    const result = validate('commitment_reliability_band', {
      band: 'sometimes',
      source_score: 0.5,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(false);
  });

  it('preferred_channel_by_contact rejects unknown preference', () => {
    const result = validate('preferred_channel_by_contact', {
      preference: 'fax_preferred',
      score_breakdown: { fax: 1 },
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(false);
  });

  it('preferred_channel_by_contact rejects non-numeric score_breakdown values', () => {
    const result = validate('preferred_channel_by_contact', {
      preference: 'email_preferred',
      score_breakdown: { email: 'high' },
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(false);
  });

  it('task_duplicate_candidate rejects unknown dedupe_confidence', () => {
    const result = validate('task_duplicate_candidate', {
      duplicate_candidate_set: ['task_a'],
      dedupe_confidence: 'maybe',
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(false);
  });

  it('source_freshness_degradation rejects non-boolean degraded', () => {
    const result = validate('source_freshness_degradation', {
      degraded: 'yes',
      reasons: [],
      last_seen_at: 1715000000000,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(false);
  });

  it('project_stall_signal rejects non-boolean stalled', () => {
    const result = validate('project_stall_signal', {
      stalled: 1,
      signals: [],
      last_activity_at: null,
      computed_at: 1715251200000,
    });
    expect(result.ok).toBe(false);
  });
});

describe('D-145 PA9 — closed-list enum membership', () => {
  it('COMMITMENT_IMBALANCE_SIGNALS = aligned / inbound_heavy / outbound_heavy / insufficient_data', () => {
    expect([...COMMITMENT_IMBALANCE_SIGNALS].sort()).toEqual([
      'aligned',
      'inbound_heavy',
      'insufficient_data',
      'outbound_heavy',
    ]);
  });

  it('COMMITMENT_RELIABILITY_BANDS = insufficient_data / reliable / mixed / risky', () => {
    expect([...COMMITMENT_RELIABILITY_BANDS].sort()).toEqual([
      'insufficient_data',
      'mixed',
      'reliable',
      'risky',
    ]);
  });

  it('PREFERRED_CHANNELS = 5 closed values', () => {
    expect([...PREFERRED_CHANNELS].sort()).toEqual([
      'call_preferred',
      'email_preferred',
      'meeting_preferred',
      'mixed_no_clear_preference',
      'text_preferred',
    ]);
  });

  it('TASK_DEDUPE_CONFIDENCES = exact / probable / low', () => {
    expect([...TASK_DEDUPE_CONFIDENCES].sort()).toEqual(['exact', 'low', 'probable']);
  });
});

describe('D-145 PA9 — registry classifications match per-producer wiring', () => {
  it('every D-145 producer carries a value_schema (not undefined)', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      const def = ENRICHMENT_REGISTRY[topic as EnrichmentTopic];
      expect(def, `topic '${topic}' missing from ENRICHMENT_REGISTRY`).toBeDefined();
      expect(def.value_schema, `topic '${topic}' has no value_schema`).toBeDefined();
    }
  });

  it('PSI-eligible producers carry registry-side emits_confidence: true', () => {
    const psiEligible = [
      'commitment_followthrough_score',
      'task_completion_velocity',
      'project_velocity',
      'context_packet_quality',
    ] as const;
    for (const topic of psiEligible) {
      const def = ENRICHMENT_REGISTRY[topic];
      expect((def as { emits_confidence?: boolean }).emits_confidence).toBe(true);
    }
  });

  it('non-PSI-eligible D-145 producers carry NO emits_confidence flag', () => {
    const nonPsi = D145_PRODUCER_TOPICS.filter(
      (t) =>
        t !== 'commitment_followthrough_score'
        && t !== 'task_completion_velocity'
        && t !== 'project_velocity'
        && t !== 'context_packet_quality',
    );
    for (const topic of nonPsi) {
      const def = ENRICHMENT_REGISTRY[topic as EnrichmentTopic];
      expect((def as { emits_confidence?: boolean }).emits_confidence).toBeFalsy();
    }
  });

  it('D-145 producers default to free_only pool policy (deterministic + band; PSI calibration is the producer-version drift signal, not LLM cost)', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      const def = ENRICHMENT_REGISTRY[topic as EnrichmentTopic];
      expect(
        (def as { default_pool_policy?: string }).default_pool_policy,
        `topic '${topic}' should default to 'free_only'`,
      ).toBe('free_only');
    }
  });

  it('D-145 producers default to auto trust state (per D-132 deterministic + band)', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      const def = ENRICHMENT_REGISTRY[topic as EnrichmentTopic];
      expect(
        (def as { default_trust_state?: string }).default_trust_state,
        `topic '${topic}' should default to 'auto'`,
      ).toBe('auto');
    }
  });
});
