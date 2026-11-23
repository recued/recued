import { expect, test, type Locator, type Page } from '@playwright/test';
import { HARNESS_URL, SETTINGS_NAV_ITEM, installFullAppHooks } from './helpers/full-app.js';

const apply = (page: Page) => page.locator('[data-recued-updates-apply]');
const cancel = (page: Page) => page.locator('[data-recued-updates-apply-cancel]');
const press = async (target: Locator) => { await target.focus(); await target.press('Enter'); };
const boot = async (page: Page) => {
  await page.goto(`${HARNESS_URL}?settle_reads=1&updates=available-slow-apply#settings/updates`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(apply(page)).toHaveText('Update to 26.8.1');
};
installFullAppHooks();

test('Updates keyboard Cancel returns to the unarmed action without applying or rolling back', async ({ page }) => {
  await boot(page);
  await press(apply(page));
  await expect(apply(page)).toHaveText('Confirm update');
  await press(cancel(page));
  await expect(cancel(page)).toHaveCount(0);
  await expect(apply(page)).toHaveText('Update to 26.8.1');
  await expect(apply(page)).toBeFocused();
  expect(await page.evaluate(() => [window.__app.rpcCallCount('update.apply'), window.__app.rpcCallCount('update.rollback')])).toEqual([0, 0]);
});

for (const movedOutside of [false, true]) test(`Updates policy completion preserves ${movedOutside ? 'Settings navigation' : 'the current Cancel'} focus and deliberate confirmation`, async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    Object.assign(window, { __connectionsFixture: async (method: string, args: { mode?: string }) => method === 'update.set_mode'
      ? { result: { mode: args.mode, source: 'user', env_locked: false, channel_default: 'auto' } } : undefined });
    window.__app.holdRpcResponses?.('update.set_mode');
  });
  await press(apply(page));
  const mode = page.locator('[data-recued-updates-mode]');
  await mode.focus();
  await mode.selectOption('off');
  await expect(mode).toHaveAttribute('aria-busy', 'true');
  const owner = movedOutside ? page.locator(`[${SETTINGS_NAV_ITEM}="account"]`) : cancel(page);
  await owner.focus();
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('update.set_mode', 0))).toBe(1);
  await expect(mode).not.toHaveAttribute('aria-busy');
  await expect(mode).toHaveValue('off');
  await expect(apply(page)).toHaveText('Confirm update');
  await expect(owner).toBeFocused();
  expect(await page.evaluate(() => [window.__app.rpcCallCount('update.set_mode'), window.__app.rpcCallCount('update.apply')])).toEqual([1, 0]);
});

test('Updates unanswered receipt replaces stale restart copy and requires closure plus a reviewed baseline before unlocking', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { __connectionsFixture: async (method: string, args: { operation_id?: string }) => {
      if (method === 'update.apply') return { result: { status: 'restarting', to_version: '26.8.1', operation_id: args.operation_id } };
      if (method === 'update.operation_status') return { result: { status: 'unknown' } };
      if (method === 'update.operation_close') return { result: { status: 'closed_unresolved', operation: 'update' } };
      return undefined;
    } });
  });
  await boot(page);
  await press(apply(page));
  await press(apply(page));
  const recovery = page.locator('[data-recued-updates-receipt-recovery]');
  const oldResult = page.locator('[data-recued-updates-apply-result]');
  const rollback = page.locator('[data-recued-updates-rollback]');
  await expect(recovery).toContainText('Your server does not know about this update.');
  await expect(oldResult).toBeHidden();
  await expect(apply(page)).toBeDisabled();
  await expect(rollback).toBeDisabled();
  await press(page.locator('[data-recued-updates-receipt-closure-review-button]'));
  await expect(page.locator('[data-recued-updates-receipt-closure-review]')).toBeVisible();
  expect(await page.evaluate(() => window.__app.rpcCallCount('update.operation_close'))).toBe(0);
  await press(page.locator('[data-recued-updates-receipt-closure-confirm]'));
  const finish = page.locator('[data-recued-updates-receipt-closure-finish]');
  await expect(finish).toHaveText('Check how the server is');
  await expect(recovery).toContainText('It does not say it worked or failed.');
  await expect(oldResult).toBeHidden();
  await expect(apply(page)).toBeDisabled();
  await press(finish);
  await expect(finish).toHaveText('Finish recovery');
  await expect(page.locator('[data-recued-updates-receipt-baseline]')).toContainText('Running 26.8.0');
  await expect(apply(page)).toBeDisabled();
  await press(finish);
  await expect(recovery).toContainText('All sorted');
  await expect(apply(page)).toBeEnabled();
  await expect(rollback).toBeEnabled();
  await expect(oldResult).toBeHidden();
  await press(finish);
  await expect(recovery).toBeHidden();
  await press(page.locator('[data-recued-updates-check]'));
  await expect(page.locator('[data-recued-updates-page]')).toHaveAttribute('data-recued-updates-page-state', 'checked');
  await expect(oldResult).toBeHidden();
  expect(await page.evaluate(() => [
    window.__app.rpcCallCount('update.apply'), window.__app.rpcCallCount('update.rollback'),
    window.__app.rpcCallCount('update.operation_close'),
  ])).toEqual([1, 0, 1]);
});
