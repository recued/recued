import { expect, test } from '@playwright/test';
import { installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
const setup = '[data-backup-watchdog]';
const urlInput = '[data-backup-watchdog-url]';
const enabled = '[data-backup-watchdog-enabled]';
const save = '[data-backup-watchdog-save]';
const feedback = '[data-backup-watchdog-feedback]';

test('write-only monitor setup preserves newer drafts, clears on route exit and supports removal', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
  await expect(page.locator(save)).toBeEnabled(); await expect(page.locator(setup)).toContainText('another host');
  await page.locator(enabled).check(); await page.locator(urlInput).fill('https://monitor.example/private-watchdog-first');
  await page.evaluate(() => window.__app.holdRpcResponses!('server.archive.watchdog.save'));
  await page.locator(save).click(); await expect(page.locator(save)).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
  await page.locator(urlInput).fill('https://monitor.example/private-watchdog-newer'); await page.locator(urlInput).focus();
  await page.evaluate(() => window.__app.releaseRpcResponses!('server.archive.watchdog.save'));
  await expect(page.locator(feedback)).toContainText('newer edits'); await expect(page.locator(urlInput)).toBeFocused();
  await expect(page.locator(urlInput)).toHaveValue('https://monitor.example/private-watchdog-newer');
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
  const overflow = await page.locator(setup).evaluate(node => ({ content: node.scrollWidth > node.clientWidth,
    page: document.documentElement.scrollWidth > window.innerWidth }));
  expect(overflow).toEqual({ content: false, page: false });
  const previousInput = await page.locator(urlInput).elementHandle();
  await page.evaluate(() => window.__app.setHash('#chat')); await expect(page.locator(setup)).toHaveCount(0);
  expect(await previousInput!.evaluate(node => node instanceof HTMLInputElement ? node.value : null)).toBe('');
  await page.evaluate(() => window.__app.setHash('#settings/backup')); await expect(page.locator(save)).toBeEnabled();
  await expect(page.locator(urlInput)).toHaveValue(''); await expect(page.locator(enabled)).toBeChecked();
  expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join())).not.toContain('private-watchdog');
  await page.locator('[data-backup-watchdog-remove]').click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(2);
  await page.evaluate(() => window.__app.releaseRpcResponses!('server.archive.watchdog.save'));
  await expect(page.locator(feedback)).toContainText('Monitor removed');
  await expect(page.locator(enabled)).not.toBeChecked(); await expect(page.locator('[data-backup-watchdog-remove]')).toBeDisabled();
});

test('a reconnect never replays an uncertain credential save', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/backup')); await expect(page.locator(save)).toBeEnabled();
  await page.locator(enabled).check(); await page.locator(urlInput).fill('https://monitor.example/private-watchdog-uncertain');
  await page.evaluate(() => window.__app.holdRpcResponses!('server.archive.watchdog.save')); await page.locator(save).click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
  await page.evaluate(() => { window.__app.setServerAvailable(false); window.__app.fireState('closed'); });
  await expect(page.locator(feedback)).toContainText('could not be confirmed');
  await page.evaluate(() => { window.__app.setServerAvailable(true); window.__app.fireState('connected'); });
  await page.evaluate(() => window.__app.releaseRpcResponses!('server.archive.watchdog.save'));
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
  await page.evaluate(() => window.__app.setHash('#chat')); await expect(page.locator(setup)).toHaveCount(0);
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
  await expect(page.locator(save)).toBeEnabled(); await expect(page.locator(enabled)).toBeChecked(); await expect(page.locator(urlInput)).toHaveValue('');
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
});
