import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installCalendarRescheduleFixture } from './helpers/calendar-reschedule-fixture.js';
import { serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks();
test.use({ timezoneId: 'Asia/Tokyo' });
const field = (page: Page, name: string) => page.locator(`[data-calendar-event-field="${name}"]`);
const kept = (page: Page) => page.getByRole('region', { name: 'Unfinished event edits', exact: true });
const eventHref = (recordId: string) => serializeSourceRecordAddress({ tab: 'calendar', collectionSlug: 'local', recordId });
const reload = async (page: Page) => {
  const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); };
  page.on('dialog', accept); try { await page.reload(); } finally { page.off('dialog', accept); }
  await page.waitForFunction(() => window.__app?.ready === true);
};
const openEvent = async (page: Page, recordId: string) => {
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed&server_profiles=multiple${eventHref(recordId)}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('.calendar-event')).toContainText('Customer planning');
};
const boot = async (page: Page) => {
  await page.clock.setFixedTime(new Date('2026-10-28T12:00Z'));
  const fixture = await installCalendarRescheduleFixture(page); await openEvent(page, fixture.get().record.record_id);
  await page.getByRole('button', { name: 'Edit event', exact: true }).click(); return fixture;
};
const stored = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('recued.calendar.edit-recovery.v1:'))
  .flatMap(key => JSON.parse(sessionStorage.getItem(key)!) as Array<{ id: string; status: string; values: { draft: { summary: string } } }>));

test('recovers the exact chosen interval and other edits after an immediate reload, then saves once', async ({ page }, info) => {
  const f = await boot(page);
  try {
    await field(page, 'summary').fill('Recovered planning'); await field(page, 'location').fill('Room 5'); await field(page, 'description').fill('Keep these details.');
    await page.getByRole('button', { name: 'Find another time', exact: true }).click();
    const finder = page.getByRole('region', { name: 'Find another time', exact: true }); await finder.getByRole('button', { name: 'Find times', exact: true }).click();
    const choices = finder.getByRole('region', { name: 'Suggested times', exact: true }); await expect(choices).toContainText('6 suggested times'); await choices.getByRole('button').nth(1).click();
    await reload(page); await expect(kept(page)).toContainText('Recovered planning'); expect(f.writes).toEqual([]);
    await kept(page).getByRole('button', { name: 'Resume edits', exact: true }).click(); await expect(field(page, 'summary')).toHaveValue('Recovered planning');
    await expect(field(page, 'location')).toHaveValue('Room 5'); await expect(field(page, 'description')).toHaveValue('Keep these details.');
    await expect(field(page, 'start')).toHaveValue('2026-10-28T11:00'); await expect(field(page, 'end')).toHaveValue('2026-10-28T12:00:12.567');
    await expect(field(page, 'summary')).toBeFocused(); await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: info.outputPath('recovered-event-phone-dark.png'), fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.locator('.calendar-event')).toContainText('Event saved.');
    expect(f.writes).toHaveLength(1); expect(f.writes[0]!.patch).toMatchObject({ summary: 'Recovered planning', description: 'Keep these details.', location: 'Room 5',
      start_at: Date.parse('2026-10-28T18:00Z'), end_at: Date.parse('2026-10-28T19:00:12.567Z') }); await expect.poll(() => stored(page)).toEqual([]);
  } finally { await f.dispose(); }
});

test('recovers the second reading of a repeated hour with fractional seconds', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-01T08:50Z'));
  const f = await installCalendarRescheduleFixture(page, Date.parse('2026-11-01T08:50Z'));
  try {
    await f.seed('local', 'event-1', { start_at: Date.parse('2026-11-01T08:15Z'), end_at: Date.parse('2026-11-01T08:45:12.345Z') }); await openEvent(page, f.get().record.record_id);
    await page.getByRole('button', { name: 'Edit event', exact: true }).click(); await page.getByRole('button', { name: 'Find another time', exact: true }).click();
    const finder = page.getByRole('region', { name: 'Find another time', exact: true });
    await finder.getByLabel('Through date', { exact: true }).fill('2026-11-01'); await finder.getByLabel('Working day starts', { exact: true }).fill('01:00');
    await finder.getByLabel('Working day ends', { exact: true }).fill('03:00'); await finder.getByLabel('Weekdays only', { exact: true }).uncheck();
    await finder.getByRole('button', { name: 'Find times', exact: true }).click(); const choices = finder.getByRole('region', { name: 'Suggested times', exact: true });
    await expect(choices.getByRole('button').first()).toContainText('PST'); await choices.getByRole('button').first().click(); await reload(page);
    await kept(page).getByRole('button', { name: 'Resume edits', exact: true }).click(); await expect(field(page, 'startChoice')).toHaveValue(String(Date.parse('2026-11-01T09:00Z')));
    await expect(field(page, 'end')).toHaveValue('2026-11-01T01:30:12.345'); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.calendar-event')).toContainText('Event saved.'); expect(f.writes[0]!.patch).toEqual({ start_at: Date.parse('2026-11-01T09:00Z'), end_at: Date.parse('2026-11-01T09:30:12.345Z') });
  } finally { await f.dispose(); }
});

test('finds kept edits from the agenda and Universal Search, then resumes the exact event', async ({ page }) => {
  const f = await boot(page);
  try {
    await field(page, 'summary').fill('Kestrel handoff'); await field(page, 'description').fill('Unique reschedule notes'); await reload(page);
    await page.evaluate(() => window.__app.setHash('#data/calendar')); await expect(kept(page)).toContainText('Kestrel handoff');
    await expect(kept(page).getByRole('link', { name: 'Review event edits', exact: true })).toHaveAttribute('href', eventHref(f.get().record.record_id));
    await page.evaluate(() => window.__app.setHash('#data/search')); const search = page.getByRole('searchbox', { name: 'Search everything', exact: true }); await search.fill('Kestrel handoff');
    const result = page.locator('.rq-draft-group').filter({ hasText: 'Kestrel handoff' }); await expect(result).toContainText('Kestrel handoff');
    await result.locator('[data-recovery-draft-key]').click(); await expect(kept(page).getByRole('button', { name: 'Resume edits', exact: true })).toBeVisible();
    await kept(page).getByRole('button', { name: 'Resume edits', exact: true }).click(); await expect(field(page, 'summary')).toHaveValue('Kestrel handoff'); expect(f.writes).toEqual([]);
  } finally { await f.dispose(); }
});

test('retains a changed-event draft for copying and discards only its recovery copy', async ({ page }, info) => {
  const f = await boot(page);
  try {
    await field(page, 'summary').fill('My kept planning'); await field(page, 'description').fill('My kept notes'); await reload(page); await f.changeSavedTitle();
    await kept(page).getByRole('button', { name: 'Resume edits', exact: true }).click(); await expect(kept(page).getByRole('region', { name: 'Compare event edits', exact: true })).toBeVisible();
    await expect(field(page, 'summary')).toHaveCount(0); await expect(page.locator('.calendar-event')).toContainText('Changed elsewhere'); await kept(page).getByText('Review kept edits', { exact: true }).click();
    await expect(kept(page).getByLabel('Kept title', { exact: true })).toHaveValue('My kept planning'); await expect(kept(page).getByRole('textbox', { name: 'Kept description', exact: true })).toHaveValue('My kept notes');
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: info.outputPath('kept-edits-conflict-phone.png'), fullPage: true });
    await kept(page).getByRole('button', { name: 'Discard edits', exact: true }).click(); await kept(page).getByRole('button', { name: 'Keep edits', exact: true }).click();
    await expect.poll(() => stored(page)).toHaveLength(1); await kept(page).getByRole('button', { name: 'Discard edits', exact: true }).click();
    await kept(page).getByRole('button', { name: 'Discard recovery copy', exact: true }).click(); await expect.poll(() => stored(page)).toEqual([]);
    expect(f.get().event.summary).toBe('Changed elsewhere'); expect(f.writes).toEqual([]);
  } finally { await f.dispose(); }
});

test('keeps edits when a read fails or the original calendar connection is replaced', async ({ page }) => {
  const f = await boot(page);
  try {
    await field(page, 'summary').fill('Kept despite replacement'); await reload(page); f.setReadAvailable(false);
    await kept(page).getByRole('button', { name: 'Resume edits', exact: true }).click(); await expect(kept(page).getByRole('alert')).toContainText('unavailable');
    f.setReadAvailable(true); f.replaceCalendar(); await kept(page).getByRole('button', { name: 'Resume edits', exact: true }).click();
    await expect(kept(page).getByRole('alert')).toContainText('was replaced'); await expect.poll(() => stored(page)).toHaveLength(1); expect(f.writes).toEqual([]);
  } finally { await f.dispose(); }
});

test('checks a save whose reply was lost after reload without issuing another update', async ({ page }) => {
  const f = await boot(page);
  try {
    await field(page, 'summary').fill('Saved through lost reply'); f.loseNextReply(); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved event', exact: true })).toBeVisible(); await reload(page);
    await expect(kept(page)).toContainText('Save was not confirmed'); await kept(page).getByRole('button', { name: 'Check saved event', exact: true }).click();
    await expect(page.locator('.calendar-event')).toContainText('Your changes are saved. No changes were sent again.'); await expect.poll(() => stored(page)).toEqual([]);
    expect(f.writes).toHaveLength(1); expect(f.get().event.summary).toBe('Saved through lost reply');
  } finally { await f.dispose(); }
});

test('keeps an in-flight update uncertain until it is visible and never automatically resends it', async ({ page }) => {
  const f = await boot(page);
  try {
    await field(page, 'summary').fill('Pending planning'); f.holdNextSave(); await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect.poll(f.savePending).toBe(true);
    await reload(page); await kept(page).getByRole('button', { name: 'Check saved event', exact: true }).click();
    await expect(kept(page).getByRole('alert')).toContainText('earlier save is not confirmed'); await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
    expect(f.writes).toHaveLength(1); f.releaseSave(); await expect.poll(() => f.get().event.summary).toBe('Pending planning');
    await kept(page).getByRole('button', { name: 'Check saved event', exact: true }).click(); await expect.poll(() => stored(page)).toEqual([]); expect(f.writes).toHaveLength(1);
  } finally { await f.dispose(); }
});

test('shows storage failure without replacing typing and blocks a save until the exact review can be kept', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('recued.calendar.edit-recovery.v1:') && document.documentElement.dataset.editRecoveryBlocked === '1') throw new DOMException('Full', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  const f = await boot(page);
  try {
    await page.evaluate(() => { document.documentElement.dataset.editRecoveryBlocked = '1'; });
    await field(page, 'summary').fill('Retain focused typing'); const input = await field(page, 'summary').elementHandle();
    await expect(page.locator('[data-calendar-edit-recovery-status]')).toContainText('could not be kept'); await expect(field(page, 'summary')).toBeFocused(); expect(await input!.evaluate(node => node.isConnected)).toBe(true);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.locator('.calendar-event-error')).toContainText('could not be kept before saving'); expect(f.writes).toEqual([]);
    await page.evaluate(() => { document.documentElement.dataset.editRecoveryBlocked = '0'; }); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.calendar-event')).toContainText('Event saved.'); expect(f.writes).toHaveLength(1);
  } finally { await f.dispose(); }
});
