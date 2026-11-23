/** D-343 (2026-11-15) — a day closed late over Telegram: after the owner's approval the chat's answer
 *  was refused by the store ("recall-ineligible source cannot carry candidates") because the turn had
 *  kept aliases and the answer passed them whatever its source; the continuation failed twice and the
 *  owner was never answered. A row carries them only where the owner's recall reads it. */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { ExecutionSource } from '@recued/contracts';
import { createChatStore, ensureChatSchema, recallCandidatesFor } from '../storage/chat-store.js';

const kept = [{ value: 'Alice Ada', kind: 'name' as const }];
const ownerChat: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's-1', user_id: 'owner' };
const telegram = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', user_id: 'owner' } as unknown as ExecutionSource;

describe('D-343 — the aliases a turn kept go only where the owner\'s recall reads', () => {
  it('keeps them for the owner\'s own chat and drops them for a messenger conversation', () => {
    expect(recallCandidatesFor(ownerChat, kept)).toEqual(kept);
    expect(recallCandidatesFor(telegram, kept)).toEqual([]);
    expect(recallCandidatesFor(undefined, kept)).toEqual([]);
  });

  it('so a Telegram answer that kept some is stored, not refused', async () => {
    const db = new Database(':memory:'); ensureChatSchema(db);
    const store = createChatStore(db, () => Buffer.alloc(32, 7));
    store.createSession({ id: 'messenger:telegram:1', title: 'telegram' });
    const row = { id: 'a-1', session_id: 'messenger:telegram:1', role: 'assistant' as const, content: 'Recorded Friday.',
      target_server: 'self' as const, picker_at_send: { display_name: 'self' } as never, model_used: { provider: 'x', model_id: 'y' },
      execution_source: telegram, ts: 1 };
    await expect(store.appendMessage({ ...row, retained_alias_candidates: kept })).rejects.toThrow(/recall-ineligible/u);
    await expect(store.appendMessage({ ...row, retained_alias_candidates: recallCandidatesFor(telegram, kept) as never })).resolves.toMatchObject({ id: 'a-1' });
    db.close();
  });
});
