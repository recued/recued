import { expect, test, type Page } from '@playwright/test';
import type { ServerTimeZoneGetResponse, ServerTimeZoneSetRequest } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

type Outcome = 'fixed' | 'follows_host' | 'error';
type Reply = { result?: unknown; error?: { code: string; message: string } };
interface TimezoneReadFixture {
  reads: unknown[];
  writes: ServerTimeZoneSetRequest[];
  pending(): number;
  release(index: number, outcome: Outcome): void;
}
declare global { interface Window { __timezoneReadRecovery: TimezoneReadFixture } }

const panel = (page: Page) => page.locator('[data-recued-server-timezone-panel]');
const retry = (page: Page) => panel(page).getByRole('button', { name: 'Retry loading timezone', exact: true });
const loading = (page: Page) => panel(page).getByRole('status', { name: '', exact: true });
const zone = (page: Page) => panel(page).getByRole('textbox', { name: 'Server timezone', exact: true });
const follows = (page: Page) => panel(page).locator('[data-recued-server-timezone-mode="follows_host"]');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside timezone settings', exact: true });
const release = (page: Page, index: number, outcome: Outcome) =>
  page.evaluate(args => window.__timezoneReadRecovery.release(args.index, args.outcome), { index, outcome });
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
  expect(await page.evaluate(() => window.__timezoneReadRecovery?.writes ?? [])).toEqual([]);
});

const open = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(() => {
    const pending: Array<{ resolve(reply: Reply): void; released: boolean }> = [];
    const fixture: TimezoneReadFixture = {
      reads: [], writes: [],
      pending: () => pending.filter(item => !item.released).length,
      release(index, outcome) {
        const item = pending[index];
        if (!item || item.released) throw new Error(`No pending timezone read ${index}`);
        item.released = true;
        const result: ServerTimeZoneGetResponse = {
          setting: { mode: outcome === 'follows_host' ? 'follows_host' : 'fixed', zone: 'Europe/London', updated_at: 1 },
          resolved_zone: 'Europe/London', host_zone: 'Europe/London',
        };
        item.resolve(outcome === 'error'
          ? { error: { code: 'UNAVAILABLE', message: 'Timezone read temporarily unavailable.' } }
          : { result });
      },
    };
    Object.assign(window, {
      __timezoneReadRecovery: fixture,
      __connectionsFixture: async (method: string, args: unknown): Promise<Reply | undefined> => {
        if (method === 'server.timezone.get') {
          fixture.reads.push(args);
          return new Promise(resolve => { pending.push({ resolve, released: false }); });
        }
        if (method === 'server.timezone.set') fixture.writes.push(args as ServerTimeZoneSetRequest);
        if (method === 'network.local_urls') return { result: { urls: [], lan_port: 7717, public_port: 443 } };
        if (method === 'network.port_mapping') return { result: { enabled: false, support: 'unsupported' } };
        if (method === 'tls_domain.list') return { result: { entries: [] } };
        return undefined;
      },
    });
    const button = document.createElement('button');
    button.textContent = 'Outside timezone settings';
    document.body.appendChild(button);
    window.__app.setHash('#settings/server/timezone');
  });
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute('data-recued-server-timezone-state', 'loading');
  await expect(loading(page)).toHaveText('Loading timezone…');
  await expect.poll(() => page.evaluate(() => window.__timezoneReadRecovery.reads.length)).toBe(1);
};
const failInitial = async (page: Page, width: number) => {
  await open(page, width);
  await release(page, 0, 'error');
  await expect(panel(page)).toHaveAttribute('data-recued-server-timezone-state', 'error');
  await expect(panel(page).getByRole('alert')).toContainText('Timezone read temporarily unavailable.');
  await expect(retry(page)).toBeVisible();
};
const activateRetry = async (page: Page) => {
  await retry(page).focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toHaveAttribute('data-recued-server-timezone-state', 'loading');
  await expect(loading(page)).toHaveText('Loading timezone…');
  await expect(loading(page)).toHaveAttribute('aria-atomic', 'true');
  await expect(loading(page)).toBeFocused();
  await expect(loading(page)).toBeInViewport();
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  await expect(panel(page).locator('input')).toHaveCount(0);
};
const expectOutcome = async (page: Page, outcome: Outcome) => {
  await expect(panel(page)).toHaveAttribute('data-recued-server-timezone-state', outcome === 'error' ? 'error' : 'ready');
  await expect(loading(page)).toHaveCount(0);
  if (outcome === 'error') await expect(panel(page).getByRole('alert')).toContainText('Timezone read temporarily unavailable.');
  else {
    await expect(retry(page)).toHaveCount(0);
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    if (outcome === 'fixed') await expect(zone(page)).toHaveValue('Europe/London');
    else { await expect(follows(page)).toBeChecked(); await expect(zone(page)).toHaveCount(0); }
  }
};

for (const width of [390, 1280]) {
  for (const outcome of ['fixed', 'follows_host', 'error'] as const) {
    for (const owner of ['retry', 'outside'] as const) {
      test(`timezone retry ${outcome} retains ${owner} focus at ${width}px`, async ({ page }, info) => {
        await failInitial(page, width);
        const oldRetry = await retry(page).elementHandle();
        await activateRetry(page);
        await oldRetry!.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
        await page.keyboard.press('Enter');
        expect(await page.evaluate(() => window.__timezoneReadRecovery.reads)).toEqual([{}, {}]);
        expect(await page.evaluate(() => window.__timezoneReadRecovery.pending())).toBe(1);
        if (owner === 'outside') await outside(page).focus();
        if (owner === 'retry' && outcome === 'fixed') await page.screenshot({ path: info.outputPath('retrying.png') });
        await release(page, 1, outcome);
        await expectOutcome(page, outcome);
        const target = owner === 'outside' ? outside(page)
          : outcome === 'error' ? retry(page) : outcome === 'fixed' ? zone(page) : follows(page);
        await expect(target).toBeFocused();
        if (owner === 'retry') await expect(target).toBeInViewport();
        if (owner === 'retry' && outcome === 'fixed') await page.screenshot({ path: info.outputPath('recovered.png') });
        if (outcome !== 'error') {
          await oldRetry!.evaluate(node => (node as HTMLButtonElement).click());
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        }
        expect(await page.evaluate(() => window.__timezoneReadRecovery.reads)).toHaveLength(2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });
    }
  }

  for (const outcome of ['fixed', 'follows_host'] as const) {
    test(`initial timezone ${outcome} loads without moving outside focus at ${width}px`, async ({ page }) => {
      await open(page, width);
      await outside(page).focus();
      await release(page, 0, outcome);
      await expectOutcome(page, outcome);
      await expect(outside(page)).toBeFocused();
      expect(await page.evaluate(() => window.__timezoneReadRecovery.reads)).toHaveLength(1);
    });
  }

  test(`a second timezone failure remains keyboard recoverable at ${width}px`, async ({ page }) => {
    await failInitial(page, width);
    await activateRetry(page);
    await release(page, 1, 'error');
    await expectOutcome(page, 'error');
    await expect(retry(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(loading(page)).toBeFocused();
    await release(page, 2, 'fixed');
    await expectOutcome(page, 'fixed');
    await expect(zone(page)).toBeFocused();
    expect(await page.evaluate(() => window.__timezoneReadRecovery.reads)).toHaveLength(3);
  });

  test(`timezone retry does not reclaim focus from another Server tab at ${width}px`, async ({ page }) => {
    await failInitial(page, width);
    await activateRetry(page);
    const tab = page.getByRole('tab', { name: 'Connect a device', exact: true });
    await tab.focus();
    await page.keyboard.press('Enter');
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page)).toBeHidden();
    await release(page, 1, 'fixed');
    await expect(panel(page)).toHaveAttribute('data-recued-server-timezone-state', 'ready');
    await expect(panel(page).locator('[data-recued-server-timezone-zone]')).toHaveValue('Europe/London');
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  for (const outcome of ['fixed', 'error'] as const) {
    test(`a disposed timezone retry ${outcome} leaves the replacement draft and focus alone at ${width}px`, async ({ page }) => {
      await failInitial(page, width);
      await activateRetry(page);
      await page.evaluate(() => window.__app.setHash('#yours'));
      await expect(panel(page)).toHaveCount(0);
      await page.evaluate(() => window.__app.setHash('#settings/server/timezone'));
      await expect(panel(page)).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.__timezoneReadRecovery.reads.length)).toBe(3);
      await release(page, 2, 'fixed');
      await expectOutcome(page, 'fixed');
      await zone(page).fill('Asia/Tokyo');
      await zone(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(5, 10, 'backward'));
      await release(page, 1, outcome);
      // Drain the old reply's transport and render continuations.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(zone(page)).toHaveValue('Asia/Tokyo');
      await expect(zone(page)).toBeFocused();
      expect(await zone(page).evaluate((input: HTMLInputElement) =>
        [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([5, 10, 'backward']);
      await expect(panel(page).getByRole('alert')).toHaveCount(0);
      expect(await page.evaluate(() => window.__timezoneReadRecovery.reads)).toHaveLength(3);
    });
  }
}
