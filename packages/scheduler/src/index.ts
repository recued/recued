export type { Schedule, ScheduleStore } from './types.js';
export { CRON_PRESETS, describeCron, buildCronFromInterval } from './types.js';
export {
  MISSED_SCHEDULE_POLICIES,
  DEFAULT_MISSED_SCHEDULE_POLICY,
  MISSED_SCHEDULE_POLICY_COPY,
  isMissedSchedulePolicy,
  type MissedSchedulePolicy,
} from './types.js';
export { createInMemoryScheduleStore } from './store.js';
export { createIDBScheduleStore, type ScheduleCollection } from './idb-store.js';
export { MIN_CRON_INTERVAL_MS, cronIntervalMs, validateCronInterval, nextCronMatch, cronMatchesAt, formatNextFire } from './cron-interval.js';
export {
  BACKFILL_WINDOW_MIN,
  shouldCatchUp,
  countMissedCycles,
  buildBackfillMetadata,
  type ScheduleForCatchUp,
  type BackfillMetadata,
  // D-266 — owner-declared missed-schedule policy.
  countOutstandingOccurrences,
  DISPLAY_OCCURRENCE_LIMIT,
  AUDIT_OCCURRENCE_LIMIT,
  resolveMissedAction,
  buildMissedRunReport,
  type MissedAction,
  type ScheduleForMissedAction,
  type MissedRunEntry,
  type MissedRunReport,
} from './backfill.js';

// D-115 Phase 2 — auto-run scheduler core.
export {
  autoRunKey,
  createAutoRunScheduler,
  rosterAllAutoRun,
  type AutoRunEntry,
  type AutoRunOutcome,
  type AutoRunScheduler,
  type AutoRunSchedulerOptions,
  type AutoRunInstallInput,
  type RosterBuildInput,
  type TickReport,
  // D-115 Phase 8 — circuit-breaker trip notification.
  type CircuitTripEvent,
} from './auto-run.js';

// D-116 Phase 7 — auto-disabled roster→summary projection. Consumed
// by extension (banner + options section) AND server (CLI status +
// /status HTML mirror). Renderers live next to each surface.
export {
  summarizeAutoDisabled,
  type AutoDisabledSummary,
  type AutoRunEntryLike,
  type SummarizeInput,
} from './auto-disabled.js';
