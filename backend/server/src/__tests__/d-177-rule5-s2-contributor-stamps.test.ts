/** D-177 N.11 rule 5 — slice B (5.f + 5.d hot-path).
 *
 *  Part 1 — contributor stamps: the chat store SERVER-stamps a
 *  `contributor` facet ('user' / 'model' / 'tool_result') on every
 *  persisted chat message, derived from role at the one persistence
 *  point (never caller-supplied); pre-stamp rows (NULL column) derive
 *  from role at read time so the facet is always present on read.
 *
 *  Part 2 — the per-session forwarded-sender candidate index: the
 *  extractor admits ONLY the structured `From:` field of a
 *  marker-anchored forwarded-mail header cluster in user-authored text
 *  (5.e.i — never body addresses, signatures, or quoted reply chains),
 *  canonicalized with `parseAddress` rigor; the index is in-memory,
 *  per-session, oldest-evicting.
 *
 *  Spec: D-177 § N.11 rule 5 (5.d / 5.e / 5.f). */

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { deriveSubDEK } from '@recued/crypto';
import { contributorForChatRole } from '@recued/contracts';
import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';
import {
  createSessionForwardedSenderIndex,
  extractForwardedSenderEmails,
} from '../chat-forwarded-sender-index.js';

const fixedMaster = (seed: number): Uint8Array => {
  const buf = new Uint8Array(32);
  buf.fill(seed);
  return buf;
};

const samplePicker = () => ({
  display_name: 'Self',
  signature: {
    server_kind: 'recued' as const,
    version: '1.0.0',
    instance_id: 'instance-test',
  },
});
const sampleModel = () => ({ provider: 'local', model_id: 'ollama/llama-3' });

const appendInput = (
  store: ChatStore,
  role: 'user' | 'assistant' | 'tool' | 'system',
  id: string,
) =>
  store.appendMessage({
    id,
    session_id: 'sess-1',
    role,
    content: `${role} content`,
    target_server: 'self',
    picker_at_send: samplePicker(),
    model_used: sampleModel(),
    ts: 1_000,
  });

describe('D-177 rule-5 slice B — contributor stamps (5.f)', () => {
  let db: Database.Database;
  let store: ChatStore;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    const key = deriveSubDEK(fixedMaster(1), 'chat');
    store = createChatStore(db, () => key);
    store.createSession({ id: 'sess-1', now: 1_000 });
  });

  it('derives the closed role→contributor mapping', () => {
    expect(contributorForChatRole('user')).toBe('user');
    expect(contributorForChatRole('assistant')).toBe('model');
    expect(contributorForChatRole('tool')).toBe('tool_result');
    // system rows are server-/externally-injected — must NOT read as user
    expect(contributorForChatRole('system')).toBe('tool_result');
  });

  it('stamps contributor on insert and round-trips it through listMessages', async () => {
    const userRow = await appendInput(store, 'user', 'm-user');
    const assistantRow = await appendInput(store, 'assistant', 'm-asst');
    const toolRow = await appendInput(store, 'tool', 'm-tool');
    expect(userRow.contributor).toBe('user');
    expect(assistantRow.contributor).toBe('model');
    expect(toolRow.contributor).toBe('tool_result');

    const listed = await store.listMessages('sess-1');
    // same ts — the store orders by (ts, message_id); compare as a set
    expect(
      listed.map((m) => [m.id, m.contributor]).sort(),
    ).toEqual([
      ['m-asst', 'model'],
      ['m-tool', 'tool_result'],
      ['m-user', 'user'],
    ]);
    // and the stamp is durably in the column, not just derived on read
    const raw = db
      .prepare(
        'SELECT message_id, contributor FROM chat_messages ORDER BY ts, message_id',
      )
      .all() as Array<{ message_id: string; contributor: string }>;
    expect(raw.find((r) => r.message_id === 'm-user')?.contributor).toBe('user');
  });

  it('derives from role at read time for pre-stamp (NULL) and off-vocabulary rows', async () => {
    await appendInput(store, 'user', 'm-legacy');
    db.prepare(
      "UPDATE chat_messages SET contributor = NULL WHERE message_id = 'm-legacy'",
    ).run();
    await appendInput(store, 'assistant', 'm-bogus');
    db.prepare(
      "UPDATE chat_messages SET contributor = 'attacker' WHERE message_id = 'm-bogus'",
    ).run();
    const listed = await store.listMessages('sess-1');
    expect(listed.find((m) => m.id === 'm-legacy')?.contributor).toBe('user');
    // off-vocabulary value is never trusted as-is — derives from role
    expect(listed.find((m) => m.id === 'm-bogus')?.contributor).toBe('model');
  });

  it('adds the contributor column to a pre-slice chat_messages table (guarded ALTER)', () => {
    const oldDb = new Database(':memory:');
    ensureChatSchema(oldDb);
    oldDb.exec('ALTER TABLE chat_messages DROP COLUMN contributor');
    // re-running the schema pass re-adds it (idempotent boot path)
    ensureChatSchema(oldDb);
    const cols = (
      oldDb.prepare('PRAGMA table_info(chat_messages)').all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain('contributor');
  });
});

describe('D-177 rule-5 slice B — forwarded-sender extraction (5.d / 5.e)', () => {
  const GMAIL_FORWARD = [
    'fyi, please handle',
    '',
    '---------- Forwarded message ---------',
    'From: Ann Vendor <Ann.Vendor@Example.COM>',
    'Date: Mon, 1 Jun 2026 at 09:00',
    'Subject: Invoice 42',
    'To: me@my.com',
    '',
    'Hi, invoice attached. Contact billing@evil.example if questions.',
  ].join('\n');

  it('extracts the canonical structured sender of a Gmail-style forward', () => {
    expect(extractForwardedSenderEmails(GMAIL_FORWARD)).toEqual([
      'ann.vendor@example.com',
    ]);
  });

  it('supports Apple Mail and Outlook markers', () => {
    const apple = [
      'Begin forwarded message:',
      'From: bob@x.com (Bob)',
      'Subject: hi',
      'Date: now',
    ].join('\n');
    const outlook = [
      '-----Original Message-----',
      'From: "Last, First" <c.d@y.org>',
      'Sent: Tuesday',
      'To: someone@y.org',
    ].join('\n');
    expect(extractForwardedSenderEmails(apple)).toEqual(['bob@x.com']);
    expect(extractForwardedSenderEmails(outlook)).toEqual(['c.d@y.org']);
  });

  it('never admits body / signature / footer addresses (5.e.i)', () => {
    const senders = extractForwardedSenderEmails(GMAIL_FORWARD);
    expect(senders).not.toContain('billing@evil.example');
    expect(senders).not.toContain('me@my.com'); // To: is not the sender
  });

  it('never reads a From: inside a quoted reply chain', () => {
    const text = [
      '---------- Forwarded message ---------',
      '> From: attacker@evil.com',
      '> Date: yesterday',
      '> Subject: nested',
      'From: real@sender.com',
      'Date: today',
      'Subject: outer',
    ].join('\n');
    expect(extractForwardedSenderEmails(text)).toEqual(['real@sender.com']);
  });

  it('a lone prose From: line without a header cluster is a no-parse', () => {
    expect(
      extractForwardedSenderEmails('From: maybe@someone.com\nhello there'),
    ).toEqual([]);
    // marker but no companion headers — still a no-parse
    expect(
      extractForwardedSenderEmails(
        '---------- Forwarded message ---------\nFrom: x@y.com\nlorem ipsum',
      ),
    ).toEqual([]);
  });

  it('plain chat text with addresses yields nothing (fail-closed)', () => {
    expect(
      extractForwardedSenderEmails('please email peter@corp.com about this'),
    ).toEqual([]);
  });

  it('extracts one sender per forwarded block across multiple forwards', () => {
    const two = `${GMAIL_FORWARD}\n\n${GMAIL_FORWARD.replace(
      'Ann.Vendor@Example.COM',
      'second@other.com',
    )}`;
    expect(extractForwardedSenderEmails(two).sort()).toEqual([
      'ann.vendor@example.com',
      'second@other.com',
    ]);
  });
});

describe('D-177 rule-5 slice B — per-session index (5.d hot-path)', () => {
  const FWD = (addr: string) =>
    [
      '---------- Forwarded message ---------',
      `From: ${addr}`,
      'Date: Mon',
      'Subject: x',
    ].join('\n');

  it('records user turns per session with contribution time, isolated by session', () => {
    const index = createSessionForwardedSenderIndex();
    index.recordUserTurn('s1', FWD('a@x.com'), 100);
    index.recordUserTurn('s1', 'no forward here', 150);
    index.recordUserTurn('s2', FWD('b@y.com'), 200);
    expect(index.candidates('s1')).toEqual([
      { email: 'a@x.com', contributed_at: 100 },
    ]);
    expect(index.candidates('s2')).toEqual([
      { email: 'b@y.com', contributed_at: 200 },
    ]);
    expect(index.candidates('unknown')).toEqual([]);
  });

  it('evicts a session on demand', () => {
    const index = createSessionForwardedSenderIndex();
    index.recordUserTurn('s1', FWD('a@x.com'), 100);
    index.evictSession('s1');
    expect(index.candidates('s1')).toEqual([]);
  });

  it('caps per-session candidates by dropping the oldest', () => {
    const index = createSessionForwardedSenderIndex();
    for (let i = 0; i < 300; i++) {
      index.recordUserTurn('s1', FWD(`u${i}@x.com`), i);
    }
    const list = index.candidates('s1');
    expect(list.length).toBe(256);
    expect(list[0]).toEqual({ email: 'u44@x.com', contributed_at: 44 });
    expect(list[list.length - 1]).toEqual({
      email: 'u299@x.com',
      contributed_at: 299,
    });
  });
});
