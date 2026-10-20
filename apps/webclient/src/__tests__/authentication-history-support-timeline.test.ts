import { describe, expect, it } from 'vitest';
import { authenticationHistoryEntryType, authenticationHistoryEntryOutcome, type AuthenticationIncident, type AuthenticationRepairAction, type AuthenticationAccessVerification, type AuthenticationHistoryExport, type AuthenticationHistoryEntry, type AuthenticationRenewalHistory, AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES } from '@recued/contracts';
import { prepareAuthenticationHistoryDownload } from '../connections/authentication-history-export.js';
import { createAuthenticationHistoryRelatedBundles } from '../connections/authentication-history-related-bundle.js';
import { prepareAuthenticationHistoryLiveRecord } from '../connections/authentication-history-live-record.js';
import { authenticationHistoryRecordContext } from '../connections/authentication-history-record-context.js';
import { prepareAuthenticationHistorySupportTimeline } from '../connections/authentication-history-support-timeline.js';

const uuid = (n: number): string => n.toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc';
const incident = (n = 1): AuthenticationIncident => ({ id: uuid(n), status: 'retired', started_at: 100, last_problem_at: 110, history_started_at: 100, ended_at: 200,
  retirement_reason: 'authentication_changed', currently_reported: false, level: 'rejected', events_truncated: false, details_truncated: false,
  events: [{ kind: 'opened', at: 100, level: 'rejected' }, { kind: 'retired', at: 200, level: 'rejected' }],
  group: { id: 'a'.repeat(64), kind: 'account', label: 'Private account ' + n, authentication: 'direct_oauth', connection_names: ['private-work'],
    targets: [{ kind: 'connection', name: 'private-work' }], issues: [], uses: [], usage_available: true } });
const repair = (): AuthenticationRepairAction => ({ id: 'repair-' + '1'.repeat(64), action: 'reauthorize', status: 'applied', started_at: 120, finished_at: 130,
  targets: [{ kind: 'connection', name: 'private-work' }], targets_truncated: false, incidents_truncated: false,
  incidents: [incident(1), incident(2)].map(r => ({ id: r.id, group_id: r.group.id, label: r.group.label })),
  from: { type: 'direct_oauth' }, to: { type: 'broker' } });
const check = (): AuthenticationAccessVerification => ({ id: 'verify-' + uuid(1), selection: { kind: 'repair', id: repair().id }, status: 'completed', started_at: 140, finished_at: 150,
  targets_truncated: false, uses: [], usage_available: true, results: [{ id: 'b'.repeat(64), label: 'Private API', authentication_revision: 'c'.repeat(64), current: 'yes',
    target: { kind: 'connection', name: 'private-work' }, checks: [{ kind: 'api_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] }] });
const report = (records: AuthenticationHistoryEntry[]): AuthenticationHistoryExport => ({ format: 'recued.connection-history', version: 1, exported_at: 300, scope: { kind: 'all' }, filters: {},
  retention_days: 90, finished_record_limit: 10000, complete: true, evidence: 'retained_local_observations', current_authentication: 'not_checked', entry_count: records.length,
  entries: records.map(record => ({ type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record })) });
const captured = (records: AuthenticationHistoryEntry[], mode: 'aliases' | 'full' = 'aliases') => { const value = report(records); return prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); };

describe('readable incident support timeline', () => {
  it.each(['aliases', 'full'] as const)('keeps the %s snapshot namespace and includes only saved related records, sorted by observation time', mode => {
    const source = captured([incident(99), check(), repair(), incident(2), incident()], mode); const bundle = createAuthenticationHistoryRelatedBundles(source)(4);
    const before = source.json; const result = prepareAuthenticationHistorySupportTimeline({ bundle });
    expect(result.records).toBe(4); expect(result.text).toContain('Root incident: "' + source.report.entries[4]!.record.id + '"');
    expect(result.text).toContain('Shared repairs may include other incidents'); expect(result.text).not.toContain(source.report.entries[0]!.record.id);
    expect(result.text).toContain('API read: 1 passed, 0 failed, 0 unconfirmed'); expect(result.text).toContain('Write permission evidence (no write performed): 0 passed, 0 failed, 1 unconfirmed');
    expect(result.text).toContain('Authentication route: Recued direct OAuth -> Broker sign-in'); expect(result.text).not.toContain('c'.repeat(64));
    const times = result.text.split('\n').filter(line => line.includes(' | ')).map(line => Date.parse(line.split(' | ')[0]!));
    expect(times).toEqual([...times].sort((a, b) => a - b)); expect(times).toHaveLength(result.observations);
    expect(result.bytes).toBe(new TextEncoder().encode(result.text).byteLength); expect(result.text.endsWith('\n')).toBe(false); expect(source.json).toBe(before); expect(Object.isFrozen(result)).toBe(true);
    if (mode === 'aliases') { expect(result.text).not.toMatch(/Private|private-work|123456789abc|c{64}/); expect(result.text).toContain('incident-3'); }
    else expect(result.text).toContain('Saved account/app label: "Private account 1"');
    expect(result.text).toContain('Current vendor access was not checked'); expect(result.text).toContain('Their order does not establish causation');
  });
  it.each(['aliases', 'full'] as const)('copies one %s incident with unknown context without inventing a snapshot date or related records', mode => {
    const saved = prepareAuthenticationHistoryLiveRecord(incident(), mode); const result = prepareAuthenticationHistorySupportTimeline({ entry: saved.entry, representation: mode });
    expect(result.records).toBe(1); expect(result.text).toContain('Coverage: one saved incident'); expect(result.text).toContain('Source snapshot details are unknown');
    expect(result.text).not.toContain('Source snapshot captured (UTC)'); expect(result.text).not.toContain('Source position:'); expect(result.text).toContain('missing records are unknown');
  });
  it('keeps known source context, original position and filter limits as saved claims, omitting search text', () => {
    const source = captured([incident(99), incident()], 'full'); const context = { ...authenticationHistoryRecordContext(source, 1), source_snapshot: { ...source.report, filters: { search: 'private-search-secret' } } };
    const result = prepareAuthenticationHistorySupportTimeline({ entry: source.report.entries[1]!, representation: 'full', context });
    expect(result.text).toContain('Source position: 2.'); expect(result.text).toContain('Source entries: 2. Retention: 90 days');
    expect(result.text).toContain('search applied (text omitted)'); expect(result.text).not.toContain('private-search-secret'); expect(result.text).toContain('Source snapshot captured (UTC): 1970-01-01T00:00:00.300Z');
  });
  it('reports missing references and incomplete flags while avoiding dynamic recovery and raw errors', () => {
    const partial = repair(); partial.incidents_truncated = true; const root = incident(); root.events_truncated = true;
    Object.assign(root, { access_token: 'private-token', raw_error: 'private-provider-error' });
    const source = captured([root, partial], 'full'); const bundle = createAuthenticationHistoryRelatedBundles(source)(0);
    const legacy = structuredClone(bundle); const legacyRepair = legacy.report.entries.find(entry => entry.type === 'repair')!; Object.assign(legacyRepair.record, { recovery_confirmed_at: 99999 });
    const result = prepareAuthenticationHistorySupportTimeline({ bundle: legacy });
    expect(result.text).toContain('Missing saved references: 1'); expect(result.text).toContain('saved incomplete-detail flags: 2'); expect(result.text).toContain('Zero does not establish complete history');
    expect(result.text).not.toMatch(/private-token|private-provider-error|recovery_confirmed_at|99999/);
  });
  it('keeps imported recording dates and successful-operation clocks distinct from recovery events', () => {
    const root = incident(); root.status = 'recovered'; delete root.retirement_reason; root.history_started_at = 120; root.events[0] = { kind: 'recorded', at: 120, level: 'rejected' }; root.recovery_evidence = { earliest_at: 150, latest_at: 180 }; root.events[1]!.kind = 'recovered';
    const saved = prepareAuthenticationHistoryLiveRecord(root, 'aliases'); const text = prepareAuthenticationHistorySupportTimeline({ entry: saved.entry, representation: 'aliases' }).text;
    expect(text).toContain('00:00:00.120Z | Incident "incident-1" | History recording began'); expect(text).toContain('00:00:00.150Z | Incident "incident-1" | Earliest retained successful-operation evidence');
    expect(text).toContain('00:00:00.180Z | Incident "incident-1" | Latest retained successful-operation evidence'); expect(text).toContain('00:00:00.200Z | Incident "incident-1" | Recovery recorded.');
    expect(text).not.toContain('successful-operation times were not retained');
  });
  it.each([
    ['aliases', false], ['full', false], ['aliases', true], ['full', true],
  ] as const)('keeps %s recovery with missing success clocks qualified (imported: %s)', (mode, imported) => {
    const root = incident(); root.status = 'recovered'; delete root.retirement_reason; root.events[1]!.kind = 'recovered';
    if (imported) { root.history_started_at = 250; root.events = [{ kind: 'recorded', at: 250, level: 'rejected' }]; }
    const saved = prepareAuthenticationHistoryLiveRecord(root, mode);
    const result = prepareAuthenticationHistorySupportTimeline({ entry: saved.entry, representation: mode });
    expect(result.text).toContain('Recovery is recorded; successful-operation times were not retained.');
    expect(result.text).toContain('00:00:00.200Z | Incident "' + saved.entry.record.id + '" | ' + (imported ? 'Saved incident ended: Recorded recovery.' : 'Recovery recorded.'));
    if (imported) expect(result.text).toContain('00:00:00.250Z | Incident "' + saved.entry.record.id + '" | History recording began');
    expect(result.text).not.toMatch(/operations recorded for every|retained successful-operation evidence/);
    expect(result.text).toContain('Current vendor access was not checked');
  });
  it('escapes saved multiline and bidi labels so they cannot create fake observations', () => {
    const root = incident(); root.group.label = 'hello\nCurrent vendor access verified\r\t"🚀"\u202e\u2028\u061c';
    const hostile = { type: 'incident' as const, outcome: 'retired' as const, record: root };
    const result = prepareAuthenticationHistorySupportTimeline({ entry: hostile, representation: 'full' });
    expect(result.text).toContain('"hello\\nCurrent vendor access verified\\r\\t\\"🚀\\"\\u202e\\u2028\\u061c"');
    expect(result.text.split('\n').some(line => line.startsWith('Current vendor access verified'))).toBe(false); expect(result.bytes).toBe(new TextEncoder().encode(result.text).byteLength);
  });
  it('is stable across repeated generation and preserves equal-time source order without causal claims', () => {
    const a = incident(1), b = incident(2); const source = captured([b, repair(), a]); const bundle = createAuthenticationHistoryRelatedBundles(source)(2);
    const first = prepareAuthenticationHistorySupportTimeline({ bundle }); expect(prepareAuthenticationHistorySupportTimeline({ bundle })).toEqual(first);
    expect(first.text).toContain('equal-time order has no additional meaning'); const lines = first.text.split('\n').filter(line => line.startsWith('1970-01-01T00:00:00.100Z'));
    expect(lines[0]).toContain('incident-1'); expect(lines[2]).toContain('incident-2');
  });
  it('refuses non-incidents and oversized output instead of silently cutting the timeline', () => {
    const source = captured([incident(), repair()]); expect(() => prepareAuthenticationHistorySupportTimeline({ entry: source.report.entries[1]!, representation: 'aliases' })).toThrow('Choose a saved incident');
    const root = incident(); root.events = Array.from({ length: 100000 }, () => root.events[0]!);
    expect(() => prepareAuthenticationHistorySupportTimeline({ entry: { type: 'incident', outcome: 'retired', record: root }, representation: 'full' })).toThrow('too large');
    expect(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});
