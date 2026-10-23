import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import {openAccountActions} from './customer-work-driver.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect,test,type Page } from '@playwright/test';
import type {} from './harness/customer-accounts-harness.js';
import type {} from './harness/customer-account-payments-harness.js';

const BASE = `${process.env.E2E_CUSTOMER_ACCOUNTS_HARNESS_URL ?? HARNESS_ORIGIN}/customer-accounts-harness.html`;
const panel = (page: Page) => page.locator('[data-customer-accounts]:visible');
const queue = (page: Page) => page.locator('[data-account-payment-reminder-queue]');
const form = (page: Page) => page.getByRole('form',{ name: 'Account payment follow-up',exact: true });
const openAccounts = async (page: Page) => {
  await page.getByRole('link',{ name: 'Customer accounts',exact: true }).click();await expect(panel(page).locator('[data-customer-account-list] article')).toHaveCount(2);await openAccountActions(page);
};
const open = async (page: Page) => {
  await openAccounts(page);await page.getByRole('button',{ name: /^Follow up on account payment for Morgan/ }).click();
  await expect(form(page).getByLabel('Follow-up time (your device timezone)')).toBeEnabled();
};
const review = async (page: Page) => {
  await openAccounts(page);await page.evaluate(() => window.__customerAccounts.reminderDue());
  await page.getByRole('button',{ name: 'Review account payment reminder email',exact: true }).click();
  await expect(page.getByRole('textbox',{ name: 'Subject',exact: true })).toHaveValue(/^Account payment reminder:/);
};
test.beforeEach(async ({ page }) => {
  const headers = await readFile(resolve(import.meta.dirname,'../public/_headers'),'utf8');const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1];if (!policy) throw new Error('Missing shipped CSP');
  await page.route('**/customer-account*-harness.html',async route => { const response = await route.fetch();await route.fulfill({ response,headers: { ...response.headers(),'content-security-policy': policy } }); });
  await page.goto(BASE);await expect(page.locator('[data-job-list] article')).toHaveCount(2);
});
test('schedules an owner-only account alert without changing money or sending mail',async ({ page }) => {
  await open(page);await expect(form(page).locator('input[type=url]')).toHaveCount(0);
  await expect(page.locator('[data-account-payment-reminder-editor]')).toContainText('Linked invoice reminders stay held');
  await form(page).getByLabel('Follow-up time (your device timezone)').fill('2026-10-16T12:00');
  await form(page).getByRole('button',{ name: 'Save account payment follow-up',exact: true }).click();await expect(queue(page)).toContainText('Follow-up scheduled');
  const calls = await page.evaluate(() => window.__customerAccounts.calls);
  expect(calls.find(row => row.method === 'reception.accounts.payment.reminders.set')?.payload).toMatchObject({ account_id: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000100',expected_revision: 0,sender_mail_instance: '',recipient_email: '' });
  expect(calls.some(row => row.method === 'execute' || row.method === 'mail.drafts.create')).toBe(false);
});
test('prepares one reviewed email with both currencies and unpaid invoices',async ({ page }) => {
  await review(page);const calls = await page.evaluate(() => window.__customerAccounts.calls);
  const saved = calls.find(row => row.method === 'mail.drafts.create')?.payload as { idempotency_key: string;content: { body: string } };
  expect(saved.idempotency_key).toBe('qapr_aaaaaaaa-aaaa-aaaa-aaaa-000000000100_1');expect(saved.content.body).toContain('90.0000 GBP');expect(saved.content.body).toContain('90.0000 EUR');
  expect(saved.content.body).toContain('Invoice INV-1');expect(saved.content.body).toContain('Invoice INV-2');expect(saved.content.body).not.toContain('INV-3');expect(saved.content.body).not.toContain('PRIVATE');
  expect(calls.some(row => row.method === 'execute')).toBe(false);await page.getByRole('button',{ name: 'Send',exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__customerAccounts.calls.filter(row => row.method === 'execute').length)).toBe(1);
  await expect(page.locator('[data-job-list]')).toContainText('90.0000 GBP outstanding');await expect(page.locator('img[src=x]')).toHaveCount(0);
});
test('snoozes and pauses the exact account revision and restores focus',async ({ page }) => {
  await openAccounts(page);await page.evaluate(() => window.__customerAccounts.reminderDue());
  await page.getByRole('button',{ name: 'Snooze account payment 1 day',exact: true }).click();await expect(queue(page)).toContainText('Follow-up scheduled');
  await page.getByRole('button',{ name: 'Pause account payment follow-up',exact: true }).click();await expect(queue(page)).toContainText('No account payment follow-ups');
  await expect(page.getByRole('button',{ name: 'Refresh account payment follow-ups',exact: true })).toBeFocused();
  const calls = await page.evaluate(() => window.__customerAccounts.calls.filter(row => row.method === 'reception.accounts.payment.reminders.set'));
  expect(calls.map(row => (row.payload as { expected_revision: number }).expected_revision)).toEqual([1,2]);
});
test('preserves dirty follow-up edits across job refresh and returns to its account action',async ({ page }) => {
  await open(page);await form(page).getByLabel('Customer email (optional)').fill('edited@example.test');
  expect(await page.evaluate(() => window.__customerAccounts.hasUnsavedChanges())).toBe(true);await page.evaluate(() => window.__customerAccounts.update());
  await expect(form(page).getByLabel('Customer email (optional)')).toHaveValue('edited@example.test');
  await page.getByRole('button',{ name: /^Edit account Morgan/ }).click();await expect(panel(page)).toContainText('close the follow-up, payment or email');
  await expect(panel(page).getByRole('form',{ name: 'Edit customer account' })).toBeHidden();
  await page.getByRole('button',{ name: 'Close account payment follow-up',exact: true }).click();
  await expect(page.getByRole('button',{ name: /^Follow up on account payment for Morgan/ })).toBeFocused();expect(await page.evaluate(() => window.__customerAccounts.hasUnsavedChanges())).toBe(false);
});
test('requires saving changed recipients before preparing an email',async ({ page }) => {
  await openAccounts(page);await page.evaluate(() => window.__customerAccounts.reminderDue());await page.getByRole('button',{ name: /^Follow up on account payment for Morgan/ }).click();
  await form(page).getByLabel('Customer email (optional)').fill('new@example.test');
  await page.getByRole('button',{ name: 'Review account payment reminder email',exact: true }).click();await expect(panel(page)).toContainText('Save or close this follow-up');
  expect(await page.evaluate(() => window.__customerAccounts.calls.some(row => row.method === 'mail.drafts.create'))).toBe(false);
  await form(page).getByRole('button',{ name: 'Save account payment follow-up',exact: true }).click();await page.getByRole('button',{ name: 'Review account payment reminder email',exact: true }).click();
  const saved = await page.evaluate(() => window.__customerAccounts.calls.find(row => row.method === 'mail.drafts.create')?.payload);expect(saved).toMatchObject({ content: { to: ['new@example.test'] } });
});
for (const action of ['Snooze account payment 1 day','Pause account payment follow-up']) {
  test(`preserves the open editor revision when the queue offers ${action}`,async ({ page }) => {
    await openAccounts(page);await page.evaluate(() => window.__customerAccounts.reminderDue());
    await queue(page).getByRole('button',{ name: 'Edit account payment follow-up',exact: true }).click();
    await form(page).getByLabel('Customer email (optional)').fill('kept@example.test');
    await queue(page).getByRole('button',{ name: action,exact: true }).click();
    await expect(page.locator('[data-account-payment-reminder-editor]')).toContainText('Save or close this follow-up before changing it from the queue.');
    expect(await page.evaluate(() => window.__customerAccounts.calls.filter(row => row.method === 'reception.accounts.payment.reminders.set').length)).toBe(0);
    await expect(form(page).getByLabel('Customer email (optional)')).toHaveValue('kept@example.test');
    await form(page).getByRole('button',{ name: 'Save account payment follow-up',exact: true }).click();
    await expect(page.locator('[data-account-payment-reminder-editor]')).toContainText('Follow-up saved.');
    expect(await page.evaluate(() => window.__customerAccounts.calls.find(row => row.method === 'reception.accounts.payment.reminders.set')?.payload)).toMatchObject({ expected_revision: 1,recipient_email: 'kept@example.test' });
    await page.getByRole('button',{ name: 'Close account payment follow-up',exact: true }).click();
    await queue(page).getByRole('button',{ name: action,exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__customerAccounts.calls.filter(row => row.method === 'reception.accounts.payment.reminders.set').length)).toBe(2);
    expect(await page.evaluate(() => window.__customerAccounts.calls.filter(row => row.method === 'reception.accounts.payment.reminders.set').at(-1)?.payload)).toMatchObject({ expected_revision: 2 });
  });
}
test('blocks reminder review while a saved account is loading',async ({ page }) => {
  await openAccounts(page);await page.evaluate(() => { window.__customerAccounts.reminderDue();window.__customerAccounts.hold('reception.accounts.get'); });
  await page.getByRole('button',{ name: /^Edit account Morgan/ }).click();
  await expect.poll(() => page.evaluate(() => window.__customerAccounts.pending())).toBe(true);
  await page.getByRole('button',{ name: 'Review account payment reminder email',exact: true }).click();
  await expect(panel(page)).toContainText('Save or close the account edits');
  expect(await page.evaluate(() => window.__customerAccounts.calls.some(row => row.method === 'reception.accounts.payment.reminders.draft' || row.method === 'mail.drafts.create'))).toBe(false);
  await page.evaluate(() => window.__customerAccounts.release());
  await expect(panel(page).getByRole('form',{ name: 'Edit customer account' }).getByLabel('Customer account name')).toBeEnabled();
  await page.getByRole('button',{ name: 'Discard account edits',exact: true }).click();
  await page.getByRole('button',{ name: 'Review account payment reminder email',exact: true }).click();
  await expect(page.getByRole('textbox',{ name: 'Subject',exact: true })).toHaveValue(/^Account payment reminder:/);
});
test('blocks stale account email after billing changes and asks for a fresh occurrence',async ({ page }) => {
  await review(page);await page.evaluate(() => { window.__customerAccounts.change();window.__customerAccounts.update(); });await expect(queue(page)).toContainText('account or billing records changed');
  await expect(page.getByRole('button',{ name: 'Review account payment reminder email',exact: true })).toHaveCount(0);
  await page.getByRole('button',{ name: 'Send',exact: true }).click();await expect(page.getByText('The account or billing records changed. Refresh the account statement.',{ exact: true })).toBeVisible();
});
test('stops account follow-up after settlement and blocks its saved email',async ({ page }) => {
  await review(page);await page.evaluate(() => window.__customerAccounts.settle());await expect(queue(page)).toContainText('No account payment follow-ups');
  await page.getByRole('button',{ name: 'Send',exact: true }).click();await expect(page.getByText('The account or billing records changed. Refresh the account statement.',{ exact: true })).toBeVisible();
});
test('shows an uncertain send and refuses a new occurrence',async ({ page }) => {
  await openAccounts(page);await page.evaluate(() => window.__customerAccounts.uncertainReminder());await expect(queue(page)).toContainText('previous email outcome is unknown');
  await expect(page.getByRole('button',{ name: 'Review account payment reminder email',exact: true })).toHaveCount(0);
  await page.getByRole('button',{ name: 'Snooze account payment 1 day',exact: true }).click();await expect(panel(page)).toContainText('Check the previous email outcome in Mail.');
});
test('keeps owner alerts available during a mail-account outage',async ({ page }) => {
  await page.evaluate(() => window.__customerAccounts.failMail());await open(page);await expect(panel(page)).toContainText('owner reminders remain available');
  await form(page).getByRole('button',{ name: 'Save account payment follow-up',exact: true }).click();await expect(queue(page)).toContainText('Follow-up scheduled');
});
test('retains edited fields and revision after a failed save',async ({ page }) => {
  await open(page);await form(page).getByLabel('Customer email (optional)').fill('kept@example.test');await form(page).getByLabel('Mail account (optional)').selectOption('work');
  await page.evaluate(() => window.__customerAccounts.reminderFail());await form(page).getByRole('button',{ name: 'Save account payment follow-up',exact: true }).click();
  await expect(panel(page)).toContainText('The follow-up changed.');await expect(form(page).getByLabel('Customer email (optional)')).toHaveValue('kept@example.test');
  expect(await page.evaluate(() => window.__customerAccounts.hasUnsavedChanges())).toBe(true);
});
test('blocks queue drafts while the account selection has unsaved edits',async ({ page }) => {
  await openAccounts(page);await page.evaluate(() => window.__customerAccounts.reminderDue());await page.getByRole('button',{ name: /^Edit account Morgan/ }).click();
  await panel(page).getByRole('form',{ name: 'Edit customer account' }).getByLabel('Customer account name').fill('Unsaved name');
  await page.getByRole('button',{ name: 'Review account payment reminder email',exact: true }).dispatchEvent('click');await expect(panel(page)).toContainText('Save or close the account edits');
  expect(await page.evaluate(() => window.__customerAccounts.calls.some(row => row.method === 'reception.accounts.payment.reminders.draft'))).toBe(false);
});
test('pages follow-ups in both directions without losing account identity',async ({ page }) => {
  await openAccounts(page);await page.evaluate(() => window.__customerAccounts.manyReminders());await expect(queue(page).locator('article')).toHaveCount(50);
  await page.getByRole('button',{ name: 'More account payment follow-ups',exact: true }).click();await expect(queue(page).locator('article')).toHaveCount(11);
  await page.getByRole('button',{ name: 'Earlier account payment follow-ups',exact: true }).click();await expect(queue(page).locator('article')).toHaveCount(50);
  const calls = await page.evaluate(() => window.__customerAccounts.calls.filter(row => row.method === 'reception.accounts.payment.reminders.list'));
  expect(calls.at(-1)?.payload).toEqual({ limit: 50 });
});
test('rejects repeated clicks while draft preparation is pending',async ({ page }) => {
  await openAccounts(page);await page.evaluate(() => { window.__customerAccounts.reminderDue();window.__customerAccounts.hold('reception.accounts.payment.reminders.draft'); });
  const review = page.getByRole('button',{ name: 'Review account payment reminder email',exact: true });await review.click();await expect.poll(() => page.evaluate(() => window.__customerAccounts.pending())).toBe(true);
  await review.dispatchEvent('click');expect(await page.evaluate(() => window.__customerAccounts.calls.filter(row => row.method === 'reception.accounts.payment.reminders.draft').length)).toBe(1);
  await page.evaluate(() => window.__customerAccounts.release());await expect(page.getByRole('textbox',{ name: 'Subject',exact: true })).toHaveValue(/^Account payment reminder:/);
});
test('ignores a delayed account reminder read after route disposal',async ({ page }) => {
  await openAccounts(page);await page.evaluate(() => window.__customerAccounts.hold('reception.accounts.payment.reminders.get'));await page.getByRole('button',{ name: /^Follow up on account payment for Morgan/ }).click();
  await expect.poll(() => page.evaluate(() => window.__customerAccounts.pending())).toBe(true);expect(await page.evaluate(() => window.__customerAccounts.hasInFlightWork())).toBe(true);
  await page.evaluate(() => { window.__customerAccounts.dispose();window.__customerAccounts.release(); });await expect(page.locator('[data-customer-jobs]')).toHaveCount(0);
});
test('fits the account follow-up form within a narrow viewport',async ({ page },info) => {
  await page.setViewportSize({ width: 390,height: 844 });await open(page);expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await form(page).screenshot({ path: info.outputPath('account-payment-follow-up-mobile.png') });
});

test('can pause a stopped account follow-up from its editor',async ({ page }) => {
  await openAccounts(page);await page.evaluate(() => { window.__customerAccounts.reminderDue();window.__customerAccounts.settle(); });
  await page.getByRole('button',{ name: /^Follow up on account payment for Morgan/ }).click();
  await expect(page.locator('[data-account-payment-reminder-editor]')).toContainText('This follow-up is stopped.');
  await page.locator('[data-account-payment-reminder-editor]').getByRole('button',{ name: 'Pause account payment follow-up',exact: true }).click();
  await expect(form(page)).toBeHidden();
  expect(await page.evaluate(() => window.__customerAccounts.calls.filter(row => row.method === 'reception.accounts.payment.reminders.set').at(-1)?.payload)).toMatchObject({ expected_revision: 1,due_at: null });
});

test('locks fresh account payment entry while editing its reminder',async ({ page }) => {
  await page.goto(BASE.replace('customer-accounts-harness.html','customer-account-payments-harness.html'));await expect(page.getByRole('heading',{name:'Morgan <studio>',exact:true})).toBeVisible();await openAccountActions(page);
  await page.getByRole('button',{ name: /^Open account payments for Morgan/ }).click();
  const entry = page.getByRole('form',{ name: 'Record customer account payment',exact: true });await expect(entry.getByLabel('Amount received')).toBeEnabled();
  await page.getByRole('button',{ name: /^Follow up on account payment for Morgan/ }).click();await expect(form(page).getByLabel('Follow-up time (your device timezone)')).toBeEnabled();
  await expect(entry.getByLabel('Amount received')).toBeDisabled();await expect(entry.getByRole('button',{ name: 'Discard account payment',exact: true })).toBeDisabled();
  await entry.dispatchEvent('submit');expect(await page.evaluate(() => window.__accountPayments.calls.some(row => row.method === 'reception.accounts.payment.prepare'))).toBe(false);
  await page.getByRole('button',{ name: 'Close account payment follow-up',exact: true }).click();await expect(entry.getByLabel('Amount received')).toBeEnabled();
});
