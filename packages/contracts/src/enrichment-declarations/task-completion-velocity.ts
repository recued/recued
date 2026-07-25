/** D-145 PA9 — `task_completion_velocity` declaration. Spec § A.7.1.
 *  PSI-eligible per A.7.2 (3 + 1 narrowing). */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const TASK_COMPLETION_VELOCITY_DECLARATION: EnrichmentDeclaration = {
  topic: 'task_completion_velocity',
  operates_on: ['data.contact', 'data.task'],
  event_time_field: 'task.completed_at',
  window: { kind: 'rolling_days', n: 30 },
  producer_kind: 'housekeeping',
  temporal_class: 'aggregate_window',
  identity_aggregation: 'scenario',
  sample_floor: 30,
  confidence_kind: 'emits_confidence',
  coverage: 'computed',
  source_degradation_reasons: ['sample_floor_unmet'],
  privacy_class: 'user_inferable',
  mcp_exposed_default: false,
  invalidation_triggers: ['data.task.state_changed', 'data.task.completed'],
  benchmark_scenarios: ['scn_castellanos_velocity_steady', 'scn_castellanos_velocity_decay'],
  return_shape:
    '{ contact: REF<contacts>, score: number, sample_count: number, confidence: number, computed_at: number }',
  suggest_directive: {
    tool: 'entity.query',
    kind: 'task',
    hint: "List the contact's completed tasks over the rolling window to derive completion velocity manually.",
  },
  concurrency_safe: true,
};
