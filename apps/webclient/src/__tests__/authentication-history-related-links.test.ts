import { describe, expect, it } from 'vitest';
import { authenticationHistoryEntryOutcome, authenticationHistoryEntryType, type AuthenticationIncident, type AuthenticationRepairAction,
  type AuthenticationAccessVerification, type AuthenticationHistoryExport, type AuthenticationHistoryEntry } from '@recued/contracts';
import { prepareAuthenticationHistoryDownload } from '../connections/authentication-history-export.js';
import { createAuthenticationHistoryRelatedBundles, prepareAuthenticationHistoryRelatedDownload } from '../connections/authentication-history-related-bundle.js';
import { createAuthenticationHistoryRelatedLinks } from '../connections/authentication-history-related-links.js';

const id = (n: number): string => n.toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc';
const incident = (n: number): AuthenticationIncident => ({ id: id(n), status: 'retired', started_at: 100, last_problem_at: 100, history_started_at: 100, ended_at: 200,
  retirement_reason: 'authentication_changed', currently_reported: false, level: 'rejected', events_truncated: false, details_truncated: false,
  events: [{ kind: 'opened', at: 100, level: 'rejected' }, { kind: 'retired', at: 200, level: 'rejected' }],
  group: { id: 'a'.repeat(64), kind: 'account', label: 'Private account', authentication: 'direct_oauth', connection_names: ['work'], targets: [{ kind: 'connection', name: 'work' }], uses: [], issues: [], usage_available: true } });
const repair = (n: number, incidents = [incident(1)]): AuthenticationRepairAction => ({ id: 'repair-' + n.toString(16).padStart(64, '0'), action: 'reauthorize', status: 'applied',
  started_at: 110, finished_at: 120, targets: [{ kind: 'connection', name: 'work' }], targets_truncated: false, incidents_truncated: false,
  incidents: incidents.map(i => ({ id: i.id, group_id: i.group.id, label: i.group.label })) });
const check = (n: number, selection: AuthenticationAccessVerification['selection']): AuthenticationAccessVerification => ({ id: 'verify-' + id(n), selection, status: 'completed',
  started_at: 130, finished_at: 140, targets_truncated: false, usage_available: true, uses: [], results: [{ id: 'b'.repeat(64), label: 'Private API', target: { kind: 'connection', name: 'work' }, authentication_revision: 'c'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] }] });
const prepare = (records: AuthenticationHistoryEntry[], mode: 'aliases' | 'full' = 'full') => {
  const source: AuthenticationHistoryExport = { format: 'recued.connection-history', version: 1, exported_at: 300, scope: { kind: 'all' }, filters: {}, retention_days: 90,
    finished_record_limit: 10000, complete: true, evidence: 'retained_local_observations', current_authentication: 'not_checked', entry_count: records.length,
    entries: records.map(record => ({ type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record })) };
  return prepareAuthenticationHistoryDownload(source, { scope: source.scope }, mode);
};

describe('typed links within a related history bundle', () => {
  it.each(['aliases', 'full'] as const)('preserves outgoing reference order and incoming snapshot order in %s mode', mode => {
    const shared = repair(1, [incident(2), incident(1)]); const other = repair(2); const verified = check(1, { kind: 'repair', id: shared.id });
    const recheck = check(2, { kind: 'verification', id: verified.id }); const snapshot = prepare([incident(99), recheck, other, incident(1), shared, incident(2), verified], mode);
    const bundle = createAuthenticationHistoryRelatedBundles(snapshot)(3); const links = createAuthenticationHistoryRelatedLinks(bundle);
    expect(bundle.report.entries).toEqual(snapshot.report.entries.slice(1));
    expect(links(2)).toEqual([1, 3].map(target => ({ direction: 'referenced_by', target, reference: { type: 'repair', id: bundle.report.entries[target]!.record.id } })));
    expect(links(3)).toEqual([
      { direction: 'references', reference: { type: 'incident', id: bundle.report.entries[4]!.record.id }, target: 4 },
      { direction: 'references', reference: { type: 'incident', id: bundle.report.entries[2]!.record.id }, target: 2 },
      { direction: 'referenced_by', reference: { type: 'verification', id: bundle.report.entries[5]!.record.id }, target: 5 },
    ]);
    expect(links(5)).toEqual([
      { direction: 'references', reference: { type: 'repair', id: bundle.report.entries[3]!.record.id }, target: 3 },
      { direction: 'referenced_by', reference: { type: 'verification', id: bundle.report.entries[0]!.record.id }, target: 0 },
    ]);
    expect(links(0)).toEqual([{ direction: 'references', reference: { type: 'verification', id: bundle.report.entries[5]!.record.id }, target: 5 }]);
  });
  it.each(['aliases', 'full'] as const)('retains unavailable references and their saved reason in %s mode', mode => {
    const snapshot = prepare([incident(1), repair(1, [incident(1), incident(2)])], mode); const bundle = createAuthenticationHistoryRelatedBundles(snapshot)(0);
    const missing = bundle.report.missing_references[0]!; const links = createAuthenticationHistoryRelatedLinks(bundle)(1);
    expect(links).toEqual([{ direction: 'references', reference: { type: 'incident', id: bundle.report.entries[0]!.record.id }, target: 0 },
      { direction: 'references', reference: missing.to, unavailable: 'outside_snapshot' }]);
    const differentType = { ...bundle, report: { ...bundle.report, missing_references: [{ ...missing, reason: 'type_mismatch' as const }] } };
    expect(createAuthenticationHistoryRelatedLinks(differentType)(1)[1]).toMatchObject({ reference: missing.to, unavailable: 'type_mismatch' });
  });
  it('does not infer references from account, target, app, label or time similarity', () => {
    const snapshot = prepare([incident(1), incident(2), repair(2, [incident(2)]), check(1, { kind: 'group', id: 'a'.repeat(64) })]);
    const bundle = createAuthenticationHistoryRelatedBundles(snapshot)(0); expect(bundle.report.entry_count).toBe(1); expect(createAuthenticationHistoryRelatedLinks(bundle)(0)).toEqual([]);
  });
  it.each(['aliases', 'full'] as const)('caches frozen links without changing %s snapshot or bundle bytes', mode => {
    const source = incident(1); Object.assign(source, { refresh_token: 'private-token' }); const snapshot = prepare([incident(99), source, repair(1), check(1, { kind: 'repair', id: repair(1).id })], mode);
    const bundle = createAuthenticationHistoryRelatedBundles(snapshot)(1); const before = prepareAuthenticationHistoryRelatedDownload(bundle); const links = createAuthenticationHistoryRelatedLinks(bundle);
    const first = links(0); expect(links(0)).toBe(first); expect(Object.isFrozen(first)).toBe(true); first.forEach(link => { expect(Object.isFrozen(link)).toBe(true); expect(Object.isFrozen(link.reference)).toBe(true); });
    expect(JSON.stringify(first)).not.toMatch(/Private|private-token|"work"/); if (mode === 'aliases') { expect(bundle.report.root.id).toBe('incident-2'); expect(JSON.stringify(first)).not.toContain('123456789abc'); }
    expect(prepareAuthenticationHistoryRelatedDownload(bundle)).toEqual(before); expect(JSON.stringify(snapshot.report)).toBe(snapshot.json); expect(bundle.report).not.toHaveProperty('navigation');
  });
  it.each([-1, 0.5, NaN, Infinity, 1])('rejects invalid bundle record position %s', index => {
    const snapshot = prepare([incident(1)]); const bundle = createAuthenticationHistoryRelatedBundles(snapshot)(0); expect(() => createAuthenticationHistoryRelatedLinks(bundle)(index)).toThrow('Choose a saved record from this bundle.');
  });
});
