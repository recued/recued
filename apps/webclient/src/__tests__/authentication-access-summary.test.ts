import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticationAccessSummary, AuthenticationAccessSummaryEvidence, AuthenticationAccessVerification, AuthenticationRepairWorklist, AuthenticationRepairAction } from '@recued/contracts';
import { PickerElement } from './helpers/file-download-picker-dom.js';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { createAuthenticationAccessPanel } from '../connections/authentication-access-panel.js';
import { appendLatestAuthenticationAccess } from '../connections/authentication-access-summary.js';
import { createReconnectWorklistPanel } from '../settings/reconnect-worklist-panel.js';
import { createAuthenticationIncidentPanel } from '../connections/authentication-incident-panel.js';

afterEach(() => vi.useRealTimers());
const summary = (): AuthenticationAccessSummary => ({ selection: { kind: 'group', id: 'a'.repeat(64) }, observed_at: 3000, targets_truncated: false, lookup_incomplete: false,
  targets: [{ id: 'b'.repeat(64), label: 'Work account', target: { kind: 'connection', name: 'work' }, state: 'checked', latest: {
    id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'group', id: 'a'.repeat(64) }, status: 'completed', started_at: 1000, finished_at: 2000,
    result: { id: 'b'.repeat(64), label: 'Work account', target: { kind: 'connection', name: 'work' }, authentication_revision: 'c'.repeat(64), current: 'yes',
      checks: [{ kind: 'api_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] },
  } }] });
const receipt = (entry: AuthenticationAccessSummaryEvidence): AuthenticationAccessVerification => ({ id: entry.id, selection: entry.selection,
  status: entry.status, started_at: entry.started_at, ...(entry.finished_at !== undefined ? { finished_at: entry.finished_at } : {}),
  targets_truncated: false, usage_available: true, uses: [], results: [structuredClone(entry.result)] });
const fixture = () => {
  const root = new PickerElement(); let active: PickerElement | null = null;
  const doc = { get activeElement() { return active; }, createElement: () => { const e = new PickerElement(); e.focus = () => { active = e; }; return e; } } as unknown as Document;
  const value = summary(); const saved = receipt(value.targets[0]!.latest!);
  const call = vi.fn<ManagedOAuthCaller>(async args => { if (args.action !== 'authentication_access_status') throw Error('Unexpected operation ' + args.action); return { action: args.action, verification: saved }; });
  const mountAccess = () => { const p = createAuthenticationAccessPanel({ document: doc, call }); p.mount(root as unknown as HTMLElement); return p; };
  const action = (name: string) => { const found = root.querySelector('[data-authentication-access-action="' + name + '"]'); if (!found) throw Error('Missing action ' + name); return found; };
  return { root, doc, value, saved, call, mountAccess, action };
};
describe('latest access summary and saved-source review', () => {
  it('links a passed latest resource to its exact saved check page without reading or preparing another check', () => {
    const f = fixture(); const row = f.value.targets[0]!;
    appendLatestAuthenticationAccess(f.doc, f.root as unknown as HTMLElement, f.value);
    expect(f.root.querySelector('[data-latest-access-page]')!.getAttribute('href')).toBe('#connections/others/access-check/' + row.latest!.id + '/target/' + row.id);
    expect(f.call).not.toHaveBeenCalled(); expect(f.root.textContent).toContain('Checked reads passed');
  });
  it.each(['worklist', 'history'] as const)('keeps an expanded legacy access result visible while a %s shortcut is read or refused', async view => {
    const f = fixture(); f.saved.results[0]!.checks = [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }];
    const repairId = 'repair-' + 'd'.repeat(64); const groupId = 'a'.repeat(64);
    if (view === 'history') f.saved.selection = { kind: 'repair', id: repairId };
    const worklist: AuthenticationRepairWorklist = { observed_at: 3000, unavailable: [], groups: [{ id: groupId, kind: 'account', label: 'Work', authentication: 'direct_oauth',
      connection_names: ['work'], targets: [{ kind: 'connection', name: 'work' }], uses: [], usage_available: true, issues: [], access_verification: f.saved }] };
    const repair: AuthenticationRepairAction = { id: repairId, action: 'reauthorize', status: 'applied', started_at: 100, finished_at: 200,
      targets: worklist.groups[0]!.targets, targets_truncated: false, incidents: [], incidents_truncated: false, access_verification: f.saved };
    const panel = view === 'worklist' ? createReconnectWorklistPanel({ document: f.doc, repairs: async () => worklist, verify: f.call })
      : createAuthenticationIncidentPanel({ document: f.doc, scope: { kind: 'all' }, verify: f.call, call: async query => ({ scope: query.scope, observed_at: 3000,
        retention_days: 90, incidents: [], repairs: [repair], order: [repairId] }) });
    panel.mount(f.root as unknown as HTMLElement); await panel.whenLoaded();
    const findDisclosure = (parent: PickerElement): PickerElement | undefined => parent.children[0]?.ownText === 'Latest access check'
      ? parent : parent.children.map(findDisclosure).find(Boolean);
    const disclosure = () => { const found = findDisclosure(f.root); if (!found) throw Error('Missing Latest access check disclosure'); return found; };
    disclosure().open = true;
    let reject!: (error: Error) => void; f.call.mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
    disclosure().querySelector('[data-access-repair-shortcut]')!.click(); expect(disclosure().open).toBe(true);
    reject(Error('offline-secret')); await panel.whenLoaded(); expect(disclosure().open).toBe(true);
    expect(disclosure().querySelector('[role="alert"]')?.textContent).toContain('could not be read');
    expect(f.root.textContent).not.toContain('offline-secret'); panel.dispose();
  });
  it.each(['worklist', 'history'] as const)('opens authentication from the exact latest failed result in %s', async view => {
    const f = fixture(); const location = { hash: '' }; Object.assign(f.doc, { defaultView: { location } });
    f.value.targets[0]!.latest!.result.checks = [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }];
    f.saved.results[0]!.checks = structuredClone(f.value.targets[0]!.latest!.result.checks);
    const repairId = 'repair-' + 'd'.repeat(64);
    const worklist: AuthenticationRepairWorklist = { observed_at: 3000, unavailable: [], groups: [{ id: 'a'.repeat(64), kind: 'account', label: 'Work', authentication: 'direct_oauth',
      connection_names: ['work'], targets: [{ kind: 'connection', name: 'work' }], uses: [], usage_available: true, issues: [], access_summary: f.value }] };
    const repair: AuthenticationRepairAction = { id: repairId, action: 'reauthorize', status: 'applied', started_at: 100, finished_at: 200,
      targets: worklist.groups[0]!.targets, targets_truncated: false, incidents: [], incidents_truncated: false, access_summary: { ...f.value, selection: { kind: 'repair', id: repairId } } };
    const panel = view === 'worklist' ? createReconnectWorklistPanel({ document: f.doc, repairs: async () => worklist, verify: f.call })
      : createAuthenticationIncidentPanel({ document: f.doc, scope: { kind: 'all' }, verify: f.call, call: async query => ({ scope: query.scope, observed_at: 3000,
        retention_days: 90, incidents: [], repairs: [repair], order: [repairId] }) });
    panel.mount(f.root as unknown as HTMLElement); await panel.whenLoaded(); expect(f.call).not.toHaveBeenCalled();
    f.root.querySelector('[data-access-repair-shortcut]')!.click(); await panel.whenLoaded();
    expect(location.hash).toBe('#connections/others/review-access/api/work/from-access/' + f.saved.id + '/' + f.saved.results[0]!.id); expect(f.call).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_status', id: f.saved.id });
    expect(f.root.textContent).toContain('Protected API read: Failed'); panel.dispose();
  });
  it('blocks a stale summary shortcut and clears its error on a new worklist snapshot', async () => {
    const f = fixture(); const location = { hash: '' }; Object.assign(f.doc, { defaultView: { location } });
    f.value.targets[0]!.latest!.result.checks = [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }];
    f.saved.results[0]!.checks = structuredClone(f.value.targets[0]!.latest!.result.checks); f.saved.results[0]!.current = 'no';
    const data: AuthenticationRepairWorklist = { observed_at: 3000, unavailable: [], groups: [{ id: 'a'.repeat(64), kind: 'account', label: 'Work', authentication: 'direct_oauth',
      connection_names: ['work'], targets: [{ kind: 'connection', name: 'work' }], uses: [], usage_available: true, issues: [], access_summary: f.value }] };
    const panel = createReconnectWorklistPanel({ document: f.doc, repairs: async () => data, verify: f.call }); panel.mount(f.root as unknown as HTMLElement); await panel.whenLoaded();
    f.root.querySelector('[data-access-repair-shortcut]')!.click(); await panel.whenLoaded(); expect(location.hash).toBe(''); expect(f.root.textContent).toContain('could not be compared');
    await panel.refresh(); expect(f.root.textContent).not.toContain('could not be compared'); panel.dispose();
  });
  it('shows the source clock and keeps successful reads separate from unperformed writes', () => {
    const f = fixture(); appendLatestAuthenticationAccess(f.doc, f.root as unknown as HTMLElement, f.value);
    expect(f.root.textContent).toContain('Checked reads passed'); expect(f.root.textContent).toContain('Check finished: ' + new Date(2000).toLocaleString());
    expect(f.root.textContent).toContain('Summary read: ' + new Date(3000).toLocaleString()); expect(f.root.textContent).toContain('Sending, editing and other writes: Unconfirmed');
    expect(f.call).not.toHaveBeenCalled();
  });
  it.each(['no', 'unknown'] as const)('does not headline a historical pass as current when comparison is %s', current => {
    const f = fixture(); f.value.targets[0]!.latest!.result.current = current; appendLatestAuthenticationAccess(f.doc, f.root as unknown as HTMLElement, f.value);
    expect(f.root.textContent).not.toContain('Checked reads passed'); expect(f.root.textContent).toContain(current === 'no' ? 'Superseded result' : 'Authentication comparison unknown');
    expect(f.root.textContent).toContain('(historical result)');
  });
  it('labels missing and unavailable checks and incomplete coverage', () => {
    const f = fixture(); f.value.lookup_incomplete = true; f.value.targets[0]!.state = 'unavailable'; delete f.value.targets[0]!.latest;
    f.value.targets.push({ id: 'd'.repeat(64), target: { kind: 'file_source', source_id: 'work.files' }, label: 'Files', state: 'not_checked' });
    appendLatestAuthenticationAccess(f.doc, f.root as unknown as HTMLElement, f.value);
    expect(f.root.textContent).toContain('Some targets or saved checks could not be summarized'); expect(f.root.textContent).toContain('Saved checks could not be read'); expect(f.root.textContent).toContain('No retained read check');
  });
  it('opens only the exact saved source through local status and offers a separate review link', async () => {
    const f = fixture(); const panel = f.mountAccess(); await panel.openSaved(f.value.targets[0]!.latest!);
    expect(f.call).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_status', id: f.saved.id }); expect(panel.hasDraft()).toBe(false); expect(panel.hasInFlightWork()).toBe(false);
    expect(f.root.textContent).toContain('Saved access check'); expect(f.action('review').getAttribute('href')).toBe('#connections/others/verify-access/group/' + 'a'.repeat(64)); panel.dispose();
  });
  it('keeps the full source receipt available when a job checked more than the summary row', async () => {
    const f = fixture(); f.saved.results.push({ ...f.saved.results[0]!, id: 'd'.repeat(64), target: { kind: 'collection', platform: 'mail', slug: 'other' }, label: 'Other checked target', checks: [{ kind: 'collection_read', status: 'passed' }] });
    const panel = f.mountAccess(); await panel.openSaved(f.value.targets[0]!.latest!); expect(f.root.textContent).toContain('Other checked target'); expect(f.call).toHaveBeenCalledTimes(1); panel.dispose();
  });
  it('reviews the containing current group even when the saved source began from an older check', async () => {
    const f = fixture(); const source = f.value.targets[0]!.latest!;
    source.selection = { kind: 'verification', id: 'verify-22345678-1234-4123-8123-123456789abc' }; f.saved.selection = source.selection;
    const panel = f.mountAccess(); await panel.openSaved(source, undefined, { kind: 'group', id: 'd'.repeat(64) });
    expect(f.action('review').getAttribute('href')).toBe('#connections/others/verify-access/group/' + 'd'.repeat(64));
    expect(f.call).toHaveBeenCalledTimes(1); panel.dispose();
  });
  it.each(['id', 'account', 'revision', 'started', 'rollback'] as const)('refuses an inconsistent saved-source %s', async mismatch => {
    const f = fixture();
    if (mismatch === 'id') f.saved.id = 'verify-22345678-1234-4123-8123-123456789abc';
    if (mismatch === 'account') f.saved.results[0]!.target = { kind: 'connection', name: 'other' };
    if (mismatch === 'revision') f.saved.results[0]!.authentication_revision = 'd'.repeat(64);
    if (mismatch === 'started') f.saved.started_at = 999;
    if (mismatch === 'rollback') { f.saved.status = 'checking'; delete f.saved.finished_at; }
    const panel = f.mountAccess(); await panel.openSaved(f.value.targets[0]!.latest!);
    expect(f.root.textContent).toContain('saved check could not be opened'); expect(f.root.textContent).not.toContain('Protected API read: Passed'); expect(panel.hasDraft()).toBe(false); panel.dispose();
  });
  it('retries a missing saved source through status without preparing or running new checks', async () => {
    const f = fixture(); f.call.mockRejectedValueOnce(new Error('private failure')); const panel = f.mountAccess(); await panel.openSaved(f.value.targets[0]!.latest!);
    expect(f.root.textContent).not.toContain('private failure'); f.action('retry-review').click(); await panel.whenLoaded();
    expect(f.call.mock.calls.map(([r]) => r.action)).toEqual(['authentication_access_status', 'authentication_access_status']); expect(f.root.textContent).toContain('Protected API read: Passed'); panel.dispose();
  });
  it('ignores a late saved result after Close and permits leaving during the local read', async () => {
    const f = fixture(); let release!: (value: Awaited<ReturnType<ManagedOAuthCaller>>) => void; f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const panel = f.mountAccess(); const pending = panel.openSaved(f.value.targets[0]!.latest!); expect(panel.hasDraft()).toBe(false); expect(panel.hasInFlightWork()).toBe(false);
    f.action('close').click(); release({ action: 'authentication_access_status', verification: f.saved }); await pending; expect(f.root.textContent).toBe(''); panel.dispose();
  });
  it('polls the same running receipt without repeating any vendor operation', async () => {
    vi.useFakeTimers(); const f = fixture(); const entry = f.value.targets[0]!.latest!; entry.status = 'checking'; delete entry.finished_at;
    f.saved.status = 'checking'; delete f.saved.finished_at; f.saved.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }];
    const panel = f.mountAccess(); await panel.openSaved(entry); f.saved.status = 'completed'; f.saved.finished_at = 2000; f.saved.results[0]!.checks = [{ kind: 'api_read', status: 'passed' }];
    await vi.advanceTimersByTimeAsync(1500); expect(f.root.textContent).toContain('Protected API read: Passed'); expect(f.call.mock.calls.map(([r]) => r.action)).toEqual(['authentication_access_status', 'authentication_access_status']); panel.dispose();
  });
  it('rejects a saved-status poll that changes the original attempt timestamp', async () => {
    vi.useFakeTimers(); const f = fixture(); const entry = f.value.targets[0]!.latest!;
    entry.status = 'checking'; delete entry.finished_at; f.saved.status = 'checking'; delete f.saved.finished_at;
    f.saved.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }];
    const panel = f.mountAccess(); await panel.openSaved(entry); f.saved.status = 'completed'; f.saved.started_at = 999; f.saved.finished_at = 2000;
    f.saved.results[0]!.checks = [{ kind: 'api_read', status: 'passed' }]; await vi.advanceTimersByTimeAsync(1500);
    expect(f.root.textContent).toContain('Check status could not be refreshed'); expect(f.root.textContent).not.toContain('Protected API read: Passed');
    expect(f.call.mock.calls.map(([r]) => r.action)).toEqual(['authentication_access_status', 'authentication_access_status']); panel.dispose();
  });
  it('keeps unavailable summaries visible without an incident or a legacy receipt', async () => {
    const f = fixture(); f.value.lookup_incomplete = true; f.value.targets[0]!.state = 'unavailable'; delete f.value.targets[0]!.latest;
    const data: AuthenticationRepairWorklist = { observed_at: 3000, unavailable: [], groups: [{ id: 'a'.repeat(64), kind: 'account', label: 'Work', authentication: 'direct_oauth',
      connection_names: ['work'], targets: [{ kind: 'connection', name: 'work' }], uses: [], usage_available: true, issues: [], access_summary: f.value }] };
    const panel = createReconnectWorklistPanel({ document: f.doc, repairs: async () => data, verify: f.call }); panel.mount(f.root as unknown as HTMLElement); await panel.whenLoaded();
    expect(f.root.textContent).toContain('Saved checks could not be read');
    expect(f.root.querySelector('[data-reconnect-worklist-action="verify-' + 'a'.repeat(64) + '"]')).not.toBeNull(); expect(f.call).not.toHaveBeenCalled(); panel.dispose();
  });
  it('surfaces a successful retry in Authentication repairs and leaves recorded problems visible', async () => {
    const f = fixture(); const old = receipt(f.value.targets[0]!.latest!); old.id = 'verify-22345678-1234-4123-8123-123456789abc'; old.results[0]!.checks = [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }];
    const data: AuthenticationRepairWorklist = { observed_at: 3000, unavailable: [], groups: [{ id: 'a'.repeat(64), kind: 'account', label: 'Work', authentication: 'direct_oauth', connection_names: ['work'],
      targets: [{ kind: 'connection', name: 'work' }], uses: [], usage_available: true, issues: [{ id: 'd'.repeat(64), code: 'credential_rejected', message: 'Recorded access problem' }], access_verification: old, access_summary: f.value }] };
    const panel = createReconnectWorklistPanel({ document: f.doc, repairs: async () => data, verify: f.call }); panel.mount(f.root as unknown as HTMLElement); await panel.whenLoaded();
    expect(f.root.textContent).toContain('Checked reads passed'); expect(f.root.textContent).not.toContain('Protected API read: Failed'); expect(f.root.textContent).toContain('Recorded access problem'); expect(f.call).not.toHaveBeenCalled();
    expect(f.root.querySelector('[data-reconnect-worklist-action="verify-' + 'a'.repeat(64) + '"]')!.getAttribute('href')).toBe('#connections/others/verify-access/group/' + 'a'.repeat(64));
    const source = f.root.querySelector('[data-latest-access-view="' + 'b'.repeat(64) + '"]')!; source.click(); await panel.whenLoaded(); expect(f.call).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_status', id: f.saved.id });
    panel.dispose(); source.click(); expect(f.call).toHaveBeenCalledTimes(1);
  });
  it('shows a current summary beside an unchanged applied repair and opens the exact source result', async () => {
    const f = fixture(); const repairId = 'repair-' + 'a'.repeat(64); f.value.selection = { kind: 'repair', id: repairId };
    const repair: AuthenticationRepairAction = { id: repairId, action: 'reauthorize', status: 'applied', started_at: 100, finished_at: 200,
      targets: [{ kind: 'connection', name: 'work' }], targets_truncated: false, incidents: [], incidents_truncated: false, access_summary: f.value };
    const panel = createAuthenticationIncidentPanel({ document: f.doc, scope: { kind: 'all' }, verify: f.call, call: async query => ({ scope: query.scope, observed_at: 3000,
      retention_days: 90, incidents: [], repairs: [repair], order: [repairId] }) }); panel.mount(f.root as unknown as HTMLElement); await panel.whenLoaded();
    expect(f.root.textContent).toContain('Checked reads passed'); expect(f.root.textContent).toContain('Later successful operations are needed'); expect(f.call).not.toHaveBeenCalled();
    f.root.querySelector('[data-latest-access-view="' + 'b'.repeat(64) + '"]')!.click(); await panel.whenLoaded(); expect(f.call).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_status', id: f.saved.id });
    expect(repair.status).toBe('applied'); expect(repair.recovery_confirmed_at).toBeUndefined(); panel.dispose();
  });
});
