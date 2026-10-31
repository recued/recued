import { expect, test, type Page, type Route } from '@playwright/test';
import { clickActionGlyph } from './helpers/action-glyph.js';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();

const calls = (page: Page, method: string): Promise<number> =>
  page.evaluate(name => window.__app.rpcCallCount(name), method);

test('device glyphs rename and revoke only the selected device, once after confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?devices=ready&settle_reads=1#settings/devices`);
  const laptop = page.locator('.account-devices-row[data-instance-id="device-laptop"]');
  await clickActionGlyph(page, laptop.getByRole('button', { name: 'Rename Travel laptop (device-laptop)', exact: true }));
  await page.getByRole('textbox', { name: 'New name for this device' }).fill('Travel laptop renamed');
  await page.evaluate(() => window.__app.holdRpcResponses?.('pair.rename'));
  const save = page.locator('[data-action="save-rename"][data-instance-id="device-laptop"]');
  await clickActionGlyph(page, save);
  await expect(save).toHaveText('Saving…');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await clickActionGlyph(page, save);
  expect(await calls(page, 'pair.rename')).toBe(1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.rename'))).toBe(1);
  await expect(laptop).toContainText('Travel laptop renamed');
  await expect(page.locator('.account-devices-row[data-instance-id="device-desktop"]')).toContainText('Office desktop');

  const revoke = laptop.getByRole('button', { name: 'Revoke Travel laptop renamed (device-laptop)', exact: true });
  await clickActionGlyph(page, revoke);
  const dialog = page.getByRole('alertdialog', { name: 'Confirm revoke Travel laptop renamed (device-laptop)' });
  await clickActionGlyph(page, dialog.getByRole('button', { name: 'Cancel revoke Travel laptop renamed (device-laptop)' }));
  await expect(dialog).toHaveCount(0);
  expect(await calls(page, 'pair.revoke')).toBe(0);

  await clickActionGlyph(page, revoke);
  await page.evaluate(() => window.__app.holdRpcResponses?.('pair.revoke'));
  const confirm = dialog.locator('[data-action="confirm-revoke"]');
  await clickActionGlyph(page, confirm);
  await expect(confirm).toHaveText('Revoking…');
  await clickActionGlyph(page, confirm);
  expect(await calls(page, 'pair.revoke')).toBe(1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.revoke'))).toBe(1);
  await expect(laptop).toHaveCount(0);
  await expect(page.locator('.account-devices-row[data-instance-id="device-desktop"]')).toBeVisible();
  await expect(page.locator('[data-action="revoke-device"][data-instance-id="device-current"]')).toHaveCount(0);
});

test('device Retry and Refresh glyphs keep reads single-flight and never revoke access', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?devices=fail-once-slow-retry&settle_reads=1#settings/devices`);
  const retry = page.locator('[data-action="retry-list"]');
  await expect(retry).toHaveText('Retry');
  await page.evaluate(() => window.__app.holdRpcResponses?.('pair.list'));
  await clickActionGlyph(page, retry);
  await expect(retry).toHaveText('Retrying…');
  await clickActionGlyph(page, retry);
  expect(await calls(page, 'pair.list')).toBe(2);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list'))).toBe(1);
  await expect(page.locator('.account-devices-row')).toHaveCount(3);
  const refresh = page.getByRole('button', { name: 'Refresh devices', exact: true });
  await clickActionGlyph(page, refresh);
  await expect(refresh).toHaveText('Refreshing…');
  await clickActionGlyph(page, refresh);
  expect(await calls(page, 'pair.list')).toBe(3);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list'))).toBe(1);
  await expect(refresh).toHaveText('Refresh');
  await expect(page.locator('[data-devices-last-checked] time')).toBeVisible();
  expect(await calls(page, 'pair.revoke')).toBe(0);
  expect(await calls(page, 'pair.rename')).toBe(0);
});

test('server-address glyphs preserve proof checking and cancel an unverified address', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?settle_reads=1#settings/servers`);
  const row = page.locator('[data-server-address-row]').first();
  const edit = row.getByRole('button', { name: 'Change address', exact: true });
  await clickActionGlyph(page, edit);
  const input = row.getByRole('textbox', { name: 'New server address', exact: true });
  const original = await input.inputValue();
  const probeUrl = new URL('/icon-address-fixture/auth/identity-probe', HARNESS_URL);
  const pending: { route?: Route; requests: number } = { requests: 0 };
  await page.route(probeUrl.href, route => { pending.route = route; pending.requests += 1; });
  await input.fill(`${probeUrl.origin.replace(/^http/, 'ws')}/icon-address-fixture/ws`);
  const check = row.getByRole('button', { name: 'Check address', exact: true });
  await clickActionGlyph(page, check);
  await expect(row.locator('[data-server-address-status]')).toHaveText('Checking…');
  await expect(check).toBeDisabled();
  await expect(row.locator('[data-server-address-save]')).toHaveCount(0);
  await clickActionGlyph(page, check);
  await expect.poll(() => pending.requests).toBe(1);
  if (!pending.route) throw new Error('The anonymous identity probe did not start.');
  await pending.route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  await expect(row).toHaveAttribute('data-server-address-row-state', 'refused');
  await expect(row.locator('[data-server-address-save]')).toHaveCount(0);
  await clickActionGlyph(page, row.getByRole('button', { name: 'Cancel', exact: true }));
  await expect(row).toHaveAttribute('data-server-address-row-state', 'idle');
  await clickActionGlyph(page, edit);
  await expect(input).toHaveValue(original);
});
