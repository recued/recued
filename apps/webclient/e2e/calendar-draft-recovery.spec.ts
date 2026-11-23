import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installCalendarRecoveryFixture } from './helpers/calendar-recovery-fixture.js';
import { installTaskCalendarFixture } from './helpers/task-calendar-fixture.js';
import { installMailCalendarEventFixture } from './helpers/mail-calendar-event-fixture.js';
import { serializeSourceRecordAddress } from '../src/shell/route.js';
import type { Locator } from '@playwright/test';

installFullAppHooks();
test.use({ timezoneId: 'Asia/Tokyo' });
const editor = (page: Page) => page.getByRole('region', { name: 'New event', exact: true });
const recovery = (page: Page) => page.getByRole('region', { name: 'Unfinished calendar events', exact: true });
const boot = async (page: Page) => {
  await page.clock.setFixedTime(new Date('2026-10-31T12:00:00Z'));
  const fixture = await installCalendarRecoveryFixture(page);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/calendar`);
  await page.waitForFunction(() => window.__app?.ready === true);
  return fixture;
};
const reload = async (page: Page) => {
  const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); };
  page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); }
  await page.waitForFunction(() => window.__app?.ready === true);
};
const open = async (page: Page, title: string) => {
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  await expect(editor(page).getByLabel('Calendar', { exact: true })).toHaveValue(JSON.stringify(['work', 'primary']));
  await editor(page).getByLabel('Title', { exact: true }).fill(title);
};
const installStorageFailure = (page: Page) => page.addInitScript(() => {
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (key.startsWith('recued.calendar.draft-recovery.v1:') && document.documentElement.dataset.calendarStorageBlocked === '1') throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  };
});

test.describe('Find a time', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });
  const finder = (page: Page) => page.getByRole('region', { name: 'Find a time', exact: true });
  const suggestions = (page: Page) => page.getByRole('region', { name: 'Suggested times', exact: true });
  const prepare = async (page: Page, form: Locator, through = '2026-11-08') => {
    await expect(form.getByLabel('Calendar', { exact: true })).toHaveValue(JSON.stringify(['work', 'primary']));
    await form.getByRole('button', { name: 'Find a time', exact: true }).click();
    await finder(page).getByLabel('From date', { exact: true }).fill('2026-11-02');
    await finder(page).getByLabel('Through date', { exact: true }).fill(through);
  };
  const search = async (page: Page) => {
    await finder(page).getByRole('button', { name: 'Find times', exact: true }).click();
    await expect(suggestions(page)).toContainText('suggested time');
  };

  test('finds a saved-data gap by keyboard, keeps the draft intact and recovers the chosen interval before creation', async ({ page }, info) => {
    const f = await boot(page);
    try {
      await f.seed({ summary: 'Busy morning', start_at: Date.parse('2026-11-02T17:00Z'), end_at: Date.parse('2026-11-02T18:00Z') });
      await open(page, 'Reviewed planning'); const form = editor(page);
      await form.getByLabel('Location (optional)', { exact: true }).fill('Room 5');
      await form.getByLabel('Notes (optional)', { exact: true }).fill('Keep these notes.');
      await form.getByLabel('Add guests', { exact: true }).fill('ada@example.test'); await form.getByLabel('Add guests', { exact: true }).press('Enter');
      await prepare(page, form); const duration = finder(page).getByLabel('Duration (minutes)', { exact: true });
      await duration.fill('30'); await duration.press('Enter');
      await expect(suggestions(page)).toContainText('6 suggested times'); await expect(duration).toBeFocused();
      expect(f.requests).toEqual([]); await expect(finder(page)).toContainText('America/Los_Angeles');
      await page.screenshot({ path: info.outputPath('time-finder-desktop.png'), fullPage: true });
      await suggestions(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('time-finder-results-desktop.png'), fullPage: true });
      await suggestions(page).getByRole('button').first().click();
      await expect(form.getByLabel('Starts', { exact: true })).toHaveValue('2026-11-02T10:00');
      await expect(form.getByLabel('Ends', { exact: true })).toHaveValue('2026-11-02T10:30');
      await expect(form.getByLabel('Title', { exact: true })).toHaveValue('Reviewed planning');
      await expect(form.getByLabel('Location (optional)', { exact: true })).toHaveValue('Room 5');
      await expect(form.getByLabel('Notes (optional)', { exact: true })).toHaveValue('Keep these notes.');
      await expect(form).toContainText('ada@example.test'); expect(f.requests).toEqual([]);
      await reload(page); await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
      await expect(form.getByLabel('Calendar', { exact: true })).toHaveValue(JSON.stringify(['work', 'primary']));
      await expect(form.getByLabel('Starts', { exact: true })).toHaveValue('2026-11-02T10:00');
      await form.getByRole('button', { name: 'Create and send invitations', exact: true }).click();
      await expect(page.locator('.calendar-event')).toContainText('Reviewed planning');
      expect(f.requests).toHaveLength(1); expect(f.providerCalls()).toBe(2);
      expect(f.requests[0]).toMatchObject({ start_at: Date.parse('2026-11-02T18:00Z'), end_at: Date.parse('2026-11-02T18:30Z'),
        description: 'Keep these notes.', location: 'Room 5', guests: [{ email: 'ada@example.test' }] });
    } finally { await f.dispose(); }
  });

  test('retires a closed search, preserves typing during a read and prevents late replies from changing an all-day draft', async ({ page }) => {
    const f = await boot(page);
    try {
      await open(page, 'Before search'); const form = editor(page); await prepare(page, form);
      await expect(form.getByRole('region', { name: 'Other events at this time', exact: true })).not.toContainText('Checking saved');
      f.holdNextOverlap(); await finder(page).getByRole('button', { name: 'Find times', exact: true }).click();
      await expect.poll(f.overlapPending).toBe(true); await form.getByLabel('Title', { exact: true }).fill('Typed during search');
      await finder(page).getByRole('button', { name: 'Close time finder', exact: true }).click();
      await prepare(page, form); await finder(page).getByLabel('Duration (minutes)', { exact: true }).fill('30'); await search(page);
      f.releaseOverlap(); await expect(suggestions(page)).toContainText('6 suggested times');
      await suggestions(page).getByRole('button').first().click();
      await expect(form.getByLabel('Ends', { exact: true })).toHaveValue('2026-11-02T09:30');
      await expect(form.getByLabel('Title', { exact: true })).toHaveValue('Typed during search');
      await prepare(page, form); await expect(form.getByRole('region', { name: 'Other events at this time', exact: true })).not.toContainText('Checking saved');
      f.holdNextOverlap(); await finder(page).getByRole('button', { name: 'Find times', exact: true }).click();
      await expect.poll(f.overlapPending).toBe(true); await form.getByLabel('All day', { exact: true }).check(); f.releaseOverlap();
      await expect(finder(page)).toHaveCount(0); await expect(form.getByRole('button', { name: 'Find a time', exact: true })).toHaveCount(0);
      await expect(form.getByLabel('First day', { exact: true })).toHaveValue('2026-11-02');
      expect(f.requests).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('validates independent search settings, retries an interrupted read and keeps event submission independent of those settings', async ({ page }, info) => {
    const f = await boot(page);
    try {
      await page.setViewportSize({ width: 390, height: 900 }); await page.emulateMedia({ colorScheme: 'dark' });
      await open(page, 'Save reviewed event'); const form = editor(page); await prepare(page, form);
      await finder(page).getByLabel('Duration (minutes)', { exact: true }).fill('0');
      await finder(page).getByLabel('Duration (minutes)', { exact: true }).press('Enter');
      await expect(suggestions(page).getByRole('alert')).toContainText('15 to 480'); expect(f.requests).toEqual([]);
      await finder(page).getByLabel('Duration (minutes)', { exact: true }).fill('30');
      f.failOverlaps(true); await finder(page).getByRole('button', { name: 'Find times', exact: true }).click();
      await expect(suggestions(page).getByRole('alert')).toContainText('could not be checked'); expect(f.requests).toEqual([]);
      await expect(form.getByLabel('Title', { exact: true })).toHaveValue('Save reviewed event'); f.failOverlaps(false); await search(page);
      await page.screenshot({ path: info.outputPath('time-finder-phone-dark.png'), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await finder(page).getByLabel('Duration (minutes)', { exact: true }).fill('0');
      await form.getByRole('button', { name: 'Create event', exact: true }).click();
      await expect(page.locator('.calendar-event')).toContainText('Save reviewed event'); expect(f.requests).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  test('keeps Create clickable when a time search finishes during pointer dispatch', async ({ page }) => {
    const f = await boot(page);
    try {
      await open(page, 'Save during search'); const form = editor(page); await prepare(page, form);
      await expect(form.getByRole('region', { name: 'Other events at this time', exact: true })).not.toContainText('Checking saved');
      f.holdNextOverlap(); await finder(page).getByRole('button', { name: 'Find times', exact: true }).click();
      await expect.poll(f.overlapPending).toBe(true); f.holdNextProvider();
      const create = form.getByRole('button', { name: 'Create event', exact: true }); await create.scrollIntoViewIfNeeded();
      const bounds = await create.boundingBox(); expect(bounds).not.toBeNull();
      await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2); await page.mouse.down();
      f.releaseOverlap(); await expect(suggestions(page)).toContainText('6 suggested times'); await page.mouse.up();
      await expect(form.getByRole('button', { name: 'Saving…', exact: true })).toBeFocused(); expect(f.requests).toHaveLength(1);
      f.release(); await expect(page.locator('.calendar-event')).toContainText('Save during search');
    } finally { await f.dispose(); }
  });

  test('skips a genuinely truncated saved-event window instead of proposing times after the last preview row', async ({ page }) => {
    const f = await boot(page);
    try {
      for (let i = 0; i < 13; i++) await f.seed({ start_at: Date.parse('2026-11-02T17:00Z') + i * 60_000, end_at: Date.parse('2026-11-02T18:00Z') + i * 60_000 });
      await open(page, 'Dense day'); await prepare(page, editor(page), '2026-11-02');
      await finder(page).getByRole('button', { name: 'Find times', exact: true }).click();
      await expect(suggestions(page)).toContainText('No times could be suggested'); await expect(suggestions(page)).toContainText('preview limit');
      await expect(suggestions(page).getByRole('button')).toHaveCount(0); expect(f.requests).toEqual([]);
      await finder(page).getByLabel('Through date', { exact: true }).fill('2026-11-03'); await search(page);
      await suggestions(page).getByRole('button').first().click(); await expect(editor(page).getByLabel('Starts', { exact: true })).toHaveValue('2026-11-03T09:00');
    } finally { await f.dispose(); }
  });

  test('suggests a task interval through the shared draft and returns to the exact unchanged task', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-31T12:00Z')); const f = await installTaskCalendarFixture(page);
    try {
      const before = f.task.task();
      await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/task/task-one`); await page.waitForFunction(() => window.__app?.ready === true);
      await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Schedule time', exact: true }).click();
      const form = page.getByRole('region', { name: 'Time for task', exact: true }); await prepare(page, form); await search(page);
      await suggestions(page).getByRole('button').first().click(); expect(f.calendar.requests).toEqual([]); expect(f.task.task()).toEqual(before);
      await form.getByRole('button', { name: 'Create event', exact: true }).click(); await expect(page.locator('.calendar-event')).toContainText(before.title);
      await page.getByRole('link', { name: 'Back to task', exact: true }).click(); await expect(page.locator('.work-entity-task-reader')).toBeVisible();
      expect(new URL(page.url()).hash).toBe('#data/task/task-one'); expect(f.task.task()).toEqual(before); expect(f.task.writes).toEqual([]);
      expect(f.calendar.requests).toHaveLength(1); expect(f.calendar.requests[0]?.description).toContain('#data/task/task-one');
    } finally { await f.dispose(); }
  });

  test('suggests an email event interval while retaining the exact source link and return', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-31T12:00Z')); const f = await installMailCalendarEventFixture(page);
    try {
      const source = serializeSourceRecordAddress(f.source());
      await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple${source}`); await page.waitForFunction(() => window.__app?.ready === true);
      await page.locator('.data-mail-message').getByRole('button', { name: 'Create event', exact: true }).click();
      const form = page.getByRole('region', { name: 'Event from email', exact: true }); await prepare(page, form); const notes = await form.getByLabel('Notes (optional)', { exact: true }).inputValue();
      await search(page); await suggestions(page).getByRole('button').first().click();
      await expect(form.getByLabel('Notes (optional)', { exact: true })).toHaveValue(notes); expect(f.requests).toEqual([]);
      await form.getByRole('button', { name: 'Create event', exact: true }).click(); await expect(page.locator('.calendar-event')).toContainText(f.message().subject);
      await page.getByRole('link', { name: 'Back to email', exact: true }).click(); await expect(page.locator('.data-mail-message')).toBeVisible();
      expect(new URL(page.url()).hash).toBe(source); expect(f.writes).toEqual([]); expect(f.requests[0]?.description).toBe(notes);
    } finally { await f.dispose(); }
  });
});

test.describe('Zoned event recovery', () => {
test.use({ timezoneId: 'America/Los_Angeles' });
test('recovers exact event fields, timezone, repeated-hour choice and guests after immediate refresh', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 }); const fixture = await boot(page);
  try {
    await open(page, 'Unfinished planning'); const form = editor(page);
    const notes = '\n  Café 😀\n<img src=x onerror="throw Error(\'unsafe\')">\nTrailing spaces  \n';
    await form.getByLabel('Starts', { exact: true }).fill('2026-11-01T01:30');
    await form.getByLabel('Ends', { exact: true }).fill('2026-11-01T03:00');
    await form.getByLabel('Which start time?', { exact: true }).selectOption(String(Date.parse('2026-11-01T09:30:00Z')));
    await form.getByLabel('Location (optional)', { exact: true }).fill('Room 5');
    await form.getByLabel('Notes (optional)', { exact: true }).fill(notes);
    await form.getByLabel('Add guests', { exact: true }).fill('Ada@Example.com'); await form.getByLabel('Add guests', { exact: true }).press('Enter');
    await form.getByLabel('Add guests', { exact: true }).fill('Still choosing a guest');
    await reload(page);
    await expect(form).toHaveCount(0); await expect(recovery(page)).toContainText('Unfinished planning'); expect(fixture.requests).toEqual([]);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).press('Enter');
    await expect(form.getByLabel('Title', { exact: true })).toBeFocused();
    await expect(form).toContainText('Times in America/Los_Angeles');
    await expect(form.getByLabel('Calendar', { exact: true })).toHaveValue(JSON.stringify(['work', 'primary']));
    await expect(form.getByLabel('Starts', { exact: true })).toHaveValue('2026-11-01T01:30');
    await expect(form.getByLabel('Ends', { exact: true })).toHaveValue('2026-11-01T03:00');
    await expect(form.getByLabel('Which start time?', { exact: true })).toHaveValue(String(Date.parse('2026-11-01T09:30:00Z')));
    await expect(form.getByLabel('Notes (optional)', { exact: true })).toHaveValue(notes);
    await expect(form.getByLabel('Location (optional)', { exact: true })).toHaveValue('Room 5');
    await expect(form).toContainText('ada@example.com'); await expect(form.getByLabel('Add guests', { exact: true })).toHaveValue('Still choosing a guest');
    await expect(form.locator('img,script')).toHaveCount(0); expect(fixture.requests).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('calendar-draft-phone.png'), fullPage: true });
    await form.getByLabel('Add guests', { exact: true }).fill('');
    await form.getByRole('button', { name: 'Create and send invitations', exact: true }).press('Enter');
    await expect(page.locator('.calendar-event')).toContainText('Unfinished planning');
    expect(fixture.requests).toEqual([expect.objectContaining({ summary: 'Unfinished planning', description: notes, location: 'Room 5', timezone: 'America/Los_Angeles',
      start_at: Date.parse('2026-11-01T09:30:00Z'), end_at: Date.parse('2026-11-01T11:00:00Z'), guests: [{ email: 'ada@example.com' }], send_invitations: true })]);
    expect(fixture.providerCalls()).toBe(1); await reload(page);
    await page.evaluate(() => { location.hash = '#data/calendar'; }); await expect(recovery(page)).toHaveCount(0);
  } finally { await fixture.dispose(); }
});
});

test('keeps an all-day draft when its selected calendar cannot be checked and discards only after confirmation', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await open(page, 'Team retreat'); const form = editor(page);
    await form.getByLabel('All day', { exact: true }).check();
    await form.getByLabel('First day', { exact: true }).fill('2026-10-31'); await form.getByLabel('Last day (inclusive)', { exact: true }).fill('2026-11-02');
    fixture.failCalendarList(true); await reload(page);
    await expect(recovery(page)).toContainText('Team retreat');
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('calendar list was interrupted');
    await expect(form.getByLabel('All day', { exact: true })).toBeChecked();
    await expect(form.getByLabel('First day', { exact: true })).toHaveValue('2026-10-31');
    await expect(form.getByLabel('Last day (inclusive)', { exact: true })).toHaveValue('2026-11-02');
    await form.getByRole('button', { name: 'Create event', exact: true }).click(); expect(fixture.requests).toEqual([]);
    fixture.failCalendarList(false); fixture.setAvailable(false); await form.getByRole('button', { name: 'Reload calendars', exact: true }).click();
    await expect(form.getByLabel('Calendar', { exact: true })).toHaveValue(JSON.stringify(['work', 'primary']));
    await expect(form.getByLabel('Calendar', { exact: true })).toContainText('Calendar unavailable');
    await reload(page); const panel = recovery(page);
    await panel.getByRole('button', { name: 'Discard draft', exact: true }).press('Enter'); await expect(panel.getByRole('button', { name: 'Keep draft', exact: true })).toBeFocused();
    await panel.getByRole('button', { name: 'Keep draft', exact: true }).press('Enter'); await expect(panel).toContainText('Team retreat');
    await panel.getByRole('button', { name: 'Discard draft', exact: true }).click(); await panel.getByRole('button', { name: 'Discard recovery copy', exact: true }).press('Enter');
    await expect(panel).toHaveCount(0); await expect(page.getByRole('button', { name: 'New event', exact: true })).toBeFocused();
    await reload(page); await expect(panel).toHaveCount(0); expect(fixture.providerCalls()).toBe(0);
  } finally { await fixture.dispose(); }
});

test('checks a lost creation reply after refresh using the same request and sends guest invitations once', async ({ page }) => {
  await installStorageFailure(page);
  const fixture = await boot(page);
  try {
    await open(page, 'Invitation with a lost reply'); const form = editor(page);
    await form.getByLabel('Add guests', { exact: true }).fill('ada@example.com'); await form.getByLabel('Add guests', { exact: true }).press('Enter');
    fixture.loseNextReply(); await form.getByRole('button', { name: 'Create and send invitations', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Check save', exact: true })).toBeFocused(); expect(fixture.providerCalls()).toBe(1);
    const sent = structuredClone(fixture.requests[0]!); await reload(page);
    await expect(recovery(page)).toContainText('save was not confirmed');
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(form.getByLabel('Title', { exact: true })).toBeDisabled(); expect(fixture.requests).toHaveLength(1);
    await page.evaluate(() => { document.documentElement.dataset.calendarStorageBlocked = '1'; });
    await form.getByRole('button', { name: 'Check save', exact: true }).press('Enter');
    await expect(form.getByRole('alert')).toContainText('recovery copy could not be updated'); expect(fixture.requests).toHaveLength(1);
    await expect(form.getByLabel('Title', { exact: true })).toBeDisabled();
    await page.evaluate(() => { delete document.documentElement.dataset.calendarStorageBlocked; });
    await form.getByRole('button', { name: 'Check save', exact: true }).press('Enter');
    await expect(page.locator('.calendar-event')).toContainText('Invitation with a lost reply');
    expect(fixture.requests).toEqual([sent, sent]); expect(fixture.providerCalls()).toBe(1);
    await reload(page); await page.evaluate(() => { location.hash = '#data/calendar'; }); await expect(recovery(page)).toHaveCount(0);
  } finally { await fixture.dispose(); }
});

test('retains a pending provider save across refresh and keeps checking its receipt without another dispatch', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await open(page, 'Provider still saving'); const form = editor(page);
    fixture.holdNextProvider(); await form.getByRole('button', { name: 'Create event', exact: true }).click();
    await expect.poll(fixture.pending).toBe(true); const sent = structuredClone(fixture.requests[0]!); await reload(page);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await form.getByRole('button', { name: 'Check save', exact: true }).press('Enter');
    await expect(form.getByRole('alert')).toContainText('save could not be confirmed'); expect(fixture.providerCalls()).toBe(1);
    fixture.release();
    await expect.poll(() => fixture.pending()).toBe(false);
    await form.getByRole('button', { name: 'Check save', exact: true }).click();
    await expect(page.locator('.calendar-event')).toContainText('Provider still saving');
    expect(fixture.requests).toEqual([sent, sent, sent]); expect(fixture.providerCalls()).toBe(1);
  } finally { await fixture.dispose(); }
});

test('shows storage failures without replacing focused text and blocks a save over an older recovery copy', async ({ page }) => {
  await installStorageFailure(page);
  const fixture = await boot(page);
  try {
    await open(page, 'Keep this meeting'); const form = editor(page), notes = form.getByLabel('Notes (optional)', { exact: true });
    await expect(form.locator('[data-calendar-recovery-status]')).toHaveText('Event details kept in this tab.');
    await page.evaluate(() => { document.documentElement.dataset.calendarStorageBlocked = '1'; }); await notes.fill('Latest notes');
    await expect(form.locator('[data-calendar-recovery-status]')).toContainText('could not be kept');
    await expect(notes).toBeFocused(); await expect(notes).toHaveValue('Latest notes');
    await form.getByRole('button', { name: 'Create event', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('recovery copy could not be updated'); expect(fixture.requests).toEqual([]);
    await page.evaluate(() => { delete document.documentElement.dataset.calendarStorageBlocked; }); await notes.fill('Kept notes');
    await expect(form.locator('[data-calendar-recovery-status]')).toHaveText('Event details kept in this tab.'); await reload(page);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click(); await expect(notes).toHaveValue('Kept notes');
    expect(fixture.requests).toEqual([]);
  } finally { await fixture.dispose(); }
});
