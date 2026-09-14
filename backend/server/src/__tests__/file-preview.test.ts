import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
import type { WsClient } from '../ws-server.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const client = { instance_id: 'paired' } as WsClient;
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-preview-')); const db = new Database(':memory:'); ensureChatSchema(db);
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const key = () => new Uint8Array(32).fill(31);
  const blobs = createEncryptedBlobStore(join(dir, 'cas'), key);
  const files = createInboundFileCollection({ db, blobs, slug: 'received', bus: createWarehouseEventBus(),
    gate: createStorageGate({ quota: 100_000_000, reservePct: 10, surface: 'collection:file:received' }) });
  const store = createChatStore(db, key); store.createSession({ id: 's', title: 'Conversation' });
  const registry = createCollectionRegistry(); registry.register(files);
  const handlers = makeFileReadRpcHandlers({ getFileReadDeps: () => ({ registry, blobs }) })!.handlers;
  const ingest = (bytes = 'original bytes', mime_type = 'text/plain', filename = 'Original.txt') =>
    files.ingest({ bytes: Buffer.from(bytes), filename, mime_type, source_id: 'same-upload', origin: 'webclient_upload', scan_status: 'clean' });
  const preview = (record_id: string, selection_revision?: string) => handlers['data.file.attachments.preview']({
    record_id, ...(selection_revision ? { selection_revision } : {}) }, client);
  return { db, blobs, files, store, handlers, ingest, preview, lifecycle: files.attachmentLifecycle! };
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
    const f = fixture(); const file = await f.ingest('zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Doc.docx');
    const get = vi.spyOn(f.blobs, 'get');
    expect(await f.preview(file.record_id)).toMatchObject({ can_download: true, unavailable_reason: expect.stringContaining('no preview') });
    expect(await f.preview(file.record_id)).not.toHaveProperty('content'); expect(get).not.toHaveBeenCalled();
  });

  it('enforces metadata, CAS plaintext, and actual byte limits while retaining the Download fallback', async () => {
    const f = fixture(); const file = await f.ingest('x'.repeat(FILE_PREVIEW_MAX_BYTES + 1));
    const get = vi.spyOn(f.blobs, 'get');
    expect(await f.preview(file.record_id)).toMatchObject({ can_download: true, unavailable_reason: expect.stringContaining('25 MiB') });
    expect(get).not.toHaveBeenCalled();
    await f.ingest('small');
    const size = vi.spyOn(f.blobs, 'plaintextSizeOf').mockResolvedValueOnce(FILE_PREVIEW_MAX_BYTES + 1);
    expect(await f.preview(file.record_id)).toMatchObject({ can_download: true, unavailable_reason: expect.stringContaining('limit') });
    expect(get).not.toHaveBeenCalled(); size.mockRestore();
    get.mockResolvedValueOnce(Buffer.alloc(FILE_PREVIEW_MAX_BYTES + 1));
    expect(await f.preview(file.record_id)).toMatchObject({ can_download: true, unavailable_reason: expect.stringContaining('limit') });
  });
});
