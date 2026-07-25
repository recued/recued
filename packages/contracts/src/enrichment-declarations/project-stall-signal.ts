/** D-145 PA9 — `project_stall_signal` declaration. Spec § A.7.1.
 *
 *  D-145 § A.7.8 (Amended 2026-05-26): pilot topic for the
 *  tunable_params substrate — `stall_window_days` defaults to 14
 *  (matches spec § A.6.1 line 18 `stalled-projects` pack recipe
 *  threshold) and varies widely by industry: SaaS / sales weekly
 *  (~7d), consulting / professional services monthly (~30d),
 *  architecture / construction / real-estate yearly (~365d), with
 *  the bounds [1, 730] covering daily-cadence sprint teams through
 *  multi-year capital projects. */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';

export const PROJECT_STALL_SIGNAL_DECLARATION: EnrichmentDeclaration = {
  topic: 'project_stall_signal',
  operates_on: ['data.project', 'data.task', 'data.note', 'data.commitment'],
  event_time_field: null,
  window: null,
  producer_kind: 'housekeeping',
  temporal_class: 'snapshot',
  identity_aggregation: 'scenario',
  sample_floor: 1,
  confidence_kind: 'none',
  coverage: 'computed',
  source_degradation_reasons: ['sample_floor_unmet'],
  privacy_class: 'user_inferable',
  mcp_exposed_default: false,
  invalidation_triggers: [
    'data.project.updated',
    'data.task.created',
    'data.task.state_changed',
    'data.note.created',
    'data.commitment.state_changed',
  ],
  benchmark_scenarios: ['scn_castellanos_stalled_project', 'scn_castellanos_active_project'],
  return_shape:
    '{ project: REF<project>, stalled: boolean, signals: [string], last_activity_at: number | null, computed_at: number }',
  suggest_directive: {
    tool: 'entity.query',
    kind: 'project',
    hint: "List the project's tasks, notes, and commitments to assess stall signals manually.",
  },
  concurrency_safe: true,
  tunable_params: {
    stall_window_days: {
      kind: 'number',
      default: 14,
      min: 1,
      max: 730,
      unit: 'days',
      ui_label: 'Stall threshold',
      ui_help:
        'Projects with no activity in this window are flagged stalled. '
        + 'Industry defaults vary: SaaS / sales weekly (~7d), consulting / '
        + 'professional services monthly (~30d), architecture / construction '
        + '/ real-estate yearly (~365d).',
    },
  },
};
