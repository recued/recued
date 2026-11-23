/** D-339 slices 11 and 13 (D-339 §5.6) — the message "Ask with the numbers" sends to
 *  Chat: a Body's days as its page holds them (`reading_trends`, a point a day for each reading with a
 *  line), in the page's own words, with what the owner chose to say about the person and what they ask.
 *
 *  The owner chooses what for, the readings, the days, whether the usual range and the trend go too,
 *  and what about the person (age, never the birth date; height; weight; gender), sees this text, and
 *  can change it before sending. It is the owner's own message: nothing travels behind it, so what the
 *  model reads is what was sent, with every edit.
 *
 *  A table, a row a day and a column a reading: compact for the owner to check and for a model to
 *  read, and each value keeps its unit ("7 h 05", "52 bpm"). A day a reading has no value shows "—";
 *  a reading with no value in the window is left out. */
import type { BodyChatRequest, YoursReadingStale, YoursReadingTrend } from '@recued/contracts';
import { assetFieldName, nameInSentence, readingDayDate, readingSpanWords, readingTrendWords, readingValueWords } from './reading-words.js';
import { goalAskWords, rangeAskWords } from './body-goal-words.js';
import { trendNumber } from './reading-sparkline.js';

export const BODY_NUMBERS_DAYS = [7, 14, 30] as const;
export type BodyNumbersDays = (typeof BODY_NUMBERS_DAYS)[number];

/** Slice 14 — a reading that has probably changed since it was measured: said beside it, with the weight
 *  it was taken at when that is why. */
export interface BodyNumbersStale { readonly weight_then?: { readonly value: number; readonly unit: string } }

/** What goes about the person, each already chosen: a value left out is absent. */
export interface BodyNumbersAbout {
  readonly age?: number;
  readonly height?: { readonly value: number; readonly unit: string; readonly day?: string; readonly stale?: BodyNumbersStale };
  /** The latest weight, and the day it is for when the page knows it. */
  readonly weight?: { readonly value: number; readonly unit: string; readonly day?: string; readonly stale?: BodyNumbersStale };
  /** Slice 14 — worked out from the height and the weight that go with it. */
  readonly bmi?: number;
  readonly gender?: string;
  /** Slice 14 — body fat, lean body mass, muscle mass, waist: each with the day it was taken. */
  readonly measures?: ReadonlyArray<{ readonly field: string; readonly value: number; readonly unit: string; readonly day?: string; readonly stale?: BodyNumbersStale }>;
  /** Slice 15 — the Body's goals: what the request is read against. */
  readonly goals?: ReadonlyArray<{ readonly reading: string; readonly target: number; readonly unit: string; readonly target_on?: string }>;
  /** Slice 16 — the Body's own ranges; one past its review says the day it was set. */
  readonly ranges?: ReadonlyArray<{ readonly reading: string; readonly low?: number; readonly high?: number; readonly unit: string;
    readonly set_on?: string; readonly due?: boolean }>;
}

/** The day a value is for and, when it has probably changed, why: "(Mon, Nov 17, at 62 kg; probably
 *  changed)". Nothing when there is neither. */
const whenWords = (at: Date, day: string | undefined, stale: BodyNumbersStale | undefined): string => {
  const parts = [...(day ? [readingDayDate(day, at)] : []), ...(stale?.weight_then ? [`at ${readingValueWords(stale.weight_then.value, stale.weight_then.unit, trendNumber)}`] : [])];
  const said = parts.join(', ');
  return stale ? ` (${said ? `${said}; ` : ''}probably changed)` : said ? ` (${said})` : '';
};

/** D-339 slice 14 — why a reading has probably changed, as the page and the form say it. */
export const staleWords = (stale: YoursReadingStale, now: Date): string => {
  const days = `${String(stale.days_old)} day${stale.days_old === 1 ? '' : 's'} ago`;
  if (stale.reason === 'weight_moved' && stale.weight_then && stale.weight_now) {
    return `Measured ${readingDayDate(stale.day, now)} at ${readingValueWords(stale.weight_then.value, stale.weight_then.unit, trendNumber)}. `
      + `You weigh ${readingValueWords(stale.weight_now.value, stale.weight_now.unit, trendNumber)} now, so it has probably changed.`;
  }
  if (stale.reason === 'growing') return `Measured ${days}. Height still changes before 18.`;
  return stale.field === 'weight' ? `Last weighed ${days}.` : `Measured ${days}, so it has probably changed.`;
};

/** D-339 slice 14 — BMI from a height and a weight, as Recued works it out (never stored, so it is as
 *  current as they are), to one decimal; undefined when either is missing or in a unit it cannot read. */
export const bodyMassIndex = (height: { value: number; unit: string } | null | undefined,
  weight: { value: number; unit: string } | null | undefined): number | undefined => {
  if (!height || !weight || !Number.isFinite(height.value) || !Number.isFinite(weight.value)) return undefined;
  const metres = height.unit === 'cm' ? height.value / 100 : height.unit === 'm' ? height.value : height.unit === 'in' ? height.value * 0.0254 : undefined;
  const kilograms = weight.unit === 'kg' ? weight.value : weight.unit === 'lb' ? weight.value * 0.45359237 : undefined;
  if (metres === undefined || kilograms === undefined || metres <= 0 || kilograms <= 0) return undefined;
  return Math.round((kilograms / (metres * metres)) * 10) / 10;
};

/** WHO's healthy range for adults. For under-18s BMI is read against age charts, so none is shown. */
export const WHO_ADULT_BMI = { low: 18.5, high: 24.9, from_age: 18 } as const;

export interface BodyNumbersChoice {
  /** The readings that go, by field, in any order: the text keeps the page's order. */
  readonly fields: readonly string[];
  readonly days: BodyNumbersDays;
  /** The usual range and the trend, worded as the page's lenses word them. */
  readonly lenses: boolean;
  readonly about?: BodyNumbersAbout;
  /** What the owner asks. Absent, or "other" with no words: "What do you notice?". */
  readonly request?: { readonly kind: BodyChatRequest; readonly text?: string };
}

/** What the text ends with when the owner asks nothing in particular. */
export const BODY_NUMBERS_QUESTION = 'What do you notice?';

/** What each request asks, as the message's last paragraph. Everyday eating and exercise, never a
 *  diagnosis: D-339 §9 keeps medical advice out. */
export const BODY_REQUEST_WORDS: Readonly<Record<Exclude<BodyChatRequest, 'other'>, string>> = {
  explain: 'What do these numbers say? Point out anything unusual, and say what each point rests on.',
  diet: 'Suggest what to eat this week, given these numbers. Say what each suggestion rests on. This is for everyday eating, not medical advice.',
  workout: 'Suggest workouts for this week, given these numbers and how recovery looks. Say what each suggestion rests on. This is for everyday exercise, not medical advice.',
};

/** Full years from a birth date to a day, both `YYYY-MM-DD`; undefined for a date that is not one or
 *  is later than the day. */
export const ageOn = (birth: string, day: string): number | undefined => {
  const pattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
  const b = pattern.exec(birth); const d = pattern.exec(day);
  if (!b || !d) return undefined;
  const [by, bm, bd] = [Number(b[1]), Number(b[2]), Number(b[3])];
  const [dy, dm, dd] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const real = new Date(Date.UTC(by, bm - 1, bd));
  if (real.getUTCFullYear() !== by || real.getUTCMonth() !== bm - 1 || real.getUTCDate() !== bd || birth > day) return undefined;
  return dy - by - (dm < bm || (dm === bm && dd < bd) ? 1 : 0);
};

const pad = (value: number): string => String(value).padStart(2, '0');
/** The browser's day of an instant, as the page dates everything else. */
const browserDay = (at: number): string => {
  const date = new Date(at);
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
/** The day `delta` days from `day`, by the calendar: no clock, so no daylight-saving hour. */
const shiftDay = (day: string, delta: number): string =>
  new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + delta)).toISOString().slice(0, 10);

/** The day a point is for: the server's own count when it sends one, else the browser's day of `at`
 *  (an older server). A Body day's `at` is the day's start in the zone it was recorded in, which can be
 *  the evening before in a browser further west. */
const pointDay = (point: YoursReadingTrend['points'][number]): string => point.day ?? browserDay(point.at);

/** The text, or undefined when nothing chosen has a value in the window and nothing goes about the
 *  person. The window is the last `days` days, ending today or on a later day a point is for (a night
 *  recorded in a zone ahead of the browser's), so the newest night is never left out. */
export const bodyNumbersText = (name: string, trends: readonly YoursReadingTrend[], choice: BodyNumbersChoice,
  now: number): string | undefined => {
  const chosen = trends.filter(trend => choice.fields.includes(trend.field));
  const byField = new Map<string, Map<string, number>>();
  let newest = '';
  for (const trend of chosen) {
    const byDay = new Map<string, number>();
    // The points are oldest first: on a day two share (only from an older server), the later one stays.
    for (const point of trend.points) {
      if (!Number.isFinite(point.value)) continue;
      const day = pointDay(point);
      byDay.set(day, point.value);
      if (day > newest) newest = day;
    }
    byField.set(trend.field, byDay);
  }
  const today = browserDay(now);
  const end = newest > today ? newest : today;
  const start = shiftDay(end, 1 - choice.days);
  const inWindow = (day: string): boolean => day >= start && day <= end;
  const columns = chosen.filter(trend => [...byField.get(trend.field)!.keys()].some(inWindow));
  const days = [...new Set(columns.flatMap(trend => [...byField.get(trend.field)!.keys()].filter(inWindow)))].sort();
  const at = new Date(now);
  const { about = {} } = choice;
  const aboutWords = [
    ...(about.age !== undefined ? [`age ${String(about.age)}`] : []),
    ...(about.height ? [`height ${readingValueWords(about.height.value, about.height.unit, trendNumber)}${about.height.stale ? whenWords(at, about.height.day, about.height.stale) : ''}`] : []),
    ...(about.weight ? [`weight ${readingValueWords(about.weight.value, about.weight.unit, trendNumber)}${whenWords(at, about.weight.day, about.weight.stale)}`] : []),
    ...(about.bmi !== undefined ? [`BMI ${trendNumber(about.bmi)}`] : []),
    ...(about.gender?.trim() ? [`gender ${about.gender.trim()}`] : []),
    ...(about.measures ?? []).map(measure =>
      `${nameInSentence(assetFieldName(measure.field))} ${readingValueWords(measure.value, measure.unit, trendNumber)}${whenWords(at, measure.day, measure.stale)}`),
    ...(about.goals ?? []).map(goal => goalAskWords(goal, goal.target_on, at)),
    ...(about.ranges ?? []).map(range => rangeAskWords(range.reading, range, at)),
  ];
  if (days.length === 0 && aboutWords.length === 0) return undefined;

  const lines = [
    days.length > 0 ? `${name}, the last ${String(choice.days)} days, as Recued recorded them:` : `${name}:`,
    ...(aboutWords.length > 0 ? [`About: ${aboutWords.join(' · ')}`] : []),
    ...(days.length > 0 ? [
      ['Day', ...columns.map(trend => assetFieldName(trend.field))].join(' | '),
      ...days.map(day => [readingDayDate(day, at), ...columns.map(trend => {
        const value = byField.get(trend.field)!.get(day);
        return value === undefined ? '—' : readingValueWords(value, trend.unit, trendNumber);
      })].join(' | ')),
    ] : []),
  ];
  if (choice.lenses && days.length > 0) {
    const lenses = columns.flatMap(trend => {
      const parts = [
        ...(trend.usual
          ? [`usual ${readingSpanWords(trend.usual.low, trend.usual.high, trend.unit, '–', trendNumber)} · last ${String(trend.usual.days ?? 30)} days`]
          : []),
        ...(trend.trend ? [readingTrendWords(trend.trend, trend.unit).replace(/^\p{Lu}/u, letter => letter.toLowerCase())] : []),
      ];
      return parts.length > 0 ? [`${assetFieldName(trend.field)}: ${parts.join('; ')}`] : [];
    });
    if (lenses.length > 0) lines.push('', ...lenses);
  }
  const request = choice.request;
  const ask = request === undefined || request.kind === 'other'
    ? (request?.text?.trim() || BODY_NUMBERS_QUESTION) : BODY_REQUEST_WORDS[request.kind];
  return `${lines.join('\n')}\n\n${ask}`;
};
