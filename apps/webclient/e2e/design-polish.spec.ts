import { expect, test, type Locator, type Page } from '@playwright/test';
import { textContrast } from './helpers/text-contrast.js';

const BASE = '/full-app-harness.html?settle_reads=1';
const boot = async (page: Page, query: string, hash: string): Promise<void> => {
  await page.goto(`${BASE}${query}${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const noPageOverflow = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
};
const withinViewport = async (page: Page, control: Locator): Promise<void> => {
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  const clips = await control.evaluate(element => {
    const clips: { top: number; bottom: number }[] = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowY === 'visible') continue;
      const rect = parent.getBoundingClientRect();
      clips.push({ top: rect.top, bottom: rect.bottom });
    }
    return clips;
  });
  for (const clip of clips) {
    expect(box!.y).toBeGreaterThanOrEqual(clip.top - 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(clip.bottom + 1);
  }
};

test('mobile Chat switches history without losing an unsent draft or its navigation guard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, '&chat=session', '#chat/new');
  const input = page.getByRole('textbox', { name: 'Message to Recued' });
  const history = page.locator('[data-recued-chat-route-session-list]');
  const toggle = page.locator('[data-recued-chat-route-history-toggle]');
  await expect(history).toBeHidden();
  await withinViewport(page, input);
  await input.fill('Keep my private draft.');
  await toggle.click();
  await expect(history).toBeVisible();
  await expect(input).toBeHidden();
  await expect(history.getByRole('searchbox', { name: 'Search chats and messages' })).toBeFocused();
  await expect(history.locator('.chat-history-filter-panel')).not.toHaveAttribute('open');
  await history.getByText('Filters', { exact: true }).click();
  await expect(history.getByRole('combobox', { name: 'Chats from', exact: true })).toBeVisible();
  await toggle.click();
  await expect(input).toHaveValue('Keep my private draft.');
  await expect(input).toBeFocused();
  await toggle.click();
  await history.locator('[data-recued-chat-route-session-row]').first().click();
  const guard = history.getByRole('alert');
  await expect(guard).toContainText('What you were writing will be lost');
  await guard.getByRole('button', { name: 'Keep writing', exact: true }).click();
  await expect(history).toBeHidden();
  await expect(input).toHaveValue('Keep my private draft.');
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(history).toBeVisible();
  await expect(toggle).toBeHidden();
  await expect(input).toHaveValue('Keep my private draft.');
  await noPageOverflow(page);
});

for (const [count, query] of [[4, '&ai=empty'], [3, '&ai=empty&recipes=installed'], [2, '&ai=empty&recipes=installed&connection=grants']] as const) {
  test(`mobile first-run Chat keeps its ${count} choices and message box reachable`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page, query, '#chat');
    const cards = page.locator('[data-recued-chat-route-activation-card]');
    await expect(cards).toHaveCount(count);
    await withinViewport(page, page.locator('[data-recued-chat-route-activation-action="capture"]'));
    await withinViewport(page, page.getByRole('textbox', { name: 'Message to Recued' }));
    await noPageOverflow(page);
  });
}

test('mobile Data exposes records before the fold and retains keyboard focus through collection changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, '&data=work-entities-paged', '#data/task');
  const picker = page.getByRole('combobox', { name: 'Collection', exact: true });
  await expect(picker).toHaveValue('task');
  expect((await picker.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await page.getByRole('combobox', { name: 'Source', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole('tablist', { name: 'Data collections' })).toBeHidden();
  await withinViewport(page, page.getByText('Task 0', { exact: true }));
  await picker.focus();
  await picker.selectOption('contact');
  await expect(page).toHaveURL(/#data\/contact$/);
  await expect(page.locator('[data-recued-data-contact-search]')).toBeVisible();
  await expect(picker).toBeFocused();
  await picker.selectOption('search');
  await expect(page).toHaveURL(/#data\/search$/);
  await expect(picker).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(picker).toBeHidden();
  const tabs = page.getByRole('tablist', { name: 'Data collections' });
  await expect(tabs).toBeVisible();
  await tabs.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await expect(page).toHaveURL(/#data\/task$/);
  await noPageOverflow(page);
});

test('informative search placeholders meet text contrast in both themes', async ({ page }) => {
  await boot(page, '&data=work-entities-paged', '#data/task');
  const input = page.getByRole('searchbox', { name: 'Search tasks' });
  await expect(input).toBeEnabled();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const contrast = await textContrast(input, true);
    expect(contrast, theme).toBeGreaterThanOrEqual(4.5);
  }
});

test('Chat Files and the portaled Create dialog share mobile control sizing and return focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, '&chat=session', '#chat/session/chat_1');
  const files = page.getByRole('button', { name: 'Files', exact: true });
  await expect(files).toBeVisible();
  expect((await files.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await create.click();
  const dialog = page.getByRole('dialog', { name: 'Create', exact: true });
  await expect(dialog).toBeVisible();
  const heights = await dialog.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
  expect(heights.every(height => height >= 44)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(create).toBeFocused();
  await noPageOverflow(page);
});

test('first-run Capture restores focus after closing Create', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, '&ai=empty', '#chat');
  const capture = page.locator('[data-recued-chat-route-activation-action="capture"]');
  await capture.click();
  const dialog = page.getByRole('dialog', { name: 'Create', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(capture).toBeFocused();
});

test('task Done checkbox keeps its label readable on narrow screens', async ({ page }) => {
  for (const width of [280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await boot(page, '&data=work-entities-paged', '#data/task');
    await page.getByText('Task 0', { exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit Task', exact: true });
    const checkbox = dialog.getByRole('checkbox', { name: 'Done', exact: true });
    await expect(checkbox).toBeVisible();
    const label = dialog.locator('label[for="form-renderer-done"]');
    const inputBox = (await checkbox.boundingBox())!;
    const labelBox = (await label.boundingBox())!;
    expect(inputBox.width).toBeLessThanOrEqual(44);
    expect(labelBox.width).toBeGreaterThanOrEqual(35);
    expect(labelBox.height).toBeLessThanOrEqual(24);
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
    await noPageOverflow(page);
  }
});

test('Saved views keeps loading and empty-state guidance visible when its list is folded', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, '&hold_rpc=data_views.list', '#views');
  const tools = page.locator('[data-saved-data-views]');
  const list = tools.locator('details').first();
  await expect(list).toHaveAttribute('open', '');
  await list.locator('summary').click();
  await expect(tools.getByText('Loading saved views…', { exact: true })).toBeVisible();
  const refresh = tools.getByRole('button', { name: 'Refresh saved views', exact: true });
  await expect(refresh).toBeVisible();
  await page.evaluate(() => window.__app.releaseRpcResponses?.('data_views.list'));
  await expect(tools.getByText(/No saved views yet/)).toBeVisible();
  await expect(refresh).toBeEnabled();
  await tools.getByRole('link', { name: 'Browse Data to save a view', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Collection', exact: true })).toHaveValue('contact');
  await expect(page.getByRole('button', { name: 'Save current view', exact: true })).toBeVisible();
  await noPageOverflow(page);
});

test('Today uses route gutters for its title, warning and task controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date('2026-09-08T12:00:00-07:00') });
  await boot(page, '&data=today', '#today');
  const title = page.getByRole('heading', { name: 'Today', exact: true }).first();
  await expect(title).toBeVisible();
  expect((await title.boundingBox())!.x).toBeGreaterThanOrEqual(16);
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const box = (await refresh.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(374);
  await expect(page.getByRole('button', { name: 'Complete Send the proposal', exact: true })).toBeVisible();
  await noPageOverflow(page);
});

test('Approvals and Kitchen wrap whole mobile toolbar labels', async ({ page }) => {
  const lines = (control: Locator) => control.evaluate(element => {
    const tops = new Set<number>();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      for (let i = 0; i < (text.textContent?.length ?? 0); i++) {
        if (!text.textContent![i]!.trim()) continue;
        const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1);
        tops.add(Math.round(range.getBoundingClientRect().top));
      }
    }
    return tops.size;
  });
  for (const width of [280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await boot(page, '&attention=pending', '#approvals');
    expect(await lines(page.getByRole('heading', { name: 'Approvals', exact: true }))).toBe(1);
    expect(await lines(page.getByRole('button', { name: 'Refresh', exact: true }))).toBe(1);
    await noPageOverflow(page);
    await boot(page, '', '#kitchen/pack');
    const actions = page.locator('.ingredient-builder-draft-actions');
    await expect(actions).toBeVisible();
    expect(await lines(actions.getByRole('button', { name: 'Refresh', exact: true }))).toBe(1);
    await noPageOverflow(page);
  }
});
