import { describe, expect, it } from 'vitest';
import { isAuthenticationRepairWorklist, type AuthenticationAccessSummaryEvidence, type AuthenticationRepairGroup, type AuthenticationRepairWorklist } from '@recued/contracts';
import { accessEvidenceVerification, bulkAuthenticationAccessRechecks } from '../connections/bulk-authentication-access-rechecks.js';

const hash = (n: number) => n.toString(16).padStart(64, '0');
const evidence = (n: number, status: 'passed' | 'failed' | 'unconfirmed' = 'failed', source = 1): AuthenticationAccessSummaryEvidence => ({
  id: 'verify-' + source.toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc', selection: { kind: 'group', id: hash(1) },
  status: 'completed', started_at: 1000, finished_at: 2000,
  result: { id: hash(n), target: { kind: 'connection', name: 'api-' + n }, label: 'API ' + n, authentication_revision: hash(10), current: 'yes',
    checks: [{ kind: 'api_read', status, ...(status !== 'passed' ? { reason: 'access_rejected' as const } : {}) }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] },
});
const group = (n: number, entries: AuthenticationAccessSummaryEvidence[]): AuthenticationRepairGroup => ({
  id: hash(n), kind: 'account', label: 'Account ' + n, authentication: 'direct_oauth', connection_names: entries.map(e => e.result.target.kind === 'connection' ? e.result.target.name : 'files'),
  targets: entries.map(e => e.result.target), issues: [], uses: [], usage_available: true,
  access_summary: { selection: { kind: 'group', id: hash(n) }, observed_at: 3000, targets_truncated: false, lookup_incomplete: false,
    targets: entries.map(e => ({ id: e.result.id, target: e.result.target as Exclude<typeof e.result.target, { kind: 'oauth_apps' }>, label: e.result.label, state: 'checked', latest: e })) },
});
const worklist = (...groups: AuthenticationRepairGroup[]): AuthenticationRepairWorklist => ({ observed_at: 3000, groups, unavailable: [] });
describe('bulk recheck selection from local latest access', () => {
  it('groups only latest completed non-passing reads by their exact saved source', () => {
    const f = worklist(group(1, [evidence(1), evidence(2, 'passed', 2), evidence(3, 'unconfirmed', 3)])); const before = structuredClone(f);
    const result = bulkAuthenticationAccessRechecks(f);
    expect(result.checks.map(c => [c.id, c.evidence.map(e => e.result.id)])).toEqual([[evidence(1).id, [hash(1)]], [evidence(3, 'unconfirmed', 3).id, [hash(3)]]]);
    expect(result.unavailable).toEqual([]); result.checks[0]!.evidence[0]!.result.current = 'no'; expect(f).toEqual(before);
  });
  it('includes an unconfirmed file download even when metadata passed', () => {
    const file = evidence(1); file.result.target = { kind: 'file_source', source_id: 'work.files' };
    file.result.checks = [{ kind: 'file_metadata', status: 'passed' }, { kind: 'file_download', status: 'unconfirmed', reason: 'resource_required' }];
    expect(bulkAuthenticationAccessRechecks(worklist(group(1, [file]))).checks[0]!.evidence).toEqual([file]);
  });
  it('excludes unfinished jobs and writes that were deliberately not executed', () => {
    const running = evidence(2); running.status = 'checking'; delete running.finished_at;
    running.result.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }];
    const result = bulkAuthenticationAccessRechecks(worklist(group(1, [evidence(1, 'passed'), running])));
    expect(result.checks).toEqual([]); expect(result.unavailable.join(' ')).toContain('still running');
  });
  it('does not resurrect a legacy failure under a newer pass or unavailable lookup', () => {
    const old = group(1, [evidence(1)]); old.access_verification = accessEvidenceVerification(evidence(1)); delete old.access_summary;
    const current = group(2, [evidence(1, 'passed', 2)]);
    expect(bulkAuthenticationAccessRechecks(worklist(old, current)).checks).toEqual([]);
    current.access_summary!.targets[0]!.state = 'unavailable'; delete current.access_summary!.targets[0]!.latest;
    const result = bulkAuthenticationAccessRechecks(worklist(old, current)); expect(result.checks).toEqual([]); expect(result.unavailable.join(' ')).toContain('unavailable');
    current.access_summary!.targets = []; current.access_summary!.lookup_incomplete = true;
    expect(bulkAuthenticationAccessRechecks(worklist(old, current)).checks).toEqual([]);
  });
  it('supports legacy group receipts but excludes removed targets and app settings', () => {
    const old = group(1, [evidence(1)]); const extra = evidence(2);
    old.access_verification = { ...accessEvidenceVerification(evidence(1)), results: [evidence(1).result, extra.result] }; delete old.access_summary;
    const app = { ...group(2, [evidence(3, 'failed', 3)]), kind: 'app' as const };
    expect(bulkAuthenticationAccessRechecks(worklist(old, app)).checks.map(c => c.evidence.map(e => e.result.id))).toEqual([[hash(1)]]);
  });
  it('deduplicates shared resources and refuses inconsistent latest observations', () => {
    const left = group(1, [evidence(1)]), right = group(2, [evidence(1)]);
    const shared = bulkAuthenticationAccessRechecks(worklist(left, right)).checks[0]!;
    expect(shared.evidence).toHaveLength(1); expect(shared.account_labels).toEqual(['Account 1', 'Account 2']);
    right.access_summary!.targets[0]!.latest = evidence(1, 'passed', 2);
    const result = bulkAuthenticationAccessRechecks(worklist(left, right)); expect(result.checks).toEqual([]); expect(result.unavailable.join(' ')).toContain('inconsistent');
  });
  it('refuses source fragments with conflicting saved attempt clocks', () => {
    const first = evidence(1), second = evidence(2); second.finished_at = 2001;
    const result = bulkAuthenticationAccessRechecks(worklist(group(1, [first, second])));
    expect(result.checks).toEqual([]); expect(result.unavailable.join(' ')).toContain('inconsistent');
  });
  it('keeps incomplete lookups visible without using the older full-group result', () => {
    const g = group(1, []); g.access_summary!.lookup_incomplete = true; g.access_verification = accessEvidenceVerification(evidence(1));
    const result = bulkAuthenticationAccessRechecks(worklist(g)); expect(result.checks).toEqual([]); expect(result.unavailable.join(' ')).toContain('omitted');
  });
  it('omits an oversized assembled source without blocking another valid saved check', () => {
    const f = worklist(group(1, Array.from({ length: 32 }, (_, n) => evidence(n + 1))), group(2, [evidence(33), evidence(34, 'failed', 2)]));
    expect(isAuthenticationRepairWorklist(f)).toBe(true);
    const result = bulkAuthenticationAccessRechecks(f);
    expect(result.checks.map(c => c.id)).toEqual([evidence(34, 'failed', 2).id]); expect(result.unavailable.join(' ')).toContain('inconsistent');
  });
  it('checks source clocks on passed fragments as well as on selected failed reads', () => {
    const first = evidence(1), second = evidence(2, 'passed'); second.finished_at = 2001;
    const f = worklist(group(1, [first, second])); expect(isAuthenticationRepairWorklist(f)).toBe(true);
    const result = bulkAuthenticationAccessRechecks(f); expect(result.checks).toEqual([]); expect(result.unavailable.join(' ')).toContain('inconsistent');
  });
  it('omits a source that assigns the same result ID to different resources', () => {
    const first = evidence(1), second = evidence(2); second.result.id = first.result.id;
    const f = worklist(group(1, [first]), group(2, [second])); expect(isAuthenticationRepairWorklist(f)).toBe(true);
    const result = bulkAuthenticationAccessRechecks(f); expect(result.checks).toEqual([]); expect(result.unavailable.join(' ')).toContain('inconsistent');
  });
});
