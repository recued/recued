import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installWorkProjectPickerFixture } from './helpers/work-project-picker-fixture.js';

installFullAppHooks();
type Kind = 'task' | 'note';
const editor = (page: Page, kind: Kind = 'task') => page.locator(`.work-entity-dialog[data-kind="${kind}"]`).filter({ has: page.locator('.work-entity-dialog-form') });
const picker = (page: Page, field = 'parent_project') => page.locator(`[data-ref-picker="form-ref-${field}"]`);
const input = (page: Page, field?: string) => picker(page, field).getByRole('combobox');
const boot = async (page: Page, kind: Kind = 'task', prepare?: (fixture: Awaited<ReturnType<typeof installWorkProjectPickerFixture>>) => void,
  prepareEditor?: (fixture: Awaited<ReturnType<typeof installWorkProjectPickerFixture>>) => void) => {
  const fixture = await installWorkProjectPickerFixture(page); prepare?.(fixture);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/${kind}/${kind}-one`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (prepareEditor) {
    await expect(page.locator('.work-entity-task-reader [data-action="open-task-related"][data-task-related-key="project:project-a"]')).toBeVisible();
    prepareEditor(fixture);
  }
  await page.locator(`.work-entity-${kind}-reader`).getByRole('button', { name: 'Edit', exact: true }).click();
  await editor(page, kind).getByRole('button', { name: 'More details', exact: true }).click();
  return fixture;
};
const choose = async (page: Page, field: string, query: string, name: string) => {
  const box = picker(page, field); await box.getByRole('combobox').fill(query);
  await box.getByRole('option', { name, exact: true }).click();
  await expect(box.getByRole('combobox')).toHaveValue(name);
};
const reload = async (page: Page) => {
  const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); }; page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); }
  await page.waitForFunction(() => window.__app?.ready === true);
};

const recentProjects = (page: Page) => page.evaluate(() => {
  const key = Object.keys(sessionStorage).find(key => key.startsWith('recued.reference.choices.v1:'));
  return key ? (JSON.parse(sessionStorage.getItem(key)!) as Array<{ kind: string; id: string }>).filter(row => row.kind === 'project').map(row => row.id) : [];
});

test('recent project choices reload with current names, support keyboard reuse and clear without changing the draft', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 }); const fixture = await boot(page);
  try {
    await choose(page, 'parent_project', 'Café', 'Café <review> · Recued'); await expect.poll(() => recentProjects(page)).toEqual(['project-c']);
    fixture.rename('project-c', 'Renamed café <review>'); await picker(page).getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(picker(page).getByRole('option')).toHaveText('Renamed café <review> · RecuedRecent choice');
    await input(page).press('ArrowDown'); await input(page).press('Enter'); await expect(picker(page).locator('[data-ref-picker-value]')).toHaveValue('project-c');
    await picker(page).getByRole('button', { name: 'Preview selected project', exact: true }).click();
    await expect(picker(page).getByRole('region', { name: 'Project preview', exact: true }).getByRole('heading')).toHaveText('Renamed café <review>');
    await page.keyboard.press('Escape'); await reload(page);
    await page.getByRole('region', { name: 'Unfinished tasks', exact: true }).getByRole('button', { name: 'Resume draft', exact: true }).click();
    const details = editor(page).getByRole('button', { name: 'More details', exact: true }); if (await details.isVisible()) await details.click();
    await expect(input(page)).toHaveValue('Renamed café <review> · Recued'); await input(page).focus();
    await expect(picker(page).getByRole('option')).toContainText('Recent choice');
    await input(page).press('ArrowDown'); await page.screenshot({ path: info.outputPath('recent-project-choices-phone.png'), fullPage: true }); await input(page).press('Escape');
    await input(page).fill('café'); await input(page).evaluate(el => (el as HTMLInputElement).setSelectionRange(1, 3));
    await picker(page).getByRole('button', { name: 'Clear recent projects', exact: true }).click();
    await expect(input(page)).toHaveValue('café'); await expect(input(page)).toBeFocused();
    expect(await input(page).evaluate(el => [(el as HTMLInputElement).selectionStart, (el as HTMLInputElement).selectionEnd])).toEqual([1, 3]);
    await expect(picker(page).locator('[data-ref-picker-value]')).toHaveValue('project-c'); await expect.poll(() => recentProjects(page)).toEqual([]); expect(fixture.writes).toEqual([]);
    await editor(page).locator('[data-form-field="title"]').focus(); await input(page).focus(); await expect(picker(page).getByRole('listbox')).toContainText('No recent projects yet. Type to search.');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([{ kind: 'task', id: 'task-one', parent_project_id: 'project-c' }]);
  } finally { fixture.dispose(); }
});

test('recent project reads keep usable rows through failures and cannot replace a newer query or a cleared list', async ({ page }) => {
  const fixture = await boot(page);
  const delivered = () => page.evaluate(() => (window as unknown as { __workProjectSettled: Record<string, number> }).__workProjectSettled['work_entity.get:project-b'] ?? 0);
  const release = async () => { const count = await delivered(); fixture.release('project-b'); await page.waitForFunction(count => (window as unknown as { __workProjectSettled: Record<string, number> }).__workProjectSettled['work_entity.get:project-b']! > count, count); };
  try {
    await choose(page, 'parent_project', 'Launch', 'Launch · Recued'); await expect.poll(() => recentProjects(page)).toEqual(['project-a']);
    await choose(page, 'parent_project', 'Launch', 'Launch · Imported'); await expect.poll(() => recentProjects(page)).toEqual(['project-b', 'project-a']);
    await choose(page, 'parent_project', 'Café', 'Café <review> · Recued'); await expect.poll(() => recentProjects(page)).toEqual(['project-c', 'project-b', 'project-a']);
    fixture.removeProject('project-c'); fixture.failName('project-b', true); await input(page).fill('');
    await expect(picker(page).getByRole('option')).toHaveText('Launch · RecuedRecent choice'); await expect(picker(page)).toContainText('Some recent projects could not be checked');
    fixture.failName('project-b', false); await picker(page).getByRole('button', { name: 'Try again', exact: true }).click(); await expect(picker(page).getByRole('option')).toHaveCount(2);
    fixture.holdName('project-b'); await editor(page).locator('[data-form-field="title"]').focus(); await input(page).focus(); await expect.poll(() => fixture.waiting('project-b')).toBe(true);
    await input(page).fill('not-in-this-project-list'); await expect(picker(page).getByRole('listbox')).toContainText('No matching projects.'); await release();
    await expect(picker(page).getByRole('option')).toHaveCount(0); await expect(input(page)).toHaveValue('not-in-this-project-list');
    fixture.holdName('project-b'); await input(page).fill(''); await expect.poll(() => fixture.waiting('project-b')).toBe(true);
    await picker(page).getByRole('button', { name: 'Clear recent projects', exact: true }).click(); await release();
    await expect(picker(page).getByRole('option')).toHaveCount(0); await expect(picker(page).getByRole('listbox')).toContainText('No recent projects yet. Type to search.');
    await expect(picker(page).locator('[data-ref-picker-value]')).toHaveValue('project-c'); await expect.poll(() => recentProjects(page)).toEqual([]); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('clearing recent projects prevents a late selection-name read from adding that choice again', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await choose(page, 'parent_project', 'Café', 'Café <review> · Recued'); await expect.poll(() => recentProjects(page)).toEqual(['project-c']);
    fixture.holdName('project-b'); await choose(page, 'parent_project', 'Launch', 'Launch · Imported'); await expect.poll(() => fixture.waiting('project-b')).toBe(true);
    await picker(page).getByRole('button', { name: 'Clear recent projects', exact: true }).click(); await expect.poll(() => recentProjects(page)).toEqual([]);
    const count = await page.evaluate(() => (window as unknown as { __workProjectSettled: Record<string, number> }).__workProjectSettled['work_entity.get:project-b'] ?? 0);
    fixture.release('project-b'); await page.waitForFunction(count => (window as unknown as { __workProjectSettled: Record<string, number> }).__workProjectSettled['work_entity.get:project-b']! > count, count);
    await expect.poll(() => recentProjects(page)).toEqual([]); await expect(picker(page).locator('[data-ref-picker-value]')).toHaveValue('project-b');
    await expect(picker(page).getByRole('listbox')).toContainText('No recent projects yet. Type to search.'); expect(fixture.writes).toEqual([]);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([{ kind: 'task', id: 'task-one', parent_project_id: 'project-b' }]);
  } finally { fixture.dispose(); }
});

test.describe('project preview pointer focus', () => {
test.use({ hasTouch: true });
test('previews the selected project through an activity redraw, retaining the query, caret and unsaved title', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await boot(page, 'task', undefined, f => f.holdTimeline('task:task-one'));
  try {
    await expect(input(page)).toHaveValue('Launch · Recued'); await expect.poll(() => fixture.waiting('timeline')).toBe(true);
    await editor(page).locator('[data-form-field="title"]').fill('Reviewed with context');
    await input(page).fill('Café'); await input(page).evaluate(el => (el as HTMLInputElement).setSelectionRange(1, 3));
    await picker(page).getByRole('button', { name: 'Preview selected project', exact: true }).click();
    const preview = picker(page).getByRole('region', { name: 'Project preview', exact: true });
    await expect(preview.getByRole('heading')).toHaveText('Launch'); await expect(preview).toContainText('Launch <strong>brief</strong>');
    await expect(preview.locator('strong')).toHaveCount(0); await expect(preview.getByRole('button', { name: 'Close preview', exact: true })).toBeFocused();
    await expect(input(page)).toHaveValue('Café'); await expect(picker(page).locator('[data-ref-picker-value]')).toHaveValue('project-a');
    await page.keyboard.press('Escape'); await expect(input(page)).toHaveValue('Café');
    await picker(page).getByRole('button', { name: 'Preview selected project', exact: true }).tap();
    await expect(preview.getByRole('heading')).toHaveText('Launch'); await expect(input(page)).toHaveValue('Café');
    await preview.evaluate(el => Object.assign(window, { __referencePreviewBeforeRefresh: el })); fixture.release('timeline');
    await page.waitForFunction(() => !(window as unknown as { __referencePreviewBeforeRefresh: HTMLElement }).__referencePreviewBeforeRefresh.isConnected);
    await expect(preview.getByRole('button', { name: 'Close preview', exact: true })).toBeFocused();
    await expect(preview.getByRole('button', { name: 'Close preview', exact: true })).toBeInViewport();
    await expect(preview.getByRole('heading')).toBeInViewport();
    await page.screenshot({ path: info.outputPath('project-reference-preview-phone.png'), fullPage: true });
    await page.keyboard.press('Escape'); await expect(preview).toHaveCount(0); await expect(editor(page)).toBeVisible(); await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveValue('Café'); expect(await input(page).evaluate(el => [(el as HTMLInputElement).selectionStart, (el as HTMLInputElement).selectionEnd])).toEqual([1, 3]);
    await expect(editor(page).locator('[data-form-field="title"]')).toHaveValue('Reviewed with context'); expect(fixture.writes).toEqual([]);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([{ kind: 'task', id: 'task-one', title: 'Reviewed with context' }]); expect(fixture.task().parent_project_id).toBe('project-a');
  } finally { fixture.dispose(); }
});
});

test('keeps failed and missing project previews distinct and retries without editing the saved link', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await expect(input(page)).toHaveValue('Launch · Recued'); fixture.failName('project-a', true);
    await picker(page).getByRole('button', { name: 'Preview selected project', exact: true }).click();
    const preview = picker(page).getByRole('region', { name: 'Project preview', exact: true });
    await expect(preview.getByRole('alert')).toContainText('Project name lookup failed');
    fixture.failName('project-a', false); fixture.removeProject('project-a'); await preview.getByRole('button', { name: 'Retry preview', exact: true }).click();
    await expect(preview.getByRole('heading')).toHaveText('Unavailable project'); await expect(preview).toContainText('Its link is kept');
    await expect(preview.getByRole('alert')).toHaveCount(0); await expect(picker(page).locator('[data-ref-picker-value]')).toHaveValue('project-a');
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click(); await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(editor(page)).toHaveCount(0); await expect(page.getByRole('alertdialog')).toHaveCount(0); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('retires a waiting project preview when another project is selected and ignores the old reply', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await expect(input(page)).toHaveValue('Launch · Recued'); fixture.holdName('project-a');
    await picker(page).getByRole('button', { name: 'Preview selected project', exact: true }).click();
    const preview = picker(page).getByRole('region', { name: 'Project preview', exact: true });
    await expect(preview).toContainText('Loading project preview'); await expect.poll(() => fixture.waiting('project-a')).toBe(true);
    await choose(page, 'parent_project', 'Launch', 'Launch · Imported'); await expect(preview).toHaveCount(0);
    await picker(page).getByRole('button', { name: 'Preview selected project', exact: true }).click(); await expect(preview).toContainText('Imported');
    const delivered = await page.evaluate(() => (window as unknown as { __workProjectSettled: Record<string, number> }).__workProjectSettled['work_entity.get:project-a'] ?? 0);
    fixture.release('project-a');
    await page.waitForFunction(count => (window as unknown as { __workProjectSettled: Record<string, number> }).__workProjectSettled['work_entity.get:project-a']! > count, delivered);
    await expect(preview).toContainText('Imported'); await expect(preview).not.toContainText('Launch <strong>brief</strong>');
    await expect(picker(page).locator('[data-ref-picker-value]')).toHaveValue('project-b'); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('distinguishes matching project titles by source and changes a task project with the keyboard', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 }); const fixture = await boot(page);
  try {
    await expect(input(page)).toHaveValue('Launch · Recued'); expect(fixture.writes).toEqual([]);
    await input(page).click(); await expect(picker(page).getByRole('listbox')).toContainText('No recent projects yet. Type to search.');
    await input(page).fill('Launch'); await expect(picker(page).getByRole('option')).toHaveCount(2);
    await expect(picker(page).getByRole('option', { name: 'Launch · Imported', exact: true })).toBeVisible();
    const imported = (await picker(page).getByRole('option').allTextContents()).indexOf('Launch · Imported');
    expect(imported).toBeGreaterThanOrEqual(0);
    for (let index = 0; index <= imported; index++) await input(page).press('ArrowDown');
    await input(page).press('Enter'); await expect(input(page)).toHaveValue('Launch · Imported');
    await expect(picker(page).getByRole('listbox')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('project-picker-phone.png'), fullPage: true });
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([{ kind: 'task', id: 'task-one', parent_project_id: 'project-b' }]);
    expect(fixture.task()).toMatchObject({ parent_project_id: 'project-b', title: 'Review launch', body: 'Keep these notes.', priority: 'high' });
  } finally { fixture.dispose(); }
});

for (const kind of ['task', 'note'] as const) test(`keeps chosen project ids and names in a new ${kind} draft through repaint and reload`, async ({ page }) => {
  const fixture = await boot(page, kind);
  try {
    await editor(page, kind).getByRole('button', { name: kind === 'task' ? 'Close' : 'Cancel', exact: true }).click();
    if (kind === 'note') await page.locator('.work-entity-note-reader').getByRole('button', { name: 'Back to notes', exact: true }).click();
    await page.getByRole('button', { name: `+ New ${kind === 'task' ? 'Task' : 'Note'}`, exact: true }).click();
    await editor(page, kind).locator('[data-form-field="title"]').fill('New linked work');
    if (kind === 'note') await editor(page, kind).getByLabel('Note text').fill('Preserve the chosen projects.');
    await editor(page, kind).getByRole('button', { name: 'More details', exact: true }).click();
    if (kind === 'note') await editor(page, kind).locator('[data-form-array-add="related_project"]').click();
    await choose(page, kind === 'task' ? 'parent_project' : 'related_project-0', 'Launch', 'Launch · Imported');
    if (kind === 'note') {
      await editor(page, kind).locator('[data-form-array-add="related_project"]').click();
      await choose(page, 'related_project-1', 'Café', 'Café <review> · Recued');
    }
    await editor(page, kind).getByRole('button', { name: 'Fewer details', exact: true }).click();
    await reload(page);
    const panel = page.getByRole('region', { name: `Unfinished ${kind === 'task' ? 'tasks' : 'notes'}`, exact: true });
    await panel.getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor(page, kind)).toHaveAttribute('data-mode', 'create');
    await expect(input(page, kind === 'task' ? 'parent_project' : 'related_project-0')).toHaveValue('Launch · Imported');
    if (kind === 'note') await expect(input(page, 'related_project-1')).toHaveValue('Café <review> · Recued');
    await editor(page, kind).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page, kind)).toHaveCount(0);
    expect(fixture.writes).toEqual([expect.objectContaining(kind === 'task' ? { parent_project_id: 'project-b' } : { related_project_ids: ['project-b', 'project-c'] })]);
    expect(fixture.writes[0]).not.toHaveProperty('id');
  } finally { fixture.dispose(); }
});

test('keeps a missing task project through unrelated edits, then explicitly clears only that link', async ({ page }) => {
  const fixture = await boot(page, 'task', fixture => fixture.removeProject('project-a'));
  try {
    await expect(input(page)).toHaveValue('Unavailable project'); await expect(picker(page)).toContainText('Its link is kept');
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(editor(page)).toHaveCount(0); await expect(page.getByRole('alertdialog')).toHaveCount(0); expect(fixture.writes).toEqual([]);
    await page.locator('[data-action="open-edit-work-entity"][data-entity-id="task-one"]').click();
    await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).locator('[data-form-field="title"]').fill('Renamed task');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.task().parent_project_id).toBe('project-a');
    await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByRole('button', { name: 'More details', exact: true }).click();
    await picker(page).getByRole('button', { name: 'Clear selection', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.task()).not.toHaveProperty('parent_project_id');
    expect(fixture.writes).toEqual([{ kind: 'task', id: 'task-one', title: 'Renamed task' }, { kind: 'task', id: 'task-one', clear_parent_project: true }]);
    expect(fixture.task()).toMatchObject({ title: 'Renamed task', body: 'Keep these notes.', priority: 'high', done: false });
  } finally { fixture.dispose(); }
});

test('retries a failed stored name without treating name hydration as a task edit', async ({ page }) => {
  const fixture = await boot(page, 'task', fixture => fixture.failName('project-a', true));
  try {
    await expect(picker(page)).toContainText('Its link is kept');
    fixture.failName('project-a', false); await picker(page).getByRole('button', { name: 'Retry project name', exact: true }).click();
    await expect(input(page)).toHaveValue('Launch · Recued');
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('a late stored-name read preserves typing and the next project choice', async ({ page }) => {
  const fixture = await boot(page, 'task', undefined, fixture => fixture.holdName('project-a'));
  try {
    await expect.poll(() => fixture.waiting('project-a')).toBe(true);
    await input(page).fill('Café'); await expect(picker(page).getByRole('option', { name: 'Café <review> · Recued', exact: true })).toBeVisible();
    fixture.release('project-a'); await expect(input(page)).toHaveValue('Café');
    await input(page).press('ArrowDown'); await input(page).press('Enter');
    await expect(input(page)).toHaveValue('Café <review> · Recued');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.task().parent_project_id).toBe('project-c');
  } finally { fixture.dispose(); }
});

test('removing a note project reindexes the remaining picker safely while an older name is in flight', async ({ page }) => {
  const fixture = await boot(page, 'note', fixture => fixture.holdName('project-a'));
  try {
    await expect.poll(() => fixture.waiting('project-a')).toBe(true); await expect(input(page, 'related_project-1')).toHaveValue('Launch · Imported');
    await editor(page, 'note').locator('[data-form-array-remove="related_project"][data-form-array-index="0"]').click();
    fixture.release('project-a'); await expect(input(page, 'related_project-0')).toHaveValue('Launch · Imported');
    await editor(page, 'note').getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page, 'note')).toHaveCount(0);
    expect(fixture.note().related_project_ids).toEqual(['project-b']);
    expect(fixture.writes).toEqual([{ kind: 'note', id: 'note-one', related_project_ids: ['project-b'] }]);
  } finally { fixture.dispose(); }
});

test('clears note project selections through Clear and saves an empty project list', async ({ page }) => {
  const fixture = await boot(page, 'note');
  try {
    await expect(input(page, 'related_project-0')).toHaveValue('Launch · Recued');
    await picker(page, 'related_project-0').getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(input(page, 'related_project-0')).toHaveValue('Launch · Imported');
    await picker(page, 'related_project-0').getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(page.locator('[data-ref-picker-value][data-form-ref-target="data.project"]')).toHaveCount(0);
    await editor(page, 'note').getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page, 'note')).toHaveCount(0);
    expect(fixture.note().related_project_ids).toEqual([]);
    expect(fixture.writes).toEqual([{ kind: 'note', id: 'note-one', related_project_ids: [] }]);
  } finally { fixture.dispose(); }
});

test('retries failed search and refuses a wrong inventory without selecting a similarly named task', async ({ page }) => {
  const fixture = await boot(page);
  try {
    fixture.failSearch(true); await input(page).fill('Launch'); await expect(picker(page)).toContainText('project index is unavailable');
    fixture.failSearch(false); fixture.wrongInventory(true);
    await picker(page).getByRole('button', { name: 'Try again', exact: true }).click(); await expect(picker(page)).toContainText('could not be confirmed');
    await expect(picker(page).getByRole('option')).toHaveCount(0);
    fixture.wrongInventory(false); fixture.truncated(); await picker(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(picker(page)).toContainText('More projects match');
    await picker(page).getByRole('option', { name: 'Launch · Imported', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.task().parent_project_id).toBe('project-b');
  } finally { fixture.dispose(); }
});

test('drops old search replies after a newer query and after leaving the task editor', async ({ page }) => {
  const fixture = await boot(page);
  try {
    fixture.holdSearch('Launch'); await input(page).fill('Launch'); await expect.poll(() => fixture.waiting('search')).toBe(true);
    await input(page).fill('Café'); await expect(picker(page).getByRole('option')).toHaveText('Café <review> · Recued');
    fixture.release('search'); await expect(picker(page).getByRole('option')).toHaveText('Café <review> · Recued');
    fixture.holdSearch('Launch'); await input(page).fill('Launch'); await expect.poll(() => fixture.waiting('search')).toBe(true);
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click(); fixture.release('search');
    await expect(editor(page)).toHaveCount(0); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('keeps a project query, caret and stored selection when an activity response redraws the editor', async ({ page }) => {
  const fixture = await boot(page, 'task', fixture => fixture.holdTimeline('task:task-one'));
  try {
    await expect.poll(() => fixture.waiting('timeline')).toBe(true);
    await input(page).fill('Café'); await expect(picker(page).getByRole('option')).toHaveText('Café <review> · Recued');
    await input(page).evaluate((node: HTMLInputElement) => { node.setSelectionRange(1, 3); Object.assign(window, { __workProjectBeforeRedraw: node }); });
    fixture.release('timeline');
    await page.waitForFunction(() => !(window as unknown as { __workProjectBeforeRedraw: Element }).__workProjectBeforeRedraw.isConnected);
    await expect(input(page)).toHaveValue('Café'); await expect(input(page)).toBeFocused();
    expect(await input(page).evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])).toEqual([1, 3]);
    await expect(picker(page).locator('[data-ref-picker-value]')).toHaveValue('project-a'); expect(fixture.writes).toEqual([]);
    await input(page).press('ArrowDown'); await input(page).press('Enter'); await expect(input(page)).toHaveValue('Café <review> · Recued');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([{ kind: 'task', id: 'task-one', parent_project_id: 'project-c' }]);
  } finally { fixture.dispose(); }
});
