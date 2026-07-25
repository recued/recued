/** The window is the entire correctness argument. These tests pin it.
 *
 *  ⛔ IF YOU ARE HERE BECAUSE `toRecentMs` REFUSED A DATE YOU WANTED: do not
 *  widen the window. Read `recent-date.ts` first. A single ±N-year span DOES NOT
 *  WORK — a seconds value read as ms lands in 1970, and 1970 is only ~56 years
 *  ago, so a natural "±60 years, seems generous" makes BOTH readings recent and
 *  disambiguates nothing. `rejects a single wide window` below proves that.
 */

import { describe, expect, it } from 'vitest';
import {
  toRecentMs, RECENT_MS_MIN, RECENT_MS_MAX, RECENT_S_MIN, RECENT_S_MAX,
} from '../recent-date.js';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().slice(0, 10));

describe('toRecentMs — the two real corpus shapes', () => {
  it('passes a warehouse unix-ms timestamp through', () => {
    expect(iso(toRecentMs(1783935122879))).toBe('2026-07-13');   // received_at / start_at
  });

  it('lifts a Stripe unix-SECONDS timestamp to ms', () => {
    expect(iso(toRecentMs(1780825854))).toBe('2026-06-07');      // created / due_date
  });
});

describe('refusing is a FEATURE — the bug stays visible', () => {
  // `new Date(null)` is epoch 0, the footgun date_parse guards against by name
  // (an AI-extracted date that was null when unstated). A naive "small number =>
  // seconds" would launder it into a plausible 1972 and make it INVISIBLE.
  it('refuses epoch 0', () => expect(toRecentMs(0)).toBeNull());
  it('refuses 1970-01-02-in-ms', () => expect(toRecentMs(86_400_000)).toBeNull());
  it('refuses a non-timestamp number', () => expect(toRecentMs(1200)).toBeNull());
  it('refuses a pre-2001 date in either unit', () => {
    expect(toRecentMs(315_532_800_000)).toBeNull();  // 1980 as ms
    expect(toRecentMs(315_532_800)).toBeNull();      // 1980 as seconds
  });
  it('refuses non-numbers and non-finite', () => {
    for (const v of [null, undefined, '1783935122879', {}, [], NaN, Infinity]) {
      expect(toRecentMs(v as unknown)).toBeNull();
    }
  });
});

describe('the bounds', () => {
  it('is inclusive at every edge', () => {
    expect(toRecentMs(RECENT_MS_MIN)).toBe(RECENT_MS_MIN);
    expect(toRecentMs(RECENT_MS_MAX)).toBe(RECENT_MS_MAX);
    expect(toRecentMs(RECENT_S_MIN)).toBe(RECENT_S_MIN * 1000);
    expect(toRecentMs(RECENT_S_MAX)).toBe(RECENT_S_MAX * 1000);
  });

  it('refuses just outside each edge', () => {
    expect(toRecentMs(RECENT_MS_MAX + 1)).toBeNull();
    expect(toRecentMs(RECENT_S_MIN - 1)).toBeNull();
  });

  // THE load-bearing property: the two ACCEPTED INPUT ranges are disjoint, so a
  // value can match at most one branch. No value is ever ambiguous.
  it('accepts disjoint input ranges — at most one branch can ever match', () => {
    expect(RECENT_S_MAX).toBeLessThan(RECENT_MS_MIN);
  });

  it('rejects a single wide window — why the naive design fails', () => {
    // The tempting version: "recent = within ±60 years of now, then guess".
    const NOW = 1_784_000_000_000;
    const wide = (ms: number) => Math.abs(ms - NOW) <= 60 * 365.25 * 86_400_000;
    const stripeSeconds = 1_780_825_854;
    // Under a wide window BOTH readings look recent => ambiguous => a guess.
    expect(wide(stripeSeconds)).toBe(true);          // read as ms  -> 1970, "recent"
    expect(wide(stripeSeconds * 1000)).toBe(true);   // read as sec -> 2026, "recent"
    // The bounded rule has no such overlap.
    expect(toRecentMs(stripeSeconds)).toBe(stripeSeconds * 1000);
  });
});

// ⚠ KNOWN AND DELIBERATE. A duration in ms shares the numeric range of a
// 2001–2096 seconds epoch, and `window_ms: 2592000000` (30 days) is IN the
// corpus. "Recent" disambiguates ms-vs-seconds; it CANNOT tell you the value is
// a timestamp at all — that assertion belongs to the caller ({format:'date'}, or
// reaching for to_recent_date). Pinned so nobody "fixes" it by widening the
// window, which would re-open the ambiguity this exists to close.
describe('the known limit — do not "fix" this by widening', () => {
  it('normalises a 30-day duration-in-ms as if it were a seconds epoch', () => {
    expect(iso(toRecentMs(2_592_000_000))).toBe('2052-02-20');
  });
});
