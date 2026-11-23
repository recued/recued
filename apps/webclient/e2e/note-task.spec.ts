import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const body = '# Launch notes\n\nneedle first\n\n' + 'Saved meeting context.\n\n'.repeat(90) + '## Decisions\n\nneedle last\n\nKeep <script>raw</script> text 二.';
const note = (page: Page) => page.locator('.work-entity-note-reader');
const editor = (page: Page) => page.locator('.work-entity-dialog[data-kind="task"][data-mode="create"]');
const task = (page: Page) => page.locator('.work-entity-task-reader');
const trigger = (page: Page) => note(page).locator('[data-action="create-note-task"]');
const openCreated = (page: Page) => note(page).getByRole('button', { name: 'Open task', exact: true });
const made = (f: Fixture) => f.tasks().filter(row => !['task-one', 'task-two'].includes(row.id));
const route = (page: Page, hash: string) => page.evaluate(hash => window.__app.setHash(hash), hash);
const boot = async (page: Page, prepare?: (f: Fixture) => void, id = 'note-one', hash = serializeShellRoute('data', 'note', id)) => {
  const f = await installTaskNoteSourceFixture(page);
  f.seedNote(id, { title: 'Launch notes <img src=x>', body, related_contact_ids: [f.person.contact_id!], related_project_ids: ['project-one'] });
  f.seedNote('note-other', { title: 'Other saved note', body: 'Separate note text.' }); f.registerSource('other.task', 'task'); prepare?.(f);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (hash === '#data/search') await expect(page.getByRole('searchbox', { name: 'Search everything', exact: true })).toBeVisible();
  else await expect(note(page)).toHaveAttribute('data-note-id', id);
  return f;
};
const create = async (page: Page) => {
  await trigger(page).focus(); await trigger(page).press('Enter');
  await expect(editor(page)).toBeVisible(); await expect(editor(page).getByRole('textbox', { name: 'Title', exact: true })).toBeFocused();
};
const cancel = async (page: Page) => {
  await editor(page).getByRole('button', { name: 'Back to note', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click(); await expect(note(page)).toBeVisible();
};
const reload = async (page: Page) => {
  const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); }; page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); } await page.waitForFunction(() => window.__app?.ready === true);
};

test('reviews a note follow-up, saves to the chosen task source, and restores Find and reading position with a fresh Open task shortcut', async ({ page }, info) => {
  const f = await boot(page), original = f.note();
  try {
    await note(page).getByRole('button', { name: 'Formatted', exact: true }).click();
    await note(page).getByRole('button', { name: 'Find in note', exact: true }).click();
    const find = note(page).getByRole('searchbox', { name: 'Find in this note', exact: true }); await find.fill('needle'); await find.press('Enter');
    await expect(note(page).locator('[data-note-find-status]')).toHaveText('2 of 2 matches.');
    const scroll = await note(page).locator('.work-entity-note-content').evaluate(node => node.scrollTop); expect(scroll).toBeGreaterThan(500);
    await create(page); await expect(editor(page).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(original.title!);
    await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveValue(new RegExp('Note: .*#data/note/note-one\\n\\nNote excerpt \\(partial\\):\\n# Launch notes'));
    await expect(editor(page).locator('[data-form-field="due_at"]')).toHaveValue(''); expect(f.writes).toEqual([]);
    await editor(page).getByLabel('Source', { exact: true }).selectOption('other.task');
    await editor(page).getByRole('textbox', { name: 'Title', exact: true }).fill('Send the launch follow-up');
    await editor(page).locator('[data-form-field="due_at"]').fill('2030-11-01T09:45'); await editor(page).getByLabel('Priority', { exact: true }).selectOption('high');
    await page.screenshot({ path: info.outputPath('note-task-draft-phone.png'), fullPage: true });
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(note(page).locator('[data-note-created-task]')).toContainText('Task created: Send the launch follow-up'); await expect(trigger(page)).toBeFocused();
    await expect(find).toHaveValue('needle'); await expect(note(page).locator('[data-note-find-status]')).toHaveText('2 of 2 matches.');
    await expect(note(page).getByRole('button', { name: 'Formatted', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await note(page).locator('.work-entity-note-content').evaluate(node => node.scrollTop)).toBeCloseTo(scroll, -1);
    expect(f.note()).toEqual(original); expect(made(f)).toHaveLength(1);
    const saved = made(f)[0]!; expect(saved).toMatchObject({ title: 'Send the launch follow-up', source_id: 'other.task', priority: 'high', due_at: Date.parse('2030-11-01T09:45:00-07:00') });
    expect(saved.assigned_contact_id).toBeUndefined(); expect(saved.parent_project_id).toBeUndefined(); expect(f.writes).toHaveLength(1);
    f.updateTask(saved.id, { title: 'Freshly renamed task' }); await openCreated(page).click();
    await expect(task(page).getByRole('heading', { name: 'Freshly renamed task', exact: true })).toBeVisible();
    await task(page).getByRole('button', { name: 'Back to note', exact: true }).click(); await expect(find).toHaveValue('needle');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: info.outputPath('note-task-created-phone-dark.png'), fullPage: true });
  } finally { f.dispose(); }
});

test('requires explicit discard for the prefilled task and returns to the same note without writing', async ({ page }) => {
  const f = await boot(page), original = f.note();
  try {
    await create(page); await editor(page).getByRole('button', { name: 'Back to note', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click(); await expect(editor(page)).toBeVisible();
    await cancel(page); await expect(trigger(page)).toBeFocused(); await expect(openCreated(page)).toHaveCount(0);
    expect(f.note()).toEqual(original); expect(f.writes).toEqual([]); expect(made(f)).toEqual([]);
    await route(page, '#data/task'); await expect(page.getByRole('region', { name: 'Unfinished tasks', exact: true })).toHaveCount(0);
  } finally { f.dispose(); }
});

test('keeps the exact source-note link for opaque IDs and copies text as plain saved content', async ({ page }) => {
  const id = "shared/note?二.)!'*", f = await boot(page, undefined, id);
  try {
    await create(page); const values = await editor(page).getByLabel('Notes', { exact: true }).inputValue();
    const url = values.split('\n')[0]!.slice(6); expect(new URL(url).hash).toBe(serializeShellRoute('data', 'note', id)); expect(new URL(url).search).toBe('');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await openCreated(page).click();
    await expect(task(page).locator('a[data-task-note-link]')).toHaveAttribute('href', url); await expect(task(page).locator('script,img')).toHaveCount(0); expect(f.note(id).body).toBe(body);
  } finally { f.dispose(); }
});

for (const state of ['read-only', 'stale'] as const) test(`creates a separate task from a ${state} note while leaving the source note intact`, async ({ page }) => {
  const f = await boot(page, f => {
    if (state === 'read-only') { f.registerSource('imported.note', 'note', false); f.updateNote('note-one', { source_id: 'imported.note' }); }
    else f.updateNote('note-one', { sync_state: 'stale_unreachable' });
  }), original = f.note();
  try {
    await expect(note(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0); await create(page);
    if (state === 'stale') await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveValue(/source is unconfirmed/);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(openCreated(page)).toBeVisible();
    expect(f.note()).toEqual(original); expect(made(f)).toHaveLength(1); expect(f.writes.map(write => write.args.kind)).toEqual(['task']);
  } finally { f.dispose(); }
});

for (const failure of ['read', 'destinations'] as const) test(`keeps the note readable when task preparation fails at ${failure}, then retries`, async ({ page }) => {
  const f = await boot(page);
  try {
    if (failure === 'read') f.fail('work_entity.source.list', ''); else { f.writable(false); f.registerSource('other.task', 'task', false); }
    await trigger(page).click(); await expect(note(page).locator('[data-note-notice]')).toContainText(failure === 'read' ? 'interrupted' : 'No writable task Source');
    await expect(editor(page)).toHaveCount(0); await expect(note(page)).toBeVisible();
    f.fail('work_entity.source.list', '', false); f.writable(true); await create(page); expect(f.writes).toEqual([]); expect(made(f)).toEqual([]);
  } finally { f.dispose(); }
});

for (const destination of ['other-note', 'editor', 'chat'] as const) test(`late preparation cannot replace ${destination} after leaving the original note`, async ({ page }) => {
  const f = await boot(page);
  try {
    f.hold('work_entity.source.list', ''); await trigger(page).click(); await expect.poll(() => f.waiting()).toBe(true);
    await trigger(page).evaluate((node: HTMLButtonElement) => node.click());
    if (destination === 'other-note') { await route(page, '#data/note/note-other'); await expect(note(page)).toHaveAttribute('data-note-id', 'note-other'); }
    if (destination === 'editor') { await note(page).getByRole('button', { name: 'Edit', exact: true }).click(); await expect(page.locator('.work-entity-dialog[data-kind="note"][data-mode="edit"]')).toBeVisible(); }
    if (destination === 'chat') { await route(page, '#chat'); await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible(); }
    const before = await page.evaluate(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'work_entity.source.list:').length);
    f.release(); await page.waitForFunction(before => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'work_entity.source.list:').length > before, before);
    await expect(editor(page)).toHaveCount(0); expect(f.writes).toEqual([]); expect(made(f)).toEqual([]);
    if (destination === 'other-note') await expect(note(page)).toHaveAttribute('data-note-id', 'note-other');
    if (destination === 'editor') await expect(page.locator('.work-entity-dialog[data-kind="note"][data-mode="edit"]')).toBeVisible();
    if (destination === 'chat') await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
  } finally { f.dispose(); }
});

test('recovers an unfinished follow-up after reload with its chosen destination, due date and exact note link', async ({ page }) => {
  const f = await boot(page);
  try {
    await create(page); await editor(page).getByLabel('Source', { exact: true }).selectOption('other.task');
    await editor(page).getByRole('textbox', { name: 'Title', exact: true }).fill('Recovered note follow-up'); await editor(page).locator('[data-form-field="due_at"]').fill('2030-11-01T09:45');
    const notes = await editor(page).getByLabel('Notes', { exact: true }).inputValue(); await reload(page);
    await page.getByRole('region', { name: 'Unfinished tasks', exact: true }).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor(page).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Recovered note follow-up'); await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveValue(notes);
    await expect(editor(page).getByLabel('Source', { exact: true })).toHaveValue('other.task'); await expect(editor(page).locator('[data-form-field="due_at"]')).toHaveValue('2030-11-01T09:45');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    await expect(page.locator('.work-entity-list-row-button[data-kind="task"]').filter({ hasText: 'Recovered note follow-up' })).toBeVisible();
    expect(made(f)).toHaveLength(1); expect(made(f)[0]!.body).toBe(notes);
  } finally { f.dispose(); }
});

test('browser Back returns to the retained note and keeps the unfinished task recoverable', async ({ page }) => {
  const f = await boot(page);
  try {
    await create(page); await editor(page).getByRole('textbox', { name: 'Title', exact: true }).fill('Still reviewing the follow-up');
    page.once('dialog', dialog => { void dialog.accept(); }); await page.goBack();
    await expect(note(page)).toHaveAttribute('data-note-id', 'note-one'); await expect(trigger(page)).toBeFocused(); expect(f.writes).toEqual([]);
    await route(page, '#data/task'); await expect(page.getByRole('region', { name: 'Unfinished tasks', exact: true })).toContainText('Still reviewing the follow-up');
  } finally { f.dispose(); }
});

for (const reply of ['lost', 'pending'] as const) test(`a ${reply} task save stays recoverable and cannot create a second task`, async ({ page }) => {
  const f = await boot(page);
  try {
    await create(page); f.reply(reply); await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toContainText(reply === 'lost' ? 'save reply was lost' : 'did not confirm'); await expect(note(page).locator('[data-note-created-task]')).toHaveCount(0);
    f.reply('confirmed'); await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toContainText('previous save was not confirmed'); expect(f.writes).toHaveLength(1); expect(made(f)).toHaveLength(1);
    await reload(page); const recovery = page.getByRole('region', { name: 'Unfinished tasks', exact: true }); await expect(recovery).toContainText('Save was not confirmed');
    await expect(recovery.getByRole('button', { name: 'Resume draft', exact: true })).toBeDisabled();
  } finally { f.dispose(); }
});

test('a held save accepts one activation and returns only after source confirmation', async ({ page }) => {
  const f = await boot(page);
  try {
    await create(page); f.hold('work_entity.upsert', ''); await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => f.waiting()).toBe(true);
    const saving = editor(page).locator('button.work-entity-dialog-submit'); await expect(saving).toHaveCount(1); await expect(saving).toBeDisabled();
    await saving.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await expect(note(page)).toHaveCount(0); f.release(); await expect(openCreated(page)).toBeVisible(); expect(f.writes).toHaveLength(1); expect(made(f)).toHaveLength(1);
  } finally { f.dispose(); }
});

test('Open task refuses a removed created task and retains the note for a retry', async ({ page }) => {
  const f = await boot(page);
  try {
    await create(page); await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(openCreated(page)).toBeVisible();
    f.removeTask(made(f)[0]!.id); await openCreated(page).click(); await expect(note(page).locator('[data-note-notice]')).toContainText('no longer available'); await expect(task(page)).toHaveCount(0);
    await expect(note(page)).toHaveAttribute('data-note-id', 'note-one'); expect(f.writes).toHaveLength(1);
  } finally { f.dispose(); }
});

test('creating from a search result preserves the search query and its return path', async ({ page }) => {
  const f = await boot(page, undefined, 'note-one', '#data/search');
  try {
    const search = page.getByRole('searchbox', { name: 'Search everything', exact: true }); await search.fill('Launch notes');
    const hit = page.locator('[data-work-search-group="note"] [data-search-work-id="note-one"]'); await hit.click(); await create(page);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(openCreated(page)).toBeVisible();
    await note(page).getByRole('button', { name: 'Back to search', exact: true }).click(); await expect(search).toHaveValue('Launch notes'); await expect(hit).toBeFocused(); expect(made(f)).toHaveLength(1);
  } finally { f.dispose(); }
});
