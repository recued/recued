import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailFollowUpFixture } from './helpers/mail-follow-up-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC' });
const watchDialog = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const linked = (page: Page) => watchDialog(page).getByRole('region', { name: 'Linked task', exact: true });
const taskDialog = (page: Page) => page.locator('[data-kind="task"][data-mode="read"][role="dialog"]');
const taskStatus = (page: Page) => taskDialog(page).getByRole('region', { name: 'Task email reply watch', exact: true });
const boot = async (page: Page, holdTaskRead = false) => {
  const f = await installMailFollowUpFixture(page, { verifyMessages: true, tasks: true });
  if (!f.taskFixture) throw Error('Missing canonical task fixture');
  const watch = await f.service.start(f.request(), 'paired-owner');
  if (holdTaskRead) f.hold('mail.follow_up.task.get');
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser#mail/reply-watch/${watch.id}`);
  await page.waitForFunction(() => window.__app?.ready === true); await expect(watchDialog(page)).toBeVisible();
  return { ...f, taskFixture: f.taskFixture, watch };
};
const chooseTask = async (page: Page) => {
  await linked(page).getByRole('button', { name: 'Link a task', exact: true }).click();
  await linked(page).getByRole('combobox', { name: 'Find an existing task', exact: true }).fill('revised');
  await linked(page).getByRole('option', { name: /Get revised estimate/ }).click();
};
const saveTask = async (page: Page) => {
  await chooseTask(page); await linked(page).getByRole('button', { name: 'Save task link', exact: true }).click();
  await expect(linked(page).getByRole('link', { name: 'Get revised estimate', exact: true })).toBeVisible();
};

test('links an existing task, shows waiting and reply status in Today and task details, then completes only on the explicit task action', async ({ page }) => {
  const f = await boot(page);
  try {
    await saveTask(page); expect(f.taskFixture.currentTask()!.done).toBe(false);
    await linked(page).getByRole('link', { name: 'Get revised estimate', exact: true }).click(); await expect(taskDialog(page)).toBeVisible();
    await expect(taskStatus(page)).toContainText('Waiting for a reply');
    await page.evaluate(() => window.__app.setHash('#today'));
    const row = page.locator(`[data-today-item="task:${f.taskFixture.task.id}"]`); await expect(row).toContainText('Waiting for a reply');
    const refresh = row.getByRole('button', { name: 'Refresh reply status', exact: true }); await refresh.focus();
    const reads = f.calls.filter(call => call.method === 'work_entity.list').length;
    await page.evaluate(id => window.__app.fireMessage({ type: 'server_event', event: {
      kind: 'warehouse', collection: 'task', op: 'update', id, cursor: Date.now() + 10000,
    } }), f.taskFixture.task.id);
    await expect.poll(() => f.calls.filter(call => call.method === 'work_entity.list').length).toBeGreaterThan(reads);
    await expect(page.locator('[data-today-view]')).toHaveAttribute('aria-busy', 'false'); await expect(refresh).toBeFocused();
    f.due(f.watch.check_at); await page.clock.setFixedTime(new Date(f.now()));
    await row.getByRole('button', { name: 'Refresh reply status', exact: true }).click(); await expect(row).toContainText('Reply check due');
    f.add({ received_at: f.now() + 1 }); await f.service.check(f.watch.id);
    await row.getByRole('button', { name: 'Refresh reply status', exact: true }).click(); await expect(row).toContainText('Reply received');
    expect(f.taskFixture.currentTask()!.done).toBe(false);
    await row.getByRole('link', { name: 'Open task: Get revised estimate', exact: true }).click(); await expect(taskStatus(page)).toContainText('Reply received');
    await taskStatus(page).getByRole('link', { name: 'Review received reply', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toBeVisible(); expect(f.taskFixture.currentTask()!.done).toBe(false);
    await page.evaluate(id => window.__app.setHash('#data/task/' + encodeURIComponent(id)), f.taskFixture.task.id);
    await expect(taskStatus(page)).toContainText('Reply received');
    await taskDialog(page).getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(taskDialog(page).locator('[data-task-completion-status]')).toHaveText('Task completed.');
    expect(f.taskFixture.currentTask()!.done).toBe(true);
    expect(f.calls.filter(call => call.method === 'work_entity.task.mark_done')).toHaveLength(1);
  } finally { f.dispose(); }
});

test('a lost task-link response checks the same save without duplicating the link or completing the task', async ({ page }) => {
  const f = await boot(page);
  try {
    await chooseTask(page); f.loseTaskLinkReply(); await linked(page).getByRole('button', { name: 'Save task link', exact: true }).click();
    await expect(linked(page)).toContainText('save outcome is not confirmed');
    await linked(page).getByRole('button', { name: 'Check save', exact: true }).click();
    await expect(linked(page).getByRole('link', { name: 'Get revised estimate', exact: true })).toBeVisible();
    const calls = f.calls.filter(call => call.method === 'mail.follow_up.task.set'); expect(calls).toHaveLength(2); expect(calls[0]!.args).toEqual(calls[1]!.args);
    expect(f.db.prepare('SELECT count(*) AS n FROM mail_follow_ups WHERE task_key IS NOT NULL').get()).toEqual({ n: 1 });
    expect(f.taskFixture.currentTask()!.done).toBe(false);
  } finally { f.dispose(); }
});

test('refuses an out-of-date task and still lets the owner unlink it after its source becomes unavailable', async ({ page }) => {
  const f = await boot(page);
  try {
    f.taskFixture.stale(true); await chooseTask(page); await linked(page).getByRole('button', { name: 'Save task link', exact: true }).click();
    await expect(linked(page).getByRole('alert')).toBeVisible(); expect((await f.service.check(f.watch.id)).task_ref).toBeUndefined();
    f.taskFixture.stale(false); await linked(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await saveTask(page);
    f.taskFixture.unavailable(true); await watchDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => window.__app.setHash('#mail'));
    await page.evaluate(hash => window.__app.setHash(hash), '#mail/reply-watch/' + f.watch.id);
    await expect(linked(page)).toContainText('could not be checked'); f.loseTaskLinkReply();
    await linked(page).getByRole('button', { name: 'Unlink task', exact: true }).click();
    await expect(linked(page)).toContainText('save outcome is not confirmed'); await linked(page).getByRole('button', { name: 'Check save', exact: true }).click();
    await expect(linked(page).getByRole('button', { name: 'Link a task', exact: true })).toBeVisible();
    expect((await f.service.check(f.watch.id)).task_ref).toBeUndefined(); expect(f.taskFixture.currentTask()!.done).toBe(false);
  } finally { f.dispose(); }
});

test('closing the watch while its task lookup is pending prevents a late panel or focus takeover', async ({ page }) => {
  const f = await boot(page, true);
  try {
    await expect.poll(() => f.isHeld()).toBe(true); await watchDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
    f.release(); await expect(watchDialog(page)).toHaveCount(0);
    await expect.poll(() => f.heldSettled()).toBe(true);
    await expect(page.getByRole('button', { name: 'Reply watches', exact: true })).toBeFocused();
    expect(f.calls.filter(call => call.method === 'mail.follow_up.task.set')).toEqual([]);
  } finally { f.dispose(); }
});

test('a late Today watch lookup cannot attach a prior task status to a different task reader', async ({ page }) => {
  const f = await boot(page);
  try {
    await saveTask(page); const other = await f.taskFixture.createTask('Check delivery date');
    f.hold('mail.follow_up.task.list'); await watchDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => window.__app.setHash('#today')); await expect.poll(() => f.isHeld()).toBe(true);
    await page.evaluate(id => window.__app.setHash('#data/task/' + encodeURIComponent(id)), other.id);
    await expect(taskDialog(page)).toContainText('Check delivery date');
    f.release(); await expect.poll(() => f.heldSettled()).toBe(true);
    await expect(taskStatus(page)).toHaveCount(0); await expect(taskDialog(page)).toContainText('Check delivery date');
    expect(f.calls.filter(call => call.method === 'work_entity.task.mark_done')).toEqual([]);
  } finally { f.dispose(); }
});

test('a retried task lookup cannot replace a task selection made while that lookup was pending', async ({ page }) => {
  const f = await boot(page);
  try {
    await saveTask(page); await f.taskFixture.createTask('Check delivery date'); f.taskFixture.unavailable(true);
    await watchDialog(page).getByRole('button', { name: 'Close', exact: true }).click(); await page.evaluate(() => window.__app.setHash('#mail'));
    await page.evaluate(hash => window.__app.setHash(hash), '#mail/reply-watch/' + f.watch.id);
    await expect(linked(page)).toContainText('could not be checked');
    f.taskFixture.unavailable(false); f.hold('mail.follow_up.task.get');
    await linked(page).getByRole('button', { name: 'Retry linked task', exact: true }).click(); await expect.poll(() => f.isHeld()).toBe(true);
    await linked(page).getByRole('button', { name: 'Change linked task', exact: true }).click();
    const field = linked(page).getByRole('combobox', { name: 'Find an existing task', exact: true }); await field.fill('delivery');
    await linked(page).getByRole('option', { name: /Check delivery date/ }).click();
    f.release(); await expect.poll(() => f.heldSettled()).toBe(true); await expect(field).toHaveValue(/Check delivery date/);
    await linked(page).getByRole('button', { name: 'Save task link', exact: true }).click();
    await expect(linked(page).getByRole('link', { name: 'Check delivery date', exact: true })).toBeVisible();
    expect(f.taskFixture.currentTask()!.done).toBe(false);
  } finally { f.dispose(); }
});
