import { expect, test, type Page } from '@playwright/test';
import type { QuietHoursGetResponse, ServerTimeZoneGetResponse } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
const finder = (page: Page) => page.getByRole('searchbox', { name: 'Find a setting', exact: true });
const result = (page: Page, id: string) => page.locator(`[data-recued-settings-finder-result="${id}"]`);
const panel = (page: Page, id: string) => page.locator(`[data-recued-settings-found="${id}"]`);
const open = async (page: Page, hash = '#settings', hold?: string) => {
  await page.addInitScript(() => {
    const quiet: QuietHoursGetResponse = { policy: { enabled: true, from_minute: 1320, to_minute: 480,
      applies_to: ['notification'], updated_at: 1 }, can_arm: true, resolved_zone: 'Europe/London' };
    const timezone: ServerTimeZoneGetResponse = { setting: { mode: 'fixed', zone: 'Europe/London', updated_at: 1 },
      resolved_zone: 'Europe/London', host_zone: 'Europe/London' };
    Object.assign(window, { __connectionsFixture: async (method: string) => {
      if (method === 'notification.quiet_hours.get') return { result: quiet };
      if (method === 'server.timezone.get') return { result: timezone };
      return undefined;
    } });
  });
  await page.goto(`${HARNESS_URL}?notifications=ready${hold ? `&hold_rpc=${encodeURIComponent(hold)}` : ''}${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
};

test('Enter opens Quiet hours, and finder history preserves its unsaved window', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await open(page);
  await finder(page).fill('quiet hours');
  await expect(result(page, 'quiet-hours')).toContainText('Approval & notifications');
  await finder(page).press('Enter');
  await expect(page).toHaveURL(/#settings\/notifications\/find\/quiet-hours$/);
  await expect(panel(page, 'quiet-hours')).toBeFocused();
  const start = page.getByLabel('Quiet hours start', { exact: true });
  await expect(start).toBeVisible();
  await start.fill('23:30');
  await finder(page).fill('timezone');
  await result(page, 'timezone').click();
  await expect(page).toHaveURL(/#settings\/server\/find\/timezone$/);
  await expect(panel(page, 'timezone')).toBeFocused();
  await expect(page.locator('[data-recued-settings-subtab="timezone"]')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(panel(page, 'quiet-hours')).toBeFocused();
  await expect(start).toHaveValue('23:30');
  await page.goForward();
  await expect(panel(page, 'timezone')).toBeFocused();
  expect(dialogs).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('finding the default model leaves Providers and survives a reload at the exact panel', async ({ page }) => {
  await open(page, '#settings/ai-models/providers');
  await finder(page).fill('default model');
  await finder(page).press('Enter');
  await expect(page).toHaveURL(/#settings\/ai-models\/find\/default-model$/);
  await expect(panel(page, 'default-model')).toBeFocused();
  await expect(page.locator('[data-recued-ai-models-tab="preference"]')).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(panel(page, 'default-model')).toBeFocused();
  await expect(panel(page, 'default-model').getByRole('heading', { name: 'Model preference' })).toBeVisible();
});

test('keyboard results can be dismissed without changing the active section', async ({ page }) => {
  await open(page, '#settings/privacy');
  await finder(page).fill('quiet hours');
  await finder(page).press('ArrowDown');
  await expect(result(page, 'quiet-hours')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(finder(page)).toBeFocused();
  await expect(finder(page)).toHaveValue('');
  await expect(page.getByRole('list', { name: 'Matching settings' })).toBeHidden();
  await expect(page).toHaveURL(/#settings\/privacy$/);
});

test('an unavailable or mismatched exact-panel link gives a usable search', async ({ page }) => {
  await open(page, '#settings/privacy/find/quiet-hours');
  await expect(page.getByRole('status').filter({ hasText: 'This setting is not available here.' })).toBeVisible();
  await finder(page).fill('quiet hours');
  await finder(page).press('Enter');
  await expect(panel(page, 'quiet-hours')).toBeFocused();
  await expect(page).toHaveURL(/#settings\/notifications\/find\/quiet-hours$/);
});

test('hidden server features are omitted and searching does not open lazy panels', async ({ page }) => {
  await open(page, '#settings/privacy');
  await expect(page.locator('[data-situation-close-day]')).toBeHidden();
  await finder(page).fill('close the day');
  await expect(result(page, 'close-day')).toHaveCount(0);
  const before = await page.evaluate(() => window.__app.rpcCallCount('collection.mail.chat_door.get'));
  await finder(page).fill('email chat');
  await expect(result(page, 'email-chat')).toBeVisible();
  expect(await page.evaluate(() => window.__app.rpcCallCount('collection.mail.chat_door.get'))).toBe(before);
  await finder(page).press('Enter');
  await expect(panel(page, 'email-chat')).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('collection.mail.chat_door.get'))).toBeGreaterThan(before);
});

test('finding Automatic backups expands its schedule disclosure', async ({ page }) => {
  await open(page, '#settings/privacy');
  await finder(page).fill('automatic backups');
  await finder(page).press('Enter');
  await expect(page).toHaveURL(/#settings\/backup\/find\/automatic-backups$/);
  await expect(panel(page, 'automatic-backups')).toBeFocused();
  await expect(panel(page, 'automatic-backups')).toHaveJSProperty('open', true);
  await expect(page.locator('[data-unattended-enabled]')).toBeVisible();
});

test('a bookmarked panel opens when its availability read completes', async ({ page }) => {
  await open(page, '#settings/notifications/find/agenda', 'yours.agenda');
  await expect(page.locator('[data-situation-agenda]')).toBeHidden();
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.agenda') ?? 0)).toBeGreaterThan(0);
  await expect(panel(page, 'agenda')).toBeFocused();
  await expect(panel(page, 'agenda').getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible();
});

test('interacting elsewhere retires a bookmarked panel’s pending focus', async ({ page }) => {
  await open(page, '#settings/notifications/find/agenda', 'yours.agenda');
  await finder(page).fill('quiet hours');
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.agenda') ?? 0)).toBeGreaterThan(0);
  await expect(page.locator('[data-situation-agenda]')).toBeVisible();
  await expect(finder(page)).toBeFocused();
  await expect(finder(page)).toHaveValue('quiet hours');
  await expect(panel(page, 'agenda')).toHaveCount(0);
});
