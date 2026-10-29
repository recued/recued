import { test, expect, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createFileLifecycleFixture as Factory } from './harness/file-lifecycle-backend.js';

const setup = async (browser: Browser, fullApp = false) => {
  const target = resolve(`node_modules/.cache/file-lifecycle-${crypto.randomUUID()}.mjs`);
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/file-lifecycle-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  const { createFileLifecycleFixture } = await import(pathToFileURL(target).href) as { createFileLifecycleFixture: typeof Factory };
  const pages: Page[] = [];
  const fixture = await createFileLifecycleFixture({ emit: event => { for (const page of pages) void page.evaluate(event => {
    (window as unknown as { queueTestEvent?(e: unknown): void }).queueTestEvent?.(event);
  }, { ...event, cursor: Date.now() }).catch(() => {}); } });
  const context = await browser.newContext();
  const calls: string[] = []; let loseAck = false, restoreSupport = true;
  let mutationGate: Promise<void> | undefined, releaseMutation: (() => void) | undefined;
  let listGate: Promise<void> | undefined, releaseList: (() => void) | undefined;
  let waitingForList = false;
  await context.route(/\/(?:file-lifecycle-rpc|d265-rpc)$/, async route => {
    const { method, args } = route.request().postDataJSON(); calls.push(method);
    try {
      if (method === 'data.file.mutate' && mutationGate) {
        const pending = mutationGate; mutationGate = undefined; await pending;
      }
      if (method === 'collection.list' && listGate) {
        const pending = listGate; listGate = undefined; waitingForList = true; await pending;
        waitingForList = false; throw new Error('The file list refresh was interrupted.');
      }
      let result = await fixture.rpc(method, args ?? {});
      if (method === 'data.file.usage' && !restoreSupport && result && typeof result === 'object') {
        const legacy = { ...result }; Reflect.deleteProperty(legacy, 'can_restore'); result = legacy;
      }
      if (method === 'data.file.mutate' && loseAck) { loseAck = false; throw new Error('Acknowledgement lost'); }
      await route.fulfill({ json: { result } });
    } catch (error) { await route.fulfill({ json: { error: String(error) } }); }
  });
  const data = await context.newPage(); const chat = await context.newPage(); pages.push(data, chat);
  if (fullApp) {
    await data.addInitScript(() => {
      Object.assign(window, { __connectionsFixture: async (method: string, args: unknown) => {
        if (['collection.listInstances', 'collection.list', 'collection.get', 'data.file.usage', 'data.file.mutate', 'data.file.read'].includes(method)) {
          const response = await fetch('/file-lifecycle-rpc', { method: 'POST', body: JSON.stringify({ method, args }) });
          const envelope = await response.json();
          return envelope.error ? { error: { code: 'bad_request', message: String(envelope.error) } } : envelope;
        }
        if (method === 'data.file.attachments.sources') return { result: { sources: [] } };
        return undefined;
      } });
    });
    await data.goto(`/full-app-harness.html?journey=verification#data/files/record/received/${encodeURIComponent(fixture.fileId)}`);
    await data.waitForFunction(() => window.__app?.ready === true);
  } else {
    await data.goto(`/file-lifecycle-harness.html?file=${encodeURIComponent(fixture.fileId)}`);
    await expect(data.locator('body')).toHaveAttribute('data-ready', 'true');
  }
  await chat.goto('/chat-queue-harness.html');
  await expect(chat.locator('body')).toHaveAttribute('data-ready', 'true');
  return { data, chat, fixture, calls, loseAck: () => { loseAck = true; },
    restoreSupport: (enabled: boolean) => { restoreSupport = enabled; },
    holdMutation: () => { mutationGate = new Promise(resolve => { releaseMutation = resolve; }); },
    releaseMutation: () => { if (!releaseMutation) throw new Error('No file write is waiting'); releaseMutation(); releaseMutation = undefined; },
    holdListFailure: () => { listGate = new Promise(resolve => { releaseList = resolve; }); },
    waitingForList: () => waitingForList,
    releaseList: () => { if (!releaseList) throw new Error('No file list is waiting'); releaseList(); releaseList = undefined; },
    close: async () => {
    releaseMutation?.(); releaseList?.();
    fixture.release(); await context.close(); fixture.close(); await rm(target, { force: true });
  } };
};
const openUsage = async (page: Page) => { await page.getByRole('button', { name: 'Manage file', exact: true }).click();
  await expect(page.locator('[data-file-lifecycle]')).toContainText('1 message in 1 conversation'); };

test('Data file deletion previews usage, links to the exact message and updates another client without rewriting text', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await openUsage(f.data);
    await expect(f.data.locator('[data-file-lifecycle] a')).toHaveAttribute('href', '#chat/session/s/answer/file-message');
    await f.data.getByRole('button', { name: 'Permanently delete', exact: true }).click();
    await expect(f.data.locator('[data-file-lifecycle]')).toContainText('Queued messages needing it will fail');
    await f.data.getByRole('button', { name: 'Keep file' }).click();
    expect(f.calls.filter(m => m === 'data.file.mutate')).toHaveLength(0);
    await f.data.getByRole('button', { name: 'Permanently delete', exact: true }).click();
    await f.data.getByRole('button', { name: 'Yes, delete it for good' }).click();
    await expect(f.data.getByRole('status').filter({ hasText: 'File deleted for good' })).toBeVisible();
    await expect(f.chat.locator('[data-chat-attachments]')).toContainText('Attachment.pdf · File deleted');
    await expect(f.chat.locator('[data-recued-chat-route-message="file-message"]')).toContainText('Attached document');
    expect((await f.fixture.messages())[0]!.content).toBe('Attached document');
  } finally { await f.close(); }
});

test('refreshes stale impact before requiring another confirmation and fails a deleted queued attachment visibly', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await openUsage(f.data);
    await f.fixture.rpc('chat.send', { session_id: 's', message: 'Hold first turn', submission_id: 'first', picker_state: { current: 'self' } });
    await f.fixture.rpc('chat.send', { session_id: 's', message: 'Queued file message', submission_id: 'file',
      picker_state: { current: 'self' },
      attachments: [{ file_id: f.fixture.fileId, media_class: 'document' }] });
    await f.data.getByRole('button', { name: 'Permanently delete', exact: true }).click();
    await f.data.getByRole('button', { name: 'Yes, delete it for good' }).click();
    await expect(f.data.locator('[data-file-lifecycle] [role="alert"]')).toContainText('usage changed');
    await expect(f.data.locator('[data-file-lifecycle]')).toContainText('1 queued');
    await expect(f.data.getByRole('button', { name: 'Yes, delete it for good' })).toHaveCount(0);
    await f.data.getByRole('button', { name: 'Permanently delete', exact: true }).click();
    await f.data.getByRole('button', { name: 'Yes, delete it for good' }).click();
    await expect(f.chat.locator('[data-recued-chat-turn-queue]')).toContainText('required attachment permanently deleted');
    f.fixture.release();
    await expect.poll(() => f.fixture.executions).toEqual(['Hold first turn']);
  } finally { await f.close(); }
});

test('archive preserves the downloadable attachment and a lost deletion acknowledgement cannot repeat the action', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.data.setViewportSize({ width: 390, height: 844 });
    await openUsage(f.data); await f.data.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(f.data.getByRole('status').filter({ hasText: 'File put away' })).toBeVisible();
    await expect(f.data.locator(`[data-collection-record="${f.fixture.fileId}"]`)).toHaveCount(0);
    await f.data.getByRole('button', { name: 'Show archived files' }).click();
    await expect(f.data.locator(`[data-collection-record="${f.fixture.fileId}"]`)).toBeVisible();
    const attachment = (await f.fixture.messages())[0]!.attachments![0]!;
    const read = await f.fixture.rpc('data.file.read', { record_id: attachment.file_id }) as { bytes_b64: string };
    expect(Buffer.from(read.bytes_b64, 'base64').toString()).toBe('%PDF-original-file');
    await f.data.goto(`/file-lifecycle-harness.html?file=${encodeURIComponent(attachment.file_id)}`);
    await openUsage(f.data);
    await expect(f.data.locator('[data-file-lifecycle]')).toContainText('Archived from the file library');
    f.loseAck(); await f.data.getByRole('button', { name: 'Permanently delete', exact: true }).click();
    await f.data.getByRole('button', { name: 'Yes, delete it for good' }).click();
    await expect(f.data.locator('[data-file-lifecycle]')).toContainText('File deleted for good');
    expect(f.calls.filter(m => m === 'data.file.mutate')).toHaveLength(2);
    expect(await f.data.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await f.close(); }
});

test('an active turn blocks permanent deletion while allowing the file to be archived', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.fixture.rpc('chat.send', { session_id: 's', message: 'Read the retained file', submission_id: 'active-file',
      picker_state: { current: 'self' }, attachments: [{ file_id: f.fixture.fileId, media_class: 'document' }] });
    await expect.poll(async () => (await f.fixture.snapshot()).turns[0]?.status).toBe('running');
    await openUsage(f.data);
    await expect(f.data.getByRole('button', { name: 'Permanently delete', exact: true })).toBeDisabled();
    await f.data.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(f.data.getByRole('status').filter({ hasText: 'File put away' })).toBeVisible();
    expect(f.fixture.files!.get(f.fixture.fileId)?.hot_fields.archived).toBe(1);
  } finally { await f.close(); }
});

test('restores an archived file on a phone, waits for server support, and keeps the confirmed result through an interrupted refresh', async ({ browser }) => {
  const f = await setup(browser, true);
  try {
    await f.data.setViewportSize({ width: 390, height: 844 });
    await openUsage(f.data); await f.data.getByRole('button', { name: 'Archive', exact: true }).click();
    await f.data.getByRole('button', { name: 'Show archived files' }).click();
    await f.data.locator(`[data-collection-record="${f.fixture.fileId}"]`).click();
    f.restoreSupport(false); await openUsage(f.data);
    const panel = f.data.locator('[data-file-lifecycle]');
    await expect(panel).toContainText('Update the server to restore archived files.');
    await expect(panel.getByRole('button', { name: 'Restore to library', exact: true })).toHaveCount(0);
    f.restoreSupport(true); await panel.getByRole('button', { name: 'Check again' }).click();
    const restore = panel.getByRole('button', { name: 'Restore to library', exact: true });
    await expect(restore).toBeVisible();
    f.holdMutation(); f.holdListFailure(); await restore.click();
    await expect(panel.getByRole('button', { name: 'Restoring…', exact: true })).toBeDisabled();
    await expect(panel).toBeFocused();
    expect(await f.data.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(false);
    const currentHash = await f.data.evaluate(() => location.hash);
    await f.data.evaluate(() => {
      window.confirm = (message?: string) => { document.documentElement.setAttribute('data-file-leave-prompt', message ?? ''); return false; };
      window.__app.setHash('#today');
    });
    await expect(f.data.locator('html')).toHaveAttribute('data-file-leave-prompt', 'Something is still happening. Leave Data anyway?');
    await expect.poll(() => f.data.evaluate(() => location.hash)).toBe(currentHash);
    await expect(panel.getByRole('button', { name: 'Restoring…', exact: true })).toBeDisabled();
    f.releaseMutation();
    const notice = f.data.locator('[data-file-lifecycle-notice]');
    await expect(notice).toHaveText('File restored to your library.');
    await expect(notice).toBeFocused();
    await expect(f.data.locator(`[data-collection-record="${f.fixture.fileId}"]`)).toHaveCount(0);
    await expect.poll(() => f.waitingForList()).toBe(true);
    expect(await f.data.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true);
    f.releaseList();
    await expect(f.data.getByRole('alert')).toContainText('file list refresh was interrupted');
    await expect(notice).toHaveText('File restored to your library.');
    await f.data.getByRole('button', { name: 'Show current files' }).click();
    await expect(f.data.locator(`[data-collection-record="${f.fixture.fileId}"]`)).toBeVisible();
    const attachment = (await f.fixture.messages())[0]!.attachments![0]!;
    const read = await f.fixture.rpc('data.file.read', { record_id: attachment.file_id }) as { bytes_b64: string };
    expect(Buffer.from(read.bytes_b64, 'base64').toString()).toBe('%PDF-original-file');
    expect(f.calls.filter(method => method === 'data.file.mutate')).toHaveLength(2);
  } finally { await f.close(); }
});

test('requires another click after stale restore impact and verifies a restored file after losing its acknowledgement without repeating the write', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await openUsage(f.data); await f.data.getByRole('button', { name: 'Archive', exact: true }).click();
    await f.data.getByRole('button', { name: 'Show archived files' }).click();
    await f.data.locator(`[data-collection-record="${f.fixture.fileId}"]`).click(); await openUsage(f.data);
    const panel = f.data.locator('[data-file-lifecycle]');
    const restore = panel.getByRole('button', { name: 'Restore to library', exact: true });
    f.holdMutation(); await restore.click();
    // A second client's archive changes the review revision before this write.
    await f.fixture.rpc('data.file.mutate', { record_id: f.fixture.fileId, action: 'archive',
      revision: f.fixture.files!.attachmentLifecycle!.preview(f.fixture.fileId).revision });
    f.releaseMutation();
    await expect(panel.getByRole('alert')).toContainText('usage changed');
    await expect(restore).toBeEnabled();
    expect(f.fixture.files!.get(f.fixture.fileId)?.hot_fields.archived).toBe(1);
    expect(f.calls.filter(method => method === 'data.file.mutate')).toHaveLength(2);
    f.loseAck(); await restore.click();
    await expect(f.data.locator('[data-file-lifecycle-notice]')).toHaveText('The file is in your library.');
    expect(f.fixture.files!.get(f.fixture.fileId)?.hot_fields.archived).toBe(0);
    expect(f.calls.filter(method => method === 'data.file.mutate')).toHaveLength(3);
    await f.data.getByRole('button', { name: 'Show current files' }).click();
    await expect(f.data.locator(`[data-collection-record="${f.fixture.fileId}"]`)).toBeVisible();
    await expect(f.chat.locator('[data-chat-attachments]')).toContainText('Attachment.pdf');
    expect((await f.fixture.messages())[0]!.content).toBe('Attached document');
  } finally { await f.close(); }
});
