import { describe, expect, it, vi } from 'vitest';
import type { AuthenticationAccessVerification, AuthenticationRepairTarget, ManagedOAuthResponse } from '@recued/contracts';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { authenticationAccessRepairLabel, createAuthenticationAccessRepairShortcuts, resolveAuthenticationAccessRepair } from '../connections/authentication-access-repair-shortcuts.js';
import { PickerElement } from './helpers/file-download-picker-dom.js';

const receipt = (target: AuthenticationRepairTarget = { kind: 'connection', name: 'work' }): AuthenticationAccessVerification => ({
  id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'group', id: 'a'.repeat(64) }, status: 'completed', started_at: 1000, finished_at: 1100,
  targets_truncated: false, usage_available: true, uses: [], results: [{ id: 'b'.repeat(64), target, label: '<Work>', authentication_revision: 'c'.repeat(64), current: 'yes',
    checks: [{ kind: target.kind === 'collection' ? 'collection_read' : target.kind === 'file_source' ? 'file_metadata' : 'api_read', status: 'failed', reason: 'access_rejected' }] }],
});
const caller = (value = receipt()) => vi.fn<ManagedOAuthCaller>(async () => ({ action: 'authentication_access_status', verification: value }));
const resolve = (call: ManagedOAuthCaller, v = receipt(), current?: () => boolean) => resolveAuthenticationAccessRepair(call, v, v.results[0]!, current);
const withReturn = (hash: string): string => hash + '/from-access/' + receipt().id + '/' + receipt().results[0]!.id;
const targets: [AuthenticationRepairTarget, string][] = [
  [{ kind: 'connection', name: 'work' }, withReturn('#connections/others/review-access/api/work')],
  [{ kind: 'collection', platform: 'mail', slug: 'work' }, withReturn('#connections/mail/work/manage-authentication')],
  [{ kind: 'collection', platform: 'calendar', slug: 'work' }, withReturn('#connections/calendar/work/manage-authentication')],
  [{ kind: 'file_source', source_id: 'opaque-source' }, withReturn('#connections/others/switch-file-authentication/api/drive-work')],
];

describe('access-result authentication destinations', () => {
  it.each(targets)('opens the exact %j destination using a saved-status read only', async (target, hash) => {
    const v = receipt(target); if (target.kind === 'file_source') v.results[0]!.file_connection = { name: 'drive-work', updated_at: 7 };
    const call = caller(v); expect(await resolve(call, v)).toBe(hash);
    expect(call).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_status', id: v.id });
  });
  it.each(['passed', 'checking', 'superseded', 'unknown', 'writes', 'app'] as const)('offers no repair for %s evidence', async kind => {
    const v = receipt(); const r = v.results[0]!;
    if (kind === 'passed') r.checks = [{ kind: 'api_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }];
    if (kind === 'checking') { v.status = 'checking'; delete v.finished_at; r.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }]; }
    if (kind === 'superseded') r.current = 'no'; if (kind === 'unknown') r.current = 'unknown';
    if (kind === 'writes') r.checks = [{ kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }];
    if (kind === 'app') r.target = { kind: 'oauth_apps' };
    expect(authenticationAccessRepairLabel(v, r)).toBeUndefined(); const call = caller(v);
    await expect(resolve(call, v)).rejects.toThrow('Refresh'); expect(call).not.toHaveBeenCalled();
  });
  it('allows a settings review for unconfirmed resources without claiming they require consent', async () => {
    const v = receipt(); v.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'resource_required' }];
    expect(authenticationAccessRepairLabel(v, v.results[0]!)).toBe('Review API authentication');
    expect(await resolve(caller(v), v)).toBe(targets[0]![1]);
  });
  it.each(['id', 'selection', 'start', 'finish', 'target', 'revision', 'result', 'checks', 'current', 'unavailable'] as const)('refuses changed %s before opening settings', async change => {
    const fresh = receipt(); const r = fresh.results[0]!;
    if (change === 'id') fresh.id = 'verify-12345678-1234-4123-8123-123456789abd';
    if (change === 'selection') fresh.selection = { kind: 'repair', id: 'repair-' + 'd'.repeat(64) };
    if (change === 'start') fresh.started_at++; if (change === 'finish') fresh.finished_at!++;
    if (change === 'target') r.target = { kind: 'connection', name: 'other' };
    if (change === 'revision') r.authentication_revision = 'd'.repeat(64);
    if (change === 'result') r.id = 'd'.repeat(64);
    if (change === 'checks') r.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'unavailable' }];
    if (change === 'current') r.current = 'no'; if (change === 'unavailable') r.current = 'unknown';
    await expect(resolve(caller(fresh))).rejects.toThrow('changed');
  });
  it.each([undefined, { name: '../work', updated_at: 7 }, { name: 'work', updated_at: -1 }])('does not guess an absent or malformed file mapping: %j', async mapping => {
    const v = receipt({ kind: 'file_source', source_id: 'not-a-connection-name' });
    const fresh = structuredClone(v); fresh.results[0]!.file_connection = mapping;
    await expect(resolve(caller(fresh), v)).rejects.toThrow(mapping ? 'could not be confirmed' : 'no confirmed authentication review');
  });
  it('uses the fresh server mapping rather than an old file destination', async () => {
    const v = receipt({ kind: 'file_source', source_id: 'opaque-source' }); v.results[0]!.file_connection = { name: 'old', updated_at: 1 };
    const fresh = structuredClone(v); fresh.results[0]!.file_connection = { name: 'drive-work', updated_at: 7 };
    expect(await resolve(caller(fresh), v)).toBe(targets[3]![1]);
  });
  it('compares saved checks by their meaning across wire field and list ordering', async () => {
    const v = receipt(); v.results[0]!.checks.push({ kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' });
    const fresh = structuredClone(v); fresh.results[0]!.checks = [
      { reason: 'not_executed', status: 'unconfirmed', kind: 'write_permissions' }, { reason: 'access_rejected', status: 'failed', kind: 'api_read' },
    ];
    expect(await resolve(caller(fresh), v)).toBe(targets[0]![1]);
  });
  it('refuses native account identities that the existing route cannot represent', async () => {
    const v = receipt({ kind: 'collection', platform: 'mail', slug: '../work' });
    await expect(resolve(caller(v), v)).rejects.toThrow('no confirmed authentication review');
  });
  it.each([null, undefined, { action: 'authentication_access_run', verification: receipt() }, { action: 'authentication_access_status', verification: {} }])('rejects an unavailable or malformed wire reply: %j', async wire => {
    await expect(resolve(vi.fn<ManagedOAuthCaller>(async () => wire as unknown as ManagedOAuthResponse))).rejects.toThrow('could not be confirmed');
  });
  it('redacts transport errors and cancels when the view is no longer current', async () => {
    const call = vi.fn<ManagedOAuthCaller>(async () => { throw Error('token=never-export-this'); });
    await expect(resolve(call)).rejects.toThrow('could not be read');
    await expect(resolve(caller(), receipt(), () => false)).rejects.toThrow('Refresh');
    let active = true; const late = caller(); late.mockImplementation(async () => { active = false; return { action: 'authentication_access_status', verification: receipt() }; });
    await expect(resolve(late, receipt(), () => active)).rejects.toThrow('no longer open');
  });
  it('keeps the original proof stable during an asynchronous read and whitelists native destination fields', async () => {
    const v = receipt({ kind: 'collection', platform: 'mail', slug: 'work' }); const fresh = structuredClone(v);
    Object.assign(fresh.results[0]!.target, { name: 'wrong', kindExtra: 'connection' });
    const call = caller(fresh); call.mockImplementation(async () => { v.results[0]!.target = { kind: 'connection', name: 'other' }; v.started_at++; return { action: 'authentication_access_status', verification: fresh }; });
    expect(await resolve(call, v)).toBe(targets[1]![1]);
  });
});

const controls = (copies = 1) => {
  const root = new PickerElement(); const body = new PickerElement(); let active: PickerElement = body; let live = true;
  const doc = { body, get activeElement() { return active; }, createElement: () => { const e = new PickerElement(); e.focus = () => { active = e; }; return e; } } as unknown as Document;
  const value = receipt(); const call = caller(value); const navigate = vi.fn();
  const render = (): void => { shortcuts.beginRender(); root.textContent = ''; for (let i = 0; i < copies; i++) shortcuts.append(root as unknown as HTMLElement, value, value.results[0]!); };
  const shortcuts = createAuthenticationAccessRepairShortcuts({ document: doc, call, host: () => root as unknown as HTMLElement, active: () => live, changed: render, navigate });
  render(); const button = () => root.querySelector('[data-access-repair-shortcut]')!;
  return { root, value, call, navigate, shortcuts, render, button, active: () => active, live: (v: boolean) => { live = v; } };
};
describe('access repair controls', () => {
  it('returns focus to the chosen occurrence when history repeats the same saved result', async () => {
    const f = controls(2); f.call.mockRejectedValueOnce(Error('offline'));
    const clicked = f.root.querySelectorAll('[data-access-repair-shortcut]')[1]!; clicked.focus(); clicked.click(); await f.shortcuts.whenLoaded();
    expect(f.active()).toBe(f.root.querySelectorAll('[data-access-repair-shortcut]')[1]); expect(f.navigate).not.toHaveBeenCalled();
  });
  it('deduplicates pending clicks across renders and restores focus after the status lookup', async () => {
    const f = controls(); let release!: () => void; f.call.mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; }); return { action: 'authentication_access_status', verification: f.value };
    });
    const old = f.button(); old.focus(); old.click(); old.fire('click'); f.render(); f.button().fire('click');
    expect(f.button().disabled).toBe(true); expect(f.root.textContent).toContain('Reading saved authentication'); expect(f.call).toHaveBeenCalledTimes(1);
    release(); await f.shortcuts.whenLoaded(); expect(f.navigate).toHaveBeenCalledExactlyOnceWith(targets[0]![1]);
    expect(f.button().disabled).toBe(false); expect(f.active()).toBe(f.button());
  });
  it('keeps redacted errors visible after rerender and allows an explicit retry', async () => {
    const f = controls(); f.call.mockRejectedValueOnce(Error('secret-token')); f.button().click(); await f.shortcuts.whenLoaded(); f.render();
    expect(f.root.querySelector('[role="alert"]')?.textContent).toContain('could not be read'); expect(f.root.textContent).not.toContain('secret-token');
    f.button().click(); await f.shortcuts.whenLoaded(); expect(f.navigate).toHaveBeenCalledTimes(1);
  });
  it.each(['reset', 'dispose', 'inactive', 'removed'] as const)('never navigates after a pending view is %s', async mode => {
    const f = controls(); let release!: () => void; f.call.mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; }); return { action: 'authentication_access_status', verification: f.value };
    });
    f.button().click(); const pending = f.shortcuts.whenLoaded();
    if (mode === 'reset') f.shortcuts.reset(); if (mode === 'dispose') f.shortcuts.dispose();
    if (mode === 'inactive') f.live(false); if (mode === 'removed') f.root.textContent = '';
    release(); await pending; expect(f.navigate).not.toHaveBeenCalled();
  });
  it('ignores detached handlers and buttons disabled by the owning view', () => {
    const f = controls(); const old = f.button(); f.render(); old.fire('click'); expect(f.call).not.toHaveBeenCalled();
    f.live(false); f.render(); f.button().fire('click'); expect(f.call).not.toHaveBeenCalled();
  });
});
