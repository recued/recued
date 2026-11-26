import { expect, test } from '@playwright/test';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { FIXED_NOW, installFullAppHooks } from './helpers/full-app.js';
import { findRuns, moreRuns, openRunSearch, refreshRuns, runHit, runHits, runNotice, runOutcome, runTime, runQuery, runResults, runType } from './helpers/run-search-fixture.js';
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

test('combines outcome and start-time filters with empty or named queries, older pages and Clear', async ({ page }) => {
  await openRunSearch(page, { count: 10, pageSize: 2 }); await runType(page).selectOption('run');
  await page.evaluate(now => {
    window.__runSearch.rows = window.__runSearch.rows.map((row, index) => ({ ...row, status: index === 2 ? 'in_doubt' : 'failed',
      started_at: now - (index === 8 ? 8 * 86400000 : (index + 1) * 1000) }));
  }, FIXED_NOW);
  await runOutcome(page).focus(); await runOutcome(page).selectOption('failed'); await expect(runOutcome(page)).toBeFocused();
  await runTime(page).focus(); await runTime(page).selectOption('7d'); await expect(runTime(page)).toBeFocused(); await expect(runHits(page)).toHaveCount(2);
  await moreRuns(page).click(); await moreRuns(page).click(); await moreRuns(page).click();
  await expect(runHits(page)).toHaveCount(8); await expect(runHit(page, 'run-8')).toHaveCount(0); await expect(runHit(page, 'run-2')).toHaveCount(0);
  const scopes = await page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.search')
    .map(call => call.args as { filters?: unknown }).filter(args => JSON.stringify(args.filters ?? {}).includes('started_from')));
  expect(scopes).toHaveLength(4); for (const request of scopes) expect(request.filters).toEqual({ outcome: 'failed', started_from: FIXED_NOW - 7 * 86400000, started_before: FIXED_NOW + 1 });
  await runQuery(page).fill('Billing'); await expect(runHit(page, 'run-3')).toBeVisible(); await expect(runHits(page)).toHaveCount(1);
  await expect(runTime(page)).toHaveValue('7d'); await expect(runOutcome(page)).toHaveValue('failed');
  await runOutcome(page).selectOption('unknown'); await expect(runHits(page)).toHaveCount(0); await expect(runResults(page)).toContainText('No recorded runs match');
  await runResults(page).getByRole('button', { name: 'Clear run filters', exact: true }).click();
  await expect(runOutcome(page)).toHaveValue('all'); await expect(runTime(page)).toHaveValue('all'); await expect(runOutcome(page)).toBeFocused();
  await expect(runQuery(page)).toHaveValue('Billing'); await expect(runHit(page, 'run-3')).toBeVisible();
});

test('filters partial results, all item failures and approval waits without changing their outcome labels', async ({ page }) => {
  await openRunSearch(page);
  await page.evaluate(() => { const f = window.__runSearch; f.rows[1] = { ...f.rows[1]!, status: 'succeeded', error_category: undefined,
    run_yield: { steps_run: 1, steps_skipped: 0, items_total: 5, items_failed: 5, stopped_at: null } };
    f.rows[2] = { ...f.rows[2]!, status: 'awaiting_approval' }; });
  await findRuns(page);
  for (const [outcome, id, label] of [['partial', 'run-0', 'Partial result'], ['refused', 'run-1', 'All items failed'], ['waiting-owner', 'run-2', 'Awaiting approval']]) {
    await runOutcome(page).selectOption(outcome!); await expect(runHits(page)).toHaveCount(1); await expect(runHit(page, id!)).toContainText(label!);
  }
});

test('retires held reads and exact checks after filter changes and refuses servers that ignore filters', async ({ page }) => {
  await openRunSearch(page); await findRuns(page);
  await page.evaluate(() => { window.__runSearch.held = ['execution.search']; }); await runOutcome(page).selectOption('failed');
  await expect.poll(() => page.evaluate(() => window.__runSearch.pending('execution.search'))).toBeGreaterThan(0);
  await runOutcome(page).selectOption('partial');
  await page.evaluate(() => { const f = window.__runSearch; f.held = []; f.release('execution.search'); }); await expect(runHits(page)).toHaveCount(1);
  await expect(runHit(page, 'run-0')).toBeVisible(); await expect(runOutcome(page)).toHaveValue('partial');
  await page.evaluate(() => { window.__runSearch.held = ['execution.get']; }); await runHit(page, 'run-0').press('Enter');
  await expect.poll(() => page.evaluate(() => window.__runSearch.pending('execution.get'))).toBeGreaterThan(0);
  await runOutcome(page).focus(); await runOutcome(page).selectOption('failed');
  await page.evaluate(() => { const f = window.__runSearch; f.held = []; f.release('execution.get'); });
  await expect(page).toHaveURL(/#data\/search$/u); await expect(runHit(page, 'run-1')).toBeVisible(); await expect(runOutcome(page)).toBeFocused();
  await page.evaluate(() => { window.__runSearch.ignoreFilters = true; }); await runTime(page).selectOption('24h');
  await expect(runResults(page)).toContainText('These run filters are unavailable'); await expect(runHits(page)).toHaveCount(0);
  await expect(runResults(page)).not.toContainText('No recorded runs match');
  await runResults(page).getByRole('button', { name: 'Clear run filters', exact: true }).click(); await expect(runHits(page)).toHaveCount(2);
});

test('saves relative filters and restores the filtered pages, focus and phone scroll from an exact run review', async ({ page }, info) => {
  await openRunSearch(page, { count: 25, pageSize: 10, width: 390 });
  await page.evaluate(() => { for (const row of window.__runSearch.rows) row.status = 'failed'; });
  await findRuns(page); await runOutcome(page).selectOption('failed'); await runTime(page).selectOption('7d');
  const tools = page.locator('[data-saved-data-views]');
  await tools.getByRole('button', { name: 'Save current view', exact: true }).click(); await tools.getByLabel('View name', { exact: true }).fill('Follow-up errors this week');
  await tools.getByRole('button', { name: 'Save view', exact: true }).click(); await expect(tools.locator('[data-view-notice]')).toContainText('Saved');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-saved-data-views') ?? '[]').at(-1));
  expect(saved.definition).toEqual({ tab: 'search', query: 'follow-up', result_type: 'run', run_filters: { outcome: 'failed', time_range: '7d' } });
  await page.evaluate(hash => window.__app.setHash(hash), '#views/' + saved.id);
  await page.clock.setFixedTime(FIXED_NOW + 1000); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(runOutcome(page)).toHaveValue('failed'); await expect(runTime(page)).toHaveValue('7d');
  await expect(runHit(page, 'run-1')).toBeVisible();
  const reopenedScope = await page.evaluate(() => (window.__runSearch.calls.find(call => call.method === 'execution.search')!.args as { filters: unknown }).filters);
  expect(reopenedScope).toEqual({ outcome: 'failed', started_from: FIXED_NOW + 1000 - 7 * 86400000, started_before: FIXED_NOW + 1001 });
  // The fixture's initial statuses are replayed on reload. There is one failed
  // run; add enough matching history to exercise a restored later page.
  await page.evaluate(() => { for (const row of window.__runSearch.rows) row.status = 'failed'; }); await refreshRuns(page).click();
  await runOutcome(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('run-search-filter-controls-phone.png'), animations: 'disabled' });
  await moreRuns(page).click(); await moreRuns(page).click(); await expect(runHits(page)).toHaveCount(24);
  const scroll = () => runHit(page, 'run-24').evaluate(element => {
    for (let node = element.parentElement; node; node = node.parentElement)
      if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node.scrollTop;
    return document.scrollingElement?.scrollTop ?? 0;
  });
  for (const browserBack of [false, true]) {
    await runHit(page, 'run-24').scrollIntoViewIfNeeded(); await runHit(page, 'run-24').focus(); const before = await scroll(); expect(before).toBeGreaterThan(0);
    const requests = await page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.search').length);
    await page.keyboard.press('Enter'); await expect(page).toHaveURL(/#logs\/run-24$/u);
    const back = page.locator('[data-logs-search-return] a'); await expect(back).toHaveAttribute('href', '#views/' + saved.id);
    if (browserBack) await page.goBack(); else await back.click();
    await expect(runOutcome(page)).toHaveValue('failed'); await expect(runTime(page)).toHaveValue('7d'); await expect(runQuery(page)).toHaveValue('follow-up');
    await expect(runHit(page, 'run-24')).toBeFocused(); await expect(runHits(page)).toHaveCount(24);
    await expect.poll(async () => Math.abs(await scroll() - before)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.search').length)).toBe(requests);
  }
  await page.screenshot({ path: info.outputPath('run-search-filters-phone.png'), animations: 'disabled' });
  await runTime(page).selectOption('30d');
  await expect(tools.getByText('Modified', { exact: true })).toBeVisible();
  await tools.getByRole('button', { name: 'Update view', exact: true }).click();
  await expect(tools.locator('[data-view-notice]')).toContainText('Updated');
  const updated = await page.evaluate(id => JSON.parse(sessionStorage.getItem('recued-test-saved-data-views') ?? '[]').find((view: { id: string }) => view.id === id), saved.id);
  expect(updated.definition.run_filters).toEqual({ outcome: 'failed', time_range: '30d' });
});

test('finds names and exact IDs in All and Runs, shows honest outcomes and excludes hidden payloads', async ({ page }) => {
  await openRunSearch(page); await runQuery(page).fill('follow-up');
  await expect(runHits(page)).toHaveCount(2); await expect(runHit(page, 'run-0')).toContainText('Partial result');
  await expect(runHit(page, 'run-0')).toContainText('2 of 5 items failed'); await expect(runHit(page, 'run-1')).toContainText(/timed out/i);
  await runType(page).selectOption('run'); await moreRuns(page).click(); await expect(runHit(page, 'run-2')).toContainText('Needs checking');
  await page.evaluate(() => { const row = window.__runSearch.rows[0]!; row.name = 'Café ﬁle <img.*>'; Object.assign(row, { output_string: 'hidden-result-needle', raw_metadata: 'hidden-config-needle' }); });
  await findRuns(page, 'CAFÉ FILE <img.*>'); await expect(runHits(page)).toHaveCount(1); await expect(runHit(page, 'run-0')).toContainText('Café ﬁle <img.*>');
  await expect(runResults(page).locator('img, input, textarea')).toHaveCount(0);
  for (const query of ['hidden-result-needle', 'hidden-config-needle', '.*unknown']) { await findRuns(page, query); await expect(runHits(page)).toHaveCount(0); }
  await findRuns(page, 'run-1'); await expect(runHits(page)).toHaveCount(1); await expect(runHit(page, 'run-1')).toBeVisible();
});

test('opens the exact run and restores all loaded pages, query, type, focus and phone scroll through both return paths', async ({ page }, info) => {
  await openRunSearch(page, { count: 25, pageSize: 10, width: 390 }); await findRuns(page);
  await moreRuns(page).click(); await moreRuns(page).click(); await expect(runHits(page)).toHaveCount(24);
  const top = () => runHit(page, 'run-24').evaluate(element => {
    for (let node = element.parentElement; node; node = node.parentElement)
      if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node.scrollTop;
    return document.scrollingElement?.scrollTop ?? 0;
  });
  for (const browserBack of [false, true]) {
    await runHit(page, 'run-24').scrollIntoViewIfNeeded(); await runHit(page, 'run-24').focus(); const before = await top(); expect(before).toBeGreaterThan(0);
    const reads = await page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.search').length);
    await page.keyboard.press('Enter'); await expect(page).toHaveURL(/#logs\/run-24$/u);
    await expect(page.getByRole('heading', { name: 'Run review', exact: true })).toBeVisible();
    const back = page.locator('[data-logs-search-return]').getByRole('link', { name: 'Back to search', exact: true }); await expect(back).toHaveAttribute('href', '#data/search');
    if (!browserBack) await page.screenshot({ path: info.outputPath('run-search-review-phone.png'), animations: 'disabled' });
    if (browserBack) await page.goBack(); else await back.click();
    await expect(runQuery(page)).toHaveValue('follow-up'); await expect(runType(page)).toHaveValue('run');
    await expect(runHit(page, 'run-24')).toBeFocused(); await expect(runHits(page)).toHaveCount(24);
    await expect.poll(async () => Math.abs(await top() - before)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.search').length)).toBe(reads);
  }
});

test('keeps sparse pages open to older history and retries a failed page at its retained cursor', async ({ page }) => {
  await openRunSearch(page, { sparse: true }); await findRuns(page);
  await expect(runHits(page)).toHaveCount(0); await expect(moreRuns(page)).toBeVisible(); await expect(runResults(page)).not.toContainText('No recorded runs match');
  await page.evaluate(() => { window.__runSearch.failing = ['execution.search']; }); await moreRuns(page).click();
  await expect(runResults(page).getByRole('alert')).toContainText('temporarily unavailable'); await expect(moreRuns(page)).toHaveText('Retry older runs');
  await page.evaluate(() => { window.__runSearch.failing = []; }); await moreRuns(page).click(); await expect(runHits(page)).toHaveCount(2);
  const requests = await page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.search').map(call => call.args));
  expect(requests[1]).toMatchObject({ cursor: { last_run_id: 'sparse-boundary' } }); expect(requests[2]).toEqual(requests[1]);
});

test('never substitutes a missing or changed run for the selected anchor', async ({ page }) => {
  await openRunSearch(page); await findRuns(page);
  await page.evaluate(() => { window.__runSearch.rows = window.__runSearch.rows.filter(row => row.run_id !== 'run-0'); });
  await runHit(page, 'run-0').press('Enter'); await expect(runNotice(page)).toContainText('no longer available'); await expect(runNotice(page)).toBeFocused();
  await expect(page).toHaveURL(/#data\/search$/u);
  await page.evaluate(() => { window.__runSearch.rows.find(row => row.run_id === 'run-1')!.started_at--; });
  await runHit(page, 'run-1').press('Enter'); await expect(runNotice(page)).toContainText('could not be confirmed');
  await expect(page).toHaveURL(/#data\/search$/u);
  await refreshRuns(page).click(); await runHit(page, 'run-1').press('Enter'); await expect(page).toHaveURL(/#logs\/run-1$/u);
});

test('retires held exact checks after whitespace edits, a different query and leaving Search', async ({ page }) => {
  await openRunSearch(page); await findRuns(page);
  for (const query of ['follow-up ', 'Billing']) {
    await page.evaluate(() => { window.__runSearch.held = ['execution.get']; });
    await runHit(page, 'run-0').press('Enter'); await expect(runNotice(page)).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.__runSearch.pending('execution.get'))).toBeGreaterThan(0);
    await runQuery(page).fill(query);
    await page.evaluate(() => { const f = window.__runSearch; f.held = []; f.release('execution.get'); });
    await expect(runQuery(page)).toBeFocused(); await expect(runQuery(page)).toHaveValue(query); await expect(page).toHaveURL(/#data\/search$/u);
    await expect(runResults(page)).toHaveAttribute('aria-busy', 'false');
    if (query === 'Billing') await expect(runHit(page, 'run-3')).toBeVisible();
  }
  await page.evaluate(() => { window.__runSearch.held = ['execution.get']; }); await runHit(page, 'run-3').press('Enter');
  await expect.poll(() => page.evaluate(() => window.__runSearch.pending('execution.get'))).toBeGreaterThan(0);
  await page.evaluate(() => window.__app.setHash('#today'));
  await page.evaluate(() => { const f = window.__runSearch; f.held = []; f.release('execution.get'); });
  await expect(page).toHaveURL(/#today$/u); await expect(runResults(page)).toHaveCount(0);
});

test('marks live activity without replacing results or taking focus, and recovers unsupported servers', async ({ page }) => {
  await openRunSearch(page, { unsupported: true }); await findRuns(page);
  await expect(runResults(page)).toContainText('unavailable on this server'); await expect(runResults(page)).not.toContainText('No recorded runs match');
  await page.evaluate(() => { window.__runSearch.unsupported = false; }); await refreshRuns(page).click(); await expect(runHits(page)).toHaveCount(2);
  const reads = await page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.search').length);
  await runQuery(page).focus(); await page.evaluate(() => { const f = window.__runSearch; f.rows.unshift({ ...f.rows[0]!, run_id: 'run-new' });
    window.__app.fireMessage({ type: 'server_event', event: { kind: 'execution', recipe_id: 'customer-followup', run_id: 'run-new', op: 'finish', cursor: 9000 } }); });
  await expect(runResults(page)).toContainText('New run activity is available'); await expect(runQuery(page)).toBeFocused(); await expect(runHit(page, 'run-0')).toBeVisible();
  expect(await page.evaluate(() => window.__runSearch.calls.filter(call => call.method === 'execution.search').length)).toBe(reads);
  await refreshRuns(page).click(); await expect(runHit(page, 'run-new')).toBeVisible();
});

test('saves Runs as a real Saved View and restores the exact view after reviewing a run', async ({ page }) => {
  await openRunSearch(page); await findRuns(page); const tools = page.locator('[data-saved-data-views]');
  await tools.getByRole('button', { name: 'Save current view', exact: true }).click(); await tools.getByLabel('View name', { exact: true }).fill('Follow-up runs');
  await tools.getByRole('button', { name: 'Save view', exact: true }).click(); await expect(tools.locator('[data-view-notice]')).toContainText('Saved');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-saved-data-views') ?? '[]').at(-1));
  expect(saved.definition).toEqual({ tab: 'search', query: 'follow-up', result_type: 'run' });
  await page.evaluate(hash => window.__app.setHash(hash), '#views/' + saved.id); await expect(runType(page)).toHaveValue('run'); await expect(runHit(page, 'run-1')).toBeVisible();
  await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); await expect(runType(page)).toHaveValue('run'); await expect(runQuery(page)).toHaveValue('follow-up');
  await runHit(page, 'run-1').press('Enter'); const back = page.locator('[data-logs-search-return] a'); await expect(back).toHaveAttribute('href', '#views/' + saved.id);
  await back.click(); await expect(runHit(page, 'run-1')).toBeFocused(); await expect(runQuery(page)).toHaveValue('follow-up');
});
