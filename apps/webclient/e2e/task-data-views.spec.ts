import { expect, test, type Page } from '@playwright/test';

test.use({ timezoneId: 'America/Los_Angeles', viewport: { width: 390, height: 844 } });
const URL_BASE = 'http://127.0.0.1:4319/full-app-harness.html?data=work-entities-paged&task_filters=1';
const row = (page: Page, id: number) => page.locator(`[data-action="open-edit-work-entity"][data-entity-id="task-${id}"]`);
const boot = async (page: Page): Promise<void> => {
  await page.clock.setFixedTime(new Date('2026-09-07T14:00:00-07:00'));
  await page.goto(`${URL_BASE}#data/task`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.getByLabel('Task status', { exact: true })).toBeVisible();
};

test('task search returns a match beyond page one and keeps keyboard focus', async ({ page }) => {
  await boot(page);
  await expect(row(page, 1)).toBeVisible();
  await expect(row(page, 4)).toHaveCount(0);
  const search = page.getByRole('searchbox', { name: 'Search tasks' });
  await search.fill('Task 4');
  await expect(row(page, 4)).toBeVisible();
  await expect(row(page, 1)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
  await expect(search).toBeFocused();
  await search.fill('');
  await expect(row(page, 1)).toBeVisible();
});

test('saved task filters survive reload and their relative dates advance on reopening', async ({ page }) => {
  await boot(page);
  const status = page.getByLabel('Task status', { exact: true });
  const due = page.getByLabel('Due date', { exact: true });
  const sort = page.getByLabel('Sort tasks', { exact: true });
  await status.selectOption('open');
  await due.selectOption('today');
  await sort.focus();
  await sort.selectOption('due_asc');
  await expect(row(page, 3)).toBeVisible();
  await expect(sort).toBeFocused();
  const tools = page.locator('[data-saved-data-views]');
  await tools.getByRole('button', { name: 'Save current view', exact: true }).click();
  await tools.getByLabel('View name', { exact: true }).fill('Due today');
  await tools.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(tools.locator('[data-view-notice]')).toContainText('Saved');
  await tools.locator('summary').click();
  const link = tools.locator('details').getByRole('link', { name: 'Due today', exact: true });
  const href = await link.getAttribute('href');
  await link.click();
  await page.reload();
  await expect(status).toHaveValue('open');
  await expect(due).toHaveValue('today');
  await expect(sort).toHaveValue('due_asc');
  await expect(row(page, 3)).toBeVisible();
  await page.clock.setFixedTime(new Date('2026-09-08T10:00:00-07:00'));
  await page.reload();
  await expect(row(page, 0)).toBeVisible();
  await expect(row(page, 3)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await row(page, 0).scrollIntoViewIfNeeded();
  const boxes = await page.getByRole('group', { name: 'Task filters' }).getByRole('combobox').evaluateAll((controls) =>
    controls.map((control) => { const rect = control.getBoundingClientRect(); return { left: rect.left, right: rect.right, height: rect.height }; }));
  expect(boxes.every((box) => box.left >= 0 && box.right <= 390 && box.height >= 36)).toBe(true);
  await page.screenshot({ path: '/tmp/recued-task-data-view.png', fullPage: true });
});

test('completion and overdue filters compose, and due sorting applies before Load more', async ({ page }) => {
  await boot(page);
  const status = page.getByLabel('Task status', { exact: true });
  const due = page.getByLabel('Due date', { exact: true });
  const sort = page.getByLabel('Sort tasks', { exact: true });
  await due.selectOption('overdue');
  await expect(row(page, 1)).toBeVisible();
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(row(page, 3)).toBeVisible();
  await expect(row(page, 2)).toHaveCount(0);
  await status.selectOption('completed');
  await expect(page.getByText('No tasks match these filters.', { exact: true })).toBeVisible();
  await due.selectOption('all');
  await expect(row(page, 2)).toBeVisible();
  await status.selectOption('all');
  await sort.selectOption('due_asc');
  await expect(row(page, 2)).toBeVisible();
  await expect(row(page, 1)).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(row(page, 1)).toBeVisible();
  const ids = await page.locator('.work-entity-list-row-button').evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('data-entity-id')));
  expect(ids).toEqual(['task-2', 'task-1']);
});
