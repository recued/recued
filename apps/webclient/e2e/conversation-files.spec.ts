import { test, expect, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createFileLifecycleFixture as Factory } from './harness/file-lifecycle-backend.js';

let createFixture: typeof Factory;
const target = resolve(`node_modules/.cache/conversation-files-${crypto.randomUUID()}.mjs`);
test.beforeAll(async () => {
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/file-lifecycle-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  createFixture = (await import(pathToFileURL(target).href) as { createFileLifecycleFixture: typeof Factory }).createFileLifecycleFixture;
});
test.afterAll(async () => { await rm(target, { force: true }); });
type Fixture = Awaited<ReturnType<typeof Factory>>;
const setup = async (browser: Browser, seed?: (fixture: Fixture) => Promise<void>) => {
  const context = await browser.newContext(); const page = await context.newPage();
  const fixture = await createFixture({ emit: event => { void page.evaluate(event => {
    (window as unknown as { queueTestEvent?(e: unknown): void }).queueTestEvent?.(event);
  }, { ...event, cursor: Date.now() }).catch(() => {}); } });
  await seed?.(fixture);
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const holds = new Map<string, Promise<void>>(); const releases: Array<() => void> = [];
  let unavailable = false; let loseSendAck = false;
  await context.route('**/existing-files-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); calls.push({ method, args });
    try {
      await holds.get(method);
      if (method === 'data.file.attachments.conversation' && unavailable) throw new Error('Conversation files are unavailable on this server.');
      const result = await fixture.rpc(method, args ?? {});
      if (method === 'chat.send' && loseSendAck) { loseSendAck = false; throw new Error('Acknowledgement lost'); }
      await route.fulfill({ json: { result } });
    } catch (error) { await route.fulfill({ json: { error: String(error) } }).catch(() => {}); }
  });
  await page.goto('/existing-files-harness.html#chat/session/s');
  const input = page.locator('[data-recued-chat-route-input]');
  await expect(input).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'Conversation files' });
  return { context, page, fixture, calls, input, dialog,
    chips: page.locator('[data-recued-chat-route-attachments]'),
    open: async () => { await page.locator('[data-chat-conversation-files-open]').click(); await expect(dialog).toBeVisible(); },
    unavailable: (value: boolean) => { unavailable = value; },
    loseSendAck: () => { loseSendAck = true; },
    hold: (method: string) => {
      let release!: () => void; holds.set(method, new Promise<void>(done => { release = done; }));
      const resume = (): void => { holds.delete(method); release(); }; releases.push(resume); return resume;
    },
    close: async () => { for (const release of releases) release(); fixture.release(); await context.close(); fixture.close(); },
  };
};

test('the header browses full retained Messenger history, pages, filters names and types, and fits a phone', async ({ browser }, testInfo) => {
  const f = await setup(browser, async fixture => {
    await fixture.seedReplyHistory();
    for (let i = 0; i < 33; i++) await fixture.addConversationFile({ id: `older-file-${i}`, ts: i + 1,
      name: `${i < 2 ? 'Older note' : 'Shared file'} ${i}.txt`, type: i % 3 ? 'document' : 'image' });
    await fixture.addConversationFile({ id: 'unrelated', session: 'other', name: 'Not in this conversation.txt' });
  });
  try {
    await f.page.setViewportSize({ width: 390, height: 844 });
    await expect(f.page.locator('[data-recued-chat-route-message="older-file-0"]')).toHaveCount(0);
    await f.open();
    const rows = f.dialog.locator('[data-conversation-file]');
    await expect(rows).toHaveCount(30);
    await f.dialog.getByRole('button', { name: 'Load more files' }).click();
    await expect(rows).toHaveCount(34);
    await expect(f.dialog).not.toContainText('Not in this conversation');
    await f.dialog.getByRole('searchbox').fill('OLDER NOTE');
    await expect(rows).toHaveCount(2);
    await f.dialog.getByRole('combobox', { name: 'File type' }).selectOption('image');
    await expect(rows).toHaveCount(1); await expect(rows).toContainText('Older note 0.txt');
    expect(f.calls.some(call => call.method === 'data.file.read' || call.method.startsWith('upload.'))).toBe(false);
    expect(await f.dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await f.dialog.screenshot({ path: testInfo.outputPath('conversation-files-mobile.png') });
    await f.page.keyboard.press('Escape');
    await expect(f.page.locator('[data-chat-conversation-files-open]')).toBeFocused();
    await f.open(); await expect(rows).toHaveCount(30);
    expect(f.calls.filter(call => call.method === 'data.file.attachments.conversation').at(-1)!.args.cursor).toBeUndefined();
  } finally { await f.close(); }
});

test('Attach again preserves text, quote and existing files and sends the selected historical version', async ({ browser }) => {
  let original!: { source: string; version: string };
  const f = await setup(browser, async fixture => {
    original = await fixture.addConversationFile({ id: 'old-version', source: 'document', name: 'Original.txt', bytes: 'original retained bytes', ts: 1 });
    await fixture.addConversationFile({ id: 'new-version', source: 'document', name: 'Replacement.txt', bytes: 'replacement bytes', ts: 2 });
  });
  try {
    await f.page.locator('[data-chat-reply-action="file-message"]').click(); await f.input.fill('My existing unsent draft');
    await f.open();
    await f.dialog.locator('[data-conversation-file]').filter({ hasText: 'Attachment.pdf' }).getByRole('button', { name: 'Attach again' }).click();
    await f.open(); const row = f.dialog.locator(`[data-conversation-file="${original.version}"]`);
    await expect(row).toContainText('Version 1 of 2');
    await row.getByRole('button', { name: 'Attach again' }).click();
    await expect(f.dialog).toHaveCount(0); await expect(f.input).toHaveValue('My existing unsent draft'); await expect(f.input).toBeFocused();
    await expect(f.chips).toContainText('Original.txt'); await expect(f.chips).toContainText('Attachment.pdf');
    await expect(f.page.locator('[data-chat-reply-draft="file-message"]')).toBeVisible();
    expect(f.calls.some(call => call.method === 'chat.send' || call.method === 'data.file.read' || call.method.startsWith('upload.'))).toBe(false);
    await f.page.locator('[data-recued-chat-route-send]').click();
    await expect.poll(() => f.calls.filter(call => call.method === 'chat.send').length).toBe(1);
    expect(f.calls.find(call => call.method === 'chat.send')!.args.attachments).toContainEqual(expect.objectContaining({ file_id: original.version }));
    f.fixture.release();
    await expect.poll(async () => (await f.fixture.messages()).find(message => message.content === 'My existing unsent draft')?.attachments?.map(file => file.file_id)).toContain(original.version);
    expect(await f.fixture.rpc('data.file.read', { record_id: original.version })).toMatchObject({ bytes_b64: Buffer.from('original retained bytes').toString('base64') });
  } finally { await f.close(); }
});

test('Show message lands on an older owner message outside the thread window and preserves a draft', async ({ browser }) => {
  const f = await setup(browser, async fixture => {
    await fixture.seedReplyHistory(); await fixture.addConversationFile({ id: 'old-owner-file', name: 'Older attachment.txt', ts: 1 });
  });
  try {
    await f.input.fill('Keep writing this'); await f.open();
    await f.dialog.locator('[data-conversation-file]').filter({ hasText: 'Older attachment.txt' }).getByRole('link', { name: 'Show message', exact: true }).click();
    await expect(f.page).toHaveURL(/#chat\/session\/s\/answer\/old-owner-file$/);
    await expect(f.page.locator('[data-recued-chat-route-message="old-owner-file"]')).toBeFocused();
    await expect(f.input).toHaveValue('Keep writing this');
    expect(f.calls.some(call => call.method === 'chat.session.get' && call.args.around_message_id === 'old-owner-file')).toBe(true);
    expect(f.calls.some(call => call.method === 'chat.send')).toBe(false);
  } finally { await f.close(); }
});

test('Open in Data resolves the retained version through the production shell', async ({ browser }) => {
  let original!: { source: string; version: string };
  const f = await setup(browser, async fixture => {
    original = await fixture.addConversationFile({ id: 'old-data', source: 'replaced', name: 'Original metadata.txt', ts: 1 });
    await fixture.addConversationFile({ id: 'new-data', source: 'replaced', name: 'Replacement metadata.txt', ts: 2 });
  });
  try {
    await f.input.fill('A draft to keep until I choose to leave'); await f.open();
    const openData = f.dialog.locator(`[data-conversation-file="${original.version}"]`).getByRole('link', { name: 'Open in Data' });
    f.page.once('dialog', dialog => dialog.dismiss()); await openData.click();
    await expect(f.page).toHaveURL(/#chat\/session\/s$/);
    await expect(f.input).toHaveValue('A draft to keep until I choose to leave');
    await expect(f.dialog).toBeVisible();
    f.page.once('dialog', dialog => dialog.accept()); await openData.click();
    await expect(f.dialog).toHaveCount(0);
    await expect(f.page).toHaveURL(new RegExp(`/record/received/${encodeURIComponent(original.version)}`));
    await expect(f.page.getByRole('button', { name: 'Use in Chat', exact: true })).toBeVisible();
    await expect(f.page.locator('[data-recued-collection-detail-heading]')).toContainText('Original metadata.txt');
    expect(f.calls.some(call => call.method === 'collection.get' && call.args.record_id === original.version)).toBe(true);
  } finally { await f.close(); }
});

test('archive, delete and reconnect refresh the open panel without changing its filter', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.open(); await f.dialog.getByRole('searchbox').fill('Attachment');
    const lifecycle = f.fixture.files!.attachmentLifecycle!;
    const mutate = (action: 'archive' | 'delete') => f.fixture.rpc('data.file.mutate', {
      record_id: f.fixture.fileId, revision: lifecycle.preview(f.fixture.fileId).revision, action,
    });
    await mutate('archive'); await expect(f.dialog.locator('[data-conversation-file]')).toContainText('Archived');
    await expect(f.dialog.getByRole('button', { name: 'Attach again' })).toBeEnabled();
    await mutate('delete'); await expect(f.dialog.locator('[data-conversation-file]')).toContainText('File deleted');
    await expect(f.dialog.getByRole('button', { name: 'Attach again' })).toBeDisabled();
    await expect(f.dialog.getByRole('link', { name: 'Open in Data' })).toHaveCount(0);
    await f.fixture.addConversationFile({ id: 'missed-file', name: 'Attachment received while offline.txt' });
    await f.page.evaluate(() => (window as unknown as { fileTestReconnect(): void }).fileTestReconnect());
    await expect(f.dialog.locator('[data-conversation-file]')).toHaveCount(2);
    await expect(f.dialog.getByRole('searchbox')).toHaveValue('Attachment');
  } finally { await f.close(); }
});

test('late list and selection responses retire when the dialog or conversation closes', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const releaseList = f.hold('data.file.attachments.conversation'); await f.open();
    await expect.poll(() => f.calls.filter(call => call.method === 'data.file.attachments.conversation').length).toBe(1);
    await f.page.keyboard.press('Escape'); releaseList();
    await expect(f.dialog).toHaveCount(0);
    await f.open(); await expect(f.dialog.getByRole('button', { name: 'Attach again' })).toBeEnabled();
    const releaseSelection = f.hold('data.file.attachments.get');
    await f.dialog.getByRole('button', { name: 'Attach again' }).click();
    await expect.poll(() => f.calls.filter(call => call.method === 'data.file.attachments.get').length).toBe(1);
    await f.page.evaluate(() => { location.hash = '#chat/new'; });
    await expect(f.dialog).toHaveCount(0); releaseSelection();
    await expect(f.input).toBeVisible(); await expect(f.chips).toHaveCount(0);
    await expect(f.page.locator('[data-chat-conversation-files-open]')).toHaveCount(0);
    expect(f.calls.some(call => call.method === 'chat.send')).toBe(false);
  } finally { await f.close(); }
});

test('unavailable servers show an error, can retry, and never disturb the composer', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.input.fill('Keep this draft'); f.unavailable(true); await f.open();
    await expect(f.dialog.getByRole('alert')).toContainText('unavailable on this server');
    await expect(f.dialog).not.toContainText('No files have been shared');
    f.unavailable(false); await f.dialog.getByRole('button', { name: 'Refresh files' }).click();
    await expect(f.dialog.locator('[data-conversation-file]')).toHaveCount(1);
    await f.page.keyboard.press('Escape'); await expect(f.input).toHaveValue('Keep this draft');
  } finally { await f.close(); }
});

test('Attach again unlocks after a send acknowledgement while its turn is still waiting', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const release = f.hold('chat.send');
    await f.input.fill('Start a turn'); await f.page.locator('[data-recued-chat-route-send]').click();
    await expect.poll(() => f.calls.filter(call => call.method === 'chat.send').length).toBe(1);
    await f.open(); await expect(f.dialog.getByRole('button', { name: 'Attach again' })).toBeDisabled();
    release();
    await expect(f.dialog.getByRole('button', { name: 'Attach again' })).toBeEnabled();
    await f.dialog.getByRole('button', { name: 'Attach again' }).click();
    await expect(f.chips).toContainText('Attachment.pdf');
    expect(f.calls.filter(call => call.method === 'chat.send')).toHaveLength(1);
  } finally { await f.close(); }
});

test('choosing an already attached version preserves a lost-ack retry across another client submission', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.input.fill('Retry these exact words with the same file'); await f.open();
    await f.dialog.getByRole('button', { name: 'Attach again' }).click();
    f.loseSendAck(); await f.page.locator('[data-recued-chat-route-send]').click();
    await expect(f.page.locator('[data-recued-chat-route]')).toContainText('Acknowledgement lost');
    await f.fixture.rpc('chat.send', { session_id: 's', message: 'A different message from another client',
      submission_id: 'another-client', picker_state: { current: 'self' } });
    await f.open(); await f.dialog.getByRole('button', { name: 'Attach again' }).click();
    await f.page.locator('[data-recued-chat-route-send]').click();
    await expect.poll(() => f.calls.filter(call => call.method === 'chat.send').length).toBe(2);
    const sent = f.calls.filter(call => call.method === 'chat.send');
    expect(sent[1]!.args.submission_id).toBe(sent[0]!.args.submission_id);
    expect(sent[1]!.args.attachments).toEqual(sent[0]!.args.attachments);
    await expect.poll(async () => (await f.fixture.snapshot()).turns.length).toBe(2);
  } finally { await f.close(); }
});
