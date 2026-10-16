import { describe, expect, it, vi } from 'vitest';
import type { OAuthAppsResponse, SavedOAuthApp } from '@recued/contracts';
import { createOAuthAppsPanel, type OAuthAppsCaller } from '../settings/oauth-apps-panel.js';
const app = (): SavedOAuthApp => ({ id: 'app-' + 'a'.repeat(32), issuer: 'google', label: 'Work <Google>', client_id: 'work-id', has_secret: true, revision: 4, uses: [] });
const response = (action: OAuthAppsResponse['action'] = 'list', apps = [app()]): OAuthAppsResponse => ({ action, apps });
const fixture = async (call: OAuthAppsCaller = vi.fn(async () => response())) => {
  let html = ''; const listeners = new Map<string, ((event: unknown) => void)[]>();
  const host = { get innerHTML() { return html; }, set innerHTML(value: string) { html = value; }, contains: () => true, querySelector: () => null,
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, [...listeners.get(type) ?? [], fn]), removeEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, (listeners.get(type) ?? []).filter(f => f !== fn)) };
  const panel = createOAuthAppsPanel({ host: host as unknown as HTMLElement, call }); await panel.whenLoaded();
  const click = (action: string, id?: string) => { const node = { dataset: { oauthAppAction: action, oauthAppId: id }, closest: (selector: string) => selector === '[data-oauth-app-action]' ? node : null }; for (const fn of listeners.get('click') ?? []) fn({ target: node }); };
  const field = (name: string, value: string) => { for (const fn of listeners.get('input') ?? []) fn({ target: { dataset: { oauthAppField: name }, value, hasAttribute: () => false } }); };
  const submit = () => { for (const fn of listeners.get('submit') ?? []) fn({ target: { hasAttribute: (key: string) => key === 'data-oauth-app-editor' }, preventDefault() {} }); };
  return { host, panel, click, field, submit };
};
describe('saved OAuth app manager', () => {
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
    let html = ''; const host = { get innerHTML() { return html; }, set innerHTML(value: string) { html = value; }, addEventListener() {}, removeEventListener() {} };
    const panel = createOAuthAppsPanel({ host: host as unknown as HTMLElement, call: () => pending });
    const before = html; panel.dispose(); resolve(response()); await panel.whenLoaded(); expect(html).toBe(before);
  });
});
