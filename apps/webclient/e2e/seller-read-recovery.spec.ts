import { expect, test, type Locator, type Page } from '@playwright/test';
import { DRAWER_TOGGLE, HARNESS_URL, SETTINGS_NAV_ITEM, installFullAppHooks } from './helpers/full-app.js';

const method = 'server.seller.getOverview';
const panel = (page: Page) => page.locator('[data-recued-seller-page]');
const refresh = (page: Page) => panel(page).locator('[data-recued-seller-refresh]');
const progress = (page: Page) => panel(page).getByRole('status');
const press = async (target: Locator) => { await target.focus(); await target.press('Enter'); };
const count = (page: Page) => page.evaluate(method => window.__app.rpcCallCount(method), method);
const release = (page: Page) => page.evaluate(method => window.__app.releaseRpcResponses?.(method, 0), method);
const open = async (page: Page, failReads = 0) => {
  // The full-app transport's opt-in fixture seam is method-scoped. Other
  // settings reads and all writes keep their normal fixture behavior.
  await page.addInitScript(failReads => {
    let reads = 0;
    (window as unknown as {
      __connectionsFixture: (method: string) => Promise<{ error: { code: string; message: string } } | undefined>;
    }).__connectionsFixture = async method => {
      if (method === 'server.seller.getOverview' && ++reads <= failReads) {
        return { error: { code: 'UNAVAILABLE', message: 'Seller read unavailable.' } };
      }
      return undefined;
    };
  }, failReads);
  await page.goto(`${HARNESS_URL}?settle_reads=1&hold_rpc=${method}#settings/seller/overview`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect.poll(() => count(page)).toBe(1);
  await release(page);
  await expect(panel(page)).toHaveAttribute('data-recued-seller-page-state', failReads > 0 ? 'error' : 'ready');
};

installFullAppHooks();

test('Seller read retry owns focus through repeated failure and recovery without duplicate reads or writes', async ({ page }) => {
  await open(page, 2);
  const oldRefresh = await refresh(page).elementHandle();
  await press(refresh(page));
  await expect.poll(() => count(page)).toBe(2);
  await expect(progress(page)).toBeFocused();
  // Detached controls can still deliver queued events. The loading phase
  // must reject them even though the new Refresh is natively disabled.
  await oldRefresh!.evaluate(button => {
    if (!(button instanceof HTMLButtonElement)) throw new Error('Expected the old Refresh button');
    button.click(); button.click();
  });
  expect(await count(page)).toBe(2);
  await release(page);
  await expect(panel(page)).toHaveAttribute('data-recued-seller-page-state', 'error');
  await expect(refresh(page)).toBeFocused();
  await press(refresh(page));
  await expect.poll(() => count(page)).toBe(3);
  await expect(progress(page)).toBeFocused();
  await release(page);
  await expect(panel(page)).toHaveAttribute('data-recued-seller-page-state', 'ready');
  await expect(refresh(page)).toBeFocused();
  expect(await page.evaluate(() => [
    'updateSettings', 'upsertManualTier', 'setOfferCheckoutUrl',
    'transitionOfferState', 'reapplyManualTier', 'issueManualCustomer',
    'extendManualCustomer', 'swapManualCustomerTier', 'closeManualCustomer',
    'reissueManualCustomerToken', 'acknowledgeLlmGatewayPaid',
  ].map(name => window.__app.rpcCallCount(`server.seller.${name}`)))).toEqual(Array(11).fill(0));
});

test('Seller read completion respects focus moved to Settings navigation', async ({ page }) => {
  await open(page);
  await press(refresh(page));
  await expect.poll(() => count(page)).toBe(2);
  const outside = page.locator(`[${SETTINGS_NAV_ITEM}="account"]`);
  await outside.focus();
  await release(page);
  await expect(panel(page)).toHaveAttribute('data-recued-seller-page-state', 'ready');
  await expect(outside).toBeFocused();
});

test('Seller read reply cannot revive a departed route or steal its focus', async ({ page }) => {
  await open(page);
  await press(refresh(page));
  await expect.poll(() => count(page)).toBe(2);
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(panel(page)).toHaveCount(0);
  const outside = page.locator(`[${DRAWER_TOGGLE}]`);
  await outside.focus();
  expect(await release(page)).toBe(1);
  await expect(page).toHaveURL(/#chat$/);
  await expect(panel(page)).toHaveCount(0);
  await expect(outside).toBeFocused();
});

test('Seller order detail distinguishes a failed read from a verified missing order', async ({ page }) => {
  await page.addInitScript(() => {
    let reads = 0;
    (window as unknown as {
      __connectionsFixture: (method: string) => Promise<{ error: { code: string; message: string } } | undefined>;
    }).__connectionsFixture = async method => {
      if (method === 'server.seller.listOrders' && ++reads === 1) {
        return { error: { code: 'UNAVAILABLE', message: 'Order read unavailable.' } };
      }
      return undefined;
    };
  });
  await page.goto(`${HARNESS_URL}?settle_reads=1#settings/seller/orders/detail/ord%3Aaccess%3Aclaim-mail-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(panel(page).getByRole('alert')).toContainText('Order read unavailable.');
  await expect(panel(page).getByRole('heading', { name: 'Item not found' })).toHaveCount(0);
  await press(refresh(page));
  await expect(panel(page).locator('[data-recued-seller-order-row="ord:access:claim-mail-1"]')).toBeVisible();
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => window.__app.setHash('#settings/seller/orders/detail/missing-order'));
  await expect(panel(page).getByRole('heading', { name: 'Item not found' })).toBeVisible();
});
