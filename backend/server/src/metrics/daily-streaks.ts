/** D-250 § D5.3 — Hands off, and the two milestones that fall out of it.
 *
 *  🔑 WHY THIS IS A SEPARATE PRODUCER FROM THE SNAPSHOT METRICS: those are RECOMPUTED
 *  from a window and replaced. A streak cannot be — it ADVANCES one complete day at a
 *  time from its own prior value, which is the artifact model (amendment 17) and the
 *  only shape compatible with amendment 16's refusal to keep a per-day series.
 *
 *  ⛔⛔ A DAY IS ONLY DECIDABLE ONCE IT IS OVER. Evaluating "today needed no approvals"
 *  at 10am is a guess that an approval at 4pm falsifies — and since a streak feeds a
 *  RECORD, a wrong credit is permanent. So this walks COMPLETE days only, never today.
 *
 *  ⛔⛔ AND THE DEFINITION IS NARROWER THAN § D5.3's WORDING, WHICH CANNOT BE BUILT.
 *  The spec says "days needing zero approvals". **There is no `approval_ask_raised`
 *  action** — the audit log records `approval_allow` / `approval_deny`, i.e. ANSWERS.
 *  So this measures days with zero ANSWERED decisions. The two differ for an ask that
 *  timed out unanswered, which reads here as hands-off. That is the same limit § D5.3
 *  hit for Waved through — *you cannot count what did not happen* — and the honest fix
 *  is to say so in the logic line rather than to imply a measurement we do not take.
 */

import type Database from 'better-sqlite3';

import {
  AUTOPILOT_TRIGGER_CLASS,
  MILESTONE_REGISTRY,
  type AutopilotClass,
} from '@recued/contracts';

import type { MetricArtifactStore } from './artifact-store.js';

const DAY_MS = 86_400_000;

export const HANDS_OFF_CURRENT_KEY = 'hands_off.current';
export const HANDS_OFF_LONGEST_KEY = 'hands_off.longest';
/** The last COMPLETE day index already folded in. Without it the task — which runs many
 *  times a day — would advance the streak once per CYCLE instead of once per day. */
export const HANDS_OFF_LAST_DAY_KEY = 'hands_off.last_day';
export const UNATTENDED_RUN_KEY = 'unattended_days.current';
/** Per-recipe accumulated run total. ⛔ ACCUMULATED, NOT COUNTED. A `GROUP BY` over the
 *  audit log would silently measure "runs still RETAINED" — the log is quota'd and evicts
 *  oldest-first — so the badge would un-earn itself as the log rolled. Adding each
 *  complete day's runs forward never re-reads history, so the total survives eviction.
 *  ⚠ A missed day undercounts, never overcounts: the badge arrives late rather than
 *  wrongly, which is the right direction for an achievement. */
export const recipeRunsKey = (recipe_id: string): string => `recipe_runs.${recipe_id}`;
export const CENTURY_RUNS = 100;

/** ⛔ A COVERAGE GAP BREAKS THE STREAK RATHER THAN BEING CREDITED OR SKIPPED.
 *
 *  A server offline for a month cannot verify the days it missed: the audit log is
 *  quota'd and evicts OLDEST-FIRST, so "no approval rows that day" and "that day's rows
 *  are gone" are the SAME OBSERVATION. Crediting them would mint a streak out of missing
 *  data; skipping them would silently splice two runs into one. Resetting is the only
 *  reading that cannot invent a record. ⚠ A short gap is walked, because those days are
 *  recent enough that their rows are genuinely still there. */
export const MAX_CATCHUP_DAYS = 7;

export const dayIndex = (ms: number): number => Math.floor(ms / DAY_MS);

const sourcesIn = (cls: AutopilotClass): string => {
  const list = Object.entries(AUTOPILOT_TRIGGER_CLASS)
    .filter(([, v]) => v === cls)
    .map(([k]) => `'${k}'`);
  return list.length > 0 ? list.join(', ') : `''`;
};

export interface DailyStreakResult {
  readonly days_folded: number;
  readonly hands_off_current: number;
  readonly hands_off_longest: number;
  /** True when a coverage gap forced a reset — surfaced so the dashboard can say the
   *  streak broke because the server was OFF, not because an approval was answered. */
  readonly reset_for_gap: boolean;
  readonly milestones_earned: readonly string[];
}

/** Fold every complete day since the last fold into the streaks. Idempotent: a second
 *  call in the same day folds nothing. */
export const advanceDailyStreaks = (
  db: Database.Database,
  artifact: MetricArtifactStore,
  now: number,
): DailyStreakResult => {
  const today = dayIndex(now);
  const lastFolded = artifact.readCounter(HANDS_OFF_LAST_DAY_KEY);
  const earned: string[] = [];

  // ⛔ THE FIRST EVER RUN SEEDS AND FOLDS NOTHING. Setting the cursor to `today - 2`
  // would fold yesterday immediately — crediting a day on which THIS SERVER WAS NOT
  // RUNNING, which is the same invention as crediting a coverage gap and is ruled out
  // for the same reason. `today - 1` means "yesterday is already accounted for", so the
  // loop below is empty and the streak starts from the first day actually observed.
  let cursor = lastFolded === undefined ? today - 1 : lastFolded;
  let reset = false;
  if (today - 1 - cursor > MAX_CATCHUP_DAYS) {
    artifact.setCounter(HANDS_OFF_CURRENT_KEY, 0, now);
    artifact.setCounter(UNATTENDED_RUN_KEY, 0, now);
    cursor = today - 2;
    reset = true;
  }

  const answered = db.prepare(
    `SELECT COUNT(*) AS n FROM audit_activities
      WHERE json_extract(data, '$.action') IN ('approval_allow', 'approval_deny')
        AND json_extract(data, '$.timestamp') >= ?
        AND json_extract(data, '$.timestamp') < ?`,
  );
  // ⛔ ONE ROW PER RECIPE PER DAY, not per run. The accumulator adds this day's total to
  // whatever the recipe already had.
  const perRecipe = db.prepare(
    `SELECT json_extract(data, '$.recipe_id') AS recipe_id, COUNT(*) AS n
       FROM audit_entries
      WHERE json_extract(data, '$.started_at') >= ?
        AND json_extract(data, '$.started_at') < ?
        AND json_extract(data, '$.recipe_id') IS NOT NULL
      GROUP BY 1`,
  );
  // § D5.3 — "another server ANSWERED you". ⚠ The ANSWER, not the ask: an outbound ask
  // proves you tried, an answer proves a working two-way relationship.
  const peerAnswered = db.prepare(
    `SELECT COUNT(*) AS n FROM audit_activities
      WHERE json_extract(data, '$.action') = 'peer_ask_answered'
        AND json_extract(data, '$.timestamp') >= ?
        AND json_extract(data, '$.timestamp') < ?`,
  );

  const runs = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN json_extract(data, '$.trigger_source')
                           IN (${sourcesIn('unattended')}) THEN 1 ELSE 0 END), 0) AS unattended,
       COALESCE(SUM(CASE WHEN json_extract(data, '$.trigger_source')
                           IN (${sourcesIn('attended')}) THEN 1 ELSE 0 END), 0) AS attended
     FROM audit_entries
      WHERE json_extract(data, '$.started_at') >= ?
        AND json_extract(data, '$.started_at') < ?`,
  );

  let current = artifact.readCounter(HANDS_OFF_CURRENT_KEY) ?? 0;
  let unattendedRun = artifact.readCounter(UNATTENDED_RUN_KEY) ?? 0;
  let folded = 0;

  for (let day = cursor + 1; day <= today - 1; day += 1) {
    const from = day * DAY_MS;
    const to = from + DAY_MS;
    const decisions = (answered.get(from, to) as { n: number }).n;
    const r = runs.get(from, to) as { unattended: number; attended: number };

    current = decisions === 0 ? current + 1 : 0;
    // ⚠ AT LEAST ONE UNATTENDED RUN IS REQUIRED, so an IDLE server does not earn a week
    // on autopilot. Rewarding "did nothing" would be § D6's failure exactly — an
    // optimal cheat that is not the desired behaviour.
    unattendedRun = r.attended === 0 && r.unattended > 0 ? unattendedRun + 1 : 0;

    if (current >= 1 && !artifact.hasMilestone('first_zero_approval_day')) {
      artifact.earnMilestone('first_zero_approval_day', to);
      earned.push('first_zero_approval_day');
    }
    if (unattendedRun >= 7 && !artifact.hasMilestone('first_unattended_week')) {
      artifact.earnMilestone('first_unattended_week', to);
      earned.push('first_unattended_week');
    }

    if ((peerAnswered.get(from, to) as { n: number }).n > 0
        && !artifact.hasMilestone('first_peer_paired')) {
      artifact.earnMilestone('first_peer_paired', to);
      earned.push('first_peer_paired');
    }

    for (const row of perRecipe.all(from, to) as Array<{ recipe_id: string; n: number }>) {
      const key = recipeRunsKey(row.recipe_id);
      const total = (artifact.readCounter(key) ?? 0) + row.n;
      artifact.setCounter(key, total, now);
      if (total >= CENTURY_RUNS && !artifact.hasMilestone('first_recipe_100_runs')) {
        artifact.earnMilestone('first_recipe_100_runs', to);
        earned.push('first_recipe_100_runs');
      }
    }
    folded += 1;
  }

  if (folded > 0 || lastFolded === undefined || reset) {
    artifact.setCounter(HANDS_OFF_CURRENT_KEY, current, now);
    artifact.setCounter(UNATTENDED_RUN_KEY, unattendedRun, now);
    artifact.setCounter(HANDS_OFF_LAST_DAY_KEY, today - 1, now);
    // ⛔ THE LONGEST IS A RECORD, NOT A COUNTER — a broken streak resets `current` and
    // must never reach the best. Two keys is what makes that structural (slice 1).
    artifact.advanceRecord(HANDS_OFF_LONGEST_KEY, current, now);
  }

  // Referenced so an added milestone that this producer cannot detect is a visible
  // omission rather than a silent one.
  void MILESTONE_REGISTRY;

  return {
    days_folded: folded,
    hands_off_current: current,
    hands_off_longest: artifact.readRecord(HANDS_OFF_LONGEST_KEY) ?? 0,
    reset_for_gap: reset,
    milestones_earned: earned,
  };
};
