/** D-213 Track A / A0 — row-level recall eligibility.
 *
 * The stamp is intentionally plaintext and indexed: later recall scans must
 * exclude a non-owner row before touching its encrypted content. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { deriveSubDEK } from '@recued/crypto';
import type { ExecutionSource } from '@recued/contracts';
import {
  CHAT_MESSAGE_RECALL_ELIGIBILITY,
  createChatStore,
  deriveChatMessageRecallEligibility,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';

const fixedMaster = (): Uint8Array => {
  const bytes = new Uint8Array(32);
  bytes.fill(213);
  return bytes;
};

const picker = {
  display_name: 'Self',
  signature: {
    server_kind: 'recued' as const,
    version: '1.0.0',
    instance_id: 'd213-a0',
  },
};

const model = { provider: 'test', model_id: 'test/model' };

const OWNER_CHAT: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'sess-1',
  user_id: 'local',
};

const RESTRICTED_CHAT: ExecutionSource = {
  ...OWNER_CHAT,
  contract_id: 'ct_restricted',
};

const MESSENGER: ExecutionSource = {
  channel: 'messenger',
  actor: 'user_self',
  vendor: 'slack',
  from: 'coworker',
};

describe('D-213 A0 — chat message recall-eligibility stamp', () => {
  let db: Database.Database;
  let store: ChatStore;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    const key = deriveSubDEK(fixedMaster(), 'chat');
    store = createChatStore(db, () => key);
    store.createSession({ id: 'sess-1', now: 1_000 });
  });

  afterEach(() => db.close());

  const append = async (
    id: string,
    execution_source?: ExecutionSource,
  ): Promise<void> => {
    await store.appendMessage({
      id,
      session_id: 'sess-1',
      role: 'user',
      content: `secret ${id}`,
      target_server: 'self',
      picker_at_send: picker,
      model_used: model,
      execution_source,
      ts: 1_000,
    });
  };

  it('lands one indexed plaintext column that supports newest-first corpus scans', () => {
    const columns = db
      .prepare('PRAGMA table_info(chat_messages)')
      .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    expect(columns.find((column) => column.name === 'recall_eligibility')).toMatchObject({
      notnull: 1,
      dflt_value: "'ineligible'",
    });

    const index = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get('idx_chat_messages_recall_eligibility') as { sql: string } | undefined;
    expect(index?.sql).toContain(
      'recall_eligibility, ts DESC, message_id DESC',
    );
  });

  it('upgrades a pre-D-213 chat table before creating the new index and leaves old rows ineligible', () => {
    db.prepare(`
      INSERT INTO chat_messages (
        message_id, session_id, role, ts, target_server,
        picker_at_send_blob, model_used_provider, model_used_model_id,
        content_encrypted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy',
      'sess-1',
      'user',
      999,
      'self',
      JSON.stringify(picker),
      model.provider,
      model.model_id,
      Buffer.from([0]),
    );
    // ⚠ BOTH indexes on the column, or the DROP COLUMN below fails. This is
    // the downgrade SIMULATION, not the migration under test — the real
    // `ensureChatSchema` adds the column before it creates either index, and
    // that ordering is what the assertions after this block check.
    db.exec(`
      DROP INDEX idx_chat_messages_recall_eligibility;
      DROP INDEX idx_chat_messages_recall_corpus;
      ALTER TABLE chat_messages DROP COLUMN recall_eligibility;
    `);

    expect(() => ensureChatSchema(db)).not.toThrow();
    const row = db
      .prepare(
        'SELECT recall_eligibility FROM chat_messages WHERE message_id = ?',
      )
      .get('legacy') as { recall_eligibility: string };
    expect(row.recall_eligibility).toBe(
      CHAT_MESSAGE_RECALL_ELIGIBILITY.INELIGIBLE,
    );
    expect(
      db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
      ).get('idx_chat_messages_recall_eligibility'),
    ).toBeDefined();
    // D-166 door corpus — the pair index has to come back on the same upgrade.
    // Without it the contract half of the recall predicate is a RESIDUAL and a
    // door corpus reads every owner row to find its own.
    expect(
      db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
      ).get('idx_chat_messages_recall_corpus'),
    ).toBeDefined();
  });

  it('stamps unrestricted direct chat as owner-authenticated', async () => {
    await append('owner-chat', OWNER_CHAT);
    const row = db
      .prepare(
        'SELECT recall_eligibility FROM chat_messages WHERE message_id = ?',
      )
      .get('owner-chat') as { recall_eligibility: string };
    expect(row.recall_eligibility).toBe(
      CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
    );
  });

  it('stamps messenger as not owner-authenticated', async () => {
    await append('messenger', MESSENGER);
    const row = db
      .prepare(
        'SELECT recall_eligibility FROM chat_messages WHERE message_id = ?',
      )
      .get('messenger') as { recall_eligibility: string };
    expect(row.recall_eligibility).toBe(
      CHAT_MESSAGE_RECALL_ELIGIBILITY.UNAUTHENTICATED_MESSENGER,
    );
  });

  it('fails closed for contracted chat, absent, and malformed sources', async () => {
    await append('restricted', RESTRICTED_CHAT);
    await append('absent');
    expect(
      deriveChatMessageRecallEligibility({
        channel: 'future-channel',
        actor: 'user_self',
      }),
    ).toBe(CHAT_MESSAGE_RECALL_ELIGIBILITY.INELIGIBLE);

    const rows = db
      .prepare(
        'SELECT message_id, recall_eligibility FROM chat_messages ORDER BY message_id',
      )
      .all() as Array<{ message_id: string; recall_eligibility: string }>;
    expect(rows).toEqual([
      {
        message_id: 'absent',
        recall_eligibility: CHAT_MESSAGE_RECALL_ELIGIBILITY.INELIGIBLE,
      },
      {
        message_id: 'restricted',
        recall_eligibility:
          CHAT_MESSAGE_RECALL_ELIGIBILITY.UNAUTHENTICATED_CHAT,
      },
    ]);
  });

  it('filters eligibility without a key or content decryption', async () => {
    await append('eligible', OWNER_CHAT);
    await append('excluded', MESSENGER);

    const rows = db
      .prepare(
        `SELECT message_id
           FROM chat_messages
          WHERE recall_eligibility = ?
          ORDER BY ts DESC, message_id DESC`,
      )
      .all(
        CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
      ) as Array<{ message_id: string }>;

    expect(rows).toEqual([{ message_id: 'eligible' }]);
  });
});
