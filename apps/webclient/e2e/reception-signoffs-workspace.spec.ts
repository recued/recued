import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { openSignoffRequestDetails } from './helpers/signoff-request.js';
import { installCustomerWorkFixture } from './fixtures/customer-work.js';
import { installSignoffWorkspaceFixture } from './fixtures/signoff-workspace.js';
const BASE = `${HARNESS_ORIGIN}/full-app-harness.html`;
type Action = 'prepare' | 'prepare_addition' | 'publish' | 'cancel' | 'completion.prepare' | 'completion.publish' | 'completion.cancel';
const root = (page: Page) => page.locator('[data-recued-quote-signoffs]');
const state = (page: Page) => page.evaluate(() => (window as any).__signoffWorkspace as { calls: Array<{ method: string; args: Record<string, unknown> }> });
test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: `(${installCustomerWorkFixture.toString()})();(${installSignoffWorkspaceFixture.toString()})();` });
  const policy = (await readFile(resolve(import.meta.dirname, '../public/_headers'), 'utf8')).match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
  await page.route('**/full-app-harness.html*', async route => { const response = await route.fetch(); await route.fulfill({ response,headers: { ...response.headers(),'content-security-policy': policy } }); });
});
async function fill(page: Page, addition = false) {
  if (!addition) {
    const create = page.locator('[data-signoff-create]');
    if (!await create.evaluate(node => (node as HTMLDetailsElement).open)) await create.locator('summary').click();
    await page.getByRole('combobox', { name: 'Open quote',exact: true }).selectOption('QNEW');
    await page.getByLabel('Task to create after your approval', { exact: true }).fill('Deliver studio drawings');
  }
  await page.getByLabel('Business name shown to the customer', { exact: true }).fill('Studio');
  await page.getByLabel(addition ? 'Added scope shown to the customer' : 'Complete scope shown to the customer', { exact: true }).fill('Three drawings and final PDF delivery.');
  await page.getByLabel('Invoice reference', { exact: true }).fill(addition ? 'INV-ADD' : 'INV-NEW');
  if (addition) await page.getByLabel('Added amount including VAT', { exact: true }).fill('30');
}
async function setup(page: Page, action: Action) {
  await page.goto(`${BASE}?jobs=6&server_profiles=multiple#reception/signoffs`);
  await expect(root(page).locator('[data-signoff-history]>article')).toHaveCount(6);
  if (action === 'prepare' || action === 'publish') {
    await fill(page);
    if (action === 'publish') await page.getByRole('button', { name: 'Prepare sign-off preview',exact: true }).click();
    return page.getByRole('button', { name: action === 'publish' ? 'Publish sign-off link' : 'Prepare sign-off preview',exact: true });
  }
  const offer = root(page).locator(`[data-signoff-id="${action === 'cancel' ? 'offer-1' : 'offer-3'}"]`);
  await openSignoffRequestDetails(offer);
  if (action === 'cancel') return offer.getByRole('button', { name: 'Cancel request',exact: true });
  if (action === 'prepare_addition') {
    await offer.getByRole('button', { name: 'Add work',exact: true }).click(); await fill(page, true);
    return page.getByRole('button', { name: 'Prepare added-work preview',exact: true });
  }
  await offer.getByRole('button', { name: 'Request completion',exact: true }).click();
  await page.getByLabel('Delivered work shown to the customer', { exact: true }).fill('Delivered all three drawings and the final PDF.');
  if (action !== 'completion.prepare') await page.getByRole('button', { name: 'Prepare completion preview',exact: true }).click();
  if (action === 'completion.cancel') {
    await page.getByRole('button', { name: 'Publish completion link',exact: true }).click();
    return page.locator('[data-completion-id="workspace-completion"]').getByRole('button', { name: 'Cancel completion request',exact: true });
  }
  return page.getByRole('button', { name: action === 'completion.prepare' ? 'Prepare completion preview' : 'Publish completion link',exact: true });
}
for (const action of ['prepare','prepare_addition','publish','cancel','completion.prepare','completion.publish','completion.cancel'] as const) {
  test(`keeps ${action} owned by its server after native departure`, async ({ page }) => {
    const submit = await setup(page, action); const method = `reception.signoff.${action}`;
    await page.evaluate(method => { (window as any).__signoffWorkspace.hold = method; }, method);
    await submit.click();
    await expect.poll(async () => (await state(page)).calls.filter(c => c.method === method).length).toBe(1);
    const request = (await state(page)).calls.find(c => c.method === method)!;
    if (action === 'publish' || action === 'completion.publish') expect(request.args).toMatchObject({ preview_hash: 'b'.repeat(64),[action === 'publish' ? 'signoff_id' : 'completion_id']: action === 'publish' ? 'workspace-offer' : 'workspace-completion' });
    else if (action === 'prepare_addition') expect(request.args).toMatchObject({ parent_signoff_id: 'offer-3',amount: '30' });
    else if (action.startsWith('completion.')) expect(request.args).toMatchObject(action === 'completion.prepare' ? { signoff_id: 'offer-3',delivery_summary: 'Delivered all three drawings and the final PDF.' } : { completion_id: 'workspace-completion' });
    else expect(request.args).toMatchObject(action === 'cancel' ? { signoff_id: 'offer-1' } : { quote_id: 'QNEW',scope: 'Three drawings and final PDF delivery.' });
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('link', { name: 'Records',exact: true }).click();
    await expect(root(page)).toHaveCount(0);
    await page.locator('[data-recued-account-menu-trigger]').click();
    const account = page.locator('[data-recued-account-menu-popover]');
    const office = account.locator('[data-recued-server-switcher-item]').filter({ hasText: 'Office server' });
    await office.click();
    const review = account.locator('[data-recued-server-switcher-switch-confirm]');
    await expect(review).toContainText('Work is still finishing on');
    await expect(review.locator('[data-recued-server-switcher-switch-commit]')).toHaveText('Switch, and check later');
    await page.evaluate(() => (window as any).__signoffWorkspace.release?.());
    await review.locator('[data-recued-server-switcher-switch-cancel]').click();
    await office.click();
    await expect(review.locator('[data-recued-server-switcher-switch-commit]')).toHaveText('Switch server');
    expect((await state(page)).calls.filter(c => c.method === method)).toHaveLength(1);
    await review.locator('[data-recued-server-switcher-switch-cancel]').click();
    await expect(office).toBeFocused();
  });
}
for (const action of ['prepare','publish','completion.prepare','completion.publish'] as const) {
  test(`a late ${action} reply preserves focus moved to the account menu`, async ({ page }) => {
    const submit = await setup(page, action);const method = `reception.signoff.${action}`;
    await page.evaluate(method => { (window as any).__signoffWorkspace.hold = method; }, method);await submit.click();
    await expect.poll(async () => (await state(page)).calls.filter(c => c.method === method).length).toBe(1);
    const account = page.locator('[data-recued-account-menu-trigger]');await account.click();
    const close = page.locator('[data-recued-account-menu-close]');await expect(close).toBeVisible();await close.focus();
    await page.evaluate(() => (window as any).__signoffWorkspace.release?.());
    await expect(action.startsWith('completion.') ? root(page).locator('[aria-label="Request customer completion"] button[type=submit]') : root(page).locator('[data-signoff-create]>form button[type=submit]')).toBeEnabled();
    await expect(close).toBeFocused();
    await close.click();await expect(account).toBeFocused();
  });
}
for (const kind of ['quote','completion'] as const) {
  test(`a delayed saved ${kind} preview preserves later account focus`, async ({ page }) => {
    await setup(page, kind === 'quote' ? 'publish' : 'completion.publish');
    const method = kind === 'quote' ? 'reception.signoff.resume' : 'reception.signoff.completion.resume';
    const resume = kind === 'quote'
      ? root(page).locator('[data-signoff-id="workspace-offer"]').getByRole('button', { name: 'Resume preview',exact: true })
      : root(page).locator('[data-completion-id="workspace-completion"]').getByRole('button', { name: 'Resume completion preview',exact: true });
    await page.evaluate(method => { (window as any).__signoffWorkspace.hold = method; }, method);await resume.click();
    await expect.poll(async () => (await state(page)).calls.filter(c => c.method === method).length).toBe(1);
    await page.locator('[data-recued-account-menu-trigger]').click();const close = page.locator('[data-recued-account-menu-close]');await close.focus();
    await page.evaluate(() => (window as any).__signoffWorkspace.release?.());
    await expect(kind === 'completion' ? root(page).locator('[aria-label="Request customer completion"] button[type=submit]') : root(page).locator('[data-signoff-create]>form button[type=submit]')).toBeEnabled();
    await expect(close).toBeFocused();
    expect((await state(page)).calls.filter(c => c.method === method)).toHaveLength(1);
  });
}
test('a delayed follow-up read preserves later account focus', async ({ page }) => {
  await page.goto(`${BASE}?jobs=6#reception/signoffs`);
  const card = root(page).locator('[data-signoff-id="offer-1"]');await openSignoffRequestDetails(card);
  await page.evaluate(() => { (window as any).__signoffWorkspace.hold = 'reception.signoff.reminders.get'; });
  await card.getByRole('button', { name: 'Set follow-up',exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__signoffWorkspace.release)).toBe('function');
  await page.locator('[data-recued-account-menu-trigger]').click();const close = page.locator('[data-recued-account-menu-close]');await close.focus();
  await page.evaluate(() => (window as any).__signoffWorkspace.release());
  await expect(page.getByLabel('Follow-up time (your device timezone)', { exact: true })).toBeEnabled();await expect(close).toBeFocused();
});
test('native status choices and keyboard submission filter requests without mutating them', async ({ page }) => {
  await page.setViewportSize({ width: 280,height: 850 });await page.goto(`${BASE}?jobs=6#reception/signoffs`);
  const cards = root(page).locator('[data-signoff-history]>article');await expect(cards).toHaveCount(6);
  const status = root(page).getByRole('combobox', { name: 'Request status',exact: true });
  await expect(status).toBeEnabled();await status.selectOption('waiting');await status.focus();await expect(status).toHaveValue('waiting');
  const search = root(page).getByRole('button', { name: 'Search',exact: true });await search.focus();await expect(search).toBeFocused();
  await page.keyboard.press('Enter');await expect(cards).toHaveCount(1);await expect(cards.first()).toContainText('Waiting for customer');
  const clear = root(page).getByRole('button', { name: 'Clear search',exact: true });await clear.focus();await expect(clear).toBeFocused();
  await page.keyboard.press('Enter');await expect(cards).toHaveCount(6);await expect(status).toHaveValue('');
  expect((await state(page)).calls.filter(call => /\.(prepare|prepare_addition|publish|cancel)$/.test(call.method))).toEqual([]);
});
