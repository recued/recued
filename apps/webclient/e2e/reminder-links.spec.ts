import { expect, test, type Page } from '@playwright/test';
import { reminderDetailLink } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installReminderWorkspaceFixture, REMINDER_WORKSPACE_NOW } from './helpers/reminder-workspace-fixture.js';

installFullAppHooks();
test.use({ timezoneId: 'Asia/Tokyo' });
const host = (page: Page) => page.locator('[data-recued-reminders]');
const detail = (page: Page) => host(page).locator('.reminders-detail');
const boot = async (page: Page, hash: string) => {
  await page.goto(`${HARNESS_URL}?journey=verification${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const notify = async (page: Page, link_url: string, cursor: number) => {
  await page.evaluate(({ link_url, cursor }) => window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'notification.notify', title: 'Reminder', text: 'A reminder rang.', link_url, cursor,
  } }), { link_url, cursor });
  const link = page.locator(`[data-recued-notify-toast] a[href="${link_url}"]`).first();
  await expect(link).toHaveAttribute('href', link_url);
  await link.click();
};

test('a notification opens its exact reminder beyond history pages, and Back preserves filters and loaded reminders', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));
  const fixture = await installReminderWorkspaceFixture(page, true);
  try {
    const id = fixture.seed({ text: 'Collect the pharmacy order', at: REMINDER_WORKSPACE_NOW - 3_600_000, state: 'delivered', finishedAt: REMINDER_WORKSPACE_NOW - 60_000 });
    for (let index = 0; index < 60; index++) fixture.seed({ text: 'Other delivered reminder ' + index, state: 'delivered' });
    for (let index = 0; index < 110; index++) fixture.seed({ text: 'Follow up ' + index, at: REMINDER_WORKSPACE_NOW + 3_600_000 + index * 60_000 });
    await boot(page, '#data/reminder');
    const items = host(page).getByRole('list', { name: 'Reminders still to ring' }).getByRole('listitem');
    await expect(items).toHaveCount(50);
    const query = host(page).getByRole('searchbox', { name: 'Search reminders', exact: true });
    await query.fill('Follow up'); await query.press('Enter');
    await host(page).getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(items).toHaveCount(100);
    await notify(page, reminderDetailLink(id), 100);
    await expect(detail(page)).toContainText('Collect the pharmacy order');
    await expect(detail(page)).toContainText('Rang');
    await expect(detail(page)).toContainText('America/New_York');
    await expect(detail(page).getByRole('button', { name: 'Remind again', exact: true })).toBeVisible();
    await expect(detail(page).getByRole('button', { name: 'Edit reminder', exact: true })).toHaveCount(0);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('reminder-detail-desktop.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('reminder-detail-desktop-dark.png') });
    await page.goBack();
    await expect(page).toHaveURL(/#data\/reminder$/);
    await expect(query).toHaveValue('Follow up');
    await expect(items).toHaveCount(100);
    await page.goForward();
    await expect(detail(page)).toContainText('Collect the pharmacy order');
    await notify(page, '#data/reminder', 101);
    await expect(query).toHaveValue('Follow up');
    await expect(items).toHaveCount(100);
    expect(fixture.detailReads).toContain(id);
  } finally { fixture.dispose(); }
});

test('a direct pending reminder can be edited and cancelled, keeping a confirmed edit when its refresh fails', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));
  const fixture = await installReminderWorkspaceFixture(page, true);
  try {
    const at = Date.parse('2030-11-03T06:30:12.345Z');
    const id = fixture.seed({ text: 'Call the dentist', at });
    await boot(page, reminderDetailLink(id));
    await expect(detail(page)).toContainText('Call the dentist');
    await expect(detail(page)).toContainText('Waiting to ring');
    await detail(page).getByRole('button', { name: 'Edit reminder', exact: true }).click();
    const text = detail(page).getByRole('textbox', { name: 'Reminder', exact: true });
    await text.fill('Call Dr Patel about the invoice');
    await host(page).getByRole('button', { name: 'Back to reminders', exact: true }).click();
    await expect(text).toHaveValue('Call Dr Patel about the invoice');
    await expect(host(page)).toContainText('Save or discard your reminder changes');
    fixture.failNextDetailRead();
    await detail(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(host(page).getByRole('alert')).toContainText('detail read was interrupted');
    await expect(detail(page)).toContainText('Call Dr Patel about the invoice');
    await expect(detail(page)).toContainText('America/New_York');
    expect(fixture.get(id)).toMatchObject({ text: 'Call Dr Patel about the invoice', at });
    await host(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(host(page).getByRole('alert')).toHaveCount(0);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('reminder-detail-mobile.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('reminder-detail-mobile-dark.png') });
    await detail(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await detail(page).getByRole('button', { name: 'Cancel it', exact: true }).click();
    await expect(detail(page)).toContainText('Cancelled');
    await expect(detail(page).getByRole('button', { name: 'Remind again', exact: true })).toBeVisible();
    expect(fixture.get(id)?.state).toBe('cancelled');
    await host(page).getByRole('button', { name: 'Back to reminders', exact: true }).click();
    await expect(page).toHaveURL(/#data\/reminder$/);
    await expect(host(page)).toContainText('No reminders waiting');
  } finally { fixture.dispose(); }
});

test('explains missing history, retries failed reads, and ignores an old item reply after navigating to a managed reminder', async ({ page }) => {
  const fixture = await installReminderWorkspaceFixture(page, true);
  try {
    const older = fixture.seed({ text: 'Stale reminder' });
    const managed = fixture.seed({ text: 'Annual boiler inspection', managed: true });
    await boot(page, '#data/reminder/rem-missing');
    await expect(host(page)).toContainText('30-day history has expired');
    fixture.failNextDetailRead();
    await page.evaluate(hash => window.__app.setHash(hash), reminderDetailLink(older));
    await expect(host(page).getByRole('alert')).toContainText('detail read was interrupted');
    await expect(detail(page)).toHaveCount(0);
    fixture.holdNextDetailRead(older);
    await host(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.poll(() => fixture.detailReadPending()).toBe(true);
    await page.evaluate(hash => window.__app.setHash(hash), reminderDetailLink(managed));
    await expect(detail(page)).toContainText('Annual boiler inspection');
    fixture.releaseDetailRead();
    await expect(detail(page).getByRole('link', { name: 'Manage in Yours', exact: true })).toHaveAttribute('href', '#yours');
    await expect(detail(page)).not.toContainText('Stale reminder');
    await expect(detail(page).getByRole('button')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(reminderDetailLink(managed) + '$'));
  } finally { fixture.dispose(); }
});


test('Back from a reminder that rang reconciles its retained list row and keeps focus on the search', async ({ page }) => {
  await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));
  const fixture = await installReminderWorkspaceFixture(page, true);
  try {
    const id = fixture.seed({ text: 'Collect the lab results', at: REMINDER_WORKSPACE_NOW - 60_000 });
    await boot(page, '#data/reminder');
    const items = host(page).getByRole('list', { name: 'Reminders still to ring' }).getByRole('listitem');
    await expect(items).toHaveCount(1);
    expect(fixture.deliver(id)).toBe(true);
    await page.evaluate(hash => window.__app.setHash(hash), reminderDetailLink(id));
    await expect(detail(page)).toContainText('Rang');
    await host(page).getByRole('button', { name: 'Back to reminders', exact: true }).click();
    await expect(host(page)).toContainText('No reminders waiting');
    await expect(host(page).getByRole('searchbox', { name: 'Search reminders', exact: true })).toBeFocused();
    await expect(items).toHaveCount(0);
  } finally { fixture.dispose(); }
});

test.describe('remind again', () => {
  const form = (page: Page) => host(page).locator('[data-reminder-create-form]');
  const message = (page: Page) => form(page).getByRole('textbox', { name: 'Reminder', exact: true });
  const time = (page: Page) => form(page).getByLabel('Date and time (America/New_York)', { exact: true });
  const history = (page: Page) => host(page).locator('.reminders-history');
  const historyRow = (page: Page, id: string) => history(page).locator(`.reminders-row[data-reminder-id="${id}"]`);
  const again = (page: Page, id: string) => historyRow(page, id).getByRole('button', { name: 'Remind again', exact: true });
  const showHistory = async (page: Page) => { await history(page).locator('summary').click(); };

  test('copies terminal wording into a fresh declared-clock reminder, preserving history and clearing the next normal draft', async ({ page }, info) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));
    const f = await installReminderWorkspaceFixture(page, true);
    try {
      const original = f.seed({ text: 'Collect <paperwork> & call the office', at: REMINDER_WORKSPACE_NOW - 3_600_000, state: 'delivered', timeZone: 'Asia/Tokyo' });
      const cancelled = f.seed({ text: 'Bring the revised documents', state: 'cancelled' });
      f.seed({ text: 'Managed clock delivery', state: 'delivered', managed: true });
      f.seed({ text: 'Managed clock cancellation', state: 'cancelled', managed: true });
      f.seed({ text: 'Still waiting' });
      const before = f.get(original), beforeCancelled = f.get(cancelled), count = f.pendingCount();
      await boot(page, '#data/reminder'); await showHistory(page);
      await expect(history(page).getByRole('button', { name: 'Remind again', exact: true })).toHaveCount(2);
      await again(page, original).click();
      await expect(message(page)).toHaveValue(before!.text); await expect(message(page)).toBeFocused();
      await expect(form(page).getByRole('heading', { name: 'Remind again', exact: true })).toBeVisible();
      await expect(form(page)).toContainText('The original stays in history');
      await expect(time(page)).toHaveValue('2026-11-01T11:00'); expect(f.creates).toEqual([]);
      await time(page).fill('2026-11-02T09:30');
      await form(page).screenshot({ path: info.outputPath('remind-again-desktop.png') });
      await form(page).getByRole('button', { name: 'Set reminder', exact: true }).press('Enter'); await expect(form(page)).toHaveCount(0);
      await expect(host(page).getByRole('list', { name: 'Reminders still to ring' }).getByRole('listitem')).toHaveCount(count + 1);
      expect(f.creates).toHaveLength(1); expect(f.creates[0]).toMatchObject({ text: before!.text, at: Date.parse('2026-11-02T14:30:00Z') });
      expect(f.createdId()).not.toBe(original); expect(f.get(f.createdId()!)).toMatchObject({ state: 'pending', time_zone: 'America/New_York' });
      expect(f.get(original)).toEqual(before); await expect(historyRow(page, original)).toContainText('Rang');
      await again(page, cancelled).click(); await expect(message(page)).toHaveValue(beforeCancelled!.text);
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(again(page, cancelled)).toBeFocused();
      expect(f.get(cancelled)).toEqual(beforeCancelled); expect(f.creates).toHaveLength(1);
      await host(page).getByRole('button', { name: 'New reminder', exact: true }).click(); await expect(message(page)).toHaveValue('');
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    } finally { f.dispose(); }
  });

  test('reuses an addressed reminder outside the history page and returns Cancel to the same detail action', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));
    const f = await installReminderWorkspaceFixture(page, true);
    try {
      const id = f.seed({ text: 'Collect the archived documents', state: 'cancelled', timeZone: 'Pacific/Auckland', finishedAt: REMINDER_WORKSPACE_NOW - 120_000 });
      const before = f.get(id);
      for (let index = 0; index < 60; index++) f.seed({ text: 'Other completed reminder ' + index, state: 'delivered' });
      await boot(page, reminderDetailLink(id)); await detail(page).getByRole('button', { name: 'Remind again', exact: true }).click();
      await expect(message(page)).toHaveValue(before!.text); await expect(message(page)).toBeFocused();
      await form(page).screenshot({ path: info.outputPath('remind-again-phone.png') });
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(detail(page).getByRole('button', { name: 'Remind again', exact: true })).toBeFocused(); expect(f.creates).toEqual([]);
      await detail(page).getByRole('button', { name: 'Remind again', exact: true }).click();
      await message(page).fill('Collect the documents and the new receipt'); await time(page).fill('2026-11-02T09:30');
      await form(page).getByRole('button', { name: 'Set reminder', exact: true }).click(); await expect(form(page)).toHaveCount(0);
      await expect(detail(page)).toContainText(before!.text); await expect(detail(page)).toContainText('Cancelled');
      await expect(page).toHaveURL(new RegExp(reminderDetailLink(id) + '$')); expect(f.get(id)).toEqual(before);
      expect(f.pendingCount()).toBe(1); expect(f.creates).toHaveLength(1);
      expect(f.get(f.createdId()!)).toMatchObject({ text: 'Collect the documents and the new receipt', time_zone: 'America/New_York', state: 'pending' });
      await host(page).getByRole('button', { name: 'Back to reminders', exact: true }).click();
      await expect(host(page).getByRole('list', { name: 'Reminders still to ring' })).toContainText('Collect the documents and the new receipt');
    } finally { f.dispose(); }
  });

  test('preserves an existing draft and retires a late reuse lookup when a new draft is explicitly opened', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW)); const f = await installReminderWorkspaceFixture(page, true);
    try {
      const id = f.seed({ text: 'Old completed wording', state: 'delivered' });
      await boot(page, '#data/reminder'); await showHistory(page);
      await host(page).getByRole('button', { name: 'New reminder', exact: true }).click(); await message(page).fill('Keep my existing draft');
      await again(page, id).click(); await expect(message(page)).toHaveValue('Keep my existing draft'); await expect(message(page)).toBeFocused();
      expect(f.detailReads).toEqual([]); expect(f.creates).toEqual([]);
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      f.holdNextDetailRead(id); await again(page, id).click(); await expect.poll(f.detailReadPending).toBe(true);
      await host(page).getByRole('button', { name: 'New reminder', exact: true }).click(); await expect(message(page)).toHaveValue('');
      await message(page).fill('A newer draft owns the form'); f.releaseDetailRead();
      await expect.poll(() => f.detailReplies.filter(reply => reply === id).length).toBe(1);
      await expect(message(page)).toHaveValue('A newer draft owns the form'); expect(f.creates).toEqual([]);
    } finally { f.dispose(); }
  });

  test('recovers a failed fresh lookup without creating a reminder or copying an unconfirmed record', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW)); const f = await installReminderWorkspaceFixture(page, true);
    try {
      const id = f.seed({ text: 'Call after the results arrive', state: 'delivered' });
      await boot(page, '#data/reminder'); await showHistory(page); f.failNextDetailRead(); await again(page, id).click();
      await expect(host(page)).toContainText('detail read was interrupted'); await expect(form(page)).toHaveCount(0); expect(f.creates).toEqual([]);
      await again(page, id).click(); await expect(message(page)).toHaveValue('Call after the results arrive');
      expect(f.detailReads).toEqual([id, id]); expect(f.creates).toEqual([]);
    } finally { f.dispose(); }
  });

  test('locks the original request after a lost creation, checks it after it rang, and keeps the original history', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW)); const f = await installReminderWorkspaceFixture(page, true);
    try {
      const id = f.seed({ text: 'Call the clinic again', state: 'delivered' }), before = f.get(id);
      await boot(page, '#data/reminder'); await showHistory(page); await again(page, id).click(); await expect(message(page)).toHaveValue(before!.text);
      await time(page).fill('2026-11-01T10:02'); f.loseNextCreate();
      await form(page).getByRole('button', { name: 'Set reminder', exact: true }).click(); await expect(form(page).getByRole('alert')).toBeVisible();
      expect(f.pendingCount()).toBe(1); const created = f.createdId()!, later = REMINDER_WORKSPACE_NOW + 180_000;
      f.setNow(later); await page.clock.setFixedTime(new Date(later)); expect(f.deliver(created)).toBe(true);
      await expect(message(page)).toBeDisabled(); await expect(time(page)).toBeDisabled();
      await expect(message(page)).toHaveValue(before!.text); await expect(time(page)).toHaveValue('2026-11-01T10:02');
      await form(page).getByRole('button', { name: 'Check save', exact: true }).click(); await expect(form(page)).toHaveCount(0);
      await expect(host(page)).toContainText('not been scheduled again'); expect(f.pendingCount()).toBe(0); expect(f.creates).toHaveLength(2);
      expect(f.creates[1]).toEqual(f.creates[0]); expect(new Set(f.creates.map(request => request.creation_id)).size).toBe(1);
      expect(f.get(id)).toEqual(before); expect(f.get(created)).toMatchObject({ state: 'delivered', text: before!.text });
      await expect(historyRow(page, id)).toContainText('Rang'); await expect(historyRow(page, created)).toContainText('Rang');
    } finally { f.dispose(); }
  });

  test('rejects a new past time, submits only once while busy, and preserves outside focus and quiet-hours confirmation', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW)); const f = await installReminderWorkspaceFixture(page, true);
    try {
      const id = f.seed({ text: 'Follow up after dinner', state: 'delivered' }), before = f.get(id);
      await boot(page, reminderDetailLink(id)); await detail(page).getByRole('button', { name: 'Remind again', exact: true }).click();
      await expect(message(page)).toHaveValue(before!.text); await time(page).fill('2026-11-01T09:00');
      await form(page).getByRole('button', { name: 'Set reminder', exact: true }).click();
      await expect(form(page).getByRole('alert')).toContainText('valid future date'); expect(f.creates).toEqual([]);
      await time(page).fill('2026-11-01T23:00'); f.holdNextCreate();
      await form(page).getByRole('button', { name: 'Set reminder', exact: true }).click(); await expect.poll(f.createPending).toBe(true);
      await expect(message(page)).toBeDisabled(); await expect(time(page)).toBeDisabled();
      await form(page).evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); expect(f.creates).toHaveLength(1);
      await host(page).getByRole('button', { name: 'Back to reminders', exact: true }).click();
      await expect(detail(page)).toBeVisible(); await expect(host(page)).toContainText('still being saved');
      const refresh = host(page).getByRole('button', { name: 'Refresh', exact: true }); await refresh.focus(); f.releaseCreate();
      await expect(form(page)).toHaveCount(0); await expect(refresh).toBeFocused(); await expect(host(page)).toContainText('quiet hours');
      expect(f.creates).toHaveLength(1); expect(f.pendingCount()).toBe(1); expect(f.get(id)).toEqual(before);
    } finally { f.dispose(); }
  });

  test('retires a detail reuse lookup on Back before another reminder opens', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW)); const f = await installReminderWorkspaceFixture(page, true);
    try {
      const first = f.seed({ text: 'Earlier finished reminder', state: 'delivered' }), second = f.seed({ text: 'Newer finished reminder', state: 'cancelled' });
      await boot(page, reminderDetailLink(first)); await expect(detail(page)).toContainText('Earlier finished reminder');
      f.holdNextDetailRead(first); await detail(page).getByRole('button', { name: 'Remind again', exact: true }).click();
      await expect.poll(f.detailReadPending).toBe(true); await host(page).getByRole('button', { name: 'Back to reminders', exact: true }).click();
      await expect(detail(page)).toHaveCount(0); await page.evaluate(hash => window.__app.setHash(hash), reminderDetailLink(second));
      await expect(detail(page)).toContainText('Newer finished reminder'); f.releaseDetailRead();
      await expect.poll(() => f.detailReplies.filter(reply => reply === first).length).toBe(2);
      await expect(form(page)).toHaveCount(0); await expect(detail(page)).toContainText('Newer finished reminder');
      await detail(page).getByRole('button', { name: 'Remind again', exact: true }).click(); await expect(message(page)).toHaveValue('Newer finished reminder');
      expect(f.creates).toEqual([]);
    } finally { f.dispose(); }
  });

  test('keeps a typed filter and its focus when the fresh reuse lookup completes', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW)); const f = await installReminderWorkspaceFixture(page, true);
    try {
      const id = f.seed({ text: 'Keep this confirmed wording', state: 'delivered' });
      await boot(page, '#data/reminder'); await showHistory(page); f.holdNextDetailRead(id); await again(page, id).click();
      await expect.poll(f.detailReadPending).toBe(true);
      const query = host(page).getByRole('searchbox', { name: 'Search reminders', exact: true }); await query.fill('Keep my typed query'); f.releaseDetailRead();
      await expect(message(page)).toHaveValue('Keep this confirmed wording'); await expect(query).toHaveValue('Keep my typed query');
      await expect(query).toBeFocused(); expect(f.creates).toEqual([]);
    } finally { f.dispose(); }
  });
});

test.describe('shared reminder search', () => {
  const search = (page: Page) => page.locator('[data-recued-universal-search-input]');
  const group = (page: Page) => page.getByRole('region', { name: 'Reminder search results', exact: true });
  const hits = (page: Page) => group(page).locator('a[data-search-reminder-id]');
  const hit = (page: Page, id: string) => group(page).locator(`a[data-search-reminder-id="${id}"]`);
  const status = (page: Page) => group(page).getByRole('combobox', { name: 'Reminder status', exact: true });
  const resultType = (page: Page) => page.getByRole('combobox', { name: 'Result type', exact: true });
  const filters = (page: Page) => host(page).getByRole('form', { name: 'Find reminders', exact: true });
  const find = async (page: Page, query: string) => {
    await search(page).fill(query); await resultType(page).selectOption('reminder');
  };

  test('searches retained history past its first page and returns from an exact result with type, status, query and pages intact', async ({ page }, info) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW)); const f = await installReminderWorkspaceFixture(page, true);
    try {
      const q = 'clinicsearch', ids: string[] = [];
      for (let i = 0; i < 65; i++) ids.push(f.seed({ text: `${q} history ${i}`, state: 'delivered', at: REMINDER_WORKSPACE_NOW - 86_400_000 + i * 60_000, timeZone: 'Asia/Tokyo' }));
      f.seed({ text: q + ' waiting' }); f.seed({ text: q + ' cancelled', state: 'cancelled' });
      f.seed({ text: q + ' managed', state: 'delivered', managed: true, at: REMINDER_WORKSPACE_NOW - 2 * 86_400_000 });
      const expired = f.seed({ text: q + ' expired', state: 'delivered', finishedAt: REMINDER_WORKSPACE_NOW - 31 * 86_400_000 });
      await boot(page, '#data/search'); await find(page, q);
      await expect(group(page).locator('.rq-group-count')).toHaveText('50 of 68'); await expect(hit(page, expired)).toHaveCount(0);
      await status(page).focus(); await status(page).selectOption('delivered'); await expect(group(page).locator('.rq-group-count')).toHaveText('50 of 66');
      await expect(status(page)).toBeFocused();
      await page.screenshot({ path: info.outputPath('reminder-search-desktop.png') });
      await group(page).getByRole('button', { name: 'More reminders', exact: true }).click(); await expect(hits(page)).toHaveCount(66);
      const id = ids[64]!, before = f.get(id);
      await hit(page, id).click(); await expect(detail(page)).toContainText(before!.text); await expect(detail(page)).toContainText('Asia/Tokyo');
      await expect(page).toHaveURL(new RegExp(reminderDetailLink(id) + '$'));
      await expect(detail(page).getByRole('button', { name: 'Remind again', exact: true })).toBeVisible();
      await host(page).getByRole('button', { name: 'Back to search', exact: true }).click();
      await expect(search(page)).toHaveValue(q); await expect(resultType(page)).toHaveValue('reminder'); await expect(status(page)).toHaveValue('delivered');
      await expect(hits(page)).toHaveCount(66); await expect(hit(page, id)).toBeFocused();
      expect(f.get(id)).toEqual(before); expect(f.creates).toEqual([]);
      await hit(page, id).click(); await expect(detail(page)).toContainText(before!.text); await page.goBack();
      await expect(search(page)).toHaveValue(q); await expect(status(page)).toHaveValue('delivered');
      await expect(hits(page)).toHaveCount(66); await expect(hit(page, id)).toBeFocused();
    } finally { f.dispose(); }
  });

  test('uses the same complete history search in Reminders on a phone and preserves its draft and list return', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));
    const f = await installReminderWorkspaceFixture(page, true);
    try {
      const q = 'phoneclinic', ids: string[] = [];
      for (let i = 0; i < 64; i++) ids.push(f.seed({ text: `${q} completed ${i}`, state: 'delivered', at: REMINDER_WORKSPACE_NOW - 86_400_000 + i * 60_000 }));
      f.seed({ text: q + ' waiting' }); f.seed({ text: 'Unrelated old reminder', state: 'delivered' });
      await boot(page, '#data/reminder'); await filters(page).getByRole('searchbox', { name: 'Search reminders', exact: true }).fill(q);
      await filters(page).getByRole('combobox', { name: 'Status', exact: true }).selectOption('delivered');
      await filters(page).getByRole('button', { name: 'Apply filters', exact: true }).click();
      const rows = host(page).getByRole('list', { name: 'Matching reminders', exact: true }).getByRole('listitem');
      await expect(rows).toHaveCount(50); await host(page).getByRole('button', { name: 'Load more', exact: true }).click(); await expect(rows).toHaveCount(64);
      await filters(page).screenshot({ path: info.outputPath('reminder-history-filters-phone.png') });
      const id = ids[63]!, before = f.get(id), selected = host(page).locator(`.reminders-row[data-reminder-id="${id}"]`);
      await selected.getByRole('button', { name: 'Open reminder', exact: true }).click(); await expect(detail(page)).toContainText(before!.text);
      await detail(page).getByRole('button', { name: 'Remind again', exact: true }).click();
      const form = host(page).locator('[data-reminder-create-form]'); await expect(form.getByRole('textbox', { name: 'Reminder', exact: true })).toHaveValue(before!.text);
      await host(page).getByRole('button', { name: 'Back to reminders', exact: true }).click(); await expect(form).toBeVisible();
      await expect(host(page)).toContainText('Save or discard your reminder changes');
      await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await host(page).getByRole('button', { name: 'Back to reminders', exact: true }).click();
      await expect(rows).toHaveCount(64); await expect(filters(page).getByRole('searchbox')).toHaveValue(q);
      await expect(filters(page).getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('delivered'); await expect(selected).toBeFocused();
      expect(f.get(id)).toEqual(before); expect(f.creates).toEqual([]);
    } finally { f.dispose(); }
  });

  test('opens the fresh exact state and rechecks the retained search when a waiting reminder rang', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW)); const f = await installReminderWorkspaceFixture(page, true);
    try {
      const q = 'justclinic', id = f.seed({ text: q + ' waiting' });
      await boot(page, '#data/search'); await find(page, q); await status(page).selectOption('pending'); await expect(hit(page, id)).toBeVisible();
      await expect(group(page)).toHaveAttribute('aria-busy', 'false');
      expect(f.deliver(id)).toBe(true); await hit(page, id).click();
      await expect(detail(page)).toContainText('Rang'); await expect(detail(page).getByRole('button', { name: 'Edit reminder', exact: true })).toHaveCount(0);
      await expect(detail(page).getByRole('button', { name: 'Remind again', exact: true })).toBeVisible();
      await host(page).getByRole('button', { name: 'Back to search', exact: true }).click();
      await expect(search(page)).toHaveValue(q); await expect(status(page)).toHaveValue('pending'); await expect(group(page).locator('.rq-group-count')).toHaveText('0 of 0');
      await expect(hits(page)).toHaveCount(0); await expect(group(page)).toContainText('No reminders match this search'); expect(f.creates).toEqual([]);
    } finally { f.dispose(); }
  });

  test('ignores an old all-status answer after the owner selects cancellations', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW)); const f = await installReminderWorkspaceFixture(page, true);
    try {
      const q = 'slowclinic', cancelled = f.seed({ text: q + ' cancellation', state: 'cancelled' }), waiting = f.seed({ text: q + ' waiting' });
      f.holdNextQuery(q); await boot(page, '#data/search'); await find(page, q); await expect.poll(f.readPending).toBe(true);
      await status(page).selectOption('cancelled'); await expect(hit(page, cancelled)).toBeVisible(); await expect(hit(page, waiting)).toHaveCount(0);
      f.releaseRead(); await expect.poll(() => f.readReplies.filter(reply => reply.page?.query === q && reply.page.state === 'all').length).toBe(1);
      await expect(status(page)).toHaveValue('cancelled'); await expect(hits(page)).toHaveCount(1); await expect(hit(page, waiting)).toHaveCount(0);
    } finally { f.dispose(); }
  });

  test('keeps loaded matches after a failed page and retries one stable cursor without stealing newer focus', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW)); const f = await installReminderWorkspaceFixture(page, true);
    try {
      const q = 'retryclinic';
      for (let i = 0; i < 61; i++) f.seed({ text: `${q} ${i}`, state: 'delivered', at: REMINDER_WORKSPACE_NOW - 86_400_000 + i * 60_000 });
      await boot(page, '#data/search'); await find(page, q); await expect(hits(page)).toHaveCount(50);
      f.failNextRead(); await group(page).getByRole('button', { name: 'More reminders', exact: true }).click();
      await expect(group(page).getByRole('alert')).toContainText('interrupted'); await expect(hits(page)).toHaveCount(50);
      const failed = f.reads.at(-1)!; f.holdNextQuery(q); await group(page).getByRole('button', { name: 'Retry reminder search', exact: true }).click();
      await expect.poll(f.readPending).toBe(true); const reads = f.reads.length;
      await group(page).locator('[data-recued-data-action="universal-search-more-reminders"]').evaluate(node => (node as HTMLElement).click());
      expect(f.reads).toHaveLength(reads); expect(f.reads.at(-1)!.page?.cursor).toEqual(failed.page?.cursor);
      await status(page).focus(); f.releaseRead(); await expect(hits(page)).toHaveCount(61); await expect(status(page)).toBeFocused();
      await expect(group(page).getByRole('alert')).toHaveCount(0);
    } finally { f.dispose(); }
  });

  test('reports an older server without pretending history was searched and keeps legacy waiting search usable', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW)); const f = await installReminderWorkspaceFixture(page, true);
    try {
      const q = 'legacyclinic'; f.seed({ text: q + ' waiting' }); f.setLegacySearch(true);
      await boot(page, '#data/search'); await find(page, q); await expect(group(page)).toContainText('Update your Recued server');
      await expect(group(page)).not.toContainText('No reminders match');
      await page.evaluate(() => window.__app.setHash('#data/reminder')); await expect(host(page)).toBeVisible();
      await filters(page).getByRole('searchbox').fill(q); await filters(page).getByRole('button', { name: 'Apply filters', exact: true }).click();
      await expect(host(page).getByRole('list', { name: 'Reminders still to ring' })).toContainText(q);
      await filters(page).getByRole('combobox', { name: 'Status', exact: true }).selectOption('delivered'); await filters(page).getByRole('button', { name: 'Apply filters', exact: true }).click();
      await expect(host(page).getByRole('alert')).toContainText('Update your Recued server');
      await filters(page).getByRole('combobox', { name: 'Status', exact: true }).selectOption('pending'); await filters(page).getByRole('button', { name: 'Apply filters', exact: true }).click();
      await expect(host(page).getByRole('alert')).toHaveCount(0); await expect(host(page).getByRole('list', { name: 'Reminders still to ring' })).toContainText(q);
    } finally { f.dispose(); }
  });

  test('saves a reminder status view and returns to that view after opening its exact reminder', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW)); const f = await installReminderWorkspaceFixture(page, true);
    try {
      const q = 'savedclinic'; f.seed({ text: q + ' cancellation', state: 'cancelled' });
      const id = f.seed({ text: q + ' waiting' });
      await boot(page, '#data/search'); await find(page, q); await status(page).selectOption('cancelled'); await expect(hits(page)).toHaveCount(1);
      const tools = page.locator('[data-saved-data-views]'); await tools.getByRole('button', { name: 'Save current view', exact: true }).click();
      await tools.getByLabel('View name', { exact: true }).fill('Cancelled clinic reminders'); await tools.getByRole('button', { name: 'Save view', exact: true }).click();
      await expect(tools.locator('[data-view-notice]')).toContainText('Saved');
      const views = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-saved-data-views') ?? '[]') as { id: string; definition: unknown }[]);
      expect(views.at(-1)!.definition).toEqual({ tab: 'search', query: q, result_type: 'reminder', reminder_state: 'cancelled' });
      const hash = '#views/' + views.at(-1)!.id; await page.evaluate(hash => window.__app.setHash(hash), hash);
      await expect(status(page)).toHaveValue('cancelled'); await expect(hits(page)).toHaveCount(1); await expect(resultType(page)).toHaveValue('reminder');
      await status(page).selectOption('pending'); await expect(hit(page, id)).toBeVisible();
      await tools.getByRole('button', { name: 'Update view', exact: true }).click();
      await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-saved-data-views') ?? '[]')[0]?.definition.reminder_state)).toBe('pending');
      await hit(page, id).click(); await expect(detail(page)).toContainText('Waiting to ring'); await host(page).getByRole('button', { name: 'Back to search', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(hash + '$')); await expect(status(page)).toHaveValue('pending'); await expect(hit(page, id)).toBeFocused();
    } finally { f.dispose(); }
  });
});

test.describe('reminder date filters in universal search', () => {
  const group = (page: Page) => page.getByRole('region', { name: 'Reminder search results', exact: true });
  const dates = (page: Page) => group(page).getByRole('form', { name: 'Filter reminder dates', exact: true });
  const range = (page: Page) => dates(page).getByRole('combobox', { name: 'Reminder dates', exact: true });
  const apply = (page: Page) => dates(page).getByRole('button', { name: 'Apply reminder dates', exact: true });
  const query = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
  const type = (page: Page) => page.getByRole('combobox', { name: 'Result type', exact: true });
  const status = (page: Page) => group(page).getByRole('combobox', { name: 'Reminder status', exact: true });
  const hits = (page: Page) => group(page).locator('[data-search-reminder-id]');
  const hit = (page: Page, id: string) => group(page).locator(`[data-search-reminder-id="${id}"]`);
  const find = async (page: Page, text: string) => { await boot(page, '#data/search');if (text) await query(page).fill(text);await type(page).selectOption('reminder'); };

  test('uses the declared filter clock for Today and seven calendar dates across the repeated hour', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));const f = await installReminderWorkspaceFixture(page, true);
    try {
      const first = f.seed({ text: 'dateclinic first', at: Date.parse('2026-11-01T04:00Z'), timeZone: 'Asia/Tokyo' });
      const last = f.seed({ text: 'dateclinic last', at: Date.parse('2026-11-02T04:59:59.999Z') });
      const tomorrow = f.seed({ text: 'dateclinic tomorrow', at: Date.parse('2026-11-02T05:00Z') });
      const seventh = f.seed({ text: 'dateclinic seventh', at: Date.parse('2026-11-08T04:59:59.999Z') });
      const outside = f.seed({ text: 'dateclinic outside', at: Date.parse('2026-11-08T05:00Z') });
      f.seed({ text: 'dateclinic previous', at: Date.parse('2026-11-01T03:59:59.999Z') });
      await find(page, 'dateclinic');await range(page).selectOption('today');await apply(page).click();await expect(hits(page)).toHaveCount(2);await expect(hit(page, first)).toBeVisible();await expect(hit(page, last)).toBeVisible();await expect(hit(page, tomorrow)).toHaveCount(0);await expect(dates(page)).toContainText('America/New_York');
      expect(f.reads.at(-1)!.page).toMatchObject({ from: Date.parse('2026-11-01T04:00Z'), before: Date.parse('2026-11-02T05:00Z') });
      await range(page).selectOption('week');await apply(page).click();await expect(hits(page)).toHaveCount(4);await expect(hit(page, seventh)).toBeVisible();await expect(hit(page, outside)).toHaveCount(0);await expect(dates(page)).toContainText('2026-11-01 through 2026-11-07');expect(f.creates).toEqual([]);expect(f.triageWrites).toEqual([]);
    } finally { f.dispose(); }
  });

  test('keeps custom dates, status, pages and exact keyboard focus when returning from a reminder', async ({ page }, info) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));const f = await installReminderWorkspaceFixture(page, true);
    try {
      const ids: string[] = [];for (let i = 0; i < 61; i++)ids.push(f.seed({ text: 'pageclinic ' + i, at: Date.parse('2026-11-01T04:00Z') + i * 60000 }));
      f.seed({ text: 'pageclinic outside', at: Date.parse('2026-11-02T05:00Z') });await find(page, 'pageclinic');await status(page).selectOption('pending');await range(page).selectOption('custom');await dates(page).getByLabel('From', { exact: true }).fill('2026-11-01');await dates(page).getByLabel('Through', { exact: true }).fill('2026-11-01');await apply(page).click();
      await expect(group(page).locator('.rq-group-count')).toHaveText('50 of 61');await group(page).getByRole('button', { name: 'More reminders', exact: true }).click();await expect(hits(page)).toHaveCount(61);const id = ids[60]!;await hit(page, id).focus();await page.keyboard.press('Enter');await expect(detail(page)).toContainText('pageclinic 60');await host(page).getByRole('button', { name: 'Back to search', exact: true }).click();
      await expect(hit(page, id)).toBeFocused();await expect(hits(page)).toHaveCount(61);await expect(query(page)).toHaveValue('pageclinic');await expect(status(page)).toHaveValue('pending');await expect(range(page)).toHaveValue('custom');await expect(dates(page).getByLabel('From', { exact: true })).toHaveValue('2026-11-01');await expect(dates(page).getByLabel('Through', { exact: true })).toHaveValue('2026-11-01');
      for (const request of f.reads.filter(read => read.page?.cursor && read.page.query === 'pageclinic'))expect(request.page).toMatchObject({ from: Date.parse('2026-11-01T04:00Z'), before: Date.parse('2026-11-02T05:00Z') });
      await page.setViewportSize({ width: 390, height: 844 });await dates(page).screenshot({ path: info.outputPath('reminder-search-dates-phone.png'), animations: 'disabled' });expect(f.creates).toEqual([]);
    } finally { f.dispose(); }
  });

  test('an unapplied invalid custom range leaves the confirmed results and saved settings unchanged', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));const f = await installReminderWorkspaceFixture(page, true);
    try {
      const today = f.seed({ text: 'invalidclinic today', at: REMINDER_WORKSPACE_NOW }), tomorrow = f.seed({ text: 'invalidclinic tomorrow', at: REMINDER_WORKSPACE_NOW + 86400000 });await find(page, 'invalidclinic');await range(page).selectOption('today');await apply(page).click();await expect(hits(page)).toHaveCount(1);const reads = f.reads.length;
      await range(page).selectOption('custom');await dates(page).getByLabel('From', { exact: true }).fill('2026-11-03');await dates(page).getByLabel('Through', { exact: true }).fill('2026-11-02');await apply(page).click();await expect(dates(page).getByRole('alert')).toBeFocused();await expect(hit(page, today)).toBeVisible();expect(f.reads).toHaveLength(reads);await expect(dates(page)).toContainText('Applied dates: 2026-11-01 through 2026-11-01');
      await dates(page).getByLabel('From', { exact: true }).fill('2026-11-02');await apply(page).click();await expect(hit(page, tomorrow)).toBeVisible();await expect(hit(page, today)).toHaveCount(0);await expect(dates(page).getByRole('alert')).toHaveCount(0);
      await dates(page).getByRole('button', { name: 'Clear reminder dates', exact: true }).click();await expect(hits(page)).toHaveCount(2);await expect(range(page)).toHaveValue('all');await expect(range(page)).toBeFocused();expect(f.creates).toEqual([]);
    } finally { f.dispose(); }
  });

  test('a previous window cannot replace newer date-filtered results', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));const f = await installReminderWorkspaceFixture(page, true);
    try {
      const today = f.seed({ text: 'slowdateclinic today', at: REMINDER_WORKSPACE_NOW }), tomorrow = f.seed({ text: 'slowdateclinic tomorrow', at: REMINDER_WORKSPACE_NOW + 86400000 });f.holdNextQuery('slowdateclinic');await find(page, 'slowdateclinic');await expect.poll(f.readPending).toBe(true);await range(page).selectOption('today');await apply(page).click();await expect(hit(page, today)).toBeVisible();await expect(hit(page, tomorrow)).toHaveCount(0);f.releaseRead();
      await expect.poll(() => f.readReplies.filter(read => read.page?.query === 'slowdateclinic').length).toBe(2);await expect(hits(page)).toHaveCount(1);await expect(range(page)).toHaveValue('today');await expect(hit(page, tomorrow)).toHaveCount(0);
    } finally { f.dispose(); }
  });

  test('a saved Today view with no query reopens on the new day and updates through existing Saved Views', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));const f = await installReminderWorkspaceFixture(page, true);
    try {
      const today = f.seed({ text: 'Today reminder', at: REMINDER_WORKSPACE_NOW }), tomorrow = f.seed({ text: 'Tomorrow reminder', at: REMINDER_WORKSPACE_NOW + 86400000 });await find(page, '');await status(page).selectOption('pending');await range(page).selectOption('today');await apply(page).click();await expect(hit(page, today)).toBeVisible();await expect(hit(page, tomorrow)).toHaveCount(0);
      const tools = page.locator('[data-saved-data-views]');await tools.getByRole('button', { name: 'Save current view', exact: true }).click();await tools.getByLabel('View name', { exact: true }).fill('Today reminders');await tools.getByRole('button', { name: 'Save view', exact: true }).click();await expect(tools.locator('[data-view-notice]')).toContainText('Saved');
      const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-saved-data-views') ?? '[]').at(-1));expect(saved.definition).toEqual({ tab: 'search', query: '', result_type: 'reminder', reminder_state: 'pending', reminder_dates: { range: 'today', time_zone: 'America/New_York' } });
      f.setNow(REMINDER_WORKSPACE_NOW + 86400000);await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW + 86400000));await page.evaluate(hash => window.__app.setHash(hash), '#views/' + saved.id);await expect(range(page)).toHaveValue('today');await expect(hit(page, tomorrow)).toBeVisible();await expect(hit(page, today)).toHaveCount(0);await expect(dates(page)).toContainText('2026-11-02 through 2026-11-02');
      await range(page).selectOption('week');await apply(page).click();await tools.getByRole('button', { name: 'Update view', exact: true }).click();await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-saved-data-views') ?? '[]').at(-1)?.definition.reminder_dates.range)).toBe('week');expect(f.creates).toEqual([]);
    } finally { f.dispose(); }
  });

  test('a late list reply preserves an unfinished custom date and its focus', async ({ page }) => {
    await page.clock.setFixedTime(new Date(REMINDER_WORKSPACE_NOW));const f = await installReminderWorkspaceFixture(page, true);
    try {
      f.seed({ text: 'draftdateclinic reminder' });f.holdNextQuery('draftdateclinic');await find(page, 'draftdateclinic');await expect.poll(f.readPending).toBe(true);await range(page).selectOption('custom');const from = dates(page).getByLabel('From', { exact: true });await from.fill('2026-11-05');f.releaseRead();await expect(hits(page)).toHaveCount(1);await expect(from).toHaveValue('2026-11-05');await expect(from).toBeFocused();await expect(dates(page)).toContainText('Applied dates: All dates');
    } finally { f.dispose(); }
  });
});
