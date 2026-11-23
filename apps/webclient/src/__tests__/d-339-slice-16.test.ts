/** D-339 slice 16 (D-339 §6) — the owner's own range for a reading, as the owner reads it: under
 *  the reading on the Body's page (where it sits, how often it was in it, and whether it is still right) and
 *  in "Ask with the numbers". It is kept on the Body (`settings.ranges`), never a pursuit.
 *
 *  The page is driven in real Chrome by `scripts/drives/d-339-ask-with-numbers-live.mjs`; here, the words
 *  and the seams the page builds them in. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rangeAskWords, rangeDaysWords, rangeDue, rangeLineWords, rangePlaceWords, rangeWords } from '../yours/body-goal-words.js';
import { bodyNumbersText } from '../yours/body-numbers-text.js';
import { readingDayDate } from '../yours/reading-words.js';

const NOW = new Date(2026, 10, 18, 9, 0, 0);
const TODAY = '2026-11-18';
const both = { low: 50, high: 52, unit: 'kg' };
const days = (values: readonly number[]) => values.map((value, ago) => ({ value, day: new Date(Date.UTC(2026, 10, 18 - ago)).toISOString().slice(0, 10) }));

describe('D-339 slice 16 — a range in the owner\'s words', () => {
  it('its bounds: both, at most, at least', () => {
    expect(rangeWords(both)).toBe('50–52 kg');
    expect(rangeWords({ high: 22, unit: '%' })).toBe('at most 22 %');
    expect(rangeWords({ low: 55, unit: 'kg' })).toBe('at least 55 kg');
  });

  it('where a value sits', () => {
    // One decimal, as the page shows every reading.
    expect([51, 52, 52.8, 49.3].map(value => rangePlaceWords(both, value))).toEqual(['in it', 'in it', '0.8 kg over it', '0.7 kg under it']);
  });

  it('how many of the last two weeks\' measured days were in it; fewer than two days say nothing', () => {
    // Today and 13 days back are inside; 14 back is not.
    const points = days([51, 53, 51.5, 49, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 40]);
    expect(rangeDaysWords(both, points, TODAY)).toBe('in it on 12 of the 14 days measured in the last two weeks');
    expect(rangeDaysWords(both, days([51]), TODAY)).toBeUndefined();
  });

  it('asks to be checked once set more than 180 days ago', () => {
    expect(rangeDue({ set_on: '2026-05-22' }, TODAY)).toBe(false);
    expect(rangeDue({ set_on: '2026-05-21' }, TODAY)).toBe(true);
  });

  it('under the reading: the range, where it sits, the two weeks; a reading in another unit says so instead', () => {
    expect(rangeLineWords('weight', both, { value: 52.8, unit: 'kg' }, days([52.8, 52.6, 51]), TODAY))
      .toBe('Your range 50–52 kg · 0.8 kg over it now · in it on 1 of the 3 days measured in the last two weeks');
    expect(rangeLineWords('weight', both, { value: 116, unit: 'lb' }, [], TODAY)).toBe('Your range 50–52 kg · the weight is in another unit now, so set the range again');
  });

  it('in Ask with the numbers: as the owner\'s own; one past its review with the day it was set', () => {
    expect(rangeAskWords('weight', both, NOW)).toBe('own range for weight 50–52 kg');
    expect(rangeAskWords('body_fat', { high: 22, unit: '%', set_on: '2026-03-02', due: true }, NOW))
      .toBe(`own range for body fat at most 22 % (set on ${readingDayDate('2026-03-02', NOW)}; not checked since)`);
    const text = bodyNumbersText('Anna’s body', [], { fields: [], days: 7, lenses: false, about: {
      weight: { value: 52.8, unit: 'kg', day: TODAY }, ranges: [{ reading: 'weight', ...both, set_on: '2026-11-01' }] } }, NOW.getTime())!;
    expect(text.split('\n')[1]).toBe(`About: weight 52.8 kg (${readingDayDate(TODAY, NOW)}) · own range for weight 50–52 kg`);
  });
});

describe('⛔ D-339 slice 16 — the seams on the page', () => {
  const route = readFileSync(new URL('../yours/bootstrap-yours-route.ts', import.meta.url), 'utf8');

  it('reads the range from the Body, on the readings a goal can have, and offers Set your range or Change range', () => {
    expect(route).toMatch(/const range = goalField \? readBodyRanges\(asset\.settings\)\[goalField\] : undefined;/u);
    expect(route).toMatch(/if \(goalField && reading\) button\(actions, range \? 'Change range' : 'Set your range'/u);
  });

  it('"Still right" sends the same ends again, so the server sets its day to today', () => {
    expect(route).toMatch(/button\(due, 'Still right', \(\) => change\(\{ action: 'range\.set', asset_id: asset\.id, reading: goalField, low: range\.low \?\? null, high: range\.high \?\? null \}\)/u);
  });

  it('the editor sends only the ends: the unit and the day are the server\'s', () => {
    const save = route.slice(route.indexOf("if (value.type === 'range') {"), route.indexOf("if (value.type === 'reading' || value.type === 'condition') {"));
    expect(save).toMatch(/action: 'range\.set', asset_id: value\.body_id, reading: value\.field, low: lowEnd, high: highEnd/u);
    expect(save).not.toMatch(/\b(?:unit|set_on)\s*:/u);
  });

  it('the Facts list leaves the ranges out, as they show under their readings', () => {
    expect(route).toMatch(/key !== ASSET_CHAT_CONVERSATION && key !== BODY_RANGES_SETTING/u);
  });

  it('Ask ticks the ranges to start, unless one is past its review', () => {
    expect(route).toMatch(/goals: true, ranges: !ranges\.some\(range => range\.due\) \}/u);
    expect(route).toMatch(/\.\.\.\(state\.include\.ranges && ranges\.length > 0 \? \{ ranges \} : \{\}\),/u);
  });
});
