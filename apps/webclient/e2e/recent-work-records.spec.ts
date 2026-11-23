import { expect, test, type Page } from '@playwright/test';
import { ACCOUNT_MENU_TRIGGER, HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 } });
type Kind = 'task' | 'note';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
declare global { interface Window { __recentWorkFixture: { blocked: boolean } } }
const panel = (page: Page) => page.getByRole('region', { name: 'Recently opened', exact: true });
const rows = (page: Page) => panel(page).locator('[data-recent-work-focus="open"]');
const input = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
const reader = (page: Page, kind: Kind) => page.locator(`.work-entity-${kind}-reader`);
const route = async (page: Page, hash: string) => page.evaluate(hash => window.__app.setHash(hash), hash);
const search = async (page: Page) => { await route(page, '#data/search'); await expect(input(page)).toBeVisible(); };
const visit = async (page: Page, kind: Kind, id = `${kind}-one`) => {
  await route(page, serializeShellRoute('data', kind, id)); await expect(reader(page, kind)).toHaveAttribute(`data-${kind}-id`, id);
};
const open = (page: Page, kind: Kind, title: string) => panel(page).getByRole('button', { name: `Open ${kind} ${title}`, exact: true });
const remove = (page: Page, kind: Kind, title: string) => panel(page).getByRole('button', { name: `Remove ${kind} ${title} from recently opened`, exact: true });
const boot = async (page: Page, prepare?: (f: Fixture) => void) => {
  const f = await installTaskNoteSourceFixture(page); f.seedNote('note-one', { title: 'Saved note <img src=x>', body: 'Private note body 二' });
  f.seedNote('note-two', { title: 'Other saved note', body: 'Another note.' }); prepare?.(f);
  await page.addInitScript(() => {
    const state = { blocked: false }; window.__recentWorkFixture = state;
    const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function(key, value) { if (state.blocked && key.startsWith('recued.work.recent.v1:')) throw Error('Storage blocked'); set.call(this, key, value); };
    Storage.prototype.removeItem = function(key) { if (state.blocked && key.startsWith('recued.work.recent.v1:')) throw Error('Storage blocked'); remove.call(this, key); };
  });
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/search`);
  await page.waitForFunction(() => window.__app?.ready === true); await expect(input(page)).toBeVisible(); return f;
};
const waitForRead = async (page: Page, f: Fixture, kind: 'work_entity.get' | 'work_entity.source.list', id: string, before: number) => {
  await page.waitForFunction(({ key, before }) => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === key).length > before,
    { key: `${kind}:${id}`, before });
  expect(f.writes).toEqual([]);
};
const completed = (page: Page, method: string, id: string) => page.evaluate(({ method, id }) =>
  (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === `${method}:${id}`).length, { method, id });

for (const kind of ['task', 'note'] as const) test(`recent ${kind}s survive leaving and reload, reopen fresh text, and return to their exact history row`, async ({ page }) => {
  const f = await boot(page), original = kind === 'task' ? f.task() : f.note();
  try {
    await visit(page, kind); await route(page, '#chat'); await search(page);
    await expect(open(page, kind, original.title!)).toContainText('Recued'); await expect(rows(page)).toHaveCount(1);
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); await expect(rows(page)).toHaveCount(1);
    expect(f.reads.filter(read => read.method === 'work_entity.get' && read.id === `${kind}-one`)).toHaveLength(1);
    if (kind === 'task') f.update({ title: 'Fresh task title', body: 'Fresh saved body.' }); else f.updateNote('note-one', { title: 'Fresh note title', body: 'Fresh saved body.' });
    await open(page, kind, original.title!).focus(); await page.keyboard.press('Enter');
    await expect(reader(page, kind).getByRole('heading', { name: `Fresh ${kind} title`, exact: true })).toBeVisible();
    await expect(reader(page, kind).locator(kind === 'task' ? '.work-entity-task-notes' : '[data-note-body]')).toHaveText('Fresh saved body.');
    await expect(reader(page, kind).getByRole('navigation', { name: `Browse ${kind}s`, exact: true })).toHaveCount(0);
    await reader(page, kind).getByRole('button', { name: 'Back to search', exact: true }).click();
    await expect(open(page, kind, `Fresh ${kind} title`)).toBeFocused(); await expect(rows(page)).toHaveCount(1); await expect(input(page)).toHaveValue('');
    const stored = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('recued.work.recent.v1:')).map(key => sessionStorage.getItem(key)).join(''));
    expect(stored).not.toContain('Fresh saved body.'); expect(stored).not.toContain(original.body!); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('keeps eight records, separates matching task/note IDs, renders labels safely, and removes or clears without losing keyboard focus', async ({ page }, info) => {
  const f = await boot(page, f => { for (let i = 0; i < 9; i++) f.seedTask(`recent-${i}`, { title: `Recent task ${i}` }); f.seedNote('recent-8', { title: 'Same ID note <img src=x>', body: 'Exact note.' }); });
  try {
    for (let i = 0; i < 9; i++) await visit(page, 'task', `recent-${i}`);
    await visit(page, 'note', 'recent-8'); await search(page); await expect(rows(page)).toHaveCount(8);
    await expect(rows(page).first()).toContainText('Same ID note <img src=x>'); await expect(rows(page).nth(1)).toContainText('Recent task 8'); await expect(panel(page).locator('img,script')).toHaveCount(0);
    await open(page, 'task', 'Recent task 5').click(); await reader(page, 'task').getByRole('button', { name: 'Back to search', exact: true }).click();
    await expect(rows(page).first()).toContainText('Recent task 5'); await expect(open(page, 'task', 'Recent task 5')).toBeFocused(); await expect(open(page, 'task', 'Recent task 5')).toBeInViewport();
    await remove(page, 'task', 'Recent task 5').focus(); await page.keyboard.press('Enter'); await expect(rows(page)).toHaveCount(7);
    await expect(remove(page, 'note', 'Same ID note <img src=x>')).toBeFocused();
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: info.outputPath('recently-opened-phone-dark.png'), fullPage: true });
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); await expect(rows(page)).toHaveCount(7);
    await panel(page).getByRole('button', { name: 'Clear recently opened', exact: true }).click(); await expect(rows(page)).toHaveCount(0); await expect(input(page)).toBeFocused();
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); await expect(panel(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('follows opaque record IDs and browser Back restores the recently opened row', async ({ page }) => {
  const id = "same/shared?二.)!'*", f = await boot(page, f => f.seedNote(id, { title: 'Opaque note', body: 'Its exact body.' }));
  try {
    await visit(page, 'note', id); await search(page); await open(page, 'note', 'Opaque note').click();
    await expect(page).toHaveURL(new RegExp(serializeShellRoute('data', 'note', id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')+'$'));
    await expect(reader(page, 'note')).toHaveAttribute('data-note-id', id); await page.goBack();
    await expect(input(page)).toHaveValue(''); await expect(open(page, 'note', 'Opaque note')).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('empty-search type filters limit recent records and query history stays independent', async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, 'task'); await visit(page, 'note'); await search(page); await expect(rows(page)).toHaveCount(2);
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('task'); await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('Task');
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('contact'); await expect(panel(page)).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('all'); await input(page).fill('launch');
    await expect(page.locator('[data-work-search-group="task"] [data-search-work-id="task-one"]')).toBeVisible(); await expect(panel(page)).toHaveCount(0);
    await input(page).fill(''); const queries = page.getByRole('region', { name: 'Recent searches', exact: true }); await expect(queries).toContainText('launch');
    await panel(page).getByRole('button', { name: 'Clear recently opened', exact: true }).click(); await expect(queries).toContainText('launch'); await expect(rows(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('failed history removal remains retryable and storage failure leaves navigation usable', async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, 'task'); await visit(page, 'note'); await search(page); await page.evaluate(() => { window.__recentWorkFixture.blocked = true; });
    await remove(page, 'note', 'Saved note <img src=x>').click(); await expect(rows(page)).toHaveCount(2); await expect(panel(page).getByRole('alert')).toContainText('Try again.');
    await panel(page).getByRole('button', { name: 'Clear recently opened', exact: true }).click(); await expect(rows(page)).toHaveCount(2);
    await open(page, 'task', f.task().title).click(); await expect(reader(page, 'task')).toBeVisible(); await reader(page, 'task').getByRole('button', { name: 'Back to search', exact: true }).click();
    await page.evaluate(() => { window.__recentWorkFixture.blocked = false; }); await remove(page, 'note', 'Saved note <img src=x>').click(); await expect(rows(page)).toHaveCount(1);
    await panel(page).getByRole('button', { name: 'Clear recently opened', exact: true }).click(); await expect(rows(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('missing records and interrupted reads explain the failure and can be retried or removed', async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, 'note'); await visit(page, 'task'); await search(page); f.removeNote('note-one');
    await open(page, 'note', 'Saved note <img src=x>').click(); await expect(panel(page).getByRole('alert')).toContainText('no longer available'); await expect(rows(page)).toHaveCount(2); await expect(reader(page, 'note')).toHaveCount(0);
    await remove(page, 'note', 'Saved note <img src=x>').click(); f.fail('work_entity.get', 'task-one');
    await open(page, 'task', f.task().title).focus(); await page.keyboard.press('Enter'); await expect(panel(page).getByRole('alert')).toContainText('interrupted'); await expect(open(page, 'task', f.task().title)).toBeFocused();
    f.fail('work_entity.get', 'task-one', false); await open(page, 'task', f.task().title).click(); await expect(reader(page, 'task')).toBeVisible(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('rechecks task source permissions when reopening from a reloaded history', async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, 'task'); await search(page); f.writable(false); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await open(page, 'task', f.task().title).click(); await expect(reader(page, 'task')).toBeVisible(); await expect(reader(page, 'task').getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(reader(page, 'task').getByText('This task is read-only here.', { exact: true })).toBeVisible(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const steering of ['clear', 'remove', 'typing', 'route', 'source-read'] as const) test(`late recent-record reads cannot reopen a reader after ${steering}`, async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, 'task'); await search(page);
    const method = steering === 'source-read' ? 'work_entity.source.list' : 'work_entity.get', id = steering === 'source-read' ? '' : 'task-one';
    const before = await completed(page, method, id); f.hold(method, id); await open(page, 'task', f.task().title).click(); await expect.poll(() => f.waiting()).toBe(true);
    await open(page, 'task', f.task().title).evaluate((node: HTMLButtonElement) => node.click());
    if (steering === 'clear' || steering === 'source-read') await panel(page).getByRole('button', { name: 'Clear recently opened', exact: true }).click();
    if (steering === 'remove') await remove(page, 'task', f.task().title).click();
    if (steering === 'typing') await input(page).fill('Other task');
    if (steering === 'route') await route(page, '#chat');
    f.release(); await waitForRead(page, f, method, id, before); await expect(reader(page, 'task')).toHaveCount(0);
    if (steering === 'typing') await expect(input(page)).toHaveValue('Other task');
    else if (steering === 'route') await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
    else { await expect(rows(page)).toHaveCount(0); await expect(input(page)).toBeFocused(); }
    await search(page); if (['clear', 'remove', 'source-read'].includes(steering)) await expect(rows(page)).toHaveCount(0);
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
  } finally { f.dispose(); }
});

test('clearing a held open and visiting another task prevents the old result from taking over', async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, 'task'); await search(page); const before = await completed(page, 'work_entity.get', 'task-one');
    f.hold('work_entity.get', 'task-one'); await open(page, 'task', f.task().title).click(); await expect.poll(() => f.waiting()).toBe(true);
    await panel(page).getByRole('button', { name: 'Clear recently opened', exact: true }).click(); await visit(page, 'task', 'task-two');
    f.release(); await waitForRead(page, f, 'work_entity.get', 'task-one', before); await expect(reader(page, 'task')).toHaveAttribute('data-task-id', 'task-two');
    await search(page); await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('Other task');
  } finally { f.dispose(); }
});

test('list browsing, previews, failed opens, and unsaved drafts do not add recent records', async ({ page }) => {
  const f = await boot(page);
  try {
    await route(page, '#data/task'); await expect(page.locator('.work-entity-list-row-button[data-kind="task"]')).toHaveCount(2); await search(page); await expect(panel(page)).toHaveCount(0);
    await input(page).fill('launch'); await expect(page.locator('[data-work-search-group="task"] [data-search-work-id="task-one"]')).toBeVisible(); await input(page).fill(''); await expect(panel(page)).toHaveCount(0);
    f.fail('work_entity.get', 'task-one'); await route(page, '#data/task/task-one'); await expect(page.getByRole('alert')).toContainText('interrupted'); await search(page); await expect(panel(page)).toHaveCount(0);
    f.fail('work_entity.get', 'task-one', false); await route(page, '#data/task'); await page.getByRole('button', { name: '+ New Task', exact: true }).click();
    const editor = page.locator('.work-entity-dialog[data-kind="task"][data-mode="create"]'); await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('Unsaved private draft');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
    await search(page); await expect(panel(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('saved note edits update history while a discarded draft keeps the saved title', async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, 'note'); await reader(page, 'note').getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('.work-entity-dialog[data-kind="note"][data-mode="edit"]'); await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('Renamed saved note'); await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page, 'note')).toBeVisible(); await search(page); await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('Renamed saved note');
    await open(page, 'note', 'Renamed saved note').click(); await reader(page, 'note').getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('Discard this title'); await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click(); await expect(reader(page, 'note')).toBeVisible(); await search(page);
    await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('Renamed saved note'); expect(f.writes).toHaveLength(1);
  } finally { f.dispose(); }
});

test('recent records stay bound to their paired server when switching away and back', async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, 'task'); await search(page); await page.locator(`[${ACCOUNT_MENU_TRIGGER}]`).click();
    const menu = page.locator('[data-recued-account-menu-popover]'), profiles = menu.locator('[data-recued-server-switcher-item]');
    const officeId = (await profiles.filter({ hasText: 'Office server' }).getAttribute('data-profile-id'))!;
    const personalId = (await profiles.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-profile-id')))).find(id => id && id !== officeId)!;
    const switchTo = async (id: string) => {
      await menu.locator(`[data-recued-server-switcher-item][data-profile-id="${id}"]`).click(); const loaded = page.waitForEvent('load');
      await menu.locator('[data-recued-server-switcher-switch-commit]').click(); await loaded; await page.waitForFunction(() => window.__app?.ready === true); await search(page);
    };
    await switchTo(officeId); await expect(panel(page)).toHaveCount(0); await visit(page, 'note'); await search(page); await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('Saved note');
    await page.locator(`[${ACCOUNT_MENU_TRIGGER}]`).click(); await switchTo(personalId); await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText(f.task().title); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
