/** D-315 slice 7 — `date_from_text`: the time an English phrase in a line of
 *  text names, read on the owner's clock.
 *
 *  `"Call the dentist tomorrow at 9am"` → `{ at, text: "Call the dentist",
 *  phrase: "tomorrow at 9am" }`. Built for `+remind` (a request the owner
 *  emails themselves, the subject saying when), which was removed the same day:
 *  a reminder by email goes to D-318's chat mailbox, where the model reads the
 *  time. It stays for any recipe that reads a time in words. Deterministic: no
 *  model reads the text, and the same text at the same moment gives the same
 *  instant.
 *
 *  What it reads (case aside), the first phrase in the text:
 *  - a day: `today`, `tonight`, `tomorrow`, a weekday (`friday`, `on friday`,
 *    `this friday`, `next friday`), `next week`, a date (`oct 20`,
 *    `october 20th`, `20 october`, `the 20th of october`, `2026-10-20`, with or
 *    without a year);
 *  - a time: `9am`, `9:30 pm`, `at 21:00`, `noon`; and, next to a day only,
 *    a bare hour (`tomorrow at 5`);
 *  - a part of the day: `morning` (9:00), `afternoon` (15:00), `evening`
 *    (18:00), and `night` (20:00) after a day;
 *  - a span from now: `in 20 minutes`, `in 2 hours`, `in 2h`, `in half an
 *    hour`, `in 3 days`, `in a week`, `in 2 months`;
 *  - a day and a time together, either way round: `friday at 3pm`,
 *    `3pm on friday`, `in 3 days at 9am`.
 *
 *  How it settles them:
 *  - a day with no time takes `default_time` (09:00 unless the step says),
 *    `tonight` 20:00, a part of the day its own hour;
 *  - a time with no day is the next one: today if still ahead, else tomorrow;
 *  - a weekday is the next one AFTER today, and so are `this` / `next` /
 *    `coming` before it — ⚠ `next friday` is the coming Friday, not the one a
 *    week later; `next week` is the coming Monday;
 *  - a date with no year is the next one: this year's if still ahead;
 *  - a bare hour next to a day is read the way people say one: 1–6 in the
 *    afternoon, 7–11 in the morning, 12 noon; with `tonight`, any hour under 12
 *    is in the evening;
 *  - a span of minutes or hours counts from now; of days, weeks or months it
 *    keeps the clock it is now, unless a time is given.
 *
 *  ⚠ WHAT IT DOES NOT TAKE, ON PURPOSE: a weekday or a month cut short to three
 *  letters (`sun`, `may` without a day — *"wear sun cream"*, *"I may call"*); a
 *  bare number without `at` (*"buy 3 apples"*); `dd/mm` or `mm/dd`, which read
 *  differently on two sides of an ocean; `midnight`, which is the start of one
 *  day or the end of another. A full weekday name is read even where it is part
 *  of a name (*"Sunday school"*): the owner sees the time before anything is
 *  made of it. English only — another language is another reader.
 *
 *  Returns `{ at, text, phrase }`: `at` the instant as Unix ms, `text` the
 *  input with the phrase (and a `by` / `on` / `at` left hanging) taken out,
 *  `phrase` the words read. With no phrase: `{ at: null, text: <input trimmed>,
 *  phrase: null }`. `null` for an unknown `time_zone` or a malformed
 *  `default_time`, as the other date transforms refuse what they cannot read
 *  rather than read it on another clock. Reads the clock, so it is never
 *  cached (`step-seed.ts`). */

import { DAY_MS, zoneOffsetMsAt, zonedWallClockToEpochMs } from '@recued/contracts';

import type { TransformFn } from './types.js';

interface Day { readonly y: number; readonly m: number; readonly d: number }
interface Clock { readonly h: number; readonly min: number }

const pad2 = (n: number): string => String(n).padStart(2, '0');

const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

const isRealDay = (day: Day): boolean =>
  day.m >= 1 && day.m <= 12 && day.d >= 1 && day.d <= daysInMonth(day.y, day.m);

const dayFromUtc = (ms: number): Day => {
  const x = new Date(ms);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
};

const addDays = (day: Day, n: number): Day => dayFromUtc(Date.UTC(day.y, day.m - 1, day.d) + n * DAY_MS);

/** A month on, keeping the day where the month has it (Jan 31 + 1 → Feb 28). */
const addMonths = (day: Day, n: number): Day => {
  const index = day.m - 1 + n;
  const y = day.y + Math.floor(index / 12);
  const m = ((index % 12) + 12) % 12 + 1;
  return { y, m, d: Math.min(day.d, daysInMonth(y, m)) };
};

/** 0 Sunday … 6 Saturday. */
const weekdayOf = (day: Day): number => new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();

/** The zone a step names: `''` none (the server process's clock, as the other
 *  date transforms read it), `null` one the platform does not know. */
const zoneParam = (v: unknown): string | null => {
  const zone = typeof v === 'string' ? v.trim() : '';
  if (zone === '') return '';
  return zonedWallClockToEpochMs('2000-01-01', zone) === null ? null : zone;
};

/** The owner's day and clock at an instant. */
const localAt = (ms: number, zone: string): { day: Day; clock: Clock } => {
  if (zone === '') {
    const x = new Date(ms);
    return { day: { y: x.getFullYear(), m: x.getMonth() + 1, d: x.getDate() }, clock: { h: x.getHours(), min: x.getMinutes() } };
  }
  const x = new Date(ms + zoneOffsetMsAt(ms, zone));
  return {
    day: { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() },
    clock: { h: x.getUTCHours(), min: x.getUTCMinutes() },
  };
};

/** The instant a day and a clock name on the owner's clock. */
const instantOf = (day: Day, clock: Clock, zone: string): number | null => {
  if (!isRealDay(day)) return null;
  if (zone === '') {
    const t = new Date(day.y, day.m - 1, day.d, clock.h, clock.min).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return zonedWallClockToEpochMs(`${String(day.y).padStart(4, '0')}-${pad2(day.m)}-${pad2(day.d)}T${pad2(clock.h)}:${pad2(clock.min)}`, zone);
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};
const PART_CLOCKS: Readonly<Record<string, Clock>> = {
  morning: { h: 9, min: 0 }, afternoon: { h: 15, min: 0 }, evening: { h: 18, min: 0 }, night: { h: 20, min: 0 },
};

const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ORDINAL = '(?:st|nd|rd|th)?';
/** Not a possessive: "today's agenda" names no day. */
const WORD_END = "(?![\\w'’])";

/** What a token says, before it is settled against now. */
type DayToken =
  | { readonly kind: 'relative_day'; readonly days: number; readonly tonight?: true }
  | { readonly kind: 'weekday'; readonly weekday: number }
  | { readonly kind: 'next_week' }
  | { readonly kind: 'date'; readonly m: number; readonly d: number; readonly y: number | null };

type Token =
  | { readonly type: 'day'; readonly start: number; readonly end: number; readonly day: DayToken }
  | { readonly type: 'time'; readonly start: number; readonly end: number; readonly clock: Clock }
  /** An hour without am / pm or minutes, read only next to a day. */
  | { readonly type: 'bare'; readonly start: number; readonly end: number; readonly hour: number }
  | { readonly type: 'part'; readonly start: number; readonly end: number; readonly part: string }
  | { readonly type: 'span'; readonly start: number; readonly end: number; readonly unit: 'minute' | 'hour' | 'day' | 'week' | 'month'; readonly n: number };

const monthIndex = (name: string): number => MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase()) + 1;

/** Every match of a pattern, as a token where `make` accepts it. */
const scan = (text: string, pattern: string, make: (m: RegExpExecArray) => Token | null): Token[] => {
  const re = new RegExp(pattern, 'gi');
  const out: Token[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const token = make(m);
    if (token !== null) out.push(token);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return out;
};

const tokensOf = (text: string): Token[] => {
  const at = (m: RegExpExecArray): { start: number; end: number } => ({ start: m.index, end: m.index + m[0].length });
  const tokens: Token[] = [
    ...scan(text, `\\b(?:on\\s+)?(today|tonight|tomorrow)${WORD_END}`, (m) => {
      const word = m[1]!.toLowerCase();
      return {
        type: 'day', ...at(m),
        day: word === 'tomorrow' ? { kind: 'relative_day', days: 1 }
          : word === 'tonight' ? { kind: 'relative_day', days: 0, tonight: true }
          : { kind: 'relative_day', days: 0 },
      };
    }),
    ...scan(text, `\\b(?:(?:on|this|next|coming)\\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)${WORD_END}`,
      (m) => ({ type: 'day', ...at(m), day: { kind: 'weekday', weekday: WEEKDAY_NAMES.indexOf(m[1]!.toLowerCase()) } })),
    ...scan(text, `\\bnext\\s+week${WORD_END}`, (m) => ({ type: 'day', ...at(m), day: { kind: 'next_week' } })),
    ...scan(text, `\\b(?:on\\s+)?${MONTH}\\.?\\s+(\\d{1,2})${ORDINAL}\\b(?:,?\\s+(\\d{4})\\b)?`, (m) => ({
      type: 'day', ...at(m),
      day: { kind: 'date', m: monthIndex(m[1]!), d: Number(m[2]), y: m[3] === undefined ? null : Number(m[3]) },
    })),
    ...scan(text, `\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?${MONTH}\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, (m) => ({
      type: 'day', ...at(m),
      day: { kind: 'date', m: monthIndex(m[2]!), d: Number(m[1]), y: m[3] === undefined ? null : Number(m[3]) },
    })),
    ...scan(text, '\\b(?:on\\s+)?(\\d{4})-(\\d{2})-(\\d{2})\\b', (m) => ({
      type: 'day', ...at(m), day: { kind: 'date', m: Number(m[2]), d: Number(m[3]), y: Number(m[1]) },
    })),
    ...scan(text, '(?:\\bat\\s+|@\\s*)?\\b(\\d{1,2})(?::([0-5]\\d))?\\s*([ap])\\.?m\\b\\.?', (m) => {
      const hour = Number(m[1]);
      if (hour < 1 || hour > 12) return null;
      const pm = m[3]!.toLowerCase() === 'p';
      return { type: 'time', ...at(m), clock: { h: (hour % 12) + (pm ? 12 : 0), min: Number(m[2] ?? '0') } };
    }),
    ...scan(text, '(?:\\bat\\s+|@\\s*)?\\b([01]?\\d|2[0-3]):([0-5]\\d)\\b(?!\\s*[ap]\\.?m\\b)', (m) => ({
      type: 'time', ...at(m), clock: { h: Number(m[1]), min: Number(m[2]) },
    })),
    ...scan(text, `(?:\\bat\\s+)?\\b(noon|midday)${WORD_END}`, (m) => ({ type: 'time', ...at(m), clock: { h: 12, min: 0 } })),
    ...scan(text, '\\bat\\s+(\\d{1,2})\\b(?![:.]\\d|\\s*[ap]\\.?m\\b)', (m) => {
      const hour = Number(m[1]);
      return hour > 23 ? null : { type: 'bare', ...at(m), hour };
    }),
    ...scan(text, `\\b(?:in\\s+the\\s+|this\\s+)?(morning|afternoon|evening)${WORD_END}`,
      (m) => ({ type: 'part', ...at(m), part: m[1]!.toLowerCase() })),
    ...scan(text, `\\b(?:at\\s+)?(night)${WORD_END}`, (m) => ({ type: 'part', ...at(m), part: 'night' })),
    ...scan(text, '\\bin\\s+half\\s+an\\s+hour\\b', (m) => ({ type: 'span', ...at(m), unit: 'minute', n: 30 })),
    ...scan(text, '\\bin\\s+(\\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s+(minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\\b',
      (m) => {
        const word = m[1]!.toLowerCase();
        const n = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word];
        if (n === undefined || n === 0) return null;
        const unit = m[2]!.toLowerCase();
        return {
          type: 'span', ...at(m), n,
          unit: unit.startsWith('mi') ? 'minute' : unit.startsWith('h') ? 'hour' : unit.startsWith('d') ? 'day'
            : unit.startsWith('w') ? 'week' : 'month',
        };
      }),
    ...scan(text, '\\bin\\s+(\\d{1,3})\\s*(m|mins?|h|hrs?|d|w)\\b', (m) => {
      const n = Number(m[1]);
      if (n === 0) return null;
      const unit = m[2]!.toLowerCase();
      return {
        type: 'span', ...at(m), n,
        unit: unit.startsWith('m') ? 'minute' : unit.startsWith('h') ? 'hour' : unit === 'd' ? 'day' : 'week',
      };
    }),
  ];
  // Where two overlap, the longer is the one meant ("at 9am", not "at 9");
  // between two as long, the earlier.
  tokens.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept: Token[] = [];
  for (const token of tokens) {
    const clash = kept.findIndex((k) => token.start < k.end && k.start < token.end);
    if (clash < 0) {
      kept.push(token);
    } else if ((token.end - token.start) > (kept[clash]!.end - kept[clash]!.start)) {
      kept[clash] = token;
    }
  }
  return kept.sort((a, b) => a.start - b.start);
};

/** Only words that join a day to a time between two tokens: `friday, 3pm`,
 *  `tomorrow - 9am`. Each token carries its own `at` / `on`. */
const joins = (text: string, from: number, to: number): boolean =>
  from <= to && /^[\s,–—-]*$/.test(text.slice(from, to));

interface Phrase {
  readonly start: number;
  readonly end: number;
  readonly day?: Extract<Token, { type: 'day' }>;
  readonly clock?: Clock;
  readonly bare?: number;
  readonly part?: string;
  readonly span?: Extract<Token, { type: 'span' }>;
}

/** The first phrase: a day, a time, a part of the day or a span, with the one
 *  next to it that completes it. A bare hour alone is no phrase. */
const firstPhrase = (text: string, tokens: readonly Token[]): Phrase | null => {
  for (let i = 0; i < tokens.length; i += 1) {
    const head = tokens[i]!;
    const next = tokens[i + 1];
    const adjacent = next !== undefined && joins(text, head.end, next.start);
    const withTime = (phrase: Phrase, token: Token | undefined): Phrase => {
      if (token === undefined) return phrase;
      if (token.type === 'time') return { ...phrase, end: token.end, clock: token.clock };
      if (token.type === 'bare') return { ...phrase, end: token.end, bare: token.hour };
      if (token.type === 'part') return { ...phrase, end: token.end, part: token.part };
      return phrase;
    };
    if (head.type === 'day') {
      return withTime({ start: head.start, end: head.end, day: head }, adjacent ? next : undefined);
    }
    if (head.type === 'span') {
      const later = head.unit === 'day' || head.unit === 'week' || head.unit === 'month';
      const time = adjacent && later && next!.type === 'time' ? next : undefined;
      return withTime({ start: head.start, end: head.end, span: head }, time);
    }
    if (head.type === 'time' || head.type === 'bare' || head.type === 'part') {
      if (adjacent && next!.type === 'day') {
        return { ...withTime({ start: head.start, end: next!.end, day: next as Extract<Token, { type: 'day' }> }, head), start: head.start, end: next!.end };
      }
      if (head.type === 'bare') continue;
      if (head.type === 'part' && head.part === 'night') continue;
      return withTime({ start: head.start, end: head.end }, head);
    }
  }
  return null;
};

/** A bare hour, read as people say one. */
const bareClock = (hour: number, tonight: boolean): Clock => {
  if (tonight && hour < 12) return { h: hour + 12, min: 0 };
  if (hour >= 1 && hour <= 6) return { h: hour + 12, min: 0 };
  return { h: hour, min: 0 };
};

const settle = (
  phrase: Phrase,
  nowMs: number,
  zone: string,
  defaultClock: Clock,
): number | null => {
  const now = localAt(nowMs, zone);
  if (phrase.span !== undefined) {
    const { unit, n } = phrase.span;
    if (unit === 'minute') return nowMs + n * 60_000;
    if (unit === 'hour') return nowMs + n * 3_600_000;
    const day = unit === 'month' ? addMonths(now.day, n) : addDays(now.day, unit === 'week' ? 7 * n : n);
    return instantOf(day, phrase.clock ?? now.clock, zone);
  }
  const token = phrase.day?.day;
  const tonight = token?.kind === 'relative_day' && token.tonight === true;
  const clock: Clock | undefined = phrase.clock
    ?? (phrase.bare !== undefined ? bareClock(phrase.bare, tonight) : undefined)
    ?? (phrase.part !== undefined ? PART_CLOCKS[phrase.part] : undefined);
  if (token === undefined) {
    // A time, or a part of the day, with no day: the next one.
    const today = instantOf(now.day, clock!, zone);
    if (today === null) return null;
    return today > nowMs ? today : instantOf(addDays(now.day, 1), clock!, zone);
  }
  const dayClock = clock ?? (tonight ? PART_CLOCKS.night! : defaultClock);
  switch (token.kind) {
    case 'relative_day':
      return instantOf(addDays(now.day, token.days), dayClock, zone);
    case 'weekday': {
      const ahead = ((token.weekday - weekdayOf(now.day) + 7) % 7) || 7;
      return instantOf(addDays(now.day, ahead), dayClock, zone);
    }
    case 'next_week': {
      const ahead = ((1 - weekdayOf(now.day) + 7) % 7) || 7;
      return instantOf(addDays(now.day, ahead), dayClock, zone);
    }
    case 'date': {
      if (token.y !== null) return instantOf({ y: token.y, m: token.m, d: token.d }, dayClock, zone);
      const thisYear = instantOf({ y: now.day.y, m: token.m, d: token.d }, dayClock, zone);
      if (thisYear !== null && thisYear > nowMs) return thisYear;
      // Gone this year (or Feb 29 in a year without one): the next one there is.
      for (let y = now.day.y + 1; y <= now.day.y + 8; y += 1) {
        const later = instantOf({ y, m: token.m, d: token.d }, dayClock, zone);
        if (later !== null) return later;
      }
      return null;
    }
  }
};

/** The text with the phrase taken out, and what it leaves hanging. */
const without = (text: string, start: number, end: number): string => {
  const before = text.slice(0, start).replace(/\s+(?:by|on|at|before|until|for|due)\s*$/i, '');
  const after = text.slice(end).replace(/^\s*(?:by|on|at)\s+(?=\S)/i, ' ');
  return `${before} ${after}`
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:.!?])/g, '$1')
    .replace(/^[\s,;:.–—-]+|[\s,;:–—-]+$/g, '')
    .trim();
};

export const date_from_text: TransformFn = (p, ctx) => {
  const zone = zoneParam(p.time_zone);
  if (zone === null) return null;
  let defaultClock: Clock = { h: 9, min: 0 };
  if (p.default_time !== undefined && p.default_time !== null && p.default_time !== '') {
    const m = typeof p.default_time === 'string' ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(p.default_time.trim()) : null;
    if (m === null) return null;
    defaultClock = { h: Number(m[1]), min: Number(m[2]) };
  }
  const text = typeof p.input === 'string' ? p.input : '';
  const phrase = firstPhrase(text, tokensOf(text));
  if (phrase === null) return { at: null, text: text.trim(), phrase: null };
  const at = settle(phrase, ctx.now().getTime(), zone, defaultClock);
  if (at === null) return { at: null, text: text.trim(), phrase: null };
  return { at, text: without(text, phrase.start, phrase.end), phrase: text.slice(phrase.start, phrase.end).trim() };
};
