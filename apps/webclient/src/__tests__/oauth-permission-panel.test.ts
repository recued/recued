import { describe, expect, it } from 'vitest';
import type { OAuthAppsRequest, OAuthAppsResponse, OAuthPermissionInventory, OAuthPermissionCleanupPreview, SavedOAuthApp } from '@recued/contracts';
import { createOAuthPermissionPanel } from '../settings/oauth-permission-panel.js';
const app: SavedOAuthApp = { id: 'default', issuer: 'google', client_id: 'client', label: 'Work <app>', revision: 1, has_secret: true };
const inventory = (): OAuthPermissionInventory => ({ fingerprint: 'a'.repeat(64), observed_at: 1000, unavailable: [], groups: [{ id: 'b'.repeat(64), app_key: 'c'.repeat(64),
  issuer: 'google', app_label: app.label, saved_app_id: 'default', account_label: 'owner@example.test', authentication: 'direct_oauth', connection_names: ['work'], native_accounts: [],
  requirements_complete: true, grants_known: true, uses: [{ kind: 'mail', id: 'work', label: 'Work <mail>' }], required_scopes: ['read'], warnings: [], scopes: [
    { scope: 'read', status: 'required', evidence: 'recorded_grant', required_by: [{ kind: 'mail', id: 'work', label: 'Work <mail>' }] },
    { scope: 'leftover', status: 'unused_locally', evidence: 'recorded_grant', required_by: [] },
    { scope: 'unconfirmed', status: 'unknown', evidence: 'requested_only', required_by: [] },
  ] }] });
const preview = (): OAuthPermissionCleanupPreview => ({ inventory_fingerprint: 'a'.repeat(64), group_id: 'b'.repeat(64), selected_scopes: ['leftover'], retained_scopes: ['read'], required_scopes: ['read'],
  connection_names: ['work'], uses: inventory().groups[0]!.uses, related_group_ids: [], method: 'google_revoke_reconnect', warnings: ['Other tools may still use these permissions.'], mutation: false, verification: 'not_checked' });
const fixture = (override?: (r: OAuthAppsRequest) => Promise<OAuthAppsResponse | undefined>) => {
  const calls: OAuthAppsRequest[] = []; const listeners = new Map<string, EventListener[]>(); const slot = { innerHTML: '' };
  const host = { ownerDocument: {}, contains: () => true, querySelector: (s: string) => s.includes('host') ? slot : { focus() {} },
    addEventListener: (name: string, fn: EventListener) => listeners.set(name, [...listeners.get(name) ?? [], fn]),
    removeEventListener: (name: string, fn: EventListener) => listeners.set(name, (listeners.get(name) ?? []).filter(f => f !== fn)) } as unknown as HTMLElement;
  const panel = createOAuthPermissionPanel({ host, call: async r => {
    calls.push(r); const result = await override?.(r); if (result) return result;
    return { action: r.action, apps: [app], ...(r.action === 'permission_inventory' ? { permission_inventory: { ...inventory(),
      ...(r.issuer && r.app_id ? { filter: { issuer: r.issuer, app_id: r.app_id } } : {}) } } : { permission_cleanup: preview() }) };
  } });
  const click = (action: string) => { const node = { dataset: { permissionAction: action }, hasAttribute: () => false, closest() { return this; } };
    for (const fn of listeners.get('click') ?? []) fn({ target: node, preventDefault() {} } as unknown as Event); };
  const choose = (scope: string, checked = true) => { for (const fn of listeners.get('change') ?? []) fn({ target: { dataset: { permissionScope: scope, permissionGroupId: 'b'.repeat(64) }, checked } } as unknown as Event); };
  return { panel, slot, calls, click, choose };
};
describe('permission consolidation panel', () => {
  it('shows requirements, unknown consent and only unused-local checkboxes', async () => {
    const f = fixture(); await f.panel.open(); expect(f.slot.innerHTML).toContain('Work &lt;app&gt;'); expect(f.slot.innerHTML).toContain('Work &lt;mail&gt;');
    expect(f.slot.innerHTML).toContain('Required by mail'); expect(f.slot.innerHTML).toContain('data-permission-scope="leftover"');
    expect(f.slot.innerHTML).not.toContain('data-permission-scope="read"'); expect(f.slot.innerHTML).not.toContain('data-permission-scope="unconfirmed"');
    f.choose('read'); f.click('preview'); await f.panel.whenLoaded(); expect(f.calls).toHaveLength(1); f.panel.dispose();
  });
  it('requires an explicit selection and server preview, with no removal action', async () => {
    const f = fixture(); await f.panel.open(); f.click('preview'); expect(f.calls).toHaveLength(1); f.choose('leftover');
    expect(f.panel.hasDraft()).toBe(true); f.click('preview'); await f.panel.whenLoaded();
    expect(f.calls.at(-1)).toEqual({ action: 'preview_permission_cleanup', inventory_fingerprint: 'a'.repeat(64), group_id: 'b'.repeat(64), selected_scopes: ['leftover'] });
    expect(f.slot.innerHTML).toContain('No permissions have been removed'); expect(f.calls.every(c => ['permission_inventory', 'preview_permission_cleanup'].includes(c.action))).toBe(true);
    f.click('back'); f.choose('leftover', false); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('preserves the exact saved-app filter in the preview request', async () => {
    const f = fixture(); await f.panel.open(app); f.choose('leftover'); f.click('preview'); await f.panel.whenLoaded();
    expect(f.calls.at(-1)).toMatchObject({ filter: { issuer: 'google', app_id: 'default' } }); f.panel.dispose();
  });
  it('requires refresh after a stale or lost preview reply', async () => {
    const f = fixture(async r => { if (r.action === 'preview_permission_cleanup') throw Error('Dependencies changed. Refresh permissions.'); return undefined; });
    await f.panel.open(); f.choose('leftover'); f.click('preview'); await f.panel.whenLoaded(); expect(f.slot.innerHTML).toContain('Dependencies changed');
    f.click('preview'); await f.panel.whenLoaded(); expect(f.calls.filter(c => c.action === 'preview_permission_cleanup')).toHaveLength(1);
    f.click('refresh'); await f.panel.whenLoaded(); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('rejects another group, another selection and unsupported response shapes', async () => {
    for (const patch of [{ group_id: 'd'.repeat(64) }, { selected_scopes: ['read'] }, { mutation: true }]) {
      const f = fixture(async r => r.action === 'preview_permission_cleanup' ? { action: r.action, apps: [app], permission_cleanup: { ...preview(), ...patch } as OAuthPermissionCleanupPreview } : undefined);
      await f.panel.open(); f.choose('leftover'); f.click('preview'); await f.panel.whenLoaded(); expect(f.slot.innerHTML).toContain('could not be confirmed');
      expect(f.slot.innerHTML).not.toContain('data-permission-cleanup-preview'); f.panel.dispose();
    }
  });
  it('ignores late inventory after close or disposal', async () => {
    for (const dispose of [false, true]) {
      let release!: (r: OAuthAppsResponse) => void; const f = fixture(async () => new Promise(resolve => { release = resolve; }));
      const pending = f.panel.open(); if (dispose) f.panel.dispose(); else f.click('close');
      release({ action: 'permission_inventory', apps: [], permission_inventory: inventory() }); await pending;
      expect(f.slot.innerHTML).toBe('');
    }
  });
  it('returns focus to the entry button even when Safari did not focus it on click', async () => {
    let focused = 0; const f = fixture(); const opener = { isConnected: true, focus: () => { focused++; } } as unknown as HTMLElement;
    await f.panel.open(undefined, opener); f.click('close'); expect(focused).toBe(1); f.panel.dispose();
  });
  it('shows unavailable inventory and safely rejects an old server response', async () => {
    const f = fixture(async r => ({ action: r.action, apps: [] })); await f.panel.open();
    expect(f.slot.innerHTML).toContain('Refresh or update the server'); expect(f.slot.innerHTML).not.toContain('No OAuth authorizations'); f.panel.dispose();
  });
});
