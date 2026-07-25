/** Smart Backfill — Phase 5 (revised: time-based catch-up, system-wide window).
 *
 *  No per-cycle missed_due records anywhere. The cloud doesn't track
 *  misses at all. The server's local scheduler runs one check per
 *  enabled schedule per tick: if at least one cron-matched cycle
 *  passed since the last fire AND the wait until the next regular
 *  cycle is longer than `BACKFILL_WINDOW_MIN`, fire one catch-up
 *  now.
 *
 *  Backfill behaviour is system-wide, not a per-recipe knob — recipe
 *  schemas describe WHAT a recipe does, not HOW the system runs it.
 *  If a destructive-side-effect recipe ever needs to opt out of
 *  catch-up, the right signal is `risk_tier: destructive` on the
 *  ingredient (already meaningful for the marketplace gate); the
 *  scheduler can derive "skip catch-up" from that without a new
 *  author-controlled field.
 *
 *  Diagnostic count is reconstructed from the observed cadence
 *  between the two most recent runs (`prev_run_at` → `last_run_at`)
 *  rather than parsed from the cron expression. Self-corrects on
 *  cron edits, returns `'unknown'` only for the first catch-up
 *  after schedule creation. */

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

/** Reconstruct the missed-cycle count from the schedule's observed
 *  cadence. Uses `(now - last_run_at) / (last_run_at - prev_run_at)`
 *  — exact for any regular interval cron, an estimate for irregular
 *  ones (alternation / weekday filters), `'unknown'` when there's
 *  no `prev_run_at` to sample from yet.
 *
 *  Subtracts 1 because the catch-up fire we're about to dispatch
 *  consumes one of the cycles in the gap. */
export function countMissedCycles(
  schedule: Pick<Schedule, 'last_run_at' | 'prev_run_at'>,
  now: number,
): number | 'unknown' {
  const last = schedule.last_run_at;
  const prev = schedule.prev_run_at ?? null;
  if (last === null || prev === null) return 'unknown';
  const intervalMs = last - prev;
  if (intervalMs <= 0) return 'unknown';
  const gapMs = now - last;
  return Math.max(0, Math.floor(gapMs / intervalMs) - 1);
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
  schedule: Pick<Schedule, 'last_run_at' | 'prev_run_at'>,
  now: number,
): BackfillMetadata {
  return {
    missed_cycles: countMissedCycles(schedule, now),
    last_run_at_before: schedule.last_run_at!,
  };
}
