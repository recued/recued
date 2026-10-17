import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILE_DOWNLOAD_VERIFICATION_MAX_BYTES, type AuthenticationAccessPreview, type AuthenticationAccessSelection, type AuthenticationAccessVerification } from '@recued/contracts';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { createAuthenticationAccessPanel } from '../connections/authentication-access-panel.js';
import { PickerElement } from './helpers/file-download-picker-dom.js';
import { createAuthenticationIncidentPanel } from '../connections/authentication-incident-panel.js';
import { createReconnectWorklistPanel } from '../settings/reconnect-worklist-panel.js';

afterEach(() => vi.useRealTimers());
const selection: AuthenticationAccessSelection = { kind: 'group', id: 'a'.repeat(64) };
const preview = (selected: AuthenticationAccessSelection = selection): AuthenticationAccessPreview => ({ id: 'b'.repeat(43), fingerprint: 'c'.repeat(64), expires_at: 999999,
  selection: selected, label: 'Work <account>', targets_truncated: false, usage_available: true, uses: [{ kind: 'schedule', id: 'daily', label: 'Daily import' }],
  targets: [{ id: 'd'.repeat(64), target: { kind: 'connection', name: 'work' }, label: 'Work API', authentication_revision: 'e'.repeat(64), check: 'api_read',
    base_url: 'https://vendor.test/v1', default_url: 'https://vendor.test/v1/me' }] });
const receipt = (selected: AuthenticationAccessSelection = selection): AuthenticationAccessVerification => ({ id: 'verify-12345678-1234-4123-8123-123456789abc', selection: selected, status: 'completed', started_at: 1000, finished_at: 1100,
  targets_truncated: false, usage_available: true, uses: preview().uses, results: [{ id: 'd'.repeat(64), target: { kind: 'connection', name: 'work' }, label: 'Work API', authentication_revision: 'e'.repeat(64), current: 'yes',
    checks: [{ kind: 'api_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] }] });
const dom = () => {
  const root = new PickerElement(); let active: PickerElement | null = null;
  const doc = { get activeElement() { return active; }, createElement: () => { const element = new PickerElement(); element.focus = () => { active = element; }; return element; } };
  return { root, doc: doc as unknown as Document };
};
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const fixture = () => {
  const { root, doc } = dom(); const plan = preview(); const done = receipt();
  const call = vi.fn<ManagedOAuthCaller>(async args => {
    if (args.action === 'authentication_access_retire') return { action: args.action };
    if (args.action === 'authentication_access_preview') return { action: args.action, preview: plan };
    if (args.action === 'authentication_access_run' || args.action === 'authentication_access_status') return { action: args.action, verification: done };
    if (args.action === 'file_authentication_files') return { action: args.action, choices: { source_id: 'google.work.file', connection_name: 'work', updated_at: 2,
      available: true, max_bytes: FILE_DOWNLOAD_VERIFICATION_MAX_BYTES, files: [{ remote_id: 'chosen', filename: 'Report.pdf', output_filename: 'Report.pdf', mode: 'download', mime_type: 'application/pdf' }] } };
    throw new Error('Unexpected action ' + args.action);
  });
  const updated = vi.fn(); const panel = createAuthenticationAccessPanel({ document: doc, call, updated }); panel.mount(root as unknown as HTMLElement);
  const action = (id: string) => { const button = root.querySelector('[data-authentication-access-action="' + id + '"]'); if (!button) throw new Error('Missing action ' + id); return button; };
  return { root, doc, panel, call, updated, plan, done, action };
};

describe('owner Verify access review and saved results', () => {
  it('guards an unresolved start receipt and allows Close without a late result reopening the panel', async () => {
    const f = fixture(); f.panel.open(selection); await f.panel.whenLoaded();
    let release!: (value: Awaited<ReturnType<ManagedOAuthCaller>>) => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); f.action('run').click();
    expect(f.panel.hasInFlightWork()).toBe(true); expect(f.panel.hasDraft()).toBe(true);
    f.action('close').click(); expect(f.panel.hasInFlightWork()).toBe(false); expect(f.panel.hasDraft()).toBe(false);
    release({ action: 'authentication_access_run', verification: f.done }); await f.panel.whenLoaded();
    expect(f.root.textContent).toBe(''); expect(f.panel.hasInFlightWork()).toBe(false); f.panel.dispose();
  });
  it('rejects malformed resumed write evidence before displaying it as a passed operation', async () => {
    const f = fixture(); const selected: AuthenticationAccessSelection = { kind: 'renewal', id: 'renewal-12345678-1234-4123-8123-123456789abc' };
    f.plan.selection = selected; const checking = receipt(selected); checking.status = 'checking'; delete checking.finished_at;
    Object.assign(checking.results[0]!.checks[0]!, { kind: ['write_permissions'] }); f.plan.running = checking;
    try {
      f.panel.open(selected); await f.panel.whenLoaded();
      expect(f.root.textContent).toContain('Access checks could not be prepared');
      expect(f.root.textContent).not.toContain('Sending, editing and other writes: Passed');
    } finally { f.panel.dispose(); }
  });
  it('resumes a renewal-related access job from the local preview without starting another read', async () => {
    vi.useFakeTimers(); const f = fixture(); const selected: AuthenticationAccessSelection = { kind: 'renewal', id: 'renewal-12345678-1234-4123-8123-123456789abc' };
    f.plan.selection = selected; const checking = receipt(selected); checking.status = 'checking'; delete checking.finished_at;
    checking.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }]; f.plan.running = checking;
    f.panel.open(selected); await f.panel.whenLoaded();
    expect(f.call.mock.calls.map(([r]) => r.action)).toEqual(['authentication_access_preview', 'authentication_access_retire']);
    expect(f.root.textContent).toContain('Access checks are running in the background'); expect(f.root.textContent).toContain('excluded or unavailable');
    expect(f.root.querySelector('[data-authentication-access-action="run"]')).toBeNull(); expect(f.panel.hasDraft()).toBe(false);
    f.done.selection = selected; await vi.advanceTimersByTimeAsync(1500);
    expect(f.call).toHaveBeenLastCalledWith({ action: 'authentication_access_status', id: checking.id });
    expect(f.root.textContent).toContain('Protected API read: Passed'); f.panel.dispose();
  });
  it('clears the standalone route busy state when a pending local preview is closed', async () => {
    const f = fixture(); let release!: (value: Awaited<ReturnType<ManagedOAuthCaller>>) => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); f.panel.open(selection);
    expect(f.panel.busy()).toBe(true); f.action('close').click(); expect(f.panel.busy()).toBe(false); expect(f.panel.hasDraft()).toBe(false);
    release({ action: 'authentication_access_preview', preview: f.plan }); await f.panel.whenLoaded();
    expect(f.root.textContent).toBe(''); expect(f.call).toHaveBeenLastCalledWith({ action: 'authentication_access_retire', review_id: f.plan.id }); f.panel.dispose();
  });
  it('retires reviews on close, disposal and late replies and lets a stale start open a new review', async () => {
    const f = fixture(); f.panel.open(selection); await f.panel.whenLoaded(); f.action('close').click();
    expect(f.call).toHaveBeenLastCalledWith({ action: 'authentication_access_retire', review_id: f.plan.id });
    f.panel.open(selection); await f.panel.whenLoaded(); f.call.mockRejectedValueOnce(new Error('stale review')); f.action('run').click(); await f.panel.whenLoaded();
    f.action('restart-review').click(); await f.panel.whenLoaded(); expect(f.call.mock.calls.filter(([a]) => a.action === 'authentication_access_preview')).toHaveLength(3);
    f.panel.dispose(); expect(f.call).toHaveBeenLastCalledWith({ action: 'authentication_access_retire', review_id: f.plan.id });
  });
  it('keeps focus outside the panel when a delayed review finishes', async () => {
    const f = fixture(); let release!: (value: Awaited<ReturnType<ManagedOAuthCaller>>) => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); f.panel.open(selection);
    const outside = f.doc.createElement('button'); outside.focus();
    release({ action: 'authentication_access_preview', preview: f.plan }); await f.panel.whenLoaded();
    expect(f.doc.activeElement).toBe(outside); f.panel.dispose();
  });
  it('previews locally and sends only the owner-reviewed resource when Run checks is selected', async () => {
    const f = fixture(); expect(f.call).not.toHaveBeenCalled(); f.panel.open(selection); await f.panel.whenLoaded();
    expect(f.call).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_preview', selection }); expect(f.root.textContent).toContain('Work <account>');
    const input = f.root.querySelector('[data-authentication-access-url="' + 'd'.repeat(64) + '"]')!;
    input.value = 'https://vendor.test/v1/chosen'; input.fire('input'); f.action('run').click(); await f.panel.whenLoaded();
    expect(f.call.mock.calls[1]![0]).toMatchObject({ action: 'authentication_access_run', choices: [{ target_id: 'd'.repeat(64), url: input.value }] });
    expect(f.root.textContent).toContain('Protected API read: Passed'); expect(f.root.textContent).toContain('Sending, editing and other writes: Unconfirmed');
    expect(f.root.textContent).toContain('Daily import'); expect(f.root.textContent).toContain('Workflow execution unconfirmed'); f.panel.dispose();
  });
  it('uses an explicit file picker and never chooses a sample or reads bytes while reviewing', async () => {
    const f = fixture(); f.plan.targets = [{ id: 'd'.repeat(64), target: { kind: 'file_source', source_id: 'google.work.file' }, label: 'Work files', authentication_revision: 'e'.repeat(64),
      check: 'file_metadata', file_connection: { name: 'work', updated_at: 2 } }];
    f.panel.open(selection); await f.panel.whenLoaded(); expect(f.call).toHaveBeenCalledTimes(1);
    f.action('file-' + 'd'.repeat(64)).click(); await tick(); expect(f.root.textContent).toContain('using the saved authentication');
    expect(f.call.mock.calls.map(([args]) => args.action)).toEqual(['authentication_access_preview', 'file_authentication_files']);
    f.root.querySelector('[data-file-download-picker-choice="chosen"]')!.fire('change');
    f.root.querySelector('[data-file-download-picker-action="verify"]')!.click(); await tick();
    f.action('run').click(); await f.panel.whenLoaded();
    expect(f.call.mock.calls.at(-1)![0]).toMatchObject({ action: 'authentication_access_run', choices: [{ target_id: 'd'.repeat(64), file_id: 'chosen' }] }); f.panel.dispose();
  });
  it('preserves a retry identity after a lost start reply and ignores detached controls', async () => {
    const f = fixture(); f.panel.open(selection); await f.panel.whenLoaded(); const oldRun = f.action('run');
    f.call.mockRejectedValueOnce(new Error('never-export-secret')); oldRun.click(); await f.panel.whenLoaded();
    expect(f.root.textContent).toContain('receipt was not received'); expect(f.root.textContent).not.toContain('never-export');
    oldRun.click(); expect(f.call).toHaveBeenCalledTimes(2);
    f.action('run').click(); await f.panel.whenLoaded(); expect(f.call.mock.calls[1]![0]).toEqual(f.call.mock.calls[2]![0]); f.panel.dispose();
  });
  it('polls an existing background receipt, retains results on refresh failure and stops polling on disposal', async () => {
    vi.useFakeTimers(); const f = fixture(); const checking = receipt(); checking.status = 'checking'; delete checking.finished_at;
    checking.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }];
    f.call.mockRejectedValueOnce(new Error('private-provider-body')); f.panel.open(selection, checking);
    await vi.advanceTimersByTimeAsync(1500); expect(f.root.textContent).toContain('Earlier results are still shown'); expect(f.root.textContent).not.toContain('private-provider-body');
    expect(f.root.textContent).toContain('Waiting for this check'); f.action('status').click(); await f.panel.whenLoaded();
    expect(f.root.textContent).toContain('Protected API read: Passed'); expect(f.updated).toHaveBeenCalled();
    const count = f.call.mock.calls.length; f.panel.dispose(); await vi.advanceTimersByTimeAsync(5000); expect(f.call).toHaveBeenCalledTimes(count);
  });
  it('labels superseded and locked-vault results without presenting them as current proof', () => {
    const f = fixture(); f.done.results[0]!.current = 'no'; f.panel.open(selection, f.done);
    expect(f.root.textContent).toContain('Superseded'); expect(f.root.textContent).toContain('(historical result)');
    f.done.results[0]!.current = 'unknown'; f.panel.open(selection, f.done); expect(f.root.textContent).toContain('Current authentication could not be compared'); f.panel.dispose();
  });
  it('rejects a mismatched preview and offers a retry without showing raw errors', async () => {
    const f = fixture(); f.plan.selection = { kind: 'group', id: 'f'.repeat(64) }; f.panel.open(selection); await f.panel.whenLoaded();
    expect(f.root.textContent).toContain('could not be prepared'); expect(f.root.querySelector('[data-authentication-access-action="run"]')).toBeNull();
    expect(f.action('retry-review')).toBeDefined(); f.panel.dispose();
  });
  it('does not render a late review after switching selections or closing the panel', async () => {
    const f = fixture(); let release!: (value: Awaited<ReturnType<ManagedOAuthCaller>>) => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); f.panel.open(selection);
    const waiting = f.panel.whenLoaded(); f.action('close').click(); release({ action: 'authentication_access_preview', preview: f.plan }); await waiting;
    expect(f.call).toHaveBeenLastCalledWith({ action: 'authentication_access_retire', review_id: f.plan.id });
    expect(f.root.textContent).toBe(''); f.panel.dispose();
  });
  it('exposes Verify access in applied repair results and in the authentication worklist without starting checks', async () => {
    const f = fixture(); const repairId = 'repair-' + 'a'.repeat(64); const history = createAuthenticationIncidentPanel({ document: f.doc, verify: f.call, scope: { kind: 'all' },
      call: async query => ({ scope: query.scope, retention_days: 90, observed_at: 1000, incidents: [], order: [repairId], repairs: [{ id: repairId,
        action: 'reauthorize', status: 'applied', started_at: 800, finished_at: 900, targets: [{ kind: 'connection', name: 'work' }], targets_truncated: false, incidents: [], incidents_truncated: false }] }) });
    history.mount(f.root as unknown as HTMLElement); await history.whenLoaded(); expect(f.root.querySelector('[data-incident-verify-access="' + repairId + '"]')).not.toBeNull();
    expect(f.call).not.toHaveBeenCalled(); history.dispose();
    const worklist = createReconnectWorklistPanel({ document: f.doc, verify: f.call, repairs: async () => ({ observed_at: 1000, unavailable: [], groups: [{
      id: selection.id, kind: 'account', label: 'Work', authentication: 'direct_oauth', connection_names: ['work'], targets: [{ kind: 'connection', name: 'work' }],
      issues: [{ id: 'b'.repeat(64), code: 'credential_rejected', message: 'Access failed' }], uses: [], usage_available: true }] }) });
    worklist.mount(f.root as unknown as HTMLElement); await worklist.whenLoaded();
    expect(f.root.querySelector('[data-reconnect-worklist-action="verify-' + selection.id + '"]')).not.toBeNull(); expect(f.call).not.toHaveBeenCalled(); worklist.dispose(); f.panel.dispose();
  });
});
