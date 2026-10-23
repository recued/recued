import { expect, test, type Page } from '@playwright/test';

const zone = (page: Page) => page.locator('[data-recued-server-timezone-zone]');
const save = (page: Page) => page.locator('[data-recued-server-timezone-save]');
const pending = (page: Page) => page.getByRole('status').filter({ hasText: 'Saving timezone…' });
const outside = (page: Page) => page.getByRole('button', { name: 'Outside panel', exact: true });
const writes = (page: Page) => page.evaluate(() => window.__timezone.calls.filter(call => call.kind === 'set').map(call => call.args));
const reads = (page: Page) => page.evaluate(() => window.__timezone.calls.filter(call => call.kind === 'get').length);
const release = (page: Page, kind: 'get' | 'set', index = 0, outcome: 'success' | 'error' | 'applied_error' | 'incomplete' | 'missing_zone' | 'invalid_zone_type' = 'success') =>
  page.evaluate(({ kind, index, outcome }) => window.__timezone.release(kind, index, outcome), { kind, index, outcome });
const open = async (page: Page, mode = 'fixed') => {
  await page.goto(`/server-timezone-harness.html?mode=${mode}`);
  await page.waitForFunction(() => window.__timezone !== undefined);
  await release(page, 'get');
  await expect(page.locator('[data-recued-server-timezone-panel]')).toHaveAttribute('data-recued-server-timezone-state', 'ready');
};
const activateSave = async (page: Page) => { await save(page).focus(); await page.keyboard.press('Enter'); };
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });
const guards = (page: Page) => page.evaluate(() => window.__timezone.guards());

for (const width of [390, 1280]) {
  test(`restored timezone text clears its draft and follows the next saved snapshot at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); expect(await guards(page)).toEqual({ work: false, dirty: false });
    await zone(page).fill('  Asia/Tokyo  '); expect(await guards(page)).toEqual({ work: false, dirty: true });
    await zone(page).fill('Europe/London'); expect(await guards(page)).toEqual({ work: false, dirty: false });
    await page.evaluate(() => { window.__timezone.setServer('Europe/Paris'); window.__timezone.refresh(); }); await release(page, 'get', 1);
    await expect(zone(page)).toHaveValue('Europe/Paris'); await expect(zone(page)).toBeFocused();
    expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toEqual([]);
  });

  test(`a fixed-mode draft stays guarded while a successful follow-host choice retires only the active setting at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page, 'follows_host');
    await page.locator('[data-recued-server-timezone-mode="fixed"]').press('Space');
    expect(await guards(page)).toEqual({ work: false, dirty: true }); await zone(page).fill('Asia/Tokyo'); expect(await writes(page)).toEqual([]);
    await page.locator('[data-recued-server-timezone-mode="follows_host"]').press('Space');
    expect(await guards(page)).toEqual({ work: true, dirty: true }); await release(page, 'set');
    expect(await guards(page)).toEqual({ work: false, dirty: false }); await expect(zone(page)).toHaveCount(0);
    await page.locator('[data-recued-server-timezone-mode="fixed"]').press('Space'); await expect(zone(page)).toHaveValue('Asia/Tokyo');
    expect(await guards(page)).toEqual({ work: false, dirty: true }); expect(await writes(page)).toEqual([{ mode: 'follows_host' }]);
  });

  for (const outcome of ['error', 'applied_error'] as const) {
    test(`restoring a timezone after save ${outcome} remains guarded through failed recovery reads at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page); await zone(page).fill('Asia/Tokyo'); await activateSave(page);
      await release(page, 'set', 0, outcome); await zone(page).fill('Europe/London'); expect(await guards(page)).toEqual({ work: false, dirty: true });
      await outside(page).focus(); await page.evaluate(() => window.__timezone.refresh()); await release(page, 'get', 1, 'error');
      expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(zone(page)).toHaveValue('Europe/London'); await expect(outside(page)).toBeFocused();
      await page.evaluate(() => window.__timezone.refresh()); await release(page, 'get', 2); await expect(zone(page)).toHaveValue('Europe/London');
      expect(await guards(page)).toEqual({ work: false, dirty: outcome === 'applied_error' });
      if (outcome === 'applied_error') { await zone(page).fill('Asia/Tokyo'); expect(await guards(page)).toEqual({ work: false, dirty: false }); }
      expect(await writes(page)).toEqual([{ mode: 'fixed', zone: 'Asia/Tokyo' }]); expect(await reads(page)).toBe(3);
    });
  }

  test(`an unchanged timezone save still needs confirmation after its reply fails at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await activateSave(page); await release(page, 'set', 0, 'error');
    await zone(page).fill('Europe/London'); expect(await guards(page)).toEqual({ work: false, dirty: true });
    await page.evaluate(() => window.__timezone.refresh()); await release(page, 'get', 1);
    expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toEqual([{ mode: 'fixed', zone: 'Europe/London' }]);
  });

  test(`an uncertain follow-host write preserves a fixed draft through recovery at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await zone(page).fill('Asia/Tokyo');
    await page.locator('[data-recued-server-timezone-mode="follows_host"]').press('Space'); await release(page, 'set', 0, 'applied_error');
    expect(await guards(page)).toEqual({ work: false, dirty: true }); await page.evaluate(() => window.__timezone.refresh()); await release(page, 'get', 1);
    await expect(zone(page)).toHaveValue('Asia/Tokyo'); expect(await guards(page)).toEqual({ work: false, dirty: true });
    await page.locator('[data-recued-server-timezone-mode="follows_host"]').press('Space'); await release(page, 'set', 1);
    expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toEqual([{ mode: 'follows_host' }, { mode: 'follows_host' }]);
  });

  for (const outcome of ['incomplete', 'missing_zone', 'invalid_zone_type'] as const) {
    test(`incomplete timezone replies (${outcome}) retain draft text and the confirmed clock until a complete read at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page); await zone(page).fill('Asia/Tokyo'); await activateSave(page);
      await release(page, 'set', 0, outcome); expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(zone(page)).toHaveValue('Asia/Tokyo');
      await expect(page.getByText('Saved as Europe/London.', { exact: true })).toBeVisible();
      await outside(page).focus(); await page.evaluate(() => window.__timezone.refresh()); await release(page, 'get', 1, outcome);
      expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(outside(page)).toBeFocused();
      await expect(page.getByRole('alert')).toHaveText('Recued could not confirm the server timezone. Try again.');
      await page.evaluate(() => window.__timezone.refresh()); await release(page, 'get', 2);
      expect(await guards(page)).toEqual({ work: false, dirty: false }); await expect(zone(page)).toHaveValue('Asia/Tokyo');
      expect(await writes(page)).toEqual([{ mode: 'fixed', zone: 'Asia/Tokyo' }]);
    });
  }
}

for (const width of [390, 1280]) {
  for (const mode of ['fixed', 'follows_host'] as const) {
    test(`legacy stored timezone remains editable in ${mode} mode at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/server-timezone-harness.html?mode=${mode}&stored_zone=Legacy%2FRetired`);
      await page.waitForFunction(() => window.__timezone !== undefined); await release(page, 'get');
      await expect(page.locator('[data-recued-server-timezone-panel]')).toHaveAttribute('data-recued-server-timezone-state', 'ready');
      expect(await guards(page)).toEqual({ work: false, dirty: false });
      await expect(page.locator('[data-recued-server-timezone-clock-role="authoritative"]')).toContainText('Europe/London');
      if (mode === 'follows_host') await page.locator('[data-recued-server-timezone-mode="fixed"]').press('Space');
      await expect(zone(page)).toHaveValue('Legacy/Retired'); await zone(page).fill('Asia/Tokyo');
      expect(await guards(page)).toEqual({ work: false, dirty: true });
      await zone(page).fill('Legacy/Retired'); expect(await guards(page)).toEqual({ work: false, dirty: mode === 'follows_host' });
      await zone(page).fill('Asia/Tokyo'); await zone(page).press('Enter'); await release(page, 'set');
      await expect(zone(page)).toHaveValue('Asia/Tokyo'); await expect(zone(page)).toBeFocused();
      await expect(page.getByText('Saved as Asia/Tokyo.', { exact: true })).toBeVisible();
      expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toEqual([{ mode: 'fixed', zone: 'Asia/Tokyo' }]);
    });
  }

  test(`legacy stored timezone refresh keeps the raw draft and selection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await zone(page).fill('  Asia/Tokyo  ');
    await zone(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(3, 8, 'backward'));
    await page.evaluate(() => { window.__timezone.setServer('Legacy/Retired'); window.__timezone.refresh(); }); await release(page, 'get', 1);
    await expect(page.getByText('Saved as Legacy/Retired.', { exact: true })).toBeVisible();
    await expect(page.locator('[data-recued-server-timezone-clock-role="authoritative"]')).toContainText('Europe/London');
    await expect(zone(page)).toHaveValue('  Asia/Tokyo  '); await expect(zone(page)).toBeFocused();
    expect(await zone(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([3, 8, 'backward']);
    expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(page.getByRole('alert')).toHaveCount(0);
    await zone(page).fill('Legacy/Retired'); expect(await guards(page)).toEqual({ work: false, dirty: false });
    expect(await writes(page)).toEqual([]);
  });
}

for (const width of [390, 1280]) {
  test(`failed saves retain the entered zone and keyboard retries submit it at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page);
    await zone(page).fill('  Asia/Tokyo  '); await activateSave(page);
    await expect(zone(page)).toHaveValue('  Asia/Tokyo  '); await expect(zone(page)).toBeDisabled();
    await expect(pending(page)).toBeFocused();
    await expect(page.locator('[data-recued-server-timezone-clock-role="authoritative"]')).toContainText('Europe/London');
    await release(page, 'set', 0, 'error');
    await expect(page.getByRole('alert')).toHaveText('Connection interrupted. Try saving again.');
    await expect(zone(page)).toHaveValue('  Asia/Tokyo  '); await expect(save(page)).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await writes(page)).toEqual([{ mode: 'fixed', zone: 'Asia/Tokyo' }, { mode: 'fixed', zone: 'Asia/Tokyo' }]);
    await release(page, 'set', 1);
    await expect(page.getByText('Saved as Asia/Tokyo.', { exact: true })).toBeVisible();
    await expect(zone(page)).toHaveValue('Asia/Tokyo'); await expect(save(page)).toBeFocused();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('Enter saves the labeled zone and preserves its selection after failure before showing the confirmed canonical zone', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('textbox', { name: 'Server timezone', exact: true })).toBeVisible();
  await zone(page).fill('PST'); await zone(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 2, 'backward'));
  await page.keyboard.press('Enter'); await expect(pending(page)).toBeFocused();
  await release(page, 'set', 0, 'error'); await expect(zone(page)).toBeFocused();
  expect(await zone(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([1, 2, 'backward']);
  await page.keyboard.press('Enter'); await release(page, 'set', 1);
  await expect(zone(page)).toHaveValue('America/Los_Angeles'); await expect(zone(page)).toBeFocused();
  await expect(page.getByText('Saved as America/Los_Angeles.', { exact: true })).toBeVisible();
  expect(await writes(page)).toEqual([{ mode: 'fixed', zone: 'PST' }, { mode: 'fixed', zone: 'PST' }]);
});

test('choosing a fixed timezone opens the field without writing until Enter confirms it', async ({ page }) => {
  await open(page, 'follows_host');
  const fixed = page.locator('[data-recued-server-timezone-mode="fixed"]');
  await fixed.focus(); await page.keyboard.press('Space'); await expect(zone(page)).toBeFocused();
  expect(await writes(page)).toEqual([]);
  await zone(page).fill('Asia/Tokyo'); await page.keyboard.press('Enter');
  expect(await writes(page)).toEqual([{ mode: 'fixed', zone: 'Asia/Tokyo' }]);
  await release(page, 'set'); await expect(zone(page)).toHaveValue('Asia/Tokyo');
});

test('a save reply never reclaims focus after the owner moves outside the panel', async ({ page }) => {
  await open(page); await zone(page).fill('Asia/Tokyo'); await activateSave(page);
  await outside(page).focus(); await release(page, 'set', 0, 'error');
  await expect(outside(page)).toBeFocused(); await expect(zone(page)).toHaveValue('Asia/Tokyo');
  await activateSave(page); await outside(page).focus(); await release(page, 'set', 1);
  await expect(outside(page)).toBeFocused(); await expect(zone(page)).toHaveValue('Asia/Tokyo');
});

test('refresh keeps the draft, input focus and selection while the saved clock updates', async ({ page }) => {
  await open(page); await zone(page).fill('Asia/Tokyo');
  await zone(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(5, 10, 'backward'));
  await page.evaluate(() => { window.__timezone.setServer('Europe/Paris'); window.__timezone.refresh(); });
  await release(page, 'get', 1);
  await expect(zone(page)).toHaveValue('Asia/Tokyo'); await expect(zone(page)).toBeFocused();
  expect(await zone(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([5, 10, 'backward']);
  await expect(page.getByText('Saved as Europe/Paris.', { exact: true })).toBeVisible();
  expect(await writes(page)).toEqual([]);
});

for (const outcome of ['success', 'error'] as const) {
  test(`a late read cannot replace a save ${outcome}`, async ({ page }) => {
    await open(page); await page.evaluate(() => window.__timezone.refresh());
    await zone(page).fill('Asia/Tokyo'); await activateSave(page); await release(page, 'set', 0, outcome);
    if (outcome === 'success') await expect(page.getByText('Saved as Asia/Tokyo.', { exact: true })).toBeVisible();
    else await expect(page.getByRole('alert')).toBeVisible();
    await release(page, 'get', 1);
    await expect(zone(page)).toHaveValue('Asia/Tokyo');
    if (outcome === 'success') await expect(page.getByText('Saved as Asia/Tokyo.', { exact: true })).toBeVisible();
    else await expect(page.getByRole('alert')).toHaveText('Connection interrupted. Try saving again.');
  });
}

test('duplicate saves and refresh requests during a write leave the pending write in charge', async ({ page }) => {
  await open(page); await zone(page).fill('Asia/Tokyo'); await activateSave(page);
  await save(page).evaluate(button => (button as HTMLButtonElement).click());
  await page.evaluate(() => { window.__timezone.refresh(); window.__timezone.refresh(); });
  expect(await reads(page)).toBe(1); expect(await writes(page)).toHaveLength(1);
  await release(page, 'set'); await expect(zone(page)).toHaveValue('Asia/Tokyo');
});

for (const kind of ['get', 'set'] as const) {
  test(`disposing retires a late ${kind} reply and leaves the replacement panel's focus alone`, async ({ page }) => {
    await open(page);
    if (kind === 'set') { await zone(page).fill('Asia/Tokyo'); await activateSave(page); }
    else await page.evaluate(() => window.__timezone.refresh());
    await page.evaluate(() => window.__timezone.remount());
    await release(page, 'get', kind === 'get' ? 2 : 1);
    await expect(zone(page)).toHaveValue('Europe/London'); await outside(page).focus();
    await release(page, kind, kind === 'get' ? 1 : 0);
    await expect(zone(page)).toHaveValue('Europe/London'); await expect(outside(page)).toBeFocused();
  });
}

test('a failed follow-host change retains the fixed draft and a successful retry keeps it available', async ({ page }) => {
  await open(page); await zone(page).fill('Asia/Tokyo');
  const follows = page.locator('[data-recued-server-timezone-mode="follows_host"]');
  await follows.focus(); await page.keyboard.press('Space'); await release(page, 'set', 0, 'error');
  await expect(zone(page)).toHaveValue('Asia/Tokyo'); await expect(follows).toBeFocused();
  await page.keyboard.press('Space'); await release(page, 'set', 1); await expect(zone(page)).toHaveCount(0);
  await expect(follows).toBeChecked(); await expect(follows).toBeFocused();
  await page.locator('[data-recued-server-timezone-mode="fixed"]').focus(); await page.keyboard.press('Space');
  await expect(zone(page)).toHaveValue('Asia/Tokyo');
  expect(await writes(page)).toEqual([{ mode: 'follows_host' }, { mode: 'follows_host' }]);
});

test('only the newest refresh updates the saved timezone', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.__timezone.refresh(); window.__timezone.setServer('Europe/Paris'); window.__timezone.refresh(); });
  await release(page, 'get', 2); await expect(zone(page)).toHaveValue('Europe/Paris');
  await release(page, 'get', 1); await expect(zone(page)).toHaveValue('Europe/Paris');
});

const checkSaved = (page: Page) => page.getByRole('button', { name: 'Check saved timezone', exact: true });
const checking = (page: Page) => page.getByRole('status').filter({ hasText: 'Checking saved timezone…' });
const uncertainSave = async (page: Page, outcome: 'error' | 'applied_error' = 'applied_error') => {
  await zone(page).fill('Asia/Tokyo'); await zone(page).press('Enter'); await release(page, 'set', 0, outcome);
  await expect(page.getByRole('alert')).toHaveText('Connection interrupted. Try saving again.');
  await expect(checkSaved(page)).toBeVisible();
};

for (const width of [390, 1280]) {
  for (const outcome of ['error', 'applied_error'] as const) {
    test(`timezone recovery confirms a save ${outcome} without another write at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page); await expect(checkSaved(page)).toHaveCount(0);
      await uncertainSave(page, outcome); await zone(page).fill('Europe/London');
      await zone(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(3, 9, 'backward'));
      await checkSaved(page).press('Enter'); await expect(checking(page)).toBeFocused(); await expect(checkSaved(page)).toBeDisabled();
      await checkSaved(page).evaluate(button => (button as HTMLButtonElement).click()); expect(await reads(page)).toBe(2);
      expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(zone(page)).toBeEnabled();
      await release(page, 'get', 1); await expect(checkSaved(page)).toHaveCount(0); await expect(checking(page)).toHaveCount(0);
      await expect(zone(page)).toHaveValue('Europe/London'); await expect(zone(page)).toBeFocused();
      expect(await zone(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([3, 9, 'backward']);
      await expect(page.getByText(`Saved as ${outcome === 'applied_error' ? 'Asia/Tokyo' : 'Europe/London'}.`, { exact: true })).toBeVisible();
      expect(await guards(page)).toEqual({ work: false, dirty: outcome === 'applied_error' });
      expect(await writes(page)).toEqual([{ mode: 'fixed', zone: 'Asia/Tokyo' }]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

  for (const outcome of ['error', 'incomplete'] as const) {
    test(`timezone recovery retains uncertainty after a read ${outcome} and supports keyboard retry at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page); await uncertainSave(page); await zone(page).fill('Europe/London');
      await checkSaved(page).press('Enter'); await expect(checking(page)).toBeFocused(); await release(page, 'get', 1, outcome);
      await expect(checkSaved(page)).toBeEnabled(); await expect(checkSaved(page)).toBeFocused();
      await expect(page.getByText('Saved as Europe/London.', { exact: true })).toBeVisible();
      expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(zone(page)).toHaveValue('Europe/London');
      await page.keyboard.press('Space'); await expect(checking(page)).toBeFocused(); await release(page, 'get', 2);
      await expect(checkSaved(page)).toHaveCount(0); await expect(zone(page)).toBeFocused();
      expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByText('Saved as Asia/Tokyo.', { exact: true })).toBeVisible();
      expect(await writes(page)).toEqual([{ mode: 'fixed', zone: 'Asia/Tokyo' }]); expect(await reads(page)).toBe(3);
    });
  }

  test(`timezone recovery preserves newer raw text and backward selection during a check at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await uncertainSave(page); await checkSaved(page).press('Enter');
    await zone(page).fill('  Pacific/Auckland  '); await zone(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(3, 9, 'backward'));
    await release(page, 'get', 1); await expect(zone(page)).toHaveValue('  Pacific/Auckland  '); await expect(zone(page)).toBeFocused();
    expect(await zone(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([3, 9, 'backward']);
    await expect(page.getByText('Saved as Asia/Tokyo.', { exact: true })).toBeVisible();
    expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(checkSaved(page)).toHaveCount(0); expect(await writes(page)).toHaveLength(1);
  });

  test(`timezone recovery preserves a fixed draft when the server confirms follow-host mode at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await zone(page).fill('  Asia/Tokyo  ');
    await page.locator('[data-recued-server-timezone-mode="follows_host"]').press('Space'); await release(page, 'set', 0, 'applied_error');
    await checkSaved(page).press('Enter'); await release(page, 'get', 1);
    await expect(zone(page)).toHaveValue('  Asia/Tokyo  '); await expect(zone(page)).toBeFocused();
    await expect(page.locator('[data-recued-server-timezone-mode="fixed"]')).toBeChecked();
    await expect(page.getByText('Following this machine — currently Europe/London.', { exact: true })).toBeVisible();
    expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(checkSaved(page)).toHaveCount(0);
    expect(await writes(page)).toEqual([{ mode: 'follows_host' }]);
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`timezone recovery read ${outcome} leaves outside focus alone at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page); await uncertainSave(page); await checkSaved(page).press('Enter');
      await outside(page).focus(); await release(page, 'get', 1, outcome); await expect(outside(page)).toBeFocused();
      await expect(zone(page)).toHaveValue('Asia/Tokyo'); expect(await writes(page)).toHaveLength(1);
      expect(await guards(page)).toEqual({ work: false, dirty: outcome === 'error' });
    });

    test(`timezone recovery ignores a stale check ${outcome} after a newer save at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page); await uncertainSave(page); await checkSaved(page).press('Enter');
      await zone(page).fill('Pacific/Auckland'); await zone(page).press('Enter'); await expect(checking(page)).toHaveCount(0);
      await release(page, 'set', 1); await expect(page.getByText('Saved as Pacific/Auckland.', { exact: true })).toBeVisible();
      await release(page, 'get', 1, outcome); await expect(zone(page)).toHaveValue('Pacific/Auckland'); await expect(zone(page)).toBeFocused();
      await expect(page.getByRole('alert')).toHaveCount(0); await expect(checkSaved(page)).toHaveCount(0);
      expect(await guards(page)).toEqual({ work: false, dirty: false });
      expect(await writes(page)).toEqual([{ mode: 'fixed', zone: 'Asia/Tokyo' }, { mode: 'fixed', zone: 'Pacific/Auckland' }]);
    });
  }
}

for (const width of [390, 1280]) {
  for (const outcome of ['success', 'error'] as const) {
    test(`timezone recovery keeps native Undo after a check ${outcome} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page); await uncertainSave(page); await checkSaved(page).press('Enter');
      await zone(page).focus(); await page.keyboard.type('abc'); await zone(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 2, 'forward'));
      const original = await zone(page).elementHandle(); await release(page, 'get', 1, outcome);
      await expect(zone(page)).toHaveValue('Asia/Tokyoabc'); await expect(zone(page)).toBeFocused();
      expect.soft(await original!.evaluate(input => input.isConnected && input === document.activeElement)).toBe(true);
      expect(await zone(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([1, 2, 'forward']);
      await page.keyboard.press('ControlOrMeta+z'); await expect(zone(page)).toHaveValue('Asia/Tokyo');
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(zone(page)).toHaveValue('Asia/Tokyoabc');
      expect(await guards(page)).toEqual({ work: false, dirty: true }); expect(await writes(page)).toHaveLength(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

declare global { interface Window {
  __timezoneImeEvents: Array<{ type: string; trusted: boolean; data: string | null }>;
} }
for (const width of [390, 1280]) {
  for (const outcome of ['success', 'error'] as const) {
    test(`timezone recovery keeps native composition through a check ${outcome} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page); await uncertainSave(page); await checkSaved(page).press('Enter');
      await zone(page).fill('Pacific/'); await zone(page).focus();
      await zone(page).evaluate(input => {
        window.__timezoneImeEvents = [];
        for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) input.addEventListener(type, event => {
          window.__timezoneImeEvents.push({ type: event.type, trusted: event.isTrusted, data: (event as CompositionEvent).data });
        });
      });
      const original = await zone(page).elementHandle(), cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send('Input.imeSetComposition', { text: 'Auck', selectionStart: 4, selectionEnd: 4 });
        await expect(zone(page)).toHaveValue('Pacific/Auck'); await release(page, 'get', 1, outcome);
        expect(await original!.evaluate(input => input.isConnected && input === document.activeElement)).toBe(true);
        const pendingEvents = await page.evaluate(() => window.__timezoneImeEvents);
        expect(pendingEvents.some(event => event.type === 'compositionstart')).toBe(true);
        expect(pendingEvents.some(event => event.type === 'compositionend')).toBe(false);
        expect(pendingEvents.every(event => event.trusted)).toBe(true);
        await cdp.send('Input.imeSetComposition', { text: 'Auckland', selectionStart: 8, selectionEnd: 8 });
        await cdp.send('Input.insertText', { text: 'Auckland' });
        await expect(zone(page)).toHaveValue('Pacific/Auckland'); await expect(zone(page)).toBeFocused();
        // CDP's insertText commits composition, but Chromium marks that end
        // event untrusted. Candidate composition updates above must be trusted.
        expect(await page.evaluate(() => window.__timezoneImeEvents.filter(event => event.type === 'compositionend'))).toMatchObject([
          { type: 'compositionend', data: 'Auckland' },
        ]);
        expect(await guards(page)).toEqual({ work: false, dirty: true }); expect(await writes(page)).toHaveLength(1);
      } finally { await cdp.detach(); }
    });
  }
}
