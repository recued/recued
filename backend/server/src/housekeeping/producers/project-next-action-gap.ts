/** D-145 PA9 — `project_next_action_gap` enrichment producer.
 *
 *  Per-project signal flagging active projects with no open task, no
 *  pending commitment, and / or no recent note. Directly feeds the
 *  Recued engine's "what should I do next?" reasoning (spec § A.7.6 #4;
 *  consumed by the Personal Organizer Foundation pack's
 *  `stalled-projects` + `today` recipes). Walks `data_project` via the
 *  project source-walker (D-145 PA9 third per-record producer on a
 *  work-entity scope, after [[note_relevance_decay]] +
 *  [[task_duplicate_candidate]]; first cross-entity reader). For each
 *  active focal project the producer:
 *
 *    1. Counts open tasks (`parent_project_id = ?` AND `done = 0`).
 *    2. Counts pending commitments
 *       (`json_each(blocks_project_ids) = ?` AND
 *        `lifecycle_state = 'pending'`).
 *    3. Counts recent notes (`json_each(related_project_ids) = ?` AND
 *       `last_user_action_at >= now - 14d`).
 *
 *  Each zero count emits the matching `gap_signals` token —
 *  `'no_open_task' | 'no_pending_commitment' | 'no_recent_note'`.
 *  `gap_present` is `signals.length > 0`. Non-active projects (paused
 *  / completed / archived) return null — no row emitted; the engine
 *  doesn't drive next-action reasoning on a finished project.
 *
 *  Closed-list gap signals match the registry's `gap_signals: string[]`
 *  schema; consumers (the `stalled-projects` recipe + downstream pack
 *  surfaces) gate on the presence of specific tokens via string
 *  comparison.
 *
 *  Why "recent note" via `last_user_action_at` rather than
 *  `created_at`? A note touched yesterday but created six months ago
 *  is still an active engagement signal. `last_user_action_at` is the
 *  canonical user-touched timestamp per § A.1.2 (only bumped on
 *  user-driven kinds — not on AI / recipe / MCP reads, so the
 *  feedback-loop guard from § A.1.2 holds).
 *
 *  Why "blocks_project_ids" for commitments? The Commitment schema
 *  (§ A.1.3) carries no `parent_project_id` — the project-commitment
 *  relationship surfaces through `blocks_project_ids[]`, the array
 *  recording which projects this commitment unblocks on fulfillment.
 *  Using it gives the canonical "commitments active in this project's
 *  work" set.
 *
 *  Sample-floor semantics. Declaration carries `sample_floor: 1` —
 *  every active project gets evaluated; no per-project abstention
 *  beyond the not-active early return. A project with no children at
 *  all emits `{ gap_present: true, gap_signals: [all three], ... }` —
 *  the empty-project case is itself a next-action gap.
 *
 *  Cadence + invalidation. Housekeeping 24h (registry). Cascade fires
 *  on `data.project.updated` + `data.task.state_changed` +
 *  `data.note.created` + `data.commitment.state_changed` per the
 *  declaration's `invalidation_triggers`. The `aggregates_from =
 *  ['project', 'task', 'note', 'commitment']` registry entry keeps the
 *  cascade walker on all four scopes; the harness stale-sweep
 *  re-derives within the next eligible cycle.
 *
 *  Spec § A.7.2 frames this as "housekeeping (daily) + reactive (on
 *  child-entity state change)". The reactive harness lift is a
 *  deferred follow-on; today the reactivity is provided by cascade
 *  staling firing into the housekeeping stale-sweep. Same precedent
 *  as [[outbound_commitment_overdue_count]].
 *
 *  Spec: `docs/d-145-spec.md` §§ A.7.2 + A.7.3 + A.7.5 + A.7.6 #4 +
 *        `ENRICHMENT_REGISTRY.project_next_action_gap` +
 *        `packages/contracts/src/enrichment-declarations/project-next-action-gap.ts`. */

import {
  type Project,
  type ProjectNextActionGapValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import {
  COMMITMENT_TABLE,
  NOTE_TABLE,
  TASK_TABLE,
} from '../../storage/work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** 14-day window for the "recent note" gap signal. Matches the
 *  Personal Organizer Foundation pack's `stalled-projects` recipe
 *  semantics (spec § A.1.4 line 18: `last_activity_at > 14d` ⇒
 *  stalled) so substrate signal + pack threshold agree on the same
 *  horizon. */
export const PROJECT_NEXT_ACTION_GAP_RECENT_NOTE_WINDOW_MS = 14 * 86_400_000;

/** Closed list of gap-signal tokens the producer emits. Consumers gate
 *  on these via string comparison; keep additions backward-compatible
 *  (recipes pin to known tokens). */
export const PROJECT_NEXT_ACTION_GAP_SIGNALS = [
  'no_open_task',
  'no_pending_commitment',
  'no_recent_note',
] as const;
export type ProjectNextActionGapSignal = (typeof PROJECT_NEXT_ACTION_GAP_SIGNALS)[number];

/** Pure SQL aggregation — zero token cost, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

// ────────────────────────────────────────────────────────────────
// SQL queries
// ────────────────────────────────────────────────────────────────

/** Count open tasks for one project. Uses `idx_task_project_done` for
 *  index-narrowed scan. Tombstoned + orphan rows excluded; pre-tombstone
 *  deletion races filtered via `deleted_at IS NULL`. Empty `project_id`
 *  short-circuits to 0 — defensive against malformed source records. */
export const countOpenTasksForProject = (
  ctx: HousekeepingContext,
  project_id: string,
): number => {
  if (project_id === '') return 0;
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM "${TASK_TABLE}"
         WHERE parent_project_id = ?
           AND done = 0
           AND sync_state IN ('live', 'stale_unreachable')
           AND deleted_at IS NULL`,
    )
    .get(project_id) as { n: number } | undefined;
  return row?.n ?? 0;
};

/** Count pending commitments linked to one project via
 *  `blocks_project_ids`. The Commitment schema (§ A.1.3) stores the
 *  project relationship as a JSON array — `json_each` membership-tests
 *  efficiently without a join table. Tombstoned + orphan rows excluded
 *  via `sync_state` + `deleted_at IS NULL`. */
export const countPendingCommitmentsForProject = (
  ctx: HousekeepingContext,
  project_id: string,
): number => {
  if (project_id === '') return 0;
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM "${COMMITMENT_TABLE}"
         WHERE lifecycle_state = 'pending'
           AND sync_state IN ('live', 'stale_unreachable')
           AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(blocks_project_ids)
               WHERE json_each.value = ?
           )`,
    )
    .get(project_id) as { n: number } | undefined;
  return row?.n ?? 0;
};

/** Count notes linked to one project via `related_project_ids` whose
 *  `last_user_action_at` falls inside the recent window. Uses the
 *  user-driven canonical-row timestamp (NOT the access ledger) so the
 *  query stays SQL-local; the ledger feeds `note_relevance_decay`'s
 *  separate decay math. */
export const countRecentNotesForProject = (
  ctx: HousekeepingContext,
  project_id: string,
  since: number,
): number => {
  if (project_id === '') return 0;
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM "${NOTE_TABLE}"
         WHERE last_user_action_at >= ?
           AND sync_state IN ('live', 'stale_unreachable')
           AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(related_project_ids)
               WHERE json_each.value = ?
           )`,
    )
    .get(since, project_id) as { n: number } | undefined;
  return row?.n ?? 0;
};

// ────────────────────────────────────────────────────────────────
// Pure helper
// ────────────────────────────────────────────────────────────────

/** Compose the `gap_signals` list from the three counts. Pure function
 *  — exposed for direct unit testing. Emits one token per zero count;
 *  order matches `PROJECT_NEXT_ACTION_GAP_SIGNALS` declaration so the
 *  emitted array is deterministic across runs. */
export const computeGapSignals = (
  open_tasks_count: number,
  pending_commitments_count: number,
  recent_notes_count: number,
): ProjectNextActionGapSignal[] => {
  const signals: ProjectNextActionGapSignal[] = [];
  if (open_tasks_count === 0) signals.push('no_open_task');
  if (pending_commitments_count === 0) signals.push('no_pending_commitment');
  if (recent_notes_count === 0) signals.push('no_recent_note');
  return signals;
};

// ────────────────────────────────────────────────────────────────
// Producer
// ────────────────────────────────────────────────────────────────

export const projectNextActionGapProducer: HousekeepingEnrichmentProducer<Project> = {
  topic: 'project_next_action_gap',
  source_scope: 'project',
  scope_read_declaration: [
    { collection: 'data.project', sample_field_paths: ['id', 'state'] },
    {
      collection: 'data.task',
      sample_field_paths: ['parent_project_id', 'done'],
    },
    {
      collection: 'data.commitment',
      sample_field_paths: ['blocks_project_ids', 'lifecycle_state'],
    },
    {
      collection: 'data.note',
      sample_field_paths: ['related_project_ids', 'last_user_action_at'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '24h',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<Project>) {
    const project = source_record.data;
    if (!project.id) return null;
    // Non-active projects (paused / completed / archived) get no row.
    // The engine doesn't drive next-action reasoning on a finished
    // project; emitting `gap_present: true` for an archived project
    // would surface noise in the `stalled-projects` recipe.
    if (project.state !== 'active') return null;

    const now = ctx.now();
    const since = now - PROJECT_NEXT_ACTION_GAP_RECENT_NOTE_WINDOW_MS;

    const open_tasks_count = countOpenTasksForProject(ctx, project.id);
    const pending_commitments_count = countPendingCommitmentsForProject(ctx, project.id);
    const recent_notes_count = countRecentNotesForProject(ctx, project.id, since);

    const signals = computeGapSignals(
      open_tasks_count,
      pending_commitments_count,
      recent_notes_count,
    );

    const value: ProjectNextActionGapValue = {
      gap_present: signals.length > 0,
      gap_signals: signals,
      computed_at: now,
    };
    return { value };
  },
};
