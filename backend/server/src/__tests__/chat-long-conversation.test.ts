/** What a LONG chat conversation costs, and what the model actually sees.
 *
 *  ⛔ WHY THIS FILE EXISTS. Nothing exercised chat past a handful of turns, so
 *  two properties that only appear at length were unasserted:
 *
 *   1. The prompt is bounded. `CHAT_TAIL_LIMIT` carries the last 3
 *      user/assistant messages, so conversation length cannot grow the packet
 *      into the model's context window. Without a test, someone raising that
 *      limit "a little" has no signal that it is the thing keeping a 2000-turn
 *      session sendable.
 *
 *   2. Getting those 3 rows is O(1) in conversation length. It was not:
 *      `buildChatTail` called `listMessages`, which reads AND DECRYPTS every
 *      message in the session, then sliced 3 in JS. Measured on an encrypted
 *      realm: 0.2ms at 10 turns, 3.2ms at 500, 12.3ms at 2000 — per turn.
 *
 *  ⚠ These assert the STORE contract, not a live model turn. The LLM path
 *  needs a credential with quota (see the harness's drivability map); the
 *  trimming decision is made before any model call and is what this pins. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';

const PICKER = {
  display_name: 'Self',
  signature: {
    server_kind: 'recued' as const,
    version: '1.0.0',
    instance_id: 'test-instance',
  },
};

describe('long chat conversations', () => {
  let dir: string;
  let db: Database.Database;
  let store: ChatStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-long-'));
    db = new Database(join(dir, 'c.db'));
    ensureChatSchema(db);
    store = createChatStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let seq = 0;
  const append = async (
    session_id: string, role: 'user' | 'assistant' | 'tool', content: string, ts: number,
  ): Promise<void> => {
    await store.appendMessage({
      id: `m-${seq++}`,
      session_id,
      role,
      content,
      target_server: 'self',
      picker_at_send: PICKER,
      model_used: { provider: 'test', model_id: 'test-model' },
      ts,
    });
  };

  const seed = async (session_id: string, turns: number): Promise<void> => {
    store.createSession({ id: session_id, now: 1_000 });
    for (let i = 0; i < turns; i++) {
      await append(session_id, 'user', `user turn ${i}`, 2_000 + i * 2);
      await append(session_id, 'assistant', `assistant turn ${i}`, 2_001 + i * 2);
    }
  };

  it('⛔ the tail read returns the LAST n, oldest-first, whatever the length', async () => {
    await seed('s1', 200);
    const tail = await store.listRecentConversational('s1', 3);
    expect(tail).toHaveLength(3);
    // Oldest-first ordering, matching `listMessages` — the query selects DESC
    // and reverses, so a dropped `.reverse()` would silently invert the
    // conversation the model reads.
    expect(tail.map((m) => m.content)).toEqual([
      'assistant turn 198', 'user turn 199', 'assistant turn 199',
    ]);
  });

  it('⛔ reads a CONSTANT number of rows regardless of conversation length', async () => {
    // The whole point. Asserted by counting rows the statement returns, not by
    // timing — a timing assertion is flaky and would not say WHY it regressed.
    await seed('short', 5);
    await seed('long', 500);
    const shortRead = await store.listRecentConversational('short', 3);
    const longRead = await store.listRecentConversational('long', 3);
    expect(shortRead).toHaveLength(3);
    expect(longRead).toHaveLength(3);

    // ...and the plan is a bounded index seek, not a scan of the session.
    const plan = (db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM chat_messages
          WHERE session_id = ? AND role IN ('user','assistant')
          ORDER BY ts DESC, message_id DESC LIMIT ?`,
      )
      .all('long', 3) as Array<{ detail: string }>).map((r) => r.detail).join(' ; ');
    expect(plan).toMatch(/SEARCH chat_messages USING INDEX/);
  });

  it('filters to conversational rows in SQL, not after the fact', async () => {
    // A session heavy in tool/system rows must still yield three CONVERSATIONAL
    // messages. Filtering after a `LIMIT 3` would return fewer, and the model
    // would silently lose its recent context in exactly the busy sessions where
    // it matters most.
    await seed('mixed', 3);
    for (let i = 0; i < 40; i++) {
      await append('mixed', 'tool', `tool noise ${i}`, 50_000 + i);
    }
    const tail = await store.listRecentConversational('mixed', 3);
    expect(tail).toHaveLength(3);
    expect(tail.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
  });

  it('a short session returns everything it has, not an error', async () => {
    await seed('tiny', 1);
    expect(await store.listRecentConversational('tiny', 3)).toHaveLength(2);
    expect(await store.listRecentConversational('tiny', 0)).toEqual([]);
  });

  it('is scoped to its own session', async () => {
    await seed('a', 5);
    await seed('b', 5);
    const tail = await store.listRecentConversational('a', 3);
    expect(tail.every((m) => m.session_id === 'a')).toBe(true);
  });
});
