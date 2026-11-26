import { expect, test, type Page } from '@playwright/test';
import type { RecordsOwnerSearchRequest, SavedDataView, SavedDataViewDefinition } from '@recued/contracts';
import { openSavedViewList } from './helpers/saved-data-views.js';
import { openRecordsManagement } from './helpers/records.js';
const URL = '/full-app-harness.html?data=records-navigation&records_browse=1';
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
  const savedRow = page.getByRole('button', { name: 'Open record job-038', exact: true });
  await savedRow.press('Enter');
  await expect(page.locator('#records-detail-title')).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#views/${saved.id}$`));
  await expect(savedRow).toBeFocused();
  await expect(rows(page)).toHaveCount(14);
  await page.reload();
  await ready(page);
  await expect(rows(page).first()).toContainText('Open 238');
  expect((await requests(page)).at(-1)).not.toHaveProperty('cursor');
  expect(errors).toEqual([]);
});

test('Desktop Saved views switches by keyboard and restores the previous filtered Records view on Back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const closedId = 'view_00000000-0000-4000-8000-000000000002';
  const hiddenId = 'view_00000000-0000-4000-8000-000000000003';
  const pack = { publisher: 'publisher-a', slug: 'same-board' };
  const makeView = (id: string, name: string, prefix: string): SavedDataView => ({
    id, name, revision: 1, created_at: 1, updated_at: 1,
    definition: { ...definition, filters: { title: { op: 'prefix', value: prefix } }, sort: '-amount' },
  });
  const views = [
    makeView(ID, 'Open jobs', 'Open'),
    { ...makeView(closedId, 'Closed jobs', 'Closed'), pack },
    { id: hiddenId, name: 'All jobs', definition, revision: 1, created_at: 1, updated_at: 1, pack, hidden: true },
  ];
  await page.addInitScript(({ key, views }) => sessionStorage.setItem(key, JSON.stringify(views)), { key: KEY, views });
  await page.goto(`${URL}#views/${ID}`);
  await ready(page);
  await expect(rows(page).first()).toContainText('Open 238');

  const switcher = toolbar(page).locator('[data-view-switcher]');
  const trigger = switcher.locator('summary');
  const openJobs = switcher.getByRole('link', { name: 'Open jobs', exact: true });
  const closedJobs = switcher.getByRole('link', { name: 'Closed jobs From same-board', exact: true });
  await expect(trigger).toHaveText('Open jobs');
  await trigger.press('Enter');
  await expect(openJobs).toHaveAttribute('aria-current', 'page');
  await expect(switcher.getByRole('link', { name: /All jobs/ })).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(openJobs).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(switcher).not.toHaveAttribute('open');
  await expect(trigger).toBeFocused();

  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(closedJobs).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#views/${closedId}$`));
  await expect(rows(page).first()).toContainText('Closed 239');
  await expect(trigger).toHaveText('Closed jobs');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#views/${ID}$`));
  await expect(rows(page).first()).toContainText('Open 238');
  await expect(trigger).toHaveText('Open jobs');

  await trigger.press('Enter');
  await page.keyboard.press('Tab');
  await expect(openJobs).toBeFocused();
  await page.setViewportSize({ width: 1279, height: 900 });
  await expect(toolbar(page).locator('[data-view-library] summary')).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(trigger).toBeFocused();

  await toolbar(page).getByRole('link', { name: 'Manage views', exact: true }).click();
  await expect(page).toHaveURL(/#views$/);
  await expect(toolbar(page).getByRole('button', { name: 'Rename Open jobs', exact: true })).toBeVisible();
  await expect(toolbar(page).getByRole('button', { name: 'Show All jobs', exact: true })).toBeVisible();
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
  const pack = page.getByRole('combobox', { name: 'Pack', exact: true });
  await pack.focus();
  const kindsBefore = await page.evaluate(() => window.__app.rpcCallCount('records.kind.list'));
  await page.evaluate(() => window.__app.holdRpcResponses?.('records.kind.list'));
  await pack.selectOption('publisher-b/same-board');
  await expect(pack).toHaveAttribute('aria-busy', 'true');
  await expect(pack).toHaveAttribute('aria-disabled', 'true');
  await pack.evaluate(node => {
    const select = node as HTMLSelectElement;
    select.value = 'publisher-a/same-board';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(pack).toHaveValue('publisher-b/same-board');
  expect(await page.evaluate(() => window.__app.rpcCallCount('records.kind.list'))).toBe(kindsBefore + 1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('records.kind.list'))).toBe(1);
  await expect(rows(page).first()).toContainText('invoice-000');
  await expect(pack).toBeFocused();
  expect((await requests(page)).at(-1)).toMatchObject({ owner: { publisher: 'publisher-b' } });
  expect((await requests(page)).at(-1)).not.toHaveProperty('cursor');
});

test('the desktop Records inspector keeps filtered results and restores the table on Close and browser Back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${URL}#data/records`);
  await ready(page);

  const pack = page.getByRole('combobox', { name: 'Pack', exact: true });
  const kind = page.getByRole('tab', { name: /^job\b/i });
  const row = page.getByRole('button', { name: 'Open record job-014', exact: true });
  const next = page.getByRole('button', { name: 'Open record job-012', exact: true });
  const index = page.getByRole('list', { name: 'Records results', exact: true });
  const heading = page.locator('#records-detail-title');
  await expect(rows(page)).toHaveCount(100);
  await pack.selectOption('publisher-b/same-board');
  await kind.click();
  await addFilter(page, 1, 'title', 'prefix', 'Open');
  await page.getByLabel('Sort records', { exact: true }).selectOption('-amount');
  await apply(page);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(rows(page)).toHaveCount(20);
  await expect(rows(page).first()).toContainText('Open 38');
  const queryCount = (await requests(page)).length;
  const scroll = page.locator('[data-recued-webclient-content]');
  await row.scrollIntoViewIfNeeded();
  await row.focus();
  const scrollTop = await scroll.evaluate(node => node.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);

  const open = async () => {
    await row.press('Enter');
    await expect(heading).toBeFocused();
    await expect(page).toHaveURL(/#data\/records\/publisher-b\/same-board\/job\/job-014$/);
    await expect(index.getByRole('listitem')).toHaveCount(20);
    await expect(index.getByRole('listitem').first()).toContainText('Open 38');
    await expect(index).not.toContainText('publisher-b@example.test');
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(page.getByLabel('Filter 1 value')).toHaveValue('Open');
  };
  const expectList = async (selection: typeof row) => {
    await expect(page).toHaveURL(/#data\/records$/);
    await expect(index).toHaveCount(0);
    await expect(pack).toHaveValue('publisher-b/same-board');
    await expect(kind).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Filter 1 value')).toHaveValue('Open');
    await expect(page.getByLabel('Sort records', { exact: true })).toHaveValue('-amount');
    await expect(page.getByRole('navigation', { name: 'Records pages' })).toContainText('Page 2');
    await expect(rows(page).first()).toContainText('Open 38');
    await expect(selection).toBeFocused();
    await expect(selection).toBeInViewport();
    expect(await requests(page)).toHaveLength(queryCount);
  };

  await open();
  const pane = page.getByRole('region', { name: 'job-014', exact: true });
  const listBox = (await index.boundingBox())!;
  expect(listBox.x + listBox.width).toBeLessThan((await pane.boundingBox())!.x);
  await pane.getByRole('button', { name: 'Close inspector', exact: true }).press('Enter');
  await expectList(row);
  expect(Math.abs(await scroll.evaluate(node => node.scrollTop) - scrollTop)).toBeLessThanOrEqual(1);
  await open();
  await next.click();
  await expect(heading).toHaveText('job-012');
  await expect(heading).toBeInViewport();
  await expect(next).toHaveAttribute('aria-current', 'true');
  await expect(row).not.toHaveAttribute('aria-current');
  await expect(page).toHaveURL(/#data\/records\/publisher-b\/same-board\/job\/job-012$/);
  await page.goBack();
  await expectList(next);

  await next.click();
  await page.getByRole('region', { name: 'job-012', exact: true })
    .getByRole('button', { name: 'job/job-058', exact: true }).click();
  const related = page.getByRole('region', { name: 'job-058', exact: true });
  await expect(related).toBeVisible();
  await expect(index.getByRole('listitem')).toHaveCount(20);
  await page.goBack();
  await expectList(next);

  await next.click();
  await expect(heading).toHaveText('job-012');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(index).toHaveCount(0);
  await expect(heading).toBeFocused();
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
});

test('the desktop Records inspector keeps the latest selection and drops reads that settle after closing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootSaved(page);
  const row = (id: string) => page.getByRole('button', { name: `Open record ${id}`, exact: true });
  const heading = page.locator('#records-detail-title');
  await row('job-004').click();
  await expect(heading).toHaveText('job-004');

  await page.evaluate(() => window.__app.holdRpcResponses!('records.get'));
  await row('job-005').click();
  await expect(row('job-005')).toHaveAttribute('aria-busy', 'true');
  await expect(row('job-004')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('button', { name: 'Delete record…', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await row('job-006').click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('records.get'))).toBe(3);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses!('records.get', 1))).toBe(1);
  await expect(heading).toHaveText('job-006');
  expect(await page.evaluate(() => window.__app.releaseRpcResponses!('records.get'))).toBe(1);
  await expect(row('job-006')).toHaveAttribute('aria-current', 'true');

  await page.evaluate(() => window.__app.holdRpcResponses!('records.get'));
  await row('job-007').click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('records.get'))).toBe(4);
  await row('job-007').press('Escape');
  expect(await page.evaluate(() => window.__app.releaseRpcResponses!('records.get'))).toBe(1);
  await expect(heading).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#views/${ID}$`));
  await expect(row('job-006')).toBeFocused();
});

test('direct Records links and phone row taps use the full record view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${URL}#data/records/publisher-b/same-board/job/job-014`);
  await ready(page);
  const detail = page.getByRole('region', { name: 'job-014', exact: true });
  await expect(detail.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  const index = page.getByRole('list', { name: 'Records results', exact: true });
  await expect(index).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await detail.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Open record job-032', exact: true }).click();
  const phoneHeading = page.getByRole('heading', { name: 'job-032', exact: true });
  await expect(phoneHeading).toBeFocused();
  await expect(phoneHeading).toBeInViewport();
  await expect(page.getByRole('region', { name: 'job-032', exact: true }).getByText('Open 32', { exact: true })).toBeInViewport();
  await expect(index).toHaveCount(0);
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
  await page.screenshot({ path: test.info().outputPath('records-filters.png'), fullPage: true });
});

test('Records disables filter editing while an export owns the reader', async ({ page }) => {
  await page.goto(`${URL}&hold_rpc=records.export#data/records`);
  await ready(page);
  await addFilter(page, 1, 'status', 'eq', 'open');
  await apply(page);
  const value = page.getByLabel('Filter 1 value', { exact: true });
  await openRecordsManagement(page);
  await page.getByRole('button', { name: 'Export kind JSON', exact: true }).click();
  await expect(value).toBeDisabled();
  await expect(page.getByLabel('Sort records', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toHaveAttribute('aria-disabled', 'true');
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('records.export'))).toBe(1);
  await expect(value).toBeEnabled();
  await expect(value).toHaveValue('open');
});

test('Records uses authored field labels safely in both the list and detail', async ({ page }) => {
  await page.goto('/full-app-harness.html?data=records-navigation&records_labels=1#data/records');
  await ready(page);
  await page.getByRole('tab', { name: 'job', exact: false }).click();
  await expect(page.getByRole('columnheader', { name: 'Job name <primary>', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Record ID', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Amount', exact: true })).toBeVisible();
  await expect(page.locator('.records-table')).not.toContainText('alice@example.test');
  await rows(page).getByRole('button', { name: 'Open record job-1', exact: true }).click();
  await expect(page.locator('.records-detail dt').filter({ hasText: 'Job name <primary>' })).toBeVisible();
  await page.getByText('Advanced raw-slot diagnostics', { exact: true }).click();
  await expect(page.locator('.records-detail pre')).toContainText('"key": "title"');
});

for (const width of [375, 1280]) {
  test(`Records clears an empty filtered view by keyboard at ${width}px while preserving sort and the saved view`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const value = `Unmatched <&>${'query'.repeat(60)}`;
    const view: SavedDataViewDefinition = { ...definition,
      filters: { title: { op: 'prefix', value } }, sort: '-amount' };
    await bootSaved(page, view);
    const summary = page.getByRole('region', { name: 'Applied filters and sorting', exact: true });
    await expect(summary).toContainText(`Title starts with "${value}"`);
    await expect(summary).toContainText('Sort: Amount — descending');
    await expect(page.locator('.records-empty-state')).toContainText('No records match the applied filters.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await summary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('empty-filtered-records.png') });
    const before = await stored(page);
    const clear = page.getByRole('button', { name: 'Clear filters', exact: true });
    await clear.focus();
    await page.keyboard.press('Enter');
    await expect(rows(page)).toHaveCount(100);
    await expect(rows(page).first()).toContainText('Closed 239');
    expect((await requests(page)).at(-1)).toMatchObject({ sort: '-amount' });
    expect((await requests(page)).at(-1)).not.toHaveProperty('filters');
    expect((await requests(page)).at(-1)).not.toHaveProperty('cursor');
    await expect(summary).toContainText('Applied filters: none');
    await expect(page.getByRole('button', { name: 'Apply filters and sorting', exact: true })).toBeFocused();
    expect(await stored(page)).toEqual(before);
    await expect(toolbar(page).locator('[data-view-modified]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('Records keeps applied summaries separate from edits and retains an unapplied sort when clearing filters', async ({ page }) => {
  await bootSaved(page, { ...definition, filters: { title: { op: 'prefix', value: 'No match' } }, sort: '-amount' });
  const summary = page.getByRole('region', { name: 'Applied filters and sorting', exact: true });
  await page.getByLabel('Filter 1 value', { exact: true }).fill('unfinished draft');
  await expect(summary).toContainText('Title starts with "No match"');
  await expect(summary).not.toContainText('unfinished draft');
  await page.getByLabel('Sort records', { exact: true }).selectOption('amount');
  await expect(summary).toContainText('Sort: Amount — descending');
  expect(await requests(page)).toHaveLength(1);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(rows(page)).toHaveCount(100);
  expect((await requests(page)).at(-1)).toMatchObject({ sort: '-amount' });
  await expect(page.getByLabel('Sort records', { exact: true })).toHaveValue('amount');
  await expect(page.locator('[data-records-draft-status]')).toBeVisible();
  await expect(summary).toContainText('Applied filters: none');
  await expect(summary).toContainText('Sort: Amount — descending');
  await apply(page);
  await expect(summary).toContainText('Sort: Amount — ascending');
  await expect(rows(page).first()).toContainText('Open 0');
});

for (const focusTarget of ['clear-filters', 'account-menu'] as const) {
  test(`Records blocks filter clearing during export and preserves ${focusTarget} focus afterward`, async ({ page }) => {
    await bootSaved(page, { ...definition, filters: { title: { op: 'prefix', value: 'No match' } }, sort: '-amount' });
    await page.goto(`${URL}&hold_rpc=records.export#views/${ID}`);
    await ready(page);
    const clear = page.getByRole('button', { name: 'Clear filters', exact: true });
    await expect(clear).toBeVisible();
    const before = await requests(page);
    await openRecordsManagement(page);
    await page.getByRole('button', { name: 'Export kind JSON', exact: true }).click();
    await expect(clear).toHaveAttribute('aria-disabled', 'true');
    await clear.focus();
    await page.keyboard.press('Enter');
    expect(await requests(page)).toEqual(before);
    await expect(page.getByRole('region', { name: 'Applied filters and sorting', exact: true }))
      .toContainText('Title starts with "No match"');
    const settledFocus = focusTarget === 'clear-filters' ? clear
      : page.getByRole('button', { name: 'Your account and servers', exact: true });
    await settledFocus.focus();
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('records.export'))).toBe(1);
    await expect(clear).not.toHaveAttribute('aria-disabled', 'true');
    await expect(settledFocus).toBeFocused();
    await clear.focus();
    await page.keyboard.press('Enter');
    await expect(rows(page)).toHaveCount(100);
    expect(await requests(page)).toHaveLength(before.length + 1);
    expect((await requests(page)).at(-1)).not.toHaveProperty('filters');
    expect((await requests(page)).at(-1)).toMatchObject({ sort: '-amount' });
  });
}
