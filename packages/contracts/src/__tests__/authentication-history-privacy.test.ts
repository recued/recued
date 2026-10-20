import { describe, expect, it } from 'vitest';
import { authenticationHistoryPrivateExport, isAuthenticationHistoryExport, type AuthenticationHistoryExport,
  type AuthenticationHistoryPrivateExport, type AuthenticationHistoryPrivateEntry } from '../authentication-history-export.js';
import { authenticationHistoryEntryType, authenticationHistoryEntryOutcome, type AuthenticationIncident, type AuthenticationRepairAction,
  type AuthenticationRenewalHistory, type AuthenticationHistoryEntry, type AuthenticationIncidentScope } from '../authentication-incident-history.js';
import type { AuthenticationAccessVerification } from '../authentication-access-verification.js';
import type { ManagedOAuthConnectionUse } from '../managed-oauth.js';

const fixture = (): [AuthenticationIncident, AuthenticationRepairAction, AuthenticationAccessVerification, AuthenticationRenewalHistory] => [
  { id: '12345678-1234-4123-8123-123456789abc', status: 'recovered', started_at: 100, history_started_at: 100, ended_at: 200,
    recovery_evidence: { earliest_at: 150, latest_at: 190 }, currently_reported: false, level: 'rejected', events_truncated: true, details_truncated: true,
    events: [{ kind: 'opened', at: 100, level: 'rejected' }, { kind: 'recovered', at: 200, level: 'rejected' }],
    group: { id: 'a'.repeat(64), kind: 'account', label: 'secret-person@example.test', authentication: 'direct_oauth', connection_names: ['secret-connection'], usage_available: false,
      issues: [{ id: 'b'.repeat(64), code: 'credential_rejected', message: 'secret-provider-error', observed_at: 101, secret_expires_on: '2026-12-01' }],
      targets: [{ kind: 'connection', name: 'secret-connection' }, { kind: 'collection', platform: 'mail', slug: 'secret-native' },
        { kind: 'collection', platform: 'calendar', slug: 'secret-native' }, { kind: 'file_source', source_id: 'secret-source' }, { kind: 'oauth_apps' }],
      uses: (['pack', 'mail', 'calendar', 'file', 'recipe', 'dish', 'schedule'] as const).map(kind => ({ kind, id: 'secret-use', label: 'Secret use' })) } },
  { id: 'repair-' + 'd'.repeat(64), action: 'switch_authentication', status: 'applied', started_at: 100, finished_at: 120, restart_required: true,
    from: { type: 'direct_oauth', app_id: 'app-' + '9'.repeat(32), label: 'Secret app', connection_name: 'secret-connection' },
    to: { type: 'broker', broker_profile_id: 'secret-profile', broker_account_id: 'secret-broker-account', label: 'Secret broker', connection_name: 'secret-connection' },
    targets: [{ kind: 'connection', name: 'secret-connection' }], targets_truncated: true,
    incidents: [{ id: '12345678-1234-4123-8123-123456789abc', group_id: 'a'.repeat(64), label: 'Secret incident' }], incidents_truncated: true },
  { id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'repair', id: 'repair-' + 'd'.repeat(64) }, status: 'completed', started_at: 100, finished_at: 120,
    targets_truncated: true, uses: [{ kind: 'pack', id: 'secret-use', label: 'Secret pack' }], usage_available: false,
    results: [{ id: 'e'.repeat(64), label: 'secret-person@example.test file', target: { kind: 'file_source', source_id: 'secret-source' },
      authentication_revision: 'f'.repeat(64), current: 'yes', file_connection: { name: 'secret-connection', updated_at: 100 },
      checks: [{ kind: 'file_metadata', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] }] },
  { id: 'renewal-12345678-1234-4123-8123-123456789abc', issuer: 'google', app_id: 'app-' + '9'.repeat(32), app_revision: 2, app_label: 'Secret app', started_at: 100,
    history_started_at: 180, finished_at: 150, status: 'completed', incomplete: true, references_incomplete: true,
    results: [{ id: 'e'.repeat(64), revision: 'f'.repeat(64), label: 'Secret grant', connections: ['secret-connection'],
      native_accounts: [{ platform: 'mail', slug: 'secret-native' }, { platform: 'calendar', slug: 'secret-native' }],
      eligible: true, status: 'unconfirmed', reason: 'not_selected', current: 'yes' }] },
];
const report = (records: AuthenticationHistoryEntry[] = fixture(), scope: AuthenticationIncidentScope = { kind: 'all' }): AuthenticationHistoryExport => ({
  format: 'recued.connection-history', version: 1, exported_at: 300, scope, filters: {}, retention_days: 90, finished_record_limit: 10000,
  complete: true, evidence: 'retained_local_observations', current_authentication: 'not_checked', entry_count: records.length,
  entries: records.map(record => ({ type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record })),
});
function row(value: AuthenticationHistoryPrivateExport, kind: 'incident', index?: number): Extract<AuthenticationHistoryPrivateEntry, { type: 'incident' }>['record'];
function row(value: AuthenticationHistoryPrivateExport, kind: 'repair', index?: number): Extract<AuthenticationHistoryPrivateEntry, { type: 'repair' }>['record'];
function row(value: AuthenticationHistoryPrivateExport, kind: 'verification', index?: number): Extract<AuthenticationHistoryPrivateEntry, { type: 'verification' }>['record'];
function row(value: AuthenticationHistoryPrivateExport, kind: 'renewal', index?: number): Extract<AuthenticationHistoryPrivateEntry, { type: 'renewal' }>['record'];
function row(value: AuthenticationHistoryPrivateExport, kind: AuthenticationHistoryPrivateEntry['type'], index = 0): AuthenticationHistoryPrivateEntry['record'] {
  const entry = value.entries.filter(e => e.type === kind)[index];
  if (!entry) throw new Error('Missing test record.'); return entry.record;
}
const inject = (v: unknown): void => {
  if (!v || typeof v !== 'object') return;
  for (const child of Object.values(v)) inject(child);
  if (!Array.isArray(v)) Object.assign(v, { client_secret: 'secret-credential', nested: { resource_url: 'https://secret.test/resource' } });
};

describe('privacy mode for connection history exports', () => {
  it('removes all free text, names, original IDs, fingerprints, search text and unknown fields without mutating evidence', () => {
    const input = report(); input.filters = { search: 'secret', from: '1970-01-01', through: '1970-01-01' };
    inject(input.entries); inject(input.scope); Object.assign(input, { client_secret: 'secret-credential' }); const before = JSON.stringify(input);
    expect(isAuthenticationHistoryExport(input)).toBe(true);
    const result = authenticationHistoryPrivateExport(input); const json = JSON.stringify(result);
    expect(json).not.toMatch(/secret-|Secret|example\.test|resource_url|client_secret|file_connection|"label"|"message"|"search"/);
    for (const raw of ['a', 'b', 'd', 'e', 'f'].map(c => c.repeat(64)).concat(fixture().map(r => r.id), ['app-' + '9'.repeat(32)])) expect(json).not.toContain(raw);
    expect(JSON.stringify(input)).toBe(before);
    expect(result).toMatchObject({ format: 'recued.connection-history.aliases', version: 1, alias_scope: 'this_file', complete: true, entry_count: 4,
      exported_at: 300, retention_days: 90, finished_record_limit: 10000, evidence: 'retained_local_observations', current_authentication: 'not_checked',
      filters: { search_applied: true, from: '1970-01-01', through: '1970-01-01' } });
    expect(result.entries.map(e => e.outcome)).toEqual(['recovered', 'applied', 'passed', 'unconfirmed']);
    expect(row(result, 'incident')).toMatchObject({ status: 'recovered', started_at: 100, history_started_at: 100, ended_at: 200,
      recovery_evidence: { earliest_at: 150, latest_at: 190 }, events_truncated: true, details_truncated: true,
      group: { usage_available: false, issues: [{ code: 'credential_rejected', observed_at: 101, secret_expires_on: '2026-12-01' }] } });
    expect(row(result, 'repair')).toMatchObject({ status: 'applied', restart_required: true, targets_truncated: true, incidents_truncated: true });
    expect(row(result, 'repair')).not.toHaveProperty('recovery_confirmed_at');
    expect(row(result, 'verification')).toMatchObject({ status: 'completed', started_at: 100, finished_at: 120, targets_truncated: true, usage_available: false,
      results: [{ current: 'unknown', checks: [{ kind: 'file_metadata', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] }] });
    expect(row(result, 'renewal')).toMatchObject({ issuer: 'google', app_revision: 2, status: 'completed', history_started_at: 180, incomplete: true,
      references_incomplete: true, results: [{ eligible: true, status: 'unconfirmed', reason: 'not_selected', current: 'unknown' }] });
    // An alias report can never be mistaken for runtime IDs by the full-report guard.
    expect(isAuthenticationHistoryExport(result)).toBe(false);
  });
  it('preserves exact record links, account references and related uses across all four kinds and later checks', () => {
    const [incident, repair, check, renewal] = fixture();
    const later: AuthenticationAccessVerification = { ...check, id: 'verify-22345678-1234-4123-8123-123456789abc', selection: { kind: 'verification', id: check.id } };
    const renewCheck: AuthenticationAccessVerification = { ...check, id: 'verify-32345678-1234-4123-8123-123456789abc', selection: { kind: 'renewal', id: renewal.id } };
    const groupCheck: AuthenticationAccessVerification = { ...check, id: 'verify-42345678-1234-4123-8123-123456789abc', selection: { kind: 'group', id: incident.group.id } };
    const result = authenticationHistoryPrivateExport(report([later, renewCheck, groupCheck, incident, repair, check, renewal], { kind: 'group', id: incident.group.id }));
    const i = row(result, 'incident'), r = row(result, 'repair'), v = row(result, 'verification', 3), n = row(result, 'renewal');
    expect(result.scope).toEqual({ kind: 'group', id: i.group.id });
    expect(r.incidents).toEqual([{ id: i.id, group_id: i.group.id }]); expect(v.selection).toEqual({ kind: 'repair', id: r.id });
    expect(row(result, 'verification', 0).selection).toEqual({ kind: 'verification', id: v.id });
    expect(row(result, 'verification', 1).selection).toEqual({ kind: 'renewal', id: n.id });
    expect(row(result, 'verification', 2).selection).toEqual({ kind: 'group', id: i.group.id });
    expect(r.targets).toEqual([i.group.targets[0]]); expect(r.from?.connection_name).toBe(i.group.connection_names[0]);
    expect(r.to?.connection_name).toBe(n.results[0]!.connections[0]); expect(n.results[0]!.connections).toEqual(i.group.connection_names);
    expect(v.results[0]!.target).toEqual(i.group.targets[3]);
    expect(n.results[0]!.native_accounts).toEqual(i.group.targets.slice(1, 3).map(t => { if (t.kind !== 'collection') throw Error(); return { platform: t.platform, slug: t.slug }; }));
    expect(n.results[0]!.native_accounts[0]!.slug).not.toBe(n.results[0]!.native_accounts[1]!.slug);
    expect(v.uses[0]).toEqual(i.group.uses[0]); expect(new Set(i.group.uses.map(u => u.id)).size).toBe(7);
    expect(v.results[0]!.id).toBe(row(result, 'verification', 0).results[0]!.id);
    expect(v.results[0]!.authentication_revision).toBe(row(result, 'verification', 0).results[0]!.authentication_revision);
    expect(v.results[0]!.id).not.toBe(n.results[0]!.id); expect(v.results[0]!.authentication_revision).not.toBe(n.results[0]!.revision);
  });
  it('qualifies saved apps by issuer and broker accounts by profile; unqualified method app IDs never create guessed joins', () => {
    const [, first, , google] = fixture();
    const same: AuthenticationRepairAction = { ...first, id: 'repair-' + '1'.repeat(64) };
    const other: AuthenticationRepairAction = { ...first, id: 'repair-' + '2'.repeat(64), to: { ...first.to!, broker_profile_id: 'other-profile' } };
    const unknown: AuthenticationRepairAction = { ...first, id: 'repair-' + '3'.repeat(64), from: { type: 'broker', broker_account_id: 'same-unqualified' }, to: { type: 'broker', broker_account_id: 'same-unqualified' } };
    const googleAgain: AuthenticationRenewalHistory = { ...google, id: 'renewal-22345678-1234-4123-8123-123456789abc' };
    const microsoft: AuthenticationRenewalHistory = { ...google, id: 'renewal-32345678-1234-4123-8123-123456789abc', issuer: 'microsoft' };
    const result = authenticationHistoryPrivateExport(report([first, same, other, unknown, google, googleAgain, microsoft]));
    expect(row(result, 'repair', 0).to).toEqual(row(result, 'repair', 1).to);
    expect(row(result, 'repair', 2).to?.broker_account_id).not.toBe(row(result, 'repair', 0).to?.broker_account_id);
    expect(row(result, 'repair', 3).from?.broker_account_id).not.toBe(row(result, 'repair', 3).to?.broker_account_id);
    expect(row(result, 'repair', 0).from).not.toHaveProperty('app_id');
    expect(row(result, 'repair', 0).from?.app_reference).not.toBe(row(result, 'renewal', 0).app_id);
    expect(row(result, 'renewal', 0).app_id).toBe(row(result, 'renewal', 1).app_id);
    expect(row(result, 'renewal', 2).app_id).not.toBe(row(result, 'renewal', 0).app_id);
  });
  it.each<AuthenticationIncidentScope>([{ kind: 'all' }, { kind: 'oauth_apps' }, { kind: 'connection', name: 'secret-connection' },
    { kind: 'file_source', source_id: 'secret-source' }, { kind: 'collection', platform: 'mail', slug: 'secret-native' },
    { kind: 'collection', platform: 'calendar', slug: 'secret-native' }, { kind: 'group', id: 'a'.repeat(64) }])('aliases the selected scope and supports complete empty reports: %j', scope => {
    const input = report([], scope); input.filters = { type: 'repair', outcome: 'applied' };
    const result = authenticationHistoryPrivateExport(input);
    expect(result).toMatchObject({ complete: true, entry_count: 0, entries: [], filters: { type: 'repair', outcome: 'applied', search_applied: false } });
    expect(result.scope.kind).toBe(scope.kind); expect(JSON.stringify(result.scope)).not.toMatch(/secret-|a{64}/);
  });
  it('keeps exact case-sensitive resource names distinct and resets aliases on each file', () => {
    const [incident] = fixture(); incident.group.connection_names = ['work', 'Work', 'work'];
    incident.group.uses = (['pack', 'recipe'] as const).map(kind => ({ kind, id: 'same', label: 'Same' } satisfies ManagedOAuthConnectionUse));
    const one = authenticationHistoryPrivateExport(report([incident]));
    expect(row(one, 'incident').group.connection_names).toEqual(['connection-1', 'connection-2', 'connection-1']);
    const [other] = fixture(); other.group.connection_names = ['different'];
    expect(row(authenticationHistoryPrivateExport(report([other])), 'incident').group.connection_names).toEqual(['connection-1']);
    expect(authenticationHistoryPrivateExport(report([incident]))).toEqual(one);
  });
  it('keeps nonempty connection, file and native-account scopes linked to their exact record targets', () => {
    const [incident] = fixture();
    for (const scope of incident.group.targets) {
      const result = authenticationHistoryPrivateExport(report([incident], scope));
      expect(row(result, 'incident').group.targets).toContainEqual(result.scope);
      if (scope.kind === 'collection') {
        const opposite = row(result, 'incident').group.targets.find(t => t.kind === 'collection' && t.platform !== scope.platform);
        expect(result.scope).not.toEqual(opposite);
      }
    }
  });
  it.each([{ complete: false }, { entry_count: 0 }, { filters: { search: 'does-not-match' } }])('refuses invalid or incomplete source data without producing another mode: %j', patch => {
    expect(() => authenticationHistoryPrivateExport({ ...report(), ...patch } as AuthenticationHistoryExport)).toThrow('Invalid history export');
  });
});
