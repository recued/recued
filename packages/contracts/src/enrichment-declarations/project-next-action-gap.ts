/** D-145 PA9 — `project_next_action_gap` declaration. Spec § A.7.2.
 *
 *  Spec § A.7.2 frames this as "housekeeping (daily) + reactive (on
 *  child-entity state change)". Today's enrichment harness only
 *  registers `'housekeeping'` producers (`buildEnrichmentProducerTask`
 *  rejects `'reactive'`); the reactive piece is provided by the
 *  cascade engine flipping stale on the declared
 *  `invalidation_triggers` + the harness stale-sweep re-running
 *  `produce()` within the next cycle. Same precedent as
 *  `outbound_commitment_overdue_count` (spec § A.7.1 reactive →
 *  registry housekeeping). The pure-reactive harness lift is a
 *  deferred follow-on. */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const PROJECT_NEXT_ACTION_GAP_DECLARATION: EnrichmentDeclaration = {
  topic: 'project_next_action_gap',
  operates_on: ['data.project', 'data.task', 'data.note', 'data.commitment'],
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
    'data.project.updated',
    'data.task.state_changed',
    'data.note.created',
    'data.commitment.state_changed',
  ],
  benchmark_scenarios: ['scn_castellanos_action_gap_present', 'scn_castellanos_action_gap_clear'],
  return_shape:
    '{ project: REF<project>, gap_present: boolean, gap_signals: [string], computed_at: number }',
  suggest_directive: {
    tool: 'entity.query',
    kind: 'project',
    hint: "List the project's open tasks, pending commitments, and recent notes to detect a next-action gap manually.",
  },
  concurrency_safe: true,
};
