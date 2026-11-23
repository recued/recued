/** D-405 slice 8 — the hint keys the earlier answers of a call's conversation carried: what every place
 *  that offers a hint from a search leaves out, never the same hint twice in one conversation (P3). */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { ChatDispatchContext } from '@recued/contracts';

import { HINT_HISTORY_MESSAGES, createCarriedHintKeys } from '../next-steps/carried-hints.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const ctx = (session_id: string | undefined, turn_state = new Map<string, unknown>()): ChatDispatchContext => ({
  channel: 'internal_function_call',
  ...(session_id !== undefined ? { session_id } : {}),
  turn_id: 't1',
  turn_state,
});

const store = () => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const chat = createChatStore(db);
  chat.createSession({ id: 's1', now: 1_000 });
  chat.createSession({ id: 's2', now: 1_000 });
  return chat;
};
const base = { target_server: 'self' as const, model_used: { provider: 'test', model_id: 'test' },
  picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued' as const, version: 'test', instance_id: 'local' } } };

describe('the hints a conversation already carried', () => {
  it('every hint an earlier answer carried, a step or an offer; never a fix for a failed call, never the owner\'s own message', async () => {
    const chat = store();
    await chat.appendMessage({ ...base, id: 'u1', session_id: 's1', role: 'user', content: 'When does my passport expire?', ts: 1_001,
      fixes: [{ kind: 'thing', type_id: 'visa', type_name: 'Visa' }] } as never);
    await chat.appendMessage({ ...base, id: 'a1', session_id: 's1', role: 'assistant', content: 'None yet.', ts: 1_002,
      fixes: [{ kind: 'thing', type_id: 'passport', type_name: 'Passport' },
        { kind: 'switch', entry_key: 'primitive.mail.search', label: 'Search your mail' }],
      install_offers: [{ kind: 'pack', slug: 'rental-book', name: 'Rental Book', publisher: 'recued-core', recipes: [] }] });
    const carried = createCarriedHintKeys(chat);
    expect([...await carried(ctx('s1'))].sort()).toEqual(['offer:pack:rental-book', 'thing:passport']);
    // Each conversation its own.
    expect([...await carried(ctx('s2'))]).toEqual([]);
  });

  it('read once a turn, whatever number of searches ask; the next turn reads again', async () => {
    const chat = store();
    const read = vi.spyOn(chat, 'listMessagePage');
    const carried = createCarriedHintKeys(chat);
    const turn = new Map<string, unknown>();
    await carried(ctx('s1', turn));
    await carried(ctx('s1', turn));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('s1', HINT_HISTORY_MESSAGES);
    await carried(ctx('s1', new Map()));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a call with no conversation has none, and reads nothing', async () => {
    const chat = store();
    const read = vi.spyOn(chat, 'listMessagePage');
    expect([...await createCarriedHintKeys(chat)(ctx(undefined))]).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('⛔ a conversation that cannot be read rejects: the caller then leaves nothing out', async () => {
    const carried = createCarriedHintKeys({ listMessagePage: async () => { throw new Error('locked'); } });
    await expect(carried(ctx('s1'))).rejects.toThrow('locked');
  });
});
