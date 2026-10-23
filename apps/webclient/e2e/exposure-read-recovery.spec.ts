import { expect, test, type Page } from '@playwright/test';
import { applyPreset, type NetworkLocalUrlsResponse } from '@recued/contracts';
import { FIXED_NOW, HARNESS_URL } from './helpers/full-app.js';

type Outcome = 'success' | 'error';
type LanOutcome = Outcome | 'public';
type LanMode = 'ready' | 'hold' | 'error';
type Reply = { result?: unknown; error?: { code: string; message: string } };
interface ExposureReadFixture {
  mode: 'hold' | 'ready';
  reads: Record<string, number>;
  writes: Array<{ method: string; args: unknown }>;
  pending(): number;
  settleInitial(outcome: Outcome): void;
  release(index: number, outcome: Outcome): void;
  releaseLan(round: 'initial' | 'retry', outcome: LanOutcome): void;
}
declare global { interface Window { __exposureReadRecovery: ExposureReadFixture } }

const panel = (page: Page) => page.locator('[data-recued-exposure-panel]');
const retry = (page: Page) => panel(page).getByRole('button', { name: 'Retry loading exposure settings', exact: true });
const loading = (page: Page) => panel(page).getByRole('status');
const heading = (page: Page) => panel(page).getByRole('heading', { name: 'Exposure & serving', exact: true });
const outside = (page: Page) => page.getByRole('button', { name: 'Outside Exposure settings', exact: true });
const consent = (page: Page) => panel(page).locator('[data-recued-exposure-public-mcp]');
const dialog = (page: Page) => panel(page).getByRole('dialog', { name: 'Let AI apps in from outside?', exact: true });
const posture = (page: Page) => panel(page).locator('[data-recued-exposure-lan-posture]');
const drain = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const readCount = (page: Page) => page.evaluate(() => window.__exposureReadRecovery.reads['exposure.get']!);
const release = (page: Page, index: number, outcome: Outcome) =>
  page.evaluate(args => window.__exposureReadRecovery.release(args.index, args.outcome), { index, outcome });
const releaseLan = (page: Page, round: 'initial' | 'retry', outcome: LanOutcome) =>
  page.evaluate(args => window.__exposureReadRecovery.releaseLan(args.round, args.outcome), { round, outcome });
let errors: Error[] = [];
let externalRequests: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = []; externalRequests = [];
  page.on('pageerror', error => errors.push(error));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(HARNESS_URL).origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
});
test.afterEach(async ({ page }) => {
  expect(errors.map(error => error.message)).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(await page.evaluate(() => window.__exposureReadRecovery?.writes ?? [])).toEqual([]);
});

// Connect a device also reads exposure.get at startup. Hold and settle the
// whole initial group before measuring the Exposure panel's own Retry reads.
const open = async (page: Page, width: number, lanMode: LanMode = 'ready', outcome: Outcome = 'error') => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(lanMode => {
    type Pending = { resolve(reply: Reply | undefined): void; released: boolean };
    const inventory: Pending[] = [];
    const lan: Pending[] = [];
    let initialLanCount = 0;
    const readReply = (outcome: Outcome): Reply | undefined => outcome === 'error'
      ? { error: { code: 'UNAVAILABLE', message: 'Exposure read temporarily unavailable.' } } : undefined;
    const lanReply = (outcome: LanOutcome): Reply => {
      if (outcome === 'error') return { error: { code: 'UNAVAILABLE', message: 'LAN status temporarily unavailable.' } };
      const result: NetworkLocalUrlsResponse = { urls: [], lan_port: 7717, public_port: 443,
        lan_exposure: { publicly_routable: outcome === 'public', wildcard: false,
          public_addresses: outcome === 'public' ? ['203.0.113.7'] : [] } };
      return { result };
    };
    const fixture: ExposureReadFixture = {
      mode: 'hold', reads: {}, writes: [],
      pending: () => inventory.filter(item => !item.released).length,
      settleInitial(outcome) {
        initialLanCount = lan.length;
        for (const item of inventory) if (!item.released) item.resolve(readReply(outcome));
        inventory.length = 0;
      },
      release(index, outcome) {
        const item = inventory[index];
        if (!item || item.released) throw new Error(`No pending Exposure read ${index}`);
        item.released = true;
        item.resolve(readReply(outcome));
      },
      releaseLan(round, outcome) {
        const items = round === 'initial' ? lan.slice(0, initialLanCount) : lan.slice(initialLanCount);
        if (!items.length) throw new Error(`No ${round} LAN reads`);
        for (const item of items) if (!item.released) {
          item.released = true;
          item.resolve(lanReply(outcome));
        }
      },
    };
    Object.assign(window, {
      __exposureReadRecovery: fixture,
      __connectionsFixture: async (method: string, args: unknown): Promise<Reply | undefined> => {
        fixture.reads[method] = (fixture.reads[method] ?? 0) + 1;
        if (method.startsWith('exposure.') && method !== 'exposure.get') fixture.writes.push({ method, args });
        if (method === 'network.local_urls') {
          if (lanMode !== 'hold') return lanReply(lanMode === 'error' ? 'error' : 'success');
          return new Promise(resolve => { lan.push({ resolve, released: false }); });
        }
        if (method !== 'exposure.get' || fixture.mode === 'ready') return undefined;
        return new Promise(resolve => { inventory.push({ resolve, released: false }); });
      },
    });
    const button = document.createElement('button');
    button.textContent = 'Outside Exposure settings';
    document.body.appendChild(button);
    window.__app.setHash('#settings/server/exposure');
  }, lanMode);
  await expect(panel(page)).toBeVisible();
  await expect(loading(page)).toHaveText('Loading exposure state…');
  await expect(loading(page)).toHaveAttribute('aria-atomic', 'true');
  await drain(page);
  await outside(page).focus();
  await page.evaluate(outcome => window.__exposureReadRecovery.settleInitial(outcome), outcome);
  await expectOutcome(page, outcome);
  await drain(page);
  await expect(outside(page)).toBeFocused();
  return readCount(page);
};
const expectOutcome = async (page: Page, outcome: Outcome) => {
  await expect(loading(page)).toHaveCount(0);
  if (outcome === 'error') {
    await expect(panel(page).getByRole('alert')).toContainText('Recued could not load these settings.');
    await expect(retry(page)).toBeVisible();
    expect((await retry(page).boundingBox())?.height).toBeGreaterThanOrEqual(36);
  } else {
    await expect(heading(page)).toBeVisible();
    await expect(panel(page).locator('[data-recued-exposure-path="reception"]')).toBeVisible();
    await expect(retry(page)).toHaveCount(0);
  }
};
const activateRetry = async (page: Page) => {
  await retry(page).focus();
  await page.keyboard.press('Enter');
  await expect(loading(page)).toHaveText('Loading exposure state…');
  await expect(loading(page)).toBeFocused();
  await expect(loading(page)).toBeInViewport();
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
};
const broadcast = (page: Page) => page.evaluate(event => window.__app.fireMessage({ type: 'server_event', event }), {
  kind: 'exposure_changed', resolution: applyPreset('lan_only', { acknowledged: false }),
  derived_preset_label: 'lan_only', public_mcp_acknowledgement: { acknowledged: false },
  changed_at: FIXED_NOW + 10, changed_by_client_id: 'device-other', cursor: 10_000,
});

for (const width of [390, 1280]) {
  for (const lanMode of ['ready', 'hold', 'error'] as const) {
    for (const outcome of ['success', 'error'] as const) {
      for (const owner of ['retry', 'outside'] as const) {
        test(`Exposure read recovery with LAN ${lanMode} and ${outcome} retains ${owner} at ${width}px`, async ({ page }, info) => {
          const before = await open(page, width, lanMode);
          const oldRetry = await retry(page).elementHandle();
          const capture = lanMode === 'hold' && outcome === 'success' && owner === 'retry';
          if (capture) await page.screenshot({ path: info.outputPath('read-error.png') });
          await activateRetry(page);
          await oldRetry!.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
          await page.keyboard.press('Enter');
          expect(await readCount(page)).toBe(before + 1);
          expect(await page.evaluate(() => window.__exposureReadRecovery.pending())).toBe(1);
          if (owner === 'outside') await outside(page).focus();
          if (capture) await page.screenshot({ path: info.outputPath('retrying.png') });
          await release(page, 0, outcome);
          await expectOutcome(page, outcome);
          const target = owner === 'outside' ? outside(page) : outcome === 'error' ? retry(page) : heading(page);
          await expect(target).toBeFocused();
          if (owner === 'retry') await expect(target).toBeInViewport();
          if (capture) await page.screenshot({ path: info.outputPath('recovered.png') });
          await oldRetry!.evaluate(node => (node as HTMLButtonElement).click());
          await drain(page);
          expect(await readCount(page)).toBe(before + 1);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        });
      }
    }
  }

  test(`Exposure read recovery stays keyboard usable after another failure at ${width}px`, async ({ page }) => {
    const before = await open(page, width);
    await activateRetry(page);
    await release(page, 0, 'error');
    await expectOutcome(page, 'error');
    await expect(retry(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(loading(page)).toBeFocused();
    await release(page, 1, 'success');
    await expectOutcome(page, 'success');
    await expect(heading(page)).toBeFocused();
    expect(await readCount(page)).toBe(before + 2);
  });

  test(`Exposure read recovery preserves outside focus on initial success at ${width}px`, async ({ page }) => {
    await open(page, width, 'ready', 'success');
    await expect(outside(page)).toBeFocused();
  });

  for (const destination of ['consent', 'example'] as const) {
    test(`Exposure read recovery transfers focus from the recovery heading to ${destination} at ${width}px`, async ({ page }) => {
      await open(page, width);
      await activateRetry(page);
      await release(page, 0, 'success');
      await expect(heading(page)).toBeFocused();
      const trigger = destination === 'consent' ? consent(page)
        : panel(page).locator('[data-recued-exposure-connect-example]');
      // A native WebKit pointer click can leave the heading focused until
      // the dialog takes ownership. Read restoration must yield to it.
      await trigger.click();
      const modal = destination === 'consent' ? dialog(page)
        : panel(page).getByRole('dialog', { name: 'Connect an AI app to this server', exact: true });
      await expect(destination === 'consent' ? modal.getByRole('textbox') : modal).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(modal).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  }

  for (const outcome of ['success', 'error'] as const) {
    test(`Exposure read recovery leaves a newly selected Server tab focused through ${outcome} at ${width}px`, async ({ page }) => {
      await open(page, width);
      await activateRetry(page);
      const connect = page.getByRole('tab', { name: 'Connect a device', exact: true });
      await connect.focus();
      await page.keyboard.press('Enter');
      await expect(panel(page)).toBeHidden();
      await release(page, 0, outcome);
      await expect(panel(page).locator(outcome === 'success' ? '.exposure-title' : '[data-recued-exposure-retry]')).toHaveCount(1);
      await expect(connect).toBeFocused();
      await expect(connect).toHaveAttribute('aria-selected', 'true');
    });

    test(`Exposure read recovery ignores a disposed Retry ${outcome} at ${width}px`, async ({ page }) => {
      await open(page, width);
      await activateRetry(page);
      await page.evaluate(() => window.__app.setHash('#yours'));
      await expect(panel(page)).toHaveCount(0);
      await page.evaluate(() => {
        window.__exposureReadRecovery.mode = 'ready';
        window.__app.setHash('#settings/server/exposure');
      });
      await expect(consent(page)).toBeVisible();
      await consent(page).focus();
      await page.keyboard.press('Enter');
      const phrase = dialog(page).getByRole('textbox');
      await expect(phrase).toBeFocused();
      const current = await phrase.elementHandle();
      await release(page, 0, outcome);
      await drain(page);
      expect(await current!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      await expect(phrase).toBeFocused();
    });

    for (const owner of ['idle', 'confirm', 'outside'] as const) {
      test(`Exposure read recovery preserves ${owner} controls through delayed LAN ${outcome} at ${width}px`, async ({ page }) => {
        await open(page, width, 'hold', 'success');
        await expect(posture(page)).toHaveCount(0);
        await consent(page).focus();
        if (owner !== 'idle') {
          await page.keyboard.press('Enter');
          await dialog(page).getByRole('textbox').fill('enable public MC');
          await dialog(page).getByRole('textbox').evaluate(node => (node as HTMLInputElement).setSelectionRange(3, 8));
        }
        const target = owner === 'idle' ? consent(page) : owner === 'confirm' ? dialog(page).getByRole('textbox') : outside(page);
        await target.focus();
        const current = await target.elementHandle();
        await releaseLan(page, 'initial', outcome);
        await drain(page);
        expect(await current!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
        await expect(target).toBeFocused();
        if (owner !== 'idle') {
          const phrase = dialog(page).getByRole('textbox');
          await expect(phrase).toHaveValue('enable public MC');
          expect(await phrase.evaluate(node => [(node as HTMLInputElement).selectionStart, (node as HTMLInputElement).selectionEnd])).toEqual([3, 8]);
        }
        if (outcome === 'success') await expect(posture(page)).toHaveAttribute('data-recued-exposure-lan-state', 'local');
        else await expect(posture(page)).toHaveCount(0);
      });
    }
  }

  test(`Exposure read recovery rejects older LAN replies after Retry at ${width}px`, async ({ page }) => {
    await open(page, width, 'hold');
    await activateRetry(page);
    await release(page, 0, 'success');
    await expectOutcome(page, 'success');
    await expect(heading(page)).toBeFocused();
    await releaseLan(page, 'retry', 'public');
    await expect(posture(page)).toHaveAttribute('data-recued-exposure-lan-state', 'public');
    const current = await posture(page).elementHandle();
    await releaseLan(page, 'initial', 'success');
    await drain(page);
    expect(await current!.evaluate(node => node.isConnected)).toBe(true);
    await expect(posture(page)).toHaveAttribute('data-recued-exposure-lan-state', 'public');
    await expect(heading(page)).toBeFocused();
  });

  for (const owner of ['loading', 'outside'] as const) {
    test(`Exposure read recovery keeps live recovery through a late failure with ${owner} focus at ${width}px`, async ({ page }) => {
      await open(page, width);
      await activateRetry(page);
      if (owner === 'outside') await outside(page).focus();
      await broadcast(page);
      await expectOutcome(page, 'success');
      await expect(owner === 'outside' ? outside(page) : heading(page)).toBeFocused();
      await consent(page).focus();
      await page.keyboard.press('Enter');
      const phrase = dialog(page).getByRole('textbox');
      await phrase.fill('enable public MC');
      const current = await phrase.elementHandle();
      await release(page, 0, 'error');
      await drain(page);
      expect(await current!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      await expect(phrase).toHaveValue('enable public MC');
      await expect(panel(page).locator('[data-recued-exposure-load-error]')).toHaveCount(0);
    });
  }
}
