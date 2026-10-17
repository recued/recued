import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAuthenticationIncidentHistoryPage, type AuthenticationRepairTarget, type ConnectionAuth } from '@recued/contracts';
import { createAuthenticationRepairActionStore, authenticationAppHistoryGroupId } from '../authentication-repair-action-store.js';
import { createAuthenticationIncidentStore } from '../authentication-incident-store.js';
import type { Episode } from '../authentication-alert-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { encodeAuthForStorage } from '../connection-auth-storage.js';
import { handleConnectionRotateCredentials } from '../connection-handler.js';

const dbs: Database.Database[] = []; afterEach(() => { dbs.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });
const target: AuthenticationRepairTarget = { kind: 'connection', name: 'work' };
const fixture = () => {
  const db = new Database(':memory:'); dbs.push(db); const incidents = createAuthenticationIncidentStore(db); const repairs = createAuthenticationRepairActionStore(db);
  const episode = (group_id = 'a'.repeat(64), targets: AuthenticationRepairTarget[] = [target]): Episode => ({ id: randomUUID(), group_id,
    status: 'open', first_seen_at: 100, last_seen_at: 100, problem_since_at: 100, present: true, announced: false,
    issues: [{ id: 'c'.repeat(64), code: 'credential_rejected', message: 'Access was rejected.' }],
    group: { id: group_id, kind: 'account', label: 'Work', authentication: 'direct_oauth', connection_names: [],
      issues: [{ id: 'c'.repeat(64), code: 'credential_rejected', message: 'Access was rejected.' }], uses: [], usage_available: true, targets } });
  const begin = (id = 'first', targets: AuthenticationRepairTarget[] = [target]) => repairs.begin('connection_credentials', id,
    { action: 'reauthorize', from: { type: 'direct_oauth' }, to: { type: 'direct_oauth' }, targets }, 110);
  const history = (scope: Parameters<typeof incidents.history>[0]['scope'] = { kind: 'all' }) => incidents.history({ scope }, 200);
  return { db, incidents, repairs, episode, begin, history };
};

describe('repair actions in retained incident history', () => {
  it.each([115, 120])('does not call an operation at %s post-repair recovery merely because the monitor closes later', verifiedAt => {
    const f = fixture(); const problem = f.episode(); f.incidents.record(problem, 100); f.begin();
    f.repairs.finish('connection_credentials', 'first', { status: 'applied' }, 120);
    problem.status = 'recovered'; problem.present = false; problem.last_seen_at = 160;
    problem.required_checks = [{ id: 'c'.repeat(64), failed_at: 100, succeeded_at: verifiedAt }]; f.incidents.record(problem, 160);
    expect(f.history().repairs![0]!.recovery_confirmed_at).toBeUndefined();
  });
  it('does not infer post-repair operations from a legacy incident with only a later closure time', () => {
    const f = fixture(); const problem = f.episode(); f.incidents.record(problem, 100); f.begin();
    f.repairs.finish('connection_credentials', 'first', { status: 'applied' }, 120);
    problem.status = 'recovered'; problem.present = false; problem.last_seen_at = 160; f.incidents.record(problem, 160);
    expect(f.history().repairs![0]!.recovery_confirmed_at).toBeUndefined();
  });
  it('requires every successful operation to follow apply, including the earliest check of a multi-use incident', () => {
    const f = fixture(); const problem = f.episode(); f.incidents.record(problem, 100); f.begin();
    f.repairs.finish('connection_credentials', 'first', { status: 'applied' }, 120);
    problem.status = 'recovered'; problem.present = false; problem.last_seen_at = 170;
    problem.required_checks = [{ id: 'first', failed_at: 100, succeeded_at: 115 }, { id: 'second', failed_at: 100, succeeded_at: 150 }];
    f.incidents.record(problem, 170); expect(f.history().repairs![0]!.recovery_confirmed_at).toBeUndefined();
    expect(f.history().incidents[0]!.recovery_evidence).toEqual({ earliest_at: 115, latest_at: 150 });
  });
  it.each(['failed', 'applied'] as const)('retains a distinct repair when a %s attempt ID is reused after deleting and recreating a connection', firstOutcome => {
    const f = fixture(); const connections = createConnectionStore(f.db);
    const row = { kind: 'api' as const, name: 'work', display_name: 'Work', config_json: '{}', auth_ciphertext: 'opaque', enrolled_at: 1, updated_at: 2 };
    const claim = () => connections.claimCredentialRotationAttempt!({ attempt_id: 'same-attempt', kind: 'api', name: 'work', started_at: 110,
      repair: { action: 'reauthorize', targets: [target] } });
    connections.upsert(row); expect(claim().claimed).toBe(true);
    if (firstOutcome === 'failed') connections.failCredentialRotationAttempt!({ attempt_id: 'same-attempt', finished_at: 120, reason: 'auth_failed' });
    else connections.completeCredentialRotationAttempt!({ attempt_id: 'same-attempt', connection: row, verification: { status: 'verified', verified_at: 120, auth_type: 'bearer' } });
    const old = f.history().repairs![0]!;
    connections.delete('api', 'work'); const recreated = { ...row, enrolled_at: 3, updated_at: 4 }; connections.upsert(recreated);
    expect(claim().claimed).toBe(true);
    connections.completeCredentialRotationAttempt!({ attempt_id: 'same-attempt', connection: recreated, verification: { status: 'verified', verified_at: 125, auth_type: 'bearer' } });
    const page = f.history(); expect(page.repairs).toHaveLength(2);
    expect(page.repairs![0]).toMatchObject({ status: 'applied' }); expect(page.repairs![0]!.id).not.toBe(old.id);
    expect(page.repairs![1]).toEqual(old); expect(claim().claimed).toBe(false); expect(f.history().repairs).toHaveLength(2);
  });
  it('does not update retained history through an unrelated source attempt without a history key', () => {
    const f = fixture(); const connections = createConnectionStore(f.db);
    f.begin('legacy-overlap'); f.repairs.finish('connection_credentials', 'legacy-overlap', { status: 'failed', reason: 'access_failed' }, 120);
    const original = f.history().repairs![0];
    connections.upsert({ kind: 'mcp', name: 'unrelated', display_name: 'Unrelated', config_json: '{}', auth_ciphertext: 'opaque', enrolled_at: 1, updated_at: 2 });
    connections.claimCredentialRotationAttempt!({ attempt_id: 'legacy-overlap', kind: 'mcp', name: 'unrelated', started_at: 130 });
    connections.failCredentialRotationAttempt!({ attempt_id: 'legacy-overlap', finished_at: 140, reason: 'server_error' });
    expect(f.history().repairs![0]).toEqual(original);
  });
  it('records the API apply time after all access checks, separately from the earlier verification clock', async () => {
    const f = fixture(); const connections = createConnectionStore(f.db); const key = () => Buffer.alloc(32, 6); let clock = 110;
    connections.upsert({ kind: 'api', name: 'work', display_name: 'Work', config_json: '{"base_url":"https://vendor.test/protected"}',
      auth_ciphertext: await encodeAuthForStorage({ type: 'bearer', token: 'old-token' }, { kind: 'api', name: 'work' }, key), enrolled_at: 1, updated_at: 2 });
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authenticated = new Headers(init?.headers).get('authorization') === 'Bearer new-token'; clock = authenticated ? 120 : 150;
      return new Response('{}', { status: authenticated ? 200 : 401 });
    });
    const result = await handleConnectionRotateCredentials({ store: connections, getEncryptionKey: key, resolveFetch: fetcher, fetcher: (url, init) => fetcher(url, init), now: () => clock }, {
      attempt_id: 'apply-clock-fixture', kind: 'api', name: 'work', expected_updated_at: 2, patch: { auth: { type: 'bearer', token: 'new-token' } },
    });
    expect(result.verification.verified_at).toBeLessThan(150);
    expect(f.history().repairs![0]).toMatchObject({ status: 'applied', finished_at: 150 });
  });
  it('retains repairs without an incident, separates applied from recovered access, and whitelists receipt fields', () => {
    const f = fixture();
    const input = { action: 'reauthorize' as const, targets: [target], from: { type: 'direct_oauth' as const, app_id: 'work', label: 'never-export-label\nignored', client_secret: 'never-export-secret' },
      to: { type: 'broker' as const, broker_profile_id: 'team', access_token: 'never-export-token' }, authorization_receipt: 'never-export-receipt' };
    f.repairs.begin('connection_credentials', 'never-export-attempt', input, 110);
    expect(f.history()).toMatchObject({ incidents: [], repairs: [{ status: 'checking', incidents: [], targets: [target] }] });
    f.repairs.finish('connection_credentials', 'never-export-attempt', { status: 'applied' }, 120);
    const page = f.history(); expect(page.repairs![0]).toMatchObject({ status: 'applied', started_at: 110, finished_at: 120 });
    expect(page.repairs![0]!.recovery_confirmed_at).toBeUndefined(); expect(isAuthenticationIncidentHistoryPage(page)).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/never-export|client_secret|access_token|authorization_receipt/);
  });
  it('links only exact currently open references, never every saved-app incident or a previously closed episode', () => {
    const f = fixture(); const old = f.episode(); old.status = 'retired'; old.retirement_reason = 'authentication_changed'; f.incidents.record(old, 100);
    const current = f.episode('b'.repeat(64)); f.incidents.record(current, 100);
    const other = f.episode('d'.repeat(64), [{ kind: 'connection', name: 'other' }, { kind: 'oauth_apps' }]); f.incidents.record(other, 100);
    f.begin('first', [target, { kind: 'oauth_apps' }]);
    expect(f.history().repairs![0]!.incidents).toEqual([{ id: current.id, group_id: current.group_id, label: 'Work' }]);
    expect(f.history({ kind: 'group', id: current.group_id }).repairs).toHaveLength(1);
    expect(f.history({ kind: 'group', id: other.group_id }).repairs).toHaveLength(0);
    expect(f.history({ kind: 'connection', name: 'other' }).repairs).toHaveLength(0);
  });
  it('associates rotation with its exact app even when no account uses it', () => {
    const f = fixture(); const app = f.episode(authenticationAppHistoryGroupId('google', 'work'), [{ kind: 'oauth_apps' }]);
    const other = f.episode(authenticationAppHistoryGroupId('google', 'other'), [{ kind: 'oauth_apps' }]);
    f.incidents.record(app, 100); f.incidents.record(other, 100);
    f.repairs.begin('oauth_app_secret', 'rotate', { action: 'rotate_secret', targets: [{ kind: 'oauth_apps' }], group_ids: [app.group_id] }, 110);
    expect(f.history().repairs![0]!.incidents.map(i => i.id)).toEqual([app.id]);
  });
  it('requires all associated incidents to record strictly later successful operations; retirement is not recovery', () => {
    const f = fixture(); const first = f.episode(); const second = f.episode('b'.repeat(64));
    f.incidents.record(first, 100); f.incidents.record(second, 100); f.begin(); f.repairs.finish('connection_credentials', 'first', { status: 'applied' }, 120);
    first.status = 'recovered'; first.present = false; first.last_seen_at = 130; f.incidents.record(first, 130);
    expect(f.history().repairs![0]!.recovery_confirmed_at).toBeUndefined();
    second.status = 'retired'; second.retirement_reason = 'authentication_changed'; second.last_seen_at = 140; f.incidents.record(second, 140);
    expect(f.history().repairs![0]!.recovery_confirmed_at).toBeUndefined();
  });
  it('shows later recovery separately and reads no credentials, vendors or repair services', () => {
    const f = fixture(); const problem = f.episode(); f.incidents.record(problem, 100); f.begin(); f.repairs.finish('connection_credentials', 'first', { status: 'applied' }, 120);
    problem.status = 'recovered'; problem.present = false; problem.last_seen_at = 120;
    problem.required_checks = [{ id: 'c'.repeat(64), failed_at: 100, succeeded_at: 120 }]; f.incidents.record(problem, 120);
    expect(f.history().repairs![0]!.recovery_confirmed_at).toBeUndefined();
    problem.last_seen_at = 160; problem.required_checks[0]!.succeeded_at = 150; f.incidents.record(problem, 160);
    const before = f.db.prepare('SELECT * FROM authentication_incident_history').all(); const fetch = vi.spyOn(globalThis, 'fetch');
    const page = f.history(); expect(page.repairs![0]).toMatchObject({ status: 'applied', finished_at: 120, recovery_confirmed_at: 150 });
    expect(isAuthenticationIncidentHistoryPage(page)).toBe(true); expect(fetch).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT * FROM authentication_incident_history').all()).toEqual(before);
  });
  it('keeps recovery unknown when any related incident was pruned or the association preview was truncated', () => {
    const f = fixture(); const problem = f.episode(); f.incidents.record(problem, 100); f.begin();
    f.repairs.finish('connection_credentials', 'first', { status: 'applied' }, 120);
    problem.status = 'recovered'; problem.present = false; problem.last_seen_at = 170;
    problem.required_checks = [{ id: 'c'.repeat(64), failed_at: 100, succeeded_at: 150 }]; f.incidents.record(problem, 170);
    expect(f.history().repairs![0]!.recovery_confirmed_at).toBe(150);
    const action = f.history().repairs![0]!;
    f.db.prepare("UPDATE authentication_incident_history SET data = json_set(data, '$.incidents_truncated', json('true')) WHERE id = ?").run(action.id);
    expect(f.history().repairs![0]!.recovery_confirmed_at).toBeUndefined();
    f.db.prepare("UPDATE authentication_incident_history SET data = json_set(data, '$.incidents_truncated', json('false')) WHERE id = ?").run(action.id);
    f.db.prepare('DELETE FROM authentication_incident_history WHERE id = ?').run(problem.id);
    expect(f.history().repairs![0]!.recovery_confirmed_at).toBeUndefined();
  });
  it('keeps a single namespaced receipt through retries, clock correction and terminal outcome refinement', () => {
    const f = fixture(); f.begin(); f.repairs.finish('connection_credentials', 'first', { status: 'applied', restart_required: true }, 90);
    f.begin(); f.repairs.finish('connection_credentials', 'first', { status: 'failed', reason: 'access_failed' }, 130);
    expect(f.history().repairs).toHaveLength(1); expect(f.history().repairs![0]).toMatchObject({ status: 'applied', finished_at: 110, restart_required: true });
    f.repairs.finish('connection_credentials', 'first', { status: 'applied', restart_required: false }, 140);
    expect(f.history().repairs![0]).toMatchObject({ finished_at: 110, restart_required: false });
    f.repairs.begin('oauth_app_secret', 'first', { action: 'rotate_secret', targets: [{ kind: 'oauth_apps' }] }, 150);
    expect(f.history().repairs).toHaveLength(2);
  });
  it('pages incidents and repairs together without losing rows when new repairs arrive', () => {
    const f = fixture(); const problem = f.episode(); f.incidents.record(problem, 100);
    f.begin('one'); f.begin('two'); const first = f.incidents.history({ scope: { kind: 'all' }, limit: 2 }, 200);
    expect(first.repairs).toHaveLength(2); expect(first.incidents).toHaveLength(0); expect(first.next_cursor).toBeDefined();
    f.begin('three'); const older = f.incidents.history({ scope: { kind: 'all' }, limit: 2, cursor: first.next_cursor }, 200);
    expect(older.order).toEqual([problem.id]); expect(older.repairs).toEqual([]); expect(older.next_cursor).toBeUndefined();
    expect(() => f.incidents.history({ scope: target, cursor: first.next_cursor }, 200)).toThrow('invalid for the selected connection');
  });
  it('keeps exact associations past bounded previews and marks omissions', () => {
    const f = fixture(); const targets: AuthenticationRepairTarget[] = Array.from({ length: 70 }, (_, n) => ({ kind: 'connection', name: 'work-' + n }));
    f.begin('many', targets); const page = f.history(targets[69]!);
    expect(page.repairs).toHaveLength(1); expect(page.repairs![0]).toMatchObject({ targets_truncated: true }); expect(page.repairs![0]!.targets).toHaveLength(64);
  });
  it('upgrades the older history table without rewriting its incident sequence or data', () => {
    const db = new Database(':memory:'); dbs.push(db);
    db.exec('CREATE TABLE authentication_incident_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, group_id TEXT, ended_at INTEGER, signature TEXT, data TEXT)');
    db.prepare('INSERT INTO authentication_incident_history VALUES (12, ?, ?, NULL, ?, ?)').run('legacy', 'old', 'fingerprint', '{}');
    createAuthenticationRepairActionStore(db);
    expect(db.prepare('SELECT sequence, kind, signature, data FROM authentication_incident_history').get()).toEqual({ sequence: 12, kind: 'incident', signature: 'fingerprint', data: '{}' });
  });
  it('closes interrupted applies on restart and retains finished repairs after account deletion and source-receipt removal', () => {
    const f = fixture(); const connections = createConnectionStore(f.db);
    connections.upsert({ kind: 'api', name: 'work', display_name: 'Work', config_json: '{}', auth_ciphertext: 'opaque', enrolled_at: 1, updated_at: 2 });
    connections.claimCredentialRotationAttempt!({ attempt_id: 'claimed', kind: 'api', name: 'work', started_at: 110,
      repair: { action: 'reauthorize', targets: [target] } });
    createConnectionStore(f.db);
    expect(f.history().repairs![0]).toMatchObject({ status: 'failed', reason: 'interrupted' });
    connections.delete('api', 'work'); expect(connections.getCredentialRotationAttempt!('claimed')).toBeNull();
    expect(f.history(target).repairs).toHaveLength(1);
    f.incidents.prune(Date.now() + 91 * 86_400_000); expect(f.history().repairs).toEqual([]);
    expect(f.db.prepare('SELECT count(*) n FROM authentication_incident_targets').get()).toEqual({ n: 0 });
  });
  it('rolls back a verified connection swap when its applied history receipt cannot be saved', async () => {
    const f = fixture(); const connections = createConnectionStore(f.db); const key = () => Buffer.alloc(32, 6);
    const original: ConnectionAuth = { type: 'bearer', token: 'old-token' };
    connections.upsert({ kind: 'api', name: 'work', display_name: 'Work', config_json: '{"base_url":"https://vendor.test/protected"}',
      auth_ciphertext: await encodeAuthForStorage(original, { kind: 'api', name: 'work' }, key), enrolled_at: 1, updated_at: 2 });
    const before = connections.get('api', 'work');
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response('{}', {
      status: new Headers(init?.headers).get('authorization') === 'Bearer new-token' ? 200 : 401 }));
    f.db.exec("CREATE TRIGGER fail_repair_history BEFORE UPDATE ON authentication_incident_history WHEN NEW.kind = 'repair' AND json_extract(NEW.data, '$.status') = 'applied' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    await expect(handleConnectionRotateCredentials({ store: connections, getEncryptionKey: key, resolveFetch: fetcher, fetcher: (url, init) => fetcher(url, init), now: () => 120 }, {
      attempt_id: 'replace-history-fixture', kind: 'api', name: 'work', expected_updated_at: 2, patch: { auth: { type: 'bearer', token: 'new-token' } },
    })).rejects.toThrow('fixture failure');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(connections.get('api', 'work')).toEqual(before);
    expect(f.history().repairs![0]).toMatchObject({ status: 'failed' });
  });
});
