/** ⛔⛔ FOUR BYTE BUDGETS IN THIS TREE WERE ENFORCED WITH `String.slice`, WHICH
 *  COUNTS UTF-16 CODE UNITS.
 *
 *  Each one checked correctly — `Buffer.byteLength(s, 'utf8') > CAP` — so the
 *  guard fired at the right moment and then cut in the wrong unit:
 *
 *    · `chat-tool-handlers.ts`  MEMORY_FETCH_ONE_CAP_BYTES      64 KB → 192 KB
 *    · `annotation-store.ts` ×2 MAX_LINK_EVIDENCE_BYTES          1 KB →   3 KB
 *    · `preview.ts`             INGREDIENT_PREVIEW_MAX_OUTPUT_BYTES 16 KB → 48 KB
 *
 *  🔑 AND TWO OF THEM WERE OVER ON PURE ASCII, before any multi-byte input.
 *  `s.slice(0, CAP - 1) + '…'` reads as "leave room for the marker" — but `…`
 *  is U+2026: ONE code unit, THREE UTF-8 bytes. A 1,024-byte cap produced
 *  1,026 bytes of ASCII.
 *
 *  ⚠ THE MEMORY ONE REPORTED ITS OWN VIOLATION AND NOBODY READ IT. The result
 *  carried `{limit_bytes: 65536, used_bytes: <real size>}`, and `used_bytes`
 *  was measured with `Buffer.byteLength` — so a CJK body shipped a budget
 *  object openly stating it was 3× over. A number in a response is not a check.
 *
 *  🔑 A CORRECT `truncateUtf8` ALREADY EXISTED in `chat-context-slice.ts`, one
 *  directory over, with a neighbouring comment stating the exact principle the
 *  four sites broke: *"A safety limit that is only approximately respected is
 *  not one."* It was unexported, so nobody could reach it. */

import { describe, expect, it } from 'vitest';
import {
  byteLengthUtf8,
  truncateUtf8,
  truncateUtf8WithMarker,
} from '../utf8-budget.js';

/** One code unit each, but 1 / 2 / 3 / 4 UTF-8 bytes. */
const SAMPLES: ReadonlyArray<[string, string, number]> = [
  ['ascii', 'a', 1],
  ['latin-1', 'é', 2],
  ['CJK', '中', 3],
  ['emoji (surrogate pair)', '😀', 4],
];

describe('truncateUtf8 — a byte budget that actually bounds', () => {
  it('the samples are the byte widths the tests assume', () => {
    // ⛔ The floor: if these are wrong, every assertion below is vacuous.
    for (const [label, ch, bytes] of SAMPLES) {
      expect(byteLengthUtf8(ch), label).toBe(bytes);
    }
    expect(byteLengthUtf8('…'), 'the ellipsis is THREE bytes').toBe(3);
  });

  it('never exceeds the budget, for any width, at any offset', () => {
    for (const [label, ch] of SAMPLES) {
      for (const cap of [0, 1, 2, 3, 4, 5, 7, 16, 63, 64, 1_024, 1_025]) {
        const out = truncateUtf8(ch.repeat(500), cap);
        expect(byteLengthUtf8(out), `${label} @ ${cap}`).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('never splits a surrogate pair, whatever the parity of the cut', () => {
    // ⚠ The offset has to be ODD relative to the pair for this to bite, which
    //   is why an emoji test at a round cap can pass while the bug is live.
    for (let lead = 0; lead < 4; lead += 1) {
      const text = 'a'.repeat(lead) + '😀'.repeat(50);
      for (let cap = 1; cap <= 24; cap += 1) {
        const out = truncateUtf8(text, cap);
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), `lead=${lead} cap=${cap}`)
          .toBe(false);
        expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), `lead=${lead} cap=${cap}`)
          .toBe(false);
      }
    }
  });

  it('keeps as much as fits — it is a budget, not a guess', () => {
    // A cut that is merely SAFE could return '' every time and pass the bound.
    expect(truncateUtf8('中'.repeat(10), 9)).toBe('中中中');
    expect(truncateUtf8('中'.repeat(10), 11)).toBe('中中中'); // 4th needs 12
    expect(truncateUtf8('a'.repeat(10), 7)).toBe('aaaaaaa');
  });

  it('returns the input untouched when it already fits', () => {
    expect(truncateUtf8('中文', 64)).toBe('中文');
    expect(truncateUtf8('', 64)).toBe('');
    expect(truncateUtf8('abc', 0)).toBe('');
    expect(truncateUtf8('abc', -5)).toBe('');
  });
});

describe('truncateUtf8WithMarker — the marker is inside the budget', () => {
  it('the TOTAL stays within the cap, marker included', () => {
    for (const [label, ch] of SAMPLES) {
      for (const cap of [1, 3, 4, 8, 64, 1_024]) {
        const out = truncateUtf8WithMarker(ch.repeat(500), cap);
        expect(byteLengthUtf8(out), `${label} @ ${cap}`).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('marks only when something was actually dropped', () => {
    expect(truncateUtf8WithMarker('abc', 64)).toBe('abc');
    expect(truncateUtf8WithMarker('abcdefgh', 6)).toBe('abc…'); // 3 + 3 bytes
  });

  it('a marker that cannot fit is itself cut — the budget wins', () => {
    expect(byteLengthUtf8(truncateUtf8WithMarker('abcdef', 2))).toBeLessThanOrEqual(2);
    expect(byteLengthUtf8(truncateUtf8WithMarker('abcdef', 1))).toBeLessThanOrEqual(1);
  });

  it('REGRESSION: the shipped expression was over on ASCII and 3x on CJK', () => {
    const CAP = 1_024;
    const shipped = (s: string): string => s.slice(0, CAP - 1) + '…';
    expect(byteLengthUtf8(shipped('a'.repeat(5_000)))).toBe(1_026); // over by 2
    expect(byteLengthUtf8(shipped('中'.repeat(5_000)))).toBe(3_072); // 3x
    // And the replacement, on the same inputs:
    expect(byteLengthUtf8(truncateUtf8WithMarker('a'.repeat(5_000), CAP)))
      .toBeLessThanOrEqual(CAP);
    expect(byteLengthUtf8(truncateUtf8WithMarker('中'.repeat(5_000), CAP)))
      .toBeLessThanOrEqual(CAP);
  });
});
