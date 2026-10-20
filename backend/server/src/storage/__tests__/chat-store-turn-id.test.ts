/** `turn_id` on a chat message — the durable half of the message↔turn link.
 *
 *  The client otherwise rebuilds that link from live `chat.message_complete`
 *  events, which only works if it was connected when the turn ended: a tab
 *  whose socket dropped mid-turn came back to a history that could not say
 *  which turn wrote what, and a composer it could not prove was free.
 *
 *  ⛔ The column is nullable with NO backfill, and these tests pin that as a
 *  DECISION rather than an omission. Nothing in an existing row can
 *  reconstruct the turn that wrote it, and a fabricated value would make an
 *  unknowable indistinguishable from a fact.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../chat-store.js';

const samplePicker = () => ({
  display_name: 'Self',
  signature: {
    server_kind: 'recued' as const,
    version: '1.0.0',
    instance_id: 'instance-turn-id-test',
  },
});

const sampleModel = () => ({ provider: 'local', model_id: 'ollama/llama-3' });

const harness = (): { db: Database.Database; store: ChatStore } => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  return { db, store: createChatStore(db) };
};

describe('chat-store — turn_id on messages', () => {
  it('round-trips the stamping turn through storage', async () => {
    const { store } = harness();
    store.createSession({ id: 'sess-1', now: 1000 });
    const written = await store.appendMessage({
      id: 'msg-q',
      session_id: 'sess-1',
      role: 'user',
      content: 'the question',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      turn_id: 'turn-1',
      ts: 1100,
    });
    // The append RESULT is handed onward without a re-read, so it has to carry
    // the field too — not only the row.
    expect(written.turn_id).toBe('turn-1');

    await store.appendMessage({
      id: 'msg-a',
      session_id: 'sess-1',
      role: 'assistant',
      content: 'the answer',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      turn_id: 'turn-1',
      ts: 1200,
    });

    const messages = await store.listMessages('sess-1');
    expect(messages.map((m) => [m.id, m.turn_id])).toEqual([
      ['msg-q', 'turn-1'],
      ['msg-a', 'turn-1'],
    ]);
  });

  it('omits the field entirely for a row written outside a turn', async () => {
    const { store } = harness();
    store.createSession({ id: 'sess-2', now: 1000 });
    await store.appendMessage({
      id: 'msg-1',
      session_id: 'sess-2',
      role: 'assistant',
      content: 'no turn stamped this',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1100,
    });
    const [message] = await store.listMessages('sess-2');
    // ABSENT, not null or '': a reader distinguishes "unknown" from a value,
    // and `'turn_id' in message` is how it does that.
    expect(message).not.toHaveProperty('turn_id');
  });

  it('adds the column to a chat database created before it existed', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const before = createChatStore(db);
    before.createSession({ id: 'sess-3', now: 1000 });
    await before.appendMessage({
      id: 'msg-old',
      session_id: 'sess-3',
      role: 'assistant',
      content: 'written before stamping existed',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1100,
    });

    // Now make the database genuinely pre-column, the state an upgrading
    // server actually finds on disk. ⚠ Order matters: the store prepares its
    // INSERT once, at construction, so the legacy row has to be written by a
    // store built against the schema it was written under.
    db.exec('ALTER TABLE chat_messages DROP COLUMN turn_id');
    expect(
      (db.prepare('PRAGMA table_info(chat_messages)').all() as { name: string }[])
        .some((c) => c.name === 'turn_id'),
    ).toBe(false);

    // Boot the upgraded binary: the guarded ALTER is the whole migration.
    ensureChatSchema(db);
    expect(
      (db.prepare('PRAGMA table_info(chat_messages)').all() as { name: string }[])
        .some((c) => c.name === 'turn_id'),
    ).toBe(true);

    const store = createChatStore(db);
    const [old] = await store.listMessages('sess-3');
    // ⛔ NOT backfilled, and it must not be: nothing in this row can say which
    // turn wrote it, so it stays unknown rather than becoming a guess.
    expect(old).not.toHaveProperty('turn_id');

    await store.appendMessage({
      id: 'msg-new',
      session_id: 'sess-3',
      role: 'assistant',
      content: 'written after',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      turn_id: 'turn-9',
      ts: 1200,
    });
    const after = await store.listMessages('sess-3');
    expect(after.map((m) => m.turn_id)).toEqual([undefined, 'turn-9']);
  });

  it('lists a turn\'s rows in the order it wrote them, and moves no other row\'s time', async () => {
    const { store } = harness();
    store.createSession({ id: 'sess-4', now: 1000 });
    const append = async (id: string, ts: number, turn_id?: string) => (await store.appendMessage({
      id, session_id: 'sess-4', role: 'assistant', content: id, target_server: 'self',
      picker_at_send: samplePicker(), model_used: sampleModel(), ts,
      ...(turn_id !== undefined ? { turn_id } : {}),
    })).ts;
    expect(await append('a', 2000, 'turn-1')).toBe(2000);
    // Same millisecond, same turn: 1 ms after the turn's newest row.
    expect(await append('b', 2000, 'turn-1')).toBe(2001);
    // Given an earlier time than its turn already holds: still listed after it.
    expect(await append('c', 1500, 'turn-1')).toBe(2002);
    // Another turn, and a row outside any turn, keep the time they were given.
    expect(await append('d', 2000, 'turn-2')).toBe(2000);
    expect(await append('e', 1200)).toBe(1200);
    // No tie: the given time stands.
    expect(await append('f', 3000, 'turn-1')).toBe(3000);
    const listed = await store.listMessages('sess-4');
    expect(listed.map((m) => [m.id, m.ts])).toEqual([
      ['e', 1200], ['a', 2000], ['d', 2000], ['b', 2001], ['c', 2002], ['f', 3000],
    ]);
  });
});
