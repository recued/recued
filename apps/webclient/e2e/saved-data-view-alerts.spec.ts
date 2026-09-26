import { expect, test, type Page } from '@playwright/test';
import type { SavedDataView } from '@recued/contracts';

const BASE = 'http://127.0.0.1:4319/full-app-harness.html';
const ID = 'view_00000000-0000-4000-8000-000000000003';
const KEY = 'recued-test-saved-data-views';
const tools = (page: Page) => page.locator('[data-saved-data-views]');
const opened = (page: Page) => tools(page).locator('.saved-data-opened');
const stored = (page: Page): Promise<SavedDataView[]> => page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), KEY);
const boot = async (page: Page, tab: 'task' | 'contact' = 'task', hold = false): Promise<void> => {
  await page.addInitScript(({ key, view }) => {
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify([view]));
  }, { key: KEY, view: { id: ID, name: 'Overdue invoices', revision: 1, created_at: 1, updated_at: 1,
    definition: tab === 'task'
      ? { tab, query: '', source_id: null, booking_lifecycle: 'all', task_filters: { completion: 'open', due: 'overdue', sort: 'due_asc' } }
      : { tab, query: '' },
  } });
  await page.goto(`${BASE}?data=${tab === 'task' ? 'work-entities-paged&task_filters=1' : 'contacts'}${hold ? '&hold_rpc=data_views.update' : ''}#views/${ID}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(opened(page)).toBeVisible();
};

test('Task alerts enable, pause and resume durably without changing the saved filters', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await boot(page);
  const initial = (await stored(page))[0]!;
  await opened(page).getByRole('button', { name: 'Notify me for Overdue invoices', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Alerts on');
  expect((await stored(page))[0]).toMatchObject({ id: ID, definition: initial.definition, revision: 2,
    alert: { enabled: true, status: 'watching' } });
  await page.reload();
  await expect(opened(page).locator('[data-view-alert]')).toContainText('Alerts on');
  await opened(page).getByRole('button', { name: 'Pause alerts for Overdue invoices', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Alerts paused');
  await page.reload();
  await expect(opened(page).getByRole('button', { name: 'Resume alerts for Overdue invoices', exact: true })).toBeVisible();
  await opened(page).getByRole('button', { name: 'Resume alerts for Overdue invoices', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Alerts on');
  expect((await stored(page))[0]).toMatchObject({ definition: initial.definition, revision: 4, alert: { enabled: true } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Alert changes preserve local filters and focus while their save is pending', async ({ page }) => {
  await boot(page, 'task', true);
  await opened(page).getByRole('button', { name: 'Notify me for Overdue invoices', exact: true }).click();
  await expect(opened(page).locator('[data-view-alert]')).toHaveAttribute('aria-busy', 'true');
  await expect(opened(page).getByRole('button', { name: 'Turning on alerts… for Overdue invoices', exact: true })).toBeDisabled();
  const search = page.getByRole('searchbox', { name: 'Search tasks' });
  await search.fill('Unsaved changes');
  await page.evaluate(() => window.__app.releaseRpcResponses?.('data_views.update'));
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Alerts on');
  await expect(search).toHaveValue('Unsaved changes');
  await expect(search).toBeFocused();
  await expect(tools(page).locator('[data-view-modified]')).toBeVisible();
  await expect(opened(page)).toContainText('Your unsaved filter changes are not monitored');
  expect((await stored(page))[0]?.definition).toMatchObject({ query: '' });
});

test('Alert conflicts require refreshing the saved view and do not overwrite a paused rule', async ({ page }) => {
  await boot(page);
  await page.evaluate(key => {
    const views = JSON.parse(sessionStorage.getItem(key)!);
    views[0].revision = 2;
    views[0].alert = { enabled: false, time_zone: 'UTC', status: 'paused', last_checked_at: null, last_notified_at: null };
    sessionStorage.setItem(key, JSON.stringify(views));
  }, KEY);
  await opened(page).getByRole('button', { name: 'Notify me for Overdue invoices', exact: true }).click();
  await expect(tools(page).getByRole('alert')).toBeVisible();
  await expect(tools(page).locator('[data-view-error]')).toBeFocused();
  expect((await stored(page))[0]).toMatchObject({ revision: 2, alert: { enabled: false } });
  await page.reload();
  await expect(opened(page)).toContainText('Alerts paused');
});

test('Contact views do not offer alerts, and alert toasts link back to their saved view', async ({ page }) => {
  await boot(page, 'contact');
  await expect(tools(page).locator('[data-view-action="alert"]')).toHaveCount(0);
  await page.evaluate(id => window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'notification.notify', title: 'New tasks in Overdue invoices', text: 'A task now matches.',
    link_url: `#views/${id}`, cursor: 100,
  } }), ID);
  const link = page.locator('[data-recued-notify-toast]').getByRole('link', { name: 'Open', exact: true });
  await expect(link).toHaveAttribute('href', `#views/${ID}`);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`#views/${ID}$`));
});

test('Records alerts preserve saved filters across enable, reload, pause and resume', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const definition = { tab: 'records', owner: { publisher: 'publisher-a', pack_slug: 'same-board' }, entity: 'job',
    filters: { title: { op: 'prefix', value: 'Open' } }, sort: '-amount' };
  await page.addInitScript(({ key, view }) => {
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify([view]));
  }, { key: KEY, view: { id: ID, name: 'Open jobs', definition, revision: 1, created_at: 1, updated_at: 1 } });
  await page.goto(`${BASE}?data=records-navigation&records_browse=1#views/${ID}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('.records-table tbody tr').first()).toContainText('Open 238');
  await opened(page).getByRole('button', { name: 'Notify me for Open jobs', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('another record matches');
  expect((await stored(page))[0]).toMatchObject({ definition, revision: 2, alert: { enabled: true } });
  await page.reload();
  await expect(opened(page)).toContainText('Alerts on');
  await opened(page).getByRole('button', { name: 'Pause alerts for Open jobs', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Alerts paused');
  await opened(page).getByRole('button', { name: 'Resume alerts for Open jobs', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Alerts on');
  expect((await stored(page))[0]).toMatchObject({ definition, revision: 4, alert: { enabled: true } });
  await page.evaluate(key => {
    const views = JSON.parse(sessionStorage.getItem(key)!);
    views[0].alert.status = 'unavailable';
    sessionStorage.setItem(key, JSON.stringify(views));
  }, KEY);
  await tools(page).locator('summary').click();
  await tools(page).getByRole('button', { name: 'Refresh saved views', exact: true }).click();
  await expect(opened(page)).toContainText('Alerts resume when the data is available');
  await tools(page).screenshot({ path: '/tmp/recued-records-alert-controls.png' });
  await expect(opened(page)).toContainText('Alerts waiting for your records');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Refreshing updates alert health without changing filters or their revision', async ({ page }) => {
  await boot(page);
  await opened(page).getByRole('button', { name: 'Notify me for Overdue invoices', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Alerts on');
  const search = page.getByRole('searchbox', { name: 'Search tasks' });
  await search.fill('Unsaved');
  await page.evaluate(key => {
    const views = JSON.parse(sessionStorage.getItem(key)!);
    views[0].alert.status = 'unavailable';
    sessionStorage.setItem(key, JSON.stringify(views));
  }, KEY);
  await tools(page).locator('summary').click();
  await tools(page).getByRole('button', { name: 'Refresh saved views', exact: true }).click();
  await expect(opened(page)).toContainText('Alerts waiting for your tasks');
  await expect(search).toHaveValue('Unsaved');
  expect((await stored(page))[0]?.revision).toBe(2);
});

test('Alert controls in the refreshed list use its reviewed revision while an older view stays open', async ({ page }) => {
  await boot(page);
  await page.evaluate(key => {
    const views = JSON.parse(sessionStorage.getItem(key)!);
    views[0].revision = 2;
    views[0].alert = { enabled: false, time_zone: 'UTC', status: 'paused', last_checked_at: null, last_notified_at: null };
    sessionStorage.setItem(key, JSON.stringify(views));
  }, KEY);
  await tools(page).locator('summary').click();
  await tools(page).getByRole('button', { name: 'Refresh saved views', exact: true }).click();
  await tools(page).locator('details').getByRole('button', { name: 'Resume alerts for Overdue invoices', exact: true }).click();
  await expect(tools(page).locator('[data-view-notice]')).toContainText('Alerts on');
  expect((await stored(page))[0]).toMatchObject({ revision: 3, alert: { enabled: true } });
});
