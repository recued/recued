/** D-145 PA9 — `open_loop_pressure` declaration. Spec § A.7.2.
 *
 *  Spec frames this as two derived-entity scopes (per-contact +
 *  per-project) sharing one producer because the math is identical
 *  (count + age-weight). PA9 v1 ships per-contact only; per-project
 *  rows ship in a follow-on slice that introduces the multi-scope
 *  task-id substrate (`enrichment.${topic}.${scope}`). The
 *  per-contact scope is the engine's primary consumer (Personal
 *  Organizer Foundation pack `today` recipe + `before-you-reply`
 *  feature); per-project layers on later without changing this
 *  declaration's shape. Registry retains `valid_scopes: ['contact',
 *  'project']` so the per-project scope is reserved at the storage
 *  layer.
 *
 *  Implementation ships as housekeeping. The spec table (§ A.7.1
 *  line 753) marks this topic `reactive`, but the cascade-driven
 *  stale-sweep already picks up fresh values within one cycle of any
 *  `data.commitment.state_changed` / `data.task.state_changed` /
 *  `data.mail.received` event — no separate reactive harness needed.
 *  Same precedent as `outbound_commitment_overdue_count` +
 *  `commitment_imbalance` + `task_signal_density_per_thread`. */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const OPEN_LOOP_PRESSURE_DECLARATION: EnrichmentDeclaration = {
  topic: 'open_loop_pressure',
  operates_on: ['data.commitment', 'data.task', 'data.mail'],
  event_time_field: null,
  window: null,
  producer_kind: 'housekeeping',
  temporal_class: 'snapshot',
  identity_aggregation: 'scenario',
  sample_floor: 1,
  confidence_kind: 'none',
  coverage: 'computed',
  source_degradation_reasons: [],
  privacy_class: 'user_inferable',
  mcp_exposed_default: false,
  invalidation_triggers: [
    'data.commitment.state_changed',
    'data.task.state_changed',
    'data.mail.received',
  ],
  benchmark_scenarios: ['scn_castellanos_pressure_high', 'scn_castellanos_pressure_low'],
  return_shape:
    '{ pressure_score: number, open_count: number, age_weighted_score: number, computed_at: number }',
  suggest_directive: {
    tool: 'entity.query',
    kind: 'commitment',
    hint: 'List open commitments, open tasks, and unread mail for the entity to assess pressure manually.',
  },
  concurrency_safe: true,
};
