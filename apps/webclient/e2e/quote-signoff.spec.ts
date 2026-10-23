import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { expect, test, type Page } from '@playwright/test';
import type {} from './harness/quote-signoff-harness.js';

const BASE = `${process.env.E2E_SIGNOFF_HARNESS_URL ?? HARNESS_ORIGIN}/quote-signoff-harness.html`;
const fill = async (page: Page, scope = 'Three drawings. <img src=x onerror=alert(1)>') => {
  await page.getByLabel('Open quote').selectOption('Q1');
  await page.getByLabel('Business name shown to the customer').fill('Studio');
  await page.getByLabel('Complete scope shown to the customer').fill(scope);
  await page.getByLabel('Task to create after your approval').fill('Draw the plans');
  await page.getByLabel('Invoice reference', { exact: true }).fill('INV-101');
  await page.getByLabel('VAT included in the quoted total (blank means zero)').fill('20');
};
const count = (page: Page, method: string) => page.evaluate((name) => window.__quoteSignoff.calls.filter((call) => call.method === name).length, method);

test('freezes and shows the full scope, blocks duplicate submissions, and publishes only the reviewed reference', async ({ page }) => {
  await page.goto(`${BASE}?defer=prepare`); await fill(page);
  await page.getByRole('button', { name: 'Preview customer sign-off' }).click();
  await expect(page.getByLabel('Complete scope shown to the customer')).toBeDisabled();
  await page.locator('form').filter({ has: page.getByLabel('Open quote') })
    .evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(await count(page, 'reception.signoff.prepare')).toBe(1);
  await page.evaluate(() => window.__quoteSignoff.release());
  const preview = page.locator('[data-signoff-preview]');
  await expect(preview).toContainText('120.0000 GBP total'); await expect(preview).toContainText('<img src=x onerror=alert(1)>');
  await expect(preview.locator('img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Publish sign-off link' }).click();
  await expect(page.getByLabel('Customer sign-off link', { exact: true })).toHaveValue('https://studio.example.test/r/signoff/fixture-token');
  const published = await page.evaluate(() => window.__quoteSignoff.calls.filter((call) => call.method === 'reception.signoff.publish'));
  expect(published).toEqual([{ method: 'reception.signoff.publish', payload: {
    signoff_id: 'a1fecd4e-42ce-42a2-b7e7-731ce51a01b2', preview_hash: 'b'.repeat(64),
  } }]);
  await expect(page.locator('[data-signoff-history]')).toContainText('Waiting for customer');
});

test('editing the scope invalidates a prepared offer and requires a new preview', async ({ page }) => {
  await page.goto(BASE); await fill(page, 'Three drawings.');
  await page.getByRole('button', { name: 'Preview customer sign-off' }).click();
  await expect(page.getByRole('button', { name: 'Publish sign-off link' })).toBeEnabled();
  await page.getByLabel('Complete scope shown to the customer').fill('Five drawings.');
  await expect(page.locator('[data-signoff-preview]')).toBeEmpty();
  expect(await count(page, 'reception.signoff.publish')).toBe(0);
  await page.getByRole('button', { name: 'Preview customer sign-off' }).click();
  await expect(page.locator('[data-signoff-preview]')).toContainText('Five drawings.');
  expect(await count(page, 'reception.signoff.prepare')).toBe(2);
});

test('a publish in flight cannot run twice or repaint a disposed route', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${BASE}?defer=publish`); await fill(page);
  await page.getByRole('button', { name: 'Preview customer sign-off' }).click();
  const publish = page.getByRole('button', { name: 'Publish sign-off link' }); await publish.click();
  await expect(publish).toBeDisabled(); await publish.evaluate((button: HTMLButtonElement) => button.click());
  expect(await count(page, 'reception.signoff.publish')).toBe(1);
  await page.evaluate(() => { window.__quoteSignoff.dispose(); window.__quoteSignoff.release(); });
  await expect(page.locator('[data-recued-quote-signoffs]')).toHaveCount(0);
  // A browser animation frame lets the deferred promise's continuation run.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.getByLabel('Customer sign-off link', { exact: true })).toHaveCount(0); expect(errors).toEqual([]);
});

test('distinguishes a waiting owner review from a closed one and cancels the exact request', async ({ page }) => {
  await page.goto(BASE);
  await page.evaluate(() => window.__quoteSignoff.setReview('waiting'));
  await expect(page.getByRole('link', { name: 'Review release in Reception Inbox' })).toHaveAttribute('href', '#reception/inbox/a1fecd4e-42ce-42a2-b7e7-731ce51a01b2');
  await page.evaluate(() => window.__quoteSignoff.setReview('closed'));
  await expect(page.locator('[data-signoff-history]')).toContainText('Owner review closed without releasing work');
  await expect(page.getByRole('link', { name: 'Review release in Reception Inbox' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel request' }).click();
  await expect(page.locator('[data-signoff-history]')).toContainText('Cancelled');
  expect(await page.evaluate(() => window.__quoteSignoff.calls.filter((call) => call.method === 'reception.signoff.cancel')))
    .toEqual([{ method: 'reception.signoff.cancel', payload: { signoff_id: 'a1fecd4e-42ce-42a2-b7e7-731ce51a01b2' } }]);
});
