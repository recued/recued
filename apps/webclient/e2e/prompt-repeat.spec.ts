import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installPromptRecoveryFixture, PROMPT_RECOVERY_NOW as NOW } from './helpers/prompt-recovery-fixture.js';
import type { PromptSchedule } from '@recued/contracts';

installFullAppHooks();test.use({ timezoneId: 'America/New_York' });
const form = (page: Page) => page.locator('[data-prompt-schedules] form');
const field = (page: Page, name: string) => form(page).getByLabel(name, { exact: true });
const days = (page: Page) => form(page).getByRole('group', { name: 'Days of week', exact: true });
const preview = (page: Page) => form(page).getByRole('region', { name: 'Schedule preview', exact: true });
const card = (page: Page, saved: PromptSchedule) => page.locator(`[data-schedule-id="${saved.schedule_id}"]`);
const go = async (page: Page) => {
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed&server_profiles=multiple&chat=session#automation/schedules`);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const keep = async (page: Page) => { await form(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click();await expect(form(page)).toHaveCount(0); };
const resume = async (page: Page) => { await page.getByRole('region', { name: 'Unfinished scheduled prompts', exact: true }).getByRole('button', { name: 'Resume draft', exact: true }).click(); };
const chooseDays = async (page: Page, chosen: string[]) => {
  await field(page, 'Repeat').selectOption('selected_days');
  for (const name of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) await days(page).getByLabel(name, { exact: true }).setChecked(chosen.includes(name));
};

test('creates selected weekdays on a phone, rejects no days, and reopens the same timing after save', async ({ page }, info) => {
  await page.clock.setFixedTime(new Date(NOW));const f = await installPromptRecoveryFixture(page);
  try {
    await go(page);await page.setViewportSize({ width: 390, height: 900 });await page.getByRole('button', { name: 'Add schedule', exact: true }).click();await page.getByLabel('Schedule type', { exact: true }).selectOption('prompt');
    await field(page, 'Title').fill('Kestrel selected days');await field(page, 'Request to run').fill('Review the customer renewal.');await field(page, 'Run').selectOption('recurring');
    // An invalid inactive month date must not block a different cadence.
    await field(page, 'Repeat').selectOption('monthly');await field(page, 'Day of month').fill('32');await chooseDays(page, []);
    await expect(preview(page)).toContainText('Choose at least one weekday');await form(page).getByRole('button', { name: 'Create schedule', exact: true }).click();expect(f.creates).toEqual([]);
    await chooseDays(page, ['Tuesday', 'Thursday']);await field(page, 'Time').fill('09:15');await field(page, 'Recurring timezone').fill('America/New_York');
    await expect(preview(page).locator('time').nth(0)).toHaveAttribute('datetime', '2026-11-03T14:15:00.000Z');await expect(preview(page).locator('time').nth(1)).toHaveAttribute('datetime', '2026-11-05T14:15:00.000Z');
    await days(page).getByLabel('Thursday', { exact: true }).focus();await days(page).scrollIntoViewIfNeeded();await page.screenshot({ path: info.outputPath('selected-weekdays-phone.png'), fullPage: true, animations: 'disabled' });
    await form(page).getByRole('button', { name: 'Create schedule', exact: true }).click();await expect(form(page)).toHaveCount(0);const saved = (await f.latest())!;
    expect(f.creates).toHaveLength(1);expect(saved).toMatchObject({ cron_expression: '15 9 * * 2,4', time_zone: 'America/New_York' });expect(f.runs()).toBe(0);
    await expect(card(page, saved)).toContainText('Tuesday, Thursday');
    await card(page, saved).getByRole('button', { name: 'Edit', exact: true }).click();await expect(field(page, 'Repeat')).toHaveValue('selected_days');await expect(days(page).getByLabel('Tuesday', { exact: true })).toBeChecked();await expect(days(page).getByLabel('Thursday', { exact: true })).toBeChecked();await expect(days(page).getByLabel('Monday', { exact: true })).not.toBeChecked();
  } finally { f.dispose(); }
});

test('previews missing month dates and DST correctly and recovers the exact monthly edit after reload', async ({ page }, info) => {
  await page.clock.setFixedTime(new Date(NOW));const f = await installPromptRecoveryFixture(page), saved = await f.seed({ title: 'Kestrel monthly', cron_expression: '0 9 31 * *' });
  try {
    await go(page);await card(page, saved).getByRole('button', { name: 'Edit', exact: true }).click();await expect(field(page, 'Repeat')).toHaveValue('monthly');await expect(field(page, 'Day of month')).toHaveValue('31');await field(page, 'Time').fill('09:30');
    await expect(form(page)).toContainText('months without that date are skipped');const times = preview(page).locator('time');await expect(times.nth(0)).toHaveAttribute('datetime', '2026-10-31T13:30:00.000Z');await expect(times.nth(1)).toHaveAttribute('datetime', '2026-12-31T14:30:00.000Z');await expect(times.nth(2)).toHaveAttribute('datetime', '2027-01-31T14:30:00.000Z');await expect(times.nth(1)).toContainText('GMT-5');expect(f.updates).toEqual([]);
    await page.setViewportSize({ width: 390, height: 900 });await field(page, 'Day of month').focus();await field(page, 'Day of month').scrollIntoViewIfNeeded();await page.screenshot({ path: info.outputPath('monthly-prompt-phone.png'), fullPage: true, animations: 'disabled' });await keep(page);await page.reload();await page.waitForFunction(() => window.__app?.ready ===true);await resume(page);
    await expect(field(page, 'Repeat')).toHaveValue('monthly');await expect(field(page, 'Day of month')).toHaveValue('31');await expect(field(page, 'Time')).toHaveValue('09:30');await expect(field(page, 'Recurring timezone')).toHaveValue('America/New_York');
    await form(page).getByRole('button', { name: 'Save changes', exact: true }).click();await expect(form(page)).toHaveCount(0);expect(f.updates).toHaveLength(1);expect(f.updates[0]).toMatchObject({ schedule_id: saved.schedule_id, expected_revision: 1, cron_expression: '30 9 31 * *' });expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('duplicates an existing monthly schedule without changing its original expression or paused state', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));const f = await installPromptRecoveryFixture(page), saved = await f.seed({ title: 'Kestrel monthly copy', cron_expression: '05 08 03 * *', time_zone: 'Asia/Tokyo' });await f.pause(saved.schedule_id);const original = await f.get(saved.schedule_id);
  try {
    await go(page);await card(page, saved).getByRole('button', { name: 'Duplicate', exact: true }).click();await expect(field(page, 'Repeat')).toHaveValue('monthly');await expect(field(page, 'Day of month')).toHaveValue('3');await expect(field(page, 'Time')).toHaveValue('08:05');await expect(field(page, 'Recurring timezone')).toHaveValue('Asia/Tokyo');
    await form(page).getByRole('button', { name: 'Create schedule', exact: true }).click();await expect(form(page)).toHaveCount(0);const copy = (await f.latest())!;
    expect(copy).toMatchObject({ cron_expression: '05 08 03 * *', time_zone: 'Asia/Tokyo', enabled: true });expect(copy.schedule_id).not.toBe(saved.schedule_id);expect(await f.get(saved.schedule_id)).toEqual(original);expect(f.updates).toEqual([]);expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('finds a selected-weekday draft through universal search and restores all its checked days', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));const f = await installPromptRecoveryFixture(page), saved = await f.seed({ title: 'Kestrel recovery weekdays' });
  try {
    await go(page);await card(page, saved).getByRole('button', { name: 'Edit', exact: true }).click();await chooseDays(page, ['Tuesday', 'Thursday']);await keep(page);await page.reload();await page.waitForFunction(() => window.__app?.ready === true);
    await page.evaluate(() => window.__app.setHash('#data/search'));await page.getByRole('searchbox', { name: 'Search everything', exact: true }).fill('Kestrel Tuesday Thursday');await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('draft');const result = page.locator('[data-recovery-draft-key]');await expect(result).toHaveCount(1);await result.click();
    await expect(field(page, 'Repeat')).toHaveValue('selected_days');await expect(days(page).getByLabel('Tuesday', { exact: true })).toBeChecked();await expect(days(page).getByLabel('Thursday', { exact: true })).toBeChecked();await expect(days(page).getByLabel('Monday', { exact: true })).not.toBeChecked();
    await form(page).getByRole('button', { name: 'Save changes', exact: true }).click();await expect(form(page)).toHaveCount(0);expect(f.updates).toHaveLength(1);expect((await f.get(saved.schedule_id)).cron_expression).toBe('15 9 * * 2,4');expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('applies the complete saved monthly timing when resolving a conflicting selected-weekday draft', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));const f = await installPromptRecoveryFixture(page), saved = await f.seed({ title: 'Kestrel timing conflict', cron_expression: '15 9 * * *' });
  try {
    await go(page);await card(page, saved).getByRole('button', { name: 'Edit', exact: true }).click();await chooseDays(page, ['Tuesday', 'Thursday']);await field(page, 'Request to run').fill('Keep my revised request.');await keep(page);
    await f.update({ schedule_id: saved.schedule_id, expected_revision: 1, cron_expression: '20 11 31 * *', time_zone: 'Asia/Tokyo' });await resume(page);
    const comparison = form(page).getByRole('region', { name: 'Compare scheduled prompt edits', exact: true });await comparison.getByRole('combobox', { name: 'Timing and timezone: which version?', exact: true }).selectOption('saved');await comparison.getByRole('button', { name: 'Prepare draft', exact: true }).click();
    await expect(field(page, 'Repeat')).toHaveValue('monthly');await expect(field(page, 'Day of month')).toHaveValue('31');await expect(field(page, 'Time')).toHaveValue('11:20');await expect(field(page, 'Recurring timezone')).toHaveValue('Asia/Tokyo');await expect(field(page, 'Request to run')).toHaveValue('Keep my revised request.');
    await form(page).getByRole('button', { name: 'Save changes', exact: true }).click();await expect(form(page)).toHaveCount(0);expect(f.updates).toHaveLength(1);expect(f.updates[0]).toMatchObject({ expected_revision: 2, cron_expression: '20 11 31 * *', time_zone: 'Asia/Tokyo', prompt: 'Keep my revised request.' });expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('keeps a skipped occurrence when an edit changes only the title of an existing day list', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));const f = await installPromptRecoveryFixture(page), saved = await f.seed({ title: 'Kestrel retained skip', cron_expression: '15 09 * * 4,2' });
  await f.skip('skip_next', { schedule_id: saved.schedule_id, expected_revision: saved.revision, expected_skip_revision: 0, run_at: saved.next_run_at! });
  const before = await f.get(saved.schedule_id);
  try {
    await go(page);await card(page, saved).getByRole('button', { name: 'Edit', exact: true }).click();await expect(field(page, 'Repeat')).toHaveValue('selected_days');
    await field(page, 'Title').fill('Kestrel retained skip renamed');await form(page).getByRole('button', { name: 'Save changes', exact: true }).click();await expect(form(page)).toHaveCount(0);
    expect(f.updates).toHaveLength(1);expect(f.updates[0]?.cron_expression).toBe('15 09 * * 4,2');const after = await f.get(saved.schedule_id);
    expect(after.title).toBe('Kestrel retained skip renamed');expect(after.skip_state?.skipped?.run_at).toBe(before.skip_state?.skipped?.run_at);expect(after.skip_state?.skipped).toBeDefined();
    await expect(card(page, saved).getByRole('button', { name: 'Undo skip', exact: true })).toBeVisible();expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});
