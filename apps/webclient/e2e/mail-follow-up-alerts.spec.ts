import { expect, test, type Page } from '@playwright/test';
import { mailFollowUpHref } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailFollowUpFixture } from './helpers/mail-follow-up-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
const toast = (page: Page) => page.locator('[data-recued-notify-toast]');
const watchDialog = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const editor = (page: Page) => page.getByRole('dialog', { name: 'Reply', exact: true });
const boot = async (page: Page) => {
  const f = await installMailFollowUpFixture(page);
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser&server_profiles=multiple#chat`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const waiting = await f.service.start(f.request(), 'paired-owner'); f.due(waiting.check_at);
  await page.clock.setFixedTime(new Date(f.now()));
  const ready = await f.service.check(waiting.id);
  return { f, ready };
};

test('the ready alert opens its exact saved draft in the existing composer and keeps owner edits', async ({ page }) => {
  const { f, ready } = await boot(page);
  try {
    await f.alerts.tick(); await f.flushAlerts();
    await expect(toast(page)).toHaveCount(1); await expect(toast(page)).toContainText('Follow-up draft ready');
    const open = toast(page).getByRole('link', { name: 'Open', exact: true }); await open.focus();
    await expect(open).toHaveAttribute('href', mailFollowUpHref(ready.id, ready.draft_id)); await open.press('Enter');
    await expect(editor(page)).toBeVisible(); await expect(editor(page).getByRole('textbox', { name: 'Subject', exact: true })).toHaveValue('Re: Renewal');
    await editor(page).getByRole('textbox', { name: 'Body', exact: true }).fill('Could you confirm the renewal by Friday?');
    await editor(page).getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(editor(page).locator('[data-mail-draft-status]')).toContainText('Draft saved.');
    const saved = await f.drafts.get({ draft_id: ready.draft_id }, f.principal);
    expect(saved.content.body).toBe('Could you confirm the renewal by Friday?');
    expect(saved.content.in_reply_to).toBe('<sent-1@example.test>');
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('a late reply updates the existing focused alert and opens the resolved watch without opening a draft', async ({ page }) => {
  const { f } = await boot(page);
  try {
    await f.alerts.tick(); await f.flushAlerts(); const open = toast(page).getByRole('link', { name: 'Open', exact: true }); await open.focus();
    f.add(); await f.service.sweep(); f.quiet(true); await f.alerts.tick(); await f.flushAlerts();
    await expect(toast(page)).toHaveCount(1); await expect(toast(page)).toContainText('Follow-up no longer needed'); await expect(open).toBeFocused();
    await open.press('Enter'); await expect(watchDialog(page)).toContainText('Reply received'); await expect(editor(page)).toHaveCount(0);
    expect(await f.activities.list()).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('quiet hours hold the alert; an offline notice is caught up once and remains current after a reply', async ({ page }) => {
  const { f } = await boot(page);
  try {
    // Give this paired tab its ordinary history baseline before the alert is created.
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('recued.notice-catch-up.v1:'))
      .map(key => JSON.parse(localStorage.getItem(key)!).through))).toEqual([0]);
    f.quiet(true); await f.alerts.tick(); expect(f.frames).toEqual([]); expect(await f.activities.list()).toEqual([]);
    f.quiet(false); await f.alerts.tick();
    // The live frame was missed while offline; reconnect reads the persisted activity.
    f.frames.splice(0); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await expect(toast(page)).toContainText('Follow-up draft ready');
    const open = toast(page).getByRole('link', { name: 'Open', exact: true }); await open.focus();
    f.add(); await f.service.sweep(); await f.alerts.tick(); await f.flushAlerts();
    await expect(toast(page)).toContainText('Follow-up no longer needed'); await expect(open).toBeFocused();
    await toast(page).getByRole('button', { name: /Dismiss notification/ }).click();
    await f.makeAlerts().tick(); await f.flushAlerts(); await expect(toast(page)).toHaveCount(0);
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await expect.poll(() => f.calls.filter(call => call.method === 'notification.recent').length).toBeGreaterThan(2);
    await expect(toast(page)).toHaveCount(0);
  } finally { f.dispose(); }
});

test('a stale or mismatched notification link rechecks the watch and never opens another draft automatically', async ({ page }) => {
  const { f, ready } = await boot(page);
  try {
    await f.alerts.tick(); await f.flushAlerts(); f.add(); // Reply not yet processed by a background sweep.
    await toast(page).getByRole('link', { name: 'Open', exact: true }).click();
    await expect(watchDialog(page)).toContainText('Reply received'); await expect(editor(page)).toHaveCount(0);
    await watchDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(hash => window.__app.setHash(hash), mailFollowUpHref(ready.id, 'mad_00000000-0000-4000-8000-000000000099'));
    await expect(watchDialog(page).getByRole('alert')).toContainText('different draft'); await expect(editor(page)).toHaveCount(0);
    await watchDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => window.__app.setHash('#mail/reply-watch/invalid/draft/not-a-draft'));
    await expect(page.getByRole('alert')).toContainText('reply watch link is incomplete'); await expect(editor(page)).toHaveCount(0);
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});
