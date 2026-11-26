import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailFollowUpFixture } from './helpers/mail-follow-up-fixture.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
const watchDialog = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const results = (page: Page) => page.getByRole('region', { name: 'Reply watch search results', exact: true });
const query = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
const go = async (page: Page, hash: string) => {
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser&server_profiles=multiple${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const backToSearch = async (page: Page, state: string) => {
  await page.goBack(); await expect(query(page)).toHaveValue('Renewal');
  await expect(page.getByRole('combobox', { name: 'Result type', exact: true })).toHaveValue('follow_up');
  await expect(page.getByRole('combobox', { name: 'Reply watch status', exact: true })).toHaveValue(state);
  await expect(results(page).getByRole('link', { name: 'Open follow-up Renewal', exact: true })).toBeFocused();
};

test('Today brings up due watches and ready drafts, then snoozes the same edited draft out of Today', async ({ page }) => {
  const f = await installMailFollowUpFixture(page);
  try {
    const watch = await f.service.start(f.request(), 'paired-owner');
    await f.service.start(f.request(watch.check_at + 3600_000, 'personal'), 'paired-owner');
    f.due(watch.check_at); await page.clock.setFixedTime(new Date(f.now())); await go(page, '#today');
    const today = page.locator('[data-today-follow-ups]'), row = today.locator(`[data-today-follow-up="${watch.id}"]`);
    await expect(row).toContainText('Check due'); await expect(today.locator('[data-today-follow-up]')).toHaveCount(1);
    expect(f.calls.filter(call => call.method === 'mail.follow_up.check')).toEqual([]); expect(f.draftCount()).toBe(0);
    await row.getByRole('link', { name: 'Check now: Renewal', exact: true }).click();
    await expect(watchDialog(page).getByRole('status')).toHaveText('Draft ready for review');
    const ready = await f.service.check(watch.id), saved = await f.drafts.get({ draft_id: ready.draft_id }, f.principal);
    await f.drafts.update({ draft_id: saved.draft_id, expected_revision: saved.revision, content: { ...saved.content, body: 'Keep these owner edits after snoozing.' } }, f.principal);
    await watchDialog(page).getByRole('button', { name: 'Close', exact: true }).click(); await page.goBack();
    await expect(row).toContainText('Draft ready for review');
    await row.getByRole('link', { name: 'Snooze: Renewal', exact: true }).click();
    await expect(watchDialog(page).getByRole('heading', { name: 'Snooze follow-up', exact: true })).toBeVisible();
    await watchDialog(page).getByRole('button', { name: 'In 1 hour', exact: true }).click();
    await watchDialog(page).getByRole('button', { name: 'Save check time', exact: true }).click();
    await expect(watchDialog(page).getByRole('status')).toHaveText('Follow-up snoozed');
    await watchDialog(page).getByRole('button', { name: 'Close', exact: true }).click(); await page.goBack();
    await expect(today).toContainText('No reply watches need attention.'); await expect(today.locator('[data-today-follow-up]')).toHaveCount(0);
    expect((await f.drafts.get({ draft_id: ready.draft_id }, f.principal)).content.body).toBe('Keep these owner edits after snoozing.');
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('Today keeps confirmed watches and a source warning when refresh fails, and retry clears the warning', async ({ page }) => {
  const f = await installMailFollowUpFixture(page);
  try {
    const watch = await f.service.start(f.request(), 'paired-owner'); f.due(watch.check_at); await page.clock.setFixedTime(new Date(f.now())); await go(page, '#today');
    const today = page.locator('[data-today-follow-ups]'); await expect(today.locator('[data-today-follow-up]')).toHaveCount(1);
    const refresh = today.getByRole('button', { name: 'Refresh reply watches', exact: true });
    f.failList(true); await refresh.focus(); await refresh.press('Enter');
    await expect(today.getByRole('alert')).toContainText('temporarily unavailable'); await expect(today.locator('[data-today-follow-up]')).toHaveCount(1);
    await expect(refresh).toBeFocused();
    await expect(today).not.toContainText('No reply watches need attention.');
    f.failList(false); await refresh.press('Enter');
    await expect(today.getByRole('alert')).toHaveCount(0); await expect(today.locator('[data-today-follow-up]')).toHaveCount(1);
    await expect(refresh).toBeFocused();
  } finally { f.dispose(); }
});

test('Search finds a ready watch in All types and restores the exact result, query, status filter and focus after draft review', async ({ page }) => {
  const f = await installMailFollowUpFixture(page);
  try {
    const watch = await f.service.start(f.request(), 'paired-owner'); f.due(watch.check_at); const ready = await f.service.check(watch.id);
    const saved = await f.drafts.get({ draft_id: ready.draft_id }, f.principal);
    await f.drafts.update({ draft_id: saved.draft_id, expected_revision: saved.revision, content: { ...saved.content, body: 'The owner already edited this draft.' } }, f.principal);
    await go(page, '#data/search'); await query(page).fill('Renewal');
    await expect(results(page).getByRole('link', { name: 'Open follow-up Renewal', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('follow_up');
    await page.getByRole('combobox', { name: 'Reply watch status', exact: true }).selectOption('draft_ready');
    const result = results(page).getByRole('link', { name: 'Open follow-up Renewal', exact: true }); await expect(result).toContainText('Open draft');
    await result.focus(); await result.press('Enter');
    const editor = page.getByRole('dialog', { name: 'Reply', exact: true }); await expect(editor).toBeVisible();
    await expect(editor.getByRole('textbox', { name: 'Body', exact: true })).toHaveValue('The owner already edited this draft.');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await watchDialog(page).getByRole('button', { name: 'Close', exact: true }).click(); await backToSearch(page, 'draft_ready');
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('Search includes reply history and Back returns from the verified received email to the same filtered result', async ({ page }) => {
  const f = await installMailFollowUpFixture(page, { verifyMessages: true });
  try {
    const watch = await f.service.start(f.request(), 'paired-owner'); f.add({ body_inline: 'The actual renewal reply found through Search.' }); await f.service.check(watch.id);
    await go(page, '#data/search'); await query(page).fill('Renewal');
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('follow_up');
    await page.getByRole('combobox', { name: 'Reply watch status', exact: true }).selectOption('replied');
    const result = results(page).getByRole('link', { name: 'Open follow-up Renewal', exact: true }); await expect(result).toContainText('Open reply'); await result.click();
    await expect(page).toHaveURL(/#data\/mail\/record\/work\/reply-1$/);
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toContainText('The actual renewal reply found through Search.');
    await backToSearch(page, 'replied'); expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});

test('Search finds watches by mailbox or status, retries failures, and refuses a stale draft link after a reply arrives', async ({ page }) => {
  const f = await installMailFollowUpFixture(page);
  try {
    const work = await f.service.start(f.request(), 'paired-owner');
    await f.service.start(f.request(work.check_at + 3600_000, 'personal'), 'paired-owner');
    f.due(work.check_at); await f.service.check(work.id); await go(page, '#data/search'); await query(page).fill('personal');
    await expect(results(page).locator('[data-search-follow-up-id]')).toHaveCount(2); await expect(results(page)).toContainText('personal'); await expect(results(page)).not.toContainText('Draft ready for review');
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('follow_up'); await query(page).fill('draft ready');
    await expect(results(page)).toContainText('Draft ready for review');
    f.failList(true); await results(page).getByRole('button', { name: 'Refresh reply watches', exact: true }).click();
    await expect(results(page).getByRole('alert')).toContainText('temporarily unavailable');
    f.failList(false); await results(page).getByRole('button', { name: 'Retry watch search', exact: true }).click();
    await expect(results(page).getByRole('alert')).toHaveCount(0);
    f.add(); await f.service.check(work.id);
    await results(page).getByRole('link', { name: 'Open follow-up Renewal', exact: true }).click();
    await expect(watchDialog(page).getByRole('status')).toHaveText('Reply received');
    await expect(page.getByRole('dialog', { name: 'Reply', exact: true })).toHaveCount(0);
    expect(f.calls.filter(call => call.method === 'execute')).toEqual([]);
  } finally { f.dispose(); }
});
