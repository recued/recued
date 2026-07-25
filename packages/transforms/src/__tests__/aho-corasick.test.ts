import { describe, it, expect } from 'vitest';
import {
  buildAhoCorasick,
  findAhoCorasickMatches,
  normalizeForMatch,
} from '../aho-corasick.js';

/** Resolve raw `{ end, patternIndex }` matches into readable
 *  `{ value, start, end }` (start derived the way the PII layer derives it). */
const collect = (
  patterns: readonly string[],
  text: string,
): Array<{ value: string; start: number; end: number }> => {
  const ac = buildAhoCorasick(patterns);
  return findAhoCorasickMatches(ac, text)
    .map(({ end, patternIndex }) => ({
      value: patterns[patternIndex]!,
      start: end - patterns[patternIndex]!.length,
      end,
    }))
    .sort((a, b) => a.end - b.end || a.start - b.start);
};

describe('aho-corasick — core algorithm (fail links + suffix output merge)', () => {
  it('finds the classic overlapping set (he / she / his / hers)', () => {
    // a h i s h e r s — the textbook A-C case exercising fail links + the
    // suffix-output merge (a match for `she` must ALSO surface the suffix `he`).
    const found = collect(['he', 'she', 'his', 'hers'], 'ahishers');
    expect(found).toEqual([
      { value: 'his', start: 1, end: 4 },
      { value: 'she', start: 3, end: 6 },
      { value: 'he', start: 4, end: 6 }, // suffix of `she`, via the output link
      { value: 'hers', start: 4, end: 8 },
    ]);
  });

  it('reports every occurrence — including OVERLAPPING — with correct offsets', () => {
    const found = collect(['ana'], 'banana ananas');
    // Fail links make A-C find overlapping hits: `banana` → ana@1 AND ana@3;
    // `ananas` → ana@7 AND ana@9. (Discovery only needs ≥ 1, but all must be exact.)
    expect(found.map((m) => m.start)).toEqual([1, 3, 7, 9]);
    for (const m of found) expect('banana ananas'.slice(m.start, m.end)).toBe('ana');
  });

  it('returns no matches for empty text or an empty pattern set', () => {
    expect(findAhoCorasickMatches(buildAhoCorasick(['x']), '')).toEqual([]);
    expect(findAhoCorasickMatches(buildAhoCorasick([]), 'anything')).toEqual([]);
  });

  it('keeps patternIndex aligned when an empty pattern shares the set (never matches)', () => {
    // An empty pattern occupies its slot but is never matchable, so a later
    // pattern's index still resolves to the right value.
    const ac = buildAhoCorasick(['', 'bob']);
    const matches = findAhoCorasickMatches(ac, 'hi bob');
    expect(matches).toEqual([{ end: 6, patternIndex: 1 }]);
    expect(ac.patternLengths).toEqual([0, 3]);
  });
});

describe('aho-corasick — normalisation (case-insensitive, accent-sensitive)', () => {
  it('matches case-insensitively (Acme ~ ACME ~ acme)', () => {
    expect(collect(['Acme'], 'visit ACME today').map((m) => m.start)).toEqual([6]);
    expect(collect(['ACME'], 'visit acme today').map((m) => m.start)).toEqual([6]);
  });

  it('is ACCENT-sensitive — Lucía matches LUCÍA but NOT Lucia', () => {
    expect(collect(['Lucía'], 'hi LUCÍA bye').length).toBe(1);
    expect(collect(['Lucía'], 'hi Lucia bye').length).toBe(0); // accent dropped → no match
  });

  it('preserves offsets across a single-UTF-16-unit accented char', () => {
    const [m] = collect(['café'], 'le café ici');
    expect(m).toEqual({ value: 'café', start: 3, end: 7 });
    expect('le café ici'.slice(m!.start, m!.end)).toBe('café');
  });

  it('matches /i regex on Greek final-sigma where per-toLowerCase would MISS (the I3 fix)', () => {
    // `/ΟΣ/i.test('Ος')` is true; a per-toLowerCase automaton would key `ΟΣ`→`οσ`
    // and `Ος`→`ος` and MISS — the toUpperCase fold keys both `ΟΣ` and matches.
    expect(/ΟΣ/i.test('Ος')).toBe(true); // ΟΣ ~ Ος (sanity: regex agrees)
    expect(collect(['ΟΣ'], 'talk to Ος now').length).toBe(1); // ΟΣ matches Ος
  });

  it('matches the micro-sign / Greek-mu equivalence /µ/i covers', () => {
    expect(collect(['µicro'], 'a μicro b').length).toBe(1); // µicro ~ μicro
  });

  it('treats an expansion fold (ß→SS) as its OWN path — Straße ≠ Strasse, like /i', () => {
    // `/Straße/i.test('strasse')` is false (ß canonicalises to ß, not SS), and the
    // per-unit automaton agrees: `ß` is ONE edge keyed `SS`, distinct from two `S`
    // edges — so the two never cross-match.
    expect(/Straße/i.test('strasse')).toBe(false); // sanity
    expect(collect(['Straße'], 'pay straße now').length).toBe(1); // case variant matches
    expect(collect(['Straße'], 'pay strasse now').length).toBe(0); // ss ≠ ß
    expect(collect(['Strasse'], 'pay straße now').length).toBe(0); // and the reverse
  });
});

describe('normalizeForMatch — dedup key consistent with the automaton fold', () => {
  it('collapses case + Greek final-sigma the way the matcher does', () => {
    expect(normalizeForMatch('Acme')).toBe(normalizeForMatch('ACME'));
    expect(normalizeForMatch('ΟΣ')).toBe(normalizeForMatch('Ος')); // ΟΣ ~ Ος
  });
  it('preserves accents (é stays distinct from e)', () => {
    expect(normalizeForMatch('café')).not.toBe(normalizeForMatch('cafe'));
  });
  it('keeps an EXPANSION fold distinct from its spelled-out form (the NUL separator)', () => {
    // Without the separator both would normalise to "STRASSE" and dedup would drop
    // one — but their automaton paths differ (ß is one `SS` edge), so the keys must
    // differ too, or the dropped value would never match (an under-seed leak).
    expect(normalizeForMatch('Straße')).not.toBe(normalizeForMatch('Strasse'));
  });
});
