/** D-339 slice 15 (D-339 §6; D-342 §17) — a body goal's progress, worked out from its
 *  Body when read, never stored on the pursuit.
 *
 *  - **Now and to go:** the Body's latest reading, in the goal's unit, and what is left (0 once at or
 *    past the target).
 *  - **Looks reached:** the average of the last 7 days, from the Body's own lenses (slice 9: 4 days
 *    of the 7 at least), at or past the target. One day's weighing swings by a kilogram; a week's
 *    average does not.
 *  - **Pace:** the trend over the lens's days (14 at least), signed the goal's way, and the weeks it
 *    leaves when it is toward the target.
 *  - A Body that is gone, a reading with none, or one in another unit than the goal's, says so
 *    (`problem`) instead: a goal in kg is never read against pounds. */
import { assetDateAt, bodyGoalWay, shiftAssetDate, type Asset, type AssetReading, type BodyGoal, type BodyGoalProgress,
  type SituationGoalDetails } from '@recued/contracts';
import { assetReadingTrends } from './asset-reading-trends.js';
import { readingDay } from './asset-reading-staleness.js';
import { readingWords } from './values-on-request.js';

/** Past two years, "about N weeks at this pace" says nothing a person can use. */
export const BODY_GOAL_WEEKS_SHOWN = 104;

export type BodyReadingHistory = (field: string, limit: number, since: number) => ReadonlyArray<AssetReading & { day?: string }>;

const hundredths = (value: number): number => Math.round(value * 100) / 100;

export const bodyGoalProgress = (
  pursuit: Pick<Asset, 'id' | 'name' | 'dates'>,
  goal: BodyGoal,
  body: Pick<Asset, 'readings' | 'settings' | 'status'> & { deleted_at?: number | null } | null,
  /** The Body's samples of a reading since a moment, each on the day it is for (`readingDays`). */
  history: BodyReadingHistory,
  now: number,
  timeZone: string,
): BodyGoalProgress => {
  const way = bodyGoalWay(goal);
  const targetOn = pursuit.dates.target_on;
  const base: BodyGoalProgress = { pursuit_id: pursuit.id, name: pursuit.name, ...(typeof targetOn === 'string' ? { target_on: targetOn } : {}),
    goal, way, reached: false };
  if (!body || body.deleted_at != null || !['active', 'lent'].includes(body.status)) return { ...base, problem: 'body_gone' };
  const reading = body.readings[goal.reading] ?? null;
  if (!reading || !Number.isFinite(reading.value)) return { ...base, problem: 'no_value' };
  if (reading.unit !== goal.unit) return { ...base, problem: 'other_unit' };
  const left = way === 'down' ? reading.value - goal.target : goal.target - reading.value;
  const progress: BodyGoalProgress = { ...base, now: { value: reading.value, day: readingDay(reading, timeZone) }, to_go: hundredths(Math.max(0, left)) };
  // The Body's own lenses over its days, for this reading alone, as its page draws them.
  const [trend] = assetReadingTrends({ readings: { [goal.reading]: reading }, settings: body.settings }, history, now, timeZone);
  const average = trend?.averages?.find(row => row.days === 7);
  if (trend && average) {
    const today = assetDateAt(now, timeZone); const first = shiftAssetDate(today, { amount: 6, unit: 'days' }, -1);
    const days = trend.points.filter(point => point.day !== undefined && point.day >= first && point.day <= today).length;
    progress.week = { value: hundredths(average.value), days };
    progress.reached = way === 'down' ? average.value <= goal.target : average.value >= goal.target;
  }
  if (trend?.trend && trend.trend.direction !== 'steady') {
    const toward = way === 'down' ? -trend.trend.per_week : trend.trend.per_week;
    progress.per_week = hundredths(toward);
    if (toward > 0 && left > 0 && left / toward <= BODY_GOAL_WEEKS_SHOWN) progress.weeks_left = Math.round((left / toward) * 10) / 10;
  }
  return progress;
};

/** A goal as a model reads it, with where the Body is now when the read worked it out. */
export const situationGoalDetails = (goal: BodyGoal, progress?: BodyGoalProgress): SituationGoalDetails => ({
  reading: readingWords(goal.reading),
  target: { value: goal.target, unit: goal.unit },
  start: { value: goal.start, day: goal.start_day },
  ...(progress?.now ? { now: progress.now } : {}),
  ...(progress?.to_go !== undefined ? { to_go: progress.to_go } : {}),
  ...(progress?.per_week !== undefined ? { per_week: progress.per_week } : {}),
  ...(progress?.weeks_left !== undefined ? { weeks_left: progress.weeks_left } : {}),
  ...(progress?.reached ? { looks_reached: true as const } : {}),
});
