/** D-266 — what happens to a schedule that did not run.
 *
 *  A schedule the machine was asleep for is a decision nobody makes
 *  today: the scheduler silently picks catch-up or skip and the owner
 *  learns neither. This is the owner's call, declared on the schedule
 *  when it is written.
 *
 *  Lives in contracts (not `@recued/scheduler`) for the same reason
 *  `cron-presets.ts` does — the vocabulary and its copy are needed by
 *  every SURFACE that offers the choice, while `@recued/scheduler` is
 *  engine code the D-148 P12 role boundary bans from clients.
 */

/** The four policies, in the order they are offered. */
export const MISSED_SCHEDULE_POLICIES = [
  'catch_up',
  'skip',
  'auto',
  'ask',
] as const;

export type MissedSchedulePolicy = (typeof MISSED_SCHEDULE_POLICIES)[number];

/** Absent `missed_policy` ⇒ `'auto'`. Every schedule written before
 *  D-266 keeps the behaviour it already had, so this is a widening,
 *  not a migration. */
export const DEFAULT_MISSED_SCHEDULE_POLICY: MissedSchedulePolicy = 'auto';

export const isMissedSchedulePolicy = (
  value: unknown,
): value is MissedSchedulePolicy =>
  typeof value === 'string'
  && (MISSED_SCHEDULE_POLICIES as readonly string[]).includes(value);

/** Owner-facing copy. `fits` is the example that makes the option
 *  concrete — the picker shows it, because "always fire" and "always
 *  skip" only read as different once you have a recipe in mind.
 *
 *  ⚠ `auto` is NOT labelled "adaptive". It adapts to CADENCE (is the
 *  next regular cycle imminent?) and, since D-266, to STALENESS (how
 *  many full cycles went by?) — but it is still a rule, not a
 *  judgement, and calling it adaptive oversells it. */
export const MISSED_SCHEDULE_POLICY_COPY: Record<
  MissedSchedulePolicy,
  { label: string; description: string; fits: string }
> = {
  catch_up: {
    label: "Catch up when I'm back",
    description: 'Always run it, however late.',
    fits: 'news aggregation — a backlog is still readable',
  },
  skip: {
    label: 'Skip it',
    description: 'Never run late, and say so.',
    fits: '"leave for the train at 08:40" — late is worse than never',
  },
  auto: {
    label: 'Decide for me',
    description:
      'Run it when the next regular cycle is still far off and only the '
      + 'one cycle was missed; skip it once it is properly stale.',
    fits: 'the default',
  },
  ask: {
    label: 'Ask me',
    description:
      'Raise it when I am back and decide nothing. One card per wake, '
      + 'never one per missed cycle.',
    fits: 'anything that sends or spends',
  },
};
