import { AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES, AUTHENTICATION_HISTORY_EXPORT_MAX_ENTRIES,
  isAuthenticationHistoryExport, authenticationHistoryExportReport, isAuthenticationIncidentHistoryFilters,
  authenticationHistoryExportRecord, authenticationHistoryEntryType, authenticationHistoryEntryOutcome,
  type AuthenticationHistoryExport, type AuthenticationHistoryPrivateExport, type AuthenticationHistoryPrivateEntry,
  type AuthenticationHistoryExportEntry, type AuthenticationIncidentScope, type AuthenticationRepairMethod } from '@recued/contracts';
import type { PreparedAuthenticationHistoryDownload } from './authentication-history-export.js';
import { createAuthenticationHistoryRelatedBundles, type AuthenticationHistoryRelatedBundle } from './authentication-history-related-bundle.js';
import { AUTHENTICATION_HISTORY_RECORD_FORMAT, authenticationHistoryContextRecordFilename, type AuthenticationHistoryRecordContext } from './authentication-history-record-context.js';
import { compareAuthenticationHistorySnapshots, type AuthenticationHistoryComparison } from './authentication-history-comparison.js';
import { AUTHENTICATION_HISTORY_COMPARISON_PAIR_FORMAT, prepareAuthenticationHistoryComparisonPair, type PreparedAuthenticationHistoryComparisonPair } from './authentication-history-comparison-pair.js';

export class AuthenticationHistoryFileError extends Error {
  constructor(readonly code: 'too_large' | 'invalid_json' | 'invalid_history' | 'unsupported_format' | 'unsupported_version') {
    super({ too_large: 'History JSON must fit within 8 MiB.', invalid_json: 'This content could not be read as history JSON.',
      invalid_history: 'This is not a valid history export, comparison pair, related history bundle or complete saved record.',
      unsupported_format: 'Open a Recued history export, comparison pair, related history bundle or complete saved record JSON.',
      unsupported_version: 'This history JSON uses an unsupported version. Update Recued or use version 1.' }[code]);
  }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const shape = (v: unknown, required: string, optional = ''): v is Record<string, unknown> => {
  if (!object(v)) return false;
  const keys = required.split(' '); const allowed = new Set([...keys, ...optional.split(' ')]);
  return keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => allowed.has(k));
};
const list = (v: unknown, check: (item: unknown) => boolean, max = 10000): boolean => Array.isArray(v) && v.length <= max && v.every(check);
const alias = (v: unknown, kind: string): v is string => typeof v === 'string' && v.startsWith(kind + '-')
  && /^[1-9][0-9]{0,15}$/.test(v.slice(kind.length + 1)) && Number.isSafeInteger(Number(v.slice(kind.length + 1)));
const privateTarget = (v: unknown, scope = false): boolean => object(v) && (
  (v.kind === 'oauth_apps' || scope && v.kind === 'all') && shape(v, 'kind')
  || scope && v.kind === 'group' && shape(v, 'kind id') && alias(v.id, 'group')
  || v.kind === 'connection' && shape(v, 'kind name') && alias(v.name, 'connection')
  || v.kind === 'file_source' && shape(v, 'kind source_id') && alias(v.source_id, 'file-source')
  || v.kind === 'collection' && shape(v, 'kind platform slug') && (v.platform === 'mail' || v.platform === 'calendar') && alias(v.slug, v.platform + '-account'));
const privateUse = (v: unknown): boolean => shape(v, 'kind id') && typeof v.kind === 'string'
  && ['pack', 'recipe', 'dish', 'schedule', 'mail', 'calendar', 'file'].includes(v.kind) && alias(v.id, 'use-' + v.kind);
const privateMethod = (v: unknown): boolean => shape(v, 'type', 'app_reference broker_profile_id broker_account_id connection_name')
  && (v.app_reference === undefined || alias(v.app_reference, 'app-reference'))
  && (v.broker_profile_id === undefined || alias(v.broker_profile_id, 'broker-profile'))
  && (v.broker_account_id === undefined || alias(v.broker_account_id, v.broker_profile_id === undefined ? 'unqualified-broker-account' : 'broker-account'))
  && (v.connection_name === undefined || alias(v.connection_name, 'connection'));

/** Check every private field and alias namespace before constructing validation
 * surrogates. Runtime lifecycle guards then check the same recorded semantics.
 * Surrogates never enter the preview, downloads, RPCs or stored history. */
const privateEntryShape = (v: unknown): v is AuthenticationHistoryPrivateEntry => {
  if (!shape(v, 'type outcome record') || !object(v.record)) return false;
  const r = v.record;
  if (v.type === 'incident') return shape(r, 'id status started_at history_started_at currently_reported level events_truncated details_truncated events group', 'last_problem_at ended_at retirement_reason recovery_evidence')
    && alias(r.id, 'incident') && (r.recovery_evidence === undefined || shape(r.recovery_evidence, 'earliest_at latest_at'))
    && list(r.events, e => shape(e, 'kind at level'), 32)
    && shape(r.group, 'id kind authentication usage_available connection_names targets uses issues') && alias(r.group.id, 'group')
    && list(r.group.connection_names, n => alias(n, 'connection'), 512) && list(r.group.targets, t => privateTarget(t), 2048) && list(r.group.uses, privateUse)
    && list(r.group.issues, i => shape(i, 'id code', 'observed_at secret_expires_on') && alias(i.id, 'issue'), 2048);
  if (v.type === 'repair') return shape(r, 'id action status started_at targets targets_truncated incidents incidents_truncated', 'finished_at reason restart_required from to')
    && alias(r.id, 'repair') && (r.from === undefined || privateMethod(r.from)) && (r.to === undefined || privateMethod(r.to))
    && list(r.targets, t => privateTarget(t), 64) && list(r.incidents, i => shape(i, 'id group_id') && alias(i.id, 'incident') && alias(i.group_id, 'group'), 64);
  if (v.type === 'verification') return shape(r, 'id status started_at targets_truncated usage_available selection results uses', 'finished_at')
    && alias(r.id, 'access-check') && shape(r.selection, 'kind id') && typeof r.selection.kind === 'string'
    && ['group', 'repair', 'verification', 'renewal'].includes(r.selection.kind)
    && alias(r.selection.id, r.selection.kind === 'verification' ? 'access-check' : r.selection.kind === 'renewal' ? 'token-renewal' : r.selection.kind)
    && list(r.uses, privateUse, 256) && list(r.results, result => shape(result, 'id target authentication_revision current checks')
      && alias(result.id, 'access-target') && alias(result.authentication_revision, 'authentication-revision') && privateTarget(result.target) && result.current === 'unknown'
      && list(result.checks, c => shape(c, 'kind status', 'reason'), 5), 32);
  if (v.type === 'renewal') return shape(r, 'id issuer app_id app_revision status started_at incomplete history_started_at results', 'finished_at references_incomplete')
    && alias(r.id, 'token-renewal') && alias(r.app_id, 'oauth-app') && list(r.results, result => shape(result, 'id revision eligible status current connections native_accounts', 'reason')
      && alias(result.id, 'authorization') && alias(result.revision, 'authorization-revision') && result.current === 'unknown'
      && list(result.connections, n => alias(n, 'connection'), 256)
      && list(result.native_accounts, a => shape(a, 'platform slug') && (a.platform === 'mail' || a.platform === 'calendar') && alias(a.slug, a.platform + '-account'), 256), 32);
  return false;
};
type PrivateScope = AuthenticationHistoryPrivateExport['scope'];
type PrivateMethod = NonNullable<Extract<AuthenticationHistoryPrivateEntry, { type: 'repair' }>['record']['from']>;
const hash = (v: string): string => Number(v.slice(v.lastIndexOf('-') + 1)).toString(16).padStart(64, '0');
const uuid = (v: string): string => { const h = hash(v).slice(-32); return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-'); };
const liftScope = (v: PrivateScope): AuthenticationIncidentScope => v.kind === 'group' ? { kind: 'group', id: hash(v.id) } : v;
const liftMethod = (v: PrivateMethod): AuthenticationRepairMethod => ({ type: v.type,
  ...(v.app_reference ? { app_id: v.app_reference } : {}), ...(v.broker_profile_id ? { broker_profile_id: v.broker_profile_id } : {}),
  ...(v.broker_account_id ? { broker_account_id: v.broker_account_id } : {}), ...(v.connection_name ? { connection_name: v.connection_name } : {}) });
const liftEntry = (entry: AuthenticationHistoryPrivateEntry): AuthenticationHistoryExportEntry => {
  if (entry.type === 'incident') { const r = entry.record; return { ...entry, record: { ...r, id: uuid(r.id), group: { ...r.group, id: hash(r.group.id), label: 'Saved alias',
    uses: r.group.uses.map(u => ({ ...u, label: 'Saved alias' })), issues: r.group.issues.map(i => ({ ...i, id: hash(i.id), message: 'Recorded local issue: ' + i.code })) } } }; }
  if (entry.type === 'repair') { const r = entry.record; const { from, to, ...rest } = r; return { ...entry, record: { ...rest, id: 'repair-' + hash(r.id),
    ...(from ? { from: liftMethod(from) } : {}), ...(to ? { to: liftMethod(to) } : {}), incidents: r.incidents.map(i => ({ id: uuid(i.id), group_id: hash(i.group_id), label: 'Saved alias' })) } }; }
  if (entry.type === 'verification') { const r = entry.record; return { ...entry, record: { ...r, id: 'verify-' + uuid(r.id),
    selection: { kind: r.selection.kind, id: r.selection.kind === 'group' ? hash(r.selection.id) : r.selection.kind === 'repair' ? 'repair-' + hash(r.selection.id)
      : (r.selection.kind === 'verification' ? 'verify-' : 'renewal-') + uuid(r.selection.id) },
    uses: r.uses.map(u => ({ ...u, label: 'Saved alias' })), results: r.results.map(result => ({ ...result, id: hash(result.id), authentication_revision: hash(result.authentication_revision), label: 'Saved alias' })) } }; }
  const r = entry.record; return { ...entry, record: { ...r, id: 'renewal-' + uuid(r.id), app_id: 'app-' + hash(r.app_id).slice(-32), app_label: 'Saved alias',
    results: r.results.map(result => ({ ...result, id: hash(result.id), revision: hash(result.revision), label: 'Saved alias' })) } };
};
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
};
const metadata = 'format version exported_at scope filters retention_days finished_record_limit';
const snapshotKeys = metadata + ' complete evidence current_authentication entry_count entries';
const privateFilters = (v: unknown): boolean => shape(v, 'search_applied', 'type outcome from through') && typeof v.search_applied === 'boolean'
  && isAuthenticationIncidentHistoryFilters(Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'search_applied')));
const validSnapshot = (v: unknown): v is AuthenticationHistoryExport | AuthenticationHistoryPrivateExport => {
  if (!object(v)) return false;
  if (v.format === 'recued.connection-history') return isAuthenticationHistoryExport(v) && same(v, authenticationHistoryExportReport(v));
  if (v.format !== 'recued.connection-history.aliases' || !shape(v, snapshotKeys + ' alias_scope') || v.alias_scope !== 'this_file'
    || !privateTarget(v.scope, true) || !privateFilters(v.filters) || !list(v.entries, privateEntryShape, AUTHENTICATION_HISTORY_EXPORT_MAX_ENTRIES)) return false;
  const value = v as unknown as AuthenticationHistoryPrivateExport;
  const { search_applied: _search, ...filters } = value.filters;
  return isAuthenticationHistoryExport({ ...value, format: 'recued.connection-history', scope: liftScope(value.scope), filters, entries: value.entries.map(liftEntry) });
};
const freeze = (v: unknown): void => { if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } };
const prepare = (report: PreparedAuthenticationHistoryDownload['report'], json: string): PreparedAuthenticationHistoryDownload => {
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) throw new AuthenticationHistoryFileError('too_large');
  freeze(report);
  return Object.freeze({ filename: 'recued-opened-connection-history-' + new Date(report.exported_at).toISOString().replace(/[:.]/g, '-') + '.json', json, bytes, count: report.entries.length, report });
};
export interface PreparedAuthenticationHistoryRecordDownload {
  readonly filename: string;
  readonly json: string;
  readonly bytes: number;
  readonly count: 1;
  readonly representation: 'full' | 'aliases';
  readonly entry: PreparedAuthenticationHistoryDownload['report']['entries'][number];
  readonly context?: AuthenticationHistoryRecordContext;
}
export type OpenedAuthenticationHistoryFile = {
  readonly kind: 'report'; readonly snapshot: PreparedAuthenticationHistoryDownload; readonly bundle?: AuthenticationHistoryRelatedBundle;
} | { readonly kind: 'record'; readonly record: PreparedAuthenticationHistoryRecordDownload }
  | { readonly kind: 'comparison'; readonly comparison: AuthenticationHistoryComparison; readonly file: PreparedAuthenticationHistoryComparisonPair };
const checkedRecord = (value: unknown) => {
  if (!shape(value, 'type outcome record')) throw new AuthenticationHistoryFileError('invalid_history');
  const aliases = privateEntryShape(value);
  // Reuse the public lifecycle/outcome guards without constructing a report.
  // Alias surrogates are for validation only; original aliases stay untouched.
  const entry = aliases ? liftEntry(value) : value;
  const record = authenticationHistoryExportRecord(entry.record);
  if (!record || entry.type !== authenticationHistoryEntryType(record) || entry.outcome !== authenticationHistoryEntryOutcome(record)
    || !same(entry.record, record)) throw new AuthenticationHistoryFileError('invalid_history');
  return { entry: value as unknown as PreparedAuthenticationHistoryRecordDownload['entry'], representation: aliases ? 'aliases' as const : 'full' as const };
};
const recordFile = (value: Record<string, unknown>): OpenedAuthenticationHistoryFile => {
  const { entry, representation } = checkedRecord(value);
  const json = JSON.stringify(value); const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) throw new AuthenticationHistoryFileError('too_large');
  freeze(value);
  const prepared: PreparedAuthenticationHistoryRecordDownload = Object.freeze({
    filename: 'recued-opened-connection-history-record-' + entry.type + '.json', json, bytes, count: 1,
    representation, entry,
  });
  return Object.freeze({ kind: 'record', record: prepared });
};
const contextRecordFile = (v: Record<string, unknown>): OpenedAuthenticationHistoryFile => {
  const aliases = v.privacy_mode === 'aliases';
  if ((!aliases && v.privacy_mode !== 'full')
    || !shape(v, 'format version privacy_mode evidence current_authentication source_snapshot entry' + (aliases ? ' alias_scope' : ''), 'source_position')
    || aliases && v.alias_scope !== 'source_snapshot' || v.evidence !== 'retained_local_observations' || v.current_authentication !== 'not_checked'
    || !shape(v.source_snapshot, metadata + ' entry_count')
    || v.source_snapshot.format !== (aliases ? 'recued.connection-history.aliases' : 'recued.connection-history')
    || !Number.isSafeInteger(v.source_snapshot.entry_count) || (v.source_snapshot.entry_count as number) < 1
    || (v.source_snapshot.entry_count as number) > AUTHENTICATION_HISTORY_EXPORT_MAX_ENTRIES
    || v.source_position !== undefined && (!Number.isSafeInteger(v.source_position) || (v.source_position as number) < 1
      || (v.source_position as number) > (v.source_snapshot.entry_count as number))) throw new AuthenticationHistoryFileError('invalid_history');
  const { entry, representation } = checkedRecord(v.entry);
  // Validate source metadata and its filters using a validation-only view.
  // Its one checked entry never replaces the recorded source entry count.
  if (representation !== v.privacy_mode || !validSnapshot({ ...v.source_snapshot, complete: true,
    evidence: 'retained_local_observations', current_authentication: 'not_checked', ...(aliases ? { alias_scope: 'this_file' } : {}),
    entry_count: 1, entries: [entry] })) throw new AuthenticationHistoryFileError('invalid_history');
  const json = JSON.stringify(v); const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) throw new AuthenticationHistoryFileError('too_large');
  freeze(v);
  const context: AuthenticationHistoryRecordContext = Object.freeze({
    source_snapshot: v.source_snapshot as unknown as AuthenticationHistoryRecordContext['source_snapshot'],
    ...(v.source_position === undefined ? {} : { source_position: v.source_position as number }),
  });
  const prepared: PreparedAuthenticationHistoryRecordDownload = Object.freeze({
    filename: authenticationHistoryContextRecordFilename(entry, context), json, bytes, count: 1, representation, entry, context,
  });
  return Object.freeze({ kind: 'record', record: prepared });
};
const relatedKeys = 'format version privacy_mode evidence current_authentication coverage unrecorded_or_excluded_links link_rule root source_snapshot entry_count counts entries incomplete_record_count missing_reference_count missing_references';
const relatedFile = (v: Record<string, unknown>): OpenedAuthenticationHistoryFile | undefined => {
  const aliases = v.privacy_mode === 'aliases';
  if ((!aliases && v.privacy_mode !== 'full') || !shape(v, relatedKeys + (aliases ? ' alias_scope' : ''))
    || aliases && v.alias_scope !== 'source_snapshot' || !shape(v.source_snapshot, metadata + ' entry_count')
    || v.source_snapshot.format !== (aliases ? 'recued.connection-history.aliases' : 'recued.connection-history')
    || !Array.isArray(v.entries) || !shape(v.root, 'type id source_position') || v.root.type !== 'incident'
    || !Number.isSafeInteger(v.root.source_position) || (v.root.source_position as number) < 1
    || !Number.isSafeInteger(v.source_snapshot.entry_count) || (v.source_snapshot.entry_count as number) > AUTHENTICATION_HISTORY_EXPORT_MAX_ENTRIES
    || (v.root.source_position as number) > (v.source_snapshot.entry_count as number) || (v.source_snapshot.entry_count as number) < v.entries.length) return;
  const report = { ...v.source_snapshot, complete: true, evidence: 'retained_local_observations', current_authentication: 'not_checked',
    ...(aliases ? { alias_scope: 'this_file' } : {}), entry_count: v.entries.length, entries: v.entries };
  if (!validSnapshot(report)) return;
  const root = v.root;
  const index = report.entries.findIndex(entry => entry.type === 'incident' && entry.record.id === root.id);
  // A subset preserves source order. The root position must leave room for
  // every included entry before and after it in the original snapshot.
  if (index < 0 || (root.source_position as number) < index + 1
    || (v.source_snapshot.entry_count as number) - (root.source_position as number) < report.entries.length - index - 1) return;
  // Recompute the complete saved-link component, missing references, counts and
  // detail flags. Preserve the original source positions and snapshot limits.
  const snapshot = prepare(report, JSON.stringify(v)); const computed = createAuthenticationHistoryRelatedBundles(snapshot)(index);
  if (!same(v, { ...computed.report, root: v.root, source_snapshot: v.source_snapshot })) return;
  const bundle: AuthenticationHistoryRelatedBundle = { filename: snapshot.filename.slice(0, -5) + '-related.json', report: v as unknown as AuthenticationHistoryRelatedBundle['report'] };
  freeze(bundle);
  return Object.freeze({ kind: 'report', snapshot, bundle });
};

/** All bytes stay local. Bound input before parsing, and bound nesting before
 * any recursive guard, projection or freeze sees untrusted JSON. Download JSON
 * is reserialized from checked data, including when a file used duplicate keys. */
export const openAuthenticationHistoryFile = (text: string): OpenedAuthenticationHistoryFile => {
  if (text.length > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES || new TextEncoder().encode(text).byteLength > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) throw new AuthenticationHistoryFileError('too_large');
  let depth = 0; let quoted = false; let escaped = false;
  for (const char of text) {
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if ((char === '{' || char === '[') && ++depth > 32) throw new AuthenticationHistoryFileError('invalid_json');
    else if (char === '}' || char === ']') depth--;
  }
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new AuthenticationHistoryFileError('invalid_json'); }
  if (!object(value)) throw new AuthenticationHistoryFileError('unsupported_format');
  if (value.format === undefined && ['type', 'outcome', 'record'].some(key => Object.hasOwn(value, key))) return recordFile(value);
  if (typeof value.format !== 'string' || !['recued.connection-history', 'recued.connection-history.aliases', 'recued.connection-history.related', AUTHENTICATION_HISTORY_RECORD_FORMAT, AUTHENTICATION_HISTORY_COMPARISON_PAIR_FORMAT].includes(value.format)) throw new AuthenticationHistoryFileError('unsupported_format');
  if (value.version !== 1) throw new AuthenticationHistoryFileError('unsupported_version');
  if (value.format === AUTHENTICATION_HISTORY_COMPARISON_PAIR_FORMAT) {
    if (!shape(value, 'format version baseline comparison')) throw new AuthenticationHistoryFileError('invalid_history');
    const report = (v: unknown) => {
      if (!object(v) || v.format !== 'recued.connection-history' || !validSnapshot(v)) throw new AuthenticationHistoryFileError('invalid_history');
      return Object.freeze({ kind: 'report' as const, snapshot: prepare(v, JSON.stringify(v)) });
    };
    const comparison = compareAuthenticationHistorySnapshots(report(value.baseline), report(value.comparison));
    return Object.freeze({ kind: 'comparison', comparison, file: prepareAuthenticationHistoryComparisonPair(comparison) });
  }
  if (value.format === AUTHENTICATION_HISTORY_RECORD_FORMAT) return contextRecordFile(value);
  if (value.format === 'recued.connection-history.related') {
    const result = relatedFile(value); if (result) return result;
  } else if (validSnapshot(value)) return Object.freeze({ kind: 'report', snapshot: prepare(value, JSON.stringify(value)) });
  throw new AuthenticationHistoryFileError('invalid_history');
};
