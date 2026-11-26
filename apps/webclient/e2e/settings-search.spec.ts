import { expect, test } from '@playwright/test';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { installFullAppHooks } from './helpers/full-app.js';
import { openSettingsSearch, findSettings, settingResults, settingQuery, settingType, settingHits, settingHit, foundSetting } from './helpers/settings-search-fixture.js';
let external: string[] = [];
test.beforeEach(async ({ page }) => {
  external = []; await page.route('**/*', route => new URL(route.request().url()).origin === HARNESS_ORIGIN ? route.continue() : (external.push(route.request().url()), route.abort()));
});
installFullAppHooks();
test.afterEach(async ({ page }) => {
  expect(external).toEqual([]);
  expect(await page.evaluate(() => window.__settingsSearch?.calls.filter(call => ['execute', 'chat.send', 'notification.quiet_hours.set', 'server.timezone.set', 'server.setConfigField'].includes(call.method)) ?? [])).toEqual([]);
});

test('finds setting names and aliases in All and Settings without mounting Settings or reading its form values', async ({ page }) => {
  await openSettingsSearch(page);
  const reads = await page.evaluate(() => window.__app.rpcCallCount('notification.quiet_hours.get'));
  await settingQuery(page).fill('DND'); await expect(settingHit(page, 'quiet-hours')).toBeVisible(); await expect(settingType(page)).toHaveValue('all');
  for (const [query, id] of [['time zone', 'timezone'], ['daily budget', 'ai-budget'], ['défault model', 'default-model']]) {
    await findSettings(page, query!); await expect(settingHit(page, id!)).toBeVisible();
  }
  await findSettings(page, 'private-api-key-value'); await expect(settingHits(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('notification.quiet_hours.get'))).toBe(reads);
  await expect(page.locator('[data-recued-settings-route]')).toHaveCount(0);
  await settingQuery(page).fill(''); await expect(settingHit(page, 'timezone')).toBeVisible(); await expect(settingHit(page, 'quiet-hours')).toBeVisible();
  await settingType(page).selectOption('mail'); await expect(settingResults(page)).toHaveCount(0);
});

test('opens exact panels, nested tabs and backup disclosures and returns to the selected search row', async ({ page }) => {
  await openSettingsSearch(page);
  for (const [query, id, section] of [['DND', 'quiet-hours', 'notifications'], ['timezone', 'timezone', 'server'], ['daily budget', 'ai-budget', 'ai-models'],
    ['default model', 'default-model', 'ai-models'], ['automatic backups', 'automatic-backups', 'backup']]) {
    await findSettings(page, query!); await settingHit(page, id!).press('Enter'); await expect(page).toHaveURL(new RegExp(`#settings/${section}/find/${id}$`));
    await expect(foundSetting(page, id!)).toBeFocused(); await expect(foundSetting(page, id!)).toBeVisible();
    if (id === 'timezone') await expect(page.locator('[data-recued-settings-subtab="timezone"]')).toHaveAttribute('aria-selected', 'true');
    if (id === 'default-model') await expect(page.locator('[data-recued-ai-models-tab="preference"]')).toHaveAttribute('aria-selected', 'true');
    if (id === 'automatic-backups') await expect(foundSetting(page, id)).toHaveJSProperty('open', true);
    await expect(page.locator('[data-settings-search-return]')).toHaveAttribute('href', '#data/search'); await page.locator('[data-settings-search-return]').click();
    await expect(settingQuery(page)).toHaveValue(query!); await expect(settingType(page)).toHaveValue('setting'); await expect(settingHit(page, id!)).toBeFocused();
  }
});

test('saves a Settings finder and restores phone scroll and focus through Back and browser Back/Forward', async ({ page }, info) => {
  await openSettingsSearch(page, { width: 390 }); await settingType(page).selectOption('setting');
  const tools = page.locator('[data-saved-data-views]'); await tools.getByRole('button', { name: 'Save current view', exact: true }).click();
  await tools.getByLabel('View name', { exact: true }).fill('Find a setting'); await tools.getByRole('button', { name: 'Save view', exact: true }).click(); await expect(tools.locator('[data-view-notice]')).toContainText('Saved');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-saved-data-views') ?? '[]').at(-1)); expect(saved.definition).toEqual({ tab: 'search', query: '', result_type: 'setting' });
  await page.evaluate(hash => window.__app.setHash(hash), '#views/' + saved.id); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(settingHit(page, 'timezone')).toBeVisible();
  const scroll = () => settingHit(page, 'timezone').evaluate(element => { for (let node = element.parentElement; node; node = node.parentElement)
    if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node.scrollTop;
    return document.scrollingElement?.scrollTop ?? 0; });
  for (const browserBack of [false, true]) {
    await settingHit(page, 'timezone').scrollIntoViewIfNeeded(); await settingHit(page, 'timezone').focus(); const before = await scroll(); expect(before).toBeGreaterThan(0); await page.keyboard.press('Enter');
    await expect(foundSetting(page, 'timezone')).toBeFocused(); await expect(page.locator('[data-settings-search-return]')).toHaveAttribute('href', '#views/' + saved.id);
    if (browserBack) await page.goBack(); else await page.locator('[data-settings-search-return]').click();
    await expect(settingType(page)).toHaveValue('setting'); await expect(settingQuery(page)).toHaveValue(''); await expect(settingHit(page, 'timezone')).toBeFocused();
    await expect.poll(async () => Math.abs(await scroll() - before)).toBeLessThanOrEqual(2);
    if (browserBack) { await page.goForward(); await expect(foundSetting(page, 'timezone')).toBeFocused(); await page.goBack(); await expect(settingHit(page, 'timezone')).toBeFocused(); }
  }
  await page.screenshot({ path: info.outputPath('settings-search-phone.png'), animations: 'disabled' }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('retiring edits blocks old links during debounce and the selected type controls which settings can open', async ({ page }) => {
  await openSettingsSearch(page); await findSettings(page, 'DND');
  await settingQuery(page).fill('timezone');
  await expect(settingHit(page, 'quiet-hours')).toHaveAttribute('aria-disabled', 'true'); await settingHit(page, 'quiet-hours').dispatchEvent('click'); await expect(page).toHaveURL(/#data\/search$/u);
  await expect(settingHit(page, 'timezone')).toBeVisible(); await expect(settingResults(page)).toHaveAttribute('aria-busy', 'false'); await expect(settingQuery(page)).toBeFocused();
  await settingType(page).selectOption('file'); await expect(settingResults(page)).toHaveCount(0); await settingType(page).selectOption('setting'); await expect(settingHit(page, 'timezone')).toBeVisible();
});

test('honors client-disabled features and retires return context after native Settings navigation', async ({ page }) => {
  await openSettingsSearch(page); await findSettings(page, 'devices'); await expect(settingHit(page, 'devices')).toHaveCount(0);
  await openSettingsSearch(page, { devices: true }); await findSettings(page, 'devices'); await expect(settingHit(page, 'devices')).toBeVisible();
  await findSettings(page, 'DND'); await settingHit(page, 'quiet-hours').press('Enter'); await expect(foundSetting(page, 'quiet-hours')).toBeFocused();
  const start = page.getByLabel('Quiet hours start', { exact: true }); await start.fill('23:30');
  const finder = page.getByRole('searchbox', { name: 'Find a setting', exact: true }); await finder.fill('timezone'); await finder.press('Enter');
  await expect(foundSetting(page, 'timezone')).toBeFocused(); await expect(page.locator('[data-settings-search-return]')).toHaveCount(0);
  await page.goBack(); await expect(foundSetting(page, 'quiet-hours')).toBeFocused(); await expect(start).toHaveValue('23:30');
});

test('pending native availability cannot steal focus after the owner moves on or returns to Search', async ({ page }) => {
  await openSettingsSearch(page); await findSettings(page, 'agenda'); await page.evaluate(() => window.__app.holdRpcResponses?.('yours.agenda'));
  await settingHit(page, 'agenda').press('Enter'); await expect(page.locator('[data-situation-agenda]')).toBeHidden();
  const finder = page.getByRole('searchbox', { name: 'Find a setting', exact: true }); await finder.fill('quiet hours');
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.agenda') ?? 0)).toBeGreaterThan(0);
  await expect(finder).toBeFocused(); await expect(finder).toHaveValue('quiet hours'); await expect(foundSetting(page, 'agenda')).toHaveCount(0);
  await page.locator('[data-settings-search-return]').click(); await expect(settingQuery(page)).toHaveValue('agenda'); await expect(settingHit(page, 'agenda')).toBeFocused();
});
