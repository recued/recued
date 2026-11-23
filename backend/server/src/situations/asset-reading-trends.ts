/** D-339 slices 7b, 9 and 10 (2026-11-17) — each reading's recent days, for the open asset's page.
 *
 *  The page draws them as a sparkline beside the reading, and writes what they say as text
 *  (`YoursReadingTrend`). The owner's fence (ruling 10): a sparkline only, never axes, hover or zoom.
 *
 *  - **A point a day.** The day's last value, the day in the owner's zone. A source that writes every
 *    few minutes still draws one point a day, and the page receives no more.
 *  - **Whose days** (slice 10). A Body reading's are its days in Records, each on the day it is for
 *    (`asset-reading-days.ts`), whenever it arrived. Any other reading's are its history: the days
 *    it was written on.
 *  - **Only the reading's current unit.** A sample in another unit is left out, never converted.
 *  - **Three lenses** (slice 9). The owner: *"trend give you the health recovery, current give you
 *    the instant body status, peroid-average baseline is more for habit/weight control"*.
 *    - **Usual,** what the latest is read against: what the `baseline` transform calls it, the median
 *      and the median absolute deviation of the days before the latest. Its days are the asset's
 *      `baseline_days` and its fewest days `min_days`, as the Body's states take them. With the
 *      Body's Records days, the range the page writes is the one they judge against.
 *    - **Trend,** which way the line goes: the `trend` transform over the days the line draws
 *      (`trend_days`), with at least `READING_TREND_MIN_DAYS` of them.
 *    - **Average,** for habits: the mean of the last 7 and the last 30 days, each against the period
 *      before it, with at least half of a period's days.
 *  - **The settings** are the asset's own, as the Body has them; any other asset gets the defaults.
 *    Each is a whole number of days inside its bounds, read as the Body's summary recipe reads it. */
import { assetDateAt, type Asset, type AssetReading, type YoursReadingTrend } from '@recued/contracts';
import { baseline, trend, type TransformContext } from '@recued/transforms';

/** The windows an asset's settings may set, what each is when unset, and its bounds. The Body's
 *  summary bounds `baseline_days` and `min_days` the same way (`d-339-body-lenses.test.ts` pins it). */
export const READING_WINDOWS = {
  /** The days a usual comes from. At most 30: a state cites each row it compared, and recovery low
   *  both measures' rows, which must stay inside the store's 100 entries of evidence. */
  usual: { setting: 'baseline_days', fallback: 14, min: 7, max: 30 },
  /** The fewest of those days that make a usual: never more than the usual's days. */
  usual_min: { setting: 'min_days', fallback: 7, min: 1 },
  /** The days the line draws and its trend covers. */
  trend: { setting: 'trend_days', fallback: 30, min: 14, max: 90 },
} as const;
/** The fewest days in the line that make a trend: two weeks. */
export const READING_TREND_MIN_DAYS = 14;
/** The periods an average covers, each against the one before it. */
export const READING_AVERAGE_DAYS = [7, 30] as const;
/** The most history rows read for one reading: the store's own bound on a read. The read is newest
 *  first, so a source writing every few minutes loses its oldest days to it, never its newest. */
export const ASSET_READING_TREND_ROWS = 10_000;

const DAY_MS = 86_400_000;

/** A setting as a whole number of days inside its bounds, read as the summary recipe reads it
 *  (`default`, `round`, `default`, `clamp`): no value, or one that is not a number, is the fallback. */
export const readingWindowDays = (value: unknown, window: { fallback: number; min: number; max: number }): number => {
  if (value === null || value === undefined || value === '') return window.fallback;
  const number = Number(value);
  return Math.min(Math.max(Number.isNaN(number) ? window.fallback : Math.round(number), window.min), window.max);
};

const dayNumber = (day: string): number =>
  Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;
const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

export const assetReadingTrends = (
  asset: Pick<Asset, 'readings'> & { settings?: Asset['settings'] },
  /** Each sample's day is its own `day` when it has one (a Records day), else the day of its `as_of`. */
  history: (field: string, limit: number, since: number) => ReadonlyArray<AssetReading & { day?: string }>,
  now: number,
  timeZone: string,
): YoursReadingTrend[] => {
  const settings = asset.settings ?? {};
  const usualDays = readingWindowDays(settings[READING_WINDOWS.usual.setting], READING_WINDOWS.usual);
  const minDays = readingWindowDays(settings[READING_WINDOWS.usual_min.setting], { ...READING_WINDOWS.usual_min, max: usualDays });
  const trendDays = readingWindowDays(settings[READING_WINDOWS.trend.setting], READING_WINDOWS.trend);
  const month = Math.max(...READING_AVERAGE_DAYS);
  // A day's age in the owner's days, today 0. The read reaches the oldest day a lens needs: the
  // usual's days and the latest, the line's days, and two of the longest average.
  const reach = Math.max(usualDays + 1, trendDays, 2 * month);
  const since = now - (reach + 1) * DAY_MS;
  const today = dayNumber(assetDateAt(now, timeZone));
  // The transforms are arithmetic over the rows they are given: they read nothing from a run.
  const context: TransformContext = { resolve: () => undefined, evaluate: () => false, now: () => new Date(now) };
  const trends: YoursReadingTrend[] = [];
  for (const [field, current] of Object.entries(asset.readings)) {
    if (!current || !Number.isFinite(current.value)) continue;
    const byAge = new Map<number, { at: number; value: number; day: string }>();
    for (const sample of history(field, ASSET_READING_TREND_ROWS, since)) {
      if (!Number.isFinite(sample.value) || !Number.isFinite(sample.as_of)) continue;
      if (sample.as_of > now || sample.unit !== current.unit) continue;
      const day = sample.day ?? assetDateAt(sample.as_of, timeZone);
      const age = today - dayNumber(day);
      if (age < 0 || age >= reach) continue;
      const kept = byAge.get(age);
      // Each point carries the day it was counted on, for a page that labels days (D-339 slice 11).
      if (!kept || sample.as_of > kept.at) byAge.set(age, { at: sample.as_of, value: sample.value, day });
    }
    /** The days `from` to `from + days - 1` ago that have a point, oldest first. */
    const days = (count: number, from = 0) => [...byAge.entries()]
      .filter(([age]) => age >= from && age < from + count).sort(([a], [b]) => b - a);
    const line = days(trendDays);
    if (line.length < 2) continue;
    const points = line.map(([, point]) => point);

    const usual = baseline({ rows: days(usualDays + 1).map(([, point]) => point), time_field: 'at', value_field: 'value', now,
      window_ms: (usualDays + 2) * DAY_MS, min_count: minDays }, context) as { status?: string; median?: number | null; mad?: number | null };
    const usualKnown = usual.status === 'known' && Number.isFinite(usual.median) && Number.isFinite(usual.mad);

    const way = trend({ rows: points, time_field: 'at', value_field: 'value', now,
      window_ms: (trendDays + 1) * DAY_MS, min_count: READING_TREND_MIN_DAYS }, context) as {
      status?: string; direction?: 'rising' | 'falling' | 'steady' | null; slope?: number | null };
    const wayKnown = way.status === 'known' && !!way.direction && Number.isFinite(way.slope);

    const averages: NonNullable<YoursReadingTrend['averages']> = [];
    for (const count of READING_AVERAGE_DAYS) {
      const enough = Math.ceil(count / 2);
      const period = days(count).map(([, point]) => point.value);
      if (period.length < enough) continue;
      const before = days(count, count).map(([, point]) => point.value);
      averages.push({ days: count, value: mean(period), ...(before.length >= enough ? { previous: mean(before) } : {}) });
    }

    trends.push({ field, unit: current.unit, days: trendDays, points,
      ...(usualKnown ? { usual: { median: usual.median!, low: usual.median! - usual.mad!, high: usual.median! + usual.mad!, days: usualDays } } : {}),
      // The days the line's points span, today included: fewer than its window while history is short.
      ...(wayKnown ? { trend: { direction: way.direction!, per_week: way.slope! * 7, days: line[0]![0] + 1 } } : {}),
      ...(averages.length ? { averages } : {}) });
  }
  return trends;
};
