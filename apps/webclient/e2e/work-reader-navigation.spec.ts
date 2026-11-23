import { expect, test, type Locator, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Kind = 'task' | 'note';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const body = 'Background context.\n\n'.repeat(45) + 'needle first\n\n' + 'More context.\n\n'.repeat(45) + 'needle last.';
const reader = (page: Page, kind: Kind) => page.locator(`.work-entity-${kind}-reader`);
const navigation = (page: Page, kind: Kind) => reader(page, kind).getByRole('navigation', { name: `Browse ${kind}s`, exact: true });
const next = (page: Page, kind: Kind) => navigation(page, kind).getByRole('button', { name: `Next ${kind}`, exact: true });
const previous = (page: Page, kind: Kind) => navigation(page, kind).getByRole('button', { name: `Previous ${kind}`, exact: true });
const rows = (page: Page, kind: Kind) => page.locator(`.work-entity-list-row-button[data-kind="${kind}"]`);
const row = (page: Page, kind: Kind, id: string) => page.locator(`.work-entity-list-row-button[data-kind="${kind}"][data-entity-id="${id}"]`);
const ids = (locator: Locator) => locator.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-entity-id')!));
const scrollPositions = (locator: Locator) => locator.evaluate(node => {
  const positions: number[] = []; let element: Element | null = node;
  while (element) { if (element.scrollHeight > element.clientHeight) positions.push(element.scrollTop); element = element.parentElement; }
  return positions;
});
const savedViewId = 'view_00000000-0000-4000-8000-000000000001';
const boot = async (page: Page, kind: Kind, options: { count?: number; search?: boolean; saved?: boolean; prepare?: (f: Fixture) => void } = {}) => {
  const f = await installTaskNoteSourceFixture(page);
  for (let index = 0; index < (options.count ?? 24); index++) {
    const id = `review-${String(index).padStart(3, '0')}`;
    f.seedTask(id, { title: `Review task ${index}`, body, due_at: Date.parse('2026-11-01T12:00:00Z') + index * 1000 });
    f.seedNote(id, { title: `Review note ${index}`, body, related_contact_ids: [f.person.contact_id!] });
  }
  options.prepare?.(f);
  if (options.saved) await page.addInitScript(({ id, kind }) => sessionStorage.setItem('recued-test-saved-data-views', JSON.stringify([
    { id, name: 'Review work', revision: 1, created_at: 1, updated_at: 2, definition: { tab: kind, query: 'Review', source_id: null, booking_lifecycle: 'all' } },
  ])), { id: savedViewId, kind });
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#${options.saved ? `views/${savedViewId}` : `data/${options.search ? 'search' : kind}`}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (options.search) {
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption(kind);
    await page.getByRole('searchbox', { name: 'Search everything', exact: true }).fill('needle');
    await expect(page.locator(`[data-work-search-group="${kind}"] [data-search-work-id]`)).toHaveCount(5);
  } else {
    if (!options.saved) await page.getByRole('searchbox', { name: `Search ${kind}s`, exact: true }).fill('Review');
    await expect(rows(page, kind)).toHaveCount(Math.min(options.count ?? 24, 100));
  }
  return f;
};
const opened = (page: Page, kind: Kind, id: string) => expect(reader(page, kind)).toHaveAttribute(`data-${kind}-id`, id);
const waitForRead = (page: Page, id: string) => page.waitForFunction(id =>
  (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.includes(`work_entity.get:${id}`), id);

for (const kind of ['task', 'note'] as const) {
  test(`${kind} reader follows the list order, keeps keyboard focus, and returns to its last row and scroll`, async ({ page }, info) => {
    const f = await boot(page, kind);
    try {
      const order = await ids(rows(page, kind)), first = row(page, kind, order[9]!), second = row(page, kind, order[10]!);
      await first.scrollIntoViewIfNeeded(); const scroll = await scrollPositions(first); expect(scroll.some(top => top > 100)).toBe(true);
      await first.click(); await opened(page, kind, order[9]!); await expect(navigation(page, kind)).toContainText('10 of 24 loaded');
      await reader(page, kind).getByRole('button', { name: `Find in ${kind}`, exact: true }).click();
      await reader(page, kind).getByRole('searchbox', { name: `Find in this ${kind}`, exact: true }).fill('needle');
      await next(page, kind).focus(); await next(page, kind).press('Enter'); await opened(page, kind, order[10]!); await expect(next(page, kind)).toBeFocused();
      await expect(reader(page, kind).getByRole('searchbox', { name: `Find in this ${kind}`, exact: true })).toHaveValue('needle');
      await expect(reader(page, kind).locator(`[data-${kind}-find-current]`)).toBeInViewport();
      await previous(page, kind).click(); await opened(page, kind, order[9]!);
      await next(page, kind).click(); await opened(page, kind, order[10]!);
      await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: info.outputPath(`${kind}-reader-navigation-phone.png`), fullPage: true });
      await reader(page, kind).getByRole('button', { name: `Back to ${kind}s`, exact: true }).click();
      await expect(second).toBeFocused(); await expect(second).toBeInViewport();
      expect(await scrollPositions(second)).toEqual(scroll); await expect(page.getByRole('searchbox', { name: `Search ${kind}s`, exact: true })).toHaveValue('Review');
      await row(page, kind, order.at(-1)!).click(); await opened(page, kind, order.at(-1)!); await expect(next(page, kind)).toBeDisabled();
      await previous(page, kind).click(); await opened(page, kind, order.at(-2)!);
      expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });

  test(`${kind} navigation pages the selected source and retries a failed page without losing its reader`, async ({ page }) => {
    const f = await boot(page, kind, { count: 125, prepare: f => {
      f.registerSource(`other.${kind}`, kind);
      if (kind === 'task') f.seedTask('outside', { source_id: 'other.task', title: 'Review outside source' });
      else f.seedNote('outside', { source_id: 'other.note', title: 'Review outside source', body });
    } });
    try {
      await page.getByRole('combobox', { name: 'Source', exact: true }).selectOption(`recued.${kind}`);
      await page.getByRole('searchbox', { name: `Search ${kind}s`, exact: true }).fill('Review');
      await expect.poll(() => f.queries.filter(call => call.method === 'work_entity.list' && call.args.kind === kind && call.args.source_id === `recued.${kind}`
        && (kind === 'note' || call.args.search === 'Review')).length).toBeGreaterThan(0);
      await expect(rows(page, kind)).toHaveCount(100); await expect(row(page, kind, 'outside')).toHaveCount(0);
      const order = await ids(rows(page, kind)), anchor = order.at(-1)!;
      await row(page, kind, anchor).click(); await opened(page, kind, anchor);
      f.fail('work_entity.list', ''); await next(page, kind).click();
      await expect(navigation(page, kind).getByRole('alert')).toContainText('interrupted'); await opened(page, kind, anchor);
      f.fail('work_entity.list', '', false); await next(page, kind).click();
      await expect(navigation(page, kind)).toContainText('101 of 125 loaded');
      const target = (await ids(rows(page, kind)))[100]!; await opened(page, kind, target);
      const pages = f.queries.filter(call => call.method === 'work_entity.list' && call.args.kind === kind && call.args.offset === 100);
      expect(pages).toHaveLength(2); expect(pages[0]!.args).toEqual(pages[1]!.args); expect(pages[1]!.args.source_id).toBe(`recued.${kind}`);
      if (kind === 'task') expect(pages[1]!.args.search).toBe('Review');
      await previous(page, kind).click(); await opened(page, kind, anchor); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });

  test(`a failed ${kind} neighbor read preserves the current record and retries the same freshly read target`, async ({ page }) => {
    const f = await boot(page, kind, { count: 6 });
    try {
      const order = await ids(rows(page, kind)); await row(page, kind, order[0]!).click(); await opened(page, kind, order[0]!);
      await expect(previous(page, kind)).toBeDisabled(); f.fail('work_entity.get', order[1]!); await next(page, kind).click();
      await expect(navigation(page, kind).getByRole('alert')).toContainText('interrupted'); await opened(page, kind, order[0]!);
      f.fail('work_entity.get', order[1]!, false);
      if (kind === 'task') f.updateTask(order[1]!, { title: 'Freshly read task target' }); else f.updateNote(order[1]!, { title: 'Freshly read note target' });
      await next(page, kind).click(); await opened(page, kind, order[1]!);
      await expect(reader(page, kind).getByRole('heading', { name: `Freshly read ${kind} target`, exact: true })).toBeVisible();
      expect(f.queries.filter(call => call.method === 'work_entity.get' && call.args.id === order[1]).map(call => call.args.kind)).toEqual([kind, kind]); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });

  test(`${kind} search navigation loads the next result page, retains Find and the type filter, and returns to the last hit`, async ({ page }, info) => {
    const f = await boot(page, kind, { count: 16, search: true });
    try {
      const results = page.locator(`[data-work-search-group="${kind}"] [data-search-work-id]`);
      await results.first().click(); await expect(navigation(page, kind)).toContainText('1 of 5+ loaded');
      for (let index = 0; index < 5; index++) {
        await next(page, kind).click(); await expect(navigation(page, kind)).toContainText(`${index + 2} of`);
        await expect(reader(page, kind).getByRole('searchbox', { name: `Find in this ${kind}`, exact: true })).toHaveValue('needle');
        await expect(reader(page, kind).locator(`[data-${kind}-find-current]`)).toBeInViewport();
      }
      await expect(navigation(page, kind)).toContainText('6 of 15+ loaded');
      const selected = await reader(page, kind).getAttribute(`data-${kind}-id`);
      expect(f.queries.filter(call => call.method === 'work_entity.search' && call.args.kind === kind && call.args.offset === 5).map(call => call.args.query)).toEqual(['needle']);
      await page.screenshot({ path: info.outputPath(`${kind}-search-navigation-phone.png`), fullPage: true });
      await reader(page, kind).getByRole('button', { name: 'Back to search', exact: true }).click();
      await expect(page.getByRole('searchbox', { name: 'Search everything', exact: true })).toHaveValue('needle');
      await expect(page.getByRole('combobox', { name: 'Result type', exact: true })).toHaveValue(kind);
      await expect(page.locator(`[data-work-search-group="${kind}"] [data-search-work-id="${selected}"]`)).toBeFocused(); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });

  test(`${kind} navigation survives a related source or contact visit`, async ({ page }) => {
    const f = await boot(page, kind, { count: 6 });
    try {
      const order = await ids(rows(page, kind));
      if (kind === 'task') f.updateTask(order[0]!, { body: body + '\n' + HARNESS_URL + serializeSourceRecordAddress(f.source('mail')) });
      await row(page, kind, order[0]!).click(); await opened(page, kind, order[0]!);
      if (kind === 'task') {
        await reader(page, kind).locator('a[href*="#data/mail/record/"]').click();
        await page.getByRole('button', { name: 'Back to task', exact: true }).click();
      } else {
        await reader(page, kind).locator('[data-note-section="related"] summary').click();
        await reader(page, kind).getByRole('button', { name: 'Open contact Riley <img src=x>', exact: true }).click();
        await page.getByRole('button', { name: '← Back to note', exact: true }).click();
      }
      await expect(navigation(page, kind)).toContainText('1 of 6 loaded'); await next(page, kind).click(); await opened(page, kind, order[1]!); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });

  test(`a ${kind} opened directly does not offer navigation through an unrelated list`, async ({ page }) => {
    const f = await boot(page, kind, { count: 6 });
    try {
      const order = await ids(rows(page, kind)); await page.evaluate(({ kind, id }) => window.__app.setHash(`#data/${kind}/${id}`), { kind, id: order[0]! });
      await opened(page, kind, order[0]!); await expect(navigation(page, kind)).toHaveCount(0); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });
}

test('completion holds task navigation and retains the original next task after the current one leaves Open', async ({ page }) => {
  const f = await boot(page, 'task', { count: 6 });
  try {
    await page.getByRole('button', { name: 'Task filters', exact: true }).click();
    await page.getByLabel('Task status', { exact: true }).selectOption('open'); await page.getByLabel('Sort tasks', { exact: true }).selectOption('due_asc');
    await expect(rows(page, 'task')).toHaveCount(6); const order = await ids(rows(page, 'task'));
    await row(page, 'task', order[0]!).click(); await opened(page, 'task', order[0]!);
    f.hold('work_entity.task.mark_done', order[0]!); await reader(page, 'task').getByRole('button', { name: 'Complete', exact: true }).click();
    await expect.poll(() => f.waiting()).toBe(true); await expect(next(page, 'task')).toBeDisabled();
    await next(page, 'task').evaluate(node => (node as HTMLButtonElement).click()); await opened(page, 'task', order[0]!);
    f.release(); await expect(reader(page, 'task').locator('[data-task-completion-status]')).toHaveText('Task completed.'); await expect(next(page, 'task')).toBeEnabled();
    await next(page, 'task').click(); await opened(page, 'task', order[1]!);
    expect(f.writes).toEqual([{ method: 'work_entity.task.mark_done', args: { id: order[0], done: true } }]);
  } finally { f.dispose(); }
});

test('note edits keep their reader order and navigation never writes unchanged note text', async ({ page }) => {
  const f = await boot(page, 'note', { count: 6 });
  try {
    const order = await ids(rows(page, 'note')), original = f.note(order[0]!);
    await row(page, 'note', order[0]!).click(); await reader(page, 'note').getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('.work-entity-dialog[data-kind="note"][data-mode="edit"]'); await expect(navigation(page, 'note')).toHaveCount(0);
    await editor.getByLabel('Title', { exact: true }).fill('Review note revised'); await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(navigation(page, 'note')).toContainText('1 of 6 loaded'); await next(page, 'note').click(); await opened(page, 'note', order[1]!);
    await previous(page, 'note').click(); await opened(page, 'note', order[0]!);
    await expect(reader(page, 'note').getByRole('heading', { name: 'Review note revised', exact: true })).toBeVisible();
    expect(f.note(order[0]!).body).toBe(original.body); expect(f.writes).toEqual([{ method: 'work_entity.upsert', args: { kind: 'note', id: order[0], title: 'Review note revised' } }]);
  } finally { f.dispose(); }
});

test('closing during a held neighboring read prevents its late response from opening a record', async ({ page }) => {
  const f = await boot(page, 'task', { count: 6 });
  try {
    const order = await ids(rows(page, 'task')); await row(page, 'task', order[0]!).click(); await opened(page, 'task', order[0]!);
    f.hold('work_entity.get', order[1]!); await next(page, 'task').click(); await expect.poll(() => f.waiting()).toBe(true);
    await opened(page, 'task', order[0]!); await reader(page, 'task').getByRole('button', { name: 'Back to tasks', exact: true }).click();
    f.release(); await waitForRead(page, order[1]!); await expect(reader(page, 'task')).toHaveCount(0); await expect(row(page, 'task', order[0]!)).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a dependency visit has no list controls and returning restores the parent navigation', async ({ page }) => {
  const f = await boot(page, 'task', { count: 6 });
  try {
    const order = await ids(rows(page, 'task')); f.updateTask(order[0]!, { blocks_task_ids: [order[1]!] });
    await row(page, 'task', order[0]!).click(); await opened(page, 'task', order[0]!);
    await reader(page, 'task').getByRole('button', { name: `Open task ${f.task(order[1]!).title}`, exact: true }).click();
    await opened(page, 'task', order[1]!); await expect(navigation(page, 'task')).toHaveCount(0);
    await reader(page, 'task').getByRole('button', { name: 'Back to task', exact: true }).click();
    await expect(navigation(page, 'task')).toContainText('1 of 6 loaded'); await next(page, 'task').click(); await opened(page, 'task', order[1]!); await expect(navigation(page, 'task')).toContainText('2 of 6 loaded'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('browser Back after Next returns to the last note row and keeps the list search', async ({ page }) => {
  const f = await boot(page, 'note', { count: 6 });
  try {
    const order = await ids(rows(page, 'note')); await row(page, 'note', order[0]!).click(); await opened(page, 'note', order[0]!);
    await next(page, 'note').click(); await opened(page, 'note', order[1]!); await page.goBack();
    await expect(reader(page, 'note')).toHaveCount(0); await expect(row(page, 'note', order[1]!)).toBeFocused();
    await expect(page.getByRole('searchbox', { name: 'Search notes', exact: true })).toHaveValue('Review'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a removed neighboring note leaves the current reader available with a clear error', async ({ page }) => {
  const f = await boot(page, 'note', { count: 6 });
  try {
    const order = await ids(rows(page, 'note')); await row(page, 'note', order[0]!).click(); await opened(page, 'note', order[0]!);
    f.removeNote(order[1]!); await next(page, 'note').click();
    await expect(navigation(page, 'note').getByRole('alert')).toContainText('no longer available'); await opened(page, 'note', order[0]!); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a task that moved to another source is not opened from the selected source reader', async ({ page }) => {
  const f = await boot(page, 'task', { count: 6, prepare: f => f.registerSource('other.task', 'task') });
  try {
    await page.getByRole('combobox', { name: 'Source', exact: true }).selectOption('recued.task');
    await page.getByRole('searchbox', { name: 'Search tasks', exact: true }).fill('Review'); await expect(rows(page, 'task')).toHaveCount(6);
    const order = await ids(rows(page, 'task')); await row(page, 'task', order[0]!).click(); await opened(page, 'task', order[0]!);
    f.updateTask(order[1]!, { source_id: 'other.task' }); await next(page, 'task').click();
    await expect(navigation(page, 'task').getByRole('alert')).toContainText('no longer in the selected source'); await opened(page, 'task', order[0]!); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['task', 'note'] as const) test(`saved-view ${kind} readers return to their last row and allow a separate collection jump`, async ({ page }) => {
  const f = await boot(page, kind, { count: 6, saved: true });
  try {
    await expect(page).toHaveURL(new RegExp(`#views/${savedViewId}$`));
    const order = await ids(rows(page, kind)); await row(page, kind, order[0]!).click(); await opened(page, kind, order[0]!);
    await next(page, kind).click(); await opened(page, kind, order[1]!); await page.goBack();
    await expect(page).toHaveURL(new RegExp(`#views/${savedViewId}$`)); await expect(row(page, kind, order[1]!)).toBeFocused();
    await row(page, kind, order[1]!).click(); await opened(page, kind, order[1]!);
    await page.evaluate(kind => window.__app.setHash(`#data/${kind}`), kind);
    await expect(page).toHaveURL(new RegExp(`#data/${kind}$`)); await expect(reader(page, kind)).toHaveCount(0);
    await expect(page.getByRole('searchbox', { name: `Search ${kind}s`, exact: true })).toHaveValue(''); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
