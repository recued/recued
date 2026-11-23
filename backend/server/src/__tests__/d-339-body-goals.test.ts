/** D-339 slice 15 (D-339 §6) — a body goal's progress, worked out from its Body: what is left,
 *  the week's average that says it looks reached, and the pace that says how long at this rate. The Body's
 *  own lenses (slice 9) give the average and the trend; here, what the goal makes of them. */
import { describe, expect, it } from 'vitest';
import type { AssetReading, BodyGoal } from '@recued/contracts';
import { bodyGoalProgress } from '../situations/body-goals.js';

const ZONE = 'UTC';
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-18T12:00:00Z');
const dayOf = (ago: number) => new Date(NOW - ago * DAY).toISOString().slice(0, 10);
const pursuit = { id: 'goal-1', name: "Weight goal · Anna's body", dates: { target_on: '2027-06-01' } };
const down: BodyGoal = { asset_id: 'body-1', reading: 'weight', target: 57, unit: 'kg', start: 62, start_day: '2026-10-01' };
/** A Body whose weight is `latest`, today. */
const body = (latest: number, unit = 'kg') => ({ status: 'active' as const, settings: {}, deleted_at: null,
  readings: { weight: { value: latest, unit, as_of: NOW - 3_600_000, evidence: [] } } });
/** A sample a day, `values[0]` today, each on its day, as the Body's days in Records are. */
const days = (values: readonly number[], unit = 'kg') => (_field: string): Array<AssetReading & { day: string }> =>
  values.map((value, ago) => ({ value, unit, as_of: NOW - ago * DAY - 3_600_000, evidence: [], day: dayOf(ago) }));

describe('D-339 slice 15 — a body goal\'s progress', () => {
  it('losing toward it: what is left, the pace toward it, and the weeks that leaves', () => {
    // 21 days falling 0.1 kg a day, from 60.0 to 58.0 today: 0.7 kg a week toward 57.
    const values = Array.from({ length: 21 }, (_, ago) => Math.round((58 + ago * 0.1) * 10) / 10);
    const progress = bodyGoalProgress(pursuit, down, body(58), days(values), NOW, ZONE);
    expect(progress).toMatchObject({ pursuit_id: 'goal-1', name: "Weight goal · Anna's body", target_on: '2027-06-01', way: 'down',
      now: { value: 58, day: dayOf(0) }, to_go: 1, reached: false });
    expect(progress.per_week).toBeCloseTo(0.7, 1);
    expect(progress.weeks_left).toBeCloseTo(1 / 0.7, 1);
    expect(progress.week).toEqual({ value: expect.closeTo(58.3, 2), days: 7 });
  });

  it('gaining toward a goal above where it started reads the same way up', () => {
    const up: BodyGoal = { ...down, reading: 'weight', target: 65, start: 60 };
    const values = Array.from({ length: 21 }, (_, ago) => Math.round((62 - ago * 0.1) * 10) / 10);
    const progress = bodyGoalProgress(pursuit, up, body(62), days(values), NOW, ZONE);
    expect(progress).toMatchObject({ way: 'up', to_go: 3, reached: false });
    expect(progress.per_week).toBeCloseTo(0.7, 1);
    expect(progress.weeks_left).toBeCloseTo(3 / 0.7, 1);
  });

  it('moving away: the pace is below 0 and leaves no weeks', () => {
    const values = Array.from({ length: 21 }, (_, ago) => Math.round((58 - ago * 0.1) * 10) / 10);
    const progress = bodyGoalProgress(pursuit, down, body(58), days(values), NOW, ZONE);
    expect(progress.per_week).toBeLessThan(0);
    expect(progress.weeks_left).toBeUndefined();
  });

  it('looks reached on the week\'s average, not on one day: a light day in a heavy week is not it', () => {
    const light = bodyGoalProgress(pursuit, down, body(56.8), days([56.8, 58, 58.2, 58.1, 57.9, 58, 58.3]), NOW, ZONE);
    expect(light).toMatchObject({ to_go: 0, reached: false });
    const held = bodyGoalProgress(pursuit, down, body(56.8), days([56.8, 56.9, 57, 56.7, 57.1, 56.6, 56.9]), NOW, ZONE);
    expect(held).toMatchObject({ to_go: 0, reached: true, week: { days: 7 } });
  });

  it('three days of the last seven are not a week: no average, so not reached', () => {
    const progress = bodyGoalProgress(pursuit, down, body(56), days([56, 56, 56]), NOW, ZONE);
    expect(progress.week).toBeUndefined();
    expect(progress.reached).toBe(false);
  });

  it('says why there is nothing: a reading in another unit, none, or a Body that is gone', () => {
    expect(bodyGoalProgress(pursuit, down, body(130, 'lb'), days([130], 'lb'), NOW, ZONE)).toMatchObject({ problem: 'other_unit', reached: false });
    expect(bodyGoalProgress(pursuit, down, { ...body(58), readings: { weight: null } }, days([]), NOW, ZONE)).toMatchObject({ problem: 'no_value' });
    expect(bodyGoalProgress(pursuit, down, { ...body(58), status: 'retired' as never }, days([58]), NOW, ZONE)).toMatchObject({ problem: 'body_gone' });
    expect(bodyGoalProgress(pursuit, down, null, days([58]), NOW, ZONE)).toMatchObject({ problem: 'body_gone' });
    expect(bodyGoalProgress(pursuit, down, { ...body(58), deleted_at: NOW }, days([58]), NOW, ZONE)).toMatchObject({ problem: 'body_gone' });
  });
});
