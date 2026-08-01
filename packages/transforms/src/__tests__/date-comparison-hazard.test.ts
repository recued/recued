/** ⛔⛔ THE ORDERING OPERATORS ARE NUMERIC. A DATE STRING IS NOT.
 *
 *  `greater` / `greater_or_equal` / `less` / `less_or_equal` all coerce with
 *  `Number()`, and `Number('2026-12-31')` is `NaN`. Every NaN comparison is
 *  false, so a recipe comparing two ISO dates gets `false` in BOTH directions —
 *  a filter that silently matches nothing, in a shape that looks completely
 *  correct on the page.
 *
 *  This shipped in four recipes before anything caught it, and in one of them
 *  ("which notice windows have I missed") it was the entire point of the pack.
 *
 *  🔑 The fix is not to change these operators — they are right for the epoch-ms
 *  and count comparisons the corpus is full of. It is to compare dates WHERE
 *  THEY ARE DATES: the Records store types its date slots and its `lt` / `lte` /
 *  `gte` predicates order them properly.
 *
 *  This file exists so the hazard is stated somewhere executable rather than
 *  living in whoever remembers it. */
import { describe, expect, it } from 'vitest';
import { evaluateOp } from '../evaluate.js';

describe('ordering operators on ISO date strings', () => {
  it('⛔ compare FALSE in both directions — the silent-empty-filter shape', () => {
    const later = '2026-12-31', earlier = '2026-07-30';
    expect(evaluateOp(later, 'greater_or_equal', earlier)).toBe(false);
    expect(evaluateOp(later, 'less', earlier)).toBe(false);
    expect(evaluateOp(earlier, 'less', later)).toBe(false);
    expect(evaluateOp(earlier, 'greater', later)).toBe(false);
  });

  it('because Number() cannot read a date', () => {
    expect(Number('2026-12-31')).toBeNaN();
  });

  it('⚠ EQUALITY still works, which is what makes it deceptive', () => {
    // A recipe author checks `equal` in the console, sees it behave, and
    // reasonably assumes the family works.
    expect(evaluateOp('2026-12-31', 'equal', '2026-12-31')).toBe(true);
    expect(evaluateOp('2026-12-31', 'not_equal', '2026-07-30')).toBe(true);
  });

  it('and the operators are CORRECT for what the corpus mostly compares', () => {
    // epoch-ms, day counts, byte sizes — the reason this is not a bug to fix
    // in the operators themselves.
    expect(evaluateOp(1_800_000_000_000, 'greater', 1_700_000_000_000)).toBe(true);
    expect(evaluateOp(30, 'less_or_equal', 60)).toBe(true);
    expect(evaluateOp('42', 'greater', '7')).toBe(true);   // numeric strings coerce fine
  });

  it('⚠ a YEAR-ONLY string coerces and compares — the trap has a shallow edge', () => {
    // '2026' IS a number, so a partial date silently works and reinforces the
    // wrong mental model.
    expect(evaluateOp('2026', 'greater', '2025')).toBe(true);
  });

  it('sorting is NOT affected — `sort` compares natively, so it stays correct', () => {
    // Which is why a list can look right (ordered) while its buckets are empty.
    expect('2026-07-30' < '2026-12-31').toBe(true);
  });
});
