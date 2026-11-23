/** D-339 slice 14 (D-339 §6) — which of a Body's readings have probably changed since they
 *  were measured. The owner (2026-11-18): *"weight changes x kg over y days but other numbers hasn't
 *  updated can possibly be staled? body fat too"*.
 *
 *  - A body measure (body fat, lean body mass, muscle mass, waist) goes with the weight on the day it was
 *    measured. When the latest weight, weighed after it, has moved from that day's by at least the
 *    Body's `stale_weight_change_kg`, it has probably changed. Otherwise it is stale past
 *    `stale_after_days`: a weight can hold while fat goes down and muscle up.
 *  - Weight has no partner: it is stale past `stale_weight_days`.
 *  - Height does not change for an adult. For someone under 18 (by the Body's birth date) it is stale
 *    past `stale_height_days`.
 *  - Anything worked out from these (BMI, an age) is as fresh as its inputs, so it is never listed.
 *
 *  Each window and threshold is the Body's setting, bounded as the page bounds it; a value it cannot read
 *  is the default. A history that cannot be read leaves out only the weight rule. */
import { BODY_MEASURE_FIELDS, assetDateAt, type Asset, type AssetReading, type YoursReadingStale } from '@recued/contracts';

const DAY_MS = 86_400_000;

/** Each setting: its default, and the bounds it is kept within. */
export const STALE_SETTINGS = {
  stale_weight_change_kg: { fallback: 2, min: 0.5, max: 20 },
  stale_after_days: { fallback: 90, min: 14, max: 365 },
  stale_weight_days: { fallback: 30, min: 7, max: 365 },
  stale_height_days: { fallback: 180, min: 30, max: 730 },
} as const;

const setting = (settings: Record<string, unknown>, name: keyof typeof STALE_SETTINGS): number => {
  const { fallback, min, max } = STALE_SETTINGS[name];
  const raw = settings[name];
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : fallback;
};

const dayNumber = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;
/** A weight in kg, or undefined in a unit this does not read. */
const kilograms = (reading: { value: number; unit: string }): number | undefined =>
  reading.unit === 'kg' ? reading.value : reading.unit === 'lb' ? reading.value * 0.45359237 : undefined;
/** The day a reading is for: the Body signals day its writer cites, else the owner's day of `as_of`.
 *  Slice 15's goals read it too (`body-goals.ts`). */
export const readingDay = (reading: AssetReading, timeZone: string): string => {
  const cited = reading.evidence.find(entry => entry.field === 'day')?.value;
  return typeof cited === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(cited) ? cited : assetDateAt(reading.as_of, timeZone);
};
/** Full years from a birth date to a day. */
const yearsOld = (birth: string, day: string): number | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(birth) || birth > day) return undefined;
  return Number(day.slice(0, 4)) - Number(birth.slice(0, 4)) - (day.slice(5) < birth.slice(5) ? 1 : 0);
};

export const assetReadingStaleness = (
  asset: Pick<Asset, 'readings' | 'dates' | 'settings'>,
  /** A reading's samples since a moment, each with the day it is for when it has one (`readingDays`). */
  history: (field: string, limit: number, since: number) => ReadonlyArray<AssetReading & { day?: string }>,
  now: number,
  timeZone: string,
): YoursReadingStale[] => {
  const settings = asset.settings ?? {};
  const today = assetDateAt(now, timeZone);
  const age = (reading: AssetReading) => { const day = readingDay(reading, timeZone); return { day, days_old: dayNumber(today) - dayNumber(day) }; };
  const out: YoursReadingStale[] = [];
  const weight = asset.readings.weight ?? null;

  if (weight) {
    const at = age(weight);
    if (at.days_old > setting(settings, 'stale_weight_days')) out.push({ field: 'weight', reason: 'too_old', ...at });
  }
  const threshold = setting(settings, 'stale_weight_change_kg');
  const backstop = setting(settings, 'stale_after_days');
  for (const field of BODY_MEASURE_FIELDS) {
    const reading = asset.readings[field] ?? null;
    if (!reading) continue;
    const at = age(reading);
    // The weight on its day: the newest sample on or before it, from the fortnight before.
    const weightDay = weight ? readingDay(weight, timeZone) : undefined;
    let then: (AssetReading & { day?: string }) | undefined;
    if (weight && weightDay !== undefined && weightDay > at.day) {
      try {
        const since = (dayNumber(at.day) - 14) * DAY_MS;
        then = history('weight', 60, since).filter(sample => (sample.day ?? assetDateAt(sample.as_of, timeZone)) <= at.day)
          .sort((a, b) => (b.day ?? assetDateAt(b.as_of, timeZone)).localeCompare(a.day ?? assetDateAt(a.as_of, timeZone)))[0];
      } catch { then = undefined; }
    }
    const before = then ? kilograms(then) : undefined;
    const latest = weight ? kilograms(weight) : undefined;
    if (then && weight && before !== undefined && latest !== undefined && Math.abs(latest - before) >= threshold) {
      out.push({ field, reason: 'weight_moved', ...at, weight_then: { value: then.value, unit: then.unit }, weight_now: { value: weight.value, unit: weight.unit } });
    } else if (at.days_old > backstop) out.push({ field, reason: 'too_old', ...at });
  }
  const height = asset.readings.height ?? null;
  const birth = typeof asset.dates?.birth_date === 'string' ? asset.dates.birth_date : '';
  const years = birth ? yearsOld(birth, today) : undefined;
  if (height && years !== undefined && years < 18) {
    const at = age(height);
    if (at.days_old > setting(settings, 'stale_height_days')) out.push({ field: 'height', reason: 'growing', ...at });
  }
  return out;
};
