/** Schedule types for client-side recipe scheduling.
 *
 *  Schedules persist in IDB so they survive service worker restarts.
 *  Chrome alarms fire the execution; the schedule store tracks state.
 */

export interface Schedule {
  schedule_id: string;
  recipe_id: string;
  publisher_id: string;
  /** Absent means legacy recurring cron schedule. */
  mode?: 'recurring' | 'one_shot';
  /** 5-field cron: "minute hour dom month dow". */
  cron_expression: string;
  /** One-shot schedules fire once at this absolute Unix-ms timestamp. */
  run_at?: number;
  enabled: boolean;
  created_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
  /** Phase 5 — Smart Backfill substrate. Timestamp of the run BEFORE
   *  `last_run_at` (epoch ms). Used to compute the observed cadence
   *  for `countMissedCycles` without parsing the cron expression.
   *  Null on schedules that have fired zero or one times — first
   *  catch-up after creation reports `missed_cycles: 'unknown'`. */
  prev_run_at?: number | null;
  /** Status of the most recent run. */
  last_status: 'success' | 'error' | 'skipped' | null;
  last_error: string | null;
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
} from '@recued/contracts';
