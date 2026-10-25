import { openBackupDisclosure } from './helpers/backup-disclosure.js';
import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
const panel = '[data-restore-readiness]';
const item = (id: string) => `${panel} [data-restore-readiness-item="${id}"]`;
const open = async (page: import('@playwright/test').Page, mode: string) => {
  await page.goto(`${HARNESS_URL}?restore_readiness=${mode}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
};
const noWrites = async (page: import('@playwright/test').Page) => {
  for (const method of ['server.archive.import', 'server.archive.export', 'server.archive.backup.check', 'server.archive.backup.retrieve',
    'server.archive.unattended.save', 'server.archive.health.save', 'server.archive.integrity.save', 'server.archive.watchdog.save',
    'server.archive.watchdog.drill.start', 'server.archive.watchdog.drill.update', 'server.archive.drill.start']) {
    expect(await page.evaluate(method => window.__app.rpcCallCount(method), method), method).toBe(0);
  }
};
const fits = async (page: import('@playwright/test').Page) => {
  expect(await page.locator(panel).evaluate(node => ({ content: node.scrollWidth > node.clientWidth, page: document.documentElement.scrollWidth > innerWidth }))).toEqual({ content: false, page: false });
};

test('a confirmed restore reads current setup, keeps owner alert evidence qualified, and survives reload', async ({ page }) => {
  await open(page, 'ready'); await expect(page.locator(panel)).toBeVisible();
  await expect(page.locator(`${panel} [data-restore-readiness-status]`)).toContainText('Status read');
  await expect(page.locator(`${panel} [data-restore-readiness-state="ready"]`)).toHaveCount(7);
  await expect(page.locator(item('drill'))).toContainText('not independently verified');
  await page.locator('[data-restore-readiness-review="schedule"]').click();
  await expect(page.locator('[data-unattended-enabled]')).toBeFocused();
  await page.locator('[data-restore-readiness-review="monitor"]').click();
  await expect(page.locator('[data-backup-watchdog-enabled]')).toBeFocused();
  await page.locator('[data-restore-readiness-review="integrity"]').click();
  await expect(page.locator('[data-backup-integrity-enabled]')).toBeFocused();
  const count = await page.evaluate(() => window.__app.rpcCallCount('server.archive.import_status'));
  await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
  await expect(page.locator(item('backup'))).toContainText('within its age limit');
  expect(count).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.archive.import_status'))).toBeGreaterThan(0);
  await fits(page); await noWrites(page);
});

test('missing setup gives review actions and refresh preserves unsaved recovery words and monitor URL', async ({ page }) => {
  await open(page, 'attention');
  await expect(page.locator(item('schedule'))).toContainText('Set up unattended backups');
  await expect(page.locator(item('monitor'))).toContainText('another host');
  await expect(page.locator(item('integrity'))).toContainText('checks are off');
  await openBackupDisclosure(page, 'schedule'); await openBackupDisclosure(page, 'tools');
  await page.locator('[data-unattended-words]').fill('synthetic draft words');
  await page.locator('[data-backup-watchdog-url]').fill('https://draft.example.test/private-token');
  await page.locator('[data-restore-readiness-refresh]').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('[data-restore-readiness-refresh]')).toHaveAttribute('aria-disabled', 'false');
  await expect(page.locator('[data-restore-readiness-refresh]')).toBeFocused();
  await expect(page.locator('[data-unattended-words]')).toHaveValue('synthetic draft words');
  await expect(page.locator('[data-backup-watchdog-url]')).toHaveValue('https://draft.example.test/private-token');
  await expect(page.locator(panel)).not.toContainText('private-token');
  await fits(page); await noWrites(page);
});

test('an accepted import cannot show post-restore readiness', async ({ page }) => {
  await open(page, 'accepted');
  await expect(page.locator('[data-archive-import-status]')).toHaveAttribute('data-archive-import-status', 'waiting_for_restart');
  await expect(page.locator(panel)).toBeHidden(); await noWrites(page);
});

test('disconnect clears passing claims and a late status cannot revive them after clearing the receipt', async ({ page }) => {
  await open(page, 'ready'); await expect(page.locator(item('monitor'))).toContainText('within the last five minutes');
  await page.evaluate(() => window.__app.holdRpcResponses!('server.archive.watchdog.get'));
  const before = await page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.get'));
  await page.locator('[data-restore-readiness-refresh]').click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('server.archive.watchdog.get'))).toBeGreaterThan(before);
  await page.evaluate(() => { window.__app.setServerAvailable(false); window.__app.fireState('closed'); });
  await expect(page.locator(`${panel} [data-restore-readiness-status]`)).toContainText('Connection lost');
  await expect(page.locator(`${panel} [data-restore-readiness-state="ready"]`)).toHaveCount(0);
  await page.locator('[data-archive-import-dismiss]').click(); await expect(page.locator(panel)).toBeHidden();
  await page.evaluate(() => { window.__app.releaseRpcResponses!('server.archive.watchdog.get'); });
  await expect(page.locator(panel)).toBeHidden(); await noWrites(page);
});


test('extra backup checks surface problems while their forms stay closed until reviewed', async ({ page }) => {
  await open(page, 'failed_checks');
  const tools = page.locator('[data-backup-disclosure="tools"]'), notice = page.locator('[data-backup-tools-attention]');
  await expect(tools).toHaveJSProperty('open', false); await expect(notice).toBeVisible();
  await expect(page.locator('[data-backup-watchdog-url]')).toBeHidden();
  await notice.getByRole('button', { name: 'Review backup checks', exact: true }).click();
  await expect(tools).toHaveJSProperty('open', true); await expect(tools.locator(':scope > summary')).toBeFocused();
  await expect(page.locator('[data-backup-watchdog-url]')).toBeVisible(); await noWrites(page);
});
