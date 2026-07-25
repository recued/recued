/**
 * D-167 PII-Value Registry P4 — pure Aho-Corasick string-set matcher.
 *
 * Design of record: `docs/d-167-eav-pii-registry-design.md` §2 (ALIASING). The
 * memory-recall PII leak ([[pii-memory-recall-leak-confirmed]]) needs the egress
 * to alias a recalled artifact's PII against the FULL cross-session contact
 * registry, not just the per-session ledger. The naive way — one
 * `scanContent`-style `/gi` regex per known value — is O(values × text), which a
 * 100k-contact warehouse makes untenable. This automaton collapses it to ONE
 * O(text) pass that finds every known value present, independent of the value
 * count (build is the one-time cost; matching is flat).
 *
 * Pure + generic — no PII opinion. The PII-aware glue (boundary verification +
 * ledger seeding) lives in `pii-alias.ts`'s `aliasKnownValuesInContent`, which is
 * the `scanContent`-SCALED layer over this primitive.
 *
 * NORMALISATION (the design §7 parity risk). Matching is **case-insensitive,
 * accent-SENSITIVE**, and must MATCH AT LEAST AS MUCH as `scanContent`'s `/gi`
 * (no `u` flag) regex, so the A-C never MISSES a span the scan would alias
 * (invariant I3: A-C seeds ⊇ scan seeds — a miss would be a leak):
 *   · Fold direction — every pattern char AND input char is folded per UTF-16
 *     unit with `.toUpperCase()`, mirroring ECMAScript's regex `/i` `Canonicalize`
 *     (which case-folds via `toUpperCase`). A plain per-unit `.toLowerCase()` does
 *     NOT match `/i`: `/ΟΣ/i.test('Ος')` is `true`, yet `Ος`/`ΟΣ` lower-case to
 *     `ος`/`οσ` (Greek final-sigma) — a per-`toLowerCase` automaton would MISS it
 *     (an I3 violation); `toUpperCase` folds both to `ΟΣ` and matches. Same class:
 *     `µ` (micro) / `µ` (Greek mu) / `M`.
 *   · The ONE place `/i` differs — its ASCII guard keeps a non-ASCII char that
 *     upper-cases to ASCII (`K` Kelvin → `K`) un-folded. We DON'T guard, so we may
 *     fold slightly MORE (match `K`~`k`). That is the SAFE direction (⊇): the extra
 *     hits only widen DISCOVERY; `scanContent` re-applies the exact `/gi` boundary
 *     at replace time, so an over-discovered span that the scan wouldn't replace is
 *     simply never aliased — never a wrong alias.
 *   · Accent-sensitive — `.toUpperCase()` PRESERVES diacritics (`é`→`É`), so a
 *     stored `Lucía` matches `LUCÍA` but NOT `Lucia` — exactly `scanContent`, and
 *     the opposite of the FUZZY surfacing normalisation
 *     (`chat-prefetch-score.ts`'s accent-STRIPPING `normalize`).
 *
 * OFFSETS. Matching consumes the input ONE UTF-16 code unit at a time, advancing
 * the position by exactly one per unit, so a reported match `end` is a UTF-16
 * index into the ORIGINAL text — directly usable for `text.slice(end)` /
 * `text.charAt(start - 1)` boundary checks. A code unit whose `.toUpperCase()`
 * expands to >1 char (e.g. `ß` → `SS`) still consumes a single unit (the fold is
 * only the edge KEY, mapped from ONE input unit), so offsets never drift.
 */

/** A built automaton. Opaque to callers — pass it to `findAhoCorasickMatches`.
 *  Plain arrays/Maps (no class, no I/O), so it is a single-process RAM value with
 *  no single-writer / connection concerns (design §7). */
export interface AhoCorasick {
  /** `goto[node]` — folded-char-key → child node id (the trie edges). */
  readonly goto: ReadonlyArray<ReadonlyMap<string, number>>;
  /** `fail[node]` — the longest-proper-suffix fallback node (root = 0). */
  readonly fail: ReadonlyArray<number>;
  /** `out[node]` — pattern indices whose value ends at this node, INCLUDING the
   *  ones reachable via fail links (merged at build), so a single node read
   *  yields every pattern ending here. */
  readonly out: ReadonlyArray<ReadonlyArray<number>>;
  /** `patternLengths[i]` — value `i`'s length in UTF-16 units = the units
   *  consumed to match it, so `start = end - patternLengths[i]`. */
  readonly patternLengths: ReadonlyArray<number>;
}

/** One match occurrence: pattern `patternIndex` ends at UTF-16 index `end`
 *  (exclusive) in the scanned text. `start = end - patternLengths[patternIndex]`.
 *  Every boundary-VALID and boundary-INVALID occurrence is reported — the caller
 *  applies its own word-boundary policy (the PII layer mirrors `scanContent`). */
export interface AhoCorasickMatch {
  readonly end: number;
  readonly patternIndex: number;
}

/** Per-UTF-16-unit case fold (the edge key + the input fold) — `.toUpperCase()`,
 *  mirroring ECMAScript regex `/i` `Canonicalize` so the automaton matches ⊇ the
 *  `/gi` scan (module doc, NORMALISATION). A single code unit in, its folded form
 *  out (usually one char; occasionally more, e.g. `ß`→`SS` — used only as a Map
 *  key, never to advance the position). */
const fold = (unit: string): string => unit.toUpperCase();

/** Whole-string match-normalisation — the per-unit `fold` applied across `s`,
 *  joined by a NUL (`\u0000`) separator. Two strings have the SAME
 *  `normalizeForMatch` IFF they traverse the IDENTICAL automaton edge path (one
 *  edge per UTF-16 unit), so a caller (e.g. `buildKnownValueIndex`'s dedup) keys
 *  on this to dedup EXACTLY what the automaton treats as equal. The separator is
 *  load-bearing: a fold can EXPAND a unit (`ß`→`SS`, ONE edge), and a plain
 *  concatenation would conflate `Straße` (path `…A·SS·E`) with `Strasse` (path
 *  `…A·S·S·E`) — two DISTINCT automaton patterns — into one dedup key, dropping the
 *  second value so it neither seeds NOR matches (an under-seed leak). The NUL
 *  separator keeps the two keys distinct, mirroring the per-edge boundary (NUL
 *  never occurs in a folded name/org value). */
export const normalizeForMatch = (s: string): string => {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i++) parts.push(fold(s[i]!));
  return parts.join('\u0000');
}

/**
 * Build the automaton over `patterns` (the canonical known values). Empty
 * patterns are skipped but still consume a `patternLengths` slot of 0 so a
 * caller's `patternIndex` stays aligned to its own `patterns` array (it never
 * matches — no node carries its index). Patterns that fold to the SAME string are
 * each kept (distinct indices); the caller dedups upstream if it wants one
 * canonical per fold.
 */
export const buildAhoCorasick = (patterns: readonly string[]): AhoCorasick => {
  const goto: Array<Map<string, number>> = [new Map()]; // node 0 = root
  const out: number[][] = [[]];
  const patternLengths: number[] = [];
  const newNode = (): number => {
    goto.push(new Map());
    out.push([]);
    return goto.length - 1;
  };

  // 1. Trie of folded pattern chars.
  for (let pi = 0; pi < patterns.length; pi++) {
    const p = patterns[pi]!;
    patternLengths[pi] = p.length;
    if (p.length === 0) continue; // skip empties (never matchable); slot kept above
    let node = 0;
    for (let i = 0; i < p.length; i++) {
      const key = fold(p[i]!);
      let next = goto[node]!.get(key);
      if (next === undefined) {
        next = newNode();
        goto[node]!.set(key, next);
      }
      node = next;
    }
    out[node]!.push(pi);
  }

  // 2. BFS fail links + output merge (standard Aho-Corasick construction).
  const fail: number[] = new Array(goto.length).fill(0);
  const queue: number[] = [];
  for (const child of goto[0]!.values()) {
    fail[child] = 0;
    queue.push(child);
  }
  let head = 0;
  while (head < queue.length) {
    const node = queue[head++]!;
    for (const [key, child] of goto[node]!) {
      queue.push(child);
      let f = fail[node]!;
      while (f !== 0 && !goto[f]!.has(key)) f = fail[f]!;
      const candidate = goto[f]!.get(key);
      fail[child] = candidate !== undefined && candidate !== child ? candidate : 0;
      // Merge the fail target's outputs so one node read yields every pattern
      // ending here (suffix matches included).
      if (out[fail[child]!]!.length > 0) {
        out[child] = out[child]!.concat(out[fail[child]!]!);
      }
    }
  }

  return { goto, fail, out, patternLengths };
};

/**
 * Find every pattern occurrence in `text` — O(text) after build, flat to the
 * pattern count. Reports each occurrence (overlaps included) as `{ end,
 * patternIndex }`; the caller resolves overlaps / applies boundary checks. A
 * non-string or empty text yields no matches.
 */
export const findAhoCorasickMatches = (
  ac: AhoCorasick,
  text: string,
): readonly AhoCorasickMatch[] => {
  if (typeof text !== 'string' || text.length === 0) return [];
  const { goto, fail, out } = ac;
  const matches: AhoCorasickMatch[] = [];
  let node = 0;
  for (let i = 0; i < text.length; i++) {
    const key = fold(text[i]!);
    // Follow fail links until an edge exists (or we're back at root).
    while (node !== 0 && !goto[node]!.has(key)) node = fail[node]!;
    node = goto[node]!.get(key) ?? 0;
    const ending = out[node]!;
    for (let k = 0; k < ending.length; k++) {
      matches.push({ end: i + 1, patternIndex: ending[k]! });
    }
  }
  return matches;
};
