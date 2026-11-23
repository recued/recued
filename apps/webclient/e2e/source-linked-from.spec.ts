import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 600 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
type Tab = 'mail' | 'calendar';
const section = (page: Page) => page.locator('[data-source-linked-from]');
const sourceScroll = (page: Page) => section(page).evaluate(node => { let host: HTMLElement | null = node.parentElement; while (host) { if (host.scrollHeight > host.clientHeight && /^(auto|scroll|overlay|hidden)$/.test(getComputedStyle(host).overflowY)) return host.scrollTop; host = host.parentElement; } return document.scrollingElement!.scrollTop; });
const reader = (page: Page, kind = 'note') => page.locator('.work-entity-' + kind + '-reader');
const open = (page: Page, kind = 'note') => section(page).getByRole('button', { name: 'Open ' + kind + ' Incoming ' + kind, exact: true });
const url = (f: Fixture, tab: Tab, slug = 'work') => HARNESS_URL + serializeSourceRecordAddress(f.source(tab, slug));
const body = (link: string) => Array.from({ length: 24 }, (_, i) => 'Context ' + i + '. '.repeat(18)).join('\n\n') + '\n\nExact source: ' + link;
const boot = async (page: Page, tab: Tab, prepare?: (f: Fixture) => void) => {
  const f = await installTaskNoteSourceFixture(page);
  f.seedNote('incoming-note', { title: 'Incoming note', body: body(url(f, tab)) });
  f.seedTask('incoming-task', { title: 'Incoming task', body: body(url(f, tab)) });
  f.seedNote('other-account', { title: 'Other account', body: url(f, tab, 'home') });
  prepare?.(f);
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + serializeSourceRecordAddress(f.source(tab)));
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(section(page)).toBeVisible(); return f;
};
const expand = async (page: Page) => { await section(page).locator('summary').click(); await expect(open(page)).toBeVisible(); };
const notify = async (page: Page) => page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'warehouse', collection: 'note', op: 'update', id: 'incoming-note', cursor: Date.now() } }));

for (const tab of ['mail', 'calendar'] as const) {
  test(tab + ' lazily discovers exact account-qualified incoming links', async ({ page }) => {
    const f = await boot(page, tab, f => {
      f.seedNote('external', { body: url(f, tab).replace('127.0.0.1', 'other.invalid') });
      f.seedNote('name-only', { body: 'Exact work email Exact work occurrence', related_mail_thread_ids: ['same-provider-thread'] });
    });
    try {
      expect(f.queries.filter(row => row.method === 'work_entity.linked_from')).toEqual([]);
      await expand(page); await expect(section(page).locator('li')).toHaveCount(2);
      await expect(section(page)).toContainText('Exact source:'); await expect(section(page)).not.toContainText('Other account');
      expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
    } finally { f.dispose(); }
  });

  for (const kind of ['note', 'task'] as const) test(tab + ' opens ' + kind + ' at the exact link and restores source scroll and keyboard focus', async ({ page }) => {
    const f = await boot(page, tab);
    try {
      await expand(page); await open(page, kind).focus();
      await open(page, kind).scrollIntoViewIfNeeded(); const top = await sourceScroll(page); expect(top).toBeGreaterThan(0);
      await open(page, kind).press('Enter'); await expect(reader(page, kind)).toHaveAttribute('data-' + kind + '-id', 'incoming-' + kind);
      const match = reader(page, kind).getByRole('link', { name: url(f, tab), exact: true });
      await expect(match).toBeFocused(); await expect(match).toBeInViewport();
      await reader(page, kind).getByRole('button', { name: 'Back to ' + (tab === 'mail' ? 'email' : 'event'), exact: true }).click();
      await expect(open(page, kind)).toBeFocused();
      await expect(page).toHaveURL(new RegExp(serializeSourceRecordAddress(f.source(tab)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
      await expect.poll(() => sourceScroll(page)).toBeCloseTo(top, 0);
      expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
    } finally { f.dispose(); }
  });

  test(tab + ' rechecks changed source links and account replacement after slow reads', async ({ page }) => {
    const f = await boot(page, tab);
    try {
      await expand(page); f.hold('work_entity.get', 'incoming-note'); await open(page).click(); await expect.poll(f.waiting).toBe(true);
      if (tab === 'mail') f.replaceMail(); else f.replaceCalendar();
      f.release(); await expect(section(page).getByRole('alert')).toContainText('source changed');
      await expect(reader(page)).toHaveCount(0); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });

  test(tab + ' browser Back cancels pending source verification', async ({ page }) => {
    const f = await boot(page, tab);
    try {
      await expand(page); f.hold('work_entity.get', 'incoming-note'); await open(page).click(); await expect.poll(f.waiting).toBe(true);
      await page.goBack(); await expect(open(page)).toBeFocused(); f.release();
      await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.includes('work_entity.get:incoming-note'));
      await expect(section(page)).toBeVisible(); await expect(reader(page)).toHaveCount(0);
    } finally { f.dispose(); }
  });
}

test('incoming links paginate, retain errors, refresh edits and restore focus when a row disappears', async ({ page }) => {
  const f = await boot(page, 'mail', f => { for (let i = 0; i < 12; i++) f.seedNote('extra-' + i, { title: 'Extra ' + i, body: url(f, 'mail') }); });
  try {
    await section(page).locator('summary').click(); await expect(section(page).locator('li')).toHaveCount(10);
    await section(page).getByRole('button', { name: 'More linked records', exact: true }).click(); await expect(section(page).locator('li')).toHaveCount(14);
    f.fail('work_entity.linked_from', ''); await section(page).getByRole('button', { name: 'Refresh linked records', exact: true }).click();
    await expect(section(page).getByRole('alert')).toContainText('Could not load'); await expect(section(page)).not.toContainText('No saved Notes');
    f.fail('work_entity.linked_from', '', false); await open(page).focus(); f.updateNote('incoming-note', { title: 'Renamed note', updated_at: f.note('incoming-note').updated_at + 1000 }); await notify(page);
    const renamed = section(page).getByRole('button', { name: 'Open note Renamed note', exact: true });
    await expect(renamed).toBeFocused(); f.updateNote('incoming-note', { body: 'Link removed.' }); await notify(page);
    await expect(renamed).toHaveCount(0); await expect(section(page).locator('summary')).toBeFocused();
  } finally { f.dispose(); }
});

test('a deleted incoming source is refused instead of opening a stale preview', async ({ page }) => {
  const f = await boot(page, 'calendar');
  try {
    await expand(page); f.removeNote('incoming-note'); await open(page).click();
    await expect(section(page).getByRole('alert')).toContainText('no longer available'); await expect(reader(page)).toHaveCount(0);
  } finally { f.dispose(); }
});

test('late link results cannot repaint another mailbox with the same provider record id', async ({ page }) => {
  const f = await boot(page, 'mail');
  try {
    f.hold('work_entity.linked_from', ''); await section(page).locator('summary').click(); await expect.poll(f.waiting).toBe(true);
    await page.evaluate(hash => window.__app.setHash(hash), serializeSourceRecordAddress(f.source('mail', 'home')));
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toContainText('Other account body.');
    f.release(); await section(page).locator('summary').click();
    await expect(section(page)).toContainText('Other account'); await expect(section(page)).not.toContainText('Incoming note');
  } finally { f.dispose(); }
});

test('Note to email to incoming Note retraces both readers and preserves outer Find', async ({ page }) => {
  const f = await boot(page, 'mail');
  try {
    await page.evaluate(() => window.__app.setHash('#data/note/incoming-note')); await expect(reader(page)).toBeVisible();
    await reader(page).locator('[data-action="note-find-open"]').click(); await reader(page).locator('[data-note-find-input]').fill('Context');
    await reader(page).getByRole('link', { name: url(f, 'mail'), exact: true }).click(); await expand(page); await open(page).click();
    await expect(reader(page).getByRole('link', { name: url(f, 'mail'), exact: true })).toBeFocused();
    await reader(page).getByRole('button', { name: 'Back to email', exact: true }).click(); await expect(open(page)).toBeFocused();
    await page.getByRole('button', { name: 'Back to note', exact: true }).click();
    await expect(reader(page).locator('[data-note-find-input]')).toHaveValue('Context');
  } finally { f.dispose(); }
});


test('keeps inbox filters and email Find across an incoming-note detour', async ({ page }) => {
  const f = await boot(page, 'mail');
  try {
    await page.getByRole('region', { name: 'Record detail', exact: true }).getByRole('button', { name: '← Back', exact: true }).click();
    const direction = page.getByRole('combobox', { name: 'Mail direction', exact: true }); await direction.selectOption('received');
    await page.locator('[data-recued-data-action="collection-open-record"]').click();
    await page.getByRole('button', { name: 'Find in email', exact: true }).click();
    const find = page.getByRole('searchbox', { name: 'Find in this email', exact: true }); await find.fill('work');
    await expand(page); await open(page).click(); await expect(reader(page)).toBeVisible();
    await reader(page).getByRole('button', { name: 'Back to email', exact: true }).click(); await expect(find).toHaveValue('work'); await expect(open(page)).toBeFocused();
    await page.getByRole('region', { name: 'Record detail', exact: true }).getByRole('button', { name: '← Back', exact: true }).click();
    await expect(direction).toHaveValue('received'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
