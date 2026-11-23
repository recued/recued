import { expect, test, type Page } from '@playwright/test';
import type { PromptSchedule } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installPromptRecoveryFixture, PROMPT_RECOVERY_NOW as NOW } from './helpers/prompt-recovery-fixture.js';
import type { PromptDraftEntry } from '../src/automation/prompt-draft-recovery.js';

installFullAppHooks(); test.use({ timezoneId: 'America/New_York' });
const panel = (page: Page) => page.locator('[data-prompt-schedules]');
const form = (page: Page) => panel(page).locator('form');
const recovery = (page: Page) => panel(page).getByRole('region', { name: 'Unfinished scheduled prompts', exact: true });
const comparison = (page: Page) => form(page).getByRole('region', { name: 'Compare scheduled prompt edits', exact: true });
const card = (page: Page, saved: PromptSchedule) => panel(page).locator(`[data-schedule-id="${saved.schedule_id}"]`);
const address = (saved: PromptSchedule) => '#automation/schedules/prompt/' + encodeURIComponent(saved.schedule_id);
const stored = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('recued.prompt-schedule.draft-recovery.v1:'))
  .flatMap(key => JSON.parse(sessionStorage.getItem(key)!) as PromptDraftEntry[]));
const hash = (page: Page, value: string) => page.evaluate(value => window.__app.setHash(value), value);
const boot = async (page: Page, once = false) => {
  await page.clock.setFixedTime(new Date(NOW)); const f = await installPromptRecoveryFixture(page);
  const saved = await f.seed(once ? { mode: 'one_shot', cron_expression: undefined, run_at: '2026-11-01T06:30:42.123Z' } : {});
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed&server_profiles=multiple&chat=session${address(saved)}`);
  await page.waitForFunction(() => window.__app?.ready === true); await card(page, saved).getByRole('button', { name: 'Edit', exact: true }).click();
  return { f, saved };
};
const keep = async (page: Page) => { await form(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click(); await expect(form(page)).toHaveCount(0); };
const resume = async (page: Page) => { await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click(); };
const refresh = async (page: Page) => { await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); };
const ready = (page: Page) => expect(form(page).getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
const pending = (page: Page) => expect(form(page).getByRole('button', { name: 'Check save', exact: true })).toBeEnabled();

test('keeps raw edited input through immediate refresh and saves only the original schedule from a phone', async ({ page }, info) => {
  const { f, saved } = await boot(page);
  try {
    await page.setViewportSize({ width: 390, height: 900 }); const request = '\n  Review Café 😀\n<img src=x> & preserve these exact details.  ';
    await form(page).getByLabel('Title', { exact: true }).fill('Kestrel revised briefing');
    await form(page).getByLabel('Request to run', { exact: true }).fill(request);
    await form(page).getByLabel('Repeat', { exact: true }).selectOption('custom');
    await form(page).getByLabel('Custom schedule (cron)', { exact: true }).fill('  30   10 * * 1-5  ');
    await form(page).getByLabel('Recurring timezone', { exact: true }).fill('Europe/Paris');
    await expect(form(page).getByLabel('Model', { exact: true })).toBeVisible(); await form(page).getByLabel('Model', { exact: true }).selectOption('slot_2');
    await form(page).getByLabel('Notify me when it’s done', { exact: true }).check(); await refresh(page);
    expect((await stored(page))[0]?.original).toMatchObject({ schedule_id: saved.schedule_id, revision: saved.revision });
    await resume(page); await ready(page); await expect(form(page).getByLabel('Request to run', { exact: true })).toHaveValue(request);
    await expect(form(page).getByLabel('Custom schedule (cron)', { exact: true })).toHaveValue('  30   10 * * 1-5  ');
    await expect(form(page).getByLabel('Model', { exact: true })).toHaveValue('slot_2'); await expect(form(page).getByLabel('Notify me when it’s done', { exact: true })).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ fullPage: true, animations: 'disabled', path: info.outputPath('kept-prompt-edits-phone.png') });
    await form(page).getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect(f.updates).toEqual([{ schedule_id: saved.schedule_id, expected_revision: saved.revision, title: 'Kestrel revised briefing', prompt: request.trim(),
      time_zone: 'Europe/Paris', cron_expression: '30 10 * * 1-5', model_source_id: 'slot_2', notify_on_done: true }]);
    expect(await f.get(saved.schedule_id)).toMatchObject({ revision: 2, enabled: true, prompt: request.trim() });
    expect(await stored(page)).toEqual([]); expect(f.creates).toEqual([]); expect(f.scheduleCount()).toBe(1); expect(f.conversationCount()).toBe(1); expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('Search Drafts opens the exact saved edit and returns to its query, type and focused recovery result', async ({ page }) => {
  const { f, saved } = await boot(page);
  try {
    await form(page).getByLabel('Request to run', { exact: true }).fill('Keep the Kestrel customer follow-up context.'); await keep(page);
    await hash(page, '#data/search'); const search = page.getByRole('searchbox', { name: 'Search everything', exact: true }); await search.fill('Kestrel customer');
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('draft');
    const result = page.locator('[data-recovery-draft-key]'); await expect(result).toHaveCount(1); await result.focus(); await page.keyboard.press('Enter');
    await ready(page); expect(new URL(page.url()).hash).toBe(address(saved)); await expect(form(page).getByLabel('Request to run', { exact: true })).toHaveValue('Keep the Kestrel customer follow-up context.');
    await page.getByRole('button', { name: 'Back to search', exact: true }).click(); await expect(form(page).getByRole('alert')).toContainText('Save, keep for later, or cancel');
    await keep(page); await page.getByRole('button', { name: 'Back to search', exact: true }).click();
    await expect(search).toHaveValue('Kestrel customer'); await expect(page.getByRole('combobox', { name: 'Result type', exact: true })).toHaveValue('draft');
    await expect(result).toBeFocused(); expect(f.updates).toEqual([]); expect(f.creates).toEqual([]);
    await result.click(); await ready(page); await form(page).getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to search', exact: true }).click(); await expect(result).toHaveCount(0); await expect(search).toBeFocused();
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('all');
    await expect(page.locator(`[data-search-prompt-id="${saved.schedule_id}"]`)).toContainText('Keep the Kestrel customer follow-up context.'); expect(f.updates).toHaveLength(1);
  } finally { f.dispose(); }
});

test('combines disjoint saved changes with kept edits and preserves a pause made elsewhere', async ({ page }) => {
  const { f, saved } = await boot(page);
  try {
    await form(page).getByLabel('Request to run', { exact: true }).fill('My revised Kestrel request.'); await keep(page);
    await f.update({ schedule_id: saved.schedule_id, expected_revision: 1, title: 'Renamed elsewhere', cron_expression: '20 11 * * 1-5', time_zone: 'Europe/Paris', model_source_id: 'slot_1', notify_on_done: true }); await f.pause(saved.schedule_id);
    await resume(page); await expect(comparison(page)).toBeVisible(); await expect(comparison(page)).toContainText('paused');
    await comparison(page).getByRole('button', { name: 'Prepare draft', exact: true }).click(); await ready(page);
    await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue('Renamed elsewhere');
    await expect(form(page).getByLabel('Request to run', { exact: true })).toHaveValue('My revised Kestrel request.');
    await expect(form(page).getByLabel('Time', { exact: true })).toHaveValue('11:20'); await expect(form(page).getByLabel('Recurring timezone', { exact: true })).toHaveValue('Europe/Paris');
    await expect(form(page).getByLabel('Model', { exact: true })).toHaveValue('slot_1'); expect(f.updates).toEqual([]);
    await form(page).getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect(f.updates[0]).toMatchObject({ expected_revision: 3, title: 'Renamed elsewhere', prompt: 'My revised Kestrel request.', cron_expression: '20 11 * * 1-5', time_zone: 'Europe/Paris', model_source_id: 'slot_1' });
    expect(await f.get(saved.schedule_id)).toMatchObject({ enabled: false, revision: 4 }); expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('requires conflict choices and rechecks the comparison before preparing against a newer revision', async ({ page }) => {
  const { f, saved } = await boot(page);
  try {
    await form(page).getByLabel('Request to run', { exact: true }).fill('My conflicting request.'); await form(page).getByLabel('Time', { exact: true }).fill('10:30'); await keep(page);
    await f.update({ schedule_id: saved.schedule_id, expected_revision: 1, prompt: 'Saved conflicting request.', cron_expression: '20 11 * * 1-5', time_zone: 'Europe/Paris' });
    await resume(page); const prepare = comparison(page).getByRole('button', { name: 'Prepare draft', exact: true }); await expect(prepare).toBeDisabled();
    await comparison(page).getByRole('combobox', { name: 'Request: which version?', exact: true }).selectOption('mine');
    await comparison(page).getByRole('combobox', { name: 'Timing and timezone: which version?', exact: true }).selectOption('saved'); await expect(prepare).toBeEnabled();
    await f.update({ schedule_id: saved.schedule_id, expected_revision: 2, title: 'Changed again before Prepare' }); await prepare.focus(); await page.keyboard.press('Enter');
    await expect(comparison(page)).toContainText('Changed again before Prepare'); await expect(prepare).toBeDisabled(); expect(f.updates).toEqual([]);
    await expect(comparison(page).getByRole('heading', { name: 'Compare scheduled prompt edits', exact: true })).toBeFocused();
    await comparison(page).getByRole('combobox', { name: 'Request: which version?', exact: true }).selectOption('mine');
    await comparison(page).getByRole('combobox', { name: 'Timing and timezone: which version?', exact: true }).selectOption('saved'); await prepare.focus(); await page.keyboard.press('Enter'); await ready(page);
    await expect(form(page).getByLabel('Title', { exact: true })).toBeFocused(); await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue('Changed again before Prepare');
    await expect(form(page).getByLabel('Request to run', { exact: true })).toHaveValue('My conflicting request.');
    await expect(form(page).getByLabel('Time', { exact: true })).toHaveValue('11:20'); await expect(form(page).getByLabel('Recurring timezone', { exact: true })).toHaveValue('Europe/Paris');
    await keep(page); expect((await stored(page))[0]?.original?.revision).toBe(3); expect(f.updates).toEqual([]);
  } finally { f.dispose(); }
});

test('checks an applied update whose reply was lost without sending the update again', async ({ page }) => {
  const { f, saved } = await boot(page);
  try {
    await form(page).getByLabel('Request to run', { exact: true }).fill('Applied once despite lost reply.'); f.nextUpdate('lost');
    await form(page).getByRole('button', { name: 'Save changes', exact: true }).click(); await pending(page);
    await expect(form(page).getByLabel('Request to run', { exact: true })).toBeDisabled();
    expect((await stored(page))[0]).toMatchObject({ status: 'unknown', values: { updateRequest: f.updates[0] } }); await keep(page); await refresh(page); await resume(page); await pending(page);
    await form(page).getByRole('button', { name: 'Check save', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect(f.updates).toHaveLength(1); expect(await stored(page)).toEqual([]); expect(await f.get(saved.schedule_id)).toMatchObject({ revision: 2, prompt: 'Applied once despite lost reply.' }); expect(f.creates).toEqual([]);
  } finally { f.dispose(); }
});

test('checks an unapplied timeout first and retries only the exact original update and revision', async ({ page }) => {
  const { f, saved } = await boot(page);
  try {
    await form(page).getByLabel('Request to run', { exact: true }).fill('Retry this original request.'); f.nextUpdate('not-applied');
    await form(page).getByRole('button', { name: 'Save changes', exact: true }).click(); await pending(page); await keep(page); await resume(page); await pending(page);
    await expect(form(page).getByRole('button', { name: 'Retry original save', exact: true })).toBeEnabled();
    await form(page).getByRole('button', { name: 'Check save', exact: true }).click(); await pending(page); expect(f.updates).toHaveLength(1);
    await form(page).getByRole('button', { name: 'Retry original save', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect(f.updates).toHaveLength(2); expect(f.updates[1]).toEqual(f.updates[0]); expect(f.updates[0]).not.toHaveProperty('creation_id'); expect(await f.get(saved.schedule_id)).toMatchObject({ revision: 2 });
  } finally { f.dispose(); }
});

test('persists before a held update and fences its late dispatch after a same-request retry wins', async ({ page }) => {
  const { f, saved } = await boot(page);
  try {
    await form(page).getByLabel('Request to run', { exact: true }).fill('Held original request.'); f.nextUpdate('hold-before');
    await form(page).getByRole('button', { name: 'Save changes', exact: true }).click(); await expect.poll(f.updatePending).toBe(true);
    expect((await stored(page))[0]).toMatchObject({ status: 'pending', values: { updateRequest: f.updates[0] } });
    await expect(form(page).getByRole('button', { name: 'Keep draft for later', exact: true })).toBeDisabled();
    await refresh(page); await resume(page); await expect(form(page).getByRole('button', { name: 'Retry original save', exact: true })).toBeEnabled();
    await form(page).getByRole('button', { name: 'Retry original save', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    f.releaseUpdate(); await expect.poll(f.completedUpdates).toBe(2); expect(await f.get(saved.schedule_id)).toMatchObject({ revision: 2, prompt: 'Held original request.' });
    expect(f.updates[1]).toEqual(f.updates[0]); expect(await stored(page)).toEqual([]); expect(f.scheduleCount()).toBe(1); expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('compares an interrupted update against later changes instead of declaring it saved or replaying it', async ({ page }) => {
  const { f, saved } = await boot(page);
  try {
    await form(page).getByLabel('Request to run', { exact: true }).fill('Original attempted edit.'); f.nextUpdate('lost');
    await form(page).getByRole('button', { name: 'Save changes', exact: true }).click(); await pending(page); await keep(page);
    await f.update({ schedule_id: saved.schedule_id, expected_revision: 2, prompt: 'A later saved request.' }); await resume(page);
    await expect(comparison(page)).toContainText('A later saved request.'); await expect(form(page).getByRole('button', { name: 'Retry original save', exact: true })).toHaveCount(0);
    await form(page).getByRole('button', { name: 'Check save', exact: true }).click(); await expect(comparison(page)).toBeVisible(); expect(f.updates).toHaveLength(1);
    await comparison(page).getByRole('combobox', { name: 'Request: which version?', exact: true }).selectOption('saved'); await comparison(page).getByRole('button', { name: 'Prepare draft', exact: true }).click(); await ready(page);
    await expect(form(page).getByLabel('Request to run', { exact: true })).toHaveValue('A later saved request.');
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(form(page)).toHaveCount(0); expect(await stored(page)).toEqual([]); expect(f.updates).toHaveLength(1);
  } finally { f.dispose(); }
});

test('a removed original cannot update a replacement, and discarding local edits leaves the other schedule unchanged', async ({ page }) => {
  const { f, saved } = await boot(page);
  try {
    await form(page).getByLabel('Request to run', { exact: true }).fill('Local edits for the removed schedule.'); await keep(page); await f.remove(saved.schedule_id);
    const other = await f.seed({ title: saved.title }); await resume(page);
    await expect(form(page).getByRole('alert')).toContainText('no longer exists'); await expect(form(page).getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled(); await keep(page);
    await recovery(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
    const confirm = recovery(page).getByRole('group', { name: 'Discard scheduled prompt draft?', exact: true }); await expect(confirm).toContainText('does not change, pause or remove');
    await confirm.getByRole('button', { name: 'Discard recovery copy', exact: true }).click(); expect(await stored(page)).toEqual([]);
    expect(await f.get(other.schedule_id)).toMatchObject({ enabled: true, revision: 1 }); expect(f.updates).toEqual([]); expect(f.creates).toEqual([]);
  } finally { f.dispose(); }
});

test('a failed current read keeps edits and a late check cannot reopen or take focus from a kept copy', async ({ page }) => {
  const { f } = await boot(page);
  try {
    await form(page).getByLabel('Request to run', { exact: true }).fill('Keep edits during a failed current read.'); await keep(page); f.failNextList(); await resume(page);
    await expect(form(page).getByRole('alert')).toContainText('interrupted'); await expect(form(page).getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    f.holdNextList(); await form(page).getByRole('button', { name: 'Recheck saved prompt', exact: true }).click(); await expect.poll(f.listPending).toBe(true);
    await keep(page); const resumeButton = recovery(page).getByRole('button', { name: 'Resume draft', exact: true }); await expect(resumeButton).toBeFocused(); f.releaseList();
    await expect(form(page)).toHaveCount(0); await expect(resumeButton).toBeFocused(); await resumeButton.click(); await ready(page); expect(f.updates).toEqual([]);
  } finally { f.dispose(); }
});

test('storage failure blocks Keep, dispatch and discard until the latest edits can be confirmed', async ({ page }) => {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('recued.prompt-schedule.draft-recovery.v1:') && document.documentElement.dataset.blockPromptWrite) throw Error('quota'); return set.call(this, key, value); };
    Storage.prototype.removeItem = function(key) { if (key.startsWith('recued.prompt-schedule.draft-recovery.v1:') && document.documentElement.dataset.blockPromptWrite) throw Error('quota'); return remove.call(this, key); };
  });
  const { f } = await boot(page);
  try {
    await form(page).getByLabel('Request to run', { exact: true }).fill('First kept version.'); await keep(page); await resume(page); await ready(page);
    await page.evaluate(() => { document.documentElement.dataset.blockPromptWrite = '1'; });
    await form(page).getByLabel('Request to run', { exact: true }).fill('Latest input must be preserved.'); await form(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click();
    await expect(form(page).getByRole('alert')).toContainText('could not be confirmed');
    await form(page).getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(form(page).getByRole('alert')).toContainText('save could not start'); expect(f.updates).toEqual([]);
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(form(page).getByRole('alert')).toContainText('could not be discarded');
    await page.evaluate(() => { delete document.documentElement.dataset.blockPromptWrite; }); await keep(page); expect((await stored(page))[0]?.values.prompt).toBe('Latest input must be preserved.');
  } finally { f.dispose(); }
});

test('keeps an exact repeated-hour instant through edit recovery and preserves a definite refusal as editable input', async ({ page }) => {
  const { f, saved } = await boot(page, true);
  try {
    await form(page).getByLabel('Title', { exact: true }).fill('One-off revised title'); await keep(page); await refresh(page); await resume(page); await ready(page);
    expect((await stored(page))[0]?.values.chosenAt).toBe(Date.parse('2026-11-01T06:30:42.123Z'));
    f.nextUpdate('refuse'); await form(page).getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(form(page).getByRole('alert')).toContainText('refused before saving');
    await expect(form(page).getByLabel('Title', { exact: true })).toBeEnabled(); expect((await stored(page))[0]).toMatchObject({ status: 'editing' });
    await form(page).getByRole('button', { name: 'Recheck saved prompt', exact: true }).click(); await ready(page);
    await form(page).getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect(f.updates[1]).toMatchObject({ schedule_id: saved.schedule_id, expected_revision: 1, run_at: '2026-11-01T06:30:42.123Z' }); expect(f.updates).toHaveLength(2); expect(f.creates).toEqual([]);
  } finally { f.dispose(); }
});

test('requires explicit defaults when the current server cannot confirm kept model or notification settings', async ({ page }) => {
  const { f } = await boot(page);
  try {
    await expect(form(page).getByLabel('Model', { exact: true })).toBeVisible(); await form(page).getByLabel('Model', { exact: true }).selectOption('slot_2');
    await form(page).getByLabel('Notify me when it’s done', { exact: true }).check(); await keep(page);
    f.previewUnsupported(true); await refresh(page); await resume(page); await ready(page);
    await expect(form(page).getByRole('status').filter({ hasText: 'has not confirmed support' })).toHaveCount(0);
    f.nextUpdate('refuse'); await form(page).getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(form(page).getByRole('alert')).toContainText('refused before saving');
    expect(f.updates[0]).toMatchObject({ model_source_id: 'slot_2', notify_on_done: true }); await keep(page);
    f.capabilities('old'); await refresh(page); await resume(page);
    await ready(page); await expect(form(page).getByLabel('Model', { exact: true })).toHaveValue('slot_2');
    await expect(form(page).getByLabel('Notify me when it’s done', { exact: true })).toBeChecked();
    await form(page).getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(form(page).getByRole('alert')).toContainText('has not confirmed support'); expect(f.updates).toHaveLength(1);
    await form(page).getByLabel('Model', { exact: true }).selectOption(''); await form(page).getByLabel('Notify me when it’s done', { exact: true }).uncheck();
    await form(page).getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    expect(f.updates[1]).not.toHaveProperty('model_source_id'); expect(f.updates[1]).not.toHaveProperty('notify_on_done');
  } finally { f.dispose(); }
});
