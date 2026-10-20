import { describe, expect, it, vi } from 'vitest';
import { authenticationHistoryEntryOutcome, authenticationHistoryEntryType, AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES, AUTHENTICATION_HISTORY_EXPORT_MAX_ENTRIES,
  type AuthenticationIncident, type AuthenticationRepairAction, type AuthenticationAccessVerification, type AuthenticationRenewalHistory, type AuthenticationHistoryExport, type AuthenticationHistoryEntry, type AuthenticationIncidentScope } from '@recued/contracts';
import { prepareAuthenticationHistoryDownload } from '../connections/authentication-history-export.js';
import { createAuthenticationHistoryRelatedBundles, prepareAuthenticationHistoryRelatedDownload } from '../connections/authentication-history-related-bundle.js';
import { openAuthenticationHistoryFile, AuthenticationHistoryFileError } from '../connections/authentication-history-saved-file.js';

const uuid = (n: number) => n.toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc';
const incident = (n: number): AuthenticationIncident => ({ id: uuid(n), status: 'retired', started_at: 100, last_problem_at: 100, history_started_at: 100, ended_at: 200,
  retirement_reason: 'authentication_changed', currently_reported: false, level: 'rejected', events_truncated: false, details_truncated: false,
  events: [{ kind: 'opened', at: 100, level: 'rejected' }, { kind: 'retired', at: 200, level: 'rejected' }],
  group: { id: 'a'.repeat(64), kind: 'account', label: '<img src=x onerror=alert(1)>', authentication: 'direct_oauth', connection_names: ['work'],
    targets: [{ kind: 'connection', name: 'work' }, { kind: 'collection', platform: 'mail', slug: 'inbox' }, { kind: 'collection', platform: 'calendar', slug: 'events' }, { kind: 'file_source', source_id: 'drive' }, { kind: 'oauth_apps' }],
    issues: [{ id: '1'.repeat(64), code: 'credential_rejected', message: 'Private issue' }], uses: [{ kind: 'pack', id: 'private-pack', label: 'Private pack' }], usage_available: true } });
const repair = (n: number): AuthenticationRepairAction => ({ id: 'repair-' + n.toString(16).padStart(64, '0'), action: 'reauthorize', status: 'applied', started_at: 110, finished_at: 120,
  from: { type: 'direct_oauth', app_id: 'default', label: 'Private app', connection_name: 'work' }, to: { type: 'broker', broker_profile_id: 'private-profile', broker_account_id: 'private-account', connection_name: 'work' },
  targets: [{ kind: 'connection', name: 'work' }], targets_truncated: false, incidents_truncated: false, incidents: [1, 2].map(n => ({ id: incident(n).id, group_id: incident(n).group.id, label: incident(n).group.label })) });
const check = (n: number, selection: AuthenticationAccessVerification['selection'] = { kind: 'repair', id: repair(1).id }): AuthenticationAccessVerification => ({ id: 'verify-' + uuid(n), selection, status: 'completed', started_at: 130, finished_at: 140, targets_truncated: false,
  usage_available: true, uses: [{ kind: 'recipe', id: 'private-recipe', label: 'Private recipe' }], results: [{ id: 'b'.repeat(64), label: 'Private API', target: { kind: 'connection', name: 'work' }, authentication_revision: 'c'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'permission_evidence_missing' }] }] });
const renewal = (): AuthenticationRenewalHistory => ({ id: 'renewal-' + uuid(1), issuer: 'google', app_id: 'default', app_revision: 1, app_label: 'Private OAuth app', status: 'completed', started_at: 110, finished_at: 120, history_started_at: 110, incomplete: false,
  results: [{ id: 'd'.repeat(64), revision: 'e'.repeat(64), label: 'Private grant', eligible: true, connections: ['work'], native_accounts: [{ platform: 'mail', slug: 'inbox' }, { platform: 'calendar', slug: 'events' }], status: 'passed', current: 'yes' }] });
const fixture = (records: AuthenticationHistoryEntry[] = [incident(99), check(1), repair(1), incident(1), incident(2), renewal(), check(2, { kind: 'renewal', id: renewal().id })]): AuthenticationHistoryExport => ({ format: 'recued.connection-history', version: 1, exported_at: 300,
  scope: { kind: 'all' }, filters: {}, retention_days: 90, finished_record_limit: 10000, complete: true, evidence: 'retained_local_observations', current_authentication: 'not_checked', entry_count: records.length,
  entries: records.map(record => ({ type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record })) });
const source = (mode: 'aliases' | 'full', value = fixture()) => prepareAuthenticationHistoryDownload(value, { scope: value.scope, filters: value.filters }, mode);
const openReport = (text: string) => { const opened = openAuthenticationHistoryFile(text); if (opened.kind !== 'report') throw Error('Expected a complete history report.'); return opened; };
const openRecord = (text: string) => { const opened = openAuthenticationHistoryFile(text); if (opened.kind !== 'record') throw Error('Expected an individual saved record.'); return opened; };
const failure = (value: unknown, code = 'invalid_history') => {
  try { openAuthenticationHistoryFile(typeof value === 'string' ? value : JSON.stringify(value)); throw Error('accepted invalid file'); }
  catch (error) { expect(error).toBeInstanceOf(AuthenticationHistoryFileError); expect((error as AuthenticationHistoryFileError).code).toBe(code); }
};

describe('opening saved authentication history files locally', () => {
  for (const mode of ['aliases', 'full'] as const) it.each(['incident', 'repair', 'verification', 'renewal'] as const)('opens a complete %s record in ' + mode + ' format without inventing snapshot metadata', kind => {
    const entry = source(mode).report.entries.find(entry => entry.type === kind)!; const json = JSON.stringify(entry);
    const opened = openRecord('\uFEFF' + JSON.stringify(entry, null, 2));
    expect(opened.record).toEqual({ filename: 'recued-opened-connection-history-record-' + kind + '.json', json,
      bytes: new TextEncoder().encode(json).byteLength, count: 1, representation: mode, entry });
    expect(Object.keys(opened)).toEqual(['kind', 'record']); expect(Object.keys(opened.record)).not.toContain('report');
    expect(Object.isFrozen(opened.record)).toBe(true); expect(Object.isFrozen(opened.record.entry.record)).toBe(true);
  });
  it.each(['aliases', 'full'] as const)('keeps the original %s entry and sparse aliases when opening a record taken from a related bundle', mode => {
    const bundle = createAuthenticationHistoryRelatedBundles(source(mode))(3); const entry = bundle.report.entries.find(entry => entry.record.id === bundle.report.root.id)!;
    expect(openRecord(JSON.stringify(entry)).record.entry).toEqual(entry);
    if (mode === 'aliases') expect(openRecord(JSON.stringify(entry)).record.entry.record.id).not.toBe('incident-1');
  });
  for (const mode of ['aliases', 'full'] as const) it.each(['incident', 'repair', 'verification', 'renewal'] as const)('rejects altered %s record kinds, outcomes, lifecycle and secret fields in ' + mode, kind => {
    const original = source(mode).report.entries.find(entry => entry.type === kind)!;
    for (const change of [
      (value: any) => { value.type = kind === 'incident' ? 'repair' : 'incident'; },
      (value: any) => { value.outcome = 'invented'; },
      (value: any) => { value.record[kind === 'incident' ? 'ended_at' : 'finished_at'] = 1; },
      (value: any) => { value.record.access_token = 'private-token'; },
      (value: any) => { value.version = 1; },
    ]) { const entry = structuredClone(original); change(entry); failure(entry); }
  });
  it.each(['aliases', 'full'] as const)('rejects provider extensions, current-authentication claims and incomplete %s records', mode => {
    const original = source(mode).report.entries.find(entry => entry.type === 'verification')!;
    for (const change of [
      (value: any) => { value.record.results[0].current = 'yes'; },
      (value: any) => { value.record.results[0].target.refresh_token = 'private-token'; },
      (value: any) => { delete value.outcome; },
      (value: any) => { delete value.record.results; },
      (value: any) => { value.untrusted_extension = true; },
    ]) { const entry = structuredClone(original); change(entry); failure(entry); }
    failure(original.record, 'unsupported_format');
  });
  it('rejects incorrect alias namespaces and alias records with names added back', () => {
    const original = source('aliases').report.entries[0]!;
    for (const change of [
      (value: any) => { value.record.id = 'incident-0'; },
      (value: any) => { value.record.group.label = 'Private name'; },
      (value: any) => { value.record.group.targets[0].name = 'group-1'; },
    ]) { const entry = structuredClone(original); change(entry); failure(entry); }
  });
  it('serializes only the checked single record when input overwrites JSON keys', () => {
    const entry = source('aliases').report.entries[0]!; const raw = JSON.stringify(entry).replace('"type":"incident"', '"type":"private-overwritten","type":"incident"');
    expect(openRecord(raw).record.json).toBe(JSON.stringify(entry)); expect(openRecord(raw).record.json).not.toContain('private-overwritten');
  });
  it.each(['exact limit', 'serialized output expansion'] as const)('checks single-record input and output bytes at the %s', variant => {
    const item = incident(1); item.group.uses = Array.from({ length: 5000 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: 'x' }));
    const entry = structuredClone(source('full', fixture([item])).report.entries[0]!); const record = entry.record as AuthenticationIncident;
    let missing = AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES - (variant === 'exact limit' ? 0 : 4) - new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    for (const use of record.group.uses) { const add = Math.min(missing, 2048 - use.label.length); use.label += 'x'.repeat(add); missing -= add; }
    expect(missing).toBe(0);
    if (variant === 'exact limit') {
      expect(openRecord(JSON.stringify(entry)).record.bytes).toBe(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES);
      record.group.uses.at(-1)!.label += 'x'; failure(entry, 'too_large');
    } else {
      record.group.uses[0]!.label = '\uD800' + record.group.uses[0]!.label.slice(1);
      const input = JSON.stringify(entry).replace('\\ud800', '\uD800');
      expect(new TextEncoder().encode(input).byteLength).toBeLessThan(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES);
      expect(new TextEncoder().encode(JSON.stringify(entry)).byteLength).toBeGreaterThan(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES);
      failure(input, 'too_large');
    }
  });
  it.each(['aliases', 'full'] as const)('round-trips all four %s record kinds without changing data or aliases', mode => {
    const original = source(mode); const opened = openReport(original.json);
    expect(opened.snapshot.report).toEqual(original.report); expect(opened.snapshot.json).toBe(original.json); expect(opened.snapshot.count).toBe(7); expect(opened.snapshot.bytes).toBe(original.bytes); expect(opened.bundle).toBeUndefined();
    expect(Object.isFrozen(opened)).toBe(true); expect(Object.isFrozen(opened.snapshot.report.entries[0]!.record)).toBe(true); expect(opened.snapshot.filename).not.toMatch(/private|work|123456789abc/i);
    if (mode === 'aliases') expect(opened.snapshot.json).not.toMatch(/Private|img src/);
  });
  it.each(['aliases', 'full'] as const)('accepts formatted %s JSON with a BOM and saves the same checked report', mode => {
    const original = source(mode); const opened = openReport('\uFEFF' + JSON.stringify(JSON.parse(original.json), null, 2)); expect(opened.snapshot.json).toBe(original.json); expect(opened.snapshot.report).toEqual(original.report);
  });
  for (const mode of ['aliases', 'full'] as const) it.each<AuthenticationIncidentScope>([{ kind: 'group', id: 'a'.repeat(64) }, { kind: 'connection', name: 'work' }, { kind: 'file_source', source_id: 'drive' }, { kind: 'collection', platform: 'mail', slug: 'inbox' }, { kind: 'collection', platform: 'calendar', slug: 'events' }, { kind: 'oauth_apps' }])('keeps %s scope metadata in ' + mode + ' mode', scope => {
    const value = fixture(); value.scope = scope; const original = source(mode, value); expect(openReport(original.json).snapshot.report).toEqual(original.report);
  });
  it.each(['aliases', 'full'] as const)('preserves applied %s filters and rejects mismatched recorded outcomes', mode => {
    const value = fixture([incident(1)]); value.filters = { search: 'work', type: 'incident', outcome: 'retired', from: '1970-01-01', through: '1970-01-01' };
    const original = source(mode, value); expect(openReport(original.json).snapshot.report.filters).toEqual(original.report.filters);
    const changed = JSON.parse(original.json); changed.entries[0].outcome = 'recovered'; failure(changed);
  });
  it.each(['aliases', 'full'] as const)('opens a %s related subset with original source counts, root position, aliases and missing links', mode => {
    const value = fixture(); const r = value.entries[2]!.record as AuthenticationRepairAction; r.incidents.push({ id: uuid(80), group_id: 'f'.repeat(64), label: 'Missing' }); r.targets_truncated = true;
    const original = source(mode, value); const bundle = createAuthenticationHistoryRelatedBundles(original)(3); const prepared = prepareAuthenticationHistoryRelatedDownload(bundle); const opened = openReport(prepared.json);
    expect(opened.bundle?.report).toEqual(bundle.report); expect(opened.snapshot.json).toBe(prepared.json); expect(opened.snapshot.report.entries).toEqual(bundle.report.entries); expect(opened.snapshot.count).toBe(4);
    expect(opened.bundle?.report).toMatchObject({ source_snapshot: { entry_count: 7 }, root: { source_position: 4 }, incomplete_record_count: 1, missing_reference_count: 1 }); expect(Object.isFrozen(opened.bundle?.report)).toBe(true);
    if (mode === 'aliases') expect(opened.bundle?.report.root.id).not.toBe('incident-1');
  });
  it.each(['aliases', 'full'] as const)('rejects altered %s related graph claims and disconnected records', mode => {
    const original = source(mode); const bundle = createAuthenticationHistoryRelatedBundles(original)(3); const raw = JSON.parse(prepareAuthenticationHistoryRelatedDownload(bundle).json);
    for (const mutate of [
      (v: typeof raw) => { v.entry_count++; }, (v: typeof raw) => { v.counts.incident++; }, (v: typeof raw) => { v.incomplete_record_count++; }, (v: typeof raw) => { v.missing_reference_count++; },
      (v: typeof raw) => { v.root.source_position = 0; }, (v: typeof raw) => { v.root.source_position = 8; }, (v: typeof raw) => { v.root.id = 'unknown-root'; }, (v: typeof raw) => { v.source_snapshot.entry_count = 1; },
      (v: typeof raw) => { v.coverage = 'complete_history'; }, (v: typeof raw) => { v.current_authentication = 'verified'; }, (v: typeof raw) => { v.source_snapshot.scope.secret = 'private'; },
      (v: typeof raw) => { v.entries.push(original.report.entries[5]); v.entry_count++; v.counts.renewal++; },
    ]) { const changed = structuredClone(raw); mutate(changed); failure(changed); }
  });
  it.each(['aliases', 'full'] as const)('checks %s root source positions against the saved subset order', mode => {
    const original = source(mode); const raw = JSON.parse(prepareAuthenticationHistoryRelatedDownload(createAuthenticationHistoryRelatedBundles(original)(3)).json);
    const index = raw.entries.findIndex((entry: { record: { id: string } }) => entry.record.id === raw.root.id);
    const first = index + 1; const last = raw.source_snapshot.entry_count - (raw.entries.length - index - 1);
    expect(first).toBeGreaterThan(1); expect(last).toBeLessThan(raw.source_snapshot.entry_count);
    for (const position of [first - 1, last + 1]) { const changed = structuredClone(raw); changed.root.source_position = position; failure(changed); }
    for (const position of [first, last]) { const changed = structuredClone(raw); changed.root.source_position = position; expect(openReport(JSON.stringify(changed)).bundle?.report.root.source_position).toBe(position); }
  });
  it.each(['aliases', 'full'] as const)('rejects incomplete, duplicate or altered %s entries and unknown credential fields', mode => {
    const raw = JSON.parse(source(mode).json);
    for (const mutate of [
      (v: typeof raw) => { v.complete = false; }, (v: typeof raw) => { v.entry_count++; }, (v: typeof raw) => { v.entries.push(v.entries[0]); v.entry_count++; },
      (v: typeof raw) => { v.entries[0].record.ended_at = 50; }, (v: typeof raw) => { v.entries[0].record.events[1].kind = 'recovered'; },
      (v: typeof raw) => { v.entries[1].record.results[0].current = 'yes'; }, (v: typeof raw) => { v.entries[1].record.results[0].checks[0].status = 'bogus'; },
      (v: typeof raw) => { v.entries[0].record.access_token = 'private-token'; }, (v: typeof raw) => { v.entries[0].record.group.targets[0].secret = 'private-token'; },
      (v: typeof raw) => { v.secret = 'private-token'; }, (v: typeof raw) => { v.retention_days = 365; },
    ]) { const changed = structuredClone(raw); mutate(changed); failure(changed); }
  });
  it('enforces alias namespaces, omitted labels, private methods and non-dense saved alias numbers', () => {
    const raw = JSON.parse(source('aliases').json);
    for (const mutate of [
      (v: typeof raw) => { v.entries[0].record.id = 'incident-0'; }, (v: typeof raw) => { v.entries[0].record.id = 'incident-9007199254740992'; },
      (v: typeof raw) => { v.entries[0].record.group.label = 'Private name'; }, (v: typeof raw) => { v.entries[0].record.group.connection_names[0] = 'group-1'; },
      (v: typeof raw) => { v.entries[2].record.from.app_reference = 'oauth-app-1'; }, (v: typeof raw) => { v.entries[2].record.to.broker_account_id = 'unqualified-broker-account-1'; },
      (v: typeof raw) => { v.entries[5].record.results[0].revision = 'authentication-revision-1'; }, (v: typeof raw) => { v.filters.search = 'Private search'; },
    ]) { const changed = structuredClone(raw); mutate(changed); failure(changed); }
    raw.entries[0].record.id = 'incident-500'; expect(openReport(JSON.stringify(raw)).snapshot.report.entries[0]!.record.id).toBe('incident-500');
    const unqualified = fixture([repair(1)]); (unqualified.entries[0]!.record as AuthenticationRepairAction).to = { type: 'broker', broker_account_id: 'old-account' };
    const original = source('aliases', unqualified); expect(openReport(original.json).snapshot.json).toBe(original.json);
  });
  it('never re-exposes overwritten keys from untrusted input JSON', () => {
    const original = source('aliases'); const raw = original.json.replace('"alias_scope":"this_file"', '"alias_scope":"private-overwritten-value","alias_scope":"this_file"');
    expect(openReport(raw).snapshot.json).toBe(original.json); expect(openReport(raw).snapshot.json).not.toContain('private-overwritten-value');
  });
  it.each(['', '{', 'null', '[]', '"history"', JSON.stringify({ format: { toString: 'bad' } })])('rejects invalid JSON or root shape %s', value => failure(value, value === '' || value === '{' ? 'invalid_json' : 'unsupported_format'));
  it('rejects unsupported formats, versions, excessive entries, UTF-8 bytes and nesting', () => {
    const raw = JSON.parse(source('full').json); failure({ format: 'other-history', version: 1 }, 'unsupported_format'); failure({ ...raw, version: 2 }, 'unsupported_version');
    failure({ ...raw, entries: Array(AUTHENTICATION_HISTORY_EXPORT_MAX_ENTRIES + 1).fill(null), entry_count: AUTHENTICATION_HISTORY_EXPORT_MAX_ENTRIES + 1 });
    failure(' '.repeat(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES + 1), 'too_large'); failure('é'.repeat(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES / 2 + 1), 'too_large');
    failure('['.repeat(33) + '0' + ']'.repeat(33), 'invalid_json');
    const legal = JSON.parse(source('full').json); legal.entries[0].record.group.label = 'Literal brackets [ { and quote " with backslash \\';
    expect(openReport(JSON.stringify(legal)).snapshot.count).toBe(7);
  });
  it.each(['aliases', 'full'] as const)('opens an empty complete %s export', mode => { const original = source(mode, fixture([])); expect(openReport(original.json).snapshot.count).toBe(0); });
  it('rejects overlong pasted text before allocating UTF-8 bytes or parsing JSON', () => {
    const text = ' '.repeat(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES + 1); const encode = vi.spyOn(TextEncoder.prototype, 'encode'); const parse = vi.spyOn(JSON, 'parse');
    try { failure(text, 'too_large'); expect(encode).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled(); }
    finally { encode.mockRestore(); parse.mockRestore(); }
  });
});
