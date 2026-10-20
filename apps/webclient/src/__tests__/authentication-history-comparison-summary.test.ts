import { describe, expect, it } from 'vitest';
import { authenticationHistoryEntryOutcome, authenticationHistoryEntryType, type AuthenticationHistoryEntry, type AuthenticationHistoryExport, type AuthenticationIncident,
  type AuthenticationIncidentScope, type AuthenticationRepairAction, type AuthenticationAccessVerification, type AuthenticationRenewalHistory } from '@recued/contracts';
import { prepareAuthenticationHistoryDownload } from '../connections/authentication-history-export.js';
import { openAuthenticationHistoryFile } from '../connections/authentication-history-saved-file.js';
import { compareAuthenticationHistorySnapshots } from '../connections/authentication-history-comparison.js';
import { prepareAuthenticationHistoryComparisonSummary } from '../connections/authentication-history-comparison-summary.js';

const uuid = (n: number): string => n.toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc';
const incident = (n = 1, recovered = false): AuthenticationIncident => ({ id: uuid(n), status: recovered ? 'recovered' : 'open', started_at: 100, history_started_at: 100,
  ...(recovered ? { ended_at: 200 } : {}), currently_reported: !recovered, level: 'rejected', events_truncated: false, details_truncated: false,
  events: [{ kind: 'opened', at: 100, level: 'rejected' }, ...(recovered ? [{ kind: 'recovered' as const, at: 200, level: 'rejected' as const }] : [])],
  group: { id: 'a'.repeat(64), kind: 'account', label: 'private-account-label', authentication: 'direct_oauth', connection_names: ['work'], targets: [{ kind: 'connection', name: 'work' }], uses: [], issues: [], usage_available: true } });
const repair = (n = 1): AuthenticationRepairAction => ({ id: 'repair-' + n.toString(16).padStart(64, '0'), action: 'reauthorize', status: 'checking', started_at: 100,
  targets: [{ kind: 'oauth_apps' }], targets_truncated: false, incidents: [], incidents_truncated: false });
const report = (records: AuthenticationHistoryEntry[] = [incident()], at = 300): AuthenticationHistoryExport => ({ format: 'recued.connection-history', version: 1,
  exported_at: at, scope: { kind: 'all' }, filters: {}, retention_days: 90, finished_record_limit: 10000, complete: true, evidence: 'retained_local_observations', current_authentication: 'not_checked',
  entry_count: records.length, entries: records.map(record => ({ type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record })) });
const opened = (value: AuthenticationHistoryExport) => openAuthenticationHistoryFile(prepareAuthenticationHistoryDownload(value, { scope: value.scope, filters: value.filters }).json);
const comparison = (a = report(), b = report([incident(1, true)], 400)) => compareAuthenticationHistorySnapshots(opened(a), opened(b));

describe('saved comparison support summary', () => {
  it('covers every difference and original position while counting unchanged rows without listing them', () => {
    const capture = comparison(report([incident(1), incident(2), incident(3)]), report([incident(3), incident(1, true), incident(4)], 400));
    const before = JSON.stringify(capture), result = prepareAuthenticationHistoryComparisonSummary(capture);
    expect(result.differences).toBe(3); expect(result.text).toContain('Only in comparison: 1.'); expect(result.text).toContain('Changed saved data: 1.');
    expect(result.text).toContain('Only in baseline: 1.'); expect(result.text).toContain('Same saved data: 1.');
    expect(result.text).toContain('Changed saved fields: "outcome" (Recorded outcome)'); expect(result.text).toContain('"status" (Status)');
    expect(result.text).toContain('Baseline source position: 1; recorded outcome: Open incident.'); expect(result.text).toContain('Comparison source position: 2; recorded outcome: Recorded recovery.');
    expect(result.text).toContain('Baseline: not included in this report.'); expect(result.text).toContain('Comparison: not included in this report.');
    expect(result.text).not.toContain(uuid(3)); expect(result.text).toContain('Same saved data rows are counted, not listed.');
    expect(result.text).toContain('One-sided inclusion does not establish incident creation, recovery, deletion or revoked access');
    expect(result.text).toContain('Current vendor access was not checked'); expect(result.text).toContain('Source server and vendor account were not verified');
    expect(result.bytes).toBe(new TextEncoder().encode(result.text).byteLength); expect(Object.isFrozen(result)).toBe(true); expect(JSON.stringify(capture)).toBe(before);
    expect(prepareAuthenticationHistoryComparisonSummary(capture)).toEqual(result); expect(result.text.endsWith('\n')).toBe(false);
  });
  it.each(['empty', 'unchanged'] as const)('describes a pair with %s records without fabricating differences', kind => {
    const a = report(kind === 'empty' ? [] : [incident()]), capture = comparison(a, structuredClone(a));
    const result = prepareAuthenticationHistoryComparisonSummary(capture); expect(result.differences).toBe(0);
    expect(result.text).toContain('No saved record differences in this captured pair.'); expect(result.text).not.toContain('- Changed saved data:');
    expect(result.text).toContain('Retained records: ' + a.entry_count); expect(result.text).toContain('Saved capture times are equal. Dates do not change the selected order.');
  });
  it.each(['earlier', 'same', 'later'] as const)('retains selected sides when the comparison capture time is %s', order => {
    const a = report(), b = report([incident(1, true)], order === 'earlier' ? 200 : order === 'same' ? 300 : 400);
    const { text, filename } = prepareAuthenticationHistoryComparisonSummary(comparison(a, b));
    expect(filename).toBe('recued-history-comparison-baseline-1970-01-01T00-00-00-300Z-comparison-' + new Date(b.exported_at).toISOString().replace(/[:.]/g, '-') + '.txt');
    expect(filename).not.toMatch(/[:/\\\s]/); expect(filename).not.toContain('private');
    expect(text).toContain('Baseline source\nCaptured (UTC): 1970-01-01T00:00:00.300Z'); expect(text).toContain('Comparison source\nCaptured (UTC): ' + new Date(b.exported_at).toISOString());
    expect(text).toContain(order === 'same' ? 'Saved capture times are equal.' : 'The comparison capture time is ' + order + ' than the baseline.');
    expect(text).toContain('Dates do not change the selected order.'); expect(text).not.toContain('Selected sides were not swapped.');
  });
  it('includes source claims, date bounds and retained detail limits without copying source search text or values', () => {
    const sourceIncident = incident(); sourceIncident.group.label = 'private-search-marker';
    const a = report([sourceIncident]), b = report([incident(1, true)], 400); a.filters = { search: 'private-search-marker', type: 'incident', from: '1970-01-01', through: '1970-01-02' };
    b.scope = { kind: 'connection', name: 'work' }; const record = b.entries[0]!.record; if (!('group' in record)) throw Error('Expected incident.'); record.details_truncated = true;
    const text = prepareAuthenticationHistoryComparisonSummary(comparison(a, b)).text;
    expect(text).toContain('Source scopes differ; record coverage can differ.'); expect(text).toContain('Source filters differ; record coverage can differ.');
    expect(text).toContain('from (inclusive UTC date) 1970-01-01'); expect(text).toContain('through (inclusive UTC date) 1970-01-02');
    expect(text).toContain('search applied (text omitted)'); expect(text).not.toContain('private-search-marker'); expect(text).not.toContain('private-account-label');
    expect(text).toContain('Retention: 90 days; finished-record limit: 10000.'); expect(text).toContain('Records with saved incomplete-detail flags: 1.');
    expect(text).toContain('Zero does not establish complete history.'); expect(text).toContain('Detailed field values, account/app labels, source filenames and search text are omitted.');
  });
  it.each<AuthenticationIncidentScope>([{ kind: 'all' }, { kind: 'oauth_apps' }, { kind: 'connection', name: 'work' }, { kind: 'group', id: 'a'.repeat(64) },
    { kind: 'file_source', source_id: 'drive' }, { kind: 'collection', platform: 'mail', slug: 'inbox' }, { kind: 'collection', platform: 'calendar', slug: 'events' }])('retains the selected %s scope in source metadata', scope => {
    const a = report([]), b = report([], 400); a.scope = scope; b.scope = scope;
    const text = prepareAuthenticationHistoryComparisonSummary(comparison(a, b)).text;
    expect(text).toContain('Source scopes match.'); expect(text).toContain('Source scope: ' + scope.kind);
    if (scope.kind === 'connection') expect(text).toContain('"work"');
    if (scope.kind === 'group') expect(text).toContain('"' + scope.id + '"');
    if (scope.kind === 'file_source') expect(text).toContain('"drive"');
    if (scope.kind === 'collection') expect(text).toContain(scope.platform + ' "' + scope.slug + '"');
  });
  it('keeps repair, read, token-renewal and recovery outcomes as separate saved evidence', () => {
    const r = repair(), v: AuthenticationAccessVerification = { id: 'verify-' + uuid(1), selection: { kind: 'group', id: 'a'.repeat(64) }, started_at: 100, finished_at: 200,
      status: 'completed', targets_truncated: false, uses: [], usage_available: true, results: [{ id: 'b'.repeat(64), label: 'private-check-label', target: { kind: 'connection', name: 'work' }, authentication_revision: 'c'.repeat(64), current: 'unknown', checks: [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }] }] };
    const n: AuthenticationRenewalHistory = { id: 'renewal-' + uuid(1), issuer: 'google', app_id: 'default', app_revision: 1, app_label: 'private-app-label', status: 'completed', started_at: 100, finished_at: 200,
      history_started_at: 200, incomplete: false, results: [{ id: 'd'.repeat(64), revision: 'e'.repeat(64), label: 'private-grant-label', eligible: true, status: 'unconfirmed', reason: 'not_selected', current: 'unknown', connections: ['work'], native_accounts: [] }] };
    const afterR = { ...r, status: 'applied' as const, finished_at: 200 }, afterV = structuredClone(v), afterN = structuredClone(n);
    afterV.results[0]!.checks = [{ kind: 'api_read', status: 'passed' }]; afterN.results[0]!.status = 'passed'; delete afterN.results[0]!.reason;
    const text = prepareAuthenticationHistoryComparisonSummary(comparison(report([r, v, n]), report([afterR, afterV, afterN], 400))).text;
    expect(text).toContain('recorded outcome: Repair applied'); expect(text).toContain('recorded outcome: Recorded check passed');
    expect(text).toContain('"results" (Results)'); expect(text).toContain('Their order does not establish causation'); expect(text).toContain('Token renewal does not establish protected-resource access');
    expect(text).not.toMatch(/private-|c{64}|d{64}|e{64}/); expect(text).not.toContain('"authentication_revision"');
  });
  it('omits raw field data even when changed labels contain HTML and structural-looking text', () => {
    const a = incident(), b = incident(); b.group.label = '<img src="/private-summary-image"> 🚀 Saved record differences \u202e';
    Object.assign(b, { access_token: 'private-token', raw_error: 'private-error' });
    const text = prepareAuthenticationHistoryComparisonSummary(comparison(report([a]), report([b], 400))).text;
    expect(text).toContain('"group" (Group)'); expect(text).not.toMatch(/private-token|private-error|img src|🚀|\u202e/);
    expect(text).toContain('Privacy: names and IDs (local use). Review before sharing.');
  });
  it('refuses an oversized complete summary instead of silently truncating its captured differences', () => {
    const before = Array.from({ length: 19000 }, (_, n) => repair(n + 1)), after: AuthenticationRepairAction[] = before.map(record => ({ ...record,
      action: 'change_permissions', status: 'applied', finished_at: 200, restart_required: true, from: { type: 'unknown' }, to: { type: 'unknown' } }));
    const capture = comparison(report(before), report(after, 400));
    expect(capture.rows).toHaveLength(19000); expect(() => prepareAuthenticationHistoryComparisonSummary(capture)).toThrow('Comparison summary is too large.');
  }, 20000);
});
