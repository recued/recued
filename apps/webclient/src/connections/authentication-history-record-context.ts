import { AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES } from '@recued/contracts';
import type { PreparedAuthenticationHistoryDownload } from './authentication-history-export.js';
import type { AuthenticationHistoryRelatedBundle } from './authentication-history-related-bundle.js';

type Entry = PreparedAuthenticationHistoryDownload['report']['entries'][number];
type Source = AuthenticationHistoryRelatedBundle['report']['source_snapshot'];
export const AUTHENTICATION_HISTORY_RECORD_FORMAT = 'recued.connection-history.record';
export interface AuthenticationHistoryRecordContext {
  readonly source_snapshot: Source;
  readonly source_position?: number;
}
export interface AuthenticationHistoryContextRecord extends AuthenticationHistoryRecordContext {
  readonly format: typeof AUTHENTICATION_HISTORY_RECORD_FORMAT;
  readonly version: 1;
  readonly privacy_mode: 'full' | 'aliases';
  readonly alias_scope?: 'source_snapshot';
  readonly evidence: 'retained_local_observations';
  readonly current_authentication: 'not_checked';
  readonly entry: Entry;
}

/** Capture known source metadata without treating a related subset's local
 * indices as original positions. Only its root retains that position. */
export const authenticationHistoryRecordContext = (snapshot: PreparedAuthenticationHistoryDownload, index: number,
  bundle?: AuthenticationHistoryRelatedBundle): AuthenticationHistoryRecordContext => {
  const entry = snapshot.report.entries[index];
  if (!Number.isInteger(index) || index < 0 || !entry) throw new Error('Choose a saved history record.');
  const source = snapshot.report;
  const source_snapshot: Source = bundle?.report.source_snapshot ?? Object.freeze({
    format: source.format, version: source.version, exported_at: source.exported_at, scope: source.scope,
    filters: source.filters, retention_days: source.retention_days, finished_record_limit: source.finished_record_limit, entry_count: source.entry_count,
  });
  const position = bundle ? entry.type === 'incident' && entry.record.id === bundle.report.root.id ? bundle.report.root.source_position : undefined : index + 1;
  return Object.freeze({ source_snapshot, ...(position === undefined ? {} : { source_position: position }) });
};

export const authenticationHistoryContextRecordFilename = (entry: Entry, context: AuthenticationHistoryRecordContext): string =>
  'recued-connection-history-record-' + (context.source_snapshot.format === 'recued.connection-history.aliases' ? 'aliases-' : '')
  + new Date(context.source_snapshot.exported_at).toISOString().replace(/[:.]/g, '-') + '-' + entry.type
  + (context.source_position === undefined ? '' : '-' + context.source_position) + '-with-context.json';

/** The entry and context come from checked, immutable previews. Keep aliases
 * in their original namespace; do not include other records or raw source JSON. */
export const prepareAuthenticationHistoryContextRecord = (entry: Entry, context: AuthenticationHistoryRecordContext) => {
  const aliases = context.source_snapshot.format === 'recued.connection-history.aliases';
  const envelope: AuthenticationHistoryContextRecord = Object.freeze({
    format: AUTHENTICATION_HISTORY_RECORD_FORMAT, version: 1, privacy_mode: aliases ? 'aliases' : 'full',
    ...(aliases ? { alias_scope: 'source_snapshot' as const } : {}),
    evidence: 'retained_local_observations', current_authentication: 'not_checked', source_snapshot: context.source_snapshot,
    ...(context.source_position === undefined ? {} : { source_position: context.source_position }), entry,
  });
  const json = JSON.stringify(envelope); const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) throw new Error('The record and its source context must fit within 8 MiB.');
  return Object.freeze({ filename: authenticationHistoryContextRecordFilename(entry, context), json, bytes, envelope });
};
