import { expect, type Page } from '@playwright/test';
import type { SavedDataView } from '@recued/contracts';
import { FIXED_NOW, HARNESS_URL } from './full-app.js';
interface SavedViewSearchFixture {
  rows: SavedDataView[]; calls: Array<{ method: string; args: unknown }>;
  held: string[]; failing: string[]; unsupported: boolean; getReplies: Array<SavedDataView | null>;
  pending(method: string): number; release(method: string): void;
}
declare global { interface Window { __savedViewSearch: SavedViewSearchFixture } }
export const savedViewId = (n: number) => `view_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const viewResults = (page: Page) => page.getByRole('region', { name: 'Saved view search results', exact: true });
export const viewQuery = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
export const viewType = (page: Page) => page.getByRole('combobox', { name: 'Result type', exact: true });
export const viewHits = (page: Page) => viewResults(page).locator('[data-search-saved-view-id]');
export const viewHit = (page: Page, n: number) => viewResults(page).locator(`[data-search-saved-view-id="${savedViewId(n)}"]`);
export const viewNotice = (page: Page) => viewResults(page).locator('[data-search-saved-view-focus]');
export const refreshViews = (page: Page) => viewResults(page).getByRole('button', { name: 'Refresh saved views', exact: true });
export const findViews = async (page: Page, query: string) => {
  await viewQuery(page).fill(query); await viewType(page).selectOption('saved_view'); await expect(viewResults(page)).toHaveAttribute('aria-busy', 'false');
};
export const openViewSearch = async (page: Page, options: { width?: number; count?: number; legacy?: boolean } = {}) => {
  await page.setViewportSize({ width: options.width ?? 1280, height: 900 }); await page.clock.setFixedTime(FIXED_NOW);
  await page.addInitScript(({ now, options }) => {
    const id = (n: number) => `view_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const row = (n: number, name: string, definition: SavedDataView['definition'], extra: Partial<SavedDataView> = {}): SavedDataView => ({
      id: id(n), name, definition, revision: 1, created_at: now, updated_at: now, ...extra,
    });
    const seed: SavedDataView[] = options.count ? Array.from({ length: options.count }, (_, n) => row(n + 1, 'Queue ' + String(n + 1).padStart(2, '0'), { tab: 'contact', query: 'Alex' })) : [
      row(1, 'Overdue tasks', { tab: 'task', query: '', source_id: null, booking_lifecycle: 'all', task_filters: { completion: 'open', due: 'overdue', sort: 'due_asc' } },
        { alert: { enabled: true, status: 'watching', time_zone: 'UTC', last_checked_at: now, last_notified_at: null } }),
      row(2, 'Café ﬁle <img.*>', { tab: 'contact', query: 'Alex' }, { pack: { publisher: 'recued-core', slug: 'client-desk' } }),
      row(3, 'Failed runs', { tab: 'search', query: 'follow-up', result_type: 'run', run_filters: { outcome: 'failed', time_range: '7d' } }),
      row(4, 'Invoices', { tab: 'records', owner: { publisher: 'recued-core', pack_slug: 'client-desk' }, entity: 'invoice', filters: { status: { op: 'eq', value: 'open' } }, sort: '-created_at' }),
      row(5, 'private-hidden-board', { tab: 'contact', query: '' }, { pack: { publisher: 'recued-core', slug: 'hidden-pack' }, hidden: true }),
      row(6, 'private-retired-board', { tab: 'contact', query: '' }, { pack: { publisher: 'recued-core', slug: 'old-pack' }, retired: { at: now, replacements: [] } }),
    ];
    if (options.legacy) seed.push(row(7, 'My day', { tab: 'today' }), row(8, 'Delivery board', { tab: 'webhook', collection_slug: null }));
    const key = 'recued-test-saved-data-views'; if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, JSON.stringify(seed));
    const waiting = new Map<string, Array<() => void>>();
    const fixture: SavedViewSearchFixture = {
      get rows() { return JSON.parse(sessionStorage.getItem(key) ?? '[]'); }, set rows(rows) { sessionStorage.setItem(key, JSON.stringify(rows)); },
      calls: [], held: [], failing: [], unsupported: false, getReplies: [], pending: method => waiting.get(method)?.length ?? 0,
      release(method) { const callbacks = waiting.get(method) ?? []; if (!callbacks.length) throw Error('No pending ' + method); waiting.delete(method); callbacks.forEach(fn => fn()); },
    };
    Object.assign(window, { __savedViewSearch: fixture, __connectionsFixture: async (method: string, args: unknown) => {
      fixture.calls.push({ method, args });
      if (fixture.held.includes(method)) await new Promise<void>(resolve => waiting.set(method, [...(waiting.get(method) ?? []), resolve]));
      if (method === 'data_views.list' || method === 'data_views.get') {
        if (fixture.failing.includes(method)) return { error: { code: 'unavailable', message: 'private-provider-error' } };
        if (fixture.unsupported) return { error: { code: 'unknown_method', message: 'private-provider-error' } };
        if (method === 'data_views.list') return { result: { views: fixture.rows.filter(row => !row.retired), retired: fixture.rows.filter(row => !!row.retired), create_once: true } };
        return { result: { view: fixture.getReplies.length ? fixture.getReplies.shift() : fixture.rows.find(row => row.id === (args as { id: string }).id) ?? null } };
      }
      if (method === 'packs.list') return { result: { packs: [] } };
      return undefined;
    } });
  }, { now: FIXED_NOW, options });
  await page.goto(`${HARNESS_URL}?settle_reads=1&journey=verification#data/search`); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(viewQuery(page)).toBeVisible();
};
