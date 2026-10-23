import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, HARNESS_URL } from './helpers/full-app.js';

const requiredReads = ['housekeeping.config.read', 'housekeeping.status.read', 'housekeeping.trust.read'] as const;
type ReadRpc = typeof requiredReads[number];
type Outcome = 'success' | 'error' | 'empty';
type Reply = { result?: unknown; error?: { code: string; message: string } };
interface HousekeepingReadFixture {
  mode: 'hold' | 'ready' | 'error';
  emptyStatus: boolean;
  reads: Record<string, number>;
  writes: Array<{ method: string; args: unknown }>;
  pending(): number;
  settleInitial(outcome: Outcome): void;
  release(index: number, outcome: Outcome): void;
}
declare global { interface Window { __housekeepingReadRecovery: HousekeepingReadFixture } }

const panel = (page: Page) => page.locator('[data-recued-housekeeping-panel-host]');
const retry = (page: Page) => panel(page).getByRole('button', { name: 'Retry loading housekeeping', exact: true });
const loading = (page: Page) => panel(page).getByRole('status');
const heading = (page: Page) => panel(page).getByRole('heading', { name: 'Housekeeping', exact: true });
const outside = (page: Page) => page.getByRole('button', { name: 'Outside housekeeping settings', exact: true });
const drain = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const readCounts = (page: Page) => page.evaluate(() => ({ ...window.__housekeepingReadRecovery.reads }));
const release = (page: Page, index: number, outcome: Outcome) =>
  page.evaluate(args => window.__housekeepingReadRecovery.release(args.index, args.outcome), { index, outcome });
let externalRequests: string[] = [];
let pageErrors: Error[] = [];

// Boot once per journey with the Housekeeping fixture enabled.
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  externalRequests = [];
  page.on('pageerror', error => pageErrors.push(error));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(HARNESS_URL).origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.map(error => error.message)).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(await page.evaluate(() => window.__housekeepingReadRecovery?.writes ?? [])).toEqual([]);
});

const open = async (page: Page, width: number, failedRead: ReadRpc = requiredReads[0], outcome: Outcome = 'error') => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${HARNESS_URL}?housekeeping=ready&settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(failedRead => {
    const pending: Array<{ resolve(reply: Reply | undefined): void; released: boolean }> = [];
    const reply = (outcome: Outcome): Reply | undefined => outcome === 'error'
      ? { error: { code: 'UNAVAILABLE', message: 'Housekeeping initial read temporarily unavailable.' } }
      : outcome === 'empty' ? { result: { tasks: [] } } : undefined;
    const fixture: HousekeepingReadFixture = {
      mode: 'hold', emptyStatus: false, reads: {}, writes: [],
      pending: () => pending.filter(item => !item.released).length,
      settleInitial(outcome) {
        fixture.mode = outcome === 'error' ? 'error' : 'ready';
        for (const item of pending) if (!item.released) item.resolve(reply(outcome));
        pending.length = 0;
      },
      release(index, outcome) {
        const item = pending[index];
        if (!item || item.released) throw new Error(`No pending Housekeeping read ${index}`);
        item.released = true;
        item.resolve(reply(outcome));
      },
    };
    Object.assign(window, {
      __housekeepingReadRecovery: fixture,
      __connectionsFixture: async (method: string, args: unknown): Promise<Reply | undefined> => {
        fixture.reads[method] = (fixture.reads[method] ?? 0) + 1;
        if ((method.startsWith('housekeeping.') && /\.(write|run_now|reset|dismiss_promotion|dismiss)$/.test(method))
          || method === 'mcp.visibility.write') fixture.writes.push({ method, args });
        if (method === 'housekeeping.status.read' && fixture.emptyStatus && fixture.mode === 'ready') return { result: { tasks: [] } };
        if (method !== failedRead || fixture.mode === 'ready') return undefined;
        if (fixture.mode === 'error') return reply('error');
        return new Promise(resolve => { pending.push({ resolve, released: false }); });
      },
    });
    const button = document.createElement('button');
    button.textContent = 'Outside housekeeping settings';
    document.body.appendChild(button);
    window.__app.setHash('#settings/housekeeping');
  }, failedRead);
  await expect(panel(page)).toBeVisible();
  await expect(loading(page)).toHaveText('Loading housekeeping…');
  await expect(loading(page)).toHaveAttribute('aria-atomic', 'true');
  await drain(page);
  await outside(page).focus();
  await page.evaluate(value => window.__housekeepingReadRecovery.settleInitial(value), outcome);
  await expectOutcome(page, outcome);
  await drain(page);
  await expect(outside(page)).toBeFocused();
  const counts = await readCounts(page);
  for (const method of requiredReads) expect(counts[method]).toBeGreaterThan(0);
  await page.evaluate(() => { window.__housekeepingReadRecovery.mode = 'hold'; });
  return counts;
};
const expectOutcome = async (page: Page, outcome: Outcome) => {
  await expect(loading(page)).toHaveCount(0);
  if (outcome === 'error') {
    await expect(panel(page).getByRole('alert')).toContainText('Housekeeping initial read temporarily unavailable.');
    await expect(retry(page)).toBeVisible();
    expect((await retry(page).boundingBox())?.height).toBeGreaterThanOrEqual(36);
    await expect(panel(page).getByRole('region', { name: 'Idle schedule', exact: true })).toHaveCount(0);
  } else {
    await expect(panel(page).getByRole('region', { name: 'Idle schedule', exact: true })).toBeVisible();
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    await expect(retry(page)).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Expand summary details', exact: true }))
      .toHaveCount(outcome === 'empty' ? 0 : 1);
  }
};
const activateRetry = async (page: Page) => {
  await retry(page).focus();
  await page.keyboard.press('Enter');
  await expect(loading(page)).toHaveText('Loading housekeeping…');
  await expect(loading(page)).toBeFocused();
  await expect(loading(page)).toBeInViewport();
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
};
const expectOneReadGroup = async (page: Page, before: Record<string, number>, groups = 1) => {
  const after = await readCounts(page);
  for (const method of requiredReads) expect(after[method], method).toBe(before[method]! + groups);
};

for (const width of [390, 1280]) {
  for (const failedRead of requiredReads) {
    for (const outcome of ['success', 'error'] as const) {
      for (const owner of ['retry', 'outside'] as const) {
        test(`Housekeeping read recovery ${failedRead} ${outcome} retains ${owner} focus at ${width}px`, async ({ page }, info) => {
          const before = await open(page, width, failedRead);
          const oldRetry = await retry(page).elementHandle();
          const capture = owner === 'retry' && outcome === 'success' && failedRead === requiredReads[0];
          if (capture) await page.screenshot({ path: info.outputPath('read-error.png') });
          await activateRetry(page);
          await oldRetry!.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
          await page.keyboard.press('Enter');
          await expectOneReadGroup(page, before);
          expect(await page.evaluate(() => window.__housekeepingReadRecovery.pending())).toBe(1);
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
          await expectOneReadGroup(page, before);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        });
      }
    }
  }

  test(`Housekeeping read recovery accepts an empty task list at ${width}px`, async ({ page }) => {
    await open(page, width, 'housekeeping.status.read');
    await activateRetry(page);
    await release(page, 0, 'empty');
    await expectOutcome(page, 'empty');
    await expect(heading(page)).toBeFocused();
  });

  test(`Housekeeping read recovery preserves outside focus on initial success at ${width}px`, async ({ page }) => {
    await open(page, width, requiredReads[0], 'success');
    await expect(outside(page)).toBeFocused();
  });

  test(`Housekeeping read recovery stays keyboard usable after a second failure at ${width}px`, async ({ page }) => {
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
    await expectOneReadGroup(page, before, 2);
  });

  test(`Housekeeping read recovery leaves a newly selected Settings section focused at ${width}px`, async ({ page }) => {
    await open(page, width);
    await activateRetry(page);
    const account = page.locator('[data-recued-settings-nav-item="account"]');
    await account.focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeHidden();
    await release(page, 0, 'success');
    await expect(panel(page).locator('.housekeeping-schedule')).toHaveCount(1);
    await expect(account).toBeFocused();
    await expect(page).toHaveURL(/#settings\/account$/);
  });

  test(`Housekeeping read recovery waits for the required group after a newer empty cycle at ${width}px`, async ({ page }) => {
    await open(page, width);
    await activateRetry(page);
    const before = (await readCounts(page))['housekeeping.status.read']!;
    await page.evaluate(now => {
      window.__housekeepingReadRecovery.mode = 'ready';
      window.__housekeepingReadRecovery.emptyStatus = true;
      window.__app.fireMessage({ type: 'server_event', event: {
        kind: 'housekeeping_cycle', at: now, duration_ms: 5,
        tasks_complete: 1, tasks_yielded: 0, tasks_errored: 0,
        per_task: [{ task_id: 'audit-compaction', status: 'complete', duration_ms: 5 }], cursor: 10_000,
      } });
    }, FIXED_NOW);
    await expect.poll(async () => (await readCounts(page))['housekeeping.status.read']!).toBeGreaterThan(before);
    await drain(page);
    await expect(loading(page)).toBeFocused();
    await expect(panel(page).getByRole('region', { name: 'Idle schedule', exact: true })).toHaveCount(0);
    await release(page, 0, 'success');
    await expectOutcome(page, 'empty');
    await expect(heading(page)).toBeFocused();
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`Housekeeping read recovery ignores disposed Retry ${outcome} after a replacement draft at ${width}px`, async ({ page }) => {
      await open(page, width);
      await activateRetry(page);
      await page.evaluate(() => window.__app.setHash('#yours'));
      await expect(panel(page)).toHaveCount(0);
      await page.evaluate(() => {
        window.__housekeepingReadRecovery.mode = 'ready';
        window.__app.setHash('#settings/housekeeping');
      });
      await expectOutcome(page, 'success');
      const custom = panel(page).locator('[data-action="housekeeping-preset-pick"][value="custom"]');
      await custom.focus();
      await page.keyboard.press('Space');
      const budget = panel(page).locator('[data-action="housekeeping-custom-budget"]');
      await budget.fill('065000');
      const counts = await readCounts(page);
      await release(page, 0, outcome);
      await drain(page);
      await expect(budget).toHaveValue('065000');
      await expect(budget).toBeFocused();
      await expect(custom).toBeChecked();
      await expect(panel(page).getByRole('alert')).toHaveCount(0);
      expect(await readCounts(page)).toEqual(counts);
    });
  }
}
