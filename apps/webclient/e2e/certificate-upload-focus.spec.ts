import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL } from './helpers/full-app.js';

declare global {
  interface Window {
    __certificateUploadFocus: { uploads: unknown[]; removals: unknown[]; listReady: boolean };
  }
}

const domains = ['server-a.example.test', 'server-b.example.test'];
const panel = (page: Page) => page.locator('[data-recued-tls-certs-panel]');
const row = (page: Page, domain: string) => panel(page).locator(`[data-recued-tls-certs-row="${domain}"]`);
const remove = (page: Page, domain: string) => row(page, domain).getByRole('button', { name: 'Remove', exact: true });
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
    const fixture = {
      uploads: [] as unknown[], removals: [] as unknown[],
      listReady: new URLSearchParams(location.search).get('certificate_list_error') !== '1',
    };
    Object.assign(window, {
      __certificateUploadFocus: fixture,
      __connectionsFixture: async (method: string, args: unknown) => {
        if (method === 'tls_domain.list' && !fixture.listReady) {
          return { error: { code: 'UNAVAILABLE', message: 'Synthetic inventory unavailable' } };
        }
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
  const { uploads, removals } = await page.evaluate(() => window.__certificateUploadFocus);
  expect({ uploads, removals }).toEqual({ uploads: [], removals: [] });
});

const open = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${HARNESS_URL}?settle_reads=1&notifications=ready&yours=demo#settings/server/certificates`);
  await page.waitForFunction(() => window.__app?.ready === true);
  for (const domain of domains) await expect(remove(page, domain)).toBeEnabled();
};

const trigger = (page: Page, domain?: string) => domain === undefined
  ? panel(page).getByRole('button', { name: 'Upload a certificate', exact: true })
  : row(page, domain).getByRole('button', { name: 'Replace', exact: true });
const form = (page: Page) => panel(page).locator('[data-recued-tls-certs-upload-form]');
const hostname = (page: Page) => form(page).locator('[data-recued-tls-certs-upload-field="domain"]');
const cancelUpload = (page: Page) => form(page).getByRole('button', { name: 'Cancel', exact: true });

for (const width of [390, 1280]) {
  test(`Certificates upload focus follows a pending inventory read after Cancel at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HARNESS_URL}?settle_reads=1&notifications=ready&yours=demo&certificate_list_error=1#settings/server/certificates`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const retry = panel(page).getByRole('button', { name: 'Retry loading certificates', exact: true });
    await expect(retry).toBeVisible();
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(hostname(page)).toBeFocused();
    await page.evaluate(() => {
      window.__certificateUploadFocus.listReady = true;
      window.__app.holdRpcResponses?.('tls_domain.list');
    });
    await retry.focus();
    await page.keyboard.press('Enter');
    const loading = panel(page).locator('[data-recued-tls-certs-status]');
    await expect(loading).toBeFocused();
    await cancelUpload(page).focus();
    await page.keyboard.press('Space');
    await expect(form(page)).toHaveCount(0);
    await expect(trigger(page)).toBeDisabled();
    await expect(loading).toBeFocused();
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('tls_domain.list'))).toBe(1);
    await expect(trigger(page)).toBeEnabled();
    await expect(panel(page).getByRole('heading', { name: 'Installed certificates', exact: true })).toBeFocused();
  });

  test(`Certificates upload focus follows the original action after hostname edits at ${width}px`, async ({ page, browserName }) => {
    await open(page, width);
    // Exercise the second row before the first; the edited hostname is not the origin.
    for (const [index, domain] of [undefined, domains[1], domains[0]].entries()) {
      await trigger(page, domain).focus();
      await page.keyboard.press(index === 1 ? 'Space' : 'Enter');
      await expect(hostname(page)).toBeFocused();
      await expect(hostname(page)).toHaveValue(domain ?? '');
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(form(page).locator('[data-recued-tls-certs-upload-field="cert_pem"]')).toBeFocused();
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
      await expect(hostname(page)).toBeFocused();
      await hostname(page).fill('edited.example.test');
      await cancelUpload(page).focus();
      await page.keyboard.press(index === 1 ? 'Enter' : 'Space');
      await expect(form(page)).toHaveCount(0);
      await expect(trigger(page, domain)).toBeFocused();
    }
  });

  test(`Certificates upload focus preserves other edits and rejects retired controls at ${width}px`, async ({ page }) => {
    await open(page, width);
    await panel(page).evaluate(node => {
      const input = document.createElement('input');
      input.id = 'certificate-outside-edit';
      input.setAttribute('aria-label', 'Fixture outside edit');
      input.value = 'outside draft';
      node.before(input);
    });
    const outside = page.locator('#certificate-outside-edit');
    await outside.focus();
    await outside.evaluate(input => (input as HTMLInputElement).setSelectionRange(2, 5));
    const originalOutside = await outside.elementHandle();
    const retiredOpen = await trigger(page).elementHandle();
    const retiredReplace = await trigger(page, domains[0]!).elementHandle();
    await trigger(page).evaluate(button => (button as HTMLButtonElement).click());
    await expect(hostname(page)).toBeVisible();
    await expect(outside).toBeFocused();
    const retiredCancel = await cancelUpload(page).elementHandle();
    await cancelUpload(page).evaluate(button => (button as HTMLButtonElement).click());
    await expect(form(page)).toHaveCount(0);
    await expect(outside).toBeFocused();
    expect(await originalOutside!.evaluate(input => input.isConnected)).toBe(true);
    expect(await outside.evaluate(input => ({ start: (input as HTMLInputElement).selectionStart, end: (input as HTMLInputElement).selectionEnd }))).toEqual({ start: 2, end: 5 });
    await expect(outside).toHaveValue('outside draft');

    await trigger(page, domains[1]!).focus();
    await page.keyboard.press('Enter');
    await expect(hostname(page)).toBeFocused();
    const currentForm = await form(page).elementHandle();
    await hostname(page).fill('newer.example.test');
    await hostname(page).evaluate(input => (input as HTMLInputElement).setSelectionRange(2, 5));
    for (const retired of [retiredOpen, retiredReplace, retiredCancel]) {
      expect(await retired!.evaluate(button => button.isConnected)).toBe(false);
      await retired!.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await expect(hostname(page)).toBeFocused();
      await expect(hostname(page)).toHaveValue('newer.example.test');
      expect(await hostname(page).evaluate(input => ({ start: (input as HTMLInputElement).selectionStart, end: (input as HTMLInputElement).selectionEnd }))).toEqual({ start: 2, end: 5 });
      expect(await currentForm!.evaluate(node => node.isConnected)).toBe(true);
    }
    await cancelUpload(page).focus();
    await page.keyboard.press('Enter');
    await expect(form(page)).toHaveCount(0);
    await expect(trigger(page, domains[1]!)).toBeFocused();
  });
}
