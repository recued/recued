import { expect, test, type Page } from '@playwright/test';

const from = (page: Page) => page.locator('[data-recued-quiet-hours-from]');
const to = (page: Page) => page.locator('[data-recued-quiet-hours-to]');
const save = (page: Page) => page.locator('[data-recued-quiet-hours-save]');
const pending = (page: Page) => page.getByRole('status').filter({ hasText: 'Saving quiet hours…' });
const declared = (page: Page) => page.locator('[data-recued-quiet-hours-declared]');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside panel', exact: true });
const writes = (page: Page) => page.evaluate(() => window.__quietHours.calls.filter(call => call.kind === 'set').map(call => call.args));
const release = (page: Page, kind: 'get' | 'set', index = 0, outcome: 'success' | 'error' | 'applied_error' | 'incomplete' = 'success') =>
  page.evaluate(({ kind, index, outcome }) => window.__quietHours.release(kind, index, outcome), { kind, index, outcome });
const open = async (page: Page, blocked = false) => {
  await page.goto(`/quiet-hours-harness.html?blocked=${blocked}`);
  await page.waitForFunction(() => window.__quietHours !== undefined);
  await release(page, 'get'); await expect(from(page)).toHaveValue('22:00');
};
const edit = async (page: Page) => { await from(page).fill('23:30'); await to(page).fill('06:15'); };
const activateSave = async (page: Page) => { await save(page).focus(); await page.keyboard.press('Enter'); };
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

const retryRead = (page: Page) => page.getByRole('button', { name: 'Retry loading quiet hours', exact: true });
const readCount = (page: Page) => page.evaluate(() => window.__quietHours.calls.filter(call => call.kind === 'get').length);
const guards = (page: Page) => page.evaluate(() => window.__quietHours.guards());
const openReadFailure = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 900 }); await page.goto('/quiet-hours-harness.html');
  await page.waitForFunction(() => window.__quietHours !== undefined);
  await release(page, 'get', 0, 'error'); await expect(page.getByRole('alert')).toHaveText('Could not read quiet hours.');
  await expect(retryRead(page)).toBeVisible();
};

for (const width of [390, 1280]) {
  test(`an incomplete window acknowledgement retains the draft and confirmed preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await edit(page); await activateSave(page);
    await release(page, 'set', 0, 'incomplete');
    expect(await guards(page)).toEqual({ work: false, dirty: true });
    await expect(from(page)).toHaveValue('23:30'); await expect(to(page)).toHaveValue('06:15'); await expect(save(page)).toBeFocused();
    await expect(declared(page)).toContainText('22:00 → 08:00'); await expect(page.getByRole('alert')).toHaveText('Recued could not confirm the quiet hours settings. Try again.');
    await outside(page).focus(); await page.evaluate(() => window.__quietHours.refresh()); await release(page, 'get', 1);
    expect(await guards(page)).toEqual({ work: false, dirty: false }); await expect(declared(page)).toContainText('23:30 → 06:15');
    await expect(outside(page)).toBeFocused(); expect(await writes(page)).toEqual([{ from_minute: 1410, to_minute: 375 }]);
  });

  test(`an incomplete recovery read retains restored values and uncertainty at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await edit(page); await activateSave(page); await release(page, 'set', 0, 'applied_error');
    await from(page).fill('22:00'); await to(page).fill('08:00'); await outside(page).focus();
    await page.evaluate(() => window.__quietHours.refresh()); await release(page, 'get', 1, 'incomplete');
    expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(from(page)).toHaveValue('22:00'); await expect(to(page)).toHaveValue('08:00');
    await expect(declared(page)).toContainText('22:00 → 08:00'); await expect(outside(page)).toBeFocused();
    await expect(page.getByRole('alert')).toHaveText('Recued could not confirm the quiet hours settings. Try again.');
    await page.evaluate(() => window.__quietHours.refresh()); await release(page, 'get', 2);
    expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(declared(page)).toContainText('23:30 → 06:15');
    await expect(from(page)).toHaveValue('22:00'); await expect(to(page)).toHaveValue('08:00'); await edit(page);
    expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toEqual([{ from_minute: 1410, to_minute: 375 }]);
    expect(await readCount(page)).toBe(3);
  });

  for (const which of ['from', 'to'] as const) {
    test(`a fully restored ${which} time clears its draft and permits a fresh window at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page);
      expect(await guards(page)).toEqual({ work: false, dirty: false });
      const field = which === 'from' ? from(page) : to(page), original = await field.elementHandle();
      await field.fill(which === 'from' ? '21:30' : '09:15'); expect(await guards(page)).toEqual({ work: false, dirty: true });
      await field.fill(which === 'from' ? '22:00' : '08:00'); await expect(field).toBeFocused();
      expect(await guards(page)).toEqual({ work: false, dirty: false });
      expect(await original!.evaluate(input => input.isConnected && document.activeElement === input)).toBe(true);
      await outside(page).focus();
      await page.evaluate(() => { window.__quietHours.setServer({ from_minute: 900, to_minute: 1080 }); window.__quietHours.refresh(); });
      await release(page, 'get', 1); await expect(from(page)).toHaveValue('15:00'); await expect(to(page)).toHaveValue('18:00');
      await expect(outside(page)).toBeFocused(); expect(await guards(page)).toEqual({ work: false, dirty: false });
      expect(await writes(page)).toEqual([]); expect(await readCount(page)).toBe(2);
    });
  }

  test(`partial reverts and incomplete native segments remain drafts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await edit(page);
    await from(page).fill('22:00'); expect(await guards(page)).toEqual({ work: false, dirty: true });
    await to(page).fill('08:00'); expect(await guards(page)).toEqual({ work: false, dirty: false });
    await from(page).focus(); for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Backspace');
    expect(await from(page).evaluate((input: HTMLInputElement) => input.validity.badInput && input.value === '')).toBe(true);
    await to(page).fill('08:00'); expect(await guards(page)).toEqual({ work: false, dirty: true });
    await page.evaluate(() => window.__quietHours.refresh()); await release(page, 'get', 1);
    expect(await from(page).evaluate((input: HTMLInputElement) => input.validity.badInput && input.value === '')).toBe(true);
    expect(await guards(page)).toEqual({ work: false, dirty: true }); expect(await writes(page)).toEqual([]);
  });

  test(`a restored focused window follows a fresh snapshot after leaving its native field at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await from(page).fill('21:30'); await from(page).fill('22:00');
    const original = await from(page).elementHandle();
    await page.evaluate(() => { window.__quietHours.setServer({ from_minute: 900, to_minute: 1080 }); window.__quietHours.refresh(); });
    await release(page, 'get', 1); await expect(from(page)).toBeFocused(); await expect(from(page)).toHaveValue('22:00');
    await expect(declared(page)).toContainText('15:00 → 18:00'); expect(await guards(page)).toEqual({ work: false, dirty: false });
    await outside(page).focus(); await expect(from(page)).toHaveValue('15:00'); await expect(to(page)).toHaveValue('18:00');
    expect(await original!.evaluate(input => input.isConnected)).toBe(true); expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toEqual([]);
  });

  test(`reverts compare with the latest acknowledged window at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await edit(page); await activateSave(page);
    await release(page, 'set'); expect(await guards(page)).toEqual({ work: false, dirty: false });
    await from(page).fill('21:30'); await from(page).fill('23:30'); expect(await guards(page)).toEqual({ work: false, dirty: false });
    await from(page).fill('22:00'); expect(await guards(page)).toEqual({ work: false, dirty: true });
    expect(await writes(page)).toEqual([{ from_minute: 1410, to_minute: 375 }]);
  });

  test(`a fresh matching snapshot retires a retained draft without replacing its fields at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await edit(page); const original = await to(page).elementHandle();
    await page.evaluate(() => { window.__quietHours.setServer({ from_minute: 1410, to_minute: 375 }); window.__quietHours.refresh(); });
    await release(page, 'get', 1); await expect(to(page)).toBeFocused(); await expect(declared(page)).toContainText('23:30 → 06:15');
    expect(await guards(page)).toEqual({ work: false, dirty: false });
    expect(await original!.evaluate(input => input.isConnected && document.activeElement === input)).toBe(true); expect(await writes(page)).toEqual([]);
  });

  for (const outcome of ['error', 'applied_error'] as const) {
    test(`restoring old times after a save ${outcome} stays guarded until a fresh read at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page); await edit(page); await activateSave(page);
      await release(page, 'set', 0, outcome); await expect(page.getByRole('alert')).toHaveText('Connection interrupted. Try saving again.');
      await from(page).fill('22:00'); await to(page).fill('08:00'); expect(await guards(page)).toEqual({ work: false, dirty: true });
      await outside(page).focus(); await page.evaluate(() => window.__quietHours.refresh()); await release(page, 'get', 1, 'error');
      expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(outside(page)).toBeFocused();
      await page.evaluate(() => window.__quietHours.refresh()); await release(page, 'get', 2);
      await expect(from(page)).toHaveValue('22:00'); await expect(to(page)).toHaveValue('08:00'); await expect(outside(page)).toBeFocused();
      expect(await guards(page)).toEqual({ work: false, dirty: outcome === 'applied_error' });
      if (outcome === 'applied_error') { await edit(page); expect(await guards(page)).toEqual({ work: false, dirty: false }); }
      expect(await writes(page)).toEqual([{ from_minute: 1410, to_minute: 375 }]); expect(await readCount(page)).toBe(3);
    });
  }

  for (const control of ['toggle', 'approval'] as const) {
    test(`a ${control} acknowledgement preserves an uncertain window even after restoring its times at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page); await edit(page); await activateSave(page); await release(page, 'set', 0, 'error');
      await from(page).fill('22:00'); await to(page).fill('08:00');
      await page.locator(`[data-recued-quiet-hours-${control}]`).press('Space'); await release(page, 'set', 1);
      expect(await guards(page)).toEqual({ work: false, dirty: true });
      await outside(page).focus(); await page.evaluate(() => window.__quietHours.refresh()); await release(page, 'get', 1);
      expect(await guards(page)).toEqual({ work: false, dirty: false }); await expect(from(page)).toHaveValue('22:00'); await expect(to(page)).toHaveValue('08:00');
      expect(await writes(page)).toEqual([{ from_minute: 1410, to_minute: 375 }, control === 'toggle' ? { enabled: false } : { applies_to: ['notification', 'approval'] }]);
    });
  }

  test(`an unchanged window save still needs confirmation after its reply fails at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await activateSave(page); await release(page, 'set', 0, 'error');
    await from(page).fill('22:00'); expect(await guards(page)).toEqual({ work: false, dirty: true });
    await page.evaluate(() => window.__quietHours.refresh()); await release(page, 'get', 1);
    expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toEqual([{ from_minute: 1320, to_minute: 480 }]);
  });

  test(`initial read retry respects timezone gating and current saved times at ${width}px`, async ({ page }) => {
    await openReadFailure(page, width);
    await page.evaluate(() => window.__quietHours.setServer({ from_minute: 900, to_minute: 1080 }, false));
    await retryRead(page).press('Enter'); await release(page, 'get', 1);
    await expect(from(page)).toHaveValue('15:00'); await expect(to(page)).toHaveValue('18:00');
    await expect(from(page)).toBeFocused(); await expect(declared(page)).toContainText('15:00 → 18:00');
    await expect(page.locator('[data-recued-quiet-hours-toggle]')).toBeDisabled();
    await expect(page.locator('[data-recued-quiet-hours-approval]')).toBeDisabled();
    await expect(page.getByRole('link', { name: 'Set the timezone', exact: true })).toHaveAttribute('href', '#settings/server/timezone');
    expect(await writes(page)).toEqual([]);
    await edit(page); await activateSave(page); await release(page, 'set');
    await expect(declared(page)).toContainText('23:30 → 06:15');
    await expect(page.locator('[data-recued-quiet-hours-toggle]')).toBeDisabled();
    await expect(save(page)).toBeFocused(); expect(await writes(page)).toEqual([{ from_minute: 1410, to_minute: 375 }]);
  });

  test(`initial read retry keeps keyboard focus through repeated failures and coalesces attempts at ${width}px`, async ({ page }) => {
    await openReadFailure(page, width); const original = await retryRead(page).elementHandle();
    expect((await retryRead(page).boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await outside(page).focus(); await page.keyboard.press('Shift+Tab'); await expect(retryRead(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toHaveText('Retrying quiet hours…');
    await expect(retryRead(page)).toBeFocused(); await expect(retryRead(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(retryRead(page)).toHaveAttribute('aria-busy', 'true'); await expect(page.getByRole('alert')).toHaveCount(0);
    await page.keyboard.press('Enter'); await page.keyboard.press('Space');
    await retryRead(page).evaluate(button => (button as HTMLButtonElement).click());
    await page.evaluate(() => { window.__quietHours.refresh(); window.__quietHours.refresh(); });
    expect(await readCount(page)).toBe(2); await expect(from(page)).toHaveCount(0);
    await release(page, 'get', 1, 'error'); await expect(page.getByRole('alert')).toHaveText('Could not read quiet hours.');
    await expect(retryRead(page)).toBeFocused(); await expect(retryRead(page)).toHaveAttribute('aria-disabled', 'false');
    expect(await original!.evaluate(button => button.isConnected && button === document.activeElement)).toBe(true);
    await page.keyboard.press('Space'); expect(await readCount(page)).toBe(3);
    await release(page, 'get', 2); await expect(from(page)).toHaveValue('22:00'); await expect(to(page)).toHaveValue('08:00');
    await expect(from(page)).toBeFocused(); await expect(retryRead(page)).toHaveCount(0);
    await expect(declared(page)).toContainText('22:00 → 08:00'); expect(await writes(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`initial read retry leaves outside focus alone after ${outcome} at ${width}px`, async ({ page }) => {
      await openReadFailure(page, width); await retryRead(page).focus(); await page.keyboard.press('Enter');
      await outside(page).focus(); await release(page, 'get', 1, outcome);
      if (outcome === 'success') await expect(from(page)).toHaveValue('22:00');
      else await expect(page.getByRole('alert')).toHaveText('Could not read quiet hours.');
      await expect(outside(page)).toBeFocused(); expect(await readCount(page)).toBe(2); expect(await writes(page)).toEqual([]);
    });

    test(`initial read retry ignores a disposed ${outcome} reply at ${width}px`, async ({ page }) => {
      await openReadFailure(page, width); await retryRead(page).focus(); await page.keyboard.press('Enter');
      await page.evaluate(() => window.__quietHours.remount()); await release(page, 'get', 2);
      await expect(from(page)).toHaveValue('22:00'); await from(page).fill('21:45'); await from(page).focus();
      const fresh = await from(page).elementHandle(); await release(page, 'get', 1, outcome);
      await expect(from(page)).toHaveValue('21:45'); await expect(from(page)).toBeFocused();
      expect(await fresh!.evaluate(input => input.isConnected && document.activeElement === input)).toBe(true);
      await expect(page.getByRole('alert')).toHaveCount(0); await expect(retryRead(page)).toHaveCount(0);
      expect(await writes(page)).toEqual([]);
    });
  }

  test(`a successful first read does not take focus or expose Retry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/quiet-hours-harness.html');
    await page.waitForFunction(() => window.__quietHours !== undefined); await outside(page).focus();
    await expect(page.getByRole('status')).toHaveText('Loading quiet hours…'); await expect(retryRead(page)).toHaveCount(0);
    await page.evaluate(() => { window.__quietHours.refresh(); window.__quietHours.refresh(); });
    expect(await readCount(page)).toBe(1); await release(page, 'get');
    await expect(from(page)).toHaveValue('22:00'); await expect(outside(page)).toBeFocused();
    await expect(retryRead(page)).toHaveCount(0); expect(await writes(page)).toEqual([]);
  });
}

for (const width of [390, 1280]) {
  test(`failed saves keep both times and keyboard retries submit the entered window at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await edit(page);
    const original = await from(page).elementHandle(); await activateSave(page);
    await expect(from(page)).toHaveValue('23:30'); await expect(to(page)).toHaveValue('06:15');
    await expect(from(page)).toBeDisabled(); await expect(pending(page)).toBeFocused();
    await expect(declared(page)).toContainText('22:00 → 08:00');
    await release(page, 'set', 0, 'error');
    await expect(page.getByRole('alert')).toHaveText('Connection interrupted. Try saving again.');
    await expect(save(page)).toBeFocused(); await expect(from(page)).toHaveValue('23:30');
    await page.keyboard.press('Enter');
    expect(await writes(page)).toEqual([{ from_minute: 1410, to_minute: 375 }, { from_minute: 1410, to_minute: 375 }]);
    await release(page, 'set', 1); await expect(declared(page)).toContainText('23:30 → 06:15');
    await expect(save(page)).toBeFocused(); await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await original!.evaluate(input => input.isConnected && input === document.querySelector('[data-recued-quiet-hours-from]'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const missing of ['from', 'to'] as const) {
  test(`validation preserves both inputs and focuses the missing ${missing} time for correction`, async ({ page }) => {
    await open(page); await edit(page);
    const field = missing === 'from' ? from(page) : to(page), other = missing === 'from' ? to(page) : from(page);
    await field.fill(''); await activateSave(page);
    await expect(page.getByRole('alert')).toHaveText('Enter both times as HH:MM.');
    await expect(field).toBeFocused(); await expect(field).toHaveValue('');
    await expect(other).toHaveValue(missing === 'from' ? '06:15' : '23:30');
    expect(await writes(page)).toEqual([]);
    await field.fill(missing === 'from' ? '23:30' : '06:15'); await page.keyboard.press('Enter');
    expect(await writes(page)).toEqual([{ from_minute: 1410, to_minute: 375 }]);
    await release(page, 'set'); await expect(field).toBeFocused();
    await expect(declared(page)).toContainText('23:30 → 06:15');
  });
}

for (const control of ['toggle', 'approval'] as const) for (const outcome of ['success', 'error'] as const) {
  test(`a ${control} ${outcome} preserves unsaved times and keeps its write separate`, async ({ page }) => {
    await open(page); await edit(page);
    const checkbox = page.locator(`[data-recued-quiet-hours-${control}]`);
    await checkbox.focus(); await page.keyboard.press('Space');
    await expect(from(page)).toHaveValue('23:30'); await expect(to(page)).toHaveValue('06:15');
    await expect(pending(page)).toBeFocused(); await release(page, 'set', 0, outcome);
    await expect(checkbox).toBeFocused(); await expect(checkbox).toBeChecked({ checked: control === 'toggle' ? outcome === 'error' : outcome === 'success' });
    await expect(from(page)).toHaveValue('23:30'); await expect(to(page)).toHaveValue('06:15');
    await expect(declared(page)).toContainText('22:00 → 08:00');
    if (outcome === 'error') await expect(page.getByRole('alert')).toBeVisible();
    await activateSave(page);
    expect(await writes(page)).toEqual([
      control === 'toggle' ? { enabled: false } : { applies_to: ['notification', 'approval'] },
      { from_minute: 1410, to_minute: 375 },
    ]);
    await release(page, 'set', 1); await expect(declared(page)).toContainText('23:30 → 06:15');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('a refresh updates the confirmed preview while both draft fields and focus stay in place', async ({ page }) => {
  await open(page); await edit(page); const original = await to(page).elementHandle();
  await page.evaluate(() => { window.__quietHours.setServer({ from_minute: 900, to_minute: 1080 }); window.__quietHours.refresh(); });
  await release(page, 'get', 1);
  await expect(from(page)).toHaveValue('23:30'); await expect(to(page)).toHaveValue('06:15'); await expect(to(page)).toBeFocused();
  await expect(declared(page)).toContainText('15:00 → 18:00');
  expect(await original!.evaluate(input => input.isConnected && document.activeElement === input)).toBe(true);
  expect(await writes(page)).toEqual([]);
});

test('an untouched window follows fresh server values and current timezone gating', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.__quietHours.setServer({ from_minute: 900, to_minute: 1080 }, false); window.__quietHours.refresh(); });
  await release(page, 'get', 1);
  await expect(from(page)).toHaveValue('15:00'); await expect(to(page)).toHaveValue('18:00');
  await expect(page.locator('[data-recued-quiet-hours-toggle]')).toBeDisabled();
  await expect(page.locator('[data-recued-quiet-hours-approval]')).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Set the timezone', exact: true })).toBeVisible();
  expect(await writes(page)).toEqual([]);
});

for (const outcome of ['success', 'error'] as const) {
  test(`an older read cannot replace a window save ${outcome}`, async ({ page }) => {
    await open(page); await page.evaluate(() => window.__quietHours.refresh());
    await edit(page); await activateSave(page); await release(page, 'set', 0, outcome);
    await release(page, 'get', 1);
    await expect(from(page)).toHaveValue('23:30'); await expect(to(page)).toHaveValue('06:15');
    if (outcome === 'success') await expect(declared(page)).toContainText('23:30 → 06:15');
    else await expect(page.getByRole('alert')).toHaveText('Connection interrupted. Try saving again.');
  });
}

test('only the newest refresh can change the confirmed window', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.__quietHours.refresh(); window.__quietHours.setServer({ from_minute: 900, to_minute: 1080 }); window.__quietHours.refresh(); });
  await release(page, 'get', 2); await release(page, 'get', 1);
  await expect(from(page)).toHaveValue('15:00'); await expect(declared(page)).toContainText('15:00 → 18:00');
});

test('duplicate saves and refresh calls during a write leave the pending window in charge', async ({ page }) => {
  await open(page); await edit(page); await activateSave(page);
  await save(page).evaluate(button => (button as HTMLButtonElement).click());
  await page.evaluate(() => { window.__quietHours.refresh(); window.__quietHours.refresh(); });
  expect(await page.evaluate(() => window.__quietHours.calls.filter(call => call.kind === 'get').length)).toBe(1);
  expect(await writes(page)).toHaveLength(1);
  await release(page, 'set'); await expect(declared(page)).toContainText('23:30 → 06:15');
});

for (const kind of ['get', 'set'] as const) {
  test(`disposing retires a late ${kind} and leaves the replacement panel alone`, async ({ page }) => {
    await open(page);
    if (kind === 'set') { await edit(page); await activateSave(page); }
    else await page.evaluate(() => window.__quietHours.refresh());
    await page.evaluate(() => window.__quietHours.remount());
    await release(page, 'get', kind === 'get' ? 2 : 1); await expect(from(page)).toHaveValue('22:00');
    await outside(page).focus(); await release(page, kind, kind === 'get' ? 1 : 0);
    await expect(from(page)).toHaveValue('22:00'); await expect(outside(page)).toBeFocused();
  });
}

test('save replies leave focus outside the panel when the owner moves there', async ({ page }) => {
  await open(page); await edit(page); await activateSave(page);
  await outside(page).focus(); await release(page, 'set', 0, 'error'); await expect(outside(page)).toBeFocused();
  await activateSave(page); await outside(page).focus(); await release(page, 'set', 1); await expect(outside(page)).toBeFocused();
});

test('time fields are named and can save a window while the timezone blocks arming', async ({ page }) => {
  await open(page, true);
  await expect(page.getByLabel('Quiet hours start', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Quiet hours end', { exact: true })).toBeVisible();
  await expect(page.locator('[data-recued-quiet-hours-toggle]')).toBeDisabled();
  await edit(page); await activateSave(page); await release(page, 'set');
  await expect(declared(page)).toContainText('23:30 → 06:15');
  expect(await writes(page)).toEqual([{ from_minute: 1410, to_minute: 375 }]);
  await expect(page.locator('[data-recued-quiet-hours-toggle]')).toBeDisabled();
});

for (const which of ['from', 'to'] as const) for (const [segment, index, text, expected] of [
  ['hour', 0, '10', '10:30'], ['minute', 1, '45', '09:45'],
] as const) for (const action of ['refresh', 'validation', 'checkbox'] as const) {
  test(`the native ${which} ${segment} edit survives ${action} without losing its other segments`, async ({ page }) => {
    await open(page);
    const field = which === 'from' ? from(page) : to(page);
    const selectSegment = async () => {
      await field.focus();
      for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft');
      for (let step = 0; step < index; step++) await page.keyboard.press('ArrowRight');
    };
    await field.fill('09:30'); await selectSegment(); await page.keyboard.press('Backspace');
    expect(await field.evaluate((input: HTMLInputElement) => input.validity.badInput && input.value === '')).toBe(true);
    const original = await field.elementHandle();
    if (action === 'refresh') {
      await page.evaluate(() => { window.__quietHours.setServer({ from_minute: 900, to_minute: 1080 }); window.__quietHours.refresh(); });
      await release(page, 'get', 1); await expect(declared(page)).toContainText('15:00 → 18:00');
    } else if (action === 'validation') {
      await activateSave(page); await expect(page.getByRole('alert')).toHaveText('Enter both times as HH:MM.');
      await expect(field).toBeFocused();
      // Native focus returns to the first segment after leaving for Save.
      // Select the missing segment, then prove its neighbours survived.
      await selectSegment();
    } else {
      await page.locator('[data-recued-quiet-hours-approval]').focus(); await page.keyboard.press('Space'); await release(page, 'set');
      // Choosing a checkbox deliberately moves focus; return to the edited
      // segment, then prove the other native segments were retained.
      await selectSegment();
    }
    expect(await original!.evaluate(input => input.isConnected && document.activeElement === input)).toBe(true);
    expect(await field.evaluate((input: HTMLInputElement) => input.validity.badInput && input.value === '')).toBe(true);
    await page.keyboard.type(text); await expect(field).toHaveValue(expected);
    const expectedMinute = segment === 'hour' ? 630 : 585;
    const expectedWindow = { from_minute: which === 'from' ? expectedMinute : 1320, to_minute: which === 'to' ? expectedMinute : 480 };
    expect(await writes(page)).toEqual(action === 'checkbox' ? [{ applies_to: ['notification', 'approval'] }] : []);
    await page.keyboard.press('Enter');
    expect(await writes(page)).toEqual(action === 'checkbox' ? [{ applies_to: ['notification', 'approval'] }, expectedWindow] : [expectedWindow]);
    await release(page, 'set', action === 'checkbox' ? 1 : 0); await expect(field).toBeFocused();
  });
}

for (const which of ['from', 'to'] as const) {
  test(`Enter validation keeps the native ${which} minute selected for immediate correction`, async ({ page }) => {
    await open(page);
    const field = which === 'from' ? from(page) : to(page);
    await field.fill('09:30'); await field.focus();
    for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter'); await expect(page.getByRole('alert')).toHaveText('Enter both times as HH:MM.');
    await expect(field).toBeFocused(); expect(await writes(page)).toEqual([]);
    await page.keyboard.type('45'); await expect(field).toHaveValue('09:45');
    await page.keyboard.press('Enter');
    expect(await writes(page)).toEqual([{ from_minute: which === 'from' ? 585 : 1320, to_minute: which === 'to' ? 585 : 480 }]);
    await release(page, 'set'); await expect(field).toBeFocused();
  });
}

test('preview refresh keeps its timezone link focused and falls back to Save if the window becomes empty', async ({ page }) => {
  await open(page);
  const link = page.locator('[data-recued-quiet-hours-timezone-link]'); await link.focus();
  await page.evaluate(() => { window.__quietHours.setServer({ from_minute: 900, to_minute: 1080 }); window.__quietHours.refresh(); });
  await release(page, 'get', 1); await expect(link).toBeFocused();
  await page.evaluate(() => { window.__quietHours.setServer({ to_minute: 900 }); window.__quietHours.refresh(); });
  await release(page, 'get', 2); await expect(declared(page)).toHaveCount(0); await expect(save(page)).toBeFocused();
  expect(await writes(page)).toEqual([]);
});
