import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
test.beforeEach(async ({ page }) => {
  await page.goto(`${HARNESS_URL}?backup_watchdog_drill=ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
});
const drill = (name: string) => `[data-backup-watchdog-drill-${name}]`;

test('an explicit pause survives route exit and completes only after the owner report and a fresh fixture ping', async ({ page }) => {
  await expect(page.locator(drill('review'))).toBeEnabled();
  await page.locator(drill('duration')).selectOption('15'); await page.locator(drill('review')).click();
  await expect(page.locator(drill('warning'))).toBeVisible(); await expect(page.locator(drill('start'))).toContainText('15 minutes');
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.start'))).toBe(0);
  await page.locator(drill('back')).click(); await expect(page.locator(drill('start'))).toBeHidden();
  await page.locator(drill('review')).click(); await page.locator(drill('start')).click();
  await expect(page.locator(drill('status'))).toContainText('Pings are paused until');
  await expect(page.locator(drill('facts'))).toContainText('not acknowledged yet');
  await page.evaluate(() => window.__app.setHash('#chat')); await expect(page.locator(drill('heading'))).toHaveCount(0);
  await page.evaluate(() => window.__app.setHash('#settings/backup')); await expect(page.locator(drill('status'))).toContainText('Pings are paused until');
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.start'))).toBe(1);
  await page.locator(drill('received')).click(); await expect(page.locator(drill('status'))).toContainText('Waiting for an eligible ping');
  await expect(page.locator(drill('facts'))).toContainText('you reported receiving');
  await expect(page.locator(drill('facts'))).toContainText('not acknowledged yet');
  await expect(page.locator(drill('status'))).toContainText('Drill complete');
  await expect(page.locator(drill('facts'))).toContainText('Post-drill ping: acknowledged');
  expect(await page.locator('[data-backup-watchdog]').evaluate(node => ({ content: node.scrollWidth > node.clientWidth, page: document.documentElement.scrollWidth > innerWidth }))).toEqual({ content: false, page: false });
});

test('an uncertain start is never replayed and can be ended after fresh status reconciliation', async ({ page }) => {
  await expect(page.locator(drill('review'))).toBeEnabled();
  await page.evaluate(() => window.__app.holdRpcResponses!('server.archive.watchdog.drill.start'));
  await page.locator(drill('review')).click(); await page.locator(drill('start')).click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.start'))).toBe(1);
  await page.evaluate(() => { window.__app.setServerAvailable(false); window.__app.fireState('closed'); });
  await expect(page.locator('[data-backup-watchdog-feedback]')).toContainText('could not be confirmed');
  await expect(page.locator(drill('status'))).toContainText('could not be confirmed');
  await page.evaluate(() => { window.__app.setServerAvailable(true); window.__app.fireState('connected'); });
  await page.evaluate(() => window.__app.releaseRpcResponses!('server.archive.watchdog.drill.start'));
  await expect(page.locator(drill('status'))).toContainText('Pings are paused until');
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.start'))).toBe(1);
  await page.locator(drill('cancel')).click(); await expect(page.locator(drill('status'))).toContainText('without a completed alert test');
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.update'))).toBe(1);
});
