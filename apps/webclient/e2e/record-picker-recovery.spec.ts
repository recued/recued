import { expect, test, type Page } from '@playwright/test';
import {
  GLOBAL_RUN_PALETTE_TRIGGER, HARNESS_URL, RUN_PALETTE, installFullAppHooks,
} from './helpers/full-app.js';

type Reply = { result?: unknown; error?: { code: string; message: string } };
interface PickerFixture {
  mode: 'error' | 'hold' | 'ready' | 'unsupported';
  pageReads: number;
  remoteQueries: string[];
  pending: number;
  inputs: Element[];
  release(index: number, fail?: boolean): void;
}
declare global { interface Window { __recordPickerRecovery: PickerFixture } }

installFullAppHooks();
const modal = (page: Page) => page.locator('.run-modal-overlay-root');
const picker = (page: Page) => modal(page).locator('[data-ref-picker]');
const input = (page: Page) => picker(page).locator('[data-ref-picker-input]');
const retry = (page: Page) => picker(page).getByRole('button', { name: 'Try again', exact: true });

const boot = async (page: Page, mode: PickerFixture['mode'] = 'error') => {
  await page.goto(`${HARNESS_URL}?data=records&run_prefill=1#chat`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(mode => {
    const pending: Array<{ settle(reply: Reply): void; reply: Reply; released: boolean }> = [];
    const error = { error: { code: 'timeout', message: 'Request timed out' } };
    const fixture: PickerFixture = {
      mode, pageReads: 0, remoteQueries: [], pending: 0, inputs: [],
      release(index, fail = false) {
        const item = pending[index];
        if (!item || item.released) throw new Error(`No pending search ${index}`);
        item.released = true; item.settle(fail ? error : item.reply);
      },
    };
    Object.assign(window, {
      __recordPickerRecovery: fixture,
      __connectionsFixture: async (method: string, raw: unknown): Promise<Reply | undefined> => {
        if (method !== 'records.search') return undefined;
        const args = raw as { filters?: Record<string, { op: string; value: string }> };
        const query = args.filters?.title?.value;
        if (query === undefined) {
          fixture.pageReads++;
          return { result: { records: [{ id: 'job-local', title: 'My Zebra' },
            ...Array.from({ length: 199 }, (_, index) => ({ id: `job-${index}`, title: `Job ${index}` }))] } };
        }
        fixture.remoteQueries.push(query);
        if (fixture.mode === 'unsupported') return {
          error: { code: 'records_invalid', message: "filter field 'title' is not admitted" },
        };
        if (fixture.mode === 'error') return error;
        const records = [{ id: 'job-remote', title: 'Zebra Corp' }, { id: 'job-beta', title: 'Beta Project' }]
          .filter(row => row.title.startsWith(query));
        const reply = { result: { records } };
        if (fixture.mode === 'ready') return reply;
        fixture.pending++;
        return new Promise(resolve => { pending.push({ settle: resolve, reply, released: false }); });
      },
    });
  }, mode);
  await page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`).click();
  await page.getByRole('combobox', { name: 'Recipe', exact: true }).fill('Follow up on this job');
  await page.getByRole('option', { name: /Follow up on this job/ }).click();
  await page.locator(`[${RUN_PALETTE}] [data-recued-run-palette-action]`).filter({ hasText: /^Run$/ }).click();
  await expect(input(page)).toBeVisible();
};

test('retry preserves the chosen record and other recipe inputs, then commits the recovered record only when selected', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await input(page).click();
  await picker(page).getByRole('option', { name: /My Zebra/ }).click();
  await modal(page).locator('[data-var-key="title"]').fill('Keep this draft');
  await modal(page).locator('[data-var-key="count"]').fill('9');
  await input(page).fill('Zebra');
  await expect(retry(page)).toBeVisible();
  await expect(picker(page).getByRole('option', { name: /My Zebra/ })).toBeVisible();
  await page.evaluate(() => {
    window.__recordPickerRecovery.mode = 'hold';
    window.__recordPickerRecovery.inputs = [...document.querySelectorAll('.run-modal-overlay-root input')];
  });
  await modal(page).getByRole('heading', { name: 'Follow up on this job', exact: true }).click();
  await modal(page).locator('[data-var-key="title"]').click();
  await retry(page).click();
  await expect.poll(() => page.evaluate(() => window.__recordPickerRecovery.pending)).toBe(1);
  await picker(page).locator('[data-ref-picker-retry]').evaluate(button => {
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  expect(await page.evaluate(() => window.__recordPickerRecovery.remoteQueries)).toEqual(['Zebra', 'Zebra']);
  await page.screenshot({ path: test.info().outputPath('retry-keeps-recipe-inputs.png'), fullPage: true });
  await page.evaluate(() => window.__recordPickerRecovery.release(0));
  await expect(retry(page)).toBeHidden();
  await expect(picker(page).getByRole('option', { name: /Zebra Corp/ })).toBeVisible();
  await expect(modal(page).locator('[data-var-key="job_id"]')).toHaveValue('job-local');
  await expect(modal(page).locator('[data-var-key="title"]')).toHaveValue('Keep this draft');
  await expect(modal(page).locator('[data-var-key="count"]')).toHaveValue('9');
  expect(await page.evaluate(() => window.__recordPickerRecovery.inputs
    .every(node => node.isConnected && document.querySelector('.run-modal-overlay-root')!.contains(node)))).toBe(true);
  expect(await page.evaluate(() => window.__recordPickerRecovery.pageReads)).toBe(1);
  expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(0);
  await picker(page).getByRole('option', { name: /Zebra Corp/ }).click();
  await modal(page).locator('[data-recued-run-modal-action="confirm-run"]').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-run-prefill-execute') ?? 'null')?.config))
    .toEqual({ job_id: 'job-remote', title: 'Keep this draft', count: 9 });
});

test('an empty failed search stays truthful and a late retry cannot replace a newer query', async ({ page }) => {
  await boot(page);
  await input(page).fill('Missing');
  await expect(retry(page)).toBeVisible();
  await expect(input(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(picker(page).locator('[data-ref-picker-results]')).toBeHidden();
  await expect(picker(page)).not.toContainText('No matching records.');
  await page.evaluate(() => { window.__recordPickerRecovery.mode = 'hold'; });
  await retry(page).click();
  await expect.poll(() => page.evaluate(() => window.__recordPickerRecovery.pending)).toBe(1);
  await page.evaluate(() => { window.__recordPickerRecovery.mode = 'ready'; });
  await input(page).fill('Beta');
  await expect(picker(page).getByRole('option', { name: /Beta Project/ })).toBeVisible();
  await page.evaluate(() => window.__recordPickerRecovery.release(0, true));
  await expect(input(page)).toHaveValue('Beta');
  await expect(picker(page).getByRole('option', { name: /Beta Project/ })).toBeVisible();
  await expect(picker(page).locator('[data-ref-picker-recovery]')).toBeHidden();
  await expect(picker(page).getByRole('option', { name: /Zebra Corp/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(0);
});

test('a known match stays selectable during retry and the late failure cannot replace that choice', async ({ page }) => {
  await boot(page);
  await input(page).fill('Zebra');
  await expect(retry(page)).toBeVisible();
  await page.evaluate(() => { window.__recordPickerRecovery.mode = 'hold'; });
  await retry(page).click();
  await expect.poll(() => page.evaluate(() => window.__recordPickerRecovery.pending)).toBe(1);
  const known = picker(page).getByRole('option', { name: /My Zebra/ });
  await expect(known).toBeVisible();
  await known.click();
  await page.evaluate(() => window.__recordPickerRecovery.release(0, true));
  await expect(input(page)).toHaveValue('My Zebra');
  await expect(modal(page).locator('[data-var-key="job_id"]')).toHaveValue('job-local');
  await expect(picker(page).locator('[data-ref-picker-recovery]')).toBeHidden();
  await expect(picker(page).locator('[data-ref-picker-results]')).toBeHidden();
  expect(await page.evaluate(() => window.__recordPickerRecovery.pageReads)).toBe(1);
  expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(0);
});

test('an unsupported label filter keeps local matches without offering repeated failed searches', async ({ page }) => {
  await boot(page, 'unsupported');
  await input(page).fill('Zebra');
  await expect(picker(page).getByRole('option', { name: /My Zebra/ })).toBeVisible();
  await input(page).fill('Zeb');
  await expect(input(page)).toHaveAttribute('aria-busy', 'false');
  await expect(picker(page).getByRole('option', { name: /My Zebra/ })).toBeVisible();
  await expect(picker(page).locator('[data-ref-picker-recovery]')).toBeHidden();
  await expect(picker(page)).toContainText('Recued only searched the first page.');
  expect(await page.evaluate(() => window.__recordPickerRecovery.remoteQueries)).toEqual(['Zebra']);
  expect(await page.evaluate(() => window.__recordPickerRecovery.pageReads)).toBe(1);
});
