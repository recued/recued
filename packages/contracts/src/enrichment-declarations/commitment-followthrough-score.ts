/** D-145 PA9 — `commitment_followthrough_score` declaration.
 *  Spec § A.7.1 + § A.7.5. PSI-eligible per A.7.2 (3 + 1 narrowing). */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const COMMITMENT_FOLLOWTHROUGH_SCORE_DECLARATION: EnrichmentDeclaration = {
  topic: 'commitment_followthrough_score',
  operates_on: ['data.contact', 'data.commitment'],
  event_time_field: 'commitment.state_changed_at',
  window: { kind: 'rolling_days', n: 90 },
  producer_kind: 'housekeeping',
  temporal_class: 'aggregate_window',
  identity_aggregation: 'scenario',
  sample_floor: 30,
  confidence_kind: 'emits_confidence',
  coverage: 'computed',
  source_degradation_reasons: ['sample_floor_unmet', 'authorship_unknown'],
  privacy_class: 'sensitive',
  mcp_exposed_default: false,
  invalidation_triggers: ['data.commitment.state_changed', 'data.commitment.created'],
  benchmark_scenarios: [
    'scn_castellanos_followthrough_basic',
    'scn_castellanos_followthrough_thin_data',
  ],
  return_shape:
    '{ contact: REF<contacts>, score: number, sample_count: number, confidence: number, computed_at: number }',
  suggest_directive: {
    tool: 'entity.query',
    kind: 'commitment',
    hint: "List the contact's commitments over the rolling window to derive followthrough manually.",
  },
  concurrency_safe: true,
};
