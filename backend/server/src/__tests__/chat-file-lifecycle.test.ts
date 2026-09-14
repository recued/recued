import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { ChatMessageAttachment } from '@recued/contracts';
import { createChatStore, encodeChatContentForStorage, ensureChatSchema } from '../storage/chat-store.js';
import { createChatTurnQueueStore, type QueuedChatCommand } from '../storage/chat-turn-queue-store.js';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { createEncryptedBlobStore } from '../storage/blob-store.js';
import { listCollectionReferencedBlobHashes } from '../storage/collection-blob-refs.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { makeFileReadRpcHandlers } from '../file-read-rpc-handler.js';
import { handleCollectionDeleteRecord } from '../collections/collection-handler.js';
import { createMessengerAttachmentSource } from '../chat-messenger-attachments.js';
import type { WsClient } from '../ws-server.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'file-lifecycle' };
const worker = { id: 'worker', pid: process.pid, started_at: Date.now() - Math.round(process.uptime() * 1000) };
const fixture = (path?: string, directory?: string) => {
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'file-lifecycle-'));
  if (!directory) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(path ?? ':memory:'); ensureChatSchema(db);
  cleanups.push(() => { if (db.open) db.close(); });
  const key = () => new Uint8Array(32).fill(31);
  const blobs = createEncryptedBlobStore(join(dir, 'cas'), key);
  const files = createInboundFileCollection({ db, blobs, slug: 'received', bus: createWarehouseEventBus(),
    gate: createStorageGate({ quota: 100_000_000, reservePct: 10, surface: 'collection:file:received' }) });
  const store = createChatStore(db, key); if (!store.getSession('s')) store.createSession({ id: 's', title: 'A conversation' });
  const queue = createChatTurnQueueStore(db, key);
  const lifecycle = files.attachmentLifecycle!;
  const registry = createCollectionRegistry(); registry.register(files);
  const handlers = makeFileReadRpcHandlers({ getFileReadDeps: () => ({ registry, blobs }) })!.handlers;
  const ingest = (text = 'original bytes', filename = 'Original.txt') => files.ingest({ bytes: Buffer.from(text), filename,
    mime_type: 'text/plain', origin: 'webclient_upload', source_id: 'same-upload', scan_status: 'clean' });
  const command = (file_id: string, message = 'Read this file', session_id = 's'): QueuedChatCommand => ({ family: 'chat', session_id, message,
    input: { session_id, message, picker_state: { current: 'self' }, attachments: [{ file_id, media_class: 'document' }] } });
  const append = (id: string, attachments: ChatMessageAttachment[], session_id = 's', turn_id?: string, ts?: number) => store.appendMessage({ id, session_id,
    role: 'user', content: 'Original immutable message', attachments, target_server: 'self',
    picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'fixture', model_id: 'fixture' },
    ...(turn_id ? { turn_id } : {}), ...(ts !== undefined ? { ts } : {}) });
  const mutate = (id: string, action: 'archive' | 'delete') => files.mutateLifecycle!({ record_id: id, action, revision: lifecycle.preview(id).revision });
  return { db, dir, key, store, blobs, files, lifecycle, queue, handlers, registry, ingest, command, append, mutate };
};
const client = { instance_id: 'paired' } as WsClient;

describe('conversation files', () => {
  it('groups shared immutable versions, excludes drafts and other conversations, and reuses exact historical bytes', async () => {
    const f = fixture(); f.store.createSession({ id: 'other', title: 'Other' });
    const original = await f.ingest();
    const first = await f.append('first', [{ file_id: original.record_id, media_class: 'document' }], 's', undefined, 1);
    const old = first.attachments![0]!;
    await f.append('latest-original', [old], 's', undefined, 5);
    await f.append('outside', [old], 'other', undefined, 10);
    await f.ingest('replacement bytes', 'Replacement.txt');
    const replaced = await f.append('replacement', [{ file_id: original.record_id, media_class: 'document' }], 's', undefined, 3);
    const draft = await f.files.ingest({ bytes: Buffer.from('draft'), filename: 'Unsent.txt', mime_type: 'text/plain',
      source_id: 'unsent', origin: 'webclient_upload', scan_status: 'clean' });
    await f.queue.admit(f.command(draft.record_id), 'draft');
    const result = await f.handlers['data.file.attachments.conversation']({ session_id: 's' }, client);
    expect(result.files).toEqual([
      expect.objectContaining({ file_id: old.file_id, source_file_id: original.record_id, filename: 'Original.txt', message_count: 2,
        last_message_id: 'latest-original', last_message_at: 5, version_number: 1, version_count: 2, availability: 'available', legacy_capture: false }),
      expect.objectContaining({ file_id: replaced.attachments![0]!.file_id, filename: 'Replacement.txt', message_count: 1,
        last_message_id: 'replacement', version_number: 2, version_count: 2 }),
    ]);
    expect(JSON.stringify(result)).not.toContain('Original immutable message');
    expect(JSON.stringify(result)).not.toContain('bytes_b64');
    const selection = await f.handlers['data.file.attachments.get']({ record_id: result.files[0]!.file_id }, client);
    const reuse = f.command(selection.file_id, 'Read the old version'); reuse.input.attachments = [selection];
    const ack = await f.queue.admit(reuse, 'reuse');
    expect((await f.queue.read(f.queue.get(ack.turn_id)!)).input.attachments).toEqual([expect.objectContaining({ file_id: old.file_id })]);
    expect(await f.handlers['data.file.read']({ record_id: selection.file_id }, client)).toMatchObject({ bytes_b64: Buffer.from('original bytes').toString('base64') });
  });

  it('filters the full retained history before paging with stable tie ordering and session-scoped cursors', async () => {
    const f = fixture(); f.store.createSession({ id: 'other', title: 'Other' });
    for (let i = 0; i < 37; i++) {
      const file = await f.files.ingest({ bytes: Buffer.from(`file ${i}`), filename: `${i < 7 ? 'Older MATCH' : 'Recent'} ${i}.txt`,
        mime_type: i % 2 ? 'image/png' : 'text/plain', origin: 'messenger_media', source_id: `messenger:${i}`, scan_status: 'clean' });
      await f.append(`m${i}`, [{ file_id: file.record_id, media_class: i % 2 ? 'image' : 'document' }], 's', undefined, i < 7 ? 1 : i);
    }
    const args = { session_id: 's', query: 'older match', media_class: 'document' as const, limit: 2 };
    const first = await f.handlers['data.file.attachments.conversation'](args, client);
    const next = await f.handlers['data.file.attachments.conversation']({ ...args, cursor: first.next_cursor! }, client);
    expect(first.files).toHaveLength(2); expect(first.next_cursor).toBeTruthy();
    expect(next.files).toHaveLength(2); expect(next.next_cursor).toBeUndefined();
    const ids = [...first.files, ...next.files].map(file => file.file_id);
    expect(new Set(ids).size).toBe(4); expect(ids).toEqual([...ids].sort());
    for (const change of [{ session_id: 'other' }, { query: 'Recent' }, { media_class: 'image' as const }]) {
      await expect(f.handlers['data.file.attachments.conversation']({ ...args, ...change, cursor: first.next_cursor! }, client)).rejects.toThrow('file search changed');
    }
    expect((await f.handlers['data.file.attachments.conversation']({ session_id: 'other' }, client)).files).toEqual([]);
  });

  it('keeps archived and deleted references visible and removes entries when their last message is removed', async () => {
    const f = fixture(); const file = await f.ingest(); const message = await f.append('m', [{ file_id: file.record_id, media_class: 'document' }]);
    const list = () => f.handlers['data.file.attachments.conversation']({ session_id: 's' }, client);
    f.mutate(file.record_id, 'archive'); expect((await list()).files[0]).toMatchObject({ archived: true, availability: 'available' });
    f.mutate(file.record_id, 'delete'); expect((await list()).files[0]).toMatchObject({ filename: 'Original.txt', availability: 'deleted', last_message_id: 'm' });
    await expect(f.handlers['data.file.attachments.get']({ record_id: message.attachments![0]!.file_id }, client)).rejects.toThrow('no longer available');
    f.db.prepare('DELETE FROM chat_messages WHERE message_id=?').run('m'); expect((await list()).files).toEqual([]);
  });

  it('shows missing legacy references truthfully without reading message bodies or inventing bytes', async () => {
    const f = fixture(); await f.append('legacy', []);
    f.store.createSession({ id: 'other', title: 'Other' }); await f.append('outside-legacy', [], 'other');
    f.db.prepare('UPDATE chat_messages SET attachments_blob=? WHERE message_id=?').run(JSON.stringify([
      { file_id: 'file:abcdef0123456789abcdef0123456789', media_class: 'document' },
    ]), 'outside-legacy');
    f.db.prepare('UPDATE chat_messages SET attachments_blob=? WHERE message_id=?').run(JSON.stringify([
      { file_id: 'file:0123456789abcdef0123456789abcdef', media_class: 'document' },
    ]), 'legacy');
    const list = await f.handlers['data.file.attachments.conversation']({ session_id: 's' }, client);
    expect(list.files).toEqual([expect.objectContaining({ availability: 'missing', legacy_capture: true, filename: 'Attachment', last_message_id: 'legacy' })]);
    expect(f.db.prepare("SELECT * FROM file_attachment_bindings WHERE session_id='other'").all()).toEqual([]);
  });

  it('requires paired authority and rejects invalid requests, stale sessions and malformed cursors', async () => {
    const f = fixture(); const list = f.handlers['data.file.attachments.conversation'];
    await expect(list({ session_id: 's' }, {} as WsClient)).rejects.toThrow('registered paired client');
    await expect(list({ session_id: 'gone' }, client)).rejects.toThrow('conversation no longer exists');
    for (const bad of [{ session_id: '' }, { limit: 0 }, { limit: 101 }, { limit: 1.1 }, { query: 'a'.repeat(201) }, { cursor: 'bad' }]) {
      await expect(list({ session_id: 's', ...bad }, client)).rejects.toThrow();
    }
  });
});

describe('choose retained files for Chat', () => {
  it('searches before limiting, pages without repeats, and keeps archived files selectable', async () => {
    const f = fixture();
    for (let i = 0; i < 36; i++) await f.files.ingest({ bytes: Buffer.from(`file ${i}`), filename: `${i < 3 ? 'Older match' : 'Other'} ${i}.txt`,
      mime_type: 'text/plain', source_id: `source-${i}`, origin: 'webclient_upload', scan_status: 'clean' });
    const search = await f.handlers['data.file.attachments.list']({ query: 'older MATCH', limit: 2 }, client);
    expect(search.files).toHaveLength(2); expect(search.next_cursor).toBeTruthy();
    const more = await f.handlers['data.file.attachments.list']({ query: 'older MATCH', limit: 2, cursor: search.next_cursor! }, client);
    expect(more.files).toHaveLength(1); expect(more.next_cursor).toBeUndefined();
    expect(new Set([...search.files, ...more.files].map(file => file.file_id)).size).toBe(3);
    await expect(f.handlers['data.file.attachments.list']({ query: 'Other', cursor: search.next_cursor! }, client)).rejects.toThrow('Search again');
    const file = search.files[0]!; f.mutate(file.file_id, 'archive');
    expect((await f.handlers['data.file.attachments.list']({ query: 'Older match' }, client)).files).toHaveLength(2);
    expect((await f.handlers['data.file.attachments.list']({ archived: true }, client)).files).toEqual([file]);
    expect(await f.handlers['data.file.attachments.get']({ record_id: file.file_id }, client)).toEqual(file);
    expect(f.db.prepare('SELECT * FROM collection_file_attachment_versions').all()).toHaveLength(0);
    expect(file).not.toHaveProperty('bytes_b64');
  });

  it('requires a paired client and validates list inputs and retained identities', async () => {
    const f = fixture();
    await expect(f.handlers['data.file.attachments.list']({}, {} as WsClient)).rejects.toThrow('registered paired client');
    await expect(f.handlers['data.file.attachments.get']({ record_id: 'file:remote:test' }, client)).rejects.toThrow('retained file');
    for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { query: 'a'.repeat(201) }, { cursor: 'invalid' }]) {
      await expect(f.handlers['data.file.attachments.list'](args, client)).rejects.toThrow();
    }
  });

  it('rejects a replaced selection before admitting a turn and can select the replacement explicitly', async () => {
    const f = fixture(); const original = await f.ingest();
    const selected = f.lifecycle.selection(original.record_id);
    const command = f.command(original.record_id); command.input.attachments = [selected];
    await f.ingest('new bytes', 'Replacement.txt');
    await expect(f.queue.admit(command, 'changed-selection')).rejects.toThrow('selected file changed');
    expect(f.db.prepare('SELECT * FROM chat_turn_queue').all()).toHaveLength(0);
    expect(f.db.prepare('SELECT * FROM file_attachment_bindings').all()).toHaveLength(0);
    command.input.attachments = [f.lifecycle.selection(original.record_id)];
    await expect(f.queue.admit(command, 'changed-selection')).resolves.toHaveProperty('turn_id');
  });

  it('rejects a deleted selection without creating a message or queue entry', async () => {
    const f = fixture(); const original = await f.ingest(); const command = f.command(original.record_id);
    command.input.attachments = [f.lifecycle.selection(original.record_id)]; f.mutate(original.record_id, 'delete');
    await expect(f.queue.admit(command, 'deleted-selection')).rejects.toThrow('no longer available');
    expect(f.db.prepare('SELECT * FROM chat_turn_queue').all()).toHaveLength(0);
    expect(await f.store.listMessages('s')).toHaveLength(0);
  });

  it('reuses immutable bytes across conversations and restores names on withdrawal', async () => {
    const f = fixture(); const original = await f.ingest(); const command = f.command(original.record_id);
    command.input.attachments = [f.lifecycle.selection(original.record_id)];
    const ack = await f.queue.admit(command, 'selected'); const draft = await f.queue.withdraw('s', ack.turn_id);
    expect(draft.attachments?.[0]).toMatchObject({ filename: 'Original.txt', source_file_id: original.record_id });
    expect(draft.attachments?.[0]).not.toHaveProperty('selection_revision');
    await f.ingest('replacement', 'Replacement.txt');
    const historical = f.lifecycle.selection(draft.attachments![0]!.file_id);
    f.store.createSession({ id: 'other', title: 'Other' });
    const other = f.command(historical.file_id, 'Use the original', 'other'); other.input.attachments = [historical];
    const second = await f.queue.admit(other, 'other'); const frozen = await f.queue.read(f.queue.get(second.turn_id)!);
    expect((frozen.input.attachments as ChatMessageAttachment[])[0]!.file_id).toBe(historical.file_id);
    expect(await f.handlers['data.file.read']({ record_id: historical.file_id }, client)).toMatchObject({ filename: 'Original.txt', bytes_b64: Buffer.from('original bytes').toString('base64') });
    expect(f.lifecycle.listSelections({}).files.map(file => file.filename)).toEqual(['Replacement.txt']);
  });

  it('replays a selected submission after deletion without creating another turn', async () => {
    const f = fixture(); const original = await f.ingest(); const command = f.command(original.record_id);
    command.input.attachments = [f.lifecycle.selection(original.record_id)];
    const ack = await f.queue.admit(command, 'lost-ack'); f.mutate(original.record_id, 'delete');
    expect((await f.queue.admit(command, 'lost-ack')).turn_id).toBe(ack.turn_id);
    expect(f.db.prepare('SELECT * FROM chat_turn_queue').all()).toHaveLength(1);
  });
});

describe('retained file lifecycle', () => {
  it('pins accepted bytes and metadata across library replacement, archive, execution and Messenger materialization', async () => {
    const f = fixture(); const original = await f.ingest();
    const ack = await f.queue.admit(f.command(original.record_id), 'submission');
    const frozen = await f.queue.read(f.queue.get(ack.turn_id)!);
    const attachments = frozen.input.attachments as ChatMessageAttachment[];
    expect(attachments[0]!.file_id).not.toBe(original.record_id);
    await f.ingest('replacement', 'Renamed.txt');
    expect(f.lifecycle.preview(original.record_id)).toMatchObject({ queued_count: 1, in_use: false });
    f.mutate(original.record_id, 'archive');
    expect(f.files.get(original.record_id)?.hot_fields.archived).toBe(1);
    expect(f.files.list({ platform: 'file', slug: 'received' })).toHaveLength(0);
    const read = await f.handlers['data.file.read']({ record_id: attachments[0]!.file_id }, client);
    expect(read).toMatchObject({ filename: 'Original.txt', bytes_b64: Buffer.from('original bytes').toString('base64') });
    f.queue.claim('chat', worker);
    const message = await f.append('m', attachments, 's', ack.turn_id);
    expect(message.attachments?.[0]).toMatchObject({ filename: 'Original.txt', source_file_id: original.record_id, availability: 'available' });
    const source = createMessengerAttachmentSource(f.files, join(f.dir, 'scratch'));
    const plan = source.snapshot(attachments[0]!.file_id); const opened = await source.open(plan);
    expect(f.lifecycle.preview(original.record_id).in_use).toBe(true);
    await opened.dispose(); f.queue.settle(ack.turn_id, worker.id, 'completed');
    expect(listCollectionReferencedBlobHashes(f.db).has(original.hot_fields.content_hash)).toBe(true);
  });

  it('uses the shared delete guard and SQL guard, then tombstones history without changing its text', async () => {
    const f = fixture(); const file = await f.ingest();
    const message = await f.append('m', [{ file_id: file.record_id, media_class: 'document' }]);
    await expect(handleCollectionDeleteRecord({ registry: f.registry } as Parameters<typeof handleCollectionDeleteRecord>[0],
      { platform: 'file', slug: 'received', record_id: file.record_id })).rejects.toThrow('retained');
    const table = (f.db.prepare('SELECT table_name FROM file_attachment_sources WHERE slug=?').get('received') as { table_name: string }).table_name;
    expect(() => f.db.prepare(`DELETE FROM "${table}" WHERE record_id=?`).run(file.record_id)).toThrow('retained');
    f.mutate(file.record_id, 'delete');
    expect((await f.store.listMessages('s'))[0]).toMatchObject({ content: 'Original immutable message',
      attachments: [{ file_id: message.attachments![0]!.file_id, filename: 'Original.txt', availability: 'deleted' }] });
    await expect(f.handlers['data.file.read']({ record_id: message.attachments![0]!.file_id }, client)).rejects.toMatchObject({ code: 'file_not_found' });
    expect(listCollectionReferencedBlobHashes(f.db).has(file.hot_fields.content_hash)).toBe(false);
  });

  it('rejects stale impact after another database client attaches, and handles both claim/delete orderings', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'file-clients-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const first = fixture(join(directory, 'db.sqlite'), directory); const second = fixture(join(directory, 'db.sqlite'), directory);
    const file = await first.ingest(); const preview = first.lifecycle.preview(file.record_id);
    const ack = await second.queue.admit(second.command(file.record_id), 'second-client');
    expect(() => first.files.mutateLifecycle!({ record_id: file.record_id, action: 'delete', revision: preview.revision })).toThrow('usage changed');
    const queuedPreview = first.lifecycle.preview(file.record_id);
    second.queue.claim('chat', worker);
    expect(() => first.files.mutateLifecycle!({ record_id: file.record_id, action: 'delete', revision: queuedPreview.revision })).toThrow('usage changed');
    expect(() => first.mutate(file.record_id, 'delete')).toThrow('currently in use');
    second.queue.settle(ack.turn_id, worker.id, 'completed');
    const next = await second.queue.admit(second.command(file.record_id, 'Next'), 'next');
    first.mutate(file.record_id, 'delete');
    expect(second.queue.claim('chat', worker)).toBeUndefined();
    expect((await second.queue.snapshot('s')).turns.find(t => t.turn_id === next.turn_id)).toMatchObject({ status: 'failed', failure_reason: 'attachment_deleted' });
    expect(await second.queue.admit(second.command(file.record_id, 'Next'), 'next')).toMatchObject({ turn_id: next.turn_id, disposition: 'replayed' });
  });

  it('deduplicates identical accepted versions and treats replacement bytes as a different command', async () => {
    const f = fixture(); const file = await f.ingest();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.queue.admit(f.command(file.record_id), `same-${i}`)));
    expect(new Set(results.map(r => r.turn_id)).size).toBe(1);
    await f.ingest('new bytes');
    const next = await f.queue.admit(f.command(file.record_id), 'new-version');
    expect(next.turn_id).not.toBe(results[0]!.turn_id);
    expect(await f.queue.admit(f.command(file.record_id), 'same-0')).toMatchObject({ turn_id: results[0]!.turn_id, disposition: 'replayed' });
  });

  it('keeps shared attachment bytes until the last conversation releases its reference', async () => {
    const f = fixture(); const file = await f.ingest(); f.store.createSession({ id: 'other' });
    const first = await f.append('first', [{ file_id: file.record_id, media_class: 'document' }]);
    await f.append('second', first.attachments!, 'other');
    f.mutate(file.record_id, 'archive'); f.store.deleteSession('s');
    expect(f.files.get(first.attachments![0]!.file_id)).not.toBeNull();
    expect(f.lifecycle.preview(first.attachments![0]!.file_id)).toMatchObject({ message_count: 1, conversation_count: 1 });
    f.store.deleteSession('other');
    // Archiving preserves the library's own copy even without a conversation.
    expect(listCollectionReferencedBlobHashes(f.db).has(file.hot_fields.content_hash)).toBe(true);
    f.mutate(file.record_id, 'delete');
    expect(listCollectionReferencedBlobHashes(f.db).has(file.hot_fields.content_hash)).toBe(false);
  });

  it('preserves unreferenced archived files and encrypted attachment versions across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'file-restart-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'db.sqlite'); const first = fixture(path, directory);
    const file = await first.ingest();
    const message = await first.append('restart', [{ file_id: file.record_id, media_class: 'document' }]);
    await first.ingest('new library bytes', 'New.txt'); first.mutate(file.record_id, 'archive');
    first.db.close();
    const restarted = fixture(path, directory);
    expect(restarted.files.list({ platform: 'file', slug: 'received' })).toEqual([]);
    expect(restarted.files.list({ platform: 'file', slug: 'received', filters: { archived: 1 } }))
      .toMatchObject([{ hot_fields: { filename: 'New.txt' } }]);
    expect((await restarted.files.readBytes(message.attachments![0]!.file_id)).bytes.toString()).toBe('original bytes');
    restarted.store.deleteSession('s');
    expect((await restarted.files.readBytes(file.record_id)).bytes.toString()).toBe('new library bytes');
    expect(listCollectionReferencedBlobHashes(restarted.db).has(file.hot_fields.content_hash)).toBe(false);
  });

  it('does not purge a newer upload or repeat cascades when a lost deletion acknowledgement is replayed', async () => {
    const f = fixture(); const file = await f.ingest();
    const changes: string[] = [];
    const handlers = makeFileReadRpcHandlers({ getFileReadDeps: () => ({ registry: f.registry, blobs: f.blobs }),
      deleted: id => { changes.push(id); } })!.handlers;
    const input = { record_id: file.record_id, action: 'delete' as const, revision: f.lifecycle.preview(file.record_id).revision };
    await handlers['data.file.mutate'](input, client);
    await f.ingest('New upload');
    await handlers['data.file.mutate'](input, client);
    expect(changes).toEqual([file.record_id]);
    expect((await f.files.readBytes(file.record_id)).bytes.toString()).toBe('New upload');
  });

  it('does not purge identical bytes retained by a different file and rejects released or changed read identities', async () => {
    const f = fixture(); const first = await f.ingest();
    const second = await f.files.ingest({ bytes: Buffer.from('original bytes'), filename: 'Other.txt',
      mime_type: 'text/plain', origin: 'webclient_upload', source_id: 'independent-upload' });
    const message = await f.append('release', [{ file_id: first.record_id, media_class: 'document' }]);
    const prepared = f.lifecycle.prepare(message.attachments!);
    f.store.deleteSession('s');
    expect(() => f.lifecycle.bind('message', 'late', 's', prepared)).toThrow('released');
    await f.ingest('replacement');
    expect(() => f.lifecycle.lease(first.record_id, first.hot_fields.content_hash)).toThrow('changed');
    f.mutate(first.record_id, 'delete');
    expect(listCollectionReferencedBlobHashes(f.db).has(second.hot_fields.content_hash)).toBe(true);
    expect((await f.files.readBytes(second.record_id)).bytes.toString()).toBe('original bytes');
  });

  it('opens legacy Messenger plans from the retained version after replacement but never revives an explicit purged version', async () => {
    const f = fixture(); const file = await f.ingest();
    const source = createMessengerAttachmentSource(f.files, join(f.dir, 'scratch'));
    const legacyPlan = source.snapshot(file.record_id);
    const message = await f.append('version', [{ file_id: file.record_id, media_class: 'document' }]);
    const exactPlan = source.snapshot(message.attachments![0]!.file_id);
    await f.ingest('replacement'); f.mutate(file.record_id, 'archive');
    const opened = await source.open(legacyPlan); await opened.dispose();
    f.mutate(file.record_id, 'delete');
    await f.ingest();
    await expect(source.open(exactPlan)).rejects.toMatchObject({ code: 'attachment_unavailable' });
  });

  it('holds read leases across database clients and releases them on errors', async () => {
    const f = fixture(); const file = await f.ingest();
    const release = f.lifecycle.lease(file.record_id);
    expect(() => f.mutate(file.record_id, 'delete')).toThrow('currently in use'); release();
    const get = f.blobs.get; f.blobs.get = async () => { throw new Error('read failed'); };
    await expect(f.handlers['data.file.read']({ record_id: file.record_id }, client)).rejects.toThrow('read failed');
    f.blobs.get = get; expect(f.lifecycle.preview(file.record_id).in_use).toBe(false);
    f.mutate(file.record_id, 'delete');
  });

  it('migrates legacy message and encrypted queue references honestly, blocking deletion until queue indexing finishes', async () => {
    const f = fixture(); const file = await f.ingest();
    const first = await f.append('old', [{ file_id: file.record_id, media_class: 'document' }]);
    const ack = await f.queue.admit(f.command(file.record_id), 'legacy');
    // Simulate a pre-version database while preserving the actual encrypted command.
    f.db.prepare('UPDATE chat_messages SET attachments_blob=? WHERE message_id=?')
      .run(JSON.stringify([{ file_id: file.record_id, media_class: 'document' }]), first.id);
    f.db.prepare("DELETE FROM file_attachment_bindings WHERE kind='message'").run();
    const legacyPayload = await encodeChatContentForStorage(JSON.stringify(f.command(file.record_id)),
      { session_id: 's', message_id: `queue:${ack.turn_id}` }, f.key);
    f.db.prepare('UPDATE chat_turn_queue SET attachments_indexed=0,payload=? WHERE turn_id=?').run(legacyPayload, ack.turn_id);
    expect(() => f.lifecycle.preview(file.record_id)).toThrow('indexed');
    await f.queue.indexLegacyAttachments();
    expect((await f.store.listMessages('s'))[0]!.attachments?.[0]).toMatchObject({ legacy_capture: true, availability: 'available' });
    expect(f.lifecycle.preview(file.record_id)).toMatchObject({ message_count: 1, queued_count: 1 });
    expect(await f.queue.admit(f.command(file.record_id), 'after-upgrade')).toMatchObject({ turn_id: ack.turn_id, disposition: 'duplicate' });
    expect(await f.queue.admit(f.command(file.record_id), 'legacy')).toMatchObject({ turn_id: ack.turn_id, disposition: 'replayed' });
  });

  it('blocks deletion and preserves FIFO while allowing indexed conversations past unrelated legacy history', async () => {
    const f = fixture(); const file = await f.ingest();
    const old = await f.queue.admit(f.command(file.record_id), 'old');
    f.db.prepare('UPDATE chat_turn_queue SET attachments_indexed=0 WHERE turn_id=?').run(old.turn_id);
    await f.queue.admit(f.command(file.record_id, 'Same conversation waits'), 'later');
    f.store.createSession({ id: 'other' });
    const independent = await f.queue.admit(f.command(file.record_id, 'Other conversation', 'other'), 'other');
    expect(f.queue.claim('chat', worker)?.turn_id).toBe(independent.turn_id);
    expect(f.queue.claim('chat', worker)).toBeUndefined();
    expect(() => f.lifecycle.preview(file.record_id)).toThrow('indexed');
    await f.queue.indexLegacyAttachments();
    expect(f.queue.claim('chat', worker)?.turn_id).toBe(old.turn_id);
  });

  it('requires a paired client for impact and mutation and validates action/revision', async () => {
    const f = fixture(); const file = await f.ingest();
    for (const method of ['data.file.usage', 'data.file.mutate'] as const) {
      await expect(f.handlers[method]({ record_id: file.record_id, action: 'delete', revision: 'x' }, {} as WsClient))
        .rejects.toMatchObject({ code: 'unauthorized' });
    }
    await expect(f.handlers['data.file.usage']({ record_id: 'file:remote:any' }, client)).rejects.toMatchObject({ code: 'bad_request' });
    const preview = await f.handlers['data.file.usage']({ record_id: file.record_id }, client);
    expect(await f.handlers['data.file.mutate']({ record_id: file.record_id, revision: preview.revision, action: 'delete' }, client)).toMatchObject({ deleted: true });
  });
});
