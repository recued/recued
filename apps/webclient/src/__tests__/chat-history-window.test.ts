/** Windowed hydration on the client side.
 *
 *  `chat.session.get` used to return every message a conversation held —
 *  measured at 146ms of AEAD decrypt and ~2.4MB for 2,000 messages, paid on
 *  every open AND every reconnect recovery. The client now asks for a window
 *  and pages backwards.
 */

import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatSession } from '@recued/contracts';

import {
  hydrateThreadFromSnapshot,
  initialChatThreadState,
  prependOlderMessages,
} from '../chat/state.js';
import { scrollTopAfterPrepend } from '../chat/bootstrap-chat-route.js';

const session = (): ChatSession => ({
  id: 'chat_1', title: 'Chat', created_at: 1, last_active_at: 2,
  archived: false, picker_state: { current: 'self' },
  model_routing: {
    current: 'byok', provider: 'local', model_id: 'm', overridden: false,
  },
});

const message = (id: string, ts: number): ChatMessage => ({
  id, session_id: 'chat_1', role: 'assistant', contributor: 'model',
  content: id, target_server: 'self',
  picker_at_send: {
    display_name: 'Self',
    signature: { server_kind: 'recued', version: '1.0.0', instance_id: 'i' },
  },
  model_used: { provider: 'local', model_id: 'm' },
  ts,
});

describe('hydration reads the window contract', () => {
  /** ⛔ ABSENT `has_more` MEANS COMPLETE HERE — the opposite of
   *  `busy_session_ids`, where absence means the server cannot answer. A server
   *  older than this slice omits the field AND hands over the whole
   *  conversation, so the two coincide; reading absence as "there is more"
   *  would paint a "load earlier" control that pages to nothing. */
  it('shows no more to load when the server did not window', () => {
    const thread = hydrateThreadFromSnapshot(initialChatThreadState(), {
      ...session(),
      messages: [message('m1', 10), message('m2', 20)],
    });
    expect(thread.has_more_before).toBe(false);
    expect(thread.oldest_cursor).toBeNull();
  });

  it('carries the cursor when the server says there is more', () => {
    const thread = hydrateThreadFromSnapshot(initialChatThreadState(), {
      ...session(),
      messages: [message('m9', 90)],
      has_more: true,
      oldest_cursor: { ts: 90, message_id: 'm9' },
    });
    expect(thread.has_more_before).toBe(true);
    expect(thread.oldest_cursor).toEqual({ ts: 90, message_id: 'm9' });
  });

  it('treats an explicit has_more:false as complete', () => {
    const thread = hydrateThreadFromSnapshot(initialChatThreadState(), {
      ...session(),
      messages: [message('m1', 10)],
      has_more: false,
      oldest_cursor: { ts: 10, message_id: 'm1' },
    });
    expect(thread.has_more_before).toBe(false);
  });
});

describe('prependOlderMessages', () => {
  const loaded = () => hydrateThreadFromSnapshot(initialChatThreadState(), {
    ...session(),
    messages: [message('m3', 30), message('m4', 40)],
    has_more: true,
    oldest_cursor: { ts: 30, message_id: 'm3' },
  });

  it('puts the older page in FRONT and advances the cursor', () => {
    const next = prependOlderMessages(
      loaded(),
      [message('m1', 10), message('m2', 20)],
      { has_more: false, oldest_cursor: null },
    );
    expect(next.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(next.has_more_before).toBe(false);
    expect(next.oldest_cursor).toBeNull();
  });

  /** ⛔ The page and the thread are read at different moments, so a turn
   *  completing in between can put a row in both. A paged read is not a
   *  snapshot of one instant. */
  it('drops anything already on screen rather than duplicating it', () => {
    const next = prependOlderMessages(
      loaded(),
      [message('m2', 20), message('m3', 30)],
      { has_more: false, oldest_cursor: null },
    );
    expect(next.messages.map((m) => m.id)).toEqual(['m2', 'm3', 'm4']);
  });

  /** ⚠ `completed_turn_ids` is a question about the RECENT tail — it stops a
   *  just-acked turn scaffolding a bubble for finished work. Feeding it ancient
   *  turn ids would push the recent ones out of a 50-entry FIFO. */
  it('does not feed ancient turn ids into the completed-turn memory', () => {
    const before = loaded();
    const next = prependOlderMessages(
      before,
      [{ ...message('m1', 10), turn_id: 'ancient' }],
      { has_more: false, oldest_cursor: null },
    );
    expect(next.completed_turn_ids).toEqual(before.completed_turn_ids);
    expect(next.completed_turn_ids).not.toContain('ancient');
  });
});

describe('scrollTopAfterPrepend', () => {
  /** ⛔ A DIFFERENT RULE FROM `nextThreadScrollTop`. There the question is "was
   *  the reader at the bottom"; here the reader is at the TOP by definition,
   *  because that is where the control lives. Content lands ABOVE the viewport,
   *  so holding scrollTop holds a POSITION while the thing at that position
   *  moves down by everything prepended — the reader ends up looking at older
   *  text with no idea why. */
  it('keeps the same message under the eye when content lands above', () => {
    expect(scrollTopAfterPrepend(0, 1000, 3000)).toBe(2000);
    expect(scrollTopAfterPrepend(120, 1000, 3000)).toBe(2120);
  });

  it('never returns a negative offset if the content somehow shrank', () => {
    expect(scrollTopAfterPrepend(50, 1000, 400)).toBe(0);
  });

  it('is a no-op when nothing was added', () => {
    expect(scrollTopAfterPrepend(300, 1000, 1000)).toBe(300);
  });
});
