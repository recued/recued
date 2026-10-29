import { expect, test, type Page } from '@playwright/test';
import type { MetricReadOutput } from '@recued/contracts';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';

declare global {
  interface Window {
    __statsFixture: {
      data: MetricReadOutput;
      failReads: number;
      readMessage: string;
      nextWrite: 'ok' | 'refuse' | 'lost';
      calls: Array<{ method: string; args?: unknown }>;
    };
  }
}

const stats = (page: Page) => page.locator('[data-recued-stats-route]');
const tag = (page: Page) => stats(page).locator('[data-recued-publish-tag]');
const season = (page: Page) => stats(page).locator('[data-recued-publish-season]');
const retry = (page: Page) => stats(page).getByRole('button', { name: 'Retry reading stats', exact: true });
const stop = (page: Page) => stats(page).locator('[data-recued-publish-stop-action]');
const calls = (page: Page, method: string) => page.evaluate(name => window.__statsFixture.calls.filter(call => call.method === name), method);
const drain = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
let errors: string[] = [], dialogs: string[] = [], popups: string[] = [];

test.beforeEach(({ page }) => {
  errors = []; dialogs = []; popups = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
  page.on('popup', popup => { popups.push(popup.url()); void popup.close(); });
});
test.afterEach(() => {
  expect(errors, 'uncaught browser errors').toEqual([]);
  expect(dialogs, 'browser dialogs').toEqual([]);
  expect(popups, 'popups').toEqual([]);
});

const open = async (page: Page, options: { published?: boolean; failRead?: boolean; empty?: boolean } = {}): Promise<void> => {
  await page.addInitScript(opts => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    window.__statsFixture = {
      data: { snapshot: opts.empty ? null : { computed_at: now, window: { from: now - 86_400_000, to: now }, metrics: [{
        metric_id: 'autopilot', metric_version: 1, reading: { kind: 'value', value: 0.5 }, label: 'Autopilot',
        description: 'Work that ran without you starting it.', shape: 'share', direction: 'higher', publishable: true,
      }] }, artifacts: [], milestones: [], publications: opts.published ? [{ tag: 'ops', metric_id: 'autopilot', season_id: '1', state: 'active', granted_at: now }] : [] },
      failReads: opts.failRead ? 1 : 0, readMessage: 'Stats temporarily unavailable.', nextWrite: 'ok', calls: [],
    };
    window.__connectionsFixture = async (method, raw) => {
      if (!method.startsWith('metric.')) return undefined;
      const state = window.__statsFixture;
      const args = raw as { tag: string; metric_id: string; season_id: string } | undefined;
      state.calls.push({ method, args });
      if (method === 'metric.read') {
        if (state.failReads > 0) { state.failReads--; return { error: { code: 'fixture_read_failed', message: state.readMessage } }; }
        return { result: structuredClone(state.data) };
      }
      const outcome = state.nextWrite; state.nextWrite = 'ok';
      if (outcome === 'refuse') return { error: { code: 'fixture_command_refused', message: 'The request was refused.' } };
      if (method === 'metric.publish' && args) state.data = { ...state.data, publications: [
        ...state.data.publications.filter(pub => pub.tag !== args.tag),
        { ...args, state: 'active', granted_at: now },
      ] };
      if (method === 'metric.unpublish' && args) state.data = { ...state.data, publications:
        state.data.publications.map(pub => pub.tag === args.tag ? { ...pub, state: 'withdrawing' } : pub) };
      const results = method === 'metric.submit' ? state.data.publications.map(pub => ({
        kind: pub.state === 'withdrawing' ? 'withdrawn' : 'ranked', board_id: pub.tag,
      })) : [];
      if (method === 'metric.submit') state.data = { ...state.data, publications:
        state.data.publications.filter(pub => pub.state !== 'withdrawing') };
      if (outcome === 'lost') return { error: { code: 'fixture_reply_lost', message: 'The response was lost.' } };
      if (method === 'metric.submit') return { result: { ok: true, sent: true, results } };
      return { result: { ok: true } };
    };
  }, options);
  await page.goto(`${HARNESS_ORIGIN}/full-app-harness.html#stats`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(stats(page)).toHaveAttribute('aria-busy', 'false');
};

const preview = async (page: Page): Promise<void> => {
  await tag(page).fill('my-board'); await season(page).fill('2026');
  await stats(page).getByRole('button', { name: 'Preview what would be sent', exact: true }).click();
  await expect(stats(page).locator('[data-recued-publish-confirm]')).toBeVisible();
};

test('an initial Stats read failure offers a read-only Retry', async ({ page }) => {
  await open(page, { failRead: true });
  await expect(stats(page).getByRole('alert')).toContainText('Stats temporarily unavailable.');
  await page.evaluate(() => { window.__statsFixture.failReads = 1; window.__statsFixture.readMessage = ''; });
  await retry(page).click();
  await expect(stats(page).getByRole('alert')).toContainText('Could not read your stats');
  await expect(retry(page)).toBeEnabled();
  await retry(page).focus(); await retry(page).press('Enter');
  await expect(stats(page).locator('tr[data-metric="autopilot"]')).toContainText('50%');
  await expect(stats(page).getByRole('alert')).toHaveCount(0);
  await expect(stats(page).getByRole('heading', { name: 'Stats', exact: true })).toBeFocused();
  expect((await calls(page, 'metric.read')).length).toBe(3);
  expect(await calls(page, 'metric.publish')).toEqual([]); expect(await calls(page, 'metric.unpublish')).toEqual([]);
  expect(await calls(page, 'metric.submit')).toEqual([]);
});

test('a refused publication keeps its preview and restores entered values on Cancel', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await open(page); const initialReads = (await calls(page, 'metric.read')).length;
  await preview(page);
  expect((await calls(page, 'metric.read')).length).toBe(initialReads);
  await page.evaluate(() => { window.__statsFixture.nextWrite = 'refuse'; });
  await stats(page).getByRole('button', { name: 'Publish this number', exact: true }).click();
  await expect(stats(page).getByRole('alert')).toContainText('confirm publishing');
  await expect(stats(page).locator('[data-recued-publish-payload]')).toContainText('my-board');
  await expect(stats(page).locator('[data-recued-publish-confirm-action]')).toHaveAttribute('data-season', '2026');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('stats-preview-recovery-phone.png'), fullPage: true });
  await retry(page).click(); await expect(stats(page)).toHaveAttribute('aria-busy', 'false');
  expect((await calls(page, 'metric.publish')).length).toBe(1);
  await stats(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(tag(page)).toHaveValue('my-board'); await expect(season(page)).toHaveValue('2026'); await expect(tag(page)).toBeFocused();
});

test('a lost publishing reply reconciles saved settings without another publish', async ({ page }) => {
  await open(page); await preview(page);
  await page.evaluate(() => { window.__statsFixture.nextWrite = 'lost'; });
  await stats(page).getByRole('button', { name: 'Publish this number', exact: true }).click();
  await expect(stop(page)).toHaveAttribute('data-tag', 'my-board');
  await expect(stats(page).locator('[data-recued-publish-confirm]')).toHaveCount(0);
  await expect(stats(page).getByRole('alert')).toHaveCount(0);
  await expect(stats(page)).toContainText('Publishing is enabled for #my-board.');
  expect((await calls(page, 'metric.publish')).length).toBe(1);
});

test('a confirmed stop remains visible when its follow-up read fails', async ({ page }) => {
  await open(page, { published: true }); await tag(page).fill('next-board'); await season(page).fill('2027');
  await page.evaluate(() => { window.__statsFixture.failReads = 1; });
  await stop(page).click();
  await expect(stats(page)).toContainText('Stop request saved for #ops.');
  await expect(stats(page).locator('[data-recued-stats-stale]')).toBeVisible();
  await expect(stats(page).locator('tr[data-metric="autopilot"]')).toContainText('50%');
  await expect(stop(page)).toBeDisabled(); await stop(page).dispatchEvent('click');
  await expect(tag(page)).toHaveValue('next-board'); await expect(season(page)).toHaveValue('2027');
  const review = stats(page).getByRole('button', { name: 'Preview what would be sent', exact: true });
  await expect(review).toBeDisabled(); await review.dispatchEvent('click');
  await expect(stats(page).locator('[data-recued-publish-confirm]')).toHaveCount(0);
  await retry(page).click(); await expect(stats(page).locator('[data-recued-publish-withdrawing]')).toBeVisible();
  expect((await calls(page, 'metric.unpublish')).length).toBe(1);
});

test('a refused stop shows its error and Retry does not repeat the command', async ({ page }) => {
  await open(page, { published: true });
  await page.evaluate(() => { window.__statsFixture.nextWrite = 'refuse'; });
  await stop(page).click();
  await expect(stats(page).getByRole('alert')).toContainText('confirm stopping publication');
  await retry(page).click(); await expect(stats(page)).toHaveAttribute('aria-busy', 'false');
  expect((await calls(page, 'metric.unpublish')).length).toBe(1);
  await expect(stop(page)).toBeEnabled();
  await stop(page).click(); await expect(stats(page).locator('[data-recued-publish-withdrawing]')).toBeVisible();
  expect((await calls(page, 'metric.unpublish')).length).toBe(2);
});

test('a pending stop rejects repeats while native draft editing survives completion', async ({ page }) => {
  await open(page, { published: true });
  await tag(page).pressSequentially('next-board'); await tag(page).press('ControlOrMeta+z');
  const undone = await tag(page).inputValue(); expect(undone).not.toBe('next-board');
  await tag(page).press('ControlOrMeta+Shift+z'); await expect(tag(page)).toHaveValue('next-board');
  await page.evaluate(() => window.__app.holdRpcResponses?.('metric.unpublish'));
  await stop(page).click(); await expect(stop(page)).toBeDisabled(); await stop(page).dispatchEvent('click'); await stop(page).press('Enter');
  expect((await calls(page, 'metric.unpublish')).length).toBe(1);
  await tag(page).focus(); await tag(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 7, 'backward'));
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('metric.unpublish'))).toBe(1);
  await expect(stats(page)).toHaveAttribute('aria-busy', 'false'); await expect(tag(page)).toBeFocused();
  expect(await tag(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([2, 7, 'backward']);
  await tag(page).press('ControlOrMeta+z'); await expect(tag(page)).toHaveValue(undone);
  await tag(page).press('ControlOrMeta+Shift+z'); await expect(tag(page)).toHaveValue('next-board');
  expect(await calls(page, 'metric.publish')).toEqual([]);
});

test('pending submission is single-flight and a lost result never claims nothing changed', async ({ page }) => {
  await open(page, { published: true });
  await stop(page).click();
  await expect(stats(page).locator('[data-recued-publish-withdrawing]')).toBeVisible();
  await page.evaluate(() => { window.__statsFixture.nextWrite = 'lost'; window.__app.holdRpcResponses?.('metric.submit'); });
  const send = stats(page).locator('[data-recued-submit-action]'); await send.click();
  await expect(send).toBeDisabled(); await send.dispatchEvent('click'); await send.press('Enter');
  expect((await calls(page, 'metric.submit')).length).toBe(1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('metric.submit'))).toBe(1);
  await expect(stats(page).locator('[data-recued-submit-status="send_failed"]')).toContainText('Could not confirm delivery');
  await expect(stats(page)).not.toContainText('Nothing changed');
  await expect(stats(page)).not.toContainText('withdrawal confirmed');
  await expect(stats(page)).not.toContainText('press send again');
  await expect(stats(page).locator('[data-recued-submit-action]')).toHaveCount(0);
  expect((await calls(page, 'metric.submit')).length).toBe(1);
});

test('leaving Stats during publishing does not trigger another read or reclaim focus', async ({ page }) => {
  await open(page); await preview(page);
  await page.evaluate(() => window.__app.holdRpcResponses?.('metric.publish'));
  await stats(page).getByRole('button', { name: 'Publish this number', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'metric.publish')).length).toBe(1);
  await page.evaluate(() => window.__app.setHash('#chat'));
  const input = page.locator('[data-recued-chat-route-input]'); await input.fill('Keep this question');
  const before = (await calls(page, 'metric.read')).length;
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('metric.publish'))).toBe(1); await drain(page);
  await expect(input).toBeFocused(); await expect(input).toHaveValue('Keep this question'); await expect(stats(page)).toHaveCount(0);
  expect((await calls(page, 'metric.read')).length).toBe(before);
});

test('publishing controls remain available without a measured snapshot and fit on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await open(page, { published: true, empty: true });
  await expect(stats(page)).toContainText('Nothing measured yet.'); await expect(stop(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('stats-recovery-phone.png'), fullPage: true });
  await stop(page).click(); await expect(stats(page).locator('[data-recued-publish-withdrawing]')).toBeVisible();
  expect((await calls(page, 'metric.unpublish')).length).toBe(1);
  await stats(page).locator('[data-recued-submit-action]').click();
  await expect(stats(page).getByRole('status')).toContainText('1 withdrawal confirmed');
  await expect(stats(page).locator('[data-recued-publish-withdrawing]')).toHaveCount(0);
  await expect(stats(page).locator('[data-recued-submit-action]')).toHaveCount(0);
  expect((await calls(page, 'metric.submit')).length).toBe(1);
});
