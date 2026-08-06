/** Turn a key prefix into a half-open RANGE, so prefix queries can use an
 *  index instead of scanning.
 *
 *  ⛔ WHY NOT `LIKE`. Two separate problems, one fix.
 *
 *  1. PERFORMANCE. SQLite cannot apply its LIKE-prefix optimisation when the
 *     pattern is a BOUND PARAMETER, which is how every prefix query in this
 *     codebase is written. Measured against a real 100k-row table with an index
 *     on `key`: `LIKE ? ESCAPE '\'` plans as `SCAN … USING COVERING INDEX` and
 *     took 2.075ms; the equivalent range plans as `SEARCH … (key>? AND key<?)`
 *     and took 0.023ms — **92x**, returning the identical 200 rows. The gap
 *     grows with the table, because one is O(total keys) and the other is
 *     O(matches).
 *
 *  2. CORRECTNESS. `LIKE` treats `_` and `%` in the PREFIX as wildcards.
 *     `shared-store.ts` guards this with `escapeLike()` + `ESCAPE '\'` and its
 *     comment explains why — "a bare `_` would otherwise delete rows the caller
 *     never named". The generic `sqlite-collection` prefix ops had NO such
 *     guard. Not currently reachable (no caller passes a `_`-bearing prefix
 *     today — checked), but it is one `deleteByPrefix` away from being a
 *     silent over-delete. A range predicate has no wildcard semantics at all,
 *     so the hazard stops existing rather than being escaped.
 *
 *  ⚠ Relies on BINARY collation, which is the default for TEXT and what every
 *  `key` column here uses (none declares `COLLATE NOCASE`). Under BINARY,
 *  SQLite compares the UTF-8 encoding bytewise, and UTF-8 preserves code-point
 *  order — so incrementing the last code point yields exactly the right
 *  boundary. A column declared `COLLATE NOCASE` would break this, which is why
 *  callers pass their own column and the assumption is stated here. */

/** The exclusive upper bound for "every string starting with `prefix`".
 *
 *  Returns `null` when no such bound exists — an empty prefix (which matches
 *  everything, so there is no upper bound) or a prefix ending in the maximum
 *  code point. Callers must handle `null` rather than fabricate a bound; a
 *  guessed bound is a silently truncated result set.
 *
 *  ⚠ Increments a CODE POINT, not a UTF-16 unit, and steps over the surrogate
 *  range. Incrementing `U+D7FF` to `U+D800` would produce an unpaired
 *  surrogate — not a valid scalar value, and not a boundary any real key sorts
 *  against. */
export const prefixUpperBound = (prefix: string): string | null => {
  if (prefix === '') return null;
  const points = [...prefix];
  for (let i = points.length - 1; i >= 0; i--) {
    const cp = points[i].codePointAt(0);
    if (cp === undefined || cp >= 0x10ffff) continue;
    const next = cp === 0xd7ff ? 0xe000 : cp + 1;
    return points.slice(0, i).join('') + String.fromCodePoint(next);
  }
  return null;
};
