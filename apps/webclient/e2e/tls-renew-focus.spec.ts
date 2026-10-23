import { expect, test, type Page } from '@playwright/test';
import type { RotationResult } from '@recued/contracts';
import { FIXED_NOW, HARNESS_URL } from './helpers/full-app.js';

type Outcome = 'success' | 'refused' | 'transport';
type Reply = { result?: RotationResult; error?: { code: string; message: string } };
interface TlsRenewFocusFixture {
  calls: unknown[];
  blockedWrites: string[];
  release(index: number, outcome: Outcome): void;
}
declare global { interface Window { __tlsRenewFocus: TlsRenewFocusFixture } }

const panel = (page: Page) => page.locator('[data-recued-tls-renew-panel]');
const button = (page: Page, name: string) => panel(page).getByRole('button', { name, exact: true });
const status = (page: Page) => panel(page).getByRole('status');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside certificate renewal', exact: true });
const state = (page: Page, value: string) => expect(panel(page)).toHaveAttribute('data-recued-tls-renew-panel-state', value);
const drain = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const release = (page: Page, index: number, outcome: Outcome) =>
  page.evaluate(args => window.__tlsRenewFocus.release(args.index, args.outcome), { index, outcome });
let pageErrors: string[] = [];
let externalRequests: string[] = [];

// Renewal replies are held, synthetic, and local. No provider or certificate tool runs.
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  externalRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(HARNESS_URL).origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
});
test.afterEach(async ({ page }) => {
  expect(pageErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
  const receipt = await page.evaluate(() => ({
    calls: window.__tlsRenewFocus.calls,
    blocked: window.__tlsRenewFocus.blockedWrites,
    count: window.__app.rpcCallCount('tls.renew'),
  }));
  expect(receipt.blocked).toEqual([]);
  expect(receipt.calls).toEqual(Array.from({ length: receipt.count }, () => ({})));
});

const open = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(now => {
    const pending: Array<((reply: Reply) => void) | null> = [];
    const fixture: TlsRenewFocusFixture = {
      calls: [], blockedWrites: [],
      release(index, outcome) {
        const resolve = pending[index];
        if (!resolve) throw new Error(`No pending local renewal ${index}`);
        pending[index] = null;
        if (outcome === 'transport') {
          resolve({ error: { code: 'UNAVAILABLE', message: 'Synthetic renewal connection failure' } });
          return;
        }
        resolve({ result: outcome === 'success'
          ? { ok: true, op: 'tls_renew', key_class: 'tls_private_key',
            new_fingerprint: 'sha256:SYNTHETIC', rotated_at: now + 7 * 86400000 }
          : { ok: false, op: 'tls_renew', error: 'acme_helper_unavailable', message: 'Synthetic local refusal' } });
      },
    };
    Object.assign(window, {
      __tlsRenewFocus: fixture,
      __connectionsFixture: async (method: string, args: unknown) => {
        if (method === 'tls_domain.list') return { result: { entries: [] } };
        if (method === 'tls.renew') {
          fixture.calls.push(args);
          return new Promise<Reply>(resolve => { pending.push(resolve); });
        }
        if (['tls_domain.upload', 'tls_domain.remove', 'key.rotate'].includes(method)) {
          fixture.blockedWrites.push(method);
          return { error: { code: 'FORBIDDEN', message: 'Unexpected local fixture write' } };
        }
        return undefined;
      },
    });
    const target = document.createElement('button');
    target.textContent = 'Outside certificate renewal';
    document.body.appendChild(target);
    window.__app.setHash('#settings/server/certificates');
  }, FIXED_NOW);
  await expect(button(page, 'Renew now')).toBeVisible();
  await drain(page);
  await outside(page).focus();
  await expect(outside(page)).toBeFocused();
};

const enterConfirmation = async (page: Page, key = 'Enter') => {
  await button(page, 'Renew now').focus();
  await page.keyboard.press(key);
  await state(page, 'confirm');
  await expect(button(page, 'Cancel')).toBeFocused();
  await expect(button(page, 'Cancel')).toBeInViewport();
  await expect(panel(page).getByRole('alert')).toContainText('accept the new one without pairing again');
};
const beginRenewal = async (page: Page, browserName: string, key = 'Enter') => {
  await enterConfirmation(page, key);
  const oldCancel = await button(page, 'Cancel').elementHandle();
  const oldConfirm = await button(page, 'Yes, renew').elementHandle();
  // WebKit on macOS uses Option-Tab for native traversal that includes buttons.
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(button(page, 'Yes, renew')).toBeFocused();
  await page.keyboard.press(key);
  await state(page, 'busy');
  await expect(status(page)).toHaveText('Getting a new certificate…');
  await expect(status(page)).toHaveAttribute('tabindex', '-1');
  await expect(status(page)).toHaveAttribute('aria-atomic', 'true');
  await expect(status(page)).toBeFocused();
  await expect(status(page)).toBeInViewport();
  await expect(button(page, 'Cancel')).toBeDisabled();
  await expect(button(page, 'Yes, renew')).toBeDisabled();
  await oldCancel!.evaluate(node => (node as HTMLButtonElement).click());
  await oldConfirm!.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
  await page.keyboard.press('Enter');
  await state(page, 'busy');
  expect(await page.evaluate(() => window.__tlsRenewFocus.calls)).toEqual([{}]);
};

for (const width of [390, 1280]) {
  const key = width === 390 ? 'Space' : 'Enter';
  test(`Certificate renewal focuses safe Cancel and restores Renew now at ${width}px`, async ({ page }, info) => {
    await open(page, width);
    const oldRenew = await button(page, 'Renew now').elementHandle();
    await enterConfirmation(page, key);
    await oldRenew!.evaluate(node => (node as HTMLButtonElement).click());
    await expect(button(page, 'Cancel')).toBeFocused();
    await page.screenshot({ path: info.outputPath('confirmation.png'), fullPage: true });
    await page.keyboard.press(key);
    await state(page, 'idle');
    await expect(button(page, 'Renew now')).toBeFocused();
    await oldRenew!.evaluate(node => (node as HTMLButtonElement).click());
    await state(page, 'idle');
    await expect(button(page, 'Renew now')).toBeFocused();
    expect(await page.evaluate(() => window.__tlsRenewFocus.calls)).toEqual([]);
  });

  for (const outcome of ['success', 'refused', 'transport'] as const) {
    for (const owner of ['panel', 'outside', 'blurred'] as const) {
      test(`Certificate renewal ${outcome} respects ${owner} focus at ${width}px`, async ({ page, browserName }, info) => {
        await open(page, width);
        await beginRenewal(page, browserName, key);
        if (owner === 'outside') {
          await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
          await expect(status(page)).not.toBeFocused();
          await outside(page).focus();
        }
        if (owner === 'blurred') await status(page).evaluate(node => (node as HTMLElement).blur());
        await release(page, 0, outcome);
        await state(page, outcome === 'success' ? 'done' : 'error');
        const result = button(page, outcome === 'success' ? 'Close' : 'Retry');
        if (owner === 'panel') {
          await expect(result).toBeFocused();
          await expect(result).toBeInViewport();
          await page.screenshot({ path: info.outputPath(`${outcome}.png`), fullPage: true });
        } else if (owner === 'outside') await expect(outside(page)).toBeFocused();
        else expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
        expect(await page.evaluate(() => window.__tlsRenewFocus.calls)).toEqual([{}]);
        if (outcome === 'success') {
          await expect(panel(page).locator('[data-recued-tls-renew-fingerprint]')).toHaveText('sha256:SYNTHETIC');
          await result.focus();
          await page.keyboard.press(key);
        } else {
          await expect(panel(page).getByRole('alert')).toContainText(outcome === 'refused' ? 'acme_helper_unavailable' : 'Synthetic renewal connection failure');
          await result.focus();
          await page.keyboard.press(key);
          await state(page, 'confirm');
          await expect(button(page, 'Cancel')).toBeFocused();
          expect(await page.evaluate(() => window.__tlsRenewFocus.calls)).toHaveLength(1);
          await page.keyboard.press(key);
        }
        await state(page, 'idle');
        await expect(button(page, 'Renew now')).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });
    }

    test(`Certificate renewal ignores disposed ${outcome} after remount at ${width}px`, async ({ page, browserName }) => {
      await open(page, width);
      await beginRenewal(page, browserName, key);
      await page.evaluate(() => window.__app.setHash('#yours'));
      await expect(panel(page)).toHaveCount(0);
      await page.evaluate(() => window.__app.setHash('#settings/server/certificates'));
      await expect(button(page, 'Renew now')).toBeVisible();
      await enterConfirmation(page, key);
      const current = await button(page, 'Cancel').elementHandle();
      await release(page, 0, outcome);
      await drain(page);
      await state(page, 'confirm');
      expect(await current!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      await expect(button(page, 'Cancel')).toBeFocused();
      expect(await page.evaluate(() => window.__tlsRenewFocus.calls)).toEqual([{}]);
    });
  }

  test(`Certificate renewal leaves another Server tab focused after completion at ${width}px`, async ({ page, browserName }) => {
    await open(page, width);
    await beginRenewal(page, browserName, key);
    const connect = page.getByRole('tab', { name: 'Connect a device', exact: true });
    await connect.focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeHidden();
    await release(page, 0, 'success');
    await state(page, 'done');
    await expect(connect).toBeFocused();
    await expect(connect).toHaveAttribute('aria-selected', 'true');
  });
}
