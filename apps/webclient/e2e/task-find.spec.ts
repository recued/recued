import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const reader = (page: Page) => page.locator('.work-entity-task-reader');
const field = (page: Page) => reader(page).getByRole('searchbox', { name: 'Find in this task', exact: true });
const status = (page: Page) => reader(page).locator('[data-task-find-status]');
const trigger = (page: Page) => reader(page).getByRole('button', { name: 'Find in task', exact: true });
const notes = (page: Page) => reader(page).locator('[data-task-find-body]');
const gap = '\n\nA paragraph with the saved task context. '.repeat(45);
const sourceUrl = (f: Fixture, kind: 'mail' | 'calendar') => HARNESS_URL + serializeSourceRecordAddress(f.source(kind));
const boot = async (page: Page, prepare?: (f: Fixture) => void) => {
  const f = await installTaskNoteSourceFixture(page);
  f.update({ title: 'Find this task', body: `needle first${gap}\nneedle last\nEmail: ${sourceUrl(f, 'mail')}\nEvent: ${sourceUrl(f, 'calendar')}` }); prepare?.(f);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/task/task-one`);
  await page.waitForFunction(() => window.__app?.ready === true); await expect(reader(page)).toBeVisible(); return f;
};
const find = async (page: Page, query = 'needle') => { await trigger(page).click(); await field(page).fill(query); };
const back = (page: Page) => page.getByRole('button', { name: 'Back to task', exact: true });

test('finds title and notes, cycles matches from the keyboard, and closes Find before the task', async ({ page }, info) => {
  const f = await boot(page, f => f.update({ title: 'Needle in the title' }));
  try {
    await trigger(page).focus(); await trigger(page).press('Control+f'); await expect(field(page)).toBeFocused();
    await field(page).fill('needle'); await expect(status(page)).toHaveText('1 of 3 matches.');
    await expect(reader(page).locator('h2 mark[data-task-find-current]')).toHaveText('Needle');
    await field(page).press('Enter'); await expect(status(page)).toHaveText('2 of 3 matches.');
    await field(page).press('Shift+Enter'); await expect(status(page)).toHaveText('1 of 3 matches.');
    await field(page).press('Shift+Enter'); await expect(status(page)).toHaveText('3 of 3 matches.'); await expect(reader(page).locator('[data-task-find-current]')).toBeInViewport();
    const next = reader(page).getByRole('button', { name: 'Next match', exact: true }); await next.click(); await expect(next).toBeFocused(); await expect(status(page)).toHaveText('1 of 3 matches.');
    await reader(page).getByRole('button', { name: 'Previous match', exact: true }).click(); await expect(status(page)).toHaveText('3 of 3 matches.');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: info.outputPath('task-find-phone-dark.png'), fullPage: true });
    await field(page).fill('Riley'); await expect(status(page)).toHaveText('No matches.'); await expect(next).toBeDisabled();
    await expect(reader(page).getByRole('button', { name: 'Previous match', exact: true })).toBeDisabled();
    await field(page).press('Escape'); await expect(field(page)).toHaveCount(0); await expect(trigger(page)).toBeFocused();
    await trigger(page).press('Meta+f'); await expect(field(page)).toBeFocused(); await expect(field(page)).toHaveValue('Riley');
    await field(page).press('Escape'); await trigger(page).press('Escape'); await expect(reader(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('matches literal Unicode and punctuation without interpreting markup or searching link attributes', async ({ page }) => {
  const f = await boot(page, f => f.update({ title: 'Literal task', body: 'Use [a.*] then [A.*]. 😀 Café CAFÉ. <img src=x>\nhttps://example.test/needle-target' })), original = f.task();
  try {
    await find(page, '[a.*]'); await expect(status(page)).toHaveText('1 of 2 matches.');
    await field(page).fill('😀'); await expect(status(page)).toHaveText('1 of 1 matches.');
    await field(page).fill('café'); await expect(status(page)).toHaveText('1 of 2 matches.');
    await field(page).fill('<img'); await expect(status(page)).toHaveText('1 of 1 matches.'); await expect(notes(page).locator('img,script')).toHaveCount(0);
    await field(page).fill('note-link'); await expect(status(page)).toHaveText('No matches.');
    await expect(notes(page).getByRole('link')).toHaveAttribute('href', 'https://example.test/needle-target');
    await field(page).press('Escape'); await expect(reader(page).locator('mark[data-task-find-match]')).toHaveCount(0);
    expect(f.task()).toEqual(original); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('finds a task title even when there are no notes', async ({ page }) => {
  const f = await boot(page, f => f.update({ title: 'A title-only needle', body: '' }));
  try { await find(page); await expect(status(page)).toHaveText('1 of 1 matches.'); await expect(notes(page)).toHaveCount(0); expect(f.writes).toEqual([]); }
  finally { f.dispose(); }
});

for (const kind of ['mail', 'calendar'] as const) test(`keeps the query and current match through an exact ${kind} source visit`, async ({ page }) => {
  const f = await boot(page), original = f.task();
  try {
    await find(page); await field(page).press('Enter'); await expect(status(page)).toHaveText('2 of 2 matches.');
    const link = notes(page).locator(`a[href*="#data/${kind}/record/"]`), href = await link.getAttribute('href');
    // A query can highlight the link text while its exact destination remains intact.
    await field(page).fill(kind === 'mail' ? 'message' : 'shared-uid');
    await expect(link).toHaveAttribute('href', href!); await expect(link.locator('mark')).toHaveCount(1);
    await field(page).fill('needle'); await field(page).press('Enter'); await link.click(); await expect(back(page)).toBeVisible();
    if (kind === 'mail') await expect(page.getByRole('article', { name: 'Email message', exact: true })).toContainText('Exact work email body.');
    else await expect(page.locator('.calendar-event')).toContainText('Exact work occurrence');
    await back(page).click(); await expect(field(page)).toHaveValue('needle'); await expect(status(page)).toHaveText('2 of 2 matches.'); await expect(link).toBeFocused();
    expect(f.task()).toEqual(original); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('nested dependency readers keep separate search states and restore each current match', async ({ page }) => {
  const f = await boot(page, f => {
    f.update({ blocks_task_ids: ['task-two'] }); f.updateTask('task-two', { body: 'branch first branch last', blocks_task_ids: ['task-three'] }); f.seedTask('task-three', { title: 'Third task' });
  });
  try {
    await find(page); await field(page).press('Enter');
    await reader(page).getByRole('button', { name: 'Open task Other task', exact: true }).click(); await expect(field(page)).toHaveCount(0);
    await find(page, 'branch'); await field(page).press('Enter'); await expect(status(page)).toHaveText('2 of 2 matches.');
    await reader(page).getByRole('button', { name: 'Open task Third task', exact: true }).click(); await expect(field(page)).toHaveCount(0);
    await back(page).click(); await expect(field(page)).toHaveValue('branch'); await expect(status(page)).toHaveText('2 of 2 matches.');
    await back(page).click(); await expect(field(page)).toHaveValue('needle'); await expect(status(page)).toHaveText('2 of 2 matches.'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('retains the Find caret, current match and scroll through an unrelated label repaint', async ({ page }) => {
  const f = await boot(page, f => f.hold('work_entity.get', 'project-one'));
  try {
    await expect.poll(() => f.waiting()).toBe(true); await find(page); await field(page).press('Enter');
    await field(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 4, 'backward'));
    const scroll = await reader(page).locator('.work-entity-task-content').evaluate(el => el.scrollTop);
    const reads = f.reads.filter(read => read.method === 'work_entity.get' && read.id === 'project-one').length; f.release();
    await page.waitForFunction(count => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(key => key === 'work_entity.get:project-one').length >= count, reads);
    await expect(reader(page).getByRole('button', { name: 'Open project Launch <img src=x> project', exact: true })).toBeVisible();
    await expect(field(page)).toBeFocused(); await expect(status(page)).toHaveText('2 of 2 matches.');
    expect(await field(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([1, 4, 'backward']);
    expect(await reader(page).locator('.work-entity-task-content').evaluate(el => el.scrollTop)).toBeCloseTo(scroll, -1); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('Search everywhere uses the same phrase in universal search', async ({ page }) => {
  const f = await boot(page);
  try {
    await trigger(page).click(); await expect(reader(page).getByRole('button', { name: 'Search everywhere', exact: true })).toBeDisabled();
    await field(page).fill('needle'); await reader(page).getByRole('button', { name: 'Search everywhere for needle', exact: true }).click();
    await expect(page.getByRole('searchbox', { name: 'Search everything', exact: true })).toHaveValue('needle');
    await expect(page.locator('[data-work-search-group="task"] [data-search-work-id="task-one"]')).toBeVisible();
    await expect(reader(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('edits raw task text without intercepting editor Find and restores the reader query after saving', async ({ page }) => {
  const f = await boot(page), original = f.task();
  try {
    await find(page); await field(page).press('Enter'); await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('.work-entity-dialog[data-kind="task"][data-mode="edit"]'), body = editor.getByLabel('Notes', { exact: true });
    await expect(body).toHaveValue(original.body!); await expect(field(page)).toHaveCount(0);
    expect(await body.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })))).toBe(true);
    await editor.getByLabel('Title').fill('Needle task saved'); await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(field(page)).toHaveValue('needle'); await expect(status(page)).toHaveText('2 of 3 matches.');
    await reader(page).getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(reader(page).locator('[data-task-completion-status]')).toHaveText('Task completed.');
    await expect(field(page)).toHaveValue('needle'); await expect(status(page)).toHaveText('2 of 3 matches.');
    expect(f.task().body).toBe(original.body); expect(f.writes).toEqual([{ method: 'work_entity.upsert', args: { kind: 'task', id: 'task-one', title: 'Needle task saved' } }, { method: 'work_entity.task.mark_done', args: { id: 'task-one', done: true } }]);
  } finally { f.dispose(); }
});

for (const state of ['read-only', 'stale', 'pending'] as const) test(`finds saved text in a ${state} task without offering edits`, async ({ page }) => {
  const f = await boot(page, f => {
    if (state === 'read-only') f.writable(false);
    if (state === 'stale') f.update({ sync_state: 'stale_unreachable' });
    if (state === 'pending') f.update({ pending_write: { staged_at: 1, operation: 'update', dirty_fields: ['title'], state: 'awaiting_verify' } });
  });
  try { await find(page); await expect(status(page)).toHaveText('1 of 2 matches.'); await expect(reader(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0); expect(f.writes).toEqual([]); }
  finally { f.dispose(); }
});

test('bounds highlight work and explicitly reports additional matches', async ({ page }) => {
  const f = await boot(page, f => f.update({ body: 'needle '.repeat(1001) }));
  try {
    await find(page); await expect(status(page)).toHaveText('1 of 1,000+ matches. Narrow your search to see more.');
    await expect(reader(page).locator('[data-task-find-match]')).toHaveCount(1000); await field(page).press('Shift+Enter');
    await expect(status(page)).toHaveText('1000 of 1,000+ matches. Narrow your search to see more.'); await expect(reader(page).locator('[data-task-find-current]')).toBeInViewport(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a late editor read cannot transfer one task’s Find query into another task', async ({ page }) => {
  const f = await boot(page);
  try {
    await find(page); f.hold('work_entity.get', 'task-one'); await reader(page).getByRole('button', { name: 'Edit', exact: true }).click(); await expect.poll(() => f.waiting()).toBe(true);
    await page.evaluate(() => window.__app.setHash('#data/task/task-two')); await expect(reader(page).getByRole('heading', { name: 'Other task', exact: true })).toBeVisible();
    await expect(field(page)).toHaveCount(0); f.release(); await trigger(page).click(); await expect(field(page)).toHaveValue('');
    await expect(status(page)).toHaveText('Type to find text.'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});


test('highlights across a source link without changing its destination or pointer behavior', async ({ page }) => {
  const f = await boot(page), href = sourceUrl(f, 'mail'), query = 'Email: '+href;
  try {
    await find(page, query); await expect(status(page)).toHaveText('1 of 1 matches.');
    const link = notes(page).locator('a[href*="#data/mail/record/"]'); await expect(link).toHaveAttribute('href', href);
    await expect(reader(page).locator('[data-task-find-match="0"]')).toHaveCount(2); await link.locator('mark').click();
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toContainText('Exact work email body.');
    await back(page).click(); await expect(field(page)).toHaveValue(query); await expect(status(page)).toHaveText('1 of 1 matches.'); await expect(link).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('Search everywhere waits for a task completion already in progress', async ({ page }) => {
  const f = await boot(page);
  try {
    await find(page); f.hold('work_entity.task.mark_done', 'task-one'); await reader(page).getByRole('button', { name: 'Complete', exact: true }).click();
    await expect.poll(() => f.waiting()).toBe(true);
    const everywhere = reader(page).locator('[data-task-find-everywhere]'); await expect(everywhere).toBeDisabled();
    await field(page).fill('needle first'); await expect(everywhere).toBeDisabled(); await expect(reader(page)).toBeVisible();
    f.release(); await expect(reader(page).locator('[data-task-completion-status]')).toHaveText('Task completed.');
    const ready = reader(page).getByRole('button', { name: 'Search everywhere for needle first', exact: true }); await expect(ready).toBeEnabled(); await ready.click();
    await expect(page.getByRole('searchbox', { name: 'Search everything', exact: true })).toHaveValue('needle first');
    expect(f.writes).toEqual([{ method: 'work_entity.task.mark_done', args: { id: 'task-one', done: true } }]);
  } finally { f.dispose(); }
});
