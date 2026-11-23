import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installCalendarRescheduleFixture } from './helpers/calendar-reschedule-fixture.js';
import { installCalendarEventFixture } from './helpers/calendar-event-fixture.js';

installFullAppHooks();
test.use({ timezoneId: 'Asia/Tokyo' });
const field = (page: Page, name: string) => page.locator(`[data-calendar-event-field="${name}"]`);
const finder = (page: Page) => page.getByRole('region', { name: 'Find another time', exact: true });
const results = (page: Page) => finder(page).getByRole('region', { name: 'Suggested times', exact: true });
const openEvent = async (page: Page) => {
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed#data/calendar`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-collection-record]').first().click();
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
};
const boot = async (page: Page, now = '2026-10-28T12:00Z') => {
  await page.clock.setFixedTime(new Date(now));
  const fixture = await installCalendarRescheduleFixture(page, Date.parse(now));
  await openEvent(page); return fixture;
};
const search = async (page: Page) => {
  await finder(page).getByRole('button', { name: 'Find times', exact: true }).click();
  await expect(results(page)).toContainText('suggested time');
};

test('excludes the event and its duplicate, preserves edits and fractional duration, and saves only after review', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
  const f = await boot(page), original = f.get();
  try {
    await field(page, 'summary').fill('Reviewed planning'); await field(page, 'location').fill('Room 5');
    await field(page, 'description').fill('Keep these notes.');
    await page.getByRole('button', { name: 'Find another time', exact: true }).click();
    await expect(finder(page)).toContainText('America/Los_Angeles');
    await expect(finder(page)).toContainText('1 hour 12.567 seconds');
    await expect(finder(page).getByLabel('Duration (minutes)', { exact: true })).toHaveCount(0);
    await finder(page).getByLabel('From date', { exact: true }).press('Enter');
    await expect(results(page)).toContainText('6 suggested times');
    await expect(results(page)).toContainText('sync is incomplete'); await expect(results(page)).toContainText('could not be checked');
    // The 9am suggestion fits only when both the event and its saved duplicate are excluded.
    await expect(results(page).getByRole('button').first()).toContainText('9:00');
    const dayReads = f.reads.filter(read => read.end_at - read.start_at === 8 * 3_600_000);
    expect(dayReads.length).toBeGreaterThan(0);
    expect(dayReads.every(read => read.exclude?.source_id === original.event.source_id
      && read.exclude.expected_incarnation === original.incarnation && read.timezone === 'America/Los_Angeles')).toBe(true);
    expect(f.writes).toEqual([]); expect(f.get()).toEqual(original);
    await finder(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('reschedule-phone-dark.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await results(page).getByRole('button').nth(1).click();
    await expect(field(page, 'start')).toHaveValue('2026-10-28T11:00');
    await expect(field(page, 'end')).toHaveValue('2026-10-28T12:00:12.567');
    await expect(field(page, 'start')).toBeFocused();
    await expect(field(page, 'summary')).toHaveValue('Reviewed planning'); await expect(field(page, 'location')).toHaveValue('Room 5');
    await expect(field(page, 'description')).toHaveValue('Keep these notes.'); expect(f.writes).toEqual([]);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.calendar-event')).toContainText('Event saved.');
    expect(f.writes).toHaveLength(1); expect(f.writes[0]).toMatchObject({ expected_version: original.resource_version, expected_incarnation: original.incarnation,
      patch: { summary: 'Reviewed planning', location: 'Room 5', description: 'Keep these notes.', start_at: Date.parse('2026-10-28T18:00Z'), end_at: Date.parse('2026-10-28T19:00:12.567Z') } });
    expect(f.get().event.source_id).toBe(original.event.source_id); expect(f.get().event.calendar_id).toBe(original.event.calendar_id);
  } finally { await f.dispose(); }
});

test('uses the edited duration and preserves the focused native input while a finder read finishes', async ({ page }) => {
  const f = await boot(page);
  try {
    await field(page, 'end').fill('2026-10-28T11:30');
    await page.getByRole('button', { name: 'Find another time', exact: true }).click();
    await expect(finder(page)).toContainText('2 hours 30 minutes');
    await finder(page).getByLabel('From date', { exact: true }).fill('2026-10-29');
    await finder(page).getByLabel('Through date', { exact: true }).fill('2026-10-29');
    f.holdNext(); await finder(page).getByRole('button', { name: 'Find times', exact: true }).click();
    await expect.poll(f.pending).toBe(true); await field(page, 'description').fill('Typed during the search');
    const input = await field(page, 'description').elementHandle(); f.release();
    await expect(results(page)).toContainText('3 suggested times');
    await expect(field(page, 'description')).toBeFocused(); expect(await input!.evaluate(node => node.isConnected)).toBe(true);
    await results(page).getByRole('button').first().click();
    await expect(field(page, 'start')).toHaveValue('2026-10-29T09:00'); await expect(field(page, 'end')).toHaveValue('2026-10-29T11:30');
    await expect(field(page, 'description')).toHaveValue('Typed during the search'); expect(f.writes).toEqual([]);
  } finally { await f.dispose(); }
});

test('retires a search on manual time edits and discard so late replies cannot restore suggestions or save', async ({ page }) => {
  const f = await boot(page), original = f.get();
  try {
    await page.getByRole('button', { name: 'Find another time', exact: true }).click(); await search(page);
    const oldAction = await results(page).getByRole('button').first().getAttribute('data-recued-data-action');
    expect(oldAction).toMatch(/^calendar-event-find-pick-/);
    await finder(page).getByRole('button', { name: 'Close time finder', exact: true }).click();
    await page.getByRole('button', { name: 'Find another time', exact: true }).click();
    f.holdNext(); await finder(page).getByRole('button', { name: 'Find times', exact: true }).click(); await expect.poll(f.pending).toBe(true);
    await field(page, 'end').fill('2026-10-28T11:00');
    await expect(finder(page)).toHaveCount(0);
    const completed = f.completed(); f.release(); await expect.poll(f.completed).toBeGreaterThan(completed);
    await page.evaluate(action => { const old = document.createElement('button'); old.setAttribute('data-recued-data-action', action!); document.querySelector('.calendar-event')!.append(old); old.click(); old.remove(); }, oldAction);
    await expect(field(page, 'end')).toHaveValue('2026-10-28T11:00');
    await page.getByRole('button', { name: 'Find another time', exact: true }).click();
    f.holdNext(); await finder(page).getByRole('button', { name: 'Find times', exact: true }).click(); await expect.poll(f.pending).toBe(true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    const after = f.completed(); f.release(); await expect.poll(f.completed).toBeGreaterThan(after);
    await expect(page.getByRole('button', { name: 'Edit event', exact: true })).toBeVisible(); await expect(finder(page)).toHaveCount(0);
    expect(f.writes).toEqual([]); expect(f.get()).toEqual(original);
  } finally { await f.dispose(); }
});

test('keeps a rescheduled draft when the saved event changes and lets the owner reload it', async ({ page }) => {
  const f = await boot(page);
  try {
    await page.getByRole('button', { name: 'Find another time', exact: true }).click(); await search(page);
    await results(page).getByRole('button').nth(1).click(); await f.changeSavedTitle();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.calendar-event-error')).toContainText('changed since you opened');
    await expect(field(page, 'start')).toHaveValue('2026-10-28T11:00'); expect(f.get().event.summary).toBe('Changed elsewhere');
    expect(f.get().event.start_at).toBe(Date.parse('2026-10-28T16:00Z'));
    await page.getByRole('button', { name: 'Reload saved values', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit event', exact: true })).toBeVisible();
    await expect(page.locator('.calendar-event')).toContainText('Changed elsewhere'); expect(f.writes).toHaveLength(1);
  } finally { await f.dispose(); }
});

test('retries failed reads, skips a truly truncated day, and keeps saving independent of finder settings', async ({ page }) => {
  const f = await boot(page);
  try {
    await field(page, 'summary').fill('Reviewed without a new time');
    await page.getByRole('button', { name: 'Find another time', exact: true }).click();
    await finder(page).getByLabel('Through date', { exact: true }).fill('2026-10-28');
    f.fail(true); await finder(page).getByRole('button', { name: 'Find times', exact: true }).click();
    await expect(results(page).getByRole('alert')).toContainText('could not be checked'); expect(f.writes).toEqual([]);
    f.fail(false);
    for (let i = 0; i < 13; i++) await f.seed('local', `dense-${i}`, { ical_uid: `dense-${i}`, start_at: Date.parse('2026-10-28T18:00Z') + i * 60_000, end_at: Date.parse('2026-10-28T19:00Z') + i * 60_000 });
    await finder(page).getByRole('button', { name: 'Find times', exact: true }).click();
    await expect(results(page)).toContainText('No times could be suggested'); await expect(results(page)).toContainText('preview limit');
    await expect(results(page).getByRole('button')).toHaveCount(0);
    await finder(page).getByLabel('Working day ends', { exact: true }).fill('08:00');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.locator('.calendar-event')).toContainText('Event saved.');
    expect(f.writes[0]!.patch).toEqual({ summary: 'Reviewed without a new time' });
  } finally { await f.dispose(); }
});

test('saves the selected second reading of a repeated hour with its exact fractional duration', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-01T08:50Z'));
  const f = await installCalendarRescheduleFixture(page, Date.parse('2026-11-01T08:50Z'));
  try {
    await f.seed('local', 'event-1', { start_at: Date.parse('2026-11-01T08:15Z'), end_at: Date.parse('2026-11-01T08:45:12.345Z') }); await openEvent(page);
    await page.getByRole('button', { name: 'Find another time', exact: true }).click();
    await finder(page).getByLabel('Through date', { exact: true }).fill('2026-11-01');
    await finder(page).getByLabel('Working day starts', { exact: true }).fill('01:00');
    await finder(page).getByLabel('Working day ends', { exact: true }).fill('03:00'); await finder(page).getByLabel('Weekdays only', { exact: true }).uncheck();
    await search(page); await expect(results(page).getByRole('button').first()).toContainText('PST'); await results(page).getByRole('button').first().click();
    await expect(field(page, 'start')).toHaveValue('2026-11-01T01:00'); await expect(field(page, 'end')).toHaveValue('2026-11-01T01:30:12.345');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.locator('.calendar-event')).toContainText('Event saved.');
    expect(f.writes[0]!.patch).toEqual({ start_at: Date.parse('2026-11-01T09:00Z'), end_at: Date.parse('2026-11-01T09:30:12.345Z') });
  } finally { await f.dispose(); }
});

test('preserves Outlook rich notes and checks an interrupted reschedule without sending it twice', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-28T12:00Z')); await installCalendarEventFixture(page, 'editable-outlook'); await openEvent(page);
  const original = await page.evaluate(() => window.__calendarEvent.saved());
  await expect(field(page, 'description')).toHaveJSProperty('readOnly', true);
  await page.getByRole('button', { name: 'Find another time', exact: true }).click(); await search(page); await results(page).getByRole('button').first().click();
  await page.evaluate(() => window.__calendarEvent.loseNextReply()); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check saved event', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Find another time', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check saved event', exact: true }).click(); await expect(page.locator('.calendar-event')).toContainText('Your changes are saved.');
  expect(await page.evaluate(() => window.__calendarEvent.writes.length)).toBe(1);
  const saved = await page.evaluate(() => window.__calendarEvent.saved()); expect(saved.event.description).toBe(original.event.description);
  expect(saved.event.calendar_id).toBe(original.event.calendar_id); expect(saved.event.source_id).toBe(original.event.source_id);
});
