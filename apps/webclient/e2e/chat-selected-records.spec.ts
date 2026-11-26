import { expect, test, type Page } from '@playwright/test';
import type { Asset } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks, CHAT_INPUT, CHAT_SEND } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { openChatHistory } from './helpers/chat-history.js';
import { readRecordChatMessage, selectedRecordsOf } from '../src/chat/record-context.js';
import { serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 900 } });
const input = (page: Page) => page.locator(`[${CHAT_INPUT}]`);
const send = (page: Page) => page.locator(`[${CHAT_SEND}]`);
const suggestion = (page: Page) => page.locator('[data-chat-record-link-suggestion]');
const attachLink = (page: Page) => suggestion(page).locator('[data-record-link-suggestion-attach]');
const recordURL = (page: Page, hash: string) => { const url = new URL(page.url()); url.search = ''; url.hash = hash; return url.href; };
const picker = (page: Page) => page.locator('dialog[data-record-link-insert-dialog]');
const query = (page: Page) => picker(page).getByRole('searchbox', { name: 'Search records', exact: true });
const chips = (page: Page) => page.locator('[data-chat-selected-records]');
const chip = (page: Page, title: string) => chips(page).locator('.chat-record-chip').filter({ has: page.getByRole('link', { name: title, exact: true }) });
const recheck = (page: Page, title: string) => chip(page, title).getByRole('button', { name: 'Recheck ' + title, exact: true });
const checkSummary = (page: Page) => chips(page).locator('[data-chat-record-check-summary]');
const cancelCheck = (page: Page) => chips(page).getByRole('button', { name: 'Cancel check', exact: true });
const recordPreview = (page: Page) => page.locator('dialog[data-chat-record-preview-dialog]');
const settledReads = (page: Page, id: string) => page.evaluate(id => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'work_entity.get:' + id).length, id);
const previewRecord = async (page: Page, title: string) => {
  await chips(page).getByRole('button', { name: 'Preview ' + title, exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(recordPreview(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
};
const use = (page: Page, n: number) => picker(page).getByRole('button', { name: `Use ${n} ${n === 1 ? 'record' : 'records'}`, exact: true });
const choose = async (page: Page, title: string, n: number, kind = 'all') => {
  await query(page).fill(title); await picker(page).getByRole('combobox', { name: 'Record type', exact: true }).selectOption(kind); await query(page).press('Enter');
  await picker(page).getByRole('button', { name: 'Select link to ' + title, exact: true }).click(); await expect(use(page, n)).toBeEnabled();
};
const addNote = async (page: Page) => {
  await page.getByRole('button', { name: 'Add records', exact: true }).click(); await choose(page, 'Context note', 1, 'note'); await use(page, 1).click(); await expect(picker(page)).toHaveCount(0); await expect(chips(page)).toContainText('Context note');
};
const switchTo = async (page: Page, id: string) => {
  await openChatHistory(page); await page.locator(`[data-recued-chat-route-session-row="${id}"]`).click(); await expect(page).toHaveURL(new RegExp('#chat/session/' + id + '$')); await expect(input(page)).toBeVisible();
};
const boot = async (page: Page, initial = 'a', pin = false, journey = 'verification', history = 0) => {
  const sends: Array<Record<string, unknown>> = [], accepted = new Map<string, Record<string, unknown>>();
  const sessions = new Map(['a', 'b'].map(id => [id, { id, title: 'Conversation ' + id, created_at: 1, last_active_at: 2, archived: false,
    picker_state: { current: 'self' }, model_routing: { current: 'byok', provider: 'openai', model_id: 'fixture' } }]));
  let loseReply = false;
  const yoursAsset: Asset = {
    id: 'fixture-calibration-kit', name: 'Private calibration kit', class_id: 'equipment', status: 'active',
    serial_number: 'Private fixture serial', source_id: 'recued.asset', sync_state: 'live',
    last_seen_at: 1, conflict_policy: 'recued_wins',
    dates: {}, readings: {}, observations: {}, values: [], anchors: [], attributes: {}, settings: {},
    rules: [], field_sources: {}, retirement: 'part', created_at: 1, updated_at: 1,
  };
  const yoursReads: Record<string, unknown>[] = [];
  const f = await installTaskNoteSourceFixture(page, { searchable: true, caller: async (method, args) => {
    if (method === 'yours.read' && (typeof args.search === 'string' || typeof args.asset_id === 'string')) {
      yoursReads.push(structuredClone(args));
      const match = typeof args.asset_id === 'string' ? args.asset_id === yoursAsset.id
        : yoursAsset.name.toLowerCase().includes(String(args.search).toLowerCase());
      return { result: { assets: match ? [structuredClone(yoursAsset)] : [], total_assets: match ? 1 : 0,
        classes: [{ id: 'equipment', name: 'Equipment' }] } };
    }
    if (method === 'chat.sessions.list') return { result: { sessions: [...sessions.values()].map(session => ({ ...session, message_count: 1 })) } };
    if (method === 'chat.session.get') return { result: { ...sessions.get(String(args.session_id)), plans: [], quoted_replies_available: true,
      messages: [...Array.from({ length: history }, (_, i) => ({ id: 'earlier-' + i, session_id: args.session_id, role: 'assistant', content: 'Earlier answer ' + i + '. ' + 'Saved conversation context. '.repeat(20), ts: 1, target_server: 'self', picker_at_send: { display_name: 'Self' }, model_used: { provider: 'openai', model_id: 'fixture' } })), ...[...accepted.values()].filter(row => row.session_id === args.session_id).map((row, i) => ({ id: 'user-' + i, session_id: args.session_id,
        role: 'user', content: row.message, ts: 3, target_server: 'self', picker_at_send: { display_name: 'Self' }, model_used: { provider: 'openai', model_id: 'fixture' } }))] } };
    if (method === 'chat.session.create') { const session = { ...sessions.get('a')!, id: 'created', title: 'Created chat' }; sessions.set('created', session); return { result: { session_id: session.id } }; }
    if (method === 'chat.send') {
      sends.push(structuredClone(args)); accepted.set(String(args.submission_id), structuredClone(args));
      if (loseReply) { loseReply = false; return { error: { code: 'UNAVAILABLE', message: 'The acknowledgement was lost.' } }; }
      return { result: { turn_id: 'turn-' + args.submission_id, status: 'succeeded' } };
    }
    if (method === 'data.file.attachments.get') return { result: { file_id: args.record_id, filename: 'Context.pdf', media_class: 'document', mime_type: 'application/pdf', size: 10, selection_revision: 'a'.repeat(64) } };
    if (method === 'data.file.attachments.list') return { result: { files: [{ file_id: 'file-context', selection_revision: 'a'.repeat(64), filename: 'Context.pdf', mime_type: 'application/pdf', media_class: 'document', size: 10, received_at: 1 }] } };
    return undefined;
  } });
  await f.seedContact(f.person.email, 'Context person <img src=x>'); f.update({ title: 'Context task' });
  f.seedNote('context-note', { title: 'Context note', body: 'Private selected note body.' });
  const goto = async (hash: string) => { await page.goto(HARNESS_URL + '?journey=' + journey + '&server_profiles=multiple&settle_reads=1' + hash); await page.waitForFunction(() => window.__app?.ready === true); };
  if (pin) { await goto(serializeSourceRecordAddress(f.source('calendar'))); await page.locator('.calendar-event [data-record-pin-key]').click(); }
  await goto(initial === 'new' ? '#chat/new' : '#chat/session/' + initial); await expect(input(page)).toBeVisible();
  return { ...f, sends, accepted, loseNextReply: () => { loseReply = true; },
    yoursAsset, yoursReads, replaceYoursAsset: () => { yoursAsset.created_at++; } };
};

for (const width of [1280, 390]) test(`attachment choices stay reachable with a tall selected-record draft at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 640 : 900 });
  const f = await boot(page);
  try {
    const ids = Array.from({ length: 20 }, (_, i) => 'attachment-' + String(i).padStart(2, '0'));
    for (const id of ids) f.seedNote(id, { title: 'Attachment context ' + id, body: 'Saved context.' });
    const question = ['Keep my quoted question.', ...Array(8).fill('Read these records with the file I choose.')].join('\n');
    await input(page).fill(question); await page.getByRole('button', { name: 'Add records', exact: true }).click();
    for (let i = 0; i < ids.length; i++) await choose(page, 'Attachment context ' + ids[i], i + 1, 'note');
    await use(page, 20).click(); await expect(picker(page)).toHaveCount(0);
    const attach = page.getByRole('button', { name: 'Attach a file', exact: true });
    const fromFiles = page.getByRole('button', { name: 'Choose from Files', exact: true });
    await attach.click(); await expect(fromFiles).toBeFocused(); await fromFiles.click({ trial: true, timeout: 2000 });
    await page.screenshot({ path: info.outputPath('attachment-choices.png'), fullPage: true });
    await page.setViewportSize({ width: width === 390 ? 768 : 390, height: 640 });
    await fromFiles.click({ trial: true, timeout: 2000 });
    await page.keyboard.press('Escape'); await expect(attach).toBeFocused(); await expect(fromFiles).toBeHidden();
    await page.keyboard.press('Enter'); await fromFiles.press('Enter');
    const files = page.getByRole('dialog', { name: 'Choose from Files', exact: true }); await expect(files).toBeVisible();
    const oldAttach = await attach.elementHandle();
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'chat.session_changed', session_id: 'a', field: 'busy', value: false, cursor: Date.now() } }));
    await expect.poll(() => oldAttach!.evaluate(node => node.isConnected)).toBe(false); await oldAttach!.dispose();
    await files.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(files).toHaveCount(0); await expect(attach).toBeFocused(); await expect(input(page)).toHaveValue(question);
    await expect(chips(page).getByRole('link')).toHaveCount(20);
    await attach.click(); await fromFiles.click(); await files.getByRole('checkbox', { name: /Context.pdf/ }).check();
    await files.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await expect(files).toHaveCount(0); await expect(input(page)).toBeFocused(); await expect(input(page)).toHaveValue(question);
    await expect(chips(page).getByRole('link')).toHaveCount(20); await expect(page.locator('[data-recued-chat-route-attachments]')).toContainText('Context.pdf');
    expect(f.sends).toEqual([]); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('Cancel check releases a partly completed 20-record Send immediately and keeps the draft ready for an explicit retry', async ({ page }, info) => {
  const f = await boot(page, 'new');
  try {
    const ids = Array.from({ length: 20 }, (_, i) => 'cancellable-' + String(i).padStart(2, '0'));
    for (const id of ids) f.seedNote(id, { title: 'Cancellation ' + id, body: 'Saved context.' });
    const question = ['Keep this draft.', ...Array(8).fill('Keep the question and selection.')].join('\n');
    await input(page).fill(question); await page.getByRole('button', { name: 'Add records', exact: true }).click();
    for (let i = 0; i < ids.length; i++) await choose(page, 'Cancellation ' + ids[i], i + 1, 'note');
    await use(page, 20).click(); await expect(picker(page)).toHaveCount(0); await expect(chips(page).getByRole('link')).toHaveCount(20);
    await page.getByRole('button', { name: 'Attach a file', exact: true }).click(); await page.getByRole('button', { name: 'Choose from Files', exact: true }).click();
    const files = page.getByRole('dialog', { name: 'Choose from Files', exact: true }); await files.getByRole('checkbox', { name: /Context.pdf/ }).check(); await files.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await expect(files).not.toBeVisible();
    const held = ids.slice(5); for (const id of held) f.hold('work_entity.get', id);
    f.fail('work_entity.get', ids[0]!); await input(page).evaluate((node: HTMLTextAreaElement) => { node.setSelectionRange(3, 11, 'backward'); node.scrollTop = 30; });
    await send(page).click(); await expect(checkSummary(page)).toHaveText('Checking records… 5 of 20 checked.'); await expect(send(page)).toHaveText('Checking…');
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'chat.session_changed', session_id: 'created', field: 'busy', value: false, cursor: Date.now() } }));
    await expect(send(page)).toBeDisabled(); await expect(recheck(page, 'Cancellation ' + ids[0])).toBeDisabled(); await expect(cancelCheck(page)).toBeEnabled();
    await page.screenshot({ path: info.outputPath('record-check-progress.png'), fullPage: true });
    await cancelCheck(page).focus(); await page.keyboard.press('Enter');
    await expect(send(page)).toBeEnabled(); await expect(send(page)).toHaveText('Send'); await expect(checkSummary(page)).toContainText('Check cancelled.');
    await expect(cancelCheck(page)).toHaveCount(0); await expect(input(page)).toBeFocused(); await expect(input(page)).toHaveValue(question); await expect(chips(page).getByRole('link')).toHaveCount(20);
    expect(await input(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection, node.scrollTop])).toEqual([3, 11, 'backward', 30]);
    await expect(page.locator('[data-recued-chat-route-attachments]')).toContainText('Context.pdf'); expect(f.sends).toEqual([]); expect(f.waiting()).toBe(true);
    f.fail('work_entity.get', ids[0]!, false); await send(page).click(); await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0]!.session_id).toBe('created'); expect(selectedRecordsOf(readRecordChatMessage(String(f.sends[0]!.message))!.context)).toHaveLength(20);
    expect(f.sends[0]!.attachments).toEqual([{ file_id: 'file-context', media_class: 'document', selection_revision: 'a'.repeat(64) }]);
    const before = await page.evaluate(ids => ids.map(id => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'work_entity.get:' + id).length), held);
    f.release(); await expect.poll(() => page.evaluate(ids => ids.map(id => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'work_entity.get:' + id).length), held)).toEqual(before.map(value => value + 1));
    expect(f.sends).toHaveLength(1); expect(f.accepted.size).toBe(1); await expect(input(page)).toHaveValue(''); await expect(chips(page)).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a cancelled Recheck keeps its previous problem and its old control and reply cannot cancel a newer mailbox check', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Compare both records.'); await page.getByRole('button', { name: 'Add records', exact: true }).click();
    await choose(page, 'Context note', 1, 'note'); await choose(page, 'Exact work email', 2, 'mail'); await use(page, 2).click(); await expect(picker(page)).toHaveCount(0);
    f.fail('work_entity.get', 'context-note'); f.failSource('collection.get', 'work'); await send(page).click(); await expect(checkSummary(page)).toContainText('2 records need attention');
    f.fail('work_entity.get', 'context-note', false); f.hold('work_entity.get', 'context-note'); await recheck(page, 'Context note').click(); await expect.poll(f.waiting).toBe(true);
    await expect(checkSummary(page)).toHaveText('Checking records… 0 of 1 checked.'); const oldCancel = await cancelCheck(page).elementHandle(); await cancelCheck(page).click();
    await expect(send(page)).toBeEnabled(); await expect(recheck(page, 'Context note')).toBeEnabled(); await expect(chip(page, 'Context note')).toHaveAttribute('data-chat-record-check-state', 'error'); await expect(input(page)).toBeFocused();
    f.failSource('collection.get', 'work', false); f.holdSource('collection.get', 'work'); await recheck(page, 'Exact work email').click(); await expect.poll(f.sourceWaiting).toBe(true);
    await oldCancel!.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await oldCancel!.dispose();
    await expect(checkSummary(page)).toHaveText('Checking records… 0 of 1 checked.'); await expect(send(page)).toBeDisabled();
    const before = await settledReads(page, 'context-note'); f.release(); await expect.poll(() => settledReads(page, 'context-note')).toBeGreaterThan(before);
    await expect(checkSummary(page)).toHaveText('Checking records… 0 of 1 checked.'); await expect(chip(page, 'Context note')).toHaveAttribute('data-chat-record-check-state', 'error'); await expect(send(page)).toBeDisabled();
    f.releaseSource(); await expect(recheck(page, 'Exact work email')).toHaveCount(0); await expect(cancelCheck(page)).toHaveCount(0);
    await expect(checkSummary(page)).toContainText('1 record needs attention'); await expect(input(page)).toHaveValue('Compare both records.'); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('Cancel focus survives a redraw and cancellation preserves newer typing and selection through a late read error', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Read my note.'); await addNote(page); f.fail('work_entity.get', 'context-note'); await send(page).click(); await expect(recheck(page, 'Context note')).toBeEnabled();
    f.fail('work_entity.get', 'context-note', false); f.hold('work_entity.get', 'context-note'); await recheck(page, 'Context note').click(); await expect.poll(f.waiting).toBe(true);
    await input(page).focus(); await input(page).press('End'); await input(page).pressSequentially(' With my updated question.');
    await input(page).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 6, 'backward'));
    const beforeRedraw = await cancelCheck(page).elementHandle(); await cancelCheck(page).focus();
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'chat.session_changed', session_id: 'a', field: 'busy', value: false, cursor: Date.now() } }));
    await expect.poll(() => beforeRedraw!.evaluate(node => node.isConnected)).toBe(false); await expect(cancelCheck(page)).toBeFocused();
    await beforeRedraw!.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await beforeRedraw!.dispose(); await expect(send(page)).toBeDisabled();
    await page.keyboard.press('Enter'); await expect(cancelCheck(page)).toHaveCount(0); await expect(send(page)).toBeEnabled(); await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveValue('Read my note. With my updated question.'); expect(await input(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([2, 6, 'backward']);
    f.fail('work_entity.get', 'context-note'); const before = await settledReads(page, 'context-note'); f.release(); await expect.poll(() => settledReads(page, 'context-note')).toBeGreaterThan(before);
    await expect(checkSummary(page)).toContainText('Check cancelled.'); await expect(input(page)).toBeFocused(); await expect(input(page)).toHaveValue('Read my note. With my updated question.'); expect(f.sends).toEqual([]);
    f.fail('work_entity.get', 'context-note', false); await recheck(page, 'Context note').click(); await expect(recheck(page, 'Context note')).toHaveCount(0);
    await expect(checkSummary(page)).toContainText('Choose Send'); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('navigation cancels the local Send check immediately and a returned draft can retry before the old read replies', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Question A'); await addNote(page); f.hold('work_entity.get', 'context-note'); await send(page).click(); await expect.poll(f.waiting).toBe(true);
    await expect(cancelCheck(page)).toBeVisible(); await switchTo(page, 'b'); await input(page).fill('Question B'); await switchTo(page, 'a');
    await expect(input(page)).toHaveValue('Question A'); await expect(chips(page)).toContainText('Context note'); await expect(send(page)).toBeEnabled(); await expect(cancelCheck(page)).toHaveCount(0); expect(f.waiting()).toBe(true); expect(f.sends).toEqual([]);
    await send(page).click(); await expect.poll(() => f.sends.length).toBe(1); await switchTo(page, 'b'); await expect(input(page)).toHaveValue('Question B');
    const before = await settledReads(page, 'context-note'); f.release(); await expect.poll(() => settledReads(page, 'context-note')).toBeGreaterThan(before);
    expect(f.sends).toHaveLength(1); expect(f.accepted.size).toBe(1); await expect(input(page)).toHaveValue('Question B'); await expect(chips(page)).toHaveCount(0);
  } finally { f.dispose(); }
});

test('a cached Cancel cannot affect later file validation or an admitted message', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Review both records.'); await page.getByRole('button', { name: 'Add records', exact: true }).click();
    await choose(page, 'Context note', 1, 'note'); await choose(page, 'Context task', 2, 'task'); await use(page, 2).click(); await expect(picker(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Attach a file', exact: true }).click(); await page.getByRole('button', { name: 'Choose from Files', exact: true }).click();
    const files = page.getByRole('dialog', { name: 'Choose from Files', exact: true }); await files.getByRole('checkbox', { name: /Context.pdf/ }).check(); await files.getByRole('button', { name: 'Attach 1 file', exact: true }).click(); await expect(files).not.toBeVisible();
    f.hold('work_entity.get', 'task-one'); f.hold('data.file.attachments.get', ''); await send(page).click(); await expect(checkSummary(page)).toHaveText('Checking records… 1 of 2 checked.');
    const stale = await cancelCheck(page).elementHandle(); f.release(); await expect(cancelCheck(page)).toHaveCount(0); await expect.poll(f.waiting).toBe(true);
    await stale!.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'chat.session_changed', session_id: 'a', field: 'busy', value: false, cursor: Date.now() } }));
    await expect(send(page)).toBeDisabled(); await expect(input(page)).toHaveValue('Review both records.'); expect(f.sends).toEqual([]);
    f.release(); await expect.poll(() => f.sends.length).toBe(1); await expect(input(page)).toHaveValue(''); await expect(chips(page)).toHaveCount(0);
    await stale!.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await stale!.dispose();
    expect(f.sends).toHaveLength(1); expect(f.accepted.size).toBe(1); expect(f.sends[0]!.attachments).toHaveLength(1); await expect(send(page)).toBeDisabled();
  } finally { f.dispose(); }
});

test('pasted links keep native undo, attach all record kinds explicitly, and preserve the question, caret and files', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 }); const f = await boot(page, 'new');
  try {
    await page.getByRole('button', { name: 'Attach a file', exact: true }).click(); await page.getByRole('button', { name: 'Choose from Files', exact: true }).click();
    const files = page.getByRole('dialog', { name: 'Choose from Files', exact: true }); await files.getByRole('checkbox', { name: /Context.pdf/ }).check(); await files.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await input(page).fill('Compare ');
    const hashes = ['#data/contact/' + encodeURIComponent(f.person.email), '#data/task/task-one', '#data/note/context-note', serializeSourceRecordAddress(f.source('mail')), serializeSourceRecordAddress(f.source('mail', 'home')), serializeSourceRecordAddress(f.source('calendar'))];
    const links = hashes.map(hash => recordURL(page, hash)).join('\n'), question = 'Compare ' + links;
    // Use the browser clipboard and its default paste/edit history.
    await page.evaluate(text => { const source = document.createElement('textarea'); source.id = 'paste-test-source'; source.value = text; document.body.appendChild(source); source.focus(); source.select(); }, links);
    await page.keyboard.press('ControlOrMeta+c'); await input(page).focus(); await page.keyboard.press('ControlOrMeta+v');
    await page.locator('#paste-test-source').evaluate(node => node.remove());
    await expect(input(page)).toHaveValue(question); await expect(suggestion(page)).toBeVisible();
    expect(f.reads).toEqual([]); expect(f.calls.filter(row => ['collection.get', 'collection.searchAll', 'collection.listInstances', 'collection.mail.message.get', 'collection.calendar.event.get'].includes(row.method))).toEqual([]);
    // Engines may group the prefill with the paste in a single undo step.
    await page.keyboard.press('ControlOrMeta+z'); await expect(input(page)).not.toHaveValue(question); expect(await input(page).inputValue()).not.toContain(links); await expect(suggestion(page)).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(input(page)).toHaveValue(question); await expect(suggestion(page)).toBeVisible();
    await input(page).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 7, 'backward'));
    const titles = ['Context person <img src=x>', 'Context task', 'Context note', 'Exact work email', 'Other mailbox email', 'Exact work occurrence'];
    for (let i = 0; i < titles.length; i++) {
      await attachLink(page).click(); await expect(chips(page).getByRole('link')).toHaveText(titles.slice(0, i + 1));
      await expect(input(page)).toHaveValue(question); await expect(input(page)).toBeFocused();
      expect(await input(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([3, 7, 'backward']);
    }
    await expect(suggestion(page)).toHaveCount(0); await expect(page.locator('[data-recued-chat-route-attachments]')).toContainText('Context.pdf');
    expect(f.sends).toEqual([]); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
    await previewRecord(page, 'Context note'); await expect(recordPreview(page)).toContainText('Private selected note body.'); await page.keyboard.press('Escape');
    await page.screenshot({ path: info.outputPath('pasted-records.png'), fullPage: true });
    await send(page).click(); await expect.poll(() => f.sends.length).toBe(1);
    const sent = String(f.sends[0]!.message), parsed = readRecordChatMessage(sent)!; expect(parsed.question).toBe(question);
    expect(selectedRecordsOf(parsed.context).map(row => row.reference.target.tab)).toEqual(['contact', 'task', 'note', 'mail', 'mail', 'calendar']);
    expect(f.sends[0]!.attachments).toEqual([{ file_id: 'file-context', media_class: 'document', selection_revision: 'a'.repeat(64) }]);
    expect(sent).not.toContain('Private selected note body.'); expect(sent).not.toContain('Exact work email body.'); expect(sent).not.toContain('pair=');
  } finally { f.dispose(); }
});

test('a pending pasted link blocks Send through typing and redraws, then attaches to the latest question', async ({ page }) => {
  const f = await boot(page);
  try {
    const question = 'Review ' + recordURL(page, '#data/task/task-one'); await input(page).fill(question);
    f.hold('work_entity.get', 'task-one'); await attachLink(page).click(); await expect.poll(f.waiting).toBe(true);
    await expect(attachLink(page)).toBeDisabled(); await expect(send(page)).toBeDisabled();
    await input(page).focus(); await input(page).press('End'); await input(page).pressSequentially(' with my new question');
    await input(page).press('ControlOrMeta+Enter'); expect(f.sends).toEqual([]);
    await input(page).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 6, 'backward'));
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'chat.session_changed', session_id: 'a', field: 'busy', value: false, cursor: Date.now() } }));
    await expect(send(page)).toBeDisabled(); await expect(attachLink(page)).toBeDisabled();
    expect(await input(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([2, 6, 'backward']);
    f.release(); await expect(chips(page)).toContainText('Context task'); await expect(send(page)).toBeEnabled();
    await expect(input(page)).toHaveValue(question + ' with my new question'); await expect(input(page)).toBeFocused();
    expect(await input(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([2, 6, 'backward']);
    expect(f.sends).toEqual([]);
    await input(page).fill(question + '\n' + recordURL(page, '#data/note/context-note'));
    f.hold('work_entity.get', 'context-note'); await attachLink(page).click(); await expect.poll(f.waiting).toBe(true);
    const otherControl = page.getByRole('button', { name: 'Add records', exact: true }); await otherControl.focus();
    f.release(); await expect(chips(page)).toContainText('Context note'); await expect(otherControl).toBeFocused();
  } finally { f.dispose(); }
});

test('pasted link errors retry explicitly, while ordinary links and dismissal leave draft text alone', async ({ page }) => {
  const f = await boot(page);
  try {
    const ordinary = 'https://example.test/#data/task/task-one ' + recordURL(page, '#data/files/file-one');
    await input(page).fill(ordinary); await expect(suggestion(page)).toHaveCount(0); expect(f.reads).toEqual([]); expect(f.calls.filter(row => ['collection.get', 'collection.searchAll', 'collection.listInstances', 'collection.mail.message.get', 'collection.calendar.event.get'].includes(row.method))).toEqual([]);
    const question = 'Review ' + recordURL(page, '#data/note/context-note'); await input(page).fill(question);
    await suggestion(page).getByRole('button', { name: 'Dismiss', exact: true }).click(); await expect(suggestion(page)).toHaveCount(0); await expect(input(page)).toHaveValue(question); expect(f.reads).toEqual([]);
    await input(page).fill(''); await input(page).fill(question); f.fail('work_entity.get', 'context-note');
    await attachLink(page).click(); await expect(suggestion(page).getByRole('alert')).toContainText('could not be attached'); await expect(send(page)).toBeEnabled();
    f.fail('work_entity.get', 'context-note', false); f.removeNote('context-note'); await attachLink(page).click(); await expect(suggestion(page).getByRole('alert')).toContainText('no longer available');
    f.seedNote('context-note', { title: 'Available again', body: 'Restored note body.' }); await attachLink(page).click(); await expect(chips(page)).toContainText('Available again'); await expect(input(page)).toHaveValue(question);
    expect(f.sends).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('a delayed pasted link cannot cross a conversation round trip or act through detached controls', async ({ page }) => {
  const f = await boot(page);
  try {
    const question = 'Question A ' + recordURL(page, '#data/task/task-one'); await input(page).fill(question);
    const oldAttach = await attachLink(page).elementHandle(); f.hold('work_entity.get', 'task-one'); await attachLink(page).click(); await expect.poll(f.waiting).toBe(true);
    await switchTo(page, 'b'); await input(page).fill('Question B ' + recordURL(page, '#data/note/context-note')); await attachLink(page).click(); await expect(chips(page)).toContainText('Context note');
    await oldAttach!.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await oldAttach!.dispose();
    await switchTo(page, 'a'); await expect(input(page)).toHaveValue(question); await expect(send(page)).toBeEnabled();
    const before = await settledReads(page, 'task-one'); f.release(); await expect.poll(() => settledReads(page, 'task-one')).toBeGreaterThan(before);
    await expect(chips(page)).toHaveCount(0); await expect(attachLink(page)).toBeEnabled(); expect(f.sends).toEqual([]);
    await attachLink(page).click(); await expect(chips(page)).toContainText('Context task');
    await switchTo(page, 'b'); await expect(chips(page).getByRole('link')).toHaveText(['Context note']);
  } finally { f.dispose(); }
});

test('editing away a pending link cancels it and its late reply cannot finish a newer attachment', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill(recordURL(page, '#data/task/task-one')); f.hold('work_entity.get', 'task-one'); await attachLink(page).click(); await expect.poll(f.waiting).toBe(true);
    await input(page).fill('Now review ' + recordURL(page, serializeSourceRecordAddress(f.source('mail', 'home')))); f.holdSource('collection.get', 'home'); await attachLink(page).click(); await expect.poll(f.sourceWaiting).toBe(true);
    const before = await settledReads(page, 'task-one'); f.release(); await expect.poll(() => settledReads(page, 'task-one')).toBeGreaterThan(before);
    await expect(chips(page)).toHaveCount(0); await expect(send(page)).toBeDisabled(); await expect(attachLink(page)).toBeDisabled();
    f.releaseSource(); await expect(chips(page).getByRole('link')).toHaveText(['Other mailbox email']); await expect(send(page)).toBeEnabled(); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('pasted duplicates preserve strong pins and the accepted submission when its acknowledgement is lost', async ({ page }) => {
  const f = await boot(page, 'a', true);
  try {
    const link = recordURL(page, serializeSourceRecordAddress(f.source('calendar')));
    await input(page).fill('Review ' + link); await page.getByRole('button', { name: 'Add records', exact: true }).click();
    await picker(page).getByRole('region', { name: 'Pinned', exact: true }).getByRole('button', { name: 'Select link to Exact work occurrence', exact: true }).click(); await use(page, 1).click();
    await expect(suggestion(page)).toHaveCount(0); f.replaceCalendar(); await send(page).click(); await expect(chips(page)).toContainText('could not be checked'); expect(f.sends).toEqual([]);
    await chips(page).getByRole('button', { name: 'Remove Exact work occurrence from chat', exact: true }).click();
    await attachLink(page).click(); await expect(chips(page)).toContainText('Exact work occurrence');
    f.loseNextReply(); await send(page).click(); await expect.poll(() => f.sends.length).toBe(1); await expect(page.locator('[data-recued-chat-route-error]')).toBeVisible();
    await expect(suggestion(page)).toHaveCount(0); f.remove('calendar', 'work', f.eventId);
    const reads = f.calls.length; await send(page).click(); await expect.poll(() => f.sends.length).toBe(2);
    expect(f.sends[1]).toEqual(f.sends[0]); expect(f.accepted.size).toBe(1); expect(f.calls.length).toBe(reads);
  } finally { f.dispose(); }
});

test('reconnect restores a pasted draft suggestion and discards the old pending lookup', async ({ page }) => {
  const f = await boot(page, 'a', false, 'reauth');
  try {
    const question = 'Review ' + recordURL(page, '#data/task/task-one'); await input(page).fill(question);
    f.hold('work_entity.get', 'task-one'); await attachLink(page).click(); await expect.poll(f.waiting).toBe(true);
    await page.evaluate(() => window.__app.forceReauth()); const form = page.getByRole('form', { name: 'Reconnect this browser', exact: true }); await expect(form).toBeVisible();
    await form.locator('#webclient-pair-code-input-code').fill('PAIR5678'); await form.locator('#webclient-pair-code-input-recovery-0').fill(`${Array(23).fill('abandon').join(' ')} art`); await form.getByRole('button', { name: /^Reconnect (?:this browser|in this tab)$/ }).click();
    await expect(input(page)).toHaveValue(question); await expect(attachLink(page)).toBeEnabled(); await expect(send(page)).toBeEnabled();
    const before = await settledReads(page, 'task-one'); f.release(); await expect.poll(() => settledReads(page, 'task-one')).toBeGreaterThan(before);
    await expect(chips(page)).toHaveCount(0); expect(f.sends).toEqual([]);
    await attachLink(page).click(); await expect(chips(page)).toContainText('Context task');
  } finally { f.dispose(); }
});

test('record checks report every failure, focus the first problem and repair one chip without changing the draft or files', async ({ page }, info) => {
  const f = await boot(page);
  try {
    const question = ('Compare these records.\n' + 'Keep this question and its selection.\n'.repeat(12)).trimEnd(); await input(page).fill(question);
    await page.getByRole('button', { name: 'Add records', exact: true }).click();
    await choose(page, 'Context note', 1, 'note'); await choose(page, 'Context task', 2, 'task'); await choose(page, 'Context person <img src=x>', 3, 'contact'); await use(page, 3).click();
    await page.getByRole('button', { name: 'Attach a file', exact: true }).click(); await page.getByRole('button', { name: 'Choose from Files', exact: true }).click();
    const files = page.getByRole('dialog', { name: 'Choose from Files', exact: true }); await files.getByRole('checkbox', { name: /Context.pdf/ }).check(); await files.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await input(page).evaluate((node: HTMLTextAreaElement) => { node.setSelectionRange(3, 11, 'backward'); node.scrollTop = 30; });
    const before = f.reads.length; f.fail('work_entity.get', 'context-note'); f.replaceTask(); await send(page).click();
    await expect(checkSummary(page)).toContainText('2 records need attention'); await expect(recheck(page, 'Context note')).toBeFocused();
    await expect(chip(page, 'Context note')).toHaveAttribute('data-chat-record-check-state', 'error');
    await expect(chip(page, 'Context task')).toHaveAttribute('data-chat-record-check-state', 'missing');
    await expect(chip(page, 'Context person <img src=x>')).not.toHaveAttribute('data-chat-record-check-state');
    expect(f.reads.slice(before).map(row => row.id)).toEqual(expect.arrayContaining(['context-note', 'task-one', f.person.contact_id]));
    await expect(input(page)).toHaveValue(question); expect(await input(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection, node.scrollTop])).toEqual([3, 11, 'backward', 30]);
    await expect(page.locator('[data-recued-chat-route-attachments]')).toContainText('Context.pdf'); expect(f.sends).toEqual([]);
    await page.screenshot({ path: info.outputPath('record-check-problems.png'), fullPage: true });
    f.fail('work_entity.get', 'context-note', false); const retryReads = f.reads.length; await recheck(page, 'Context note').click();
    await expect(recheck(page, 'Context note')).toHaveCount(0); await expect(checkSummary(page)).toContainText('1 record needs attention');
    await expect(chip(page, 'Context note').getByRole('button', { name: 'Remove Context note from chat', exact: true })).toBeFocused();
    expect(f.reads.slice(retryReads).length).toBeGreaterThan(0); expect(f.reads.slice(retryReads).every(row => row.method === 'work_entity.get' && row.id === 'context-note')).toBe(true);
    expect(f.sends).toEqual([]); await chip(page, 'Context task').getByRole('button', { name: 'Remove Context task from chat', exact: true }).click();
    await expect(checkSummary(page)).toContainText('Choose Send'); await expect(input(page)).toHaveValue(question);
    await send(page).click(); await expect.poll(() => f.sends.length).toBe(1);
    const parsed = readRecordChatMessage(String(f.sends[0]!.message))!; expect(parsed.question).toBe(question);
    expect(selectedRecordsOf(parsed.context).map(row => row.reference.target.tab)).toEqual(['note', 'contact']);
    expect(f.sends[0]!.attachments).toEqual([{ file_id: 'file-context', media_class: 'document', selection_revision: 'a'.repeat(64) }]);
  } finally { f.dispose(); }
});

test('a slow Recheck preserves continued typing and moved focus, blocks Send, and never replaces the fresh Send check', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Read my note.'); await addNote(page); f.fail('work_entity.get', 'context-note'); await send(page).click(); await expect(recheck(page, 'Context note')).toBeEnabled();
    f.fail('work_entity.get', 'context-note', false); f.hold('work_entity.get', 'context-note'); await recheck(page, 'Context note').click(); await expect.poll(f.waiting).toBe(true);
    await expect(send(page)).toBeDisabled(); await expect(recheck(page, 'Context note')).toBeDisabled();
    await input(page).focus(); await input(page).press('End'); await input(page).pressSequentially(' With a new question.'); await input(page).press('ControlOrMeta+Enter'); expect(f.sends).toEqual([]);
    await input(page).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 6, 'backward'));
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'chat.session_changed', session_id: 'a', field: 'busy', value: false, cursor: Date.now() } }));
    await expect(send(page)).toBeDisabled(); await expect(recheck(page, 'Context note')).toBeDisabled();
    const elsewhere = page.getByRole('button', { name: 'Add records', exact: true }); await elsewhere.focus(); f.release();
    await expect(recheck(page, 'Context note')).toHaveCount(0); await expect(elsewhere).toBeFocused(); await expect(send(page)).toBeEnabled();
    await expect(input(page)).toHaveValue('Read my note. With a new question.'); expect(await input(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([2, 6, 'backward']); expect(f.sends).toEqual([]);
    f.removeNote('context-note'); await send(page).click(); await expect(chip(page, 'Context note')).toHaveAttribute('data-chat-record-check-state', 'missing'); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('removing a checking chip retires its reply and detached Recheck cannot affect a newer selection at the same address', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Read my note.'); await addNote(page); f.fail('work_entity.get', 'context-note'); await send(page).click(); await expect(recheck(page, 'Context note')).toBeEnabled();
    const stale = await recheck(page, 'Context note').elementHandle(); f.fail('work_entity.get', 'context-note', false); f.hold('work_entity.get', 'context-note');
    await recheck(page, 'Context note').click(); await expect.poll(f.waiting).toBe(true);
    await chip(page, 'Context note').getByRole('button', { name: 'Remove Context note from chat', exact: true }).click(); await expect(chips(page)).toHaveCount(0); await expect(send(page)).toBeEnabled();
    await addNote(page); f.fail('work_entity.get', 'context-note'); await send(page).click(); await expect(chip(page, 'Context note')).toHaveAttribute('data-chat-record-check-state', 'error');
    f.fail('work_entity.get', 'context-note', false); const before = await settledReads(page, 'context-note'); f.release(); await expect.poll(() => settledReads(page, 'context-note')).toBeGreaterThan(before);
    await expect(chip(page, 'Context note')).toHaveAttribute('data-chat-record-check-state', 'error');
    const reads = f.reads.length; await stale!.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await stale!.dispose(); expect(f.reads.length).toBe(reads);
    await expect(input(page)).toHaveValue('Read my note.'); expect(f.sends).toEqual([]);
    await recheck(page, 'Context note').click(); await expect(recheck(page, 'Context note')).toHaveCount(0); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('completed check problems stay with each draft while a pending Recheck is cancelled by a conversation round trip', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Question A'); await addNote(page); f.fail('work_entity.get', 'context-note'); await send(page).click(); await expect(recheck(page, 'Context note')).toBeEnabled();
    f.fail('work_entity.get', 'context-note', false); f.hold('work_entity.get', 'context-note'); await recheck(page, 'Context note').click(); await expect.poll(f.waiting).toBe(true);
    await switchTo(page, 'b'); await input(page).fill('Question B'); await page.getByRole('button', { name: 'Add records', exact: true }).click(); await choose(page, 'Context task', 1, 'task'); await use(page, 1).click();
    await expect(picker(page)).toHaveCount(0); f.replaceTask(); await send(page).click(); await expect(chip(page, 'Context task')).toHaveAttribute('data-chat-record-check-state', 'missing');
    await switchTo(page, 'a'); await expect(input(page)).toHaveValue('Question A'); await expect(chip(page, 'Context note')).toHaveAttribute('data-chat-record-check-state', 'error'); await expect(recheck(page, 'Context note')).toBeEnabled();
    const elsewhere = page.getByRole('button', { name: 'Add records', exact: true }); await elsewhere.focus();
    const before = await settledReads(page, 'context-note'); f.release(); await expect.poll(() => settledReads(page, 'context-note')).toBeGreaterThan(before);
    await expect(chip(page, 'Context note')).toHaveAttribute('data-chat-record-check-state', 'error'); await expect(elsewhere).toBeFocused();
    await switchTo(page, 'b'); await expect(input(page)).toHaveValue('Question B'); await expect(chip(page, 'Context task')).toHaveAttribute('data-chat-record-check-state', 'missing'); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('record checks keep mailbox addresses distinct and a failed pinned calendar Recheck cannot downgrade its identity', async ({ page }) => {
  const f = await boot(page, 'a', true);
  try {
    await input(page).fill('Compare these accounts.'); await page.getByRole('button', { name: 'Add records', exact: true }).click();
    await picker(page).getByRole('region', { name: 'Pinned', exact: true }).getByRole('button', { name: 'Select link to Exact work occurrence', exact: true }).click();
    await choose(page, 'Exact work email', 2, 'mail'); await choose(page, 'Other mailbox email', 3, 'mail'); await use(page, 3).click(); await expect(picker(page)).toHaveCount(0); await expect(chips(page).getByRole('link')).toHaveCount(3);
    f.replaceCalendar(); f.failSource('collection.get', 'work'); f.remove('mail', 'home', f.mailId);
    await send(page).click(); await expect(checkSummary(page)).toContainText('3 records need attention');
    await expect(chip(page, 'Other mailbox email')).toHaveAttribute('data-chat-record-check-state', 'missing');
    await expect(chip(page, 'Exact work email')).toHaveAttribute('data-chat-record-check-state', 'error'); await expect(chip(page, 'Exact work occurrence')).toHaveAttribute('data-chat-record-check-state', 'error'); expect(f.sends).toEqual([]);
    f.failSource('collection.get', 'work', false); const calls = f.calls.length; await recheck(page, 'Exact work email').click(); await expect(recheck(page, 'Exact work email')).toHaveCount(0);
    const reads = f.calls.slice(calls).filter(row => row.method === 'collection.get'); expect(reads.length).toBeGreaterThan(0); expect(reads.every(row => row.args.platform === 'mail' && row.args.slug === 'work' && row.args.record_id === f.mailId)).toBe(true);
    await expect(chip(page, 'Other mailbox email')).toHaveAttribute('data-chat-record-check-state', 'missing');
    await recheck(page, 'Exact work occurrence').click(); await expect(recheck(page, 'Exact work occurrence')).toBeEnabled();
    await expect(chip(page, 'Exact work occurrence')).toHaveAttribute('data-chat-record-check-state', 'error'); await expect(checkSummary(page)).toContainText('2 records need attention'); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('reconnect keeps the selected draft and ignores the retired Recheck after the new route reports a problem', async ({ page }) => {
  const f = await boot(page, 'a', false, 'reauth');
  try {
    await input(page).fill('Keep this draft.'); await addNote(page); f.fail('work_entity.get', 'context-note'); await send(page).click(); await expect(recheck(page, 'Context note')).toBeEnabled();
    f.fail('work_entity.get', 'context-note', false); f.hold('work_entity.get', 'context-note'); await recheck(page, 'Context note').click(); await expect.poll(f.waiting).toBe(true);
    await page.evaluate(() => window.__app.forceReauth()); const form = page.getByRole('form', { name: 'Reconnect this browser', exact: true }); await expect(form).toBeVisible();
    await form.locator('#webclient-pair-code-input-code').fill('PAIR5678'); await form.locator('#webclient-pair-code-input-recovery-0').fill(`${Array(23).fill('abandon').join(' ')} art`); await form.getByRole('button', { name: /^Reconnect (?:this browser|in this tab)$/ }).click();
    await expect(input(page)).toHaveValue('Keep this draft.'); await expect(chips(page)).toContainText('Context note'); await expect(recheck(page, 'Context note')).toHaveCount(0);
    f.fail('work_entity.get', 'context-note'); await send(page).click(); await expect(chip(page, 'Context note')).toHaveAttribute('data-chat-record-check-state', 'error');
    f.fail('work_entity.get', 'context-note', false); const before = await settledReads(page, 'context-note'); f.release(); await expect.poll(() => settledReads(page, 'context-note')).toBeGreaterThan(before);
    await expect(chip(page, 'Context note')).toHaveAttribute('data-chat-record-check-state', 'error'); expect(f.sends).toEqual([]);
    await recheck(page, 'Context note').click(); await expect(recheck(page, 'Context note')).toHaveCount(0); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('a record selection edited during a later file check cancels that admission and waits for another explicit Send', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Review these records.'); await page.getByRole('button', { name: 'Add records', exact: true }).click();
    await choose(page, 'Context note', 1, 'note'); await choose(page, 'Context task', 2, 'task'); await use(page, 2).click(); await expect(picker(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Attach a file', exact: true }).click(); await page.getByRole('button', { name: 'Choose from Files', exact: true }).click();
    const files = page.getByRole('dialog', { name: 'Choose from Files', exact: true }); await files.getByRole('checkbox', { name: /Context.pdf/ }).check(); await files.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    f.hold('data.file.attachments.get', ''); await send(page).click(); await expect.poll(f.waiting).toBe(true);
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'chat.session_changed', session_id: 'a', field: 'busy', value: false, cursor: Date.now() } }));
    await chip(page, 'Context note').getByRole('button', { name: 'Remove Context note from chat', exact: true }).click();
    const beforeRelease = await input(page).elementHandle(); f.release(); await expect.poll(() => beforeRelease!.evaluate(node => node.isConnected)).toBe(false); await beforeRelease!.dispose();
    expect(f.sends).toEqual([]); await expect(input(page)).toHaveValue('Review these records.'); await expect(chips(page).getByRole('link')).toHaveText(['Context task']); await expect(page.locator('[data-recued-chat-route-attachments]')).toContainText('Context.pdf');
    await send(page).click(); await expect.poll(() => f.sends.length).toBe(1);
    expect(selectedRecordsOf(readRecordChatMessage(String(f.sends[0]!.message))!.context)[0]!.reference.target.hash).toBe('#data/task/task-one'); expect(f.sends[0]!.attachments).toHaveLength(1);
  } finally { f.dispose(); }
});

test('new Chat collects all record types, previews contents on demand, and sends exact references only on Send', async ({ page }, info) => {
  const f = await boot(page, 'new');
  try {
    await expect(input(page)).toBeFocused();
    await input(page).fill('Compare these records.'); await input(page).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 7, 'backward'));
    await page.getByRole('button', { name: 'Add records', exact: true }).click();
    await expect(picker(page).getByRole('heading', { name: 'Add records to Chat', exact: true })).toBeVisible();
    const titles = ['Context person <img src=x>', 'Context task', 'Context note', 'Exact work email', 'Other mailbox email', 'Exact work occurrence'];
    for (let i = 0; i < titles.length; i++) await choose(page, titles[i]!, i + 1);
    await query(page).fill('no matching records'); await query(page).press('Enter');
    const selection = picker(page).getByRole('region', { name: 'Selected records', exact: true }); await selection.locator('summary').click();
    await selection.getByRole('button', { name: 'Preview Context note', exact: true }).click();
    await expect(picker(page).locator('[data-record-result-preview-panel]')).toContainText('Private selected note body.');
    await page.keyboard.press('Escape'); await expect(selection.getByRole('button', { name: 'Preview Context note', exact: true })).toBeFocused();
    expect(f.sends).toEqual([]); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
    await use(page, 6).click(); await expect(picker(page)).toHaveCount(0); await expect(input(page)).toHaveValue('Compare these records.'); await expect(input(page)).toBeFocused();
    expect(await input(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([3, 7, 'backward']);
    await expect(chips(page).getByRole('link')).toHaveText(titles); await expect(chips(page).locator('img,script')).toHaveCount(0); await expect(chips(page)).not.toContainText('Private selected note body.');
    const expectedDetails = ['riley@example.test', 'Bring the launch agenda.', 'Private selected note body.', 'Account: work', 'Account: home', 'Keep the event context.'];
    for (let i = 0; i < titles.length; i++) {
      await previewRecord(page, titles[i]!); await expect(recordPreview(page)).toContainText(expectedDetails[i]!);
      await expect(recordPreview(page).locator('img,script')).toHaveCount(0); expect(f.sends).toEqual([]);
      if (i === 0) {
        await page.keyboard.press('Shift+Tab'); await expect(recordPreview(page).getByRole('button', { name: 'Remove from chat', exact: true })).toBeFocused();
        await page.keyboard.press('Tab'); await expect(recordPreview(page).getByRole('button', { name: 'Close preview', exact: true })).toBeFocused();
      }
      await page.keyboard.press('Escape'); await expect(chips(page).getByRole('button', { name: 'Preview ' + titles[i], exact: true })).toBeFocused();
      expect(await input(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([3, 7, 'backward']);
    }
    await page.screenshot({ path: info.outputPath('chat-records.png'), fullPage: true });
    const before = f.reads.length; await send(page).click(); await expect.poll(() => f.sends.length).toBe(1); await expect(chips(page)).toHaveCount(0); await expect(input(page)).toHaveValue(''); expect(f.reads.length).toBeGreaterThan(before);
    const sent = String(f.sends[0]!.message), parsed = readRecordChatMessage(sent)!; expect(parsed.question).toBe('Compare these records.');
    const records = selectedRecordsOf(parsed.context); expect(records.map(row => row.reference.target.tab)).toEqual(['contact', 'task', 'note', 'mail', 'mail', 'calendar']);
    expect(records.filter(row => row.reference.target.tab === 'mail').map(row => row.reference.target.hash)).toEqual([serializeSourceRecordAddress(f.source('mail')), serializeSourceRecordAddress(f.source('mail', 'home'))]);
    expect(sent).not.toContain('Private selected note body.'); expect(sent).not.toContain('Exact work email body.'); expect(sent).not.toContain('Meeting room 2'); expect(sent).not.toContain('pair=');
    await switchTo(page, 'b'); await switchTo(page, 'created'); await expect(page.locator('[data-chat-records-question]')).toContainText('Compare these records.');
    await expect(page.locator('[data-chat-records-question]').getByRole('list').getByRole('link')).toHaveCount(6);
  } finally { f.dispose(); }
});


test('searches and attaches a Yours asset with other records and checks its identity again before Send', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Review these records together.');
    await addNote(page);
    const title = f.yoursAsset.name;
    const openAssets = async () => {
      await page.getByRole('button', { name: 'Add records', exact: true }).click();
      await picker(page).getByRole('combobox', { name: 'Record type', exact: true }).selectOption({ label: 'Yours assets' });
      await query(page).fill('calibration');
      await query(page).press('Enter');
    };
    const assetResult = () => picker(page).getByRole('region', { name: 'Yours assets', exact: true });
    const chooseAsset = async () => {
      await assetResult().getByRole('button', { name: 'Select link to ' + title, exact: true }).click();
      await expect(use(page, 2)).toBeEnabled();
      await use(page, 2).click();
      await expect(picker(page)).toHaveCount(0);
      await expect(chip(page, title).getByRole('link')).toHaveAttribute('href', '#yours/asset/' + f.yoursAsset.id);
    };

    await openAssets();
    await expect(assetResult()).toContainText(title);
    await expect(assetResult()).toContainText('Equipment');
    await assetResult().getByRole('button', { name: 'Preview ' + title, exact: true }).click();
    const preview = picker(page).getByRole('region', { name: 'Record preview', exact: true });
    await expect(preview).toContainText('Status: active');
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
    expect(f.yoursReads).toContainEqual({ search: 'calibration', offset: 0, limit: 20, pursuits: 'exclude', mark_shown: false });
    await chooseAsset();
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveValue('Review these records together.');

    f.replaceYoursAsset();
    await send(page).click();
    await expect(chip(page, title)).toContainText('removed or replaced');
    expect(f.sends).toEqual([]);
    await chip(page, title).getByRole('button', { name: 'Remove ' + title + ' from chat', exact: true }).click();
    await openAssets();
    await chooseAsset();
    await send(page).click();
    await expect.poll(() => f.sends.length).toBe(1);

    const message = String(f.sends[0]!.message);
    const parsed = readRecordChatMessage(message)!;
    expect(parsed.question).toBe('Review these records together.');
    expect(selectedRecordsOf(parsed.context).map(row => row.reference.target.tab)).toEqual(['note', 'asset']);
    expect(message).toContain(JSON.stringify({ kind: 'asset', id: f.yoursAsset.id, created_at: f.yoursAsset.created_at }));
    expect(message).toContain('use work.read');
    expect(message).not.toContain(title);
    expect(message).not.toContain(f.yoursAsset.serial_number);
    const exactReads = f.yoursReads.filter(read => read.asset_id === f.yoursAsset.id);
    expect(exactReads.length).toBeGreaterThan(0);
    expect(exactReads.every(read => read.mark_shown === false)).toBe(true);
    await switchTo(page, 'b');
    await switchTo(page, 'a');
    const sentAsset = page.locator('[data-chat-records-question]').getByRole('link', { name: 'Selected asset', exact: true });
    await expect(sentAsset).toHaveAttribute('href', '#yours/asset/' + f.yoursAsset.id);
    expect(f.writes).toEqual([]);
    expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('record selections stay with each conversation and can be edited or cleared without changing the question', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Question A'); await addNote(page); await switchTo(page, 'b'); await expect(chips(page)).toHaveCount(0); await expect(input(page)).toHaveValue('');
    await input(page).fill('Question B'); await page.getByRole('button', { name: 'Add records', exact: true }).click(); await choose(page, 'Context task', 1, 'task'); await use(page, 1).click();
    await switchTo(page, 'a'); await expect(input(page)).toHaveValue('Question A'); await expect(chips(page)).toContainText('Context note'); await expect(chips(page)).not.toContainText('Context task');
    await page.getByRole('button', { name: 'Add records', exact: true }).click(); await expect(use(page, 1)).toBeEnabled();
    await query(page).fill('Context task'); await query(page).press('Enter'); await query(page).focus();
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'chat.session_changed', session_id: 'a', field: 'busy', value: false, cursor: 1 } }));
    await expect(query(page)).toBeFocused(); await expect(query(page)).toHaveValue('Context task'); await expect(use(page, 1)).toBeEnabled();
    await choose(page, 'Context task', 2, 'task'); await use(page, 2).click();
    const detached = await chips(page).getByRole('button', { name: 'Remove Context note from chat', exact: true }).elementHandle();
    await switchTo(page, 'b'); await detached!.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await detached!.dispose();
    await expect(input(page)).toHaveValue('Question B'); await expect(chips(page).getByRole('link')).toHaveText(['Context task']);
    await switchTo(page, 'a'); await chips(page).getByRole('button', { name: 'Remove Context task from chat', exact: true }).click(); await expect(chips(page).getByRole('link')).toHaveText(['Context note']);
    await page.getByRole('button', { name: 'Add records', exact: true }).click();
    await picker(page).getByRole('button', { name: 'Clear selection', exact: true }).click(); await use(page, 0).click(); await expect(chips(page)).toHaveCount(0); await expect(input(page)).toHaveValue('Question A'); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('Send retries interrupted reads, then blocks the entire draft when a selected record was replaced', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Compare both.'); await page.getByRole('button', { name: 'Add records', exact: true }).click(); await choose(page, 'Context note', 1, 'note'); await choose(page, 'Context task', 2, 'task'); await use(page, 2).click();
    f.fail('work_entity.get', 'context-note'); await send(page).click(); await expect(chips(page)).toContainText('could not be checked'); expect(f.sends).toEqual([]); await expect(chips(page).getByRole('link')).toHaveCount(2);
    f.fail('work_entity.get', 'context-note', false); f.replaceTask(); await send(page).click(); await expect(chip(page, 'Context task')).toContainText('removed or replaced'); expect(f.sends).toEqual([]); await expect(input(page)).toHaveValue('Compare both.');
    await chips(page).getByRole('button', { name: 'Remove Context task from chat', exact: true }).click(); await send(page).click(); await expect.poll(() => f.sends.length).toBe(1); expect(selectedRecordsOf(readRecordChatMessage(String(f.sends[0]!.message))!.context)).toHaveLength(1);
  } finally { f.dispose(); }
});

test('leaving and returning during a slow record check cancels that send and keeps the draft', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Keep this draft.'); await addNote(page); f.hold('work_entity.get', 'context-note'); await send(page).click(); await expect.poll(f.waiting).toBe(true);
    await switchTo(page, 'b'); await input(page).fill('Other question'); await switchTo(page, 'a'); await expect(input(page)).toHaveValue('Keep this draft.');
    f.release(); await expect(send(page)).toBeEnabled(); expect(f.sends).toEqual([]); await expect(chips(page)).toContainText('Context note');
    await send(page).click(); await expect.poll(() => f.sends.length).toBe(1);
  } finally { f.dispose(); }
});

test('an identical retry after a lost send acknowledgement retains its submission even if the record was deleted', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Read my note.'); await addNote(page); f.loseNextReply(); await send(page).click(); await expect.poll(() => f.sends.length).toBe(1); await expect(page.locator('[data-recued-chat-route-error]')).toBeVisible(); await expect(chips(page)).toContainText('Context note');
    await previewRecord(page, 'Context note'); await page.keyboard.press('Escape');
    f.removeNote('context-note'); await input(page).fill('A different question'); await send(page).click();
    await expect(chip(page, 'Context note')).toHaveAttribute('data-chat-record-check-state', 'missing'); expect(f.sends).toHaveLength(1);
    await input(page).fill('Read my note.'); const reads = f.reads.length; await send(page).click(); await expect.poll(() => f.sends.length).toBe(2); expect(f.sends[1]).toEqual(f.sends[0]); expect(f.accepted.size).toBe(1); expect(f.reads.length).toBe(reads); await expect(chips(page)).toHaveCount(0); await expect(input(page)).toHaveValue('');
  } finally { f.dispose(); }
});

test('a pinned calendar selection keeps its account incarnation through the Chat picker', async ({ page }) => {
  const f = await boot(page, 'a', true);
  try {
    await input(page).fill('Prepare for this meeting.'); await page.getByRole('button', { name: 'Add records', exact: true }).click();
    await picker(page).getByRole('region', { name: 'Pinned', exact: true }).getByRole('button', { name: 'Select link to Exact work occurrence', exact: true }).click(); await expect(use(page, 1)).toBeEnabled(); await use(page, 1).click();
    f.replaceCalendar(); await send(page).click(); await expect(chips(page)).toContainText('could not be checked'); expect(f.sends).toEqual([]); await expect(chips(page)).toContainText('Exact work occurrence');
  } finally { f.dispose(); }
});

test('reconnecting restores active and parked record selections beside exact file attachments', async ({ page }) => {
  const f = await boot(page, 'a', false, 'reauth');
  try {
    await input(page).fill('Question A with a file'); await addNote(page);
    await page.getByRole('button', { name: 'Attach a file', exact: true }).click(); await page.getByRole('button', { name: 'Choose from Files', exact: true }).click();
    const files = page.getByRole('dialog', { name: 'Choose from Files', exact: true }); await files.getByRole('checkbox', { name: /Context.pdf/ }).check(); await files.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await switchTo(page, 'b'); await input(page).fill('Question B'); await page.getByRole('button', { name: 'Add records', exact: true }).click(); await choose(page, 'Context task', 1, 'task'); await use(page, 1).click();
    f.hold('work_entity.get', 'task-one'); await chips(page).getByRole('button', { name: 'Preview Context task', exact: true }).click(); await expect.poll(f.waiting).toBe(true);
    await page.evaluate(() => window.__app.forceReauth()); await expect(recordPreview(page)).toHaveCount(0); const form = page.getByRole('form', { name: 'Reconnect this browser', exact: true }); await expect(form).toBeVisible();
    await form.locator('#webclient-pair-code-input-code').fill('PAIR5678'); await form.locator('#webclient-pair-code-input-recovery-0').fill(`${Array(23).fill('abandon').join(' ')} art`); await form.getByRole('button', { name: /^Reconnect (?:this browser|in this tab)$/ }).click();
    await expect(input(page)).toHaveValue('Question B'); await expect(chips(page).getByRole('link')).toHaveText(['Context task']); const beforeRepairRead = await settledReads(page, 'task-one'); f.release(); await expect.poll(() => settledReads(page, 'task-one')).toBeGreaterThan(beforeRepairRead); await expect(recordPreview(page)).toHaveCount(0); expect(f.sends).toEqual([]);
    await switchTo(page, 'a'); await expect(input(page)).toHaveValue('Question A with a file'); await expect(chips(page).getByRole('link')).toHaveText(['Context note']); await expect(page.locator('[data-recued-chat-route-attachments]')).toContainText('Context.pdf');
    f.hold('data.file.attachments.get', ''); await send(page).click(); await expect.poll(f.waiting).toBe(true);
    await switchTo(page, 'b'); await switchTo(page, 'a'); f.release(); await expect(send(page)).toBeEnabled(); expect(f.sends).toEqual([]);
    await send(page).click(); await expect.poll(() => f.sends.length).toBe(1); expect(f.sends[0]!.attachments).toEqual([{ file_id: 'file-context', media_class: 'document', selection_revision: 'a'.repeat(64) }]); expect(selectedRecordsOf(readRecordChatMessage(String(f.sends[0]!.message))!.context)[0]!.reference.target.hash).toBe('#data/note/context-note');
    await switchTo(page, 'b'); await expect(chips(page).getByRole('link')).toHaveText(['Context task']); await expect(input(page)).toHaveValue('Question B');
  } finally { f.dispose(); }
});

test('Ask again preserves a record-only composer draft and explains why it cannot send yet', async ({ page }) => {
  const f = await installTaskNoteSourceFixture(page, { searchable: true });
  try {
    f.seedNote('context-note', { title: 'Context note', body: 'Private selected note body.' });
    await page.goto(HARNESS_URL + '?chat=session&chat_steps=1&yours=demo#chat/session/chat_1'); await page.waitForFunction(() => window.__app?.ready === true);
    await addNote(page); await expect(input(page)).toHaveValue('');
    await page.evaluate(() => {
      Object.assign(window, { __chatStepsLanded: [{ kind: 'thing', id: 'passport' }] });
      window.__app.fireMessage({ type: 'server_event', event: { kind: 'warehouse', collection: 'asset', op: 'insert', id: 'asset-new', cursor: Date.now() } });
    });
    const fixes = page.locator('[data-chat-fixes]'); await fixes.getByRole('button', { name: 'Ask again', exact: true }).click();
    await expect(fixes.getByRole('alert')).toHaveText('Send or clear the message you are writing, then ask again.');
    expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0); await expect(chips(page)).toContainText('Context note');
  } finally { f.dispose(); }
});

test('chip previews preserve the question, files, caret and reading position across a redraw and removal', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); const f = await boot(page, 'a', false, 'verification', 60);
  try {
    const question = Array.from({ length: 30 }, (_, i) => 'Keep this question line ' + i).join('\n'); await input(page).fill(question);
    await page.getByRole('button', { name: 'Add records', exact: true }).click(); await choose(page, 'Context note', 1, 'note'); await choose(page, 'Context task', 2, 'task'); await use(page, 2).click();
    await page.getByRole('button', { name: 'Attach a file', exact: true }).click(); await page.getByRole('button', { name: 'Choose from Files', exact: true }).click();
    const files = page.getByRole('dialog', { name: 'Choose from Files', exact: true }); await files.getByRole('checkbox', { name: /Context.pdf/ }).check(); await files.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    const transcript = page.locator('[data-recued-chat-route-messages]'); await transcript.evaluate(node => { node.scrollTop = 350; });
    await input(page).evaluate((node: HTMLTextAreaElement) => { node.setSelectionRange(3, 11, 'backward'); node.scrollTop = 35; });
    const before = await transcript.evaluate(node => node.scrollTop); await previewRecord(page, 'Context note');
    await recordPreview(page).getByRole('button', { name: 'Open full record', exact: true }).focus();
    const beforeRedraw = await input(page).elementHandle();
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'chat.session_changed', session_id: 'a', field: 'busy', value: true, cursor: Date.now() } }));
    await expect.poll(() => beforeRedraw!.evaluate(node => node.isConnected)).toBe(false); await beforeRedraw!.dispose();
    await expect(recordPreview(page).getByRole('button', { name: 'Open full record', exact: true })).toBeFocused(); await expect(recordPreview(page)).toContainText('Private selected note body.');
    await page.keyboard.press('Escape'); await expect(chips(page).getByRole('button', { name: 'Preview Context note', exact: true })).toBeFocused();
    await expect(input(page)).toHaveValue(question); expect(await input(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection, node.scrollTop])).toEqual([3, 11, 'backward', 35]);
    expect(await transcript.evaluate(node => node.scrollTop)).toBe(before);
    await previewRecord(page, 'Context note'); await recordPreview(page).getByRole('button', { name: 'Remove from chat', exact: true }).click();
    await expect(recordPreview(page)).toHaveCount(0); await expect(chips(page).getByRole('link')).toHaveText(['Context task']); await expect(chips(page).getByRole('button', { name: 'Preview Context task', exact: true })).toBeFocused();
    await previewRecord(page, 'Context task'); await recordPreview(page).getByRole('button', { name: 'Remove from chat', exact: true }).click();
    await expect(chips(page)).toHaveCount(0); await expect(page.getByRole('button', { name: 'Add records', exact: true })).toBeFocused();
    await expect(input(page)).toHaveValue(question); await expect(page.locator('[data-recued-chat-route-attachments]')).toContainText('Context.pdf'); expect(f.sends).toEqual([]); expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

test('chip previews retry interrupted reads and never adopt a record that replaced the selection', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('My question'); await page.getByRole('button', { name: 'Add records', exact: true }).click(); await choose(page, 'Context task', 1, 'task'); await use(page, 1).click();
    f.fail('work_entity.get', 'task-one'); await chips(page).getByRole('button', { name: 'Preview Context task', exact: true }).click();
    await expect(recordPreview(page).getByRole('alert')).toContainText('could not be previewed'); await expect(recordPreview(page)).not.toContainText('This read was interrupted.');
    f.fail('work_entity.get', 'task-one', false); await recordPreview(page).getByRole('button', { name: 'Try again', exact: true }).click(); await expect(recordPreview(page)).toContainText('Bring the launch agenda.'); await expect(recordPreview(page).getByRole('heading', { name: 'Context task', exact: true })).toBeFocused();
    f.replaceTask(); await recordPreview(page).getByRole('button', { name: 'Open full record', exact: true }).click(); await expect(recordPreview(page).getByRole('alert')).toContainText('removed or replaced'); await expect(page).toHaveURL(/#chat\/session\/a$/u);
    await page.keyboard.press('Escape'); await chips(page).getByRole('button', { name: 'Preview Context task', exact: true }).click();
    await expect(recordPreview(page)).toContainText('removed or replaced'); await expect(recordPreview(page)).not.toContainText('Reused task identity'); await expect(recordPreview(page).getByRole('button', { name: 'Open full record', exact: true })).toHaveCount(0);
    await recordPreview(page).getByRole('button', { name: 'Remove from chat', exact: true }).click(); await expect(chips(page)).toHaveCount(0); await expect(input(page)).toHaveValue('My question'); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('a closed preview cannot replace a newer preview or act through its detached controls after a late read', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Keep my question'); await page.getByRole('button', { name: 'Add records', exact: true }).click(); await choose(page, 'Context note', 1, 'note'); await choose(page, 'Context task', 2, 'task'); await use(page, 2).click();
    f.hold('work_entity.get', 'context-note'); await chips(page).getByRole('button', { name: 'Preview Context note', exact: true }).click(); await expect.poll(f.waiting).toBe(true);
    const detached = await recordPreview(page).getByRole('button', { name: 'Remove from chat', exact: true }).elementHandle();
    await page.keyboard.press('Escape'); await previewRecord(page, 'Context task'); const open = recordPreview(page).getByRole('button', { name: 'Open full record', exact: true }); await open.focus();
    await detached!.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await detached!.dispose();
    const beforeRead = await settledReads(page, 'context-note'); f.release(); await expect.poll(() => settledReads(page, 'context-note')).toBeGreaterThan(beforeRead);
    await expect(recordPreview(page).getByRole('heading', { name: 'Context task', exact: true })).toBeVisible(); await expect(open).toBeFocused(); await expect(chips(page).getByRole('link')).toHaveCount(2); await expect(input(page)).toHaveValue('Keep my question'); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('a conversation switch fences pending previews, including when the same draft returns before its read', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Question A'); await addNote(page); f.hold('work_entity.get', 'context-note'); await chips(page).getByRole('button', { name: 'Preview Context note', exact: true }).click(); await expect.poll(f.waiting).toBe(true);
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-recued-chat-route-history-toggle]')!.click();
      document.querySelector<HTMLButtonElement>('[data-recued-chat-route-session-row="b"]')!.click();
    });
    await expect(page).toHaveURL(/#chat\/session\/b$/u); await expect(input(page)).toHaveValue(''); await expect(recordPreview(page)).toHaveCount(0);
    await input(page).fill('Question B'); await switchTo(page, 'a'); await expect(input(page)).toHaveValue('Question A'); await input(page).focus(); const beforeRead = await settledReads(page, 'context-note'); f.release();
    await expect.poll(() => settledReads(page, 'context-note')).toBeGreaterThan(beforeRead);
    await expect(recordPreview(page)).toHaveCount(0); await expect(input(page)).toBeFocused(); await expect(chips(page)).toContainText('Context note'); await previewRecord(page, 'Context note');
    await page.keyboard.press('Escape'); await switchTo(page, 'b'); await expect(input(page)).toHaveValue('Question B'); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('chip previews recheck a pinned calendar account before opening the full record', async ({ page }) => {
  const f = await boot(page, 'a', true);
  try {
    await input(page).fill('Prepare for this meeting'); await page.getByRole('button', { name: 'Add records', exact: true }).click();
    await picker(page).getByRole('region', { name: 'Pinned', exact: true }).getByRole('button', { name: 'Select link to Exact work occurrence', exact: true }).click(); await use(page, 1).click();
    await previewRecord(page, 'Exact work occurrence'); f.replaceCalendar(); f.updateCalendar('work', { summary: 'Replacement calendar details' });
    await recordPreview(page).getByRole('button', { name: 'Open full record', exact: true }).click(); await expect(recordPreview(page).getByRole('alert')).toContainText('could not be checked'); await expect(page).toHaveURL(/#chat\/session\/a$/u);
    await page.keyboard.press('Escape'); await chips(page).getByRole('button', { name: 'Preview Exact work occurrence', exact: true }).click(); await expect(recordPreview(page).getByRole('alert')).toContainText('could not be previewed'); await expect(recordPreview(page)).not.toContainText('Replacement calendar details');
    await recordPreview(page).getByRole('button', { name: 'Remove from chat', exact: true }).click(); await expect(input(page)).toHaveValue('Prepare for this meeting'); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});

test('Open full record uses the selected mailbox when two accounts share a provider record ID', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Question with account context'); await page.getByRole('button', { name: 'Add records', exact: true }).click(); await choose(page, 'Exact work email', 1, 'mail'); await choose(page, 'Other mailbox email', 2, 'mail'); await use(page, 2).click();
    await previewRecord(page, 'Other mailbox email'); await expect(recordPreview(page)).toContainText('Account: home');
    page.on('dialog', async dialog => dialog.accept()); await recordPreview(page).getByRole('button', { name: 'Open full record', exact: true }).click();
    await expect(page).toHaveURL(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + serializeSourceRecordAddress(f.source('mail', 'home'))); await expect(page.locator('.data-mail-message')).toContainText('Other account body.'); await expect(recordPreview(page)).toHaveCount(0); expect(f.sends).toEqual([]); expect(f.mutations).toEqual([]);
  } finally { f.dispose(); }
});

// D-406 slice 2 (the owner: reuse "Add records", no second picker) — the emails among the records added to a message
// also ride the send as `mail_refs`, so the server reads them before the turn's first round, with each one's place in
// its thread. The references stay in the message as they were.
test('D-406 slice 2 — the emails among the added records ride the send as mail_refs, each mailbox apart, beside the references', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Summarize these emails.'); await page.getByRole('button', { name: 'Add records', exact: true }).click();
    await choose(page, 'Context note', 1, 'note'); await choose(page, 'Exact work email', 2, 'mail'); await choose(page, 'Other mailbox email', 3, 'mail');
    await use(page, 3).click(); await expect(picker(page)).toHaveCount(0);
    await send(page).click(); await expect.poll(() => f.sends.length).toBe(1);
    // The same record id in two mailboxes is two emails.
    expect(f.sends[0]!.mail_refs).toEqual([{ slug: 'work', record_id: f.mailId }, { slug: 'home', record_id: f.mailId }]);
    const parsed = readRecordChatMessage(String(f.sends[0]!.message))!;
    expect(selectedRecordsOf(parsed.context).map((row) => row.reference.target.tab)).toEqual(['note', 'mail', 'mail']);
  } finally { f.dispose(); }
});

test('D-406 slice 2 — a message whose added records hold no email carries no mail_refs', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Read my note.'); await addNote(page); await send(page).click(); await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0]).not.toHaveProperty('mail_refs');
  } finally { f.dispose(); }
});

test('D-406 (Q4) — the events among the added records ride the send as calendar_refs, each calendar apart', async ({ page }) => {
  const f = await boot(page);
  try {
    await input(page).fill('Prepare me for these.'); await page.getByRole('button', { name: 'Add records', exact: true }).click();
    await choose(page, 'Exact work occurrence', 1, 'calendar'); await choose(page, 'Other calendar occurrence', 2, 'calendar'); await choose(page, 'Exact work email', 3, 'mail');
    await use(page, 3).click(); await expect(picker(page)).toHaveCount(0);
    await send(page).click(); await expect.poll(() => f.sends.length).toBe(1);
    // The same record id in two calendars is two events.
    const eventId = f.source('calendar').recordId;
    expect(f.sends[0]!.calendar_refs).toEqual([{ slug: 'work', record_id: eventId }, { slug: 'home', record_id: eventId }]);
    expect(f.sends[0]!.mail_refs).toEqual([{ slug: 'work', record_id: f.mailId }]);
  } finally { f.dispose(); }
});

test('D-406 (Q5) — "Chat about this" on an email opens a new chat with it added, and the send carries it as mail_refs', async ({ page }) => {
  const f = await boot(page);
  try {
    await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + serializeSourceRecordAddress(f.source('mail')));
    await page.waitForFunction(() => window.__app?.ready === true);
    const chatAbout = page.locator('[data-mail-focus="chat"]');
    await expect(chatAbout).toHaveText('Chat about this');
    await chatAbout.click();
    await expect(input(page)).toHaveValue('What should I know about this email?');
    await expect(chips(page).getByRole('link')).toHaveText(['Exact work email']);
    expect(f.sends).toEqual([]);
    await send(page).click(); await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0]!.mail_refs).toEqual([{ slug: 'work', record_id: f.mailId }]);
    const parsed = readRecordChatMessage(String(f.sends[0]!.message))!;
    expect(parsed.question).toBe('What should I know about this email?');
    expect(selectedRecordsOf(parsed.context).map((row) => row.reference.target.hash)).toEqual([serializeSourceRecordAddress(f.source('mail'))]);
  } finally { f.dispose(); }
});
