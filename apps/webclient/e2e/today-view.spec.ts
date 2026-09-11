import { expect, test, type Page } from '@playwright/test';

test.use({ timezoneId: 'America/Los_Angeles', viewport: { width: 390, height: 844 } });
const base = 'http://127.0.0.1:4319/full-app-harness.html?data=today';
const boot = async (page: Page, extra = ''): Promise<void> => {
  await page.clock.install({ time: new Date('2026-09-08T12:00:00-07:00') });
  await page.goto(`${base}${extra}#data/today`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-today-view]')).toHaveAttribute('aria-busy', 'false');
};

test('Today merges all kinds, exposes source freshness, and renders within a mobile viewport', async ({ page }) => {
  await boot(page);
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-today-group="overdue"]')).toContainText('Send the proposal');
  const today = page.locator('[data-today-group="today"]');
  await expect(today).toContainText('Review the brief');
  await expect(today).toContainText('Deliver the draft to Maya');
  await expect(today).toContainText('Design review');
  await expect(today).toContainText('All day · In progress');
  await expect(today).toContainText('Sync stale');
  await expect(today).toContainText('work-calendar');
  await expect(page.locator('[data-today-group="next"]')).toContainText('Prepare the demo');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('[data-today-view]').screenshot({ path: '/tmp/recued-today-mobile.png' });
});

test('original task, commitment, and source-qualified calendar details return to Today with browser Back', async ({ page }) => {
  await boot(page);
  for (const [title, hash] of [
    ['Send the proposal', '#data/task/late%2Ftask'],
    ['Deliver the draft to Maya', '#data/commitment/promise'],
    ['Design review', '#data/calendar/record/work-calendar/cal%3Aevent%2Fone'],
  ] as const) {
    const link = page.locator('[data-today-view]').getByRole('link', { name: title, exact: true });
    await expect(link).toHaveAttribute('href', hash);
    await link.click();
    await expect(page).toHaveURL(new RegExp(hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
    if (title === 'Design review') await expect(page.locator('[data-recued-collection-detail-heading]')).toContainText(title);
    else await expect(page.getByRole('dialog')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#data\/today$/);
    await expect(page.locator('[data-today-view]')).toHaveAttribute('aria-busy', 'false');
  }
});

test('Refresh and the minute clock advance deadlines without losing keyboard focus', async ({ page }) => {
  await boot(page);
  const refresh = page.locator('.today-refresh');
  await refresh.click();
  await expect(refresh).toHaveAttribute('aria-disabled', 'false');
  await expect(refresh).toBeFocused();
  const link = page.getByRole('link', { name: 'Review the brief', exact: true });
  await link.focus();
  await page.clock.setSystemTime(new Date('2026-09-09T00:01:00-07:00'));
  await page.evaluate(() => {
    const heartbeat = (): void => window.__app.fireMessage({ type: 'server_heartbeat', ts: Date.now() });
    heartbeat();
    setInterval(heartbeat, 10_000);
  });
  await page.clock.runFor(60_001);
  await expect(page.locator('[data-today-group="overdue"]')).toContainText('Review the brief');
  await expect(page.locator('[data-today-group="today"]')).toContainText('Prepare the demo');
  await expect(link).toBeFocused();
  await expect(page.getByRole('link', { name: 'Design review', exact: true })).toHaveCount(0);
});

test('a failed calendar still shows tasks and commitments, with an explicit partial result', async ({ page }) => {
  await boot(page, '&today_failure=1');
  await expect(page.locator('[data-today-view]')).toContainText('Results below may be incomplete');
  await expect(page.getByRole('link', { name: 'Review the brief', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Deliver the draft to Maya', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Design review', exact: true })).toHaveCount(0);
});

test('refresh keeps keyboard focus in Today when the focused record disappears', async ({ page }) => {
  await boot(page);
  await page.getByRole('link', { name: 'Review the brief', exact: true }).focus();
  await page.evaluate(() => {
    document.documentElement.dataset.todayHideTask = 'task-today';
    document.querySelector<HTMLButtonElement>('.today-refresh')!.click();
  });
  await expect(page.getByRole('link', { name: 'Review the brief', exact: true })).toHaveCount(0);
  await expect(page.locator('.today-refresh')).toBeFocused();
});

test('Today can be saved and reopens the relative view after reload', async ({ page }) => {
  await boot(page);
  const tools = page.locator('[data-saved-data-views]');
  await tools.getByRole('button', { name: 'Save current view', exact: true }).click();
  await tools.getByLabel('View name', { exact: true }).fill('My day');
  await tools.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(tools.locator('[data-view-notice]')).toContainText('Saved');
  await tools.locator('summary').click();
  await tools.getByRole('link', { name: 'My day', exact: true }).click();
  await expect(page).toHaveURL(/#data\/view\//);
  await page.reload();
  await expect(page.locator('[data-today-view]')).toContainText('Deliver the draft to Maya');
});
