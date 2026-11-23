import { expect, test, type Page } from '@playwright/test';
import { DRAWER_TOGGLE, HARNESS_URL, SETTINGS_NAV_ITEM, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
const read = 'server.getLLMConfig';
const state = '[data-recued-ai-models-page]';
const openFailed = async (page: Page) => {
  await page.goto(`${HARNESS_URL}?ai=empty#settings/ai-models/setup/start`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator(state)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
  await page.evaluate(async () => { window.__app.failNextAiModelsConfigRead!(); await window.__app.refreshAiModels!(); });
  const setup = page.locator('[data-recued-ai-models-chat-setup]');
  const retry = setup.getByRole('button', { name: 'Try again', exact: true });
  await expect(retry).toBeVisible();
  return { setup, retry };
};
const noWrites = async (page: Page) => {
  for (const method of ['server.setLLMSlot', 'chat.default_model_pref.set', 'server.probeLlmSource']) {
    expect(await page.evaluate(method => window.__app.rpcCallCount(method), method)).toBe(0);
  }
};

test('Set up Chat read retry keeps recovery focus and one pending read through failure and success', async ({ page }) => {
  const { setup, retry } = await openFailed(page);
  await page.evaluate(method => { window.__app.holdRpcResponses!(method); window.__app.failNextAiModelsConfigRead!(); }, read);
  const before = await page.evaluate(method => window.__app.rpcCallCount(method), read);
  const original = await retry.elementHandle();
  await retry.focus(); await page.keyboard.press('Enter');
  const progress = setup.locator('[data-recued-ai-models-chat-setup-status="loading"]');
  await expect(progress).toBeFocused(); await expect(progress).toHaveAttribute('tabindex', '-1');
  await original!.evaluate((button: HTMLElement) => { button.click(); button.click(); });
  expect(await page.evaluate(method => window.__app.rpcCallCount(method), read)).toBe(before + 1);
  expect(await page.evaluate(method => window.__app.releaseRpcResponses!(method), read)).toBe(1);
  await expect(retry).toBeFocused();
  await expect(setup.locator('[data-recued-ai-models-chat-setup-error="load"]')).toBeVisible();
  await page.keyboard.press('Enter'); await expect(progress).toBeFocused();
  expect(await page.evaluate(method => window.__app.releaseRpcResponses!(method), read)).toBe(1);
  const provider = setup.getByRole('combobox', { name: 'Provider', exact: true });
  await expect(provider).toBeFocused(); await expect(retry).toHaveCount(0);
  expect(await page.evaluate(method => window.__app.rpcCallCount(method), read)).toBe(before + 2);
  await noWrites(page);
});

for (const leaves of [false, true]) test(`Set up Chat read retry retires focus when ${leaves ? 'the route is left' : 'the owner moves elsewhere'}`, async ({ page }) => {
  const { setup, retry } = await openFailed(page);
  await page.evaluate(method => window.__app.holdRpcResponses!(method), read);
  await retry.focus(); await page.keyboard.press('Enter');
  await expect(setup.locator('[data-recued-ai-models-chat-setup-status="loading"]')).toBeFocused();
  if (leaves) { await page.evaluate(() => window.__app.setHash('#chat')); await expect(setup).toHaveCount(0); }
  const outside = page.locator(leaves ? `[${DRAWER_TOGGLE}]` : `[${SETTINGS_NAV_ITEM}="account"]`);
  await outside.focus();
  // Deliver the setup read alone. Chat can start a separate read on mount.
  expect(await page.evaluate(method => window.__app.releaseRpcResponses!(method, 0), read)).toBe(1);
  if (leaves) { await expect(setup).toHaveCount(0); await expect(page).toHaveURL(/#chat$/); }
  else await expect(setup.getByRole('combobox', { name: 'Provider', exact: true })).toBeVisible();
  await expect(outside).toBeFocused(); await noWrites(page);
});
