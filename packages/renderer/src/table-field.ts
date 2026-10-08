/** A table column's `field` names a PATH into the row (2026-10-07).
 *
 *  `value.pressure_score` is the score inside an enrichment entry,
 *  `properties.dealname` a HubSpot property, `attendees.0.email` the first
 *  attendee's address. 847 columns in 248 shipped recipes are written so.
 *
 *  ⛔ THREE SURFACES DRAW A TABLE, AND THEY DISAGREED. The owner's result panel
 *  read the path; this package's table block — the reception pages — and the
 *  server's text output read only a top-level key, so the same column showed a
 *  value in one and "—" in the others. One reader, used by all three, is what
 *  keeps them from drifting apart again.
 *
 *  - An own key that itself contains dots (`hs.lead_status`, a flattened
 *    vendor field) is matched whole before the path is split — at any depth,
 *    longest first, falling back to shorter splits when that branch ends.
 *  - A number indexes an array.
 *  - Only a row's own properties count: `__proto__`, `constructor` and
 *    `prototype` never resolve, and nothing inherited does.
 *  Anything else is `undefined`, which a cell shows as "—". */

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const walk = (value: unknown, segments: readonly string[]): unknown => {
  if (segments.length === 0) return value;
  if (value === null || typeof value !== 'object') return undefined;
  for (let take = segments.length; take >= 1; take -= 1) {
    const key = segments.slice(0, take).join('.');
    if (key.length === 0 || UNSAFE_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const found = walk((value as Record<string, unknown>)[key], segments.slice(take));
    if (found !== undefined) return found;
  }
  return undefined;
};

/** The value a table column shows for one row. */
export const tableFieldValue = (row: unknown, field: string): unknown =>
  typeof field === 'string' && field.length > 0 ? walk(row, field.split('.')) : undefined;
