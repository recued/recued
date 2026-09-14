/** Schedule types for client-side recipe scheduling.
 *
 *  Schedules persist in IDB so they survive service worker restarts.
 *  Chrome alarms fire the execution; the schedule store tracks state.
 */

import type { MissedSchedulePolicy } from '@recued/contracts';

export interface Schedule {
  schedule_id: string;
  recipe_id: string;
  publisher_id: string;
  /** Absent means legacy recurring cron schedule. */
  mode?: 'recurring' | 'one_shot';
  /** 5-field cron: "minute hour dom month dow". */
  cron_expression: string;
  /** D-269 — the IANA zone the expression is read in.
   *  ⛔ Absent means THE SERVER'S DECLARED ZONE, resolved at evaluation time —
   *  not UTC, and not the host. Pre-D-269 rows all lack it. */
  time_zone?: string;
  /** One-shot schedules fire once at this absolute Unix-ms timestamp. */
  run_at?: number;
  enabled: boolean;
  created_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
  /** Timestamp of the run BEFORE `last_run_at` (epoch ms) — a strict
   *  ONE-DEEP UNDO LOG of `last_run_at`, rolled by `updateRun` whenever
   *  that field changes to a new value.
   *
   *  ⛔ NOT A CADENCE SOURCE, WHICH IS WHAT IT WAS BUILT FOR AND WHY IT
   *  NEARLY GOT DELETED. `countMissedCycles` used to divide by
   *  `last_run_at - prev_run_at`; that measure was replaced because this
   *  pair SPANS AN OUTAGE — nothing ran in between — so it mis-measured
   *  the one case that mattered. Nothing reads it now.
   *
   *  🔑 "NOTHING READS IT" IS NOT "IT HAS NO PURPOSE". It is the only
   *  on-row record of where `last_run_at` was, and `last_run_at` is the
   *  single field EVERY scheduling decision reads: the catch-up test,
   *  the occurrence count, the per-minute dedupe guard, and the
   *  missed-answer expiry all measure forward from it. A `last_run_at`
   *  corrupted FAR FORWARD — a clock jump, a bad restore, a write that
   *  claims a run which never happened — kills a schedule SILENTLY:
   *  nothing fires until the cron naturally matches again, and nothing
   *  else on the row says what the value should have been. The audit log
   *  is not the fallback either; it evicts oldest-first.
   *
   *  ⚠ THIS SESSION SUPPLIED THE NEAR-MISS. The D-266 skip path was one
   *  review away from stamping `last_run_at` for a run that never
   *  happened; had it shipped, this field held the truth.
   *
   *  ⚠ It is insurance nobody can currently CLAIM: absent from
   *  `ServerSchedule`, so no client sees it, and no rpc reads it back.
   *  If it is ever wanted for recovery in earnest it needs a surface —
   *  keeping it costs one number per row, so the bar for that is low. */
  prev_run_at?: number | null;
  /** D-266 — what the owner wants done about a cycle this schedule
   *  missed while the machine was off. Absent ⇒
   *  `DEFAULT_MISSED_SCHEDULE_POLICY` (`'auto'`), which is the
   *  behaviour every pre-D-266 schedule already had. */
  missed_policy?: MissedSchedulePolicy;
  /** D-266 — what the owner answered about the outage outstanding at
   *  `at` (`schedules.answerMissed`). Outranks `missed_policy` for that
   *  one occurrence: `'run'` fires one catch-up, `'skip'` settles it.
   *
   *  ⛔ ONE FIELD CARRYING THE VERDICT, NOT A TIMESTAMP PER OUTCOME.
   *  Two timestamps (`granted_at` / `skipped_at`) could BOTH be live at
   *  once, and then the ORDER the checks happen to be written in would
   *  silently decide which the owner gets. One field makes that state
   *  unrepresentable.
   *
   *  ⚠ It does NOT make "the later answer wins" true, and that claim
   *  stood here until an audit drove it. A second answer never reaches
   *  this field: `answerMissed` re-derives what is outstanding, and a
   *  schedule already carrying an answer is no longer outstanding, so
   *  the call is a no-op. Which is right — by then the ask is closed and
   *  the card is gone, so there is no surface to answer twice from — but
   *  it is a different property than the one the comment asserted.
   *
   *  ⛔⛔ AND `'skip'` HAS TO BE RECORDED AT ALL, WHICH IS NOT OBVIOUS.
   *  Skipping changes nothing else about the row on purpose — stamping
   *  `last_run_at` would claim a run that never happened — so
   *  without this the miss stays outstanding, the answered ask is
   *  cancelled, and the NEXT TICK RAISES THE SAME QUESTION. An endless
   *  prompt is exactly what makes `Ask me` the first option an owner
   *  turns off, which is the failure the whole design is arranged
   *  around.
   *
   *  🔑 SELF-EXPIRING, SO THERE IS NO SECOND TABLE AND NO CLEANUP: any
   *  later run — the catch-up it authorised, or simply the next regular
   *  cycle — moves `last_run_at` past `at`, and the same comparison
   *  that made the answer live (`at > last_run_at`) makes it spent. */
  missed_answer?: { at: number; answer: 'run' | 'skip' };
  /** Status of the most recent run. */
  last_status: 'success' | 'error' | 'skipped' | null;
  last_error: string | null;
  /** D-268 — failures since the last success. `0` / absent ⇒ the last run
   *  succeeded, or this schedule predates D-268.
   *
   *  ⛔ THE CRON PATH HAD NO BREAKER AT ALL, WHICH IS WHY THIS IS NEW HERE AND
   *  NOT ON `AutoRunEntry`. `CIRCUIT_BREAKER_THRESHOLD` has exactly one consumer
   *  (`packages/scheduler/src/auto-run.ts`), so a daily schedule that failed
   *  every day recorded `last_error` and fired again tomorrow, forever.
   *
   *  ⚠ OPTIONAL, AND THAT IS THE COMPAT DECISION. A self-hosted fleet has no
   *  deploy order: an older reader of a newer row must ACCEPT-AND-IGNORE rather
   *  than reject, and an older WRITER simply omits it, which reads back as `0` —
   *  "no failures since the last success" — the one default that cannot disarm
   *  anything by accident.
   *
   *  🔑 It is the EPISODE as well as the counter: `0 → 1` opens an episode (and
   *  sends the one notice), any reset to `0` closes it. A second field for the
   *  episode would be a second place the same fact lives. */
  consecutive_failures?: number;
  /** Instance that owns this schedule. Only this instance executes it.
   *  Other instances skip the schedule during their tick. When absent,
   *  any instance may execute (backward compat). */
  instance_id?: string;
  /** D-179 P2 — standing dish this schedule dispatches as. The dish's
   *  `config_overlay` resolves inside `handleExecute`; a disabled dish
   *  SKIPS the fire silently (attachment stays armed). Absent ⇒
   *  dishless run (ephemeral attribution). */
  dish_id?: string;
}

export interface ScheduleStore {
  list(): Promise<Schedule[]>;
  get(schedule_id: string): Promise<Schedule | null>;
  getByRecipe(recipe_id: string, publisher_id: string): Promise<Schedule | null>;
  set(schedule: Schedule): Promise<void>;
  delete(schedule_id: string): Promise<void>;
}

// Reactive-substrate slice 1 — CRON_PRESETS / buildCronFromInterval /
// describeCron moved to `@recued/contracts` (cron-presets.ts): they're
// pure display-layer pieces client surfaces need, and the D-148 P12
// role boundary bans `@recued/scheduler` (engine code) from clients.
// Re-exported here so existing engine-side consumers keep their import.
export {
  CRON_PRESETS,
  buildCronFromInterval,
  describeCron,
  MISSED_SCHEDULE_POLICIES,
  DEFAULT_MISSED_SCHEDULE_POLICY,
  MISSED_SCHEDULE_POLICY_COPY,
  isMissedSchedulePolicy,
  type MissedSchedulePolicy,
} from '@recued/contracts';
