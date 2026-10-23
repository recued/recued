import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
const summary = '[data-passport-recovery-summary]';
const row = (name: string) => `[data-passport-recovery-row="${name}"]`;
const jsonField = '[data-recued-archive-passport-json]';
const start = '[data-recued-archive-passport-start]';
const downloadButton = '[data-recued-archive-passport-download]';
const show = async (page: Page, mode: string) => {
  await page.goto(`${HARNESS_URL}?passport_summary=${mode}`); await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
  await page.locator(start).focus(); await page.keyboard.press('Enter'); await expect(page.locator(summary)).toBeVisible();
};
const noOverflow = async (page: Page) => {
  expect(await page.locator(summary).evaluate(node => ({ content: node.scrollWidth > node.clientWidth, page: document.documentElement.scrollWidth > innerWidth }))).toEqual({ content: false, page: false });
};

test('recovery summary preserves the exported snapshot, keyboard focus and exact downloaded JSON', async ({ page }) => {
  await show(page, 'healthy'); await expect(page.locator(downloadButton)).toBeFocused();
  await expect(page.locator(summary)).toContainText('States recorded in this exported file');
  await expect(page.locator(row('backup'))).toContainText('at export'); await expect(page.locator(row('recovery'))).toContainText('earlier copy');
  await expect(page.locator(row('alert'))).toContainText('owner reported'); await expect(page.locator(row('alert'))).toContainText('not independently verified');
  await expect(page.locator(row('ping'))).toContainText('after the pause');
  const json = await page.locator(jsonField).inputValue(), before = await page.locator(summary).textContent();
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_heartbeat', payload: { server_id: 'fixture-backup', last_seen_at: Date.now(), lifecycle_state: 'running', supervisor_mode: 'native',
    backup_health: { age_ms: 0, monitoring: 'active', backup_state: 'due', recovery_test_state: 'due', integrity: { monitoring: 'active', state: 'failed' } } } }));
  await expect(page.locator(downloadButton)).toBeFocused(); expect(await page.locator(summary).textContent()).toBe(before);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator(downloadButton).click()]);
  const path = await download.path(); if (!path) throw new Error('Missing fixture download');
  expect(await readFile(path, 'utf8')).toBe(json); expect(download.suggestedFilename()).toBe('recued-passport-support_redacted.json');
  expect(await page.evaluate(() => window.__app.rpcCallCount('passport.export'))).toBe(1);
  for (const method of ['server.archive.export', 'server.archive.backup.check', 'server.archive.drill.start', 'server.archive.watchdog.drill.start']) {
    expect(await page.evaluate(method => window.__app.rpcCallCount(method), method)).toBe(0);
  }
  await noOverflow(page); await page.locator('[data-recued-archive-backup-cancel]').focus(); await page.keyboard.press('Enter');
  await expect(page.locator(summary)).toHaveCount(0); await expect(page.locator(jsonField)).toHaveCount(0); await expect(page.locator(start)).toBeFocused();
});

test('overdue and partial proof remains separate from drill results for an earlier monitor setup', async ({ page }) => {
  await show(page, 'attention'); await expect(page.locator(row('backup'))).toContainText('overdue');
  await expect(page.locator(row('integrity'))).toContainText('partial');
  for (const name of ['drill', 'alert', 'ping']) await expect(page.locator(row(name))).toContainText('Earlier monitor setup');
  await noOverflow(page);
});

test('older Passports identify missing evidence without inventing passing results', async ({ page }) => {
  await show(page, 'legacy'); await expect(page.locator(row('backup'))).toContainText('alone does not prove');
  for (const name of ['recovery', 'integrity', 'monitor', 'drill']) await expect(page.locator(row(name))).toContainText('not included');
  await expect(page.locator(downloadButton)).toBeEnabled(); await noOverflow(page);
});

test('malformed optional fields cannot complete an alert drill or render unknown state text', async ({ page }) => {
  await show(page, 'malformed'); await expect(page.locator(row('backup'))).toContainText('unavailable');
  for (const name of ['drill', 'alert', 'ping']) await expect(page.locator(row(name))).toContainText('unavailable');
  await expect(page.locator(summary)).not.toContainText('unknown-future-state'); await noOverflow(page);
});
