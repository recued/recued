/** D-139 P3 — `engagement_velocity_signal` deterministic producer.
 *
 *  Touches/week trajectory on a deal — compares the recent (30d)
 *  window against the baseline (30-90d) window. Pure compute over
 *  `EngagementRow[]` (substrate-side filtered + edge-walked); zero
 *  token cost.
 *
 *  Pass-4 evidence-quality consumption defaults baked into the
 *  algorithm:
 *    - lifecycle_state: `'point_in_time'` + `'completed'` count at
 *      full weight; `'no_answer'` (call attempt — connection
 *      failed) counts at 0.25; everything else (`'pending'`,
 *      `'scheduled'`, `'cancelled'`, `'failed'`, `'rescheduled'`)
 *      excluded entirely.
 *    - authorship: `'crm_automation'` + `'system_process'` weighted
 *      at 0.25 each (workflow auto-logs + tracking pixels are
 *      weaker signal but not zero); everything else weighted 1.0.
 *    - direction: `'internal'` excluded (rep-to-rep chatter doesn't
 *      count against external trajectory); `'inbound'` / `'outbound'`
 *      / `'unknown'` included.
 *    - dedupe_acceptance: `'exact_only'` — caller is responsible for
 *      passing through `'probable'`-confidence twins as separate
 *      rows; producer over-counts rather than mis-merges.
 *    - event_at: `null` rows excluded (the touch hasn't happened
 *      yet — pending tasks, future meetings).
 *
 *  Trajectory math (90d split into recent 30d + baseline 60d):
 *    weighted_recent_per_30d   = weighted_recent
 *    weighted_baseline_per_30d = weighted_baseline / 2  (60d → 30d-eq)
 *    ratio = weighted_recent_per_30d / max(weighted_baseline_per_30d, EPSILON)
 *    ratio ≥ 1.5 → 'accelerating'
 *    ratio ≤ 0.5 → 'decaying'
 *    otherwise   → 'steady'
 *
 *  Coverage metadata composed from caller-supplied substrate state
 *  (rate-control / replay-ledger / authorship-unknown signals).
 *  Producer never derives degradation itself — substrate is the
 *  authoritative source per § A.9.3.
 *
 *  Spec: D-139 § A.9.1 + § A.9.3 + § P3 acceptance. */

import {
  type CoverageMetadata,
  type EngagementRow,
  type EngagementVelocitySignalValue,
  type EngagementVelocityTrajectory,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** 30 days — the recent (foreground) trajectory window. */
export const VELOCITY_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** 60 days — the baseline (30-90d) trajectory window. */
export const VELOCITY_BASELINE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

/** Authorship weight for `'crm_automation'` + `'system_process'` rows.
 *  Workflow auto-logs + tracking pixels are weaker engagement signal
 *  but not zero — a HubSpot workflow logging a follow-up still
 *  represents intent. */
export const VELOCITY_AUTOMATION_WEIGHT = 0.25;

/** Lifecycle weight for `'no_answer'` calls. The rep made the
 *  attempt — counts as outbound effort but at lower trajectory
 *  contribution than connected calls. */
export const VELOCITY_NO_ANSWER_WEIGHT = 0.25;

/** Trajectory-bucket cutoffs. Mirrors `engagement_score_per_contact`
 *  + `meeting_frequency` ratios so cross-topic recipes stay
 *  legible. */
export const VELOCITY_ACCELERATING_RATIO = 1.5;
export const VELOCITY_DECAYING_RATIO = 0.5;

/** Min combined weighted sample before reporting non-`'steady'`.
 *  Below this floor the comparison is statistical noise — same
 *  shape as `engagement_score_per_contact`'s `MIN_SAMPLE`. */
export const VELOCITY_MIN_SAMPLE = 2;

const EPSILON = 1e-9;

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Per-row weight from authorship + lifecycle. Returns 0 to signal
 *  "skip this row entirely" (excluded direction or excluded
 *  lifecycle state). */
export const velocityWeightForRow = (row: EngagementRow): number => {
  // Direction filter — internal-only chatter doesn't count.
  if (row.direction === 'internal') return 0;

  // Lifecycle filter — only evidence-bearing states contribute.
  // `'no_answer'` counts at lower weight (the attempt happened but
  // didn't connect); everything else outside evidence states is 0.
  let lifecycle_weight: number;
  if (row.lifecycle_state === 'point_in_time') lifecycle_weight = 1.0;
  else if (row.lifecycle_state === 'completed') lifecycle_weight = 1.0;
  else if (row.lifecycle_state === 'no_answer') lifecycle_weight = VELOCITY_NO_ANSWER_WEIGHT;
  else return 0;

  // Authorship weighting — automation + system_process at 0.25.
  const authorship_weight =
    row.authorship === 'crm_automation' || row.authorship === 'system_process'
      ? VELOCITY_AUTOMATION_WEIGHT
      : 1.0;

  return authorship_weight * lifecycle_weight;
};

/** Bucket a per-30d ratio into the closed trajectory enum. */
export const decideVelocityTrajectory = (
  weighted_recent: number,
  weighted_baseline_per_30d: number,
): EngagementVelocityTrajectory => {
  const total = weighted_recent + weighted_baseline_per_30d;
  if (total < VELOCITY_MIN_SAMPLE) return 'steady';
  // No baseline + any recent activity → accelerating (the deal
  // started moving in the recent window). Mirrors
  // `engagement_score_per_contact`'s zero-baseline path.
  if (weighted_baseline_per_30d < EPSILON) {
    return weighted_recent > 0 ? 'accelerating' : 'steady';
  }
  const ratio = weighted_recent / weighted_baseline_per_30d;
  if (ratio >= VELOCITY_ACCELERATING_RATIO) return 'accelerating';
  if (ratio <= VELOCITY_DECAYING_RATIO) return 'decaying';
  return 'steady';
};

// ────────────────────────────────────────────────────────────────
// Producer entry point
// ────────────────────────────────────────────────────────────────

export interface EngagementVelocityProducerInput {
  /** Engagement rows already scoped to the deal via edge-walker
   *  (`engagement_edges` WHERE `edge_type='deal' AND target_id=...`).
   *  Rows MUST be the substrate-side `EngagementRow` shape — Pass-4
   *  evidence-quality fields populated by reconciler ingest. */
  rows: ReadonlyArray<EngagementRow>;
  /** Caller-supplied coverage signals. Producer never derives these
   *  from row state — substrate composes per § A.9.3. */
  coverage: CoverageMetadata;
  /** Wall-clock now() in unix-ms UTC. */
  now: number;
}

export interface EngagementVelocityProducerOutput {
  value: EngagementVelocitySignalValue;
  coverage: CoverageMetadata;
}

/** Pure compute. Iterates the row set in one O(n) pass; partitions
 *  into recent + baseline windows on `event_at`; folds weights;
 *  decides bucket. Deterministic — same inputs always produce same
 *  output (no clock reads beyond the supplied `now`). */
export const computeEngagementVelocitySignal = (
  input: EngagementVelocityProducerInput,
): EngagementVelocityProducerOutput => {
  const recent_cutoff = input.now - VELOCITY_RECENT_WINDOW_MS;
  const baseline_cutoff = input.now - VELOCITY_RECENT_WINDOW_MS - VELOCITY_BASELINE_WINDOW_MS;

  let weighted_recent = 0;
  let weighted_baseline = 0;
  let total_recent = 0;
  let total_baseline = 0;
  let cursor_at = 0;

  for (const row of input.rows) {
    if (row.event_at === null) continue;
    if (row.event_at < baseline_cutoff) continue;
    // Codex P2 #3 fold — track max vendor_modified_at across all
    // window-eligible rows (regardless of authorship/lifecycle
    // weight) so the cursor reflects the producer's read horizon.
    if (row.vendor_modified_at > cursor_at) cursor_at = row.vendor_modified_at;
    const weight = velocityWeightForRow(row);
    if (weight === 0) continue;
    if (row.event_at >= recent_cutoff) {
      weighted_recent += weight;
      total_recent += 1;
    } else {
      weighted_baseline += weight;
      total_baseline += 1;
    }
  }

  // Normalize baseline to per-30d rate before comparing — the
  // baseline window is twice the recent window so a flat trajectory
  // would otherwise look like decay.
  const weighted_baseline_per_30d = weighted_baseline / 2;
  const trajectory = decideVelocityTrajectory(weighted_recent, weighted_baseline_per_30d);

  const value: EngagementVelocitySignalValue = {
    trajectory,
    weighted_recent,
    weighted_baseline,
    total_recent,
    total_baseline,
    cursor_at,
  };

  return { value, coverage: input.coverage };
};
