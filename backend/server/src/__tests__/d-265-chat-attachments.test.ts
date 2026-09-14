import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { OutboundAttachment, OutboundMessage, TransportSendResult } from '@recued/transport';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { createEncryptedBlobStore, resolveBlobObjectPath } from '../storage/blob-store.js';
import { createChatStore, encodeChatContentForStorage, ensureChatSchema } from '../storage/chat-store.js';
import { createChatMessengerBridge } from '../chat-messenger-bridge.js';
import { createMessengerAttachmentSource, MessengerAttachmentError } from '../chat-messenger-attachments.js';
import { createMessengerAccountResolver } from '../composition/bin/messenger-account-identity.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'attachment-test' };
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-attachments-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(':memory:'); ensureChatSchema(db);
  let locked = false;
  const key = () => locked ? null : new Uint8Array(32).fill(67);
  const store = createChatStore(db, key);
  const blobs = createEncryptedBlobStore(join(dir, 'cas'), key);
  const files = createInboundFileCollection({ db, blobs, slug: 'received', bus: createWarehouseEventBus(),
    gate: createStorageGate({ quota: 100_000_000, reservePct: 10, surface: 'collection:file:received' }),
  });
  const scratch = join(dir, 'scratch');
  const source = createMessengerAttachmentSource(files, scratch);
  const bridge = createChatMessengerBridge({ db, store, getKey: key, pollMs: 5, minSendIntervalMs: 0, retryDelayMs: 5 });
  cleanup.push(() => { bridge.close(); db.close(); });
  const bound = bridge.bind('slack', 'C123', 'slack:T1:B1');
  const sent: OutboundMessage[] = []; const uploaded: Array<{ file: OutboundAttachment; bytes: Buffer }> = [];
  let account = 'slack:T1:B1';
  const register = (send?: (file: OutboundAttachment) => Promise<TransportSendResult>) => bridge.register('slack', {
    resolve: async () => ({ token: 'fixture', recipient: 'C123', account }), attachments: source,
    send: async message => { sent.push(message); return { ok: true, vendor_message_id: `${sent.length}.000001` }; },
    sendAttachment: async file => {
      await file.beforeSend?.();
      expect(statSync(file.path).mode & 0o777).toBe(0o600);
      expect(statSync(join(file.path, '..')).mode & 0o777).toBe(0o700);
      uploaded.push({ file, bytes: readFileSync(file.path) });
      return send ? send(file) : { ok: true, vendor_file_id: `F${uploaded.length}` };
    },
  });
  const ingest = (name: string, bytes = Buffer.from(`private file ${name}`)) => files.ingest({ bytes, filename: name,
    mime_type: 'application/octet-stream', origin: 'webclient_upload', source_id: name,
  });
  const add = (id: string, ids: string[], content = 'Read these files') => store.appendMessage({ id, session_id: bound.session_id,
    role: 'assistant', content, attachments: ids.map(file_id => ({ file_id, media_class: 'document' as const })),
    target_server: 'self', picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'fixture', model_id: 'fixture' },
  });
  const state = async (id: string) => (await bridge.snapshot(bound.session_id)).deliveries.find(d => d.message_id === id)!;
  const wait = (id: string, expected: object) => vi.waitFor(async () => expect(await state(id)).toMatchObject(expected));
  return { db, key, store, blobs, files, source, scratch, bridge, bound, sent, uploaded, ingest, add, state, wait, register,
    lock: () => { locked = true; }, account: () => { account = 'slack:T2:B2'; },
  };
};

describe('D-265 retained attachment delivery', () => {
  it('does not revive a deleted message attachment when an old compiled plan finds an identical new upload', async () => {
    const f = fixture(); const file = await f.ingest('Legacy.pdf');
    const oldPlan = f.source.snapshot(file.record_id);
    await f.add('legacy-plan', [file.record_id]);
    const job = await f.state('legacy-plan');
    const payload = await encodeChatContentForStorage(JSON.stringify(oldPlan),
      { session_id: f.bound.session_id, message_id: `delivery:${job.delivery_id}:0` }, f.key);
    f.db.prepare("INSERT INTO chat_delivery_chunks (delivery_id,chunk_index,payload,kind,state) VALUES (?,0,?,'attachment','pending')")
      .run(job.delivery_id, payload);
    f.db.prepare('UPDATE chat_deliveries SET attachments_compiled=1 WHERE delivery_id=?').run(job.delivery_id);
    f.files.mutateLifecycle!({ record_id: file.record_id, action: 'delete',
      revision: f.files.attachmentLifecycle!.preview(file.record_id).revision });
    await f.ingest('Legacy.pdf');
    f.register();
    await f.wait('legacy-plan', { state: 'failed', error: 'attachment_unavailable' });
    expect(f.sent).toEqual([]); expect(f.uploaded).toEqual([]);
  });

  it('names the file blocking compilation without opening its bytes, then reports confirmed files separately from a lost receipt', async () => {
    const f = fixture(); const one = await f.ingest('First.pdf'); const two = await f.ingest('Second.pdf');
    f.files.setScanStatus(two.record_id, 'pending');
    f.register(async file => file.filename === 'Second.pdf' ? { ok: false, error: { kind: 'network', detail: 'lost receipt' } }
      : { ok: true, vendor_file_id: 'confirmed-first' });
    await f.add('details', [one.record_id, two.record_id]);
    await f.wait('details', { state: 'failed', error: 'attachment_blocked' });
    const read = async () => (await f.bridge.snapshot(f.bound.session_id, { session_id: f.bound.session_id, details: true })).deliveries[0]!;
    const blocked = await read();
    expect(blocked.details).toMatchObject({ plan: 'unprepared', text: null, attachments: [
      { filename: 'First.pdf', state: 'pending' }, { filename: 'Second.pdf', state: 'failed', error: 'attachment_blocked' },
    ] });
    expect(f.uploaded).toEqual([]); expect(f.sent).toEqual([]);
    f.files.setScanStatus(two.record_id, 'clean'); f.bridge.act(f.bound.session_id, blocked.delivery_id, 'retry-files', 'retry');
    await f.wait('details', { state: 'unknown', sent_chunks: 2 });
    expect((await read()).details).toMatchObject({ plan: 'prepared', text: { sent_parts: 1, total_parts: 1 }, attachments: [
      { filename: 'First.pdf', state: 'sent' }, { filename: 'Second.pdf', state: 'unknown', error: 'network' },
    ] });
    // Names in the immutable plan survive file metadata removal and reads do
    // not resend either the anchor or a file whose receipt is confirmed.
    vi.spyOn(f.source, 'describe').mockReturnValue(undefined);
    expect((await read()).details?.attachments[1]?.filename).toBe('Second.pdf');
    f.bridge.close();
    const restarted = createChatMessengerBridge({ db: f.db, store: f.store, getKey: f.key });
    cleanup.push(() => restarted.close());
    expect((await restarted.snapshot(f.bound.session_id, { session_id: f.bound.session_id, details: true })).deliveries[0]!.details)
      .toMatchObject({ attachments: [{ state: 'sent' }, { filename: 'Second.pdf', state: 'unknown' }] });
    expect(() => f.bridge.act(f.bound.session_id, blocked.delivery_id, 'unacknowledged', 'retry')).toThrow('Acknowledge');
    f.bridge.act(f.bound.session_id, blocked.delivery_id, 'skip-remainder', 'skip');
    expect((await read()).details).toMatchObject({ uncertain_parts: 1, attachments: [
      { state: 'sent' }, { state: 'unknown', skipped: true },
    ] });
    expect(f.sent).toHaveLength(1); expect(f.uploaded).toHaveLength(2);
  });

  it('identifies the failed file when verification fails after the plan was compiled', async () => {
    const f = fixture(); const file = await f.ingest('Changed.pdf');
    f.register();
    vi.spyOn(f.source, 'open').mockRejectedValue(new MessengerAttachmentError('attachment_changed'));
    const message = await f.add('changed-details', [file.record_id]);
    await f.wait('changed-details', { state: 'failed', sent_chunks: 1, error: 'attachment_changed' });
    const row = (await f.bridge.snapshot(f.bound.session_id, { session_id: f.bound.session_id, details: true })).deliveries[0]!;
    expect(row.details?.attachments).toEqual([{ file_id: message.attachments![0]!.file_id, filename: 'Changed.pdf', state: 'failed', error: 'attachment_changed' }]);
  });

  it('shares verified bot sender identity with the binding cache and refreshes it on token rotation', async () => {
    let calls = 0;
    const identity = createMessengerAccountResolver(async () => Response.json({ ok: true, team_id: 'T1', bot_id: `B${++calls}`, user_id: `U${calls}` }));
    expect(await identity('slack', 'token')).toBe('slack:T1:B1');
    expect(await identity.senderId('slack', 'token')).toBe('U1'); expect(calls).toBe(1);
    expect(await identity.senderId('slack', 'rotated')).toBe('U2');
    expect(await identity('slack', 'rotated')).toBe('slack:T1:B2'); expect(calls).toBe(2);
  });

  it('retries an incomplete bot-author identity instead of caching the intake failure forever', async () => {
    let calls = 0;
    const identity = createMessengerAccountResolver(async () => Response.json({ ok: true, team_id: 'T1', bot_id: 'B1',
      ...(++calls > 1 ? { user_id: 'UBOT' } : {}),
    }));
    expect(await identity.senderId('slack', 'token')).toBeUndefined();
    expect(await identity.senderId('slack', 'token')).toBe('UBOT'); expect(calls).toBe(2);
  });

  it('reclaims crashed-worker plaintext without removing another live worker or unrelated scratch', async () => {
    const f = fixture(); const file = await f.ingest('restart');
    const orphan = join(f.scratch, 'messenger-mirror-2147483647-1000-dead');
    const live = `messenger-mirror-${process.pid}-${Math.round(Date.now() - process.uptime() * 1000)}-live`;
    mkdirSync(orphan, { recursive: true }); writeFileSync(join(orphan, 'attachment'), 'private orphan');
    mkdirSync(join(f.scratch, live)); mkdirSync(join(f.scratch, 'unrelated'));
    const source = createMessengerAttachmentSource(f.files, f.scratch);
    const opened = await source.open(source.snapshot(file.record_id)); await opened.dispose();
    expect(readdirSync(f.scratch).sort()).toEqual([live, 'unrelated'].sort());
  });

  it('streams authentic original bytes, keeps metadata encrypted, and places every file after its text anchor', async () => {
    const f = fixture();
    const one = await f.ingest('Résumé 🐈.pdf', Buffer.from('%PDF-original\0bytes'));
    const two = await f.ingest('voice.ogg', Buffer.from('OggS-original-audio'));
    f.register(); await f.add('message', [one.record_id, two.record_id]);
    await f.wait('message', { state: 'sent', sent_chunks: 3, total_chunks: 3 });
    expect(f.sent).toHaveLength(1);
    expect(f.uploaded.map(p => p.bytes)).toEqual([Buffer.from('%PDF-original\0bytes'), Buffer.from('OggS-original-audio')]);
    expect(f.uploaded.map(p => p.file.filename)).toEqual(['Résumé 🐈.pdf', 'voice.ogg']);
    expect(f.uploaded.every(p => p.file.thread_id === '1.000001' && p.file.reply_to_message_id === '1.000001')).toBe(true);
    expect(readdirSync(f.scratch)).toEqual([]);
    const journal = JSON.stringify(f.db.prepare('SELECT payload FROM chat_delivery_chunks').all());
    expect(journal).not.toContain('Résumé'); expect(journal).not.toContain(one.record_id);
    const rows = f.db.prepare('SELECT kind, vendor_message_id, vendor_file_id FROM chat_delivery_chunks ORDER BY chunk_index').all();
    expect(rows).toEqual([{ kind: 'text', vendor_message_id: '1.000001', vendor_file_id: null },
      { kind: 'attachment', vendor_message_id: null, vendor_file_id: 'F1' }, { kind: 'attachment', vendor_message_id: null, vendor_file_id: 'F2' }]);
    expect(await f.bridge.nativeReply(f.bound.session_id, 'slack', '1.000001')).toMatchObject({ message_id: 'message' });
  });

  it('keeps lost file receipts unknown, blocks later posts, and retries only the unconfirmed file', async () => {
    const f = fixture(); const a = await f.ingest('a'); const b = await f.ingest('b'); let fail = true;
    f.register(async () => f.uploaded.length === 2 && fail ? { ok: false, error: { kind: 'network', detail: 'lost' } }
      : { ok: true, vendor_file_id: 'confirmed' });
    await f.add('one', [a.record_id, b.record_id]); await f.add('two', [], 'later answer');
    await f.wait('one', { state: 'unknown', sent_chunks: 2, total_chunks: 3 });
    expect((await f.state('two')).state).toBe('pending'); expect(readdirSync(f.scratch)).toEqual([]);
    const job = await f.state('one');
    expect(() => f.bridge.act(f.bound.session_id, job.delivery_id, 'retry', 'retry')).toThrow('Acknowledge');
    fail = false; f.bridge.act(f.bound.session_id, job.delivery_id, 'retry', 'retry', true); f.bridge.kick();
    await f.wait('two', { state: 'sent' });
    expect(f.uploaded.map(p => p.file.filename)).toEqual(['a', 'b', 'b']);
    expect(f.uploaded[1]!.file.delivery_id).toBe(f.uploaded[2]!.file.delivery_id);
    expect(f.sent.map(p => p.text)).toEqual(['Read these files', 'later answer']);
  });

  it.each(['missing', 'flagged', 'pending'] as const)('fails visibly for a %s file before posting text', async scenario => {
    const f = fixture(); const file = await f.ingest('blocked');
    if (scenario === 'missing') f.files.delete(file.record_id); else f.files.setScanStatus(file.record_id, scenario);
    f.register();
    if (scenario === 'missing') await expect(f.add('one', [file.record_id])).rejects.toThrow('unavailable');
    else { await f.add('one', [file.record_id]); await f.wait('one', { state: 'failed', error: 'attachment_blocked' }); }
    expect(f.sent).toEqual([]); expect(f.uploaded).toEqual([]);
  });

  it.each(['delete', 'corrupt', 'lock', 'account'] as const)('refuses %s between text and file without leaking bytes', async scenario => {
    const f = fixture(); const file = await f.ingest('sensitive');
    f.register();
    // Mutate the retained input or authority after the text receipt, exactly
    // when the next worker attempt begins materializing the file.
    const originalOpen = f.source.open;
    f.source.open = async plan => {
      if (scenario === 'delete') f.files.delete(file.record_id);
      if (scenario === 'corrupt') writeFileSync(resolveBlobObjectPath(f.blobs.root, plan.blob_hash), Buffer.alloc(60));
      if (scenario === 'lock') f.lock();
      if (scenario === 'account') f.account();
      return originalOpen(plan);
    };
    await f.add('one', [file.record_id]);
    await f.wait('one', { state: 'failed', sent_chunks: 1, total_chunks: 2 });
    expect(f.uploaded).toEqual([]);
    expect(f.sent).toHaveLength(1);
    if (scenario !== 'delete') expect(readdirSync(f.scratch)).toEqual([]);
  });

  it('delivers the original retained version when the library changes after the text receipt', async () => {
    const f = fixture(); const file = await f.ingest('sensitive', Buffer.from('original'));
    f.register(); const open = f.source.open;
    f.source.open = async plan => { await f.ingest('sensitive', Buffer.from('replacement')); return open(plan); };
    await f.add('immutable', [file.record_id]); await f.wait('immutable', { state: 'sent', sent_chunks: 2 });
    expect(f.uploaded.map(upload => upload.bytes.toString())).toEqual(['original']);
  });

  it('upgrades an already compiled legacy text plan without resending its receipt or backfilling completed history', async () => {
    const f = fixture(); const file = await f.ingest('legacy');
    await f.add('old-completed', [file.record_id]);
    f.db.prepare("UPDATE chat_deliveries SET state = 'sent' WHERE message_id = 'old-completed'").run();
    await f.add('pending', [file.record_id]);
    const job = await f.state('pending');
    const payload = await encodeChatContentForStorage('already posted', { session_id: f.bound.session_id, message_id: `delivery:${job.delivery_id}:0` }, f.key);
    f.db.prepare("INSERT INTO chat_delivery_chunks (delivery_id, chunk_index, payload, state, vendor_message_id) VALUES (?, 0, ?, 'sent', '123.000001')")
      .run(job.delivery_id, payload);
    f.register(); await f.wait('pending', { state: 'sent', total_chunks: 2 });
    expect(f.sent).toEqual([]); expect(f.uploaded).toHaveLength(1);
    expect(f.uploaded[0]!.file.thread_id).toBe('123.000001');
    expect((await f.state('old-completed')).total_chunks).toBe(0);
  });

  it('gives a file-only assistant message a reply anchor and fails if file delivery is unsupported', async () => {
    const f = fixture(); const file = await f.ingest('only-file');
    f.bridge.register('slack', { resolve: async () => ({ token: 'fixture', recipient: 'C123', account: 'slack:T1:B1' }),
      send: async () => { throw new Error('Must not drop the file'); },
    });
    await f.add('one', [file.record_id], '');
    await f.wait('one', { state: 'failed', error: 'attachment_unsupported' });
    f.register(); const job = await f.state('one'); f.bridge.act(f.bound.session_id, job.delivery_id, 'retry', 'retry'); f.bridge.kick();
    await f.wait('one', { state: 'sent', total_chunks: 2 });
    expect(f.sent[0]!.text).toBe('Assistant attached a file.');
  });
});
