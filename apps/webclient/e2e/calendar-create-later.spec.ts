import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installCalendarRecoveryFixture } from './helpers/calendar-recovery-fixture.js';
import { installMailCalendarEventFixture } from './helpers/mail-calendar-event-fixture.js';
import { installTaskCalendarFixture } from './helpers/task-calendar-fixture.js';
import { serializeSourceRecordAddress } from '../src/shell/route.js';
import type { CalendarRecoveryEntry } from '../src/data/calendar-draft-recovery.js';

installFullAppHooks();
test.use({ timezoneId: 'America/Los_Angeles' });
const form = (page: Page, name = 'New event') => page.getByRole('region', { name, exact: true });
const recovery = (page: Page) => page.getByRole('region', { name: 'Unfinished calendar events', exact: true });
const later = (page: Page) => page.getByRole('button', { name: 'Keep draft for later', exact: true });
const tasks = (page: Page) => page.getByRole('tab', { name: 'Tasks', exact: true });
const stored = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('recued.calendar.draft-recovery.v1:'))
  .flatMap(key => JSON.parse(sessionStorage.getItem(key)!) as CalendarRecoveryEntry[]));
const go = async (page: Page, hash = '#data/calendar') => {
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed&server_profiles=multiple${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const boot = async (page: Page) => {
  await page.clock.setFixedTime(new Date('2026-10-31T12:00Z'));
  const fixture = await installCalendarRecoveryFixture(page); await go(page); return fixture;
};
const open = async (page: Page, title: string) => {
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  await expect(form(page).getByLabel('Calendar', { exact: true })).toHaveValue(JSON.stringify(['work', 'primary']));
  await form(page).getByLabel('Title', { exact: true }).fill(title);
};
const returnToCalendar = (page: Page) => page.evaluate(() => window.__app.setHash('#data/calendar'));

test('keeps exact new-event fields through navigation, traverses every choice by keyboard and resumes from Universal Search', async ({ page }, info) => {
  const f = await boot(page);
  try {
    await open(page, 'Kestrel event draft'); const editor = form(page);
    await editor.getByLabel('Starts', { exact: true }).fill('2026-11-01T01:30');
    await editor.getByLabel('Ends', { exact: true }).fill('2026-11-01T03:00');
    await editor.getByLabel('Which start time?', { exact: true }).selectOption(String(Date.parse('2026-11-01T09:30Z')));
    await editor.getByLabel('Location (optional)', { exact: true }).fill('Room 5');
    await editor.getByLabel('Add guests', { exact: true }).fill('ada@example.test'); await editor.getByLabel('Add guests', { exact: true }).press('Enter');
    await editor.getByLabel('Add guests', { exact: true }).fill('Still choosing');
    await editor.getByLabel('Notes (optional)', { exact: true }).fill('\nLatest notes\n');
    await tasks(page).click();
    const dialog = page.getByRole('alertdialog', { name: 'Leave this event?', exact: true });
    const editing = dialog.getByRole('button', { name: 'Keep editing', exact: true }), discard = dialog.getByRole('button', { name: 'Discard draft', exact: true });
    await expect(editing).toBeFocused(); await page.keyboard.press('Tab'); await expect(later(page)).toBeFocused();
    await page.keyboard.press('Tab'); await expect(discard).toBeFocused(); await page.keyboard.press('Tab'); await expect(editing).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(discard).toBeFocused(); await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0); await expect(editor.getByLabel('Title', { exact: true })).toBeFocused();
    await tasks(page).click(); await page.setViewportSize({ width: 390, height: 844 }); await expect(dialog).toBeVisible();
    await page.screenshot({ path: info.outputPath('keep-new-event-phone.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 }); await expect(tasks(page)).toBeVisible(); await later(page).click();
    await expect(tasks(page)).toHaveAttribute('aria-selected', 'true'); expect(f.requests).toEqual([]);
    const kept = (await stored(page))[0]!; expect(kept.values.draft.guestQuery).toBe('Still choosing');
    await page.evaluate(() => window.__app.setHash('#data/search')); await page.getByRole('searchbox', { name: 'Search everything', exact: true }).fill('Kestrel event draft');
    await page.getByRole('region', { name: 'Unfinished work search results', exact: true }).locator('[data-recovery-draft-key]').click();
    await expect(editor.getByLabel('Calendar', { exact: true })).toHaveValue(JSON.stringify(['work', 'primary']));
    await expect(editor.getByLabel('Notes (optional)', { exact: true })).toHaveValue('\nLatest notes\n');
    await expect(editor.getByLabel('Location (optional)', { exact: true })).toHaveValue('Room 5');
    await expect(editor.getByLabel('Starts', { exact: true })).toHaveValue('2026-11-01T01:30');
    await expect(editor.getByLabel('Which start time?', { exact: true })).toHaveValue(String(Date.parse('2026-11-01T09:30Z')));
    await expect(editor.getByLabel('Add guests', { exact: true })).toHaveValue('Still choosing'); await expect(editor).toContainText('Times in America/Los_Angeles');
    await editor.getByLabel('Add guests', { exact: true }).fill(''); expect(f.requests).toEqual([]);
    await editor.getByRole('button', { name: 'Create and send invitations', exact: true }).click();
    await expect(page.locator('.calendar-event')).toContainText('Kestrel event draft');
    expect(f.requests).toHaveLength(1); expect(f.requests[0]).toMatchObject({ creation_id: kept.values.creationId,
      timezone: 'America/Los_Angeles', start_at: Date.parse('2026-11-01T09:30Z'), end_at: Date.parse('2026-11-01T11:00Z'),
      description: '\nLatest notes\n', location: 'Room 5', guests: [{ email: 'ada@example.test' }] });
    expect(f.providerCalls()).toBe(1); expect(await stored(page)).toEqual([]);
  } finally { await f.dispose(); }
});

test('keeps the form and destination pending after failed persistence or read-back and leaves only after a verified retry', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem, getItem = Storage.prototype.getItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('recued.calendar.draft-recovery.v1:') && document.documentElement.dataset.keepWriteBlocked === '1') throw new DOMException('Full', 'QuotaExceededError'); setItem.call(this, key, value); };
    Storage.prototype.getItem = function(key) { if (key.startsWith('recued.calendar.draft-recovery.v1:') && document.documentElement.dataset.keepReadBlocked === '1') throw new DOMException('Unavailable', 'SecurityError'); return getItem.call(this, key); };
  });
  const f = await boot(page);
  try {
    await open(page, 'Draft with blocked storage');
    await page.evaluate(() => { document.documentElement.dataset.keepWriteBlocked = '1'; });
    await form(page).getByLabel('Notes (optional)', { exact: true }).fill('The latest details'); await tasks(page).click(); await later(page).click();
    await expect(page.getByRole('alertdialog').getByRole('alert')).toContainText('could not be confirmed');
    await expect(tasks(page)).toHaveAttribute('aria-selected', 'false'); expect(f.requests).toEqual([]);
    await page.evaluate(() => { document.documentElement.dataset.keepWriteBlocked = '0'; });
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await form(page).getByLabel('Notes (optional)', { exact: true }).fill('The final details');
    await expect(page.locator('[data-calendar-recovery-status]')).toHaveText('Event details kept in this tab.');
    await page.evaluate(() => { document.documentElement.dataset.keepReadBlocked = '1'; }); await tasks(page).click(); await later(page).click();
    await expect(page.getByRole('alertdialog').getByRole('alert')).toContainText('could not be confirmed'); await expect(tasks(page)).toHaveAttribute('aria-selected', 'false');
    await page.evaluate(() => { document.documentElement.dataset.keepReadBlocked = '0'; }); await later(page).click();
    await expect(tasks(page)).toHaveAttribute('aria-selected', 'true'); await returnToCalendar(page);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(form(page).getByLabel('Notes (optional)', { exact: true })).toHaveValue('The final details'); expect(f.requests).toEqual([]);
  } finally { await f.dispose(); }
});

test('blocks leaving during creation and keeps an interrupted invitation unchanged for an idempotent Check save', async ({ page }) => {
  const f = await boot(page);
  try {
    await open(page, 'Invitation to check later'); const editor = form(page);
    await editor.getByLabel('Add guests', { exact: true }).fill('ada@example.test'); await editor.getByLabel('Add guests', { exact: true }).press('Enter');
    f.holdNextProvider(); f.loseNextReply(); await editor.getByRole('button', { name: 'Create and send invitations', exact: true }).click();
    await expect.poll(f.pending).toBe(true); await tasks(page).click(); await expect(tasks(page)).toHaveAttribute('aria-selected', 'false');
    await expect(later(page)).toHaveCount(0); await expect(editor.getByRole('button', { name: 'Saving…', exact: true })).toBeFocused();
    f.release(); await expect(editor.getByRole('button', { name: 'Check save', exact: true })).toBeVisible();
    const original = await stored(page); expect(original[0]?.status).toBe('unknown'); const sent = structuredClone(f.requests[0]!);
    await tasks(page).click(); await expect(page.getByRole('alertdialog')).toContainText('may already exist'); await later(page).click();
    await expect(tasks(page)).toHaveAttribute('aria-selected', 'true'); expect(await stored(page)).toEqual(original); expect(f.requests).toEqual([sent]);
    await returnToCalendar(page); await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor.getByLabel('Title', { exact: true })).toBeDisabled(); expect(f.requests).toEqual([sent]);
    await editor.getByRole('button', { name: 'Check save', exact: true }).click(); await expect(page.locator('.calendar-event')).toContainText('Invitation to check later');
    expect(f.requests).toEqual([sent, sent]); expect(f.providerCalls()).toBe(1); expect(await stored(page)).toEqual([]);
  } finally { await f.dispose(); }
});

test('keeps a duplicate on Cancel with its exact duration and original-event return intact', async ({ page }) => {
  const f = await boot(page);
  try {
    const original = await f.seed({ end_at: Date.parse('2026-10-28T17:15:15.123Z') }), before = f.get(original.snapshot.event.source_id);
    const href = serializeSourceRecordAddress({ tab: 'calendar', collectionSlug: 'work', recordId: original.snapshot.record.record_id });
    await go(page, href); await page.locator('.calendar-event').getByRole('button', { name: 'Duplicate event', exact: true }).click();
    const editor = form(page, 'Duplicate event'); await editor.getByLabel('Starts', { exact: true }).fill('2026-11-02T09:00');
    await expect(editor.getByLabel('Ends', { exact: true })).toHaveValue('2026-11-02T10:15:15.123');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await later(page).click(); await expect(editor).toHaveCount(0);
    const kept = (await stored(page))[0]!; expect(kept.values.duplicate?.context.recordId).toBe(original.snapshot.record.record_id);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor.getByLabel('Ends', { exact: true })).toHaveValue('2026-11-02T10:15:15.123'); expect(f.requests).toEqual([]);
    await editor.getByRole('button', { name: 'Create event', exact: true }).click(); await expect(editor).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to original event', exact: true })).toHaveAttribute('href', href);
    expect(f.get(original.snapshot.event.source_id)).toEqual(before); expect(f.requests[0]?.creation_id).toBe(kept.values.creationId); expect(f.providerCalls()).toBe(2);
  } finally { await f.dispose(); }
});

test('keeps an email event on Cancel and resumes with its source link and exact return', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-31T12:00Z')); const f = await installMailCalendarEventFixture(page);
  try {
    const href = serializeSourceRecordAddress(f.source()); await go(page, href);
    await page.locator('.data-mail-message').getByRole('button', { name: 'Create event', exact: true }).click();
    const editor = form(page, 'Event from email'); await editor.getByLabel('Starts', { exact: true }).fill('2026-11-02T09:00'); await editor.getByLabel('Ends', { exact: true }).fill('2026-11-02T10:00');
    const notes = await editor.getByLabel('Notes (optional)', { exact: true }).inputValue();
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await later(page).click(); await expect(editor).toHaveCount(0);
    await expect(page.locator('.data-mail-message')).toBeVisible(); expect(new URL(page.url()).hash).toBe(href);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor.getByLabel('Notes (optional)', { exact: true })).toHaveValue(notes); await expect(editor.getByRole('link', { name: f.message().subject, exact: true })).toHaveAttribute('href', href);
    expect(f.requests).toEqual([]); await editor.getByRole('button', { name: 'Create event', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Back to email', exact: true })).toHaveAttribute('href', href); expect(f.writes).toEqual([]); expect(f.requests[0]?.description).toBe(notes);
  } finally { await f.dispose(); }
});

test('keeps time for a task on Cancel and resumes without changing the task or its return', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-31T12:00Z')); const f = await installTaskCalendarFixture(page);
  try {
    const before = f.task.task(); await go(page, '#data/task/task-one');
    await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Schedule time', exact: true }).click();
    const editor = form(page, 'Time for task'); await editor.getByLabel('Starts', { exact: true }).fill('2026-11-02T09:00'); await editor.getByLabel('Ends', { exact: true }).fill('2026-11-02T10:00');
    const notes = await editor.getByLabel('Notes (optional)', { exact: true }).inputValue();
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await later(page).click(); await expect(editor).toHaveCount(0);
    await expect(page.locator('.work-entity-task-reader')).toBeVisible(); expect(new URL(page.url()).hash).toBe('#data/task/task-one');
    await returnToCalendar(page); await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor.getByLabel('Notes (optional)', { exact: true })).toHaveValue(notes); expect(f.calendar.requests).toEqual([]);
    await editor.getByRole('button', { name: 'Create event', exact: true }).click();
    await page.getByRole('link', { name: 'Back to task', exact: true }).click(); await expect(page.locator('.work-entity-task-reader')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#data/task/task-one'); expect(f.task.task()).toEqual(before); expect(f.task.writes).toEqual([]); expect(f.calendar.requests[0]?.description).toBe(notes);
  } finally { await f.dispose(); }
});
