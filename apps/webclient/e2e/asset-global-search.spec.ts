import { expect, test, type Page } from '@playwright/test';
import type { Asset, YoursReadRequest } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks, SHELL_CONTENT } from './helpers/full-app.js';

declare global { interface Window { __assetSearchDrive: {
  calls: YoursReadRequest[]; holdNext: boolean; failNext: boolean; waiting: boolean;
  removePassport: boolean; recordCalls: number; holdRecords: boolean; release(): void;
} } }
installFullAppHooks();

const input = (page: Page) => page.getByRole('searchbox', { name: 'Search everything' });
const assets = (page: Page) => page.getByRole('region', { name: 'Asset search results' });
const rows = (page: Page) => assets(page).getByRole('link');
const installSearch = async (page: Page, saved = false) => {
  await page.addInitScript(({ saved }) => {
    let release: (() => void) | undefined;
    const drive = { calls: [] as YoursReadRequest[], holdNext: false, failNext: false, waiting: false,
      removePassport: false, recordCalls: 0, holdRecords: saved, release() { release?.(); release = undefined; } };
    const asset = (index: number): Asset => ({ id: index === 15 ? 'passport' : `asset-${index}`,
      name: index === 15 ? 'Ana’s passport' : `Passport wallet ${String(index).padStart(2, '0')}`,
      class_id: 'passport', status: 'active', source_id: 'recued.asset', sync_state: 'live',
      conflict_policy: 'recued_wins', last_seen_at: 1, dates: {}, readings: {}, observations: {}, values: [],
      anchors: [], attributes: {}, settings: {}, rules: [], field_sources: {}, retirement: 'part', created_at: 1, updated_at: 1 });
    Object.assign(window, { __assetSearchDrive: drive, __connectionsFixture: async (method: string, input: unknown) => {
      const args = (input ?? {}) as YoursReadRequest & { query?: string };
      if (method === 'yours.read' && args.search) {
        drive.calls.push(structuredClone(args));
        const all = args.search === 'passport' ? Array.from({ length: 17 }, (_, index) => asset(index))
          .filter(row => !drive.removePassport || row.id !== 'passport') : [];
        const result = { assets: all.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 5)),
          classes: [{ id: 'passport', name: 'Passport' }], total_assets: all.length };
        if (drive.holdNext) {
          drive.holdNext = false; drive.waiting = true;
          await new Promise<void>(done => { release = done; }); drive.waiting = false;
        }
        if (drive.failNext) { drive.failNext = false; return { error: { code: 'unavailable', message: 'Asset search unavailable. Try again.' } }; }
        return { result };
      }
      if (method === 'work_entity.search') return { result: { groups: args.query === 'passport' ? [{ kind: 'task', offset: 0, more: false,
        matches: [{ id: 'check-passport', title: 'Check passport', source_label: 'My tasks', updated_at: 1 }] }] : [] } };
      if (method === 'collection.searchAll') {
        drive.recordCalls += 1;
        if (drive.holdRecords) {
          drive.holdRecords = false; drive.waiting = true;
          await new Promise<void>(done => { release = done; }); drive.waiting = false;
        }
        return { result: { groups: args.query === 'passport' ? [{ slug: 'inbox', platform: 'mail', more: false,
          matches: [{ record_id: 'passport-mail', hot_fields: { subject: 'Passport email' }, rank: 0, received_at: 1 }] }] : [] } };
      }
      if (saved && (method === 'data_views.get' || method === 'data_views.list')) {
        const view = { id: 'travel', name: 'Travel search', definition: { tab: 'search', query: 'passport' }, revision: 1, created_at: 1, updated_at: 1 };
        return { result: method === 'data_views.get' ? { view } : { views: [view] } };
      }
      if (method === 'contact.search.local') return { result: { contacts: [], total: 0 } };
      if (method === 'recipe.list') return { result: { recipes: [] } };
      if (method === 'packs.list') return { result: { packs: [] } };
      return undefined;
    } });
  }, { saved });
  await page.goto(`${HARNESS_URL}?yours=demo${saved ? '#views/travel' : '#data/search'}`);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const settle = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

test('pages assets, opens the existing detail, and retains search results, focus and scroll through Back and Forward', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installSearch(page); await input(page).fill('passport');
  await expect(rows(page)).toHaveCount(5);
  await page.screenshot({ path: testInfo.outputPath('asset-search-desktop.png'), fullPage: true });
  const more = assets(page).getByRole('button', { name: 'More assets', exact: true });
  await more.click(); await expect(rows(page)).toHaveCount(15);
  await more.evaluate(node => { node.scrollIntoView({ block: 'end' }); node.focus({ preventScroll: true }); });
  await page.keyboard.press('Enter');
  await expect(rows(page)).toHaveCount(17);
  const passport = rows(page).filter({ hasText: 'Ana’s passport' });
  await expect(passport).toBeFocused();
  await expect(passport).toBeInViewport({ ratio: 1 });
  await settle(page);
  const scroll = await page.locator(`[${SHELL_CONTENT}]`).evaluate(node => node.scrollTop);
  await page.keyboard.press('Enter');
  const detail = page.locator('[data-recued-yours]');
  await expect(detail.getByRole('heading', { name: 'Ana’s passport', exact: true })).toBeVisible();
  await detail.getByRole('link', { name: 'Back to search', exact: true }).click();
  await expect(input(page)).toHaveValue('passport'); await expect(rows(page)).toHaveCount(17);
  await expect(passport).toBeFocused();
  await expect(page.getByRole('button', { name: /Check passport/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Passport email/ })).toBeVisible();
  await expect.poll(() => page.locator(`[${SHELL_CONTENT}]`).evaluate(node => node.scrollTop)).toBe(scroll);
  await page.goBack();
  await expect(detail.getByRole('heading', { name: 'Ana’s passport', exact: true })).toBeVisible();
  await page.goBack(); await expect(passport).toBeFocused();
  await page.goForward();
  await expect(detail.getByRole('link', { name: 'Back to search', exact: true })).toBeVisible();
  await page.evaluate(() => { window.__assetSearchDrive.removePassport = true; window.__assetSearchDrive.holdNext = true; });
  await page.goBack(); await expect(rows(page)).toHaveCount(17); await expect(passport).toBeFocused();
  await page.waitForFunction(() => window.__assetSearchDrive.waiting);
  await page.evaluate(() => window.__assetSearchDrive.release());
  await expect(rows(page)).toHaveCount(16); await expect(input(page)).toBeFocused();
  const reads = await page.evaluate(() => window.__assetSearchDrive.calls);
  expect(reads.every(read => read.mark_shown === false && read.include_derived === false && read.include_asset_summaries === false)).toBe(true);
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await expect(page).toHaveURL(/#data\/task$/);
  await page.evaluate(() => { location.hash = '#yours/asset/passport'; });
  await expect(detail.getByRole('link', { name: 'Back to assets', exact: true })).toBeVisible();
  await expect(detail.getByRole('link', { name: 'Back to search', exact: true })).toHaveCount(0);
});

test('mobile search keeps ready groups usable, retires old reads, and retries a failed asset page without losing its prefix', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSearch(page);
  await page.evaluate(() => { window.__assetSearchDrive.holdNext = true; });
  await input(page).fill('passport');
  await page.waitForFunction(() => window.__assetSearchDrive.waiting);
  await expect(page.getByRole('button', { name: /Check passport/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Passport email/ })).toBeVisible();
  await expect(page.getByText(/No matches in the searched sources/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Look for/ })).toHaveCount(0);
  await input(page).fill('unmatched');
  await expect(page.getByRole('button', { name: /Look for/ })).toBeVisible();
  await page.evaluate(() => window.__assetSearchDrive.release());
  await expect(rows(page)).toHaveCount(0); await expect(input(page)).toHaveValue('unmatched');
  await input(page).fill('passport'); await expect(rows(page)).toHaveCount(5);
  await page.screenshot({ path: testInfo.outputPath('asset-search-mobile.png'), fullPage: true });
  // A row still in the DOM during the debounce belongs to the retired query.
  const hash = await page.evaluate(() => {
    const row = document.querySelector<HTMLAnchorElement>('[data-search-asset-id]')!;
    const box = document.querySelector<HTMLInputElement>('[data-recued-universal-search-input]')!;
    box.value = 'other'; box.dispatchEvent(new Event('input', { bubbles: true })); row.click();
    box.value = 'passport'; box.dispatchEvent(new Event('input', { bubbles: true }));
    return location.hash;
  });
  expect(hash).toBe('#data/search');
  await expect.poll(() => page.evaluate(() => window.__assetSearchDrive.calls.filter(call => call.search === 'passport' && call.offset === 0).length)).toBe(3);
  await expect(assets(page).getByRole('button', { name: 'More assets', exact: true })).toBeEnabled();
  await page.evaluate(() => { window.__assetSearchDrive.failNext = true; });
  await assets(page).getByRole('button', { name: 'More assets', exact: true }).click();
  await expect(assets(page).getByRole('alert')).toContainText('Asset search unavailable');
  await expect(rows(page)).toHaveCount(5);
  await assets(page).getByRole('button', { name: 'Retry assets', exact: true }).click();
  await expect(rows(page)).toHaveCount(15);
  await expect(rows(page).nth(5)).toBeFocused();
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
});

test('returns to the originating saved Search view and resumes only its interrupted initial groups', async ({ page }) => {
  await installSearch(page, true);
  await expect(input(page)).toHaveValue('passport'); await expect(rows(page)).toHaveCount(5);
  await page.waitForFunction(() => window.__assetSearchDrive.waiting);
  await assets(page).getByRole('button', { name: 'More assets', exact: true }).click();
  await expect(rows(page)).toHaveCount(15);
  await assets(page).getByRole('button', { name: 'More assets', exact: true }).click();
  const passport = rows(page).filter({ hasText: 'Ana’s passport' });
  await expect(passport).toBeFocused(); await page.keyboard.press('Enter');
  const back = page.locator('[data-recued-yours]').getByRole('link', { name: 'Back to search', exact: true });
  await expect(back).toHaveAttribute('href', '#views/travel');
  await back.click();
  await expect(page).toHaveURL(/#views\/travel$/);
  await expect(passport).toBeFocused(); await expect(rows(page)).toHaveCount(17);
  await expect(page.getByRole('button', { name: /Passport email/ })).toBeVisible();
  expect(await page.evaluate(() => window.__assetSearchDrive.recordCalls)).toBe(2);
  expect(await page.evaluate(() => window.__app.rpcCallCount('work_entity.search'))).toBe(1);
  await page.evaluate(() => window.__assetSearchDrive.release());
});
