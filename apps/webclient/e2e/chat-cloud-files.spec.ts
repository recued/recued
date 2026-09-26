import type { ChatDeliverySnapshot, FileLifecyclePreview } from '@recued/contracts';
import { test, expect, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createFileLifecycleFixture as Factory } from './harness/file-lifecycle-backend.js';

let createFixture: typeof Factory;
const target = resolve(`node_modules/.cache/chat-cloud-files-${crypto.randomUUID()}.mjs`);
test.beforeAll(async () => {
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/file-lifecycle-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  createFixture = (await import(pathToFileURL(target).href) as { createFileLifecycleFixture: typeof Factory }).createFileLifecycleFixture;
});
test.afterAll(async () => { await rm(target, { force: true }); });

const setup = async (browser: Browser, messenger = false) => {
  const context = await browser.newContext(); const page = await context.newPage();
  const fixture = await createFixture({ emit: event => { void page.evaluate(event => {
    (window as unknown as { queueTestEvent?(e: unknown): void }).queueTestEvent?.(event);
  }, { ...event, cursor: Date.now() }).catch(() => {}); } }, messenger, true);
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []; let loseAck = false;
  const failures = new Map<string, string>(); const holds = new Map<string, Promise<void>>();
  await context.route('**/existing-files-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); calls.push({ method, args });
    try {
      const hold = holds.get(method); if (hold) { holds.delete(method); await hold; }
      const failure = failures.get(method);
      if (failure) { failures.delete(method); throw new Error(failure); }
      const result = await fixture.rpc(method, args ?? {});
      if (method === 'data.file.attachments.import' && loseAck) { loseAck = false; throw new Error('Import acknowledgement lost'); }
      await route.fulfill({ json: { result } });
    } catch (error) { await route.fulfill({ json: { error: String(error) } }).catch(() => {}); }
  });
  await page.goto('/existing-files-harness.html#chat/session/s');
  const input = page.locator('[data-recued-chat-route-input]'); await expect(input).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'Choose from Files' });
  const pick = async () => {
    await page.getByRole('button', { name: 'Attach a file', exact: true }).click();
    await page.getByRole('button', { name: 'Choose from Files', exact: true }).click();
    await expect(dialog.getByRole('combobox')).toContainText('Google Drive · Work drive');
    await dialog.getByRole('combobox').selectOption('google.work.file');
    await expect(dialog.getByRole('checkbox', { name: /Cloud report.pdf/ })).toBeVisible();
  };
  return { context, page, input, dialog, fixture, calls, pick,
    failNext: (method: string, message: string) => { failures.set(method, message); },
    /** Park the next call to `method` until the returned release runs. */
    holdNext: (method: string) => {
      let release!: () => void; holds.set(method, new Promise<void>(done => { release = done; })); return () => release();
    },
    chips: page.locator('[data-recued-chat-route-attachment]'),
    loseAck: () => { loseAck = true; },
    close: async () => { fixture.release(); await context.close(); fixture.close(); },
  };
};

const openDataCloudFile = async (f: Awaited<ReturnType<typeof setup>>, filename = 'Cloud report.pdf') => {
  await f.page.evaluate(() => { location.hash = '#data/files'; });
  await f.page.getByRole('button', { name: 'Google Drive · Work drive', exact: true }).click();
  await f.page.locator('[data-collection-record]').filter({ hasText: filename }).click();
  await f.page.getByRole('button', { name: 'Import and use in Chat', exact: true }).click();
  const dialog = f.page.getByRole('dialog', { name: 'Import and use in Chat' });
  await expect(dialog.getByRole('button', { name: 'Shared conversation', exact: true })).toBeVisible();
  return dialog;
};

test('Data browses connected files and imports into the shared Messenger conversation through the production shell', async ({ browser }, testInfo) => {
  const f = await setup(browser, true);
  try {
    const deliveries = () => f.fixture.rpc('chat.deliveries.list', { session_id: 's' }) as Promise<ChatDeliverySnapshot>;
    await expect.poll(async () => (await deliveries()).deliveries.find(d => d.message_id === 'file-message')?.state).toBe('unknown');
    const historical = (await deliveries()).deliveries.find(d => d.message_id === 'file-message')!;
    await f.fixture.rpc('chat.delivery.skip', { session_id: 's', delivery_id: historical.delivery_id, submission_id: 'skip-data-seed', accept_unknown: true });
    f.fixture.cloudSource!.add('one', 'Cloud report', { mime_type: 'application/vnd.google-apps.document' });
    const dialog = await openDataCloudFile(f, 'Cloud report');
    const detailHash = new URL(f.page.url()).hash;
    expect(f.fixture.cloudSource!.downloads()).toBe(0);
    await expect(dialog.getByRole('button', { name: 'Import and use in Chat', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Shared conversation', exact: true }).click();
    await f.page.setViewportSize({ width: 390, height: 844 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath('data-cloud-import-mobile.png') });
    expect(f.fixture.cloudSource!.downloads()).toBe(0);
    await dialog.getByRole('button', { name: 'Import and use in Chat', exact: true }).click();
    await expect(f.page).toHaveURL(/#chat\/session\/s$/);
    await expect(f.chips).toContainText('Cloud report.docx');
    expect(f.calls.some(call => call.method === 'chat.send')).toBe(false);
    f.fixture.cloudSource!.add('one', 'Changed remote name.pdf', { revision: 'v2' });
    f.fixture.cloudSource!.connections.delete('api', 'work');
    await f.input.fill('Read the copy chosen in Data');
    await f.page.locator('[data-recued-chat-route-send]').click(); f.fixture.release();
    await expect(f.input).toHaveValue('');
    await expect.poll(() => f.fixture.uploads.some(bytes => bytes.toString() === 'native-document-export')).toBe(true);
    expect(f.fixture.cloudSource!.downloads()).toBe(1);
    expect(detailHash).toContain('remote%3Agoogle.work.file');
    const send = f.calls.find(call => call.method === 'chat.send')!;
    expect(JSON.stringify(send.args.attachments)).not.toContain('file:remote:');
  } finally { await f.close(); }
});

test('Data imports to a new draft only after confirmation and restores an exact remote file link on reload', async ({ browser }) => {
  const f = await setup(browser);
  try {
    let dialog = await openDataCloudFile(f);
    await f.page.keyboard.press('Escape');
    expect(f.fixture.cloudSource!.downloads()).toBe(0);
    await f.page.reload();
    await f.page.getByRole('button', { name: 'Import and use in Chat', exact: true }).click();
    dialog = f.page.getByRole('dialog', { name: 'Import and use in Chat' });
    await dialog.getByRole('button', { name: 'New chat', exact: true }).click();
    await dialog.getByRole('button', { name: 'Import and use in Chat', exact: true }).click();
    await expect(f.page).toHaveURL(/#chat\/new$/); await expect(f.chips).toContainText('Cloud report.pdf');
    expect(f.calls.some(call => call.method === 'chat.send' || call.method === 'chat.session.create')).toBe(false);
    expect(f.fixture.cloudSource!.downloads()).toBe(1);
  } finally { await f.close(); }
});

for (const [kind, extension] of [
  ['document', 'docx'], ['spreadsheet', 'xlsx'], ['presentation', 'pptx'],
] as const) test(`a Google ${kind} lights up in both file pickers and Data retains its advertised export`, async ({ browser }) => {
  const f = await setup(browser);
  try {
    f.fixture.cloudSource!.add('native', 'Native plan', { mime_type: `application/vnd.google-apps.${kind}`, size: 60 * 1024 * 1024 });
    await f.pick();
    const option = f.dialog.getByRole('checkbox', { name: /Native plan/ });
    await expect(option).toBeEnabled(); await expect(f.dialog).toContainText(`Saves as Native plan.${extension}`);
    await f.page.keyboard.press('Escape');
    const dialog = await openDataCloudFile(f, 'Native plan');
    await expect(dialog).toContainText(`Saves as Native plan.${extension}`);
    await dialog.getByRole('button', { name: 'Shared conversation', exact: true }).click();
    await dialog.getByRole('button', { name: 'Import and use in Chat', exact: true }).click();
    await expect(f.chips).toContainText(`Native plan.${extension}`);
    const saved = f.fixture.files!.list({ platform: 'file', slug: 'received' }).find(file => file.hot_fields.filename === `Native plan.${extension}`)!;
    expect((await f.fixture.files!.readBytes(saved.record_id)).bytes.toString()).toBe('native-document-export');
    expect(saved.hot_fields.cloud_capture).toMatchObject({ filename: 'Native plan', export_as: { filename: `Native plan.${extension}` } });
    expect(f.fixture.cloudSource!.downloads()).toBe(1);
  } finally { await f.close(); }
});

test('Data import retries recover the same saved file after a lost ACK and disconnection', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const dialog = await openDataCloudFile(f);
    await dialog.getByRole('button', { name: 'Shared conversation', exact: true }).click(); f.loseAck();
    await dialog.getByRole('button', { name: 'Import and use in Chat', exact: true }).click();
    await expect(dialog).toContainText('Import acknowledgement lost');
    f.fixture.cloudSource!.connections.delete('api', 'work');
    await dialog.getByRole('button', { name: 'Reload file', exact: true }).click();
    await expect(dialog).toContainText('cloud file or connection changed');
    await dialog.getByRole('button', { name: 'Retry import', exact: true }).click();
    await expect(f.chips).toHaveCount(1);
    const requests = f.calls.filter(call => call.method === 'data.file.attachments.import');
    expect(requests).toHaveLength(2); expect(requests[0]!.args).toEqual(requests[1]!.args);
    expect(f.fixture.cloudSource!.downloads()).toBe(1);
  } finally { await f.close(); }
});

test('Data can reload a changed selection and explain unavailable formats without downloading', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const dialog = await openDataCloudFile(f);
    await dialog.getByRole('button', { name: 'Shared conversation', exact: true }).click();
    f.fixture.cloudSource!.add('one', 'Updated document', { mime_type: 'application/vnd.google-apps.form', revision: 'v2' });
    await dialog.getByRole('button', { name: 'Import and use in Chat', exact: true }).click();
    await expect(dialog).toContainText('cloud file or connection changed');
    await dialog.getByRole('button', { name: 'Reload file', exact: true }).click();
    await expect(dialog).toContainText('This Google file cannot be exported here');
    await expect(dialog.getByRole('button', { name: 'Import and use in Chat', exact: true })).toBeDisabled();
    expect(f.fixture.cloudSource!.downloads()).toBe(0);
  } finally { await f.close(); }
});

test('leaving Data during import and returning to the same file cannot revive a late handoff', async ({ browser }) => {
  const f = await setup(browser); let release!: () => void;
  try {
    const dialog = await openDataCloudFile(f); const address = new URL(f.page.url()).hash;
    const held = new Promise<void>(done => { release = done; }); f.fixture.cloudSource!.beforeFetch(() => held);
    await dialog.getByRole('button', { name: 'Shared conversation', exact: true }).click();
    await dialog.getByRole('button', { name: 'Import and use in Chat', exact: true }).click();
    await expect.poll(() => f.fixture.cloudSource!.downloads()).toBe(1);
    await f.page.evaluate(() => { location.hash = '#chat/new'; }); await expect(dialog).toHaveCount(0);
    await expect(f.input).toBeVisible();
    await f.page.evaluate(hash => { location.hash = hash; }, address);
    await expect(f.page.getByRole('button', { name: 'Import and use in Chat', exact: true })).toBeVisible();
    release();
    await expect.poll(() => f.fixture.files!.list({ platform: 'file', slug: 'received' }).length).toBe(2);
    expect(new URL(f.page.url()).hash).toBe(address);
    await f.page.evaluate(() => { location.hash = '#chat/new'; });
    await expect(f.chips).toHaveCount(0);
    expect(f.calls.some(call => call.method === 'chat.send')).toBe(false);
  } finally { release?.(); await f.close(); }
});

test('Data searches and pages source metadata, and a source-list failure keeps saved files reachable', async ({ browser }) => {
  const f = await setup(browser);
  try {
    for (let i = 0; i < 35; i++) f.fixture.cloudSource!.add(`invoice-${String(i).padStart(2, '0')}`, `Invoice ${i}.pdf`);
    f.failNext('data.file.attachments.sources', 'Sources temporarily unavailable');
    await f.page.evaluate(() => { location.hash = '#data/files'; });
    await expect(f.page.getByRole('alert')).toContainText('Sources temporarily unavailable');
    await expect(f.page.locator('[data-collection-record]').filter({ hasText: 'Attachment.pdf' })).toBeVisible();
    await f.page.getByRole('button', { name: 'Reload file sources', exact: true }).click();
    await f.page.getByRole('button', { name: 'Google Drive · Work drive', exact: true }).click();
    await f.page.getByRole('searchbox', { name: 'Search cloud files', exact: true }).fill('clients invoice');
    await f.page.getByRole('searchbox', { name: 'Search cloud files', exact: true }).press('Enter');
    await expect(f.page.locator('[data-collection-record]')).toHaveCount(30);
    f.failNext('data.file.attachments.remote.list', 'Page temporarily unavailable');
    await f.page.getByRole('button', { name: 'Load more files', exact: true }).click();
    await expect(f.page.getByRole('alert')).toContainText('Page temporarily unavailable');
    await expect(f.page.locator('[data-collection-record]')).toHaveCount(30);
    await f.page.getByRole('button', { name: 'Load more files', exact: true }).click();
    await expect(f.page.locator('[data-collection-record]')).toHaveCount(35);
    expect(f.fixture.cloudSource!.downloads()).toBe(0);
  } finally { await f.close(); }
});

// ⛔ The two races behind a "36 rows for 35" flake in the test above, made
// deterministic: the first page of a source lands while the owner is already
// searching it. Each let "Load more" page a search the owner never ran.
test('Data keeps a search typed while a source is loading when its first page repaints', async ({ browser }) => {
  const f = await setup(browser);
  try {
    for (let i = 0; i < 35; i++) f.fixture.cloudSource!.add(`invoice-${String(i).padStart(2, '0')}`, `Invoice ${i}.pdf`);
    await f.page.evaluate(() => { location.hash = '#data/files'; });
    const search = f.page.getByRole('searchbox', { name: 'Search cloud files', exact: true });
    const rows = f.page.locator('[data-collection-record]');
    const release = f.holdNext('data.file.attachments.remote.list');
    await f.page.getByRole('button', { name: 'Google Drive · Work drive', exact: true }).click();
    await search.click(); await f.page.keyboard.type('clients');
    release(); await expect(rows).toHaveCount(30);
    await expect(search).toBeFocused(); await f.page.keyboard.type(' invoice');
    await expect(search).toHaveValue('clients invoice'); await f.page.keyboard.press('Enter');
    await expect.poll(() => f.calls.filter(call => call.method === 'data.file.attachments.remote.list').length).toBe(2);
    await expect(rows).toHaveCount(30);
    await f.page.getByRole('button', { name: 'Load more files', exact: true }).click();
    await expect(rows).toHaveCount(35);
    expect(f.calls.filter(call => call.method === 'data.file.attachments.remote.list').map(call => call.args.query))
      .toEqual(['', 'clients invoice', 'clients invoice']);
  } finally { await f.close(); }
});

test('Data searches on Enter while a source is still loading instead of dropping it', async ({ browser }) => {
  const f = await setup(browser);
  try {
    for (let i = 0; i < 35; i++) f.fixture.cloudSource!.add(`invoice-${String(i).padStart(2, '0')}`, `Invoice ${i}.pdf`);
    await f.page.evaluate(() => { location.hash = '#data/files'; });
    const search = f.page.getByRole('searchbox', { name: 'Search cloud files', exact: true });
    const rows = f.page.locator('[data-collection-record]');
    const release = f.holdNext('data.file.attachments.remote.list');
    await f.page.getByRole('button', { name: 'Google Drive · Work drive', exact: true }).click();
    await search.fill('clients invoice'); await search.press('Enter');
    await expect(rows).toHaveCount(30); release();
    await f.page.getByRole('button', { name: 'Load more files', exact: true }).click();
    await expect(rows).toHaveCount(35);
    expect(f.calls.filter(call => call.method === 'data.file.attachments.remote.list').map(call => call.args.query))
      .toEqual(['', 'clients invoice', 'clients invoice']);
  } finally { await f.close(); }
});

test('an exact link to a disconnected file source still offers the remaining saved-file library', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await openDataCloudFile(f); await f.page.keyboard.press('Escape');
    f.fixture.cloudSource!.connections.delete('api', 'work');
    await f.page.reload();
    await expect(f.page.getByRole('alert')).toContainText('source this record came from is gone');
    await f.page.getByRole('button', { name: 'Saved files', exact: true }).click();
    await expect(f.page.locator('[data-collection-record]').filter({ hasText: 'Attachment.pdf' })).toBeVisible();
    expect(f.fixture.cloudSource!.downloads()).toBe(0);
  } finally { await f.close(); }
});

test('warehouse broadcasts during a cloud import preserve its pending Data-to-Chat handoff', async ({ browser }) => {
  const f = await setup(browser); let release!: () => void;
  try {
    const dialog = await openDataCloudFile(f);
    const held = new Promise<void>(done => { release = done; }); f.fixture.cloudSource!.beforeFetch(() => held);
    await dialog.getByRole('button', { name: 'Shared conversation', exact: true }).click();
    await dialog.getByRole('button', { name: 'Import and use in Chat', exact: true }).click();
    await expect.poll(() => f.fixture.cloudSource!.downloads()).toBe(1);
    await f.page.evaluate(() => {
      (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent({
        kind: 'warehouse', collection: 'file', op: 'insert', id: 'another-file', cursor: Date.now() + 10_000,
      });
    });
    // Cross the production route's 400 ms warehouse-refresh debounce.
    await f.page.waitForTimeout(650);
    await expect(dialog).toBeVisible();
    release();
    await expect(f.chips).toContainText('Cloud report.pdf');
    expect(f.fixture.cloudSource!.downloads()).toBe(1);
    expect(f.calls.some(call => call.method === 'chat.send')).toBe(false);
  } finally { release?.(); await f.close(); }
});

test('cloud selection imports a copy into a dirty draft and sends retained bytes to the shared Messenger session', async ({ browser }) => {
  const f = await setup(browser, true);
  try {
    // The fixture deliberately loses the first historical upload's receipt.
    const deliveries = () => f.fixture.rpc('chat.deliveries.list', { session_id: 's' }) as Promise<ChatDeliverySnapshot>;
    await expect.poll(async () => (await deliveries()).deliveries.find(d => d.message_id === 'file-message')?.state).toBe('unknown');
    const historical = (await deliveries()).deliveries.find(d => d.message_id === 'file-message')!;
    await f.fixture.rpc('chat.delivery.skip', { session_id: 's', delivery_id: historical.delivery_id, submission_id: 'skip-seed', accept_unknown: true });
    await f.input.fill('Keep my text and read the cloud file'); await f.pick();
    expect(f.fixture.cloudSource!.downloads()).toBe(0);
    await expect(f.dialog).toContainText('Import saves the current download as a copy');
    await f.dialog.getByRole('checkbox', { name: /Cloud report.pdf/ }).check();
    await f.dialog.getByRole('button', { name: 'Import and attach 1 file', exact: true }).click();
    await expect(f.dialog).toHaveCount(0); await expect(f.chips).toContainText('Cloud report.pdf');
    await expect(f.input).toHaveValue('Keep my text and read the cloud file');
    expect(f.calls.some(call => call.method === 'chat.send')).toBe(false);
    expect(f.fixture.cloudSource!.downloads()).toBe(1);
    f.fixture.cloudSource!.connections.delete('api', 'work');
    await f.page.locator('[data-recued-chat-route-send]').click(); f.fixture.release();
    await expect(f.input).toHaveValue('');
    await expect.poll(async () => (await f.fixture.messages()).some(message => message.content === 'Keep my text and read the cloud file')).toBe(true);
    await expect.poll(() => f.fixture.uploads.some(bytes => bytes.toString() === '%PDF-cloud-attachment')).toBe(true);
    const send = f.calls.find(call => call.method === 'chat.send')!;
    expect(JSON.stringify(send.args.attachments)).not.toContain('file:remote:');
    const imported = f.fixture.files!.list({ platform: 'file', slug: 'received' }).find(file => file.hot_fields.filename === 'Cloud report.pdf')!;
    expect(imported.hot_fields.origin).toBe('connection_download');
    const conversation = await f.fixture.rpc('data.file.attachments.conversation', { session_id: 's' }) as { files: Array<{ source_file_id: string }> };
    expect(conversation.files.some(file => file.source_file_id === imported.record_id)).toBe(true);
  } finally { await f.close(); }
});

test('cloud browsing filters names and paths before pagination and explains unsupported downloads', async ({ browser }) => {
  const f = await setup(browser);
  try {
    for (let i = 0; i < 34; i++) f.fixture.cloudSource!.add(`z-${String(i).padStart(2, '0')}`, `Invoice ${i}.pdf`);
    f.fixture.cloudSource!.add('native', 'Google Form', { mime_type: 'application/vnd.google-apps.form' });
    await f.pick();
    await expect(f.dialog.getByRole('checkbox', { name: /Google Form/ })).toBeDisabled();
    await expect(f.dialog).toContainText('This Google file cannot be exported here');
    await f.dialog.getByRole('searchbox').fill('clients invoice');
    await expect(f.dialog.getByRole('checkbox')).toHaveCount(30);
    await f.dialog.getByRole('button', { name: 'Load more files' }).click();
    await expect(f.dialog.getByRole('checkbox')).toHaveCount(34);
    expect(f.fixture.cloudSource!.downloads()).toBe(0);
    await f.page.keyboard.press('Escape'); await expect(f.dialog).toHaveCount(0);
  } finally { await f.close(); }
});

test('captured cloud details stay visible in Conversation files and Data after source changes and deletion', async ({ browser }, testInfo) => {
  const f = await setup(browser);
  try {
    const connection = f.fixture.cloudSource!.connections.get('api', 'work')!;
    f.fixture.cloudSource!.connections.upsert({ ...connection, display_name: 'Work drive <img src=x>' });
    f.fixture.cloudSource!.add('one', 'Cloud report.pdf', { path: '/Clients/<b>original</b>.pdf' });
    await f.pick(); await f.dialog.getByRole('checkbox', { name: /Cloud report.pdf/ }).check();
    await f.dialog.getByRole('button', { name: 'Import and attach 1 file', exact: true }).click();
    await expect(f.dialog).toHaveCount(0);
    const imported = f.fixture.files!.list({ platform: 'file', slug: 'received' })
      .find(file => file.hot_fields.filename === 'Cloud report.pdf')!;
    f.fixture.cloudSource!.add('one', 'Changed name.pdf', { path: '/Moved/Changed.pdf', revision: 'v3' });
    f.fixture.cloudSource!.connections.delete('api', 'work');
    await f.input.fill('Keep this captured file'); await f.page.locator('[data-recued-chat-route-send]').click();
    f.fixture.release(); await expect(f.input).toHaveValue('');
    await expect.poll(async () => (await f.fixture.messages()).some(message => message.content === 'Keep this captured file')).toBe(true);
    await f.page.locator('[data-chat-conversation-files-open]').click();
    const conversation = f.page.getByRole('dialog', { name: 'Conversation files' });
    const row = conversation.locator('[data-conversation-file]').filter({ hasText: 'Cloud report.pdf' });
    const capture = row.getByRole('region', { name: 'Cloud source' });
    await expect(capture).toContainText('Saved copy from Google Drive · Work drive <img src=x>');
    await expect(capture).toContainText('Captured');
    await capture.getByText('Source details', { exact: true }).click();
    await expect(capture).toContainText('/Clients/<b>original</b>.pdf');
    await expect(capture).toContainText('Cloud version seen in the file list');
    await expect(capture).toContainText('v1');
    await expect(capture).toContainText('The downloaded cloud version was not verified.');
    await expect(capture).toContainText(imported.hot_fields.content_hash);
    await expect(capture).not.toContainText('Changed name.pdf');
    await expect(capture.locator('img,b')).toHaveCount(0);
    await f.page.setViewportSize({ width: 390, height: 844 });
    expect(await conversation.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await conversation.screenshot({ path: testInfo.outputPath('cloud-source-capture-mobile.png') });
    await row.getByRole('link', { name: 'Open in Data' }).click();
    await expect(conversation).toHaveCount(0);
    const dataCapture = f.page.getByRole('region', { name: 'Cloud source' });
    await expect(dataCapture).toContainText('Saved copy from Google Drive · Work drive <img src=x>');
    await dataCapture.getByText('Source details', { exact: true }).click();
    await expect(dataCapture).toContainText('/Clients/<b>original</b>.pdf');
    await expect(dataCapture.locator('img,b')).toHaveCount(0);
    const usage = () => f.fixture.rpc('data.file.usage', { record_id: imported.record_id }) as Promise<FileLifecyclePreview>;
    await expect.poll(async () => (await usage()).in_use).toBe(false);
    await f.fixture.rpc('data.file.mutate', { record_id: imported.record_id, action: 'delete', revision: (await usage()).revision });
    await f.page.evaluate(() => { location.hash = '#chat/session/s'; });
    await f.page.locator('[data-chat-conversation-files-open]').click();
    await expect(row).toContainText('File deleted');
    await expect(row.getByRole('region', { name: 'Cloud source' })).toContainText('Google Drive · Work drive <img src=x>');
    expect(f.fixture.cloudSource!.downloads()).toBe(1);
  } finally { await f.close(); }
});

test('a lost import ACK reuses its receipt after disconnection and adds only one file', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.input.fill('Preserve the draft'); await f.pick();
    await f.dialog.getByRole('checkbox', { name: /Cloud report.pdf/ }).check(); f.loseAck();
    await f.dialog.getByRole('button', { name: 'Import and attach 1 file', exact: true }).click();
    await expect(f.dialog).toContainText('Import acknowledgement lost');
    f.fixture.cloudSource!.connections.delete('api', 'work');
    await f.dialog.getByRole('button', { name: 'Import and attach 1 file', exact: true }).click();
    await expect(f.dialog).toHaveCount(0); await expect(f.chips).toHaveCount(1);
    await expect(f.input).toHaveValue('Preserve the draft');
    expect(f.fixture.cloudSource!.downloads()).toBe(1);
    const imports = f.calls.filter(call => call.method === 'data.file.attachments.import');
    expect(imports).toHaveLength(2); expect(imports[0]!.args.import_id).toBe(imports[1]!.args.import_id);
  } finally { await f.close(); }
});

test('a partial batch retries the failed download and preserves the successful copy', async ({ browser }) => {
  const f = await setup(browser);
  try {
    f.fixture.cloudSource!.add('two', 'Second cloud file.pdf');
    f.fixture.cloudSource!.beforeFetch(async () => { if (f.fixture.cloudSource!.downloads() === 2) throw new Error('Download interrupted'); });
    await f.pick(); await f.dialog.getByRole('checkbox', { name: /Cloud report.pdf/ }).check();
    await f.dialog.getByRole('checkbox', { name: /Second cloud file.pdf/ }).check();
    await f.dialog.getByRole('button', { name: 'Import and attach 2 files', exact: true }).click();
    await expect(f.dialog).toContainText('1 of 2 files ready to attach.');
    await expect(f.dialog.getByRole('button', { name: 'Attach ready files' })).toBeVisible();
    await f.dialog.getByRole('button', { name: 'Import and attach 2 files', exact: true }).click();
    await expect(f.chips).toHaveCount(2); expect(f.fixture.cloudSource!.downloads()).toBe(3);
    expect(f.fixture.files!.list({ platform: 'file', slug: 'received' })).toHaveLength(3);
    expect(f.calls.filter(call => call.method === 'chat.send')).toHaveLength(0);
  } finally { await f.close(); }
});

test('closing during import leaves the saved copy in Files and never attaches it to a later conversation', async ({ browser }) => {
  const f = await setup(browser); let release!: () => void;
  try {
    const held = new Promise<void>(resolve => { release = resolve; }); f.fixture.cloudSource!.beforeFetch(() => held);
    await f.pick(); await f.dialog.getByRole('checkbox', { name: /Cloud report.pdf/ }).check();
    await f.dialog.getByRole('button', { name: 'Import and attach 1 file', exact: true }).click();
    await expect.poll(() => f.fixture.cloudSource!.downloads()).toBe(1);
    await f.page.evaluate(() => { location.hash = '#chat/new'; });
    await expect(f.dialog).toHaveCount(0); release();
    await expect.poll(() => f.fixture.files!.list({ platform: 'file', slug: 'received' }).length).toBe(2);
    await expect(f.chips).toHaveCount(0); await expect(f.input).toHaveValue('');
    expect(f.calls.some(call => call.method === 'chat.send')).toBe(false);
    await f.page.getByRole('button', { name: 'Attach a file', exact: true }).click();
    await f.page.getByRole('button', { name: 'Choose from Files', exact: true }).click();
    await expect(f.dialog.getByRole('checkbox', { name: /Cloud report.pdf/ })).toBeVisible();
  } finally { release?.(); await f.close(); }
});

test('a changed cloud selection cannot be imported until it is selected again', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.input.fill('Keep the reviewed draft'); await f.pick();
    await f.dialog.getByRole('checkbox', { name: /Cloud report.pdf/ }).check();
    f.fixture.cloudSource!.add('one', 'New cloud name.pdf', { revision: 'v2' });
    await f.dialog.getByRole('button', { name: 'Import and attach 1 file', exact: true }).click();
    await expect(f.dialog).toContainText('cloud file or connection changed'); expect(f.fixture.cloudSource!.downloads()).toBe(0);
    await f.dialog.getByRole('checkbox', { name: /Cloud report.pdf/ }).uncheck();
    await f.dialog.getByRole('searchbox').fill('New cloud');
    await f.dialog.getByRole('checkbox', { name: /New cloud name.pdf/ }).check();
    await f.dialog.getByRole('button', { name: 'Import and attach 1 file', exact: true }).click();
    await expect(f.chips).toContainText('New cloud name.pdf'); await expect(f.input).toHaveValue('Keep the reviewed draft');
  } finally { await f.close(); }
});

test('selections can be removed after switching sources without downloading them', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.pick(); await f.dialog.getByRole('checkbox', { name: /Cloud report.pdf/ }).check();
    await f.dialog.getByRole('combobox').selectOption('');
    await f.dialog.getByRole('button', { name: 'Remove Cloud report.pdf' }).click();
    await f.dialog.getByRole('checkbox', { name: /Attachment.pdf/ }).check();
    await f.dialog.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await expect(f.chips).toContainText('Attachment.pdf'); expect(f.fixture.cloudSource!.downloads()).toBe(0);
  } finally { await f.close(); }
});

test('a partial import can attach ready files without retrying the failed file', async ({ browser }) => {
  const f = await setup(browser);
  try {
    f.fixture.cloudSource!.add('two', 'Unavailable cloud file.pdf');
    f.fixture.cloudSource!.beforeFetch(async () => { if (f.fixture.cloudSource!.downloads() > 1) throw new Error('Provider unavailable'); });
    await f.pick(); await f.dialog.getByRole('checkbox', { name: /Cloud report.pdf/ }).check();
    await f.dialog.getByRole('checkbox', { name: /Unavailable cloud file.pdf/ }).check();
    await f.dialog.getByRole('button', { name: 'Import and attach 2 files', exact: true }).click();
    await f.dialog.getByRole('button', { name: 'Attach ready files' }).click();
    await expect(f.chips).toHaveCount(1); await expect(f.chips).toContainText('Cloud report.pdf');
    expect(f.fixture.cloudSource!.downloads()).toBe(2);
  } finally { await f.close(); }
});
