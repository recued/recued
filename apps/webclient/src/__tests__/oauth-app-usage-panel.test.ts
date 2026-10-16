import { describe, expect, it, vi } from 'vitest';
import { type OAuthAppsRequest, type OAuthAppsResponse, type OAuthAppUsageReview, type OAuthAppSecretRotationOutcome, type SavedOAuthApp } from '@recued/contracts';
import { createOAuthAppUsagePanel } from '../settings/oauth-app-usage-panel.js';
const app = (): SavedOAuthApp => ({ id: 'app-' + 'a'.repeat(32), issuer: 'google', label: 'Work <app>', client_id: 'client', has_secret: true, revision: 1 });
const usage = (): OAuthAppUsageReview => ({ id: 'u'.repeat(43), fingerprint: 'a'.repeat(64), expires_at: 9999999, app: app(), can_rotate: true,
  native_accounts: [{ platform: 'mail', slug: 'work' }], unreadable_connections: [], warnings: [],
  connections: ['one', 'two', 'legacy'].map((name, i) => ({ name, display_name: name + ' display', origin: i === 2 ? 'unknown' : 'confirmed',
    secret_matches: true, client_id_matches: true, group_id: name, group_complete: true, selected_by_default: i !== 2,
    uses: [{ kind: 'pack', id: 'pack', label: 'Pack <name>' }], usage_available: true })) });
const outcome = (selected = ['one', 'two']): OAuthAppSecretRotationOutcome => ({ attempt_id: 'a'.repeat(43), issuer: 'google', app_id: app().id,
  status: 'applied', selected_names: selected, skipped_names: ['legacy'], native_accounts: usage().native_accounts, verification: 'not_checked', app_revision: 2 });
const fixture = async (override?: (r: OAuthAppsRequest) => Promise<OAuthAppsResponse | undefined>, saved = new Map<string, string>()) => {
  const calls: OAuthAppsRequest[] = []; const listeners = new Map<string, EventListener[]>(); const slot = { innerHTML: '' }; let clock = 1000;
  const changed = vi.fn();
  const host = { ownerDocument: { defaultView: null }, contains: () => true, querySelector: (s: string) => s.includes('host') ? slot : { focus() {} },
    addEventListener: (name: string, fn: EventListener) => listeners.set(name, [...listeners.get(name) ?? [], fn]),
    removeEventListener: (name: string, fn: EventListener) => listeners.set(name, (listeners.get(name) ?? []).filter(f => f !== fn)) } as unknown as HTMLElement;
  const call = async (r: OAuthAppsRequest): Promise<OAuthAppsResponse> => {
    calls.push(r); if (override) { const value = await override(r); if (value) return value; }
    if (r.action === 'usage') return { action: r.action, apps: [app()], usage: usage() };
    if (r.action === 'rotate_secret') return { action: r.action, apps: [app()], rotation_outcome: outcome([...r.selected_names]) };
    if (r.action === 'rotation_status') return { action: r.action, apps: [app()], rotation_outcome: outcome() };
    return { action: r.action, apps: [app()] };
  };
  const panel = createOAuthAppUsagePanel({ host, call, changed, now: () => clock, id: () => 'a'.repeat(43), storage: {
    getItem: k => saved.get(k) ?? null, setItem: (k, v) => { saved.set(k, v); }, removeItem: k => { saved.delete(k); } } });
  await panel.whenLoaded();
  const click = (action: string) => {
    const node = { dataset: { appUsageAction: action }, hasAttribute: () => false, closest() { return this; } };
    for (const fn of listeners.get('click') ?? []) fn({ target: node, preventDefault() {} } as unknown as Event);
  };
  const secret = (value: string) => { for (const fn of listeners.get('input') ?? []) fn({ target: { value, dataset: {}, hasAttribute: (n: string) => n === 'data-app-usage-secret' } } as unknown as Event); };
  const choose = (name: string, checked: boolean) => { for (const fn of listeners.get('change') ?? []) fn({ target: { dataset: { appUsageCopy: name }, checked, hasAttribute: () => false } } as unknown as Event); };
  return { panel, calls, slot, click, secret, choose, saved, changed, clock: (n: number) => { clock = n; } };
};
describe('saved app usage and rotation panel', () => {
  it('shows native uses and confirmed copies before an explicit review and apply', async () => {
    const f = await fixture(); await f.panel.open(app());
    expect(f.slot.innerHTML).toContain('Work &lt;app&gt;'); expect(f.slot.innerHTML).toContain('mail work');
    expect(f.slot.innerHTML).toContain('A Google reset revokes the old secret at once');
    expect(f.slot.innerHTML).toContain('Pack &lt;name&gt;'); expect(f.slot.innerHTML).toContain('origin unknown');
    expect(f.calls.map(c => c.action)).toEqual(['usage']); f.click('apply'); expect(f.calls).toHaveLength(1);
    f.secret('fixture-new-secret'); expect(f.panel.hasDraft()).toBe(true); f.click('review'); expect(f.calls).toHaveLength(1);
    expect(f.slot.innerHTML).toContain('Update this saved app and 2 API credential copies');
    f.click('apply'); await f.panel.whenLoaded();
    expect(f.calls).toContainEqual({ action: 'rotate_secret', review_id: usage().id, fingerprint: usage().fingerprint, selected_names: ['one', 'two'], client_secret: 'fixture-new-secret', attempt_id: 'a'.repeat(43) });
    expect(f.slot.innerHTML).toContain('Vendor renewal has not been checked'); expect(f.slot.innerHTML).not.toContain('fixture-new-secret');
    expect(f.saved.size).toBe(0); expect(f.changed).toHaveBeenCalledOnce(); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('allows exclusions and explicit inclusion of a copy with unknown origin', async () => {
    const f = await fixture(); await f.panel.open(app()); f.choose('two', false); f.choose('legacy', true); f.secret('new'); f.click('review'); f.click('apply'); await f.panel.whenLoaded();
    expect(f.calls.find(c => c.action === 'rotate_secret')).toMatchObject({ selected_names: ['legacy', 'one'] }); f.panel.dispose();
  });
  it('selects and excludes all connections in a shared authorization together', async () => {
    const f = await fixture(async r => r.action === 'usage' ? { action: r.action, apps: [app()], usage: { ...usage(), connections: usage().connections.map(c => ({ ...c, group_id: c.name === 'legacy' ? 'legacy' : 'shared' })) } } : undefined);
    await f.panel.open(app()); f.choose('one', false); f.secret('new'); f.click('review');
    expect(f.slot.innerHTML).toContain('0 API credential copies'); f.click('back'); f.choose('two', true); f.click('review');
    expect(f.slot.innerHTML).toContain('2 API credential copies'); f.panel.dispose();
  });
  it('retires an expired review and does not submit the secret', async () => {
    const f = await fixture(); await f.panel.open(app()); f.secret('new'); f.click('review'); f.clock(usage().expires_at + 1); f.click('apply');
    expect(f.slot.innerHTML).toContain('review expired'); expect(f.calls.some(c => c.action === 'rotate_secret')).toBe(false);
    expect(f.calls).toContainEqual({ action: 'retire_usage', id: usage().id }); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('persists only an opaque attempt after a lost reply and recovers without applying again', async () => {
    const saved = new Map<string, string>();
    const f = await fixture(async r => { if (r.action === 'rotate_secret') { expect([...saved.values()]).toEqual(['a'.repeat(43)]); throw Error('lost'); } return undefined; }, saved);
    await f.panel.open(app()); f.secret('private-new-secret'); f.click('review'); f.click('apply'); await f.panel.whenLoaded();
    expect(f.slot.innerHTML).toContain('The reply was lost'); expect(f.slot.innerHTML).not.toContain('private-new-secret');
    expect([...saved.values()]).toEqual(['a'.repeat(43)]); f.click('apply'); expect(f.calls.filter(c => c.action === 'rotate_secret')).toHaveLength(1); f.panel.dispose();
    const reopened = await fixture(undefined, saved); expect(reopened.slot.innerHTML).toContain('Secret rotation saved');
    expect(reopened.calls.map(c => c.action)).toEqual(['rotation_status']); expect(saved.size).toBe(0); reopened.panel.dispose();
  });
  it('keeps confirmed success when a list refresh throws', async () => {
    const f = await fixture(); f.changed.mockImplementation(() => { throw Error('list error'); });
    await f.panel.open(app()); f.secret('new'); f.click('review'); f.click('apply'); await f.panel.whenLoaded();
    expect(f.slot.innerHTML).toContain('Secret rotation saved'); expect(f.slot.innerHTML).not.toContain('The reply was lost'); expect(f.saved.size).toBe(0); f.panel.dispose();
  });
  it('clears failed receipts so the owner can start a fresh review', async () => {
    const saved = new Map([['recued:oauth-app-secret-rotation', 'a'.repeat(43)]]);
    const f = await fixture(async r => r.action === 'rotation_status' ? { action: r.action, apps: [app()], rotation_outcome: { ...outcome(), status: 'failed', reason: 'changed' } } : undefined, saved);
    expect(f.slot.innerHTML).toContain('No secret changes'); expect(saved.size).toBe(0); await f.panel.open(app()); expect(f.calls.filter(c => c.action === 'usage')).toHaveLength(1); f.panel.dispose();
  });
  it('retires usage that arrives after disposal', async () => {
    let release!: (r: OAuthAppsResponse) => void;
    const f = await fixture(async r => r.action === 'usage' ? new Promise(resolve => { release = resolve; }) : undefined);
    const pending = f.panel.open(app()); f.panel.dispose(); release({ action: 'usage', apps: [app()], usage: usage() }); await pending;
    expect(f.calls).toContainEqual({ action: 'retire_usage', id: usage().id });
  });
  it('refuses a locked or incomplete credential inventory', async () => {
    const f = await fixture(async r => r.action === 'usage' ? { action: r.action, apps: [app()], usage: { ...usage(), can_rotate: false, unreadable_connections: ['locked-api'] } } : undefined);
    await f.panel.open(app()); expect(f.slot.innerHTML).toContain('Unreadable API credentials: locked-api');
    f.secret('new'); f.click('review'); f.click('apply'); await f.panel.whenLoaded(); expect(f.calls.some(c => c.action === 'rotate_secret')).toBe(false); f.panel.dispose();
  });
});
