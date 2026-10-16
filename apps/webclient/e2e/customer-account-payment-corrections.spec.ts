import {openAccountActions} from './customer-work-driver.js';
import { expect,test,type Page } from '@playwright/test';
import type {} from './harness/customer-account-payments-harness.js';
const BASE = `${process.env.E2E_CUSTOMER_ACCOUNT_PAYMENTS_HARNESS_URL ?? 'http://127.0.0.1:4319'}/customer-account-payments-harness.html`;
const payments = (page: Page) => page.locator('[data-customer-account-payments]');
const editor = (page: Page) => page.locator('[data-account-payment-corrections]');
const form = (page: Page) => editor(page).getByRole('form',{name:'Correct customer account payment',exact:true});
const record = async (page: Page) => {
  await page.goto(BASE);await expect(page.getByRole('heading',{name:'Morgan <studio>',exact:true})).toBeVisible();await openAccountActions(page);await page.getByRole('button',{name:'Open account payments for Morgan <studio>',exact:true}).click();const f=payments(page).getByRole('form',{name:'Record customer account payment',exact:true});
  await expect(f.getByRole('button',{name:'Preview account payment',exact:true})).toBeEnabled();await f.getByLabel('Payment currency',{exact:true}).selectOption('GBP');
  await f.getByLabel('Amount received',{exact:true}).fill('50.0003');await f.getByLabel('Received on',{exact:true}).fill('2026-10-15');
  await f.getByLabel(/^INV-1 ·/).fill('30.0001');await f.getByLabel(/^INV-2 ·/).fill('20.0002');
  await page.evaluate(()=>window.__accountPayments.mode('success'));await f.getByRole('button',{name:'Preview account payment',exact:true}).click();
  await payments(page).getByRole('button',{name:'Review account payment',exact:true}).click();await expect(payments(page).getByRole('button',{name:/^Correct account payment aaaa/})).toBeVisible();
};
const open = async (page: Page) => { await record(page);await payments(page).getByRole('button',{name:/^Correct account payment aaaa/}).click();await expect(form(page).getByRole('button',{name:'Preview account payment correction',exact:true})).toBeEnabled(); };
const preview = async (page: Page) => {
  await open(page);await form(page).getByLabel('Correct account payment total',{exact:true}).fill('30.0003');await form(page).getByLabel(/^INV-1 ·/).fill('10.0001');
  await form(page).getByLabel('Reason for account payment correction',{exact:true}).fill('Fix allocation <not HTML>.');await form(page).getByRole('button',{name:'Preview account payment correction',exact:true}).click();
  await expect(editor(page).getByRole('button',{name:'Review account payment correction',exact:true})).toBeVisible();
};
test('previews every original allocation without executing a correction',async({page})=>{
  await preview(page);await expect(editor(page).locator('[data-account-correction-preview]')).toContainText('INV-1: 30.0001 → 10.0001');await expect(editor(page).locator('[data-account-correction-preview]')).toContainText('INV-2');
  expect(await page.evaluate(()=>window.__accountPayments.calls.filter(c=>c.method==='execute').length)).toBe(1);expect(await page.evaluate(()=>window.__accountPayments.dirty())).toBe(true);
});
test('keeps a single correction waiting for owner approval and preserves its Runs link when closed',async({page})=>{
  await preview(page);await page.evaluate(()=>window.__accountPayments.mode('approval'));await editor(page).getByRole('button',{name:'Review account payment correction',exact:true}).click();
  await expect(editor(page)).toContainText('waiting for your approval');await expect(editor(page).getByRole('link',{name:'Review correction in Runs',exact:true})).toBeVisible();await expect(form(page).getByLabel('Correct account payment total',{exact:true})).toBeDisabled();
  await editor(page).getByRole('button',{name:'Close account payment correction',exact:true}).click();await expect(editor(page)).toBeHidden();expect(await page.evaluate(()=>window.__accountPayments.calls.filter(c=>c.method==='execute').length)).toBe(2);
});
test('applies a confirmed correction and refreshes the combined receipt while retaining the original total',async({page})=>{
  await preview(page);await editor(page).getByRole('button',{name:'Review account payment correction',exact:true}).click();await expect(editor(page)).toContainText('correction applied');
  await editor(page).getByRole('button',{name:'Close account payment correction',exact:true}).click();await expect(payments(page).getByRole('button',{name:/^Correct account payment aaaa/})).toBeFocused();
  await payments(page).getByRole('button',{name:/^View account payment receipt /}).click();const receipt=payments(page).locator('[data-customer-account-payment-statement]');
  await expect(receipt).toContainText('Originally recorded payment: 50.0003 GBP');await expect(receipt).toContainText('Current recorded allocations: 30.0003 GBP');await expect(receipt).toContainText('10.0001');
});
test('voids the group without submitting replacement fields and shows removed entries in its receipt',async({page})=>{
  await open(page);await form(page).getByLabel(/^INV-1 ·/).fill('');await form(page).getByLabel('Account correction action',{exact:true}).selectOption('void');
  await form(page).getByLabel('Reason for account payment correction',{exact:true}).fill('Duplicate received payment.');await form(page).getByRole('button',{name:'Preview account payment correction',exact:true}).click();
  await expect(editor(page).locator('[data-account-correction-preview]')).toContainText('removed');const input=await page.evaluate(()=>window.__accountPayments.calls.find(c=>c.method==='reception.accounts.payment.correction.prepare')!.payload);expect(input).not.toHaveProperty('allocations');expect(input).not.toHaveProperty('amount');
  await editor(page).getByRole('button',{name:'Review account payment correction',exact:true}).click();await editor(page).getByRole('button',{name:'Close account payment correction',exact:true}).click();
  await payments(page).getByRole('button',{name:/^View account payment receipt /}).click();await expect(payments(page).locator('[data-customer-account-payment-statement]')).toContainText('Current recorded allocations: 0.0000 GBP');
});
test('protects the correction from account close and refresh, then closes explicitly',async({page})=>{
  await open(page);await form(page).getByLabel('Reason for account payment correction',{exact:true}).fill('Keep my reason');await payments(page).getByRole('button',{name:'Refresh account payments',exact:true}).click();
  await page.getByRole('button',{name:'Close customer accounts',exact:true}).click();await expect(editor(page)).toBeVisible();await expect(form(page).getByLabel('Reason for account payment correction',{exact:true})).toHaveValue('Keep my reason');
  await editor(page).getByRole('button',{name:'Close account payment correction',exact:true}).click();expect(await page.evaluate(()=>window.__accountPayments.dirty())).toBe(false);
});
test('prevents duplicate preview requests and keeps route work in flight',async({page})=>{
  await open(page);await form(page).getByLabel('Reason for account payment correction',{exact:true}).fill('Correct reference');await form(page).getByLabel('Correct account payment reference',{exact:true}).fill('NEW');
  await page.evaluate(()=>window.__accountPayments.hold('reception.accounts.payment.correction.prepare'));await form(page).getByRole('button',{name:'Preview account payment correction',exact:true}).click();await expect(editor(page).getByRole('button',{name:'Close account payment correction',exact:true})).toBeDisabled();expect(await page.evaluate(()=>window.__accountPayments.busy())).toBe(true);
  await form(page).evaluate(n=>(n as HTMLFormElement).requestSubmit());await page.evaluate(()=>window.__accountPayments.release());await expect(editor(page).getByRole('button',{name:'Review account payment correction',exact:true})).toBeVisible();expect(await page.evaluate(()=>window.__accountPayments.calls.filter(c=>c.method==='reception.accounts.payment.correction.prepare').length)).toBe(1);
});
test('invalidates an edited preview and refuses stale reviews',async({page})=>{
  await preview(page);await form(page).getByLabel('Correct account payment reference',{exact:true}).fill('NEW');await expect(editor(page).getByRole('button',{name:'Review account payment correction',exact:true})).toBeHidden();
  await form(page).getByRole('button',{name:'Preview account payment correction',exact:true}).click();await page.evaluate(()=>window.__accountPayments.change());await editor(page).getByRole('button',{name:'Review account payment correction',exact:true}).click();await expect(editor(page)).toContainText('entries changed');
});
test('requires the installed correction recipe before starting owner review',async({page})=>{
  await preview(page);await page.evaluate(()=>window.__accountPayments.mode('missing'));await editor(page).getByRole('button',{name:'Review account payment correction',exact:true}).click();await expect(editor(page)).toContainText('Install or update Reception');expect(await page.evaluate(()=>window.__accountPayments.calls.filter(c=>c.method==='execute').length)).toBe(1);
});
test('keeps correction history usable after a receipt load fails and recovers on refresh',async({page})=>{
  await record(page);await page.evaluate(()=>window.__accountPayments.failReceipt(true));await payments(page).getByRole('button',{name:/^Correct account payment aaaa/}).click();await expect(editor(page)).toContainText('receipt is unavailable');await expect(form(page).getByLabel('Correct account payment total',{exact:true})).toBeDisabled();await expect(editor(page).getByRole('button',{name:'Refresh account correction history',exact:true})).toBeEnabled();
  await page.evaluate(()=>window.__accountPayments.failReceipt(false));await editor(page).getByRole('button',{name:'Refresh account correction',exact:true}).click();await expect(form(page).getByLabel('Correct account payment total',{exact:true})).toBeEnabled();
});
test('pages correction history and shows literal reasons without HTML',async({page})=>{
  await preview(page);await page.evaluate(()=>window.__accountPayments.manyCorrections());await editor(page).getByRole('button',{name:'Refresh account correction history',exact:true}).click();await expect(editor(page).locator('[data-account-correction-id]')).toHaveCount(25);
  await editor(page).getByRole('button',{name:'Older account corrections',exact:true}).click();await expect(editor(page).locator('[data-account-correction-id]')).toHaveCount(2);await expect(editor(page)).toContainText('Fix allocation <not HTML>.');await expect(editor(page).locator('not')).toHaveCount(0);
  await editor(page).getByRole('button',{name:'Newer account corrections',exact:true}).click();await expect(editor(page).locator('[data-account-correction-id]')).toHaveCount(25);
});
test('locks original payment entry while correcting a historical group and rejects programmatic submit',async({page})=>{
  await record(page);const original=payments(page).getByRole('form',{name:'Record customer account payment',exact:true});
  await original.getByRole('button',{name:'Start another account payment',exact:true}).click();await expect(original.getByLabel('Amount received',{exact:true})).toBeEnabled();
  await payments(page).getByRole('button',{name:/^Correct account payment aaaa/}).click();await expect(form(page).getByRole('button',{name:'Preview account payment correction',exact:true})).toBeEnabled();
  await expect(original.getByLabel('Amount received',{exact:true})).toBeDisabled();await expect(original.getByRole('button',{name:'Discard account payment',exact:true})).toBeDisabled();
  const count=await page.evaluate(()=>window.__accountPayments.calls.filter(c=>c.method==='reception.accounts.payment.prepare').length);
  await original.evaluate(n=>(n as HTMLFormElement).requestSubmit());expect(await page.evaluate(()=>window.__accountPayments.calls.filter(c=>c.method==='reception.accounts.payment.prepare').length)).toBe(count);
  await editor(page).getByRole('button',{name:'Close account payment correction',exact:true}).click();await expect(original.getByLabel('Amount received',{exact:true})).toBeEnabled();
});
test('clears obsolete entry balances after a confirmed correction until a fresh account statement loads',async({page})=>{
  await preview(page);await editor(page).getByRole('button',{name:'Review account payment correction',exact:true}).click();await expect(editor(page)).toContainText('correction applied');
  await editor(page).getByRole('button',{name:'Close account payment correction',exact:true}).click();const original=payments(page).getByRole('form',{name:'Record customer account payment',exact:true});
  await expect(original.getByLabel('Amount received',{exact:true})).toBeDisabled();await expect(original.locator('[data-account-payment-invoice]')).toHaveCount(0);
  await expect(original.getByLabel('Amount received',{exact:true})).toHaveValue('');await expect(payments(page)).toContainText('Refresh account payments before recording another');
  await payments(page).getByRole('button',{name:'Refresh account payments',exact:true}).click();await expect(original.getByLabel('Amount received',{exact:true})).toBeEnabled();
  await original.getByLabel('Payment currency',{exact:true}).selectOption('GBP');await expect(original.locator('[data-account-payment-invoice]')).toHaveCount(2);
});
