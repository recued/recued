/** D-339 slice 15 (D-339 §6) — a body goal in the owner's words: the line under its reading
 *  on the Body's page, its line on the Pursuits tab and its own page, and what "Ask with the numbers"
 *  sends of it. Its numbers are the server's (`BodyGoalProgress`), worked out from the Body when read. */
import { BODY_RANGE_REVIEW_DAYS, bodyRangePlace, type BodyGoalProgress, type BodyRange } from '@recued/contracts';
import { assetFieldName, nameInSentence, readingDayDate, readingSpanWords, readingValueWords } from './reading-words.js';
import { trendNumber } from './reading-sparkline.js';

const value = (number: number, unit: string): string => readingValueWords(number, unit, trendNumber);

/** The time a pace leaves, as a person says it: "a week", "3 weeks", "2 months". */
export const goalTimeWords = (weeks: number): string => {
  if (weeks < 1) return 'less than a week';
  if (weeks < 9) { const count = Math.round(weeks); return count === 1 ? 'a week' : `${String(count)} weeks`; }
  const months = Math.round(weeks / 4.345);
  return months === 1 ? 'a month' : `${String(months)} months`;
};

/** Where it stands: "1.1 kg to go", the pace, "looks reached", or why there is nothing to say. */
const standing = (progress: BodyGoalProgress): string[] => {
  const name = nameInSentence(assetFieldName(progress.goal.reading));
  if (progress.problem === 'body_gone') return ['its Body is no longer active'];
  if (progress.problem === 'no_value') return [`no ${name} yet`];
  if (progress.problem === 'other_unit') return [`the ${name} is in another unit now, so set the goal again`];
  if (progress.reached) return ['looks reached'];
  if (progress.to_go === undefined) return [];
  if (progress.to_go === 0) return ['there today'];
  return [`${value(progress.to_go, progress.goal.unit)} to go`,
    ...(progress.weeks_left !== undefined ? [`about ${goalTimeWords(progress.weeks_left)} at this pace`]
      : progress.per_week !== undefined && progress.per_week < 0 ? ['moving away from it'] : [])];
};

/** The goal and its date: "57 kg by Mon, Jun 1". */
const targetWords = (goal: { readonly target: number; readonly unit: string }, targetOn: string | undefined, now: Date): string =>
  `${value(goal.target, goal.unit)}${targetOn ? ` by ${readingDayDate(targetOn, now)}` : ''}`;

/** Under the reading on the Body's page: "Goal 57 kg by Mon, Jun 1 · 1.1 kg to go · about 3 weeks at this pace". */
export const goalLineWords = (progress: BodyGoalProgress, now: Date): string =>
  [`Goal ${targetWords(progress.goal, progress.target_on, now)}`, ...standing(progress)].join(' · ');

/** On the Pursuits tab and the goal's own page, where its target date has its own line:
 *  "Weight 58.1 kg now · goal 57 kg · 1.1 kg to go". */
export const goalProgressWords = (progress: BodyGoalProgress): string => {
  const words = [...(progress.now ? [`${assetFieldName(progress.goal.reading)} ${value(progress.now.value, progress.goal.unit)} now`] : []),
    `goal ${value(progress.goal.target, progress.goal.unit)}`, ...standing(progress)].join(' · ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** What "Ask with the numbers" sends of a goal: "goal weight 57 kg by Mon, Jun 1". */
export const goalAskWords = (goal: { readonly reading: string; readonly target: number; readonly unit: string }, targetOn: string | undefined, now: Date): string =>
  `goal ${nameInSentence(assetFieldName(goal.reading))} ${targetWords(goal, targetOn, now)}`;

// ── D-339 slice 16: the owner's own range for a reading ──────────────────────────────────────────────
type Bounds = Pick<BodyRange, 'low' | 'high' | 'unit'>;
const dayIndex = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;
const hundredths = (number: number): number => Math.round(number * 100) / 100;

/** Its bounds: "50–52 kg", "at most 20 %", "at least 55 kg". */
export const rangeWords = (range: Bounds): string =>
  range.low !== undefined && range.high !== undefined ? readingSpanWords(range.low, range.high, range.unit, '–', trendNumber)
    : range.high !== undefined ? `at most ${value(range.high, range.unit)}` : `at least ${value(range.low!, range.unit)}`;

/** Where a value sits: "in it", "0.8 kg over it", "1.2 kg under it". */
export const rangePlaceWords = (range: Bounds, now: number): string => {
  const { place, by } = bodyRangePlace(range, now);
  return place === 'in' ? 'in it' : `${value(hundredths(by), range.unit)} ${place} it`;
};

/** How many of the last two weeks' measured days were in it, from the reading's points (one a day):
 *  "in it on 9 of the 12 days measured in the last two weeks". Nothing with fewer than two days. */
export const rangeDaysWords = (range: Bounds, points: ReadonlyArray<{ value: number; day?: string }>, today: string): string | undefined => {
  const recent = points.filter(point => point.day !== undefined && dayIndex(today) - dayIndex(point.day) < 14 && dayIndex(point.day) <= dayIndex(today));
  if (recent.length < 2) return undefined;
  const inside = recent.filter(point => bodyRangePlace(range, point.value).place === 'in').length;
  return `in it on ${String(inside)} of the ${String(recent.length)} days measured in the last two weeks`;
};

/** Set long enough ago to ask whether it is still right (the owner: set numbers go stale). */
export const rangeDue = (range: Pick<BodyRange, 'set_on'>, today: string): boolean => dayIndex(today) - dayIndex(range.set_on) > BODY_RANGE_REVIEW_DAYS;

/** Under the reading on the Body's page: "Your range 50–52 kg · 0.8 kg over it now · in it on 9 of the 12 days
 *  measured in the last two weeks". "Now" sets today's reading apart from the two weeks. A reading in
 *  another unit says so instead of where it sits. */
export const rangeLineWords = (reading: string, range: Bounds, current: { value: number; unit: string } | undefined,
  points: ReadonlyArray<{ value: number; day?: string }>, today: string): string => {
  const parts = [`Your range ${rangeWords(range)}`];
  if (current && current.unit !== range.unit) parts.push(`the ${nameInSentence(assetFieldName(reading))} is in another unit now, so set the range again`);
  else if (current) {
    parts.push(`${rangePlaceWords(range, current.value)} now`);
    const days = rangeDaysWords(range, points, today);
    if (days) parts.push(days);
  }
  return parts.join(' · ');
};

/** What "Ask with the numbers" sends of a range: "own range for weight 50–52 kg", and, past its review,
 *  the day it was set. */
export const rangeAskWords = (reading: string, range: Bounds & { set_on?: string; due?: boolean }, now: Date): string =>
  `own range for ${nameInSentence(assetFieldName(reading))} ${rangeWords(range)}${range.due && range.set_on ? ` (set on ${readingDayDate(range.set_on, now)}; not checked since)` : ''}`;

