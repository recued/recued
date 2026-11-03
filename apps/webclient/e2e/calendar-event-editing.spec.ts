import { expect, test, type Page } from '@playwright/test';
import { clickActionGlyph } from './helpers/action-glyph.js';
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

test('previews overlaps while editing without replacing the focused time input or blocking Save', async ({ page }, testInfo) => {
  await boot(page);
  await page.evaluate(() => { window.__calendarOverlap.holdNext(); window.__calendarOverlap.partial(true); window.__calendarOverlap.dense(true); });
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Other events at this time', exact: true });
  await expect.poll(() => page.evaluate(() => window.__calendarOverlap.pending())).toBe(true);
  const time = field(page, 'end');
  await time.focus();
  const inputHandle = await time.elementHandle();
  await page.evaluate(() => window.__calendarOverlap.release());
  await expect(preview).toContainText('Design review');
  await expect(preview).toContainText('Design · Work');
  await expect(preview).toContainText('out of date');
  await expect(preview).toContainText('preview is incomplete');
  await expect(preview).toContainText('America/Los_Angeles');
  await expect(preview.locator('.calendar-overlap-events > li:visible')).toHaveCount(3);
  await expect(preview.getByText('Design review 12', { exact: true })).toBeHidden();
  await expect(time).toBeFocused();
  expect(await inputHandle!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  const request = await page.evaluate(() => window.__calendarOverlap.requests[0]);
  expect(request?.exclude).toEqual({ slug: 'local', source_id: 'event-1', expected_incarnation: 'local-calendar-1' });
  expect(request?.start_at).toBe(Date.parse('2026-10-28T16:00:12.345Z'));
  await page.locator('.calendar-event-editor').screenshot({ path: testInfo.outputPath('overlap-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('.calendar-event-editor').screenshot({ path: testInfo.outputPath('overlap-phone-dark.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await preview.getByText('Show 9 more saved events', { exact: true }).click();
  await expect(preview.locator('.calendar-overlap-events > li:visible')).toHaveCount(12);
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
});

test('retires old overlap results and permits saving when an advisory read fails', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__calendarOverlap.holdNext());
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__calendarOverlap.pending())).toBe(true);
  await field(page, 'end').fill('2026-10-28T08:00');
  const preview = page.getByRole('region', { name: 'Other events at this time', exact: true });
  await expect(preview).toContainText('Choose valid times');
  await page.evaluate(() => window.__calendarOverlap.release());
  await expect(preview).not.toContainText('Design review');
  await page.evaluate(() => window.__calendarOverlap.fail(true));
  await field(page, 'end').fill('2026-10-28T10:30');
  await expect(preview).toContainText('could not be checked');
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  await page.evaluate(() => window.__calendarOverlap.fail(false));
  await preview.getByRole('button', { name: 'Retry check', exact: true }).click();
  await expect(preview).toContainText('Design review');
  expect(await page.evaluate(() => window.__calendarEvent.writes.length)).toBe(0);
});

test('checks a new event on the agenda time zone and keeps creation available during the check', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  const form = page.getByRole('region', { name: 'New event', exact: true });
  await form.getByLabel('Starts', { exact: true }).fill('2026-10-29T01:00');
  await page.evaluate(() => window.__calendarOverlap.holdNext());
  await form.getByLabel('Ends', { exact: true }).fill('2026-10-29T02:00');
  await expect.poll(() => page.evaluate(() => window.__calendarOverlap.pending())).toBe(true);
  await expect(form.getByRole('button', { name: 'Create event', exact: true })).toBeEnabled();
  await form.getByLabel('Title', { exact: true }).fill('New planning');
  await page.evaluate(() => window.__calendarOverlap.release());
  const preview = form.getByRole('region', { name: 'Other events at this time', exact: true });
  await expect(preview).toContainText('Design review');
  await expect(preview).toContainText('Asia/Tokyo');
  const request = await page.evaluate(() => window.__calendarOverlap.requests.at(-1));
  expect(request?.exclude).toBeUndefined();
  expect(request?.start_at).toBe(Date.parse('2026-10-28T16:00:00Z'));
});

test.describe('Repeated-hour creation', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });
test('requires an explicit repeated-hour choice in a new event before checking that interval', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  const form = page.getByRole('region', { name: 'New event', exact: true });
  await form.getByLabel('Ends', { exact: true }).fill('2026-11-01T03:00');
  const start = form.getByLabel('Starts', { exact: true });
  await start.fill('2026-11-01T01:30');
  const handle = await start.elementHandle();
  const preview = form.getByRole('region', { name: 'Other events at this time', exact: true });
  await expect(preview).toContainText('Choose valid times');
  await expect(form.getByLabel('Which start time?', { exact: true })).toBeVisible();
  expect(await handle!.evaluate(node => node.isConnected)).toBe(true);
  await form.getByLabel('Which start time?', { exact: true }).selectOption(String(Date.parse('2026-11-01T09:30:00Z')));
  await expect(preview).toContainText('No overlapping saved events found');
  const request = await page.evaluate(() => window.__calendarOverlap.requests.at(-1));
  expect(request?.start_at).toBe(Date.parse('2026-11-01T09:30:00Z'));
  expect(request?.timezone).toBe('America/Los_Angeles');
});
});

test('edits a permitted Google event in its original calendar without creating or moving it', async ({ page }, testInfo) => {
  await boot(page, 'editable-google');
  const original = await page.evaluate(() => window.__calendarEvent.saved());
  await clickActionGlyph(page, page.getByRole('button', { name: 'Edit event', exact: true }));
  await expect(page.locator('.calendar-event-editor')).toContainText('Google is asked to notify existing guests');
  await field(page, 'summary').fill('Updated customer planning');
  await field(page, 'location').fill('Room 5');
  await field(page, 'end').fill('2026-10-28T11:00');
  await page.locator('.calendar-event').screenshot({ path: testInfo.outputPath('remote-edit-desktop.png') });
  await clickActionGlyph(page, page.getByRole('button', { name: 'Save changes', exact: true }));
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
  const guestSearch = form.getByLabel('Add guests', { exact: true });
  const composition = await guestSearch.evaluate((node: HTMLInputElement) => {
    node.focus();
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    node.value = 'Ad';
    node.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Ad', isComposing: true, inputType: 'insertCompositionText' }));
    const permitted = node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', isComposing: true, keyCode: 229 }));
    return { connected: node.isConnected, permitted };
  });
  expect(composition).toEqual({ connected: true, permitted: true });
  await guestSearch.evaluate((node: HTMLInputElement) => {
    node.value = 'Ada';
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'Ada' }));
  });
  await form.getByRole('button', { name: 'Add Ada Lovelace · ada@example.com', exact: true }).click();
  await form.getByLabel('Add guests', { exact: true }).fill('Guest@Example.com');
  await form.getByLabel('Add guests', { exact: true }).press('Enter');
  await expect(form.getByRole('button', { name: 'Remove guest@example.com', exact: true })).toBeVisible();
  await form.getByLabel('Add guests', { exact: true }).fill('Ada');
  await form.getByRole('button', { name: 'Remove Ada Lovelace', exact: true }).click();
  await form.getByRole('button', { name: 'Add Ada Lovelace · ada@example.com', exact: true }).click();
  expect(await page.evaluate(() => window.__calendarEvent.creates)).toHaveLength(0);
  await form.getByLabel('Calendar', { exact: true }).selectOption(JSON.stringify(['local', 'local']));
  await expect(form.getByLabel('Add guests', { exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: 'Create and send invitations', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Choose a calendar that can send invitations');
  expect(await page.evaluate(() => window.__calendarEvent.creates)).toHaveLength(0);
  await form.getByLabel('Calendar', { exact: true }).selectOption(JSON.stringify(['work', 'work']));
  await expect(form.getByRole('button', { name: 'Remove Ada Lovelace', exact: true })).toBeVisible();
  await form.getByRole('region', { name: 'Event guests', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('new-event-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await form.getByRole('button', { name: 'Create and send invitations', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('new-event-guests-phone.png') });
  await clickActionGlyph(page, form.getByRole('button', { name: 'Create and send invitations', exact: true }));
  await expect(page.locator('.calendar-event')).toContainText('Project planning');
  await expect(page.locator('.calendar-event').getByRole('region', { name: 'Event guests' })).toContainText('ada@example.com');
  await expect(page.locator('.calendar-event').getByRole('region', { name: 'Event guests' })).toContainText('guest@example.com');
  await page.screenshot({ path: testInfo.outputPath('created-meeting-phone.png') });
  expect(await page.evaluate(() => window.__calendarEvent.creates[0])).toMatchObject({ slug: 'work', calendar_id: 'work',
    expected_incarnation: 'work-calendar-1', summary: 'Project planning', location: 'Room 4', description: 'Review the release scope.',
    send_invitations: true, guests: [{ email: 'guest@example.com' }, { email: 'ada@example.com', display_name: 'Ada Lovelace' }],
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
  await expect(form.getByLabel('Add guests', { exact: true })).toHaveCount(0);
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
    const reload = agenda.getByRole('button', { name: 'Reload calendar', exact: true });
    await reload.focus(); await reload.press('Enter');
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

test.describe('Local event deletion', () => {
  const reviewDeletion = async (page: Page) => {
    await page.locator('.calendar-event-more summary').click();
    await clickActionGlyph(page, page.getByRole('button', { name: 'Delete event', exact: true }));
    const review = page.getByRole('region', { name: 'Delete event', exact: true });
    await expect(review).toBeVisible();
    await expect(review.getByRole('button', { name: 'Keep event', exact: true })).toBeFocused();
    return review;
  };

  test('deletes a reviewed event once and returns to the same agenda date and calendar filter', async ({ page }, testInfo) => {
    await page.clock.setFixedTime(new Date('2026-10-28T12:00:00Z'));
    await installCalendarEventFixture(page, 'timed', true);
    await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.evaluate(() => window.__app.setHash('#data/calendar'));
    const agenda = page.getByRole('region', { name: 'Calendar agenda', exact: true });
    await agenda.getByLabel('Agenda start date').fill('2026-10-25');
    await agenda.locator('summary').click();
    await agenda.getByRole('checkbox', { name: 'work', exact: true }).uncheck();
    await agenda.getByRole('button', { name: /Customer planning/ }).click();
    let review = await reviewDeletion(page);
    await expect(review).toContainText('Customer planning');
    await expect(review).toContainText('America/Los_Angeles');
    expect(await page.evaluate(() => window.__calendarEvent.deletes.length)).toBe(0);
    await review.getByRole('button', { name: 'Keep event', exact: true }).click();
    await expect(review).toHaveCount(0);
    review = await reviewDeletion(page);
    await page.locator('.calendar-event').screenshot({ path: testInfo.outputPath('local-deletion-desktop.png') });
    await page.evaluate(() => window.__calendarEvent.holdNextSave());
    await clickActionGlyph(page, review.getByRole('button', { name: 'Delete event', exact: true }));
    const pending = review.getByRole('button', { name: 'Deleting…', exact: true });
    await expect(pending).toHaveAttribute('aria-disabled', 'true');
    await clickActionGlyph(page, pending);
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    await expect(review).toBeVisible();
    expect(await page.evaluate(() => window.__calendarEvent.deletes.length)).toBe(1);
    await page.evaluate(() => window.__calendarEvent.releaseSave());
    await expect(agenda).toBeVisible();
    await expect(agenda.getByRole('button', { name: /Customer planning/ })).toHaveCount(0);
    await expect(agenda.getByLabel('Agenda start date')).toHaveValue('2026-10-25');
    await expect(agenda.getByRole('checkbox', { name: 'work', exact: true })).not.toBeChecked();
    await expect(page.locator('[data-calendar-deletion-notice]')).toHaveText('Event is no longer in this calendar.');
    await expect(agenda.getByLabel('Agenda start date')).toBeFocused();
    expect(await page.evaluate(() => window.__calendarEvent.deletes)).toEqual([{
      slug: 'local', source_id: 'event-1', expected_incarnation: 'local-calendar-1', expected_version: 'v1',
    }]);
    expect(await page.evaluate(() => [window.__calendarEvent.writes.length, window.__calendarEvent.creates.length])).toEqual([0, 0]);
  });

  test('checks a lost all-day deletion reply on a phone without repeating the write', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 }); await boot(page, 'all-day');
    const review = await reviewDeletion(page);
    await expect(review).toContainText('October 31'); await expect(review).toContainText('November 2');
    await expect(review).toContainText('All day');
    await page.locator('.calendar-event').screenshot({ path: testInfo.outputPath('local-deletion-phone.png') });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.locator('.calendar-event').screenshot({ path: testInfo.outputPath('local-deletion-phone-dark.png') });
    await page.evaluate(() => window.__calendarEvent.loseNextReply());
    await review.getByRole('button', { name: 'Delete event', exact: true }).click();
    const check = review.getByRole('button', { name: 'Check deletion', exact: true });
    await expect(check).toBeFocused();
    await expect(review.getByRole('button', { name: 'Delete event', exact: true })).toHaveCount(0);
    await page.evaluate(() => window.__calendarEvent.setReadAvailable(false));
    await clickActionGlyph(page, check);
    await expect(review.getByRole('alert')).toContainText('unavailable');
    expect(await page.evaluate(() => window.__calendarEvent.deletes.length)).toBe(1);
    await page.evaluate(() => window.__calendarEvent.setReadAvailable(true));
    await clickActionGlyph(page, check);
    const agenda = page.getByRole('region', { name: 'Calendar agenda', exact: true });
    await expect(agenda).toBeVisible();
    await expect(agenda.getByRole('button', { name: /Team retreat/ })).toHaveCount(0);
    await expect(page.locator('[data-calendar-deletion-notice]')).toBeVisible();
    expect(await page.evaluate(() => [window.__calendarEvent.deletes.length, window.__calendarEvent.deletionChecks.length])).toEqual([1, 2]);
  });

  test('requires a new review after the event changes and never treats a replaced calendar as deletion', async ({ page }) => {
    await boot(page);
    let review = await reviewDeletion(page);
    await page.evaluate(() => window.__calendarEvent.changeSavedTitle('Updated by another client'));
    await review.getByRole('button', { name: 'Delete event', exact: true }).click();
    await review.getByRole('button', { name: 'Check deletion', exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect(page.locator('.calendar-event h2')).toHaveText('Updated by another client');
    expect(await page.evaluate(() => window.__calendarEvent.deletes.length)).toBe(1);
    review = await reviewDeletion(page);
    await expect(review).toContainText('Updated by another client');
    await page.evaluate(() => window.__calendarEvent.loseNextReply());
    await review.getByRole('button', { name: 'Delete event', exact: true }).click();
    await expect(review.getByRole('button', { name: 'Check deletion', exact: true })).toBeVisible();
    await page.evaluate(() => window.__calendarEvent.replaceCalendar());
    await review.getByRole('button', { name: 'Check deletion', exact: true }).click();
    await expect(review.getByRole('alert')).toContainText('removed or replaced');
    await expect(page.locator('[data-calendar-deletion-notice]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__calendarEvent.deletes.map(request => request.expected_version))).toEqual(['v1', 'v2']);
  });

  for (const mode of ['connected', 'timed'] as const) {
    test(`keeps deletion unavailable for ${mode === 'connected' ? 'a connected calendar' : 'an older local server'}`, async ({ page }) => {
      await boot(page, mode);
      if (mode === 'timed') {
        await page.evaluate(() => window.__calendarEvent.setDeleteSupported(false));
        await page.getByRole('button', { name: '← Back', exact: true }).click();
        await page.getByRole('region', { name: 'Calendar agenda', exact: true }).getByRole('button', { name: /Customer planning/ }).click();
      }
      await expect(page.locator('.calendar-event h2')).toHaveText('Customer planning');
      await expect(page.locator('.calendar-event-more')).toHaveCount(0);
      expect(await page.evaluate(() => window.__calendarEvent.deletes.length)).toBe(0);
    });
  }
});
