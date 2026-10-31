import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { clickActionGlyph } from './helpers/action-glyph.js';

installFullAppHooks();

test('Yours glyphs open the same editor and refresh its asset', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/asset/passport`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const route = page.locator('[data-recued-yours]');
  await expect(route).toHaveAttribute('aria-busy', 'false');
  await clickActionGlyph(page, route.getByRole('button', { name: 'Edit asset', exact: true }));
  const editor = route.locator('[data-yours-editor]');
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Ana’s passport');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.evaluate(() => window.__app.holdRpcResponses?.('yours.read'));
  const before = await page.evaluate(() => window.__app.rpcCallCount('yours.read'));
  await clickActionGlyph(page, route.getByRole('button', { name: 'Refresh', exact: true }));
  await expect(route.getByRole('button', { name: 'Refreshing…', exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(before + 1);
  await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.read'));
  await expect(route).toHaveAttribute('aria-busy', 'false');
});

test('Runs glyph refreshes active runs without starting an execution', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?live=running#logs/active`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const refresh = page.locator('[data-recued-logs-action="refresh-active"]');
  await expect(refresh).not.toHaveAttribute('aria-busy');
  await page.evaluate(() => window.__app.holdRpcResponses?.('execution.active'));
  const before = await page.evaluate(() => ({ reads: window.__app.rpcCallCount('execution.active'), writes: window.__app.rpcCallCount('execute') }));
  await clickActionGlyph(page, refresh);
  await expect(refresh).toHaveText('Refreshing…');
  await clickActionGlyph(page, refresh);
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('execution.active'))).toBe(before.reads + 1);
  expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(before.writes);
  await page.evaluate(() => window.__app.releaseRpcResponses?.('execution.active'));
  await expect(refresh).toHaveText('Refresh');
});

test('Contracts glyphs open limits and submit one guarded update', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?contracts=paged#contracts/door_paged_01`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const route = page.locator('[data-recued-contracts-route]');
  await clickActionGlyph(page, route.getByRole('button', { name: 'Change limits', exact: true }));
  const form = route.getByRole('group', { name: 'Change limits', exact: true });
  await form.getByRole('spinbutton').fill('37');
  await page.evaluate(() => window.__app.holdRpcResponses?.('collection.contract.setLimits'));
  const before = await page.evaluate(() => window.__app.rpcCallCount('collection.contract.setLimits'));
  await clickActionGlyph(page, form.getByRole('button', { name: 'Save limits', exact: true }));
  const busy = form.getByRole('button', { name: 'Saving…', exact: true });
  await expect(busy).toHaveAttribute('aria-disabled', 'true');
  await expect(busy).toHaveAttribute('aria-busy', 'true');
  await clickActionGlyph(page, busy);
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('collection.contract.setLimits'))).toBe(before + 1);
});
