import { expect, test, type Locator, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks, DRAWER_TOGGLE, DRAWER_ACTION } from './helpers/full-app.js';
import { openChatHistory } from './helpers/chat-history.js';

declare global { interface Window {
  __assetChatCalls: Array<{ method: string; args: Record<string, unknown> }>;
  __assetRuleWrites: import('@recued/contracts').YoursCommand[];
  __occurrenceRenewals: import('@recued/contracts').YoursCommand[];
  __assetFactWrites: import('@recued/contracts').YoursCommand[];
  __navigationOpens: import('@recued/contracts').YoursCommand[];
  __assetHandoffWrites: import('@recued/contracts').YoursCommand[];
  __assetReportReading(id: string, field: string, value: number, unit: string, asOf: number): void;
  __assetSummaries: import('@recued/contracts').YoursAssetSummary[];
  __lastTimeRecovery: {
    reads: number; writes: Array<'on' | 'off'>;
    release(kind: 'read' | 'save', reply: { result?: unknown; error?: { code: string; message: string } }): void;
  };
} }
const captureAssetChatCalls = (page: Page) => page.evaluate(() => {
  window.__assetChatCalls.length = 0;
});

installFullAppHooks();

const showAssetFilters = async (route: Locator) => {
  const filters = route.locator('[data-yours-disclosure="Filters"]');
  if (!await filters.evaluate(node => (node as HTMLDetailsElement).open)) await filters.locator('summary').click();
};

const assetSection = async (route: Locator, name: 'Overview' | 'Rules' | 'Files' | 'Activity') => {
  await route.getByRole('navigation', { name: 'Asset sections', exact: true }).getByRole('link', { name, exact: true }).click();
};

test('Asset cards show task counts and authoritative due dates with estimates kept explicit', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=summaries#yours/assets`);
  const route = page.locator('[data-recued-yours]'); const renewal = route.locator('[data-yours-asset="card-renewal"]');
  await expect(renewal.getByRole('heading', { name: 'Home cover', exact: true })).toBeVisible();
  await expect(renewal).toContainText('2 open tasks'); await expect(renewal).toContainText('Overdue: Renew cover · 2026-10-16');
  const bike = route.locator('[data-yours-asset="card-estimate"]'); await expect(bike).toContainText('1 open task');
  await expect(bike).toContainText('Estimated due: Service by distance · 2026-10-22');
  await renewal.getByRole('link', { name: 'Open asset', exact: true }).click();
  await expect(route.getByRole('heading', { name: 'Home cover', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__app.rpcCallCount('work_entity.upsert'))).toBe(0);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
});

test('Asset cards name missing facts without treating a missing deadline as a clear status', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=summaries#yours/assets`);
  const card = page.locator('[data-yours-asset="card-missing"]');
  await expect(card).toContainText('1 open task'); await expect(card).toContainText('No due date known.');
  await expect(card).toContainText('Missing facts (4):');
  await expect(card.getByRole('button', { name: 'Record last serviced on for Boiler', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Record current battery reading for Boiler', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Record confirmed leak condition for Boiler', exact: true })).toBeVisible();
  await expect(card.locator('[data-yours-more-facts]>summary')).toHaveText('Show 1 more missing fact');
  await expect(card).not.toContainText('All clear');
});

test('Asset cards distinguish unconfigured inactive and unavailable sources', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=summaries#yours/assets`);
  await expect(page.locator('[data-yours-asset="card-empty"]')).toContainText('No active rules.');
  await expect(page.locator('[data-yours-asset="card-retired"]')).toContainText('Rules inactive for this asset.');
  const stale = page.locator('[data-yours-asset="card-stale"]');
  await expect(stale).toContainText('Source unavailable; these facts may be out of date.');
  await expect(stale).toContainText('Due today: Review monitor · 2026-10-17');
});

test('Asset cards refresh from server summaries without editing the asset', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=summaries#yours/assets`);
  const card = page.locator('[data-yours-asset="card-renewal"]'); await expect(card).toContainText('2 open tasks');
  await page.evaluate(() => {
    const row = window.__assetSummaries.find(row => row.asset_id === 'card-renewal')!;
    row.open_tasks = 0; row.next_due = { on: '2027-10-16', title: 'Renew cover', rule_id: 'renew', state: 'upcoming', estimated: false };
  });
  await page.locator('[data-recued-yours]').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(card).toContainText('No open tasks'); await expect(card).toContainText('Next due: Renew cover · 2027-10-16');
  await expect(card).not.toContainText('Overdue:');
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
});

test('Asset cards from an older server report unavailable summaries without inventing zero counts', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=summaries&yours_without_asset_summaries#yours/assets`);
  const summary = page.locator('[data-yours-asset-summary="card-renewal"]');
  await expect(summary).toHaveText('Summary unavailable. Open the asset for details.');
  await expect(summary).not.toContainText('No open tasks');
  const stale = page.locator('[data-yours-asset="card-stale"]');
  await expect(stale).toContainText('Source unavailable; these facts may be out of date.');
  await expect(stale).toContainText('Summary unavailable. Open the asset for details.');
});

test('Asset cards fit a narrow phone without clipping missing facts or due dates', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${HARNESS_URL}?yours=summaries#yours/assets`);
  const route = page.locator('[data-recued-yours]'); await expect(route.locator('[data-yours-asset-summary]')).toHaveCount(6);
  expect(await route.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('asset-cards-mobile.png'), fullPage: true });
  await route.locator('[data-yours-asset="card-missing"]').screenshot({ path: testInfo.outputPath('missing-fact-shortcuts-mobile.png') });
});

test.describe('Asset card dates follow the owner snapshot', () => {
  test.use({ timezoneId: 'Pacific/Honolulu' });
  test('Asset cards preserve calendar days and due status across device time zones', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2040-01-01T23:30Z'));
    await page.goto(`${HARNESS_URL}?yours=summaries#yours/assets`);
    await expect(page.locator('[data-yours-asset="card-stale"]')).toContainText('Due today: Review monitor · 2026-10-17');
    await expect(page.locator('[data-yours-asset="card-renewal"]')).toContainText('Overdue: Renew cover · 2026-10-16');
  });
});

const missingFactCards = async (page: Page, flags = '') => {
  await page.clock.setFixedTime(new Date('2026-10-17T12:00Z'));
  await page.goto(`${HARNESS_URL}?yours=summaries${flags}#yours/assets`);
  const route = page.locator('[data-recued-yours]');
  await expect(route.locator('[data-yours-asset="card-missing"]')).toContainText('Missing facts (4):');
  return route;
};

test('Asset filters select missing facts and overdue dates from the owner snapshot', async ({ page }) => {
  const route = await missingFactCards(page); const filter = route.getByLabel('Show assets', { exact: true });
  await showAssetFilters(route); await filter.selectOption('missing_facts');
  await expect(route.locator('[data-yours-asset-count]')).toHaveText('1 matching asset');
  await expect(route.locator('[data-yours-asset]')).toHaveCount(1);
  await expect(route.locator('[data-yours-asset="card-missing"]')).toContainText('Missing facts (4)');
  await showAssetFilters(route); await filter.selectOption('overdue');
  await expect(route.locator('[data-yours-asset-count]')).toHaveText('1 matching asset');
  await expect(route.locator('[data-yours-asset]')).toHaveCount(1);
  await expect(route.locator('[data-yours-asset="card-renewal"]')).toContainText('Overdue: Renew cover');
  await showAssetFilters(route); await filter.selectOption(''); await expect(route.locator('[data-yours-asset-count]')).toHaveText('6 assets');
  await expect(route.locator('[data-yours-asset]')).toHaveCount(6);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
});

for (const [filter, term] of [['missing_facts', 'Workshop / meter #'], ['overdue', 'overdue cover']] as const) {
  test(`Asset filters keep ${filter} and encoded search across pagination refresh and browser back`, async ({ page }) => {
    await page.goto(`${HARNESS_URL}?yours=summaries&yours_asset_filter_pages#yours/assets`);
    const route = page.locator('[data-recued-yours]');
    await expect(route.locator('[data-yours-asset]')).toHaveCount(50);
    await expect(route.locator('[data-yours-asset] h3').first()).toHaveText('clear cover 54');
    await showAssetFilters(route); await route.getByLabel('Show assets', { exact: true }).selectOption(filter);
    await expect(route.locator('[data-yours-asset-count]')).toHaveText('56 matching assets');
    await route.getByLabel('Find assets', { exact: true }).fill(term);
    await route.getByLabel('Find assets', { exact: true }).press('Enter');
    await expect(route.locator('[data-yours-asset-count]')).toHaveText('55 matching assets');
    const firstIds = await route.locator('[data-yours-asset]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-yours-asset')));
    expect(firstIds).toHaveLength(50);
    await route.getByRole('link', { name: 'Next', exact: true }).click();
    await expect(route.locator('[data-yours-asset]')).toHaveCount(5);
    await expect(route.locator('[data-yours-asset-count]')).toHaveText('55 matching assets');
    await expect(route.getByLabel('Show assets', { exact: true })).toHaveValue(filter);
    await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue(term);
    await expect(page).toHaveURL(new RegExp(`/filter/${filter}/search/${encodeURIComponent(term)}/page/2$`, 'u'));
    const lastIds = await route.locator('[data-yours-asset]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-yours-asset')));
    expect(new Set([...firstIds, ...lastIds]).size).toBe(55);
    await expect(route.getByRole('link', { name: 'Next', exact: true })).toHaveCount(0);
    await route.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(route.locator('[data-yours-asset]')).toHaveCount(5);
    await route.getByRole('link', { name: 'Open asset', exact: true }).first().click();
    await expect(route.getByRole('button', { name: 'Edit asset', exact: true })).toBeVisible();
    await page.goBack(); await expect(route.locator('[data-yours-asset]')).toHaveCount(5);
    await expect(route.getByLabel('Show assets', { exact: true })).toHaveValue(filter);
    await page.reload(); await expect(route.locator('[data-yours-asset]')).toHaveCount(5);
    await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue(term);
    await route.getByRole('link', { name: 'Previous', exact: true }).click();
    await expect(route.locator('[data-yours-asset]')).toHaveCount(50);
    await route.getByRole('link', { name: 'Next', exact: true }).click(); await expect(route.locator('[data-yours-asset]')).toHaveCount(5);
    await route.getByLabel('Find assets', { exact: true }).fill('absent');
    await route.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(route.locator('[data-yours-asset-count]')).toHaveText('0 matching assets');
    await expect(route.getByText('No assets match these filters.', { exact: true })).toBeVisible();
    await expect(route.getByRole('link', { name: 'Previous', exact: true })).toHaveCount(0);
  });
}

for (const [sphere, term] of [['personal', 'overdue cover'], ['professional', 'Workshop / meter #'], ['unsorted', 'clear cover']] as const) {
  test(`Asset sphere filters find all ${sphere} matches across pages and preserve the choice through navigation`, async ({ page }) => {
    await page.goto(`${HARNESS_URL}?yours=summaries&yours_asset_filter_pages&yours_asset_spheres#yours/assets`);
    const route = page.locator('[data-recued-yours]');
    await expect(route.locator('[data-yours-asset-count]')).toHaveText('171 assets');
    await expect(route.locator('[data-yours-asset] h3').first()).toHaveText('clear cover 54');
    await route.getByLabel('Find assets', { exact: true }).fill(term);
    await showAssetFilters(route); await route.getByLabel('Asset sphere', { exact: true }).selectOption(sphere);
    await expect(route.locator('[data-yours-asset-count]')).toHaveText('55 matching assets');
    await expect(route.locator('[data-yours-asset]')).toHaveCount(50);
    const firstIds = await route.locator('[data-yours-asset]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-yours-asset')));
    await route.getByRole('link', { name: 'Next', exact: true }).click();
    await expect(route.locator('[data-yours-asset]')).toHaveCount(5);
    await expect(route.locator('[data-yours-asset-count]')).toHaveText('55 matching assets');
    await expect(page).toHaveURL(new RegExp(`/sphere/${sphere}/search/${encodeURIComponent(term)}/page/2$`, 'u'));
    const lastIds = await route.locator('[data-yours-asset]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-yours-asset')));
    expect(new Set([...firstIds, ...lastIds]).size).toBe(55);
    await expect(route.getByRole('link', { name: 'Next', exact: true })).toHaveCount(0);
    await route.getByRole('button', { name: 'Refresh', exact: true }).click();
    await route.getByRole('link', { name: 'Open asset', exact: true }).first().click();
    await expect(route.getByRole('button', { name: 'Edit asset', exact: true })).toBeVisible();
    await page.goBack(); await expect(route.locator('[data-yours-asset]')).toHaveCount(5);
    await expect(route.getByLabel('Asset sphere', { exact: true })).toHaveValue(sphere);
    await page.reload(); await expect(route.locator('[data-yours-asset]')).toHaveCount(5);
    await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue(term);
    await route.getByRole('link', { name: 'Previous', exact: true }).click();
    await expect(route.locator('[data-yours-asset]')).toHaveCount(50);
    await showAssetFilters(route); await route.getByLabel('Asset sphere', { exact: true }).selectOption('');
    await expect(page).toHaveURL(new RegExp(`#yours/assets/search/${encodeURIComponent(term)}$`, 'u'));
    await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue(term);
  });
}

test('Asset sphere filters compose with attention and search and reset the page when either changes', async ({ page }) => {
  const term = 'Workshop / meter #';
  await page.goto(`${HARNESS_URL}?yours=summaries&yours_asset_filter_pages&yours_asset_spheres#yours/assets/filter/missing_facts/sphere/professional/search/${encodeURIComponent(term)}/page/2`);
  const route = page.locator('[data-recued-yours]');
  await expect(route.locator('[data-yours-asset]')).toHaveCount(5);
  await route.getByRole('link', { name: 'Remove attention filter', exact: true }).click();
  await expect(route.getByLabel('Show assets', { exact: true })).toHaveValue('');
  await expect(route.getByLabel('Asset sphere', { exact: true })).toHaveValue('professional');
  await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue(term);
  await expect(route.locator('[data-yours-asset]')).toHaveCount(50);
  await showAssetFilters(route); await route.getByLabel('Show assets', { exact: true }).selectOption('overdue');
  await expect(route.locator('[data-yours-asset-count]')).toHaveText('0 matching assets');
  await route.getByLabel('Find assets', { exact: true }).fill('overdue cover');
  await showAssetFilters(route); await route.getByLabel('Asset sphere', { exact: true }).selectOption('personal');
  await expect(route.locator('[data-yours-asset-count]')).toHaveText('55 matching assets');
  await expect(route.getByLabel('Show assets', { exact: true })).toHaveValue('overdue');
  await route.getByRole('link', { name: 'Next', exact: true }).click();
  await expect(route.locator('[data-yours-asset]')).toHaveCount(5);
  await showAssetFilters(route); await route.getByLabel('Asset sphere', { exact: true }).selectOption('professional');
  await expect(route.locator('[data-yours-asset-count]')).toHaveText('0 matching assets');
  await expect(route.getByText('No assets match these filters.', { exact: true })).toBeVisible();
  await expect(route.getByRole('link', { name: 'Previous', exact: true })).toHaveCount(0);
  await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue('overdue cover');
  await expect(page).toHaveURL(/\/filter\/overdue\/sphere\/professional\/search\/overdue%20cover$/u);
});

test('Asset sphere filters refresh membership after a placement change and replace an empty last page', async ({ page }) => {
  const term = 'Workshop / meter #';
  await page.goto(`${HARNESS_URL}?yours=summaries&yours_asset_filter_pages&yours_asset_filter_last_page&yours_asset_spheres#settings`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(hash => { location.hash = hash; }, `#yours/assets/filter/missing_facts/sphere/professional/search/${encodeURIComponent(term)}/page/2`);
  const route = page.locator('[data-recued-yours]');
  await expect(route.locator('[data-yours-asset-count]')).toHaveText('51 matching assets');
  await expect(route.locator('[data-yours-asset]')).toHaveCount(1);
  const chip = route.locator('[data-yours-asset] [data-yours-sphere]'); await chip.locator('summary').click();
  await chip.getByLabel('This record’s sphere', { exact: true }).selectOption('personal');
  await chip.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(route.locator('[data-yours-asset-count]')).toHaveText('50 matching assets');
  await expect(route.locator('[data-yours-asset]')).toHaveCount(50);
  await expect(route.getByLabel('Asset sphere', { exact: true })).toHaveValue('professional');
  await expect(route.getByLabel('Show assets', { exact: true })).toHaveValue('missing_facts');
  await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue(term);
  await expect(route.getByRole('link', { name: 'Previous', exact: true })).toHaveCount(0);
  await expect(route.getByRole('link', { name: 'Next', exact: true })).toHaveCount(0);
  await page.goBack(); await expect(page).toHaveURL(/#settings$/u);
  await expect(route).toHaveCount(0);
});

for (const filter of ['', 'missing_facts'] as const) {
  test(`Asset sphere filters require server acknowledgement with ${filter || 'all assets'}`, async ({ page }) => {
    await page.goto(`${HARNESS_URL}?yours=summaries&yours_asset_filter_pages&yours_asset_spheres&yours_without_asset_sphere#yours/assets${filter ? `/filter/${filter}` : ''}/sphere/professional/page/2`);
    const route = page.locator('[data-recued-yours]');
    await expect(route.getByText('Asset sphere filters are unavailable on this server. Choose All spheres to view your assets.', { exact: true })).toBeVisible();
    await expect(route.locator('[data-yours-asset]')).toHaveCount(0);
    await expect(route.locator('[data-yours-asset-count]')).toHaveCount(0);
    await expect(route.getByRole('navigation', { name: 'Pages', exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/\/sphere\/professional\/page\/2$/u);
    await showAssetFilters(route); await route.getByLabel('Asset sphere', { exact: true }).selectOption('');
    await expect(route.getByLabel('Show assets', { exact: true })).toHaveValue(filter);
    await expect(route.locator('[data-yours-asset]')).toHaveCount(50);
    await expect(route.locator('[data-yours-asset-count]')).toHaveText(filter ? '56 matching assets' : '171 assets');
    await expect(route.getByRole('link', { name: 'Previous', exact: true })).toHaveCount(0);
  });
}

test('Asset filters keep a failed missing fact draft and remove a resolved last match after retry', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=summaries&yours_asset_filter_pages&yours_fail_once#yours/assets/filter/missing_facts/search/${encodeURIComponent('Workshop / meter #00')}`);
  const route = page.locator('[data-recued-yours]'); await expect(route.locator('[data-yours-asset-count]')).toHaveText('1 matching asset');
  await route.getByRole('button', { name: 'Record inspected on for Workshop / meter #00', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); const date = form.getByLabel('Inspected on', { exact: true }); await date.fill('2026-10-17');
  await form.getByRole('button', { name: 'Save date', exact: true }).click();
  await expect(route.locator('[role=alert]')).not.toBeEmpty(); await expect(date).toHaveValue('2026-10-17');
  await form.getByRole('button', { name: 'Save date', exact: true }).click(); await expect(form).toHaveCount(0);
  await expect(route.getByLabel('Show assets', { exact: true })).toHaveValue('missing_facts');
  await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue('Workshop / meter #00');
  await expect(route.locator('[data-yours-asset-count]')).toHaveText('0 matching assets');
  await expect(route.locator('[data-yours-asset]')).toHaveCount(0);
  await expect(route.locator('[data-yours-heading]')).toBeFocused();
});

test('Asset filters return to the preceding page when saving its last missing fact empties the last page', async ({ page }) => {
  const term = 'Workshop / meter #';
  await page.goto(`${HARNESS_URL}?yours=summaries&yours_asset_filter_pages&yours_asset_filter_last_page&yours_asset_spheres#settings`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(hash => { location.hash = hash; }, `#yours/assets/filter/missing_facts/sphere/professional/search/${encodeURIComponent(term)}/page/2`);
  const route = page.locator('[data-recued-yours]'); await expect(route.locator('[data-yours-asset-count]')).toHaveText('51 matching assets');
  await expect(route.locator('[data-yours-asset]')).toHaveCount(1);
  await route.getByRole('button', { name: 'Record inspected on for Workshop / meter #00', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('Inspected on', { exact: true }).fill('2026-10-17');
  await form.getByRole('button', { name: 'Save date', exact: true }).click();
  await expect(route.locator('[data-yours-asset-count]')).toHaveText('50 matching assets');
  await expect(route.locator('[data-yours-asset]')).toHaveCount(50);
  await expect(route.getByRole('link', { name: 'Previous', exact: true })).toHaveCount(0);
  await expect(route.getByRole('link', { name: 'Next', exact: true })).toHaveCount(0);
  await expect(route.getByLabel('Show assets', { exact: true })).toHaveValue('missing_facts');
  await expect(route.getByLabel('Asset sphere', { exact: true })).toHaveValue('professional');
  await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue(term);
  await page.goBack(); await expect(page).toHaveURL(/#settings$/u);
  await expect(route).toHaveCount(0);
});

test('Asset filters replace an out-of-range page without trapping browser Back', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=summaries#settings`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => { location.hash = '#yours/assets/filter/missing_facts/page/99'; });
  const route = page.locator('[data-recued-yours]');
  await expect(route.locator('[data-yours-asset-count]')).toHaveText('1 matching asset');
  await expect(page).toHaveURL(/#yours\/assets\/filter\/missing_facts$/u);
  await page.goBack(); await expect(page).toHaveURL(/#settings$/u);
  await expect(route).toHaveCount(0);
});

test('Asset filters clear an earlier read error only after a successful retry', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=summaries&yours_asset_search_fail_once#yours/assets/filter/missing_facts/search/Boiler`);
  const route = page.locator('[data-recued-yours]');
  await expect(route.locator('[role=alert]')).toHaveText('Asset search unavailable. Try again.');
  await route.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(route.locator('[data-yours-asset-count]')).toHaveText('1 matching asset');
  await expect(route.locator('[role=alert]')).toBeEmpty();
  await expect(route.getByLabel('Show assets', { exact: true })).toHaveValue('missing_facts');
  await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue('Boiler');
});

for (const method of ['yours.read', 'contact.list'] as const) {
  test(`Asset filters preserve a search draft when a pending ${method} finishes`, async ({ page }) => {
    const route = await missingFactCards(page);
    await showAssetFilters(route); await route.getByLabel('Show assets', { exact: true }).selectOption('missing_facts');
    await expect(route.locator('[data-yours-asset-count]')).toHaveText('1 matching asset');
    await page.evaluate(rpc => window.__app.holdRpcResponses?.(rpc), method);
    const before = await page.evaluate(rpc => window.__app.rpcCallCount(rpc), method);
    await route.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => page.evaluate(rpc => window.__app.rpcCallCount(rpc), method)).toBe(before + 1);
    const query = route.getByLabel('Find assets', { exact: true }); await query.fill('Boiler'); await query.focus();
    expect(await page.evaluate(rpc => window.__app.releaseRpcResponses?.(rpc), method)).toBe(1);
    await expect(route).toHaveAttribute('aria-busy', 'false');
    await expect(query).toHaveValue('Boiler'); await expect(query).toBeFocused();
    await expect(route.getByText('Updates are available.', { exact: false })).toBeVisible();
    await route.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(/#yours\/assets\/filter\/missing_facts\/search\/Boiler$/u);
    await expect.poll(() => page.evaluate(rpc => window.__app.rpcCallCount(rpc), method)).toBe(before + 2);
    expect(await page.evaluate(rpc => window.__app.releaseRpcResponses?.(rpc), method)).toBe(1);
    await expect(route.locator('[data-yours-asset-count]')).toHaveText('1 matching asset');
    await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue('Boiler');
    expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
  });
}

test('Asset filters report assets that could not be checked and keep all assets reachable', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=summaries&yours_asset_filter_unavailable#yours/assets/filter/overdue`);
  const route = page.locator('[data-recued-yours]'); await expect(route.locator('[data-yours-asset-count]')).toHaveText('1 matching asset');
  await expect(route.getByText('1 asset could not be checked. Choose All assets to review it.', { exact: true })).toBeVisible();
  await route.getByRole('link', { name: 'Remove attention filter', exact: true }).click();
  await expect(route.locator('[data-yours-asset]')).toHaveCount(6);
});

test('Asset filters never present an older server unfiltered page as filtered results', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=summaries&yours_without_asset_filters#yours/assets/filter/missing_facts/search/Boiler`);
  const route = page.locator('[data-recued-yours]');
  await expect(route.getByText('Asset filters are unavailable on this server. Choose All assets to view your assets.', { exact: true })).toBeVisible();
  await expect(route.locator('[data-yours-asset]')).toHaveCount(0); await expect(route.locator('[data-yours-asset-count]')).toHaveCount(0);
  await route.getByRole('link', { name: 'Remove attention filter', exact: true }).click();
  await expect(route.locator('[data-yours-asset]')).toHaveCount(1);
  await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue('Boiler');
});

test.describe('Missing fact shortcuts preserve date-only input', () => {
  test.use({ timezoneId: 'Pacific/Honolulu' });
  test('Missing fact shortcuts save only the chosen date and return to the filtered page', async ({ page }) => {
    const route = await missingFactCards(page);
    await route.getByLabel('Find assets', { exact: true }).fill('Boiler');
    await route.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(route.locator('[data-yours-asset]')).toHaveCount(1);
    await route.getByRole('button', { name: 'Record last serviced on for Boiler', exact: true }).click();
    const form = route.locator('[data-yours-editor]'); const date = form.getByLabel('Last serviced on', { exact: true });
    await expect(form.getByRole('heading', { name: 'Record a date for Boiler', exact: true })).toBeVisible();
    await expect(date).toHaveValue(''); await expect(date).toBeFocused();
    await expect(form.locator('input')).toHaveCount(1);
    const save = form.getByRole('button', { name: 'Save date', exact: true }); await save.click();
    expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
    await date.fill('2026-10-01'); await save.click(); await expect(form).toHaveCount(0);
    expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([
      { action: 'asset.update', id: 'card-missing', patch: { dates: { last_serviced_on: '2026-10-01' } } },
    ]);
    await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue('Boiler');
    await expect(route.locator('[data-yours-asset]')).toHaveCount(1);
    await expect(route.locator('[data-yours-asset="card-missing"]')).toContainText('Missing facts (3):');
    await expect(route.getByRole('link', { name: 'Open asset', exact: true })).toBeFocused();
    await expect(page).toHaveURL(/#yours\/assets\/search\/Boiler$/u);
  });
});

test('Missing fact shortcuts preselect the reading and leave the actual value blank', async ({ page }) => {
  const route = await missingFactCards(page);
  await route.getByRole('button', { name: 'Record current battery reading for Boiler', exact: true }).click();
  const form = route.locator('[data-yours-editor]');
  await expect(form).toContainText('For Boiler');
  await expect(form.getByLabel('Reading', { exact: true })).toHaveValue('battery');
  await expect(form.getByLabel('Value', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Value', { exact: true })).toBeFocused();
  await expect(form.getByLabel('Unit', { exact: true })).toHaveValue('%');
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
  await form.getByLabel('Value', { exact: true }).fill('0');
  await form.getByRole('button', { name: 'Save reading', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([
    { action: 'asset.update', id: 'card-missing', patch: { readings: { battery: { value: 0, unit: '%', as_of: Date.parse('2026-10-17T12:00Z'), evidence: [] } } } },
  ]);
  const card = route.locator('[data-yours-asset="card-missing"]'); await expect(card).toContainText('Missing facts (3):');
  await expect(card.getByRole('button', { name: /battery reading/u })).toHaveCount(0);
});

test('Missing fact shortcuts require an explicit condition and preserve unknown versus clear', async ({ page }) => {
  const route = await missingFactCards(page);
  await route.getByRole('button', { name: 'Record confirmed leak condition for Boiler', exact: true }).click();
  const form = route.locator('[data-yours-editor]');
  await expect(form).toContainText('For Boiler'); await expect(form.getByLabel('Condition', { exact: true })).toHaveValue('leak');
  const state = form.getByLabel('What you observed', { exact: true }); await expect(state).toHaveValue(''); await expect(state).toBeFocused();
  await form.getByRole('button', { name: 'Save condition', exact: true }).click();
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
  await state.selectOption('clear'); await form.getByRole('button', { name: 'Save condition', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([
    { action: 'asset.update', id: 'card-missing', patch: { observations: { leak: { active: false, certainty: 'confirmed', as_of: Date.parse('2026-10-17T12:00Z'), evidence: [], source: 'owner' } } } },
  ]);
  await expect(route.locator('[data-yours-asset="card-missing"]')).toContainText('Missing facts (3):');
});

test('Missing fact shortcuts expose additional fields and return keyboard focus after cancelling a draft', async ({ page }) => {
  const route = await missingFactCards(page); const card = route.locator('[data-yours-asset="card-missing"]');
  const more = card.locator('[data-yours-more-facts]'); await more.locator('summary').click();
  const shortcut = card.getByRole('button', { name: 'Record inspected on for Boiler', exact: true }); await shortcut.click();
  const form = route.locator('[data-yours-editor]'); const date = form.getByLabel('Inspected on', { exact: true });
  await expect(date).toBeFocused(); await date.fill('2026-10-02');
  page.once('dialog', dialog => dialog.dismiss()); await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(date).toHaveValue('2026-10-02');
  page.once('dialog', dialog => dialog.accept()); await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form).toHaveCount(0); await expect(shortcut).toBeVisible(); await expect(shortcut).toBeFocused();
  await expect(more).toHaveAttribute('open', '');
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
});

test('Missing fact shortcuts keep the date draft and retry the same field after a failed save', async ({ page }) => {
  const route = await missingFactCards(page, '&yours_fail_once');
  await route.getByRole('button', { name: 'Record last serviced on for Boiler', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); const date = form.getByLabel('Last serviced on', { exact: true }); await date.fill('2026-10-01');
  const save = form.getByRole('button', { name: 'Save date', exact: true }); await save.focus(); await page.keyboard.press('Enter');
  await expect(route.getByRole('alert')).toContainText('unavailable'); await expect(save).toBeFocused(); await expect(date).toHaveValue('2026-10-01');
  await page.keyboard.press('Enter'); await expect(form).toHaveCount(0);
  const writes = await page.evaluate(() => window.__assetFactWrites); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  await expect(route.locator('[data-yours-asset="card-missing"]').getByRole('link', { name: 'Open asset', exact: true })).toBeFocused();
});

test('Missing fact shortcuts leave unavailable inactive and removed fields read-only', async ({ page }) => {
  const route = await missingFactCards(page);
  await page.evaluate(() => {
    for (const id of ['card-stale', 'card-retired']) window.__assetSummaries.find(row => row.asset_id === id)!.missing = [{ path: 'dates.reviewed_on', reason: 'unknown' }];
    window.__assetSummaries.find(row => row.asset_id === 'card-missing')!.missing.push({ path: 'dates.removed_on', reason: 'unknown' });
  });
  await route.getByRole('button', { name: 'Refresh', exact: true }).click();
  for (const id of ['card-stale', 'card-retired']) {
    const card = route.locator(`[data-yours-asset="${id}"]`);
    await expect(card).toContainText('Reviewed on'); await expect(card.getByRole('button', { name: /Record reviewed on/u })).toHaveCount(0);
  }
  const card = route.locator('[data-yours-asset="card-missing"]'); await card.locator('[data-yours-more-facts]>summary').click();
  await expect(card).toContainText('Removed on'); await expect(card.getByRole('button', { name: /Record removed on/u })).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
});

for (const [kind, method] of [['date', 'yours.read'], ['reading', 'yours.read'], ['condition', 'yours.read'], ['date', 'contact.list']] as const) {
  test(`Missing fact shortcuts preserve a ${kind} draft when an older list refresh finishes${method === 'contact.list' ? ' after reading contacts' : ''}`, async ({ page }) => {
    const route = await missingFactCards(page);
    await page.evaluate(rpc => window.__app.holdRpcResponses?.(rpc), method);
    const before = await page.evaluate(rpc => window.__app.rpcCallCount(rpc), method);
    await route.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => page.evaluate(rpc => window.__app.rpcCallCount(rpc), method)).toBe(before + 1);
    const action = kind === 'date' ? 'Record last serviced on for Boiler' : kind === 'reading' ? 'Record current battery reading for Boiler' : 'Record confirmed leak condition for Boiler';
    await route.getByRole('button', { name: action, exact: true }).click();
    const form = route.locator('[data-yours-editor]');
    const input = form.getByLabel(kind === 'date' ? 'Last serviced on' : kind === 'reading' ? 'Value' : 'What you observed', { exact: true });
    const draft = kind === 'date' ? '2026-10-01' : kind === 'reading' ? '15' : 'present';
    if (kind === 'condition') await input.selectOption(draft); else await input.fill(draft);
    await input.focus();
    expect(await page.evaluate(rpc => window.__app.releaseRpcResponses?.(rpc), method)).toBe(1);
    await expect(route).toHaveAttribute('aria-busy', 'false');
    await expect(input).toHaveValue(draft); await expect(input).toBeFocused();
    expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
    page.once('dialog', dialog => dialog.accept()); await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(form).toHaveCount(0); await expect(route.getByRole('button', { name: action, exact: true })).toBeFocused();
  });
}

const manualOdometer = async (page: Page, flags = '') => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields${flags}#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]');
  await route.locator('[data-yours-reading="odometer"]').getByRole('button', { name: 'Update reading', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('Value', { exact: true }).fill('9500');
  await form.getByLabel('Observed at', { exact: true }).fill('2026-10-17T12:00');
  await form.getByRole('button', { name: 'Save reading', exact: true }).click(); await expect(form).toHaveCount(0);
  return route;
};

test('Automatic updates keep the manual reading until an authoritative fresh snapshot arrives and preserve its history', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const route = await manualOdometer(page, '&yours_handoff_writer');
  const card = route.locator('[data-yours-reading="odometer"]'); await expect(card).toContainText('Recorded by you');
  await expect(route.locator('[data-yours-reading="pressure"]').getByRole('button', { name: 'Allow automatic updates', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'Allow automatic updates', exact: true }).click();
  await expect(card).toContainText('Automatic updates allowed.'); await expect(card).toContainText('9500 km');
  await expect(card.getByText('No writer is ready', { exact: false })).toHaveCount(0);
  expect(await route.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => window.__assetHandoffWrites)).toMatchObject([{ action: 'asset.automatic_updates', id: 'passport', path: 'readings.odometer',
    expected: { value: { value: 9500, unit: 'km', evidence: [] }, source: { kind: 'owner', revision: expect.any(String) } } }]);
  await expect(route.locator('[data-yours-handoff]')).toContainText('Previous manual entry: 9500 km');
  await route.getByRole('link', { name: 'Assets', exact: true }).click();
  await route.getByRole('link', { name: 'Open asset', exact: true }).click(); await expect(card).toContainText('Automatic updates allowed.');
  await page.evaluate(() => window.__assetReportReading('passport', 'odometer', 9600, 'km', Date.now()));
  await route.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(card).toContainText('9600 km'); await expect(card).toContainText('Asset monitor');
  await expect(card.getByRole('button', { name: 'Allow automatic updates', exact: true })).toHaveCount(0);
  await expect(route.locator('[data-yours-handoff]')).toContainText('Previous manual entry: 9500 km');
});

test('Automatic updates for a condition can be reclaimed by a new manual entry while retaining the old receipt', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); const card = route.locator('[data-yours-condition="damage"]');
  await card.getByRole('button', { name: 'Update condition', exact: true }).click(); const form = route.locator('[data-yours-editor]');
  await form.getByLabel('What you observed', { exact: true }).selectOption('possible');
  await form.getByRole('button', { name: 'Save condition', exact: true }).click(); await expect(form).toHaveCount(0);
  await card.getByRole('button', { name: 'Allow automatic updates', exact: true }).click(); await expect(card).toContainText('Automatic updates allowed.');
  await expect(card).toContainText('No writer is ready for this field.');
  await card.getByRole('button', { name: 'Update condition', exact: true }).click();
  await form.getByLabel('What you observed', { exact: true }).selectOption('clear');
  await form.getByRole('button', { name: 'Save condition', exact: true }).click(); await expect(form).toHaveCount(0);
  await expect(card).toContainText('Clear · confirmed · Recorded by you');
  await expect(card.getByRole('button', { name: 'Allow automatic updates', exact: true })).toBeVisible();
  await expect(card).not.toContainText('Automatic updates allowed.');
  await expect(route.locator('[data-yours-handoff]')).toContainText('Previous manual entry: Present · conditional');
});

test('Automatic updates preserve the retry target and keyboard focus after a failed handoff', async ({ page }) => {
  const route = await manualOdometer(page, '&yours_handoff_fail_once');
  const card = route.locator('[data-yours-reading="odometer"]'); const allow = card.getByRole('button', { name: 'Allow automatic updates', exact: true });
  await allow.focus(); await page.keyboard.press('Enter');
  await expect(route.getByRole('alert')).toContainText('unavailable'); await expect(allow).toBeFocused();
  await expect(card).toContainText('9500 km'); await expect(route.locator('[data-yours-handoff]')).toHaveCount(0);
  await page.keyboard.press('Enter'); await expect(card).toContainText('Automatic updates allowed.');
  const writes = await page.evaluate(() => window.__assetHandoffWrites); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  await expect(route.locator('[data-yours-handoff]')).toHaveCount(1);
});

test('Automatic updates require a refresh when another owner changes the manual fact', async ({ page }) => {
  const route = await manualOdometer(page, '&yours_handoff_stale'); const card = route.locator('[data-yours-reading="odometer"]');
  await card.getByRole('button', { name: 'Allow automatic updates', exact: true }).click();
  await expect(route.getByRole('alert')).toHaveText('This field changed. Refresh the asset before allowing automatic updates.');
  await expect(route.locator('[data-yours-handoff]')).toHaveCount(0);
  await route.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(card).toContainText('9800 km');
  await card.getByRole('button', { name: 'Allow automatic updates', exact: true }).click(); await expect(card).toContainText('Automatic updates allowed.');
  await expect(route.locator('[data-yours-handoff]')).toContainText('Previous manual entry: 9800 km');
  expect(await page.evaluate(() => window.__assetHandoffWrites)).toMatchObject([
    { expected: { value: { value: 9500 } } }, { expected: { value: { value: 9800 } } },
  ]);
});

test('Automatic updates can release a manually cleared unknown without presenting it as zero', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields&yours_handoff_unknown#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); const card = route.locator('[data-yours-reading="battery"]');
  await expect(card).toContainText('Unknown'); await expect(card).toContainText('Recorded by you');
  await card.getByRole('button', { name: 'Allow automatic updates', exact: true }).click(); await expect(card).toContainText('Automatic updates allowed.');
  await expect(card).toContainText('Unknown'); await expect(route.locator('[data-yours-handoff]')).toContainText('Previous manual entry: Unknown');
  expect(await page.evaluate(() => window.__assetHandoffWrites)).toMatchObject([{ path: 'readings.battery', expected: { value: null } }]);
});

test('An open task proof can close names the +done address to forward the proof to', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_proof=1#yours/asset/passport`);
  await expect(page.locator('[data-yours-proof-addresses]')).toHaveText('To close one with proof, forward the email that shows it was done '
    + 'to ana+done@example.test from that same mailbox, then accept the proposal it makes here.');
  // A server that names no address says nothing about it.
  await page.goto(`${HARNESS_URL}?yours=demo#yours/asset/passport`);
  await expect(page.getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible();
  await expect(page.locator('[data-yours-proof-addresses]')).toHaveCount(0);
});

test('Manual reading requires an actual value and changes only the selected fact', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Record reading', exact: true }).click();
  const form = route.locator('[data-yours-editor]');
  await expect(form.getByLabel('Reading', { exact: true })).toBeFocused();
  await expect(form.getByLabel('Reading', { exact: true }).locator('option:checked')).toHaveText('Odometer');
  await expect(form.getByLabel('Value', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Unit', { exact: true })).toHaveValue('km');
  await expect(form.getByLabel('Unit', { exact: true })).toHaveJSProperty('readOnly', true);
  await expect(form.locator('[data-yours-observation-previous]')).toContainText('Last recorded: 9000 km');
  await expect(form.getByText('Your entry takes priority over automatic updates to this field.', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Save reading', exact: true }).click();
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
  await form.getByLabel('Value', { exact: true }).fill('0');
  await form.getByLabel('Observed at', { exact: true }).fill('2026-10-17T12:00');
  expect(await route.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const asOf = await page.evaluate(() => new Date('2026-10-17T12:00').getTime());
  await form.getByRole('button', { name: 'Save reading', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([{ action: 'asset.update', id: 'passport',
    patch: { readings: { odometer: { value: 0, unit: 'km', as_of: asOf, evidence: [] } } } }]);
  await expect(route.locator('[data-yours-reading="pressure"]')).toContainText('2 bar');
  await expect(route.locator('[data-yours-reading="battery"]')).toContainText('Unknown');
  expect(await page.evaluate(() => window.__app.rpcCallCount('work_entity.upsert'))).toBe(0);
});

test('Observation drafts keep values units and times separate for each reading', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]');
  await route.locator('[data-yours-reading="battery"]').getByRole('button', { name: 'Update reading', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); const picker = form.getByLabel('Reading', { exact: true });
  await expect(picker).toHaveValue('battery'); await expect(form.getByLabel('Unit', { exact: true })).toHaveValue('');
  await form.getByLabel('Value', { exact: true }).fill('20'); await form.getByLabel('Unit', { exact: true }).fill('%');
  await form.getByLabel('Observed at', { exact: true }).fill('2026-10-16T09:15');
  await picker.selectOption('pressure');
  await expect(form.getByLabel('Value', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Unit', { exact: true })).toHaveValue('bar');
  await expect(form.getByLabel('Unit', { exact: true })).toHaveJSProperty('readOnly', true);
  await form.getByLabel('Value', { exact: true }).fill('2.75'); await picker.selectOption('battery');
  await expect(form.getByLabel('Value', { exact: true })).toHaveValue('20');
  await expect(form.getByLabel('Unit', { exact: true })).toHaveValue('%');
  await expect(form.getByLabel('Unit', { exact: true })).toHaveJSProperty('readOnly', false);
  await expect(form.getByLabel('Observed at', { exact: true })).toHaveValue('2026-10-16T09:15');
  const asOf = await page.evaluate(() => new Date('2026-10-16T09:15').getTime());
  await form.getByRole('button', { name: 'Save reading', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([{ action: 'asset.update', id: 'passport',
    patch: { readings: { battery: { value: 20, unit: '%', as_of: asOf, evidence: [] } } } }]);
  await expect(route.locator('[data-yours-reading="pressure"]')).toContainText('2 bar');
  await expect(route.locator('[data-yours-reading="odometer"]')).toContainText('9000 km');
});

test('Manual reading adds a new typed field that can immediately be used by a rule', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Record reading', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('Reading', { exact: true }).selectOption({ label: 'New reading…' });
  await form.getByLabel('Field name', { exact: true }).fill('temperature');
  await expect(form.getByLabel('Unit', { exact: true })).toHaveValue('');
  await form.getByLabel('Value', { exact: true }).fill('-5.25'); await form.getByLabel('Unit', { exact: true }).fill('°C');
  await form.getByLabel('Observed at', { exact: true }).fill('2026-10-17T12:00');
  const asOf = await page.evaluate(() => new Date('2026-10-17T12:00').getTime());
  await form.getByRole('button', { name: 'Save reading', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([{ action: 'asset.update', id: 'passport',
    patch: { readings: { temperature: { value: -5.25, unit: '°C', as_of: asOf, evidence: [] } } } }]);
  await assetSection(route, 'Rules'); await route.getByRole('button', { name: 'Add rule', exact: true }).click();
  await form.getByLabel('When', { exact: true }).selectOption('objective');
  await form.getByLabel('Asset reading', { exact: true }).selectOption('temperature');
  await expect(form.getByLabel('Reading unit', { exact: true })).toHaveValue('°C');
  await expect(form.getByLabel('Asset reading', { exact: true }).locator('option:checked')).toHaveText('Temperature · -5.25 °C');
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([]);
});

test('Manual condition requires an explicit state and can later record a confirmed clear', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Record condition', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await expect(form.getByLabel('Condition', { exact: true })).toHaveValue('damage');
  await expect(form.getByLabel('What you observed', { exact: true })).toHaveValue('');
  await expect(form.locator('[data-yours-observation-previous]')).toContainText('Unknown is not clear.');
  await form.getByRole('button', { name: 'Save condition', exact: true }).click();
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
  await form.getByLabel('What you observed', { exact: true }).selectOption('possible');
  await form.getByLabel('Observed at', { exact: true }).fill('2026-10-17T12:00');
  const asOf = await page.evaluate(() => new Date('2026-10-17T12:00').getTime());
  await form.getByRole('button', { name: 'Save condition', exact: true }).click(); await expect(form).toHaveCount(0);
  const card = route.locator('[data-yours-condition="damage"]'); await expect(card).toContainText('Present · conditional · Recorded by you');
  await card.getByRole('button', { name: 'Update condition', exact: true }).click();
  await expect(form.getByLabel('What you observed', { exact: true })).toHaveValue('');
  await form.getByLabel('What you observed', { exact: true }).selectOption('clear');
  await form.getByLabel('Observed at', { exact: true }).fill('2026-10-17T12:00');
  await form.getByRole('button', { name: 'Save condition', exact: true }).click(); await expect(form).toHaveCount(0);
  await expect(card).toContainText('Clear · confirmed · Recorded by you');
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([
    { action: 'asset.update', id: 'passport', patch: { observations: { damage: { active: true, certainty: 'conditional', as_of: asOf, evidence: [], source: 'owner' } } } },
    { action: 'asset.update', id: 'passport', patch: { observations: { damage: { active: false, certainty: 'confirmed', as_of: asOf, evidence: [], source: 'owner' } } } },
  ]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('work_entity.upsert'))).toBe(0);
});

test('Manual condition adds a field without replacing a part relationship or inherited facts', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=parts#yours/asset/boiler`);
  const route = page.locator('[data-recued-yours]'); await route.getByLabel('More actions for facts', { exact: true }).click(); await route.getByRole('button', { name: 'Record condition', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await expect(form.getByLabel('Field name', { exact: true })).toBeVisible();
  await form.getByLabel('Field name', { exact: true }).fill('heating_fault');
  await form.getByLabel('What you observed', { exact: true }).selectOption('present');
  await form.getByLabel('Observed at', { exact: true }).fill('2026-10-17T12:00');
  const asOf = await page.evaluate(() => new Date('2026-10-17T12:00').getTime());
  await form.getByRole('button', { name: 'Save condition', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([{ action: 'asset.update', id: 'boiler',
    patch: { observations: { heating_fault: { active: true, certainty: 'confirmed', as_of: asOf, evidence: [], source: 'owner' } } } }]);
  await expect(route.getByRole('link', { name: 'Belongs to House', exact: true })).toBeVisible();
  await assetSection(route, 'Rules'); await route.getByRole('button', { name: 'Add rule', exact: true }).click();
  await expect(form.getByLabel('When', { exact: true })).toHaveValue('condition');
  await expect(form.getByLabel('Asset condition', { exact: true }).locator('option:checked')).toHaveText('Heating fault · Active');
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([]);
});

test('Manual reading uses a saved rule unit when the current value is still unknown', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); await assetSection(route, 'Rules'); await route.getByRole('button', { name: 'Add rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('When', { exact: true }).selectOption('objective');
  await form.getByLabel('Asset reading', { exact: true }).selectOption('battery');
  await form.getByLabel('Reading unit', { exact: true }).fill('%'); await form.getByLabel('Target', { exact: true }).fill('20');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  await assetSection(route, 'Overview'); await route.locator('[data-yours-reading="battery"]').getByRole('button', { name: 'Update reading', exact: true }).click();
  await expect(form.getByLabel('Value', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Unit', { exact: true })).toHaveValue('%');
  await expect(form.getByLabel('Unit', { exact: true })).toHaveJSProperty('readOnly', true);
  await expect(form.locator('[data-yours-observation-unit]')).toHaveText('Unit from this asset’s rule.');
  await form.getByLabel('Value', { exact: true }).fill('15');
  await form.getByRole('button', { name: 'Save reading', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetFactWrites)).toMatchObject([{ action: 'asset.update', patch: { readings: { battery: { value: 15, unit: '%' } } } }]);
});

test('Manual reading rejects duplicate and reserved new field names without writing', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Record reading', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('Reading', { exact: true }).selectOption({ label: 'New reading…' });
  await form.getByLabel('Field name', { exact: true }).fill('pressure');
  await form.getByLabel('Value', { exact: true }).fill('3'); await form.getByLabel('Unit', { exact: true }).fill('bar');
  await form.getByRole('button', { name: 'Save reading', exact: true }).click();
  await expect(route.getByRole('alert')).toHaveText('That field already exists. Choose it from the list.');
  await form.getByLabel('Field name', { exact: true }).fill('constructor');
  await form.getByRole('button', { name: 'Save reading', exact: true }).click();
  await expect(route.getByRole('alert')).toHaveText('Use a field name such as gas_pressure or leak_detected.');
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
});

test('Observation times reject future values and preserve the complete draft through a failed write', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields&yours_fail_once=1#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Record reading', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('Value', { exact: true }).fill('9500');
  await form.getByLabel('Observed at', { exact: true }).fill('2100-01-01T12:00');
  const save = form.getByRole('button', { name: 'Save reading', exact: true }); await save.click();
  await expect(route.getByRole('alert')).toHaveText('Choose an observation time that has already happened.');
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
  await form.getByLabel('Observed at', { exact: true }).fill('2026-10-17T12:00'); await save.focus(); await page.keyboard.press('Enter');
  await expect(route.getByRole('alert')).toContainText('unavailable'); await expect(save).toBeFocused();
  await expect(form.getByLabel('Reading', { exact: true })).toHaveValue('odometer');
  await expect(form.getByLabel('Value', { exact: true })).toHaveValue('9500');
  await expect(form.getByLabel('Unit', { exact: true })).toHaveValue('km');
  await expect(form.getByLabel('Observed at', { exact: true })).toHaveValue('2026-10-17T12:00');
  await page.keyboard.press('Enter'); await expect(form).toHaveCount(0);
  const writes = await page.evaluate(() => window.__assetFactWrites); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  await expect(route.locator('[data-yours-reading="odometer"]')).toContainText('9500 km');
});

test.describe('Observation times around daylight saving changes', () => {
  test.use({ timezoneId: 'America/New_York' });
  test('Observation times retain the captured instant during a clock rollback', async ({ page }) => {
    const instant = new Date('2026-11-01T06:30:10Z'); await page.clock.setFixedTime(instant);
    await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport`);
    const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Record reading', exact: true }).click();
    const form = route.locator('[data-yours-editor]'); await expect(form.getByLabel('Observed at', { exact: true })).toHaveValue('2026-11-01T01:30:10');
    await form.getByLabel('Value', { exact: true }).fill('9500');
    await form.getByRole('button', { name: 'Save reading', exact: true }).click(); await expect(form).toHaveCount(0);
    expect(await page.evaluate(() => window.__assetFactWrites)).toMatchObject([{ patch: { readings: { odometer: { as_of: instant.getTime() } } } }]);
  });
  test('Observation times reject an edited wall time that never occurred', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-11-01T06:30:10Z'));
    await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport`);
    const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Record reading', exact: true }).click();
    const form = route.locator('[data-yours-editor]'); await form.getByLabel('Value', { exact: true }).fill('9500');
    await form.getByLabel('Observed at', { exact: true }).fill('2026-03-08T02:30');
    await form.getByRole('button', { name: 'Save reading', exact: true }).click();
    await expect(route.getByRole('alert')).toHaveText('Enter a valid observation time in this device’s time zone.');
    expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
  });
});

test('Unknown reading units stay separate from known readings and retain their own draft', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); await assetSection(route, 'Rules'); await route.getByRole('button', { name: 'Add rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('When', { exact: true }).selectOption('objective');
  await expect(form.getByLabel('Reading unit', { exact: true })).toHaveValue('km');
  await form.getByLabel('Asset reading', { exact: true }).selectOption('battery');
  await expect(form.getByLabel('Reading unit', { exact: true })).toHaveValue('');
  await form.getByLabel('Target', { exact: true }).fill('20'); await form.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([]);
  await form.getByLabel('Reading unit', { exact: true }).fill('%');
  await form.getByLabel('Asset reading', { exact: true }).selectOption('odometer');
  await expect(form.getByLabel('Reading unit', { exact: true })).toHaveValue('km');
  await expect(form.getByLabel('Reading unit', { exact: true })).toHaveJSProperty('readOnly', true);
  await form.getByLabel('Asset reading', { exact: true }).selectOption('battery');
  await expect(form.getByLabel('Reading unit', { exact: true })).toHaveValue('%');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toMatchObject([{ action: 'rule.save', rule: { when: { field: 'battery', unit: '%' } } }]);
});

test('Schedule proposals expose only schedule edits and retain the original rule', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/proposals`);
  const route = page.locator('[data-recued-yours]');
  const card = route.locator('article').filter({ has: page.getByRole('heading', { name: 'Review renewal reminders', exact: true }) });
  await card.getByRole('button', { name: 'Review change', exact: true }).click(); const form = route.locator('[data-yours-editor]');
  await expect(form.getByLabel('Remind before (for example 6 months, 1 week)', { exact: true })).toBeFocused();
  for (const name of ['Title', 'When', 'Asset date', 'Consequence', 'Expiry', 'Creates', 'Notify']) await expect(form.getByLabel(name, { exact: true })).toBeDisabled();
  await form.getByLabel('Remind before (for example 6 months, 1 week)', { exact: true }).fill('3 weeks');
  await form.getByLabel('On the day', { exact: true }).uncheck();
  await form.getByRole('button', { name: 'Save proposal', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([{ action: 'proposal.edit', id: 'schedule-review',
    payload: { asset_id: 'passport', rule_id: 'renew', schedule: { before: [{ amount: 3, unit: 'weeks' }], on_day: false } } }]);
  await route.getByRole('link', { name: 'Assets', exact: true }).click();
  await route.getByRole('link', { name: 'Open asset', exact: true }).click();
  await assetSection(route, 'Rules'); await route.locator('article').filter({ has: page.getByRole('heading', { name: 'Renew', exact: true }) }).getByRole('button', { name: 'Edit rule', exact: true }).click();
  await expect(form.getByLabel('Title', { exact: true })).toHaveValue('Renew');
  await expect(form.getByLabel('Remind before (for example 6 months, 1 week)', { exact: true })).toHaveValue('6 months, 3 months, 1 months');
});

test('Schedule proposals with a missing rule stay on the proposal and explain the stale target', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields&yours_missing_rule#yours/proposals`);
  const route = page.locator('[data-recued-yours]');
  await route.locator('article').filter({ has: page.getByRole('heading', { name: 'Review renewal reminders', exact: true }) }).getByRole('button', { name: 'Review change', exact: true }).click();
  await expect(route.getByRole('alert')).toHaveText('Rule not found. Refresh this proposal.');
  await expect(route.locator('[data-yours-editor]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([]);
});

test('Returning from a class rule keeps protection for the unsaved class draft', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/assets/classes`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Create class', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('Name', { exact: true }).fill('Membership draft');
  await form.getByRole('button', { name: 'Add date field', exact: true }).click(); await form.getByLabel('Date field name', { exact: true }).fill('Expires on');
  await form.getByRole('button', { name: 'Add preset rule', exact: true }).click();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Membership draft');
  const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await page.evaluate(() => { location.hash = '#settings'; });
  await expect.poll(() => dialogs).toEqual(['Discard these unsaved Yours changes?']);
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Membership draft');
});

test('Asset date rules choose named facts and keep an unknown date unknown', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport/view/rules`);
  const route = page.locator('[data-recued-yours]'); await assetSection(route, 'Rules'); await route.getByRole('button', { name: 'Add rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]');
  await expect(form.getByLabel('Asset date', { exact: true })).toContainText('Issued on · Unknown');
  await expect(form.getByLabel('Target', { exact: true })).toBeHidden();
  await expect(form.getByLabel('Interval amount', { exact: true })).toBeHidden();
  await expect(form.getByLabel('Observation certainty', { exact: true })).toBeHidden();
  await expect(form.locator('[data-yours-rule-more]')).not.toHaveAttribute('open');
  await form.getByLabel('Title', { exact: true }).fill('Check issue date');
  await form.getByLabel('Asset date', { exact: true }).selectOption('issued_on');
  await expect(form.locator('[data-yours-rule-fact-hint]')).toHaveText('The date is unknown. No deadline has been assumed.');
  expect(await route.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(route.getByRole('heading', { name: 'Check issue date', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__assetRuleWrites)).toMatchObject([{ action: 'rule.save', asset_id: 'passport',
    rule: { title: 'Check issue date', when: { kind: 'expiry', field: 'issued_on' }, enabled: true, pinned: true,
      reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [{ amount: 1, unit: 'months' }], on_day: true } } }]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('work_entity.upsert'))).toBe(0);
});

test('Interval rules save the chosen last-done fact without supplying a missing date', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport/view/rules`);
  const route = page.locator('[data-recued-yours]'); await assetSection(route, 'Rules'); await route.getByRole('button', { name: 'Add rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('When', { exact: true }).selectOption('interval');
  await form.getByLabel('Asset date', { exact: true }).selectOption('last_serviced_on');
  await form.getByLabel('Interval amount', { exact: true }).fill('3'); await form.getByLabel('Interval unit', { exact: true }).selectOption('weeks');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toMatchObject([{ action: 'rule.save', rule: {
    when: { kind: 'interval', field: 'last_serviced_on', every: { amount: 3, unit: 'weeks' } } } }]);
  expect(await route.locator('dt').filter({ hasText: /^Last serviced on$/ }).evaluate(element => element.nextElementSibling?.textContent)).toBe('Unknown');
  expect(await page.evaluate(() => window.__app.rpcCallCount('work_entity.upsert'))).toBe(0);
});

test('Date rules keep an explicit earlier deadline in the advanced options', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/asset/passport/view/rules`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Edit rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.locator('[data-yours-rule-more]>summary').click();
  await form.getByLabel('Date offset before its field (blank for the field date)', { exact: true }).fill('2');
  await form.getByLabel('Date offset unit', { exact: true }).selectOption('weeks');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toMatchObject([{ action: 'rule.save', rule: {
    when: { kind: 'expiry', field: 'expires_on', offset: { amount: 2, unit: 'weeks' } } } }]);
  await route.getByRole('button', { name: 'Edit rule', exact: true }).click();
  await form.locator('[data-yours-rule-more]>summary').click();
  await expect(form.getByLabel('Date offset before its field (blank for the field date)', { exact: true })).toHaveValue('2');
  await expect(form.getByLabel('Date offset unit', { exact: true })).toHaveValue('weeks');
});

test('Rule kinds retain draft values and ignore invalid controls from inactive kinds', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport/view/rules`);
  const route = page.locator('[data-recued-yours]'); await assetSection(route, 'Rules'); await route.getByRole('button', { name: 'Add rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); const when = form.getByLabel('When', { exact: true });
  await when.selectOption('interval'); await form.getByLabel('Asset date', { exact: true }).selectOption('last_serviced_on');
  await form.getByLabel('Interval amount', { exact: true }).fill('-2');
  await when.selectOption('objective'); await form.getByLabel('Target', { exact: true }).fill('24000');
  await form.getByLabel('Asset reading', { exact: true }).selectOption('battery'); await form.getByLabel('Reading unit', { exact: true }).fill('%');
  await when.selectOption('condition'); await form.getByLabel('Observation certainty', { exact: true }).selectOption('conditional');
  await when.selectOption('objective'); await expect(form.getByLabel('Target', { exact: true })).toHaveValue('24000');
  await expect(form.getByLabel('Asset reading', { exact: true })).toHaveValue('battery'); await expect(form.getByLabel('Reading unit', { exact: true })).toHaveValue('%');
  await when.selectOption('interval'); await expect(form.getByLabel('Interval amount', { exact: true })).toHaveValue('-2');
  await expect(form.getByLabel('Asset date', { exact: true })).toHaveValue('last_serviced_on');
  await when.selectOption('expiry'); await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toMatchObject([{ action: 'rule.save', rule: { when: { kind: 'expiry', field: 'last_serviced_on' } } }]);
  expect(await page.evaluate(() => window.__assetRuleWrites[0])).not.toHaveProperty('rule.when.every');
});

test('Reading rules require a target and use the actual reading unit, including a zero target', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport/view/rules`);
  const route = page.locator('[data-recued-yours]'); await assetSection(route, 'Rules'); await route.getByRole('button', { name: 'Add rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('When', { exact: true }).selectOption('objective');
  await expect(form.getByLabel('Asset reading', { exact: true })).toContainText('Odometer · 9000 km');
  await expect(form.getByLabel('Reading unit', { exact: true })).toHaveValue('km');
  await expect(form.getByLabel('Reading unit', { exact: true })).toHaveJSProperty('readOnly', true);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([]);
  await form.getByLabel('Target', { exact: true }).fill('0'); await form.getByLabel('Direction', { exact: true }).selectOption('falling');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toMatchObject([{ action: 'rule.save', rule: {
    when: { kind: 'objective', field: 'odometer', target: 0, unit: 'km', direction: 'falling', mode: 'usage', lead_days: 14 } } }]);
});

test('An unknown reading can define a target without inventing a current value', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport/view/rules`);
  const route = page.locator('[data-recued-yours]'); await assetSection(route, 'Rules'); await route.getByRole('button', { name: 'Add rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('When', { exact: true }).selectOption('objective');
  await form.getByLabel('Asset reading', { exact: true }).selectOption('battery');
  await expect(form.locator('[data-yours-rule-fact-hint]')).toContainText('The reading is unknown.');
  await form.getByLabel('Reading unit', { exact: true }).fill('%'); await form.getByLabel('Target', { exact: true }).fill('20');
  await form.getByLabel('Direction', { exact: true }).selectOption('falling');
  await form.locator('[data-yours-rule-more]>summary').click(); await form.getByLabel('Usage interval (optional)', { exact: true }).fill('-1');
  await form.getByLabel('After completion', { exact: true }).selectOption('condition');
  await expect(form.getByLabel('Usage interval (optional)', { exact: true })).toBeHidden();
  await expect(form.getByLabel('Usage interval (optional)', { exact: true })).toBeDisabled();
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toMatchObject([{ action: 'rule.save', rule: {
    when: { kind: 'objective', field: 'battery', target: 20, unit: '%', direction: 'falling', mode: 'condition' } } }]);
  expect(await page.evaluate(() => window.__assetRuleWrites[0])).not.toHaveProperty('rule.when.every');
});

test('Editing a reading rule preserves its advanced settings and existing delivery behavior', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport/view/rules`);
  const route = page.locator('[data-recued-yours]'); const card = route.locator('article').filter({ has: page.getByRole('heading', { name: 'Service by distance', exact: true }) });
  await card.getByRole('button', { name: 'Edit rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await expect(form.locator('[data-yours-rule-more]')).not.toHaveAttribute('open');
  await expect(form.getByLabel('Creates', { exact: true })).toHaveValue('');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([{ action: 'rule.save', asset_id: 'passport', confirm_floor_mute: false, rule: {
    id: 'meter_service', title: 'Service by distance', enabled: true, muted: true, pinned: true, consequence: 'routine', expiry_policy: 'escalate_overdue',
    verified_as_of: '2026-10-01', reaction: { notify: false, occurrence: null, emit: true }, schedule: { before: [], on_day: false },
    when: { kind: 'objective', field: 'odometer', target: 10000, unit: 'km', direction: 'rising', mode: 'usage', lead_days: 9, lead_value: 250, every: 5000 } } }]);
});

test('Condition rules select recorded conditions without treating unknown as active', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport/view/rules`);
  const route = page.locator('[data-recued-yours]'); await assetSection(route, 'Rules'); await route.getByRole('button', { name: 'Add rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('When', { exact: true }).selectOption('condition');
  await expect(form.getByLabel('Asset condition', { exact: true })).toContainText('Damage · Unknown');
  await expect(form.locator('[data-yours-rule-fact-hint]')).toContainText('No active condition has been assumed.');
  await expect(form.getByLabel('Target', { exact: true })).toBeHidden();
  await form.getByLabel('Observation certainty', { exact: true }).selectOption('conditional');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toMatchObject([{ action: 'rule.save', rule: { when: { kind: 'condition', field: 'damage', certainty: 'conditional' } } }]);
});

test('An asset without facts explains what to add and cannot save an empty selector', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=parts#yours/asset/boiler`);
  const route = page.locator('[data-recued-yours]'); await assetSection(route, 'Rules'); await route.getByRole('button', { name: 'Add rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]');
  await expect(form.locator('[data-yours-rule-fact-hint]')).toHaveText('No dates on this asset yet. Add one in Edit asset before saving this kind of rule.');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.getByLabel('When', { exact: true }).selectOption('objective');
  await expect(form.locator('[data-yours-rule-fact-hint]')).toHaveText('No readings on this asset yet. Use Record reading on the asset before saving this kind of rule.');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.getByLabel('When', { exact: true }).selectOption('condition');
  await expect(form.locator('[data-yours-rule-fact-hint]')).toHaveText('No conditions on this asset yet. Use Record condition on the asset before saving this kind of rule.');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([]);
});

test('Invalid advanced values are revealed and notices cannot retain action repeats', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/asset/passport/view/rules`);
  const route = page.locator('[data-recued-yours]'); await assetSection(route, 'Rules'); await route.getByRole('button', { name: 'Add rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); const more = form.locator('[data-yours-rule-more]');
  await more.locator('summary').click(); await form.getByLabel('Repeat after (blank for none)', { exact: true }).fill('0');
  await more.locator('summary').click(); await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(more).toHaveAttribute('open'); await expect(form.getByLabel('Repeat after (blank for none)', { exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([]);
  await form.getByLabel('Repeat after (blank for none)', { exact: true }).fill('2'); await more.locator('summary').click();
  await form.getByLabel('Creates', { exact: true }).selectOption('notice'); await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(route.getByRole('alert')).toHaveText('Only an action can repeat after its date. Clear Repeat after or choose an action.');
  await expect(more).toHaveAttribute('open');
  await form.getByLabel('Repeat after (blank for none)', { exact: true }).fill(''); await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toMatchObject([{ action: 'rule.save', rule: { reaction: { occurrence: 'notice' } } }]);
  expect(await page.evaluate(() => window.__assetRuleWrites[0])).not.toHaveProperty('rule.schedule.after');
});

test('Stopping a safety clock still requires the existing explicit confirmation', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/asset/passport/view/rules`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Edit rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('Notify', { exact: true }).uncheck();
  page.once('dialog', dialog => dialog.dismiss()); await form.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([]); await expect(form).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toMatchObject([{ action: 'rule.save', confirm_floor_mute: true, rule: {
    id: 'renew', reaction: { notify: false }, schedule: { after: { amount: 1, unit: 'months' } } } }]);
});

test('Editing a proposed asset rule saves its draft without enabling or applying it', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/proposals`);
  const route = page.locator('[data-recued-yours]'); const card = route.locator('article').filter({ has: page.getByRole('heading', { name: 'Review issue-date check', exact: true }) });
  await card.getByRole('button', { name: 'Review change', exact: true }).click(); const form = route.locator('[data-yours-editor]');
  await expect(form.getByLabel('Asset date', { exact: true })).toHaveValue('issued_on');
  await form.locator('[data-yours-rule-more]>summary').click();
  await expect(form.getByLabel('Enabled', { exact: true })).toBeDisabled();
  await form.getByLabel('Remind before (for example 6 months, 1 week)', { exact: true }).fill('2 weeks');
  await form.getByRole('button', { name: 'Save proposal', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toMatchObject([{ action: 'proposal.edit', id: 'rule-review', payload: {
    asset_id: 'passport', rule: { id: 'issue_check', enabled: false, pinned: false, when: { kind: 'expiry', field: 'issued_on' }, schedule: { before: [{ amount: 2, unit: 'weeks' }], on_day: true } } } }]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('work_entity.upsert'))).toBe(0);
});

test('An asset question opens an editable draft for the exact asset without sending', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${HARNESS_URL}?yours=relations#yours/asset/boiler-current`);
  await page.getByRole('button', { name: 'Ask about this asset', exact: true }).click();
  const context = page.getByRole('group', { name: 'Selected asset', exact: true });
  await expect(page.getByRole('heading', { name: 'Ask about this asset', exact: true })).toBeVisible();
  await expect(page.locator('[data-recued-chat-route-activation]')).toHaveCount(0);
  await expect(context.getByRole('link', { name: 'Kitchen boiler', exact: true })).toHaveAttribute('href', '#yours/asset/boiler-current');
  await expect(page.getByRole('textbox', { name: 'Message to Recued', exact: true })).toHaveValue('What should I know about this asset?');
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.session.create'))).toBe(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Asset questions send references through ordinary Chat and show a readable history entry', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_file_details=ready&connection=source-answer#yours/asset/passport`);
  await captureAssetChatCalls(page);
  await page.getByRole('button', { name: 'Ask about this asset', exact: true }).click();
  const context = page.getByRole('group', { name: 'Selected asset', exact: true }); await expect(context).toContainText('1 linked file');
  await page.getByRole('textbox', { name: 'Message to Recued', exact: true }).fill('What does the saved evidence say?');
  await page.locator('[data-recued-chat-route-send]').click();
  await expect.poll(() => page.evaluate(() => window.__assetChatCalls.filter(call => call.method === 'chat.send').length)).toBe(1);
  const args = await page.evaluate(() => window.__assetChatCalls.find(call => call.method === 'chat.send')!.args);
  expect(args.message).toContain('"asset":{"kind":"asset","id":"passport"}');
  expect(args.message).toContain('"file_ref":"file:received:receipt"');
  expect(args.message).not.toContain('Ana’s passport'); expect(args.attachments).toBeUndefined();
  expect(await page.evaluate(() => window.__app.rpcCallCount('data.file.attachments.preview'))).toBe(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('data.file.read'))).toBe(0);
  await expect(context).toHaveCount(0);
  await page.locator('[data-recued-chat-route-new-session]').click(); await openChatHistory(page);
  await page.locator('[data-recued-chat-route-session-row]').first().click();
  const question = page.locator('[data-chat-asset-question]');
  await expect(question.getByRole('link', { name: 'Open selected asset', exact: true })).toHaveAttribute('href', '#yours/asset/passport');
  await expect(question).toContainText('What does the saved evidence say?'); await expect(question.locator('pre')).toBeHidden();
});

test('Removing asset context keeps the question and sends an ordinary message', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=relations&connection=source-answer#yours/asset/boiler-current`); await captureAssetChatCalls(page);
  await page.getByRole('button', { name: 'Ask about this asset', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message to Recued', exact: true }); await input.fill('A different question.');
  await page.getByRole('button', { name: 'Remove asset context', exact: true }).click(); await expect(input).toHaveValue('A different question.');
  await expect(page.getByRole('group', { name: 'Selected asset', exact: true })).toHaveCount(0);
  await page.locator('[data-recued-chat-route-send]').click();
  await expect.poll(() => page.evaluate(() => window.__assetChatCalls.find(call => call.method === 'chat.send')?.args.message)).toBe('A different question.');
});

test('Withdrawing an asset question restores editable context and preserves a context-only draft', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_file_details=ready&yours_asset_queue=1&connection=source-answer#yours/asset/passport`);
  await captureAssetChatCalls(page); await page.getByRole('button', { name: 'Ask about this asset', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message to Recued', exact: true });
  await input.fill('What needs maintenance?'); await page.locator('[data-recued-chat-route-send]').click();
  const queue = page.getByRole('region', { name: 'Conversation queue', exact: true });
  await expect(queue).toContainText('Queued: What needs maintenance?');
  await queue.getByRole('button', { name: 'Withdraw to edit', exact: true }).click();
  const context = page.getByRole('group', { name: 'Selected asset', exact: true });
  await expect(input).toHaveValue('What needs maintenance?'); await expect(context).toContainText('1 linked file');
  await expect(queue).not.toContainText('work.read');
  await expect(context.getByRole('link')).toHaveAttribute('href', '#yours/asset/passport');
  await input.fill(''); await queue.getByRole('button', { name: 'Restore withdrawn draft', exact: true }).click();
  await expect(queue).toContainText('Send or clear your current draft'); await expect(input).toHaveValue('');
  await expect(context).toBeVisible();
  await input.fill('Check the warranty instead.'); await page.locator('[data-recued-chat-route-send]').click();
  await expect.poll(() => page.evaluate(() => window.__assetChatCalls.filter(call => call.method === 'chat.send').length)).toBe(2);
  const sent = await page.evaluate(() => window.__assetChatCalls.filter(call => call.method === 'chat.send').map(call => call.args));
  expect(sent[1]!.message).toContain('Check the warranty instead.'); expect(sent[1]!.message).toContain('"file_ref":"file:received:receipt"');
  expect(String(sent[1]!.message).match(/recued\.asset_question/g)).toHaveLength(1);
  expect(sent[1]!.submission_id).not.toBe(sent[0]!.submission_id);
});

test('The supplied asset context stays expanded across Chat renders', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&connection=source-answer#yours/asset/passport`);
  await page.getByRole('button', { name: 'Ask about this asset', exact: true }).click();
  await page.locator('[data-recued-chat-route-send]').click();
  await page.locator('[data-recued-chat-route-new-session]').click(); await openChatHistory(page);
  await page.locator('[data-recued-chat-route-session-row]').first().click();
  const details = page.locator('[data-chat-asset-question] details'); await details.locator('summary').click();
  await expect(details).toHaveJSProperty('open', true);
  await page.locator('[data-recued-chat-route-input]').fill('A follow-up');
  await page.locator('[data-recued-chat-route-send]').click();
  await expect(page.locator('[data-chat-asset-question] details').first()).toHaveJSProperty('open', true);
});

test('A failed asset question retains its context and retries the same submission', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=relations&connection=source-answer&chat=session&chat_send_response=fail-once#yours/asset/boiler-current`);
  await captureAssetChatCalls(page); await page.getByRole('button', { name: 'Ask about this asset', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message to Recued', exact: true }); await input.fill('What needs maintenance?');
  await page.locator('[data-recued-chat-route-send]').click();
  await expect.poll(() => page.evaluate(() => window.__assetChatCalls.filter(call => call.method === 'chat.send').length)).toBe(1);
  await expect(page.locator('[data-recued-chat-route-send]')).toBeEnabled();
  await expect(page.getByRole('group', { name: 'Selected asset', exact: true })).toBeVisible(); await expect(input).toHaveValue('What needs maintenance?');
  await page.locator('[data-recued-chat-route-send]').click();
  await expect.poll(() => page.evaluate(() => window.__assetChatCalls.filter(call => call.method === 'chat.send').length)).toBe(2);
  const sent = await page.evaluate(() => window.__assetChatCalls.filter(call => call.method === 'chat.send').map(call => call.args));
  expect(sent[1]!.submission_id).toBe(sent[0]!.submission_id); expect(sent[1]!.message).toBe(sent[0]!.message);
  await expect(page.getByRole('group', { name: 'Selected asset', exact: true })).toHaveCount(0);
});

test('Asset context stays with its parked draft and context-only drafts can be discarded', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=relations&chat=session#yours/asset/boiler-current`);
  await page.getByRole('button', { name: 'Ask about this asset', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message to Recued', exact: true }); await input.fill('My boiler question');
  await openChatHistory(page); await page.locator('[data-recued-chat-route-session-row="chat_1"]').click();
  await expect(page.getByRole('group', { name: 'Selected asset', exact: true })).toHaveCount(0); await expect(input).toHaveValue('');
  await page.locator('[data-recued-chat-route-new-session]').click(); await expect(input).toHaveValue('My boiler question');
  await expect(page.getByRole('group', { name: 'Selected asset', exact: true })).toContainText('Kitchen boiler');
  await input.fill(''); await page.locator('[data-recued-chat-route-new-session]').click();
  await page.getByRole('button', { name: 'Throw it away and start a new one', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Selected asset', exact: true })).toHaveCount(0); await expect(input).toHaveValue('');
});

test('An asset question waits for Chat loading and never submits itself', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=relations#yours/asset/boiler-current`);
  await page.evaluate(() => window.__app.holdRpcResponses?.('chat.sessions.list'));
  const before = await page.evaluate(() => window.__app.rpcCallCount('chat.sessions.list'));
  await page.getByRole('button', { name: 'Ask about this asset', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('chat.sessions.list'))).toBeGreaterThan(before);
  await expect(page.locator('[data-recued-chat-route-send]:enabled')).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
  await page.evaluate(() => window.__app.releaseRpcResponses?.('chat.sessions.list'));
  await expect(page.getByRole('group', { name: 'Selected asset', exact: true })).toContainText('Kitchen boiler');
  await expect(page.getByRole('textbox', { name: 'Message to Recued', exact: true })).toHaveValue('What should I know about this asset?');
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
});

test('Today and Data filter loaded records by their server-derived sphere', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&settle_reads=1#today`);
  const today = page.locator('[data-today-view]'); const title = today.getByRole('link', { name: 'Renew · Ana’s passport', exact: true });
  await expect(today.locator('[data-item-sphere]').first()).toContainText('Personal');
  await today.getByLabel('Today sphere', { exact: true }).selectOption('professional'); await expect(title).toHaveCount(0);
  await today.getByLabel('Today sphere', { exact: true }).selectOption('personal'); await expect(title).toBeVisible();
  await page.evaluate(() => { location.hash = '#data/commitment'; });
  const filter = page.getByLabel('Data sphere', { exact: true }); await expect(filter).toBeVisible();
  await filter.selectOption('professional'); await expect(page.getByText('Renew · Ana’s passport', { exact: true })).toHaveCount(0);
  await filter.selectOption('personal'); await expect(page.getByText('Renew · Ana’s passport', { exact: true })).toBeVisible(); await expect(filter).toBeFocused();
});
test('Data offers the sphere filter over loaded records only', async ({ page }) => {
  // An empty tab has nothing to filter, on any server; on one without Yours this
  // was also the one place the filter stayed, since no placement read ever failed.
  for (const server of ['yours=demo', 'yours=demo&yours_absent=1']) {
    await page.goto(`${HARNESS_URL}?${server}&settle_reads=1#data/note`);
    await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
    await expect(page.getByLabel('Data sphere', { exact: true })).toHaveCount(0);
  }
  await page.goto(`${HARNESS_URL}?yours=demo&settle_reads=1#data/commitment`);
  await expect(page.getByLabel('Data sphere', { exact: true })).toBeVisible();
});
test('Connections places a source in Personal or Work on the lane that holds it', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await page.goto(`${HARNESS_URL}?yours=demo&settle_reads=1#connections/mail`);
  // Each lane offers only its own sources: the calendar is placed on Calendar.
  let row = page.locator('[data-source-sphere-row="mail:personal"]'); await expect(row).toBeVisible();
  await expect(page.locator('[data-source-sphere-row="calendar:work"]')).toHaveCount(0);
  await page.evaluate(() => { location.hash = '#connections/calendar'; });
  row = page.locator('[data-source-sphere-row="calendar:work"]'); await expect(row.getByRole('radio', { name: 'Work', exact: true })).toBeChecked();
  await row.getByRole('radio', { name: 'Personal', exact: true }).check();
  // A change waits for Save, and says it widens what Personal access covers.
  await expect(row).toContainText('Anything you have shared for Personal items will include them');
  await row.getByRole('button', { name: 'Save', exact: true }).click(); await expect(row.getByRole('status')).toContainText('Saved');
  await page.evaluate(() => { location.hash = '#connections/mail'; }); await expect(page.locator('[data-source-sphere-row="mail:personal"]')).toBeVisible();
  await page.evaluate(() => { location.hash = '#connections/calendar'; });
  await expect(page.locator('[data-source-sphere-row="calendar:work"]').getByRole('radio', { name: 'Personal', exact: true })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('Learning proposals have working edits and annual tasks are reviewed in Contracts', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await page.goto(`${HARNESS_URL}?yours=demo&learning=1&contracts=paged#yours/proposals`);
  let route = page.locator('[data-recued-yours]');
  const ranking = route.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Review passport ranking', exact: true }) });
  await ranking.getByRole('button', { name: 'Review change', exact: true }).click();
  let form = page.locator('[data-yours-editor]'); await form.getByLabel('Ranking factor (0.5 to 1.5)', { exact: true }).fill('1.4'); await form.getByRole('button', { name: 'Save', exact: true }).click();
  await ranking.getByRole('button', { name: 'Review change', exact: true }).click(); await expect(form.getByLabel('Ranking factor (0.5 to 1.5)', { exact: true })).toHaveValue('1.4');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  const relation = route.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Relate trips to travel documents', exact: true }) });
  await relation.getByRole('button', { name: 'Review change', exact: true }).click();
  await form.getByLabel('Related asset class', { exact: true }).selectOption('passport'); await form.getByRole('button', { name: 'Save', exact: true }).click();
  await route.getByRole('link', { name: 'Review standing task in Contracts', exact: true }).click();
  const panel = page.locator('[data-standing-tasks]'); await expect(panel.getByRole('heading', { name: 'An annual task? · Buy flowers', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Edit annual task', exact: true }).click();
  await panel.getByLabel('Annual task', { exact: true }).fill('Arrange flowers'); await panel.getByRole('button', { name: 'Save proposal', exact: true }).click();
  await panel.getByRole('button', { name: 'Edit annual task', exact: true }).click(); await expect(panel.getByLabel('Annual task', { exact: true })).toHaveValue('Arrange flowers');
  await panel.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  await panel.getByRole('button', { name: 'Accept annual task', exact: true }).click(); await expect(panel).toBeHidden();
  await page.evaluate(() => { location.hash = '#yours/occasions'; }); route = page.locator('[data-recued-yours]');
  await expect(route.getByRole('heading', { name: 'Arrange flowers', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('A server without Yours leaves the new sections out instead of reporting errors', async ({ page }) => {
  // ⛔ The hosted webclient is newer than many self-hosted servers. Each D-325 surface
  // reported its missing method as an error instead of leaving the section out.
  // The demo records give every surface something to read; every `yours.*` method is unknown.
  const count = (method: string) => page.evaluate(name => window.__app.rpcCallCount(name), method);
  const calledAgain = async (method: string, before: number) => expect.poll(() => count(method)).toBeGreaterThan(before);
  await page.goto(`${HARNESS_URL}?yours=demo&yours_absent=1&contracts=paged#today`); await calledAgain('yours.today', 0);
  await expect(page.locator('[data-today-view]').getByText('Some sources may be missing', { exact: false })).toHaveCount(0);
  let before = await count('yours.spheres'); await page.evaluate(() => { location.hash = '#data/commitment'; }); await calledAgain('yours.spheres', before);
  await expect(page.getByText('Renew · Ana’s passport', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Data sphere', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Sphere placements could not be read', { exact: false })).toHaveCount(0);
  before = await count('yours.delivery'); await page.evaluate(() => { location.hash = '#settings/notifications'; }); await calledAgain('yours.delivery', before);
  await expect(page.locator('[data-situation-delivery]')).toHaveCount(0); await expect(page.locator('[data-household-delivery]')).toHaveCount(0);
  await calledAgain('yours.learning', 0); await page.evaluate(() => { location.hash = '#settings/privacy'; });
  await expect(page.locator('[data-last-time]')).toHaveCount(0);
  before = await count('yours.read'); await page.evaluate(() => { location.hash = '#connections/mail'; }); await calledAgain('yours.read', before);
  await expect(page.locator('[data-source-spheres]')).toHaveCount(0);
  before = await count('yours.read'); await page.evaluate(() => { location.hash = '#contracts'; }); await calledAgain('yours.read', before);
  await expect(page.locator('[data-standing-tasks]')).toHaveCount(0);
  // A contact's sphere control and recorded history.
  await page.goto(`${HARNESS_URL}?yours=demo&yours_absent=1&data=contacts&settle_reads=1#data/contact`); await calledAgain('yours.spheres', 0);
  await expect(page.getByLabel('Data sphere', { exact: true })).toHaveCount(0);
  await page.locator('[data-recued-data-contact-row]').first().locator('.data-contact-row-button').click();
  await calledAgain('yours.sphere', 0); await calledAgain('yours.read', 0);
  await expect(page.locator('[data-recued-data-contact-detail-heading]')).toBeVisible();
  await expect(page.locator('[data-sphere-placement]')).toHaveCount(0);
  await expect(page.locator('[data-contact-proactive-history]')).toHaveCount(0);
  await expect(page.getByText('This history could not be read', { exact: false })).toHaveCount(0);
});
test('A broadcast burst never rebuilds Yours over what the owner is typing', async ({ page }) => {
  // ⛔ Every warehouse event re-read the whole snapshot and re-rendered the page,
  // so a mail sync reset a half-typed search, date or place with focus still in it.
  await page.goto(`${HARNESS_URL}?yours=demo#yours`);
  const route = page.locator('[data-recued-yours]'); const search = route.getByLabel('Find assets', { exact: true });
  await expect(search).toBeVisible(); await search.fill('LG tel');
  const before = await page.evaluate(() => window.__app.rpcCallCount('yours.read'));
  await page.evaluate(() => { for (let index = 0; index < 5; index += 1) window.__app.fireMessage({ type: 'server_event',
    event: { kind: 'warehouse', collection: 'mail', op: 'insert', id: `burst-${index}`, cursor: Date.now() + 10_000 + index } }); });
  await expect(route.getByText('Updates are available.', { exact: false })).toBeVisible();
  await expect(search).toHaveValue('LG tel');
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(before);
  await route.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(before + 1);
  // With nothing typed, a burst refreshes once, not once per event.
  await page.evaluate(() => { for (let index = 0; index < 5; index += 1) window.__app.fireMessage({ type: 'server_event',
    event: { kind: 'warehouse', collection: 'mail', op: 'insert', id: `quiet-${index}`, cursor: Date.now() + 20_000 + index } }); });
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(before + 2);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(before + 2);
});
test('A cancelled new asset stays closed through the next refresh', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/new`);
  const route = page.locator('[data-recued-yours]'); const form = page.locator('[data-yours-editor]');
  await expect(form.getByLabel('Name', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(form).toHaveCount(0);
  const before = await page.evaluate(() => window.__app.rpcCallCount('yours.read'));
  await route.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(before + 1);
  await page.waitForTimeout(300); await expect(form).toHaveCount(0);
});
test('A typed search is not an unsaved change when leaving Yours', async ({ page }) => {
  const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await page.goto(`${HARNESS_URL}?yours=demo#yours`);
  const route = page.locator('[data-recued-yours]'); await route.getByLabel('Find assets', { exact: true }).fill('passport');
  await page.evaluate(() => { location.hash = '#settings'; });
  await expect(route).toHaveCount(0); expect(dialogs).toEqual([]);
});
test('Episodes lists stored episodes only and keeps a cited derived episode only after an owner correction', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await page.goto(`${HARNESS_URL}?yours=demo#yours/episodes`);
  let route = page.locator('[data-recued-yours]'); await expect(route.locator('summary').filter({ hasText: /^Memory exclusions$/u })).toBeVisible();
  await route.locator('[data-yours-disclosure="Last time in your overview"]>summary').click();
  await expect(route.getByRole('button', { name: 'Accept this rate', exact: true })).toBeDisabled();
  // P44 — never a derived lifelog: the list shows nothing assembled, and never asks for it.
  await expect(route.getByText('Assembled for this view.', { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as { __yoursDerivedListReads?: number }).__yoursDerivedListReads ?? 0)).toBe(0);
  await page.evaluate(() => { location.hash = '#yours/episodes/episode/vegas-episode'; }); route = page.locator('[data-recued-yours]');
  await expect(route.getByText('Assembled for this view.', { exact: false })).toBeVisible();
  await route.getByRole('button', { name: 'Correct or annotate', exact: true }).click(); const form = page.locator('[data-yours-editor]');
  await form.getByLabel('Notes', { exact: true }).fill('We visited the museum that afternoon.'); await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(route.getByText('We visited the museum that afternoon.', { exact: true })).toBeVisible();
  await expect(route.getByText('Assembled for this view.', { exact: false })).toHaveCount(0);
  await route.locator('[data-yours-disclosure="Memory exclusions"]>summary').click();
  await route.getByLabel('Person to exclude', { exact: true }).selectOption('ana'); await route.getByRole('button', { name: 'Add exclusion', exact: true }).click();
  await expect(route.getByRole('heading', { name: 'Person: Ana', exact: true })).toBeVisible();
  await route.getByRole('button', { name: 'Remove exclusion', exact: true }).click(); await expect(route.getByRole('heading', { name: 'Person: Ana', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await route.getByLabel('More actions for Las Vegas trip', { exact: true }).click();
  await route.getByRole('button', { name: 'Delete and stop suggesting', exact: true }).click(); await expect(route.getByRole('heading', { name: 'Las Vegas trip', exact: true })).toHaveCount(0);
});
test('An annual occasion keeps its date notice and offers an editable habit with its own due offset', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await page.goto(`${HARNESS_URL}#yours/occasions`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Create occasion', exact: true }).click();
  let form = page.locator('[data-yours-editor]'); await form.getByLabel('Name', { exact: true }).fill('Ana birthday');
  await form.getByLabel('Annual date (MM-DD)', { exact: true }).fill('10-24'); await form.getByLabel('Person', { exact: true }).selectOption('ana');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(route.getByText('Notice · 1 week before; on the day', { exact: true })).toBeVisible();
  await route.getByRole('button', { name: 'Add habit', exact: true }).click(); form = page.locator('[data-yours-editor]');
  await form.getByLabel('Title', { exact: true }).fill('Buy flowers'); await form.getByLabel('Due before the occasion (blank for the occasion date)', { exact: true }).fill('2');
  await form.getByLabel('Remind before the due date', { exact: true }).fill('1 week');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const habit = route.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Buy flowers', exact: true }) }).last();
  await expect(habit.getByText('Task · 1 week before; on the day', { exact: true })).toBeVisible();
  await habit.getByRole('button', { name: 'Edit occasion rule', exact: true }).click();
  await expect(page.locator('[data-yours-editor]').getByLabel('Due before the occasion (blank for the occasion date)', { exact: true })).toHaveValue('2');
});
test('Yours has five working tabs, Classes within Assets, and same-route addresses replace their content', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/assets`);
  const route = page.locator('[data-recued-yours]'); const nav = page.getByRole('navigation', { name: 'Yours', exact: true });
  await expect(nav.getByRole('link')).toHaveCount(5);
  await expect(route.getByRole('heading', { name: 'Ana’s passport' })).toBeVisible();
  await nav.getByRole('link', { name: 'Proposals', exact: true }).click();
  await expect(route.locator('summary').filter({ hasText: /^What is read$/u })).toBeVisible();
  await expect(route.getByRole('heading', { name: 'LG television' })).toBeVisible();
  await nav.getByRole('link', { name: 'Assets', exact: true }).click();
  await route.getByRole('link', { name: 'Classes', exact: true }).click();
  await expect(route.getByRole('heading', { name: 'Passport · v1' })).toBeVisible();
  await nav.getByRole('link', { name: 'Occasions', exact: true }).click();
  await expect(route.getByRole('button', { name: 'Create occasion' })).toBeVisible();
  await nav.getByRole('link', { name: 'Episodes', exact: true }).click();
  await expect(route.getByRole('button', { name: 'Record episode' })).toBeVisible();
  await expect(route).toHaveCount(1);
});

test('Create → Asset keeps its discard guard and reveals required details on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await page.locator(`[${DRAWER_ACTION}="create"]`).click();
  const overlay = page.locator('[data-recued-create-overlay]');
  await overlay.getByLabel('Email', { exact: true }).fill('draft@example.test');
  await overlay.locator('[data-recued-create-asset]').click();
  await overlay.getByRole('button', { name: 'Keep editing' }).click();
  await expect(overlay.getByLabel('Email', { exact: true })).toHaveValue('draft@example.test');
  await overlay.locator('[data-recued-create-asset]').click();
  await overlay.getByRole('button', { name: 'Throw it away' }).click();
  const form = page.locator('[data-yours-editor]');
  await expect(form.getByLabel('Type (optional)', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Status', { exact: true })).not.toBeVisible();
  await expect(form.getByLabel('Holder', { exact: true })).not.toBeVisible();
  await form.getByLabel('Name', { exact: true }).fill('Travel passport');
  await form.getByLabel('Type (optional)', { exact: true }).selectOption('passport');
  await expect(form.getByLabel('Holder', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form.getByLabel('Holder', { exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
  await form.getByLabel('Holder', { exact: true }).selectOption('ana');
  await form.getByText('More details (optional)', { exact: true }).click();
  await form.getByLabel('expires on', { exact: true }).fill('2027-04-17');
  await expect(form.getByText('Optional; no reminder needs it.', { exact: false })).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('[data-recued-yours]').getByRole('heading', { name: 'Travel passport', exact: true })).toBeVisible();
  await expect(page.locator('[data-yours-editor]')).toHaveCount(0);
});

test('asset creation reveals invalid optional details and keeps corrected facts through save', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${HARNESS_URL}?yours=demo#yours/new`);
  const consoleErrors: string[] = []; page.on('console', message => { if (message.type() === 'error' && message.text().includes('not focusable')) consoleErrors.push(message.text()); });
  const route = page.locator('[data-recued-yours]'); const form = page.locator('[data-yours-editor]');
  const more = form.locator('[data-yours-asset-more]'); const toggle = more.locator('summary');
  await form.getByLabel('Name', { exact: true }).fill('Workshop boiler');
  await toggle.click(); await form.getByRole('button', { name: 'Add place', exact: true }).click();
  await form.getByLabel('Latitude', { exact: true }).fill('100'); await form.getByLabel('Longitude', { exact: true }).fill('200');
  await toggle.click(); await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form.getByLabel('Latitude', { exact: true })).toBeFocused(); await expect(more).toHaveAttribute('open', '');
  await form.getByLabel('Latitude', { exact: true }).fill('37'); await form.getByLabel('Longitude', { exact: true }).fill('');
  await toggle.click(); await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(route.getByRole('alert')).toContainText('both latitude and longitude'); await expect(more).toHaveAttribute('open', '');
  await form.getByLabel('Longitude', { exact: true }).fill('0');
  await form.getByRole('button', { name: 'Add setting', exact: true }).click();
  await form.getByLabel('Settings field name', { exact: true }).fill('bad key'); await form.getByLabel('Settings value', { exact: true }).fill('21');
  await toggle.click(); await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(route.getByRole('alert')).toContainText('Use a field name'); await expect(more).toHaveAttribute('open', '');
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0); expect(consoleErrors).toEqual([]);
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Workshop boiler');
  await form.getByLabel('Settings field name', { exact: true }).fill('preferred_notice_days');
  await toggle.click(); await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(route.getByRole('heading', { name: 'Workshop boiler', exact: true })).toBeVisible();
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click();
  await expect(form.getByLabel('Latitude', { exact: true })).toHaveValue('37'); await expect(form.getByLabel('Longitude', { exact: true })).toHaveValue('0');
  await expect(form.getByLabel('Settings field name', { exact: true })).toHaveValue('preferred_notice_days'); await expect(form.getByLabel('Settings value', { exact: true })).toHaveValue('21');
});

test('an asset edit retains its draft and keyboard focus across a failed write, then shows the confirmed result', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_fail_once=1#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Edit asset', exact: true }).click();
  const form = page.locator('[data-yours-editor]'); await form.getByLabel('Name', { exact: true }).fill('Passport kept in safe');
  const save = form.getByRole('button', { name: 'Save', exact: true }); await save.focus(); await page.keyboard.press('Enter');
  await expect(route.getByRole('alert')).toContainText('unavailable'); await expect(save).toBeFocused();
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Passport kept in safe');
  await page.keyboard.press('Enter');
  await expect(route.getByRole('heading', { name: 'Passport kept in safe', exact: true })).toBeVisible();
  await expect(form).toHaveCount(0);
});

// D-325 §15.3 — the header names the holder, each fact says where it came from and what
// outranks it, a condition shows its writer and evidence, and an edit or "That’s expected"
// sends only what it changes: the store stamps whatever it is sent as typed by the owner.
test('The asset page says where each fact came from, and an edit re-sends nothing the owner left alone', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_provenance=1#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); const fact = (path: string) => route.locator(`[data-yours-fact="${path}"]`);
  await expect(route.locator('[data-yours-holder]')).toHaveText('Held by Ana');
  await expect(route.getByText('Passport · Active · Only you', { exact: true })).toBeVisible();
  await expect(fact('dates.expires_on')).toContainText('From a request that came in');
  await expect(fact('dates.expires_on')).toContainText('A device report, a document you confirm or your own entry outranks it.');
  await expect(fact('settings.radius_km')).toContainText('From a document you confirmed');
  await expect(fact('settings.radius_km')).toContainText('Only your own entry outranks it.');
  await expect(fact('attributes.cover')).toContainText('An AI guess'); await expect(fact('holder_contact')).toContainText('Ana');
  await expect(fact('document_number')).toContainText('Entered by you'); await expect(fact('document_number')).toContainText('Nothing automatic replaces it.');
  await expect(fact('document_number')).toContainText('AI apps you connect can read it exactly as typed');
  const condition = route.locator('[data-yours-condition="flickering"]');
  await expect(condition).toContainText('Present · conditional · Porch light check ·');
  await expect(condition.locator('[data-yours-evidence] li')).toHaveText(['Home Assistant · light.porch · transitions: on and off 14 times in two minutes, not from an automation']);
  await condition.getByRole('button', { name: 'That’s expected', exact: true }).click();
  await expect(condition).toContainText('You marked this as expected on');
  await expect(condition).toContainText('While it is present, it raises no task or reminder.');
  await expect(condition.getByRole('button', { name: 'That’s expected', exact: true })).toHaveCount(0);
  await expect(fact('settings.expected_patterns')).toHaveCount(0);
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click();
  const form = page.locator('[data-yours-editor]'); await form.getByLabel('Name', { exact: true }).fill('Ana’s old passport');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([
    { action: 'asset.update', id: 'passport', patch: { settings: { expected_patterns: { flickering: { active: true, at: Date.parse('2026-10-17T12:00Z') } } } } },
    { action: 'asset.update', id: 'passport', patch: { name: 'Ana’s old passport' }, confirm_retirement: false },
  ]);
  await condition.getByRole('button', { name: 'Not expected after all', exact: true }).click();
  await expect(condition.getByRole('button', { name: 'That’s expected', exact: true })).toBeVisible();
  expect((await page.evaluate(() => window.__assetFactWrites)).at(-1))
    .toEqual({ action: 'asset.update', id: 'passport', patch: { settings: { expected_patterns: null } } });
});

// D-325 §15.2 and P44 — an occasion's page shows the suggestions that would change it and
// its history, where an episode can be corrected or hidden; a contact's page offers the same.
test('An occasion shows its suggestions and history, and an episode cited there or on a contact can be corrected or hidden', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&contact_history=1&occasion_history=1#yours/occasions/occasion/ana-birthday`);
  const route = page.locator('[data-recued-yours]'); const cited = (id: string) => route.locator(`[data-yours-cited-episode="${id}"]`);
  await expect(route.getByRole('heading', { name: 'Suggestions', exact: true })).toBeVisible();
  await expect(route.getByRole('heading', { name: 'Review reminder timing · Ana birthday', exact: true })).toBeVisible();
  await expect(route.locator('[data-yours-cited-episode]')).toHaveCount(2);
  await expect(cited('dinner')).toContainText('your record');
  await cited('dinner').getByRole('button', { name: 'Correct', exact: true }).click();
  const editor = page.locator('[data-yours-editor]'); await expect(editor.getByLabel('What happened', { exact: true })).toHaveValue('Birthday dinner');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(editor).toHaveCount(0);
  await cited('museum').getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(cited('museum')).toHaveCount(0); await expect(cited('dinner')).toBeVisible();
  await page.evaluate(() => { location.hash = '#yours/episodes'; });
  await route.locator('[data-yours-disclosure="Memory exclusions"]>summary').click();
  await expect(route.getByText('Episode: Museum afternoon', { exact: true })).toBeVisible();
  await expect(route.getByText(/^Episode: /u)).toHaveCount(1);
  await page.goto(`${HARNESS_URL}?yours=demo&data=contacts&contact_history=1&occasion_history=1&settle_reads=1#data/contact`);
  await page.locator('[data-recued-data-contact-row]').first().locator('.data-contact-row-button').click();
  const history = page.locator('[data-contact-proactive-history]');
  await history.getByRole('button', { name: 'Hide Museum afternoon', exact: true }).click();
  await expect(history.locator('[data-contact-episode="museum"]')).toHaveCount(0);
  await history.getByRole('link', { name: 'Correct Birthday dinner', exact: true }).click();
  await expect(page.locator('[data-yours-editor]').getByLabel('What happened', { exact: true })).toHaveValue('Birthday dinner');
});

// D-325 §15.7 — "last time" is switched in Settings → Privacy → Learning, which links to
// the people, places and dates it never brings up at the top of Yours → Episodes.
test('Settings → Privacy → Learning turns last time on and off and links to what it never brings up', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_last_time_asked=1&yours_last_time_ready=1#settings/privacy`);
  const panel = page.locator('[data-last-time]'); const state = panel.locator('[data-last-time-state]');
  await expect(state).toHaveText('Recued is asking whether to allow it. Answer in the bell, or here.');
  await expect(panel.getByRole('link', { name: 'People, places and dates it never brings up', exact: true })).toHaveAttribute('href', '#yours/episodes');
  await panel.getByRole('button', { name: 'Allow last time', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(state).toHaveText('On. Your overview may offer flowers.'); await expect(panel.getByRole('status')).toHaveText('Last time is on.');
  await panel.getByRole('button', { name: 'Turn last time off', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(state).toHaveText('Off. Recued does not ask again.');
  await expect(panel.getByRole('button', { name: 'Allow last time', exact: true })).toBeFocused();
  await page.evaluate(() => { location.hash = '#yours/episodes'; });
  const recall = page.locator('[data-recued-yours]');
  await recall.locator('[data-yours-disclosure="Last time in your overview"]>summary').click();
  await expect(recall.getByText('Off. A kind of offer reaches your overview only after at least five scored candidates', { exact: false })).toBeVisible();
  await expect(recall.getByRole('button', { name: 'Allow last time', exact: true })).toBeVisible();
});

for (const width of [390, 1280]) for (const scenario of ['initial-error', 'mismatch', 'outside-focus'] as const) {
  test(`Last time Privacy ${scenario} recovers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(scenario => {
      type Reply = { result?: unknown; error?: { code: string; message: string } };
      const pending: Array<{ kind: 'read' | 'save'; resolve(reply: Reply): void }> = [];
      const controls = {
        reads: 0, writes: [] as Array<'on' | 'off'>,
        release(kind: 'read' | 'save', reply: Reply) {
          const index = pending.findIndex(item => item.kind === kind);
          if (index < 0) throw new Error('No pending Last time fixture reply.');
          pending.splice(index, 1)[0]!.resolve(reply);
        },
      };
      window.__lastTimeRecovery = controls;
      Object.assign(window, { __connectionsFixture: async (method: string, args: unknown) => {
        if (method === 'yours.learning') {
          controls.reads++;
          if (controls.reads === 1) return scenario === 'initial-error'
            ? { error: { code: 'unavailable', message: 'Could not check Last time settings.' } }
            : { result: { last_time: 'on', asked: false, classes: [] } };
          return new Promise<Reply>(resolve => pending.push({ kind: 'read', resolve }));
        }
        const input = args as { action?: string; last_time?: 'on' | 'off' } | undefined;
        if (method === 'yours.change' && input?.action === 'settings.update' && input.last_time) {
          controls.writes.push(input.last_time);
          return new Promise<Reply>(resolve => pending.push({ kind: 'save', resolve }));
        }
        return undefined;
      } });
    }, scenario);
    await page.goto(`${HARNESS_URL}?yours=demo#settings/privacy`);
    const panel = page.locator('[data-last-time]'); const notice = panel.locator('[data-last-time-message]');
    const retry = panel.getByRole('button', { name: 'Retry Last time settings', exact: true });
    const off = panel.getByRole('button', { name: 'Turn last time off', exact: true });
    if (scenario === 'initial-error') {
      await expect(panel.getByRole('heading')).toHaveText('Last time'); await expect(notice).toHaveAttribute('role', 'alert');
      await retry.focus(); await page.keyboard.press('Enter');
      await page.evaluate(() => window.__lastTimeRecovery.release('read', { result: { last_time: 'on', asked: false, classes: [] } }));
      await expect(off).toBeFocused(); await expect(retry).toBeHidden();
      expect(await page.evaluate(() => window.__lastTimeRecovery.writes)).toEqual([]);
      return;
    }
    await off.focus(); await page.keyboard.press('Enter'); await expect(notice).toHaveText('Saving…');
    const outside = page.locator('[data-recued-account-menu-trigger]');
    if (scenario === 'outside-focus') { await outside.focus(); await expect(outside).toBeFocused(); }
    await page.evaluate(() => window.__lastTimeRecovery.release('save', { result: {} }));
    await expect.poll(() => page.evaluate(() => window.__lastTimeRecovery.reads)).toBe(2);
    await page.evaluate(scenario => window.__lastTimeRecovery.release('read', {
      result: { last_time: scenario === 'mismatch' ? 'on' : 'off', asked: false, classes: [] },
    }), scenario);
    if (scenario === 'mismatch') {
      await expect(notice).toHaveAttribute('role', 'alert'); await expect(notice).toContainText('could not be confirmed');
      await expect(panel.locator('[data-last-time-state]')).toContainText('On.'); await expect(off).toBeFocused();
      await retry.focus(); await page.keyboard.press('Enter');
      await page.evaluate(() => window.__lastTimeRecovery.release('read', { result: { last_time: 'off', asked: false, classes: [] } }));
    }
    await expect(notice).toHaveText('Last time is off.');
    if (scenario === 'outside-focus') await expect(outside).toBeFocused();
    else await expect(panel.getByRole('button', { name: 'Allow last time', exact: true })).toBeFocused();
    expect(await page.evaluate(() => window.__lastTimeRecovery.writes)).toEqual(['off']);
  });
}

test('The asset header says when its holder is no longer in your contacts', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_holder_gone=1#yours/asset/passport`);
  await expect(page.locator('[data-recued-yours] [data-yours-holder]')).toHaveText('Held by a contact no longer on file');
});

test('A part shows what it inherits without saving it as its own, and a new asset keeps its class audience', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=parts#yours/asset/boiler`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Edit asset', exact: true }).click();
  let form = page.locator('[data-yours-editor]'); const audience = form.getByLabel('Who sees its reminders', { exact: true });
  await expect(audience).toHaveValue(''); await expect(audience.locator('option:checked')).toHaveText('Same as House (Me and my household)');
  // Shared through the house, with nowhere set up to take it: the form says so and where to fix it.
  const where = form.locator('[data-yours-audience-hint]');
  await expect(where).toHaveText('No household group is set up yet, so its reminders reach only you for now. Set up household reminders');
  await expect(where.getByRole('link', { name: 'Set up household reminders', exact: true })).toHaveAttribute('href', '#settings/notifications');
  await audience.selectOption('owner'); await expect(where).toBeHidden(); await audience.selectOption('');
  await expect(where).toContainText('reach only you for now');
  await expect(form.getByLabel('Exact address', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Exact address', { exact: true })).toHaveAttribute('placeholder', '1 Main Street');
  await expect(form.getByText('Place: Home, from House. Add a place below to give this one its own.', { exact: true })).toBeVisible();
  await expect(form.getByLabel('Place name', { exact: true })).toHaveCount(0);
  await form.getByLabel('Name', { exact: true }).fill('Basement boiler'); await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  // The house changes; the boiler follows, because the save above copied nothing into it.
  await page.evaluate(() => { location.hash = '#yours/asset/house'; });
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click(); form = page.locator('[data-yours-editor]');
  await form.getByLabel('Who sees its reminders', { exact: true }).selectOption('owner'); await form.getByLabel('Exact address', { exact: true }).fill('2 Side Street');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  await page.evaluate(() => { location.hash = '#yours/asset/boiler'; });
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click(); form = page.locator('[data-yours-editor]');
  await expect(form.getByLabel('Who sees its reminders', { exact: true }).locator('option:checked')).toHaveText('Same as House (Only me)');
  await expect(form.getByLabel('Exact address', { exact: true })).toHaveAttribute('placeholder', '2 Side Street');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(form).toHaveCount(0);
  // A new asset leaves its audience to the class unless the owner picks one.
  await page.evaluate(() => { location.hash = '#yours/assets'; });
  await route.getByRole('button', { name: 'Create asset', exact: true }).click(); form = page.locator('[data-yours-editor]');
  await form.getByLabel('Name', { exact: true }).fill('Garage boiler'); await form.getByLabel('Type (optional)', { exact: true }).selectOption('boiler');
  await form.getByText('More details (optional)', { exact: true }).click();
  await expect(form.getByLabel('Passport nationality (optional)', { exact: true })).not.toBeVisible();
  await expect(form.getByLabel('Who sees its reminders', { exact: true }).locator('option:checked')).toHaveText('Class default (Me and my household)');
  // The class's default counts as shared, so the new asset says where its reminders go too.
  await expect(form.locator('[data-yours-audience-hint]')).toContainText('reach only you for now');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  await page.evaluate(() => { location.hash = '#yours/asset/new-1'; });
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click();
  await expect(page.locator('[data-yours-editor]').getByLabel('Who sees its reminders', { exact: true })).toHaveValue('household');
});

test('An asset shared with the household says which group its reminders go to', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=parts&household=group#yours/asset/boiler`);
  const route = page.locator('[data-recued-yours]');
  await expect(route.getByText('Boiler · Active · Shared with your household (same as House)', { exact: true })).toBeVisible();
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click();
  let form = page.locator('[data-yours-editor]'); const where = form.locator('[data-yours-audience-hint]');
  await expect(where).toHaveText('Its reminders also go to Family on Telegram.');
  // Its own "Only me" says nothing; going back to the house's sharing reads the house, not "only me".
  await form.getByLabel('Who sees its reminders', { exact: true }).selectOption('owner');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  await expect(route.getByText('Boiler · Active · Only you', { exact: true })).toBeVisible();
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click(); form = page.locator('[data-yours-editor]');
  await expect(form.locator('[data-yours-audience-hint]')).toBeHidden();
  await form.getByLabel('Who sees its reminders', { exact: true }).selectOption('');
  await expect(form.locator('[data-yours-audience-hint]')).toHaveText('Its reminders also go to Family on Telegram.');
});

test('A visa keeps the country it is for, in its own field, which a passport does not show', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/assets`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Create asset', exact: true }).click();
  let form = page.locator('[data-yours-editor]'); const visaFor = form.getByLabel('Visa valid for', { exact: true });
  await form.getByLabel('Name', { exact: true }).fill('Ana’s Japan visa'); await form.getByLabel('Type (optional)', { exact: true }).selectOption('visa');
  await form.getByLabel('Holder', { exact: true }).selectOption('ana'); await form.getByText('More details (optional)', { exact: true }).click();
  await expect(visaFor).toBeVisible();
  await expect(form.getByLabel('Passport nationality (optional)', { exact: true })).not.toBeVisible();
  // A name is not a code: the form says what it wants rather than saving "JA".
  await visaFor.fill('Ja'); await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(1); await expect(visaFor).toHaveValue('Ja');
  await visaFor.fill('jp'); await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  await page.evaluate(() => { location.hash = '#yours/asset/new-1'; });
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click(); form = page.locator('[data-yours-editor]');
  await expect(form.getByLabel('Visa valid for', { exact: true })).toHaveValue('Japan');
  // Not among the free settings rows, where a second copy could disagree with it.
  expect(await form.getByLabel('Settings field name', { exact: true }).evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).not.toContain('valid_for');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { location.hash = '#yours/asset/passport'; });
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click();
  await expect(page.locator('[data-yours-editor]').getByLabel('Visa valid for', { exact: true })).not.toBeVisible();
});

test('A passport keeps a nationality only as a country code, as a visa keeps its country', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Edit asset', exact: true }).click();
  let form = page.locator('[data-yours-editor]');
  const nationality = form.getByLabel('Passport nationality (optional)', { exact: true });
  // Two letters that name no country would reach the trip check and an AI as a nationality.
  await nationality.fill('Ja'); await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(route.getByRole('alert')).toHaveText('Choose a country from the suggestions, or enter a valid two-letter country code.');
  await expect(form).toHaveCount(1); await expect(nationality).toHaveValue('Ja');
  await nationality.fill('cn'); await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click(); form = page.locator('[data-yours-editor]');
  await expect(form.getByLabel('Passport nationality (optional)', { exact: true })).toHaveValue('China');
});

test('A visa can be tied to a passport, chosen among passports only, and says what tying does', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/assets`);
  const route = page.locator('[data-recued-yours]');
  // Something to search past: a boiler of Ana's is not a passport.
  await route.getByRole('button', { name: 'Create asset', exact: true }).click(); let form = page.locator('[data-yours-editor]');
  await form.getByLabel('Name', { exact: true }).fill('Ana’s boiler'); await form.getByLabel('Type (optional)', { exact: true }).selectOption('boiler');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  await page.evaluate(() => { location.hash = '#yours/assets'; });
  await route.getByRole('button', { name: 'Create asset', exact: true }).click(); form = page.locator('[data-yours-editor]');
  await form.getByLabel('Name', { exact: true }).fill('Ana’s Japan visa'); await form.getByLabel('Type (optional)', { exact: true }).selectOption('visa');
  await form.getByLabel('Holder', { exact: true }).selectOption('ana'); await form.getByText('More details (optional)', { exact: true }).click();
  await expect(form.getByText('Retiring that passport then retires the visa too. A trip check lists the traveller’s visas either way.', { exact: false })).toBeVisible();
  const picker = form.getByRole('combobox', { name: 'Tied to passport', exact: true });
  await picker.fill('Ana'); await expect(form.getByRole('option', { name: /Ana’s passport/ })).toBeVisible();
  await expect(form.getByRole('option', { name: /Ana’s boiler/ })).toHaveCount(0);
  await form.getByRole('option', { name: /Ana’s passport/ }).click();
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  await page.evaluate(() => { location.hash = '#yours/asset/new-2'; });
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click(); form = page.locator('[data-yours-editor]');
  await expect(form.getByRole('combobox', { name: 'Tied to passport', exact: true })).toHaveValue('Ana’s passport');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  // A parent that is no passport is the owner's own choice: the empty picker leaves it be.
  await route.getByRole('button', { name: 'Change parent', exact: true }).click();
  const parent = route.getByRole('combobox', { name: 'Parent asset', exact: true });
  await parent.fill('boiler'); await route.getByRole('option', { name: /Ana’s boiler/ }).click();
  await route.getByRole('button', { name: 'Save parent', exact: true }).click();
  await expect(route.getByRole('link', { name: 'Belongs to Ana’s boiler', exact: true })).toBeVisible();
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click(); form = page.locator('[data-yours-editor]');
  await expect(form.getByRole('combobox', { name: 'Tied to passport', exact: true })).toHaveValue('');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  await expect(route.getByRole('link', { name: 'Belongs to Ana’s boiler', exact: true })).toBeVisible();
});

test('Asset details save typed preferences, anchors and dated value history', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await page.goto(`${HARNESS_URL}?yours=demo#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Edit asset', exact: true }).click();
  let form = page.locator('[data-yours-editor]'); await form.getByRole('button', { name: 'Add setting', exact: true }).click();
  await form.getByLabel('Settings field name', { exact: true }).fill('preferred_notice_days'); await form.getByLabel('Settings value type', { exact: true }).selectOption('Number'); await form.getByLabel('Settings value', { exact: true }).fill('21');
  await form.getByRole('button', { name: 'Add attribute', exact: true }).click(); await form.getByLabel('Attributes field name', { exact: true }).fill('cover'); await form.getByLabel('Attributes value', { exact: true }).fill('Blue');
  await form.getByRole('button', { name: 'Add place', exact: true }).click(); await form.getByLabel('Place name', { exact: true }).fill('Home'); await form.getByLabel('Latitude', { exact: true }).fill('37.78'); await form.getByLabel('Longitude', { exact: true }).fill('-122.41');
  await form.getByRole('button', { name: 'Add value', exact: true }).click(); await form.getByLabel('Amount', { exact: true }).fill('85.50'); await form.getByLabel('Currency', { exact: true }).fill('USD'); await form.getByLabel('Valued on', { exact: true }).fill('2026-10-10');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click(); form = page.locator('[data-yours-editor]');
  await expect(form.getByLabel('Settings value type', { exact: true })).toHaveValue('Number'); await expect(form.getByLabel('Settings value', { exact: true })).toHaveValue('21');
  await expect(form.getByLabel('Latitude', { exact: true })).toHaveValue('37.78'); await expect(form.getByLabel('Amount', { exact: true })).toHaveValue('85.50'); await expect(form.getByLabel('Valued on', { exact: true })).toHaveValue('2026-10-10');
});

test.describe('Asset fact row focus', () => {
  const kinds = [
    { kind: 'setting', add: 'Add setting', field: 'Settings field name', remove: 'Remove setting' },
    { kind: 'attribute', add: 'Add attribute', field: 'Attributes field name', remove: 'Remove attribute' },
    { kind: 'place', add: 'Add place', field: 'Place name', remove: 'Remove anchor' },
    { kind: 'identifier', add: 'Add identifier', field: 'Identifier scheme', remove: 'Remove anchor' },
    { kind: 'instrument', add: 'Add instrument', field: 'Instrument identifier', remove: 'Remove anchor' },
    { kind: 'valuation', add: 'Add value', field: 'Amount', remove: 'Remove value' },
  ] as const;
  const open = async (page: Page, width: number, create = false) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HARNESS_URL}?yours=demo#yours/${create ? 'new' : 'asset/passport'}`);
    if (!create) await page.locator('[data-recued-yours]').getByRole('button', { name: 'Edit asset', exact: true }).click();
    const form = page.locator('[data-yours-editor]');
    await form.getByLabel('Name', { exact: true }).fill('Preserved passport draft');
    if (create) await form.locator('[data-yours-asset-more] > summary').click();
    return form;
  };
  const activate = async (control: Locator, page: Page) => { await control.focus(); await page.keyboard.press('Enter'); };
  const remove = (field: Locator, name: string) => field.locator('xpath=ancestor::article[1]').getByRole('button', { name, exact: true });

  for (const width of [390, 1280]) {
    for (const item of kinds) {
      test(`keyboard ${item.kind} rows keep focus through add, middle removal and last removal at ${width}px`, async ({ page }) => {
        const form = await open(page, width); const add = form.getByRole('button', { name: item.add, exact: true });
        const fields = form.getByLabel(item.field, { exact: true }); await expect(fields).toHaveCount(0);
        const texts = item.kind === 'valuation' ? ['85.50', '90.00', '105.25'] : ['first_fact', 'second_fact', 'third_fact'];
        for (const [index, text] of texts.entries()) {
          await activate(add, page); await expect(fields).toHaveCount(index + 1);
          await expect(fields.nth(index)).toBeFocused(); await expect(fields.nth(index)).toBeInViewport();
          await page.keyboard.type(text); await expect(fields.nth(index)).toHaveValue(text);
        }
        // Prefer the next row, then the previous row, then this kind's Add.
        await activate(remove(fields.nth(1), item.remove), page); await expect(fields).toHaveCount(2);
        await expect(fields.nth(1)).toBeFocused(); await expect(fields.nth(1)).toHaveValue(texts[2]!);
        await activate(remove(fields.nth(1), item.remove), page); await expect(fields).toHaveCount(1);
        await expect(fields.first()).toBeFocused(); await expect(fields.first()).toHaveValue(texts[0]!);
        await activate(remove(fields.first(), item.remove), page); await expect(fields).toHaveCount(0); await expect(add).toBeFocused();
        await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Preserved passport draft'); expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
        await activate(form.getByRole('button', { name: 'Save', exact: true }), page); await expect(form).toHaveCount(0);
        expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([expect.objectContaining({ action: 'asset.update', patch: { name: 'Preserved passport draft' } })]);
      });

      test(`pointer ${item.kind} rows focus the new field and the matching Add after removal at ${width}px`, async ({ page }) => {
        const form = await open(page, width); const add = form.getByRole('button', { name: item.add, exact: true });
        await add.click(); const field = form.getByLabel(item.field, { exact: true });
        await expect(field).toBeFocused(); await expect(field).toBeInViewport();
        await remove(field, item.remove).click(); await expect(field).toHaveCount(0); await expect(add).toBeFocused();
        await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Preserved passport draft');
      });
    }

    test(`scripted fact actions respect another field's focus and selection at ${width}px`, async ({ page }) => {
      const form = await open(page, width); const name = form.getByLabel('Name', { exact: true });
      await name.focus(); await name.evaluate(input => (input as HTMLInputElement).setSelectionRange(2, 7));
      for (const item of kinds) {
        await form.getByRole('button', { name: item.add, exact: true }).evaluate(button => (button as HTMLButtonElement).click());
        await expect(name).toBeFocused(); const field = form.getByLabel(item.field, { exact: true }); await expect(field).toHaveCount(1);
        await remove(field, item.remove).evaluate(button => (button as HTMLButtonElement).click()); await expect(name).toBeFocused();
        expect(await name.evaluate(input => [(input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd])).toEqual([2, 7]);
      }
      expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
    });

    test(`new asset optional facts keep their keyboard place and the main draft at ${width}px`, async ({ page }) => {
      const form = await open(page, width, true);
      for (const item of kinds) {
        const add = form.getByRole('button', { name: item.add, exact: true }); await activate(add, page);
        const field = form.getByLabel(item.field, { exact: true }); await expect(field).toBeFocused(); await expect(field).toBeInViewport();
        await activate(remove(field, item.remove), page); await expect(add).toBeFocused();
      }
      const more = form.locator('[data-yours-asset-more]'); await more.locator('summary').click(); await expect(more).not.toHaveAttribute('open');
      await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Preserved passport draft');
      expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
    });
  }

  test('mixed anchor rows return focus to a neighboring kind before their own Add', async ({ page }) => {
    const form = await open(page, 390);
    for (const title of ['Add place', 'Add identifier', 'Add instrument']) await activate(form.getByRole('button', { name: title, exact: true }), page);
    await activate(remove(form.getByLabel('Identifier scheme', { exact: true }), 'Remove anchor'), page);
    await expect(form.getByLabel('Instrument identifier', { exact: true })).toBeFocused();
    await activate(remove(form.getByLabel('Instrument identifier', { exact: true }), 'Remove anchor'), page);
    await expect(form.getByLabel('Place name', { exact: true })).toBeFocused();
    await activate(remove(form.getByLabel('Place name', { exact: true }), 'Remove anchor'), page);
    await expect(form.getByRole('button', { name: 'Add place', exact: true })).toBeFocused();
  });
});

test('Due says each task’s deadline in words, and a renewal asks for its new date instead of closing on Done', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/occurrences`);
  const route = page.locator('[data-recued-yours]');
  // The tab reads "Due" at its old address, and a task says when it is due, not its stored values.
  await expect(page.getByRole('navigation', { name: 'Yours', exact: true }).getByRole('link', { name: 'Due', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(route.getByRole('heading', { name: 'Due', exact: true })).toBeVisible();
  await expect(route.getByText('Due Apr 17, 2027', { exact: true })).toBeVisible();
  // §15.7 (2026-10-24) — a passport's renewal is done by its new date: Done alone kept the old one.
  const date = route.getByLabel('New expiry date', { exact: true });
  await expect(date).toHaveAttribute('min', '2027-04-18');
  await route.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(route.locator('[data-yours-error]')).toHaveText('Enter a date after 2027-04-17');
  await date.fill('2037-04-17');
  await route.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(route.getByRole('heading', { name: 'Renew · Ana’s passport' })).toHaveCount(0);
  expect(await page.evaluate(() => window.__occurrenceRenewals)).toEqual([
    { action: 'occurrence.renewed', id: 'passport-occurrence', on: '' }, { action: 'occurrence.renewed', id: 'passport-occurrence', on: '2037-04-17' }]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('work_entity.commitment.fulfill'))).toBe(0);
});

test('a receipt proposal becomes an asset only after acceptance and leaves the waiting lane', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/proposals`);
  const route = page.locator('[data-recued-yours]'); const card = route.locator('article').filter({ has: page.getByRole('heading', { name: 'LG television', exact: true }) });
  await expect(card).toContainText('high confidence'); await card.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(route.getByText('No proposals waiting.', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Yours', exact: true }).getByRole('link', { name: 'Assets', exact: true }).click();
  await expect(route.getByRole('heading', { name: 'LG television', exact: true })).toBeVisible();
});

test('sphere chips on assets, occurrences, occasions and episodes can be changed, reset and filtered', async ({ page }) => {
  for (const [tab, title] of [['assets', 'Ana’s passport'], ['occurrences', 'Renew · Ana’s passport'], ['occasions', 'Ana birthday'], ['episodes', 'Museum afternoon']]) {
    await page.goto(`${HARNESS_URL}?yours=demo&contact_history=1#yours/${tab}`);
    const route = page.locator('[data-recued-yours]'); const card = route.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).first();
    const chip = card.locator('[data-yours-sphere]').first(); await chip.locator('summary').click();
    await chip.getByLabel('This record’s sphere', { exact: true }).selectOption('professional');
    await chip.getByRole('button', { name: 'Change', exact: true }).click(); await expect(chip.locator('summary')).toContainText('Work · placed by you');
    await chip.locator('summary').click(); await chip.getByRole('button', { name: 'Reset', exact: true }).click(); await expect(chip.locator('summary')).toContainText('Unsorted');
    const filterLabel = tab === 'assets' ? 'Asset sphere' : 'Sphere on this page';
    if (tab === 'assets') await showAssetFilters(route);
    await route.getByLabel(filterLabel, { exact: true }).selectOption('professional'); await expect(card).not.toBeVisible();
    if (tab === 'assets') await showAssetFilters(route);
    await route.getByLabel(filterLabel, { exact: true }).selectOption('unsorted'); await expect(card).toBeVisible();
  }
});

test('Today shows Coming up and attached situation values, and Done on a renewal only acknowledges it', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#today`);
  const today = page.locator('[data-today-view]'); const coming = today.locator('[data-today-group="coming_up"]');
  await expect(coming.getByRole('link', { name: 'Renew · Ana’s passport', exact: true })).toHaveAttribute('href', '#yours/asset/passport');
  const cluster = today.locator('[data-today-cluster="lisbon-trip"]');
  // §6.2 in words: why it is here, how it misses the trip, and whom it names.
  const passport = cluster.locator('li').filter({ hasText: 'Passport expiry' });
  await expect(passport.locator('[data-today-reasons]')).toHaveText('Connected to this · From your records');
  await expect(passport.locator('dd[data-today-verdict="outside"]')).toContainText('well after this');
  await expect(passport.locator('dd')).toHaveText([/well after this$/u, 'Not recorded', 'Ana Lima']);
  await expect(today.locator('[data-today-proposals]')).toContainText('LG television');
  await expect(today.locator('[data-today-unmatched]')).toContainText('Unmatched replies');
  await expect(today.getByRole('link', { name: 'Connect a phone channel' })).toHaveAttribute('href', '#connections');
  await coming.getByRole('button', { name: 'Done: Renew · Ana’s passport', exact: true }).click();
  // §15.7 (2026-10-24) — a press does not renew a passport: Done acknowledges its reminder, and
  // the task stays open until its new date is entered.
  await expect(today.locator('[data-today-task-notice]')).toHaveText(
    'Noted. It stays open until its new date is entered under Yours → Due, and Today shows it again at its next reminder.');
  await expect(coming.getByRole('link', { name: 'Renew · Ana’s passport', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__occurrenceRenewals)).toEqual([{ action: 'occurrence.acknowledge', id: 'passport-occurrence' }]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('work_entity.commitment.fulfill'))).toBe(0);
});

// D-325 Option A — a bill on Today links to its own facts, and opening it from Today tells the
// server, which counts it as acting on its kind. The Data page's own report carries no `from`.
test('Today links a bill to its own facts and reports opening it from Today', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?today_bill=1#today`);
  // Alone in its cluster, the bill is the row's own link and the cluster's item.
  const links = page.locator('[data-today-view]').getByRole('link', { name: 'Bill: Acme Power', exact: true });
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', '#data/mail_fact/thing/mthing_bill');
  await links.first().click();
  await expect(page).toHaveURL(/#data\/mail_fact\/thing\/mthing_bill$/u);
  await expect.poll(() => page.evaluate(() => window.__navigationOpens.filter(row => row.action === 'navigation.open' && row.from === 'today')))
    .toEqual([{ action: 'navigation.open', ref: { collection: 'mail_fact', id: 'mthing_bill' }, from: 'today' }]);
});

const overviewPanel = (page: Page) => page.locator('[data-situation-delivery]');
const overviewTime = (page: Page) => overviewPanel(page).getByLabel('Time', { exact: true });
const overviewDraftPrompt = 'Discard the unsaved digest settings?';
const overviewWorkPrompt = 'A digest action is still in progress. Leave Settings anyway?';
const openOverviewSettings = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${HARNESS_URL}?yours=demo&notifications=ready#settings/notifications`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(overviewTime(page)).toHaveValue('08:00');
};
const overviewWouldBlockUnload = (page: Page) => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});
const leaveOverviewSettings = (page: Page) => page.evaluate(() => window.__app.setHash('#yours/assets'));
const overviewTimezoneLink = (page: Page) => overviewPanel(page).getByRole('link', { name: 'server timezone', exact: true });
const openOverviewTimezone = async (page: Page, width: number) => {
  await page.addInitScript(() => {
    Object.assign(window, { __connectionsFixture: async (method: string) => {
      if (method === 'server.timezone.get') return { result: {
        setting: { mode: 'fixed', zone: 'Europe/London', updated_at: 1 },
        resolved_zone: 'Europe/London', host_zone: 'Europe/London',
      } };
      return undefined;
    } });
  });
  await openOverviewSettings(page, width);
};
const expectOverviewTimezone = async (page: Page) => {
  await expect(page).toHaveURL(/#settings\/server\/timezone$/u);
  await expect(page.getByRole('tab', { name: 'Timezone', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-recued-server-timezone-panel]')).toBeVisible();
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.timezone.set'))).toBe(0);
};

for (const width of [390, 1280]) {
  test(`Coming up timezone link opens Timezone and preserves Back and Forward at ${width}px`, async ({ page }) => {
    await openOverviewTimezone(page, width);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await overviewTimezoneLink(page).press('Enter'); await expectOverviewTimezone(page);
    await page.goBack(); await expect(page).toHaveURL(/#settings\/notifications$/u); await expect(overviewTime(page)).toHaveValue('08:00');
    await page.goForward(); await expectOverviewTimezone(page);
    expect(dialogs).toEqual([]); expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
  });

  test(`Coming up timezone link keeps edited times and focus through repeated cancellation at ${width}px`, async ({ page }) => {
    await openOverviewTimezone(page, width); await overviewTime(page).fill('10:30'); const original = await overviewTime(page).elementHandle();
    const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await overviewTimezoneLink(page).press('Enter'); await expect.poll(() => dialogs).toHaveLength(attempt);
      await expect(page).toHaveURL(/#settings\/notifications$/u); await expect(overviewTime(page)).toHaveValue('10:30');
      await expect(overviewTimezoneLink(page)).toBeFocused(); expect(await original!.evaluate(input => input.isConnected)).toBe(true);
      expect(await overviewWouldBlockUnload(page)).toBe(true);
    }
    accept = true; await overviewTimezoneLink(page).press('Enter'); await expectOverviewTimezone(page);
    await page.goBack(); await expect(overviewTime(page)).toHaveValue('08:00');
    await page.goForward(); await expectOverviewTimezone(page);
    expect(dialogs).toEqual([overviewDraftPrompt, overviewDraftPrompt, overviewDraftPrompt]);
    expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
  });

  test(`Coming up timezone link retains an incomplete native minute after cancellation at ${width}px`, async ({ page }) => {
    await openOverviewTimezone(page, width); const field = overviewTime(page); await field.fill('09:30');
    const selectMinute = async () => {
      await field.focus(); for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight');
    };
    await selectMinute(); await page.keyboard.press('Backspace'); const original = await field.elementHandle();
    const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    await overviewTimezoneLink(page).press('Enter'); await expect.poll(() => dialogs).toEqual([overviewDraftPrompt]);
    await expect(page).toHaveURL(/#settings\/notifications$/u); await expect(overviewTimezoneLink(page)).toBeFocused();
    expect(await field.evaluate((input: HTMLInputElement) => input.validity.badInput && input.value === '')).toBe(true);
    expect(await original!.evaluate(input => input.isConnected)).toBe(true);
    await selectMinute(); await page.keyboard.type('45'); await expect(field).toHaveValue('09:45');
    accept = true; await overviewTimezoneLink(page).press('Enter'); await expectOverviewTimezone(page);
    expect(dialogs).toEqual([overviewDraftPrompt, overviewDraftPrompt]);
    expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
  });

  test(`Coming up timezone link leaves a fully restored schedule without a warning at ${width}px`, async ({ page }) => {
    await openOverviewTimezone(page, width); await overviewTime(page).fill('10:30'); await overviewTime(page).fill('08:00');
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    expect(await overviewWouldBlockUnload(page)).toBe(false); await overviewTimezoneLink(page).press('Enter'); await expectOverviewTimezone(page);
    expect(dialogs).toEqual([]); expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
  });

  for (const kind of ['save', 'send'] as const) {
    for (const phase of ['write', 'confirmation'] as const) {
      test(`Coming up timezone link ignores a late ${kind} ${phase} reply after accepted navigation at ${width}px`, async ({ page }) => {
        await openOverviewTimezone(page, width); if (kind === 'save') await overviewTime(page).fill('10:30');
        await page.evaluate(() => window.__app.holdRpcResponses?.('yours.change'));
        if (phase === 'confirmation') await page.evaluate(() => window.__app.holdRpcResponses?.('yours.delivery'));
        const beforeReads = await page.evaluate(() => window.__app.rpcCallCount('yours.delivery'));
        await overviewPanel(page).getByRole('button', { name: kind === 'save' ? 'Save digest settings' : 'Send now', exact: true }).press('Enter');
        await expect(overviewTime(page)).toBeDisabled(); const original = await overviewTime(page).elementHandle();
        if (phase === 'confirmation') {
          expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.change'))).toBe(1);
          await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.delivery'))).toBe(beforeReads + 1);
        }
        const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
        await overviewTimezoneLink(page).press('Enter'); await expectOverviewTimezone(page); expect(dialogs).toEqual([overviewWorkPrompt]);
        expect(await original!.evaluate(input => input.isConnected)).toBe(false);
        if (phase === 'confirmation') {
          await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.delivery'))).toBe(beforeReads + 2);
          expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.delivery', 1))).toBe(1);
        }
        const zone = page.getByLabel('Server timezone', { exact: true }); await zone.fill('Asia/Tokyo'); await zone.focus();
        const fresh = await zone.elementHandle(), reads = await page.evaluate(() => window.__app.rpcCallCount('yours.delivery'));
        expect(await page.evaluate(method => window.__app.releaseRpcResponses?.(method), phase === 'write' ? 'yours.change' : 'yours.delivery')).toBe(1);
        await expectOverviewTimezone(page); await expect(zone).toHaveValue('Asia/Tokyo'); await expect(zone).toBeFocused();
        expect(await fresh!.evaluate(input => input.isConnected && input === document.activeElement)).toBe(true);
        expect(await page.evaluate(() => window.__app.rpcCallCount('yours.delivery'))).toBe(reads);
        expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(1); expect(dialogs).toEqual([overviewWorkPrompt]);
      });
    }

    test(`Coming up timezone link guards a pending ${kind} and its confirmation read at ${width}px`, async ({ page }) => {
      await openOverviewTimezone(page, width); if (kind === 'save') await overviewTime(page).fill('10:30');
      await page.evaluate(() => { window.__app.holdRpcResponses?.('yours.change'); window.__app.holdRpcResponses?.('yours.delivery'); });
      const beforeReads = await page.evaluate(() => window.__app.rpcCallCount('yours.delivery'));
      await overviewPanel(page).getByRole('button', { name: kind === 'save' ? 'Save digest settings' : 'Send now', exact: true }).press('Enter');
      const original = await overviewTime(page).elementHandle();
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      for (const phase of ['write', 'confirmation'] as const) {
        await expect(overviewTime(page)).toBeDisabled(); await overviewTimezoneLink(page).press('Enter');
        await expect.poll(() => dialogs).toHaveLength(phase === 'write' ? 1 : 2); await expect(page).toHaveURL(/#settings\/notifications$/u);
        await expect(overviewTimezoneLink(page)).toBeFocused(); expect(await original!.evaluate(input => input.isConnected)).toBe(true);
        if (phase === 'write') {
          expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.change'))).toBe(1);
          await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.delivery'))).toBe(beforeReads + 1);
        }
      }
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.delivery'))).toBe(1);
      await expect(overviewPanel(page).getByRole('status')).toContainText(kind === 'save' ? 'Digest settings saved.' : 'Checked.');
      expect(await overviewWouldBlockUnload(page)).toBe(false); await overviewTimezoneLink(page).press('Enter'); await expectOverviewTimezone(page);
      expect(dialogs).toEqual([overviewWorkPrompt, overviewWorkPrompt]);
      expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(1);
    });
  }

  for (const field of ['How often', 'Day', 'Time', 'Also send a note on the day something is due'] as const) {
    test(`Coming up reverted ${field} leaves without an unsaved warning at ${width}px`, async ({ page }) => {
      await openOverviewSettings(page, width); const control = overviewPanel(page).getByLabel(field, { exact: true });
      const original = await control.elementHandle();
      if (field === 'How often') await control.selectOption('daily');
      else if (field === 'Day') await control.selectOption('4');
      else if (field === 'Time') await control.fill('10:30');
      else await control.uncheck();
      expect(await overviewWouldBlockUnload(page)).toBe(true);
      if (field === 'How often') await control.selectOption('weekly');
      else if (field === 'Day') await control.selectOption('1');
      else if (field === 'Time') await control.fill('08:00');
      else await control.check();
      expect(await overviewWouldBlockUnload(page)).toBe(false);
      expect(await original!.evaluate(node => node.isConnected)).toBe(true);
      expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await leaveOverviewSettings(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([]);
    });
  }

  test(`Coming up partial reverts stay guarded until the whole schedule is restored at ${width}px`, async ({ page }) => {
    await openOverviewSettings(page, width); const panel = overviewPanel(page);
    await panel.getByLabel('Day', { exact: true }).selectOption('4');
    await panel.getByLabel('How often', { exact: true }).selectOption('daily');
    await overviewTime(page).fill('10:30'); await panel.getByLabel('Also send a note on the day something is due', { exact: true }).uncheck();
    await panel.getByLabel('How often', { exact: true }).selectOption('weekly');
    await panel.getByLabel('Day', { exact: true }).selectOption('1'); await overviewTime(page).fill('08:00');
    expect(await overviewWouldBlockUnload(page)).toBe(true);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await leaveOverviewSettings(page); await expect.poll(() => dialogs).toEqual([overviewDraftPrompt]);
    await expect(page).toHaveURL(/#settings\/notifications$/u);
    await expect(panel.getByLabel('Also send a note on the day something is due', { exact: true })).not.toBeChecked();
    await panel.getByLabel('Also send a note on the day something is due', { exact: true }).check(); expect(await overviewWouldBlockUnload(page)).toBe(false);
    expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); await expect(overviewTime(page)).toHaveValue('08:00');
    expect(dialogs).toEqual([overviewDraftPrompt]); expect(await overviewWouldBlockUnload(page)).toBe(false);
    await leaveOverviewSettings(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([overviewDraftPrompt]);
  });

  for (const [segment, index, originalValue] of [['hour', 0, '08'], ['minute', 1, '00']] as const) {
    test(`Coming up reverts keep an incomplete ${segment} guarded until its saved value is restored at ${width}px`, async ({ page }) => {
      await openOverviewSettings(page, width); const field = overviewTime(page);
      const selectSegment = async () => {
        await field.focus(); for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft');
        for (let step = 0; step < index; step++) await page.keyboard.press('ArrowRight');
      };
      await selectSegment(); await page.keyboard.press('Backspace'); const original = await field.elementHandle();
      const frequency = overviewPanel(page).getByLabel('How often', { exact: true });
      await frequency.selectOption('daily'); await frequency.selectOption('weekly');
      expect(await field.evaluate((input: HTMLInputElement) => input.validity.badInput && input.value === '')).toBe(true);
      expect(await overviewWouldBlockUnload(page)).toBe(true);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await leaveOverviewSettings(page); await expect.poll(() => dialogs).toEqual([overviewDraftPrompt]);
      await expect(page).toHaveURL(/#settings\/notifications$/u); expect(await original!.evaluate(node => node.isConnected)).toBe(true);
      await selectSegment(); await page.keyboard.type(originalValue); await expect(field).toHaveValue('08:00');
      expect(await overviewWouldBlockUnload(page)).toBe(false);
      expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
      await leaveOverviewSettings(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([overviewDraftPrompt]);
    });
  }

  test(`Coming up navigation protects a draft through cancelled and accepted native reloads at ${width}px`, async ({ page }) => {
    await openOverviewSettings(page, width); const field = overviewTime(page);
    await field.fill('10:30'); const original = await field.elementHandle();
    const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.type()); void (accept ? dialog.accept() : dialog.dismiss()); });
    await page.evaluate(() => { window.location.reload(); });
    await expect.poll(() => dialogs).toEqual(['beforeunload']);
    await expect(field).toHaveValue('10:30');
    expect(await original!.evaluate(node => node.isConnected && node === document.querySelector('[data-situation-delivery] input[name="time"]'))).toBe(true);
    accept = true; await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await expect(field).toHaveValue('08:00'); expect(dialogs).toEqual(['beforeunload', 'beforeunload']);
  });

  test(`Coming up navigation preserves Back history through repeated cancellation at ${width}px`, async ({ page }) => {
    await openOverviewSettings(page, width);
    await leaveOverviewSettings(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#settings/notifications')); await expect(overviewTime(page)).toHaveValue('08:00');
    await overviewTime(page).fill('10:30'); const original = await overviewTime(page).elementHandle();
    const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.goBack(); await expect.poll(() => dialogs).toHaveLength(attempt);
      await expect(page).toHaveURL(/#settings\/notifications$/u); await expect(overviewTime(page)).toHaveValue('10:30');
      expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    }
    accept = true; await page.goBack(); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    expect(dialogs).toEqual([overviewDraftPrompt, overviewDraftPrompt, overviewDraftPrompt]);
    await page.goForward(); await expect(page).toHaveURL(/#settings\/notifications$/u);
    await expect(overviewTime(page)).toHaveValue('08:00');
  });

  test(`Coming up navigation still protects edits after Send now succeeds at ${width}px`, async ({ page }) => {
    await openOverviewSettings(page, width); const field = overviewTime(page);
    await field.fill('10:30'); const original = await field.elementHandle();
    await overviewPanel(page).getByRole('button', { name: 'Send now', exact: true }).press('Enter');
    await expect(overviewPanel(page).getByRole('status')).toContainText('Checked.');
    await expect(field).toHaveValue('10:30');
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await leaveOverviewSettings(page); await expect.poll(() => dialogs).toEqual([overviewDraftPrompt]);
    await expect(page).toHaveURL(/#settings\/notifications$/u);
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    await overviewPanel(page).getByRole('button', { name: 'Save digest settings', exact: true }).press('Enter');
    await expect(overviewPanel(page).getByRole('status')).toHaveText('Digest settings saved.');
    await leaveOverviewSettings(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    expect(dialogs).toEqual([overviewDraftPrompt]);
  });

  test(`Coming up navigation keeps an unsaved schedule when leaving is declined at ${width}px`, async ({ page }) => {
    await openOverviewSettings(page, width);
    const panel = overviewPanel(page), field = overviewTime(page);
    await panel.getByLabel('Day', { exact: true }).selectOption('4');
    await panel.getByLabel('How often', { exact: true }).selectOption('daily');
    await panel.getByLabel('Also send a note on the day something is due', { exact: true }).uncheck();
    await field.fill('10:30'); await field.focus(); const original = await field.elementHandle();
    const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    expect(await overviewWouldBlockUnload(page)).toBe(true);
    await leaveOverviewSettings(page); await expect.poll(() => dialogs).toEqual([overviewDraftPrompt]);
    await expect(page).toHaveURL(/#settings\/notifications$/u); await expect(field).toBeFocused();
    await expect(field).toHaveValue('10:30');
    await expect(panel.getByLabel('How often', { exact: true })).toHaveValue('daily');
    await expect(panel.getByLabel('Day', { exact: true })).toHaveValue('4');
    await expect(panel.getByLabel('Also send a note on the day something is due', { exact: true })).not.toBeChecked();
    expect(await original!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    accept = true; await leaveOverviewSettings(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    expect(dialogs).toEqual([overviewDraftPrompt, overviewDraftPrompt]);
    await page.evaluate(() => window.__app.setHash('#settings/notifications')); await expect(field).toHaveValue('08:00');
  });

  test(`Coming up navigation allows untouched and confirmed schedules without a prompt at ${width}px`, async ({ page }) => {
    await openOverviewSettings(page, width);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    expect(await overviewWouldBlockUnload(page)).toBe(false);
    await leaveOverviewSettings(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#settings/notifications')); await expect(overviewTime(page)).toHaveValue('08:00');
    await overviewTime(page).fill('10:30');
    await overviewPanel(page).getByRole('button', { name: 'Save digest settings', exact: true }).press('Enter');
    await expect(overviewPanel(page).getByRole('status')).toHaveText('Digest settings saved.');
    expect(await overviewWouldBlockUnload(page)).toBe(false);
    await leaveOverviewSettings(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    expect(dialogs).toEqual([]);
  });

  for (const kind of ['save', 'send'] as const) {
    test(`Coming up navigation guards a pending ${kind} through its confirmation read at ${width}px`, async ({ page }) => {
      await openOverviewSettings(page, width);
      if (kind === 'save') await overviewTime(page).fill('10:30');
      await page.evaluate(() => { window.__app.holdRpcResponses?.('yours.change'); window.__app.holdRpcResponses?.('yours.delivery'); });
      const before = await page.evaluate(() => ({ writes: window.__app.rpcCallCount('yours.change'), reads: window.__app.rpcCallCount('yours.delivery') }));
      const original = await overviewTime(page).elementHandle();
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await overviewPanel(page).getByRole('button', { name: kind === 'save' ? 'Save digest settings' : 'Send now', exact: true }).press('Enter');
      await expect(overviewTime(page)).toBeDisabled(); expect(await overviewWouldBlockUnload(page)).toBe(true);
      await leaveOverviewSettings(page); await expect.poll(() => dialogs).toEqual([overviewWorkPrompt]);
      await expect(page).toHaveURL(/#settings\/notifications$/u);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.change'))).toBe(1);
      await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.delivery'))).toBe(before.reads + 1);
      await expect(overviewTime(page)).toBeDisabled(); expect(await overviewWouldBlockUnload(page)).toBe(true);
      await leaveOverviewSettings(page); await expect.poll(() => dialogs).toEqual([overviewWorkPrompt, overviewWorkPrompt]);
      await expect(page).toHaveURL(/#settings\/notifications$/u);
      expect(await original!.evaluate(node => node.isConnected && node === document.querySelector('[data-situation-delivery] input[name="time"]'))).toBe(true);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.delivery'))).toBe(1);
      await expect(overviewPanel(page).getByRole('status')).toContainText(kind === 'save' ? 'Digest settings saved.' : 'Checked.');
      expect(await overviewWouldBlockUnload(page)).toBe(false);
      expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(before.writes + 1);
      await leaveOverviewSettings(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
      expect(dialogs).toEqual([overviewWorkPrompt, overviewWorkPrompt]);
    });

    for (const phase of ['write', 'confirmation'] as const) {
      test(`Coming up navigation ignores a late ${kind} ${phase} reply after an accepted leave at ${width}px`, async ({ page }) => {
        await openOverviewSettings(page, width);
        if (kind === 'save') await overviewTime(page).fill('10:30');
        await page.evaluate(() => window.__app.holdRpcResponses?.('yours.change'));
        const original = await overviewTime(page).elementHandle();
        const beforeReads = await page.evaluate(() => window.__app.rpcCallCount('yours.delivery'));
        if (phase === 'confirmation') await page.evaluate(() => window.__app.holdRpcResponses?.('yours.delivery'));
        await overviewPanel(page).getByRole('button', { name: kind === 'save' ? 'Save digest settings' : 'Send now', exact: true }).press('Enter');
        await expect(overviewTime(page)).toBeDisabled();
        if (phase === 'confirmation') {
          expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.change'))).toBe(1);
          await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.delivery'))).toBe(beforeReads + 1);
        }
        const dialogs: string[] = []; let accept = true;
        page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
        await leaveOverviewSettings(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
        expect(dialogs).toEqual([overviewWorkPrompt]);
        expect(await original!.evaluate(node => node.isConnected)).toBe(false);
        await page.evaluate(() => window.__app.setHash('#settings/notifications'));
        if (phase === 'confirmation') {
          await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.delivery'))).toBe(beforeReads + 2);
          expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.delivery', 1))).toBe(1);
        }
        await expect(overviewTime(page)).toBeEnabled();
        await overviewTime(page).fill('11:45'); await overviewTime(page).focus(); const fresh = await overviewTime(page).elementHandle();
        const currentReads = await page.evaluate(() => window.__app.rpcCallCount('yours.delivery'));
        expect(await page.evaluate(method => window.__app.releaseRpcResponses?.(method), phase === 'write' ? 'yours.change' : 'yours.delivery')).toBe(1);
        await expect(overviewTime(page)).toHaveValue('11:45'); await expect(overviewTime(page)).toBeFocused();
        expect(await fresh!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
        expect(await page.evaluate(() => window.__app.rpcCallCount('yours.delivery'))).toBe(currentReads);
        accept = false; await leaveOverviewSettings(page);
        await expect.poll(() => dialogs).toEqual([overviewWorkPrompt, overviewDraftPrompt]);
        await expect(overviewTime(page)).toHaveValue('11:45');
      });
    }
  }

  for (const [segment, index, typed, expected] of [['hour', 0, '10', '10:30'], ['minute', 1, '45', '09:45']] as const) {
    test(`Coming up navigation retains an incomplete native ${segment} edit after cancellation at ${width}px`, async ({ page }) => {
      await openOverviewSettings(page, width); const field = overviewTime(page);
      const selectSegment = async () => {
        await field.focus(); for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft');
        for (let step = 0; step < index; step++) await page.keyboard.press('ArrowRight');
      };
      await field.fill('09:30'); await selectSegment(); await page.keyboard.press('Backspace');
      expect(await field.evaluate((input: HTMLInputElement) => input.validity.badInput && input.value === '')).toBe(true);
      const original = await field.elementHandle();
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      expect(await overviewWouldBlockUnload(page)).toBe(true);
      await leaveOverviewSettings(page); await expect.poll(() => dialogs).toEqual([overviewDraftPrompt]);
      await expect(page).toHaveURL(/#settings\/notifications$/u); await expect(field).toBeFocused();
      expect(await original!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      expect(await field.evaluate((input: HTMLInputElement) => input.validity.badInput && input.value === '')).toBe(true);
      await selectSegment(); await page.keyboard.type(typed); await expect(field).toHaveValue(expected);
    });
  }
}

test('Approval & notifications reads as channels, what you are told about, its timing, then the household', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&notifications=ready#settings/notifications`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const section = page.locator('[data-recued-settings-section="notifications"]');
  await expect(section.locator('h3')).toHaveText(['Channels', 'Your secret phrase', 'What you are notified about', 'Digest', 'Quiet hours', 'Reminders for shared assets']);
  await expect(section.locator('[data-household-delivery] h4')).toHaveText(['Post them in a Telegram group', 'Show their tasks on a Home Assistant to-do list']);
  // The card names its assets and links to them, so it reads as the assets' setting.
  const shared = section.locator('[data-household-shared]');
  await expect(shared).toHaveText('No asset is shared yet. To share one, edit it in your assets and set Who sees its reminders to Me and my household.');
  await shared.getByRole('link', { name: 'your assets', exact: true }).click();
  await expect(page.locator('[data-recued-yours]')).toBeVisible();
});

test('Approval & notifications says first, not in a footnote, when nothing reaches your phone', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&notifications=ready&phone=none#settings/notifications`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const callout = page.locator('[data-recued-notifications-phone-callout]');
  await expect(callout).toContainText('Nothing reaches your phone yet.');
  await expect(callout.getByRole('link', { name: 'Connections', exact: true })).toHaveAttribute('href', '#connections');
  // It sits above every channel, where the page is read first.
  const top = (await callout.boundingBox())!.y; const list = (await page.locator('[data-recued-notifications-panel] .notif-list').boundingBox())!.y;
  expect(top).toBeLessThan(list);
  // ⛔ With Telegram on and carrying no reminder, "turn on a channel" would be wrong: it says why.
  await page.goto(`${HARNESS_URL}?yours=demo&notifications=ready&phone=telegram#settings/notifications`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(callout).toHaveText('Reminders don’t reach your phone yet. Telegram is on, but its connection isn’t set to reach only you: check it in Connections.');
  await expect(callout.getByRole('link', { name: 'Connections', exact: true })).toHaveAttribute('href', '#connections');
});

test('Approval & notifications offers a Home Assistant connection’s to-do lists by name', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&notifications=ready&household_lists=1#settings/notifications`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const panel = page.locator('[data-household-delivery]');
  await panel.getByLabel('Home Assistant connection', { exact: true }).selectOption('0');
  const menu = panel.getByLabel('To-do list', { exact: true });
  await expect(menu.locator('option')).toHaveText(['Choose a list', 'Chores', 'Household']);
  await expect(panel.getByLabel('To-do list ID', { exact: true })).toBeHidden();
  await menu.selectOption('todo.chores'); await panel.getByRole('button', { name: 'Save to-do list', exact: true }).click();
  await expect(panel.locator('[data-household-status]')).toHaveText('Home Assistant list saved.');
  // Read again after the save, the menu shows the list that was saved.
  await expect(menu).toHaveValue('todo.chores');
});

test('Approval & notifications names the shared assets, each opening its asset', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=parts&notifications=ready#settings/notifications`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const shared = page.locator('[data-recued-settings-section="notifications"] [data-household-shared]');
  await expect(shared).toHaveText('Shared now: House. To change one, edit it in your assets.');
  await shared.getByRole('link', { name: 'House', exact: true }).click();
  await expect(page.locator('[data-recued-yours]').getByRole('heading', { name: 'House', exact: true, level: 2 })).toBeVisible();
});

test('Approval & notifications saves the digest settings and shows its last sent values', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&notifications=ready#settings/notifications`);
  const panel = page.locator('[data-situation-delivery]');
  await panel.getByLabel('Day', { exact: true }).selectOption('4');
  await panel.getByLabel('How often', { exact: true }).selectOption('daily');
  await panel.getByLabel('Time', { exact: true }).fill('10:30');
  await panel.getByLabel('Also send a note on the day something is due', { exact: true }).uncheck();
  await panel.getByRole('button', { name: 'Send now', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(panel.getByRole('status')).toContainText('Checked.');
  await expect(panel.getByLabel('How often', { exact: true })).toHaveValue('daily');
  await expect(panel.getByLabel('Day', { exact: true })).toHaveValue('4');
  await expect(panel.getByLabel('Time', { exact: true })).toHaveValue('10:30');
  await expect(panel.getByLabel('Also send a note on the day something is due', { exact: true })).not.toBeChecked();
  await panel.getByRole('button', { name: 'Save digest settings', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(panel.getByRole('status')).toHaveText('Digest settings saved.');
  await expect(panel.getByRole('button', { name: 'Save digest settings', exact: true })).toBeFocused();
  await expect(panel.getByLabel('Time', { exact: true })).toHaveValue('10:30');
  await expect(panel.getByLabel('How often', { exact: true })).toHaveValue('daily');
  await panel.getByRole('button', { name: 'Send now', exact: true }).click();
  await panel.getByText('What it sent', { exact: true }).click(); await expect(panel).toContainText('Lisbon trip · Passport expiry');
});

for (const width of [390, 1280]) {
  const openHousehold = async (page: Page) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HARNESS_URL}?yours=demo&notifications=ready#settings/notifications`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect(page.locator('[data-household-delivery]').getByRole('button', { name: 'Save household Telegram', exact: true })).toBeEnabled();
  };
  // A destination's details show only once it is on, so a detail field is
  // reverted on a saved destination rather than beside Off.
  const switchOn = async (page: Page, kind: 'telegram' | 'home_assistant') => {
    const panel = page.locator('[data-household-delivery]');
    if (kind === 'telegram') {
      await panel.getByLabel('Household group', { exact: true }).selectOption('0');
      await panel.getByRole('button', { name: 'Save household Telegram', exact: true }).click();
      await expect(panel.locator('[data-household-status]')).toHaveText('Household Telegram saved.');
    } else {
      await panel.getByLabel('Home Assistant connection', { exact: true }).selectOption('0');
      await panel.getByLabel('To-do list ID', { exact: true }).fill('todo.household');
      await panel.getByRole('button', { name: 'Save to-do list', exact: true }).click();
      await expect(panel.locator('[data-household-status]')).toHaveText('Home Assistant list saved.');
    }
  };
  for (const label of ['Household group', 'Home Assistant connection', 'To-do list ID'] as const) {
    test(`Household draft reverting ${label} leaves without an unsaved warning at ${width}px`, async ({ page }) => {
      await openHousehold(page); const field = page.locator('[data-household-delivery]').getByLabel(label, { exact: true });
      const detail = label === 'To-do list ID' ? 'home_assistant' : null;
      if (detail) await switchOn(page, detail);
      const initial = await field.inputValue(), original = await field.elementHandle(); expect(await overviewWouldBlockUnload(page)).toBe(false);
      if (label === 'Household group' || label === 'Home Assistant connection') await field.selectOption(initial === '' ? '0' : '');
      else await field.fill('todo.edited');
      expect(await overviewWouldBlockUnload(page)).toBe(true);
      if (label === 'Household group' || label === 'Home Assistant connection') await field.selectOption(initial);
      else await field.fill(initial);
      expect(await overviewWouldBlockUnload(page)).toBe(false); expect(await original!.evaluate(node => node.isConnected)).toBe(true);
      expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(detail ? 1 : 0);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await leaveOverviewSettings(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([]);
    });
  }

  test(`Household draft partial reverts protect the other form until both are restored at ${width}px`, async ({ page }) => {
    await openHousehold(page); const panel = page.locator('[data-household-delivery]');
    const group = panel.getByLabel('Household group', { exact: true });
    const connection = panel.getByLabel('Home Assistant connection', { exact: true }), entity = panel.getByLabel('To-do list ID', { exact: true });
    const before = { group: await group.inputValue(), connection: await connection.inputValue(), entity: await entity.inputValue() };
    await group.selectOption('0'); await connection.selectOption('0'); await entity.fill('todo.edited');
    await group.selectOption(before.group); expect(await overviewWouldBlockUnload(page)).toBe(true);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await leaveOverviewSettings(page); await expect.poll(() => dialogs).toEqual(['Discard the unsaved household delivery settings?']);
    await expect(page).toHaveURL(/#settings\/notifications$/u); await expect(entity).toHaveValue('todo.edited'); await expect(connection).toHaveValue('0');
    await entity.fill(before.entity); expect(await overviewWouldBlockUnload(page)).toBe(true);
    await connection.selectOption(before.connection); expect(await overviewWouldBlockUnload(page)).toBe(false);
    expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); await expect(group).toHaveValue(before.group);
    expect(dialogs).toEqual(['Discard the unsaved household delivery settings?']); expect(await overviewWouldBlockUnload(page)).toBe(false);
    await leaveOverviewSettings(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toHaveLength(1);
  });
}

test('Household Telegram saves an enrolled group, separately from private channels, as a group that only reads', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await page.goto(`${HARNESS_URL}?yours=demo&notifications=ready#settings/notifications`);
  const panel = page.locator('[data-household-delivery]'); const telegram = panel.locator('[data-household-telegram]');
  // D-325 §15.7 (2026-10-24) — the group only receives: nobody to add, invite or let answer.
  await expect(telegram).toContainText('Nobody answers them there: you mark them done in Recued.');
  await panel.getByLabel('Household group', { exact: true }).selectOption('0');
  const save = panel.getByRole('button', { name: 'Save household Telegram', exact: true }); await save.focus(); await page.keyboard.press('Enter');
  await expect(panel.getByRole('status')).toHaveText('Household Telegram saved.'); await expect(save).toBeFocused();
  await expect(telegram.getByRole('button')).toHaveText(['Save household Telegram']); await expect(telegram.locator('input')).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(1);
  await panel.getByLabel('Household group', { exact: true }).selectOption(''); await save.click();
  await expect(panel.getByRole('status')).toHaveText('Household Telegram saved.');
  await expect(panel.getByLabel('Household group', { exact: true })).toHaveValue('');
});
test('Household lists preserve the other delivery form’s unsaved selection', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await page.goto(`${HARNESS_URL}?yours=demo&notifications=ready#settings/notifications`);
  const panel = page.locator('[data-household-delivery]');
  await panel.getByLabel('Household group', { exact: true }).selectOption('0');
  await panel.getByLabel('Home Assistant connection', { exact: true }).selectOption('0'); await panel.getByLabel('To-do list ID', { exact: true }).fill('todo.household');
  await panel.getByRole('button', { name: 'Save to-do list', exact: true }).click();
  await expect(panel.locator('[data-household-status]')).toHaveText('Home Assistant list saved.');
  await expect(panel.getByLabel('Household group', { exact: true })).toHaveValue('0');
  await panel.getByRole('button', { name: 'Save household Telegram', exact: true }).click();
  await expect(panel.locator('[data-household-status]')).toHaveText('Household Telegram saved.');
  await expect(panel.getByLabel('To-do list ID', { exact: true })).toHaveValue('todo.household');
});

test('Household catches up on a group chosen elsewhere while Settings was away', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&notifications=ready#settings/notifications`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const group = page.locator('[data-household-delivery]').getByLabel('Household group', { exact: true });
  await expect(group).toHaveValue('');
  await page.evaluate(() => { location.hash = '#yours/assets'; }); await expect(page.locator('[data-recued-yours]')).toBeVisible();
  await page.evaluate(() => { window.__householdFixture!.setGroup(true); location.hash = '#settings/notifications'; });
  await expect(group).toHaveValue('0');
});
test('An owner class draft adds and edits a typed rule without changing an asset', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/assets/classes`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Create class', exact: true }).click();
  let form = route.locator('[data-yours-editor]'); await form.getByLabel('Name', { exact: true }).fill('Membership');
  await form.getByRole('button', { name: 'Add date field', exact: true }).click(); await form.getByLabel('Date field name', { exact: true }).fill('Expires on');
  await form.getByRole('button', { name: 'Add preset rule', exact: true }).click();
  form = route.locator('[data-yours-editor]'); await form.getByLabel('Title', { exact: true }).fill('Renew membership');
  await form.getByLabel('Asset date', { exact: true }).selectOption('expires_on'); await form.getByRole('button', { name: 'Keep rule in draft', exact: true }).click();
  form = route.locator('[data-yours-editor]'); await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Membership');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(route.getByRole('heading', { name: 'Membership · v1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__app.rpcCallCount('work_entity.upsert'))).toBe(0);
});

test('An asset attaches an existing file, opens the real preview, and removes only the reference', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/asset/passport/view/files`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Browse files', exact: true }).click();
  // `files` is the Data tab's name; an unknown tab falls back to Contacts.
  await expect(route.getByRole('link', { name: 'Upload a receipt, photo or certificate in Files', exact: true })).toHaveAttribute('href', '#data/files');
  await route.getByRole('button', { name: 'Attach', exact: true }).click();
  const attachment = route.locator('[data-yours-document]');
  await expect(attachment.getByRole('heading', { name: 'Passport receipt.txt', exact: true })).toBeVisible();
  await expect(attachment).toContainText('text/plain · 16 B');
  expect(await page.evaluate(() => window.__app.rpcCallCount('data.file.attachments.preview'))).toBe(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('data.file.read'))).toBe(0);
  await attachment.getByRole('button', { name: 'Document details', exact: true }).click();
  await route.getByLabel('Purpose (optional)', { exact: true }).fill('Receipt');
  await route.getByLabel('Applies to (optional)', { exact: true }).fill('Ana’s passport renewal');
  await route.getByLabel('Document revision (optional)', { exact: true }).fill('October 2026');
  await route.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(attachment).toContainText('Ana’s passport renewal');
  await expect(attachment).toContainText('October 2026');
  await route.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(attachment).toContainText('October 2026');
  await expect(route.locator('dt').filter({ hasText: /^document details$/ })).toHaveCount(0);
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click();
  await expect(route.getByLabel('Attributes field name', { exact: true })).toHaveCount(0);
  await route.getByRole('button', { name: 'Add attribute', exact: true }).click();
  await route.getByLabel('Attributes field name', { exact: true }).fill('document_details');
  await route.getByLabel('Attributes value', { exact: true }).fill('overwrite');
  await route.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(route.getByRole('alert')).toContainText('Use Document details on the attached file');
  await route.getByLabel('Attributes field name', { exact: true }).fill('colour');
  await route.getByLabel('Attributes value', { exact: true }).fill('blue');
  await route.getByLabel('Name', { exact: true }).fill('Ana’s current passport');
  await route.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(attachment).toContainText('October 2026');
  await route.getByRole('button', { name: 'Preview file', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'File preview', exact: true }); await expect(preview).toContainText('Passport receipt');
  await preview.getByRole('button', { name: 'Close preview', exact: true }).click(); await route.getByLabel('More actions for attached file', { exact: true }).click(); await route.getByRole('button', { name: 'Remove attachment', exact: true }).click();
  await expect(route.getByText('No attached files.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__app.rpcCallCount('data.file.mutate'))).toBe(0);
});

test('Unavailable file metadata can be retried without losing document edits or downloading content', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${HARNESS_URL}?yours=demo&yours_file_details=retry#yours/asset/passport/view/files`);
  const route = page.locator('[data-recued-yours]'); const attachment = route.locator('[data-yours-document]');
  await expect(attachment).toContainText('File details unavailable.');
  await attachment.getByRole('button', { name: 'Retry file details', exact: true }).click();
  await expect(attachment.getByRole('heading', { name: 'Passport receipt.txt', exact: true })).toBeVisible();
  await attachment.getByRole('button', { name: 'Document details', exact: true }).click();
  await route.getByLabel('Purpose (optional)', { exact: true }).fill('Manual');
  await expect(route.getByLabel('Document revision (optional)', { exact: true })).toHaveValue('');
  await route.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(route.getByLabel('Purpose (optional)', { exact: true })).toHaveValue('Manual');
  await route.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(attachment).toContainText('Manual');
  await attachment.getByRole('button', { name: 'Document details', exact: true }).click();
  await route.getByLabel('Purpose (optional)', { exact: true }).fill('');
  await route.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(attachment.getByText('Purpose', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('data.file.attachments.preview'))).toBe(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('data.file.read'))).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const mode of ['missing', 'mismatch']) test(`A ${mode} file stays removable and does not display another file’s metadata`, async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_file_details=${mode}#yours/asset/passport/view/files`);
  const route = page.locator('[data-recued-yours]'); const attachment = route.locator('[data-yours-document]');
  await expect(attachment).toContainText('File details unavailable.');
  await expect(attachment).not.toContainText('Unrelated private file');
  await expect(attachment.getByRole('heading', { name: 'Attached file', exact: true })).toBeVisible();
  await attachment.getByLabel('More actions for attached file', { exact: true }).click(); await attachment.getByRole('button', { name: 'Remove attachment', exact: true }).click();
  await expect(route.getByText('No attached files.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__app.rpcCallCount('data.file.mutate'))).toBe(0);
});

test('An ordinary asset edit preserves document details updated after its form opened', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_file_details=ready&yours_concurrent_document=1#yours/asset/passport/view/files`);
  const route = page.locator('[data-recued-yours]');
  await route.getByRole('button', { name: 'Document details', exact: true }).click();
  await route.getByLabel('Purpose (optional)', { exact: true }).fill('Earlier manual');
  await route.getByLabel('Document revision (optional)', { exact: true }).fill('Edition 2025');
  await route.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(route.locator('[data-yours-document]')).toContainText('Earlier manual');
  await route.getByRole('button', { name: 'Edit asset', exact: true }).click();
  await route.getByLabel('Name', { exact: true }).fill('Ana’s current passport');
  await route.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(route.locator('[data-yours-document]')).toContainText('Updated elsewhere');
  await expect(route.locator('[data-yours-document]')).toContainText('Edition 2026');
});

test('Older file search responses cannot replace the latest results', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/asset/passport/view/files`);
  const route = page.locator('[data-recued-yours]'); const method = 'data.file.attachments.list';
  await page.evaluate(rpc => window.__app.holdRpcResponses?.(rpc), method);
  const before = await page.evaluate(rpc => window.__app.rpcCallCount(rpc), method);
  await route.getByLabel('Find a file to attach', { exact: true }).fill('receipt');
  await route.getByRole('button', { name: 'Browse files', exact: true }).click();
  await expect.poll(() => page.evaluate(rpc => window.__app.rpcCallCount(rpc), method)).toBe(before + 1);
  await route.getByLabel('Find a file to attach', { exact: true }).fill('no matching document');
  await route.getByRole('button', { name: 'Browse files', exact: true }).click();
  await expect.poll(() => page.evaluate(rpc => window.__app.rpcCallCount(rpc), method)).toBe(before + 2);
  expect(await page.evaluate(rpc => window.__app.releaseRpcResponses?.(rpc, 1), method)).toBe(1);
  await expect(route.getByText('No matching files.', { exact: true })).toBeVisible();
  expect(await page.evaluate(rpc => window.__app.releaseRpcResponses?.(rpc, 0), method)).toBe(1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(route.getByText('No matching files.', { exact: true })).toBeVisible();
  await expect(route.getByRole('button', { name: 'Attach', exact: true })).toHaveCount(0);
  await route.getByLabel('Find a file to attach', { exact: true }).fill('receipt');
  await route.getByRole('button', { name: 'Browse files', exact: true }).click();
  await expect.poll(() => page.evaluate(rpc => window.__app.rpcCallCount(rpc), method)).toBe(before + 3);
  await route.getByLabel('Find a file to attach', { exact: true }).fill('a different search');
  expect(await page.evaluate(rpc => window.__app.releaseRpcResponses?.(rpc, 0), method)).toBe(1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(route.getByRole('button', { name: 'Attach', exact: true })).toHaveCount(0);
});

test('Late file metadata cannot replace a document draft', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_file_details=ready#yours/assets`);
  await page.waitForFunction(() => window.__app?.ready);
  await page.evaluate(() => { window.__app.holdRpcResponses?.('data.file.attachments.get'); location.hash = '#yours/asset/passport/view/files'; });
  const route = page.locator('[data-recued-yours]');
  await expect(route.getByText('Loading file details…', { exact: true })).toBeVisible();
  await route.getByRole('button', { name: 'Document details', exact: true }).click();
  await route.getByLabel('Purpose (optional)', { exact: true }).fill('Draft manual');
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('data.file.attachments.get'))).toBe(1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(route.getByLabel('Purpose (optional)', { exact: true })).toHaveValue('Draft manual');
  await route.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(route.locator('[data-yours-document]')).toContainText('Draft manual');
});

test('File browsing appends each page once and resets pagination for a new search', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_file_pages=1#yours/asset/passport/view/files`);
  const route = page.locator('[data-recued-yours]');
  await route.getByRole('button', { name: 'Browse files', exact: true }).click();
  await expect(route.getByRole('heading', { name: 'Passport receipt.txt', exact: true })).toBeVisible();
  await route.getByRole('button', { name: 'More files', exact: true }).click();
  await expect(route.getByRole('heading', { name: 'Boiler certificate.txt', exact: true })).toBeVisible();
  await expect(route.getByRole('heading', { name: 'Passport receipt.txt', exact: true })).toHaveCount(1);
  await expect(route.getByRole('button', { name: 'More files', exact: true })).toHaveCount(0);
  await route.getByLabel('Find a file to attach', { exact: true }).fill('certificate');
  await route.getByRole('button', { name: 'Browse files', exact: true }).click();
  await expect(route.getByRole('heading', { name: 'Boiler certificate.txt', exact: true })).toBeVisible();
  await expect(route.getByRole('heading', { name: 'Passport receipt.txt', exact: true })).toHaveCount(0);
});

test('Late file metadata cannot revive an asset page after navigation', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_file_details=ready#yours/assets`);
  await page.waitForFunction(() => window.__app?.ready);
  await page.evaluate(() => { window.__app.holdRpcResponses?.('data.file.attachments.get'); location.hash = '#yours/asset/passport/view/files'; });
  const route = page.locator('[data-recued-yours]');
  await expect(route.getByText('Loading file details…', { exact: true })).toBeVisible();
  await page.evaluate(() => { location.hash = '#yours/assets'; });
  await expect(route.getByRole('link', { name: 'Open asset', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('data.file.attachments.get'))).toBe(1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(route.locator('[data-yours-document]')).toHaveCount(0);
  await expect(route.getByRole('link', { name: 'Open asset', exact: true })).toBeVisible();
});

test('A parent is selected by name beyond the loaded asset page and saved explicitly', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${HARNESS_URL}?yours=relations#yours/asset/boiler-current`);
  const route = page.locator('[data-recued-yours]');
  await expect(route.getByRole('link', { name: 'Belongs to Main house', exact: true })).toBeVisible();
  await expect(route.getByLabel('Parent asset id (blank to detach)', { exact: true })).toHaveCount(0);
  await route.getByRole('button', { name: 'Change parent', exact: true }).click();
  const picker = route.getByRole('combobox', { name: 'Parent asset', exact: true });
  await expect(picker).toHaveValue('Main house'); const before = await page.evaluate(() => window.__app.rpcCallCount('yours.change'));
  await picker.fill('Mountain'); await expect(route.getByRole('option', { name: /Mountain cabin/ })).toBeVisible();
  await picker.press('ArrowDown'); await picker.press('Enter'); await expect(picker).toHaveValue('Mountain cabin');
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(before);
  await route.getByRole('button', { name: 'Save parent', exact: true }).click();
  await expect(route.getByRole('link', { name: 'Belongs to Mountain cabin', exact: true })).toBeVisible();
  await expect(route.locator('[data-yours-editor]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Clearing and saving the parent removes only that relationship', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=relations#yours/asset/boiler-current`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Change parent', exact: true }).click();
  await route.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await route.getByRole('button', { name: 'Save parent', exact: true }).click();
  await expect(route.getByText('No parent asset.', { exact: true })).toBeVisible();
  await expect(route.getByRole('heading', { name: 'Kitchen boiler', exact: true })).toBeVisible();
  await expect(route).toContainText('CUR001');
  await expect(route.getByRole('link', { name: 'Boiler sensor · part', exact: true })).toBeVisible();
});

test.describe('Asset relationship touch actions', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 780 } });
  test('Clear, selection, Save and Cancel work with taps', async ({ page }) => {
    await page.goto(`${HARNESS_URL}?yours=relations#yours/asset/boiler-current`);
    const route = page.locator('[data-recued-yours]');
    await route.getByRole('button', { name: 'Change parent', exact: true }).tap();
    const picker = route.getByRole('combobox', { name: 'Parent asset', exact: true });
    await route.getByRole('button', { name: 'Clear selection', exact: true }).tap();
    await expect(picker).toHaveValue('');
    await route.getByRole('button', { name: 'Save parent', exact: true }).tap();
    await expect(route.getByText('No parent asset.', { exact: true })).toBeVisible();
    await route.getByRole('button', { name: 'Choose parent', exact: true }).tap();
    await picker.fill('Mountain'); await route.getByRole('option', { name: /Mountain cabin/ }).tap();
    await route.getByRole('button', { name: 'Save parent', exact: true }).tap();
    await expect(route.getByRole('link', { name: 'Belongs to Mountain cabin', exact: true })).toBeVisible();
    await route.getByRole('button', { name: 'Change parent', exact: true }).tap();
    await picker.fill('Garden'); await expect(route.getByRole('option', { name: /Garden flat/ })).toBeVisible();
    await route.getByRole('button', { name: 'Cancel', exact: true }).tap();
    await expect(route.getByRole('combobox')).toHaveCount(0);
    await expect(route.getByRole('link', { name: 'Belongs to Mountain cabin', exact: true })).toBeVisible();
  });
});

test('Relationship search is transient while a chosen relationship keeps the discard guard', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=relations#yours/asset/boiler-current`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Change parent', exact: true }).click();
  await route.getByRole('combobox', { name: 'Parent asset', exact: true }).fill('Mountain');
  await route.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(route.locator('[data-yours-editor]')).toHaveCount(0);
  await route.getByRole('button', { name: 'Change parent', exact: true }).click();
  await route.getByRole('combobox', { name: 'Parent asset', exact: true }).fill('Mountain');
  await route.getByRole('option', { name: /Mountain cabin/ }).click();
  page.once('dialog', dialog => dialog.accept()); await route.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(route.locator('[data-yours-editor]')).toHaveCount(0);
  await expect(route.getByRole('link', { name: 'Belongs to Main house', exact: true })).toBeVisible();
});

test('Parent choices omit the asset itself and its known parts', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=relations#yours/asset/boiler-current`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Change parent', exact: true }).click();
  const picker = route.getByRole('combobox', { name: 'Parent asset', exact: true });
  await picker.fill('Boiler sensor'); await expect(route.getByText('No matching assets.', { exact: true })).toBeVisible();
  const before = await page.evaluate(() => window.__app.rpcCallCount('yours.change')); await picker.press('Enter');
  await expect(route.getByRole('alert')).toContainText('Choose parent asset from the matches');
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(before);
  await picker.fill('Kitchen boiler'); await expect(route.getByRole('option')).toHaveCount(1);
  await expect(route.getByRole('option')).toContainText('ALT002'); await expect(route.getByRole('option')).not.toContainText('CUR001');
});

test('A same-thing link uses a named record and leaves both assets and the parent intact', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=relations#yours/asset/boiler-current`);
  const route = page.locator('[data-recued-yours]');
  await route.getByRole('button', { name: 'Link another record for the same thing', exact: true }).click();
  await route.getByRole('combobox', { name: 'Other record', exact: true }).fill('Kitchen boiler');
  const option = route.getByRole('option'); await expect(option).toHaveCount(1); await expect(option).toContainText('ALT002'); await option.click();
  await route.getByRole('button', { name: 'Link records', exact: true }).click();
  await expect(route.getByRole('link', { name: 'Kitchen boiler · part', exact: true })).toHaveAttribute('href', '#yours/asset/boiler-duplicate');
  await expect(route.getByRole('link', { name: 'Belongs to Main house', exact: true })).toBeVisible();
  await expect(route).toContainText('CUR001');
});

test('Asset relationship searches ignore old responses and replies after Cancel', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=relations#yours/asset/boiler-current`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Change parent', exact: true }).click();
  await expect(route.getByText('More assets match. Type a more specific name to narrow the results.', { exact: true })).toBeVisible();
  const picker = route.getByRole('combobox', { name: 'Parent asset', exact: true }); const method = 'yours.read';
  await page.evaluate(rpc => window.__app.holdRpcResponses?.(rpc), method);
  const before = await page.evaluate(rpc => window.__app.rpcCallCount(rpc), method);
  await picker.fill('Mountain'); await expect.poll(() => page.evaluate(rpc => window.__app.rpcCallCount(rpc), method)).toBe(before + 1);
  await picker.fill('Garden'); await expect.poll(() => page.evaluate(rpc => window.__app.rpcCallCount(rpc), method)).toBe(before + 2);
  expect(await page.evaluate(rpc => window.__app.releaseRpcResponses?.(rpc, 1), method)).toBe(1);
  await expect(route.getByRole('option', { name: /Garden flat/ })).toBeVisible();
  expect(await page.evaluate(rpc => window.__app.releaseRpcResponses?.(rpc, 0), method)).toBe(1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(route.getByRole('option', { name: /Garden flat/ })).toBeVisible();
  await expect(route.getByRole('option', { name: /Mountain cabin/ })).toHaveCount(0);
  await picker.fill('Mountain'); await expect.poll(() => page.evaluate(rpc => window.__app.rpcCallCount(rpc), method)).toBe(before + 3);
  await route.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(rpc => window.__app.releaseRpcResponses?.(rpc), method)).toBe(1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(route.getByRole('combobox')).toHaveCount(0);
  await expect(route.getByRole('link', { name: 'Belongs to Main house', exact: true })).toBeVisible();
});

test('Asset relationship search reports read failures and capped matches', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=relations&yours_asset_search_fail_once=1#yours/asset/boiler-current`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Change parent', exact: true }).click();
  const picker = route.getByRole('combobox', { name: 'Parent asset', exact: true });
  await expect(route.getByText('Asset search unavailable. Try again.', { exact: true })).toBeVisible();
  await expect(picker).toHaveValue('Main house'); await picker.fill('');
  await expect(route.getByText('More assets match. Type a more specific name to narrow the results.', { exact: true })).toBeVisible();
  await picker.fill('Mountain'); await expect(route.getByRole('option', { name: /Mountain cabin/ })).toBeVisible();
  await expect(route.getByText('More assets match. Type a more specific name to narrow the results.', { exact: true })).toHaveCount(0);
});

test('Relationship proposal review resolves saved assets beyond page one and preserves them on save', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=relations#yours/proposals`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Review change', exact: true }).click();
  const primary = route.getByRole('combobox', { name: 'Asset', exact: true }); const related = route.getByRole('combobox', { name: 'Related asset', exact: true });
  await expect(primary).toHaveValue('Kitchen boiler'); await expect(related).toHaveValue('Mountain cabin');
  await related.fill('Garden'); await route.getByRole('option', { name: /Garden flat/ }).click();
  await route.getByRole('button', { name: 'Save proposal', exact: true }).click();
  await expect(route.locator('[data-yours-editor]')).toHaveCount(0);
  await route.getByRole('button', { name: 'Review change', exact: true }).click();
  await expect(primary).toHaveValue('Kitchen boiler'); await expect(related).toHaveValue('Garden flat');
  await primary.fill('Garden'); await route.getByRole('option', { name: /Garden flat/ }).click();
  await expect(related).toHaveValue('');
  await route.getByRole('button', { name: 'Save proposal', exact: true }).click();
  await expect(route.getByRole('alert')).toContainText('Choose related asset from the matches');
  page.once('dialog', dialog => dialog.accept()); await route.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { location.hash = '#yours/asset/boiler-current'; });
  await expect(route.getByRole('link', { name: 'Belongs to Main house', exact: true })).toBeVisible();
});

test('A late saved-asset label cannot replace a relationship search query', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=relations#yours/proposals`);
  const route = page.locator('[data-recued-yours]'); const method = 'yours.read';
  await expect(route.getByRole('button', { name: 'Review change', exact: true })).toBeVisible();
  await page.evaluate(rpc => window.__app.holdRpcResponses?.(rpc), method);
  const before = await page.evaluate(rpc => window.__app.rpcCallCount(rpc), method);
  await route.getByRole('button', { name: 'Review change', exact: true }).click();
  const primary = route.getByRole('combobox', { name: 'Asset', exact: true });
  await primary.fill('Mountain');
  await expect.poll(() => page.evaluate(rpc => window.__app.rpcCallCount(rpc), method)).toBeGreaterThanOrEqual(before + 4);
  await page.evaluate(rpc => window.__app.releaseRpcResponses?.(rpc), method);
  await expect(route.getByRole('option', { name: /Mountain cabin/ })).toBeVisible();
  await expect(primary).toHaveValue('Mountain');
  await expect(route.getByRole('combobox', { name: 'Related asset', exact: true })).toHaveValue('Mountain cabin');
  await primary.press('Escape'); await expect(primary).toHaveValue('Kitchen boiler');
  await route.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(route.locator('[data-yours-editor]')).toHaveCount(0);
});

test('A delayed saved-asset lookup cannot undo a chosen reference', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=relations#yours/proposals`);
  const route = page.locator('[data-recued-yours]'); const method = 'yours.read';
  await expect(route.getByRole('button', { name: 'Review change', exact: true })).toBeVisible();
  await page.evaluate(rpc => window.__app.holdRpcResponses?.(rpc), method);
  const before = await page.evaluate(rpc => window.__app.rpcCallCount(rpc), method);
  await route.getByRole('button', { name: 'Review change', exact: true }).click();
  const related = route.getByRole('combobox', { name: 'Related asset', exact: true });
  await related.fill('Garden');
  await expect.poll(() => page.evaluate(rpc => window.__app.rpcCallCount(rpc), method)).toBe(before + 4);
  expect(await page.evaluate(rpc => window.__app.releaseRpcResponses?.(rpc, 3), method)).toBe(1);
  await route.getByRole('option', { name: /Garden flat/ }).click();
  expect(await page.evaluate(rpc => window.__app.releaseRpcResponses?.(rpc), method)).toBe(3);
  await expect(route.getByRole('combobox', { name: 'Asset', exact: true })).toHaveValue('Kitchen boiler');
  await expect(related).toHaveValue('Garden flat');
  page.once('dialog', dialog => dialog.accept()); await route.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(route.locator('[data-yours-editor]')).toHaveCount(0);
});

test('Proposal kind filters survive their route and leave the underlying proposal waiting', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/proposals`);
  const route = page.locator('[data-recued-yours]'); await route.getByLabel('Proposal kind', { exact: true }).selectOption('rule');
  await expect(page).toHaveURL(/#yours\/proposals\/kind\/rule$/);
  await expect(route.getByLabel('Proposal kind', { exact: true })).toHaveValue('rule'); await expect(route.getByText('No proposals waiting.', { exact: true })).toBeVisible();
  await route.getByLabel('Proposal kind', { exact: true }).selectOption(''); await expect(route.getByRole('heading', { name: 'LG television', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
});
