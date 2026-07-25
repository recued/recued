/** D-137 P1 — AI Chat substrate schema.
 *
 *  Acceptance per spec § Contract Tightening + § Must Hold (D-137-
 *  equivalent of D-149 § Must Hold I-15):
 *    - `ensureChatSchema(db)` lands `chat_sessions` + `chat_messages`.
 *    - The schema matches the closed `CHAT_TABLES` inventory.
 *    - Schema is idempotent — calling twice does not error.
 *    - `archived` defaults to 0 (session active) at the SQL layer.
 *    - `picker_state_target` defaults to `'self'` (Mary's internal
 *      channel) at the SQL layer per § A.7.
 *    - `model_routing_layer` defaults to `'byok'` (D-191: "local" is a
 *      display property, not a routing layer).
 *    - `ON DELETE CASCADE` on the message foreign key (deleting a
 *      session removes its messages — preserves storage discipline).
 *    - Canonical indexes from the substrate spec land alongside the
 *      tables.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CHAT_TABLES } from '@recued/contracts';
import { ensureChatSchema } from '../storage/chat-store.js';

const listTables = (db: Database.Database): Set<string> => {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
};

const listIndexes = (db: Database.Database): Set<string> => {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%'`,
    )
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
};

const listColumns = (db: Database.Database, table: string): Set<string> => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
};

describe('D-137 P1 — ensureChatSchema lands chat_sessions + chat_messages', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('lands every table named in CHAT_TABLES', () => {
    ensureChatSchema(db);
    const tables = listTables(db);
    for (const name of CHAT_TABLES) {
      expect(tables.has(name)).toBe(true);
    }
  });

  it('lands the canonical indexes per substrate', () => {
    ensureChatSchema(db);
    const indexes = listIndexes(db);
    const required = [
      'idx_chat_sessions_last_active',
      'idx_chat_sessions_archived',
      'idx_chat_messages_session_ts',
      'idx_chat_messages_role',
      'idx_chat_messages_target_server',
    ];
    for (const name of required) {
      expect(indexes.has(name)).toBe(true);
    }
  });

  it('lands chat_messages.attachments_blob for session file turn refs', () => {
    ensureChatSchema(db);
    expect(listColumns(db, 'chat_messages').has('attachments_blob')).toBe(true);
  });

  it('is idempotent — second call is a no-op', () => {
    ensureChatSchema(db);
    const before = listTables(db).size;
    expect(() => ensureChatSchema(db)).not.toThrow();
    const after = listTables(db).size;
    expect(after).toBe(before);
  });
});

describe('D-137 P1 — chat_sessions default columns (§ A.7 + § A.14)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
  });

  it('archived defaults to 0 (session active)', () => {
    db.prepare(
      `INSERT INTO chat_sessions (session_id, created_at, last_active_at)
        VALUES (?, ?, ?)`,
    ).run('sess-1', 1000, 2000);
    const row = db
      .prepare(`SELECT archived FROM chat_sessions WHERE session_id = ?`)
      .get('sess-1') as { archived: number };
    expect(row.archived).toBe(0);
  });

  it('picker_state_target defaults to "self" (§ A.7 internal channel)', () => {
    db.prepare(
      `INSERT INTO chat_sessions (session_id, created_at, last_active_at)
        VALUES (?, ?, ?)`,
    ).run('sess-2', 1000, 2000);
    const row = db
      .prepare(`SELECT picker_state_target FROM chat_sessions WHERE session_id = ?`)
      .get('sess-2') as { picker_state_target: string };
    expect(row.picker_state_target).toBe('self');
  });

  it('model_routing_layer defaults to "byok" (D-191: "local" is not a routing layer)', () => {
    db.prepare(
      `INSERT INTO chat_sessions (session_id, created_at, last_active_at)
        VALUES (?, ?, ?)`,
    ).run('sess-3', 1000, 2000);
    const row = db
      .prepare(`SELECT model_routing_layer FROM chat_sessions WHERE session_id = ?`)
      .get('sess-3') as { model_routing_layer: string };
    expect(row.model_routing_layer).toBe('byok');
  });
});

describe('D-137 P1 — chat_messages ON DELETE CASCADE (storage discipline)', () => {
  it('ensureChatSchema leaves the connection with PRAGMA foreign_keys = ON', () => {
    const db = new Database(':memory:');
    db.exec(`PRAGMA foreign_keys = OFF`);
    expect(
      (db.prepare(`PRAGMA foreign_keys`).get() as { foreign_keys: number })
        .foreign_keys,
    ).toBe(0);
    ensureChatSchema(db);
    // Substrate guarantees FK enforcement regardless of caller-side
    // state — the prior `PRAGMA foreign_keys = OFF` is flipped back ON
    // so the `chat_messages` ON DELETE CASCADE fires reliably.
    expect(
      (db.prepare(`PRAGMA foreign_keys`).get() as { foreign_keys: number })
        .foreign_keys,
    ).toBe(1);
  });

  it('deleting a session removes its messages (callers do not need to set PRAGMA)', () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    // No `PRAGMA foreign_keys = ON` set here — ensureChatSchema handles
    // it on the caller's behalf so the CASCADE fires for any caller of
    // the substrate, not just those who happen to set the pragma.
    db.prepare(
      `INSERT INTO chat_sessions (session_id, created_at, last_active_at)
        VALUES (?, ?, ?)`,
    ).run('sess-1', 1000, 2000);
    db.prepare(
      `INSERT INTO chat_messages
         (message_id, session_id, role, ts, target_server, picker_at_send_blob,
          model_used_provider, model_used_model_id, content_encrypted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'msg-1',
      'sess-1',
      'user',
      1500,
      'self',
      '{}',
      'local',
      'ollama/llama-3',
      Buffer.from('placeholder'),
    );

    db.prepare(`DELETE FROM chat_sessions WHERE session_id = ?`).run('sess-1');

    const messages = db
      .prepare(`SELECT message_id FROM chat_messages WHERE session_id = ?`)
      .all('sess-1');
    expect(messages.length).toBe(0);
  });
});
