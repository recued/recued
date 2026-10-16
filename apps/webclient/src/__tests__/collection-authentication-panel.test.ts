import { describe, expect, it, vi } from 'vitest';
import type { CollectionAuthenticationReview, CollectionAuthenticationOutcome, ManagedOAuthRequest } from '@recued/contracts';
import { createCollectionAuthenticationPanel } from '../connections/collection-authentication-panel.js';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { initialAccountsPanelState, renderAccountsPanel } from '@recued/ui-shared';

const review = (): CollectionAuthenticationReview => ({ id: 'r'.repeat(43), fingerprint: 'f'.repeat(64), expires_at: 9999999999999,
  platform: 'mail', slug: 'inbox', provider: 'gmail', source: { name: 'native', display_name: 'Your Google app', authentication: 'direct_oauth' },
  current: { status: 'known', account_id: 'owner@example.test', email: 'owner@example.test' },
  target: { status: 'known', account_id: 'owner@example.test', email: 'owner@example.test' }, required_scopes: ['mail-read'],
  selections: ['INBOX'], uses: [{ kind: 'mail', id: 'inbox', label: 'Inbox' }], warnings: ['Keep sync state'] });
const outcome = (status: CollectionAuthenticationOutcome['status'] = 'applied'): CollectionAuthenticationOutcome => ({
  attempt_id: 'a'.repeat(43), platform: 'mail', slug: 'inbox', status, connection_name: 'native', authentication: 'direct_oauth' });
const fixture = (override?: ManagedOAuthCaller, saved = new Map<string, string>()) => {
  const calls: ManagedOAuthRequest[] = []; const listeners = new Map<string, EventListener[]>();
  const slot = { innerHTML: '' }; const heading = { focus: vi.fn() }; const changed = vi.fn(); const openConnections = vi.fn();
  const host = { ownerDocument: { defaultView: null }, contains: () => true,
    querySelector: (s: string) => s.includes('host') ? slot : heading,
    addEventListener: (s: string, listener: EventListener) => listeners.set(s, [...listeners.get(s) ?? [], listener]),
    removeEventListener: (s: string, listener: EventListener) => listeners.set(s, (listeners.get(s) ?? []).filter(l => l !== listener)) } as unknown as HTMLElement;
  const call: ManagedOAuthCaller = async request => {
    calls.push(request); if (override) return override(request);
    if (request.action === 'collection_authentication_candidates') return { action: request.action, sources: [review().source,
      { name: 'broker', display_name: 'Nango', authentication: 'broker' }] };
    if (request.action === 'collection_authentication_review') return { action: request.action, review: review() };
    if (request.action === 'collection_authentication_apply') return { action: request.action, outcome: outcome() };
    if (request.action === 'collection_authentication_status') return { action: request.action, outcome: outcome() };
    if (request.action === 'collection_authentication_retire') return { action: request.action };
    throw new Error('Unexpected fixture action');
  };
  const panel = createCollectionAuthenticationPanel({ host, call, changed, openConnections, id: () => 'a'.repeat(43),
    storage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => { saved.set(k, v); }, removeItem: k => { saved.delete(k); } } });
  const click = (action: string) => {
    const node = { dataset: { collectionAuthAction: action }, closest() { return this; }, getAttribute: () => null };
    for (const handler of listeners.get('click') ?? []) handler({ target: node, preventDefault() {} } as unknown as Event);
  };
  const select = (value: string) => { for (const handler of listeners.get('change') ?? []) handler({ target: { value,
    hasAttribute: (s: string) => s === 'data-collection-auth-source' } } as unknown as Event); };
  const permission = (feature: string, checked: boolean) => {
    const node = { checked, dataset: { permissionPlatform: 'mail', permissionSlug: 'inbox', permissionFeature: feature },
      getAttribute: (name: string) => name === 'data-collection-permission-owner' ? 'collection-auth' : null };
    for (const handler of listeners.get('change') ?? []) handler({ type: 'change', target: node } as unknown as Event);
  };
  return { panel, calls, slot, heading, changed, openConnections, saved, click, select, permission };
};
describe('Mail and Calendar authentication review UI', () => {
  it('reviews matching identity, permissions, and preserved selections before applying', async () => {
    const f = fixture(); await f.panel.open('mail', 'inbox', 'broker'); expect(f.slot.innerHTML).toContain('Your Google app · Recued direct OAuth');
    expect(f.slot.innerHTML).toContain('value="native" selected');
    expect(f.slot.innerHTML).not.toContain('Apply authentication switch'); f.click('review');
    await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Apply authentication switch'));
    expect(f.slot.innerHTML).toContain('Same vendor account verified'); expect(f.slot.innerHTML).toContain('owner@example.test');
    expect(f.slot.innerHTML).toContain('INBOX'); f.click('apply');
    await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Authentication switched'));
    expect(f.calls.filter(c => c.action === 'collection_authentication_apply')).toHaveLength(1); expect(f.changed).toHaveBeenCalledOnce();
    expect(f.saved.size).toBe(0); f.panel.dispose();
  });
  it('retires a review after changing its selected source and labels unavailable email as unknown', async () => {
    const f = fixture(async request => {
      if (request.action === 'collection_authentication_candidates') return { action: request.action, sources: [review().source,
        { name: 'broker', display_name: 'Nango', authentication: 'broker' }] };
      if (request.action === 'collection_authentication_review') return { action: request.action, review: { ...review(),
        current: { status: 'known', account_id: 'inbox-id' }, target: { status: 'known', account_id: 'inbox-id' } } };
      return { action: 'collection_authentication_retire' };
    });
    await f.panel.open('mail', 'inbox'); f.click('review'); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Apply authentication switch'));
    expect(f.slot.innerHTML).toContain('<dd>Unknown</dd>'); f.select('broker');
    expect(f.calls).toContainEqual({ action: 'collection_authentication_retire', review_id: 'r'.repeat(43) });
    expect(f.slot.innerHTML).not.toContain('Apply authentication switch'); f.click('apply');
    expect(f.calls.some(c => c.action === 'collection_authentication_apply')).toBe(false); f.panel.dispose();
  });
  it('recovers a lost reply across remount without another application or authorization', async () => {
    const saved = new Map<string, string>();
    const f = fixture(async request => {
      if (request.action === 'collection_authentication_candidates') return { action: request.action, sources: [review().source] };
      if (request.action === 'collection_authentication_review') return { action: request.action, review: review() };
      if (request.action === 'collection_authentication_apply') throw new Error('network lost');
      return { action: 'collection_authentication_retire' };
    }, saved);
    await f.panel.open('mail', 'inbox'); f.click('review'); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Apply authentication switch'));
    f.click('apply'); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('The reply was lost'));
    f.click('review'); expect(f.calls.filter(c => c.action === 'collection_authentication_review')).toHaveLength(1); f.panel.dispose();
    const reopened = fixture(undefined, saved); await reopened.panel.open('mail', 'inbox');
    await vi.waitFor(() => expect(reopened.slot.innerHTML).toContain('Authentication switched'));
    expect(reopened.calls.some(c => c.action === 'collection_authentication_status')).toBe(true);
    expect(reopened.calls.some(c => c.action === 'collection_authentication_apply')).toBe(false); reopened.panel.dispose();
  });
  it('recovers the durable result even when the saved source list is unavailable', async () => {
    const saved = new Map([['recued:collection-authentication:mail:inbox', 'a'.repeat(43)]]);
    const f = fixture(async request => {
      if (request.action === 'collection_authentication_candidates') throw new Error('source list unavailable');
      if (request.action === 'collection_authentication_status') return { action: request.action, outcome: outcome() };
      throw new Error('Unexpected fixture action');
    }, saved);
    await f.panel.open('mail', 'inbox'); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Authentication switched'));
    expect(saved.size).toBe(0); expect(f.calls.some(c => c.action === 'collection_authentication_apply')).toBe(false); f.panel.dispose();
  });
  it('keeps restart recovery available after reload until the collection runs', async () => {
    const saved = new Map<string, string>(); let running = false;
    const call: ManagedOAuthCaller = async request => {
      if (request.action === 'collection_authentication_candidates') return { action: request.action, sources: [review().source] };
      if (request.action === 'collection_authentication_review') return { action: request.action, review: review() };
      if (request.action === 'collection_authentication_apply' || request.action === 'collection_authentication_status') return {
        action: request.action, outcome: { ...outcome(), ...(running ? {} : { restart_needed: true }) } };
      return { action: 'collection_authentication_retire' };
    };
    const f = fixture(call, saved); await f.panel.open('mail', 'inbox'); f.click('review');
    await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Apply authentication switch')); f.click('apply');
    await vi.waitFor(() => expect(f.slot.innerHTML).toContain('needs a restart')); expect(saved.size).toBe(1); f.panel.dispose();
    const reopened = fixture(call, saved); await reopened.panel.open('mail', 'inbox');
    await vi.waitFor(() => { expect(reopened.slot.innerHTML).toContain('Check result'); expect(reopened.panel.busy()).toBe(false); });
    running = true; reopened.click('status'); await vi.waitFor(() => expect(saved.size).toBe(0));
    expect(reopened.slot.innerHTML).not.toContain('needs a restart'); reopened.panel.dispose();
  });
  it('retires a late review after disposal and ignores its HTML', async () => {
    let release!: (response: Awaited<ReturnType<ManagedOAuthCaller>>) => void;
    const f = fixture(async request => {
      if (request.action === 'collection_authentication_candidates') return { action: request.action, sources: [review().source] };
      if (request.action === 'collection_authentication_review') return new Promise(resolve => { release = resolve; });
      return { action: 'collection_authentication_retire' };
    });
    await f.panel.open('mail', 'inbox'); f.click('review'); f.panel.dispose(); release({ action: 'collection_authentication_review', review: review() });
    await vi.waitFor(() => expect(f.calls.some(c => c.action === 'collection_authentication_retire')).toBe(true));
    expect(f.slot.innerHTML).toBe('');
  });
  it('rejects mixed-version malformed reviews and escapes display names', async () => {
    const f = fixture(async request => {
      if (request.action === 'collection_authentication_candidates') return { action: request.action, sources: [{ ...review().source, display_name: '<script>private</script>' }] };
      if (request.action === 'collection_authentication_review') return { action: request.action, review: { ...review(), fingerprint: '' } };
      return { action: 'collection_authentication_retire' };
    });
    await f.panel.open('mail', 'inbox'); expect(f.slot.innerHTML).toContain('&lt;script&gt;'); f.click('review');
    await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Could not verify')); expect(f.slot.innerHTML).not.toContain('Apply authentication switch'); f.panel.dispose();
  });
  it('offers the entry point only for supported OAuth collections with the server caller', () => {
    const state = initialAccountsPanelState('mail'); state.stage = 'detail'; state.detailSlug = 'inbox';
    state.rows = [{ slug: 'inbox', adapterType: 'gmail', authState: 'healthy', authenticationSwitchAvailable: true }];
    expect(renderAccountsPanel({ state })).toContain('Manage authentication');
    state.rows[0]!.adapterType = 'imap'; expect(renderAccountsPanel({ state })).not.toContain('Manage authentication');
    state.rows[0]!.adapterType = 'gmail'; state.rows[0]!.authenticationSwitchAvailable = false;
    expect(renderAccountsPanel({ state })).not.toContain('Manage authentication');
  });
});

it('reviews connection-backed permission choices with the exact current source and explains Microsoft sending', async () => {
  const current = { platform: 'mail' as const, slug: 'inbox', read: true as const, send: false, organize: false };
  const source = { name: 'broker', display_name: 'Nango', authentication: 'broker' as const };
  const f = fixture(async request => {
    if (request.action === 'collection_authentication_candidates') return { action: request.action, sources: [review().source, source],
      provider: 'graph', current_connection_name: 'broker', permissions: current };
    if (request.action === 'collection_authentication_review') return { action: request.action, review: { ...review(), provider: 'graph', source,
      intent: 'permissions', permissions: { current, selected: request.permissions! } } };
    if (request.action === 'collection_authentication_apply') return { action: request.action, outcome: { ...outcome(), connection_name: 'broker', authentication: 'broker', intent: 'permissions' } };
    return { action: 'collection_authentication_retire' };
  });
  await f.panel.permissions('mail', 'inbox', 'broker'); expect(f.slot.innerHTML).toContain('Mail.Send and Mail.ReadWrite');
  expect(f.slot.innerHTML).toContain('value="broker" selected'); f.select('native'); f.permission('send', true);
  expect(f.slot.innerHTML).toContain('Send mail: Off → On'); expect(f.slot.innerHTML).toContain('Organize mail: Off (kept)');
  f.click('review'); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Apply permission choices'));
  expect(f.calls.find(c => c.action === 'collection_authentication_review')).toMatchObject({ connection_name: 'broker', intent: 'permissions', permissions: { ...current, send: true } });
  f.click('apply'); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Permission choices applied.')); f.panel.dispose();
});

it('does not apply choices if an older server ignores the permission intent', async () => {
  const current = { platform: 'mail' as const, slug: 'inbox', read: true as const, send: false, organize: false };
  const f = fixture(async request => {
    if (request.action === 'collection_authentication_candidates') return { action: request.action, sources: [review().source], provider: 'gmail', current_connection_name: 'native', permissions: current };
    if (request.action === 'collection_authentication_review') return { action: request.action, review: review() };
    return { action: 'collection_authentication_retire' };
  });
  await f.panel.permissions('mail', 'inbox', 'native'); f.permission('send', true); f.click('review');
  await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Could not verify')); expect(f.slot.innerHTML).not.toContain('Apply permission choices');
  f.click('apply'); expect(f.calls.some(c => c.action === 'collection_authentication_apply')).toBe(false);
  f.click('connections'); expect(f.openConnections).toHaveBeenCalledWith('native'); f.panel.dispose();
});

it('updates the current permission summary after a confirmed apply', async () => {
  let current = { platform: 'mail' as const, slug: 'inbox', read: true as const, send: false, organize: false };
  let selected = current;
  const f = fixture(async request => {
    if (request.action === 'collection_authentication_candidates') return { action: request.action, sources: [review().source],
      provider: 'gmail', current_connection_name: 'native', permissions: current };
    if (request.action === 'collection_authentication_review') {
      selected = request.permissions as typeof current;
      return { action: request.action, review: { ...review(), intent: 'permissions', permissions: { current, selected } } };
    }
    if (request.action === 'collection_authentication_apply') { current = structuredClone(selected); return { action: request.action, outcome: { ...outcome(), intent: 'permissions' } }; }
    return { action: 'collection_authentication_retire' };
  });
  await f.panel.permissions('mail', 'inbox', 'native'); f.permission('send', true); f.click('review');
  await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Apply permission choices')); f.click('apply');
  await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Permission choices applied.'));
  await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Send mail: On (kept)'));
  expect(f.slot.innerHTML).not.toContain('Send mail: Off → On');
  f.permission('send', false); expect(f.slot.innerHTML).toContain('Send mail: On → Off'); f.panel.dispose();
});

it('lets the owner revise verified choices and retires the old apply review', async () => {
  const current = { platform: 'mail' as const, slug: 'inbox', read: true as const, send: false, organize: false };
  const f = fixture(async request => {
    if (request.action === 'collection_authentication_candidates') return { action: request.action, sources: [review().source], provider: 'gmail', current_connection_name: 'native', permissions: current };
    if (request.action === 'collection_authentication_review') return { action: request.action, review: { ...review(), intent: 'permissions', permissions: { current, selected: request.permissions! } } };
    return { action: 'collection_authentication_retire' };
  });
  await f.panel.permissions('mail', 'inbox', 'native'); f.permission('send', true); f.click('review');
  await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Apply permission choices'));
  f.click('choices'); expect(f.calls).toContainEqual({ action: 'collection_authentication_retire', review_id: review().id });
  expect(f.slot.innerHTML).not.toContain('Apply permission choices'); f.permission('organize', true);
  expect(f.slot.innerHTML).toContain('Organize mail: Off → On'); f.click('apply');
  expect(f.calls.some(c => c.action === 'collection_authentication_apply')).toBe(false); f.panel.dispose();
});

it('refreshes permission choices after recovering an apply that finished after the initial list read', async () => {
  const saved = new Map([['recued:collection-authentication:mail:inbox', 'a'.repeat(43)]]); let applied = false;
  const current = { platform: 'mail' as const, slug: 'inbox', read: true as const, send: false, organize: false };
  const f = fixture(async request => {
    if (request.action === 'collection_authentication_candidates') return { action: request.action, sources: [review().source], provider: 'gmail', current_connection_name: 'native',
      permissions: { ...current, send: applied } };
    if (request.action === 'collection_authentication_status') { applied = true; return { action: request.action, outcome: { ...outcome(), intent: 'permissions' } }; }
    throw Error('Only recovery reads are allowed');
  }, saved);
  await f.panel.permissions('mail', 'inbox', 'native');
  await vi.waitFor(() => { expect(f.slot.innerHTML).toContain('Send mail: On (kept)'); expect(f.panel.busy()).toBe(false); });
  expect(saved.size).toBe(0); expect(f.calls.filter(c => c.action === 'collection_authentication_candidates')).toHaveLength(2);
  expect(f.calls.some(c => c.action === 'collection_authentication_apply' || c.action === 'collection_authentication_review')).toBe(false); f.panel.dispose();
});

it('keeps a confirmed permission result when its follow-up read fails and requires refreshing choices', async () => {
  const current = { platform: 'mail' as const, slug: 'inbox', read: true as const, send: false, organize: false }; let applied = false; let readFails = true;
  const f = fixture(async request => {
    if (request.action === 'collection_authentication_candidates') {
      if (applied && readFails) throw Error('Local metadata unavailable');
      return { action: request.action, sources: [review().source], provider: 'gmail', current_connection_name: 'native', permissions: { ...current, send: applied } };
    }
    if (request.action === 'collection_authentication_review') return { action: request.action, review: { ...review(), intent: 'permissions', permissions: { current, selected: request.permissions! } } };
    if (request.action === 'collection_authentication_apply') { applied = true; return { action: request.action, outcome: { ...outcome(), intent: 'permissions' } }; }
    return { action: 'collection_authentication_retire' };
  });
  await f.panel.permissions('mail', 'inbox', 'native'); f.permission('send', true); f.click('review');
  await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Apply permission choices')); f.click('apply');
  await vi.waitFor(() => expect(f.slot.innerHTML).toContain('current permission choices could not be read'));
  expect(f.slot.innerHTML).toContain('Permission choices applied.'); expect(f.slot.innerHTML).not.toContain('reply was lost');
  expect(f.slot.innerHTML).not.toContain('Send mail: Off'); expect(f.saved.size).toBe(0);
  expect(f.slot.innerHTML).toContain('data-collection-auth-action="review" disabled');
  readFails = false; f.click('refresh-choices'); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Send mail: On (kept)')); f.panel.dispose();
});

it('keeps a confirmed result when refreshing the parent account view throws', async () => {
  const f = fixture(); f.changed.mockImplementation(() => { throw Error('Account list unavailable'); });
  await f.panel.open('mail', 'inbox'); f.click('review'); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Apply authentication switch'));
  f.click('apply'); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('The change is confirmed. Refresh the account view'));
  expect(f.slot.innerHTML).toContain('Authentication switched.'); expect(f.slot.innerHTML).not.toContain('reply was lost'); expect(f.saved.size).toBe(0); f.panel.dispose();
});

it('uses the current choices verified by the server rather than an older source-list snapshot', async () => {
  const current = { platform: 'mail' as const, slug: 'inbox', read: true as const, send: false, organize: false };
  const f = fixture(async request => {
    if (request.action === 'collection_authentication_candidates') return { action: request.action, sources: [review().source], provider: 'gmail', current_connection_name: 'native', permissions: current };
    if (request.action === 'collection_authentication_review') return { action: request.action, review: { ...review(), intent: 'permissions', permissions: { current: { ...current, send: true }, selected: request.permissions! } } };
    return { action: 'collection_authentication_retire' };
  });
  await f.panel.permissions('mail', 'inbox', 'native'); f.click('review'); await vi.waitFor(() => expect(f.slot.innerHTML).toContain('Apply permission choices'));
  expect(f.slot.innerHTML).toContain('Send mail: On → Off'); f.panel.dispose();
});
