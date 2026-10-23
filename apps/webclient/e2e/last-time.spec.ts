import { expect, test, type Page } from '@playwright/test';

type Choice = 'on' | 'off';
const panel = (page: Page) => page.locator('[data-last-time]');
const choice = (page: Page, value: Choice) => panel(page).locator(`[data-last-time-choice="${value}"]`);
const notice = (page: Page) => panel(page).locator('[data-last-time-message]');
const state = (page: Page) => panel(page).locator('[data-last-time-state]');
const retry = (page: Page) => panel(page).getByRole('button', { name: 'Retry Last time settings', exact: true });
const exclusions = (page: Page) => panel(page).getByRole('link');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside panel', exact: true });
const reads = (page: Page) => page.evaluate(() => window.__lastTime.calls.filter(call => call.kind === 'read').length);
const writes = (page: Page) => page.evaluate(() => window.__lastTime.calls.filter(call => call.kind === 'save'));
const release = (page: Page, kind: 'read' | 'save', index = 0, outcome: 'success' | 'error' | 'unsupported' | 'malformed' | 'unchanged' = 'success') =>
  page.evaluate(({ kind, index, outcome }) => window.__lastTime.release(kind, index, outcome), { kind, index, outcome });
const open = async (page: Page, initial: Choice | 'unasked' = 'on') => {
  await page.goto('/last-time-harness.html?state=' + initial);
  await page.waitForFunction(() => window.__lastTime !== undefined);
  await release(page, 'read'); await expect(choice(page, initial === 'on' ? 'off' : 'on')).toBeVisible();
};
const activate = async (page: Page, value: Choice) => { await choice(page, value).focus(); await page.keyboard.press('Enter'); };
const retryRead = async (page: Page) => { await retry(page).focus(); await page.keyboard.press('Enter'); };
const finish = async (page: Page, saveIndex = 0, readIndex = 1) => {
  await release(page, 'save', saveIndex); await expect.poll(() => reads(page)).toBeGreaterThan(readIndex); await release(page, 'read', readIndex);
};
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

for (const width of [390, 1280]) {
  for (const initial of ['on', 'off', 'unasked'] as const) {
    test(`Last time confirms a keyboard choice from ${initial} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page, initial);
      const wanted = initial === 'on' ? 'off' : 'on';
      const link = await exclusions(page).elementHandle();
      if (initial === 'unasked') await expect(choice(page, 'off')).toHaveText('Keep it off');
      await activate(page, wanted); await expect(notice(page)).toHaveText('Saving…'); await expect(notice(page)).toBeFocused();
      await expect(choice(page, wanted)).toBeDisabled(); await release(page, 'save');
      await expect(notice(page)).toHaveText('Checking the Last time setting…');
      await expect(notice(page)).not.toHaveText(`Last time is ${wanted}.`);
      await release(page, 'read', 1); await expect(notice(page)).toHaveText(`Last time is ${wanted}.`);
      await expect(choice(page, wanted === 'on' ? 'off' : 'on')).toBeFocused(); await expect(retry(page)).toBeHidden();
      await expect(state(page)).toHaveText(wanted === 'off' ? 'Off. Recued does not ask again.' : 'On. No kind of offer has proved useful enough for your overview yet.');
      expect(await link!.evaluate(element => element.isConnected && element === document.querySelector('[data-last-time] a'))).toBe(true);
      expect(await writes(page)).toEqual([{ kind: 'save', choice: wanted }]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

  test(`Last time has a keyboard read retry after an initial failure at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/last-time-harness.html');
    await page.waitForFunction(() => window.__lastTime !== undefined); await release(page, 'read', 0, 'error');
    await expect(notice(page)).toHaveAttribute('role', 'alert'); await expect(panel(page).getByRole('heading')).toHaveText('Last time');
    await expect(state(page)).toHaveText('Current setting unavailable.'); await expect(exclusions(page)).toBeVisible();
    await retryRead(page); await expect(notice(page)).toBeFocused(); await release(page, 'read', 1);
    await expect(choice(page, 'off')).toBeFocused(); await expect(retry(page)).toBeHidden(); expect(await writes(page)).toEqual([]);
  });

  for (const wanted of ['on', 'off'] as const) {
    test(`Last time never confirms ${wanted} when the read disagrees at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page, wanted === 'on' ? 'off' : 'on');
      await activate(page, wanted); await release(page, 'save', 0, 'unchanged');
      await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1);
      await expect(notice(page)).toHaveAttribute('role', 'alert'); await expect(notice(page)).toContainText('could not be confirmed');
      await expect(choice(page, wanted)).toBeFocused(); await expect(choice(page, wanted)).toBeEnabled();
      await expect(state(page)).toContainText(wanted === 'on' ? 'Off.' : 'On.');
      await page.evaluate(wanted => window.__lastTime.setServer(wanted), wanted); await retryRead(page); await release(page, 'read', 2);
      await expect(notice(page)).toHaveText(`Last time is ${wanted}.`); await expect(retry(page)).toBeHidden();
      expect(await writes(page)).toEqual([{ kind: 'save', choice: wanted }]);
    });
  }

  for (const outcome of ['success', 'write-error', 'read-error', 'mismatch'] as const) {
    test(`Last time ${outcome} respects focus moved outside the action at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page); await activate(page, 'off');
      const target = outcome === 'read-error' || outcome === 'mismatch' ? exclusions(page) : outside(page);
      await target.focus();
      await release(page, 'save', 0, outcome === 'write-error' ? 'error' : outcome === 'mismatch' ? 'unchanged' : 'success');
      if (outcome !== 'write-error') { await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1, outcome === 'read-error' ? 'error' : 'success'); }
      await expect(notice(page)).toHaveAttribute('role', outcome === 'success' ? 'status' : 'alert'); await expect(target).toBeFocused();
      expect(await writes(page)).toEqual([{ kind: 'save', choice: 'off' }]);
    });
  }
}

test('Last time checks a lost write acknowledgement before offering another save', async ({ page }) => {
  await open(page); await activate(page, 'off'); await release(page, 'save', 0, 'error');
  await expect(retry(page)).toBeFocused(); await expect(choice(page, 'off')).toBeDisabled(); await expect(state(page)).toContainText('Last confirmed: On.');
  await retryRead(page); await release(page, 'read', 1); await expect(notice(page)).toContainText('could not be confirmed');
  expect(await writes(page)).toHaveLength(1); await expect(choice(page, 'off')).toBeEnabled();
  await activate(page, 'off'); await finish(page, 1, 2); await expect(notice(page)).toHaveText('Last time is off.');
  expect(await writes(page)).toEqual([{ kind: 'save', choice: 'off' }, { kind: 'save', choice: 'off' }]);
});

for (const outcome of ['error', 'unsupported', 'malformed'] as const) {
  test(`Last time retries only the read after a save confirmation ${outcome}`, async ({ page }) => {
    await open(page); await activate(page, 'off'); await release(page, 'save'); await expect.poll(() => reads(page)).toBe(2);
    await release(page, 'read', 1, outcome); await expect(notice(page)).toHaveAttribute('role', 'alert');
    await expect(panel(page)).toBeVisible(); await expect(retry(page)).toBeFocused(); await expect(choice(page, 'off')).toBeDisabled();
    await retryRead(page); await release(page, 'read', 2); await expect(notice(page)).toHaveText('Last time is off.');
    await expect(choice(page, 'on')).toBeFocused(); expect(await writes(page)).toEqual([{ kind: 'save', choice: 'off' }]);
  });
}

test('Last time is omitted on an older server and stays disposed', async ({ page }) => {
  await page.goto('/last-time-harness.html'); await page.waitForFunction(() => window.__lastTime !== undefined);
  await release(page, 'read', 0, 'unsupported'); await expect(panel(page)).toHaveCount(0);
  await page.evaluate(() => window.__lastTime.refresh()); expect(await reads(page)).toBe(1); expect(await writes(page)).toEqual([]);
});

for (const outcome of ['success', 'error'] as const) {
  test(`an older Last time read ${outcome} cannot replace a write confirmation`, async ({ page }) => {
    await open(page); await page.evaluate(() => window.__lastTime.refresh()); await activate(page, 'off'); await finish(page, 0, 2);
    await release(page, 'read', 1, outcome); await expect(notice(page)).toHaveText('Last time is off.');
    await expect(state(page)).toHaveText('Off. Recued does not ask again.'); await expect(retry(page)).toBeHidden();
  });

  test(`only the latest Last time refresh applies after an older ${outcome}`, async ({ page }) => {
    await open(page);
    await page.evaluate(() => { window.__lastTime.refresh(); window.__lastTime.setServer('off'); window.__lastTime.refresh(); });
    await release(page, 'read', 2); await release(page, 'read', 1, outcome);
    await expect(state(page)).toHaveText('Off. Recued does not ask again.'); await expect(notice(page)).toHaveText('Last time settings updated.');
  });
}

test('duplicate Last time actions and refreshes cannot interrupt a pending write or confirmation', async ({ page }) => {
  await open(page); await activate(page, 'off');
  await choice(page, 'off').evaluate(button => (button as HTMLButtonElement).click()); await page.evaluate(() => window.__lastTime.refresh());
  expect(await reads(page)).toBe(1); expect(await writes(page)).toHaveLength(1);
  await release(page, 'save'); await expect.poll(() => reads(page)).toBe(2);
  await page.evaluate(() => window.__lastTime.refresh()); await choice(page, 'off').evaluate(button => (button as HTMLButtonElement).click());
  expect(await reads(page)).toBe(2); expect(await writes(page)).toHaveLength(1);
  await release(page, 'read', 1); await expect(notice(page)).toHaveText('Last time is off.');
});

for (const stage of ['save', 'read'] as const) {
  test(`disposing Last time during ${stage} retires late results`, async ({ page }) => {
    await open(page); await activate(page, 'off');
    if (stage === 'read') { await release(page, 'save'); await expect.poll(() => reads(page)).toBe(2); }
    const previous = await panel(page).elementHandle(); const previousText = await panel(page).textContent();
    await page.evaluate(() => window.__lastTime.remount()); await expect(panel(page).getByRole('heading')).toHaveText('Last time');
    await outside(page).focus(); await release(page, stage, stage === 'read' ? 1 : 0);
    await release(page, 'read', stage === 'read' ? 2 : 1); await expect(choice(page, stage === 'read' ? 'on' : 'off')).toBeVisible();
    await expect(outside(page)).toBeFocused(); expect(await reads(page)).toBe(stage === 'read' ? 3 : 2);
    expect(await previous!.evaluate(element => element.textContent)).toBe(previousText);
  });
}

test('a refreshed Last time choice keeps its keyboard owner when the old button disappears', async ({ page }) => {
  await open(page); await choice(page, 'off').focus();
  await page.evaluate(() => { window.__lastTime.setServer('off'); window.__lastTime.refresh(); }); await release(page, 'read', 1);
  await expect(choice(page, 'on')).toBeFocused(); expect(await writes(page)).toEqual([]);
});
