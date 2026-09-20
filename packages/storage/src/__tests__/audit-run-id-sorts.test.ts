/** A run id must sort LEXICOGRAPHICALLY in the order the runs happened.
 *
 *  ⛔ THAT IS THE WHOLE POINT OF THE FORMAT. `newRunId` builds a fixed-width
 *  UTC stamp followed by a random suffix precisely so a plain string sort is a
 *  chronological sort — which is what makes ids usable as a stable tiebreak and
 *  what makes "the next id after X" meaningful.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-18): four separate mutations of that format
 *  survived every test — dropping the millisecond zero-pad, dropping the hour
 *  pad, taking LOCAL time instead of UTC, and the `getUTCMonth() + 1` off-by-
 *  one. Each is invisible to a test that only checks the SHAPE of one id, and
 *  each breaks ordering somewhere specific:
 *
 *    - unpadded ms: 12:00:00.9 sorts AFTER 12:00:00.85
 *    - unpadded hours: 09:00 sorts after 10:00
 *    - local time: ids reorder across a DST shift, and across machines
 *    - month off-by-one: December renders as month 11 and lands before itself
 *
 *  ⇒ Asserted as the PROPERTY rather than the format: ids minted at increasing
 *  instants compare increasing. One test covers all four, and it keeps covering
 *  a format change that preserves the property. */

import { describe, expect, it, vi } from 'vitest';

import { newRunId } from '../audit.js';

/** Instants chosen to sit either side of every carry the format performs. */
const ORDERED_INSTANTS: ReadonlyArray<[string, number]> = [
  ['ms 009', Date.UTC(2026, 0, 1, 0, 0, 0, 9)],
  ['ms 010', Date.UTC(2026, 0, 1, 0, 0, 0, 10)],
  ['ms 099', Date.UTC(2026, 0, 1, 0, 0, 0, 99)],
  ['ms 100', Date.UTC(2026, 0, 1, 0, 0, 0, 100)],
  ['ms 999', Date.UTC(2026, 0, 1, 0, 0, 0, 999)],
  ['second rollover', Date.UTC(2026, 0, 1, 0, 0, 1, 0)],
  ['minute 09', Date.UTC(2026, 0, 1, 0, 9, 0, 0)],
  ['minute 10', Date.UTC(2026, 0, 1, 0, 10, 0, 0)],
  ['hour 09', Date.UTC(2026, 0, 1, 9, 0, 0, 0)],
  ['hour 10', Date.UTC(2026, 0, 1, 10, 0, 0, 0)],
  ['day 09', Date.UTC(2026, 0, 9, 0, 0, 0, 0)],
  ['day 10', Date.UTC(2026, 0, 10, 0, 0, 0, 0)],
  ['month 09 (Sep)', Date.UTC(2026, 8, 1, 0, 0, 0, 0)],
  ['month 10 (Oct)', Date.UTC(2026, 9, 1, 0, 0, 0, 0)],
  ['month 12 (Dec)', Date.UTC(2026, 11, 1, 0, 0, 0, 0)],
  ['next year', Date.UTC(2027, 0, 1, 0, 0, 0, 0)],
];

describe('newRunId — string order is time order', () => {
  it('⛔⛔ every later instant produces a lexicographically greater id', () => {
    const ids = ORDERED_INSTANTS.map(([label, at]) => [label, newRunId(at)] as const);
    for (let i = 1; i < ids.length; i++) {
      const [prevLabel, prev] = ids[i - 1]!;
      const [label, id] = ids[i]!;
      expect(
        id > prev,
        `${label} (${id}) does not sort after ${prevLabel} (${prev})`,
      ).toBe(true);
    }
  });

  it('⛔ the stamp is fixed-width, so a sort never compares a short field to a long one', () => {
    // The property above can hold by luck on a chosen set; this pins the reason
    // it holds for every set. Every id has the same stamp length.
    const lengths = new Set(
      ORDERED_INSTANTS.map(([, at]) => newRunId(at).split('-')[0]!.length),
    );
    expect(lengths.size, `stamp widths varied: ${[...lengths].join(', ')}`).toBe(1);
  });

  it('⛔ the suffix is PADDED to a fixed width — the small draws are the ones that matter', () => {
    // ⚠⚠ DRIVEN, NOT SAMPLED. A base-36 render of `floor(random * 36**6)` is
    // short only when the draw lands below 36**5 — probability 1/36 — so a
    // sampling test is a coin flip: 64 draws miss a short suffix about 17% of
    // the time. That is a flaky test, not a weak one, and it is exactly what I
    // wrote first. Stubbing the draw makes the small cases certain.
    const at = Date.UTC(2026, 5, 15, 12, 30, 45, 123);
    const draw = vi.spyOn(Math, 'random');
    try {
      for (const [label, value, expected] of [
        ['zero', 0, '000000'],
        ['one unit', 1 / 36 ** 6, '000001'],
        // Just under the 6-char boundary: renders 5 chars unpadded.
        ['just below 36**5', (36 ** 5 - 1) / 36 ** 6, 'zzzzz'.padStart(6, '0')],
      ] as const) {
        draw.mockReturnValue(value);
        const suffix = newRunId(at).split('-')[1]!;
        expect(suffix.length, `${label}: suffix "${suffix}" is not 6 chars`).toBe(6);
        expect(suffix, label).toBe(expected);
      }
    } finally {
      draw.mockRestore();
    }
  });

  it('⚠ and the suffix really does vary, so same-millisecond runs do not collide', () => {
    // The complement to the stubbed test above — unstubbed, and asserting only
    // that it VARIES, which is not a coin flip.
    const at = Date.UTC(2026, 5, 15, 12, 30, 45, 123);
    const suffixes = new Set(
      Array.from({ length: 32 }, () => newRunId(at).split('-')[1]!),
    );
    expect(suffixes.size, 'the suffix is not random').toBeGreaterThan(1);
  });

  it('⚠ the stamp is UTC — the same instant yields the same id stamp regardless of TZ', () => {
    // A local-time stamp reorders ids across a DST shift and disagrees between
    // two machines reading the same database.
    const at = Date.UTC(2026, 6, 4, 23, 30, 0, 0);
    const stamp = newRunId(at).split('-')[0]!;
    expect(stamp).toBe('20260704T233000000');
  });
});
