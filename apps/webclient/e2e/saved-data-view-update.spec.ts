import { expect, test, type Page } from '@playwright/test';
import type { SavedDataView, SavedDataViewDefinition } from '@recued/contracts';

const BASE = 'http://127.0.0.1:4319/full-app-harness.html';
const ID = 'view_00000000-0000-4000-8000-000000000002';
const KEY = 'recued-test-saved-data-views';
const tools = (page: Page) => page.locator('[data-saved-data-views]');
const query = (page: Page) => page.locator('[data-recued-data-contact-search]');
const stored = (page: Page): Promise<SavedDataView[]> => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), KEY);
const boot = async (page: Page, definition: SavedDataViewDefinition = { tab: 'contact', query: 'Acme' }, holdUpdate = false): Promise<void> => {
  await page.addInitScript(({ key, view }) => {
    if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, JSON.stringify([view]));
  }, { key: KEY, view: { id: ID, name: 'My view', definition, revision: 1, created_at: 1, updated_at: 1 } });
  await page.goto(`${BASE}?data=${definition.tab === 'task' ? 'work-entities-paged&task_filters=1' : 'contacts'}${holdUpdate ? '&hold_rpc=data_views.update' : ''}#data/view/${ID}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(tools(page).getByRole('button', { name: 'Update view', exact: true })).toBeVisible();
};
// A search repaint can detach a locator's resolved element before evaluate runs.
// Set selection on the live focus owner in one browser operation.
const selectDraftText = async (page: Page, start: number, end: number, direction: 'forward' | 'backward' | 'none' = 'none'): Promise<void> => {
  await page.evaluate(({ start, end, direction }) => {
    const input = document.activeElement;
    if (!(input instanceof HTMLInputElement) || input.closest('[role="dialog"]') === null) {
      throw new Error('The draft input must own keyboard focus before setting selection.');
    }
    input.setSelectionRange(start, end, direction);
  }, { start, end, direction });
};
const releaseUpdate = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('data_views.update'))).toBe(1);
};
const peerUpdate = async (page: Page, queryText: string): Promise<void> => {
  await page.evaluate(({ key, text }) => {
    const views = JSON.parse(sessionStorage.getItem(key)!);
    views[0].definition = { tab: 'contact', query: text };
    views[0].name = 'Other browser'; views[0].revision += 1;
    sessionStorage.setItem(key, JSON.stringify(views));
  }, { key: KEY, text: queryText });
};

test('Saved view updates show Modified immediately and keep the bookmark and mounted reader', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);
  await expect(query(page)).toHaveValue('Acme');
  await expect(tools(page).getByRole('button', { name: 'Update view', exact: true })).toBeDisabled();
  await query(page).fill('Changed');
  await expect(tools(page).locator('[data-view-modified]')).toHaveText('Modified');
  await expect(query(page)).toBeFocused();
  await query(page).fill('Acme');
  await expect(tools(page).locator('[data-view-modified]')).toHaveCount(0);
  await query(page).fill('Updated search');
  await page.locator('[data-recued-data-route]').evaluate((element) => element.setAttribute('data-reader-kept', 'yes'));
  await tools(page).getByRole('button', { name: 'Update view', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('bookmark stays the same');
  await expect(page.locator('[data-recued-data-route]')).toHaveAttribute('data-reader-kept', 'yes');
  await expect(tools(page).locator('[data-view-modified]')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#data/view/${ID}$`));
  expect(await stored(page)).toEqual([expect.objectContaining({ id: ID, name: 'My view', revision: 2,
    created_at: 1, definition: { tab: 'contact', query: 'Updated search' } })]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('data_views.get'))).toBe(1);
  await page.reload();
  await expect(query(page)).toHaveValue('Updated search');
  await expect(tools(page).locator('[data-view-modified]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Saved view updates replace Overdue with Next seven days at the same task bookmark', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.clock.setFixedTime(new Date('2026-09-07T14:00:00-07:00'));
  await boot(page, { tab: 'task', query: 'Task', source_id: null, booking_lifecycle: 'all',
    task_filters: { completion: 'open', due: 'overdue', sort: 'due_asc' } });
  const due = page.getByLabel('Due date', { exact: true });
  await expect(due).toHaveValue('overdue');
  await due.selectOption('next_7_days');
  await expect(tools(page).locator('[data-view-modified]')).toBeVisible();
  await tools(page).getByRole('button', { name: 'Update view', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Updated');
  await page.reload();
  await expect(due).toHaveValue('next_7_days');
  await expect(page.getByLabel('Task status', { exact: true })).toHaveValue('open');
  await expect(page.getByLabel('Sort tasks', { exact: true })).toHaveValue('due_asc');
  await expect(page.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('Task');
  await expect(page).toHaveURL(new RegExp(`#data/view/${ID}$`));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/recued-saved-view-update.png', fullPage: true });
});

test('Saved view updates offer Save as new without changing the original settings or bookmark', async ({ page }) => {
  await boot(page);
  await query(page).fill('Copy settings');
  await tools(page).getByRole('button', { name: 'Save as new', exact: true }).click();
  await tools(page).getByLabel('View name', { exact: true }).fill('A separate view');
  await page.keyboard.press('Enter');
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Saved “A separate view”');
  const views = await stored(page);
  expect(views).toHaveLength(2);
  expect(views[0]).toMatchObject({ id: ID, revision: 1, definition: { tab: 'contact', query: 'Acme' } });
  expect(views[1]).toMatchObject({ name: 'A separate view', revision: 1, definition: { tab: 'contact', query: 'Copy settings' } });
  expect(views[1]!.id).not.toBe(ID);
  await expect(query(page)).toHaveValue('Copy settings');
  await expect(tools(page).locator('[data-view-modified]')).toBeVisible();
  await tools(page).locator('summary').click();
  await tools(page).locator('details').getByRole('link', { name: 'A separate view', exact: true }).click();
  await expect(query(page)).toHaveValue('Copy settings');
  await expect(page).toHaveURL(new RegExp(`#data/view/${views[1]!.id}$`));
  await expect(tools(page).locator('[data-view-modified]')).toHaveCount(0);
});

test('Saved view updates require review after each competing revision and preserve local settings', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await boot(page);
  await query(page).fill('My settings');
  await peerUpdate(page, 'Their <first> settings');
  await tools(page).getByRole('button', { name: 'Update view', exact: true }).click();
  const review = tools(page).getByRole('group', { name: 'Review saved view changes' });
  await expect(review).toContainText('Their <first> settings');
  await expect(review).toContainText('My settings');
  await expect(query(page)).toHaveValue('My settings');
  expect((await stored(page))[0]).toMatchObject({ revision: 2, definition: { query: 'Their <first> settings' } });
  expect(await page.evaluate(() => window.__app.rpcCallCount('data_views.update'))).toBe(1);
  // A second peer write invalidates even the explicitly reviewed replacement.
  await peerUpdate(page, 'Their second settings');
  await review.getByRole('button', { name: 'Replace saved settings' }).click();
  await expect(review).toContainText('Their second settings');
  expect((await stored(page))[0]!.revision).toBe(3);
  await review.getByRole('button', { name: 'Replace saved settings' }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Updated “Other browser”');
  expect((await stored(page))[0]).toMatchObject({ revision: 4, definition: { tab: 'contact', query: 'My settings' } });
  await expect(review).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#data/view/${ID}$`));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Saved view updates do not silently adopt a newer revision after list refresh or rename', async ({ page }) => {
  await boot(page);
  await query(page).fill('My settings');
  await peerUpdate(page, 'Their settings');
  await tools(page).locator('summary').click();
  await tools(page).getByRole('button', { name: 'Refresh saved views' }).click();
  const review = tools(page).getByRole('group', { name: 'Review saved view changes' });
  await expect(review).toContainText('Their settings');
  await expect(tools(page).getByRole('button', { name: 'Update view', exact: true })).toBeDisabled();
  await tools(page).getByRole('button', { name: 'Rename Other browser', exact: true }).click();
  await tools(page).getByLabel('View name', { exact: true }).fill('Renamed here');
  await page.keyboard.press('Enter');
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Saved “Renamed here”');
  await expect(review).toContainText('Currently saved as “Renamed here”');
  await expect(review).toContainText('Their settings');
  expect(await page.evaluate(() => window.__app.rpcCallCount('data_views.update'))).toBe(0);
});

test('Saved view updates preserve a draft and keyboard focus started during the save', async ({ page }) => {
  await boot(page, { tab: 'contact', query: 'Acme' }, true);
  await query(page).fill('Saved before draft');
  await tools(page).getByRole('button', { name: 'Update view', exact: true }).click();
  await page.getByRole('button', { name: 'New contact', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New contact' });
  await dialog.getByLabel('Email').fill('keep-this@example.test');
  await selectDraftText(page, 2, 6, 'backward');
  await releaseUpdate(page);
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Updated');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Email')).toHaveValue('keep-this@example.test');
  await expect(dialog.getByLabel('Email')).toBeFocused();
  expect(await dialog.getByLabel('Email').evaluate((element: HTMLInputElement) =>
    [element.selectionStart, element.selectionEnd, element.selectionDirection])).toEqual([2, 6, 'backward']);
  await expect(tools(page).getByRole('button', { name: 'Update view', exact: true })).toBeDisabled();
  await expect(tools(page).getByRole('button', { name: 'Save as new', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__app.rpcCallCount('contact.upsert'))).toBe(0);
  expect((await stored(page))[0]).toMatchObject({ revision: 2, definition: { query: 'Saved before draft' } });
});

test('Saved view updates preserve task draft text and selection across a pending search repaint', async ({ page }) => {
  await boot(page, { tab: 'task', query: '', source_id: null, booking_lifecycle: 'all' }, true);
  const search = page.getByRole('searchbox', { name: 'Search tasks' });
  const initialSearches = await page.evaluate(() => {
    const url = new URL(location.href);
    url.searchParams.append('hold_rpc', 'work_entity.list');
    history.replaceState(null, '', url);
    return window.__app.rpcCallCount('work_entity.list');
  });
  await search.fill('Task');
  await tools(page).getByRole('button', { name: 'Update view', exact: true }).click();
  await page.getByRole('button', { name: '+ New Task', exact: true }).click();
  const title = page.getByRole('dialog', { name: 'New Task' }).getByLabel('Title');
  await title.fill('Keep this task draft');
  await selectDraftText(page, 1, 4);
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('work_entity.list'))).toBe(initialSearches + 1);
  await title.evaluate((element) => element.setAttribute('data-before-search-reply', 'yes'));
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('work_entity.list'))).toBe(1);
  await expect(title).not.toHaveAttribute('data-before-search-reply', 'yes');
  await expect(title).toHaveValue('Keep this task draft');
  await expect(title).toBeFocused();
  expect(await title.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([1, 4]);
  await releaseUpdate(page);
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Updated');
  await expect(title).toHaveValue('Keep this task draft');
  await expect(title).toBeFocused();
  expect(await title.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([1, 4]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('work_entity.upsert'))).toBe(0);
});

test('Saved view updates freeze submitted settings while later filter edits remain Modified', async ({ page }) => {
  await boot(page, { tab: 'contact', query: 'Acme' }, true);
  await query(page).fill('Submitted settings');
  await tools(page).getByRole('button', { name: 'Update view', exact: true }).click();
  await tools(page).locator('[data-view-action="update"]').dispatchEvent('click');
  await query(page).fill('Later settings');
  await releaseUpdate(page);
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Updated');
  expect(await page.evaluate(() => window.__app.rpcCallCount('data_views.update'))).toBe(1);
  expect((await stored(page))[0]).toMatchObject({ revision: 2, definition: { query: 'Submitted settings' } });
  await expect(query(page)).toHaveValue('Later settings');
  await expect(query(page)).toBeFocused();
  await expect(tools(page).locator('[data-view-modified]')).toBeVisible();
  await expect(page).toHaveURL(/#data\/contact$/);
  await tools(page).getByRole('button', { name: 'Update view', exact: true }).click();
  await releaseUpdate(page);
  await expect(tools(page).locator('[data-view-modified]')).toHaveCount(0);
  expect((await stored(page))[0]).toMatchObject({ revision: 3, definition: { query: 'Later settings' } });
});

test('Saved view updates detach a deleted bookmark and allow saving local settings as new', async ({ page }) => {
  await boot(page);
  await query(page).fill('Keep after deletion');
  await page.evaluate((key) => sessionStorage.setItem(key, '[]'), KEY);
  await tools(page).getByRole('button', { name: 'Update view', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('deleted in another browser');
  await expect(query(page)).toHaveValue('Keep after deletion');
  await expect(tools(page).getByRole('button', { name: 'Update view', exact: true })).toHaveCount(0);
  await tools(page).getByRole('button', { name: 'Save current view', exact: true }).click();
  await tools(page).getByLabel('View name', { exact: true }).fill('Recovered settings');
  await page.keyboard.press('Enter');
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Saved');
  const views = await stored(page);
  expect(views).toHaveLength(1);
  expect(views[0]!.id).not.toBe(ID);
  expect(views[0]!.definition).toEqual({ tab: 'contact', query: 'Keep after deletion' });
});

test('Saved view updates retain local changes after a failed write and allow an explicit retry', async ({ page }) => {
  await boot(page);
  await query(page).fill('Retry these settings');
  await page.evaluate(() => {
    const url = new URL(location.href); url.searchParams.set('saved_views_update', 'fail');
    history.replaceState(null, '', url);
  });
  await tools(page).getByRole('button', { name: 'Update view', exact: true }).click();
  await expect(tools(page).getByRole('alert')).toContainText('temporarily unavailable');
  await expect(tools(page).locator('[data-view-modified]')).toBeVisible();
  await expect(query(page)).toHaveValue('Retry these settings');
  expect((await stored(page))[0]).toMatchObject({ revision: 1, definition: { query: 'Acme' } });
  await page.evaluate(() => {
    const url = new URL(location.href); url.searchParams.delete('saved_views_update');
    history.replaceState(null, '', url);
  });
  await tools(page).getByRole('button', { name: 'Update view', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Updated');
  expect((await stored(page))[0]).toMatchObject({ revision: 2, definition: { query: 'Retry these settings' } });
});
