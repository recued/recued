import { expect, test } from '@playwright/test';
import { HARNESS_URL, LIST_PREVIEW, SHELL_CONTENT, installFullAppHooks } from './helpers/full-app.js';

/** Recipes browser journeys against the deterministic full-app harness. */
installFullAppHooks();

test('Recipes hands focus into detail and back to the exact card', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  const card = page.locator('[data-recued-recipes-card]').first();
  await expect(card).toBeVisible();
  const recipeId = await card.getAttribute('data-recued-recipes-card');
  expect(recipeId).not.toBeNull();
  const open = card.getByRole('button', { name: /Open .+ details/ });

  await open.focus();
  await page.keyboard.press('Enter');
  const detail = page.locator(`[data-recued-recipes-detail="${recipeId}"]`);
  await expect(detail).toBeVisible();
  const detailHeading = detail.getByRole('heading', { level: 1 });
  await expect(detailHeading).toBeFocused();

  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'recipe_runnability_changed',
      recipes: [],
      cursor: 61,
    },
  }));
  await expect(detailHeading).toBeFocused();

  const back = detail.locator('[data-recued-recipes-back]');
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(detail).toHaveCount(0);
  await expect(open).toBeFocused();

  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'recipe_runnability_changed',
      recipes: [],
      cursor: 62,
    },
  }));
  await expect(open).toBeFocused();
});

test('Recipes uses Space for preview and Enter for durable detail', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed#recipes`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const card = page.locator(
    '[data-recued-recipes-card="autorun-live-1"]',
  );
  const open = card.getByRole('button', {
    name: 'Open Watch pipeline details',
    exact: true,
  });
  await card.focus();
  await page.keyboard.press('Space');

  const preview = page.locator(`[${LIST_PREVIEW}]`);
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Watch pipeline' }))
    .toBeVisible();
  await expect(page).toHaveURL(/#recipes$/);
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(card).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#recipes\/autorun-live-1$/);
  await expect(page.locator(
    '[data-recued-recipes-detail="autorun-live-1"]',
  )).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#recipes$/);
  await expect(open).toBeFocused();
});

test('Recipes restores filter, page, focus, and scroll through browser Back', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=paged#recipes`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const search = page.getByRole('searchbox', {
    name: 'Search installed recipes',
  });
  const manual = page.getByRole('group', { name: 'Filter by type' })
    .getByRole('button', { name: 'Manual', exact: true });
  const pager = page.getByRole('navigation', {
    name: 'Installed recipes pages',
  });
  await search.fill('Paged recipe');
  await manual.click();
  await pager.getByRole('button', { name: 'Next', exact: false }).click();
  await expect(pager).toContainText('Page 2 of 3');

  const content = page.locator(`[${SHELL_CONTENT}]`);
  const open = page.getByRole('button', {
    name: 'Open Paged recipe 25 details',
    exact: true,
  });
  // Capture the position at activation time. Playwright, like a pointer user,
  // first reveals an off-screen target; the continuity contract starts from
  // the settled position where the action can actually be pressed.
  await open.scrollIntoViewIfNeeded();
  const savedScroll = await content.evaluate((element) => element.scrollTop);
  expect(savedScroll).toBeGreaterThan(0);
  await open.click();
  await expect(page).toHaveURL(/#recipes\/paged-recipe-25$/);

  await page.goBack();
  await expect(page).toHaveURL(/#recipes$/);
  await expect(search).toHaveValue('Paged recipe');
  await expect(manual).toHaveAttribute('aria-pressed', 'true');
  await expect(pager).toContainText('Page 2 of 3');
  await expect(open).toBeFocused();
  await expect.poll(
    () => content.evaluate((element) => element.scrollTop),
  ).toBe(savedScroll);
});

test('Recipes gives mobile navigation full-size targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  const card = page.locator('[data-recued-recipes-card]').first();
  await expect(card).toBeVisible();
  const listLinks = page.locator(
    '[data-recued-recipes-route] .recipes-actions > .recipes-inline-link',
  );
  const listHeights = await listLinks.evaluateAll((links) => links.map(
    (link) => link.getBoundingClientRect().height,
  ));
  expect(listHeights.length).toBeGreaterThan(0);
  expect(Math.min(...listHeights)).toBeGreaterThanOrEqual(36);

  await card.getByRole('button', { name: /Open .+ details/ }).click();
  const detail = page.locator('[data-recued-recipes-detail]');
  await expect(detail).toBeVisible();
  const detailLinks = detail.locator('a:visible');
  const detailHeights = await detailLinks.evaluateAll((links) => links.map(
    (link) => link.getBoundingClientRect().height,
  ));
  expect(detailHeights.length).toBeGreaterThan(0);
  expect(Math.min(...detailHeights)).toBeGreaterThanOrEqual(36);
  const definition = detail.locator('[data-recued-recipes-definition]');
  const definitionSummary = definition.locator('summary');
  expect((await definitionSummary.boundingBox())?.height)
    .toBeGreaterThanOrEqual(44);
  await definitionSummary.focus();
  await page.keyboard.press('Enter');
  await expect(definition).toHaveAttribute('open', '');
  await expect(definitionSummary).toBeFocused();
  expect(await detail.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test('Recipes contains long installed cards at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(`${HARNESS_URL}?recipes=installed&run_palette=long#recipes`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-recipes-route]');
  const section = route.locator('[data-recued-recipes-section]');
  const grid = route.locator('.recipes-card-grid');
  const card = route.locator('[data-recued-recipes-card]').first();
  await expect(card.locator('.recipe-card-name')).toContainText('RecipeNN');
  const owners = [route, section, grid, card];
  for (const owner of owners) {
    expect(await owner.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    )).toBe(true);
  }
  const textOwners = card.locator(
    '.recipe-card, .recipe-card-header, .recipe-card-name, '
    + '.recipe-card-footer, .recipe-card-footer > *',
  );
  expect(await textOwners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  const targets = await card.getByRole('button').evaluateAll(
    (buttons) => buttons.map((button) => button.getBoundingClientRect().height),
  );
  expect(Math.min(...targets)).toBeGreaterThanOrEqual(36);
});

test('Recipes contains long identity throughout its narrow detail view', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(`${HARNESS_URL}?recipes=installed&run_palette=long#recipes`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-recipes-route]');
  await route.locator('[data-recued-recipes-card]').first()
    .getByRole('button', { name: /^Open / }).click();
  const detail = route.locator('[data-recued-recipes-detail]');
  await expect(detail.locator('.recipes-detail-name')).toContainText('RecipeNN');
  expect(await detail.evaluate(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  )).toBe(true);
  const owners = detail.locator(
    '.recipes-detail-header, .recipes-detail-title, '
    + '.recipes-detail-name, .recipes-detail-meta, .recipes-detail-section',
  );
  expect(await owners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  expect(await route.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);

  const definition = detail.locator('[data-recued-recipes-definition]');
  await definition.locator('summary').click();
  const definitionGeometry = await definition.evaluate((element) => {
    const code = element.querySelector('pre');
    return {
      ownerContained: element.scrollWidth <= element.clientWidth + 1,
      codeContained: code !== null
        && code.getBoundingClientRect().right
          <= element.getBoundingClientRect().right + 1,
      codeScrollable: code !== null && code.scrollWidth > code.clientWidth,
    };
  });
  expect(definitionGeometry).toEqual({
    ownerContained: true,
    codeContained: true,
    codeScrollable: true,
  });
});

test('Recipes contains long live status disclosures on list and detail', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(`${HARNESS_URL}?recipes=installed&run_palette=long#recipes`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-recipes-route]');
  const card = route.locator('[data-recued-recipes-card]').first();
  const recipeId = await card.getAttribute('data-recued-recipes-card');
  expect(recipeId).not.toBeNull();
  await page.evaluate((id) => {
    const operation = `operation-${'identity'.repeat(35)}`;
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'recipe_runnability_changed',
        cursor: 99,
        recipes: [{
          recipe_id: id,
          status: 'blocked',
          dependencies: [{
            capability: 'crm',
            ops: [operation],
            optional: false,
            satisfied: false,
            providers: [],
            unprovided_ops: [operation],
          }],
        }],
      },
    });
  }, recipeId);

  const cardStatus = card.locator('[data-recued-recipes-runnability]');
  await expect(cardStatus).toHaveAttribute('data-recued-recipes-runnability', 'blocked');
  expect(await cardStatus.evaluate((element) => [
    element,
    ...element.querySelectorAll('.recipes-runnability-detail'),
  ].every((owner) => owner.scrollWidth <= owner.clientWidth + 1))).toBe(true);
  expect(await route.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);

  await card.getByRole('button', { name: /^Open / }).click();
  const detail = route.locator('[data-recued-recipes-detail]');
  const detailStatus = detail.locator('[data-recued-recipes-runnability]');
  await expect(detailStatus).toBeVisible();
  expect(await detailStatus.evaluate((element) => [
    element,
    ...element.querySelectorAll('.recipes-runnability-detail'),
  ].every((owner) => owner.scrollWidth <= owner.clientWidth + 1))).toBe(true);
  expect(await detail.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
  expect(await route.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test('Recipes gives list Open and Run separate focus ownership', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  const card = page.locator(
    '[data-recued-recipes-card="autorun-live-1"]',
  );
  await expect(card).toHaveAttribute('role', 'group');
  await expect(card).toHaveAttribute('tabindex', '0');
  await expect(card.getByRole('button', {
    name: 'Preview Watch pipeline',
    exact: true,
  })).toHaveCount(1);
  await expect(card.getByRole('button', {
    name: 'Open Watch pipeline details',
    exact: true,
  })).toHaveCount(1);
  const run = card.getByRole('button', {
    name: 'Run Watch pipeline',
    exact: true,
  });
  await run.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(run).toBeFocused();
});

// D-320 — the run dialog reads the recipe's slots after it opens, and the
// repaint that draws the Connection line replaced the focused dialog: focus
// fell to the page. Held until the dialog has focus, so the read always lands
// after it, as it does on a real server.
test('Recipes keeps the Run dialog focused when its Connection line arrives', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_connections=choice&hold_rpc=packs.connections.recipe`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  const run = page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: 'Run Watch pipeline', exact: true });
  await run.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(dialog).toBeFocused();
  const line = dialog.locator('[data-recued-run-modal-connection]');
  await expect(line).toHaveCount(0);
  await expect.poll(
    () => page.evaluate(() => window.__app.releaseRpcResponses?.('packs.connections.recipe')),
  ).toBe(1);
  await expect(line).toHaveCount(1);
  await expect(dialog).toBeFocused();
});

test('Recipes offers a missing pack before Run and recovers live', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed&recipe_default_run=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  const card = page.locator('[data-recued-recipes-card="autorun-live-1"]');
  await expect(card).toBeVisible();
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'recipe_runnability_changed',
      recipes: [{
        recipe_id: 'autorun-live-1',
        status: 'blocked',
        dependencies: [{
          capability: 'recued-core.officecli',
          ops: [],
          optional: false,
          satisfied: false,
          providers: [],
          unprovided_ops: [],
        }],
      }],
      cursor: 63,
    },
  }));

  await expect(card.locator('.recipes-runnability-pill')).toHaveText(
    'Cannot run. Install a Pack',
  );
  await expect(card).toContainText(
    'Install the officecli pack to make this recipe work.',
  );
  await expect(card.locator('[data-recued-recipes-run-button]')).toBeDisabled();

  await card.getByRole('button', {
    name: 'Open Watch pipeline details',
    exact: true,
  }).focus();
  await page.keyboard.press('Enter');
  const detail = page.locator('[data-recued-recipes-detail="autorun-live-1"]');
  await expect(detail).toBeVisible();
  const offer = detail.locator('[data-recued-pack-install-offer]');
  await expect(offer).toContainText(
    'This recipe needs a pack you don’t have installed yet.',
  );
  await expect(offer.getByRole('link', { name: 'Get officecli' }))
    .toHaveAttribute('href', '#packs/officecli');
  await expect(detail.locator('[data-recued-recipes-run-button]')).toBeDisabled();
  await expect(detail.getByRole('button', { name: 'Run with overrides' }))
    .toBeDisabled();

  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'recipe_runnability_changed',
      recipes: [{
        recipe_id: 'autorun-live-1',
        status: 'runnable',
        dependencies: [],
      }],
      cursor: 64,
    },
  }));

  await expect(offer).toHaveCount(0);
  const recoveredRun = detail.locator('[data-recued-recipes-run-button]');
  await expect(recoveredRun).toBeEnabled();
  await expect(recoveredRun).toHaveAttribute(
    'data-recued-recipes-action',
    'run-defaults',
  );
  await expect(detail.getByRole('button', { name: 'Run with overrides' }))
    .toBeEnabled();
});

test('Recipes preserves direct default Run focus through execution', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_default_run=1`
    + '&recipe_execute_delay_ms=2500',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: 'Open Watch pipeline details', exact: true })
    .click();
  const detail = page.locator('[data-recued-recipes-detail="autorun-live-1"]');
  await expect(detail).toBeVisible();

  const defaultRun = detail.locator('[data-recued-recipes-action="run-defaults"]');
  const executeCallsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('execute'),
  );
  await defaultRun.focus();
  await page.keyboard.press('Enter');

  await expect(defaultRun).toHaveText('Running…');
  await expect(defaultRun).toHaveAttribute('aria-disabled', 'true');
  await expect(defaultRun).toHaveAttribute('aria-busy', 'true');
  await expect(defaultRun).not.toHaveAttribute('disabled');
  await expect(defaultRun).toBeFocused();
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'recipe_runnability_changed',
      recipes: [],
      cursor: 66,
    },
  }));
  await expect(defaultRun).toHaveText('Running…');
  await expect(defaultRun).toBeFocused();
  await defaultRun.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('execute')),
  ).toBe(executeCallsBefore + 1);

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    document.querySelector<HTMLElement>('[data-recued-recipes-back]')?.click();
  });
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening. Leave anyway?',
  );
  await expect(detail).toBeVisible();
  await expect(defaultRun).toBeFocused();

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening. Leave anyway?',
  );
  await expect(page).toHaveURL(/#recipes\/autorun-live-1$/);
  await expect(detail).toBeVisible();
  await expect(defaultRun).toBeFocused();

  await expect(detail.getByRole('status')).toContainText('Run completed');
  await expect(defaultRun).toHaveText('Run');
  await expect(defaultRun).not.toHaveAttribute('aria-disabled');
  await expect(defaultRun).not.toHaveAttribute('aria-busy');
  await expect(defaultRun).toBeFocused();

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(detail).toHaveCount(0);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '2');
});

test('Recipes keeps the audit-backed Run facts receipt in modal and result', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_run_facts=1#recipes/autorun-live-1`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const detail = page.locator('[data-recued-recipes-detail="autorun-live-1"]');
  await expect(detail).toBeVisible();
  await detail.locator('[data-recued-recipes-action="open-run"]')
    .filter({ hasText: /^Run$/ })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();

  const receipt =
    '34 steps · 1,249 items · 2 provider calls · 13,385 tokens · 42 seconds';
  await expect(dialog.locator('[data-recued-run-modal-facts]')).toHaveText(receipt);
  await expect(detail.locator('[data-recued-recipes-result-facts]')).toHaveText(receipt);
});

test('Recipes protects editable result work through its save', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_result=editable-grid`
    + '&recipe_execute_delay_ms=2500',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: 'Open Watch pipeline details', exact: true })
    .click();
  const detail = page.locator('[data-recued-recipes-detail="autorun-live-1"]');
  await detail.locator('[data-recued-recipes-action="open-run"]')
    .filter({ hasText: /^Run$/ })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(detail.locator('[data-recued-recipes-result-panel]'))
    .toContainText('Save what arrived');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  const amount = detail.locator(
    '[data-recued-recipes-result-grid-cell="0:amount"]',
  );
  const status = detail.locator('.recipes-result-grid-status');
  const save = detail.locator(
    '[data-recued-recipes-action="result-grid-submit"]',
  );
  await amount.fill('800.00');
  await expect(status).toHaveText('1 row · Unsaved changes');
  await expect(save).toBeEnabled();

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    document.querySelector<HTMLElement>('[data-recued-recipes-back]')?.click();
  });
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'You have changes you have not saved. Leave anyway?',
  );
  await expect(detail).toBeVisible();
  await expect(amount).toHaveValue('800.00');

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'You have changes you have not saved. Leave anyway?',
  );
  await expect(page).toHaveURL(/#recipes\/autorun-live-1$/);
  await expect(amount).toHaveValue('800.00');

  const executeCallsBeforeSave = await page.evaluate(
    () => window.__app.rpcCallCount('execute'),
  );
  await save.click();
  await expect(status).toHaveText('1 row · Saving changes…');
  await expect(save).toHaveText('Saving…');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toBeFocused();
  await save.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('execute')),
  ).toBe(executeCallsBeforeSave + 1);

  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-recued-recipes-back]')?.click();
  });
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening. Leave anyway?',
  );
  await expect(detail).toBeVisible();

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening. Leave anyway?',
  );
  await expect(page).toHaveURL(/#recipes\/autorun-live-1$/);
  await expect(detail).toBeVisible();

  await expect(status).toHaveText('1 row · No changes yet');
  await expect(amount).toHaveValue('800.00');
  await expect(save).toBeDisabled();
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toHaveAttribute('tabindex', '-1');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).toBeFocused();

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(detail).toHaveCount(0);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '4');
});

test('Recipes owns result search and paging through every repaint', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_result=paged-filter`
    + '&recipe_execute_delay_ms=2000',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: 'Open Watch pipeline details', exact: true })
    .click();
  const detail = page.locator('[data-recued-recipes-detail="autorun-live-1"]');
  await detail.locator('[data-recued-recipes-action="open-run"]')
    .filter({ hasText: /^Run$/ })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(detail.getByText('page-one-row', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  const status = detail.locator(
    '[data-recued-recipes-result-filter] [data-var-key="status"]',
  );
  const search = detail.locator(
    '[data-recued-recipes-action="result-filter-search"]',
  );
  await status.fill('closed');
  await search.focus();
  await page.keyboard.press('Enter');

  await expect(search).toHaveText('Running…');
  await expect(search).toHaveAttribute('aria-disabled', 'true');
  await expect(search).toHaveAttribute('aria-busy', 'true');
  await expect(search).not.toHaveAttribute('disabled');
  await expect(search).toBeFocused();

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    document.querySelector<HTMLElement>('[data-recued-recipes-back]')?.click();
  });
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening. Leave anyway?',
  );
  await expect(search).toBeFocused();

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening. Leave anyway?',
  );
  await expect(page).toHaveURL(/#recipes\/autorun-live-1$/);
  await expect(search).toBeFocused();

  await expect(search).toHaveText('Search jobs');
  await expect(search).not.toHaveAttribute('aria-disabled');
  await expect(search).not.toHaveAttribute('aria-busy');
  await expect(search).toBeFocused();

  const next = detail.locator(
    '[data-recued-recipes-result-filter-page="next"]',
  );
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(next).toHaveText('Loading next page…');
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await expect(next).toHaveAttribute('aria-busy', 'true');
  await expect(next).not.toHaveAttribute('disabled');
  await expect(next).toBeFocused();

  await expect(detail.getByText('page-two-row', { exact: true })).toBeVisible();
  const previous = detail.locator(
    '[data-recued-recipes-result-filter-page="previous"]',
  );
  await expect(previous).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(previous).toHaveText('Loading previous page…');
  await expect(previous).toHaveAttribute('aria-disabled', 'true');
  await expect(previous).toHaveAttribute('aria-busy', 'true');
  await expect(previous).not.toHaveAttribute('disabled');
  await expect(previous).toBeFocused();

  await expect(detail.getByText('page-one-row', { exact: true })).toBeVisible();
  await expect(next).toBeFocused();

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(detail).toHaveCount(0);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '2');
});

test('Recipes restores the replaced detail Run opener after execution', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: 'Open Watch pipeline details', exact: true })
    .click();
  const detail = page.locator('[data-recued-recipes-detail="autorun-live-1"]');
  const opener = detail.locator('[data-recued-recipes-action="open-run"]')
    .filter({ hasText: /^Run$/ });
  await opener.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(dialog).toBeFocused();
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(dialog.locator('[data-recued-run-modal-result]'))
    .toContainText('Run completed');
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  await close.focus();
  await page.keyboard.press('Enter');

  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

// D-319 — the Config button is gone: a recipe's settings are its dishes'.
// This demo's recipe runs when the owner runs it, so "Running as" offers
// Save settings: it reads what a first dish starts from, then opens the form.
test('Recipes keeps Save settings owned while reading what a first dish starts from', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_default_run=1&hold_rpc=dishes.defaults`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: 'Open Watch pipeline details', exact: true })
    .click();
  const detail = page.locator('[data-recued-recipes-detail="autorun-live-1"]');
  await expect(detail.locator('[data-recued-recipes-action="open-recipe-config"]')).toHaveCount(0);
  const switchOn = detail.locator(
    '[data-recued-running-as-action="save-settings"][data-recued-running-as-recipe="autorun-live-1"]',
  );
  await expect(switchOn).toHaveText('Save settings');
  const readsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('dishes.defaults'),
  );
  await switchOn.focus();
  await page.keyboard.press('Enter');

  await expect(switchOn).toHaveText('Saving…');
  await expect(switchOn).toHaveAttribute('aria-disabled', 'true');
  await expect(switchOn).toHaveAttribute('aria-busy', 'true');
  await expect(switchOn).not.toHaveAttribute('disabled');
  await expect(switchOn).toBeFocused();
  await switchOn.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('dishes.defaults')),
  ).toBe(readsBefore + 1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('dishes.defaults')))
    .toBe(1);
  const editor = page.getByRole('dialog', { name: 'Edit config' });
  await expect(editor).toBeFocused();
  await expect(editor).toContainText('Settings for “Watch pipeline”');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(switchOn).toHaveText('Save settings');
  await expect(switchOn).toBeFocused();
});

test('Recipes returns a failed Save settings read to its action with a retryable error', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_default_run=1&dishes_defaults_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: 'Open Watch pipeline details', exact: true })
    .click();
  const detail = page.locator('[data-recued-recipes-detail="autorun-live-1"]');
  const switchOn = detail.locator(
    '[data-recued-running-as-action="save-settings"][data-recued-running-as-recipe="autorun-live-1"]',
  );
  await switchOn.focus();
  await page.keyboard.press('Enter');

  await expect(switchOn).toHaveText('Saving…');
  await expect(switchOn).toHaveAttribute('aria-disabled', 'true');
  await expect(switchOn).toHaveAttribute('aria-busy', 'true');
  await expect(switchOn).toBeFocused();

  const alert = detail.locator('[data-recued-running-as] [role="alert"]');
  await expect(alert).toContainText('Recued could not read what this recipe starts from');
  await expect(alert).toContainText('Settings are temporarily unavailable');
  await expect(switchOn).toHaveText('Save settings');
  await expect(switchOn).not.toHaveAttribute('aria-disabled');
  await expect(switchOn).not.toHaveAttribute('aria-busy');
  await expect(switchOn).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Edit config' })).toHaveCount(0);
});

test('Recipes keeps Save settings owned through failure and retry', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_default_run=1`
    + '&dishes_create_response=fail-once-slow-retry'
    + '&dishes_create_delay_ms=2500',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: 'Open Watch pipeline details', exact: true })
    .click();
  const detail = page.locator('[data-recued-recipes-detail="autorun-live-1"]');
  await detail.locator(
    '[data-recued-running-as-action="save-settings"]'
    + '[data-recued-running-as-recipe="autorun-live-1"]',
  ).click();

  const editor = page.getByRole('dialog', { name: 'Edit config' });
  const limit = editor.locator('[data-var-key="limit"]');
  await limit.fill('40');
  const confirm = editor.locator(
    '[data-recued-config-editor-action="confirm"]',
  );
  const close = editor.getByRole('button', { name: 'Close', exact: true });
  const callsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('dishes.create'),
  );
  await confirm.focus();
  await page.keyboard.press('Enter');

  await expect(confirm).toHaveText('Saving…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await expect(limit).toBeDisabled();
  await expect(close).toHaveAttribute('aria-disabled', 'true');
  await expect(close).not.toHaveAttribute('disabled');
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  await confirm.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('dishes.create')),
  ).toBe(callsBefore + 1);

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    window.__app.setHash('#data');
  });
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening. Leave anyway?',
  );
  await expect(page).toHaveURL(/#recipes\/autorun-live-1$/);
  await expect(editor).toBeVisible();
  await expect(confirm).toBeFocused();

  await expect(editor.getByRole('alert')).toHaveText(
    "Recued could not save that. What you typed is still here. Try again.",
  );
  await expect(limit).toHaveValue('40');
  await expect(limit).toBeEnabled();
  await expect(confirm).toHaveText('Save');
  await expect(confirm).not.toHaveAttribute('aria-disabled');
  await expect(confirm).not.toHaveAttribute('aria-busy');
  await expect(confirm).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Saving…');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('dishes.create')),
  ).toBe(callsBefore + 2);
  await expect(editor).toHaveCount(0);
  // Saved: the dish's line is drawn, and its switch has the focus.
  const dishSwitch = detail.locator('[data-recued-running-as-dish][role="switch"]');
  await expect(dishSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(dishSwitch).toHaveAccessibleName('Watch pipeline');
  await expect(dishSwitch).toBeFocused();

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Recipes preserves related auto-run action ownership', async ({ page }) => {
  await page.route('https://recued.com/catalog/**', async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.goto(
    `${HARNESS_URL}?recipes=related-autorun&auto_run_update_delay_ms=2500`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  const reactiveCard = page.locator(
    '[data-recued-recipes-card="autorun-live-1"]',
  );
  await expect(reactiveCard.locator('[data-recued-recipes-run-button]'))
    .toHaveCount(0);
  await expect(reactiveCard.getByRole('link', {
    name: 'Manage automation for Watch pipeline',
    exact: true,
  })).toHaveAttribute('href', '#automation/autorun-live-1');
  await reactiveCard.getByRole('button', {
    name: 'Open Watch pipeline details',
    exact: true,
  }).click();
  const detail = page.locator(
    '[data-recued-recipes-detail="autorun-live-1"]',
  );
  const detailHeader = detail.locator('.recipes-detail-header');
  await expect(detailHeader.locator(
    '[data-recued-recipes-action="open-run"], '
      + '[data-recued-recipes-action="run-defaults"], '
      + '[data-recued-recipes-action="open-schedule"]',
  )).toHaveCount(0);
  // D-319 — no timer toggle in the header: the recipe runs as its dish,
  // switched under "Running as".
  await expect(detailHeader.locator(
    '[data-recued-recipes-action^="toggle-auto-run"]',
  )).toHaveCount(0);
  await expect(detail.locator(
    '[data-recued-running-as-dish="dsh_autorun"][role="switch"]',
  )).toHaveAccessibleName('Watch pipeline');
  await expect(detailHeader.getByRole('link', {
    name: 'Manage automation',
    exact: true,
  })).toHaveAttribute('href', '#automation/autorun-live-1');
  const row = page.locator('[data-recued-recipes-related-row="close-action"]');
  const pause = row.locator(
    '[data-recued-recipes-action="toggle-auto-run:off"]',
  );
  await expect(row.getByRole('link', {
    name: 'Open Close action (close-action)',
    exact: true,
  })).toHaveCount(1);
  await expect(row.getByRole('link', {
    name: 'Automation for Close action (close-action)',
    exact: true,
  })).toHaveCount(1);
  await expect(row.getByRole('link', {
    name: 'Logs for Close action (close-action)',
    exact: true,
  })).toHaveCount(1);
  await expect(pause).toHaveAccessibleName(
    'Pause auto-run Close action (close-action)',
  );
  const callsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('auto_run.update'),
  );
  await pause.focus();
  await page.keyboard.press('Enter');

  await expect(pause).toHaveText('Pausing…');
  await expect(pause).toHaveAccessibleName(
    'Pausing… Close action (close-action)',
  );
  await expect(pause).toHaveAttribute('aria-disabled', 'true');
  await expect(pause).toHaveAttribute('aria-busy', 'true');
  await expect(pause).not.toHaveAttribute('disabled');
  await expect(pause).toBeFocused();
  await pause.evaluate((button) => {
    (button as HTMLElement).click();
    (button as HTMLElement).click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('auto_run.update')),
  ).toBe(callsBefore + 1);

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    document.querySelector<HTMLElement>('[data-recued-recipes-back]')?.click();
  });
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening. Leave anyway?',
  );
  await expect(row).toBeVisible();
  await expect(pause).toBeFocused();

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening. Leave anyway?',
  );
  await expect(page).toHaveURL(/#recipes\/autorun-live-1$/);
  await expect(row).toBeVisible();
  await expect(pause).toBeFocused();

  const arm = row.locator(
    '[data-recued-recipes-action="toggle-auto-run:on"]',
  );
  await expect(arm).toHaveText('Arm auto-run');
  await expect(arm).toHaveAccessibleName(
    'Arm auto-run Close action (close-action)',
  );
  await expect(arm).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(arm).toHaveText('Setting it to run on its own…');
  const logs = row.locator('[data-recued-recipes-runs-link]');
  await logs.focus();
  await expect(row.locator(
    '[data-recued-recipes-action="toggle-auto-run:off"]',
  )).toHaveText('Pause auto-run');
  await expect(logs).toBeFocused();

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(row).toHaveCount(0);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '2');
});

test('Recipes keeps workflow-pack recovery focused and single-flight', async ({ page }) => {
  let membershipCalls = 0;
  let releaseMembership!: () => void;
  const membershipReleased = new Promise<void>((resolve) => {
    releaseMembership = resolve;
  });
  await page.route('https://recued.com/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/catalog/recipes.json') {
      await route.fulfill({
        json: ['autorun-live-1', 'close-action'].map((recipe_id) => ({
          recipe_id,
          publisher_id: 'recued-core',
          name: recipe_id === 'autorun-live-1' ? 'Watch pipeline' : 'Close action',
          description: '',
          type: 'recipe',
          version: 1,
          platforms: [],
          tags: [],
          download_count: 0,
          rating_avg: 0,
          rating_count: 0,
          created_at: '',
          depends_on: [],
          recipe_bundle: 'recued-core/pipeline-response',
        })),
      });
      return;
    }
    if (pathname === '/catalog/packs.json') {
      await route.fulfill({
        json: [{
          slug: 'pipeline-response',
          publisher_id: 'recued-core',
          name: 'Pipeline Response',
          description: '',
          version: 1,
          pack_kind: 'app_pack',
          tags: [],
          download_count: 0,
          item_count: 2,
          recipe_refs: [],
          created_at: '',
        }],
      });
      return;
    }
    if (pathname === '/packs/pipeline-response.json') {
      membershipCalls += 1;
      if (membershipCalls === 1) {
        await route.fulfill({ status: 503, json: { error: 'temporarily unavailable' } });
        return;
      }
      await membershipReleased;
      await route.fulfill({
        json: {
          slug: 'pipeline-response',
          publisher: 'recued-core',
          recipes: [
            { slug: 'autorun-live-1', version: 1 },
            { slug: 'close-action', version: 1 },
          ],
        },
      });
      return;
    }
    await route.fulfill({ json: [] });
  });

  await page.goto(`${HARNESS_URL}?recipes=related-autorun`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));
  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: 'Open Watch pipeline details', exact: true })
    .click();

  const status = page.locator(
    '[data-recued-recipes-bundle-status="pipeline-response"]',
  );
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(status).toContainText(
    'Couldn’t verify this recipe’s workflow pack contents.',
  );
  const retry = page.locator(
    '[data-recued-recipes-bundle-retry="pipeline-response"]',
  );
  await expect(retry).toHaveText('Retry workflow pack');
  await retry.focus();
  await page.keyboard.press('Enter');

  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.dispatchEvent('click');
  await retry.dispatchEvent('click');
  await expect.poll(() => membershipCalls).toBe(2);

  releaseMembership();
  const workflowPack = page.locator(
    '[data-recued-recipes-bundle-pack="pipeline-response"]',
  );
  await expect(workflowPack).toHaveText('See the whole Pack');
  await expect(status).toHaveCount(0);
  await expect(workflowPack).toBeFocused();
  expect(membershipCalls).toBe(2);
});

test('Recipes preserves installed search focus through a live repaint', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  const search = page.getByRole('searchbox', {
    name: 'Search installed recipes',
  });
  await search.fill('pipeline');
  await expect(search).toHaveValue('pipeline');
  await search.evaluate((input) => {
    (input as HTMLInputElement).setSelectionRange(2, 2);
  });

  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'recipe_runnability_changed',
      recipes: [],
      cursor: 63,
    },
  }));

  await expect(search).toHaveValue('pipeline');
  await expect(search).toBeFocused();
  expect(await search.evaluate((input) =>
    (input as HTMLInputElement).selectionStart)).toBe(2);
});

test('Recipes preserves an installed filter chip through repaints', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  const chip = page.getByRole('group', { name: 'Filter by type' })
    .getByRole('button', { name: 'Manual', exact: true });
  expect((await chip.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(chip).toBeFocused();

  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'recipe_runnability_changed',
      recipes: [],
      cursor: 64,
    },
  }));
  await expect(chip).toBeFocused();
});

test('Recipes keeps paging controls reachable across page repaints', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  const pager = page.getByRole('navigation', {
    name: 'Installed recipes pages',
  });
  const next = pager.getByRole('button', { name: 'Next', exact: false });
  const previous = pager.getByRole('button', { name: 'Previous', exact: false });
  await expect(pager).toContainText('Page 1 of 3');

  await next.focus();
  await page.keyboard.press('Enter');
  await expect(pager).toContainText('Page 2 of 3');
  await expect(next).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(pager).toContainText('Page 3 of 3');
  await expect(previous).toBeFocused();

  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'recipe_runnability_changed',
      recipes: [],
      cursor: 65,
    },
  }));
  await expect(previous).toBeFocused();
});

test('Recipes preserves Refresh focus through its RPC lifecycle', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const calls = await page.evaluate(
    () => window.__app.rpcCallCount('recipe.list'),
  );
  await refresh.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (before) => window.__app.rpcCallCount('recipe.list') > before,
    calls,
  );
  await expect(refresh).toBeFocused();
});

test('Recipes Discover keeps focus on a facet chip through query repaints', async ({ page }) => {
  await page.route('https://recued.com/catalog/search?**', async (route) => {
    const url = new URL(route.request().url());
    const gmailOnly = url.searchParams.get('f.platform') === 'gmail';
    const recipes = [
      {
        recipe_id: 'mail-digest',
        publisher_id: 'recued-core',
        name: 'Mail digest',
        description: 'Summarize unread mail.',
        version: 1,
        platforms: ['gmail'],
        tags: ['mail'],
        depends_on: [],
      },
      {
        recipe_id: 'sales-review',
        publisher_id: 'recued-core',
        name: 'Sales review',
        description: 'Review new sales records.',
        version: 1,
        platforms: ['hubspot'],
        tags: ['sales'],
        depends_on: [],
      },
    ];
    const rows = gmailOnly ? recipes.slice(0, 1) : recipes;
    await route.fulfill({
      json: {
        rows,
        total: rows.length,
        totalPages: 1,
        page: 1,
        facets: {
          platform: [
            { value: 'gmail', count: 1 },
            { value: 'hubspot', count: 1 },
          ],
          tag: [
            { value: 'mail', count: 1 },
            { value: 'sales', count: 1 },
          ],
        },
      },
    });
  });
  await page.evaluate(() => window.__app.setHash('#recipes'));
  await page.locator('[data-recued-discovery-tab="discover"]').click();

  const gmail = page.locator('[data-facet="platform"][data-value="gmail"]');
  await expect(gmail).toBeVisible();
  expect((await gmail.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await gmail.focus();
  await expect(gmail).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(gmail).toHaveAttribute('aria-pressed', 'true');
  await expect(gmail).toBeFocused();
  await expect(page.locator('[data-recued-discover-card]')).toHaveCount(1);
});

test('Recipes Discover contains long facets and results at a narrow viewport', async ({ page }) => {
  const longIdentity = 'identity'.repeat(28);
  const longPublisher = `publisher-${'identity'.repeat(20)}`;
  const longPlatform = `platform-${'identity'.repeat(18)}`;
  const longTag = `tag-${'identity'.repeat(18)}`;
  await page.setViewportSize({ width: 280, height: 844 });
  await page.route('https://recued.com/catalog/search?**', async (route) => {
    await route.fulfill({
      json: {
        rows: [{
          recipe_id: `discover-${longIdentity}`,
          publisher_id: longPublisher,
          name: `Discover${'N'.repeat(240)}`,
          description: `description-${'content'.repeat(35)}`,
          version: 1,
          platforms: [longPlatform],
          tags: [longTag],
          depends_on: [`pack-${'identity'.repeat(20)}`],
        }],
        total: 1,
        totalPages: 1,
        page: 1,
        facets: {
          platform: [{ value: longPlatform, count: 1 }],
          tag: [{ value: longTag, count: 1 }],
        },
      },
    });
  });
  await page.goto(`${HARNESS_URL}?recipes=installed#recipes`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-discovery-tab="discover"]').click();

  const panel = page.locator('[data-recued-discover-panel]');
  const card = panel.locator('[data-recued-discover-card]');
  await expect(card.locator('.discover-card-title')).toContainText('DiscoverNN');
  const owners = panel.locator(
    ':scope, .discover-controls, .discover-filters, .discover-chip-group, '
    + '.discover-grid, [data-recued-discover-card], .discover-card-head, '
    + '.discover-card-title, .discover-badge, .discover-card-foot, '
    + '.discover-card-meta',
  );
  expect(await owners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  expect(await panel.evaluate((element) => {
    const parent = element.parentElement;
    return parent !== null && parent.scrollWidth <= parent.clientWidth + 1;
  })).toBe(true);
  const facetHeights = await panel.locator('.discover-chip').evaluateAll(
    (chips) => chips.map((chip) => chip.getBoundingClientRect().height),
  );
  expect(facetHeights).toHaveLength(2);
  expect(Math.min(...facetHeights)).toBeGreaterThanOrEqual(44);
  expect((await card.locator('[data-recued-discover-action]').boundingBox())?.height)
    .toBeGreaterThanOrEqual(36);
});

test('Recipes Discover keeps dependency install ownership through a slow failure', async ({ page }) => {
  await page.route('https://recued.com/catalog/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/catalog/versions')) {
      await route.fulfill({ json: { versions: {} } });
      return;
    }
    if (url.pathname.endsWith('/catalog/search')) {
      await route.fulfill({
        json: {
          rows: [{
            recipe_id: 'mail-digest',
            publisher_id: 'recued-core',
            name: 'Mail digest',
            description: 'Summarize unread mail.',
            version: 1,
            platforms: ['gmail'],
            tags: ['mail'],
            depends_on: ['recued-core.missing-mail'],
          }],
          total: 1,
          totalPages: 1,
          page: 1,
          facets: {},
        },
      });
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: 'Marketplace catalogue unavailable.' },
    });
  });
  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_install_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));
  await page.locator('[data-recued-discovery-tab="discover"]').click();

  const action = page.locator(
    '[data-recued-discover-action][data-id="mail-digest"]',
  );
  await action.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Install Mail digest' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog).toBeFocused();

  const install = dialog.locator('[data-recued-recipe-dialog-install]');
  await install.focus();
  await page.keyboard.press('Enter');
  await expect(install).toHaveText('Installing…');
  await expect(install).toHaveAttribute('aria-disabled', 'true');
  await expect(install).toHaveAttribute('aria-busy', 'true');
  await expect(install).not.toHaveAttribute('disabled');
  await expect(install).toBeFocused();

  await install.dispatchEvent('click');
  await install.dispatchEvent('click');
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('recipe.installBySlug'),
  )).toBe(1);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(install).toBeFocused();

  await expect(dialog.getByRole('alert'))
    .toHaveText('Recipe install unavailable.');
  await expect(install).toHaveText('Install recipe');
  await expect(install).not.toHaveAttribute('aria-disabled');
  await expect(install).not.toHaveAttribute('aria-busy');
  await expect(install).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(action).toBeFocused();
});

test('Recipes gives a missing dependency a named mobile install target', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.route('https://recued.com/catalog/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/catalog/versions')) {
      await route.fulfill({ json: { versions: {} } });
      return;
    }
    if (url.pathname.endsWith('/catalog/search')) {
      await route.fulfill({
        json: {
          rows: [{
            recipe_id: 'mail-digest',
            publisher_id: 'recued-core',
            name: 'Mail digest',
            description: 'Summarize unread mail.',
            version: 1,
            platforms: ['gmail'],
            tags: ['mail'],
            depends_on: ['recued-core.installed-mail'],
          }],
          total: 1,
          totalPages: 1,
          page: 1,
          facets: {},
        },
      });
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: 'Marketplace catalogue unavailable.' },
    });
  });
  await page.goto(
    `${HARNESS_URL}?recipes=installed&packs=installed&packs_installed=0`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));
  await page.locator('[data-recued-discovery-tab="discover"]').click();
  await page.locator(
    '[data-recued-discover-action][data-id="mail-digest"]',
  ).click();

  const dialog = page.getByRole('dialog', { name: 'Install Mail digest' });
  const dependency = dialog.getByRole('checkbox', {
    name: 'Install Installed Mail',
  });
  await expect(dependency).toBeChecked();
  const labelHeight = await dependency.evaluate((node) => (
    node.closest('label')?.getBoundingClientRect().height ?? 0
  ));
  expect(labelHeight).toBeGreaterThanOrEqual(36);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth))
    .toBe(true);

  await dependency.focus();
  await page.keyboard.press('Space');
  await expect(dependency).not.toBeChecked();
  await expect(dependency).toBeFocused();
});

test('Recipes contains long dependency consent content at a narrow viewport', async ({ page }) => {
  const longPackSlug = `pack-${'identity'.repeat(7)}`;
  await page.setViewportSize({ width: 280, height: 844 });
  await page.route('https://recued.com/catalog/search?**', async (route) => {
    await route.fulfill({
      json: {
        rows: [{
          recipe_id: `dialog-${'identity'.repeat(28)}`,
          publisher_id: `publisher-${'identity'.repeat(24)}`,
          name: `Install${'N'.repeat(240)}`,
          description: 'Open the dependency consent surface.',
          version: 123456789,
          platforms: ['mail'],
          tags: ['workflow'],
          depends_on: [`recued-core.${longPackSlug}`],
        }],
        total: 1,
        totalPages: 1,
        page: 1,
        facets: {},
      },
    });
  });
  await page.goto(
    `${HARNESS_URL}?recipes=installed&packs=installed`
    + '&packs_installed=0&connection_text=long#recipes',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-discovery-tab="discover"]').click();
  await page.locator('[data-recued-discover-action]').click();

  const dialog = page.getByRole('dialog', { name: /^Install InstallN/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.recipe-dialog-meta')).toContainText('publisher-identity');
  const owners = dialog.locator(
    ':scope, :scope > *, .recipe-dialog-deps, '
    + '[data-recued-recipe-dialog-dep], .recipe-dialog-dep-head, '
    + '.recipe-dialog-dep-select, .recipe-dialog-dep-name, '
    + '[data-recued-install-grant-picker], .igp-access-list, '
    + '.igp-access-row, .igp-scope-list, .igp-scope-row, .recipe-dialog-foot',
  );
  expect(await owners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  const frame = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
    };
  });
  expect(frame.left).toBeGreaterThanOrEqual(9.5);
  expect(frame.right).toBeLessThanOrEqual(frame.viewportWidth - 9.5);
  const dependency = dialog.getByRole('checkbox', { name: 'Install Installed Mail' });
  const install = dialog.locator('[data-recued-recipe-dialog-install]');
  expect((await dependency.locator('..').boundingBox())?.height)
    .toBeGreaterThanOrEqual(36);
  expect((await install.boundingBox())?.height).toBeGreaterThanOrEqual(40);
});

test('Recipes Discover keeps marketplace recovery focused and single-flight', async ({ page }) => {
  let searchCalls = 0;
  await page.route('https://recued.com/catalog/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/catalog/versions')) {
      await route.fulfill({ json: { versions: {} } });
      return;
    }
    if (url.pathname.endsWith('/catalog/search')) {
      searchCalls += 1;
      if (searchCalls === 1) {
        await route.fulfill({
          status: 503,
          json: { error: 'Marketplace unavailable.' },
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
      await route.fulfill({
        json: {
          rows: [{
            recipe_id: 'mail-digest',
            publisher_id: 'recued-core',
            name: 'Mail digest',
            description: 'Summarize unread mail.',
            version: 1,
            platforms: ['gmail'],
            tags: ['mail'],
            depends_on: [],
          }],
          total: 1,
          totalPages: 1,
          page: 1,
          facets: {},
        },
      });
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: 'Marketplace catalogue unavailable.' },
    });
  });
  await page.evaluate(() => window.__app.setHash('#recipes'));
  await page.locator('[data-recued-discovery-tab="discover"]').click();

  const status = page.locator('[data-recued-discover-status]');
  await expect(status).toHaveAttribute('role', 'alert');
  const retry = page.locator('[data-recued-discover-retry]');
  await expect(retry).toHaveText('Retry');
  expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await retry.focus();
  await page.keyboard.press('Enter');

  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.dispatchEvent('click');
  await retry.dispatchEvent('click');
  await expect.poll(() => searchCalls).toBe(2);

  const card = page.locator(
    '[data-recued-discover-card][data-id="mail-digest"]',
  );
  await expect(card).toBeVisible();
  await expect(card.locator('[data-recued-discover-action]')).toBeFocused();
  await expect(retry).toHaveCount(0);
});

test('Recipes discovery tabs form one arrow-key keyboard stop', async ({ page }) => {
  await page.route('https://recued.com/catalog/search?**', async (route) => {
    await route.fulfill({
      json: {
        rows: [],
        total: 0,
        totalPages: 1,
        page: 1,
        facets: {},
      },
    });
  });
  await page.evaluate(() => window.__app.setHash('#recipes'));

  const installed = page.locator('[data-recued-discovery-tab="installed"]');
  const discover = page.locator('[data-recued-discovery-tab="discover"]');
  await expect(page.getByRole('tablist', {
    name: 'Recipe library sections',
  })).toBeVisible();
  await expect(installed).toHaveAttribute(
    'aria-controls',
    'recued-recipes-library-installed-panel',
  );
  await expect(page.getByRole('tabpanel', { name: 'Installed' })).toBeVisible();
  await expect(installed).toHaveAttribute('tabindex', '0');
  await expect(discover).toHaveAttribute('tabindex', '-1');
  await installed.focus();
  await page.keyboard.press('ArrowRight');

  await expect(discover).toHaveAttribute('aria-selected', 'true');
  await expect(discover).toHaveAttribute('tabindex', '0');
  await expect(discover).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Discover' })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(installed).toHaveAttribute('aria-selected', 'true');
  await expect(installed).toHaveAttribute('tabindex', '0');
  await expect(installed).toBeFocused();
});
