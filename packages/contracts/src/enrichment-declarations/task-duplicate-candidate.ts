/** D-145 PA9 — `task_duplicate_candidate` declaration. Spec § A.7.2. */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const TASK_DUPLICATE_CANDIDATE_DECLARATION: EnrichmentDeclaration = {
  topic: 'task_duplicate_candidate',
  operates_on: ['data.task'],
  event_time_field: null,
  window: null,
  producer_kind: 'housekeeping',
  temporal_class: 'snapshot',
  identity_aggregation: 'scenario',
  sample_floor: 2,
  confidence_kind: 'none',
  coverage: 'computed',
  source_degradation_reasons: ['sample_floor_unmet'],
  privacy_class: 'user_inferable',
  mcp_exposed_default: false,
  invalidation_triggers: ['data.task.created', 'data.task.updated'],
  benchmark_scenarios: ['scn_castellanos_duplicate_exact', 'scn_castellanos_duplicate_probable'],
  return_shape:
    "{ task: REF<task>, duplicate_candidate_set: [REF<task>], dedupe_confidence: 'exact' | 'probable' | 'low', computed_at: number }",
  suggest_directive: {
    tool: 'entity.query',
    kind: 'task',
    hint: 'List tasks with overlapping titles, descriptions, or due-dates to inspect for duplicates manually.',
  },
  concurrency_safe: true,
};
