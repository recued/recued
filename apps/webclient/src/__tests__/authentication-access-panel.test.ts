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
const fixture = (savedCheck?: Parameters<typeof createAuthenticationAccessPanel>[0]['savedCheck']) => {
  const { root, doc } = dom(); const plan = preview(); const done = receipt();
  const call = vi.fn<ManagedOAuthCaller>(async args => {
    if (args.action === 'authentication_access_retire') return { action: args.action };
    if (args.action === 'authentication_access_preview') return { action: args.action, preview: plan };
    if (args.action === 'authentication_access_run' || args.action === 'authentication_access_status') return { action: args.action, verification: done };
    if (args.action === 'file_authentication_files') return { action: args.action, choices: { source_id: 'google.work.file', connection_name: 'work', updated_at: 2,
      available: true, max_bytes: FILE_DOWNLOAD_VERIFICATION_MAX_BYTES, files: [{ remote_id: 'chosen', filename: 'Report.pdf', output_filename: 'Report.pdf', mode: 'download', mime_type: 'application/pdf' }] } };
    throw new Error('Unexpected action ' + args.action);
  });
  const updated = vi.fn(); const panel = createAuthenticationAccessPanel({ document: doc, call, updated, ...(savedCheck ? { savedCheck } : {}) }); panel.mount(root as unknown as HTMLElement);
  const action = (id: string) => { const button = root.querySelector('[data-authentication-access-action="' + id + '"]'); if (!button) throw new Error('Missing action ' + id); return button; };
  return { root, doc, panel, call, updated, plan, done, action };
};

describe('owner Verify access review and saved results', () => {
  it.each(['yes', 'no', 'unknown'] as const)('opens a passed receipt whose authentication is %s without preparing or running checks', async current => {
    const saved = vi.fn(); const f = fixture(saved); f.done.results[0]!.current = current; const before = structuredClone(f.done);
    await f.panel.openCheck({ verification_id: f.done.id, view: 'result' });
    expect(f.call).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_status', id: f.done.id });
    expect(f.root.textContent).toContain('Protected API read: Passed'); expect(f.root.querySelector('[data-authentication-access-action="run"]')).toBeNull();
    expect(f.root.querySelector('[data-authentication-access-action="recheck"]')).toBeNull(); expect(f.panel.hasDraft()).toBe(false); expect(f.panel.hasInFlightWork()).toBe(false);
    expect(f.root.querySelector('[data-authentication-access-page]')!.getAttribute('href')).toBe('#connections/others/access-check/' + f.done.id);
    expect(f.action('status').textContent).toBe('Refresh saved check'); expect(f.doc.activeElement).toBe(f.action('status')); expect(saved).not.toHaveBeenCalled();
    f.action('status').click(); await f.panel.whenLoaded(); expect(f.call).toHaveBeenCalledTimes(2); expect(f.done).toEqual(before); f.panel.dispose();
  });
  it('keeps a passed resource link focused without offering other failed resources as its own recheck', async () => {
    const f = fixture(); const target = f.done.results[0]!;
    f.done.results.push({ ...structuredClone(target), id: 'f'.repeat(64), target: { kind: 'connection', name: 'other' }, label: 'Other account', checks: [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }] });
    await f.panel.openCheck({ verification_id: f.done.id, target_id: target.id, view: 'result' });
    expect(f.root.textContent).not.toContain('Other account'); expect(f.root.querySelector('[data-authentication-access-action="review-returned"]')).toBeNull();
    expect(f.root.querySelector('[data-authentication-access-page]')!.getAttribute('href')).toContain('/target/' + target.id);
    expect(f.root.querySelector('[data-authentication-access-all]')!.getAttribute('href')).toBe('#connections/others/access-check/' + f.done.id); f.panel.dispose();
  });
  it('reopens a completed comparison from a saved-status address using only exact local status reads', async () => {
    const f = fixture(); const original = receipt(); original.results[0]!.authentication_revision = 'f'.repeat(64); original.results[0]!.current = 'no';
    original.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    f.done.id = 'verify-22345678-1234-4123-8123-123456789abc'; f.done.selection = { kind: 'verification', id: original.id }; f.done.started_at = 1200; f.done.finished_at = 1300;
    f.call.mockImplementation(async request => {
      if (request.action !== 'authentication_access_status') throw Error('Unexpected action');
      return { action: request.action, verification: request.id === original.id ? original : f.done };
    });
    await f.panel.openCheck({ verification_id: f.done.id, view: 'comparison', target_id: f.done.results[0]!.id });
    expect(f.call.mock.calls.map(([r]) => r.action === 'authentication_access_status' && r.id)).toEqual([f.done.id, f.done.id, original.id]);
    expect(f.root.querySelector('[data-access-comparison]')).not.toBeNull(); expect(f.root.textContent).toContain('Protected API read: Passed');
    expect(f.root.querySelector('[data-access-comparison-page]')!.getAttribute('href')).toBe('#connections/others/access-check/' + f.done.id + '/target/' + f.done.results[0]!.id + '/compare');
    expect(f.panel.hasDraft()).toBe(false); expect(f.updated).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['outside', 'Close'] as const)('preserves focus moved to %s while a bookmarked comparison reads its initial status', async choice => {
    const f = fixture(); const original = receipt(); original.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    f.done.id = 'verify-22345678-1234-4123-8123-123456789abc'; f.done.selection = { kind: 'verification', id: original.id }; f.done.started_at = 1200; f.done.finished_at = 1300;
    f.call.mockImplementation(async request => {
      if (request.action !== 'authentication_access_status') throw Error('Unexpected action');
      return { action: request.action, verification: request.id === original.id ? original : f.done };
    });
    let release!: () => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ action: 'authentication_access_status', verification: f.done }); }));
    const pending = f.panel.openCheck({ verification_id: f.done.id, view: 'comparison' });
    const outside = f.doc.createElement('a'); (choice === 'Close' ? f.action('close') : outside).focus(); release(); await pending;
    expect(f.root.querySelector('[data-access-comparison]')).not.toBeNull();
    expect(f.doc.activeElement).toBe(choice === 'Close' ? f.action('close') : outside); f.panel.dispose();
  });
  it('keeps the newer saved result visible when its comparison source is no longer retained', async () => {
    const f = fixture(); const sourceId = 'verify-22345678-1234-4123-8123-123456789abc'; f.done.selection = { kind: 'verification', id: sourceId };
    f.call.mockImplementation(async request => {
      if (request.action !== 'authentication_access_status') throw Error('Unexpected action');
      if (request.id === sourceId) throw Error('private source details'); return { action: request.action, verification: f.done };
    });
    await f.panel.openCheck({ verification_id: f.done.id, view: 'comparison' });
    expect(f.root.textContent).toContain('may no longer be retained'); expect(f.root.textContent).toContain('Protected API read: Passed');
    expect(f.root.textContent).not.toContain('private source details'); expect(f.root.querySelector('[data-access-comparison]')).toBeNull();
    expect(f.root.querySelector('[data-authentication-access-page]')).not.toBeNull(); f.panel.dispose();
  });
  it('shows an ordinary saved result when its address requests an unavailable comparison', async () => {
    const f = fixture(); await f.panel.openCheck({ verification_id: f.done.id, view: 'comparison' });
    expect(f.root.textContent).toContain('Comparisons are available for completed rechecks'); expect(f.root.textContent).toContain('Protected API read: Passed');
    expect(f.call).toHaveBeenCalledTimes(1); expect(f.root.querySelector('[data-access-comparison]')).toBeNull(); f.panel.dispose();
  });
  it.each(['wrong receipt', 'missing target'] as const)('refuses a saved-check page for a %s without replacing it with another result', async mode => {
    const f = fixture(); const reference = { verification_id: f.done.id, view: 'result' as const, target_id: f.done.results[0]!.id };
    if (mode === 'wrong receipt') f.done.id = 'verify-22345678-1234-4123-8123-123456789abc'; else reference.target_id = 'f'.repeat(64);
    await f.panel.openCheck(reference); expect(f.root.textContent).toContain('saved check is unavailable'); expect(f.root.querySelector('[data-authentication-access-result]')).toBeNull();
    expect(f.call).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_status', id: reference.verification_id }); f.panel.dispose();
  });
  it('reads progress for the linked running job and opens its comparison once it completes, without starting another job', async () => {
    vi.useFakeTimers(); const f = fixture(); const original = receipt(); original.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    f.done.id = 'verify-22345678-1234-4123-8123-123456789abc'; f.done.selection = { kind: 'verification', id: original.id }; f.done.started_at = 1200; f.done.finished_at = 1300;
    const checking = structuredClone(f.done); checking.status = 'checking'; delete checking.finished_at; checking.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }];
    f.call.mockImplementation(async request => { if (request.action !== 'authentication_access_status') throw Error('Unexpected action'); return { action: request.action, verification: request.id === original.id ? original : f.done }; });
    f.call.mockResolvedValueOnce({ action: 'authentication_access_status', verification: checking });
    await f.panel.openCheck({ verification_id: f.done.id, view: 'comparison' }); expect(f.root.textContent).toContain('still running'); expect(f.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500); expect(f.root.querySelector('[data-access-comparison]')).not.toBeNull();
    expect(f.call.mock.calls.every(([r]) => r.action === 'authentication_access_status')).toBe(true); expect(f.call).toHaveBeenCalledTimes(4); f.panel.dispose();
  });
  it('drops a late saved-check reply after Close and does not open its requested comparison', async () => {
    const f = fixture(); let release!: (reply: Awaited<ReturnType<ManagedOAuthCaller>>) => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); const pending = f.panel.openCheck({ verification_id: f.done.id, view: 'comparison' });
    expect(f.panel.hasDraft()).toBe(false); expect(f.panel.hasInFlightWork()).toBe(false); f.action('close').click();
    release({ action: 'authentication_access_status', verification: f.done }); await pending; expect(f.root.textContent).toBe(''); expect(f.call).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it('keeps the prior completed evidence when a saved-status refresh changes its recorded checks', async () => {
    const f = fixture(); await f.panel.openCheck({ verification_id: f.done.id, view: 'result' });
    f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' }; f.action('status').click(); await f.panel.whenLoaded();
    expect(f.root.textContent).toContain('Earlier results are still shown'); expect(f.root.textContent).toContain('Protected API read: Passed');
    expect(f.updated).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it('publishes a saved-result destination only after an accepted start receipt and clears the in-flight guard first', async () => {
    let inFlightAtPublish = true; const saved = vi.fn(() => { inFlightAtPublish = f.panel.hasInFlightWork(); }); const f = fixture(saved);
    f.panel.open(selection); await f.panel.whenLoaded(); expect(saved).not.toHaveBeenCalled();
    f.call.mockRejectedValueOnce(Error('lost receipt')); f.action('run').click(); await f.panel.whenLoaded(); expect(saved).not.toHaveBeenCalled();
    f.action('run').click(); await f.panel.whenLoaded(); expect(saved).toHaveBeenCalledExactlyOnceWith({ verification_id: f.done.id, view: 'result' });
    expect(inFlightAtPublish).toBe(false); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('compares a completed recheck explicitly using local status and lets Close cancel a pending comparison', async () => {
    const f = fixture(); const original = receipt(); original.results[0]!.current = 'no'; original.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    f.done.id = 'verify-22345678-1234-4123-8123-123456789abc'; f.done.selection = { kind: 'verification', id: original.id }; f.done.started_at = 1200; f.done.finished_at = 1300;
    f.call.mockImplementation(async request => {
      if (request.action !== 'authentication_access_status') throw Error('Unexpected action');
      return { action: request.action, verification: request.id === original.id ? original : f.done };
    });
    f.panel.open(f.done.selection, f.done); expect(f.call).not.toHaveBeenCalled();
    f.root.querySelector('[data-access-compare]')!.click(); await f.panel.whenLoaded();
    expect(f.root.querySelector('[data-access-comparison]')).not.toBeNull(); expect(f.call).toHaveBeenCalledTimes(2); expect(f.updated).not.toHaveBeenCalled();
    let release!: (reply: Awaited<ReturnType<ManagedOAuthCaller>>) => void; f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.root.querySelector('[data-access-compare]')!.click(); const pending = f.panel.whenLoaded();
    expect(f.panel.busy()).toBe(true); expect(f.panel.hasInFlightWork()).toBe(false); expect(f.panel.hasDraft()).toBe(false);
    f.action('close').click(); expect(f.panel.busy()).toBe(false); release({ action: 'authentication_access_status', verification: f.done }); await pending;
    expect(f.root.textContent).toBe(''); expect(f.call.mock.calls.every(([r]) => r.action === 'authentication_access_status')).toBe(true); f.panel.dispose();
  });
  it.each(['no', 'unknown'] as const)('returns to the exact historical result after authentication is %s without preparing or running checks', async current => {
    const f = fixture(); f.done.results[0]!.current = current; f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    f.done.results.push({ ...structuredClone(f.done.results[0]!), id: 'f'.repeat(64), target: { kind: 'connection', name: 'other' }, label: 'Other API' });
    const before = structuredClone(f.done); await f.panel.openResult({ verification_id: f.done.id, target_id: f.done.results[0]!.id });
    expect(f.root.textContent).toContain('Work API'); expect(f.root.textContent).not.toContain('Other API');
    expect(f.root.textContent).toContain('does not confirm that a repair succeeded'); expect(f.root.textContent).toContain(current === 'no' ? 'Superseded' : 'could not be compared');
    expect(f.call).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_status', id: f.done.id }); expect(f.panel.hasDraft()).toBe(false);
    expect(f.root.querySelector('[data-authentication-access-action="run"]')).toBeNull(); expect(f.doc.activeElement).toBe(f.action('review-returned'));
    expect(f.done).toEqual(before); expect(f.updated).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it('reviews fresh authentication with only the originating resource selected, then runs only explicitly selected reads', async () => {
    const f = fixture(); f.done.results[0]!.current = 'no'; f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    f.done.results.push({ ...structuredClone(f.done.results[0]!), id: 'f'.repeat(64), target: { kind: 'connection', name: 'other' }, label: 'Other API' });
    f.plan.selection = { kind: 'verification', id: f.done.id }; f.plan.targets[0]!.authentication_revision = 'a'.repeat(64);
    f.plan.targets[0]!.default_url = 'https://vendor.test/v1/current';
    f.plan.targets.push({ ...f.plan.targets[0]!, id: 'f'.repeat(64), target: { kind: 'connection', name: 'other' }, label: 'Other API' });
    const original = structuredClone(f.done); const normal = f.call.getMockImplementation()!;
    f.call.mockImplementation(async args => {
      if (args.action !== 'authentication_access_run') return normal(args);
      return { action: args.action, verification: { ...structuredClone(original), id: 'verify-22345678-1234-4123-8123-123456789abc', selection: f.plan.selection,
        results: original.results.filter(r => args.target_ids!.includes(r.id)).map(r => ({ ...r, authentication_revision: 'a'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] })) } };
    });
    await f.panel.openResult({ verification_id: f.done.id, target_id: f.done.results[0]!.id }); f.action('review-returned').click(); await f.panel.whenLoaded();
    expect(f.call.mock.calls.map(([r]) => r.action)).toEqual(['authentication_access_status', 'authentication_access_preview']);
    expect(f.root.textContent).toContain('1 of 2 targets selected'); expect(f.panel.hasDraft()).toBe(true);
    expect(f.root.querySelector('[data-authentication-access-target="' + 'd'.repeat(64) + '"]')!.checked).toBe(true);
    expect(f.root.querySelector('[data-authentication-access-target="' + 'f'.repeat(64) + '"]')!.checked).toBe(false);
    expect(f.doc.activeElement).toBe(f.action('run'));
    const url = f.root.querySelector('[data-authentication-access-url="' + 'd'.repeat(64) + '"]')!; expect(url.value).toBe('https://vendor.test/v1/current');
    url.value = 'https://vendor.test/v1/fresh'; url.fire('input'); f.action('run').click(); await f.panel.whenLoaded();
    expect(f.call.mock.calls.find(([r]) => r.action === 'authentication_access_run')![0]).toMatchObject({
      target_ids: ['d'.repeat(64)], choices: [{ target_id: 'd'.repeat(64), url: 'https://vendor.test/v1/fresh' }] });
    expect(f.root.textContent).toContain('Protected API read: Passed'); expect(f.done).toEqual(original); f.panel.dispose();
  });
  it.each(['missing', 'changed target'] as const)('refuses a fresh review whose originating resource is %s', async change => {
    const f = fixture(); f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    f.plan.selection = { kind: 'verification', id: f.done.id };
    if (change === 'missing') f.plan.targets[0]!.id = 'f'.repeat(64); else f.plan.targets[0]!.target = { kind: 'connection', name: 'different' };
    await f.panel.openResult({ verification_id: f.done.id, target_id: f.done.results[0]!.id }); f.action('review-returned').click(); await f.panel.whenLoaded();
    expect(f.root.textContent).toContain('Access checks could not be prepared'); expect(f.root.querySelector('[data-authentication-access-action="run"]')).toBeNull();
    expect(f.call.mock.calls.map(([r]) => r.action)).toEqual(['authentication_access_status', 'authentication_access_preview', 'authentication_access_retire']); f.panel.dispose();
  });
  it('requires a fresh file choice after returning from repair instead of carrying a previous picker selection', async () => {
    const f = fixture(); const target = f.plan.targets[0]!;
    target.target = { kind: 'file_source', source_id: 'google.work.file' }; target.check = 'file_metadata'; delete target.base_url; delete target.default_url;
    target.file_connection = { name: 'work', updated_at: 2 };
    f.done.results[0]!.target = structuredClone(target.target); f.done.results[0]!.checks = [{ kind: 'file_metadata', status: 'passed' }, { kind: 'file_download', status: 'unconfirmed', reason: 'resource_required' }];
    f.panel.open(selection); await f.panel.whenLoaded(); f.action('file-' + target.id).click(); await tick();
    const file = f.root.querySelector('[data-file-download-picker-choice="chosen"]')!; file.checked = true; file.fire('change');
    f.root.querySelector('[data-file-download-picker-action="verify"]')!.click(); await tick(); expect(f.action('file-' + target.id).textContent).toBe('Change selected file');
    await f.panel.openResult({ verification_id: f.done.id, target_id: target.id }); f.plan.selection = { kind: 'verification', id: f.done.id };
    const reads = f.call.mock.calls.length; f.action('review-returned').click(); await f.panel.whenLoaded();
    expect(f.action('file-' + target.id).textContent).toBe('Choose a file');
    expect(f.call.mock.calls.slice(reads).map(([r]) => r.action)).toEqual(['authentication_access_preview']); f.panel.dispose();
  });
  it.each(['wrong source', 'missing target', 'passed', 'running'] as const)('does not turn a %s saved return into a new check', async mode => {
    const f = fixture(); f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    const reference = { verification_id: f.done.id, target_id: f.done.results[0]!.id };
    if (mode === 'wrong source') f.done.id = 'verify-22345678-1234-4123-8123-123456789abc';
    if (mode === 'missing target') reference.target_id = 'f'.repeat(64);
    if (mode === 'passed') f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'passed' };
    if (mode === 'running') { f.done.status = 'checking'; delete f.done.finished_at; f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }; }
    await f.panel.openResult(reference); expect(f.root.textContent).toContain('saved result is unavailable');
    expect(f.call).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_status', id: reference.verification_id });
    expect(f.root.querySelector('[data-authentication-access-action="review-returned"]')).toBeNull(); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('retries an unavailable saved return locally and drops late replies after Close', async () => {
    const f = fixture(); f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    const reference = { verification_id: f.done.id, target_id: f.done.results[0]!.id };
    f.call.mockRejectedValueOnce(Error('private-token')); await f.panel.openResult(reference); expect(f.root.textContent).not.toContain('private-token');
    f.action('retry-review').click(); await f.panel.whenLoaded(); expect(f.call.mock.calls.map(([r]) => r.action)).toEqual(['authentication_access_status', 'authentication_access_status']);
    let release!: (reply: Awaited<ReturnType<ManagedOAuthCaller>>) => void; f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.panel.openResult(reference); expect(f.panel.hasInFlightWork()).toBe(false); f.action('close').click();
    release({ action: 'authentication_access_status', verification: f.done }); await pending; expect(f.root.textContent).toBe(''); f.panel.dispose();
  });
  it.each(['success', 'failure'] as const)('keeps focus outside the panel when a delayed saved return ends in %s', async outcome => {
    const f = fixture(); f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    let release!: (reply: Awaited<ReturnType<ManagedOAuthCaller>>) => void; let reject!: (reason: Error) => void;
    f.call.mockImplementationOnce(() => new Promise((resolve, fail) => { release = resolve; reject = fail; }));
    const pending = f.panel.openResult({ verification_id: f.done.id, target_id: f.done.results[0]!.id });
    const outside = f.doc.createElement('button'); outside.focus();
    if (outcome === 'success') release({ action: 'authentication_access_status', verification: f.done }); else reject(Error('private response'));
    await pending; expect(f.doc.activeElement).toBe(outside); expect(f.call).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it.each(['success', 'failure'] as const)('keeps the chosen Close control focused when a delayed saved return ends in %s', async outcome => {
    const f = fixture(); f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    let release!: (reply: Awaited<ReturnType<ManagedOAuthCaller>>) => void; let reject!: (reason: Error) => void;
    f.call.mockImplementationOnce(() => new Promise((resolve, fail) => { release = resolve; reject = fail; }));
    const pending = f.panel.openResult({ verification_id: f.done.id, target_id: f.done.results[0]!.id }); f.action('close').focus();
    if (outcome === 'success') release({ action: 'authentication_access_status', verification: f.done }); else reject(Error('private response'));
    await pending; expect(f.doc.activeElement).toBe(f.action('close')); expect(f.call).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it.each(['replace', 'dispose'] as const)('ignores a delayed saved return after %s', async action => {
    const f = fixture(); f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    let release!: (reply: Awaited<ReturnType<ManagedOAuthCaller>>) => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.panel.openResult({ verification_id: f.done.id, target_id: f.done.results[0]!.id });
    if (action === 'replace') { f.panel.open(selection); await f.panel.whenLoaded(); } else f.panel.dispose();
    const before = f.root.textContent; const focused = f.doc.activeElement;
    release({ action: 'authentication_access_status', verification: f.done }); await pending;
    expect(f.root.textContent).toBe(before); expect(f.doc.activeElement).toBe(focused);
    expect(f.root.querySelector('[data-authentication-access-action="review-returned"]')).toBeNull(); f.panel.dispose();
  });
  it.each([true, false])('resumes a source-related running job only when it includes the returned resource: %s', async includesOrigin => {
    const f = fixture(); f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    const source = structuredClone(f.done); const origin = source.results[0]!;
    f.plan.selection = { kind: 'verification', id: source.id };
    const running = receipt(f.plan.selection); running.id = 'verify-22345678-1234-4123-8123-123456789abc'; running.status = 'checking'; delete running.finished_at;
    running.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }];
    if (!includesOrigin) { f.plan.targets[0]!.id = 'f'.repeat(64); f.plan.targets[0]!.target = { kind: 'connection', name: 'other' };
      running.results[0]!.id = 'f'.repeat(64); running.results[0]!.target = { kind: 'connection', name: 'other' }; }
    f.plan.running = running;
    await f.panel.openResult({ verification_id: source.id, target_id: origin.id }); f.action('review-returned').click(); await f.panel.whenLoaded();
    expect(f.call.mock.calls.map(([r]) => r.action)).toEqual(['authentication_access_status', 'authentication_access_preview', 'authentication_access_retire']);
    expect(f.root.querySelector('[data-authentication-access-action="run"]')).toBeNull();
    expect(f.root.textContent).toContain(includesOrigin ? 'Access checks are running in the background' : 'Access checks could not be prepared');
    expect(f.panel.hasDraft()).toBe(false); expect(f.done).toEqual(source); f.panel.dispose();
  });
  it('does not keep the return resource selected when a different ordinary review is opened', async () => {
    const f = fixture(); f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    await f.panel.openResult({ verification_id: f.done.id, target_id: f.done.results[0]!.id });
    f.panel.open(selection); await f.panel.whenLoaded(); expect(f.root.textContent).not.toContain('Showing the resource');
    expect(f.action('run')).toBeDefined(); expect(f.plan.selection).toEqual(selection); f.panel.dispose();
  });
  it('opens a fresh authentication review from a failed saved check without starting new vendor work', async () => {
    const f = fixture(); const location = { hash: '' }; Object.assign(f.doc, { defaultView: { location } });
    f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    f.panel.open(selection, f.done); expect(f.call).not.toHaveBeenCalled();
    f.root.querySelector('[data-access-repair-shortcut]')!.click(); await f.panel.whenLoaded();
    expect(location.hash).toBe('#connections/others/review-access/api/work/from-access/' + f.done.id + '/' + f.done.results[0]!.id);
    expect(f.call).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_status', id: f.done.id }); f.panel.dispose();
  });
  it('lets Close cancel a pending authentication shortcut without a late navigation', async () => {
    const f = fixture(); const location = { hash: '' }; Object.assign(f.doc, { defaultView: { location } });
    f.done.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    let release!: (reply: Awaited<ReturnType<ManagedOAuthCaller>>) => void; f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.panel.open(selection, f.done); f.root.querySelector('[data-access-repair-shortcut]')!.click(); const pending = f.panel.whenLoaded();
    expect(f.panel.busy()).toBe(true); expect(f.panel.hasInFlightWork()).toBe(false); f.action('close').click();
    release({ action: 'authentication_access_status', verification: f.done }); await pending;
    expect(location.hash).toBe(''); expect(f.root.textContent).toBe(''); f.panel.dispose();
  });
  it('refuses a resumed receipt whose target differs from its status snapshot', async () => {
    const f = fixture(); const checking = receipt(); checking.status = 'checking'; delete checking.finished_at;
    checking.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }]; checking.results[0]!.target = { kind: 'connection', name: 'other' };
    f.plan.running = checking; f.panel.open(selection); await f.panel.whenLoaded();
    expect(f.root.textContent).toContain('could not be prepared'); expect(f.root.textContent).not.toContain('Access checks are running');
    expect(f.root.querySelector('[data-authentication-access-action="run"]')).toBeNull(); f.panel.dispose();
  });
  it.each(['different account', 'extra target', 'different revision'] as const)('rejects a recheck start receipt for a %s', async mismatch => {
    const f = fixture(); const selected: AuthenticationAccessSelection = { kind: 'verification', id: f.done.id }; f.plan.selection = selected; f.done.selection = selected;
    if (mismatch === 'different account') f.done.results[0]!.target = { kind: 'connection', name: 'other' };
    if (mismatch === 'extra target') f.done.results.push({ ...f.done.results[0]!, id: 'f'.repeat(64), target: { kind: 'connection', name: 'other' } });
    if (mismatch === 'different revision') f.done.results[0]!.authentication_revision = 'f'.repeat(64);
    f.panel.open(selected); await f.panel.whenLoaded(); f.action('run').click(); await f.panel.whenLoaded();
    expect(f.root.textContent).toContain('receipt was not received'); expect(f.root.textContent).not.toContain('Protected API read: Passed');
    expect(f.panel.hasDraft()).toBe(true); expect(f.updated).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['different account', 'extra target', 'different revision'] as const)('keeps the saved result after a %s appears in status', async mismatch => {
    const f = fixture(); const checking = receipt(); checking.status = 'checking'; delete checking.finished_at;
    checking.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }];
    if (mismatch === 'different account') f.done.results[0]!.target = { kind: 'connection', name: 'other' };
    if (mismatch === 'extra target') f.done.results.push({ ...f.done.results[0]!, id: 'f'.repeat(64), target: { kind: 'connection', name: 'other' } });
    if (mismatch === 'different revision') f.done.results[0]!.authentication_revision = 'f'.repeat(64);
    f.panel.open(selection, checking); f.action('status').click(); await f.panel.whenLoaded();
    expect(f.root.textContent).toContain('Earlier results are still shown'); expect(f.root.textContent).toContain('Waiting for this check');
    expect(f.root.textContent).not.toContain('Protected API read: Passed'); expect(f.updated).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it('opens a fresh targeted review from a saved failure and runs only the selected targets', async () => {
    const f = fixture(); const old = receipt(); old.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' };
    const selected: AuthenticationAccessSelection = { kind: 'verification', id: old.id }; f.plan.selection = selected;
    f.plan.targets.push({ id: 'f'.repeat(64), target: { kind: 'collection', platform: 'mail', slug: 'work' }, label: 'Work Mail', authentication_revision: 'e'.repeat(64), check: 'collection_read' });
    f.done.selection = selected; f.done.id = 'verify-22345678-1234-4123-8123-123456789abc';
    f.done.results = [{ ...old.results[0]!, id: 'f'.repeat(64), target: { kind: 'collection', platform: 'mail', slug: 'work' }, label: 'Work Mail', checks: [{ kind: 'collection_read', status: 'passed' }] }];
    f.panel.open(selection, old); expect(f.call).not.toHaveBeenCalled();
    expect(f.action('recheck').getAttribute('href')).toBe('#connections/others/verify-access/verification/' + old.id);
    f.panel.open(selected); await f.panel.whenLoaded();
    expect(f.call).toHaveBeenCalledWith({ action: 'authentication_access_preview', selection: selected });
    expect(f.call.mock.calls.every(([r]) => r.action !== 'authentication_access_run')).toBe(true);
    expect(f.root.textContent).toContain('Earlier passed results stay in history'); expect(f.root.textContent).toContain('2 of 2 targets selected');
    const checkbox = f.root.querySelector('[data-authentication-access-target="' + 'd'.repeat(64) + '"]')!;
    checkbox.checked = false; checkbox.fire('change'); expect(f.root.textContent).toContain('1 of 2 targets selected'); expect(f.doc.activeElement?.getAttribute('data-authentication-access-action')).toBe('target-' + 'd'.repeat(64));
    f.action('run').click(); await f.panel.whenLoaded();
    expect(f.call).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'authentication_access_run', target_ids: ['f'.repeat(64)], choices: [{ target_id: 'f'.repeat(64) }] }));
    expect(f.root.textContent).toContain('Earlier results remain in history'); expect(old.results[0]!.checks[0]!.status).toBe('failed');
    expect(f.root.querySelector('[data-authentication-access-action="recheck"]')).toBeNull(); f.panel.dispose();
  });
  it('does not offer a recheck for passed reads with unperformed writes, or while checks are running', () => {
    const f = fixture(); f.panel.open(selection, f.done); expect(f.root.querySelector('[data-authentication-access-action="recheck"]')).toBeNull();
    const checking = receipt(); checking.status = 'checking'; delete checking.finished_at; checking.results[0]!.checks[0] = { kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' };
    f.panel.open(selection, checking); expect(f.root.querySelector('[data-authentication-access-action="recheck"]')).toBeNull(); f.panel.dispose();
  });
  it('requires at least one target and freezes the subset and resources after a lost start reply', async () => {
    const f = fixture(); const selected: AuthenticationAccessSelection = { kind: 'verification', id: f.done.id }; f.plan.selection = selected; f.done.selection = selected;
    f.panel.open(selected); await f.panel.whenLoaded();
    let checkbox = f.root.querySelector('[data-authentication-access-target="' + 'd'.repeat(64) + '"]')!;
    checkbox.checked = false; checkbox.fire('change'); expect(f.action('run').disabled).toBe(true); f.action('run').click(); expect(f.call).toHaveBeenCalledTimes(1);
    checkbox = f.root.querySelector('[data-authentication-access-target="' + 'd'.repeat(64) + '"]')!; checkbox.checked = true; checkbox.fire('change');
    f.call.mockRejectedValueOnce(new Error('lost receipt')); f.action('run').click(); await f.panel.whenLoaded();
    checkbox = f.root.querySelector('[data-authentication-access-target="' + 'd'.repeat(64) + '"]')!;
    const input = f.root.querySelector('[data-authentication-access-url="' + 'd'.repeat(64) + '"]')!;
    expect(checkbox.disabled).toBe(true); expect(input.disabled).toBe(true); expect(f.root.textContent).toContain('Retry keeps the same selected targets and resources');
    checkbox.checked = false; checkbox.fire('change'); input.value = 'https://vendor.test/v1/changed'; input.fire('input');
    f.action('run').click(); await f.panel.whenLoaded(); expect(f.call.mock.calls[1]![0]).toEqual(f.call.mock.calls[2]![0]); f.panel.dispose();
  });
  it('offers a recheck entry from history only for completed non-passing reads', async () => {
    const f = fixture(); const failed = receipt(); failed.results[0]!.checks[0] = { kind: 'api_read', status: 'unconfirmed', reason: 'resource_required' };
    const passed = receipt(); passed.id = 'verify-22345678-1234-4123-8123-123456789abc';
    const history = createAuthenticationIncidentPanel({ document: f.doc, verify: f.call, scope: { kind: 'all' }, call: async query => ({ scope: query.scope,
      retention_days: 90, observed_at: 1200, incidents: [], repairs: [], verifications: [failed, passed], order: [failed.id, passed.id] }) });
    history.mount(f.root as unknown as HTMLElement); await history.whenLoaded();
    const link = f.root.querySelector('[data-incident-recheck-access="' + failed.id + '"]')!;
    expect(link.getAttribute('href')).toBe('#connections/others/verify-access/verification/' + failed.id);
    expect(f.root.querySelector('[data-incident-recheck-access="' + passed.id + '"]')).toBeNull(); expect(f.call).not.toHaveBeenCalled(); history.dispose(); f.panel.dispose();
  });
  it('provides a fresh-review destination when the source result is no longer available', async () => {
    const f = fixture(); f.call.mockRejectedValueOnce(new Error('private source details'));
    f.panel.open({ kind: 'verification', id: f.done.id }); await f.panel.whenLoaded();
    expect(f.root.textContent).toContain('If the saved result is gone'); expect(f.root.textContent).not.toContain('private source details');
    expect(f.root.querySelector('[data-authentication-access-fallback="repairs"]')).not.toBeNull(); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
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
    f.done.results[0]!.target = f.plan.targets[0]!.target;
    f.done.results[0]!.checks = [{ kind: 'file_metadata', status: 'passed' }, { kind: 'file_download', status: 'passed' }];
    f.panel.open(selection); await f.panel.whenLoaded(); expect(f.call).toHaveBeenCalledTimes(1);
    f.action('file-' + 'd'.repeat(64)).click(); await tick(); expect(f.root.textContent).toContain('using the saved authentication');
    expect(f.call.mock.calls.map(([args]) => args.action)).toEqual(['authentication_access_preview', 'file_authentication_files']);
    f.root.querySelector('[data-file-download-picker-choice="chosen"]')!.fire('change');
    f.root.querySelector('[data-file-download-picker-action="verify"]')!.click(); await tick();
    f.action('run').click(); await f.panel.whenLoaded();
    expect(f.call.mock.calls.at(-1)![0]).toMatchObject({ action: 'authentication_access_run', choices: [{ target_id: 'd'.repeat(64), file_id: 'chosen' }] });
    expect(f.root.textContent).toContain('Chosen file download/export: Passed'); f.panel.dispose();
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
