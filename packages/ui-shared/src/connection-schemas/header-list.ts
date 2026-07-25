/** Shared helpers for the `header-list` connection field (repeatable 1..N
 *  custom-header auth). The header-list anchors at a base key (`auth.headers`);
 *  the flat form values use `<base>.<i>.header_name` / `<base>.<i>.value`.
 *  `collectHeaderRows` reads those back into rows — used by the renderer (which
 *  rows to draw), the form validator (half-filled-row check), and the payload
 *  projector (compact + re-index). One reader so the three never diverge.
 *
 *  UX only: the authoritative shape (non-empty array, ≤ MAX_HEADER_AUTH_ENTRIES,
 *  prototype-safe non-empty name+value) lives in the contracts
 *  `validateHeaderAuthEntries`, which the server re-runs at enroll. */

/** One header row as held in the flat form values. `index` is the form-value
 *  index (may be sparse after removals — the payload projector compacts it). */
export interface HeaderRow {
  index: number;
  header_name: string;
  value: string;
}

/** Collect the present header rows from flat form values, sorted by index. A
 *  row is "present" when either its `header_name` or `value` key exists in
 *  `values` (so an added-but-empty row still renders). Ignores non-numeric
 *  indices and any sub-key other than `header_name` / `value`. */
export const collectHeaderRows = (
  values: Record<string, string>,
  baseKey: string,
): HeaderRow[] => {
  const prefix = `${baseKey}.`;
  const byIndex = new Map<number, HeaderRow>();
  for (const key of Object.keys(values)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length); // `<i>.header_name` | `<i>.value`
    const dot = rest.indexOf('.');
    if (dot < 0) continue;
    const idxStr = rest.slice(0, dot);
    const sub = rest.slice(dot + 1);
    if (!/^\d+$/.test(idxStr)) continue;
    if (sub !== 'header_name' && sub !== 'value') continue;
    const index = Number(idxStr);
    const row = byIndex.get(index) ?? { index, header_name: '', value: '' };
    if (sub === 'header_name') row.header_name = values[key] ?? '';
    else row.value = values[key] ?? '';
    byIndex.set(index, row);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
};
