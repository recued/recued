import { expect, test, type Page } from '@playwright/test';

/** D-343 slice 4 (ruling 19) — the Close the day card, under the Agenda's in Settings. */
const panel = (page: Page) => page.locator('[data-situation-close-day]');
const on = (page: Page) => panel(page).getByLabel('Ask me each evening what I did', { exact: true });
const time = (page: Page) => panel(page).getByLabel('Time', { exact: true });
const save = (page: Page) => panel(page).getByRole('button', { name: 'Save', exact: true });
const send = (page: Page) => panel(page).getByRole('button', { name: 'Send now', exact: true });
const notice = (page: Page) => panel(page).locator('[data-close-day-message]');
const reads = (page: Page) => page.evaluate(() => window.__closeDay.calls.filter(call => call.kind === 'read').length);
const changes = (page: Page) => page.evaluate(() => window.__closeDay.calls.filter(call => call.kind !== 'read'));
const unsaved = (page: Page) => page.evaluate(() => window.__closeDay.hasUnsavedChanges());
const release = (page: Page, kind: 'read' | 'save' | 'send' | 'retry' | 'review', index = 0, outcome: 'success' | 'error' | 'unsupported' | 'unnamed' = 'success') =>
  page.evaluate(({ kind, index, outcome }) => window.__closeDay.release(kind, index, outcome), { kind, index, outcome });
const goto = async (page: Page) => { await page.goto('/close-day-harness.html'); await page.waitForFunction(() => window.__closeDay !== undefined); };
const open = async (page: Page) => { await goto(page); await release(page, 'read'); await expect(time(page)).toHaveValue('21:00'); };
const finish = async (page: Page, kind: 'save' | 'send', readIndex = 1) => {
  await release(page, kind); await expect.poll(() => reads(page)).toBeGreaterThan(readIndex); await release(page, 'read', readIndex);
};
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

test('a server that names no Close the day shows no card, whether it has an Agenda or none', async ({ page }) => {
  await goto(page);
  await expect(panel(page)).toBeHidden();
  await release(page, 'read', 0, 'unnamed'); await expect(panel(page)).toHaveCount(0);
  await goto(page);
  await release(page, 'read', 0, 'unsupported'); await expect(panel(page)).toHaveCount(0);
  expect(await changes(page)).toEqual([]);
});

for (const width of [390, 1280]) {
  test(`off at 21:00 until turned on; it saves exactly that, and a revert leaves nothing unsaved at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page);
    await expect(on(page)).not.toBeChecked(); await expect(panel(page)).toContainText('Nothing has been sent yet.');
    await on(page).check(); await time(page).fill('21:30'); expect(await unsaved(page)).toBe(true);
    await on(page).uncheck(); await time(page).fill('21:00'); expect(await unsaved(page)).toBe(false);
    await on(page).check(); await time(page).fill('21:30');
    await save(page).focus(); await page.keyboard.press('Enter'); await expect(time(page)).toBeDisabled();
    await finish(page, 'save'); await expect(notice(page)).toHaveText('Close the day saved.');
    await expect(on(page)).toBeChecked(); await expect(time(page)).toHaveValue('21:30'); expect(await unsaved(page)).toBe(false);
    expect(await changes(page)).toEqual([{ kind: 'save', settings: { enabled: true, time: '21:30' } }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('Send now shows what it sent, and keeps an edit for Save', async ({ page }) => {
  await open(page); await time(page).fill('22:00');
  await send(page).focus(); await page.keyboard.press('Enter');
  await finish(page, 'send'); await expect(notice(page)).toHaveText('Sent. Reply to it with what you did.');
  await expect(time(page)).toHaveValue('22:00'); expect(await unsaved(page)).toBe(true);
  await expect(panel(page)).toContainText('· Send now · Sent');
  await panel(page).getByText('What it sent', { exact: true }).click();
  await expect(panel(page).locator('.sd-sent')).toHaveText('07:00 Run 5 km\n18:00 Spanish lesson\n\nPursuit: Learn Spanish\n\nReply to this with what you did.');
  expect(await changes(page)).toEqual([{ kind: 'send' }]);
});

test('a save the server does not keep says so and keeps the edit', async ({ page }) => {
  await open(page); await page.evaluate(() => window.__closeDay.dropNextSave());
  await on(page).check(); await save(page).click(); await finish(page, 'save');
  await expect(notice(page)).toHaveText('The settings could not be confirmed. Your edits are still here. Try saving again.');
  await expect(notice(page)).toHaveAttribute('role', 'alert');
  await expect(on(page)).toBeChecked(); expect(await unsaved(page)).toBe(true);
});

test('a first read that fails shows the card with a way to retry it', async ({ page }) => {
  await goto(page); await release(page, 'read', 0, 'error');
  await expect(notice(page)).toHaveAttribute('role', 'alert');
  const retry = panel(page).getByRole('button', { name: 'Retry', exact: true });
  await retry.click(); await release(page, 'read', 1); await expect(time(page)).toHaveValue('21:00'); await expect(retry).toBeHidden();
});

test('an email handoff retries in place, retains a draft through a failed refresh, and lets an older unknown reply be marked reviewed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 }); await open(page);
  await page.evaluate(() => {
    window.__closeDay.setEmailReplies([
      { id: 'reply-1', received_at: Date.parse('2026-11-14T20:00:00Z'), reason: 'retry', session_id: 'chat/1', retry_available: true },
      { id: 'old-reply', received_at: Date.parse('2026-11-13T20:00:00Z'), reason: 'unknown', retry_available: false },
    ]);
    window.__closeDay.refresh();
  });
  await release(page, 'read', 1);
  const email = panel(page).locator('[data-close-day-email-replies]');
  await expect(email).toContainText('Your reply is saved; Recued will try again.');
  await expect(email.getByRole('link', { name: 'Open conversation' })).toHaveAttribute('href', '#chat/session/chat%2F1');
  await expect(email.getByRole('button', { name: 'Try opening in Chat' })).toHaveCount(1);
  await time(page).fill('22:30');
  const retry = email.getByRole('button', { name: 'Try opening in Chat' });
  await retry.focus(); await page.keyboard.press('Enter');
  await expect(retry).toBeDisabled(); await expect(notice(page)).toBeFocused();
  await release(page, 'retry');
  await expect.poll(() => reads(page)).toBe(3);
  await release(page, 'read', 2, 'error');
  await expect(notice(page)).toHaveText('Read interrupted.');
  await expect(time(page)).toHaveValue('22:30'); expect(await unsaved(page)).toBe(true);
  await panel(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await release(page, 'read', 3);
  await expect(retry).toHaveCount(0);
  const reviewed = email.getByRole('button', { name: 'Mark reviewed' });
  await reviewed.focus(); await page.keyboard.press('Enter');
  await release(page, 'review'); await expect.poll(() => reads(page)).toBe(5); await release(page, 'read', 4);
  await expect(notice(page)).toHaveText('Earlier email reply marked reviewed.');
  await expect(notice(page)).toBeFocused(); await expect(email).toBeEmpty();
  await expect(time(page)).toHaveValue('22:30');
  expect(await changes(page)).toEqual([{ kind: 'retry', reply_id: 'reply-1' }, { kind: 'review', reply_id: 'old-reply' }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
