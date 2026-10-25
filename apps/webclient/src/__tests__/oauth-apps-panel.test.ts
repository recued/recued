import { describe, expect, it, vi } from 'vitest';
import type { OAuthAppsResponse, SavedOAuthApp } from '@recued/contracts';
import { createOAuthAppsPanel, type OAuthAppsCaller } from '../settings/oauth-apps-panel.js';
const app = (): SavedOAuthApp => ({ id: 'app-' + 'a'.repeat(32), issuer: 'google', label: 'Work <Google>', client_id: 'work-id', has_secret: true, revision: 4, uses: [] });
const response = (action: OAuthAppsResponse['action'] = 'list', apps = [app()]): OAuthAppsResponse => ({ action, apps });
const fixture = async (call: OAuthAppsCaller = vi.fn(async () => response()), saved?: Map<string, string>) => {
  let html = ''; const listeners = new Map<string, ((event: unknown) => void)[]>();
  const host = { get innerHTML() { return html; }, set innerHTML(value: string) { html = value; }, contains: () => true, querySelector: () => null,
    ...(saved ? { ownerDocument: { defaultView: { sessionStorage: { getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); } } } } } : {}),
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, [...listeners.get(type) ?? [], fn]), removeEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, (listeners.get(type) ?? []).filter(f => f !== fn)) };
  const panel = createOAuthAppsPanel({ host: host as unknown as HTMLElement, call }); await panel.whenLoaded();
  const click = (action: string, id?: string) => { const node = { dataset: { oauthAppAction: action, oauthAppId: id }, closest: (selector: string) => selector === '[data-oauth-app-action]' ? node : null }; for (const fn of listeners.get('click') ?? []) fn({ target: node }); };
  const field = (name: string, value: string) => { for (const fn of listeners.get('input') ?? []) fn({ target: { dataset: { oauthAppField: name }, value, hasAttribute: () => false } }); };
  const submit = () => { for (const fn of listeners.get('submit') ?? []) fn({ target: { hasAttribute: (key: string) => key === 'data-oauth-app-editor' }, preventDefault() {} }); };
  const filter = (value: string) => { for (const fn of listeners.get('input') ?? []) fn({ target: { dataset: {}, value, hasAttribute: (key: string) => key === 'data-oauth-app-filter' } }); };
  return { host, panel, click, field, submit, filter };
};
describe('saved OAuth app manager', () => {
  it.each([{ issuer: 'google' as const, id: 'default' }, { issuer: 'microsoft' as const, id: app().id }])('does not substitute a recovered check from $issuer/$id for a targeted app review', async source => {
    const other = { ...app(), ...source, label: 'Other app' }; const jobId = 'renewal-12345678-1234-4123-8123-123456789abc';
    const saved = new Map([['recued:oauth-app-renewal', jobId]]);
    const call = vi.fn<OAuthAppsCaller>(async request => ({ ...response(request.action, [app(), other]), ...(request.action === 'renewal_status'
      ? { renewal_verification: { id: jobId, issuer: other.issuer, app_id: other.id, app_label: other.label, app_revision: other.revision, status: 'checking', started_at: 1, incomplete: false,
        results: [{ id: 'a'.repeat(64), revision: 'b'.repeat(64), label: 'Other account', connections: ['other'], native_accounts: [], eligible: true, status: 'unconfirmed', reason: 'not_checked', current: 'yes' }] } } : {}) }));
    const f = await fixture(call, saved); f.panel.open({ issuer: 'google', id: app().id, view: 'renewal' }); await f.panel.whenLoaded();
    expect(f.host.innerHTML).toContain('Another saved app has an unfinished renewal check');
    expect(call.mock.calls.some(([r]) => r.action === 'renewal_preview' || r.action === 'renewal_run')).toBe(false);
    expect(saved.get('recued:oauth-app-renewal')).toBe(jobId); f.panel.dispose();
  });
  it.each(['usage', 'renewal'] as const)('opens a targeted %s review with freshly loaded app metadata and no write', async view => {
    const call = vi.fn<OAuthAppsCaller>(async args => ({ ...response(args.action),
      ...(args.action === 'usage' ? { usage: { id: 'u'.repeat(43), fingerprint: 'a'.repeat(64), expires_at: Date.now() + 60000, app: app(),
        can_rotate: true, native_accounts: [], connections: [], unreadable_connections: [], warnings: [] } } : {}),
      ...(args.action === 'renewal_preview' ? { renewal_review: { id: 'r'.repeat(43), fingerprint: 'b'.repeat(64), expires_at: Date.now() + 60000, app: app(), grants: [], incomplete: false } } : {}) }));
    const f = await fixture(call); f.panel.open({ issuer: 'google', id: app().id, view }); await f.panel.whenLoaded();
    expect(call.mock.calls.slice(0, 2).map(([request]) => request)).toEqual([{ action: 'list' }, { action: view === 'usage' ? 'usage' : 'renewal_preview', issuer: 'google', id: app().id, expected_revision: 4 }]);
    expect(call.mock.calls.some(([request]) => ['save','rotate_secret','renewal_run'].includes(request.action))).toBe(false); f.panel.dispose();
  });
  it('keeps drafts and missing app targets fail closed', async () => {
    const call = vi.fn<OAuthAppsCaller>(async args => response(args.action)); const f = await fixture(call);
    f.panel.open({ issuer: 'microsoft', id: app().id, view: 'usage' }); await f.panel.whenLoaded();
    expect(f.host.innerHTML).toContain('could not be found'); expect(call).toHaveBeenCalledTimes(1);
    f.click('add'); f.field('label', 'Keep my draft'); f.panel.open({ issuer: 'google', id: app().id, view: 'usage' }); await f.panel.whenLoaded();
    expect(f.panel.hasDraft()).toBe(true); expect(f.host.innerHTML).toContain('Keep my draft'); expect(call).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it('opens renewal from the saved-app row with its current revision and no token request', async () => {
    const call = vi.fn<OAuthAppsCaller>(async args => response(args.action)); const f = await fixture(call); f.click('toggle');
    expect(f.host.innerHTML).toContain('View saved-app history');
    expect(f.host.innerHTML).toContain('href="#connections/others/incident-history/oauth_apps"');
    expect(f.host.innerHTML).toContain('Verify token renewal'); f.click('renewal', 'google:' + app().id); await f.panel.whenLoaded();
    expect(call).toHaveBeenLastCalledWith({ action: 'renewal_preview', issuer: 'google', id: app().id, expected_revision: app().revision });
    expect(call.mock.calls.some(([args]) => args.action === 'renewal_run')).toBe(false); f.panel.dispose();
  });
  it('adds a named app with a write-only secret and clears the mounted secret after success', async () => {
    const call = vi.fn<OAuthAppsCaller>(async args => response(args.action)); const f = await fixture(call);
    f.click('toggle'); expect(f.host.innerHTML).toContain('Work &lt;Google&gt;'); f.click('add');
    f.field('issuer', 'microsoft'); f.field('label', '  Entra work  '); f.field('client-id', 'entra-id'); f.field('secret', 'fixture-new-secret');
    expect(f.panel.hasDraft()).toBe(true); f.submit(); await f.panel.whenLoaded();
    expect(call).toHaveBeenLastCalledWith({ action: 'save', issuer: 'microsoft', label: 'Entra work', client_id: 'entra-id', client_secret: 'fixture-new-secret' });
    expect(f.host.innerHTML).not.toContain('fixture-new-secret'); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('preserves a blank secret and exact app revision on edit; stale errors retain the draft', async () => {
    const call = vi.fn<OAuthAppsCaller>(async args => { if (args.action === 'save') throw new Error('The saved app changed. Refresh before saving.'); return response(); });
    const f = await fixture(call); f.click('toggle'); f.click('edit', 'google:' + app().id); f.field('label', 'Renamed'); f.submit(); await f.panel.whenLoaded();
    expect(call).toHaveBeenLastCalledWith({ action: 'save', issuer: 'google', id: app().id, expected_revision: 4, label: 'Renamed', client_id: 'work-id' });
    expect(f.host.innerHTML).toContain('The saved app changed'); expect(f.panel.hasDraft()).toBe(true);
    f.click('toggle'); expect(f.host.innerHTML).toContain('Save or cancel'); f.panel.dispose();
  });
  it('requires explicit removal and refuses a profile reported in use', async () => {
    const used = { ...app(), id: 'default', uses: [{ lane: 'mail' as const, slug: 'work' }] };
    const call = vi.fn<OAuthAppsCaller>(async args => response(args.action, [app(), used])); const f = await fixture(call); f.click('toggle');
    f.click('remove', 'google:default'); f.click('confirm-remove'); expect(call).toHaveBeenCalledTimes(1);
    f.click('remove', 'google:' + app().id); expect(call).toHaveBeenCalledTimes(1); f.click('confirm-remove'); await f.panel.whenLoaded();
    expect(call).toHaveBeenLastCalledWith({ action: 'delete', issuer: 'google', id: app().id, expected_revision: 4 }); f.panel.dispose();
  });
  it('ignores metadata that finishes after disposal', async () => {
    let resolve!: (value: OAuthAppsResponse) => void; const pending = new Promise<OAuthAppsResponse>(done => { resolve = done; });
    let html = ''; const host = { get innerHTML() { return html; }, set innerHTML(value: string) { html = value; }, querySelector: () => null, addEventListener() {}, removeEventListener() {} };
    const panel = createOAuthAppsPanel({ host: host as unknown as HTMLElement, call: () => pending });
    const before = html; panel.dispose(); resolve(response()); await panel.whenLoaded(); expect(html).toBe(before);
  });
});

describe('a long saved-app list', () => {
  const many = (count: number, extra: Partial<SavedOAuthApp> = {}): SavedOAuthApp[] => Array.from({ length: count }, (_, i) => ({
    ...app(), id: 'app-' + String(i).padStart(32, '0'), issuer: i % 3 === 2 ? 'microsoft' : 'google', label: 'App ' + String(i).padStart(2, '0'),
    client_id: 'client-' + i, ...extra }));
  const listed = (apps: SavedOAuthApp[], expiry = false): OAuthAppsCaller => vi.fn(async args => ({ ...response(args.action, apps), ...(expiry ? { secret_expiry_supported: true } : {}) }));
  const shownRows = (html: string): string[] => [...html.matchAll(/data-oauth-app-row="([^"]+)"(?! hidden)/g)].map(match => match[1]!);

  it('lists each app as one closed row, grouped by vendor, with its actions inside the row', async () => {
    const f = await fixture(listed(many(3))); f.click('toggle'); const html = f.host.innerHTML;
    expect(html.indexOf('data-oauth-app-group="google"')).toBeLessThan(html.indexOf('data-oauth-app-group="microsoft"'));
    expect(html).toMatch(/<details data-oauth-app-details="google:app-0{32}">/);
    const row = html.slice(html.indexOf('data-oauth-app-row="google:app-0'), html.indexOf('</li>', html.indexOf('data-oauth-app-row="google:app-0')));
    expect(row.indexOf('</summary>')).toBeLessThan(row.indexOf('data-oauth-app-action="usage"'));
    expect(html).not.toContain('data-oauth-app-filter'); f.panel.dispose();
  });

  it('shows eight rows and a filter for a long list, and every row on request', async () => {
    const f = await fixture(listed(many(18))); f.click('toggle');
    expect(f.host.innerHTML).toContain('data-oauth-app-filter'); expect(shownRows(f.host.innerHTML)).toHaveLength(8);
    expect(f.host.innerHTML).toContain('Show all 18 apps');
    f.click('show-all'); expect(shownRows(f.host.innerHTML)).toHaveLength(18); expect(f.host.innerHTML).toContain('Show fewer apps');
    // A filter shows every match, cap or not, and says how many; the next render keeps it.
    f.click('show-all'); f.filter('App 0'); f.click('show-all');
    expect(shownRows(f.host.innerHTML)).toHaveLength(10); expect(f.host.innerHTML).toContain('10 of 18 apps');
    expect(f.host.innerHTML).toMatch(/data-oauth-app-action="show-all" hidden/);
    f.panel.dispose();
  });

  it('edits an app inside its own row, which stays open beyond the cap', async () => {
    const apps = many(18); const last = apps.find(a => a.label === 'App 16')!;
    const f = await fixture(listed(apps)); f.click('toggle'); f.click('edit', last.issuer + ':' + last.id); const html = f.host.innerHTML;
    const start = html.indexOf('data-oauth-app-row="' + last.issuer + ':' + last.id + '"');
    expect(html.slice(start, html.indexOf('</li>', start))).toContain('data-oauth-app-editor');
    expect(shownRows(html)).toContain(last.issuer + ':' + last.id);
    expect(html).toMatch(new RegExp('data-oauth-app-details="' + last.issuer + ':' + last.id + '" open'));
    f.panel.dispose();
  });

  it('keeps the three soonest expiry reminders in view and the rest behind one line', async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000); const day = soon.getFullYear() + '-' + String(soon.getMonth() + 1).padStart(2, '0') + '-' + String(soon.getDate()).padStart(2, '0');
    const f = await fixture(listed(many(5, { secret_expires_on: day }), true)); const html = f.host.innerHTML;
    const shown = html.slice(0, html.indexOf('data-oauth-app-expiry-more'));
    expect(shown.match(/data-oauth-app-action="edit-expiry"/g)).toHaveLength(3);
    expect(html).toContain('Show 2 more'); expect(html.match(/data-oauth-app-action="edit-expiry"/g)).toHaveLength(5); f.panel.dispose();
  });
});
