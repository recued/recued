import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute } from '../src/shell/route.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Kind = 'task' | 'note';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const targetId = (kind: Kind) => 'target/' + kind + "?二!'()*";
const sourceId = (kind: Kind) => 'source-' + kind;
const sourceTitle = (kind: Kind) => 'Linked ' + kind + ' <img src=x>';
const url = (kind: Kind) => HARNESS_URL + serializeShellRoute('data', kind, targetId(kind));
const reader = (page: Page, kind: Kind) => page.locator('.work-entity-' + kind + '-reader');
const section = (page: Page, kind: Kind) => reader(page, kind).locator('[data-' + kind + '-section="linked-from"]');
const source = (page: Page, target: Kind, from: Kind) => section(page, target).getByRole('button', { name: 'Open ' + from + ' ' + sourceTitle(from), exact: true });
const content = (page: Page, kind: Kind) => reader(page, kind).locator('.work-entity-' + kind + '-content');
const targetBody = 'Findneedle first.\n\n' + Array.from({ length: 30 }, (_, index) => 'Paragraph ' + index + '. Keep this saved context. '.repeat(8)).join('\n\n') + '\n\nFindneedle last.';
const seedSource = (f: Fixture, target: Kind, from: Kind, patch = {}) => {
  const body = Array.from({ length: 30 }, (_, index) => 'Earlier paragraph ' + index + '. '.repeat(9)).join('\n\n') + '\n\nExact link context: ' + url(target) + '\n\nAfter the match.';
  if (from === 'note') f.seedNote(sourceId(from), { title: sourceTitle(from), body, ...patch });
  else f.seedTask(sourceId(from), { title: sourceTitle(from), body, assigned_contact_id: undefined, parent_project_id: undefined, blocks_task_ids: [], ...patch });
};
const boot = async (page: Page, kind: Kind = 'note', prepare?: (f: Fixture) => void) => {
  const f = await installTaskNoteSourceFixture(page);
  f.update({ assigned_contact_id: undefined, parent_project_id: undefined, blocks_task_ids: [] });
  f.seedTask(targetId('task'), { title: 'Target task', body: targetBody });
  f.seedNote(targetId('note'), { title: 'Target note', body: targetBody });
  seedSource(f, kind, 'note'); seedSource(f, kind, 'task'); prepare?.(f);
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + serializeShellRoute('data', kind, targetId(kind)));
  await page.waitForFunction(() => window.__app?.ready === true); await expect(reader(page, kind)).toBeVisible();
  return f;
};
const expand = async (page: Page, kind: Kind) => {
  await section(page, kind).locator('summary').click(); await expect(source(page, kind, 'note')).toBeVisible();
};
const back = async (page: Page, kind: Kind, activation: 'pointer' | 'keyboard' = 'pointer') => {
  const button = reader(page, kind).getByRole('button', { name: /^(?:← )?Back to (?:note|task)$/u });
  if (activation === 'keyboard') await button.press('Enter'); else await button.click();
};

for (const target of ['task', 'note'] as const) {
  test(target + ': lazy exact matches cover saved kinds without including title-only, other deployments or self links', async ({ page }) => {
    const f = await boot(page, target, f => {
      f.seedNote('title-only', { title: url(target), body: 'No link in this saved body.' });
      f.seedNote('other-deployment', { body: url(target).replace('/full-app-harness.html', '/other-client.html') });
      f.seedNote('external', { body: url(target).replace('127.0.0.1', 'localhost') });
      if (target === 'task') f.updateTask(targetId(target), { body: targetBody + '\n' + url(target) });
      else f.updateNote(targetId(target), { body: targetBody + '\n' + url(target) });
    });
    expect(f.queries.filter(call => call.method === 'work_entity.linked_from')).toHaveLength(0);
    await expand(page, target);
    await expect(section(page, target).locator('li')).toHaveCount(2);
    await expect(section(page, target)).toContainText('Exact link context:');
    await expect(section(page, target).locator('img,script')).toHaveCount(0);
    const calls = f.queries.filter(call => call.method === 'work_entity.linked_from');
    expect(calls[0]!.args).toEqual({ url: url(target), limit: 10, offset: 0 });
    expect(f.reads.filter(call => call.method === 'work_entity.get' && call.id.startsWith('source-'))).toHaveLength(0);
    f.dispose();
  });

  for (const from of ['task', 'note'] as const) for (const activation of ['pointer', 'keyboard'] as const) {
    test(target + ' → ' + from + ' with ' + activation + ': opens at the matching link and Back restores Find, scroll and exact trigger focus', async ({ page }) => {
      const f = await boot(page, target);
      await reader(page, target).locator('[data-action="' + target + '-find-open"]').click();
      await reader(page, target).locator('[data-' + target + '-find-input]').fill('Findneedle');
      await expect(reader(page, target).locator('[data-' + target + '-find-status]')).toContainText('2');
      await expand(page, target);
      await content(page, target).evaluate(node => { node.scrollTop = node.scrollHeight; });
      if (activation === 'pointer') await source(page, target, from).click({ trial: true });
      else await source(page, target, from).focus();
      const top = await content(page, target).evaluate(node => node.scrollTop);
      if (activation === 'pointer') await source(page, target, from).click();
      else await source(page, target, from).press('Enter');
      await expect(reader(page, from)).toHaveAttribute('data-' + from + '-id', sourceId(from));
      const link = reader(page, from).locator('a[href]').filter({ hasText: url(target) }).first();
      await expect(link).toBeFocused(); await expect(link).toBeInViewport();
      expect(await content(page, from).evaluate(node => node.scrollTop)).toBeGreaterThan(100);
      expect(f.reads.filter(call => call.method === 'work_entity.get' && call.id === sourceId(from))).toHaveLength(1);
      await back(page, from, activation);
      await expect(reader(page, target)).toHaveAttribute('data-' + target + '-id', targetId(target));
      await expect(reader(page, target).locator('[data-' + target + '-find-input]')).toHaveValue('Findneedle');
      await expect(reader(page, target).locator('[data-' + target + '-find-status]')).toContainText('2');
      await expect(source(page, target, from)).toBeFocused();
      await expect.poll(() => content(page, target).evaluate(node => node.scrollTop)).toBeCloseTo(top, 0);
      f.dispose();
    });
  }
}

test('paginates beyond the first loaded list, refreshes edited links and distinguishes errors from empty results', async ({ page }) => {
  const f = await boot(page, 'note', f => { for (let index = 0; index < 22; index++) f.seedNote('extra-' + String(index).padStart(2, '0'), { title: 'Extra ' + index, body: url('note') }); });
  await section(page, 'note').locator('summary').click();
  await expect(section(page, 'note').locator('li')).toHaveCount(10);
  await section(page, 'note').getByRole('button', { name: 'More linked records', exact: true }).click();
  await expect(section(page, 'note').locator('li')).toHaveCount(20);
  const lastPage = section(page, 'note').getByRole('button', { name: 'More linked records', exact: true });
  await lastPage.focus(); await lastPage.press('Enter');
  await expect(section(page, 'note').locator('li')).toHaveCount(24);
  await expect(section(page, 'note').locator('summary')).toBeFocused();
  expect(f.queries.filter(call => call.method === 'work_entity.linked_from').map(call => call.args.offset)).toEqual([0, 10, 20]);
  f.updateNote(sourceId('note'), { body: 'The link was removed.' }); f.removeTask(sourceId('task'));
  for (let index = 0; index < 22; index++) f.removeNote('extra-' + String(index).padStart(2, '0'));
  f.fail('work_entity.linked_from', ''); await section(page, 'note').getByRole('button', { name: 'Refresh linked records' }).click();
  await expect(section(page, 'note').getByRole('alert')).toContainText('Could not load');
  await expect(section(page, 'note')).not.toContainText('No saved Notes');
  f.fail('work_entity.linked_from', '', false); await section(page, 'note').getByRole('button', { name: 'Refresh linked records' }).click();
  await expect(section(page, 'note')).toContainText('No saved Notes or task notes link here.');
  await expect(section(page, 'note').locator('li')).toHaveCount(0); f.dispose();
});

for (const interaction of ['wheel', 'keyboard'] as const) test('keeps a new ' + interaction + ' reading position when a delayed reminder read settles', async ({ page }) => {
  const f = await boot(page, 'task');
  try {
    await reader(page, 'task').locator('[data-action="task-find-open"]').click();
    await reader(page, 'task').locator('[data-task-find-input]').fill('Findneedle');
    await expand(page, 'task');
    await source(page, 'task', 'note').click(); await expect(reader(page, 'note')).toBeVisible();
    f.holdAll('reminder.list', ''); f.holdAll('work_entity.get', targetId('task'));
    await back(page, 'note'); await expect.poll(f.waiting).toBe(true);
    const host = content(page, 'task'), before = await host.evaluate(node => node.scrollTop);
    if (interaction === 'wheel') { await host.hover({ position: { x: 10, y: 10 } }); await page.mouse.wheel(0, -180); }
    else await source(page, 'task', 'note').press('PageUp');
    await expect.poll(() => host.evaluate(node => node.scrollTop)).toBeLessThan(before);
    const chosen = await host.evaluate(node => new Promise<number>(resolve => {
      let previous = node.scrollTop, stable = 0;
      const frame = () => { const next = node.scrollTop; stable = next === previous ? stable + 1 : 0; previous = next;
        if (stable >= 3) resolve(next); else requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    }));
    f.release(); await expect(reader(page, 'task').getByText('No linked reminders waiting.', { exact: true })).toBeVisible();
    await expect.poll(() => host.evaluate(node => node.scrollTop)).toBeCloseTo(chosen, 0);
    await expect(reader(page, 'task').locator('[data-task-find-input]')).toHaveValue('Findneedle');
  } finally { f.dispose(); }
});

test('warehouse updates refresh incoming titles and removed links without moving reader focus or Find', async ({ page }) => {
  const f = await boot(page); await expand(page, 'note');
  await reader(page, 'note').locator('[data-action="note-find-open"]').click();
  await reader(page, 'note').locator('[data-note-find-input]').fill('Findneedle');
  await section(page, 'note').locator('summary').focus();
  f.updateNote(sourceId('note'), { title: 'Renamed source <script>literal</script>' });
  const notify = () => page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'warehouse', collection: 'note', op: 'update', id: 'source-note', cursor: Date.now() } }));
  await notify();
  await expect(section(page, 'note').getByRole('button', { name: 'Open note Renamed source <script>literal</script>', exact: true })).toBeVisible();
  await expect(section(page, 'note').locator('summary')).toBeFocused();
  await expect(reader(page, 'note').locator('[data-note-find-input]')).toHaveValue('Findneedle');
  await section(page, 'note').getByRole('button', { name: 'Open note Renamed source <script>literal</script>', exact: true }).focus();
  f.updateNote(sourceId('note'), { body: 'The link was removed.' }); await notify();
  await expect(section(page, 'note').locator('li')).toHaveCount(1);
  await expect(section(page, 'note').locator('summary')).toBeFocused();
  await expect(source(page, 'note', 'task')).toBeVisible();
  await expect(reader(page, 'note').locator('[data-note-find-status]')).toContainText('2');
  f.dispose();
});

for (const change of ['removed-link', 'deleted', 'reused', 'unavailable'] as const) {
  test('fresh source recheck refuses ' + change + ' without opening unrelated saved content', async ({ page }) => {
    const f = await boot(page); await expand(page, 'note');
    if (change === 'removed-link') f.updateNote(sourceId('note'), { body: 'No longer links here.' });
    if (change === 'deleted') f.removeNote(sourceId('note'));
    if (change === 'reused') { f.removeNote(sourceId('note')); seedSource(f, 'note', 'note', { created_at: Date.parse('2026-11-01T00:00:00Z') }); }
    if (change === 'unavailable') f.fail('work_entity.get', sourceId('note'));
    await source(page, 'note', 'note').click();
    await expect(reader(page, 'note')).toHaveAttribute('data-note-id', targetId('note'));
    await expect(section(page, 'note').getByRole('alert')).toBeVisible();
    await expect(page.locator('.work-entity-note-reader[data-note-id="source-note"]')).toHaveCount(0); f.dispose();
  });
}

test('a late incoming-links reply cannot repaint another reader', async ({ page }) => {
  const f = await boot(page); f.hold('work_entity.linked_from', '');
  await section(page, 'note').locator('summary').click(); await expect.poll(f.waiting).toBe(true);
  await page.evaluate(hash => { location.hash = hash; }, serializeShellRoute('data', 'task', targetId('task')));
  await expect(reader(page, 'task')).toBeVisible(); f.release();
  await expect(reader(page, 'task')).toHaveAttribute('data-task-id', targetId('task'));
  await expect(section(page, 'task').locator('li')).toHaveCount(0); await expect(section(page, 'task')).not.toContainText(sourceTitle('note')); f.dispose();
});

for (const from of ['task', 'note'] as const) {
  test('a late ' + from + ' source verification cannot steal focus or navigate after browser Back', async ({ page }) => {
    const f = await boot(page); await expand(page, 'note'); f.hold('work_entity.get', sourceId(from));
    await source(page, 'note', from).click(); await expect.poll(f.waiting).toBe(true);
    if (from === 'note') {
      await expect(source(page, 'note', from)).toHaveAttribute('aria-busy', 'true');
      await expect(source(page, 'note', from)).toHaveText('Opening…');
      await expect(source(page, 'note', from)).toBeFocused();
    }
    await page.goBack(); await expect(reader(page, 'note')).toHaveAttribute('data-note-id', targetId('note'));
    f.release(); await expect(source(page, 'note', from)).toBeFocused();
    await expect(reader(page, 'note')).toHaveAttribute('data-note-id', targetId('note')); f.dispose();
  });
}

test('formatted Markdown labels jump to their real destination; code links remain reachable through plain text', async ({ page }) => {
  const f = await boot(page); seedSource(f, 'note', 'note', { body: '# Source heading\n\n[Open the target](' + url('note') + ')' });
  // Remember the source display preference before entering through Linked from.
  await page.evaluate(() => { location.hash = '#data/note/source-note'; });
  await expect(reader(page, 'note')).toHaveAttribute('data-note-id', sourceId('note'));
  await reader(page, 'note').getByRole('button', { name: 'Formatted', exact: true }).click();
  await page.evaluate(hash => { location.hash = hash; }, serializeShellRoute('data', 'note', targetId('note')));
  await expect(reader(page, 'note')).toHaveAttribute('data-note-id', targetId('note')); await expand(page, 'note');
  await source(page, 'note', 'note').click(); await expect(reader(page, 'note').getByRole('link', { name: 'Open the target', exact: true })).toBeFocused();
  await back(page, 'note'); f.updateNote(sourceId('note'), { body: '```\n' + url('note') + '\n```' });
  await source(page, 'note', 'note').click();
  await expect(reader(page, 'note').getByRole('link', { name: url('note'), exact: true })).toBeFocused(); f.dispose();
});
