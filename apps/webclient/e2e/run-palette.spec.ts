import { expect, test, type Page } from '@playwright/test';
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

const PREFILL_URL = `${HARNESS_URL}?data=records&run_prefill=1`;
const openContextRecipe = async (page: Page, name: string) => {
  await page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`).click();
  await page.getByRole('combobox', { name: 'Recipe' }).fill(name);
  await page.getByRole('option', { name: new RegExp(name) }).click();
  await page.locator(`[${RUN_PALETTE_ACTION}]`).filter({ hasText: /^Run$/ }).click();
  return page.locator('.run-modal-overlay-root');
};

test('page context ranks actual matches first and fills renamed arguments without guessing another object', async ({ page }) => {
  await page.goto(`${PREFILL_URL}#data/records/publisher-a/same-board/job/job-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-action="records-close-record"]')).toBeVisible();
  await page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`).click();
  await page.getByRole('combobox', { name: 'Recipe' }).click();
  const options = page.getByRole('option');
  await expect(options.first()).toContainText('Follow up on this job');
  await expect(options.first()).toContainText('Prefills 2 arguments from this page');
  const reads = await page.evaluate(() => window.__app.rpcCallCount('recipe.get'));
  await page.getByRole('combobox', { name: 'Recipe' }).fill('Draft this job message');
  await page.getByRole('option', { name: /Draft this job message/ }).click();
  expect(await page.evaluate(() => window.__app.rpcCallCount('recipe.get'))).toBe(reads);
  await page.locator(`[${RUN_PALETTE_ACTION}]`).filter({ hasText: /^Run$/ }).click();
  const modal = page.locator('.run-modal-overlay-root');
  await expect(modal.locator('[data-var-key="subject_line"]')).toHaveValue('Prepare quote');
  await expect(modal.locator('[data-var-key="recipient"]')).toHaveValue('');
  await modal.locator('[data-var-key="subject_line"]').fill('Discuss quote');
  await modal.locator('[data-var-key="recipient"]').fill('ana@example.test');
  await modal.locator('[data-recued-run-modal-action="confirm-run"]').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-run-prefill-execute') ?? 'null')?.config))
    .toEqual({ subject_line: 'Discuss quote', recipient: 'ana@example.test' });
});

test('page context prefills a selected Records object, remains editable, and waits for Run', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${PREFILL_URL}#data/records/publisher-a/same-board/job/job-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-action="records-close-record"]')).toBeVisible();
  const modal = await openContextRecipe(page, 'Follow up on this job');
  await expect(modal.locator('[data-var-key="job_id"]')).toHaveValue('job-1');
  await expect(modal.locator('[data-var-key="title"]')).toHaveValue('Prepare quote');
  await expect(modal.locator('[data-recued-run-prefill-source]')).toContainText('Prefilled from Prepare quote');
  expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(0);
  await modal.locator('[data-var-key="title"]').fill('Follow up tomorrow');
  await modal.locator('[data-recued-run-modal-action="confirm-run"]').click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(1);
  const request = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-run-prefill-execute') ?? 'null'));
  expect(request.config).toMatchObject({ job_id: 'job-1', title: 'Follow up tomorrow' });
  expect(request.config).not.toHaveProperty('count');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('page context preserves structured arguments through JSON review and tab changes', async ({ page }) => {
  await page.goto(`${PREFILL_URL}#data/records/publisher-a/same-board/job/job-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-action="records-close-record"]')).toBeVisible();
  const modal = await openContextRecipe(page, 'Review this job object');
  await expect(modal).not.toContainText('[object Object]');
  await expect(modal.locator('[data-var-key="job"]')).toHaveCount(0);
  const json = modal.locator('[data-recued-run-modal-config]');
  await expect(json).toBeVisible();
  const config = JSON.parse(await json.inputValue());
  expect(config.job).toMatchObject({ id: 'job-1', title: 'Prepare quote' });
  config.job.title = 'Review tomorrow';
  await json.fill(JSON.stringify(config));
  await modal.getByRole('tab', { name: 'Schedule', exact: true }).click();
  await expect(modal.locator('[data-recued-run-prefill-source]')).toHaveCount(0);
  await modal.getByRole('tab', { name: 'Run', exact: true }).click();
  expect(JSON.parse(await json.inputValue()).job.title).toBe('Review tomorrow');
  await modal.locator('[data-recued-run-modal-action="confirm-run"]').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-run-prefill-execute') ?? 'null')?.config?.job?.title))
    .toBe('Review tomorrow');
});

test('page context does not cross a Records pack namespace', async ({ page }) => {
  await page.goto(`${PREFILL_URL}#data/records/publisher-a/same-board/job/job-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-action="records-close-record"]')).toBeVisible();
  const modal = await openContextRecipe(page, 'Follow up on this job');
  await expect(modal.locator('[data-var-key="job_id"]')).toHaveValue('job-1');
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Recipe' }).fill('Follow up in another pack');
  await page.getByRole('option', { name: /Follow up in another pack/ }).click();
  await page.locator(`[${RUN_PALETTE_ACTION}]`).filter({ hasText: /^Run$/ }).click();
  await expect(modal.locator('[data-var-key="job_id"]')).toHaveValue('');
  await expect(modal.locator('[data-recued-run-prefill-source]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(0);
});

test('page context is cleared after leaving a selected record', async ({ page }) => {
  await page.goto(`${PREFILL_URL}#data/records/publisher-a/same-board/job/job-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-action="records-close-record"]').click();
  const modal = await openContextRecipe(page, 'Follow up on this job');
  await expect(modal.locator('[data-var-key="job_id"]')).toHaveValue('');
  await expect(modal.locator('[data-var-key="title"]')).toHaveValue('');
  await expect(modal.locator('[data-recued-run-prefill-source]')).toHaveCount(0);
});

test('page context reads a rendered recipe record through the Installed tab shell', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed&recipe_default_run=1&recipe_result=record-fields&run_prefill=1#recipes/autorun-live-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const detail = page.locator('[data-recued-recipes-detail="autorun-live-1"]');
  await detail.locator('[data-recued-recipes-action="run-defaults"]').click();
  await expect(detail.locator('.record-fields-block')).toBeVisible();
  const modal = await openContextRecipe(page, 'Follow up on this job');
  await expect(modal.locator('[data-var-key="job_id"]')).toHaveValue('job_1');
  await expect(modal.locator('[data-var-key="title"]')).toHaveValue('Replace the circulation pump');
});

test('page context uses targets declared only in the loaded recipe body', async ({ page }) => {
  await page.goto(`${PREFILL_URL}#data/records/publisher-a/same-board/job/job-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-action="records-close-record"]')).toBeVisible();
  const modal = await openContextRecipe(page, 'Use this job as context');
  const target = modal.locator('[data-recued-run-modal-target="job_id"]');
  await expect(target).toHaveValue('job-1');
  await target.fill('job-2');
  await modal.locator('[data-recued-run-modal-action="confirm-run"]').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-run-prefill-execute') ?? 'null')?.context)).toEqual({ job_id: 'job-2' });
  await page.keyboard.press('Escape');
  await expect(page.locator(`[${RUN_PALETTE_ACTION}]`).filter({ hasText: /^Run$/ })).toBeFocused();
});

for (const mode of ['choice', 'single']) {
  test(`API page arguments keep their source account through review and Run (${mode})`, async ({ page }) => {
    await page.goto(`${HARNESS_URL}?recipes=installed&recipe_default_run=1&recipe_result=record-fields&run_prefill=1&api_record_source=hubspot&recipe_connections=${mode}#recipes/autorun-live-1`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.locator('[data-recued-recipes-detail="autorun-live-1"] [data-recued-recipes-action="run-defaults"]').click();
    await expect(page.locator('.record-fields-block')).toBeVisible();
    const before = await page.evaluate(() => window.__app.rpcCallCount('execute'));
    const modal = await openContextRecipe(page, 'Follow up with this API contact');
    await expect(modal.locator('[data-var-key="person"]')).toHaveValue('contact-42');
    await expect(modal.locator('[data-var-key="email"]')).toHaveValue('ana@example.test');
    if (mode === 'choice') await expect(modal.locator('[data-recued-run-modal-connection="hubspot"]')).toHaveValue('hubspot-app');
    expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(before);
    await modal.locator('[data-var-key="email"]').fill('edited@example.test');
    await modal.getByRole('tab', { name: 'Schedule', exact: true }).click();
    await modal.getByRole('tab', { name: 'Run', exact: true }).click();
    await modal.locator('[data-recued-run-modal-action="confirm-run"]').click();
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-run-prefill-execute') ?? 'null')))
      .toMatchObject({ config: { person: 'contact-42', email: 'edited@example.test' }, connections: { hubspot: 'hubspot-app' },
        connection_revisions: { 'hubspot-app': 'a'.repeat(64) } });
  });
}

test('API page arguments stay manual after its source account is replaced before opening Run', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed&recipe_default_run=1&recipe_result=record-fields&run_prefill=1&api_record_source=hubspot&recipe_connections=choice#recipes/autorun-live-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipes-detail="autorun-live-1"] [data-recued-recipes-action="run-defaults"]').click();
  await expect(page.locator('.record-fields-block')).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem('recued-test-api-account-revision', 'b'.repeat(64)));
  const modal = await openContextRecipe(page, 'Follow up with this API contact');
  await expect(modal.locator('[data-var-key="person"]')).toHaveValue('');
  await expect(modal.locator('[data-recued-run-prefill-source]')).toHaveCount(0);
});

test('replacing an API account while Run is open clears untouched arguments and requires review', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed&recipe_default_run=1&recipe_result=record-fields&run_prefill=1&api_record_source=hubspot&recipe_connections=choice#recipes/autorun-live-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipes-detail="autorun-live-1"] [data-recued-recipes-action="run-defaults"]').click();
  await expect(page.locator('.record-fields-block')).toBeVisible();
  const before = await page.evaluate(() => window.__app.rpcCallCount('execute'));
  const modal = await openContextRecipe(page, 'Follow up with this API contact');
  await expect(modal.locator('[data-var-key="person"]')).toHaveValue('contact-42');
  await modal.locator('[data-var-key="email"]').fill('edited@example.test');
  await page.evaluate(() => sessionStorage.setItem('recued-test-api-account-revision', 'b'.repeat(64)));
  await modal.locator('[data-recued-run-modal-action="confirm-run"]').click();
  await expect(modal).toContainText('An account used by the page changed. Review the arguments before running.');
  await expect(modal.locator('[data-var-key="person"]')).toHaveValue('');
  await expect(modal.locator('[data-var-key="email"]')).toHaveValue('edited@example.test');
  expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(before);
  await modal.getByRole('tab', { name: 'Schedule', exact: true }).click();
  await modal.getByRole('tab', { name: 'Run', exact: true }).click();
  await expect(modal.locator('[data-var-key="person"]')).toHaveValue('');
});

test('changing the API account clears untouched page arguments and retains reviewed edits', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed&recipe_default_run=1&recipe_result=record-fields&run_prefill=1&api_record_source=hubspot&recipe_connections=choice#recipes/autorun-live-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipes-detail="autorun-live-1"] [data-recued-recipes-action="run-defaults"]').click();
  await expect(page.locator('.record-fields-block')).toBeVisible();
  const before = await page.evaluate(() => window.__app.rpcCallCount('execute'));
  const modal = await openContextRecipe(page, 'Follow up with this API contact');
  await expect(modal.locator('[data-var-key="person"]')).toHaveValue('contact-42');
  await modal.locator('[data-var-key="email"]').fill('edited@example.test');
  const connection = modal.locator('[data-recued-run-modal-connection="hubspot"]');
  await connection.selectOption('hubspot-key');
  await expect(modal.locator('[data-var-key="person"]')).toHaveValue('');
  await expect(modal.locator('[data-var-key="email"]')).toHaveValue('edited@example.test');
  await expect(modal.locator('[data-recued-run-prefill-source]')).toContainText('Unedited page values were cleared');
  await modal.getByRole('tab', { name: 'Schedule', exact: true }).click();
  await modal.getByRole('tab', { name: 'Run', exact: true }).click();
  await expect(modal.locator('[data-var-key="person"]')).toHaveValue('');
  expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(before);
});

for (const [source, mode] of [['missing', 'choice'], ['salesforce', 'choice'], ['hubspot', 'unavailable']]) {
  test(`API page arguments stay manual when the source cannot match (${source}/${mode})`, async ({ page }) => {
    await page.goto(`${HARNESS_URL}?recipes=installed&recipe_default_run=1&recipe_result=record-fields&run_prefill=1&api_record_source=${source}&recipe_connections=${mode}#recipes/autorun-live-1`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.locator('[data-recued-recipes-detail="autorun-live-1"] [data-recued-recipes-action="run-defaults"]').click();
    await expect(page.locator('.record-fields-block')).toBeVisible();
    const modal = await openContextRecipe(page, 'Follow up with this API contact');
    await expect(modal.locator('[data-var-key="person"]')).toHaveValue('');
    await expect(modal.locator('[data-var-key="email"]')).toHaveValue('');
    await expect(modal.locator('[data-recued-run-prefill-source]')).toHaveCount(0);
  });
}

test('page context uses the selected Yours asset and clears on its list', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&run_prefill=1#yours/asset/passport`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-recued-yours] h2').first()).toHaveText('Ana’s passport');
  let modal = await openContextRecipe(page, 'Check this asset');
  await expect(modal.locator('[data-var-key="asset_id"]')).toHaveValue('passport');
  await expect(modal.locator('[data-var-key="name"]')).toHaveValue('Ana’s passport');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__app.setHash('#yours/assets'));
  await expect(page).toHaveURL(/#yours\/assets$/);
  modal = await openContextRecipe(page, 'Check this asset');
  await expect(modal.locator('[data-var-key="asset_id"]')).toHaveValue('');
  await expect(modal.locator('[data-recued-run-prefill-source]')).toHaveCount(0);
});

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
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('link', { name: /Look through starter Packs/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('link', { name: /Look through starter Packs/ })).toBeFocused();

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
