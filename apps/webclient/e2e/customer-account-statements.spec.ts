import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import {openAccountActions} from './customer-work-driver.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect,test,type Page } from '@playwright/test';
import type {} from './harness/customer-accounts-harness.js';

const BASE = `${process.env.E2E_CUSTOMER_ACCOUNTS_HARNESS_URL ?? HARNESS_ORIGIN}/customer-accounts-harness.html`;
const panel = (page: Page) => page.locator('[data-customer-accounts]:visible');
const editor = (page: Page) => panel(page).getByRole('form',{ name: 'Edit customer account' });
const view = (page: Page) => panel(page).locator('[data-customer-account-statement]:visible');
const email = (page: Page) => view(page).getByRole('form',{ name: 'Prepare account statement email' });
const open = async (page: Page) => {
  await page.getByRole('link',{ name: 'Customer accounts',exact: true }).click();
  await expect(panel(page).locator('[data-customer-account-list] article')).toHaveCount(2);await openAccountActions(page);
};
const edit = async (page: Page) => {
  await open(page);await panel(page).getByRole('button',{ name: /^Edit account Morgan/ }).click();
  await expect(editor(page).getByRole('button',{ name: 'Find customer jobs',exact: true })).toBeEnabled();
};
const statement = async (page: Page) => {
  await open(page);await panel(page).getByRole('button',{ name: /^View account statement for Morgan/ }).click();
  await expect(view(page).getByRole('button',{ name: 'Download account statement',exact: true })).toBeEnabled();
};
const review = async (page: Page) => {
  await statement(page);await email(page).getByLabel('Customer email',{ exact: true }).fill('morgan@example.test');
  await email(page).getByLabel('Mail account',{ exact: true }).selectOption('work');
  await email(page).getByRole('button',{ name: 'Review account statement email',exact: true }).click();
  await expect(page.getByRole('textbox',{ name: 'Subject',exact: true })).toHaveValue(/^Customer account statement:/);
};
test.beforeEach(async ({ page }) => {
  const headers = await readFile(resolve(import.meta.dirname,'../public/_headers'),'utf8');
  const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1];if (!policy) throw new Error('Missing shipped CSP');
  await page.route('**/customer-accounts-harness.html',async route => {
    const response = await route.fetch();await route.fulfill({ response,headers: { ...response.headers(),'content-security-policy': policy } });
  });
  await page.goto(BASE);await expect(page.locator('[data-job-list] article')).toHaveCount(2);
});
test('opens accounts on demand and keeps same-named unlinked jobs out of the statement',async ({ page }) => {
  expect(await page.evaluate(() => window.__customerAccounts.calls.some(call => call.method.startsWith('reception.accounts.')))).toBe(false);
  await statement(page);const copy = view(page).locator('[data-account-statement-copy]');
  await expect(copy).toContainText('2 linked jobs');await expect(copy).toContainText('Job: Job 1');await expect(copy).toContainText('Job: Job 2');await expect(copy).not.toContainText('Job: Job 3');
  await expect(copy).toContainText('Currency: GBP');await expect(copy).toContainText('Currency: EUR');
  await expect(copy).toContainText('Customer still owes: 90.0000 GBP');await expect(copy).toContainText('Refund still owed to customer: 8.0000 GBP');
  expect(await page.evaluate(() => window.__customerAccounts.calls.some(call => call.method === 'execute' || call.method === 'mail.drafts.create'))).toBe(false);
});
test('requires explicit confirmation before saving the chosen jobs',async ({ page }) => {
  await edit(page);await editor(page).getByLabel('Customer account name',{ exact: true }).fill('Morgan studio');
  await expect(editor(page).getByRole('button',{ name: 'Save customer account',exact: true })).toBeDisabled();
  await editor(page).getByLabel('I confirm these jobs belong to this customer account.').check();
  await editor(page).getByRole('button',{ name: 'Save customer account',exact: true }).click();
  await expect(panel(page).getByRole('heading',{ name: 'Morgan studio',exact: true })).toBeVisible();
  const input = await page.evaluate(() => window.__customerAccounts.calls.find(call => call.method === 'reception.accounts.save')?.payload);
  expect(input).toEqual({ account_id: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000100',expected_revision: 1,customer: 'Morgan studio',job_ids: ['aaaaaaaa-aaaa-aaaa-aaaa-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-000000000002'] });
});
test('retains selected jobs across job pages and explicitly creates a distinct account',async ({ page }) => {
  await open(page);await panel(page).getByRole('button',{ name: 'New customer account',exact: true }).click();
  await editor(page).getByLabel('Customer account name',{ exact: true }).fill('Another Morgan');
  await editor(page).getByRole('button',{ name: 'More jobs to link',exact: true }).click();
  await editor(page).locator('[data-account-job-choices]').getByRole('checkbox').check();
  await expect(editor(page).getByLabel('Selected account jobs')).toContainText('Job 3');
  await editor(page).getByLabel('I confirm these jobs belong to this customer account.').check();
  await editor(page).getByRole('button',{ name: 'Save customer account',exact: true }).click();
  await expect(panel(page).getByRole('heading',{ name: 'Another Morgan',exact: true })).toBeVisible();
  const payload = await page.evaluate(() => window.__customerAccounts.calls.find(call => call.method === 'reception.accounts.save')!.payload as { expected_revision: number;job_ids: string[] });
  expect(payload.expected_revision).toBe(0);expect(payload.job_ids).toEqual(['aaaaaaaa-aaaa-aaaa-aaaa-000000000003']);
});
test('does not lose the existing selection when a job search returns a subset',async ({ page }) => {
  await edit(page);await editor(page).getByLabel('Search jobs to link',{ exact: true }).fill('Job 2');
  await editor(page).getByRole('button',{ name: 'Find customer jobs',exact: true }).click();
  await expect(editor(page).locator('[data-account-job-choices] input')).toHaveCount(1);
  await expect(editor(page).getByLabel('Selected account jobs')).toContainText('2 selected jobs');
});
test('keeps dirty fields and focus across board refresh and blocks account navigation until discarded',async ({ page }) => {
  await edit(page);const name = editor(page).getByLabel('Customer account name',{ exact: true });await name.fill('Retained edit');
  await page.evaluate(() => window.__customerAccounts.update());await expect(name).toHaveValue('Retained edit');await expect(name).toBeFocused();
  expect(await page.evaluate(() => window.__customerAccounts.hasUnsavedChanges())).toBe(true);
  await page.getByRole('link',{name:'Jobs',exact:true}).click();await expect(name).toHaveValue('Retained edit');
  await editor(page).getByRole('button',{ name: 'Discard account edits',exact: true }).click();
  expect(await page.evaluate(() => window.__customerAccounts.hasUnsavedChanges())).toBe(false);
});
test('retains edits when the saved account changed instead of overwriting it',async ({ page }) => {
  await edit(page);await editor(page).getByLabel('Customer account name',{ exact: true }).fill('Keep this change');
  await editor(page).getByLabel('I confirm these jobs belong to this customer account.').check();await page.evaluate(() => window.__customerAccounts.failSave());
  await editor(page).getByRole('button',{ name: 'Save customer account',exact: true }).click();await expect(panel(page)).toContainText('The account changed');
  await expect(editor(page).getByLabel('Customer account name',{ exact: true })).toHaveValue('Keep this change');
  expect(await page.evaluate(() => window.__customerAccounts.hasUnsavedChanges())).toBe(true);
});
test('prevents double saving while a save is pending and reports route work',async ({ page }) => {
  await edit(page);await editor(page).getByLabel('Customer account name',{ exact: true }).fill('One save');
  await editor(page).getByLabel('I confirm these jobs belong to this customer account.').check();await page.evaluate(() => window.__customerAccounts.hold('reception.accounts.save'));
  await editor(page).getByRole('button',{ name: 'Save customer account',exact: true }).click();
  await expect(editor(page).getByRole('button',{ name: 'Save customer account',exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__customerAccounts.hasInFlightWork())).toBe(true);
  await editor(page).evaluate(form => (form as HTMLFormElement).requestSubmit());await page.evaluate(() => window.__customerAccounts.release());
  await expect(editor(page)).toBeHidden();expect(await page.evaluate(() => window.__customerAccounts.calls.filter(call => call.method === 'reception.accounts.save').length)).toBe(1);
});
test('can remove every job without deleting its invoice history and disables an empty statement',async ({ page }) => {
  await edit(page);const chosen = editor(page).getByLabel('Selected account jobs');
  while (await chosen.getByRole('button').count()) await chosen.getByRole('button').first().click();
  await editor(page).getByLabel('I confirm these jobs belong to this customer account.').check();await editor(page).getByRole('button',{ name: 'Save customer account',exact: true }).click();
  await expect(editor(page)).toBeHidden();await openAccountActions(page);await expect(panel(page).getByRole('button',{ name: /^View account statement for Morgan/ })).toBeDisabled();
  await page.getByRole('link',{name:'Jobs',exact:true}).click();await expect(page.locator('[data-job-list] article')).toHaveCount(2);
});
test('downloads an escaped, complete offline account statement under the shipped CSP',async ({ page },info) => {
  const errors: string[] = [];page.on('pageerror',error => errors.push(error.message));await statement(page);
  const pending = page.waitForEvent('download');await view(page).getByRole('button',{ name: 'Download account statement',exact: true }).click();
  const download = await pending;expect(download.suggestedFilename()).toMatch(/^account-statement-[a-f0-9]{16}\.html$/);
  const html = await readFile((await download.path())!,'utf8');expect(html).toContain('&lt;img src=x');expect(html).toContain('&lt;script&gt;alert(1)');
  expect(html).toContain("default-src 'none'");expect(html).toContain('Invoice INV-1');expect(html).toContain('Invoice INV-2');expect(html).not.toMatch(/PRIVATE|<script|<img/);
  await view(page).screenshot({ path: info.outputPath('account-statement.png') });expect(errors).toEqual([]);
});
test('prints the isolated copy and restores focus to the current account action',async ({ page }) => {
  await page.addInitScript(() => { window.print = () => document.documentElement.setAttribute('data-print-called','true'); });await page.goto(BASE);await statement(page);
  await view(page).getByRole('button',{ name: 'Print account statement / save PDF',exact: true }).click();
  const frame = page.frameLocator('[data-account-statement-print]');await expect(frame.locator('html')).toHaveAttribute('data-print-called','true');
  await expect(frame.locator('body')).toContainText('Invoice INV-2');await expect(frame.locator('script,img')).toHaveCount(0);
  await view(page).getByRole('button',{ name: 'Close account statement',exact: true }).click();await expect(page.locator('[data-account-statement-print]')).toHaveCount(0);
  await expect(panel(page).getByRole('button',{ name: /^View account statement for Morgan/ })).toBeFocused();
});
test('keeps exports available when Mail cannot load',async ({ page }) => {
  await page.evaluate(() => window.__customerAccounts.failMail());await statement(page);await expect(view(page)).toContainText('Mail accounts could not be loaded');
  await expect(email(page)).toBeHidden();await expect(view(page).getByRole('button',{ name: 'Download account statement',exact: true })).toBeEnabled();
});
test('allows close while Mail is pending and ignores the late response',async ({ page }) => {
  await page.evaluate(() => window.__customerAccounts.hold('mail.accounts'));await statement(page);await expect.poll(() => page.evaluate(() => window.__customerAccounts.pending())).toBe(true);
  expect(await page.evaluate(() => window.__customerAccounts.hasInFlightWork())).toBe(false);
  await view(page).getByRole('button',{ name: 'Close account statement',exact: true }).click();await page.evaluate(() => window.__customerAccounts.release());await expect(view(page)).toBeHidden();
});
test('rejects incomplete account copies and does not retain an old export after refresh fails',async ({ page }) => {
  await statement(page);await page.evaluate(() => window.__customerAccounts.failStatement());await view(page).getByRole('button',{ name: 'Refresh account statement',exact: true }).click();
  await expect(view(page)).toContainText('needs review in Records');await expect(view(page).getByRole('button',{ name: 'Download account statement',exact: true })).toBeDisabled();
  await expect(view(page).locator('[data-account-statement-copy]')).toBeEmpty();
});
test('rejects a response belonging to another account',async ({ page }) => {
  await page.evaluate(() => window.__customerAccounts.invalid());await open(page);await panel(page).getByRole('button',{ name: /^View account statement for Morgan/ }).click();
  await expect(view(page)).toContainText('does not match the selected job or account');await expect(view(page).getByRole('button',{ name: 'Download account statement',exact: true })).toBeDisabled();
});
test('prepares a private draft without sending and preserves the normal owner review',async ({ page }) => {
  await review(page);expect(await page.evaluate(() => window.__customerAccounts.calls.some(call => call.method === 'execute'))).toBe(false);
  await page.getByRole('button',{ name: 'Send',exact: true }).click();await expect.poll(() => page.evaluate(() => window.__customerAccounts.calls.filter(call => call.method === 'execute').length)).toBe(1);await expect(page.getByRole('dialog')).toBeHidden();
});
test('rechecks the account before preparing email and keeps the recipient after refusal',async ({ page }) => {
  await statement(page);await email(page).getByLabel('Customer email',{ exact: true }).fill('morgan@example.test');await email(page).getByLabel('Mail account',{ exact: true }).selectOption('work');
  await page.evaluate(() => window.__customerAccounts.change());await email(page).getByRole('button',{ name: 'Review account statement email',exact: true }).click();
  await expect(view(page)).toContainText('records changed');await expect(email(page).getByLabel('Customer email',{ exact: true })).toHaveValue('morgan@example.test');
  expect(await page.evaluate(() => window.__customerAccounts.calls.some(call => call.method === 'mail.drafts.create'))).toBe(false);
});
test('blocks Send after a linked job or selection changes',async ({ page }) => {
  await page.evaluate(() => window.__customerAccounts.sendSuccess());await review(page);await page.evaluate(() => window.__customerAccounts.change());
  await page.getByRole('button',{ name: 'Send',exact: true }).click();await expect(page.getByRole('alert')).toContainText('records changed');
});
test('keeps the account email when leaving its workspace is cancelled',async({page})=>{
 await review(page);await page.getByRole('link',{name:'Jobs',exact:true}).dispatchEvent('click');await expect(page.getByRole('textbox',{name:'Subject',exact:true})).toHaveValue(/^Customer account statement:/);expect(await page.evaluate(()=>window.__customerAccounts.calls.some(c=>c.method==='reception.jobs.payment.statement.draft'))).toBe(false);
});
test('blocks refresh that would discard statement email edits',async ({ page }) => {
  await statement(page);await email(page).getByLabel('Customer email',{ exact: true }).fill('retain@example.test');await page.evaluate(() => window.__customerAccounts.update());
  await view(page).getByRole('button',{ name: 'Refresh account statement',exact: true }).click();await expect(view(page)).toContainText('Review or close this statement email');
  await expect(email(page).getByLabel('Customer email',{ exact: true })).toHaveValue('retain@example.test');
});
test('retains loaded accounts on a failed refresh and retries successfully',async ({ page }) => {
  await open(page);await page.evaluate(() => window.__customerAccounts.failList(true));await panel(page).getByRole('button',{ name: 'Refresh customer accounts',exact: true }).click();
  await expect(panel(page)).toContainText('Previously loaded accounts remain visible');await expect(panel(page).locator('[data-customer-account-list] article')).toHaveCount(2);await openAccountActions(page);
  await page.evaluate(() => window.__customerAccounts.failList(false));await panel(page).getByRole('button',{ name: 'Refresh customer accounts',exact: true }).click();await expect(panel(page)).toContainText('2 customer accounts on this page.');
});
test('pages all account identities and returns to the prior page',async ({ page }) => {
  await page.evaluate(() => window.__customerAccounts.many());await page.getByRole('link',{ name: 'Customer accounts',exact: true }).click();await expect(panel(page).locator('[data-customer-account-list] article')).toHaveCount(25);
  await panel(page).getByRole('button',{ name: 'More accounts',exact: true }).click();await expect(panel(page).locator('[data-customer-account-list] article')).toHaveCount(5);
  await panel(page).getByRole('button',{ name: 'Previous accounts',exact: true }).click();await expect(panel(page).locator('[data-customer-account-list] article')).toHaveCount(25);
});
test('ignores a late statement after disposal and releases route work',async ({ page }) => {
  await open(page);await page.evaluate(() => window.__customerAccounts.hold('reception.accounts.statement'));await panel(page).getByRole('button',{ name: /^View account statement for Morgan/ }).click();
  await expect.poll(() => page.evaluate(() => window.__customerAccounts.pending())).toBe(true);expect(await page.evaluate(() => window.__customerAccounts.hasInFlightWork())).toBe(true);
  await page.evaluate(() => { window.__customerAccounts.dispose();window.__customerAccounts.release(); });await expect(page.locator('[data-customer-jobs]')).toHaveCount(0);
});
test('fits a narrow viewport without hiding customer balances or controls',async ({ page }) => {
  await page.setViewportSize({ width: 390,height: 844 });await statement(page);await expect(view(page)).toContainText('Customer still owes: 90.0000 EUR');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const outcome of ['cancel','send'] as const) test(`unlocks account controls after the statement email closes by ${outcome}`,async ({ page }) => {
  if (outcome === 'send') await page.evaluate(() => window.__customerAccounts.sendSuccess());await review(page);
  await page.getByRole('dialog').getByRole('button',{ name: outcome === 'send' ? 'Send' : 'Cancel',exact: true }).click();await expect(page.getByRole('dialog')).toBeHidden();
  await expect(email(page).getByRole('button',{ name: 'Review account statement email',exact: true })).toBeEnabled();
  await view(page).getByRole('button',{ name: 'Close account statement',exact: true }).click();
  await panel(page).getByRole('button',{ name: 'Close customer accounts',exact: true }).click();await expect(page.getByRole('heading',{name:'Customer jobs',exact:true})).toBeFocused();
});


test.describe('saved account access',() => {
  test('returns focus to a direct saved statement action after an account edit',async ({ page }) => {
    await edit(page);await editor(page).getByLabel('Customer account name',{ exact: true }).fill('Renamed saved account');
    await editor(page).getByLabel('I confirm these jobs belong to this customer account.').check();
    await editor(page).getByRole('button',{ name: 'Save customer account',exact: true }).click();
    const saved = panel(page).getByRole('region',{ name: 'Saved customer account',exact: true });
    await expect(saved).toContainText('Renamed saved account');
    await expect(saved.getByRole('button',{ name: 'View saved account statement',exact: true })).toBeFocused();
    await saved.getByRole('button',{ name: 'View saved account statement',exact: true }).click();
    await expect(view(page)).toContainText('Customer account statement — Renamed saved account');
    await view(page).getByRole('button',{ name: 'Close account statement',exact: true }).click();
    await expect(saved.getByRole('button',{ name: 'View saved account statement',exact: true })).toBeFocused();
  });
  for (const failedRefresh of [false,true]) test(`keeps a new account reachable when saved outside its current page (${failedRefresh ? 'failed refresh' : 'successful refresh'})`,async ({ page }) => {
    await page.evaluate(() => {
      Object.defineProperty(crypto,'randomUUID',{ configurable: true,value: () => '00000000-0000-0000-0000-000000000001' });
      window.__customerAccounts.many();
    });
    await page.getByRole('link',{ name: 'Customer accounts',exact: true }).click();
    await expect(panel(page).locator('[data-customer-account-list] article')).toHaveCount(25);
    await panel(page).getByRole('button',{ name: 'More accounts',exact: true }).click();
    await expect(panel(page).locator('[data-customer-account-list] article')).toHaveCount(5);
    await panel(page).getByRole('button',{ name: 'New customer account',exact: true }).click();
    await editor(page).getByLabel('Customer account name',{ exact: true }).fill('Created from later page');
    await editor(page).getByRole('button',{ name: 'More jobs to link',exact: true }).click();
    await editor(page).locator('[data-account-job-choices]').getByRole('checkbox').check();
    await editor(page).getByLabel('I confirm these jobs belong to this customer account.').check();
    if (failedRefresh) await page.evaluate(() => window.__customerAccounts.failList(true));
    await editor(page).getByRole('button',{ name: 'Save customer account',exact: true }).click();
    const saved = panel(page).getByRole('region',{ name: 'Saved customer account',exact: true });
    await expect(saved).toContainText('Created from later page');
    await expect(panel(page).locator('[data-customer-account-list] article')).toHaveCount(5);
    const action = saved.getByRole('button',{ name: 'View saved account statement',exact: true });await expect(action).toBeFocused();
    await action.click();await expect(view(page)).toContainText('Job: Job 3');
    await expect(view(page)).toContainText('Customer account statement — Created from later page');
    expect(await page.evaluate(() => window.__customerAccounts.calls.filter(call => call.method === 'reception.accounts.save').length)).toBe(1);
  });
});


test('keeps an empty saved account editable and focuses its saved identity',async ({ page }) => {
  await edit(page);const selected = editor(page).getByLabel('Selected account jobs');
  while (await selected.getByRole('button').count()) await selected.getByRole('button').first().click();
  await editor(page).getByLabel('I confirm these jobs belong to this customer account.').check();
  await editor(page).getByRole('button',{ name: 'Save customer account',exact: true }).click();
  const saved = panel(page).getByRole('region',{ name: 'Saved customer account',exact: true });await expect(saved).toBeFocused();
  await expect(saved.getByRole('button',{ name: 'View saved account statement',exact: true })).toBeDisabled();
  await saved.getByRole('button',{ name: 'Edit saved customer account',exact: true }).click();
  await expect(editor(page).getByLabel('Selected account jobs')).toContainText('0 selected jobs');
  await expect(editor(page).getByLabel('Customer account name',{ exact: true })).toHaveValue(/^Morgan/);
});
test('returns from a saved statement to its current account editor after reopening edits',async ({ page }) => {
  await edit(page);await editor(page).getByLabel('Customer account name',{ exact: true }).fill('Editable saved account');
  await editor(page).getByLabel('I confirm these jobs belong to this customer account.').check();
  await editor(page).getByRole('button',{ name: 'Save customer account',exact: true }).click();
  const saved = panel(page).getByRole('region',{ name: 'Saved customer account',exact: true });
  await saved.getByRole('button',{ name: 'View saved account statement',exact: true }).click();
  await expect(view(page).getByRole('button',{ name: 'Download account statement',exact: true })).toBeEnabled();
  await saved.getByRole('button',{ name: 'Edit saved customer account',exact: true }).click();
  await expect(editor(page).getByRole('button',{ name: 'Find customer jobs',exact: true })).toBeEnabled();
  await view(page).getByRole('button',{ name: 'Close account statement',exact: true }).click();
  await expect(editor(page).getByLabel('Customer account name',{ exact: true })).toBeFocused();
});
