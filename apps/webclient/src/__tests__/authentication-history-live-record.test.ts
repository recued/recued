import { describe, expect, it } from 'vitest';
import { AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES, type AuthenticationIncident, type AuthenticationRepairAction,
  type AuthenticationAccessVerification, type AuthenticationRenewalHistory } from '@recued/contracts';
import { prepareAuthenticationHistoryLiveRecord } from '../connections/authentication-history-live-record.js';
import { openAuthenticationHistoryFile } from '../connections/authentication-history-saved-file.js';

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

const records = () => [incident(1), repair, verification, renewal];
const raw = (record: unknown, mode: 'aliases' | 'full') => JSON.stringify(prepareAuthenticationHistoryLiveRecord(record, mode).entry);

describe('single live history record preparation', () => {
  for (const mode of ['aliases', 'full'] as const) it.each(records())('round-trips a checked '+ mode + ' record $id without invented source context', record => {
    const before = JSON.stringify(record); const prepared = prepareAuthenticationHistoryLiveRecord(record, mode); const json = JSON.stringify(prepared.entry);
    const opened = openAuthenticationHistoryFile(json);
    expect(opened.kind).toBe('record'); if (opened.kind !== 'record') throw Error('Expected record.');
    expect(prepared.json).toBe(json); expect(prepared.bytes).toBe(new TextEncoder().encode(json).byteLength); expect(prepared.count).toBe(1); expect(prepared.representation).toBe(mode);
    expect(opened.record.entry).toEqual(prepared.entry); expect(opened.record.context).toBeUndefined(); expect(opened.record.representation).toBe(mode);
    expect(Object.keys(prepared.entry)).toEqual(['type', 'outcome', 'record']);
    expect(prepared.filename).toBe('recued-connection-history-' + (mode === 'aliases' ? 'aliases-' : '') + 'record-' + prepared.entry.type + '.json');
    expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(prepared.entry.record)).toBe(true);
    expect(JSON.stringify(record)).toBe(before); expect(json).not.toMatch(/exported_at|source_position|source_snapshot|retention_days/);
    if (mode === 'aliases') expect(json).not.toMatch(/Private|private-|work|inbox/);
  });
  it.each(['aliases', 'full'] as const)('reapplies the nested public field allowlist in %s mode', mode => {
    const item = incident(1); Object.assign(item, { access_token: 'secret-marker', recovery_confirmed_at: 160, access_summary: { token: 'secret-marker' } });
    Object.assign(item.group, { client_secret: 'secret-marker' }); Object.assign(item.group.targets[0]!, { refresh_token: 'secret-marker' });
    Object.assign(item.group.uses[0]!, { token: 'secret-marker' }); Object.assign(item.group.issues[0]!, { navigation: 'secret-marker' });
    expect(raw(item, mode)).not.toMatch(/secret-marker|Private issue|access_summary|access_token|refresh_token|recovery_confirmed/);
    for (const record of [verification, renewal]) {
      const text = raw(record, mode); expect(text).not.toMatch(/"current":"yes"|"current":"no"/); expect(text).toContain('"current":"unknown"');
    }
  });
  it('captures deeply independent immutable data without freezing or changing a live reply', () => {
    const item = incident(1); const prepared = prepareAuthenticationHistoryLiveRecord(item, 'full'); const before = JSON.stringify(prepared.entry);
    item.group.label = 'Later account'; item.events[0]!.at = 101; item.group.targets.push({ kind: 'connection', name: 'later' });
    expect(prepared.json).toBe(before); expect(JSON.stringify(prepared.entry)).toBe(before); expect(Object.isFrozen(item)).toBe(false); expect(Object.isFrozen(prepared.entry.record)).toBe(true);
    if (!('group' in prepared.entry.record)) throw Error('Expected incident.'); expect(Object.isFrozen(prepared.entry.record.group.targets)).toBe(true);
  });
  it('starts fresh file-local alias namespaces instead of linking separately exported accounts', () => {
    const first = incident(1); const second = incident(2); second.group.id = 'b'.repeat(64); second.group.connection_names = ['other']; second.group.targets = [{ kind: 'connection', name: 'other' }];
    const a = prepareAuthenticationHistoryLiveRecord(first, 'aliases'); const b = prepareAuthenticationHistoryLiveRecord(second, 'aliases');
    expect(a.entry.record.id).toBe('incident-1'); expect(b.entry.record.id).toBe('incident-1');
    expect(raw(first, 'aliases')).toBe(raw(first, 'aliases')); expect(raw(first, 'full')).not.toBe(raw(second, 'full'));
  });
  it.each([null, {}, { ...incident(1), ended_at: 1 }, { ...repair, status: 'checking' }, { ...verification, finished_at: 1 }, { ...renewal, status: 'invented' }])('rejects invalid lifecycle data', record => {
    expect(() => prepareAuthenticationHistoryLiveRecord(record, 'full')).toThrow();
    expect(() => prepareAuthenticationHistoryLiveRecord(record, 'aliases')).toThrow();
  });
  it('rejects invalid privacy modes', () => expect(() => prepareAuthenticationHistoryLiveRecord(incident(1), 'unknown' as 'full')).toThrow());
  it('enforces the UTF-8 byte limit on the entry itself and preserves the source on refusal', () => {
    const item = incident(1); item.group.uses = Array.from({ length: 5000 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: 'x' }));
    let missing = AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES - new TextEncoder().encode(raw(item, 'full')).byteLength;
    for (const use of item.group.uses) { const add = Math.min(missing, 2047 - use.label.length); use.label += 'x'.repeat(add); missing -= add; }
    expect(missing).toBe(0); const exact = raw(item, 'full'); expect(new TextEncoder().encode(exact).byteLength).toBe(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES);
    item.group.uses[0]!.label += 'é'; const before = JSON.stringify(item);
    expect(() => prepareAuthenticationHistoryLiveRecord(item, 'full')).toThrow('too large'); expect(JSON.stringify(item)).toBe(before);
    expect(prepareAuthenticationHistoryLiveRecord(item, 'aliases').entry.type).toBe('incident');
  });
});
