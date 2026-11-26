import { expect, type Page } from '@playwright/test';
import { FIXED_NOW, HARNESS_URL } from './full-app.js';
type Row = Record<string, unknown>;
interface ConnectionSearchFixture {
  mail: Row[]; calendar: Row[]; file: Row[]; cloud: Row[]; api: Row[];
  calls: Array<{ method: string; args: unknown }>; held: string[]; failing: string[]; unsupported: string[];
  pending(method: string): number; release(method: string): void;
}
declare global { interface Window { __connectionSearch: ConnectionSearchFixture } }
export const connectionResults = (page: Page) => page.getByRole('region', { name: 'Connection search results', exact: true });
export const connectionQuery = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
export const connectionType = (page: Page) => page.getByRole('combobox', { name: 'Result type', exact: true });
export const connectionHits = (page: Page) => connectionResults(page).locator('[data-search-connection-key]');
export const connectionHit = (page: Page, href: string) => connectionHits(page).and(page.locator(`a[href="${href}"]`));
export const refreshConnections = (page: Page) => connectionResults(page).getByRole('button', { name: 'Refresh connections', exact: true });
export const connectionNotice = (page: Page) => connectionResults(page).locator('[data-search-connection-focus]');
export const findConnections = async (page: Page, query: string) => {
  await connectionQuery(page).fill(query); await connectionType(page).selectOption('connection');
  await expect(connectionResults(page)).toHaveAttribute('aria-busy', 'false');
};
export const openConnectionSearch = async (page: Page, options: { width?: number; count?: number; oauth?: boolean } = {}) => {
  await page.setViewportSize({ width: options.width ?? 1280, height: 900 }); await page.clock.setFixedTime(FIXED_NOW);
  await page.addInitScript(({ now, options }) => {
    const account = (slug: string, adapter: string, platform: string) => ({ slug, adapter_type: adapter, platform, auth_state: 'healthy', last_synced_at: now,
      caps: { read: true, search: true, list: true }, account_email: slug + '@example.org', send_capable: true, sync_status: { access_verified: true, initial_sync_complete: true } });
    const waiting = new Map<string, Array<() => void>>();
    const fixture: ConnectionSearchFixture = {
      mail: Array.from({ length: options.count ?? 1 }, (_, index) => account(index ? 'work-' + String(index).padStart(2, '0') : 'work', 'gmail', 'mail')),
      calendar: [account('work', 'gcal', 'calendar')], file: [account('work', 'fs', 'file')],
      cloud: [{ source_id: 'projects/one', label: 'Project files', provider: 'sharepoint', last_synced_at: now, stale: true, authentication_connection: 'private-auth' }],
      api: [{ kind: 'api', name: 'crm', display_name: 'Customer CRM', vendor: 'hubspot', updated_at: now, auth_type: options.oauth ? 'oauth2_refresh' : 'bearer',
        base_url: 'https://private-config.invalid', headers: { authorization: 'private-header' }, health: { status: 'auth_failed', last_error: 'private-error' } }],
      calls: [], held: [], failing: [], unsupported: [],
      pending: method => waiting.get(method)?.length ?? 0,
      release(method) { const callbacks = waiting.get(method) ?? []; if (!callbacks.length) throw Error('No pending ' + method); waiting.delete(method); callbacks.forEach(fn => fn()); },
    };
    Object.assign(window, { __connectionSearch: fixture, __connectionsFixture: async (method: string, args: unknown) => {
      fixture.calls.push({ method, args });
      if (fixture.held.includes(method)) await new Promise<void>(resolve => waiting.set(method, [...(waiting.get(method) ?? []), resolve]));
      if (fixture.unsupported.includes(method)) return { error: { code: 'unknown_method', message: 'private-provider-error' } };
      if (fixture.failing.includes(method)) return { error: { code: 'unavailable', message: 'private-provider-error' } };
      if (method === 'collection.mail.list') return { result: { instances: fixture.mail } };
      if (method === 'collection.calendar.list') return { result: { instances: fixture.calendar } };
      if (method === 'collection.listInstances') return { result: { instances: fixture.file } };
      if (method === 'data.file.attachments.sources') return { result: { sources: fixture.cloud } };
      if (method === 'collection.connection.list') return { result: { connections: fixture.api } };
      if (method === 'packs.list') return { result: { packs: [] } };
      return undefined;
    } });
  }, { now: FIXED_NOW, options });
  await page.goto(`${HARNESS_URL}?settle_reads=1&journey=verification#data/search`); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(connectionQuery(page)).toBeVisible();
};
