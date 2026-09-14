import { expect, test } from '@playwright/test';

const url = 'http://127.0.0.1:4319/kitchen-harness.html?surface=recipe&fixture=editor';

test('reference choices respect parallel prefetch and sequential execution order', async ({ page }) => {
  await page.goto(url.replace('fixture=editor', 'fixture=parallel'));
  const prefetch = page.locator('[data-recued-recipe-editor-step="second"] [data-recued-recipe-reference]');
  await prefetch.focus();
  await expect(prefetch.locator('option[value="{{trigger.gate}}"]')).toHaveCount(1);
  await expect(prefetch.locator('option[value="{{step.first}}"]')).toHaveCount(0);
  await expect(prefetch.locator('option[value="{{step.read}}"]')).toHaveCount(0);
  const sequential = page.locator('[data-recued-recipe-editor-step="filter"] [data-recued-recipe-reference="param:array"]');
  await sequential.focus();
  for (const id of ['first', 'second', 'read']) await expect(sequential.locator(`option[value="{{step.${id}}}"]`)).toHaveCount(1);
  await expect(sequential.locator('option[value="{{step.count}}"]')).toHaveCount(0);
});

test('edits invalidate visible validation feedback without moving focus', async ({ page }) => {
  await page.goto(url);
  await page.locator('[data-recued-recipe-editor-validate]').click();
  await expect(page.locator('[data-recued-recipe-editor-status]')).toHaveText('Valid');
  const name = page.locator('[data-recued-recipe-editor-field="recipe_name"]');
  await name.fill('Changed recipe');
  await expect(name).toBeFocused();
  await expect(page.locator('[data-recued-recipe-editor-valid]')).toHaveCount(0);
  await expect(page.locator('[data-recued-recipe-editor-status]')).toHaveText('You have changes. Check them, or save.');
  const array = page.locator('[data-recued-recipe-editor-step="filter"] [data-recued-recipe-editor-field="param:array"]');
  await array.fill('[1,');
  await page.locator('[data-recued-recipe-editor-validate]').click();
  await expect(page.getByRole('button', { name: 'Fix steps[1].array' })).toBeVisible();
  await array.fill('[1]');
  await expect(array).toBeFocused();
  await expect(page.locator('[data-recued-recipe-editor-issues]')).toHaveCount(0);
  await expect(page.locator('[data-recued-recipe-outline-step][data-has-error]')).toHaveCount(0);
});

test('queued disclosure events from replaced cards cannot collapse the active editor', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => {
    const obsolete = document.querySelector('[data-recued-recipe-editor-step="read"]')!;
    document.querySelector<HTMLButtonElement>('[data-recued-recipe-editor-validate]')!.click();
    obsolete.removeAttribute('open');
    obsolete.dispatchEvent(new Event('toggle'));
  });
  await expect(page.locator('[data-recued-recipe-editor-status]')).toHaveText('Valid');
  await expect(page.locator('[data-recued-recipe-editor-step="read"]')).toHaveAttribute('open', '');
});

test('draft recovery uses the saved revision and undo returns to a clean document', async ({ page }) => {
  await page.goto(url + '&recovery');
  const value = page.locator('[data-recued-recipe-editor-step="filter"] [data-recued-recipe-editor-field="param:value"]');
  await value.fill('20');
  await page.locator('[data-recued-recipe-editor-save]').click();
  await expect(page.locator('[data-recued-recipe-editor-status]')).toContainText('v2');
  await value.fill('30');
  await page.waitForFunction(() => {
    const key = Object.keys(sessionStorage).find(key => key.startsWith('recued.kitchen.draft.v1:'));
    return key && JSON.parse(sessionStorage.getItem(key)!).base.version === 2;
  });
  await page.locator('[data-recued-recipe-undo]').click();
  await expect(value).toHaveValue('20');
  await page.keyboard.press('Control+s');
  expect(await page.evaluate(() => window.__harness.recipeSaveBodies)).toHaveLength(1);
});

test('unfinished numbers survive validation without being cleared or saved', async ({ page }) => {
  await page.goto(url);
  await page.locator('[data-recued-recipe-settings] > summary').click();
  const ttl = page.locator('[data-recued-recipe-editor-field="ttl"]');
  await ttl.fill('');
  await ttl.pressSequentially('-');
  await page.locator('[data-recued-recipe-editor-validate]').click();
  await expect(ttl).toHaveValue('-');
  await expect(ttl).toHaveAttribute('aria-invalid', 'true');
  expect(await page.evaluate(() => window.__harness.recipeValidateCalls)).toBe(0);
});

for (const [path, key] of [['steps[0].skip_when.operator', 'skip_when'], ['output.render[0].source', 'output']] as const) {
  test(`validation for ${path} focuses and marks its enclosing editor`, async ({ page }) => {
    await page.goto(url.replace('fixture=editor', 'fixture=audit') + '&validation_path=' + encodeURIComponent(path));
    await page.locator('[data-recued-recipe-editor-validate]').click();
    await page.getByRole('button', { name: `Fix ${path}`, exact: true }).click();
    const field = page.locator(`[data-recued-recipe-editor-field="${key}"]`);
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field.locator('..')).toContainText('Invalid nested value');
    await field.fill(key === 'output' ? '{"render":[]}' : '{"field":"{{config.threshold}}","operator":"is_null"}');
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
    await expect(field.locator('..')).not.toContainText('Invalid nested value');
  });
}

test('unfinished operation JSON stays a draft through validation, refresh, removal, and undo', async ({ page }) => {
  await page.goto(url + '&recovery');
  const read = page.locator('[data-recued-recipe-editor-step="read"]');
  await read.locator('[data-recued-recipe-editor-field="op_arg_name"]').fill('rows');
  await read.getByRole('button', { name: 'Add argument to step read', exact: true }).click();
  const rows = read.locator('[data-recued-recipe-editor-field="arg:rows"]');
  await rows.fill('[1,');
  await page.locator('[data-recued-recipe-editor-save]').click();
  await expect(rows).toHaveAttribute('aria-invalid', 'true');
  expect(await page.evaluate(() => window.__harness.recipeSaveBodies)).toHaveLength(0);
  await page.reload();
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(rows).toHaveValue('[1,');
  await read.getByRole('button', { name: 'Remove argument rows from step read', exact: true }).click();
  await page.locator('[data-recued-recipe-undo]').click();
  await expect(rows).toHaveValue('[1,');
  await rows.fill('[1,2]');
  await page.locator('[data-recued-recipe-editor-save]').click();
  await expect(page.locator('[data-recued-recipe-editor-status]')).toContainText('Saved');
  expect(await page.evaluate(() => window.__harness.recipeSaveBodies.at(-1)?.steps[0]))
    .toMatchObject({ args: { rows: [1, 2] } });
});

test('undoing an unfinished rename keeps the preceding recipe edit', async ({ page }) => {
  await page.goto(url);
  await page.locator('[data-recued-recipe-duplicate="filter"]').click();
  await page.locator('[data-recued-recipe-editor-step="count"] [data-recued-recipe-editor-field="step_id"]').fill('total');
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-recued-recipe-editor-step="filter_copy"]')).toHaveCount(1);
});

for (const kind of ['operations', 'fields'] as const) {
  test(`adding pack ${kind} while searching reveals the new row`, async ({ page }) => {
    await page.goto('http://127.0.0.1:4319/kitchen-harness.html?surface=pack&fixture=largest');
    await page.locator(`[data-recued-ingredient-builder-section-nav="${kind === 'operations' ? 'operations' : 'data'}"]`).click();
    const search = page.getByRole('searchbox', { name: kind === 'operations' ? 'Search the operations' : 'Search the data fields' });
    await search.fill('no-match-xyz');
    await page.getByRole('button', { name: kind === 'operations' ? 'Add operation' : 'Add field', exact: true }).click();
    await expect(search).toHaveValue('');
    expect(await page.evaluate(() => document.activeElement?.closest('[hidden], .is-hidden'))).toBeNull();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  });
}
