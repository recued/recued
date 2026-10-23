import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installConnectionsUxFixture } from './fixtures/connections-ux.js';
import { ACCESS_COMPARISON_IDS as ids, installAccessComparisonFixture } from './fixtures/connections-access-comparison.js';

const origin = process.env.CONNECTIONS_UX_ORIGIN ?? HARNESS_ORIGIN;
const route = (page: Page) => page.locator('[data-recued-connections-route]');
const historyRow = (page: Page, id = ids.recheck) => route(page).locator('[data-authentication-verification="' + id + '"]');
const accessPanel = (page: Page) => route(page).locator('.authentication-access');
const bulkPanel = (page: Page) => route(page).locator('[data-bulk-access]');
const compare = (host: Locator) => host.locator('[data-access-compare]');
const comparison = (host: Locator) => host.getByRole('region', { name: 'Original and recheck results', exact: true });
const activate = async (control: Locator) => { await control.focus(); await expect(control).toBeFocused(); await control.press('Enter'); };
const requests = (page: Page) => page.evaluate(() => window.__accessComparisonFixture.requests
  .filter(r => r.method === 'collection.connection.managedOAuth').map(r => r.args));
const readPair = [{ action: 'authentication_access_status', id: ids.recheck }, { action: 'authentication_access_status', id: ids.original }];
type View = 'history' | 'panel' | 'summary' | 'targeted' | 'bulk';

const go = async (page: Page, view: View, stop = false): Promise<Locator> => {
  await page.goto(origin + '/full-app-harness.html?settle_reads=1&oauth=ready&connection=webhooks#chat');
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(installAccessComparisonFixture, ids);
  if (view === 'bulk') await page.evaluate(() => window.__accessComparisonFixture.latestOriginal());
  const hash = view === 'targeted' ? '#connections/others/access-result/' + ids.recheck + '/' + ids.file
    : view === 'history' || view === 'panel' ? '#connections/others/incident-history' : '#connections/others';
  await page.evaluate(value => window.__app.setHash(value), hash);
  if (view === 'history') { await expect(compare(historyRow(page))).toBeEnabled(); return historyRow(page); }
  if (view === 'panel') await activate(historyRow(page).locator('[data-incident-view-access]'));
  else if (view !== 'targeted') {
    const summary = route(page).locator('[data-authentication-repairs-summary]');
    await expect(summary).not.toHaveText('Reading authentication status…'); await activate(summary);
    if (view === 'summary') await activate(route(page).locator('[data-latest-access-view="' + ids.file + '"]'));
    else {
      await activate(route(page).locator('[data-reconnect-worklist-action="bulk-access"]'));
      const panel = bulkPanel(page); await expect(panel.getByRole('searchbox')).toBeFocused();
      await activate(panel.locator('[data-bulk-access-action="mode"]'));
      const choice = panel.locator('[data-bulk-access-account="' + ids.original + '"]');
      await expect(choice).toBeEnabled(); await choice.focus(); await choice.press('Space');
      await activate(panel.locator('[data-bulk-access-action="review"]'));
      await expect(panel.locator('[data-bulk-access-action="run"]')).toBeFocused();
      await panel.locator('[data-bulk-access-url="' + ids.api + '"]').fill('https://sheets.googleapis.com/v4/spreadsheets/comparison');
      if (stop) await page.evaluate(() => window.__accessComparisonFixture.holdReply('authentication_access_run'));
      await activate(panel.locator('[data-bulk-access-action="run"]'));
      if (stop) {
        await expect.poll(() => page.evaluate(() => window.__accessComparisonFixture.pendingReplies('authentication_access_run'))).toEqual([ids.recheck]);
        await activate(panel.locator('[data-bulk-access-action="stop"]'));
        await expect(panel).toHaveAttribute('data-bulk-access', 'stopped'); return panel;
      }
      await expect(panel).toHaveAttribute('data-bulk-access', 'finished'); await expect(compare(panel)).toBeEnabled(); return panel;
    }
  }
  await expect(accessPanel(page).locator('[data-authentication-access-result]')).toHaveAttribute('data-authentication-access-result', ids.recheck);
  await expect(compare(accessPanel(page))).toBeEnabled(); return accessPanel(page);
};

const openComparison = async (page: Page, host: Locator) => {
  const before = (await requests(page)).length;
  const receipts = await page.evaluate(() => window.__accessComparisonFixture.receipts());
  await activate(compare(host)); await expect(comparison(host)).toBeVisible(); await expect(compare(host)).toBeFocused();
  await expect(compare(host)).toHaveAttribute('aria-expanded', 'true');
  const controlledId = await compare(host).getAttribute('aria-controls'); expect(controlledId).toBeTruthy();
  await expect(host.locator('[id="' + controlledId + '"]')).toBeVisible();
  await expect(host.locator('[id="' + controlledId + '"]')).toHaveAttribute('aria-busy', 'false');
  const controlIds = await route(page).locator('[data-access-compare]').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-controls')));
  expect(new Set(controlIds).size).toBe(controlIds.length);
  expect((await requests(page)).slice(before)).toEqual(readPair);
  expect(await page.evaluate(() => window.__accessComparisonFixture.receipts())).toEqual(receipts);
  return comparison(host);
};
const hold = async (page: Page) => page.evaluate(() => window.__accessComparisonFixture.holdReply('authentication_access_status'));
const pending = (page: Page) => page.evaluate(() => window.__accessComparisonFixture.pendingReplies('authentication_access_status'));
const release = async (page: Page, id?: string) => page.evaluate(value => window.__accessComparisonFixture.releaseReplies('authentication_access_status', value), id);

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    test.beforeEach(async ({ page }) => { await page.addInitScript(installConnectionsUxFixture); });
    test.afterEach(async ({ page }) => {
      const errors = await page.pageErrors(); expect(errors, errors.map(error => error.message).join(' | ')).toHaveLength(0);
    });

    for (const view of ['history', 'panel', 'summary', 'bulk'] as const) test(`${view} comparison aligns saved attempts, preserves read boundaries and hides with keyboard focus`, async ({ page }) => {
      const host = await go(page, view); const result = await openComparison(page, host);
      await expect(result.locator('[data-access-comparison-target]')).toHaveCount(3);
      await expect(result).not.toContainText('Earlier passed account');
      await expect(result.getByRole('table')).toHaveCount(3);
      await expect(result.getByRole('columnheader', { name: 'Original', exact: true })).toHaveCount(3);
      await expect(result.getByRole('columnheader', { name: 'Recheck', exact: true })).toHaveCount(3);
      const api = result.locator('[data-access-comparison-target="' + ids.api + '"]');
      await expect(api.locator('[data-access-comparison-before="api_read"]')).toContainText('Failed');
      await expect(api.locator('[data-access-comparison-after="api_read"]')).toHaveText('Passed');
      await expect(api.locator('[data-access-comparison-after="write_permissions"]')).toContainText('Unconfirmed');
      const files = result.getByRole('table', { name: 'Read outcomes for Work Drive archive', exact: true });
      await expect(files.getByRole('rowheader', { name: 'Chosen file download/export', exact: true })).toHaveCount(1);
      await expect(files.locator('[data-access-comparison-before="file_download"]')).toHaveText('Passed (historical result)');
      await expect(files.locator('[data-access-comparison-after="file_download"]')).toHaveText('Not checked in this attempt');
      await expect(result.locator('[data-access-comparison-before-current="no"]')).toHaveCount(3);
      await expect(result.locator('[data-access-comparison-after-current="yes"]')).toHaveCount(3);
      const originals = await result.locator('[data-access-comparison-original] time').evaluateAll(nodes => nodes.map(n => n.getAttribute('datetime')));
      const rechecks = await result.locator('[data-access-comparison-recheck] time').evaluateAll(nodes => nodes.map(n => n.getAttribute('datetime')));
      expect(originals).toEqual([new Date(1_700_000_000_000).toISOString(), new Date(1_700_000_001_000).toISOString()]);
      expect(rechecks).toEqual([new Date(1_700_000_002_000).toISOString(), new Date(1_700_000_003_000).toISOString()]);
      await expect(result).toContainText('may differ between attempts'); await expect(result).toContainText('does not establish which repair');
      expect(await result.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      expect(await route(page).evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      const beforeHide = (await requests(page)).length;
      await activate(host.getByRole('button', { name: 'Hide comparison', exact: true }));
      await expect(comparison(host)).toHaveCount(0); await expect(compare(host)).toHaveText('Compare with original check');
      await expect(compare(host)).toHaveAttribute('aria-expanded', 'false');
      await expect(compare(host)).toBeFocused(); expect((await requests(page)).slice(beforeHide)).toEqual([]);
    });

    test('a targeted saved result compares only its originating resource and links to the exact original', async ({ page }) => {
      const host = await go(page, 'targeted'); const result = await openComparison(page, host);
      await expect(result.locator('[data-access-comparison-target]')).toHaveAttribute('data-access-comparison-target', ids.file);
      await expect(result).not.toContainText('Work spreadsheets'); await expect(result).not.toContainText('Work mailbox');
      const link = result.getByRole('link', { name: 'Open original saved result', exact: true });
      await expect(link).toHaveAttribute('href', new RegExp('#connections/others/access-result/' + ids.original + '/' + ids.file + '$'));
      const before = (await requests(page)).length; await activate(link);
      await expect(accessPanel(page).locator('[data-authentication-access-result]')).toHaveAttribute('data-authentication-access-result', ids.original);
      await expect(accessPanel(page)).toContainText('These are saved read results.'); await expect(compare(accessPanel(page))).toHaveCount(0);
      await expect(accessPanel(page).getByRole('button', { name: 'Review current access for this resource', exact: true })).toBeFocused();
      expect((await requests(page)).slice(before)).toEqual([{ action: 'authentication_access_status', id: ids.original }]);
    });

    test('refresh clears old evidence, waits for both saved replies and refreshes historical authentication flags', async ({ page }) => {
      const host = await go(page, 'history'); await openComparison(page, host);
      await page.evaluate(() => window.__accessComparisonFixture.current('unknown')); await hold(page);
      const before = (await requests(page)).length; await activate(compare(host));
      await expect.poll(() => pending(page)).toEqual([ids.recheck, ids.original]);
      await expect(comparison(host)).toHaveCount(0); await expect(compare(host)).toBeDisabled();
      await expect(compare(host)).toHaveAttribute('aria-expanded', 'false');
      await expect(host.getByRole('status')).toContainText('Reading saved checks for comparison…');
      await page.keyboard.press('Enter'); expect((await requests(page)).slice(before)).toEqual(readPair);
      await release(page, ids.recheck); await expect(comparison(host)).toHaveCount(0); await expect(compare(host)).toBeDisabled();
      await release(page, ids.original);
      await expect(comparison(host).locator('[data-access-comparison-after-current="unknown"]')).toHaveCount(3);
      await expect(comparison(host).locator('[data-access-comparison-after="api_read"]')).toHaveText('Passed (historical result)');
      await expect(compare(host)).toBeFocused(); expect((await requests(page)).slice(before)).toEqual(readPair);
    });

    test('inconsistent current-authentication replies remain unknown without altering either saved receipt', async ({ page }) => {
      const host = await go(page, 'history'); await page.evaluate(() => window.__accessComparisonFixture.inconsistentAuthentication());
      const result = await openComparison(page, host); const api = result.locator('[data-access-comparison-target="' + ids.api + '"]');
      await expect(api).toContainText('could not be compared consistently');
      await expect(api.locator('[data-access-comparison-before-current="unknown"]')).toHaveCount(1);
      await expect(api.locator('[data-access-comparison-after-current="unknown"]')).toHaveCount(1);
      await expect(api.locator('[data-access-comparison-after="api_read"]')).toHaveText('Passed (historical result)');
      await expect(result.locator('[data-access-comparison-target="' + ids.mail + '"] [data-access-comparison-after-current="yes"]')).toHaveCount(1);
    });

    for (const mode of ['original_missing', 'recheck_changed'] as const) test(`${mode} keeps the saved result visible and requires an explicit comparison retry`, async ({ page }) => {
      const host = await go(page, 'history'); await openComparison(page, host);
      await page.evaluate(value => window.__accessComparisonFixture.status(value), mode);
      const before = (await requests(page)).length; await activate(compare(host));
      await expect(host.getByRole('alert')).toContainText(mode === 'original_missing' ? 'The saved checks could not be read.' : 'do not form a matching original and recheck');
      await expect(host).not.toContainText('fixture-secret-token'); await expect(comparison(host)).toHaveCount(0);
      await expect(host.locator('[data-authentication-access-result]')).toHaveAttribute('data-authentication-access-result', ids.recheck);
      await expect(compare(host)).toBeFocused(); expect((await requests(page)).slice(before)).toEqual(readPair);
      await page.evaluate(() => window.__accessComparisonFixture.status('current'));
      await openComparison(page, host);
    });

    for (const focus of ['inside', 'outside'] as const) test(`a delayed comparison preserves focus moved ${focus} the history result`, async ({ page }) => {
      const host = await go(page, 'history'); await hold(page); await activate(compare(host));
      await expect.poll(() => pending(page)).toHaveLength(2);
      const next = focus === 'inside' ? host.locator('[data-incident-recheck-access]') : route(page).getByRole('link', { name: 'Calendar', exact: true });
      await next.focus(); await expect(next).toBeFocused(); await release(page);
      await expect(comparison(host)).toBeVisible(); await expect(next).toBeFocused(); await expect(page).toHaveURL(/#connections\/others\/incident-history$/);
    });

    for (const view of ['panel', 'bulk'] as const) test(`closing a pending ${view} comparison cannot overwrite the next view or steal its focus`, async ({ page }) => {
      const host = await go(page, view); await hold(page); await activate(compare(host));
      await expect.poll(() => pending(page)).toHaveLength(2);
      await activate(host.locator(view === 'bulk' ? '[data-bulk-access-action="close"]' : '[data-authentication-access-action="close"]'));
      if (view === 'panel') {
        await expect(historyRow(page).locator('[data-incident-view-access]')).toBeFocused();
        await activate(historyRow(page, ids.original).locator('[data-incident-view-access]'));
        const close = accessPanel(page).locator('[data-authentication-access-action="close"]'); await close.focus(); await release(page);
        await expect(accessPanel(page).locator('[data-authentication-access-result]')).toHaveAttribute('data-authentication-access-result', ids.original);
        await expect(comparison(accessPanel(page))).toHaveCount(0); await expect(close).toBeFocused();
      } else {
        const trigger = route(page).locator('[data-reconnect-worklist-action="bulk-access"]'); await expect(trigger).toBeFocused(); await activate(trigger);
        const search = bulkPanel(page).getByRole('searchbox'); await expect(search).toBeFocused(); await search.fill('Work'); await release(page);
        await expect(bulkPanel(page)).toHaveAttribute('data-bulk-access', 'idle'); await expect(search).toHaveValue('Work'); await expect(search).toBeFocused();
        await expect(comparison(bulkPanel(page))).toHaveCount(0);
      }
    });

    test('leaving history discards late comparison replies even after a new history view opens', async ({ page }) => {
      const host = await go(page, 'history'); await hold(page); await activate(compare(host));
      await expect.poll(() => pending(page)).toHaveLength(2);
      await activate(route(page).getByRole('link', { name: 'Calendar', exact: true })); await expect(page).toHaveURL(/#connections\/calendar$/);
      await expect(route(page).getByRole('link', { name: 'Calendar', exact: true })).toHaveAttribute('aria-current', 'page');
      await page.goBack(); await expect(compare(historyRow(page))).toBeEnabled();
      const refresh = route(page).getByRole('button', { name: 'Refresh history', exact: true }); await refresh.focus(); await release(page);
      await expect(comparison(route(page))).toHaveCount(0); await expect(refresh).toBeFocused(); await expect(compare(historyRow(page))).toHaveText('Compare with original check');
    });

    test('a stopped batch offers comparison only after its issued recheck returns', async ({ page }) => {
      const host = await go(page, 'bulk', true); await expect(compare(host)).toHaveCount(0);
      await page.evaluate(() => window.__accessComparisonFixture.releaseReplies('authentication_access_run'));
      await expect(compare(host)).toBeEnabled(); await expect(host).toHaveAttribute('data-bulk-access', 'stopped');
      await openComparison(page, host); await expect(host).toHaveAttribute('data-bulk-access', 'stopped');
      expect((await requests(page)).filter(r => r.action === 'authentication_access_run')).toHaveLength(1);
    });
  });
}
