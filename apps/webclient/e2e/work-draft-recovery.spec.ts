import { expect, test, type Page } from '@playwright/test';
import type { WorkEntity, WorkEntityUpsertRpcRequest } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskCalendarFixture } from './helpers/task-calendar-fixture.js';

installFullAppHooks();

test.describe('draft recovery search', () => {
  type DraftKind = 'task' | 'project' | 'note' | 'calendar';
  const local = (page: Page) => page.getByRole('region', { name: 'Unfinished work search results', exact: true });
  const form = (page: Page, kind: DraftKind) => kind === 'calendar'
    ? page.getByRole('region', { name: 'New event', exact: true })
    : page.locator(`.work-entity-dialog[data-kind="${kind}"]`).filter({ has: page.locator('.work-entity-dialog-form') });
  const name = (kind: DraftKind) => 'Recovery ' + kind;
  const boot = async (page: Page) => {
    await page.clock.setFixedTime(new Date('2026-11-20T12:00Z'));
    const f = await installTaskCalendarFixture(page);
    await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/task`);
    await page.waitForFunction(() => window.__app?.ready === true); return f;
  };
  const refresh = async (page: Page) => {
    const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); }; page.on('dialog', accept);
    try { await page.reload(); } finally { page.off('dialog', accept); }
    await page.waitForFunction(() => window.__app?.ready === true);
  };
  const seed = async (page: Page, kind: DraftKind) => {
    await page.evaluate(kind => window.__app.setHash('#data/' + kind), kind);
    if (kind === 'calendar') {
      await page.getByRole('button', { name: 'New event', exact: true }).click();
      await expect(form(page, kind).getByLabel('Calendar', { exact: true })).toHaveValue(JSON.stringify(['work', 'primary']));
      await form(page, kind).getByLabel('Title', { exact: true }).fill(name(kind));
      await form(page, kind).getByLabel('Notes (optional)', { exact: true }).fill('Calendar details to retain.');
    } else {
      await page.getByRole('button', { name: '+ New ' + kind[0]!.toUpperCase() + kind.slice(1), exact: true }).click();
      await form(page, kind).locator('[data-form-field="title"]').fill(name(kind));
      await form(page, kind).locator(`[data-form-field="${kind === 'project' ? 'description' : 'body'}"]`).fill(kind === 'note' ? 'Cobalt <review> & plan' : 'Details to retain for ' + kind);
    }
    await refresh(page);
  };
  const search = async (page: Page, query = 'Recovery') => {
    await page.evaluate(() => window.__app.setHash('#data/search'));
    await page.locator('#rq-search-input').fill(query);
    await page.locator('[data-recued-universal-search-type]').selectOption('draft');
  };
  const result = (page: Page, kind: DraftKind, unconfirmed = false) => local(page).getByRole('button', {
    name: (unconfirmed ? 'Review unconfirmed ' : 'Resume ') + (kind === 'calendar' ? 'calendar event' : kind) + ' draft ' + name(kind), exact: true,
  });

  for (const kind of ['task', 'note', 'project', 'calendar'] as const) test('resumes the exact ' + kind + ' draft from search and writes only after Save', async ({ page }) => {
    const f = await boot(page);
    try {
      await seed(page, kind); await search(page); await result(page, kind).click();
      const editor = form(page, kind);
      await expect(kind === 'calendar' ? editor.getByLabel('Title', { exact: true }) : editor.locator('[data-form-field="title"]')).toHaveValue(name(kind));
      await expect(kind === 'calendar' ? editor.getByLabel('Notes (optional)', { exact: true }) : editor.locator(`[data-form-field="${kind === 'project' ? 'description' : 'body'}"]`))
        .toHaveValue(kind === 'calendar' ? 'Calendar details to retain.' : kind === 'note' ? 'Cobalt <review> & plan' : 'Details to retain for ' + kind);
      expect(f.task.writes).toEqual([]); expect(f.calendar.requests).toEqual([]);
      await editor.getByRole('button', { name: kind === 'calendar' ? 'Create event' : 'Save', exact: true }).click();
      if (kind === 'calendar') { await expect(page.locator('.calendar-event')).toContainText(name(kind)); expect(f.calendar.providerCalls()).toBe(1); }
      else {
        await expect.poll(() => f.task.writes.filter(row => row.method === 'work_entity.upsert').length).toBe(1);
        await expect(editor).toHaveCount(0);
      }
      await search(page); await expect(result(page, kind)).toHaveCount(0);
    } finally { await f.dispose(); }
  });

  test('browses all recovery types, searches full draft text and keeps scope and counts clear on desktop and phone', async ({ page }, info) => {
    const f = await boot(page);
    try {
      for (const kind of ['task', 'note', 'project', 'calendar'] as const) await seed(page, kind);
      await search(page); await expect(local(page).locator('[data-recovery-draft-key]')).toHaveCount(4);
      await expect(local(page)).toContainText('this server and this browser tab');
      await expect(page.locator('[data-recued-universal-search-type]')).toContainText('Drafts · 4 loaded');
      await local(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('recovery-search-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 900 }); await page.emulateMedia({ colorScheme: 'dark' });
      await page.screenshot({ path: info.outputPath('recovery-search-phone-dark.png'), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('#rq-search-input').fill('Cobalt');
      await expect(local(page).locator('[data-recovery-draft-key]')).toHaveCount(1); await expect(result(page, 'note')).toBeVisible();
      await expect(local(page)).toContainText('Cobalt <review> & plan'); await expect(local(page).locator('img,script')).toHaveCount(0);
      await page.locator('#rq-search-input').fill(''); await expect(local(page).locator('[data-recovery-draft-key]')).toHaveCount(4);
      expect(f.task.writes).toEqual([]); expect(f.calendar.requests).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('rejects a changed stored revision instead of silently opening its replacement', async ({ page }) => {
    const f = await boot(page);
    try {
      await seed(page, 'task'); await search(page); await expect(result(page, 'task')).toBeVisible();
      await page.evaluate(() => {
        const key = Object.keys(sessionStorage).find(key => key.startsWith('recued.task.draft-recovery.v1:'))!;
        const rows = JSON.parse(sessionStorage.getItem(key)!); rows[0].revision++; rows[0].values.title = 'Changed recovery task'; sessionStorage.setItem(key, JSON.stringify(rows));
      });
      await result(page, 'task').click(); await expect(local(page).getByRole('alert')).toContainText('changed or is no longer available');
      await expect(form(page, 'task')).toHaveCount(0); expect(f.task.writes).toEqual([]);
      await local(page).getByRole('button', { name: 'Resume task draft Changed recovery task', exact: true }).click();
      await expect(form(page, 'task').locator('[data-form-field="title"]')).toHaveValue('Changed recovery task');
    } finally { await f.dispose(); }
  });

  test('retires a waiting resume and lets a newer recovery own the editor', async ({ page }) => {
    const f = await boot(page);
    try {
      await seed(page, 'task'); await seed(page, 'note'); await search(page);
      f.task.hold('work_entity.source.list', ''); await result(page, 'task').click(); await expect.poll(f.task.waiting).toBe(true);
      await search(page, 'Recovery note'); await result(page, 'note').click();
      await expect(form(page, 'note').locator('[data-form-field="title"]')).toHaveValue(name('note'));
      f.task.release(); await expect(form(page, 'note').locator('[data-form-field="body"]')).toHaveValue('Cobalt <review> & plan');
      await expect(form(page, 'task')).toHaveCount(0); expect(f.task.writes).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('opens an unconfirmed task for review without repeating its write', async ({ page }) => {
    const f = await boot(page);
    try {
      await seed(page, 'task'); await search(page); await result(page, 'task').click(); f.task.reply('lost');
      await form(page, 'task').getByRole('button', { name: 'Save', exact: true }).click(); await expect(form(page, 'task').getByRole('alert')).toBeVisible();
      expect(f.task.writes).toHaveLength(1); await refresh(page); f.task.reply('confirmed');
      await search(page); await result(page, 'task', true).click();
      await expect(page.locator('.work-draft-preview')).toContainText('Draft title'); await expect(page.locator('.work-draft-preview textarea').first()).toHaveValue(name('task'));
      await expect(page.getByRole('region', { name: 'Unfinished tasks', exact: true }).getByRole('button', { name: 'Resume draft', exact: true })).toBeDisabled();
      expect(f.task.writes).toHaveLength(1);
      await page.goBack(); await expect(page.locator('#rq-search-input')).toHaveValue('Recovery');
      await expect(page.locator('[data-recued-universal-search-type]')).toHaveValue('draft');
      await expect(result(page, 'task', true)).toBeFocused();
      await result(page, 'task', true).click();
      await expect(page.locator('.work-draft-preview textarea').first()).toHaveValue(name('task')); expect(f.task.writes).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  test('opens an unconfirmed calendar save as a locked check and reuses its receipt only on explicit Check save', async ({ page }) => {
    const f = await boot(page);
    try {
      await seed(page, 'calendar'); await search(page); await result(page, 'calendar').click(); f.calendar.loseNextReply();
      await form(page, 'calendar').getByRole('button', { name: 'Create event', exact: true }).click();
      await expect(form(page, 'calendar').getByRole('button', { name: 'Check save', exact: true })).toBeVisible();
      const original = structuredClone(f.calendar.requests[0]); expect(f.calendar.providerCalls()).toBe(1); await refresh(page);
      await search(page); await result(page, 'calendar', true).click();
      await expect(form(page, 'calendar').getByLabel('Title', { exact: true })).toBeDisabled(); expect(f.calendar.requests).toHaveLength(1);
      await form(page, 'calendar').getByRole('button', { name: 'Check save', exact: true }).click();
      await expect(page.locator('.calendar-event')).toContainText(name('calendar')); expect(f.calendar.requests).toEqual([original, original]); expect(f.calendar.providerCalls()).toBe(1);
    } finally { await f.dispose(); }
  });
});
test.use({ timezoneId: 'America/Los_Angeles' });
type Kind = 'task' | 'project';
type FixtureWindow = Window & { __workDraftFixture: { holdRead(): void; waiting(): boolean; release(): void } };
const title = (kind: Kind) => kind === 'task' ? 'Task' : 'Project';
const textField = (kind: Kind) => kind === 'task' ? 'body' : 'description';
const dateField = (kind: Kind) => kind === 'task' ? 'due_at' : 'target_completion_at';
const editor = (page: Page, kind: Kind) => page.locator(`.work-entity-dialog[data-kind="${kind}"]`).filter({ has: page.locator('.work-entity-dialog-form') });
const recovery = (page: Page, kind: Kind) => page.getByRole('region', { name: `Unfinished ${kind === 'task' ? 'tasks' : 'projects'}`, exact: true });
const writes = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('work-drafts.writes') ?? '[]') as WorkEntityUpsertRpcRequest[]);
const reload = async (page: Page) => {
  const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); };
  page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); }
  await page.waitForFunction(() => window.__app?.ready === true);
};
const install = async (page: Page, kind: Kind) => {
  await page.clock.install({ time: new Date('2026-11-15T12:00:00Z') });
  await page.addInitScript(() => {
    const now = 1_700_000_000_000;
    const base = (kind: Kind) => ({ id: `${kind}-one`, source_id: `recued.${kind}`, sync_state: 'live' as const,
      conflict_policy: 'recued_wins' as const, created_at: now, updated_at: now, last_seen_at: now });
    if (!sessionStorage.getItem('work-drafts.rows')) sessionStorage.setItem('work-drafts.rows', JSON.stringify([
      { ...base('task'), _kind: 'task', title: 'Saved task', body: 'Original notes', done: false, priority: 'medium', blocks_task_ids: [] },
      { ...base('project'), _kind: 'project', title: 'Saved project', description: 'Original description', state: 'active', related_contact_ids: ['person@example.test'], last_activity_at: now },
    ]));
    const read = () => JSON.parse(sessionStorage.getItem('work-drafts.rows')!) as WorkEntity[];
    const linkedTask: WorkEntity = { ...base('task'), id: 'linked-task', _kind: 'task', title: 'Linked task', done: false, blocks_task_ids: [] };
    let hold = false, release: (() => void) | undefined;
    Object.assign(window, { __workDraftFixture: { holdRead() { hold = true; }, waiting: () => release !== undefined,
      release() { const done = release; release = undefined; done?.(); } },
    __connectionsFixture: async (method: string, input: unknown) => {
      const args = (input ?? {}) as Record<string, unknown>;
      if (method === 'contact.get') return { result: { contact: args.email === 'person@example.test' ? {
        _id: 'person@example.test', _collection: 'contact', email: 'person@example.test', name: 'person@example.test',
        first_seen: now, last_interaction: now, interaction_count: 0, source: 'manual', created_at: now, updated_at: now,
      } : null } };
      if (method === 'contact.list' || method === 'contact.search.local') return { result: { contacts: [{ _id: 'person@example.test', _collection: 'contact',
        email: 'person@example.test', name: 'person@example.test', first_seen: now, last_interaction: now,
        interaction_count: 0, source: 'manual', created_at: now, updated_at: now }], total: 1 } };
      if (method === 'work_entity.source.list') return { result: {
        sources: (['task', 'project'] as const).map(kind => ({ id: `recued.${kind}`, top_tier_kind: kind, source_kind: 'builtin',
          source_label: 'Recued', write_capable: sessionStorage.getItem(`work-drafts.readonly.${kind}`) !== '1', registered_at: now })),
        defaults_by_kind: { task: 'recued.task', project: 'recued.project' },
      } };
      if (method === 'work_entity.list') { const rows = read().filter(row => row._kind === args.kind); return { result: { entities: rows, total: rows.length } }; }
      if (method === 'work_entity.get') {
        const result = { entity: args.kind === 'task' && args.id === linkedTask.id ? linkedTask : read().find(row => row._kind === args.kind && row.id === args.id) ?? null };
        if (hold) { hold = false; await new Promise<void>(done => { release = done; }); }
        return { result };
      }
      if (method === 'work_entity.search' && args.kind === 'task') return { result: { groups: [{ kind: 'task', offset: 0, more: false,
        matches: linkedTask.title.toLowerCase().includes(String(args.query).toLowerCase()) ? [{ id: linkedTask.id, title: linkedTask.title,
          source_id: linkedTask.source_id, source_label: 'Recued', excerpt: '', updated_at: now, stale: false, pending_write: false }] : [] }] } };
      if (method === 'work_entity.project.items') return { result: { project_id: args.project_id, kind: args.kind, items: [], total: 0,
        offset: args.offset ?? 0, ...(args.kind === 'task' ? { open_tasks: 0 } : {}), ...(args.kind === 'commitment' ? { commitment_status: args.commitment_status ?? 'open' } : {}) } };
      if (method !== 'work_entity.upsert') return undefined;
      const writes = JSON.parse(sessionStorage.getItem('work-drafts.writes') ?? '[]'); writes.push(args);
      sessionStorage.setItem('work-drafts.writes', JSON.stringify(writes));
      const rows = read(), current = rows.find(row => row._kind === args.kind && row.id === args.id);
      const seed = current ?? { ...base(args.kind as Kind), id: `${args.kind}-created`,
        ...(args.kind === 'task' ? { _kind: 'task', done: false, blocks_task_ids: [] } : { _kind: 'project', state: 'active', related_contact_ids: [], last_activity_at: now }) };
      const patch = Object.fromEntries(Object.entries(args).filter(([key]) => !['kind', 'id', 'clear_due_at'].includes(key)));
      const saved = { ...seed, ...patch, updated_at: now + 60_000,
        ...(args.clear_due_at ? { due_at: undefined } : {}),
        ...(sessionStorage.getItem('work-drafts.pending') === '1' ? { pending_write: { staged_at: now, operation: args.id ? 'update' : 'create', dirty_fields: ['title'], state: 'awaiting_verify' } } : {}),
      } as WorkEntity;
      sessionStorage.setItem('work-drafts.rows', JSON.stringify([...rows.filter(row => row._kind !== args.kind || row.id !== saved.id), saved]));
      if (sessionStorage.getItem('work-drafts.lost') === '1') return { error: { code: 'timeout', message: 'The save reply was lost.' } };
      return { result: { entity: saved } };
    } });
  });
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/${kind}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.getByRole('button', { name: `+ New ${title(kind)}`, exact: true })).toBeVisible();
};
const open = async (page: Page, kind: Kind) => {
  await page.locator(`[data-action="open-edit-work-entity"][data-entity-id="${kind}-one"]`).click();
  if (kind === 'task') await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Edit', exact: true }).click();
  if (kind === 'project') await page.getByRole('button', { name: 'Edit project', exact: true }).click();
  await expect(editor(page, kind)).toBeVisible();
};

for (const kind of ['task', 'project'] as const) {
  test(`recovers a new ${kind} after immediate reload with text, dates and related records, then clears only a confirmed save`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 900 }); await install(page, kind);
    await page.getByRole('button', { name: `+ New ${title(kind)}`, exact: true }).click();
    const dialog = editor(page, kind), text = '\n  Café 🧾\n<img src=x onerror="throw Error(\'unsafe\')">\nTrailing spaces  \n';
    await dialog.locator('[data-form-field="title"]').fill(`Unfinished ${kind}`);
    await dialog.locator(`[data-form-field="${textField(kind)}"]`).fill(text);
    await dialog.locator(`[data-form-field="${dateField(kind)}"]`).fill('2030-10-30T09:45');
    if (kind === 'task') await dialog.getByRole('button', { name: 'More details', exact: true }).click();
    const relation = kind === 'task' ? 'blocks_task' : 'related_contacts';
    await dialog.locator(`[data-form-array-add="${relation}"]`).click();
    const linked = dialog.getByRole('combobox', { name: kind === 'task' ? 'Depends on 1' : 'Related contacts 1', exact: true });
    await linked.fill(kind === 'task' ? 'Linked' : 'person');
    await dialog.getByRole('option', { name: kind === 'task' ? 'Linked task · Recued' : /person@example.test/ }).click();
    if (kind === 'task') await dialog.getByRole('button', { name: 'Fewer details', exact: true }).click();
    await reload(page);
    const panel = recovery(page, kind); await expect(panel.getByRole('heading', { name: `Unfinished ${kind}`, exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Review draft', exact: true }).click();
    await expect(panel.getByLabel(kind === 'task' ? 'Draft notes' : 'Draft description', { exact: true })).toHaveValue(text);
    await expect(panel.locator('img,script')).toHaveCount(0); expect(await writes(page)).toEqual([]);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${kind}-draft-phone.png`) });
    await panel.getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(dialog.locator(`[data-form-field="${textField(kind)}"]`)).toHaveValue(text);
    await expect(dialog.locator(`[data-form-field="${dateField(kind)}"]`)).toHaveValue('2030-10-30T09:45');
    await expect(dialog.getByRole('combobox', { name: kind === 'task' ? 'Depends on 1' : 'Related contacts 1', exact: true })).toHaveValue(kind === 'task' ? 'Linked task · Recued' : 'person@example.test');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(panel).toHaveCount(0); await reload(page); await expect(panel).toHaveCount(0);
    expect(await writes(page)).toEqual([expect.objectContaining({ kind, source_id: `recued.${kind}`, title: `Unfinished ${kind}`,
      [textField(kind)]: text.trim(), [dateField(kind)]: Date.parse('2030-10-30T09:45:00-07:00'),
      [kind === 'task' ? 'blocks_task_ids' : 'related_contact_ids']: [kind === 'task' ? 'linked-task' : 'person@example.test'] })]);
  });

  test(`resumes existing ${kind} edits and clears an explicitly discarded draft without changing the saved item`, async ({ page }) => {
    await install(page, kind); await open(page, kind);
    const dialog = editor(page, kind); await dialog.locator(`[data-form-field="${textField(kind)}"]`).fill('Recovered edit'); await reload(page);
    await recovery(page, kind).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(dialog.locator(`[data-form-field="${textField(kind)}"]`)).toHaveValue('Recovered edit');
    if (kind === 'project') await expect(dialog.getByRole('combobox', { name: 'Related contacts 1', exact: true })).toHaveValue('person@example.test');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toHaveCount(0);
    if (kind === 'project') await page.getByRole('button', { name: 'Edit project', exact: true }).click();
    else await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Edit', exact: true }).click();
    await dialog.locator(`[data-form-field="${textField(kind)}"]`).fill('Discard this edit');
    await dialog.getByRole('button', { name: kind === 'task' ? 'Cancel' : 'Back to project', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
    await reload(page); await expect(recovery(page, kind)).toHaveCount(0);
    expect(await writes(page)).toEqual([{ kind, id: `${kind}-one`, [textField(kind)]: 'Recovered edit' }]);
  });

  test(`keeps a ${kind} draft available when saved content changes or source write access is withdrawn`, async ({ page }) => {
    await install(page, kind); await open(page, kind);
    await editor(page, kind).locator(`[data-form-field="${textField(kind)}"]`).fill('My unfinished edit'); await reload(page);
    await page.evaluate(({ kind, field }) => {
      const rows = JSON.parse(sessionStorage.getItem('work-drafts.rows')!); rows.find((row: WorkEntity) => row._kind === kind)[field] = 'Changed elsewhere';
      sessionStorage.setItem('work-drafts.rows', JSON.stringify(rows));
    }, { kind, field: textField(kind) });
    const panel = recovery(page, kind); await panel.getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText(`saved ${kind} changed`); await expect(panel.getByRole('alert')).toBeFocused();
    await expect(panel.getByLabel(kind === 'task' ? 'Draft notes' : 'Draft description', { exact: true })).toHaveValue('My unfinished edit');
    await expect(editor(page, kind)).toHaveCount(0); expect(await writes(page)).toEqual([]);
    await page.evaluate(({ kind, field }) => {
      const rows = JSON.parse(sessionStorage.getItem('work-drafts.rows')!); rows.find((row: WorkEntity) => row._kind === kind)[field] = kind === 'task' ? 'Original notes' : 'Original description';
      sessionStorage.setItem('work-drafts.rows', JSON.stringify(rows)); sessionStorage.setItem(`work-drafts.readonly.${kind}`, '1');
    }, { kind, field: textField(kind) });
    await panel.getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('cannot be reopened for editing'); expect(await writes(page)).toEqual([]);
    await panel.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Keep draft', exact: true })).toBeFocused();
    await panel.getByRole('button', { name: 'Discard recovery copy', exact: true }).click(); await expect(panel).toHaveCount(0);
  });

  test(`keeps an unconfirmed new ${kind} for review and prevents replay after reload`, async ({ page }) => {
    await install(page, kind); await page.getByRole('button', { name: `+ New ${title(kind)}`, exact: true }).click();
    const dialog = editor(page, kind); await dialog.locator('[data-form-field="title"]').fill('Unconfirmed item');
    await dialog.locator(`[data-form-field="${textField(kind)}"]`).fill('Keep this draft');
    await page.evaluate(() => sessionStorage.setItem('work-drafts.pending', '1'));
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(`did not confirm this ${kind}`);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('source already returned an item'); expect(await writes(page)).toHaveLength(1);
    await reload(page);
    const panel = recovery(page, kind); await expect(panel).toContainText('Save was not confirmed');
    await expect(panel.getByRole('button', { name: 'Resume draft', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: 'Review draft', exact: true }).click();
    await expect(panel.getByLabel(kind === 'task' ? 'Draft notes' : 'Draft description', { exact: true })).toHaveValue('Keep this draft');
    await panel.getByRole('button', { name: `Open saved ${kind}`, exact: true }).click();
    expect(await writes(page)).toHaveLength(1);
    await expect(page.getByRole('heading', { name: 'Unconfirmed item', exact: true, level: 2 })).toBeVisible();
  });
}

test('a lost create reply keeps its recovery copy and blocks another create before and after reload', async ({ page }) => {
  await install(page, 'task'); await page.getByRole('button', { name: '+ New Task', exact: true }).click();
  const dialog = editor(page, 'task'); await dialog.locator('[data-form-field="title"]').fill('Reply lost'); await dialog.getByLabel('Notes', { exact: true }).fill('Check for the created task');
  await page.evaluate(() => sessionStorage.setItem('work-drafts.lost', '1'));
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog.getByRole('alert')).toBeVisible(); await expect(dialog.locator('[data-work-recovery-status]')).toContainText('Save not confirmed');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('previous save was not confirmed');
  expect(await writes(page)).toHaveLength(1); await reload(page);
  const panel = recovery(page, 'task'); await expect(panel.getByRole('button', { name: 'Resume draft', exact: true })).toBeDisabled();
  await expect(page.locator('[data-action="open-edit-work-entity"][data-entity-id="task-created"]')).toContainText('Reply lost');
  expect(await writes(page)).toHaveLength(1);
});

test('a late task resume read cannot replace a newer Data destination', async ({ page }) => {
  await install(page, 'task'); await open(page, 'task'); await editor(page, 'task').getByLabel('Notes', { exact: true }).fill('Keep for later'); await reload(page);
  await page.evaluate(() => (window as unknown as FixtureWindow).__workDraftFixture.holdRead());
  await recovery(page, 'task').getByRole('button', { name: 'Resume draft', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).__workDraftFixture.waiting())).toBe(true);
  await page.evaluate(() => { location.hash = '#data/note'; }); await expect(page).toHaveURL(/#data\/note$/);
  await page.evaluate(() => (window as unknown as FixtureWindow).__workDraftFixture.release());
  await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible(); await expect(editor(page, 'task')).toHaveCount(0);
  expect(await writes(page)).toEqual([]);
});

test('a blocked task checkpoint reports the failure without replacing focused text and recovers when storage returns', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('recued.task.draft-recovery.v1:') && document.documentElement.dataset.workStorageBlocked === '1') throw new DOMException('Full', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  await install(page, 'task'); await open(page, 'task');
  const dialog = editor(page, 'task'), text = dialog.getByLabel('Notes', { exact: true });
  await page.evaluate(() => { document.documentElement.dataset.workStorageBlocked = '1'; }); await text.fill('Latest text'); await page.clock.runFor(350);
  await expect(dialog.locator('[data-work-recovery-status]')).toContainText('Latest edits could not be kept'); await expect(text).toBeFocused(); await expect(text).toHaveValue('Latest text');
  await page.evaluate(() => { delete document.documentElement.dataset.workStorageBlocked; }); await text.fill('Kept text'); await page.clock.runFor(350);
  await expect(dialog.locator('[data-work-recovery-status]')).toHaveText('Changes kept in this tab.'); await reload(page);
  await recovery(page, 'task').getByRole('button', { name: 'Review draft', exact: true }).click();
  await expect(recovery(page, 'task').getByLabel('Draft notes', { exact: true })).toHaveValue('Kept text'); expect(await writes(page)).toEqual([]);
});
