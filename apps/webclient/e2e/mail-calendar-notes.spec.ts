import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeSourceRecordAddress } from '../src/shell/route.js';
import { installMailCalendarEventFixture } from './helpers/mail-calendar-event-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Kind = 'mail' | 'calendar';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const editor = (page: Page) => page.locator('.work-entity-dialog[data-kind="note"][data-mode="create"]');
const reader = (page: Page) => page.locator('.work-entity-note-reader');
const detail = (page: Page, kind: Kind) => page.locator(kind === 'mail' ? '.data-mail-message' : '.calendar-event');
const noun = (kind: Kind) => kind === 'mail' ? 'email' : 'event';
const back = (page: Page, kind: Kind) => page.getByRole('button', { name: `Back to ${noun(kind)}`, exact: true });
const sourceLink = (page: Page) => reader(page).locator('a[data-note-note-link]').last();
const recovery = (page: Page) => page.getByRole('region', { name: 'Unfinished notes', exact: true });
const url = (f: Fixture, kind: Kind) => HARNESS_URL.split(/[?#]/)[0] + serializeSourceRecordAddress(f.source(kind));
const boot = async (page: Page, kind: Kind, prepare?: (f: Fixture) => void) => {
  const f = await installTaskNoteSourceFixture(page); f.registerSource('other.note', 'note'); prepare?.(f);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple&settle_reads=1${serializeSourceRecordAddress(f.source(kind))}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(detail(page, kind).getByRole('button', { name: 'Add note', exact: true })).toBeVisible(); return f;
};
const create = async (page: Page, kind: Kind) => {
  await detail(page, kind).getByRole('button', { name: 'Add note', exact: true }).click();
  await expect(editor(page)).toBeVisible(); await expect(editor(page).locator('[data-form-field="title"]')).toBeFocused();
};
const reload = async (page: Page) => {
  const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); }; page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); }
  await page.waitForFunction(() => window.__app?.ready === true);
};
const expectSource = async (page: Page, f: Fixture, kind: Kind) => {
  await expect.poll(() => new URL(page.url()).hash).toBe(serializeSourceRecordAddress(f.source(kind)));
  await expect(detail(page, kind)).toContainText(kind === 'mail' ? 'Exact work email body.' : 'Exact work occurrence');
};

for (const kind of ['mail', 'calendar'] as const) test(`reviews and saves a ${kind} note, opens its exact source in both formats, and preserves nested returns`, async ({ page }, info) => {
  const f = await boot(page, kind);
  try {
    const before = f.notes().length; await create(page, kind);
    await expect(editor(page).locator('[data-form-field="title"]')).toHaveValue(`Notes: Exact work ${kind === 'mail' ? 'email' : 'occurrence'}`);
    await expect(editor(page).locator('[data-form-field="body"]')).toHaveValue(`${kind === 'mail' ? 'Email' : 'Event'}: <${url(f, kind)}>\n\n`);
    expect(f.writes).toEqual([]); expect(f.notes()).toHaveLength(before);
    await editor(page).getByLabel('Source', { exact: true }).selectOption('other.note');
    await editor(page).locator('[data-form-field="title"]').fill('Reviewed meeting decisions');
    const body = `Source: <${url(f, kind)}>\n\n` + Array.from({ length: 32 }, (_, n) => `Decision ${n + 1}: keep the reviewed scope.\n`).join('\n') + `\nOriginal: <${url(f, kind)}>`;
    await editor(page).locator('[data-form-field="body"]').fill(body);
    await page.screenshot({ path: info.outputPath(`${kind}-note-draft-phone.png`), fullPage: true });
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page).getByRole('heading', { name: 'Reviewed meeting decisions', exact: true })).toBeVisible();
    expect(f.notes()).toHaveLength(before + 1); expect(f.writes).toHaveLength(1);
    const saved = f.notes().find(note => note.title === 'Reviewed meeting decisions')!;
    expect(saved).toMatchObject({ source_id: 'other.note', body, related_contact_ids: [], related_mail_thread_ids: [], related_calendar_event_ids: [], related_project_ids: [] });
    expect(f.writes[0]!.args).not.toHaveProperty('origin');
    for (const format of ['Plain text', 'Formatted']) {
      await reader(page).getByRole('button', { name: format, exact: true }).click();
      await expect(sourceLink(page)).toHaveAttribute('href', url(f, kind));
      if (format === 'Formatted') {
        await reader(page).getByRole('button', { name: 'Find in note', exact: true }).click();
        await reader(page).getByRole('searchbox', { name: 'Find in this note', exact: true }).fill('Decision');
        await reader(page).getByRole('button', { name: 'Next match', exact: true }).click();
      }
      await sourceLink(page).focus();
      const scroll = await reader(page).locator('.work-entity-note-content').evaluate(el => el.scrollTop);
      const find = await reader(page).locator('[data-note-find-status]').allTextContents();
      await sourceLink(page).press('Enter'); await expectSource(page, f, kind);
      await page.getByRole('button', { name: 'Back to note', exact: true }).click();
      await expect(sourceLink(page)).toBeFocused();
      await expect(reader(page)).toHaveAttribute('data-note-format', format === 'Formatted' ? 'formatted' : 'plain');
      expect(await reader(page).locator('.work-entity-note-content').evaluate(el => el.scrollTop)).toBeCloseTo(scroll, -1);
      expect(await reader(page).locator('[data-note-find-status]').allTextContents()).toEqual(find);
      if (format === 'Formatted') await expect(reader(page).getByRole('searchbox', { name: 'Find in this note', exact: true })).toHaveValue('Decision');
    }
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('.work-entity-dialog[data-kind="note"][data-mode="edit"]').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(reader(page)).toBeVisible();
    await back(page, kind).click(); await expectSource(page, f, kind);
    await expect(detail(page, kind).getByRole('button', { name: 'Add note', exact: true })).toBeFocused();
    expect(f.writes).toHaveLength(1); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['mail', 'calendar'] as const) test(`an untouched ${kind} note requires discard and returns to its mounted source`, async ({ page }) => {
  const f = await boot(page, kind);
  try {
    if (kind === 'mail') {
      await detail(page, kind).getByRole('button', { name: 'Find in email', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Find in this email', exact: true }).fill('Exact');
    }
    await create(page, kind); await back(page, kind).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(editor(page)).toBeVisible(); await back(page, kind).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expectSource(page, f, kind); await expect(detail(page, kind).getByRole('button', { name: 'Add note', exact: true })).toBeFocused();
    if (kind === 'mail') await expect(page.getByRole('searchbox', { name: 'Find in this email', exact: true })).toHaveValue('Exact');
    expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['mail', 'calendar'] as const) test(`recovers a ${kind} note with its chosen destination and exact Back control`, async ({ page }) => {
  const f = await boot(page, kind);
  try {
    await create(page, kind); await editor(page).getByLabel('Source', { exact: true }).selectOption('other.note');
    await editor(page).locator('[data-form-field="title"]').fill('Keep this unfinished note');
    const body = await editor(page).locator('[data-form-field="body"]').inputValue(); await reload(page);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor(page).locator('[data-form-field="title"]')).toHaveValue('Keep this unfinished note');
    await expect(editor(page).getByLabel('Source', { exact: true })).toHaveValue('other.note');
    await expect(editor(page).locator('[data-form-field="body"]')).toHaveValue(body);
    await back(page, kind).click(); await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expectSource(page, f, kind); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

for (const [kind, reply] of [['mail', 'lost'], ['calendar', 'pending']] as const) test(`keeps a ${reply} ${kind} note save unconfirmed and prevents another create after reload`, async ({ page }) => {
  const f = await boot(page, kind);
  try {
    await create(page, kind); const before = f.notes().length; f.reply(reply);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page).getByRole('alert')).toBeVisible();
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toContainText('previous save was not confirmed');
    expect(f.writes).toHaveLength(1); expect(f.notes()).toHaveLength(before + 1);
    await reload(page); await expect(recovery(page).getByRole('button', { name: 'Resume draft', exact: true })).toBeDisabled();
    expect(f.writes).toHaveLength(1); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['mail', 'calendar'] as const) test(`shares the ${kind} follow-up preparation gate and ignores a late note handoff after navigation`, async ({ page }) => {
  const f = await boot(page, kind);
  try {
    f.hold('work_entity.source.list', ''); const before = f.reads.filter(read => read.method === 'work_entity.source.list').length;
    await detail(page, kind).getByRole('button', { name: 'Add note', exact: true }).click(); await expect.poll(() => f.waiting()).toBe(true);
    await detail(page, kind).getByRole('button', { name: kind === 'mail' ? 'Create task' : 'Create follow-up task', exact: true }).evaluate((el: HTMLButtonElement) => el.click());
    expect(f.reads.filter(read => read.method === 'work_entity.source.list')).toHaveLength(before + 1);
    await page.evaluate(hash => window.__app.setHash(hash), '#chat'); await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
    const settled = await page.evaluate(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'work_entity.source.list:').length);
    f.release(); await page.waitForFunction(before => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'work_entity.source.list:').length > before, settled);
    await expect(editor(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a saved note keeps its return when its exact source is unavailable or returns another record', async ({ page }) => {
  const f = await boot(page, 'mail', f => f.seedNote('source-note', { title: 'Saved source note', body: `<${url(f, 'mail')}>` }));
  try {
    await page.evaluate(hash => window.__app.setHash(hash), '#data/note/source-note'); await expect(reader(page)).toBeVisible();
    f.failSource('collection.get', 'work'); await sourceLink(page).click();
    await expect(page.getByRole('button', { name: 'Back to note', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('interrupted');
    await page.getByRole('button', { name: 'Back to note', exact: true }).click(); await expect(sourceLink(page)).toBeFocused();
    f.failSource('collection.get', 'work', false); f.wrongRecord(); await sourceLink(page).click();
    await expect(page.getByRole('alert')).toContainText('could not be confirmed');
    await page.getByRole('button', { name: 'Back to note', exact: true }).click(); await expect(reader(page)).toBeVisible();
    expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('formatted external links and modified source clicks retain native new-tab behavior', async ({ page, context }) => {
  const f = await boot(page, 'mail', f => f.seedNote('source-note', { body: `<${url(f, 'mail')}>\n\n[External](https://external.invalid/#data/mail/record/work/other)` }));
  try {
    await page.evaluate(hash => window.__app.setHash(hash), '#data/note/source-note');
    await reader(page).getByRole('button', { name: 'Formatted', exact: true }).click();
    await context.route('https://external.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<p>External context</p>' }));
    const popup = page.waitForEvent('popup'); await reader(page).getByRole('link', { name: 'External', exact: true }).click();
    const other = await popup; await expect(other).toHaveURL('https://external.invalid/#data/mail/record/work/other'); await other.close();
    const sourceTab = context.waitForEvent('page'); await reader(page).locator('a[data-note-note-link]').first().click({ modifiers: ['ControlOrMeta'] });
    const source = await sourceTab; await source.waitForLoadState(); await source.close();
    await expect(reader(page)).toBeVisible(); await expect(page).toHaveURL(/#data\/note\/source-note$/);
    expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('an unavailable recovered email origin keeps its note editable and allows the reviewed save', async ({ page }) => {
  const f = await boot(page, 'mail');
  try {
    await create(page, 'mail'); await reload(page);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    f.failSource('collection.mail.message.get', 'work'); await back(page, 'mail').click();
    await expect(editor(page).locator('[data-draft-origin-error]')).toContainText('Could not reopen');
    await editor(page).locator('[data-form-field="title"]').fill('Saved without the original email');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(f.writes).toHaveLength(1); expect(f.notes().find(note => note.title === 'Saved without the original email')?.body).toContain(url(f, 'mail'));
    expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('keeps a read-only event open when note destinations are unavailable and retries after they recover', async ({ page }) => {
  const f = await boot(page, 'calendar', f => { f.registerSource('recued.note', 'note', false); f.registerSource('other.note', 'note', false); });
  try {
    await detail(page, 'calendar').getByRole('button', { name: 'Add note', exact: true }).click();
    await expect(detail(page, 'calendar').getByRole('alert')).toContainText('No writable note Source');
    await expect(editor(page)).toHaveCount(0); f.registerSource('other.note', 'note');
    await create(page, 'calendar'); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test.describe('mail calendar event', () => {
  const form = (page: Page) => page.getByRole('region', { name: 'Event from email', exact: true });
  const mail = (page: Page) => page.locator('.data-mail-message');
  const action = (page: Page) => mail(page).getByRole('button', { name: 'Create event', exact: true });
  const recoveries = (page: Page) => page.getByRole('region', { name: 'Unfinished calendar events', exact: true });
  const bootMail = async (page: Page) => {
    await page.clock.setFixedTime(new Date('2026-11-19T12:00Z'));
    const f = await installMailCalendarEventFixture(page);
    await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple&token=not-for-notes${serializeSourceRecordAddress(f.source())}`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect(action(page)).toBeVisible(); return f;
  };
  const dates = async (page: Page) => {
    await form(page).getByLabel('Starts', { exact: true }).fill('2026-11-20T09:00');
    await form(page).getByLabel('Ends', { exact: true }).fill('2026-11-20T10:00');
  };
  const emailUrl = (f: Awaited<ReturnType<typeof bootMail>>) => HARNESS_URL.split(/[?#]/)[0] + serializeSourceRecordAddress(f.source());

  test('reviews an email event draft, saves through the owner handler and returns to the exact source', async ({ page }, info) => {
    const f = await bootMail(page);
    try {
      const before = f.message(); f.changeSubject('Fresh <review> & planning');
      await action(page).click();
      await expect(form(page).getByLabel('Title', { exact: true })).toBeFocused();
      await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue('Fresh <review> & planning');
      await expect(form(page).getByLabel('Notes (optional)', { exact: true })).toHaveValue('Original email: ' + emailUrl(f));
      await expect(form(page)).toContainText('Times in America/Los_Angeles');
      await expect(form(page).getByLabel('Starts', { exact: true })).toHaveValue('');
      await expect(form(page).getByLabel('Ends', { exact: true })).toHaveValue('');
      await expect(form(page).getByLabel('Add guests', { exact: true })).toHaveValue('');
      await expect(mail(page)).toContainText(before.body!); expect(f.requests).toEqual([]);
      await dates(page); await page.setViewportSize({ width: 1280, height: 960 });
      await form(page).getByRole('heading', { name: 'Event from email', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath('mail-event-desktop.png'), fullPage: true });
      await form(page).getByRole('button', { name: 'Create event', exact: true }).click();
      await expect(page.locator('.calendar-event')).toContainText('Fresh <review> & planning');
      expect(f.requests).toHaveLength(1); expect(f.providerCalls()).toBe(1);
      expect(f.requests[0]).toMatchObject({ summary: 'Fresh <review> & planning', description: 'Original email: ' + emailUrl(f),
        start_at: Date.parse('2026-11-20T17:00Z'), end_at: Date.parse('2026-11-20T18:00Z'), timezone: 'America/Los_Angeles', is_all_day: false });
      for (const key of ['guests', 'send_invitations', 'mail', 'origin', 'reply']) expect(f.requests[0]).not.toHaveProperty(key);
      const back = page.getByRole('link', { name: 'Back to email', exact: true });
      await expect(back).toHaveAttribute('href', serializeSourceRecordAddress(f.source())); await back.click();
      await expect(action(page)).toBeVisible(); expect(new URL(page.url()).hash).toBe(serializeSourceRecordAddress(f.source()));
      expect(f.message().body).toBe(before.body); expect(f.writes).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('invites only guests explicitly added to the reviewed event, without mail sending authority', async ({ page }) => {
    const f = await bootMail(page);
    try {
      await action(page).click(); await dates(page);
      await expect(form(page)).not.toContainText('private@example.test');
      await form(page).getByLabel('Add guests', { exact: true }).fill('alex@example.test');
      await form(page).getByRole('button', { name: 'Add guest', exact: true }).click();
      await form(page).getByRole('button', { name: 'Create and send invitations', exact: true }).click();
      await expect(page.locator('.calendar-event')).toContainText('alex@example.test');
      expect(f.requests).toHaveLength(1); expect(f.requests[0]).toMatchObject({ guests: [{ email: 'alex@example.test' }], send_invitations: true });
      expect(f.providerCalls()).toBe(1); expect(f.writes).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('recovers an untouched draft at the email and returns on confirmed Cancel', async ({ page }, info) => {
    const f = await bootMail(page);
    try {
      await action(page).click();
      await form(page).getByRole('heading', { name: 'Event from email', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath('mail-event-phone.png'), fullPage: true });
      await reload(page); await expect(form(page)).toHaveCount(0);
      await recoveries(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
      await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue(f.message().subject);
      await expect(form(page).getByLabel('Starts', { exact: true })).toHaveValue('');
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(form(page).getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
      await form(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
      await expect(form(page)).toHaveCount(0); await expect(action(page)).toBeFocused();
      expect(new URL(page.url()).hash).toBe(serializeSourceRecordAddress(f.source()));
      expect(f.requests).toEqual([]); await reload(page); await expect(recoveries(page)).toHaveCount(0);
    } finally { await f.dispose(); }
  });

  test('checks a lost creation reply after reload without a second event or invitations', async ({ page }) => {
    const f = await bootMail(page);
    try {
      await action(page).click(); await dates(page);
      await form(page).getByLabel('Add guests', { exact: true }).fill('alex@example.test');
      await form(page).getByRole('button', { name: 'Add guest', exact: true }).click(); f.loseNextReply();
      await form(page).getByRole('button', { name: 'Create and send invitations', exact: true }).click();
      await expect(form(page).getByRole('button', { name: 'Check save', exact: true })).toBeVisible();
      await reload(page); await recoveries(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
      await expect(form(page).getByLabel('Title', { exact: true })).toBeDisabled();
      await form(page).getByRole('button', { name: 'Check save', exact: true }).click();
      await expect(page.getByRole('link', { name: 'Back to email', exact: true })).toBeVisible();
      expect(f.requests).toHaveLength(2); expect(f.requests[1]).toEqual(f.requests[0]); expect(f.providerCalls()).toBe(1); expect(f.writes).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('preserves the existing event draft and guards a switch to another conversation message', async ({ page }) => {
    const f = await bootMail(page);
    try {
      await action(page).click(); await form(page).getByLabel('Title', { exact: true }).fill('Keep my event');
      const reads = f.calls.length; await action(page).click();
      await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue('Keep my event');
      await expect(form(page).getByLabel('Title', { exact: true })).toBeFocused(); expect(f.calls).toHaveLength(reads);
      const other = page.locator('[data-recued-data-action="mail-message-toggle"][data-mail-record="mail-2"]');
      await other.click(); await form(page).getByRole('button', { name: 'Keep editing', exact: true }).click();
      await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue('Keep my event');
      await other.click(); await form(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
      await expect(form(page)).toHaveCount(0); await expect(mail(page)).toContainText('Second message context.'); expect(f.requests).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('retires a delayed email check when a newer ordinary event draft owns the page', async ({ page }) => {
    const f = await bootMail(page);
    try {
      f.holdRead(); await action(page).click(); await expect.poll(f.readPending).toBe(true);
      await page.getByRole('combobox', { name: 'Collection', exact: true }).selectOption('calendar');
      await page.getByRole('button', { name: 'New event', exact: true }).click();
      const ordinary = page.getByRole('region', { name: 'New event', exact: true });
      await ordinary.getByLabel('Title', { exact: true }).fill('Keep this newer draft'); f.releaseRead();
      await expect(ordinary.getByLabel('Title', { exact: true })).toHaveValue('Keep this newer draft');
      await expect(form(page)).toHaveCount(0); expect(f.requests).toEqual([]); expect(f.writes).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('permits retry after an interrupted read and refuses a replacement mailbox', async ({ page }) => {
    const f = await bootMail(page);
    try {
      f.failReads(true); await action(page).click(); await expect(mail(page).getByRole('alert')).toContainText('interrupted');
      await expect(form(page)).toHaveCount(0); f.failReads(false); await action(page).click(); await expect(form(page)).toBeVisible();
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await form(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
      f.replaceMailbox(); await action(page).click(); await expect(mail(page).getByRole('alert')).toContainText('different identity');
      await expect(form(page)).toHaveCount(0); expect(f.requests).toEqual([]); expect(f.writes).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('retains reviewed guests when invitations become unavailable and allows creating a personal event after clearing them', async ({ page }) => {
    const f = await bootMail(page);
    try {
      await action(page).click(); await dates(page);
      await form(page).getByLabel('Add guests', { exact: true }).fill('alex@example.test');
      await form(page).getByRole('button', { name: 'Add guest', exact: true }).click();
      f.setInvitations(false); await form(page).getByRole('button', { name: 'Reload calendars', exact: true }).click();
      await expect(form(page)).toContainText('alex@example.test');
      await form(page).getByRole('button', { name: 'Create and send invitations', exact: true }).click();
      await expect(form(page).getByRole('alert')).toContainText('Choose a calendar that can send invitations'); expect(f.requests).toEqual([]);
      await form(page).getByRole('button', { name: 'Clear guests', exact: true }).click();
      await form(page).getByRole('button', { name: 'Create event', exact: true }).click();
      await expect(page.locator('.calendar-event')).toBeVisible(); expect(f.requests[0]).not.toHaveProperty('send_invitations'); expect(f.providerCalls()).toBe(1);
    } finally { await f.dispose(); }
  });
  test('resumes an email event from the calendar agenda and cancels back to the exact email', async ({ page }) => {
    const f = await bootMail(page);
    try {
      await action(page).click(); await dates(page); await reload(page);
      await expect(recoveries(page)).toBeVisible();
      await page.getByRole('combobox', { name: 'Collection', exact: true }).selectOption('calendar');
      await recoveries(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
      await expect(form(page).getByLabel('Notes (optional)', { exact: true })).toHaveValue('Original email: ' + emailUrl(f));
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await form(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
      await expect(action(page)).toBeVisible();
      expect(new URL(page.url()).hash).toBe(serializeSourceRecordAddress(f.source()));
      expect(f.requests).toEqual([]); expect(f.writes).toEqual([]);
    } finally { await f.dispose(); }
  });

});
