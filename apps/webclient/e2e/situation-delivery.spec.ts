import { expect, test, type Page } from '@playwright/test';

const panel = (page: Page) => page.locator('[data-situation-delivery]');
const time = (page: Page) => panel(page).getByLabel('Time', { exact: true });
const save = (page: Page) => panel(page).getByRole('button', { name: 'Save overview schedule', exact: true });
const send = (page: Page) => panel(page).getByRole('button', { name: 'Send now', exact: true });
const notice = (page: Page) => panel(page).locator('[data-situation-delivery-message]');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside panel', exact: true });
const retry = (page: Page) => page.getByRole('button', { name: 'Retry overview settings', exact: true });
const reads = (page: Page) => page.evaluate(() => window.__overview.calls.filter(call => call.kind === 'read').length);
const changes = (page: Page) => page.evaluate(() => window.__overview.calls.filter(call => call.kind !== 'read'));
const release = (page: Page, kind: 'read' | 'save' | 'send', index = 0, outcome: 'success' | 'error' | 'unsupported' = 'success') =>
  page.evaluate(({ kind, index, outcome }) => window.__overview.release(kind, index, outcome), { kind, index, outcome });
const activate = async (page: Page, kind: 'save' | 'send') => { await (kind === 'save' ? save(page) : send(page)).focus(); await page.keyboard.press('Enter'); };
const open = async (page: Page) => {
  await page.goto('/situation-delivery-harness.html');
  await page.waitForFunction(() => window.__overview !== undefined);
  await release(page, 'read'); await expect(time(page)).toHaveValue('09:00');
};
const edit = async (page: Page) => {
  await panel(page).getByLabel('Overview', { exact: true }).selectOption('daily');
  await panel(page).getByLabel('Weekly day', { exact: true }).selectOption('5');
  await time(page).fill('23:30'); await panel(page).getByLabel('Day-of notes', { exact: true }).uncheck();
};
const expectDraft = async (page: Page) => {
  await expect(panel(page).getByLabel('Overview', { exact: true })).toHaveValue('daily');
  await expect(panel(page).getByLabel('Weekly day', { exact: true })).toHaveValue('5');
  await expect(time(page)).toHaveValue('23:30');
  await expect(panel(page).getByLabel('Day-of notes', { exact: true })).not.toBeChecked();
};
const finish = async (page: Page, kind: 'save' | 'send', index = 0, readIndex = 1) => {
  await release(page, kind, index); await expect.poll(() => reads(page)).toBeGreaterThan(readIndex); await release(page, 'read', readIndex);
};
const draft = { frequency: 'daily', weekday: 5, time: '23:30', day_of: false };
const unsaved = (page: Page) => page.evaluate(() => window.__overview.hasUnsavedChanges());
const restore = async (page: Page) => {
  await panel(page).getByLabel('Overview', { exact: true }).selectOption('weekly');
  await panel(page).getByLabel('Weekly day', { exact: true }).selectOption('1');
  await time(page).fill('09:00'); await panel(page).getByLabel('Day-of notes', { exact: true }).check();
};
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

for (const width of [390, 1280]) {
  test(`a fully reverted schedule adopts newer confirmed settings at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await edit(page);
    const original = await time(page).elementHandle(); expect(await unsaved(page)).toBe(true);
    await restore(page); expect(await unsaved(page)).toBe(false); await outside(page).focus();
    await page.evaluate(() => {
      window.__overview.setServer({ settings: { frequency: 'off', weekday: 7, time: '12:00', day_of: false } });
      window.__overview.refresh();
    });
    await release(page, 'read', 1);
    await expect(panel(page).getByLabel('Overview', { exact: true })).toHaveValue('off');
    await expect(panel(page).getByLabel('Weekly day', { exact: true })).toHaveValue('7');
    await expect(time(page)).toHaveValue('12:00'); await expect(panel(page).getByLabel('Day-of notes', { exact: true })).not.toBeChecked();
    expect(await unsaved(page)).toBe(false); await expect(outside(page)).toBeFocused(); expect(await changes(page)).toEqual([]);
    expect(await original!.evaluate(input => input.isConnected)).toBe(true);
  });

  test(`draft reverts compare against the latest confirmed schedule at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await edit(page);
    await page.evaluate(() => {
      window.__overview.setServer({ settings: { frequency: 'off', weekday: 7, time: '12:00', day_of: false } });
      window.__overview.refresh();
    });
    await release(page, 'read', 1); await expectDraft(page); expect(await unsaved(page)).toBe(true);
    await restore(page); expect(await unsaved(page)).toBe(true);
    await panel(page).getByLabel('Overview', { exact: true }).selectOption('off');
    await panel(page).getByLabel('Weekly day', { exact: true }).selectOption('7'); await time(page).fill('12:00');
    expect(await unsaved(page)).toBe(true); await panel(page).getByLabel('Day-of notes', { exact: true }).uncheck();
    expect(await unsaved(page)).toBe(false); expect(await changes(page)).toEqual([]); expect(await reads(page)).toBe(2);
  });

  test(`a confirmed save becomes the baseline for later reverts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await edit(page);
    await activate(page, 'save'); await finish(page, 'save'); await expect(notice(page)).toHaveText('Overview schedule saved.');
    expect(await unsaved(page)).toBe(false); await restore(page); expect(await unsaved(page)).toBe(true);
    await edit(page); expect(await unsaved(page)).toBe(false);
    expect(await changes(page)).toEqual([{ kind: 'save', settings: draft }]); expect(await reads(page)).toBe(2);
  });

  for (const phase of ['write', 'confirmation'] as const) {
    test(`reverting after a failed ${phase} keeps a save guarded until a fresh read at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page); await edit(page); await activate(page, 'save');
      if (phase === 'write') await release(page, 'save', 0, 'error');
      else { await release(page, 'save'); await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1, 'error'); }
      await expect(notice(page)).toHaveAttribute('role', 'alert'); await restore(page); expect(await unsaved(page)).toBe(true);
      const failedRead = await reads(page); await page.evaluate(() => window.__overview.refresh()); await release(page, 'read', failedRead, 'error');
      await expect(notice(page)).toHaveAttribute('role', 'alert'); expect(await unsaved(page)).toBe(true); await expect(time(page)).toHaveValue('09:00');
      const before = await reads(page); await page.evaluate(() => window.__overview.refresh()); await release(page, 'read', before);
      await expect(time(page)).toHaveValue('09:00');
      await expect(panel(page).getByLabel('Overview', { exact: true })).toHaveValue('weekly');
      await expect(panel(page).getByLabel('Weekly day', { exact: true })).toHaveValue('1');
      await expect(panel(page).getByLabel('Day-of notes', { exact: true })).toBeChecked();
      expect(await unsaved(page)).toBe(phase === 'confirmation');
      if (phase === 'confirmation') { await edit(page); expect(await unsaved(page)).toBe(false); }
      expect(await changes(page)).toEqual([{ kind: 'save', settings: draft }]); expect(await reads(page)).toBe(before + 1);
    });
  }

  test(`Send now updates delivery results while keeping all schedule edits for Save at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await edit(page);
    const original = await time(page).elementHandle(); await activate(page, 'send');
    await expectDraft(page); await expect(time(page)).toBeDisabled(); await expect(notice(page)).toBeFocused();
    await finish(page, 'send'); await expectDraft(page); await expect(send(page)).toBeFocused();
    await expect(notice(page)).toContainText('Checked.');
    await panel(page).getByText('What it sent', { exact: true }).click(); await expect(panel(page)).toContainText('Fixture overview');
    expect(await changes(page)).toEqual([{ kind: 'send' }]);
    await activate(page, 'save'); expect(await changes(page)).toEqual([{ kind: 'send' }, { kind: 'save', settings: draft }]);
    await finish(page, 'save', 0, 2); await expect(notice(page)).toHaveText('Overview schedule saved.');
    await expectDraft(page); await expect(save(page)).toBeFocused();
    expect(await original!.evaluate(input => input.isConnected && input === document.querySelector('[name="time"]'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const kind of ['save', 'send'] as const) for (const outcome of ['success', 'error'] as const) {
  test(`a ${kind} ${outcome} does not reclaim focus after the owner moves outside`, async ({ page }) => {
    await open(page); await edit(page); await activate(page, kind); await outside(page).focus();
    if (outcome === 'success') await finish(page, kind);
    else { await release(page, kind, 0, 'error'); await expect(notice(page)).toHaveAttribute('role', 'alert'); }
    await expect(outside(page)).toBeFocused(); await expectDraft(page); await expect(time(page)).toBeEnabled();
  });
}

test('a failed schedule save retains its draft, announces the error and retries the same settings', async ({ page }) => {
  await open(page); await edit(page); await activate(page, 'save'); await release(page, 'save', 0, 'error');
  await expect(notice(page)).toHaveAttribute('role', 'alert'); await expect(notice(page)).toHaveText('Could not save the overview schedule. Try again.');
  await expect(save(page)).toBeFocused(); await expectDraft(page); await page.keyboard.press('Enter');
  expect(await changes(page)).toEqual([{ kind: 'save', settings: draft }, { kind: 'save', settings: draft }]);
  await finish(page, 'save', 1); await expect(notice(page)).toHaveText('Overview schedule saved.');
});

for (const kind of ['save', 'send'] as const) {
  test(`a failed read after ${kind} retries only the read and preserves edits`, async ({ page }) => {
    await open(page); await edit(page); await activate(page, kind);
    await release(page, kind); await expect.poll(() => reads(page)).toBe(2); await expect(time(page)).toBeDisabled();
    await release(page, 'read', 1, 'error'); await expect(notice(page)).toHaveAttribute('role', 'alert');
    await expectDraft(page); await expect(kind === 'save' ? save(page) : send(page)).toBeFocused();
    await retry(page).focus(); await page.keyboard.press('Enter'); await release(page, 'read', 2);
    await expectDraft(page); await expect(retry(page)).toBeHidden(); await expect(save(page)).toBeFocused();
    expect(await changes(page)).toEqual(kind === 'save' ? [{ kind: 'save', settings: draft }] : [{ kind: 'send' }]);
  });
}

test('an initial read failure can be retried from the keyboard', async ({ page }) => {
  await page.goto('/situation-delivery-harness.html'); await page.waitForFunction(() => window.__overview !== undefined);
  await release(page, 'read', 0, 'error'); await expect(notice(page)).toHaveAttribute('role', 'alert');
  await retry(page).focus(); await page.keyboard.press('Enter'); await release(page, 'read', 1);
  await expect(time(page)).toHaveValue('09:00'); await expect(save(page)).toBeFocused();
  expect(await changes(page)).toEqual([]);
});

test('a server without overview settings omits the initial panel', async ({ page }) => {
  await page.goto('/situation-delivery-harness.html'); await page.waitForFunction(() => window.__overview !== undefined);
  await release(page, 'read', 0, 'unsupported'); await expect(panel(page)).toHaveCount(0);
  expect(await changes(page)).toEqual([]);
});

test('refresh updates delivery results while retaining the form draft and active input', async ({ page }) => {
  await open(page); await edit(page); await time(page).focus(); const original = await time(page).elementHandle();
  await page.evaluate(() => { window.__overview.setServer({ pending: 2, uncertain: 1 }); window.__overview.refresh(); });
  await expectDraft(page); await release(page, 'read', 1); await expectDraft(page); await expect(time(page)).toBeFocused();
  await expect(panel(page)).toContainText('2 overview deliveries are waiting.');
  await expect(panel(page)).toContainText('1 deliveries could not be confirmed');
  expect(await original!.evaluate(input => input.isConnected && document.activeElement === input)).toBe(true);
});

test('an untouched schedule adopts refreshed server settings', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.__overview.setServer({ settings: { frequency: 'daily', weekday: 5, time: '23:30', day_of: false } }); window.__overview.refresh(); });
  await release(page, 'read', 1); await expectDraft(page); expect(await changes(page)).toEqual([]);
});

for (const kind of ['save', 'send'] as const) {
  test(`an older read cannot replace a ${kind} confirmation`, async ({ page }) => {
    await open(page); await page.evaluate(() => window.__overview.refresh()); await edit(page); await activate(page, kind);
    await finish(page, kind, 0, 2); await release(page, 'read', 1); await expectDraft(page);
    if (kind === 'save') await expect(notice(page)).toHaveText('Overview schedule saved.');
    else await expect(panel(page).getByText('What it sent', { exact: true })).toBeVisible();
  });
}

for (const width of [390, 1280]) for (const outcome of ['success', 'error'] as const) {
  test(`an older read ${outcome} cannot retire an unconfirmed save or its error at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page); await page.evaluate(() => window.__overview.refresh());
    await edit(page); await activate(page, 'save'); await release(page, 'save', 0, 'error');
    await expect(notice(page)).toHaveText('Could not save the overview schedule. Try again.'); await expectDraft(page);
    await restore(page); expect(await unsaved(page)).toBe(true); await outside(page).focus();
    await release(page, 'read', 1, outcome);
    await expect(notice(page)).toHaveText('Could not save the overview schedule. Try again.'); await expect(time(page)).toHaveValue('09:00');
    expect(await unsaved(page)).toBe(true); await expect(outside(page)).toBeFocused();
    await page.evaluate(() => window.__overview.refresh()); await release(page, 'read', 2);
    expect(await unsaved(page)).toBe(false); await expect(outside(page)).toBeFocused(); await expect(time(page)).toHaveValue('09:00');
    expect(await changes(page)).toEqual([{ kind: 'save', settings: draft }]); expect(await reads(page)).toBe(3);
  });
}

test('only the newest refresh can update the schedule', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.__overview.refresh(); window.__overview.setServer({ settings: { frequency: 'daily', weekday: 5, time: '23:30', day_of: false } }); window.__overview.refresh(); });
  await release(page, 'read', 2); await release(page, 'read', 1); await expectDraft(page);
});

test('duplicate actions and refresh calls cannot start work during a pending write or its confirmation read', async ({ page }) => {
  await open(page); await edit(page); await activate(page, 'send');
  const attempt = () => page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-send-now]')!.click();
    document.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    window.__overview.refresh();
  });
  await attempt(); expect(await changes(page)).toEqual([{ kind: 'send' }]); expect(await reads(page)).toBe(1);
  await release(page, 'send'); await expect.poll(() => reads(page)).toBe(2); await attempt();
  expect(await changes(page)).toEqual([{ kind: 'send' }]); expect(await reads(page)).toBe(2);
  await release(page, 'read', 1); await expectDraft(page);
});

for (const kind of ['read', 'save', 'send'] as const) {
  test(`disposing ignores a late ${kind} reply and leaves the new panel and focus alone`, async ({ page }) => {
    await open(page);
    if (kind === 'read') await page.evaluate(() => window.__overview.refresh());
    else { await edit(page); await activate(page, kind); }
    await page.evaluate(() => window.__overview.remount());
    await release(page, 'read', kind === 'read' ? 2 : 1); await outside(page).focus();
    await release(page, kind, kind === 'read' ? 1 : 0); await expect(time(page)).toHaveValue('09:00'); await expect(outside(page)).toBeFocused();
    expect(await reads(page)).toBe(kind === 'read' ? 3 : 2);
  });
}

test('a confirmation read cannot repaint a replacement panel after disposal', async ({ page }) => {
  await open(page); await edit(page); await activate(page, 'send'); await release(page, 'send'); await expect.poll(() => reads(page)).toBe(2);
  await page.evaluate(() => window.__overview.remount()); await release(page, 'read', 2); await outside(page).focus();
  await release(page, 'read', 1); await expect(outside(page)).toBeFocused(); await expect(time(page)).toHaveValue('09:00');
  await expect(notice(page)).not.toContainText('Checked.');
});

test('a different confirmation preserves the submitted draft and does not claim it was saved', async ({ page }) => {
  await open(page); await edit(page); await activate(page, 'save');
  await page.evaluate(() => { window.__overview.release('save', 0); window.__overview.setServer({ settings: { frequency: 'off', weekday: 1, time: '09:00', day_of: true } }); });
  await release(page, 'read', 1); await expectDraft(page); await expect(notice(page)).toHaveAttribute('role', 'alert');
  await expect(notice(page)).toContainText('could not be confirmed');
});

test('refresh keeps the sent overview disclosure open and its summary focused', async ({ page }) => {
  await open(page); await activate(page, 'send'); await finish(page, 'send');
  const summary = panel(page).getByText('What it sent', { exact: true }); await summary.click(); await summary.focus();
  await page.evaluate(() => { window.__overview.setServer({ pending: 2 }); window.__overview.refresh(); }); await release(page, 'read', 2);
  await expect(summary).toBeFocused(); await expect(panel(page).locator('details')).toHaveAttribute('open', '');
});

for (const [segment, index, text, expected] of [['hour', 0, '10', '10:30'], ['minute', 1, '45', '09:45']] as const)
  for (const action of ['refresh', 'send', 'validation'] as const) {
    test(`the native ${segment} draft survives ${action} with the other time segments intact`, async ({ page }) => {
      await open(page); const field = time(page);
      const selectSegment = async () => {
        await field.focus(); for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft');
        for (let step = 0; step < index; step++) await page.keyboard.press('ArrowRight');
      };
      await field.fill('09:30'); await selectSegment(); await page.keyboard.press('Backspace');
      expect(await field.evaluate((input: HTMLInputElement) => input.validity.badInput && input.value === '')).toBe(true);
      const original = await field.elementHandle();
      if (action === 'refresh') { await page.evaluate(() => window.__overview.refresh()); await release(page, 'read', 1); }
      else if (action === 'send') { await activate(page, 'send'); await finish(page, 'send'); await selectSegment(); }
      else { await activate(page, 'save'); await expect(field).toBeFocused(); await selectSegment(); }
      expect(await original!.evaluate(input => input.isConnected && document.activeElement === input)).toBe(true);
      expect(await field.evaluate((input: HTMLInputElement) => input.validity.badInput && input.value === '')).toBe(true);
      expect(await changes(page)).toEqual(action === 'send' ? [{ kind: 'send' }] : []);
      await page.keyboard.type(text); await expect(field).toHaveValue(expected); await activate(page, 'save');
      expect((await changes(page)).at(-1)).toEqual({ kind: 'save', settings: { frequency: 'weekly', weekday: 1, time: expected, day_of: true } });
      await finish(page, 'save', 0, action === 'validation' ? 1 : 2); await expect(save(page)).toBeFocused();
    });
  }
