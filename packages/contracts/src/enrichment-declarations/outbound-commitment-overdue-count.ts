/** D-145 PA9 — `outbound_commitment_overdue_count` declaration. Spec § A.7.1.
 *
 *  Per-contact snapshot of overdue outbound commitments to this
 *  counterparty. Spec § A.7.1 frames this as "per-pair (boss-level)";
 *  the PA9 implementation slice ships per-contact rows so engine +
 *  alert recipes can surface per-counterparty growth — global rollup
 *  is a derived aggregation off the per-contact set, not a separate
 *  producer.
 *
 *  Cadence: housekeeping (24h) — the work-entity due-status sweep
 *  (`work-entity-due-status-sweep.ts`) already cascades invalidation
 *  on every commitment state transition, so housekeeping picks up
 *  fresh overdue counts within one cycle without a separate reactive
 *  harness. The declaration retains `state_changed` + `due_passed`
 *  in `invalidation_triggers` for cascade alignment. */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const OUTBOUND_COMMITMENT_OVERDUE_COUNT_DECLARATION: EnrichmentDeclaration = {
  topic: 'outbound_commitment_overdue_count',
  operates_on: ['data.commitment'],
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
  invalidation_triggers: ['data.commitment.state_changed', 'data.commitment.due_passed'],
  benchmark_scenarios: ['scn_castellanos_overdue_growth', 'scn_castellanos_overdue_zero'],
  return_shape:
    '{ contact: REF<contacts>, count: number, oldest_overdue_at: number | null, computed_at: number }',
  suggest_directive: {
    tool: 'entity.query',
    kind: 'commitment',
    hint: 'List outbound commitments with due_at in the past to count overdue items.',
  },
  concurrency_safe: true,
};
