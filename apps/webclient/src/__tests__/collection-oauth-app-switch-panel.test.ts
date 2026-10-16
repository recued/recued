import { describe, expect, it, vi } from 'vitest';
import { OPENER_RELAY_MESSAGE_KIND, type CollectionOAuthAppContext, type CollectionOAuthAppReview, type CollectionOAuthAppOutcome,
  type ManagedOAuthRequest, type ManagedOAuthResponse } from '@recued/contracts';
import { createCollectionOAuthAppSwitchPanel } from '../connections/collection-oauth-app-switch-panel.js';
import { initialAccountsPanelState, renderAccountsPanel } from '@recued/ui-shared';

const targetId = 'app-' + 'a'.repeat(32);
const context = (): CollectionOAuthAppContext => ({
  id: 'c'.repeat(43), fingerprint: 'f'.repeat(64), expires_at: 9999999999999, platform: 'mail', slug: 'work', issuer: 'google',
  current_app: { id: 'default', issuer: 'google', label: 'Old app', client_id: 'old-client', has_secret: true, revision: 1 },
  apps: [{ id: targetId, issuer: 'google', label: 'Work <app>', client_id: 'new-client', has_secret: true, revision: 2 }],
  collections: [{ platform: 'mail', slug: 'work', provider: 'gmail', current: { status: 'known', account_id: 'owner@example.test', email: 'owner@example.test' },
    required_scopes: ['https://www.googleapis.com/auth/gmail.readonly'], selections: ['Inbox'] }], requested_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
});
const review = (): CollectionOAuthAppReview => ({ id: 'r'.repeat(43), fingerprint: 'e'.repeat(64), expires_at: 9999999999999,
  context: context(), app: context().apps[0]!, targets: [context().collections[0]!.current], granted_scopes: context().requested_scopes });
const outcome = (): CollectionOAuthAppOutcome => ({ attempt_id: 'a'.repeat(43), platform: 'mail', slug: 'work', status: 'applied', app_id: targetId,
  collections: [{ platform: 'mail', slug: 'work' }] });
const fixture = (override?: (request: ManagedOAuthRequest) => Promise<ManagedOAuthResponse | undefined>, saved = new Map<string, string>(), blocked = false,
  options: Pick<Parameters<typeof createCollectionOAuthAppSwitchPanel>[0], 'bulk' | 'slotSelector' | 'targetApp' | 'locked'> = {}) => {
  const calls: ManagedOAuthRequest[] = []; const order: string[] = []; const listeners = new Map<string, EventListener[]>();
  const slot = { innerHTML: '', contains: (node: { scope?: string }) => node.scope !== 'other', querySelector: () => ({ focus() {} }) }; const changed = vi.fn(); const openApps = vi.fn();
  const host = { ownerDocument: { defaultView: null }, contains: () => true, querySelector: (s: string) => s.includes('host') || s === '[data-bulk-slot]' ? slot : { focus() {} },
    addEventListener: (type: string, handler: EventListener) => listeners.set(type, [...listeners.get(type) ?? [], handler]),
    removeEventListener: (type: string, handler: EventListener) => listeners.set(type, (listeners.get(type) ?? []).filter(fn => fn !== handler)) } as unknown as HTMLElement;
  let receive: ((ev: { origin: string; data: unknown }) => void) | undefined; let popup: { closed: boolean; location: { href: string }; close(): void } | undefined;
  const call = async (request: ManagedOAuthRequest): Promise<ManagedOAuthResponse> => {
    calls.push(request); order.push(request.action);
    if (override) { const response = await override(request); if (response) return response; }
    if (request.action === 'collection_authentication_app_context') return { action: request.action, context: context() };
    if (request.action === 'collection_authentication_app_authorize') return { action: request.action, authorization: { id: 'i'.repeat(43), context_id: context().id,
      issuer: 'google', app: context().apps[0]!, requested_scopes: context().requested_scopes, expires_at: context().expires_at } };
    if (request.action === 'collection_authentication_app_review') return { action: request.action, review: review() };
    if (request.action === 'collection_authentication_app_apply' || request.action === 'collection_authentication_app_status') return { action: request.action, outcome: outcome() };
    return { action: 'collection_authentication_app_retire' };
  };
  const panel = createCollectionOAuthAppSwitchPanel({ host, call, changed, openApps, now: () => 1000, id: () => 'a'.repeat(43), ...options,
    storage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); }, removeItem: key => { saved.delete(key); } },
    oauth: () => ({ openPopup: () => { order.push('popup'); if (blocked) return null; popup = { closed: false, location: { href: '' }, close() { this.closed = true; } }; return popup; },
      env: { origin: 'https://app.recued.com', randomState: () => 'test-state', onMessage: fn => { receive = fn; return () => { receive = undefined; }; },
        setTimeout: () => () => {}, setInterval: () => () => {} } }),
  });
  const click = (action: string, scope = 'own') => { const node = { scope, dataset: { oauthAppSwitchAction: action }, getAttribute: () => null, closest() { return this; } };
    for (const handler of listeners.get('click') ?? []) handler({ target: node, preventDefault() {} } as unknown as Event); };
  const finish = (data = { code: 'fixture-code' }) => receive?.({ origin: 'https://app.recued.com', data: { kind: OPENER_RELAY_MESSAGE_KIND,
    state: new URL(popup!.location.href).searchParams.get('state'), ...data } });
  const authorize = async () => { click('authorize'); await vi.waitFor(() => expect(popup?.location.href).toContain('client_id=new-client')); finish();
    await vi.waitFor(() => expect(panel.snapshot().review).toBeDefined()); };
  const scopes = (value: string) => {
    const node = { value, hasAttribute: (name: string) => name === 'data-oauth-reauthorization-scopes' };
    for (const handler of listeners.get('input') ?? []) handler({ target: node } as unknown as Event);
  };
  const permission = (feature: string, checked: boolean) => {
    const node = { checked, dataset: { permissionPlatform: 'mail', permissionSlug: 'work', permissionFeature: feature },
      getAttribute: (name: string) => name === 'data-collection-permission-owner' ? 'oauth-app' : null };
    for (const handler of listeners.get('change') ?? []) handler({ type: 'change', target: node } as unknown as Event);
  };
  return { panel, slot, calls, order, click, scopes, permission, saved, changed, openApps, popup: () => popup, finish, authorize };
};
describe('switch saved OAuth app owner flow', () => {
  it('scopes bulk card actions to their own slot and leaves apply to the coordinator', async () => {
    const f = fixture(undefined, undefined, false, { bulk: true, slotSelector: '[data-bulk-slot]', targetApp: context().apps[0]! });
    await f.panel.open('mail', 'work'); f.click('authorize', 'other'); expect(f.calls).toHaveLength(1);
    await f.authorize(); expect(f.slot.innerHTML).toContain('Verified for bulk apply'); expect(f.slot.innerHTML).not.toContain('Apply OAuth app switch');
    f.click('apply'); expect(f.calls.some(r => r.action === 'collection_authentication_app_apply')).toBe(false);
    await f.panel.apply(); expect(f.calls.filter(r => r.action === 'collection_authentication_app_apply')).toHaveLength(1); f.panel.dispose();
  });
  it('blocks actions while another bulk card is authorizing or the queue is applying', async () => {
    const f = fixture(undefined, undefined, false, { bulk: true, locked: () => true }); await f.panel.open('mail', 'work'); f.click('authorize');
    expect(f.calls).toHaveLength(1); expect(f.popup()).toBeUndefined(); f.panel.dispose();
  });
  it('rejects a changed pinned destination before consent', async () => {
    const f = fixture(undefined, undefined, false, { bulk: true, targetApp: { ...context().apps[0]!, revision: 3 } });
    await f.panel.open('mail', 'work'); expect(f.slot.innerHTML).toContain('selected saved app changed'); f.click('authorize');
    expect(f.calls.some(r => r.action === 'collection_authentication_app_authorize')).toBe(false); f.panel.dispose();
  });
  it('never falls back to a different app when another client already selected the bulk destination', async () => {
    const ctx = context(); const destination = ctx.apps[0]!; const old = ctx.current_app;
    const f = fixture(async request => request.action === 'collection_authentication_app_context'
      ? { action: request.action, context: { ...ctx, current_app: destination, apps: [old, destination] } } : undefined,
      undefined, false, { bulk: true, targetApp: destination });
    await f.panel.open('mail', 'work'); f.click('authorize');
    expect(f.calls.some(r => r.action === 'collection_authentication_app_authorize')).toBe(false); expect(f.popup()).toBeUndefined();
    expect(f.slot.innerHTML).toContain('Already using the destination saved app'); f.panel.dispose();
  });
  it('rejects a different app revision in a returned account review', async () => {
    const f = fixture(async request => request.action === 'collection_authentication_app_review'
      ? { action: request.action, review: { ...review(), app: { ...review().app, revision: 3 } } } : undefined);
    await f.panel.open('mail', 'work'); f.click('authorize'); await vi.waitFor(() => expect(f.popup()?.location.href).toContain('client_id=new-client')); f.finish();
    await vi.waitFor(() => expect(f.slot.innerHTML).toContain('could not be verified')); expect(f.panel.snapshot().review).toBeUndefined(); f.panel.dispose();
  });
  it('binds explicit bulk result recovery to its destination app', async () => {
    const f = fixture(); await f.panel.open('mail', 'work', '', { attempt: 'a'.repeat(43), app_id: 'default' });
    expect(f.slot.innerHTML).toContain('result could not be read'); expect(f.calls.map(r => r.action)).toEqual(['collection_authentication_app_status']); f.panel.dispose();
  });
  it('recovers an inherited receipt without inferring the newly selected destination', async () => {
    const f = fixture(async request => request.action === 'collection_authentication_app_status'
      ? { action: request.action, outcome: { ...outcome(), app_id: 'default' } } : undefined,
      undefined, false, { bulk: true, targetApp: context().apps[0]! });
    await f.panel.open('mail', 'work', '', { attempt: 'a'.repeat(43) });
    expect(f.panel.snapshot().outcome?.app_id).toBe('default'); expect(f.panel.snapshot().attempt).toBeUndefined();
    expect(f.calls.map(r => r.action)).toEqual(['collection_authentication_app_status']); f.panel.dispose();
  });
  it('labels an earlier switch to another app separately from the selected bulk destination', async () => {
    const saved = new Map([['recued:collection-oauth-app:mail:work', 'a'.repeat(43)]]);
    const f = fixture(async request => request.action === 'collection_authentication_app_status'
      ? { action: request.action, outcome: { ...outcome(), app_id: 'default' } } : undefined,
      saved, false, { bulk: true, targetApp: context().apps[0]! });
    await f.panel.open('mail', 'work'); expect(f.slot.innerHTML).toContain('earlier switch used a different saved app');
    expect(f.calls.map(r => r.action)).toEqual(['collection_authentication_app_status']); f.panel.dispose();
  });
  it('shows identity, kept resources, callback and permissions before explicit authorization and apply', async () => {
    const f = fixture(); await f.panel.open('mail', 'work');
    expect(f.slot.innerHTML).toContain('owner@example.test'); expect(f.slot.innerHTML).toContain('Inbox');
    expect(f.slot.innerHTML).toContain('Work &lt;app&gt;'); expect(f.slot.innerHTML).toContain('Review requested permissions');
    expect(f.slot.innerHTML).toContain('https://app.recued.com/oauth-callback?recued_relay=opener');
    expect(f.calls).toHaveLength(1); await f.authorize();
    expect(f.order.indexOf('popup')).toBeLessThan(f.order.indexOf('collection_authentication_app_authorize'));
    expect(f.calls).toContainEqual({ action: 'collection_authentication_app_review', authorization_id: 'i'.repeat(43),
      code: 'fixture-code', redirect_uri: 'https://app.recued.com/oauth-callback?recued_relay=opener' });
    expect(f.calls.some(r => r.action === 'collection_authentication_app_apply')).toBe(false);
    f.click('apply'); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('OAuth app switched'));
    expect(f.changed).toHaveBeenCalledOnce(); expect(f.saved.size).toBe(0); f.panel.dispose();
  });
  it('does not start preparation when a popup is blocked', async () => {
    const f = fixture(undefined, undefined, true); await f.panel.open('mail', 'work'); f.click('authorize');
    expect(f.slot.innerHTML).toContain('Allow popups'); expect(f.calls).toHaveLength(1); f.panel.dispose();
  });
  it('keeps a confirmed result when refreshing the account list throws', async () => {
    const f = fixture(); f.changed.mockImplementation(() => { throw Error('list refresh failed'); });
    await f.panel.open('mail', 'work'); await f.authorize(); f.click('apply');
    await vi.waitFor(() => expect(f.slot.innerHTML).toContain('OAuth app switched'));
    expect(f.slot.innerHTML).not.toContain('The reply was lost');
    expect(f.slot.innerHTML).toContain('Refresh the account list');
    expect(f.saved.size).toBe(0); f.panel.dispose();
  });
  it('retires the context and closes a pending popup on cancel', async () => {
    const f = fixture(); await f.panel.open('mail', 'work'); f.click('authorize');
    await vi.waitFor(() => expect(f.popup()?.location.href).toContain('client_id=new-client')); f.click('close');
    await vi.waitFor(() => expect(f.popup()?.closed).toBe(true));
    expect(f.calls).toContainEqual({ action: 'collection_authentication_app_retire', id: context().id });
    expect(f.slot.innerHTML).toBe(''); expect(f.calls.some(r => r.action === 'collection_authentication_app_review')).toBe(false); f.panel.dispose();
  });
  it('recovers a lost apply reply across remount without consent or another apply', async () => {
    const saved = new Map([['recued:collection-oauth-app:mail:work', 'a'.repeat(43)]]);
    const f = fixture(undefined, saved); await f.panel.open('mail', 'work');
    expect(f.slot.innerHTML).toContain('OAuth app switched');
    expect(f.calls.map(r => r.action)).toEqual(['collection_authentication_app_status']);
    expect(saved.size).toBe(0); f.panel.dispose();
  });
  it('allows a fresh review after a failed receipt with a stale restart marker', async () => {
    const saved = new Map([['recued:collection-oauth-app:mail:work', 'a'.repeat(43)]]);
    const f = fixture(async request => request.action === 'collection_authentication_app_status'
      ? { action: request.action, outcome: { ...outcome(), status: 'failed', reason: 'access_failed', restart_needed: outcome().collections } } : undefined, saved);
    await f.panel.open('mail', 'work');
    expect(f.slot.innerHTML).toContain('The saved OAuth app was kept');
    expect(saved.size).toBe(0); expect(f.slot.innerHTML).toContain('Refresh account and apps');
    f.click('refresh'); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Authorize and verify account'));
    expect(f.calls.filter(r => r.action === 'collection_authentication_app_context')).toHaveLength(1); f.panel.dispose();
  });
  it('drops and retires late context replies after disposal', async () => {
    let release!: (r: ManagedOAuthResponse) => void;
    const f = fixture(async request => request.action === 'collection_authentication_app_context'
      ? new Promise(resolve => { release = resolve; }) : { action: 'collection_authentication_app_retire' });
    const pending = f.panel.open('mail', 'work'); f.panel.dispose(); release({ action: 'collection_authentication_app_context', context: context() }); await pending;
    expect(f.slot.innerHTML).toBe(''); expect(f.calls).toContainEqual({ action: 'collection_authentication_app_retire', id: context().id });
  });
  it('persists only the attempt ID after a lost apply reply and recovers without authorizing again', async () => {
    const saved = new Map<string, string>();
    const f = fixture(async request => { if (request.action === 'collection_authentication_app_apply') throw Error('lost reply'); return undefined; }, saved);
    await f.panel.open('mail', 'work'); await f.authorize(); f.click('apply');
    await vi.waitFor(() => expect(f.slot.innerHTML).toContain('The reply was lost'));
    expect([...saved.values()]).toEqual(['a'.repeat(43)]); f.click('authorize');
    expect(f.calls.filter(r => r.action === 'collection_authentication_app_authorize')).toHaveLength(1); f.panel.dispose();
    const reopened = fixture(undefined, saved); await reopened.panel.open('mail', 'work');
    expect(reopened.slot.innerHTML).toContain('OAuth app switched');
    expect(reopened.calls.map(r => r.action)).toEqual(['collection_authentication_app_status']); reopened.panel.dispose();
  });
  it('refuses a mismatched account in a malformed review response', async () => {
    const f = fixture(async request => request.action === 'collection_authentication_app_review'
      ? { action: request.action, review: { ...review(), targets: [{ status: 'known', account_id: 'other-account' }] } } : undefined);
    await f.panel.open('mail', 'work'); f.click('authorize');
    await vi.waitFor(() => expect(f.popup()?.location.href).toContain('client_id=new-client')); f.finish();
    await vi.waitFor(() => expect(f.slot.innerHTML).toContain('could not be verified'));
    expect(f.slot.innerHTML).not.toContain('Apply OAuth app switch');
    expect(f.calls.some(r => r.action === 'collection_authentication_app_apply')).toBe(false); f.panel.dispose();
  });
  it('offers one authentication entry point and exposes app switching inside its chooser', () => {
    const state = initialAccountsPanelState('mail'); state.stage = 'detail'; state.detailSlug = 'work';
    state.rows = [{ slug: 'work', adapterType: 'gmail', authState: 'healthy', oauthAppSwitchAvailable: true }];
    expect(renderAccountsPanel({ state })).toContain('Manage authentication');
    state.authenticationManagement = { slug: 'work', action: 'app' };
    expect(renderAccountsPanel({ state })).toContain('Change OAuth app');
    state.rows[0]!.managedConnectionName = 'broker-account'; expect(renderAccountsPanel({ state })).not.toContain('Change OAuth app');
    delete state.authenticationManagement; delete state.rows[0]!.managedConnectionName;
    state.rows[0]!.adapterType = 'imap'; expect(renderAccountsPanel({ state })).not.toContain('Manage authentication');
  });
});


it('reauthorizes with the current app and refuses a legacy server that ignores the requested operation', async () => {
  const f = fixture(async request => request.action === 'collection_authentication_app_context' ? { action: request.action,
    context: { ...context(), intent: 'reauthorize' } } : undefined);
  await f.panel.reauthorize('mail', 'work'); expect(f.calls[0]).toMatchObject({ intent: 'reauthorize', scopes: [] });
  expect(f.slot.innerHTML).toContain('Current OAuth app'); expect(f.slot.innerHTML).toContain('Additional permissions');
  expect(f.slot.innerHTML).not.toContain('New saved OAuth app'); f.panel.dispose();
  const legacy = fixture(); await legacy.panel.reauthorize('mail', 'work'); legacy.click('authorize');
  expect(legacy.popup()).toBeUndefined(); legacy.panel.dispose();
});


it('reviews edited scopes before opening consent and uses the current app through verified apply', async () => {
  let ctx: CollectionOAuthAppContext;
  const f = fixture(async request => {
    if (request.action === 'collection_authentication_app_context') { ctx = { ...context(), intent: 'reauthorize',
      requested_scopes: [...context().requested_scopes, ...request.scopes ?? []] }; return { action: request.action, context: ctx }; }
    if (request.action === 'collection_authentication_app_authorize') return { action: request.action, authorization: { id: 'i'.repeat(43), context_id: ctx.id,
      issuer: 'google', app: ctx.current_app, requested_scopes: ctx.requested_scopes, expires_at: ctx.expires_at } };
    if (request.action === 'collection_authentication_app_review') return { action: request.action, review: { ...review(), context: ctx, app: ctx.current_app, granted_scopes: ctx.requested_scopes } };
    if (request.action === 'collection_authentication_app_apply') return { action: request.action, outcome: { ...outcome(), intent: 'reauthorize', app_id: 'default' } };
    return undefined;
  });
  await f.panel.reauthorize('mail', 'work'); f.scopes('https://www.googleapis.com/auth/gmail.labels');
  f.click('authorize'); expect(f.popup()).toBeUndefined();
  f.click('refresh'); await vi.waitFor(() => expect(f.calls.filter(r => r.action === 'collection_authentication_app_context')).toHaveLength(2));
  await vi.waitFor(() => expect(f.slot.innerHTML).toContain('gmail.labels</code>'));
  f.click('authorize'); await vi.waitFor(() => expect(f.popup()?.location.href).toContain('client_id=old-client'));
  f.finish(); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Apply reauthorization'));
  f.click('apply'); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Sign-in reauthorized.'));
  expect(f.changed).toHaveBeenCalledOnce(); f.panel.dispose();
});

it('requires a fresh permission review after choosing Send mail and preserves the reviewed current choices', async () => {
  let ctx: CollectionOAuthAppContext;
  const current = { platform: 'mail' as const, slug: 'work', read: true as const, send: false, organize: false };
  const f = fixture(async request => {
    if (request.action === 'collection_authentication_app_context') {
      const selected = request.permissions?.[0] ?? current;
      ctx = { ...context(), intent: 'reauthorize', collections: [{ ...context().collections[0]!, permissions: { current, selected } }],
        requested_scopes: [...context().requested_scopes, ...(selected.platform === 'mail' && selected.send ? ['https://www.googleapis.com/auth/gmail.send'] : [])] };
      return { action: request.action, context: ctx };
    }
    if (request.action === 'collection_authentication_app_authorize') return { action: request.action, authorization: { id: 'i'.repeat(43), context_id: ctx.id,
      issuer: 'google', app: ctx.current_app, requested_scopes: ctx.requested_scopes, expires_at: ctx.expires_at } };
    if (request.action === 'collection_authentication_app_review') return { action: request.action, review: { ...review(), context: ctx, app: ctx.current_app, granted_scopes: ctx.requested_scopes } };
    return undefined;
  });
  await f.panel.reauthorize('mail', 'work'); expect(f.slot.innerHTML).toContain('What Recued can do');
  f.permission('send', true); expect(f.slot.innerHTML).toContain('Send mail: Off → On');
  expect(f.panel.snapshot().context!.collections[0]!.permissions!.selected).toEqual(current);
  f.click('authorize'); expect(f.popup()).toBeUndefined(); f.click('refresh');
  await vi.waitFor(() => expect(f.slot.innerHTML).toContain('gmail.send</code>'));
  expect(f.calls.filter(r => r.action === 'collection_authentication_app_context')[1]).toMatchObject({ permissions: [{ ...current, send: true }] });
  f.click('authorize'); await vi.waitFor(() => expect(f.popup()?.location.href).toContain('client_id=old-client'));
  f.finish(); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Apply reauthorization'));
  f.permission('organize', true); expect(f.panel.snapshot().review!.context.collections[0]!.permissions!.selected).toEqual({ ...current, send: true });
  expect(f.slot.innerHTML).toMatch(/data-permission-feature="organize" disabled>/); f.panel.dispose();
});

it('rejects a server that ignores the selected permission choices', async () => {
  let reads = 0;
  const current = { platform: 'mail' as const, slug: 'work', read: true as const, send: false, organize: false };
  const f = fixture(async request => request.action === 'collection_authentication_app_context' ? { action: request.action,
    context: { ...context(), intent: 'reauthorize', collections: [{ ...context().collections[0]!, ...(reads++ === 0 ? { permissions: { current, selected: current } } : {}) }] } } : undefined);
  await f.panel.reauthorize('mail', 'work'); f.permission('send', true); f.click('refresh');
  await vi.waitFor(() => expect(f.slot.innerHTML).toContain('server did not confirm the selected permission choices'));
  f.click('authorize'); expect(f.popup()).toBeUndefined(); expect(f.panel.snapshot().review).toBeUndefined(); f.panel.dispose();
});
