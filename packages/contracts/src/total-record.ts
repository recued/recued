/** Build a `Record<K, V>` whose key set is PROVEN to cover `K`.
 *
 *  ── Why this exists ─────────────────────────────────────────────────
 *  The codebase built total records by hand, eight times, all in one shape:
 *
 *      const out = {} as Record<PathRole, PathResolution>;   // ← the lie
 *      for (const role of PATH_ROLES) out[role] = …;
 *      return out;
 *
 *  The cast is what makes it compile: `{}` is not a `Record<PathRole, …>`, and
 *  `as` silences the missing-key check for every key. It is *correct* only
 *  because the loop happens to cover the union — a fact nothing verified. Miss a
 *  key and you get `undefined` typed as present, which surfaces far from here.
 *  `scripts/check-object-cast-completeness.mjs` found all eight.
 *
 *  ── Why this is a PROOF and not just a tidier assertion ─────────────
 *  `K` is inferred from `keys`. Callers pass a canonical list declared
 *  `as const satisfies readonly Union[]` and carrying a `…AreExhaustive`
 *  compile-time proof (see `PATH_ROLES` in `network.ts`), so:
 *
 *    · `satisfies` ⇒ every listed key really is a `Union` member, and
 *    · the exhaustiveness alias ⇒ no `Union` member is missing from the list,
 *    · therefore `K` (the tuple's member type) IS `Union`, and the record this
 *      builds has exactly the keys its type claims.
 *
 *  ⚠ THE ONE ASSERTION LIVES HERE, ON PURPOSE. `Object.fromEntries` is typed to
 *  return `{ [k: string]: V }` — TypeScript cannot carry the key type through
 *  it, so *some* assertion is unavoidable for any loop-built total record. The
 *  point is that there is now exactly ONE, it is three lines from its
 *  justification, and it is discharged by the callers' exhaustiveness proofs
 *  rather than by hope. ⛔ That is only true while callers pass a proven list:
 *  handing this a plain `Union[]` variable compiles and proves NOTHING.
 *
 *  ⚠ `K extends PropertyKey`, not `string`: some closed key sets are NUMERIC
 *  (`ContactListCount = 2 | 3 | 4 | 5`). JS object keys are strings either way,
 *  which is exactly what the `{} as Record<…>` accumulators produced before, so
 *  this changes types only — never the runtime shape. */
export const totalRecord = <K extends PropertyKey, V>(
  keys: readonly K[],
  make: (key: K) => V,
): Record<K, V> =>
  Object.fromEntries(keys.map((key) => [key, make(key)])) as Record<K, V>;
