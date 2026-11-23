import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute } from '../src/shell/route.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 900 } });
type Kind = 'task' | 'note';
type Target = Kind | 'contact';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const originId = (kind: Kind) => kind === 'task' ? 'task-one' : 'origin-note';
const targetId = (f: Fixture, kind: Target) => kind === 'contact' ? f.person.contact_id! : 'linked/' + kind + '?二';
const hash = (f: Fixture, kind: Target) => serializeShellRoute('data', kind, targetId(f, kind));
const url = (f: Fixture, kind: Target) => HARNESS_URL.split('?')[0].split('#')[0] + hash(f, kind);
const reader = (page: Page, kind: Kind) => page.locator('.work-entity-' + kind + '-reader');
const link = (page: Page, f: Fixture, from: Kind, to: Target) => reader(page, from).locator('a[href="' + url(f, to) + '"]');
const back = (page: Page, kind: Kind) => page.getByRole('button', { name: new RegExp('^(?:← )?Back to ' + kind + '$') });
const editor = (page: Page, kind: Kind) => page.locator('.work-entity-dialog[data-kind="' + kind + '"][data-mode="edit"]');
const noWrites = (f: Fixture) => { expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]); };
const boot = async (page: Page, kind: Kind = 'note') => {
  const f = await installTaskNoteSourceFixture(page);
  f.seedTask(targetId(f, 'task'), { title: 'Linked task', body: 'The current linked task.' });
  f.seedNote(targetId(f, 'note'), { title: 'Linked note', body: 'The current linked note.' });
  const body = Array.from({ length: 20 }, (_, index) => 'Needle ' + index + '. ' + 'Saved reader context. '.repeat(8)).join('\n\n')
    + '\n\n' + (['contact', 'task', 'note'] as const).map(target => url(f, target)).join('\n\n')
    + '\n\nhttps://external.invalid/context\n\n' + HARNESS_URL.split('?')[0].split('#')[0] + serializeShellRoute('data', kind, originId(kind));
  f.seedNote('origin-note', { title: 'Starting note', body }); f.update({ title: 'Starting task', body });
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + serializeShellRoute('data', kind, originId(kind)));
  await page.waitForFunction(() => window.__app?.ready === true); await expect(reader(page, kind)).toBeVisible(); return f;
};
const prepare = async (page: Page, f: Fixture, from: Kind, to: Target) => {
  await reader(page, from).getByRole('button', { name: 'Find in ' + from, exact: true }).click();
  const field = reader(page, from).getByRole('searchbox', { name: 'Find in this ' + from, exact: true });
  await field.fill('Needle'); await field.press('Enter'); await field.press('Enter');
  await expect(reader(page, from).locator('[data-' + from + '-find-status]')).toHaveText('3 of 20 matches.');
  await link(page, f, from, to).focus();
  return reader(page, from).locator('.work-entity-' + from + '-content').evaluate(node => node.scrollTop);
};
const restored = async (page: Page, f: Fixture, from: Kind, to: Target, top: number) => {
  await expect(reader(page, from)).toHaveAttribute('data-' + from + '-id', originId(from));
  await expect(link(page, f, from, to)).toBeFocused();
  await expect(reader(page, from).getByRole('searchbox', { name: 'Find in this ' + from, exact: true })).toHaveValue('Needle');
  await expect(reader(page, from).locator('[data-' + from + '-find-status]')).toHaveText('3 of 20 matches.');
  await expect.poll(() => reader(page, from).locator('.work-entity-' + from + '-content').evaluate(node => node.scrollTop)).toBeCloseTo(top, -1);
};

for (const from of ['task', 'note'] as const) for (const to of ['contact', 'task', 'note'] as const)
  test('a ' + from + ' follows its copied ' + to + ' link in place and restores Find, position and keyboard focus', async ({ page, context }, info) => {
    const f = await boot(page, from), pages = context.pages().length;
    try {
      const top = await prepare(page, f, from, to), before = from === 'task' ? f.task() : f.note('origin-note');
      expect(top).toBeGreaterThan(100);
      await link(page, f, from, to).press('Enter'); await expect(back(page, from)).toBeVisible();
      if (to === 'contact') await expect(page.locator('[data-recued-data-contact-detail]')).toContainText('Riley <img src=x>');
      else await expect(reader(page, to)).toHaveAttribute('data-' + to + '-id', targetId(f, to));
      if (to !== 'contact' && from !== to) await expect(page.locator('.work-entity-list-view[data-kind="' + to + '"]')).toContainText('Linked ' + to);
      expect(await page.evaluate(() => location.hash)).toBe(to === 'contact' ? serializeShellRoute('data', 'contact', f.person.email) : hash(f, to));
      expect(context.pages()).toHaveLength(pages);
      expect(f.reads.some(call => call.method === (to === 'contact' ? 'contact.get' : 'work_entity.get') && call.id === targetId(f, to))).toBe(true);
      await page.screenshot({ path: info.outputPath(from + '-to-' + to + '-phone.png'), fullPage: true });
      await back(page, from).click(); await restored(page, f, from, to, top);
      expect(from === 'task' ? f.task() : f.note('origin-note')).toEqual(before); noWrites(f);
    } finally { f.dispose(); }
  });

test('nested note, task and contact links retrace each reader with browser Back', async ({ page }) => {
  const f = await boot(page);
  try {
    f.updateNote(targetId(f, 'note'), { body: url(f, 'task') });
    f.updateTask(targetId(f, 'task'), { body: url(f, 'contact') });
    await link(page, f, 'note', 'note').click(); await expect(reader(page, 'note')).toHaveAttribute('data-note-id', targetId(f, 'note'));
    await link(page, f, 'note', 'task').click(); await expect(reader(page, 'task')).toBeVisible();
    await link(page, f, 'task', 'contact').click(); await expect(page.locator('[data-recued-data-contact-detail]')).toBeVisible();
    await page.goBack(); await expect(link(page, f, 'task', 'contact')).toBeFocused();
    await page.goBack(); await expect(reader(page, 'note')).toHaveAttribute('data-note-id', targetId(f, 'note'));
    await page.goBack(); await expect(reader(page, 'note')).toHaveAttribute('data-note-id', 'origin-note'); await expect(link(page, f, 'note', 'note')).toBeFocused(); noWrites(f);
  } finally { f.dispose(); }
});

for (const to of ['note', 'contact'] as const) test('browser Back fences a pending ' + to + ' link read', async ({ page }) => {
  const f = await boot(page);
  try {
    const top = await prepare(page, f, 'note', to), method = to === 'contact' ? 'contact.get' : 'work_entity.get', id = targetId(f, to);
    f.hold(method, id); await link(page, f, 'note', to).click(); await expect.poll(f.waiting).toBe(true);
    await page.goBack(); await restored(page, f, 'note', to, top);
    const count = await page.evaluate(key => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === key).length, method + ':' + id);
    f.release(); await page.waitForFunction(({ key, count }) => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === key).length > count, { key: method + ':' + id, count });
    await restored(page, f, 'note', to, top); noWrites(f);
  } finally { f.dispose(); }
});

for (const to of ['task', 'note'] as const) test('browser Back protects and retains a recoverable linked ' + to + ' draft', async ({ page }) => {
  const f = await boot(page), prompts: string[] = [];
  try {
    await link(page, f, 'note', to).click(); await reader(page, to).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page, to).getByLabel('Title').fill('Keep this unsaved linked edit');
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(1); await expect(editor(page, to).getByLabel('Title')).toHaveValue('Keep this unsaved linked edit');
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.accept(); }); await page.goBack();
    await expect(reader(page, 'note')).toHaveAttribute('data-note-id', 'origin-note'); await expect(link(page, f, 'note', to)).toBeFocused();
    await link(page, f, 'note', to).click();
    if (to === 'note') await reader(page, to).getByRole('region', { name: 'Unfinished notes', exact: true }).getByRole('button', { name: 'Resume draft', exact: true }).click();
    else {
      await reader(page, to).getByRole('button', { name: 'Edit', exact: true }).click();
      await editor(page, to).getByRole('button', { name: 'Resume draft', exact: true }).click();
    }
    await expect(editor(page, to).getByLabel('Title')).toHaveValue('Keep this unsaved linked edit'); noWrites(f);
  } finally { f.dispose(); }
});

test('explicitly discarding a linked note editor returns to the task without leaving a recovery draft', async ({ page }) => {
  const f = await boot(page, 'task');
  try {
    await link(page, f, 'task', 'note').click(); await reader(page, 'note').getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page, 'note').getByLabel('Title').fill('Discard this linked note edit');
    await editor(page, 'note').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(link(page, f, 'task', 'note')).toBeFocused(); await link(page, f, 'task', 'note').click();
    await expect(reader(page, 'note').getByRole('region', { name: 'Unfinished notes', exact: true })).toHaveCount(0);
    await reader(page, 'note').getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(page, 'note').getByLabel('Title')).toHaveValue('Linked note');
    await expect(editor(page, 'note').getByRole('button', { name: 'Resume draft', exact: true })).toHaveCount(0); noWrites(f);
  } finally { f.dispose(); }
});

for (const fault of ['missing', 'wrong record', 'interrupted'] as const) test('a ' + fault + ' linked read retains a return to its saved note', async ({ page }) => {
  const f = await boot(page), to = fault === 'interrupted' ? 'note' : 'task';
  try {
    if (fault === 'missing') f.removeTask(targetId(f, to));
    if (fault === 'wrong record') f.taskReply(targetId(f, to), { entity: { ...f.task(), _kind: 'task' } });
    if (fault === 'interrupted') f.fail('work_entity.get', targetId(f, to));
    const top = await prepare(page, f, 'note', to); await link(page, f, 'note', to).click();
    await expect(page.getByRole('alert').filter({ hasText: fault === 'interrupted' ? 'This read was interrupted.' : 'No task was returned' })).toBeVisible();
    await back(page, 'note').click(); await restored(page, f, 'note', to, top); noWrites(f);
  } finally { f.dispose(); }
});

test('a merged contact link retains its tombstone and a return to the starting note', async ({ page }) => {
  const f = await boot(page);
  try {
    const merged = { ...f.person, merged_into: 'kept-person' }; f.contactReply(f.person.contact_id!, merged); f.contactReply(f.person.email, merged);
    await link(page, f, 'note', 'contact').click(); await expect(page.locator('[data-recued-data-contact-detail]')).toContainText(/merged/iu);
    await back(page, 'note').click(); await expect(link(page, f, 'note', 'contact')).toBeFocused(); noWrites(f);
  } finally { f.dispose(); }
});

test('browser Back protects a linked contact editor until the owner approves leaving', async ({ page }) => {
  const f = await boot(page), prompts: string[] = [];
  try {
    await link(page, f, 'note', 'contact').click();
    await page.locator('[data-recued-data-contact-detail]').getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('[data-recued-data-contact-dialog]'), name = editor.getByRole('textbox', { name: /^Name/u });
    await name.fill('Keep this unsaved contact name');
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(1); await expect(name).toHaveValue('Keep this unsaved contact name');
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.accept(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(2); await expect(link(page, f, 'note', 'contact')).toBeFocused();
    await expect(editor).toHaveCount(0); noWrites(f);
  } finally { f.dispose(); }
});

test('external links and modified copied-record clicks retain normal browser tabs', async ({ page, context }) => {
  const f = await boot(page);
  try {
    await reader(page, 'note').getByRole('button', { name: 'Formatted', exact: true }).click();
    await context.route('https://external.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<p>External context</p>' }));
    const popup = page.waitForEvent('popup'); await reader(page, 'note').getByRole('link', { name: 'https://external.invalid/context', exact: true }).click();
    const external = await popup; await expect(external).toHaveURL('https://external.invalid/context'); await external.close();
    const opened = context.waitForEvent('page'); await link(page, f, 'note', 'task').click({ modifiers: ['ControlOrMeta'] });
    const target = await opened; await expect(target).toHaveURL(url(f, 'task')); await target.close();
    await expect(reader(page, 'note')).toHaveAttribute('data-note-id', 'origin-note'); noWrites(f);
  } finally { f.dispose(); }
});

test('a link to the note already being read does not create another return frame', async ({ page, context }) => {
  const f = await boot(page);
  try {
    const own = reader(page, 'note').locator('a[href$="#data/note/origin-note"]'), pages = context.pages().length;
    await own.click(); await expect(own).toBeFocused(); await expect(back(page, 'note')).toHaveCount(0);
    expect(context.pages()).toHaveLength(pages); await expect(reader(page, 'note')).toHaveAttribute('data-note-id', 'origin-note'); noWrites(f);
  } finally { f.dispose(); }
});
