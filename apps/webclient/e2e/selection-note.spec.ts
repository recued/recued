import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, SHELL_CONTENT, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 900 } });
type Kind = 'mail' | 'note';
const quote = 'Keep this selected reference. 二🧾';
const sourceBody = '# Research\n\n' + 'Earlier background.\n\n'.repeat(80) + quote + '\n\nOther reference text.';
const toolbar = (p: Page) => p.getByRole('complementary', { name: 'Selected text actions', exact: true });
const action = (p: Page) => toolbar(p).getByRole('button', { name: 'Save selection to a note', exact: true });
const picker = (p: Page) => p.getByRole('dialog', { name: 'Save selection to a note', exact: true });
const editor = (p: Page) => p.locator('.work-entity-dialog[data-kind="note"]');
const text = (p: Page) => editor(p).locator('[data-form-field="body"]');
const bodySelector = (kind: Kind) => kind === 'mail' ? '[data-mail-message-body]' : '[data-note-body]';
const scroll = (p: Page, kind: Kind) => p.locator(kind === 'note' ? '.work-entity-note-content' : `[${SHELL_CONTENT}]`);
const boot = async (page: Page, kind: Kind, caller?: Parameters<typeof installTaskNoteSourceFixture>[1]) => {
  const f = await installTaskNoteSourceFixture(page, { searchable: true, ...caller });
  f.seedNote('source-note', { title: 'Source reference', body: sourceBody }); f.updateMail('work', { body: sourceBody });
  f.seedNote('destination', { title: 'Project research', body: 'Existing research stays exactly.\n', related_project_ids: ['project-one'] });
  const hash = kind === 'note' ? serializeShellRoute('data', 'note', 'source-note') : serializeSourceRecordAddress(f.source('mail'));
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + hash);
  await page.waitForFunction(() => window.__app?.ready === true); await expect(page.locator(bodySelector(kind))).toContainText(quote);
  return { ...f, hash };
};
const select = async (p: Page, kind: Kind) => {
  await p.locator(bodySelector(kind)).evaluate((body, quote) => {
    const all = body.textContent!, begin = all.indexOf(quote); if (begin < 0) throw new Error('Quotation is missing.');
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT), range = document.createRange(); let node: Node | null, offset = 0, started = false;
    while ((node = walker.nextNode())) {
      const end = offset + node.textContent!.length;
      if (!started && begin >= offset && begin < end) { range.setStart(node, begin - offset); started = true; }
      if (started && begin + quote.length <= end) { range.setEnd(node, begin + quote.length - offset); break; }
      offset = end;
    }
    const content = body.closest('.work-entity-note-content') ?? document.querySelector('[data-recued-webclient-content]')!;
    content.scrollTop += range.getBoundingClientRect().top - content.getBoundingClientRect().top - 150;
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  }, quote);
  await expect(action(p)).toBeEnabled();
};
const open = async (p: Page, kind: Kind) => { await select(p, kind); await action(p).click(); await expect(picker(p)).toBeVisible(); };
const existing = async (p: Page) => {
  await picker(p).getByRole('searchbox', { name: 'Find an existing note', exact: true }).fill('Project research');
  await picker(p).getByRole('button', { name: 'Search notes', exact: true }).click();
  await picker(p).getByRole('button', { name: 'Use note Project research', exact: true }).click(); await expect(editor(p)).toBeVisible();
};
const selected = (p: Page) => p.evaluate(() => window.getSelection()?.toString());

for (const kind of ['mail', 'note'] as const) {
  test(kind + ': reviews a new quoted note and returns to the same selection, Find and position after Save', async ({ page }, info) => {
    const f = await boot(page, kind);
    try {
      const reader = page.locator(kind === 'note' ? '.work-entity-note-reader' : '.data-mail-message');
      await reader.getByRole('button', { name: kind === 'note' ? 'Find in note' : 'Find in email', exact: true }).click();
      const find = page.locator(kind === 'note' ? '[data-note-find-input]' : '[data-mail-find-input]'); await find.fill('selected');
      await select(page, kind); const top = await scroll(page, kind).evaluate(node => node.scrollTop); await action(page).click();
      await picker(page).getByRole('button', { name: 'Create a new note', exact: true }).click();
      await expect(editor(page)).toBeVisible(); await expect(editor(page).locator('[data-form-field="title"]')).toHaveValue(quote);
      const draft = await text(page).inputValue(); expect(draft).toContain('> ' + quote); expect(draft).toContain(f.hash); expect(draft).not.toContain('Earlier background');
      expect(f.writes).toEqual([]); await text(page).fill(draft + '\n\nMy additional context.');
      await page.screenshot({ path: info.outputPath('quoted-note-review.png') });
      await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
      await page.locator('.work-entity-note-reader').getByRole('button', { name: kind === 'mail' ? 'Back to email' : 'Back to note', exact: true }).click();
      await expect.poll(() => selected(page)).toBe(quote); await expect(find).toHaveValue('selected'); await expect(action(page)).toBeFocused();
      await expect.poll(() => scroll(page, kind).evaluate(node => node.scrollTop)).toBeCloseTo(top, 0);
      expect(f.writes).toHaveLength(1); const saved = f.notes().find(note => note.id !== 'source-note' && note.id !== 'destination')!;
      expect(saved.body).toBe(draft + '\n\nMy additional context.'); expect(f.note('source-note').body).toBe(sourceBody);
    } finally { f.dispose(); }
  });
  test(kind + ': appends to an existing note only on Save and retains its original text and relationships', async ({ page }) => {
    const f = await boot(page, kind);
    try {
      const before = structuredClone(f.note('destination')); await open(page, kind); await existing(page);
      const draft = await text(page).inputValue(); expect(draft.startsWith(before.body)).toBe(true); expect(draft).toContain('> ' + quote); expect(draft).toContain(f.hash);
      expect(f.note('destination')).toEqual(before); expect(f.writes).toEqual([]);
      await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.locator('.work-entity-note-reader')).toHaveAttribute('data-note-id', 'destination');
      expect(f.note('destination')).toMatchObject({ body: draft, title: before.title, related_project_ids: before.related_project_ids });
      expect(f.writes[0]!.args.expected_revision).toMatch(/^[a-f0-9]{64}$/u); expect(f.notes()).toHaveLength(2);
      await page.locator('.work-entity-note-reader').getByRole('button', { name: kind === 'mail' ? 'Back to email' : 'Back to note', exact: true }).click();
      await expect.poll(() => selected(page)).toBe(quote); await expect(action(page)).toBeFocused();
    } finally { f.dispose(); }
  });
  test(kind + ': picker cancellation and protected editor discard return without creating or changing a note', async ({ page }) => {
    const f = await boot(page, kind);
    try {
      await open(page, kind); await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(action(page)).toBeFocused();
      await action(page).click(); await existing(page);
      const back = editor(page).getByRole('button', { name: 'Cancel', exact: true });
      await back.click(); await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click(); await expect(editor(page)).toBeVisible();
      await back.click(); await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect.poll(() => selected(page)).toBe(quote); await expect(action(page)).toBeFocused(); expect(f.writes).toEqual([]); expect(f.notes()).toHaveLength(2);
    } finally { f.dispose(); }
  });
}

test('a concurrent destination edit rejects Save and leaves the reviewed passage and owner edits available', async ({ page }) => {
  const f = await boot(page, 'mail');
  try {
    await open(page, 'mail'); await existing(page); const draft = await text(page).inputValue() + '\nMy edits'; await text(page).fill(draft);
    f.updateNote('destination', { body: 'Newer research from another client.' });
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page).getByRole('alert')).toContainText('note changed');
    await expect(text(page)).toHaveValue(draft); expect(f.note('destination').body).toBe('Newer research from another client.'); expect(f.notes()).toHaveLength(2);
  } finally { f.dispose(); }
});

test('a recovered append keeps its original revision guard against an edit made after resuming', async ({ page }) => {
  const f = await boot(page, 'mail');
  try {
    await open(page, 'mail'); await existing(page); const draft = await text(page).inputValue(); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await page.getByRole('region', { name: 'Unfinished notes', exact: true }).getByRole('button', { name: 'Resume draft', exact: true }).click(); await expect(text(page)).toHaveValue(draft);
    f.updateNote('destination', { body: 'Changed after resuming.' }); await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toContainText('note changed'); expect(f.note('destination').body).toBe('Changed after resuming.'); await expect(text(page)).toHaveValue(draft);
  } finally { f.dispose(); }
});

test('cancelling a pending destination read retires its late reply and keeps the source selection', async ({ page }) => {
  const f = await boot(page, 'note');
  try {
    await open(page, 'note'); await picker(page).getByRole('searchbox').fill('Project research'); await picker(page).getByRole('button', { name: 'Search notes', exact: true }).click();
    f.hold('work_entity.get', 'destination'); await picker(page).getByRole('button', { name: 'Use note Project research', exact: true }).click(); await expect.poll(f.waiting).toBe(true);
    await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click(); f.release();
    await expect(action(page)).toBeEnabled(); await expect(action(page)).toBeFocused(); await expect(page.locator('.work-entity-note-form')).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a source changed while choosing a note cannot seed a quotation from stale text', async ({ page }) => {
  const f = await boot(page, 'mail');
  try {
    await open(page, 'mail'); f.updateMail('work', { body: 'Changed original email.' }); await picker(page).getByRole('button', { name: 'Create a new note', exact: true }).click();
    await expect(toolbar(page).getByRole('alert')).toContainText('passage changed'); await expect(page.locator('.work-entity-note-form')).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('existing-note search filters read-only sources and an older server can still create a new quoted note', async ({ page }) => {
  let f!: Awaited<ReturnType<typeof boot>>;
  f = await boot(page, 'mail', { caller: (method, args) => method === 'work_entity.get' && args.id === 'destination'
    ? { result: { entity: { _kind: 'note', ...f.note('destination') } } } : undefined });
  try {
    f.registerSource('locked.note', 'note', false); f.seedNote('locked', { title: 'Project locked reference', source_id: 'locked.note', body: 'Keep unchanged.' });
    await open(page, 'mail'); await picker(page).getByRole('searchbox').fill('Project'); await picker(page).getByRole('button', { name: 'Search notes', exact: true }).click();
    await expect(picker(page).getByRole('button', { name: 'Use note Project research', exact: true })).toBeVisible();
    await expect(picker(page).getByRole('button', { name: 'Use note Project locked reference', exact: true })).toHaveCount(0);
    await picker(page).getByRole('button', { name: 'Use note Project research', exact: true }).click(); await expect(picker(page).getByRole('status').last()).toContainText('Update your Recued server');
    await picker(page).getByRole('button', { name: 'Create a new note', exact: true }).click(); await expect(editor(page)).toHaveAttribute('data-mode', 'create'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('browser Back protects an unsaved clipped note and restores the original note selection after acceptance', async ({ page }) => {
  const f = await boot(page, 'note');
  try {
    await open(page, 'note'); await picker(page).getByRole('button', { name: 'Create a new note', exact: true }).click();
    await expect(text(page)).toContainText(quote); page.once('dialog', dialog => { void dialog.accept(); }); await page.goBack();
    await expect.poll(() => selected(page)).toBe(quote); await expect(action(page)).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a lost new-note acknowledgement keeps the quotation and a second Save cannot create another note', async ({ page }) => {
  const f = await boot(page, 'mail');
  try {
    await open(page, 'mail'); await picker(page).getByRole('button', { name: 'Create a new note', exact: true }).click();
    const draft = await text(page).inputValue(); f.reply('lost'); await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toBeVisible(); await expect(text(page)).toHaveValue(draft); expect(f.notes()).toHaveLength(3);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page).getByRole('alert')).toContainText('previous save was not confirmed');
    expect(f.writes).toHaveLength(1); expect(f.notes()).toHaveLength(3);
  } finally { f.dispose(); }
});

test('a search display label can be a fallback or shortened without changing the note being edited', async ({ page }) => {
  const f = await boot(page, 'mail');
  try {
    const cases = [{ id: 'untitled', body: 'Untitled reference context', title: undefined },
      { id: 'long-title', body: 'Long reference context', title: 'Long reference ' + 'research '.repeat(18) }];
    for (const destination of cases) {
      f.seedNote(destination.id, destination); await open(page, 'mail'); await picker(page).getByRole('searchbox').fill(destination.body);
      await picker(page).getByRole('button', { name: 'Search notes', exact: true }).click();
      await picker(page).locator('[data-selection-note-results] button').click(); await expect(editor(page)).toBeVisible();
      await expect(editor(page).locator('[data-form-field="title"]')).toHaveValue(destination.title ?? ''); expect((await text(page).inputValue()).startsWith(destination.body)).toBe(true);
      await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(action(page)).toBeFocused(); expect(f.note(destination.id).body).toBe(destination.body);
    }
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
