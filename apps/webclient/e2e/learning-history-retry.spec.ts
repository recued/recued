import { expect, test, type Locator, type Page } from '@playwright/test';

const a = 'history-case-a', b = 'history-case-b';
const retry = (page: Page) => page.getByRole('button', { name: 'Retry learned history', exact: true });
const region = (page: Page) => page.getByRole('region', { name: 'What Recued has learned', exact: true });
const toggle = (page: Page) => page.locator('[data-recued-learning-toggle]');
const notice = (page: Page) => page.locator('[data-recued-learning-cases-read-status]');
const empty = (page: Page) => page.locator('[data-recued-learning-cases-empty]');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside panel', exact: true });
const action = (page: Page, kind: 'draft' | 'forget' | 'draft-prompt', id: string) => page.locator(`[data-recued-learning-${kind}="${id}"]`);
const press = async (locator: Locator) => { await locator.focus(); await locator.press('Enter'); };
const calls = (page: Page, kind: string) => page.evaluate(kind => window.__learningHistory.calls.filter(call => call.kind === kind), kind);
const release = (page: Page, kind: 'preferences' | 'history' | 'save' | 'forget' | 'draft', index = 0, outcome: 'success' | 'error' = 'success') =>
  page.evaluate(({ kind, index, outcome }) => window.__learningHistory.release(kind, index, outcome), { kind, index, outcome });
const open = async (page: Page, width: number, failed = true) => {
  await page.setViewportSize({ width, height: 900 }); await page.goto('/learning-history-retry-harness.html');
  await page.waitForFunction(() => window.__learningHistory !== undefined);
  await expect(notice(page)).toHaveText('Loading learned history…'); await expect(retry(page)).toHaveCount(0);
  await release(page, 'history', 0, failed ? 'error' : 'success');
};
const readOnly = async (page: Page) => {
  expect(await calls(page, 'preferences')).toHaveLength(1);
  for (const kind of ['save', 'forget', 'draft', 'handoff']) expect(await calls(page, kind)).toEqual([]);
};
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

for (const width of [390, 1280]) {
  for (const result of ['first', 'empty'] as const) {
    test(`Learning retries failed history to ${result} without replacing the toggle at ${width}px`, async ({ page }) => {
      await open(page, width); const originalToggle = await toggle(page).elementHandle(), originalRetry = await retry(page).elementHandle();
      await press(retry(page)); await expect(retry(page)).toBeFocused();
      await expect(notice(page)).toHaveText('Retrying learned history…'); await expect(retry(page)).toHaveAttribute('aria-busy', 'true');
      await expect(retry(page)).toHaveAttribute('aria-disabled', 'true'); await expect(retry(page)).not.toHaveAttribute('disabled');
      await retry(page).evaluate((node: HTMLButtonElement) => { node.click(); node.click(); });
      expect(await calls(page, 'history')).toHaveLength(2); await expect(empty(page)).toHaveCount(0);
      expect(await page.evaluate(() => window.__learningHistory.hasInFlightWork())).toBe(false);
      await release(page, 'history', 1, 'error'); await expect(notice(page)).toHaveAttribute('role', 'alert');
      await expect(retry(page)).toBeFocused(); await expect(retry(page)).toHaveAttribute('aria-disabled', 'false');
      expect(await originalRetry!.evaluate(node => node.isConnected && node === document.querySelector('[data-recued-learning-cases-retry]'))).toBe(true);
      await page.evaluate(result => window.__learningHistory.setCases(result), result); await retry(page).press('Enter');
      await release(page, 'history', 2); await expect(retry(page)).toHaveCount(0);
      await expect(result === 'empty' ? empty(page) : region(page)).toBeFocused();
      expect(await originalToggle!.evaluate(node => node.isConnected && node === document.querySelector('[data-recued-learning-toggle]'))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await readOnly(page);
    });
  }

  for (const outcome of ['success', 'error'] as const) {
    test(`Learning history retry ${outcome} respects outside focus at ${width}px`, async ({ page }) => {
      await open(page, width); await press(retry(page)); await outside(page).focus(); await release(page, 'history', 1, outcome);
      await expect(outside(page)).toBeFocused();
      if (outcome === 'error') await expect(retry(page)).toHaveAttribute('aria-disabled', 'false');
      else await expect(retry(page)).toHaveCount(0);
      await readOnly(page);
    });
    test(`Learning ignores a disposed history retry ${outcome} at ${width}px`, async ({ page }) => {
      await open(page, width); const old = await retry(page).elementHandle(); await press(retry(page)); await outside(page).focus();
      await page.evaluate(() => window.__learningHistory.dispose()); await old!.evaluate((node: HTMLButtonElement) => node.click());
      await release(page, 'history', 1, outcome); await expect(page.locator('#panel')).toBeEmpty(); await expect(outside(page)).toBeFocused();
      expect(await calls(page, 'history')).toHaveLength(2); await readOnly(page);
    });
  }

  for (const readFirst of [true, false]) {
    test(`Learning history keeps an overlapping preference write truthful (read first: ${readFirst}) at ${width}px`, async ({ page }) => {
      await open(page, width); await press(retry(page)); await toggle(page).focus(); await toggle(page).press('Space');
      let node = await toggle(page).elementHandle();
      await expect(toggle(page)).not.toBeChecked(); await expect(toggle(page)).toHaveAttribute('aria-busy', 'true');
      if (readFirst) {
        await release(page, 'history', 1); await expect(toggle(page)).not.toBeChecked(); await expect(toggle(page)).toHaveAttribute('aria-busy', 'true');
        expect(await node!.evaluate(element => element.isConnected && element === document.querySelector('[data-recued-learning-toggle]'))).toBe(true);
      }
      await release(page, 'save', 0, 'error'); node = await toggle(page).elementHandle();
      if (!readFirst) await release(page, 'history', 1);
      await expect(toggle(page)).toBeChecked(); await expect(toggle(page)).toBeFocused();
      expect(await node!.evaluate(element => element.isConnected && element === document.querySelector('[data-recued-learning-toggle]'))).toBe(true);
      expect(await calls(page, 'preferences')).toHaveLength(1); expect(await calls(page, 'save')).toEqual([{ kind: 'save', patch: { 'chat.execution_case_offer': false } }]);
      expect(await calls(page, 'history')).toHaveLength(2); expect(await page.evaluate(() => window.__learningHistory.hasInFlightWork())).toBe(false);
      for (const kind of ['forget', 'draft', 'handoff']) expect(await calls(page, kind)).toEqual([]);
    });
  }

  for (const retainedCase of [true, false]) {
    test(`Learning keeps a finished draft through history failure (case retained: ${retainedCase}) at ${width}px`, async ({ page }) => {
      await open(page, width, false); await press(action(page, 'draft', a)); await press(action(page, 'draft', a)); await release(page, 'draft');
      await expect(action(page, 'draft', a)).toHaveText('Open finished draft');
      expect(await page.evaluate(() => window.__learningHistory.hasUnsavedChanges())).toBe(true);
      await press(action(page, 'forget', b)); await press(action(page, 'forget', b)); await release(page, 'forget');
      await expect.poll(async () => (await calls(page, 'history')).length).toBe(2); await release(page, 'history', 1, 'error');
      await expect(action(page, 'draft', a)).toHaveText('Open finished draft');
      await page.evaluate(kept => window.__learningHistory.setCases(kept ? 'first' : 'empty'), retainedCase);
      await press(retry(page)); await expect(action(page, 'draft', a)).toHaveText('Open finished draft'); await release(page, 'history', 2);
      await expect(action(page, 'draft', a)).toHaveText('Open finished draft'); expect(await calls(page, 'handoff')).toHaveLength(1);
      await expect(region(page)).toContainText('Send the quarterly report');
      await page.evaluate(() => window.__learningHistory.allowHandoff()); await press(action(page, 'draft', a));
      const handoffs = await calls(page, 'handoff'); expect(handoffs).toHaveLength(2); expect(handoffs[1]).toEqual(handoffs[0]);
      expect(await calls(page, 'draft')).toHaveLength(1); expect(await calls(page, 'forget')).toEqual([{ kind: 'forget', case_id: b }]);
      expect(await calls(page, 'preferences')).toHaveLength(1); expect(await calls(page, 'save')).toEqual([]);
      expect(await page.evaluate(() => window.__learningHistory.hasUnsavedChanges())).toBe(false);
    });
  }

  for (const outcome of ['success', 'error'] as const) {
    test(`Learning protects a separate preference write during draft handoff and history ${outcome} at ${width}px`, async ({ page }) => {
      await open(page, width, false); await press(action(page, 'draft', a)); await press(action(page, 'draft', a)); await release(page, 'draft');
      await press(action(page, 'forget', b)); await press(action(page, 'forget', b)); await release(page, 'forget');
      await expect.poll(async () => (await calls(page, 'history')).length).toBe(2); await release(page, 'history', 1, 'error');
      await press(retry(page));
      await toggle(page).focus(); await toggle(page).press('Space');
      expect(await page.evaluate(() => window.__learningHistory.hasInFlightWork())).toBe(true);
      await page.evaluate(() => window.__learningHistory.allowHandoff()); await press(action(page, 'draft', a));
      const handoffs = await calls(page, 'handoff'); expect(handoffs).toHaveLength(2);
      expect(handoffs[1]).toMatchObject({ case_id: a, work_pending: true, unsaved: false });
      expect(handoffs[1]!.recipe).toEqual(handoffs[0]!.recipe);
      expect(await page.evaluate(() => window.__learningHistory.hasUnsavedChanges())).toBe(false);
      await release(page, 'history', 2, outcome);
      expect(await page.evaluate(() => window.__learningHistory.hasInFlightWork())).toBe(true);
      await release(page, 'save', 0, 'error');
      expect(await page.evaluate(() => window.__learningHistory.hasInFlightWork())).toBe(false);
      expect(await calls(page, 'draft')).toHaveLength(1); expect(await calls(page, 'preferences')).toHaveLength(1);
      expect(await calls(page, 'save')).toHaveLength(1); expect(await calls(page, 'forget')).toHaveLength(1);
    });
  }

  test(`Learning protects another finished draft during a handoff at ${width}px`, async ({ page }) => {
    await open(page, width, false);
    for (const [index, id] of [a, b].entries()) {
      await press(action(page, 'draft', id)); await press(action(page, 'draft', id)); await release(page, 'draft', index);
      await expect(action(page, 'draft', id)).toHaveText('Open finished draft');
    }
    await page.evaluate(() => window.__learningHistory.allowHandoff()); await press(action(page, 'draft', a));
    let handoffs = await calls(page, 'handoff'); expect(handoffs).toHaveLength(3);
    expect(handoffs[2]).toMatchObject({ case_id: a, work_pending: false, unsaved: true });
    expect(await page.evaluate(() => window.__learningHistory.hasUnsavedChanges())).toBe(true);
    await expect(action(page, 'draft', b)).toHaveText('Open finished draft'); await press(action(page, 'draft', b));
    handoffs = await calls(page, 'handoff'); expect(handoffs).toHaveLength(4);
    expect(handoffs[3]).toMatchObject({ case_id: b, work_pending: false, unsaved: false });
    expect(await page.evaluate(() => window.__learningHistory.hasUnsavedChanges())).toBe(false);
    expect(await calls(page, 'draft')).toHaveLength(2); expect(await calls(page, 'preferences')).toHaveLength(1);
    expect(await calls(page, 'save')).toEqual([]); expect(await calls(page, 'forget')).toEqual([]);
  });

  test(`Learning preserves newer prompt text and selection when a history read settles at ${width}px`, async ({ page }) => {
    await open(page, width, false); await press(action(page, 'draft', a));
    await action(page, 'draft-prompt', a).fill('Original draft instruction');
    await press(action(page, 'forget', b)); await press(action(page, 'forget', b)); await release(page, 'forget');
    await expect.poll(async () => (await calls(page, 'history')).length).toBe(2);
    const prompt = action(page, 'draft-prompt', a); await prompt.fill('Newer instruction while history is pending');
    await prompt.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(6, 17, 'forward'));
    await release(page, 'history', 1); await expect(prompt).toHaveValue('Newer instruction while history is pending'); await expect(prompt).toBeFocused();
    expect(await prompt.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([6, 17, 'forward']);
    expect(await calls(page, 'draft')).toEqual([]); expect(await calls(page, 'handoff')).toEqual([]); expect(await calls(page, 'preferences')).toHaveLength(1);
  });
}

const prefsRetry = (page: Page) => page.getByRole('button', { name: 'Retry Learning settings', exact: true });
const prefsNotice = (page: Page) => page.locator('[data-recued-learning-read-status]');
const openPreferences = async (page: Page, width: number, failed = true) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/learning-history-retry-harness.html?preferences=held');
  await page.waitForFunction(() => window.__learningHistory !== undefined);
  await expect(prefsNotice(page)).toHaveText('Loading Learning settings…');
  await expect(prefsRetry(page)).toHaveCount(0); await expect(toggle(page)).toHaveCount(0);
  expect(await calls(page, 'preferences')).toHaveLength(1); expect(await calls(page, 'history')).toEqual([]);
  expect(await page.evaluate(() => window.__learningHistory.hasInFlightWork())).toBe(false);
  if (failed) await release(page, 'preferences', 0, 'error');
};
const noActions = async (page: Page) => {
  for (const kind of ['save', 'forget', 'draft', 'handoff']) expect(await calls(page, kind)).toEqual([]);
  expect(await page.evaluate(() => window.__learningHistory.hasInFlightWork())).toBe(false);
  expect(await page.evaluate(() => window.__learningHistory.hasUnsavedChanges())).toBe(false);
};

for (const width of [390, 1280]) {
  for (const result of ['first', 'empty'] as const) {
    test(`Learning retries initial settings failures to ${result} with native keyboard focus at ${width}px`, async ({ page }) => {
      await openPreferences(page, width);
      await expect(prefsNotice(page)).toHaveAttribute('role', 'alert');
      await expect(prefsNotice(page)).toContainText('could not load these settings');
      const original = await prefsRetry(page).elementHandle();
      if (result === 'first') await page.screenshot({ path: test.info().outputPath('settings-error.png'), fullPage: true });
      await press(prefsRetry(page));
      await expect(prefsRetry(page)).toBeFocused(); await expect(prefsRetry(page)).not.toHaveAttribute('disabled');
      await expect(prefsRetry(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(prefsRetry(page)).toHaveAttribute('aria-busy', 'true');
      await expect(prefsNotice(page)).toHaveAttribute('role', 'status');
      await expect(prefsNotice(page)).toHaveText('Retrying Learning settings…');
      await expect(page.locator('[data-recued-learning-error]')).toHaveCount(0);
      await prefsRetry(page).press('Enter'); await prefsRetry(page).press('Space');
      await prefsRetry(page).evaluate((node: HTMLButtonElement) => { node.click(); node.click(); });
      expect(await calls(page, 'preferences')).toHaveLength(2);
      expect(await calls(page, 'history')).toEqual([]); await noActions(page);
      if (result === 'first') await page.screenshot({ path: test.info().outputPath('settings-pending.png'), fullPage: true });
      await release(page, 'preferences', 1, 'error');
      await expect(prefsRetry(page)).toBeFocused(); await expect(prefsRetry(page)).toHaveAttribute('aria-busy', 'false');
      await expect(prefsRetry(page)).toHaveAttribute('aria-disabled', 'false');
      await expect(prefsNotice(page)).toHaveAttribute('role', 'alert');
      expect(await original!.evaluate(node => node.isConnected && node === document.querySelector('[data-recued-learning-retry]'))).toBe(true);
      await page.evaluate(result => { window.__learningHistory.setCases(result); window.__learningHistory.setOffer(false); }, result);
      await prefsRetry(page).press('Space'); await release(page, 'preferences', 2);
      await expect(toggle(page)).not.toBeChecked(); await expect(toggle(page)).toBeFocused();
      await expect(prefsRetry(page)).toHaveCount(0); await expect(prefsNotice(page)).toHaveCount(0);
      await expect(notice(page)).toHaveText('Loading learned history…');
      await expect(empty(page)).toHaveCount(0); expect(await calls(page, 'history')).toHaveLength(1);
      await original!.evaluate((node: HTMLButtonElement) => node.click());
      expect(await calls(page, 'preferences')).toHaveLength(3);
      await release(page, 'history'); await expect(result === 'empty' ? empty(page) : region(page)).toBeVisible();
      await expect(toggle(page)).toBeFocused(); await noActions(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (result === 'first') await page.screenshot({ path: test.info().outputPath('settings-recovered.png'), fullPage: true });
    });
  }

  test(`Learning initial success keeps outside focus at ${width}px`, async ({ page }) => {
    await openPreferences(page, width, false); await outside(page).focus();
    await release(page, 'preferences'); await expect(outside(page)).toBeFocused();
    await expect(toggle(page)).toBeChecked(); await release(page, 'history');
    await expect(outside(page)).toBeFocused(); expect(await calls(page, 'preferences')).toHaveLength(1);
    await noActions(page);
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`Learning settings retry ${outcome} respects outside focus at ${width}px`, async ({ page }) => {
      await openPreferences(page, width); await press(prefsRetry(page)); await outside(page).focus();
      await release(page, 'preferences', 1, outcome); await expect(outside(page)).toBeFocused();
      if (outcome === 'success') { await release(page, 'history'); await expect(outside(page)).toBeFocused(); }
      else {
        await expect(prefsRetry(page)).toHaveAttribute('aria-disabled', 'false');
        expect(await calls(page, 'history')).toEqual([]);
      }
      expect(await calls(page, 'preferences')).toHaveLength(2); await noActions(page);
    });

    test(`Learning ignores a disposed settings retry ${outcome} at ${width}px`, async ({ page }) => {
      await openPreferences(page, width); const old = await prefsRetry(page).elementHandle();
      await press(prefsRetry(page)); await outside(page).focus(); await page.evaluate(() => window.__learningHistory.dispose());
      await old!.evaluate((node: HTMLButtonElement) => node.click()); await release(page, 'preferences', 1, outcome);
      await expect(page.locator('#panel')).toBeEmpty(); await expect(outside(page)).toBeFocused();
      expect(await calls(page, 'preferences')).toHaveLength(2); expect(await calls(page, 'history')).toEqual([]); await noActions(page);
    });
  }

  test(`Learning retries history separately after settings recover at ${width}px`, async ({ page }) => {
    await openPreferences(page, width); await press(prefsRetry(page)); await release(page, 'preferences', 1);
    await release(page, 'history', 0, 'error');
    await expect(toggle(page)).toBeFocused(); await expect(toggle(page)).toBeChecked();
    await expect(prefsRetry(page)).toHaveCount(0); await expect(page.locator('[data-recued-learning-error]')).toHaveCount(0);
    await expect(empty(page)).toHaveCount(0); await expect(retry(page)).toBeVisible();
    await press(retry(page)); await release(page, 'history', 1); await expect(region(page)).toBeFocused();
    expect(await calls(page, 'preferences')).toHaveLength(2); expect(await calls(page, 'history')).toHaveLength(2); await noActions(page);
  });

  test(`Learning keeps recovered preference writes guarded and does not reuse the read Retry for save errors at ${width}px`, async ({ page }) => {
    await openPreferences(page, width); const old = await prefsRetry(page).elementHandle();
    await press(prefsRetry(page)); await release(page, 'preferences', 1); await release(page, 'history');
    await toggle(page).press('Space'); await expect(toggle(page)).not.toBeChecked();
    await expect(toggle(page)).toHaveAttribute('aria-busy', 'true');
    expect(await page.evaluate(() => window.__learningHistory.hasInFlightWork())).toBe(true);
    await old!.evaluate((node: HTMLButtonElement) => node.click());
    expect(await calls(page, 'preferences')).toHaveLength(2); expect(await calls(page, 'history')).toHaveLength(1);
    await release(page, 'save', 0, 'error'); await expect(toggle(page)).toBeFocused(); await expect(toggle(page)).toBeChecked();
    await expect(page.locator('[data-recued-learning-error]')).toContainText('could not save it');
    await expect(prefsRetry(page)).toHaveCount(0);
    await old!.evaluate((node: HTMLButtonElement) => node.click()); expect(await calls(page, 'preferences')).toHaveLength(2);
    expect(await calls(page, 'save')).toEqual([{ kind: 'save', patch: { 'chat.execution_case_offer': false } }]);
    expect(await page.evaluate(() => window.__learningHistory.hasInFlightWork())).toBe(false);
    for (const kind of ['forget', 'draft', 'handoff']) expect(await calls(page, kind)).toEqual([]);
  });
}
