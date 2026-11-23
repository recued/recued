/** D-339 slice 14 (D-339 §6) — everything Apple Health can send, on the Body's page: BMI
 *  worked out from the latest height and weight (never stored, so as current as they are), WHO's adult
 *  range beside it, the new readings' names, and the readings with no value yet folded on a Body.
 *
 *  The page is driven in real Chrome by `scripts/drives/d-339-ask-with-numbers-live.mjs`; here, the
 *  arithmetic, the words, and the seams the page builds them in. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WHO_ADULT_BMI, bodyMassIndex, bodyNumbersText, staleWords } from '../yours/body-numbers-text.js';
import { assetFieldName, readingDayDate } from '../yours/reading-words.js';

describe('D-339 slice 14 — BMI from a height and a weight', () => {
  it('is weight over height squared, to one decimal, from cm and kg or from inches and pounds', () => {
    expect(bodyMassIndex({ value: 168, unit: 'cm' }, { value: 61, unit: 'kg' })).toBe(21.6);
    expect(bodyMassIndex({ value: 1.68, unit: 'm' }, { value: 61, unit: 'kg' })).toBe(21.6);
    // 66 in and 134.5 lb are 167.6 cm and 61.0 kg.
    expect(bodyMassIndex({ value: 66, unit: 'in' }, { value: 134.5, unit: 'lb' })).toBe(21.7);
  });

  it('is nothing without both, or in a unit it cannot read', () => {
    expect(bodyMassIndex(null, { value: 61, unit: 'kg' })).toBeUndefined();
    expect(bodyMassIndex({ value: 168, unit: 'cm' }, undefined)).toBeUndefined();
    expect(bodyMassIndex({ value: 168, unit: 'cm' }, { value: 9.6, unit: 'st' })).toBeUndefined();
    expect(bodyMassIndex({ value: 0, unit: 'cm' }, { value: 61, unit: 'kg' })).toBeUndefined();
    expect(bodyMassIndex({ value: Number.NaN, unit: 'cm' }, { value: 61, unit: 'kg' })).toBeUndefined();
  });

  it('WHO\'s healthy range is an adult\'s', () => {
    expect(WHO_ADULT_BMI).toEqual({ low: 18.5, high: 24.9, from_age: 18 });
  });

  it('goes in the message\'s About line after the weight', () => {
    const text = bodyNumbersText('Anna’s body', [], { fields: [], days: 7, lenses: false,
      about: { age: 36, height: { value: 168, unit: 'cm' }, weight: { value: 61, unit: 'kg' }, bmi: 21.6, gender: 'female' } }, Date.now());
    expect(text!.split('\n')[1]).toBe('About: age 36 · height 168 cm · weight 61 kg · BMI 21.6 · gender female');
  });
});

describe('D-339 slice 14 — the new readings in the owner\'s words', () => {
  it('names each as the guide does', () => {
    expect(assetFieldName('blood_glucose')).toBe('Blood sugar');
    expect(assetFieldName('blood_pressure_systolic')).toBe('Blood pressure (systolic)');
    expect(assetFieldName('exercise_minutes')).toBe('Exercise');
    expect(assetFieldName('body_fat')).toBe('Body fat');
    expect(assetFieldName('lean_body_mass')).toBe('Lean body mass');
  });
});

describe('⛔ D-339 slice 14 — the seams on the Body\'s page', () => {
  const route = readFileSync(new URL('../yours/bootstrap-yours-route.ts', import.meta.url), 'utf8');

  it('folds the readings with no value yet on a Body only, after the rest', () => {
    // Slice 15: a goal pursuit holds its values as its Body does, yet is not one.
    expect(route).toMatch(/const isBody = asset\.settings\.values_on_request === true && !isPursuit\(asset\);/u);
    expect(route).toMatch(/const unset = isBody && unknownReadings > 0 \? el\('details'\) : undefined;/u);
    expect(route).toMatch(/card\(!reading && unset \? unset : readings, /u);
    // Placed once the readings and the BMI are in, before the conditions.
    expect(route.indexOf('if (unset) readings.append(unset);')).toBeGreaterThan(route.indexOf("const item = card(readings, 'BMI');"));
    expect(route.indexOf('if (unset) readings.append(unset);')).toBeLessThan(route.indexOf('for (const [name, observation] of Object.entries(asset.observations))'));
  });

  it('shows BMI on a Body from its latest height and weight, and WHO\'s range only for an adult or a Body with no birth date', () => {
    expect(route).toMatch(/const bmi = isBody \? bodyMassIndex\(asset\.readings\.height \?\? null, asset\.readings\.weight \?\? null\) : undefined;/u);
    expect(route).toMatch(/if \(age === undefined \|\| age >= WHO_ADULT_BMI\.from_age\) el\('small', `WHO's healthy range for adults/u);
  });

  it('offers the BMI in Ask with the numbers, worked out from the height and weight the form holds', () => {
    expect(route).toMatch(/const bmi = bodyMassIndex\(height === undefined \? null : \{ value: height, unit: 'cm' \}, weight \?\? null\);/u);
    expect(route).toMatch(/\.\.\.\(state\.include\.bmi && bmi !== undefined \? \{ bmi \} : \{\}\),/u);
  });
});

describe('D-339 slice 14 — what has probably changed, and why', () => {
  const now = new Date(2026, 10, 18, 9, 0, 0);
  it('says why, as the page and the form say it', () => {
    expect(staleWords({ field: 'body_fat', reason: 'weight_moved', day: '2026-11-17', days_old: 1,
      weight_then: { value: 62, unit: 'kg' }, weight_now: { value: 58.1, unit: 'kg' } }, now))
      .toBe(`Measured ${readingDayDate('2026-11-17', now)} at 62 kg. You weigh 58.1 kg now, so it has probably changed.`);
    expect(staleWords({ field: 'weight', reason: 'too_old', day: '2026-10-14', days_old: 35 }, now)).toBe('Last weighed 35 days ago.');
    expect(staleWords({ field: 'lean_body_mass', reason: 'too_old', day: '2026-08-10', days_old: 100 }, now)).toBe('Measured 100 days ago, so it has probably changed.');
    expect(staleWords({ field: 'height', reason: 'growing', day: '2026-04-01', days_old: 231 }, now)).toBe('Measured 231 days ago. Height still changes before 18.');
  });

  it('sends a body measure with its day, and one that has probably changed with the weight it was taken at', () => {
    const text = bodyNumbersText('Anna’s body', [], { fields: [], days: 7, lenses: false, about: {
      weight: { value: 58, unit: 'kg', day: '2026-11-18' },
      measures: [{ field: 'body_fat', value: 26, unit: '%', day: '2026-11-17', stale: { weight_then: { value: 62, unit: 'kg' } } },
        { field: 'waist', value: 80, unit: 'cm', day: '2026-11-17' }] } }, now.getTime())!;
    expect(text.split('\n')[1]).toBe(`About: weight 58 kg (${readingDayDate('2026-11-18', now)}) · body fat 26 % (${readingDayDate('2026-11-17', now)}, at 62 kg; probably changed) · waist 80 cm (${readingDayDate('2026-11-17', now)})`);
  });

  it('marks a stale weight, and a child\'s height, the same way', () => {
    const text = bodyNumbersText('Anna’s body', [], { fields: [], days: 7, lenses: false, about: {
      height: { value: 150, unit: 'cm', day: '2026-04-01', stale: {} }, weight: { value: 61, unit: 'kg', day: '2026-10-14', stale: {} } } }, now.getTime())!;
    expect(text.split('\n')[1]).toBe(`About: height 150 cm (${readingDayDate('2026-04-01', now)}; probably changed) · weight 61 kg (${readingDayDate('2026-10-14', now)}; probably changed)`);
  });
});

describe('⛔ D-339 slice 14 — the seams for what has probably changed', () => {
  const route = readFileSync(new URL('../yours/bootstrap-yours-route.ts', import.meta.url), 'utf8');
  it('notes it under the reading on the page, from the server\'s list for this Body', () => {
    expect(route).toMatch(/const stale = snapshot\?\.reading_staleness\?\.asset_id === asset\.id \? snapshot\.reading_staleness\.readings\.find\(row => row\.field === name\) : undefined;\s+if \(reading && stale\) \{ const note = el\('p', staleWords\(stale, new Date\(\)\), item\);/u);
  });
  it('starts it unticked in Ask with the numbers: the weight, the BMI from it, the height, each body measure', () => {
    expect(route).toMatch(/include: \{ age: true, height: !staleOf\('height'\), weight: !staleOf\('weight'\), bmi: !staleOf\('weight'\), gender: true,\s+\.\.\.Object\.fromEntries\(BODY_MEASURE_FIELDS\.map\(field => \[field, !staleOf\(field\)\]\)\), goals: true, ranges: !ranges\.some\(range => range\.due\) \}/u);
  });
});

