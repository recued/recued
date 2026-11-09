import { describe, expect, it } from 'vitest';
import { baseline, getTransform, getTransformSchema, held, transitions, window_change, within_distance } from '../index.js';
import { ctx } from './helpers.js';

const context = ctx();
const base = { time_field: 'at', state_field: 'state', now: 1000 };

describe('D-325 shared series arithmetic', () => {
  it('is registered for recipes with schemas', () => {
    for (const name of ['held', 'transitions', 'window_change', 'baseline', 'within_distance']) {
      expect(getTransform(name)).toBeTypeOf('function');
      expect(getTransformSchema(name)?.rows).toEqual({ required: true, type: 'array' });
    }
  });
  it('holds a state from its actual last change, sorts copies, and returns evidence', () => {
    const rows = [{ at: 700, state: 'off' }, { at: 0, state: 'on' }, { at: 400, state: 'off' }];
    const original = structuredClone(rows);
    expect(held({ ...base, rows, hold_ms: 600 }, context)).toEqual({
      status: 'settled', value: 'off', since: 400, evidence: [rows[1], rows[2], rows[0]],
    });
    expect(held({ ...base, rows, hold_ms: 601 }, context)).toMatchObject({ status: 'pending' });
    expect(rows).toEqual(original);
  });
  it('never settles a single sample, guesses a state, or breaks equal-time ties by order', () => {
    expect(held({ ...base, rows: [], hold_ms: 50 }, context)).toMatchObject({ status: 'unknown', value: null });
    expect(held({ ...base, rows: [{ at: 0, state: false }], hold_ms: 50 }, context)).toMatchObject({ status: 'pending', value: false });
    expect(held({ ...base, rows: [{ at: 0, state: 1 }, { at: 0, state: 2 }], hold_ms: 0 }, context)).toMatchObject({ status: 'unknown' });
  });
  it('counts changes inside the window using its predecessor, excludes future rows', () => {
    const rows = [{ at: 800, state: 1 }, { at: 1100, state: 1 }, { at: 400, state: 0 }, { at: 600, state: 1 }, { at: 700, state: 0 }];
    expect(transitions({ ...base, rows, window_ms: 500, min_count: 3 }, context)).toMatchObject({
      count: 3, flickering: true, first_change: 600, last_change: 800,
      evidence: [rows[2], rows[3], rows[4], rows[0]],
    });
    expect(transitions({ ...base, rows: [rows[3]], window_ms: 500, min_count: 3 }, context)).toMatchObject({ count: null, flickering: 'unknown' });
    // An incompletely observed window proves a positive, but cannot prove no flicker.
    expect(transitions({ ...base, rows: [rows[3], rows[4]], window_ms: 500, min_count: 3 }, context)).toMatchObject({ count: 1, flickering: 'unknown' });
  });
  it('computes a price move only from distinct in-window numeric points', () => {
    const rows = [{ at: 900, price: 82 }, { at: 500, price: 100 }, { at: 0, price: 1 }];
    expect(window_change({ ...base, rows, value_field: 'price', window_ms: 500 }, context)).toEqual({
      status: 'known', percent_change: -18, from: { value: 100, at: 500 }, to: { value: 82, at: 900 }, evidence: [rows[1], rows[0]],
    });
    for (const points of [[], [{ at: 500, price: 100 }], [{ at: 500, price: 0 }, { at: 900, price: 5 }], [{ at: 500, price: '100' }, { at: 900, price: 5 }]]) {
      expect(window_change({ ...base, rows: points, value_field: 'price', window_ms: 500 }, context)).toMatchObject({ status: 'unknown', percent_change: null });
    }
  });
  it('uses explicit nested fields and does not depend on context.now', () => {
    const row = (at: string, state: boolean) => ({ event: { timestamp: at, state } });
    const rows = [row('2026-10-17T00:00:00Z', false), row('2026-10-17T00:00:01Z', true)];
    expect(held({ rows, time_field: 'event.timestamp', state_field: 'event.state', hold_ms: 1000, now: Date.parse('2026-10-17T00:00:03Z') }, context)).toMatchObject({ status: 'settled', value: true });
  });
  it('finds nearby rows across the dateline and retains the deciding rows', () => {
    const near = { loc: { lat: 0, lon: -179.99 } };
    const far = { loc: { lat: 0, lon: 170 } };
    const args = { place: { latitude: 0, longitude: 179.99 }, rows: [far, near], latitude_field: 'loc.lat', longitude_field: 'loc.lon', radius_km: 5 };
    const result = within_distance(args, context);
    expect(result).toMatchObject({ status: 'known', nearest_km: expect.closeTo(2.2239, 3), matches: [{ row: near }], evidence: [near] });
    expect(within_distance({ ...args, rows: [{ loc: { lat: 91, lon: 0 } }] }, context)).toMatchObject({ status: 'unknown', nearest_km: null });
    expect(within_distance({ ...args, place: { latitude: 91, longitude: 0 } }, context)).toMatchObject({ status: 'unknown' });
  });
});

describe('D-339 baseline: the latest value against its own usual', () => {
  const args = { time_field: 'at', value_field: 'value', now: 1000, window_ms: 900, min_count: 7 };
  // Seven earlier nights inside the window [100, 1000], the latest at 900, one before the
  // window and one in the future: neither may join the usual.
  const earlier = [50, 52, 48, 51, 49, 53, 47].map((value, i) => ({ at: 200 + i * 100, value }));
  const latest = { at: 900, value: 40 };
  const rows = [latest, { at: 50, value: 999 }, ...earlier.slice().reverse(), { at: 1100, value: 1 }];

  it('compares the latest with the median and MAD of the earlier samples, never itself', () => {
    const original = structuredClone(rows);
    expect(baseline({ ...args, rows }, context)).toEqual({
      status: 'known', latest: { value: 40, at: 900 }, median: 50, mad: 2, count: 7,
      difference: -10, percent_difference: -20, evidence: [...earlier, latest],
    });
    expect(rows).toEqual(original);
  });
  it('takes the mean of the middle two for an even count', () => {
    const six = [1, 2, 3, 4, 5, 6].map((value, i) => ({ at: 200 + i * 100, value }));
    expect(baseline({ ...args, min_count: 6, rows: [...six, { at: 900, value: 7 }] }, context))
      .toMatchObject({ status: 'known', median: 3.5, mad: 1.5, difference: 3.5, percent_difference: 100 });
  });
  it('is unknown with too few earlier samples, still saying how many and what the latest is', () => {
    expect(baseline({ ...args, min_count: 8, rows }, context)).toEqual({
      status: 'unknown', latest: { value: 40, at: 900 }, median: null, mad: null, count: 7,
      difference: null, percent_difference: null, evidence: [...earlier, latest],
    });
  });
  it('is unknown when the latest is older than max_age_ms', () => {
    expect(baseline({ ...args, rows, max_age_ms: 99 }, context)).toEqual({
      status: 'unknown', latest: { value: 40, at: 900 }, median: null, mad: null, count: null,
      difference: null, percent_difference: null, evidence: [latest],
    });
    expect(baseline({ ...args, rows, max_age_ms: 100 }, context)).toMatchObject({ status: 'known', median: 50 });
  });
  it('gives no percentage over a usual of 0, but still the difference', () => {
    const zeros = [0, 0, 0, 1, 0, 0, 0].map((value, i) => ({ at: 200 + i * 100, value }));
    expect(baseline({ ...args, rows: [...zeros, { at: 900, value: 2 }] }, context))
      .toMatchObject({ status: 'known', median: 0, difference: 2, percent_difference: null });
  });
  it('skips values that are not numbers and times that are not instants', () => {
    const text = { at: 850, value: '45' };
    expect(baseline({ ...args, rows: [...rows, text] }, context)).toMatchObject({ count: 7, median: 50 });
    // A bare date is not an instant: the rows need the day's start as one (D-339 §3.4).
    const days = earlier.map((row, i) => ({ day: `2026-11-0${i + 1}`, value: row.value }));
    expect(baseline({ ...args, time_field: 'day', rows: days }, context)).toMatchObject({ status: 'unknown', latest: null });
    const iso = [...earlier, latest].map(row => ({ day_start: new Date(row.at * 1000).toISOString(), value: row.value }));
    expect(baseline({ ...args, time_field: 'day_start', now: 1000 * 1000, window_ms: 900 * 1000, rows: iso }, context))
      .toMatchObject({ status: 'known', median: 50, difference: -10 });
  });
  it('refuses bad arguments and equal-time conflicts instead of guessing', () => {
    for (const bad of [{ window_ms: 0 }, { min_count: 0 }, { min_count: 1.5 }, { value_field: '' }, { max_age_ms: -1 }, { now: undefined }]) {
      expect(baseline({ ...args, rows, ...bad }, context)).toMatchObject({ status: 'unknown', latest: null, count: null });
    }
    expect(baseline({ ...args, rows: [...rows, { at: 900, value: 41 }] }, context)).toMatchObject({ status: 'unknown', latest: null });
    // The same value twice at one time is one sample, not a conflict.
    expect(baseline({ ...args, rows: [...rows, { ...latest }] }, context)).toMatchObject({ status: 'known', count: 7 });
  });
  it('compares each series only with its own history, sorted by its key', () => {
    const series = (metric: string, source: string, values: number[]) =>
      values.map((value, i) => ({ at: 200 + i * 100, metric, source, value }));
    const oura = series('hrv_rmssd', 'oura', [50, 52, 48, 51, 49, 53, 47, 40]);
    const apple = series('hrv_sdnn', 'apple_health', [30, 31, 29, 30, 32, 28, 30, 33]);
    const conflict = [{ at: 900, metric: 'steps', source: 'apple_health', value: 1 }, { at: 900, metric: 'steps', source: 'apple_health', value: 2 }];
    const result = baseline({ ...args, rows: [...oura, { at: 300, metric: 'hrv_rmssd', value: 1 }, ...apple, ...conflict], series_fields: ['metric', 'source'] }, context);
    expect(result).toMatchObject([
      { series: { metric: 'hrv_rmssd', source: 'oura' }, status: 'known', median: 50, percent_difference: -20 },
      { series: { metric: 'hrv_sdnn', source: 'apple_health' }, status: 'known', median: 30, percent_difference: 10 },
      { series: { metric: 'steps', source: 'apple_health' }, status: 'unknown', latest: null },
    ]);
    expect(result).toHaveLength(3);
    for (const bad of [[], [''], 'metric', [1]]) {
      expect(baseline({ ...args, rows: oura, series_fields: bad }, context)).toEqual([]);
    }
  });
});
