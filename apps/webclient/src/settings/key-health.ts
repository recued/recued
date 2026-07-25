/** D-148 § A.4 + § A.11 — Settings → Server → Key Health renderer.
 *
 *  Reads the server passport's `key_health` block + projects each
 *  key class into a row the UI renders. Rows order by status severity
 *  (overdue first, then warning, then healthy) so user attention is
 *  drawn to the rotations that matter.
 *
 *  The webclient never runs key-rotation flows itself — the actual
 *  rotation is server-side via `key.rotate.*` rpcs (P7). This module
 *  only renders + dispatches the trigger calls; the server is the
 *  authority.
 */

import type {
  KeyClass,
  KeyHealthBundle,
  KeyHealthEntry,
} from '@recued/contracts';

/** Severity ordering surfaced in the UI — overdue rows render first. */
export const KEY_HEALTH_STATUS_ORDER = ['overdue', 'warning', 'healthy'] as const;

export interface KeyHealthRow {
  key_class: KeyClass;
  status: 'healthy' | 'warning' | 'overdue';
  last_rotated_at?: number;
  /** True iff the entry's expiry is within the warning window
   *  (passport-derived). The UI maps to a localized warning chip. */
  expiry_warning?: boolean;
  /** True iff the class was marked compromised; survives rotation
   *  until cleared with explicit user action. The UI renders a
   *  prominent banner. */
  compromise_alert?: boolean;
}

const isHealthEntry = (value: unknown): value is KeyHealthEntry => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.status === 'healthy' || v.status === 'warning' || v.status === 'overdue';
};

const sortIndex = (status: 'healthy' | 'warning' | 'overdue'): number => {
  const idx = KEY_HEALTH_STATUS_ORDER.indexOf(status);
  return idx === -1 ? KEY_HEALTH_STATUS_ORDER.length : idx;
};

/** Build the rendered rows from the passport's projection. The
 *  passport carries the per-class entries verbatim — this function
 *  flattens into a typed array + sorts by status. */
export const buildKeyHealthRows = (bundle: KeyHealthBundle): KeyHealthRow[] => {
  const rows: KeyHealthRow[] = [];
  for (const [key_class, entry] of Object.entries(bundle) as [KeyClass, unknown][]) {
    if (!isHealthEntry(entry)) continue;
    const row: KeyHealthRow = { key_class, status: entry.status };
    if (entry.last_rotated_at !== undefined) row.last_rotated_at = entry.last_rotated_at;
    if (entry.expiry_warning !== undefined) row.expiry_warning = entry.expiry_warning;
    if (entry.compromise_alert !== undefined) row.compromise_alert = entry.compromise_alert;
    rows.push(row);
  }
  rows.sort((a, b) => {
    const sa = sortIndex(a.status);
    const sb = sortIndex(b.status);
    if (sa !== sb) return sa - sb;
    return a.key_class.localeCompare(b.key_class);
  });
  return rows;
};
