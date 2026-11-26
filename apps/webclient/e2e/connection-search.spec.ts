import { expect, test } from '@playwright/test';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { installFullAppHooks } from './helpers/full-app.js';
import { openConnectionSearch, findConnections, connectionResults, connectionQuery, connectionType, connectionHits, connectionHit, refreshConnections, connectionNotice } from './helpers/connection-search-fixture.js';
let external: string[] = [];
test.beforeEach(async ({ page }) => {
  external = [];
  await page.route('**/*', route => new URL(route.request().url()).origin === HARNESS_ORIGIN ? route.continue() : (external.push(route.request().url()), route.abort()));
});
installFullAppHooks();
test.afterEach(async ({ page }) => {
  expect(external).toEqual([]);
  expect(await page.evaluate(() => window.__connectionSearch?.calls.filter(call => call.method === 'execute'
    || /(?:\.probe|\.enroll|\.rotate|\.reauthorize|\.send|\.remove|\.update|\.upsert|\.sync|\.startVendorOAuth|\.completeVendorOAuth)/i.test(call.method)
    || call.method === 'collection.connection.managedOAuth' && /prepare|reauthoriz|switch|start|apply|save|enroll|probe|review_direct/.test(String((call.args as { action?: string })?.action))) ?? [])).toEqual([]);
});

test('finds providers, account emails, IDs and literal Unicode names in All and Connections without indexing private configuration', async ({ page }) => {
  await openConnectionSearch(page); await connectionQuery(page).fill('example.org'); await expect(connectionHits(page)).toHaveCount(1);
  await expect(connectionType(page)).toHaveValue('all'); await expect(connectionResults(page)).toContainText('Initial import complete');
  for (const [query, count] of [['work', 3], ['gmail work@example.org', 1], ['Google', 1], ['Local folder', 1], ['projects/one', 1], ['hubspot', 1], ['private-', 0]]) {
    await findConnections(page, query as string); await expect(connectionHits(page)).toHaveCount(count as number);
  }
  await page.evaluate(() => { window.__connectionSearch.api[0]!.display_name = 'Café ﬁle <img.*>'; });
  await findConnections(page, 'CAFÉ FILE <img.*>'); await expect(connectionHits(page)).toHaveCount(1);
  await expect(connectionResults(page).locator('img')).toHaveCount(0); await expect(connectionHits(page)).toContainText('Recorded health: sign-in failed');
  await connectionQuery(page).fill(''); await expect(connectionHits(page)).toHaveCount(5);
  await connectionType(page).selectOption('mail'); await expect(connectionResults(page)).toHaveCount(0);
});

test('opens each exact native account or API panel and restores the query, selected type and focus', async ({ page }) => {
  await openConnectionSearch(page);
  for (const [query, href, heading] of [['gmail', '#connections/mail/work', 'work'], ['gcal', '#connections/calendar/work', 'work'],
    ['Local folder', '#connections/file/work', 'work'], ['projects/one', '#connections/file/remote%3Aprojects%2Fone', 'Project files'],
    ['crm', '#connections/others/review-access/api/crm', '']]) {
    await findConnections(page, query!); const hit = connectionHit(page, href!); await expect(hit).toBeVisible(); await hit.press('Enter');
    await expect(page).toHaveURL(new RegExp(href!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
    if (heading) await expect(page.locator('[data-accounts-detail-heading]')).toHaveText(heading);
    else await expect(page.locator('[data-connection-dialog-heading]')).toBeVisible();
    await page.locator('[data-search-connection-return]').click();
    await expect(connectionQuery(page)).toHaveValue(query!); await expect(connectionType(page)).toHaveValue('connection'); await expect(connectionHit(page, href!)).toBeFocused();
  }
});

test('keeps Saved Views, all loaded rows, phone scroll and exact focus through Back and browser Back/Forward', async ({ page }, info) => {
  await openConnectionSearch(page, { width: 390, count: 25 }); await findConnections(page, 'gmail');
  const tools = page.locator('[data-saved-data-views]'); await tools.getByRole('button', { name: 'Save current view', exact: true }).click();
  await tools.getByLabel('View name', { exact: true }).fill('Work mail accounts'); await tools.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(tools.locator('[data-view-notice]')).toContainText('Saved');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-saved-data-views') ?? '[]').at(-1));
  expect(saved.definition).toEqual({ tab: 'search', query: 'gmail', result_type: 'connection' });
  await page.evaluate(hash => window.__app.setHash(hash), '#views/' + saved.id); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(connectionType(page)).toHaveValue('connection'); await expect(connectionHits(page)).toHaveCount(25);
  const hit = connectionHit(page, '#connections/mail/work-24');
  const scroll = () => hit.evaluate(element => { for (let node = element.parentElement; node; node = node.parentElement)
    if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node.scrollTop;
    return document.scrollingElement?.scrollTop ?? 0; });
  for (const browserBack of [false, true]) {
    await hit.scrollIntoViewIfNeeded(); await hit.focus(); const before = await scroll(); expect(before).toBeGreaterThan(0); await page.keyboard.press('Enter');
    await expect(page.locator('[data-accounts-detail-heading]')).toHaveText('work-24');
    await expect(page.locator('[data-search-connection-return]')).toHaveAttribute('href', '#views/' + saved.id);
    const reads = await page.evaluate(() => window.__connectionSearch.calls.filter(call => call.method === 'collection.mail.list').length);
    if (browserBack) await page.goBack(); else await page.locator('[data-search-connection-return]').click();
    await expect(hit).toBeFocused(); await expect(connectionQuery(page)).toHaveValue('gmail'); await expect(connectionHits(page)).toHaveCount(25);
    await expect.poll(async () => Math.abs(await scroll() - before)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.__connectionSearch.calls.filter(call => call.method === 'collection.mail.list').length)).toBe(reads);
    if (browserBack) { await page.goForward(); await expect(page.locator('[data-accounts-detail-heading]')).toHaveText('work-24'); await page.goBack(); await expect(hit).toBeFocused(); }
  }
  await page.screenshot({ path: info.outputPath('connection-search-phone.png'), animations: 'disabled' });
});

test('keeps good inventories through failures, reports unavailable sources and retries without a false empty or cloud-search offer', async ({ page }) => {
  await openConnectionSearch(page); await page.evaluate(() => { window.__connectionSearch.unsupported = ['collection.calendar.list']; window.__connectionSearch.failing = ['collection.mail.list']; });
  await findConnections(page, 'work'); await expect(connectionHits(page)).toHaveCount(1);
  await expect(connectionResults(page)).toContainText('Calendar accounts: unavailable'); await expect(connectionResults(page)).toContainText('Mail accounts: could not be read');
  await findConnections(page, 'unmatched'); await expect(connectionHits(page)).toHaveCount(0);
  await expect(page.locator('.rq-search')).not.toContainText('No matches in the searched sources'); await expect(connectionResults(page)).not.toContainText('private-provider-error');
  await connectionType(page).selectOption('all'); await expect(page.locator('.rq-search')).not.toContainText('Search the Marketplace');
  await page.locator('.rq-sources > summary').click();
  await page.evaluate(() => { window.__connectionSearch.failing = []; window.__connectionSearch.unsupported = []; }); await refreshConnections(page).click();
  await findConnections(page, 'work'); await expect(connectionHits(page)).toHaveCount(3);
});

test('refuses changed or removed selections and retires held exact checks after edits, type changes and navigation', async ({ page }) => {
  await openConnectionSearch(page); await findConnections(page, 'gmail'); const hit = connectionHit(page, '#connections/mail/work');
  await page.evaluate(() => { window.__connectionSearch.mail[0]!.account_email = 'replacement@example.org'; }); await hit.press('Enter');
  await expect(connectionNotice(page)).toContainText('could not be confirmed'); await expect(connectionNotice(page)).toBeFocused(); await expect(page).toHaveURL(/#data\/search$/u);
  await refreshConnections(page).click();
  for (const boundary of ['space', 'type', 'leave']) {
    await page.evaluate(() => { window.__connectionSearch.held = ['collection.mail.list']; }); await hit.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__connectionSearch.pending('collection.mail.list'))).toBeGreaterThan(0);
    if (boundary === 'space') await connectionQuery(page).fill('gmail ');
    else if (boundary === 'type') await connectionType(page).selectOption('file');
    else await page.evaluate(() => window.__app.setHash('#data/task'));
    await page.evaluate(() => { window.__connectionSearch.held = []; window.__connectionSearch.release('collection.mail.list'); });
    await expect(page).toHaveURL(boundary === 'leave' ? /#data\/task$/u : /#data\/search$/u);
    if (boundary === 'space') { await expect(connectionQuery(page)).toBeFocused(); await expect(connectionResults(page)).toHaveAttribute('aria-busy', 'false'); }
    if (boundary === 'type') await connectionType(page).selectOption('connection');
  }
});

test('a slow unrelated inventory keeps confirmed accounts usable and a late reply cannot reopen Search', async ({ page }) => {
  await openConnectionSearch(page);
  await page.evaluate(() => { window.__connectionSearch.held = ['data.file.attachments.sources']; });
  await connectionQuery(page).fill('gmail'); await connectionType(page).selectOption('connection');
  await expect.poll(() => page.evaluate(() => window.__connectionSearch.pending('data.file.attachments.sources'))).toBeGreaterThan(0);
  await expect(connectionResults(page)).toHaveAttribute('aria-busy', 'true');
  const hit = connectionHit(page, '#connections/mail/work'); await expect(hit).toBeVisible(); await expect(hit).not.toHaveAttribute('aria-disabled', 'true');
  await hit.press('Enter'); await expect(page.locator('[data-accounts-detail-heading]')).toHaveText('work');
  await page.evaluate(() => { window.__connectionSearch.held = []; window.__connectionSearch.release('data.file.attachments.sources'); });
  await expect(page.locator('[data-accounts-detail-heading]')).toHaveText('work'); await expect(connectionResults(page)).toHaveCount(0);
  await page.locator('[data-search-connection-return]').click(); await expect(connectionQuery(page)).toHaveValue('gmail');
  await expect(connectionHit(page, '#connections/mail/work')).toBeFocused();
});

test('opening OAuth API review does not prepare authentication, and unrelated native navigation retires the return link', async ({ page }) => {
  await openConnectionSearch(page, { oauth: true }); await findConnections(page, 'crm');
  await connectionHit(page, '#connections/others/review-access/api/crm').press('Enter'); await expect(page.locator('[data-connection-dialog-heading]')).toBeVisible();
  await expect(page.locator('[data-manage-authentication-heading]')).toHaveCount(0);
  await expect(page.locator('[data-search-connection-return]')).toBeVisible();
  await page.locator('[data-action="connections-cancel-dialog"]').click(); await expect(page.locator('[data-search-connection-return]')).toHaveCount(0);
  await page.goBack(); await expect(connectionQuery(page)).toBeVisible();
  await findConnections(page, 'gmail'); await connectionHit(page, '#connections/mail/work').press('Enter');
  await page.getByRole('button', { name: 'Back', exact: true }).click(); await expect(page).toHaveURL(/#connections\/mail$/u);
  await expect(page.locator('[data-search-connection-return]')).toHaveCount(0);
});
