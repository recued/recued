/** Reverse an update's actual field changes. The host supplies lossless values
 * from the write transaction; display snapshots alone are not undo material. */
export const reverseLocalUpdate = (
  fields: readonly { key: string; before: unknown; after: unknown; beforePresent: boolean }[],
): { set: Record<string, unknown>; unset: string[] } | null => {
  const entries: [string, unknown][] = [];
  const unset: string[] = [];
  for (const field of fields) {
    if (JSON.stringify(field.before) === JSON.stringify(field.after) && field.beforePresent) continue;
    if (!field.beforePresent) {
      if (field.after !== undefined) unset.push(field.key);
    } else entries.push([field.key, field.before]);
  }
  return entries.length || unset.length ? { set: Object.fromEntries(entries), unset } : null;
};
