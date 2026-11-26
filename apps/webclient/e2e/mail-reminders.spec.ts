import { expect, test, type Page } from '@playwright/test';
import { reminderDetailLink } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installMailTaskFixture } from './helpers/mail-task-fixture.js';
import type { ReminderDraftEntry } from '../src/reminders/reminder-draft-recovery.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
type Fixture = Awaited<ReturnType<typeof installMailTaskFixture>>;
const email = (page: Page) => page.getByRole('article', { name: 'Email message', exact: true });
const section = (page: Page) => email(page).getByRole('region', { name: 'Reminders for this email', exact: true });
const linked = (page: Page) => section(page).getByRole('region', { name: 'Linked reminders', exact: true });
const form = (page: Page) => section(page).locator('[data-mail-reminder-slot] [data-reminder-create-form]');
const boot = async (page: Page, prepare?: (f: Fixture) => void, now?: number) => {
  const f = await installMailTaskFixture(page, { reminders: true, ...(now === undefined ? {} : { now }) }); prepare?.(f);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/mail/record/work/mail-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(email(page).getByRole('button', { name: 'Remind me', exact: true })).toBeVisible();
  return f;
};
const open = async (page: Page) => {
  await email(page).getByRole('button', { name: 'Remind me', exact: true }).click();
  await expect(form(page).getByRole('textbox', { name: 'Reminder', exact: true })).toBeFocused();
};

test('keeps an email reminder through refresh and Search with its exact repeated-hour preset and source lifetime', async ({ page }) => {
  const f = await boot(page, undefined, Date.parse('2026-11-01T09:10:42.123Z'));
  try {
    await open(page); await form(page).getByRole('textbox', { name: 'Reminder', exact: true }).fill('Kestrel email follow up');
    await form(page).getByRole('button', { name: 'In 15 minutes', exact: true }).click();
    await form(page).getByRole('button', { name: 'Keep draft for later', exact: true }).click(); await expect(form(page)).toHaveCount(0);
    await expect(email(page)).toContainText('Draft kept in this tab');
    const kept = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('recued.reminder.draft-recovery.v1:'))
      .flatMap(key => JSON.parse(sessionStorage.getItem(key)!) as ReminderDraftEntry[])[0]!);
    expect(kept.values).toMatchObject({ mail_ref: f.mailReference(), chosenAt: f.now + 15 * 60_000, time: '2026-11-01T01:25' });
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await page.evaluate(() => window.__app.setHash('#data/search'));
    await page.getByRole('searchbox', { name: 'Search everything', exact: true }).fill('Kestrel email');
    await page.getByRole('region', { name: 'Unfinished work search results', exact: true })
      .getByRole('button', { name: 'Resume reminder draft Kestrel email follow up', exact: true }).click();
    const recovered = page.locator('[data-recued-reminders] [data-reminder-create-form]');
    await expect(recovered.getByRole('link', { name: 'View source email', exact: true })).toHaveAttribute('href', '#data/mail/record/work/mail-1');
    await expect(recovered.getByLabel('Date and time (America/Los_Angeles)', { exact: true })).toHaveValue('2026-11-01T01:25');
    expect(f.reminderCalls.filter(row => row.method === 'reminder.create')).toEqual([]);
    await recovered.getByRole('button', { name: 'Set reminder', exact: true }).click(); await expect(recovered).toHaveCount(0);
    expect(f.reminderCalls.filter(row => row.method === 'reminder.create').map(row => row.args)).toEqual([{
      text: 'Kestrel email follow up', at: f.now + 15 * 60_000, creation_id: kept.values.creationId, mail_ref: f.mailReference(),
    }]);
    expect(f.reminders()).toHaveLength(1); expect(f.writes).toEqual([]); expect(f.tasks()).toEqual([]);
  } finally { f.dispose(); }
});

test('sets and manages a reminder for the selected email, preserving one creation after a lost reply', async ({ page }, info) => {
  const f = await boot(page);
  try {
    await page.locator('.data-mail-conversation-toggle[data-mail-record="mail-2"]').click();
    await expect(email(page)).toContainText('second email needs');
    await open(page);
    await expect(form(page).getByRole('textbox', { name: 'Reminder', exact: true })).toHaveValue('Follow up: Quote 2');
    await form(page).getByRole('textbox', { name: 'Reminder', exact: true }).fill('Call Alex about <Quote 2>');
    await form(page).getByRole('button', { name: 'Tomorrow at 9am', exact: true }).click();
    await expect(form(page).getByLabel('Date and time (America/Los_Angeles)', { exact: true })).toHaveValue('2026-11-17T09:00');
    f.loseReminderReply();
    await form(page).getByRole('button', { name: 'Set reminder', exact: true }).click();
    await expect(form(page).getByRole('alert')).toContainText('reply was lost');
    await form(page).getByRole('button', { name: 'Check save', exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    const requests = f.reminderCalls.filter(row => row.method === 'reminder.create').map(row => row.args);
    expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
    expect(f.reminders()).toHaveLength(1);
    const reminder = f.reminders()[0]!;
    expect(reminder).toMatchObject({ text: 'Call Alex about <Quote 2>', at: Date.parse('2026-11-17T17:00:00Z'), mail_ref: f.mailReference('work', 'mail-2') });
    const row = linked(page).locator(`[data-record-reminder-row="${reminder.reminder_id}"]`);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Reschedule', exact: true }).click();
    const detail = linked(page).locator('.reminders-detail');
    await detail.getByRole('textbox', { name: 'Reminder', exact: true }).fill('Send the revised quote');
    await detail.getByRole('button', { name: 'In 15 minutes', exact: true }).click();
    await detail.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Edit reminder', exact: true })).toBeVisible();
    await linked(page).getByRole('button', { name: 'Back to linked reminders', exact: true }).click();
    await row.getByRole('button', { name: 'Cancel', exact: true }).click();
    await linked(page).getByRole('button', { name: 'Cancel it', exact: true }).click();
    await expect(detail).toContainText('Cancelled');
    await linked(page).getByRole('button', { name: 'Back to linked reminders', exact: true }).click();
    await linked(page).locator('summary').click();
    await row.getByRole('button', { name: 'Remind again', exact: true }).click();
    const again = linked(page).locator('[data-reminder-create-form]');
    await expect(again.getByRole('textbox', { name: 'Reminder', exact: true })).toHaveValue('Send the revised quote');
    await again.getByRole('button', { name: 'In 15 minutes', exact: true }).click();
    await again.getByRole('button', { name: 'Set reminder', exact: true }).click();
    await expect(again).toHaveCount(0);
    expect(f.reminders()).toHaveLength(1); expect(f.reminders()[0]?.mail_ref).toEqual(reminder.mail_ref);
    expect(f.reminder(reminder.reminder_id)?.state).toBe('cancelled');
    await linked(page).getByRole('button', { name: 'Back to linked reminders', exact: true }).click();
    await expect(linked(page)).toContainText('1 of 1 waiting');
    expect(f.writes).toEqual([]); expect(f.tasks()).toEqual([]);
    expect(f.calls).not.toContain('collection.mail.message.updateState');
    await page.screenshot({ path: info.outputPath('email-reminders-phone.png'), animations: 'disabled' });
  } finally { f.dispose(); }
});

test('pages only this email lifetime and keeps a draft and native time field through a reader repaint', async ({ page }) => {
  const f = await boot(page, f => {
    const ref = f.mailReference();
    for (let i = 0; i < 23; i++) f.seedReminder(ref, 'Linked reminder ' + i, 'pending', f.now + 3600_000 + i * 60_000);
    f.seedReminder(f.mailReference('personal'), 'Other mailbox reminder');
    f.seedReminder({ ...ref, incarnation: 'older-enrollment' }, 'Old mailbox reminder');
    f.seedReminder({ ...ref, received_at: ref.received_at + 1 }, 'Reused email reminder');
    f.hold('collection.mail.message.attachments', 'mail-1');
  });
  try {
    await expect(linked(page)).toContainText('20 of 23 waiting');
    await linked(page).getByRole('button', { name: 'Load more reminders', exact: true }).click();
    await expect(linked(page)).toContainText('23 of 23 waiting');
    await expect(linked(page)).not.toContainText('Other mailbox reminder');
    await expect(linked(page)).not.toContainText('Old mailbox reminder');
    await expect(linked(page)).not.toContainText('Reused email reminder');
    await expect.poll(() => f.waitingRead()).toBe(true);
    await open(page);
    const words = form(page).getByRole('textbox', { name: 'Reminder', exact: true });
    await words.fill('Keep this draft through attachment completion');
    const at = form(page).locator('input[type="datetime-local"]');
    await at.evaluate(node => { Object.assign(window, { __mailReminderTime: node }); });
    await email(page).getByRole('button', { name: 'Create task', exact: true }).click();
    await expect(words).toBeFocused(); await expect(page.locator('.work-entity-dialog')).toHaveCount(0);
    f.releaseReads();
    await page.waitForFunction(() => (window as unknown as { __mailTaskSettled: string[] }).__mailTaskSettled.includes('collection.mail.message.attachments:mail-1'));
    await expect(words).toHaveValue('Keep this draft through attachment completion');
    expect(await at.evaluate(node => node === (window as unknown as { __mailReminderTime: Element }).__mailReminderTime)).toBe(true);
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(email(page).getByRole('button', { name: 'Remind me', exact: true })).toBeFocused();
    expect(f.reminderCalls.filter(row => row.method === 'reminder.create')).toEqual([]);
  } finally { f.dispose(); }
});

test('a notification opens its exact email and returns to the same reminder with focus', async ({ page }) => {
  let id = '';
  const f = await boot(page, f => { id = f.seedReminder(f.mailReference('work', 'mail-2'), 'Reply about Quote 2', 'delivered'); });
  try {
    const hash = reminderDetailLink(id);
    await page.evaluate(link_url => window.__app.fireMessage({ type: 'server_event', event: {
      kind: 'notification.notify', title: 'Reminder', text: 'Reply about Quote 2', link_url, cursor: 2201,
    } }), hash);
    await page.locator(`[data-recued-notify-toast] a[href="${hash}"]`).first().click();
    const detail = page.locator('.reminders-detail');
    await expect(detail).toContainText('Reply about Quote 2');
    f.hold('collection.mail.message.get', 'mail-2');
    await detail.getByRole('button', { name: 'Open email', exact: true }).click();
    await expect.poll(() => f.waitingRead()).toBe(true);
    await page.getByRole('button', { name: 'Back to reminders', exact: true }).click();
    f.releaseReads();
    await expect(page).toHaveURL(/#data\/reminder$/); await expect(email(page)).toHaveCount(0);
    await page.evaluate(hash => window.__app.setHash(hash), hash);
    await expect(detail).toContainText('Reply about Quote 2');
    await detail.getByRole('button', { name: 'Open email', exact: true }).click();
    await expect(email(page)).toContainText('second email needs');
    await expect(page).toHaveURL(/#data\/mail\/record\/work\/mail-2$/);
    await page.getByRole('button', { name: 'Back to reminder', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Open email', exact: true })).toBeFocused();
    await expect(page).toHaveURL(new RegExp(hash + '$'));
    await detail.getByRole('button', { name: 'Open email', exact: true }).click();
    await expect(email(page)).toBeVisible(); await page.goBack();
    await expect(detail).toContainText('Reply about Quote 2');
    f.reenroll();
    await detail.getByRole('button', { name: 'Open email', exact: true }).click();
    await expect(page.locator('[data-recued-reminders]').getByRole('alert')).toContainText('removed or replaced');
    expect(f.calls).not.toContain('collection.mail.message.updateState');
  } finally { f.dispose(); }
});

test('a desktop reminder switch retires an email lookup even when the original row is selected again', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 768 });
  const f = await installMailTaskFixture(page, { reminders: true });
  try {
    const id = f.seedReminder(f.mailReference('work', 'mail-2'), 'Review Quote 2');
    f.seedReminder(f.mailReference(), 'Send the delivery date');
    await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/reminder`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const selected = page.getByRole('button', { name: 'Open reminder: Review Quote 2', exact: true });
    const pane = page.getByRole('region', { name: 'Review Quote 2', exact: true });
    const linkedEmail = pane.getByRole('button', { name: 'Open email', exact: true });
    await selected.click();
    f.hold('collection.get', 'mail-2');
    await linkedEmail.click();
    await expect.poll(f.waitingRead).toBe(true);
    await page.getByRole('button', { name: 'Open reminder: Send the delivery date', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Send the delivery date', exact: true })).toBeVisible();
    await selected.click();
    await expect(linkedEmail).toBeEnabled();
    f.releaseReads();
    await page.waitForFunction(() => (window as unknown as { __mailTaskSettled: string[] })
      .__mailTaskSettled.includes('collection.get:mail-2'));
    await expect(page).toHaveURL(new RegExp(reminderDetailLink(id) + '$'));
    await expect(email(page)).toHaveCount(0);

    await linkedEmail.click();
    await expect(email(page)).toContainText('second email needs');
    await page.goBack();
    await expect(linkedEmail).toBeFocused();
    await expect(selected).toHaveAttribute('aria-current', 'true');
    expect(f.calls).not.toContain('collection.mail.message.updateState');
  } finally { f.dispose(); }
});

test('uses the chosen repeated-hour instant and refuses an unsupported email filter without creating an unbound reminder', async ({ page }) => {
  const now = Date.parse('2026-11-01T08:50:12.345Z');
  const f = await boot(page, f => f.filterSupported(false), now);
  try {
    await expect(linked(page).getByRole('alert')).toContainText('Update your Recued server');
    await email(page).getByRole('button', { name: 'Remind me', exact: true }).click();
    await expect(section(page).getByRole('alert').first()).toContainText('Update');
    await expect(form(page)).toHaveCount(0); expect(f.reminders()).toEqual([]);
    f.filterSupported(true); await open(page);
    await form(page).getByRole('button', { name: 'In 15 minutes', exact: true }).click();
    await expect(form(page).getByLabel('Date and time (America/Los_Angeles)', { exact: true })).toHaveValue('2026-11-01T01:05');
    await form(page).getByRole('button', { name: 'Set reminder', exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    expect(f.reminders()[0]?.at).toBe(now + 15 * 60_000);
  } finally { f.dispose(); }
});

test('email reminders appear in Today and universal search and a late read cannot replace another email draft', async ({ page }) => {
  let id = '';
  const f = await boot(page, f => { id = f.seedReminder(f.mailReference(), 'Quote follow-up due now', 'pending', f.now - 60_000); });
  try {
    await page.evaluate(() => window.__app.setHash('#today'));
    await expect(page.locator(`[data-today-reminder-row="${id}"]`)).toContainText('Quote follow-up due now');
    await page.locator(`[data-today-reminder-row="${id}"]`).getByRole('link', { name: 'Quote follow-up due now', exact: true }).click();
    await page.locator('.reminders-detail').getByRole('button', { name: 'Open email', exact: true }).click();
    await expect(email(page)).toBeVisible();
    await page.getByRole('button', { name: 'Back to reminder', exact: true }).click();
    await page.getByRole('button', { name: 'Back to Today', exact: true }).click();
    await expect(page.locator(`[data-today-reminder-row="${id}"]`)).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#data/search'));
    await page.locator('[data-recued-universal-search-input]').fill('Quote');
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('reminder');
    await expect(page.getByRole('link', { name: /Quote follow-up due now/ })).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#data/mail/record/work/mail-1'));
    await expect(email(page).getByRole('button', { name: 'Remind me', exact: true })).toBeVisible();
    f.hold('reminder.get', id);
    await linked(page).locator(`[data-record-reminder-row="${id}"]`).getByRole('button', { name: 'Reschedule', exact: true }).click();
    await expect.poll(() => f.waitingRead()).toBe(true);
    await open(page);
    const words = form(page).getByRole('textbox', { name: 'Reminder', exact: true }); await words.fill('A new reminder draft');
    f.releaseReads();
    await expect(linked(page).locator('.reminders-detail')).toHaveCount(0); await expect(words).toHaveValue('A new reminder draft');
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(f.reminder(id)?.text).toBe('Quote follow-up due now');
  } finally { f.dispose(); }
});
