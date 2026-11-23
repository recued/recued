import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Kind = 'note' | 'task';
const original = 'Keep Café 二🙂 before SELECT and keep this ending.';
const picker = (page: Page) => page.locator('dialog[data-record-link-insert-dialog]');
const editor = (page: Page, kind: Kind = 'note') => page.locator('.work-entity-dialog[data-kind="' + kind + '"]').filter({ has: page.locator('textarea[data-form-field="body"]') });
const field = (page: Page, kind: Kind = 'note') => editor(page, kind).locator('textarea[data-form-field="body"]');
const input = (page: Page) => picker(page).getByRole('searchbox', { name: 'Search records', exact: true });
const selected = (page: Page) => picker(page).getByRole('region', { name: 'Selected records', exact: true });
const insert = (page: Page, n: number) => picker(page).getByRole('button', { name: 'Insert ' + n + (n === 1 ? ' link' : ' links'), exact: true });
const settled = (page: Page, id: string) => page.evaluate(id => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(row => row === 'work_entity.get:' + id).length, id);
const preview = (page: Page) => picker(page).locator('[data-record-result-preview-panel]');
const search = async (page: Page, query: string, type = 'all') => { await input(page).fill(query); await picker(page).getByRole('combobox', { name: 'Record type', exact: true }).selectOption(type); await input(page).press('Enter'); };
const choose = async (page: Page, label: string, count: number) => { await picker(page).getByRole('button', { name: 'Select link to ' + label, exact: true }).click(); await expect(insert(page, count)).toBeEnabled(); };
const review = async (page: Page) => { const details = selected(page).locator('details'); if (!await details.evaluate((node: HTMLDetailsElement) => node.open)) await details.locator('summary').click(); };
const open = async (page: Page, kind: Kind = 'note') => {
  await field(page, kind).evaluate((node: HTMLTextAreaElement) => { node.focus(); const at = node.value.indexOf('SELECT'); node.setSelectionRange(at, at + 6, 'backward'); });
  await editor(page, kind).getByRole('button', { name: 'Insert record link', exact: true }).click();
  await picker(page).getByRole('button', { name: 'Select multiple', exact: true }).click();
};
const boot = async (page: Page, kind: Kind = 'note', pin = false) => {
  const f = await installTaskNoteSourceFixture(page, { searchable: true });
  await f.seedContact(f.person.email, 'Batch contact <img src=x>');
  f.update({ title: 'Batch task', assigned_contact_id: undefined, parent_project_id: undefined, blocks_task_ids: [] });
  f.seedNote('target-note', { title: 'Batch note', body: 'Private selected body <script>literal</script>.' });
  f.seedNote('editor-note', { title: 'Editor note', body: original }); f.seedTask('editor-task', { title: 'Editor task', body: original });
  const goto = async (hash: string) => { await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + hash); await page.waitForFunction(() => window.__app?.ready === true); };
  if (pin) { await goto(serializeSourceRecordAddress(f.source('calendar'))); await page.locator('.calendar-event [data-record-pin-key]').click(); }
  await goto(serializeShellRoute('data', kind, 'editor-' + kind));
  await page.locator('.work-entity-' + kind + '-reader').getByRole('button', { name: 'Edit', exact: true }).click(); await expect(field(page, kind)).toHaveValue(original); await open(page, kind);
  return f;
};

for (const kind of ['note', 'task'] as const) test(kind + ' collects all five record types across searches and inserts one undoable block, saved only explicitly', async ({ page }, info) => {
  await page.setViewportSize({ width: kind === 'note' ? 390 : 1280, height: 900 }); const f = await boot(page, kind);
  try {
    const url = page.url();
    await search(page, 'Batch contact', 'contact'); await choose(page, 'Batch contact <img src=x>', 1);
    await search(page, 'Batch task', 'task'); await choose(page, 'Batch task', 2);
    await search(page, 'Batch note', 'note'); await choose(page, 'Batch note', 3);
    await search(page, 'email', 'mail'); await choose(page, 'Exact work email', 4); await choose(page, 'Other mailbox email', 5);
    await search(page, 'Exact work occurrence', 'calendar'); await choose(page, 'Exact work occurrence', 6);
    await search(page, 'no matching records'); await expect(input(page)).toHaveValue('no matching records'); await review(page);
    await expect(selected(page)).not.toContainText('Private selected body'); await expect(selected(page).locator('img,script')).toHaveCount(0);
    await selected(page).getByRole('button', { name: 'Preview Batch note', exact: true }).click(); await expect(preview(page)).toContainText('Private selected body');
    await page.keyboard.press('Escape'); await expect(selected(page).getByRole('button', { name: 'Preview Batch note', exact: true })).toBeFocused(); await expect(input(page)).toHaveValue('no matching records');
    await page.screenshot({ path: info.outputPath('multi-record-' + kind + '.png'), fullPage: true });
    const rows = [
      ['Batch contact <img src=x>', serializeShellRoute('data', 'contact', f.person.contact_id!)], ['Batch task', '#data/task/task-one'], ['Batch note', '#data/note/target-note'],
      ['Exact work email', serializeSourceRecordAddress(f.source('mail'))], ['Other mailbox email', serializeSourceRecordAddress(f.source('mail', 'home'))], ['Exact work occurrence', serializeSourceRecordAddress(f.source('calendar'))],
    ];
    const expected = original.replace('SELECT', '\n' + rows.map(([title, hash]) => '- ' + title + ': ' + HARNESS_URL + hash).join('\n') + '\n');
    expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]); await insert(page, 6).click(); await expect(picker(page)).toHaveCount(0); await expect(field(page, kind)).toHaveValue(expected); await expect(field(page, kind)).toBeFocused(); expect(page.url()).toBe(url);
    expect((kind === 'note' ? f.note('editor-note') : f.task('editor-task')).body).toBe(original);
    await page.keyboard.press('ControlOrMeta+z'); await expect(field(page, kind)).toHaveValue(original); await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(field(page, kind)).toHaveValue(expected);
    await editor(page, kind).getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.locator('.work-entity-' + kind + '-reader')).toBeVisible();
    expect(f.writes).toHaveLength(1); expect((kind === 'note' ? f.note('editor-note') : f.task('editor-task')).body).toBe(expected); expect(f.mutations).toEqual([]);
    for (const [, hash] of rows) await expect(page.locator('.work-entity-' + kind + '-reader').locator('a[href="' + HARNESS_URL + hash + '"]')).toHaveCount(1);
  } finally { f.dispose(); }
});

test('a pending selection follows query changes but a removed selection cannot return from a late read', async ({ page }) => {
  const f = await boot(page);
  try {
    await search(page, 'Batch note', 'note'); f.hold('work_entity.get', 'target-note'); await picker(page).getByRole('button', { name: 'Select link to Batch note', exact: true }).click(); await expect.poll(f.waiting).toBe(true);
    await search(page, 'Batch task', 'task'); f.release(); await expect(insert(page, 1)).toBeEnabled(); await choose(page, 'Batch task', 2);
    await search(page, HARNESS_URL + '#data/note/target-note'); await expect(picker(page).getByRole('button', { name: 'Select link to Batch note', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await review(page); await selected(page).getByRole('button', { name: 'Remove Batch note from selection', exact: true }).click(); await expect(insert(page, 1)).toBeEnabled();
    f.hold('work_entity.get', 'target-note'); await picker(page).getByRole('button', { name: 'Select link to Batch note', exact: true }).click(); await expect.poll(f.waiting).toBe(true);
    await review(page); await selected(page).getByRole('button', { name: 'Remove Batch note from selection', exact: true }).click(); const before = await settled(page, 'target-note'); f.release(); await expect.poll(() => settled(page, 'target-note')).toBeGreaterThan(before);
    await expect(insert(page, 1)).toBeEnabled(); await expect(selected(page)).not.toContainText('Batch note'); await expect(field(page)).toHaveValue(original); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a failed selection can be retried and a selected preview can remove it after changing the query', async ({ page }) => {
  const f = await boot(page);
  try {
    await search(page, 'Batch note', 'note'); f.fail('work_entity.get', 'target-note'); await picker(page).getByRole('button', { name: 'Select link to Batch note', exact: true }).click();
    await review(page); await expect(selected(page).getByRole('alert')).toContainText('could not be checked'); await expect(insert(page, 1)).toBeDisabled();
    f.fail('work_entity.get', 'target-note', false); await selected(page).getByRole('button', { name: 'Try again', exact: true }).click(); await expect(insert(page, 1)).toBeEnabled();
    await search(page, 'no matches'); await review(page); await selected(page).getByRole('button', { name: 'Preview Batch note', exact: true }).click(); await expect(preview(page)).toContainText('Private selected body');
    await preview(page).getByRole('button', { name: 'Remove from selection', exact: true }).click(); await expect(insert(page, 0)).toBeDisabled(); await expect(selected(page)).toHaveCount(0); await expect(input(page)).toHaveValue('no matches'); await expect(field(page)).toHaveValue(original); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const fault of ['task', 'mail'] as const) test('a replaced ' + fault + ' blocks the whole batch until it is removed', async ({ page }) => {
  const f = await boot(page);
  try {
    await search(page, 'Batch note', 'note'); await choose(page, 'Batch note', 1);
    const label = fault === 'task' ? 'Batch task' : 'Exact work email'; await search(page, fault === 'task' ? 'Batch task' : 'Exact work email', fault); await choose(page, label, 2);
    if (fault === 'task') f.replaceTask(); else f.replaceSourceRecord('mail');
    await insert(page, 2).click(); await expect(picker(page).getByRole('alert').filter({ hasText: 'No links were inserted' })).toBeVisible(); await expect(field(page)).toHaveValue(original); expect(f.writes).toEqual([]);
    await review(page); await expect(selected(page)).toContainText('removed or replaced'); await selected(page).getByRole('button', { name: 'Remove ' + label + ' from selection', exact: true }).click();
    await insert(page, 1).click(); await expect(field(page)).toHaveValue(original.replace('SELECT', '\n- Batch note: ' + HARNESS_URL + '#data/note/target-note\n')); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('closing a pending batch cannot insert into a reopened picker or steal its focus', async ({ page }) => {
  const f = await boot(page);
  try {
    await search(page, 'Batch task', 'task'); await choose(page, 'Batch task', 1); f.hold('work_entity.get', 'task-one'); await insert(page, 1).click(); await expect.poll(f.waiting).toBe(true);
    await expect(picker(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused(); await page.keyboard.press('Escape'); await expect(field(page)).toBeFocused();
    await open(page); await search(page, 'Batch note', 'note'); await choose(page, 'Batch note', 1); await input(page).focus(); const before = await settled(page, 'task-one'); f.release();
    await expect.poll(() => settled(page, 'task-one')).toBeGreaterThan(before);
    await expect(input(page)).toBeFocused(); await expect(field(page)).toHaveValue(original); await expect(insert(page, 1)).toBeEnabled();
    await insert(page, 1).click(); await expect(field(page)).toHaveValue(original.replace('SELECT', '\n- Batch note: ' + HARNESS_URL + '#data/note/target-note\n')); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a changed editor during a batch check retains its new draft', async ({ page }) => {
  const f = await boot(page);
  try {
    await search(page, 'Batch note', 'note'); await choose(page, 'Batch note', 1); f.hold('work_entity.get', 'target-note'); await insert(page, 1).click(); await expect.poll(f.waiting).toBe(true);
    const before = await settled(page, 'target-note'); await field(page).evaluate((node: HTMLTextAreaElement) => { node.value = 'Newer draft'; node.dispatchEvent(new Event('input', { bubbles: true })); }); f.release(); await expect.poll(() => settled(page, 'target-note')).toBeGreaterThan(before);
    await expect(picker(page).getByRole('alert').filter({ hasText: 'The draft changed' })).toBeVisible(); await expect(field(page)).toHaveValue('Newer draft'); await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(field(page)).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a selected pinned event still checks the account incarnation at insertion', async ({ page }) => {
  const f = await boot(page, 'note', true);
  try {
    await picker(page).getByRole('region', { name: 'Pinned', exact: true }).getByRole('button', { name: 'Select link to Exact work occurrence', exact: true }).click(); await expect(insert(page, 1)).toBeEnabled();
    f.replaceCalendar(); await insert(page, 1).click(); await expect(picker(page).getByRole('alert').filter({ hasText: 'No links were inserted' })).toBeVisible(); await expect(field(page)).toHaveValue(original); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('a block that exceeds the editor limit leaves the entire draft and selection intact', async ({ page }) => {
  const f = await boot(page);
  try {
    await field(page).evaluate((node: HTMLTextAreaElement, max) => { node.maxLength = max; }, original.length + 2);
    await search(page, 'Batch note', 'note'); await choose(page, 'Batch note', 1); await insert(page, 1).click(); await expect(picker(page).getByRole('alert').filter({ hasText: 'exceed the text limit' })).toBeVisible();
    await expect(field(page)).toHaveValue(original); await expect(insert(page, 1)).toBeEnabled(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
