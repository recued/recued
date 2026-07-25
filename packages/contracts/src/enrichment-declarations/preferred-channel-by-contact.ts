/** D-145 PA9 — `preferred_channel_by_contact` declaration. Spec § A.7.2.
 *  Behavioral, not sentiment — substrate explicitly avoids "sentiment"
 *  framing per § A.1.5 narrow taxonomy. */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const PREFERRED_CHANNEL_BY_CONTACT_DECLARATION: EnrichmentDeclaration = {
  topic: 'preferred_channel_by_contact',
  operates_on: ['data.mail', 'data.calendar', 'data.contact.engagements'],
  event_time_field: 'mail.received_at',
  window: { kind: 'rolling_days', n: 90 },
  producer_kind: 'housekeeping',
  temporal_class: 'aggregate_window',
  identity_aggregation: 'scenario',
  sample_floor: 5,
  confidence_kind: 'none',
  coverage: 'computed',
  source_degradation_reasons: ['sample_floor_unmet'],
  privacy_class: 'user_inferable',
  mcp_exposed_default: false,
  invalidation_triggers: ['data.mail.received', 'data.calendar.event_completed'],
  benchmark_scenarios: ['scn_castellanos_channel_email', 'scn_castellanos_channel_mixed'],
  return_shape:
    "{ contact: REF<contacts>, preference: 'email_preferred' | 'call_preferred' | 'text_preferred' | 'meeting_preferred' | 'mixed_no_clear_preference', score_breakdown: { [channel: string]: number }, computed_at: number }",
  suggest_directive: {
    tool: 'entity.query',
    kind: 'mail',
    hint: "List the contact's mail and calendar history to infer channel preference from response patterns.",
  },
  concurrency_safe: true,
};
