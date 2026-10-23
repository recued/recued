import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect,test,type Page } from '@playwright/test';
import { openJob } from './customer-work-driver.js';
import type {} from './harness/quote-payment-reminders-harness.js';
const BASE=`${process.env.E2E_PAYMENT_REMINDERS_HARNESS_URL??HARNESS_ORIGIN}/quote-payment-reminders-harness.html`;
const form=(page:Page)=>page.getByRole('form',{name:'Payment follow-up',exact:true});
// Since c63d5b076 the follow-up editor opens from the job's Follow-ups tab, and the due queue
// lives in Reception → Follow-ups, one group per kind.
const open=async(page:Page)=>{await openJob(page,'followups');await page.getByRole('button',{name:'Follow up on payment — INV-101',exact:true}).click();await expect(form(page).getByLabel('Follow-up time (your device timezone)')).toBeVisible();};
const queue=async(page:Page,kind='Invoice payments')=>{
  await page.getByRole('navigation',{name:'Customer work',exact:true}).getByRole('link',{name:'Follow-ups',exact:true}).click();
  const group=page.locator('[data-customer-followup-group]').filter({has:page.locator('summary',{hasText:kind})});
  if(!await group.evaluate(node=>(node as HTMLDetailsElement).open))await group.locator('summary').click();
  return group;
};
const reads=(page:Page,method:string)=>page.evaluate(name=>window.__paymentReminders.calls.filter(call=>call.method===name).length,method);
const closeEmail=async(page:Page)=>{await page.getByRole('dialog',{name:'New mail',exact:true}).getByRole('button',{name:'Close',exact:true}).click();await expect(page.getByRole('dialog',{name:'New mail',exact:true})).toHaveCount(0);};
const toJob=async(page:Page)=>{await page.getByRole('navigation',{name:'Customer work',exact:true}).getByRole('link',{name:'Jobs',exact:true}).click();await openJob(page,'followups');};
const review=async(page:Page)=>{await page.evaluate(()=>window.__paymentReminders.due());await (await queue(page)).getByRole('button',{name:'Review payment reminder email',exact:true}).click();await expect(page.getByLabel('Subject')).toHaveValue('Payment reminder: INV-101');};
test.beforeEach(async({page})=>{
  const headers=await readFile(resolve(import.meta.dirname,'../public/_headers'),'utf8');const policy=headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1];if(!policy)throw new Error('Missing shipped CSP');
  await page.route('**/quote-payment-reminders-harness.html',async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'content-security-policy':policy}});});
  await page.goto(BASE);await expect(page.locator('[data-job-list] article')).toHaveCount(1);
});
test('schedules an owner alert after the old offer expires without any mail send',async({page})=>{
  await page.evaluate(()=>window.__paymentReminders.expireOffer());await open(page);await expect(form(page).locator('input[type=url]')).toHaveCount(0);
  await form(page).getByLabel('Follow-up time (your device timezone)').fill('2026-10-15T12:00');await form(page).getByRole('button',{name:'Save payment follow-up',exact:true}).click();
  await expect(page.locator('[data-payment-reminder-queue]')).toContainText('Follow-up scheduled');const calls=await page.evaluate(()=>window.__paymentReminders.calls);
  expect(calls.find(call=>call.method==='reception.signoff.payment.reminders.set')?.payload).toMatchObject({signoff_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',expected_revision:0,sender_mail_instance:'',recipient_email:''});
  expect(calls.some(call=>call.method==='execute'||call.method==='mail.drafts.create')).toBe(false);await expect(page.locator('[data-job-list]')).toContainText('120.0000 GBP outstanding');
});
test('saves a private payment draft for the selected invoice',async({page})=>{
  await review(page);const saved=await page.evaluate(()=>window.__paymentReminders.calls.find(call=>call.method==='mail.drafts.create')?.payload);
  expect(saved).toMatchObject({idempotency_key:'qpr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa_1',content:{reconciliation_id:'qpr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa_1',to:['morgan@example.test']}});
  expect(await page.evaluate(()=>window.__paymentReminders.calls.some(call=>call.method==='execute'))).toBe(false);
  await expect(page.getByRole('button',{name:'Send',exact:true})).toBeVisible();
});
test('uses the governed mail flow only after the owner chooses Send',async({page})=>{
  await review(page);await page.getByRole('button',{name:'Send',exact:true}).click();await expect.poll(async()=>page.evaluate(()=>window.__paymentReminders.calls.filter(call=>call.method==='execute').length)).toBe(1);
  const sent=await page.evaluate(()=>window.__paymentReminders.calls.find(call=>call.method==='execute')?.payload);expect(sent).toMatchObject({config:{reconciliation_id:'qpr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa_1',sender_mail_instance:'work',to:['morgan@example.test']}});
  await closeEmail(page);await toJob(page);await expect(page.locator('[data-job-list]')).toContainText('120.0000 GBP outstanding');await expect(page.locator('[data-job-list]')).toContainText('Work in progress');
});
test('snoozes and pauses the selected invoice occurrence and restores focus',async({page})=>{
  await page.evaluate(()=>window.__paymentReminders.due());const group=await queue(page);await group.getByRole('button',{name:'Snooze payment 1 day',exact:true}).click();await expect(group.locator('[data-payment-reminder-queue]')).toContainText('Follow-up scheduled');
  await group.getByRole('button',{name:'Pause payment follow-up',exact:true}).click();await expect(group.locator('[data-payment-reminder-queue]')).toContainText('No payment follow-ups');
  await expect(group.getByRole('button',{name:'Refresh payment follow-ups',exact:true})).toBeFocused();
  const calls=await page.evaluate(()=>window.__paymentReminders.calls.filter(call=>call.method==='reception.signoff.payment.reminders.set'));expect(calls.map(call=>(call.payload as {expected_revision:number}).expected_revision)).toEqual([1,2]);
});
test('prepares the current partial balance rather than the original invoice total',async({page})=>{
  await page.evaluate(()=>{window.__paymentReminders.due();window.__paymentReminders.partial();});await (await queue(page)).getByRole('button',{name:'Review payment reminder email',exact:true}).click();await expect(page.getByLabel('Subject')).toHaveValue('Payment reminder: INV-101');
  const body=await page.evaluate(()=>{const saved=window.__paymentReminders.calls.find(call=>call.method==='mail.drafts.create')?.payload as {content:{body:string}};return saved.content.body;});expect(body).toContain('100.0000 GBP recorded outstanding');expect(body).not.toContain('120.0000 GBP');
});
test('marks an existing draft stale after partial payment and refuses its Send',async({page})=>{
  await review(page);await page.evaluate(()=>window.__paymentReminders.partial());const group=page.locator('[data-customer-followup-group]').filter({hasText:'Invoice payments'});await expect(group.locator('[data-payment-reminder-queue]')).toContainText('invoice changed');await expect(group.getByRole('button',{name:'Review payment reminder email',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Send',exact:true}).click();await expect(page.getByText('The invoice changed after this draft was prepared.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Send',exact:true})).toBeVisible();await closeEmail(page);await toJob(page);await expect(page.locator('[data-job-list]')).toContainText('100.0000 GBP outstanding');
});
test('removes settled invoices from the reminder queue and blocks an old draft',async({page})=>{
  await review(page);await page.evaluate(()=>window.__paymentReminders.settle());const group=page.locator('[data-customer-followup-group]').filter({hasText:'Invoice payments'});await expect(group.getByRole('button',{name:'Review payment reminder email',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Send',exact:true}).click();await expect(page.getByText('This invoice is no longer open for follow-up.',{exact:true})).toBeVisible();
  await closeEmail(page);await toJob(page);await expect(page.getByRole('button',{name:'Follow up on payment — INV-101',exact:true})).toHaveCount(0);await expect(page.locator('[data-job-list]')).toContainText('Recorded paid in full');
});
test('preserves dirty payment edits across refresh and returns focus after closing',async({page})=>{
  await open(page);await form(page).getByLabel('Customer email (optional)',{exact:true}).fill('edited@example.test');expect(await page.evaluate(()=>window.__paymentReminders.hasUnsavedChanges())).toBe(true);
  await page.evaluate(()=>window.__paymentReminders.update());await expect(form(page).getByLabel('Customer email (optional)',{exact:true})).toHaveValue('edited@example.test');await page.getByRole('button',{name:'Close payment follow-up',exact:true}).click();
  await expect(page.getByRole('button',{name:'Follow up on payment — INV-101',exact:true})).toBeFocused();expect(await page.evaluate(()=>window.__paymentReminders.hasUnsavedChanges())).toBe(false);
});
test('keeps payment owner alerts available during a mail-account outage',async({page})=>{
  await page.evaluate(()=>window.__paymentReminders.failMail());await open(page);await expect(page.locator('[data-payment-reminder-editor]')).toContainText('owner reminders remain available');await form(page).getByRole('button',{name:'Save payment follow-up',exact:true}).click();await expect(page.locator('[data-payment-reminder-queue]')).toContainText('Follow-up scheduled');
});
test('blocks a second draft request while the first reminder composer is open',async({page})=>{
  const completion=await queue(page,'Completion requests');await review(page);await page.evaluate(()=>window.__paymentReminders.completionDue());
  // The open email is a modal dialog, so the page behind it is out of reach: dispatch, as before.
  await completion.locator('button',{hasText:'Review reminder email'}).dispatchEvent('click');
  await expect(completion).toContainText('Close the email you have open');expect(await page.evaluate(()=>window.__paymentReminders.calls.filter(call=>call.method==='mail.drafts.create').length)).toBe(1);await expect(page.getByLabel('Subject')).toHaveValue('Payment reminder: INV-101');
});
test('preserves a focused payment queue action through refresh',async({page})=>{
  await page.evaluate(()=>window.__paymentReminders.due());const edit=(await queue(page)).getByRole('button',{name:'Edit payment follow-up',exact:true});await edit.focus();await expect(edit).toBeFocused();
  const before=await reads(page,'reception.signoff.payment.reminders.list');await page.evaluate(()=>window.__paymentReminders.update());
  await expect.poll(()=>reads(page,'reception.signoff.payment.reminders.list')).toBeGreaterThan(before);await expect(edit).toBeFocused();
});
test('ignores a delayed payment read after disposal',async({page})=>{
  await openJob(page,'followups');await page.evaluate(()=>window.__paymentReminders.deferGet());await page.getByRole('button',{name:'Follow up on payment — INV-101',exact:true}).click();await expect.poll(async()=>page.evaluate(()=>window.__paymentReminders.hasInFlightWork())).toBe(true);
  await page.evaluate(()=>{window.__paymentReminders.dispose();window.__paymentReminders.release();});await expect(page.locator('[data-customer-jobs]')).toHaveCount(0);
});
test('fits the payment follow-up editor within a narrow viewport',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});await open(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await form(page).screenshot({path:info.outputPath('payment-follow-up-mobile.png')});
});

test('requires saved follow-up settings before reviewing an email and preserves edited recipients',async({page})=>{
  await page.evaluate(()=>window.__paymentReminders.due());const group=await queue(page);
  await group.getByRole('button',{name:'Edit payment follow-up',exact:true}).click();await expect(form(page).getByLabel('Follow-up time (your device timezone)')).toBeVisible();
  await form(page).getByLabel('Customer email (optional)',{exact:true}).fill('new-recipient@example.test');
  await group.getByRole('button',{name:'Review payment reminder email',exact:true}).click();
  await expect(page.locator('[data-payment-reminder-editor]')).toContainText('Save or close this follow-up before reviewing its email.');
  expect(await page.evaluate(()=>window.__paymentReminders.calls.some(call=>call.method==='reception.signoff.payment.reminders.draft'||call.method==='mail.drafts.create'))).toBe(false);
  await expect(form(page).getByLabel('Customer email (optional)',{exact:true})).toHaveValue('new-recipient@example.test');
  await form(page).getByRole('button',{name:'Save payment follow-up',exact:true}).click();
  await group.getByRole('button',{name:'Review payment reminder email',exact:true}).click();await expect(page.getByLabel('Subject')).toHaveValue('Payment reminder: INV-101');
  const saved=await page.evaluate(()=>window.__paymentReminders.calls.find(call=>call.method==='mail.drafts.create')?.payload);
  expect(saved).toMatchObject({content:{to:['new-recipient@example.test']}});
});
