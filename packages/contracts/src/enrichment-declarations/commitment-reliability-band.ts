/** D-145 PA9 — `commitment_reliability_band` declaration. Spec § A.7.2.
 *  Banded over `commitment_followthrough_score` — `derived_band`
 *  confidence kind (the source IS PSI-eligible; bands are not). */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const COMMITMENT_RELIABILITY_BAND_DECLARATION: EnrichmentDeclaration = {
  topic: 'commitment_reliability_band',
  operates_on: ['data.enrichment.commitment_followthrough_score'],
  event_time_field: 'commitment_followthrough_score.computed_at',
  window: { kind: 'rolling_days', n: 90 },
  producer_kind: 'housekeeping',
  temporal_class: 'aggregate_window',
  identity_aggregation: 'scenario',
  sample_floor: 30,
  confidence_kind: 'derived_band',
  coverage: 'computed',
  source_degradation_reasons: ['sample_floor_unmet'],
  privacy_class: 'sensitive',
  mcp_exposed_default: false,
  invalidation_triggers: ['data.enrichment.commitment_followthrough_score.updated'],
  benchmark_scenarios: ['scn_castellanos_band_reliable', 'scn_castellanos_band_risky'],
  return_shape:
    "{ contact: REF<contacts>, band: 'insufficient_data' | 'reliable' | 'mixed' | 'risky', source_score: number | null, computed_at: number }",
  suggest_directive: {
    tool: 'enrichment.search',
    kind: 'commitment_followthrough_score',
    hint: 'Look up the source commitment_followthrough_score this band derives from to assess reliability directly.',
  },
  concurrency_safe: true,
};
