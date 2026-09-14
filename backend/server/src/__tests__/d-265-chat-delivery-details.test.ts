import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatMessengerBridge } from '../chat-messenger-bridge.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { handleChatDelivery } from '../chat-handler.js';
import { createChatTurnQueueStore } from '../storage/chat-turn-queue-store.js';
import type { ChatDeliveryListRequest } from '@recued/contracts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'delivery-details' };
const fixture = (path = ':memory:') => {
  const db = new Database(path); ensureChatSchema(db);
  let locked = false;
  let keyByte = 51;
  const getKey = () => locked ? null : new Uint8Array(32).fill(keyByte);
  const store = createChatStore(db, getKey);
  const bridge = createChatMessengerBridge({ db, store, getKey, pollMs: 10, minSendIntervalMs: 0 });
  cleanups.push(() => { bridge.close(); if (db.open) db.close(); });
  const { session_id } = bridge.bind('slack', 'C1', 'slack:T1:B1');
  const add = (id: string, extra: { role?: 'user' | 'assistant'; turn_id?: string; attachments?: Array<{ file_id: string; media_class: string }> } = {}) =>
    store.appendMessage({ id, session_id, role: 'assistant', content: `Private message ${id}`, target_server: 'self',
      picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'fixture', model_id: 'fixture' }, ...extra });
  const read = (options: Omit<ChatDeliveryListRequest, 'session_id'> = {}) => bridge.snapshot(session_id, { session_id, details: true, ...options });
  const raw = createChatOrchestrator({ chatStore: store, selfSignature: signature,
    registry: { list: () => [], listByTier: () => [], getByName: () => null, dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} } });
  const deps = { store, orchestrator: { ...raw, messengerBridge: bridge }, selfSignature: signature };
  return { db, store, bridge, session_id, add, read, deps, lock: () => { locked = true; }, rotate: () => { keyByte++; } };
};

describe('message-level Messenger delivery reads', () => {
  it('publishes a preparation failure and its revision atomically to another SQLite connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-read-revision-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'chat.sqlite'); const f = fixture(path); const observer = new Database(path);
    cleanups.push(() => observer.close());
    const states: string[] = [];
    f.db.function('observe_delivery_revision', () => {
      const row = observer.prepare("SELECT state FROM chat_deliveries WHERE message_id = 'observed'").get() as { state: string } | undefined;
      if (row) states.push(row.state);
      return 1;
    });
    f.db.exec(`CREATE TRIGGER observe_revision BEFORE UPDATE ON chat_delivery_revisions
      BEGIN SELECT observe_delivery_revision(); END;`);
    f.bridge.register('slack', { resolve: async () => null, send: async () => { throw new Error('Must not send'); } });
    await f.add('observed');
    await vi.waitFor(async () => expect((await f.read()).deliveries[0]).toMatchObject({ state: 'failed', error: 'binding_changed' }));
    expect(states).toContain('sending'); expect(states).not.toContain('failed');
    expect(observer.prepare("SELECT state FROM chat_deliveries WHERE message_id = 'observed'").get()).toEqual({ state: 'failed' });
  });

  it('pages the whole journal without duplicates while new messages arrive, and looks up messages outside the overview', async () => {
    const f = fixture();
    for (let i = 0; i < 230; i++) await f.add(`m${i}`);
    f.db.exec("UPDATE chat_deliveries SET state = CASE WHEN sequence = 1 THEN 'skipped' WHEN sequence = 2 THEN 'failed' ELSE 'sent' END");
    const first = await f.read({ view: 'history', limit: 23 });
    expect(first.deliveries.map(d => d.message_id)).toEqual(Array.from({ length: 23 }, (_, i) => `m${229 - i}`));
    expect(first).toMatchObject({ pending_count: 1, skipped_count: 1, details_available: true });
    await f.add('new-arrival');
    const ids = first.deliveries.map(d => d.message_id);
    let cursor = first.next_cursor;
    while (cursor) {
      const page = await f.read({ view: 'history', limit: 23, cursor });
      ids.push(...page.deliveries.map(d => d.message_id)); cursor = page.next_cursor;
    }
    expect(ids).toHaveLength(230); expect(new Set(ids).size).toBe(230); expect(ids).not.toContain('new-arrival');
    expect((await f.read({ view: 'history', limit: 1 })).deliveries[0]!.message_id).toBe('new-arrival');
    expect((await f.read()).deliveries.some(d => d.message_id === 'm0')).toBe(false);
    const old = await f.read({ view: 'messages', message_ids: ['m0', 'm1', 'missing'] });
    expect(old.deliveries.map(d => [d.message_id, d.state])).toEqual([['m0', 'skipped'], ['m1', 'failed']]);
    expect(old.deliveries[0]!.details?.message).toMatchObject({ role: 'assistant', snippet: 'Private message m0' });
  });

  it('rejects malformed and cross-conversation cursors and bounds requests at the RPC boundary', async () => {
    const f = fixture(); await f.add('one'); await f.add('two');
    const page = await f.read({ view: 'history', limit: 1 });
    const other = f.bridge.bind('slack', 'C2', 'slack:T1:B1');
    await expect(handleChatDelivery(f.deps, 'list', { session_id: other.session_id, view: 'history', cursor: page.next_cursor })).rejects.toThrow('cursor');
    expect((await f.bridge.snapshot(other.session_id, { session_id: other.session_id, view: 'messages', details: true, message_ids: ['one'] })).deliveries).toEqual([]);
    for (const request of [
      { view: 'history', cursor: 'bad' }, { view: 'history', limit: 101 }, { view: 'history', limit: 0 },
      { view: 'history', limit: 1.5 }, { cursor: 'cursor' }, { view: 'surprise' }, { details: 'true' },
      { view: 'messages', message_ids: Array(201).fill('one') }, { view: 'messages', message_ids: [3] }, { view: 'messages' },
    ]) await expect(handleChatDelivery(f.deps, 'list', { session_id: f.session_id, ...request })).rejects.toThrow();
    expect(await handleChatDelivery(f.deps, 'list', { session_id: f.session_id })).not.toHaveProperty('details_available');
  });

  it('keeps native files distinct from completed historical text deliveries without touching the transport', async () => {
    const f = fixture();
    const queue = createChatTurnQueueStore(f.db);
    const command = { family: 'messenger' as const, session_id: f.session_id, message: 'Native file', input: {},
      native_receipt: { vendor: 'slack', account: 'slack:T1:B1', recipient: 'C1', message_id: 'native-ts', thread_id: 'root' } };
    const accepted = await queue.admit(command, 'native');
    await f.add('native', { role: 'user', turn_id: accepted.turn_id, attachments: [{ file_id: 'file', media_class: 'document' }] });
    await f.add('historical', { attachments: [{ file_id: 'file', media_class: 'document' }] });
    f.db.prepare("UPDATE chat_deliveries SET state = 'sent' WHERE message_id = 'historical'").run();
    const rows = (await f.read()).deliveries;
    expect(rows[0]).toMatchObject({ state: 'sent', details: { plan: 'native', attachments: [{ state: 'sent' }] } });
    expect(rows[1]).toMatchObject({ state: 'sent', details: { plan: 'legacy', attachments: [{ state: 'not_mirrored' }] } });
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM chat_delivery_chunks').get()).toEqual({ count: 0 });
  });

  it('does not return decrypted details across a vault lock or a deleted/recreated session', async () => {
    const f = fixture(); await f.add('one');
    const original = f.store.listMessagePage;
    vi.spyOn(f.store, 'listMessagePage').mockImplementation(async (...args) => {
      const page = await original(...args); f.lock(); return page;
    });
    await expect(f.read()).rejects.toThrow('Unlock');
    const rotated = fixture(); await rotated.add('before-key-change');
    const originalRotated = rotated.store.listMessagePage;
    vi.spyOn(rotated.store, 'listMessagePage').mockImplementation(async (...args) => {
      const page = await originalRotated(...args); rotated.rotate(); return page;
    });
    await expect(rotated.read()).rejects.toThrow('vault changed');
    const g = fixture(); await g.add('private');
    const originalG = g.store.listMessagePage;
    vi.spyOn(g.store, 'listMessagePage').mockImplementation(async (...args) => {
      const page = await originalG(...args);
      g.store.deleteSession(g.session_id); g.bridge.bind('slack', 'C1', 'slack:T1:B1'); return page;
    });
    await expect(g.read()).rejects.toThrow('Conversation changed');
  });
});
