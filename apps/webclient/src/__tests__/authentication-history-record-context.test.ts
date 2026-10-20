import { describe, expect, it } from 'vitest';
import { AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES, AUTHENTICATION_HISTORY_EXPORT_MAX_ENTRIES, authenticationHistoryEntryOutcome, authenticationHistoryEntryType,
  type AuthenticationHistoryEntry, type AuthenticationHistoryExport, type AuthenticationIncident, type AuthenticationRepairAction,
  type AuthenticationAccessVerification, type AuthenticationRenewalHistory } from '@recued/contracts';
import { prepareAuthenticationHistoryDownload } from '../connections/authentication-history-export.js';
import { createAuthenticationHistoryRelatedBundles, prepareAuthenticationHistoryRelatedDownload } from '../connections/authentication-history-related-bundle.js';
import { authenticationHistoryRecordContext, prepareAuthenticationHistoryContextRecord } from '../connections/authentication-history-record-context.js';
import { openAuthenticationHistoryFile, AuthenticationHistoryFileError } from '../connections/authentication-history-saved-file.js';

const uuid = (n: number) => n.toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc';
const incident = (n: number): AuthenticationIncident => ({ id: uuid(n), status: 'retired', started_at: 100, last_problem_at: 100, history_started_at: 100, ended_at: 200,
  retirement_reason: 'authentication_changed', currently_reported: false, level: 'rejected', events_truncated: false, details_truncated: false,
  events: [{ kind: 'opened', at: 100, level: 'rejected' }, { kind: 'retired', at: 200, level: 'rejected' }],
  group: { id: 'a'.repeat(64), kind: 'account', label: 'Private account', authentication: 'direct_oauth', connection_names: ['work'], targets: [{ kind: 'connection', name: 'work' }],
    issues: [{ id: '1'.repeat(64), code: 'credential_rejected', message: 'Private issue' }], uses: [{ kind: 'pack', id: 'private-pack', label: 'Private pack' }], usage_available: true } });
const repair: AuthenticationRepairAction = { id: 'repair-' + '2'.repeat(64), action: 'reauthorize', status: 'applied', started_at: 110, finished_at: 120,
  from: { type: 'direct_oauth', app_id: 'default', label: 'Private app', connection_name: 'work' }, to: { type: 'broker', broker_profile_id: 'private-profile', broker_account_id: 'private-account' },
  targets: [{ kind: 'connection', name: 'work' }], targets_truncated: false, incidents_truncated: false, incidents: [1, 2].map(n => ({ id: uuid(n), group_id: 'a'.repeat(64), label: 'Private account' })) };
const verification: AuthenticationAccessVerification = { id: 'verify-' + uuid(1), selection: { kind: 'repair', id: repair.id }, status: 'completed', started_at: 130, finished_at: 140, targets_truncated: false,
  usage_available: true, uses: [], results: [{ id: 'b'.repeat(64), label: 'Private API', target: { kind: 'connection', name: 'work' }, authentication_revision: 'c'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] }] };
const renewal: AuthenticationRenewalHistory = { id: 'renewal-' + uuid(1), issuer: 'google', app_id: 'default', app_revision: 1, app_label: 'Private OAuth app', status: 'completed', started_at: 110, finished_at: 120, history_started_at: 110, incomplete: false,
  results: [{ id: 'd'.repeat(64), revision: 'e'.repeat(64), label: 'Private grant', eligible: true, connections: ['work'], native_accounts: [{ platform: 'mail', slug: 'inbox' }], status: 'passed', current: 'yes' }] };
const fixture = (records: AuthenticationHistoryEntry[] = [incident(99), verification, repair, incident(1), incident(2), renewal]): AuthenticationHistoryExport => ({ format: 'recued.connection-history', version: 1, exported_at: 300,
  scope: { kind: 'all' }, filters: {}, retention_days: 90, finished_record_limit: 10000, complete: true, evidence: 'retained_local_observations', current_authentication: 'not_checked', entry_count: records.length,
  entries: records.map(record => ({ type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record })) });
const source = (mode: 'aliases' | 'full', value = fixture()) => prepareAuthenticationHistoryDownload(value, { scope: value.scope, filters: value.filters }, mode);
const openedRecord = (text: string) => { const opened = openAuthenticationHistoryFile(text); if (opened.kind !== 'record') throw Error('Expected a saved record.'); return opened.record; };
const failure = (value: unknown, code = 'invalid_history') => {
  try { openAuthenticationHistoryFile(JSON.stringify(value)); throw Error('Accepted invalid context.'); }
  catch (error) { expect(error).toBeInstanceOf(AuthenticationHistoryFileError); expect((error as AuthenticationHistoryFileError).code).toBe(code); }
};

describe('individual history records with optional source context', () => {
  for (const mode of ['aliases', 'full'] as const) it.each(['incident', 'repair', 'verification', 'renewal'] as const)('round-trips a complete %s record with ' + mode + ' source context', kind => {
    const snapshot = source(mode); const index = snapshot.report.entries.findIndex(entry => entry.type === kind); const entry = snapshot.report.entries[index]!;
    const context = authenticationHistoryRecordContext(snapshot, index); const prepared = prepareAuthenticationHistoryContextRecord(entry, context);
    const record = openedRecord('\uFEFF' + JSON.stringify(prepared.envelope, null, 2));
    expect(record).toMatchObject({ json: prepared.json, filename: prepared.filename, count: 1, representation: mode, entry, context });
    expect(record.context?.source_snapshot.entry_count).toBe(6); expect(record.context?.source_position).toBe(index + 1);
    expect(prepared.filename).toMatch(new RegExp('-' + kind + '-' + (index + 1) + '-with-context\\.json$'));
    expect(record.context?.source_snapshot.format).toBe(snapshot.report.format);
    expect(Object.isFrozen(record)).toBe(true); expect(Object.isFrozen(record.context?.source_snapshot.filters)).toBe(true); expect(Object.isFrozen(record.entry.record)).toBe(true);
    expect(Object.keys(JSON.parse(record.json))).not.toContain('entries');
    expect(openedRecord(JSON.stringify(entry)).context).toBeUndefined();
    if (mode === 'aliases') expect(record.json).not.toContain('Private');
  });
  it.each(['aliases', 'full'] as const)('preserves %s source metadata and sparse aliases from related subsets without guessing positions', mode => {
    const original = source(mode); const bundle = createAuthenticationHistoryRelatedBundles(original)(3);
    const result = openAuthenticationHistoryFile(prepareAuthenticationHistoryRelatedDownload(bundle).json);
    if (result.kind !== 'report' || !result.bundle) throw Error('Expected a related bundle.');
    for (let index = 0; index < result.snapshot.report.entries.length; index++) {
      const entry = result.snapshot.report.entries[index]!; const context = authenticationHistoryRecordContext(result.snapshot, index, result.bundle);
      const prepared = prepareAuthenticationHistoryContextRecord(entry, context); const record = openedRecord(prepared.json);
      expect(context.source_snapshot).toEqual(bundle.report.source_snapshot); expect(context.source_snapshot.entry_count).toBe(6); expect(record.entry).toEqual(entry);
      if (entry.record.id === bundle.report.root.id) expect(record.context?.source_position).toBe(4);
      else { expect(record.context).not.toHaveProperty('source_position'); expect(prepared.envelope).not.toHaveProperty('source_position'); expect(prepared.filename).toMatch(new RegExp('-' + entry.type + '-with-context\\.json$')); }
      if (mode === 'aliases' && entry.record.id === bundle.report.root.id) expect(entry.record.id).not.toBe('incident-1');
    }
  });
  it.each(['aliases', 'full'] as const)('preserves applied %s filters and refuses records inconsistent with them', mode => {
    const value = fixture([incident(1)]); value.filters = { type: 'incident', outcome: 'retired', search: 'work', from: '1970-01-01', through: '1970-01-01' };
    const snapshot = source(mode, value); const prepared = prepareAuthenticationHistoryContextRecord(snapshot.report.entries[0]!, authenticationHistoryRecordContext(snapshot, 0));
    expect(openedRecord(prepared.json).context?.source_snapshot.filters).toEqual(snapshot.report.filters);
    failure({ ...prepared.envelope, source_snapshot: { ...prepared.envelope.source_snapshot, filters: { type: 'repair' } } });
  });
  it.each(['aliases', 'full'] as const)('refuses invalid %s source metadata, context claims, version and record fields', mode => {
    const snapshot = source(mode); const original = prepareAuthenticationHistoryContextRecord(snapshot.report.entries[0]!, authenticationHistoryRecordContext(snapshot, 0)).envelope;
    for (const change of [
      (v: any) => { v.source_snapshot.entry_count = 0; }, (v: any) => { v.source_snapshot.entry_count = AUTHENTICATION_HISTORY_EXPORT_MAX_ENTRIES + 1; },
      (v: any) => { v.source_position = 0; }, (v: any) => { v.source_position = 7; }, (v: any) => { v.source_position = 1.1; },
      (v: any) => { v.source_snapshot.retention_days = 365; }, (v: any) => { v.source_snapshot.finished_record_limit = 0; },
      (v: any) => { v.source_snapshot.exported_at = -1; }, (v: any) => { v.source_snapshot.version = 2; },
      (v: any) => { v.source_snapshot.scope.credential = 'secret'; }, (v: any) => { v.source_snapshot.filters.extra = 'secret'; },
      (v: any) => { v.source_snapshot.extra = 'secret'; }, (v: any) => { v.extra = 'secret'; },
      (v: any) => { v.entry.record.access_token = 'secret'; }, (v: any) => { v.entry.outcome = 'invented'; },
      (v: any) => { v.entry.record.ended_at = 1; }, (v: any) => { v.current_authentication = 'verified'; },
      (v: any) => { v.evidence = 'authenticated'; }, (v: any) => { v.privacy_mode = mode === 'aliases' ? 'full' : 'aliases'; },
      (v: any) => { delete v.source_snapshot; }, (v: any) => { delete v.entry; },
      (v: any) => { v.source_snapshot.format = mode === 'aliases' ? 'recued.connection-history' : 'recued.connection-history.aliases'; },
      (v: any) => { v.alias_scope = 'this_file'; },
    ]) { const changed = structuredClone(original); change(changed); failure(changed); }
    for (const version of [0, 2, '1', null]) failure({ ...original, version }, 'unsupported_version');
    const unknown = { ...original }; delete (unknown as { source_position?: number }).source_position;
    expect(openedRecord(JSON.stringify(unknown)).context).not.toHaveProperty('source_position');
  });
  it('reserializes only checked envelope bytes when input overwrites keys', () => {
    const snapshot = source('aliases'); const prepared = prepareAuthenticationHistoryContextRecord(snapshot.report.entries[0]!, authenticationHistoryRecordContext(snapshot, 0));
    const raw = prepared.json.replace('"privacy_mode":"aliases"', '"privacy_mode":"private-overwritten-value","privacy_mode":"aliases"');
    expect(openedRecord(raw).json).toBe(prepared.json); expect(openedRecord(raw).json).not.toContain('private-overwritten-value');
  });
  it('bounds the serialized context even when its valid source report fits exactly within 8 MiB', () => {
    const item = incident(1); item.group.uses = Array.from({ length: 5000 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: 'x' }));
    const value = fixture([item]); const snapshot = source('full', value);
    let missing = AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES - snapshot.bytes;
    for (const use of item.group.uses) { const add = Math.min(missing, 2048 - use.label.length); use.label += 'x'.repeat(add); missing -= add; }
    expect(missing).toBe(0);
    const exact = source('full', value); expect(exact.bytes).toBe(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES);
    expect(() => prepareAuthenticationHistoryContextRecord(exact.report.entries[0]!, authenticationHistoryRecordContext(exact, 0))).toThrow('8 MiB');
  });
  it.each([-1, 1.1, 6, NaN])('refuses an invalid source index %s', index => expect(() => authenticationHistoryRecordContext(source('aliases'), index)).toThrow());
});
