import { describe, expect, it, vi } from 'vitest';
import { CHAT_MAIN_TURN_TOOL_LOOP_CAP, contributorForChatRole, type ChatMessage } from '@recued/contracts';
import { createCapacity } from '@recued/middleware';
import type { EventBus } from '../events/bus.js';
import {
  chatCapacity,
  createServerChatChannel,
} from '../chat-channel-factory.js';
import { createChatBusSink } from '../chat-channel-sink.js';
import { createChatStoreSessionStateStore } from '../chat-channel-session-store.js';
import type { ChatStore } from '../storage/chat-store.js';

const fakeBus = (): Pick<EventBus, 'emit'> => ({
  emit: vi.fn(),
});

const message = (
  overrides: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: 'msg',
  session_id: 'sess-1',
  role: 'user',
  contributor: 'user',
  content: 'hello',
  target_server: 'self',
  picker_at_send: {
    display_name: 'Self',
    signature: {
      server_kind: 'recued',
      version: 'test',
      instance_id: 'test-server',
    },
  },
  model_used: { provider: 'local', model_id: 'test-model' },
  ts: 1,
  ...overrides,
});

const createFakeChatStore = (): ChatStore & {
  messages: ChatMessage[];
  appendMessage: ReturnType<typeof vi.fn>;
  listMessages: ReturnType<typeof vi.fn>;
} => {
  const sessions = new Set<string>();
  const messages: ChatMessage[] = [];

  return {
    messages,
    // ⚠ Present so this double still satisfies `ChatStore`, not because these
    // adapters page or track seen state. A structural double goes stale the
    // moment the interface grows, and `npm run build` cannot say so — it
    // excludes tests, so only `typecheck:tests` catches it.
    async listMessagePage(_session_id: string, limit: number) {
      const page = messages.slice(-limit);
      return { messages: page, has_more: messages.length > page.length };
    },
    markSessionSeen() {},
    createSession(input) {
      sessions.add(input.id);
      return {
        id: input.id,
        created_at: input.now ?? 0,
        last_active_at: input.now ?? 0,
        picker_state: input.picker_state ?? { current: 'self' },
        model_routing: input.model_routing ?? { current: 'byok' },
        archived: false,
      };
    },
    getSession(session_id) {
      return sessions.has(session_id)
        ? {
            id: session_id,
            created_at: 0,
            last_active_at: 0,
            picker_state: { current: 'self' },
            model_routing: { current: 'byok' },
            archived: false,
          }
        : null;
    },
    listSessions: () => [],
    setPicker: () => false,
    setModelPref: () => false,
    clearModelPref: () => false,
    getDefaultModelPref: () => ({ layer: 'byok', updated_at: 0 }),
    getDefaultModelSourceId: () => ({ source_id: null, updated_at: 0 }),
    setDefaultModelSourceId: (source_id) => ({ source_id, updated_at: 0 }),
    // Global chat-behaviour setting. ⚠ OFF in the double: these adapters do not
    // fold, and inheriting the server's default-ON would spend a brief call
    // inside tests whose subject is channel adaptation.
    getRollingBriefEnabled: () => false,
    setRollingBriefEnabled: (enabled: boolean) => enabled,
    // ⚠ SECOND TIME THIS DOUBLE WENT STALE IN ONE SESSION — first when
    //   `ChatStore` grew the rolling-brief ENABLE, now when it grew the brief's
    //   durable storage. The stub's note above predicts exactly this, and the
    //   recurrence is the point: a structural double tracks an interface only as
    //   well as someone remembers to, and only `typecheck:tests` says otherwise.
    readSessionBrief: async () => null,
    writeSessionBrief: async () => undefined,
    deleteSessionBrief: () => undefined,
    setTitle: () => false,
    setArchived: () => false,
    bumpSessionLastActiveAt: () => false,
    deleteSession: () => false,
    appendMessage: vi.fn(async (input) => {
      const row = message({
        id: input.id,
        session_id: input.session_id,
        role: input.role,
        // mirror the real store's server stamp (5.f)
        contributor: contributorForChatRole(input.role),
        content: input.content,
        target_server: input.target_server,
        picker_at_send: input.picker_at_send,
        model_used: input.model_used,
        ts: input.ts ?? 0,
        ...(input.tool_calls ? { tool_calls: input.tool_calls } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
      });
      sessions.add(input.session_id);
      messages.push(row);
      return row;
    }),
    // Mirrors the real store's SQL: conversational roles only, last `limit`,
    // returned oldest-first. Implemented rather than stubbed to `[]` — a fake
    // that returns nothing would make `buildChatTail` look like it works on an
    // empty tail, which is the state this double exists to avoid.
    listRecentConversational: vi.fn(async (session_id: string, limit: number) =>
      messages
        .filter((row) => row.session_id === session_id)
        .filter((row) => row.role === 'user' || row.role === 'assistant')
        .slice(-Math.max(0, limit)),
    ),
    listMessages: vi.fn(async (session_id: string) =>
      messages.filter((row) => row.session_id === session_id),
    ),
    appendEgress: vi.fn(async () => {}),
    getEgress: vi.fn(async () => []),
  };
};

describe('D-160 Stage 1a chat channel D-121 sink', () => {
  it('maps ChannelOutbound kinds to chat broadcast events and skips done', () => {
    const bus = fakeBus();
    const sink = createChatBusSink(bus);
    const emit = vi.mocked(bus.emit);

    sink({
      kind: 'token',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      delta: 'tok',
    });
    sink({
      kind: 'transparency',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      note: 'looking up context',
    });
    sink({
      kind: 'message',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      text: 'final text',
    });
    sink({
      kind: 'done',
      session_id: 'sess-1',
      turn_id: 'turn-1',
    });

    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenNthCalledWith(1, {
      kind: 'chat.token_streamed',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      delta: 'tok',
    });
    expect(emit).toHaveBeenNthCalledWith(2, {
      kind: 'chat.transparency',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      event: {
        kind: 'chat.channel_note',
        note: 'looking up context',
      },
    });
    expect(emit).toHaveBeenNthCalledWith(3, {
      kind: 'chat.message_complete',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      final: 'final text',
    });
  });

  it('swallows bus failures at the broadcast boundary', () => {
    const sink = createChatBusSink({
      emit: vi.fn(() => {
        throw new Error('push unavailable');
      }),
    });

    expect(() =>
      sink({
        kind: 'token',
        session_id: 'sess-1',
        turn_id: 'turn-1',
        delta: 'tok',
      }),
    ).not.toThrow();
  });
});

describe('D-160 Stage 2 cache-only ChatStore-backed SessionStateStore', () => {
  it('caches appended SessionEntry rows WITHOUT writing through to the ChatStore', async () => {
    const chatStore = createFakeChatStore();
    const store = createChatStoreSessionStateStore(chatStore);

    store.append({
      session_id: 'sess-1',
      surface: 'chat',
      role: 'user',
      text: 'hello',
      ts: 10,
    });
    store.append({
      session_id: 'sess-1',
      surface: 'chat',
      role: 'assistant',
      text: 'answer',
      ts: 20,
    });
    await store.flush();

    // Cache-only: the orchestrator's RICH finalize owns durable
    // persistence, so `append` never writes through to the ChatStore
    // (a write-through would double-persist a lossy, defaults-filled row
    // against the finalize). `flush` is a no-op.
    expect(chatStore.appendMessage).not.toHaveBeenCalled();
    expect(chatStore.messages).toEqual([]);
    // ...but `history` reflects the cached appends within the session.
    expect(store.history('sess-1')).toEqual([
      { session_id: 'sess-1', surface: 'chat', role: 'user', text: 'hello', ts: 10 },
      { session_id: 'sess-1', surface: 'chat', role: 'assistant', text: 'answer', ts: 20 },
    ]);
  });

  it('preloads append-ordered conversational history from the durable ChatStore rows', async () => {
    const chatStore = createFakeChatStore();
    // Seed the durable store the way the rich finalize does (direct rows),
    // then confirm `preload` hydrates the cache append-ordered.
    const seed = async (
      id: string,
      role: 'user' | 'assistant',
      content: string,
      ts: number,
    ): Promise<void> => {
      await chatStore.appendMessage({
        id,
        session_id: 'sess-1',
        role,
        content,
        target_server: 'self',
        picker_at_send: {
          display_name: 'Self',
          signature: { server_kind: 'recued', version: 'test', instance_id: 'test-server' },
        },
        model_used: { provider: 'local', model_id: 'test-model' },
        ts,
      });
    };
    await seed('m-user', 'user', 'hello', 10);
    await seed('m-assistant', 'assistant', 'answer', 20);

    const store = createChatStoreSessionStateStore(chatStore);
    await store.preload('sess-1');

    expect(store.history('sess-1')).toEqual([
      { session_id: 'sess-1', surface: 'chat', role: 'user', text: 'hello', ts: 10 },
      { session_id: 'sess-1', surface: 'chat', role: 'assistant', text: 'answer', ts: 20 },
    ]);
  });

  it('degrades to EMPTY — not a STALE prior turn — when a preload read throws', async () => {
    const chatStore = createFakeChatStore();
    await chatStore.appendMessage({
      id: 'm-user',
      session_id: 'sess-1',
      role: 'user',
      content: 'hello',
      target_server: 'self',
      picker_at_send: {
        display_name: 'Self',
        signature: { server_kind: 'recued', version: 'test', instance_id: 'test-server' },
      },
      model_used: { provider: 'local', model_id: 'test-model' },
      ts: 10,
    });
    const store = createChatStoreSessionStateStore(chatStore);

    // Turn N-1: a successful preload warms the LONG-LIVED cache.
    await store.preload('sess-1');
    expect(store.history('sess-1')).toHaveLength(1);

    // Turn N: the durable read throws. The store must NOT keep serving turn
    // N-1's entries — a `ctx.history` reader (the D-164 entity prefetch) would
    // otherwise prefetch on the PREVIOUS turn. `preload` clears the cache before
    // re-throwing (the orchestrator's best-effort wrapper swallows the throw),
    // so `history` degrades to EMPTY and the prefetch no-ops.
    chatStore.listMessages.mockRejectedValueOnce(new Error('listMessages failed'));
    await expect(store.preload('sess-1')).rejects.toThrow('listMessages failed');
    expect(store.history('sess-1')).toEqual([]);
  });
});

describe('D-160 Stage 1a chat capacity and factory', () => {
  it('maps the chat loop cap to a middleware Capacity partial', () => {
    expect(chatCapacity()).toEqual({
      max_turns: CHAT_MAIN_TURN_TOOL_LOOP_CAP,
    });
    expect(createCapacity(chatCapacity()).max_turns).toBe(
      CHAT_MAIN_TURN_TOOL_LOOP_CAP,
    );
  });

  it('wires createChatChannel with the backend sink and store adapters', async () => {
    const bus = fakeBus();
    const chatStore = createFakeChatStore();
    const { channel } = createServerChatChannel({
      bus,
      chatStore,
      userId: 'local-user',
    });
    const inbound = vi.fn();

    channel.onInbound(inbound);
    await channel.receiveUserMessage({
      session_id: 'sess-1',
      text: 'hello',
    });
    await channel.deliver({
      kind: 'message',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      text: 'answer',
    });

    expect(channel.surface).toBe('chat');
    expect(inbound).toHaveBeenCalledWith(expect.objectContaining({
      from: 'local-user',
      session_id: 'sess-1',
      source: expect.objectContaining({
        channel: 'chat',
        user_id: 'local-user',
      }),
    }));
    // Default `deliverFinalMessage: true` — the channel owns final delivery.
    expect(vi.mocked(bus.emit)).toHaveBeenCalledWith({
      kind: 'chat.message_complete',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      final: 'answer',
    });
  });

  it('suppresses the final chat.message_complete when deliverFinalMessage is false', async () => {
    // D-160 Stage 2 — the orchestrator's rich finalize owns
    // chat.message_complete (with the full ChatMessage row), so it
    // registers the channel with deliverFinalMessage: false. The channel
    // still streams the token delta but must NOT emit a second,
    // text-only chat.message_complete racing the finalize.
    const bus = fakeBus();
    const chatStore = createFakeChatStore();
    const { channel } = createServerChatChannel({
      bus,
      chatStore,
      userId: 'local-user',
      deliverFinalMessage: false,
    });

    await channel.deliver({
      kind: 'token',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      delta: 'streamed',
    });
    await channel.deliver({
      kind: 'message',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      text: 'answer',
    });

    const emit = vi.mocked(bus.emit);
    // The token delta still flows.
    expect(emit).toHaveBeenCalledWith({
      kind: 'chat.token_streamed',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      delta: 'streamed',
    });
    // ...but no chat.message_complete is emitted by the channel.
    expect(
      emit.mock.calls.some(([event]) => event.kind === 'chat.message_complete'),
    ).toBe(false);
  });
});
