import { expect, test, type Page } from '@playwright/test';
import { ACCOUNT_MENU_TRIGGER, HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 850 } });
type Kind = 'contact' | 'task' | 'note' | 'mail' | 'calendar'; type Mode = 'search' | 'insert';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const original = 'Café 二🙂 Before SELECT after.\nKeep this unfinished draft.';
const picker = (page: Page) => page.locator('[data-record-link-insert-dialog]');
const body = (page: Page) => page.locator('.work-entity-dialog-form [data-form-field="body"]');
const input = (page: Page, mode: Mode) => mode === 'search' ? page.getByRole('searchbox', { name: 'Search everything', exact: true }) : picker(page).getByRole('searchbox', { name: 'Search records', exact: true });
const card = (page: Page, mode: Mode) => mode === 'search' ? page.locator('[data-exact-record-link]') : picker(page).getByRole('region', { name: 'Record link', exact: true });
const detail = (page: Page, kind: Kind) => page.locator(kind === 'task' || kind === 'note' ? '.work-entity-' + kind + '-reader'
  : kind === 'mail' ? '.data-mail-message' : kind === 'calendar' ? '.calendar-event' : '[data-recued-data-contact-detail]');
const title = (f: Fixture, kind: Kind) => kind === 'contact' ? f.person.name! : kind === 'task' ? 'Exact task' : kind === 'note' ? 'Exact note' : kind === 'mail' ? 'Other mailbox email' : 'Other calendar occurrence';
const noun = (kind: Kind) => kind === 'mail' ? 'email' : kind === 'calendar' ? 'event' : kind;
const address = (f: Fixture, kind: Kind) => kind === 'mail' || kind === 'calendar' ? serializeSourceRecordAddress(f.source(kind, 'home'))
  : serializeShellRoute('data', kind, kind === 'contact' ? f.person.contact_id! : kind === 'task' ? 'task-one' : 'target-note');
const choose = (page: Page, f: Fixture, mode: Mode, kind: Kind) => mode === 'search' ? card(page, mode).getByRole('link', { name: 'Open ' + noun(kind) + ' ' + title(f, kind), exact: true })
  : picker(page).getByRole('button', { name: 'Insert link to ' + title(f, kind), exact: true });
const boot = async (page: Page, mode: Mode) => {
  const f = await installTaskNoteSourceFixture(page, { searchable: true }); f.seedNote('target-note', { title: 'Exact note', body: 'Private saved note text' });
  f.seedNote('editor-note', { title: 'Editor note', body: original }); f.update({ title: 'Exact task', assigned_contact_id: undefined, parent_project_id: undefined, blocks_task_ids: [] });
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + (mode === 'search' ? '#data/search' : '#data/note/editor-note'));
  await page.waitForFunction(() => window.__app?.ready === true);
  if (mode === 'insert') {
    await detail(page, 'note').getByRole('button', { name: 'Edit', exact: true }).click();
    await body(page).evaluate((node: HTMLTextAreaElement) => { node.focus(); const at = node.value.indexOf('SELECT'); node.setSelectionRange(at, at + 6, 'backward'); });
    await page.getByRole('button', { name: 'Insert record link', exact: true }).click();
  }
  return f;
};
const lookup = async (page: Page, f: Fixture, mode: Mode, kind: Kind) => { await input(page, mode).fill(HARNESS_URL + address(f, kind)); if (mode === 'insert') await input(page, mode).press('Enter'); await expect(choose(page, f, mode, kind)).toBeVisible(); };
const noFanout = (f: Fixture) => { expect(f.calls.filter(call => call.method === 'collection.searchAll')).toEqual([]); expect(f.queries.filter(call => call.method === 'work_entity.search')).toEqual([]); };
const noWrites = (f: Fixture) => { expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]); };

for (const mode of ['search', 'insert'] as const) for (const kind of ['contact', 'task', 'note', 'mail', 'calendar'] as const)
  test(mode + ' resolves the exact ' + kind + ' URL and preserves its surrounding workflow', async ({ page }, info) => {
    const f = await boot(page, mode);
    try {
      await lookup(page, f, mode, kind); noFanout(f); const href = HARNESS_URL + address(f, kind);
      if (kind === 'mail' || kind === 'calendar') {
        await expect(card(page, mode)).toContainText('Account: home');
        expect(f.calls.filter(call => call.method === 'collection.get').map(call => [call.args.slug, call.args.record_id])).toEqual([['home', f.source(kind, 'home').recordId]]);
      }
      if (mode === 'search') {
        await expect(card(page, mode)).not.toContainText('Private saved note text'); await choose(page, f, mode, kind).focus(); await page.keyboard.press('Enter');
        await expect(detail(page, kind)).toBeVisible(); await expect.poll(() => new URL(page.url()).hash).toBe(kind === 'contact' ? serializeShellRoute('data', 'contact', f.person.email) : address(f, kind));
        if (kind === 'note') await page.getByRole('button', { name: 'Back to search', exact: true }).click(); else await page.goBack();
        await expect(input(page, mode)).toHaveValue(href); await expect(choose(page, f, mode, kind)).toBeFocused();
      } else {
        await choose(page, f, mode, kind).click(); const expected = original.replace('SELECT', href); await expect(body(page)).toHaveValue(expected); await expect(body(page)).toBeFocused();
        const at = original.indexOf('SELECT') + href.length; expect(await body(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([at, at]);
        if (kind === 'mail') { await page.keyboard.press('ControlOrMeta+z'); await expect(body(page)).toHaveValue(original); await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(body(page)).toHaveValue(expected); }
      }
      if (mode === 'search' && kind === 'mail') await page.screenshot({ path: info.outputPath('exact-record-link-phone.png'), fullPage: true }); noWrites(f);
    } finally { f.dispose(); }
  });

test('the picker accepts a complete record URL longer than the text-search limit', async ({ page }) => {
  const f = await boot(page, 'insert');
  try {
    const id = 'saved/二'.repeat(35); f.seedNote(id, { title: 'Long address note', body: 'Saved' }); const href = HARNESS_URL + serializeShellRoute('data', 'note', id); expect(href.length).toBeGreaterThan(200);
    await input(page, 'insert').fill(href); await input(page, 'insert').press('Enter'); await picker(page).getByRole('button', { name: 'Insert link to Long address note', exact: true }).click();
    await expect(body(page)).toHaveValue(original.replace('SELECT', href)); noFanout(f); noWrites(f);
  } finally { f.dispose(); }
});

for (const mode of ['search', 'insert'] as const) test(mode + ' rejects foreign or malformed URLs without fetching or searching them', async ({ page }) => {
  const f = await boot(page, mode);
  try {
    const gets = () => f.reads.filter(call => ['work_entity.get', 'contact.get'].includes(call.method)); const sourceGets = () => f.calls.filter(call => call.method === 'collection.get');
    const readCount = gets().length, callCount = sourceGets().length; const foreign: string[] = []; page.on('request', request => { if (request.url().startsWith('https://outside.example/')) foreign.push(request.url()); });
    for (const href of ['https://outside.example/client/#data/note/one', HARNESS_URL + '?pair=private#data/task/task-one', '#data/note/%broken']) {
      await input(page, mode).fill(href); if (mode === 'insert') await input(page, mode).press('Enter');
      await expect(card(page, mode)).toContainText('from this Recued app'); expect(gets()).toHaveLength(readCount); expect(sourceGets()).toHaveLength(callCount); expect(foreign).toEqual([]); noFanout(f);
    }
    await input(page, mode).fill(mode === 'search' ? 'Exact task' : 'Exact note'); if (mode === 'insert') await input(page, mode).press('Enter');
    if (mode === 'search') await expect(page.locator('[data-work-search-group="task"]')).toBeVisible(); else await expect(picker(page).getByRole('button', { name: 'Insert link to Exact note', exact: true })).toBeVisible(); noWrites(f);
  } finally { f.dispose(); }
});

for (const mode of ['search', 'insert'] as const) test(mode + ' keeps a missing record in place and restores an unfinished selection', async ({ page }) => {
  const f = await boot(page, mode);
  try {
    const href = HARNESS_URL + serializeShellRoute('data', 'note', 'not-found'); await input(page, mode).fill(href); if (mode === 'insert') await input(page, mode).press('Enter');
    await expect(card(page, mode)).toContainText('no longer available'); await expect(input(page, mode)).toHaveValue(href); noFanout(f);
    if (mode === 'insert') {
      await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(body(page)).toHaveValue(original); await expect(body(page)).toBeFocused();
      const at = original.indexOf('SELECT'); expect(await body(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([at, at + 6, 'backward']);
    }
    noWrites(f);
  } finally { f.dispose(); }
});

for (const mode of ['search', 'insert'] as const) test(mode + ' rechecks the selected record lifetime before acting', async ({ page }) => {
  const f = await boot(page, mode);
  try {
    await lookup(page, f, mode, 'mail'); f.replaceSourceRecord('mail', 'home'); await choose(page, f, mode, 'mail').click();
    await expect(mode === 'search' ? card(page, mode).getByRole('alert') : picker(page).getByRole('alert')).toBeVisible();
    await expect(input(page, mode)).toHaveValue(HARNESS_URL + address(f, 'mail')); if (mode === 'search') await expect(page).toHaveURL(/#data\/search$/); noWrites(f);
  } finally { f.dispose(); }
});

test('a late universal lookup cannot replace a newer exact result', async ({ page }) => {
  const f = await boot(page, 'search');
  try {
    f.holdSource('collection.get', 'home'); await input(page, 'search').fill(HARNESS_URL + address(f, 'mail')); await expect.poll(f.sourceWaiting).toBe(true);
    await lookup(page, f, 'search', 'task'); f.releaseSource(); await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.includes('collection.get:'));
    await expect(choose(page, f, 'search', 'task')).toBeVisible(); await expect(card(page, 'search')).not.toContainText('Other mailbox email'); noFanout(f); noWrites(f);
  } finally { f.dispose(); }
});

test('Cancel retires a pending picker lookup without touching the editor', async ({ page }) => {
  const f = await boot(page, 'insert');
  try {
    f.holdSource('collection.get', 'home'); await input(page, 'insert').fill(HARNESS_URL + address(f, 'mail')); await input(page, 'insert').press('Enter'); await expect.poll(f.sourceWaiting).toBe(true);
    await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click(); f.releaseSource(); await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.includes('collection.get:'));
    await expect(body(page)).toHaveValue(original); await expect(body(page)).toBeFocused(); await expect(picker(page)).toHaveCount(0); noWrites(f);
  } finally { f.dispose(); }
});


test('a late Open confirmation cannot leave a newer universal query', async ({ page }) => {
  const f = await boot(page, 'search');
  try {
    await lookup(page, f, 'search', 'mail'); f.holdSource('collection.get', 'home'); await choose(page, f, 'search', 'mail').click(); await expect.poll(f.sourceWaiting).toBe(true);
    await lookup(page, f, 'search', 'task'); f.releaseSource(); await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(key => key === 'collection.get:').length >= 2);
    await expect(choose(page, f, 'search', 'task')).toBeVisible(); await expect(page).toHaveURL(/#data\/search$/); noWrites(f);
  } finally { f.dispose(); }
});


for (const mode of ['search', 'insert'] as const) test(mode + ' retries an interrupted exact read without turning it into an empty search', async ({ page }) => {
  const f = await boot(page, mode);
  try {
    f.failSource('collection.get', 'home'); await input(page, mode).fill(HARNESS_URL + address(f, 'mail')); if (mode === 'insert') await input(page, mode).press('Enter');
    await expect(card(page, mode)).toContainText('could not be checked'); await expect(card(page, mode)).not.toContainText('No matching');
    f.failSource('collection.get', 'home', false); await card(page, mode).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(choose(page, f, mode, 'mail')).toBeVisible(); noFanout(f); noWrites(f);
  } finally { f.dispose(); }
});

test('exact lookup results stay with their server profile', async ({ page }) => {
  const f = await boot(page, 'search');
  try {
    await lookup(page, f, 'search', 'mail');
    await page.locator('[' + ACCOUNT_MENU_TRIGGER + ']').click(); const menu = page.locator('[data-recued-account-menu-popover]');
    await menu.locator('[data-recued-server-switcher-item]').filter({ hasText: 'Office server' }).click(); const loaded = page.waitForEvent('load');
    await menu.locator('[data-recued-server-switcher-switch-commit]').click(); await loaded; await page.waitForFunction(() => window.__app?.ready === true);
    await page.evaluate(() => window.__app.setHash('#data/search'));
    await expect(input(page, 'search')).toHaveValue(''); await expect(card(page, 'search')).toHaveCount(0); await expect(detail(page, 'mail')).toHaveCount(0); noWrites(f);
  } finally { f.dispose(); }
});


test('Back to the exact result protects an unfinished reply before restoring search', async ({ page }) => {
  const f = await boot(page, 'search');
  try {
    await lookup(page, f, 'search', 'mail'); await choose(page, f, 'search', 'mail').click(); await expect(detail(page, 'mail')).toBeVisible();
    await detail(page, 'mail').getByRole('button', { name: 'Reply', exact: true }).click();
    const draft = page.getByRole('dialog', { name: /Reply/ }); await draft.locator('[data-form-field="body"]').fill('Keep this unfinished reply.');
    const prompts: string[] = []; page.once('dialog', async dialog => { prompts.push(dialog.message()); await dialog.dismiss(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(1); await expect(draft.locator('[data-form-field="body"]')).toHaveValue('Keep this unfinished reply.');
    page.once('dialog', async dialog => { prompts.push(dialog.message()); await dialog.accept(); }); await page.goBack();
    await expect(input(page, 'search')).toHaveValue(HARNESS_URL + address(f, 'mail')); await expect(choose(page, f, 'search', 'mail')).toBeFocused(); noWrites(f);
  } finally { f.dispose(); }
});
