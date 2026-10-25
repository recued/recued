import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { renderApprovalLinkUnavailableHtml } from '../../../backend/server/src/ports/reception/handlers/approval-link-render.js';
import { lookupReceptionStaticAsset } from '../../../backend/server/src/ports/reception/static-assets.js';
import { installCustomerWorkFixture } from './fixtures/customer-work.js';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { openSignoffRequestDetails } from './helpers/signoff-request.js';
import type {} from './harness/quote-signoff-harness.js';

declare global { interface Window { __finishSignoffCopy?: () => void } }

const BASE = `${process.env.E2E_SIGNOFF_HARNESS_URL ?? HARNESS_ORIGIN}/quote-signoff-harness.html`;
const APP = `${HARNESS_ORIGIN}/full-app-harness.html`;
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const failures: string[] = []; errors.set(page, failures);
  page.on('pageerror', error => failures.push(error.message));
  // Keep the deterministic connection alive while exercising the real poll.
  await page.addInitScript({ content: `(${installCustomerWorkFixture.toString()})();
    setInterval(() => window.__app?.fireMessage({type:'server_heartbeat',payload:{server_id:'fixture-server',last_seen_at:Date.now(),lifecycle_state:'running',uptime_s:120,supervisor_mode:'systemd'}}), 1000);
    const previousCustomerFixture = window.__receptionFixture;
    window.__receptionFixture = async (method, args) => method === 'reception.signoff.quotes'
      ? {result:{quotes:[{id:'Q1',label:'Drawings',customer:'Morgan Studio',amount:'120.0000',currency:'GBP',revision:3}],truncated:false}}
      : previousCustomerFixture(method,args);` });
  const headers = await readFile(resolve(import.meta.dirname, '../public/_headers'), 'utf8');
  const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
  await page.route(/\/(full-app|quote-signoff)-harness\.html/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
  });
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

const fill = async (page: Page) => {
  const creation = page.locator('[data-signoff-create]');
  if (!await creation.evaluate(node => (node as HTMLDetailsElement).open)) await creation.locator('summary').click();
  await page.getByLabel('Open quote').selectOption('Q1');
  await page.getByLabel('Business name shown to the customer').fill('Studio');
  await page.getByLabel('Complete scope shown to the customer').fill('Three drawings, one revision, and final PDF delivery.');
  await page.getByLabel('Task to create after your approval').fill('Deliver drawings');
  await page.getByLabel('Invoice reference', { exact: true }).fill('INV-NEW');
};
const share = async (page: Page) => {
  await page.goto(BASE); await fill(page);
  await page.getByRole('button', { name: 'Prepare sign-off preview', exact: true }).click();
  await expect(page.locator('[data-signoff-preview] h3')).toBeFocused();
  await page.getByRole('button', { name: 'Publish sign-off link', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign-off link ready', exact: true })).toBeFocused();
  return page.locator('[data-customer-link-share]');
};

test('keeps an unpublished sign-off when the owner declines navigation, and discards only after acceptance', async ({ page }) => {
  await page.goto(`${APP}?jobs=0#reception/signoffs/new`); await fill(page);
  const scope = page.getByLabel('Complete scope shown to the customer');
  const value = await scope.inputValue();
  const cancelled = page.waitForEvent('dialog');
  const firstClick = page.getByRole('link', { name: 'Jobs', exact: true }).click();
  const first = await cancelled; const prompt = first.message(); await first.dismiss(); await firstClick;
  expect(prompt).toContain('Discard');
  await expect(scope).toHaveValue(value);
  await expect(page).toHaveURL(/#reception\/signoffs\/new$/);
  const accepted = page.waitForEvent('dialog');
  const secondClick = page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await (await accepted).accept(); await secondClick;
  await expect(page.locator('[data-jobs-board]')).toBeVisible();
  await page.getByRole('link', { name: 'Sign-offs', exact: true }).click();
  await expect(scope).toHaveValue('');
});

test('discard clears creation fields and permits leaving without another prompt', async ({ page }) => {
  await page.goto(`${APP}?jobs=0#reception/signoffs/new`); await fill(page);
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(page.getByLabel('Complete scope shown to the customer')).toHaveValue('');
  let prompted = false; page.on('dialog', async dialog => { prompted = true; await dialog.dismiss(); });
  await page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await expect(page.locator('[data-jobs-board]')).toBeVisible(); expect(prompted).toBe(false);
});

test('protects added-work edits when switching agreements and leaving the route', async ({ page }) => {
  await page.goto(`${APP}?jobs=6#reception/signoffs`);
  const cards = page.locator('[data-signoff-history] article');
  await openSignoffRequestDetails(cards.first());
  await cards.first().getByRole('button', { name: 'Add work', exact: true }).click();
  const scope = page.getByLabel('Added scope shown to the customer', { exact: true });
  await scope.fill('One additional drawing.');
  await page.getByLabel('Added amount including VAT').fill('30');
  await openSignoffRequestDetails(cards.nth(2));
  await cards.nth(2).getByRole('button', { name: 'Add work', exact: true }).click();
  await expect(scope).toHaveValue('One additional drawing.');
  await expect(page.getByText('Finish or discard the current sign-off draft before choosing another agreement.')).toBeVisible();
  const pending = page.waitForEvent('dialog');
  const click = page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await (await pending).dismiss(); await click; await expect(scope).toHaveValue('One additional drawing.');
});

test('explains immediate replacement before preparing and focuses the saved preview', async ({ page }) => {
  await page.goto(BASE + '?waiting'); await fill(page);
  const notice = page.locator('[data-signoff-replacement-notice]');
  await expect(notice).toContainText('immediately replaces earlier active requests');
  await expect(notice).toContainText('accepted request waiting for your review');
  expect(await page.evaluate(() => window.__quoteSignoff.calls.filter(call => call.method === 'reception.signoff.prepare'))).toEqual([]);
  await page.getByRole('button', { name: 'Prepare sign-off preview', exact: true }).click();
  await expect(page.locator('[data-signoff-preview] h3')).toBeFocused();
  await expect(page.getByText('Preview prepared. Earlier active requests for this quote have been replaced.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => window.__quoteSignoff.calls.some(call => call.method === 'reception.signoff.publish'))).toBe(false);
});

test('explains added-work replacement before preparation and publishes the reviewed parent', async ({ page }) => {
  await page.goto(BASE + '?completion');
  await openSignoffRequestDetails(page.locator('[data-signoff-history] article').first());
  await page.getByRole('button', { name: 'Add work', exact: true }).click();
  await expect(page.locator('[data-signoff-replacement-notice]')).toContainText('immediately replaces pending added-work requests');
  await page.getByLabel('Business name shown to the customer').fill('Studio');
  await page.getByLabel('Added scope shown to the customer', { exact: true }).fill('One additional drawing.');
  await page.getByLabel('Added amount including VAT').fill('30');
  await page.getByLabel('Invoice reference', { exact: true }).fill('INV-ADD');
  await page.getByRole('button', { name: 'Prepare added-work preview', exact: true }).click();
  await expect(page.locator('[data-signoff-preview] h3')).toBeFocused();
  await expect(page.locator('[data-signoff-preview]')).toContainText('150.0000 GBP');
  await page.getByRole('button', { name: 'Publish sign-off link', exact: true }).click();
  const calls = await page.evaluate(() => window.__quoteSignoff.calls);
  expect(calls.find(call => call.method === 'reception.signoff.prepare_addition')?.payload).toMatchObject({ parent_signoff_id: 'a1fecd4e-42ce-42a2-b7e7-731ce51a01b2' });
  expect(calls.find(call => call.method === 'reception.signoff.publish')?.payload).toMatchObject({ signoff_id: 'c1fecd4e-42ce-42a2-b7e7-731ce51a01b2', preview_hash: 'd'.repeat(64) });
});

test('the twenty-second poll preserves expanded details, keyboard focus and scroll', async ({ page }) => {
  await page.clock.install();
  await page.goto(`${APP}?jobs=6#reception/signoffs`);
  const card = page.locator('[data-signoff-history] article').nth(4);
  await openSignoffRequestDetails(card);
  const scope = card.locator('[data-signoff-disclosure="scope"]');
  await scope.locator('summary').click(); await scope.locator('summary').focus();
  const pane = page.locator('[data-recued-webclient-content]');
  const before = await pane.evaluate(node => node.scrollTop);
  const reads = await page.evaluate(() => window.__app.rpcCallCount('reception.signoff.list'));
  await page.clock.fastForward(20_000);
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('reception.signoff.list'))).toBeGreaterThan(reads);
  await expect(scope).toHaveJSProperty('open', true);
  await expect(card.locator('[data-signoff-disclosure="actions"]')).toHaveJSProperty('open', true);
  await expect(scope.locator('summary')).toBeFocused();
  expect(await pane.evaluate(node => node.scrollTop)).toBeCloseTo(before, 0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(scope).toHaveJSProperty('open', true);
});

test('mobile request cards keep precise money and one main action without overflow', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${APP}?jobs=6#reception/signoffs`);
  const card = page.locator('[data-signoff-history] article').first();
  await expect(card.getByRole('link', { name: 'Open job', exact: true })).toBeVisible();
  await expect(card.locator('.signoff-amount')).toHaveText('120.0000 GBP');
  await expect(card.locator('[data-signoff-state]')).toHaveText('Work and invoice released');
  await expect(card.getByText('Quote Q-1', { exact: true })).toBeVisible();
  await expect(card.locator('a:visible,button:visible,summary:visible')).toHaveCount(2);
  expect((await card.boundingBox())!.height).toBeLessThan(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await openSignoffRequestDetails(card);
  await expect(card.getByRole('button', { name: 'Record payment', exact: true })).toBeVisible();
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  await refresh.focus(); await refresh.click();
  await expect(refresh).toBeFocused();
  await card.locator('[data-signoff-disclosure="actions"]>summary').click();
  await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('signoffs-mobile.png') });
});

test('copies the exact link to the browser clipboard and shows expiry and feedback', async ({ page, context, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'Native clipboard permissions are qualified in Chromium.');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const card = await share(page);
  await expect(card.locator('time')).toHaveAttribute('datetime', /Z$/);
  await card.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(card.getByRole('status')).toHaveText('Link copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await card.getByLabel('Customer sign-off link', { exact: true }).inputValue());
  await card.screenshot({ path: info.outputPath('signoff-link-ready.png') });
});

test('selects the visible link for manual copying when clipboard access fails', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Denied')) }, configurable: true }));
  const card = await share(page);
  await card.getByRole('button', { name: 'Copy link', exact: true }).click();
  const input = card.getByLabel('Customer sign-off link', { exact: true });
  await expect(input).toBeFocused();
  expect(await input.evaluate((node: HTMLInputElement) => node.selectionEnd! - node.selectionStart!)).toBe((await input.inputValue()).length);
  await expect(card.getByRole('status')).toContainText('The link is selected');
});

test('a stalled clipboard falls back to manual selection after its deadline', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => new Promise(() => {}) }, configurable: true }));
  const card = await share(page);
  await card.getByRole('button', { name: 'Copy link', exact: true }).click();
  await page.clock.fastForward(2_100);
  await expect(card.getByRole('status')).toContainText('The link is selected');
  await expect(card.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled();
});

test('a late clipboard result cannot label a replacement link copied', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => new Promise<void>(resolveCopy => {
      window.__finishSignoffCopy = resolveCopy;
    }) }, configurable: true });
  });
  const card = await share(page);
  await card.getByRole('button', { name: 'Copy link', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare sign-off preview', exact: true }).click();
  await page.getByRole('button', { name: 'Publish sign-off link', exact: true }).click();
  await page.evaluate(() => window.__finishSignoffCopy!());
  await expect(card.locator('[role=status]')).toBeEmpty();
  await expect(card.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled();
});

test('renders the neutral unavailable page on mobile with the shipped public styles', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/reception/_static/*', async route => {
    const asset = lookupReceptionStaticAsset(new URL(route.request().url()).pathname);
    await route.fulfill(asset ? { contentType: asset.content_type, body: asset.bytes } : { status: 404 });
  });
  await page.route('**/reception/approve/expired-fixture*', route => route.fulfill({ status: 410, contentType: 'text/html', body: renderApprovalLinkUnavailableHtml() }));
  const response = await page.goto(`${HARNESS_ORIGIN}/reception/approve/expired-fixture?t=fixture-token`);
  expect(response!.status()).toBe(410);
  await expect(page.getByRole('heading', { name: 'This link is unavailable', exact: true })).toBeVisible();
  await expect(page.getByText('Ask the business that sent it for a new link.', { exact: true })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('fixture-token');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: info.outputPath('unavailable-link-mobile.png') });
});
