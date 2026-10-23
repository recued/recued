import { expect, test } from '@playwright/test';
import type { QuietHoursGetResponse, ServerTimeZoneGetResponse } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

type Scenario = 'blocked' | 'different clocks' | 'same clock';
type Reply = { result?: unknown; error?: { code: string; message: string } };
declare global { interface Window { __quietHoursTimezoneWrites: Array<{ method: string; args: unknown }> } }

// Exercise both preview branches without relying on the test runner's zone.
test.use({ timezoneId: 'America/Los_Angeles' });
let externalRequests: string[] = [];
test.beforeEach(async ({ page }) => {
  externalRequests = [];
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(HARNESS_URL).origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
});
installFullAppHooks();
test.afterEach(async ({ page }) => {
  expect(externalRequests).toEqual([]);
  expect(await page.evaluate(() => window.__quietHoursTimezoneWrites)).toEqual([]);
});

for (const width of [390, 1280]) {
  for (const scenario of ['blocked', 'different clocks', 'same clock'] as const) {
    test(`Quiet hours opens the timezone editor with ${scenario} at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((scenario: Scenario) => {
        window.__quietHoursTimezoneWrites = [];
        const quietHours: QuietHoursGetResponse = {
          policy: { enabled: true, from_minute: 1320, to_minute: 480, applies_to: ['notification'], updated_at: 1 },
          can_arm: scenario !== 'blocked',
          resolved_zone: scenario === 'same clock' ? 'America/Los_Angeles' : 'Asia/Hong_Kong',
        };
        const timezone: ServerTimeZoneGetResponse = {
          setting: { mode: 'fixed', zone: 'Europe/London', updated_at: 1 },
          resolved_zone: 'Europe/London', host_zone: 'Europe/London',
        };
        // Only RPC replies are fixtures; the production panel, native link,
        // hash router and Settings tabs handle the complete handoff.
        Object.assign(window, {
          __connectionsFixture: async (method: string, args: unknown): Promise<Reply | undefined> => {
            if (method === 'notification.quiet_hours.get') return { result: quietHours };
            if (method === 'server.timezone.get') return { result: timezone };
            if (method === 'notifications.describe' || method === 'notifications.describe_bridges') return { result: { rows: [] } };
            if (method === 'notification.kind_policy.get') return { result: { policies: [] } };
            if (method === 'network.local_urls') return { result: { urls: [], lan_port: 7717, public_port: 443 } };
            if (method === 'network.port_mapping') return { result: { enabled: false, support: 'unsupported' } };
            if (method === 'tls_domain.list') return { result: { entries: [] } };
            if (method.endsWith('.set') || method === 'server.setConfigField') window.__quietHoursTimezoneWrites.push({ method, args });
            return undefined;
          },
        });
        window.__app.setHash('#settings/notifications');
      }, scenario);
      const quiet = page.locator('[data-recued-quiet-hours-panel]');
      await expect(quiet).toBeVisible();
      await expect(quiet).toHaveAttribute('data-recued-quiet-hours-state', 'ready');
      const label = scenario === 'blocked' ? 'Set the timezone'
        : scenario === 'different clocks' ? 'change Recued’s timezone' : 'Change Recued’s timezone';
      const link = quiet.getByRole('link', { name: label, exact: true });
      if (scenario === 'blocked') await expect(quiet.locator('[data-recued-quiet-hours-toggle]')).toBeDisabled();
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#settings\/server\/timezone$/);
      await expect(page.getByRole('tab', { name: 'Timezone', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab', { name: 'Connect a device', exact: true })).toHaveAttribute('aria-selected', 'false');
      const timezone = page.locator('[data-recued-server-timezone-panel]');
      await expect(timezone).toBeVisible();
      await expect(timezone.getByRole('textbox', { name: 'Server timezone', exact: true })).toHaveValue('Europe/London');
      await expect(page.locator('[data-recued-connect-device-panel]')).toBeHidden();
      if (scenario === 'blocked') await page.screenshot({ path: info.outputPath('timezone-destination.png') });
    });
  }
}
