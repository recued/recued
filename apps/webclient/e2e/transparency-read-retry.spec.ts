import { expect, test, type Page } from '@playwright/test';

const panel = (page: Page) => page.locator('[data-recued-transparency-panel]');
const retry = (page: Page) => page.getByRole('button', { name: 'Retry transparency settings', exact: true });
const status = (page: Page) => page.locator('[data-recued-transparency-load-status]');
const master = (page: Page) => page.locator('[data-recued-transparency-toggle="ui.transparency.enabled"]');
const orchestration = (page: Page) => page.locator('[data-recued-transparency-toggle="ui.transparency.class.orchestration"]');
const tier = (page: Page) => page.locator('[data-recued-transparency-tier]');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside panel', exact: true });
const release = (page: Page, kind: 'read' | 'save', index = 0, outcome: 'success' | 'error' = 'success') =>
  page.evaluate(({ kind, index, outcome }) => window.__transparencyReadRetry.release(kind, index, outcome), { kind, index, outcome });
const reads = (page: Page) => page.evaluate(() => window.__transparencyReadRetry.calls.filter(call => call.kind === 'read').length);
const writes = (page: Page) => page.evaluate(() => window.__transparencyReadRetry.calls.filter(call => call.kind === 'save'));
const open = async (page: Page, width: number, failed = true) => {
  await page.setViewportSize({ width, height: 900 }); await page.goto('/transparency-read-retry-harness.html');
  await page.waitForFunction(() => window.__transparencyReadRetry !== undefined);
  await expect(status(page)).toHaveText('Loading transparency settings…'); await expect(retry(page)).toBeHidden();
  if (failed) { await release(page, 'read', 0, 'error'); await expect(status(page)).toHaveAttribute('role', 'alert'); }
};
const activate = async (page: Page) => { await retry(page).focus(); await page.keyboard.press('Enter'); };
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

for (const width of [390, 1280]) {
  test(`Transparency recovers a failed read in place and keeps Retry focused while pending at ${width}px`, async ({ page }) => {
    await open(page, width);
    const button = await retry(page).elementHandle();
    await activate(page);
    await expect(status(page)).toHaveText('Retrying transparency settings…'); await expect(status(page)).toHaveAttribute('role', 'status');
    await expect(retry(page)).toHaveAttribute('aria-disabled', 'true'); await expect(retry(page)).toHaveAttribute('aria-busy', 'true');
    await expect(retry(page)).not.toHaveAttribute('disabled'); await expect(retry(page)).toBeFocused();
    await retry(page).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    expect(await reads(page)).toBe(2); expect(await writes(page)).toEqual([]);
    expect(await page.evaluate(() => window.__transparencyReadRetry.hasInFlightWork())).toBe(false);
    expect(await button!.evaluate(node => node.isConnected && node === document.querySelector('[data-recued-transparency-retry]'))).toBe(true);
    await release(page, 'read', 1);
    await expect(master(page)).toBeFocused(); await expect(master(page)).toBeChecked(); await expect(orchestration(page)).toBeChecked();
    await expect(tier(page)).toHaveValue('none'); await expect(retry(page)).toHaveCount(0);
    await expect(panel(page).locator('[data-recued-transparency-failure-row] input')).toBeDisabled();
    await expect(panel(page).locator('[data-recued-transparency-failure-row] input')).toBeChecked();
    expect(await writes(page)).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`Transparency keeps repeated failures actionable and restores focus after a later success at ${width}px`, async ({ page }) => {
    await open(page, width); const button = await retry(page).elementHandle(); await activate(page);
    await release(page, 'read', 1, 'error');
    await expect(retry(page)).toBeFocused(); await expect(retry(page)).toHaveAttribute('aria-disabled', 'false');
    await expect(retry(page)).toHaveAttribute('aria-busy', 'false'); await expect(status(page)).toHaveAttribute('role', 'alert');
    expect(await button!.evaluate(node => node.isConnected && node === document.querySelector('[data-recued-transparency-retry]'))).toBe(true);
    await page.keyboard.press('Enter'); expect(await reads(page)).toBe(3); await release(page, 'read', 2);
    await expect(master(page)).toBeFocused(); expect(await writes(page)).toEqual([]);
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`Transparency retry ${outcome} respects focus moved outside at ${width}px`, async ({ page }) => {
      await open(page, width); await activate(page); await outside(page).focus(); await release(page, 'read', 1, outcome);
      await expect(outside(page)).toBeFocused();
      if (outcome === 'success') { await expect(master(page)).toBeVisible(); await expect(retry(page)).toHaveCount(0); }
      else { await expect(retry(page)).toBeVisible(); await expect(retry(page)).toHaveAttribute('aria-disabled', 'false'); }
      expect(await reads(page)).toBe(2); expect(await writes(page)).toEqual([]);
    });

    test(`Transparency ignores a disposed retry ${outcome} reply at ${width}px`, async ({ page }) => {
      await open(page, width); const button = await retry(page).elementHandle(); await activate(page); await outside(page).focus();
      await page.evaluate(() => window.__transparencyReadRetry.dispose());
      await button!.evaluate((node: HTMLButtonElement) => node.click()); await release(page, 'read', 1, outcome);
      await expect(page.locator('#panel')).toBeEmpty(); await expect(page.locator('#panel')).not.toHaveAttribute('data-recued-transparency-panel');
      await expect(outside(page)).toBeFocused(); expect(await reads(page)).toBe(2); expect(await writes(page)).toEqual([]);
    });
  }

  test(`Transparency initial success leaves outside focus and needs no retry at ${width}px`, async ({ page }) => {
    await open(page, width, false); await outside(page).focus(); await release(page, 'read');
    await expect(outside(page)).toBeFocused(); await expect(master(page)).toBeVisible(); await expect(retry(page)).toHaveCount(0);
    expect(await reads(page)).toBe(1); expect(await writes(page)).toEqual([]);
  });

  test(`Transparency retains recovered preferences and the write guard after a save failure at ${width}px`, async ({ page }) => {
    await open(page, width); const oldRetry = await retry(page).elementHandle(); await activate(page); await release(page, 'read', 1);
    await master(page).focus(); await page.keyboard.press('Space');
    await expect(master(page)).toHaveAttribute('aria-busy', 'true'); await expect(master(page)).toBeFocused();
    expect(await page.evaluate(() => window.__transparencyReadRetry.hasInFlightWork())).toBe(true);
    await oldRetry!.evaluate((node: HTMLButtonElement) => node.click());
    expect(await reads(page)).toBe(2); expect(await writes(page)).toEqual([{ kind: 'save', patch: { 'ui.transparency.enabled': false } }]);
    await outside(page).focus(); await release(page, 'save', 0, 'error');
    await expect(outside(page)).toBeFocused(); await expect(master(page)).toBeChecked(); await expect(orchestration(page)).toBeChecked();
    await expect(tier(page)).toHaveValue('none'); await expect(panel(page).locator('[data-recued-transparency-error]')).toContainText('Could not save:');
    expect(await page.evaluate(() => window.__transparencyReadRetry.hasInFlightWork())).toBe(false);
    await oldRetry!.evaluate((node: HTMLButtonElement) => node.click());
    expect(await reads(page)).toBe(2); expect(await writes(page)).toHaveLength(1); await expect(retry(page)).toHaveCount(0);
  });
}
