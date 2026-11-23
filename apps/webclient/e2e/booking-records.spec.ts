import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks, CHAT_INPUT, CHAT_SEND } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { readRecordChatMessage, selectedRecordsOf } from '../src/chat/record-context.js';
import { serializeShellRoute } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const title = 'Send the revised proposal <team>';
const reader = (page: Page) => page.locator('.work-entity-booking-detail[data-booking-id]');
const input = (page: Page) => page.locator(`[${CHAT_INPUT}]`);
const chips = (page: Page) => page.locator('[data-chat-selected-records]');
const picker = (page: Page) => page.locator('dialog[data-record-link-insert-dialog]');
const hash = (id = 'booking-one') => serializeShellRoute('data', 'booking', id);
const link = (page: Page, id = 'booking-one') => { const url = new URL(page.url()); url.search = ''; url.hash = hash(id); return url.href; };
const visit = async (page: Page, address: string) => { await page.evaluate(address => { location.hash = address; }, address); };
const boot = async (page: Page, address = hash(), prepare?: (f: Fixture) => void, journey = 'verification') => {
  const sends: Array<Record<string, unknown>> = [];
  const session = { id: 'created', title: 'Booking conversation', created_at: 1, last_active_at: 2, archived: false,
    picker_state: { current: 'self' }, model_routing: { current: 'byok', provider: 'openai', model_id: 'fixture' } };
  const f = await installTaskNoteSourceFixture(page, { searchable: true, caller: async (method, args) => {
    if (method === 'chat.sessions.list') return { result: { sessions: sends.length ? [{ ...session, message_count: sends.length }] : [] } };
    if (method === 'chat.session.create') return { result: { session_id: session.id } };
    if (method === 'chat.session.get') return { result: { ...session, id: args.session_id, plans: [], messages: sends.map((row, i) => ({
      id: 'user-' + i, session_id: args.session_id, role: 'user', content: row.message, ts: 3, target_server: 'self',
      picker_at_send: { display_name: 'Self' }, model_used: { provider: 'openai', model_id: 'fixture' } })) } };
    if (method === 'chat.send') { sends.push(structuredClone(args)); return { result: { turn_id: 'turn-' + sends.length, status: 'succeeded' } }; }
    return undefined;
  } });
  f.seedBooking('booking-one', { title: title }); f.seedBooking('booking-two', { title: 'Another booking' });
  f.seedNote('context-note', { title: 'Context note', body: 'Before SELECT after. Keep this draft.' }); prepare?.(f);
  await page.goto(HARNESS_URL + '?journey=' + journey + '&server_profiles=multiple&settle_reads=1' + address);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (address.startsWith('#data/booking/')) {
    await expect(reader(page)).toHaveAttribute('data-booking-id', decodeURIComponent(address.split('/')[2]!));
    await expect(reader(page).locator('[data-booking-customer-state]')).not.toHaveAttribute('data-booking-customer-state', 'loading');
  }
  return { ...f, sends };
};
const clipboard = async (page: Page, deny = false) => page.addInitScript(deny => {
  const state = { values: [] as string[] };
  Object.assign(window, { __bookingCopies: state });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => {
    state.values.push(value); if (deny) throw new Error('Clipboard unavailable');
  } } });
  document.execCommand = () => false;
}, deny);
const copies = (page: Page) => page.evaluate(() => (window as unknown as { __bookingCopies: { values: string[] } }).__bookingCopies.values);
const chooseBooking = async (page: Page) => {
  await page.getByRole('button', { name: 'Add records', exact: true }).click();
  await picker(page).getByRole('combobox', { name: 'Record type', exact: true }).selectOption('booking');
  await picker(page).getByRole('searchbox', { name: 'Search records', exact: true }).fill(title);
  await picker(page).getByRole('searchbox', { name: 'Search records', exact: true }).press('Enter');
};

test('copies the displayed booking facts and deployment link without modifying records', async ({ page }) => {
  await clipboard(page); const f = await boot(page);
  try {
    const saved = f.booking(); await expect(reader(page)).toContainText(f.person.name!);
    await reader(page).getByRole('button', { name: 'Copy summary', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(reader(page).locator('[data-work-copy-notice]')).toHaveText('Booking summary copied.');
    const summary = (await copies(page))[0]!; expect(summary).toContain(title); expect(summary).toContain('Customer: ' + f.person.name);
    expect(summary).toContain('Saved status: confirmed'); expect(summary).toContain('Starts:'); expect(summary).toContain('Ends:');
    expect(summary).not.toContain(f.person.contact_id!); await expect(reader(page).getByRole('button', { name: 'Copy summary', exact: true })).toBeFocused();
    await reader(page).getByRole('button', { name: 'Copy link', exact: true }).click(); await expect(reader(page).locator('[data-work-copy-notice]')).toHaveText('Link copied.');
    expect((await copies(page))[1]).toBe(link(page)); expect(f.booking()).toEqual(saved); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('clipboard refusal offers escaped, selected text for manual copying on a phone', async ({ page }, info) => {
  await clipboard(page, true); const f = await boot(page, hash(), f => f.updateBooking('booking-one', { title: 'Keep </textarea><script>raw</script> 二' }));
  try {
    await reader(page).getByRole('button', { name: 'Copy summary', exact: true }).click();
    const fallback = reader(page).getByRole('textbox', { name: 'Booking summary to copy', exact: true });
    await expect(fallback).toBeFocused(); await expect(fallback).toHaveValue((await copies(page))[0]!);
    expect(await fallback.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([0, (await fallback.inputValue()).length]);
    await expect(reader(page).locator('img,script')).toHaveCount(0); await page.screenshot({ path: info.outputPath('booking-copy-manual-phone.png'), fullPage: true });
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('Chat about this opens an editable question with the exact booking attached and sends only on request', async ({ page }, info) => {
  const f = await boot(page);
  try {
    const saved = f.booking(); await reader(page).getByRole('button', { name: 'Chat about this', exact: true }).click();
    await expect(page).toHaveURL(/#chat\/new$/); await expect(input(page)).toHaveValue('What should I know about this booking?');
    await expect(chips(page).getByRole('link', { name: title, exact: true })).toBeVisible(); expect(f.sends).toEqual([]);
    await input(page).fill('What is blocking this booking?'); await page.screenshot({ path: info.outputPath('booking-chat-phone.png'), fullPage: true });
    await page.locator(`[${CHAT_SEND}]`).click(); await expect.poll(() => f.sends.length).toBe(1);
    const context = readRecordChatMessage(String(f.sends[0]!.message))!; expect(context.question).toBe('What is blocking this booking?');
    const records = selectedRecordsOf(context.context); expect(records).toHaveLength(1);
    expect(records[0]!.reference.identity).toBe(JSON.stringify(['booking', saved.id, saved.source_id, saved.source_record_id ?? null, saved.created_at]));
    expect(f.booking()).toEqual(saved); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('an open follow-up email stays protected when Chat about this is requested', async ({ page }) => {
  const f = await boot(page);
  try {
    await reader(page).getByRole('button', { name: 'Draft email', exact: true }).click();
    const mail = page.getByRole('dialog', { name: 'New mail', exact: true }); await mail.locator('[data-form-field="body"]').fill('Keep this unfinished email.');
    const before = f.reads.length;
    await reader(page).getByRole('button', { name: 'Chat about this', exact: true }).evaluate(node => (node as HTMLButtonElement).click());
    await expect(mail.getByRole('textbox', { name: 'What should this email say?', exact: true })).toBeFocused();
    await expect(mail.locator('[data-form-field="body"]')).toHaveValue('Keep this unfinished email.'); expect(f.reads).toHaveLength(before);
    await expect(page).toHaveURL(/#data\/booking\/booking-one$/); expect(f.sends).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a slow Chat check is retired when another booking is opened', async ({ page }) => {
  const f = await boot(page);
  try {
    f.hold('work_entity.get', 'booking-one'); await reader(page).getByRole('button', { name: 'Chat about this', exact: true }).click(); await expect.poll(f.waiting).toBe(true);
    await visit(page, hash('booking-two')); await expect(reader(page)).toHaveAttribute('data-booking-id', 'booking-two'); f.release();
    await expect(reader(page)).toContainText('Another booking'); await expect(reader(page).getByRole('button', { name: 'Chat about this', exact: true })).toBeEnabled();
    await expect(page).toHaveURL(/#data\/booking\/booking-two$/); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('a replaced booking is refused by the chat action without changing the reader', async ({ page }) => {
  const f = await boot(page);
  try {
    f.removeBooking('booking-one'); f.seedBooking('booking-one', { title: 'Replacement booking' }, Date.parse('2026-11-10T00:00:00Z'));
    await reader(page).getByRole('button', { name: 'Chat about this', exact: true }).click();
    await expect(reader(page).locator('[data-booking-chat-error]')).toContainText('removed or replaced');
    await expect(reader(page)).toContainText(title); await expect(page).toHaveURL(/#data\/booking\/booking-one$/); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('Add records finds and previews a booking and preserves its reference through connection recovery', async ({ page }) => {
  const f = await boot(page, '#chat/new', undefined, 'reauth');
  try {
    await input(page).fill('Keep this question.'); await chooseBooking(page);
    await picker(page).getByRole('button', { name: 'Preview ' + title, exact: true }).click();
    const preview = picker(page).getByRole('region', { name: 'Record preview', exact: true }); await expect(preview).toContainText('Saved status:');
    await preview.getByRole('button', { name: 'Add to selection', exact: true }).click();
    await picker(page).getByRole('button', { name: 'Use 1 record', exact: true }).click(); await expect(input(page)).toHaveValue('Keep this question.');
    await expect(chips(page)).toContainText(title);
    await page.evaluate(() => window.__app.forceReauth());
    const reconnect = page.getByRole('form', { name: 'Reconnect this browser', exact: true }); await expect(reconnect).toBeVisible();
    await reconnect.locator('#webclient-pair-code-input-code').fill('PAIR5678');
    await reconnect.locator('#webclient-pair-code-input-recovery-0').fill(`${Array(23).fill('abandon').join(' ')} art`);
    await reconnect.getByRole('button', { name: /^Reconnect (?:this browser|in this tab)$/ }).click();
    await expect(input(page)).toHaveValue('Keep this question.'); await expect(chips(page)).toContainText(title);
    await page.locator(`[${CHAT_SEND}]`).click(); await expect.poll(() => f.sends.length).toBe(1);
    expect(selectedRecordsOf(readRecordChatMessage(String(f.sends[0]!.message))!.context)[0]!.reference.target).toMatchObject({ tab: 'booking', id: 'booking-one' });
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('pasted booking links can be previewed, attached and rechecked before Send refuses a replacement', async ({ page }) => {
  const f = await boot(page, '#chat/new');
  try {
    const question = 'Check this booking: ' + link(page); await input(page).fill(question);
    const suggestion = page.locator('[data-chat-record-link-suggestion]');
    await expect(suggestion).toContainText('Attach the booking');
    await suggestion.locator('[data-record-link-suggestion-attach]').click(); await expect(chips(page)).toContainText(title);
    await chips(page).getByRole('button', { name: 'Preview ' + title, exact: true }).click();
    const preview = page.locator('dialog[data-chat-record-preview-dialog]'); await expect(preview).toContainText('Saved status:');
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
    f.removeBooking('booking-one'); f.seedBooking('booking-one', { title: 'Replacement booking' }, Date.parse('2026-11-10T00:00:00Z'));
    await page.locator(`[${CHAT_SEND}]`).click(); await expect(chips(page).locator('[data-chat-record-check-summary]')).toContainText('needs attention');
    await expect(input(page)).toHaveValue(question); expect(f.sends).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('universal search resolves a pasted booking link, previews it and returns to the exact search', async ({ page }) => {
  const f = await boot(page, '#data/search');
  try {
    const query = page.getByRole('searchbox', { name: 'Search everything', exact: true }), href = link(page); await query.fill(href);
    const result = page.locator('[data-exact-record-link]'); await expect(result).toContainText(title);
    await result.getByRole('button', { name: 'Preview ' + title, exact: true }).click();
    const preview = page.locator('dialog[data-record-result-preview-dialog]'); await expect(preview).toContainText('Saved status:');
    await preview.getByRole('button', { name: 'Open booking', exact: true }).click(); await expect(reader(page)).toContainText(title);
    await page.goBack(); await expect(query).toHaveValue(href); await expect(result.getByRole('link', { name: 'Open booking ' + title, exact: true })).toBeFocused();
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a booking link inserted into a note preserves the unfinished text and opens with a return to that note', async ({ page }) => {
  const f = await boot(page, '#data/note/context-note');
  try {
    await page.locator('.work-entity-note-reader').getByRole('button', { name: 'Edit', exact: true }).click();
    const body = page.locator('.work-entity-dialog-form [data-form-field="body"]');
    await body.evaluate((node: HTMLTextAreaElement) => { node.focus(); const at = node.value.indexOf('SELECT'); node.setSelectionRange(at, at + 6); });
    await page.getByRole('button', { name: 'Insert record link', exact: true }).click();
    await picker(page).getByRole('searchbox', { name: 'Search records', exact: true }).fill(link(page));
    await picker(page).getByRole('searchbox', { name: 'Search records', exact: true }).press('Enter');
    await picker(page).getByRole('button', { name: 'Insert link to ' + title, exact: true }).click();
    await expect(body).toHaveValue('Before ' + link(page) + ' after. Keep this draft.'); await expect(body).toBeFocused(); expect(f.writes).toEqual([]);
    await page.locator('.work-entity-dialog-form').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.work-entity-note-reader').getByRole('button', { name: 'Formatted', exact: true }).click();
    await page.locator('.work-entity-note-reader').getByRole('link', { name: link(page), exact: true }).click();
    await expect(reader(page)).toContainText(title); await reader(page).getByRole('button', { name: 'Back to note', exact: true }).click();
    await expect(page.locator('.work-entity-note-reader')).toContainText('Keep this draft.'); expect(f.writes).toHaveLength(1);
  } finally { f.dispose(); }
});

test('a saved read-only booking can be copied and discussed without write authority', async ({ page }) => {
  await clipboard(page); const f = await boot(page, hash(), f => { f.registerSource('other.booking', 'booking', false); f.updateBooking('booking-one', { source_id: 'other.booking' }); });
  try {
    await reader(page).getByRole('button', { name: 'Copy summary', exact: true }).click(); expect((await copies(page))[0]).toContain('Customer: ' + f.person.name);
    await reader(page).getByRole('button', { name: 'Chat about this', exact: true }).click(); await expect(chips(page)).toContainText(title);
    expect(f.sends).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('universal booking search previews and opens the reader and returns to the same query, type and control', async ({ page }, info) => {
  const f = await boot(page, '#data/search');
  try {
    const query = page.getByRole('searchbox', { name: 'Search everything', exact: true }); await query.fill('revised');
    const group = page.locator('[data-work-search-group="booking"]'); await expect(group).toContainText(title);
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('booking');
    await expect(page.locator('[data-work-search-group="note"]')).toHaveCount(0);
    await group.getByRole('button', { name: 'Preview ' + title, exact: true }).click();
    const preview = page.locator('dialog[data-record-result-preview-dialog]'); await expect(preview).toContainText('Saved status: confirmed');
    await page.screenshot({ path: info.outputPath('booking-search-preview-phone.png'), fullPage: true });
    await preview.getByRole('button', { name: 'Open booking', exact: true }).click(); await expect(reader(page)).toHaveAttribute('data-booking-id', 'booking-one');
    await reader(page).getByRole('button', { name: 'Back to search', exact: true }).click();
    await expect(query).toHaveValue('revised'); await expect(page.getByRole('combobox', { name: 'Result type', exact: true })).toHaveValue('booking');
    await expect(group.locator('[data-recued-data-action="universal-search-open-work"][data-search-work-id="booking-one"]')).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('booking search pages beyond the first five results', async ({ page }) => {
  const f = await boot(page, '#data/search', f => { for (let i = 0; i < 8; i++) f.seedBooking('page-' + i, { title: 'Paged consultation ' + i }); });
  try {
    const query = page.getByRole('searchbox', { name: 'Search everything', exact: true }); await query.fill('Paged');
    const group = page.locator('[data-work-search-group="booking"]'), rows = group.locator('[data-recued-data-action="universal-search-open-work"]'); await expect(rows).toHaveCount(5);
    await group.getByRole('button', { name: 'More bookings', exact: true }).click(); await expect(rows).toHaveCount(8); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const destination of ['search', 'booking'] as const) test(`a delayed booking preview cannot repaint a newer ${destination} selection`, async ({ page }) => {
  const f = await boot(page, '#data/search');
  try {
    const query = page.getByRole('searchbox', { name: 'Search everything', exact: true }); await query.fill('revised');
    const group = page.locator('[data-work-search-group="booking"]'); await expect(group).toContainText(title);
    f.hold('work_entity.get', 'booking-one'); await group.getByRole('button', { name: 'Preview ' + title, exact: true }).click(); await expect.poll(f.waiting).toBe(true);
    const preview = page.locator('dialog[data-record-result-preview-dialog]'); await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
    if (destination === 'search') await query.fill('Another'); else await visit(page, hash('booking-two'));
    f.release(); await expect(preview).toHaveCount(0);
    if (destination === 'search') { await expect(query).toHaveValue('Another'); await expect(page.locator('[data-work-search-group="booking"]')).toContainText('Another booking'); }
    else { await expect(reader(page)).toHaveAttribute('data-booking-id', 'booking-two'); await expect(reader(page)).toContainText('Another booking'); }
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('browser Back protects an email drafted from a search booking and restores the search after acceptance', async ({ page }) => {
  const f = await boot(page, '#data/search');
  try {
    const query = page.getByRole('searchbox', { name: 'Search everything', exact: true }); await query.fill('revised');
    await page.locator('[data-work-search-group="booking"] [data-recued-data-action="universal-search-open-work"][data-search-work-id="booking-one"]').click();
    await expect(reader(page)).toHaveAttribute('data-booking-id', 'booking-one'); await reader(page).getByRole('button', { name: 'Draft email', exact: true }).click();
    const body = page.getByRole('dialog', { name: 'New mail', exact: true }).locator('[data-form-field="body"]'); await body.fill('Keep this unfinished email.');
    const prompts: string[] = [], current = await page.evaluate(() => location.hash);
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); }); await page.goBack();
    await expect.poll(() => prompts.length).toBe(1); await expect(body).toHaveValue('Keep this unfinished email.'); expect(await page.evaluate(() => location.hash)).toBe(current);
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.accept(); }); await page.goBack(); await expect.poll(() => prompts.length).toBe(2); await expect(query).toHaveValue('revised');
    await expect(page.getByRole('dialog', { name: 'New mail', exact: true })).toHaveCount(0); expect(f.sends).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('an older server reports booking search as unavailable while keeping the other result kinds usable', async ({ page }) => {
  const f = await boot(page, '#data/search', f => f.fixtureCaller((method) => method === 'work_entity.search' ? { result: { groups: ['task', 'note', 'project', 'commitment'].map(kind => ({ kind, matches: kind === 'task' ? [{ id: 'task-one', title: 'Consultation task', excerpt: '', source_id: 'recued.task', source_label: 'Recued', updated_at: 100, stale: false, pending_write: false }] : [], more: false, offset: 0 })) } } : undefined));
  try {
    await page.getByRole('searchbox', { name: 'Search everything', exact: true }).fill('consultation');
    const group = page.locator('[data-work-search-group="booking"]'); await expect(group.getByRole('alert')).toContainText('Update your Recued server');
    await expect(page.getByRole('combobox', { name: 'Result type', exact: true }).locator('option[value="booking"]')).toContainText('Unavailable');
    await expect(page.locator('[data-work-search-group="task"]')).toBeVisible(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
