import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();

test('Connection recovery retries a failed Yours read, preserves a draft and detaches after leaving', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_asset_search_fail_once=1#yours/assets/search/passport`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const route = page.locator('[data-recued-yours]');
  const reconnect = () => page.evaluate(() => { window.__app.fireState('connecting'); window.__app.fireState('connected'); });
  await expect(route.getByRole('alert')).toContainText('Asset search unavailable');
  const failedReads = await page.evaluate(() => window.__app.rpcCallCount('yours.read'));
  await reconnect();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBeGreaterThan(failedReads);
  const asset = route.getByRole('link', { name: 'Ana’s passport', exact: true }); await expect(asset).toBeVisible();
  await asset.click(); await expect(route.getByRole('heading', { name: 'Ana’s passport', exact: true })).toBeVisible();
  await route.getByRole('button', { name: 'Add fact', exact: true }).click();
  await route.getByLabel('Fact name', { exact: true }).fill('length'); await route.getByLabel('Value', { exact: true }).fill('25 meters');
  const reads = await page.evaluate(() => window.__app.rpcCallCount('yours.read'));
  await reconnect();
  await expect(route.getByLabel('Value', { exact: true })).toHaveValue('25 meters');
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(reads);
  page.once('dialog', dialog => dialog.accept()); await route.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => window.__app.setHash('#chat')); await expect(route).toHaveCount(0);
  const after = await page.evaluate(() => window.__app.rpcCallCount('yours.read'));
  await reconnect();
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(after);
});

test('A text fact preserves its exact value and returns to the filtered asset list', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=summaries&yours_asset_filter_pages#yours/assets/filter/missing_facts/search/Workshop/page/2`);
  const route = page.locator('[data-recued-yours]');
  const row = route.locator('[data-yours-asset]').last();
  const id = await row.getAttribute('data-yours-asset');
  await row.getByRole('link', { name: 'Open asset', exact: true }).click();
  await expect(route.getByRole('navigation', { name: 'Yours', exact: true }).getByRole('link', { name: 'Assets', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(route.getByRole('button', { name: 'Delete asset', exact: true })).toHaveCount(0);
  await route.getByRole('button', { name: 'Add fact', exact: true }).click();
  const form = route.locator('[data-yours-editor]');
  await expect(form.getByLabel('Fact name', { exact: true })).toBeFocused();
  await expect(form.getByLabel('Observed at', { exact: true })).toHaveCount(0);
  await expect(form.getByLabel('Value type', { exact: true })).toHaveValue('Text');
  await form.getByLabel('Fact name', { exact: true }).fill('length');
  const value = '  about 25 meters\n測定は概算です  ';
  await form.getByLabel('Value', { exact: true }).fill(value);
  await form.getByRole('button', { name: 'Save fact', exact: true }).click();
  const fact = route.locator('[data-yours-fact="attributes.length"]');
  await expect(fact).toBeVisible();
  expect(await fact.evaluate(node => node.firstChild?.textContent)).toBe(value);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([{ action: 'asset.update', id, patch: { attributes: { length: value } } }]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('binding.save'))).toBe(0);
  await route.getByRole('link', { name: 'Back to assets', exact: true }).click();
  await expect(page).toHaveURL(/#yours\/assets\/filter\/missing_facts\/search\/Workshop\/page\/2$/u);
  await expect(route.getByLabel('Find assets', { exact: true })).toHaveValue('Workshop');
  await expect(route.getByLabel('Show assets', { exact: true })).toHaveValue('missing_facts');
  await expect(route.locator(`[data-yours-asset="${id}"]`).getByRole('link', { name: 'Open asset', exact: true })).toBeFocused();
});

test('A failed fact save retains the draft and retries only that fact', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_fail_once=1#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]');
  await route.getByRole('button', { name: 'Add fact', exact: true }).click();
  const form = route.locator('[data-yours-editor]');
  await form.getByLabel('Fact name', { exact: true }).fill('length');
  await form.getByLabel('Value', { exact: true }).fill('25 meters');
  const save = form.getByRole('button', { name: 'Save fact', exact: true });
  await save.focus(); await page.keyboard.press('Enter');
  await expect(route.getByRole('alert')).toContainText('unavailable');
  await expect(form.getByLabel('Value', { exact: true })).toHaveValue('25 meters');
  await expect(save).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(form).toHaveCount(0);
  await expect(route.locator('[data-yours-fact="attributes.length"]')).toContainText('25 meters');
  const writes = await page.evaluate(() => window.__assetFactWrites);
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
});

for (const crlf of [false, true]) test(`Saving an unchanged ${crlf ? 'CRLF' : 'plain'} text fact preserves its source without a read or write roundtrip`, async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_provenance=1${crlf ? '&yours_crlf_fact=1' : ''}#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); const fact = route.locator('[data-yours-fact="attributes.cover"]');
  const before = await fact.innerText(); const reads = await page.evaluate(() => window.__app.rpcCallCount('yours.read'));
  const exact = await fact.evaluate(node => node.firstChild?.textContent);
  await route.getByLabel('More actions for cover', { exact: true }).click(); await route.getByRole('button', { name: 'Edit fact', exact: true }).click();
  await route.getByRole('button', { name: 'Save fact', exact: true }).click();
  await expect(route.locator('[data-yours-editor]')).toHaveCount(0); await expect(fact).toHaveText(before, { useInnerText: true });
  expect(await fact.evaluate(node => node.firstChild?.textContent)).toBe(exact);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(reads);
});

test('A fact menu stays within the phone and restores keyboard focus after editing', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${HARNESS_URL}?yours=demo&yours_provenance=1#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]');
  const trigger = route.getByLabel('More actions for cover', { exact: true });
  await trigger.focus(); await page.keyboard.press('Enter');
  const actions = route.getByRole('group', { name: 'Actions for cover', exact: true });
  await expect(actions).toBeVisible();
  const bounds = await actions.boundingBox(); expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused(); await expect(actions).toBeHidden();
  await page.keyboard.press('Enter');
  await actions.getByRole('button', { name: 'Edit fact', exact: true }).click();
  await expect(route.getByLabel('Value', { exact: true })).toBeFocused();
  await route.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(actions.getByRole('button', { name: 'Edit fact', exact: true })).toBeFocused();
});

for (const theme of ['light', 'dark']) for (const width of [1440, 390, 320]) {
  test(`Yours views share usable navigation and fit at ${width}px in ${theme}`, async ({ page }, testInfo) => {
    await page.addInitScript(value => localStorage.setItem('recued.theme', value), theme);
    await page.setViewportSize({ width, height: width < 640 ? 844 : 1000 });
    for (const view of ['assets', 'assets/classes', 'asset/passport', 'asset/passport/view/rules', 'proposals', 'occurrences', 'occasions', 'episodes']) {
      await page.goto(`${HARNESS_URL}?yours=demo&yours_provenance=1&contact_history=1#yours/${view}`);
      const route = page.locator('[data-recued-yours]');
      await expect(route).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const nav = route.getByRole('navigation', { name: 'Yours', exact: true });
      await expect(nav.getByRole('link')).toHaveCount(5);
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
      expect(await route.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${view.replaceAll('/', '-')}-${theme}-${width}.png`), fullPage: true });
    }
  });
}
