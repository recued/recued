import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute } from '../src/shell/route.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Kind = 'note' | 'task';
type Target = Kind | 'contact';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const sourceId = (kind: Kind) => kind === 'task' ? 'task-one' : 'origin-note';
const targetId = (f: Fixture, kind: Target) => kind === 'contact' ? f.person.contact_id! : 'linked/' + kind + "?二)'*";
const title = (target: Target) => 'Pick target ' + target + ' <img src=x>';
const href = (f: Fixture, kind: Target) => HARNESS_URL + serializeShellRoute('data', kind, targetId(f, kind));
const editor = (page: Page, kind: Kind = 'note') => page.locator('.work-entity-dialog[data-kind="' + kind + '"]').filter({ has: page.locator('.work-entity-dialog-form') });
const body = (page: Page, kind: Kind = 'note') => editor(page, kind).locator('textarea[data-form-field="body"]');
const reader = (page: Page, kind: Kind = 'note') => page.locator('.work-entity-' + kind + '-reader');
const content = (page: Page, kind: Kind) => editor(page, kind).locator('.work-entity-' + kind + '-content');
const picker = (page: Page) => page.locator('dialog[data-record-link-insert-dialog]');
const query = (page: Page) => picker(page).getByRole('searchbox', { name: 'Search records', exact: true });
const result = (page: Page, kind: Target) => picker(page).getByRole('button', { name: 'Insert link to ' + title(kind), exact: true });
const saved = (f: Fixture, kind: Kind) => kind === 'task' ? f.task() : f.note(sourceId(kind));
const original = Array.from({ length: 24 }, (_, i) => 'Saved context ' + i + '. ' + 'Keep Café 二🙂 <script>literal</script>. '.repeat(6)).join('\n\n') + '\n\nSELECTME\n\nKeep this ending.';
const boot = async (page: Page, kind: Kind = 'note', prepare?: (f: Fixture) => void) => {
  const f = await installTaskNoteSourceFixture(page, { searchable: true });
  await f.seedContact(f.person.email, title('contact'));
  f.seedTask(targetId(f, 'task'), { title: title('task'), body: 'Linked task notes.' });
  f.seedNote(targetId(f, 'note'), { title: title('note'), body: 'Linked note text.' });
  f.update({ title: 'Starting task', body: original, assigned_contact_id: undefined, parent_project_id: undefined, blocks_task_ids: [] });
  f.seedNote('origin-note', { title: 'Starting note', body: original }); prepare?.(f);
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + serializeShellRoute('data', kind, sourceId(kind)));
  await page.waitForFunction(() => window.__app?.ready === true); await expect(reader(page, kind)).toBeVisible();
  await reader(page, kind).getByRole('button', { name: 'Edit', exact: true }).click(); await expect(body(page, kind)).toHaveValue(original);
  return f;
};
const open = async (page: Page, kind: Kind = 'note') => {
  await body(page, kind).evaluate((node: HTMLTextAreaElement) => { node.focus({ preventScroll: true }); const start = node.value.indexOf('SELECTME'); node.setSelectionRange(start, start + 8, 'backward'); node.scrollTop = node.scrollHeight; });
  await editor(page, kind).getByRole('button', { name: 'Insert record link', exact: true }).evaluate(node => node.focus({ preventScroll: true }));
  const position = await body(page, kind).evaluate((node: HTMLTextAreaElement) => ({ start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection, top: node.scrollTop }));
  const top = await content(page, kind).evaluate(node => node.scrollTop);
  await page.keyboard.press('Enter'); await expect(picker(page)).toBeVisible(); await expect(query(page)).toBeFocused();
  return { ...position, contentTop: top };
};
const search = async (page: Page) => { await query(page).fill('Pick target'); await query(page).press('Enter'); await expect(result(page, 'note')).toBeVisible(); };
const expected = (f: Fixture, target: Target) => original.replace('SELECTME', href(f, target));
const settled = (page: Page, method: string, id: string) => page.evaluate(key => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(row => row === key).length, method + ':' + id);
const waitSettled = (page: Page, method: string, id: string, before: number) => page.waitForFunction(({ key, before }) =>
  (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(row => row === key).length > before, { key: method + ':' + id, before });
const reload = async (page: Page) => { const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); }; page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); } await page.waitForFunction(() => window.__app?.ready === true); };

for (const kind of ['note', 'task'] as const) for (const target of ['contact', 'task', 'note'] as const)
  test(kind + ' inserts the exact ' + target + ' at its selection, saves only explicitly, and opens the saved preview with Back', async ({ page }, info) => {
    const f = await boot(page, kind), before = structuredClone(saved(f, kind));
    try {
      await editor(page, kind).locator('[data-form-field="title"]').fill('Unsaved source title');
      const searches = f.queries.filter(row => row.method === 'work_entity.search').length;
      await open(page, kind); expect(f.queries.filter(row => row.method === 'work_entity.search')).toHaveLength(searches);
      await search(page); await expect(picker(page).locator('img,script')).toHaveCount(0);
      await result(page, target).click(); await expect(picker(page)).toHaveCount(0);
      await expect(body(page, kind)).toHaveValue(expected(f, target)); await expect(body(page, kind)).toBeFocused();
      const cursor = original.indexOf('SELECTME') + href(f, target).length;
      expect(await body(page, kind).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([cursor, cursor]);
      expect(saved(f, kind)).toEqual(before); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
      expect(f.reads.filter(row => row.method === (target === 'contact' ? 'contact.get' : 'work_entity.get') && row.id === targetId(f, target))).toHaveLength(1);
      if (kind === 'note' && target === 'task') { await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: info.outputPath('inserted-link-phone.png'), fullPage: true }); }
      await editor(page, kind).getByRole('button', { name: 'Save', exact: true }).click();
      await expect(reader(page, kind)).toBeVisible(); expect(f.writes).toHaveLength(1); expect(saved(f, kind).body).toBe(expected(f, target));
      const link = reader(page, kind).locator('a[href="' + href(f, target) + '"]');
      await link.locator('+ button[data-work-link-preview-trigger]').click();
      await expect(page.locator('[data-work-link-preview]').getByRole('heading', { name: title(target), exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Close preview', exact: true }).click(); await link.click();
      await expect(page.getByRole('button', { name: new RegExp('^(?:← )?Back to ' + kind + '$', 'u') })).toBeVisible();
      await page.getByRole('button', { name: new RegExp('^(?:← )?Back to ' + kind + '$', 'u') }).click(); await expect(link).toBeFocused();
      expect(f.writes).toHaveLength(1);
    } finally { f.dispose(); }
  });

for (const kind of ['note', 'task'] as const) test('a new ' + kind + ' keeps inserted links in its draft until Save', async ({ page }) => {
  const f = await boot(page, kind);
  try {
    await editor(page, kind).getByRole('button', { name: 'Cancel', exact: true }).click();
    await reader(page, kind).getByRole('button', { name: kind === 'note' ? 'Back to notes' : 'Back to tasks', exact: true }).click();
    await page.getByRole('button', { name: '+ New ' + (kind === 'note' ? 'Note' : 'Task'), exact: true }).click();
    await editor(page, kind).locator('[data-form-field="title"]').fill('New linked draft'); await body(page, kind).fill(original);
    await open(page, kind); await search(page); await result(page, 'task').click(); await expect(body(page, kind)).toHaveValue(expected(f, 'task')); expect(f.writes).toEqual([]);
    await editor(page, kind).getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => f.writes.length).toBe(1);
    const row = (kind === 'note' ? f.notes() : f.tasks()).find(row => row.title === 'New linked draft'); expect(row?.body).toBe(expected(f, 'task'));
  } finally { f.dispose(); }
});

for (const kind of ['note', 'task'] as const) for (const action of ['Cancel', 'Escape'] as const)
  test(action + ' restores the ' + kind + ' draft, selected text, focus and editor scroll', async ({ page }) => {
    const f = await boot(page, kind);
    try {
      await editor(page, kind).locator('[data-form-field="title"]').fill('Keep this unfinished title');
      const position = await open(page, kind); expect(position.top).toBeGreaterThan(100); await search(page);
      if (action === 'Cancel') await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click(); else await query(page).press('Escape');
      await expect(picker(page)).toHaveCount(0); await expect(body(page, kind)).toBeFocused(); await expect(body(page, kind)).toHaveValue(original);
      await expect(editor(page, kind).locator('[data-form-field="title"]')).toHaveValue('Keep this unfinished title');
      expect(await body(page, kind).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection, node.scrollTop]))
        .toEqual([position.start, position.end, position.direction, position.top]);
      await expect(content(page, kind)).toHaveJSProperty('scrollTop', position.contentTop); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });

test('a late failed query cannot replace newer results for another type', async ({ page }) => {
  const f = await boot(page); let release!: () => void, waiting = false;
  f.fixtureCaller(async (method, args) => {
    if (method === 'work_entity.search' && args.query === 'Old') { waiting = true; await new Promise<void>(done => { release = done; }); return { error: { code: 'unavailable', message: 'Old private diagnostic' } }; }
    return undefined;
  });
  try {
    await open(page); await picker(page).getByRole('combobox', { name: 'Record type', exact: true }).selectOption('task'); await query(page).fill('Old'); await query(page).press('Enter');
    await expect.poll(() => waiting).toBe(true); await query(page).fill('Pick target'); await picker(page).getByRole('combobox', { name: 'Record type', exact: true }).selectOption('note');
    await expect(result(page, 'note')).toBeVisible(); const before = await settled(page, 'work_entity.search', ''); release(); await waitSettled(page, 'work_entity.search', '', before);
    await expect(result(page, 'note')).toBeVisible(); await expect(picker(page)).not.toContainText('private diagnostic'); await expect(picker(page).getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
    await expect(query(page)).toHaveValue('Pick target'); expect(f.writes).toEqual([]);
  } finally { release?.(); f.dispose(); }
});

test('a failed task search leaves contact and Note matches usable and retries only Tasks', async ({ page }) => {
  const f = await boot(page); let fail = true;
  f.fixtureCaller((method, args) => method === 'work_entity.search' && args.kind === 'task' && fail ? { error: { code: 'unavailable', message: 'private search diagnostic' } } : undefined);
  try {
    await open(page); await search(page); await expect(result(page, 'contact')).toBeVisible(); const tasks = picker(page).getByRole('region', { name: 'Tasks', exact: true });
    await expect(tasks).toContainText('Tasks could not be searched. Try again.'); await expect(picker(page)).not.toContainText('private search diagnostic');
    const taskReads = f.queries.filter(row => row.method === 'work_entity.search' && row.args.kind === 'task').length,
      noteReads = f.queries.filter(row => row.method === 'work_entity.search' && row.args.kind === 'note').length;
    fail = false; await tasks.getByRole('button', { name: 'Try again', exact: true }).click(); await expect(result(page, 'task')).toBeVisible();
    expect(f.queries.filter(row => row.method === 'work_entity.search' && row.args.kind === 'task')).toHaveLength(taskReads + 1);
    expect(f.queries.filter(row => row.method === 'work_entity.search' && row.args.kind === 'note')).toHaveLength(noteReads); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const fault of ['deleted', 'wrong identity', 'failed read'] as const) test(fault + ' cannot insert a link until the exact record can be checked again', async ({ page }) => {
  const f = await boot(page), target = fault === 'deleted' ? 'note' : 'task';
  try {
    await open(page); await search(page);
    if (fault === 'deleted') f.removeNote(targetId(f, target));
    if (fault === 'wrong identity') f.taskReply(targetId(f, target), { entity: { ...f.task(), _kind: 'task' } });
    if (fault === 'failed read') f.fail('work_entity.get', targetId(f, target));
    await result(page, target).click(); await expect(picker(page).getByRole('alert')).toContainText(fault === 'deleted' ? 'no longer available' : 'could not be checked');
    await expect(body(page)).toHaveValue(original); expect(f.writes).toEqual([]);
    if (fault === 'deleted') f.seedNote(targetId(f, target), { title: title('note'), body: 'Restored note.' });
    if (fault === 'wrong identity') f.taskReply(targetId(f, target));
    if (fault === 'failed read') f.fail('work_entity.get', targetId(f, target), false);
    await result(page, target).click(); await expect(picker(page)).toHaveCount(0); await expect(body(page)).toHaveValue(expected(f, target)); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a closed late verification cannot replace a newer inserted link or steal editor focus', async ({ page }) => {
  const f = await boot(page);
  try {
    f.hold('work_entity.get', targetId(f, 'task')); f.fail('work_entity.get', targetId(f, 'task'));
    await open(page); await search(page); await result(page, 'task').click(); await expect.poll(f.waiting).toBe(true);
    await expect(picker(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await open(page); await search(page); await result(page, 'note').click();
    await expect(body(page)).toHaveValue(expected(f, 'note')); const before = await settled(page, 'work_entity.get', targetId(f, 'task'));
    f.release(); await waitSettled(page, 'work_entity.get', targetId(f, 'task'), before);
    await expect(body(page)).toHaveValue(expected(f, 'note')); await expect(body(page)).toBeFocused(); await expect(picker(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a draft changed during a pending check never takes the stale insertion', async ({ page }) => {
  const f = await boot(page);
  try {
    f.hold('work_entity.get', targetId(f, 'task')); await open(page); await search(page); await result(page, 'task').click(); await expect.poll(f.waiting).toBe(true);
    await body(page).evaluate((node: HTMLTextAreaElement) => { node.value = 'Newer draft text'; node.dispatchEvent(new Event('input', { bubbles: true })); }); f.release();
    await expect(picker(page).getByRole('alert')).toContainText('draft changed'); await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(body(page)).toHaveValue('Newer draft text'); await expect(body(page)).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('an insertion that exceeds the text limit preserves the entire draft', async ({ page }) => {
  const f = await boot(page);
  try {
    await body(page).evaluate((node: HTMLTextAreaElement) => { node.maxLength = node.value.length + 2; }); await open(page); await search(page); await result(page, 'task').click();
    await expect(picker(page).getByRole('alert')).toContainText('exceed the text limit'); await expect(body(page)).toHaveValue(original); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a real live-list repaint preserves the open picker, query selection, scroll and draft position', async ({ page }, info) => {
  const f = await boot(page, 'note', f => { for (let index = 0; index < 25; index++) f.seedTask('extra-' + index, { title: 'Pick target extra ' + index }); });
  try {
    const position = await open(page); await search(page); await expect(picker(page)).toContainText('More matches. Refine your search.');
    await query(page).evaluate((node: HTMLInputElement) => { node.focus(); node.setSelectionRange(2, 5); (window as unknown as { __originalLinkQuery: Element }).__originalLinkQuery = node; });
    const top = await picker(page).locator('[data-link-insert-results]').evaluate(node => { node.scrollTop = 80; return node.scrollTop; }); expect(top).toBeGreaterThan(0);
    const before = f.queries.filter(row => row.method === 'work_entity.list').length;
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'warehouse', collection: 'note', op: 'update', id: 'other', cursor: Date.now() } }));
    await expect.poll(() => f.queries.filter(row => row.method === 'work_entity.list').length).toBeGreaterThan(before);
    await expect.poll(() => query(page).evaluate(node => node !== (window as unknown as { __originalLinkQuery: Element }).__originalLinkQuery)).toBe(true);
    await expect(query(page)).toBeFocused(); await expect(query(page)).toHaveValue('Pick target');
    expect(await query(page).evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])).toEqual([2, 5]); await expect(picker(page).locator('[data-link-insert-results]')).toHaveJSProperty('scrollTop', top);
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: info.outputPath('record-link-search-phone.png'), fullPage: true });
    await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(body(page)).toBeFocused(); await expect(body(page)).toHaveValue(original);
    await expect(body(page)).toHaveJSProperty('scrollTop', position.top); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('Tab stays in the picker and arrow keys insert the selected contact without navigating', async ({ page }) => {
  const f = await boot(page);
  try {
    await open(page); await search(page); const url = page.url(), cancel = picker(page).getByRole('button', { name: 'Cancel', exact: true });
    const previewNote = picker(page).getByRole('button', { name: 'Preview ' + title('note'), exact: true });
    await cancel.focus(); await page.keyboard.press('Shift+Tab'); await expect(previewNote).toBeFocused();
    await page.keyboard.press('Enter'); await expect(picker(page).getByRole('heading', { name: title('note'), exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(previewNote).toBeFocused();
    await page.keyboard.press('Tab'); await expect(cancel).toBeFocused(); await query(page).focus(); await page.keyboard.press('ArrowDown');
    await expect(result(page, 'contact')).toBeFocused(); await page.keyboard.press('Enter'); await expect(picker(page)).toHaveCount(0);
    await expect(body(page)).toHaveValue(expected(f, 'contact')); await expect(body(page)).toBeFocused(); expect(page.url()).toBe(url); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('inserted text is recovered after immediate reload without writing the saved Note', async ({ page }) => {
  const f = await boot(page);
  try {
    await open(page); await search(page); await result(page, 'note').click(); await reload(page);
    await reader(page).getByRole('region', { name: 'Unfinished notes', exact: true }).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(body(page)).toHaveValue(expected(f, 'note')); expect(f.note('origin-note').body).toBe(original); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('ordinary editing stays available without native dialog support', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: undefined }); });
  const f = await boot(page);
  try {
    await expect(editor(page).getByRole('button', { name: 'Insert record link', exact: true })).toHaveCount(0);
    await body(page).fill('Ordinary saved edit.'); await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page)).toContainText('Ordinary saved edit.'); expect(f.writes).toHaveLength(1);
  } finally { f.dispose(); }
});

for (const kind of ['note', 'task'] as const) test('inserting into a ' + kind + ' supports native Undo and Redo before Save', async ({ page }) => {
  const f = await boot(page, kind);
  try {
    await open(page, kind); await search(page); await result(page, 'task').click(); await expect(body(page, kind)).toHaveValue(expected(f, 'task'));
    await page.keyboard.press('ControlOrMeta+z'); await expect(body(page, kind)).toHaveValue(original); expect(f.writes).toEqual([]);
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(body(page, kind)).toHaveValue(expected(f, 'task'));
    await editor(page, kind).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page, kind)).toBeVisible(); expect(saved(f, kind).body).toBe(expected(f, 'task')); expect(f.writes).toHaveLength(1);
  } finally { f.dispose(); }
});

test('plain range insertion still works when the native editing command is unavailable', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined }); });
  const f = await boot(page);
  try {
    await open(page); await search(page); await result(page, 'task').click();
    await expect(body(page)).toHaveValue(expected(f, 'task')); await expect(body(page)).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
