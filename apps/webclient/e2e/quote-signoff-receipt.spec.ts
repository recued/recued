import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type {} from './harness/quote-signoff-harness.js';

const BASE = `${process.env.E2E_SIGNOFF_HARNESS_URL ?? 'http://127.0.0.1:4319'}/quote-signoff-harness.html`;
test.beforeEach(async ({ page }) => {
  const headers = await readFile(resolve(import.meta.dirname, '../public/_headers'), 'utf8');
  const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1];
  if (!policy) throw new Error('The shipped webclient Content Security Policy is missing.');
  await page.route('**/quote-signoff-harness.html*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
  });
});
const prepare = async (page: Page) => {
  await page.getByLabel('Open quote').selectOption('Q1');
  await page.getByLabel('Business name shown to the customer').fill('Studio');
  await page.getByLabel('Complete scope shown to the customer').fill('Three drawings. <img src=x onerror=alert(1)>');
  await page.getByLabel('Task to create after your approval').fill('PRIVATE internal task');
  await page.getByLabel('Invoice reference', { exact: true }).fill('INV-101');
  await page.getByRole('button', { name: 'Preview customer sign-off' }).click();
  await expect(page.getByRole('button', { name: 'View sign-off receipt' })).toBeVisible();
};

test('downloads the captured customer copy with escaped terms and no private transport data', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE); await prepare(page);
  await page.getByRole('button', { name: 'View sign-off receipt' }).click();
  const view = page.getByRole('region', { name: 'Sign-off receipt' });
  await expect(view).toContainText('120.0000 GBP total');
  await expect(view).toContainText('<img src=x onerror=alert(1)>');
  await expect(view.locator('img')).toHaveCount(0);
  await view.screenshot({ path: testInfo.outputPath('receipt-preview.png') });
  // An unsaved form edit cannot become part of the already loaded receipt.
  await page.getByLabel('Complete scope shown to the customer').fill('PRIVATE unsaved new scope');
  const pending = page.waitForEvent('download');
  await view.getByRole('button', { name: 'Download receipt' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('signoff-a1fecd4e-42ce-42a2-b7e7-731ce51a01b2.html');
  const path = await download.path(); expect(path).not.toBeNull();
  const html = await readFile(path!, 'utf8');
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(html).toContain("default-src 'none'"); expect(html).not.toContain('PRIVATE');
  expect(html).not.toContain('fixture-token');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__quoteSignoff.calls.filter(call => call.method === 'reception.signoff.receipt')))
    .toEqual([{ method: 'reception.signoff.receipt', payload: { signoff_id: 'a1fecd4e-42ce-42a2-b7e7-731ce51a01b2' } }]);
});

test('prints the same static copy in an isolated frame and cleans it on close', async ({ page }) => {
  await page.addInitScript(() => { window.print = () => { document.documentElement.setAttribute('data-print-called', 'true'); }; });
  await page.goto(BASE); await prepare(page); await page.getByRole('button', { name: 'View sign-off receipt' }).click();
  const view = page.getByRole('region', { name: 'Sign-off receipt' });
  await expect(view.getByRole('button', { name: 'Print / save PDF' })).toBeEnabled();
  await view.getByRole('button', { name: 'Print / save PDF' }).click();
  const frame = page.frameLocator('[data-signoff-receipt-print]');
  await expect(frame.locator('html')).toHaveAttribute('data-print-called', 'true');
  await expect(frame.locator('body')).toContainText('120.0000 GBP total');
  await expect(frame.locator('img, script')).toHaveCount(0);
  await expect(page.locator('[data-signoff-receipt-print]')).toHaveAttribute('sandbox', 'allow-same-origin allow-modals');
  await view.getByRole('button', { name: 'Close receipt' }).click();
  await expect(page.locator('[data-signoff-receipt-print]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View sign-off receipt' })).toBeFocused();
});

test('refreshes failed reads and restores focus to the repainted history button on Escape', async ({ page }) => {
  await page.goto(BASE); await prepare(page); await page.evaluate(() => window.__quoteSignoff.failReceipt(true));
  await page.getByRole('button', { name: 'View sign-off receipt' }).click();
  const view = page.getByRole('region', { name: 'Sign-off receipt' });
  await expect(view).toContainText('Receipt unavailable');
  await expect(view.getByRole('button', { name: 'Download receipt' })).toBeDisabled();
  await page.evaluate(() => window.__quoteSignoff.failReceipt(false));
  await view.getByRole('button', { name: 'Refresh receipt' }).click();
  await expect(view).toContainText('No customer reply recorded');
  // The list updates without replacing or silently refreshing this snapshot.
  await page.evaluate(() => window.__quoteSignoff.setReview('waiting'));
  await expect(page.locator('[data-signoff-history]')).toContainText('Customer accepted');
  await expect(view).toContainText('No customer reply recorded');
  await view.getByRole('button', { name: 'Refresh receipt' }).click();
  await expect(view).toContainText('Customer accepted');
  await view.getByRole('button', { name: 'Download receipt' }).focus(); await page.keyboard.press('Escape');
  await expect(view).toBeHidden(); await expect(page.getByRole('button', { name: 'View sign-off receipt' })).toBeFocused();
});

test('a closed or disposed receipt ignores its late RPC completion', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${BASE}?defer=receipt`); await prepare(page);
  await page.getByRole('button', { name: 'View sign-off receipt' }).click();
  const view = page.getByRole('region', { name: 'Sign-off receipt' });
  await expect(view).toContainText('Loading receipt');
  await view.getByRole('button', { name: 'Close receipt' }).click(); await page.evaluate(() => window.__quoteSignoff.release());
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(view).toBeHidden();
  await page.getByRole('button', { name: 'View sign-off receipt' }).click(); await expect(view).toContainText('Loading receipt');
  await page.evaluate(() => { window.__quoteSignoff.dispose(); window.__quoteSignoff.release(); });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(page.locator('[data-signoff-receipt]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('marks older reconstructed wording on the receipt and downloaded copy', async ({ page }) => {
  await page.goto(`${BASE}?legacy_receipt=1`); await prepare(page);
  await page.getByRole('button', { name: 'View sign-off receipt' }).click();
  const view = page.getByRole('region', { name: 'Sign-off receipt' });
  await expect(view).toContainText('Offered terms (rebuilt from saved terms)');
  const pending = page.waitForEvent('download');
  await view.getByRole('button', { name: 'Download receipt' }).click();
  const path = await (await pending).path(); expect(path).not.toBeNull();
  expect(await readFile(path!, 'utf8')).toContain('Offered terms (rebuilt from saved terms)');
});

test('refuses an unsupported receipt format before allowing print or download', async ({ page }) => {
  await page.goto(`${BASE}?bad_receipt_version=1`); await prepare(page);
  await page.getByRole('button', { name: 'View sign-off receipt' }).click();
  const view = page.getByRole('region', { name: 'Sign-off receipt' });
  await expect(view).toContainText('receipt format is not supported');
  await expect(view.getByRole('button', { name: 'Download receipt' })).toBeDisabled();
  await expect(view.getByRole('button', { name: 'Print / save PDF' })).toBeDisabled();
  await expect(view.locator('article, iframe')).toHaveCount(0);
});
