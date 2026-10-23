import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect,test,type Page } from '@playwright/test';
import { openJob } from './customer-work-driver.js';
import type {} from './harness/quote-completion-reminders-harness.js';
const BASE = `${process.env.E2E_COMPLETION_REMINDERS_HARNESS_URL ?? HARNESS_ORIGIN}/quote-completion-reminders-harness.html`;
const editor = (page: Page) => page.getByRole('form',{ name: 'Completion follow-up',exact: true });
// Since c63d5b076 the follow-up editor opens from the job's Follow-ups tab, and the due queue
// lives in Reception → Follow-ups, one group per kind.
const open = async (page: Page) => { await openJob(page,'followups');await page.getByRole('button',{ name: 'Follow up on completion',exact: true }).click();await expect(editor(page).getByLabel('Follow-up time (your device timezone)')).toBeVisible(); };
const queue = async (page: Page, kind = 'Completion requests') => {
  await page.getByRole('navigation',{ name: 'Customer work',exact: true }).getByRole('link',{ name: 'Follow-ups',exact: true }).click();
  const group = page.locator('[data-customer-followup-group]').filter({ has: page.locator('summary',{ hasText: kind }) });
  if (!await group.evaluate(node => (node as HTMLDetailsElement).open)) await group.locator('summary').click();
  return group;
};
const reads = (page: Page, method: string) => page.evaluate(name => window.__completionReminders.calls.filter(call => call.method === name).length, method);
test.beforeEach(async ({ page }) => {
  const headers = await readFile(resolve(import.meta.dirname,'../public/_headers'),'utf8');
  const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1];if (!policy) throw new Error('Missing shipped CSP');
  await page.route('**/quote-completion-reminders-harness.html',async route => { const response = await route.fetch();await route.fulfill({ response,headers: { ...response.headers(),'content-security-policy': policy } }); });
  await page.goto(BASE);await expect(page.locator('[data-job-list] article')).toHaveCount(1);
});
test('schedules an owner-only completion reminder without releasing work or sending mail',async ({ page }) => {
  await open(page);await editor(page).getByLabel('Follow-up time (your device timezone)').fill('2026-10-15T12:00');
  await editor(page).getByRole('button',{ name: 'Save follow-up',exact: true }).click();
  await expect(page.locator('[data-completion-reminder-queue]')).toContainText('Follow-up scheduled');
  const calls = await page.evaluate(() => window.__completionReminders.calls);
  expect(calls.find(call => call.method.endsWith('reminders.set'))?.payload).toMatchObject({ completion_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',expected_revision: 0,sender_mail_instance: '',recipient_email: '' });
  expect(calls.some(call => call.method === 'execute' || call.method === 'mail.drafts.create')).toBe(false);
  await expect(page.locator('[data-job-list]')).toContainText('Work in progress');await expect(page.locator('[data-job-list]')).toContainText('120.0000 GBP outstanding');
});
test('snoozes and pauses the displayed completion occurrence',async ({ page }) => {
  await page.evaluate(() => window.__completionReminders.due());const group = await queue(page);
  await group.getByRole('button',{ name: 'Snooze 1 day',exact: true }).click();
  await expect(group.locator('[data-completion-reminder-queue]')).toContainText('Follow-up scheduled');
  await group.getByRole('button',{ name: 'Pause follow-up',exact: true }).click();await expect(group.locator('[data-completion-reminder-queue]')).toContainText('No follow-ups');
  const edits = await page.evaluate(() => window.__completionReminders.calls.filter(call => call.method.endsWith('reminders.set')));
  expect(edits.map(call => (call.payload as { expected_revision: number }).expected_revision)).toEqual([1,2]);expect(edits.at(-1)?.payload).toMatchObject({ due_at: null });
});
test('keeps focus on the same follow-up action after the queue refreshes',async ({ page }) => {
  await page.evaluate(() => window.__completionReminders.due());const group = await queue(page);
  const edit = group.getByRole('button',{ name: 'Edit follow-up',exact: true });
  await edit.focus();await expect(edit).toBeFocused();
  const before = await reads(page,'reception.signoff.completion.reminders.list');
  await page.evaluate(() => window.__completionReminders.update());
  await expect.poll(() => reads(page,'reception.signoff.completion.reminders.list')).toBeGreaterThan(before);
  await expect(edit).toBeFocused();
});
test('returns focus to Refresh follow-ups when the customer reply removes a focused reminder',async ({ page }) => {
  await page.evaluate(() => window.__completionReminders.due());const group = await queue(page);
  const edit = group.getByRole('button',{ name: 'Edit follow-up',exact: true });
  await edit.focus();await expect(edit).toBeFocused();
  await page.evaluate(() => window.__completionReminders.reply());
  await expect(edit).toHaveCount(0);
  await expect(group.getByRole('button',{ name: 'Refresh follow-ups',exact: true })).toBeFocused();
});
test('returns focus to the refreshed Customer jobs action when the follow-up editor closes',async ({ page }) => {
  await open(page);
  const before = await reads(page,'reception.jobs.closeout.get');
  await page.evaluate(() => window.__completionReminders.update());
  await expect.poll(() => reads(page,'reception.jobs.closeout.get')).toBeGreaterThan(before);
  await page.getByRole('button',{ name: 'Close follow-up',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Follow up on completion',exact: true })).toBeFocused();
});
test('returns focus to the refreshed queue action when its follow-up editor closes',async ({ page }) => {
  await page.evaluate(() => window.__completionReminders.due());const group = await queue(page);
  const edit = group.getByRole('button',{ name: 'Edit follow-up',exact: true });
  await edit.click();await expect(editor(page)).toBeVisible();
  const before = await reads(page,'reception.signoff.completion.reminders.list');
  await page.evaluate(() => window.__completionReminders.update());
  await expect.poll(() => reads(page,'reception.signoff.completion.reminders.list')).toBeGreaterThan(before);
  await page.getByRole('button',{ name: 'Close follow-up',exact: true }).click();
  await expect(edit).toBeFocused();
});
test('returns focus to Refresh follow-ups after pausing removes the selected row',async ({ page }) => {
  await page.evaluate(() => window.__completionReminders.due());const group = await queue(page);
  await group.getByRole('button',{ name: 'Pause follow-up',exact: true }).click();
  await expect(group.locator('[data-completion-reminder-queue]')).toContainText('No follow-ups');
  await expect(group.getByRole('button',{ name: 'Refresh follow-ups',exact: true })).toBeFocused();
});
test('saves a completion reminder email and opens the shared composer for owner review',async ({ page }) => {
  await page.evaluate(() => window.__completionReminders.due());await (await queue(page)).getByRole('button',{ name: 'Review reminder email',exact: true }).click();
  await expect(page.getByLabel('Subject')).toHaveValue('Reminder: please confirm delivery for Drawings');
  const calls = await page.evaluate(() => window.__completionReminders.calls);
  const saved = calls.find(call => call.method === 'mail.drafts.create')?.payload as { idempotency_key: string;content: { reconciliation_id: string;to: string[] } };
  expect(saved.idempotency_key).toBe('qcr_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb_1');expect(saved.content.reconciliation_id).toBe(saved.idempotency_key);expect(saved.content.to).toEqual(['morgan@example.test']);
  expect(calls.some(call => call.method === 'execute' || call.method === 'mail.drafts.prepare')).toBe(false);
  await expect(page.getByRole('button',{ name: 'Send',exact: true })).toBeVisible();
});
test('uses the existing governed mail execution only after the owner chooses Send',async ({ page }) => {
  await page.evaluate(() => window.__completionReminders.due());await (await queue(page)).getByRole('button',{ name: 'Review reminder email',exact: true }).click();
  await page.getByRole('button',{ name: 'Send',exact: true }).click();
  await expect.poll(async () => page.evaluate(() => window.__completionReminders.calls.filter(call => call.method === 'execute').length)).toBe(1);
  const sent = await page.evaluate(() => window.__completionReminders.calls.find(call => call.method === 'execute')?.payload);
  expect(sent).toMatchObject({ config: { reconciliation_id: 'qcr_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb_1',sender_mail_instance: 'work',to: ['morgan@example.test'] } });
});
test('preserves follow-up edits and its route leave guard during board refresh',async ({ page }) => {
  await open(page);await editor(page).getByLabel('Customer email (optional)',{ exact: true }).fill('edited@example.test');
  expect(await page.evaluate(() => window.__completionReminders.hasUnsavedChanges())).toBe(true);
  // The job page has no Refresh jobs button; the refresh is the panel update a route runs.
  const before = await reads(page,'reception.jobs.closeout.get');
  await page.evaluate(() => window.__completionReminders.update());
  await expect.poll(() => reads(page,'reception.jobs.closeout.get')).toBeGreaterThan(before);
  await expect(editor(page).getByLabel('Customer email (optional)',{ exact: true })).toHaveValue('edited@example.test');
  await page.getByRole('button',{ name: 'Close follow-up',exact: true }).click();expect(await page.evaluate(() => window.__completionReminders.hasUnsavedChanges())).toBe(false);
});
test('removes the reminder action and due queue when a completion reply is received',async ({ page }) => {
  await page.evaluate(() => window.__completionReminders.due());const group = await queue(page);
  await expect(group.getByRole('button',{ name: 'Review reminder email',exact: true })).toBeVisible();
  await page.evaluate(() => window.__completionReminders.reply());await expect(group.getByRole('button',{ name: 'Review reminder email',exact: true })).toHaveCount(0);
  await page.getByRole('navigation',{ name: 'Customer work',exact: true }).getByRole('link',{ name: 'Jobs',exact: true }).click();await openJob(page,'followups');
  await expect(page.getByRole('button',{ name: 'Follow up on completion',exact: true })).toHaveCount(0);await expect(page.locator('[data-job-list]')).toContainText('Customer accepted delivery');
  await expect(page.locator('[data-job-list]')).toContainText('Work in progress');
});
test('keeps owner reminder scheduling available during a mail-account outage',async ({ page }) => {
  await page.evaluate(() => window.__completionReminders.failMail());await open(page);
  await expect(page.locator('[data-completion-reminder-editor]')).toContainText('owner reminders remain available');
  await editor(page).getByRole('button',{ name: 'Save follow-up',exact: true }).click();await expect(page.locator('[data-completion-reminder-queue]')).toContainText('Follow-up scheduled');
});
test('stores a completion link for reminders only when the owner opts in at publishing',async ({ page }) => {
  await openJob(page,'overview');await page.getByRole('button',{ name: 'Request completion',exact: true }).click();
  const request = page.getByRole('form',{ name: 'Request customer completion',exact: true });await request.getByLabel('Delivered work shown to the customer').fill('Delivered all drawings.');
  await request.getByRole('button',{ name: 'Preview completion',exact: true }).click();const keep = request.getByLabel('Save this link for follow-up emails');await expect(keep).not.toBeChecked();await keep.check();
  await request.getByRole('button',{ name: 'Publish completion link',exact: true }).click();
  await expect(page.getByLabel('Customer completion link',{ exact: true })).toBeVisible();
  const published = await page.evaluate(() => window.__completionReminders.calls.find(call => call.method === 'reception.signoff.completion.publish')?.payload);
  expect(published).toMatchObject({ completion_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',remember_link_for_reminders: true });
});
test('ignores a delayed follow-up read after the board is disposed',async ({ page }) => {
  await openJob(page,'followups');await page.evaluate(() => window.__completionReminders.deferGet());await page.getByRole('button',{ name: 'Follow up on completion',exact: true }).click();
  await expect.poll(async () => page.evaluate(() => window.__completionReminders.hasInFlightWork())).toBe(true);
  await page.evaluate(() => { window.__completionReminders.dispose();window.__completionReminders.release(); });await expect(page.locator('[data-customer-jobs]')).toHaveCount(0);
});
test('keeps the completion follow-up editor within a narrow mobile viewport',async ({ page },info) => {
  await page.setViewportSize({ width: 390,height: 844 });await open(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await editor(page).screenshot({ path: info.outputPath('completion-follow-up-mobile.png') });
});
