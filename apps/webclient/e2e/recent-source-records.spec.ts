import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 900 } });
type Kind = 'mail' | 'calendar' | 'contact';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const panel = (page: Page) => page.getByRole('region', { name: 'Recently opened', exact: true });
const rows = (page: Page) => panel(page).locator('[data-recent-work-focus="open"]');
const input = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
const noun = (kind: Kind) => kind === 'mail' ? 'email' : kind === 'calendar' ? 'event' : kind;
const detail = (page: Page, kind: Kind) => page.locator(kind === 'mail' ? '.data-mail-message' : kind === 'calendar' ? '.calendar-event' : '[data-recued-data-contact-detail]');
const heading = (page: Page, kind: Kind, name: string) => (kind === 'mail' ? page.getByRole('region', { name: 'Email conversation', exact: true }) : detail(page, kind)).getByRole('heading', { name, exact: true });
const title = (f: Fixture, kind: Kind, slug = 'work') => kind === 'contact' ? f.person.name! : kind === 'mail' ? slug === 'work' ? 'Exact work email' : 'Other mailbox email' : slug === 'work' ? 'Exact work occurrence' : 'Other calendar occurrence';
const open = (page: Page, kind: Kind, name: string) => panel(page).getByRole('button', { name: `Open ${noun(kind)} ${name}`, exact: true });
const back = (page: Page) => page.getByRole('button', { name: /^(?:← )?Back to search$/, exact: true });
const route = async (page: Page, hash: string) => page.evaluate(hash => window.__app.setHash(hash), hash);
const search = async (page: Page) => { await route(page, '#data/search'); await expect(input(page)).toBeVisible(); };
const visit = async (page: Page, f: Fixture, kind: Kind, slug = 'work') => {
  await route(page, kind === 'contact' ? serializeShellRoute('data', 'contact', f.person.email) : serializeSourceRecordAddress(f.source(kind, slug)));
  await expect(heading(page, kind, title(f, kind, slug))).toBeVisible();
  if (kind === 'mail') await expect(detail(page, kind)).toContainText(slug === 'work' ? 'Exact work email body.' : 'Other account body.');
};
const boot = async (page: Page) => {
  const f = await installTaskNoteSourceFixture(page);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple&settle_reads=1#data/search`);
  await page.waitForFunction(() => window.__app?.ready === true); await expect(input(page)).toBeVisible(); return f;
};
const reload = async (page: Page) => {
  await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); await expect(input(page)).toBeVisible();
};

for (const kind of ['mail', 'calendar', 'contact'] as const) test(`recent ${kind} records survive reload, recheck their exact identity, and restore their history row`, async ({ page }, info) => {
  const f = await boot(page);
  try {
    await visit(page, f, kind); await search(page); await expect(rows(page)).toHaveCount(1);
    await expect(open(page, kind, title(f, kind))).toContainText(kind === 'contact' ? f.person.email : 'work');
    await reload(page); await expect(rows(page)).toHaveCount(1);
    if (kind === 'mail') f.updateMail('work', { subject: 'Fresh email subject' });
    if (kind === 'calendar') f.updateCalendar('work', { summary: 'Fresh event title' });
    if (kind === 'contact') f.contactReply(f.person.contact_id!, { ...f.person, name: 'Fresh contact name' });
    const fresh = kind === 'mail' ? 'Fresh email subject' : kind === 'calendar' ? 'Fresh event title' : 'Fresh contact name';
    await open(page, kind, title(f, kind)).focus(); await page.keyboard.press('Enter');
    if (kind === 'mail') await expect(detail(page, kind)).toContainText('Exact work email body.');
    else await expect(heading(page, kind, fresh)).toBeVisible();
    if (kind !== 'contact') await expect.poll(() => new URL(page.url()).hash).toBe(serializeSourceRecordAddress(f.source(kind)));
    await back(page).click(); await expect(open(page, kind, fresh)).toBeFocused(); await expect(rows(page)).toHaveCount(1);
    await open(page, kind, fresh).click(); await expect(detail(page, kind)).toBeVisible(); await page.goBack();
    await expect(open(page, kind, fresh)).toBeFocused(); await expect(input(page)).toHaveValue('');
    const stored = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('recued.work.recent.v1:')).map(key => sessionStorage.getItem(key)).join(''));
    expect(stored).not.toContain('Exact work email body.'); expect(stored).not.toContain('Keep the event context.');
    expect(f.calls.filter(call => ['collection.get', 'collection.mail.message.get', 'collection.calendar.event.get'].includes(call.method)).every(call => call.args.slug === 'work')).toBe(true);
    await page.screenshot({ path: info.outputPath(`recent-${kind}-phone.png`), fullPage: true });
    expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('separates matching provider ids across accounts, filters all five kinds, and removes or clears with useful focus', async ({ page }) => {
  const f = await boot(page);
  try {
    for (const kind of ['mail', 'calendar'] as const) for (const slug of ['work', 'home']) await visit(page, f, kind, slug);
    await visit(page, f, 'contact');
    await route(page, '#data/task/task-one'); await expect(page.locator('.work-entity-task-reader')).toBeVisible();
    f.seedNote('recent-note', { title: 'Saved note', body: 'Private note body' });
    await route(page, '#data/note/recent-note'); await expect(page.locator('.work-entity-note-reader')).toBeVisible(); await search(page);
    await expect(rows(page)).toHaveCount(7); await expect(panel(page).locator('img,script')).toHaveCount(0);
    for (const [kind, count] of [['mail', 2], ['calendar', 2], ['contact', 1], ['task', 1], ['note', 1]] as const) {
      await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption(kind); await expect(rows(page)).toHaveCount(count);
    }
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('mail');
    await panel(page).getByRole('button', { name: 'Remove email Exact work email from recently opened', exact: true }).click();
    await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('home');
    await expect(panel(page).getByRole('button', { name: 'Remove email Other mailbox email from recently opened', exact: true })).toBeFocused();
    await panel(page).getByRole('button', { name: 'Clear recently opened', exact: true }).click(); await expect(rows(page)).toHaveCount(0); await expect(input(page)).toBeFocused();
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('all'); await reload(page); await expect(panel(page)).toHaveCount(0);
    expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('restores search scroll and keyboard focus when returning to an already visible recent row', async ({ page }) => {
  const f = await boot(page);
  try {
    for (let index = 0; index < 7; index++) {
      const id = `scroll-${index}`; f.seedTask(id, { title: `Saved task ${index}: keep the full delivery and review context visible here` });
      await route(page, serializeShellRoute('data', 'task', id)); await expect(page.locator('.work-entity-task-reader')).toHaveAttribute('data-task-id', id);
    }
    await visit(page, f, 'calendar'); await search(page); await expect(rows(page)).toHaveCount(8);
    const host = page.locator('[data-recued-webclient-content]'), row = open(page, 'calendar', title(f, 'calendar'));
    await host.evaluate(node => { node.scrollTop = 80; }); await row.focus(); await row.scrollIntoViewIfNeeded();
    const top = await host.evaluate(node => node.scrollTop); expect(top).toBeGreaterThan(0);
    await row.press('Enter'); await expect(detail(page, 'calendar')).toBeVisible(); await back(page).click();
    await expect(row).toBeFocused(); await expect(row).toBeInViewport(); expect(await host.evaluate(node => node.scrollTop)).toBeCloseTo(top, -1);
    expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['mail', 'calendar', 'contact'] as const) test(`keeps a missing or replaced ${kind} entry available for removal without opening another identity`, async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, f, kind); await search(page); await reload(page);
    if (kind === 'mail') f.remove('mail', 'work', f.mailId);
    if (kind === 'calendar') f.replaceCalendar();
    if (kind === 'contact') f.contactReply(f.person.contact_id!, { ...f.person, merged_into: 'survivor@example.test' });
    await open(page, kind, title(f, kind)).click(); await expect(panel(page).getByRole('alert')).toBeVisible();
    await expect(detail(page, kind)).toHaveCount(0); await expect(rows(page)).toHaveCount(1); await expect(panel(page)).not.toContainText('Your draft');
    await panel(page).getByRole('button', { name: `Remove ${noun(kind)} ${title(f, kind)} from recently opened`, exact: true }).click();
    await expect(rows(page)).toHaveCount(0); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('retries an interrupted event read without leaving history or dropping the selected result type', async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, f, 'calendar'); await search(page); await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('calendar');
    f.failSource('collection.calendar.event.get', 'work'); await open(page, 'calendar', title(f, 'calendar')).click();
    await expect(panel(page).getByRole('alert')).toContainText('interrupted'); f.failSource('collection.calendar.event.get', 'work', false);
    await open(page, 'calendar', title(f, 'calendar')).click(); await expect(detail(page, 'calendar')).toBeVisible(); await back(page).click();
    await expect(page.getByRole('combobox', { name: 'Result type', exact: true })).toHaveValue('calendar');
    await expect(open(page, 'calendar', title(f, 'calendar'))).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const [kind, steering] of [['mail', 'remove'], ['calendar', 'type'], ['contact', 'route']] as const) test(`a held ${kind} read cannot take over after ${steering} and duplicate clicks share one preparation`, async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, f, kind); await search(page);
    const method = kind === 'contact' ? 'contact.get' : kind === 'mail' ? 'collection.mail.message.get' : 'collection.calendar.event.get';
    const id = kind === 'contact' ? f.person.contact_id! : '';
    if (kind === 'contact') f.hold(method, id); else f.holdSource(method, 'work');
    await open(page, kind, title(f, kind)).click(); await expect.poll(() => kind === 'contact' ? f.waiting() : f.sourceWaiting()).toBe(true);
    await open(page, kind, title(f, kind)).evaluate((node: HTMLButtonElement) => node.click());
    if (steering === 'remove') await panel(page).getByRole('button', { name: `Remove ${noun(kind)} ${title(f, kind)} from recently opened`, exact: true }).click();
    if (steering === 'type') await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('contact');
    if (steering === 'route') await route(page, '#chat');
    const settled = await page.evaluate(key => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === key).length, `${method}:${id}`);
    f.release(); f.releaseSource();
    await page.waitForFunction(({ key, before }) => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === key).length > before, { key: `${method}:${id}`, before: settled });
    await expect(detail(page, kind)).toHaveCount(0);
    if (steering === 'route') await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible(); else await expect(input(page)).toBeVisible();
    expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('a mail identity replaced between preparation and the reader read is rejected while retaining Back to search', async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, f, 'mail'); await search(page); f.holdSource('collection.get', 'work');
    await open(page, 'mail', title(f, 'mail')).click(); await expect.poll(() => f.sourceWaiting()).toBe(true);
    f.updateMail('work', { received_at: Date.parse('2030-01-01T00:00:00Z'), body: 'A different email must not appear.' }); f.releaseSource();
    await expect(page.getByRole('alert')).toContainText('different identity'); await expect(page.locator('body')).not.toContainText('A different email must not appear.');
    await back(page).click(); await expect(open(page, 'mail', title(f, 'mail'))).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['mail', 'calendar'] as const) test(`browser Back protects ${kind} edits before restoring the exact recent row`, async ({ page }) => {
  const f = await boot(page); if (kind === 'calendar') f.editableCalendar();
  try {
    await visit(page, f, kind); await search(page); await open(page, kind, title(f, kind)).click();
    if (kind === 'mail') {
      await detail(page, kind).getByRole('button', { name: 'Reply', exact: true }).click();
      await page.getByRole('dialog', { name: /Reply/ }).locator('[data-form-field="body"]').fill('Keep this reply draft.');
    } else {
      await detail(page, kind).getByRole('button', { name: 'Edit event', exact: true }).click();
      await detail(page, kind).locator('[data-calendar-event-field="summary"]').fill('Keep this event edit');
    }
    const prompts: string[] = []; page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(1); await expect(detail(page, kind)).toBeVisible();
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.accept(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(2); await expect(open(page, kind, title(f, kind))).toBeFocused();
    expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['mail', 'calendar'] as const) test(`a ${kind} note detour retains the original search return and both recent records`, async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, f, kind); await search(page); await open(page, kind, title(f, kind)).click();
    await detail(page, kind).getByRole('button', { name: 'Add note', exact: true }).click();
    const editor = page.locator('.work-entity-dialog[data-kind="note"][data-mode="create"]');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.work-entity-note-reader').getByRole('button', { name: `Back to ${noun(kind)}`, exact: true }).click();
    await back(page).click(); await expect(open(page, kind, title(f, kind))).toBeFocused();
    await expect(rows(page)).toHaveCount(2); expect(f.writes).toHaveLength(1); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});
