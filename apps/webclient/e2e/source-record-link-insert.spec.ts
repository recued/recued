import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 800 }, timezoneId: 'America/Los_Angeles' });
type Kind = 'note' | 'task'; type Tab = 'mail' | 'calendar';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const original = 'Café 二🙂 Before SELECT after.\n\nKeep this unfinished draft.';
const editor = (page: Page) => page.locator('.work-entity-dialog-form');
const body = (page: Page) => editor(page).locator('[data-form-field="body"]');
const picker = (page: Page) => page.locator('[data-record-link-insert-dialog]');
const query = (page: Page) => picker(page).getByRole('searchbox', { name: 'Search records', exact: true });
const reader = (page: Page, kind: Kind = 'note') => page.locator('.work-entity-' + kind + '-reader');
const title = (tab: Tab, slug: string) => tab === 'mail' ? slug === 'work' ? 'Exact work email' : 'Other mailbox email' : slug === 'work' ? 'Exact work occurrence' : 'Other calendar occurrence';
const result = (page: Page, tab: Tab, slug = 'work') => picker(page).getByRole('button', { name: 'Insert link to ' + title(tab, slug), exact: true });
const href = (f: Fixture, tab: Tab, slug = 'work') => HARNESS_URL + serializeSourceRecordAddress(f.source(tab, slug));
const boot = async (page: Page, kind: Kind = 'note') => {
  const f = await installTaskNoteSourceFixture(page, { searchable: true });
  f.seedNote('picker-note', { title: 'Picker note', body: original });
  f.update({ title: 'Picker task', body: original, assigned_contact_id: undefined, parent_project_id: undefined, blocks_task_ids: [] });
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1#data/' + kind + '/' + (kind === 'note' ? 'picker-note' : 'task-one'));
  await page.waitForFunction(() => window.__app?.ready === true); await reader(page, kind).getByRole('button', { name: 'Edit', exact: true }).click();
  await body(page).evaluate((node: HTMLTextAreaElement) => { node.focus(); const at = node.value.indexOf('SELECT'); node.setSelectionRange(at, at + 6, 'backward'); });
  await page.getByRole('button', { name: 'Insert record link', exact: true }).click(); await expect(query(page)).toBeFocused(); return f;
};
const search = async (page: Page, tab: Tab) => {
  await picker(page).getByRole('combobox', { name: 'Record type', exact: true }).selectOption(tab);
  await query(page).fill(tab === 'mail' ? 'Riley' : 'Meeting'); await query(page).press('Enter');
};

for (const kind of ['note', 'task'] as const) for (const tab of ['mail', 'calendar'] as const)
  test(kind + ' inserts, previews and follows the exact ' + tab + ' link with account identity and incoming links', async ({ page }) => {
    const f = await boot(page, kind), slug = kind === 'note' ? 'work' : 'home';
    try {
      await search(page, tab); await expect(result(page, tab)).toBeVisible(); await expect(result(page, tab, 'home')).toBeVisible();
      await expect(picker(page).getByRole('heading', { name: slug, exact: true, level: 4 })).toBeVisible();
      await expect(result(page, tab, slug)).toContainText('Account: ' + slug);
      await expect(result(page, tab, slug)).toContainText(/2026/);
      if (tab === 'mail') await expect(result(page, tab, slug)).toContainText('Riley');
      await result(page, tab, slug).click(); await expect(picker(page)).toHaveCount(0); await expect(body(page)).toBeFocused();
      const expected = original.replace('SELECT', href(f, tab, slug)); await expect(body(page)).toHaveValue(expected);
      expect(await body(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([original.indexOf('SELECT') + href(f, tab, slug).length, original.indexOf('SELECT') + href(f, tab, slug).length]);
      expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
      const gets = f.calls.filter(call => call.method === 'collection.get'); expect(gets.map(call => [call.args.platform, call.args.slug, call.args.record_id])).toEqual([[tab, slug, f.source(tab, slug).recordId]]);
      await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(reader(page, kind)).toBeVisible();
      expect((kind === 'note' ? f.note('picker-note') : f.task()).body).toBe(expected); expect(f.writes).toHaveLength(1);
      const link = reader(page, kind).getByRole('link', { name: href(f, tab, slug), exact: true });
      await link.locator('+ [data-work-link-preview-trigger]').click();
      await expect(page.locator('[data-work-link-preview]').getByRole('heading', { name: title(tab, slug), exact: true })).toBeVisible();
      await expect(page.locator('[data-work-link-preview]')).toContainText('Account: ' + slug);
      await page.locator('[data-work-link-preview]').getByRole('button', { name: 'Open ' + (tab === 'mail' ? 'email' : 'event'), exact: true }).click();
      const incoming = page.locator('[data-source-linked-from]'); await incoming.locator('summary').click();
      await expect(incoming.getByRole('button', { name: 'Open ' + kind + ' Picker ' + kind, exact: true })).toBeVisible();
      await page.getByRole('button', { name: new RegExp('^(?:← )?Back to ' + kind + '$') }).click();
      await expect(link.locator('+ [data-work-link-preview-trigger]')).toBeFocused(); expect(f.writes).toHaveLength(1);
    } finally { f.dispose(); }
  });

for (const state of ['deleted', 'reused'] as const) test('a ' + state + ' source cannot replace the selected draft text', async ({ page }) => {
  const f = await boot(page);
  try {
    await search(page, 'mail'); await expect(result(page, 'mail')).toBeVisible();
    if (state === 'deleted') f.remove('mail', 'work', f.mailId); else f.replaceSourceRecord('mail');
    await result(page, 'mail').click(); await expect(picker(page).getByRole('alert')).toBeVisible();
    expect(f.note('picker-note').body).toBe(original); expect(f.writes).toEqual([]);
    await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(body(page)).toHaveValue(original); await expect(body(page)).toBeFocused();
  } finally { f.dispose(); }
});

test('Cancel fences a slow source confirmation and restores the exact draft selection', async ({ page }) => {
  const f = await boot(page);
  try {
    await search(page, 'calendar'); await expect(result(page, 'calendar')).toBeVisible();
    f.holdSource('collection.get', 'work'); await result(page, 'calendar').click(); await expect.poll(f.sourceWaiting).toBe(true);
    await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(body(page)).toBeFocused();
    const at = original.indexOf('SELECT'); expect(await body(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([at, at + 6, 'backward']);
    f.releaseSource(); await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.includes('collection.get:'));
    await expect(body(page)).toHaveValue(original); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a late mail search cannot replace the newer Calendar results', async ({ page }) => {
  const f = await boot(page);
  try {
    f.holdSource('collection.searchAll', ''); await search(page, 'mail'); await expect.poll(f.sourceWaiting).toBe(true);
    await search(page, 'calendar'); await expect(result(page, 'calendar')).toBeVisible();
    f.releaseSource(); await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(key => key === 'collection.searchAll:').length >= 2);
    await expect(result(page, 'mail')).toHaveCount(0); await expect(result(page, 'calendar')).toBeVisible();
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('one unavailable account is labelled while another remains selectable', async ({ page }) => {
  const f = await boot(page);
  try {
    f.failSearchAccount('mail', 'work'); await search(page, 'mail');
    await expect(picker(page)).toContainText('Could not search account work.'); await expect(result(page, 'mail')).toHaveCount(0);
    await result(page, 'mail', 'home').click(); await expect(body(page)).toHaveValue(original.replace('SELECT', href(f, 'mail', 'home'))); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('failed account searches remain retryable and are never described as an empty mailbox', async ({ page }) => {
  const f = await boot(page);
  try {
    f.failSearchAccount('mail', 'work'); f.failSearchAccount('mail', 'home'); await search(page, 'mail');
    await expect(picker(page)).toContainText('Could not search account work.'); await expect(picker(page)).not.toContainText('No matching mail.');
    f.failSearchAccount('mail', 'work', false); await picker(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(result(page, 'mail')).toBeVisible(); await expect(picker(page)).toContainText('Could not search account home.');
  } finally { f.dispose(); }
});

test('source link insertion retains native Undo and Redo before Save', async ({ page }) => {
  const f = await boot(page);
  try {
    await search(page, 'calendar'); await result(page, 'calendar').click(); const expected = original.replace('SELECT', href(f, 'calendar'));
    await expect(body(page)).toHaveValue(expected); await page.keyboard.press('ControlOrMeta+z'); await expect(body(page)).toHaveValue(original);
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(body(page)).toHaveValue(expected); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
