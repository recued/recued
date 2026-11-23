/** D-339 slice 14 (D-339 §6) — which of a Body's readings have probably changed since they
 *  were measured: a body measure whose weight has moved since, anything past its days, and a child's
 *  height. The page shows why beside each; Ask with the numbers starts it unticked. */
import { describe, expect, it } from 'vitest';
import type { AssetReading } from '@recued/contracts';
import { STALE_SETTINGS, assetReadingStaleness } from '../situations/asset-reading-staleness.js';

const DAY = 86_400_000;
const now = Date.parse('2026-11-18T15:00:00Z');
const day = (ago: number) => new Date(now - ago * DAY).toISOString().slice(0, 10);
/** A reading for a day, citing that day as a Body signals row does. */
const on = (ago: number, value: number, unit: string): AssetReading =>
  ({ value, unit, as_of: Date.parse(`${day(ago)}T08:00:00Z`), evidence: [{ collection: 'body-signals.daily_metric', id: `r${String(ago)}`, field: 'day', value: day(ago) }] });
const weights = (samples: Array<[number, number]>, unit = 'kg') => () => samples.map(([ago, value]) => ({ ...on(ago, value, unit), day: day(ago) }));
const settings = { values_on_request: true };
const stale = (readings: Record<string, AssetReading | null>, history = weights([]), extra: Record<string, unknown> = {}, dates: Record<string, string> = {}) =>
  assetReadingStaleness({ readings, dates, settings: { ...settings, ...extra } }, history, now, 'UTC');

describe('D-339 slice 14 — a body measure goes with its weight', () => {
  it('has probably changed once the weight weighed after it has moved by 2 kg', () => {
    const out = stale({ body_fat: on(40, 24, '%'), weight: on(0, 58, 'kg') }, weights([[0, 58], [40, 62], [45, 62.4]]));
    expect(out).toEqual([{ field: 'body_fat', reason: 'weight_moved', day: day(40), days_old: 40,
      weight_then: { value: 62, unit: 'kg' }, weight_now: { value: 58, unit: 'kg' } }]);
  });

  it('holds while the weight holds, until its days run out', () => {
    expect(stale({ body_fat: on(40, 24, '%'), weight: on(0, 61, 'kg') }, weights([[0, 61], [40, 62]]))).toEqual([]);
    expect(stale({ lean_body_mass: on(100, 45, 'kg'), weight: on(0, 61, 'kg') }, weights([[0, 61], [100, 61.5]])))
      .toEqual([{ field: 'lean_body_mass', reason: 'too_old', day: day(100), days_old: 100 }]);
  });

  it('is fresh when it was measured after the latest weight, or on its day', () => {
    expect(stale({ body_fat: on(2, 24, '%'), weight: on(5, 58, 'kg') }, weights([[5, 58], [30, 62]]))).toEqual([]);
    expect(stale({ waist: on(0, 80, 'cm'), weight: on(0, 58, 'kg') }, weights([[0, 58], [30, 62]]))).toEqual([]);
    // The Body's weight was weighed before it: whatever else the history holds (another source's newer
    // sample), the weight it shows has not moved since.
    expect(stale({ body_fat: on(2, 24, '%'), weight: on(5, 58, 'kg') }, weights([[3, 62], [5, 58]]))).toEqual([]);
  });

  it('reads a weight in pounds as one in kilograms', () => {
    // 136.7 lb is 62.0 kg, 127.9 lb is 58.0 kg.
    const out = stale({ body_fat: on(40, 24, '%'), weight: on(0, 127.9, 'lb') }, weights([[0, 127.9], [40, 136.7]], 'lb'));
    expect(out[0]).toMatchObject({ field: 'body_fat', reason: 'weight_moved', weight_then: { value: 136.7, unit: 'lb' } });
  });

  it('with no weight from its fortnight, or a history it cannot read, only its days count', () => {
    expect(stale({ body_fat: on(40, 24, '%'), weight: on(0, 58, 'kg') }, weights([[0, 58]]))).toEqual([]);
    const unreadable = () => { throw new Error('Records is closed'); };
    expect(stale({ body_fat: on(100, 24, '%'), weight: on(0, 58, 'kg') }, unreadable))
      .toEqual([{ field: 'body_fat', reason: 'too_old', day: day(100), days_old: 100 }]);
  });
});

describe('D-339 slice 14 — weight and height', () => {
  it('a weight is stale past 30 days', () => {
    expect(stale({ weight: on(30, 60, 'kg') })).toEqual([]);
    expect(stale({ weight: on(31, 60, 'kg') })).toEqual([{ field: 'weight', reason: 'too_old', day: day(31), days_old: 31 }]);
  });

  it('a height changes only for someone under 18', () => {
    const height = { height: on(200, 160, 'cm') };
    expect(stale(height, weights([]), {}, { birth_date: '2011-03-04' })).toEqual([{ field: 'height', reason: 'growing', day: day(200), days_old: 200 }]);
    expect(stale(height, weights([]), {}, { birth_date: '1990-03-04' })).toEqual([]);
    expect(stale(height)).toEqual([]);
  });
});

describe('D-339 slice 14 — the owner\'s settings, kept within their bounds', () => {
  it('reads each, and a value it cannot read is the default', () => {
    const moved = (extra: Record<string, unknown>) => stale({ body_fat: on(40, 24, '%'), weight: on(0, 58, 'kg') }, weights([[0, 58], [40, 62]]), extra);
    expect(moved({ stale_weight_change_kg: 5 })).toEqual([]);
    expect(moved({ stale_weight_change_kg: 'a lot' })[0]?.reason).toBe('weight_moved');
    expect(stale({ weight: on(10, 60, 'kg') }, weights([]), { stale_weight_days: 7 })[0]?.reason).toBe('too_old');
    // Bounded: 1 day is read as the least, 7.
    expect(stale({ weight: on(5, 60, 'kg') }, weights([]), { stale_weight_days: 1 })).toEqual([]);
    expect(STALE_SETTINGS.stale_weight_days).toEqual({ fallback: 30, min: 7, max: 365 });
  });
});
