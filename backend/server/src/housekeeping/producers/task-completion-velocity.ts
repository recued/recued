/** D-145 PA9 — `task_completion_velocity` enrichment producer.
 *
 *  Per-contact PSI-eligible velocity over the contact's completed tasks
 *  in the rolling 30-day window. Throughput is the natural lens: how
 *  many tasks the contact closed per day. Distribution shift over time
 *  is the engine's "is this person ramping up / decaying?" signal —
 *  D-133 PSI calibrates buckets on the score distribution + emits a
 *  drift signal when the distribution diverges from baseline.
 *
 *  Math:
 *      score = sample_count / 30                  (tasks per day)
 *      sample_count = completed tasks in window
 *
 *  Score is raw rate, NOT 0..1 — `PsiEligibleScoreValue.score` is
 *  "producer-normalized; not schema-enforced". `commitment_followthrough_score`
 *  emits a natural ratio (fulfilled / terminal) so it lands in 0..1
 *  by construction; velocity has no natural ratio so it emits the raw
 *  rate (tasks/day). PSI iterates the raw distribution; saturation
 *  would compress the top of the distribution and lose discrimination
 *  for power users. A future tunable_params lift (§ A.7.8) can add a
 *  saturation cap per industry cadence if drift detection needs it.
 *
 *  Direction. Tasks are unidirectional (`assigned_contact_id = <email>`);
 *  there's no inbound/outbound axis — "completed FOR me" / "completed
 *  BY me" distinctions live on commitments, not tasks. The contact's
 *  velocity is the contact's throughput as the assignee.
 *
 *  Window. 30 days on `completed_at` — when the task actually closed,
 *  not when it was created. A task created six months ago that the
 *  contact finishes today contributes to today's velocity; a task
 *  created two months ago that's still open contributes nothing
 *  (no terminal signal). Matches declaration `window.rolling_days: 30`
 *  + `event_time_field: 'task.completed_at'`.
 *
 *  Sample-floor. 30 completed tasks in window per spec § A.7.5 PSI
 *  calibration baseline (matches `PSI_SAMPLE_FLOOR_MINIMUM` +
 *  `commitment_followthrough_score`). Below floor → `produce()`
 *  returns null (no row). Spec § A.7.5: "under floor → emit
 *  `coverage.sources_degraded: 'sample_floor_unmet'` + abstain;
 *  never compute thin".
 *
 *  Confidence (PSI-eligible). Linear ramp matching `commitment_followthrough_score`:
 *
 *      confidence = clamp(sample_count / 100, 0, 1)
 *
 *  At sample_floor (30) → confidence ≈ 0.30; at the saturation cap
 *  (100 tasks) → 1.00. Exposed as
 *  `TASK_COMPLETION_VELOCITY_CONFIDENCE_SATURATION`. Tunable params
 *  lift candidate (sales reps see hundreds of tasks/quarter; ICs see
 *  dozens — saturation differs per role).
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
 *  `data.task.state_changed` + `data.task.completed` per the
 *  declaration's `invalidation_triggers`. The work-entity due-status
 *  sweep already cascades task transitions to downstream PA9
 *  enrichment; the stale-sweep re-derives within the next eligible
 *  cycle.
 *
 *  Spec: D-145 §§ A.7.1 (line 741) + A.7.2 + A.7.5 +
 *        `ENRICHMENT_REGISTRY.task_completion_velocity` +
 *        `packages/contracts/src/enrichment-declarations/task-completion-velocity.ts`. */

import {
  computeProducerVersionHash,
  type ContactRecord,
  type PsiEligibleScoreValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { TASK_TABLE } from '../../storage/work-entity-store.js';
import { contactAddresses, sqlInList } from './_contact-addresses.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** 30-day rolling window — matches declaration `window.n` so cascade
 *  invalidation + producer computation agree on the same horizon. */
export const TASK_COMPLETION_VELOCITY_WINDOW_DAYS = 30;
export const TASK_COMPLETION_VELOCITY_WINDOW_MS =
  TASK_COMPLETION_VELOCITY_WINDOW_DAYS * 86_400_000;

/** Minimum completed tasks in window for the producer to emit.
 *  Matches declaration `sample_floor: 30` + the substrate-wide PSI
 *  calibration baseline (`PSI_SAMPLE_FLOOR_MINIMUM`). Below this the
 *  per-day rate is too noisy + PSI drift detection needs ≥ 30-row
 *  baseline per bucket. */
export const TASK_COMPLETION_VELOCITY_SAMPLE_FLOOR = 30;

/** Sample size at which confidence saturates to 1.0. Linear ramp from
 *  sample_floor up. Mirrors `commitment_followthrough_score` for cross-
 *  producer consistency. Exposed for unit testing + future
 *  tunable_params lift. */
export const TASK_COMPLETION_VELOCITY_CONFIDENCE_SATURATION = 100;

/** Static base inputs for `computeProducerVersionHash`. PSI drift
 *  detection iterates the confidence distribution per producer-
 *  version; bumping `producer_code_hash` invalidates every existing
 *  row + lets D-133 pick up the new distribution. Bump on every
 *  meaningful behaviour change (filter shift, window-size change,
 *  rate formula tweak). */
const PRODUCER_VERSION_HASH_BASE = {
  producer_code_hash: 'task_completion_velocity:1',
  model_id: '',
  prompt_template_hash: '',
  adapter_version: '',
  consumed_ingredients_versions: [],
} as const;

/** Cached at module load — pure function over a closed set of inputs. */
export const TASK_COMPLETION_VELOCITY_PRODUCER_VERSION_HASH =
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
export const computeVelocityConfidence = (
  sample_count: number,
  saturation: number = TASK_COMPLETION_VELOCITY_CONFIDENCE_SATURATION,
): number => {
  if (!Number.isFinite(sample_count) || sample_count <= 0) return 0;
  if (!Number.isFinite(saturation) || saturation <= 0) return 0;
  const ratio = sample_count / saturation;
  return ratio >= 1 ? 1 : ratio;
};

// ────────────────────────────────────────────────────────────────
// SQL query
// ────────────────────────────────────────────────────────────────

export interface CompletedTaskCounts {
  /** Number of tasks completed by this contact in window. */
  completed_count: number;
  /** MAX(`completed_at`) across contributing rows. NULL when no rows
   *  contribute (caller short-circuits on `< sample_floor` before
   *  reading). */
  latest_completed_at: number | null;
}

const ZERO_COMPLETED_COUNTS: CompletedTaskCounts = {
  completed_count: 0,
  latest_completed_at: null,
};

/** Query the task table for one contact's completed tasks in the
 *  rolling window. Uses `idx_task_assigned_done` to narrow on
 *  `(assigned_contact_id, done)`; the `completed_at >= since` filter
 *  is a final-tier predicate over the narrowed range. Tombstones
 *  (`deleted_at IS NOT NULL` or `sync_state = 'tombstoned'`)
 *  excluded — they're cancellations, not closures. */
export const countCompletedTasksForContact = (
  ctx: HousekeepingContext,
  contact_email: string,
  since: number,
): CompletedTaskCounts => {
  if (contact_email === '') return ZERO_COMPLETED_COUNTS;
  // D-205 #3.5 — across the merge group. A velocity is a RATE, so tasks stranded
  // on an absorbed address don't just shrink the numerator — they make a busy
  // person look idle.
  const addresses = contactAddresses(ctx, contact_email);
  if (addresses.length === 0) return ZERO_COMPLETED_COUNTS;
  const row = ctx.db
    .prepare(
      `SELECT
          COUNT(*) AS completed_count,
          MAX(completed_at) AS latest_completed_at
        FROM "${TASK_TABLE}"
        WHERE assigned_contact_id IN (${sqlInList(addresses.length)})
          AND done = 1
          AND completed_at IS NOT NULL
          AND completed_at >= ?
          AND sync_state IN ('live', 'stale_unreachable')
          AND deleted_at IS NULL`,
    )
    .get(...addresses, since) as
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

export const taskCompletionVelocityProducer: HousekeepingEnrichmentProducer<ContactRecord> = {
  topic: 'task_completion_velocity',
  source_scope: 'contact',
  producer_version_hash: TASK_COMPLETION_VELOCITY_PRODUCER_VERSION_HASH,
  scope_read_declaration: [
    // `merged_into`: the assignee query reads the merge graph to widen itself
    // across the contact's absorbed addresses (D-205 #3.5).
    { collection: 'data.contact', sample_field_paths: ['email', 'merged_into'] },
    {
      collection: 'data.task',
      sample_field_paths: ['assigned_contact_id', 'done', 'completed_at'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '24h',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<ContactRecord>) {
    const email = source_record.data.email;
    if (!email) return null;
    const now = ctx.now();
    const since = now - TASK_COMPLETION_VELOCITY_WINDOW_MS;

    const { completed_count, latest_completed_at } =
      countCompletedTasksForContact(ctx, email, since);

    if (completed_count < TASK_COMPLETION_VELOCITY_SAMPLE_FLOOR) {
      // Below PSI calibration baseline — abstain rather than emit a
      // thin score. Per spec § A.7.5: "under floor → emit
      // `coverage.sources_degraded: 'sample_floor_unmet'` + abstain;
      // never compute thin".
      return null;
    }

    // Tasks per day across the rolling window. Raw rate, not 0..1 —
    // see header for rationale (no natural ratio; saturation would
    // compress the top of the distribution for PSI iteration).
    const score = completed_count / TASK_COMPLETION_VELOCITY_WINDOW_DAYS;
    const confidence = computeVelocityConfidence(completed_count);

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
