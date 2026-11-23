/** D-339 slice 7a (2026-11-17) — a reading as an asset's page words it: its name ("Sleep"), its
 *  value ("7 h 05"), and, when its writer cites them, its source and the day it describes
 *  ("Oura · last night"). The page's own day is the browser's, as for every date the page shows. */
import { isAssetDate, type AssetEvidence } from '@recued/contracts';

/** The Body's readings and states (`community/packs/body-signals.json`) in the owner's words: a
 *  reading as the Body signals guide names it (`recued-docs/content/guides/body-signals.md`), a
 *  state as its rule's title, which Today shows. Two kinds of heart rate variability never share a
 *  name (D-339 §3.3). Any other field is its key with spaces. */
const FIELD_NAMES: Readonly<Record<string, string>> = {
  sleep_minutes: 'Sleep', hrv_rmssd: 'Heart rate variability (RMSSD)', hrv_sdnn: 'Heart rate variability (SDNN)',
  respiratory_rate: 'Breathing rate', spo2: 'Blood oxygen', skin_temp_deviation: 'Skin temperature change',
  vo2_max: 'VO₂ max', hrv_below_usual: 'HRV below usual', resting_hr_above_usual: 'Resting heart rate above usual',
  // D-339 slice 14 — the rest of what Apple Health sends; any other is its key with spaces.
  blood_pressure_systolic: 'Blood pressure (systolic)', blood_pressure_diastolic: 'Blood pressure (diastolic)',
  blood_glucose: 'Blood sugar', exercise_minutes: 'Exercise',
};

/** A reading's or condition's name, as a title: "Sleep", "Battery". */
export const assetFieldName = (field: string): string => {
  if (Object.hasOwn(FIELD_NAMES, field)) return FIELD_NAMES[field]!;
  const text = field.replaceAll('_', ' ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
};

/** A name inside a sentence: lower-cased, except a first word that is an abbreviation ("HRV", "VO₂"). */
export const nameInSentence = (name: string): string =>
  /\p{Lu}/u.test(name.split(' ')[0]!.slice(1)) ? name : name.charAt(0).toLowerCase() + name.slice(1);

const MINUTES = new Set(['min', 'minutes']);
/** A duration of an hour or more, as hours and minutes the way a watch shows sleep: 425 → "7 h 05". */
const hoursAndMinutes = (minutes: number): string | undefined => {
  const total = Math.round(minutes);
  return Number.isFinite(minutes) && total >= 60 ? `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')}` : undefined;
};

/** A reading's value: minutes as hours and minutes ("7 h 05"), anything else as its number and unit. */
export const readingValueWords = (value: number, unit: string, number: (value: number) => string = String): string =>
  (MINUTES.has(unit) ? hoursAndMinutes(value) : undefined) ?? `${number(value)} ${unit}`;

/** Two values of one reading joined by `between`: "6 h 53–7 h 18", or "40–52 ms". */
export const readingSpanWords = (low: number, high: number, unit: string, between: string,
  number: (value: number) => string = String): string => {
  const from = MINUTES.has(unit) ? hoursAndMinutes(low) : undefined;
  const to = MINUTES.has(unit) ? hoursAndMinutes(high) : undefined;
  return from && to ? `${from}${between}${to}` : `${number(low)}${between}${number(high)} ${unit}`;
};

/** D-339 slice 9 — a lens's number in a reading's words. Minutes are whole ("9 min", "1 h 05"), as a
 *  watch shows sleep; any other unit keeps one decimal below 100 ("41.3 ms"), none from 100 ("9120
 *  steps"), and two figures below 1 ("0.04 kg"), so a small change is never written as 0. */
const lensWords = (value: number, unit: string): string => MINUTES.has(unit)
  ? readingValueWords(Math.round(value), unit)
  : readingValueWords(value, unit, number => Math.abs(number) >= 100 ? String(Math.round(number))
    : Math.abs(number) < 1 && number !== 0 ? String(Number(number.toPrecision(2)))
      : number.toFixed(1).replace(/\.0$/u, ''));

/** Which way a reading's line goes: "Rising, about 9 min a week · last 30 days", or "Steady · last 30
 *  days". The days are those its points span, which is fewer than the line's while history is short. */
export const readingTrendWords = (trend: { direction: 'rising' | 'falling' | 'steady'; per_week: number; days: number },
  unit: string): string => trend.direction === 'steady' ? `Steady · last ${trend.days} days`
  : `${trend.direction === 'rising' ? 'Rising' : 'Falling'}, about ${lensWords(Math.abs(trend.per_week), unit)} a week · last ${trend.days} days`;

/** A period's average against the one before it: "7 h 02 over the last 7 days, 14 min more than the 7
 *  days before". Two averages that read the same are "the same"; without the period before, only the
 *  average. */
export const readingAverageWords = (average: { days: number; value: number; previous?: number }, unit: string): string => {
  const words = `${lensWords(average.value, unit)} over the last ${average.days} days`;
  if (average.previous === undefined) return words;
  if (lensWords(average.value, unit) === lensWords(average.previous, unit)) return `${words}, the same as the ${average.days} days before`;
  const change = average.value - average.previous;
  return `${words}, ${lensWords(Math.abs(change), unit)} ${change > 0 ? 'more' : 'less'} than the ${average.days} days before`;
};

/** D-339 §3.3 — the readings that describe the night ending on the morning of their row's day. Each
 *  is measured asleep by every source the Body takes. The others are worded as their day, which is
 *  true for any of them: resting heart rate and blood oxygen are a ring's night but Apple Health's
 *  whole day. */
const NIGHT_READINGS = new Set(['sleep_minutes', 'hrv_rmssd', 'respiratory_rate', 'skin_temp_deviation']);

const DAY_MS = 86_400_000;
const pad = (value: number): string => String(value).padStart(2, '0');
const localDay = (at: Date): string => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const dayIndex = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;
const dateWords = (day: string, today: string): string => new Date(`${day}T12:00:00`).toLocaleDateString(undefined,
  day.slice(0, 4) === today.slice(0, 4) ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });

/** The day a reading describes: "today", "yesterday", "Sat, Nov 15"; for a night, "last night", "the
 *  night before last", "night of Fri, Nov 14" (a night belongs to the day it ends, §3.3). */
const dayWords = (field: string, day: string, now: Date): string => {
  const today = localDay(now); const ago = dayIndex(today) - dayIndex(day);
  if (!NIGHT_READINGS.has(field)) return ago === 0 ? 'today' : ago === 1 ? 'yesterday' : dateWords(day, today);
  if (ago === 0) return 'last night';
  if (ago === 1) return 'the night before last';
  const evening = new Date(`${day}T12:00:00`); evening.setDate(evening.getDate() - 1);
  return `night of ${dateWords(localDay(evening), today)}`;
};

/** A day as a date: "Tue, Nov 17", with its year when it is not this year's. */
export const readingDayDate = (day: string, now: Date): string => dateWords(day, localDay(now));

/** Sources that are no device's name (D-339 slice 18: a weight or height the owner typed on the Body's page). */
const SOURCE_WORDS: Readonly<Record<string, string>> = { typed: 'typed by you' };

/** A source as the owner knows it: `apple_health` → "Apple Health", `oura` → "Oura", `typed` → "typed by you". */
export const sourceWords = (value: string): string => Object.hasOwn(SOURCE_WORDS, value) ? SOURCE_WORDS[value]!
  : /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/u.test(value)
    ? value.split(/[_-]/u).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') : value.trim();

/** D-339 §3.4 — the Body's daily rows in Records: the pack, its entity, and the collection its
 *  recipes cite them as. */
export const BODY_SIGNALS_RECORDS = { owner: { publisher: 'recued-core', pack_slug: 'body-signals' }, entity: 'daily_metric' } as const;
const BODY_SIGNALS_COLLECTION = `${BODY_SIGNALS_RECORDS.owner.pack_slug}.${BODY_SIGNALS_RECORDS.entity}`;
export interface BodySignalsRow { id: string; day: string; source: string; metric: string }
const KEY = /^[a-z][a-z0-9_]*$/u;
/** A Body signals row that evidence cites. The pack's key names its day, source and metric
 *  (`<body_id>:<day>:<source>:<metric>`, a body id holding no colon), as a mail or calendar
 *  evidence id names its account. Any other evidence is not one. */
export const bodySignalsRow = (evidence: Pick<AssetEvidence, 'collection' | 'id'>): BodySignalsRow | undefined => {
  if (evidence.collection !== BODY_SIGNALS_COLLECTION) return undefined;
  const [body, day, source, metric, ...rest] = evidence.id.split(':');
  return body && !rest.length && isAssetDate(day) && KEY.test(source ?? '') && KEY.test(metric ?? '')
    ? { id: evidence.id, day: day as string, source: source!, metric: metric! } : undefined;
};

/** "Oura · last night": the `source` and `day` a reading's writer cites from its row, as the Body's
 *  summary does for each reading. The day counts only from the source's own row. Undefined when the
 *  writer cites neither. */
export const readingOriginWords = (field: string, evidence: readonly AssetEvidence[], now: Date): string | undefined => {
  const source = evidence.find(item => item.field === 'source' && typeof item.value === 'string' && item.value.trim());
  const day = evidence.find(item => item.field === 'day' && isAssetDate(item.value)
    && (!source || (item.collection === source.collection && item.id === source.id)));
  const words = [
    ...(source ? [sourceWords(source.value as string)] : []),
    ...(day ? [dayWords(field, day.value as string, now)] : []),
  ];
  return words.length ? words.join(' · ') : undefined;
};
