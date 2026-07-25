/** source_mirror — canonical-record hashing (D-192 P1.5 extraction).
 *
 *  The ONE hash convention every Source-mirror reconciler shares, lifted
 *  from the D-190 generic CRM reconciler (and the D-129/D-130 per-vendor
 *  `_fnv1a.ts` copies, whose Salesforce comment recorded exactly this
 *  lift: "when a third vendor needs the same util, lift to a shared
 *  helper"). Zero vendor coupling — pure functions over projected
 *  canonical records.
 *
 *  Change suppression, cascade invalidation, and conflict detection all
 *  key off these hashes, so there must be exactly one home for the
 *  convention: order-insensitive stable serialization × identity-field
 *  exclusion × FNV-1a. */

/** FNV-1a 32-bit hash. Same algorithm as `packages/recipes/src/canonical.ts`'s
 *  internal `fnv1a32`. Deterministic + order-sensitive over its input
 *  string — pair with `stableStringify` for order-insensitive record
 *  hashing.
 *
 *  Reference: http://isthe.com/chongo/tech/comp/fnv/#FNV-1a
 *  Offset basis: 0x811c9dc5, prime: 0x01000193. Returns lowercase hex
 *  padded to 8 chars. */
export const fnv1aHex = (str: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/** Order-insensitive stable serialization for hashing: sorts object keys
 *  recursively so a re-ordered projection (or a key-order quirk) can never
 *  false-diff a record that didn't actually change. */
export const stableStringify = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
};

/** The canonical fields minus the identity key — `id` is the row KEY
 *  (the mirror's `target_id` / `source_record_id`), constant per record,
 *  not a semantic field whose change should refresh the snapshot.
 *  Matches the hb/sf reconciler convention (their `toMeta` projects no
 *  `id`). */
export const canonicalFields = (record: Record<string, unknown>): Record<string, unknown> => {
  const { id: _id, ...rest } = record;
  return rest;
};

/** The canonical record hash: `fnv1a:<hex>` over the stable
 *  serialization of the record's non-identity fields. */
export const hashCanonical = (record: Record<string, unknown>): string =>
  `fnv1a:${fnv1aHex(stableStringify(canonicalFields(record)))}`;
