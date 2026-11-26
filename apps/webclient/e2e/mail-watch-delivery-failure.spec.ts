import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { canonicalizeGmail } from '../../../backend/server/src/collections/mail/gmail-provider.js';
import { buildRecord } from '../../../backend/server/src/collections/mail/mail-collection.js';
import { deliveryReportMime } from '../../../backend/server/src/__tests__/fixtures/mail-delivery-report-fixture.js';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailFollowUpFixture } from './helpers/mail-follow-up-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
const dialog = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const go = async (page: Page, hash: string) => {
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const fixture = async (page: Page) => {
  const f = await installMailFollowUpFixture(page, { tasks: true, verifyMessages: true });
  if (!f.taskFixture) throw Error('Missing canonical task fixture');
  let watch = await f.service.start({ ...f.request(), waiting_for: { address: 'alex@example.test', recipients: ['alex@example.test', 'copy@example.test'] }, notify_on_reply: true }, 'paired-owner');
  watch = await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.taskFixture.task.id }, () => {});
  const receive = async (options: Parameters<typeof deliveryReportMime>[0] = {}) => {
    const msg = await canonicalizeGmail({ id: options.id ?? 'failure', threadId: 'separate-report-thread', labelIds: ['INBOX'], internalDate: String(f.now()),
      raw: deliveryReportMime({ at: f.now(), ...options }).toString('base64url') });
    const { record } = buildRecord(msg, f.now, 'owner@example.test'); record.body_inline = msg.body_text; f.tables.get('work')!.upsert(record); return record;
  };
  return { ...f, taskFixture: f.taskFixture, watch, receive };
};

test('stops ready-draft actions after an exact permanent failure, retires its old alert and retains the task and owner edits', async ({ page }) => {
  const f = await fixture(page);
  try {
    f.due(); let ready = await f.service.check(f.watch.id);
    ready = await f.service.reschedule({ id: ready.id, expected_revision: ready.revision, request_id: randomUUID(), check_at: f.now() + 3600000 });
    f.due(ready.check_at); ready = await f.service.check(ready.id);
    const draft = await f.drafts.get({ draft_id: ready.draft_id }, f.principal);
    await f.drafts.update({ draft_id: draft.draft_id, expected_revision: draft.revision, content: { ...draft.content, body: 'Preserve these owner edits.' } }, f.principal);
    await go(page, `#mail/reply-watch/${f.watch.id}`); await expect(dialog(page).getByRole('button', { name: 'Open saved draft', exact: true })).toBeVisible();
    await f.alerts.tick(); await f.flushAlerts();
    await expect(page.locator('[data-recued-notify-toast]').filter({ hasText: 'Follow-up draft ready' })).toHaveCount(1);
    const report = await f.receive(); await dialog(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(dialog(page).getByRole('status')).toHaveText('Delivery failed for alex@example.test');
    await expect(dialog(page)).toContainText('550 5.1.1 No such user');
    await expect(dialog(page).getByRole('button', { name: 'Open saved draft', exact: true })).toHaveCount(0);
    await expect(dialog(page).getByRole('button', { name: 'Change check time', exact: true })).toHaveCount(0);
    await f.alerts.tick(); await f.replyAlerts.tick(); await f.flushAlerts();
    await expect(page.locator('[data-recued-notify-toast]').filter({ hasText: 'Follow-up draft ready' })).toHaveCount(0);
    await expect(page.locator('[data-recued-notify-toast]').filter({ hasText: 'Email delivery failed' })).toHaveCount(1);
    await dialog(page).getByRole('button', { name: 'Open delivery report', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toContainText('This is a delivery report.');
    expect(f.calls.filter(call => call.method === 'mail.follow_up.delivery_report.get')).toHaveLength(1);
    expect((await f.service.getDeliveryReport({ id: f.watch.id })).mail_ref.record_id).toBe(report.record_id);
    await page.evaluate(() => window.__app.setHash('#today'));
    const task = page.locator(`[data-today-item="task:${f.taskFixture.task.id}"]`); await expect(task).toContainText('Delivery failed for alex@example.test');
    await expect(task.getByRole('link', { name: 'Review delivery report', exact: true })).toBeVisible();
    const attention = page.locator(`[data-today-follow-up="${f.watch.id}"]`); await expect(attention).toContainText('550 5.1.1 No such user');
    await expect(attention.getByRole('link', { name: 'Snooze: Renewal', exact: true })).toHaveCount(0);
    expect((await f.drafts.get({ draft_id: draft.draft_id }, f.principal)).content.body).toBe('Preserve these owner edits.');
    expect(f.taskFixture.currentTask()!.done).toBe(false); expect(f.draftCount()).toBe(1);
    expect(f.calls.filter(call => call.method === 'execute' || call.method === 'work_entity.task.mark_done')).toEqual([]);
  } finally { f.dispose(); }
});

test('Search opens the verified report and Back restores the same failure result, query, filter and focus', async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.receive(); await f.service.check(f.watch.id); await go(page, '#data/search');
    const query = page.getByRole('searchbox', { name: 'Search everything', exact: true }); await query.fill('Renewal');
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('follow_up');
    await page.getByRole('combobox', { name: 'Reply watch status', exact: true }).selectOption('delivery_failed');
    const results = page.getByRole('region', { name: 'Reply watch search results', exact: true });
    const result = results.getByRole('link', { name: 'Open follow-up Renewal', exact: true });
    await expect(result).toContainText('Delivery failed for alex@example.test'); await expect(result).toContainText('Open delivery report');
    await result.focus(); await result.press('Enter');
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toContainText('This is a delivery report.');
    await page.goBack(); await expect(query).toHaveValue('Renewal');
    await expect(page.getByRole('combobox', { name: 'Result type', exact: true })).toHaveValue('follow_up');
    await expect(page.getByRole('combobox', { name: 'Reply watch status', exact: true })).toHaveValue('delivery_failed'); await expect(result).toBeFocused();
    expect(f.taskFixture.currentTask()!.done).toBe(false); expect(f.draftCount()).toBe(0);
  } finally { f.dispose(); }
});

test('ambiguous reports require review and a changed report cannot be opened using its earlier verified link', async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.receive({ extraStatus: ['Action: delayed'] }); await go(page, `#mail/reply-watch/${f.watch.id}`);
    await expect(dialog(page).getByRole('status')).toHaveText('Needs attention'); await expect(dialog(page)).toContainText('delivery report needs review'); expect(f.draftCount()).toBe(0);
    await f.receive(); await dialog(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(dialog(page).getByRole('status')).toHaveText('Delivery failed for alex@example.test');
    await f.receive({ action: 'delayed', status: '4.2.2' });
    await dialog(page).getByRole('button', { name: 'Open delivery report', exact: true }).click();
    await expect(dialog(page).getByRole('alert')).toContainText('delivery report or conversation changed');
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Check now', exact: true }).click(); await expect(dialog(page).getByRole('status')).toHaveText('Needs attention');
    expect(f.taskFixture.currentTask()!.done).toBe(false); expect(f.draftCount()).toBe(0);
  } finally { f.dispose(); }
});
