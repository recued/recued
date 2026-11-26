import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailFollowUpFixture } from './helpers/mail-follow-up-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
const ui = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const trigger = (page: Page) => page.getByRole('article', { name: 'Email message', exact: true }).getByRole('button', { name: 'Follow up if no reply', exact: true });
const boot = async (page: Page) => {
  const f = await installMailFollowUpFixture(page);
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser#data/mail/record/work/sent-1`);
  await page.waitForFunction(() => window.__app?.ready === true); await expect(trigger(page)).toBeVisible(); return f;
};
const arm = async (page: Page) => {
  await trigger(page).click(); await ui(page).getByRole('button', { name: 'In 1 hour', exact: true }).click();
  await ui(page).getByRole('button', { name: 'Start reply watch', exact: true }).click();
  await expect(ui(page).getByRole('status')).toHaveText('Waiting for a reply');
};

test('persists an exact sent-email watch and opens its due draft in the existing editor for owner review', async ({ page }) => {
  const f = await boot(page);
  try {
    await arm(page);
    const watch = (await f.service.list()).watches[0]!;
    expect(watch.mail_ref).toEqual(f.reference()); expect(watch.check_at).toBe(f.now() + 3600_000);
    await ui(page).getByRole('button', { name: 'Close', exact: true }).click(); await expect(trigger(page)).toBeFocused();
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); await trigger(page).click();
    await expect(ui(page).getByRole('status')).toHaveText('Waiting for a reply');
    f.time(watch.check_at);
    await ui(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(ui(page)).toContainText('healthy mailbox sync'); expect(f.draftCount()).toBe(0);
    f.health.last_indexed_at = watch.check_at;
    await ui(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(ui(page).getByRole('status')).toHaveText('Draft ready for review'); expect(f.draftCount()).toBe(1);
    await ui(page).getByRole('button', { name: 'Open saved draft', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Reply', exact: true }); await expect(editor).toBeVisible();
    await expect(editor.locator('[data-form-field="subject"]')).toHaveValue('Re: Renewal');
    const body = editor.locator('[data-form-field="body"]'); await expect(body).toHaveValue(/following up/);
    await body.fill('Thanks Alex, could you confirm the renewal by Friday?');
    await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(editor.locator('[data-mail-draft-status]')).toContainText('Draft saved.');
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(ui(page)).toBeVisible(); await expect(ui(page).getByRole('status')).toHaveText('Draft ready for review');
    const current = (await f.service.list()).watches[0]!;
    const saved = await f.drafts.get({ draft_id: current.draft_id }, f.principal);
    expect(saved.content).toMatchObject({ body: 'Thanks Alex, could you confirm the renewal by Friday?',
      in_reply_to: '<sent-1@example.test>', to: ['alex@example.test', 'copy@example.test'], sender_mail_instance: 'work' });
    await ui(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => window.__app.setHash('#mail'));
    await page.getByRole('button', { name: 'Reply watches', exact: true }).click();
    await ui(page).getByRole('button', { name: 'Manage watch', exact: true }).click();
    await ui(page).getByRole('button', { name: 'Open saved draft', exact: true }).click();
    await expect(editor.locator('[data-form-field="body"]')).toHaveValue(saved.content.body);
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(ui(page)).toBeVisible();
    await ui(page).getByRole('link', { name: 'View watched email', exact: true }).click();
    await expect(page).toHaveURL(/#data\/mail\/record\/work\/sent-1$/); await expect(trigger(page)).toBeVisible();
    expect(f.calls.filter(row => row.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('retries a lost creation once and resolves only the watched mailbox when a recipient replies', async ({ page }) => {
  const f = await boot(page);
  try {
    await trigger(page).click(); await ui(page).getByRole('button', { name: 'In 1 hour', exact: true }).click();
    f.loseStartReply(); await ui(page).getByRole('button', { name: 'Start reply watch', exact: true }).click();
    await expect(ui(page).getByRole('alert')).toContainText('response was lost');
    await expect(ui(page).getByLabel('Check date and time (America/Los_Angeles)', { exact: true })).toBeDisabled();
    await ui(page).getByRole('button', { name: 'Check save', exact: true }).click();
    await expect(ui(page).getByRole('status')).toHaveText('Waiting for a reply');
    const requests = f.calls.filter(row => row.method === 'mail.follow_up.start'); expect(requests).toHaveLength(2); expect(requests[0]!.args).toEqual(requests[1]!.args);
    f.add({}, 'personal'); await ui(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(ui(page).getByRole('status')).toHaveText('Waiting for a reply');
    f.add(); await ui(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(ui(page).getByRole('status')).toHaveText('Reply received');
    expect((await f.service.list()).watches).toHaveLength(1); expect(f.draftCount()).toBe(0);
    expect(f.calls.filter(row => row.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('manages and cancels a watch from Mail after its source mailbox disappears', async ({ page }) => {
  const f = await boot(page);
  try {
    await arm(page); await ui(page).getByRole('button', { name: 'Close', exact: true }).click();
    f.instances.delete('mail', 'work'); f.instances.delete('mail', 'personal');
    await page.evaluate(() => window.__app.setHash('#mail'));
    const watches = page.getByRole('button', { name: 'Reply watches', exact: true }); await expect(watches).toBeVisible(); await watches.click();
    await ui(page).getByRole('button', { name: 'Manage watch', exact: true }).click();
    await ui(page).getByRole('link', { name: 'View watched email', exact: true }).click();
    await expect(ui(page).getByRole('alert')).toContainText('mailbox changed');
    await expect(page).toHaveURL(/#mail$/);
    await ui(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(ui(page).getByRole('status')).toHaveText('Needs attention');
    await ui(page).getByRole('button', { name: 'Cancel watch', exact: true }).click();
    await expect(ui(page).getByRole('status')).toHaveText('Cancelled'); expect(f.draftCount()).toBe(0);
  } finally { f.dispose(); }
});

test('keeps asynchronous work with its dialog and releases navigation after the watch is saved', async ({ page }) => {
  const f = await boot(page);
  try {
    await trigger(page).click(); await ui(page).getByRole('button', { name: 'In 1 hour', exact: true }).click(); f.hold('mail.follow_up.start');
    await ui(page).getByRole('button', { name: 'Start reply watch', exact: true }).click();
    await expect.poll(f.isHeld).toBe(true); await expect(ui(page).getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    await ui(page).press('Escape'); await expect(ui(page)).toBeVisible();
    f.release(); await expect(ui(page).getByRole('status')).toHaveText('Waiting for a reply');
    await ui(page).press('Escape'); await expect(ui(page)).toHaveCount(0); await expect(trigger(page)).toBeFocused();
    await page.evaluate(() => window.__app.setHash('#data/mail'));
    await page.getByRole('button', { name: 'Reply watches', exact: true }).click();
    await expect(ui(page)).toContainText('Renewal'); expect((await f.service.list()).watches).toHaveLength(1);
  } finally { f.dispose(); }
});
