/** Shared helpers for the `match-pattern-list` connection field (D-192 M4c-UI)
 *  — the messenger message→commitment TRIGGER editor. Repeatable rows anchored
 *  at `config.match_patterns`; the flat form values use
 *  `config.match_patterns.<i>.kind` / `.value` / `.mode`. `collectMatchPatternRows`
 *  reads them back (the renderer, the form validator, and the submit handler
 *  share ONE reader); `matchPatternRowsToPatterns` compiles the complete rows
 *  into the `MessageMatchPattern[]` the `setMatchPatterns` rpc takes. Mirrors
 *  `header-list.ts`.
 *
 *  UX only — the authoritative shape (kinds, caps, token grammar) lives in the
 *  contracts `validateMessageMatchPatterns`, which the server re-runs on the
 *  `setMatchPatterns` write. */

import type { MessageMatchPattern } from '@recued/contracts';

/** One trigger row as held in the flat form values. `index` is the form-value
 *  index (may be sparse after removals). A `kind` / `mode` of `''` is the
 *  unselected placeholder; `mode` is meaningful only for a `content` row. */
export interface MatchPatternRow {
  index: number;
  kind: string;
  value: string;
  mode: string;
}

/** Collect the present trigger rows from flat form values, sorted by index. A
 *  row is "present" when any of its `kind` / `value` / `mode` keys exists (so an
 *  added-but-empty row still renders). Ignores non-numeric indices + unknown
 *  sub-keys. */
export const collectMatchPatternRows = (
  values: Record<string, string>,
  baseKey: string,
): MatchPatternRow[] => {
  const prefix = `${baseKey}.`;
  const byIndex = new Map<number, MatchPatternRow>();
  for (const key of Object.keys(values)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length); // `<i>.kind` | `<i>.value` | `<i>.mode`
    const dot = rest.indexOf('.');
    if (dot < 0) continue;
    const idxStr = rest.slice(0, dot);
    const sub = rest.slice(dot + 1);
    if (!/^\d+$/.test(idxStr)) continue;
    if (sub !== 'kind' && sub !== 'value' && sub !== 'mode') continue;
    const index = Number(idxStr);
    const row = byIndex.get(index) ?? { index, kind: '', value: '', mode: '' };
    if (sub === 'kind') row.kind = values[key] ?? '';
    else if (sub === 'value') row.value = values[key] ?? '';
    else row.mode = values[key] ?? '';
    byIndex.set(index, row);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
};

/** A row is COMPLETE when it has both a kind and a (trimmed) value — the two
 *  the compile keeps and the validator requires together. */
export const isCompleteMatchPatternRow = (row: MatchPatternRow): boolean =>
  row.kind.length > 0 && row.value.trim().length > 0;

/** A row is HALF-FILLED when exactly one of (kind, value) is set — a validation
 *  error (mirrors the header-list half-filled check). */
export const isHalfFilledMatchPatternRow = (row: MatchPatternRow): boolean =>
  (row.kind.length > 0) !== (row.value.trim().length > 0);

/** Compile the collected rows into `MessageMatchPattern[]` — keeps only
 *  COMPLETE rows; `mode` rides only a `content` row (and only when non-blank —
 *  an unselected mode omits the field, which the matcher defaults to
 *  `contains`). An unknown `kind` is dropped. The server re-validates. */
export const matchPatternRowsToPatterns = (
  rows: readonly MatchPatternRow[],
): MessageMatchPattern[] => {
  const out: MessageMatchPattern[] = [];
  for (const row of rows) {
    if (!isCompleteMatchPatternRow(row)) continue;
    const value = row.value.trim();
    if (row.kind === 'content') {
      const mode = row.mode.trim();
      out.push(mode.length > 0 ? { kind: 'content', value, mode: mode as 'contains' | 'word' } : { kind: 'content', value });
    } else if (row.kind === 'tag' || row.kind === 'mention') {
      out.push({ kind: row.kind, value });
    }
  }
  return out;
};
