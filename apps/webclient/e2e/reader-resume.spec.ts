import { expect, test, type Page } from '@playwright/test';
import { ACCOUNT_MENU_TRIGGER, HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute } from '../src/shell/route.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 900 } });
type Kind = 'note' | 'task';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const reader = (page: Page, kind: Kind = 'note') => page.locator(`.work-entity-${kind}-reader`);
const content = (page: Page, kind: Kind = 'note') => reader(page, kind).locator(`.work-entity-${kind}-content`);
const find = (page: Page, kind: Kind = 'note') => reader(page, kind).getByRole('searchbox', { name: `Find in this ${kind}`, exact: true });
const status = (page: Page, kind: Kind = 'note') => reader(page, kind).locator(`[data-${kind}-find-status]`);
const route = (page: Page, hash: string) => page.evaluate(hash => window.__app.setHash(hash), hash);
const recordId = (kind: Kind) => kind === 'note' ? 'resume-note' : 'task-one';
const title = (kind: Kind) => kind === 'note' ? 'Long note' : 'Long task';
const body = '# Private heading not stored\n\n' + Array.from({ length: 40 }, (_, index) => `## Section ${index + 1}\n\nNeedle ${index + 1}. This paragraph keeps the full reading context available while moving through a long record. More detail stays with its original source.\n`).join('\n')
  + '\nPrivate body not stored. <https://private.invalid/?token=not-stored>\n';
const boot = async (page: Page) => {
  const f = await installTaskNoteSourceFixture(page); f.seedNote('resume-note', { title: 'Long note', body });
  f.seedNote('other-note', { title: 'Other note', body: 'Other untouched note.' }); f.update({ title: 'Long task', body });
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple&settle_reads=1#data/search`);
  await page.waitForFunction(() => window.__app?.ready === true); return f;
};
const visit = async (page: Page, kind: Kind = 'note', id = recordId(kind)) => {
  await route(page, serializeShellRoute('data', kind, id)); await expect(reader(page, kind)).toHaveAttribute(`data-${kind}-id`, id);
};
const reload = async (page: Page, kind: Kind = 'note') => {
  await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); await expect(reader(page, kind)).toBeVisible();
};
const search = async (page: Page) => {
  await reader(page, await reader(page, 'note').count() ? 'note' : 'task').getByRole('button', { name: /Back to (?:notes|tasks|search)/, exact: true }).click();
  await route(page, '#data/search'); await expect(page.getByRole('searchbox', { name: 'Search everything', exact: true })).toBeVisible();
};
const recent = (page: Page, kind: Kind) => page.getByRole('region', { name: 'Recently opened', exact: true }).getByRole('button', { name: `Open ${kind} ${title(kind)}`, exact: true });
const prepare = async (page: Page, kind: Kind = 'note') => {
  await visit(page, kind);
  if (kind === 'note') await reader(page, kind).getByRole('button', { name: 'Formatted', exact: true }).click();
  await reader(page, kind).getByRole('button', { name: `Find in ${kind}`, exact: true }).click(); await find(page, kind).fill('Needle');
  for (let index = 0; index < 4; index++) await find(page, kind).press('Enter');
  await expect(status(page, kind)).toHaveText('5 of 40 matches.');
  await content(page, kind).evaluate(node => { node.scrollTop = 1700; }); return content(page, kind).evaluate(node => node.scrollTop);
};
const expectState = async (page: Page, kind: Kind, top: number) => {
  await expect(find(page, kind)).toHaveValue('Needle'); await expect(status(page, kind)).toHaveText('5 of 40 matches.');
  if (kind === 'note') await expect(reader(page, kind)).toHaveAttribute('data-note-format', 'formatted');
  await expect.poll(() => content(page, kind).evaluate(node => node.scrollTop)).toBeCloseTo(top, -1);
};

for (const kind of ['note', 'task'] as const) test(`reopens a ${kind} from Recently opened with its position and Find, and preserves them through immediate reload`, async ({ page }, info) => {
  const f = await boot(page);
  try {
    const top = await prepare(page, kind); expect(top).toBeGreaterThan(1000);
    await search(page); await recent(page, kind).focus(); await page.keyboard.press('Enter'); await expectState(page, kind, top);
    await reload(page, kind); await expectState(page, kind, top);
    const stored = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('recued.work.reading.v1:')).map(key => sessionStorage.getItem(key)).join(''));
    expect(stored).not.toContain('Private heading'); expect(stored).not.toContain('Private body'); expect(stored).not.toContain('private.invalid'); expect(stored).not.toContain('token=');
    await page.screenshot({ path: info.outputPath(`resumed-${kind}-phone.png`), fullPage: true }); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['note', 'task'] as const) test(`Start from top resets a ${kind} position across reload while retaining Find and the Note display choice`, async ({ page }) => {
  const f = await boot(page);
  try {
    await prepare(page, kind); await reader(page, kind).getByRole('button', { name: 'Start from top', exact: true }).click();
    await expectState(page, kind, 0); await reload(page, kind); await expectState(page, kind, 0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('separates record and kind identities, and remembers independent plain and formatted positions', async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page); await content(page).evaluate(node => { node.scrollTop = 500; });
    await reader(page).getByRole('button', { name: 'Formatted', exact: true }).click(); await content(page).evaluate(node => { node.scrollTop = 1500; });
    await search(page); await visit(page, 'task'); await expect(find(page, 'task')).toHaveCount(0); expect(await content(page, 'task').evaluate(node => node.scrollTop)).toBe(0);
    await search(page); await visit(page, 'note', 'other-note'); await expect(reader(page)).toHaveAttribute('data-note-format', 'plain'); await expect(find(page)).toHaveCount(0);
    await search(page); await recent(page, 'note').click(); await expect(reader(page)).toHaveAttribute('data-note-format', 'formatted');
    await expect.poll(() => content(page).evaluate(node => node.scrollTop)).toBeCloseTo(1500, -1);
    await reader(page).getByRole('button', { name: 'Plain text', exact: true }).click(); await expect.poll(() => content(page).evaluate(node => node.scrollTop)).toBeCloseTo(500, -1);
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('changed text keeps Note format but retires stale Find and positions', async ({ page }) => {
  const f = await boot(page);
  try {
    await prepare(page); await search(page); f.updateNote('resume-note', { body: '# Revised\n\nThe current saved body.' });
    await recent(page, 'note').click(); await expect(reader(page)).toHaveAttribute('data-note-format', 'formatted');
    await expect(reader(page).locator('[data-note-body]')).toContainText('The current saved body.'); await expect(find(page)).toHaveCount(0);
    expect(await content(page).evaluate(node => node.scrollTop)).toBe(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['note', 'task'] as const) test(`a confirmed ${kind} edit retains its live reading state through reload`, async ({ page }) => {
  const f = await boot(page);
  try {
    await prepare(page, kind); await reader(page, kind).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator(`.work-entity-dialog[data-kind="${kind}"][data-mode="edit"]`);
    await editor.locator('[data-form-field="body"]').fill('Needle newly added.\n\n' + body); await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(status(page, kind)).toHaveText('5 of 41 matches.'); await expect(find(page, kind)).toHaveValue('Needle');
    const top = await content(page, kind).evaluate(node => node.scrollTop); await reload(page, kind);
    await expect(status(page, kind)).toHaveText('5 of 41 matches.'); await expect(find(page, kind)).toHaveValue('Needle');
    if (kind === 'note') await expect(reader(page, kind)).toHaveAttribute('data-note-format', 'formatted');
    await expect.poll(() => content(page, kind).evaluate(node => node.scrollTop)).toBeCloseTo(top, -1); expect(f.writes).toHaveLength(1);
  } finally { f.dispose(); }
});

test('a source identity replacement cannot inherit another record’s position, format or Find', async ({ page }) => {
  const f = await boot(page);
  try {
    await prepare(page); await search(page); f.registerSource('other.note', 'note'); f.updateNote('resume-note', { source_id: 'other.note' });
    await visit(page); await expect(reader(page)).toHaveAttribute('data-note-format', 'plain'); await expect(find(page)).toHaveCount(0);
    expect(await content(page).evaluate(node => node.scrollTop)).toBe(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['note', 'task'] as const) test(`a new search takes precedence over a ${kind}’s saved Find and scroll`, async ({ page }) => {
  const f = await boot(page);
  try {
    await prepare(page, kind); await search(page);
    const query = page.getByRole('searchbox', { name: 'Search everything', exact: true }); await query.fill('Section 1');
    await page.locator(`[data-work-search-group="${kind}"] [data-search-work-id="${recordId(kind)}"]`).click();
    await expect(find(page, kind)).toHaveValue('Section 1'); await expect(status(page, kind)).toHaveText(/1 of \d+ matches/);
    expect(await content(page, kind).evaluate(node => node.scrollTop)).toBeLessThan(1700); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a late read cannot install cached state over a newer note', async ({ page }) => {
  const f = await boot(page);
  try {
    await prepare(page); await search(page); f.hold('work_entity.get', 'resume-note');
    await recent(page, 'note').click(); await expect.poll(() => f.waiting()).toBe(true); await visit(page, 'note', 'other-note');
    const settled = await page.evaluate(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'work_entity.get:resume-note').length);
    f.release(); await page.waitForFunction(before => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'work_entity.get:resume-note').length > before, settled);
    await expect(reader(page)).toHaveAttribute('data-note-id', 'other-note'); await expect(reader(page)).toHaveAttribute('data-note-format', 'plain'); await expect(find(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('metadata storage failure keeps reading and navigation usable, then resumes persistence when storage returns', async ({ page }) => {
  const f = await boot(page);
  try {
    await page.evaluate(() => {
      const set = Storage.prototype.setItem; Object.assign(window, { __readingStorageBlocked: true });
      Storage.prototype.setItem = function(key, value) { if (key.startsWith('recued.work.reading.v1:') && (window as unknown as { __readingStorageBlocked: boolean }).__readingStorageBlocked) throw Error('Blocked'); set.call(this, key, value); };
    });
    const top = await prepare(page); await search(page); await recent(page, 'note').click(); await expectState(page, 'note', top);
    await page.evaluate(() => { (window as unknown as { __readingStorageBlocked: boolean }).__readingStorageBlocked = false; });
    await content(page).evaluate(node => { node.scrollTop = 1800; }); await reload(page); await expectState(page, 'note', 1800); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('reading state stays with its paired server when switching away and back', async ({ page }) => {
  const f = await boot(page);
  try {
    const top = await prepare(page); await search(page); await page.locator(`[${ACCOUNT_MENU_TRIGGER}]`).click();
    const menu = page.locator('[data-recued-account-menu-popover]'), profiles = menu.locator('[data-recued-server-switcher-item]');
    const office = (await profiles.filter({ hasText: 'Office server' }).getAttribute('data-profile-id'))!;
    const original = (await profiles.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-profile-id')))).find(id => id && id !== office)!;
    const switchTo = async (id: string) => {
      await menu.locator(`[data-recued-server-switcher-item][data-profile-id="${id}"]`).click(); const loaded = page.waitForEvent('load');
      await menu.locator('[data-recued-server-switcher-switch-commit]').click(); await loaded; await page.waitForFunction(() => window.__app?.ready === true);
    };
    await switchTo(office); await visit(page); await expect(reader(page)).toHaveAttribute('data-note-format', 'plain'); await expect(find(page)).toHaveCount(0);
    await search(page); await page.locator(`[${ACCOUNT_MENU_TRIGGER}]`).click(); await switchTo(original); await visit(page); await expectState(page, 'note', top); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
