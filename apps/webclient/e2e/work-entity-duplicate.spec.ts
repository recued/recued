import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installWorkEntityDuplicateFixture, NOTE_BODY, type DuplicateKind } from './helpers/work-entity-duplicate-fixture.js';

installFullAppHooks();
test.use({ timezoneId: 'America/Los_Angeles' });
const editor = (page: Page, kind: DuplicateKind) => page.locator(`.work-entity-dialog[data-kind="${kind}"]`);
const reader = (page: Page) => page.locator('.work-entity-note-reader');
const recovery = (page: Page, kind: DuplicateKind) => page.getByRole('region', { name: `Unfinished ${kind === 'task' ? 'tasks' : 'notes'}`, exact: true });
const boot = async (page: Page, kind: DuplicateKind, prepare?: (fixture: Awaited<ReturnType<typeof installWorkEntityDuplicateFixture>>) => void) => {
  const fixture = await installWorkEntityDuplicateFixture(page);
  prepare?.(fixture);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/${kind}/${kind}-original`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.getByRole('button', { name: `Duplicate ${kind}`, exact: true })).toBeVisible();
  return fixture;
};
const duplicate = async (page: Page, kind: DuplicateKind) => {
  await page.getByRole('button', { name: `Duplicate ${kind}`, exact: true }).click();
  await expect(editor(page, kind)).toHaveAttribute('data-mode', 'create');
  await expect(editor(page, kind).locator('[data-form-field="title"]')).toBeFocused();
};
const reload = async (page: Page) => {
  const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); };
  page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); }
  await page.waitForFunction(() => window.__app?.ready === true);
};
const savedId = (page: Page) => page.evaluate(() => decodeURIComponent(location.hash.split('/').at(-1)!));

test('duplicates a completed task as an open new task, reviews links and deadline, and returns to the untouched original', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 }); const fixture = await boot(page, 'task');
  try {
    await duplicate(page, 'task'); const dialog = editor(page, 'task');
    await expect(dialog.locator('[data-form-field="title"]')).toHaveValue('Original task');
    await expect(dialog.locator('[data-form-field="body"]')).toHaveValue('Reusable task notes');
    await expect(dialog.locator('[data-form-field="due_at"]')).toHaveValue('');
    await expect(dialog.getByRole('button', { name: 'Fewer details', exact: true })).toBeVisible();
    expect(fixture.writes).toEqual([]);
    await dialog.locator('[data-form-field="title"]').fill('Next task');
    await dialog.locator('[data-form-field="due_at"]').fill('2030-10-30T09:45');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveAttribute('data-mode', 'read');
    await expect(dialog.getByRole('heading', { name: 'Next task', exact: true })).toBeVisible();
    const id = await savedId(page); expect(id).not.toBe('task-original');
    expect(fixture.writes).toEqual([expect.objectContaining({ kind: 'task', source_id: 'recued.task', title: 'Next task', done: false,
      due_at: Date.parse('2030-10-30T09:45:00-07:00'), priority: 'high', assigned_contact_id: 'person@example.test',
      parent_calendar_event_id: 'event-one', linked_mail_thread_id: 'thread-one', parent_project_id: 'project-one', blocks_task_ids: ['task-blocked'] })]);
    expect(fixture.writes[0]).not.toHaveProperty('id'); expect(fixture.writes[0]).not.toHaveProperty('completed_at');
    expect(fixture.created('task')[0]).toMatchObject({ id, done: false }); expect(fixture.created('task')[0]).not.toHaveProperty('completed_at');
    await dialog.getByRole('button', { name: 'Back to original task', exact: true }).click();
    await expect(page).toHaveURL(/#data\/task\/task-original$/); await expect(dialog.getByRole('heading', { name: 'Original task', exact: true })).toBeVisible();
    expect(fixture.read('task')).toEqual(fixture.originals.task);
    await page.screenshot({ path: testInfo.outputPath('duplicate-task-phone.png'), fullPage: true });
  } finally { fixture.dispose(); }
});

test('duplicates exact note Markdown and all links, opens the new reader and returns to the original', async ({ page }) => {
  const fixture = await boot(page, 'note');
  try {
    await duplicate(page, 'note'); const dialog = editor(page, 'note');
    await expect(dialog.locator('[data-form-field="body"]')).toHaveValue(NOTE_BODY); expect(fixture.writes).toEqual([]);
    await dialog.locator('[data-form-field="title"]').fill('Next note'); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page).getByRole('heading', { name: 'Next note', exact: true })).toBeVisible();
    await expect(reader(page).locator('img,script')).toHaveCount(0);
    expect(await savedId(page)).not.toBe('note-original');
    expect(fixture.writes).toEqual([{ kind: 'note', source_id: 'recued.note', title: 'Next note', body: NOTE_BODY,
      related_contact_ids: ['person@example.test'], related_calendar_event_ids: ['event-one'], related_mail_thread_ids: ['thread-one'], related_project_ids: ['project-one'] }]);
    await reader(page).getByRole('button', { name: 'Back to original note', exact: true }).click();
    await expect(reader(page).getByRole('heading', { name: 'Original note', exact: true })).toBeVisible();
    expect(fixture.read('note')).toEqual(fixture.originals.note);
  } finally { fixture.dispose(); }
});

for (const kind of ['task', 'note'] as const) {
  test(`checkpoints an untouched ${kind} copy immediately and resumes it as a create after refresh`, async ({ page }) => {
    const fixture = await boot(page, kind);
    try {
      await duplicate(page, kind); await reload(page);
      const panel = recovery(page, kind); await expect(panel).toContainText(`New ${kind}`);
      expect(fixture.writes).toEqual([]);
      await panel.getByRole('button', { name: 'Resume draft', exact: true }).click();
      const dialog = editor(page, kind); await expect(dialog).toHaveAttribute('data-mode', 'create');
      await expect(dialog.locator('[data-form-field="title"]')).toHaveValue(`Original ${kind}`);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toHaveCount(0);
      expect(fixture.writes).toHaveLength(1); expect(fixture.writes[0]).not.toHaveProperty('id');
      expect(fixture.read(kind)).toEqual(fixture.originals[kind]); await expect(panel).toHaveCount(0);
    } finally { fixture.dispose(); }
  });

  test(`requires explicit discard for a seeded ${kind} draft and returns to the original`, async ({ page }) => {
    const fixture = await boot(page, kind);
    try {
      await duplicate(page, kind); const dialog = editor(page, kind);
      await dialog.getByRole('button', { name: `Back to original ${kind}`, exact: true }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await expect(dialog).toHaveAttribute('data-mode', 'create');
      await dialog.getByRole('button', { name: `Back to original ${kind}`, exact: true }).click();
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#data/${kind}/${kind}-original$`));
      await reload(page); await expect(recovery(page, kind)).toHaveCount(0); expect(fixture.writes).toEqual([]);
    } finally { fixture.dispose(); }
  });

  test(`keeps a lost ${kind} save recoverable and blocks a second create`, async ({ page }) => {
    const fixture = await boot(page, kind);
    try {
      await duplicate(page, kind); fixture.reply('lost'); const dialog = editor(page, kind);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('save reply was lost');
      await expect(dialog.locator('[data-form-field="title"]')).toHaveValue(`Original ${kind}`);
      fixture.reply('normal'); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('previous save was not confirmed');
      expect(fixture.writes).toHaveLength(1); expect(fixture.created(kind)).toHaveLength(1);
      await reload(page); const panel = recovery(page, kind);
      await expect(panel).toContainText('Save was not confirmed'); await expect(panel.getByRole('button', { name: 'Resume draft', exact: true })).toBeDisabled();
      expect(fixture.read(kind)).toEqual(fixture.originals[kind]);
    } finally { fixture.dispose(); }
  });
}

test('refuses to copy unsaved task edits and re-reads the latest saved original', async ({ page }) => {
  const fixture = await boot(page, 'task');
  try {
    await editor(page, 'task').getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = editor(page, 'task'); await dialog.locator('[data-form-field="title"]').fill('Unsaved changes');
    await page.getByRole('button', { name: 'Duplicate task', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Save or discard your changes');
    await expect(dialog.locator('[data-form-field="title"]')).toHaveValue('Unsaved changes'); expect(fixture.writes).toEqual([]);
    await dialog.locator('[data-form-field="title"]').fill('Original task'); fixture.latestTaskTitle('Latest saved task');
    await duplicate(page, 'task'); await expect(dialog.locator('[data-form-field="title"]')).toHaveValue('Latest saved task');
    expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

for (const method of ['work_entity.get', 'work_entity.source.list']) {
  test(`a failed or late ${method} preparation preserves the original and cannot replace a newer destination`, async ({ page }) => {
    const fixture = await boot(page, 'note');
    try {
      fixture.fail(method); await page.getByRole('button', { name: 'Duplicate note', exact: true }).click();
      await expect(reader(page).getByRole('alert')).toContainText('source read was interrupted'); fixture.fail(null);
      fixture.hold(method); await page.getByRole('button', { name: 'Duplicate note', exact: true }).click(); await expect.poll(fixture.pending).toBe(true);
      await page.evaluate(() => window.__app.setHash('#data/task/task-other'));
      await expect(editor(page, 'task').getByRole('heading', { name: 'Other task', exact: true })).toBeVisible();
      fixture.release(); await expect(page).toHaveURL(/#data\/task\/task-other$/);
      await expect(editor(page, 'task')).toHaveAttribute('data-mode', 'read'); expect(fixture.writes).toEqual([]);
    } finally { fixture.dispose(); }
  });
}

test('checks fresh Source permission before offering a new draft', async ({ page }) => {
  const fixture = await boot(page, 'task');
  try {
    fixture.readonly('task'); await page.getByRole('button', { name: 'Duplicate task', exact: true }).click();
    await expect(editor(page, 'task').getByRole('alert')).toContainText('No writable Source');
    await expect(editor(page, 'task')).toHaveAttribute('data-mode', 'read'); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('copies a read-only original to Recued and lets the owner explicitly choose another writable Source', async ({ page }) => {
  const fixture = await boot(page, 'note', fixture => {
    fixture.externalNote(); fixture.addDestination('alternate.note'); fixture.addDestination('through.note', true);
  });
  try {
    await expect(reader(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await duplicate(page, 'note'); const dialog = editor(page, 'note'), source = dialog.locator('[data-action="select-create-source"]');
    await expect(source).toHaveValue('recued.note'); await expect(source.locator('option')).toHaveCount(2);
    await source.selectOption('alternate.note'); await expect(dialog.locator('[data-form-field="body"]')).toHaveValue(NOTE_BODY);
    expect(fixture.writes).toEqual([]); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page).getByRole('button', { name: 'Back to original note', exact: true })).toBeVisible();
    expect(fixture.writes).toEqual([expect.objectContaining({ kind: 'note', source_id: 'alternate.note', body: NOTE_BODY })]);
    expect(fixture.writes[0]).not.toHaveProperty('source_record_id'); expect(fixture.read('note')).toEqual(fixture.originals.note);
    await reader(page).getByRole('button', { name: 'Back to original note', exact: true }).click();
    await expect(reader(page)).toContainText('Archive');
  } finally { fixture.dispose(); }
});

test('does not overwrite task edits typed during preparation', async ({ page }) => {
  const fixture = await boot(page, 'task');
  try {
    await editor(page, 'task').getByRole('button', { name: 'Edit', exact: true }).click();
    fixture.hold('work_entity.get'); await page.getByRole('button', { name: 'Duplicate task', exact: true }).click();
    await expect.poll(fixture.pending).toBe(true); const dialog = editor(page, 'task');
    await dialog.locator('[data-form-field="title"]').fill('Edits during read'); fixture.release();
    await expect(dialog.getByRole('alert')).toContainText('Save or discard your changes');
    await expect(dialog.locator('[data-form-field="title"]')).toHaveValue('Edits during read');
    await expect(dialog).toHaveAttribute('data-mode', 'edit'); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('keeps the project return after duplicating a linked note and cancelling edits to the saved copy', async ({ page }) => {
  const fixture = await boot(page, 'note');
  try {
    await page.evaluate(() => window.__app.setHash('#data/project/project-one'));
    const project = page.locator('[data-project-overview="project-one"]');
    await project.locator('[data-project-item-id="note-original"]').click();
    await expect(reader(page).getByRole('button', { name: 'Back to project', exact: true })).toBeVisible();
    await duplicate(page, 'note'); await editor(page, 'note').getByRole('button', { name: 'Save', exact: true }).click();
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page, 'note').locator('[data-form-field="title"]').fill('Unsaved copy edits');
    await editor(page, 'note').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await reader(page).getByRole('button', { name: 'Back to original note', exact: true }).click();
    await expect(page).toHaveURL(/#data\/note\/note-original$/);
    await reader(page).getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(project).toBeVisible(); await expect(project.locator('[data-project-item-id]')).toHaveCount(3);
    expect(fixture.writes).toHaveLength(1); expect(fixture.read('note')).toEqual(fixture.originals.note);
  } finally { fixture.dispose(); }
});

for (const reply of ['original', 'pending'] as const) {
  test(`an unconfirmed ${reply} create reply never clears recovery or opens the wrong saved item`, async ({ page }) => {
    const fixture = await boot(page, 'note');
    try {
      await duplicate(page, 'note'); fixture.reply(reply); const dialog = editor(page, 'note');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('source did not confirm this copy');
      await expect(dialog).toHaveAttribute('data-mode', 'create'); fixture.reply('normal');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click(); expect(fixture.writes).toHaveLength(1);
      await reload(page); await expect(recovery(page, 'note')).toContainText('Save was not confirmed');
      expect(fixture.read('note')).toEqual(fixture.originals.note);
    } finally { fixture.dispose(); }
  });
}
