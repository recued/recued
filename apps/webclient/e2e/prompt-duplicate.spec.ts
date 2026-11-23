import { expect, test, type Page } from '@playwright/test';
import type { PromptSchedule } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installPromptRecoveryFixture, PROMPT_RECOVERY_NOW as NOW } from './helpers/prompt-recovery-fixture.js';
import type { PromptDraftEntry } from '../src/automation/prompt-draft-recovery.js';

installFullAppHooks(); test.use({ timezoneId: 'America/New_York' });
const panel = (page: Page) => page.locator('[data-prompt-schedules]');
const form = (page: Page) => panel(page).locator('form');
const card = (page: Page, saved: PromptSchedule) => panel(page).locator(`[data-schedule-id="${saved.schedule_id}"]`);
const address = (saved: PromptSchedule) => '#automation/schedules/prompt/' + encodeURIComponent(saved.schedule_id);
const stored = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('recued.prompt-schedule.draft-recovery.v1:'))
  .flatMap(key => JSON.parse(sessionStorage.getItem(key)!) as PromptDraftEntry[]));
const go = async (page: Page, hash: string) => {
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed&server_profiles=multiple&chat=session${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const duplicate = async (page: Page, saved: PromptSchedule) => {
  const button = card(page, saved).getByRole('button', { name: 'Duplicate', exact: true });
  await button.focus(); await page.keyboard.press('Enter');
  await expect(form(page).getByLabel('Title', { exact: true })).toBeFocused();
};
const preview = (page: Page) => form(page).getByRole('region', { name: 'Schedule preview', exact: true });
const keep = async (page: Page) => {
  const button = form(page).getByRole('button', { name: 'Keep draft for later', exact: true });
  await button.focus(); await page.keyboard.press('Enter'); await expect(form(page)).toHaveCount(0);
};
const searchDraft = async (page: Page, query: string) => {
  await page.evaluate(() => window.__app.setHash('#data/search'));
  await page.getByRole('searchbox', { name: 'Search everything', exact: true }).fill(query);
  await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('draft');
  const result = page.locator('[data-recovery-draft-key]'); await expect(result).toHaveCount(1);
  await result.focus(); await page.keyboard.press('Enter');
};

test('duplicates a paused prompt from its exact details into an independent schedule with reviewed settings', async ({ page }, info) => {
  await page.clock.setFixedTime(new Date(NOW)); const f = await installPromptRecoveryFixture(page);
  try {
    const saved = await f.seed({ title: 'Café <renewal>', prompt: 'Review Café 😀\nKeep the customer context.',
      cron_expression: '5,35 8-17 * * 1-5', time_zone: 'Europe/Paris', model_source_id: 'slot_2', notify_on_done: true });
    await f.pause(saved.schedule_id); const original = await f.get(saved.schedule_id);
    f.overlay(saved.schedule_id, { last_run_at: NOW - 3600000, last_turn_id: 'source-turn', last_status: 'failed',
      last_outcome: { status: 'failed', reason: 'turn_failed', message_id: 'source-answer' } });
    await go(page, address(saved)); await page.setViewportSize({ width: 390, height: 900 }); await duplicate(page, saved);
    await expect(page.getByRole('heading', { name: 'Duplicate scheduled prompt', exact: true })).toBeVisible();
    await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue('Café <renewal> (copy)');
    await expect(form(page).getByLabel('Request to run', { exact: true })).toHaveValue(saved.prompt);
    await expect(form(page).getByLabel('Run', { exact: true })).toBeEnabled();
    await expect(form(page).getByLabel('Repeat', { exact: true })).toHaveValue('custom');
    await expect(form(page).getByLabel('Custom schedule (cron)', { exact: true })).toHaveValue('5,35 8-17 * * 1-5');
    await expect(form(page).getByLabel('Recurring timezone', { exact: true })).toHaveValue('Europe/Paris');
    await expect(form(page).getByLabel('Model', { exact: true })).toHaveValue('slot_2');
    await expect(form(page).getByLabel('Notify me when it’s done', { exact: true })).toBeChecked();
    await expect(preview(page)).toContainText('Next runs · Europe/Paris');
    expect(f.creates).toEqual([]); expect(f.updates).toEqual([]); expect(f.scheduleCount()).toBe(1);
    await form(page).getByLabel('Title', { exact: true }).fill('Café follow-up');
    await form(page).getByLabel('Request to run', { exact: true }).fill('Prepare the Café follow-up for the new project.');
    await page.screenshot({ path: info.outputPath('duplicate-prompt-phone.png'), fullPage: true, animations: 'disabled' });
    const draft = (await stored(page))[0]!; expect(draft.original).toBeNull(); expect(draft.values.request).toBeNull();
    await form(page).getByRole('button', { name: 'Create schedule', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    const copy = (await f.latest())!;
    await expect(page).toHaveURL(new RegExp(address(copy) + '$'));
    await expect(card(page, copy).getByRole('heading', { name: 'Café follow-up', exact: true })).toBeVisible();
    expect(copy.schedule_id).not.toBe(saved.schedule_id); expect(copy.session_id).not.toBe(saved.session_id);
    expect(copy).toMatchObject({ revision: 1, enabled: true, title: 'Café follow-up', prompt: 'Prepare the Café follow-up for the new project.',
      mode: 'recurring', cron_expression: '5,35 8-17 * * 1-5', time_zone: 'Europe/Paris', model_source_id: 'slot_2', notify_on_done: true,
      last_run_at: null, last_turn_id: null, last_status: null });
    expect(f.creates).toEqual([{ creation_id: draft.values.creationId, title: copy.title, prompt: copy.prompt,
      mode: 'recurring', cron_expression: copy.cron_expression, time_zone: copy.time_zone, model_source_id: 'slot_2', notify_on_done: true }]);
    expect(await f.get(saved.schedule_id)).toEqual(original); expect(f.updates).toEqual([]);
    expect(f.scheduleCount()).toBe(2); expect(f.conversationCount()).toBe(2); expect(f.runs()).toBe(0); expect(await stored(page)).toEqual([]);
  } finally { f.dispose(); }
});

test('copies a finished one-off without its old instant and requires a new future time in its original timezone', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW)); const f = await installPromptRecoveryFixture(page);
  try {
    const saved = await f.seed({ title: 'One-off renewal', mode: 'one_shot', cron_expression: undefined,
      run_at: '2026-11-01T09:30:42.123Z', time_zone: 'America/Los_Angeles' });
    await f.pause(saved.schedule_id); const original = await f.get(saved.schedule_id);
    const later = Date.parse('2026-11-02T12:00:00Z'); f.setNow(later); await page.clock.setFixedTime(new Date(later));
    await go(page, '#automation/schedules'); await duplicate(page, saved);
    const time = form(page).getByLabel('Date and time (America/Los_Angeles)', { exact: true });
    await expect(form(page).getByLabel('Run', { exact: true })).toHaveValue('one_shot'); await expect(time).toHaveValue('');
    await expect(form(page)).toContainText('choose a new date and time');
    await form(page).getByRole('button', { name: 'Create schedule', exact: true }).click();
    expect(await time.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true); expect(f.creates).toEqual([]);
    await time.fill('2026-10-30T09:45'); await expect(preview(page)).toContainText('future');
    await form(page).getByRole('button', { name: 'Create schedule', exact: true }).click(); await expect(form(page).getByRole('alert')).toContainText('future');
    expect(f.scheduleCount()).toBe(1); expect(f.conversationCount()).toBe(1);
    await time.fill('2026-11-03T09:45'); await expect(preview(page)).toContainText('Runs once · America/Los_Angeles');
    await form(page).getByRole('button', { name: 'Create schedule', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect(await f.latest()).toMatchObject({ mode: 'one_shot', run_at: Date.parse('2026-11-03T17:45:00Z'), time_zone: 'America/Los_Angeles', enabled: true });
    expect(await f.get(saved.schedule_id)).toEqual(original); expect(f.updates).toEqual([]);
    expect(f.scheduleCount()).toBe(2); expect(f.conversationCount()).toBe(2); expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('recovers an untouched copy through Search Drafts after reload and removal of its source', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW)); const f = await installPromptRecoveryFixture(page);
  try {
    const saved = await f.seed({ title: 'Kestrel briefing', model_source_id: 'slot_1', notify_on_done: true });
    await go(page, address(saved)); await duplicate(page, saved);
    const draft = (await stored(page))[0]!;
    expect(draft).toMatchObject({ original: null, status: 'editing', values: { title: 'Kestrel briefing (copy)', request: null, chosenAt: null } });
    expect(draft.values).not.toHaveProperty('updateRequest');
    await f.remove(saved.schedule_id); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await searchDraft(page, 'Kestrel briefing'); expect(new URL(page.url()).hash).toBe('#automation/schedules');
    await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue('Kestrel briefing (copy)');
    await expect(form(page).getByLabel('Request to run', { exact: true })).toHaveValue(saved.prompt);
    await expect(form(page).getByLabel('Repeat', { exact: true })).toHaveValue('weekdays');
    await expect(form(page).getByLabel('Time', { exact: true })).toHaveValue('09:15');
    await expect(form(page).getByLabel('Recurring timezone', { exact: true })).toHaveValue('America/New_York');
    await expect(form(page).getByLabel('Model', { exact: true })).toHaveValue('slot_1');
    await expect(form(page).getByLabel('Notify me when it’s done', { exact: true })).toBeChecked();
    await expect(preview(page)).toContainText('Next runs'); expect(f.creates).toEqual([]);
    await form(page).getByRole('button', { name: 'Create schedule', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect(f.creates).toHaveLength(1); expect(f.creates[0]!.creation_id).toBe(draft.values.creationId);
    expect(f.updates).toEqual([]); expect(f.scheduleCount()).toBe(1); expect(f.conversationCount()).toBe(2); expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('keeps a copy beside its source details and checks a lost creation reply with the same new request after reload', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW)); const f = await installPromptRecoveryFixture(page);
  try {
    const saved = await f.seed({ title: 'Weekly Kestrel', cron_expression: '20 10 * * 2' });
    await go(page, address(saved)); await duplicate(page, saved);
    await expect(form(page).getByLabel('Repeat', { exact: true })).toHaveValue('weekly');
    await expect(form(page).getByLabel('Day of week', { exact: true })).toHaveValue('2');
    await expect(form(page).getByLabel('Time', { exact: true })).toHaveValue('10:20'); await keep(page);
    const recovery = panel(page).getByRole('region', { name: 'Unfinished scheduled prompts', exact: true });
    await expect(recovery.getByRole('button', { name: 'Resume draft', exact: true })).toBeFocused();
    await recovery.getByRole('button', { name: 'Resume draft', exact: true }).click(); await expect(preview(page)).toContainText('Next runs');
    f.loseNextCreate(); await form(page).getByRole('button', { name: 'Create schedule', exact: true }).click();
    await expect(form(page).getByRole('button', { name: 'Check save', exact: true })).toBeEnabled();
    const request = f.creates[0]!; expect((await stored(page))[0]!.status).toBe('unknown'); await keep(page);
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); await searchDraft(page, 'Weekly Kestrel');
    await expect(form(page).getByLabel('Request to run', { exact: true })).toBeDisabled();
    await form(page).getByRole('button', { name: 'Check save', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect(f.creates).toEqual([request, request]); expect(f.scheduleCount()).toBe(2); expect(f.conversationCount()).toBe(2);
    expect(await f.get(saved.schedule_id)).toMatchObject({ revision: 1, title: saved.title });
    expect(f.updates).toEqual([]); expect(f.runs()).toBe(0); expect(await stored(page)).toEqual([]);
  } finally { f.dispose(); }
});

test('Chat cancels only its copy, starts another with a fresh ID and changes its cadence without sending the composer', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW)); const f = await installPromptRecoveryFixture(page);
  try {
    const saved = await f.seed({ title: 'K'.repeat(152) + '😀' + 'Z'.repeat(6), cron_expression: '45 8 * * *' });
    await go(page, '#chat/session/' + saved.session_id);
    const composer = page.locator('[data-recued-chat-route-input]'); await composer.fill('Keep my current chat draft.');
    await panel(page).locator('[data-prompt-schedule-compact] > summary').click(); await duplicate(page, saved);
    await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue('K'.repeat(152) + ' (copy)');
    const cancelled = (await stored(page))[0]!.values.creationId;
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(form(page)).toHaveCount(0); await expect(card(page, saved).getByRole('button', { name: 'Duplicate', exact: true })).toBeFocused();
    expect(await stored(page)).toEqual([]); expect(await f.get(saved.schedule_id)).toMatchObject({ revision: 1, enabled: true });
    await duplicate(page, saved); const next = (await stored(page))[0]!.values.creationId; expect(next).not.toBe(cancelled);
    await expect(form(page).getByLabel('Repeat', { exact: true })).toHaveValue('daily');
    await expect(form(page).getByLabel('Time', { exact: true })).toHaveValue('08:45');
    await form(page).getByLabel('Run', { exact: true }).selectOption('one_shot');
    await expect(form(page).getByLabel('Date and time (America/New_York)', { exact: true })).toHaveValue('');
    await form(page).getByLabel('Date and time (America/New_York)', { exact: true }).fill('2026-11-03T10:00');
    await expect(preview(page)).toContainText('Runs once'); await form(page).getByRole('button', { name: 'Create schedule', exact: true }).click();
    await expect(form(page)).toHaveCount(0); const copy = (await f.latest())!;
    await expect(panel(page).getByRole('link', { name: 'Open scheduled conversation', exact: true })).toHaveAttribute('href', '#chat/session/' + copy.session_id);
    await expect(composer).toHaveValue('Keep my current chat draft.');
    expect(copy.session_id).not.toBe(saved.session_id); expect(f.creates).toHaveLength(1); expect(f.creates[0]!.creation_id).toBe(next);
    expect(f.updates).toEqual([]); expect(f.scheduleCount()).toBe(2); expect(f.conversationCount()).toBe(2); expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});
