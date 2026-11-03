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
    await expect(detail(page).getByRole('button')).toHaveCount(0);
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
    await expect(detail(page).getByRole('button')).toHaveCount(0);
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
