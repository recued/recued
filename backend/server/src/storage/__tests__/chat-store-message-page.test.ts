/** Windowed conversation reads.
 *
 *  `chat.session.get` returned every message a conversation had ever held, and
 *  decrypted each one: measured at 8.7ms for 100 messages, 33ms for 500, and
 *  146ms for 2,000 — paid on every session open AND every reconnect recovery,
 *  before ~2.4MB crosses the socket. This is the bounded read that replaces it.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { createChatStore, ensureChatSchema, type ChatStore } from '../chat-store.js';

const picker = () => ({
  display_name: 'Self',
  signature: { server_kind: 'recued' as const, version: '1.0.0', instance_id: 'i' },
});
const model = () => ({ provider: 'local', model_id: 'm' });

const seed = async (
  store: ChatStore,
  session_id: string,
  count: number,
  tsFor: (i: number) => number = (i) => 1000 + i,
): Promise<void> => {
  store.createSession({ id: session_id, now: 1000 });
  for (let i = 0; i < count; i += 1) {
    await store.appendMessage({
      id: `${session_id}-m${String(i).padStart(4, '0')}`,
      session_id,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
      target_server: 'self',
      picker_at_send: picker(),
      model_used: model(),
      ts: tsFor(i),
    });
  }
};

const harness = (): ChatStore => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  return createChatStore(db);
};

describe('listMessagePage', () => {
  it('returns the NEWEST page, in display order', async () => {
    const store = harness();
    await seed(store, 's', 10);
    const page = await store.listMessagePage('s', 3);
    expect(page.messages.map((m) => m.content)).toEqual([
      'message 7', 'message 8', 'message 9',
    ]);
    expect(page.has_more).toBe(true);
  });

  it('walks backwards through the whole conversation without gap or repeat', async () => {
    const store = harness();
    await seed(store, 's', 10);
    const seen = [];
    let cursor = undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await store.listMessagePage('s', 3, cursor);
      seen.unshift(...page.messages.map((m) => m.id));
      if (!page.has_more) break;
      cursor = page.oldest;
    }
    const all = (await store.listMessages('s')).map((m) => m.id);
    // Same rows, same order, each exactly once — the two properties a paged
    // read has to preserve and the two a cursor bug destroys.
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
  });

  /** ⛔ THE CURSOR IS A PAIR FOR THIS REASON. The wordless-drop path writes an
   *  assistant reply in the SAME millisecond as the message it answers, so `ts`
   *  is not unique. A `ts <` cursor drops every row sharing the boundary ts;
   *  `ts <=` repeats them forever. */
  it('pages correctly when every message shares one timestamp', async () => {
    const store = harness();
    await seed(store, 's', 9, () => 5000);
    const seen = [];
    let cursor = undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await store.listMessagePage('s', 2, cursor);
      seen.unshift(...page.messages.map((m) => m.id));
      if (!page.has_more) break;
      cursor = page.oldest;
    }
    const all = (await store.listMessages('s')).map((m) => m.id);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(9);
  });

  /** ⛔ `has_more` CANNOT BE `rows.length === limit`. A conversation of exactly
   *  `limit` messages would report more and hand back a cursor that pages to
   *  nothing — rendering a "load earlier" control that does nothing when
   *  pressed. The reader asks for one row beyond the page to tell those apart. */
  it('says there is no more when the conversation is exactly one page', async () => {
    const store = harness();
    await seed(store, 's', 5);
    const page = await store.listMessagePage('s', 5);
    expect(page.messages).toHaveLength(5);
    expect(page.has_more).toBe(false);
  });

  it('handles an empty conversation without inventing a cursor', async () => {
    const store = harness();
    store.createSession({ id: 'empty', now: 1000 });
    const page = await store.listMessagePage('empty', 10);
    expect(page.messages).toEqual([]);
    expect(page.has_more).toBe(false);
    expect(page.oldest).toBeUndefined();
  });

  it('reports no more once the cursor reaches the start', async () => {
    const store = harness();
    await seed(store, 's', 4);
    const first = await store.listMessagePage('s', 2);
    const second = await store.listMessagePage('s', 2, first.oldest);
    expect(second.messages.map((m) => m.content)).toEqual(['message 0', 'message 1']);
    expect(second.has_more).toBe(false);
  });
});
