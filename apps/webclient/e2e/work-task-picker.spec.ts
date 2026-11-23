import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installWorkTaskPickerFixture } from './helpers/work-task-picker-fixture.js';

installFullAppHooks();
const editor = (page: Page) => page.locator('.work-entity-dialog[data-kind="task"]').filter({ has: page.locator('.work-entity-dialog-form') });
const picker = (page: Page, index = 0) => page.locator(`[data-ref-picker="form-ref-blocks_task-${index}"]`);
const input = (page: Page, index = 0) => picker(page, index).getByRole('combobox');
const boot = async (page: Page, prepare?: (fixture: Awaited<ReturnType<typeof installWorkTaskPickerFixture>>) => void, taskId = 'task-one') => {
  const fixture = await installWorkTaskPickerFixture(page); prepare?.(fixture);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/task/${taskId}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Edit', exact: true }).click();
  await editor(page).getByRole('button', { name: 'More details', exact: true }).click();
  return fixture;
};
const choose = async (page: Page, index: number, query: string, name: string) => {
  await input(page, index).fill(query); await picker(page, index).getByRole('option', { name, exact: true }).click();
  await expect(input(page, index)).toHaveValue(name);
};
const reload = async (page: Page) => {
  const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); }; page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); }
  await page.waitForFunction(() => window.__app?.ready === true);
};

test('recent dependency choices exclude this task and other rows, while removing a row frees its choice', async ({ page }) => {
  const fixture = await boot(page, f => f.update('task-one', { blocks_task_ids: [] }), 'task-c');
  const recentTasks = () => page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(key => key.startsWith('recued.reference.choices.v1:'));
    return key ? (JSON.parse(sessionStorage.getItem(key)!) as Array<{ kind: string; id: string }>).filter(row => row.kind === 'task').map(row => row.id) : [];
  });
  try {
    await editor(page).getByRole('button', { name: 'Add Depends on', exact: true }).click(); await choose(page, 0, 'Launch', 'Launch review · Recued');
    await expect.poll(recentTasks).toEqual(['task-one']); await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
    await page.locator('[data-action="open-edit-work-entity"][data-entity-id="task-one"]').click(); await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByRole('button', { name: 'More details', exact: true }).click(); await editor(page).getByRole('button', { name: 'Add Depends on', exact: true }).click();
    await expect(picker(page).getByRole('option')).toHaveCount(0); await expect(picker(page).getByRole('listbox')).toContainText('No available recent tasks. Type to search.');
    await choose(page, 0, 'Launch', 'Launch checklist · Recued'); await expect.poll(recentTasks).toEqual(['task-a', 'task-one']);
    await editor(page).getByRole('button', { name: 'Add Depends on', exact: true }).click(); await expect(picker(page, 1).getByRole('option')).toHaveCount(0);
    await expect(picker(page, 1).getByRole('listbox')).toContainText('No available recent tasks. Type to search.');
    await choose(page, 1, 'Launch', 'Launch checklist · Imported'); await expect.poll(recentTasks).toEqual(['task-b', 'task-a', 'task-one']);
    await editor(page).getByRole('button', { name: 'Add Depends on', exact: true }).click(); await expect(picker(page, 2).getByRole('option')).toHaveCount(0);
    await expect(picker(page, 2).getByRole('listbox')).toContainText('No available recent tasks. Type to search.');
    await editor(page).locator('[data-form-array-remove="blocks_task"][data-form-array-index="0"]').click();
    await editor(page).locator('[data-form-field="title"]').focus(); await input(page, 1).focus(); await expect(picker(page, 1).getByRole('option')).toContainText('Launch checklist · Recued');
    await expect(picker(page, 1).getByRole('option')).toHaveCount(1); await input(page, 1).press('ArrowDown'); await input(page, 1).press('Enter');
    expect(fixture.writes).toEqual([]); await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([{ kind: 'task', id: 'task-one', blocks_task_ids: ['task-b', 'task-a'] }]);
  } finally { fixture.dispose(); }
});

test('previews dependency status, notes and due date without changing its id or the task draft', async ({ page }) => {
  const fixture = await boot(page, f => f.update('task-b', { body: 'Imported <script>notes</script>', due_at: Date.UTC(2026, 10, 23, 18), priority: 'high' }));
  try {
    await expect(input(page, 1)).toHaveValue('Launch checklist · Imported');
    await picker(page, 1).getByRole('button', { name: 'Preview selected task', exact: true }).click();
    const preview = picker(page, 1).getByRole('region', { name: 'Task preview', exact: true });
    await expect(preview).toContainText('Completed'); await expect(preview).toContainText('Imported <script>notes</script>'); await expect(preview).toContainText('2026');
    await expect(preview).toContainText('high'); await expect(preview.locator('script')).toHaveCount(0); await expect(picker(page, 1).locator('[data-ref-picker-value]')).toHaveValue('task-b');
    await page.keyboard.press('Escape'); await expect(preview).toHaveCount(0); await expect(input(page, 1)).toBeFocused(); expect(fixture.writes).toEqual([]);
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click(); await expect(editor(page)).toHaveCount(0); await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(fixture.task().blocks_task_ids).toEqual(['task-a', 'task-b']);
  } finally { fixture.dispose(); }
});

test('chooses task dependencies by name and source with the keyboard, excluding itself and duplicate links', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await boot(page, fixture => fixture.update('task-one', { blocks_task_ids: [] }));
  try {
    await editor(page).getByRole('button', { name: 'Add Depends on', exact: true }).click();
    await expect(input(page)).toBeFocused(); await input(page).fill('Launch');
    await expect(picker(page).getByRole('option')).toHaveCount(2);
    await expect(picker(page).getByRole('option', { name: 'Launch review · Recued', exact: true })).toHaveCount(0);
    const imported = (await picker(page).getByRole('option').allTextContents()).indexOf('Launch checklist · Imported');
    expect(imported).toBeGreaterThanOrEqual(0);
    for (let index = 0; index <= imported; index++) await input(page).press('ArrowDown');
    await input(page).press('Enter'); await expect(input(page)).toHaveValue('Launch checklist · Imported');
    await expect(picker(page)).toContainText('Completed task.');
    await expect(picker(page).getByRole('button', { name: 'Retry task details', exact: true, includeHidden: true })).toBeHidden();
    await editor(page).getByRole('button', { name: 'Add Depends on', exact: true }).click(); await input(page, 1).fill('Launch');
    await expect(picker(page, 1).getByRole('option')).toHaveText('Launch checklist · Recued');
    await input(page, 1).press('ArrowDown'); await input(page, 1).press('Enter'); await expect(picker(page, 1)).toContainText('Open task.');
    await page.screenshot({ path: testInfo.outputPath('task-dependencies-phone.png'), fullPage: true });
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([{ kind: 'task', id: 'task-one', blocks_task_ids: ['task-b', 'task-a'] }]);
    expect(fixture.task()).toMatchObject({ blocks_task_ids: ['task-b', 'task-a'], title: 'Launch review', body: 'Keep these notes.', done: false, priority: 'high' });
  } finally { fixture.dispose(); }
});

test('recovers chosen dependency ids and status after repaint and immediate reload', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: '+ New Task', exact: true }).click();
    await editor(page).getByLabel('Title').fill('New dependent task');
    await editor(page).getByRole('button', { name: 'More details', exact: true }).click();
    await editor(page).locator('[data-form-array-add="blocks_task"]').click(); await choose(page, 0, 'Launch', 'Launch checklist · Imported');
    await editor(page).locator('[data-form-array-add="blocks_task"]').click(); await choose(page, 1, 'Café', 'Café <review> · Recued');
    await editor(page).getByRole('button', { name: 'Fewer details', exact: true }).click(); await reload(page);
    await page.getByRole('region', { name: 'Unfinished tasks', exact: true }).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor(page)).toHaveAttribute('data-mode', 'create');
    await expect(input(page)).toHaveValue('Launch checklist · Imported'); await expect(picker(page)).toContainText('Completed task.');
    await expect(input(page, 1)).toHaveValue('Café <review> · Recued');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([expect.objectContaining({ kind: 'task', title: 'New dependent task', blocks_task_ids: ['task-b', 'task-c'] })]);
    expect(fixture.writes[0]).not.toHaveProperty('id');
    expect(fixture.tasks().find(task => task.title === 'New dependent task')?.blocks_task_ids).toEqual(['task-b', 'task-c']);
  } finally { fixture.dispose(); }
});

test('removes dependencies through Clear and saves the empty list without changing other task fields', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await expect(input(page)).toHaveValue('Launch checklist · Recued'); await expect(picker(page, 1)).toContainText('Completed task.');
    await picker(page).getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(input(page)).toHaveValue('Launch checklist · Imported'); await expect(input(page)).toBeFocused();
    await picker(page).getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(page.locator('[data-ref-picker-value][data-form-ref-target="data.task"]')).toHaveCount(0);
    await expect(editor(page).locator('[data-form-array-add="blocks_task"]')).toBeFocused();
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([{ kind: 'task', id: 'task-one', blocks_task_ids: [] }]);
    expect(fixture.task()).toMatchObject({ title: 'Launch review', body: 'Keep these notes.', priority: 'high', blocks_task_ids: [] });
  } finally { fixture.dispose(); }
});

test('retains a missing dependency during unrelated edits and leaves name hydration clean', async ({ page }) => {
  const fixture = await boot(page, fixture => fixture.remove('task-a'));
  try {
    await expect(input(page)).toHaveValue('Unavailable task'); await expect(picker(page)).toContainText('Its link is kept');
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0); expect(fixture.writes).toEqual([]);
    await page.locator('[data-action="open-edit-work-entity"][data-entity-id="task-one"]').click();
    await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByLabel('Title').fill('Renamed review'); await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([{ kind: 'task', id: 'task-one', title: 'Renamed review' }]);
    expect(fixture.task().blocks_task_ids).toEqual(['task-a', 'task-b']);
  } finally { fixture.dispose(); }
});

test('retries task details without changing the dependency and refreshes completion when reopened', async ({ page }) => {
  const fixture = await boot(page, fixture => fixture.failName('task-a', true));
  try {
    await expect(picker(page)).toContainText('Its link is kept'); fixture.failName('task-a', false);
    await picker(page).getByRole('button', { name: 'Retry task details', exact: true }).click();
    await expect(input(page)).toHaveValue('Launch checklist · Recued'); await expect(picker(page)).toContainText('Open task.');
    await expect(picker(page).getByRole('button', { name: 'Retry task details', exact: true, includeHidden: true })).toBeHidden();
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0); fixture.update('task-a', { done: true });
    await page.locator('[data-action="open-edit-work-entity"][data-entity-id="task-one"]').click();
    await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByRole('button', { name: 'More details', exact: true }).click();
    await expect(picker(page)).toContainText('Completed task.'); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('keeps the surviving dependency after reindexing and ignores a removed dependency read', async ({ page }) => {
  const fixture = await boot(page, fixture => fixture.holdName('task-a'));
  try {
    await expect.poll(() => fixture.waiting('task-a')).toBe(true); await expect(input(page, 1)).toHaveValue('Launch checklist · Imported');
    await editor(page).locator('[data-form-array-remove="blocks_task"][data-form-array-index="0"]').click();
    fixture.release('task-a'); await expect(input(page)).toHaveValue('Launch checklist · Imported'); await expect(picker(page)).toContainText('Completed task.');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([{ kind: 'task', id: 'task-one', blocks_task_ids: ['task-b'] }]);
    expect(fixture.task().blocks_task_ids).toEqual(['task-b']);
  } finally { fixture.dispose(); }
});

test('preserves a typed query during a late name read and drops old searches after a newer query or editor exit', async ({ page }) => {
  const fixture = await boot(page, fixture => fixture.holdName('task-a'));
  try {
    await expect.poll(() => fixture.waiting('task-a')).toBe(true);
    await input(page).fill('Café'); await expect(picker(page).getByRole('option')).toHaveText('Café <review> · Recued');
    fixture.release('task-a'); await expect(input(page)).toHaveValue('Café');
    fixture.holdSearch('Launch'); await input(page).fill('Launch'); await expect.poll(() => fixture.waiting('search')).toBe(true);
    await input(page).fill('Café'); await expect(picker(page).getByRole('option')).toHaveText('Café <review> · Recued');
    fixture.release('search'); await expect(picker(page).getByRole('option')).toHaveText('Café <review> · Recued');
    fixture.holdSearch('Launch'); await input(page).fill('Launch'); await expect.poll(() => fixture.waiting('search')).toBe(true);
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click(); fixture.release('search'); await expect(editor(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('retries failed search and rejects a wrong inventory while making truncated results explicit', async ({ page }) => {
  const fixture = await boot(page);
  try {
    fixture.failSearch(true); await input(page).fill('Café'); await expect(picker(page)).toContainText('task index is unavailable');
    fixture.failSearch(false); fixture.wrongInventory(true); await picker(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(picker(page)).toContainText('could not be confirmed'); await expect(picker(page).getByRole('option')).toHaveCount(0);
    fixture.wrongInventory(false); fixture.truncated(); await picker(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(picker(page)).toContainText('More tasks match'); await picker(page).getByRole('option', { name: 'Café <review> · Recued', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.task().blocks_task_ids).toEqual(['task-c', 'task-b']);
  } finally { fixture.dispose(); }
});

test('keeps a dependency query, caret and stored selection when an activity response redraws the editor', async ({ page }) => {
  const fixture = await boot(page, fixture => fixture.holdTimeline('task:task-one'));
  try {
    await expect.poll(() => fixture.waiting('timeline')).toBe(true);
    await input(page).fill('Café'); await expect(picker(page).getByRole('option')).toHaveText('Café <review> · Recued');
    await input(page).evaluate((node: HTMLInputElement) => { node.setSelectionRange(1, 3); Object.assign(window, { __workTaskBeforeRedraw: node }); });
    fixture.release('timeline');
    await page.waitForFunction(() => !(window as unknown as { __workTaskBeforeRedraw: Element }).__workTaskBeforeRedraw.isConnected);
    await expect(input(page)).toHaveValue('Café'); await expect(input(page)).toBeFocused();
    expect(await input(page).evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])).toEqual([1, 3]);
    await expect(picker(page).locator('[data-ref-picker-value]')).toHaveValue('task-a'); expect(fixture.writes).toEqual([]);
    await input(page).press('ArrowDown'); await input(page).press('Enter'); await expect(input(page)).toHaveValue('Café <review> · Recued');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([{ kind: 'task', id: 'task-one', blocks_task_ids: ['task-c', 'task-b'] }]);
  } finally { fixture.dispose(); }
});
