import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailFollowUpFixture } from './helpers/mail-follow-up-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
const editor = (page: Page) => page.getByRole('dialog', { name: 'New mail', exact: true });
const watchDialog = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const choice = (page: Page) => editor(page).getByRole('checkbox', { name: 'Watch for a reply', exact: true });
const load = async (page: Page) => {
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser&server_profiles=multiple#mail`);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const boot = async (page: Page, holdCapability = false) => {
  const installed = await installMailFollowUpFixture(page, { compose: true });
  if (!installed.compose) throw Error('Missing governed-send fixture');
  if (holdCapability) installed.holdComposeCapability();
  await load(page); return { ...installed, compose: installed.compose };
};
const write = async (page: Page) => {
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Add To', exact: true }).click();
  await editor(page).locator('[data-form-array-item="to"]').first().fill('alex@example.test');
  await editor(page).locator('[data-form-field="subject"]').fill('Composer renewal');
  await editor(page).getByRole('textbox', { name: 'Body', exact: true }).fill('Please confirm the revised renewal terms.');
  await choice(page).check(); await editor(page).getByRole('combobox', { name: 'Reply check interval', exact: true }).selectOption('3600000');
};
const openPending = async (page: Page, dismissToast = true) => {
  if (dismissToast) await page.locator('[data-recued-notify-toast]').filter({ hasText: 'Reply watch request' }).getByRole('button', { name: /Dismiss notification/ }).click();
  await page.getByRole('button', { name: 'Reply watches', exact: true }).click();
  await watchDialog(page).getByRole('button', { name: 'Manage pending watch', exact: true }).click();
  await expect(watchDialog(page).getByRole('heading', { name: 'Reply watch request', exact: true })).toBeVisible();
};

test('opens the composer while optional capabilities are pending and preserves typing when they arrive', async ({ page }) => {
  const f = await boot(page, true);
  try {
    await page.getByRole('button', { name: 'New mail', exact: true }).click(); await expect(editor(page)).toBeVisible();
    const body = editor(page).getByRole('textbox', { name: 'Body', exact: true });
    await body.fill('Keep my unfinished message.'); await expect(choice(page)).toHaveCount(0);
    f.releaseComposeCapability(); await expect(choice(page)).toBeVisible();
    await expect(body).toHaveValue('Keep my unfinished message.'); await expect(body).toBeFocused();
    expect(f.compose.delivered).toEqual([]); expect(f.compose.sendStore.activeIds()).toEqual([]);
  } finally { f.releaseComposeCapability(); f.dispose(); }
});

test('chooses a watch in the composer, waits for real approval and Sent sync, then finds its due draft in Today and Search', async ({ page }) => {
  const f = await boot(page);
  try {
    await write(page); await editor(page).getByRole('checkbox', { name: 'Notify me when a reply arrives', exact: true }).check();
    await editor(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(f.compose.delivered).toEqual([]); expect((await f.service.list()).watches).toEqual([]);
    await page.locator('[data-recued-notify-toast]').filter({ hasText: 'Reply watch request' }).getByRole('link', { name: 'Open', exact: true }).click();
    await expect(watchDialog(page).getByRole('status')).toHaveText('Waiting for send approval');
    await f.compose.answer('approve'); expect(f.compose.delivered).toHaveLength(1);
    await watchDialog(page).getByRole('button', { name: 'Refresh reply watch request', exact: true }).click();
    await expect(watchDialog(page).getByRole('status')).toHaveText('Waiting for Sent sync');
    expect((await f.service.list()).watches).toEqual([]);
    f.compose.syncSent(); f.compose.restartSend();
    await watchDialog(page).getByRole('button', { name: 'Refresh reply watch request', exact: true }).click();
    await expect(watchDialog(page).getByRole('status')).toHaveText('Waiting for a reply');
    const watch = (await f.service.list()).watches[0]!; expect(watch.check_at).toBe(f.now() + 3600000); expect(watch.notify_on_reply).toBe(true);
    await watchDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => window.__app.setHash('#data/search')); await page.getByRole('searchbox', { name: 'Search everything', exact: true }).fill('Composer renewal');
    await expect(page.getByRole('region', { name: 'Reply watch search results', exact: true }).getByRole('link', { name: 'Open follow-up Composer renewal', exact: true })).toBeVisible();
    f.due(watch.check_at); await page.clock.setFixedTime(new Date(f.now())); await page.evaluate(() => window.__app.setHash('#today'));
    const row = page.locator(`[data-today-follow-up="${watch.id}"]`); await expect(row).toContainText('Check due');
    await row.getByRole('link', { name: 'Check now: Composer renewal', exact: true }).click();
    await expect(watchDialog(page).getByRole('status')).toHaveText('Draft ready for review');
    await watchDialog(page).getByRole('button', { name: 'Open saved draft', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Reply', exact: true }).getByRole('textbox', { name: 'Body', exact: true })).toHaveValue(/following up/);
    expect(f.compose.delivered).toHaveLength(1); expect(f.draftCount()).toBe(1);
  } finally { f.dispose(); }
});

test('cancels a pending reply watch without cancelling the separately approved email', async ({ page }) => {
  const f = await boot(page);
  try {
    await write(page); await editor(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    await openPending(page); await expect(watchDialog(page)).toContainText('does not cancel or resend the email');
    const cancel = watchDialog(page).getByRole('button', { name: 'Cancel reply watch request', exact: true }); await cancel.focus(); await cancel.press('Enter');
    await expect(watchDialog(page).getByRole('status')).toHaveText('Reply watch cancelled');
    await f.compose.answer('approve'); f.compose.syncSent(); f.compose.restartSend(); await f.compose.send().sweep();
    expect(f.compose.delivered).toHaveLength(1); expect((await f.service.list()).watches).toEqual([]);
  } finally { f.dispose(); }
});

test('shows a denied governed send without an active reply watch or a provider delivery', async ({ page }) => {
  const f = await boot(page);
  try {
    await write(page); await editor(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(editor(page)).toHaveCount(0); await openPending(page);
    await f.compose.answer('deny'); await watchDialog(page).getByRole('button', { name: 'Refresh reply watch request', exact: true }).click();
    await expect(watchDialog(page).getByRole('status')).toHaveText('Send did not start');
    expect(f.compose.delivered).toEqual([]); expect((await f.service.list()).watches).toEqual([]);
  } finally { f.dispose(); }
});

test('keeps the preference in a saved draft, guards scheduling, and lets an older server send after the owner turns it off', async ({ page }) => {
  const f = await boot(page);
  try {
    await write(page); await editor(page).getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(editor(page).locator('[data-mail-draft-status]')).toContainText('Draft saved.');
    const saved = (await f.drafts.list({}, f.principal)).drafts[0]!;
    expect((await f.drafts.get({ draft_id: saved.draft_id }, f.principal)).content.follow_up).toMatchObject({ after_ms: 3600000 });
    await editor(page).getByRole('button', { name: 'Schedule…', exact: true }).click(); await expect(editor(page).getByRole('alert')).toContainText('currently support Send');
    expect(f.compose.sendStore.activeIds()).toEqual([]); await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    f.composeAvailable(false); await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await page.locator(`[data-mail-draft-id="${saved.draft_id}"]`).getByRole('button', { name: 'Composer renewal', exact: true }).click();
    await expect(choice(page)).toBeChecked(); await expect(editor(page)).toContainText('This server cannot start reply watches from the composer');
    const calls = f.calls.filter(item => item.method === 'execute').length;
    await editor(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(editor(page).getByRole('alert')).toContainText('unavailable on this server');
    expect(f.calls.filter(item => item.method === 'execute')).toHaveLength(calls);
    await choice(page).uncheck(); await editor(page).getByRole('button', { name: 'Send', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    expect(f.compose.sendStore.activeIds()).toEqual([]); expect(f.compose.delivered).toEqual([]);
  } finally { f.dispose(); }
});

test('restores the watch choice with an unfinished message and keeps a lost submit response from dispatching again', async ({ page }) => {
  const f = await boot(page);
  try {
    await write(page); await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await editor(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await page.getByRole('button', { name: 'Restore message', exact: true }).click(); await expect(choice(page)).toBeChecked();
    await expect(editor(page).getByRole('combobox', { name: 'Reply check interval', exact: true })).toHaveValue('3600000');
    f.loseExecuteReply(); await editor(page).getByRole('button', { name: 'Send', exact: true }).click();
    await expect(editor(page).locator('[data-mail-compose-recovery-status]')).toContainText('not confirmed');
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click(); f.compose.restartSend();
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await page.getByRole('button', { name: 'View submitted message', exact: true }).click();
    await expect(editor(page).getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(editor(page).getByRole('link', { name: 'View reply watch request', exact: true })).toBeVisible();
    await editor(page).getByRole('link', { name: 'View reply watch request', exact: true }).click(); await expect(editor(page)).toHaveCount(0);
    await expect(watchDialog(page).getByRole('status')).toHaveText('Waiting for send approval');
    const submitted = f.calls.find(item => item.method === 'execute')!.args;
    await f.compose.execute(submitted as Parameters<typeof f.compose.execute>[0]);
    expect((await f.compose.asks.listByStatus('open'))).toHaveLength(1); expect(f.compose.delivered).toEqual([]);
    await f.compose.answer('approve'); f.compose.syncSent(); await f.compose.send().sweep(); expect((await f.service.list()).watches).toHaveLength(1); expect(f.compose.delivered).toHaveLength(1);
  } finally { f.dispose(); }
});
