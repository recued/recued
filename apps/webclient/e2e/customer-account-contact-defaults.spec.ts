import {openAccountActions} from './customer-work-driver.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect,test,type Page } from '@playwright/test';
import type {} from './harness/customer-accounts-harness.js';
import type {} from './harness/customer-account-payments-harness.js';

const BASE=(process.env.E2E_CUSTOMER_ACCOUNTS_HARNESS_URL ?? 'http://127.0.0.1:4319')+'/customer-accounts-harness.html';
const PAYMENTS=(process.env.E2E_CUSTOMER_ACCOUNT_PAYMENTS_HARNESS_URL ?? 'http://127.0.0.1:4319')+'/customer-account-payments-harness.html';
const FIELDS={ contact_name: 'Billing <img src=x onerror=alert(1)>',recipient_email: 'billing@example.test',sender_mail_instance: 'work' };
const accounts=(page: Page)=>page.locator('[data-customer-accounts]:visible');
const cards=(page: Page)=>accounts(page).locator('[data-customer-account-list] article');
const contacts=(page: Page)=>page.locator('[data-account-contact-defaults]:visible');
const statement=(page: Page)=>page.locator('[data-customer-account-statement]:visible');
const email=(page: Page)=>statement(page).getByRole('form',{ name:'Prepare account statement email',exact:true });
const reminder=(page: Page)=>page.locator('[data-account-payment-reminder-editor]');
const seed=(page: Page)=>page.evaluate(value=>window.__customerAccounts.contactDefaults(value),FIELDS);
const openAccounts=async(page: Page)=>{
  if (!await accounts(page).isVisible()) await page.getByRole('link',{ name:'Customer accounts',exact:true }).click();
  await expect(cards(page)).toHaveCount(2);await openAccountActions(page);
};
const openContact=async(page: Page,index=0)=>{
  await openAccounts(page);await cards(page).nth(index).getByRole('button',{ name:/^Edit contact defaults for / }).click();
  await expect(contacts(page)).toBeVisible();await expect(contacts(page).getByRole('button',{ name:'Refresh contact defaults',exact:true })).toBeEnabled();
};
const closeContact=async(page: Page)=>{ await contacts(page).getByRole('button',{ name:'Close contact defaults',exact:true }).click();await expect(contacts(page)).toBeHidden(); };
const openStatement=async(page: Page,index=0)=>{
  await openAccounts(page);await cards(page).nth(index).getByRole('button',{ name:/^View account statement for / }).click();
  await expect(statement(page)).toBeVisible();await expect(email(page)).toBeVisible();
};
const openReminder=async(page: Page)=>{
  await openAccounts(page);await cards(page).first().getByRole('button',{ name:/^Follow up on account payment for / }).click();
  await expect(reminder(page)).toBeVisible();await expect(reminder(page).getByRole('button',{ name:'Save account payment follow-up',exact:true })).toBeEnabled();
};
test.beforeEach(async({page})=>{
  const headers=await readFile(resolve(import.meta.dirname,'../public/_headers'),'utf8');const policy=headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1];if(!policy)throw new Error('Missing shipped CSP');
  await page.route('**/customer-account*-harness.html*',async route=>{ const response=await route.fetch();await route.fulfill({ response,headers:{ ...response.headers(),'content-security-policy':policy } }); });
  await page.goto(BASE);await expect(page.locator('[data-job-list] article')).toHaveCount(2);
});
test('keeps existing accounts blank until contact defaults are explicitly saved',async({page})=>{
  await openContact(page);await expect(contacts(page)).toContainText('No contact defaults saved yet');
  await expect(contacts(page).getByLabel('Contact name (optional)',{exact:true})).toHaveValue('');await expect(contacts(page).getByLabel('Default customer email (optional)',{exact:true})).toHaveValue('');
  await expect(contacts(page).getByLabel('Default Mail account (optional)',{exact:true})).toHaveValue('');
  expect(await page.evaluate(()=>window.__customerAccounts.calls.some(c=>c.method==='reception.accounts.contact.set'))).toBe(false);
});
test('saves contact defaults independently, restores focus and reuses them in a new statement email',async({page})=>{
  await openContact(page);await contacts(page).getByLabel('Contact name (optional)',{exact:true}).fill(FIELDS.contact_name);
  await contacts(page).getByLabel('Default customer email (optional)',{exact:true}).fill(FIELDS.recipient_email);await contacts(page).getByLabel('Default Mail account (optional)',{exact:true}).selectOption('work');
  await contacts(page).getByRole('button',{ name:'Save contact defaults',exact:true }).click();await expect(contacts(page)).toContainText('Contact defaults saved');
  const writes=await page.evaluate(()=>window.__customerAccounts.calls.filter(c=>c.method==='reception.accounts.contact.set'));expect(writes).toHaveLength(1);expect(writes[0]!.payload).toMatchObject({expected_revision:0,contact:FIELDS});
  expect(await page.evaluate(()=>window.__customerAccounts.calls.some(c=>c.method==='reception.accounts.save'||c.method==='execute'||c.method==='mail.drafts.create'))).toBe(false);
  await closeContact(page);await expect(cards(page).first().getByRole('button',{name:/^Edit contact defaults for /})).toBeFocused();
  await openStatement(page);await expect(email(page).getByLabel('Customer email',{exact:true})).toHaveValue(FIELDS.recipient_email);await expect(email(page).getByLabel('Mail account',{exact:true})).toHaveValue('work');
  await expect(statement(page)).toContainText(FIELDS.contact_name);await expect(statement(page).locator('img,script')).toHaveCount(0);
});
test('reopens saved fields and clears them only after an explicit save',async({page})=>{
  await seed(page);await openContact(page);await expect(contacts(page).getByLabel('Default customer email (optional)',{exact:true})).toHaveValue(FIELDS.recipient_email);
  await contacts(page).getByRole('button',{name:'Clear contact fields',exact:true}).click();await expect(contacts(page)).toContainText('Save to clear');
  expect(await page.evaluate(()=>window.__customerAccounts.calls.some(c=>c.method==='reception.accounts.contact.set'))).toBe(false);
  await contacts(page).getByRole('button',{name:'Save contact defaults',exact:true}).click();await expect(contacts(page)).toContainText('Contact defaults saved');await closeContact(page);
  await openStatement(page);await expect(statement(page)).toContainText('No saved contact defaults');await expect(email(page).getByLabel('Customer email',{exact:true})).toHaveValue('');await expect(email(page).getByLabel('Mail account',{exact:true})).toHaveValue('');
});
test('preserves dirty fields across board polling and guards account changes and aging',async({page})=>{
  await openContact(page);await contacts(page).getByLabel('Default customer email (optional)',{exact:true}).fill('unsaved@example.test');await page.evaluate(()=>window.__customerAccounts.update());
  await page.getByRole('link',{name:'Receivables aging',exact:true}).click();await expect(page.locator('[data-receivables-aging]')).toBeHidden();
  await accounts(page).getByRole('button',{name:'Close customer accounts',exact:true}).dispatchEvent('click');await expect(contacts(page)).toBeVisible();
  await expect(contacts(page).getByLabel('Default customer email (optional)',{exact:true})).toHaveValue('unsaved@example.test');expect(await page.evaluate(()=>window.__customerAccounts.hasUnsavedChanges())).toBe(true);
  await contacts(page).getByRole('button',{name:'Discard contact default edits',exact:true}).click();await expect(contacts(page)).toBeHidden();expect(await page.evaluate(()=>window.__customerAccounts.hasUnsavedChanges())).toBe(false);
});
test('retains edits after a failed save and recovers without touching account membership',async({page})=>{
  await openContact(page);await contacts(page).getByLabel('Default customer email (optional)',{exact:true}).fill('kept@example.test');await page.evaluate(()=>window.__customerAccounts.contactFailure('save'));
  await contacts(page).getByRole('button',{name:'Save contact defaults',exact:true}).click();await expect(contacts(page)).toContainText('could not be saved');await expect(contacts(page).getByLabel('Default customer email (optional)',{exact:true})).toHaveValue('kept@example.test');
  await page.evaluate(()=>window.__customerAccounts.contactFailure('none'));await contacts(page).getByRole('button',{name:'Save contact defaults',exact:true}).click();await expect(contacts(page)).toContainText('Contact defaults saved');
});
test('refuses a stale contact save and reloads the other client’s values after discarding',async({page})=>{
  await seed(page);await openContact(page);await contacts(page).getByLabel('Default customer email (optional)',{exact:true}).fill('mine@example.test');
  await page.evaluate(()=>window.__customerAccounts.contactDefaults({recipient_email:'winner@example.test'}));await contacts(page).getByRole('button',{name:'Save contact defaults',exact:true}).click();await expect(contacts(page)).toContainText('contact defaults changed');
  await expect(contacts(page).getByLabel('Default customer email (optional)',{exact:true})).toHaveValue('mine@example.test');await contacts(page).getByRole('button',{name:'Discard contact default edits',exact:true}).click();
  await openContact(page);await expect(contacts(page).getByLabel('Default customer email (optional)',{exact:true})).toHaveValue('winner@example.test');
});
test('fences duplicate contact saves while the first write is pending',async({page})=>{
  await openContact(page);await contacts(page).getByLabel('Default customer email (optional)',{exact:true}).fill('once@example.test');await page.evaluate(()=>window.__customerAccounts.hold('reception.accounts.contact.set'));
  await contacts(page).getByRole('button',{name:'Save contact defaults',exact:true}).click();await expect(contacts(page).getByRole('button',{name:'Close contact defaults',exact:true})).toBeDisabled();
  await contacts(page).getByRole('form',{name:'Edit account contact defaults',exact:true}).evaluate(form=>(form as HTMLFormElement).requestSubmit());
  expect(await page.evaluate(()=>window.__customerAccounts.calls.filter(c=>c.method==='reception.accounts.contact.set').length)).toBe(1);await page.evaluate(()=>window.__customerAccounts.release());await expect(contacts(page)).toContainText('Contact defaults saved');
});
test('refuses unreadable contact defaults without guessing an empty revision, then recovers',async({page})=>{
  await page.evaluate(()=>window.__customerAccounts.contactFailure('read'));await openContact(page);await expect(contacts(page)).toContainText('Contact defaults unavailable');await expect(contacts(page).getByRole('button',{name:'Save contact defaults',exact:true})).toBeDisabled();
  await page.evaluate(()=>window.__customerAccounts.contactFailure('none'));await contacts(page).getByRole('button',{name:'Refresh contact defaults',exact:true}).click();await expect(contacts(page)).toContainText('No contact defaults saved yet');
});
test('lets the owner override defaults before creating a reviewed statement draft',async({page})=>{
  await seed(page);await openStatement(page);await expect(email(page).getByLabel('Customer email',{exact:true})).toHaveValue(FIELDS.recipient_email);
  await email(page).getByLabel('Customer email',{exact:true}).fill('chosen@example.test');await email(page).getByLabel('Mail account',{exact:true}).selectOption('other');await email(page).getByRole('button',{name:'Review account statement email',exact:true}).click();
  await expect(statement(page)).toContainText('Statement draft saved');const prepared=await page.evaluate(()=>window.__customerAccounts.calls.find(c=>c.method==='reception.accounts.statement.draft')?.payload);
  expect(prepared).toMatchObject({recipient_email:'chosen@example.test',sender_mail_instance:'other'});expect(await page.evaluate(()=>window.__customerAccounts.calls.some(c=>c.method==='execute'))).toBe(false);
});
test('never overwrites manually entered recipient or sender when defaults arrive late',async({page})=>{
  await seed(page);await page.evaluate(()=>window.__customerAccounts.hold('reception.accounts.contact.get'));await openStatement(page);
  await expect.poll(()=>page.evaluate(()=>window.__customerAccounts.pending())).toBe(true);await email(page).getByLabel('Customer email',{exact:true}).fill('manual@example.test');await email(page).getByLabel('Mail account',{exact:true}).selectOption('other');
  await page.evaluate(()=>window.__customerAccounts.release());await expect(statement(page)).toContainText('Saved contact:');await expect(email(page).getByLabel('Customer email',{exact:true})).toHaveValue('manual@example.test');await expect(email(page).getByLabel('Mail account',{exact:true})).toHaveValue('other');
});
test('ignores a former account’s late defaults and starts each account with its own choices',async({page})=>{
  await seed(page);await page.evaluate(()=>{window.__customerAccounts.otherStatement();window.__customerAccounts.contactDefaults({recipient_email:'other@example.test',sender_mail_instance:'other'},'aaaaaaaa-aaaa-aaaa-aaaa-000000000101');window.__customerAccounts.hold('reception.accounts.contact.get');});
  await openStatement(page);await expect.poll(()=>page.evaluate(()=>window.__customerAccounts.pending())).toBe(true);await statement(page).getByRole('button',{name:'Close account statement',exact:true}).click();
  await openStatement(page,1);await expect(email(page).getByLabel('Customer email',{exact:true})).toHaveValue('other@example.test');await page.evaluate(()=>window.__customerAccounts.release());
  await expect(email(page).getByLabel('Customer email',{exact:true})).toHaveValue('other@example.test');await expect(email(page).getByLabel('Mail account',{exact:true})).toHaveValue('other');
  await statement(page).getByRole('button',{name:'Close account statement',exact:true}).click();await openStatement(page);await expect(email(page).getByLabel('Customer email',{exact:true})).toHaveValue(FIELDS.recipient_email);
});
test('clears the previous account contact hint while another statement loads or fails',async({page})=>{
  await seed(page);await page.evaluate(()=>window.__customerAccounts.otherStatement());await openStatement(page);
  const hint=statement(page).locator('[data-account-contact-default-status]');await expect(hint).toContainText(FIELDS.contact_name);
  await statement(page).getByRole('button',{name:'Close account statement',exact:true}).click();
  await page.evaluate(()=>window.__customerAccounts.hold('reception.accounts.statement'));await cards(page).nth(1).getByRole('button',{name:/^View account statement for /}).click();
  await expect.poll(()=>page.evaluate(()=>window.__customerAccounts.pending())).toBe(true);await expect(statement(page)).toContainText('Loading account statement');
  await expect(hint).toHaveText('');await expect(email(page)).toBeHidden();
  await page.evaluate(()=>{window.__customerAccounts.failStatement();window.__customerAccounts.release();});
  await expect(statement(page)).toContainText('needs review in Records');await expect(hint).toHaveText('');
  await expect(statement(page).getByRole('button',{name:'Download account statement',exact:true})).toBeDisabled();
});
test('retains an unavailable sender preference while asking for an available sender in new emails',async({page})=>{
  await seed(page);await page.evaluate(()=>window.__customerAccounts.contactSenderMode('missing'));await openContact(page);await expect(contacts(page).getByLabel('Default Mail account (optional)',{exact:true})).toHaveValue('work');
  await expect(contacts(page)).toContainText('saved Mail account is unavailable');await contacts(page).getByLabel('Default customer email (optional)',{exact:true}).fill('new-billing@example.test');await contacts(page).getByRole('button',{name:'Save contact defaults',exact:true}).click();await expect(contacts(page)).toContainText('Contact defaults saved');await closeContact(page);
  await openStatement(page);await expect(email(page).getByLabel('Customer email',{exact:true})).toHaveValue('new-billing@example.test');await expect(email(page).getByLabel('Mail account',{exact:true})).toHaveValue('');await expect(statement(page)).toContainText('saved Mail account is unavailable');
});
test('does not choose another sender when the preferred Mail account cannot send',async({page})=>{
  await seed(page);await page.evaluate(()=>window.__customerAccounts.contactSenderMode('read_only'));await openStatement(page);
  await expect(statement(page)).toContainText('saved Mail account is unavailable');await expect(email(page).getByLabel('Mail account',{exact:true})).toHaveValue('');await expect(email(page).getByLabel('Mail account',{exact:true}).locator('option[value=other]')).toHaveCount(1);
});
test('keeps print, download and manual email available when defaults fail to load',async({page})=>{
  await page.evaluate(()=>window.__customerAccounts.contactFailure('read'));await openStatement(page);await expect(statement(page)).toContainText('Choose the email details yourself');await expect(statement(page).getByRole('button',{name:'Download account statement',exact:true})).toBeEnabled();
  await expect(email(page).getByLabel('Customer email',{exact:true})).toHaveValue('');await email(page).getByLabel('Customer email',{exact:true}).fill('manual@example.test');await email(page).getByLabel('Mail account',{exact:true}).selectOption('work');await email(page).getByRole('button',{name:'Review account statement email',exact:true}).click();await expect(statement(page)).toContainText('Statement draft saved');
});
test('does not prefill a contact reply belonging to a different account',async({page})=>{
  await seed(page);await page.evaluate(()=>window.__customerAccounts.contactWrongAccount());await openStatement(page);await expect(statement(page)).toContainText('Choose the email details yourself');await expect(email(page).getByLabel('Customer email',{exact:true})).toHaveValue('');await expect(email(page).getByLabel('Mail account',{exact:true})).toHaveValue('');
});
test('prefills a new follow-up without saving a schedule or preparing an email',async({page})=>{
  await seed(page);await openReminder(page);await expect(reminder(page).getByLabel('Customer email (optional)',{exact:true})).toHaveValue(FIELDS.recipient_email);await expect(reminder(page).getByLabel('Mail account (optional)',{exact:true})).toHaveValue('work');
  expect(await page.evaluate(()=>window.__customerAccounts.calls.some(c=>c.method==='reception.accounts.payment.reminders.set'||c.method==='mail.drafts.create'||c.method==='execute'))).toBe(false);
});
test('keeps a saved email follow-up’s selected address after defaults change',async({page})=>{
  await page.evaluate(()=>{window.__customerAccounts.reminderDue();window.__customerAccounts.contactDefaults({recipient_email:'new@example.test',sender_mail_instance:'other'});});await openReminder(page);
  await expect(reminder(page).getByLabel('Customer email (optional)',{exact:true})).toHaveValue('morgan@example.test');await expect(reminder(page).getByLabel('Mail account (optional)',{exact:true})).toHaveValue('work');
  expect(await page.evaluate(()=>window.__customerAccounts.calls.some(c=>c.method==='reception.accounts.contact.get'))).toBe(false);
});
test('keeps a saved owner-only follow-up free of email after defaults are added',async({page})=>{
  await openReminder(page);await expect(reminder(page)).toContainText('No saved contact defaults');await reminder(page).getByRole('button',{name:'Save account payment follow-up',exact:true}).click();await expect(reminder(page)).toContainText('Follow-up saved');await reminder(page).getByRole('button',{name:'Close account payment follow-up',exact:true}).click();
  await seed(page);await openReminder(page);await expect(reminder(page).getByLabel('Customer email (optional)',{exact:true})).toHaveValue('');await expect(reminder(page).getByLabel('Mail account (optional)',{exact:true})).toHaveValue('');
});
test('does not replace edits to a new follow-up when contact defaults arrive late',async({page})=>{
  await seed(page);await page.evaluate(()=>window.__customerAccounts.hold('reception.accounts.contact.get'));await openReminder(page);
  await reminder(page).getByLabel('Customer email (optional)',{exact:true}).fill('manual@example.test');await reminder(page).getByLabel('Mail account (optional)',{exact:true}).selectOption('other');await page.evaluate(()=>window.__customerAccounts.release());
  await expect(reminder(page)).toContainText('Saved contact:');await expect(reminder(page).getByLabel('Customer email (optional)',{exact:true})).toHaveValue('manual@example.test');await expect(reminder(page).getByLabel('Mail account (optional)',{exact:true})).toHaveValue('other');
});
test('keeps saved contact metadata out of downloaded customer statements',async({page},info)=>{
  await seed(page);await openStatement(page);await expect(email(page).getByLabel('Customer email',{exact:true})).toHaveValue(FIELDS.recipient_email);
  const downloaded=page.waitForEvent('download');await statement(page).getByRole('button',{name:'Download account statement',exact:true}).click();const download=await downloaded;const path=info.outputPath('account-statement.html');await download.saveAs(path);const html=await readFile(path,'utf8');
  expect(html).not.toContain(FIELDS.recipient_email);expect(html).not.toContain('Billing &lt;img');expect(html).not.toContain('Saved contact');
});
test('prefills a recorded account payment receipt and keeps its reviewed address editable',async({page})=>{
  await page.goto(PAYMENTS);await expect(page.getByRole('heading',{name:'Morgan <studio>',exact:true})).toBeVisible();await openAccountActions(page);await page.getByRole('button',{name:'Open account payments for Morgan <studio>',exact:true}).click();const payment=page.locator('[data-customer-account-payments]');const form=payment.getByRole('form',{name:'Record customer account payment',exact:true});
  await form.getByLabel('Payment currency',{exact:true}).selectOption('GBP');await form.getByLabel('Amount received',{exact:true}).fill('50.0003');await form.getByLabel('Received on',{exact:true}).fill('2026-10-15');await form.getByLabel(/^INV-1 ·/).fill('30.0001');await form.getByLabel(/^INV-2 ·/).fill('20.0002');
  await page.evaluate(()=>window.__accountPayments.mode('success'));await form.getByRole('button',{name:'Preview account payment',exact:true}).click();await payment.getByRole('button',{name:'Review account payment',exact:true}).click();await expect(payment.getByRole('button',{name:/^View account payment receipt /})).toBeVisible();await page.evaluate(value=>window.__accountPayments.contactDefaults(value),FIELDS);
  await payment.getByRole('button',{name:/^View account payment receipt /}).click();const receipt=page.locator('[data-customer-account-payment-statement]');const mail=receipt.getByRole('form',{name:'Prepare account payment receipt email',exact:true});
  await expect(mail.getByLabel('Customer email',{exact:true})).toHaveValue(FIELDS.recipient_email);await expect(mail.getByLabel('Mail account',{exact:true})).toHaveValue('work');await mail.getByLabel('Customer email',{exact:true}).fill('chosen@example.test');await mail.getByRole('button',{name:'Review account payment receipt email',exact:true}).click();await expect(receipt).toContainText('Statement draft saved');
  expect(await page.evaluate(()=>window.__accountPayments.calls.find(c=>c.method==='reception.accounts.payment.receipt.draft')?.payload)).toMatchObject({recipient_email:'chosen@example.test',sender_mail_instance:'work'});
});
test('ignores a late contact read after the route is disposed',async({page})=>{
  await seed(page);await page.evaluate(()=>window.__customerAccounts.hold('reception.accounts.contact.get'));await openStatement(page);await expect.poll(()=>page.evaluate(()=>window.__customerAccounts.pending())).toBe(true);
  await page.evaluate(()=>{window.__customerAccounts.dispose();window.__customerAccounts.release();});await expect(page.locator('[data-customer-jobs]')).toHaveCount(0);expect(await page.evaluate(()=>window.__customerAccounts.calls.some(c=>c.method==='mail.drafts.create'||c.method==='execute'))).toBe(false);
});
test('keeps contact defaults and their source controls readable on narrow screens under the shipped CSP',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});await seed(page);await openContact(page);await expect(contacts(page).getByLabel('Contact name (optional)',{exact:true})).toHaveValue(FIELDS.contact_name);await expect(contacts(page).locator('img,script')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await contacts(page).screenshot({path:info.outputPath('account-contact-defaults-mobile.png')});
});
