import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const reader = (page: Page) => page.locator('.work-entity-task-reader');
const link = (page: Page, kind: 'mail' | 'calendar' = 'mail') => reader(page).locator(`a[data-task-note-link][href*="#data/${kind}/record/"]`);
const back = (page: Page) => page.getByRole('button', { name: 'Back to task', exact: true });
const email = (page: Page) => page.getByRole('article', { name: 'Email message', exact: true });
const event = (page: Page) => page.locator('.calendar-event');
const sourceUrl = (f: Fixture, kind: 'mail' | 'calendar') => HARNESS_URL.split('#')[0].split('?')[0] + serializeSourceRecordAddress(f.source(kind));
const boot = async (page: Page, prepare?: (f: Fixture) => void, hash = '#data/task/task-one') => {
  const f = await installTaskNoteSourceFixture(page);
  f.update({ body: `Email: ${sourceUrl(f, 'mail')}\nEvent: ${sourceUrl(f, 'calendar')}\n\n${f.task().body}` }); prepare?.(f);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true); return f;
};

for (const kind of ['mail', 'calendar'] as const) test(`opens the exact ${kind} source and restores the task's keyboard focus and scroll`, async ({ page }, info) => {
  const f = await boot(page), original = f.task();
  try {
    await link(page, kind).focus(); const scroll = await reader(page).locator('.work-entity-task-content').evaluate(el => el.scrollTop);
    await link(page, kind).press('Enter'); await expect(back(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(serializeSourceRecordAddress(f.source(kind)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')+'$'));
    if (kind === 'mail') await expect(email(page)).toContainText('Exact work email body.'); else await expect(event(page)).toContainText('Exact work occurrence');
    expect(f.calls.filter(call => call.method === 'collection.get').map(call => [call.args.platform, call.args.slug, call.args.record_id])).toEqual([[kind, 'work', kind === 'mail' ? f.mailId : f.eventId]]);
    await page.screenshot({ path: info.outputPath(`task-source-${kind}-phone.png`), fullPage: true });
    await back(page).click(); await expect(link(page, kind)).toBeFocused();
    expect(await reader(page).locator('.work-entity-task-content').evaluate(el => el.scrollTop)).toBeCloseTo(scroll, -1);
    expect(f.task()).toEqual(original); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('renders URLs while leaving notes, markup and their stored body unchanged', async ({ page }, info) => {
  const f = await boot(page), original = structuredClone(f.task());
  try {
    // Preview controls are adjacent to URLs; they are separate from saved text.
    const rendered = await reader(page).locator('.work-entity-task-notes').evaluate(node => {
      const copy = node.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('[data-work-link-preview-trigger]').forEach(control => control.remove());
      return copy.textContent;
    });
    expect(rendered).toBe(original.body);
    await expect(reader(page).locator('.work-entity-task-notes a')).toHaveCount(2);
    await expect(reader(page).locator('.work-entity-task-notes script')).toHaveCount(0);
    await link(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('task-note-links-phone.png'), fullPage: true });
    expect(f.task()).toEqual(original); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('browser Back restores a nested task dependency and retains its original task return', async ({ page }) => {
  const f = await boot(page, f => { f.update({ blocks_task_ids: ['task-two'] }); f.updateTask('task-two', { body: `Email: ${sourceUrl(f, 'mail')}` }); });
  try {
    await reader(page).getByRole('button', { name: 'Open task Other task', exact: true }).click();
    await link(page).click(); await expect(email(page)).toContainText('Exact work email body.'); await page.goBack();
    await expect(reader(page).getByRole('heading', { name: 'Other task', exact: true })).toBeVisible(); await expect(link(page)).toBeFocused();
    await back(page).click(); await expect(reader(page).getByRole('heading', { name: 'Plan launch <img src=x>', exact: true })).toBeVisible();
    await reader(page).getByRole('button', { name: 'Back to tasks', exact: true }).click(); await expect(page).toHaveURL(/#data\/task$/); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a source detour preserves the original project and its search', async ({ page }) => {
  const f = await boot(page, undefined, '#data/project/project-one');
  try {
    const query = page.getByRole('searchbox', { name: 'Search this project', exact: true }); await query.fill('launch'); await query.press('Enter');
    await page.locator('[data-project-item-id="task-one"][data-action="project-work-open"]').click();
    await link(page, 'calendar').click(); await expect(event(page)).toContainText('Exact work occurrence'); await back(page).click();
    await reader(page).getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(query).toHaveValue('launch'); await expect(page).toHaveURL(/#data\/project\/project-one$/); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a source detour preserves the universal search query and result focus', async ({ page }) => {
  const f = await boot(page, undefined, '#data/search');
  try {
    const query = page.getByRole('searchbox', { name: 'Search everything', exact: true }); await query.fill('Plan launch');
    const result = page.locator('[data-work-search-group="task"] [data-search-work-id="task-one"]'); await result.click();
    await link(page).click(); await expect(email(page)).toContainText('Exact work email body.'); await back(page).click();
    await reader(page).getByRole('button', { name: 'Back to search', exact: true }).click();
    await expect(query).toHaveValue('Plan launch'); await expect(result).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('keeps a return to Today through a task and its source link', async ({ page }) => {
  const f = await boot(page, f => {
    f.update({ due_at: Date.parse('2026-10-31T19:00:00Z'), blocks_task_ids: ['task-two'] });
    f.updateTask('task-two', { body: `Email: ${sourceUrl(f, 'mail')}` });
  }, '#today');
  try {
    await page.getByRole('combobox', { name: 'Today sphere' }).selectOption('professional');
    const blockers = page.locator('[data-task-blockers="task-one"]'); await blockers.locator('summary').click();
    await blockers.getByRole('link', { name: 'Other task', exact: true }).click(); await link(page).click();
    await expect(email(page)).toContainText('Exact work email body.'); await back(page).click();
    await reader(page).getByRole('button', { name: 'Back to Today', exact: true }).click();
    await expect(page).toHaveURL(/#today$/); await expect(page.getByRole('combobox', { name: 'Today sphere' })).toHaveValue('professional'); await expect(blockers).toHaveAttribute('open', '');
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['mail', 'calendar'] as const) test(`keeps Back to task when the exact ${kind} record was removed`, async ({ page }) => {
  const f = await boot(page, f => f.remove(kind, 'work', kind === 'mail' ? f.mailId : f.eventId));
  try {
    await link(page, kind).click(); await expect(back(page)).toBeVisible(); await expect(page.getByText(/no longer exists|not found|no longer available/i)).toBeVisible();
    await back(page).click(); await expect(link(page, kind)).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('retries a failed exact source read without losing the task return', async ({ page }) => {
  const f = await boot(page, f => f.failSource('collection.get', 'work'));
  try {
    await link(page).click(); await expect(page.getByRole('alert')).toContainText('interrupted'); await expect(back(page)).toBeVisible();
    f.failSource('collection.get', 'work', false); await page.getByRole('button', { name: /Retry|Try again/i }).click();
    await expect(email(page)).toContainText('Exact work email body.'); await back(page).click(); await expect(link(page)).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('rejects a mismatched returned record instead of opening a different message', async ({ page }) => {
  const f = await boot(page, f => f.wrongRecord());
  try {
    await link(page).click(); await expect(page.getByRole('alert')).toContainText('could not be confirmed'); await expect(email(page)).toHaveCount(0);
    await back(page).click(); await expect(link(page)).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a late source read cannot reopen its page after returning and opening another task', async ({ page }) => {
  const f = await boot(page, f => f.holdSource('collection.get', 'work'));
  try {
    await link(page).click(); await expect.poll(() => f.sourceWaiting()).toBe(true); await back(page).click();
    await expect(link(page)).toBeFocused(); await page.evaluate(() => window.__app.setHash('#data/task/task-two'));
    await expect(reader(page).getByRole('heading', { name: 'Other task', exact: true })).toBeVisible();
    f.releaseSource(); await page.waitForFunction(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.some(key => key.startsWith('collection.get:')));
    await expect(reader(page).getByRole('heading', { name: 'Other task', exact: true })).toBeVisible(); await expect(email(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('external links and modified source clicks retain native new-tab behavior and the current reader', async ({ page, context }) => {
  const f = await boot(page, f => f.update({ body: `${f.task().body}\nExternal: https://external.invalid/context` }));
  try {
    await context.route('https://external.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<p>External context</p>' }));
    const external = reader(page).getByRole('link', { name: 'https://external.invalid/context', exact: true });
    const popup = page.waitForEvent('popup'); await external.click(); const other = await popup; await expect(other).toHaveURL('https://external.invalid/context'); await other.close();
    const sourceTab = context.waitForEvent('page'); await link(page).click({ modifiers: ['ControlOrMeta'] }); const source = await sourceTab; await source.waitForLoadState(); await source.close();
    await expect(reader(page)).toBeVisible(); await expect(page).toHaveURL(/#data\/task\/task-one$/); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('browser Back protects an email reply draft before restoring the task', async ({ page }) => {
  const f = await boot(page), prompts: string[] = [];
  try {
    await link(page).click(); await email(page).getByRole('button', { name: 'Reply', exact: true }).click();
    const compose = page.getByRole('dialog', { name: /Reply/ }); await compose.locator('[data-form-field="body"]').fill('Keep this source reply draft.');
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(1); await expect(compose.locator('[data-form-field="body"]')).toHaveValue('Keep this source reply draft.');
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.accept(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(2); await expect(link(page)).toBeFocused(); await expect(compose).toHaveCount(0);
    expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('calendar edits are protected on both the local return and browser Back', async ({ page }) => {
  const f = await boot(page, f => f.editableCalendar()), prompts: string[] = [];
  try {
    await link(page, 'calendar').click(); await event(page).getByRole('button', { name: 'Edit event', exact: true }).click();
    const title = event(page).locator('[data-calendar-event-field="summary"]'); await title.fill('Keep this event edit');
    await back(page).click(); await page.getByRole('button', { name: 'Keep editing', exact: true }).click(); await expect(title).toHaveValue('Keep this event edit');
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(1); await expect(title).toHaveValue('Keep this event edit');
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.accept(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(2); await expect(link(page, 'calendar')).toBeFocused(); expect(f.mutations).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['mail', 'calendar'] as const) test(`a task created from email retains its email return after visiting a ${kind} link`, async ({ page }) => {
  const f = await boot(page);
  try {
    await link(page).click(); await email(page).getByRole('button', { name: 'Create task', exact: true }).click();
    const form = page.locator('.work-entity-dialog[data-kind="task"][data-mode="create"]');
    if (kind === 'calendar') await form.getByLabel('Notes', { exact: true }).fill((await form.getByLabel('Notes', { exact: true }).inputValue()) + `\nEvent: ${sourceUrl(f, 'calendar')}`);
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(reader(page).getByRole('heading', { name: 'Exact work email', exact: true })).toBeVisible();
    await link(page, kind).click();
    if (kind === 'mail') await expect(email(page)).toContainText('Exact work email body.'); else await expect(event(page)).toContainText('Exact work occurrence');
    await back(page).click();
    await reader(page).getByRole('button', { name: 'Back to email', exact: true }).click();
    await expect(email(page)).toContainText('Exact work email body.'); await expect(email(page).getByRole('button', { name: 'Create task', exact: true })).toBeFocused(); await back(page).click();
    await expect(reader(page).getByRole('heading', { name: 'Plan launch <img src=x>', exact: true })).toBeVisible();
    expect(f.writes).toHaveLength(1); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});


test('a concurrent task-note edit cannot move restored focus to a different URL', async ({ page }) => {
  const f = await boot(page);
  try {
    await link(page).click(); await expect(email(page)).toContainText('Exact work email body.');
    f.update({ body: 'Added context: https://external.invalid/new\n'+f.task().body });
    await back(page).click(); await expect(reader(page).locator('.work-entity-task-notes')).toContainText('Added context:');
    await expect(link(page)).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});


test('returning from a source rechecks dependencies and keeps a failed parent read unconfirmed', async ({ page }) => {
  const f = await boot(page, f => f.update({ blocks_task_ids: ['task-two'] }));
  try {
    await expect(reader(page).locator('[data-task-dependency-summary]')).toHaveText('Waiting on 1 task');
    await link(page).click(); await expect(email(page)).toContainText('Exact work email body.');
    f.updateTask('task-two', { done: true }); f.fail('work_entity.get', 'task-one'); await back(page).click();
    await expect(reader(page).locator('[data-task-notice]')).toContainText('Could not refresh this task');
    await expect(reader(page).locator('[data-task-dependency-summary]')).toHaveText('Dependency status unavailable');
    f.fail('work_entity.get', 'task-one', false); await reader(page).getByRole('button', { name: 'Check dependencies again', exact: true }).click();
    await expect(reader(page).locator('[data-task-dependency-summary]')).toHaveText('Dependencies complete'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
