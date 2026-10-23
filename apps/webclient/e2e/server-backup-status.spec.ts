import { expect, test } from '@playwright/test';
import { ACCOUNT_MENU_TRIGGER, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
const account = '[data-recued-account-menu-popover]';
const pill = '[data-recued-webclient-server-pill-host] button';
const controls = '[data-recued-webclient-server-control-popover]';
const backup = '[data-recued-webclient-server-control-backup]';
const warning = {
  age_ms: 0, monitoring: 'active', backup_state: 'due', recovery_test_state: 'due',
  integrity: { monitoring: 'active', state: 'failed' },
};

test('backup warnings preserve focus through heartbeats and open the actual backup route', async ({ page }) => {
  await page.evaluate(summary => window.__app.fireMessage({ type: 'server_heartbeat', payload: {
    server_id: 'fixture-backup', last_seen_at: 1, lifecycle_state: 'running', supervisor_mode: 'native', backup_health: summary,
  } }), warning);
  await page.locator(`[${ACCOUNT_MENU_TRIGGER}]`).click();
  await expect(page.locator(pill)).toHaveAccessibleName(/Server attention.*Backup overdue/);
  await page.locator(pill).click();
  const details = page.locator(backup);
  await expect(details).toContainText('Backup overdue');
  await expect(details).toContainText('Recovery test overdue');
  await expect(details).toContainText('S3 scan needs attention');
  for (const method of ['server.archive.health.get', 'server.archive.integrity.get', 'server.archive.backup.check', 'server.setPaused']) {
    expect(await page.evaluate(m => window.__app.rpcCallCount(m), method)).toBe(0);
  }
  const open = details.getByRole('button', { name: 'Open Backup & Recovery' });
  await open.focus();
  await page.evaluate(summary => window.__app.fireMessage({ type: 'server_heartbeat', payload: {
    server_id: 'fixture-backup', last_seen_at: Date.now() + 86_400_000, lifecycle_state: 'running', backup_health: summary,
  } }), warning);
  await expect(open).toBeFocused();
  const bounds = await page.locator(controls).evaluate(node => ({
    left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
    width: window.innerWidth, overflow: node.scrollWidth > node.clientWidth,
  }));
  expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 0.5);
  expect(bounds.overflow).toBe(false);
  await page.keyboard.press('Enter');
  await expect(page.locator(account)).toBeHidden();
  await expect(page.locator('[data-recued-archive-backup-panel]')).toBeVisible();
  expect(await page.evaluate(() => window.__app.activeRoute())).toBe('settings');
});

test('malformed backup metadata keeps liveness and disconnect clears cached warnings', async ({ page }) => {
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_heartbeat', payload: {
    server_id: 'fixture-backup', last_seen_at: Date.now(), lifecycle_state: 'running',
    backup_health: { monitoring: '<img src=x onerror=alert(1)> private body' },
  } }));
  await page.locator(`[${ACCOUNT_MENU_TRIGGER}]`).click();
  await expect(page.locator(pill)).toHaveAccessibleName('Server attention — Backup status unavailable');
  await page.locator(pill).click();
  await expect(page.locator(backup)).toContainText('Backup status unavailable');
  await expect(page.locator(controls)).not.toContainText('private body');
  await page.evaluate(() => { window.__app.fireState('disconnected'); window.__app.fireState('connected'); });
  await expect(page.locator(pill)).toBeHidden();
  await expect(page.locator(backup)).toBeHidden();
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_heartbeat', payload: {
    server_id: 'fixture-backup', last_seen_at: Date.now(), lifecycle_state: 'running',
  } }));
  await expect(page.locator(pill)).toHaveAccessibleName(/Server running/);
  await page.locator(pill).click();
  await expect(page.locator(backup)).toHaveCount(0);
});
