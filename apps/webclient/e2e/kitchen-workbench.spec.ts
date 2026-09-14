import { expect, test, type Page } from '@playwright/test';

const url = 'http://127.0.0.1:4319/kitchen-harness.html?surface=recipe&fixture=editor';
const open = async (page: Page, extra = ''): Promise<void> => {
  await page.goto(url + extra);
  await page.waitForFunction(() => window.__harness?.mounted === true);
};
const step = (page: Page, id: string) => page.locator(`[data-recued-recipe-editor-step="${id}"]`);
const field = (page: Page, id: string, key: string) => step(page, id).locator(`[data-recued-recipe-editor-field="${key}"]`);
const save = async (page: Page): Promise<void> => {
  await page.locator('[data-recued-recipe-editor-save]').click();
  await expect(page.locator('[data-recued-recipe-editor-status]')).toContainText('Saved');
};

test('new transform fields, references, and structured values can be authored and saved', async ({ page }) => {
  await open(page);
  await page.locator('[data-recued-recipe-editor-add-name]').selectOption('filter');
  await page.locator('[data-recued-recipe-editor-add]').click();
  await field(page, 'filter_1', 'param:array').fill('[{"amount":12}]');
  await field(page, 'filter_1', 'param:field').fill('amount');
  await field(page, 'filter_1', 'param:value').fill('5');
  await save(page);
  expect(await page.evaluate(() => window.__harness.recipeSaveBodies.at(-1)?.steps.at(-1)))
    .toMatchObject({ array: [{ amount: 12 }], field: 'amount', value: 5 });
  const picker = step(page, 'filter_1').locator('[data-recued-recipe-reference="param:array"]');
  await picker.focus(); await picker.selectOption('{{step.read}}');
  await expect(field(page, 'filter_1', 'param:array')).toHaveValue('{{step.read}}');
  await save(page);
  expect(await page.evaluate(() => window.__harness.recipeSaveBodies.at(-1)?.steps.at(-1)))
    .toMatchObject({ array: '{{step.read}}' });
});

test('unfinished JSON survives repaint and validation links focus the exact field', async ({ page }) => {
  await open(page);
  const array = field(page, 'filter', 'param:array');
  await array.fill('[1,');
  await page.locator('[data-recued-recipe-editor-validate]').click();
  await expect(array).toHaveValue('[1,');
  await expect(array).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Fix steps[1].array', exact: true }).click();
  await expect(array).toBeFocused();
  expect(await page.evaluate(() => window.__harness.recipeValidateCalls)).toBe(0);
  await array.fill('[{"amount":12}]');
  await save(page);
  expect(await page.evaluate(() => window.__harness.recipeSaveBodies.at(-1)?.steps[1]))
    .toMatchObject({ array: [{ amount: 12 }] });
});

test('outline search opens a collapsed match and focuses its step', async ({ page }) => {
  await page.goto(url.replace('fixture=editor', 'fixture=largest'));
  await page.waitForFunction(() => window.__harness?.mounted === true);
  const last = await page.locator('[data-recued-recipe-editor-step]').last().getAttribute('data-recued-recipe-editor-step');
  await expect(page.locator('[data-recued-recipe-editor-step][open]')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search the steps' }).fill(last!);
  await page.locator(`[data-recued-recipe-outline-step="${last}"]`).click();
  await expect(step(page, last!)).toHaveAttribute('open', '');
  await expect(field(page, last!, 'step_id')).toBeFocused();
});

test('outline supports search clearing, Enter navigation, and section shortcuts', async ({ page }) => {
  await open(page);
  const outline = page.getByRole('navigation', { name: 'The steps in this Recipe' });
  const search = outline.getByRole('searchbox', { name: 'Search the steps' });
  await search.fill('no-match-xyz');
  await expect(outline).toContainText('No steps match');
  await search.press('Escape');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await expect(outline.locator('[data-recued-recipe-outline-step]')).toHaveCount(3);
  await search.fill('count');
  await search.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(search).toBeFocused();
  await search.press('Enter');
  await expect(field(page, 'count', 'step_id')).toBeFocused();
  await expect(outline.locator('[data-recued-recipe-outline-step="count"]')).toHaveAttribute('aria-current', 'step');
  await outline.getByRole('button', { name: 'Clear the step search' }).click();
  await expect(search).toBeFocused();
  await outline.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('[data-recued-recipe-settings] > summary')).toBeFocused();
  await expect(page.locator('[data-recued-recipe-settings]')).toHaveAttribute('open', '');
  expect(await page.evaluate(() => window.__harness.recipeSaveBodies.length)).toBe(0);
});

test('phone outline stays collapsed across edits and opens the sample panel by keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const disclosure = page.locator('[data-recued-recipe-outline]');
  await expect(disclosure).not.toHaveAttribute('open');
  await disclosure.locator('summary').press('Enter');
  await expect(disclosure).toHaveAttribute('open', '');
  await disclosure.locator('summary').press('Enter');
  await page.locator('[data-recued-recipe-duplicate="filter"]').click();
  await expect(disclosure).not.toHaveAttribute('open');
  await disclosure.locator('summary').press('Enter');
  await disclosure.getByRole('button', { name: 'Sample test', exact: true }).press('Enter');
  await expect(page.locator('[data-recued-recipe-test]')).toHaveAttribute('open', '');
  await expect(page.locator('[data-recued-recipe-test] > summary')).toBeFocused();
  await page.setViewportSize({ width: 280, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(280);
});

test('duplicate, undo, redo and deletion preserve the recipe through save', async ({ page }) => {
  await open(page);
  await page.locator('[data-recued-recipe-duplicate="filter"]').click();
  await expect(step(page, 'filter_copy')).toHaveCount(1);
  await page.locator('[data-recued-recipe-undo]').click();
  await expect(step(page, 'filter_copy')).toHaveCount(0);
  await page.locator('[data-recued-recipe-redo]').click();
  await expect(step(page, 'filter_copy')).toHaveCount(1);
  await step(page, 'filter_copy').locator('[data-recued-recipe-editor-remove]').click();
  await page.keyboard.press('Control+z');
  await expect(step(page, 'filter_copy')).toHaveCount(1);
  await save(page);
  expect(await page.evaluate(() => window.__harness.recipeSaveBodies.at(-1)?.steps.map(item => item.id)))
    .toEqual(['read', 'filter', 'filter_copy', 'count']);
});

test('settings author variables, complete output definitions, and automatic runs', async ({ page }) => {
  await open(page);
  await page.locator('[data-recued-recipe-settings] > summary').click();
  await page.locator('[data-recued-recipe-editor-field="variables.threshold"]').fill('20');
  await page.getByRole('textbox', { name: 'New input name' }).fill('label');
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  await page.locator('[data-recued-recipe-editor-field="variables.label"]').fill('"Total"');
  await page.locator('[data-recued-recipe-auto-run]').check();
  await page.locator('[data-recued-recipe-editor-field="auto_run.interval_ms"]').fill('120000');
  await page.locator('[data-recued-recipe-editor-field="output"]').fill('{"render":[{"type":"text","source":"step.count"}]}');
  await save(page);
  const saved = await page.evaluate(() => window.__harness.recipeSaveBodies.at(-1));
  expect(saved?.variables).toEqual({ threshold: 20, label: 'Total' });
  expect(saved?.auto_run).toEqual({ interval_ms: 120000, default_enabled: false });
  expect(saved?.output).toEqual({ render: [{ type: 'text', source: 'step.count' }] });
});

test('draft recovery restores incomplete edits after refresh and isolates profiles', async ({ page }) => {
  await open(page, '&recovery&profile=a');
  await field(page, 'filter', 'param:array').fill('[1,');
  await page.waitForFunction(() => Object.keys(sessionStorage).some(key => key.startsWith('recued.kitchen.draft.v1:')));
  await open(page, '&recovery&profile=b');
  await expect(page.getByRole('button', { name: 'Restore draft', exact: true })).toHaveCount(0);
  await open(page, '&recovery&profile=a');
  await expect(page.getByRole('button', { name: 'Restore draft', exact: true })).toHaveCount(1);
  await page.reload();
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(field(page, 'filter', 'param:array')).toHaveValue('[1,');
  await field(page, 'filter', 'param:array').fill('[]');
  await save(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Restore draft', exact: true })).toHaveCount(0);
});

test('sample testing reports real intermediate values, missing mocks, and stale results', async ({ page }) => {
  await open(page);
  await page.locator('[data-recued-recipe-test] > summary').click();
  await page.locator('[data-recued-recipe-test-run]').click();
  await expect(page.locator('[data-recued-recipe-test-status]')).toHaveText('Test failed');
  await page.locator('[data-recued-recipe-editor-field="test_sample"]').fill(JSON.stringify({
    config: { threshold: 10 }, mocks: { read: { result: [{ amount: 5 }, { amount: 20 }] } },
  }));
  await page.locator('[data-recued-recipe-test-run]').click();
  await expect(page.locator('[data-recued-recipe-test-status]')).toHaveText('Test passed');
  await expect(page.locator('[data-recued-recipe-test-status]')).toHaveAttribute('data-state', 'passed');
  await expect(page.locator('.recipe-editor-test-totals')).toHaveText('3 passed');
  await page.locator('[data-recued-recipe-test-step="count"]').click();
  await expect(page.locator('[data-recued-recipe-test-step="count"]').locator('..').locator('pre').last()).toHaveText('1');
  await page.locator('[data-recued-recipe-test-step="count"]').locator('..').getByRole('button', { name: 'Go to step' }).click();
  await expect(field(page, 'count', 'step_id')).toBeFocused();
  expect(await page.evaluate(() => window.__harness.recipeSaveBodies.length)).toBe(0);
  await field(page, 'filter', 'param:value').fill('25');
  await page.locator('[data-recued-recipe-editor-validate]').click();
  await expect(page.locator('[data-recued-recipe-test-status]')).toContainText('recipe changed');
  await expect(page.locator('[data-recued-recipe-test-status]')).toHaveAttribute('data-state', 'stale');
});

test('pack searches filter operations and data rows without changing the draft', async ({ page }) => {
  await page.goto('http://127.0.0.1:4319/kitchen-harness.html?surface=pack&fixture=largest');
  await page.waitForFunction(() => window.__harness?.mounted === true);
  await page.locator('[data-recued-ingredient-builder-section-nav="operations"]').click();
  await page.getByRole('searchbox', { name: 'Search the operations' }).fill('no-such-operation-xyz');
  await expect(page.locator('[data-recued-ingredient-operation-row]:visible')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear the operation search' }).click();
  await expect(page.getByRole('searchbox', { name: 'Search the operations' })).toBeFocused();
  expect(await page.locator('[data-recued-ingredient-operation-row]:visible').count()).toBeGreaterThan(0);
  await page.locator('[data-recued-ingredient-builder-section-nav="data"]').click();
  await page.getByRole('searchbox', { name: 'Search the data fields' }).fill('no-such-field-xyz');
  await expect(page.locator('[data-recued-ingredient-entity-field-row]:visible')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search the data fields' }).press('Escape');
  await expect(page.getByRole('searchbox', { name: 'Search the data fields' })).toHaveValue('');
  expect(await page.locator('[data-recued-ingredient-entity-field-row]:visible').count()).toBeGreaterThan(0);
});

test('automatic trigger steps can be added and saved from the workbench', async ({ page }) => {
  await open(page);
  await page.locator('[data-recued-recipe-settings] > summary').click();
  await page.locator('[data-recued-recipe-auto-run]').check();
  await page.locator('[data-recued-recipe-trigger-add-name]').selectOption('coalesce');
  await page.locator('[data-recued-recipe-trigger-add]').click();
  await field(page, 'coalesce', 'param:values').fill('[{"should_run":true,"reason":"sample"}]');
  await save(page);
  expect(await page.evaluate(() => window.__harness.recipeSaveBodies.at(-1)?.trigger_steps))
    .toEqual([{ id: 'coalesce', transform: 'coalesce', values: [{ should_run: true, reason: 'sample' }] }]);
  await page.locator('[data-recued-recipe-trigger-add-kind]').selectOption('op');
  await page.locator('[data-recued-recipe-trigger-add-name]').fill('core.records.list');
  await page.locator('[data-recued-recipe-trigger-add]').click();
  await save(page);
  expect(await page.evaluate(() => window.__harness.recipeSaveBodies.at(-1)?.trigger_steps?.at(-1)))
    .toMatchObject({ id: 'list', op: 'core.records.list' });
  expect(await page.evaluate(() => window.__harness.recipeSaveBodies.at(-1)?.steps.map(item => item.id)))
    .toEqual(['read', 'filter', 'count']);
});

test('removing unfinished settings clears hidden errors and undo restores their drafts', async ({ page }) => {
  await open(page);
  await page.locator('[data-recued-recipe-settings] > summary').click();
  const threshold = page.locator('[data-recued-recipe-editor-field="variables.threshold"]');
  await threshold.fill('{');
  await page.getByRole('button', { name: 'Remove variable threshold', exact: true }).click();
  await page.locator('[data-recued-recipe-undo]').click();
  await expect(threshold).toHaveValue('{');
  await page.locator('[data-recued-recipe-redo]').click();
  await page.locator('[data-recued-recipe-auto-run]').check();
  await page.locator('[data-recued-recipe-editor-field="auto_run.interval_ms"]').fill('');
  await page.locator('[data-recued-recipe-auto-run]').uncheck();
  await save(page);
  expect(await page.evaluate(() => window.__harness.recipeSaveBodies.at(-1)?.variables)).toEqual({});
});

test('undo in sample text does not undo recipe edits', async ({ page }) => {
  await open(page);
  await page.locator('[data-recued-recipe-duplicate="filter"]').click();
  await page.locator('[data-recued-recipe-test] > summary').click();
  const sample = page.locator('[data-recued-recipe-editor-field="test_sample"]');
  await sample.fill('{"config":{}}');
  await page.keyboard.press('Control+z');
  await expect(step(page, 'filter_copy')).toHaveCount(1);
});

test('settings, value editors and test results stay usable on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 900 });
  await open(page);
  await page.locator('[data-recued-recipe-settings] > summary').click();
  await page.locator('[data-recued-recipe-test] > summary').click();
  await page.locator('[data-recued-recipe-test-run]').click();
  await expect(page.locator('[data-recued-recipe-test-status]')).toHaveText('Test failed');
  await page.locator('[data-recued-recipe-test-step="read"]').click();
  const widths = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(widths.width).toBeLessThanOrEqual(widths.viewport);
  await page.screenshot({ path: '/tmp/kitchen-workbench-phone.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/kitchen-workbench-desktop.png' });
});
