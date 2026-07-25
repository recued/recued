import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { deriveSubDEK } from '@recued/crypto';
import type { ChatEgressPacket } from '@recued/contracts';
import {
  createChatStore,
  ensureChatSchema,
  type ChatKeyProvider,
  type ChatStore,
} from '../chat-store.js';

const fixedMaster = (seed: number): Uint8Array => {
  const buf = new Uint8Array(32);
  buf.fill(seed);
  return buf;
};

const chatKey = (master: Uint8Array): Uint8Array => deriveSubDEK(master, 'chat');

const samplePicker = () => ({
  display_name: 'Self',
  signature: {
    server_kind: 'recued' as const,
    version: '1.0.0',
    instance_id: 'instance-egress-test',
  },
});

const sampleModel = () => ({ provider: 'local', model_id: 'ollama/llama-3' });

const createHarness = (
  getKey?: ChatKeyProvider,
): { db: Database.Database; store: ChatStore } => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  return { db, store: createChatStore(db, getKey) };
};

const createParentMessage = async (
  store: ChatStore,
  session_id = 'sess-egress',
  message_id = 'msg-egress',
): Promise<void> => {
  store.createSession({ id: session_id, now: 1000 });
  await store.appendMessage({
    id: message_id,
    session_id,
    role: 'assistant',
    content: 'assistant response',
    target_server: 'self',
    picker_at_send: samplePicker(),
    model_used: sampleModel(),
    ts: 1100,
  });
};

const egressPackets: ChatEgressPacket[] = [
  {
    call_index: 2,
    prompt: 'third model-bound prompt with AliasContact3',
    model_id: 'local/llama-3.2',
    ts: 1300,
  },
  {
    call_index: 0,
    prompt: 'first model-bound prompt with AliasContact1',
    model_id: 'openai/gpt-4.1-mini',
    ts: 1110,
  },
  {
    call_index: 1,
    prompt: 'second model-bound prompt with AliasContact2',
    model_id: 'anthropic/claude-3-5-sonnet',
    ts: 1200,
  },
];

describe('chat egress history storage', () => {
  it('appendEgress + getEgress round-trips packets without a key provider using base64 fallback', async () => {
    const { db, store } = createHarness();
    await createParentMessage(store);

    await store.appendEgress('sess-egress', 'msg-egress', egressPackets);

    expect(await store.getEgress('sess-egress', 'msg-egress')).toEqual([
      egressPackets[1],
      egressPackets[2],
      egressPackets[0],
    ]);

    const row = db
      .prepare(
        `SELECT prompt_encrypted FROM chat_egress WHERE message_id = ? AND call_index = ?`,
      )
      .get('msg-egress', 0) as { prompt_encrypted: string };
    expect(Buffer.from(row.prompt_encrypted, 'base64').toString('utf8')).toBe(
      egressPackets[1].prompt,
    );
  });

  it('appendEgress + getEgress round-trips packets with the chat key provider using AEAD ciphertext', async () => {
    const key = chatKey(fixedMaster(7));
    const { db, store } = createHarness(() => key);
    await createParentMessage(store);

    await store.appendEgress('sess-egress', 'msg-egress', egressPackets);

    expect(await store.getEgress('sess-egress', 'msg-egress')).toEqual([
      egressPackets[1],
      egressPackets[2],
      egressPackets[0],
    ]);

    const row = db
      .prepare(
        `SELECT prompt_encrypted FROM chat_egress WHERE message_id = ? AND call_index = ?`,
      )
      .get('msg-egress', 0) as { prompt_encrypted: string };
    expect(row.prompt_encrypted).not.toContain(egressPackets[1].prompt);
    expect(Buffer.from(row.prompt_encrypted, 'base64').toString('utf8')).not.toContain(
      egressPackets[1].prompt,
    );
  });

  it('getEgress returns an empty array for a message with no egress packets', async () => {
    const { store } = createHarness();
    await createParentMessage(store);

    await expect(store.getEgress('sess-egress', 'msg-egress')).resolves.toEqual([]);
  });

  it('deleteSession cascades through the parent message and removes egress history', async () => {
    const { db, store } = createHarness();
    await createParentMessage(store);
    await store.appendEgress('sess-egress', 'msg-egress', egressPackets);

    expect(
      (db.prepare(`SELECT COUNT(*) AS count FROM chat_egress`).get() as { count: number }).count,
    ).toBe(3);

    expect(store.deleteSession('sess-egress')).toBe(true);

    await expect(store.getEgress('sess-egress', 'msg-egress')).resolves.toEqual([]);
    expect(
      (db.prepare(`SELECT COUNT(*) AS count FROM chat_egress`).get() as { count: number }).count,
    ).toBe(0);
  });
});
