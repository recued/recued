import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const now = Date.parse('2026-10-31T18:00:00Z'), projectHash = serializeShellRoute('data', 'project', 'project-one');
const overview = (page: Page) => page.locator('[data-project-overview]');
const attention = (page: Page) => overview(page).locator('[data-project-attention]');
const list = (page: Page) => attention(page).locator('[data-project-attention-list]');
const rows = (page: Page) => list(page).locator('[data-action="project-attention-open"]');
const row = (page: Page, name: string) => rows(page).filter({ has: page.getByText(name, { exact: true }) });
const overdue = (page: Page, total = 14) => attention(page).getByRole('button', { name: `${total} Overdue tasks`, exact: true });
const visit = (page: Page, hash: string) => page.evaluate(hash => { location.hash = hash; }, hash);
const boot = async (page: Page, prepare?: (f: Fixture) => void, wait = true) => {
  const f = await installTaskNoteSourceFixture(page, { searchable: true });
  f.removeTask('task-one'); f.removeTask('task-two'); f.seedProject('other', { title: 'Other project' });
  for (let i = 0; i < 14; i++) f.seedTask('overdue/' + i + '二?', { title: 'Overdue task ' + i, due_at: now - (i + 1) * 60_000, parent_project_id: 'project-one' });
  f.seedTask('soon', { title: 'Due tomorrow', due_at: now + 86_400_000, parent_project_id: 'project-one' });
  f.seedTask('date-only', { title: 'Due today as a day', due_at: Date.parse('2026-10-31'), parent_project_id: 'project-one' });
  f.seedTask('no-date', { title: 'No deadline', parent_project_id: 'project-one' });
  f.seedTask('completed', { title: 'Already completed', done: true, due_at: now - 1000, parent_project_id: 'project-one' });
  f.seedTask('other-project', { title: 'Other overdue task', due_at: now - 1000, parent_project_id: 'other' });
  for (const [id, direction] of [['approval', 'inbound'], ['delivery', 'outbound'], ['review', 'internal']] as const)
    f.seedCommitment(id, { statement: id + ' blocks this project', direction, blocks_project_ids: ['project-one'] });
  f.seedCommitment('finished', { statement: 'Earlier fulfilled promise', lifecycle_state: 'fulfilled', blocks_project_ids: ['project-one'] });
  f.seedNote('project-note', { title: 'Matching note', body: 'Only this note matches the project query.', related_project_ids: ['project-one'] });
  prepare?.(f); await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + projectHash);
  await page.waitForFunction(() => window.__app?.ready === true); await expect(overview(page)).toHaveAttribute('data-project-overview', 'project-one');
  if (wait) await expect(overdue(page)).toBeVisible(); return f;
};
const clipboard = (page: Page, deny = false) => page.addInitScript(deny => {
  const values: string[] = []; Object.assign(window, { __attentionCopies: values });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { values.push(value); if (deny) throw new Error('Clipboard unavailable'); } } });
  document.execCommand = () => false;
}, deny);
const copied = (page: Page) => page.evaluate(() => (window as unknown as { __attentionCopies: string[] }).__attentionCopies);
const openFirst = async (page: Page) => {
  await overdue(page).click(); await expect(rows(page)).toHaveCount(10);
  const control = rows(page).first(), key = (await control.getAttribute('data-attention-key'))!, id = JSON.parse(key)[1] as string;
  await control.click(); await expect(page.locator('.work-entity-task-reader')).toHaveAttribute('data-task-id', id); return { id, key };
};

test('complete attention totals and the copied update remain independent of project search and task filters', async ({ page }, info) => {
  await clipboard(page); const f = await boot(page);
  try {
    await expect(attention(page).getByRole('button', { name: '2 Due in the next 7 days', exact: true })).toBeVisible();
    await expect(attention(page).getByRole('button', { name: '3 Outstanding blocking commitments', exact: true })).toBeVisible();
    const search = overview(page).getByRole('searchbox', { name: 'Search this project', exact: true }); await search.fill('Matching note'); await search.press('Enter');
    await overview(page).getByRole('group', { name: 'Tasks to show', exact: true }).getByRole('button', { name: 'Completed', exact: true }).click();
    await expect(overview(page).locator('[data-project-section="task"]')).toContainText('No matching tasks'); await expect(overdue(page)).toBeVisible();
    await attention(page).getByRole('button', { name: 'Copy status update', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(attention(page).locator('[data-project-attention-copy-notice]')).toHaveText('Project update copied.');
    const text = (await copied(page))[0]!; expect(text).toContain('Tasks: 17 open, 1 completed'); expect(text).toContain('Overdue tasks: 14'); expect(text).toContain('Outstanding blocking commitments: 3'); expect(text).toContain('America/Los_Angeles'); expect(text).not.toContain('project-one');
    expect(f.queries.filter(q => q.method === 'work_entity.project.attention').every(q => !Object.hasOwn(q.args, 'query'))).toBe(true);
    expect(f.writes).toEqual([]); await page.screenshot({ path: info.outputPath('project-attention-phone.png'), fullPage: true });
  } finally { f.dispose(); }
});

test('the full paged attention list opens exact records and returns with project filters, scroll and focus intact', async ({ page }) => {
  const f = await boot(page);
  try {
    const search = overview(page).getByRole('searchbox', { name: 'Search this project', exact: true }); await search.fill('Matching note'); await search.press('Enter');
    await overview(page).getByRole('group', { name: 'Tasks to show', exact: true }).getByRole('button', { name: 'Completed', exact: true }).click();
    await overdue(page).click(); await expect(rows(page)).toHaveCount(10); await list(page).getByRole('button', { name: 'More attention items', exact: true }).click(); await expect(rows(page)).toHaveCount(14);
    const control = row(page, 'Overdue task 0'); await control.focus(); const position = await control.evaluate(node => node.getBoundingClientRect().top); await page.keyboard.press('Enter');
    await expect(page.locator('.work-entity-task-reader')).toHaveAttribute('data-task-id', 'overdue/0二?');
    await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(search).toHaveValue('Matching note'); await expect(overview(page).getByRole('group', { name: 'Tasks to show', exact: true }).getByRole('button', { name: 'Completed', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(rows(page)).toHaveCount(14); await expect(control).toBeFocused(); await expect.poll(() => control.evaluate(node => node.getBoundingClientRect().top)).toBeCloseTo(position, 0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('blocking commitments open their saved reader and browser Back returns to the same attention scope', async ({ page }) => {
  const f = await boot(page);
  try {
    await attention(page).getByRole('button', { name: '3 Outstanding blocking commitments', exact: true }).click(); await expect(rows(page)).toHaveCount(3);
    const chosen = rows(page).filter({ hasText: 'approval blocks this project' }); await chosen.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.work-entity-commitment-reader')).toHaveAttribute('data-commitment-id', 'approval'); await page.goBack();
    await expect(chosen).toBeFocused(); await expect(list(page)).toContainText('3 of 3'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const change of ['reassigned', 'replaced'] as const) test(`a ${change} attention task is refused before navigation`, async ({ page }) => {
  const f = await boot(page);
  try {
    await overdue(page).click(); const control = rows(page).first(), key = (await control.getAttribute('data-attention-key'))!, id = JSON.parse(key)[1] as string;
    if (change === 'reassigned') f.updateTask(id, { parent_project_id: 'other' });
    else { f.removeTask(id); f.seedTask(id, { title: 'Replacement task', due_at: now - 1000, parent_project_id: 'project-one' }, now + 5000); }
    await control.click(); await expect(attention(page).locator('[data-project-attention-action-error]')).toContainText(change === 'reassigned' ? 'no longer matches' : 'removed or replaced');
    await expect(overview(page)).toHaveAttribute('data-project-overview', 'project-one'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('failed refresh keeps confirmed totals and retry exposes explicit stale, partial and provider-only coverage', async ({ page }) => {
  await clipboard(page); const f = await boot(page);
  try {
    f.fail('work_entity.project.attention', 'project-one'); await attention(page).getByRole('button', { name: 'Refresh attention', exact: true }).click();
    await expect(attention(page).getByRole('alert')).toContainText('last successful read'); await expect(overdue(page)).toBeVisible();
    await attention(page).getByRole('button', { name: 'Copy status update', exact: true }).click(); expect((await copied(page))[0]).toContain('latest refresh failed');
    f.fail('work_entity.project.attention', 'project-one', false); f.attentionReply({ coverage: { omitted: 0, issues: [
      { kind: 'task', source_label: 'Vendor <team>', reason: 'stale' }, { kind: 'task', source_label: 'Partial source', reason: 'incomplete' },
      { kind: 'commitment', source_label: 'Live provider', reason: 'provider_only' },
    ] } });
    await attention(page).getByRole('button', { name: 'Refresh attention', exact: true }).click();
    const coverage = attention(page).locator('[data-project-attention-coverage]'); await expect(coverage).toContainText('saved coverage is incomplete'); await expect(coverage).toContainText('provider-only work is not included');
    await attention(page).getByRole('button', { name: 'Copy status update', exact: true }).click(); expect((await copied(page)).at(-1)).toContain('Vendor <team>: saved work may be out of date.'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const operation of ['summary', 'open'] as const) test(`a delayed attention ${operation} cannot change a newer project`, async ({ page }) => {
  const f = await boot(page);
  try {
    if (operation === 'summary') { f.hold('work_entity.project.attention', 'project-one'); await attention(page).getByRole('button', { name: 'Refresh attention', exact: true }).click(); }
    else { await overdue(page).click(); const id = JSON.parse((await rows(page).first().getAttribute('data-attention-key'))!)[1] as string; f.hold('work_entity.get', id); await rows(page).first().click(); }
    await expect.poll(f.waiting).toBe(true); await visit(page, serializeShellRoute('data', 'project', 'other')); await expect(overview(page)).toHaveAttribute('data-project-overview', 'other');
    f.release(); await expect(overview(page)).toContainText('Other project'); await expect(attention(page).getByRole('button', { name: '1 Overdue tasks', exact: true })).toBeVisible(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('manual copying stays escaped, focused and selected through a delayed ordinary project section', async ({ page }, info) => {
  await clipboard(page, true); const f = await boot(page, f => { f.updateProject('project-one', { title: 'Release </textarea><script>literal</script>' }); f.hold('work_entity.project.items', ''); });
  try {
    await expect.poll(f.waiting).toBe(true); await attention(page).getByRole('button', { name: 'Copy status update', exact: true }).click();
    const field = attention(page).getByRole('textbox', { name: 'Project update to copy', exact: true }); await expect(field).toBeFocused(); const value = await field.inputValue();
    f.release(); await expect(overview(page).locator('[data-project-section="task"]')).not.toHaveAttribute('aria-busy', 'true'); await expect(field).toBeFocused();
    expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([0, value.length]); await expect(overview(page).locator('img,script')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('project-update-manual-phone.png'), fullPage: true }); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('returning from an attention item refuses a reused original project', async ({ page }) => {
  const f = await boot(page);
  try {
    await openFirst(page); f.removeProject(); f.seedProject('project-one', { title: 'Replacement project' }, now + 5000);
    await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(attention(page).getByRole('alert')).toContainText('removed or replaced'); await expect(overview(page)).not.toContainText('Replacement project');
    await expect(attention(page).getByRole('button', { name: 'Copy status update', exact: true })).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a task completed elsewhere leaves the attention list and return focus moves to its heading', async ({ page }) => {
  const f = await boot(page);
  try {
    const { id } = await openFirst(page); f.updateTask(id, { done: true }); await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(overdue(page, 13)).toBeVisible(); await expect(attention(page).locator('[data-project-focus="attention-list"]')).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('browser Back protects an unsaved attention task edit and returns to its retained scope after acceptance', async ({ page }) => {
  const f = await boot(page);
  try {
    const { key, id } = await openFirst(page); await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Edit', exact: true }).click();
    const field = page.locator('.work-entity-dialog[data-kind="task"] [data-form-field="title"]'); await field.fill('Unfinished task edit');
    const prompts: string[] = [], address = await page.evaluate(() => location.hash);
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); }); await page.goBack(); await expect.poll(() => prompts.length).toBe(1); await expect(field).toHaveValue('Unfinished task edit'); expect(await page.evaluate(() => location.hash)).toBe(address);
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.accept(); }); await page.goBack(); await expect.poll(() => prompts.length).toBe(2); await expect(overview(page)).toHaveAttribute('data-project-overview', 'project-one');
    await expect(overview(page).locator('[data-project-focus]').filter({ hasText: f.task(id).title })).not.toHaveCount(0);
    await expect(rows(page).filter({ hasText: f.task(id).title })).toBeFocused(); expect(f.task(id).title).not.toBe('Unfinished task edit'); expect(key).toContain(id); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('an older server keeps the ordinary project sections usable without inventing attention totals', async ({ page }) => {
  const f = await boot(page, f => f.fixtureCaller(method => method === 'work_entity.project.attention' ? { error: { code: 'unknown_method', message: 'Older server' } } : undefined), false);
  try {
    await expect(attention(page)).toContainText('Update your Recued server'); await expect(attention(page).getByRole('group', { name: 'Attention scopes', exact: true })).toHaveCount(0);
    await expect(overview(page).locator('[data-project-section="task"]')).toContainText('Overdue task'); await expect(overview(page).getByRole('button', { name: 'Edit project', exact: true })).toBeVisible(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
