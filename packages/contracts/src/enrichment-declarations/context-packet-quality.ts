/** D-145 PA9 — `context_packet_quality` declaration.
 *  Spec § A.7.2 + § A.7.5 example. PSI-eligible per A.7.2 (3 + 1
 *  narrowing). Feeds the C.3 benchmark loop + future engine tuning. */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const CONTEXT_PACKET_QUALITY_DECLARATION: EnrichmentDeclaration = {
  topic: 'context_packet_quality',
  operates_on: ['data.memory.recued_plan', 'data.memory.audit'],
  event_time_field: 'recued_plan.completed_at',
  window: { kind: 'rolling_days', n: 30 },
  producer_kind: 'reactive',
  temporal_class: 'aggregate_window',
  identity_aggregation: 'scenario',
  sample_floor: 50,
  confidence_kind: 'emits_confidence',
  coverage: 'computed',
  source_degradation_reasons: ['sample_floor_unmet'],
  privacy_class: 'user_inferable',
  mcp_exposed_default: false,
  invalidation_triggers: [
    'recued_plan.completed',
    'recued_plan.user_undo',
    'recued_plan.user_correction',
  ],
  benchmark_scenarios: [
    'scn_castellanos_packet_quality_negative',
    'scn_castellanos_packet_quality_positive',
  ],
  return_shape: '{ score: number, sample_count: number, confidence: number, computed_at: number }',
  suggest_directive: {
    tool: 'memory.search',
    kind: 'recued_plan',
    hint: 'Search recent recued_plan and audit entries to assess context-packet quality from completion outcomes.',
  },
  concurrency_safe: true,
};
