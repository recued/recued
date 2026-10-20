import { AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES } from '@recued/contracts';
import { historyComparisonLabels, type AuthenticationHistoryComparison, type ComparableHistorySnapshot, type HistoryComparisonKind } from './authentication-history-comparison.js';
import { previewRecordTypes, previewRecordedOutcomes, previewTitle } from './authentication-history-preview-fields.js';

// Preserve literal source identifiers without allowing line or bidi controls to
// become new structural entries in the readable support text.
const literal = (value: string): string => JSON.stringify(value).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
  char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
const incomplete = (snapshot: ComparableHistorySnapshot): number => snapshot.report.entries.filter(entry => Object.entries(entry.record)
  .some(([key, value]) => value === true && ['events_truncated', 'details_truncated', 'targets_truncated', 'incidents_truncated', 'incomplete', 'references_incomplete'].includes(key))).length;

/** A summary of the complete checked pair, independent of table UI state.
 * Field values, labels, source filenames, search text and fingerprints stay out.
 * Never truncate a summary or copy a partial result when it exceeds the bound. */
export const prepareAuthenticationHistoryComparisonSummary = (capture: AuthenticationHistoryComparison): { readonly filename: string; readonly text: string; readonly bytes: number; readonly differences: number } => {
  const lines: string[] = [], encoder = new TextEncoder(); let bytes = 0;
  const add = (line = ''): void => {
    bytes += encoder.encode(line).byteLength + (lines.length ? 1 : 0);
    if (bytes > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) throw new Error('Comparison summary is too large.');
    lines.push(line);
  };
  const differences = capture.rows.filter(row => row.kind !== 'unchanged');
  add('Recued saved history comparison summary');
  add('Privacy: names and IDs (local use). Review before sharing.');
  add('Saved observations and source claims only. Current vendor access was not checked.');
  add('Coverage: all differences in the captured pair. Table filters, ID search, paging and expanded fields do not change this summary.');
  add('Detailed field values, account/app labels, source filenames and search text are omitted. Inspect the source records for all retained fields.');
  add('Matches use saved record type and ID. Source server and vendor account were not verified; use reports from the same Recued server.');
  add('One-sided inclusion does not establish incident creation, recovery, deletion or revoked access. Array order changes count as changed saved data.');
  add('Repairs, protected reads, token renewal and recorded recovery are separate evidence. Their order does not establish causation.');
  add('Read checks do not verify sending, editing, all resources or future work. Token renewal does not establish protected-resource access.');
  add('Source scopes ' + (capture.scope_matches ? 'match.' : 'differ; record coverage can differ.'));
  add('Source filters ' + (capture.filters_match ? 'match.' : 'differ; record coverage can differ.'));
  add(capture.capture_order === 'same' ? 'Saved capture times are equal. Dates do not change the selected order.'
    : 'The comparison capture time is ' + capture.capture_order + ' than the baseline. Dates do not change the selected order.');
  for (const side of ['baseline', 'comparison'] as const) {
    const report = capture[side].report, scope = report.scope, filters = report.filters, title = side === 'baseline' ? 'Baseline' : 'Comparison';
    add(); add(title + ' source');
    add('Captured (UTC): ' + new Date(report.exported_at).toISOString());
    add('Source scope: ' + scope.kind + (scope.kind === 'connection' ? ' ' + literal(scope.name) : scope.kind === 'collection' ? ' ' + scope.platform + ' ' + literal(scope.slug)
      : scope.kind === 'file_source' ? ' ' + literal(scope.source_id) : scope.kind === 'group' ? ' ' + literal(scope.id) : '') + '.');
    const applied = [filters.type ? 'type ' + filters.type : '', filters.outcome ? 'outcome ' + filters.outcome : '',
      filters.from !== undefined ? 'from (inclusive UTC date) ' + filters.from : '', filters.through !== undefined ? 'through (inclusive UTC date) ' + filters.through : '',
      filters.search ? 'search applied (text omitted)' : ''].filter(Boolean);
    add('Applied source filters: ' + (applied.length ? applied.join('; ') + '.' : 'none.'));
    add('Retained records: ' + report.entry_count + '. Retention: ' + report.retention_days + ' days; finished-record limit: ' + report.finished_record_limit + '.');
    add('Records with saved incomplete-detail flags: ' + incomplete(capture[side]) + '. Zero does not establish complete history.');
  }
  add(); add('Captured comparison counts');
  for (const kind of Object.keys(historyComparisonLabels) as HistoryComparisonKind[]) add(historyComparisonLabels[kind] + ': ' + capture.counts[kind] + '.');
  add('Differences listed: ' + differences.length + '. Same saved data rows are counted, not listed.');
  add(); add('Saved record differences');
  if (!differences.length) add('No saved record differences in this captured pair.');
  for (const row of differences) {
    add('- ' + historyComparisonLabels[row.kind] + ': ' + previewRecordTypes[row.type] + ' ' + literal(row.id));
    if (row.fields.length) add('  Changed saved fields: ' + row.fields.map(field => literal(field) + ' (' + (field === 'outcome' ? 'Recorded outcome' : previewTitle(field)) + ')').join(', ') + '.');
    for (const side of ['baseline', 'comparison'] as const) {
      const position = side === 'baseline' ? row.baseline_index : row.comparison_index, title = side === 'baseline' ? 'Baseline' : 'Comparison';
      add(position === undefined ? '  ' + title + ': not included in this report.' : '  ' + title + ' source position: ' + (position + 1)
        + '; recorded outcome: ' + previewRecordedOutcomes[capture[side].report.entries[position]!.outcome] + '.');
    }
  }
  const stamp = (side: 'baseline' | 'comparison'): string => new Date(capture[side].report.exported_at).toISOString().replace(/[:.]/g, '-');
  return Object.freeze({ filename: 'recued-history-comparison-baseline-' + stamp('baseline') + '-comparison-' + stamp('comparison') + '.txt',
    text: lines.join('\n'), bytes, differences: differences.length });
};
