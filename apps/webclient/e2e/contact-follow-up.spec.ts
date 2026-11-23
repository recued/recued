import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installContactFollowUpFixture } from './helpers/contact-follow-up-fixture.js';
import { serializeShellRoute } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installContactFollowUpFixture>>;
type Kind = 'task' | 'note';
const profile = (page: Page) => page.locator('[data-recued-data-contact-detail]');
const editor = (page: Page, kind: Kind) => page.locator(`.work-entity-dialog[data-kind="${kind}"][data-mode="create"]`);
const reader = (page: Page, kind: Kind) => page.locator(`.work-entity-${kind}-reader`);
const trigger = (page: Page, kind: Kind) => profile(page).getByRole('button', { name: kind === 'task' ? 'Create task' : 'Add note', exact: true });
const created = (page: Page, kind: Kind) => profile(page).getByRole('button', { name: `Open ${kind}`, exact: true });
const made = (f: Fixture, kind: Kind) => kind === 'task' ? f.tasks().filter(row => !['task-one', 'task-two'].includes(row.id)) : f.notes().filter(row => row.id !== 'note-one');
const route = (page: Page, hash: string) => page.evaluate(hash => window.__app.setHash(hash), hash);
const boot = async (page: Page, hash?: string, prepare?: (fixture: Fixture) => void) => {
  const f = await installContactFollowUpFixture(page);
  f.seedNote('note-one', { title: 'Parent note', body: 'Saved parent text', related_contact_ids: [f.person.contact_id!] });
  prepare?.(f);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple&settle_reads=1${hash ?? serializeShellRoute('data', 'contact', f.person.email)}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (!hash) await expect(profile(page).getByRole('heading', { name: f.person.name!, exact: true })).toBeVisible();
  return f;
};
const create = async (page: Page, kind: Kind) => {
  await trigger(page, kind).evaluate((node: HTMLButtonElement) => node.focus({ preventScroll: true })); await trigger(page, kind).press('Enter');
  await expect(editor(page, kind)).toBeVisible(); await expect(editor(page, kind).getByRole('textbox', { name: 'Title', exact: true })).toBeFocused();
};
const discard = async (page: Page, kind: Kind) => {
  await editor(page, kind).getByRole('button', { name: 'Back to contact', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click(); await expect(profile(page)).toBeVisible();
};
const reload = async (page: Page) => {
  page.once('dialog', dialog => { void dialog.accept(); }); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
};

for (const kind of ['task', 'note'] as const) test(`reviews and saves a contact ${kind}, returns to activity and opens a fresh saved record`, async ({ page }, info) => {
  const f = await boot(page);
  try {
    const feed = profile(page).locator('[data-contact-activity-scope]');
    await feed.getByRole('combobox', { name: 'Who acted', exact: true }).selectOption('user_self');
    await feed.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(feed.locator('.memory-timeline-entry')).toHaveCount(50);
    await feed.getByRole('button', { name: 'Load older activity', exact: true }).click(); await expect(feed.locator('.memory-timeline-entry')).toHaveCount(100);
    const anchor = feed.locator('.memory-timeline-entry').nth(52); await anchor.scrollIntoViewIfNeeded();
    const position = (await anchor.boundingBox())!.y;
    await create(page, kind); expect(f.writes).toEqual([]);
    await expect(editor(page, kind).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(kind === 'task' ? `Follow up with ${f.person.name}` : '');
    if (kind === 'task') {
      const text = await editor(page, kind).getByLabel('Notes', { exact: true }).inputValue();
      expect(new URL(text.slice(9)).hash).toBe(serializeShellRoute('data', 'contact', f.person.contact_id!)); expect(new URL(text.slice(9)).search).toBe('');
      await editor(page, kind).getByLabel('Priority', { exact: true }).selectOption('high');
      await editor(page, kind).locator('[data-form-field="due_at"]').fill('2030-11-01T09:45');
    } else {
      await expect(editor(page, kind).locator('[data-form-field="body"]')).toHaveValue('');
      await expect(editor(page, kind).getByRole('combobox', { name: 'Related contact 1', exact: true })).toHaveValue(f.person.name!);
      await editor(page, kind).locator('[data-form-field="body"]').fill('The next conversation needs a launch date.');
    }
    await editor(page, kind).getByRole('textbox', { name: 'Title', exact: true }).fill(`Reviewed contact ${kind}`);
    await editor(page, kind).getByLabel('Source', { exact: true }).selectOption(`other.${kind}`);
    await page.screenshot({ path: info.outputPath(`contact-${kind}-draft-phone.png`), fullPage: true });
    await editor(page, kind).getByRole('button', { name: 'Save', exact: true }).click(); await expect(created(page, kind)).toBeVisible();
    await expect(trigger(page, kind)).toBeFocused(); await expect(feed.getByRole('combobox', { name: 'Who acted', exact: true })).toHaveValue('user_self');
    await expect(feed.locator('.memory-timeline-entry')).toHaveCount(100);
    await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - position)).toBeLessThan(8);
    expect(made(f, kind)).toHaveLength(1); const saved = made(f, kind)[0]!;
    expect(saved.source_id).toBe(`other.${kind}`); expect(f.writes).toHaveLength(1); expect(f.writes[0]!.method).toBe('work_entity.upsert');
    if (kind === 'task') { const task = f.task(saved.id); expect(task.assigned_contact_id).toBeUndefined(); expect(task.parent_project_id).toBeUndefined(); expect(task.priority).toBe('high'); }
    if (kind === 'note') { expect(f.note(saved.id).related_contact_ids).toEqual([f.person.contact_id]); expect(f.note(saved.id).related_project_ids).toEqual([]); }
    if (kind === 'task') f.updateTask(saved.id, { title: 'Freshly renamed follow-up' }); else f.updateNote(saved.id, { title: 'Freshly renamed follow-up' });
    await created(page, kind).click(); await expect(reader(page, kind).getByRole('heading', { name: 'Freshly renamed follow-up', exact: true })).toBeVisible();
    await reader(page, kind).getByRole('button', { name: 'Back to contact', exact: true }).click(); await expect(created(page, kind)).toBeFocused();
    await expect(feed.locator('.memory-timeline-entry')).toHaveCount(100); await expect(profile(page).locator('img,script')).toHaveCount(0);
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: info.outputPath(`contact-${kind}-created-phone-dark.png`), fullPage: true });
  } finally { f.dispose(); }
});

for (const kind of ['task', 'note'] as const) test(`canceling the contact ${kind} draft requires discard, preserves its profile, and performs no write`, async ({ page }) => {
  const f = await boot(page);
  try {
    await create(page, kind); await editor(page, kind).getByRole('button', { name: 'Back to contact', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click(); await expect(editor(page, kind)).toBeVisible();
    await discard(page, kind); await expect(trigger(page, kind)).toBeFocused(); await expect(created(page, kind)).toHaveCount(0);
    expect(f.writes).toEqual([]); expect(made(f, kind)).toEqual([]);
    await route(page, `#data/${kind}`); await expect(page.getByRole('region', { name: kind === 'task' ? 'Unfinished tasks' : 'Unfinished notes', exact: true })).toHaveCount(0);
  } finally { f.dispose(); }
});

for (const failure of ['source-read', 'no-destination', 'merged', 'replaced', 'missing'] as const) test(`contact preparation handles ${failure} without opening an editor or writing`, async ({ page }) => {
  const f = await boot(page), id = f.person.contact_id!;
  try {
    if (failure === 'source-read') f.fail('work_entity.source.list', '');
    if (failure === 'no-destination') { f.writable(false); f.registerSource('other.task', 'task', false); }
    if (failure === 'merged') f.contactReply(id, { ...f.person, merged_into: 'survivor@example.test' });
    if (failure === 'replaced') f.contactReply(id, { ...f.person, contact_id: 'different-person' });
    if (failure === 'missing') f.contactReply(id, null);
    await trigger(page, 'task').click(); await expect(profile(page).locator('[data-contact-work-error]')).toContainText(failure === 'source-read' ? 'interrupted' : failure === 'no-destination' ? 'No writable task Source' : 'same identity');
    await expect(editor(page, 'task')).toHaveCount(0); expect(f.writes).toEqual([]);
    f.fail('work_entity.source.list', '', false); f.writable(true); f.contactReply(id); await create(page, 'task');
  } finally { f.dispose(); }
});

for (const destination of ['other-contact', 'editor', 'closed-editor', 'chat'] as const) test(`late contact preparation cannot replace ${destination}`, async ({ page }) => {
  const f = await boot(page);
  try {
    const other = await f.seedContact('blair@example.test', 'Blair Chen');
    f.hold('work_entity.source.list', ''); await trigger(page, 'task').click(); await expect.poll(() => f.waiting()).toBe(true);
    await trigger(page, 'note').evaluate((node: HTMLButtonElement) => node.click());
    if (destination === 'other-contact') { await route(page, serializeShellRoute('data', 'contact', other.email)); await expect(profile(page).getByRole('heading', { name: other.name!, exact: true })).toBeVisible(); }
    if (destination === 'editor' || destination === 'closed-editor') {
      await profile(page).getByRole('button', { name: 'Edit', exact: true }).click(); await expect(page.locator('[data-recued-data-contact-dialog]')).toBeVisible();
      if (destination === 'closed-editor') await page.locator('[data-recued-data-contact-dialog]').getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    if (destination === 'chat') { await route(page, '#chat'); await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible(); }
    const before = await page.evaluate(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'work_entity.source.list:').length);
    f.release(); await page.waitForFunction(before => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'work_entity.source.list:').length > before, before);
    await expect(editor(page, 'task')).toHaveCount(0); await expect(editor(page, 'note')).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['task', 'note'] as const) test(`a contact merged during ${kind} review prevents saving and allows retry before any write`, async ({ page }) => {
  const f = await boot(page), id = f.person.contact_id!;
  try {
    await create(page, kind); if (kind === 'note') await editor(page, kind).locator('[data-form-field="body"]').fill('Reviewed note.');
    f.contactReply(id, { ...f.person, merged_into: 'survivor@example.test' });
    await editor(page, kind).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page, kind).getByRole('alert')).toContainText('same identity');
    expect(f.writes).toEqual([]); f.contactReply(id);
    await editor(page, kind).getByRole('button', { name: 'Save', exact: true }).click(); await expect(created(page, kind)).toBeVisible(); expect(made(f, kind)).toHaveLength(1);
  } finally { f.dispose(); }
});

for (const kind of ['task', 'note'] as const) for (const reply of ['lost', 'pending'] as const) test(`an unconfirmed ${reply} contact ${kind} save retains recovery and blocks another create`, async ({ page }) => {
  const f = await boot(page);
  try {
    await create(page, kind); if (kind === 'note') await editor(page, kind).locator('[data-form-field="body"]').fill('Keep this draft.');
    f.reply(reply); await editor(page, kind).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page, kind).getByRole('alert')).toContainText(reply === 'lost' ? 'reply was lost' : 'did not confirm');
    f.reply('confirmed'); await editor(page, kind).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page, kind).getByRole('alert')).toContainText('previous save was not confirmed'); expect(f.writes).toHaveLength(1); expect(made(f, kind)).toHaveLength(1);
    await reload(page); const recovery = page.getByRole('region', { name: kind === 'task' ? 'Unfinished tasks' : 'Unfinished notes', exact: true });
    await expect(recovery).toContainText('Save was not confirmed'); await expect(recovery.getByRole('button', { name: 'Resume draft', exact: true })).toBeDisabled();
  } finally { f.dispose(); }
});

for (const kind of ['task', 'note'] as const) test(`browser Back retains the contact ${kind} draft for recovery after returning to the profile`, async ({ page }) => {
  const f = await boot(page);
  try {
    await create(page, kind); await editor(page, kind).getByRole('textbox', { name: 'Title', exact: true }).fill('Recover this contact follow-up');
    page.once('dialog', dialog => { void dialog.accept(); }); await page.goBack(); await expect(profile(page)).toBeVisible(); await expect(trigger(page, kind)).toBeFocused();
    await route(page, `#data/${kind}`); const recovery = page.getByRole('region', { name: kind === 'task' ? 'Unfinished tasks' : 'Unfinished notes', exact: true });
    await recovery.getByRole('button', { name: 'Resume draft', exact: true }).click(); await expect(editor(page, kind).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Recover this contact follow-up');
    if (kind === 'note') { await editor(page, kind).locator('[data-form-field="body"]').fill('Recovered with the same relationship.'); }
    await editor(page, kind).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page, kind)).toHaveCount(0);
    const saved = made(f, kind)[0]!; if (kind === 'note') expect(f.note(saved.id).related_contact_ids).toEqual([f.person.contact_id]);
    else expect(f.task(saved.id).body).toContain(serializeShellRoute('data', 'contact', f.person.contact_id!));
  } finally { f.dispose(); }
});

test('contact actions retain the parent note reader through create and cancel', async ({ page }) => {
  const f = await boot(page, '#data/note/note-one');
  try {
    await expect(reader(page, 'note').getByRole('heading', { name: 'Parent note', exact: true })).toBeVisible();
    await reader(page, 'note').locator('[data-note-section="related"] summary').click();
    await reader(page, 'note').getByRole('button', { name: `Open contact ${f.person.name}`, exact: true }).click(); await expect(profile(page)).toBeVisible();
    await create(page, 'note'); await discard(page, 'note'); await profile(page).getByRole('button', { name: '← Back to note', exact: true }).click();
    await expect(reader(page, 'note').getByRole('heading', { name: 'Parent note', exact: true })).toBeVisible(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a deleted created task cannot be opened and a fresh read failure can be retried', async ({ page }) => {
  const f = await boot(page);
  try {
    await create(page, 'task'); await editor(page, 'task').getByRole('button', { name: 'Save', exact: true }).click(); await expect(created(page, 'task')).toBeVisible();
    const saved = made(f, 'task')[0]!; f.fail('work_entity.get', saved.id); await created(page, 'task').click(); await expect(profile(page).locator('[data-contact-work-error]')).toContainText('interrupted');
    f.fail('work_entity.get', saved.id, false); f.removeTask(saved.id); await created(page, 'task').click(); await expect(profile(page).locator('[data-contact-work-error]')).toContainText('same identity');
    await expect(reader(page, 'task')).toHaveCount(0); expect(f.writes).toHaveLength(1);
  } finally { f.dispose(); }
});

test('nested follow-ups keep both contact and note return paths', async ({ page }) => {
  const f = await boot(page);
  try {
    await create(page, 'note'); await editor(page, 'note').locator('[data-form-field="body"]').fill('A new conversation note.');
    await editor(page, 'note').getByRole('textbox', { name: 'Title', exact: true }).fill('Conversation context');
    await editor(page, 'note').getByRole('button', { name: 'Save', exact: true }).click(); await created(page, 'note').click();
    await reader(page, 'note').locator('[data-note-section="related"] summary').click();
    await reader(page, 'note').getByRole('button', { name: `Open contact ${f.person.name}`, exact: true }).click();
    await create(page, 'task'); await discard(page, 'task');
    await profile(page).getByRole('button', { name: '← Back to note', exact: true }).click();
    await expect(reader(page, 'note').getByRole('heading', { name: 'Conversation context', exact: true })).toBeVisible();
    await reader(page, 'note').getByRole('button', { name: 'Back to contact', exact: true }).click();
    await expect(created(page, 'note')).toBeVisible(); expect(made(f, 'note')).toHaveLength(1); expect(made(f, 'task')).toEqual([]);
  } finally { f.dispose(); }
});

test('creating from universal search returns to the same contact hit and query', async ({ page }) => {
  const f = await boot(page, '#data/search');
  try {
    const search = page.getByRole('searchbox', { name: 'Search everything', exact: true }); await search.fill('Riley');
    const hit = page.locator(`[data-search-contact-email="${f.person.email}"]`); await hit.click();
    await create(page, 'task'); await editor(page, 'task').getByRole('button', { name: 'Save', exact: true }).click(); await expect(created(page, 'task')).toBeVisible();
    await profile(page).getByRole('button', { name: '← Back to search', exact: true }).click();
    await expect(search).toHaveValue('Riley'); await expect(hit).toBeFocused(); expect(made(f, 'task')).toHaveLength(1);
  } finally { f.dispose(); }
});

test('history that settles during note review is retained when returning to the contact', async ({ page }) => {
  const f = await boot(page, undefined, f => f.hold('yours.read', ''));
  try {
    await expect.poll(() => f.waiting()).toBe(true); await create(page, 'note');
    const before = await page.evaluate(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'yours.read:').length);
    f.release(); await page.waitForFunction(before => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'yours.read:').length > before, before);
    await discard(page, 'note'); await expect(profile(page).getByText('Loading recorded history…', { exact: true })).toHaveCount(0);
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a held contact validation accepts one save and waits for confirmation before returning', async ({ page }) => {
  const f = await boot(page);
  try {
    await create(page, 'task'); f.hold('contact.get', f.person.contact_id!);
    await editor(page, 'task').getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => f.waiting()).toBe(true);
    const saving = editor(page, 'task').locator('button.work-entity-dialog-submit'); await expect(saving).toBeDisabled();
    await saving.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))); expect(f.writes).toEqual([]); await expect(profile(page)).toHaveCount(0);
    f.release(); await expect(created(page, 'task')).toBeVisible(); expect(f.writes).toHaveLength(1); expect(made(f, 'task')).toHaveLength(1);
  } finally { f.dispose(); }
});
