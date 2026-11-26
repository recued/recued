import { expect, test, type Page } from '@playwright/test';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { FIXED_NOW, installFullAppHooks } from './helpers/full-app.js';
import { findRuns, moreRuns, openRunSearch, runHit, runHits, runOutcome, runTime, runQuery, runResults } from './helpers/run-search-fixture.js';

const navigation = (page: Page) => page.getByRole('navigation', { name: 'Matching run navigation', exact: true });
const next = (page: Page) => navigation(page).getByRole('button', { name: 'Next matching run', exact: true });
const previous = (page: Page) => navigation(page).getByRole('button', { name: 'Previous matching run', exact: true });
const position = (page: Page) => navigation(page).locator('[data-run-review-position]');
const older = (page: Page) => navigation(page).locator('[data-recued-logs-action="more-search-runs"]');
const back = (page: Page) => page.locator('[data-logs-search-return]').getByRole('link', { name: 'Back to search', exact: true });
const heading = (page: Page) => page.locator('[data-recued-logs-detail-heading]');
const error = (page: Page) => page.getByRole('region', { name: 'Run detail', exact: true }).getByRole('alert');
const searches = (page: Page) => page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.search').length);
declare global { interface Window { __runReviewReader?: Element } }
const review = async (page: Page) => {
  await runResults(page).getByRole('button', { name: 'Review matching runs', exact: true }).click();
  await expect(navigation(page)).toBeVisible(); await expect(navigation(page)).toHaveAttribute('aria-busy', 'false');
};
const failedRuns = async (page: Page, options: { count?: number; pageSize?: number; width?: number } = {}) => {
  await openRunSearch(page, options); await page.evaluate(() => { for (const row of window.__runSearch.rows) row.status = 'failed'; });
  await findRuns(page); await runOutcome(page).selectOption('failed'); await runTime(page).selectOption('7d');
};
let external: string[] = [];
test.beforeEach(async ({ page }) => {
  external = [];
  await page.route('**/*', route => new URL(route.request().url()).origin === HARNESS_ORIGIN ? route.continue()
    : (external.push(route.request().url()), route.abort()));
});
installFullAppHooks();
test.afterEach(async ({ page }) => {
  expect(external).toEqual([]);
  expect(await page.evaluate(() => window.__runSearch?.calls.filter(call => ['execute', 'execution.kill', 'execution.cancel', 'execution.promote', 'approval.resolve', 'chat.plan.approve', 'chat.send'].includes(call.method)) ?? [])).toEqual([]);
});

test('reviews the filtered loaded matches in order and restores the last row of a Saved View on phone Back and Forward', async ({ page }, info) => {
  await failedRuns(page, { count: 35, pageSize: 10, width: 390 });
  const tools = page.locator('[data-saved-data-views]');
  await tools.getByRole('button', { name: 'Save current view', exact: true }).click(); await tools.getByLabel('View name', { exact: true }).fill('Follow-up errors');
  await tools.getByRole('button', { name: 'Save view', exact: true }).click(); await expect(tools.locator('[data-view-notice]')).toContainText('Saved');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-saved-data-views') ?? '[]').at(-1));
  await page.evaluate(hash => window.__app.setHash(hash), '#views/' + saved.id);
  await moreRuns(page).click(); await expect(runHits(page)).toHaveCount(20);
  const ids = await runHits(page).evaluateAll(rows => rows.map(row => row.getAttribute('data-search-run-id')!)); let reads = await searches(page);
  await review(page); await expect(position(page)).toHaveText('Run 1 of 20 loaded'); await expect(previous(page)).toBeDisabled();
  await expect(navigation(page)).toContainText('follow-up'); await expect(navigation(page)).toContainText('Last 7 days');
  await expect(navigation(page)).toContainText('More history remains');
  const originalWindow = await navigation(page).textContent();
  await page.clock.setFixedTime(FIXED_NOW + 8 * 86400000);
  for (let index = 1; index < ids.length; index++) {
    await next(page).press('Enter');
    await expect(position(page)).toHaveText(`Run ${index + 1} of 20 loaded`);
    await expect(navigation(page)).toHaveAttribute('aria-busy', 'false'); await expect(page).toHaveURL(new RegExp('#logs/' + ids[index] + '$', 'u'));
    if (index === 1) await expect(heading(page)).toBeFocused();
  }
  await expect(next(page)).toBeDisabled(); await expect(previous(page)).toBeEnabled();
  expect(await navigation(page).textContent()).toEqual(originalWindow?.replace('Run 1 of 20 loaded', 'Run 20 of 20 loaded'));
  await page.screenshot({ path: info.outputPath('older-run-controls-phone.png'), animations: 'disabled' });
  const reader = page.locator('[data-recued-logs-detail]'), technical = reader.locator('[data-recued-logs-technical]');
  await technical.locator('summary').click(); await expect(technical).toHaveAttribute('open', '');
  await reader.evaluate(element => { window.__runReviewReader = element; });
  const detailReads = await page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.get').length);
  const windowText = await navigation(page).locator('p').filter({ hasText: /^Run start window:/u }).textContent();
  await older(page).press('Enter'); await expect(position(page)).toHaveText('Run 20 of 30 loaded');
  await older(page).press('Enter'); await expect(position(page)).toHaveText('Run 20 of 34 loaded');
  await expect(older(page)).toHaveCount(0); await expect(position(page)).toBeFocused();
  await expect(page).toHaveURL(new RegExp('#logs/' + ids[19] + '$', 'u'));
  expect(await reader.evaluate(element => element === window.__runReviewReader)).toBe(true);
  await expect(technical).toHaveAttribute('open', '');
  expect(await navigation(page).locator('p').filter({ hasText: /^Run start window:/u }).textContent()).toBe(windowText);
  expect(await page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.get').length)).toBe(detailReads);
  const requests = await page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.search').slice(-2).map(call => call.args as { query: string; filters: unknown }));
  for (const request of requests) expect(request).toMatchObject({ query: 'follow-up', filters: { outcome: 'failed', started_from: FIXED_NOW - 7 * 86400000, started_before: FIXED_NOW + 1 } });
  reads += 2; expect(await searches(page)).toBe(reads);
  await page.screenshot({ path: info.outputPath('matching-runs-phone.png'), animations: 'disabled' });
  await previous(page).click(); await expect(position(page)).toHaveText('Run 19 of 34 loaded');
  expect(await searches(page)).toBe(reads);
  const lastId = ids[18]!;
  const returned = async () => {
    await expect(page).toHaveURL(new RegExp('#views/' + saved.id + '$', 'u'));
    await expect(runQuery(page)).toHaveValue('follow-up'); await expect(runOutcome(page)).toHaveValue('failed'); await expect(runTime(page)).toHaveValue('7d');
    await expect(runHits(page)).toHaveCount(34); await expect(runHit(page, lastId)).toBeFocused();
    const box = await runHit(page, lastId).boundingBox(); expect(box).not.toBeNull(); expect(box!.y).toBeGreaterThanOrEqual(55); expect(box!.y + box!.height).toBeLessThanOrEqual(900);
    expect(await searches(page)).toBe(reads);
  };
  await back(page).click(); await returned();
  await page.goBack(); await expect(position(page)).toHaveText('Run 19 of 34 loaded'); await expect(back(page)).toHaveAttribute('href', '#views/' + saved.id);
  await page.goBack(); await returned();
  await page.goForward(); await expect(position(page)).toHaveText('Run 19 of 34 loaded');
});

test('retries older history at the same cursor, retains sparse continuations and rejects duplicates without losing the current run', async ({ page }) => {
  await failedRuns(page, { count: 4, pageSize: 2 }); await review(page);
  await page.evaluate(() => { window.__runSearch.failing = ['execution.search']; }); await older(page).click();
  await expect(navigation(page).getByRole('alert')).toContainText('temporarily unavailable'); await expect(older(page)).toHaveText('Retry older runs');
  await expect(position(page)).toHaveText('Run 1 of 2 loaded'); await expect(page).toHaveURL(/#logs\/run-0$/u);
  const cursor = await page.evaluate(() => (window.__runSearch.calls.filter(call => call.method === 'execution.search').at(-1)!.args as { cursor: { last_event_at: number; last_run_id: string } }).cursor);
  const gap = { last_event_at: cursor.last_event_at - 1, last_run_id: 'sparse-older' };
  await page.evaluate(boundary => { const f = window.__runSearch; f.failing = []; f.searchPages.push({ runs: [], next_cursor: boundary }); }, gap);
  await older(page).click(); await expect(navigation(page)).toContainText('No additional matches in this part of history. More history remains.');
  await expect(position(page)).toHaveText('Run 1 of 2 loaded'); await expect(older(page)).toHaveText('Search older runs');
  await page.evaluate(() => { const f = window.__runSearch; f.searchPages.push({ runs: [f.rows[0]!] }); }); await older(page).click();
  await expect(navigation(page).getByRole('alert')).toContainText('Run history changed'); await expect(older(page)).toHaveText('Retry older runs');
  await expect(position(page)).toHaveText('Run 1 of 2 loaded');
  await page.evaluate(() => { const f = window.__runSearch; f.searchPages.push({ runs: [f.rows[2]!] }); }); await older(page).press('Enter');
  await expect(position(page)).toHaveText('Run 1 of 3 loaded'); await expect(older(page)).toHaveCount(0); await expect(position(page)).toBeFocused();
  const requests = await page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.search').slice(-4).map(call => call.args as { cursor: unknown; filters: unknown }));
  expect(requests.map(request => request.cursor)).toEqual([cursor, cursor, gap, gap]);
  expect(requests.every(request => JSON.stringify(request.filters) === JSON.stringify(requests[0]!.filters))).toBe(true);
  await next(page).click(); await next(page).click(); await expect(position(page)).toHaveText('Run 3 of 3 loaded');
  await back(page).click(); await expect(runHits(page)).toHaveCount(3); await expect(runHit(page, 'run-2')).toBeFocused();
});

test('allows sibling review during an older read and retires that read before a different Search query can receive its results', async ({ page }) => {
  await failedRuns(page, { count: 6, pageSize: 2 }); await review(page);
  await page.evaluate(() => { window.__runSearch.held = ['execution.search']; }); await older(page).click();
  await expect.poll(() => page.evaluate(() => window.__runSearch.pending('execution.search'))).toBe(1);
  await expect(next(page)).toBeEnabled(); await next(page).click(); await expect(page).toHaveURL(/#logs\/run-1$/u);
  await expect(position(page)).toHaveText('Run 2 of 2 loaded');
  await back(page).click(); await expect(runHits(page)).toHaveCount(2); await expect(runHit(page, 'run-1')).toBeFocused();
  await runQuery(page).fill('Billing');
  await expect.poll(() => page.evaluate(() => window.__runSearch.pending('execution.search'))).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => { const f = window.__runSearch; f.held = []; f.release('execution.search'); });
  await expect(runHits(page)).toHaveCount(1); await expect(runHit(page, 'run-3')).toBeVisible(); await expect(runQuery(page)).toBeFocused();
  await expect(runQuery(page)).toHaveValue('Billing'); await expect(page).toHaveURL(/#data\/search$/u);
  await page.evaluate(() => window.__app.setHash('#today')); await page.evaluate(() => window.__app.setHash('#logs/run-1'));
  await expect(navigation(page)).toHaveCount(0); await expect(back(page)).toHaveCount(0);
});

test('starts at an individual match and explains missing, substituted, changed-lifetime and changed-outcome entries without substituting details', async ({ page }) => {
  await failedRuns(page, { count: 8, pageSize: 10 }); await runHit(page, 'run-0').press('Enter');
  await expect(position(page)).toHaveText('Run 1 of 7 loaded');
  await page.evaluate(() => {
    const f = window.__runSearch; f.rows = f.rows.filter(row => row.run_id !== 'run-1');
    f.substitutions['run-2'] = 'run-0'; f.rows.find(row => row.run_id === 'run-4')!.started_at--;
    f.rows.find(row => row.run_id === 'run-5')!.status = 'succeeded';
    f.rows.find(row => row.run_id === 'run-6')!.run_yield = { steps_run: 1, steps_skipped: 0, items_total: 5, items_failed: 99, stopped_at: null };
  });
  for (const [id, message] of [['run-1', /no longer available/i], ['run-2', /different run/i], ['run-4', /could not be confirmed/i], ['run-5', /no longer matches/i]] as const) {
    await next(page).click(); await expect(page).toHaveURL(new RegExp('#logs/' + id + '$', 'u')); await expect(error(page)).toContainText(message);
    await expect(next(page)).toBeEnabled(); await expect(page.locator('[data-recued-logs-run-summary]')).toHaveCount(0);
  }
  await next(page).click(); await expect(page).toHaveURL(/#logs\/run-6$/u); await expect(error(page)).toHaveCount(0);
  await expect(position(page)).toHaveText('Run 6 of 7 loaded');
  await back(page).click(); await expect(runHit(page, 'run-6')).toBeFocused(); await expect(runResults(page)).toContainText('New run activity is available');
});

test('keeps the review order and focused navigation during live repaints, fences held detail reads on Back and retires the visit on another route', async ({ page }) => {
  await failedRuns(page, { count: 6, pageSize: 10 }); await review(page);
  await next(page).focus();
  const activeReads = await page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.active').length);
  await page.evaluate(() => { const f = window.__runSearch; f.rows.unshift({ ...f.rows[0]!, run_id: 'new-unloaded' });
    window.__app.fireMessage({ type: 'server_event', event: { kind: 'execution', recipe_id: 'customer-followup', run_id: 'new-unloaded', op: 'finish', cursor: 9000 } }); });
  await expect.poll(() => page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.active').length)).toBeGreaterThan(activeReads);
  await expect(navigation(page)).toContainText('Run activity has changed');
  await expect(next(page)).toBeFocused(); await expect(position(page)).toHaveText('Run 1 of 5 loaded');
  await page.evaluate(() => { window.__runSearch.held = ['execution.get']; }); await next(page).click();
  await expect.poll(() => page.evaluate(() => window.__runSearch.pending('execution.get'))).toBeGreaterThan(0);
  await expect(next(page)).toBeDisabled(); await expect(previous(page)).toBeDisabled();
  await back(page).click(); await expect(runHit(page, 'run-1')).toBeFocused();
  await page.evaluate(() => { const f = window.__runSearch; f.held = []; f.release('execution.get'); });
  await expect(runHit(page, 'run-1')).toBeFocused(); await expect(page).toHaveURL(/#data\/search$/u);
  await runHit(page, 'run-1').press('Enter'); await expect(position(page)).toHaveText('Run 2 of 5 loaded');
  await page.evaluate(() => { window.__runSearch.held = ['execution.get']; }); await next(page).click();
  await expect.poll(() => page.evaluate(() => window.__runSearch.pending('execution.get'))).toBeGreaterThan(0);
  await page.evaluate(() => window.__app.setHash('#today'));
  await page.evaluate(() => { const f = window.__runSearch; f.held = []; f.release('execution.get'); });
  await expect(page).toHaveURL(/#today$/u);
  await page.evaluate(() => window.__app.setHash('#logs/run-2'));
  await expect(page.getByRole('heading', { name: 'Run review', exact: true })).toBeVisible();
  await expect(navigation(page)).toHaveCount(0); await expect(back(page)).toHaveCount(0);
});

test('keeps a failed detail readable and retryable within the queue, and drops Search context when opening History', async ({ page }) => {
  await failedRuns(page, { count: 6, pageSize: 10 }); await runHit(page, 'run-2').press('Enter');
  await expect(position(page)).toHaveText('Run 3 of 5 loaded');
  await page.evaluate(() => { window.__runSearch.failing = ['execution.get']; }); await next(page).click();
  await expect(error(page)).toContainText('temporarily unavailable'); await expect(previous(page)).toBeEnabled();
  await page.evaluate(() => { window.__runSearch.failing = []; });
  await page.getByRole('region', { name: 'Run detail', exact: true }).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(error(page)).toHaveCount(0); await expect(position(page)).toHaveText('Run 4 of 5 loaded');
  await page.getByRole('link', { name: 'Back to history', exact: false }).click();
  await expect(page).toHaveURL(/#logs$/u); await expect(navigation(page)).toHaveCount(0);
  await page.evaluate(() => window.__app.setHash('#logs/run-4')); await expect(back(page)).toHaveCount(0);
});
