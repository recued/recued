/** D-145 PA9 — `open_loop_pressure` enrichment producer (per-project).
 *
 *  Per-project companion to [[open-loop-pressure]] (per-contact).
 *  Spec § A.7.2 frames `open_loop_pressure` as TWO scopes (contact +
 *  project) sharing one topic because the math is identical: count
 *  open work, age-weight, saturate at 60 person-days. The per-contact
 *  scope answers "which counterparty has the most open loop?"; the
 *  per-project scope answers "which active project has the most open
 *  loop?" Both feed the engine's "what needs attention?" planner —
 *  contact pressure into `before-you-reply` / `today`, project
 *  pressure into the `stalled-projects` adjacent surface.
 *
 *  The two scopes share substrate through the multi-scope task-id
 *  substrate (this slice — `task_id_suffix: 'project'` on the
 *  registration entry composes `enrichment.open_loop_pressure.project`
 *  while the per-contact entry retains `enrichment.open_loop_pressure`
 *  for back-compat). Storage stays scope-keyed; both rows persist
 *  under the same `(topic, authored_by)` and discriminate via the
 *  scope column.
 *
 *  Per-project math + sources:
 *    1. Open commitments — `lifecycle_state = 'pending'` rows where
 *       `EXISTS(SELECT 1 FROM json_each(blocks_project_ids) WHERE
 *       json_each.value = <project.id>)`. Both directions count.
 *       Internal direction excluded — matches per-contact precedent.
 *       Same SQL pattern as
 *       [[project-stall-signal.maxCommitmentActivityForProject]].
 *    2. Open tasks — `done = 0` rows where `parent_project_id =
 *       <project.id>`. Same SQL pattern as
 *       [[project-stall-signal.maxTaskActivityForProject]].
 *
 *  No mail source — a project doesn't have a natural mail
 *  relationship. The per-contact scope handles the unread-mail pressure
 *  via canonical From/To/Cc match; the per-project scope is
 *  commitments + tasks only.
 *
 *  Math:
 *    - `open_count = commitments_open + tasks_open`
 *    - `age_weighted_score = Σ max(0, age_days)` across all open items
 *      (`state_changed_at` for commitments, `updated_at` for tasks)
 *    - `pressure_score = clamp(age_weighted_score / 60, 0, 1)` — same
 *      saturation cap as per-contact (60 person-days; pack recipes
 *      re-shape if they want a different curve)
 *
 *  Pure helpers reused from [[open-loop-pressure]]:
 *  `computeAgeDays`, `computePressureScore`,
 *  `OPEN_LOOP_PRESSURE_SATURATION_DAYS`.
 *
 *  Sample-floor semantics. Declaration carries `sample_floor: 1` —
 *  active projects with zero open work emit no row. Empty-floor
 *  abstention keeps the warehouse small.
 *
 *  Active-state gate. Paused / completed / archived projects emit no
 *  row. A paused project is intentionally dormant; an archived
 *  project is intentionally finished. Surfacing "pressure" on either
 *  would be noise in the `today` / `stalled-projects` recipes. Same
 *  precedent as [[project_next_action_gap]] +
 *  [[project_stall_signal]].
 *
 *  Cadence + invalidation. Housekeeping 24h. Cascade fires on
 *  `data.commitment.state_changed` + `data.task.state_changed` per
 *  the declaration (mail trigger is per-contact only — project rows
 *  ignore mail invalidation). The work-entity due-status sweep marks
 *  commitment topics stale on every transition.
 *
 *  Spec: D-145 §§ A.7.1 (line 753) + A.7.2 +
 *        A.7.6 #1 + `ENRICHMENT_REGISTRY.open_loop_pressure` +
 *        `packages/contracts/src/enrichment-declarations/open-loop-pressure.ts`. */

import {
  type OpenLoopPressureValue,
  type Project,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { COMMITMENT_TABLE, TASK_TABLE } from '../../storage/work-entity-store.js';
import { computePressureScore } from './open-loop-pressure.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Pure SQL + arithmetic — zero token cost, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

// ────────────────────────────────────────────────────────────────
// SQL aggregators
// ────────────────────────────────────────────────────────────────

export interface PendingItemAggregate {
  count: number;
  age_weighted: number;
}

const ZERO_AGGREGATE: PendingItemAggregate = { count: 0, age_weighted: 0 };

/** Aggregate open commitments linked to one project. Same lifecycle +
 *  direction filter as per-contact (`pending` + inbound|outbound) but
 *  joins via `blocks_project_ids` JSON membership instead of
 *  counterparty match. Mirrors
 *  [[project-stall-signal.maxCommitmentActivityForProject]]'s join
 *  pattern. */
export const aggregateOpenCommitmentsForProject = (
  ctx: HousekeepingContext,
  project_id: string,
  now: number,
): PendingItemAggregate => {
  if (project_id === '') return ZERO_AGGREGATE;
  const row = ctx.db
    .prepare(
      `SELECT
          COUNT(*) AS count,
          COALESCE(SUM(CASE WHEN ? - state_changed_at > 0 THEN (? - state_changed_at) / 86400000.0 ELSE 0 END), 0) AS age_weighted
        FROM "${COMMITMENT_TABLE}"
        WHERE lifecycle_state = 'pending'
          AND direction IN ('inbound', 'outbound')
          AND sync_state IN ('live', 'stale_unreachable')
          AND deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM json_each(blocks_project_ids)
              WHERE json_each.value = ?
          )`,
    )
    .get(now, now, project_id) as
    | { count: number | null; age_weighted: number | null }
    | undefined;
  return {
    count: row?.count ?? 0,
    age_weighted: row?.age_weighted ?? 0,
  };
};

/** Aggregate open tasks (`done = 0`) parented to one project. Uses
 *  `idx_task_project_done` for index-narrowed scan. Mirrors
 *  [[project-stall-signal.maxTaskActivityForProject]] but narrows on
 *  `done = 0` since pressure is "open *now*", not broad recency. */
export const aggregateOpenTasksForProject = (
  ctx: HousekeepingContext,
  project_id: string,
  now: number,
): PendingItemAggregate => {
  if (project_id === '') return ZERO_AGGREGATE;
  const row = ctx.db
    .prepare(
      `SELECT
          COUNT(*) AS count,
          COALESCE(SUM(CASE WHEN ? - updated_at > 0 THEN (? - updated_at) / 86400000.0 ELSE 0 END), 0) AS age_weighted
        FROM "${TASK_TABLE}"
        WHERE parent_project_id = ?
          AND done = 0
          AND sync_state IN ('live', 'stale_unreachable')
          AND deleted_at IS NULL`,
    )
    .get(now, now, project_id) as
    | { count: number | null; age_weighted: number | null }
    | undefined;
  return {
    count: row?.count ?? 0,
    age_weighted: row?.age_weighted ?? 0,
  };
};

// ────────────────────────────────────────────────────────────────
// Producer
// ────────────────────────────────────────────────────────────────

export const openLoopPressureProjectProducer: HousekeepingEnrichmentProducer<Project> = {
  topic: 'open_loop_pressure',
  source_scope: 'project',
  scope_read_declaration: [
    { collection: 'data.project', sample_field_paths: ['id', 'state'] },
    {
      collection: 'data.commitment',
      sample_field_paths: [
        'blocks_project_ids',
        'lifecycle_state',
        'direction',
        'state_changed_at',
      ],
    },
    {
      collection: 'data.task',
      sample_field_paths: ['parent_project_id', 'done', 'updated_at'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '24h',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<Project>) {
    const project = source_record.data;
    if (!project.id) return null;
    // Non-active projects (paused / completed / archived) get no row.
    // Matches `project_stall_signal` + `project_next_action_gap` —
    // emitting pressure on intentionally-dormant projects would surface
    // noise in the `today` recipe.
    if (project.state !== 'active') return null;

    const now = ctx.now();
    const commitments = aggregateOpenCommitmentsForProject(ctx, project.id, now);
    const tasks = aggregateOpenTasksForProject(ctx, project.id, now);

    const open_count = commitments.count + tasks.count;
    if (open_count < 1) {
      // Sample floor unmet — project has no open loop at all. Abstain
      // rather than emit a zero-row for every active project (matches
      // per-contact precedent).
      return null;
    }

    const age_weighted_score = commitments.age_weighted + tasks.age_weighted;
    const pressure_score = computePressureScore(age_weighted_score);

    const value: OpenLoopPressureValue = {
      pressure_score,
      open_count,
      age_weighted_score,
      computed_at: now,
    };
    return { value };
  },
};
