import { expect, test, type Page } from '@playwright/test';
import { reminderDetailLink, type ReminderRecordReference, type Task, type Commitment } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskReaderFixture } from './helpers/task-reader-fixture.js';
import type { ReminderDraftEntry } from '../src/reminders/reminder-draft-recovery.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
type Fixture = Awaited<ReturnType<typeof installTaskReaderFixture>>;
const reader = (page: Page) => page.locator('.work-entity-task-reader, .work-entity-commitment-reader');
const form = (page: Page) => page.locator('[data-work-reminder-slot] [data-reminder-create-form]');
const message = (page: Page) => form(page).getByRole('textbox', { name: 'Reminder', exact: true });
const boot = async (page: Page, kind: 'task' | 'commitment' = 'task', prepare?: (f: Fixture) => void) => {
  const f = await installTaskReaderFixture(page, { reminders: true });
  f.seedCommitment('promise-one'); prepare?.(f);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/${kind}/${kind === 'task' ? 'task-one' : 'promise-one'}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(reader(page)).toBeVisible();
  return f;
};
const open = async (page: Page) => {
  await reader(page).getByRole('button', { name: 'Remind me about this', exact: true }).click();
  await expect(message(page)).toBeFocused();
};
const save = async (page: Page) => {
  await form(page).getByLabel('Date and time (America/Los_Angeles)', { exact: true }).fill('2026-11-02T09:15');
  await form(page).getByRole('button', { name: 'Set reminder', exact: true }).click();
};
const reference = (record: Task | Commitment): ReminderRecordReference => ({
  kind: 'statement' in record ? 'commitment' : 'task', id: record.id, source_id: record.source_id,
  source_record_id: record.source_record_id ?? null, created_at: record.created_at,
});
const linked = (page: Page) => reader(page).locator('[data-work-linked-reminders]');
const linkedRow = (page: Page, id: string) => linked(page).locator(`[data-record-reminder-row="${id}"]`);

for (const kind of ['task', 'commitment'] as const) test(`${kind} reminder recovery keeps its exact source through refresh and Universal Search`, async ({ page }) => {
  const f = await boot(page, kind);
  try {
    const before = structuredClone(kind === 'task' ? f.task() : f.commitment()), ref = reference(before);
    await open(page); await message(page).fill('Kestrel ' + kind + ' follow up');
    await form(page).getByLabel('Date and time (America/Los_Angeles)', { exact: true }).fill('2026-11-02T09:15');
    await form(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    const kept = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('recued.reminder.draft-recovery.v1:'))
      .flatMap(key => JSON.parse(sessionStorage.getItem(key)!) as ReminderDraftEntry[])[0]!);
    expect(kept.values.record_ref).toEqual(ref); expect(f.reminderRequests).toEqual([]);
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await page.evaluate(() => window.__app.setHash('#data/search'));
    await page.getByRole('searchbox', { name: 'Search everything', exact: true }).fill('Kestrel ' + kind);
    await page.getByRole('region', { name: 'Unfinished work search results', exact: true })
      .getByRole('button', { name: 'Resume reminder draft Kestrel ' + kind + ' follow up', exact: true }).click();
    const recovered = page.locator('[data-recued-reminders] [data-reminder-create-form]');
    await expect(recovered.getByRole('link', { name: 'View source ' + kind, exact: true })).toHaveAttribute('href', '#data/' + kind + '/' + before.id);
    await expect(recovered.getByRole('textbox', { name: 'Reminder', exact: true })).toHaveValue('Kestrel ' + kind + ' follow up');
    await recovered.getByRole('button', { name: 'Set reminder', exact: true }).click(); await expect(recovered).toHaveCount(0);
    expect(f.reminderRequests).toEqual([{ text: 'Kestrel ' + kind + ' follow up', at: Date.parse('2026-11-02T17:15Z'), creation_id: kept.values.creationId, record_ref: ref }]);
    expect(kind === 'task' ? f.task() : f.commitment()).toEqual(before); expect(f.writes).toEqual([]); expect(f.reminders()).toHaveLength(1);
  } finally { f.dispose(); }
});

test('keeps a Remind again draft with its source while leaving the original reminder in history', async ({ page }) => {
  const f = await boot(page), source = structuredClone(f.task());
  try {
    const ref = reference(source), id = f.seedReminder({ text: 'Kestrel history follow up', at: Date.parse('2026-11-01T10:00Z'), state: 'delivered', record_ref: ref });
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await linked(page).locator('summary').click(); await linkedRow(page, id).getByRole('button', { name: 'Remind again', exact: true }).click();
    const again = linked(page).locator('[data-reminder-create-form]');
    await again.getByLabel('Date and time (America/Los_Angeles)', { exact: true }).fill('2026-11-02T09:15');
    await again.getByRole('button', { name: 'Keep draft for later', exact: true }).click(); await expect(again).toHaveCount(0);
    await page.evaluate(() => window.__app.setHash('#data/reminder'));
    const recoveries = page.getByRole('region', { name: 'Unfinished reminders and alarms', exact: true });
    await recoveries.getByRole('button', { name: 'Resume draft', exact: true }).click();
    const recovered = page.locator('[data-recued-reminders] [data-reminder-create-form]');
    await expect(recovered.getByRole('heading', { name: 'Remind again', exact: true })).toBeVisible();
    await recovered.getByRole('button', { name: 'Set reminder', exact: true }).click(); await expect(recovered).toHaveCount(0);
    expect(f.reminder(id)?.state).toBe('delivered'); expect(f.reminderRequests).toHaveLength(1);
    expect(f.reminderRequests[0]?.record_ref).toEqual(ref); expect(f.task()).toEqual(source); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['task', 'commitment'] as const) test(`${kind} creates an independent reminder and its retained detail opens the exact reader and returns`, async ({ page }, info) => {
  const f = await boot(page, kind, kind === 'task' ? f => f.writable(false) : undefined);
  try {
    const before = structuredClone(kind === 'task' ? f.task() : f.commitment());
    await open(page);
    await expect(message(page)).toHaveValue('Follow up: ' + (kind === 'task' ? f.task().title : f.commitment().statement));
    await message(page).fill('Review <proposal> & call Riley');
    await save(page);
    await expect(form(page)).toHaveCount(0);
    await expect(reader(page).locator('[data-work-reminder-notice]')).toContainText('9:15 AM');
    expect(f.reminders()).toHaveLength(1);
    const reminder = f.reminders()[0]!;
    expect(reminder).toMatchObject({ text: 'Review <proposal> & call Riley', at: Date.parse('2026-11-02T17:15:00Z'),
      record_ref: { kind, id: before.id, source_id: before.source_id, source_record_id: before.source_record_id ?? null, created_at: before.created_at } });
    expect(kind === 'task' ? f.task() : f.commitment()).toEqual(before); expect(f.writes).toEqual([]);
    f.cancelReminder(reminder.reminder_id);
    await page.evaluate(hash => window.__app.setHash(hash), reminderDetailLink(reminder.reminder_id));
    const detail = page.locator('.reminders-detail');
    await expect(detail).toContainText('Cancelled');
    await detail.getByRole('button', { name: 'Open ' + kind, exact: true }).click();
    await expect(reader(page)).toBeVisible();
    await expect(reader(page).getByRole('button', { name: 'Back to reminder', exact: true })).toBeVisible();
    await reader(page).getByRole('button', { name: 'Back to reminder', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Open ' + kind, exact: true })).toBeFocused();
    await detail.getByRole('button', { name: 'Open ' + kind, exact: true }).click();
    await expect(reader(page)).toBeVisible(); await page.goBack();
    await expect(detail).toContainText('Review <proposal> & call Riley');
    await page.screenshot({ animations: 'disabled', path: info.outputPath(kind + '-linked-reminder.png') });
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('keeps a contextual draft through a repaint, blocks competing actions and returns focus on Cancel', async ({ page }) => {
  const f = await boot(page, 'task', f => f.hold('work_entity.get', 'project-one'));
  try {
    await expect.poll(() => f.waiting()).toBe(true);
    await open(page); await message(page).fill('My unfinished reminder');
    await message(page).evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(3, 8));
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(message(page)).toHaveValue('My unfinished reminder'); await expect(message(page)).toBeFocused();
    f.release();
    await expect(reader(page).getByRole('button', { name: 'Open project Launch <img src=x> project', exact: true })).toBeVisible();
    await expect(message(page)).toHaveValue('My unfinished reminder');
    await expect(message(page)).toBeFocused();
    expect(await message(page).evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([3, 8]);
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(reader(page).getByRole('button', { name: 'Remind me about this', exact: true })).toBeFocused();
    expect(f.reminderRequests).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a late linked-record read cannot replace a newer reminder view', async ({ page }) => {
  const f = await boot(page);
  try {
    await open(page); await save(page); await expect(form(page)).toHaveCount(0);
    const original = f.reminders()[0]!;
    await page.evaluate(hash => window.__app.setHash(hash), reminderDetailLink(original.reminder_id));
    f.hold('work_entity.get', 'task-one');
    await page.locator('.reminders-detail').getByRole('button', { name: 'Open task', exact: true }).click();
    await expect.poll(() => f.waiting()).toBe(true);
    await page.locator('[data-recued-reminders]').getByRole('button', { name: 'Back to reminders', exact: true }).click();
    await expect(page).toHaveURL(/#data\/reminder$/);
    f.release();
    await expect(page.locator('[data-recued-reminders]').getByRole('searchbox', { name: 'Search reminders', exact: true })).toBeVisible();
    await expect(reader(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('retries a lost creation reply with one stable identity even after the source was removed', async ({ page }) => {
  const f = await boot(page);
  try {
    await open(page); f.loseReminderReply(); await save(page);
    await expect(form(page).getByRole('alert')).toContainText('reply was lost');
    const original = f.reminders()[0]!;
    f.removeTask('task-one');
    await form(page).getByRole('button', { name: 'Check save', exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    expect(f.reminderRequests).toHaveLength(2); expect(f.reminderRequests[0]).toEqual(f.reminderRequests[1]);
    expect(f.reminders().map(row => row.reminder_id)).toEqual([original.reminder_id]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('refuses old-server support and source replacement before creating, and ignores a late open in another reader', async ({ page }) => {
  const f = await boot(page);
  try {
    f.reminderLinks(false);
    await reader(page).getByRole('button', { name: 'Remind me about this', exact: true }).click();
    await expect(reader(page).getByRole('alert')).toContainText('Update the server'); expect(f.reminderRequests).toEqual([]);
    f.reminderLinks(true); f.hold('work_entity.get', 'task-one');
    await reader(page).getByRole('button', { name: 'Remind me about this', exact: true }).click();
    await expect.poll(() => f.waiting()).toBe(true);
    await page.evaluate(() => window.__app.setHash('#data/task/task-two'));
    await expect(reader(page).getByRole('heading', { name: 'Other task', exact: true })).toBeVisible();
    f.release(); await expect(form(page)).toHaveCount(0);
    await page.evaluate(() => window.__app.setHash('#data/task/task-one'));
    await expect(reader(page).getByRole('heading', { name: 'Plan launch <img src=x>', exact: true })).toBeVisible();
    f.replaceTask();
    await reader(page).getByRole('button', { name: 'Remind me about this', exact: true }).click();
    await expect(reader(page).getByRole('alert')).toContainText('changed or is unavailable');
    expect(f.reminderRequests).toEqual([]);
  } finally { f.dispose(); }
});

test('refuses a deleted or reused linked record, retries failed reads, and preserves the binding in Remind again', async ({ page }) => {
  const f = await boot(page);
  try {
    await open(page); await save(page); await expect(form(page)).toHaveCount(0);
    const original = f.reminders()[0]!;
    f.cancelReminder(original.reminder_id);
    await page.evaluate(hash => window.__app.setHash(hash), reminderDetailLink(original.reminder_id));
    const detail = page.locator('.reminders-detail'), target = detail.getByRole('button', { name: 'Open task', exact: true });
    f.fail('work_entity.get', 'task-one'); await target.click();
    await expect(detail.getByRole('alert')).toContainText('interrupted');
    f.fail('work_entity.get', 'task-one', false); f.replaceTask(); await target.click();
    await expect(detail.getByRole('alert')).toContainText('removed or replaced');
    f.removeTask('task-one'); await target.click();
    await expect(detail.getByRole('alert')).toContainText('removed or replaced');
    await detail.getByRole('button', { name: 'Remind again', exact: true }).click();
    const again = page.locator('[data-reminders-create-slot] [data-reminder-create-form]');
    await again.getByRole('button', { name: 'Set reminder', exact: true }).click();
    await expect(again.getByRole('alert')).toContainText('removed, replaced');
    expect(f.reminderRequests.at(-1)?.record_ref).toEqual(original.record_ref);
    expect(f.reminders()).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['task', 'commitment'] as const) test(`${kind} manages exact linked reminders and recent history inside the same reader`, async ({ page }, info) => {
  const ids: string[] = [];
  const f = await boot(page, kind, f => {
    if (kind === 'task') f.writable(false);
    const record_ref = reference(kind === 'task' ? f.task() : f.commitment());
    for (let i = 0; i < 25; i++) ids.push(f.seedReminder({ text: `Linked ${i} <proposal>`, at: Date.parse('2026-11-02T17:00:00Z') + i * 60_000, record_ref }));
    for (let i = 0; i < 22; i++) f.seedReminder({ text: 'Earlier linked ' + i, at: Date.parse('2026-11-01T18:00:00Z') + i * 60_000, record_ref, state: 'delivered' });
    f.seedReminder({ text: 'Reused record reminder', at: Date.parse('2026-11-02T16:00:00Z'), record_ref: { ...record_ref, created_at: record_ref.created_at + 1 } });
    f.seedReminder({ text: 'Unbound reminder', at: Date.parse('2026-11-02T16:00:00Z') });
  });
  try {
    const source = structuredClone(kind === 'task' ? f.task() : f.commitment());
    await expect(linked(page).locator('[data-record-reminder-row]')).toHaveCount(20);
    await expect(linked(page)).toContainText('20 of 25 waiting');
    await expect(linked(page)).toContainText('America/Los_Angeles');
    await expect(linked(page)).not.toContainText('Reused record reminder');
    await expect(linked(page)).not.toContainText('Unbound reminder');
    f.failReminderPages(true);
    await linked(page).getByRole('button', { name: 'Load more reminders', exact: true }).click();
    await expect(linked(page).getByRole('alert')).toContainText('interrupted');
    await expect(linked(page).locator('[data-record-reminder-row]')).toHaveCount(20);
    f.failReminderPages(false);
    await linked(page).getByRole('button', { name: 'Load more reminders', exact: true }).click();
    await expect(linked(page).locator('[data-record-reminder-row]')).toHaveCount(25);
    const id = ids[24]!;
    await linkedRow(page, id).getByRole('button', { name: 'Reschedule', exact: true }).click();
    const detail = linked(page).locator('.reminders-detail');
    await expect(detail.getByRole('textbox', { name: 'Reminder', exact: true })).toBeFocused();
    await detail.getByRole('textbox', { name: 'Reminder', exact: true }).fill('Call Riley about <proposal>');
    await detail.getByRole('button', { name: 'Tomorrow at 9am', exact: true }).click();
    await detail.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Edit reminder', exact: true })).toBeVisible();
    expect(f.reminder(id)?.text).toBe('Call Riley about <proposal>');
    await linked(page).getByRole('button', { name: 'Back to linked reminders', exact: true }).click();
    await expect(linkedRow(page, id).getByRole('button', { name: 'Reschedule', exact: true })).toBeFocused();
    await expect(linked(page).locator('[data-record-reminder-row]')).toHaveCount(25);
    await linkedRow(page, id).getByRole('button', { name: 'Cancel', exact: true }).click();
    await linked(page).getByRole('button', { name: 'Cancel it', exact: true }).click();
    await expect(detail).toContainText('Cancelled');
    await linked(page).getByRole('button', { name: 'Back to linked reminders', exact: true }).click();
    await expect(linked(page)).toContainText('24 of 24 waiting');
    await linked(page).locator('summary').click();
    await expect(linked(page)).toContainText('20 of 23 in recent history');
    await linked(page).getByRole('button', { name: 'Load more history', exact: true }).click();
    await expect(linked(page)).toContainText('23 of 23 in recent history');
    await linkedRow(page, id).getByRole('button', { name: 'Remind again', exact: true }).click();
    const again = linked(page).locator('[data-reminder-create-form]');
    await expect(again.getByRole('textbox', { name: 'Reminder', exact: true })).toHaveValue('Call Riley about <proposal>');
    await again.getByLabel('Date and time (America/Los_Angeles)', { exact: true }).fill('2026-11-03T09:15');
    f.loseReminderReply();
    await again.getByRole('button', { name: 'Set reminder', exact: true }).click();
    await expect(again.getByRole('alert')).toContainText('reply was lost');
    await again.getByRole('button', { name: 'Check save', exact: true }).click();
    await expect(again).toHaveCount(0);
    expect(f.reminderRequests).toHaveLength(2);
    expect(f.reminderRequests[0]?.creation_id).toBe(f.reminderRequests[1]?.creation_id);
    expect(f.reminderRequests[0]?.record_ref).toEqual(reference(source));
    expect(f.reminder(id)?.state).toBe('cancelled');
    await linked(page).getByRole('button', { name: 'Back to linked reminders', exact: true }).click();
    await expect(linked(page)).toContainText('25 of 25 waiting');
    await expect(linked(page)).toContainText('23 of 23 in recent history');
    await expect(page).toHaveURL(new RegExp(`#data/${kind}/${source.id}$`));
    expect(kind === 'task' ? f.task() : f.commitment()).toEqual(source); expect(f.writes).toEqual([]);
    await page.screenshot({ animations: 'disabled', path: info.outputPath(kind + '-linked-reminder-management.png') });
  } finally { f.dispose(); }
});

test('protects an embedded edit across source actions and repaint, then refreshes after a lost move reply', async ({ page }) => {
  let id = '';
  const f = await boot(page, 'task', f => {
    id = f.seedReminder({ text: 'Original linked words', at: Date.parse('2026-11-02T17:00:00Z'), record_ref: reference(f.task()) });
    f.hold('work_entity.get', 'project-one');
  });
  try {
    await expect.poll(() => f.waiting()).toBe(true);
    await linkedRow(page, id).getByRole('button', { name: 'Reschedule', exact: true }).click();
    const field = linked(page).getByRole('textbox', { name: 'Reminder', exact: true });
    await field.fill('Unfinished follow-up');
    await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(field).toHaveValue('Unfinished follow-up');
    await expect(field).toBeFocused();
    await reader(page).getByRole('button', { name: 'Remind me about this', exact: true }).click();
    await expect(form(page)).toHaveCount(0); await expect(field).toHaveValue('Unfinished follow-up');
    const at = linked(page).locator('input[type="datetime-local"]');
    await at.evaluate(node => { Object.assign(window, { __heldLinkedTime: node }); });
    f.release();
    await expect(reader(page).getByRole('button', { name: 'Open project Launch <img src=x> project', exact: true })).toBeVisible();
    expect(await at.evaluate(node => node === (window as unknown as { __heldLinkedTime: Element }).__heldLinkedTime)).toBe(true);
    await expect(field).toHaveValue('Unfinished follow-up');
    f.loseReminderUpdate();
    await linked(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(linked(page).getByRole('alert')).toContainText('reply was lost');
    expect(f.reminder(id)?.text).toBe('Unfinished follow-up');
    await linked(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(linked(page).getByRole('button', { name: 'Edit reminder', exact: true })).toBeVisible();
    await linked(page).getByRole('button', { name: 'Back to linked reminders', exact: true }).click();
    await expect(linkedRow(page, id)).toContainText('Unfinished follow-up');
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('reports missing server filtering and retires a late detail read when a different record opens', async ({ page }) => {
  let id = '';
  const f = await boot(page, 'task', f => {
    f.reminderRecordFiltering(false);
    id = f.seedReminder({ text: 'Original lifetime reminder', at: Date.parse('2026-11-02T17:00:00Z'), record_ref: reference(f.task()) });
  });
  try {
    await expect(linked(page).getByRole('alert')).toContainText('Update your Recued server');
    await expect(linked(page)).not.toContainText('No linked reminders waiting');
    f.reminderRecordFiltering(true);
    await linked(page).getByRole('button', { name: 'Refresh linked reminders', exact: true }).click();
    await expect(linkedRow(page, id)).toBeVisible();
    f.hold('reminder.get', id);
    await linkedRow(page, id).getByRole('button', { name: 'Reschedule', exact: true }).click();
    await expect.poll(() => f.waiting()).toBe(true);
    await page.evaluate(() => window.__app.setHash('#data/task/task-two'));
    await expect(reader(page).getByRole('heading', { name: 'Other task', exact: true })).toBeVisible();
    f.release();
    await expect(linked(page)).toContainText('No linked reminders waiting');
    await expect(linked(page).locator('.reminders-detail')).toHaveCount(0);
    f.replaceTask();
    await page.evaluate(() => window.__app.setHash('#data/task/task-one'));
    await expect(reader(page).getByRole('heading', { name: 'Reused task identity', exact: true })).toBeVisible();
    await expect(linked(page)).toContainText('No linked reminders waiting');
    expect(f.reminder(id)?.text).toBe('Original lifetime reminder'); expect(f.reminderWrites).toEqual([]);
  } finally { f.dispose(); }
});

test('allows one reminder workflow while creation or an existing reminder is still opening', async ({ page }) => {
  let id = '';
  const f = await boot(page, 'task', f => {
    id = f.seedReminder({ text: 'Existing reminder', at: Date.parse('2026-11-02T17:00:00Z'), record_ref: reference(f.task()) });
  });
  try {
    await expect(linkedRow(page, id)).toBeVisible();
    f.hold('work_entity.get', 'task-one');
    await reader(page).getByRole('button', { name: 'Remind me about this', exact: true }).click();
    await expect.poll(() => f.waiting()).toBe(true);
    await linkedRow(page, id).getByRole('button', { name: 'Reschedule', exact: true }).click();
    await expect(linked(page).locator('.reminders-edit')).toHaveCount(0);
    f.release(); await expect(message(page)).toBeFocused();
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    f.hold('reminder.get', id);
    await linkedRow(page, id).getByRole('button', { name: 'Reschedule', exact: true }).click();
    await expect.poll(() => f.waiting()).toBe(true);
    await open(page); await message(page).fill('Keep this new reminder draft');
    f.release();
    await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.includes('reminder.get:'));
    await expect(linked(page).locator('.reminders-detail')).toHaveCount(0);
    await expect(message(page)).toHaveValue('Keep this new reminder draft');
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(f.reminderRequests).toEqual([]); expect(f.reminderWrites).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
