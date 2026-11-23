import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 850 } });
type Kind = 'task' | 'note' | 'contact' | 'mail' | 'calendar';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const original = 'Café 二🙂 Before SELECT after.\nKeep this unfinished draft.';
const picker = (page: Page) => page.locator('[data-record-link-insert-dialog]');
const body = (page: Page) => page.locator('.work-entity-dialog-form [data-form-field="body"]');
const query = (page: Page) => picker(page).getByRole('searchbox', { name: 'Search records', exact: true });
const detail = (page: Page, kind: Kind) => page.locator(kind === 'task' || kind === 'note' ? '.work-entity-' + kind + '-reader'
  : kind === 'mail' ? '.data-mail-message' : kind === 'calendar' ? '.calendar-event' : '[data-recued-data-contact-detail]');
const label = (f: Fixture, kind: Kind, slug = 'work') => kind === 'task' ? 'Target task' : kind === 'note' ? 'Target note' : kind === 'contact' ? f.person.name!
  : kind === 'mail' ? slug === 'work' ? 'Exact work email' : 'Other mailbox email' : slug === 'work' ? 'Exact work occurrence' : 'Other calendar occurrence';
const address = (f: Fixture, kind: Kind, slug = 'work') => kind === 'mail' || kind === 'calendar' ? serializeSourceRecordAddress(f.source(kind, slug))
  : serializeShellRoute('data', kind, kind === 'contact' ? f.person.contact_id! : kind === 'task' ? 'task-one' : 'target-note');
const choice = (page: Page, f: Fixture, kind: Kind, slug = 'work') => picker(page).getByRole('button', { name: 'Insert link to ' + label(f, kind, slug), exact: true });
const route = async (page: Page, hash: string) => page.evaluate(hash => window.__app.setHash(hash), hash);
const boot = async (page: Page) => {
  const f = await installTaskNoteSourceFixture(page, { searchable: true });
  f.seedNote('target-note', { title: 'Target note', body: 'Saved reference' }); f.seedNote('editor-note', { title: 'Editor note', body: original });
  f.update({ title: 'Target task', assigned_contact_id: undefined, parent_project_id: undefined, blocks_task_ids: [] });
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1#data/search');
  await page.waitForFunction(() => window.__app?.ready === true); return f;
};
const visit = async (page: Page, f: Fixture, kind: Kind, pin = false, slug = 'work') => {
  await route(page, address(f, kind, slug)); await expect(detail(page, kind).locator('[data-record-pin-key]')).toBeVisible();
  if (pin) { await detail(page, kind).locator('[data-record-pin-key]').click(); await expect(detail(page, kind).locator('[data-record-pin-key]')).toHaveAttribute('aria-pressed', 'true'); }
};
const openEditor = async (page: Page, pinEditor = false) => {
  await route(page, '#data/note/editor-note'); const reader = detail(page, 'note'); await expect(reader.locator('[data-record-pin-key]')).toBeVisible();
  if (pinEditor) await reader.locator('[data-record-pin-key]').click();
  await reader.getByRole('button', { name: 'Edit', exact: true }).click();
  await body(page).evaluate((node: HTMLTextAreaElement) => { node.focus(); const at = node.value.indexOf('SELECT'); node.setSelectionRange(at, at + 6, 'backward'); });
};
const openPicker = async (page: Page) => { await page.getByRole('button', { name: 'Insert record link', exact: true }).click(); await expect(query(page)).toBeFocused(); };
const noWrites = (f: Fixture) => { expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]); };

for (const kind of ['task', 'note', 'contact', 'mail', 'calendar'] as const) test('inserts a verified ' + kind + ' from the existing pinned or recent list without typing', async ({ page }) => {
  const f = await boot(page), pin = ['task', 'contact', 'mail'].includes(kind);
  try {
    await visit(page, f, kind, pin); await openEditor(page); const reads = f.reads.length, sourceReads = f.calls.length; await openPicker(page);
    await expect(picker(page).getByRole('heading', { name: pin ? 'Pinned' : 'Recently opened', exact: true })).toBeVisible();
    await expect(choice(page, f, kind)).toHaveCount(1); expect(f.reads).toHaveLength(reads); expect(f.calls).toHaveLength(sourceReads);
    await choice(page, f, kind).click(); const href = HARNESS_URL + address(f, kind), expected = original.replace('SELECT', href);
    await expect(picker(page)).toHaveCount(0); await expect(body(page)).toHaveValue(expected); await expect(body(page)).toBeFocused();
    expect(await body(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([original.indexOf('SELECT') + href.length, original.indexOf('SELECT') + href.length]); noWrites(f);
    if (kind === 'mail') { await page.keyboard.press('ControlOrMeta+z'); await expect(body(page)).toHaveValue(original); await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(body(page)).toHaveValue(expected); noWrites(f); }
    if (kind === 'note') { await page.locator('.work-entity-dialog-form').getByRole('button', { name: 'Save', exact: true }).click(); await expect(detail(page, 'note')).toBeVisible(); expect(f.note('editor-note').body).toBe(expected); expect(f.writes).toHaveLength(1); }
  } finally { f.dispose(); }
});

test('keeps account-qualified choices, excludes the editor, filters shortcuts and restores them after search', async ({ page }, info) => {
  const f = await boot(page);
  try {
    await visit(page, f, 'task', true); await visit(page, f, 'mail', true); await visit(page, f, 'mail', false, 'home'); await visit(page, f, 'calendar'); await openEditor(page, true); await openPicker(page);
    await expect(picker(page).getByRole('button', { name: 'Insert link to Editor note', exact: true })).toHaveCount(0);
    await expect(choice(page, f, 'mail')).toHaveCount(1); await expect(choice(page, f, 'mail')).toContainText('Account: work'); await expect(choice(page, f, 'mail', 'home')).toContainText('Account: home');
    expect(await picker(page).locator('h3').allTextContents()).toEqual(['Pinned', 'Recently opened']);
    const filter = picker(page).getByRole('combobox', { name: 'Record type', exact: true }); await filter.selectOption('mail');
    await expect(choice(page, f, 'task')).toHaveCount(0); await expect(choice(page, f, 'calendar')).toHaveCount(0);
    await query(page).fill('Riley'); await query(page).press('Enter'); await expect(picker(page).getByRole('heading', { name: 'Mail', exact: true })).toBeVisible();
    await query(page).fill(''); await expect(picker(page).getByRole('heading', { name: 'Pinned', exact: true })).toBeVisible();
    await expect(picker(page).getByRole('heading', { name: 'Mail', exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('record-link-shortcuts-phone.png'), fullPage: true });
    await choice(page, f, 'mail', 'home').click(); await expect(body(page)).toHaveValue(original.replace('SELECT', HARNESS_URL + address(f, 'mail', 'home'))); noWrites(f);
  } finally { f.dispose(); }
});

for (const kind of ['mail', 'calendar', 'contact'] as const) test('rejects a replaced ' + kind + ' shortcut and preserves the selection and draft', async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, f, kind, true); await openEditor(page); await openPicker(page);
    if (kind === 'mail') f.replaceSourceRecord('mail'); else if (kind === 'calendar') f.replaceCalendar(); else f.contactReply(f.person.contact_id!, { ...f.person, merged_into: 'other-contact' });
    await choice(page, f, kind).click(); await expect(picker(page).getByRole('alert')).toBeVisible();
    await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(body(page)).toHaveValue(original); await expect(body(page)).toBeFocused();
    const at = original.indexOf('SELECT'); expect(await body(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([at, at + 6, 'backward']); noWrites(f);
  } finally { f.dispose(); }
});

test('Cancel fences a slow shortcut verification without inserting after the picker closes', async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, f, 'mail', true); await openEditor(page); await openPicker(page);
    f.holdSource('collection.get', 'work'); await choice(page, f, 'mail').click(); await expect.poll(f.sourceWaiting).toBe(true);
    await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(body(page)).toBeFocused();
    f.releaseSource(); await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(key => key === 'collection.get:').length >= 2);
    await expect(body(page)).toHaveValue(original); noWrites(f);
  } finally { f.dispose(); }
});
