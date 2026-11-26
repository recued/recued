import { expect, test, type Page } from '@playwright/test';
import { mailFollowUpReplyHref } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailFollowUpFixture } from './helpers/mail-follow-up-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
const watchDialog = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const editor = (page: Page) => page.getByRole('dialog', { name: 'Reply all', exact: true });
const notices = (page: Page) => page.locator('[data-recued-notify-toast]');
const preference = (page: Page) => watchDialog(page).getByRole('checkbox', { name: 'Notify me when a reply arrives', exact: true });
const boot = async (page: Page, optIn = false) => {
  const f = await installMailFollowUpFixture(page, { verifyMessages: true });
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser&server_profiles=multiple#data/mail/record/work/sent-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.getByRole('article', { name: 'Email message', exact: true }).getByRole('button', { name: 'Follow up if no reply', exact: true }).click();
  await expect(preference(page)).not.toBeChecked(); if (optIn) await preference(page).check();
  await watchDialog(page).getByRole('button', { name: 'In 1 hour', exact: true }).click();
  await watchDialog(page).getByRole('button', { name: 'Start reply watch', exact: true }).click();
  await expect(watchDialog(page).getByRole('status')).toHaveText('Waiting for a reply');
  return f;
};

test('opens the actual received reply from a watch and continues with Reply all and the existing AI composer', async ({ page }) => {
  const f = await boot(page);
  try {
    await preference(page).check(); await expect(preference(page)).toBeEnabled(); await expect(preference(page)).toBeChecked();
    await expect(preference(page)).toBeFocused();
    f.add({ body_inline: 'We can renew for another year. Please confirm the revised terms.',
      hot_fields: { subject: 'Renewal terms confirmed', to: ['owner@example.test', 'copy@example.test'], cc: ['reviewer@example.test'] } });
    await watchDialog(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(watchDialog(page).getByRole('status')).toHaveText('Reply received');
    await watchDialog(page).getByRole('button', { name: 'Open received reply', exact: true }).click();
    await expect(page).toHaveURL(/#data\/mail\/record\/work\/reply-1$/);
    const message = page.getByRole('article', { name: 'Email message', exact: true });
    await expect(page.getByRole('region', { name: 'Email conversation', exact: true })).toContainText('Renewal terms confirmed');
    await expect(message).toContainText('Please confirm the revised terms.');
    await message.getByRole('button', { name: 'Reply all', exact: true }).click(); await expect(editor(page)).toBeVisible();
    await expect.poll(() => editor(page).locator('[data-form-array-item="to"]').evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value)))
      .toEqual(['alex@example.test', 'copy@example.test']);
    await expect(editor(page).locator('[data-mail-compose-ai-brief]')).toBeVisible();
    await expect(editor(page).getByRole('button', { name: 'Draft with AI', exact: true })).toBeVisible();
    await editor(page).getByRole('textbox', { name: 'Body', exact: true }).fill('Thanks, I will review the revised terms today.');
    await editor(page).getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(editor(page).locator('[data-mail-draft-status]')).toContainText('Draft saved.');
    const saved = (await f.drafts.list({}, f.principal)).drafts[0]!;
    const detail = await f.drafts.get({ draft_id: saved.draft_id }, f.principal);
    expect(detail.content).toMatchObject({ sender_mail_instance: 'work', in_reply_to: '<reply-1@example.test>',
      references: ['<sent-1@example.test>', '<reply-1@example.test>'], to: ['alex@example.test', 'copy@example.test'], cc: ['reviewer@example.test'] });
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('an opted-in reply before the follow-up deadline produces one alert that opens the verified received message', async ({ page }) => {
  const f = await boot(page, true);
  try {
    const watch = (await f.service.list()).watches[0]!;
    await watchDialog(page).getByRole('button', { name: 'Close', exact: true }).click(); await page.evaluate(() => window.__app.setHash('#chat'));
    f.add({ body_inline: 'The renewal is approved. We will send the paperwork.' }); await f.service.sweep();
    await f.replyAlerts.tick(); await f.flushAlerts();
    expect(f.now()).toBeLessThan(watch.check_at); expect(f.draftCount()).toBe(0);
    await expect(notices(page)).toHaveCount(1); await expect(notices(page)).toContainText('Reply received');
    const open = notices(page).getByRole('link', { name: 'Open', exact: true });
    await expect(open).toHaveAttribute('href', mailFollowUpReplyHref(watch.id)); await open.focus(); await open.press('Enter');
    await expect(page).toHaveURL(/#data\/mail\/record\/work\/reply-1$/);
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toContainText('The renewal is approved.');
    await f.makeReplyAlerts().tick(); await f.flushAlerts(); expect(await f.activities.list()).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('quiet hours defer an unseen reply alert until catch-up, and the reply preference can stop another queued alert', async ({ page }) => {
  const f = await boot(page, true);
  try {
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('recued.notice-catch-up.v1:'))
      .map(key => JSON.parse(localStorage.getItem(key)!).through))).toEqual([0]);
    f.quiet(true); f.add({ body_inline: 'A reply that arrived while the owner was away.' }); await f.service.sweep();
    await f.replyAlerts.tick(); expect(f.frames).toEqual([]); expect(await f.activities.list()).toEqual([]);
    await watchDialog(page).getByRole('button', { name: 'Close', exact: true }).click(); await page.evaluate(() => window.__app.setHash('#chat'));
    f.quiet(false); await f.replyAlerts.tick(); f.frames.splice(0);
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await expect(notices(page)).toContainText('Reply received');
    await notices(page).getByRole('link', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toContainText('A reply that arrived');
    await notices(page).getByRole('button', { name: /Dismiss notification/ }).click();
    await f.makeReplyAlerts().tick(); await f.flushAlerts(); await expect(notices(page)).toHaveCount(0);
    // A second watch has its own opt-in; stopping it during quiet hours sends nothing later.
    const other = await f.service.start({ ...f.request(undefined, 'personal'), notify_on_reply: true }, 'paired-owner');
    f.add({}, 'personal'); await f.service.sweep(); const replied = await f.service.check(other.id);
    await page.evaluate(hash => window.__app.setHash(hash), `#mail/reply-watch/${other.id}`);
    await expect(watchDialog(page).getByRole('status')).toHaveText('Reply received');
    // The successful save removes this terminal watch's checkbox. Check the
    // resulting UI and stored preference rather than rechecking a removed node.
    await expect(preference(page)).toBeChecked(); await preference(page).focus(); await preference(page).press('Space');
    await expect(preference(page)).toHaveCount(0);
    await expect(watchDialog(page).getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await f.replyAlerts.tick(); await f.flushAlerts(); await expect(notices(page)).toHaveCount(0);
    expect((await f.service.check(replied.id)).notify_on_reply).toBe(false);
  } finally { f.dispose(); }
});

test('a reply replaced during the reader handoff shows an unavailable state instead of the replacement message', async ({ page }) => {
  const f = await boot(page);
  try {
    f.add({ body_inline: 'Original recipient reply.' }); await watchDialog(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(watchDialog(page).getByRole('status')).toHaveText('Reply received');
    f.hold('collection.mail.message.get'); await watchDialog(page).getByRole('button', { name: 'Open received reply', exact: true }).click();
    await expect.poll(f.isHeld).toBe(true);
    const row = f.tables.get('work')!.get('reply-1')!;
    f.tables.get('work')!.upsert({ ...row, source_id: 'replacement-provider-message', received_at: row.received_at + 1, body_inline: 'Replacement message must stay hidden.' });
    f.release(); await expect(page.getByRole('alert')).toContainText('removed or replaced');
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Replacement message must stay hidden.');
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});
