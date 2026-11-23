import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const title = 'Consultation <team>', previousId = 'previous/二?', previousTitle = 'Previous consultation <team>';
const hash = (id = 'booking-one') => serializeShellRoute('data', 'booking', id);
const reader = (page: Page) => page.locator('.work-entity-booking-detail[data-booking-id]');
const customer = (page: Page) => reader(page).locator('[data-booking-customer-state]');
const profile = (page: Page) => page.locator('[data-recued-data-contact-detail]');
const historyRow = (page: Page, name = previousTitle) => reader(page).locator('.work-entity-booking-history li').filter({ has: page.getByText(name, { exact: true }) });
const openHistory = (page: Page) => historyRow(page).getByRole('button');
const back = (page: Page) => reader(page).getByRole('button', { name: 'Back to original booking', exact: true });
const visit = (page: Page, address: string) => page.evaluate(address => { location.hash = address; }, address);
const boot = async (page: Page, options: { address?: string; prepare?: (f: Fixture) => void | Promise<void>; waitCustomer?: boolean } = {}) => {
  const executions: Record<string, unknown>[] = [];
  const f = await installTaskNoteSourceFixture(page, { searchable: true, caller: (method, args) => {
    if (method === 'execute') { executions.push(structuredClone(args)); return { result: { success: true, output: { render: [{ type: 'text', data: 'Draft about the consultation.' }] } } }; }
    return undefined;
  } });
  f.seedBooking('booking-one'); f.seedBooking('booking-two', { title: 'Another booking' });
  for (let i = 0; i < 12; i++) f.seedBooking(i === 0 ? previousId : 'history-' + i, { title: i === 0 ? previousTitle : 'Earlier consultation ' + i,
    lifecycle_state: i % 2 ? 'no_show' : 'completed', slot_start_at: Date.parse('2026-10-30T18:00:00Z') - i * 86_400_000,
    slot_end_at: Date.parse('2026-10-30T19:00:00Z') - i * 86_400_000 });
  await options.prepare?.(f); const address = options.address ?? hash();
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + address);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (address.startsWith('#data/booking/')) {
    await expect(reader(page)).toHaveAttribute('data-booking-id', decodeURIComponent(address.split('/')[2]!));
    if (options.waitCustomer !== false) await expect(customer(page)).not.toHaveAttribute('data-booking-customer-state', 'loading');
  }
  return { ...f, executions };
};

test('resolves the customer, opens its exact contact and refreshes the name on return without changing the booking', async ({ page }, info) => {
  const f = await boot(page);
  try {
    const saved = f.booking(); await expect(customer(page)).toContainText(f.person.name!); await expect(customer(page)).not.toContainText(f.person.contact_id!);
    await reader(page).getByRole('button', { name: 'Open contact', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(profile(page)).toContainText(f.person.name!); await expect(profile(page).getByRole('button', { name: /Back to booking$/ })).toBeVisible();
    await f.seedContact(f.person.email, 'Riley updated'); await profile(page).getByRole('button', { name: /Back to booking$/ }).click();
    await expect(reader(page)).toHaveAttribute('data-booking-id', saved.id); await expect(customer(page)).toContainText('Riley updated');
    await expect(reader(page).getByRole('button', { name: 'Open contact', exact: true })).toBeFocused();
    expect(f.booking()).toEqual(saved); expect(f.writes).toEqual([]); await page.screenshot({ path: info.outputPath('booking-customer-phone.png'), fullPage: true });
  } finally { f.dispose(); }
});

test('opens an opaque history address and restores the original booking, filters, scroll and keyboard control', async ({ page }) => {
  const f = await boot(page, { address: '#data/booking' });
  try {
    await page.getByRole('combobox', { name: 'Source', exact: true }).selectOption('recued.booking');
    await page.getByRole('combobox', { name: 'Filter bookings by status', exact: true }).selectOption('confirmed');
    await page.getByRole('searchbox', { name: 'Search bookings', exact: true }).fill('Consultation');
    await expect(page.locator('[data-action="open-work-entity-detail"][data-entity-id="booking-two"]')).toHaveCount(0);
    await page.locator('[data-action="open-work-entity-detail"][data-entity-id="booking-one"]').click();
    await expect(reader(page)).toHaveAttribute('data-booking-id', 'booking-one'); await expect(customer(page)).toHaveAttribute('data-booking-customer-state', 'ready');
    await expect(reader(page)).toContainText('Showing 10 of 12 previous bookings.');
    const button = historyRow(page, 'Earlier consultation 8').getByRole('button'); await button.focus();
    const top = await button.evaluate(node => node.getBoundingClientRect().top);
    await page.keyboard.press('Enter'); await expect(reader(page)).toHaveAttribute('data-booking-id', 'history-8');
    await page.goBack(); await expect(reader(page)).toHaveAttribute('data-booking-id', 'booking-one'); await expect(button).toBeFocused();
    await expect.poll(() => button.evaluate(node => node.getBoundingClientRect().top)).toBeCloseTo(top, -1);
    await reader(page).getByRole('button', { name: 'Back to bookings', exact: true }).click();
    await expect(page.getByRole('searchbox', { name: 'Search bookings', exact: true })).toHaveValue('Consultation');
    await expect(page.getByRole('combobox', { name: 'Filter bookings by status', exact: true })).toHaveValue('confirmed');
    await expect(page.getByRole('combobox', { name: 'Source', exact: true })).toHaveValue('recued.booking'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('Draft email opens the existing AI composer with current customer and booking facts and returns without sending', async ({ page }, info) => {
  const f = await boot(page);
  try {
    const saved = f.booking(); await reader(page).getByRole('button', { name: 'Draft email', exact: true }).click();
    const mail = page.getByRole('dialog', { name: 'New mail', exact: true }), brief = mail.getByRole('textbox', { name: 'What should this email say?', exact: true });
    await expect(brief).toBeFocused(); await expect(brief).toHaveValue(/^Draft an email about the booking below/);
    const facts = JSON.parse((await brief.inputValue()).split('Booking context:\n')[1]!);
    expect(facts).toMatchObject({ customer: f.person.name, email: f.person.email, title, saved_status: 'confirmed', starts_at: '2026-11-21T19:30:00.000Z', ends_at: '2026-11-21T20:30:00.000Z' });
    await brief.fill('Ask whether the customer would like to prepare anything.'); await mail.locator('[data-form-field="body"]').fill('Keep this unfinished email.');
    expect(f.executions).toEqual([]); expect(f.writes).toEqual([]); await page.screenshot({ path: info.outputPath('booking-email-phone.png'), fullPage: true });
    await mail.getByRole('button', { name: 'Close', exact: true }).click(); await mail.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await expect(reader(page).getByRole('button', { name: 'Draft email', exact: true })).toBeFocused(); expect(f.booking()).toEqual(saved);
  } finally { f.dispose(); }
});

test('missing customer reads can be retried and unlinked bookings offer no invented recipient', async ({ page }) => {
  const f = await boot(page, { prepare: f => { f.contactReply(f.person.contact_id!, null); f.updateBooking('booking-two', { counterparty_contact_id: undefined }); } });
  try {
    await expect(customer(page)).toContainText('Customer unavailable'); await expect(reader(page).getByRole('button', { name: 'Draft email', exact: true })).toHaveCount(0);
    f.contactReply(f.person.contact_id!, undefined); await reader(page).getByRole('button', { name: 'Try customer again', exact: true }).click();
    await expect(customer(page)).toContainText(f.person.name!); await expect(reader(page).getByRole('button', { name: 'Open contact', exact: true })).toBeEnabled();
    await visit(page, hash('booking-two')); await expect(reader(page)).toHaveAttribute('data-booking-id', 'booking-two'); await expect(customer(page)).toContainText('Not linked');
    await expect(reader(page).getByRole('button', { name: 'Open contact', exact: true })).toHaveCount(0); await expect(reader(page).getByRole('button', { name: 'Draft email', exact: true })).toHaveCount(0);
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a customer email changed after the booking opened requires review before composition', async ({ page }) => {
  const f = await boot(page);
  try {
    f.contactReply(f.person.contact_id!, { ...f.person, email: 'changed@example.test' }); await reader(page).getByRole('button', { name: 'Draft email', exact: true }).click();
    await expect(reader(page).locator('[data-booking-action-error]')).toContainText('email address changed');
    await expect(page.getByRole('dialog', { name: 'New mail', exact: true })).toHaveCount(0); await expect(reader(page)).toContainText(title); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a failed history read retries explicitly and a reused booking is kept unavailable', async ({ page }) => {
  const f = await boot(page);
  try {
    f.fail('work_entity.get', previousId); await openHistory(page).click(); await expect(historyRow(page).getByRole('alert')).toBeVisible();
    const before = f.booking(previousId); f.fail('work_entity.get', previousId, false); f.removeBooking(previousId);
    f.seedBooking(previousId, { title: 'Replacement booking', lifecycle_state: 'completed' }, before.created_at + 5000);
    await openHistory(page).click(); await expect(historyRow(page).getByRole('alert')).toContainText('no longer available');
    await expect(reader(page)).toHaveAttribute('data-booking-id', 'booking-one'); await expect(reader(page)).not.toContainText('Replacement booking'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const action of ['customer', 'history'] as const) test(`a delayed ${action} lookup cannot navigate or repaint a newer booking`, async ({ page }) => {
  const f = await boot(page, { prepare: async f => { const person = await f.seedContact('other@example.test', 'Another customer'); f.updateBooking('booking-two', { counterparty_contact_id: person.contact_id }); } });
  try {
    f.hold(action === 'customer' ? 'contact.get' : 'work_entity.get', action === 'customer' ? f.person.contact_id! : previousId);
    await (action === 'customer' ? reader(page).getByRole('button', { name: 'Open contact', exact: true }) : openHistory(page)).click(); await expect.poll(f.waiting).toBe(true);
    await visit(page, hash('booking-two')); await expect(reader(page)).toHaveAttribute('data-booking-id', 'booking-two'); await expect(customer(page)).toContainText('Another customer');
    f.release(); await expect(customer(page)).toContainText('Another customer'); await expect(page).toHaveURL(/#data\/booking\/booking-two$/); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['contact', 'booking', 'email'] as const) test(`browser Back protects an unsaved ${kind} editor before returning to the original booking`, async ({ page }) => {
  const f = await boot(page);
  try {
    if (kind === 'contact') { await reader(page).getByRole('button', { name: 'Open contact', exact: true }).click(); await profile(page).getByRole('button', { name: 'Edit', exact: true }).click(); }
    else { await openHistory(page).click(); await reader(page).getByRole('button', { name: kind === 'email' ? 'Draft email' : 'Edit / reschedule', exact: true }).click(); }
    const field = kind === 'contact' ? page.getByRole('dialog', { name: 'Edit contact', exact: true }).getByLabel('Name', { exact: true })
      : kind === 'email' ? page.getByRole('dialog', { name: 'New mail', exact: true }).locator('[data-form-field="body"]') : page.locator('.work-entity-dialog[data-kind="booking"] [data-form-field="title"]');
    await field.fill('Unfinished child edit'); const current = await page.evaluate(() => location.hash), prompts: string[] = [];
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(1); expect(await page.evaluate(() => location.hash)).toBe(current); await expect(field).toHaveValue('Unfinished child edit');
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.accept(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(2); await expect(reader(page)).toHaveAttribute('data-booking-id', 'booking-one');
    await expect(kind === 'contact' ? reader(page).getByRole('button', { name: 'Open contact', exact: true }) : openHistory(page)).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a replaced original booking is never adopted while returning from a previous booking', async ({ page }) => {
  const f = await boot(page);
  try {
    const original = f.booking(); await openHistory(page).click(); await expect(reader(page)).toHaveAttribute('data-booking-id', previousId);
    f.removeBooking('booking-one'); f.seedBooking('booking-one', { title: 'Replacement original booking' }, original.created_at + 5000);
    await back(page).click(); const unavailable = page.locator('.work-entity-booking-detail');
    await expect(unavailable.getByRole('alert')).toContainText('Could not return'); await expect(unavailable).not.toContainText('Replacement original booking');
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('an existing email draft remains in place when customer or history navigation is requested', async ({ page }) => {
  const f = await boot(page);
  try {
    await reader(page).getByRole('button', { name: 'Draft email', exact: true }).click();
    const mail = page.getByRole('dialog', { name: 'New mail', exact: true }); await mail.locator('[data-form-field="body"]').fill('Keep this email.');
    const before = f.reads.length;
    for (const control of [reader(page).getByRole('button', { name: 'Open contact', exact: true }), openHistory(page)]) await control.evaluate(node => (node as HTMLButtonElement).click());
    await expect(mail.locator('[data-form-field="body"]')).toHaveValue('Keep this email.'); await expect(mail.getByRole('textbox', { name: 'What should this email say?', exact: true })).toBeFocused();
    expect(f.reads).toHaveLength(before); await expect(reader(page)).toHaveAttribute('data-booking-id', 'booking-one'); expect(f.executions).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const held of ['booking', 'customer'] as const) test(`a new focus choice survives the delayed ${held} refresh on return`, async ({ page }) => {
  const f = await boot(page);
  try {
    await reader(page).getByRole('button', { name: 'Open contact', exact: true }).click();
    f.hold(held === 'booking' ? 'work_entity.get' : 'contact.get', held === 'booking' ? 'booking-one' : f.person.contact_id!);
    await profile(page).getByRole('button', { name: /Back to booking$/ }).click(); await expect.poll(f.waiting).toBe(true);
    const control = page.locator('.work-entity-booking-detail').getByRole('button', { name: 'Back to bookings', exact: true });
    await control.focus(); await page.keyboard.press('End'); f.release(); await expect(reader(page)).toHaveAttribute('data-booking-id', 'booking-one');
    await expect(customer(page)).toHaveAttribute('data-booking-customer-state', 'ready'); await expect(control).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a merged customer is resolved through the contact owner and the booking reference stays unchanged', async ({ page }) => {
  const f = await boot(page, { prepare: async f => { const survivor = await f.seedContact('survivor@example.test', 'Surviving customer'); f.mergeContacts([f.person.email], survivor.email); } });
  try {
    await expect(customer(page)).toContainText('Surviving customer'); await expect(customer(page)).toContainText('Merged contact.');
    await reader(page).getByRole('button', { name: 'Open contact', exact: true }).click(); await expect(profile(page)).toContainText('Surviving customer');
    await profile(page).getByRole('button', { name: /Back to booking$/ }).click(); await expect(customer(page)).toContainText('Surviving customer');
    expect(f.booking().counterparty_contact_id).toBe(f.person.contact_id); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
