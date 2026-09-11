import { expect, test } from '@playwright/test';

const base = 'http://127.0.0.1:4319/full-app-harness.html?recipe_simulation=1';
const status = '[data-recued-recipe-test-status]';
test('the paired Kitchen route sends the authored sample to the server and renders its result', async ({ page }) => {
  await page.goto(`${base}#kitchen/recipe/sample-test`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipe-test] > summary').click();
  await page.locator('[data-recued-recipe-editor-field="test_sample"]').fill('{"config":{"items":[1,2,3,4]}}');
  await page.locator('[data-recued-recipe-test-run]').click();
  await expect(page.locator(status)).toHaveText('Test passed');
  expect(await page.evaluate(() => window.__app.rpcCallCount('recipe.simulate'))).toBe(1);
  await page.locator('[data-recued-recipe-test-step="count"]').click();
  await expect(page.locator('[data-recued-recipe-test-step="count"]').locator('..').locator('pre').last()).toHaveText('4');
  expect(await page.evaluate(() => window.__app.rpcCallCount('recipe.save'))).toBe(0);
});

test('cancelling a paired sample test sends cancellation and ignores a late response', async ({ page }) => {
  await page.goto(`${base}&hold_rpc=recipe.simulate#kitchen/recipe/sample-test`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipe-test] > summary').click();
  await page.locator('[data-recued-recipe-test-run]').click();
  await expect(page.locator(status)).toHaveText('Testing…');
  await page.getByRole('button', { name: 'Cancel test', exact: true }).click();
  await expect(page.locator(status)).toHaveText('Test cancelled');
  await expect(page.locator('[data-recued-recipe-test-run]')).toBeFocused();
  expect(await page.evaluate(() => window.__app.rpcCallCount('recipe.simulate.cancel'))).toBe(1);
  await page.evaluate(() => window.__app.releaseRpcResponses?.('recipe.simulate'));
  await expect(page.locator(status)).toHaveText('Test cancelled');
  await expect(page.locator('[data-recued-recipe-test-step]')).toHaveCount(0);
});
