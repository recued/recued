/** D-145 PA9 — `project_velocity` enrichment producer.
 *
 *  Per-project PSI-eligible velocity over the project's completed tasks
 *  in the rolling 30-day window. Per-project sibling to
 *  [[task-completion-velocity]] — same math, same window, same PSI
 *  shape; the source axis swaps `assigned_contact_id` for
 *  `parent_project_id`. The contact axis answers "which counterparty's
 *  throughput is changing?"; the project axis answers "which project's
 *  throughput is changing?" D-133 PSI iterates the score distribution
 *  per producer-version to surface accelerating / decaying projects.
 *
 *  Math (identical to [[task-completion-velocity]]):
 *      score = sample_count / 30                  (tasks per day)
 *      sample_count = completed tasks on this project in window
 *
 *  Score is a raw rate, NOT 0..1 — `PsiEligibleScoreValue.score` is
 *  "producer-normalized; not schema-enforced". Velocity has no natural
 *  ratio so it emits the raw rate. PSI iterates the raw distribution;
 *  a saturation clamp would compress the top of the distribution and
 *  lose discrimination for high-throughput projects. A future
 *  tunable_params lift (§ A.7.8) can add a saturation cap per project
 *  cadence if drift detection needs it.
 *
 *  Active-state gate. Non-active projects (paused / completed /
 *  archived) return null — no row emitted. A paused project is
 *  intentionally dormant; an archived project is intentionally
 *  finished. Computing velocity on either would surface noise in the
 *  engine's "what's accelerating?" reasoning. Same precedent as
 *  [[project_stall_signal]] + [[project_next_action_gap]] +
 *  [[open-loop-pressure-project]].
 *
 *  Window. 30 days on `completed_at` — when the task actually closed,
 *  not when it was created. A task created six months ago that closes
 *  today contributes to today's project velocity; a task created two
 *  months ago that's still open contributes nothing (no terminal
 *  signal). Matches declaration `window.rolling_days: 30` +
 *  `event_time_field: 'task.completed_at'` + sibling
 *  [[task-completion-velocity]].
 *
 *  Sample-floor. 30 completed tasks in window per spec § A.7.5 PSI
 *  calibration baseline (matches `PSI_SAMPLE_FLOOR_MINIMUM` +
 *  [[commitment-followthrough-score]] + [[task-completion-velocity]]).
 *  Below floor → `produce()` returns null. Spec § A.7.5: "under floor
 *  → emit `coverage.sources_degraded: 'sample_floor_unmet'` + abstain;
 *  never compute thin".
 *
 *  Confidence (PSI-eligible). Linear ramp matching sibling velocity +
 *  followthrough for cross-producer consistency:
 *
 *      confidence = clamp(sample_count / 100, 0, 1)
 *
 *  At sample_floor (30) → confidence ≈ 0.30; at the saturation cap
 *  (100 tasks) → 1.00. Exposed as
 *  `PROJECT_VELOCITY_CONFIDENCE_SATURATION`. Tunable params lift
 *  candidate (long-running projects have different natural completion
 *  rates than short sprints).
 *
 *  Event time. `event_at` = MAX(`completed_at`) across contributing
 *  rows so bistemporal stamping reflects when the most recent
 *  completion the producer observed actually happened. Spec § A.7.5
 *  event_time_field: `'task.completed_at'`.
 *
 *  Producer-version hash. Static base hash exposed as a constant. PSI
 *  drift detection (D-133) iterates the confidence distribution per
 *  producer-version; bumping `producer_code_hash` invalidates every
 *  existing row + lets D-133 pick up the new distribution as a
 *  potential drift signal.
 *
 *  Cadence + invalidation. Housekeeping 24h. Cascade fires on
 *  `data.project.updated` + `data.task.completed` per the
 *  declaration's `invalidation_triggers`. The work-entity due-status
 *  sweep already cascades task transitions to downstream PA9
 *  enrichment; the stale-sweep re-derives within the next eligible
 *  cycle.
 *
 *  Spec: D-145 §§ A.7.1 (line 744) + A.7.2 + A.7.5 +
 *        `ENRICHMENT_REGISTRY.project_velocity` +
 *        `packages/contracts/src/enrichment-declarations/project-velocity.ts`. */

import {
  computeProducerVersionHash,
  type Project,
  type PsiEligibleScoreValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { TASK_TABLE } from '../../storage/work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** 30-day rolling window — matches declaration `window.n` so cascade
 *  invalidation + producer computation agree on the same horizon.
 *  Identical to [[task-completion-velocity]]. */
export const PROJECT_VELOCITY_WINDOW_DAYS = 30;
export const PROJECT_VELOCITY_WINDOW_MS =
  PROJECT_VELOCITY_WINDOW_DAYS * 86_400_000;

/** Minimum completed tasks in window for the producer to emit.
 *  Matches declaration `sample_floor: 30` + the substrate-wide PSI
 *  calibration baseline (`PSI_SAMPLE_FLOOR_MINIMUM`). Below this the
 *  per-day rate is too noisy + PSI drift detection needs ≥ 30-row
 *  baseline per bucket. */
export const PROJECT_VELOCITY_SAMPLE_FLOOR = 30;

/** Sample size at which confidence saturates to 1.0. Linear ramp from
 *  sample_floor up. Mirrors [[task-completion-velocity]] +
 *  [[commitment-followthrough-score]] for cross-producer consistency.
 *  Exposed for unit testing + future tunable_params lift. */
export const PROJECT_VELOCITY_CONFIDENCE_SATURATION = 100;

/** Static base inputs for `computeProducerVersionHash`. PSI drift
 *  detection iterates the confidence distribution per producer-
 *  version; bumping `producer_code_hash` invalidates every existing
 *  row + lets D-133 pick up the new distribution. Bump on every
 *  meaningful behaviour change (filter shift, window-size change,
 *  rate formula tweak). */
const PRODUCER_VERSION_HASH_BASE = {
  producer_code_hash: 'project_velocity:1',
  model_id: '',
  prompt_template_hash: '',
  adapter_version: '',
  consumed_ingredients_versions: [],
} as const;

/** Cached at module load — pure function over a closed set of inputs. */
export const PROJECT_VELOCITY_PRODUCER_VERSION_HASH =
  computeProducerVersionHash(PRODUCER_VERSION_HASH_BASE);

/** Pure SQL aggregation — zero token cost, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Convert a `(sample_count)` into a per-row confidence value the PSI
 *  drift detector iterates. Linear in sample size up to a saturation
 *  cap. Pure — exposed for direct unit testing. Defensive: non-finite
 *  or non-positive sample counts return 0. */
export const computeProjectVelocityConfidence = (
  sample_count: number,
  saturation: number = PROJECT_VELOCITY_CONFIDENCE_SATURATION,
): number => {
  if (!Number.isFinite(sample_count) || sample_count <= 0) return 0;
  if (!Number.isFinite(saturation) || saturation <= 0) return 0;
  const ratio = sample_count / saturation;
  return ratio >= 1 ? 1 : ratio;
};

// ────────────────────────────────────────────────────────────────
// SQL query
// ────────────────────────────────────────────────────────────────

export interface ProjectCompletedTaskCounts {
  /** Number of tasks completed on this project in window. */
  completed_count: number;
  /** MAX(`completed_at`) across contributing rows. NULL when no rows
   *  contribute (caller short-circuits on `< sample_floor` before
   *  reading). */
  latest_completed_at: number | null;
}

const ZERO_COMPLETED_COUNTS: ProjectCompletedTaskCounts = {
  completed_count: 0,
  latest_completed_at: null,
};

/** Query the task table for one project's completed tasks in the
 *  rolling window. Uses `idx_task_project_done` to narrow on
 *  `(parent_project_id, done)`; the `completed_at >= since` filter
 *  is a final-tier predicate over the narrowed range. Tombstones
 *  (`deleted_at IS NOT NULL` or `sync_state = 'tombstoned'`)
 *  excluded — they're cancellations, not closures. Mirrors
 *  [[task-completion-velocity.countCompletedTasksForContact]] — same
 *  filter set, different keying axis. */
export const countCompletedTasksForProject = (
  ctx: HousekeepingContext,
  project_id: string,
  since: number,
): ProjectCompletedTaskCounts => {
  if (project_id === '') return ZERO_COMPLETED_COUNTS;
  const row = ctx.db
    .prepare(
      `SELECT
          COUNT(*) AS completed_count,
          MAX(completed_at) AS latest_completed_at
        FROM "${TASK_TABLE}"
        WHERE parent_project_id = ?
          AND done = 1
          AND completed_at IS NOT NULL
          AND completed_at >= ?
          AND sync_state IN ('live', 'stale_unreachable')
          AND deleted_at IS NULL`,
    )
    .get(project_id, since) as
    | {
        completed_count: number | null;
        latest_completed_at: number | null;
      }
    | undefined;
  if (!row) return ZERO_COMPLETED_COUNTS;
  return {
    completed_count: row.completed_count ?? 0,
    latest_completed_at: row.latest_completed_at,
  };
};

// ────────────────────────────────────────────────────────────────
// Producer
// ────────────────────────────────────────────────────────────────

export const projectVelocityProducer: HousekeepingEnrichmentProducer<Project> = {
  topic: 'project_velocity',
  source_scope: 'project',
  producer_version_hash: PROJECT_VELOCITY_PRODUCER_VERSION_HASH,
  scope_read_declaration: [
    { collection: 'data.project', sample_field_paths: ['id', 'state'] },
    {
      collection: 'data.task',
      sample_field_paths: ['parent_project_id', 'done', 'completed_at'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '24h',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<Project>) {
    const project = source_record.data;
    if (!project.id) return null;
    // Non-active projects (paused / completed / archived) get no row.
    // Matches `project_stall_signal` + `project_next_action_gap` +
    // `open_loop_pressure-project` — emitting velocity on
    // intentionally-dormant or finished projects would surface noise in
    // the engine's "what's accelerating?" reasoning.
    if (project.state !== 'active') return null;

    const now = ctx.now();
    const since = now - PROJECT_VELOCITY_WINDOW_MS;

    const { completed_count, latest_completed_at } =
      countCompletedTasksForProject(ctx, project.id, since);

    if (completed_count < PROJECT_VELOCITY_SAMPLE_FLOOR) {
      // Below PSI calibration baseline — abstain rather than emit a
      // thin score. Per spec § A.7.5: "under floor → emit
      // `coverage.sources_degraded: 'sample_floor_unmet'` + abstain;
      // never compute thin".
      return null;
    }

    // Tasks per day across the rolling window. Raw rate, not 0..1 —
    // see header for rationale (no natural ratio; saturation would
    // compress the top of the distribution for PSI iteration).
    const score = completed_count / PROJECT_VELOCITY_WINDOW_DAYS;
    const confidence = computeProjectVelocityConfidence(completed_count);

    const value: PsiEligibleScoreValue = {
      score,
      sample_count: completed_count,
      confidence,
      computed_at: now,
    };
    const output: { value: PsiEligibleScoreValue; event_at?: number } = { value };
    if (latest_completed_at !== null && Number.isFinite(latest_completed_at)) {
      output.event_at = latest_completed_at;
    }
    return output;
  },
};
