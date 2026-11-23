import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Kind = 'task' | 'note';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const gap = '\n\nA paragraph with context before the matching passage.'.repeat(45);
const body = `${gap}\n\nneedle first${gap}\n\nneedle last. Alternate phrase. Café [a.*].`;
const id = (kind: Kind) => `${kind}-one`;
const reader = (page: Page, kind: Kind) => page.locator(`.work-entity-${kind}-reader`);
const field = (page: Page, kind: Kind) => reader(page, kind).getByRole('searchbox', { name: `Find in this ${kind}`, exact: true });
const status = (page: Page, kind: Kind) => reader(page, kind).locator(`[data-${kind}-find-status]`);
const result = (page: Page, kind: Kind) => page.locator(`[data-work-search-group="${kind}"] [data-search-work-id="${id(kind)}"]`);
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
const boot = async (page: Page, kind: Kind, query = 'needle', prepare?: (f: Fixture) => void) => {
  const f = await installTaskNoteSourceFixture(page);
  f.update({ title: 'Task result', body, blocks_task_ids: ['task-two'] });
  f.seedNote('note-one', { title: 'Note result', body, related_contact_ids: [f.person.contact_id!] });
  f.seedNote('note-other', { title: 'Other note', body: 'A separate note.' });
  prepare?.(f);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/search`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption(kind);
  await search(page).fill(query); await expect(result(page, kind)).toBeVisible(); return f;
};
const current = (f: Fixture, kind: Kind) => kind === 'task' ? f.task() : f.note();
const change = (f: Fixture, kind: Kind, value: string) => kind === 'task' ? f.update({ body: value }) : f.updateNote('note-one', { body: value });
const waitForRead = (page: Page, record: string) => page.waitForFunction(record =>
  (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.includes(`work_entity.get:${record}`), record);

for (const kind of ['task', 'note'] as const) {
  test(`${kind} search opens Find at the first current match and returns to the same filtered result`, async ({ page }, info) => {
    const f = await boot(page, kind), original = current(f, kind);
    try {
      await result(page, kind).scrollIntoViewIfNeeded();
      await result(page, kind).locator('mark').first().click();
      await expect(field(page, kind)).toHaveValue('needle'); await expect(field(page, kind)).toBeFocused();
      await expect(status(page, kind)).toHaveText('1 of 2 matches.');
      await expect(reader(page, kind).locator(`[data-${kind}-find-current]`)).toBeInViewport();
      expect(await reader(page, kind).locator(`.work-entity-${kind}-content`).evaluate(el => el.scrollTop)).toBeGreaterThan(100);
      await field(page, kind).press('Enter'); await expect(status(page, kind)).toHaveText('2 of 2 matches.');
      await field(page, kind).press('Shift+Enter'); await expect(status(page, kind)).toHaveText('1 of 2 matches.');
      await page.screenshot({ path: info.outputPath(`${kind}-search-match-phone.png`), fullPage: true });
      await reader(page, kind).getByRole('button', { name: 'Back to search', exact: true }).click();
      await expect(search(page)).toHaveValue('needle'); await expect(page.getByRole('combobox', { name: 'Result type', exact: true })).toHaveValue(kind);
      await expect(result(page, kind)).toBeFocused();
      expect(current(f, kind)).toEqual(original); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });

  test(`${kind} search uses the fetched text when a result changes before its read completes`, async ({ page }) => {
    const f = await boot(page, kind);
    try {
      f.hold('work_entity.get', id(kind)); await result(page, kind).click(); await expect.poll(() => f.waiting()).toBe(true);
      change(f, kind, 'The saved passage has been replaced.'); f.release();
      await expect(field(page, kind)).toHaveValue('needle'); await expect(status(page, kind)).toHaveText('No matches.');
      await expect(reader(page, kind).locator('mark')).toHaveCount(0);
      await expect(reader(page, kind).getByRole('button', { name: 'Next match', exact: true })).toBeDisabled();
      await expect(reader(page, kind)).toContainText('The saved passage has been replaced.'); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });

  test(`a late ${kind} search read cannot seed Find in a newer record`, async ({ page }) => {
    const f = await boot(page, kind), other = kind === 'task' ? 'task-two' : 'note-other';
    try {
      f.hold('work_entity.get', id(kind)); await result(page, kind).click(); await expect.poll(() => f.waiting()).toBe(true);
      await page.evaluate(({ kind, other }) => window.__app.setHash(`#data/${kind}/${other}`), { kind, other });
      await expect(reader(page, kind)).toHaveAttribute(`data-${kind}-id`, other);
      f.release(); await waitForRead(page, id(kind)); await expect(field(page, kind)).toHaveCount(0);
      await reader(page, kind).getByRole('button', { name: `Find in ${kind}`, exact: true }).click();
      await expect(field(page, kind)).toHaveValue(''); await expect(status(page, kind)).toHaveText('Type to find text.'); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });

  test(`opening the same ${kind} from a new search replaces a closed Find query and current match`, async ({ page }) => {
    const f = await boot(page, kind);
    try {
      await result(page, kind).click(); await expect(field(page, kind)).toHaveValue('needle'); await field(page, kind).press('Enter');
      await field(page, kind).press('Escape');
      await reader(page, kind).getByRole('button', { name: 'Back to search', exact: true }).click();
      await search(page).fill('Alternate phrase');
      await expect(result(page, kind).locator('.rq-row-excerpt mark').first()).toHaveText('Alternate'); await result(page, kind).click();
      await expect(field(page, kind)).toHaveValue('Alternate phrase'); await expect(status(page, kind)).toHaveText('1 of 1 matches.');
      await expect(reader(page, kind).locator(`[data-${kind}-find-current]`)).toHaveText('Alternate phrase'); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });

  test(`a failed ${kind} result read leaves Find closed and a successful retry uses the search phrase`, async ({ page }) => {
    const f = await boot(page, kind);
    try {
      f.fail('work_entity.get', id(kind)); await result(page, kind).click();
      await expect(page.getByRole('alert').filter({ hasText: 'This read was interrupted.' })).toBeVisible();
      await expect(field(page, kind)).toHaveCount(0); f.fail('work_entity.get', id(kind), false);
      await page.getByRole('button', { name: 'Back to search', exact: true }).click();
      await expect(result(page, kind)).toBeVisible(); await result(page, kind).click();
      await expect(field(page, kind)).toHaveValue('needle'); await expect(status(page, kind)).toHaveText('1 of 2 matches.'); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });
}

test('a searched task keeps its phrase and current match through an exact email source visit', async ({ page }) => {
  const f = await boot(page, 'task', 'needle', f => f.update({ body: body + '\n' + HARNESS_URL + serializeSourceRecordAddress(f.source('mail')) }));
  try {
    await result(page, 'task').click(); await expect(field(page, 'task')).toHaveValue('needle'); await field(page, 'task').press('Enter');
    await reader(page, 'task').locator('a[href*="#data/mail/record/"]').click();
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toContainText('Exact work email body.');
    await page.getByRole('button', { name: 'Back to task', exact: true }).click();
    await expect(field(page, 'task')).toHaveValue('needle'); await expect(status(page, 'task')).toHaveText('2 of 2 matches.');
    expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('a searched note retains its phrase and current match through a related contact visit', async ({ page }) => {
  const f = await boot(page, 'note');
  try {
    await result(page, 'note').click(); await expect(field(page, 'note')).toHaveValue('needle'); await field(page, 'note').press('Enter');
    await reader(page, 'note').locator('[data-note-section="related"] summary').click();
    await reader(page, 'note').getByRole('button', { name: 'Open contact Riley <img src=x>', exact: true }).click();
    await page.getByRole('button', { name: '← Back to note', exact: true }).click();
    await expect(field(page, 'note')).toHaveValue('needle'); await expect(status(page, 'note')).toHaveText('2 of 2 matches.'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('note search preserves a literal Unicode query and rendered links when switching format', async ({ page }) => {
  const f = await boot(page, 'note', '  Café [a.*]  ', f => f.updateNote('note-one', { body: gap + '\n\nCafé [a.*]. [Reference](https://example.test/source) <img src=x>' }));
  try {
    await result(page, 'note').click(); await expect(field(page, 'note')).toHaveValue('Café [a.*]'); await expect(status(page, 'note')).toHaveText('1 of 1 matches.');
    await reader(page, 'note').getByRole('button', { name: 'Formatted', exact: true }).click();
    await expect(status(page, 'note')).toHaveText('1 of 1 matches.'); await expect(reader(page, 'note').locator('[data-note-find-current]')).toBeInViewport();
    await expect(reader(page, 'note').getByRole('link', { name: 'Reference', exact: true })).toHaveAttribute('href', 'https://example.test/source');
    await expect(reader(page, 'note').locator('img,script')).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('search passes the whole phrase to Find even beyond the manual input limit', async ({ page }) => {
  const query = 'a'.repeat(520) + ' ending';
  const f = await boot(page, 'task', query, f => f.update({ body: gap + '\n\n' + query + '\n' + 'a'.repeat(520) + ' different ending' }));
  try {
    await result(page, 'task').click(); await expect(field(page, 'task')).toHaveValue(query); await expect(status(page, 'task')).toHaveText('1 of 1 matches.');
    await expect(reader(page, 'task').locator('[data-task-find-current]')).toHaveText(query); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a title-only task result highlights its title without requiring notes', async ({ page }) => {
  const f = await boot(page, 'task', 'needle', f => f.update({ title: 'needle in the title', body: '' }));
  try {
    await result(page, 'task').click(); await expect(status(page, 'task')).toHaveText('1 of 1 matches.');
    await expect(reader(page, 'task').locator('h2 [data-task-find-current]')).toHaveText('needle'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
