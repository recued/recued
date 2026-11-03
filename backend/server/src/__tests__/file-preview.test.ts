import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { FILE_PREVIEW_MAX_BYTES, isReservedLocalRpc } from '@recued/contracts';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { createEncryptedBlobStore } from '../storage/blob-store.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { makeFileReadRpcHandlers } from '../file-read-rpc-handler.js';
import type { FilePreviewConversionDeps } from '../file-preview-conversion.js';
import { takeResumedRunFinisher, finishResumedRun } from '../resumed-run-finishers.js';
import { stampExecuteResponseAuditRun, type ExecuteResponse, type ExecuteRequest } from '../types.js';
import type { WsClient } from '../ws-server.js';
import { watchedFileRecordId } from '../collections/file/watched-folder-collection.js';
import { startWatchedFolder } from './helpers/watched-folder.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const client = { instance_id: 'paired' } as WsClient;
const fixture = (conversions?: FilePreviewConversionDeps) => {
  const dir = mkdtempSync(join(tmpdir(), 'file-preview-')); const db = new Database(':memory:'); ensureChatSchema(db);
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const key = () => new Uint8Array(32).fill(31);
  const blobs = createEncryptedBlobStore(join(dir, 'cas'), key);
  const files = createInboundFileCollection({ db, blobs, slug: 'received', bus: createWarehouseEventBus(),
    gate: createStorageGate({ quota: 100_000_000, reservePct: 10, surface: 'collection:file:received' }) });
  const store = createChatStore(db, key); store.createSession({ id: 's', title: 'Conversation' });
  const registry = createCollectionRegistry(); registry.register(files);
  const handlers = makeFileReadRpcHandlers({ getFileReadDeps: () => ({ registry, blobs }), ...(conversions ? { conversions } : {}) })!.handlers;
  const ingest = (bytes = 'original bytes', mime_type = 'text/plain', filename = 'Original.txt') =>
    files.ingest({ bytes: Buffer.from(bytes), filename, mime_type, source_id: 'same-upload', origin: 'webclient_upload', scan_status: 'clean' });
  const preview = (record_id: string, selection_revision?: string) => handlers['data.file.attachments.preview']({
    record_id, ...(selection_revision ? { selection_revision } : {}) }, client);
  return { db, blobs, files, store, registry, handlers, ingest, preview, lifecycle: files.attachmentLifecycle! };
};

describe('paired file previews', () => {
  it('reads the immutable message version after its source changes, including archived versions', async () => {
    const f = fixture(); const file = await f.ingest();
    const message = await f.store.appendMessage({ id: 'm', session_id: 's', role: 'user', content: 'Read this',
      attachments: [{ file_id: file.record_id, media_class: 'document' }], target_server: 'self',
      picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: '1', instance_id: 'test' } },
      model_used: { provider: 'test', model_id: 'test' } });
    const version = message.attachments![0]!.file_id;
    await f.ingest('replacement bytes', 'text/plain', 'Replacement.txt');
    f.files.mutateLifecycle!({ record_id: file.record_id, action: 'archive', revision: f.lifecycle.preview(file.record_id).revision });
    const before = await f.store.listMessages('s'); const put = vi.spyOn(f.blobs, 'put');
    expect(await f.preview(version)).toMatchObject({ record_id: version, filename: 'Original.txt', transient: false,
      can_download: true, size_bytes: 14, content: { kind: 'text', bytes_b64: Buffer.from('original bytes').toString('base64') } });
    expect(await f.preview(file.record_id)).toMatchObject({ filename: 'Replacement.txt', content: { bytes_b64: Buffer.from('replacement bytes').toString('base64') } });
    expect(await f.store.listMessages('s')).toEqual(before); expect(put).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT * FROM collection_file_attachment_versions').all()).toHaveLength(1);
  });

  it('requires a paired client, reserves the RPC from MCP, and rejects malformed identities before byte access', async () => {
    const f = fixture(); const file = await f.ingest(); const get = vi.spyOn(f.blobs, 'get');
    expect(isReservedLocalRpc('data.file.attachments.preview')).toBe(true);
    await expect(f.handlers['data.file.attachments.preview']({ record_id: file.record_id }, {} as WsClient)).rejects.toThrow('registered paired client');
    for (const record_id of ['', 'other:id', 'x'.repeat(12001)]) await expect(f.preview(record_id)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(f.preview(file.record_id, 'invalid')).rejects.toMatchObject({ code: 'bad_request' });
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects a changed picker selection before reading and a replacement during the read', async () => {
    const f = fixture(); const file = await f.ingest(); const selected = f.lifecycle.selection(file.record_id);
    await f.ingest('new bytes'); const get = vi.spyOn(f.blobs, 'get');
    await expect(f.preview(file.record_id, selected.selection_revision)).rejects.toMatchObject({ code: 'file_selection_changed' });
    expect(get).not.toHaveBeenCalled();
    get.mockRestore(); const originalGet = f.blobs.get.bind(f.blobs);
    vi.spyOn(f.blobs, 'get').mockImplementationOnce(async hash => {
      const bytes = await originalGet(hash); await f.ingest('changed while reading'); return bytes;
    });
    await expect(f.preview(file.record_id)).rejects.toMatchObject({ code: 'file_selection_changed' });
  });

  it('leases bytes during preview, rejects deletion afterward, and never returns missing or corrupt bytes', async () => {
    const f = fixture(); const file = await f.ingest(); const read = f.blobs.get.bind(f.blobs);
    const get = vi.spyOn(f.blobs, 'get').mockImplementationOnce(async hash => {
      const bytes = await read(hash);
      expect(() => f.files.mutateLifecycle!({ record_id: file.record_id, action: 'delete', revision: f.lifecycle.preview(file.record_id).revision }))
        .toThrow('currently in use');
      return bytes;
    });
    await expect(f.preview(file.record_id)).resolves.toHaveProperty('content');
    get.mockRestore(); const next = file;
    const corrupt = vi.spyOn(f.blobs, 'get').mockResolvedValueOnce(Buffer.from('corrupt'));
    await expect(f.preview(next.record_id)).rejects.toMatchObject({ code: 'file_blob_hash_mismatch' });
    corrupt.mockResolvedValueOnce(null); await expect(f.preview(next.record_id)).rejects.toMatchObject({ code: 'file_blob_missing' });
    corrupt.mockRestore();
    f.files.mutateLifecycle!({ record_id: file.record_id, action: 'delete', revision: f.lifecycle.preview(file.record_id).revision });
    await expect(f.preview(file.record_id)).rejects.toThrow('no longer available');
  });

  it('returns unsupported formats without reading, and leaves Download available', async () => {
    const f = fixture(); const file = await f.ingest('zip', 'application/zip', 'Archive.zip');
    const get = vi.spyOn(f.blobs, 'get');
    expect(await f.preview(file.record_id)).toMatchObject({ can_download: true, unavailable_reason: expect.stringContaining('no preview') });
    expect(await f.preview(file.record_id)).not.toHaveProperty('content'); expect(get).not.toHaveBeenCalled();
  });

  it('previews DOCX bytes and frozen provenance without borrowing a newer saved file origin', async () => {
    const f = fixture();
    const capture = { remote_record_id: 'file:remote:source:one', source_id: 'google.work.file', provider: 'google',
      source_label: 'Work drive', remote_id: 'one', filename: 'Original cloud name', path: '/Clients/Original',
      captured_at: 100, content_hash: createHash('sha256').update('DOCX bytes').digest('hex') };
    const file = await f.files.ingest({ bytes: Buffer.from('DOCX bytes'), filename: 'Saved.docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', source_id: 'same-upload',
      origin: 'connection_download', scan_status: 'clean', cloud_capture: capture });
    const message = await f.store.appendMessage({ id: 'origin', session_id: 's', role: 'user', content: 'Read this',
      attachments: [{ file_id: file.record_id, media_class: 'document' }], target_server: 'self',
      picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: '1', instance_id: 'test' } },
      model_used: { provider: 'test', model_id: 'test' } });
    await f.files.ingest({ bytes: Buffer.from('new bytes'), filename: 'Replacement.txt', mime_type: 'text/plain', source_id: 'same-upload',
      origin: 'connection_download', scan_status: 'clean', cloud_capture: { ...capture, source_label: 'New drive', captured_at: 200,
        content_hash: createHash('sha256').update('new bytes').digest('hex') } });
    const result = await f.preview(message.attachments![0]!.file_id);
    expect(result).toMatchObject({ filename: 'Saved.docx', can_download: true, content: { kind: 'docx', bytes_b64: Buffer.from('DOCX bytes').toString('base64') },
      origin: { label: 'Work drive', source_filename: capture.filename, path: capture.path, captured_at: 100, saved_copy: true } });
    expect(result.content_hash).toBe(file.hot_fields.content_hash);
  });

  it('enforces metadata, CAS plaintext, and actual byte limits while retaining the Download fallback', async () => {
    const f = fixture(); const file = await f.ingest('x'.repeat(FILE_PREVIEW_MAX_BYTES + 1));
    const get = vi.spyOn(f.blobs, 'get');
    expect(await f.preview(file.record_id)).toMatchObject({ can_download: true, unavailable_reason: expect.stringContaining('25 MiB') });
    expect(get).not.toHaveBeenCalled();
    await f.ingest('small');
    const metadata = await f.handlers['data.file.attachments.preview']({ record_id: file.record_id,
      selection_revision: f.lifecycle.selection(file.record_id).selection_revision, metadata_only: true }, client);
    expect(metadata).toMatchObject({ can_download: true, size_bytes: 5, content_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(metadata).not.toHaveProperty('content'); expect(get).not.toHaveBeenCalled();
    const size = vi.spyOn(f.blobs, 'plaintextSizeOf').mockResolvedValueOnce(FILE_PREVIEW_MAX_BYTES + 1);
    expect(await f.preview(file.record_id)).toMatchObject({ can_download: true, unavailable_reason: expect.stringContaining('limit') });
    expect(get).not.toHaveBeenCalled(); size.mockRestore();
    get.mockResolvedValueOnce(Buffer.alloc(FILE_PREVIEW_MAX_BYTES + 1));
    expect(await f.preview(file.record_id)).toMatchObject({ can_download: true, unavailable_reason: expect.stringContaining('limit') });
  });
});

/** D-106 follow-up — the Files tab offers Preview on a file in a folder Recued
 *  watches, and the preview rpc took retained files only: every one failed
 *  "Choose a retained file." (live drive, 2026-10-10). */
describe('a watched folder’s file previews', () => {
  const NOTE = '# Kickoff\n\nRenewal in 83 days.\n';
  const watched = async () => {
    const f = fixture();
    const root = mkdtempSync(join(tmpdir(), 'file-preview-watched-'));
    mkdirSync(join(root, 'Sandhurst'));
    writeFileSync(join(root, 'Sandhurst', 'kickoff-notes.md'), NOTE);
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    writeFileSync(join(root, 'brief.pdf'), Buffer.from('%PDF-1.4\n%%EOF\n'));
    writeFileSync(join(root, 'brief.docx'), Buffer.from('DOCX bytes'));
    writeFileSync(join(root, 'data.bin'), Buffer.from([0, 1, 2]));
    const folder = await startWatchedFolder({
      db: f.db, bus: createWarehouseEventBus(), registry: f.registry, slug: 'clients', root,
    });
    cleanups.push(async () => { await folder.close(); rmSync(root, { recursive: true, force: true }); });
    return { ...f, root, id: (path: string) => watchedFileRecordId('clients', path) };
  };

  it('previews text, images, PDF and DOCX from the folder, and copies nothing into Recued', async () => {
    const f = await watched(); const put = vi.spyOn(f.blobs, 'put');
    expect(await f.preview(f.id('Sandhurst/kickoff-notes.md'))).toMatchObject({
      record_id: f.id('Sandhurst/kickoff-notes.md'), filename: 'kickoff-notes.md', mime_type: 'text/markdown',
      size_bytes: Buffer.byteLength(NOTE), transient: false, can_download: true,
      content: { kind: 'text', bytes_b64: Buffer.from(NOTE).toString('base64') },
      origin: { label: 'Watched folder', path: 'Sandhurst/kickoff-notes.md' },
    });
    expect(await f.preview(f.id('logo.png'))).toMatchObject({ mime_type: 'image/png', content: { kind: 'image' } });
    expect(await f.preview(f.id('brief.pdf'))).toMatchObject({ mime_type: 'application/pdf', content: { kind: 'pdf' } });
    expect(await f.preview(f.id('brief.docx'))).toMatchObject({ mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: { kind: 'docx' } });
    const binary = await f.preview(f.id('data.bin'));
    expect(binary).toMatchObject({ can_download: true, unavailable_reason: expect.stringContaining('no preview') });
    expect(binary).not.toHaveProperty('content');
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses a stale selection, a file gone from its folder, and a folder this server does not have', async () => {
    const f = await watched();
    await expect(f.preview(f.id('Sandhurst/kickoff-notes.md'), 'f'.repeat(64)))
      .rejects.toMatchObject({ code: 'file_selection_changed' });
    // Gone from disk while its record stands (no live watch here): the read says so.
    unlinkSync(join(f.root, 'Sandhurst', 'kickoff-notes.md'));
    await expect(f.preview(f.id('Sandhurst/kickoff-notes.md'))).rejects.toMatchObject({ code: 'file_not_found' });
    await expect(f.preview(watchedFileRecordId('elsewhere', 'notes.md'))).rejects.toMatchObject({ code: 'file_not_found' });
  });
});


const conversionResponse = (text: string, run = 'preview-test-run'): ExecuteResponse => stampExecuteResponseAuditRun({
  recipe_id: 'preview-test', recipe_hash: 'hash', success: true,
  output: { render: [{ type: 'summary', data: { bytes_b64: Buffer.from(text).toString('base64'), size_bytes: Buffer.byteLength(text) } }], sidebar: [] },
  steps: [], errors: [], duration_ms: 1,
}, run);
const conversionHold = (run: string): ExecuteResponse => stampExecuteResponseAuditRun({
  recipe_id: 'preview-test', recipe_hash: 'hash', success: false, awaiting_approval: true,
  output: { render: [], sidebar: [] }, steps: [], errors: [], duration_ms: 1,
}, run);
const reader = { converter: 'markitdown' as const, fingerprint: 'installed-reader-v1' };

describe('explicit paired preview conversions', () => {
  it('offers readers without reading bytes and requires a paired web app and an installed reader to start', async () => {
    let installed = false, inventoryUnavailable = false;
    const execute = vi.fn();
    const f = fixture({ readers: () => {
      if (inventoryUnavailable) throw new Error('private-inventory-diagnostic');
      return installed ? [reader] : [];
    }, execute });
    const file = await f.ingest('workbook bytes', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Budget.xlsx');
    const get = vi.spyOn(f.blobs, 'get');
    expect(await f.preview(file.record_id)).toMatchObject({ can_download: true, conversion: { readers: [] } });
    const args = { action: 'start' as const, record_id: file.record_id, selection_revision: f.lifecycle.selection(file.record_id).selection_revision,
      request_id: 'explicit-preview-request-1', converter: 'markitdown' as const };
    const convert = f.handlers['data.file.attachments.convert'];
    await expect(convert(args, { ...client, instance_id: null })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(convert(args, { ...client, client_kind: 'bridge' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(convert(args, client)).rejects.toMatchObject({ code: 'not_configured' });
    inventoryUnavailable = true;
    expect(await f.preview(file.record_id)).toMatchObject({ can_download: true, conversion: { readers: [] } });
    await expect(convert(args, client)).rejects.toMatchObject({
      code: 'not_configured', message: 'Document readers could not be checked. Try again in a moment.',
    });
    inventoryUnavailable = false;
    installed = true;
    expect(await f.preview(file.record_id)).toMatchObject({ conversion: { readers: ['markitdown'] } });
    await f.ingest('new source', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Budget.xlsx');
    await expect(convert(args, client)).rejects.toMatchObject({ code: 'file_selection_changed' });
    expect(get).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(isReservedLocalRpc('data.file.attachments.convert')).toBe(true);
  });

  it('pins the selected stored bytes, bounds extracted text and keeps downloads original and results private to the initiating client', async () => {
    const text = '# Budget\n<img src=x onerror=alert(1)>\n' + 'a'.repeat(100_000);
    const execute = vi.fn(async (_request: Pick<ExecuteRequest, 'recipe' | 'config'>) => conversionResponse(text));
    const f = fixture({ readers: () => [reader], execute });
    const file = await f.ingest('original workbook', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Budget.xlsx');
    const selection = f.lifecycle.selection(file.record_id);
    const result = await f.handlers['data.file.attachments.convert']({ action: 'start', record_id: file.record_id,
      selection_revision: selection.selection_revision, request_id: 'explicit-preview-request-2', converter: 'markitdown' }, client);
    expect(result).toMatchObject({ state: 'ready', record_id: file.record_id, text: text.slice(0, 100_000), truncated: true });
    expect(execute.mock.calls[0]![0].config).toEqual({ source: { backing: 'cas', record_id: file.record_id, content_sha256: createHash('sha256').update('original workbook').digest('hex') } });
    expect((await f.handlers['data.file.read']({ record_id: file.record_id }, client)).bytes_b64).toBe(Buffer.from('original workbook').toString('base64'));
    await expect(f.handlers['data.file.attachments.convert']({ action: 'status', conversion_id: result.conversion_id },
      { ...client, instance_id: 'different-client' })).rejects.toMatchObject({ code: 'not_found' });
    await f.ingest('replacement', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Budget.xlsx');
    const stale = await f.handlers['data.file.attachments.convert']({ action: 'status', conversion_id: result.conversion_id }, client);
    expect(stale.state).toBe('failed'); expect(stale.text).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('deduplicates an approval hold and delivers its resumed text only after rechecking the selected source', async () => {
    const run = 'preview-held-test';
    cleanups.push(() => { takeResumedRunFinisher(run); });
    const execute = vi.fn(async () => conversionHold(run));
    const f = fixture({ readers: () => [reader], execute, runStatus: async () => 'awaiting_approval' });
    const file = await f.ingest('workbook', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Budget.xlsx');
    const args = { action: 'start' as const, record_id: file.record_id, selection_revision: f.lifecycle.selection(file.record_id).selection_revision,
      request_id: 'explicit-preview-request-3', converter: 'markitdown' as const };
    const held = await f.handlers['data.file.attachments.convert'](args, client);
    expect(held).toMatchObject({ state: 'awaiting_approval', run_id: run }); expect(held.text).toBeUndefined();
    expect(await f.handlers['data.file.attachments.convert']({ ...args, request_id: 'another-preview-request-3' }, client)).toEqual(held);
    expect(execute).toHaveBeenCalledTimes(1);
    const finish = takeResumedRunFinisher(run); expect(finish).toBeDefined();
    const delivered = await finish!.finish(conversionResponse('Approved text', run));
    expect(delivered).not.toHaveProperty('result.text');
    expect(await f.handlers['data.file.attachments.convert']({ action: 'status', conversion_id: held.conversion_id }, client))
      .toMatchObject({ state: 'ready', text: 'Approved text' });
    expect(await f.handlers['data.file.attachments.convert']({ ...args, request_id: 'another-preview-request-3' }, client))
      .toMatchObject({ conversion_id: held.conversion_id, state: 'ready', text: 'Approved text' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('withholds converted content after a source change, reader removal, refused approval or converter failure', async () => {
    let installed = true;
    let outcome = conversionHold('preview-changed-test');
    const execute = vi.fn(async () => outcome);
    const f = fixture({ readers: () => installed ? [reader] : [], execute, runStatus: async () => 'cancelled' });
    const file = await f.ingest('workbook', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Budget.xlsx');
    const start = () => f.handlers['data.file.attachments.convert']({ action: 'start', record_id: file.record_id,
      selection_revision: f.lifecycle.selection(file.record_id).selection_revision, request_id: randomUUID(), converter: 'markitdown' }, client);
    const held = await start();
    const finish = takeResumedRunFinisher('preview-changed-test'); expect(finish).toBeDefined();
    await f.ingest('new workbook', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Budget.xlsx');
    await finish!.finish(conversionResponse('stale secret text'));
    expect(await f.handlers['data.file.attachments.convert']({ action: 'status', conversion_id: held.conversion_id }, client))
      .toMatchObject({ state: 'failed' });
    const refused = await start();
    expect(await f.handlers['data.file.attachments.convert']({ action: 'status', conversion_id: refused.conversion_id }, client))
      .toMatchObject({ state: 'failed' });
    takeResumedRunFinisher('preview-changed-test');
    outcome = conversionResponse('cache must be retired');
    const ready = await start(); installed = false;
    const removed = await f.handlers['data.file.attachments.convert']({ action: 'status', conversion_id: ready.conversion_id }, client);
    expect(removed.state).toBe('failed'); expect(removed.text).toBeUndefined();
    installed = true;
    outcome = { ...conversionResponse('must not escape'), success: false, errors: [{ message: 'adapter-private-output' }] };
    const failed = await start(); expect(failed.state).toBe('failed'); expect(failed.text).toBeUndefined();
    expect(JSON.stringify(failed)).not.toContain('adapter-private-output');
  });

  it('expires temporary text rather than rerunning a converter when its result is requested later', async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(async () => conversionResponse('temporary text'));
      const f = fixture({ readers: () => [reader], execute });
      const file = await f.ingest('workbook', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Budget.xlsx');
      const ready = await f.handlers['data.file.attachments.convert']({ action: 'start', record_id: file.record_id,
        selection_revision: f.lifecycle.selection(file.record_id).selection_revision, request_id: 'expiring-preview-request', converter: 'markitdown' }, client);
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);
      await expect(f.handlers['data.file.attachments.convert']({ action: 'status', conversion_id: ready.conversion_id }, client))
        .rejects.toMatchObject({ code: 'not_found' });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('withholds a resumed raw conversion if its finisher was lost and makes the preview retryable', async () => {
    let now = 0;
    const run = 'preview-lost-finisher';
    const execute = vi.fn(async (_request: Pick<ExecuteRequest, 'recipe' | 'config'>) => conversionHold(run));
    const f = fixture({ readers: () => [reader], execute, now: () => now, runStatus: async () => 'succeeded' });
    const file = await f.ingest('workbook', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Budget.xlsx');
    const held = await f.handlers['data.file.attachments.convert']({ action: 'start', record_id: file.record_id,
      selection_revision: f.lifecycle.selection(file.record_id).selection_revision, request_id: 'lost-finisher-preview-request', converter: 'markitdown' }, client);
    takeResumedRunFinisher(run);
    const request = execute.mock.calls[0]![0];
    const recipe = request.recipe as import('@recued/contracts').RecipeDefinition;
    const finished = await finishResumedRun({ run_id: run, recipe_id: recipe.recipe_id, recipe_snapshot: { ...recipe } }, request.config,
      conversionResponse('private extracted text', run));
    expect(finished).toMatchObject({ tool_name: 'file.preview', result: { result: { status: 'unavailable' } } });
    expect(JSON.stringify(finished)).not.toContain('bytes_b64');
    expect(JSON.stringify(finished)).not.toContain('private extracted text');
    await f.handlers['data.file.attachments.convert']({ action: 'status', conversion_id: held.conversion_id }, client);
    now = 4000;
    const failed = await f.handlers['data.file.attachments.convert']({ action: 'status', conversion_id: held.conversion_id }, client);
    expect(failed.state).toBe('failed'); expect(failed.text).toBeUndefined();
  });
});
