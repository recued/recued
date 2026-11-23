/** The per-turn reading's records (`chat_assignment_scopes`), retired 2026-11-18: the owner, "the brief only
 *  summarises", and nothing reads a request before a turn. A server that kept them drops them when the chat
 *  schema is ensured; the rest of the conversation stays. */
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

it('drops the retired reading records on an existing server, and keeps the conversation', async () => {
  const db = new Database(':memory:');
  try {
    ensureChatSchema(db);
    const store = createChatStore(db, () => new Uint8Array(32).fill(7));
    store.createSession({ id: 's', now: 1 });
    // As a server before 9eeac1277 kept it: one encrypted record per owner turn.
    db.exec(`CREATE TABLE chat_assignment_scopes (session_id TEXT NOT NULL, turn_id TEXT NOT NULL, scope_encrypted TEXT NOT NULL,
      PRIMARY KEY(session_id, turn_id), FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE)`);
    db.prepare('INSERT INTO chat_assignment_scopes VALUES (?,?,?)').run('s', 't1', 'ciphertext');
    ensureChatSchema(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_assignment_scopes'").get()).toBeUndefined();
    expect(createChatStore(db, () => new Uint8Array(32).fill(7)).getSession('s')).toBeDefined();
    // Ensured again, nothing to drop: idempotent.
    expect(() => ensureChatSchema(db)).not.toThrow();
  } finally { db.close(); }
});
