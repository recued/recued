import { expect, test } from '@playwright/test';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { installFullAppHooks } from './helpers/full-app.js';
import { openViewSearch, findViews, viewResults, viewQuery, viewType, viewHits, viewHit, viewNotice, refreshViews, savedViewId } from './helpers/saved-view-search-fixture.js';
let external: string[] = [];
test.beforeEach(async ({ page }) => {
  external = []; await page.route('**/*', route => new URL(route.request().url()).origin === HARNESS_ORIGIN ? route.continue() : (external.push(route.request().url()), route.abort()));
});
installFullAppHooks();
test.afterEach(async ({ page }) => {
  expect(external).toEqual([]);
  expect(await page.evaluate(() => window.__savedViewSearch?.calls.filter(call => ['execute', 'chat.send', 'work.entity.upsert', 'work.entity.delete'].includes(call.method)
    || /^data_views\.(update|rename|delete|retired\.resolve)$/.test(call.method)) ?? [])).toEqual([]);
});

test('finds names, saved filters, data types and packs in All and Saved views, with safe literal highlights and recorded alert status', async ({ page }) => {
  await openViewSearch(page); await viewQuery(page).fill('overdue'); await expect(viewHit(page, 1)).toBeVisible(); await expect(viewType(page)).toHaveValue('all');
  await expect(viewHit(page, 1)).toContainText('Alerts on'); await expect(viewHit(page, 1)).toContainText('Open tasks');
  for (const [query, count] of [['CAFÉ FILE <img.*>', 1], ['client-desk', 2], ['Contacts', 1], ['Records invoice open', 1], ['private-', 0]]) {
    await findViews(page, query as string); await expect(viewHits(page)).toHaveCount(count as number);
  }
  await expect(viewResults(page).locator('img')).toHaveCount(0); await viewQuery(page).fill(''); await expect(viewHits(page)).toHaveCount(4);
  await expect(viewHit(page, 5)).toHaveCount(0); await expect(viewHit(page, 6)).toHaveCount(0);
  await viewType(page).selectOption('mail'); await expect(viewResults(page)).toHaveCount(0);
});

test('opens exact saved task, contact and filtered Search settings and restores the originating query and focused row', async ({ page }) => {
  await openViewSearch(page);
  for (const [query, n] of [['Overdue', 1], ['Café', 2], ['Failed runs', 3]] as const) {
    await findViews(page, query); await viewHit(page, n).press('Enter'); await expect(page).toHaveURL(new RegExp('#views/' + savedViewId(n) + '$'));
    await expect(page.locator('[data-search-saved-view-return]')).toHaveAttribute('href', '#data/search');
    if (n === 1) {
      await expect(page.getByRole('combobox', { name: 'Task status', exact: true })).toHaveValue('open'); await expect(page.getByRole('combobox', { name: 'Due date', exact: true })).toHaveValue('overdue');
    } else if (n === 2) await expect(page.locator('[data-recued-data-contact-search]')).toHaveValue('Alex');
    else { await expect(viewQuery(page)).toHaveValue('follow-up'); await expect(viewType(page)).toHaveValue('run'); await expect(page.locator('[data-search-run-filter="outcome"]')).toHaveValue('failed'); }
    await page.locator('[data-search-saved-view-return]').click(); await expect(viewQuery(page)).toHaveValue(query); await expect(viewType(page)).toHaveValue('saved_view'); await expect(viewHit(page, n)).toBeFocused();
    if (n === 3) {
      await viewHit(page, n).press('Enter'); await expect(viewQuery(page)).toHaveValue('follow-up');
      await page.goBack(); await expect(viewQuery(page)).toHaveValue(query); await expect(viewHit(page, n)).toBeFocused();
    }
  }
});

test('persists the finder as a Saved View and keeps phone scroll and row focus through Back and browser Back/Forward', async ({ page }, info) => {
  await openViewSearch(page, { width: 390, count: 25 }); await findViews(page, 'Queue');
  const tools = page.locator('[data-saved-data-views]'); await tools.getByRole('button', { name: 'Save current view', exact: true }).click();
  await tools.getByLabel('View name', { exact: true }).fill('Find configured views'); await tools.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(tools.locator('[data-view-notice]')).toContainText('Saved');
  const saved = await page.evaluate(() => window.__savedViewSearch.rows.at(-1)!); expect(saved.definition).toEqual({ tab: 'search', query: 'Queue', result_type: 'saved_view' });
  await page.evaluate(hash => window.__app.setHash(hash), '#views/' + saved.id); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(viewHits(page)).toHaveCount(25); await expect(viewResults(page)).toContainText('Current view');
  const scroll = () => viewHit(page, 25).evaluate(element => { for (let node = element.parentElement; node; node = node.parentElement)
    if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node.scrollTop;
    return document.scrollingElement?.scrollTop ?? 0; });
  for (const browserBack of [false, true]) {
    await viewHit(page, 25).scrollIntoViewIfNeeded(); await viewHit(page, 25).focus(); const before = await scroll(); expect(before).toBeGreaterThan(0); await page.keyboard.press('Enter');
    await expect(page.locator('[data-recued-data-contact-search]')).toHaveValue('Alex'); await expect(page.locator('[data-search-saved-view-return]')).toHaveAttribute('href', '#views/' + saved.id);
    if (browserBack) await page.goBack(); else await page.locator('[data-search-saved-view-return]').click();
    await expect(viewType(page)).toHaveValue('saved_view'); await expect(viewQuery(page)).toHaveValue('Queue'); await expect(viewHits(page)).toHaveCount(25); await expect(viewHit(page, 25)).toBeFocused();
    await expect.poll(async () => Math.abs(await scroll() - before)).toBeLessThanOrEqual(2);
    if (browserBack) { await page.goForward(); await expect(page.locator('[data-recued-data-contact-search]')).toHaveValue('Alex'); await page.goBack(); await expect(viewHit(page, 25)).toBeFocused(); }
  }
  await page.screenshot({ path: info.outputPath('saved-view-search-phone.png'), animations: 'disabled' });
  await viewQuery(page).fill('configured');
  const original = viewResults(page).locator(`[data-search-saved-view-id="${saved.id}"]`);
  await expect(original).toBeVisible(); await original.press('Enter'); await expect(viewQuery(page)).toHaveValue('Queue');
  await page.locator('[data-search-saved-view-return]').click(); await expect(viewQuery(page)).toHaveValue('configured'); await expect(original).toBeFocused();
});

test('refuses stale, hidden and removed selections and rechecks again before mounting the selected view', async ({ page }) => {
  await openViewSearch(page); await findViews(page, 'Overdue');
  await page.evaluate(() => { window.__savedViewSearch.rows = window.__savedViewSearch.rows.map(row => row.id.endsWith('001') ? { ...row, revision: 2, name: 'Changed queue' } : row); });
  await viewHit(page, 1).press('Enter'); await expect(viewNotice(page)).toContainText('could not be confirmed'); await expect(viewNotice(page)).toBeFocused(); await expect(page).toHaveURL(/#data\/search$/u);
  await refreshViews(page).click(); await viewHit(page, 1).press('Enter'); await expect(page.getByRole('combobox', { name: 'Due date', exact: true })).toHaveValue('overdue'); await page.locator('[data-search-saved-view-return]').click();
  await page.evaluate(() => { const selected = window.__savedViewSearch.rows.find(row => row.id.endsWith('001'))!; window.__savedViewSearch.getReplies = [selected, { ...selected, revision: selected.revision + 1 }]; });
  await viewHit(page, 1).press('Enter'); await expect(page.locator('[data-recued-data-route]')).toContainText('Return to search and refresh saved views');
  await expect(page.getByRole('combobox', { name: 'Due date', exact: true })).toHaveCount(0); await page.locator('[data-search-saved-view-return]').click();
  await page.evaluate(() => { window.__savedViewSearch.rows = window.__savedViewSearch.rows.map(row => row.id.endsWith('001') ? { ...row, hidden: true } : row); });
  await viewHit(page, 1).press('Enter'); await expect(viewNotice(page)).toContainText('could not be confirmed'); await refreshViews(page).click(); await expect(viewHits(page)).toHaveCount(0);
});

test('retires held list and exact reads after query edits, type changes and leaving Search', async ({ page }) => {
  await openViewSearch(page); await findViews(page, 'Overdue');
  for (const boundary of ['space', 'type', 'leave']) {
    await page.evaluate(() => { window.__savedViewSearch.held = ['data_views.get']; }); await viewHit(page, 1).press('Enter');
    await expect.poll(() => page.evaluate(() => window.__savedViewSearch.pending('data_views.get'))).toBeGreaterThan(0);
    if (boundary === 'space') await viewQuery(page).fill('Overdue '); else if (boundary === 'type') await viewType(page).selectOption('file'); else await page.evaluate(() => window.__app.setHash('#data/task'));
    await page.evaluate(() => { window.__savedViewSearch.held = []; window.__savedViewSearch.release('data_views.get'); });
    await expect(page).toHaveURL(boundary === 'leave' ? /#data\/task$/u : /#data\/search$/u);
    if (boundary === 'space') { await expect(viewQuery(page)).toBeFocused(); await expect(viewResults(page)).toHaveAttribute('aria-busy', 'false'); }
    if (boundary === 'type') await viewType(page).selectOption('saved_view');
  }
  await page.evaluate(() => window.__app.setHash('#data/search')); await expect(viewQuery(page)).toBeVisible();
  await page.evaluate(() => { window.__savedViewSearch.held = ['data_views.list']; }); await viewQuery(page).fill('Overdue'); await viewType(page).selectOption('saved_view');
  await expect.poll(() => page.evaluate(() => window.__savedViewSearch.pending('data_views.list'))).toBeGreaterThan(0); await page.evaluate(() => window.__app.setHash('#data/task'));
  await page.evaluate(() => { window.__savedViewSearch.held = []; window.__savedViewSearch.release('data_views.list'); }); await expect(page).toHaveURL(/#data\/task$/u); await expect(viewResults(page)).toHaveCount(0);
});

test('reports unavailable lists honestly, retries them, and retires the return link when navigating away from the selected view', async ({ page }) => {
  await openViewSearch(page); await page.evaluate(() => { window.__savedViewSearch.unsupported = true; }); await findViews(page, 'Overdue');
  await expect(viewResults(page)).toContainText('unavailable on this server'); await expect(viewResults(page)).not.toContainText('No saved views match');
  await expect(page.locator('.rq-search')).not.toContainText('No Saved views results loaded'); await expect(viewResults(page)).not.toContainText('private-provider-error');
  await page.evaluate(() => { window.__savedViewSearch.unsupported = false; }); await refreshViews(page).click(); await expect(viewHit(page, 1)).toBeVisible();
  await viewHit(page, 1).press('Enter'); await expect(page.locator('[data-search-saved-view-return]')).toBeVisible();
  await page.evaluate(() => window.__app.setHash('#data/contact')); await expect(page.locator('[data-search-saved-view-return]')).toHaveCount(0);
});

test('keeps legacy Today and Webhooks destinations and restores Search through Back and browser Back', async ({ page }) => {
  await openViewSearch(page, { legacy: true });
  for (const [query, n, hash] of [['My day', 7, '#today'], ['Delivery board', 8, '#connections/webhooks']] as const) {
    await findViews(page, query); await viewHit(page, n).press('Enter'); await expect(page).toHaveURL(new RegExp(hash + '$'));
    await expect(page.getByRole('link', { name: 'Back to search', exact: true })).toBeVisible();
    if (n === 7) await page.getByRole('link', { name: 'Back to search', exact: true }).click(); else await page.goBack();
    await expect(viewQuery(page)).toHaveValue(query); await expect(viewHit(page, n)).toBeFocused();
  }
});
