import { expect, type Page } from '@playwright/test';
import type { QuietHoursGetResponse, ServerTimeZoneGetResponse } from '@recued/contracts';
import { FIXED_NOW, HARNESS_URL } from './full-app.js';
interface SettingsSearchFixture { calls: Array<{ method: string; args: unknown }> }
declare global { interface Window { __settingsSearch: SettingsSearchFixture } }
export const settingResults = (page: Page) => page.getByRole('region', { name: 'Settings search results', exact: true });
export const settingQuery = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
export const settingType = (page: Page) => page.getByRole('combobox', { name: 'Result type', exact: true });
export const settingHits = (page: Page) => settingResults(page).locator('[data-search-setting-id]');
export const settingHit = (page: Page, id: string) => settingResults(page).locator(`[data-search-setting-id="${id}"]`);
export const foundSetting = (page: Page, id: string) => page.locator(`[data-recued-settings-found="${id}"]`);
export const findSettings = async (page: Page, query: string) => {
  await settingQuery(page).fill(query); await settingType(page).selectOption('setting'); await expect(settingResults(page)).toHaveAttribute('aria-busy', 'false');
};
export const openSettingsSearch = async (page: Page, options: { width?: number; devices?: boolean } = {}) => {
  await page.setViewportSize({ width: options.width ?? 1280, height: 900 }); await page.clock.setFixedTime(FIXED_NOW);
  await page.addInitScript(() => {
    const quiet: QuietHoursGetResponse = { policy: { enabled: true, from_minute: 1320, to_minute: 480,
      applies_to: ['notification'], updated_at: 1 }, can_arm: true, resolved_zone: 'Europe/London' };
    const timezone: ServerTimeZoneGetResponse = { setting: { mode: 'fixed', zone: 'Europe/London', updated_at: 1 }, resolved_zone: 'Europe/London', host_zone: 'Europe/London' };
    const fixture: SettingsSearchFixture = { calls: [] };
    Object.assign(window, { __settingsSearch: fixture, __connectionsFixture: async (method: string, args: unknown) => {
      fixture.calls.push({ method, args });
      if (method === 'notification.quiet_hours.get') return { result: quiet };
      if (method === 'server.timezone.get') return { result: timezone };
      return undefined;
    } });
  });
  await page.goto(`${HARNESS_URL}?settle_reads=1&journey=verification&notifications=ready${options.devices ? '&devices=ready' : ''}#data/search`);
  await page.waitForFunction(() => window.__app?.ready === true); await expect(settingQuery(page)).toBeVisible();
};
