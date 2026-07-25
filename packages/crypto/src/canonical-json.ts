/** D-148 — canonical JSON serializer for cryptographic signing.
 *
 *  Stable byte sequence used both at signing time and at verification
 *  time. Sender + verifier MUST produce the same bytes — diverging
 *  from this canonicalizer breaks the signature without any other
 *  visible failure.
 *
 *  Two flavors, one implementation:
 *
 *    - `canonicalJSONStringify` (lenient) — mirrors `JSON.stringify`
 *      semantics: non-finite numbers → `null`, undefined object values
 *      omitted, function/symbol values dropped. Used by audit signing,
 *      DDNS, ACME, handle ops, BridgeAuthority, recued-plan signing,
 *      pair-blob signing.
 *
 *    - `canonicalJSONStringifyStrict` (strict) — throws on non-finite
 *      numbers, BigInt, and function/symbol values. Used by Server
 *      Passport signing where any unexpected shape is a programming
 *      error that should fail loudly rather than produce silently-
 *      coerced bytes.
 *
 *  Shared discipline:
 *
 *   - Object keys sorted lexicographically (UTF-16 code-unit order via
 *     `Object.keys(...).sort()` — matches `JSON.stringify(... , Object.keys(o).sort())`).
 *   - No whitespace.
 *   - Primitives use `JSON.stringify` (string / boolean / null).
 *   - `undefined` keys on objects are omitted on BOTH modes (standard
 *     JSON behavior) so partial-shape rows + schema evolution stay
 *     compatible with prior signatures.
 *   - Top-level `undefined` throws on both modes.
 *
 *  Source of truth for both server (audit signing, BridgeAuthority
 *  signing, pair-blob signing, recued-plan signing, handle ops,
 *  Server Passport signing) and cloud (DDNS / ACME / handle-*
 *  verifiers via `@recued/crypto/canonical-json` sub-path import).
 *  Pinning to one shared module guarantees byte-identical
 *  canonicalization across the trust boundary. */

const canonicalize = (value: unknown, strict: boolean): string => {
  if (value === undefined) {
    throw new TypeError('canonicalJSONStringify: top-level undefined is invalid');
  }
  if (value === null) return 'null';
  if (typeof value === 'bigint') {
    if (strict) {
      throw new Error('canonicalJSONStringify: bigint not supported');
    }
    // Lenient: JSON.stringify natively throws TypeError on bigint —
    // same net effect, slightly different error class. Surface the
    // platform error.
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      if (strict) {
        throw new Error('canonicalJSONStringify: non-finite number');
      }
      return 'null';
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    // string / boolean / function / symbol top-level.
    if (typeof value === 'function' || typeof value === 'symbol') {
      if (strict) {
        throw new Error(
          `canonicalJSONStringify: unsupported type '${typeof value}' at top level`,
        );
      }
      // Lenient: JSON.stringify returns undefined for symbol/function
      // at top level. Pass through — caller gets undefined back, a
      // weird edge but consistent with JSON.stringify.
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
        if (strict) {
          throw new Error(
            `canonicalJSONStringify: non-JSON value at array index ${i}`,
          );
        }
        parts.push('null');
      } else {
        parts.push(canonicalize(v, strict));
      }
    }
    return '[' + parts.join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    // `undefined` values are always omitted on both modes — matches
    // `JSON.stringify` semantics and preserves backward compat with
    // signed payloads that grew optional fields over time.
    if (v === undefined) continue;
    if (typeof v === 'function' || typeof v === 'symbol') {
      if (strict) {
        throw new Error(
          `canonicalJSONStringify: non-JSON value at key '${k}'`,
        );
      }
      // Lenient: skip. Without this, recursion on a function/symbol
      // value falls through to `JSON.stringify(v)` which returns
      // `undefined`, and string concatenation coerces it to the
      // literal token "undefined" — producing invalid JSON like
      // `"k":undefined`.
      continue;
    }
    parts.push(JSON.stringify(k) + ':' + canonicalize(v, strict));
  }
  return '{' + parts.join(',') + '}';
};

/** Lenient canonical-JSON — mirrors `JSON.stringify` for non-JSON
 *  edge cases (non-finite numbers → null, function/symbol values
 *  dropped). The general-purpose signing serializer for D-148. */
export const canonicalJSONStringify = (value: unknown): string =>
  canonicalize(value, false);

/** Strict canonical-JSON — throws on non-finite numbers, BigInt, and
 *  function/symbol values rather than coercing or dropping silently.
 *  Used by Server Passport signing where any unexpected shape is a
 *  programming error. Identical byte output to the lenient variant
 *  for all JSON-clean inputs. */
export const canonicalJSONStringifyStrict = (value: unknown): string =>
  canonicalize(value, true);
