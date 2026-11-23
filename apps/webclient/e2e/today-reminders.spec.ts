import { expect, test, type Page } from '@playwright/test';
import { reminderDetailLink } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskReaderFixture } from './helpers/task-reader-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
const NOW = Date.parse('2026-10-31T18:00:00Z'), DAY = 86400_000;
type Fixture = Awaited<ReturnType<typeof installTaskReaderFixture>>;
const panel = (page: Page) => page.locator('[data-today-reminders]');
const row = (page: Page, id: string) => panel(page).locator(`[data-today-reminder-row="${id}"]`);
const boot = async (page: Page, prepare: (f: Fixture) => void) => {
  const f = await installTaskReaderFixture(page, { reminders: true });
  f.fixtureCaller((method) => method === 'yours.today'
    ? { error: { code: 'unknown_method', message: 'Yours is absent from this saved-record fixture.' } }
    : method === 'yours.spheres' ? { result: { placements: [] } } : undefined);
  prepare(f);
  await page.goto(`${HARNESS_URL}?journey=verification#today`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
  return f;
};

test('shows due, today and upcoming one-off reminders in their own clocks, pages past managed reminders and keeps confirmed rows on refresh failure', async ({ page }, info) => {
  let due = '', today = '', upcoming = '';
  const f = await boot(page, f => {
    for (let i = 0; i < 105; i++) f.seedReminder({ text: 'Managed clock ' + i, at: NOW - 3600_000 + i, managed: true });
    due = f.seedReminder({ text: 'Due <now> & call', at: NOW - 30_000 });
    today = f.seedReminder({ text: 'Collect the paperwork', at: NOW + 3600_000 });
    upcoming = f.seedReminder({ text: 'Review the renewal', at: NOW + 2 * DAY });
    f.seedReminder({ text: 'Outside this window', at: NOW + 20 * DAY });
    f.seedReminder({ text: 'Already rang', at: NOW - 60_000, state: 'delivered' });
    f.seedReminder({ text: 'Already cancelled', at: NOW + 60_000, state: 'cancelled' });
  });
  try {
    await expect(panel(page).locator('[data-today-reminder-group="now"]')).toContainText('Due <now> & call');
    await expect(panel(page).locator('[data-today-reminder-group="today"]')).toContainText('Collect the paperwork');
    await expect(panel(page).locator('[data-today-reminder-group="next"]')).toContainText('Review the renewal');
    await expect(panel(page).locator('[data-today-reminder-row]')).toHaveCount(3);
    await expect(row(page, today)).toContainText('America/Los_Angeles');
    await expect(row(page, today)).toContainText('12:00 PM');
    f.failReminderPages(true);
    await panel(page).getByRole('button', { name: 'Refresh reminders', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toContainText('later reminder page was interrupted');
    await expect(row(page, due)).toBeVisible(); await expect(row(page, upcoming)).toBeVisible();
    f.failReminderPages(false);
    await panel(page).getByRole('button', { name: 'Refresh reminders', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    await panel(page).screenshot({ path: info.outputPath('today-reminders-phone.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await panel(page).screenshot({ path: info.outputPath('today-reminders-phone-dark.png') });
    expect(f.reminderWrites).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('moves on the reminder clock across DST and reconciles a lost reply without moving it a second time', async ({ page }) => {
  let id = '';
  const f = await boot(page, f => { id = f.seedReminder({ text: 'Review the task', at: NOW + 60_000 }); });
  try {
    const original = structuredClone(f.task());
    f.loseReminderUpdate();
    await row(page, id).getByRole('button', { name: 'Tomorrow at 9am', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toContainText('move reply was lost');
    expect(f.reminder(id)?.at).toBe(Date.parse('2026-11-01T17:00:00Z'));
    await page.clock.setFixedTime(new Date(NOW + 300_000));
    await row(page, id).getByRole('button', { name: 'Tomorrow at 9am', exact: true }).click();
    await expect(panel(page).getByRole('status').filter({ hasText: 'Reminder moved' })).toBeVisible();
    expect(f.reminderWrites).toHaveLength(1);
    await row(page, id).getByRole('button', { name: 'In 15 minutes', exact: true }).click();
    await expect.poll(() => f.reminder(id)?.at).toBe(NOW + 300_000 + 900_000);
    await row(page, id).getByRole('button', { name: 'In 1 hour', exact: true }).click();
    await expect.poll(() => f.reminder(id)?.at).toBe(NOW + 300_000 + 3600_000);
    expect(f.task()).toEqual(original); expect(f.writes).toEqual([]); expect(f.reminderRequests).toEqual([]);
  } finally { f.dispose(); }
});

test('confirms cancellation, keeps it on Keep, and reconciles a lost cancellation reply', async ({ page }) => {
  let id = '';
  const f = await boot(page, f => { id = f.seedReminder({ text: 'Call the office', at: NOW + 60_000 }); });
  try {
    await row(page, id).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(row(page, id).getByRole('button', { name: 'Cancel reminder', exact: true })).toBeFocused();
    await row(page, id).getByRole('button', { name: 'Keep reminder', exact: true }).click();
    await expect(row(page, id).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    expect(f.reminderWrites).toEqual([]);
    await row(page, id).getByRole('button', { name: 'Cancel', exact: true }).click();
    f.loseReminderCancel();
    await row(page, id).getByRole('button', { name: 'Cancel reminder', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toContainText('cancellation reply was lost');
    await row(page, id).getByRole('button', { name: 'Cancel reminder', exact: true }).click();
    await expect(row(page, id)).toHaveCount(0);
    await expect(panel(page).locator('[data-today-reminder-focus="notice"]')).toContainText('already cancelled');
    await expect(panel(page).locator('[data-today-reminder-focus="notice"]')).toBeFocused();
    expect(f.reminderWrites.filter(row => row.method === 'reminder.cancel')).toHaveLength(1);
  } finally { f.dispose(); }
});

test('a refresh that confirms a lost move lets a later click set a new relative time', async ({ page }) => {
  let id = '';
  const f = await boot(page, f => { id = f.seedReminder({ text: 'Review again', at: NOW + 60_000 }); });
  try {
    f.loseReminderUpdate();
    await row(page, id).getByRole('button', { name: 'In 1 hour', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toContainText('move reply was lost');
    await page.clock.setFixedTime(new Date(NOW + 600_000));
    await panel(page).getByRole('button', { name: 'Refresh reminders', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
    await row(page, id).getByRole('button', { name: 'In 1 hour', exact: true }).click();
    await expect.poll(() => f.reminder(id)?.at).toBe(NOW + 600_000 + 3600_000);
    expect(f.reminderWrites).toHaveLength(2);
  } finally { f.dispose(); }
});

test('rechecks a reminder that rang, protects a task draft, and serializes a move in flight', async ({ page }) => {
  let id = '', second = '';
  const f = await boot(page, f => {
    id = f.seedReminder({ text: 'Stale reminder', at: NOW + 60_000 });
    second = f.seedReminder({ text: 'Another reminder', at: NOW + 120_000 });
  });
  try {
    await page.getByRole('button', { name: 'Reschedule Plan launch <img src=x>', exact: true }).click();
    await page.getByLabel('New due date and time', { exact: true }).fill('2026-11-04T09:30');
    const input = await page.getByLabel('New due date and time', { exact: true }).elementHandle();
    await row(page, id).getByRole('button', { name: 'In 1 hour', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toContainText('Finish or cancel');
    expect(await input!.evaluate(node => node.isConnected)).toBe(true);
    await expect(page.getByLabel('New due date and time', { exact: true })).toHaveValue('2026-11-04T09:30');
    await page.locator('[data-today-task-editor]').getByRole('button', { name: 'Cancel', exact: true }).click();
    f.deliverReminder(id);
    await row(page, id).getByRole('button', { name: 'In 1 hour', exact: true }).click();
    await expect(row(page, id)).toHaveCount(0);
    await expect(panel(page).getByRole('alert')).toBeFocused();
    expect(f.reminderWrites).toEqual([]);
    f.hold('reminder.update', second);
    await row(page, second).getByRole('button', { name: 'In 1 hour', exact: true }).click();
    await expect.poll(() => f.waiting()).toBe(true);
    await expect(row(page, second).getByRole('button', { name: 'Cancel', exact: true })).toHaveAttribute('aria-disabled', 'true');
    f.release();
    await expect.poll(() => f.reminderWrites.length).toBe(1);
    await expect(row(page, second).getByRole('button', { name: 'In 1 hour', exact: true })).toBeFocused();
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('opens the exact reminder and linked task, returns through both, and restores Today view state and focus', async ({ page }) => {
  let id = '';
  const f = await boot(page, f => {
    const task = f.task();
    id = f.seedReminder({ text: 'Follow up on launch', at: NOW + 3600_000, record_ref: {
      kind: 'task', id: task.id, source_id: task.source_id, source_record_id: task.source_record_id ?? null, created_at: task.created_at,
    } });
  });
  try {
    await page.evaluate(() => window.__app.setHash('#data/today'));
    await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
    await page.locator('[data-today-sphere]').selectOption('professional');
    await expect(page.locator('[data-today-empty]')).toHaveCount(0);
    await row(page, id).getByRole('link', { name: 'Follow up on launch', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(reminderDetailLink(id) + '$'));
    await page.goBack();
    await expect(page).toHaveURL(/#data\/today$/);
    await expect(row(page, id).getByRole('link')).toBeFocused();
    await expect(page.locator('[data-today-sphere]')).toHaveValue('professional');
    await row(page, id).getByRole('link').click();
    await page.locator('.reminders-detail').getByRole('button', { name: 'Open task', exact: true }).click();
    await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Back to reminder', exact: true }).click();
    await page.locator('[data-recued-reminders]').getByRole('button', { name: 'Back to Today', exact: true }).click();
    await expect(row(page, id).getByRole('link')).toBeFocused();
    await expect(page.locator('[data-today-sphere]')).toHaveValue('professional');
    await row(page, id).getByRole('link').click();
    await page.goBack();
    await expect(row(page, id).getByRole('link')).toBeFocused();
    await page.goForward();
    await expect(page.locator('[data-recued-reminders]').getByRole('button', { name: 'Back to Today', exact: true })).toBeVisible();
    f.deliverReminder(id);
    await page.locator('[data-recued-reminders]').getByRole('button', { name: 'Back to Today', exact: true }).click();
    await expect(panel(page).getByRole('heading', { name: 'Reminders', exact: true })).toBeFocused();
    await expect(row(page, id)).toHaveCount(0);
  } finally { f.dispose(); }
});
