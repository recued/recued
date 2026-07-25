/** D-137 P1.2 — ChatStore CRUD + chat sub-DEK round-trip.
 *
 *  Acceptance per spec § Contract Tightening + § A.14:
 *    - `createChatStore` round-trips chat_sessions + chat_messages
 *    - Sub-DEK encryption is opaque (plaintext never appears in
 *      `content_encrypted`)
 *    - AAD binding — a blob enrolled under (sess-A, msg-1) does not
 *      decrypt under (sess-B, msg-1) — moving rows is fatal to decode
 *    - Per-session picker / model_pref toggles persist + round-trip
 *    - `deleteSession` cascades messages (already gated by FK +
 *      ensureChatSchema's PRAGMA)
 */

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { deriveSubDEK, randomBytes } from '@recued/crypto';
import type { LLMConfig } from '@recued/llm';
import {
  createChatStore,
  decodeChatContentFromStorage,
  ensureChatSchema,
  encodeChatContentForStorage,
  type ChatStore,
} from '../storage/chat-store.js';

// D-174 R28 Slice A — the global default is a source_id; the inherited § A.14
// hint comes from the resolved slot's `speed`. slot_2 = quality so a
// `slot_2` default resolves to model_hint 'quality'.
const HINT_FIXTURE_CONFIG: LLMConfig = {
  slot_1: { provider: 'openai-compatible', model: 'm', api_key: 'k', speed: 'fast', supports_json: true },
  slot_2: { provider: 'openai-compatible', model: 'm', api_key: 'k', speed: 'quality', supports_json: true },
  free_pool: [
    { id: 'fp', type: 'api', provider: 'openai-compatible', model: 'm', api_key: 'k', speed: 'fast', supports_json: true, enabled: true },
  ],
};

const fixedMaster = (seed: number): Uint8Array => {
  const buf = new Uint8Array(32);
  buf.fill(seed);
  return buf;
};

const chatKey = (master: Uint8Array): Uint8Array => deriveSubDEK(master, 'chat');

let db: Database.Database;
let store: ChatStore;
let key: Uint8Array;
let getKey: () => Uint8Array;

const samplePicker = () => ({
  display_name: 'Self',
  signature: {
    server_kind: 'recued' as const,
    version: '1.0.0',
    instance_id: 'instance-test',
  },
});

const sampleModel = () => ({ provider: 'local', model_id: 'ollama/llama-3' });

beforeEach(() => {
  db = new Database(':memory:');
  ensureChatSchema(db);
  key = chatKey(fixedMaster(1));
  getKey = () => key;
  store = createChatStore(db, getKey, () => HINT_FIXTURE_CONFIG);
});

describe('D-137 P1.2 — chat sub-DEK AEAD round-trip', () => {
  it('encodeChatContentForStorage / decodeChatContentFromStorage round-trip', async () => {
    const blob = await encodeChatContentForStorage(
      'hello peter',
      { session_id: 'sess-1', message_id: 'msg-1' },
      getKey,
    );
    const recovered = await decodeChatContentFromStorage(
      blob,
      { session_id: 'sess-1', message_id: 'msg-1' },
      getKey,
    );
    expect(recovered).toBe('hello peter');
  });

  it('ciphertext does NOT contain the plaintext token', async () => {
    const blob = await encodeChatContentForStorage(
      'SECRET-PETER-FROM-ACME-DO-NOT-LEAK',
      { session_id: 'sess-1', message_id: 'msg-1' },
      getKey,
    );
    expect(blob).not.toContain('SECRET-PETER-FROM-ACME-DO-NOT-LEAK');
    const decoded = Buffer.from(blob, 'base64').toString('binary');
    expect(decoded).not.toContain('SECRET-PETER-FROM-ACME-DO-NOT-LEAK');
  });

  it('AAD binding — blob enrolled under (sess-A, msg-1) does not decode under (sess-B, msg-1)', async () => {
    const blob = await encodeChatContentForStorage(
      'hello',
      { session_id: 'sess-A', message_id: 'msg-1' },
      getKey,
    );
    await expect(
      decodeChatContentFromStorage(
        blob,
        { session_id: 'sess-B', message_id: 'msg-1' },
        getKey,
      ),
    ).rejects.toThrow(/aead/);
  });

  it('AAD binding — blob enrolled under msg-1 does not decode under msg-2', async () => {
    const blob = await encodeChatContentForStorage(
      'hello',
      { session_id: 'sess-A', message_id: 'msg-1' },
      getKey,
    );
    await expect(
      decodeChatContentFromStorage(
        blob,
        { session_id: 'sess-A', message_id: 'msg-2' },
        getKey,
      ),
    ).rejects.toThrow(/aead/);
  });

  it('falls back to plaintext base64 when no key provider is wired', async () => {
    const blob = await encodeChatContentForStorage(
      'hello',
      { session_id: 'sess-1', message_id: 'msg-1' },
      undefined,
    );
    const recovered = await decodeChatContentFromStorage(
      blob,
      { session_id: 'sess-1', message_id: 'msg-1' },
      undefined,
    );
    expect(recovered).toBe('hello');
  });

  it('locked key provider (returns null) throws ChatVaultLockedError', async () => {
    const { ChatVaultLockedError } = await import('../storage/chat-store.js');
    await expect(
      encodeChatContentForStorage(
        'hello',
        { session_id: 'sess-1', message_id: 'msg-1' },
        () => null,
      ),
    ).rejects.toBeInstanceOf(ChatVaultLockedError);
  });

  it('Codex P1 fold — locked decode throws ChatVaultLockedError (not silent empty)', async () => {
    const { ChatVaultLockedError } = await import('../storage/chat-store.js');
    const blob = await encodeChatContentForStorage(
      'hello',
      { session_id: 'sess-1', message_id: 'msg-1' },
      getKey,
    );
    await expect(
      decodeChatContentFromStorage(
        blob,
        { session_id: 'sess-1', message_id: 'msg-1' },
        () => null,
      ),
    ).rejects.toBeInstanceOf(ChatVaultLockedError);
  });
});

describe('D-137 P1.2 — Codex P1 fold: locked-vault behavior in listMessages', () => {
  it('listMessages propagates ChatVaultLockedError when key provider returns null', async () => {
    const { ChatVaultLockedError, createChatStore } = await import('../storage/chat-store.js');
    // Write under a real key; then re-construct the store with a
    // locked key provider so the read path returns null.
    store.createSession({ id: 'sess-1', now: 1000 });
    await store.appendMessage({
      id: 'msg-1',
      session_id: 'sess-1',
      role: 'user',
      content: 'hi',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1100,
    });
    const lockedStore = createChatStore(db, () => null);
    await expect(lockedStore.listMessages('sess-1')).rejects.toBeInstanceOf(
      ChatVaultLockedError,
    );
  });

  it('listMessages still degrades gracefully on AAD-mismatch corruption (Codex distinction)', async () => {
    // Validates the two error paths are distinguished. AAD-mismatch
    // surfaces as empty content (per the existing graceful path);
    // locked-key surfaces as a thrown error (the P1 fold).
    store.createSession({ id: 'sess-1', now: 1000 });
    store.createSession({ id: 'sess-2', now: 1000 });
    await store.appendMessage({
      id: 'msg-1',
      session_id: 'sess-1',
      role: 'user',
      content: 'in-1',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1100,
    });
    await store.appendMessage({
      id: 'msg-2',
      session_id: 'sess-2',
      role: 'user',
      content: 'in-2',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1100,
    });
    db.prepare(`
      UPDATE chat_messages
         SET content_encrypted = (
           SELECT content_encrypted FROM chat_messages WHERE message_id = 'msg-2'
         )
       WHERE message_id = 'msg-1'
    `).run();
    // Same key + same store; cross-binding swap degrades to empty
    // content — does NOT throw (unlike the locked case).
    const messages = await store.listMessages('sess-1');
    expect(messages[0].content).toBe('');
  });
});

describe('D-137 P1.2 — ChatStore session CRUD', () => {
  it('createSession + getSession round-trip', () => {
    const session = store.createSession({
      id: 'sess-1',
      title: 'My session',
      now: 1000,
    });
    expect(session.id).toBe('sess-1');
    expect(session.title).toBe('My session');
    expect(session.picker_state.current).toBe('self');
    expect(session.model_routing.current).toBe('byok');
    expect(session.archived).toBe(false);
    const fetched = store.getSession('sess-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe('sess-1');
    expect(fetched!.title).toBe('My session');
  });

  it('getSession returns null when missing', () => {
    expect(store.getSession('nonexistent')).toBeNull();
  });

  it('listSessions returns rows in last_active_at DESC order', () => {
    store.createSession({ id: 'sess-old', now: 1000 });
    store.createSession({ id: 'sess-new', now: 2000 });
    const sessions = store.listSessions();
    expect(sessions.length).toBe(2);
    expect(sessions[0].id).toBe('sess-new');
    expect(sessions[1].id).toBe('sess-old');
  });

  it('listSessions surfaces message_count per session', async () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    await store.appendMessage({
      id: 'msg-1',
      session_id: 'sess-1',
      role: 'user',
      content: 'hi',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1100,
    });
    await store.appendMessage({
      id: 'msg-2',
      session_id: 'sess-1',
      role: 'assistant',
      content: 'hello',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1200,
    });
    const [summary] = store.listSessions();
    expect(summary.message_count).toBe(2);
  });

  it('setPicker persists + appears on get + bumps last_active_at', () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    const ok = store.setPicker('sess-1', 'connection.mcp.bob', 5000);
    expect(ok).toBe(true);
    const fetched = store.getSession('sess-1')!;
    expect(fetched.picker_state.current).toBe('connection.mcp.bob');
    expect(fetched.last_active_at).toBe(5000);
  });

  it('setModelPref persists provider + model_id', () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    store.setModelPref(
      'sess-1',
      { current: 'byok', provider: 'anthropic', model_id: 'claude-opus-4-7' },
      6000,
    );
    const fetched = store.getSession('sess-1')!;
    expect(fetched.model_routing.current).toBe('byok');
    expect(fetched.model_routing.provider).toBe('anthropic');
    expect(fetched.model_routing.model_id).toBe('claude-opus-4-7');
  });

  it('§ A.14 — setModelPref persists the slot hint; clear reverts to the default hint', () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    store.setModelPref('sess-1', { current: 'byok', model_hint: 'thinking' }, 6000);
    expect(store.getSession('sess-1')!.model_routing.model_hint).toBe('thinking');
    // A non-overridden session inherits the global default's resolved hint
    // (slot_2 → speed 'quality').
    store.setDefaultModelSourceId('slot_2', 6100);
    store.clearModelPref('sess-1', 6200);
    const reverted = store.getSession('sess-1')!.model_routing;
    expect(reverted.overridden).toBe(false);
    expect(reverted.model_hint).toBe('quality');
  });

  it('§ A.14 — a default with no hint leaves an inherited session hint-less', () => {
    store.createSession({ id: 'sess-2', now: 1000 });
    store.setDefaultModelSourceId('free_pool', 6300);
    expect(store.getSession('sess-2')!.model_routing.model_hint).toBeUndefined();
  });

  it('setArchived toggles the flag', () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    store.setArchived('sess-1', true, 7000);
    expect(store.getSession('sess-1')!.archived).toBe(true);
    store.setArchived('sess-1', false, 7100);
    expect(store.getSession('sess-1')!.archived).toBe(false);
  });

  it('deleteSession removes the row + every message', async () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    await store.appendMessage({
      id: 'msg-1',
      session_id: 'sess-1',
      role: 'user',
      content: 'hi',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1100,
    });
    const deleted = store.deleteSession('sess-1');
    expect(deleted).toBe(true);
    expect(store.getSession('sess-1')).toBeNull();
    expect((await store.listMessages('sess-1')).length).toBe(0);
  });
});

describe('D-137 P1.2 — ChatStore message CRUD', () => {
  beforeEach(() => {
    store.createSession({ id: 'sess-1', now: 1000 });
  });

  it('appendMessage + listMessages round-trip preserves content', async () => {
    await store.appendMessage({
      id: 'msg-1',
      session_id: 'sess-1',
      role: 'user',
      content: 'tell me about peter',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1100,
    });
    const messages = await store.listMessages('sess-1');
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].content).toBe('tell me about peter');
    expect(messages[0].role).toBe('user');
    expect(messages[0].target_server).toBe('self');
  });

  it('appendMessage persists attachments_blob and returns typed turn refs', async () => {
    await store.appendMessage({
      id: 'msg-1',
      session_id: 'sess-1',
      role: 'user',
      content: 'see attached',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1100,
      attachments: [
        { file_id: 'file-voice-1', media_class: 'voice' },
        { file_id: 'file-image-1', media_class: 'image' },
      ],
    });

    const row = db
      .prepare(`SELECT attachments_blob FROM chat_messages WHERE message_id = ?`)
      .get('msg-1') as { attachments_blob: string };
    expect(JSON.parse(row.attachments_blob)).toEqual([
      { file_id: 'file-voice-1', media_class: 'voice' },
      { file_id: 'file-image-1', media_class: 'image' },
    ]);

    const messages = await store.listMessages('sess-1');
    expect(messages[0].content).toBe('see attached');
    expect(messages[0].attachments).toEqual([
      { file_id: 'file-voice-1', media_class: 'voice' },
      { file_id: 'file-image-1', media_class: 'image' },
    ]);
  });

  it('appendMessage encrypts content at rest', async () => {
    await store.appendMessage({
      id: 'msg-1',
      session_id: 'sess-1',
      role: 'user',
      content: 'PLAINTEXT-PETER-DO-NOT-LEAK',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1100,
    });
    const row = db
      .prepare(`SELECT content_encrypted FROM chat_messages WHERE message_id = ?`)
      .get('msg-1') as { content_encrypted: string };
    // sub_dek encryption makes the on-disk blob opaque base64; the
    // literal plaintext must not appear in the at-rest payload.
    expect(row.content_encrypted).not.toContain('PLAINTEXT-PETER-DO-NOT-LEAK');
  });

  it('listMessages orders by ts ASC', async () => {
    await store.appendMessage({
      id: 'msg-2',
      session_id: 'sess-1',
      role: 'assistant',
      content: 'second',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 2000,
    });
    await store.appendMessage({
      id: 'msg-1',
      session_id: 'sess-1',
      role: 'user',
      content: 'first',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1000,
    });
    const messages = await store.listMessages('sess-1');
    expect(messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
  });

  it('appendMessage persists tool_calls + provenance', async () => {
    await store.appendMessage({
      id: 'msg-1',
      session_id: 'sess-1',
      role: 'assistant',
      content: 'I used contact.search',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1100,
      tool_calls: [
        {
          tool_name: 'contact.search',
          tier: 1,
          args: { query: 'Peter' },
          result_ref: 'sess-1:turn-1:contact.search',
          status: 'ok',
          started_at: 1050,
          completed_at: 1080,
        },
      ],
      provenance: [{ source: 'local', record_id: 'contact-123', label: 'Peter Smith' }],
    });
    const messages = await store.listMessages('sess-1');
    expect(messages[0].tool_calls?.length).toBe(1);
    expect(messages[0].tool_calls?.[0].tool_name).toBe('contact.search');
    expect(messages[0].provenance?.[0].source).toBe('local');
  });

  it('messages with different session keys do NOT cross-decrypt (per AAD binding)', async () => {
    // Force two sessions sharing a key but distinct (session_id,
    // message_id) bindings — the AAD MUST stop a row-swap from
    // succeeding. We swap the at-rest blob between two rows and assert
    // the row's plaintext degrades to empty (per messageFromRow's
    // graceful-degradation path).
    store.createSession({ id: 'sess-2', now: 1000 });
    await store.appendMessage({
      id: 'msg-1',
      session_id: 'sess-1',
      role: 'user',
      content: 'in sess-1',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1100,
    });
    await store.appendMessage({
      id: 'msg-2',
      session_id: 'sess-2',
      role: 'user',
      content: 'in sess-2',
      target_server: 'self',
      picker_at_send: samplePicker(),
      model_used: sampleModel(),
      ts: 1100,
    });
    // Cross-swap encrypted blobs — should make both rows unreadable
    // (AAD binds to session_id + message_id).
    db.prepare(`
      UPDATE chat_messages
         SET content_encrypted = (
           SELECT content_encrypted FROM chat_messages WHERE message_id = 'msg-2'
         )
       WHERE message_id = 'msg-1'
    `).run();
    const messages = await store.listMessages('sess-1');
    // Graceful degradation — corrupted row surfaces as empty string,
    // not a thrown exception (per messageFromRow contract).
    expect(messages[0].content).toBe('');
  });
});
