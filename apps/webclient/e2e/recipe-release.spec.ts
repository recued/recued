import { expect,test,type Page } from '@playwright/test';
const input = (page: Page) => page.locator('[data-recued-recipe-editor-step="count"] [data-recued-recipe-editor-field="param:input"]');
const open = async (page: Page,scenario = '1') => {
  await page.goto(`/kitchen-harness.html?surface=recipe&fixture=regression&regression=1&releases=${scenario}`);
  const panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
  await expect(panel.getByRole('button',{ name: 'Start reviewed releases',exact: true })).toBeVisible(); return panel;
};
const suite = async (page: Page,assertOutput = false) => {
  const panel = page.locator('[data-recipe-regression]'); await panel.locator('summary').first().click();
  await expect(panel.getByRole('button',{ name: 'Save test version',exact: true })).toBeEnabled();
  if (assertOutput) { await panel.getByRole('button',{ name: 'Add check',exact: true }).click(); await panel.getByRole('textbox',{ name: 'Expected value (JSON)',exact: true }).fill('0'); }
  await panel.getByRole('button',{ name: 'Save test version',exact: true }).click();
  await expect(panel.locator('[data-regression-status]')).toContainText('Saved test version 1.');
};
const draft = async (page: Page) => {
  await input(page).fill('[1,2]'); await input(page).press('Tab');
  const panel = page.locator('[data-recipe-release]'); await panel.getByRole('button',{ name: 'Start reviewed releases',exact: true }).click();
  await expect(panel.locator('[data-release-status]')).toContainText('Saved release draft 1.'); return panel;
};
const review = async (page: Page) => {
  const panel = page.locator('[data-recipe-release]'); await panel.getByRole('button',{ name: 'Test saved draft',exact: true }).click();
  await expect(panel.locator('[data-release-status]')).toContainText('Saved draft passed.');
  await panel.getByRole('button',{ name: 'Review activation',exact: true }).click(); await expect(panel.locator('[data-release-review]')).toBeVisible(); return panel;
};
const activeInput = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-release-browser')!).view.active.recipe.steps[0].input);
for (const width of [280,1280]) {
  test(`drafts resume without activating and reviewed restoration follows the same tests at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); await suite(page); let panel = await draft(page);
    expect(await activeInput(page)).toEqual([]);
    await page.reload(); panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([1,2]); expect(await activeInput(page)).toEqual([]);
    await review(page); await expect(panel.locator('[data-release-review]')).toContainText('steps');
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.'); expect(await activeInput(page)).toEqual([1,2]);
    await page.reload(); panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await expect(panel.getByRole('combobox',{ name: 'Release to restore',exact: true })).toHaveValue('1');
    await panel.getByRole('combobox',{ name: 'Release to restore',exact: true }).selectOption('1');
    await panel.getByRole('button',{ name: 'Restore as draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('as draft 3');
    await expect(input(page)).toHaveValue('[]'); expect(await activeInput(page)).toEqual([1,2]);
    await expect(panel.getByRole('button',{ name: 'Review activation',exact: true })).toBeDisabled();
    await review(page); await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 3.'); expect(await activeInput(page)).toEqual([]);
    expect(await page.evaluate(() => window.__harness.recipeSaveBodies.length)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`failed assertions and working edits prevent activation at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); await suite(page,true); const panel = await draft(page);
    await panel.getByRole('button',{ name: 'Test saved draft',exact: true }).click();
    await expect(panel.locator('[data-release-results]')).toContainText('0 passed, 1 failed');
    await expect(panel.getByRole('button',{ name: 'Review activation',exact: true })).toBeDisabled(); expect(await activeInput(page)).toEqual([]);
    await input(page).fill('[]'); await input(page).press('ControlOrMeta+s');
    await expect(panel.locator('[data-release-status]')).toContainText('Saved release draft 2.');
    await review(page); await input(page).fill('[1]'); await input(page).press('Tab');
    await expect(panel.locator('[data-release-review]')).toHaveCount(0); await expect(panel.getByRole('button',{ name: 'Test saved draft',exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.__harness.recipeSaveBodies.length)).toBe(0);
  });
  test(`stable retries recover lost save and activation replies at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); let panel = await open(page,'lost-save'); await suite(page);
    await panel.getByRole('button',{ name: 'Start reviewed releases',exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Draft save reply lost');
    // The first reply can be lost before the UI learns enrollment.
    await panel.getByRole('button',{ name: 'Start reviewed releases',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Saved release draft 1.');
    await page.goto('/kitchen-harness.html?surface=recipe&fixture=regression&regression=1&releases=lost-activate');
    panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click(); await review(page);
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Activation reply lost');
    await panel.getByRole('button',{ name: 'Retry activation',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.');
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-release-browser')!).view.releases.length)).toBe(2);
  });
  test(`changing saved tests invalidates an already displayed activation review at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); await suite(page); const panel = await draft(page); await review(page);
    const tests = page.locator('[data-recipe-regression]'); await tests.getByRole('textbox',{ name: 'Case name',exact: true }).fill('Updated case');
    await tests.getByRole('button',{ name: 'Save test version',exact: true }).click();
    await expect(tests.locator('[data-regression-status]')).toContainText('Saved test version 2.');
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Saved tests changed'); expect(await activeInput(page)).toEqual([]);
  });
  test(`cancellation and edits during testing cannot activate a passing old working copy at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'slow'); await suite(page); let panel = await draft(page);
    await panel.getByRole('button',{ name: 'Test saved draft',exact: true }).click(); await panel.getByRole('button',{ name: 'Cancel release tests',exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Release tests cancelled'); await expect(panel.getByRole('button',{ name: 'Review activation',exact: true })).toBeDisabled();
    await page.goto('/kitchen-harness.html?surface=recipe&fixture=regression&regression=1&releases=defer'); panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await panel.getByRole('button',{ name: 'Test saved draft',exact: true }).click(); await input(page).fill('[1]'); await input(page).press('Tab');
    await expect(panel.locator('[data-release-status]')).toContainText('Working edits changed while tests ran');
    await expect(panel.getByRole('button',{ name: 'Review activation',exact: true })).toBeDisabled(); expect(await activeInput(page)).toEqual([]);
  });
  test(`a superseded save reply preserves the working recipe and requires a reload at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page,'peer'); await suite(page); await draft(page);
    await expect(panel.locator('[data-release-status]')).toContainText('Newer changes exist'); await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([1,2]);
    await expect(panel.getByRole('button',{ name: 'Test saved draft',exact: true })).toBeDisabled();
    await panel.getByRole('button',{ name: 'Reload saved draft',exact: true }).click(); await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([99]);
    await expect(panel.getByRole('button',{ name: 'Test saved draft',exact: true })).toBeEnabled();
    await review(page); expect(await activeInput(page)).toEqual([]);
  });
  test(`a late draft save retains unfinished JSON and the leave guard at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page,'late-save'); await suite(page);
    await input(page).fill('[1,2]'); await input(page).press('Tab');
    await panel.getByRole('button',{ name: 'Start reviewed releases',exact: true }).click();
    await input(page).fill('['); await input(page).press('Tab');
    await expect(panel.locator('[data-release-status]')).toContainText('Saved release draft 1.');
    await expect(input(page)).toHaveValue('[');
    await expect(page.locator('[data-recued-recipe-editor-dirty]')).toContainText('Unsaved');
    await expect(panel.getByRole('button',{ name: 'Test saved draft',exact: true })).toBeDisabled(); expect(await activeInput(page)).toEqual([]);
  });
  test(`a late reload preserves edits made while the private draft loads at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page,'late-load'); await suite(page); await draft(page);
    await panel.getByRole('button',{ name: 'Reload saved draft',exact: true }).click();
    await input(page).fill('[3]'); await input(page).press('Tab');
    await expect(panel.locator('[data-release-status]')).toContainText('Newer working edits were kept');
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([3]);
    await expect(panel.getByRole('button',{ name: 'Test saved draft',exact: true })).toBeDisabled();
    page.once('dialog',dialog => dialog.accept()); await panel.getByRole('button',{ name: 'Reload saved draft',exact: true }).click();
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([1,2]);
    await expect(panel.getByRole('button',{ name: 'Test saved draft',exact: true })).toBeEnabled();
  });
  test(`a late restoration preserves newer working edits and the active recipe at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page,'late-restore'); await suite(page); await draft(page); await review(page);
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.');
    await panel.getByRole('button',{ name: 'Restore as draft',exact: true }).click();
    await input(page).fill('[3]'); await input(page).press('Tab');
    await expect(panel.locator('[data-release-status]')).toContainText('Newer working edits were kept');
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([3]);
    expect(await activeInput(page)).toEqual([1,2]);
    page.once('dialog',dialog => dialog.accept()); await panel.getByRole('button',{ name: 'Reload saved draft',exact: true }).click();
    await expect(input(page)).toHaveValue('[]'); expect(await activeInput(page)).toEqual([1,2]);
  });
}
