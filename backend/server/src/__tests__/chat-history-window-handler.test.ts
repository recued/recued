/** `chat.session.get` windowing — the compatibility half.
 *
 *  ⛔ THE RULE THIS FILE EXISTS FOR: an absent `limit` MUST still return the
 *  whole conversation. A webclient older than this slice sends no limit and has
 *  no "load earlier" control; if the server windowed by DEFAULT, that client
 *  would show a silently truncated history with no way to reach the rest and
 *  nothing on screen admitting it. Windowing is opt-in, and only a caller that
 *  can page should opt in.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { handleSessionGet } from '../chat-handler.js';
import type { ChatRpcDeps } from '../chat-handler.js';

const picker = () => ({
  display_name: 'Self',
  signature: { server_kind: 'recued' as const, version: '1.0.0', instance_id: 'i' },
});

const harness = async (messages: number) => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const store = createChatStore(db);
  store.createSession({ id: 'chat_1', now: 1000 });
  for (let i = 0; i < messages; i += 1) {
    await store.appendMessage({
      id: `m${String(i).padStart(4, '0')}`,
      session_id: 'chat_1',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
      target_server: 'self',
      picker_at_send: picker(),
      model_used: { provider: 'local', model_id: 'm' },
      ts: 1000 + i,
    });
  }
  return { store, deps: { store } as unknown as ChatRpcDeps };
};

describe('handleSessionGet — windowing', () => {
  it('returns EVERYTHING when no limit is asked for', async () => {
    const { deps } = await harness(250);
    const result = await handleSessionGet(deps, { session_id: 'chat_1' });
    expect(result.messages).toHaveLength(250);
    // ⛔ And says nothing about `has_more`, because there is nothing more —
    // the client reads that absence as "complete", which is only true if the
    // un-windowed read really did hand over everything.
    expect(result).not.toHaveProperty('has_more');
  });

  it('windows to the newest page when a limit is asked for', async () => {
    const { deps } = await harness(250);
    const result = await handleSessionGet(deps, {
      session_id: 'chat_1',
      limit: 100,
    } as never);
    expect(result.messages).toHaveLength(100);
    expect(result.messages[0]?.content).toBe('message 150');
    expect(result.messages[99]?.content).toBe('message 249');
    expect(result.has_more).toBe(true);
    expect(result.oldest_cursor).toEqual({ ts: 1150, message_id: 'm0150' });
  });

  it('pages backwards from a cursor', async () => {
    const { deps } = await harness(250);
    const first = await handleSessionGet(deps, {
      session_id: 'chat_1', limit: 100,
    } as never);
    const older = await handleSessionGet(deps, {
      session_id: 'chat_1', limit: 100, before: first.oldest_cursor,
    } as never);
    expect(older.messages[0]?.content).toBe('message 50');
    expect(older.messages[99]?.content).toBe('message 149');
    expect(older.has_more).toBe(true);
  });

  /** A limit is a number a CLIENT sent, and a client is not the authority on
   *  how much work this server does. Clamped silently — the response reports
   *  what it actually returned, which is the field a caller should be reading. */
  it('clamps an absurd limit rather than obeying it', async () => {
    const { deps } = await harness(250);
    const result = await handleSessionGet(deps, {
      session_id: 'chat_1', limit: 1_000_000,
    } as never);
    expect(result.messages).toHaveLength(250);
    expect(result.has_more).toBe(false);
  });

  it('rejects a non-numeric limit instead of coercing it', async () => {
    const { deps } = await harness(5);
    await expect(
      handleSessionGet(deps, { session_id: 'chat_1', limit: 'lots' } as never),
    ).rejects.toThrow(/limit/);
  });

  /** ⛔ HALF A CURSOR IS NOT A POSITION. A caller sending one is not paging
   *  from somewhere earlier, it is paging from somewhere undefined — so the
   *  read falls back to the newest page rather than ordering against
   *  `undefined` and returning whatever that happens to mean in SQLite. */
  it('ignores a malformed cursor and returns the newest page', async () => {
    const { deps } = await harness(20);
    const result = await handleSessionGet(deps, {
      session_id: 'chat_1', limit: 5, before: { ts: 1010 },
    } as never);
    expect(result.messages[4]?.content).toBe('message 19');
  });
});
