import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installCalendarTaskFixture } from './helpers/calendar-task-fixture.js';

installFullAppHooks(); test.use({ timezoneId: 'Asia/Tokyo' });
const detail = (page: Page) => page.locator('.calendar-event');
const editor = (page: Page) => page.locator('.work-entity-dialog[data-kind="task"]');
const recovery = (page: Page) => page.getByRole('region', { name: 'Unfinished tasks', exact: true });
const create = async (page: Page) => {
  await detail(page).getByRole('button', { name: 'Create follow-up task', exact: true }).click();
  await expect(editor(page)).toHaveAttribute('data-mode', 'create'); await expect(editor(page).getByLabel('Title')).toBeFocused();
};
const boot = async (page: Page, allDay = false, prepare?: (fixture: Awaited<ReturnType<typeof installCalendarTaskFixture>>) => void) => {
  const fixture = await installCalendarTaskFixture(page, allDay); prepare?.(fixture);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/calendar`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.getByLabel('Agenda start date', { exact: true }).fill(allDay ? '2026-10-31' : '2026-10-29');
  await page.locator('[data-collection-record="cal:work:shared-uid"]').first().click();
  await expect(detail(page).getByRole('heading', { name: allDay ? 'Team retreat' : 'Customer planning', exact: true })).toBeVisible();
  return fixture;
};
const reload = async (page: Page) => {
  const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); }; page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); } await page.waitForFunction(() => window.__app?.ready === true);
};

test('reviews a follow-up from a read-only event, saves to the chosen task source, and returns to its agenda date', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 }); const fixture = await boot(page);
  try {
    const origin = new URL(page.url()).hash; await create(page);
    await expect(editor(page).getByLabel('Title')).toHaveValue('Customer planning');
    await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveValue(/Calendar: Planning\nEvent: .*#data\/calendar\/record\/work\/cal%3Awork%3Ashared-uid[\s\S]*9:00:12 AM PDT[\s\S]*Time zone: America\/Los_Angeles[\s\S]*Bring the launch agenda\./);
    await expect(editor(page).locator('[data-form-field="due_at"]')).toHaveValue(''); expect(fixture.writes).toEqual([]);
    await editor(page).getByLabel('Source', { exact: true }).selectOption('other.task');
    await editor(page).getByLabel('Title').fill('Send the launch proposal');
    await editor(page).locator('[data-form-field="due_at"]').fill('2030-10-30T09:45'); await editor(page).getByLabel('Priority', { exact: true }).selectOption('high');
    await page.screenshot({ path: testInfo.outputPath('calendar-task-draft-phone.png'), fullPage: true });
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page)).toHaveCount(0); await expect(detail(page)).toContainText('Task created: Send the launch proposal');
    expect(new URL(page.url()).hash).toBe(origin); await expect(detail(page).getByRole('button', { name: 'Create follow-up task', exact: true })).toBeFocused();
    expect(fixture.writes).toEqual([expect.objectContaining({ kind: 'task', source_id: 'other.task', title: 'Send the launch proposal', due_at: Date.parse('2030-10-30T09:45:00+09:00'), priority: 'high' })]);
    expect(fixture.writes[0]).not.toHaveProperty('parent_calendar_event_id'); expect(fixture.tasks()).toHaveLength(1); expect(fixture.calendarWrites).toEqual([]);
    await detail(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('calendar-task-created-phone.png'), fullPage: true });
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    await expect(page.getByLabel('Agenda start date', { exact: true })).toHaveValue('2026-10-29');
    await page.screenshot({ path: testInfo.outputPath('calendar-task-phone.png'), fullPage: true });
  } finally { fixture.dispose(); }
});

test('requires an explicit discard for the prefilled task and returns to the same event on Cancel', async ({ page }) => {
  const fixture = await boot(page);
  try {
    const origin = new URL(page.url()).hash; await create(page);
    await editor(page).getByRole('button', { name: 'Back to event', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Keep editing', exact: true }).click(); await expect(editor(page).getByLabel('Title')).toHaveValue('Customer planning');
    await editor(page).getByRole('button', { name: 'Back to event', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(editor(page)).toHaveCount(0); expect(new URL(page.url()).hash).toBe(origin);
    await expect(detail(page).getByRole('heading', { name: 'Customer planning', exact: true })).toBeVisible();
    expect(fixture.writes).toEqual([]); expect(fixture.calendarWrites).toEqual([]);
  } finally { fixture.dispose(); }
});

test('recovers an unfinished calendar follow-up after immediate reload with its exact link, chosen source and due date', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await create(page); await editor(page).getByLabel('Source', { exact: true }).selectOption('other.task');
    await editor(page).getByLabel('Title').fill('Recovered event follow-up'); await editor(page).locator('[data-form-field="due_at"]').fill('2030-10-30T09:45');
    const notes = await editor(page).getByLabel('Notes', { exact: true }).inputValue(); await reload(page);
    await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor(page).getByLabel('Title')).toHaveValue('Recovered event follow-up'); await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveValue(notes);
    await expect(editor(page).getByLabel('Source', { exact: true })).toHaveValue('other.task'); await expect(editor(page).locator('[data-form-field="due_at"]')).toHaveValue('2030-10-30T09:45');
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(fixture.tasks()).toHaveLength(1); expect(fixture.tasks()[0]?.body).toContain('#data/calendar/record/work/cal%3Awork%3Ashared-uid');
    expect(fixture.calendarWrites).toEqual([]);
  } finally { fixture.dispose(); }
});

test('browser Back returns to the mounted event while retaining the unfinished task for recovery', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await create(page); await editor(page).getByLabel('Title').fill('Still reviewing this event');
    page.once('dialog', dialog => { void dialog.accept(); }); await page.goBack();
    await expect(detail(page).getByRole('heading', { name: 'Customer planning', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#data\/calendar\/record\/work\/cal%3Awork%3Ashared-uid$/);
    await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/task`); await page.waitForFunction(() => window.__app?.ready === true);
    await expect(recovery(page)).toContainText('Still reviewing this event'); expect(fixture.writes).toEqual([]); expect(fixture.calendarWrites).toEqual([]);
  } finally { fixture.dispose(); }
});

for (const mode of ['unavailable', 'readonly'] as const) test(`keeps the event open when task destinations are ${mode}, then retries preparation`, async ({ page }) => {
  const fixture = await boot(page, false, fixture => { if (mode === 'readonly') fixture.writable(false); else fixture.failSources(true); });
  try {
    await detail(page).getByRole('button', { name: 'Create follow-up task', exact: true }).click();
    await expect(detail(page).getByRole('alert')).toContainText(mode === 'readonly' ? 'No writable task Source' : 'Task Sources could not be loaded');
    await expect(editor(page)).toHaveCount(0); fixture.writable(true); fixture.failSources(false); await create(page);
    expect(fixture.writes).toEqual([]); expect(fixture.calendarWrites).toEqual([]);
  } finally { fixture.dispose(); }
});

test('drops a late preparation after switching calendar occurrences with the same provider UID', async ({ page }) => {
  const fixture = await boot(page);
  try {
    fixture.holdSources(); await detail(page).getByRole('button', { name: 'Create follow-up task', exact: true }).click();
    await expect.poll(() => fixture.waiting()).toBe(true); await page.getByRole('button', { name: '← Back', exact: true }).click();
    await page.locator('[data-collection-record="cal:home:shared-uid"]').click();
    await expect(detail(page).getByRole('heading', { name: 'Family planning', exact: true })).toBeVisible(); fixture.release();
    await expect(editor(page)).toHaveCount(0); await create(page);
    await expect(editor(page).getByLabel('Title')).toHaveValue('Family planning'); await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveValue(/#data\/calendar\/record\/home\/cal%3Ahome%3Ashared-uid/);
    expect(fixture.writes).toEqual([]); expect(fixture.calendarWrites).toEqual([]);
  } finally { fixture.dispose(); }
});

for (const reply of ['lost', 'pending'] as const) test(`does not return or create twice after a ${reply} save confirmation`, async ({ page }) => {
  const fixture = await boot(page);
  try {
    await create(page); fixture.reply(reply); await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toBeVisible(); expect(fixture.tasks()).toHaveLength(1);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor(page).getByRole('alert')).toContainText('previous save was not confirmed');
    expect(fixture.writes).toHaveLength(1); await reload(page); await expect(recovery(page)).toBeVisible();
    await expect(recovery(page).getByRole('button', { name: 'Resume draft', exact: true })).toBeDisabled();
    expect(fixture.writes).toHaveLength(1); expect(fixture.tasks()).toHaveLength(1); expect(fixture.calendarWrites).toEqual([]);
  } finally { fixture.dispose(); }
});

test('copies inclusive all-day dates and marks partial event notes without inventing a task deadline', async ({ page }) => {
  const fixture = await boot(page, true);
  try {
    await create(page); const notes = await editor(page).getByLabel('Notes', { exact: true }).inputValue();
    expect(notes).toContain('October 31, 2026'); expect(notes).toContain('November 2, 2026'); expect(notes).not.toContain('November 3');
    expect(notes).toContain('Event notes (partial):'); await expect(editor(page).locator('[data-form-field="due_at"]')).toHaveValue('');
    expect(fixture.writes).toEqual([]); expect(fixture.calendarWrites).toEqual([]);
  } finally { fixture.dispose(); }
});
