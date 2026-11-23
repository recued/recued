import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Kind = 'task' | 'note';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
type CopyMode = 'ok' | 'deny' | 'hold' | 'legacy' | 'manual';
declare global { interface Window { __workCopy: { copies: string[]; legacy: string[]; mode: CopyMode; success: boolean; settled: number; release: () => void } } }
const reader = (page: Page, kind: Kind = 'task') => page.locator(`.work-entity-${kind}-reader`);
const copyLink = (page: Page, kind: Kind = 'task') => reader(page, kind).locator('[data-action="work-copy-link"]');
const details = (page: Page) => reader(page).locator('[data-action="work-copy-details"]');
const copies = (page: Page) => page.evaluate(() => window.__workCopy.copies);
const clipboard = async (page: Page, mode: CopyMode) => page.addInitScript(mode => {
  const state = { copies: [] as string[], legacy: [] as string[], mode, success: true, settled: 0, release: () => {} };
  window.__workCopy = state;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'legacy' || mode === 'manual' ? undefined : { writeText: async (value: string) => {
    state.copies.push(value);
    try {
      if (state.mode === 'hold') await new Promise<void>(done => { state.release = done; });
      if (state.mode === 'deny' || !state.success) throw new Error('Clipboard unavailable');
    } finally { state.settled++; }
  } } });
  document.execCommand = command => {
    if (command !== 'copy') return false;
    state.legacy.push((document.activeElement as HTMLTextAreaElement)?.value ?? ''); return state.mode === 'legacy';
  };
}, mode);
const boot = async (page: Page, options: { kind?: Kind; hash?: string; mode?: CopyMode; prepare?: (f: Fixture) => void } = {}) => {
  const f = await installTaskNoteSourceFixture(page);
  f.seedNote('note-one', { title: 'Copy note one', body: 'Saved <script>note</script> 二' });
  f.seedNote('note-two', { title: 'Copy note two', body: 'Another saved note.' });
  options.prepare?.(f); await clipboard(page, options.mode ?? 'ok');
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple${options.hash ?? `#data/${options.kind ?? 'task'}/${options.kind === 'note' ? 'note-one' : 'task-one'}`}`);
  await page.waitForFunction(() => window.__app?.ready === true); return f;
};
const release = async (page: Page, success = false) => {
  await page.evaluate(success => { window.__workCopy.success = success; window.__workCopy.release(); }, success);
  await page.waitForFunction(() => window.__workCopy.settled > 0);
};

for (const due of ['2026-11-01T00:00:00Z', '2026-11-01T08:30:12.345Z']) test(`copies saved task details with the displayed deadline ${due}`, async ({ page }) => {
  const f = await boot(page, { prepare: f => f.update({ due_at: Date.parse(due), priority: 'high' }) });
  try {
    const saved = f.task(), dueLabel = await reader(page).locator('dt').filter({ hasText: /^Due date$/ }).locator('..').locator('dd').innerText();
    await details(page).focus(); await details(page).press('Enter'); await expect(reader(page).locator('[data-work-copy-notice]')).toHaveText('Task details copied.');
    expect(await copies(page)).toEqual([`${saved.title}\nStatus: Open\nDue date: ${dueLabel}\nPriority: High\n\n${saved.body}`]);
    await expect(details(page)).toBeFocused(); expect(f.task()).toEqual(saved); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const source of ['read-only', 'stale', 'pending'] as const) test(`allows copying the saved ${source} task and carries source uncertainty`, async ({ page }) => {
  const f = await boot(page, { prepare: f => {
    if (source === 'read-only') f.writable(false);
    if (source === 'stale') f.update({ sync_state: 'stale_unreachable' });
    if (source === 'pending') f.update({ pending_write: { staged_at: Date.now(), operation: 'update', dirty_fields: ['title'], state: 'awaiting_verify' } });
  } });
  try {
    await details(page).click(); await expect(reader(page).locator('[data-work-copy-notice]')).toHaveText('Task details copied.');
    const value = (await copies(page))[0]!;
    if (source === 'stale') expect(value).toContain('Source status: This source cannot be reached. The task may be out of date.');
    if (source === 'pending') expect(value).toContain('Source status: A change is waiting for source confirmation.');
    await expect(reader(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('clipboard rejection offers escaped task text and preserves manual selection through a label repaint', async ({ page }, info) => {
  const f = await boot(page, { mode: 'deny', prepare: f => { f.hold('work_entity.get', 'project-one'); f.update({ body: 'needle <img src=x>\n</textarea><script>raw</script>' }); } });
  try {
    await expect.poll(() => f.waiting()).toBe(true); await details(page).click();
    const input = reader(page).getByRole('textbox', { name: 'Task details to copy', exact: true });
    await expect(input).toHaveValue((await copies(page))[0]!); await expect(input).toBeFocused(); await expect(input).toHaveAttribute('readonly', '');
    expect(await input.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([0, (await input.inputValue()).length]);
    await expect(reader(page).locator('img,script')).toHaveCount(0);
    await input.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 8, 'backward'));
    f.release(); await expect(reader(page).getByRole('button', { name: 'Open project Launch <img src=x> project', exact: true })).toBeVisible();
    await expect(input).toBeFocused(); expect(await input.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([2, 8, 'backward']);
    await reader(page).getByRole('button', { name: 'Find in task', exact: true }).click();
    await reader(page).getByRole('searchbox', { name: 'Find in this task', exact: true }).fill('needle');
    await expect(reader(page).locator('[data-task-find-status]')).toHaveText('1 of 1 matches.');
    await reader(page).getByRole('button', { name: 'Select task details', exact: true }).click(); await expect(input).toBeFocused();
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: info.outputPath('copy-task-details-manual-phone.png'), fullPage: true });
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const mode of ['legacy', 'manual'] as const) test(`uses the ${mode} fallback when the clipboard API is absent`, async ({ page }) => {
  const f = await boot(page, { mode });
  try {
    await copyLink(page).focus(); await copyLink(page).press('Enter');
    const expected = HARNESS_URL.split('?')[0].split('#')[0] + '#data/task/task-one';
    expect(await page.evaluate(() => window.__workCopy.legacy)).toEqual([expected]);
    if (mode === 'legacy') { await expect(reader(page).locator('[data-work-copy-notice]')).toHaveText('Link copied.'); await expect(copyLink(page)).toBeFocused(); }
    else { const input = reader(page).getByRole('textbox', { name: 'Link to this task', exact: true }); await expect(input).toHaveValue(expected); await expect(input).toBeFocused(); }
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['task', 'note'] as const) for (const origin of ['search', 'saved view'] as const) test(`copies the exact ${kind} link from ${origin} with an opaque record ID`, async ({ page }) => {
  const id = "shared/id?二.)!'*", viewId = 'view_00000000-0000-4000-8000-000000000001';
  if (origin === 'saved view') await page.addInitScript(({ id, kind }) => sessionStorage.setItem('recued-test-saved-data-views', JSON.stringify([
    { id, name: 'Copy review', revision: 1, created_at: 1, updated_at: 2, definition: { tab: kind, query: 'Review', source_id: null, booking_lifecycle: 'all' } },
  ])), { id: viewId, kind });
  const f = await boot(page, { kind, hash: origin === 'search' ? '#data/search' : `#views/${viewId}`, prepare: f => {
    if (kind === 'task') f.seedTask(id, { title: 'Review copy target needle', body: 'Exact saved task.' });
    else f.seedNote(id, { title: 'Review copy target needle', body: 'Exact saved note.' });
  } });
  try {
    if (origin === 'search') {
      await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption(kind);
      await page.getByRole('searchbox', { name: 'Search everything', exact: true }).fill('copy target needle');
      await page.locator(`[data-work-search-group="${kind}"] [data-search-work-id]`).click();
    } else await page.locator(`.work-entity-list-row-button[data-kind="${kind}"]`).filter({ hasText: 'Review copy target needle' }).click();
    await expect(reader(page, kind)).toHaveAttribute(`data-${kind}-id`, id); await copyLink(page, kind).click();
    const notice = reader(page, kind).locator(kind === 'task' ? '[data-work-copy-notice]' : '[data-note-notice]'); await expect(notice).toHaveText('Link copied.');
    const expected = HARNESS_URL.split('?')[0].split('#')[0] + serializeShellRoute('data', kind, id); expect(await copies(page)).toEqual([expected]);
    await reader(page, kind).getByRole('button', { name: origin === 'search' ? 'Back to search' : `Back to ${kind}s`, exact: true }).click();
    if (origin === 'saved view') await expect(page).toHaveURL(new RegExp(`#views/${viewId}$`));
    else await expect(page.getByRole('searchbox', { name: 'Search everything', exact: true })).toHaveValue('copy target needle');
    await page.evaluate(hash => window.__app.setHash(hash), new URL(expected).hash); await expect(reader(page, kind)).toHaveAttribute(`data-${kind}-id`, id);
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('coordinates note body and link copies and leaves the saved note unchanged', async ({ page }) => {
  const f = await boot(page, { kind: 'note', mode: 'hold' });
  try {
    const saved = f.note(); await reader(page, 'note').getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(copyLink(page, 'note')).toHaveAttribute('aria-disabled', 'true'); await copyLink(page, 'note').evaluate((node: HTMLButtonElement) => node.click());
    expect(await copies(page)).toEqual([saved.body]); await release(page, true); await expect(reader(page, 'note').locator('[data-note-notice]')).toHaveText('Note text copied.');
    await page.evaluate(() => { window.__workCopy.mode = 'ok'; }); await copyLink(page, 'note').click();
    await expect(reader(page, 'note').locator('[data-note-notice]')).toHaveText('Link copied.');
    expect(await copies(page)).toEqual([saved.body, HARNESS_URL.split('?')[0].split('#')[0] + '#data/note/note-one']); expect(f.note()).toEqual(saved); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['task', 'note'] as const) test(`late ${kind} copy failures cannot replace a neighboring reader result`, async ({ page }) => {
  const f = await boot(page, { kind, mode: 'hold', hash: `#data/${kind}` });
  try {
    await page.locator(`.work-entity-list-row-button[data-kind="${kind}"]`).first().click(); await copyLink(page, kind).click();
    await copyLink(page, kind).evaluate((node: HTMLButtonElement) => node.click()); expect(await copies(page)).toHaveLength(1);
    await reader(page, kind).getByRole('button', { name: `Next ${kind}`, exact: true }).click();
    const id = await reader(page, kind).getAttribute(`data-${kind}-id`);
    await page.evaluate(() => { window.__workCopy.mode = 'ok'; }); await copyLink(page, kind).click();
    await expect(reader(page, kind).locator(kind === 'task' ? '[data-work-copy-notice]' : '[data-note-notice]')).toHaveText('Link copied.');
    await release(page); await expect(copyLink(page, kind)).toBeFocused(); await expect(reader(page, kind).locator('[data-work-copy-value]')).toHaveCount(0);
    expect((await copies(page))[1]).toBe(HARNESS_URL.split('?')[0].split('#')[0] + serializeShellRoute('data', kind, id!)); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a late task copy cannot insert saved details into its editor', async ({ page }) => {
  const f = await boot(page, { mode: 'hold' });
  try {
    await details(page).click(); await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('.work-entity-dialog[data-kind="task"][data-mode="edit"]'); await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('Unsaved title');
    await release(page); await expect(editor.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Unsaved title'); await expect(editor.locator('[data-work-copy-value],[data-action^="work-copy-"]')).toHaveCount(0);
    expect(f.task().title).not.toBe('Unsaved title'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('closing a note reader fences its late link failure and preserves the list focus', async ({ page }) => {
  const f = await boot(page, { kind: 'note', hash: '#data/note', mode: 'hold' });
  try {
    const row = page.locator('.work-entity-list-row-button[data-kind="note"]').first();
    await row.click(); await copyLink(page, 'note').click(); await reader(page, 'note').getByRole('button', { name: 'Back to notes', exact: true }).click();
    await release(page); await expect(reader(page, 'note')).toHaveCount(0); await expect(row).toBeFocused();
    await row.click(); await expect(reader(page, 'note').locator('[data-note-notice],[data-work-copy-value]')).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a source visit clears the pending copy without stealing focus after returning', async ({ page }) => {
  const f = await boot(page, { mode: 'hold', prepare: f => f.update({ body: HARNESS_URL.split('?')[0].split('#')[0] + serializeSourceRecordAddress(f.source('mail')) }) });
  try {
    await details(page).click(); await reader(page).locator('a[data-task-note-link]').click(); await expect(page.getByRole('article', { name: 'Email message', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to task', exact: true }).click(); await release(page);
    await expect(reader(page).locator('a[data-task-note-link]')).toBeFocused(); await expect(reader(page).locator('[data-work-copy-value],[data-work-copy-notice]')).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('finishing a copy keeps the user in Find when focus has moved', async ({ page }) => {
  const f = await boot(page, { mode: 'hold' });
  try {
    await details(page).click(); await reader(page).getByRole('button', { name: 'Find in task', exact: true }).click();
    const find = reader(page).getByRole('searchbox', { name: 'Find in this task', exact: true }); await find.fill('launch'); await release(page);
    await expect(find).toBeFocused(); await expect(find).toHaveValue('launch'); await expect(reader(page).getByRole('textbox', { name: 'Task details to copy', exact: true })).toBeVisible(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
