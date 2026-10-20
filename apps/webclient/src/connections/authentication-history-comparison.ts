import type { PreparedAuthenticationHistoryDownload } from './authentication-history-export.js';
import type { OpenedAuthenticationHistoryFile } from './authentication-history-saved-file.js';

type Report = PreparedAuthenticationHistoryDownload['report'];
export type ComparableHistorySnapshot = PreparedAuthenticationHistoryDownload & {
  readonly report: Extract<Report, { format: 'recued.connection-history' }>;
};
export type HistoryComparisonKind = 'comparison_only' | 'changed' | 'baseline_only' | 'unchanged';
export const historyComparisonLabels = Object.freeze({ comparison_only: 'Only in comparison', changed: 'Changed saved data', baseline_only: 'Only in baseline', unchanged: 'Same saved data' } satisfies Record<HistoryComparisonKind, string>);
export interface HistoryComparisonRow {
  readonly type: Report['entries'][number]['type']; readonly id: string; readonly kind: HistoryComparisonKind;
  readonly baseline_index?: number; readonly comparison_index?: number;
  /** Top-level saved record fields; outcome is the entry's recorded outcome. */
  readonly fields: readonly string[];
}
export class HistoryComparisonError extends Error {
  constructor(readonly code: 'report_required' | 'aliases') {
    super(code === 'aliases' ? 'Use Names and IDs reports. Aliases are assigned separately in each file and cannot be matched across files.'
      : 'Choose a complete history report in Names and IDs mode. Single records and related history bundles cannot be compared as reports.');
  }
}

/** Inputs come only from the checked immutable local-file opener. A related
 * bundle's synthetic preview report must not be mistaken for a full report. */
export const authenticationHistoryComparisonSnapshot = (source: OpenedAuthenticationHistoryFile): ComparableHistorySnapshot => {
  if (source.kind !== 'report' || source.bundle) throw new HistoryComparisonError('report_required');
  if (source.snapshot.report.format !== 'recued.connection-history') throw new HistoryComparisonError('aliases');
  return source.snapshot as ComparableHistorySnapshot;
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
// Object insertion order is not evidence of a change. Array order is retained
// data, and remains significant. JSON numbers use numeric equality: -0 and 0
// are the same saved value. Checked reports have bounded schemas/depth.
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, index) => same(value, b[index]));
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
};
const key = (entry: Report['entries'][number]): string => entry.type + ':' + entry.record.id;
export const compareAuthenticationHistorySnapshots = (before: OpenedAuthenticationHistoryFile, after: OpenedAuthenticationHistoryFile) => {
  const baseline = authenticationHistoryComparisonSnapshot(before), comparison = authenticationHistoryComparisonSnapshot(after);
  const counts: Record<HistoryComparisonKind, number> = { comparison_only: 0, changed: 0, baseline_only: 0, unchanged: 0 };
  const rows: HistoryComparisonRow[] = []; const remaining = new Map(baseline.report.entries.map((entry, index) => [key(entry), index]));
  comparison.report.entries.forEach((entry, index) => {
    const baselineIndex = remaining.get(key(entry)); const fields: string[] = [];
    if (baselineIndex !== undefined) {
      remaining.delete(key(entry)); const previous = baseline.report.entries[baselineIndex]!;
      if (previous.outcome !== entry.outcome) fields.push('outcome');
      const a = previous.record as unknown as Record<string, unknown>, b = entry.record as unknown as Record<string, unknown>;
      for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) if (!same(a[field], b[field])) fields.push(field);
    }
    const kind = baselineIndex === undefined ? 'comparison_only' : fields.length ? 'changed' : 'unchanged'; counts[kind]++;
    rows.push(Object.freeze({ type: entry.type, id: entry.record.id, kind, ...(baselineIndex === undefined ? {} : { baseline_index: baselineIndex }), comparison_index: index, fields: Object.freeze(fields) }));
  });
  for (const index of remaining.values()) {
    const entry = baseline.report.entries[index]!; counts.baseline_only++;
    rows.push(Object.freeze({ type: entry.type, id: entry.record.id, kind: 'baseline_only', baseline_index: index, fields: Object.freeze([]) }));
  }
  return Object.freeze({ baseline, comparison, rows: Object.freeze(rows), counts: Object.freeze(counts),
    scope_matches: same(baseline.report.scope, comparison.report.scope), filters_match: same(baseline.report.filters, comparison.report.filters),
    capture_order: comparison.report.exported_at < baseline.report.exported_at ? 'earlier' as const : comparison.report.exported_at === baseline.report.exported_at ? 'same' as const : 'later' as const });
};
export type AuthenticationHistoryComparison = ReturnType<typeof compareAuthenticationHistorySnapshots>;

export type HistoryComparisonSavedValue = { readonly present: false } | { readonly present: true; readonly json: string };
/** Read only a changed top-level field from its checked, captured source entries.
 * Missing fields are distinct from false, zero, empty strings and empty arrays.
 * Compact formatting keeps large values within their checked source size. */
export const authenticationHistoryComparisonFieldValues = (capture: AuthenticationHistoryComparison, index: number, field: string) => {
  const row = capture.rows[index];
  if (!row || row.kind !== 'changed' || !row.fields.includes(field) || row.baseline_index === undefined || row.comparison_index === undefined)
    throw new Error('Choose a changed saved field.');
  const read = (snapshot: ComparableHistorySnapshot, position: number): HistoryComparisonSavedValue => {
    const entry = snapshot.report.entries[position]!;
    const source = (field === 'outcome' ? entry : entry.record) as unknown as Record<string, unknown>;
    if (!Object.hasOwn(source, field)) return Object.freeze({ present: false });
    const json = JSON.stringify(source[field]);
    if (json === undefined) throw new Error('This saved field is unavailable.');
    return Object.freeze({ present: true, json: json.length <= 4096 ? JSON.stringify(source[field], null, 2) : json });
  };
  return Object.freeze({ baseline: read(capture.baseline, row.baseline_index), comparison: read(capture.comparison, row.comparison_index) });
};
