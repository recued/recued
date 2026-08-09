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

/** Which sub-key holds a row's NAME. `header_name` for header auth,
 *  `field_name` for `body_field` auth — the only difference between the two
 *  list fields, so they share one renderer, one validator and one projector.
 *
 *  ⚠ Derived from the FIELD TYPE, never passed separately: a name key that
 *  travelled independently of the field it describes is a second thing to keep
 *  in step, and the three consumers would each have their own chance to get it
 *  wrong. */
export const nameKeyForListField = (
  type: 'header-list' | 'body-field-list',
): 'header_name' | 'field_name' =>
  (type === 'body-field-list' ? 'field_name' : 'header_name');

/** One list row as held in the flat form values. `index` is the form-value
 *  index (may be sparse after removals — the payload projector compacts it).
 *  `name` is the row's name whichever sub-key carried it. */
export interface HeaderRow {
  index: number;
  /** @deprecated Read `name`. Retained so existing header-list call sites and
   *  their tests keep compiling; always equal to `name`. */
  header_name: string;
  name: string;
  value: string;
}

/** Collect the present rows from flat form values, sorted by index. A row is
 *  "present" when either its name key or its `value` key exists in `values` (so
 *  an added-but-empty row still renders). Ignores non-numeric indices and any
 *  sub-key other than the name key / `value`. */
export const collectHeaderRows = (
  values: Record<string, string>,
  baseKey: string,
  nameKey: 'header_name' | 'field_name' = 'header_name',
): HeaderRow[] => {
  const prefix = `${baseKey}.`;
  const byIndex = new Map<number, HeaderRow>();
  for (const key of Object.keys(values)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length); // `<i>.<nameKey>` | `<i>.value`
    const dot = rest.indexOf('.');
    if (dot < 0) continue;
    const idxStr = rest.slice(0, dot);
    const sub = rest.slice(dot + 1);
    if (!/^\d+$/.test(idxStr)) continue;
    if (sub !== nameKey && sub !== 'value') continue;
    const index = Number(idxStr);
    const row = byIndex.get(index) ?? { index, header_name: '', name: '', value: '' };
    if (sub === nameKey) {
      row.name = values[key] ?? '';
      row.header_name = row.name;
    } else row.value = values[key] ?? '';
    byIndex.set(index, row);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
};
