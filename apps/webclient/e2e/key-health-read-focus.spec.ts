import { expect, test, type Page } from '@playwright/test';
import type { RotationResult, ServerSystemStatus } from '@recued/contracts';
import { FIXED_NOW, HARNESS_URL } from './helpers/full-app.js';

type ReadRpc = 'key.health' | 'system.status';
type Outcome = 'success' | 'error' | 'sealed';
type Reply = { result?: unknown; error?: { code: string; message: string } };
interface KeyHealthReadFixture {
  healthMode: 'hold' | 'ready';
  reads: Record<ReadRpc, number>;
  writes: unknown[];
  expectedRotations: number;
  pending(method: ReadRpc): number;
  settleInitial(outcome: Outcome): void;
  release(method: ReadRpc, index: number, outcome: Outcome): void;
}
declare global { interface Window { __keyHealthReadFocus: KeyHealthReadFixture } }

const panel = (page: Page) => page.locator('[data-recued-key-health-panel]');
const retry = (page: Page) => panel(page).getByRole('button', { name: 'Retry loading key health', exact: true });
const loading = (page: Page) => panel(page).getByRole('status');
const heading = (page: Page) => panel(page).getByRole('heading', { name: 'Key Health', exact: true });
const outside = (page: Page) => page.getByRole('button', { name: 'Outside Key Health', exact: true });
const rotate = (page: Page) => panel(page).getByRole('button', { name: 'Rotate Master encryption key now', exact: true });
const confirm = (page: Page) => panel(page).getByRole('button', { name: 'Yes, continue', exact: true });
const cancel = (page: Page) => panel(page).getByRole('button', { name: 'Cancel', exact: true });
const posture = (page: Page) => panel(page).locator('[data-recued-keyfile-posture]');
const drain = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const readCounts = (page: Page) => page.evaluate(() => ({ ...window.__keyHealthReadFocus.reads }));
const release = (page: Page, method: ReadRpc, index: number, outcome: Outcome) =>
  page.evaluate(args => window.__keyHealthReadFocus.release(args.method, args.index, args.outcome), { method, index, outcome });
let pageErrors: Error[] = [];
let externalRequests: string[] = [];

// Each journey boots once. Every rotation reply here is synthetic and local.
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
  const receipt = await page.evaluate(() => ({
    writes: window.__keyHealthReadFocus.writes,
    expected: window.__keyHealthReadFocus.expectedRotations,
    calls: window.__app.rpcCallCount('key.rotate'),
  }));
  expect(receipt.writes).toEqual(Array.from({ length: receipt.expected }, () => ({ op: 'master_dek_rotate' })));
  expect(receipt.calls).toBe(receipt.expected);
});

const open = async (page: Page, width: number, outcome: Outcome = 'error', holdPosture = false) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(({ holdPosture, now }) => {
    type Pending = { resolve(reply: Reply | undefined): void; released: boolean };
    const pending: Record<ReadRpc, Pending[]> = { 'key.health': [], 'system.status': [] };
    const reply = (method: ReadRpc, outcome: Outcome): Reply | undefined => {
      if (outcome === 'error') return { error: { code: 'UNAVAILABLE', message: method === 'key.health'
        ? 'Key inventory temporarily unavailable.' : 'Keyfile status temporarily unavailable.' } };
      if (outcome === 'sealed') {
        const status: ServerSystemStatus = {
          name: 'Audit server', version: '0.0.0-harness', uptime_seconds: 7200,
          paired_client_count: 2, paired_client_connected: 1, ws_state: 'serving', last_sync_at: now,
          executions_last_hour: 3, executions_last_24h: 12, pending_asks: 1,
          ask_load: null, schedule_queue_depth: 0, recent_error_count: 0, keyfile_sealing: 'machine', snapshot_at: now,
        };
        return { result: { status } };
      }
      return undefined;
    };
    const fixture: KeyHealthReadFixture = {
      healthMode: 'hold', reads: { 'key.health': 0, 'system.status': 0 }, writes: [], expectedRotations: 0,
      pending: method => pending[method].filter(item => !item.released).length,
      settleInitial(outcome) {
        for (const item of pending['key.health']) if (!item.released) item.resolve(reply('key.health', outcome));
        pending['key.health'].length = 0;
      },
      release(method, index, outcome) {
        const item = pending[method][index];
        if (!item || item.released) throw new Error(`No pending ${method} read ${index}`);
        item.released = true;
        item.resolve(reply(method, outcome));
      },
    };
    Object.assign(window, {
      __keyHealthReadFocus: fixture,
      __connectionsFixture: async (method: string, args: unknown): Promise<Reply | undefined> => {
        if (method === 'key.rotate') {
          fixture.writes.push(args);
          const result: RotationResult = { ok: true, op: 'master_dek_rotate', key_class: 'master_dek', rotated_at: now };
          return { result };
        }
        if (method !== 'key.health' && method !== 'system.status') return undefined;
        fixture.reads[method]++;
        if ((method === 'key.health' && fixture.healthMode === 'ready') || (method === 'system.status' && !holdPosture)) return undefined;
        return new Promise(resolve => { pending[method].push({ resolve, released: false }); });
      },
    });
    const button = document.createElement('button');
    button.textContent = 'Outside Key Health';
    document.body.appendChild(button);
    window.__app.setHash('#settings/server/key-health');
  }, { holdPosture, now: FIXED_NOW });
  await expect(panel(page)).toBeVisible();
  await expect(loading(page)).toHaveText('Loading key health…');
  await expect(loading(page)).toHaveAttribute('aria-atomic', 'true');
  await expect.poll(() => page.evaluate(() => window.__keyHealthReadFocus.pending('key.health'))).toBe(1);
  await drain(page);
  await outside(page).focus();
  await page.evaluate(value => window.__keyHealthReadFocus.settleInitial(value), outcome);
  await expectOutcome(page, outcome);
  await drain(page);
  await expect(outside(page)).toBeFocused();
  const counts = await readCounts(page);
  expect(counts['key.health']).toBe(1);
  expect(counts['system.status']).toBe(1);
  return counts;
};
const expectOutcome = async (page: Page, outcome: Outcome) => {
  await expect(panel(page)).toHaveAttribute('data-recued-key-health-panel-state', outcome === 'error' ? 'load_error' : 'idle');
  await expect(loading(page)).toHaveCount(0);
  if (outcome === 'error') {
    await expect(panel(page).getByRole('alert')).toContainText('Key inventory temporarily unavailable.');
    await expect(retry(page)).toBeVisible();
    expect((await retry(page).boundingBox())?.height).toBeGreaterThanOrEqual(36);
  } else {
    await expect(heading(page)).toBeVisible();
    await expect(rotate(page)).toBeVisible();
    await expect(retry(page)).toHaveCount(0);
  }
};
const activateRetry = async (page: Page) => {
  await retry(page).focus();
  await page.keyboard.press('Enter');
  await expect(loading(page)).toHaveText('Loading key health…');
  await expect(loading(page)).toBeFocused();
  await expect(loading(page)).toBeInViewport();
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
};
const expectReadGroups = async (page: Page, before: Record<ReadRpc, number>, groups = 1) => {
  const after = await readCounts(page);
  expect(after['key.health']).toBe(before['key.health'] + groups);
  expect(after['system.status']).toBe(before['system.status'] + groups);
};

for (const width of [390, 1280]) {
  for (const outcome of ['success', 'error'] as const) {
    for (const owner of ['retry', 'outside'] as const) {
      test(`Key Health read focus through Retry ${outcome} retains ${owner} at ${width}px`, async ({ page }, info) => {
        const before = await open(page, width);
        const oldRetry = await retry(page).elementHandle();
        const capture = outcome === 'success' && owner === 'retry';
        if (capture) await page.screenshot({ path: info.outputPath('read-error.png') });
        await activateRetry(page);
        await oldRetry!.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
        await page.keyboard.press('Enter');
        await expectReadGroups(page, before);
        expect(await page.evaluate(() => window.__keyHealthReadFocus.pending('key.health'))).toBe(1);
        if (owner === 'outside') await outside(page).focus();
        if (capture) await page.screenshot({ path: info.outputPath('retrying.png') });
        await release(page, 'key.health', 0, outcome);
        await expectOutcome(page, outcome);
        const target = owner === 'outside' ? outside(page) : outcome === 'error' ? retry(page) : heading(page);
        await expect(target).toBeFocused();
        if (owner === 'retry') await expect(target).toBeInViewport();
        if (capture) await page.screenshot({ path: info.outputPath('recovered.png') });
        await oldRetry!.evaluate(node => (node as HTMLButtonElement).click());
        await drain(page);
        await expectReadGroups(page, before);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });
    }
  }

  test(`Key Health read focus preserves outside focus on initial success at ${width}px`, async ({ page }) => {
    await open(page, width, 'success');
    await expect(outside(page)).toBeFocused();
  });

  test(`Key Health read focus stays keyboard usable after another failure at ${width}px`, async ({ page }) => {
    const before = await open(page, width);
    await activateRetry(page);
    await release(page, 'key.health', 0, 'error');
    await expectOutcome(page, 'error');
    await expect(retry(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(loading(page)).toBeFocused();
    await release(page, 'key.health', 1, 'success');
    await expectOutcome(page, 'success');
    await expect(heading(page)).toBeFocused();
    await expectReadGroups(page, before, 2);
  });

  test(`Key Health read focus leaves a newly selected Server tab focused at ${width}px`, async ({ page }) => {
    await open(page, width);
    await activateRetry(page);
    const connect = page.getByRole('tab', { name: 'Connect a device', exact: true });
    await connect.focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeHidden();
    await release(page, 'key.health', 0, 'success');
    await expect(panel(page).locator('.key-health-list')).toHaveCount(1);
    await expect(connect).toBeFocused();
    await expect(connect).toHaveAttribute('aria-selected', 'true');
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`Key Health read focus ignores a disposed Retry ${outcome} at ${width}px`, async ({ page }) => {
      await open(page, width);
      await activateRetry(page);
      await page.evaluate(() => window.__app.setHash('#yours'));
      await expect(panel(page)).toHaveCount(0);
      await page.evaluate(() => {
        window.__keyHealthReadFocus.healthMode = 'ready';
        window.__app.setHash('#settings/server/key-health');
      });
      await expect(rotate(page)).toBeVisible();
      await rotate(page).focus();
      await page.keyboard.press('Enter');
      await confirm(page).focus();
      const current = await confirm(page).elementHandle();
      await release(page, 'key.health', 0, outcome);
      await drain(page);
      await expect(panel(page)).toHaveAttribute('data-recued-key-health-panel-state', 'confirm');
      expect(await current!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      await expect(confirm(page)).toBeFocused();
    });

    for (const owner of ['idle', 'confirm', 'cancel', 'outside'] as const) {
      test(`Key Health read focus preserves ${owner} through delayed keyfile ${outcome} at ${width}px`, async ({ page }) => {
        await open(page, width, 'success', true);
        await expect(posture(page)).toHaveCount(0);
        await rotate(page).focus();
        if (owner !== 'idle') {
          await page.keyboard.press('Enter');
          await expect(cancel(page)).toBeFocused();
        }
        const target = owner === 'idle' ? rotate(page) : owner === 'confirm' ? confirm(page)
          : owner === 'cancel' ? cancel(page) : outside(page);
        await target.focus();
        const current = await target.elementHandle();
        const oldCancel = owner === 'idle' ? null : await cancel(page).elementHandle();
        const oldConfirm = owner === 'idle' ? null : await confirm(page).elementHandle();
        await release(page, 'system.status', 0, outcome);
        await drain(page);
        expect(await current!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
        await expect(target).toBeFocused();
        if (owner !== 'idle') {
          await expect(panel(page)).toHaveAttribute('data-recued-key-health-panel-state', 'confirm');
          expect(await oldCancel!.evaluate(node => node.isConnected)).toBe(true);
          expect(await oldConfirm!.evaluate(node => node.isConnected)).toBe(true);
          await cancel(page).focus();
          await page.keyboard.press('Enter');
          await expect(rotate(page)).toBeFocused();
        }
        await expect(posture(page)).toHaveAttribute('data-recued-keyfile-posture-tone', outcome === 'error' ? 'unreadable' : 'unsealed');
      });
    }
  }

  for (const oldOutcome of ['sealed', 'error'] as const) {
    test(`Key Health read focus lets Retry finish before stale keyfile ${oldOutcome} at ${width}px`, async ({ page }) => {
      const before = await open(page, width, 'error', true);
      await activateRetry(page);
      await expectReadGroups(page, before);
      await release(page, 'key.health', 0, 'success');
      await expectOutcome(page, 'success');
      await expect(heading(page)).toBeFocused();
      await expect(posture(page)).toHaveCount(0);
      await release(page, 'system.status', 1, 'success');
      await expect(posture(page)).toHaveAttribute('data-recued-keyfile-posture-tone', 'unsealed');
      const current = await posture(page).elementHandle();
      await release(page, 'system.status', 0, oldOutcome);
      await drain(page);
      expect(await current!.evaluate(node => node.isConnected)).toBe(true);
      await expect(posture(page)).toHaveAttribute('data-recued-keyfile-posture-tone', 'unsealed');
      await expect(heading(page)).toBeFocused();
    });
  }

  for (const owner of ['close', 'outside'] as const) {
    test(`Key Health read focus on Close reload retains ${owner} at ${width}px`, async ({ page }) => {
      const before = await open(page, width, 'success');
      await page.evaluate(() => { window.__keyHealthReadFocus.expectedRotations = 1; });
      await rotate(page).focus();
      await page.keyboard.press('Enter');
      await confirm(page).focus();
      await page.keyboard.press('Enter');
      await expect(panel(page)).toHaveAttribute('data-recued-key-health-panel-state', 'done');
      const close = panel(page).getByRole('button', { name: 'Close', exact: true });
      const oldClose = await close.elementHandle();
      await close.focus();
      await page.keyboard.press('Enter');
      await expect(loading(page)).toBeFocused();
      if (owner === 'outside') await outside(page).focus();
      await oldClose!.evaluate(node => (node as HTMLButtonElement).click());
      await expectReadGroups(page, before);
      await release(page, 'key.health', 0, 'success');
      await expectOutcome(page, 'success');
      await expect(owner === 'close' ? rotate(page) : outside(page)).toBeFocused();
    });
  }
}
