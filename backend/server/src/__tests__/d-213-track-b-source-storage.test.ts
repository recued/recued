import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { deriveSubDEK } from '@recued/crypto';
import type { ExecutionSource } from '@recued/contracts';

import {
  CHAT_MESSAGE_RECALL_ELIGIBILITY,
  createChatStore,
  decodeChatContentFromStorage,
  encodeChatContentForStorage,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';

const OWNER: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'current',
  user_id: 'local',
};
const picker = {
  display_name: 'Self',
  signature: {
    server_kind: 'recued' as const,
    version: '1',
    instance_id: 'd213-b',
  },
};
const model = { provider: 'test', model_id: 'test/model' };

describe('D-213 Track B — split encrypted source storage', () => {
  let db: Database.Database;
  let store: ChatStore;
  let key: Uint8Array;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    const master = new Uint8Array(32);
    master.fill(213);
    key = deriveSubDEK(master, 'chat');
    store = createChatStore(db, () => key);
    store.createSession({ id: 'current', now: 1 });
  });

  afterEach(() => db.close());

  const appendOwnerUser = async (id = 'u1'): Promise<void> => {
    await store.appendMessage({
      id,
      session_id: 'current',
      role: 'user',
      content: 'Email Alice at Alice@Acme.com',
      target_server: 'self',
      picker_at_send: picker,
      model_used: model,
      execution_source: OWNER,
      ts: 10,
      tool_calls: [{
        tool_name: 'mail.send',
        tier: 2,
        status: 'ok',
        args: { to: 'Alice@Acme.com' },
        detail: 'private Alice detail',
        started_at: 1,
      }],
    });
  };

  it('installs only row-local candidate storage, lifecycle, and revision columns', () => {
    const messageColumns = db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{
      name: string;
    }>;
    const sessionColumns = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{
      name: string;
    }>;
    expect(messageColumns.map((row) => row.name)).toEqual(
      expect.arrayContaining(['candidates_encrypted', 'source_lifecycle']),
    );
    expect(sessionColumns.map((row) => row.name)).toContain('content_revision');

    const candidateAggregates = db.prepare(`
      SELECT name, type, sql
        FROM sqlite_master
       WHERE sql LIKE '%candidates_encrypted%'
         AND NOT (type = 'table' AND name = 'chat_messages')
    `).all();
    expect(candidateAggregates).toEqual([]);
  });

  it('writes only prompt_parts_v1, finalizes candidates atomically, and preserves exact casing', async () => {
    await appendOwnerUser();
    const pending = db.prepare(`
      SELECT content_encrypted, candidates_encrypted, source_lifecycle
        FROM chat_messages WHERE message_id = 'u1'
    `).get() as {
      content_encrypted: string;
      candidates_encrypted: string | null;
      source_lifecycle: string;
    };
    expect(pending.source_lifecycle).toBe('pending');
    expect(pending.candidates_encrypted).toBeNull();
    const storedContent = await decodeChatContentFromStorage(
      pending.content_encrypted,
      { session_id: 'current', message_id: 'u1' },
      () => key,
    );
    expect(JSON.parse(storedContent)).toMatchObject({
      format: 'prompt_parts_v1',
      primary: {
        role: 'content',
        content_kind: 'user_message',
        text: 'Email Alice at Alice@Acme.com',
        speaker: 'user',
      },
    });

    await expect(store.finalizeMessageSource?.({
      session_id: 'current',
      message_id: 'u1',
      candidates: [
        { value: 'Alice@Acme.com', kind: 'email' },
        { value: 'Alice Ada', kind: 'name' },
      ],
    })).resolves.toBe(true);
    const finalized = db.prepare(`
      SELECT source_lifecycle, candidates_encrypted
        FROM chat_messages WHERE message_id = 'u1'
    `).get() as { source_lifecycle: string; candidates_encrypted: string };
    expect(finalized.source_lifecycle).toBe('finalized');
    expect(finalized.candidates_encrypted).not.toContain('Alice');
    expect(
      (db.prepare(`
        SELECT content_revision FROM chat_sessions WHERE session_id = 'current'
      `).get() as { content_revision: number }).content_revision,
    ).toBe(1);

    const harvest = await store.harvestPiiSources!({
      session_id: 'current',
      max_rows: 256,
      max_bytes: 1_048_576,
      max_candidates: 1_024,
    });
    expect(harvest).toMatchObject({
      partial: false,
      content_revision: 1,
      rows: [{
        message_id: 'u1',
        content: 'Email Alice at Alice@Acme.com',
        source_lifecycle: 'finalized',
        candidates: [
          { value: 'Alice@Acme.com', kind: 'email' },
          { value: 'Alice Ada', kind: 'name' },
        ],
      }],
    });
  });

  it('advances a private keyset frontier across repeated bounded harvests', async () => {
    for (const [index, value] of ['First Person', 'Second Person', 'Third Person'].entries()) {
      const id = `u${index + 1}`;
      await appendOwnerUser(id);
      await expect(store.finalizeMessageSource?.({
        session_id: 'current',
        message_id: id,
        candidates: [{ value, kind: 'name' }],
      })).resolves.toBe(true);
    }

    const first = await store.harvestPiiSources!({
      session_id: 'current',
      max_rows: 1,
      max_bytes: 1_048_576,
      max_candidates: 1_024,
    });
    expect(first).toMatchObject({
      partial: true,
      rows: [{ message_id: 'u1' }],
      next_cursor: { ts: 10, message_id: 'u1' },
    });

    const second = await store.harvestPiiSources!({
      session_id: 'current',
      after: first.next_cursor,
      max_rows: 1,
      max_bytes: 1_048_576,
      max_candidates: 1_024,
    });
    expect(second).toMatchObject({
      partial: true,
      rows: [{ message_id: 'u2' }],
      next_cursor: { ts: 10, message_id: 'u2' },
    });

    const third = await store.harvestPiiSources!({
      session_id: 'current',
      after: second.next_cursor,
      max_rows: 1,
      max_bytes: 1_048_576,
      max_candidates: 1_024,
    });
    expect(third).toMatchObject({
      partial: false,
      rows: [{ message_id: 'u3' }],
    });
    expect(third.next_cursor).toBeUndefined();
  });

  it('encrypts tool args/detail while reconstructing the unchanged public shape', async () => {
    await appendOwnerUser();
    const row = db.prepare(`
      SELECT tool_calls_blob FROM chat_messages WHERE message_id = 'u1'
    `).get() as { tool_calls_blob: string };
    expect(row.tool_calls_blob).not.toContain('Alice@Acme.com');
    expect(row.tool_calls_blob).not.toContain('private Alice detail');
    const [message] = await store.listMessages('current');
    expect(message?.tool_calls?.[0]).toMatchObject({
      args: { to: 'Alice@Acme.com' },
      detail: 'private Alice detail',
    });
  });

  it('keeps a failed source searchable but excludes typed candidates', async () => {
    await appendOwnerUser();
    expect(store.failMessageSource?.('current', 'u1')).toBe(true);
    const [message] = await store.listMessages('current');
    expect(message?.content).toBe('Email Alice at Alice@Acme.com');
    const recall = await store.getRecallMessage!({
      row_eligibility:
        CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
      recall_contract_id: null,
      tool_session_id: null,
      item_id: 'u1',
    });
    expect(recall).toMatchObject({
      readable: true,
      content: 'Email Alice at Alice@Acme.com',
    });
    const harvest = await store.harvestPiiSources!({
      session_id: 'current',
      max_rows: 256,
      max_bytes: 1_048_576,
      max_candidates: 1_024,
    });
    expect(harvest.rows[0]).toMatchObject({
      source_lifecycle: 'failed',
      candidates: [],
    });
  });

  it('reconciles an orphan pending row to failed on store startup', async () => {
    await appendOwnerUser();
    const restarted = createChatStore(db, () => key);
    const row = db.prepare(`
      SELECT source_lifecycle FROM chat_messages WHERE message_id = 'u1'
    `).get() as { source_lifecycle: string };
    expect(row.source_lifecycle).toBe('failed');
    expect(
      (await restarted.listMessages('current'))[0]?.content,
    ).toBe('Email Alice at Alice@Acme.com');
  });

  it('relinquishes a failed finalization claim so first harvest can reconcile it', async () => {
    await appendOwnerUser();
    await expect(store.finalizeMessageSource?.({
      session_id: 'wrong-session',
      message_id: 'u1',
      candidates: [],
    })).resolves.toBe(false);
    const harvest = await store.harvestPiiSources!({
      session_id: 'current',
      max_rows: 256,
      max_bytes: 1_048_576,
      max_candidates: 1_024,
    });
    expect(harvest.rows[0]).toMatchObject({
      message_id: 'u1',
      source_lifecycle: 'failed',
      candidates: [],
    });
  });

  it('rejects a pending source lifecycle on an assistant row', async () => {
    await expect(store.appendMessage({
      id: 'invalid-pending',
      session_id: 'current',
      role: 'assistant',
      content: 'not an owner source draft',
      target_server: 'self',
      picker_at_send: picker,
      model_used: model,
      execution_source: OWNER,
      source_lifecycle: 'pending',
    })).rejects.toThrow(
      'pending source requires an owner-authenticated user or tool-result row',
    );
  });

  it('never persists candidates on a recall-ineligible row', async () => {
    const messenger: ExecutionSource = {
      channel: 'messenger',
      actor: 'user_self',
      vendor: 'slack',
      from: 'bound-conversation',
    };
    await expect(store.appendMessage({
      id: 'ineligible-with-candidate',
      session_id: 'current',
      role: 'assistant',
      content: 'external-surface answer',
      target_server: 'self',
      picker_at_send: picker,
      model_used: model,
      execution_source: messenger,
      retained_alias_candidates: [{ value: 'Alice Ada', kind: 'name' }],
    })).rejects.toThrow(
      'recall-ineligible source cannot carry candidates',
    );

    await store.appendMessage({
      id: 'ineligible-empty',
      session_id: 'current',
      role: 'assistant',
      content: 'external-surface answer',
      target_server: 'self',
      picker_at_send: picker,
      model_used: model,
      execution_source: messenger,
    });
    const row = db.prepare(`
      SELECT candidates_encrypted
        FROM chat_messages
       WHERE message_id = 'ineligible-empty'
    `).get() as { candidates_encrypted: string | null };
    expect(row.candidates_encrypted).toBeNull();
  });

  it('accepts no legacy bare-string content shape', async () => {
    await appendOwnerUser();
    const legacy = await encodeChatContentForStorage(
      'legacy bare string',
      { session_id: 'current', message_id: 'u1' },
      () => key,
    );
    db.prepare(`
      UPDATE chat_messages SET content_encrypted = ? WHERE message_id = 'u1'
    `).run(legacy);
    expect((await store.listMessages('current'))[0]?.content).toBe('');
    const recall = await store.getRecallMessage!({
      row_eligibility:
        CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
      recall_contract_id: null,
      tool_session_id: null,
      item_id: 'u1',
    });
    expect(recall).toMatchObject({ readable: false });
  });

  it('rejects prompt_parts_v1 envelopes carrying an extra payload member', async () => {
    await appendOwnerUser();
    const widened = await encodeChatContentForStorage(
      JSON.stringify({
        format: 'prompt_parts_v1',
        primary: {
          source: 'framework',
          role: 'content',
          content_kind: 'user_message',
          text: 'visible',
          speaker: 'user',
        },
        hidden_payload: { credential: 'must-not-be-readable' },
      }),
      { session_id: 'current', message_id: 'u1' },
      () => key,
    );
    db.prepare(`
      UPDATE chat_messages SET content_encrypted = ? WHERE message_id = 'u1'
    `).run(widened);
    expect((await store.listMessages('current'))[0]?.content).toBe('');
    await expect(store.getRecallMessage!({
      row_eligibility:
        CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
      recall_contract_id: null,
      tool_session_id: null,
      item_id: 'u1',
    })).resolves.toMatchObject({ readable: false });
  });

  it('fails closed when a plaintext row role disagrees with its encrypted source envelope', async () => {
    await appendOwnerUser();
    await store.finalizeMessageSource?.({
      session_id: 'current',
      message_id: 'u1',
      candidates: [{ value: 'Alice Ada', kind: 'name' }],
    });
    db.prepare(`
      UPDATE chat_messages SET role = 'assistant' WHERE message_id = 'u1'
    `).run();

    expect((await store.listMessages('current'))[0]).toMatchObject({
      role: 'assistant',
      content: '',
    });
    await expect(store.getRecallMessage!({
      row_eligibility:
        CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
      recall_contract_id: null,
      tool_session_id: null,
      item_id: 'u1',
    })).resolves.toMatchObject({ readable: false });
    await expect(store.harvestPiiSources!({
      session_id: 'current',
      max_rows: 256,
      max_bytes: 1_048_576,
      max_candidates: 1_024,
    })).resolves.toMatchObject({
      partial: true,
      rows: [],
    });
  });

  it('rejects retained candidate entries with any member beyond value and kind', async () => {
    await appendOwnerUser();
    await expect(store.finalizeMessageSource?.({
      session_id: 'current',
      message_id: 'u1',
      candidates: [{
        value: 'Alice Ada',
        kind: 'name',
        path: 'private.path',
      } as never],
    })).rejects.toThrow('invalid retained alias candidate');
    expect(
      (db.prepare(`
        SELECT source_lifecycle
          FROM chat_messages
         WHERE message_id = 'u1'
      `).get() as { source_lifecycle: string }).source_lifecycle,
    ).toBe('pending');
  });

  it('rejects free-form content as a retained alias candidate', async () => {
    await appendOwnerUser();
    await expect(store.finalizeMessageSource?.({
      session_id: 'current',
      message_id: 'u1',
      candidates: [{
        value: 'entire free-form tool output',
        kind: 'content',
      } as never],
    })).rejects.toThrow('invalid retained alias candidate');
  });

  it('rejects finalized candidates on a failed source instead of silently dropping them', async () => {
    await expect(store.appendMessage({
      id: 'failed-with-candidate',
      session_id: 'current',
      role: 'user',
      content: 'Alice Ada',
      target_server: 'self',
      picker_at_send: picker,
      model_used: model,
      execution_source: OWNER,
      source_lifecycle: 'failed',
      retained_alias_candidates: [{ value: 'Alice Ada', kind: 'name' }],
    })).rejects.toThrow(
      'non-finalized source cannot carry finalized candidates',
    );
  });

  it('deletes content and candidate ciphertext with the owning session cascade', async () => {
    await appendOwnerUser();
    await store.finalizeMessageSource?.({
      session_id: 'current',
      message_id: 'u1',
      candidates: [{ value: 'Alice Ada', kind: 'name' }],
    });
    expect(store.deleteSession('current')).toBe(true);
    expect(
      (db.prepare(`
        SELECT COUNT(*) AS count FROM chat_messages
      `).get() as { count: number }).count,
    ).toBe(0);
  });

  it('search decrypts content without touching a corrupt candidate ciphertext', async () => {
    await appendOwnerUser();
    await store.finalizeMessageSource?.({
      session_id: 'current',
      message_id: 'u1',
      candidates: [{ value: 'Alice Ada', kind: 'name' }],
    });
    db.prepare(`
      UPDATE chat_messages
         SET candidates_encrypted = 'tampered'
       WHERE message_id = 'u1'
    `).run();
    const recall = await store.getRecallMessage!({
      row_eligibility:
        CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
      recall_contract_id: null,
      tool_session_id: null,
      item_id: 'u1',
    });
    expect(recall).toMatchObject({
      readable: true,
      content: 'Email Alice at Alice@Acme.com',
    });
    const harvest = await store.harvestPiiSources!({
      session_id: 'current',
      max_rows: 256,
      max_bytes: 1_048_576,
      max_candidates: 1_024,
    });
    expect(harvest.partial).toBe(true);
    expect(harvest.rows).toEqual([]);
  });

  it('refuses an oversized encrypted source before decrypting it', async () => {
    await store.appendMessage({
      id: 'oversized',
      session_id: 'current',
      role: 'assistant',
      content: 'x'.repeat(1_048_577),
      target_server: 'self',
      picker_at_send: picker,
      model_used: model,
      execution_source: OWNER,
      ts: 20,
    });
    const harvest = await store.harvestPiiSources!({
      session_id: 'current',
      max_rows: Number.MAX_SAFE_INTEGER,
      max_bytes: Number.MAX_SAFE_INTEGER,
      max_candidates: Number.MAX_SAFE_INTEGER,
    });
    expect(harvest).toMatchObject({
      partial: true,
      decrypted_rows: 0,
      decrypted_bytes: 0,
      rows: [],
    });
  });

  it('skips a split-column row that is jointly impossible and still reaches later rows', async () => {
    await store.appendMessage({
      id: 'jointly-oversized',
      session_id: 'current',
      role: 'assistant',
      content: 'x'.repeat(600_000),
      target_server: 'self',
      picker_at_send: picker,
      model_used: model,
      execution_source: OWNER,
      ts: 20,
      retained_alias_candidates: [{
        value: 'y'.repeat(600_000),
        kind: 'name',
      }],
    });
    await store.appendMessage({
      id: 'later-readable',
      session_id: 'current',
      role: 'assistant',
      content: 'later source',
      target_server: 'self',
      picker_at_send: picker,
      model_used: model,
      execution_source: OWNER,
      ts: 21,
    });

    const result = await store.harvestPiiSources!({
      session_id: 'current',
      max_rows: 256,
      max_bytes: 1_048_576,
      max_candidates: 1_024,
    });
    expect(result.partial).toBe(true);
    expect(result.rows).toEqual([
      expect.objectContaining({
        message_id: 'later-readable',
        content: 'later source',
      }),
    ]);
    expect(result.next_cursor).toBeUndefined();
  });
});
