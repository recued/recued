import { expect, test, type Page } from '@playwright/test';
import { ACCOUNT_MENU_TRIGGER, HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
const input = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
const recent = (page: Page) => page.getByRole('region', { name: 'Recent searches', exact: true });
const rows = (page: Page) => recent(page).locator('.rq-recent-run');
const search = async (page: Page, query: string) => {
  const before = await page.evaluate(() => window.__recentSearchFixture.reads.length);
  await input(page).fill(query);
  await expect.poll(() => page.evaluate(() => window.__recentSearchFixture.reads.length)).toBe(before + 1);
  await expect(page.locator('[data-search-record]')).toContainText(`${query.trim()} · read ${before + 1}`);
};
const blank = async (page: Page) => { await input(page).fill(''); await expect(recent(page)).toBeVisible(); };

const boot = async (page: Page) => {
  await page.addInitScript(() => {
    const state = { reads: [] as string[], completed: 0, holdNext: false, blocked: false, release: () => {} };
    const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function(key, value) {
      if (state.blocked && key.startsWith('recued.search.recent.v1:')) throw new Error('Session storage blocked');
      set.call(this, key, value);
    };
    Storage.prototype.removeItem = function(key) {
      if (state.blocked && key.startsWith('recued.search.recent.v1:')) throw new Error('Session storage blocked');
      remove.call(this, key);
    };
    Object.assign(window, { __recentSearchFixture: state, __connectionsFixture: async (method: string, raw: unknown) => {
      if (method !== 'collection.searchAll') return undefined;
      const query = String((raw as { query: string }).query);
      state.reads.push(query); const index = state.reads.length;
      if (state.holdNext) { state.holdNext = false; await new Promise<void>(done => { state.release = done; }); }
      state.completed++;
      return { result: { groups: [{ platform: 'mail', slug: 'inbox', more: false,
        source_freshness: { stale: false, last_success_at: Date.now(), age_ms: 0, degraded: false, pending: 0 },
        matches: [{ record_id: 'search-record', rank: -1, hot_fields: { subject: `${query} · read ${index}` } }],
      }] } };
    } });
  });
  await page.goto(`${HARNESS_URL}?server_profiles=multiple&recipes=installed#data/search`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(input(page)).toBeVisible();
};

test('recent searches rerun fresh reads from the keyboard and survive route changes and reloads', async ({ page }) => {
  await boot(page); await search(page, 'Northwind');
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
  await page.evaluate(() => window.__app.setHash('#data/search'));
  await expect(rows(page)).toHaveText(['Northwind']);
  await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(rows(page)).toHaveText(['Northwind']);
  expect(await page.evaluate(() => window.__recentSearchFixture.reads)).toEqual([]);
  await recent(page).getByRole('button', { name: 'Search again for Northwind', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveValue('Northwind'); await expect(input(page)).toBeFocused();
  await expect(page.locator('[data-search-record]')).toContainText('Northwind · read 1');
  expect(await page.evaluate(() => window.__recentSearchFixture.reads)).toEqual(['Northwind']);
  await blank(page);
  await recent(page).getByRole('button', { name: 'Search again for Northwind', exact: true }).click();
  await expect(page.locator('[data-search-record]')).toContainText('Northwind · read 2');
  expect(await page.evaluate(() => window.__recentSearchFixture.reads)).toEqual(['Northwind', 'Northwind']);
});

test('recent searches retain the finished query instead of intermediate typing and checkpoint it on reload', async ({ page }) => {
  await boot(page); await search(page, 'Ren'); await search(page, 'Renewal'); await search(page, 'Renewal deadline');
  await blank(page); await expect(rows(page)).toHaveText(['Renewal deadline']);
  await search(page, 'Customer follow-up');
  await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(rows(page)).toHaveText(['Customer follow-up', 'Renewal deadline']);
});

test('recent searches keep five distinct queries, render text safely, and preserve focus through removal and clear', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await boot(page);
  const literal = 'Renewal <img src=x onerror=alert(1)> & scope';
  for (const query of ['Alpha', literal, 'Gamma', 'Delta', 'Epsilon', 'Zeta', '  gamma  ']) { await search(page, query); await blank(page); }
  await expect(rows(page)).toHaveText(['gamma', 'Zeta', 'Epsilon', 'Delta', literal]);
  await expect(recent(page).locator('img')).toHaveCount(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: testInfo.outputPath('recent-searches-phone-dark.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await recent(page).getByRole('button', { name: 'Remove gamma from recent searches', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(rows(page)).toHaveText(['Zeta', 'Epsilon', 'Delta', literal]);
  await expect(recent(page).getByRole('button', { name: 'Remove Zeta from recent searches', exact: true })).toBeFocused();
  await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(rows(page)).toHaveText(['Zeta', 'Epsilon', 'Delta', literal]);
  await recent(page).getByRole('button', { name: 'Clear history', exact: true }).click();
  await expect(recent(page)).toHaveCount(0); await expect(input(page)).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Search history cleared.' })).toBeVisible();
  await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(recent(page)).toHaveCount(0);
});

test('recent search removal stays retryable when storage fails and late replies cannot repopulate cleared history', async ({ page }) => {
  await boot(page); await search(page, 'First query'); await blank(page);
  await page.evaluate(() => { window.__recentSearchFixture.blocked = true; });
  await recent(page).getByRole('button', { name: 'Remove First query from recent searches', exact: true }).click();
  await expect(rows(page)).toHaveText(['First query']);
  await expect(page.getByRole('alert')).toContainText('Could not update search history. Try again.');
  await recent(page).getByRole('button', { name: 'Clear history', exact: true }).click();
  await expect(rows(page)).toHaveText(['First query']);
  await page.evaluate(() => { window.__recentSearchFixture.blocked = false; window.__recentSearchFixture.holdNext = true; });
  await input(page).fill('Held query');
  await expect.poll(() => page.evaluate(() => window.__recentSearchFixture.reads)).toEqual(['First query', 'Held query']);
  await blank(page);
  await recent(page).getByRole('button', { name: 'Clear history', exact: true }).click();
  await page.evaluate(() => window.__recentSearchFixture.release());
  await expect.poll(() => page.evaluate(() => window.__recentSearchFixture.completed)).toBe(2);
  await expect(input(page)).toHaveValue(''); await expect(recent(page)).toHaveCount(0);
  await expect(page.locator('[data-search-record]')).toHaveCount(0);
  await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(recent(page)).toHaveCount(0);
});

test('recent searches remain bound to their paired server when the owner switches away and back', async ({ page }) => {
  await boot(page); await search(page, 'Personal planning'); await blank(page);
  await page.locator(`[${ACCOUNT_MENU_TRIGGER}]`).click();
  const menu = page.locator('[data-recued-account-menu-popover]');
  const profiles = menu.locator('[data-recued-server-switcher-item]');
  const office = profiles.filter({ hasText: 'Office server' });
  const officeId = await office.getAttribute('data-profile-id');
  expect(officeId).not.toBeNull();
  const personalId = (await profiles.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-profile-id')))).find(id => id && id !== officeId)!;
  expect(personalId).toBeTruthy();
  const switchTo = async (id: string) => {
    await menu.locator(`[data-recued-server-switcher-item][data-profile-id="${id}"]`).click();
    const loaded = page.waitForEvent('load');
    await menu.locator('[data-recued-server-switcher-switch-commit]').click(); await loaded;
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.evaluate(() => window.__app.setHash('#data/search'));
    await expect(input(page)).toBeVisible();
  };
  await switchTo(officeId!);
  await expect(recent(page)).toHaveCount(0);
  await search(page, 'Office follow-up'); await blank(page);
  await expect(rows(page)).toHaveText(['Office follow-up']);
  await page.locator(`[${ACCOUNT_MENU_TRIGGER}]`).click(); await switchTo(personalId);
  await expect(rows(page)).toHaveText(['Personal planning']);
});

declare global { interface Window { __recentSearchFixture: {
  reads: string[]; completed: number; holdNext: boolean; blocked: boolean; release(): void;
} } }
