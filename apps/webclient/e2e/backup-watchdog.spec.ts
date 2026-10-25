import { openBackupDisclosure } from './helpers/backup-disclosure.js';
import { expect, test } from '@playwright/test';
import { installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
const setup = '[data-backup-watchdog]';
const urlInput = '[data-backup-watchdog-url]';
const enabled = '[data-backup-watchdog-enabled]';
const save = '[data-backup-watchdog-save]';
const feedback = '[data-backup-watchdog-feedback]';
const urlError = '[data-backup-watchdog-url-error]';

for (const width of [390, 1280]) test.describe(`monitor URL validation at ${width}px`, () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.__app.setHash('#settings/backup')); await openBackupDisclosure(page, 'tools'); await expect(page.locator(save)).toBeEnabled();
  });

  test('identifies invalid URLs without a write and clears the error when corrected', async ({ page }) => {
    const url = page.locator(urlInput), error = page.locator(urlError), node = await url.elementHandle();
    await page.locator(enabled).check(); await page.locator(save).focus(); await page.keyboard.press('Enter');
    await expect(error).toHaveText('Enter the monitor success-ping URL once.'); await expect(url).toBeFocused();
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    await expect(url).toHaveAttribute('aria-describedby', (await error.getAttribute('id'))!);
    for (const invalid of ['http://monitor.example/private-validation-token', 'https://monitor.example/ping?private=validation-token',
      'https://monitor.example:8443/private-validation-token', 'https://private-validation-token@monitor.example/ping', 'https://monitor.example/ping#private-validation-token']) {
      await url.fill(invalid); await page.locator(save).click();
      await expect(error).toContainText('HTTPS'); await expect(url).toBeFocused(); await expect(url).toHaveValue(invalid);
      expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(0);
    }
    await page.evaluate(() => window.__app.fireState('connected'));
    await expect(error).toBeVisible(); await expect(url).toBeFocused();
    expect(await node!.evaluate(node => node.isConnected && node === document.querySelector('[data-backup-watchdog-url]'))).toBe(true);
    await expect(page.locator(setup)).not.toContainText('private-validation-token');
    await expect(page.locator(feedback)).not.toContainText('could not be confirmed');
    expect(await page.locator(setup).evaluate(node => ({ content: node.scrollWidth > node.clientWidth,
      page: document.documentElement.scrollWidth > innerWidth }))).toEqual({ content: false, page: false });
    await url.fill('https://monitor.example/private-validation-token'); await expect(error).toBeHidden();
    await expect(url).not.toHaveAttribute('aria-invalid'); await expect(url).not.toHaveAttribute('aria-describedby');
    await expect(url).toBeFocused(); await page.locator(save).click();
    await expect(page.locator(feedback)).toContainText('Monitor setup saved.'); await expect(url).toHaveValue('');
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
    expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join())).not.toContain('private-validation-token');
  });

  test('keeps a saved URL when blank and removes the monitor despite an invalid replacement', async ({ page }) => {
    const url = page.locator(urlInput), error = page.locator(urlError);
    await page.locator(enabled).check(); await url.fill('https://monitor.example/private-existing-token'); await page.locator(save).click();
    await expect(url).toHaveValue(''); await expect(page.locator(save)).toBeEnabled();
    await url.fill('http://monitor.example/private-replacement'); await page.locator(save).click(); await expect(error).toBeVisible();
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
    await url.fill(''); await page.locator(enabled).uncheck(); await page.locator(save).click();
    await expect(error).toBeHidden(); await expect(page.locator(save)).toBeEnabled();
    await expect(page.locator('[data-backup-watchdog-remove]')).toBeEnabled();
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(2);
    await url.fill('http://monitor.example/private-replacement'); await page.locator(save).click(); await expect(error).toBeVisible();
    await page.locator('[data-backup-watchdog-remove]').focus(); await page.keyboard.press('Enter');
    await expect(page.locator(feedback)).toContainText('Monitor removed.'); await expect(url).toHaveValue('');
    await expect(error).toBeHidden(); await expect(url).not.toHaveAttribute('aria-invalid');
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(3);
  });
});

test('write-only monitor setup preserves newer drafts, clears on route exit and supports removal', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/backup')); await openBackupDisclosure(page, 'tools');
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
  await page.evaluate(() => window.__app.setHash('#settings/backup')); await openBackupDisclosure(page, 'tools'); await expect(page.locator(save)).toBeEnabled();
  await expect(page.locator(urlInput)).toHaveValue(''); await expect(page.locator(enabled)).toBeChecked();
  expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join())).not.toContain('private-watchdog');
  await page.locator('[data-backup-watchdog-remove]').click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(2);
  await page.evaluate(() => window.__app.releaseRpcResponses!('server.archive.watchdog.save'));
  await expect(page.locator(feedback)).toContainText('Monitor removed');
  await expect(page.locator(enabled)).not.toBeChecked(); await expect(page.locator('[data-backup-watchdog-remove]')).toBeDisabled();
});

test('a reconnect never replays an uncertain credential save', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/backup')); await openBackupDisclosure(page, 'tools'); await expect(page.locator(save)).toBeEnabled();
  await page.locator(enabled).check(); await page.locator(urlInput).fill('https://monitor.example/private-watchdog-uncertain');
  await page.evaluate(() => window.__app.holdRpcResponses!('server.archive.watchdog.save')); await page.locator(save).click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
  await page.evaluate(() => { window.__app.setServerAvailable(false); window.__app.fireState('closed'); });
  await expect(page.locator(feedback)).toContainText('could not be confirmed');
  await page.evaluate(() => { window.__app.setServerAvailable(true); window.__app.fireState('connected'); });
  await page.evaluate(() => window.__app.releaseRpcResponses!('server.archive.watchdog.save'));
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
  await expect(page.locator(save)).toBeEnabled(); const warning = await page.locator(feedback).textContent();
  await page.locator(urlInput).fill('http://monitor.example/private-invalid-after-uncertain'); await page.locator(save).click();
  await expect(page.locator(urlError)).toBeVisible(); await expect(page.locator(urlInput)).toBeFocused();
  await expect(page.locator(feedback)).toHaveText(warning!);
  await page.locator('[data-backup-watchdog-discard]').click(); await expect(page.locator(urlError)).toBeHidden();
  await expect(page.locator(urlInput)).not.toHaveAttribute('aria-invalid'); await expect(page.locator(feedback)).toHaveText(warning!);
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
  await page.evaluate(() => window.__app.setHash('#chat')); await expect(page.locator(setup)).toHaveCount(0);
  await page.evaluate(() => window.__app.setHash('#settings/backup')); await openBackupDisclosure(page, 'tools');
  await expect(page.locator(save)).toBeEnabled(); await expect(page.locator(enabled)).toBeChecked(); await expect(page.locator(urlInput)).toHaveValue('');
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
});
