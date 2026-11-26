import { expect, test, type Page } from '@playwright/test';
import { calendarDayMs } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailFollowUpFixture } from './helpers/mail-follow-up-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
const dialog = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const linked = (page: Page) => dialog(page).getByRole('region', { name: 'Linked task', exact: true });
const boot = async (page: Page) => {
  const f = await installMailFollowUpFixture(page, { verifyMessages: true, tasks: true });
  if (!f.taskFixture) throw Error('Missing canonical task fixture');
  const watch = await f.service.start(f.request(), 'paired-owner');
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser#mail/reply-watch/${watch.id}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(linked(page).getByRole('button', { name: 'Create task', exact: true })).toBeVisible();
  return { ...f, taskFixture: f.taskFixture, watch };
};
const fill = async (page: Page, due = '2026-11-24') => {
  await linked(page).getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(linked(page).getByRole('textbox', { name: 'Task title', exact: true })).toBeFocused();
  await linked(page).getByRole('textbox', { name: 'Task title', exact: true }).fill('Get the revised estimate');
  if (due) await linked(page).getByLabel('Due date (optional)', { exact: true }).fill(due);
};

test('reviews and cancels without creating, then creates one linked local task with its date and email context across reload and Today', async ({ page }) => {
  const f = await boot(page);
  try {
    await fill(page); await linked(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(linked(page).getByRole('button', { name: 'Create task', exact: true })).toBeVisible();
    expect(f.taskFixture.taskStore.countTasks()).toBe(1); expect(f.calls.filter(call => call.method === 'mail.follow_up.task.create')).toEqual([]);
    await fill(page); await linked(page).getByRole('button', { name: 'Create and link task', exact: true }).click();
    await expect(linked(page).getByRole('link', { name: 'Get the revised estimate', exact: true })).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    const saved = (await f.service.getTask({ id: f.watch.id })).task!; const task = f.taskFixture.currentTask(saved.ref.id)!;
    expect(task.due_at).toBe(calendarDayMs('2026-11-24')); expect(task.done).toBe(false); expect(f.taskFixture.taskStore.countTasks()).toBe(2);
    const email = new URL(page.url()); email.search = ''; email.hash = '#data/mail/record/work/sent-1';
    expect(task.body).toContain(email.href);
    await page.reload(); await expect(linked(page).getByRole('link', { name: 'Get the revised estimate', exact: true })).toBeVisible();
    await linked(page).getByRole('link', { name: 'Get the revised estimate', exact: true }).click();
    const reader = page.locator('[data-kind="task"][data-mode="read"][role="dialog"]');
    await expect(reader.getByRole('region', { name: 'Task email reply watch', exact: true })).toContainText('Waiting for a reply');
    await expect(reader.locator('[data-task-note-link]')).toHaveAttribute('href', email.href);
    await page.evaluate(() => window.__app.setHash('#today'));
    await expect(page.locator(`[data-today-item="task:${saved.ref.id}"]`)).toContainText('Waiting for a reply');
    expect(f.calls.filter(call => call.method === 'work_entity.task.mark_done')).toEqual([]); expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('checks an uncertain create with the original title and request, keeping one task and one link', async ({ page }) => {
  const f = await boot(page);
  try {
    await fill(page, ''); f.loseTaskCreateReply(); await linked(page).getByRole('button', { name: 'Create and link task', exact: true }).click();
    await expect(linked(page)).toContainText('save outcome is not confirmed');
    const title = linked(page).getByRole('textbox', { name: 'Task title', exact: true });
    await title.focus(); await page.keyboard.type('Attempted change'); await expect(title).toHaveValue('Get the revised estimate');
    await linked(page).getByRole('button', { name: 'Check save', exact: true }).click();
    await expect(linked(page).getByRole('link', { name: 'Get the revised estimate', exact: true })).toBeVisible();
    const calls = f.calls.filter(call => call.method === 'mail.follow_up.task.create'); expect(calls).toHaveLength(2); expect(calls[0]!.args).toEqual(calls[1]!.args);
    const saved = (await f.service.getTask({ id: f.watch.id })).task!;
    expect(f.taskFixture.taskStore.countTasks()).toBe(2); expect(f.taskFixture.currentTask(saved.ref.id)!.due_at).toBeUndefined();
    expect(f.db.prepare('SELECT count(*) AS n FROM mail_follow_ups WHERE task_key IS NOT NULL').get()).toEqual({ n: 1 });
  } finally { f.dispose(); }
});

test('keeps reviewed fields after the watched email changes during a pending save and creates no task', async ({ page }) => {
  const f = await boot(page);
  try {
    await fill(page); f.hold('mail.follow_up.task.create'); await linked(page).getByRole('button', { name: 'Create and link task', exact: true }).click();
    await expect.poll(() => f.isHeld()).toBe(true);
    f.tables.get('work')!.upsert({ ...f.seed, hot_fields: { ...f.seed.hot_fields, subject: 'Changed at source' } }); f.release();
    await expect(linked(page).getByRole('alert')).toBeVisible();
    await expect(linked(page).getByRole('textbox', { name: 'Task title', exact: true })).toHaveValue('Get the revised estimate');
    await expect(linked(page).getByLabel('Due date (optional)', { exact: true })).toHaveValue('2026-11-24');
    expect(f.taskFixture.taskStore.countTasks()).toBe(1); expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toBeUndefined();
    await linked(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(linked(page).getByRole('button', { name: 'Link a task', exact: true })).toBeVisible();
  } finally { f.dispose(); }
});
