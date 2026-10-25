import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL } from './helpers/full-app.js';

declare global {
  interface Window {
    __certificateRemovalFocus: { uploads: unknown[]; removals: unknown[] };
  }
}

const domains = ['server-a.example.test', 'server-b.example.test'];
const panel = (page: Page) => page.locator('[data-recued-tls-certs-panel]');
const row = (page: Page, domain: string) => panel(page).locator(`[data-recued-tls-certs-row="${domain}"]`);
const remove = (page: Page, domain: string) => row(page, domain).getByRole('button', { name: 'Remove', exact: true });
const cancel = (page: Page, domain: string) => row(page, domain).getByRole('button', { name: 'Cancel', exact: true });
const confirm = (page: Page, domain: string) => row(page, domain).getByRole('button', { name: 'Remove certificate', exact: true });
let errors: string[] = [];
let externalRequests: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(HARNESS_URL).origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript(() => {
    const fixture = { uploads: [] as unknown[], removals: [] as unknown[] };
    Object.assign(window, {
      __certificateRemovalFocus: fixture,
      __connectionsFixture: async (method: string, args: unknown) => {
        if (method === 'tls_domain.list') return { result: { entries: ['server-a.example.test', 'server-b.example.test'].map(domain => ({
          domain, source: 'byo_upload', issuer: 'Synthetic CA', fingerprint: 'ab'.repeat(32), expires_at: Date.now() + 90 * 86400000,
        })) } };
        if (method === 'tls_domain.upload') fixture.uploads.push(args);
        if (method === 'tls_domain.remove') fixture.removals.push(args);
        if (method === 'tls_domain.upload' || method === 'tls_domain.remove') {
          return { error: { code: 'FORBIDDEN', message: 'Unexpected write in focus fixture.' } };
        }
        return undefined;
      },
    });
  });
});

test.afterEach(async ({ page }) => {
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(await page.evaluate(() => window.__certificateRemovalFocus)).toEqual({ uploads: [], removals: [] });
});

const open = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${HARNESS_URL}?settle_reads=1&notifications=ready&yours=demo#settings/server/certificates`);
  await page.waitForFunction(() => window.__app?.ready === true);
  for (const domain of domains) await expect(remove(page, domain)).toBeEnabled();
};

for (const width of [390, 1280]) {
  test(`Certificates removal keeps keyboard focus in the matching row at ${width}px`, async ({ page, browserName }) => {
    await open(page, width);
    // Start with the second row so a first-match focus implementation fails.
    for (const [index, domain] of [...domains].reverse().entries()) {
      await remove(page, domain).focus();
      await page.keyboard.press(index === 0 ? 'Enter' : 'Space');
      await expect(cancel(page, domain)).toBeFocused();
      await expect(confirm(page, domain)).toBeVisible();
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(confirm(page, domain)).toBeFocused();
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
      await expect(cancel(page, domain)).toBeFocused();
      await page.keyboard.press(index === 0 ? 'Space' : 'Enter');
      await expect(confirm(page, domain)).toHaveCount(0);
      await expect(remove(page, domain)).toBeFocused();
    }
  });

  test(`Certificates removal leaves editing focus alone and ignores retired controls at ${width}px`, async ({ page }) => {
    await open(page, width);
    await panel(page).getByRole('button', { name: 'Upload a certificate', exact: true }).click();
    const hostname = panel(page).locator('[data-recued-tls-certs-upload-field="domain"]');
    await hostname.fill('draft.example.test');
    await hostname.evaluate(input => (input as HTMLInputElement).setSelectionRange(2, 5));
    const originalInput = await hostname.elementHandle();
    const retiredRemove = await remove(page, domains[0]!).elementHandle();
    // An unfocused programmatic action must not move focus out of the draft.
    await remove(page, domains[0]!).evaluate(button => (button as HTMLButtonElement).click());
    await expect(cancel(page, domains[0]!)).toBeVisible();
    await expect(hostname).toBeFocused();
    const retiredCancel = await cancel(page, domains[0]!).elementHandle();
    await cancel(page, domains[0]!).evaluate(button => (button as HTMLButtonElement).click());
    await expect(confirm(page, domains[0]!)).toHaveCount(0);
    await expect(hostname).toBeFocused();
    expect(await hostname.evaluate(input => ({ start: (input as HTMLInputElement).selectionStart, end: (input as HTMLInputElement).selectionEnd }))).toEqual({ start: 2, end: 5 });
    expect(await originalInput!.evaluate(input => input.isConnected)).toBe(true);
    await expect(hostname).toHaveValue('draft.example.test');

    await remove(page, domains[1]!).focus();
    await page.keyboard.press('Enter');
    await expect(cancel(page, domains[1]!)).toBeFocused();
    const currentCancel = await cancel(page, domains[1]!).elementHandle();
    for (const retired of [retiredRemove, retiredCancel]) {
      expect(await retired!.evaluate(button => button.isConnected)).toBe(false);
      await retired!.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await expect(cancel(page, domains[1]!)).toBeFocused();
      await expect(confirm(page, domains[0]!)).toHaveCount(0);
      expect(await currentCancel!.evaluate(button => button.isConnected)).toBe(true);
    }
    await page.keyboard.press('Enter');
    await expect(remove(page, domains[1]!)).toBeFocused();
    await expect(hostname).toHaveValue('draft.example.test');
  });
}
