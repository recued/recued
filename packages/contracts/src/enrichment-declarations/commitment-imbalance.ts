/** D-145 PA9 — `commitment_imbalance` declaration. Spec § A.7.1. */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const COMMITMENT_IMBALANCE_DECLARATION: EnrichmentDeclaration = {
  topic: 'commitment_imbalance',
  operates_on: ['data.contact', 'data.commitment'],
  event_time_field: 'commitment.created_at',
  window: { kind: 'rolling_days', n: 90 },
  producer_kind: 'housekeeping',
  temporal_class: 'aggregate_window',
  identity_aggregation: 'scenario',
  sample_floor: 5,
  confidence_kind: 'none',
  coverage: 'computed',
  source_degradation_reasons: ['sample_floor_unmet'],
  privacy_class: 'sensitive',
  mcp_exposed_default: false,
  invalidation_triggers: ['data.commitment.created', 'data.commitment.state_changed'],
  benchmark_scenarios: ['scn_castellanos_imbalance_basic', 'scn_castellanos_imbalance_balanced'],
  return_shape:
    "{ contact: REF<contacts>, inbound_count: number, outbound_count: number, imbalance_signal: 'aligned' | 'inbound_heavy' | 'outbound_heavy' | 'insufficient_data', computed_at: number }",
  suggest_directive: {
    tool: 'entity.query',
    kind: 'commitment',
    hint: "List the contact's commitments grouped by direction (inbound vs outbound) to assess imbalance manually.",
  },
  concurrency_safe: true,
};
