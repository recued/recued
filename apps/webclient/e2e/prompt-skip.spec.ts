import { expect, test, type Page } from '@playwright/test';
import type { PromptSchedule } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installPromptRecoveryFixture, PROMPT_RECOVERY_NOW as NOW } from './helpers/prompt-recovery-fixture.js';

installFullAppHooks(); test.use({ timezoneId: 'America/New_York' });
const panel = (page: Page) => page.locator('[data-prompt-schedules]');
const card = (page: Page, row: PromptSchedule) => panel(page).locator(`[data-schedule-id="${row.schedule_id}"]`);
const confirmation = (page: Page) => panel(page).getByRole('region', { name: 'Skip next scheduled run', exact: true });
const go = async (page: Page, hash: string) => {
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed&server_profiles=multiple&chat=session${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const open = async (page: Page, row: PromptSchedule) => {
  await card(page, row).getByRole('button', { name: 'Skip next run', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(confirmation(page).getByRole('button', { name: 'Keep next run', exact: true })).toBeFocused();
};
const confirm = async (page: Page) => {
  const button = confirmation(page).getByRole('button', { name: 'Skip this run', exact: true }); await expect(button).toBeEnabled();
  await button.focus(); await page.keyboard.press('Enter');
};
const refresh = async (page: Page) => { await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); };
const setup = async (page: Page) => {
  await page.clock.setFixedTime(new Date(NOW)); const f = await installPromptRecoveryFixture(page);
  const saved = await f.seed({ title: 'Kestrel briefing', cron_expression: '*/5 * * * *' }); return { f, saved };
};
const address = (row: PromptSchedule) => '#automation/schedules/prompt/' + row.schedule_id;
const pending = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('recued:prompt-skip:')).map(key => JSON.parse(sessionStorage.getItem(key)!)));

test('reviews the exact skipped and following times, keeps or skips by keyboard, and restores the original run from its details', async ({ page }, info) => {
  const { f, saved } = await setup(page);
  try {
    await go(page, '#automation/schedules'); await page.setViewportSize({ width: 390, height: 900 }); await open(page, saved);
    await expect(confirmation(page)).toContainText(/Skip: Oct 31, 2026(?:,| at) 8:05 AM GMT-4/);
    await expect(confirmation(page)).toContainText(/Following run: Oct 31, 2026(?:,| at) 8:10 AM GMT-4/);
    expect(f.skipChanges).toEqual([]); expect((await f.get(saved.schedule_id)).next_run_at).toBe(saved.next_run_at);
    await page.screenshot({ path: info.outputPath('skip-next-run-phone.png'), fullPage: true, animations: 'disabled' });
    await confirmation(page).getByRole('button', { name: 'Keep next run', exact: true }).press('Enter');
    await expect(card(page, saved).getByRole('button', { name: 'Skip next run', exact: true })).toBeFocused(); expect(f.skipChanges).toEqual([]);
    await open(page, saved); await confirm(page);
    await expect(card(page, saved).getByRole('button', { name: 'Undo skip', exact: true })).toBeEnabled();
    await expect(card(page, saved)).toContainText(/Skipped run: Oct 31, 2026(?:,| at) 8:05 AM GMT-4/);
    const skipped = await f.get(saved.schedule_id);
    expect(skipped).toMatchObject({ enabled: true, revision: 1, cron_expression: '*/5 * * * *', time_zone: 'America/New_York', next_run_at: NOW + 600000 });
    await page.evaluate(hash => window.__app.setHash(hash), address(saved));
    await card(page, saved).getByRole('button', { name: 'Undo skip', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(card(page, saved).getByRole('button', { name: 'Skip next run', exact: true })).toBeEnabled();
    expect(await f.get(saved.schedule_id)).toMatchObject({ enabled: true, revision: 1, next_run_at: saved.next_run_at, skip_state: { revision: 2 } });
    expect(f.skipChanges.map(change => change.action)).toEqual(['skip_next', 'undo_skip']);
    expect(f.creates).toEqual([]); expect(f.updates).toEqual([]); expect(f.scheduleCount()).toBe(1); expect(f.conversationCount()).toBe(1); expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('keeps preview errors read-only and refuses a stale confirmation instead of skipping its new target', async ({ page }) => {
  const { f, saved } = await setup(page);
  try {
    await go(page, address(saved)); f.nextSkipPreview('fail'); await open(page, saved);
    await expect(confirmation(page).getByRole('alert')).toContainText('temporarily unavailable');
    await expect(confirmation(page).getByRole('button', { name: 'Skip this run', exact: true })).toBeDisabled();
    f.nextSkipPreview('bad-ack'); await confirmation(page).getByRole('button', { name: 'Retry skip preview', exact: true }).click();
    await expect(confirmation(page).getByRole('alert')).toContainText('could not be confirmed');
    expect(f.skipChanges).toEqual([]); await confirmation(page).getByRole('button', { name: 'Retry skip preview', exact: true }).click();
    await expect(confirmation(page).getByRole('button', { name: 'Skip this run', exact: true })).toBeEnabled();
    await f.update({ schedule_id: saved.schedule_id, expected_revision: 1, cron_expression: '*/10 * * * *' }); await confirm(page);
    await expect(panel(page).getByRole('alert')).toContainText('changed');
    expect(await f.get(saved.schedule_id)).toMatchObject({ revision: 2, next_run_at: NOW + 600000, skip_state: { revision: 0 } });
    expect(f.skipChanges).toEqual([{ action: 'skip_next', request: { schedule_id: saved.schedule_id, expected_revision: 1, expected_skip_revision: 0, run_at: NOW + 300000 } }]);
    await open(page, saved); await expect(confirmation(page)).toContainText('8:20 AM GMT-4'); await confirm(page);
    await expect(card(page, saved).getByRole('button', { name: 'Undo skip', exact: true })).toBeEnabled();
    expect((await f.get(saved.schedule_id)).next_run_at).toBe(NOW + 1200000); expect(f.skipChanges[1]?.request.run_at).toBe(NOW + 600000); expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('checks a lost skip reply and an unconfirmed Undo after reload using their original clock revisions', async ({ page }) => {
  const { f, saved } = await setup(page);
  try {
    await go(page, address(saved)); await open(page, saved); f.nextSkip('lost'); await confirm(page);
    await expect(card(page, saved).getByRole('button', { name: 'Check skip', exact: true })).toBeEnabled();
    const first = f.skipChanges[0]!; expect(await pending(page)).toEqual([first]); await refresh(page);
    await card(page, saved).getByRole('button', { name: 'Check skip', exact: true }).click();
    await expect(card(page, saved).getByRole('button', { name: 'Undo skip', exact: true })).toBeEnabled();
    expect(f.skipChanges).toEqual([first, first]); expect((await f.get(saved.schedule_id)).next_run_at).toBe(NOW + 600000);
    f.nextSkip('bad-ack'); await card(page, saved).getByRole('button', { name: 'Undo skip', exact: true }).click();
    await expect(card(page, saved).getByRole('button', { name: 'Check undo', exact: true })).toBeEnabled();
    const restore = f.skipChanges[2]!; await refresh(page); await card(page, saved).getByRole('button', { name: 'Check undo', exact: true }).click();
    await expect(card(page, saved).getByRole('button', { name: 'Skip next run', exact: true })).toBeEnabled();
    expect(f.skipChanges).toEqual([first, first, restore, restore]); expect(await pending(page)).toEqual([]);
    expect(await f.get(saved.schedule_id)).toMatchObject({ revision: 1, next_run_at: saved.next_run_at, skip_state: { revision: 2 } });
    expect(f.runs()).toBe(0); expect(f.scheduleCount()).toBe(1); expect(f.conversationCount()).toBe(1);
  } finally { f.dispose(); }
});

test('expires Undo automatically at the original run time while leaving the following run active', async ({ page }) => {
  await page.clock.install({ time: new Date(NOW) }); const f = await installPromptRecoveryFixture(page);
  try {
    const saved = await f.seed({ cron_expression: '*/5 * * * *' }); await go(page, address(saved)); await open(page, saved); await confirm(page);
    await expect(card(page, saved).getByRole('button', { name: 'Undo skip', exact: true })).toBeEnabled();
    f.setNow(NOW + 300000); await page.clock.fastForward(300010);
    await expect(card(page, saved).getByRole('button', { name: 'Undo skip', exact: true })).toHaveCount(0);
    await expect(card(page, saved).getByRole('button', { name: 'Skip next run', exact: true })).toBeEnabled();
    expect(await f.get(saved.schedule_id)).toMatchObject({ enabled: true, revision: 1, next_run_at: NOW + 600000 });
    expect(f.skipChanges).toHaveLength(1); await open(page, saved); await expect(confirmation(page)).toContainText('8:15 AM GMT-4');
    expect(f.skipChanges).toHaveLength(1); expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('rejects an Undo that reaches the server after its deadline instead of restoring an overdue occurrence', async ({ page }) => {
  const { f, saved } = await setup(page);
  try {
    await go(page, address(saved)); await open(page, saved); await confirm(page);
    await expect(card(page, saved).getByRole('button', { name: 'Undo skip', exact: true })).toBeEnabled();
    f.nextSkip('hold-before'); await card(page, saved).getByRole('button', { name: 'Undo skip', exact: true }).click(); await expect.poll(f.skipPending).toBe(true);
    f.setNow(saved.next_run_at!); await page.clock.setFixedTime(new Date(saved.next_run_at!)); f.releaseSkip();
    await expect(panel(page).getByRole('alert')).toContainText('no longer be undone');
    await expect(card(page, saved).getByRole('button', { name: 'Undo skip', exact: true })).toHaveCount(0);
    expect((await f.get(saved.schedule_id)).next_run_at).toBe(NOW + 600000); expect(await pending(page)).toEqual([]); expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('discards a late preview after it is closed and a different occurrence is reviewed', async ({ page }) => {
  const { f, saved } = await setup(page);
  try {
    await go(page, address(saved)); f.nextSkipPreview('hold'); await open(page, saved); await expect.poll(f.skipPreviewPending).toBe(true);
    await confirmation(page).getByRole('button', { name: 'Keep next run', exact: true }).click();
    await f.update({ schedule_id: saved.schedule_id, expected_revision: 1, cron_expression: '*/10 * * * *' });
    await panel(page).getByRole('button', { name: 'Refresh', exact: true }).click(); await expect.poll(async () => (await f.get(saved.schedule_id)).revision).toBe(2);
    await expect(card(page, saved).locator('dl')).toContainText('8:10 AM');
    await open(page, saved); await expect(confirmation(page)).toContainText(/Following run: Oct 31, 2026(?:,| at) 8:20 AM GMT-4/); f.releaseSkipPreview();
    await expect(confirmation(page)).not.toContainText('8:05 AM GMT-4');
    await confirm(page); await expect(card(page, saved).getByRole('button', { name: 'Undo skip', exact: true })).toBeEnabled();
    expect(f.skipChanges[0]?.request).toMatchObject({ expected_revision: 2, expected_skip_revision: 0, run_at: NOW + 600000 });
    expect((await f.get(saved.schedule_id)).next_run_at).toBe(NOW + 1200000); expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('offers skips only with server support and an active recurring prompt, and Chat keeps its composer while skipping', async ({ page }) => {
  const { f, saved } = await setup(page);
  try {
    const paused = await f.seed({ title: 'Paused briefing' }); await f.pause(paused.schedule_id);
    const once = await f.seed({ title: 'One-off briefing', mode: 'one_shot', cron_expression: undefined, run_at: '2026-11-02T12:00Z' });
    await go(page, '#automation/schedules'); await expect(card(page, saved).getByRole('button', { name: 'Skip next run', exact: true })).toBeVisible();
    await expect(card(page, paused).getByRole('button', { name: 'Skip next run', exact: true })).toHaveCount(0);
    await expect(card(page, once).getByRole('button', { name: 'Skip next run', exact: true })).toHaveCount(0);
    f.capabilities('old'); await refresh(page); await expect(panel(page).getByRole('button', { name: 'Skip next run', exact: true })).toHaveCount(0);
    f.capabilities('current');
    await go(page, '#chat/session/' + saved.session_id); const composer = page.locator('[data-recued-chat-route-input]'); await composer.fill('Keep this chat draft.');
    await panel(page).locator('[data-prompt-schedule-compact] > summary').click(); await open(page, saved); await confirm(page);
    await expect(card(page, saved).getByRole('button', { name: 'Undo skip', exact: true })).toBeEnabled();
    await expect(composer).toHaveValue('Keep this chat draft.'); expect((await f.get(saved.schedule_id)).next_run_at).toBe(NOW + 600000);
    expect(f.skipChanges).toHaveLength(1); expect(f.runs()).toBe(0); expect(f.creates).toEqual([]);
  } finally { f.dispose(); }
});
