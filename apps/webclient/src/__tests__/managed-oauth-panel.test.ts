/** D-322 — broker setup, picker, popup and stale flow UI lifecycle. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedOAuthPanel, type ManagedOAuthPanelContext, type ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { CONNECTION_HEALTH_FRESH_MS } from '@recued/contracts';
import type { ManagedOAuthAuth, ManagedOAuthRequest, ManagedOAuthResponse, ManagedOAuthPermissionPreview, ManagedOAuthImpactPreview } from '@recued/contracts';
afterEach(() => vi.useRealTimers());

const settle = async () => { for (let i = 0; i < 24; i += 1) await Promise.resolve(); };
const permissionPreview = (patch: Partial<ManagedOAuthPermissionPreview> = {}): ManagedOAuthPermissionPreview => ({
  fingerprint: 'reviewed-permissions', decision: 'authorize', scope_metadata: 'available',
  required_scopes: ['write'], previous_scopes: [], requested_scopes: ['write'], added_scopes: ['write'], retained_scopes: [],
  sources: [{ kind: 'request', label: 'This connection', scopes: ['write'] }],
  warnings: ['Requested permissions are not proof of vendor-granted access.'], ...patch,
});
const fixture = (ambiguous = false, intercept?: (request: ManagedOAuthRequest) => Promise<ManagedOAuthResponse> | undefined, manageProfiles = false,
  initialContext: Partial<ManagedOAuthPanelContext> = {}, allowPopup = true, confirmDiscard?: (prompt: string) => boolean,
  afterAuthorized?: (auth: ManagedOAuthAuth) => void,
  accountActions: { openConnection?(name: string, expectedUpdatedAt: number): Promise<boolean>; checkConnection?(name: string, expectedUpdatedAt: number): Promise<void> } = {}) => {
  vi.useFakeTimers();
  const ctx: ManagedOAuthPanelContext = { enabled: true, mode: 'create', name: 'sheets', base_url: 'https://sheets.googleapis.com/v4', scopes: ['write'], profile_id: '', integration_id: '', ...initialContext };
  const calls: ManagedOAuthRequest[] = []; const authorized: ManagedOAuthAuth[] = [];
  const grantSets: (readonly string[] | undefined)[] = [];
  let currentAuth: ManagedOAuthAuth | undefined;
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
      case 'preview': return { action: 'preview', preview: permissionPreview({
        decision: ctx.mode === 'edit' ? 'reconnect' : 'authorize',
      }) };
      case 'start': return { action: 'start', flow_id: 'flow', claim_secret: 'private-claim', connect_link: 'https://connect.nango.dev/?token=session',
        expires_at: Date.now() + 600_000, requested_scopes: [], scope_metadata: 'unknown' };
      case 'status': return completed ? { action: 'status', status: 'authorized', auth: { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account', target_origin: 'https://sheets.googleapis.com', requested_scopes: [], authorization_receipt: 'opaque-private-receipt' } }
        : { action: 'status', status: 'pending' };
      case 'cancel': return { action: 'cancel' };
      case 'account_impact': throw new Error('This fixture needs an explicit account impact response.');
      case 'collection_authentication_candidates':
      case 'collection_authentication_app_context':
      case 'collection_authentication_app_authorize':
      case 'collection_authentication_app_review':
      case 'collection_authentication_app_apply':
      case 'collection_authentication_app_status':
      case 'collection_authentication_app_retire':
      case 'collection_authentication_review':
      case 'collection_authentication_apply':
      case 'collection_authentication_status':
      case 'collection_authentication_retire': throw new Error('This fixture does not handle collection authentication migration.');
      case 'review_direct_authentication':
      case 'authentication_worklist':
      case 'authentication_history':
      case 'authentication_history_export':
      case 'authentication_access_preview':
      case 'authentication_access_retire':
      case 'authentication_access_run':
      case 'authentication_access_status':
      case 'file_authentication_files':
      case 'file_authentication_prepare':
      case 'reauthorization_context':
      case 'retire_direct_authentication': throw new Error('This fixture does not handle direct OAuth reviews.');
      case 'migration_candidates':
      case 'migration_prepare':
      case 'migration_apply':
      case 'migration_status':
      case 'migration_stop': throw new Error('This fixture does not handle a bulk migration.');
      case 'delete_profile': return { action: 'delete_profile' };
      case 'save_profile': return { action: 'save_profile', profile: { id: 'cloud', label: request.label, broker: 'nango', base_url: request.base_url, revision: 2 }, integrations: [] };
      case 'providers': return { action: 'providers', providers: [{ id: 'google-sheet', label: 'Google Sheets' }], selected_id: 'google-sheet' };
      case 'create_integration': return { action: 'create_integration', integration: { id: request.integration_id, label: request.label,
        provider: request.provider, default_scopes: [], scope_metadata: 'unknown' } };
      case 'remote_connections': return { action: 'remote_connections', connections: [{ id: 'existing-account', label: 'Work account', auth_error: false }], page: request.page ?? 0, has_more: false };
      case 'account_usage': return { action: 'account_usage', usage: { connection_id: request.connection_id, auth_error: false, connections: [], warnings: [] } };
      case 'attach': return { action: 'attach', flow_id: 'attach-flow', claim_secret: 'attach-claim', expires_at: Date.now() + 600_000,
        auth: { type: 'managed_oauth', broker_profile_id: request.profile_id, integration_id: request.integration_id, connection_id: request.connection_id,
          target_origin: new URL(request.base_url).origin, requested_scopes: [], authorization_receipt: 'attach-receipt' } };
      case 'delete_remote_connection': return { action: 'delete_remote_connection' };
      case 'save_reauthorization':
      case 'apply_authentication_switch': throw new Error('Unexpected fixture action');
    }
  };
  const host = {
    innerHTML: '', contains: () => true,
    addEventListener: (name: string, fn: EventListener) => { listeners.set(name, [...listeners.get(name) ?? [], fn]); },
    removeEventListener: (name: string, fn: EventListener) => { listeners.set(name, (listeners.get(name) ?? []).filter((value) => value !== fn)); },
  };
  const open = vi.fn(() => allowPopup ? popup : null);
  const panel = createManagedOAuthPanel({ call, manageProfiles, context: () => ctx, select: (profile, integration) => { ctx.profile_id = profile; ctx.integration_id = integration; },
    requiredScopes: (scopes) => { ctx.scopes = [...new Set([...ctx.scopes, ...scopes])].sort(); },
    authorized: (auth, grants) => { currentAuth = auth; authorized.push(auth); grantSets.push(grants); afterAuthorized?.(auth); },
    invalidate: () => { currentAuth = undefined; invalidations += 1; },
    changed: () => panel.mount(host as unknown as HTMLElement), open,
    ...(confirmDiscard ? { confirmDiscard } : {}), ...accountActions });
  const click = (action: string, name?: string) => {
    const target = { dataset: { managedAction: action, managedName: name }, disabled: false, closest: () => target };
    for (const listener of [...listeners.get('click') ?? []]) listener({ type: 'click', target, preventDefault() {} } as unknown as Event);
  };
  const input = (field: string, value: string, select = false) => {
    const type = select ? 'change' : 'input';
    for (const listener of [...listeners.get(type) ?? []]) listener({ type, target: { tagName: select ? 'SELECT' : 'INPUT', dataset: { managedField: field }, value } } as unknown as Event);
  };
  panel.mount(host as unknown as HTMLElement);
  const authorizeNew = async () => { input('account-mode', 'new', true); await settle(); click('authorize'); };
  return { ctx, panel, host, calls, click, input, listeners, authorizeNew, popup, open, authorized, grantSets,
    currentAuth: () => currentAuth, invalidations: () => invalidations, complete: () => { completed = true; } };
};

describe('broker panel inside a connection editor', () => {
  it('keeps broker administration out of an existing connection and names the account it signs in with', async () => {
    const f = fixture(false, undefined, false, { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'existing-account' }); await settle();
    const html = f.host.innerHTML;
    expect(html).toMatch(/data-managed-field="profile"[^>]*disabled/);
    for (const action of ['add', 'edit', 'delete', 'refresh', 'add-integration']) expect(html).not.toContain(`data-managed-action="${action}"`);
    expect(html).toContain('Signed in as Nango account <code>existing-account</code>');
    expect(html).not.toContain('managed-oauth-trust'); f.panel.dispose();
  });
  it('lets a new connection add or edit a broker and leaves removing one to broker management', async () => {
    const f = fixture(); await settle();
    expect(f.host.innerHTML).toContain('data-managed-action="add"'); expect(f.host.innerHTML).toContain('data-managed-action="edit"');
    expect(f.host.innerHTML).not.toContain('data-managed-action="delete"'); f.panel.dispose();
    const managed = fixture(false, undefined, true); await settle();
    expect(managed.host.innerHTML).toContain('data-managed-action="delete"'); expect(managed.host.innerHTML).toContain('managed-oauth-trust');
    managed.panel.dispose();
  });
});

describe('managed OAuth browser controller', () => {
  it.each([false, true])('keeps a newly authorized switch account after an impact read fails, with recovery %s', async recover => {
    const auth: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'sheets-prod',
      connection_id: 'account', target_origin: 'https://sheets.googleapis.com', requested_scopes: [], authorization_receipt: 'receipt' };
    let reads = 0;
    const f = fixture(false, request => {
      if (request.action === 'remote_connections') return Promise.resolve({ action: 'remote_connections',
        connections: [{ id: 'account', label: 'Completed account', auth_error: false }], page: 0, has_more: false });
      if (request.action === 'status') return Promise.resolve({ action: 'status', status: 'authorized', auth, impact_available: true });
      if (request.action === 'account_impact') {
        if (++reads === 1) return Promise.reject(new Error('fixture identity read interrupted'));
        return Promise.resolve({ action: 'account_impact', impact: { fingerprint: 'b'.repeat(64), phase: 'before_save', mode: 'switch', consent: 'request',
          target: { authentication: 'broker', broker: { id: 'cloud', label: 'Cloud', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1 },
            integration_id: 'sheets-prod', connection_id: 'account', identity: { status: 'unknown', reason: 'unsupported' } }, connections: [], warnings: [] } });
      }
      return undefined;
    }, false, { mode: 'switch', expected_updated_at: 7 });
    await settle(); await f.authorizeNew(); await settle();
    expect(f.authorized).toHaveLength(0); expect(f.currentAuth()).toBeUndefined();
    expect(f.host.innerHTML).toContain('The account and impact could not be reviewed');
    if (recover) {
      f.click('refresh-impact'); await settle();
      expect(f.currentAuth()?.connection_id).toBe('account');
      expect(f.panel.impactFingerprint()).toBe('b'.repeat(64));
    }
    f.ctx.scopes = ['more']; f.panel.sync(); await settle();
    expect(f.host.innerHTML).toContain('Review authorization again');
    f.click('review-authorization'); await settle();
    expect(f.calls.filter(request => request.action === 'preview').at(-1)).toMatchObject({ connection_id: 'account' });
    expect(f.open).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it.each([false, true])('waits for the actual authorized account and retires stale impact replies: %s', async stale => {
    const impact = (phase: ManagedOAuthImpactPreview['phase']): ManagedOAuthImpactPreview => ({
      fingerprint: 'a'.repeat(64), phase, mode: 'switch', consent: 'reuse',
      target: { authentication: 'broker', broker: { id: 'cloud', label: 'Cloud', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1 },
        integration_id: 'sheets-prod', connection_id: 'existing-account', identity: { status: 'known', account_id: 'user', email: phase === 'before_save' ? 'actual@example.test' : 'previous@example.test' } },
      connections: [], warnings: [],
    });
    let finish!: (value: ManagedOAuthResponse) => void;
    const delayed = new Promise<ManagedOAuthResponse>(resolve => { finish = resolve; });
    const f = fixture(false, request => {
      if (request.action === 'preview') return Promise.resolve({ action: 'preview', preview: permissionPreview({ decision: 'reuse', account_impact: impact('before_authorization') }) });
      if (request.action === 'start') return Promise.resolve({ action: 'reuse', flow_id: 'flow', claim_secret: 'claim', expires_at: Date.now() + 600000, impact_available: true,
        auth: { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'existing-account',
          target_origin: 'https://sheets.googleapis.com', requested_scopes: [], authorization_receipt: 'receipt' } });
      if (request.action === 'account_impact') return delayed;
      return undefined;
    }, false, { mode: 'switch', expected_updated_at: 7 });
    await settle(); f.input('account', 'existing-account', true); await settle(); f.click('authorize'); await settle();
    expect(f.authorized).toHaveLength(0); expect(f.panel.busy()).toBe(true);
    if (stale) { f.ctx.scopes = ['more']; f.panel.sync(); }
    finish({ action: 'account_impact', impact: impact('before_save') }); await settle();
    expect(f.authorized).toHaveLength(stale ? 0 : 1);
    if (stale) expect(f.host.innerHTML).not.toContain('actual@example.test');
    else { expect(f.host.innerHTML).toContain('actual@example.test'); expect(f.panel.impactFingerprint()).toBe('a'.repeat(64)); }
    f.panel.dispose();
  });
  it('locks broker controls and ignores profile/account actions while the parent verifies a switch', async () => {
    const f = fixture(false, undefined, false, { mode: 'switch', expected_updated_at: 7 }); await settle();
    f.input('account', 'existing-account', true); await settle(); f.ctx.saving = true; f.panel.mount(f.host as unknown as HTMLElement);
    const before = f.calls.length; f.input('profile', 'other-profile', true); f.input('account', 'other-account', true);
    f.click('authorize'); f.click('force-reauthorize'); await settle();
    expect(f.ctx.profile_id).toBe('cloud'); expect(f.calls.length).toBe(before);
    expect(f.host.innerHTML).toMatch(/data-managed-field="profile"[^>]*disabled/); f.panel.dispose();
  });
  it('reviews a completed new switch account again after its receipt expires without creating another account', async () => {
    const f = fixture(false, request => request.action === 'remote_connections' ? Promise.resolve({ action: 'remote_connections',
      connections: [{ id: 'account', label: 'Completed account', auth_error: false }], page: 0, has_more: false })
      : request.action === 'preview' && request.connection_id === 'account' ? Promise.resolve({ action: 'preview', preview: permissionPreview({ decision: 'reuse' }) })
      : request.action === 'start' && request.connection_id === 'account' ? Promise.resolve({ action: 'reuse', flow_id: 'renewed-review', claim_secret: 'renewed-claim',
          expires_at: Date.now() + 600_000, auth: { type: 'managed_oauth', broker_profile_id: request.profile_id, integration_id: request.integration_id,
            connection_id: 'account', target_origin: 'https://sheets.googleapis.com', requested_scopes: ['write'], authorization_receipt: 'renewed-receipt' } }) : undefined,
      false, { mode: 'switch', expected_updated_at: 7 });
    await settle(); f.input('account-mode', 'new', true); await settle(); f.click('authorize'); await settle(); f.complete();
    await vi.advanceTimersByTimeAsync(2500); await settle(); expect(f.currentAuth()?.connection_id).toBe('account');
    await vi.advanceTimersByTimeAsync(600_001); await settle();
    expect(f.host.innerHTML).toContain('Review authorization again'); f.click('review-authorization'); await settle();
    expect(f.calls.filter(request => request.action === 'preview').at(-1)).toMatchObject({ connection_id: 'account', switch_authentication: true });
    f.click('authorize'); await settle();
    expect(f.currentAuth()?.authorization_receipt).toBe('renewed-receipt'); expect(f.open).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it('keeps the completed switch account available when a review read fails, without permitting a duplicate new-account start', async () => {
    let failRead = true;
    const f = fixture(false, request => request.action === 'account_usage' && failRead ? Promise.reject(new Error('fixture read interrupted')) : undefined,
      false, { mode: 'switch', expected_updated_at: 7 });
    await settle(); f.input('account-mode', 'new', true); await settle(); f.click('authorize'); await settle(); f.complete();
    await vi.advanceTimersByTimeAsync(2500); await settle(); f.ctx.scopes.push('extra-scope'); f.panel.sync(); await settle();
    f.click('review-authorization'); await settle(); expect(f.host.innerHTML).toContain('fixture read interrupted');
    expect(f.host.innerHTML).toContain('Review authorization again');
    const starts = f.calls.filter(request => request.action === 'start').length;
    f.click('authorize'); await settle(); expect(f.calls.filter(request => request.action === 'start')).toHaveLength(starts);
    failRead = false; f.click('review-authorization'); await settle();
    expect(f.calls.filter(request => request.action === 'preview').at(-1)).toMatchObject({ connection_id: 'account', scopes: expect.arrayContaining(['extra-scope']) });
    expect(f.open).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it('reviews and authorizes a selected replacement account bound to the existing name and revision', async () => {
    const f = fixture(false, request => request.action === 'preview' ? Promise.resolve({ action: 'preview', preview: permissionPreview({ decision: 'reuse' }) })
      : request.action === 'start' ? Promise.resolve({ action: 'reuse', flow_id: 'switch-flow', claim_secret: 'switch-claim', expires_at: Date.now() + 600_000,
          auth: { type: 'managed_oauth', broker_profile_id: request.profile_id, integration_id: request.integration_id,
            connection_id: request.connection_id!, target_origin: 'https://sheets.googleapis.com', requested_scopes: ['write'], authorization_receipt: 'switch-receipt' } }) : undefined,
      false, { mode: 'switch', expected_updated_at: 7 });
    await settle(); expect(f.host.innerHTML).toContain('Select an existing account');
    expect(f.calls.some(request => request.action === 'preview')).toBe(false);
    f.input('account', 'existing-account', true); await settle();
    expect(f.host.innerHTML).toContain('Permission preview');
    expect(f.host.innerHTML).not.toContain('data-managed-action="attach"');
    f.click('attach'); await settle(); expect(f.calls.some(request => request.action === 'attach')).toBe(false);
    f.click('authorize'); await settle();
    expect(f.calls.find(request => request.action === 'preview')).toMatchObject({ name: 'sheets', switch_authentication: true,
      expected_updated_at: 7, connection_id: 'existing-account' });
    expect(f.calls.find(request => request.action === 'start')).toMatchObject({ name: 'sheets', switch_authentication: true,
      expected_updated_at: 7, connection_id: 'existing-account', preview_fingerprint: 'reviewed-permissions' });
    expect(f.currentAuth()?.authorization_receipt).toBe('switch-receipt'); expect(f.open).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it('can authorize a new replacement account without pinning the previous remote ID', async () => {
    const f = fixture(false, undefined, false, { mode: 'switch', expected_updated_at: 7, connection_id: 'original-account' });
    await settle(); f.input('account-mode', 'new', true); await settle(); f.click('authorize'); await settle();
    const request = f.calls.find(request => request.action === 'start');
    expect(request).toMatchObject({ switch_authentication: true, name: 'sheets', expected_updated_at: 7 });
    expect(request).not.toHaveProperty('connection_id'); f.panel.dispose();
  });
  it('lets a switch request fresh consent for the selected replacement account when reuse needs repair', async () => {
    const f = fixture(false, undefined, false, { mode: 'switch', expected_updated_at: 7 });
    await settle(); f.input('account', 'existing-account', true); await settle();
    expect(f.host.innerHTML).toContain('Review sign-in again'); f.click('force-reauthorize'); await settle();
    expect(f.calls.filter(request => request.action === 'preview').at(-1)).toMatchObject({
      connection_id: 'existing-account', force_reauthorization: true, switch_authentication: true, expected_updated_at: 7 });
    f.click('authorize'); await settle();
    expect(f.calls.find(request => request.action === 'start')).toMatchObject({
      connection_id: 'existing-account', force_reauthorization: true, switch_authentication: true, expected_updated_at: 7 });
    expect(f.open).toHaveBeenCalledTimes(1);
    f.click('cancel'); await settle();
    f.input('account-mode', 'new', true); await settle(); f.click('authorize'); await settle();
    const newAccount = f.calls.filter(request => request.action === 'start').at(-1);
    expect(newAccount).not.toHaveProperty('connection_id'); expect(newAccount).not.toHaveProperty('force_reauthorization');
    expect(f.open).toHaveBeenCalledTimes(2); f.panel.dispose();
  });
  it('expires a displayed successful check locally without creating consent or reading Nango again', async () => {
    const checkedAt = Date.now();
    const f = fixture(false, r => r.action === 'account_usage' ? Promise.resolve({ action: 'account_usage', usage: {
      connection_id: r.connection_id, auth_error: false, warnings: [], connections: [{ name: 'saved-sheets',
        display_name: 'Saved sheets', updated_at: 2, health: { status: 'ok', last_probed_at: checkedAt }, uses: [], usage_available: true }],
    } }) : undefined, true);
    await settle(); f.input('account', 'existing-account', true); await settle();
    expect(f.host.innerHTML).toContain('data-managed-health="ok"');
    await vi.advanceTimersByTimeAsync(CONNECTION_HEALTH_FRESH_MS + 1);
    expect(f.host.innerHTML).toContain('data-managed-health="unknown"');
    expect(f.calls.filter(call => call.action === 'account_usage')).toHaveLength(1);
    expect(f.calls.some(call => call.action === 'start')).toBe(false);
    f.panel.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['account change', 'disposal'] as const)('retires a pending health expiry after $0', async phase => {
    const checkedAt = Date.now();
    const f = fixture(false, r => r.action === 'account_usage' ? Promise.resolve({ action: 'account_usage', usage: {
      connection_id: r.connection_id, auth_error: false, warnings: [], connections: [{ name: 'saved-sheets',
        display_name: 'Saved sheets', updated_at: 2, health: { status: 'ok', last_probed_at: checkedAt }, uses: [], usage_available: true }],
    } }) : undefined, true);
    await settle(); f.input('account', 'existing-account', true); await settle();
    expect(vi.getTimerCount()).toBe(1);
    if (phase === 'account change') f.input('account', '', true); else f.panel.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CONNECTION_HEALTH_FRESH_MS + 1);
    expect(f.calls.filter(call => call.action === 'account_usage')).toHaveLength(1); f.panel.dispose();
  });
  it('loads selected account usage only in management and routes check and repair to that connection', async () => {
    const openConnection = vi.fn(async () => true); const checkConnection = vi.fn(async () => {});
    const f = fixture(false, r => r.action === 'account_usage' ? Promise.resolve({ action: 'account_usage', usage: {
      connection_id: r.connection_id, auth_error: true, warnings: [], connections: [{ name: 'saved-sheets', display_name: 'Saved sheets', updated_at: 2,
        health: { status: 'auth_failed' }, uses: [{ kind: 'pack', id: 'sheet-pack', label: 'Sheet pack' }], usage_available: true }],
    } }) : undefined, true, {}, true, undefined, undefined, { openConnection, checkConnection });
    await settle(); f.input('account', 'existing-account', true); await settle();
    expect(f.host.innerHTML).toContain('Saved sheets'); expect(f.host.innerHTML).toContain('Sheet pack');
    f.input('delete-confirmation', 'existing-account'); f.click('delete-account'); await settle();
    expect(f.calls.some(call => call.action === 'delete_remote_connection')).toBe(false);
    expect(f.host.innerHTML).toMatch(/data-managed-action="delete-account" disabled/);
    f.click('open-connection', 'saved-sheets'); await settle(); expect(openConnection).toHaveBeenCalledWith('saved-sheets', 2);
    f.click('check-connection', 'saved-sheets'); await settle(); expect(checkConnection).toHaveBeenCalledWith('saved-sheets', 2);
    expect(f.calls.filter(call => call.action === 'account_usage')).toHaveLength(2);
    f.click('check-connection', 'unrelated'); await settle(); expect(checkConnection).toHaveBeenCalledTimes(1);
    expect(f.calls.some(call => call.action === 'start' || call.action === 'attach')).toBe(false);
    expect(f.open).not.toHaveBeenCalled();
  });
  it('drops a late account usage response after selection changes', async () => {
    let resolve: ((result: ManagedOAuthResponse) => void) | undefined;
    const f = fixture(false, r => r.action === 'account_usage' ? new Promise(done => { resolve = done; }) : undefined, true);
    await settle(); f.input('account', 'existing-account', true); await settle();
    expect(f.host.innerHTML).toContain('Loading account usage');
    f.input('account', '', true);
    resolve!({ action: 'account_usage', usage: { connection_id: 'existing-account', auth_error: false,
      connections: [{ name: 'late-account', display_name: 'Late account', updated_at: 2, health: { status: 'unknown' }, uses: [], usage_available: true }], warnings: [] } });
    await settle(); expect(f.host.innerHTML).not.toContain('Late account');
  });
  it('keeps failed usage distinct from an empty account and lets the owner retry', async () => {
    let fail = true;
    const f = fixture(false, r => r.action === 'account_usage' && fail ? Promise.reject(new Error('Usage unavailable')) : undefined, true);
    await settle(); f.input('account', 'existing-account', true); await settle();
    expect(f.host.innerHTML).toContain('Usage unavailable'); expect(f.host.innerHTML).not.toContain('No saved Recued API connections');
    fail = false; f.click('refresh-usage'); await settle();
    expect(f.host.innerHTML).toContain('No saved Recued API connections');
  });
  it('does not read account usage while attaching an existing account in enrollment', async () => {
    const f = fixture(); await settle(); f.input('account', 'existing-account', true); await settle();
    expect(f.calls.some(call => call.action === 'account_usage')).toBe(false);
  });
  it('surfaces malformed usage instead of rendering an empty healthy account', async () => {
    const f = fixture(false, r => r.action === 'account_usage'
      ? Promise.resolve({ action: 'account_usage', usage: { connection_id: r.connection_id, connections: null } } as unknown as ManagedOAuthResponse) : undefined, true);
    await settle(); f.input('account', 'existing-account', true); await settle();
    expect(f.host.innerHTML).toContain('Account usage could not be verified'); expect(f.panel.busy()).toBe(false);
    expect(f.host.innerHTML).not.toContain('No saved Recued API connections');
  });
  it('retires a probe indicator when the broker context changes before the probe settles', async () => {
    let finish!: () => void;
    const checkConnection = vi.fn(() => new Promise<void>(done => { finish = done; }));
    const f = fixture(false, r => r.action === 'account_usage' ? Promise.resolve({ action: 'account_usage', usage: {
      connection_id: r.connection_id, auth_error: false, warnings: [], connections: [{ name: 'saved-sheets', display_name: 'Saved sheets', updated_at: 2,
        health: { status: 'unknown' }, uses: [], usage_available: true }],
    } }) : undefined, true, {}, true, undefined, undefined, { checkConnection });
    await settle(); f.input('account', 'existing-account', true); await settle(); f.click('check-connection', 'saved-sheets'); await settle();
    expect(f.panel.busy()).toBe(true); f.ctx.profile_id = 'another-broker'; f.panel.mount(f.host as unknown as HTMLElement); await settle();
    f.input('account', 'existing-account', true); await settle();
    expect(f.host.innerHTML).not.toContain('Checking API access…'); expect(f.panel.busy()).toBe(false);
    finish(); await settle(); expect(f.panel.busy()).toBe(false);
  });
  it.each(['new consent', 'attach', 'imported reconnect'] as const)('preserves the receipt when the enrollment host applies %s account metadata', async phase => {
    const f = fixture(false, r => r.action === 'attach' ? Promise.resolve({ action: 'attach', flow_id: 'attached', claim_secret: 'attached-claim', expires_at: Date.now() + 600_000,
      auth: { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account', target_origin: 'https://sheets.googleapis.com',
        requested_scopes: [], imported: true, authorization_receipt: 'attached-receipt' } }) : undefined,
      false, phase === 'imported reconnect' ? { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account', imported: true } : {},
      true, undefined, auth => { f.ctx.connection_id = auth.connection_id; if (auth.imported) f.ctx.imported = true; else delete f.ctx.imported; });
    await settle();
    if (phase === 'attach') { f.input('account', 'existing-account', true); f.click('attach'); await settle(); }
    else {
      if (phase === 'new consent') await f.authorizeNew(); else f.click('authorize');
      await settle(); f.complete(); await vi.advanceTimersByTimeAsync(2500); await settle();
    }
    expect(f.currentAuth()?.authorization_receipt).toBe(phase === 'attach' ? 'attached-receipt' : 'opaque-private-receipt');
    expect(f.calls.some(r => r.action === 'cancel')).toBe(false); expect(f.panel.busy()).toBe(false); f.panel.dispose();
  });
  it.each(['opener', 'navigation'] as const)('retires the server flow when popup %s fails after session creation', async failure => {
    const f = fixture(); await settle();
    if (failure === 'opener') Object.defineProperty(f.popup, 'opener', { set() { throw new Error('Popup refused'); } });
    else Object.defineProperty(f.popup.location, 'href', { get() { return 'about:blank'; }, set() { throw new Error('Popup refused'); } });
    await f.authorizeNew(); await settle();
    expect(f.calls).toContainEqual({ action: 'cancel', flow_id: 'flow', claim_secret: 'private-claim' });
    expect(f.popup.closed).toBe(true); expect(f.panel.busy()).toBe(false); expect(f.currentAuth()).toBeUndefined();
    expect(f.host.innerHTML).toContain('Popup refused');
    f.click('authorize'); await settle(); expect(f.calls.filter(r => r.action === 'start')).toHaveLength(1);
    f.click('refresh-permissions'); await settle(); expect(f.calls.filter(r => r.action === 'preview')).toHaveLength(2);
    f.panel.dispose();
  });
  it('leaves preparation with a visible error when start returns an unexpected response', async () => {
    const f = fixture(false, r => r.action === 'start' ? Promise.resolve({ action: 'profiles', profiles: [] }) : undefined);
    await settle(); await f.authorizeNew(); await settle();
    expect(f.panel.busy()).toBe(false); expect(f.popup.closed).toBe(true);
    expect(f.host.innerHTML).toContain('Unexpected authorization response');
    expect(f.currentAuth()).toBeUndefined();
    f.click('authorize'); await settle(); expect(f.calls.filter(r => r.action === 'start')).toHaveLength(1); f.panel.dispose();
  });
  it('retires the flow when polling returns an unexpected status envelope', async () => {
    const f = fixture(false, r => r.action === 'status' ? Promise.resolve({ action: 'profiles', profiles: [] }) : undefined);
    await settle(); await f.authorizeNew(); await settle();
    expect(f.panel.busy()).toBe(false); expect(f.currentAuth()).toBeUndefined();
    expect(f.calls).toContainEqual({ action: 'cancel', flow_id: 'flow', claim_secret: 'private-claim' });
    expect(f.host.innerHTML).toContain('Unexpected authorization status response');
    f.click('authorize'); await settle(); expect(f.calls.filter(r => r.action === 'start')).toHaveLength(1); f.panel.dispose();
  });
  it.each(['expired', 'closed', 'rejected'] as const)('requires a fresh review after consent becomes %s', async failure => {
    const f = fixture(false, r => r.action === 'status' && failure !== 'closed'
      ? failure === 'expired' ? Promise.resolve({ action: 'status', status: 'expired' }) : Promise.reject(new Error('Consent rejected')) : undefined);
    await settle(); await f.authorizeNew(); await settle();
    if (failure === 'closed') { f.popup.closed = true; await vi.advanceTimersByTimeAsync(2500); await settle(); }
    expect(f.panel.busy()).toBe(false); expect(f.currentAuth()).toBeUndefined();
    expect(f.calls.filter(r => r.action === 'cancel')).toHaveLength(1);
    f.click('authorize'); await settle(); expect(f.calls.filter(r => r.action === 'start')).toHaveLength(1);
    f.click('refresh-permissions'); await settle(); expect(f.calls.filter(r => r.action === 'preview')).toHaveLength(2); f.panel.dispose();
  });
  it.each(['reuse', 'consent'] as const)('retires %s receipts and partial editor auth when applying authorization fails', async phase => {
    const f = fixture(false, r => r.action === 'preview' ? Promise.resolve({ action: 'preview', preview: permissionPreview({ decision: phase === 'reuse' ? 'reuse' : 'authorize' }) })
      : r.action === 'start' && phase === 'reuse' ? Promise.resolve({ action: 'reuse', flow_id: 'reuse', claim_secret: 'claim', expires_at: Date.now() + 600_000,
        auth: { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account',
          target_origin: 'https://sheets.googleapis.com', requested_scopes: [] } }) : undefined,
      false, {}, true, undefined, () => { throw Object.assign(new Error('Could not apply authorization'), { code: 'transport' }); });
    await settle(); await f.authorizeNew(); await settle();
    if (phase === 'consent') { f.complete(); await vi.advanceTimersByTimeAsync(2500); await settle(); }
    expect(f.panel.busy()).toBe(false); expect(f.currentAuth()).toBeUndefined();
    expect(f.calls).toContainEqual({ action: 'cancel', flow_id: phase === 'reuse' ? 'reuse' : 'flow', claim_secret: phase === 'reuse' ? 'claim' : 'private-claim' });
    expect(f.host.innerHTML).toContain('Could not apply authorization');
    f.click('authorize'); await settle(); expect(f.calls.filter(r => r.action === 'start')).toHaveLength(1); f.panel.dispose();
  });
  it('waits for a read-only preview before enabling authorization and opens no popup for reuse', async () => {
    let finish!: (response: ManagedOAuthResponse) => void;
    const waiting = new Promise<ManagedOAuthResponse>(resolve => { finish = resolve; });
    const f = fixture(false, r => r.action === 'preview' ? waiting : r.action === 'start'
      ? Promise.resolve({ action: 'reuse', flow_id: 'reuse', claim_secret: 'claim', expires_at: Date.now() + 600_000,
        auth: { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account',
          target_origin: 'https://sheets.googleapis.com', requested_scopes: ['read', 'write'] } }) : undefined,
      false, { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account' });
    await settle(); f.click('authorize'); await settle();
    expect(f.host.innerHTML).toContain('Checking the permission request');
    expect(f.host.innerHTML).toMatch(/data-managed-action="authorize" disabled/);
    expect(f.calls.some(r => r.action === 'start' || r.action === 'cancel')).toBe(false);
    expect(f.open).not.toHaveBeenCalled(); expect(f.authorized).toEqual([]);
    finish({ action: 'preview', preview: permissionPreview({ decision: 'reuse', added_scopes: [], retained_scopes: ['write'],
      previous_scopes: ['read', 'write'], sources: [{ kind: 'pack', label: 'Other pack', scopes: ['write'] }] }) });
    await settle(); expect(f.host.innerHTML).toContain('Reuse current authorization');
    expect(f.host.innerHTML).toContain('Other pack'); expect(f.host.innerHTML).toContain('Also kept for other uses');
    f.click('authorize'); await settle();
    expect(f.open).not.toHaveBeenCalled(); expect(f.authorized).toHaveLength(1);
    expect(f.calls.find(r => r.action === 'start')).toMatchObject({ preview_fingerprint: 'reviewed-permissions' });
    f.panel.dispose();
  });
  it('displays a blocked plan and requires review before forced sign-in', async () => {
    const f = fixture(false, r => r.action === 'preview' ? Promise.resolve({ action: 'preview', preview: permissionPreview({
      decision: 'blocked', blocked_reason: 'Manage the app scopes in Nango.' }) }) : undefined,
      false, { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account' });
    await settle(); expect(f.host.innerHTML).toContain('Manage the app scopes in Nango.');
    f.click('authorize'); f.click('force-reauthorize'); await settle(); f.click('authorize'); await settle();
    expect(f.calls.some(r => r.action === 'start')).toBe(false); expect(f.open).not.toHaveBeenCalled();
    expect(f.calls.find(r => r.action === 'preview' && r.force_reauthorization)).toBeDefined(); f.panel.dispose();
  });
  it('retires a late preview on scope or account changes without restoring stale authorization', async () => {
    let finish!: (response: ManagedOAuthResponse) => void;
    const waiting = new Promise<ManagedOAuthResponse>(resolve => { finish = resolve; });
    const f = fixture(false, r => r.action === 'preview' && r.scopes.includes('write') ? waiting : undefined,
      false, { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account' });
    await settle(); f.ctx.scopes = ['new']; f.panel.sync(); await settle();
    finish({ action: 'preview', preview: permissionPreview({ sources: [{ kind: 'request', label: 'Stale scope plan', scopes: ['old'] }] }) });
    await settle(); expect(f.host.innerHTML).not.toContain('Stale scope plan');
    expect(f.calls.filter(r => r.action === 'preview').at(-1)).toMatchObject({ scopes: ['new'] });
    f.ctx.connection_id = 'different-account'; f.panel.sync(); await settle();
    expect(f.calls.filter(r => r.action === 'preview').at(-1)).toMatchObject({ connection_id: 'different-account' });
    expect(f.open).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it('escapes scope sources, distinguishes unknown profiles, and retries failed reads explicitly', async () => {
    let unavailable = true;
    const f = fixture(false, r => r.action === 'preview' ? unavailable ? Promise.reject(new Error('Broker temporarily unavailable.'))
      : Promise.resolve({ action: 'preview', preview: permissionPreview({ scope_metadata: 'unknown', requested_scopes: undefined,
        added_scopes: undefined, retained_scopes: undefined,
        sources: [{ kind: 'pack', label: '<img src=x onerror=alert(1)>', scopes: ['<script>bad()</script>'] }] }) }) : undefined,
      false, { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account' });
    await settle(); expect(f.host.innerHTML).toContain('Broker temporarily unavailable.');
    f.click('authorize'); await settle(); expect(f.calls.some(r => r.action === 'start')).toBe(false);
    unavailable = false; f.click('refresh-permissions'); await settle();
    expect(f.host.innerHTML).toContain('exact permission request is unavailable');
    expect(f.host.innerHTML).toContain('&lt;img'); expect(f.host.innerHTML).not.toContain('<script>');
    expect(f.open).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it('requires a refreshed preview after start rejects a changed permission request', async () => {
    const f = fixture(false, r => r.action === 'start' ? Promise.reject(new Error('Permissions changed after review.')) : undefined,
      false, { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account' });
    await settle(); f.click('authorize'); await settle();
    expect(f.host.innerHTML).toContain('Permissions changed after review.'); expect(f.popup.closed).toBe(true);
    f.click('authorize'); await settle(); expect(f.calls.filter(r => r.action === 'start')).toHaveLength(1);
    expect(f.host.innerHTML).toMatch(/data-managed-action="authorize" disabled/);
    f.click('refresh-permissions'); await settle(); expect(f.calls.filter(r => r.action === 'preview')).toHaveLength(2);
    f.panel.dispose();
  });
  it('retires an isolated vendor popup independently and refreshes permissions after cancel', async () => {
    const f = fixture(); await settle(); await f.authorizeNew(); await settle();
    const close = vi.spyOn(f.popup, 'close');
    Object.defineProperty(f.popup.location, 'href', { get() { throw new Error('Cross-origin window'); } });
    const previews = f.calls.filter(r => r.action === 'preview').length;
    f.click('cancel'); await settle();
    expect(close).not.toHaveBeenCalled();
    expect(f.calls).toContainEqual({ action: 'cancel', flow_id: 'flow', claim_secret: 'private-claim' });
    expect(f.calls.filter(r => r.action === 'preview')).toHaveLength(previews + 1);
    expect(f.host.innerHTML).toContain('Close the sign-in window if it is still open.');
    expect(f.authorized).toEqual([]); expect(f.panel.busy()).toBe(false); f.panel.dispose();
  });
  it('restores the typed caret even when focusing a replacement fires focusin with its initial position', async () => {
    const f = fixture(); await settle(); f.click('add'); f.input('label', ''); f.click('save-profile');
    const body = { dataset: {} };
    const doc: { activeElement: { dataset: { managedField?: string }; selectionStart?: number; selectionEnd?: number }; body: typeof body } = { activeElement: body, body };
    const replacement = { dataset: { managedField: 'label' }, selectionStart: 0, selectionEnd: 0, selectionDirection: 'none',
      disabled: false, focus() { doc.activeElement = this; for (const listener of f.listeners.get('focusin') ?? []) listener({} as Event); },
      setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; } };
    let markup = f.host.innerHTML;
    Object.assign(f.host, { ownerDocument: doc, querySelector: (selector: string) => selector === '[data-managed-field="label"]' ? replacement : null });
    Object.defineProperty(f.host, 'innerHTML', { get: () => markup, set: (value: string) => { markup = value; doc.activeElement = body; } });
    doc.activeElement = { ...replacement, selectionStart: 1, selectionEnd: 1 };
    f.input('label', 'I');
    expect(doc.activeElement).toBe(replacement);
    expect(replacement.selectionStart).toBe(1); expect(replacement.selectionEnd).toBe(1); f.panel.dispose();
  });
  it('does not mistake a failed profile lookup for an empty broker list and offers retry', async () => {
    let unavailable = true;
    const f = fixture(false, r => r.action === 'profiles' && unavailable ? Promise.reject(new Error('Broker profile lookup failed.')) : undefined);
    await settle(); expect(f.panel.busy()).toBe(false);
    expect(f.host.innerHTML).not.toContain('Add your first OAuth broker');
    expect(f.host.innerHTML).toContain('Refresh brokers');
    unavailable = false; f.click('refresh-profiles'); await settle();
    expect(f.ctx.profile_id).toBe('cloud'); expect(f.ctx.integration_id).toBe('sheets-prod'); f.panel.dispose();
  });
  it('loads the selected integration’s accounts directly in broker management', async () => {
    const f = fixture(false, undefined, true); await settle();
    expect(f.calls).toContainEqual({ action: 'remote_connections', profile_id: 'cloud', integration_id: 'sheets-prod', page: 0 });
    expect(f.host.innerHTML).toContain('data-managed-field="account"');
    expect(f.host.innerHTML).not.toContain('data-managed-field="account-mode"'); f.panel.dispose();
  });
  it('validates broker fields locally and retains the draft for correction', async () => {
    const f = fixture(); await settle(); f.click('add');
    f.input('label', ''); f.input('server', 'not-a-url'); f.click('save-profile'); await settle();
    expect(f.calls.some(r => r.action === 'save_profile')).toBe(false);
    expect(f.host.innerHTML).toContain('Enter a profile name.');
    expect(f.host.innerHTML).toContain('Paste the environment API key');
    expect(f.host.innerHTML).toContain('aria-invalid="true"');
    expect(f.panel.hasDraft()).toBe(true);
    f.input('label', 'My Nango'); f.input('server', 'https://nango.example'); f.input('key', 'environment-key');
    f.input('connect-origin', 'https://connect.example/path'); f.click('save-profile'); await settle();
    expect(f.calls.some(r => r.action === 'save_profile')).toBe(false);
    expect(f.host.innerHTML).toContain('Enter only the Connect UI origin');
    f.input('connect-origin', 'https://connect.example'); f.click('save-profile'); await settle();
    expect(f.calls).toContainEqual({ action: 'save_profile', broker: 'nango', label: 'My Nango', base_url: 'https://nango.example',
      connect_ui_origin: 'https://connect.example', api_key: 'environment-key' });
    expect(f.host.innerHTML).not.toContain('environment-key'); f.panel.dispose();
  });
  it('preserves a dirty key when discard is declined and clears it when confirmed', async () => {
    const confirm = vi.fn((_prompt: string) => false);
    const f = fixture(false, undefined, false, {}, true, confirm); await settle(); f.click('add'); f.input('key', 'private-draft');
    f.click('toggle-key'); expect(f.host.innerHTML).toContain('aria-pressed="true"');
    f.click('close-setup'); expect(f.panel.hasDraft()).toBe(true); expect(f.host.innerHTML).toContain('private-draft');
    expect(confirm.mock.calls[0]![0]).not.toContain('private-draft');
    confirm.mockReturnValue(true); f.click('close-setup'); expect(f.panel.hasDraft()).toBe(false);
    expect(f.host.innerHTML).not.toContain('private-draft'); f.click('add');
    expect(f.host.innerHTML).toContain('aria-pressed="false"'); expect(f.host.innerHTML).not.toContain('private-draft'); f.panel.dispose();
  });
  it('requires confirmation before removing a profile and preserves a referenced profile after refusal', async () => {
    const f = fixture(false, r => r.action === 'delete_profile' ? Promise.reject(new Error('This profile is used by a saved connection.')) : undefined, true);
    await settle(); f.click('delete'); await settle(); expect(f.calls.some(r => r.action === 'delete_profile')).toBe(false);
    f.click('cancel-delete-profile'); f.click('confirm-delete-profile'); await settle();
    expect(f.calls.some(r => r.action === 'delete_profile')).toBe(false);
    f.click('delete'); f.click('confirm-delete-profile'); await settle();
    expect(f.calls.filter(r => r.action === 'delete_profile')).toHaveLength(1);
    expect(f.ctx.profile_id).toBe('cloud'); expect(f.host.innerHTML).toContain('This profile is used by a saved connection.'); f.panel.dispose();
  });
  it('validates a custom vendor app before sending any credentials to Nango', async () => {
    const f = fixture(); await settle(); f.click('add-integration'); await settle(); f.input('app', 'custom', true);
    f.input('integration-id', ''); f.input('client-secret', 'draft-app-secret'); f.click('create-integration'); await settle();
    expect(f.calls.some(r => r.action === 'create_integration')).toBe(false);
    expect(f.host.innerHTML).toContain('Enter a unique integration ID.');
    expect(f.host.innerHTML).toContain('Enter your vendor OAuth client ID.');
    expect(f.host.innerHTML).toContain('draft-app-secret'); f.panel.dispose();
  });
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
    await settle(); f.click('force-reauthorize'); await settle(); f.click('authorize'); await settle();
    expect(f.calls.find(r => r.action === 'start')).toMatchObject({ name: 'sheets', force_reauthorization: true });
    expect(f.popup.location.href).toContain('https://connect.nango.dev'); f.panel.dispose();
  });
  it('reuses tracked requests with browser popups blocked', async () => {
    const f = fixture(false, r => r.action === 'preview' ? Promise.resolve({ action: 'preview', preview: permissionPreview({ decision: 'reuse' }) }) : r.action === 'start' ? Promise.resolve({ action: 'reuse', flow_id: 'reuse',
      claim_secret: 'claim', expires_at: Date.now() + 600_000,
      auth: { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account',
        target_origin: 'https://sheets.googleapis.com', requested_scopes: ['write'] } }) : undefined, false,
      { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account' }, false);
    await settle(); f.click('authorize'); await settle();
    expect(f.authorized).toHaveLength(1); expect(f.host.innerHTML).not.toContain('Allow popups');
    expect(f.panel.busy()).toBe(false); f.panel.dispose();
  });
  it('does not create consent when the reviewed reconnect needs a blocked popup', async () => {
    const f = fixture(false, undefined, false, { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account' }, false);
    await settle(); f.click('authorize'); await settle();
    expect(f.calls.some(r => r.action === 'start' || r.action === 'cancel')).toBe(false);
    expect(f.host.innerHTML).toContain('Allow popups'); expect(f.authorized).toEqual([]); f.panel.dispose();
  });
  it('waits for cancellation to record completed scopes before another reconnect', async () => {
    let finish!: (r: ManagedOAuthResponse) => void;
    const canceled = new Promise<ManagedOAuthResponse>(resolve => { finish = resolve; });
    const f = fixture(false, r => r.action === 'cancel' ? canceled : undefined, false,
      { mode: 'edit', profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'account' });
    await settle(); f.click('authorize'); await settle();
    f.click('cancel'); f.click('force-reauthorize'); await settle(); f.click('authorize'); await settle();
    expect(f.calls.filter(r => r.action === 'start')).toHaveLength(1);
    finish({ action: 'cancel' }); await settle();
    expect(f.calls.filter(r => r.action === 'start')).toHaveLength(1);
    f.click('authorize'); await settle();
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
    await f.authorizeNew(); await settle();
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
    const f = fixture(); await settle(); f.complete(); await f.authorizeNew(); await settle();
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
    f.input('account-mode', 'new', true); await settle(); f.click('authorize'); await settle();
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
    f.input('account-mode', 'new', true); await settle(); f.click('authorize'); await settle();
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
    f.click('add'); expect(f.host.innerHTML).toContain('Environment API key'); expect(f.host.innerHTML).toContain('Environment Settings');
    f.click('close-setup'); f.input('integration', 'sheets-prod', true); f.input('account-mode', 'existing', true); await settle();
    f.input('account', 'existing-account', true); await settle(); expect(f.host.innerHTML).toContain('affects every tool using this account');
    f.input('delete-confirmation', 'existing-account'); f.click('delete-account'); await settle();
    expect(f.calls).toContainEqual({ action: 'delete_remote_connection', profile_id: 'cloud', integration_id: 'sheets-prod',
      connection_id: 'existing-account', confirmation: 'existing-account' }); f.panel.dispose();
  });
  it('closes a starting popup and cancels a late server session after the target changes', async () => {
    let finish!: (result: ManagedOAuthResponse) => void;
    const started = new Promise<ManagedOAuthResponse>((resolve) => { finish = resolve; });
    const f = fixture(false, (request) => request.action === 'start' ? started : undefined);
    await settle(); await f.authorizeNew(); await settle(); expect(f.panel.busy()).toBe(true);
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
    const f = fixture(); await settle(); await f.authorizeNew(); await settle();
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
    await settle(); await f.authorizeNew(); await settle();
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
    await settle(); await f.authorizeNew(); await settle();
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
    await settle(); await f.authorizeNew(); await settle();
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
    await settle(); await f.authorizeNew(); await settle();
    expect(f.panel.busy()).toBe(false); expect(f.popup.closed).toBe(true);
    expect(f.host.innerHTML).toContain('The broker rejected this API key.');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.calls.filter((r) => r.action === 'status')).toHaveLength(1);
    expect(f.authorized).toEqual([]); f.panel.dispose();
  });
  it('cancels and invalidates consent after a scope edit and ignores late completion', async () => {
    const f = fixture(); await settle(); await f.authorizeNew(); await settle();
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
    const f = fixture(); await settle(); f.complete(); await f.authorizeNew(); await settle();
    expect(f.authorized).toHaveLength(1);
    f.ctx.scopes = ['new-permission']; f.panel.sync(); await settle();
    expect(f.calls).toContainEqual({ action: 'cancel', flow_id: 'flow', claim_secret: 'private-claim' });
    f.panel.dispose();
  });
});


it('manual reauthorization keeps the broker account and explicitly requests fresh consent', async () => {
  const f = fixture(false, undefined, false, { mode: 'switch', reauthorize_current: true, forceReauthorization: true,
    profile_id: 'cloud', integration_id: 'sheets-prod', connection_id: 'existing-account', expected_updated_at: 3 });
  await settle();
  expect(f.calls.some(request => request.action === 'preview' && request.force_reauthorization === true && request.connection_id === 'existing-account')).toBe(true);
  expect(f.calls.some(request => request.action === 'remote_connections')).toBe(false);
  expect(f.host.innerHTML).not.toContain('Authorize a new account');
  f.panel.dispose();
});
