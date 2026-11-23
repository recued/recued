import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, CHAT_INPUT, CHAT_SEND, SHELL_CONTENT, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../src/shell/route.js';
import { readRecordChatMessage, selectedRecordsOf } from '../src/chat/record-context.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 900 } });
type Kind = 'mail' | 'note';
const quote = 'Please send the revised schedule tomorrow. 二🧾';
const body = '# Meeting context\n\n' + 'Earlier context for the meeting.\n\n'.repeat(80) + quote + '\n\nOther saved context.';
const toolbar = (page: Page) => page.getByRole('complementary', { name: 'Selected text actions', exact: true });
const task = (page: Page) => page.locator('.work-entity-dialog[data-kind="task"][data-mode="create"]');
const input = (page: Page) => page.locator(`[${CHAT_INPUT}]`);
const selector = (kind: Kind) => kind === 'mail' ? '[data-mail-message-body]' : '[data-note-body]';
const host = (page: Page, kind: Kind) => page.locator(kind === 'note' ? '.work-entity-note-content' : `[${SHELL_CONTENT}]`);
const boot = async (page: Page, kind: Kind, text = body) => {
  const sends: Array<Record<string, unknown>> = [];
  const session = { id: 'passage-chat', title: 'Passage chat', created_at: 1, last_active_at: 2, archived: false,
    picker_state: { current: 'self' }, model_routing: { current: 'byok', provider: 'openai', model_id: 'fixture' } };
  const f = await installTaskNoteSourceFixture(page, { caller: (method, args) => {
    if (method === 'chat.sessions.list') return { result: { sessions: [] } };
    if (method === 'chat.session.create') return { result: { session_id: session.id } };
    if (method === 'chat.session.get') return { result: { ...session, plans: [], messages: [] } };
    if (method === 'chat.send') { sends.push(structuredClone(args)); return { result: { turn_id: 'passage-turn', status: 'succeeded' } }; }
    return undefined;
  } });
  f.seedNote('passage-note', { title: 'Meeting note', body: text }); f.updateMail('work', { body: text });
  const hash = kind === 'note' ? serializeShellRoute('data', 'note', 'passage-note') : serializeSourceRecordAddress(f.source('mail'));
  await page.goto(HARNESS_URL + '?journey=verification&server_profiles=multiple&settle_reads=1' + hash);
  await page.waitForFunction(() => window.__app?.ready === true); await expect(page.locator(selector(kind))).toContainText(text === body ? quote : text.slice(0, 6));
  return { ...f, hash, sends };
};
const select = async (page: Page, kind: Kind, text = quote) => {
  await page.locator(selector(kind)).evaluate((element, text) => {
    const all = element.textContent!, start = all.indexOf(text); if (start < 0) throw new Error('Passage missing.');
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), range = document.createRange();
    let offset = 0, begun = false, node: Node | null;
    while ((node = walker.nextNode())) {
      const end = offset + node.textContent!.length;
      if (!begun && start >= offset && start < end) { range.setStart(node, start - offset); begun = true; }
      if (begun && start + text.length <= end) { range.setEnd(node, start + text.length - offset); break; }
      offset = end;
    }
    const scroll = element.closest('.work-entity-note-content') ?? document.querySelector('[data-recued-webclient-content]')!;
    scroll.scrollTop += range.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 150;
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  }, text);
  await expect(toolbar(page)).toBeVisible();
};
const selected = (page: Page) => page.evaluate(() => window.getSelection()?.toString());

for (const kind of ['mail', 'note'] as const) {
  test(kind + ': creates a reviewed task from a passage past the opening excerpt, then restores its highlight and Find', async ({ page }, info) => {
    const f = await boot(page, kind);
    try {
      const reader = page.locator(kind === 'note' ? '.work-entity-note-reader' : '.data-mail-message');
      if (kind === 'note') await reader.getByRole('button', { name: 'Formatted', exact: true }).click();
      await reader.getByRole('button', { name: kind === 'note' ? 'Find in note' : 'Find in email', exact: true }).click();
      const find = page.locator(kind === 'note' ? '[data-note-find-input]' : '[data-mail-find-input]');
      await find.fill('revised'); await select(page, kind);
      if (kind === 'note') await expect(page.locator('.work-entity-note-reader').getByRole('complementary', { name: 'Selected text actions', exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath('selected-passage-phone.png') });
      const top = await host(page, kind).evaluate(node => node.scrollTop);
      await toolbar(page).getByRole('button', { name: 'Create task from selection', exact: true }).click();
      await expect(task(page)).toBeVisible(); expect(f.writes).toEqual([]);
      await expect(task(page).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(quote);
      const notes = await task(page).getByLabel('Notes', { exact: true }).inputValue();
      expect(notes).toContain('Selected passage:\n' + quote); expect(notes).not.toContain('Earlier context');
      expect(new URL(notes.split('\n').find(line => line.startsWith(kind === 'mail' ? 'Email: ' : 'Note: '))!.split(': ').slice(1).join(': ')).hash).toBe(f.hash);
      await task(page).getByRole('button', { name: 'Save', exact: true }).click();
      if (kind === 'mail') await page.locator('.work-entity-task-reader').getByRole('button', { name: 'Back to email', exact: true }).click();
      await expect(page.locator(selector(kind))).toBeVisible(); await expect(toolbar(page)).toBeVisible();
      await expect(toolbar(page).getByRole('button', { name: 'Create task from selection', exact: true })).toBeFocused();
      await expect.poll(() => selected(page)).toBe(quote); await expect(find).toHaveValue('revised');
      await expect.poll(() => host(page, kind).evaluate(node => node.scrollTop)).toBeCloseTo(top, 0);
      expect(f.writes).toHaveLength(1); expect(f.sends).toEqual([]); expect(f.note('passage-note').body).toBe(body);
    } finally { f.dispose(); }
  });

  test(kind + ': opens an editable quoted question with the exact record, protects it on Back, and restores the reader', async ({ page }) => {
    const f = await boot(page, kind);
    try {
      const reader = page.locator(kind === 'note' ? '.work-entity-note-reader' : '.data-mail-message');
      await reader.getByRole('button', { name: kind === 'note' ? 'Find in note' : 'Find in email', exact: true }).click();
      const find = page.locator(kind === 'note' ? '[data-note-find-input]' : '[data-mail-find-input]'); await find.fill('revised');
      await select(page, kind); const top = await host(page, kind).evaluate(node => node.scrollTop);
      const ask = toolbar(page).getByRole('button', { name: 'Ask about selection', exact: true }); await ask.focus(); await ask.press('Enter');
      await expect(input(page)).toHaveValue(new RegExp('Quoted passage')); expect(await input(page).inputValue()).toContain(JSON.stringify(quote));
      await expect(page.locator('[data-chat-selected-records] a')).toHaveAttribute('href', f.hash);
      expect(f.sends).toEqual([]); expect(f.writes).toEqual([]);
      const prompts: string[] = [];
      page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); });
      await page.locator('[data-chat-selected-records] a').click(); await expect.poll(() => prompts.length).toBe(1); await expect(input(page)).toBeVisible();
      page.once('dialog', dialog => { void dialog.accept(); });
      await page.locator('[data-chat-selected-records] a').click();
      await expect(page.locator(selector(kind))).toBeVisible();
      await expect.poll(() => selected(page)).toBe(quote); await expect(find).toHaveValue('revised');
      await expect(toolbar(page).getByRole('button', { name: 'Ask about selection', exact: true })).toBeFocused();
      await expect.poll(() => host(page, kind).evaluate(node => node.scrollTop)).toBeCloseTo(top, 0);
      expect(f.sends).toEqual([]);
    } finally { f.dispose(); }
  });

  test(kind + ': sends the edited question only on request, with the exact source reference', async ({ page }) => {
    const f = await boot(page, kind);
    try {
      await select(page, kind); await toolbar(page).getByRole('button', { name: 'Ask about selection', exact: true }).click();
      await expect(input(page)).toBeVisible(); expect(f.sends).toEqual([]);
      await input(page).fill((await input(page).inputValue()) + 'What should I do next?');
      await page.locator(`[${CHAT_SEND}]`).click(); await expect.poll(() => f.sends.length).toBe(1);
      const parsed = readRecordChatMessage(String(f.sends[0]!.message))!;
      expect(parsed.question).toContain(JSON.stringify(quote)); expect(parsed.question).toContain('What should I do next?');
      expect(selectedRecordsOf(parsed.context).map(row => row.reference.target.hash)).toEqual([f.hash]);
      if (kind === 'mail') expect(f.sends[0]!.mail_refs).toEqual([{ slug: 'work', record_id: f.mailId }]);
      else expect(f.sends[0]).not.toHaveProperty('mail_refs');
    } finally { f.dispose(); }
  });

  test(kind + ': refuses changed source content before a selected task can open', async ({ page }) => {
    const f = await boot(page, kind);
    try {
      await select(page, kind);
      if (kind === 'note') f.updateNote('passage-note', { body: 'Changed source text.' }); else f.updateMail('work', { body: 'Changed source text.' });
      await toolbar(page).getByRole('button', { name: 'Create task from selection', exact: true }).click();
      await expect(toolbar(page).getByRole('alert')).toContainText('passage changed');
      await expect(task(page)).toHaveCount(0); expect(f.writes).toEqual([]); expect(f.sends).toEqual([]);
    } finally { f.dispose(); }
  });

  test(kind + ': discarding the selected task returns to the same quote without creating anything', async ({ page }) => {
    const f = await boot(page, kind);
    try {
      await select(page, kind); await toolbar(page).getByRole('button', { name: 'Create task from selection', exact: true }).click();
      await expect(task(page)).toBeVisible();
      await task(page).getByRole('button', { name: kind === 'mail' ? 'Back to email' : 'Back to note', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click(); await expect(task(page)).toBeVisible();
      await task(page).getByRole('button', { name: kind === 'mail' ? 'Back to email' : 'Back to note', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect.poll(() => selected(page)).toBe(quote);
      await expect(toolbar(page).getByRole('button', { name: 'Create task from selection', exact: true })).toBeFocused();
      expect(f.writes).toEqual([]); expect(f.sends).toEqual([]);
    } finally { f.dispose(); }
  });

  test(kind + ': browser Back restores the selection after accepting the protected question leave guard', async ({ page }) => {
    const f = await boot(page, kind);
    try {
      await select(page, kind); await toolbar(page).getByRole('button', { name: 'Ask about selection', exact: true }).click();
      await expect(input(page)).toBeVisible(); page.once('dialog', dialog => { void dialog.accept(); });
      await page.goBack(); await expect(page.locator(selector(kind))).toBeVisible(); await expect.poll(() => selected(page)).toBe(quote);
      expect(f.writes).toEqual([]); expect(f.sends).toEqual([]);
    } finally { f.dispose(); }
  });

  test(kind + ': a removed source cannot open a selected-record question', async ({ page }) => {
    const f = await boot(page, kind);
    try {
      await select(page, kind);
      if (kind === 'note') f.removeNote('passage-note'); else f.remove('mail', 'work', f.mailId);
      await toolbar(page).getByRole('button', { name: 'Ask about selection', exact: true }).click();
      await expect(toolbar(page).getByRole('alert')).toBeVisible(); await expect(input(page)).toHaveCount(0);
      expect(f.writes).toEqual([]); expect(f.sends).toEqual([]);
    } finally { f.dispose(); }
  });

  test(kind + ': a late passage check cannot open Chat after moving to another note', async ({ page }) => {
    const f = await boot(page, kind);
    try {
      f.seedNote('other-passage-note', { title: 'Another note', body: 'Keep this different reading visit.' });
      await select(page, kind);
      if (kind === 'note') f.hold('work_entity.get', 'passage-note'); else f.holdSource('collection.mail.message.get', 'work');
      await toolbar(page).getByRole('button', { name: 'Ask about selection', exact: true }).click();
      await expect.poll(() => kind === 'note' ? f.waiting() : f.sourceWaiting()).toBe(true);
      await page.evaluate(() => window.__app.setHash('#data/note/other-passage-note'));
      await expect(page.locator('.work-entity-note-reader')).toHaveAttribute('data-note-id', 'other-passage-note');
      const completed = await page.evaluate(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.length);
      f.release(); f.releaseSource();
      await page.waitForFunction(before => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.length > before, completed);
      await expect(page.locator('.work-entity-note-reader')).toHaveAttribute('data-note-id', 'other-passage-note');
      await expect(input(page)).toHaveCount(0); await expect(toolbar(page)).not.toBeVisible();
      expect(f.writes).toEqual([]); expect(f.sends).toEqual([]);
    } finally { f.dispose(); }
  });
}

for (const format of ['plain', 'formatted'] as const) test(format + ': quotations across record links exclude Preview controls and restore the selection', async ({ page }) => {
  const url = HARNESS_URL + '#data/task/task-one';
  const text = format === 'plain' ? `Before the link ${url} after the link.` : `Before [the linked task](${url}) after the link.`;
  const expected = format === 'plain' ? text : 'Before the linked task after the link.';
  const f = await boot(page, 'note', text);
  try {
    if (format === 'formatted') await page.locator('.work-entity-note-reader').getByRole('button', { name: 'Formatted', exact: true }).click();
    await expect(page.locator('[data-note-body]').getByRole('button', { name: 'Preview linked task', exact: true })).toBeVisible();
    await page.locator('[data-note-body]').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
    });
    await expect(toolbar(page)).toBeVisible(); const highlight = await selected(page);
    await toolbar(page).getByRole('button', { name: 'Create task from selection', exact: true }).click();
    expect((await task(page).getByLabel('Notes', { exact: true }).inputValue()).split('Selected passage:\n')[1]?.trim()).toBe(expected);
    await expect(task(page).getByLabel('Notes', { exact: true })).not.toHaveValue(/Preview/u);
    await task(page).getByRole('button', { name: 'Back to note', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect.poll(() => selected(page)).toBe(highlight);
    await toolbar(page).getByRole('button', { name: 'Ask about selection', exact: true }).click();
    const encoded = (await input(page).inputValue()).split('\n').find(line => line.startsWith('"'))!;
    expect(String(JSON.parse(encoded)).trim()).toBe(expected);
    expect(f.writes).toEqual([]); expect(f.sends).toEqual([]); expect(f.note('passage-note').body).toBe(text);
  } finally { f.dispose(); }
});

test('a replacement mailbox cannot inherit a selected email passage even with the same provider record', async ({ page }) => {
  const f = await boot(page, 'mail');
  try {
    await select(page, 'mail'); f.replaceMail();
    await toolbar(page).getByRole('button', { name: 'Ask about selection', exact: true }).click();
    await expect(toolbar(page).getByRole('alert')).toContainText('mailbox changed');
    await expect(input(page)).toHaveCount(0); expect(f.sends).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('Send rechecks the original mailbox when it changes after the quoted question opens', async ({ page }) => {
  const f = await boot(page, 'mail');
  try {
    await select(page, 'mail'); await toolbar(page).getByRole('button', { name: 'Ask about selection', exact: true }).click();
    await expect(input(page)).toBeVisible(); const question = await input(page).inputValue(); f.replaceMail();
    await page.locator(`[${CHAT_SEND}]`).click();
    await expect(page.locator('[data-chat-selected-records]')).toContainText(/needs attention|unavailable|changed|could not/iu);
    expect(f.sends).toEqual([]); await expect(input(page)).toHaveValue(question);
  } finally { f.dispose(); }
});

test('a newer passage supersedes a task preparation that is still waiting for destinations', async ({ page }) => {
  const f = await boot(page, 'note');
  try {
    await select(page, 'note'); f.hold('work_entity.source.list', '');
    await toolbar(page).getByRole('button', { name: 'Create task from selection', exact: true }).click();
    await expect.poll(f.waiting).toBe(true);
    const newer = 'Earlier context for the meeting.'; await select(page, 'note', newer); await expect(toolbar(page)).toContainText(newer);
    const completed = await page.evaluate(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(key => key === 'work_entity.source.list:').length);
    f.release();
    await page.waitForFunction(before => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(key => key === 'work_entity.source.list:').length > before, completed);
    await expect(task(page)).toHaveCount(0); await expect.poll(() => selected(page)).toBe(newer);
    const create = toolbar(page).getByRole('button', { name: 'Create task from selection', exact: true }); await expect(create).toBeEnabled();
    await create.click(); await expect(task(page).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(newer);
    await expect(task(page).getByLabel('Notes', { exact: true })).not.toHaveValue(new RegExp(quote)); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('ignores cross-reader selections, explains long selections, and dismisses with Escape without closing the note', async ({ page }) => {
  const f = await boot(page, 'note');
  try {
    await select(page, 'note'); await page.keyboard.press('Escape'); await expect(toolbar(page)).not.toBeVisible();
    await expect(page.locator('[data-note-body]')).toBeVisible();
    f.updateNote('passage-note', { body: 'Long selection '.repeat(400) });
    await page.evaluate(() => window.__app.setHash('#data/note/passage-note'));
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    const text = (await page.locator('[data-note-body]').textContent())!; await select(page, 'note', text);
    await expect(toolbar(page)).toContainText('Select up to 4,000 characters.');
    await expect(toolbar(page).getByRole('button', { name: 'Create task from selection', exact: true })).toBeDisabled();
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.body); const selection = window.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
    });
    await expect(toolbar(page)).not.toBeVisible(); expect(f.writes).toEqual([]); expect(f.sends).toEqual([]);
  } finally { f.dispose(); }
});
