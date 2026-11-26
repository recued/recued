import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { canonicalizeGmail } from '../../../backend/server/src/collections/mail/gmail-provider.js';
import { buildRecord } from '../../../backend/server/src/collections/mail/mail-collection.js';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailFollowUpFixture } from './helpers/mail-follow-up-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
const dialog = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const boot = async (page: Page) => {
  const f = await installMailFollowUpFixture(page, { tasks: true, verifyMessages: true });
  if (!f.taskFixture) throw Error('Missing canonical task fixture');
  let watch = await f.service.start({ ...f.request(), waiting_for: { address: 'alex@example.test', recipients: ['alex@example.test', 'copy@example.test'] }, notify_on_reply: true }, 'paired-owner');
  watch = await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.taskFixture.task.id }, () => {});
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser#mail/reply-watch/${watch.id}`);
  await page.waitForFunction(() => window.__app?.ready === true); await expect(dialog(page)).toBeVisible();
  const receive = async (id: string, headers: string[], at = f.now()) => {
    const message = await canonicalizeGmail({ id, threadId: String(f.seed.hot_fields.thread_id), labelIds: ['INBOX'], internalDate: String(at),
      raw: Buffer.from(['From: Alex <alex@example.test>', 'To: owner@example.test', 'Subject: Re: Renewal',
        `Date: ${new Date(at).toUTCString()}`, `Message-ID: <${id}@example.test>`, 'In-Reply-To: <sent-1@example.test>',
        'Content-Type: text/plain', ...headers, '', 'Received message.'].join('\r\n')).toString('base64url') });
    const { record } = buildRecord(message, f.now, 'owner@example.test'); record.body_inline = message.body_text; f.tables.get('work')!.upsert(record); return record;
  };
  return { ...f, taskFixture: f.taskFixture, watch, receive };
};

test('keeps the chosen task watch waiting through an automatic reply, permits Snooze and notifies only for a later ordinary reply', async ({ page }) => {
  const f = await boot(page);
  try {
    await f.receive('automatic', ['Auto-Submitted: auto-replied']);
    await dialog(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(dialog(page).getByRole('status')).toHaveText('Waiting for a reply');
    await expect(dialog(page)).toContainText('Automatic reply received. Still waiting for alex@example.test.');
    await f.replyAlerts.tick(); expect(await f.activities.list()).toEqual([]); expect(f.taskFixture.currentTask()!.done).toBe(false);
    await dialog(page).getByRole('button', { name: 'Snooze follow-up', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Tomorrow at 9am', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Save check time', exact: true }).click();
    await expect(dialog(page)).toContainText('Automatic reply received. Still waiting');
    const snoozed = await f.service.check(f.watch.id); expect(snoozed).toMatchObject({ state: 'waiting', schedule_version: 1, waiting_for: f.watch.waiting_for, task_ref: f.watch.task_ref });
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click(); await page.evaluate(() => window.__app.setHash('#today'));
    const row = page.locator(`[data-today-item="task:${f.taskFixture.task.id}"]`); await expect(row).toContainText('Automatic reply received. Still waiting');
    const ordinary = await f.receive('ordinary', [], f.now() + 2000); await f.service.check(f.watch.id);
    await row.getByRole('button', { name: 'Refresh reply status', exact: true }).click(); await expect(row).toContainText('Reply received');
    await expect(row).not.toContainText('Still waiting'); expect(f.taskFixture.currentTask()!.done).toBe(false);
    await f.replyAlerts.tick(); await f.replyAlerts.tick(); expect(await f.activities.list()).toHaveLength(1); await f.flushAlerts();
    await expect(page.locator('[data-recued-notify-toast]').filter({ hasText: 'Reply received' })).toHaveCount(1);
    expect((await f.service.getReply({ id: f.watch.id })).mail_ref.record_id).toBe(ordinary.record_id);
    expect(f.calls.filter(call => call.method === 'work_entity.task.mark_done' || call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('asks for review of missing or duplicate evidence and recovers after a verified mailbox rescan', async ({ page }) => {
  const f = await boot(page);
  try {
    const row = await f.receive('ambiguous', ['Auto-Submitted: no', 'Auto-Submitted: auto-replied']);
    await dialog(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(dialog(page).getByRole('status')).toHaveText('Needs attention'); await expect(dialog(page)).toContainText('automatic-mail status could not be verified');
    expect(f.draftCount()).toBe(0); await f.replyAlerts.tick(); expect(await f.activities.list()).toEqual([]);
    delete row.hot_fields.reply_automation; f.tables.get('work')!.upsert(row);
    await dialog(page).getByRole('button', { name: 'Check now', exact: true }).click(); await expect(dialog(page).getByRole('status')).toHaveText('Needs attention');
    await f.receive('ambiguous', ['Auto-Submitted: auto-replied']);
    await dialog(page).getByRole('button', { name: 'Check now', exact: true }).click(); await expect(dialog(page).getByRole('status')).toHaveText('Waiting for a reply');
    await expect(dialog(page)).toContainText('Automatic reply received. Still waiting for alex@example.test.');
    await expect(dialog(page).getByRole('button', { name: 'Snooze follow-up', exact: true })).toBeVisible(); expect(f.taskFixture.currentTask()!.done).toBe(false);
    expect(f.draftCount()).toBe(0);
  } finally { f.dispose(); }
});
