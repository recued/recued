/** Map apply-mode value-param injection (s13 fix round) — pins the heal of
 *  the silent param-mismatch class plus the hint-aware interpolation.
 *
 *  Before this round, apply mode injected the per-item field value as
 *  `from` whenever `field` was set. Only `date_diff` reads `from`; every
 *  other shipped target computed on undefined: `compare` attached false
 *  constants, `switch` always took its default, `is_past` / `date_format`
 *  attached null. The shared APPLY_VALUE_PARAM table (schemas.ts) now
 *  routes the value to each target's real param — these tests would have
 *  caught the original bug and pin the heal per target.
 */
import { describe, it, expect } from 'vitest';
import {
  APPLY_VALUE_PARAM,
  TRANSFORM_SCHEMAS,
  getTransform,
} from '../index.js';
import type { TransformContext } from '../types.js';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const ctx = { now: () => NOW, getTransform } as unknown as TransformContext;
const map = getTransform('map')!;

const day = (offset: number): string =>
  new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

describe('apply-mode value-param injection (the heal pins)', () => {
  it('compare receives the value as `left` — flags compute correctly', () => {
    const r = map({
      array: [{ revenue: 5_000_000 }, { revenue: 200_000 }],
      apply: 'compare', field: 'revenue',
      operator: 'greater_or_equal', value: 1_000_000, output_field: 'is_big',
    } as never, ctx) as Array<{ is_big: boolean }>;
    expect(r.map((x) => x.is_big)).toEqual([true, false]);
  });

  it('switch receives the value as `input` — cases match instead of defaulting', () => {
    const r = map({
      array: [{ region: 'emea' }, { region: 'apac' }],
      apply: 'switch', field: 'region',
      cases: { emea: 'Europe', amer: 'Americas' }, default: 'Other',
      output_field: 'region_name',
    } as never, ctx) as Array<{ region_name: string }>;
    expect(r.map((x) => x.region_name)).toEqual(['Europe', 'Other']);
  });

  it('is_past receives the value as `date` — real booleans, not null', () => {
    const r = map({
      array: [{ close_date: day(-5) }, { close_date: day(+30) }],
      apply: 'is_past', field: 'close_date', output_field: '_is_expired',
    } as never, ctx) as Array<{ _is_expired: boolean }>;
    expect(r.map((x) => x._is_expired)).toEqual([true, false]);
  });

  it('date_format receives the value as `date` — month buckets render', () => {
    const r = map({
      array: [{ close_date: '2026-07-21' }],
      apply: 'date_format', field: 'close_date', format: 'YYYY-MM',
      output_field: 'close_month',
    } as never, ctx) as Array<{ close_month: string }>;
    expect(r[0].close_month).toBe('2026-07');
  });

  it('date_diff keeps its `from` injection — days-since semantics unchanged', () => {
    const r = map({
      array: [{ last_activity_date: day(-45) }, { close_date_only: 'x' }],
      apply: 'date_diff', field: 'last_activity_date', to: 'now', unit: 'days',
      output_field: '_days_inactive',
    } as never, ctx) as Array<{ _days_inactive: number | null }>;
    expect(r[0]._days_inactive).toBe(45);
  });

  it('pins the APPLY_VALUE_PARAM table exactly, and every entry names a declared schema param (drift guard)', () => {
    // Exact-content pin: silently DELETING an exception entry (so the
    // target falls back to `input`) is the original bug shape — it must
    // fail here, not surface as nulls downstream.
    expect(APPLY_VALUE_PARAM).toEqual({
      date_diff: 'from',
      date_add: 'date',
      date_format: 'date',
      is_past: 'date',
      is_future: 'date',
      compare: 'left',
    });
    for (const [target, param] of Object.entries(APPLY_VALUE_PARAM)) {
      expect(TRANSFORM_SCHEMAS[target], `schema for ${target}`).toBeDefined();
      expect(
        Object.prototype.hasOwnProperty.call(TRANSFORM_SCHEMAS[target], param),
        `${target} declares "${param}"`,
      ).toBe(true);
    }
  });
});

describe('expression-string format hints (Case 1 / Case 2.5)', () => {
  it('interpolation applies a `:currency` hint (pre-fix the hinted ref survived as literal braces)', () => {
    const r = map({
      array: [{ close_month: '2026-06', raw_total: 173000 }],
      expression: '{{item.close_month}}: raw={{item.raw_total:currency}}',
    } as never, ctx) as string[];
    // Locale-stable: compute the expectation with the SAME formatter the
    // engine's formatHint uses (system locale, USD) — hard-coding "$173,000.00"
    // would flake on non-en-US machines.
    const expected = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(173000);
    expect(r[0]).toBe(`2026-06: raw=${expected}`);
    expect(r[0]).not.toContain('{{');
  });

  it('a pure single hinted ref preserves type and ignores the hint (value-system rule)', () => {
    const r = map({
      array: [{ raw_total: 173000 }],
      expression: '{{item.raw_total:currency}}',
    } as never, ctx) as number[];
    expect(r[0]).toBe(173000);
  });

  it('math expressions still evaluate after a prior interpolation call (global-regex lastIndex guard)', () => {
    // Guards the CURRENT structure, not a shipped bug: since the hint-aware
    // rewrite, Case 2.5 no longer resets ITEM_REF_RE (it uses the hinted
    // variant), so the Case-2 math gate's own `lastIndex = 0` reset is the
    // ONLY thing keeping the global regex coherent across calls.
    //
    // Order matters: the global regex's inherited lastIndex from EARLIER
    // tests could make the poison call below miss past-end and auto-reset
    // (a self-cancelling poison — the un-mutated and mutated runs would
    // both pass). The no-ref normalizer call forces a guaranteed miss →
    // lastIndex 0, so the poison call then deterministically ADVANCES it.
    // Without the gate reset the math call's .test() starts mid-string,
    // misses its ref, and the expression degrades to the interpolated
    // string "21 * 2". (Mutation-verified: removing the gate reset fails
    // exactly this test.)
    map({ array: [{ x: 1 }], expression: 'no refs here' } as never, ctx);

    const first = map({
      array: [{ note: 'hello' }],
      expression: 'say {{item.note}}',
    } as never, ctx) as string[];
    expect(first[0]).toBe('say hello');

    const second = map({
      array: [{ amount: 21 }],
      expression: '{{item.amount}} * 2',
    } as never, ctx) as number[];
    expect(second[0]).toBe(42);
  });
});
