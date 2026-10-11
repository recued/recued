/** D-106 follow-up — a file in a folder Recued watches, brought into Chat.
 *
 *  Chat attaches retained files only, so the Files tab's "Import and use in
 *  Chat" copies a watched file into the received files, as it does a connected
 *  source's file. Driven through the paired rpcs the picker calls
 *  (`data.file.attachments.remote.get` → `data.file.attachments.import`), over
 *  a real watched folder and a real received-files store. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { watchedFileRecordId } from '../collections/file/watched-folder-collection.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { makeFileReadRpcHandlers } from '../file-read-rpc-handler.js';
import { createEncryptedBlobStore } from '../storage/blob-store.js';
import { ensureChatSchema } from '../storage/chat-store.js';
import type { WsClient } from '../ws-server.js';
import { startWatchedFolder } from './helpers/watched-folder.js';

const NOTE = '# Sandhurst brief\n\nRenewal in 83 days.\n';
const client = { instance_id: 'paired' } as WsClient;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const world = async (receivedQuota = 100_000_000) => {
  const dir = mkdtempSync(join(tmpdir(), 'folder-import-'));
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const blobs = createEncryptedBlobStore(join(dir, 'cas'), () => new Uint8Array(32).fill(7));
  const received = createInboundFileCollection({
    db, blobs, slug: 'received', bus: createWarehouseEventBus(),
    gate: createStorageGate({ quota: receivedQuota, reservePct: 1, surface: 'collection:file:received' }),
  });
  const registry = createCollectionRegistry();
  registry.register(received);
  const root = join(dir, 'Clients');
  mkdirSync(join(root, 'Sandhurst'), { recursive: true });
  writeFileSync(join(root, 'Sandhurst', 'brief.md'), NOTE);
  const folder = await startWatchedFolder({ db, bus: createWarehouseEventBus(), registry, slug: 'clients', root });
  const audit: Array<{ action: string; detail?: string }> = [];
  const handlers = makeFileReadRpcHandlers({
    getFileReadDeps: () => ({
      registry, blobs,
      auditLog: { logActivity: async (entry: { action: string; detail?: string }) => { audit.push(entry); } } as never,
    }),
    folderAttachments: { db },
  })!.handlers;
  cleanups.push(async () => { await folder.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const id = watchedFileRecordId('clients', 'Sandhurst/brief.md');
  const select = () => handlers['data.file.attachments.remote.get']({ record_id: id }, client);
  const bring = (selection_revision: string, import_id: string = randomUUID()) =>
    handlers['data.file.attachments.import']({ record_id: id, selection_revision, import_id }, client);
  const copies = () => received.list({ platform: 'file', slug: 'received', limit: 50 })
    .filter((r) => r.hot_fields.origin === 'watched_folder');
  return { root, folder, received, handlers, audit, id, select, bring, copies };
};

describe('a watched file brought into Chat', () => {
  it('is copied into the saved files, read from its folder, with where it came from', async () => {
    const w = await world();
    const selected = await w.select();
    expect(selected).toMatchObject({
      record_id: w.id, source_id: 'clients', filename: 'brief.md', path: 'Sandhurst/brief.md',
      mime_type: 'text/markdown', size: Buffer.byteLength(NOTE),
    });
    expect(selected).not.toHaveProperty('unavailable_reason');

    const saved = await w.bring(selected.selection_revision);
    expect(saved).toMatchObject({ filename: 'brief.md', mime_type: 'text/markdown', size: Buffer.byteLength(NOTE) });
    expect(saved.file_id).toMatch(/^file:[0-9a-f]{32}$/);
    expect(w.received.get(saved.file_id)?.hot_fields.origin).toBe('watched_folder');
    expect((await w.received.readBytes(saved.file_id)).bytes.toString()).toBe(NOTE);
    expect(w.audit.filter((a) => a.action === 'collection_record_created').map((a) => JSON.parse(a.detail!).operation))
      .toEqual(['folder_attachment_import']);
    // The picker's own Preview takes the same revision.
    await expect(w.handlers['data.file.attachments.preview']({ record_id: w.id, selection_revision: selected.selection_revision }, client))
      .resolves.toMatchObject({ content: { kind: 'text' } });
  });

  it('a retry with the same import id returns the same copy, never a second one', async () => {
    const w = await world();
    const { selection_revision } = await w.select();
    const importId = randomUUID();
    const first = await w.bring(selection_revision, importId);
    expect((await w.bring(selection_revision, importId)).file_id).toBe(first.file_id);
    const again = randomUUID();
    const [a, b] = await Promise.all([w.bring(selection_revision, again), w.bring(selection_revision, again)]);
    expect(a.file_id).toBe(b.file_id);
    expect(w.copies()).toHaveLength(2);
    // One import id is one request: the same id for another revision is refused.
    await expect(w.bring('a'.repeat(64), importId)).rejects.toMatchObject({ code: 'file_selection_changed' });
  });

  it('refuses a stale selection, a file gone from its folder, and one too large to keep', async () => {
    const w = await world();
    const { selection_revision } = await w.select();
    // Edited in the folder after it was picked: the watch moves its record on.
    writeFileSync(join(w.root, 'Sandhurst', 'brief.md'), `${NOTE}And one more line.\n`);
    await w.folder.collection.ingest({ type: 'change', path: join(w.root, 'Sandhurst', 'brief.md') });
    await expect(w.bring(selection_revision)).rejects.toMatchObject({ code: 'file_selection_changed' });
    // Gone from disk while its record stands (no live watch here).
    const current = await w.select();
    unlinkSync(join(w.root, 'Sandhurst', 'brief.md'));
    await expect(w.bring(current.selection_revision)).rejects.toMatchObject({ code: 'file_not_found' });
    expect(w.copies()).toEqual([]);

    const small = await world(10);
    const offered = await small.select();
    expect(offered.unavailable_reason).toBe('There is not enough room left in your saved files for this file.');
    await expect(small.bring(offered.selection_revision)).rejects.toMatchObject({ code: 'file_too_large' });
  });

  it('refuses a malformed request before reading anything', async () => {
    const w = await world();
    const { selection_revision } = await w.select();
    await expect(w.bring('not-a-revision')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(w.bring(selection_revision, 'not-a-uuid')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(w.handlers['data.file.attachments.remote.get']({ record_id: watchedFileRecordId('elsewhere', 'x.md') }, client))
      .rejects.toMatchObject({ code: 'file_not_found' });
    expect(w.copies()).toEqual([]);
  });
});
