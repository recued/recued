import { expect, test, type Page } from '@playwright/test';
import type { SourceRegistration, WorkEntity } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskBulkTriageFixture } from './helpers/task-bulk-triage-fixture.js';

installFullAppHooks();
test.use({ timezoneId: 'America/Los_Angeles' });

const installTasks = async (page: Page) => {
  await page.addInitScript(() => {
    type Task = Extract<WorkEntity, { _kind: 'task' }>;
    const source: SourceRegistration = { id: 'recued.task', top_tier_kind: 'task', source_kind: 'builtin',
      source_label: 'My tasks', write_capable: true, registered_at: 1 };
    const sources = [source, { ...source, id: 'remote.task', source_kind: 'connection' as const, source_label: 'Connected tasks' },
      { ...source, id: 'readonly.task', source_kind: 'connection' as const, source_label: 'Read-only tasks', write_capable: false }];
    const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({ _kind: 'task', id, title,
      done: false, due_at: Date.UTC(2030, 9, 30), source_id: source.id, sync_state: 'live', conflict_policy: 'recued_wins',
      last_seen_at: 1, created_at: 1, updated_at: 1, blocks_task_ids: [], ...extra });
    const stored = new Map([
      task('a', 'File quarterly return'), task('b', 'Send revised proposal'),
      task('readonly', 'Read-only source task', { source_id: 'readonly.task' }),
      task('c', 'Book the inspection'), task('d', 'Pay electricity bill', { source_id: 'remote.task' }),
      task('pending', 'Waiting for source', { source_id: 'remote.task', pending_write: { staged_at: 1,
        operation: 'update', dirty_fields: ['due_at'], state: 'awaiting_verify' } }), task('done', 'Finished task', { done: true }),
    ].map(row => [row.id, row]));
    const writes: Array<{ method: string; args: Record<string, unknown> }> = [];
    const failures = new Map<string, 'before' | 'lost' | 'pending'>();
    let hold: string | null = null, release: (() => void) | undefined;
    Object.assign(window, { __taskBatch: {
      writes, fail(id: string, kind: 'before' | 'lost' | 'pending') { failures.set(id, kind); },
      hold(id: string) { hold = id; }, waiting: () => release !== undefined,
      release() { const done = release; release = undefined; done?.(); },
      confirm(id: string) { delete stored.get(id)!.pending_write; },
      row: (id: string) => structuredClone(stored.get(id)),
    }, __connectionsFixture: async (method: string, input: unknown) => {
      const args = (input ?? {}) as { kind?: string; id?: string; source_id?: string; offset?: number; search?: string;
        due_at?: number; clear_due_at?: boolean; done?: boolean; task_filter?: { completion: string } };
      if (method === 'work_entity.source.list') return { result: { sources, defaults_by_kind: { task: source.id } } };
      if (method === 'work_entity.get') return { result: { entity: stored.get(args.id!) ?? null } };
      if (method === 'work_entity.list') {
        let rows = args.kind === 'task' ? [...stored.values()] : [];
        if (args.source_id) rows = rows.filter(row => row.source_id === args.source_id);
        if (args.search) rows = rows.filter(row => row.title.toLowerCase().includes(args.search!.trim().toLowerCase()));
        if (args.task_filter?.completion !== undefined && args.task_filter.completion !== 'all') {
          rows = rows.filter(row => row.done === (args.task_filter!.completion === 'completed'));
        }
        const offset = args.offset ?? 0;
        return { result: { entities: rows.slice(offset, offset + 3), total: rows.length } };
      }
      if (method !== 'work_entity.task.mark_done' && method !== 'work_entity.upsert') return undefined;
      writes.push({ method, args: structuredClone(args) });
      const current = stored.get(args.id!);
      const failure = failures.get(args.id!); failures.delete(args.id!);
      if (failure === 'before') return { error: { code: 'unavailable', message: 'The task change was interrupted.' } };
      if (!current || !sources.find(row => row.id === current.source_id)?.write_capable) return { error: { code: 'forbidden', message: 'This source is read-only.' } };
      const next = { ...current, ...(method === 'work_entity.task.mark_done' ? { done: args.done! }
        : { due_at: args.clear_due_at ? undefined : args.due_at }) };
      if (failure === 'pending') next.pending_write = { staged_at: 1, operation: 'update', dirty_fields: ['due_at'], state: 'awaiting_verify' };
      stored.set(next.id, next);
      if (hold === args.id) { hold = null; await new Promise<void>(done => { release = done; }); }
      if (failure === 'lost') return { error: { code: 'timeout', message: 'The task change reply was lost.' } };
      return { result: { entity: next } };
    } });
  });
  await page.goto(`${HARNESS_URL}?journey=verification#data/task`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.getByRole('checkbox', { name: 'Select File quarterly return', exact: true })).toBeVisible();
};
const selection = (page: Page) => page.getByRole('region', { name: 'Task selection', exact: true });
const results = (page: Page) => page.getByRole('region', { name: 'Task batch results', exact: true });
const shiftPreview = (page: Page) => page.getByRole('region', { name: 'Deadline shift preview', exact: true });
const search = (page: Page) => page.locator('[data-action="search-work-entities"][data-kind="task"]');
const more = (page: Page) => page.getByRole('button', { name: 'Load more', exact: true });
const changes = async (page: Page) => {
  const panel = selection(page), disclosure = panel.locator('[data-task-bulk-more]');
  if (!await disclosure.evaluate(element => element.hasAttribute('open'))) await disclosure.locator('summary').click();
  return panel;
};


test('keeps selection compact and preserves More changes and drafts across repaints', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installTasks(page);
  const panel = selection(page), selectShown = panel.getByRole('button', { name: 'Select shown', exact: true });
  await selectShown.click();
  const disclosure = panel.locator('[data-task-bulk-more]'), summary = disclosure.locator('summary');
  const priority = panel.getByLabel('Priority', { exact: true });
  await expect(disclosure).not.toHaveAttribute('open');
  await expect(priority).toBeHidden();
  await expect(panel.getByRole('button', { name: 'Complete selected', exact: true })).toBeVisible();
  await expect(page.locator('.work-entity-list-row-button').nth(1)).toBeInViewport({ ratio: 1 });
  await summary.focus(); await summary.press('Enter');
  await expect(priority).toBeVisible();
  await priority.focus(); await priority.selectOption('high');
  await expect(priority).toBeFocused();
  await selectShown.focus(); await selectShown.press('Enter');
  await expect(selectShown).toBeFocused();
  await expect(disclosure).toHaveAttribute('open');
  await expect(priority).toHaveValue('high');
  await summary.focus(); await summary.press('Enter');
  await expect(priority).toBeHidden();
  await selectShown.focus(); await selectShown.press('Enter');
  await expect(disclosure).not.toHaveAttribute('open');
  await summary.focus(); await summary.press('Enter');
  await expect(priority).toHaveValue('high');
  expect(await page.evaluate(() => window.__taskBatch.writes)).toEqual([]);
  await panel.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(disclosure).toHaveCount(0);
  await selectShown.click();
  await expect(disclosure).not.toHaveAttribute('open');
  await summary.click();
  await expect(priority).toHaveValue('');
});

test('selects only shown writable tasks, resets on search, and applies whole-day dates, clears and completion', async ({ page }, testInfo) => {
  await installTasks(page);
  await expect(page.getByRole('checkbox', { name: /Select Read-only source task/ })).toBeDisabled();
  await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
  await expect(selection(page)).toContainText('2 tasks selected');
  await search(page).fill('proposal');
  await expect(page.locator('.work-entity-list-row')).toHaveCount(1);
  await expect(selection(page)).toContainText('Change tasks together');
  await search(page).fill(''); await expect(page.locator('.work-entity-list-row')).toHaveCount(3);
  await more(page).click(); await expect(page.locator('.work-entity-list-row')).toHaveCount(6);
  await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
  await expect(selection(page)).toContainText('4 tasks selected');
  await (await changes(page)).getByLabel('Due date', { exact: true }).fill('2030-11-05');
  await page.locator('.work-entity-page').screenshot({ path: testInfo.outputPath('task-selection-desktop.png') });
  await (await changes(page)).getByRole('button', { name: 'Set due date', exact: true }).click();
  await expect(results(page)).toContainText('4 confirmed · 0 failed');
  await expect(results(page)).toBeFocused();
  expect(await page.evaluate(() => window.__taskBatch.writes.map(row => row.args))).toEqual(
    ['a', 'b', 'c', 'd'].map(id => ({ kind: 'task', id, due_at: Date.UTC(2030, 10, 5) })));
  await expect(page.locator('.work-entity-list-row').first()).toContainText('Due 2030-11-05');
  await results(page).getByRole('button', { name: 'Start another selection', exact: true }).click();
  await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
  await (await changes(page)).getByRole('button', { name: 'Clear due dates', exact: true }).click();
  await expect(results(page)).toContainText('2 confirmed · 0 failed');
  expect(await page.evaluate(() => window.__taskBatch.writes.slice(4).map(row => row.args))).toEqual([
    { kind: 'task', id: 'a', clear_due_at: true }, { kind: 'task', id: 'b', clear_due_at: true },
  ]);
  await results(page).getByRole('button', { name: 'Start another selection', exact: true }).click();
  await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
  await selection(page).getByRole('button', { name: 'Complete selected', exact: true }).click();
  await expect(results(page)).toContainText('2 confirmed · 0 failed');
  expect(await page.evaluate(() => window.__taskBatch.writes.slice(6))).toEqual([
    { method: 'work_entity.task.mark_done', args: { id: 'a', done: true } },
    { method: 'work_entity.task.mark_done', args: { id: 'b', done: true } },
  ]);
});

test('keeps phone batches recoverable across navigation, stop, lost replies and pending source confirmation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installTasks(page);
  await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
  await page.evaluate(() => { window.__taskBatch.fail('a', 'lost'); window.__taskBatch.fail('b', 'before'); window.__taskBatch.hold('a'); });
  await selection(page).getByRole('button', { name: 'Complete selected', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__taskBatch.waiting())).toBe(true);
  await page.getByRole('combobox', { name: 'Collection', exact: true }).selectOption('note');
  await expect(page.getByRole('combobox', { name: 'Collection', exact: true })).toHaveValue('task');
  await results(page).getByRole('button', { name: 'Stop after current task', exact: true }).click();
  await expect(results(page)).toBeFocused();
  await search(page).focus();
  await page.evaluate(() => window.__taskBatch.release());
  await expect(results(page)).toContainText('0 confirmed · 2 failed');
  await expect(search(page)).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('task-batch-retry-mobile.png') });
  await results(page).getByRole('button', { name: 'Retry failed', exact: true }).click();
  await expect(results(page)).toContainText('1 confirmed · 1 failed');
  await results(page).getByRole('button', { name: 'Retry failed', exact: true }).click();
  await expect(results(page)).toContainText('2 confirmed · 0 failed');
  expect(await page.evaluate(() => window.__taskBatch.writes.map(row => row.args.id))).toEqual(['a', 'b', 'b']);
  await results(page).getByRole('button', { name: 'Start another selection', exact: true }).click();
  await more(page).click(); await expect(page.locator('.work-entity-list-row')).toHaveCount(6);
  await page.getByRole('checkbox', { name: 'Select Book the inspection', exact: true }).check();
  await page.evaluate(() => window.__taskBatch.fail('c', 'pending'));
  await (await changes(page)).getByRole('button', { name: 'Clear due dates', exact: true }).click();
  await expect(results(page)).toContainText('0 confirmed · 0 failed · 1 waiting for confirmation');
  await results(page).getByRole('button', { name: 'Check unconfirmed', exact: true }).click();
  await expect(results(page)).toContainText('The requested outcome is not confirmed.');
  await page.evaluate(() => window.__taskBatch.confirm('c'));
  await results(page).getByRole('button', { name: 'Check unconfirmed', exact: true }).click();
  await expect(results(page)).toContainText('1 confirmed · 0 failed');
  expect(await page.evaluate(() => window.__taskBatch.writes.filter(row => row.args.id === 'c'))).toHaveLength(1);
});

test('a list refresh started before selection cannot replace the selected page', async ({ page }) => {
  await installTasks(page);
  await more(page).click(); await expect(page.locator('.work-entity-list-row')).toHaveCount(6);
  const reads = await page.evaluate(() => window.__app.rpcCallCount('work_entity.list'));
  await page.evaluate(() => {
    window.__app.holdRpcResponses?.('work_entity.list');
    window.__app.fireMessage({ type: 'server_event', event: { kind: 'warehouse', collection: 'task',
      op: 'update', id: 'a', cursor: Date.now() } });
  });
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('work_entity.list'))).toBe(reads + 1);
  await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
  await expect(selection(page)).toContainText('4 tasks selected');
  await expect.poll(() => page.evaluate(() => window.__app.releaseRpcResponses?.('work_entity.list') ?? 0)).toBe(1);
  await expect(page.locator('.work-entity-list-row')).toHaveCount(6);
  await expect(selection(page)).toContainText('4 tasks selected');
});

declare global { interface Window { __taskBatch: {
  writes: Array<{ method: string; args: Record<string, unknown> }>;
  fail(id: string, kind: 'before' | 'lost' | 'pending'): void;
  hold(id: string): void; waiting(): boolean; release(): void; confirm(id: string): void;
  row(id: string): WorkEntity | undefined;
} } }

const nativeTasks = async (page: Page, options: { includeUndated?: boolean } = {}) => {
  const fixture = await installTaskBulkTriageFixture(page, options);
  await page.goto(`${HARNESS_URL}?journey=verification#data/task`); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.getByRole('checkbox', { name: 'Select Prepare launch', exact: true })).toBeVisible();
  return fixture;
};

test('sets priority across open and completed native tasks, skips matching priorities, and preserves unrelated fields', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 }); const fixture = await nativeTasks(page);
  try {
    const before = fixture.read('open-a'), completed = fixture.read('done-a');
    await expect(page.getByRole('checkbox', { name: /^Select Read-only task —/ })).toBeDisabled();
    await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click(); await expect(selection(page)).toContainText('4 tasks selected');
    await expect((await changes(page)).getByRole('button', { name: 'Set due date', exact: true })).toBeDisabled();
    await (await changes(page)).getByRole('button', { name: 'Set priority', exact: true }).click();
    await expect(selection(page).getByRole('alert')).toContainText('Choose Low, Medium, or High'); expect(fixture.writes).toEqual([]);
    await (await changes(page)).getByLabel('Priority', { exact: true }).selectOption('high');
    await expect(selection(page).getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('task-priority-selection-phone.png'), fullPage: true });
    await (await changes(page)).getByRole('button', { name: 'Set priority', exact: true }).click();
    await expect(results(page)).toContainText('4 confirmed · 0 failed'); await expect(results(page)).toContainText('Set priority to High');
    expect(fixture.writes.map(row => row.args).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual(
      ['done-a', 'open-a', 'open-b'].map(id => ({ kind: 'task', id, priority: 'high' })));
    expect(fixture.read('open-a')).toMatchObject({ title: before.title, body: before.body, due_at: before.due_at, done: false, priority: 'high',
      assigned_contact_id: before.assigned_contact_id, parent_project_id: before.parent_project_id, parent_calendar_event_id: before.parent_calendar_event_id,
      linked_mail_thread_id: before.linked_mail_thread_id, blocks_task_ids: before.blocks_task_ids });
    expect(fixture.read('done-a')).toMatchObject({ done: true, completed_at: completed.completed_at, due_at: completed.due_at, priority: 'high' });
    await expect(page.locator('[data-action="open-edit-work-entity"][data-entity-id="done-a"]')).toContainText('Priority high');
  } finally { fixture.dispose(); }
});

test('reopens completed native tasks with cleared completion times and retains their original deadlines', async ({ page }) => {
  const fixture = await nativeTasks(page);
  try {
    await page.getByRole('button', { name: 'Task filters', exact: true }).click();
    await page.locator('[data-action="filter-task-completion"]').selectOption('completed');
    await expect(page.getByRole('checkbox', { name: 'Select Prepare launch', exact: true })).toHaveCount(0);
    const due = fixture.read('done-a').due_at;
    await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click(); await expect(selection(page)).toContainText('2 tasks selected');
    await expect(selection(page).getByRole('button', { name: 'Complete selected', exact: true })).toHaveCount(0);
    await selection(page).getByRole('button', { name: 'Reopen selected', exact: true }).click();
    await expect(results(page)).toContainText('2 confirmed · 0 failed');
    expect(fixture.writes.map(row => row.args).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([{ id: 'done-a', done: false }, { id: 'done-b', done: false }]);
    expect(fixture.writes.every(row => row.method === 'work_entity.task.mark_done')).toBe(true);
    expect(fixture.read('done-a')).toMatchObject({ done: false, due_at: due }); expect(fixture.read('done-a').completed_at).toBeUndefined();
    expect(fixture.read('done-b').completed_at).toBeUndefined(); await expect(page.locator('[data-entity-id="done-a"]')).toHaveCount(0);
    await results(page).getByRole('button', { name: 'Start another selection', exact: true }).click();
    await page.locator('[data-action="filter-task-completion"]').selectOption('open');
    await expect(page.getByRole('checkbox', { name: 'Select Finished review', exact: true })).toBeVisible();
  } finally { fixture.dispose(); }
});

for (const action of ['priority', 'reopen'] as const) {
  test(`reconciles native ${action} batches after lost replies and pending confirmation without repeating writes`, async ({ page }) => {
    const fixture = await nativeTasks(page);
    try {
      await page.getByRole('checkbox', { name: 'Select Finished review', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Select Finished approval', exact: true }).check();
      if (action === 'priority') await (await changes(page)).getByLabel('Priority', { exact: true }).selectOption('medium');
      fixture.fail('done-a', 'lost'); fixture.fail('done-b', 'pending');
      await (await changes(page)).getByRole('button', { name: action === 'priority' ? 'Set priority' : 'Reopen selected', exact: true }).click();
      await expect(results(page)).toContainText('1 failed · 1 waiting for confirmation');
      await results(page).getByRole('button', { name: 'Retry failed', exact: true }).click();
      await expect(results(page)).toContainText('1 confirmed · 0 failed · 1 waiting for confirmation');
      await results(page).getByRole('button', { name: 'Check unconfirmed', exact: true }).click();
      await expect(results(page)).toContainText('The requested outcome is not confirmed'); fixture.confirm('done-b');
      await results(page).getByRole('button', { name: 'Check unconfirmed', exact: true }).click();
      await expect(results(page)).toContainText('2 confirmed · 0 failed'); expect(fixture.writes).toHaveLength(2);
    } finally { fixture.dispose(); }
  });
}

test('checks current native permissions and identity before a priority batch, without writing unavailable tasks', async ({ page }) => {
  const fixture = await nativeTasks(page);
  try {
    await page.getByRole('checkbox', { name: 'Select Prepare launch', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Select Review proposal', exact: true }).check();
    await (await changes(page)).getByLabel('Priority', { exact: true }).selectOption('high'); fixture.readonly(true); fixture.replace('open-b');
    await (await changes(page)).getByRole('button', { name: 'Set priority', exact: true }).click();
    await expect(results(page)).toContainText('0 confirmed · 2 failed'); expect(fixture.writes).toEqual([]);
    await expect(results(page)).toContainText('read-only'); await expect(results(page)).toContainText('identity');
  } finally { fixture.dispose(); }
});

test('stops native priority writes after the current task and retries with the originally chosen priority', async ({ page }) => {
  const fixture = await nativeTasks(page);
  try {
    await page.getByRole('checkbox', { name: 'Select Prepare launch', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Select Review proposal', exact: true }).check();
    await (await changes(page)).getByLabel('Priority', { exact: true }).selectOption('high'); fixture.hold('work_entity.upsert', 'open-a');
    await (await changes(page)).getByRole('button', { name: 'Set priority', exact: true }).click(); await expect.poll(fixture.waiting).toBe(true);
    await results(page).getByRole('button', { name: 'Stop after current task', exact: true }).click(); await search(page).focus(); fixture.release();
    await expect(results(page)).toContainText('1 confirmed · 1 failed'); await expect(search(page)).toBeFocused();
    await results(page).getByRole('button', { name: 'Retry failed', exact: true }).click();
    await expect(results(page)).toContainText('2 confirmed · 0 failed');
    expect(fixture.writes.map(row => row.args)).toEqual([{ kind: 'task', id: 'open-a', priority: 'high' }, { kind: 'task', id: 'open-b', priority: 'high' }]);
  } finally { fixture.dispose(); }
});

test('previews spaced native deadlines, cancels safely, validates custom days, and shifts earlier with skipped tasks', async ({ page }, testInfo) => {
  const fixture = await nativeTasks(page, { includeUndated: true });
  try {
    const before = fixture.read('open-a'), second = fixture.read('open-b'), completed = fixture.read('done-a');
    await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
    await (await changes(page)).getByRole('button', { name: 'Preview +1 week', exact: true }).click();
    await expect(shiftPreview(page)).toContainText('2 tasks will move · 3 skipped');
    await expect(shiftPreview(page)).toBeFocused();
    await expect(shiftPreview(page).getByRole('listitem').filter({ hasText: 'Prepare launch' })).toContainText('2026-11-16 12:00:00 UTC → 2026-11-23 12:00:00 UTC');
    await expect(shiftPreview(page).getByRole('listitem').filter({ hasText: 'Review proposal' })).toContainText('2026-11-19 12:00:00 UTC → 2026-11-26 12:00:00 UTC');
    await expect(shiftPreview(page)).toContainText('No due date to shift'); expect(fixture.writes).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('deadline-shift-preview-desktop.png'), fullPage: true });
    await shiftPreview(page).getByRole('button', { name: 'Back to selection', exact: true }).click();
    await expect(selection(page)).toContainText('5 tasks selected');
    await expect((await changes(page)).getByRole('button', { name: 'Preview shift', exact: true })).toBeFocused();
    await (await changes(page)).getByLabel('Days to shift', { exact: true }).fill('0');
    await (await changes(page)).getByRole('button', { name: 'Preview shift', exact: true }).click();
    await expect(selection(page).getByRole('alert')).toContainText('nonzero whole number'); expect(fixture.writes).toEqual([]);
    await (await changes(page)).getByLabel('Days to shift', { exact: true }).press('ControlOrMeta+A');
    await (await changes(page)).getByLabel('Days to shift', { exact: true }).pressSequentially('-2');
    await expect((await changes(page)).getByLabel('Days to shift', { exact: true })).toHaveValue('-2');
    await (await changes(page)).getByRole('button', { name: 'Preview shift', exact: true }).click();
    await expect(shiftPreview(page)).toContainText('Shift deadlines 2 days earlier');
    await shiftPreview(page).getByRole('button', { name: 'Apply deadline shift', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(results(page)).toContainText('2 confirmed · 0 failed · 0 waiting for confirmation · 3 skipped');
    expect(fixture.writes.map(row => row.args).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([
      { kind: 'task', id: 'open-a', due_at: before.due_at! - 2 * 86400000 }, { kind: 'task', id: 'open-b', due_at: second.due_at! - 2 * 86400000 },
    ]);
    expect(fixture.read('open-b').due_at! - fixture.read('open-a').due_at!).toBe(second.due_at! - before.due_at!);
    expect(fixture.read('open-a')).toMatchObject({ title: before.title, body: before.body, priority: before.priority,
      assigned_contact_id: before.assigned_contact_id, parent_project_id: before.parent_project_id, linked_mail_thread_id: before.linked_mail_thread_id });
    expect(fixture.read('done-a')).toMatchObject({ done: true, completed_at: completed.completed_at, due_at: completed.due_at });
    expect(fixture.read('undated').due_at).toBeUndefined();
  } finally { fixture.dispose(); }
});

test('keeps phone deadline shifts at their previewed dates after lost replies and pending source confirmation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); const fixture = await nativeTasks(page);
  try {
    const first = fixture.read('open-a').due_at!, second = fixture.read('open-b').due_at!;
    await page.getByRole('checkbox', { name: 'Select Prepare launch', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Select Review proposal', exact: true }).check();
    await (await changes(page)).getByRole('button', { name: 'Preview +1 day', exact: true }).click();
    await expect(shiftPreview(page)).toContainText('2 tasks will move · 0 skipped');
    fixture.fail('open-a', 'lost'); fixture.fail('open-b', 'pending');
    await page.screenshot({ path: testInfo.outputPath('deadline-shift-preview-phone.png'), fullPage: true });
    await shiftPreview(page).getByRole('button', { name: 'Apply deadline shift', exact: true }).click();
    await expect(results(page)).toContainText('1 failed · 1 waiting for confirmation');
    await results(page).getByRole('button', { name: 'Retry failed', exact: true }).click();
    await expect(results(page)).toContainText('1 confirmed · 0 failed · 1 waiting for confirmation');
    await results(page).getByRole('button', { name: 'Check unconfirmed', exact: true }).click();
    await expect(results(page)).toContainText('The requested outcome is not confirmed'); fixture.confirm('open-b');
    await results(page).getByRole('button', { name: 'Check unconfirmed', exact: true }).click();
    await expect(results(page)).toContainText('2 confirmed · 0 failed · 0 waiting for confirmation · 0 skipped');
    expect(fixture.writes).toHaveLength(2); expect(fixture.read('open-a').due_at).toBe(first + 86400000);
    expect(fixture.read('open-b').due_at).toBe(second + 86400000);
  } finally { fixture.dispose(); }
});

test('leaves native deadlines changed or completed after a preview alone', async ({ page }) => {
  const fixture = await nativeTasks(page);
  try {
    const first = fixture.read('open-a').due_at!, second = fixture.read('open-b').due_at!;
    await page.getByRole('checkbox', { name: 'Select Prepare launch', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Select Review proposal', exact: true }).check();
    await (await changes(page)).getByRole('button', { name: 'Preview +1 week', exact: true }).click();
    fixture.change('open-a', { due_at: first + 2 * 86400000 }); fixture.change('open-b', { done: true });
    await shiftPreview(page).getByRole('button', { name: 'Apply deadline shift', exact: true }).click();
    await expect(results(page)).toContainText('0 confirmed · 0 failed · 0 waiting for confirmation · 2 skipped');
    await expect(results(page)).toContainText('due date changed after the preview'); await expect(results(page)).toContainText('completed after the preview');
    expect(fixture.writes).toEqual([]); expect(fixture.read('open-a').due_at).toBe(first + 2 * 86400000); expect(fixture.read('open-b').due_at).toBe(second);
  } finally { fixture.dispose(); }
});

test('stops native deadline shifts and retries only the remaining frozen target', async ({ page }) => {
  const fixture = await nativeTasks(page);
  try {
    const first = fixture.read('open-a').due_at!, second = fixture.read('open-b').due_at!;
    await page.getByRole('checkbox', { name: 'Select Prepare launch', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Select Review proposal', exact: true }).check();
    await (await changes(page)).getByRole('button', { name: 'Preview +1 week', exact: true }).click(); fixture.hold('work_entity.upsert', 'open-a');
    await shiftPreview(page).getByRole('button', { name: 'Apply deadline shift', exact: true }).click(); await expect.poll(fixture.waiting).toBe(true);
    await results(page).getByRole('button', { name: 'Stop after current task', exact: true }).click(); fixture.release();
    await expect(results(page)).toContainText('1 confirmed · 1 failed');
    await results(page).getByRole('button', { name: 'Retry failed', exact: true }).click();
    await expect(results(page)).toContainText('2 confirmed · 0 failed');
    expect(fixture.writes.map(row => row.args)).toEqual([
      { kind: 'task', id: 'open-a', due_at: first + 7 * 86400000 }, { kind: 'task', id: 'open-b', due_at: second + 7 * 86400000 },
    ]);
  } finally { fixture.dispose(); }
});

test('retires a deadline preview when task search changes without submitting the old selection', async ({ page }) => {
  const fixture = await nativeTasks(page);
  try {
    await page.getByRole('checkbox', { name: 'Select Prepare launch', exact: true }).check();
    await (await changes(page)).getByRole('button', { name: 'Preview +1 day', exact: true }).click();
    await expect(shiftPreview(page)).toBeVisible(); await search(page).fill('proposal');
    await expect(shiftPreview(page)).toHaveCount(0); await expect(selection(page)).toContainText('Change tasks together');
    await expect(page.locator('.work-entity-list-row')).toHaveCount(1); expect(fixture.writes).toEqual([]);
    await page.getByRole('checkbox', { name: 'Select Review proposal', exact: true }).check();
    await (await changes(page)).getByRole('button', { name: 'Preview +1 day', exact: true }).click();
    await expect(shiftPreview(page)).toContainText('1 task will move');
    await expect(shiftPreview(page)).not.toContainText('Prepare launch'); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});


test.describe('selected task projects', () => {
  type Fixture = Awaited<ReturnType<typeof installTaskBulkTriageFixture>>;
  const selection = (page: Page) => page.getByRole('region', { name: 'Task selection', exact: true });
  const preview = (page: Page) => page.getByRole('region', { name: 'Task project preview', exact: true });
  const results = (page: Page) => page.getByRole('region', { name: 'Task batch results', exact: true });
  const picker = (page: Page) => page.locator('[data-ref-picker="task-bulk-project"]');
  const input = (page: Page) => picker(page).getByRole('combobox', { name: 'Project for selected tasks', exact: true });
  const search = (page: Page) => page.getByRole('searchbox', { name: 'Search tasks', exact: true });
  const boot = async (page: Page, prepare?: (fixture: Fixture) => void) => {
    const fixture = await installTaskBulkTriageFixture(page); prepare?.(fixture);
    await page.goto(`${HARNESS_URL}?journey=verification#data/task`); await page.waitForFunction(() => window.__app?.ready === true);
    await expect(page.getByRole('checkbox', { name: 'Select Prepare launch', exact: true })).toBeVisible();
    return fixture;
  };
  const selectOpen = async (page: Page) => {
    await page.getByRole('checkbox', { name: 'Select Prepare launch', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Select Review proposal', exact: true }).check();
    await changes(page);
  };
  const choose = async (page: Page, query = 'Customer release', label = 'Customer release · Recued') => {
    await changes(page); await input(page).fill(query); await picker(page).getByRole('option', { name: label, exact: true }).click();
    await expect(input(page)).toHaveValue(label);
  };
  const review = async (page: Page, remove = false) => {
    await (await changes(page)).getByRole('button', { name: remove ? 'Preview removing project links' : 'Preview project assignment', exact: true }).click();
    await expect(preview(page).getByRole('button', { name: 'Apply project changes', exact: true })).toBeEnabled();
  };

  test('assigns open and completed native tasks by project name, with move review and keyboard confirmation', async ({ page }, info) => {
    const f = await boot(page);
    try {
      const first = f.read('open-a'), done = f.read('done-a');
      await selectOpen(page); await page.getByRole('checkbox', { name: 'Select Finished review', exact: true }).check();
      await changes(page); await input(page).fill('Customer release');
      await expect(picker(page).getByRole('option')).toHaveCount(2);
      const labels = await picker(page).getByRole('option').allTextContents(), index = labels.indexOf('Customer release · Recued');
      expect(index).toBeGreaterThanOrEqual(0);
      for (let i = 0; i <= index; i++) await input(page).press('ArrowDown');
      await input(page).press('Enter'); await expect(input(page)).toHaveValue('Customer release · Recued');
      await review(page); await expect(preview(page)).toBeFocused();
      await expect(preview(page)).toContainText('3 tasks will change · 0 skipped');
      await expect(preview(page).getByRole('listitem').filter({ hasText: 'Prepare launch' })).toContainText('Launch project · Recued → Customer release · Recued');
      await expect(preview(page)).toContainText('Moves out of its current project.'); expect(f.writes).toEqual([]);
      await page.screenshot({ path: info.outputPath('task-project-preview-desktop.png'), fullPage: true });
      await preview(page).getByRole('button', { name: 'Back to selection', exact: true }).click();
      await expect(selection(page)).toContainText('3 tasks selected'); await expect(input(page)).toHaveValue('Customer release · Recued');
      await expect((await changes(page)).getByRole('button', { name: 'Preview project assignment', exact: true })).toBeFocused();
      await input(page).focus(); await expect(picker(page).getByRole('option')).toHaveCount(2); await input(page).press('Escape');
      await review(page); await preview(page).getByRole('button', { name: 'Apply project changes', exact: true }).focus(); await page.keyboard.press('Enter');
      await expect(results(page)).toContainText('3 confirmed · 0 failed · 0 waiting for confirmation · 0 skipped');
      expect(f.writes.map(row => row.args).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual(
        ['done-a', 'open-a', 'open-b'].map(id => ({ kind: 'task', id, parent_project_id: 'release' })));
      expect(f.read('open-a')).toMatchObject({ title: first.title, body: first.body, due_at: first.due_at, priority: first.priority,
        assigned_contact_id: first.assigned_contact_id, parent_calendar_event_id: first.parent_calendar_event_id, linked_mail_thread_id: first.linked_mail_thread_id,
        blocks_task_ids: first.blocks_task_ids, parent_project_id: 'release' });
      expect(f.read('done-a')).toMatchObject({ done: true, completed_at: done.completed_at, due_at: done.due_at, parent_project_id: 'release' });
    } finally { f.dispose(); }
  });

  test('removes reviewed links on a phone, preserves completed tasks, and disables an all-skipped preview', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 }); const f = await boot(page, f => f.change('done-a', { parent_project_id: 'launch' }));
    try {
      const before = f.read('open-a'), done = f.read('done-a');
      await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
      await review(page, true); await expect(preview(page)).toContainText('2 tasks will change · 2 skipped');
      await expect(preview(page)).toContainText('Launch project · Recued → No project'); await expect(preview(page)).toContainText('Already has no project.');
      await page.screenshot({ path: info.outputPath('task-project-removal-phone.png'), fullPage: true });
      await preview(page).getByRole('button', { name: 'Back to selection', exact: true }).click();
      await expect((await changes(page)).getByRole('button', { name: 'Preview removing project links', exact: true })).toBeFocused();
      expect(f.writes).toEqual([]); await review(page, true);
      await preview(page).getByRole('button', { name: 'Apply project changes', exact: true }).click();
      await expect(results(page)).toContainText('2 confirmed · 0 failed · 0 waiting for confirmation · 2 skipped');
      expect(f.writes.map(row => row.args).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual(
        ['done-a', 'open-a'].map(id => ({ kind: 'task', id, clear_parent_project: true })));
      expect(f.read('open-a').parent_project_id).toBeUndefined(); expect(f.read('open-a')).toMatchObject({ body: before.body, due_at: before.due_at, priority: before.priority });
      expect(f.read('done-a')).toMatchObject({ done: true, completed_at: done.completed_at, due_at: done.due_at });
      await results(page).getByRole('button', { name: 'Start another selection', exact: true }).click();
      await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
      await (await changes(page)).getByRole('button', { name: 'Preview removing project links', exact: true }).click();
      await expect(preview(page)).toContainText('0 tasks will change · 4 skipped');
      await expect(preview(page).getByRole('button', { name: 'Apply project changes', exact: true })).toBeDisabled(); expect(f.writes).toHaveLength(2);
    } finally { f.dispose(); }
  });

  for (const remove of [false, true]) {
    test(`reconciles native project ${remove ? 'removal' : 'assignment'} after lost replies and pending confirmation without repeating writes`, async ({ page }) => {
      const f = await boot(page, f => f.change('open-b', { parent_project_id: 'launch' }));
      try {
        await selectOpen(page);
        if (!remove) await choose(page, 'Customer release', 'Customer release · Imported projects');
        await review(page, remove); f.fail('open-a', 'lost'); f.fail('open-b', 'pending');
        await preview(page).getByRole('button', { name: 'Apply project changes', exact: true }).click();
        await expect(results(page)).toContainText('1 failed · 1 waiting for confirmation');
        await results(page).getByRole('button', { name: 'Retry failed', exact: true }).click();
        await expect(results(page)).toContainText('1 confirmed · 0 failed · 1 waiting for confirmation');
        await results(page).getByRole('button', { name: 'Check unconfirmed', exact: true }).click();
        await expect(results(page)).toContainText('The requested outcome is not confirmed'); f.confirm('open-b');
        await results(page).getByRole('button', { name: 'Check unconfirmed', exact: true }).click();
        await expect(results(page)).toContainText('2 confirmed · 0 failed · 0 waiting for confirmation'); expect(f.writes).toHaveLength(2);
        expect(f.read('open-a').parent_project_id).toBe(remove ? undefined : 'imported-release');
        expect(f.read('open-b').parent_project_id).toBe(remove ? undefined : 'imported-release');
      } finally { f.dispose(); }
    });
  }

  test('leaves a reassigned native task alone and reconciles another already at the reviewed destination', async ({ page }) => {
    const f = await boot(page);
    try {
      await selectOpen(page); await choose(page); await review(page);
      f.change('open-a', { parent_project_id: 'imported-release' }); f.change('open-b', { parent_project_id: 'release' });
      await preview(page).getByRole('button', { name: 'Apply project changes', exact: true }).click();
      await expect(results(page)).toContainText('1 confirmed · 0 failed · 0 waiting for confirmation · 1 skipped');
      await expect(results(page)).toContainText('project link changed after the preview'); expect(f.writes).toEqual([]);
      expect(f.read('open-a').parent_project_id).toBe('imported-release'); expect(f.read('open-b').parent_project_id).toBe('release');
    } finally { f.dispose(); }
  });

  test('requires a new review after the destination project is replaced, including on retry', async ({ page }) => {
    const f = await boot(page);
    try {
      await selectOpen(page); await choose(page); await review(page); f.replaceProject('release');
      await preview(page).getByRole('button', { name: 'Apply project changes', exact: true }).click();
      await expect(results(page)).toContainText('0 confirmed · 2 failed'); await expect(results(page)).toContainText('destination project changed identity');
      await results(page).getByRole('button', { name: 'Retry failed', exact: true }).click();
      await expect(results(page)).toContainText('0 confirmed · 2 failed'); expect(f.writes).toEqual([]);
      await results(page).getByRole('button', { name: 'Start another selection', exact: true }).click();
      await selectOpen(page); await choose(page); await review(page);
      await preview(page).getByRole('button', { name: 'Apply project changes', exact: true }).click();
      await expect(results(page)).toContainText('2 confirmed · 0 failed'); expect(f.writes).toHaveLength(2);
    } finally { f.dispose(); }
  });

  test('rechecks native task access and identity before a project batch', async ({ page }) => {
    const f = await boot(page);
    try {
      await selectOpen(page); await choose(page); await review(page); f.readonly(true); f.replace('open-b');
      await preview(page).getByRole('button', { name: 'Apply project changes', exact: true }).click();
      await expect(results(page)).toContainText('0 confirmed · 2 failed'); await expect(results(page)).toContainText('read-only');
      await expect(results(page)).toContainText('changed identity'); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });

  test('stops project writes after the current task and retries only the remaining frozen destination', async ({ page }) => {
    const f = await boot(page);
    try {
      await selectOpen(page); await choose(page); await review(page); f.hold('work_entity.upsert', 'open-a');
      await preview(page).getByRole('button', { name: 'Apply project changes', exact: true }).click(); await expect.poll(f.waiting).toBe(true);
      await results(page).getByRole('button', { name: 'Stop after current task', exact: true }).click(); await search(page).focus(); f.release();
      await expect(results(page)).toContainText('1 confirmed · 1 failed'); await expect(search(page)).toBeFocused();
      await results(page).getByRole('button', { name: 'Retry failed', exact: true }).click(); await expect(results(page)).toContainText('2 confirmed · 0 failed');
      expect(f.writes.map(row => row.args)).toEqual([{ kind: 'task', id: 'open-a', parent_project_id: 'release' }, { kind: 'task', id: 'open-b', parent_project_id: 'release' }]);
    } finally { f.dispose(); }
  });

  test('retires a pending project preview on Back and clears it when task search changes', async ({ page }) => {
    const f = await boot(page);
    try {
      await selectOpen(page); await choose(page); f.hold('work_entity.get', 'release');
      await (await changes(page)).getByRole('button', { name: 'Preview project assignment', exact: true }).click(); await expect.poll(f.waiting).toBe(true);
      await expect(preview(page)).toContainText('Loading project preview');
      await preview(page).getByRole('button', { name: 'Back to selection', exact: true }).click();
      await choose(page, 'Launch', 'Launch project · Recued'); f.release(); await review(page);
      await expect(preview(page)).toContainText('1 task will change · 1 skipped'); await expect(preview(page)).not.toContainText('Customer release');
      await search(page).fill('Review proposal'); await expect(preview(page)).toHaveCount(0);
      await expect(selection(page)).toContainText('Change tasks together'); expect(f.writes).toEqual([]);
      await page.getByRole('checkbox', { name: 'Select Review proposal', exact: true }).check(); await choose(page); await review(page);
      await expect(preview(page)).not.toContainText('Prepare launch');
      await preview(page).getByRole('button', { name: 'Apply project changes', exact: true }).click(); await expect(results(page)).toContainText('1 confirmed · 0 failed');
      expect(f.writes.map(row => row.args)).toEqual([{ kind: 'task', id: 'open-b', parent_project_id: 'release' }]);
      expect(f.read('open-a').parent_project_id).toBe('launch');
    } finally { f.dispose(); }
  });

  test('recovers project search and preview failures while retaining the selection, then clears the chosen target', async ({ page }) => {
    const f = await boot(page);
    try {
      await selectOpen(page); f.failProjectSearch(true); await changes(page); await input(page).fill('Customer release');
      await expect(picker(page)).toContainText('Projects could not be searched'); f.failProjectSearch(false);
      await picker(page).getByRole('button', { name: 'Try again', exact: true }).click();
      await picker(page).getByRole('option', { name: 'Customer release · Recued', exact: true }).click(); f.failProjectReads('release', true);
      await (await changes(page)).getByRole('button', { name: 'Preview project assignment', exact: true }).click();
      await expect(preview(page).getByRole('alert')).toContainText('Project lookup interrupted');
      await expect(preview(page).getByRole('button', { name: 'Apply project changes', exact: true })).toBeDisabled(); expect(f.writes).toEqual([]);
      f.failProjectReads('release', false); await preview(page).getByRole('button', { name: 'Retry preview', exact: true }).click();
      await expect(preview(page)).toContainText('2 tasks will change'); await preview(page).getByRole('button', { name: 'Back to selection', exact: true }).click();
      await expect(selection(page)).toContainText('2 tasks selected'); await expect(input(page)).toHaveValue('Customer release · Recued');
      await picker(page).getByRole('button', { name: 'Clear selection', exact: true }).click();
      await expect(input(page)).toHaveValue(''); await expect((await changes(page)).getByRole('button', { name: 'Preview project assignment', exact: true })).toBeDisabled();
      await (await changes(page)).getByRole('button', { name: 'Preview removing project links', exact: true }).click();
      await expect(preview(page)).toContainText('1 task will change · 1 skipped');
      expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });
});

test.describe('reviewed task contact changes over native handlers', () => {
    type Fixture = Awaited<ReturnType<typeof installTaskBulkTriageFixture>>;
    const preview = (page: Page) => page.getByRole('region', { name: 'Task contact preview', exact: true });
    const picker = (page: Page) => page.locator('[data-ref-picker="task-bulk-contact"]');
    const input = (page: Page) => picker(page).getByRole('combobox');
    const boot = async (page: Page, prepare?: (f: Fixture) => void) => {
      const f = await installTaskBulkTriageFixture(page); prepare?.(f);
      await page.goto(`${HARNESS_URL}?journey=verification#data/task`); await page.waitForFunction(() => window.__app?.ready === true);
      await expect(page.getByRole('checkbox', { name: 'Select Prepare launch', exact: true })).toBeVisible(); return f;
    };
    const select = async (page: Page) => {
      await page.getByRole('checkbox', { name: 'Select Prepare launch', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Select Review proposal', exact: true }).check();
      await changes(page);
    };
    const choose = async (page: Page, query = 'Alex', label = 'Alex <img src=x> · alex@example.test') => {
      await changes(page); await input(page).fill(query); await picker(page).getByRole('option', { name: label, exact: true }).click();
      await expect(input(page)).toHaveValue(label);
    };
    const review = async (page: Page, remove = false) => {
      await (await changes(page)).getByRole('button', { name: remove ? 'Preview clearing assignments' : 'Preview contact assignment', exact: true }).click();
      await expect(preview(page).getByRole('button', { name: 'Apply contact changes', exact: true })).toBeEnabled();
    };
    const apply = async (page: Page) => preview(page).getByRole('button', { name: 'Apply contact changes', exact: true }).click();

    test('disambiguates contacts by email, reviews open and completed tasks, and applies only assignment by keyboard', async ({ page }, info) => {
      const f = await boot(page), before = f.read('open-a'), done = f.read('done-a');
      try {
        await select(page); await page.getByRole('checkbox', { name: 'Select Finished review', exact: true }).check();
        await changes(page); await input(page).fill('Riley'); await expect(picker(page).getByRole('option')).toHaveCount(2);
        await input(page).press('ArrowDown'); await input(page).press('Enter');
        await expect(input(page)).toHaveValue(/Riley · (person|other)@example.test/);
        await choose(page); await review(page); await expect(preview(page)).toBeFocused();
        await expect(preview(page)).toContainText('3 tasks will change · 0 skipped');
        await expect(preview(page)).toContainText('Riley · person@example.test → Alex <img src=x> · alex@example.test');
        await expect(preview(page).locator('img')).toHaveCount(0); expect(f.writes).toEqual([]);
        await page.screenshot({ path: info.outputPath('task-contact-preview-desktop.png'), fullPage: true });
        await preview(page).getByRole('button', { name: 'Back to selection', exact: true }).click();
        await expect(input(page)).toHaveValue('Alex <img src=x> · alex@example.test');
        await expect((await changes(page)).getByRole('button', { name: 'Preview contact assignment', exact: true })).toBeFocused();
        await input(page).focus(); await expect(picker(page).getByRole('option')).toHaveCount(1); await input(page).press('Escape');
        await review(page); await preview(page).getByRole('button', { name: 'Apply contact changes', exact: true }).focus(); await page.keyboard.press('Enter');
        await expect(results(page)).toContainText('3 confirmed · 0 failed · 0 waiting for confirmation · 0 skipped');
        expect(f.writes.map(row => row.args).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual(
          ['done-a', 'open-a', 'open-b'].map(id => ({ kind: 'task', id, assigned_contact_id: f.target.email })));
        expect(f.read('open-a')).toEqual({ ...before, assigned_contact_id: f.target.email, updated_at: before.updated_at + 1000, last_seen_at: before.last_seen_at + 1000 });
        expect(f.read('done-a')).toMatchObject({ done: true, completed_at: done.completed_at, due_at: done.due_at, assigned_contact_id: f.target.email });
      } finally { f.dispose(); }
    });

    test('previews clearing on a phone, skips empty assignments, and retains unrelated native task fields', async ({ page }, info) => {
      await page.setViewportSize({ width: 390, height: 844 }); const f = await boot(page), before = f.read('open-a');
      try {
        await select(page); await review(page, true); await expect(preview(page)).toContainText('1 task will change · 1 skipped');
        await expect(preview(page)).toContainText('Riley · person@example.test → No assigned contact');
        await expect(preview(page)).toContainText('Already has no assigned contact');
        await page.screenshot({ path: info.outputPath('task-contact-clear-phone.png'), fullPage: true }); await apply(page);
        await expect(results(page)).toContainText('1 confirmed · 0 failed · 0 waiting for confirmation · 1 skipped');
        expect(f.writes.map(row => row.args)).toEqual([{ kind: 'task', id: 'open-a', clear_assigned_contact: true }]);
        const { assigned_contact_id: _removed, ...other } = before;
        expect(f.read('open-a')).toEqual({ ...other, updated_at: before.updated_at + 1000, last_seen_at: before.last_seen_at + 1000 });
      } finally { f.dispose(); }
    });

    for (const remove of [false, true]) test(`reconciles native contact ${remove ? 'clearing' : 'assignment'} after lost and pending replies without repeating writes`, async ({ page }) => {
      const f = await boot(page, f => f.change('open-b', { assigned_contact_id: f.person.contact_id }));
      try {
        await select(page); if (!remove) await choose(page); await review(page, remove);
        f.fail('open-a', 'lost'); f.fail('open-b', 'pending'); await apply(page);
        await expect(results(page)).toContainText('0 confirmed · 1 failed · 1 waiting for confirmation');
        await results(page).getByRole('button', { name: 'Retry failed', exact: true }).click();
        await expect(results(page)).toContainText('1 confirmed · 0 failed · 1 waiting for confirmation');
        await results(page).getByRole('button', { name: 'Check unconfirmed', exact: true }).click();
        await expect(results(page)).toContainText('1 waiting for confirmation'); expect(f.writes).toHaveLength(2);
        f.confirm('open-b'); await results(page).getByRole('button', { name: 'Check unconfirmed', exact: true }).click();
        await expect(results(page)).toContainText('2 confirmed · 0 failed · 0 waiting for confirmation'); expect(f.writes).toHaveLength(2);
        expect(f.read('open-a').assigned_contact_id).toBe(remove ? undefined : f.target.email);
      } finally { f.dispose(); }
    });

    test('leaves changed assignments alone and rechecks the chosen contact identity before retrying', async ({ page }) => {
      const f = await boot(page);
      try {
        await select(page); await choose(page); await review(page);
        f.change('open-a', { assigned_contact_id: f.other.email }); f.fail('open-b', 'before'); await apply(page);
        await expect(results(page)).toContainText('0 confirmed · 1 failed · 0 waiting for confirmation · 1 skipped');
        await expect(results(page)).toContainText('assigned contact changed after the preview');
        f.contactReply(f.target.contact_id!, { ...f.target, contact_id: 'replacement-contact' });
        await results(page).getByRole('button', { name: 'Retry failed', exact: true }).click();
        await expect(results(page)).toContainText('assigned contact changed identity'); expect(f.writes).toHaveLength(1);
        expect(f.read('open-a').assigned_contact_id).toBe(f.other.email); expect(f.read('open-b').assigned_contact_id).toBeUndefined();
      } finally { f.dispose(); }
    });

    test('stops after the current contact write and retries only the remaining reviewed destination', async ({ page }) => {
      const f = await boot(page);
      try {
        await select(page); await choose(page); await review(page); f.hold('work_entity.upsert', 'open-a'); await apply(page);
        await expect.poll(f.waiting).toBe(true); await results(page).getByRole('button', { name: 'Stop after current task', exact: true }).click();
        f.release(); await expect(results(page)).toContainText('1 confirmed · 1 failed');
        await results(page).getByRole('button', { name: 'Retry failed', exact: true }).click(); await expect(results(page)).toContainText('2 confirmed · 0 failed');
        expect(f.writes.map(row => row.args)).toEqual(['open-a', 'open-b'].map(id => ({ kind: 'task', id, assigned_contact_id: f.target.email })));
      } finally { f.dispose(); }
    });

    test('recovers search and preview errors without accepting typed text or turning a missing contact into clearing', async ({ page }) => {
      const f = await boot(page);
      try {
        await select(page); f.failContactSearch(true); await changes(page); await input(page).fill('Alex');
        await expect(picker(page)).toContainText('Contact search interrupted');
        await expect((await changes(page)).getByRole('button', { name: 'Preview contact assignment', exact: true })).toBeDisabled();
        f.failContactSearch(false); await picker(page).getByRole('button', { name: 'Try again', exact: true }).click();
        await picker(page).getByRole('option', { name: 'Alex <img src=x> · alex@example.test', exact: true }).click();
        f.failContactReads(f.target.email, true); await (await changes(page)).getByRole('button', { name: 'Preview contact assignment', exact: true }).click();
        await expect(preview(page)).toContainText('Contact lookup interrupted'); await expect(preview(page).getByRole('button', { name: 'Apply contact changes', exact: true })).toBeDisabled();
        f.failContactReads(f.target.email, false); await preview(page).getByRole('button', { name: 'Retry preview', exact: true }).click();
        await expect(preview(page).getByRole('button', { name: 'Apply contact changes', exact: true })).toBeEnabled();
        await preview(page).getByRole('button', { name: 'Back to selection', exact: true }).click();
        await picker(page).getByRole('button', { name: 'Clear selection', exact: true }).click();
        await expect(input(page)).toHaveValue(''); await expect((await changes(page)).getByRole('button', { name: 'Preview contact assignment', exact: true })).toBeDisabled();
        expect(f.writes).toEqual([]);
      } finally { f.dispose(); }
    });

    test('retires delayed contact previews on Back and resets assignment selection when task search changes', async ({ page }) => {
      const f = await boot(page);
      try {
        await select(page); await choose(page); f.hold('contact.get', f.target.email);
        await (await changes(page)).getByRole('button', { name: 'Preview contact assignment', exact: true }).click(); await expect.poll(f.waiting).toBe(true);
        await expect(preview(page)).toContainText('Loading contact preview');
        await preview(page).getByRole('button', { name: 'Back to selection', exact: true }).click();
        await choose(page, 'Riley', 'Riley · other@example.test'); f.release(); await review(page); await expect(preview(page)).toContainText('Riley · other@example.test');
        await preview(page).getByRole('button', { name: 'Back to selection', exact: true }).click();
        await search(page).fill('Review proposal'); await expect(selection(page)).toContainText('Change tasks together');
        await page.getByRole('checkbox', { name: 'Select Review proposal', exact: true }).check(); await changes(page); await expect(input(page)).toHaveValue(''); expect(f.writes).toEqual([]);
      } finally { f.dispose(); }
    });
});
