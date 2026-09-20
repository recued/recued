/** ⛔⛔ THE SAME DIRECTIVE VOCABULARY IS READ BY TWO FORMATTERS, AND ONLY ONE
 *  WAS FIXED.
 *
 *  A render section goes through `formatValue`
 *  (`packages/renderer/src/format.ts`); a `{{step.x:relative}}` inside a
 *  transform param goes through `formatHint` here. The renderer carries the fix
 *  AND the damage count:
 *
 *    "A date hint on an epoch NUMBER used to fall through to String(value) and
 *     print the raw integer — `1751328000000` where a date belonged, at
 *     success:true, invisible to every gate (12 recipes shipped that way)."
 *
 *  `formatHint` was still `typeof value === 'string'` on both `date` and
 *  `relative`, so the second path printed the raw integer. Found by a flagship
 *  dry-run rendering `Starts 1784003600000`.
 *
 *  ⚠ `toRecentMs` is the SHARED decider, so this never guesses: its ms and
 *  seconds ranges are disjoint, and a number outside both is not a recent
 *  timestamp and still falls through to the text form — the same
 *  zero-regression argument the renderer makes for its own copy.
 *
 *  ⛔ SEPARATELY, AND NOT FIXED HERE: a hint on a PURE ref is dropped. See the
 *  last test — `resolveValue` returns early with "Pure reference — preserve
 *  type", so `"{{step.x:relative}}"` alone formats NOTHING, for strings as well
 *  as numbers. That is deliberate (a pure ref must stay a number for
 *  arithmetic) and it is also why a recipe author can write a hint that is
 *  silently ignored. Pinned, not changed. */

import { describe, expect, it } from 'vitest';
import { formatHint, resolveValue } from '../resolve.js';
import { RECENT_MS_MIN, RECENT_MS_MAX } from '../recent-date.js';

/** 2026-07-14T04:33:20Z — the value the flagship rendered raw. */
const EPOCH_MS = 1_784_003_600_000;
const EPOCH_S = 1_784_003_600;

describe('a date hint formats an epoch NUMBER, not just a string', () => {
  it('`date` formats a unix-ms number', () => {
    const out = formatHint(EPOCH_MS, 'date');
    expect(out).not.toBe(String(EPOCH_MS));
    expect(out).toMatch(/2026/);
  });

  it('`date` formats a unix-SECONDS number to the same day', () => {
    // The two ranges are disjoint, so the decider never has to guess.
    expect(formatHint(EPOCH_S, 'date')).toBe(formatHint(EPOCH_MS, 'date'));
  });

  it('`relative` formats a number', () => {
    const out = formatHint(EPOCH_MS, 'relative');
    expect(out).not.toBe(String(EPOCH_MS));
    expect(out).toMatch(/ago|today|yesterday|in \d+ days/);
  });

  it('a number outside BOTH ranges still falls through — zero regression', () => {
    // ⛔ This is the claim the renderer's comment makes for its copy, and it is
    //   what keeps a duration or a count from being rendered as a date.
    for (const n of [0, 1, 999, RECENT_MS_MIN - 1, RECENT_MS_MAX + 1]) {
      expect(formatHint(n, 'date'), String(n)).toBe(String(n));
      expect(formatHint(n, 'relative'), String(n)).toBe(String(n));
    }
  });

  it('strings keep their pre-existing behaviour, parseable or not', () => {
    expect(formatHint('2026-07-14T04:33:20.000Z', 'date')).toMatch(/2026/);
    // An unparseable string passed through before and must still pass through.
    expect(formatHint('not a date', 'date')).toBe('not a date');
    expect(formatHint('not a date', 'relative')).toBe('not a date');
  });

  it('interpolated refs format; a PURE ref does not — pinned, not endorsed', () => {
    const stores = { step: { t: EPOCH_MS, s: '2026-07-14T04:33:20.000Z' } } as never;
    // Interpolated — the hint applies.
    expect(String(resolveValue('at {{step.t:relative}}', stores))).toMatch(/ago|today|in \d+/);
    expect(String(resolveValue('at {{step.s:relative}}', stores))).toMatch(/ago|today|in \d+/);
    // ⛔ Pure ref — `resolveValue` returns early to preserve TYPE, so the hint
    //   is dropped. True for the string too, so this is not a number problem:
    //   a recipe author writing `"{{step.x:relative}}"` as a whole value gets
    //   no formatting and no error. `travel-day-prep-checklist` did exactly
    //   that and rendered a raw epoch to the owner.
    expect(resolveValue('{{step.t:relative}}', stores)).toBe(EPOCH_MS);
    expect(resolveValue('{{step.s:relative}}', stores)).toBe('2026-07-14T04:33:20.000Z');
  });
});
