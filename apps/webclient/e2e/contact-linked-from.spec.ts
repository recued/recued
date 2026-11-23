import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installContactFollowUpFixture } from './helpers/contact-follow-up-fixture.js';
import { serializeShellRoute } from '../src/shell/route.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Kind = 'task' | 'note';
type Fixture = Awaited<ReturnType<typeof installContactFollowUpFixture>>;
const profile = (page: Page) => page.locator('[data-recued-data-contact-detail]');
const section = (page: Page) => profile(page).locator('[data-contact-section="linked-from"]');
const reader = (page: Page, kind: Kind) => page.locator('.work-entity-' + kind + '-reader');
const title = (kind: Kind) => 'Source ' + kind + ' <img src=x>';
const id = (kind: Kind) => 'incoming/' + kind + '?二';
const source = (page: Page, kind: Kind) => section(page).getByRole('button', { name: 'Open ' + kind + ' ' + title(kind), exact: true });
const link = (contactId: string) => HARNESS_URL + serializeShellRoute('data', 'contact', contactId);
const savedBody = (url: string) => Array.from({ length: 24 }, (_, i) => 'Source paragraph ' + i + '. '.repeat(15)).join('\n\n') + '\n\nContact link context: ' + url + '\n\nAfter the link.';
const boot = async (page: Page, prepare?: (f: Fixture) => void | Promise<void>) => {
  const f = await installContactFollowUpFixture(page);
  f.update({ assigned_contact_id: undefined, parent_project_id: undefined, blocks_task_ids: [] });
  f.seedNote(id('note'), { title: title('note'), body: savedBody(link(f.person.contact_id!)), related_contact_ids: [] });
  f.seedTask(id('task'), { title: title('task'), body: savedBody(link(f.person.contact_id!)), assigned_contact_id: undefined, parent_project_id: undefined, blocks_task_ids: [] });
  await prepare?.(f);
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + serializeShellRoute('data', 'contact', f.person.email));
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(profile(page).getByRole('heading', { name: f.person.name!, exact: true })).toBeVisible();
  return f;
};
const expand = async (page: Page) => { await section(page).locator('summary').click(); await expect(source(page, 'task')).toBeVisible(); };
const notify = async (page: Page) => page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'warehouse', collection: 'note', op: 'update', id: 'source-note', cursor: Date.now() } }));

test('loads only on expansion and finds exact saved links rather than names, external deployments or structured membership', async ({ page }) => {
  const f = await boot(page, f => {
    f.seedNote('name-only', { body: 'Riley', related_contact_ids: [f.person.contact_id!] });
    f.seedNote('external', { body: link(f.person.contact_id!).replace('127.0.0.1', 'localhost') });
    f.seedNote('path', { body: link(f.person.contact_id!).replace('/full-app-harness.html', '/other-client.html') });
  });
  try {
    expect(f.queries.filter(row => row.method === 'work_entity.linked_from')).toHaveLength(0);
    await expand(page); await expect(section(page).locator('li')).toHaveCount(2);
    await expect(section(page)).toContainText('Contact link context:'); await expect(section(page).locator('img,script')).toHaveCount(0);
    expect(f.queries.find(row => row.method === 'work_entity.linked_from')!.args).toEqual({ url: link(f.person.contact_id!), limit: 10, offset: 0,
      contact_identity: { id: f.person.contact_id, created_at: f.person.created_at } });
    expect(f.reads.filter(row => row.method === 'work_entity.get' && row.id.startsWith('incoming/'))).toHaveLength(0);
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['task', 'note'] as const) test('contact → ' + kind + ' jumps to the link and returns to paged activity, filters, scroll and trigger focus', async ({ page }) => {
  const f = await boot(page);
  try {
    const activity = profile(page).locator('[data-contact-activity-scope]');
    await activity.getByRole('combobox', { name: 'Who acted', exact: true }).selectOption('user_self');
    await activity.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(activity.locator('.memory-timeline-entry')).toHaveCount(50);
    await activity.getByRole('button', { name: 'Load older activity', exact: true }).click();
    await expect(activity.locator('.memory-timeline-entry')).toHaveCount(100);
    await expand(page); await source(page, kind).focus();
    const top = await source(page, kind).evaluate(node => { let host: HTMLElement | null = node.parentElement;
      while (host && host.scrollHeight <= host.clientHeight + 1) host = host.parentElement; return host?.scrollTop ?? document.scrollingElement!.scrollTop; });
    await source(page, kind).press('Enter'); await expect(reader(page, kind)).toHaveAttribute('data-' + kind + '-id', id(kind));
    const matched = reader(page, kind).getByRole('link', { name: link(f.person.contact_id!), exact: true });
    await expect(matched).toBeFocused(); await expect(matched).toBeInViewport();
    await reader(page, kind).getByRole('button', { name: 'Back to contact', exact: true }).click();
    await expect(activity.locator('.memory-timeline-entry')).toHaveCount(100);
    await expect(activity.getByRole('combobox', { name: 'Who acted', exact: true })).toHaveValue('user_self');
    await expect(source(page, kind)).toBeFocused();
    await expect.poll(() => source(page, kind).evaluate(node => { let host: HTMLElement | null = node.parentElement;
      while (host && host.scrollHeight <= host.clientHeight + 1) host = host.parentElement; return host?.scrollTop ?? document.scrollingElement!.scrollTop; })).toBeCloseTo(top, 0);
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('merged identities and email aliases point to the contact, then disappear after split or withdrawal', async ({ page }) => {
  let oldEmail = '', oldId = '', aliasId = '';
  const f = await boot(page, async f => {
    const old = await f.seedContact('old@example.test', 'Old person'); oldEmail = old.email; oldId = old.contact_id!;
    f.mergeContacts([old.email], f.person.email);
    aliasId = f.addEmailAlias(f.person.contact_id!, 'second@example.test').id;
    f.updateNote(id('note'), { body: savedBody(link(oldId)) }); f.seedNote('alias', { title: 'Alias source', body: '#data/contact/SECOND%40example.test' });
  });
  try {
    await expand(page); await expect(section(page).locator('li')).toHaveCount(3);
    await source(page, 'note').click(); await expect(reader(page, 'note').getByRole('link', { name: link(oldId), exact: true })).toBeFocused();
    await reader(page, 'note').getByRole('button', { name: 'Back to contact', exact: true }).click();
    f.splitContact(oldEmail); f.removeEmailAlias(aliasId);
    await section(page).getByRole('button', { name: 'Refresh linked records', exact: true }).click();
    await expect(section(page).locator('li')).toHaveCount(1); await expect(source(page, 'task')).toBeVisible();
    expect(f.note(id('note')).body).toContain(oldId);
  } finally { f.dispose(); }
});

test('paginates past the loaded list and distinguishes interrupted reads from empty links', async ({ page }) => {
  const f = await boot(page, f => { for (let i = 0; i < 22; i++) f.seedNote('extra-' + i, { title: 'Extra ' + i, body: link(f.person.contact_id!) }); });
  try {
    await section(page).locator('summary').click(); await expect(section(page).locator('li')).toHaveCount(10);
    await section(page).getByRole('button', { name: 'More linked records', exact: true }).click(); await expect(section(page).locator('li')).toHaveCount(20);
    const more = section(page).getByRole('button', { name: 'More linked records', exact: true }); await more.focus(); await more.press('Enter');
    await expect(section(page).locator('li')).toHaveCount(24); await expect(section(page).locator('summary')).toBeFocused();
    f.fail('work_entity.linked_from', ''); await section(page).getByRole('button', { name: 'Refresh linked records', exact: true }).click();
    await expect(section(page).getByRole('alert')).toContainText('Could not load'); await expect(section(page)).not.toContainText('No saved Notes');
    f.fail('work_entity.linked_from', '', false); f.removeNote(id('note')); f.removeTask(id('task'));
    for (let i = 0; i < 22; i++) f.removeNote('extra-' + i);
    await section(page).getByRole('button', { name: 'Refresh linked records', exact: true }).click();
    await expect(section(page)).toContainText('No saved Notes or task notes link here.');
  } finally { f.dispose(); }
});

for (const change of ['removed-link', 'deleted', 'reused', 'split', 'contact-merged'] as const) test('fresh source verification refuses ' + change + ' without opening stale or unrelated content', async ({ page }) => {
  let oldEmail = '';
  const f = await boot(page, async f => {
    if (change !== 'split') return;
    const old = await f.seedContact('old@example.test', 'Old person'); oldEmail = old.email; f.mergeContacts([old.email], f.person.email);
    f.updateNote(id('note'), { body: savedBody(link(old.contact_id!)) });
  });
  try {
    await expand(page);
    if (change === 'removed-link') f.updateNote(id('note'), { body: 'No link here.' });
    if (change === 'deleted') f.removeNote(id('note'));
    if (change === 'reused') { f.removeNote(id('note')); f.seedNote(id('note'), { title: 'Replacement', body: link(f.person.contact_id!), created_at: f.person.created_at + 1000 }); }
    if (change === 'split') f.splitContact(oldEmail);
    if (change === 'contact-merged') { const survivor = await f.seedContact('next@example.test', 'Next person'); f.mergeContacts([f.person.email], survivor.email); }
    await source(page, 'note').click(); await expect(profile(page)).toBeVisible();
    await expect(section(page).getByRole('alert')).toBeVisible(); await expect(reader(page, 'note')).toHaveCount(0);
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['task', 'note'] as const) test('browser Back cancels a slow ' + kind + ' source verification without losing the contact', async ({ page }) => {
  const f = await boot(page);
  try {
    await expand(page); f.hold('work_entity.get', id(kind)); await source(page, kind).click(); await expect.poll(f.waiting).toBe(true);
    await page.goBack(); await expect(profile(page)).toBeVisible(); await expect(source(page, kind)).toBeFocused();
    f.release(); await expect(profile(page)).toBeVisible(); await expect(reader(page, kind)).toHaveCount(0);
  } finally { f.dispose(); }
});

test('late links cannot repaint another contact', async ({ page }) => {
  const f = await boot(page); const other = await f.seedContact('other@example.test', 'Other contact');
  try {
    f.hold('work_entity.linked_from', ''); await section(page).locator('summary').click(); await expect.poll(f.waiting).toBe(true);
    await page.evaluate(hash => window.__app.setHash(hash), serializeShellRoute('data', 'contact', other.email));
    await expect(profile(page).getByRole('heading', { name: 'Other contact', exact: true })).toBeVisible(); f.release();
    await expect(section(page).locator('li')).toHaveCount(0); await expect(section(page)).not.toContainText(title('note'));
  } finally { f.dispose(); }
});

test('live edited links update without losing contact filters or leaving focus on a removed row', async ({ page }) => {
  const f = await boot(page);
  try {
    await expand(page); await source(page, 'note').focus();
    f.updateNote(id('note'), { title: 'Renamed source' }); await notify(page);
    const renamed = section(page).getByRole('button', { name: 'Open note Renamed source', exact: true });
    await expect(renamed).toBeVisible(); await expect(renamed).toBeFocused();
    f.updateNote(id('note'), { body: 'Link removed.' }); await notify(page);
    await expect(section(page).locator('li')).toHaveCount(1); await expect(section(page).locator('summary')).toBeFocused();
  } finally { f.dispose(); }
});

for (const change of ['split', 'merged-away'] as const) test('rechecks the contact group after a slow source read during ' + change, async ({ page }) => {
  let oldEmail = '';
  const f = await boot(page, async f => {
    if (change !== 'split') return;
    const old = await f.seedContact('old@example.test', 'Old person'); oldEmail = old.email;
    f.mergeContacts([old.email], f.person.email); f.updateNote(id('note'), { body: savedBody(link(old.contact_id!)) });
  });
  try {
    await expand(page); f.hold('work_entity.get', id('note')); await source(page, 'note').click(); await expect.poll(f.waiting).toBe(true);
    if (change === 'split') f.splitContact(oldEmail);
    else { const next = await f.seedContact('next@example.test', 'Next person'); f.mergeContacts([f.person.email], next.email); }
    f.release();
    await expect(profile(page)).toBeVisible(); await expect(section(page).getByRole('alert')).toBeVisible();
    await expect(reader(page, 'note')).toHaveCount(0);
  } finally { f.dispose(); }
});

test('Note → Contact → incoming Note retraces both readers and preserves the outer Find state', async ({ page }) => {
  const f = await boot(page);
  try {
    await page.evaluate(hash => window.__app.setHash(hash), serializeShellRoute('data', 'note', id('note')));
    await expect(reader(page, 'note')).toBeVisible();
    await reader(page, 'note').locator('[data-action="note-find-open"]').click();
    await reader(page, 'note').locator('[data-note-find-input]').fill('Source paragraph');
    await reader(page, 'note').getByRole('link', { name: link(f.person.contact_id!), exact: true }).click();
    await expect(profile(page)).toBeVisible(); await expand(page); await source(page, 'note').click();
    await expect(reader(page, 'note').getByRole('link', { name: link(f.person.contact_id!), exact: true })).toBeFocused();
    await reader(page, 'note').getByRole('button', { name: 'Back to contact', exact: true }).click();
    await expect(source(page, 'note')).toBeFocused();
    await profile(page).getByRole('button', { name: /^(?:← )?Back to note$/u }).click();
    await expect(reader(page, 'note')).toHaveAttribute('data-note-id', id('note'));
    await expect(reader(page, 'note').locator('[data-note-find-input]')).toHaveValue('Source paragraph');
  } finally { f.dispose(); }
});
