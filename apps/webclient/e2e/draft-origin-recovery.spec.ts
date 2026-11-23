import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
type Start = 'contact-task' | 'contact-note' | 'note' | 'mail' | 'calendar';
const kind = (from: Start) => from === 'contact-note' ? 'note' : 'task';
const noun = (from: Start) => from.startsWith('contact') ? 'contact' : from === 'mail' ? 'email' : from === 'calendar' ? 'event' : 'note';
const editor = (page: Page, from: Start) => page.locator(`.work-entity-dialog[data-kind="${kind(from)}"][data-mode="create"]`);
const profile = (page: Page) => page.locator('[data-recued-data-contact-detail]');
const route = (page: Page, hash: string) => page.evaluate(hash => window.__app.setHash(hash), hash);
const reload = async (page: Page) => {
  const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); }; page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); }
  await page.waitForFunction(() => window.__app?.ready === true);
};
const resume = async (page: Page, from: Start) => {
  await page.getByRole('region', { name: kind(from) === 'task' ? 'Unfinished tasks' : 'Unfinished notes', exact: true }).getByRole('button', { name: 'Resume draft', exact: true }).click();
  await expect(editor(page, from)).toBeVisible(); await expect(editor(page, from).getByRole('button', { name: `Back to ${noun(from)}`, exact: true })).toBeVisible();
};
const boot = async (page: Page, from: Start) => {
  const f = await installTaskNoteSourceFixture(page); f.registerSource('other.task', 'task'); f.registerSource('other.note', 'note');
  f.seedNote('note-origin', { title: 'Original note <img src=x>', body: 'The saved note that started this follow-up.' });
  const hash = from.startsWith('contact') ? serializeShellRoute('data', 'contact', f.person.email) : from === 'note' ? '#data/note/note-origin'
    : serializeSourceRecordAddress({ tab: from === 'mail' ? 'mail' : 'calendar', collectionSlug: 'work', recordId: from === 'mail' ? f.mailId : f.eventId });
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple&settle_reads=1${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (from.startsWith('contact')) await profile(page).getByRole('button', { name: from === 'contact-task' ? 'Create task' : 'Add note', exact: true }).click();
  else if (from === 'note') await page.locator('.work-entity-note-reader').getByRole('button', { name: 'Create task', exact: true }).click();
  else if (from === 'mail') await page.locator('.data-mail-message').getByRole('button', { name: 'Create task', exact: true }).click();
  else await page.locator('.calendar-event').getByRole('button', { name: 'Create follow-up task', exact: true }).click();
  await expect(editor(page, from)).toBeVisible();
  await editor(page, from).getByRole('textbox', { name: 'Title', exact: true }).fill('Keep this reviewed follow-up');
  await editor(page, from).getByLabel('Source', { exact: true }).selectOption(`other.${kind(from)}`);
  if (kind(from) === 'task') await editor(page, from).locator('[data-form-field="due_at"]').fill('2030-11-01T09:45');
  else await editor(page, from).locator('[data-form-field="body"]').fill('Keep this unfinished conversation note.');
  return f;
};
const back = (page: Page, from: Start) => editor(page, from).getByRole('button', { name: `Back to ${noun(from)}`, exact: true });
const discard = async (page: Page, from: Start) => {
  await back(page, from).click(); await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(editor(page, from)).toHaveCount(0);
};
const expectOrigin = async (page: Page, from: Start, f: Fixture) => {
  if (from.startsWith('contact')) await expect(profile(page).getByRole('heading', { name: f.person.name!, exact: true })).toBeVisible();
  else if (from === 'note') await expect(page.locator('.work-entity-note-reader').getByRole('heading', { name: 'Original note <img src=x>', exact: true })).toBeVisible();
  else if (from === 'mail') { await expect(page.locator('.data-mail-message')).toContainText('Exact work email body.'); await expect(page).toHaveURL(/#data\/mail\/record\/work\//); }
  else { await expect(page.locator('.calendar-event').getByRole('heading', { name: 'Exact work occurrence', exact: true })).toBeVisible(); await expect(page).toHaveURL(/#data\/calendar\/record\/work\//); }
};

for (const from of ['contact-task', 'contact-note', 'note', 'mail', 'calendar'] as const) test(`resumes a ${from} draft after reload and returns to its exact original record`, async ({ page }, info) => {
  const f = await boot(page, from);
  try {
    const body = await editor(page, from).locator('[data-form-field="body"]').inputValue();
    await reload(page); await resume(page, from);
    await expect(editor(page, from).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Keep this reviewed follow-up');
    await expect(editor(page, from).getByLabel('Source', { exact: true })).toHaveValue(`other.${kind(from)}`);
    await expect(editor(page, from).locator('[data-form-field="body"]')).toHaveValue(body);
    if (kind(from) === 'task') await expect(editor(page, from).locator('[data-form-field="due_at"]')).toHaveValue('2030-11-01T09:45');
    await expect(editor(page, from).locator('[data-draft-origin]')).toContainText(`Started from ${noun(from)}`);
    await expect(editor(page, from).locator('[data-draft-origin] img, [data-draft-origin] script')).toHaveCount(0);
    if (from === 'contact-note' || from === 'mail') await page.screenshot({ path: info.outputPath(`recovered-${from}-phone.png`), fullPage: true });
    await discard(page, from); await expectOrigin(page, from, f); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('retains the contact and reviewed fields through repeated reloads, and rechecks after Keep editing', async ({ page }) => {
  const from = 'contact-task', f = await boot(page, from);
  try {
    await reload(page); await resume(page, from);
    await editor(page, from).getByRole('textbox', { name: 'Title', exact: true }).fill('Second revision');
    await reload(page); await resume(page, from); await expect(editor(page, from).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Second revision');
    await back(page, from).click(); await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click();
    f.contactReply(f.person.contact_id!, { ...f.person, merged_into: 'survivor@example.test' }); await back(page, from).click();
    await expect(editor(page, from).locator('[data-draft-origin-error]')).toContainText('different identity'); await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(editor(page, from).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Second revision');
    f.contactReply(f.person.contact_id!); await discard(page, from); await expectOrigin(page, from, f); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const from of ['contact-note', 'mail'] as const) test(`an unavailable ${from} origin keeps the draft editable and allows its reviewed save`, async ({ page }) => {
  const f = await boot(page, from);
  try {
    await reload(page); await resume(page, from);
    if (from === 'contact-note') f.contactReply(f.person.contact_id!, null); else f.failSource('collection.mail.message.get', 'work');
    await back(page, from).click(); await expect(editor(page, from).locator('[data-draft-origin-error]')).toContainText('Could not reopen');
    await expect(editor(page, from).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Keep this reviewed follow-up');
    await reload(page); await resume(page, from);
    await editor(page, from).getByRole('textbox', { name: 'Title', exact: true }).fill('Saved with the original context unavailable');
    await editor(page, from).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page, from)).toHaveCount(0);
    expect(f.writes).toHaveLength(1); expect(f.writes[0]!.args).not.toHaveProperty('origin'); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

for (const from of ['note', 'calendar'] as const) test(`a replaced ${from} origin cannot redirect the recovered draft to a different identity`, async ({ page }) => {
  const f = await boot(page, from);
  try {
    await reload(page); await resume(page, from);
    if (from === 'note') f.updateNote('note-origin', { source_id: 'other.note' }); else f.replaceCalendar();
    await back(page, from).click(); await expect(editor(page, from).locator('[data-draft-origin-error]')).toContainText('different identity');
    await expect(editor(page, from)).toBeVisible(); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('a failed source read can be retried without losing fields or dispatching writes', async ({ page }) => {
  const from = 'calendar', f = await boot(page, from);
  try {
    await reload(page); await resume(page, from); f.failSource('collection.calendar.event.get', 'work');
    await back(page, from).click(); await expect(editor(page, from).locator('[data-draft-origin-error]')).toContainText('interrupted');
    f.failSource('collection.calendar.event.get', 'work', false); await discard(page, from); await expectOrigin(page, from, f);
    expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

for (const destination of ['chat', 'saved-task'] as const) test(`a late return check cannot replace ${destination} or create a second record`, async ({ page }) => {
  const from = 'contact-task', f = await boot(page, from);
  try {
    await reload(page); await resume(page, from); const id = f.person.contact_id!;
    f.hold('contact.get', id); const before = f.reads.filter(read => read.method === 'contact.get' && read.id === id).length;
    await back(page, from).click(); await expect.poll(() => f.waiting()).toBe(true); await back(page, from).evaluate((node: HTMLButtonElement) => node.click());
    expect(f.reads.filter(read => read.method === 'contact.get' && read.id === id)).toHaveLength(before + 1);
    if (destination === 'chat') { page.once('dialog', dialog => { void dialog.accept(); }); await route(page, '#chat'); await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible(); }
    else { await editor(page, from).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page, from)).toHaveCount(0); expect(f.writes).toHaveLength(1); }
    const settled = await page.evaluate(id => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === `contact.get:${id}`).length, id); f.release();
    await page.waitForFunction(({ before, id }) => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === `contact.get:${id}`).length > before, { before: settled, id });
    await expect(profile(page)).toHaveCount(0); await expect(editor(page, from)).toHaveCount(0); expect(f.writes).toHaveLength(destination === 'chat' ? 0 : 1);
  } finally { f.dispose(); }
});

test('malformed optional context leaves a legacy draft recoverable without a forged return control', async ({ page }) => {
  const from = 'contact-task', f = await boot(page, from);
  try {
    await reload(page);
    await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(key => key.startsWith('recued.task.draft-recovery.v1:'))!;
      const rows = JSON.parse(sessionStorage.getItem(key)!); rows[0].origin = { kind: 'contact', id: 'forged', createdAt: -1, label: 'Forged' }; sessionStorage.setItem(key, JSON.stringify(rows));
    });
    await reload(page); await page.getByRole('region', { name: 'Unfinished tasks', exact: true }).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor(page, from).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Keep this reviewed follow-up');
    await expect(back(page, from)).toHaveCount(0); await expect(editor(page, from).locator('[data-draft-origin]')).toHaveCount(0);
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('Keep editing cancels a pending discard check and a late reply cannot remove the draft', async ({ page }) => {
  const from = 'contact-note', f = await boot(page, from);
  try {
    await reload(page); await resume(page, from); await back(page, from).click();
    const id = f.person.contact_id!; f.hold('contact.get', id);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click(); await expect.poll(() => f.waiting()).toBe(true);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click();
    const settled = await page.evaluate(id => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === `contact.get:${id}`).length, id);
    f.release(); await page.waitForFunction(({ before, id }) => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === `contact.get:${id}`).length > before, { before: settled, id });
    await expect(editor(page, from).locator('[data-form-field="body"]')).toHaveValue('Keep this unfinished conversation note.');
    await reload(page); await resume(page, from); await expect(editor(page, from).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Keep this reviewed follow-up');
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
