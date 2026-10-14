import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect,test,type Page } from '@playwright/test';
import type {} from './harness/quote-signoff-harness.js';
import { renderApprovalLinkHtml } from '../../../backend/server/src/ports/reception/handlers/approval-link-render.js';
import { lookupReceptionStaticAsset } from '../../../backend/server/src/ports/reception/static-assets.js';
const BASE = `${process.env.E2E_SIGNOFF_HARNESS_URL ?? 'http://127.0.0.1:4319'}/quote-signoff-harness.html?completion`;
test.beforeEach(async ({ page }) => {
  const headers = await readFile(resolve(import.meta.dirname,'../public/_headers'),'utf8');
  const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1];if (!policy) throw new Error('Missing shipped CSP');
  await page.route('**/quote-signoff-harness.html*',async route => { const response = await route.fetch();await route.fulfill({ response,headers: { ...response.headers(),'content-security-policy': policy } }); });
});
const prepare = async (page: Page,delivery = 'Delivered the drawings. <img src=x onerror=alert(1)>') => {
  await page.getByRole('button',{ name: 'Request completion',exact: true }).click();
  await page.getByLabel('Delivered work shown to the customer').fill(delivery);
  await page.getByRole('button',{ name: 'Preview completion',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Publish completion link',exact: true })).toBeVisible();
};
const publish = async (page: Page) => { await prepare(page);await page.getByRole('button',{ name: 'Publish completion link',exact: true }).click();await expect(page.getByLabel('Customer completion link',{ exact: true })).toBeVisible(); };
const queue = (page: Page) => page.locator('[data-completion-history]');

const publicForm = async (page: Page) => {
  const origin = new URL(BASE).origin;
  const posts: URLSearchParams[] = [];
  await page.route(origin+'/reception/_static/*',async route => {
    const asset = lookupReceptionStaticAsset(new URL(route.request().url()).pathname);
    await route.fulfill(asset ? { contentType: asset.content_type,body: asset.bytes } : { status: 404 });
  });
  await page.route(origin+'/reception/approve/browser-completion*',async route => {
    if (route.request().method() === 'POST') {
      posts.push(new URLSearchParams(route.request().postData() ?? ''));
      await route.fulfill({ contentType: 'text/html',body: '<!doctype html><h1>Response received</h1>' });return;
    }
    await route.fulfill({ contentType: 'text/html',body: renderApprovalLinkHtml({
      completion: true,display_name: 'Studio',action_kind: 'approve_wording',prompt: 'Review the delivered work.',
      context_summary: 'Agreed scope:\nThree drawings.\n\nDelivered work:\nDrawings delivered. <script>alert(1)</script>',
      visitor_field_constraints: { name: 'optional',email: 'optional' },expiry_display: 'Expires in 7 days',
      submit_button_label: 'Submit',endpoint_id: 'browser-completion',bearer_secret: 'fixture-token',form_nonce: 'fixture-nonce',
    }) });
  });
  await page.goto(origin+'/reception/approve/browser-completion?t=fixture-token');
  return posts;
};

test('public completion preserves scope lines under the shipped CSP and accepts without corrections',async ({ page }) => {
  const errors: string[] = [];page.on('pageerror',error => errors.push(error.message));
  const posts = await publicForm(page);
  const context = page.locator('.rcp-context');
  await expect(context).toHaveCSS('white-space','pre-wrap');await expect(context).toHaveCSS('overflow-wrap','anywhere');
  await expect(context.locator('script')).toHaveCount(0);
  await page.getByRole('button',{ name: 'Accept completion',exact: true }).click();
  await expect(page.getByRole('heading',{ name: 'Response received' })).toBeVisible();
  expect(posts).toHaveLength(1);expect(posts[0]?.get('decision')).toBe('approve');expect(posts[0]?.get('comment')).toBe('');
  expect(posts[0]?.get('form_nonce')).toBe('fixture-nonce');expect(errors).toEqual([]);
});

test('public completion blocks empty corrections before posting and sends the filled reply',async ({ page }) => {
  const posts = await publicForm(page);
  await page.getByRole('button',{ name: 'Request corrections',exact: true }).click();
  await expect(page.getByLabel('Corrections (required when requesting changes)')).toBeFocused();
  expect(posts).toHaveLength(0);
  await page.getByLabel('Corrections (required when requesting changes)').fill('Please correct the scale.');
  await page.getByRole('button',{ name: 'Request corrections',exact: true }).click();
  await expect(page.getByRole('heading',{ name: 'Response received' })).toBeVisible();
  expect(posts).toHaveLength(1);expect(posts[0]?.get('decision')).toBe('reject');
  expect(posts[0]?.get('comment')).toBe('Please correct the scale.');
});

test('previews and shares exactly the delivery and released scope without executing work',async ({ page },info) => {
  const errors: string[] = [];page.on('pageerror',error => errors.push(error.message));
  await page.goto(BASE);await prepare(page);
  const editor = page.getByRole('form',{ name: 'Request customer completion' });
  await expect(editor).toContainText('Agreed scope:\nThree drawings.');await expect(editor).toContainText('Delivered the drawings. <img src=x onerror=alert(1)>');
  await expect(editor.locator('img')).toHaveCount(0);await editor.screenshot({ path: info.outputPath('completion-preview.png') });
  await page.getByRole('button',{ name: 'Publish completion link' }).click();
  await expect(page.getByLabel('Customer completion link',{ exact: true })).toHaveValue('https://studio.example.test/r/completion/fixture-token');
  await expect(page.getByRole('button',{ name: 'Publish completion link' })).toHaveCount(0);
  const calls = await page.evaluate(() => window.__quoteSignoff.calls);
  expect(calls.filter(call => call.method === 'reception.signoff.completion.publish')).toHaveLength(1);
  expect(calls.some(call => /execute|approve|mark_done/.test(call.method))).toBe(false);expect(errors).toEqual([]);
});
test('editing prepared delivery invalidates publication until it is previewed again',async ({ page }) => {
  await page.goto(BASE);await prepare(page);await page.getByLabel('Delivered work shown to the customer').fill('New delivery.');
  await expect(page.getByRole('button',{ name: 'Publish completion link' })).toHaveCount(0);
  await page.getByRole('button',{ name: 'Preview completion',exact: true }).click();
  await expect(page.getByRole('form',{ name: 'Request customer completion' })).toContainText('New delivery.');
});
test('preserves an unfinished editor while refreshing request history',async ({ page }) => {
  await page.goto(BASE);await page.getByRole('button',{ name: 'Request completion',exact: true }).click();
  await page.getByLabel('Delivered work shown to the customer').fill('Unsaved delivery.');
  await page.getByRole('button',{ name: 'Refresh completions' }).click();
  await expect(page.getByLabel('Delivered work shown to the customer')).toHaveValue('Unsaved delivery.');
  await page.getByRole('button',{ name: 'Request completion',exact: true }).click();
  await expect(page.getByLabel('Delivered work shown to the customer')).toHaveValue('Unsaved delivery.');
});
test('shows specific corrections as text and links the separate owner review',async ({ page }) => {
  await page.goto(BASE);await publish(page);
  await page.evaluate(() => window.__quoteSignoff.completionResponse('corrections_requested','Correct scale. <script>alert(1)</script>'));
  await expect(queue(page)).toContainText('Customer requested corrections.');await expect(queue(page)).toContainText('Correct scale. <script>alert(1)</script>');
  await expect(queue(page).locator('script')).toHaveCount(0);await expect(queue(page).getByRole('link',{ name: 'Review completion in Reception Inbox' })).toHaveAttribute('href','#reception/inbox');
  await page.getByLabel('Completion requests',{ exact: true }).selectOption('review');
  await expect.poll(async () => page.evaluate(() => window.__quoteSignoff.calls.filter(call => call.method === 'reception.signoff.completion.list').at(-1)?.payload)).toEqual({ limit: 50,review_only: true });
});
test('does not infer acceptance from a processed status when the reply is unavailable',async ({ page }) => {
  await page.goto(BASE);await publish(page);await page.evaluate(() => window.__quoteSignoff.completionResponse('unavailable'));
  await expect(queue(page)).toContainText('Reply processed');await expect(queue(page)).toContainText('Customer reply unavailable.');
  await expect(queue(page)).not.toContainText('Customer accepted completion.');
});
test('cancels a pending completion without approving its work',async ({ page }) => {
  await page.goto(BASE);await publish(page);await queue(page).getByRole('button',{ name: 'Cancel completion request' }).click();
  await expect(queue(page)).toContainText('Cancelled');await expect(queue(page).getByRole('button',{ name: 'Cancel completion request' })).toHaveCount(0);
});
test('retries a failed preparation without publishing the failed preview',async ({ page }) => {
  await page.goto(BASE);await page.getByRole('button',{ name: 'Request completion',exact: true }).click();await page.getByLabel('Delivered work shown to the customer').fill('Delivered.');
  await page.evaluate(() => window.__quoteSignoff.failCompletion(true));await page.getByRole('button',{ name: 'Preview completion',exact: true }).click();
  await expect(page.locator('[data-signoff-completions]')).toContainText('Completion unavailable. Try again.');
  await expect(page.getByRole('button',{ name: 'Publish completion link' })).toHaveCount(0);
  await page.evaluate(() => window.__quoteSignoff.failCompletion(false));await page.getByRole('button',{ name: 'Preview completion',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Publish completion link' })).toBeEnabled();
});
test('exports completion decision and owner action while omitting corrections and escaping the delivery',async ({ page }) => {
  await page.goto(BASE);await publish(page);await page.evaluate(() => window.__quoteSignoff.completionResponse('corrections_requested','PRIVATE correction','reopen'));
  await expect(queue(page)).toContainText('Owner reopened work');await page.getByRole('button',{ name: 'View receipt' }).click();
  const view = page.getByRole('region',{ name: 'Sign-off receipt' });await expect(view).toContainText('Delivery completion');await expect(view).toContainText('Customer requested corrections');
  await expect(view).toContainText('Owner reopened work');await expect(view).not.toContainText('PRIVATE correction');
  const pending = page.waitForEvent('download');await view.getByRole('button',{ name: 'Download receipt' }).click();
  const download = await pending;const html = await readFile((await download.path())!,'utf8');
  expect(html).toContain('Delivery completion');expect(html).toContain('Customer requested corrections');expect(html).toContain('Owner reopened work');expect(html).toContain('&lt;img');
  expect(html).not.toContain('PRIVATE correction');expect(html).not.toContain('fixture-token');expect(html).not.toMatch(/<(?:img|script)\b/);
});
test('ignores a late completion preparation after the panel is disposed',async ({ page }) => {
  await page.goto(BASE+'&defer=reception.signoff.completion.prepare');await page.getByRole('button',{ name: 'Request completion',exact: true }).click();await page.getByLabel('Delivered work shown to the customer').fill('Delivered.');
  await page.getByRole('button',{ name: 'Preview completion',exact: true }).click();
  await expect.poll(async () => page.evaluate(() => window.__quoteSignoff.calls.some(call => call.method === 'reception.signoff.completion.prepare'))).toBe(true);
  await page.evaluate(() => { window.__quoteSignoff.dispose();window.__quoteSignoff.release(); });
  await expect(page.locator('[data-recued-quote-signoffs]')).toHaveCount(0);
});
