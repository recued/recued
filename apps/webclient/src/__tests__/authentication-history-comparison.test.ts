import { describe, expect, it } from 'vitest';
import { authenticationHistoryEntryOutcome, authenticationHistoryEntryType, type AuthenticationHistoryEntry, type AuthenticationHistoryExport, type AuthenticationIncident, type AuthenticationAccessVerification, type AuthenticationRepairAction, type AuthenticationRenewalHistory } from '@recued/contracts';
import { prepareAuthenticationHistoryDownload } from '../connections/authentication-history-export.js';
import { openAuthenticationHistoryFile } from '../connections/authentication-history-saved-file.js';
import { compareAuthenticationHistorySnapshots, authenticationHistoryComparisonSnapshot, authenticationHistoryComparisonFieldValues } from '../connections/authentication-history-comparison.js';
import { createAuthenticationHistoryRelatedBundles } from '../connections/authentication-history-related-bundle.js';
import { authenticationHistoryRecordContext, prepareAuthenticationHistoryContextRecord } from '../connections/authentication-history-record-context.js';

const uuid = (n: number): string => n.toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc';
const incident = (n = 1, recovered = false): AuthenticationIncident => ({ id: uuid(n), status: recovered ? 'recovered' : 'open', started_at: 100, history_started_at: 100, last_problem_at: 100,
  ...(recovered ? { ended_at: 200, recovery_evidence: { earliest_at: 150, latest_at: 160 } } : {}), currently_reported: !recovered, level: 'rejected', events_truncated: false, details_truncated: false,
  events: [{ kind: 'opened', at: 100, level: 'rejected' }, ...(recovered ? [{ kind: 'recovered' as const, at: 200, level: 'rejected' as const }] : [])],
  group: { id: 'a'.repeat(64), kind: 'account', label: 'Private work', authentication: 'direct_oauth', connection_names: ['work'], targets: [{ kind: 'connection', name: 'work' }], issues: [], uses: [], usage_available: true } });
const report = (records: AuthenticationHistoryEntry[] = [incident()], at = 300): AuthenticationHistoryExport => ({ format: 'recued.connection-history', version: 1, exported_at: at, scope: { kind: 'all' }, filters: {}, retention_days: 90, finished_record_limit: 10000,
  complete: true, evidence: 'retained_local_observations', current_authentication: 'not_checked', entry_count: records.length, entries: records.map(record => ({ type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record })) });
const prepared = (value: AuthenticationHistoryExport, mode: 'aliases' | 'full' = 'full') => prepareAuthenticationHistoryDownload(value, { scope: value.scope, filters: value.filters }, mode);
const opened = (value: AuthenticationHistoryExport, mode: 'aliases' | 'full' = 'full') => openAuthenticationHistoryFile(prepared(value, mode).json);

describe('saved history snapshot comparison', () => {
  it('matches typed IDs and distinguishes saved changes from one-sided inclusion without inventing recovery', () => {
    const before = opened(report([incident(1), incident(2), incident(3)])), after = opened(report([incident(4), incident(1, true), incident(3)], 400));
    const result = compareAuthenticationHistorySnapshots(before, after);
    expect(result.counts).toEqual({ comparison_only: 1, changed: 1, baseline_only: 1, unchanged: 1 });
    expect(result.rows.map(row => [row.id, row.kind, row.baseline_index, row.comparison_index])).toEqual([
      [uuid(4), 'comparison_only', undefined, 0], [uuid(1), 'changed', 0, 1], [uuid(3), 'unchanged', 2, 2], [uuid(2), 'baseline_only', 1, undefined],
    ]);
    expect(result.rows[1]!.fields).toEqual(expect.arrayContaining(['outcome', 'status', 'ended_at', 'events', 'recovery_evidence']));
    expect(result.rows[3]!.fields).toEqual([]); expect(result.baseline.report.entries[1]!.outcome).toBe('open');
  });
  it('compares repair, read verification and renewal saved outcomes independently', () => {
    const repair: AuthenticationRepairAction = { id: 'repair-' + '1'.repeat(64), action: 'reauthorize', status: 'checking', started_at: 110, targets: [{ kind: 'connection', name: 'work' }], targets_truncated: false, incidents: [], incidents_truncated: false };
    const verify: AuthenticationAccessVerification = { id: 'verify-' + uuid(1), selection: { kind: 'repair', id: repair.id }, started_at: 120, finished_at: 130, status: 'completed', targets_truncated: false, uses: [], usage_available: true,
      results: [{ id: 'b'.repeat(64), label: 'Private API', authentication_revision: 'c'.repeat(64), current: 'unknown', target: { kind: 'connection', name: 'work' }, checks: [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_executed' }] }] };
    const renewal: AuthenticationRenewalHistory = { id: 'renewal-' + uuid(1), issuer: 'google', app_id: 'default', app_revision: 2, app_label: 'Private app', status: 'completed', started_at: 140, finished_at: 150, history_started_at: 180, incomplete: false,
      results: [{ id: 'd'.repeat(64), revision: 'e'.repeat(64), label: 'Private authorization', eligible: true, status: 'unconfirmed', reason: 'not_selected', current: 'unknown', connections: ['work'], native_accounts: [] }] };
    const afterRepair = { ...repair, status: 'applied' as const, finished_at: 115 }, afterVerify = structuredClone(verify), afterRenewal = structuredClone(renewal);
    afterVerify.results[0]!.checks = [{ kind: 'api_read', status: 'passed' }]; afterRenewal.results[0]!.status = 'passed'; delete afterRenewal.results[0]!.reason;
    const result = compareAuthenticationHistorySnapshots(opened(report([repair, verify, renewal])), opened(report([afterRepair, afterVerify, afterRenewal])));
    expect(result.counts.changed).toBe(3); expect(result.rows.every(row => row.fields.includes('outcome'))).toBe(true);
    expect(result.rows[1]!.fields).toContain('results'); expect(result.rows[2]!.fields).toContain('results');
  });
  it('ignores object key order but preserves recorded array order', () => {
    const record = incident(); record.group.connection_names = ['work', 'other']; const first = prepared(report([record]));
    const reordered = JSON.parse(first.json); reordered.entries[0].record = Object.fromEntries(Object.entries(reordered.entries[0].record).reverse());
    reordered.entries[0].record.group = Object.fromEntries(Object.entries(reordered.entries[0].record.group).reverse());
    expect(compareAuthenticationHistorySnapshots(openAuthenticationHistoryFile(first.json), openAuthenticationHistoryFile(JSON.stringify(reordered))).counts.unchanged).toBe(1);
    reordered.entries[0].record.group.connection_names.reverse();
    expect(compareAuthenticationHistorySnapshots(openAuthenticationHistoryFile(first.json), openAuthenticationHistoryFile(JSON.stringify(reordered))).rows[0]!.fields).toEqual(['group']);
  });
  it.each(['earlier', 'same', 'later'] as const)('keeps selected sides when the comparison capture is %s', order => {
    const at = order === 'earlier' ? 250 : order === 'same' ? 300 : 400;
    const result = compareAuthenticationHistorySnapshots(opened(report()), opened(report([incident()], at)));
    expect(result.capture_order).toBe(order); expect(result.baseline.report.exported_at).toBe(300); expect(result.comparison.report.exported_at).toBe(at); expect(result.counts.unchanged).toBe(1);
  });
  it('reports source scope/filter differences without deriving record changes or complete history', () => {
    const a = report(), b = report(); b.scope = { kind: 'connection', name: 'work' }; b.filters = { search: 'Private' };
    const result = compareAuthenticationHistorySnapshots(opened(a), opened(b));
    expect([result.scope_matches, result.filters_match]).toEqual([false, false]); expect(result.counts.unchanged).toBe(1);
    expect(result.rows[0]!.fields).toEqual([]);
  });
  it('compares empty reports and keeps newly included older records separate from incident creation', () => {
    const result = compareAuthenticationHistorySnapshots(opened(report([], 300)), opened(report([incident()], 400)));
    expect(result.counts.comparison_only).toBe(1); expect(result.comparison.report.entries[0]!.record.started_at).toBe(100);
    expect(compareAuthenticationHistorySnapshots(opened(report([])), opened(report([]))).rows).toEqual([]);
  });
  it('keeps omissions and incomplete flags as saved data rather than asserting complete recovery', () => {
    const a = incident(), b = incident(); b.details_truncated = true; b.events_truncated = true;
    const result = compareAuthenticationHistorySnapshots(opened(report([a])), opened(report([b])));
    expect(result.rows[0]!.fields).toEqual(['details_truncated', 'events_truncated']); expect(result.comparison.report.entries[0]!.outcome).toBe('open');
  });
  it('freezes output and preserves both source snapshots and positions', () => {
    const a = opened(report()), b = opened(report([incident(2), incident()], 400)); const before = JSON.stringify([a, b]);
    const result = compareAuthenticationHistorySnapshots(a, b);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.rows)).toBe(true); expect(Object.isFrozen(result.rows[0])).toBe(true); expect(Object.isFrozen(result.rows[0]!.fields)).toBe(true);
    expect(JSON.stringify([a, b])).toBe(before); expect(compareAuthenticationHistorySnapshots(a, b)).toEqual(result);
    expect(result.rows[1]).toMatchObject({ baseline_index: 0, comparison_index: 1 });
  });
  it.each(['baseline', 'comparison'] as const)('refuses file-local aliases in the %s slot even when alias text matches', side => {
    const aliases = opened(report(), 'aliases'), full = opened(report());
    expect(() => compareAuthenticationHistorySnapshots(side === 'baseline' ? aliases : full, side === 'comparison' ? aliases : full)).toThrow('assigned separately');
  });
  it('refuses single records and related bundles including their synthetic report wrappers', () => {
    const source = prepared(report()), entry = source.report.entries[0]!;
    const single = openAuthenticationHistoryFile(JSON.stringify(entry));
    const context = openAuthenticationHistoryFile(prepareAuthenticationHistoryContextRecord(entry, authenticationHistoryRecordContext(source, 0)).json);
    const related = openAuthenticationHistoryFile(JSON.stringify(createAuthenticationHistoryRelatedBundles(source)(0).report));
    for (const value of [single, context, related]) expect(() => authenticationHistoryComparisonSnapshot(value)).toThrow('complete history report');
  });

  it('reads changed values from the matched positions and keeps raw outcomes distinct from record status', () => {
    const a = incident(), b = incident(1, true);
    const capture = compareAuthenticationHistorySnapshots(opened(report([incident(2), a])), opened(report([b], 400)));
    expect(authenticationHistoryComparisonFieldValues(capture, 0, 'status')).toEqual({ baseline: { present: true, json: '"open"' }, comparison: { present: true, json: '"recovered"' } });
    const values = authenticationHistoryComparisonFieldValues(capture, 0, 'outcome');
    expect(values).toEqual({ baseline: { present: true, json: '"open"' }, comparison: { present: true, json: '"recovered"' } });
    expect(Object.isFrozen(values)).toBe(true); expect(Object.isFrozen(values.baseline)).toBe(true); expect(Object.isFrozen(values.comparison)).toBe(true);
    expect(capture.rows[0]).toMatchObject({ baseline_index: 1, comparison_index: 0 });
  });
  it.each(['baseline', 'comparison'] as const)('keeps a missing optional field explicit in the %s report', missing => {
    const a = incident(), b = incident(); delete (missing === 'baseline' ? a : b).last_problem_at;
    const result = compareAuthenticationHistorySnapshots(opened(report([a])), opened(report([b], 400)));
    const values = authenticationHistoryComparisonFieldValues(result, 0, 'last_problem_at');
    expect(values[missing]).toEqual({ present: false }); expect(values[missing === 'baseline' ? 'comparison' : 'baseline']).toEqual({ present: true, json: '100' });
  });
  it('preserves zero, false, empty arrays, quotes, Unicode and nested saved data without display normalization', () => {
    const a = incident(), b = incident(); a.history_started_at = 0; b.history_started_at = 50; b.events_truncated = true;
    b.group.label = '<img src="/private-field-image"> "Café" 🚀'; b.group.uses = [{ kind: 'pack', id: 'sheets', label: 'Saved scope "one"' }];
    const first = opened(report([a])), second = opened(report([b], 400)), before = JSON.stringify([first, second]);
    const capture = compareAuthenticationHistorySnapshots(first, second);
    expect(authenticationHistoryComparisonFieldValues(capture, 0, 'history_started_at').baseline).toEqual({ present: true, json: '0' });
    expect(authenticationHistoryComparisonFieldValues(capture, 0, 'events_truncated')).toEqual({ baseline: { present: true, json: 'false' }, comparison: { present: true, json: 'true' } });
    const group = authenticationHistoryComparisonFieldValues(capture, 0, 'group');
    if (!group.baseline.present || !group.comparison.present) throw Error('Expected saved group values.');
    expect(JSON.parse(group.baseline.json)).toEqual(a.group); expect(JSON.parse(group.comparison.json)).toEqual(b.group);
    expect(JSON.parse(group.baseline.json).uses).toEqual([]); expect(group.comparison.json).toContain('🚀'); expect(group.comparison.json).toContain('\\"Café\\"');
    expect(JSON.stringify([first, second])).toBe(before);
  });
  it('keeps large nested values complete in compact JSON, including the final saved item', () => {
    const a = incident(), b = incident(); b.group.uses = Array.from({ length: 50 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: '🚀é'.repeat(60) }));
    const capture = compareAuthenticationHistorySnapshots(opened(report([a])), opened(report([b], 400)));
    const values = authenticationHistoryComparisonFieldValues(capture, 0, 'group');
    if (!values.comparison.present) throw Error('Expected saved group.');
    const saved = (capture.comparison.report.entries[0]!.record as AuthenticationIncident).group;
    expect(values.comparison.json.length).toBeGreaterThan(4096); expect(values.comparison.json).toBe(JSON.stringify(saved));
    expect(JSON.parse(values.comparison.json).uses.at(-1)).toEqual(b.group.uses.at(-1));
  });
  it.each(['unchanged', 'baseline-only', 'comparison-only', 'unlisted-field', 'invalid-row'] as const)('does not expose values for %s selections', selection => {
    const capture = selection === 'baseline-only' ? compareAuthenticationHistorySnapshots(opened(report()), opened(report([])))
      : selection === 'comparison-only' ? compareAuthenticationHistorySnapshots(opened(report([])), opened(report()))
      : compareAuthenticationHistorySnapshots(opened(report()), opened(report([incident(1, selection !== 'unchanged')])));
    expect(() => authenticationHistoryComparisonFieldValues(capture, selection === 'invalid-row' ? -1 : 0, selection === 'unlisted-field' ? 'group' : 'status')).toThrow('Choose a changed saved field.');
  });
  it('does not invent a saved change when equivalent JSON zeros use a different sign', () => {
    const value = incident(); value.started_at = 0; value.history_started_at = 0; value.last_problem_at = 0; value.events[0]!.at = 0;
    const json = prepared(report([value])).json;
    const baseline = openAuthenticationHistoryFile(json.replace('"history_started_at":0', '"history_started_at":-0').replace('"at":0', '"at":-0'));
    const record = authenticationHistoryComparisonSnapshot(baseline).report.entries[0]!.record as AuthenticationIncident;
    expect(Object.is(record.history_started_at, -0)).toBe(true); expect(Object.is(record.events[0]!.at, -0)).toBe(true);
    const result = compareAuthenticationHistorySnapshots(baseline, openAuthenticationHistoryFile(json));
    expect(result.counts.changed).toBe(0); expect(result.counts.unchanged).toBe(1); expect(result.rows[0]!.fields).toEqual([]);
  });

});
