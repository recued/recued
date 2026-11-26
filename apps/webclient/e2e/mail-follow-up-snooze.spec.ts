import { expect, test, type Page } from '@playwright/test';
import { mailFollowUpHref } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailFollowUpFixture } from './helpers/mail-follow-up-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
const dialog = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const editor = (page: Page) => page.getByRole('dialog', { name: 'Reply', exact: true });
const input = (page: Page) => dialog(page).getByLabel('Check date and time (America/Los_Angeles)', { exact: true });
const toasts = (page: Page) => page.locator('[data-recued-notify-toast]');
const boot = async (page: Page) => {
  const f = await installMailFollowUpFixture(page);
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser&server_profiles=multiple#data/mail/record/work/sent-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.getByRole('article', { name: 'Email message', exact: true }).getByRole('button', { name: 'Follow up if no reply', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'In 1 hour', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Start reply watch', exact: true }).click();
  await expect(dialog(page).getByRole('status')).toHaveText('Waiting for a reply');
  return f;
};

test('changes a waiting watch in the server timezone, supports cancel, and retains its new time after reload', async ({ page }) => {
  const f = await boot(page);
  try {
    const original = (await f.service.list()).watches[0]!;
    await dialog(page).getByRole('button', { name: 'Change check time', exact: true }).click();
    await input(page).fill('2026-11-25T10:30'); await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await f.service.list()).watches[0]).toEqual(original);
    expect(f.calls.filter(call => call.method === 'mail.follow_up.reschedule')).toHaveLength(0);
    await dialog(page).getByRole('button', { name: 'Change check time', exact: true }).click();
    await input(page).fill('2026-11-25T10:30'); await dialog(page).getByRole('button', { name: 'Save check time', exact: true }).click();
    await expect(dialog(page).getByRole('status')).toHaveText('Waiting for a reply');
    const moved = (await f.service.list()).watches[0]!;
    expect(moved).toMatchObject({ id: original.id, schedule_version: 1, check_at: Date.parse('2026-11-25T18:30:00Z') });
    f.due(original.check_at); await f.service.sweep(); expect(f.draftCount()).toBe(0);
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click(); await page.reload();
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.getByRole('article', { name: 'Email message', exact: true }).getByRole('button', { name: 'Follow up if no reply', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Change check time', exact: true }).click();
    await expect(input(page)).toHaveValue('2026-11-25T10:30');
  } finally { f.dispose(); }
});

test('snoozes an edited saved draft, retires its old link, and opens one fresh due alert in the same composer', async ({ page }) => {
  const f = await boot(page);
  try {
    const original = (await f.service.list()).watches[0]!; f.due(original.check_at);
    await page.clock.setFixedTime(new Date(f.now())); await f.service.sweep();
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click(); await f.alerts.tick(); await f.flushAlerts();
    const oldHash = await toasts(page).getByRole('link', { name: 'Open', exact: true }).getAttribute('href');
    await toasts(page).getByRole('link', { name: 'Open', exact: true }).click(); await expect(editor(page)).toBeVisible();
    await editor(page).getByRole('textbox', { name: 'Body', exact: true }).fill('Please confirm the revised renewal by Friday.');
    await editor(page).getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(editor(page).locator('[data-mail-draft-status]')).toContainText('Draft saved.');
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Snooze follow-up', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Tomorrow at 9am', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Save check time', exact: true }).click();
    await expect(dialog(page).getByRole('status')).toHaveText('Follow-up snoozed');
    const moved = (await f.service.list()).watches[0]!;
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
    await f.alerts.tick(); await f.flushAlerts();
    // The six-second live card may have expired while its draft was edited.
    expect(JSON.parse((await f.activities.list())[0]!.detail!).title).toBe('Follow-up postponed');
    f.due(moved.check_at); await page.clock.setFixedTime(new Date(f.now())); await f.service.sweep();
    await f.makeAlerts().tick(); await f.flushAlerts();
    const fresh = toasts(page).filter({ hasText: 'Follow-up draft ready' }); await expect(fresh).toHaveCount(1);
    const hash = mailFollowUpHref(moved.id, moved.draft_id, 1);
    await expect(fresh.getByRole('link', { name: 'Open', exact: true })).toHaveAttribute('href', hash);
    await fresh.getByRole('link', { name: 'Open', exact: true }).click(); await expect(editor(page)).toBeVisible();
    await expect(editor(page).getByRole('textbox', { name: 'Body', exact: true })).toHaveValue('Please confirm the revised renewal by Friday.');
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
    // Even the original, externally delivered link must not open a later alert cycle.
    await page.evaluate(() => window.__app.setHash('#chat'));
    await page.evaluate(hash => window.__app.setHash(hash!), oldHash);
    await expect(dialog(page).getByRole('alert')).toContainText('earlier check time'); await expect(editor(page)).toHaveCount(0);
    expect(f.draftCount()).toBe(1); expect(await f.activities.list()).toHaveLength(2);
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('keeps a pending time change immutable and retries its lost response without another schedule', async ({ page }) => {
  const f = await boot(page);
  try {
    await dialog(page).getByRole('button', { name: 'Change check time', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Tomorrow at 9am', exact: true }).click();
    f.loseTimeReply(); f.hold('mail.follow_up.reschedule');
    await dialog(page).getByRole('button', { name: 'Save check time', exact: true }).click();
    await expect.poll(f.isHeld).toBe(true); await expect(dialog(page).getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await dialog(page).press('Escape'); await expect(dialog(page)).toBeVisible(); f.release();
    await expect(dialog(page).getByRole('alert')).toContainText('response was lost'); await expect(input(page)).toBeDisabled();
    await expect(dialog(page).getByRole('button', { name: 'Tomorrow at 9am', exact: true })).toBeDisabled();
    await dialog(page).getByRole('button', { name: 'Check save', exact: true }).click();
    await expect(dialog(page).getByRole('status')).toHaveText('Waiting for a reply');
    const writes = f.calls.filter(call => call.method === 'mail.follow_up.reschedule'); expect(writes).toHaveLength(2);
    expect(writes[0]!.args).toEqual(writes[1]!.args); expect((await f.service.list()).watches[0]!.schedule_version).toBe(1);
  } finally { f.dispose(); }
});

test('shows a reply arriving during a time change and keeps the saved draft without scheduling another alert', async ({ page }) => {
  const f = await boot(page);
  try {
    const original = (await f.service.list()).watches[0]!; f.due(original.check_at); await page.clock.setFixedTime(new Date(f.now()));
    await dialog(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(dialog(page).getByRole('status')).toHaveText('Draft ready for review');
    await dialog(page).getByRole('button', { name: 'Snooze follow-up', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Tomorrow at 9am', exact: true }).click();
    f.beforeWatch(async value => { if ((value as { watch: { schedule_version?: number } }).watch.schedule_version) f.add(); });
    await dialog(page).getByRole('button', { name: 'Save check time', exact: true }).click();
    await expect(dialog(page).getByRole('status')).toHaveText('Reply received');
    await expect(dialog(page).getByRole('button', { name: 'Snooze follow-up', exact: true })).toHaveCount(0);
    await expect(dialog(page).getByRole('button', { name: 'Open saved draft', exact: true })).toBeEnabled();
    f.beforeWatch(); await f.alerts.tick(); expect(f.frames.filter(frame => frame.kind === 'notification.notify' && !frame.replace_existing)).toEqual([]);
    expect((await f.service.list()).watches[0]!.schedule_version).toBeUndefined(); expect(f.draftCount()).toBe(1);
  } finally { f.dispose(); }
});
