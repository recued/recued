import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

type Outcome = 'success' | 'empty' | 'error';
type Reply = { result?: unknown; error?: { code: string; message: string } };
interface MaintenanceReadFixture {
  mode: Outcome | 'hold';
  reads: unknown[];
  writes: Array<{ method: string; args: unknown }>;
  pending(): number;
  settleInitial(outcome: Outcome): void;
  release(index: number, outcome: Outcome): void;
}
declare global { interface Window { __maintenanceReadRecovery: MaintenanceReadFixture } }

const panel = (page: Page) => page.locator('[data-recued-maintenance-panel-host]');
const retry = (page: Page) => panel(page).getByRole('button', { name: 'Retry loading maintenance tasks', exact: true });
const heading = (page: Page) => panel(page).getByRole('heading', { name: 'Maintenance', exact: true });
const loading = (page: Page) => panel(page).getByRole('status');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside maintenance settings', exact: true });
const release = (page: Page, index: number, outcome: Outcome) =>
  page.evaluate(args => window.__maintenanceReadRecovery.release(args.index, args.outcome), { index, outcome });
const drain = (page: Page) => page.evaluate(() =>
  new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
  expect(await page.evaluate(() => window.__maintenanceReadRecovery?.writes ?? [])).toEqual([]);
});

const open = async (page: Page, width: number, outcome: Outcome = 'error') => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(now => {
    const pending: Array<{ resolve(reply: Reply): void; released: boolean }> = [];
    const reply = (value: Outcome): Reply => value === 'error'
      ? { error: { code: 'UNAVAILABLE', message: 'Maintenance status temporarily unavailable.' } }
      : { result: { tasks: value === 'empty' ? [] : [{
        meta: { id: 'audit-compaction', description: 'Compact repetitive audit rows', interruptible: true, kind: 'core' },
        state: { task_id: 'audit-compaction', cursor: { kind: 'complete' }, last_run_at: now - 60_000,
          last_run_duration_ms: 420, last_status: 'complete', consecutive_errors: 0 },
      }] } };
    const fixture: MaintenanceReadFixture = {
      mode: 'hold', reads: [], writes: [],
      pending: () => pending.filter(item => !item.released).length,
      settleInitial(value) {
        fixture.mode = value;
        for (const item of pending) if (!item.released) item.resolve(reply(value));
        pending.length = 0;
      },
      release(index, value) {
        const item = pending[index];
        if (!item || item.released) throw new Error(`No pending maintenance read ${index}`);
        item.released = true;
        item.resolve(reply(value));
      },
    };
    Object.assign(window, {
      __maintenanceReadRecovery: fixture,
      __connectionsFixture: async (method: string, args: unknown): Promise<Reply | undefined> => {
        if (method === 'housekeeping.status.read') {
          fixture.reads.push(args);
          return fixture.mode === 'hold'
            ? new Promise(resolve => { pending.push({ resolve, released: false }); })
            : reply(fixture.mode);
        }
        if (method === 'housekeeping.task.run_now' || method === 'server.runPressureReclaim') {
          fixture.writes.push({ method, args });
        }
        return undefined;
      },
    });
    const button = document.createElement('button');
    button.textContent = 'Outside maintenance settings';
    document.body.appendChild(button);
    window.__app.setHash('#settings/server/maintenance');
  }, FIXED_NOW);
  await expect(panel(page)).toBeVisible();
  await expect(loading(page)).toHaveText('Loading maintenance tasks…');
  await drain(page);
  await outside(page).focus();
  await page.evaluate(value => window.__maintenanceReadRecovery.settleInitial(value), outcome);
  if (outcome === 'error') {
    await expect(panel(page).getByRole('alert')).toContainText('Maintenance status temporarily unavailable.');
    await expect(retry(page)).toBeVisible();
    expect((await retry(page).boundingBox())?.height).toBeGreaterThanOrEqual(36);
  } else await expect(heading(page)).toBeVisible();
  await drain(page);
  await expect(outside(page)).toBeFocused();
  // Both Housekeeping and Maintenance read this RPC on Settings mount.
  const initialReads = await page.evaluate(() => window.__maintenanceReadRecovery.reads.length);
  expect(initialReads).toBeGreaterThan(0);
  await page.evaluate(() => { window.__maintenanceReadRecovery.mode = 'hold'; });
  return initialReads;
};

const activateRetry = async (page: Page) => {
  await retry(page).focus();
  await page.keyboard.press('Enter');
  await expect(loading(page)).toHaveText('Loading maintenance tasks…');
  await expect(loading(page)).toBeFocused();
  await expect(loading(page)).toBeInViewport();
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
};
const expectOutcome = async (page: Page, outcome: Outcome) => {
  await expect(loading(page)).toHaveCount(0);
  if (outcome === 'error') {
    await expect(panel(page).getByRole('alert')).toContainText('Maintenance status temporarily unavailable.');
    await expect(retry(page)).toBeVisible();
  } else {
    await expect(heading(page)).toBeVisible();
    await expect(retry(page)).toHaveCount(0);
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Run audit-compaction now' }))
      .toHaveCount(outcome === 'success' ? 1 : 0);
  }
};
const refreshStatus = (page: Page, outcome: Outcome) => page.evaluate(({ now, outcome }) => {
  window.__maintenanceReadRecovery.mode = outcome;
  window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'housekeeping_cycle', at: now, duration_ms: 5,
    tasks_complete: 1, tasks_yielded: 0, tasks_errored: 0,
    per_task: [{ task_id: 'audit-compaction', status: 'complete', duration_ms: 5 }], cursor: 10_000,
  } });
}, { now: FIXED_NOW, outcome });

for (const width of [390, 1280]) {
  for (const outcome of ['success', 'empty', 'error'] as const) {
    for (const owner of ['retry', 'outside'] as const) {
      test(`maintenance retry ${outcome} retains ${owner} focus at ${width}px`, async ({ page }, info) => {
        const initialReads = await open(page, width);
        const oldRetry = await retry(page).elementHandle();
        if (owner === 'retry' && outcome === 'success') await page.screenshot({ path: info.outputPath('read-error.png') });
        await activateRetry(page);
        await oldRetry!.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
        await page.keyboard.press('Enter');
        expect(await page.evaluate(() => window.__maintenanceReadRecovery.reads.length)).toBe(initialReads + 1);
        expect(await page.evaluate(() => window.__maintenanceReadRecovery.pending())).toBe(1);
        if (owner === 'outside') await outside(page).focus();
        if (owner === 'retry' && outcome === 'success') await page.screenshot({ path: info.outputPath('retrying.png') });
        await release(page, 0, outcome);
        await expectOutcome(page, outcome);
        const target = owner === 'outside' ? outside(page) : outcome === 'error' ? retry(page) : heading(page);
        await expect(target).toBeFocused();
        if (owner === 'retry') await expect(target).toBeInViewport();
        if (owner === 'retry' && outcome === 'success') await page.screenshot({ path: info.outputPath('recovered.png') });
        await oldRetry!.evaluate(node => (node as HTMLButtonElement).click());
        await drain(page);
        expect(await page.evaluate(() => window.__maintenanceReadRecovery.reads.length)).toBe(initialReads + 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });
    }
  }

  test(`initial maintenance status does not take outside focus at ${width}px`, async ({ page }) => {
    await open(page, width, 'success');
    await expectOutcome(page, 'success');
    await expect(outside(page)).toBeFocused();
  });

  test(`a second maintenance failure remains keyboard recoverable at ${width}px`, async ({ page }) => {
    const initialReads = await open(page, width);
    await activateRetry(page);
    await release(page, 0, 'error');
    await expectOutcome(page, 'error');
    await expect(retry(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(loading(page)).toBeFocused();
    await release(page, 1, 'success');
    await expectOutcome(page, 'success');
    await expect(heading(page)).toBeFocused();
    expect(await page.evaluate(() => window.__maintenanceReadRecovery.reads.length)).toBe(initialReads + 2);
  });

  test(`a maintenance cycle recovers the error without another Retry at ${width}px`, async ({ page }) => {
    await open(page, width);
    await retry(page).focus();
    await refreshStatus(page, 'success');
    await expectOutcome(page, 'success');
    await expect(heading(page)).toBeFocused();
  });

  test(`a newer empty maintenance cycle retires a pending Retry error at ${width}px`, async ({ page }) => {
    await open(page, width);
    await activateRetry(page);
    await refreshStatus(page, 'empty');
    await expectOutcome(page, 'empty');
    await expect(heading(page)).toBeFocused();
    expect(await page.evaluate(() => window.__maintenanceReadRecovery.pending())).toBe(1);
    await release(page, 0, 'error');
    await drain(page);
    await expectOutcome(page, 'empty');
    await expect(heading(page)).toBeFocused();
  });

  test(`maintenance retry leaves focus on the newly selected Server tab at ${width}px`, async ({ page }) => {
    await open(page, width);
    await activateRetry(page);
    const tab = page.getByRole('tab', { name: 'Connect a device', exact: true });
    await tab.focus();
    await page.keyboard.press('Enter');
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page)).toBeHidden();
    await release(page, 0, 'success');
    await drain(page);
    await expect(panel(page).getByRole('heading', { name: 'Maintenance', exact: true, includeHidden: true })).toHaveCount(1);
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`a disposed maintenance retry ${outcome} leaves the replacement panel alone at ${width}px`, async ({ page }) => {
      await open(page, width);
      await activateRetry(page);
      await page.evaluate(() => window.__app.setHash('#yours'));
      await expect(panel(page)).toHaveCount(0);
      await page.evaluate(() => {
        window.__maintenanceReadRecovery.mode = 'success';
        window.__app.setHash('#settings/server/maintenance');
      });
      await expectOutcome(page, 'success');
      const trigger = panel(page).getByRole('button', { name: 'Run audit-compaction now' });
      await trigger.focus();
      await drain(page);
      const before = await panel(page).innerHTML();
      await release(page, 0, outcome);
      await drain(page);
      expect(await panel(page).innerHTML()).toBe(before);
      await expect(trigger).toBeFocused();
    });
  }
}
