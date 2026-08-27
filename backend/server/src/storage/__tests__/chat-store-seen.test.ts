/** Per-session "seen" state.
 *
 *  The unread mark used to be a tab-lifetime Set in the webclient: you could be
 *  told an answer had arrived, reload, and be told nothing. The route persists
 *  nothing to browser storage by house rule, so the mark lives here — which
 *  also makes it survive a closed tab and read the same on every client.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { createChatStore, ensureChatSchema, type ChatStore } from '../chat-store.js';

const picker = () => ({
  display_name: 'Self',
  signature: { server_kind: 'recued' as const, version: '1.0.0', instance_id: 'i' },
});

const say = async (store: ChatStore, session_id: string, id: string) => {
  await store.appendMessage({
    id, session_id, role: 'assistant', content: id,
    target_server: 'self', picker_at_send: picker(),
    model_used: { provider: 'local', model_id: 'm' }, ts: 1000,
  });
};

const harness = (): { db: Database.Database; store: ChatStore } => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  return { db, store: createChatStore(db) };
};

const summary = (store: ChatStore, id: string) =>
  store.listSessions().find((s) => s.id === id)!;

describe('session seen state', () => {
  it('starts a new session seen, so it is markable from its first message', async () => {
    const { store } = harness();
    store.createSession({ id: 's', now: 1000 });
    expect(summary(store, 's').last_seen_message_count).toBe(0);
    expect(summary(store, 's').message_count).toBe(0);

    await say(store, 's', 'm1');
    const after = summary(store, 's');
    // Unread: one message has landed since it was last looked at.
    expect(after.message_count).toBe(1);
    expect(after.last_seen_message_count).toBe(0);
  });

  it('catches the mark up to the current count', async () => {
    const { store } = harness();
    store.createSession({ id: 's', now: 1000 });
    await say(store, 's', 'm1');
    await say(store, 's', 'm2');
    store.markSessionSeen('s');
    const seen = summary(store, 's');
    expect(seen.last_seen_message_count).toBe(seen.message_count);
  });

  /** ⛔ A COUNT, NOT A TIMESTAMP. `last_active_at` is bumped by six different
   *  writes — the picker and model-pref updates among them — so a timestamp key
   *  would mark a chat unread for changing its model. */
  it('does not move when the model pref changes', async () => {
    const { store } = harness();
    store.createSession({ id: 's', now: 1000 });
    await say(store, 's', 'm1');
    store.markSessionSeen('s');
    const before = summary(store, 's');

    store.setModelPref('s', { current: 'byok' }, 9_999);
    const after = summary(store, 's');
    expect(after.last_active_at).not.toBe(before.last_active_at);
    // …and yet nothing became unread.
    expect(after.message_count).toBe(after.last_seen_message_count);
  });

  /** ⛔ NULL MEANS SEEN, AND IS NOT BACKFILLED. A session written before the
   *  column exists carries nothing; reading that as "zero seen" would light up
   *  every old chat at once on the first boot after an upgrade. */
  it('leaves a pre-column session with no seen count rather than inventing one', async () => {
    const { db, store } = harness();
    store.createSession({ id: 's', now: 1000 });
    await say(store, 's', 'm1');
    // Stand in for a row written before the column existed.
    db.exec('UPDATE chat_sessions SET last_seen_message_count = NULL');
    const row = summary(store, 's');
    expect(row).not.toHaveProperty('last_seen_message_count');
    expect(row.message_count).toBe(1);
  });

  it('is a no-op for a session that does not exist', () => {
    const { store } = harness();
    expect(() => store.markSessionSeen('nope')).not.toThrow();
  });
});
