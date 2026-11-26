import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { canonicalizeGmail } from '../../../backend/server/src/collections/mail/gmail-provider.js';
import { buildRecord } from '../../../backend/server/src/collections/mail/mail-collection.js';
import { deliveryReportMime } from '../../../backend/server/src/__tests__/fixtures/mail-delivery-report-fixture.js';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailFollowUpFixture } from './helpers/mail-follow-up-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
const editor = (page: Page) => page.getByRole('dialog', { name: 'New mail', exact: true });
const manager = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const keep = (page: Page) => editor(page).getByRole('checkbox', { name: 'Keep tracking “Get revised estimate”', exact: true });
const watchChoice = (page: Page) => editor(page).getByRole('checkbox', { name: 'Watch for a reply', exact: true });
const boot = async (page: Page, oldDraft = false) => {
  const f = await installMailFollowUpFixture(page, { tasks: true, compose: true, verifyMessages: true });
  if (!f.taskFixture || !f.compose) throw Error('Missing native task/send fixture');
  let watch = await f.service.start({ ...f.request(), waiting_for: { address: 'alex@example.test', recipients: ['alex@example.test', 'copy@example.test'] } }, 'paired-owner');
  watch = await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.taskFixture.task.id }, () => {});
  if (oldDraft) {
    f.due(); watch = await f.service.check(watch.id); const saved = await f.drafts.get({ draft_id: watch.draft_id }, f.principal);
    await f.drafts.update({ draft_id: saved.draft_id, expected_revision: saved.revision, content: { ...saved.content, body: 'Keep previous follow-up edits.' } }, f.principal);
  }
  const msg = await canonicalizeGmail({ id: 'failure', threadId: 'report-thread', labelIds: ['INBOX'], raw: deliveryReportMime({ at: f.now() }).toString('base64url') });
  const { record } = buildRecord(msg, f.now, 'owner@example.test'); f.tables.get('work')!.upsert(record);
  watch = await f.service.check(watch.id); await page.clock.setFixedTime(new Date(f.now()));
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser&server_profiles=multiple#mail/reply-watch/${watch.id}`);
  await page.waitForFunction(() => window.__app?.ready === true); await expect(manager(page)).toContainText('Delivery failed for alex@example.test');
  return { ...f, watch, report: record, taskFixture: f.taskFixture, compose: f.compose };
};

test('reviews a fresh replacement in the integrated composer and transfers the task only after approval and exact Sent sync', async ({ page }) => {
  const f = await boot(page, true);
  try {
    await manager(page).getByRole('button', { name: 'Draft replacement', exact: true }).click(); await expect(editor(page)).toBeVisible();
    await expect(editor(page).getByRole('textbox', { name: 'Body', exact: true })).toHaveValue('Can you confirm the renewal?');
    await expect(editor(page).locator('[data-form-array-item="to"]')).toHaveValue('alex@example.test');
    await expect(editor(page).locator('[data-form-array-item="cc"]')).toHaveCount(0);
    await expect(editor(page)).toContainText('Replacement draft'); await expect(watchChoice(page)).not.toBeChecked();
    await expect(editor(page).getByRole('button', { name: 'Draft with AI', exact: true })).toBeVisible();
    await editor(page).locator('[data-form-array-item="to"]').fill('new-alex@example.test'); await watchChoice(page).check();
    await expect(keep(page)).not.toBeChecked(); await keep(page).check();
    await editor(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(f.compose.delivered).toHaveLength(0); expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
    const args = f.calls.find(call => call.method === 'execute')!.args as { config: Record<string, unknown>; mail_follow_up: { request_id: string; continue_task: { replacement_hash: string } } };
    expect(args.config.to).toEqual(['new-alex@example.test']); expect(args.config).not.toHaveProperty('in_reply_to'); expect(args.config).not.toHaveProperty('reconciliation_id');
    expect(args.mail_follow_up.continue_task.replacement_hash).toMatch(/^[a-f0-9]{64}$/);
    await f.compose.answer('approve'); const id = 'mfw_' + args.mail_follow_up.request_id;
    expect((await f.compose.send().get(id))!.state).toBe('awaiting_sync'); expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
    f.compose.syncSent(); f.compose.restartSend(); expect((await f.compose.send().get(id))!.state).toBe('armed');
    await page.evaluate(id => window.__app.setHash('#data/task/' + encodeURIComponent(id)), f.taskFixture.task.id);
    const status = page.getByRole('region', { name: 'Task email reply watch', exact: true }); await expect(status).toContainText('Waiting for a reply');
    await expect(status.getByRole('link', { name: 'View reply watch', exact: true })).toHaveAttribute('href', '#mail/reply-watch/' + id);
    expect((await f.drafts.get({ draft_id: f.watch.draft_id }, f.principal)).content.body).toBe('Keep previous follow-up edits.');
    expect((await f.service.getDeliveryReport({ id: f.watch.id })).mail_ref.record_id).toBe(f.report.record_id);
    expect(f.taskFixture.currentTask()!.done).toBe(false); expect(f.compose.delivered).toHaveLength(1);
  } finally { f.dispose(); }
});

test('preserves owner edits and explicit task consent through a delayed context lookup, save and reopen', async ({ page }) => {
  const f = await boot(page);
  try {
    f.hold('mail.follow_up.task.context'); await manager(page).getByRole('button', { name: 'Draft replacement', exact: true }).click();
    await expect.poll(() => f.isHeld()).toBe(true);
    const body = editor(page).getByRole('textbox', { name: 'Body', exact: true }); await body.fill('Replacement with the owner’s edits.');
    f.release(); await expect(body).toHaveValue('Replacement with the owner’s edits.'); await expect(body).toBeFocused();
    await editor(page).locator('[data-form-array-item="to"]').fill('new-alex@example.test'); await watchChoice(page).check(); await keep(page).check();
    await editor(page).getByRole('button', { name: 'Save draft', exact: true }).click(); await expect(editor(page).locator('[data-mail-draft-status]')).toContainText('Draft saved.');
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await manager(page).getByRole('button', { name: 'Open replacement draft', exact: true }).click();
    await expect(body).toHaveValue('Replacement with the owner’s edits.'); await expect(keep(page)).toBeChecked();
    expect(f.draftCount()).toBe(1); expect(f.compose.delivered).toHaveLength(0); expect(f.taskFixture.currentTask()!.done).toBe(false);
  } finally { f.dispose(); }
});

test('keeping a new watch without task consent leaves the existing task on its failure history', async ({ page }) => {
  const f = await boot(page);
  try {
    await manager(page).getByRole('button', { name: 'Draft replacement', exact: true }).click();
    await editor(page).locator('[data-form-array-item="to"]').fill('new-alex@example.test'); await watchChoice(page).check(); await expect(keep(page)).not.toBeChecked();
    await editor(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    await f.compose.answer('approve'); f.compose.syncSent(); await f.compose.send().sweep();
    const source = (await f.service.getTask({ id: f.watch.id })).watch; expect(source.task_ref).toEqual(f.watch.task_ref); expect(source.state).toBe('delivery_failed');
    const next = (await f.service.list()).watches.find(value => value.id !== f.watch.id)!; expect(next.task_ref).toBeUndefined();
    expect(f.taskFixture.currentTask()!.done).toBe(false); expect(f.compose.delivered).toHaveLength(1);
  } finally { f.dispose(); }
});

test('refuses preparation when the verified report changes while the request is pending', async ({ page }) => {
  const f = await boot(page);
  try {
    f.hold('mail.follow_up.replacement.create'); await manager(page).getByRole('button', { name: 'Draft replacement', exact: true }).click();
    await expect.poll(() => f.isHeld()).toBe(true); f.tables.get('work')!.delete(f.report.record_id); f.release();
    await expect(manager(page).getByRole('alert')).toContainText('delivery report or conversation changed'); await expect(editor(page)).toHaveCount(0);
    expect(f.draftCount()).toBe(0); expect(f.compose.delivered).toHaveLength(0); expect(f.taskFixture.currentTask()!.done).toBe(false);
  } finally { f.dispose(); }
});
