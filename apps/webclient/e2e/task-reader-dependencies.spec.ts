import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskReaderFixture } from './helpers/task-reader-fixture.js';
import { installTaskBlockersFixture } from './helpers/task-blockers-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installTaskReaderFixture>>;
const reader = (page: Page) => page.locator('.work-entity-task-reader');
const dependencies = (page: Page) => reader(page).locator('[data-task-section="dependencies"]');
const summary = (page: Page) => dependencies(page).locator('[data-task-dependency-summary]');
const dependency = (page: Page, name = 'Other task') => dependencies(page).getByRole('button', { name: `Open task ${name}`, exact: true });
const editor = (page: Page) => page.locator('.work-entity-dialog[data-kind="task"][data-mode="edit"]');
const boot = async (page: Page, prepare?: (fixture: Fixture) => void, hash = '#data/task/task-one') => {
  const fixture = await installTaskReaderFixture(page); fixture.update({ blocks_task_ids: ['task-two'] }); prepare?.(fixture);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true); return fixture;
};
const back = (page: Page) => reader(page).getByRole('button', { name: 'Back to task', exact: true });

test('reads named dependencies and confirmed status without writes or duplicate references', async ({ page }, info) => {
  const f = await boot(page, f => {
    f.update({ blocks_task_ids: ['task-two', 'task-two', 'finished'] });
    f.seedTask('finished', { title: 'Approve <img src=x>', done: true });
  });
  try {
    await expect(summary(page)).toHaveText('Waiting on 1 task');
    await expect(dependencies(page)).toContainText('Recued · Open'); await expect(dependencies(page)).toContainText('Recued · Completed');
    await expect(dependencies(page).getByRole('button', { name: 'Open task Approve <img src=x>', exact: true })).toBeVisible();
    await expect(dependencies(page).locator('img')).toHaveCount(0); await expect(dependency(page)).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('task-reader-dependencies-phone.png'), fullPage: true });
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('keyboard navigation restores the parent task scroll, disclosure and focus', async ({ page }) => {
  const f = await boot(page);
  try {
    await expect(dependency(page)).toBeVisible(); await dependency(page).focus();
    const scroll = await reader(page).locator('.work-entity-task-content').evaluate(el => el.scrollTop);
    await dependency(page).press('Enter'); await expect(reader(page).getByRole('heading', { name: 'Other task', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#data\/task\/task-two$/); await back(page).click();
    await expect(page).toHaveURL(/#data\/task\/task-one$/); await expect(dependency(page)).toBeFocused();
    await expect(dependencies(page)).toHaveAttribute('open', '');
    expect(await reader(page).locator('.work-entity-task-content').evaluate(el => el.scrollTop)).toBeCloseTo(scroll, -1); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('nested dependency visits and browser Back retain each parent and the task-list return', async ({ page }) => {
  const f = await boot(page, f => { f.seedTask('task-three', { title: 'Third task' }); f.updateTask('task-two', { blocks_task_ids: ['task-three'] }); });
  try {
    await dependency(page).click(); await dependency(page, 'Third task').click();
    await expect(reader(page).getByRole('heading', { name: 'Third task', exact: true })).toBeVisible();
    await page.goBack(); await expect(dependency(page, 'Third task')).toBeFocused();
    await back(page).click(); await expect(dependency(page)).toBeFocused();
    await reader(page).getByRole('button', { name: 'Back to tasks', exact: true }).click();
    await expect(reader(page)).toHaveCount(0); await expect(page).toHaveURL(/#data\/task$/); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('completion in a dependency refreshes its parent and the original task list without changing the parent', async ({ page }) => {
  const f = await boot(page), original = f.task();
  try {
    await dependency(page).click(); await reader(page).getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(reader(page).locator('[data-task-completion-status]')).toHaveText('Task completed.'); await back(page).click();
    await expect(summary(page)).toHaveText('Dependencies complete'); await expect(dependencies(page)).toContainText('Recued · Completed');
    expect(f.task()).toEqual(original); expect(f.task('task-two').done).toBe(true);
    await reader(page).getByRole('button', { name: 'Back to tasks', exact: true }).click();
    await expect(page.locator('[data-task-blockers="task-one"] summary')).toHaveText('Dependencies complete');
    expect(f.writes).toEqual([{ method: 'work_entity.task.mark_done', args: { id: 'task-two', done: true } }]);
  } finally { f.dispose(); }
});

test('a dependency detour preserves the original project return', async ({ page }) => {
  const f = await boot(page, undefined, '#data/project/project-one');
  try {
    await page.locator('[data-action="project-work-open"][data-project-item-id="task-one"]').click();
    await dependency(page).click(); await back(page).click();
    await reader(page).getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(page.locator('.project-overview')).toBeVisible(); await expect(page).toHaveURL(/#data\/project\/project-one$/); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a nested reader dependency preserves the Today sphere, disclosure and return route', async ({ page }) => {
  const f = await installTaskBlockersFixture(page); f.update('blocker-open', { blocks_task_ids: ['blocker-done'] });
  try {
    await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#today`); await page.waitForFunction(() => window.__app?.ready === true);
    await page.getByRole('combobox', { name: 'Today sphere' }).selectOption('professional');
    const blockers = page.locator('[data-task-blockers="owner-one"]'); await blockers.locator('summary').click();
    await blockers.getByRole('link', { name: 'Review launch', exact: true }).click();
    await dependency(page, 'Approve launch').click(); await back(page).click();
    await reader(page).getByRole('button', { name: 'Back to Today', exact: true }).click();
    await expect(page).toHaveURL(/#today$/); await expect(page.getByRole('combobox', { name: 'Today sphere' })).toHaveValue('professional');
    await expect(blockers).toHaveAttribute('open', ''); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('missing and failed reads remain unavailable and can be retried without losing the reader', async ({ page }) => {
  const f = await boot(page, f => { f.removeTask('task-two'); f.update({ blocks_task_ids: ['task-two', 'failed'] }); f.seedTask('failed'); f.fail('work_entity.get', 'failed'); });
  try {
    await expect(summary(page)).toHaveText('Dependency status unavailable');
    await expect(dependencies(page)).toContainText('This task is no longer available.');
    await expect(dependencies(page)).toContainText('Could not load this task. Try again.');
    f.seedTask('task-two', { title: 'Restored dependency', done: true }); f.fail('work_entity.get', 'failed', false);
    await dependencies(page).locator('[data-task-related-key="task:task-two"][data-action="retry-task-related"]').click();
    await dependencies(page).locator('[data-task-related-key="task:failed"][data-action="retry-task-related"]').click();
    await expect(summary(page)).toHaveText('Waiting on 1 task'); await expect(dependency(page, 'Restored dependency')).toBeVisible(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('pending and stale completion stay unconfirmed while still allowing a read-only dependency visit', async ({ page }) => {
  const f = await boot(page, f => f.taskReply('task-two', { entity: { ...f.task('task-two'), _kind: 'task', done: true,
    pending_write: { staged_at: 1, operation: 'update', dirty_fields: ['done'], state: 'awaiting_verify' } } }));
  try {
    await expect(summary(page)).toHaveText('Dependency status unavailable'); await expect(dependencies(page)).toContainText('Change awaiting confirmation');
    await dependency(page).click(); await expect(reader(page)).toContainText('waiting for source confirmation');
    await expect(reader(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0); await back(page).click();
    f.taskReply('task-two', { entity: { ...f.task('task-two'), _kind: 'task', done: true, sync_state: 'stale_unreachable' } });
    await dependencies(page).getByRole('button', { name: 'Check dependencies again', exact: true }).click();
    await expect(dependencies(page)).toContainText('Status unconfirmed'); await expect(summary(page)).toHaveText('Dependency status unavailable'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('expiring freshness changes completed dependency and owner certainty while the reader stays open', async ({ page }) => {
  const f = await installTaskBlockersFixture(page), at = Date.parse('2026-11-16T12:00:00Z'); f.update('blocker-open', { done: true });
  f.fresh('blocker-open', { state: 'fresh', last_success_at: at, stale_after_ms: 300000 });
  f.fresh('owner-one', { state: 'fresh', last_success_at: at, stale_after_ms: 400000 });
  try {
    await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/task/owner-one`);
    await expect(summary(page)).toHaveText('Dependencies complete'); await page.clock.fastForward(360000);
    await expect(summary(page)).toHaveText('Dependency status unavailable'); await expect(dependencies(page)).toContainText('Status unconfirmed');
    await page.clock.fastForward(120000); await expect(dependencies(page)).toContainText('saved dependency list may be out of date'); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('a late dependency activation cannot replace a newer task visit', async ({ page }) => {
  const f = await boot(page);
  try {
    await expect(dependency(page)).toBeVisible(); f.hold('work_entity.get', 'task-two'); await dependency(page).click();
    await expect.poll(() => f.waiting()).toBe(true); await page.evaluate(() => window.__app.setHash('#data/task/task-two'));
    await expect(reader(page).getByRole('heading', { name: 'Other task', exact: true })).toBeVisible();
    f.release(); await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(key => key === 'work_entity.get:task-two').length >= 3);
    await expect(page).toHaveURL(/#data\/task\/task-two$/); await expect(back(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a reused canonical task id is rejected until its new identity is explicitly checked', async ({ page }) => {
  const f = await boot(page);
  try {
    await expect(dependency(page)).toBeVisible(); f.removeTask('task-two'); f.seedTask('task-two', { title: 'Replacement task' }, Date.parse('2026-11-01T18:00:00Z'));
    await dependency(page).click(); await expect(dependencies(page)).toContainText('The linked task changed. Try again to check it.');
    await expect(page).toHaveURL(/#data\/task\/task-one$/);
    await dependencies(page).getByRole('button', { name: 'Try again', exact: true }).click(); await dependency(page, 'Replacement task').click();
    await expect(reader(page).getByRole('heading', { name: 'Replacement task', exact: true })).toBeVisible(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('dirty dependency edits require a decision and saved edits refresh the parent name', async ({ page }) => {
  const f = await boot(page);
  try {
    await dependency(page).click(); await reader(page).getByRole('button', { name: 'Edit', exact: true }).click(); await editor(page).getByLabel('Title').fill('Reviewed dependency');
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(editor(page).getByLabel('Title')).toHaveValue('Reviewed dependency');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await back(page).click();
    await expect(dependency(page, 'Reviewed dependency')).toBeVisible(); expect(f.task().title).toBe('Plan launch <img src=x>');
    expect(f.writes).toEqual([{ method: 'work_entity.upsert', args: { kind: 'task', id: 'task-two', title: 'Reviewed dependency' } }]);
  } finally { f.dispose(); }
});

test('self references remain unconfirmed and never open another reader', async ({ page }) => {
  const f = await boot(page, f => f.update({ blocks_task_ids: ['task-one'] }));
  try {
    await expect(summary(page)).toHaveText('Dependency status unavailable'); await expect(dependencies(page)).toContainText('This task depends on itself.');
    await expect(dependencies(page).getByRole('button', { name: /^Open task / })).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('returns through universal search with its original query and focused result', async ({ page }) => {
  const f = await boot(page, undefined, '#data/search');
  try {
    const query = page.getByRole('searchbox', { name: 'Search everything', exact: true }); await query.fill('Plan launch');
    const result = page.locator('[data-work-search-group="task"] [data-search-work-id="task-one"]'); await result.click();
    await dependency(page).click(); await back(page).click();
    await reader(page).getByRole('button', { name: 'Back to search', exact: true }).click();
    await expect(query).toHaveValue('Plan launch'); await expect(result).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('browser Back protects a dependency draft and retains its recovery copy after approved leave', async ({ page }) => {
  const f = await boot(page), prompts: string[] = [];
  try {
    await dependency(page).click(); await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByLabel('Title').fill('Recover this dependency edit');
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); });
    await page.goBack(); await expect.poll(() => prompts.length).toBe(1); await expect(editor(page).getByLabel('Title')).toHaveValue('Recover this dependency edit');
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.accept(); });
    await page.goBack(); await expect.poll(() => prompts.length).toBe(2); await expect(dependency(page)).toBeFocused();
    await dependency(page).click(); await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor(page).getByLabel('Title')).toHaveValue('Recover this dependency edit'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('explicitly discarding a dependency editor through Close returns to its parent without a draft', async ({ page }) => {
  const f = await boot(page);
  try {
    await dependency(page).click(); await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByLabel('Title').fill('Discard this dependency edit'); await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(dependency(page)).toBeFocused(); await dependency(page).click(); await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(page).getByLabel('Title')).toHaveValue('Other task');
    await expect(editor(page).getByRole('button', { name: 'Resume draft', exact: true })).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a failed parent refresh keeps its saved dependency list unconfirmed until a successful recheck', async ({ page }) => {
  const f = await boot(page);
  try {
    await dependency(page).click(); await reader(page).getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(reader(page).locator('[data-task-completion-status]')).toHaveText('Task completed.');
    f.fail('work_entity.get', 'task-one'); await back(page).click();
    await expect(reader(page).locator('[data-task-notice]')).toContainText('Could not refresh this task');
    await expect(summary(page)).toHaveText('Dependency status unavailable');
    await expect(dependencies(page)).toContainText('saved dependency list may be out of date');
    f.fail('work_entity.get', 'task-one', false);
    await dependencies(page).getByRole('button', { name: 'Check dependencies again', exact: true }).click();
    await expect(summary(page)).toHaveText('Dependencies complete');
    await expect(dependencies(page)).not.toContainText('saved dependency list may be out of date');
    await expect(reader(page).locator('[data-task-notice]')).toHaveCount(0);
    expect(f.writes).toEqual([{ method: 'work_entity.task.mark_done', args: { id: 'task-two', done: true } }]);
  } finally { f.dispose(); }
});
