import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installCustomerWorkFixture } from './fixtures/customer-work.js';
const BASE = `${HARNESS_ORIGIN}/full-app-harness.html`;
const pane = (page: Page) => page.locator('[data-recued-webclient-content]');
const jobNav = (page: Page) => page.getByRole('navigation', { name: 'Job sections', exact: true });
const board = (page: Page) => page.locator('[data-jobs-board]:visible');
const go = async (page: Page, hash = '#reception/jobs', count = 63) => {
    await page.goto(`${BASE}?jobs=${count}${hash}`);
    await page.locator('[data-recued-reception-route-tabs]').waitFor();
};
const calls = (page: Page) => page.evaluate(() => (window as any).__customerUxCalls as Array<{
    method: string;
    args: Record<string, unknown>;
}>);
const inViewport = async (page: Page, selector: string) => {
    const box = await page.locator(selector).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
};
test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCustomerWorkFixture);
    const headers = await readFile(resolve(import.meta.dirname, '../public/_headers'), 'utf8');
    const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
    await page.route('**/full-app-harness.html*', async (route) => { const response = await route.fetch(); await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } }); });
});
test('keeps a fifty-job board compact and separates working navigation from setup', async ({ page }) => {
    await go(page);
    await expect(board(page).locator('.job-summary')).toHaveCount(50);
    const first = board(page).locator('.job-summary').first();
    await expect(first.locator('button,a,summary')).toHaveCount(2);
    await expect(first).toContainText('Due 2026-10-10');
    await expect(page.getByRole('navigation', { name: 'Customer work', exact: true })).toBeVisible();
    await expect(page.locator('[data-recued-reception-route-tabs] a')).toHaveText(['Inbox', 'Customer work', 'Records', 'Manage']);
    expect((await first.boundingBox())!.y).toBeLessThan(700);
    expect((await calls(page)).some(c => c.method === 'execute' || c.method.endsWith('.reminders.list'))).toBe(false);
});
test('hydrates the exact job on reload and gives an honest missing-job state', async ({ page }) => {
    await go(page, '#reception/jobs/job-55/billing');
    await expect(jobNav(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Morgan Studio — Drawings 55', exact: true })).toBeVisible();
    expect((await calls(page)).filter(c => c.method === 'reception.jobs.list')).toHaveLength(0);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Documents — INV-55', exact: true })).toBeVisible();
    await go(page, '#reception/jobs/missing/billing');
    await expect(page.getByText('This job is unavailable.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Record payment/ })).toHaveCount(0);
});
test('native Back restores the captured board page, row and scroll position', async ({ page }) => {
    await go(page);
    await board(page).getByRole('button', { name: 'Older jobs', exact: true }).click();
    await expect(board(page).locator('.job-summary')).toHaveCount(13);
    const target = board(page).locator('.job-summary').nth(8).getByRole('link', { name: 'Open job', exact: true });
    await target.scrollIntoViewIfNeeded();
    const saved = await pane(page).evaluate(n => n.scrollTop);
    await target.click();
    await expect(jobNav(page)).toBeVisible();
    await jobNav(page).getByRole('link', { name: 'Activity', exact: true }).click();
    await expect(page.locator('[data-job-timeline]:visible h3').first()).toBeFocused();
    await page.goBack();
    await expect(jobNav(page).getByRole('link', { name: 'Overview', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await expect(target).toBeFocused();
    await expect(board(page).locator('.job-summary')).toHaveCount(13);
    expect(await pane(page).evaluate(n => n.scrollTop)).toBeCloseTo(saved, 0);
    await page.reload();
    await expect(board(page).locator('.job-summary')).toHaveCount(13);
    await expect(target).toBeFocused();
    expect(await pane(page).evaluate(n => n.scrollTop)).toBeCloseTo(saved, 0);
});
test('mobile job identity and selected section remain accessible above long activity', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go(page, '#reception/jobs/job-1/closeout');
    const active = jobNav(page).getByRole('link', { name: 'Closeout', exact: true });
    await expect(active).toHaveAttribute('aria-current', 'page');
    const box = await active.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await expect(page.locator('[data-closeout-checklist] li')).toHaveCount(2);
    await expect(page.getByRole('link', { name: 'Check email outcome', exact: true })).toBeVisible();
    await jobNav(page).getByRole('link', { name: 'Activity', exact: true }).click();
    await expect(page.locator('[data-job-timeline]:visible h3').first()).toBeFocused();
    const heading = await page.locator('[data-job-timeline]:visible h3').first().boundingBox();
    const header = await page.locator('[data-customer-job-header]').boundingBox();
    expect(heading!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1);
    expect(heading!.y).toBeLessThan(600);
    await pane(page).evaluate(n => { n.scrollTop += 1000; });
    await expect(page.getByRole('heading', { name: 'Morgan Studio — Drawings 1', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath('persistent-job-header.png') });
});
test('account editing loads and enables choices before focusing the visible name field', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go(page, '#reception/accounts');
    await page.getByText('Account actions', { exact: true }).first().click();
    await page.evaluate(() => { (window as any).__customerUxHold = 'reception.jobs.list'; });
    await page.getByRole('button', { name: 'Edit account Morgan Studio', exact: true }).click();
    const name = page.getByRole('form', { name: 'Edit customer account', exact: true }).getByLabel('Customer account name');
    await expect(name).toBeDisabled();
    await page.evaluate(() => { (window as any).__customerUxRelease(); });
    await expect(name).toBeEnabled();
    await expect(name).toBeFocused();
    await inViewport(page, 'input[name=customer_account_name]');
    await expect(page.locator('[data-customer-account-list]')).toBeHidden();
});
test('Billing exposes credit, refund and document actions without opening payment history', async ({ page }) => {
    await go(page, '#reception/jobs/job-1/billing');
    await page.getByRole('button', { name: 'Issue credit — INV-1', exact: true }).click();
    await expect(page.getByRole('form', { name: 'Issue invoice credit', exact: true })).toBeVisible();
    await expect(page.locator('[data-invoice-section=payments]')).toBeHidden();
    await page.getByRole('button', { name: 'Close invoice credit', exact: true }).click();
    await page.getByRole('navigation', { name: 'Invoice billing sections' }).getByRole('button', { name: 'Refunds', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Manage refunds and receipts', exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: 'Invoice billing sections' }).getByRole('button', { name: 'Documents', exact: true }).click();
    await expect(page.getByRole('button', { name: /Payment receipt —/ })).toBeVisible();
});
test('a loaded payment receipt reveals and focuses its heading, then returns to its entry', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go(page, '#reception/jobs/job-1/billing');
    await page.getByRole('button', { name: 'View payment history — INV-1', exact: true }).click();
    const source = page.getByRole('button', { name: 'View payment receipt', exact: true });
    await source.click();
    await expect(page.locator('[data-payment-receipt] h3')).toBeFocused();
    await inViewport(page, '[data-payment-receipt] h3');
    await page.getByRole('button', { name: 'Back to payment history', exact: true }).click();
    await expect(source).toBeFocused();
});
test('account statements lead with precise summaries and an aligned ledger with collapsed detail', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go(page, '#reception/accounts');
    await page.getByText('Account actions', { exact: true }).first().click();
    await page.getByRole('button', { name: 'View account statement for Morgan Studio', exact: true }).click();
    const copy = page.locator('[data-account-statement-copy]');
    await expect(copy.locator('table tbody tr')).toHaveCount(2);
    expect((await copy.locator('th').first().boundingBox())!.height).toBeLessThan(45);
    expect(await copy.locator('.financial-table').evaluate(n=>n.scrollWidth>n.clientWidth)).toBe(true);
    await expect(copy.locator('dd')).toContainText(['240.0000', '40.2468', '0.0000', '199.7532', '0.0000']);
    await expect(copy.locator('details')).toHaveJSProperty('open', false);
    expect((await copy.boundingBox())!.height).toBeLessThan(900);
    await copy.getByText('Full statement and transaction history', { exact: true }).click();
    await expect(copy).toContainText('20.1234');
    await page.screenshot({ path: info.outputPath('account-statement-mobile.png') });
});
test('empty work has a direct quote creation action and existing sign-offs lead with history', async ({ page }) => {
    await go(page, '#reception/jobs', 0);
    await page.getByRole('link', { name: 'Start a customer quote', exact: true }).click();
    await expect(page.locator('[data-signoff-create]')).toHaveJSProperty('open', true);
    await go(page, '#reception/signoffs', 6);
    await expect(page.locator('[data-signoff-create]')).toHaveJSProperty('open', false);
    await expect(page.locator('[data-signoff-history]')).toBeVisible();
});


test('collapses empty follow-up groups and omits their unused paging controls',async({page})=>{
 await go(page,'#reception/followups');const groups=page.locator('[data-customer-followup-group]');await expect(groups).toHaveCount(4);await expect.poll(async()=> (await calls(page)).filter(c=>c.method.endsWith('.reminders.list')).length).toBe(4);
 for(const group of await groups.all()){await expect(group).toHaveJSProperty('open',false);await group.locator('summary').first().click();await expect(group.getByRole('button',{name:/More .*follow-ups|Earlier .*follow-ups/})).toHaveCount(0);}
});


test('reveals follow-up load failures instead of hiding them in a collapsed group',async({page})=>{
 await page.goto(BASE+'?customer_fail=reception.signoff.reminders.list#reception/followups');const group=page.locator('[data-customer-followup-group]').first();await expect(group).toHaveJSProperty('open',true);await expect(group).toContainText('Could not load follow-ups');
});


test('reveals sign-off requests after a handoff from a scrolled workspace',async({page})=>{
 await page.setViewportSize({width:390,height:844});await go(page,'#reception/jobs/job-1/activity');await page.locator('[data-job-timeline]:visible h3').waitFor();await pane(page).evaluate(n=>{n.scrollTop+=2000;});await page.evaluate(()=>{location.hash='#reception/signoffs';});await expect(page.locator('[data-recued-quote-signoffs]>h2')).toBeFocused();const first=page.locator('[data-signoff-history] article').first();expect((await first.boundingBox())!.y).toBeGreaterThanOrEqual(0);expect((await first.boundingBox())!.y).toBeLessThan(700);
});
