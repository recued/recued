import { expect, test, type Page } from '@playwright/test';
import type { ReminderView } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installReminderWorkspaceFixture, REMINDER_WORKSPACE_NOW } from './helpers/reminder-workspace-fixture.js';

installFullAppHooks();
test.use({ timezoneId: 'Asia/Tokyo' });
const row = (page: Page) => page.locator('.reminders-list[aria-label] .reminders-row[data-reminder-id="rem-edit"]');
const field = (page: Page, name: string) => row(page).locator(`[data-recued-reminders-field="${name}"]`);
const savedAt = Date.parse('2030-11-03T06:30:12.345Z');

const boot = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    let reminder: ReminderView = { reminder_id: 'rem-edit', text: 'Call the dentist',
      at: Date.parse('2030-11-03T06:30:12.345Z'), when: 'Sunday 3 November at 1:30 AM', time_zone: 'America/New_York', state: 'pending', delivered_at: null };
    const managed: ReminderView = { ...reminder, reminder_id: 'rem-clock', text: 'Annual boiler inspection', managed_by: 'clock' };
    let failRead = false, holdRead = false, hold = false;
    let releaseRead: (() => void) | undefined;
    let release: (() => void) | undefined;
    let next: 'success' | 'error' | 'delivered' = 'success';
    const writes: Array<{ reminder_id: string; text?: string; at?: number }> = [];
    Object.assign(window, { __reminderEdit: { writes,
      holdNextWrite() { hold = true; }, releaseWrite() { if (!release) throw new Error('No reminder write is waiting.'); const done = release; release = undefined; done(); },
      holdNextRead() { holdRead = true; }, releaseRead() { if (!releaseRead) throw new Error('No reminder read is waiting.'); const done = releaseRead; releaseRead = undefined; done(); },
      failNextRead() { failRead = true; }, nextOutcome(value: typeof next) { next = value; }, saved: () => structuredClone(reminder),
    }, __connectionsFixture: async (method: string, raw: unknown) => {
      if (method === 'reminder.list') {
        if (holdRead) { holdRead = false; await new Promise<void>(done => { releaseRead = done; }); }
        if (failRead) { failRead = false; return { error: { code: 'unavailable', message: 'The reminder refresh was interrupted.' } }; }
        const pending = [managed, ...(reminder.state === 'pending' ? [reminder] : [])];
        return { result: { reminders: structuredClone(pending), count: pending.length,
          delivered: reminder.state === 'pending' ? [] : [structuredClone(reminder)] } };
      }
      if (method === 'reminder.update') {
        const patch = structuredClone(raw) as { reminder_id: string; text?: string; at?: number };
        writes.push(patch);
        if (hold) { hold = false; await new Promise<void>(done => { release = done; }); }
        const outcome = next; next = 'success';
        if (outcome === 'error') return { error: { code: 'unavailable', message: 'The reminder save was interrupted.' } };
        if (outcome === 'delivered') {
          reminder = { ...reminder, state: 'delivered', delivered_at: Date.now() };
          return { result: { updated: false, reason: 'not_pending', reminder: structuredClone(reminder), message: 'Not changed: that reminder has already rung.' } };
        }
        reminder = { ...reminder, ...patch };
        return { result: { updated: true, reminder: structuredClone(reminder), message: 'Reminder changed.' } };
      }
      return undefined;
    } });
  });
  await page.goto(`${HARNESS_URL}?journey=verification#data/reminder`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(row(page)).toContainText('Call the dentist');
};

test('changes only the wording, keeps the exact repeated-hour instant, and retains the confirmed edit after a failed refresh', async ({ page }) => {
  await boot(page);
  await row(page).getByRole('button', { name: 'Edit reminder', exact: true }).click();
  await expect(field(page, 'text')).toBeFocused();
  await expect(field(page, 'at')).toHaveValue('2030-11-03T01:30');
  await field(page, 'text').fill('Call Dr Patel about the invoice');
  await page.evaluate(() => { window.__reminderEdit.holdNextWrite(); window.__reminderEdit.holdNextRead(); window.__reminderEdit.failNextRead(); });
  await row(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(field(page, 'text')).toBeDisabled(); await expect(field(page, 'at')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__reminderEdit.writes.length)).toBe(1);
  expect(await page.evaluate(() => window.__reminderEdit.writes)).toEqual([{ reminder_id: 'rem-edit', text: 'Call Dr Patel about the invoice' }]);
  await page.evaluate(() => window.__reminderEdit.releaseWrite());
  await expect(row(page)).toContainText('Call Dr Patel about the invoice');
  await expect(row(page).getByRole('button', { name: 'Edit reminder', exact: true })).toBeFocused();
  await expect(page.locator('[data-recued-reminders-focus="notice"]')).toHaveText('Reminder changed.');
  await page.evaluate(() => window.__reminderEdit.releaseRead());
  await expect(page.getByRole('alert')).toContainText('refresh was interrupted');
  expect(await page.evaluate(() => window.__reminderEdit.saved().at)).toBe(savedAt);
});

test('keeps both fields on interruption, then reports a reminder that rang before retrying could save', async ({ page }) => {
  await boot(page);
  await row(page).getByRole('button', { name: 'Edit reminder', exact: true }).click();
  await field(page, 'text').fill('Ask about the invoice');
  await field(page, 'at').fill('2030-11-04T09:15');
  await page.evaluate(() => window.__reminderEdit.nextOutcome('error'));
  await row(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('save was interrupted');
  await expect(field(page, 'text')).toHaveValue('Ask about the invoice');
  await expect(field(page, 'at')).toHaveValue('2030-11-04T09:15');
  await expect(field(page, 'text')).toBeFocused();
  expect(await page.evaluate(() => window.__reminderEdit.writes[0])).toEqual({ reminder_id: 'rem-edit', text: 'Ask about the invoice', at: Date.parse('2030-11-04T14:15:00Z') });
  await page.evaluate(() => window.__reminderEdit.nextOutcome('delivered'));
  await row(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('[data-recued-reminders-focus="notice"]')).toContainText('already rung');
  await expect(row(page)).toHaveCount(0);
  await page.locator('.reminders-history summary').click();
  await expect(page.locator('.reminders-history [data-reminder-id="rem-edit"]')).toContainText('Rang');
  expect(await page.evaluate(() => window.__reminderEdit.saved().text)).toBe('Call the dentist');
});

test('offers schedule management for Yours reminders and lets a phone user discard unsaved wording', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const clock = page.locator('.reminders-row[data-reminder-id="rem-clock"]');
  await expect(clock.getByRole('link', { name: 'Manage in Yours' })).toHaveAttribute('href', '#yours');
  await expect(clock.getByRole('button')).toHaveCount(0);
  await row(page).getByRole('button', { name: 'Edit reminder', exact: true }).click();
  await field(page, 'text').fill('');
  await row(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter what this reminder should say');
  await expect(field(page, 'text')).toBeFocused();
  expect(await page.evaluate(() => window.__reminderEdit.writes)).toEqual([]);
  await field(page, 'text').fill('Words to discard');
  await row(page).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(row(page).getByRole('button', { name: 'Edit reminder', exact: true })).toBeFocused();
  await expect(row(page)).toContainText('Call the dentist');
  await expect(field(page, 'text')).toHaveCount(0);
});

test('browses reminders past 200 and searches the complete waiting list with date filters', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));
  const fixture = await installReminderWorkspaceFixture(page);
  try {
    await page.goto(`${HARNESS_URL}?journey=verification#data/reminder`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const host = page.locator('[data-recued-reminders]');
    const items = host.getByRole('list', { name: 'Reminders still to ring' }).getByRole('listitem');
    await expect(items).toHaveCount(50);
    for (const count of [100, 150, 200, 235]) {
      const previousCount = await items.count();
      await host.getByRole('button', { name: 'Load more', exact: true }).click();
      await expect(items).toHaveCount(count);
      await expect(items.nth(previousCount)).toBeFocused();
      await expect(items.nth(previousCount)).toBeInViewport();
    }
    await expect(host.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
    const search = host.getByRole('searchbox', { name: 'Search reminders', exact: true });
    await search.fill('Meter check 220');
    await search.press('Enter');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Meter check 220');
    await expect(items.first()).toContainText('Managed in Yours');
    await expect(items.first().getByRole('button', { name: 'Edit reminder', exact: true })).toHaveCount(0);
    await host.getByRole('combobox', { name: 'Dates', exact: true }).selectOption('today');
    await host.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(host).toContainText('No waiting reminders match these filters.');
    const todayRead = fixture.reads.at(-1)!.page!;
    expect(todayRead).toMatchObject({ query: 'Meter check 220',
      from: Date.parse('2026-11-01T04:00:00Z'), before: Date.parse('2026-11-02T05:00:00Z') });
    await host.getByRole('combobox', { name: 'Dates', exact: true }).selectOption('custom');
    await host.getByLabel('From', { exact: true }).fill('2026-11-10');
    await host.getByLabel('Through', { exact: true }).fill('2026-11-10');
    await host.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(items).toHaveCount(1);
    await search.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('reminders-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await host.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(items).toHaveCount(50);
    fixture.holdNextQuery('Manual follow up');
    await search.fill('Manual follow up');
    await search.press('Enter');
    await expect.poll(() => fixture.readPending()).toBe(true);
    await search.fill('Meter check 220');
    await search.press('Enter');
    await expect(items).toHaveCount(1);
    fixture.releaseRead();
    await expect(items.first()).toContainText('Meter check 220');
    await search.fill('Manual follow up 0');
    await search.press('Enter');
    await expect(items).toHaveCount(1);
    await items.first().getByRole('button', { name: 'Edit reminder', exact: true }).click();
    const text = items.first().locator('[data-recued-reminders-field="text"]');
    await text.fill('Keep this pending draft');
    await host.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(text).toHaveValue('Keep this pending draft');
    await expect(host).toContainText('Save or discard your reminder changes');
    await items.first().getByRole('button', { name: 'Discard changes', exact: true }).click();
    await host.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(items).toHaveCount(50);
    await search.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('reminders-mobile.png') });
  } finally { fixture.dispose(); }
});

test('creates a reminder in Data, reconciles a lost reply and retains the result through a failed refresh', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));
  const fixture = await installReminderWorkspaceFixture(page, true);
  try {
    await page.goto(`${HARNESS_URL}?journey=verification#data/reminder`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const host = page.locator('[data-recued-reminders]');
    await host.getByRole('button', { name: 'New reminder', exact: true }).click();
    const form = host.locator('[data-reminder-create-form]');
    await expect(form.getByRole('textbox', { name: 'Reminder', exact: true })).toBeFocused();
    await form.getByRole('textbox', { name: 'Reminder', exact: true }).fill('Collect the pharmacy order');
    await form.getByLabel('Date and time (America/New_York)', { exact: true }).fill('2026-11-01T23:00');
    await page.screenshot({ path: testInfo.outputPath('reminder-create-mobile.png') });
    page.once('dialog', dialog => { void dialog.dismiss(); });
    await page.evaluate(() => window.__app.setHash('#chat'));
    await expect(form.getByRole('textbox', { name: 'Reminder', exact: true })).toHaveValue('Collect the pharmacy order');
    fixture.loseNextCreate();
    await form.getByRole('button', { name: 'Set reminder', exact: true }).click();
    await expect(form.getByRole('alert')).toBeVisible();
    await expect(form.getByRole('button', { name: 'Set reminder', exact: true })).toBeFocused();
    expect(fixture.pendingCount()).toBe(1);
    fixture.failNextRead();
    fixture.holdNextCreate();
    await page.keyboard.press('Enter');
    await expect.poll(() => fixture.createPending()).toBe(true);
    const refresh = host.getByRole('button', { name: 'Refresh', exact: true });
    await refresh.focus();
    fixture.releaseCreate();
    await expect(form).toHaveCount(0);
    const notice = host.locator('[data-recued-reminders-focus="notice"]');
    await expect(notice).toContainText('quiet hours');
    await expect(refresh).toBeFocused();
    await expect(host.getByRole('alert')).toContainText('refresh was interrupted');
    const items = host.getByRole('list', { name: 'Reminders still to ring' }).getByRole('listitem');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Collect the pharmacy order');
    expect(fixture.creates).toHaveLength(2);
    expect(fixture.creates[1]).toEqual(fixture.creates[0]);
    expect(fixture.creates[0]?.at).toBe(Date.parse('2026-11-02T04:00:00Z'));
    await host.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(host.getByRole('alert')).toHaveCount(0);
    await expect(items).toHaveCount(1);
    await items.first().getByRole('button', { name: 'Cancel', exact: true }).click();
    await items.first().getByRole('button', { name: 'Cancel it', exact: true }).click();
    await expect(host).toContainText('Cancelled: it will not ring.');
    expect(fixture.pendingCount()).toBe(0);
    await host.locator('.reminders-history summary').click();
    await expect(host.locator('.reminders-history')).toContainText('Collect the pharmacy order');
    await expect(host.locator('.reminders-history')).toContainText('Cancelled');
    await host.getByRole('button', { name: 'New reminder', exact: true }).click();
    await form.getByRole('textbox', { name: 'Reminder', exact: true }).fill('Already withdrawn reminder');
    await form.getByLabel('Date and time (America/New_York)', { exact: true }).fill('2026-11-02T23:00');
    fixture.loseNextCreate();
    fixture.holdNextCreate();
    await form.getByRole('button', { name: 'Set reminder', exact: true }).click();
    await expect.poll(() => fixture.createPending()).toBe(true);
    await refresh.focus();
    fixture.releaseCreate();
    await expect(form.getByRole('alert')).toBeVisible();
    await expect(refresh).toBeFocused();
    await fixture.cancelLatestCreated();
    fixture.failNextRead();
    await form.getByRole('button', { name: 'Set reminder', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(notice).toContainText('Reminder history');
    await expect(notice).toContainText('not been scheduled again');
    await expect(notice).toBeFocused();
    await expect(host.locator('.reminders-history')).toContainText('Already withdrawn reminder');
    expect(fixture.pendingCount()).toBe(0);
  } finally { fixture.dispose(); }
});

declare global { interface Window { __reminderEdit: {
  writes: Array<{ reminder_id: string; text?: string; at?: number }>;
  holdNextWrite(): void; releaseWrite(): void; holdNextRead(): void; releaseRead(): void; failNextRead(): void;
  nextOutcome(outcome: 'success' | 'error' | 'delivered'): void; saved(): ReminderView;
} } }
