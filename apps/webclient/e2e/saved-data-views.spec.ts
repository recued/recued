import { expect, test, type Page } from '@playwright/test';
import { openSavedViewList } from './helpers/saved-data-views.js';

const URL_BASE = 'http://127.0.0.1:4319/full-app-harness.html';
const tools = (page: Page) => page.locator('[data-saved-data-views]');
const query = (page: Page) => page.locator('[data-recued-data-contact-search]');
const ready = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-recued-data-route]')).toBeVisible();
};
/** D-291 — the LIST lives on `#views` now; `#data` keeps only "Save current
 *  view". So a flow that saves and then manages crosses surfaces, exactly as
 *  the owner's does. Once a view is OPEN (`#views/<id>`) the rail carries the
 *  list again, so this is only needed on the first hop out of `#data`. */
const openViewsList = async (page: Page): Promise<void> => {
  await page.evaluate(() => window.__app.setHash('#views'));
  await expect(page.locator('[data-saved-data-views] details')).toBeVisible();
};

const saveView = async (page: Page, name: string): Promise<void> => {
  await tools(page).getByRole('button', { name: 'Save current view', exact: true }).click();
  await tools(page).getByLabel('View name', { exact: true }).fill(name);
  await tools(page).getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText(`Saved “${name}”`);
};

test('Saved views persist search settings through reload, rename, Back, and deletion', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${URL_BASE}?data=contacts#data/contact`);
  await ready(page);
  await query(page).fill('Acme');
  await saveView(page, 'Acme <Team>');
  await openViewsList(page);
  await openSavedViewList(page);
  let link = tools(page).locator('details').getByRole('link', { name: 'Acme <Team>', exact: true });
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^#views\/view_/);
  await link.click();
  await expect(query(page)).toHaveValue('Acme');
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await page.reload();
  await ready(page);
  await expect(query(page)).toHaveValue('Acme');
  expect(await page.evaluate(() => window.__app.rpcCallCount('data_views.create'))).toBe(0);

  await query(page).fill('Changed search');
  await expect(page).toHaveURL(/#data\/contact$/);
  await tools(page).getByRole('link', { name: 'Acme <Team>', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(query(page)).toHaveValue('Acme');

  await openSavedViewList(page);
  await tools(page).getByRole('button', { name: 'Rename Acme <Team>', exact: true }).click();
  await tools(page).getByLabel('View name', { exact: true }).fill('Customers');
  await tools(page).getByRole('button', { name: 'Save view', exact: true }).click();
  link = tools(page).locator('details').getByRole('link', { name: 'Customers', exact: true });
  await expect(link).toHaveAttribute('href', href!);
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await page.goBack();
  await expect(query(page)).toHaveValue('Acme');
  await expect(tools(page)).toContainText('Customers');

  await openSavedViewList(page);
  await tools(page).getByRole('button', { name: 'Delete Customers', exact: true }).click();
  await expect(tools(page).getByRole('group', { name: 'Delete saved view' })).toContainText('Its records will stay');
  await tools(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(tools(page).locator('details').getByRole('link', { name: 'Customers', exact: true })).toBeVisible();
  await tools(page).getByRole('button', { name: 'Delete Customers', exact: true }).click();
  await tools(page).getByRole('button', { name: 'Delete view', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Deleted');
  await expect(query(page)).toHaveValue('Acme');
  await page.evaluate((hash) => window.__app.setHash(hash!), href);
  await page.reload();
  await ready(page);
  await expect(page.getByRole('alert')).toContainText('does not have that saved view any more');
  expect(await page.evaluate(() => window.__app.rpcCallCount('contact.list'))).toBe(0);
  expect(errors).toEqual([]);
});

/** D-291 — the OLD address still opens the view.
 *
 *  ⛔ THIS IS NOT NOSTALGIA, IT IS THE COMPATIBILITY SURFACE. Alert
 *  notifications already delivered carry `#data/view/<id>` — in inboxes and OS
 *  notification centres no server can reach — and browsers keep bookmarks. The
 *  parser re-points that address, and this is the only test that says so; every
 *  other spec was switched to the canonical `#views/<id>` when it moved.
 *
 *  ⚠ The address BAR is not rewritten on arrival, deliberately: the route only
 *  writes an address when it navigates. So this asserts the VIEW opened, not
 *  that the URL changed. */
test('Saved views still open from a pre-D-291 #data/view bookmark', async ({ page }) => {
  await page.goto(`${URL_BASE}?data=contacts#data/contact`);
  await ready(page);
  await query(page).fill('Acme');
  await saveView(page, 'Acme');
  await openViewsList(page);
  await openSavedViewList(page);
  const href = await tools(page).locator('details a').getAttribute('href');
  const id = href!.replace('#views/', '');

  await page.evaluate((legacy) => window.__app.setHash(legacy), `#data/view/${id}`);
  await expect(query(page)).toHaveValue('Acme');
  await expect(tools(page).locator('.saved-data-opened')).toContainText('Acme');
});

test('Saved views keep a missing or unavailable bookmark explicit and retryable', async ({ page }) => {
  await page.goto(`${URL_BASE}?data=contacts&saved_views_get=fail#views/view_00000000-0000-4000-8000-000000000001`);
  await ready(page);
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  expect(await page.evaluate(() => window.__app.rpcCallCount('contact.list'))).toBe(0);
  await page.getByRole('button', { name: 'Retry saved view' }).click();
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  expect(await page.evaluate(() => window.__app.rpcCallCount('data_views.get'))).toBe(2);
  await page.getByRole('link', { name: 'Browse Data', exact: true }).click();
  // ⚠ The escape link is a bare `#data`, and a tabless address lands on
  // Contacts again (D-290 — Today is its own route; D-267 had made this
  // Today). Name the destination rather than proxy for "somewhere usable".
  await expect(page.getByRole('tab', { name: 'Contacts', exact: true }))
    .toHaveAttribute('aria-selected', 'true');
  // The escape must also clear the saved-view error rather than carry it along.
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Saved views discard a delayed bookmark load after navigation', async ({ page }) => {
  const id = 'view_00000000-0000-4000-8000-000000000001';
  await page.addInitScript((viewId) => {
    sessionStorage.setItem('recued-test-saved-data-views', JSON.stringify([{
      id: viewId, name: 'Old route', definition: { tab: 'contact', query: 'Acme' }, revision: 1, created_at: 1, updated_at: 1,
    }]));
  }, id);
  await page.goto(`${URL_BASE}?data=contacts&hold_rpc=data_views.get#views/${id}`);
  await ready(page);
  await expect(page.getByRole('status').filter({ hasText: 'Loading saved view…' })).toBeVisible();
  await page.evaluate(() => window.__app.setHash('#data/task'));
  await expect(page.getByRole('tab', { name: 'Tasks', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('data_views.get'))).toBe(1);
  // Deliver the obsolete reply after the new route owns the page.
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('data_views.get')))
    .toBe(1);
  await expect(page).toHaveURL(/#data\/task$/);
  await expect(page.getByRole('tab', { name: 'Tasks', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(query(page)).toHaveCount(0);
});

test('Saved views keep a save single-flight and remain usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${URL_BASE}?data=contacts&saved_views_write=slow#data/contact`);
  await ready(page);
  await query(page).fill('Acme');
  await tools(page).getByRole('button', { name: 'Save current view' }).click();
  await tools(page).getByLabel('View name', { exact: true }).fill('Customer '.repeat(11).trim());
  await tools(page).locator('[data-view-editor]').dispatchEvent('submit');
  await tools(page).locator('[data-view-editor]').dispatchEvent('submit');
  await expect(tools(page).getByRole('button', { name: 'Saving…' })).toBeDisabled();
  expect(await page.evaluate(() => window.__app.rpcCallCount('data_views.create'))).toBe(1);
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Saved');
  await openViewsList(page);
  await openSavedViewList(page);
  await expect(tools(page).locator('details a')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/recued-saved-data-views.png', fullPage: true });
});

test('Saved views retain the exact Records publisher, pack, and kind', async ({ page }) => {
  await page.goto(`${URL_BASE}?data=records-navigation#data/records`);
  await ready(page);
  await page.locator('[data-records-namespace="publisher-b/same-board"]').click();
  await page.locator('[data-action="records-select-kind"][data-records-kind="job"]').click();
  await expect(page.getByRole('button', { name: 'Open record job-b', exact: true })).toBeVisible();
  await saveView(page, 'Publisher B jobs');
  // D-291 — the list is its own route now; `#data` only saves and links there.
  await openViewsList(page);
  await openSavedViewList(page);
  await tools(page).locator('details a').click();
  await page.reload();
  await ready(page);
  await expect(page.getByRole('button', { name: 'Open record job-b', exact: true })).toBeVisible();
  await expect(page.locator('[data-action="records-select-kind"][data-records-kind="job"]')).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => window.__app.rpcCallCount('records.search'))).toBe(1);
});

for (const missing of ['pack', 'kind'] as const) {
  test(`Saved views do not fall back when a Records ${missing} disappears`, async ({ page }) => {
    const id = 'view_00000000-0000-4000-8000-000000000001';
    await page.addInitScript(({ viewId, absent }) => {
      sessionStorage.setItem('recued-test-saved-data-views', JSON.stringify([{
        id: viewId, name: 'Unavailable records', revision: 1, created_at: 1, updated_at: 1,
        definition: { tab: 'records', owner: { publisher: absent === 'pack' ? 'missing' : 'publisher-b', pack_slug: 'same-board' }, entity: absent === 'kind' ? 'missing' : 'job' },
      }]));
    }, { viewId: id, absent: missing });
    await page.goto(`${URL_BASE}?data=records-navigation#views/${id}`);
    await ready(page);
    await expect(page.locator('[data-recued-data-route]')).toContainText(`The ${missing === 'kind' ? 'kind' : 'Pack'} you picked is gone`);
    expect(await page.evaluate(() => window.__app.rpcCallCount('records.search'))).toBe(0);
    await expect(page).toHaveURL(new RegExp(`#views/${id}$`));
  });
}

test('Saved views reopen a Memory origin and preserve keyboard cancellation', async ({ page }) => {
  await page.goto(`${URL_BASE}?data=memory-rows#data/memory`);
  await ready(page);
  await page.locator('[data-memory-filter="user_self"]').click();
  await expect(page.locator('.memory-row')).toHaveCount(1);
  await tools(page).getByRole('button', { name: 'Save current view' }).click();
  await expect(tools(page).getByLabel('View name', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tools(page).getByLabel('View name', { exact: true })).toHaveCount(0);
  await expect(tools(page).getByRole('button', { name: 'Save current view' })).toBeFocused();
  await saveView(page, 'My memories');
  await openViewsList(page);
  await openSavedViewList(page);
  await tools(page).locator('details a').click();
  await page.reload();
  await ready(page);
  await expect(page.locator('[data-memory-filter="user_self"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.memory-row')).toHaveCount(1);
  await expect(page.locator('.memory-row')).toContainText('Concise answers');
  expect(await page.evaluate(() => window.__app.rpcCallCount('memory.list'))).toBe(1);
});

test('Saved views keep a conflicting rename for review before retrying', async ({ page }) => {
  await page.goto(`${URL_BASE}?data=contacts#data/contact`);
  await ready(page);
  await saveView(page, 'Original');
  await openViewsList(page);
  await openSavedViewList(page);
  await tools(page).getByRole('button', { name: 'Rename Original', exact: true }).click();
  await tools(page).getByLabel('View name', { exact: true }).fill('My edit');
  await page.evaluate(() => {
    const key = 'recued-test-saved-data-views';
    const views = JSON.parse(sessionStorage.getItem(key)!);
    views[0].name = 'Other browser'; views[0].revision += 1;
    sessionStorage.setItem(key, JSON.stringify(views));
  });
  await page.keyboard.press('Enter');
  await expect(tools(page).getByRole('alert')).toContainText('another browser');
  await expect(tools(page).getByLabel('View name', { exact: true })).toHaveValue('My edit');
  await tools(page).getByRole('button', { name: 'Refresh saved views' }).click();
  await expect(tools(page).getByRole('alert')).toContainText('current name is “Other browser”');
  await tools(page).getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(tools(page).locator('details a')).toHaveText('My edit');
});

test('Saved views can be deleted without discarding an open Data draft', async ({ page }) => {
  await page.goto(`${URL_BASE}?data=contacts&saved_views_write=slow#data/contact`);
  await ready(page);
  await saveView(page, 'Contacts');
  await openViewsList(page);
  await openSavedViewList(page);
  const href = await tools(page).locator('details a').getAttribute('href');
  await tools(page).locator('details a').click();
  // Opening the view rebuilds this panel with its list folded. Unfolding it
  // before then would read the open list it replaces.
  await expect(tools(page).locator('.saved-data-opened')).toContainText('Opened from Contacts');
  await openSavedViewList(page);
  await tools(page).getByRole('button', { name: 'Delete Contacts', exact: true }).click();
  await tools(page).getByRole('button', { name: 'Delete view', exact: true }).click();
  // A Data action can start while the independent view deletion is settling.
  await page.getByRole('button', { name: 'New contact', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New contact' });
  await dialog.getByLabel('Email').fill('keep-this@example.test');
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Deleted');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Email')).toHaveValue('keep-this@example.test');
  await expect(dialog.getByLabel('Email')).toBeFocused();
  expect(await page.evaluate(() => window.__app.rpcCallCount('contact.upsert'))).toBe(0);
  await page.reload();
  await ready(page);
  await expect(query(page)).toBeVisible();
  await page.evaluate((hash) => window.__app.setHash(hash!), href);
  await expect(page.getByRole('alert')).toContainText('does not have that saved view any more');
});
