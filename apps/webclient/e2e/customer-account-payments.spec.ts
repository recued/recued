import {openAccountActions} from './customer-work-driver.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect,test,type Page } from '@playwright/test';
import type {} from './harness/customer-account-payments-harness.js';
const BASE = `${process.env.E2E_CUSTOMER_ACCOUNT_PAYMENTS_HARNESS_URL ?? 'http://127.0.0.1:4319'}/customer-account-payments-harness.html`;
const root = (page: Page) => page.locator('[data-customer-account-payments]');
const form = (page: Page) => root(page).getByRole('form',{ name: 'Record customer account payment',exact: true });
const receipt = (page: Page) => root(page).locator('[data-customer-account-payment-statement]');
const open = async (page: Page) => { await expect(page.getByRole('heading',{name:'Morgan <studio>',exact:true})).toBeVisible();await openAccountActions(page); await page.getByRole('button',{ name: 'Open account payments for Morgan <studio>',exact: true }).click();await expect(form(page).getByRole('button',{ name: 'Preview account payment',exact: true })).toBeEnabled(); };
const fill = async (page: Page) => {
  await open(page);await form(page).getByLabel('Payment currency',{ exact: true }).selectOption('GBP');
  await form(page).getByLabel('Amount received',{ exact: true }).fill('50.0003');await form(page).getByLabel('Received on',{ exact: true }).fill('2026-10-15');
  await form(page).getByLabel('Payment method',{ exact: true }).fill('bank transfer');await form(page).getByLabel('Payment reference',{ exact: true }).fill('BANK-ONE');
  await form(page).getByLabel(/^INV-1 ·/).fill('30.0001');await form(page).getByLabel(/^INV-2 ·/).fill('20.0002');
};
const preview = async (page: Page) => { await fill(page);await form(page).getByRole('button',{ name: 'Preview account payment',exact: true }).click();await expect(root(page).getByRole('button',{ name: 'Review account payment',exact: true })).toBeVisible(); };
const recorded = async (page: Page) => { await page.evaluate(() => window.__accountPayments.mode('success'));await preview(page);await root(page).getByRole('button',{ name: 'Review account payment',exact: true }).click();await expect(root(page)).toContainText('Account payment recorded.'); };
const showReceipt = async (page: Page) => { await recorded(page);await root(page).getByRole('button',{ name: /^View account payment receipt / }).click();await expect(receipt(page)).toContainText('Originally recorded payment: 50.0003 GBP'); };
test.beforeEach(async ({ page }) => {
  const headers = await readFile(resolve(import.meta.dirname,'../public/_headers'),'utf8');const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1];if (!policy) throw new Error('Missing shipped CSP');
  await page.route('**/customer-account-payments-harness.html',async route => { const response = await route.fetch();await route.fulfill({ response,headers: { ...response.headers(),'content-security-policy': policy } }); });
  await page.goto(BASE);await expect(page.getByRole('heading',{ name: 'Morgan <studio>',exact: true })).toBeVisible();await openAccountActions(page);
});
test('loads payment balances only on demand and restricts invoice choices to one currency',async ({ page }) => {
  expect(await page.evaluate(() => window.__accountPayments.calls.some(c => c.method === 'reception.accounts.payment.history'))).toBe(false);await open(page);
  await expect(form(page).getByLabel(/^INV-3 ·/)).toBeVisible();await expect(form(page).getByLabel(/^INV-1 ·/)).toHaveCount(0);
  await form(page).getByLabel('Payment currency',{ exact: true }).selectOption('GBP');await expect(form(page).locator('[data-account-payment-invoice]')).toHaveCount(2);
});
test('previews exact decimal allocations without executing and requires owner review',async ({ page }) => {
  await preview(page);await expect(root(page).locator('[data-account-payment-preview]')).toContainText('INV-1: 30.0001');await expect(root(page)).toContainText('INV-2: 20.0002');
  const input = await page.evaluate(() => window.__accountPayments.calls.find(c => c.method === 'reception.accounts.payment.prepare')!.payload);
  expect(input).toMatchObject({ currency: 'GBP',amount: '50.0003',allocations: [{ signoff_id: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001',amount: '30.0001' },{ signoff_id: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000002',amount: '20.0002' }] });
  expect(await page.evaluate(() => window.__accountPayments.calls.some(c => c.method === 'execute'))).toBe(false);
});
test('rejects unbalanced allocations while retaining entered values',async ({ page }) => {
  await fill(page);await form(page).getByLabel('Amount received',{ exact: true }).fill('50');await form(page).getByRole('button',{ name: 'Preview account payment',exact: true }).click();
  await expect(root(page)).toContainText('must add up exactly');await expect(form(page).getByLabel(/^INV-1 ·/)).toHaveValue('30.0001');expect(await page.evaluate(() => window.__accountPayments.dirty())).toBe(true);
});
test('retains amounts across currency changes and invalidates an edited preview',async ({ page }) => {
  await preview(page);await form(page).getByLabel('Payment reference',{ exact: true }).fill('CHANGED');await expect(root(page).getByRole('button',{ name: 'Review account payment',exact: true })).toBeHidden();
  await form(page).getByLabel('Payment currency',{ exact: true }).selectOption('EUR');await form(page).getByLabel('Payment currency',{ exact: true }).selectOption('GBP');await expect(form(page).getByLabel(/^INV-1 ·/)).toHaveValue('30.0001');
});
test('protects dirty edits from account refresh and close, then discards explicitly',async ({ page }) => {
  await fill(page);await page.getByRole('button',{ name: 'Close customer accounts',exact: true }).click();await expect(root(page)).toBeVisible();await expect(form(page).getByLabel('Payment reference',{ exact: true })).toHaveValue('BANK-ONE');
  await root(page).getByRole('button',{ name: 'Refresh account payments',exact: true }).click();await expect(root(page)).toContainText('Finish or discard');
  await form(page).getByRole('button',{ name: 'Discard account payment',exact: true }).click();expect(await page.evaluate(() => window.__accountPayments.dirty())).toBe(false);await expect(form(page).getByLabel('Amount received',{ exact: true })).toBeFocused();
});
test('prevents duplicate preview submission and reports pending route work',async ({ page }) => {
  await fill(page);await page.evaluate(() => window.__accountPayments.hold('reception.accounts.payment.prepare'));await form(page).getByRole('button',{ name: 'Preview account payment',exact: true }).click();
  await expect(form(page).getByRole('button',{ name: 'Preview account payment',exact: true })).toBeDisabled();expect(await page.evaluate(() => window.__accountPayments.busy())).toBe(true);
  await form(page).evaluate(node => (node as HTMLFormElement).requestSubmit());await page.evaluate(() => window.__accountPayments.release());await expect(root(page).getByRole('button',{ name: 'Review account payment',exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__accountPayments.calls.filter(c => c.method === 'reception.accounts.payment.prepare').length)).toBe(1);
});
test('keeps stale reviews from recording and requires fresh balances',async ({ page }) => {
  await preview(page);await page.evaluate(() => window.__accountPayments.change());await root(page).getByRole('button',{ name: 'Review account payment',exact: true }).click();await expect(root(page)).toContainText('balances changed');
  await expect(root(page).getByRole('button',{ name: /^View account payment receipt / })).toHaveCount(0);
});
test('requires the installed approval recipe',async ({ page }) => {
  await preview(page);await page.evaluate(() => window.__accountPayments.mode('missing'));await root(page).getByRole('button',{ name: 'Review account payment',exact: true }).click();await expect(root(page)).toContainText('Install or update Reception');
  expect(await page.evaluate(() => window.__accountPayments.calls.some(c => c.method === 'execute'))).toBe(false);
});
test('queues a single owner decision and does not claim a receipt before approval',async ({ page }) => {
  await preview(page);await root(page).getByRole('button',{ name: 'Review account payment',exact: true }).click();await expect(root(page)).toContainText('waiting for your approval');
  await expect(root(page).getByRole('button',{ name: 'Review account payment',exact: true })).toBeDisabled();await expect(root(page).getByRole('link',{ name: 'Review in Runs',exact: true })).toBeVisible();
  await expect(root(page).getByRole('button',{ name: /^View account payment receipt / })).toHaveCount(0);expect(await page.evaluate(() => window.__accountPayments.dirty())).toBe(false);
});
test('confirms the applied payment and shows a complete escaped offline receipt',async ({ page }) => {
  await showReceipt(page);const download = page.waitForEvent('download');await receipt(page).getByRole('button',{ name: 'Download account payment receipt',exact: true }).click();
  const saved = await download;const path = await saved.path();if (!path) throw new Error('Receipt download missing');const html = await readFile(path,'utf8');
  expect(html).toContain('Morgan &lt;studio&gt;');expect(html).toContain('INV-1');expect(html).toContain('INV-2');expect(html).not.toContain('<script');
});
test('keeps receipts available when Mail fails',async ({ page }) => {
  await page.evaluate(() => window.__accountPayments.failMail());await showReceipt(page);await expect(receipt(page)).toContainText('Mail accounts could not be loaded');await expect(receipt(page).getByRole('button',{ name: 'Download account payment receipt',exact: true })).toBeEnabled();
});
test('prepares one private receipt draft for owner review',async ({ page }) => {
  await showReceipt(page);const email = receipt(page).getByRole('form',{ name: 'Prepare account payment receipt email',exact: true });await email.getByLabel('Customer email',{ exact: true }).fill('morgan@example.test');await email.getByLabel('Mail account',{ exact: true }).selectOption('work');
  await email.getByRole('button',{ name: 'Review account payment receipt email',exact: true }).click();await expect(page.getByRole('textbox',{ name: 'Subject',exact: true })).toHaveValue(/^Customer account payment receipt:/);
  expect(await page.evaluate(() => window.__accountPayments.calls.filter(c => c.method === 'mail.drafts.create').length)).toBe(1);
});
test('disposes safely during a pending preview',async ({ page }) => {
  await fill(page);await page.evaluate(() => window.__accountPayments.hold('reception.accounts.payment.prepare'));await form(page).getByRole('button',{ name: 'Preview account payment',exact: true }).click();
  await page.evaluate(() => { window.__accountPayments.dispose();window.__accountPayments.release(); });await expect(root(page)).toHaveCount(0);expect(await page.evaluate(() => window.__accountPayments.calls.some(c => c.method === 'execute'))).toBe(false);
});
test('keeps the account payment form within a narrow viewport',async ({ page }) => {
  await page.setViewportSize({ width: 390,height: 844 });await preview(page);expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('prints the isolated receipt and returns focus to the payment history action',async ({ page }) => {
  await page.addInitScript(() => { window.print = () => document.documentElement.setAttribute('data-print-called','true'); });await page.goto(BASE);await showReceipt(page);
  await receipt(page).getByRole('button',{ name: 'Print account payment receipt / save PDF',exact: true }).click();const frame = page.frameLocator('[data-account-payment-statement-print]');
  await expect(frame.locator('html')).toHaveAttribute('data-print-called','true');await expect(frame.locator('body')).toContainText('Invoice INV-2');await expect(frame.locator('script,img')).toHaveCount(0);
  await receipt(page).getByRole('button',{ name: 'Close account payment receipt',exact: true }).click();await expect(page.locator('[data-account-payment-statement-print]')).toHaveCount(0);
  await expect(root(page).getByRole('button',{ name: /^View account payment receipt / })).toBeFocused();
});
test('rechecks the receipt before creating email and preserves the entered recipient after refusal',async ({ page }) => {
  await showReceipt(page);const email = receipt(page).getByRole('form',{ name: 'Prepare account payment receipt email',exact: true });await email.getByLabel('Customer email',{ exact: true }).fill('morgan@example.test');await email.getByLabel('Mail account',{ exact: true }).selectOption('work');
  await page.evaluate(() => window.__accountPayments.change());await email.getByRole('button',{ name: 'Review account payment receipt email',exact: true }).click();await expect(receipt(page)).toContainText('payment entries changed');await expect(email.getByLabel('Customer email',{ exact: true })).toHaveValue('morgan@example.test');
  expect(await page.evaluate(() => window.__accountPayments.calls.some(c => c.method === 'mail.drafts.create'))).toBe(false);
});
test('rejects Send if a payment entry changed after receipt review',async ({ page }) => {
  await showReceipt(page);const email = receipt(page).getByRole('form',{ name: 'Prepare account payment receipt email',exact: true });await email.getByLabel('Customer email',{ exact: true }).fill('morgan@example.test');await email.getByLabel('Mail account',{ exact: true }).selectOption('work');await email.getByRole('button',{ name: 'Review account payment receipt email',exact: true }).click();
  await expect(page.getByRole('textbox',{ name: 'Subject',exact: true })).toBeVisible();await page.evaluate(() => window.__accountPayments.change());await page.getByRole('button',{ name: 'Send',exact: true }).click();await expect(page.getByRole('alert')).toContainText('payment entries changed');
});
test('pages through recorded account payments and returns to the newest page',async ({ page }) => {
  await recorded(page);await page.evaluate(() => window.__accountPayments.many());await root(page).getByRole('button',{ name: 'Refresh account payments',exact: true }).click();await expect(root(page).locator('[data-account-payment-history] article')).toHaveCount(25);
  await root(page).getByRole('button',{ name: 'Older account payments',exact: true }).click();await expect(root(page).locator('[data-account-payment-history] article')).toHaveCount(2);
  await root(page).getByRole('button',{ name: 'Newer account payments',exact: true }).click();await expect(root(page).locator('[data-account-payment-history] article')).toHaveCount(25);
});
test('starts another entry with fresh balances and clears the old receipt',async ({ page }) => {
  await showReceipt(page);await receipt(page).getByRole('button',{ name: 'Close account payment receipt',exact: true }).click();await root(page).getByRole('button',{ name: 'Start another account payment',exact: true }).click();
  await expect(form(page).getByRole('button',{ name: 'Preview account payment',exact: true })).toBeEnabled();await expect(form(page).getByLabel('Amount received',{ exact: true })).toHaveValue('');
  expect(await page.evaluate(() => window.__accountPayments.calls.filter(c => c.method === 'reception.accounts.statement').length)).toBe(2);
});


test('keeps gross payment allocations and refund balances separate in the combined receipt',async ({ page }) => {
  await recorded(page);await page.evaluate(() => window.__accountPayments.refund());await root(page).getByRole('button',{ name: /^View account payment receipt / }).click();
  await expect(receipt(page)).toContainText('Current recorded allocations: 50.0003 GBP');await expect(receipt(page)).toContainText('Recorded refunds: 7.0001 GBP');await expect(receipt(page)).toContainText('Refund still owed: 3.0000 GBP');
});


test('clears the previous account form when a different account has unavailable billing',async ({ page }) => {
  await open(page);await expect(form(page).getByLabel(/^INV-3 ·/)).toBeVisible();await page.evaluate(() => window.__accountPayments.otherAccount());
  await page.getByRole('button',{ name: 'Refresh customer accounts',exact: true }).click();await expect(page.getByRole('heading',{name:'Casey',exact:true})).toBeVisible();await openAccountActions(page);await page.getByRole('button',{ name: 'Open account payments for Casey',exact: true }).click();
  await expect(root(page)).toContainText('selected account billing records are unavailable');
  await expect(root(page).getByRole('heading',{ name: /Customer account payments/ })).toContainText('000000000101');
  await expect(form(page).locator('[data-account-payment-invoice]')).toHaveCount(0);await expect(form(page).getByLabel('Payment currency',{ exact: true }).locator('option')).toHaveCount(0);
  await expect(form(page).getByLabel('Amount received',{ exact: true })).toBeDisabled();await expect(root(page)).toContainText('No account payments recorded.');
});
test('disables entry and clears stale invoice choices after a failed balance refresh',async ({ page }) => {
  await open(page);await page.evaluate(() => window.__accountPayments.failBilling(true));await root(page).getByRole('button',{ name: 'Refresh account payments',exact: true }).click();
  await expect(root(page)).toContainText('selected account billing records are unavailable');await expect(form(page).locator('[data-account-payment-invoice]')).toHaveCount(0);
  await expect(form(page).getByLabel('Amount received',{ exact: true })).toBeDisabled();await expect(form(page).getByRole('button',{ name: 'Preview account payment',exact: true })).toBeDisabled();
  await page.evaluate(() => window.__accountPayments.failBilling(false));await root(page).getByRole('button',{ name: 'Refresh account payments',exact: true }).click();await expect(form(page).getByRole('button',{ name: 'Preview account payment',exact: true })).toBeEnabled();
});
