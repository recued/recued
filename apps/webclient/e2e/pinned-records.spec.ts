import { expect, test, type Page } from '@playwright/test';
import { ACCOUNT_MENU_TRIGGER, HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 900 } });
type Kind = 'task' | 'note' | 'mail' | 'calendar' | 'contact';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const kinds = ['task', 'note', 'mail', 'calendar', 'contact'] as const;
const noun = (kind: Kind) => kind === 'mail' ? 'email' : kind === 'calendar' ? 'event' : kind;
const input = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
const panel = (page: Page) => page.getByRole('region', { name: 'Pinned', exact: true });
const rows = (page: Page) => panel(page).locator('.rq-recent-record');
const detail = (page: Page, kind: Kind) => page.locator(kind === 'task' || kind === 'note' ? `.work-entity-${kind}-reader`
  : kind === 'mail' ? '.data-mail-message' : kind === 'calendar' ? '.calendar-event' : '[data-recued-data-contact-detail]');
const title = (f: Fixture, kind: Kind, slug = 'work') => kind === 'task' ? f.task().title : kind === 'note' ? 'Notebook'
  : kind === 'contact' ? f.person.name! : kind === 'mail' ? slug === 'work' ? 'Exact work email' : 'Other mailbox email'
  : slug === 'work' ? 'Exact work occurrence' : 'Other calendar occurrence';
const openPin = (page: Page, kind: Kind, label: string) => panel(page).getByRole('button', { name: `Open ${noun(kind)} ${label}`, exact: true });
const route = (page: Page, hash: string) => page.evaluate(hash => window.__app.setHash(hash), hash);
const search = async (page: Page) => { await route(page, '#data/search'); await expect(input(page)).toBeVisible(); await expect(input(page)).toHaveValue(''); };
const reload = async (page: Page) => { await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); };
const back = (page: Page) => page.getByRole('button', { name: /^(?:← )?Back to search$/, exact: true });
const boot = async (page: Page) => {
  const f = await installTaskNoteSourceFixture(page, { searchable: true });
  const body = Array.from({ length: 30 }, (_, index) => `## Section ${index + 1}\n\nNeedle ${index + 1}. ${'Keep the full private reading context here. '.repeat(5)}`).join('\n\n');
  f.seedNote('pin-note', { title: 'Notebook', body }); f.update({ body });
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple&settle_reads=1#data/search`);
  await page.waitForFunction(() => window.__app?.ready === true); return f;
};
const visit = async (page: Page, f: Fixture, kind: Kind, slug = 'work') => {
  await route(page, kind === 'mail' || kind === 'calendar' ? serializeSourceRecordAddress(f.source(kind, slug))
    : serializeShellRoute('data', kind, kind === 'contact' ? f.person.contact_id! : kind === 'note' ? 'pin-note' : 'task-one'));
  await expect(detail(page, kind)).toBeVisible(); await expect(detail(page, kind).locator('[data-record-pin-key]')).toBeVisible();
};
const pinReader = async (page: Page, f: Fixture, kind: Kind, slug = 'work') => {
  await visit(page, f, kind, slug);
  const control = detail(page, kind).getByRole('button', { name: `Pin ${noun(kind)} ${title(f, kind, slug)}`, exact: true });
  await control.click(); await expect(detail(page, kind).locator('[data-record-pin-key]')).toHaveAttribute('aria-pressed', 'true');
};
const noWrites = (f: Fixture) => { expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]); };

for (const kind of kinds) test(`pins a ${kind} from its reader, reopens the current record after reload, and returns focus to its shortcut`, async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, f, kind); const label = title(f, kind); let top = 0;
    if (kind === 'task' || kind === 'note') {
      if (kind === 'note') await detail(page, kind).getByRole('button', { name: 'Formatted', exact: true }).click();
      await detail(page, kind).getByRole('button', { name: `Find in ${kind}`, exact: true }).click();
      const find = detail(page, kind).getByRole('searchbox', { name: `Find in this ${kind}`, exact: true }); await find.fill('Needle'); await find.press('Enter'); await find.press('Enter');
      await detail(page, kind).locator(`.work-entity-${kind}-content`).evaluate(node => { node.scrollTop = 900; });
      top = await detail(page, kind).locator(`.work-entity-${kind}-content`).evaluate(node => node.scrollTop);
    }
    await detail(page, kind).getByRole('button', { name: `Pin ${noun(kind)} ${label}`, exact: true }).click();
    await expect(detail(page, kind).getByRole('button', { name: `Unpin ${noun(kind)} ${label}`, exact: true })).toBeFocused();
    await search(page); await expect(rows(page)).toHaveCount(1); await reload(page);
    if (kind === 'mail') f.updateMail('work', { subject: 'Fresh email title' });
    if (kind === 'calendar') f.updateCalendar('work', { summary: 'Fresh event title' });
    if (kind === 'contact') f.contactReply(f.person.contact_id!, { ...f.person, name: 'Fresh contact title' });
    const fresh = kind === 'mail' ? 'Fresh email title' : kind === 'calendar' ? 'Fresh event title' : kind === 'contact' ? 'Fresh contact title' : label;
    await openPin(page, kind, label).focus(); await page.keyboard.press('Enter'); await expect(detail(page, kind)).toBeVisible();
    if (kind === 'task' || kind === 'note') {
      await expect(detail(page, kind).getByRole('searchbox', { name: `Find in this ${kind}`, exact: true })).toHaveValue('Needle');
      await expect(detail(page, kind).locator(`[data-${kind}-find-status]`)).toHaveText('3 of 30 matches.');
      await expect.poll(() => detail(page, kind).locator(`.work-entity-${kind}-content`).evaluate(node => node.scrollTop)).toBeCloseTo(top, -1);
      if (kind === 'note') await expect(detail(page, kind)).toHaveAttribute('data-note-format', 'formatted');
    } else await expect(detail(page, kind)).toContainText(fresh === 'Fresh email title' ? 'Exact work email body.' : fresh);
    await back(page).click(); await expect(openPin(page, kind, fresh)).toBeFocused();
    await openPin(page, kind, fresh).click(); await expect(detail(page, kind)).toBeVisible(); await page.goBack(); await expect(openPin(page, kind, fresh)).toBeFocused();
    await panel(page).getByRole('button', { name: `Unpin ${noun(kind)} ${fresh}`, exact: true }).click(); await expect(rows(page)).toHaveCount(0); await expect(input(page)).toBeFocused();
    await reload(page); await expect(panel(page)).toHaveCount(0); await expect(page.locator('[data-recent-work-panel] .rq-recent-record')).toHaveCount(1);
    noWrites(f);
  } finally { f.dispose(); }
});

for (const kind of kinds) test(`pins and unpins a ${kind} search result without opening it or losing the search`, async ({ page }, info) => {
  const f = await boot(page);
  try {
    const query = kind === 'task' ? 'Plan launch' : kind === 'note' ? 'Notebook' : kind === 'contact' ? 'Riley' : 'Exact';
    await input(page).fill(query); await input(page).press('Enter');
    const row = kind === 'task' || kind === 'note' ? page.locator(`[data-work-search-group="${kind}"] .rq-row`).first()
      : kind === 'contact' ? page.locator('.rq-contact-group .rq-row').first()
      : page.locator(`.rq-row`).filter({ has: page.locator(`[data-search-platform="${kind}"][data-search-slug="work"]`) }).first();
    const control = row.locator('[data-record-pin-key]'); await expect(control).toBeVisible(); await control.focus(); await page.keyboard.press('Enter');
    await expect(control).toHaveAttribute('aria-pressed', 'true'); await expect(control).toBeFocused(); await expect(input(page)).toHaveValue(query);
    await expect(detail(page, kind)).toHaveCount(0); await expect(page).toHaveURL(/#data\/search$/);
    await control.click(); await expect(control).toHaveAttribute('aria-pressed', 'false'); await control.click(); await expect(control).toHaveAttribute('aria-pressed', 'true');
    if (kind === 'mail') await page.screenshot({ path: info.outputPath('pin-search-phone.png'), fullPage: true });
    await input(page).fill(''); await expect(rows(page)).toHaveCount(1); await reload(page); await expect(openPin(page, kind, title(f, kind))).toBeVisible();
    const stored = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('recued.work.pinned.v1:')).map(key => localStorage.getItem(key)).join(''));
    expect(stored).not.toContain('private reading context'); expect(stored).not.toContain('Exact work email body.'); expect(stored).not.toContain('Keep the event context.'); noWrites(f);
  } finally { f.dispose(); }
});

test('keeps pins above history, separates accounts and kinds, and retains chosen records after recent history fills or clears', async ({ page }, info) => {
  const f = await boot(page);
  try {
    for (const kind of kinds) await pinReader(page, f, kind);
    for (const kind of ['mail', 'calendar'] as const) await pinReader(page, f, kind, 'home');
    for (let index = 0; index < 9; index++) { f.seedTask(`other-${index}`); await route(page, serializeShellRoute('data', 'task', `other-${index}`)); await expect(detail(page, 'task')).toHaveAttribute('data-task-id', `other-${index}`); }
    await search(page); await expect(rows(page)).toHaveCount(7);
    const sections = page.locator('[data-pinned-work-panel], [data-recent-work-panel]'); await expect(sections.first()).toHaveAttribute('data-pinned-work-panel', '');
    await page.getByRole('button', { name: 'Clear recently opened', exact: true }).click(); await expect(rows(page)).toHaveCount(7);
    for (const [kind, count] of [['task', 1], ['note', 1], ['mail', 2], ['calendar', 2], ['contact', 1]] as const) {
      await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption(kind); await expect(rows(page)).toHaveCount(count);
    }
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('all'); await reload(page); await expect(rows(page)).toHaveCount(7);
    await expect(panel(page).locator('img,script')).toHaveCount(0); await page.screenshot({ path: info.outputPath('pinned-records-phone.png'), fullPage: true }); noWrites(f);
  } finally { f.dispose(); }
});

test('a duplicate or late pin read cannot save an old search result after the query changes', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Notebook'); const control = page.locator('[data-work-search-group="note"] [data-record-pin-key]'); await expect(control).toBeVisible();
    f.hold('work_entity.get', 'pin-note'); await control.click(); await expect.poll(f.waiting).toBe(true);
    await control.evaluate((node: HTMLButtonElement) => node.click());
    const count = f.reads.filter(read => read.method === 'work_entity.get' && read.id === 'pin-note').length;
    await input(page).fill('Plan launch'); f.release();
    await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.includes('work_entity.get:pin-note'));
    await input(page).fill(''); await expect(panel(page)).toHaveCount(0);
    expect(f.reads.filter(read => read.method === 'work_entity.get' && read.id === 'pin-note')).toHaveLength(count); noWrites(f);
  } finally { f.dispose(); }
});

test('rejects unreviewed replacement identities and lets an explicitly reviewed record replace its shortcut', async ({ page }) => {
  const f = await boot(page);
  try {
    for (const kind of kinds) {
      await pinReader(page, f, kind); const label = title(f, kind); await search(page);
      if (kind === 'task') f.replaceTask();
      if (kind === 'note') f.removeNote('pin-note');
      if (kind === 'mail') f.updateMail('work', { received_at: Date.parse('2030-01-01T00:00:00Z') });
      if (kind === 'calendar') f.replaceCalendar();
      if (kind === 'contact') f.contactReply(f.person.contact_id!, { ...f.person, merged_into: 'other@example.test' });
      await openPin(page, kind, label).click(); await expect(panel(page).getByRole('alert')).toBeVisible(); await expect(detail(page, kind)).toHaveCount(0);
      let removeLabel = label;
      if (kind === 'task') {
        await visit(page, f, kind); const control = detail(page, kind).getByRole('button', { name: 'Pin task Reused task identity', exact: true });
        await expect(control).toHaveAttribute('aria-pressed', 'false'); await control.click();
        await expect(detail(page, kind).locator('[data-record-pin-key]')).toHaveAttribute('aria-pressed', 'true');
        await search(page); removeLabel = 'Reused task identity'; await expect(openPin(page, kind, removeLabel)).toBeVisible();
      }
      await panel(page).getByRole('button', { name: `Unpin ${noun(kind)} ${removeLabel}`, exact: true }).click(); await expect(rows(page)).toHaveCount(0);
    }
    noWrites(f);
  } finally { f.dispose(); }
});

test('a search result that moved sources or changed its record identity cannot be pinned', async ({ page }) => {
  const f = await boot(page);
  try {
    for (const kind of ['task', 'mail'] as const) {
      const query = kind === 'task' ? 'Plan launch' : 'Exact'; await input(page).fill(query);
      const row = kind === 'task' ? page.locator('[data-work-search-group="task"] .rq-row').first()
        : page.locator('.rq-row').filter({ has: page.locator('[data-search-platform="mail"][data-search-slug="work"]') }).first();
      const control = row.locator('[data-record-pin-key]'); await expect(control).toBeVisible();
      if (kind === 'task') { f.registerSource('moved.task', 'task'); f.updateTask('task-one', { source_id: 'moved.task' }); } else f.wrongRecord();
      await control.click(); await expect(row.getByRole('alert')).toContainText('identity'); await expect(control).toHaveAttribute('aria-pressed', 'false');
      await expect(input(page)).toHaveValue(query); await expect(detail(page, kind)).toHaveCount(0); await input(page).fill(''); await expect(panel(page)).toHaveCount(0);
    }
    noWrites(f);
  } finally { f.dispose(); }
});

test('failed pin and unpin persistence leave controls honest and retryable', async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, f, 'note');
    await page.evaluate(() => {
      const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem; Object.assign(window, { __pinBlocked: true });
      const blocked = (key: string) => key.startsWith('recued.work.pinned.v1:') && (window as unknown as { __pinBlocked: boolean }).__pinBlocked;
      Storage.prototype.setItem = function(key, value) { if (blocked(key)) throw Error('Blocked'); set.call(this, key, value); };
      Storage.prototype.removeItem = function(key) { if (blocked(key)) throw Error('Blocked'); remove.call(this, key); };
    });
    const control = detail(page, 'note').locator('[data-record-pin-key]'); await control.click(); await expect(detail(page, 'note').getByRole('alert')).toContainText('Could not save');
    await expect(control).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(() => { (window as unknown as { __pinBlocked: boolean }).__pinBlocked = false; }); await control.click(); await expect(control).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => { (window as unknown as { __pinBlocked: boolean }).__pinBlocked = true; }); await control.click(); await expect(detail(page, 'note').getByRole('alert')).toContainText('Could not remove');
    await expect(control).toHaveAttribute('aria-pressed', 'true'); await search(page); await reload(page); await expect(rows(page)).toHaveCount(1); noWrites(f);
  } finally { f.dispose(); }
});

test('pins survive opening another tab on the same paired server', async ({ page, context }) => {
  const f = await boot(page); let other: Page | undefined, second: Fixture | undefined;
  try {
    await pinReader(page, f, 'note'); other = await context.newPage(); second = await boot(other);
    await expect(openPin(other, 'note', 'Notebook')).toBeVisible(); await expect(other.locator('[data-recent-work-panel]')).toHaveCount(0); noWrites(f); noWrites(second);
  } finally { second?.dispose(); await other?.close(); f.dispose(); }
});

test('pins stay with their pairing when switching servers away and back', async ({ page }) => {
  const f = await boot(page);
  try {
    await pinReader(page, f, 'note'); await search(page); await page.locator(`[${ACCOUNT_MENU_TRIGGER}]`).click();
    const menu = page.locator('[data-recued-account-menu-popover]'), profiles = menu.locator('[data-recued-server-switcher-item]');
    const office = (await profiles.filter({ hasText: 'Office server' }).getAttribute('data-profile-id'))!;
    const original = (await profiles.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-profile-id')))).find(id => id && id !== office)!;
    const switchTo = async (id: string) => {
      await menu.locator(`[data-recued-server-switcher-item][data-profile-id="${id}"]`).click(); const loaded = page.waitForEvent('load');
      await menu.locator('[data-recued-server-switcher-switch-commit]').click(); await loaded; await page.waitForFunction(() => window.__app?.ready === true);
    };
    await switchTo(office); await search(page); await expect(panel(page)).toHaveCount(0); await pinReader(page, f, 'task');
    await search(page); await page.locator(`[${ACCOUNT_MENU_TRIGGER}]`).click(); await switchTo(original); await search(page);
    await expect(rows(page)).toHaveCount(1); await expect(openPin(page, 'note', 'Notebook')).toBeVisible(); noWrites(f);
  } finally { f.dispose(); }
});

for (const kind of ['mail', 'calendar'] as const) test(`a pinned ${kind} return still protects an unfinished edit`, async ({ page }) => {
  const f = await boot(page); if (kind === 'calendar') f.editableCalendar();
  try {
    await pinReader(page, f, kind); await search(page); await openPin(page, kind, title(f, kind)).click();
    if (kind === 'mail') { await detail(page, kind).getByRole('button', { name: 'Reply', exact: true }).click(); await page.getByRole('dialog', { name: /Reply/ }).locator('[data-form-field="body"]').fill('Keep this reply.'); }
    else { await detail(page, kind).getByRole('button', { name: 'Edit event', exact: true }).click(); await detail(page, kind).locator('[data-calendar-event-field="summary"]').fill('Keep this event edit.'); }
    const prompts: string[] = []; page.once('dialog', async dialog => { prompts.push(dialog.message()); await dialog.dismiss(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(1); await expect(detail(page, kind)).toBeVisible();
    page.once('dialog', async dialog => { prompts.push(dialog.message()); await dialog.accept(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(2); await expect(openPin(page, kind, title(f, kind))).toBeFocused(); noWrites(f);
  } finally { f.dispose(); }
});
