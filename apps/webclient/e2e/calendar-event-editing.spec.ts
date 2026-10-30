import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installCalendarEventFixture, type CalendarEventFixtureMode } from './helpers/calendar-event-fixture.js';

installFullAppHooks();
// The browser is away from the event's zone: every edit must still use LA.
test.use({ timezoneId: 'Asia/Tokyo' });
const field = (page: Page, name: string) => page.locator(`[data-calendar-event-field="${name}"]`);
const boot = async (page: Page, mode: CalendarEventFixtureMode = 'timed') => {
  await page.clock.setFixedTime(new Date('2026-10-28T12:00:00Z'));
  await installCalendarEventFixture(page, mode);
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/calendar'));
  await page.locator('[data-collection-record]').first().click();
  await expect(page.locator('.calendar-event')).toContainText(mode === 'all-day' ? 'All day' : 'America/Los_Angeles');
};

test('edits a permitted Google event in its original calendar without creating or moving it', async ({ page }, testInfo) => {
  await boot(page, 'editable-google');
  const original = await page.evaluate(() => window.__calendarEvent.saved());
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  await expect(page.locator('.calendar-event-editor')).toContainText('Google is asked to notify existing guests');
  await field(page, 'summary').fill('Updated customer planning');
  await field(page, 'location').fill('Room 5');
  await field(page, 'end').fill('2026-10-28T11:00');
  await page.locator('.calendar-event').screenshot({ path: testInfo.outputPath('remote-edit-desktop.png') });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('.calendar-event')).toContainText('Event saved.');
  const writes = await page.evaluate(() => window.__calendarEvent.writes);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ slug: 'work', source_id: original.event.source_id,
    patch: { summary: 'Updated customer planning', location: 'Room 5', end_at: Date.parse('2026-10-28T18:00:00Z') } });
  const saved = await page.evaluate(() => window.__calendarEvent.saved());
  expect(saved.event.calendar_id).toBe(original.event.calendar_id); expect(saved.event.source_id).toBe(original.event.source_id);
  expect(saved.event.description).toBe(original.event.description);
  expect(await page.evaluate(() => window.__calendarEvent.creates.length)).toBe(0);
});

test('keeps Outlook rich notes read-only on a phone and confirms an interrupted save from a live read', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, 'editable-outlook');
  const original = await page.evaluate(() => window.__calendarEvent.saved());
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  await expect(field(page, 'description')).toHaveJSProperty('readOnly', true);
  await field(page, 'summary').fill('Planning for Friday');
  await page.locator('.calendar-event').screenshot({ path: testInfo.outputPath('remote-edit-phone.png') });
  await page.evaluate(() => window.__calendarEvent.loseNextReply());
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check saved event', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__calendarEvent.setReadAvailable(false));
  await page.getByRole('button', { name: 'Check saved event', exact: true }).click();
  await expect(field(page, 'summary')).toHaveValue('Planning for Friday');
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__calendarEvent.setReadAvailable(true));
  await page.getByRole('button', { name: 'Check saved event', exact: true }).click();
  await expect(page.locator('.calendar-event')).toContainText('Your changes are saved.');
  expect(await page.evaluate(() => window.__calendarEvent.writes.length)).toBe(1);
  const saved = await page.evaluate(() => window.__calendarEvent.saved());
  expect(saved.event.description).toBe(original.event.description); expect(saved.event.calendar_id).toBe(original.event.calendar_id);
});

test('creates an event in the chosen connected calendar and returns to its agenda date', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-10-28T12:00:00Z'));
  await installCalendarEventFixture(page, 'timed', true);
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/calendar'));
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  const form = page.getByRole('region', { name: 'New event', exact: true });
  await expect(form.getByLabel('Title', { exact: true })).toBeFocused();
  await form.getByLabel('Calendar', { exact: true }).selectOption(JSON.stringify(['work', 'work']));
  await form.getByLabel('Title', { exact: true }).fill('Project planning');
  await form.getByLabel('Starts', { exact: true }).fill('2026-11-05T16:00');
  await form.getByLabel('Ends', { exact: true }).fill('2026-11-05T17:00');
  await form.getByLabel('Location (optional)', { exact: true }).fill('Room 4');
  await form.getByLabel('Notes (optional)', { exact: true }).fill('Review the release scope.');
  await form.screenshot({ path: testInfo.outputPath('new-event-desktop.png') });
  await form.getByRole('button', { name: 'Create event', exact: true }).click();
  await expect(page.locator('.calendar-event')).toContainText('Project planning');
  expect(await page.evaluate(() => window.__calendarEvent.creates[0])).toMatchObject({ slug: 'work', calendar_id: 'work',
    expected_incarnation: 'work-calendar-1', summary: 'Project planning', location: 'Room 4', description: 'Review the release scope.',
    start_at: Date.parse('2026-11-05T07:00:00Z'), end_at: Date.parse('2026-11-05T08:00:00Z'), timezone: 'Asia/Tokyo', is_all_day: false });
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await expect(page.getByLabel('Agenda start date')).toHaveValue('2026-11-05');
  await expect(page.getByRole('button', { name: /Project planning/ })).toBeVisible();
});

test('keeps a phone event draft through navigation and recovers a lost all-day save without a second event', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(new Date('2026-10-28T12:00:00Z'));
  await installCalendarEventFixture(page);
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/calendar'));
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  const form = page.getByRole('region', { name: 'New event', exact: true });
  await form.getByLabel('Title', { exact: true }).fill('Conference');
  await form.getByLabel('All day', { exact: true }).check();
  await form.getByLabel('First day', { exact: true }).fill('2026-10-31');
  await form.getByLabel('Last day (inclusive)', { exact: true }).fill('2026-11-02');
  await page.getByRole('combobox', { name: 'Collection', exact: true }).selectOption('task');
  await expect(form.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await form.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(form.getByLabel('Title', { exact: true })).toHaveValue('Conference');
  await form.screenshot({ path: testInfo.outputPath('new-event-phone.png') });
  await page.evaluate(() => window.__calendarEvent.loseNextReply());
  await form.getByRole('button', { name: 'Create event', exact: true }).click();
  await expect(form.getByRole('button', { name: 'Check save', exact: true })).toBeFocused();
  await expect(form.getByLabel('Title', { exact: true })).toBeDisabled();
  await form.getByRole('button', { name: 'Check save', exact: true }).click();
  await expect(page.locator('.calendar-event')).toContainText('Conference');
  const requests = await page.evaluate(() => window.__calendarEvent.creates);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({ is_all_day: true, start_at: Date.parse('2026-10-31T00:00:00Z'), end_at: Date.parse('2026-11-03T00:00:00Z') });
  expect(await page.evaluate(() => window.__calendarEvent.createdCount())).toBe(1);
});

test('responds to a remote invitation once and checks a lost reply without resending', async ({ page }) => {
  await boot(page, 'invitation');
  const invitation = page.getByRole('region', { name: 'Invitation response' });
  await expect(invitation).toContainText('Customer host <host@example.com>');
  await expect(invitation).toContainText('Awaiting response');
  await page.evaluate(() => window.__calendarEvent.holdNextSave());
  await invitation.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(invitation.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await expect(invitation.getByRole('button', { name: 'Decline', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__calendarEvent.responses.length)).toBe(1);
  await page.evaluate(() => window.__calendarEvent.releaseSave());
  await expect(invitation.getByRole('button', { name: 'Accept', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.calendar-event')).toContainText('Response submitted');
  await page.evaluate(() => window.__calendarEvent.loseNextReply());
  await invitation.getByRole('button', { name: 'Maybe', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check response', exact: true })).toBeFocused();
  await expect(invitation.getByRole('button', { name: 'Decline', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__calendarEvent.setReadAvailable(false));
  await page.getByRole('button', { name: 'Check response', exact: true }).click();
  await expect(invitation).toContainText('Last synced response');
  await expect(invitation).toContainText('Showing the last synced details');
  await expect(page.getByRole('button', { name: 'Check response', exact: true })).toBeFocused();
  await expect(invitation.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0);
  await expect(page.locator('.calendar-event')).not.toContainText('Your calendar currently shows');
  await page.evaluate(() => window.__calendarEvent.setReadAvailable(true));
  await page.getByRole('button', { name: 'Check response', exact: true }).click();
  await expect(invitation.getByRole('button', { name: 'Maybe', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.calendar-event')).toContainText('No response was sent again');
  expect(await page.evaluate(() => window.__calendarEvent.responses.map(r => [r.slug, r.source_id, r.response])))
    .toEqual([['work', 'event-1', 'accepted'], ['work', 'event-1', 'tentative']]);
});

test('keeps saved event details readable during an outage and refreshes before offering responses', async ({ page }) => {
  await boot(page, 'invitation');
  await page.evaluate(() => window.__calendarEvent.setReadAvailable(false));
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await page.locator('[data-collection-record]').first().click();
  await expect(page.locator('.calendar-event')).toContainText('Customer planning');
  await expect(page.locator('.calendar-event')).toContainText('America/Los_Angeles');
  await expect(page.locator('.calendar-event')).toContainText('Last synced response');
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.__calendarEvent.setReadAvailable(true));
  await page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeEnabled();
  await expect(page.locator('.calendar-event')).toContainText('Response refreshed from your calendar');
  expect(await page.evaluate(() => window.__calendarEvent.responses.length)).toBe(0);
});

test('keeps read-only invitations out of RSVP and confirms a provider-removed decline', async ({ page }) => {
  await boot(page, 'invitation');
  await page.evaluate(() => window.__calendarEvent.allowResponses(false));
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await page.locator('[data-collection-record]').first().click();
  await expect(page.locator('.calendar-event')).toContainText('This calendar is read-only.');
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.__calendarEvent.allowResponses(true); window.__calendarEvent.removeOnDecline(); });
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await page.locator('[data-collection-record]').first().click();
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(page.locator('.calendar-event')).toContainText('Your calendar removed this event.');
  await expect(page.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__calendarEvent.responses.length)).toBe(1);
});

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

test.describe('Seven-day agenda', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });
  const openAgenda = async (page: Page) => {
    await page.clock.setFixedTime(new Date('2026-10-28T12:00:00Z'));
    await installCalendarEventFixture(page, 'timed', true);
    await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed`);
    await page.waitForFunction(() => window.__app?.ready === true);
  };

  test('browses a paged week, filters calendars and returns from editing to the same date and event', async ({ page }, testInfo) => {
    await openAgenda(page);
    await page.evaluate(() => window.__app.setHash('#data/calendar'));
    const agenda = page.getByRole('region', { name: 'Calendar agenda', exact: true });
    await expect(agenda.getByRole('button', { name: /Planning slot/ })).toHaveCount(103);
    await expect(agenda.getByRole('button', { name: /Team retreat/ })).toHaveCount(3);
    await expect(agenda.getByRole('region', { name: 'Saturday, October 31' })).toContainText('Overnight handover');
    await expect(agenda.getByRole('region', { name: 'Sunday, November 1' })).toContainText('Overnight handover');
    expect(await page.evaluate(() => window.__calendarAgenda.reads.some(read => read.offset === 100))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('agenda-desktop.png') });

    await agenda.getByRole('button', { name: 'Next week', exact: true }).click();
    await expect(agenda.getByRole('button', { name: /Remote planning/ })).toBeVisible();
    await expect(agenda.getByLabel('Agenda start date')).toHaveValue('2026-11-04');
    await agenda.getByRole('button', { name: 'Previous week', exact: true }).click();
    await expect(agenda.getByRole('button', { name: /Customer planning/ })).toBeVisible();
    await agenda.getByLabel('Agenda start date').fill('2026-10-25');
    await expect(agenda.getByRole('button', { name: /Team retreat/ })).toHaveCount(1);
    await agenda.locator('summary').click();
    await agenda.getByRole('checkbox', { name: 'work', exact: true }).uncheck();
    await agenda.getByRole('button', { name: /Customer planning/ }).click();
    await page.getByRole('button', { name: 'Edit event', exact: true }).click();
    await field(page, 'summary').fill('Customer launch review');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit event', exact: true })).toBeFocused();
    await page.goBack();
    await expect(agenda.getByLabel('Agenda start date')).toHaveValue('2026-10-25');
    await expect(agenda.getByRole('checkbox', { name: 'work', exact: true })).not.toBeChecked();
    await expect(agenda.getByRole('button', { name: /Customer launch review/ })).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await agenda.getByRole('button', { name: 'Show all calendars', exact: true }).click();
    await agenda.getByRole('button', { name: 'Next week', exact: true }).click();
    await expect(agenda.getByRole('button', { name: /Remote planning/ })).toBeVisible();
    await agenda.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(agenda.getByLabel('Agenda start date')).toHaveValue('2026-10-28');
    await expect(agenda.getByRole('button', { name: /Customer launch review/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('agenda-mobile.png') });
    await agenda.getByRole('button', { name: /Customer launch review/ }).click();
    await page.getByRole('button', { name: 'Edit event', exact: true }).click();
    await field(page, 'start').fill('2026-11-02T09:00');
    await field(page, 'end').fill('2026-11-02T10:00');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit event', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    await agenda.getByRole('button', { name: /Customer launch review/ }).click();
    await page.getByRole('button', { name: 'Edit event', exact: true }).click();
    await field(page, 'start').fill('2026-11-20T09:00');
    await field(page, 'end').fill('2026-11-20T10:00');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit event', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    await expect(agenda.getByLabel('Agenda start date')).toBeFocused();
    await expect(agenda.getByLabel('Agenda start date')).toBeInViewport();
    await expect(agenda.getByRole('button', { name: /Customer launch review/ })).toHaveCount(0);
  });

  test('shows ready calendars during a source failure, retries it and ignores an old date response', async ({ page }) => {
    await openAgenda(page);
    await page.evaluate(() => { window.__calendarAgenda.holdNext('work'); window.__app.setHash('#data/calendar'); });
    const agenda = page.getByRole('region', { name: 'Calendar agenda', exact: true });
    await expect(agenda.getByRole('button', { name: /Customer planning/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__calendarAgenda.pending())).toBe(true);
    await expect(agenda).not.toContainText('No saved events in this date range');
    await page.evaluate(() => { window.__calendarAgenda.fail('work'); window.__calendarAgenda.release(); });
    await expect(agenda.getByRole('alert')).toContainText('unavailable');
    await expect(agenda.getByRole('button', { name: /Customer planning/ })).toBeVisible();
    await page.evaluate(() => window.__calendarAgenda.fail(null));
    await page.evaluate(() => window.__calendarAgenda.holdNext('work'));
    await agenda.getByRole('button', { name: 'Reload calendar', exact: true }).click();
    const retry = agenda.getByRole('button', { name: 'Reloading…', exact: true });
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute('aria-disabled', 'true');
    await page.evaluate(() => window.__calendarAgenda.release());
    await expect(agenda.getByRole('alert')).toHaveCount(0);

    await page.evaluate(() => window.__calendarAgenda.holdNext('work'));
    await agenda.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__calendarAgenda.pending())).toBe(true);
    await agenda.getByRole('button', { name: 'Next week', exact: true }).click();
    await expect(agenda.getByRole('button', { name: /Remote planning/ })).toBeVisible();
    await page.evaluate(() => window.__calendarAgenda.release());
    await expect(agenda.getByLabel('Agenda start date')).toHaveValue('2026-11-04');
    await expect(agenda.getByRole('button', { name: /Remote planning/ })).toHaveCount(1);
    await expect(agenda.getByRole('button', { name: /Customer planning/ })).toHaveCount(0);
  });
});
