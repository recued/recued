import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks, CHAT_INPUT, CHAT_SEND } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { readRecordChatMessage, selectedRecordsOf } from '../src/chat/record-context.js';
import { serializeShellRoute } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 }, timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
const title = 'Send the revised proposal <team>';
const reader = (page: Page) => page.locator('.work-entity-commitment-reader');
const input = (page: Page) => page.locator(`[${CHAT_INPUT}]`);
const chips = (page: Page) => page.locator('[data-chat-selected-records]');
const picker = (page: Page) => page.locator('dialog[data-record-link-insert-dialog]');
const hash = (id = 'promise-one') => serializeShellRoute('data', 'commitment', id);
const link = (page: Page, id = 'promise-one') => { const url = new URL(page.url()); url.search = ''; url.hash = hash(id); return url.href; };
const visit = async (page: Page, address: string) => { await page.evaluate(address => { location.hash = address; }, address); };
const boot = async (page: Page, address = hash(), prepare?: (f: Fixture) => void, journey = 'verification') => {
  const sends: Array<Record<string, unknown>> = [];
  const session = { id: 'created', title: 'Commitment conversation', created_at: 1, last_active_at: 2, archived: false,
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
  f.seedCommitment('promise-one', { statement: title }); f.seedCommitment('promise-two', { statement: 'Another promise' });
  f.seedNote('context-note', { title: 'Context note', body: 'Before SELECT after. Keep this draft.' }); prepare?.(f);
  await page.goto(HARNESS_URL + '?journey=' + journey + '&server_profiles=multiple&settle_reads=1' + address);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (address.startsWith('#data/commitment/')) await expect(reader(page)).toHaveAttribute('data-commitment-id', decodeURIComponent(address.split('/')[2]!));
  return { ...f, sends };
};
const clipboard = async (page: Page, deny = false) => page.addInitScript(deny => {
  const state = { values: [] as string[] };
  Object.assign(window, { __commitmentCopies: state });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => {
    state.values.push(value); if (deny) throw new Error('Clipboard unavailable');
  } } });
  document.execCommand = () => false;
}, deny);
const copies = (page: Page) => page.evaluate(() => (window as unknown as { __commitmentCopies: { values: string[] } }).__commitmentCopies.values);
const chooseCommitment = async (page: Page) => {
  await page.getByRole('button', { name: 'Add records', exact: true }).click();
  await picker(page).getByRole('combobox', { name: 'Record type', exact: true }).selectOption('commitment');
  await picker(page).getByRole('searchbox', { name: 'Search records', exact: true }).fill('revised proposal');
  await picker(page).getByRole('searchbox', { name: 'Search records', exact: true }).press('Enter');
};

test('copies the displayed commitment summary and exact deployment link without modifying records', async ({ page }) => {
  await clipboard(page); const f = await boot(page);
  try {
    const saved = f.commitment(); await expect(reader(page)).toContainText(f.person.name!);
    const value = async (label: string) => reader(page).locator('dt').filter({ hasText: new RegExp('^' + label + '$') }).locator('..').locator('dd').innerText();
    const status = await reader(page).locator('[data-commitment-status]').innerText(), deadline = await value('Deadline');
    await reader(page).getByRole('button', { name: 'Copy summary', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(reader(page).locator('[data-work-copy-notice]')).toHaveText('Commitment summary copied.');
    expect((await copies(page))[0]).toBe(`${title}\nDirection: I owe\nSaved status: ${status}\nWith: ${f.person.name}\nDeadline: ${deadline}\nSource: Recued`);
    await expect(reader(page).getByRole('button', { name: 'Copy summary', exact: true })).toBeFocused();
    await reader(page).getByRole('button', { name: 'Copy link', exact: true }).click(); await expect(reader(page).locator('[data-work-copy-notice]')).toHaveText('Link copied.');
    expect((await copies(page))[1]).toBe(link(page)); expect(f.commitment()).toEqual(saved); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('clipboard refusal offers escaped, selected text for manual copying on a phone', async ({ page }, info) => {
  await clipboard(page, true); const f = await boot(page, hash(), f => f.updateCommitment('promise-one', { statement: 'Keep </textarea><script>raw</script> 二' }));
  try {
    await reader(page).getByRole('button', { name: 'Copy summary', exact: true }).click();
    const fallback = reader(page).getByRole('textbox', { name: 'Commitment summary to copy', exact: true });
    await expect(fallback).toBeFocused(); await expect(fallback).toHaveValue((await copies(page))[0]!);
    expect(await fallback.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([0, (await fallback.inputValue()).length]);
    await expect(reader(page).locator('img,script')).toHaveCount(0); await page.screenshot({ path: info.outputPath('commitment-copy-manual-phone.png'), fullPage: true });
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('Chat about this opens an editable question with the exact commitment attached and sends only on request', async ({ page }, info) => {
  const f = await boot(page);
  try {
    const saved = f.commitment(); await reader(page).getByRole('button', { name: 'Chat about this', exact: true }).click();
    await expect(page).toHaveURL(/#chat\/new$/); await expect(input(page)).toHaveValue('What should I know about this commitment?');
    await expect(chips(page).getByRole('link', { name: title, exact: true })).toBeVisible(); expect(f.sends).toEqual([]);
    await input(page).fill('What is blocking this promise?'); await page.screenshot({ path: info.outputPath('commitment-chat-phone.png'), fullPage: true });
    await page.locator(`[${CHAT_SEND}]`).click(); await expect.poll(() => f.sends.length).toBe(1);
    const context = readRecordChatMessage(String(f.sends[0]!.message))!; expect(context.question).toBe('What is blocking this promise?');
    const records = selectedRecordsOf(context.context); expect(records).toHaveLength(1);
    expect(records[0]!.reference.identity).toBe(JSON.stringify(['commitment', saved.id, saved.source_id, saved.source_record_id ?? null, saved.created_at]));
    expect(f.commitment()).toEqual(saved); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('an open follow-up email stays protected when Chat about this is requested', async ({ page }) => {
  const f = await boot(page);
  try {
    await reader(page).getByRole('button', { name: 'Draft follow-up', exact: true }).click();
    const mail = page.getByRole('dialog', { name: 'New mail', exact: true }); await mail.locator('[data-form-field="body"]').fill('Keep this unfinished email.');
    const before = f.reads.length;
    await reader(page).getByRole('button', { name: 'Chat about this', exact: true }).evaluate(node => (node as HTMLButtonElement).click());
    await expect(mail.getByRole('textbox', { name: 'What should this email say?', exact: true })).toBeFocused();
    await expect(mail.locator('[data-form-field="body"]')).toHaveValue('Keep this unfinished email.'); expect(f.reads).toHaveLength(before);
    await expect(page).toHaveURL(/#data\/commitment\/promise-one$/); expect(f.sends).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a slow Chat check is retired when another commitment is opened', async ({ page }) => {
  const f = await boot(page);
  try {
    f.hold('work_entity.get', 'promise-one'); await reader(page).getByRole('button', { name: 'Chat about this', exact: true }).click(); await expect.poll(f.waiting).toBe(true);
    await visit(page, hash('promise-two')); await expect(reader(page)).toHaveAttribute('data-commitment-id', 'promise-two'); f.release();
    await expect(reader(page)).toContainText('Another promise'); await expect(reader(page).getByRole('button', { name: 'Chat about this', exact: true })).toBeEnabled();
    await expect(page).toHaveURL(/#data\/commitment\/promise-two$/); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('a replaced commitment is refused by the chat action without changing the reader', async ({ page }) => {
  const f = await boot(page);
  try {
    f.removeCommitment('promise-one'); f.seedCommitment('promise-one', { statement: 'Replacement promise' }, Date.parse('2026-11-10T00:00:00Z'));
    await reader(page).getByRole('button', { name: 'Chat about this', exact: true }).click();
    await expect(reader(page).locator('[data-commitment-chat-error]')).toContainText('removed or replaced');
    await expect(reader(page)).toContainText(title); await expect(page).toHaveURL(/#data\/commitment\/promise-one$/); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('Add records finds and previews a commitment and preserves its reference through connection recovery', async ({ page }) => {
  const f = await boot(page, '#chat/new', undefined, 'reauth');
  try {
    await input(page).fill('Keep this question.'); await chooseCommitment(page);
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
    expect(selectedRecordsOf(readRecordChatMessage(String(f.sends[0]!.message))!.context)[0]!.reference.target).toMatchObject({ tab: 'commitment', id: 'promise-one' });
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('pasted commitment links can be previewed, attached and rechecked before Send refuses a replacement', async ({ page }) => {
  const f = await boot(page, '#chat/new');
  try {
    const question = 'Check this promise: ' + link(page); await input(page).fill(question);
    const suggestion = page.locator('[data-chat-record-link-suggestion]');
    await expect(suggestion).toContainText('Attach the commitment');
    await suggestion.locator('[data-record-link-suggestion-attach]').click(); await expect(chips(page)).toContainText(title);
    await chips(page).getByRole('button', { name: 'Preview ' + title, exact: true }).click();
    const preview = page.locator('dialog[data-chat-record-preview-dialog]'); await expect(preview).toContainText('Saved status:');
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
    f.removeCommitment('promise-one'); f.seedCommitment('promise-one', { statement: 'Replacement promise' }, Date.parse('2026-11-10T00:00:00Z'));
    await page.locator(`[${CHAT_SEND}]`).click(); await expect(chips(page).locator('[data-chat-record-check-summary]')).toContainText('needs attention');
    await expect(input(page)).toHaveValue(question); expect(f.sends).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('universal search resolves a pasted commitment link, previews it and returns to the exact search', async ({ page }) => {
  const f = await boot(page, '#data/search');
  try {
    const query = page.getByRole('searchbox', { name: 'Search everything', exact: true }), href = link(page); await query.fill(href);
    const result = page.locator('[data-exact-record-link]'); await expect(result).toContainText(title);
    await result.getByRole('button', { name: 'Preview ' + title, exact: true }).click();
    const preview = page.locator('dialog[data-record-result-preview-dialog]'); await expect(preview).toContainText('Saved status:');
    await preview.getByRole('button', { name: 'Open commitment', exact: true }).click(); await expect(reader(page)).toContainText(title);
    await page.goBack(); await expect(query).toHaveValue(href); await expect(result.getByRole('link', { name: 'Open commitment ' + title, exact: true })).toBeFocused();
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a commitment link inserted into a note preserves the unfinished text and opens with a return to that note', async ({ page }) => {
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

test('a saved read-only commitment can be copied and discussed without write authority', async ({ page }) => {
  await clipboard(page); const f = await boot(page, hash(), f => { f.registerSource('other.commitment', 'commitment', false); f.updateCommitment('promise-one', { source_id: 'other.commitment' }); });
  try {
    await expect(reader(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await reader(page).getByRole('button', { name: 'Copy summary', exact: true }).click(); expect((await copies(page))[0]).toContain('Source: Other commitments');
    await reader(page).getByRole('button', { name: 'Chat about this', exact: true }).click(); await expect(chips(page)).toContainText(title);
    expect(f.sends).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
