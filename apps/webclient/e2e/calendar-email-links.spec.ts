import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installCalendarEmailFixture } from './helpers/calendar-email-fixture.js';
import { serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 700 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installCalendarEmailFixture>>;
const event = (page: Page) => page.locator('.calendar-event');
const email = (page: Page) => page.getByRole('article', { name: 'Email message', exact: true });
const linked = (page: Page) => page.locator('[data-source-linked-from]');
const events = (page: Page) => linked(page).getByRole('region', { name: 'Linked calendar events', exact: true });
const openEvent = (page: Page, title = 'Planning from email') => linked(page).getByRole('button', { name: 'Open event ' + title, exact: true });
const openMail = (page: Page) => event(page).getByRole('button', { name: 'Open original email', exact: true });
const scroll = (page: Page) => linked(page).evaluate(node => {
  let host: HTMLElement | null = node.parentElement;
  while (host) { if (host.scrollHeight > host.clientHeight && /^(auto|scroll|overlay|hidden)$/.test(getComputedStyle(host).overflowY)) return host.scrollTop; host = host.parentElement; }
  return document.scrollingElement!.scrollTop;
});
const boot = async (page: Page, f: Fixture, hash = serializeSourceRecordAddress(f.source('mail'))) => {
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + hash);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const expand = async (page: Page) => { await linked(page).locator('summary').click(); await expect(openEvent(page)).toBeVisible(); };
const readOnly = (f: Fixture) => { expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]); };

test('opens the original email from each exact calendar account and returns to its event', async ({ page }) => {
  const f = await installCalendarEmailFixture(page);
  try {
    await boot(page, f, f.eventHash());
    await expect(openMail(page)).toBeVisible(); await openMail(page).press('Enter');
    await expect(email(page)).toContainText('Exact work email body.');
    await page.getByRole('button', { name: 'Back to event', exact: true }).click();
    await expect(openMail(page)).toBeFocused(); await expect(page).toHaveURL(new RegExp(f.eventHash() + '$'));
    await page.evaluate(hash => window.__app.setHash(hash), f.eventHash('home'));
    await openMail(page).click(); await expect(email(page)).toContainText('Other account body.');
    await page.getByRole('button', { name: 'Back to event', exact: true }).click();
    await expect(event(page)).toContainText('Other mailbox meeting'); await expect(openMail(page)).toBeFocused();
    readOnly(f);
  } finally { await f.dispose(); }
});

test('reopens the linked event and returns to the email with its Find, viewport and keyboard trigger intact', async ({ page }) => {
  const f = await installCalendarEmailFixture(page);
  try {
    for (let i = 0; i < 4; i++) f.seedNote('incoming-' + i, { title: 'Saved context ' + i, body: f.mailUrl() });
    await boot(page, f); await page.getByRole('button', { name: 'Find in email', exact: true }).click();
    const find = page.getByRole('searchbox', { name: 'Find in this email', exact: true }); await find.fill('work');
    await expand(page); await expect(events(page).locator('li')).toHaveCount(1);
    await expect(events(page)).toContainText('Planning'); await expect(events(page)).toContainText('November 1');
    await expect(events(page)).not.toContainText('Other mailbox meeting');
    await openEvent(page).click({ trial: true }); await openEvent(page).focus();
    const top = await scroll(page); await page.screenshot({ path: test.info().outputPath('linked-events-phone.png') });
    await openEvent(page).press('Enter'); await expect(event(page)).toContainText('Planning from email');
    await openMail(page).click(); await expect(find).toHaveValue('work'); await expect(openEvent(page)).toBeFocused();
    await expect.poll(() => scroll(page)).toBeCloseTo(top, 0);
    await openEvent(page).press('Enter'); await page.getByRole('button', { name: 'Back to email', exact: true }).click();
    await expect(openEvent(page)).toBeFocused(); await expect(find).toHaveValue('work');
    readOnly(f);
  } finally { await f.dispose(); }
});

test('pages events independently and refreshes cancellation, edits and removed explicit links', async ({ page }) => {
  const f = await installCalendarEmailFixture(page);
  try {
    const now = f.event().event.updated_at;
    for (let i = 0; i < 12; i++) {
      await f.seed('work', 'extra-' + i, { summary: 'Extra event ' + i, updated_at: now + i + 1 });
      await f.seed('work', 'wrong-' + i, { description: f.mailUrl('home'), updated_at: now + 100 + i });
      f.seedNote('note-' + i, { title: 'Incoming note ' + i, body: f.mailUrl() });
    }
    await boot(page, f); await linked(page).locator('summary').click();
    await expect(events(page).locator('li')).toHaveCount(10);
    const workRows = linked(page).locator('[data-linked-from-action="open"]'); await expect(workRows).toHaveCount(10);
    await events(page).getByRole('button', { name: 'More linked events', exact: true }).click();
    await expect(events(page).locator('li')).toHaveCount(13); await expect(workRows).toHaveCount(10);
    await linked(page).getByRole('button', { name: 'More linked records', exact: true }).click();
    await expect(workRows).toHaveCount(12); await expect(events(page).locator('li')).toHaveCount(13);
    await f.seed('work', 'extra-11', { summary: 'Cancelled planning', status: 'cancelled', updated_at: now + 500 });
    await linked(page).getByRole('button', { name: 'Refresh linked records', exact: true }).click();
    await expect(events(page).locator('li')).toHaveCount(10); await expect(events(page)).toContainText('Cancelled');
    await openEvent(page, 'Cancelled planning').click(); await expect(event(page)).toContainText('Cancelled');
    await page.getByRole('button', { name: 'Back to email', exact: true }).click();
    await openEvent(page, 'Cancelled planning').click(); await openMail(page).click();
    await expect(openEvent(page, 'Cancelled planning')).toBeFocused();
    await f.seed('work', 'extra-11', { description: 'Source link removed.', updated_at: now + 501 });
    await linked(page).getByRole('button', { name: 'Refresh linked records', exact: true }).click();
    await expect(openEvent(page, 'Cancelled planning')).toHaveCount(0); readOnly(f);
  } finally { await f.dispose(); }
});

test('refuses stale event links and replacement calendars, and retires an email open after browser Back', async ({ page }) => {
  const f = await installCalendarEmailFixture(page);
  try {
    await boot(page, f); await expand(page);
    await f.seed('work', f.eventId, { description: 'Link removed.' }); await openEvent(page).click();
    await expect(linked(page).getByRole('alert')).toContainText('no longer links'); await expect(event(page)).toHaveCount(0);
    await f.seed(); await linked(page).getByRole('button', { name: 'Refresh linked records', exact: true }).click();
    await expect(openEvent(page)).toBeVisible(); f.replaceCalendar(); await openEvent(page).click();
    await expect(linked(page).getByRole('alert')).toContainText('calendar changed'); await expect(event(page)).toHaveCount(0);
    await linked(page).getByRole('button', { name: 'Refresh linked records', exact: true }).click();
    await openEvent(page).click(); await expect(openMail(page)).toBeVisible();
    f.hold('collection.calendar.event.get', ''); await openMail(page).click(); await expect.poll(f.waiting).toBe(true);
    await page.goBack(); await expect(openEvent(page)).toBeFocused(); f.release();
    await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.includes('collection.calendar.event.get:'));
    await expect(email(page)).toContainText('Exact work email body.'); await expect(event(page)).toHaveCount(0);
    f.removeEvent(); await openEvent(page).click(); await expect(linked(page).getByRole('alert')).toBeVisible(); readOnly(f);
  } finally { await f.dispose(); }
});

test('opens a source email beyond a truncated description while excluding external deployment links', async ({ page }) => {
  const f = await installCalendarEmailFixture(page);
  try {
    await f.seed('work', f.eventId, { description: 'Long meeting context. '.repeat(15000) + '\nOriginal email: ' + f.mailUrl() });
    await boot(page, f, f.eventHash()); await expect(event(page)).toContainText('Description preview');
    await openMail(page).click(); await expect(email(page)).toContainText('Exact work email body.');
    await page.getByRole('button', { name: 'Back to event', exact: true }).click(); await expect(openMail(page)).toBeFocused();
    await f.seed('work', f.eventId, { description: 'Original email: ' + f.mailUrl().replace('127.0.0.1', 'external.invalid') });
    await page.evaluate(hash => window.__app.setHash(hash), '#data/calendar');
    await page.evaluate(hash => window.__app.setHash(hash), f.eventHash());
    await expect(event(page)).toContainText('external.invalid'); await expect(openMail(page)).toHaveCount(0); readOnly(f);
  } finally { await f.dispose(); }
});

test('rechecks the link when a slower display read arrives after the incoming result was verified', async ({ page }) => {
  const f = await installCalendarEmailFixture(page);
  try {
    await boot(page, f); await expand(page);
    f.holdEventDisplay(); await openEvent(page).click(); await expect.poll(f.waiting).toBe(true);
    await f.seed('work', f.eventId, { description: 'This event no longer refers to the email.' }); f.release();
    await expect(event(page).getByRole('alert')).toContainText('no longer links');
    await expect(openMail(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to email', exact: true }).click();
    await expect(email(page)).toContainText('Exact work email body.'); readOnly(f);
  } finally { await f.dispose(); }
});

test('keeps the already-loaded older conversation window and its index position across an event detour', async ({ page }) => {
  const f = await installCalendarEmailFixture(page); f.showMailHistory();
  try {
    await boot(page, f);
    await page.getByRole('button', { name: 'Load older messages', exact: true }).click();
    const index = page.locator('.data-mail-conversation-index');
    await expect(index.locator('[data-mail-record]')).toHaveCount(40);
    await index.evaluate(node => { node.scrollTop = 300; }); const top = await index.evaluate(node => node.scrollTop);
    await expand(page); await openEvent(page).click(); await expect(openMail(page)).toBeVisible();
    await page.getByRole('button', { name: 'Back to email', exact: true }).click();
    await expect(openEvent(page)).toBeFocused(); await expect(index.locator('[data-mail-record]')).toHaveCount(40);
    await expect.poll(() => index.evaluate(node => node.scrollTop)).toBeCloseTo(top, 0); readOnly(f);
  } finally { await f.dispose(); }
});
