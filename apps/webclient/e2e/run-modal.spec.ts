import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

/** Shared Run modal and config editor journeys across Recipes and Automation. */
installFullAppHooks();

test('the shared Run modal leaves composing Escape to its config editor', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  const opener = page.locator('[data-recued-recipes-run-button]').first();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  const config = dialog.locator('[data-recued-run-modal-config]');
  await config.fill('{"名前":"レポート"}');
  await config.focus();
  const composingEscape = await config.evaluate((field) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    const dispatched = field.dispatchEvent(event);
    return { dispatched, defaultPrevented: event.defaultPrevented };
  });
  expect(composingEscape).toEqual({
    dispatched: true,
    defaultPrevented: false,
  });
  await expect(dialog).toBeVisible();
  await expect(config).toHaveValue('{"名前":"レポート"}');
  await expect(config).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('the shared Run modal preserves focus across execution repaints', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  const opener = page.locator('[data-recued-recipes-run-button]').first();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(dialog).toBeFocused();

  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  const running = dialog.getByRole('button', { name: 'Running...' });
  await expect(running).toHaveAttribute('aria-disabled', 'true');
  await expect(running).toBeFocused();

  await expect(dialog.locator('[data-recued-run-modal-result]'))
    .toContainText('Run completed');
  const runAgain = dialog.getByRole('button', { name: 'Run', exact: true });
  await expect(runAgain).toBeFocused();

  await runAgain.click();
  await expect(dialog.locator('[data-recued-run-modal-result]')).toHaveCount(0);
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  await close.focus();
  await expect(dialog.locator('[data-recued-run-modal-result]'))
    .toContainText('Run completed');
  await expect(close).toBeFocused();

  await runAgain.click();
  await expect(dialog.locator('[data-recued-run-modal-result]')).toHaveCount(0);
  const config = dialog.locator('[data-recued-run-modal-config]');
  await config.fill('{"next":true}');
  await config.evaluate((field) => {
    (field as HTMLTextAreaElement).setSelectionRange(2, 2);
  });
  await expect(dialog.locator('[data-recued-run-modal-result]'))
    .toContainText('Run completed');
  await expect(config).toHaveValue('{"next":true}');
  await expect(config).toBeFocused();
  expect(await config.evaluate((field) =>
    (field as HTMLTextAreaElement).selectionStart)).toBe(2);

  await close.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('the shared Run modal retains execution ownership across route leave', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));

  await page.locator('[data-recued-recipes-run-button]').first().click();
  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  const running = dialog.getByRole('button', { name: 'Running...' });
  await expect(running).toHaveAttribute('aria-disabled', 'true');
  await expect(running).toBeFocused();

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
  await expect(page).toHaveURL(/#recipes$/);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-recued-run-modal-result]'))
    .toContainText('Run completed');

  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(dialog).toHaveCount(0);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('the shared config editor keeps usable mobile targets', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 480 });
  await page.goto(`${HARNESS_URL}?recipes=installed&recipe_default_run=1`);
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
  // Recipe metadata owns this heading; a single unbroken pack-provided name
  // must not push Close or Save outside the modal.
  await editor.locator('.config-editor-title').evaluate((title) => {
    title.textContent =
      'UNBROKEN_RECIPE_CONFIGURATION_TITLE_THAT_EXCEEDS_A_PHONE_VIEWPORT_123456789';
  });
  const geometry = await editor.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const close = node.querySelector(
      '[data-recued-config-editor-action="cancel"]',
    )?.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      closeRight: close?.right ?? Number.POSITIVE_INFINITY,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(23.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth - 23.5);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.closeRight).toBeLessThanOrEqual(geometry.right);
  const targets = editor.locator('button:visible, input:visible, select:visible');
  const sizes = await targets.evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  // Close, the recipe's one setting, "Also on a schedule", and Save.
  expect(sizes).toHaveLength(4);
  expect(Math.min(...sizes.map(({ width }) => width)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.min(...sizes.map(({ height }) => height)))
    .toBeGreaterThanOrEqual(36);
});

test('the shared Run modal tabs form one arrow-key keyboard stop', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));
  await page.locator('[data-recued-recipes-run-button]').first().click();

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  const tabs = dialog.getByRole('tab');
  const run = tabs.getByText('Run', { exact: true });
  const schedule = tabs.getByText('Schedule', { exact: true });
  await expect(run).toHaveAttribute('aria-selected', 'true');
  await expect(run).toHaveAttribute('tabindex', '0');
  await expect(schedule).toHaveAttribute('tabindex', '-1');
  expect(await tabs.evaluateAll((nodes) => nodes.filter(
    (node) => node.getAttribute('tabindex') === '0',
  ).length)).toBe(1);

  await run.focus();
  await page.keyboard.press('ArrowRight');
  await expect(schedule).toHaveAttribute('aria-selected', 'true');
  await expect(schedule).toBeFocused();
  const panel = dialog.getByRole('tabpanel');
  await expect(panel).toHaveAttribute('aria-labelledby', await schedule.getAttribute('id') ?? '');

  await page.keyboard.press('Home');
  await expect(run).toHaveAttribute('aria-selected', 'true');
  await expect(run).toBeFocused();
});

test('the shared Run modal stays contained with usable mobile targets', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 480 });
  await page.goto(`${HARNESS_URL}?recipes=installed&recipe_default_run=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));
  await page.locator('[data-recued-recipes-run-button]').first().click();

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

  const runTargetHeights = await dialog.getByRole('button').evaluateAll(
    (buttons) => buttons.map((button) => button.getBoundingClientRect().height),
  );
  expect(Math.min(...runTargetHeights)).toBeGreaterThanOrEqual(36);
  const advanced = dialog.locator('.run-modal-advanced > summary');
  await expect(advanced).toBeVisible();
  expect((await advanced.boundingBox())?.height).toBeGreaterThanOrEqual(36);

  await dialog.getByRole('tab', { name: 'Schedule' }).click();
  const preset = dialog.getByRole('combobox', { name: 'Run on a schedule' });
  expect((await preset.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  const repeatTargetHeight = await dialog.getByRole('checkbox', {
    name: 'Repeat',
  }).evaluate((checkbox) => checkbox.closest('label')!
    .getBoundingClientRect().height);
  expect(repeatTargetHeight).toBeGreaterThanOrEqual(36);
  const scheduleTargetHeights = await dialog.getByRole('button').evaluateAll(
    (buttons) => buttons.map((button) => button.getBoundingClientRect().height),
  );
  expect(Math.min(...scheduleTargetHeights)).toBeGreaterThanOrEqual(36);

  const add = dialog.getByRole('button', { name: 'Add schedule' });
  await add.click();
  await expect(dialog.locator('.run-modal-rule-row')).toHaveCount(1);
  const contained = await dialog.evaluate((node) => {
    const panel = node.getBoundingClientRect();
    const row = node.querySelector('.run-modal-rule-row')
      ?.getBoundingClientRect();
    return {
      panelRight: panel.right,
      rowRight: row?.right ?? Number.POSITIVE_INFINITY,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    };
  });
  expect(contained.scrollWidth).toBeLessThanOrEqual(contained.clientWidth);
  expect(contained.rowRight).toBeLessThanOrEqual(contained.panelRight - 13.5);
});

test('the shared Run modal preserves Repeat focus while cadence controls swap', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));
  await page.locator('[data-recued-recipes-run-button]').first().click();

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await dialog.getByRole('tab', { name: 'Schedule' }).click();
  const repeat = dialog.getByRole('checkbox', { name: 'Repeat' });
  await expect(repeat).toBeChecked();

  await repeat.focus();
  await page.keyboard.press('Space');
  await expect(repeat).not.toBeChecked();
  await expect(dialog.getByRole('textbox', { name: 'Run once at' })).toBeVisible();
  await expect(repeat).toBeFocused();

  await page.keyboard.press('Space');
  await expect(repeat).toBeChecked();
  await expect(dialog.locator('[data-recued-run-modal-preset]')).toBeVisible();
  await expect(repeat).toBeFocused();
});

test('the shared Run modal preserves Schedule once validation focus', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));
  await page.locator('[data-recued-recipes-run-button]').first().click();

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await dialog.getByRole('tab', { name: 'Schedule' }).click();
  await dialog.getByRole('checkbox', { name: 'Repeat' }).uncheck();
  const scheduleOnce = dialog.getByRole('button', { name: 'Schedule once' });
  await scheduleOnce.click();

  await expect(dialog.getByRole('alert'))
    .toContainText('Pick a date and time to run once.');
  await expect(scheduleOnce).toBeFocused();

  const runAt = dialog.getByRole('textbox', { name: 'Run once at' });
  await runAt.fill('2030-01-02T09:30');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(runAt).toBeFocused();
});

test('the shared Run modal keeps Add schedule focused while creating', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));
  await page.locator('[data-recued-recipes-run-button]').first().click();

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await dialog.getByRole('tab', { name: 'Schedule' }).click();
  const add = dialog.getByRole('button', { name: 'Add schedule' });
  await add.click();

  await expect(add).toHaveAttribute('aria-disabled', 'true');
  await expect(add).toHaveAttribute('aria-busy', 'true');
  await expect(add).toBeFocused();

  await expect(dialog.locator('.run-modal-rule-row')).toHaveCount(1);
  await expect(add).not.toHaveAttribute('aria-disabled', 'true');
  await expect(add).not.toHaveAttribute('aria-busy', 'true');
  await expect(add).toBeFocused();
});

test('the shared Run modal distinguishes repeated schedule actions', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));
  await page.locator('[data-recued-recipes-run-button]').first().click();

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await dialog.getByRole('tab', { name: 'Schedule' }).click();
  const add = dialog.getByRole('button', { name: 'Add schedule' });
  await add.click();
  await expect(dialog.locator('.run-modal-rule-row')).toHaveCount(1);
  await add.click();
  await expect(dialog.locator('.run-modal-rule-row')).toHaveCount(2);

  const names = [
    'Pause schedule Every 5 minutes (schedule-run-modal-1)',
    'Pause schedule Every 5 minutes (schedule-run-modal-2)',
    'Remove schedule Every 5 minutes (schedule-run-modal-1)',
    'Remove schedule Every 5 minutes (schedule-run-modal-2)',
  ];
  for (const name of names) {
    await expect(dialog.getByRole('button', { name, exact: true })).toHaveCount(1);
  }

  const secondPause = dialog.getByRole('button', {
    name: 'Pause schedule Every 5 minutes (schedule-run-modal-2)',
    exact: true,
  });
  await secondPause.focus();
  await page.keyboard.press('Enter');
  await expect(secondPause).toHaveAttribute('aria-disabled', 'true');
  await expect(secondPause).toHaveAttribute('aria-busy', 'true');
  await expect(secondPause).toBeFocused();

  await expect(dialog.getByRole('button', {
    name: 'Resume schedule Every 5 minutes (schedule-run-modal-2)',
    exact: true,
  })).toBeFocused();
  await expect(dialog.getByRole('button', {
    name: 'Pause schedule Every 5 minutes (schedule-run-modal-1)',
    exact: true,
  })).toBeVisible();
});

test('the shared Run modal preserves schedule row action ownership', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#recipes'));
  await page.locator('[data-recued-recipes-run-button]').first().click();

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await dialog.getByRole('tab', { name: 'Schedule' }).click();
  const add = dialog.getByRole('button', { name: 'Add schedule' });
  await add.click();
  await expect(dialog.locator('.run-modal-rule-row')).toHaveCount(1);

  const pause = dialog.locator(
    '[data-recued-run-modal-action="toggle-schedule:off"]',
  );
  await pause.click();
  await expect(pause).toHaveAttribute('aria-disabled', 'true');
  await expect(pause).toHaveAttribute('aria-busy', 'true');
  await expect(pause).toBeFocused();

  const resume = dialog.locator(
    '[data-recued-run-modal-action="toggle-schedule:on"]',
  );
  await expect(resume).toBeFocused();
  await resume.click();
  await expect(pause).toBeFocused();

  const remove = dialog.locator(
    '[data-recued-run-modal-action="remove-schedule"]',
  );
  await remove.click();
  await expect(remove).toHaveAttribute('aria-disabled', 'true');
  await expect(remove).toBeFocused();
  await expect(dialog.locator('.run-modal-rule-row')).toHaveCount(0);
  await expect(add).toBeFocused();
});

test('the shared Run modal preserves trigger action ownership', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?automation=rules`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/triggers'));
  await page.getByRole('button', { name: 'Add trigger' }).click();
  const picker = page.getByRole('combobox', {
    name: 'Choose a recipe to automate',
  });
  await picker.fill('Watch pipeline');
  await page.getByRole('option', { name: /Watch pipeline/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(dialog.getByRole('tab', { name: 'Trigger' }))
    .toHaveAttribute('aria-selected', 'true');
  const pattern = dialog.locator('[data-recued-run-modal-pattern]');
  const add = dialog.getByRole('button', { name: 'Add trigger' });
  await expect(add).toBeDisabled();
  await pattern.fill('data.mail.**');
  await expect(add).toBeEnabled();
  await add.click();

  await expect(add).toHaveAttribute('aria-disabled', 'true');
  await expect(add).toHaveAttribute('aria-busy', 'true');
  await expect(add).toBeFocused();

  const row = dialog.locator('.run-modal-rule-row');
  await expect(row).toHaveCount(1);
  await expect(add).not.toHaveAttribute('aria-disabled');
  await expect(add).not.toHaveAttribute('aria-busy');
  await expect(add).toBeFocused();

  const pause = row.locator(
    '[data-recued-run-modal-action="toggle-trigger:off"]',
  );
  await pause.click();
  await expect(pause).toHaveAttribute('aria-disabled', 'true');
  await expect(pause).toHaveAttribute('aria-busy', 'true');
  await expect(pause).toBeFocused();

  const resume = row.locator(
    '[data-recued-run-modal-action="toggle-trigger:on"]',
  );
  await expect(resume).toBeFocused();
  await resume.click();
  await expect(resume).toHaveAttribute('aria-disabled', 'true');
  await expect(resume).toHaveAttribute('aria-busy', 'true');
  await expect(resume).toBeFocused();
  await expect(row.locator(
    '[data-recued-run-modal-action="toggle-trigger:off"]',
  )).toBeFocused();

  const remove = row.locator(
    '[data-recued-run-modal-action="remove-trigger"]',
  );
  await remove.click();
  await expect(remove).toHaveAttribute('aria-disabled', 'true');
  await expect(remove).toHaveAttribute('aria-busy', 'true');
  await expect(remove).toBeFocused();
  await expect(row).toHaveCount(0);
  await expect(add).toBeFocused();
});

// D-319 — a trigger belongs to a dish and has no settings of its own, so the
// row it adds offers no Config and the tab asks for none. (The settings
// editor's composing-Escape guard is covered in `config-editor-overlay.test.ts`.)
test('the shared Run modal adds a trigger with no settings of its own', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?automation=rules`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/triggers'));
  await page.getByRole('button', { name: 'Add trigger' }).click();
  const picker = page.getByRole('combobox', {
    name: 'Choose a recipe to automate',
  });
  await picker.fill('Watch pipeline');
  await page.getByRole('option', { name: /Watch pipeline/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(dialog.getByRole('textbox', { name: 'Topic' })).toHaveCount(0);
  await expect(dialog).not.toContainText('Config for runs from this trigger');
  await dialog.locator('[data-recued-run-modal-pattern]').fill('data.mail.**');
  await dialog.getByRole('button', { name: 'Add trigger' }).click();
  const row = dialog.locator('.run-modal-rule-row');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-recued-run-modal-action="config-trigger"]')).toHaveCount(0);
  await expect(row.getByRole('button', { name: /^Pause trigger/ })).toBeVisible();
});
