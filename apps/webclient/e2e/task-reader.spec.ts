import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskReaderFixture } from './helpers/task-reader-fixture.js';
import { installTaskCalendarFixture } from './helpers/task-calendar-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installTaskReaderFixture>>;
const reader = (page: Page) => page.locator('.work-entity-task-reader');
const editor = (page: Page) => page.locator('.work-entity-dialog[data-kind="task"][data-mode="edit"]');
const contact = (page: Page) => reader(page).getByRole('button', { name: 'Open contact Riley <img src=x>', exact: true });
const project = (page: Page) => reader(page).getByRole('button', { name: 'Open project Launch <img src=x> project', exact: true });
const boot = async (page: Page, prepare?: (fixture: Fixture) => void, hash = '#data/task/task-one') => {
  const fixture = await installTaskReaderFixture(page); prepare?.(fixture);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(reader(page)).toBeVisible();
  return fixture;
};

test('opens a readable task without a draft and completes and reopens only its lifecycle', async ({ page }, info) => {
  const f = await boot(page);
  try {
    await expect(reader(page).getByRole('heading', { name: 'Plan launch <img src=x>', exact: true })).toBeVisible();
    await expect(reader(page)).toContainText(/Nov 1, 2026(?:,| at) 1:30 AM PDT/);
    await expect(reader(page)).toContainText('High'); await expect(reader(page).locator('.work-entity-task-notes')).toHaveText(f.task().body!);
    await expect(reader(page).locator('textarea,input')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { taskMarkupExecuted?: boolean }).taskMarkupExecuted)).toBeUndefined();
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes('work-draft') && sessionStorage.getItem(key)?.includes('task-one')))).toEqual([]);
    await expect(project(page)).toBeVisible(); await expect(contact(page)).toBeVisible();
    await page.screenshot({ path: info.outputPath('task-reader-phone.png'), fullPage: true });
    await reader(page).getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(reader(page).locator('[data-task-completion-status]')).toHaveText('Task completed.');
    await reader(page).getByRole('button', { name: 'Reopen', exact: true }).click();
    await expect(reader(page).locator('[data-task-completion-status]')).toHaveText('Task reopened.');
    expect(f.writes).toEqual([{ method: 'work_entity.task.mark_done', args: { id: 'task-one', done: true } }, { method: 'work_entity.task.mark_done', args: { id: 'task-one', done: false } }]);
    expect(f.task().body).toContain('Bring the launch agenda.');
  } finally { f.dispose(); }
});

test('edits and saves into the reader, retaining a timed due date down to milliseconds', async ({ page }, info) => {
  const f = await boot(page), due = f.task().due_at;
  try {
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(page).getByLabel('Title')).toBeFocused();
    await editor(page).getByLabel('Title').fill('Review the launch');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page).getByRole('heading', { name: 'Review the launch', exact: true })).toBeVisible();
    await expect(reader(page).locator('[data-task-notice]')).toHaveText('Task saved.');
    await expect(reader(page).locator('[data-task-notice]')).toBeFocused();
    expect(f.task().due_at).toBe(due); expect(f.writes).toHaveLength(1);
    await page.screenshot({ path: info.outputPath('task-reader-saved-phone.png'), fullPage: true });
  } finally { f.dispose(); }
});

test('Cancel keeps or discards edits back to the reader, while reload can resume an unfinished edit', async ({ page }) => {
  const f = await boot(page);
  try {
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByLabel('Title').fill('Unfinished launch');
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(editor(page).getByLabel('Title')).toHaveValue('Unfinished launch');
    await page.reload(); await expect(reader(page)).toBeVisible();
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor(page).getByLabel('Title')).toHaveValue('Unfinished launch');
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(reader(page).getByRole('heading', { name: 'Plan launch <img src=x>', exact: true })).toBeVisible();
    await expect(reader(page).getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('due shortcuts read the current task and enter a recoverable editor for review before saving', async ({ page }) => {
  const f = await boot(page);
  try {
    await reader(page).getByRole('button', { name: 'Due tomorrow', exact: true }).click();
    await expect(editor(page).getByLabel('Due date', { exact: true })).toHaveValue('2026-11-01T01:30');
    expect(f.writes).toEqual([]);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page)).toBeVisible(); expect(f.task().due_at).toBe(Date.parse('2026-11-01T08:30:12.345Z'));
    await reader(page).getByRole('button', { name: 'Clear due date', exact: true }).click();
    await expect(editor(page).getByLabel('Due date', { exact: true })).toHaveValue('');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page)).toContainText('No due date'); expect(f.task().due_at).toBeUndefined();
  } finally { f.dispose(); }
});

test('opens the exact assigned contact and restores task scroll and keyboard focus on Back', async ({ page }) => {
  const f = await boot(page);
  try {
    await expect(contact(page)).toBeVisible(); await contact(page).focus();
    const scroll = await reader(page).locator('.work-entity-task-content').evaluate(el => el.scrollTop);
    await contact(page).press('Enter');
    await expect(page.getByRole('button', { name: '← Back to task', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#data\/contact\/riley%40example.test$/);
    await page.getByRole('button', { name: '← Back to task', exact: true }).click();
    await expect(contact(page)).toBeFocused();
    expect(await reader(page).locator('.work-entity-task-content').evaluate(el => el.scrollTop)).toBeCloseTo(scroll, -1);
    expect(f.reads.some(read => read.method === 'contact.get' && read.id === f.person.contact_id)).toBe(true); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('nested project and task visits return through their own contexts and browser Back restores the original task', async ({ page }) => {
  const f = await boot(page);
  try {
    await project(page).click(); await expect(page.locator('.project-overview')).toBeVisible();
    await page.locator('[data-action="project-work-open"][data-project-item-id="task-two"]').click();
    await expect(reader(page).getByRole('heading', { name: 'Other task', exact: true })).toBeVisible();
    await project(page).click(); await page.getByRole('button', { name: 'Back to task', exact: true }).click();
    await expect(reader(page).getByRole('heading', { name: 'Other task', exact: true })).toBeVisible();
    await reader(page).getByRole('button', { name: 'Back to project', exact: true }).click();
    await page.getByRole('button', { name: 'Back to task', exact: true }).click();
    await expect(reader(page).getByRole('heading', { name: 'Plan launch <img src=x>', exact: true })).toBeVisible();
    await project(page).click(); await page.goBack();
    await expect(project(page)).toBeFocused(); await expect(page).toHaveURL(/#data\/task\/task-one$/); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const state of ['read-only', 'stale', 'pending'] as const) test(`reads a ${state} task and related context without offering writes`, async ({ page }) => {
  const f = await boot(page, fixture => {
    if (state === 'read-only') fixture.writable(false);
    if (state === 'stale') fixture.update({ sync_state: 'stale_unreachable' });
    if (state === 'pending') fixture.update({ pending_write: { staged_at: Date.now(), operation: 'update', dirty_fields: ['title'], state: 'awaiting_verify' } });
  });
  try {
    await expect(reader(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(reader(page).getByRole('button', { name: 'Complete', exact: true })).toHaveCount(0);
    await expect(project(page)).toBeVisible(); await expect(reader(page).locator('.work-entity-task-notes')).toHaveText(f.task().body!); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const fault of ['source-revoked', 'read-failed'] as const) test(`keeps the reader when opening Edit finds ${fault}`, async ({ page }) => {
  const f = await boot(page);
  try {
    if (fault === 'source-revoked') f.writable(false); else f.fail('work_entity.get', 'task-one');
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(reader(page).locator('[data-task-notice]')).toContainText(fault === 'source-revoked' ? 'cannot be edited' : 'Could not open the editor');
    await expect(editor(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a late related-record open cannot replace a newer task visit', async ({ page }) => {
  const f = await boot(page);
  try {
    await expect(project(page)).toBeVisible(); f.hold('work_entity.get', 'project-one'); await project(page).click();
    await expect.poll(() => f.waiting()).toBe(true);
    await page.evaluate(() => window.__app.setHash('#data/task/task-two'));
    await expect(reader(page).getByRole('heading', { name: 'Other task', exact: true })).toBeVisible();
    f.release(); await expect(project(page)).toBeVisible();
    await expect(page).toHaveURL(/#data\/task\/task-two$/); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a hidden reader lookup cannot repaint a project query typed in the task editor', async ({ page }) => {
  const f = await boot(page, fixture => fixture.hold('work_entity.get', 'project-one'));
  try {
    await expect.poll(() => f.waiting()).toBe(true);
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByRole('button', { name: 'More details', exact: true }).click();
    const query = editor(page).getByRole('combobox', { name: 'Parent project', exact: true });
    await expect(query).toHaveValue('Launch <img src=x> project · Recued');
    await query.fill('Other');
    f.release();
    await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(key => key === 'work_entity.get:project-one').length >= 2);
    await expect(query).toHaveValue('Other'); await expect(query).toBeFocused();
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('missing related records are retryable, and activation rechecks a replaced project identity', async ({ page }) => {
  const f = await boot(page, fixture => fixture.removeProject());
  try {
    await expect(reader(page)).toContainText('This project is no longer available.'); f.restoreProject();
    await reader(page).getByRole('button', { name: 'Try again', exact: true }).click(); await expect(project(page)).toBeVisible();
    f.removeProject(); f.restoreProject(2); await project(page).click();
    await expect(reader(page)).toContainText('Could not load this project. Try again.');
    await expect(page.locator('.project-overview')).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a reused task id cannot open an editor for a different incarnation', async ({ page }) => {
  const f = await boot(page);
  try {
    f.replaceTask(); await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(reader(page)).toContainText('changed identity'); await expect(editor(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const reply of ['lost', 'pending'] as const) test(`an edit with a ${reply} save reply stays in its recoverable editor`, async ({ page }) => {
  const f = await boot(page);
  try {
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click(); await editor(page).getByLabel('Title').fill('Unconfirmed edit'); f.reply(reply);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toContainText(reply === 'lost' ? 'lost' : 'not confirmed');
    await expect(editor(page).getByLabel('Title')).toHaveValue('Unconfirmed edit'); await expect(reader(page)).toHaveCount(0); expect(f.writes).toHaveLength(1);
  } finally { f.dispose(); }
});

test('whole-day deadlines retain their calendar date in a western device zone', async ({ page }) => {
  const f = await boot(page, fixture => fixture.update({ due_at: Date.parse('2026-11-01T00:00:00Z') }));
  try { await expect(reader(page)).toContainText('Nov 1, 2026'); await expect(reader(page)).not.toContainText('Oct 31, 2026'); }
  finally { f.dispose(); }
});

test.describe('schedule calendar time for a task', () => {
  const form = (page: Page) => page.getByRole('region', { name: 'Time for task', exact: true });
  const recovery = (page: Page) => page.getByRole('region', { name: 'Unfinished calendar events', exact: true });
  const schedule = (page: Page) => reader(page).getByRole('button', { name: 'Schedule time', exact: true });
  const bootCalendar = async (page: Page, prepare?: (f: Awaited<ReturnType<typeof installTaskCalendarFixture>>) => void) => {
    const f = await installTaskCalendarFixture(page);
    try {
      prepare?.(f);
      await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple&token=not-for-notes#data/task/task-one`);
      await page.waitForFunction(() => window.__app?.ready === true); await expect(reader(page)).toBeVisible();
      return f;
    } catch (error) { await f.dispose(); throw error; }
  };
  const dates = async (page: Page) => {
    await form(page).getByLabel('Starts', { exact: true }).fill('2026-11-02T09:00');
    await form(page).getByLabel('Ends', { exact: true }).fill('2026-11-02T10:00');
  };
  const reload = async (page: Page) => {
    const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); }; page.on('dialog', accept);
    try { await page.reload(); } finally { page.off('dialog', accept); }
    await page.waitForFunction(() => window.__app?.ready === true);
  };
  const sourceUrl = () => HARNESS_URL.split(/[?#]/)[0] + '#data/task/task-one';

  test('reviews fresh task details, reserves calendar time and returns without changing the task', async ({ page }, info) => {
    const f = await bootCalendar(page);
    try {
      f.task.update({ title: 'Fresh <review> & planning' }); const before = f.task.task();
      await schedule(page).click();
      await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue(before.title);
      await expect(form(page).getByLabel('Notes (optional)', { exact: true })).toHaveValue('Task: ' + sourceUrl());
      await expect(form(page).getByLabel('Starts', { exact: true })).toHaveValue('');
      await expect(form(page).getByLabel('Ends', { exact: true })).toHaveValue('');
      await expect(form(page)).toContainText('Times in America/Los_Angeles');
      await expect(form(page)).toContainText('does not change the task’s deadline or completion status');
      expect(f.task.writes).toEqual([]); expect(f.calendar.requests).toEqual([]);
      await dates(page); await page.setViewportSize({ width: 1280, height: 960 });
      await form(page).getByRole('heading', { name: 'Time for task', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath('task-calendar-desktop.png'), fullPage: true });
      await form(page).getByRole('button', { name: 'Create event', exact: true }).click();
      await expect(page.locator('.calendar-event')).toContainText(before.title);
      expect(f.calendar.requests).toHaveLength(1); expect(f.calendar.providerCalls()).toBe(1);
      expect(f.calendar.requests[0]).toMatchObject({ summary: before.title, description: 'Task: ' + sourceUrl(),
        start_at: Date.parse('2026-11-02T17:00Z'), end_at: Date.parse('2026-11-02T18:00Z'), timezone: 'America/Los_Angeles' });
      for (const key of ['task', 'origin', 'due_at', 'done', 'guests', 'assigned_contact_id']) expect(f.calendar.requests[0]).not.toHaveProperty(key);
      const back = page.getByRole('link', { name: 'Back to task', exact: true }); await expect(back).toHaveAttribute('href', '#data/task/task-one');
      await back.click(); await expect(reader(page).getByRole('heading', { name: before.title, exact: true })).toBeVisible();
      expect(f.task.task()).toEqual(before); expect(f.task.writes).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('recovers an untouched time draft and returns to its task on confirmed Cancel', async ({ page }, info) => {
    const f = await bootCalendar(page);
    try {
      const before = f.task.task(); await schedule(page).click();
      await expect.poll(() => new URL(page.url()).hash).toBe('#data/calendar');
      await expect(form(page).getByLabel('Calendar', { exact: true })).toHaveValue(JSON.stringify(['work', 'primary']));
      await page.screenshot({ path: info.outputPath('task-calendar-phone.png'), fullPage: true });
      await reload(page); await expect(form(page)).toHaveCount(0);
      await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
      await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue(before.title);
      await expect(form(page).getByLabel('Starts', { exact: true })).toHaveValue('');
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await form(page).getByRole('button', { name: 'Keep editing', exact: true }).click(); await expect(form(page)).toBeVisible();
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await form(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
      await expect(schedule(page)).toBeVisible(); expect(new URL(page.url()).hash).toBe('#data/task/task-one');
      expect(f.task.task()).toEqual(before); expect(f.task.writes).toEqual([]); expect(f.calendar.requests).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('checks a lost creation reply after reload with one calendar reservation and the same task context', async ({ page }) => {
    const f = await bootCalendar(page);
    try {
      const before = f.task.task(); await schedule(page).click(); await dates(page); f.calendar.loseNextReply();
      await form(page).getByRole('button', { name: 'Create event', exact: true }).click();
      await expect(form(page).getByRole('button', { name: 'Check save', exact: true })).toBeVisible();
      await reload(page); await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
      await expect(form(page).getByLabel('Title', { exact: true })).toBeDisabled();
      await form(page).getByRole('button', { name: 'Check save', exact: true }).click();
      await expect(page.getByRole('link', { name: 'Back to task', exact: true })).toBeVisible();
      expect(f.calendar.requests).toHaveLength(2); expect(f.calendar.requests[1]).toEqual(f.calendar.requests[0]);
      expect(f.calendar.providerCalls()).toBe(1); expect(f.task.task()).toEqual(before); expect(f.task.writes).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('preserves an older calendar draft while a task reserves a separate new draft', async ({ page }) => {
    const f = await bootCalendar(page);
    try {
      await reader(page).getByRole('button', { name: 'Back to tasks', exact: true }).click();
      await page.getByRole('combobox', { name: 'Collection', exact: true }).selectOption('calendar');
      await page.getByRole('button', { name: 'New event', exact: true }).click();
      await page.getByRole('region', { name: 'New event', exact: true }).getByLabel('Title', { exact: true }).fill('Keep my calendar draft');
      await reload(page); await expect(recovery(page)).toContainText('Keep my calendar draft');
      await page.evaluate(() => window.__app.setHash('#data/task/task-one')); await schedule(page).click();
      await expect(form(page)).toBeVisible(); await expect(recovery(page)).toContainText('Keep my calendar draft');
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await form(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
      await expect(schedule(page)).toBeVisible();
      await reader(page).getByRole('button', { name: 'Back to tasks', exact: true }).click();
      await page.getByRole('combobox', { name: 'Collection', exact: true }).selectOption('calendar');
      await expect(recovery(page)).toContainText('Keep my calendar draft'); expect(f.calendar.requests).toEqual([]); expect(f.task.writes).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('retires a delayed task check and lets another task start its own time draft', async ({ page }) => {
    const f = await bootCalendar(page);
    try {
      f.task.hold('work_entity.get', 'task-one'); await schedule(page).click(); await expect.poll(f.task.waiting).toBe(true);
      await page.evaluate(() => window.__app.setHash('#data/task/task-two'));
      await expect(reader(page).getByRole('heading', { name: 'Other task', exact: true })).toBeVisible();
      await schedule(page).click(); await expect(form(page)).toBeVisible();
      await form(page).getByLabel('Title', { exact: true }).fill('Keep this newer block'); f.task.release();
      await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue('Keep this newer block');
      expect(f.task.writes).toEqual([]); expect(f.calendar.requests).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('allows retry after an interrupted task read and refuses a replacement identity', async ({ page }) => {
    const f = await bootCalendar(page);
    try {
      f.task.fail('work_entity.get', 'task-one'); await schedule(page).click(); await expect(reader(page)).toContainText('interrupted');
      await expect(form(page)).toHaveCount(0); f.task.fail('work_entity.get', 'task-one', false);
      await schedule(page).click(); await expect(form(page)).toBeVisible();
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await form(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
      await expect(schedule(page)).toBeVisible(); f.task.replaceTask(); await schedule(page).click();
      await expect(reader(page)).toContainText('different identity'); await expect(form(page)).toHaveCount(0);
      expect(f.task.writes).toEqual([]); expect(f.calendar.requests).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('refuses a task completed after it was opened and omits scheduling when that completed state is read', async ({ page }) => {
    const f = await bootCalendar(page);
    try {
      f.task.update({ done: true }); await schedule(page).click();
      await expect(reader(page)).toContainText('completed, unavailable or awaiting source confirmation'); await expect(form(page)).toHaveCount(0);
      await reload(page); await expect(reader(page)).toBeVisible(); await expect(schedule(page)).toHaveCount(0);
      expect(f.task.task().done).toBe(true); expect(f.task.writes).toEqual([]); expect(f.calendar.requests).toEqual([]);
    } finally { await f.dispose(); }
  });

  test('can schedule an open read-only task using independently checked calendar authority', async ({ page }) => {
    const f = await bootCalendar(page, f => f.task.writable(false));
    try {
      const before = f.task.task(); await expect(reader(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      await schedule(page).click(); await dates(page); await form(page).getByRole('button', { name: 'Create event', exact: true }).click();
      await expect(page.locator('.calendar-event')).toContainText(before.title);
      expect(f.calendar.requests).toHaveLength(1); expect(f.calendar.requests[0]).not.toHaveProperty('guests');
      expect(f.task.task()).toEqual(before); expect(f.task.writes).toEqual([]);
    } finally { await f.dispose(); }
  });
});

test('clearing the assigned-contact picker removes the native task assignment and survives reopening', async ({ page }, info) => {
  const f = await boot(page), before = f.task();
  try {
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    const details = editor(page).getByRole('button', { name: 'More details', exact: true });
    if (await details.isVisible()) await details.click();
    const picker = editor(page).locator('[data-ref-picker="form-ref-assigned_contact"]');
    await expect(picker.locator('[data-ref-picker-value]')).toHaveValue(before.assigned_contact_id!);
    await picker.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(picker.getByRole('combobox')).toHaveValue('');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page).locator('[data-task-notice]')).toHaveText('Task saved.');
    expect(f.writes.map(row => row.args)).toEqual([{ kind: 'task', id: before.id, clear_assigned_contact: true }]);
    const { assigned_contact_id: _removed, ...other } = before;
    expect(f.task()).toEqual({ ...other, updated_at: before.updated_at + 1000, last_seen_at: before.last_seen_at + 1000 });
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await expect(reader(page).getByRole('button', { name: 'Open contact Riley <img src=x>', exact: true })).toHaveCount(0);
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    if (await details.isVisible()) await details.click(); await expect(picker.getByRole('combobox')).toHaveValue('');
    await page.screenshot({ path: info.outputPath('task-unassigned-phone.png'), fullPage: true });
  } finally { f.dispose(); }
});
