import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installReminderWorkspaceFixture, REMINDER_WORKSPACE_NOW as NOW } from './helpers/reminder-workspace-fixture.js';

installFullAppHooks();
test.use({ timezoneId: 'Asia/Tokyo' });
const host = (page: Page) => page.locator('[data-recued-reminders]');
const bulk = (page: Page) => host(page).getByRole('region', { name: 'Bulk reminder actions' });
const boot = async (page: Page) => {
  await page.goto(`${HARNESS_URL}?journey=verification#data/reminder`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(host(page).getByRole('heading', { name: 'Reminders', exact: true })).toBeVisible();
};
const result = (page: Page, id: string) => bulk(page).locator(`[data-reminder-triage-result="${id}"]`);

test('selects only loaded personal matches, preserves selection on Load more, and clears it on new filters', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  const f = await installReminderWorkspaceFixture(page, true);
  for (let i = 0; i < 55; i++) f.seed({ text: `Call client ${i.toString().padStart(2, '0')}`, at: NOW + 3_600_000 + i * 60_000 });
  f.seed({ text: 'Call client clock', managed: true, at: NOW + 60_000 });
  f.seed({ text: 'Call client history', state: 'delivered' }); f.seed({ text: 'Other personal reminder' });
  try {
    await boot(page);
    await host(page).getByRole('searchbox', { name: 'Search reminders', exact: true }).fill('Call client');
    await host(page).getByRole('button', { name: 'Apply filters', exact: true }).click();
    await bulk(page).getByRole('button', { name: 'Select loaded personal reminders', exact: true }).press('Enter');
    await expect(bulk(page).getByRole('status')).toHaveText('49 selected.');
    await expect(host(page).getByRole('checkbox', { name: 'Select reminder: Call client clock', exact: true })).toHaveCount(0);
    await host(page).getByRole('button', { name: 'Load more', exact: true }).press('Enter');
    await expect(host(page).getByRole('checkbox')).toHaveCount(55);
    await expect(host(page).getByRole('checkbox', { checked: true })).toHaveCount(49);
    await bulk(page).getByRole('button', { name: 'Select loaded personal reminders', exact: true }).press('Enter');
    await expect(bulk(page).getByRole('status')).toHaveText('55 selected.');
    await host(page).getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(bulk(page).getByRole('status')).toHaveText('0 selected.');
    expect(f.triageWrites).toEqual([]);
  } finally { f.dispose(); }
});

test('reviews a chosen time and owner quiet-hours delay before moving, then retains the result through a failed refresh', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date(NOW)); await page.setViewportSize({ width: 390, height: 844 });
  const f = await installReminderWorkspaceFixture(page, true);
  const a = f.seed({ text: 'Call the dentist', timeZone: 'Asia/Tokyo' }), b = f.seed({ text: 'Confirm the invoice' });
  try {
    await boot(page);
    await bulk(page).getByRole('button', { name: 'Select loaded personal reminders', exact: true }).click();
    await bulk(page).getByRole('button', { name: 'Choose a time', exact: true }).press('Enter');
    const time = bulk(page).getByLabel('New reminder time', { exact: true }); await expect(time).toBeFocused();
    await time.fill('2026-11-01T23:15');
    await bulk(page).getByRole('button', { name: 'Review move', exact: true }).press('Enter');
    await expect(bulk(page).getByRole('heading', { name: 'Review reminder move', exact: true })).toBeFocused();
    await expect(result(page, a)).toContainText('Asia/Tokyo');
    await expect(result(page, b)).toContainText('Quiet hours hold delivery until Monday 2 November at 7:00 AM (America/New_York)');
    expect(f.triageWrites).toEqual([]); expect(f.get(a)?.at).toBe(NOW + 3_600_000);
    await page.screenshot({ path: testInfo.outputPath('bulk-reminder-review-phone.png'), fullPage: true });
    f.failNextRead();
    await bulk(page).getByRole('button', { name: 'Move 2 reminders', exact: true }).press('Enter');
    await expect(bulk(page).getByRole('status')).toHaveText('2 applied. 0 remaining selected.');
    await expect(bulk(page).getByRole('status')).toBeFocused();
    await expect(host(page).getByRole('alert')).toContainText('refresh was interrupted');
    expect(f.get(a)).toMatchObject({ text: 'Call the dentist', at: Date.parse('2026-11-02T04:15:00Z'), time_zone: 'Asia/Tokyo' });
    expect(f.get(b)?.at).toBe(Date.parse('2026-11-02T04:15:00Z'));
    await expect(host(page).getByRole('checkbox', { checked: true })).toHaveCount(0);
  } finally { f.dispose(); }
});

test('moves to tomorrow on the declared clock and retries only failures at the original reviewed instant', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  const f = await installReminderWorkspaceFixture(page, true), a = f.seed({ text: 'Success' }), b = f.seed({ text: 'Try again' });
  try {
    await boot(page); await bulk(page).getByRole('button', { name: 'Select loaded personal reminders', exact: true }).click();
    await bulk(page).getByRole('button', { name: 'Move to tomorrow', exact: true }).press('Enter');
    await expect(bulk(page)).toContainText('Nov 2, 2026'); await expect(bulk(page)).toContainText('9:00 AM GMT-5');
    f.failTriageFor(b);
    await bulk(page).getByRole('button', { name: 'Move 2 reminders', exact: true }).press('Enter');
    await expect(result(page, a)).toHaveAttribute('data-outcome', 'applied'); await expect(result(page, b)).toHaveAttribute('data-outcome', 'failed');
    await expect(host(page).getByRole('checkbox', { checked: true })).toHaveCount(1);
    expect(f.get(a)?.at).toBe(Date.parse('2026-11-02T14:00:00Z'));
    await page.clock.setFixedTime(new Date(NOW + 7 * 3_600_000)); f.setNow(NOW + 7 * 3_600_000); f.allowTriage();
    await bulk(page).getByRole('button', { name: 'Retry failed (1)', exact: true }).press('Enter');
    await expect(bulk(page).getByRole('status')).toHaveText('2 applied. 0 remaining selected.');
    expect(f.triageWrites.map(w => w.items.map(i => i.reminder_id))).toEqual([[a, b].sort((x, y) => x.localeCompare(y)), [b]]);
    expect(f.triageWrites[1]?.action).toEqual(f.triageWrites[0]?.action);
    expect(f.triageWrites[1]?.request_id).toBe(f.triageWrites[0]?.request_id);
    expect(f.get(b)?.at).toBe(Date.parse('2026-11-02T14:00:00Z'));
  } finally { f.dispose(); }
});

test('retries an uncertain cancellation safely, blocks navigation while applying, and keeps later focus', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  const f = await installReminderWorkspaceFixture(page, true), a = f.seed({ text: 'Cancel me' });
  try {
    await boot(page); await host(page).getByRole('checkbox', { name: 'Select reminder: Cancel me', exact: true }).check();
    await bulk(page).getByRole('button', { name: 'Cancel selected', exact: true }).press('Enter');
    await expect(bulk(page).getByRole('heading', { name: 'Review reminder cancellation', exact: true })).toBeFocused();
    expect(f.get(a)?.state).toBe('pending'); f.holdNextTriageReply(); f.loseNextTriageReply();
    await bulk(page).getByRole('button', { name: 'Cancel 1 reminder', exact: true }).press('Enter');
    await expect.poll(() => f.triagePending()).toBe(true);
    await expect(bulk(page).getByRole('button', { name: 'Clear selection', exact: true })).toBeDisabled();
    await host(page).getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(host(page).locator('[data-recued-reminders-focus="notice"]')).toContainText('still being saved');
    const query = host(page).getByRole('searchbox', { name: 'Search reminders', exact: true }); await query.focus();
    f.releaseTriage();
    await expect(bulk(page).getByRole('button', { name: 'Retry failed (1)', exact: true })).toBeVisible(); await expect(query).toBeFocused();
    expect(f.get(a)?.state).toBe('cancelled');
    await bulk(page).getByRole('button', { name: 'Retry failed (1)', exact: true }).press('Enter');
    await expect(bulk(page).getByRole('status')).toHaveText('1 applied. 0 remaining selected.');
    expect(f.triageWrites[1]).toEqual(f.triageWrites[0]);
    await expect(result(page, a)).toContainText('Confirmed the earlier change.');
    expect(f.pendingCount()).toBe(0);
  } finally { f.dispose(); }
});

test('requires a new review for reminders changed or delivered after preview, retaining only those selections', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  const f = await installReminderWorkspaceFixture(page, true), a = f.seed({ text: 'Old wording' }), b = f.seed({ text: 'Already sent' }), c = f.seed({ text: 'Still pending' });
  try {
    await boot(page); await bulk(page).getByRole('button', { name: 'Select loaded personal reminders', exact: true }).click();
    await bulk(page).getByRole('button', { name: 'Cancel selected', exact: true }).press('Enter');
    await expect(bulk(page).getByRole('button', { name: 'Cancel 3 reminders', exact: true })).toBeVisible();
    f.edit(a, 'New wording'); f.deliver(b);
    await bulk(page).getByRole('button', { name: 'Cancel 3 reminders', exact: true }).press('Enter');
    await expect(bulk(page).getByRole('status')).toHaveText('1 applied. 2 remaining selected.');
    await expect(result(page, a)).toContainText('changed since review'); await expect(result(page, b)).toContainText('already rung');
    await expect(bulk(page).getByRole('button', { name: /^Retry failed/ })).toHaveCount(0);
    expect(f.get(a)).toMatchObject({ text: 'New wording', state: 'pending' }); expect(f.get(c)?.state).toBe('cancelled');
    await bulk(page).getByRole('button', { name: 'Back to selection', exact: true }).press('Enter');
    await bulk(page).getByRole('button', { name: 'Cancel selected', exact: true }).press('Enter');
    await expect(result(page, a)).toContainText('New wording'); await expect(result(page, b)).toContainText('already rung');
    await bulk(page).getByRole('button', { name: 'Cancel 1 reminder', exact: true }).press('Enter');
    await expect(bulk(page).getByRole('status')).toHaveText('1 applied. 1 remaining selected.');
    expect(f.triageWrites[1]?.items.map(i => i.reminder_id)).toEqual([a]);
    expect(f.get(b)?.state).toBe('delivered');
  } finally { f.dispose(); }
});

test('preserves a dirty singular edit and rejects nonexistent or past bulk times before any write', async ({ page }) => {
  const now = Date.parse('2027-03-13T17:00:00Z'); await page.clock.setFixedTime(new Date(now));
  const f = await installReminderWorkspaceFixture(page, true); f.setNow(now); const id = f.seed({ text: 'Keep my words', at: now + 3_600_000 });
  try {
    await boot(page);
    const item = host(page).locator(`.reminders-row[data-reminder-id="${id}"]`);
    await item.getByRole('button', { name: 'Edit reminder', exact: true }).click();
    await item.locator('[data-recued-reminders-field="text"]').fill('Unsaved words');
    await bulk(page).getByRole('button', { name: 'Select loaded personal reminders', exact: true }).click();
    await expect(item.locator('[data-recued-reminders-field="text"]')).toHaveValue('Unsaved words');
    await expect(bulk(page).getByRole('status')).toHaveText('0 selected.');
    await item.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await bulk(page).getByRole('button', { name: 'Select loaded personal reminders', exact: true }).click();
    await bulk(page).getByRole('button', { name: 'Choose a time', exact: true }).click();
    const time = bulk(page).getByLabel('New reminder time', { exact: true });
    for (const value of ['2027-03-14T02:30', '2027-03-12T09:00']) {
      await time.fill(value); await bulk(page).getByRole('button', { name: 'Review move', exact: true }).press('Enter');
      await expect(bulk(page).getByRole('alert')).toContainText('valid future day and time'); await expect(time).toBeFocused();
    }
    expect(f.triageWrites).toEqual([]); expect(f.get(id)?.text).toBe('Keep my words');
  } finally { f.dispose(); }
});

test('retires a late review when filters change and never restores the previous selection', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  const f = await installReminderWorkspaceFixture(page, true); f.seed({ text: 'Call client' });
  try {
    await boot(page); await bulk(page).getByRole('button', { name: 'Select loaded personal reminders', exact: true }).click();
    f.holdNextTriageReview(); await bulk(page).getByRole('button', { name: 'Move to tomorrow', exact: true }).press('Enter');
    await expect.poll(() => f.triageReviewPending()).toBe(true);
    await host(page).getByRole('button', { name: 'Clear filters', exact: true }).press('Enter');
    await expect(bulk(page).getByRole('status')).toHaveText('0 selected.');
    f.releaseTriageReview();
    await expect(bulk(page).getByRole('heading')).toHaveCount(0);
    await expect(host(page).getByRole('checkbox', { checked: true })).toHaveCount(0);
    expect(f.triageWrites).toEqual([]);
  } finally { f.dispose(); }
});

test.describe('bulk reminder actions in universal search', () => {
  const group = (page: Page) => page.getByRole('region', { name: 'Reminder search results', exact: true });
  const actions = (page: Page) => group(page).getByRole('region', { name: 'Bulk reminder actions', exact: true });
  const query = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
  const type = (page: Page) => page.getByRole('combobox', { name: 'Result type', exact: true });
  const status = (page: Page) => group(page).getByRole('combobox', { name: 'Reminder status', exact: true });
  const dates = (page: Page) => group(page).getByRole('form', { name: 'Filter reminder dates', exact: true });
  const range = (page: Page) => dates(page).getByRole('combobox', { name: 'Reminder dates', exact: true });
  const rows = (page: Page) => group(page).locator('[data-search-reminder-id]');
  const outcome = (page: Page, id: string) => actions(page).locator(`[data-reminder-triage-result="${id}"]`);
  const selectLoaded = (page: Page) => actions(page).getByRole('button', { name: 'Select loaded personal reminders', exact: true });
  const find = async (page: Page, text = '') => {
    await page.goto(`${HARNESS_URL}?journey=verification#data/search`);
    await page.waitForFunction(() => window.__app?.ready === true);
    if (text) await query(page).fill(text);
    await type(page).selectOption('reminder');
  };

  test('selects only loaded editable matches, keeps selection on More, and resets it on status changes', async ({ page }) => {
    await page.clock.setFixedTime(new Date(NOW));
    const f = await installReminderWorkspaceFixture(page, true);
    for (let i = 0; i < 55; i++) f.seed({ text: `batchclinic client ${i}`, at: NOW + 3_600_000 + i * 60_000 });
    f.seed({ text: 'batchclinic Yours', managed: true, at: NOW + 600_000 });
    f.seed({ text: 'batchclinic history', state: 'delivered', at: NOW + 300_000 });
    f.seed({ text: 'Another reminder' });
    try {
      await find(page, 'batchclinic');
      await expect(rows(page)).toHaveCount(50);
      await expect(group(page).getByRole('checkbox')).toHaveCount(48);
      await selectLoaded(page).press('Enter');
      await expect(actions(page).getByRole('status')).toHaveText('48 selected.');
      await expect(actions(page)).toContainText('loaded results only');
      await group(page).getByRole('button', { name: 'More reminders', exact: true }).press('Enter');
      await expect(rows(page)).toHaveCount(57);
      await expect(group(page).getByRole('checkbox', { checked: true })).toHaveCount(48);
      await selectLoaded(page).press('Enter');
      await expect(actions(page).getByRole('status')).toHaveText('55 selected.');
      await status(page).selectOption('pending');
      await expect(rows(page)).toHaveCount(50);
      await expect(actions(page).getByRole('status')).toHaveText('0 selected.');
      await expect(group(page).getByRole('checkbox', { checked: true })).toHaveCount(0);
      expect(f.triageWrites).toEqual([]);
    } finally { f.dispose(); }
  });

  test('reviews tomorrow on the filter clock and keeps query, dates, counts, and keyboard focus when the last result leaves', async ({ page }, testInfo) => {
    await page.clock.setFixedTime(new Date(NOW));
    await page.setViewportSize({ width: 390, height: 844 });
    const f = await installReminderWorkspaceFixture(page, true);
    const id = f.seed({ text: 'batchtoday appointment', timeZone: 'Asia/Tokyo' });
    f.seed({ text: 'batchtoday tomorrow', at: NOW + 86_400_000 });
    try {
      await find(page, 'batchtoday');
      await status(page).selectOption('pending');
      await range(page).selectOption('today');
      await dates(page).getByRole('button', { name: 'Apply reminder dates', exact: true }).click();
      const checkbox = group(page).getByRole('checkbox', { name: 'Select reminder: batchtoday appointment', exact: true });
      await checkbox.focus(); await checkbox.press('Space'); await expect(checkbox).toBeFocused();
      await page.keyboard.press(testInfo.project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(rows(page)).toBeFocused();
      await actions(page).getByRole('button', { name: 'Move to tomorrow', exact: true }).press('Enter');
      await expect(actions(page).getByRole('heading', { name: 'Review reminder move', exact: true })).toBeFocused();
      await expect(actions(page)).toContainText('9:00 AM GMT-5');
      await expect(actions(page)).toContainText('America/New_York');
      await expect(outcome(page, id)).toContainText('Asia/Tokyo');
      expect(f.triageWrites).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('search-reminder-review-phone.png'), fullPage: true });
      await actions(page).getByRole('button', { name: 'Move 1 reminder', exact: true }).press('Enter');
      await expect(actions(page).getByRole('status')).toHaveText('1 applied. 0 remaining selected.');
      await expect(actions(page).getByRole('status')).toBeFocused();
      await expect(rows(page)).toHaveCount(0);
      await expect(group(page).locator('.rq-group-count')).toHaveText('0 of 0');
      await expect(type(page).locator('option[value="reminder"]')).toHaveText('Reminders · 0 loaded');
      await expect(query(page)).toHaveValue('batchtoday');
      await expect(status(page)).toHaveValue('pending'); await expect(range(page)).toHaveValue('today');
      expect(f.get(id)).toMatchObject({ at: Date.parse('2026-11-02T14:00Z'), time_zone: 'Asia/Tokyo' });
      expect(f.reads.at(-1)?.page).toMatchObject({ query: 'batchtoday', state: 'pending',
        from: Date.parse('2026-11-01T04:00Z'), before: Date.parse('2026-11-02T05:00Z') });
    } finally { f.dispose(); }
  });

  test('reviews a chosen time and retries only the failed item after a failed refresh', async ({ page }) => {
    await page.clock.setFixedTime(new Date(NOW));
    const f = await installReminderWorkspaceFixture(page, true);
    const a = f.seed({ text: 'batchmove first' }), b = f.seed({ text: 'batchmove retry' });
    try {
      await find(page, 'batchmove'); await status(page).selectOption('pending');
      await selectLoaded(page).click();
      await actions(page).getByRole('button', { name: 'Choose a time', exact: true }).press('Enter');
      const time = actions(page).getByLabel('New reminder time', { exact: true });
      await expect(time).toBeFocused(); await time.fill('2026-11-03T10:15');
      await actions(page).getByRole('button', { name: 'Review move', exact: true }).press('Enter');
      await expect(actions(page).getByRole('heading', { name: 'Review reminder move', exact: true })).toBeFocused();
      expect(f.triageWrites).toEqual([]);
      f.failTriageFor(b); f.failNextRead();
      await actions(page).getByRole('button', { name: 'Move 2 reminders', exact: true }).press('Enter');
      await expect(outcome(page, a)).toHaveAttribute('data-outcome', 'applied');
      await expect(outcome(page, b)).toHaveAttribute('data-outcome', 'failed');
      await expect(group(page).getByRole('alert')).toContainText('refresh was interrupted');
      await expect(group(page).getByRole('checkbox')).toHaveCount(0);
      f.allowTriage();
      await actions(page).getByRole('button', { name: 'Retry failed (1)', exact: true }).press('Enter');
      await expect(actions(page).getByRole('status')).toHaveText('2 applied. 0 remaining selected.');
      expect(f.triageWrites[1]?.items.map(item => item.reminder_id)).toEqual([b]);
      expect(f.triageWrites[1]?.request_id).toBe(f.triageWrites[0]?.request_id);
      expect(f.triageWrites[1]?.action).toEqual({ kind: 'move', at: Date.parse('2026-11-03T15:15Z'), time_zone: 'America/New_York' });
      expect(f.get(a)?.at).toBe(Date.parse('2026-11-03T15:15Z'));
      expect(f.get(b)?.at).toBe(Date.parse('2026-11-03T15:15Z'));
      await expect(query(page)).toHaveValue('batchmove'); await expect(status(page)).toHaveValue('pending');
    } finally { f.dispose(); }
  });

  test('blocks scope changes while applying, safely retries a lost reply, and preserves later query focus', async ({ page }) => {
    await page.clock.setFixedTime(new Date(NOW));
    const f = await installReminderWorkspaceFixture(page, true), id = f.seed({ text: 'batchcancel client' });
    try {
      await find(page, 'batchcancel'); await status(page).selectOption('pending'); await selectLoaded(page).click();
      await actions(page).getByRole('button', { name: 'Cancel selected', exact: true }).press('Enter');
      await expect(actions(page).getByRole('heading', { name: 'Review reminder cancellation', exact: true })).toBeFocused();
      expect(f.triageWrites).toEqual([]); f.holdNextTriageReply(); f.loseNextTriageReply();
      await actions(page).getByRole('button', { name: 'Cancel 1 reminder', exact: true }).press('Enter');
      await expect.poll(f.triagePending).toBe(true);
      await expect(type(page)).toBeDisabled(); await expect(status(page)).toBeDisabled(); await expect(range(page)).toBeDisabled();
      await expect(query(page)).not.toBeEditable();
      await rows(page).click(); await expect(group(page)).toBeVisible();
      await query(page).focus(); f.releaseTriage();
      await expect(actions(page).getByRole('button', { name: 'Retry failed (1)', exact: true })).toBeVisible();
      await expect(query(page)).toBeFocused(); await expect(rows(page)).toHaveCount(0);
      expect(f.get(id)?.state).toBe('cancelled');
      await actions(page).getByRole('button', { name: 'Retry failed (1)', exact: true }).press('Enter');
      await expect(actions(page).getByRole('status')).toHaveText('1 applied. 0 remaining selected.');
      await expect(outcome(page, id)).toContainText('Confirmed the earlier change.');
      expect(f.triageWrites[1]).toEqual(f.triageWrites[0]);
      await expect(query(page)).toHaveValue('batchcancel'); await expect(status(page)).toHaveValue('pending');
    } finally { f.dispose(); }
  });

  test('retires pending reviews at query, type, status, and applied-date boundaries without stealing focus', async ({ page }) => {
    await page.clock.setFixedTime(new Date(NOW));
    const f = await installReminderWorkspaceFixture(page, true); f.seed({ text: 'batchscope client' });
    try {
      await find(page, 'batchscope');
      for (const boundary of ['query', 'type', 'status', 'dates'] as const) {
        await expect(rows(page)).toHaveCount(1); await selectLoaded(page).click();
        f.holdNextTriageReview();
        await actions(page).getByRole('button', { name: 'Move to tomorrow', exact: true }).press('Enter');
        await expect.poll(f.triageReviewPending).toBe(true);
        if (boundary === 'query') await query(page).fill('batchscope client');
        if (boundary === 'type') { await type(page).selectOption('all'); await type(page).selectOption('reminder'); }
        if (boundary === 'status') await status(page).selectOption('pending');
        if (boundary === 'dates') {
          await range(page).selectOption('today');
          await expect(actions(page).getByRole('status')).toHaveText('Checking selected reminders…');
          await dates(page).getByRole('button', { name: 'Apply reminder dates', exact: true }).click();
        }
        await query(page).focus(); f.releaseTriageReview();
        await expect(actions(page).getByRole('status')).toHaveText('0 selected.');
        await expect(actions(page).getByRole('heading')).toHaveCount(0);
        await expect(group(page).getByRole('checkbox', { checked: true })).toHaveCount(0);
        await expect(query(page)).toBeFocused();
      }
      expect(f.triageWrites).toEqual([]);
    } finally { f.dispose(); }
  });
});
