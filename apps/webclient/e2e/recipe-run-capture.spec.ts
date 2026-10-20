import { expect,test,type Page } from '@playwright/test';
const open = async (page: Page,scenario = '') => {
  await page.goto('/recipe-run-capture-harness.html?scenario=' + scenario);
  const panel = page.locator('[data-recipe-run-capture]'); await panel.locator('summary').first().click();
  await expect(panel.getByRole('button',{ name: 'Run installed recipe and capture',exact: true })).toBeEnabled();
  await panel.getByRole('textbox',{ name: 'Run settings and event context (JSON)',exact: true }).fill(JSON.stringify({ config: { rows: [1,2],api_key: 'private-token' },context: {} })); return panel;
};
const capture = async (page: Page) => {
  const panel = page.locator('[data-recipe-run-capture]'); await panel.getByRole('button',{ name: 'Run installed recipe and capture',exact: true }).click();
  await expect(panel.getByRole('textbox',{ name: 'Captured test case (JSON)',exact: true })).toBeVisible(); return panel;
};
const saved = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('recipe-capture-fixture')!));
for (const width of [280,1280]) {
  test(`a usable test draft does not imply the live recipe succeeded at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'failed'); const panel = await capture(page);
    await expect(panel).toContainText('Live run outcome: failed.');
    expect((await saved(page)).runs).toBe(1);
    const value = JSON.parse(await panel.getByRole('textbox',{ name: 'Captured test case (JSON)' }).inputValue());
    expect(value.assertions[0]).toEqual({ kind: 'run_status',expected: 'failed' });
    await expect(panel.getByRole('button',{ name: 'Import into saved tests',exact: true })).toBeDisabled();
  });

  test(`capture requires review, sanitizes data and imports into the real saved-test editor at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); const panel = await capture(page);
    const field = panel.getByRole('textbox',{ name: 'Captured test case (JSON)',exact: true });
    const draft = JSON.parse(await field.inputValue()); expect(draft.sample.config.api_key).toBe('[redacted]'); expect(draft.sample.config.rows).toEqual([1,2]);
    const button = panel.getByRole('button',{ name: 'Import into saved tests',exact: true }); await expect(button).toBeDisabled();
    draft.name = 'Recorded count'; await field.fill(JSON.stringify(draft,null,2)); await expect(field).toBeFocused();
    await panel.locator('[data-capture-ack]').check(); await button.click(); await expect(panel.locator('[data-capture-status]')).toContainText('Imported captured case');
    const state = await saved(page); expect(state.runs).toBe(1); expect(state.imports).toBe(1); expect(state.suite.version.suite.cases[0].name).toBe('Recorded count');
    draft.name = 'A later capture edit'; await field.fill(JSON.stringify(draft)); await panel.locator('[data-capture-ack]').check();
    await expect(button).toBeDisabled(); expect((await saved(page)).imports).toBe(1);
    const tests = page.locator('[data-recipe-regression]'); await tests.locator('summary').first().click();
    await tests.getByRole('button',{ name: 'Run test suite',exact: true }).click(); await expect(tests.locator('[data-regression-results]')).toContainText('1 passed, 0 failed');
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });
  test(`lost live-run replies recover the capture without repeating execution at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page,'lost-run');
    await panel.getByRole('button',{ name: 'Run installed recipe and capture',exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('Run reply lost');
    await panel.getByRole('button',{ name: 'Review capture',exact: true }).click(); await expect(panel.getByRole('textbox',{ name: 'Captured test case (JSON)' })).toBeVisible();
    expect((await saved(page)).runs).toBe(1);
  });
  test(`lost import replies retry the exact write once at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'lost-import'); const panel = await capture(page);
    await panel.locator('[data-capture-ack]').check(); await panel.getByRole('button',{ name: 'Import into saved tests',exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Import reply lost'); await panel.getByRole('button',{ name: 'Retry importing case',exact: true }).click();
    await expect(panel.locator('[data-capture-status]')).toContainText('Imported captured case'); expect((await saved(page)).imports).toBe(1);
  });
  test(`saved-test drafts hold importing without losing the focused case edit at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); const panel = await capture(page);
    await panel.locator('[data-capture-ack]').check(); const tests = page.locator('[data-recipe-regression]'); await tests.locator('summary').first().click();
    const field = tests.getByRole('textbox',{ name: 'Case name',exact: true }); await field.fill('Keep saved-test draft'); await expect(field).toBeFocused();
    await expect(panel.getByRole('button',{ name: 'Import into saved tests',exact: true })).toBeDisabled(); expect((await saved(page)).imports).toBe(0);
  });
  test(`an incomplete held run cannot become a saved case at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page,'held');
    await panel.getByRole('button',{ name: 'Run installed recipe and capture',exact: true }).click(); await expect(panel.locator('[data-capture-status]')).toContainText('cannot be imported');
    await expect(panel.getByRole('button',{ name: 'Import into saved tests',exact: true })).toHaveCount(0); expect((await saved(page)).imports).toBe(0);
  });
  test(`a newer saved suite requires a fresh capture review at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); const panel = await capture(page); await panel.locator('[data-capture-ack]').check();
    await page.evaluate(() => { const key = 'recipe-capture-fixture',state = JSON.parse(sessionStorage.getItem(key)!); state.suite.head_revision++; sessionStorage.setItem(key,JSON.stringify(state)); });
    await panel.getByRole('button',{ name: 'Import into saved tests',exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('Saved tests changed'); expect((await saved(page)).imports).toBe(0);
  });
  test(`expiry holds importing while preserving unfinished capture JSON at ${width}px`,async ({ page }) => {
    await page.clock.install(); await page.setViewportSize({ width,height: 900 }); await open(page); const panel = await capture(page);
    const field = panel.getByRole('textbox',{ name: 'Captured test case (JSON)' }), value = JSON.parse(await field.inputValue()); value.name = 'Keep expired draft';
    await field.fill(JSON.stringify(value)); await panel.locator('[data-capture-ack]').check();
    await page.clock.fastForward(600_002); await expect(panel.getByRole('button',{ name: 'Import into saved tests',exact: true })).toBeDisabled();
    expect(JSON.parse(await field.inputValue()).name).toBe('Keep expired draft');
    await expect(panel.locator('[data-capture-status]')).toContainText('expired');
  });
  test(`reloading resumes a capture and asks for fresh acknowledgement at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); await capture(page); await page.reload();
    const panel = page.locator('[data-recipe-run-capture]'); await panel.locator('summary').first().click();
    await panel.getByRole('button',{ name: 'Review capture',exact: true }).click(); await expect(panel.locator('[data-capture-ack]')).not.toBeChecked();
    await expect(panel.getByRole('button',{ name: 'Import into saved tests',exact: true })).toBeDisabled(); expect((await saved(page)).runs).toBe(1);
  });
  test(`running capture joins the editor leave guard and holds another start at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page,'slow');
    await panel.getByRole('button',{ name: 'Run installed recipe and capture',exact: true }).click();
    expect(await page.evaluate(() => (window as any).captureFixture.hasInFlightWork())).toBe(true);
    await expect(panel.getByRole('button',{ name: 'Run installed recipe and capture',exact: true })).toBeDisabled();
    await expect(panel.getByRole('textbox',{ name: 'Captured test case (JSON)' })).toBeVisible(); expect((await saved(page)).runs).toBe(1);
  });
}
