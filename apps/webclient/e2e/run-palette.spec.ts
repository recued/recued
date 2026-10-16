import { expect, test } from '@playwright/test';
import {
  CHAT_ACTIVATION_ACTION, CREATE_OVERLAY, DRAWER_ACTION, DRAWER_TOGGLE,
  GLOBAL_RUN_PALETTE_TRIGGER, HARNESS_URL, RUN_PALETTE, SHELL_TOPBAR,
  installFullAppHooks,
} from './helpers/full-app.js';

/** Run palette browser journeys against the deterministic full-app harness. */
const RUN_PALETTE_CLOSE = 'data-recued-run-palette-close';
const RUN_PALETTE_ACTION = 'data-recued-run-palette-action';
const RUN_PALETTE_RESULT = 'data-recued-run-palette-result';
const RUN_PALETTE_RETRY = 'data-recued-run-palette-retry';

installFullAppHooks();

test('the shell owns one Run palette across routes and Ctrl+K opens it globally', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 653 });
  await page.goto(`${HARNESS_URL}?run_palette=autorun#data`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const trigger = page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`);
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(trigger).toHaveAttribute(
    'aria-keyshortcuts',
    'Control+K Meta+K',
  );
  expect((await trigger.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const topbarGeometry = await page.locator(`[${SHELL_TOPBAR}]`).evaluate(
    (topbar) => {
      const rect = topbar.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        scrollWidth: topbar.scrollWidth,
        clientWidth: topbar.clientWidth,
        viewport: window.innerWidth,
      };
    },
  );
  expect(topbarGeometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(topbarGeometry.right).toBeLessThanOrEqual(topbarGeometry.viewport + 0.5);
  expect(topbarGeometry.scrollWidth).toBeLessThanOrEqual(
    topbarGeometry.clientWidth,
  );

  const overlay = page.locator(`[${RUN_PALETTE}]`);
  await trigger.click();
  await expect(overlay).toHaveCount(1);
  await page.keyboard.press('Control+K');
  await expect(overlay).toHaveCount(1);
  expect(await overlay.evaluate((node) => node.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await expect(trigger).toBeFocused();

  const content = page.locator('[data-recued-webclient-content]');
  await content.focus();
  const composing = await content.evaluate((node) => {
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    const dispatched = node.dispatchEvent(event);
    return { dispatched, defaultPrevented: event.defaultPrevented };
  });
  expect(composing).toEqual({ dispatched: true, defaultPrevented: false });
  await expect(overlay).toHaveCount(0);

  await page.keyboard.press('Control+K');
  await expect(overlay).toHaveCount(1);
  await page.evaluate(() => window.__app.setHash('#settings'));
  await expect(page).toHaveURL(/#settings$/);
  await expect(overlay).toHaveCount(0);
  await expect(trigger).toBeVisible();

  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await page.locator(`[${DRAWER_ACTION}="create"]`).click();
  const createOverlay = page.locator(`[${CREATE_OVERLAY}]`);
  await expect(createOverlay).toBeVisible();
  await page.keyboard.press('Control+K');
  await expect(overlay).toHaveCount(0);
  await expect(createOverlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(createOverlay).toHaveCount(0);

  await page.keyboard.press('Control+K');
  await expect(overlay).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
});

test('the first-run recipe handoff traps focus and recovers an empty inventory', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const automate = page.locator(
    `[${CHAT_ACTIVATION_ACTION}="automate"]`,
  );
  await automate.click();

  const overlay = page.locator(`[${RUN_PALETTE}]`);
  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(overlay).toBeVisible();
  await expect(dialog).toBeFocused();
  await expect(dialog).toContainText('You have no Recipes yet.');
  await expect(dialog.getByRole('combobox', { name: 'Recipe' })).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: /Look through starter Packs/ }))
    .toHaveAttribute('href', '#packs');

  const close = page.locator(`[${RUN_PALETTE_CLOSE}]`);
  expect((await close.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await overlay.evaluate((node) => node.contains(document.activeElement)))
    .toBe(true);

  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await expect(automate).toBeFocused();
});

test('the Run palette stays contained with usable mobile targets', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 480 });
  await page.goto(`${HARNESS_URL}?run_palette=autorun`);
  await page.waitForFunction(() => window.__app?.ready === true);
  // Installed recipes retire Chat's first-run card; the shell launcher stays.
  await page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`).click();

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  const geometry = await dialog.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(15.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth - 15.5);

  const close = page.locator(`[${RUN_PALETTE_CLOSE}]`);
  const picker = dialog.getByRole('combobox', { name: 'Recipe' });
  expect((await close.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  expect((await picker.boundingBox())?.height).toBeGreaterThanOrEqual(36);

  await picker.fill('Watch pipeline');
  const option = page.getByRole('option', { name: /Watch pipeline/ });
  await expect(option).toBeVisible();
  expect((await option.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  const optionRow = dialog.locator('.ref-picker-option').first();
  await optionRow.locator('.ref-picker-option-label').evaluate((label) => {
    label.textContent =
      'UNBROKEN_REFERENCE_LABEL_THAT_IS_MUCH_LONGER_THAN_THE_AVAILABLE_PHONE_PICKER_WIDTH_123456789';
  });
  await optionRow.locator('.ref-picker-option-sub').evaluate((sublabel) => {
    sublabel.textContent =
      'publisher/pack/entity/UNBROKEN_REFERENCE_IDENTIFIER_ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789';
  });
  const resultWidths = await dialog.locator('.ref-picker-results')
    .evaluate((results) => ({
      client: results.clientWidth,
      scroll: results.scrollWidth,
    }));
  expect(resultWidths.scroll).toBeLessThanOrEqual(resultWidths.client);
  await optionRow.click();

  const clear = dialog.getByRole('button', { name: 'Clear selection' });
  const pause = page.locator(`[${RUN_PALETTE_ACTION}]`, { hasText: 'Pause' });
  const clearTarget = await clear.boundingBox();
  expect(clearTarget?.width).toBeGreaterThanOrEqual(36);
  expect(clearTarget?.height).toBeGreaterThanOrEqual(36);
  expect((await pause.boundingBox())?.height).toBeGreaterThanOrEqual(36);
});

test('the Run palette contains a long installed recipe after selection', async ({ page }) => {
  const longName = `Recipe${'N'.repeat(240)}`;
  const longId = `autorun-${'I'.repeat(240)}`;
  await page.setViewportSize({ width: 280, height: 480 });
  await page.goto(`${HARNESS_URL}?run_palette=long`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`).click();

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  const picker = dialog.getByRole('combobox', { name: 'Recipe' });
  await picker.fill('RecipeNN');
  const option = dialog.locator('.ref-picker-option').first();
  await expect(option.locator('.ref-picker-option-label')).toHaveText(longName);
  await expect(option.locator('.ref-picker-option-sub')).toHaveText(longId);
  await option.click();

  const selected = dialog.locator('.run-palette-selected');
  await expect(selected).toHaveText(longName);
  await expect(dialog.locator(`[${RUN_PALETTE_ACTION}]`, { hasText: 'Pause' }))
    .toBeVisible();
  const geometry = await dialog.evaluate((node) => {
    const elements = [
      node,
      node.querySelector<HTMLElement>('.run-palette-actions'),
      node.querySelector<HTMLElement>('.run-palette-selected'),
      node.querySelector<HTMLElement>('.run-palette-state'),
      ...node.querySelectorAll<HTMLElement>(
        '[data-recued-run-palette-action]',
      ),
    ].filter((element): element is HTMLElement => element !== null);
    return elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    });
  });
  for (const bounds of geometry) {
    expect(bounds.left).toBeGreaterThanOrEqual(15.5);
    expect(bounds.right).toBeLessThanOrEqual(264.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }
});

test('the Run palette leaves composing Escape to its recipe picker', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?run_palette=autorun`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const trigger = page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`);
  await trigger.click();

  const overlay = page.locator(`[${RUN_PALETTE}]`);
  const picker = page.getByRole('combobox', { name: 'Recipe' });
  await picker.fill('監視レシピ');
  await picker.focus();
  const composingEscape = await picker.evaluate((input) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    const dispatched = input.dispatchEvent(event);
    return { dispatched, defaultPrevented: event.defaultPrevented };
  });
  expect(composingEscape).toEqual({
    dispatched: true,
    defaultPrevented: false,
  });
  await expect(overlay).toBeVisible();
  await expect(picker).toHaveValue('監視レシピ');
  await expect(picker).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(overlay).toBeVisible();
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('the Run palette keeps inventory recovery focused and single-flight', async ({ page }) => {
  // Chat's activation read would consume the injected inventory failure.
  await page.goto(
    `${HARNESS_URL}?run_palette=inventory-retry&hold_rpc=recipe.list#data`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  expect(await page.evaluate(() => window.__app.rpcCallCount('recipe.list')))
    .toBe(0);
  await page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`).click();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('recipe.list')),
  ).toBe(1);
  expect(await page.evaluate(
    () => window.__app.releaseRpcResponses?.('recipe.list'),
  )).toBe(1);

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(dialog.getByRole('alert')).toHaveText('Recued could not load your Recipes.');
  const retry = page.locator(`[${RUN_PALETTE_RETRY}]`);
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('recipe.list'),
  );
  await retry.focus();
  await page.keyboard.press('Enter');

  await expect(retry).toHaveText('Trying again…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('recipe.list')),
  ).toBe(before + 1);
  expect(await page.evaluate(
    () => window.__app.releaseRpcResponses?.('recipe.list'),
  )).toBe(1);

  const picker = dialog.getByRole('combobox', { name: 'Recipe' });
  await expect(picker).toBeVisible();
  await expect(picker).toBeFocused();
  await expect(retry).toHaveCount(0);
});

test('the Run palette guards an in-flight auto-run toggle and route leave', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?run_palette=autorun&hold_rpc=auto_run.update`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`).click();

  const recipe = page.getByRole('combobox', { name: 'Recipe' });
  await expect(recipe).toBeVisible();
  await recipe.fill('Watch pipeline');
  await page.getByRole('option', { name: /Watch pipeline/ }).click();

  const pause = page.locator(`[${RUN_PALETTE_ACTION}]`, {
    hasText: 'Pause',
  });
  await expect(pause).toBeVisible();
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('auto_run.update'),
  );
  await pause.focus();
  await pause.evaluate((button) => {
    (button as HTMLElement).click();
    (button as HTMLElement).click();
  });

  const overlay = page.locator(`[${RUN_PALETTE}]`);
  const close = page.locator(`[${RUN_PALETTE_CLOSE}]`);
  await expect(close).toHaveAttribute('aria-disabled', 'true');
  await expect(close).not.toHaveAttribute('disabled');
  await page.keyboard.press('Escape');
  await expect(overlay).toBeVisible();
  await close.dispatchEvent('click');
  await close.dispatchEvent('click');
  await overlay.dispatchEvent('click');
  await expect(overlay).toBeVisible();
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return window.dispatchEvent(event);
  })).toBe(false);

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
    'A recipe action is still in progress. Leave this page anyway?',
  );
  await expect.poll(
    () => page.evaluate(() => window.location.hash),
  ).toBe('');
  await expect(overlay).toBeVisible();

  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('auto_run.update'),
    ),
  ).toBe(before + 1);
  expect(await page.evaluate(
    () => window.__app.releaseRpcResponses?.('auto_run.update'),
  )).toBe(1);
  await expect(page.locator(`[${RUN_PALETTE_ACTION}]`, { hasText: 'Arm' }))
    .toBeFocused();
  await expect(close).not.toHaveAttribute('aria-disabled');
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return window.dispatchEvent(event);
  })).toBe(true);

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(overlay).toHaveCount(0);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('the Run palette switches a recipe on through its settings, never arming it bare', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?run_palette=not-switched-on`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`).click();

  const recipe = page.getByRole('combobox', { name: 'Recipe' });
  await recipe.fill('Watch pipeline');
  await page.getByRole('option', { name: /Watch pipeline/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(dialog).toContainText('Not switched on');
  const switchOn = page.locator(`[${RUN_PALETTE_ACTION}]`, { hasText: 'Switch on…' });
  await switchOn.click();

  // D-319 §5.5 — its settings first, in the form the recipe page uses.
  const form = page.locator('.config-editor-panel[role="dialog"]');
  await expect(form).toContainText('Switch on “Watch pipeline”');
  await expect(form).toContainText('It runs every minute.');
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(page.locator(`[${RUN_PALETTE}]`)).toBeVisible();
  await expect(switchOn).toBeFocused();

  await switchOn.click();
  await form.locator('[data-recued-config-editor-action="confirm"]').click();
  await expect(page.locator(`[${RUN_PALETTE_ACTION}]`, { hasText: 'Pause' })).toBeVisible();
  expect(await page.evaluate(() => window.__app.rpcCallCount('dishes.create'))).toBe(1);
  expect(await page.evaluate(() => window.__app.rpcCallCount('auto_run.update'))).toBe(0);
});

test('the Run palette retains a pending toggle through its Automation handoff', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?run_palette=autorun&hold_rpc=auto_run.update`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`).click();

  const recipe = page.getByRole('combobox', { name: 'Recipe' });
  await expect(recipe).toBeVisible();
  await recipe.fill('Watch pipeline');
  await page.getByRole('option', { name: /Watch pipeline/ }).click();
  await page.locator(`[${RUN_PALETTE_ACTION}]`, { hasText: 'Pause' }).click();

  await recipe.fill('Review failed runs');
  await page.getByRole('option', { name: /Review failed runs/ }).click();
  const manage = page.getByRole('link', { name: 'Manage in Automation →' });
  const overlay = page.locator(`[${RUN_PALETTE}]`);
  const html = page.locator('html');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
  });

  await manage.click();
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'A recipe action is still in progress. Leave this page anyway?',
  );
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
  await expect(overlay).toBeVisible();

  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('auto_run.update')),
  ).toBe(1);
  expect(await page.evaluate(
    () => window.__app.releaseRpcResponses?.('auto_run.update'),
  )).toBe(1);
  await expect(page.locator(`[${RUN_PALETTE_CLOSE}]`))
    .not.toHaveAttribute('aria-disabled');
  await manage.click();
  await expect(page).toHaveURL(/#automation\/managed-live-1$/);
  await expect(overlay).toHaveCount(0);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('the Run palette restores auto-run action focus after its state changes', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?run_palette=autorun`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`).click();

  const recipe = page.getByRole('combobox', { name: 'Recipe' });
  await recipe.fill('Watch pipeline');
  await page.getByRole('option', { name: /Watch pipeline/ }).click();

  const pause = page.locator(`[${RUN_PALETTE_ACTION}]`, {
    hasText: 'Pause',
  });
  await pause.focus();
  await page.keyboard.press('Enter');

  const arm = page.locator(`[${RUN_PALETTE_ACTION}]`, { hasText: 'Arm' });
  await expect(arm).toBeVisible();
  await expect(arm).toBeFocused();
});

test('the Run palette reports a failed auto-run update in place', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?run_palette=autorun-fail`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`).click();

  const recipe = page.getByRole('combobox', { name: 'Recipe' });
  await recipe.fill('Watch pipeline');
  await page.getByRole('option', { name: /Watch pipeline/ }).click();

  const pause = page.locator(`[${RUN_PALETTE_ACTION}]`, {
    hasText: 'Pause',
  });
  await pause.focus();
  await page.keyboard.press('Enter');

  const result = page.locator(`[${RUN_PALETTE_RESULT}]`);
  await expect(result).toHaveAttribute('role', 'status');
  await expect(result).toContainText('Recued could not change that');
  await expect(pause).toBeFocused();
});
