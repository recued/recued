import { describe, expect, it } from 'vitest';
import { authenticationHistoryExportRecord, authenticationHistoryExportReport, isAuthenticationHistoryExport, isAuthenticationHistoryExportQuery,
  type AuthenticationHistoryExport } from '../authentication-history-export.js';
import { authenticationHistoryEntryType, authenticationHistoryEntryOutcome, type AuthenticationHistoryEntry } from '../authentication-incident-history.js';

const records = (): AuthenticationHistoryEntry[] => [
  { id: '12345678-1234-4123-8123-123456789abc', status: 'recovered', started_at: 100, history_started_at: 100, ended_at: 200,
    recovery_evidence: { earliest_at: 150, latest_at: 190 }, currently_reported: false, level: 'rejected', events_truncated: true, details_truncated: true,
    events: [{ kind: 'opened', at: 100, level: 'rejected' }, { kind: 'recovered', at: 200, level: 'rejected' }],
    group: { id: 'a'.repeat(64), kind: 'account', label: 'Work', authentication: 'direct_oauth', connection_names: ['work'], usage_available: false,
      issues: [{ id: 'b'.repeat(64), code: 'credential_rejected', message: 'raw-provider-error-marker' }], targets: [{ kind: 'connection', name: 'work' }], uses: [{ kind: 'pack', id: 'sheet', label: 'Sheets' }] } },
  { id: 'repair-' + 'd'.repeat(64), action: 'rotate_secret', status: 'applied', started_at: 100, finished_at: 120,
    from: { type: 'direct_oauth', app_id: 'work' }, to: { type: 'broker', broker_profile_id: 'team', broker_account_id: 'work-account' },
    targets: [{ kind: 'connection', name: 'work' }], targets_truncated: false, incidents: [], incidents_truncated: false },
  { id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'group', id: 'a'.repeat(64) }, status: 'completed', started_at: 100, finished_at: 120,
    targets_truncated: true, uses: [], usage_available: false, results: [{ id: 'e'.repeat(64), label: 'Work file', target: { kind: 'file_source', source_id: 'work-file' },
      authentication_revision: 'f'.repeat(64), current: 'yes', file_connection: { name: 'work', updated_at: 100 },
      checks: [{ kind: 'file_metadata', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] }] },
  { id: 'renewal-12345678-1234-4123-8123-123456789abc', issuer: 'google', app_id: 'default', app_revision: 2, app_label: 'Work', started_at: 100,
    history_started_at: 180, finished_at: 150, status: 'completed', incomplete: true, references_incomplete: true,
    results: [{ id: 'e'.repeat(64), revision: 'f'.repeat(64), label: 'Work grant', connections: ['work'], native_accounts: [{ platform: 'mail', slug: 'work' }],
      eligible: true, status: 'unconfirmed', reason: 'not_selected', current: 'yes' }] },
];
const report = (): AuthenticationHistoryExport => ({ format: 'recued.connection-history', version: 1, exported_at: 300, scope: { kind: 'all' }, filters: {}, retention_days: 90,
  finished_record_limit: 10000, complete: true, evidence: 'retained_local_observations', current_authentication: 'not_checked', entry_count: 4,
  entries: records().map(record => ({ type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record })) });
const inject = (v: unknown): void => {
  if (!v || typeof v !== 'object') return;
  for (const child of Object.values(v)) inject(child);
  if (!Array.isArray(v)) Object.assign(v, { access_token: 'private-token-marker', client_secret: 'private-secret-marker', raw_error: 'private-error-marker' });
};

describe('connection history export contract', () => {
  it('recursively selects public fields for every record kind and removes live projections without changing evidence', () => {
    const value = report(); inject(value.entries); Object.assign(value, { client_secret: 'private-secret-marker' }); inject(value.scope); const before = JSON.stringify(value);
    expect(isAuthenticationHistoryExport(value)).toBe(true);
    const exported = authenticationHistoryExportReport(value); const json = JSON.stringify(exported);
    expect(isAuthenticationHistoryExport(exported)).toBe(true); expect(JSON.stringify(value)).toBe(before);
    expect(json).not.toMatch(/private-|raw-provider-error-marker|file_connection|access_token|client_secret|raw_error/);
    expect(exported.entries.map(e => e.outcome)).toEqual(['recovered', 'applied', 'passed', 'unconfirmed']);
    expect(exported.entries[0]!.record).toMatchObject({ recovery_evidence: { earliest_at: 150, latest_at: 190 }, events_truncated: true, details_truncated: true });
    expect(exported.entries[2]!.record).toMatchObject({ results: [{ current: 'unknown', checks: [{ kind: 'file_metadata', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] }], usage_available: false, targets_truncated: true });
    expect(exported.entries[3]!.record).toMatchObject({ results: [{ current: 'unknown', reason: 'not_selected' }], incomplete: true, references_incomplete: true });
  });
  it('does not carry latest-access or later-recovery projections into an applied repair receipt', () => {
    const entries = records(); const repair = entries[1]!;
    Object.assign(repair, { access_verification: { ...entries[2], selection: { kind: 'repair', id: repair.id } },
      incidents: [{ id: entries[0]!.id, group_id: 'a'.repeat(64), label: 'Work' }], recovery_confirmed_at: 190 });
    const exported = authenticationHistoryExportRecord(repair);
    expect(exported).not.toBeNull(); expect(exported).not.toHaveProperty('access_verification'); expect(exported).not.toHaveProperty('recovery_confirmed_at');
    expect(exported).toMatchObject({ status: 'applied', incidents: [{ id: entries[0]!.id }] });
  });
  it.each([null, [], { scope: { kind: 'bad' } }, { scope: { kind: 'all' }, cursor: 'older' }, { scope: { kind: 'all' }, limit: 10 },
    { scope: { kind: 'all' }, include_renewals: false }, { scope: { kind: 'all' }, filters: { search: '\ud800' } },
    { scope: { kind: 'all' }, filters: { from: '2026-02-30' } }, { scope: { kind: 'all' }, action: 'authentication_history' }])('rejects incomplete or invalid export selection %j', value => {
    expect(isAuthenticationHistoryExportQuery(value)).toBe(false);
  });
  it('accepts all supported scopes and an empty complete report', () => {
    for (const scope of [{ kind: 'all' }, { kind: 'oauth_apps' }, { kind: 'group', id: 'a'.repeat(64) }, { kind: 'connection', name: 'work' },
      { kind: 'collection', platform: 'mail', slug: 'work' }, { kind: 'file_source', source_id: 'work' }]) {
      expect(isAuthenticationHistoryExportQuery({ scope, action: 'authentication_history_export', filters: {} })).toBe(true);
    }
    expect(isAuthenticationHistoryExport({ ...report(), entries: [], entry_count: 0 })).toBe(true);
  });
  it.each([{ complete: false }, { entry_count: 3 }, { version: 2 }, { exported_at: NaN }, { current_authentication: 'yes' }, { retention_days: 100 },
    { filters: { outcome: 'passed' } }, { entries: [] }])('refuses a contradictory or partial report %j', patch => {
    expect(isAuthenticationHistoryExport({ ...report(), ...patch })).toBe(false);
  });
  it('rejects duplicate IDs, incorrect types/outcomes and malformed evidence', () => {
    const value = report(); value.entries[1] = value.entries[0]!; expect(isAuthenticationHistoryExport(value)).toBe(false);
    const wrong = report(); wrong.entries[0]!.outcome = 'passed'; expect(isAuthenticationHistoryExport(wrong)).toBe(false);
    wrong.entries[0]!.outcome = 'recovered'; wrong.entries[0]!.type = 'renewal'; expect(isAuthenticationHistoryExport(wrong)).toBe(false);
    expect(authenticationHistoryExportRecord({ ...records()[2], finished_at: 99 })).toBeNull();
  });
});
