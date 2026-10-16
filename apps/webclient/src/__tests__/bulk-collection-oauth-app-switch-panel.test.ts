import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { initialAccountsPanelState, renderAccountsPanel } from '@recued/ui-shared';
import type { CollectionOAuthAppContext, CollectionOAuthAppReview, CollectionOAuthAppOutcome, SavedOAuthApp, OAuthAppConfigSnapshot } from '@recued/contracts';
import { createCollectionOAuthAppSwitchPanel } from '../connections/collection-oauth-app-switch-panel.js';
import { createBulkCollectionOAuthAppSwitchPanel, type BulkOAuthAppAccount } from '../connections/bulk-collection-oauth-app-switch-panel.js';
vi.mock('../connections/collection-oauth-app-switch-panel.js', () => ({ createCollectionOAuthAppSwitchPanel: vi.fn() }));

const destination: SavedOAuthApp = { id: 'app-' + 'a'.repeat(32), issuer: 'google', label: 'Work <app>', client_id: 'new-client', has_secret: true, revision: 2 };
const config: OAuthAppConfigSnapshot = { google: { client_id: 'old-client', has_secret: true, source: 'stored', apps: [destination] }, microsoft: { client_id: null, has_secret: false, source: null } };
const refs: BulkOAuthAppAccount[] = [{ platform: 'mail', slug: 'one', issuer: 'google' }, { platform: 'calendar', slug: 'two', issuer: 'google' }];
const context = (platform: 'mail' | 'calendar', slug: string): CollectionOAuthAppContext => ({ id: 'c'.repeat(43), fingerprint: 'f'.repeat(64), expires_at: 600001,
  platform, slug, issuer: 'google', current_app: { ...destination, id: 'default', client_id: 'old-client' }, apps: [destination], requested_scopes: ['read'],
  collections: [{ platform, slug, provider: platform === 'mail' ? 'gmail' : 'gcal', current: { status: 'known', account_id: slug }, required_scopes: ['read'], selections: ['keep'] }] });
type ChildState = ReturnType<ReturnType<typeof createCollectionOAuthAppSwitchPanel>['snapshot']>;
type ChildDeps = Parameters<typeof createCollectionOAuthAppSwitchPanel>[0];
type Plan = { members?: Array<{ platform: 'mail' | 'calendar'; slug: string }>; currentApp?: string; openError?: boolean;
  failed?: boolean; lost?: boolean; gate?: Promise<void>; openGate?: Promise<void>; expired?: boolean; restart?: boolean;
  inheritedAttempt?: string; recoveredAppId?: string; inheritedResult?: boolean };
interface FakeChild {
  reauthorize: Mock<(platform: 'mail' | 'calendar', slug: string) => Promise<void>>;
  snapshot(): ChildState; busy(): boolean; render: Mock<() => void>; dispose: Mock<() => void>; close: Mock<() => void>;
  open: Mock<(platform: 'mail' | 'calendar', slug: string, choice?: string, saved?: { attempt: string; app_id?: string }) => Promise<void>>;
  verify(): void; apply: Mock<() => Promise<void>>; refreshStatus: Mock<() => Promise<void>>; context: Mock<() => void>;
}
const plans = new Map<string, Plan>(); const children: FakeChild[] = []; const cleanup: (() => void)[] = [];
let recovering = false;
const child = (deps: ChildDeps): FakeChild => {
  let selected = refs[0]!; let attemptNumber = 0;
  const state: ChildState = { context: undefined, review: undefined, outcome: undefined, attempt: undefined, busy: false, error: '' };
  const notify = () => deps.updated?.();
  const outcome = (): CollectionOAuthAppOutcome => ({ attempt_id: state.attempt!, platform: selected.platform, slug: selected.slug, status: 'applied', app_id: plans.get(selected.slug)?.recoveredAppId ?? destination.id,
    collections: [{ platform: selected.platform, slug: selected.slug }], ...(plans.get(selected.slug)?.restart ? { restart_needed: [{ platform: selected.platform, slug: selected.slug }] } : {}) });
  const result: FakeChild = {
    reauthorize: vi.fn(async () => {}), snapshot: () => state, busy: () => state.busy, render: vi.fn(), dispose: vi.fn(), close: vi.fn(() => { state.context = undefined; state.review = undefined; }),
    open: vi.fn(async (platform: 'mail' | 'calendar', slug: string, _choice?: string, saved?: { attempt: string; app_id?: string }) => {
      selected = { platform, slug, issuer: 'google' }; const plan = plans.get(slug); await plan?.openGate;
      if (saved) { state.attempt = saved.attempt; if (recovering) { state.outcome = outcome(); if (!plan?.restart) state.attempt = undefined; } notify(); return; }
      if (plan?.inheritedAttempt) {
        state.attempt = plan.inheritedAttempt;
        if (plan.inheritedResult) { state.outcome = outcome(); state.attempt = undefined; } else state.error = 'Result temporarily unreadable';
        notify(); return;
      }
      if (plan?.openError) { state.error = 'Account could not be verified'; return; }
      state.context = context(platform, slug); if (plan?.currentApp) state.context.current_app.id = plan.currentApp;
      if (plan?.members) state.context.collections = plan.members.map(r => ({ ...state.context!.collections[0]!, ...r })); notify();
    }),
    verify() {
      state.review = { id: 'r'.repeat(43), fingerprint: 'e'.repeat(64), expires_at: plans.get(selected.slug)?.expired ? 500 : 600001,
        context: state.context!, app: destination, targets: state.context!.collections.map(r => r.current), granted_scopes: ['read'] }; notify();
    },
    apply: vi.fn(async () => {
      state.attempt = String.fromCharCode(97 + children.indexOf(result) + attemptNumber++).repeat(43); state.busy = true; notify();
      const plan = plans.get(selected.slug); await plan?.gate;
      if (plan?.lost) state.error = 'Reply lost'; else {
        state.outcome = { ...outcome(), ...(plan?.failed ? { status: 'failed', reason: 'access_failed' } : {}) }; state.review = undefined;
        if (!plan?.restart) state.attempt = undefined;
      }
      state.busy = false; notify();
    }),
    refreshStatus: vi.fn(async () => { state.outcome = outcome(); state.attempt = undefined; notify(); }),
    context: vi.fn(),
  };
  return result;
};
beforeEach(() => {
  plans.clear(); children.length = 0; recovering = false;
  vi.mocked(createCollectionOAuthAppSwitchPanel).mockImplementation(deps => { const value = child(deps); children.push(value); return value; });
});
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers(); });
const fixture = (accounts: readonly BulkOAuthAppAccount[] = refs, saved = new Map<string, string>(), failList = false, now = () => 1000) => {
  const listeners = new Map<string, EventListener[]>(); const footer = { innerHTML: '' };
  const slot = { innerHTML: '', contains: () => true, querySelector: (selector: string) => selector === '[data-bulk-app-footer]' ? footer : { focus() {} }, querySelectorAll: () => [] };
  const host = { ownerDocument: { defaultView: null }, querySelector: () => slot,
    addEventListener: (type: string, listener: EventListener) => listeners.set(type, [...listeners.get(type) ?? [], listener]),
    removeEventListener: (type: string, listener: EventListener) => listeners.set(type, (listeners.get(type) ?? []).filter(fn => fn !== listener)) } as unknown as HTMLElement;
  const list = vi.fn(async () => { if (failList) throw Error('List unavailable'); return accounts; }); const apps = vi.fn(async () => config);
  const panel = createBulkCollectionOAuthAppSwitchPanel({ host, call: vi.fn(), accounts: list, apps, changed: vi.fn(), openApps: vi.fn(), now,
    storage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => { saved.set(k, v); }, removeItem: k => { saved.delete(k); } } });
  cleanup.push(() => panel.dispose());
  const fire = (type: string, dataset: Record<string, string>, value = '', checked = true, choice = false) => {
    const node = { dataset, value, checked, closest() { return this; }, hasAttribute: (s: string) => s === 'data-bulk-app-choice' && choice };
    for (const listener of listeners.get(type) ?? []) listener({ target: node, preventDefault() {} } as unknown as Event);
  };
  const click = async (action: string) => { fire('click', { bulkAppAction: action }); await panel.whenLoaded(); };
  return { panel, slot, footer, list, apps, saved, click,
    choose: () => fire('change', {}, 'google:' + destination.id, true, true),
    select: (row: BulkOAuthAppAccount) => fire('change', { bulkAppAccount: row.platform + ':' + row.slug }),
    async prepare() { await panel.open('mail'); this.choose(); accounts.filter(a => a.issuer === 'google').forEach(a => this.select(a)); await click('review'); },
  };
};
describe('bulk native saved-app switching', () => {
  it('offers an entry only on Mail and Calendar lists with eligible native accounts', () => {
    const state = initialAccountsPanelState('mail'); state.bulkOAuthAppSwitchAvailable = true;
    expect(renderAccountsPanel({ state })).not.toContain('Bulk switch saved OAuth apps');
    state.loading = false; state.rows = [{ slug: 'work', adapterType: 'gmail', authState: 'healthy' }];
    expect(renderAccountsPanel({ state })).toContain('Bulk switch saved OAuth apps'); state.lane = 'calendar'; state.rows = [{ slug: 'work', adapterType: 'gcal', authState: 'healthy' }]; expect(renderAccountsPanel({ state })).toContain('Bulk switch saved OAuth apps');
    state.lane = 'file'; expect(renderAccountsPanel({ state })).not.toContain('Bulk switch saved OAuth apps'); state.lane = 'mail'; state.stage = 'form';
    expect(renderAccountsPanel({ state })).not.toContain('Bulk switch saved OAuth apps');
  });
  it('loads without authorizing or writing, filters the vendor, and escapes app names', async () => {
    const f = fixture([...refs, { platform: 'mail', slug: 'microsoft', issuer: 'microsoft' }]); await f.panel.open('mail'); f.choose();
    expect(f.slot.innerHTML).toContain('Work &lt;app&gt;'); expect(f.slot.innerHTML).not.toContain('mail microsoft'); expect(children).toHaveLength(0);
    expect(f.list).toHaveBeenCalledOnce(); expect(f.saved.size).toBe(0);
  });
  it('requires an explicit verified bulk apply and pins the destination on every child', async () => {
    const f = fixture(); await f.prepare(); expect(children).toHaveLength(2);
    expect(vi.mocked(createCollectionOAuthAppSwitchPanel).mock.calls.every(([deps]) => deps.targetApp === destination && deps.bulk)).toBe(true);
    await f.click('apply'); expect(children.every(c => c.apply.mock.calls.length === 0)).toBe(true);
    children.forEach(c => c.verify()); expect(f.footer.innerHTML).toContain('2 sign-in groups ready'); await f.click('apply');
    expect(children.every(c => c.apply.mock.calls.length === 1)).toBe(true); expect(f.footer.innerHTML).toContain('2 switched');
  });
  it('deduplicates a shared grant while keeping unselected companions in its review', async () => {
    plans.set('one', { members: [{ platform: 'mail', slug: 'one' }, { platform: 'calendar', slug: 'two' }, { platform: 'mail', slug: 'companion' }] });
    const f = fixture(); await f.prepare(); expect(children).toHaveLength(1); expect(children[0]!.snapshot().context?.collections).toHaveLength(3);
  });
  it('skips accounts already using the target and never submits them', async () => {
    plans.set('one', { currentApp: destination.id }); const f = fixture(); await f.prepare(); children[1]!.verify(); await f.click('apply');
    expect(f.slot.innerHTML).toContain('Already using the destination'); expect(children[0]!.apply).not.toHaveBeenCalled(); expect(children[1]!.apply).toHaveBeenCalledOnce();
  });
  it('continues after a failed access check and preserves the separate results', async () => {
    plans.set('one', { failed: true }); const f = fixture(); await f.prepare(); children.forEach(c => c.verify()); await f.click('apply');
    expect(children[0]!.snapshot().outcome?.status).toBe('failed'); expect(children[1]!.snapshot().outcome?.status).toBe('applied'); expect(f.footer.innerHTML).toContain('1 switched');
  });
  it('excludes unverified and expired groups while applying verified rows', async () => {
    plans.set('one', { expired: true }); const f = fixture(); await f.prepare(); children.forEach(c => c.verify()); await f.click('apply');
    expect(children[0]!.apply).not.toHaveBeenCalled(); expect(children[1]!.apply).toHaveBeenCalledOnce();
  });
  it('continues after an unreadable account context', async () => {
    plans.set('one', { openError: true }); const f = fixture(); await f.prepare(); expect(children).toHaveLength(2); children[1]!.verify(); await f.click('apply');
    expect(children[0]!.apply).not.toHaveBeenCalled(); expect(children[1]!.apply).toHaveBeenCalledOnce();
  });
  it('stops the remaining queue while allowing the current atomic switch to finish', async () => {
    let release!: () => void; plans.set('one', { gate: new Promise(resolve => { release = resolve; }) });
    const f = fixture(); await f.prepare(); children.forEach(c => c.verify()); const applying = f.click('apply');
    await vi.waitFor(() => expect(children[0]!.apply).toHaveBeenCalledOnce());
    // Stop deliberately does not await the in-flight apply promise.
    const stopping = f.click('stop'); release(); await Promise.all([applying, stopping]);
    expect(children[1]!.apply).not.toHaveBeenCalled(); expect(f.footer.innerHTML).toContain('Remaining groups were not applied');
  });
  it('stops remaining switches on account-view navigation and closes after the current atomic switch', async () => {
    let release!: () => void; plans.set('one', { gate: new Promise(resolve => { release = resolve; }) });
    const f = fixture(); await f.prepare(); children.forEach(c => c.verify()); const applying = f.click('apply');
    await vi.waitFor(() => expect(children[0]!.apply).toHaveBeenCalledOnce()); f.panel.context('mail', 'detail'); release(); await applying;
    expect(children[1]!.apply).not.toHaveBeenCalled(); expect(f.slot.innerHTML).toBe('');
    expect(JSON.parse(f.saved.get('recued:collection-oauth-app:bulk')!)).toHaveLength(1);
  });
  it('does not assign a new destination to an unresolved switch inherited from a single-account flow', async () => {
    plans.set('one', { inheritedAttempt: 'z'.repeat(43) }); const f = fixture(); await f.prepare();
    expect(JSON.parse(f.saved.get('recued:collection-oauth-app:bulk')!)).toEqual([{ platform: 'mail', slug: 'one', attempt: 'z'.repeat(43) }]);
    expect(children.every(c => !c.apply.mock.calls.length)).toBe(true);
  });
  it('does not count a previous switch to another app as applied to the selected destination', async () => {
    plans.set('one', { inheritedAttempt: 'z'.repeat(43), inheritedResult: true, recoveredAppId: 'default' });
    const f = fixture(); await f.prepare(); expect(f.footer.innerHTML).toContain('0 switched');
    expect(children[0]!.snapshot().outcome?.app_id).toBe('default'); expect(children[0]!.apply).not.toHaveBeenCalled();
  });
  it('recovers an inherited switch with an unknown destination without loading accounts or replacing it with the selected app', async () => {
    const saved = new Map([['recued:collection-oauth-app:bulk', JSON.stringify([{ platform: 'mail', slug: 'one', attempt: 'z'.repeat(43) }])]]);
    plans.set('one', { recoveredAppId: 'default' }); recovering = true; const f = fixture(refs, saved, true); await f.panel.open('mail');
    expect(f.list).not.toHaveBeenCalled(); expect(children[0]!.snapshot().outcome?.app_id).toBe('default');
    expect(JSON.parse(saved.get('recued:collection-oauth-app:bulk')!)[0]).toEqual({ platform: 'mail', slug: 'one', attempt: 'z'.repeat(43), app_id: 'default' });
    expect(children[0]!.apply).not.toHaveBeenCalled();
  });
  it('recovers lost and completed receipts after reload without loading accounts or repeating a write', async () => {
    plans.set('one', { lost: true }); const saved = new Map<string, string>(); const f = fixture(refs, saved); await f.prepare(); children.forEach(c => c.verify()); await f.click('apply');
    const raw = saved.get('recued:collection-oauth-app:bulk')!;
    expect(JSON.parse(raw)).toHaveLength(2); expect(raw).not.toMatch(/new-client|secret|code|token|account_id/); f.panel.dispose();
    recovering = true; const reopened = fixture(refs, saved, true); await reopened.panel.open('calendar');
    expect(reopened.list).not.toHaveBeenCalled(); expect(reopened.apps).not.toHaveBeenCalled(); expect(reopened.footer.innerHTML).toContain('2 switched');
    expect(children.slice(2).every(c => c.apply.mock.calls.length === 0)).toBe(true);
  });
  it('keeps result recovery for a committed switch whose sync still needs restarting', async () => {
    plans.set('one', { restart: true }); const f = fixture(); await f.prepare(); children.forEach(c => c.verify()); await f.click('apply');
    expect(f.footer.innerHTML).toMatch(/data-bulk-app-action="again" disabled/); expect(f.saved.has('recued:collection-oauth-app:bulk')).toBe(true);
  });
  it('does not apply anything when reopening saved results', async () => {
    const saved = new Map([['recued:collection-oauth-app:bulk', JSON.stringify([{ platform: 'mail', slug: 'one', app_id: destination.id, attempt: 'a'.repeat(43) }])]]);
    recovering = true; const f = fixture(refs, saved); await f.panel.open('mail'); await f.click('apply'); expect(children[0]!.apply).not.toHaveBeenCalled();
  });
  it('retires all reviews on navigation and ignores a late context without starting the next group', async () => {
    let release!: () => void; plans.set('one', { openGate: new Promise(resolve => { release = resolve; }) });
    const f = fixture(); await f.panel.open('mail'); f.choose(); refs.forEach(f.select); const preparing = f.click('review');
    await vi.waitFor(() => expect(children).toHaveLength(1)); f.panel.context('file', 'list'); release(); await preparing;
    expect(children[0]!.dispose).toHaveBeenCalledOnce(); expect(children).toHaveLength(1); expect(f.slot.innerHTML).toBe('');
  });
  it('clears completed result references only after choosing accounts again', async () => {
    const f = fixture(); await f.prepare(); children.forEach(c => c.verify()); await f.click('apply'); expect(f.saved.size).toBe(1);
    await f.click('again'); expect(f.saved.size).toBe(0); expect(f.list).toHaveBeenCalledTimes(2);
  });
  it('caps selected accounts and creates no more than twenty independent contexts', async () => {
    const many: BulkOAuthAppAccount[] = Array.from({ length: 22 }, (_, i) => ({ platform: 'mail', slug: 'account-' + i, issuer: 'google' }));
    const f = fixture(many); await f.prepare(); expect(children).toHaveLength(20);
  });
  it('expires ready counts locally without fetching or leaving a live timer after disposal', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const f = fixture(refs, undefined, false, () => Date.now());
    await f.prepare(); children.forEach(c => c.verify()); expect(f.footer.innerHTML).toContain('2 sign-in groups ready');
    await vi.advanceTimersByTimeAsync(600001); expect(f.footer.innerHTML).toContain('0 sign-in groups ready');
    expect(children.every(c => !c.apply.mock.calls.length)).toBe(true); expect(f.list).toHaveBeenCalledOnce(); f.panel.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('updates only the expiring card while keeping other reviewed cards mounted', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const f = fixture(refs, undefined, false, () => Date.now());
    await f.prepare(); children.forEach(c => c.verify()); children[1]!.snapshot().review!.expires_at = 1200001;
    const firstRenders = children[0]!.render.mock.calls.length; const secondRenders = children[1]!.render.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600001);
    expect(children[0]!.render).toHaveBeenCalledTimes(firstRenders + 1); expect(children[1]!.render).toHaveBeenCalledTimes(secondRenders);
    expect(f.footer.innerHTML).toContain('1 sign-in groups ready'); expect(f.list).toHaveBeenCalledOnce();
  });
  it('reports corrupt recovery data without starting a switch or preventing a fresh account review', async () => {
    const f = fixture(refs, new Map([['recued:collection-oauth-app:bulk', '{broken']])); await f.panel.open('mail');
    expect(f.footer.innerHTML).toContain('Saved result references could not be read'); expect(f.list).toHaveBeenCalledOnce(); expect(children).toHaveLength(0);
  });
  it('lets a failed account listing be retried without leaving stale choices', async () => {
    const f = fixture(); f.list.mockRejectedValueOnce(Error('List unavailable')); await f.panel.open('mail');
    expect(f.footer.innerHTML).toContain('List unavailable'); expect(f.slot.innerHTML).not.toContain('Work &lt;app&gt;');
    await f.click('reload'); expect(f.list).toHaveBeenCalledTimes(2); expect(f.slot.innerHTML).toContain('Work &lt;app&gt;');
  });
});
