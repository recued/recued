/** Real SQLite, encrypted chat storage and queue admission. No model or external mailbox. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmailCloseDay, type EmailClosingReply } from '../email-close-day.js';
import { createNoticeConversationOpener } from '../chat-notices.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatTurnQueueStore } from '../storage/chat-turn-queue-store.js';
import { createVaultStateBus } from '../vault-state-bus.js';

const KEY = new Uint8Array(32).fill(53);
const NOW = Date.parse('2026-11-14T20:00:00Z');
const REPLY: EmailClosingReply = { title: 'Your day · Fri 13 Nov', text: 'Did the call with Ana, skipped Spanish.',
  quoted: 'Your day · Fri 13 Nov\n10:00 Call with Ana\n18:00 Spanish', rfc_message_id: '<owner-reply@example.test>',
  source: { slug: 'alerts', record_id: 'alerts:1' } };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const fixture = (options: { path?: string; afterOpen?: () => Promise<void>; readReply?: () => Promise<Pick<EmailClosingReply, 'title' | 'text' | 'quoted'> | null>;
  beforeService?: (db: Database.Database) => void } = {}) => {
  const db = new Database(options.path ?? ':memory:'); ensureChatSchema(db);
  const state = { locked: false, enabled: true, failAdmission: false, lockAtAdmission: false, acceptedButReplyLost: false };
  const getKey = () => state.locked ? null : KEY;
  const store = createChatStore(db, getKey);
  const journal = createChatTurnQueueStore(db, getKey);
  const open = createNoticeConversationOpener({ chatStore: store,
    signature: { server_kind: 'recued', version: '1', instance_id: 'email-recovery' } });
  options.beforeService?.(db);
  const bus = createVaultStateBus();
  const service = createEmailCloseDay({ db, getKey, canRun: () => state.enabled,
    subscribeVault: listener => bus.subscribe(listener), now: () => NOW,
    readReply: options.readReply ?? (async () => REPLY),
    openNoticeConversation: () => async (notice, identity) => {
      const opened = await open(notice, identity); await options.afterOpen?.(); return opened;
    },
    queue: () => ({ routing: () => undefined, submit: async (command, submission, repeat, beforeInsert) => {
      if (state.lockAtAdmission) { state.locked = true; state.lockAtAdmission = false; }
      const ack = await journal.admit(command, submission, repeat, turn => {
        beforeInsert?.(turn);
        if (state.failAdmission) throw new Error('injected admission transaction rollback');
      });
      if (state.acceptedButReplyLost) throw new Error('injected lost admission response');
      return ack;
    } }),
  });
  cleanups.push(async () => { await service.stop(); if (db.open) db.close(); });
  const count = (table: 'chat_sessions' | 'chat_messages' | 'chat_turn_queue') =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { db, state, store, journal, bus, service, count };
};

describe('a closing email belongs to its durable handoff until Chat accepts it', () => {
  it.each(['received', 'session', 'notice', 'accepted'] as const)('recovers a process stopped after %s, without a second conversation or turn', async boundary => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-email-handoff-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'chat.db');
    const moduleUrl = (file: string) => new URL(`../${file}.ts`, import.meta.url).href;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import Database from 'better-sqlite3';
      import { createEmailCloseDay } from ${JSON.stringify(moduleUrl('email-close-day'))};
      import { createNoticeConversationOpener } from ${JSON.stringify(moduleUrl('chat-notices'))};
      import { createChatStore, ensureChatSchema } from ${JSON.stringify(moduleUrl('storage/chat-store'))};
      import { createChatTurnQueueStore } from ${JSON.stringify(moduleUrl('storage/chat-turn-queue-store'))};
      const db = new Database(process.argv[1]); ensureChatSchema(db);
      const boundary = process.argv[2], getKey = () => new Uint8Array(32).fill(53);
      const store = createChatStore(db, getKey), journal = createChatTurnQueueStore(db, getKey);
      const open = createNoticeConversationOpener({ chatStore: { ...store, appendMessage: async input => {
        if (boundary === 'session') process.exit(0);
        return store.appendMessage(input);
      } }, signature: { server_kind: 'recued', version: '1', instance_id: 'email-recovery' } });
      const service = createEmailCloseDay({ db, getKey, readReply: async () => null,
        canRun: () => { if (boundary === 'received') process.exit(0); return true; },
        openNoticeConversation: () => open,
        queue: () => ({ routing: () => undefined, submit: async (...args) => {
          if (boundary === 'notice') process.exit(0);
          const ack = await journal.admit(...args);
          if (boundary === 'accepted') process.exit(0);
          return ack;
        } }) });
      await service(${JSON.stringify(REPLY)});
      process.exit(2);
    `, path, boundary], { cwd: fileURLToPath(new URL('../../../../', import.meta.url)), encoding: 'utf8', timeout: 15_000 });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    const f = fixture({ path });
    const pending = f.db.prepare('SELECT payload,mail_record_id FROM email_close_day_replies').get() as { payload: string | null; mail_record_id: string | null };
    if (boundary !== 'received' && boundary !== 'accepted') {
      expect(pending.payload).not.toContain(REPLY.text);
      expect(pending.payload).not.toBeNull();
    }
    await f.service.recover(true);
    await f.service.recover(true);
    expect(await f.service(REPLY)).toBe('seen');
    expect(f.count('chat_sessions')).toBe(1);
    expect(f.count('chat_messages')).toBe(1);
    expect(f.count('chat_turn_queue')).toBe(1);
    expect(f.service.pending()).toEqual([]);
    const row = f.db.prepare('SELECT * FROM chat_turn_queue').get() as Parameters<typeof f.journal.read>[0];
    const command = await f.journal.read(row);
    expect(command).toMatchObject({ family: 'chat', message: REPLY.text,
      input: { picker_state: { current: 'self' }, reply_to_message_id: expect.stringMatching(/^notice:/u) } });
    expect(f.db.prepare('SELECT state,payload,mail_record_id FROM email_close_day_replies').get())
      .toEqual({ state: 'accepted', payload: null, mail_record_id: null });
  });

  it('retries a real vault-lock refusal at the unlock edge, keeping the one notice and conversation', async () => {
    const f = fixture(); f.service.start(); f.state.lockAtAdmission = true;
    expect(await f.service(REPLY)).toBe('pending');
    expect(f.count('chat_turn_queue')).toBe(0);
    expect(f.service.pending()).toEqual([expect.objectContaining({ reason: 'retry', retry_available: true, session_id: expect.any(String) })]);
    f.state.locked = false; f.bus.emit('unlocked', 'locked');
    await vi.waitFor(() => expect(f.count('chat_turn_queue')).toBe(1));
    expect(f.count('chat_sessions')).toBe(1); expect(f.count('chat_messages')).toBe(1);
    expect(f.service.pending()).toEqual([]);
    await f.service.stop(); f.bus.emit('unlocked', 'locked');
    expect(f.count('chat_turn_queue')).toBe(1);
  });

  it('rolls the handoff back with a rejected admission transaction and accepts it on manual retry', async () => {
    const f = fixture(); f.state.failAdmission = true;
    expect(await f.service(REPLY)).toBe('pending');
    expect(f.count('chat_turn_queue')).toBe(0);
    const [pending] = f.service.pending();
    expect(pending?.reason).toBe('retry');
    f.state.failAdmission = false;
    await Promise.all([f.service.retry(pending!.id), f.service.recover(true), f.service(REPLY)]);
    expect(f.count('chat_turn_queue')).toBe(1);
    expect(f.count('chat_messages')).toBe(1);
    expect(f.service.pending()).toEqual([]);
  });

  it('keeps a committed admission after a lost reply and never sends it to the queue again', async () => {
    const f = fixture(); f.state.acceptedButReplyLost = true;
    expect(await f.service(REPLY)).toBe('opened');
    await f.service.recover(true);
    expect(await f.service(REPLY)).toBe('seen');
    expect(f.count('chat_turn_queue')).toBe(1);
    expect(f.service.pending()).toEqual([]);
  });

  it('recovers a saved mailbox reference without another first-seen mail event and shows an unreadable source', async () => {
    let available = false;
    const f = fixture({ readReply: async () => available ? REPLY : null });
    f.state.locked = true;
    expect(await f.service(REPLY)).toBe('pending');
    expect(f.db.prepare('SELECT payload FROM email_close_day_replies').get()).toEqual({ payload: null });
    f.state.locked = false;
    await f.service.recover(true);
    const [pending] = f.service.pending(); expect(pending?.reason).toBe('source_unavailable');
    available = true; await f.service.retry(pending!.id);
    expect(f.count('chat_turn_queue')).toBe(1); expect(f.service.pending()).toEqual([]);
  });

  it('does not substitute a changed mailbox record for the reply that was proven the owner\'s', async () => {
    const f = fixture({ readReply: async () => ({ ...REPLY, text: 'A different request' }) });
    f.state.locked = true; await f.service(REPLY); f.state.locked = false;
    await f.service.recover(true);
    expect(f.service.pending()[0]?.reason).toBe('source_unavailable');
    expect(f.count('chat_turn_queue')).toBe(0); expect(f.count('chat_sessions')).toBe(0);
  });

  it('does not recreate a conversation the owner deletes while its handoff is opening', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ afterOpen: () => blocked });
    const receive = f.service(REPLY);
    await vi.waitFor(() => expect(f.count('chat_messages')).toBe(1));
    const session = f.service.pending()[0]!.session_id!;
    f.store.deleteSession(session); release(); await receive;
    await f.service.recover(true);
    expect(await f.service(REPLY)).toBe('seen');
    expect(f.count('chat_sessions')).toBe(0); expect(f.count('chat_turn_queue')).toBe(0);
    expect(f.service.pending()).toEqual([]);
  });

  it('stops an in-flight source read before it can open Chat, leaving ownership for the next worker', async () => {
    let release!: () => void;
    const read = vi.fn(() => new Promise<typeof REPLY>(resolve => { release = () => resolve(REPLY); }));
    const f = fixture({ readReply: read });
    f.state.enabled = false; await f.service(REPLY); f.state.enabled = true;
    const recovering = f.service.recover(true);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const stopped = f.service.stop(); release(); await Promise.all([recovering, stopped]);
    expect(f.count('chat_sessions')).toBe(0); expect(f.count('chat_turn_queue')).toBe(0);
    expect(f.service.pending()).toHaveLength(1);
  });

  it('exposes an old unconfirmed claim without replaying an email whose original execution is unknown', async () => {
    const f = fixture({ beforeService: db => db.exec(`CREATE TABLE email_close_day_replies
      (rfc_message_id TEXT PRIMARY KEY,session_id TEXT,created_at INTEGER NOT NULL);
      INSERT INTO email_close_day_replies VALUES('<owner-reply@example.test>',NULL,1);`) });
    await f.service.recover(true);
    expect(await f.service(REPLY)).toBe('seen');
    expect(f.service.pending()).toEqual([expect.objectContaining({ reason: 'unknown', retry_available: false })]);
    expect(() => f.service.retry(f.service.pending()[0]!.id)).toThrow('original handoff could not be confirmed');
    f.service.markReviewed(f.service.pending()[0]!.id);
    expect(f.service.pending()).toEqual([]);
    expect(await f.service(REPLY)).toBe('seen');
    expect(f.count('chat_sessions')).toBe(0); expect(f.count('chat_turn_queue')).toBe(0);
  });
});
