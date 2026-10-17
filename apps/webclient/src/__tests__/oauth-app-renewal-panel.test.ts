import { describe, expect, it, vi } from 'vitest';
import { type OAuthAppsRequest, type OAuthAppsResponse, type OAuthAppRenewalReview, type OAuthAppRenewalVerification, type SavedOAuthApp } from '@recued/contracts';
import { createOAuthAppRenewalPanel } from '../settings/oauth-app-renewal-panel.js';
const app = (): SavedOAuthApp => ({ id: 'app-' + 'a'.repeat(32), issuer: 'google', label: 'Work <app>', client_id: 'client', has_secret: true, revision: 2 });
const review = (): OAuthAppRenewalReview => ({ id: 'u'.repeat(43), fingerprint: 'a'.repeat(64), expires_at: 10000, app: app(), incomplete: false,
  grants: [{ id: 'b'.repeat(64), revision: 'c'.repeat(64), label: 'Shared <API>', connections: ['one', 'two'], native_accounts: [], eligible: true },
    { id: 'd'.repeat(64), revision: 'e'.repeat(64), label: 'Mail and Calendar', connections: [], native_accounts: [{ platform: 'mail', slug: 'work' }, { platform: 'calendar', slug: 'work' }], eligible: true },
    { id: 'f'.repeat(64), revision: '1'.repeat(64), label: 'Old secret', connections: ['old'], native_accounts: [], eligible: false, reason: 'secret_mismatch' }] });
const outcome = (status: 'checking' | 'completed' = 'completed'): OAuthAppRenewalVerification => ({ id: 'renewal-12345678-1234-4123-8123-123456789abc',
  issuer: app().issuer, app_id: app().id, app_revision: 2, app_label: app().label, status, started_at: 1000, ...(status === 'completed' ? { finished_at: 2000 } : {}), incomplete: false,
  results: review().grants.map(g => ({ ...g, current: 'yes', status: g.eligible && status === 'completed' ? 'passed' : 'unconfirmed',
    ...(g.reason ? { reason: g.reason } : status === 'checking' ? { reason: 'not_checked' } : {}) })) });
const fixture = async (override?: (r: OAuthAppsRequest) => Promise<OAuthAppsResponse | undefined>, saved = new Map<string, string>(), canNavigate = () => true) => {
  let active: { getAttribute(name: string): string | null } | undefined; const focused = vi.fn();
  const calls: OAuthAppsRequest[] = []; const listeners = new Map<string, EventListener[]>(); const slot = { innerHTML: '', contains: () => true, querySelector: (selector: string) => ({ focus: () => focused(selector) }) }; let clock = 1000; const closed = vi.fn();
  const host = { ownerDocument: { get activeElement() { return active; }, defaultView: null }, contains: () => true,
    querySelector: (s: string) => s.includes('host') ? slot : { focus() {} }, addEventListener: (name: string, fn: EventListener) => listeners.set(name, [...listeners.get(name) ?? [], fn]),
    removeEventListener: (name: string, fn: EventListener) => listeners.set(name, (listeners.get(name) ?? []).filter(f => f !== fn)) } as unknown as HTMLElement;
  const call = async (r: OAuthAppsRequest): Promise<OAuthAppsResponse> => {
    calls.push(r); const custom = await override?.(r); if (custom) return custom;
    if (r.action === 'renewal_preview') return { action: r.action, apps: [app()], renewal_review: review() };
    if (r.action === 'renewal_run' || r.action === 'renewal_status') return { action: r.action, apps: [app()], renewal_verification: outcome() };
    return { action: r.action, apps: [app()] };
  };
  const navigate = vi.fn();
  const panel = createOAuthAppRenewalPanel({ host, call, navigate, canNavigate, now: () => clock, id: () => 'a'.repeat(43), storage: { getItem: k => saved.get(k) ?? null,
    setItem: (k, v) => { saved.set(k, v); }, removeItem: k => { saved.delete(k); } } }); await panel.whenLoaded();
  const click = (action: string) => {
    const node = { dataset: { appRenewalAction: action }, hasAttribute: () => false, closest() { return this; } };
    for (const fn of listeners.get('click') ?? []) fn({ target: node, preventDefault() {} } as unknown as Event);
  };
  const choose = (id: string, checked: boolean) => { for (const fn of listeners.get('change') ?? []) fn({ target: { dataset: { appRenewalGrant: id }, checked } } as unknown as Event); };
  return { panel, calls, slot, click, choose, closed, saved, focused, navigate,
    focusGrant: (id: string) => { active = { getAttribute: name => name === 'data-app-renewal-grant' ? id : null }; }, clock: (value: number) => { clock = value; } };
};
describe('saved app renewal review', () => {
  it('opens a separate access review from a completed result without renewing or reading vendor data', async () => {
    const v = outcome();
    const f = await fixture(async r => r.action === 'renewal_preview' ? { action: r.action, apps: [app()], renewal_review: { ...review(), latest: v } } : undefined);
    await f.panel.open(app()); expect(f.slot.innerHTML).toContain('>Verify access</button>');
    f.click('verify-access'); await f.panel.whenLoaded();
    expect(f.navigate).toHaveBeenCalledExactlyOnceWith('#connections/others/verify-access/renewal/' + v.id);
    expect(f.calls.map(c => c.action)).toEqual(['renewal_preview', 'renewal_retire']); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('keeps another draft and hides access actions until renewal finishes', async () => {
    const f = await fixture(async r => r.action === 'renewal_preview' ? { action: r.action, apps: [app()], renewal_review: { ...review(), latest: outcome() } } : undefined, new Map(), () => false);
    await f.panel.open(app()); f.click('verify-access'); expect(f.navigate).not.toHaveBeenCalled(); expect(f.slot.innerHTML).toContain('Save or cancel'); f.panel.dispose();
    const pending = await fixture(async r => r.action === 'renewal_preview' ? { action: r.action, apps: [app()], renewal_review: { ...review(), latest: outcome('checking') } } : undefined);
    await pending.panel.open(app()); expect(pending.slot.innerHTML).not.toContain('>Verify access</button>');
    pending.click('verify-access'); expect(pending.navigate).not.toHaveBeenCalled(); pending.panel.dispose();
  });
  it('clears the cancelled shortcut state before preparing another renewal review', async () => {
    const v = outcome(); Object.assign(v.results[0]!, { status: 'failed', reason: 'grant_rejected' }); let previews = 0;
    let releaseStatus!: (reply: OAuthAppsResponse) => void; let releasePreview!: (reply: OAuthAppsResponse) => void;
    const f = await fixture(async r => {
      if (r.action === 'renewal_status') return new Promise(resolve => { releaseStatus = resolve; });
      if (r.action === 'renewal_preview') return ++previews === 1 ? { action: r.action, apps: [app()], renewal_review: { ...review(), latest: v } }
        : new Promise(resolve => { releasePreview = resolve; });
      return undefined;
    });
    await f.panel.open(app()); f.click('shortcut:' + v.results[0]!.id + ':0'); const cancelled = f.panel.whenLoaded(); f.click('close'); const fresh = f.panel.open(app());
    expect(f.slot.innerHTML).toContain('Preparing the local renewal review');
    releaseStatus({ action: 'renewal_status', apps: [app()], renewal_verification: v }); await cancelled;
    releasePreview({ action: 'renewal_preview', apps: [app()], renewal_review: review() }); await fresh;
    expect(f.navigate).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it('checks a retained failure before opening a repair and retires the unused renewal review', async () => {
    const v = outcome(); Object.assign(v.results[0]!, { status: 'failed', reason: 'grant_rejected' });
    const f = await fixture(async r => r.action === 'renewal_preview' ? { action: r.action, apps: [app()], renewal_review: { ...review(), latest: v } }
      : r.action === 'renewal_status' ? { action: r.action, apps: [app()], renewal_verification: v } : undefined);
    await f.panel.open(app()); expect(f.slot.innerHTML).toContain('Re-authorize API: one');
    f.click('shortcut:' + v.results[0]!.id + ':0'); await f.panel.whenLoaded();
    expect(f.navigate).toHaveBeenCalledExactlyOnceWith('#connections/others/review-access/api/one/from-renewal/google/' + app().id);
    expect(f.calls).toContainEqual({ action: 'renewal_status', id: v.id }); expect(f.calls).toContainEqual({ action: 'renewal_retire', review_id: review().id });
    expect(f.calls.some(c => c.action === 'renewal_run')).toBe(false); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('keeps the result and review when authentication changed before the repair click', async () => {
    const v = outcome(); Object.assign(v.results[0]!, { status: 'failed', reason: 'client_rejected' });
    const fresh = structuredClone(v); fresh.results[0]!.current = 'no';
    const f = await fixture(async r => r.action === 'renewal_preview' ? { action: r.action, apps: [app()], renewal_review: { ...review(), latest: v } }
      : r.action === 'renewal_status' ? { action: r.action, apps: [app()], renewal_verification: fresh } : undefined);
    await f.panel.open(app()); f.click('shortcut:' + v.results[0]!.id + ':0'); await f.panel.whenLoaded();
    expect(f.navigate).not.toHaveBeenCalled(); expect(f.slot.innerHTML).toContain('authorization changed'); expect(f.panel.hasDraft()).toBe(true); f.panel.dispose();
  });
  it('does not discard another draft or navigate after Close overtakes a pending shortcut', async () => {
    const v = outcome(); Object.assign(v.results[0]!, { status: 'failed', reason: 'grant_rejected' });
    const preview = async (r: OAuthAppsRequest) => r.action === 'renewal_preview' ? { action: r.action, apps: [app()], renewal_review: { ...review(), latest: v } } : undefined;
    const blocked = await fixture(preview, new Map(), () => false); await blocked.panel.open(app()); blocked.click('shortcut:' + v.results[0]!.id + ':0'); await blocked.panel.whenLoaded();
    expect(blocked.calls.some(c => c.action === 'renewal_status')).toBe(false); expect(blocked.slot.innerHTML).toContain('Save or cancel'); blocked.panel.dispose();
    let release!: (v: OAuthAppsResponse) => void;
    const f = await fixture(async r => r.action === 'renewal_status' ? new Promise(resolve => { release = resolve; }) : preview(r));
    await f.panel.open(app()); f.click('shortcut:' + v.results[0]!.id + ':0'); f.click('close'); release({ action: 'renewal_status', apps: [app()], renewal_verification: v }); await f.panel.whenLoaded();
    expect(f.navigate).not.toHaveBeenCalled(); expect(f.slot.innerHTML).toBe(''); f.panel.dispose();
  });
  it('retains keyboard focus on a grant when its selection is changed', async () => {
    const f = await fixture(); await f.panel.open(app()); const id = review().grants[0]!.id; f.focusGrant(id); f.choose(id, false);
    expect(f.focused).toHaveBeenCalledWith('[data-app-renewal-grant="' + id + '"]'); f.panel.dispose();
  });
  it('opens a local review, escapes labels, groups copies, and sends only selected eligible groups on Run', async () => {
    const f = await fixture(); await f.panel.open(app(), f.closed);
    expect(f.calls.map(c => c.action)).toEqual(['renewal_preview']); expect(f.slot.innerHTML).toContain('Work &lt;app&gt;');
    expect(f.slot.innerHTML).toContain('Shared &lt;API&gt;'); expect(f.slot.innerHTML).toContain('API: one, API: two'); expect(f.slot.innerHTML).toContain('different secret');
    f.choose('d'.repeat(64), false); f.choose('f'.repeat(64), true); f.click('run'); await f.panel.whenLoaded();
    expect(f.calls.find(c => c.action === 'renewal_run')).toEqual({ action: 'renewal_run', review_id: review().id, fingerprint: review().fingerprint,
      attempt_id: 'a'.repeat(43), selected_ids: ['b'.repeat(64)] });
    expect(f.slot.innerHTML).toContain('A new access token was received and saved'); expect(f.slot.innerHTML).toContain('Verify access separately');
    expect(f.saved.size).toBe(0); f.click('close'); expect(f.closed).toHaveBeenCalledOnce(); f.panel.dispose();
  });
  it('uses only status recovery after losing the start reply, including after remount', async () => {
    const saved = new Map<string, string>(); const f = await fixture(async r => { if (r.action === 'renewal_run') throw Error('lost'); return undefined; }, saved);
    await f.panel.open(app()); f.click('run'); await f.panel.whenLoaded(); expect(f.slot.innerHTML).toContain('Refresh renewal status');
    expect(f.panel.hasDraft()).toBe(true);
    expect([...saved.values()]).toEqual(['a'.repeat(43)]); f.click('run'); expect(f.calls.filter(c => c.action === 'renewal_run')).toHaveLength(1); f.panel.dispose();
    const recovered = await fixture(undefined, saved); expect(recovered.calls).toEqual([{ action: 'renewal_status', attempt_id: 'a'.repeat(43) }]);
    expect(recovered.slot.innerHTML).toContain('Saved renewal results'); expect(saved.size).toBe(0); recovered.panel.dispose();
  });
  it('keeps a background check recoverable after Close and reads it without rerunning renewal', async () => {
    const f = await fixture(async r => r.action === 'renewal_run' ? { action: r.action, apps: [app()], renewal_verification: outcome('checking') } : undefined);
    await f.panel.open(app()); expect(f.panel.hasDraft()).toBe(true); f.click('run'); await f.panel.whenLoaded(); expect(f.slot.innerHTML).toContain('running in the background');
    expect(f.panel.hasDraft()).toBe(false);
    f.click('close'); expect(f.slot.innerHTML).toBe(''); expect(f.panel.hasDraft()).toBe(false); await f.panel.open(app(), f.closed);
    expect(f.calls.filter(c => c.action === 'renewal_run')).toHaveLength(1); expect(f.calls).toContainEqual({ action: 'renewal_status', id: outcome().id });
    f.click('close'); expect(f.closed).toHaveBeenCalledOnce(); f.panel.dispose();
  });
  it('retires late previews without clearing a newer review', async () => {
    let release!: (r: OAuthAppsResponse) => void; let delay = true;
    const f = await fixture(async r => r.action === 'renewal_preview' && delay ? new Promise(resolve => { release = resolve; }) : undefined);
    const older = f.panel.open(app()); f.click('close'); delay = false; await f.panel.open(app());
    release({ action: 'renewal_preview', apps: [app()], renewal_review: { ...review(), id: 'z'.repeat(43) } }); await older;
    expect(f.calls).toContainEqual({ action: 'renewal_retire', review_id: 'z'.repeat(43) });
    f.click('run'); await f.panel.whenLoaded(); expect(f.calls.filter(c => c.action === 'renewal_run')).toHaveLength(1); f.panel.dispose();
  });
  it('blocks expired reviews and handles an old server without starting renewal', async () => {
    const f = await fixture(); await f.panel.open(app()); f.clock(20000); f.click('run'); expect(f.calls.some(c => c.action === 'renewal_run')).toBe(false); f.panel.dispose();
    const old = await fixture(async r => { if (r.action === 'renewal_preview') throw Error('not_configured'); return undefined; });
    await old.panel.open(app()); expect(old.slot.innerHTML).toContain('update the server'); expect(old.calls.some(c => c.action === 'renewal_run')).toBe(false); old.panel.dispose();
  });
  it('shows superseded or unknown proof and distinguishes rejected app credentials from an expired authorization', async () => {
    const v = outcome(); v.results[0] = { ...v.results[0]!, status: 'failed', reason: 'client_rejected', current: 'no' };
    v.results[1] = { ...v.results[1]!, status: 'failed', reason: 'grant_rejected', current: 'unknown' };
    const f = await fixture(async r => r.action === 'renewal_run' ? { action: r.action, apps: [app()], renewal_verification: v } : undefined);
    await f.panel.open(app()); f.click('run'); await f.panel.whenLoaded(); expect(f.slot.innerHTML).toContain('Check the saved Client ID and secret');
    expect(f.slot.innerHTML).toContain('Re-authorize the affected account'); expect(f.slot.innerHTML).toContain('Superseded'); expect(f.slot.innerHTML).toContain('could not be compared'); f.panel.dispose();
  });
});
