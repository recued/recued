import { expect, test, type Page } from '@playwright/test';
import type { SourceRegistration, WorkEntity } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

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
const search = (page: Page) => page.locator('[data-action="search-work-entities"][data-kind="task"]');
const more = (page: Page) => page.getByRole('button', { name: 'Load more', exact: true });

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
  await selection(page).getByLabel('Due date', { exact: true }).fill('2030-11-05');
  await page.locator('.work-entity-page').screenshot({ path: testInfo.outputPath('task-selection-desktop.png') });
  await selection(page).getByRole('button', { name: 'Set due date', exact: true }).click();
  await expect(results(page)).toContainText('4 confirmed · 0 failed');
  await expect(results(page)).toBeFocused();
  expect(await page.evaluate(() => window.__taskBatch.writes.map(row => row.args))).toEqual(
    ['a', 'b', 'c', 'd'].map(id => ({ kind: 'task', id, due_at: Date.UTC(2030, 10, 5) })));
  await expect(page.locator('.work-entity-list-row').first()).toContainText('Due 2030-11-05');
  await results(page).getByRole('button', { name: 'Start another selection', exact: true }).click();
  await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
  await selection(page).getByRole('button', { name: 'Clear due dates', exact: true }).click();
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
  await selection(page).getByRole('button', { name: 'Clear due dates', exact: true }).click();
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
