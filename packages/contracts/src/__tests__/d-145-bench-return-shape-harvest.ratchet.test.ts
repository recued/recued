/** Bench return-shape harvest ratchet.
 *
 *  Locks the invariant that every topic carried by the bench catalog
 *  (`recued-enrichment-benchmark/scenario-engine/src/enrichment-
 *  episodes/catalog.js`) also carries a non-empty `return_shape: string`
 *  on its `ENRICHMENT_REGISTRY` entry — the bench is the source of truth
 *  for REF<entity> annotations, and recued's registry must mirror them
 *  so LLM-facing surfaces (`registry.describe` / MCP tool descriptions /
 *  catalog renderings) carry consistent shape metadata.
 *
 *  Why the topic list lives inline. The bench repo is a sibling, not a
 *  package dependency, and we don't want the ratchet to break under
 *  bench file moves. The 41-topic list below is the harvested set as of
 *  2026-05-27 — when a future bench addition lands, this list grows by
 *  hand at harvest time + the ratchet starts failing for the new entry
 *  until its `return_shape` is added to the registry.
 *
 *  The 16 PA9 producers (commitment_followthrough_score / etc.) are
 *  intentionally OUT of scope here — they carry `return_shape` on
 *  their per-topic `EnrichmentDeclaration` files in
 *  `packages/contracts/src/enrichment-declarations/`, not on the
 *  registry entry. The `d-164-phase-2-producer-audit.ratchet.test.ts`
 *  guards that layer. */

import { describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type EnrichmentDefinition,
  type EnrichmentTopic,
} from '../enrichment-registry.js';

/** `ENRICHMENT_REGISTRY` is `as const satisfies Record<string,
 *  EnrichmentDefinition>` — the narrowed literal type for each entry
 *  drops optional properties that the entry doesn't declare, so
 *  reading `def.return_shape` on a non-declaring entry would be a TS
 *  error. The cast widens the narrowed entry back to the parent
 *  contract type so the optional `return_shape` slot is reachable
 *  consistently across all 60-ish entries. */
const asDef = (topic: EnrichmentTopic): EnrichmentDefinition | undefined =>
  ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition | undefined;

/** Topics the bench catalog declares a `return_shape` for. Harvested
 *  verbatim from `recued-enrichment-benchmark/scenario-engine/src/
 *  enrichment-episodes/catalog.js` on 2026-05-27 (41 topics). */
const BENCH_TOPICS: ReadonlyArray<EnrichmentTopic> = [
  'contact_timeline_rollup',
  'calendar_event_rollup',
  'meeting_reschedule_pattern',
  'thread_signals',
  'embedding',
  'purpose',
  'summary',
  'action_items',
  'behavioral_signature',
  'reply_patterns',
  'attendee_patterns',
  'meeting_frequency',
  'company',
  'role',
  'preparation_notes',
  'related_threads',
  'connection_health_trend',
  'connection_last_used_pattern',
  'connection_optimal_batch_size',
  'deal_health_score',
  'deal_velocity_signal',
  'engagement_score_per_contact',
  'engagement_silence_duration',
  'engagement_velocity_signal',
  'inbound_outbound_ratio',
  'last_meaningful_touch',
  'meeting_to_followup_lag',
  'out_of_band_engagement',
  'account_engagement_breadth',
  'account_reentry_signal',
  'champion_deal_count',
  'multi_account_contact',
  'engagement_sentiment_trend',
  'next_best_action',
  'commitment_tracker',
  'lifecycle_stage_inferred',
  'attribution_signal',
  'topic_cluster',
  'working_group',
  'organization',
  'confidence_drift_signal',
];

describe('Bench return_shape harvest', () => {
  it('lists exactly 41 bench topics', () => {
    expect(BENCH_TOPICS).toHaveLength(41);
  });

  it('every bench topic carries a non-empty return_shape on its registry entry', () => {
    const missing: string[] = [];
    for (const topic of BENCH_TOPICS) {
      const def = asDef(topic);
      if (def === undefined) {
        missing.push(`${topic}: not in ENRICHMENT_REGISTRY`);
        continue;
      }
      if (typeof def.return_shape !== 'string' || def.return_shape.length === 0) {
        missing.push(`${topic}: return_shape is absent or empty`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every bench topic exists in ENRICHMENT_REGISTRY (no orphan entries)', () => {
    const orphans: string[] = [];
    for (const topic of BENCH_TOPICS) {
      if (ENRICHMENT_REGISTRY[topic] === undefined) {
        orphans.push(topic);
      }
    }
    expect(orphans).toEqual([]);
  });

  it('bench topics do not overlap with PA9 declaration files', () => {
    // PA9's 16 declarations carry `return_shape` on their
    // `EnrichmentDeclaration` files in
    // `packages/contracts/src/enrichment-declarations/`, NOT on the
    // registry entry. Bench-harvest topics are a disjoint set —
    // harvested onto the registry directly. This invariant guards
    // against accidental double-coverage that would let one source
    // of truth drift from the other.
    const PA9_TOPICS = new Set<string>([
      'commitment_followthrough_score',
      'commitment_imbalance',
      'commitment_reliability_band',
      'context_packet_quality',
      'note_relevance_decay',
      'open_loop_pressure',
      'outbound_commitment_overdue_count',
      'preferred_channel_by_contact',
      'project_next_action_gap',
      'project_stall_signal',
      'project_velocity',
      'source_freshness_degradation',
      'standing_instruction_conflict',
      'task_completion_velocity',
      'task_duplicate_candidate',
      'task_signal_density_per_thread',
    ]);
    const overlap = BENCH_TOPICS.filter((t) => PA9_TOPICS.has(t));
    expect(overlap).toEqual([]);
  });

  it('REF<X> annotations appear on at least one bench return_shape', () => {
    // Smoke test that the REF convention actually landed — guards
    // against a harvest pass that copies the shape string but loses
    // the REF<X> markers via accidental find-replace.
    let withRef = 0;
    for (const topic of BENCH_TOPICS) {
      const def = asDef(topic);
      if (def?.return_shape?.includes('REF<')) withRef += 1;
    }
    expect(withRef).toBeGreaterThan(0);
  });
});
