import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HARNESS_ORIGIN } from './harness-origin.js';
import { installCustomerWorkFixture } from '../fixtures/customer-work.js';
import { installAccountsMoneyWorkspaceFixture } from '../fixtures/accounts-money-workspace.js';
export const financeRoot = (page: Page) => page.locator('[data-customer-work]');
export const accountRoot = (page: Page) => page.locator('[data-customer-accounts]:visible');
export const financeState = (page: Page) => page.evaluate(() => (window as any).__financeWorkspace as {calls:Array<{method:string;args:Record<string,unknown>}>});
export const holdFinance = (page: Page, method: string) => page.evaluate(method => { (window as any).__financeWorkspace.hold=method; },method);
export const releaseFinance = (page: Page) => page.evaluate(() => (window as any).__financeWorkspace.release?.());
export async function installFinancePage(page: Page) {
  await page.addInitScript({content:`(${installCustomerWorkFixture.toString()})();(${installAccountsMoneyWorkspaceFixture.toString()})();`});
  const policy=(await readFile(resolve(import.meta.dirname,'../../public/_headers'),'utf8')).match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
  await page.route('**/full-app-harness.html*',async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'content-security-policy':policy}});});
}
export async function goFinance(page: Page, hash='#reception/accounts', extra='') {
  await page.goto(`${HARNESS_ORIGIN}/full-app-harness.html?jobs=6&server_profiles=multiple${extra?'&'+extra:''}${hash}`);
  await page.locator('[data-recued-reception-route-tabs]').waitFor();
}
export async function accountAction(page: Page, kind:'edit'|'contact'|'payments'|'statement'|'followup') {
  const cards=accountRoot(page).locator('[data-customer-account-list]>article');await expect(cards).toHaveCount(8);const card=cards.first();const details=card.locator('details');if(!await details.evaluate(n=>(n as HTMLDetailsElement).open))await details.locator('summary').click();
  return card.getByRole('button',{name:{edit:'Edit account Morgan Studio',contact:'Edit contact defaults for Morgan Studio',payments:'Open account payments for Morgan Studio',statement:'View account statement for Morgan Studio',followup:'Follow up on account payment for Morgan Studio'}[kind],exact:true});
}
export async function openAccountPayments(page: Page) {
  await (await accountAction(page,'payments')).click();const root=page.locator('[data-customer-account-payments]:visible');await expect(root.getByLabel('Amount received',{exact:true})).toBeEnabled();return root;
}
export async function openFinanceInvoice(page: Page, section:'Payments'|'Credits'|'Refunds'|'Documents'='Payments', shortcut=false, extra='') {
  await goFinance(page,'#reception/jobs/job-1/billing',extra);
  await page.getByRole('button',{name:shortcut?'Issue credit — INV-1':'View payment history — INV-1',exact:true}).click();const root=page.locator('[data-customer-payment-history]:visible');
  if(!shortcut){await expect(root.locator('[data-payment-history-entries]>article')).toHaveCount(1);if(section!=='Payments')await root.getByRole('navigation',{name:'Invoice billing sections'}).getByRole('button',{name:section,exact:true}).click();}
  return root;
}
export async function fillAccountSave(page: Page) {
  await (await accountAction(page,'edit')).click();const form=accountRoot(page).getByRole('form',{name:'Edit customer account',exact:true});await expect(form.getByLabel('Customer account name')).toBeEnabled();await form.getByLabel('Customer account name').fill('Morgan Studio accounts');await form.getByRole('checkbox',{name:'I confirm these jobs belong to this customer account.',exact:true}).check();return form.getByRole('button',{name:'Save customer account',exact:true});
}
export async function prepareFinanceAction(page: Page, kind:string) {
  if(kind==='account-save'){await goFinance(page);return fillAccountSave(page);}
  if(kind==='contact-save'){await goFinance(page);await (await accountAction(page,'contact')).click();const form=page.getByRole('form',{name:'Edit account contact defaults',exact:true});await expect(form.getByLabel('Contact name (optional)',{exact:true})).toBeEnabled();await form.getByLabel('Contact name (optional)',{exact:true}).fill('Morgan');return form.getByRole('button',{name:'Save contact defaults',exact:true});}
  if(kind.startsWith('account-payment')){
    await goFinance(page);const payments=await openAccountPayments(page);
    if(kind==='account-payment') {await payments.getByLabel('Amount received',{exact:true}).fill('10.0000');await payments.getByLabel('Received on',{exact:true}).fill('2026-11-22');await payments.locator('[data-account-payment-invoice]').first().fill('10.0000');return payments.getByRole('button',{name:'Preview account payment',exact:true});}
    await payments.getByRole('button',{name:'Correct account payment account-payment-1',exact:true}).click();const form=page.getByRole('form',{name:'Correct customer account payment',exact:true});await expect(form.getByRole('combobox',{name:'Account correction action',exact:true})).toBeEnabled();await form.getByRole('combobox',{name:'Account correction action',exact:true}).selectOption('void');await form.getByLabel('Reason for account payment correction',{exact:true}).fill('Duplicate recorded payment.');return form.getByRole('button',{name:'Preview account payment correction',exact:true});
  }
  const section=kind.startsWith('credit')?'Credits':kind.startsWith('refund')?'Refunds':'Payments';const invoice=await openFinanceInvoice(page,section,false,kind==='payment-correction'?'finance_unlinked_payment=1':'');
  if(kind==='payment-correction'){await invoice.getByRole('button',{name:'Correct recorded payment',exact:true}).click();const form=page.getByRole('form',{name:'Correct recorded payment',exact:true});await form.getByRole('combobox',{name:'Correction action',exact:true}).selectOption('void');await form.getByLabel('Reason for correction',{exact:true}).fill('Duplicate recorded payment.');return form.getByRole('button',{name:'Preview payment correction',exact:true});}
  if(kind==='credit'){await invoice.getByRole('button',{name:'Issue invoice credit',exact:true}).click();const form=invoice.getByRole('form',{name:'Issue invoice credit',exact:true});await form.getByLabel('Credit amount',{exact:true}).fill('10.0000');await form.getByLabel('Credit reason (shown on customer copy)',{exact:true}).fill('Reduced drawing scope.');return form.getByRole('button',{name:'Preview invoice credit',exact:true});}
  if(kind==='credit-correction'){await invoice.getByRole('button',{name:'Correct invoice credit',exact:true}).click();const form=invoice.getByRole('form',{name:'Correct invoice credit',exact:true});await form.getByLabel('Reverse date',{exact:true}).fill('2026-11-22');await form.getByLabel('Reason for correction (shown on customer copies)',{exact:true}).fill('Duplicate credit entry.');return form.getByRole('button',{name:'Preview credit correction',exact:true});}
  if(kind==='refund'){await invoice.getByRole('button',{name:'Manage refunds and receipts',exact:true}).click();const form=invoice.getByRole('form',{name:'Customer refund entry',exact:true});await form.getByRole('combobox',{name:'Original payment (this history page)',exact:true}).selectOption('P1');await form.getByLabel('Refund or paid credit amount',{exact:true}).fill('1.0000');await form.getByLabel('Entry date',{exact:true}).fill('2026-11-22');await form.getByLabel('Reason (shown on customer copies)',{exact:true}).fill('Recorded customer adjustment.');return form.getByRole('button',{name:'Preview refund entry',exact:true});}
  await invoice.getByRole('button',{name:'Manage refunds and receipts',exact:true}).click();await invoice.getByRole('button',{name:'Close refund entry',exact:true}).click();await invoice.getByRole('button',{name:'Correct a recorded refund',exact:true}).click();const form=invoice.getByRole('form',{name:'Correct recorded refund',exact:true});await form.getByRole('combobox',{name:'Refund to correct',exact:true}).selectOption('refund-1');await form.getByLabel('Refund reversal date',{exact:true}).fill('2026-11-22');await form.getByLabel('Refund correction reason (shown on customer copies)',{exact:true}).fill('Duplicate refund entry.');return form.getByRole('button',{name:'Preview refund correction',exact:true});
}
