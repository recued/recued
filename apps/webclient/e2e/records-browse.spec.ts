import { expect, test, type Page } from '@playwright/test';
import type { RecordsOwnerSearchRequest, SavedDataViewDefinition } from '@recued/contracts';
import { openSavedViewList } from './helpers/saved-data-views.js';
const URL = 'http://127.0.0.1:4319/full-app-harness.html?data=records-navigation&records_browse=1';
const KEY = 'recued-test-saved-data-views';
const ID = 'view_00000000-0000-4000-8000-000000000001';
const definition = { tab: 'records' as const, owner: { publisher: 'publisher-a', pack_slug: 'same-board' }, entity: 'job' };
const toolbar = (page: Page) => page.locator('[data-saved-data-views]');
const rows = (page: Page) => page.locator('.records-table tbody tr');
const requests = (page: Page): Promise<RecordsOwnerSearchRequest[]> => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-records-searches') ?? '[]'));
const stored = (page: Page) => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? '[]'), KEY);
const ready = async (page: Page) => {
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-recued-data-route]')).toBeVisible();
};
const bootSaved = async (page: Page, view: SavedDataViewDefinition = definition) => {
  await page.addInitScript(({ key, id, definition }) => sessionStorage.setItem(key, JSON.stringify([
    { id, name: 'Jobs', definition, revision: 1, created_at: 1, updated_at: 1 },
  ])), { key: KEY, id: ID, definition: view });
  await page.goto(`${URL}#views/${ID}`);
  await ready(page);
};
const addFilter = async (page: Page, index: number, field: string, op: string, value: string) => {
  await page.getByRole('button', { name: 'Add filter', exact: true }).click();
  await page.getByLabel(`Filter ${index} field`, { exact: true }).selectOption(field);
  await page.getByLabel(`Filter ${index} condition`, { exact: true }).selectOption(op);
  await page.getByLabel(`Filter ${index} value`, { exact: true }).fill(value);
};
const apply = async (page: Page) => {
  await page.getByRole('button', { name: 'Apply filters and sorting', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply filters and sorting', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
};

test('Records applies filters and sorting before paging and saves settings without cursors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${URL}#data/records`);
  await ready(page);
  await page.getByRole('tab', { name: 'job', exact: false }).click();
  await expect(rows(page)).toHaveCount(100);
  await addFilter(page, 1, 'title', 'prefix', 'Open');
  await addFilter(page, 2, 'amount', 'gte', '10.2500');
  await page.getByLabel('Sort records', { exact: true }).selectOption('-amount');
  await expect(toolbar(page).getByRole('button', { name: 'Save current view', exact: true })).toBeDisabled();
  await apply(page);
  await expect(rows(page).first()).toContainText('Open 238');
  expect((await requests(page)).at(-1)).toMatchObject({ entity: 'job', filters: {
    title: { op: 'prefix', value: 'Open' }, amount: { op: 'gte', value: '10.2500' },
  }, sort: '-amount' });
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(rows(page)).toHaveCount(14);
  await expect(rows(page).first()).toContainText('Open 38');
  expect((await requests(page)).at(-1)?.cursor).toBeTruthy();
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(rows(page).first()).toContainText('Open 238');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(rows(page)).toHaveCount(14);
  await toolbar(page).getByRole('button', { name: 'Save current view', exact: true }).click();
  await toolbar(page).getByLabel('View name', { exact: true }).fill('Open jobs');
  await toolbar(page).getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(toolbar(page).locator('[data-view-notice]')).toContainText('Saved');
  const saved = (await stored(page))[0];
  expect(Object.keys(saved.definition).sort()).toEqual(['entity', 'filters', 'owner', 'sort', 'tab']);
  // D-291 — the saved-view list is its own route; `#data` only saves and links.
  await page.evaluate(() => window.__app.setHash('#views'));
  // The list starts open there, so a click on its summary would fold it.
  await openSavedViewList(page);
  await toolbar(page).locator('details').getByRole('link', { name: 'Open jobs', exact: true }).click();
  await expect(rows(page).first()).toContainText('Open 238');
  expect((await requests(page)).at(-1)).not.toHaveProperty('cursor');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(rows(page)).toHaveCount(14);
  await expect(page).toHaveURL(new RegExp(`#views/${saved.id}$`));
  await expect(toolbar(page).locator('[data-view-modified]')).toHaveCount(0);
  await page.reload();
  await ready(page);
  await expect(rows(page).first()).toContainText('Open 238');
  expect((await requests(page)).at(-1)).not.toHaveProperty('cursor');
  expect(errors).toEqual([]);
});

test('Records updates old bookmarks, reviews competing filters and saves copies', async ({ page }) => {
  await bootSaved(page);
  await expect(rows(page).first()).toContainText('Open 0');
  expect((await requests(page)).at(-1)).not.toHaveProperty('filters');
  expect((await requests(page)).at(-1)).not.toHaveProperty('sort');
  await page.getByLabel('Sort records', { exact: true }).selectOption('-amount');
  await apply(page);
  await toolbar(page).getByRole('button', { name: 'Update view', exact: true }).click();
  await expect(toolbar(page).locator('[data-view-notice]')).toContainText('Updated');
  expect((await stored(page))[0]).toMatchObject({ id: ID, revision: 2, definition: { ...definition, sort: '-amount' } });
  await addFilter(page, 1, 'title', 'prefix', 'Open');
  await apply(page);
  await page.evaluate(key => {
    const views = JSON.parse(sessionStorage.getItem(key)!);
    views[0].definition.filters = { title: { op: 'prefix', value: 'Closed <other>' } };
    views[0].definition.sort = 'amount';
    views[0].revision += 1;
    sessionStorage.setItem(key, JSON.stringify(views));
  }, KEY);
  await toolbar(page).getByRole('button', { name: 'Update view', exact: true }).click();
  await expect(toolbar(page)).toContainText('Closed <other>');
  await expect(toolbar(page)).toContainText('Sort: amount ascending');
  await expect(toolbar(page)).toContainText('Sort: amount descending');
  await expect(page.getByLabel('Filter 1 value', { exact: true })).toHaveValue('Open');
  await toolbar(page).getByRole('button', { name: 'Replace saved settings', exact: true }).click();
  await expect(toolbar(page).locator('[data-view-notice]')).toContainText('Updated');
  await expect(page).toHaveURL(new RegExp(`#views/${ID}$`));
  expect((await stored(page))[0]).toMatchObject({ revision: 4, definition: { filters: { title: { value: 'Open' } }, sort: '-amount' } });
  await page.getByLabel('Filter 1 value', { exact: true }).fill('Closed');
  await apply(page);
  await toolbar(page).getByRole('button', { name: 'Save as new', exact: true }).click();
  await toolbar(page).getByLabel('View name', { exact: true }).fill('Closed jobs');
  await toolbar(page).getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(toolbar(page).locator('[data-view-notice]')).toContainText('Saved');
  const views = await stored(page);
  expect(views[0]).toMatchObject({ id: ID, revision: 4, definition: { filters: { title: { value: 'Open' } } } });
  expect(views[1]).toMatchObject({ name: 'Closed jobs', definition: { filters: { title: { value: 'Closed' } }, sort: '-amount' } });
});

test('Records restarts paging for query, kind, pack and refresh changes', async ({ page }) => {
  await bootSaved(page, { ...definition, filters: { title: { op: 'prefix', value: 'Open' } }, sort: '-amount' });
  await expect(rows(page)).toHaveCount(100);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(rows(page)).toHaveCount(20);
  await page.getByLabel('Sort records', { exact: true }).selectOption('amount');
  await apply(page);
  await expect(rows(page).first()).toContainText('Open 0');
  expect((await requests(page)).at(-1)).not.toHaveProperty('cursor');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(rows(page)).toHaveCount(20);
  await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
  await expect(rows(page)).toHaveCount(100);
  expect((await requests(page)).at(-1)).not.toHaveProperty('cursor');
  await page.getByRole('tab', { name: 'invoice', exact: false }).click();
  await expect(rows(page).first()).toContainText('invoice-000');
  expect((await requests(page)).at(-1)).toEqual(expect.objectContaining({ entity: 'invoice' }));
  expect((await requests(page)).at(-1)).not.toHaveProperty('filters');
  expect((await requests(page)).at(-1)).not.toHaveProperty('sort');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(rows(page).first()).toContainText('invoice-100');
  await page.locator('[data-records-namespace="publisher-b/same-board"]').click();
  await expect(rows(page).first()).toContainText('invoice-000');
  expect((await requests(page)).at(-1)).toMatchObject({ owner: { publisher: 'publisher-b' } });
  expect((await requests(page)).at(-1)).not.toHaveProperty('cursor');
});

test('Records keeps a missing saved field explicit until corrected', async ({ page }) => {
  await bootSaved(page, { ...definition, filters: { retired: { op: 'eq', value: 'keep' } }, sort: '-amount' });
  await expect(page.getByRole('alert')).toContainText('cannot be used');
  expect(await requests(page)).toEqual([]);
  await expect(page.getByLabel('Filter 1 field', { exact: true })).toHaveValue('retired');
  await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cannot be used');
  expect(await requests(page)).toEqual([]);
  await page.getByRole('button', { name: 'Reset filters and sorting', exact: true }).click();
  await expect(rows(page)).toHaveCount(100);
  expect((await requests(page)).at(-1)).not.toHaveProperty('filters');
  await expect(toolbar(page).locator('[data-view-modified]')).toBeVisible();
});

test('Records filter controls support keyboard apply and fit a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await bootSaved(page);
  await expect(rows(page)).toHaveCount(100);
  await addFilter(page, 1, 'amount', 'gte', 'not a number');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Type an amount');
  expect(await requests(page)).toHaveLength(1);
  await page.getByLabel('Filter 1 value', { exact: true }).fill('230.0000');
  await page.keyboard.press('Enter');
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByRole('button', { name: 'Apply filters and sorting', exact: true })).toBeFocused();
  expect((await requests(page)).at(-1)?.filters).toEqual({ amount: { op: 'gte', value: '230.0000' } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/recued-records-filters.png', fullPage: true });
});

test('Records disables filter editing while an export owns the reader', async ({ page }) => {
  await page.goto(`${URL}&hold_rpc=records.export#data/records`);
  await ready(page);
  await addFilter(page, 1, 'status', 'eq', 'open');
  await apply(page);
  const value = page.getByLabel('Filter 1 value', { exact: true });
  await page.getByRole('button', { name: 'Export kind JSON', exact: true }).click();
  await expect(value).toBeDisabled();
  await expect(page.getByLabel('Sort records', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toHaveAttribute('aria-disabled', 'true');
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('records.export'))).toBe(1);
  await expect(value).toBeEnabled();
  await expect(value).toHaveValue('open');
});
