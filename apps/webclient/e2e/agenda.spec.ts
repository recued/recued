import { expect, test, type Page } from '@playwright/test';

/** D-325 §15.7 amendment (2026-11-02, later) — the Agenda card, apart from the Digest's. */
const panel = (page: Page) => page.locator('[data-situation-agenda]');
const on = (page: Page) => panel(page).getByLabel('Send me an agenda', { exact: true });
const often = (page: Page) => panel(page).getByLabel('How often', { exact: true });
const weekday = (page: Page) => panel(page).getByLabel('Day', { exact: true });
const day = (page: Page) => panel(page).getByLabel('Which day', { exact: true });
const days = (page: Page) => panel(page).getByLabel('Which days', { exact: true });
const time = (page: Page) => panel(page).getByLabel('Time', { exact: true });
const save = (page: Page) => panel(page).getByRole('button', { name: 'Save agenda settings', exact: true });
const send = (page: Page) => panel(page).getByRole('button', { name: 'Send now', exact: true });
const notice = (page: Page) => panel(page).locator('[data-agenda-message]');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside panel', exact: true });
const reads = (page: Page) => page.evaluate(() => window.__agenda.calls.filter(call => call.kind === 'read').length);
const changes = (page: Page) => page.evaluate(() => window.__agenda.calls.filter(call => call.kind !== 'read'));
const unsaved = (page: Page) => page.evaluate(() => window.__agenda.hasUnsavedChanges());
const release = (page: Page, kind: 'read' | 'save' | 'send', index = 0, outcome: 'success' | 'error' | 'unsupported' = 'success') =>
  page.evaluate(({ kind, index, outcome }) => window.__agenda.release(kind, index, outcome), { kind, index, outcome });
const activate = async (page: Page, kind: 'save' | 'send') => { await (kind === 'save' ? save(page) : send(page)).focus(); await page.keyboard.press('Enter'); };
const finish = async (page: Page, kind: 'save' | 'send', index = 0, readIndex = 1) => {
  await release(page, kind, index); await expect.poll(() => reads(page)).toBeGreaterThan(readIndex); await release(page, 'read', readIndex);
};
const open = async (page: Page) => {
  await page.goto('/agenda-harness.html'); await page.waitForFunction(() => window.__agenda !== undefined);
  await release(page, 'read'); await expect(time(page)).toHaveValue('07:00');
};
const edit = async (page: Page) => {
  await on(page).check(); await day(page).selectOption('tomorrow'); await time(page).fill('20:30');
};
const draft = { enabled: true, time: '20:30', day: 'tomorrow', frequency: 'daily', weekday: 1 };
const expectDraft = async (page: Page) => {
  await expect(on(page)).toBeChecked(); await expect(day(page)).toHaveValue('tomorrow'); await expect(time(page)).toHaveValue('20:30');
};
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

test('a server without an Agenda shows no card: none while it loads, none once it answers', async ({ page }) => {
  await page.goto('/agenda-harness.html'); await page.waitForFunction(() => window.__agenda !== undefined);
  await expect(panel(page)).toBeHidden();
  await release(page, 'read', 0, 'unsupported'); await expect(panel(page)).toHaveCount(0);
  expect(await changes(page)).toEqual([]);
});

test('a first read that fails shows the card with a way to retry it', async ({ page }) => {
  await page.goto('/agenda-harness.html'); await page.waitForFunction(() => window.__agenda !== undefined);
  await release(page, 'read', 0, 'error'); await expect(notice(page)).toHaveAttribute('role', 'alert');
  await expect(panel(page).locator('[data-agenda-editor]')).toBeHidden();
  const retry = panel(page).getByRole('button', { name: 'Retry agenda settings', exact: true });
  await retry.focus(); await page.keyboard.press('Enter'); await release(page, 'read', 1);
  await expect(time(page)).toHaveValue('07:00'); await expect(retry).toBeHidden(); await expect(save(page)).toBeFocused();
});

for (const width of [390, 1280]) {
  test(`turning it on with a day and a time saves exactly those, and a revert leaves nothing unsaved at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page);
    await expect(on(page)).not.toBeChecked(); await expect(day(page)).toHaveValue('today');
    await expect(panel(page)).toContainText('No agenda has been sent yet.');
    await edit(page); expect(await unsaved(page)).toBe(true);
    await on(page).uncheck(); await day(page).selectOption('today'); await time(page).fill('07:00'); expect(await unsaved(page)).toBe(false);
    await edit(page); await activate(page, 'save'); await expect(time(page)).toBeDisabled(); await expect(notice(page)).toBeFocused();
    await finish(page, 'save'); await expect(notice(page)).toHaveText('Agenda settings saved.'); await expect(save(page)).toBeFocused();
    await expectDraft(page); expect(await unsaved(page)).toBe(false);
    expect(await changes(page)).toEqual([{ kind: 'save', settings: draft }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('Send now shows what it sent and keeps every edit for Save', async ({ page }) => {
  await open(page); await edit(page); await activate(page, 'send');
  await finish(page, 'send'); await expect(notice(page)).toHaveText('Checked. An agenda is sent only when something is on.');
  await expectDraft(page); expect(await unsaved(page)).toBe(true); await expect(send(page)).toBeFocused();
  await expect(panel(page)).toContainText('· Send now · Sent');
  await panel(page).getByText('What it sent', { exact: true }).click(); await expect(panel(page).locator('.sd-sent')).toHaveText('06:00 Wake up\n06:30 Jogging');
  expect(await changes(page)).toEqual([{ kind: 'send' }]);
});

test('an untouched card adopts the server’s settings, and an edited one keeps its draft through a refresh', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.__agenda.setServer({ settings: { enabled: true, time: '06:15', day: 'today', frequency: 'daily', weekday: 1 } });
    window.__agenda.refresh();
  });
  await release(page, 'read', 1); await expect(on(page)).toBeChecked(); await expect(time(page)).toHaveValue('06:15');
  expect(await unsaved(page)).toBe(false);
  await day(page).selectOption('tomorrow');
  await page.evaluate(() => {
    window.__agenda.setServer({ settings: { enabled: false, time: '05:00', day: 'today', frequency: 'daily', weekday: 1 }, pending: 1 });
    window.__agenda.refresh();
  });
  await release(page, 'read', 2); await expect(day(page)).toHaveValue('tomorrow'); await expect(on(page)).toBeChecked();
  await expect(panel(page)).toContainText('1 agenda is waiting to be sent.'); expect(await unsaved(page)).toBe(true);
  expect(await changes(page)).toEqual([]);
});

test('a failed save keeps the draft, says so, and saves the same settings again', async ({ page }) => {
  await open(page); await edit(page); await activate(page, 'save'); await release(page, 'save', 0, 'error');
  await expect(notice(page)).toHaveAttribute('role', 'alert'); await expect(notice(page)).toHaveText('Could not save the agenda. Try again.');
  await expectDraft(page); await expect(save(page)).toBeFocused(); expect(await unsaved(page)).toBe(true);
  await page.keyboard.press('Enter'); await finish(page, 'save', 1); await expect(notice(page)).toHaveText('Agenda settings saved.');
  expect(await changes(page)).toEqual([{ kind: 'save', settings: draft }, { kind: 'save', settings: draft }]);
});

test('a save the server does not confirm keeps the draft and does not claim it was saved', async ({ page }) => {
  await open(page); await edit(page); await activate(page, 'save');
  await page.evaluate(() => {
    window.__agenda.release('save', 0);
    window.__agenda.setServer({ settings: { enabled: false, time: '07:00', day: 'today', frequency: 'daily', weekday: 1 } });
  });
  await release(page, 'read', 1); await expectDraft(page); await expect(notice(page)).toHaveAttribute('role', 'alert');
  await expect(notice(page)).toContainText('could not be confirmed');
});

test('a work in flight is reported, and a late reply does not reclaim focus after the owner moved on', async ({ page }) => {
  await open(page); await edit(page); await activate(page, 'save');
  expect(await page.evaluate(() => window.__agenda.hasInFlightWork())).toBe(true);
  await outside(page).focus(); await finish(page, 'save');
  await expect(outside(page)).toBeFocused(); expect(await page.evaluate(() => window.__agenda.hasInFlightWork())).toBe(false);
});

test('the card says when the next agenda goes, in the server’s zone', async ({ page }) => {
  await open(page); await expect(panel(page).locator('[data-agenda-next]')).toHaveCount(0);
  // 07:00 UTC on Monday 28 October 2030 is 08:00 in Paris.
  await page.evaluate(() => {
    window.__agenda.setServer({ settings: { enabled: true, time: '08:00', day: 'today', frequency: 'daily', weekday: 1 },
      next_at: Date.parse('2030-10-28T07:00:00Z'), time_zone: 'Europe/Paris' });
    window.__agenda.refresh();
  });
  await release(page, 'read', 1);
  const expected = await page.evaluate(() => new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit',
    minute: '2-digit', timeZone: 'Europe/Paris' }).format(Date.parse('2030-10-28T07:00:00Z')));
  await expect(panel(page).locator('[data-agenda-next]')).toHaveText(`Next agenda: ${expected}`); expect(expected).toContain('08:00');
});

// §15.7 amendment (2026-11-03): the owner, "perhaps agenda can be weekly as well for user to choose between daily & weekly".
for (const width of [390, 1280]) {
  test(`Weekly shows its day, names the seven days it lists, and saves them at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page);
    await expect(often(page)).toHaveValue('daily'); await expect(weekday(page)).toBeHidden();
    await expect(panel(page).locator('[data-agenda-week-hint]')).toBeHidden();
    await on(page).check(); await often(page).selectOption('weekly');
    await expect(weekday(page)).toHaveValue('1'); await expect(days(page)).toHaveValue('today');
    await expect(days(page).locator('option')).toHaveText(['Monday to Sunday', 'Tuesday to Monday']);
    await weekday(page).selectOption('7'); await expect(days(page).locator('option')).toHaveText(['Sunday to Saturday', 'Monday to Sunday']);
    await days(page).selectOption('tomorrow'); await time(page).fill('18:00');
    await expect(panel(page).locator('[data-agenda-week-hint]')).toBeVisible(); await expect(panel(page).locator('.sd-lede')).toHaveText(/^Your day or your week/u);
    await activate(page, 'save'); await finish(page, 'save'); await expect(notice(page)).toHaveText('Agenda settings saved.');
    expect(await unsaved(page)).toBe(false);
    expect(await changes(page)).toEqual([{ kind: 'save', settings: { enabled: true, time: '18:00', day: 'tomorrow', frequency: 'weekly', weekday: 7 } }]);
    // Back to Daily: the Day goes, and the same choice reads Tomorrow again.
    await often(page).selectOption('daily'); await expect(weekday(page)).toBeHidden();
    await expect(day(page).locator('option')).toHaveText(['Today', 'Tomorrow']); await expect(day(page)).toHaveValue('tomorrow');
    expect(await unsaved(page)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('a server whose Agenda is daily only offers no week, and a save leaves the week out', async ({ page }) => {
  await page.goto('/agenda-harness.html'); await page.waitForFunction(() => window.__agenda !== undefined);
  await page.evaluate(() => { window.__agenda.setServer({ settings: { enabled: false, time: '07:00', day: 'today' } }); window.__agenda.remount(); });
  await release(page, 'read', 1); await expect(time(page)).toHaveValue('07:00');
  await expect(often(page)).toBeHidden(); await expect(weekday(page)).toBeHidden();
  await expect(panel(page).locator('.sd-lede')).toHaveText(/^Your day in time order/u);
  await edit(page); await activate(page, 'save'); await finish(page, 'save', 0, 2); await expect(notice(page)).toHaveText('Agenda settings saved.');
  expect(await changes(page)).toEqual([{ kind: 'save', settings: { enabled: true, time: '20:30', day: 'tomorrow' } }]);
});
