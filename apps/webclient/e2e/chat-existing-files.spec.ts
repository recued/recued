import type { ChatDeliverySnapshot } from '@recued/contracts';
import { test, expect, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createFileLifecycleFixture as Factory } from './harness/file-lifecycle-backend.js';

let createFixture: typeof Factory;
const target = resolve(`node_modules/.cache/chat-existing-files-${crypto.randomUUID()}.mjs`);
test.beforeAll(async () => {
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/file-lifecycle-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  createFixture = (await import(pathToFileURL(target).href) as { createFileLifecycleFixture: typeof Factory }).createFileLifecycleFixture;
});
test.afterAll(async () => { await rm(target, { force: true }); });

const setup = async (browser: Browser, data = false, messenger = false) => {
  const context = await browser.newContext(); const page = await context.newPage();
  const fixture = await createFixture({ emit: event => { void page.evaluate(event => {
    (window as unknown as { queueTestEvent?(e: unknown): void }).queueTestEvent?.(event);
  }, { ...event, cursor: Date.now() }).catch(() => {}); } }, messenger);
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const heldRpcs = new Map<string, Promise<void>>(); const releases: Array<() => void> = [];
  let beforeList: (() => Promise<void>) | undefined; let unavailable = false; let loseSendAck = false;
  await context.route('**/existing-files-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); calls.push({ method, args });
    try {
      await heldRpcs.get(method);
      if (method === 'data.file.attachments.list') await beforeList?.();
      if (method.startsWith('data.file.attachments.') && unavailable) throw new Error('Choose from Files is unavailable on this server.');
      const result = await fixture.rpc(method, args ?? {});
      if (method === 'chat.send' && loseSendAck) { loseSendAck = false; throw new Error('Acknowledgement lost'); }
      await route.fulfill({ json: { result } });
    } catch (error) { await route.fulfill({ json: { error: String(error) } }).catch(() => {}); }
  });
  await page.goto(`/existing-files-harness.html#${data ? `data/files/record/received/${encodeURIComponent(fixture.fileId)}` : 'chat/session/s'}`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const input = page.locator('[data-recued-chat-route-input]');
  if (!data) await expect(input).toBeVisible();
  return { context, page, fixture, calls, input,
    chips: page.locator('[data-recued-chat-route-attachments]'),
    listDelay: (fn: () => Promise<void>) => { beforeList = fn; },
    unavailable: () => { unavailable = true; },
    loseSendAck: () => { loseSendAck = true; },
    holdRpc: (method: string) => {
      let release!: () => void; heldRpcs.set(method, new Promise<void>(done => { release = done; }));
      const resume = (): void => { heldRpcs.delete(method); release(); }; releases.push(resume); return resume;
    },
    pick: async () => { await page.getByRole('button', { name: 'Attach a file', exact: true }).click(); await page.getByRole('button', { name: 'Choose from Files', exact: true }).click(); },
    close: async () => { for (const release of releases) release(); fixture.release(); await context.close(); fixture.close(); },
  };
};

test('Data Use in Chat joins the production shell, retains the draft, and sends the same stored version', async ({ browser }) => {
  const f = await setup(browser, true);
  try {
    await f.page.getByRole('button', { name: 'Use in Chat', exact: true }).click();
    await f.page.getByRole('dialog', { name: 'Use in Chat' }).getByRole('button', { name: 'Shared conversation' }).click();
    await expect(f.page).toHaveURL(/#chat\/session\/s$/);
    await expect(f.chips).toContainText('Attachment.pdf');
    expect(f.calls.filter(call => call.method === 'chat.send')).toHaveLength(0);
    await f.input.fill('Please compare this with my draft');
    await f.pick(); await f.page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(f.input).toHaveValue('Please compare this with my draft');
    await f.page.locator('[data-recued-chat-route-send]').click();
    await expect.poll(() => f.calls.filter(call => call.method === 'chat.send').length).toBe(1);
    const sent = f.calls.find(call => call.method === 'chat.send')!;
    expect(sent.args.attachments).toEqual([expect.objectContaining({ file_id: f.fixture.fileId, selection_revision: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
    f.fixture.release();
    await expect.poll(async () => (await f.fixture.messages()).find(message => message.role === 'user')?.attachments?.[0]?.filename).toBe('Attachment.pdf');
    expect(f.calls.some(call => call.method.startsWith('upload.') || call.method === 'data.file.read')).toBe(false);
  } finally { await f.close(); }
});

test('Data can choose a new chat without creating or sending a turn until Send', async ({ browser }) => {
  const f = await setup(browser, true);
  try {
    await f.page.getByRole('button', { name: 'Use in Chat', exact: true }).click();
    await f.page.getByRole('dialog').getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(f.chips).toContainText('Attachment.pdf'); await expect(f.page).toHaveURL(/#chat\/new$/);
    expect(f.calls.some(call => call.method === 'chat.send' || call.method === 'chat.session.create')).toBe(false);
    await f.input.fill('New conversation with this file');
    await f.page.locator('[data-recued-chat-route-send]').click();
    await expect.poll(() => f.calls.filter(call => call.method === 'chat.send').length).toBe(1);
    expect(f.calls.find(call => call.method === 'chat.send')!.args.session_id).not.toBe('s');
  } finally { await f.close(); }
});

test('Chat searches Messenger-retained files, keeps text and prevents a changed file from sending', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.fixture.files!.ingest({ bytes: Buffer.from('Messenger document'), filename: 'Messenger notes.txt', mime_type: 'text/plain', origin: 'messenger_media', source_id: 'telegram:message-7', scan_status: 'clean' });
    await f.input.fill('Keep this unsent text'); await f.pick();
    const dialog = f.page.getByRole('dialog', { name: 'Choose from Files' });
    await dialog.getByRole('searchbox').fill('messenger');
    await dialog.getByRole('checkbox', { name: /Messenger notes.txt/ }).check();
    await dialog.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await expect(f.input).toHaveValue('Keep this unsent text'); await expect(f.chips).toContainText('Messenger notes.txt');
    await f.fixture.files!.ingest({ bytes: Buffer.from('Changed after selection'), filename: 'Changed notes.txt', mime_type: 'text/plain', origin: 'messenger_media', source_id: 'telegram:message-7', scan_status: 'clean' });
    await f.page.locator('[data-recued-chat-route-send]').click();
    await expect(f.page.locator('[data-recued-chat-route]')).toContainText('selected file changed');
    await expect(f.input).toHaveValue('Keep this unsent text'); await expect(f.chips).toContainText('Messenger notes.txt');
    expect(f.fixture.executions).toEqual([]);
    await f.chips.getByRole('button', { name: /Remove/ }).click();
    expect(f.fixture.files!.list({ platform: 'file', slug: 'received' })).toHaveLength(2);
  } finally { await f.close(); }
});

test('a delayed picker read retires on navigation and older servers retain the upload action', async ({ browser }) => {
  const f = await setup(browser);
  let release!: () => void;
  try {
    f.listDelay(() => new Promise<void>(done => { release = done; })); await f.pick();
    await expect.poll(() => typeof release).toBe('function');
    await f.page.evaluate(() => { location.hash = '#chat/new'; });
    await expect(f.page.getByRole('dialog')).toHaveCount(0); release();
    await expect(f.chips).toHaveCount(0);
    f.listDelay(async () => {}); f.unavailable(); await f.pick();
    await expect(f.page.getByRole('dialog')).toContainText('unavailable on this server');
    await f.page.keyboard.press('Escape');
    await f.page.getByRole('button', { name: 'Attach a file', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Upload files', exact: true })).toBeVisible();
  } finally { release?.(); await f.close(); }
});

test('re-pair recovery retains the quote, file name and selection guard; deletion still rejects Send', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.page.locator('[data-chat-reply-action="file-message"]').click();
    await f.input.fill('My reply with an existing file'); await f.pick();
    await f.page.getByRole('dialog').getByRole('checkbox', { name: /Attachment.pdf/ }).check();
    await f.page.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await f.page.evaluate(() => (window as unknown as { fileTestRePair(): Promise<void> }).fileTestRePair());
    await expect(f.input).toHaveValue('My reply with an existing file');
    await expect(f.chips).toContainText('Attachment.pdf');
    await expect(f.page.locator('[data-chat-reply-draft="file-message"]')).toBeVisible();
    const lifecycle = f.fixture.files!.attachmentLifecycle!;
    f.fixture.files!.mutateLifecycle!({ record_id: f.fixture.fileId, action: 'delete', revision: lifecycle.preview(f.fixture.fileId).revision });
    await f.page.locator('[data-recued-chat-route-send]').click();
    await expect(f.page.locator('[data-recued-chat-route]')).toContainText('no longer available');
    await expect(f.input).toHaveValue('My reply with an existing file'); await expect(f.chips).toContainText('Attachment.pdf');
    expect(f.calls.some(call => call.method === 'chat.send')).toBe(false);
    await expect(f.page.locator('[data-chat-reply-draft="file-message"]')).toBeVisible();
    expect(f.fixture.executions).toEqual([]);
  } finally { await f.close(); }
});

test('picker pages, keeps selections across searches, and makes archived files reusable', async ({ browser }, testInfo) => {
  const f = await setup(browser);
  try {
    await f.page.setViewportSize({ width: 390, height: 844 });
    const lifecycle = f.fixture.files!.attachmentLifecycle!;
    f.fixture.files!.mutateLifecycle!({ record_id: f.fixture.fileId, action: 'archive', revision: lifecycle.preview(f.fixture.fileId).revision });
    for (let i = 0; i < 31; i++) await f.fixture.files!.ingest({ bytes: Buffer.from(`stored ${i}`), filename: `Library ${i}.txt`,
      mime_type: 'text/plain', origin: 'webclient_upload', source_id: `library-${i}`, scan_status: 'clean' });
    await f.pick(); const dialog = f.page.getByRole('dialog');
    await expect(dialog.getByRole('checkbox', { name: /Library/ })).toHaveCount(30);
    await dialog.getByRole('button', { name: 'Load more files' }).click();
    await expect(dialog.getByRole('checkbox', { name: /Library/ })).toHaveCount(31);
    await dialog.getByRole('checkbox', { name: /Library 0.txt/ }).check();
    await dialog.getByRole('checkbox', { name: 'Show archived files' }).check();
    await dialog.getByRole('checkbox', { name: /Attachment.pdf/ }).check();
    await dialog.screenshot({ path: testInfo.outputPath('existing-files-picker.png') });
    await dialog.getByRole('button', { name: 'Attach 2 files', exact: true }).click();
    await expect(f.chips).toContainText('Library 0.txt'); await expect(f.chips).toContainText('Attachment.pdf');
    expect(f.calls.some(call => call.method === 'chat.send' || call.method === 'data.file.read')).toBe(false);
  } finally { await f.close(); }
});

test('a recovered selection cannot lose its version guard against an older server', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.input.fill('Do not substitute another file'); await f.pick();
    await f.page.getByRole('dialog').getByRole('checkbox', { name: /Attachment.pdf/ }).check();
    await f.page.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await f.page.evaluate(() => (window as unknown as { fileTestRePair(): Promise<void> }).fileTestRePair());
    await expect(f.chips).toContainText('Attachment.pdf'); f.unavailable();
    await f.page.locator('[data-recued-chat-route-send]').click();
    await expect(f.page.locator('[data-recued-chat-route]')).toContainText('unavailable on this server');
    await expect(f.input).toHaveValue('Do not substitute another file');
    expect(f.calls.some(call => call.method === 'chat.send')).toBe(false);
  } finally { await f.close(); }
});

test('an identical Send retry recovers the accepted turn after a lost acknowledgement and file deletion', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.fixture.rpc('chat.send', { session_id: 's', message: 'Hold first', submission_id: 'hold', picker_state: { current: 'self' } });
    await expect.poll(() => f.fixture.executions).toEqual(['Hold first']);
    await f.input.fill('Queue the selected file'); await f.pick();
    await f.page.getByRole('dialog').getByRole('checkbox', { name: /Attachment.pdf/ }).check();
    await f.page.getByRole('button', { name: 'Attach 1 file', exact: true }).click(); f.loseSendAck();
    await f.page.locator('[data-recued-chat-route-send]').click();
    await expect(f.page.locator('[data-recued-chat-route]')).toContainText('Acknowledgement lost');
    const lifecycle = f.fixture.files!.attachmentLifecycle!;
    f.fixture.files!.mutateLifecycle!({ record_id: f.fixture.fileId, action: 'delete', revision: lifecycle.preview(f.fixture.fileId).revision });
    await f.page.locator('[data-recued-chat-route-send]').click();
    await expect(f.input).toHaveValue('');
    const sends = f.calls.filter(call => call.method === 'chat.send');
    expect(sends).toHaveLength(2); expect(sends[0]!.args.submission_id).toBe(sends[1]!.args.submission_id);
    expect(f.calls.filter(call => call.method === 'data.file.attachments.get')).toHaveLength(1);
    expect((await f.fixture.snapshot()).turns).toHaveLength(2);
  } finally { await f.close(); }
});

test('a slow preference read cannot leave the file handoff out of an enabled composer', async ({ browser }) => {
  const f = await setup(browser, true);
  try {
    const release = f.holdRpc('prefs.get');
    await f.page.getByRole('button', { name: 'Use in Chat', exact: true }).click();
    await f.page.getByRole('dialog').getByRole('button', { name: 'Shared conversation' }).click();
    await expect(f.input).toBeVisible();
    await expect(f.chips).toContainText('Attachment.pdf', { timeout: 3000 });
    await f.input.fill('Read the file I chose');
    await f.page.locator('[data-recued-chat-route-send]').click();
    await expect.poll(() => f.calls.filter(call => call.method === 'chat.send').length).toBe(1);
    expect(f.calls.find(call => call.method === 'chat.send')!.args.attachments).toHaveLength(1);
    release(); await expect(f.chips).toHaveCount(0);
  } finally { await f.close(); }
});

test('discarding a recovered draft cannot restore its file into a later Chat visit', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.input.fill('This draft belongs to the original chat'); await f.pick();
    await f.page.getByRole('dialog').getByRole('checkbox', { name: /Attachment.pdf/ }).check();
    await f.page.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await f.page.evaluate(() => (window as unknown as { fileTestRePair(): Promise<void> }).fileTestRePair());
    await expect(f.chips).toContainText('Attachment.pdf');
    f.page.once('dialog', dialog => dialog.accept());
    await f.page.evaluate(() => { location.hash = '#chat/new'; });
    await expect(f.page).toHaveURL(/#chat\/new$/);
    await expect(f.input).toHaveValue('', { timeout: 3000 }); await expect(f.chips).toHaveCount(0);
  } finally { await f.close(); }
});

test('a background thread refresh preserves the open file picker and its selection', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.pick(); await f.page.getByRole('dialog').getByRole('checkbox', { name: /Attachment.pdf/ }).check();
    const reads = f.calls.filter(call => call.method === 'chat.session.get').length;
    await f.page.evaluate(() => (window as unknown as { fileTestReconnect(): void }).fileTestReconnect());
    await expect.poll(() => f.calls.filter(call => call.method === 'chat.session.get').length).toBeGreaterThan(reads);
    await f.page.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await expect(f.chips).toContainText('Attachment.pdf', { timeout: 3000 });
  } finally { await f.close(); }
});

test('a recovered draft can be edited before preferences settle without losing those edits', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.input.fill('Recovered text'); await f.pick();
    await f.page.getByRole('dialog').getByRole('checkbox', { name: /Attachment.pdf/ }).check();
    await f.page.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    const release = f.holdRpc('prefs.get');
    await f.page.evaluate(() => (window as unknown as { fileTestRePair(): Promise<void> }).fileTestRePair());
    await expect(f.chips).toContainText('Attachment.pdf');
    await f.input.fill('New edits after recovery'); release();
    await expect(f.input).toHaveValue('New edits after recovery');
    await f.page.locator('[data-recued-chat-route-send]').click();
    await expect.poll(() => f.calls.filter(call => call.method === 'chat.send').length).toBe(1);
    expect(f.calls.find(call => call.method === 'chat.send')!.args.message).toBe('New edits after recovery');
  } finally { await f.close(); }
});

test('a pending conversation handoff blocks Send and an internal New chat discards it before a late list arrives', async ({ browser }) => {
  const f = await setup(browser, true);
  try {
    await f.page.getByRole('button', { name: 'Use in Chat', exact: true }).click();
    await expect(f.page.getByRole('dialog').getByRole('button', { name: 'Shared conversation' })).toBeVisible();
    const release = f.holdRpc('chat.sessions.list');
    await f.page.getByRole('dialog').getByRole('button', { name: 'Shared conversation' }).click();
    await expect(f.input).toBeVisible(); await expect(f.input).not.toBeEditable();
    await expect(f.page.locator('[data-recued-chat-route-send]')).toBeDisabled();
    await f.page.getByRole('button', { name: 'New chat', exact: true }).click();
    const guard = f.page.locator('[data-recued-chat-route-history-draft-guard]');
    await expect(guard).toBeVisible();
    await guard.getByRole('button', { name: 'Throw it away and start a new one' }).click();
    await expect(f.page).toHaveURL(/#chat\/new$/);
    await expect(f.input).toBeEditable(); await f.input.fill('A separate new draft');
    release(); await f.pick(); await f.page.keyboard.press('Escape');
    await expect(f.input).toHaveValue('A separate new draft'); await expect(f.chips).toHaveCount(0);
    expect(f.calls.some(call => call.method === 'chat.session.get' || call.method === 'chat.send')).toBe(false);
  } finally { await f.close(); }
});

test('an existing file reaches the linked Messenger as its accepted bytes after the library copy changes', async ({ browser }) => {
  const f = await setup(browser, false, true);
  const deliveries = async (): Promise<ChatDeliverySnapshot> => await f.fixture.rpc('chat.deliveries.list', {
    session_id: 's', details: true,
  }) as ChatDeliverySnapshot;
  try {
    // Retire the fixture's seeded historical message, whose first upload deliberately loses its receipt.
    await expect.poll(async () => (await deliveries()).deliveries.find(d => d.message_id === 'file-message')?.state).toBe('unknown');
    const historical = (await deliveries()).deliveries.find(d => d.message_id === 'file-message')!;
    await f.fixture.rpc('chat.delivery.skip', { session_id: 's', delivery_id: historical.delivery_id, submission_id: 'skip-seed', accept_unknown: true });
    await f.input.fill('Mirror this exact file'); await f.pick();
    await f.page.getByRole('dialog').getByRole('checkbox', { name: /Attachment.pdf/ }).check();
    await f.page.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await f.page.locator('[data-recued-chat-route-send]').click();
    await expect(f.chips).toHaveCount(0); await expect.poll(() => f.fixture.executions).toEqual(['Mirror this exact file']);
    await f.fixture.files!.ingest({ filename: 'Replacement.pdf', bytes: Buffer.from('%PDF-replaced-after-acceptance'),
      mime_type: 'application/pdf', origin: 'webclient_upload', source_id: 'browser-file', scan_status: 'clean' });
    f.fixture.release();
    await expect.poll(async () => (await deliveries()).deliveries.find(d => d.details?.message?.role === 'user')?.state).toBe('sent');
    const message = (await f.fixture.messages()).find(m => m.role === 'user')!;
    expect(message.attachments?.[0]).toMatchObject({ filename: 'Attachment.pdf', source_file_id: f.fixture.fileId });
    expect(message.attachments?.[0]?.file_id).not.toBe(f.fixture.fileId);
    expect(f.fixture.uploads.at(-1)).toEqual(Buffer.from('%PDF-original-file'));
    await expect(f.page.locator(`[data-chat-message-delivery="${message.id}"] summary`)).toContainText('Delivered');
    expect(f.calls.some(call => call.method.startsWith('upload.') || call.method === 'data.file.read')).toBe(false);
  } finally { await f.close(); }
});

test('New chat can discard a file-only unsent draft without creating a session', async ({ browser }) => {
  const f = await setup(browser, true);
  try {
    await f.page.getByRole('button', { name: 'Use in Chat', exact: true }).click();
    await f.page.getByRole('dialog').getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(f.chips).toContainText('Attachment.pdf'); await expect(f.input).toHaveValue('');
    await f.page.getByRole('button', { name: 'New chat', exact: true }).click();
    await f.page.locator('[data-recued-chat-route-history-draft-guard]').getByRole('button', { name: 'Throw it away and start a new one' }).click();
    await expect(f.chips).toHaveCount(0);
    await expect(f.page.locator('[data-recued-chat-route-send]')).toBeDisabled();
    expect(f.calls.some(call => call.method === 'chat.session.create' || call.method === 'chat.send')).toBe(false);
  } finally { await f.close(); }
});
