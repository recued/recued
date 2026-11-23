import {expect,test,type Page} from '@playwright/test';
import {installFinancePage,goFinance,financeState,holdFinance,releaseFinance,accountRoot,accountAction,openAccountPayments,prepareFinanceAction,fillAccountSave} from './helpers/accounts-money-workspace.js';
test.beforeEach(async({page})=>installFinancePage(page));
const writes={
 'account-save':'reception.accounts.save','contact-save':'reception.accounts.contact.set','account-payment':'reception.accounts.payment.prepare','account-payment-correction':'reception.accounts.payment.correction.prepare',
 'payment-correction':'reception.signoff.payment.correction.prepare','credit':'reception.signoff.invoice.credit.prepare','credit-correction':'reception.signoff.invoice.credit.correction.prepare','refund':'reception.signoff.refund.prepare','refund-correction':'reception.signoff.refund.correction.prepare',
} as const;
for(const [kind,method] of Object.entries(writes))test(`keeps ${kind} owned after leaving its financial view`,async({page})=>{
 const submit=await prepareFinanceAction(page,kind);await expect(submit).toBeEnabled();await holdFinance(page,method);await submit.click();await expect.poll(async()=>(await financeState(page)).calls.filter(c=>c.method===method).length).toBe(1);
 const args=(await financeState(page)).calls.find(c=>c.method===method)!.args;
 if(kind==='account-save')expect(args).toEqual({account_id:'account-0',expected_revision:1,customer:'Morgan Studio accounts',job_ids:['job-1','job-2']});
 else if(kind==='contact-save')expect(args).toEqual({account_id:'account-0',expected_revision:0,contact:{contact_name:'Morgan'}});
 else if(kind==='account-payment')expect(args).toMatchObject({account_id:'account-0',expected_statement_hash:'a'.repeat(64),amount:'10.0000',allocations:[{signoff_id:'offer-1',amount:'10.0000'}]});
 else if(kind==='account-payment-correction')expect(args).toMatchObject({account_payment_id:'account-payment-1',expected_receipt_hash:'a'.repeat(64),action:'void'});
 else expect(args).toMatchObject({signoff_id:'offer-1',expected_snapshot_hash:'a'.repeat(64),...(kind==='payment-correction'?{payment_id:'P1',action:'void'}:kind==='credit-correction'?{credit_id:'credit-1',action:'reverse'}:kind==='refund-correction'?{refund_id:'refund-1',action:'reverse'}:{})});
 page.once('dialog',d=>d.accept());await page.getByRole('link',{name:'Records',exact:true}).click();await expect(page.locator('[data-customer-work]')).toHaveCount(0);
 await page.locator('[data-recued-account-menu-trigger]').click();const account=page.locator('[data-recued-account-menu-popover]');const office=account.locator('[data-recued-server-switcher-item]').filter({hasText:'Office server'});await office.click();const review=account.locator('[data-recued-server-switcher-switch-confirm]');
 await expect(review).toContainText('Work is still finishing on');await expect(review.locator('[data-recued-server-switcher-switch-commit]')).toHaveText('Switch, and check later');await releaseFinance(page);
 await review.locator('[data-recued-server-switcher-switch-cancel]').click();await office.click();await expect(review.locator('[data-recued-server-switcher-switch-commit]')).toHaveText('Switch server');expect((await financeState(page)).calls.filter(c=>c.method===method)).toHaveLength(1);await review.locator('[data-recued-server-switcher-switch-cancel]').click();await expect(office).toBeFocused();
});
async function accountFocus(page:Page){await page.locator('[data-recued-account-menu-trigger]').click();const close=page.locator('[data-recued-account-menu-close]');await close.focus();await expect(close).toBeFocused();return close;}
for(const kind of ['list','edit-account','edit-jobs','contact','save','statement','account-payments','invoice','invoice-credit','receipt','aging'] as const)test(`a delayed ${kind} result preserves later account focus`,async({page})=>{
 let ready:()=>Promise<void>;
 if(kind==='list'||kind==='aging'){
  const method=kind==='list'?'reception.accounts.list':'reception.jobs.receivables';await goFinance(page,kind==='list'?'#reception/accounts':'#reception/receivables',`finance_hold=${method}`);ready=async()=>{await expect(page.locator(kind==='list'?'[data-customer-account-list]>article':'[data-aging-rows]>article')).toHaveCount(kind==='list'?8:2);};
 }else if(kind==='edit-account'||kind==='edit-jobs'){
  await goFinance(page);const trigger=await accountAction(page,'edit');await holdFinance(page,kind==='edit-account'?'reception.accounts.get':'reception.jobs.list');await trigger.click();ready=async()=>{await expect(accountRoot(page).getByLabel('Customer account name',{exact:true})).toBeEnabled();await expect(page.locator('[data-account-job-choices] input')).toHaveCount(6);};
 }else if(kind==='save'){
  await goFinance(page);const submit=await fillAccountSave(page);await holdFinance(page,'reception.accounts.save');await submit.click();ready=async()=>{await expect(page.locator('[data-customer-account-list]>article').filter({hasText:'Morgan Studio accounts'})).toBeVisible();};
 }else if(kind==='contact'||kind==='statement'||kind==='account-payments'){
  await goFinance(page);const action=kind==='account-payments'?'payments':kind;const trigger=await accountAction(page,action);await holdFinance(page,kind==='contact'?'reception.accounts.contact.get':'reception.accounts.statement');await trigger.click();ready=async()=>{if(kind==='contact')await expect(page.getByLabel('Contact name (optional)',{exact:true})).toBeEnabled();else if(kind==='account-payments')await expect(page.getByLabel('Amount received',{exact:true})).toBeEnabled();else await expect(page.getByRole('button',{name:'Download account statement',exact:true})).toBeEnabled();};
 }else{
  await goFinance(page,'#reception/jobs/job-1/billing');await page.getByRole('button',{name:'View payment history — INV-1',exact:true}).waitFor();
  if(kind==='receipt'){
   await page.getByRole('button',{name:'View payment history — INV-1',exact:true}).click();const trigger=page.locator('[data-payment-history-entries]').getByRole('button',{name:'View payment receipt',exact:true});await expect(trigger).toBeEnabled();await holdFinance(page,'reception.signoff.payment.receipt');await trigger.click();ready=async()=>{await expect(page.getByRole('button',{name:'Download payment receipt',exact:true})).toBeEnabled();};
  }else{
   await holdFinance(page,'reception.signoff.payment.history');await page.getByRole('button',{name:kind==='invoice-credit'?'Issue credit — INV-1':'View payment history — INV-1',exact:true}).click();ready=async()=>{if(kind==='invoice-credit')await expect(page.getByRole('button',{name:'Preview invoice credit',exact:true})).toBeEnabled();else await expect(page.locator('[data-payment-history-entries]>article')).toHaveCount(1);};
  }
 }
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).__financeWorkspace.release)).toBe('function');const close=await accountFocus(page);await releaseFinance(page);await ready!();await expect(close).toBeFocused();await close.click();await expect(page.locator('[data-recued-account-menu-trigger]')).toBeFocused();
});
