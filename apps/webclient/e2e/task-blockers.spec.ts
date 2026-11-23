import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskBlockersFixture } from './helpers/task-blockers-fixture.js';

installFullAppHooks();
const blockers = (page: Page, owner = 'owner-one') => page.locator(`[data-task-blockers="${owner}"]`);
const editor = (page: Page) => page.locator('.work-entity-dialog[data-kind="task"]');
const boot = async (page: Page, surface: 'tasks' | 'today' = 'tasks', prepare?: (fixture: Awaited<ReturnType<typeof installTaskBlockersFixture>>) => void) => {
  const fixture = await installTaskBlockersFixture(page); prepare?.(fixture);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple${surface === 'today' ? '#today' : '#data/task'}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  return fixture;
};
const expand = async (page: Page) => { await blockers(page).locator('summary').click(); await expect(blockers(page)).toHaveAttribute('open', ''); };

test('shows named blockers, returns to the filtered task list, and refreshes after completing a dependency', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 }); const fixture = await boot(page);
  try {
    await expect(blockers(page).locator('summary')).toHaveText('Waiting on 1 task');
    await expect(blockers(page, 'owner-two').locator('summary')).toHaveText('Waiting on 1 task');
    expect(fixture.reads.filter(id => id === 'blocker-open')).toHaveLength(1);
    const search = page.locator('[data-action="search-work-entities"][data-kind="task"]'); await search.fill('Ship launch');
    await expect(blockers(page, 'owner-two')).toHaveCount(0); await expand(page);
    await expect(blockers(page)).toContainText('Recued · Open'); await expect(blockers(page)).toContainText('Imported · Completed');
    await blockers(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('task-blockers-waiting-phone.png'), fullPage: true });
    const link = blockers(page).getByRole('link', { name: 'Review launch', exact: true }); await link.focus(); await link.press('Enter');
    await expect(editor(page).getByRole('heading', { name: 'Review launch', exact: true })).toBeVisible();
    await editor(page).getByRole('button', { name: 'Back to tasks', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    await expect(search).toHaveValue('Ship launch'); await expect(blockers(page)).toHaveAttribute('open', '');
    await expect(link).toBeFocused(); await link.click();
    await editor(page).getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(editor(page).locator('[data-task-completion-status]')).toHaveText('Task completed.');
    await editor(page).getByRole('button', { name: 'Back to tasks', exact: true }).click();
    await expect(blockers(page).locator('summary')).toHaveText('Dependencies complete');
    expect(fixture.task('blocker-open').done).toBe(true); expect(fixture.task().blocks_task_ids).toEqual(['blocker-open', 'blocker-done']);
    await blockers(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('task-blockers-phone.png'), fullPage: true });
  } finally { fixture.dispose(); }
});

test('returns from a dependency to Today with its sphere and disclosure intact', async ({ page }) => {
  const fixture = await boot(page, 'today');
  try {
    await expect(blockers(page).locator('summary')).toHaveText('Waiting on 1 task');
    await page.getByRole('combobox', { name: 'Today sphere' }).selectOption('professional'); await expand(page);
    await blockers(page).getByRole('link', { name: 'Review launch', exact: true }).click();
    await expect(editor(page).getByRole('heading', { name: 'Review launch', exact: true })).toBeVisible();
    await editor(page).getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(editor(page).locator('[data-task-completion-status]')).toHaveText('Task completed.');
    await editor(page).getByRole('button', { name: 'Back to Today', exact: true }).click();
    await expect(page).toHaveURL(/#today$/); await expect(page.getByRole('combobox', { name: 'Today sphere' })).toHaveValue('professional');
    await expect(blockers(page)).toHaveAttribute('open', ''); await expect(blockers(page).locator('summary')).toHaveText('Dependencies complete');
    expect(fixture.task('blocker-open').done).toBe(true); expect(fixture.task().body).toBe('Keep the launch notes.');
  } finally { fixture.dispose(); }
});

test('keeps missing and stale completion explicit and never reports the remaining links as complete', async ({ page }) => {
  const fixture = await boot(page, 'tasks', fixture => { fixture.remove('blocker-open'); fixture.fresh('blocker-done', { state: 'stale' }); });
  try {
    await expect(blockers(page).locator('summary')).toHaveText('Dependency status unavailable'); await expand(page);
    await expect(blockers(page)).toContainText('Unavailable task'); await expect(blockers(page)).toContainText('Completed · Last saved status; may be out of date');
    await expect(blockers(page).getByRole('link')).toHaveCount(1); expect(fixture.mutations).toEqual([]);
    expect(fixture.task().blocks_task_ids).toEqual(['blocker-open', 'blocker-done']);
  } finally { fixture.dispose(); }
});

test('retries failed dependency reads and safely displays task titles as text', async ({ page }) => {
  const fixture = await boot(page, 'tasks', fixture => { fixture.fail('blocker-open', true); fixture.update('blocker-open', { title: '<img src=x onerror="throw Error(1)">' }); });
  try {
    await expect(blockers(page).locator('summary')).toHaveText('Dependency status unavailable'); await expand(page);
    await expect(blockers(page)).toContainText('Task status unavailable'); fixture.fail('blocker-open', false);
    const retry = blockers(page).getByRole('button', { name: 'Check dependencies again', exact: true }); await retry.focus(); await retry.press('Enter');
    await expect(blockers(page).locator('summary')).toHaveText('Waiting on 1 task');
    await expect(retry).toBeFocused();
    await expect(blockers(page).getByRole('link', { name: '<img src=x onerror="throw Error(1)">', exact: true })).toBeVisible();
    await expect(blockers(page).locator('img,script')).toHaveCount(0); expect(fixture.mutations).toEqual([]);
  } finally { fixture.dispose(); }
});

test('a stale parent source cannot report complete from fresh completed dependency rows', async ({ page }) => {
  const fixture = await boot(page, 'tasks', fixture => {
    fixture.update('blocker-open', { done: true }); fixture.ownerFresh({ source_id: 'recued.task', state: 'stale' });
  });
  try {
    await expect(blockers(page).locator('summary')).toHaveText('Dependency status unavailable'); await expand(page);
    await expect(blockers(page)).toContainText('The saved dependency list may be out of date.');
    await expect(blockers(page).getByRole('link')).toHaveCount(2); expect(fixture.mutations).toEqual([]);
  } finally { fixture.dispose(); }
});

test('expires a completed dependency status while Tasks stays open', async ({ page }) => {
  const fixture = await boot(page, 'tasks', fixture => {
    fixture.update('blocker-open', { done: true }); fixture.fresh('blocker-open', { state: 'fresh', last_success_at: Date.parse('2026-11-16T12:00:00Z'), stale_after_ms: 300000 });
  });
  try {
    await expect(blockers(page).locator('summary')).toHaveText('Dependencies complete');
    await page.clock.fastForward(360000); await expect(blockers(page).locator('summary')).toHaveText('Dependency status unavailable');
    await expand(page); await expect(blockers(page)).toContainText('Last saved status; may be out of date');
    expect(fixture.mutations).toEqual([]);
  } finally { fixture.dispose(); }
});

test('protects dependency edits before returning to Today and refreshes the saved title on Save', async ({ page }) => {
  const fixture = await boot(page, 'today');
  try {
    await expect(blockers(page).locator('summary')).toHaveText('Waiting on 1 task'); await expand(page);
    await blockers(page).getByRole('link', { name: 'Review launch', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByLabel('Title').fill('Reviewed launch');
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(editor(page).getByLabel('Title')).toHaveValue('Reviewed launch');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page).getByRole('heading', { name: 'Reviewed launch', exact: true })).toBeVisible();
    await editor(page).getByRole('button', { name: 'Back to Today', exact: true }).click();
    await expect(page).toHaveURL(/#today$/); await expect(blockers(page)).toHaveAttribute('open', '');
    await expect(blockers(page).getByRole('link', { name: 'Reviewed launch', exact: true })).toBeVisible();
    expect(fixture.task('blocker-open').title).toBe('Reviewed launch'); expect(fixture.task().body).toBe('Keep the launch notes.');
    expect(fixture.mutations).toEqual([{ method: 'work_entity.upsert', args: { kind: 'task', id: 'blocker-open', title: 'Reviewed launch' } }]);
  } finally { fixture.dispose(); }
});

test('keeps a return to Today available when a task can no longer be opened', async ({ page }) => {
  const fixture = await boot(page, 'today');
  try {
    await expect(blockers(page).locator('summary')).toHaveText('Waiting on 1 task'); await expand(page); fixture.fail('blocker-open', true);
    await blockers(page).getByRole('link', { name: 'Review launch', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Back to Today', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to Today', exact: true }).click();
    await expect(page).toHaveURL(/#today$/); await expect(blockers(page).locator('summary')).toHaveText('Dependency status unavailable');
    expect(fixture.mutations).toEqual([]);
  } finally { fixture.dispose(); }
});

test('a late completed read cannot replace a newer open status after refreshing Tasks', async ({ page }) => {
  const fixture = await boot(page, 'tasks', fixture => { fixture.update('blocker-open', { done: true }); fixture.hold('blocker-open'); });
  try {
    await expect.poll(() => fixture.waiting('blocker-open')).toBe(true); fixture.update('blocker-open', { done: false });
    await page.getByRole('button', { name: 'Task filters', exact: true }).click();
    await page.getByRole('combobox', { name: 'Task status', exact: true }).selectOption('open');
    await expect(blockers(page).locator('summary')).toHaveText('Waiting on 1 task'); fixture.release('blocker-open');
    await expect(blockers(page).locator('summary')).toHaveText('Waiting on 1 task'); expect(fixture.mutations).toEqual([]);
  } finally { fixture.dispose(); }
});

test('keeps a Today reschedule editor intact when opening a dependency would leave it', async ({ page }) => {
  const fixture = await boot(page, 'today');
  try {
    await expect(blockers(page).locator('summary')).toHaveText('Waiting on 1 task'); await expand(page);
    const row = page.locator('[data-today-item="task:owner-one"]');
    await row.getByRole('button', { name: 'Reschedule Ship launch', exact: true }).click();
    const due = row.locator('[data-recued-today-action="today-task-due"]'); await due.fill('2026-11-18T10:15');
    await blockers(page).getByRole('link', { name: 'Review launch', exact: true }).click();
    await expect(page).toHaveURL(/#today$/); await expect(due).toHaveValue('2026-11-18T10:15');
    await expect(blockers(page).getByRole('alert')).toContainText('Finish or cancel'); expect(fixture.mutations).toEqual([]);
  } finally { fixture.dispose(); }
});
