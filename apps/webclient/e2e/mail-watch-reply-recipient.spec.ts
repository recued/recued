import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailFollowUpFixture } from './helpers/mail-follow-up-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
const watches = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const compose = (page: Page) => page.getByRole('dialog', { name: /^(New mail|Reply)$/ });
const waitingFor = (page: Page) => compose(page).getByRole('combobox', { name: 'Waiting for', exact: true });
const boot = async (page: Page, hash = '#mail') => {
  const f = await installMailFollowUpFixture(page, { compose: true, verifyMessages: true });
  if (!f.compose) throw Error('Missing governed send fixture');
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser&server_profiles=multiple${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true); return { ...f, compose: f.compose };
};
const write = async (page: Page) => {
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await compose(page).getByRole('button', { name: 'Add To', exact: true }).click();
  await compose(page).locator('[data-form-array-item="to"]').fill('alex@example.test');
  await compose(page).locator('[data-mail-compose-copy-recipients] summary').click();
  await compose(page).getByRole('button', { name: 'Add Cc', exact: true }).click();
  await compose(page).locator('[data-form-array-item="cc"]').fill('copy@example.test');
  await compose(page).getByRole('textbox', { name: 'Subject', exact: true }).fill('Chosen participant');
  await compose(page).getByRole('textbox', { name: 'Body', exact: true }).fill('Please send the revised estimate.');
  await compose(page).getByRole('checkbox', { name: 'Watch for a reply', exact: true }).check();
  await waitingFor(page).selectOption('alex@example.test');
};

test('chooses a person from Sent, shows other participant activity, retains the choice in a due draft and resolves only for that person', async ({ page }) => {
  const f = await boot(page, '#data/mail/record/work/sent-1');
  try {
    await page.getByRole('article', { name: 'Email message', exact: true }).getByRole('button', { name: 'Follow up if no reply', exact: true }).click();
    await watches(page).getByRole('combobox', { name: 'Waiting for', exact: true }).selectOption('alex@example.test');
    await watches(page).getByRole('button', { name: 'In 1 hour', exact: true }).click();
    await watches(page).getByRole('button', { name: 'Start reply watch', exact: true }).click();
    await expect(watches(page)).toContainText('Waiting for: alex@example.test');
    const watch = (await f.service.list()).watches[0]!;
    f.add({ hot_fields: { from: 'copy@example.test' } });
    await watches(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(watches(page).getByRole('status')).toHaveText('Waiting for a reply'); await expect(watches(page)).toContainText('1 other participant reply');
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await page.getByRole('article', { name: 'Email message', exact: true }).getByRole('button', { name: 'Follow up if no reply', exact: true }).click();
    await expect(watches(page)).toContainText('Waiting for: alex@example.test');
    f.due(); await page.clock.setFixedTime(new Date(f.now()));
    await watches(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await watches(page).getByRole('button', { name: 'Open saved draft', exact: true }).click();
    await expect(waitingFor(page)).toHaveValue('alex@example.test');
    await expect(compose(page).getByRole('checkbox', { name: 'Watch for a reply', exact: true })).toBeChecked();
    await compose(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    f.add({ record_id: 'chosen-reply', source_id: 'chosen-reply-source', received_at: f.now() + 1 });
    await watches(page).getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(watches(page).getByRole('status')).toHaveText('Reply received');
    expect((await f.service.getReply({ id: watch.id })).mail_ref.record_id).toBe('chosen-reply');
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('keeps the original responder in an uncertain Sent watch save and retries the identical request', async ({ page }) => {
  const f = await boot(page, '#data/mail/record/work/sent-1');
  try {
    await page.getByRole('article', { name: 'Email message', exact: true }).getByRole('button', { name: 'Follow up if no reply', exact: true }).click();
    const choice = watches(page).getByRole('combobox', { name: 'Waiting for', exact: true });
    await choice.selectOption('copy@example.test'); f.loseStartReply();
    await watches(page).getByRole('button', { name: 'Start reply watch', exact: true }).click();
    await expect(watches(page).getByRole('alert')).toBeVisible(); await expect(choice).toHaveValue('copy@example.test'); await expect(choice).toBeDisabled();
    await watches(page).getByRole('button', { name: 'Check save', exact: true }).click();
    await expect(watches(page)).toContainText('Waiting for: copy@example.test');
    const calls = f.calls.filter(call => call.method === 'mail.follow_up.start'); expect(calls).toHaveLength(2); expect(calls[0]!.args).toEqual(calls[1]!.args);
    expect((await f.service.list()).watches).toHaveLength(1);
  } finally { f.dispose(); }
});

test('requires fresh recipient review, saves the choice, guards scheduling and starts it only after approval and Sent verification', async ({ page }) => {
  const f = await boot(page);
  try {
    await write(page);
    const cc = compose(page).locator('[data-form-array-item="cc"]'); await cc.fill('another@example.test');
    await expect(cc).toBeFocused(); await expect(cc).toHaveValue('another@example.test');
    await expect(waitingFor(page)).toHaveValue('__review__');
    await compose(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(compose(page).getByRole('alert')).toContainText('Review Waiting for');
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
    await waitingFor(page).selectOption('alex@example.test');
    await compose(page).getByRole('button', { name: 'Schedule…', exact: true }).click(); await expect(compose(page).getByRole('alert')).toContainText('Anyone on To/Cc before scheduling');
    await compose(page).getByRole('button', { name: 'Save draft', exact: true }).click(); await expect(compose(page).locator('[data-mail-draft-status]')).toContainText('Draft saved.');
    const draft = (await f.drafts.list({}, f.principal)).drafts[0]!;
    await compose(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await page.locator(`[data-mail-draft-id="${draft.draft_id}"]`).getByRole('button', { name: 'Chosen participant', exact: true }).click(); await expect(waitingFor(page)).toHaveValue('alex@example.test');
    await compose(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(compose(page)).toHaveCount(0);
    expect(f.compose.delivered).toHaveLength(0); const pending = (await f.compose.send().pending())[0]!; expect(pending.waiting_for!.recipients).toEqual(['alex@example.test', 'another@example.test']);
    await f.compose.answer('approve'); expect((await f.compose.send().get(pending.id))!.state).toBe('awaiting_sync');
    f.compose.syncSent(); f.compose.restartSend(); expect((await f.compose.send().get(pending.id))!.state).toBe('armed');
    expect((await f.service.check(pending.id)).waiting_for!.address).toBe('alex@example.test'); expect(f.compose.delivered).toHaveLength(1);
    const args = f.calls.find(call => call.method === 'execute')!.args as { config: object };
    expect(args.config).not.toHaveProperty('follow_up');
  } finally { f.dispose(); }
});

test('restores the chosen person with unfinished edits and lets the owner explicitly return to Anyone', async ({ page }) => {
  const f = await boot(page);
  try {
    await write(page); await compose(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await compose(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click(); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await page.getByRole('button', { name: 'Restore message', exact: true }).click(); await expect(waitingFor(page)).toHaveValue('alex@example.test');
    await waitingFor(page).selectOption(''); await compose(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(compose(page)).toHaveCount(0);
    const pending = (await f.compose.send().pending())[0]!; expect(pending.waiting_for).toBeUndefined();
    await f.compose.answer('deny'); expect(f.compose.delivered).toHaveLength(0);
  } finally { f.dispose(); }
});
