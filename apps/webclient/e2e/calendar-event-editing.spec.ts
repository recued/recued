import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installCalendarEventFixture } from './helpers/calendar-event-fixture.js';

installFullAppHooks();
// The browser is away from the event's zone: every edit must still use LA.
test.use({ timezoneId: 'Asia/Tokyo' });
const field = (page: Page, name: string) => page.locator(`[data-calendar-event-field="${name}"]`);
const boot = async (page: Page, mode: 'timed' | 'all-day' | 'connected' = 'timed') => {
  await installCalendarEventFixture(page, mode);
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/calendar'));
  await page.locator('[data-collection-record]').first().click();
  await expect(page.locator('.calendar-event')).toContainText(mode === 'all-day' ? 'All day' : 'America/Los_Angeles');
};

test('edits a timed local event on its own clock, saves once, and returns to the updated list', async ({ page }) => {
  await boot(page);
  await expect(page.locator('.calendar-event')).toContainText('1 hour');
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  await expect(field(page, 'summary')).toBeFocused();
  await expect(field(page, 'start')).toHaveValue('2026-10-28T09:00');
  await expect(field(page, 'description')).toHaveValue('\nBring the launch agenda.');
  await field(page, 'summary').fill('Customer launch review');
  await field(page, 'location').fill(''); await field(page, 'description').fill('Updated agenda.');
  await field(page, 'end').fill('2026-10-28T11:30');
  await page.evaluate(() => window.__calendarEvent.holdNextSave());
  const save = page.getByRole('button', { name: 'Save changes', exact: true });
  await save.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-disabled', 'true');
  expect(await page.evaluate(() => window.__calendarEvent.writes.length)).toBe(1);
  await page.evaluate(() => window.__calendarEvent.releaseSave());
  await expect(page.getByRole('button', { name: 'Edit event', exact: true })).toBeFocused();
  const request = await page.evaluate(() => window.__calendarEvent.writes[0]);
  expect(request).toMatchObject({ slug: 'local', source_id: 'event-1', expected_version: 'v1', expected_incarnation: 'local-calendar-1',
    patch: { summary: 'Customer launch review', description: 'Updated agenda.', location: '', end_at: Date.parse('2026-10-28T18:30:00Z') } });
  expect(request?.patch).not.toHaveProperty('start_at');
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await expect(page.locator('[data-collection-record]')).toContainText('Customer launch review');
  await page.locator('[data-collection-record]').first().click();
  await expect(page.locator('.calendar-event-description')).toHaveText('Updated agenda.');
});

test('edits an all-day range with an inclusive last day across the DST boundary', async ({ page }) => {
  await boot(page, 'all-day');
  await expect(page.locator('.calendar-event')).toContainText('3 days');
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  await expect(field(page, 'start')).toHaveValue('2026-10-31');
  await expect(field(page, 'end')).toHaveValue('2026-11-02');
  await field(page, 'start').fill('2026-11-01'); await field(page, 'end').fill('2026-11-04');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit event', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__calendarEvent.writes[0]?.patch)).toEqual({
    start_at: Date.parse('2026-11-01T00:00:00Z'), end_at: Date.parse('2026-11-05T00:00:00Z'),
  });
  await expect(page.locator('.calendar-event')).toContainText('4 days');
});

test('preserves a failed draft and guards Back and collection navigation until it is discarded', async ({ page }) => {
  await boot(page); await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  await field(page, 'summary').fill('Keep my draft'); await field(page, 'description').fill('Draft notes to keep.');
  await page.evaluate(() => window.__calendarEvent.holdNextSave());
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeFocused();
  await page.evaluate(() => window.__calendarEvent.releaseSave(true));
  await expect(page.getByRole('alert')).toContainText('interrupted');
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeFocused();
  await expect(field(page, 'summary')).toHaveValue('Keep my draft');
  page.once('dialog', dialog => { void dialog.dismiss(); });
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(field(page, 'summary')).toHaveValue('Keep my draft');
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Discard changes', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(field(page, 'description')).toBeFocused();
  await expect(field(page, 'description')).toHaveValue('Draft notes to keep.');
  await page.locator('[data-recued-data-route-tab="task"]').click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(field(page, 'summary')).toHaveCount(0);
  expect(await page.evaluate(() => window.__calendarEvent.writes.length)).toBe(1);
});

test('keeps a stale draft until the owner reloads the newer saved event', async ({ page }) => {
  await boot(page); await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  await field(page, 'summary').fill('My older draft');
  await page.evaluate(() => window.__calendarEvent.changeSavedTitle('A newer saved title'));
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('changed');
  await page.evaluate(() => window.__calendarEvent.holdNextRead());
  await page.getByRole('button', { name: 'Check saved event', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Checking…', exact: true })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__calendarEvent.readPending())).toBe(true);
  await page.evaluate(() => window.__calendarEvent.releaseRead());
  await expect(page.getByRole('alert')).toContainText('differs from your draft');
  await expect(page.getByRole('button', { name: 'Check saved event', exact: true })).toBeFocused();
  await expect(field(page, 'summary')).toHaveValue('My older draft');
  await page.getByRole('button', { name: 'Reload saved values', exact: true }).click();
  await page.evaluate(() => window.__calendarEvent.holdNextRead());
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__calendarEvent.readPending())).toBe(true);
  await page.evaluate(() => window.__calendarEvent.releaseRead(true));
  await expect(page.getByRole('alert')).toContainText('read was interrupted');
  await expect(page.getByRole('button', { name: 'Retry event details', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Retry event details', exact: true }).click();
  await expect(page.locator('[data-recued-collection-detail-heading]')).toHaveText('A newer saved title');
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  await field(page, 'summary').fill('My new draft');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('[data-recued-collection-detail-heading]')).toHaveText('My new draft');
  expect(await page.evaluate(() => window.__calendarEvent.writes[1]?.expected_version)).toBe('v2');
});

test('confirms a save with a lost reply using a read and retains the original timed precision', async ({ page }) => {
  await boot(page); await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  await field(page, 'description').fill('Saved despite a lost reply.');
  await page.evaluate(() => window.__calendarEvent.loseNextReply());
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('responding');
  await expect(field(page, 'description')).toHaveValue('Saved despite a lost reply.');
  await page.getByRole('button', { name: 'Check saved event', exact: true }).click();
  await expect(page.locator('.calendar-event-notice')).toHaveText('Your changes are saved.');
  expect(await page.evaluate(() => window.__calendarEvent.writes.length)).toBe(1);
  const saved = await page.evaluate(() => window.__calendarEvent.saved());
  expect(saved.event.start_at).toBe(Date.parse('2026-10-28T16:00:12.345Z'));
  expect(saved.event.end_at).toBe(Date.parse('2026-10-28T17:00:12.345Z'));
});

test('shows precise connected event details and keeps its recipe reschedule action', async ({ page }) => {
  await boot(page, 'connected');
  await expect(page.locator('.calendar-event')).toContainText('Edit this event in its connected calendar');
  await expect(page.getByRole('button', { name: 'Edit event', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reschedule', exact: true })).toBeVisible();
});


test('requires a repeated-time reading while preserving the native date input being edited', async ({ page }) => {
  await boot(page); await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  // Replacing this native input resets its active date/time segment.
  const editingStart = await field(page, 'start').elementHandle();
  await field(page, 'start').fill('2026-11-01T01:30');
  expect(await editingStart!.evaluate(node => node.isConnected)).toBe(true);
  await field(page, 'end').fill('2026-11-01T03:00');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Choose which repeated start time');
  expect(await page.evaluate(() => window.__calendarEvent.writes.length)).toBe(0);
  await field(page, 'startChoice').selectOption(String(Date.parse('2026-11-01T09:30:00Z')));
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit event', exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.__calendarEvent.writes[0]?.patch)).toEqual({
    start_at: Date.parse('2026-11-01T09:30:00Z'), end_at: Date.parse('2026-11-01T11:00:00Z'),
  });
});
