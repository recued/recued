import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../src/shell/route.js';
installFullAppHooks(); test.use({ viewport: { width: 390, height: 850 } });
type Mode = 'search' | 'insert'; type Kind = 'contact' | 'task' | 'note' | 'mail' | 'calendar';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const original = 'Café 二🙂 Before SELECT after.\nKeep this unfinished draft.';
const saved = 'Saved literal <script>window.resultPreviewExecuted=true</script> context. ' + '二🙂'.repeat(120) + 'END OF PRIVATE BODY';
const picker = (page: Page) => page.locator('[data-record-link-insert-dialog]');
const field = (page: Page) => page.locator('.work-entity-dialog-form [data-form-field="body"]');
const input = (page: Page, mode: Mode) => mode === 'search' ? page.getByRole('searchbox', { name: 'Search everything', exact: true }) : picker(page).getByRole('searchbox', { name: 'Search records', exact: true });
const preview = (page: Page, mode: Mode) => mode === 'search' ? page.getByRole('dialog', { name: 'Record preview', exact: true }) : picker(page).locator('[data-record-result-preview-panel]');
const label = (f: Fixture, kind: Kind) => kind === 'contact' ? f.person.name! : kind === 'note' ? 'Preview target note' : kind === 'task' ? 'Preview target task' : kind === 'mail' ? 'Other mailbox email' : 'Other calendar occurrence';
const query = (kind: Kind) => kind === 'contact' || kind === 'mail' ? 'Riley' : kind === 'calendar' ? 'occurrence' : 'Preview target';
const trigger = (page: Page, f: Fixture, mode: Mode, kind: Kind) => (mode === 'search' ? page.locator('.rq-search') : picker(page)).getByRole('button', { name: 'Preview ' + label(f, kind), exact: true });
const detail = (page: Page, kind: Kind) => page.locator(kind === 'task' || kind === 'note' ? '.work-entity-' + kind + '-reader' : kind === 'mail' ? '.data-mail-message' : kind === 'calendar' ? '.calendar-event' : '[data-recued-data-contact-detail]');
const address = (f: Fixture, kind: Kind) => kind === 'mail' || kind === 'calendar' ? serializeSourceRecordAddress(f.source(kind, 'home')) : serializeShellRoute('data', kind, kind === 'contact' ? f.person.contact_id! : kind === 'task' ? 'task-one' : 'target-note');
const boot = async (page: Page, mode: Mode) => {
  const f = await installTaskNoteSourceFixture(page, { searchable: true }); f.seedNote('target-note', { title: 'Preview target note', body: saved }); f.seedNote('editor-note', { title: 'Editor note', body: original });
  f.update({ title: 'Preview target task', body: saved, assigned_contact_id: undefined, parent_project_id: undefined, blocks_task_ids: [] });
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + (mode === 'search' ? '#data/search' : '#data/note/editor-note')); await page.waitForFunction(() => window.__app?.ready === true);
  if (mode === 'insert') {
    await detail(page, 'note').getByRole('button', { name: 'Edit', exact: true }).click();
    await field(page).evaluate((node: HTMLTextAreaElement) => { node.focus(); const at = node.value.indexOf('SELECT'); node.setSelectionRange(at, at + 6, 'backward'); });
    await page.getByRole('button', { name: 'Insert record link', exact: true }).click();
  }
  return f;
};
const search = async (page: Page, f: Fixture, mode: Mode, kind: Kind, exact = false) => { await input(page, mode).fill(exact ? HARNESS_URL + address(f, kind) : query(kind)); if (mode === 'insert') await input(page, mode).press('Enter'); await expect(trigger(page, f, mode, kind)).toBeVisible(); };
const noWrites = (f: Fixture) => { expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]); };

for (const mode of ['search', 'insert'] as const) for (const kind of ['contact', 'task', 'note', 'mail', 'calendar'] as const)
  test(mode + ' previews the current ' + kind + ' and closes with query focus and scroll intact', async ({ page }, info) => {
    const f = await boot(page, mode);
    try {
      await search(page, f, mode, kind); const before = f.calls.filter(call => call.method === 'collection.get').length;
      await trigger(page, f, mode, kind).scrollIntoViewIfNeeded(); const scroll = mode === 'search' ? page.locator('[data-recued-webclient-content]') : picker(page).locator('[data-link-insert-results]'); const top = await scroll.evaluate(node => node.scrollTop);
      await trigger(page, f, mode, kind).focus(); await page.keyboard.press('Enter'); await expect(preview(page, mode).getByRole('heading', { name: label(f, kind), exact: true })).toBeFocused();
      if (kind === 'note' || kind === 'task') { await expect(preview(page, mode)).toContainText('Saved literal <script>'); await expect(preview(page, mode)).not.toContainText('END OF PRIVATE BODY'); await expect(preview(page, mode)).toContainText('Source: Recued'); }
      if (kind === 'mail' || kind === 'calendar') { await expect(preview(page, mode)).toContainText('Account: home'); expect(f.calls.filter(call => call.method === 'collection.get').slice(before).map(call => [call.args.slug, call.args.record_id])).toEqual([['home', f.source(kind, 'home').recordId]]); }
      await expect(preview(page, mode).locator('script,img')).toHaveCount(0); expect(await page.evaluate(() => (window as unknown as { resultPreviewExecuted?: boolean }).resultPreviewExecuted)).toBeUndefined();
      if (mode === 'insert' && kind === 'note') await page.screenshot({ path: info.outputPath('picker-preview-phone.png'), fullPage: true });
      if (mode === 'search' && kind === 'mail') await page.screenshot({ path: info.outputPath('search-preview-phone.png'), fullPage: true });
      await page.keyboard.press('Escape'); await expect(preview(page, mode)).toHaveCount(0); await expect(trigger(page, f, mode, kind)).toBeFocused(); await expect(input(page, mode)).toHaveValue(query(kind));
      expect(await scroll.evaluate(node => node.scrollTop)).toBeCloseTo(top, 0); if (mode === 'insert') { await expect(field(page)).toHaveValue(original); const at = original.indexOf('SELECT'); expect(await field(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([at, at + 6, 'backward']); } noWrites(f);
    } finally { f.dispose(); }
  });

for (const mode of ['search', 'insert'] as const) for (const kind of ['note', 'mail'] as const)
  test(mode + ' uses the existing ' + (mode === 'search' ? 'Open' : 'Insert') + ' path from the ' + kind + ' preview', async ({ page }) => {
    const f = await boot(page, mode);
    try {
      await search(page, f, mode, kind, true); await trigger(page, f, mode, kind).click(); await expect(preview(page, mode).getByRole('heading', { name: label(f, kind), exact: true })).toBeVisible();
      await preview(page, mode).getByRole('button', { name: mode === 'search' ? 'Open ' + (kind === 'mail' ? 'email' : kind) : 'Insert link', exact: true }).click();
      if (mode === 'search') { await expect(detail(page, kind)).toBeVisible(); await expect.poll(() => new URL(page.url()).hash).toBe(address(f, kind)); }
      else { const expected = original.replace('SELECT', HARNESS_URL + address(f, kind)); await expect(field(page)).toHaveValue(expected); await expect(field(page)).toBeFocused(); await page.keyboard.press('ControlOrMeta+z'); await expect(field(page)).toHaveValue(original); await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(field(page)).toHaveValue(expected); }
      noWrites(f);
    } finally { f.dispose(); }
  });

for (const mode of ['search', 'insert'] as const) test(mode + ' fences a closed slow preview and restores its trigger', async ({ page }) => {
  const f = await boot(page, mode);
  try {
    await search(page, f, mode, 'note'); f.hold('work_entity.get', 'target-note'); await trigger(page, f, mode, 'note').click(); await expect.poll(f.waiting).toBe(true);
    await page.keyboard.press('Escape'); await expect(trigger(page, f, mode, 'note')).toBeFocused(); f.release(); await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.includes('work_entity.get:target-note'));
    await expect(preview(page, mode)).toHaveCount(0); if (mode === 'insert') await expect(field(page)).toHaveValue(original); noWrites(f);
  } finally { f.dispose(); }
});
for (const mode of ['search', 'insert'] as const) test(mode + ' retries a failed preview without dropping the query or draft', async ({ page }) => {
  const f = await boot(page, mode);
  try {
    await search(page, f, mode, 'note'); f.fail('work_entity.get', 'target-note'); await trigger(page, f, mode, 'note').click(); await expect(preview(page, mode).getByRole('alert')).toContainText('could not be previewed');
    f.fail('work_entity.get', 'target-note', false); await preview(page, mode).getByRole('button', { name: 'Try again', exact: true }).click(); await expect(preview(page, mode)).toContainText('Saved literal');
    await preview(page, mode).getByRole('button', { name: 'Close preview', exact: true }).click(); await expect(input(page, mode)).toHaveValue(query('note')); if (mode === 'insert') await expect(field(page)).toHaveValue(original); noWrites(f);
  } finally { f.dispose(); }
});
for (const mode of ['search', 'insert'] as const) test(mode + ' refuses Open or Insert when the previewed source was replaced', async ({ page }) => {
  const f = await boot(page, mode);
  try {
    await search(page, f, mode, 'mail'); await trigger(page, f, mode, 'mail').click(); await expect(preview(page, mode).getByRole('heading', { name: label(f, 'mail'), exact: true })).toBeVisible();
    f.replaceSourceRecord('mail', 'home'); await preview(page, mode).getByRole('button', { name: mode === 'search' ? 'Open email' : 'Insert link', exact: true }).click(); await expect(preview(page, mode).getByRole('alert')).toContainText('removed or replaced');
    if (mode === 'search') await expect(page).toHaveURL(/#data\/search$/); else await expect(field(page)).toHaveValue(original); noWrites(f);
  } finally { f.dispose(); }
});
test('universal search previews the existing pinned and recent references without reopening their reader', async ({ page }) => {
  const f = await boot(page, 'search');
  try {
    await page.evaluate(() => window.__app.setHash('#data/note/target-note')); await detail(page, 'note').locator('[data-record-pin-key]').click(); await page.evaluate(() => window.__app.setHash('#data/search'));
    for (const name of ['Pinned', 'Recently opened']) { const button = page.getByRole('region', { name, exact: true }).getByRole('button', { name: 'Preview Preview target note', exact: true }); await button.click(); await expect(preview(page, 'search')).toContainText('Saved literal'); await preview(page, 'search').getByRole('button', { name: 'Close preview', exact: true }).click(); await expect(button).toBeFocused(); }
    await expect(detail(page, 'note')).toHaveCount(0); noWrites(f);
  } finally { f.dispose(); }
});


for (const mode of ['search', 'insert'] as const) test(mode + ' keeps an open preview through late results from another search group', async ({ page }) => {
  const f = await boot(page, mode);
  try {
    f.holdSource('collection.searchAll', ''); await search(page, f, mode, 'note'); await expect.poll(f.sourceWaiting).toBe(true);
    await trigger(page, f, mode, 'note').click(); await expect(preview(page, mode).getByRole('heading', { name: label(f, 'note'), exact: true })).toBeFocused();
    f.releaseSource(); await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.includes('collection.searchAll:'));
    await expect(preview(page, mode).getByRole('heading', { name: label(f, 'note'), exact: true })).toBeFocused(); await expect(preview(page, mode)).toContainText('Saved literal');
    await preview(page, mode).getByRole('button', { name: 'Close preview', exact: true }).click(); await expect(trigger(page, f, mode, 'note')).toBeFocused(); await expect(input(page, mode)).toHaveValue(query('note'));
    if (mode === 'insert') await expect(field(page)).toHaveValue(original); noWrites(f);
  } finally { f.dispose(); }
});


test('a contact preview opens its canonical person after its email address is reassigned', async ({ page }) => {
  const f = await boot(page, 'search');
  try {
    await search(page, f, 'search', 'contact'); await trigger(page, f, 'search', 'contact').click(); await expect(preview(page, 'search').getByRole('heading', { name: label(f, 'contact'), exact: true })).toBeVisible();
    const other = await f.seedContact('other@example.test', 'Another person');
    f.contactReply(f.person.contact_id!, { ...f.person, email: 'changed@example.test', _id: 'changed@example.test' });
    f.contactReply(f.person.email, { ...other, email: f.person.email, _id: f.person.email });
    await preview(page, 'search').getByRole('button', { name: 'Open contact', exact: true }).click();
    await expect(detail(page, 'contact')).toContainText(label(f, 'contact')); await expect(detail(page, 'contact')).toContainText('changed@example.test'); await expect(detail(page, 'contact')).not.toContainText('Another person'); noWrites(f);
  } finally { f.dispose(); }
});


test('a contact preview keeps its canonical person while Open is pending', async ({ page }) => {
  const f = await boot(page, 'search');
  try {
    await search(page, f, 'search', 'contact'); await trigger(page, f, 'search', 'contact').click(); await expect(preview(page, 'search').getByRole('heading', { name: label(f, 'contact'), exact: true })).toBeVisible();
    f.hold('contact.get', f.person.contact_id!); await preview(page, 'search').getByRole('button', { name: 'Open contact', exact: true }).click(); await expect.poll(f.waiting).toBe(true);
    const other = await f.seedContact('other@example.test', 'Another person');
    f.contactReply(f.person.contact_id!, { ...f.person, email: 'changed@example.test', _id: 'changed@example.test' });
    f.contactReply(f.person.email, { ...other, email: f.person.email, _id: f.person.email }); f.release();
    await expect(detail(page, 'contact')).toBeVisible(); await expect(detail(page, 'contact')).toContainText(label(f, 'contact')); await expect(detail(page, 'contact')).toContainText('changed@example.test'); await expect(detail(page, 'contact')).not.toContainText('Another person'); noWrites(f);
  } finally { f.dispose(); }
});
