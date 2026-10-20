import type { PreparedAuthenticationHistoryDownload } from './authentication-history-export.js';
import { normalizePreviewSearch, previewMatchedText, type PreviewHighlight } from './authentication-history-preview-excerpt.js';
export { normalizePreviewSearch } from './authentication-history-preview-excerpt.js';

type PreviewEntry = PreparedAuthenticationHistoryDownload['report']['entries'][number];
export type PreviewPath = readonly (string | number)[];
export const PREVIEW_MATCH_PAGE_SIZE = 5;
export const previewRecordTypes = { incident: 'Incident', repair: 'Repair', verification: 'Access check', renewal: 'Token-renewal check' } as const;
export const previewRecordedOutcomes = { open: 'Open incident', recovered: 'Recorded recovery', retired: 'Closed without confirmed recovery', running: 'Running',
  applied: 'Repair applied', failed: 'Failed', passed: 'Recorded check passed', unconfirmed: 'Unconfirmed' } as const;
const titles: Record<string, string> = { id: 'Record or reference ID', exported_at: 'Snapshot captured (UTC)', scope: 'Selected scope', filters: 'Applied filters',
  entry_count: 'Retained record count', retention_days: 'Retention in days', finished_record_limit: 'Finished-record retention limit',
  current_authentication: 'Current authentication', search_applied: 'Search used (text removed)', authentication_revision: 'Authentication fingerprint',
  at: 'Event time (UTC)', started_at: 'Started (UTC)', finished_at: 'Finished (UTC)', ended_at: 'Closed (UTC)', history_started_at: 'History recording began (UTC)',
  targets_truncated: 'Some resources omitted', incidents_truncated: 'Some incident links omitted', events_truncated: 'Some events omitted',
  details_truncated: 'Some details omitted', references_incomplete: 'Some references missing', incomplete: 'Some inventory missing',
  usage_available: 'Usage inventory available', current: 'Authentication still matches', currently_reported: 'Problem reported in saved observation',
  app_reference: 'Unqualified app reference', from: 'Previous authentication', to: 'Selected authentication', revision: 'Authorization fingerprint' };
const words = (value: string): string => value.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
export const previewTitle = (key: string): string => titles[key] ?? words(key);
const enumKeys = new Set(['kind', 'type', 'status', 'reason', 'action', 'code', 'current', 'current_authentication', 'authentication', 'evidence', 'retirement_reason']);
export const previewScalarText = (key: string, data: unknown): string => {
  if (typeof data === 'number' && (key === 'at' || key.endsWith('_at'))) return new Date(data).toISOString();
  if (typeof data === 'boolean') return data ? 'Yes' : 'No';
  if (typeof data === 'string') return enumKeys.has(key) ? words(data) : data;
  return typeof data === 'number' ? String(data) : '';
};
const pathKey = (path: PreviewPath): string => {
  for (let index = path.length - 1; index >= 0; index--) if (typeof path[index] === 'string') return path[index] as string;
  return '';
};
export const previewFieldTitle = (path: PreviewPath): string => {
  if (path.length === 1 && path[0] === 'type') return 'Record type';
  if (path.length === 1 && path[0] === 'outcome') return 'Recorded outcome';
  const last = path[path.length - 1]; return typeof last === 'number' ? 'Item ' + (last + 1) : previewTitle(last ?? '');
};
export const previewPathLabel = (path: PreviewPath): string => (path[0] === 'record' ? path.slice(1) : path)
  .map(part => typeof part === 'number' ? 'Item ' + (part + 1) : path.length === 1 ? previewFieldTitle(path) : previewTitle(part)).join(' › ');
export const previewFieldText = (path: PreviewPath, data: unknown): string => {
  if (path.length === 1 && typeof data === 'string') {
    const labels = path[0] === 'type' ? previewRecordTypes : path[0] === 'outcome' ? previewRecordedOutcomes : undefined;
    if (labels && Object.hasOwn(labels, data)) {
      const label = (labels as Readonly<Record<string, string>>)[data]!;
      return normalizePreviewSearch(label) === normalizePreviewSearch(data) ? label : `${label} (${data})`;
    }
  }
  return previewScalarText(pathKey(path), data);
};

interface PreviewField { path: PreviewPath; label?: string; values: readonly string[]; display: string }
function* fields(data: unknown, path: PreviewPath, named = true): Generator<PreviewField> {
  const scalar = typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean';
  if (scalar) {
    const raw = String(data); const display = previewFieldText(path, data);
    yield { path, ...(named ? { label: previewFieldTitle(path) } : {}), values: raw === display ? [raw] : [raw, display],
      display: normalizePreviewSearch(raw) === normalizePreviewSearch(display) || display.endsWith(` (${raw})`) ? display : `${display} (${raw})` };
  } else if (data && typeof data === 'object') {
    if (named) yield { path, label: previewFieldTitle(path), values: [], display: Array.isArray(data) ? data.length + ' items' : 'Saved details' };
    if (Array.isArray(data)) { for (let index = 0; index < data.length; index++) yield* fields(data[index], [...path, index], false); }
    else { for (const [key, value] of Object.entries(data)) yield* fields(value, [...path, key]); }
  }
}
function* entryFields(entry: PreviewEntry): Generator<PreviewField> {
  yield* fields(entry.type, ['type']); yield* fields(entry.outcome, ['outcome']); yield* fields(entry.record, ['record'], false);
}
/** Only prepared public fields enter either the index or the match locations. */
export const previewSearchText = (entry: PreviewEntry): string => {
  const values: string[] = [];
  for (const field of entryFields(entry)) { if (field.label) values.push(field.label); values.push(...field.values); }
  return normalizePreviewSearch(values.join('\n'));
};
export interface PreviewMatch { path: PreviewPath; label: string; labelHighlights: readonly PreviewHighlight[]; value: string; valueHighlights: readonly PreviewHighlight[];
  source: 'Field name' | 'Saved value' | 'Field name and value' }
export const previewMatches = (entry: PreviewEntry, query: string, offset = 0): { total: number; matches: PreviewMatch[] } => {
  const needle = normalizePreviewSearch(query.trim()); const matches: PreviewMatch[] = []; let total = 0;
  if (!needle) return { total, matches };
  for (const field of entryFields(entry)) {
    const name = !!field.label && normalizePreviewSearch(field.label).includes(needle);
    const value = field.values.some(value => normalizePreviewSearch(value).includes(needle));
    if (!name && !value) continue;
    if (total >= offset && matches.length < PREVIEW_MATCH_PAGE_SIZE) {
      const label = previewPathLabel(field.path); const excerpt = previewMatchedText(field.display, value ? query : '', true);
      const fieldName = previewMatchedText(field.label ?? '', name ? query : ''); const labelOffset = label.length - fieldName.text.length;
      matches.push({ path: field.path, label, labelHighlights: fieldName.highlights.map(range => ({ start: range.start + labelOffset, end: range.end + labelOffset })),
        value: excerpt.text, valueHighlights: excerpt.highlights,
        source: name && value ? 'Field name and value' : name ? 'Field name' : 'Saved value' });
    }
    total++;
  }
  return { total, matches };
};
