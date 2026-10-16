import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

/** Kitchen browser journeys against the deterministic full-app harness. */
installFullAppHooks();

test('Kitchen recipe editor contains mobile authoring controls', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(
    () => window.__app.setHash('#kitchen/recipe/autorun-live-1'),
  );

  const editor = page.locator('[data-recued-recipe-editor-route]');
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('heading', { name: 'Recipe editor' }))
    .toBeFocused();
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('webhook.ingress.list'),
  )).toBe(1);
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('recipe.webhook.status'),
  )).toBe(1);

  const contained = await editor.evaluate((node) => (
    node.scrollWidth <= node.clientWidth
    && [...node.querySelectorAll<HTMLElement>('.recipe-editor-section')]
      .every((section) => section.scrollWidth <= section.clientWidth)
  ));
  expect(contained).toBe(true);

  const targets = editor.locator(
    'button:visible, input:visible, select:visible, textarea:visible, summary:visible',
  );
  const sizes = await targets.evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  expect(sizes.length).toBeGreaterThan(10);
  expect(Math.min(...sizes.map(({ width }) => width)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.min(...sizes.map(({ height }) => height)))
    .toBeGreaterThanOrEqual(36);
});

test('Kitchen recipe steps keep desktop row actions full-sized', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${HARNESS_URL}?recipes=installed&settle_reads=1`
      + '#kitchen/recipe/autorun-live-1',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const editor = page.locator('[data-recued-recipe-editor-route]');
  await expect(editor.getByRole('heading', { name: 'Recipe editor' }))
    .toBeFocused();
  const add = editor.getByRole('button', { name: 'Add step' });
  await add.click();

  const rowActions = editor.locator('.recipe-editor-step-actions .rx-btn');
  const sizes = await rowActions.evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  // ⚠ This pinned `3` and went red on 2026-09-09 when `ce3dca96d` added a
  // Duplicate action — a stale COUNT, while the thing the test is actually for
  // (every row action stays a full-sized target) passed the whole time. Assert
  // the floor and NAME the actions, so a button that disappears still fails
  // while one that is added is simply measured like the rest.
  expect(sizes.length).toBeGreaterThanOrEqual(3);
  for (const name of ['Duplicate', 'Remove']) {
    await expect(
      editor.locator('.recipe-editor-step-actions').getByRole('button', { name }),
    ).toHaveCount(1);
  }
  expect(Math.min(...sizes.map(({ width }) => width)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.min(...sizes.map(({ height }) => height)))
    .toBeGreaterThanOrEqual(36);

  const remove = editor.getByRole('button', { name: 'Remove step filter' });
  await remove.focus();
  await page.keyboard.press('Enter');
  await expect(editor.locator('.recipe-editor-step-card')).toHaveCount(0);
  await expect(add).toBeFocused();
});

test('Kitchen pack data fields keep wide editing inside their scroller', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#kitchen/pack'));

  const builder = page.locator('[data-recued-ingredient-builder-route]');
  await expect(builder.getByRole('combobox', { name: 'Draft' })).toBeEnabled();
  await builder.getByRole('tab', { name: 'Data fields' }).click();

  const groups = builder.locator('[data-recued-ingredient-entity-field-table]');
  await expect(groups).toContainText('No entity fields');
  expect(await builder.evaluate((node) => node.scrollWidth <= node.clientWidth))
    .toBe(true);

  await builder.getByRole('button', { name: 'Add field' }).click();
  const entity = builder.getByRole('textbox', { name: 'Entity for data field 1' });
  await expect(entity).toBeFocused();
  const table = builder.getByRole('table', { name: 'Ungrouped data fields' });
  await expect(table).toBeVisible();

  const containment = await builder.evaluate((node) => {
    const wrap = node.querySelector<HTMLElement>('.ingredient-builder-table-wrap');
    if (wrap === null) return null;
    const rect = wrap.getBoundingClientRect();
    return {
      routeContained: node.scrollWidth <= node.clientWidth,
      wrapContained: rect.left >= 0 && rect.right <= window.innerWidth,
      locallyScrollable: wrap.scrollWidth > wrap.clientWidth,
      overflowX: getComputedStyle(wrap).overflowX,
    };
  });
  expect(containment).toEqual({
    routeContained: true,
    wrapContained: true,
    locallyScrollable: true,
    overflowX: 'auto',
  });
});

test('Kitchen pack review keeps its desktop checkbox row full-sized', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${HARNESS_URL}?settle_reads=1#kitchen/pack`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const builder = page.locator('[data-recued-ingredient-builder-route]');
  await expect(builder.getByRole('combobox', { name: 'Draft' })).toBeEnabled();
  await builder.getByRole('tab', { name: 'Operations' }).click();
  const reviewed = builder.getByRole('checkbox', {
    name: 'Reviewed for operation untitled',
  });
  await expect(reviewed).not.toBeChecked();
  const targetBox = await reviewed.locator('..').boundingBox();
  expect(targetBox?.height).toBeGreaterThanOrEqual(36);

  await reviewed.focus();
  await page.keyboard.press('Space');
  const reviewedField = builder.locator(
    '[data-recued-ingredient-operation-field="reviewed"]',
  );
  await expect(reviewedField).toBeChecked();
  const operationRow = builder.locator(
    '[data-recued-ingredient-operation-row="row-0"]',
  );
  await expect(operationRow).not.toHaveAttribute('open', '');
  await expect(operationRow.locator(':scope > summary')).toBeFocused();
});
