import { describe, expect, it } from 'vitest';
import { authenticationHistoryEntryOutcome, authenticationHistoryEntryType, authenticationHistoryExportReport, AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES,
  type AuthenticationIncident, type AuthenticationRepairAction, type AuthenticationAccessVerification, type AuthenticationHistoryExport, type AuthenticationHistoryEntry, type AuthenticationRenewalHistory } from '@recued/contracts';
import { prepareAuthenticationHistoryDownload } from '../connections/authentication-history-export.js';
import { createAuthenticationHistoryRelatedBundles, prepareAuthenticationHistoryRelatedDownload } from '../connections/authentication-history-related-bundle.js';

const uuid = (n: number): string => n.toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc';
const incident = (n: number): AuthenticationIncident => ({ id: uuid(n), status: 'retired', started_at: 100, last_problem_at: 100, history_started_at: 100, ended_at: 200,
  retirement_reason: 'authentication_changed', currently_reported: false, level: 'rejected', events_truncated: false, details_truncated: false,
  events: [{ kind: 'opened', at: 100, level: 'rejected' }, { kind: 'retired', at: 200, level: 'rejected' }],
  group: { id: 'a'.repeat(64), kind: 'account', label: 'Private account ' + n, authentication: 'direct_oauth', connection_names: ['work'],
    targets: [{ kind: 'connection', name: 'work' }], issues: [], uses: [], usage_available: true } });
const repair = (n: number, incidents = [incident(1)]): AuthenticationRepairAction => ({ id: 'repair-' + n.toString(16).padStart(64, '0'), action: 'reauthorize', status: 'applied',
  started_at: 110, finished_at: 120, targets: [{ kind: 'connection', name: 'work' }], targets_truncated: false, incidents_truncated: false,
  incidents: incidents.map(i => ({ id: i.id, group_id: i.group.id, label: i.group.label })) });
const check = (n: number, selection: AuthenticationAccessVerification['selection'] = { kind: 'repair', id: repair(1).id }): AuthenticationAccessVerification => ({ id: 'verify-' + uuid(n), selection,
  status: 'completed', started_at: 130, finished_at: 140, targets_truncated: false, usage_available: true, uses: [], results: [{ id: 'b'.repeat(64), label: 'Private API',
    target: { kind: 'connection', name: 'work' }, authentication_revision: 'c'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] }] });
const report = (records: AuthenticationHistoryEntry[]): AuthenticationHistoryExport => ({ format: 'recued.connection-history', version: 1, exported_at: 300, scope: { kind: 'all' }, filters: {},
  retention_days: 90, finished_record_limit: 10000, complete: true, evidence: 'retained_local_observations', current_authentication: 'not_checked', entry_count: records.length,
  entries: records.map(record => ({ type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record })) });
const prepare = (source: AuthenticationHistoryExport, mode: 'aliases' | 'full' = 'full') => prepareAuthenticationHistoryDownload(source, { scope: source.scope, filters: source.filters }, mode);

describe('related history bundle', () => {
  it.each(['aliases', 'full'] as const)('follows explicit references in both directions in %s mode, once per record and in snapshot order', mode => {
    const root = incident(1); const other = incident(2); const shared = repair(1, [root, other]); const second = repair(2, [other]);
    const initial = check(1); const recheck = check(2, { kind: 'verification', id: initial.id }); const followup = check(3, { kind: 'repair', id: second.id });
    const source = report([recheck, incident(99), check(99, { kind: 'group', id: root.group.id }), shared, root, followup, other, initial, second, repair(99, [])]);
    const snapshot = prepare(source, mode); const before = snapshot.json; const bundle = createAuthenticationHistoryRelatedBundles(snapshot)(4);
    expect(bundle.report.entries).toEqual([0, 3, 4, 5, 6, 7, 8].map(i => snapshot.report.entries[i]));
    bundle.report.entries.forEach(entry => expect(snapshot.report.entries).toContain(entry));
    expect(bundle.report).toMatchObject({ root: { type: 'incident', id: snapshot.report.entries[4]!.record.id, source_position: 5 }, coverage: 'source_snapshot_only',
      link_rule: 'saved_record_references_both_directions', unrecorded_or_excluded_links: 'not_known', current_authentication: 'not_checked',
      counts: { incident: 2, repair: 2, verification: 3, renewal: 0 }, entry_count: 7, missing_reference_count: 0, incomplete_record_count: 0 });
    expect(snapshot.json).toBe(before); expect(Object.isFrozen(bundle.report.entries)).toBe(true); expect(Object.isFrozen(bundle.report.root)).toBe(true);
    expect(bundle.filename).toBe(snapshot.filename.slice(0, -5) + '-related-incident-5.json');
    expect(bundle.filename).not.toMatch(/Private|123456789abc|work/); const downloaded = prepareAuthenticationHistoryRelatedDownload(bundle);
    expect(JSON.parse(downloaded.json)).toEqual(bundle.report); expect(downloaded.filename).toBe(bundle.filename);
    expect(bundle.report).not.toHaveProperty('complete'); expect(bundle.report.source_snapshot).toMatchObject({ entry_count: source.entry_count, format: snapshot.report.format, exported_at: 300 });
  });
  it('keeps original aliases instead of renumbering the subset, and never brings back projected secrets or labels', () => {
    const source = report([incident(99), incident(1), repair(1), check(1)]); Object.assign(source.entries[1]!.record, { access_token: 'private-token' });
    const snapshot = prepare(source, 'aliases'); const bundle = createAuthenticationHistoryRelatedBundles(snapshot)(1); const json = prepareAuthenticationHistoryRelatedDownload(bundle).json;
    expect(bundle.report).toMatchObject({ privacy_mode: 'aliases', alias_scope: 'source_snapshot', root: { id: 'incident-2' } });
    expect(json).not.toMatch(/Private|private-token|123456789abc|"work"|"label"/); expect(bundle.report.entries[0]!.record.id).toBe('incident-2');
    expect(JSON.stringify(bundle.report.entries)).toBe(JSON.stringify(snapshot.report.entries.slice(1))); expect(json).not.toContain('incident-1');
  });
  it.each(['aliases', 'full'] as const)('marks missing incident references and saved incomplete flags in %s mode without fabricating records', mode => {
    const partial = repair(1, [incident(1), incident(2)]); partial.incidents_truncated = true; const root = incident(1); root.events_truncated = true;
    const source = report([root, partial, check(1)]); const snapshot = prepare(source, mode); const bundle = createAuthenticationHistoryRelatedBundles(snapshot)(0);
    const savedRepair = snapshot.report.entries[1]!.record; if (!('incidents' in savedRepair)) throw Error();
    expect(bundle.report).toMatchObject({ entry_count: 3, incomplete_record_count: 2, missing_reference_count: 1, missing_references: [{
      from: { type: 'repair', id: savedRepair.id }, to: { type: 'incident', id: savedRepair.incidents[1]!.id }, reason: 'outside_snapshot' }] });
    expect(bundle.report.entries).toEqual(snapshot.report.entries); expect(bundle.report.entries).toHaveLength(3);
  });
  it('does not infer links from identical groups, connections, app labels, targets or clocks', () => {
    const root = incident(1); const source = report([root, incident(2), repair(2, [incident(2)]), check(2, { kind: 'group', id: root.group.id })]);
    const snapshot = prepare(source); const bundle = createAuthenticationHistoryRelatedBundles(snapshot)(0);
    expect(bundle.report.entries).toEqual([snapshot.report.entries[0]]); expect(bundle.report.missing_references).toEqual([]);
  });
  it('keeps renewal-led checks separate even when the renewal and a related repair share an app and connection', () => {
    const related = repair(1); related.from = { type: 'direct_oauth', app_id: 'default' };
    const renewal: AuthenticationRenewalHistory = { id: 'renewal-' + uuid(1), issuer: 'google', app_id: 'default', app_revision: 1, app_label: 'Private account 1', status: 'completed',
      started_at: 110, finished_at: 120, history_started_at: 110, incomplete: false, results: [{ id: 'd'.repeat(64), revision: 'e'.repeat(64), label: 'Private account 1',
        eligible: true, connections: ['work'], native_accounts: [], status: 'passed', current: 'yes' }] };
    const verification = check(1, { kind: 'renewal', id: renewal.id }); const snapshot = prepare(report([incident(1), related, renewal, verification]));
    const bundle = createAuthenticationHistoryRelatedBundles(snapshot)(0); expect(bundle.report.entries).toEqual(snapshot.report.entries.slice(0, 2));
    expect(bundle.report.counts).toEqual({ incident: 1, repair: 1, verification: 0, renewal: 0 });
  });
  it('preserves the captured scope, applied filters and retention limits, even when the root has no available links', () => {
    const source = report([incident(1)]); source.scope = { kind: 'connection', name: 'work' }; source.filters = { type: 'incident', search: 'Private' };
    const snapshot = prepare(source, 'aliases'); const bundle = createAuthenticationHistoryRelatedBundles(snapshot)(0);
    expect(bundle.report.source_snapshot).toMatchObject({ scope: { kind: 'connection', name: 'connection-1' }, filters: { type: 'incident', search_applied: true }, retention_days: 90, finished_record_limit: 10000 });
    expect(bundle.report.entry_count).toBe(1); expect(bundle.report.missing_reference_count).toBe(0); expect(bundle.report.unrecorded_or_excluded_links).toBe('not_known');
  });
  it('remains tied to the frozen preview after caller mutations and across repeated selections', () => {
    const source = report([incident(1), repair(1), check(1)]); const snapshot = prepare(source); const select = createAuthenticationHistoryRelatedBundles(snapshot);
    const before = prepareAuthenticationHistoryRelatedDownload(select(0)); source.entries.length = 1; source.exported_at = 900;
    expect(prepareAuthenticationHistoryRelatedDownload(select(0))).toEqual(before); expect(Object.isFrozen(select(0).report.source_snapshot.filters)).toBe(true);
  });
  it('handles links shared across a dense graph without recursive traversal or duplicate records', () => {
    const roots = Array.from({ length: 64 }, (_, n) => incident(n)); const repairs = Array.from({ length: 64 }, (_, n) => repair(n, roots));
    const source = report([...roots, ...repairs, ...repairs.map((r, n) => check(n, { kind: 'repair', id: r.id }))]); const snapshot = prepare(source);
    const bundle = createAuthenticationHistoryRelatedBundles(snapshot)(0); expect(bundle.report.entries).toEqual(snapshot.report.entries); expect(bundle.report.entry_count).toBe(192);
  });
  it('does not pull a disconnected verification cycle into an incident bundle', () => {
    const first = check(1, { kind: 'verification', id: check(2).id }); const second = check(2, { kind: 'verification', id: first.id });
    const snapshot = prepare(report([incident(1), first, second])); expect(createAuthenticationHistoryRelatedBundles(snapshot)(0).report.entry_count).toBe(1);
  });
  it.each([-1, 0.5, NaN, Infinity, 3, 1, 2])('rejects non-incident or invalid source position %s', index => {
    const snapshot = prepare(report([incident(1), repair(1), check(1)])); expect(() => createAuthenticationHistoryRelatedBundles(snapshot)(index)).toThrow('Choose an incident from this preview.');
  });
  it('enforces the UTF-8 byte ceiling when bundle metadata pushes a valid source snapshot over the limit', () => {
    const checks = Array.from({ length: 1600 }, (_, n) => {
      const result = check(n); result.results[0]!.label = 'é'.repeat(2048); return result;
    });
    const root = incident(1); const source = report([root, repair(1), ...checks]);
    // Fill public labels up to the exact existing snapshot byte limit.
    let remaining = AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES - new TextEncoder().encode(JSON.stringify(authenticationHistoryExportReport(source))).byteLength;
    expect(remaining).toBeGreaterThan(0);
    for (const v of checks) {
      if (remaining <= 0) break;
      const use = { kind: 'pack' as const, id: 'p', label: 'x' };
      const overhead = new TextEncoder().encode(JSON.stringify([use])).byteLength - 2;
      if (remaining < overhead) break;
      v.uses = [use]; remaining -= overhead; const more = Math.min(2047, remaining); use.label += 'x'.repeat(more); remaining -= more;
    }
    root.group.label += 'x'.repeat(remaining); remaining = 0;
    expect(remaining).toBe(0); const snapshot = prepare(source); expect(snapshot.bytes).toBe(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES);
    const bundle = createAuthenticationHistoryRelatedBundles(snapshot)(0); expect(bundle.report.entry_count).toBe(snapshot.count);
    expect(() => prepareAuthenticationHistoryRelatedDownload(bundle)).toThrow('Related history bundle is too large.');
    expect(snapshot.json).toBe(JSON.stringify(snapshot.report));
  });
});
