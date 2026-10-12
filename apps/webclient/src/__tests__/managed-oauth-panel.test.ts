/** D-322 — broker setup, picker, popup and stale flow UI lifecycle. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedOAuthPanel, type ManagedOAuthPanelContext, type ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import type { ManagedOAuthAuth, ManagedOAuthRequest, ManagedOAuthResponse } from '@recued/contracts';
afterEach(() => vi.useRealTimers());

const settle = async () => { for (let i = 0; i < 24; i += 1) await Promise.resolve(); };
const fixture = (ambiguous = false, intercept?: (request: ManagedOAuthRequest) => Promise<ManagedOAuthResponse> | undefined, manageProfiles = false,
  initialContext: Partial<ManagedOAuthPanelContext> = {}, allowPopup = true) => {
  vi.useFakeTimers();
  const ctx: ManagedOAuthPanelContext = { enabled: true, mode: 'create', name: 'sheets', base_url: 'https://sheets.googleapis.com/v4', scopes: ['write'], profile_id: '', integration_id: '', ...initialContext };
  const calls: ManagedOAuthRequest[] = []; const authorized: ManagedOAuthAuth[] = [];
  const grantSets: (readonly string[] | undefined)[] = [];
  const listeners = new Map<string, EventListener[]>(); let invalidations = 0; let completed = false;
  const popup = { closed: false, location: { href: 'about:blank' }, opener: {}, close() { this.closed = true; } };
  const call: ManagedOAuthCaller = async (request) => {
    calls.push(request);
    const intercepted = intercept?.(request);
    if (intercepted !== undefined) return intercepted;
    switch (request.action) {
      case 'profiles': return { action: 'profiles', profiles: [{ id: 'cloud', label: 'Nango Cloud', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1 }] };
      case 'integrations': return { action: 'integrations', required_scopes: ['pack-read'], integrations: [
        { id: 'sheets-prod', label: 'Sheets', provider: 'google-sheet', default_scopes: [], scope_metadata: 'unknown' },
        ...(ambiguous ? [{ id: 'sheets-other', label: 'Other', provider: 'google-sheet', default_scopes: [], scope_metadata: 'unknown' as const }] : []) ],
        ...(ambiguous ? {} : { selected_id: 'sheets-prod' }) };
      case 'start': return { action: 'start', flow_id: 'flow', claim_secret: 'private-claim', connect_link: 'https://connect.nango.dev/?token=session',
        expires_at: Date.now() + 600_000, requested_scopes: [], scope_metadata: 'unknown' };
      case 'status': return completed ? { action: 'status', status: 'authorized', auth: { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account', target_origin: 'https://sheets.googleapis.com', requested_scopes: [], authorization_receipt: 'opaque-private-receipt' } }
        : { action: 'status', status: 'pending' };
      case 'cancel': return { action: 'cancel' };
      case 'delete_profile': return { action: 'delete_profile' };
      case 'save_profile': return { action: 'save_profile', profile: { id: 'cloud', label: request.label, broker: 'nango', base_url: request.base_url, revision: 2 }, integrations: [] };
      case 'providers': return { action: 'providers', providers: [{ id: 'google-sheet', label: 'Google Sheets' }], selected_id: 'google-sheet' };
      case 'create_integration': return { action: 'create_integration', integration: { id: request.integration_id, label: request.label,
        provider: request.provider, default_scopes: [], scope_metadata: 'unknown' } };
      case 'remote_connections': return { action: 'remote_connections', connections: [{ id: 'existing-account', label: 'Work account', auth_error: false }], page: request.page ?? 0, has_more: false };
      case 'attach': return { action: 'attach', flow_id: 'attach-flow', claim_secret: 'attach-claim', expires_at: Date.now() + 600_000,
        auth: { type: 'managed_oauth', broker_profile_id: request.profile_id, integration_id: request.integration_id, connection_id: request.connection_id,
          target_origin: new URL(request.base_url).origin, requested_scopes: [], authorization_receipt: 'attach-receipt' } };
      case 'delete_remote_connection': return { action: 'delete_remote_connection' };
      case 'save_reauthorization': throw new Error('Unexpected fixture action');
    }
  };
  const host = {
    innerHTML: '', contains: () => true,
    addEventListener: (name: string, fn: EventListener) => { listeners.set(name, [...listeners.get(name) ?? [], fn]); },
    removeEventListener: (name: string, fn: EventListener) => { listeners.set(name, (listeners.get(name) ?? []).filter((value) => value !== fn)); },
  };
  const panel = createManagedOAuthPanel({ call, manageProfiles, context: () => ctx, select: (profile, integration) => { ctx.profile_id = profile; ctx.integration_id = integration; },
    requiredScopes: (scopes) => { ctx.scopes = [...new Set([...ctx.scopes, ...scopes])].sort(); },
    authorized: (auth, grants) => { authorized.push(auth); grantSets.push(grants); }, invalidate: () => { invalidations += 1; },
    changed: () => panel.mount(host as unknown as HTMLElement), open: () => allowPopup ? popup : null });
  const click = (action: string) => {
    const target = { dataset: { managedAction: action }, disabled: false, closest: () => target };
    for (const listener of [...listeners.get('click') ?? []]) listener({ type: 'click', target, preventDefault() {} } as unknown as Event);
  };
  const input = (field: string, value: string, select = false) => {
    const type = select ? 'change' : 'input';
    for (const listener of [...listeners.get(type) ?? []]) listener({ type, target: { tagName: select ? 'SELECT' : 'INPUT', dataset: { managedField: field }, value } } as unknown as Event);
  };
  panel.mount(host as unknown as HTMLElement);
  const authorizeNew = () => { input('account-mode', 'new', true); click('authorize'); };
  return { ctx, panel, host, calls, click, input, authorizeNew, popup, authorized, grantSets, invalidations: () => invalidations, complete: () => { completed = true; } };
};

describe('managed OAuth browser controller', () => {
  it('accepts a history-based reuse receipt without claiming granted permissions', async () => {
    const auth: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'sheets-prod',
      connection_id: 'account', target_origin: 'https://sheets.googleapis.com', requested_scopes: ['read', 'write'],
      required_scopes: ['read'], authorization_receipt: 'reuse-receipt' };
    const f = fixture(false, r => r.action === 'start' ? Promise.resolve({ action: 'reuse', flow_id: 'reuse-flow',
      claim_secret: 'reuse-claim', expires_at: Date.now() + 600_000, auth }) : undefined,
      false, { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account', scopes: ['read'] });
    await settle(); f.click('authorize'); await settle();
    expect(f.authorized).toEqual([auth]); expect(f.grantSets).toEqual([undefined]); expect(f.popup.closed).toBe(true);
    expect(f.popup.location.href).toBe('about:blank');
    expect(f.calls.some(r => r.action === 'status')).toBe(false);
    expect(f.host.innerHTML).toContain('granted permissions remain unknown');
    expect(f.host.innerHTML).not.toContain('authorization covers these permissions');
    expect(f.host.innerHTML).not.toContain('permissions are confirmed');
    expect(f.host.innerHTML).not.toContain('reuse-receipt');
    f.click('authorize'); await settle(); expect(f.calls.filter(r => r.action === 'start')).toHaveLength(1);
    f.panel.dispose(); await settle();
    expect(f.calls).toContainEqual({ action: 'cancel', flow_id: 'reuse-flow', claim_secret: 'reuse-claim' });
  });
  it('cancels a reused receipt that arrives after the scope request changes', async () => {
    let finish!: (r: ManagedOAuthResponse) => void;
    const gate = new Promise<ManagedOAuthResponse>(resolve => { finish = resolve; });
    const f = fixture(false, r => r.action === 'start' ? gate : undefined, false,
      { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account' });
    await settle(); f.click('authorize'); await settle(); f.ctx.scopes = ['new']; f.panel.sync();
    finish({ action: 'reuse', flow_id: 'late-reuse', claim_secret: 'late-claim', expires_at: Date.now() + 600_000,
      granted_scopes: ['write'], auth: { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'sheets-prod',
        connection_id: 'account', target_origin: 'https://sheets.googleapis.com', requested_scopes: ['write'] } });
    await settle(); expect(f.authorized).toEqual([]);
    expect(f.calls).toContainEqual({ action: 'cancel', flow_id: 'late-reuse', claim_secret: 'late-claim' }); f.panel.dispose();
  });
  it('allows an explicit repair to bypass permission reuse while preserving the account', async () => {
    const f = fixture(false, undefined, false, { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account' });
    await settle(); f.click('force-reauthorize'); await settle();
    expect(f.calls.find(r => r.action === 'start')).toMatchObject({ name: 'sheets', force_reauthorization: true });
    expect(f.popup.location.href).toContain('https://connect.nango.dev'); f.panel.dispose();
  });
  it('reuses tracked requests with browser popups blocked', async () => {
    const f = fixture(false, r => r.action === 'start' ? Promise.resolve({ action: 'reuse', flow_id: 'reuse',
      claim_secret: 'claim', expires_at: Date.now() + 600_000,
      auth: { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account',
        target_origin: 'https://sheets.googleapis.com', requested_scopes: ['write'] } }) : undefined, false,
      { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account' }, false);
    await settle(); f.click('authorize'); await settle();
    expect(f.authorized).toHaveLength(1); expect(f.host.innerHTML).not.toContain('Allow popups');
    expect(f.panel.busy()).toBe(false); f.panel.dispose();
  });
  it('cancels a consent session when an access check needs a blocked popup', async () => {
    const f = fixture(false, undefined, false, { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account' }, false);
    await settle(); f.click('authorize'); await settle();
    expect(f.calls).toContainEqual({ action: 'cancel', flow_id: 'flow', claim_secret: 'private-claim' });
    expect(f.host.innerHTML).toContain('Allow popups'); expect(f.authorized).toEqual([]); f.panel.dispose();
  });
  it('waits for cancellation to record completed scopes before another reconnect', async () => {
    let finish!: (r: ManagedOAuthResponse) => void;
    const canceled = new Promise<ManagedOAuthResponse>(resolve => { finish = resolve; });
    const f = fixture(false, r => r.action === 'cancel' ? canceled : undefined, false,
      { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account' });
    await settle(); f.click('authorize'); await settle();
    f.click('cancel'); f.click('force-reauthorize'); await settle();
    expect(f.calls.filter(r => r.action === 'start')).toHaveLength(1);
    finish({ action: 'cancel' }); await settle();
    expect(f.calls.filter(r => r.action === 'start')).toHaveLength(2);
    expect(f.calls.filter(r => r.action === 'start')[1]).toMatchObject({ force_reauthorization: true });
    f.panel.dispose();
  });
  it('checks prefilled accounts while profile discovery is still loading', async () => {
    let finish!: (r: ManagedOAuthResponse) => void;
    const gate = new Promise<ManagedOAuthResponse>((resolve) => { finish = resolve; });
    const f = fixture(false, (r) => r.action === 'profiles' ? gate : undefined, false,
      { profile_id: 'cloud', integration_id: 'sheets-prod' });
    await settle();
    expect(f.calls).toContainEqual({ action: 'remote_connections', profile_id: 'cloud', integration_id: 'sheets-prod', page: 0 });
    expect(f.host.innerHTML).toContain('value="existing" selected');
    f.click('authorize'); await settle(); expect(f.calls.some((r) => r.action === 'start')).toBe(false);
    f.panel.dispose(); finish({ action: 'profiles', profiles: [] }); await settle();
  });
  it('checks existing accounts first without choosing an identity or creating another connection', async () => {
    const f = fixture(); await settle();
    expect(f.calls.filter((r) => r.action === 'remote_connections')).toEqual([
      { action: 'remote_connections', profile_id: 'cloud', integration_id: 'sheets-prod', page: 0 },
    ]);
    expect(f.host.innerHTML).toContain('value="existing" selected');
    expect(f.host.innerHTML).toContain('Work account');
    expect(f.host.innerHTML).not.toContain('value="existing-account" selected');
    expect(f.host.innerHTML).toContain('data-managed-action="attach" disabled');
    f.click('authorize'); await settle();
    expect(f.calls.some((r) => r.action === 'start' || r.action === 'attach')).toBe(false);
    expect(f.popup.location.href).toBe('about:blank'); f.panel.dispose();
  });
  it('offers fresh consent when the first account page proves there are no accounts', async () => {
    const f = fixture(false, (r) => r.action === 'remote_connections'
      ? Promise.resolve({ action: 'remote_connections', connections: [], page: 0, has_more: false }) : undefined);
    await settle();
    expect(f.host.innerHTML).toContain('value="new" selected');
    expect(f.host.innerHTML).toContain('creates another Nango connection');
    f.click('authorize'); await settle();
    expect(f.calls.filter((r) => r.action === 'start')).toHaveLength(1); f.panel.dispose();
  });
  it('keeps reuse available when an empty page has more accounts', async () => {
    const f = fixture(false, (r) => r.action === 'remote_connections'
      ? Promise.resolve({ action: 'remote_connections', connections: [], page: r.page ?? 0, has_more: true }) : undefined);
    await settle();
    expect(f.host.innerHTML).toContain('value="existing" selected');
    expect(f.host.innerHTML).toContain('data-managed-action="next-accounts"');
    f.click('authorize'); await settle();
    expect(f.calls.some((r) => r.action === 'start')).toBe(false); f.panel.dispose();
  });
  it('shows lookup failures and requires a deliberate choice before starting fresh consent', async () => {
    const f = fixture(false, (r) => r.action === 'remote_connections'
      ? Promise.reject(new Error('The broker key cannot list accounts.')) : undefined);
    await settle();
    expect(f.host.innerHTML).toContain('The broker key cannot list accounts.');
    expect(f.panel.busy()).toBe(false);
    f.click('authorize'); await settle(); expect(f.calls.some((r) => r.action === 'start')).toBe(false);
    f.authorizeNew(); await settle();
    expect(f.calls.filter((r) => r.action === 'start')).toHaveLength(1); f.panel.dispose();
  });
  it('keeps a deliberate new-account choice through rerenders and integration refresh', async () => {
    const f = fixture(); await settle(); f.input('account-mode', 'new', true);
    f.panel.mount(f.host as unknown as HTMLElement); f.click('refresh'); await settle();
    expect(f.host.innerHTML).toContain('value="new" selected');
    expect(f.calls.filter((r) => r.action === 'remote_connections')).toHaveLength(1);
    f.click('authorize'); await settle(); expect(f.calls.filter((r) => r.action === 'start')).toHaveLength(1);
    f.panel.dispose();
  });
  it('does not choose between several accounts even when all are healthy', async () => {
    const f = fixture(false, (r) => r.action === 'remote_connections' ? Promise.resolve({ action: 'remote_connections',
      connections: [{ id: 'personal', label: 'Personal', auth_error: false }, { id: 'work', label: 'Work', auth_error: false }],
      page: 0, has_more: false }) : undefined);
    await settle();
    expect(f.host.innerHTML).toContain('Personal'); expect(f.host.innerHTML).toContain('Work');
    expect(f.host.innerHTML).not.toContain('value="personal" selected');
    expect(f.host.innerHTML).not.toContain('value="work" selected');
    expect(f.host.innerHTML).toContain('data-managed-action="attach" disabled'); f.panel.dispose();
  });
  it('ignores an old account page after the integration changes', async () => {
    let finish!: (r: ManagedOAuthResponse) => void;
    const gate = new Promise<ManagedOAuthResponse>((resolve) => { finish = resolve; });
    const f = fixture(false, (r) => r.action === 'remote_connections' && r.integration_id === 'sheets-prod' ? gate : undefined);
    await settle(); expect(f.panel.busy()).toBe(true);
    f.ctx.integration_id = 'sheets-other'; f.panel.mount(f.host as unknown as HTMLElement); await settle();
    expect(f.panel.busy()).toBe(false);
    finish({ action: 'remote_connections', connections: [{ id: 'stale', label: 'Old integration account', auth_error: false }], page: 0, has_more: false });
    await settle();
    expect(f.host.innerHTML).toContain('Work account');
    expect(f.host.innerHTML).not.toContain('Old integration account');
    f.input('account', 'existing-account', true); f.click('attach'); await settle();
    expect(f.calls.find((r) => r.action === 'attach')).toMatchObject({ integration_id: 'sheets-other' }); f.panel.dispose();
  });
  it('does not create a second connection when consent already succeeded in the same form', async () => {
    const f = fixture(); await settle(); f.complete(); f.authorizeNew(); await settle();
    expect(f.authorized).toHaveLength(1);
    expect(f.host.innerHTML).toContain('data-managed-action="authorize" disabled');
    f.click('authorize'); await settle();
    expect(f.calls.filter((r) => r.action === 'start')).toHaveLength(1);
    expect(f.calls.some((r) => r.action === 'cancel')).toBe(false); f.panel.dispose();
  });
  it('keeps saved-account edits on same-account reauthorization without a new-account picker', async () => {
    const f = fixture(); await settle();
    const accountLookups = f.calls.filter((r) => r.action === 'remote_connections').length;
    f.ctx.mode = 'edit'; f.ctx.connection_id = 'saved-account'; f.panel.mount(f.host as unknown as HTMLElement); await settle();
    expect(f.host.innerHTML).not.toContain('data-managed-field="account-mode"');
    expect(f.host.innerHTML).not.toContain('data-managed-field="account"');
    expect(f.calls.filter((r) => r.action === 'remote_connections')).toHaveLength(accountLookups);
    f.click('authorize'); await settle();
    expect(f.calls.find((r) => r.action === 'start')).toMatchObject({ name: 'sheets', integration_id: 'sheets-prod' });
    f.panel.dispose();
  });
  it('shows an attachment failure and unlocks the form so the owner can retry', async () => {
    const f = fixture(false, (r) => r.action === 'attach' ? Promise.reject(new Error('This account needs reauthorization.')) : undefined);
    await settle(); f.input('account-mode', 'existing', true); await settle();
    f.input('account', 'existing-account', true); f.click('attach'); await settle();
    expect(f.panel.busy()).toBe(false);
    expect(f.host.innerHTML).toContain('This account needs reauthorization.');
    expect(f.authorized).toEqual([]);
    f.input('account-mode', 'new', true); f.click('authorize'); await settle();
    expect(f.calls.some((r) => r.action === 'start')).toBe(true); f.panel.dispose();
  });
  it('keeps the saved integration selected when editing its broker key', async () => {
    const f = fixture(); await settle(); f.ctx.mode = 'edit'; f.ctx.connection_id = 'account';
    f.panel.mount(f.host as unknown as HTMLElement); await settle();
    f.click('edit'); f.input('key', 'rotated-key'); f.click('save-profile'); await settle();
    expect(f.ctx.integration_id).toBe('sheets-prod');
    expect(f.host.innerHTML).not.toContain('data-managed-action="authorize" disabled');
    f.click('authorize'); await settle();
    expect(f.calls.find((r) => r.action === 'start')).toMatchObject({ name: 'sheets', integration_id: 'sheets-prod' });
    f.panel.dispose();
  });
  it('retires the selected account receipt when its account list is refreshed', async () => {
    const f = fixture(); await settle(); f.input('account-mode', 'existing', true); await settle();
    f.input('account', 'existing-account', true); f.click('attach'); await settle();
    const before = f.invalidations(); f.click('refresh-accounts'); await settle();
    expect(f.invalidations()).toBeGreaterThan(before);
    expect(f.calls).toContainEqual({ action: 'cancel', flow_id: 'attach-flow', claim_secret: 'attach-claim' });
    expect(f.host.innerHTML).toContain('data-managed-action="attach" disabled'); f.panel.dispose();
  });
  it('clears account choices and app secrets after a broker key edit', async () => {
    const f = fixture(); await settle(); f.input('account-mode', 'existing', true); await settle();
    f.input('account', 'existing-account', true); f.click('add-integration'); await settle();
    f.input('app', 'custom', true); f.input('client-secret', 'old-app-secret');
    f.click('edit'); f.input('key', 'rotated-key'); f.click('save-profile'); await settle();
    expect(f.ctx.integration_id).toBe('sheets-prod');
    expect(f.host.innerHTML).toContain('data-managed-field="account"');
    expect(f.host.innerHTML).not.toContain('value="existing-account" selected');
    expect(f.host.innerHTML).not.toContain('old-app-secret');
    expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('reuses an explicitly selected Nango account without opening a popup or claiming scopes', async () => {
    const f = fixture(); await settle(); f.input('account-mode', 'existing', true); await settle();
    expect(f.calls.some((r) => r.action === 'remote_connections')).toBe(true);
    expect(f.host.innerHTML).toContain('Work account');
    expect(f.host.innerHTML).toContain('data-managed-action="attach" disabled');
    f.input('account', 'existing-account', true); f.click('attach'); await settle();
    expect(f.authorized[0]).toMatchObject({ connection_id: 'existing-account', requested_scopes: [], authorization_receipt: 'attach-receipt' });
    expect(f.calls.some((r) => r.action === 'start')).toBe(false);
    expect(f.popup.location.href).toBe('about:blank'); expect(f.host.innerHTML).not.toContain('attach-receipt');
    f.panel.dispose(); await settle(); expect(f.calls).toContainEqual({ action: 'cancel', flow_id: 'attach-flow', claim_secret: 'attach-claim' });
  });
  it('cancels an attached receipt if its response arrives after switching the broker', async () => {
    let finish!: (r: ManagedOAuthResponse) => void;
    const gate = new Promise<ManagedOAuthResponse>((resolve) => { finish = resolve; });
    const f = fixture(false, (r) => r.action === 'attach' ? gate : undefined); await settle();
    f.input('account-mode', 'existing', true); await settle(); f.input('account', 'existing-account', true);
    f.click('attach'); await settle(); f.ctx.base_url = 'https://different.example'; f.panel.sync();
    finish({ action: 'attach', flow_id: 'late-attach', claim_secret: 'late-claim', expires_at: Date.now() + 600_000,
      auth: { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'existing-account',
        target_origin: 'https://sheets.googleapis.com', requested_scopes: [], authorization_receipt: 'late-receipt' } });
    await settle(); expect(f.authorized).toEqual([]);
    expect(f.calls).toContainEqual({ action: 'cancel', flow_id: 'late-attach', claim_secret: 'late-claim' }); f.panel.dispose();
  });
  it('keeps an imported account’s scope history intact and passes new permissions through fresh consent', async () => {
    const f = fixture(); await settle(); f.input('account-mode', 'existing', true); await settle();
    f.input('account', 'existing-account', true); f.click('authorize'); await settle();
    expect(f.host.innerHTML).not.toContain('data-managed-action="authorize"');
    expect(f.host.innerHTML).toContain('existing scope profile');
    expect(f.calls.some((r) => r.action === 'start')).toBe(false);
    expect(f.popup.location.href).toBe('about:blank');
    f.input('account-mode', 'new', true); f.click('authorize'); await settle();
    expect(f.calls.find((r) => r.action === 'start')).toMatchObject({ scopes: ['pack-read', 'write'] });
    expect(f.calls.find((r) => r.action === 'start')).not.toHaveProperty('connection_id');
    f.panel.dispose();
  });
  it('creates shared/custom integrations and clears custom app secrets after failure', async () => {
    const f = fixture(); await settle(); f.click('add-integration'); await settle();
    expect(f.host.innerHTML).toContain('Nango shared app, if available'); f.click('create-integration'); await settle();
    expect(f.calls.find((r) => r.action === 'create_integration')).toMatchObject({ app: 'shared', provider: 'google-sheet', integration_id: 'recued-google-sheet' });
    expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
    const custom = fixture(false, (r) => r.action === 'create_integration' ? Promise.reject(new Error('Broker unavailable.')) : undefined);
    await settle(); custom.click('add-integration'); await settle(); custom.input('app', 'custom', true);
    custom.input('client-id', 'custom-id'); custom.input('client-secret', 'private-secret'); custom.input('app-scopes', 'read,write');
    custom.click('create-integration'); await settle();
    expect(custom.calls.find((r) => r.action === 'create_integration')).toMatchObject({ client_id: 'custom-id', client_secret: 'private-secret', scopes: ['read', 'write'] });
    expect(custom.host.innerHTML).not.toContain('private-secret'); expect(custom.host.innerHTML).toContain('Broker unavailable.'); custom.panel.dispose();
  });
  it('lets the server check imported-account history and shows its refusal safely', async () => {
    const f = fixture(false, r => r.action === 'start' ? Promise.reject(new Error('Recued does not know this account’s previous scopes. Manage consent in Nango.')) : undefined); await settle();
    f.ctx.mode = 'edit'; f.ctx.connection_id = 'existing-account'; f.ctx.imported = true;
    f.panel.mount(f.host as unknown as HTMLElement); await settle();
    expect(f.host.innerHTML).toContain('Recued checks for saved scope history');
    expect(f.host.innerHTML).toContain('data-managed-action="authorize"');
    f.click('authorize'); await settle();
    expect(f.calls.some((r) => r.action === 'start')).toBe(true);
    expect(f.host.innerHTML).toContain('previous scopes');
    expect(f.popup.closed).toBe(true); f.panel.dispose();
  });
  it('uses the same profile form independently of enrollment and confirms remote deletion', async () => {
    const f = fixture(false, undefined, true); await settle();
    expect(f.calls).toContainEqual({ action: 'integrations', profile_id: 'cloud' });
    expect(f.host.innerHTML).not.toContain('data-managed-action="authorize"');
    f.click('add'); expect(f.host.innerHTML).toContain('Nango API key'); expect(f.host.innerHTML).toContain('Environment Settings');
    f.click('close-setup'); f.input('integration', 'sheets-prod', true); f.input('account-mode', 'existing', true); await settle();
    f.input('account', 'existing-account', true); expect(f.host.innerHTML).toContain('affects every tool using it');
    f.input('delete-confirmation', 'existing-account'); f.click('delete-account'); await settle();
    expect(f.calls).toContainEqual({ action: 'delete_remote_connection', profile_id: 'cloud', integration_id: 'sheets-prod',
      connection_id: 'existing-account', confirmation: 'existing-account' }); f.panel.dispose();
  });
  it('closes a starting popup and cancels a late server session after the target changes', async () => {
    let finish!: (result: ManagedOAuthResponse) => void;
    const started = new Promise<ManagedOAuthResponse>((resolve) => { finish = resolve; });
    const f = fixture(false, (request) => request.action === 'start' ? started : undefined);
    await settle(); f.authorizeNew(); await settle(); expect(f.panel.busy()).toBe(true);
    f.ctx.base_url = 'https://www.googleapis.com/drive/v3'; f.panel.sync();
    expect(f.popup.closed).toBe(true);
    finish({ action: 'start', flow_id: 'late-flow', claim_secret: 'late-claim', connect_link: 'https://connect.nango.dev',
      expires_at: Date.now() + 600_000, requested_scopes: [], scope_metadata: 'unknown' });
    await settle();
    expect(f.calls).toContainEqual({ action: 'cancel', flow_id: 'late-flow', claim_secret: 'late-claim' });
    expect(f.authorized).toHaveLength(0); expect(f.panel.busy()).toBe(false); f.panel.dispose();
  });
  it('does not seed another dialog after a broker-save response arrives late', async () => {
    let finish!: (result: ManagedOAuthResponse) => void;
    const saved = new Promise<ManagedOAuthResponse>((resolve) => { finish = resolve; });
    const f = fixture(false, (request) => request.action === 'save_profile' ? saved : undefined);
    await settle(); f.click('add'); f.input('label', 'Late broker'); f.input('key', 'temporary-key');
    f.click('save-profile'); await settle(); f.ctx.enabled = false; f.ctx.profile_id = ''; f.ctx.integration_id = ''; f.panel.mount(null);
    finish({ action: 'save_profile', profile: { id: 'late-profile', label: 'Late broker', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1 }, integrations: [] });
    await settle(); expect(f.ctx.profile_id).toBe(''); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('prefills the sole matching configured integration; ambiguity asks the owner', async () => {
    const single = fixture(); await settle();
    expect(single.ctx).toMatchObject({ profile_id: 'cloud', integration_id: 'sheets-prod' });
    expect(single.ctx.scopes).toEqual(['pack-read', 'write']);
    expect(single.host.innerHTML).toContain('Nango Cloud'); single.panel.dispose();
    const many = fixture(true); await settle(); expect(many.ctx.integration_id).toBe('');
    many.input('integration', 'sheets-other', true); expect(many.ctx.integration_id).toBe('sheets-other'); many.panel.dispose();
  });
  it('opens a short-lived link, polls the server and applies only a verified receipt', async () => {
    const f = fixture(); await settle(); f.authorizeNew(); await settle();
    expect(f.popup.location.href).toBe('https://connect.nango.dev/?token=session'); expect(f.popup.opener).toBeNull();
    expect(f.host.innerHTML).toContain('did not expose its app scopes');
    expect(f.authorized).toEqual([]); f.complete(); await vi.advanceTimersByTimeAsync(2500); await settle();
    expect(f.authorized[0]).toMatchObject({ authorization_receipt: 'opaque-private-receipt', connection_id: 'account' });
    expect(f.host.innerHTML).not.toContain('private-claim'); expect(f.host.innerHTML).not.toContain('opaque-private-receipt');
    expect(f.popup.closed).toBe(true); f.panel.dispose();
  });
  it.each(['broker_unavailable', 'transport', 'timeout'])('keeps consent pending and recovers after a %s polling failure', async (code) => {
    let failures = 1;
    const f = fixture(false, (r) => r.action === 'status' && failures-- > 0
      ? Promise.reject(Object.assign(new Error('temporary broker failure'), { code })) : undefined);
    await settle(); f.authorizeNew(); await settle();
    expect(f.panel.busy()).toBe(true); expect(f.popup.closed).toBe(false);
    expect(f.calls.some((r) => r.action === 'cancel')).toBe(false);
    expect(f.host.innerHTML).toContain('Retrying authorization verification');
    expect(f.authorized).toEqual([]);
    f.complete(); await vi.advanceTimersByTimeAsync(2500); await settle();
    expect(f.authorized).toHaveLength(1); expect(f.panel.busy()).toBe(false);
    expect(f.host.innerHTML).not.toContain('Retrying authorization verification'); f.panel.dispose();
  });
  it('backs off temporary failures only until the existing authorization expires', async () => {
    const f = fixture(false, (r) => r.action === 'status'
      ? Promise.reject(Object.assign(new Error('temporary broker failure'), { code: 'broker_unavailable' })) : undefined);
    await settle(); f.authorizeNew(); await settle();
    await vi.advanceTimersByTimeAsync(2499); expect(f.calls.filter((r) => r.action === 'status')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(f.calls.filter((r) => r.action === 'status')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4999); expect(f.calls.filter((r) => r.action === 'status')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(f.calls.filter((r) => r.action === 'status')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(600_000); await settle();
    expect(f.panel.busy()).toBe(false); expect(f.popup.closed).toBe(true);
    expect(f.host.innerHTML).toContain('Authorization expired'); expect(f.authorized).toEqual([]);
    expect(f.calls.filter((r) => r.action === 'cancel')).toHaveLength(1);
    const statusCount = f.calls.filter((r) => r.action === 'status').length;
    await vi.advanceTimersByTimeAsync(20_000); expect(f.calls.filter((r) => r.action === 'status')).toHaveLength(statusCount);
    f.panel.dispose();
  });
  it.each(['cancel', 'scope edit', 'dispose'])('retires a scheduled polling retry after %s', async (action) => {
    const f = fixture(false, (r) => r.action === 'status'
      ? Promise.reject(Object.assign(new Error('temporary broker failure'), { code: 'broker_unavailable' })) : undefined);
    await settle(); f.authorizeNew(); await settle();
    if (action === 'cancel') f.click('cancel');
    else if (action === 'scope edit') { f.ctx.scopes = ['new-scope']; f.panel.sync(); }
    else f.panel.dispose();
    await settle(); await vi.advanceTimersByTimeAsync(20_000);
    expect(f.calls.filter((r) => r.action === 'status')).toHaveLength(1);
    expect(f.calls.filter((r) => r.action === 'cancel')).toHaveLength(1);
    expect(f.authorized).toEqual([]); f.panel.dispose();
  });
  it('reports permanent polling errors without retrying or applying authorization', async () => {
    const f = fixture(false, (r) => r.action === 'status'
      ? Promise.reject(Object.assign(new Error('The broker rejected this API key.'), { code: 'bad_request' })) : undefined);
    await settle(); f.authorizeNew(); await settle();
    expect(f.panel.busy()).toBe(false); expect(f.popup.closed).toBe(true);
    expect(f.host.innerHTML).toContain('The broker rejected this API key.');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.calls.filter((r) => r.action === 'status')).toHaveLength(1);
    expect(f.authorized).toEqual([]); f.panel.dispose();
  });
  it('cancels and invalidates consent after a scope edit and ignores late completion', async () => {
    const f = fixture(); await settle(); f.authorizeNew(); await settle();
    f.ctx.scopes = ['different-scope']; f.panel.sync(); await settle();
    expect(f.calls.some((request) => request.action === 'cancel')).toBe(true); expect(f.invalidations()).toBeGreaterThan(0);
    f.complete(); await vi.advanceTimersByTimeAsync(5000); expect(f.authorized).toEqual([]); f.panel.dispose();
  });
  it('tests and saves broker credentials separately from vendor auth and clears its key draft', async () => {
    const f = fixture(); await settle(); f.click('add');
    expect(f.host.innerHTML).not.toContain('data-managed-field="scope-action"');
    f.input('label', 'My broker'); f.input('server', 'https://broker.example'); f.input('key', 'secret-env-key');
    expect(f.panel.hasDraft()).toBe(true); f.click('save-profile'); await settle();
    expect(f.calls).toContainEqual({ action: 'save_profile', broker: 'nango', label: 'My broker', base_url: 'https://broker.example', api_key: 'secret-env-key' });
    expect(f.panel.hasDraft()).toBe(false); expect(f.host.innerHTML).not.toContain('secret-env-key'); f.panel.dispose();
  });
  it('retires a completed receipt when the form changes before save', async () => {
    const f = fixture(); await settle(); f.complete(); f.authorizeNew(); await settle();
    expect(f.authorized).toHaveLength(1);
    f.ctx.scopes = ['new-permission']; f.panel.sync(); await settle();
    expect(f.calls).toContainEqual({ action: 'cancel', flow_id: 'flow', claim_secret: 'private-claim' });
    f.panel.dispose();
  });
});
