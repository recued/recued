import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailFollowUpFixture } from './helpers/mail-follow-up-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
const editor = (page: Page) => page.getByRole('dialog', { name: 'Reply', exact: true });
const watchDialog = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const keepTask = (page: Page) => editor(page).getByRole('group', { name: 'After Sent verification', exact: true }).getByRole('checkbox', { name: /^Keep tracking / });
const openWatch = async (page: Page, id: string) => {
  await page.evaluate(() => window.__app.setHash('#mail'));
  await page.evaluate(hash => window.__app.setHash(hash), '#mail/reply-watch/' + id);
  await watchDialog(page).getByRole('button', { name: 'Open saved draft', exact: true }).click();
};
const boot = async (page: Page, holdContext = false) => {
  const f = await installMailFollowUpFixture(page, { tasks: true, compose: true, verifyMessages: true });
  if (!f.taskFixture || !f.compose) throw Error('Missing native task/send fixture');
  let watch = await f.service.start(f.request(), 'paired-owner');
  watch = await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.taskFixture.task.id }, () => {});
  f.due(); watch = await f.service.check(watch.id); await page.clock.setFixedTime(new Date(f.now()));
  if (holdContext) f.hold('mail.follow_up.task.context');
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser&server_profiles=multiple#mail/reply-watch/${watch.id}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await watchDialog(page).getByRole('button', { name: 'Open saved draft', exact: true }).click();
  await editor(page).getByRole('checkbox', { name: 'Watch for a reply', exact: true }).check();
  return { ...f, watch, taskFixture: f.taskFixture, compose: f.compose };
};

test('opts into the exact task, keeps the selection in a saved draft, and transfers only after the approved send is verified', async ({ page }) => {
  const f = await boot(page);
  try {
    await expect(keepTask(page)).not.toBeChecked(); await expect(editor(page)).toContainText('Get revised estimate'); await keepTask(page).check();
    await editor(page).getByRole('button', { name: 'Schedule…', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toContainText('Turn off task tracking before scheduling');
    await editor(page).getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(editor(page).locator('[data-mail-draft-status]')).toContainText('Draft saved.');
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); await openWatch(page, f.watch.id);
    await expect(keepTask(page)).toBeChecked();
    await expect.poll(() => f.calls.filter(call => call.method === 'mail.follow_up.task.context').length).toBeGreaterThan(1);
    await expect(editor(page)).not.toContainText('Checking current task tracking');
    await editor(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(f.compose.delivered).toHaveLength(0); expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
    const execute = f.calls.find(call => call.method === 'execute')!.args as { config: Record<string, unknown>; mail_follow_up: { request_id: string; continue_task: { task_ref: unknown } } };
    expect(execute.mail_follow_up.continue_task.task_ref).toEqual(f.watch.task_ref); expect(execute.config).not.toHaveProperty('follow_up');
    await f.compose.answer('approve'); const id = 'mfw_' + execute.mail_follow_up.request_id;
    expect((await f.compose.send().get(id))!.state).toBe('awaiting_sync'); expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
    f.compose.syncSent(); f.compose.restartSend(); expect((await f.compose.send().get(id))!.state).toBe('armed');
    await page.evaluate(id => window.__app.setHash('#data/task/' + encodeURIComponent(id)), f.taskFixture.task.id);
    const status = page.getByRole('region', { name: 'Task email reply watch', exact: true });
    await expect(status).toContainText('Waiting for a reply'); await expect(status.getByRole('link', { name: 'View reply watch', exact: true })).toHaveAttribute('href', '#mail/reply-watch/' + id);
    expect(f.taskFixture.currentTask()!.done).toBe(false); expect(f.compose.delivered).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'work_entity.task.mark_done')).toEqual([]);
  } finally { f.dispose(); }
});

test('keeps the old task association when the task option is left unchecked', async ({ page }) => {
  const f = await boot(page);
  try {
    await expect(keepTask(page)).not.toBeChecked(); await editor(page).getByRole('button', { name: 'Send', exact: true }).click();
    await expect(editor(page)).toHaveCount(0); await f.compose.answer('approve'); f.compose.syncSent();
    const pending = (await f.compose.send().pending())[0]; expect(pending).toBeUndefined();
    expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
    const next = (await f.service.list()).watches.find(watch => watch.id !== f.watch.id)!; expect(next.task_ref).toBeUndefined();
    const args = f.calls.find(call => call.method === 'execute')!.args as { mail_follow_up: object };
    expect(args.mail_follow_up).not.toHaveProperty('continue_task'); expect(f.taskFixture.currentTask()!.done).toBe(false);
  } finally { f.dispose(); }
});

test('a late optional task lookup preserves typing and focus, and cannot reopen a closed composer', async ({ page }) => {
  const f = await boot(page, true);
  try {
    await expect.poll(() => f.isHeld()).toBe(true);
    const body = editor(page).getByRole('textbox', { name: 'Body', exact: true }); await body.fill('Keep these unfinished edits.');
    f.release(); await expect(keepTask(page)).toBeVisible(); await expect(body).toHaveValue('Keep these unfinished edits.'); await expect(body).toBeFocused();
    await editor(page).getByRole('button', { name: 'Save draft', exact: true }).click(); await expect(editor(page).locator('[data-mail-draft-status]')).toContainText('Draft saved.');
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    f.hold('mail.follow_up.task.context'); await openWatch(page, f.watch.id); await expect.poll(() => f.isHeld()).toBe(true);
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    f.release(); await expect.poll(() => f.heldSettled()).toBe(true); await expect(editor(page)).toHaveCount(0);
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('a saved task selection is not silently refreshed after an unlink and relink', async ({ page }) => {
  const f = await boot(page);
  try {
    await keepTask(page).check(); await editor(page).getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(editor(page).locator('[data-mail-draft-status]')).toContainText('Draft saved.');
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    let watch = (await f.service.getTask({ id: f.watch.id })).watch;
    watch = await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: null }, () => {});
    await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.taskFixture.task.id }, () => {});
    await openWatch(page, f.watch.id); await expect(keepTask(page)).toBeChecked();
    await expect(editor(page)).toContainText('Task tracking changed');
    await editor(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(editor(page).getByRole('alert')).toContainText('Turn off task tracking');
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
    await keepTask(page).uncheck(); await editor(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    await f.compose.answer('deny'); expect(f.compose.delivered).toHaveLength(0);
    expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
  } finally { f.dispose(); }
});

test('restores an explicit task selection with unfinished edits through recovery', async ({ page }) => {
  const f = await boot(page);
  try {
    await keepTask(page).check(); await editor(page).getByRole('textbox', { name: 'Body', exact: true }).fill('Recovered follow-up text.');
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    await page.evaluate(() => window.__app.setHash('#mail'));
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await page.getByRole('button', { name: 'Restore message', exact: true }).click();
    await expect(keepTask(page)).toBeChecked(); await expect(editor(page)).toContainText('Get revised estimate');
    await expect(editor(page).getByRole('textbox', { name: 'Body', exact: true })).toHaveValue('Recovered follow-up text.');
    expect(f.compose.delivered).toHaveLength(0); expect(f.taskFixture.currentTask()!.done).toBe(false);
  } finally { f.dispose(); }
});
