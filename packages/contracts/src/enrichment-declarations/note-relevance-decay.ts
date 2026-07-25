/** D-145 PA9 — `note_relevance_decay` declaration. Spec § A.7.1. */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const NOTE_RELEVANCE_DECAY_DECLARATION: EnrichmentDeclaration = {
  topic: 'note_relevance_decay',
  operates_on: ['data.note', 'note_access_ledger'],
  event_time_field: 'note.last_accessed_at',
  window: { kind: 'rolling_days', n: 180 },
  producer_kind: 'housekeeping',
  temporal_class: 'aggregate_window',
  identity_aggregation: 'scenario',
  sample_floor: 1,
  confidence_kind: 'none',
  coverage: 'computed',
  source_degradation_reasons: [],
  privacy_class: 'user_inferable',
  mcp_exposed_default: false,
  invalidation_triggers: ['data.note.created', 'data.note.accessed'],
  benchmark_scenarios: ['scn_castellanos_note_decay_old', 'scn_castellanos_note_decay_recent'],
  return_shape:
    '{ note: REF<note>, decay_score: number, last_access_at: number | null, computed_at: number }',
  suggest_directive: {
    tool: 'entity.query',
    kind: 'note',
    hint: "Read the note's last_accessed_at to compute decay manually against the rolling window.",
  },
  concurrency_safe: true,
};
