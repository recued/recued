/** D-145 PA9 — `task_signal_density_per_thread` declaration. Spec § A.7.1.
 *
 *  Implementation ships as housekeeping. The spec table (§ A.7.1 line
 *  742) marks this topic `reactive`, but the housekeeping harness's
 *  cascade-driven stale-sweep already picks up fresh density values
 *  within one cycle of any `data.mail.received` or `data.task.created`
 *  event — no separate reactive harness needed. Same precedent as
 *  `outbound_commitment_overdue_count` (declaration line 24 + ENRICHMENT_REGISTRY.outbound_commitment_overdue_count).
 *  The 30d rolling window stays as the cascade-invalidation framing;
 *  the producer itself reads all-time signal counts (matching the
 *  spec hint "count task-shaped signals over its message count") so
 *  thread density is comparable across thread ages. */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const TASK_SIGNAL_DENSITY_PER_THREAD_DECLARATION: EnrichmentDeclaration = {
  topic: 'task_signal_density_per_thread',
  operates_on: ['data.task', 'data.mail'],
  event_time_field: 'mail.received_at',
  window: { kind: 'rolling_days', n: 30 },
  producer_kind: 'housekeeping',
  temporal_class: 'aggregate_window',
  identity_aggregation: 'scenario',
  sample_floor: 1,
  confidence_kind: 'none',
  coverage: 'computed',
  source_degradation_reasons: ['partial_api_failure'],
  privacy_class: 'user_inferable',
  mcp_exposed_default: false,
  invalidation_triggers: ['data.mail.received', 'data.task.created'],
  benchmark_scenarios: ['scn_castellanos_density_high_signal', 'scn_castellanos_density_chatter'],
  return_shape:
    '{ thread: REF<mail>, density: number, signal_count: number, computed_at: number }',
  suggest_directive: {
    tool: 'entity.query',
    kind: 'mail',
    hint: 'Read the mail thread and count task-shaped signals (mentions, asks, follow-ups) over its message count.',
  },
  concurrency_safe: true,
};
