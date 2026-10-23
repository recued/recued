import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
type Surface = 'recipes' | 'packs';
const recipeId = (surface: Surface) => surface === 'recipes' ? 'autorun-live-1' : 'installed-mail-digest';
const run = async (page: Page, surface: Surface, useDialog = false) => {
  if (surface === 'recipes' && !useDialog) {
    await page.locator('[data-recued-recipes-action="run-defaults"]').click();
  } else {
    if (surface === 'recipes') {
      await page.locator('[data-recued-recipes-action="open-run"]').filter({ hasText: /^Run$/ }).click();
    } else {
      await page.locator('[data-recued-pack-app-operation="installed-mail-digest"]').click();
    }
    const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
    await dialog.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Run completed');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  }
  await expect(page.locator('.recipes-result-panel [data-recued-run-summary]')).toBeVisible();
};
const openResult = async (page: Page, surface: Surface, recorded = true, resultKind = 'copyable') => {
  const query = `recipe_result=${resultKind}${recorded ? '&recipe_run_log=1' : ''}`;
  await page.goto(surface === 'recipes'
    ? `${HARNESS_URL}?recipes=installed&recipe_default_run=1&${query}#recipes`
    : `${HARNESS_URL}?packs=installed&${query}#packs/installed-mail`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (surface === 'recipes') {
    await page.locator('[data-recued-recipes-card="autorun-live-1"]')
      .getByRole('button', { name: /Open .+ details/ }).click();
  }
  if (surface === 'packs' && resultKind === 'editable-grid') {
    await expect(page.locator('.recipes-result-panel [data-recued-run-summary]')).toBeVisible();
  } else {
    await run(page, surface, resultKind === 'editable-grid');
  }
  return page.locator('.recipes-result-panel');
};

for (const surface of ['recipes', 'packs'] as const) {
  for (const width of [375, 1280]) {
    test(`${surface} opens its exact run in Logs by keyboard at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const panel = await openResult(page, surface);
      const link = panel.getByRole('link', { name: 'Open this run in Logs', exact: true });
      const runId = `run-${recipeId(surface)}-1`;
      await expect(link).toHaveAttribute('href', `#logs/${runId}`);
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(width === 375 ? 44 : 36);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await link.focus();
      await expect(link).toBeFocused();
      await link.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath('result-run-link.png') });
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`#logs/${runId}$`));
      const detail = page.locator('[data-recued-logs-detail]');
      await expect(detail).toContainText(runId);
      await expect(detail).toContainText(recipeId(surface));
      await expect(detail).not.toContainText('Loading');
      expect(await page.evaluate(() => window.__app.rpcCallCount('execution.get'))).toBeGreaterThan(0);
    });
  }

  test(`${surface} omits the exact-run link on an unaudited response`, async ({ page }) => {
    const panel = await openResult(page, surface, false);
    await expect(panel.getByRole('link', { name: 'Open this run in Logs', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Copy run summary', exact: true })).toBeVisible();
  });

  test(`${surface} keeps table edits when leaving for Logs is declined`, async ({ page }) => {
    const panel = await openResult(page, surface, true, 'editable-grid');
    const amount = panel.locator('[data-recued-recipes-result-grid-cell="0:amount"]');
    await amount.fill('125.00');
    await expect(panel.locator('.recipes-result-grid-status')).toHaveText('1 row · Unsaved changes');
    const link = panel.getByRole('link', { name: 'Open this run in Logs', exact: true });
    const target = (await link.getAttribute('href'))!;
    const runId = target.slice('#logs/'.length);
    const previousHash = new URL(page.url()).hash;
    const executeCalls = await page.evaluate(() => window.__app.rpcCallCount('execute'));
    const declinePrompt = new Promise<string>(resolve => page.once('dialog', async dialog => {
      resolve(dialog.message());
      await dialog.dismiss();
    }));
    await link.click();
    expect(await declinePrompt).toBe(surface === 'recipes'
      ? 'You have changes you have not saved. Leave anyway?'
      : 'This pack result has unsaved table changes. Leave Packs anyway?');
    await expect.poll(() => new URL(page.url()).hash).toBe(previousHash);
    await expect(amount).toHaveValue('125.00');
    await expect(panel.locator('.recipes-result-grid-status')).toHaveText('1 row · Unsaved changes');
    expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(executeCalls);
    expect(await page.evaluate(() => window.__app.rpcCallCount('execution.get'))).toBe(0);

    page.once('dialog', dialog => dialog.accept());
    await link.click();
    await expect.poll(() => new URL(page.url()).hash).toBe(target);
    await expect(page.locator('[data-recued-logs-detail]')).toContainText(runId);
  });
}

test('running again replaces the Logs target with the current response anchor', async ({ page }) => {
  const panel = await openResult(page, 'recipes');
  const link = panel.getByRole('link', { name: 'Open this run in Logs', exact: true });
  await expect(link).toHaveAttribute('href', '#logs/run-autorun-live-1-1');
  await run(page, 'recipes');
  await expect(link).toHaveAttribute('href', '#logs/run-autorun-live-1-2');
  await link.click();
  await expect(page.locator('[data-recued-logs-detail]')).toContainText('run-autorun-live-1-2');
});
