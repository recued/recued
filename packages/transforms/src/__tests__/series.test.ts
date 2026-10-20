import { describe, expect, it } from 'vitest';
import { getTransform, getTransformSchema, held, transitions, window_change, within_distance } from '../index.js';
import { ctx } from './helpers.js';

const context = ctx();
const base = { time_field: 'at', state_field: 'state', now: 1000 };

describe('D-325 shared series arithmetic', () => {
  it('is registered for recipes with schemas', () => {
    for (const name of ['held', 'transitions', 'window_change', 'within_distance']) {
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
