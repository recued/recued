/** D-339 slices 11 and 13 (D-339 §5.6) — "Ask with the numbers": the message the owner
 *  sees, changes and sends, and the seam that carries it to the Body's own conversation.
 *
 *  The form and Chat are driven in real Chrome, with a real model, by
 *  `scripts/drives/d-339-ask-with-numbers-live.mjs`; the send's rpc by `d-339-body-chat.test.ts`. Here:
 *  the text a choice gives, and that the route and the bootstrap send that text and nothing else. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { YoursReadingTrend } from '@recued/contracts';
import { BODY_NUMBERS_QUESTION, BODY_REQUEST_WORDS, ageOn, bodyNumbersText, type BodyNumbersChoice } from '../yours/body-numbers-text.js';
import { readingDayDate } from '../yours/reading-words.js';

const HOUR = 3_600_000;
// 09:00 on Nov 17, 2026, in the test machine's own zone: the page dates days as the browser does.
const now = new Date(2026, 10, 17, 9, 0, 0).getTime();
const pad = (value: number): string => String(value).padStart(2, '0');
/** The browser's day `offset` days from Nov 17. */
const day = (offset: number): string => {
  const date = new Date(2026, 10, 17 + offset);
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const midnight = (value: string): number => new Date(`${value}T00:00:00`).getTime();
/** A day as the text labels it: the page's own words for a date. */
const label = (offset: number): string => readingDayDate(day(offset), new Date(now));
const line = (field: string, unit: string, values: Array<[number, number]>, extra: Partial<YoursReadingTrend> = {}): YoursReadingTrend =>
  ({ field, unit, days: 30, points: values.map(([offset, value]) => ({ at: midnight(day(offset)), value, day: day(offset) })), ...extra });

const sleep = line('sleep_minutes', 'min', [[-9, 400], [-6, 425], [-5, 380], [-4, 455], [-3, 432], [-2, 418], [-1, 441], [0, 425]],
  { usual: { median: 427, low: 416, high: 438, days: 14 }, trend: { direction: 'rising', per_week: 9, days: 30 } });
const restingHeartRate = line('resting_heart_rate', 'bpm', [[-6, 52], [-5, 54], [-3, 53], [0, 51]],
  { trend: { direction: 'steady', per_week: 0.1, days: 30 } });
// Nothing in the last 7 days.
const hrv = line('hrv_sdnn', 'ms', [[-20, 41.3], [-12, 44]]);
const steps = line('steps', 'steps', [[-6, 8120], [-1, 10432]]);
// The page's order, which the text keeps.
const page = [sleep, restingHeartRate, hrv, steps];
const text = (choice: Partial<BodyNumbersChoice>, trends: readonly YoursReadingTrend[] = page): string | undefined =>
  bodyNumbersText('Anna’s body', trends, { fields: page.map(trend => trend.field), days: 7, lenses: false, ...choice }, now);

describe('D-339 slice 11 — the text "Ask with the numbers" puts in Chat', () => {
  it('is a table: a row a day, oldest first, a column a reading in the page\'s order and words, then the question', () => {
    // Chosen in another order: the columns keep the page's.
    expect(text({ fields: ['steps', 'sleep_minutes', 'resting_heart_rate'] })).toBe([
      'Anna’s body, the last 7 days, as Recued recorded them:',
      'Day | Sleep | Resting heart rate | Steps',
      `${label(-6)} | 7 h 05 | 52 bpm | 8120 steps`,
      `${label(-5)} | 6 h 20 | 54 bpm | —`,
      `${label(-4)} | 7 h 35 | — | —`,
      `${label(-3)} | 7 h 12 | 53 bpm | —`,
      `${label(-2)} | 6 h 58 | — | —`,
      `${label(-1)} | 7 h 21 | — | 10432 steps`,
      `${label(0)} | 7 h 05 | 51 bpm | —`,
      '',
      BODY_NUMBERS_QUESTION,
    ].join('\n'));
  });

  it('leaves out a reading with no value in the window, and takes it in when a longer window reaches it', () => {
    expect(text({ fields: ['sleep_minutes', 'hrv_sdnn'] })).not.toContain('Heart rate variability');
    const fortnight = text({ fields: ['sleep_minutes', 'hrv_sdnn'], days: 14 })!;
    expect(fortnight.split('\n')[1]).toBe('Day | Sleep | Heart rate variability (SDNN)');
    expect(fortnight).toContain(`${label(-12)} | — | 44 ms`);
    expect(fortnight).toContain(`${label(-9)} | 6 h 40 | —`);
    expect(fortnight).not.toContain(label(-20));
  });

  it('adds the usual range and the trend as the page\'s lenses word them, for the readings that have them', () => {
    const lenses = text({ fields: ['sleep_minutes', 'resting_heart_rate', 'steps'], lenses: true })!.split('\n');
    // After the table: a blank line, a line for each reading with a usual range or a trend, the question.
    expect(lenses.slice(-5)).toEqual([
      '',
      'Sleep: usual 6 h 56–7 h 18 · last 14 days; rising, about 9 min a week · last 30 days',
      'Resting heart rate: steady · last 30 days',
      '',
      BODY_NUMBERS_QUESTION,
    ]);
    expect(text({ fields: ['steps'], lenses: true })).not.toMatch(/usual|steady|rising/u);
  });

  it('labels a point by the day it is for, not by the browser\'s day of its instant', () => {
    // A night of the 17th recorded in a zone ahead of this one starts at 22:00 on the 16th here.
    const ahead: YoursReadingTrend = { field: 'sleep_minutes', unit: 'min', points: [{ at: midnight(day(0)) - 2 * HOUR, value: 425, day: day(0) }] };
    expect(text({ fields: ['sleep_minutes'] }, [ahead])).toContain(`${label(0)} | 7 h 05`);
    expect(text({ fields: ['sleep_minutes'] }, [ahead])).not.toContain(label(-1));
    // From an older server, with no day: the browser's day of the instant.
    const { day: _day, ...older } = ahead.points[0]!;
    expect(text({ fields: ['sleep_minutes'] }, [{ ...ahead, points: [older] }])).toContain(`${label(-1)} | 7 h 05`);
  });

  it('ends the window on a later day a point is for, so the newest night is never left out', () => {
    const tomorrow: YoursReadingTrend = { field: 'sleep_minutes', unit: 'min', points: [
      { at: midnight(day(-6)), value: 400, day: day(-6) }, { at: midnight(day(1)) - 2 * HOUR, value: 425, day: day(1) }] };
    const rows = text({ fields: ['sleep_minutes'] }, [tomorrow])!.split('\n');
    // The 7 days end on the 18th, so the 11th falls out and the 18th is in.
    expect(rows[2]).toBe(`${readingDayDate(day(1), new Date(now))} | 7 h 05`);
    expect(rows).not.toContain(`${label(-6)} | 6 h 40`);
  });

  it('is nothing when nothing chosen has a value in the window', () => {
    expect(text({ fields: [] })).toBeUndefined();
    expect(text({ fields: ['hrv_sdnn'] })).toBeUndefined();
  });
});

describe('D-339 slice 13 — what goes about the person, and what the owner asks', () => {
  it('says the age, the height, the latest weight with its day and the gender on one line after the heading', () => {
    const rows = text({ fields: ['sleep_minutes'], about: { age: 36, height: { value: 168, unit: 'cm' },
      weight: { value: 61.2, unit: 'kg', day: day(-2) }, gender: ' female ' } })!.split('\n');
    expect(rows.slice(0, 3)).toEqual(['Anna’s body, the last 7 days, as Recued recorded them:',
      `About: age 36 · height 168 cm · weight 61.2 kg (${label(-2)}) · gender female`, 'Day | Sleep']);
    // Each is left out on its own; with none, no line at all.
    expect(text({ fields: ['sleep_minutes'], about: { age: 36 } })!.split('\n')[1]).toBe('About: age 36');
    expect(text({ fields: ['sleep_minutes'], about: { gender: '  ' } })!.split('\n')[1]).toBe('Day | Sleep');
  });

  it('ends with what the owner asks: each kind in its words, their own words, or the question', () => {
    for (const kind of ['explain', 'diet', 'workout'] as const) {
      expect(text({ fields: ['sleep_minutes'], request: { kind } })!.endsWith(`\n\n${BODY_REQUEST_WORDS[kind]}`)).toBe(true);
    }
    expect(text({ fields: ['sleep_minutes'], request: { kind: 'other', text: '  Am I sleeping enough?  ' } })!.endsWith('\n\nAm I sleeping enough?')).toBe(true);
    expect(text({ fields: ['sleep_minutes'], request: { kind: 'other', text: ' ' } })!.endsWith(`\n\n${BODY_NUMBERS_QUESTION}`)).toBe(true);
    // Everyday eating and exercise, never a diagnosis (§9).
    expect(BODY_REQUEST_WORDS.diet).toMatch(/not medical advice/u);
    expect(BODY_REQUEST_WORDS.workout).toMatch(/not medical advice/u);
  });

  it('still says something with no readings chosen, when it says who the person is', () => {
    expect(text({ fields: [], about: { age: 36, gender: 'female' }, request: { kind: 'diet' } })).toBe(
      `Anna’s body:\nAbout: age 36 · gender female\n\n${BODY_REQUEST_WORDS.diet}`);
    expect(text({ fields: [], about: {} })).toBeUndefined();
  });

  it('counts the age in full years, and gives none for a date that is not a birth date', () => {
    expect(ageOn('1990-03-04', '2026-03-03')).toBe(35);
    expect(ageOn('1990-03-04', '2026-03-04')).toBe(36);
    expect(ageOn('2000-02-29', '2026-02-28')).toBe(25);
    expect(ageOn('2000-02-29', '2026-03-01')).toBe(26);
    for (const bad of ['1990-02-30', '1990-3-4', 'March 4', '2030-01-01']) expect(ageOn(bad, '2026-11-17'), bad).toBeUndefined();
  });
});

describe('⛔ D-339 slices 11 and 13 — the seam: the page sends the owner\'s message to the Body\'s conversation, and only that', () => {
  const route = readFileSync(new URL('../yours/bootstrap-yours-route.ts', import.meta.url), 'utf8');
  const bootstrap = readFileSync(new URL('../webclient-bootstrap.ts', import.meta.url), 'utf8');

  it('offers the button on a Body whose numbers wait for the owner, readings or none (slice 18), and lists the models as it opens', () => {
    expect(route).toMatch(/if \(options\.bodyChat && asset\.settings\.values_on_request === true && !pursuitPage\) \{\s+const bodyChat = options\.bodyChat;\s+const numbers = button\(assetHeader\.actions, 'Ask with the numbers',\s+loadEditor\(async \(\) => \(\{ type: 'ask_numbers', asset, sources: await bodyChat\.sources\(\) \}\)\)/u);
  });

  it('opens the conversation, keeps the approval on the Body, sends, and only then leaves the form for Chat', () => {
    // Slice 18: a typed weight or height is saved as a measurement before the approval is kept.
    const order = ['const conversation = await bodyChat.open(', 'await options.bodyMeasure.record(measured);',
      'const recorded = await options.change({ action: \'asset.update\', id: asset.id, patch });',
      'if (recorded.failed?.length) throw', 'await bodyChat.send({ session_id: conversation.session_id, text, source });',
      'editorIntent++; editor = undefined; dirty = false; editorReturnFocus = undefined;', 'bodyChat.openChat(conversation.session_id);'];
    const at = order.map((step) => route.indexOf(step));
    expect(at.every((index) => index > 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The approval is the Body's conversation and what went, under its own setting.
    expect(route).toMatch(/const patch: AssetPatch = \{ settings: \{ \[ASSET_CHAT_CONVERSATION\]: \{ session_id: conversation\.session_id, sent \} \} \};/u);
    // A setting the page lists apart from the Body's facts.
    expect(route).toMatch(/filter\(\(\[key\]\) => key !== ASSET_EXPECTED_PATTERNS && key !== ASSET_CHAT_CONVERSATION && key !== BODY_RANGES_SETTING\)/u);
  });

  it('sends the age, never the birth date: what about the person goes is built from the age alone', () => {
    const start = route.indexOf('const aboutNow = (): BodyNumbersAbout => {');
    const body = route.slice(start, route.indexOf('\n      };', start));
    expect(start).toBeGreaterThan(0);
    expect(body).toMatch(/const age = state\.birth \? ageOn\(state\.birth, today\) : undefined;/u);
    expect(body).toMatch(/\.\.\.\(state\.include\.age && age !== undefined \? \{ age \} : \{\}\)/u);
    // Nothing else in it names the birth date.
    expect(body.replace('const age = state.birth ? ageOn(state.birth, today) : undefined;', '')).not.toMatch(/birth/u);
  });

  it('wires the Body\'s chat to the real rpc and opens Chat at the conversation', () => {
    expect(bootstrap).toMatch(/bodyChat: createBodyChat\(\{\s+call: rpcConn\.call as unknown as BodyChatCall,\s+openChat: sessionId => navigateHash\(serializeChatSessionAddress\(\{ sessionId \}\)\),/u);
    expect(bootstrap).not.toMatch(/chatDraft: text =>/u);
  });
});
