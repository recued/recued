import { openBackupDisclosure } from './helpers/backup-disclosure.js';
import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
test.beforeEach(async ({ page }) => {
  await page.goto(`${HARNESS_URL}?backup_watchdog_drill=ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/backup')); await openBackupDisclosure(page, 'tools');
});
const drill = (name: string) => `[data-backup-watchdog-drill-${name}]`;
const monitor = (name: string) => `[data-backup-watchdog-${name}]`;
const noMonitorWrites = async (page: Page) => {
  for (const method of ['server.archive.watchdog.save', 'server.archive.watchdog.drill.start', 'server.archive.watchdog.drill.update']) {
    expect(await page.evaluate(method => window.__app.rpcCallCount(method), method), method).toBe(0);
  }
};
const enter = async (page: Page, name: string) => { await page.locator(drill(name)).focus(); await page.keyboard.press('Enter'); };
const beginWithKeyboard = async (page: Page) => {
  await expect(page.locator(drill('review'))).toBeEnabled();
  await enter(page, 'review'); await expect(page.locator(drill('start'))).toBeFocused();
  await page.keyboard.press('Enter');
};

for (const width of [390, 1280]) test.describe(`monitor drill keyboard focus at ${width}px`, () => {
  test.use({ viewport: { width, height: 900 } });

  test('review and Go back keep focus on the next control without starting a drill', async ({ page }) => {
    await expect(page.locator(drill('review'))).toBeEnabled();
    await page.locator(drill('duration')).selectOption('15'); await enter(page, 'review');
    await expect(page.locator(drill('start'))).toBeFocused();
    await expect(page.locator(drill('start'))).toHaveText('Pause pings for 15 minutes');
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.start'))).toBe(0);
    await enter(page, 'back'); await expect(page.locator(drill('review'))).toBeFocused();
    await expect(page.locator(drill('duration'))).toHaveValue('15'); await expect(page.locator(drill('start'))).toBeHidden();
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.start'))).toBe(0);
    expect(await page.locator('[data-backup-watchdog]').evaluate(node => ({ content: node.scrollWidth > node.clientWidth, page: document.documentElement.scrollWidth > innerWidth }))).toEqual({ content: false, page: false });
  });

  test('pending start and end actions keep focus on visible status and retain keyboard navigation', async ({ page, browserName }) => {
    const next = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    await page.evaluate(() => window.__app.holdRpcResponses!('server.archive.watchdog.drill.start'));
    await beginWithKeyboard(page);
    await expect(page.locator(drill('status'))).toBeFocused(); await expect(page.locator(drill('status'))).toBeVisible();
    await expect(page.locator(drill('status'))).toHaveText('Updating the monitor alert drill…');
    await expect(page.locator(drill('status'))).toHaveCSS('outline-style', 'solid');
    await expect(page.locator(drill('status'))).toHaveCSS('outline-width', '2px');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.start'))).toBe(1);
    await page.evaluate(() => window.__app.releaseRpcResponses!('server.archive.watchdog.drill.start'));
    await expect(page.locator(drill('status'))).toContainText('Pings are paused until');
    await expect(page.locator(drill('status'))).toBeFocused();
    await page.keyboard.press(next); await expect(page.locator(drill('received'))).toBeFocused();
    await page.keyboard.press(next); await expect(page.locator(drill('cancel'))).toBeFocused();
    await page.evaluate(() => window.__app.holdRpcResponses!('server.archive.watchdog.drill.update'));
    await page.keyboard.press('Enter'); await expect(page.locator(drill('status'))).toBeFocused();
    await page.evaluate(() => window.__app.releaseRpcResponses!('server.archive.watchdog.drill.update'));
    await expect(page.locator(drill('status'))).toContainText('without a completed alert test');
    await expect(page.locator(drill('status'))).toBeFocused();
    await page.keyboard.press(next); await expect(page.locator(drill('review'))).toBeFocused();
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.update'))).toBe(1);
  });

  test('confirming an alert keeps focus when its button disappears', async ({ page }) => {
    await beginWithKeyboard(page); await expect(page.locator(drill('received'))).toBeEnabled();
    await page.evaluate(() => window.__app.holdRpcResponses!('server.archive.watchdog.drill.update'));
    await enter(page, 'received'); await expect(page.locator(drill('status'))).toBeFocused();
    await expect(page.locator(drill('status'))).toHaveText('Updating the monitor alert drill…');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.update'))).toBe(1);
    await page.evaluate(() => window.__app.releaseRpcResponses!('server.archive.watchdog.drill.update'));
    await expect(page.locator(drill('facts'))).toContainText('you reported receiving');
    await expect(page.locator(drill('received'))).toBeHidden(); await expect(page.locator(drill('status'))).toBeFocused();
  });

  test('failed reads repair lost confirmation focus and recovery preserves a newer URL draft', async ({ page }) => {
    await expect(page.locator(drill('review'))).toBeEnabled(); await enter(page, 'review');
    await expect(page.locator(drill('start'))).toBeFocused();
    await expect(page.locator('[data-remote-backups-refresh]')).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(() => { window.__app.setServerAvailable(false); window.__app.fireState('closed'); });
    await page.locator('[data-remote-backups-refresh]').evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator(drill('status'))).toContainText('could not be confirmed');
    await expect(page.locator(drill('status'))).toBeFocused();
    const url = page.locator('[data-backup-watchdog-url]'); await url.fill('https://draft.example/private-focus-draft');
    await page.evaluate(() => { window.__app.setServerAvailable(true); window.__app.fireState('connected'); });
    await expect(page.locator(drill('status'))).not.toContainText('could not be confirmed');
    await expect(url).toBeFocused(); await expect(url).toHaveValue('https://draft.example/private-focus-draft');
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.start'))).toBe(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.update'))).toBe(0);
  });

  test('late replies after leaving the page do not take focus from the new route', async ({ page }) => {
    await page.evaluate(() => window.__app.holdRpcResponses!('server.archive.watchdog.drill.start'));
    await beginWithKeyboard(page); await expect(page.locator(drill('status'))).toBeFocused();
    await page.evaluate(() => window.__app.setHash('#chat')); await expect(page.locator(drill('heading'))).toHaveCount(0);
    const nextControl = page.locator('button:visible:enabled').first(); await nextControl.focus();
    await page.evaluate(() => window.__app.releaseRpcResponses!('server.archive.watchdog.drill.start'));
    await expect(nextControl).toBeFocused(); await expect(page.locator(drill('heading'))).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.start'))).toBe(1);
  });

  test('reverting setup edits clears the draft state and restores the drill without saving', async ({ page }) => {
    await expect(page.locator(drill('review'))).toBeEnabled(); await expect(page.locator(monitor('discard'))).toBeDisabled();
    await page.locator(monitor('enabled')).uncheck();
    await expect(page.locator(drill('review'))).toBeDisabled(); await expect(page.locator(monitor('draft-status'))).toHaveText('Unsaved monitor changes.');
    await page.locator(monitor('enabled')).check(); await expect(page.locator(drill('review'))).toBeEnabled();
    await page.locator(monitor('url')).fill('https://draft.example/private-reverted-monitor');
    await expect(page.locator(drill('review'))).toBeDisabled(); await expect(page.locator(monitor('discard'))).toBeEnabled();
    await page.locator(monitor('url')).fill('');
    await expect(page.locator(drill('review'))).toBeEnabled(); await expect(page.locator(monitor('discard'))).toBeDisabled();
    await expect(page.locator(monitor('draft-status'))).toHaveText('No unsaved monitor changes.'); await noMonitorWrites(page);
  });

  test('discard restores confirmed settings, clears the URL and returns keyboard focus without writing', async ({ page }) => {
    await expect(page.locator(drill('review'))).toBeEnabled(); const url = page.locator(monitor('url')), node = await url.elementHandle();
    await page.locator(monitor('enabled')).uncheck(); await url.fill('https://draft.example/private-discarded-monitor');
    await page.locator(monitor('discard')).focus(); await page.keyboard.press('Enter');
    await expect(page.locator(monitor('enabled'))).toBeChecked(); await expect(page.locator(monitor('enabled'))).toBeFocused();
    await expect(url).toHaveValue(''); await expect(page.locator(monitor('discard'))).toBeDisabled();
    await expect(page.locator(monitor('draft-status'))).toHaveText('No unsaved monitor changes.'); await expect(page.locator(drill('review'))).toBeEnabled();
    expect(await node!.evaluate(node => node.isConnected && node === document.querySelector('[data-backup-watchdog-url]'))).toBe(true);
    expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join())).not.toContain('private-discarded-monitor');
    await expect(page.locator('[data-backup-watchdog]')).not.toContainText('private-discarded-monitor'); await noMonitorWrites(page);
  });

  test('save preserves a newer checkbox edit and discard returns to the acknowledged value', async ({ page }) => {
    await expect(page.locator(drill('review'))).toBeEnabled(); await page.locator(monitor('enabled')).uncheck();
    await page.locator(monitor('url')).fill('https://draft.example/private-submitted-monitor');
    await page.evaluate(() => window.__app.holdRpcResponses!('server.archive.watchdog.save')); await page.locator(monitor('save')).click();
    await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
    await page.locator(monitor('enabled')).check(); await expect(page.locator(monitor('discard'))).toBeDisabled();
    await page.evaluate(() => window.__app.releaseRpcResponses!('server.archive.watchdog.save'));
    await expect(page.locator(monitor('feedback'))).toContainText('newer edits'); await expect(page.locator(monitor('save'))).toBeEnabled();
    await expect(page.locator(monitor('enabled'))).toBeChecked(); await expect(page.locator(monitor('url'))).toHaveValue('');
    await expect(page.locator(monitor('draft-status'))).toHaveText('Unsaved monitor changes.');
    await page.locator(monitor('discard')).focus(); await page.keyboard.press('Enter');
    await expect(page.locator(monitor('enabled'))).not.toBeChecked(); await expect(page.locator(monitor('enabled'))).toBeFocused();
    await expect(page.locator(monitor('draft-status'))).toHaveText('No unsaved monitor changes.');
    await expect(page.locator(monitor('feedback'))).not.toContainText('newer edits');
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
  });

  test('discard clears an uncertain replacement draft while keeping the write warning and preventing replay', async ({ page }) => {
    await expect(page.locator(drill('review'))).toBeEnabled(); await page.locator(monitor('url')).fill('https://draft.example/private-uncertain-monitor');
    await page.evaluate(() => window.__app.holdRpcResponses!('server.archive.watchdog.save')); await page.locator(monitor('save')).click();
    await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
    await page.evaluate(() => { window.__app.setServerAvailable(false); window.__app.fireState('closed'); });
    await expect(page.locator(monitor('feedback'))).toContainText('could not be confirmed');
    await page.evaluate(() => { window.__app.setServerAvailable(true); window.__app.fireState('connected'); });
    await page.evaluate(() => window.__app.releaseRpcResponses!('server.archive.watchdog.save'));
    await expect(page.locator(monitor('save'))).toBeEnabled(); await expect(page.locator(monitor('url'))).toHaveValue('https://draft.example/private-uncertain-monitor');
    await page.locator(monitor('discard')).focus(); await page.keyboard.press('Enter');
    await expect(page.locator(monitor('url'))).toHaveValue(''); await expect(page.locator(monitor('draft-status'))).toHaveText('No unsaved monitor changes.');
    await expect(page.locator(monitor('feedback'))).toContainText('could not be confirmed');
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.save'))).toBe(1);
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.drill.start'))).toBe(0);
  });
});

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
  await page.evaluate(() => window.__app.setHash('#settings/backup')); await openBackupDisclosure(page, 'tools'); await expect(page.locator(drill('status'))).toContainText('Pings are paused until');
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
