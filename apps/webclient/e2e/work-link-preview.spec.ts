import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute } from '../src/shell/route.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 900 }, locale: 'en-US', timezoneId: 'America/Los_Angeles' });
type Source = 'task' | 'note' | 'formatted';
type Kind = 'task' | 'note';
type Target = Kind | 'contact';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const sourceKind = (source: Source): Kind => source === 'task' ? 'task' : 'note';
const sourceId = (kind: Kind) => kind === 'task' ? 'task-one' : 'origin-note';
const targetId = (f: Fixture, target: Target) => target === 'contact' ? f.person.contact_id! : 'linked/' + target + '?二';
const href = (f: Fixture, target: Target) => HARNESS_URL.split('?')[0].split('#')[0] + serializeShellRoute('data', target, targetId(f, target));
const reader = (page: Page, kind: Kind = 'note') => page.locator('.work-entity-' + kind + '-reader');
const link = (page: Page, f: Fixture, kind: Kind, target: Target) => reader(page, kind).locator('a[href="' + href(f, target) + '"]');
const trigger = (page: Page, f: Fixture, kind: Kind, target: Target) => reader(page, kind).locator('a[href="' + href(f, target) + '"] + button[data-work-link-preview-trigger]');
const panel = (page: Page) => page.locator('dialog[data-work-link-preview]');
const close = (page: Page) => panel(page).getByRole('button', { name: 'Close preview', exact: true });
const query = (page: Page, kind: Kind) => reader(page, kind).getByRole('searchbox', { name: 'Find in this ' + kind, exact: true });
const content = (page: Page, kind: Kind) => reader(page, kind).locator('.work-entity-' + kind + '-content');
const noWrites = (f: Fixture) => { expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]); };
const targetReads = (f: Fixture, target: Target) => f.reads.filter(row => row.method === (target === 'contact' ? 'contact.get' : 'work_entity.get') && row.id === targetId(f, target)).length;
const boot = async (page: Page, source: Source = 'note', prepare?: (f: Fixture) => void | Promise<void>) => {
  const f = await installTaskNoteSourceFixture(page), kind = sourceKind(source);
  f.seedTask(targetId(f, 'task'), { title: 'Linked task <img src=x>', body: 'Saved task text.', due_at: Date.UTC(2030, 10, 1) });
  f.seedNote(targetId(f, 'note'), { title: 'Linked note', body: 'Private note <img src=x> 二 '.repeat(30) + 'HIDDEN TAIL NOT PART OF PREVIEW' });
  const body = Array.from({ length: 20 }, (_, index) => 'Needle ' + index + '. ' + 'Saved reader context. '.repeat(8)).join('\n\n')
    + '\n\n' + (['contact', 'task', 'note'] as const).map(target => href(f, target)).join('\n\n')
    + '\n\nhttps://external.invalid/#data/task/foreign';
  f.update({ title: 'Starting task', body, assigned_contact_id: undefined, parent_project_id: undefined, blocks_task_ids: [] });
  f.seedNote('origin-note', { title: 'Starting note', body }); f.seedNote('other-note', { title: 'Another note', body: 'Another saved record.' });
  await prepare?.(f);
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + serializeShellRoute('data', kind, sourceId(kind)));
  await page.waitForFunction(() => window.__app?.ready === true); await expect(reader(page, kind)).toBeVisible();
  if (source === 'formatted') await reader(page, kind).getByRole('button', { name: 'Formatted', exact: true }).click();
  return f;
};
const prepare = async (page: Page, f: Fixture, kind: Kind, target: Target) => {
  await reader(page, kind).getByRole('button', { name: 'Find in ' + kind, exact: true }).click();
  await query(page, kind).fill('Needle'); await query(page, kind).press('Enter'); await query(page, kind).press('Enter');
  await expect(reader(page, kind).locator('[data-' + kind + '-find-status]')).toHaveText('3 of 20 matches.');
  await trigger(page, f, kind, target).focus(); return content(page, kind).evaluate(node => node.scrollTop);
};
const expectSource = async (page: Page, f: Fixture, kind: Kind, target: Target, top: number) => {
  await expect(trigger(page, f, kind, target)).toBeFocused(); await expect(query(page, kind)).toHaveValue('Needle');
  await expect(reader(page, kind).locator('[data-' + kind + '-find-status]')).toHaveText('3 of 20 matches.');
  await expect.poll(() => content(page, kind).evaluate(node => node.scrollTop)).toBeCloseTo(top, -1);
};
const waitSettled = (page: Page, method: string, id: string, count: number) => page.waitForFunction(({ key, count }) =>
  (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === key).length > count, { key: method + ':' + id, count });
const settled = (page: Page, method: string, id: string) => page.evaluate(key =>
  (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === key).length, method + ':' + id);

for (const source of ['task', 'note', 'formatted'] as const) for (const target of ['contact', 'task', 'note'] as const)
  test(source + ' previews the exact ' + target + ' only on request and closes without losing Find or position', async ({ page }, info) => {
    const f = await boot(page, source), kind = sourceKind(source), saved = kind === 'task' ? f.task() : f.note('origin-note');
    try {
      await expect(trigger(page, f, kind, target)).toBeVisible(); expect(targetReads(f, target)).toBe(0);
      const top = await prepare(page, f, kind, target); expect(top).toBeGreaterThan(100); const url = page.url();
      await trigger(page, f, kind, target).press('Enter'); await expect(panel(page)).toBeVisible();
      await expect(panel(page).getByRole('heading', { name: target === 'contact' ? f.person.name! : target === 'task' ? 'Linked task <img src=x>' : 'Linked note', exact: true })).toBeVisible();
      if (target === 'contact') await expect(panel(page)).toContainText(f.person.email);
      if (target === 'task') { await expect(panel(page).getByText('Open', { exact: true })).toBeVisible(); await expect(panel(page).getByText(/^Due date:/u)).toContainText('2030'); }
      if (target === 'note') { await expect(panel(page)).toContainText('Private note <img src=x>'); await expect(panel(page)).not.toContainText('HIDDEN TAIL'); }
      expect(targetReads(f, target)).toBe(1); await expect(panel(page).locator('img,script')).toHaveCount(0); expect(page.url()).toBe(url);
      await expect(content(page, kind)).toHaveJSProperty('scrollTop', top);
      if (source === 'note') { await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: info.outputPath('preview-' + target + '-phone.png'), fullPage: true }); }
      await close(page).click(); await expect(panel(page)).toHaveCount(0); await expectSource(page, f, kind, target, top);
      expect(kind === 'task' ? f.task() : f.note('origin-note')).toEqual(saved); noWrites(f);
    } finally { f.dispose(); }
  });

test('keyboard Tab and Escape stay inside the preview and Ctrl+F returns to the reader Find', async ({ page }) => {
  const f = await boot(page);
  try {
    await prepare(page, f, 'note', 'task'); await trigger(page, f, 'note', 'task').press('Enter');
    await expect(panel(page).getByRole('button', { name: 'Open task', exact: true })).toBeVisible();
    await page.keyboard.press('Shift+Tab'); await expect(panel(page).getByRole('button', { name: 'Open task', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(close(page)).toBeFocused();
    await page.keyboard.press('Tab'); await expect(panel(page).getByRole('button', { name: 'Open task', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(close(page)).toBeFocused();
    await page.keyboard.press('Escape'); await expect(panel(page)).toHaveCount(0); await expect(query(page, 'note')).toHaveValue('Needle');
    await trigger(page, f, 'note', 'task').press('Enter'); await expect(panel(page)).toBeVisible(); await page.keyboard.press('ControlOrMeta+f');
    await expect(panel(page)).toHaveCount(0); await expect(query(page, 'note')).toBeFocused(); await expect(query(page, 'note')).toHaveValue('Needle'); noWrites(f);
  } finally { f.dispose(); }
});

for (const target of ['contact', 'task', 'note'] as const) test('Open rechecks the previewed ' + target + ' and Back restores its Preview trigger', async ({ page }) => {
  const f = await boot(page);
  try {
    const top = await prepare(page, f, 'note', target); await trigger(page, f, 'note', target).click();
    await expect(panel(page).getByRole('button', { name: 'Open ' + target, exact: true })).toBeVisible();
    if (target === 'contact') await f.seedContact(f.person.email, 'Fresh contact');
    if (target === 'task') f.updateTask(targetId(f, target), { title: 'Fresh task' });
    if (target === 'note') f.updateNote(targetId(f, target), { title: 'Fresh note' });
    await panel(page).getByRole('button', { name: 'Open ' + target, exact: true }).click(); await expect(panel(page)).toHaveCount(0);
    const destination = target === 'contact' ? page.locator('[data-recued-data-contact-detail]') : reader(page, target);
    await expect(destination).toContainText('Fresh ' + target); expect(targetReads(f, target)).toBe(2);
    await page.getByRole('button', { name: /^(?:← )?Back to note$/u }).click(); await expectSource(page, f, 'note', target, top); noWrites(f);
  } finally { f.dispose(); }
});

test('a failed read offers retry without surfacing transport diagnostics', async ({ page }) => {
  const f = await boot(page);
  try {
    f.fail('work_entity.get', targetId(f, 'task')); await trigger(page, f, 'note', 'task').click();
    await expect(panel(page).getByRole('alert')).toHaveText('This record could not be loaded. Try again.');
    await expect(panel(page).getByRole('button', { name: 'Open task', exact: true })).toHaveCount(0);
    f.fail('work_entity.get', targetId(f, 'task'), false); await panel(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(panel(page)).toContainText('Linked task <img src=x>'); expect(targetReads(f, 'task')).toBe(2); noWrites(f);
  } finally { f.dispose(); }
});

test('a deleted Note remains unavailable until a requested retry reads its replacement', async ({ page }) => {
  const f = await boot(page);
  try {
    f.removeNote(targetId(f, 'note')); await trigger(page, f, 'note', 'note').click();
    await expect(panel(page)).toContainText('This note is no longer available.');
    await expect(panel(page).getByRole('button', { name: 'Open note', exact: true })).toHaveCount(0);
    f.seedNote(targetId(f, 'note'), { title: 'Restored note', body: 'Current saved text.' });
    await panel(page).getByRole('button', { name: 'Try again', exact: true }).click(); await expect(panel(page)).toContainText('Restored note'); noWrites(f);
  } finally { f.dispose(); }
});

test('a response for another task never becomes an openable preview', async ({ page }) => {
  const f = await boot(page);
  try {
    f.taskReply(targetId(f, 'task'), { entity: { ...f.task(), _kind: 'task' } }); await trigger(page, f, 'note', 'task').click();
    await expect(panel(page).getByRole('alert')).toContainText('could not be confirmed');
    await expect(panel(page)).not.toContainText('Starting task'); await expect(panel(page).getByRole('button', { name: 'Open task', exact: true })).toHaveCount(0); noWrites(f);
  } finally { f.dispose(); }
});

test('a merged contact is identified before the owner opens its saved link', async ({ page }) => {
  const f = await boot(page);
  try {
    f.contactReply(f.person.contact_id!, { ...f.person, merged_into: 'kept-contact' }); await trigger(page, f, 'note', 'contact').click();
    await expect(panel(page)).toContainText('This contact was merged.'); await expect(panel(page).getByRole('button', { name: 'Open contact', exact: true })).toBeVisible(); noWrites(f);
  } finally { f.dispose(); }
});

test('a late failure after Close cannot replace or steal focus from a newer preview', async ({ page }) => {
  const f = await boot(page);
  try {
    f.hold('work_entity.get', targetId(f, 'task')); f.fail('work_entity.get', targetId(f, 'task'));
    await trigger(page, f, 'note', 'task').click(); await expect.poll(f.waiting).toBe(true); await expect(panel(page)).toContainText('Loading preview');
    await close(page).click(); await trigger(page, f, 'note', 'note').click(); await expect(panel(page)).toContainText('Linked note'); await close(page).focus();
    const before = await settled(page, 'work_entity.get', targetId(f, 'task')); f.release(); await waitSettled(page, 'work_entity.get', targetId(f, 'task'), before);
    await expect(panel(page)).toContainText('Linked note'); await expect(panel(page).getByRole('alert')).toHaveCount(0); await expect(close(page)).toBeFocused(); noWrites(f);
  } finally { f.dispose(); }
});

test('leaving the reader closes its pending preview and fences the late response', async ({ page }) => {
  const f = await boot(page);
  try {
    f.hold('work_entity.get', targetId(f, 'note')); await trigger(page, f, 'note', 'note').click(); await expect.poll(f.waiting).toBe(true);
    await page.evaluate(() => window.__app.setHash('#data/note/other-note')); await expect(reader(page)).toHaveAttribute('data-note-id', 'other-note');
    const before = await settled(page, 'work_entity.get', targetId(f, 'note')); f.release(); await waitSettled(page, 'work_entity.get', targetId(f, 'note'), before);
    await expect(panel(page)).toHaveCount(0); await expect(reader(page)).toContainText('Another saved record.'); noWrites(f);
  } finally { f.dispose(); }
});

test('a background related-record repaint preserves preview focus and excludes its text from Find', async ({ page }) => {
  const f = await boot(page, 'note', f => { f.updateNote('origin-note', { related_contact_ids: [f.person.contact_id!] }); f.hold('contact.get', f.person.contact_id!); });
  try {
    await reader(page).getByRole('button', { name: 'Find in note', exact: true }).click(); await query(page, 'note').fill('Private note');
    await reader(page).locator('[data-note-section="related"] summary').click(); await expect.poll(f.waiting).toBe(true);
    await trigger(page, f, 'note', 'note').click(); await expect(panel(page)).toContainText('Private note'); await close(page).focus();
    const before = await settled(page, 'contact.get', f.person.contact_id!); f.release(); await waitSettled(page, 'contact.get', f.person.contact_id!, before);
    await expect(panel(page)).toContainText('Linked note'); await expect(close(page)).toBeFocused();
    await expect(reader(page).locator('[data-note-find-status]')).toHaveText('No matches.'); expect(targetReads(f, 'note')).toBe(1); noWrites(f);
  } finally { f.dispose(); }
});

test('Preview controls are not saved text matches and external links get no preview lookup', async ({ page }) => {
  const f = await boot(page, 'formatted');
  try {
    await reader(page).getByRole('button', { name: 'Find in note', exact: true }).click(); await query(page, 'note').fill('Preview');
    await expect(reader(page).locator('[data-note-find-status]')).toHaveText('No matches.');
    await expect(reader(page).locator('[data-work-link-preview-trigger]')).toHaveCount(3);
    await expect(reader(page).locator('a[href^="https://external.invalid"] + [data-work-link-preview-trigger]')).toHaveCount(0);
    expect(['contact', 'task', 'note'].map(kind => targetReads(f, kind as Target))).toEqual([0, 0, 0]); noWrites(f);
  } finally { f.dispose(); }
});

test('a browser without native dialogs keeps ordinary record links usable', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: undefined }); });
  const f = await boot(page);
  try {
    await expect(reader(page).locator('[data-work-link-preview-trigger]')).toHaveCount(0);
    await link(page, f, 'note', 'task').click(); await expect(reader(page, 'task')).toContainText('Linked task <img src=x>');
    await page.getByRole('button', { name: 'Back to note', exact: true }).click(); await expect(link(page, f, 'note', 'task')).toBeFocused(); noWrites(f);
  } finally { f.dispose(); }
});
