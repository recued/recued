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


const tasks = (page: Page) => page.getByRole('tab', { name: 'Tasks', exact: true });
const keepLater = (page: Page) => page.getByRole('button', { name: 'Keep edits for later', exact: true });

test('keeps exact latest edits while switching tasks, supports all three keyboard choices and resumes through Universal Search', async ({ page }, info) => {
  const f = await boot(page);
  try {
    await field(page, 'summary').fill('Kestrel planning'); await field(page, 'description').fill('Latest handoff notes'); await field(page, 'end').fill('2026-10-28T10:30:12.567');
    await tasks(page).click(); const dialog = page.getByRole('alertdialog', { name: 'Leave this event?', exact: true }); await expect(dialog).toBeVisible();
    const editing = page.getByRole('button', { name: 'Keep editing', exact: true }), discard = page.getByRole('button', { name: 'Discard changes', exact: true });
    await expect(editing).toBeFocused(); await page.keyboard.press('Tab'); await expect(keepLater(page)).toBeFocused(); await page.keyboard.press('Tab'); await expect(discard).toBeFocused();
    await page.keyboard.press('Tab'); await expect(editing).toBeFocused(); await page.keyboard.press('Shift+Tab'); await expect(discard).toBeFocused(); await page.keyboard.press('Escape');
    await expect(field(page, 'end')).toBeFocused(); await expect(field(page, 'summary')).toHaveValue('Kestrel planning'); expect(f.writes).toEqual([]);
    await tasks(page).click(); await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: info.outputPath('keep-event-edits-phone.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.setViewportSize({ width: 1280, height: 900 }); await keepLater(page).click();
    await expect(tasks(page)).toHaveAttribute('aria-selected', 'true'); expect(f.writes).toEqual([]); await expect.poll(() => stored(page)).toHaveLength(1);
    await page.evaluate(() => window.__app.setHash('#data/search')); await page.getByRole('searchbox', { name: 'Search everything', exact: true }).fill('Kestrel planning');
    const result = page.getByRole('region', { name: 'Unfinished work search results', exact: true }); await expect(result).toContainText('Kestrel planning'); await result.locator('[data-recovery-draft-key]').click();
    await kept(page).getByRole('button', { name: 'Resume edits', exact: true }).click(); await expect(field(page, 'summary')).toHaveValue('Kestrel planning');
    await expect(field(page, 'description')).toHaveValue('Latest handoff notes'); await expect(field(page, 'end')).toHaveValue('2026-10-28T10:30:12.567'); expect(f.writes).toEqual([]);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.locator('.calendar-event')).toContainText('Event saved.');
    expect(f.writes).toHaveLength(1); expect(f.writes[0]!.patch).toMatchObject({ summary: 'Kestrel planning', description: 'Latest handoff notes', end_at: Date.parse('2026-10-28T17:30:12.567Z') });
  } finally { await f.dispose(); }
});

test('stays in the editor after failed persistence or read-back and follows the destination only after retry succeeds', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem, getItem = Storage.prototype.getItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('recued.calendar.edit-recovery.v1:') && document.documentElement.dataset.keepWriteBlocked === '1') throw new DOMException('Full', 'QuotaExceededError'); setItem.call(this, key, value); };
    Storage.prototype.getItem = function(key) { if (key.startsWith('recued.calendar.edit-recovery.v1:') && document.documentElement.dataset.keepReadBlocked === '1') throw new DOMException('Unavailable', 'SecurityError'); return getItem.call(this, key); };
  });
  const f = await boot(page);
  try {
    await page.evaluate(() => { document.documentElement.dataset.keepWriteBlocked = '1'; }); await field(page, 'description').fill('The latest unflushed notes'); await tasks(page).click(); await keepLater(page).click();
    await expect(page.getByRole('alertdialog').getByRole('alert')).toContainText('could not be confirmed'); await expect(page.getByRole('alertdialog')).toBeVisible(); await expect(tasks(page)).toHaveAttribute('aria-selected', 'false');
    await page.evaluate(() => { document.documentElement.dataset.keepWriteBlocked = '0'; }); await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await field(page, 'description').fill('The final notes after retry'); await expect(page.locator('[data-calendar-edit-recovery-status]')).toHaveText('Event edits kept in this tab.');
    await page.evaluate(() => { document.documentElement.dataset.keepReadBlocked = '1'; }); await tasks(page).click(); await keepLater(page).click(); await expect(page.getByRole('alertdialog').getByRole('alert')).toContainText('could not be confirmed');
    await expect(page.getByRole('alertdialog')).toBeVisible(); expect(f.writes).toEqual([]);
    await page.evaluate(() => { document.documentElement.dataset.keepReadBlocked = '0'; }); await keepLater(page).click(); await expect(tasks(page)).toHaveAttribute('aria-selected', 'true');
    await page.evaluate(() => window.__app.setHash('#data/calendar')); await kept(page).getByRole('link', { name: 'Review event edits', exact: true }).click();
    await kept(page).getByRole('button', { name: 'Resume edits', exact: true }).click(); await expect(field(page, 'description')).toHaveValue('The final notes after retry'); expect(f.writes).toEqual([]);
  } finally { await f.dispose(); }
});

test('keeps an interrupted save unchanged while leaving and checks its saved result without sending another write', async ({ page }) => {
  const f = await boot(page);
  try {
    await field(page, 'summary').fill('Saved through an interrupted reply'); f.loseNextReply(); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved event', exact: true })).toBeFocused(); const original = await stored(page); expect(original[0]?.status).toBe('unknown');
    await tasks(page).click(); await expect(page.getByRole('alertdialog')).toContainText('earlier save may still complete'); await keepLater(page).click(); await expect(tasks(page)).toHaveAttribute('aria-selected', 'true');
    expect(await stored(page)).toEqual(original); expect(f.writes).toHaveLength(1); await page.evaluate(() => window.__app.setHash('#data/calendar'));
    await kept(page).getByRole('link', { name: 'Review event edits', exact: true }).click(); await expect(kept(page)).toContainText('Save was not confirmed');
    await kept(page).getByRole('button', { name: 'Check saved event', exact: true }).click(); await expect(page.locator('.calendar-event')).toContainText('Your changes are saved. No changes were sent again.');
    expect(f.writes).toHaveLength(1); await expect.poll(() => stored(page)).toEqual([]);
  } finally { await f.dispose(); }
});

test('keeps the recovery when closing the editor or reloading the saved event and still compares a changed version', async ({ page }) => {
  const f = await boot(page);
  try {
    await field(page, 'description').fill('Keep through Cancel and Reload'); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await keepLater(page).click();
    await expect(field(page, 'description')).toHaveCount(0); await expect(kept(page)).toContainText('Customer planning'); expect(f.writes).toEqual([]);
    await kept(page).getByRole('button', { name: 'Resume edits', exact: true }).click(); await expect(field(page, 'description')).toHaveValue('Keep through Cancel and Reload'); await f.changeSavedTitle();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.locator('.calendar-event-error')).toContainText('changed since you opened');
    await page.getByRole('button', { name: 'Reload saved values', exact: true }).click(); await keepLater(page).click(); await expect(field(page, 'description')).toHaveCount(0);
    await expect(page.locator('.calendar-event')).toContainText('Changed elsewhere'); await expect.poll(() => stored(page)).toHaveLength(1);
    await kept(page).getByRole('button', { name: 'Resume edits', exact: true }).click(); await expect(page.getByRole('region', { name: 'Compare event edits', exact: true })).toContainText('Keep through Cancel and Reload');
    expect(f.writes).toHaveLength(1); expect(f.get().event.description).toBe('Original notes');
  } finally { await f.dispose(); }
});
