/** Canonical form + stable hashing for recipes.
 *
 *  Why this exists:
 *    - Cache keys: the engine caches per-recipe; a stable hash over the
 *      recipe content gives a collision-free key that changes when the
 *      recipe does.
 *    - Integrity: marketplace download → canonical JSON string → SHA-256
 *      via Web Crypto. This module gives you the canonical string; the
 *      caller supplies the cryptographic hash if they need one.
 *    - Diffing: two recipes with the same meaning but different key order
 *      should compare equal. `recipesEqual` + `normalizeRecipe` are the
 *      primitives a future `diffRecipes(before, after)` will build on.
 *    - Change detection: Kitchen UI detects "user has unsaved changes" by
 *      comparing the current editor state's hash to the last-saved hash.
 *
 *  Canonicalization rules (intentionally minimal — we preserve meaning):
 *    1. Object keys sorted lexicographically at every depth.
 *    2. Arrays preserve order (arrays are ordered data — reordering would
 *       change the recipe's meaning, e.g. step execution order).
 *    3. `undefined` properties dropped (already dropped by JSON.stringify
 *       but we normalize so recipesEqual compares cleanly).
 *    4. Primitives unchanged (no string trimming, case folding, or number
 *       coercion — all of those could alter meaning).
 *    5. null preserved.
 *    6. Non-serializable values (functions, symbols, cycles) are not
 *       handled — recipes are JSON, so this is by design.
 *
 *  The hash is FNV-1a 32-bit, NOT cryptographic. It is deterministic,
 *  fast, and has good dispersion for cache-key use. If you need integrity
 *  verification, use `canonicalJsonString` + Web Crypto SHA-256.
 */

/** Deeply clone a value with object keys sorted at every depth. Arrays
 *  preserve their original order. Returns a new object — the input is
 *  never mutated. */
export const normalizeRecipe = <T = unknown>(input: T): T => {
  return normalize(input) as T;
};

const normalize = (v: unknown): unknown => {
  if (v === null) return null;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(normalize);
  const sortedKeys = Object.keys(v as Record<string, unknown>).sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    const val = (v as Record<string, unknown>)[k];
    if (val === undefined) continue; // drop undefined — matches JSON semantics
    Object.defineProperty(out, k, {
      value: normalize(val),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
};

/** Serialize a recipe to its canonical JSON string form. The output is
 *  deterministic — same recipe content yields the exact same string
 *  regardless of the original key order. No whitespace. */
export const canonicalJsonString = (recipe: unknown): string =>
  JSON.stringify(normalize(recipe));

/** Compare two recipes for deep equality after canonicalization.
 *  Two recipes with the same fields in different key order are equal. */
export const recipesEqual = (a: unknown, b: unknown): boolean =>
  canonicalJsonString(a) === canonicalJsonString(b);

/** Stable non-cryptographic hash of a recipe.
 *
 *  Algorithm: FNV-1a 32-bit over the UTF-16 code units of the canonical
 *  JSON string. Output is an 8-character lowercase hex string.
 *
 *  Properties:
 *    - Deterministic: same recipe → same hash, across runs and platforms.
 *    - Order-insensitive for object keys: `{a:1,b:2}` and `{b:2,a:1}` hash
 *      identically because normalization sorts keys first.
 *    - Array-order sensitive: reordering steps changes the hash.
 *    - ~1 in 4 billion collision probability — fine for cache keys. For
 *      integrity, use canonicalJsonString + SHA-256 via Web Crypto. */
export const hashRecipe = (recipe: unknown): string => {
  const str = canonicalJsonString(recipe);
  return fnv1a32(str);
};

/** FNV-1a 32-bit hash. Operates on UTF-16 code units (charCodeAt), which
 *  is fine because the input is always a JSON string — all characters are
 *  in the BMP or are surrogate pairs that hash consistently as pairs.
 *
 *  Reference: http://isthe.com/chongo/tech/comp/fnv/#FNV-1a
 *  Offset basis: 0x811c9dc5, prime: 0x01000193. */
const fnv1a32 = (str: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // 32-bit multiply with prime. Math.imul stays within int32 range and
    // is much faster than `(hash * prime) >>> 0` for long strings.
    hash = Math.imul(hash, 0x01000193);
  }
  // Coerce to unsigned 32-bit and pad to 8 hex chars
  return (hash >>> 0).toString(16).padStart(8, '0');
};
