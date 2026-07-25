/** D-145 PA9 — `source_freshness_degradation` declaration.
 *  Spec § A.7.2 + § A.7.5 example. Source health signal feeding the
 *  engine's omission decisions. */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const SOURCE_FRESHNESS_DEGRADATION_DECLARATION: EnrichmentDeclaration = {
  topic: 'source_freshness_degradation',
  operates_on: ['source_registry', 'connection'],
  event_time_field: null,
  window: null,
  producer_kind: 'housekeeping',
  temporal_class: 'snapshot',
  identity_aggregation: 'scenario',
  sample_floor: 1,
  confidence_kind: 'none',
  coverage: 'declared',
  source_degradation_reasons: [
    'quota_suspended',
    'permission_revoked',
    'rate_limit_active',
    'webhook_delivery_degraded',
  ],
  privacy_class: 'public_metadata',
  mcp_exposed_default: false,
  invalidation_triggers: [
    'source_registry.updated',
    'connection.state_changed',
    'source_registry.last_seen_at_advance',
  ],
  benchmark_scenarios: ['scn_castellanos_source_disabled', 'scn_castellanos_partial_coverage'],
  return_shape:
    '{ degraded: boolean, reasons: SourceDegradationReason[], last_seen_at: number | null, computed_at: number }',
  // No natural deterministic fallback — degradation is an operational signal
  // whose recourse is to reconfigure the source / connection, not to query
  // a different warehouse collection.
  suggest_directive: null,
  concurrency_safe: true,
};
