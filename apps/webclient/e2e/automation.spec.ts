import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

/**
 * Automation browser journeys against the deterministic full-app harness.
 * Shares the app boot and uncaught-page-error gates with full-app.spec.ts.
 * Included in e2e:webclient:full and the standard webclient Playwright config.
 */
const AUTOMATION_SUBNAV = 'data-recued-automation-subnav';
const AUTOMATION_SECTION_PANEL = 'data-recued-automation-section-panel';
const AUTOMATION_STATUS_FILTER = 'data-recued-automation-status-filter';
const AUTOMATION_ORIGIN_FILTER = 'data-recued-automation-origin-filter';
const AUTOMATION_ROW = 'data-recued-automation-row';
const AUTOMATION_RETRY = 'data-recued-automation-retry';
const AUTOMATION_ADD_ERROR = 'data-recued-automation-add-error';
const AUTOMATION_ADD_RETRY = 'data-recued-automation-add-retry';
const AUTOMATION_DISH_HISTORY = 'data-recued-dish-history';
const AUTOMATION_DISH_HISTORY_ERROR = 'data-recued-dish-history-error';
const AUTOMATION_DISH_HISTORY_RETRY = 'data-recued-dish-history-retry';

installFullAppHooks();

test('Automation keeps keyboard focus on a view tab through its repaint', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#automation'));

  // D-319 §5.4 — the nav is the page's two views.
  const comingUp = page.locator(`[${AUTOMATION_SUBNAV}="coming-up"]`);
  await expect(comingUp).toBeVisible();
  await comingUp.focus();
  await expect(comingUp).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/#automation\/coming-up$/);
  await expect(comingUp).toHaveAttribute('aria-selected', 'true');
  await expect(comingUp).toBeFocused();
});

test('Automation contains narrow navigation, the one list and long rule text', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=rules&automation_text=long#automation/coming-up`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-automation-route]');
  const comingUp = page.locator(`[${AUTOMATION_SUBNAV}="coming-up"]`);
  await expect(comingUp).toHaveAttribute('aria-selected', 'true');
  // The selected view's tab is inside the nav, scrolled to if it must be.
  expect(await comingUp.evaluate((element) => {
    const nav = element.parentElement;
    if (nav === null) return false;
    const navBox = nav.getBoundingClientRect();
    const tabBox = element.getBoundingClientRect();
    return tabBox.left >= navBox.left - 1 && tabBox.right <= navBox.right + 1;
  })).toBe(true);
  expect(await route.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);

  // D-319 §5.4 — the one list, grouped by recipe, holds long rows too.
  await page.evaluate(() => window.__app.setHash('#automation'));
  const group = route.locator('[data-recued-automation-recipe]').first();
  await expect(group).toBeVisible();
  expect(await route.locator('[data-recued-automation-recipe], [data-recued-automation-row]')
    .evaluateAll((elements) => elements.every(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ))).toBe(true);
  expect(await route.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);

  await page.evaluate(() => window.__app.setHash('#automation/triggers'));
  const row = route.locator(
    '[data-recued-automation-row^="event_trigger:"]',
  );
  await expect(row).toBeVisible();
  expect(await row.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
  const textOwners = row.locator(
    '.automation-row-title a, .automation-row-detail > *, .automation-row-meta > *',
  );
  expect(await textOwners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  expect(await route.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test('Automation is one list by recipe and dish, with filters and a way back from Details', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?automation=dishes`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation'));

  const route = page.locator('[data-recued-automation-route]');
  const group = route.locator('[data-recued-automation-recipe="daily-brief"]');
  const line = group.locator('li[data-recued-automation-dish="dish-e2e-1"]');
  await expect(line).toBeVisible();
  // A schedule made before D-319 belongs to no dish: it sits under its recipe.
  await expect(group.locator('[data-recued-automation-row="schedule:schedule-e2e-1"]')).toBeVisible();
  expect(await route.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);

  const off = route.locator('[data-recued-automation-chip="off"]');
  await off.click();
  await expect(off).toHaveAttribute('aria-pressed', 'true');
  await expect(off).toBeFocused();
  await expect(line).toHaveCount(0);
  await off.click();
  await expect(off).toHaveAttribute('aria-pressed', 'false');
  await expect(line).toBeVisible();

  const details = line.locator('[data-recued-automation-action="detail:dish"]');
  await details.click();
  const back = route.locator('[data-recued-automation-back]');
  await expect(back).toHaveText('Back to By recipe');
  await expect(page).toHaveURL(/#automation\/dishes\/dish-e2e-1$/);
  await back.click();
  await expect(page).toHaveURL(/#automation\/all$/);
  await expect(details).toBeFocused();
});

test('Automation contains long rule facts in narrow detail views', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=rules&automation_text=long#automation/triggers`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-automation-route]');
  const row = route.locator(
    '[data-recued-automation-row^="event_trigger:"]',
  );
  await row.getByRole('button', { name: /^Details / }).click();

  const detail = route.locator('[data-recued-automation-detail]');
  await expect(detail).toBeVisible();
  const textOwners = detail.locator(
    '[data-recued-automation-detail-heading] a, .automation-detail-facts, '
    + '.automation-detail-facts dd',
  );
  expect(await textOwners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  expect(await detail.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
  expect(await route.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test('Automation contains its narrow authoring picker and modal header', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=rules&automation_text=long#automation/schedules`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  await page.getByRole('button', { name: 'Add schedule' }).click();
  const actions = page.locator('.automation-section-actions');
  const picker = actions.locator('.automation-add-picker');
  const option = picker.locator('.ref-picker-option').first();
  await expect(option).toBeVisible();
  expect(await actions.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
  expect(await picker.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);

  await option.click();
  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(dialog).toBeVisible();
  const headerOwners = dialog.locator(
    '.run-modal-header, .run-modal-title, .run-modal-recipe-id, '
    + '.run-modal-close',
  );
  expect(await headerOwners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  const closeTarget = await dialog.getByRole('button', { name: 'Close' })
    .boundingBox();
  expect(closeTarget?.width).toBeGreaterThanOrEqual(36);
  expect(closeTarget?.height).toBeGreaterThanOrEqual(36);
  const dialogGeometry = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right };
  });
  expect(dialogGeometry.left).toBeGreaterThanOrEqual(15.5);
  expect(dialogGeometry.right).toBeLessThanOrEqual(264.5);
});

test('Automation contains long recovery messages with a usable retry', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=rules&automation_text=long`
    + '&automation_list_response=fail-twice-slow-retry#automation/schedules',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-automation-route]');
  const error = route.locator('[data-recued-automation-error="schedule"]');
  await expect(error).toHaveAttribute('role', 'alert');
  expect(await error.evaluate((element) => {
    const message = element.querySelector('span');
    return element.scrollWidth <= element.clientWidth + 1
      && message !== null
      && message.scrollWidth <= message.clientWidth + 1;
  })).toBe(true);
  const retryTarget = await error.getByRole('button', { name: 'Retry' })
    .boundingBox();
  expect(retryTarget?.width).toBeGreaterThanOrEqual(36);
  expect(retryTarget?.height).toBeGreaterThanOrEqual(36);
  expect(await route.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test('Automation contains long inline poll status and controls', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=rules&automation_text=long`
    + '&automation_watch_response=slow#automation/triggers',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-automation-route]');
  const poll = route.locator('.automation-poll');
  await expect(poll).toBeVisible();
  expect(await poll.evaluate((element) => [
    element,
    ...element.querySelectorAll('span'),
  ].every((owner) => owner.scrollWidth <= owner.clientWidth + 1))).toBe(true);
  const targets = await poll.getByRole('button').evaluateAll(
    (buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        clientWidth: button.clientWidth,
        scrollWidth: button.scrollWidth,
      };
    }),
  );
  for (const target of targets) {
    expect(target.width).toBeGreaterThanOrEqual(36);
    expect(target.height).toBeGreaterThanOrEqual(36);
    expect(target.scrollWidth).toBeLessThanOrEqual(target.clientWidth + 1);
  }
  expect(await route.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test('Automation view tabs form one arrow-key keyboard stop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#automation'));

  // D-319 §5.4 — two views: By recipe and Coming up.
  const tabs = page.locator(`[${AUTOMATION_SUBNAV}]`);
  const all = page.locator(`[${AUTOMATION_SUBNAV}="all"]`);
  const comingUp = page.locator(`[${AUTOMATION_SUBNAV}="coming-up"]`);
  const panel = page.locator(`[${AUTOMATION_SECTION_PANEL}]`);
  await expect(tabs).toHaveCount(2);
  const tabHeights = await tabs.evaluateAll((nodes) => nodes.map(
    (node) => node.getBoundingClientRect().height,
  ));
  expect(Math.min(...tabHeights)).toBeGreaterThanOrEqual(36);
  await expect(panel).toHaveAttribute(
    'aria-labelledby',
    'recued-automation-section-tab-all',
  );
  await expect(page.getByRole('tabpanel', { name: /By recipe/ })).toBeVisible();
  await expect(all).toHaveAttribute('aria-selected', 'true');
  await expect(all).toHaveAttribute('tabindex', '0');
  const stops = () => tabs.evaluateAll((nodes) => nodes.filter(
    (node) => node.getAttribute('tabindex') === '0',
  ).length);
  expect(await stops()).toBe(1);

  await all.focus();
  await page.keyboard.press('ArrowRight');
  await expect(comingUp).toHaveAttribute('aria-selected', 'true');
  await expect(comingUp).toHaveAttribute('tabindex', '0');
  await expect(comingUp).toBeFocused();
  await expect(panel).toHaveAttribute(
    'aria-labelledby',
    'recued-automation-section-tab-coming-up',
  );
  await expect(page).toHaveURL(/#automation\/coming-up$/);

  await page.keyboard.press('Home');
  await expect(all).toHaveAttribute('aria-selected', 'true');
  await expect(all).toBeFocused();
  await page.keyboard.press('End');
  await expect(comingUp).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(all).toHaveAttribute('aria-selected', 'true');
  await expect(all).toBeFocused();

  // A list by kind (a rule's Details, an older link) has no tab of its own:
  // the nav keeps its one keyboard stop.
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));
  await expect(all).toHaveAttribute('aria-selected', 'false');
  await expect(all).toHaveAttribute('tabindex', '0');
  expect(await stops()).toBe(1);
});

test('Automation keeps keyboard focus on its status filter through repaint', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // D-319 §5.4 — the one list filters by its chips; a list by kind keeps
  // its Status filter.
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));

  const status = page.locator(`[${AUTOMATION_STATUS_FILTER}]`);
  await expect(status).toBeVisible();
  await status.focus();
  await expect(status).toBeFocused();
  await status.selectOption('on');

  await expect(status).toHaveValue('on');
  await expect(status).toBeFocused();
});

test('Automation keeps keyboard focus on its origin filter through repaint', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#automation/triggers'));

  const origin = page.locator(`[${AUTOMATION_ORIGIN_FILTER}]`);
  await expect(origin).toBeVisible();
  await origin.focus();
  await expect(origin).toBeFocused();
  await origin.selectOption('user');

  await expect(origin).toHaveValue('user');
  await expect(origin).toBeFocused();
});

test('Automation keeps a failed Schedules Retry focused and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=rules&automation_list_response=fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));

  const error = page.locator('[data-recued-automation-error="schedule"]');
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toContainText('Schedules are temporarily unavailable.');
  const retry = page.locator(`[${AUTOMATION_RETRY}="schedules"]`);
  await expect(retry).toHaveText('Retry');
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('schedules.list'),
  );
  await retry.focus();
  await page.keyboard.press('Enter');

  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('schedules.list')),
  ).toBe(before + 1);

  await expect(error).toHaveCount(0);
  await expect(page.locator(
    '[data-recued-automation-action="detail:schedule"]'
    + '[data-rule-id="schedule-e2e-1"]',
  )).toBeVisible();
  // D-319 §5.4 — a list by kind has no tab of its own: focus lands on the
  // nav's one keyboard stop.
  await expect(page.locator(`[${AUTOMATION_SUBNAV}="all"]`))
    .toBeFocused();
});

test('Automation returns a failed Schedules Retry to its alert action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=rules&automation_list_response=fail-twice-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));

  const retry = page.locator(`[${AUTOMATION_RETRY}="schedules"]`);
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');

  await expect(retry).toHaveText('Retry');
  await expect(retry).not.toHaveAttribute('aria-disabled');
  await expect(retry).not.toHaveAttribute('aria-busy');
  await expect(retry).toBeFocused();
  await expect(page.locator('[data-recued-automation-error="schedule"]'))
    .toHaveAttribute('role', 'alert');
});

test('Automation gives standalone row navigation a full mobile target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?automation=dishes`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/dishes'));

  const recipe = page.locator('.automation-row-title a', {
    hasText: 'Morning digest',
  });
  await expect(recipe).toBeVisible();
  expect((await recipe.boundingBox())?.height).toBeGreaterThanOrEqual(36);

  const route = page.locator('[data-recued-automation-route]');
  expect(await route.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test('Automation gives list and detail handoffs full mobile targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?automation=rules`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));

  const route = page.locator('[data-recued-automation-route]');
  const listHandoffs = route.locator('a:visible');
  await expect(listHandoffs).toHaveCount(2);
  for (const link of await listHandoffs.all()) {
    const target = await link.boundingBox();
    expect(target?.width).toBeGreaterThanOrEqual(36);
    expect(target?.height).toBeGreaterThanOrEqual(36);
  }

  await page.locator(
    '[data-recued-automation-action="detail:schedule"]'
    + '[data-rule-id="schedule-e2e-1"]',
  ).click();
  const detailHandoffs = route.locator('a:visible');
  await expect(detailHandoffs).toHaveCount(3);
  for (const link of await detailHandoffs.all()) {
    const target = await link.boundingBox();
    expect(target?.width).toBeGreaterThanOrEqual(36);
    expect(target?.height).toBeGreaterThanOrEqual(36);
  }
  expect(await route.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test('Automation recovers a failed dish history read without losing focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=dishes&automation_history_response=fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/dishes'));

  const dish = page.locator(`[${AUTOMATION_ROW}="dish:dish-e2e-1"]`);
  const details = dish.locator(
    '[data-recued-automation-action="detail:dish"]',
  );
  await details.focus();
  await page.keyboard.press('Enter');

  const heading = page.getByRole('heading', { name: 'Morning digest', exact: true });
  const error = page.locator(
    `[${AUTOMATION_DISH_HISTORY_ERROR}="dish-e2e-1"]`,
  );
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toContainText('Dish history is temporarily unavailable.');
  await expect(page.getByText('No runs recorded for this dish.')).toHaveCount(0);
  await expect(heading).toBeFocused();

  const retry = page.locator(
    `[${AUTOMATION_DISH_HISTORY_RETRY}="dish-e2e-1"]`,
  );
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('dishes.history'),
  );
  await retry.focus();
  await page.keyboard.press('Enter');

  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('dishes.history')),
  ).toBe(before + 1);

  await expect(error).toHaveCount(0);
  await expect(page.locator(
    `[${AUTOMATION_DISH_HISTORY}="dish-e2e-1"]`,
  )).toContainText('succeeded');
  await expect(heading).toBeFocused();
});

test('Automation keeps dish rename focus through cancel and save reconciliation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=dishes&automation_dish_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/dishes'));

  const rename = page.getByRole('button', {
    name: 'Rename Morning digest (dish-e2e-1)',
    exact: true,
  });
  await rename.focus();
  await page.keyboard.press('Enter');

  const input = page.getByRole('textbox', {
    name: 'Rename Morning digest (dish-e2e-1)',
    exact: true,
  });
  await expect(input).toHaveValue('Morning digest');
  await expect(input).toBeFocused();
  const cancel = page.getByRole('button', {
    name: 'Cancel renaming Morning digest (dish-e2e-1)',
    exact: true,
  });
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(rename).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
  await input.fill('Evening digest');
  const save = page.getByRole('button', {
    name: 'Save name for Morning digest (dish-e2e-1)',
    exact: true,
  });
  const updatesBefore = await page.evaluate(
    () => window.__app.rpcCallCount('dishes.update'),
  );
  await save.focus();
  await page.keyboard.press('Enter');

  const renaming = page.getByRole('button', {
    name: 'Renaming… Morning digest (dish-e2e-1)',
    exact: true,
  });
  await expect(renaming).toHaveText('Renaming…');
  await expect(renaming).toHaveAttribute('aria-disabled', 'true');
  await expect(renaming).toHaveAttribute('aria-busy', 'true');
  await expect(renaming).not.toHaveAttribute('disabled');
  await expect(renaming).toBeFocused();
  await renaming.dispatchEvent('click');
  await renaming.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('dishes.update')),
  ).toBe(updatesBefore + 1);

  const renamed = page.getByRole('button', {
    name: 'Rename Evening digest (dish-e2e-1)',
    exact: true,
  });
  await expect(renamed).toBeVisible();
  await expect(renamed).toBeFocused();
});

test('Automation keeps focus on its recipe filter after keyboard selection', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`${HARNESS_URL}?automation=rules`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));
  await expect(page.locator(
    '[data-recued-automation-action="detail:schedule"]'
    + '[data-rule-id="schedule-e2e-1"]',
  )).toBeVisible();

  const picker = page.getByRole('combobox', {
    name: 'Show only one Recipe',
  });
  await picker.focus();
  await expect(page.getByRole('option', { name: 'daily-brief', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  const composingEnter = await picker.evaluate((input) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    const dispatched = input.dispatchEvent(event);
    return { dispatched, defaultPrevented: event.defaultPrevented };
  });
  expect(composingEnter).toEqual({
    dispatched: true,
    defaultPrevented: false,
  });
  await expect(picker).toHaveValue('');
  await expect(page.getByRole('option', { name: 'daily-brief', exact: true }))
    .toBeVisible();
  expect((await page.getByRole('option', {
    name: 'daily-brief',
    exact: true,
  }).boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await page.keyboard.press('Enter');

  await expect(picker).toHaveValue('daily-brief');
  await expect(picker).toBeFocused();
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('option', {
    name: 'daily-brief',
    exact: true,
  })).toHaveCount(0);
  expect((await picker.boundingBox())?.height).toBeGreaterThanOrEqual(36);

  await page.keyboard.press('Tab');
  const clear = page.getByRole('button', { name: 'Clear selection' });
  await expect(clear).toBeFocused();
  const clearTarget = await clear.boundingBox();
  expect(clearTarget?.width).toBeGreaterThanOrEqual(36);
  expect(clearTarget?.height).toBeGreaterThanOrEqual(36);
  await page.keyboard.press('Enter');
  await expect(picker).toHaveValue('');
  await expect(picker).toBeFocused();
});

test('Automation preserves a recipe query and caret through live refresh', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?automation=rules`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));
  await expect(page.locator(
    '[data-recued-automation-action="detail:schedule"]'
    + '[data-rule-id="schedule-e2e-1"]',
  )).toBeVisible();

  const picker = page.getByRole('combobox', {
    name: 'Show only one Recipe',
  });
  await picker.fill('daily');
  await picker.evaluate((input) => {
    (input as HTMLInputElement).setSelectionRange(2, 2);
  });
  const listCalls = await page.evaluate(
    () => window.__app.rpcCallCount('schedules.list'),
  );
  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: { kind: 'automation_rule_changed', cursor: 51 },
    });
  });
  await page.waitForFunction(
    (before) => window.__app.rpcCallCount('schedules.list') > before,
    listCalls,
  );

  await expect(picker).toHaveValue('daily');
  await expect(picker).toBeFocused();
  expect(await picker.evaluate((input) =>
    (input as HTMLInputElement).selectionStart)).toBe(2);
});

test('Automation moves focus into and back from its Add picker', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));

  const add = page.getByRole('button', { name: 'Add schedule' });
  await expect(add).toBeVisible();
  await add.focus();
  await page.keyboard.press('Enter');

  const picker = page.getByRole('combobox', {
    name: 'Choose a recipe to automate',
  });
  await expect(picker).toBeVisible();
  await expect(picker).toHaveAttribute('aria-expanded', 'true');
  await expect(picker).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(add).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(picker).toHaveCount(0);
  await expect(add).toBeFocused();
});

test('Automation Add inventory retry stays explicit, single-flight, and focus-owned', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=rules`
    + '&automation_recipe_list_response=fail-once-slow-retry'
    + '#automation/schedules',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.waitForFunction(
    () => window.__app.rpcCallCount('recipe.list') >= 2,
  );

  const add = page.getByRole('button', { name: 'Add schedule' });
  await add.focus();
  await page.keyboard.press('Enter');

  const failure = page.locator(`[${AUTOMATION_ADD_ERROR}="schedules"]`);
  await expect(failure).toHaveAttribute('role', 'alert');
  await expect(failure).toContainText(
    'Installed recipes are temporarily unavailable.',
  );
  await expect(page.getByText('No installed Recipes match.')).toHaveCount(0);
  await expect(page.getByRole('combobox', {
    name: 'Choose a recipe to automate',
  })).toHaveCount(0);

  const callsBeforeRetry = await page.evaluate(
    () => window.__app.rpcCallCount('recipe.list'),
  );
  const retry = page.locator(`[${AUTOMATION_ADD_RETRY}="schedules"]`);
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).toBeFocused();
  await retry.dispatchEvent('click');
  await retry.dispatchEvent('click');
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('recipe.list'),
  )).toBe(callsBeforeRetry + 1);

  const picker = page.getByRole('combobox', {
    name: 'Choose a recipe to automate',
  });
  await expect(picker).toBeVisible();
  await expect(picker).toBeFocused();
  await expect(failure).toHaveCount(0);
});

test('Automation returns schedule-modal focus to its Add trigger', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?automation=rules`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));

  const add = page.getByRole('button', { name: 'Add schedule' });
  await add.click();
  const picker = page.getByRole('combobox', {
    name: 'Choose a recipe to automate',
  });
  await picker.fill('Watch pipeline');
  await page.getByRole('option', { name: /Watch pipeline/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(dialog.getByRole('tab', { name: 'Schedule' }))
    .toHaveAttribute('aria-selected', 'true');
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  await close.focus();
  await page.keyboard.press('Enter');

  await expect(dialog).toHaveCount(0);
  await expect(add).toBeVisible();
  await expect(add).toBeFocused();
});

test('Automation keeps its create modal owned until the command settles', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?automation=rules`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/triggers'));

  const routeAdd = page.getByRole('button', { name: 'Add trigger' });
  await routeAdd.click();
  const picker = page.getByRole('combobox', {
    name: 'Choose a recipe to automate',
  });
  await picker.fill('Watch pipeline');
  await page.getByRole('option', { name: /Watch pipeline/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await dialog.locator('[data-recued-run-modal-pattern]').fill('data.mail.**');
  const add = dialog.getByRole('button', { name: 'Add trigger' });
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
  await add.focus();
  await page.keyboard.press('Enter');

  await expect(add).toHaveAttribute('aria-disabled', 'true');
  await page.evaluate(() => window.__app.setHash('#data'));
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening here. Leave anyway?',
  );
  await expect(page).toHaveURL(/#automation\/triggers$/);
  await expect(dialog).toBeVisible();
  await expect(add).toBeFocused();
  await expect(add).toHaveAttribute('aria-busy', 'true');
  await expect(add).toBeFocused();
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toHaveAttribute('aria-disabled', 'true');
  await expect(close).not.toHaveAttribute('disabled');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await close.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect(dialog).toBeVisible();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('triggers.create')),
  ).toBe(1);

  await expect(dialog.locator('.run-modal-rule-row')).toHaveCount(1);
  await expect(close).not.toHaveAttribute('aria-disabled');
  await close.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(routeAdd).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Automation restores the exact schedule toggle after mutation re-list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=rules&automation_schedule_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));

  const pause = page.locator(
    '[data-recued-automation-action="toggle:schedule:off"]'
    + '[data-rule-id="schedule-e2e-1"]',
  );
  await expect(pause).toBeVisible();
  await pause.focus();
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('schedules.update'),
  );
  await page.keyboard.press('Enter');

  await expect(pause).toHaveText('Pausing…');
  await expect(pause).toHaveAttribute('aria-disabled', 'true');
  await expect(pause).toHaveAttribute('aria-busy', 'true');
  await expect(pause).not.toHaveAttribute('disabled');
  await expect(pause).toBeFocused();
  await pause.dispatchEvent('click');
  await pause.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('schedules.update')),
  ).toBe(before + 1);

  const resume = page.locator(
    '[data-recued-automation-action="toggle:schedule:on"]'
    + '[data-rule-id="schedule-e2e-1"]',
  );
  await expect(resume).toBeVisible();
  await expect(resume).toBeFocused();
  await expect(page.locator('[data-recued-automation-state]')).toHaveText('Paused');

  await page.keyboard.press('Enter');
  await expect(pause).toBeVisible();
  await expect(pause).toBeFocused();
  await expect(page.locator('[data-recued-automation-state]')).toHaveText('On');
});

test('Automation restores failed schedule mutation focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=rules&automation_schedule_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));

  const pause = page.locator(
    '[data-recued-automation-action="toggle:schedule:off"]'
    + '[data-rule-id="schedule-e2e-1"]',
  );
  await pause.focus();
  await page.keyboard.press('Enter');

  await expect(pause).toHaveText('Pausing…');
  await expect(pause).toBeFocused();
  await expect(page.getByRole('alert')).toHaveText(
    'Schedule update unavailable.',
  );
  await expect(pause).toHaveText('Pause');
  await expect(pause).toBeFocused();
  await expect(page.locator('[data-recued-automation-state]')).toHaveText('On');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('schedules.update')),
  ).toBe(1);
});

test('Automation keeps manual watch runs owned through reconciliation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=rules&automation_watch_response=slow`
    + '&automation_watch_relist_response=slow',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/triggers'));

  const row = page.locator(
    `[${AUTOMATION_ROW}="watch:hubspot/deal/main-crm"]`,
  );
  const runNow = page.locator(
    '[data-recued-automation-action="run:watch"]'
    + '[data-rule-id="hubspot/deal/main-crm"]',
  );
  // D-319 §5.4 — the nav's other view.
  const schedulesTab = page.locator(
    '[data-recued-automation-subnav="coming-up"]',
  );
  const statusFilter = page.locator(`[${AUTOMATION_STATUS_FILTER}]`);

  await expect(row).toContainText('last poll never');
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
  await runNow.focus();
  await page.keyboard.press('Enter');

  await expect(runNow).toHaveText('Running…');
  await expect(runNow).toHaveAttribute('aria-disabled', 'true');
  await expect(runNow).toHaveAttribute('aria-busy', 'true');
  await expect(runNow).not.toHaveAttribute('disabled');
  await expect(runNow).toBeFocused();
  await expect(schedulesTab).toHaveAttribute('aria-disabled', 'true');
  await expect(statusFilter.locator('..')).toHaveAttribute('inert', '');

  // These internal controls bypass the shell's route-switch guard. Even a
  // synthetic activation must leave the pending action visible and focused.
  await schedulesTab.dispatchEvent('click');
  await expect(page).toHaveURL(/#automation\/triggers$/);
  await expect(runNow).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#data'));
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening here. Leave anyway?',
  );
  await expect(page).toHaveURL(/#automation\/triggers$/);
  await expect(runNow).toBeFocused();
  await runNow.dispatchEvent('click');
  await runNow.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('watch.run_now')),
  ).toBe(1);

  // The RPC has landed, but the authoritative watch re-list is deliberately
  // still pending. Progress ownership must span that reconciliation gap.
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('watch.list')),
  ).toBeGreaterThan(1);
  await expect(runNow).toHaveText('Running…');
  await expect(runNow).toBeFocused();

  await expect(runNow).toHaveText('Run now');
  await expect(runNow).not.toHaveAttribute('aria-busy');
  await expect(runNow).toBeFocused();
  await expect(row).not.toContainText('last poll never');
  await expect(schedulesTab).not.toHaveAttribute('aria-disabled');
  await expect(statusFilter.locator('..')).not.toHaveAttribute('inert');
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');

  await schedulesTab.click();
  await expect(page).toHaveURL(/#automation\/coming-up$/);
});

test('Automation restores failed manual watch runs for retry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=rules&automation_watch_response=fail-once-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/triggers'));

  const runNow = page.locator(
    '[data-recued-automation-action="run:watch"]'
    + '[data-rule-id="hubspot/deal/main-crm"]',
  );
  // D-319 §5.4 — the nav's other view.
  const schedulesTab = page.locator(
    '[data-recued-automation-subnav="coming-up"]',
  );
  await runNow.focus();
  await page.keyboard.press('Enter');
  await expect(runNow).toHaveText('Running…');

  await schedulesTab.dispatchEvent('click');
  await expect(page).toHaveURL(/#automation\/triggers$/);
  await expect(runNow).toBeFocused();
  await expect(page.getByRole('alert')).toHaveText('Watch run unavailable.');
  await expect(runNow).toHaveText('Run now');
  await expect(runNow).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(runNow).toHaveText('Running…');
  await expect(runNow).toHaveText('Run now');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(runNow).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('watch.run_now')),
  ).toBe(2);
});

test('Automation gives repeated schedule actions exact accessible owners', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`${HARNESS_URL}?automation=delete`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));

  const actionNames = [
    'Pause daily-brief (schedule-e2e-1)',
    'Pause weekly-report (schedule-e2e-2)',
    'Remove daily-brief (schedule-e2e-1)',
    'Remove weekly-report (schedule-e2e-2)',
    'Details daily-brief (schedule-e2e-1)',
    'Details weekly-report (schedule-e2e-2)',
  ];
  for (const name of actionNames) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
  }

  const rowLayout = await page.locator(
    `[${AUTOMATION_ROW}="schedule:schedule-e2e-1"]`,
  ).evaluate((row) => {
    const content = row.firstElementChild?.getBoundingClientRect();
    const actions = row.querySelector('.automation-row-actions')
      ?.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    return {
      rowWidth: bounds.width,
      contentWidth: content?.width ?? 0,
      contentBottom: content?.bottom ?? Number.POSITIVE_INFINITY,
      actionsTop: actions?.top ?? Number.NEGATIVE_INFINITY,
    };
  });
  expect(rowLayout.contentWidth).toBeGreaterThanOrEqual(
    rowLayout.rowWidth - 25,
  );
  expect(rowLayout.actionsTop).toBeGreaterThanOrEqual(
    rowLayout.contentBottom,
  );

  const weeklyDetails = page.getByRole('button', {
    name: 'Details weekly-report (schedule-e2e-2)',
    exact: true,
  });
  await weeklyDetails.focus();
  await page.keyboard.press('Enter');

  const heading = page.getByRole('heading', {
    name: 'weekly-report',
    exact: true,
  });
  await expect(heading).toBeFocused();
  const back = page.getByRole('button', { name: 'Back to Schedules' });
  await back.focus();
  await page.keyboard.press('Enter');

  await expect(weeklyDetails).toBeVisible();
  await expect(weeklyDetails).toBeFocused();
});

test('Automation focuses schedule details and restores the exact row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?automation=rules`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));

  const details = page.locator(
    '[data-recued-automation-action="detail:schedule"]'
    + '[data-rule-id="schedule-e2e-1"]',
  );
  await expect(details).toBeVisible();
  await details.focus();
  await page.keyboard.press('Enter');

  const heading = page.getByRole('heading', { name: 'daily-brief', exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page).toHaveURL(/#automation\/schedules\/schedule-e2e-1$/);

  const deletesBefore = await page.evaluate(
    () => window.__app.rpcCallCount('schedules.delete'),
  );
  const remove = page.getByRole('button', { name: 'Remove', exact: true });
  await remove.focus();
  await page.keyboard.press('Enter');
  const confirm = page.locator(
    '[data-recued-automation-action="delete-confirm:schedule"]',
  );
  await expect(confirm).toHaveText('Confirm remove');
  await expect(confirm).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('schedules.delete')),
  ).toBe(deletesBefore);
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(remove).toBeFocused();

  const back = page.getByRole('button', { name: 'Back to Schedules' });
  await back.focus();
  await page.keyboard.press('Enter');

  await expect(details).toBeVisible();
  await expect(details).toBeFocused();
  await expect(page).toHaveURL(/#automation\/schedules$/);
});

test('Automation advances focus after removing a schedule', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=delete&automation_schedule_delete_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));

  const removed = page.locator(
    `[${AUTOMATION_ROW}="schedule:schedule-e2e-1"]`,
  );
  const successor = page.locator(
    `[${AUTOMATION_ROW}="schedule:schedule-e2e-2"]`,
  );
  await expect(removed).toBeVisible();
  const remove = removed.locator(
    '[data-recued-automation-action="delete:schedule"]',
  );
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('schedules.delete'),
  );
  await remove.focus();
  await page.keyboard.press('Enter');

  const confirm = removed.locator(
    '[data-recued-automation-action="delete-confirm:schedule"]',
  );
  await expect(confirm).toHaveText('Confirm remove');
  await expect(confirm).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('schedules.delete')),
  ).toBe(before);
  const cancel = removed.locator(
    '[data-recued-automation-action="delete-cancel:schedule"]',
  );
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(remove).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('schedules.delete')),
  ).toBe(before);

  await page.keyboard.press('Enter');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Removing…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await confirm.dispatchEvent('click');
  await confirm.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('schedules.delete')),
  ).toBe(before + 1);

  await expect(removed).toHaveCount(0);
  await expect(successor).toBeVisible();
  await expect(successor.locator(
    '[data-recued-automation-action="detail:schedule"]',
  )).toBeFocused();
});

test('Automation keeps failed schedule removal confirmed and focused', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?automation=delete&automation_schedule_delete_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#automation/schedules'));

  const removed = page.locator(
    `[${AUTOMATION_ROW}="schedule:schedule-e2e-1"]`,
  );
  const remove = removed.locator(
    '[data-recued-automation-action="delete:schedule"]',
  );
  await remove.focus();
  await page.keyboard.press('Enter');
  const confirm = removed.locator(
    '[data-recued-automation-action="delete-confirm:schedule"]',
  );
  await expect(confirm).toHaveText('Confirm remove');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(confirm).toHaveText('Removing…');
  await expect(confirm).toBeFocused();
  await expect(page.getByRole('alert')).toHaveText(
    'Schedule removal unavailable.',
  );
  await expect(confirm).toHaveText('Confirm remove');
  await expect(confirm).toBeFocused();
  await expect(removed).toBeVisible();
  const cancel = removed.locator(
    '[data-recued-automation-action="delete-cancel:schedule"]',
  );
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(remove).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('schedules.delete')),
  ).toBe(1);
});
