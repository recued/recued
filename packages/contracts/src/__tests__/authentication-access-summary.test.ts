import { describe, expect, it } from 'vitest';
import { isAuthenticationAccessSummary, type AuthenticationAccessSummary } from '../authentication-access-summary.js';
import { isAuthenticationRepairWorklist } from '../authentication-repair-worklist.js';
import { isAuthenticationRepairAction } from '../authentication-incident-history.js';

const value = (): AuthenticationAccessSummary => ({ selection: { kind: 'group', id: 'a'.repeat(64) }, observed_at: 3000,
  targets_truncated: false, lookup_incomplete: false, targets: [{ id: 'b'.repeat(64), target: { kind: 'connection', name: 'work' }, label: 'Work', state: 'checked', latest: {
    id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'verification', id: 'verify-22345678-1234-4123-8123-123456789abc' },
    status: 'completed', started_at: 1000, finished_at: 2000, result: { id: 'b'.repeat(64), target: { kind: 'connection', name: 'work' }, label: 'Work',
      authentication_revision: 'c'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] },
  } }] });
describe('latest access summary boundary', () => {
  it('accepts distinct source clocks, pending attempts, unchecked targets and unknown current authentication', () => {
    const v = value(); expect(isAuthenticationAccessSummary(v)).toBe(true);
    v.targets[0]!.latest!.status = 'checking'; delete v.targets[0]!.latest!.finished_at; v.targets[0]!.latest!.result.current = 'unknown'; expect(isAuthenticationAccessSummary(v)).toBe(true);
    v.targets[0]!.state = 'not_checked'; delete v.targets[0]!.latest; expect(isAuthenticationAccessSummary(v)).toBe(true);
    v.targets = []; expect(isAuthenticationAccessSummary(v)).toBe(true);
  });
  it.each(['target', 'result id', 'write pass', 'sparse', 'state', 'finished time', 'unchecked proof', 'limit'] as const)('rejects contradictory %s', field => {
    const v = value(); const row = v.targets[0]!;
    if (field === 'target') row.latest!.result.target = { kind: 'connection', name: 'other' };
    if (field === 'result id') row.latest!.result.id = 'd'.repeat(64);
    if (field === 'write pass') row.latest!.result.checks = [{ kind: 'write_permissions', status: 'passed' }];
    if (field === 'sparse') v.targets = Array(1);
    if (field === 'state') Object.assign(row, { state: ['checked'] });
    if (field === 'finished time') row.latest!.finished_at = 1;
    if (field === 'unchecked proof') row.state = 'not_checked';
    if (field === 'limit') v.targets = Array.from({ length: 33 }, (_, n) => ({ ...row, id: n.toString(16).padStart(64, '0') }));
    expect(isAuthenticationAccessSummary(v)).toBe(false);
  });
  it('binds a worklist summary to its containing group and resource targets', () => {
    const summary = value(); const group = { id: summary.selection.id, label: 'Work', kind: 'account', authentication: 'direct_oauth', connection_names: ['work'], issues: [], uses: [], usage_available: true,
      targets: [{ kind: 'connection', name: 'work' }], access_summary: summary };
    const worklist = { observed_at: 3000, groups: [group], unavailable: [] }; expect(isAuthenticationRepairWorklist(worklist)).toBe(true);
    group.id = 'd'.repeat(64); expect(isAuthenticationRepairWorklist(worklist)).toBe(false); group.id = summary.selection.id;
    group.targets = [{ kind: 'connection', name: 'other' }]; expect(isAuthenticationRepairWorklist(worklist)).toBe(false);
  });
  it('binds repair summaries without rewriting the applied repair or its original targets', () => {
    const summary = value(); summary.selection = { kind: 'repair', id: 'repair-' + 'a'.repeat(64) };
    const repair = { id: summary.selection.id, action: 'reauthorize', status: 'applied', started_at: 100, finished_at: 200,
      targets: [{ kind: 'connection', name: 'work' }], targets_truncated: false, incidents: [], incidents_truncated: false, access_summary: summary };
    expect(isAuthenticationRepairAction(repair)).toBe(true); repair.id = 'repair-' + 'd'.repeat(64); expect(isAuthenticationRepairAction(repair)).toBe(false);
  });
});
