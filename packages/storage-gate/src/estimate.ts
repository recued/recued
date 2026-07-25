/** Size estimation for gated writes (Phase B).
 *
 *  The storage gate's `canWrite(bytes, ...)` contract requires callers
 *  to pass a byte count. Each gated surface wraps its own write path
 *  with `estimateSize(payload)` so the gate sees a consistent,
 *  reproducible number. The number does NOT have to match the exact
 *  on-disk footprint byte-for-byte — indexes, row overhead, and blob-
 *  store fragmentation all add their own constants the gate treats as
 *  part of the reserve headroom. What matters is that:
 *
 *    - the same input always yields the same number (no Math.random,
 *      no Date.now, no TextEncoder quirks that depend on the
 *      environment), and
 *    - the number is close enough to reality that the gate's
 *      pressure / blocked thresholds kick in before the filesystem
 *      actually runs out of space.
 *
 *  Implementation: stable JSON byte length (UTF-8). For Buffer /
 *  ArrayBuffer / Uint8Array (CAS blob paths), the byte length of the
 *  binary payload itself — JSON-wrapping those just wastes cycles. */

const JSON_KEY_SET = (() => {
  const cached = new Set<string>();
  return {
    /** Stable key ordering — sorts lexicographically. Matches the same
     *  guarantee the audit / vault / shared-store canonicalisation uses,
     *  so two structurally-identical payloads always produce the same
     *  byte count. */
    sort(keys: string[]): string[] {
      cached.clear();
      for (const k of keys) cached.add(k);
      return [...cached].sort();
    },
  };
})();

/** Stringify `value` into a canonical JSON form: object keys sorted
 *  lexicographically, no insignificant whitespace, cycle detection.
 *  Deterministic for a given input. Used internally by `estimateSize`;
 *  exported for callers that need the canonical form itself (hashers,
 *  audit diffs, etc.).
 *
 *  JSON.stringify semantics are preserved where sensible:
 *   - `undefined` / function / symbol property values are DROPPED from
 *     objects (they also become `null` at array positions).
 *   - `NaN` / `Infinity` stringify as `'null'`.
 *   - circular references substitute `'null'` at the back-edge rather
 *     than throwing.
 *   - `BigInt` becomes the string form of the integer (JSON.stringify
 *     would throw; defensive since we don't want estimate to surface
 *     BigInt errors to callers). */
export const canonicalJson = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, inObjectProperty: boolean): string | null => {
    // JSON rules differ between array positions and object property
    // values for "drop-worthy" inputs (undefined, function, symbol):
    // arrays serialise them as `null`; objects drop them entirely.
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
      return inObjectProperty ? null : 'null';
    }
    if (v === null) return 'null';
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return 'null'; // NaN / Infinity.
      return JSON.stringify(v);
    }
    if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'bigint') return JSON.stringify(v.toString());
    if (Array.isArray(v)) {
      if (seen.has(v)) return 'null';
      seen.add(v);
      const parts = v.map((item) => walk(item, false) ?? 'null');
      seen.delete(v);
      return `[${parts.join(',')}]`;
    }
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      if (seen.has(obj)) return 'null';
      seen.add(obj);
      const keys = JSON_KEY_SET.sort(Object.keys(obj));
      const parts: string[] = [];
      for (const k of keys) {
        const valueStr = walk(obj[k], true);
        if (valueStr === null) continue; // Dropped property.
        parts.push(`${JSON.stringify(k)}:${valueStr}`);
      }
      seen.delete(obj);
      return `{${parts.join(',')}}`;
    }
    return 'null';
  };
  return walk(value, false) ?? 'null';
};

const utf8Encoder = new TextEncoder();

/** Estimate the byte cost of storing `value`.
 *
 *  - `Buffer` / `Uint8Array` / `ArrayBuffer` — the byte length itself
 *    (CAS blob path stores these raw).
 *  - `string` — UTF-8 byte length.
 *  - anything else — UTF-8 byte length of the canonical JSON form.
 *
 *  Never negative, never NaN. Returns 0 only for truly empty payloads
 *  (empty string, empty object, empty array, null, undefined). */
export const estimateSize = (value: unknown): number => {
  if (value === null || value === undefined) return 4; // "null"
  if (typeof value === 'string') return utf8ByteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  // Node Buffer is a Uint8Array subclass; already covered above.
  const json = canonicalJson(value);
  return utf8ByteLength(json);
};

/** UTF-8 byte length of a string. Uses TextEncoder for accuracy with
 *  multi-byte characters; falls back to length*4 if TextEncoder is
 *  unavailable (defensive — every target runtime has it). */
export const utf8ByteLength = (s: string): number => {
  if (typeof s !== 'string') return 0;
  try {
    return utf8Encoder.encode(s).byteLength;
  } catch {
    return s.length * 4;
  }
};

/** Sum `estimateSize` over many items. Prefer calling this in one
 *  batch than calling `estimateSize` in a loop — matches the summed-
 *  write pattern the pruner + cascade use. */
export const estimateTotalSize = (values: Iterable<unknown>): number => {
  let total = 0;
  for (const v of values) total += estimateSize(v);
  return total;
};
