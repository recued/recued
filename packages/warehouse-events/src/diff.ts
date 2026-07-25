/** Canonical-record diff — the `changed_fields` producer shared by
 *  every fat-event emit site (the watch poll loop, the D-128 vendor
 *  reconciler cycle, the webhook funnel). Lives here (the neutral
 *  event package) so backend modules on different layers don't import
 *  each other just to agree on what a changed field is. */

/** Flatten a canonical record to dotted leaf paths. Plain nested
 *  objects recurse (`key_dates.close_date`); arrays + scalars + null
 *  are leaves. */
const flattenLeaves = (
  record: Record<string, unknown>,
  prefix = '',
  out: Map<string, unknown> = new Map(),
): Map<string, unknown> => {
  for (const [key, value] of Object.entries(record)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenLeaves(value as Record<string, unknown>, path, out);
    } else {
      out.set(path, value);
    }
  }
  return out;
};

/** Canonical field keys whose values differ — dotted leaf paths over
 *  the union of both records, compared by stable serialization. */
export const diffChangedFields = (
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] => {
  const a = flattenLeaves(prev);
  const b = flattenLeaves(next);
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  const changed: string[] = [];
  for (const key of keys) {
    const va = a.get(key);
    const vb = b.get(key);
    if (va === vb) continue;
    if (JSON.stringify(va ?? null) !== JSON.stringify(vb ?? null)) changed.push(key);
  }
  return changed.sort();
};
