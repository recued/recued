import { test, expect, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createFileLifecycleFixture as Factory } from './harness/file-lifecycle-backend.js';

let createFixture: typeof Factory;
const target = resolve('node_modules/.cache/file-previews-' + crypto.randomUUID() + '.mjs');
test.beforeAll(async () => {
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/file-lifecycle-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  createFixture = (await import(pathToFileURL(target).href) as { createFileLifecycleFixture: typeof Factory }).createFileLifecycleFixture;
});
test.afterAll(async () => { await rm(target, { force: true }); });
type Fixture = Awaited<ReturnType<typeof Factory>>;
const previewMethod = 'data.file.attachments.preview';
const setup = async (browser: Browser, seed?: (fixture: Fixture) => Promise<void>) => {
  const context = await browser.newContext(); const page = await context.newPage();
  await context.addInitScript(() => {
    const urls = new Set<string>(); const violations: string[] = []; let workers = 0;
    const create = URL.createObjectURL; const revoke = URL.revokeObjectURL; const terminate = Worker.prototype.terminate;
    URL.createObjectURL = blob => { const url = create(blob); urls.add(url); return url; };
    URL.revokeObjectURL = url => { urls.delete(url); revoke(url); };
    Worker.prototype.terminate = function () { workers++; terminate.call(this); };
    document.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective + ': ' + event.blockedURI));
    Object.assign(window, { previewResources: () => ({ urls: urls.size, terminated: workers, violations }) });
  });
  // Exercise the same self-hosted script/worker and image posture as the server.
  await context.route('**/existing-files-harness.html', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: http: https:; img-src 'self' data: blob:; font-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" } });
  });
  const fixture = await createFixture({ emit: event => { void page.evaluate(event => {
    (window as unknown as { queueTestEvent?(e: unknown): void }).queueTestEvent?.(event);
  }, { ...event, cursor: Date.now() }).catch(() => {}); } }, false, true);
  await seed?.(fixture);
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let pending: Promise<void> | undefined; let release: (() => void) | undefined; let failPreview = false;
  await context.route('**/existing-files-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); calls.push({ method, args });
    try {
      if (method === previewMethod) { await pending; if (failPreview) { failPreview = false; throw new Error('Preview connection interrupted'); } }
      const result = await fixture.rpc(method, args ?? {});
      await route.fulfill({ json: { result } });
    } catch (error) { await route.fulfill({ json: { error: String(error) } }).catch(() => {}); }
  });
  await page.goto('/existing-files-harness.html#chat/session/s');
  const input = page.locator('[data-recued-chat-route-input]'); await expect(input).toBeVisible();
  const viewer = page.getByRole('dialog', { name: 'File preview', exact: true });
  const picker = page.getByRole('dialog', { name: 'Choose from Files', exact: true });
  const conversation = page.getByRole('dialog', { name: 'Conversation files', exact: true });
  return { context, page, fixture, calls, input, viewer, picker, conversation,
    chips: page.locator('[data-recued-chat-route-attachments]'),
    resources: () => page.evaluate(() => (window as unknown as { previewResources(): { urls: number; terminated: number; violations: string[] } }).previewResources()),
    pick: async () => { await page.getByRole('button', { name: 'Attach a file', exact: true }).click();
      await page.getByRole('button', { name: 'Choose from Files', exact: true }).click(); await expect(picker).toBeVisible(); },
    openConversation: async () => { await page.locator('[data-chat-conversation-files-open]').click(); await expect(conversation).toBeVisible(); },
    fail: () => { failPreview = true; },
    hold: () => { pending = new Promise<void>(done => { release = done; }); return () => { pending = undefined; release?.(); }; },
    close: async () => { release?.(); fixture.release(); await context.close(); fixture.close(); },
  };
};
const noWrites = (calls: Array<{ method: string }>) =>
  expect(calls.filter(call => ['chat.send', 'chat.session.create', 'data.file.attachments.import'].includes(call.method) || call.method.startsWith('upload.'))).toEqual([]);

// Valid two-page PDF, including an ignored document action. No network or library fixture dependency.
const pdfFixture = () => {
  const streams = ['First retained PDF page', 'Second retained PDF page'].map(text => 'BT /F1 24 Tf 30 200 Td (' + text + ') Tj ET\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >> >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + streams[0]!.length + ' >>\nstream\n' + streams[0] + 'endstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    '<< /Length ' + streams[1]!.length + ' >>\nstream\n' + streams[1] + 'endstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += (i + 1) + ' 0 obj\n' + object + '\nendobj\n'; }
  const xref = Buffer.byteLength(pdf); pdf += 'xref\n0 8\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  return Buffer.from(pdf + 'trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
};

test('Conversation files and Data preview the same historical bytes without changing the draft or message', async ({ browser }) => {
  let original!: { source: string; version: string };
  const f = await setup(browser, async fixture => {
    original = await fixture.addConversationFile({ id: 'old', source: 'same', name: 'Original.txt', bytes: 'Original evidence', ts: 1 });
    await fixture.addConversationFile({ id: 'new', source: 'same', name: 'Replacement.txt', bytes: 'Replacement evidence', ts: 2 });
  });
  try {
    const messages = await f.fixture.messages();
    await f.input.fill('Unsent draft'); await f.page.locator('[data-chat-reply-action="file-message"]').click();
    await f.page.locator('[data-recued-chat-route-message="old"]').getByRole('button', { name: 'Preview Original.txt', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Original evidence');
    await f.viewer.getByRole('button', { name: 'Close preview' }).click();
    await f.openConversation();
    const row = f.conversation.locator('[data-conversation-file="' + original.version + '"]');
    await row.getByRole('button', { name: 'Preview Original.txt', exact: true }).evaluate(button => button.setAttribute('data-preview-old-control', ''));
    await row.getByRole('button', { name: 'Preview Original.txt', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Original evidence');
    await f.page.evaluate(() => {
      (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent({
        kind: 'chat.session_changed', session_id: 's', field: 'attachments', value: true, cursor: Date.now() + 10_000,
      });
    });
    await expect(f.conversation.locator('[data-preview-old-control]')).toHaveCount(0);
    await f.page.keyboard.press('Escape'); await expect(f.conversation).toBeVisible();
    await expect(row.getByRole('button', { name: 'Preview Original.txt', exact: true })).toBeFocused();
    await f.page.keyboard.press('Escape'); await expect(f.input).toHaveValue('Unsent draft');
    await expect(f.page.locator('[data-chat-reply-draft="file-message"]')).toBeVisible();
    await f.input.fill(''); await f.page.getByRole('button', { name: 'Remove reply', exact: true }).click();
    await f.openConversation(); await row.getByRole('link', { name: 'Open in Data' }).click();
    await f.page.getByRole('button', { name: 'Preview file', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Original evidence');
    noWrites(f.calls); expect(await f.fixture.messages()).toEqual(messages);
  } finally { await f.close(); }
});

test('picker and composer image previews preserve selections and release their object URLs', async ({ browser }) => {
  const f = await setup(browser, async fixture => {
    await fixture.addConversationFile({ id: 'image', name: 'Pixel.png', type: 'image',
      bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRFkAAAAASUVORK5CYII=', 'base64') });
  });
  try {
    await f.input.fill('Keep my text'); await f.pick();
    await f.picker.getByRole('checkbox', { name: /Pixel.png/ }).check();
    await f.picker.getByRole('button', { name: 'Preview Pixel.png', exact: true }).click();
    await expect(f.viewer.getByRole('img', { name: 'Pixel.png', exact: true })).toBeVisible();
    await expect.poll(() => f.resources().then(value => value.urls)).toBe(1);
    await f.page.keyboard.press('Escape');
    await expect(f.picker.getByRole('checkbox', { name: /Pixel.png/ })).toBeChecked();
    await expect.poll(() => f.resources().then(value => value.urls)).toBe(0);
    await f.picker.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await f.chips.getByRole('button', { name: 'Preview Pixel.png', exact: true }).click();
    await expect(f.viewer.getByRole('img')).toBeVisible(); await f.viewer.getByRole('button', { name: 'Close preview' }).click();
    await expect(f.input).toHaveValue('Keep my text'); await expect(f.chips).toContainText('Pixel.png');
    noWrites(f.calls); expect((await f.resources()).violations).toEqual([]);
  } finally { await f.close(); }
});

test('remote PDF uses the local worker, pages and zooms on mobile, and Download saves the exact preview', async ({ browser }, testInfo) => {
  const bytes = pdfFixture(); const f = await setup(browser);
  const workerRequests: string[] = []; f.page.on('request', request => { if (request.url().includes('pdf.worker')) workerRequests.push(request.url()); });
  try {
    await f.page.setViewportSize({ width: 390, height: 844 }); f.fixture.cloudSource!.respond(bytes, 'application/pdf');
    const before = f.fixture.files!.totalBytes(); await f.pick(); await f.picker.getByRole('combobox', { name: 'File source' }).selectOption('google.work.file');
    await f.picker.getByRole('button', { name: 'Preview Cloud report.pdf', exact: true }).click();
    await expect(f.viewer.locator('canvas[data-file-preview-rendered]')).toBeVisible();
    await expect(f.viewer).toContainText('Temporary preview'); await expect(f.viewer).toContainText('Page 1 of 2');
    await f.viewer.getByRole('button', { name: 'Show page text' }).click();
    await expect(f.viewer.getByLabel('PDF page text')).toContainText('First retained PDF page');
    await f.viewer.getByRole('button', { name: 'Next page' }).click();
    await expect(f.viewer.getByLabel('PDF page text')).toContainText('Second retained PDF page');
    await expect(f.viewer.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await f.viewer.getByRole('button', { name: 'Zoom in' }).click();
    await expect(f.viewer.locator('canvas[data-file-preview-rendered]')).toBeVisible();
    expect(await f.viewer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await f.viewer.screenshot({ path: testInfo.outputPath('file-preview-pdf-mobile.png') });
    f.fixture.cloudSource!.respond('Changed after preview', 'application/pdf');
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file' }).click();
    const download = await saving; expect(await readFile((await download.path())!)).toEqual(bytes);
    expect(download.suggestedFilename()).toBe('Cloud report.pdf'); expect(f.fixture.cloudSource!.downloads()).toBe(1);
    expect(f.fixture.files!.totalBytes()).toBe(before); noWrites(f.calls);
    expect(workerRequests).toHaveLength(1); expect(new URL(workerRequests[0]!).origin).toBe(new URL(f.page.url()).origin);
    expect((await f.resources()).violations).toEqual([]);
    await f.viewer.getByRole('button', { name: 'Close preview' }).click();
    await expect.poll(() => f.resources().then(value => value.terminated)).toBe(1);
    await expect.poll(() => f.resources().then(value => value.urls)).toBe(0);
  } finally { await f.close(); }
});

test('Data and its import chooser share a metadata-only fallback until an explicit Download', async ({ browser }) => {
  const f = await setup(browser);
  try {
    f.fixture.cloudSource!.add('one', 'Native plan', { mime_type: 'application/vnd.google-apps.document' });
    await f.page.evaluate(() => { location.hash = '#data/files'; });
    await f.page.getByRole('button', { name: /Work drive/ }).click();
    await f.page.locator('[data-collection-record]').filter({ hasText: 'Native plan' }).click();
    await f.page.getByRole('button', { name: 'Preview file', exact: true }).click();
    await expect(f.viewer).toContainText('Native plan.docx'); await expect(f.viewer).toContainText('no preview yet');
    expect(f.fixture.cloudSource!.downloads()).toBe(0); await f.viewer.getByRole('button', { name: 'Close preview' }).click();
    await f.page.getByRole('button', { name: 'Import and use in Chat', exact: true }).click();
    const chooser = f.page.getByRole('dialog', { name: 'Import and use in Chat', exact: true });
    await chooser.getByRole('button', { name: 'Preview file', exact: true }).click();
    await expect(f.viewer).toContainText('no preview yet');
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file' }).click();
    const download = await saving; expect((await readFile((await download.path())!)).toString()).toBe('native-document-export');
    expect(download.suggestedFilename()).toBe('Native plan.docx'); expect(f.fixture.cloudSource!.downloads()).toBe(1);
    noWrites(f.calls);
    await f.page.keyboard.press('Escape'); await expect(chooser).toBeVisible();
    await expect(chooser.getByRole('button', { name: 'Preview file', exact: true })).toBeFocused();
  } finally { await f.close(); }
});

test('HTML remains plain text and a shortened preview downloads the complete original', async ({ browser }) => {
  const source = '<script>window.previewExecuted=true</script><img src="https://outside.invalid/tracker">' + 'z'.repeat(100_010);
  const f = await setup(browser, async fixture => {
    await fixture.addConversationFile({ id: 'html', name: 'Document.html', mime_type: 'text/html', bytes: source });
  });
  try {
    await f.openConversation(); await f.conversation.getByRole('button', { name: 'Preview Document.html', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toContainText('<script>');
    await expect(f.viewer).toContainText('first 100,000 characters');
    expect(await f.viewer.locator('section').locator('script,iframe,object,img').count()).toBe(0);
    expect(await f.page.evaluate(() => Reflect.get(window, 'previewExecuted'))).toBeUndefined();
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file' }).click();
    expect((await readFile((await (await saving).path())!)).toString()).toBe(source);
    noWrites(f.calls); expect(f.calls.some(call => call.method === 'data.file.read')).toBe(false);
  } finally { await f.close(); }
});

test('retry recovers a failed preview and late replies retire on close and navigation', async ({ browser }) => {
  const f = await setup(browser, async fixture => { await fixture.addConversationFile({ id: 'text', name: 'Note.txt', bytes: 'Retained note' }); });
  try {
    await f.pick(); f.fail(); await f.picker.getByRole('button', { name: 'Preview Note.txt', exact: true }).click();
    await expect(f.viewer.getByRole('alert')).toContainText('connection interrupted');
    await f.viewer.getByRole('button', { name: 'Retry preview' }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Retained note');
    await f.page.keyboard.press('Escape');
    const release = f.hold(); await f.picker.getByRole('button', { name: 'Preview Note.txt', exact: true }).click();
    await expect(f.viewer).toContainText('Loading preview'); await f.page.keyboard.press('Escape');
    await expect(f.viewer).toHaveCount(0); await expect(f.picker).toBeVisible(); release();
    await f.picker.getByRole('button', { name: 'Preview Note.txt', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Retained note');
    await f.page.evaluate(() => { location.hash = '#chat/new'; });
    await expect(f.viewer).toHaveCount(0); await expect(f.picker).toHaveCount(0);
    noWrites(f.calls); await expect.poll(() => f.resources().then(value => value.urls)).toBe(0);
  } finally { await f.close(); }
});

test('Data keeps an open preview through a warehouse refresh and retires a pending read on route changes', async ({ browser }) => {
  let id = '';
  const f = await setup(browser, async fixture => {
    id = (await fixture.addConversationFile({ id: 'data-note', name: 'Data note.txt', bytes: 'Saved note' })).version;
  });
  try {
    const hash = '#data/files/record/received/' + encodeURIComponent(id);
    await f.page.evaluate(hash => { location.hash = hash; }, hash);
    await f.page.getByRole('button', { name: 'Preview file', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Saved note');
    await f.page.evaluate(() => {
      (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent({
        kind: 'warehouse', collection: 'file', op: 'insert', id: 'unrelated', cursor: Date.now() + 10_000,
      });
    });
    await f.page.waitForTimeout(650); // Cross the production warehouse refresh debounce.
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Saved note');
    await f.viewer.getByRole('button', { name: 'Close preview' }).click();
    const release = f.hold(); await f.page.getByRole('button', { name: 'Preview file', exact: true }).click();
    await expect(f.viewer).toContainText('Loading preview');
    await f.page.evaluate(() => { location.hash = '#chat/new'; }); await expect(f.viewer).toHaveCount(0);
    await f.page.evaluate(hash => { location.hash = hash; }, hash); release();
    await f.page.getByRole('button', { name: 'Preview file', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Saved note');
    expect(f.calls.filter(call => call.method === previewMethod)).toHaveLength(3); noWrites(f.calls);
  } finally { await f.close(); }
});

test('a changed picker selection reports the conflict before reading or altering a draft', async ({ browser }) => {
  const f = await setup(browser, async fixture => {
    await fixture.addConversationFile({ id: 'selected', source: 'changing', name: 'Selected.txt', bytes: 'first' });
  });
  try {
    await f.input.fill('Still writing'); await f.pick();
    await expect(f.picker.getByRole('button', { name: 'Preview Selected.txt', exact: true })).toBeVisible();
    await f.fixture.addConversationFile({ id: 'changed', source: 'changing', name: 'Changed.txt', bytes: 'second' });
    await f.picker.getByRole('button', { name: 'Preview Selected.txt', exact: true }).click();
    await expect(f.viewer.getByRole('alert')).toContainText('file changed');
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveCount(0);
    await f.page.keyboard.press('Escape'); await f.page.keyboard.press('Escape');
    await expect(f.input).toHaveValue('Still writing'); noWrites(f.calls);
  } finally { await f.close(); }
});

for (const invalid of [
  { name: 'Broken.pdf', mime: 'application/pdf', bytes: '%PDF-broken', message: 'Invalid PDF' },
  { name: 'Broken.png', mime: 'image/png', bytes: 'not an image', message: 'could not be displayed' },
  { name: 'Binary.txt', mime: 'text/plain', bytes: '\0binary', message: 'binary data' },
]) test('an unreadable ' + invalid.name + ' still downloads its original bytes', async ({ browser }) => {
  const f = await setup(browser, async fixture => {
    await fixture.addConversationFile({ id: 'invalid', name: invalid.name, mime_type: invalid.mime, bytes: invalid.bytes });
  });
  try {
    await f.openConversation(); await f.conversation.getByRole('button', { name: 'Preview ' + invalid.name, exact: true }).click();
    await expect(f.viewer.getByRole('alert')).toContainText(invalid.message);
    await expect(f.viewer.getByRole('button', { name: 'Download file' })).toBeEnabled();
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file' }).click();
    expect((await readFile((await (await saving).path())!)).toString()).toBe(invalid.bytes);
    noWrites(f.calls);
  } finally { await f.close(); }
});
