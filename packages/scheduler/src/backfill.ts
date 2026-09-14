/** Smart Backfill — Phase 5 (revised: time-based catch-up, system-wide window).
 *
 *  No per-cycle missed_due records anywhere. The cloud doesn't track
 *  misses at all. The server's local scheduler runs one check per
 *  enabled schedule per tick: if at least one cron-matched cycle
 *  passed since the last fire AND the wait until the next regular
 *  cycle is longer than `BACKFILL_WINDOW_MIN`, fire one catch-up
 *  now.
 *
 *  ⛔ D-266 OVERTURNS THE PARAGRAPH THAT USED TO STAND HERE. It read
 *  "backfill behaviour is system-wide, not a per-recipe knob — recipe
 *  schemas describe WHAT a recipe does, not HOW the system runs it",
 *  and proposed deriving a catch-up opt-out from `risk_tier` instead
 *  of adding a field. That reasoning holds for the RECIPE and fails
 *  for the SCHEDULE: it is the owner, not the author, who knows
 *  whether a late run is worth having, and the same recipe answers
 *  differently on two schedules. So `missed_policy` hangs off the
 *  SCHEDULE (an owner-written record) and not the recipe — which is
 *  why no recipe-schema field appears anywhere in this change, and
 *  why the original rule is still right about what it was about.
 *
 *  ⛔ THE MISSED-CYCLE COUNT IS NO LONGER AN OBSERVED-CADENCE ESTIMATE.
 *  It used to divide the gap by `prev_run_at → last_run_at`; that pair
 *  SPANS AN OUTAGE (nothing ran in between), so the first judgement
 *  after any real downtime read an outage-width "interval" and called a
 *  month-long gap fresh. It now COUNTS cron-matched occurrences, which
 *  is exact for irregular crons too — see `countOutstandingOccurrences`
 *  for why every arithmetic substitute is not. */

import { DEFAULT_MISSED_SCHEDULE_POLICY } from '@recued/contracts';
import type { Schedule } from './types.js';
import { nextCronMatch } from './cron-interval.js';

/** System-wide catch-up window in minutes. 30 is the conservative
 *  default — failures of catch-up (skipped catch-up) are silent and
 *  the next regular cycle handles it; spurious catch-ups (double
 *  fires) are visible side effects. Tighter values shift the
 *  trade-off toward freshness, looser toward safety. */
export const BACKFILL_WINDOW_MIN = 30;

/** Minimal shape `shouldCatchUp` needs. Accepts the server-local
 *  `Schedule` directly and the cloud cron's `ScheduleRow` after
 *  string-to-ms conversion of timestamps — same logic, two callers. */
export type ScheduleForCatchUp = Pick<Schedule, 'cron_expression' | 'last_run_at'>;

/** Should the scheduler fire a catch-up for this schedule on this
 *  tick? `true` only when (1) the schedule has fired before, (2) at
 *  least one cron-matched minute passed since the last fire, and
 *  (3) the wait until the next regular cycle is longer than
 *  `BACKFILL_WINDOW_MIN`. */
export function shouldCatchUp(
  schedule: ScheduleForCatchUp,
  now: number,
): boolean {
  // (1) Never fired — no fires can have been missed; schedule starts
  // fresh on its next regular cycle.
  if (schedule.last_run_at === null) return false;

  const parts = schedule.cron_expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  // (2) Did at least one cron-matched minute pass between last_run_at
  // and now? `nextCronMatch` returns the current minute when it
  // matches, so step strictly forward by 1 min from the last fire.
  // If the next expected match is still in the future, the regular
  // tick handles it — no catch-up.
  const nextExpected = nextCronMatch(parts, schedule.last_run_at + 60_000);
  if (nextExpected === null || nextExpected > now) return false;

  // (3) Catch up only when the wait until the next regular cycle is
  // longer than the window. Step forward by 1 min for the same
  // reason — we want strictly future matches.
  const nextFromNow = nextCronMatch(parts, now + 60_000);
  if (nextFromNow === null) return false;
  return (nextFromNow - now) / 60_000 > BACKFILL_WINDOW_MIN;
}

/** Where the DISPLAY count stops. Ninety-nine is chosen so the scan
 *  cost stays bounded for a long outage (a daily cron stops after 99
 *  days of walking, ~36 ms) while covering every outage an owner would
 *  read a number off. Past it the honest rendering is "99+". */
export const DISPLAY_OCCURRENCE_LIMIT = 99;

/** Where the AUDIT count stops — high enough to be exact for any real
 *  outage (10,000 daily occurrences is 27 years).
 *
 *  🔑 IT CAN AFFORD TO BE, AND THE CARD'S LIMIT CANNOT, because of WHEN
 *  each runs. The card's count is recomputed every tick for as long as
 *  the owner has not answered; this one runs ONCE, on the catch-up fire
 *  itself. The scan is bounded by `now` regardless, so this limit is a
 *  rail against a pathological cron rather than a truncation anyone
 *  should meet. */
export const AUDIT_OCCURRENCE_LIMIT = 10_000;

/** How many cron-matched occurrences fall in `(lastRunAt, now]`,
 *  counted only as far as `limit`.
 *
 *  ⛔ THIS REPLACED AN OBSERVED-CADENCE ESTIMATE, AND THE REASON IS A
 *  MEASURED DEFECT, NOT TIDINESS. The old measure divided the gap by
 *  `last_run_at - prev_run_at` — and after a real outage that PAIR
 *  SPANS THE OUTAGE, because nothing ran in between. A daily schedule
 *  down thirty days and then run once recorded a THIRTY-ONE DAY
 *  "interval", so the next judgement read a 34-day gap as well under
 *  one cycle and called it fresh. For `'ask'` that is the wrong
 *  direction in kind: a run the owner asked to be consulted about fires
 *  silently.
 *
 *  🔑 COUNTING OCCURRENCES IS EXACT WHERE EVERY ARITHMETIC SHORTCUT IS
 *  NOT, and the weekday case is the proof. `cronIntervalMs` — the
 *  obvious substitute — returns the MINIMUM spacing, so `0 8 * * 1-5`
 *  reads one day and a Friday-to-Monday gap scores two missed cycles
 *  that never existed. Driven: this returns 1 (catch it up), and 2 only
 *  once a genuine second weekday has passed.
 *
 *  ⚠ THE `limit` IS LOAD-BEARING, NOT A GUARD. The scan walks the
 *  window a minute at a time (`nextCronMatch` resumes from each match,
 *  so the whole loop is ONE linear pass), which means cost tracks the
 *  WINDOW, not the number of matches: a daily cron down a year is
 *  ~525k steps ≈ 135 ms. Stopping at the smallest count that answers
 *  the question is what keeps that off the tick — the decision needs
 *  only "is there a second one?" and passes 2, measured at ≤ 16 ms for
 *  the worst cadence (monthly). Callers that want a number for display
 *  pass a larger limit and must render `capped` as "N+", never as N. */
export function countOutstandingOccurrences(
  cronExpression: string,
  lastRunAt: number,
  now: number,
  limit: number,
): { count: number; capped: boolean } {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5 || limit <= 0) return { count: 0, capped: false };
  let count = 0;
  let at = lastRunAt;
  for (;;) {
    // Step strictly forward: `nextCronMatch` returns the current minute
    // when it matches, so starting at `at` would count it again.
    const match = nextCronMatch(parts, at + 60_000);
    if (match === null || match > now) return { count, capped: false };
    count += 1;
    at = match;
    if (count >= limit) return { count, capped: true };
  }
}

/** Missed cycles BEYOND the single catch-up on offer — the number the
 *  audit row and the missed-run card show.
 *
 *  ⚠ `'unknown'` now means "the cron could not be read", NOT "no
 *  `prev_run_at` to sample yet". The measure no longer samples anything:
 *  a schedule that has run exactly once reports a real count from its
 *  first run onward, where the old one reported `'unknown'` for the
 *  whole of its first catch-up.
 *
 *  ⚠ `capped` is dropped here because this scans to
 *  `AUDIT_OCCURRENCE_LIMIT`, which no real outage reaches — the audit
 *  row gets an exact number. A caller that needs the CHEAP bounded scan
 *  (the missed-run card, recomputed every tick) must call
 *  `countOutstandingOccurrences` itself and render its `capped` as
 *  "N+". */
export function countMissedCycles(
  schedule: Pick<Schedule, 'last_run_at' | 'cron_expression'>,
  now: number,
): number | 'unknown' {
  const last = schedule.last_run_at;
  if (last === null) return 'unknown';
  const parts = schedule.cron_expression.trim().split(/\s+/);
  if (parts.length !== 5) return 'unknown';
  const { count } = countOutstandingOccurrences(
    schedule.cron_expression, last, now, AUDIT_OCCURRENCE_LIMIT,
  );
  return Math.max(0, count - 1);
}

/** Build the audit metadata payload that rides on a catch-up fire's
 *  AuditEntry. The webclient renderer surfaces these fields so
 *  operators see the missed count + the prior last_run_at without
 *  scanning two rows. */
export interface BackfillMetadata {
  missed_cycles: number | 'unknown';
  /** The `last_run_at` value the schedule had BEFORE this catch-up
   *  bumped it. Lets operators see the actual outage window without
   *  computing it from two rows. */
  last_run_at_before: number;
}

export function buildBackfillMetadata(
  schedule: Pick<Schedule, 'last_run_at' | 'cron_expression'>,
  now: number,
): BackfillMetadata {
  return {
    missed_cycles: countMissedCycles(schedule, now),
    last_run_at_before: schedule.last_run_at!,
  };
}

// ────────────────────────────────────────────────────────────────
// D-266 — owner-declared missed-schedule policy
// ────────────────────────────────────────────────────────────────

/** Is a SECOND cron-matched occurrence outstanding — i.e. more than the
 *  one a catch-up would fire?
 *
 *  This is the STALENESS bound, and it is a genuinely different question
 *  from `BACKFILL_WINDOW_MIN` above, which is a NEXT-OCCURRENCE-
 *  PROXIMITY bound ("don't catch up when the regular cycle is
 *  imminent"). The proximity bound was never wrong; it just never
 *  bounded staleness, and the two only diverge once the gap exceeds
 *  roughly one interval. Both must pass.
 *
 *  🔑 TWO is the whole threshold, and it is not a tunable pretending to
 *  be one. "Exactly one occurrence outstanding" is the case every
 *  policy agrees to fire — hourly twenty minutes late, daily a day
 *  late, a weekday cron on the Monday after a weekend. A second
 *  outstanding occurrence is the first moment the schedule is
 *  measurably behind rather than merely late. Allowing N would mean
 *  counting past 2, which is what makes the scan expensive. */
const isStale = (
  cronExpression: string,
  lastRunAt: number,
  now: number,
): boolean => countOutstandingOccurrences(cronExpression, lastRunAt, now, 2).count >= 2;

/** What the scheduler should do about this schedule's missed cycle.
 *
 *   - `'none'` — nothing is owed. Either nothing was missed, or the
 *     next regular cycle is close enough to serve as the catch-up.
 *   - `'fire'` — dispatch one catch-up now (today's behaviour).
 *   - `'skip'` — do not run it; record that it was skipped.
 *   - `'ask'`  — decide nothing; leave the miss pending and put it in
 *     front of the owner. */
export type MissedAction = 'none' | 'fire' | 'skip' | 'ask';

export type ScheduleForMissedAction =
  ScheduleForCatchUp
  & Pick<Schedule, 'prev_run_at' | 'missed_policy' | 'missed_answer'>;

/** Resolve the owner's policy against the two measures that already
 *  ship. This is the ONE place the four policies branch.
 *
 *  ⚠ `countMissedCycles` returns `'unknown'` when there is no
 *  `prev_run_at` to sample a cadence from — the first catch-up after
 *  a schedule is created. Unknown is read as NOT STALE, deliberately:
 *  it preserves pre-D-266 behaviour for a brand-new schedule, and the
 *  alternative (treat unmeasurable as suspect) would ask the owner a
 *  question on the first miss of every schedule they ever write,
 *  which is exactly the fatigue that makes `'ask'` the first option
 *  anyone switches off. */
export function resolveMissedAction(
  schedule: ScheduleForMissedAction,
  now: number,
): MissedAction {
  // The proximity bound gates everything: when it says no, no cycle is
  // outstanding (or the regular tick is about to cover it), and there
  // is nothing for any policy to decide.
  if (!shouldCatchUp(schedule, now)) return 'none';

  // An explicit answer outranks the standing policy — the owner is
  // deciding this occurrence, which is the whole point of `'ask'`. It is
  // live only while it post-dates the last run: any later run moves
  // `last_run_at` past it and spends it.
  //
  // ⛔ BOTH VERDICTS ARE TERMINAL HERE. `'skip'` returning `'none'` is
  // what stops the question coming back: a skip deliberately moves no
  // timestamp, so without reading the answer the miss is still
  // outstanding on the next tick and the ask the owner just answered is
  // raised again, forever.
  const answered = schedule.missed_answer;
  if (
    answered !== undefined
    && schedule.last_run_at !== null
    && answered.at > schedule.last_run_at
  ) return answered.answer === 'run' ? 'fire' : 'none';

  const policy = schedule.missed_policy ?? DEFAULT_MISSED_SCHEDULE_POLICY;
  if (policy === 'catch_up') return 'fire';
  if (policy === 'skip') return 'skip';

  // `shouldCatchUp` above already returned false for a null `last_run_at`
  // (a schedule that never fired can have missed nothing), so this is a
  // number by the time we reach it — narrowed rather than asserted.
  const lastRunAt = schedule.last_run_at ?? 0;
  const stale = isStale(schedule.cron_expression, lastRunAt, now);

  // `'ask'` gets its trigger for free: a fresh miss is not a question,
  // a stale one is. Without this the strongest option would fire a
  // prompt every time a laptop lid closed over a single cycle.
  if (policy === 'ask') return stale ? 'ask' : 'fire';

  return stale ? 'skip' : 'fire';
}

/** One line of the wake card: a recipe with at least one schedule
 *  waiting on the owner.
 *
 *  ⛔ KEYED BY RECIPE, NOT BY SCHEDULE, AND THAT DECIDES HOW MANY RUNS
 *  HAPPEN. D-266: "one run per recipe, but the count stays visible" —
 *  a brief supersedes a brief. Two schedules of one recipe that both
 *  missed produce ONE entry and, on `run`, ONE fire; the others are
 *  recorded skipped. `schedule_ids` therefore carries all of them, and
 *  `run_schedule_id` names the single one that would actually fire. */
export interface MissedRunEntry {
  recipe_id: string;
  /** Every schedule of this recipe currently waiting on an answer,
   *  most-recently-run first. */
  schedule_ids: string[];
  /** The one that fires on `run` — the most recent, since only the
   *  latest cycle is worth running. */
  run_schedule_id: string;
  /** Full cycles missed beyond the single catch-up on offer; the
   *  largest across this recipe's waiting schedules. `'unknown'` only
   *  when the cron cannot be read. NOT the number of runs offered — it
   *  is the record of the outage, and the only place the owner learns
   *  the machine was off for three days. */
  missed_cycles: number | 'unknown';
  /** The count stopped at `DISPLAY_OCCURRENCE_LIMIT` — the real figure
   *  is at least this, and a renderer MUST show "N+" rather than N.
   *
   *  ⛔ REACHED IN PRACTICE, not a theoretical edge: an hourly schedule
   *  down four days passes 99 occurrences, and every schedule on this
   *  card is hourly-or-rarer by construction (the proximity bound keeps
   *  frequent crons out entirely). Without this flag the card would
   *  state a precise "missed 99" for an outage of any length above it. */
  missed_cycles_capped: boolean;
  /** When `run_schedule_id` last actually ran. */
  last_run_at: number;
}

/** Everything the one-per-wake card needs, recomputed from live
 *  schedule rows.
 *
 *  🔑 THIS IS A READ, NOT A DURABLE ASK. The set of outstanding misses
 *  is fully re-derivable from `last_run_at` + the cron + the clock, so
 *  storing it would buy nothing and cost the usual: a row that can
 *  disagree with the world, an answer that clears a still-true
 *  finding, an expiry nobody tends. Nothing here persists; the card is
 *  gone the moment the underlying schedules stop qualifying. */
export interface MissedRunReport {
  /** Start of the outage window — the OLDEST `last_run_at` among the
   *  waiting entries. Null when there are none. */
  outage_from: number | null;
  /** The clock this report was computed against. */
  outage_to: number;
  entries: MissedRunEntry[];
}

export function buildMissedRunReport(
  schedules: readonly (Schedule & { enabled: boolean })[],
  now: number,
): MissedRunReport {
  const byRecipe = new Map<string, Schedule[]>();
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (resolveMissedAction(schedule, now) !== 'ask') continue;
    const bucket = byRecipe.get(schedule.recipe_id);
    if (bucket) bucket.push(schedule);
    else byRecipe.set(schedule.recipe_id, [schedule]);
  }

  const entries: MissedRunEntry[] = [];
  for (const [recipe_id, group] of byRecipe) {
    // Most recent first — the head is the cycle worth running.
    group.sort((a, b) => (b.last_run_at ?? 0) - (a.last_run_at ?? 0));
    let missed: number | 'unknown' = 'unknown';
    let capped = false;
    for (const schedule of group) {
      if (schedule.last_run_at === null) continue;
      const scan = countOutstandingOccurrences(
        schedule.cron_expression, schedule.last_run_at, now, DISPLAY_OCCURRENCE_LIMIT,
      );
      const count = Math.max(0, scan.count - 1);
      if (missed === 'unknown' || count > missed) {
        missed = count;
        capped = scan.capped;
      }
    }
    entries.push({
      recipe_id,
      schedule_ids: group.map((s) => s.schedule_id),
      run_schedule_id: group[0]!.schedule_id,
      missed_cycles: missed,
      missed_cycles_capped: capped,
      last_run_at: group[0]!.last_run_at!,
    });
  }

  // Longest-waiting first: the outage reads top-down.
  entries.sort((a, b) => a.last_run_at - b.last_run_at);
  return {
    outage_from: entries.length === 0 ? null : entries[0]!.last_run_at,
    outage_to: now,
    entries,
  };
}
