import { describe, expect, it } from 'vitest';
import { isAuthenticationAccessPreview, isAuthenticationAccessRequest, isAuthenticationAccessVerification, isAuthenticationAccessSelection, authenticationAccessRecheckResults,
  type AuthenticationAccessPreview, type AuthenticationAccessVerification } from '../authentication-access-verification.js';
import { isAuthenticationIncidentHistoryPage } from '../authentication-incident-history.js';
const preview = (): AuthenticationAccessPreview => ({ id: 'a'.repeat(43), fingerprint: 'b'.repeat(64), selection: { kind: 'group', id: 'c'.repeat(64) }, label: 'Work', expires_at: 2000,
  targets_truncated: false, usage_available: true, uses: [], targets: [{ id: 'd'.repeat(64), target: { kind: 'connection', name: 'work' }, label: 'Work API',
    authentication_revision: 'e'.repeat(64), check: 'api_read', base_url: 'https://vendor.test/v1' }] });
const receipt = (): AuthenticationAccessVerification => ({ id: 'verify-12345678-1234-4123-8123-123456789abc', selection: preview().selection, status: 'completed', started_at: 1000, finished_at: 1100,
  targets_truncated: false, usage_available: true, uses: [], results: [{ id: 'd'.repeat(64), target: { kind: 'connection', name: 'work' }, label: 'Work API',
    authentication_revision: 'e'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] }] });
describe('saved-authentication access wire boundary', () => {
  it('accepts optional fresh file navigation metadata without requiring it on older receipts', () => {
    const v = receipt(); v.results[0]!.target = { kind: 'file_source', source_id: 'opaque-source' };
    expect(isAuthenticationAccessVerification(v)).toBe(true);
    v.results[0]!.file_connection = { name: 'drive-work', updated_at: 123 };
    expect(isAuthenticationAccessVerification(v)).toBe(true);
  });
  it.each(['api', 'collection', 'superseded', 'unknown', 'name', 'time'] as const)('rejects invalid file navigation metadata: %s', kind => {
    const v = receipt(); const r = v.results[0]!; r.target = { kind: 'file_source', source_id: 'opaque-source' };
    r.file_connection = { name: 'drive-work', updated_at: 123 };
    if (kind === 'api') r.target = { kind: 'connection', name: 'work' };
    if (kind === 'collection') r.target = { kind: 'collection', platform: 'mail', slug: 'work' };
    if (kind === 'superseded') r.current = 'no';
    if (kind === 'unknown') r.current = 'unknown';
    if (kind === 'name') r.file_connection.name = '../work';
    if (kind === 'time') r.file_connection.updated_at = -1;
    expect(isAuthenticationAccessVerification(v)).toBe(false);
  });
  it.each(['targets', 'results', 'checks', 'uses'] as const)('rejects sparse %s in saved access evidence', field => {
    const p = preview(); const v = receipt();
    if (field === 'targets') p.targets = Array(1);
    if (field === 'results') v.results = Array(1);
    if (field === 'checks') v.results[0]!.checks = Array(1);
    if (field === 'uses') { p.uses = Array(1); v.uses = Array(1); }
    if (field === 'targets' || field === 'uses') expect(isAuthenticationAccessPreview(p)).toBe(false);
    if (field !== 'targets') expect(isAuthenticationAccessVerification(v)).toBe(false);
  });
  it.each(['target_ids', 'choices'] as const)('rejects a sparse %s array instead of treating it as a reviewed selection', field => {
    const p = preview();
    const request = { action: 'authentication_access_run', review_id: p.id, fingerprint: p.fingerprint, attempt_id: 'c'.repeat(43), choices: [], target_ids: [p.targets[0]!.id] };
    expect(isAuthenticationAccessRequest({ ...request, [field]: Array(1) })).toBe(false);
  });
  it('recognizes retained access-result selections and bounded explicit target subsets', () => {
    const selection = { kind: 'verification' as const, id: receipt().id }; const p = preview(); p.selection = selection;
    expect(isAuthenticationAccessPreview(p)).toBe(true);
    expect(isAuthenticationAccessSelection({ ...selection, kind: ['verification'] })).toBe(false);
    expect(isAuthenticationAccessSelection({ ...selection, id: 'https://vendor.test/result' })).toBe(false);
    const request = { action: 'authentication_access_run', review_id: p.id, fingerprint: p.fingerprint, attempt_id: 'c'.repeat(43), choices: [], target_ids: [p.targets[0]!.id] };
    expect(isAuthenticationAccessRequest(request)).toBe(true);
    for (const invalid of [[], [p.targets[0]!.id, p.targets[0]!.id], ['raw-token'], 'all', Array.from({ length: 33 }, (_, i) => i.toString(16).padStart(64, '0'))]) {
      expect(isAuthenticationAccessRequest({ ...request, target_ids: invalid })).toBe(false);
    }
  });
  it('rechecks only completed non-passing reads, including a missing file download after metadata passed', () => {
    const v = receipt(); v.results[0]!.checks.push({ kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' });
    expect(authenticationAccessRecheckResults(v)).toEqual([]);
    v.results[0]!.checks.push({ kind: 'file_download', status: 'unconfirmed', reason: 'resource_required' });
    expect(authenticationAccessRecheckResults(v)).toEqual(v.results);
    v.results[0]!.checks = [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }]; expect(authenticationAccessRecheckResults(v)).toEqual(v.results);
    v.status = 'checking'; delete v.finished_at; expect(authenticationAccessRecheckResults(v)).toEqual([]);
  });
  it.each(['check kind', 'check reason', 'comparison', 'use kind'] as const)('rejects coerced access evidence: %s', field => {
    const v = receipt();
    if (field === 'check kind') Object.assign(v.results[0]!.checks[0]!, { kind: ['write_permissions'] });
    if (field === 'check reason') { v.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }]; Object.assign(v.results[0]!.checks[0]!, { reason: ['not_checked'] }); }
    if (field === 'comparison') Object.assign(v.results[0]!, { current: ['unknown'] });
    if (field === 'use kind') { v.uses = [{ id: 'daily', label: 'Daily import', kind: 'schedule' }]; Object.assign(v.uses[0]!, { kind: ['schedule'] }); }
    expect(isAuthenticationAccessVerification(v)).toBe(false);
  });
  it('accepts only an opaque retained renewal selection and a matching active access receipt', () => {
    const selection = { kind: 'renewal' as const, id: 'renewal-12345678-1234-4123-8123-123456789abc' };
    const p = preview(); p.selection = selection;
    expect(isAuthenticationAccessRequest({ action: 'authentication_access_preview', selection })).toBe(true);
    expect(isAuthenticationAccessSelection({ ...selection, kind: ['renewal'] })).toBe(false);
    expect(isAuthenticationAccessSelection({ ...selection, id: 'https://vendor.test' })).toBe(false);
    const v = receipt(); v.selection = selection; v.status = 'checking'; delete v.finished_at;
    p.running = v; expect(isAuthenticationAccessPreview(p)).toBe(true);
    p.running.selection = preview().selection; expect(isAuthenticationAccessPreview(p)).toBe(false);
    p.running.selection = selection; p.running.status = 'completed'; p.running.finished_at = 1100;
    expect(isAuthenticationAccessPreview(p)).toBe(false);
  });
  it('accepts bounded reviews, checking jobs and finished historical results', () => {
    expect(isAuthenticationAccessPreview(preview())).toBe(true); const v = receipt(); expect(isAuthenticationAccessVerification(v)).toBe(true);
    v.results[0]!.current = 'no'; expect(isAuthenticationAccessVerification(v)).toBe(true);
    v.status = 'checking'; delete v.finished_at; v.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }];
    expect(isAuthenticationAccessVerification(v)).toBe(true);
  });
  it('rejects wrong check/target pairs, unsafe defaults and duplicate targets', () => {
    const p = preview(); p.targets[0]!.check = 'file_metadata'; expect(isAuthenticationAccessPreview(p)).toBe(false);
    const other = preview(); other.targets[0]!.default_url = 'https://user:secret@vendor.test/v1'; expect(isAuthenticationAccessPreview(other)).toBe(false);
    const repeated = preview(); repeated.targets.push(repeated.targets[0]!); expect(isAuthenticationAccessPreview(repeated)).toBe(false);
  });
  it.each(['writes', 'no-reason', 'checking-time', 'completed-waiting', 'wrong-revision', 'empty-checks', 'duplicate-checks'] as const)('refuses contradictory receipt state: %s', kind => {
    const v = receipt();
    if (kind === 'writes') v.results[0]!.checks = [{ kind: 'write_permissions', status: 'passed' }];
    if (kind === 'no-reason') v.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed' }];
    if (kind === 'checking-time') v.status = 'checking';
    if (kind === 'completed-waiting') v.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }];
    if (kind === 'wrong-revision') v.results[0]!.authentication_revision = 'raw-token';
    if (kind === 'empty-checks') v.results[0]!.checks = [];
    if (kind === 'duplicate-checks') v.results[0]!.checks.push(v.results[0]!.checks[0]!);
    expect(isAuthenticationAccessVerification(v)).toBe(false);
  });
  it('accepts blank resources and Sheets links as owner inputs while rejecting over-limit or duplicated choices', () => {
    const request = { action: 'authentication_access_run', review_id: 'a'.repeat(43), fingerprint: 'b'.repeat(64), attempt_id: 'c'.repeat(43), choices: [{ target_id: 'd'.repeat(64), url: '' }] };
    expect(isAuthenticationAccessRequest(request)).toBe(true); request.choices[0]!.url = 'https://docs.google.com/spreadsheets/d/test/edit#gid=123'; expect(isAuthenticationAccessRequest(request)).toBe(true);
    request.choices[0]!.url = 'x'.repeat(4097); expect(isAuthenticationAccessRequest(request)).toBe(false); request.choices[0]!.url = '';
    request.choices.push(request.choices[0]!); expect(isAuthenticationAccessRequest(request)).toBe(false);
  });
  it('validates one causal mixed history order including independent access-check entries', () => {
    const v = receipt(); const page = { scope: { kind: 'all' }, observed_at: 1200, retention_days: 90, incidents: [], repairs: [], verifications: [v], order: [v.id] };
    expect(isAuthenticationIncidentHistoryPage(page)).toBe(true); expect(isAuthenticationIncidentHistoryPage({ ...page, order: [] })).toBe(false);
    expect(isAuthenticationIncidentHistoryPage({ ...page, verifications: [v, v], order: [v.id, v.id] })).toBe(false);
  });
});
