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

const comparison = (page: Page) => page.getByRole('region', { name: 'Compare event edits', exact: true });
const version = (page: Page, field: string) => comparison(page).getByRole('combobox', { name: `${field}: which version?`, exact: true });
const resume = async (page: Page) => { await kept(page).getByRole('button', { name: 'Resume edits', exact: true }).click(); await expect(comparison(page)).toBeVisible(); };
const change = (f: Awaited<ReturnType<typeof boot>>, patch: Parameters<Awaited<ReturnType<typeof boot>>['seed']>[2]) => f.seed('local', 'event-1', { ...f.get().event, ...patch });

test('keeps independent note and location edits with the latest saved time, checkpoints the new review and saves explicitly', async ({ page }, info) => {
  const f = await boot(page);
  try {
    await field(page, 'description').fill('My kept notes'); await field(page, 'location').fill('My room'); await reload(page);
    await change(f, { summary: 'Saved title', start_at: Date.parse('2026-10-28T18:00:23.456Z'), end_at: Date.parse('2026-10-28T19:00:36.789Z') }); const fresh = f.get(); await resume(page);
    await expect(comparison(page)).toContainText('Your edits will be carried over'); await expect(comparison(page)).toContainText('The saved change will be kept');
    await expect(comparison(page).getByRole('button', { name: 'Prepare draft', exact: true })).toBeEnabled(); expect(f.writes).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: info.outputPath('calendar-comparison-phone-dark.png'), fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await comparison(page).getByRole('button', { name: 'Prepare draft', exact: true }).click(); await expect(field(page, 'summary')).toHaveValue('Saved title');
    await expect(field(page, 'description')).toHaveValue('My kept notes'); await expect(field(page, 'location')).toHaveValue('My room'); await expect(field(page, 'start')).toHaveValue('2026-10-28T11:00');
    expect(f.writes).toEqual([]); await reload(page); await kept(page).getByRole('button', { name: 'Resume edits', exact: true }).click();
    await expect(field(page, 'description')).toHaveValue('My kept notes'); await expect(comparison(page)).toHaveCount(0); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.calendar-event')).toContainText('Event saved.'); expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ expected_version: fresh.resource_version, expected_incarnation: fresh.incarnation, patch: { description: 'My kept notes', location: 'My room' } });
    expect(f.get().event.start_at).toBe(fresh.event.start_at); expect(f.get().event.end_at).toBe(fresh.event.end_at);
  } finally { await f.dispose(); }
});

test('requires each conflict choice, keeps the focused select connected, and reapplies the whole chosen interval', async ({ page }) => {
  const f = await boot(page);
  try {
    await field(page, 'summary').fill('My title'); await field(page, 'description').fill('My notes'); await field(page, 'end').fill('2026-10-28T10:30'); await reload(page);
    await change(f, { summary: 'Saved title', description: 'Saved notes', start_at: Date.parse('2026-10-28T18:00Z'), end_at: Date.parse('2026-10-28T19:00Z') }); const fresh = f.get(); await resume(page);
    const prepare = comparison(page).getByRole('button', { name: 'Prepare draft', exact: true }); await expect(prepare).toBeDisabled();
    const title = version(page, 'Title'); await title.focus(); const input = await title.elementHandle(); await title.selectOption('saved');
    await expect(title).toBeFocused(); expect(await input!.evaluate(node => node.isConnected)).toBe(true); await version(page, 'Notes').selectOption('mine'); await expect(prepare).toBeDisabled();
    await version(page, 'Dates and times').selectOption('mine'); await expect(prepare).toBeEnabled(); expect(f.writes).toEqual([]); await prepare.click();
    await expect(field(page, 'summary')).toHaveValue('Saved title'); await expect(field(page, 'description')).toHaveValue('My notes'); await expect(field(page, 'start')).toHaveValue('2026-10-28T09:00');
    await expect(field(page, 'end')).toHaveValue('2026-10-28T10:30'); await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.locator('.calendar-event')).toContainText('Event saved.');
    expect(f.writes).toHaveLength(1); expect(f.writes[0]).toMatchObject({ expected_version: fresh.resource_version, patch: { description: 'My notes', start_at: Date.parse('2026-10-28T16:00Z'), end_at: Date.parse('2026-10-28T17:30Z') } });
    expect(f.writes[0]!.patch.summary).toBeUndefined();
  } finally { await f.dispose(); }
});

test('refreshes another changed event and retires its old selections before preparing a new draft', async ({ page }) => {
  const f = await boot(page);
  try {
    await field(page, 'summary').fill('My title'); await reload(page); await change(f, { summary: 'First saved title' }); await resume(page); await version(page, 'Title').selectOption('mine');
    const oldToken = await version(page, 'Title').getAttribute('data-calendar-conflict-token');
    await change(f, { summary: 'Newer saved title', description: 'Newer saved notes' }); const fresh = f.get(); await comparison(page).getByRole('button', { name: 'Prepare draft', exact: true }).click();
    await expect(kept(page).getByRole('alert')).toContainText('changed again'); await expect(comparison(page)).toContainText('Newer saved title'); await expect(version(page, 'Title')).toHaveValue('');
    expect(await version(page, 'Title').getAttribute('data-calendar-conflict-token')).not.toBe(oldToken); await expect(comparison(page).getByRole('button', { name: 'Prepare draft', exact: true })).toBeDisabled();
    await version(page, 'Title').selectOption('mine'); await comparison(page).getByRole('button', { name: 'Prepare draft', exact: true }).click();
    await expect(field(page, 'description')).toHaveValue('Newer saved notes'); await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.locator('.calendar-event')).toContainText('Event saved.');
    expect(f.writes[0]).toMatchObject({ expected_version: fresh.resource_version, patch: { summary: 'My title' } });
  } finally { await f.dispose(); }
});

test('cancels comparison without changing the recovery and fences a prepare read after navigating away', async ({ page }) => {
  const f = await boot(page);
  try {
    await field(page, 'description').fill('Kept notes'); await reload(page); await change(f, { location: 'Saved room' }); await resume(page);
    const original = await stored(page); await comparison(page).getByRole('button', { name: 'Cancel comparison', exact: true }).click();
    await expect(kept(page).getByRole('button', { name: 'Resume edits', exact: true })).toBeFocused(); expect(await stored(page)).toEqual(original);
    await resume(page); await page.keyboard.press('Escape'); await expect(comparison(page)).toHaveCount(0); expect(await stored(page)).toEqual(original);
    await resume(page); f.holdNextRead(); await comparison(page).getByRole('button', { name: 'Prepare draft', exact: true }).click(); await expect.poll(f.readPending).toBe(true);
    await page.evaluate(() => window.__app.setHash('#data/task')); await expect(page.getByRole('tab', { name: 'Tasks', exact: true })).toHaveAttribute('aria-selected', 'true');
    const completed = f.completedEventReads(); f.releaseRead(); await expect.poll(f.completedEventReads).toBeGreaterThan(completed);
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await expect(field(page, 'summary')).toHaveCount(0); expect(await stored(page)).toEqual(original); expect(f.writes).toEqual([]);
  } finally { await f.dispose(); }
});

test('retains the original edits after a checkpoint failure and permits an explicit retry', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('recued.calendar.edit-recovery.v1:') && document.documentElement.dataset.comparisonStorageBlocked === '1') throw new DOMException('Full', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  const f = await boot(page);
  try {
    await field(page, 'description').fill('Kept notes'); await reload(page); await change(f, { location: 'Saved room' }); await resume(page); const original = await stored(page);
    await page.evaluate(() => { document.documentElement.dataset.comparisonStorageBlocked = '1'; }); await comparison(page).getByRole('button', { name: 'Prepare draft', exact: true }).click();
    await expect(kept(page).getByRole('alert')).toContainText('prepared draft could not be kept'); expect(await stored(page)).toEqual(original); expect(f.writes).toEqual([]);
    await page.evaluate(() => { document.documentElement.dataset.comparisonStorageBlocked = '0'; }); await comparison(page).getByRole('button', { name: 'Prepare draft', exact: true }).click();
    await expect(field(page, 'description')).toHaveValue('Kept notes'); await expect(field(page, 'location')).toHaveValue('Saved room'); expect(f.writes).toEqual([]);
  } finally { await f.dispose(); }
});

test('reapplies a repeated-hour interval without rounding an untouched endpoint or choosing the other offset', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-01T08:50Z'));
  const f = await installCalendarRescheduleFixture(page, Date.parse('2026-11-01T08:50Z'));
  try {
    const start = Date.parse('2026-11-01T08:15:12.345Z'), end = Date.parse('2026-11-01T09:30:12.567Z');
    await f.seed('local', 'event-1', { start_at: start, end_at: Date.parse('2026-11-01T08:45:12.345Z') }); await openEvent(page, f.get().record.record_id);
    await page.getByRole('button', { name: 'Edit event', exact: true }).click(); await field(page, 'end').fill('2026-11-01T01:30:12.567'); await field(page, 'endChoice').selectOption(String(end)); await reload(page);
    await change(f, { start_at: Date.parse('2026-11-01T09:15:45.678Z'), end_at: Date.parse('2026-11-01T09:45:45.678Z') }); const fresh = f.get(); await resume(page);
    await expect(comparison(page)).toContainText('PDT'); await expect(comparison(page)).toContainText('PST'); await version(page, 'Dates and times').selectOption('mine');
    await comparison(page).getByRole('button', { name: 'Prepare draft', exact: true }).click(); await expect(field(page, 'startChoice')).toHaveValue(String(start)); await expect(field(page, 'endChoice')).toHaveValue(String(end));
    await expect(field(page, 'start')).toHaveValue('2026-11-01T01:15:12.345'); await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.locator('.calendar-event')).toContainText('Event saved.');
    expect(f.writes[0]).toMatchObject({ expected_version: fresh.resource_version, patch: { start_at: start, end_at: end } });
  } finally { await f.dispose(); }
});
