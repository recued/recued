/** D-160 spec § A.8 step 6 — `messenger` reuses the chat turn substrate.
 *
 *  Step 6 is the final A.8 stage: "`messenger` provides its own `Channel` +
 *  `TurnExecutor` over the same registry" (spec § A.8 step 6 / N.9). The
 *  orchestrator gains `runMessengerTurn`, which drives a turn over the SAME
 *  constructor-built `streamRegistry` (the s5 hooks: standing-instructions /
 *  scope-search / correction-learning / confidence-shape / personal-recipes +
 *  the always-on pii-protect / pii-restore bookends) + the SAME `runChatTurn`
 *  mechanics as chat — via `runStream` with a caller-injected messenger
 *  `Channel`. The framework's post-`update` `out.message` delivers the final
 *  over the channel's transport. The chat path stays byte-identical (covered
 *  by the existing 2200+ chat-suite tests, unchanged here).
 *
 *  These tests pin the step-6 reuse + the two documented seam boundaries:
 *    1. the s5 hooks run on a MESSENGER turn over the same registry (the
 *       scope-search → confidence-shape chain fires when a producer is wired,
 *       exactly as on a chat turn);
 *    2. the framework delivers the final assistant message over the messenger
 *       channel's transport, recorded into the shared session store;
 *    3. the messenger surface is a selective projection (N.6) — the no-op
 *       `emit` + the channel's token-drop mean NO `chat.*` events leak to the
 *       D-121 bus;
 *    4. PII boundary (Codex review fold): the pii-protect bookend EXECUTES on
 *       a messenger turn but DECIDES inactive — D-163 `owns_llm_egress`
 *       classifies a `messenger-*` surface as external-egress — vs `active`
 *       on chat;
 *    5. robustness — a messenger turn with no chat session defaults to local
 *       and still delivers (never throws on a missing session, unlike chat).
 *
 *  The messenger channel + transport semantics themselves are pinned by
 *  `@recued/messenger`'s own tests (`d-160-phase-0-messenger`); this file
 *  pins the chat-lane REUSE the orchestrator now drives them through.
 */

import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  createInMemorySessionStore,
  type Channel,
  type ChannelInbound,
  type ChannelOutbound,
  type SessionStateStore,
  type SurfaceTag,
} from '@recued/chat';
import {
  createMiddlewareRegistry,
  runStream,
  type MiddlewareRegistry,
  type TurnExecutor,
} from '@recued/middleware';
import {
  registerFirstPartyMiddlewares,
  type ScopeSearchSource,
} from '@recued/middleware-recued';
import { piiEgress } from '@recued/gateway';
import {
  type AIOutput,
  type InternalToolRegistry,
  type RecuedServerSignature,
} from '@recued/contracts';

import {
  createChatOrchestrator,
  type ChatTurnAck,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import { createChatStreamMiddlewares } from '../chat-stream-middleware.js';
import { readPiiEgressPlan } from '../chat-pii-egress.js';
import {
  RECALL_SEARCH_TOOL_ENTRY,
  RECALL_SEARCH_TOOL_NAME,
} from '../chat-recall-search-tool.js';
import {
  CHAT_MESSAGE_RECALL_ELIGIBILITY,
  createChatStore,
  ensureChatSchema,
} from '../storage/chat-store.js';

const NOW = Date.UTC(2030, 0, 15, 12, 0, 0);
const SESSION = 'sess-msgr';
const baseDeps = { now: () => NOW, resolveTzClock: () => null };

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

const internalRegistry = (): InternalToolRegistry => ({
  list: () => [],
  listByTier: () => [],
  getByName: () => null,
  dispatch: vi.fn(async () => ({ ok: true, result: {} }) as const),
  subscribeRefresh: () => () => undefined,
});

const firstPartyRegistry = (): MiddlewareRegistry => {
  const registry = createMiddlewareRegistry();
  registerFirstPartyMiddlewares(registry);
  return registry;
};

/** What the messenger transport would post to the external app. */
interface CapturedSend {
  recipient: string;
  token: string;
  text: string;
}

/** A faithful in-test fake of the `@recued/messenger` channel — mirrors its
 *  `deliver` contract (record only the final `message`, dropping token /
 *  transparency / done events + wrong-session events) + `ingest` (parse →
 *  append user row → invoke the inbound handler with a `messenger-<vendor>`
 *  surface + `(messenger × actor)` source + `dispatch_depth`). Built from the
 *  `@recued/chat` `Channel` interface alone, so this chat-lane test pulls in
 *  no `@recued/messenger` / `@recued/transport` value import (neither is a
 *  backend/server dependency — wiring them in is the deferred downstream
 *  consumer's job). The real channel + transport are pinned by
 *  `@recued/messenger`'s own P0 tests (`d-160-phase-0-messenger`); this file
 *  exercises the orchestrator's channel-injection REUSE seam. */
const fakeMessengerChannel = (opts: {
  vendor: 'slack' | 'telegram';
  sessionStore: SessionStateStore;
  token: string;
  recipient: string;
  sessionId: string;
  parsedText: string;
  now: () => number;
}): {
  channel: Channel & { ingest(payload: unknown, dispatch_depth?: number): Promise<void> };
  sends: CapturedSend[];
} => {
  const sends: CapturedSend[] = [];
  const surface: SurfaceTag = `messenger-${opts.vendor}`;
  let handler: ((m: ChannelInbound) => void | Promise<void>) | null = null;
  const channel = {
    surface,
    async deliver(event: ChannelOutbound): Promise<void> {
      if (event.kind !== 'message') return;
      if (event.session_id !== opts.sessionId) return;
      sends.push({ recipient: opts.recipient, token: opts.token, text: event.text });
      opts.sessionStore.append({
        session_id: opts.sessionId,
        surface,
        role: 'assistant',
        text: event.text,
        ts: opts.now(),
      });
    },
    onInbound(h: (m: ChannelInbound) => void | Promise<void>): void {
      handler = h;
    },
    async ingest(_payload: unknown, dispatch_depth = 0): Promise<void> {
      const ts = opts.now();
      opts.sessionStore.append({
        session_id: opts.sessionId,
        surface,
        role: 'user',
        text: opts.parsedText,
        ts,
      });
      const inbound: ChannelInbound = {
        session_id: opts.sessionId,
        surface,
        text: opts.parsedText,
        from: 'U-sender',
        source: { channel: 'messenger', actor: 'user_self', vendor: opts.vendor, from: 'U-sender' },
        dispatch_depth,
        ts,
      };
      await handler?.(inbound);
    },
  };
  return { channel, sends };
};

/** A two-candidate fan-out source whose `query` is a spy — proves the
 *  scope-search hook reached it through `runStream` on a messenger turn. */
const spyContactSource = (): {
  source: ScopeSearchSource<unknown, unknown>;
  calls: () => number;
} => {
  let calls = 0;
  const source: ScopeSearchSource<unknown, unknown> = {
    id: 'local',
    query: async () => {
      calls += 1;
      return [
        { record: { id: 'alice' }, score: 0.9 },
        { record: { id: 'bob' }, score: 0.4 },
      ];
    },
  };
  return { source, calls: () => calls };
};

/** A minimal `Channel` that only records the surface — for the PII-plan
 *  unit (no transport needed). */
const recordingChannel = (surface: SurfaceTag): Channel => ({
  surface,
  async deliver(_event: ChannelOutbound): Promise<void> {},
  onInbound(): void {},
});

interface MessengerHarness {
  ack: ChatTurnAck;
  sends: CapturedSend[];
  sessionStore: ReturnType<typeof createInMemorySessionStore>;
  broadcast: { emit: ReturnType<typeof vi.fn> };
  executeAiCall: ReturnType<typeof vi.fn>;
  inbound: ChannelInbound;
}

/** Compose a real orchestrator + a real `@recued/messenger` channel over a
 *  capturing transport, then drive ONE messenger turn the production way:
 *  `onInbound(runMessengerTurn)` → `channel.ingest(payload)`. Returns the
 *  ack + the captured outbound sends + the shared session store + spies. */
const runMessengerTurn = async (opts: {
  aiResponse?: string;
  createSession?: boolean;
  getScopeSearchInput?: Parameters<typeof createChatOrchestrator>[0]['getScopeSearchInput'];
  parsedText?: string;
} = {}): Promise<MessengerHarness> => {
  const db = new Database(':memory:');
  try {
    ensureChatSchema(db);
    const chatStore = createChatStore(db);
    if (opts.createSession !== false) {
      chatStore.createSession({ id: SESSION, now: NOW - 1_000 });
    }
    const executeAiCall = vi.fn<ExecuteChatAiCall>(async () => ({
      body: {
        response: opts.aiResponse ?? 'reply over messenger',
        events: [],
        tool_calls: [],
      } satisfies AIOutput,
    }));
    const broadcast = { emit: vi.fn() };
    const orchestrator = createChatOrchestrator({
      chatStore,
      registry: internalRegistry(),
      broadcast,
      selfSignature,
      executeAiCall,
      middlewareRegistry: firstPartyRegistry(),
      ...(opts.getScopeSearchInput ? { getScopeSearchInput: opts.getScopeSearchInput } : {}),
      now: () => NOW,
    });

    const sessionStore = createInMemorySessionStore();
    const { channel, sends } = fakeMessengerChannel({
      vendor: 'slack',
      sessionStore,
      token: 'byo-token',
      recipient: 'C-recipient',
      sessionId: SESSION,
      parsedText: opts.parsedText ?? 'find alice',
      now: () => NOW,
    });

    let turnPromise: Promise<ChatTurnAck> | undefined;
    let inbound: ChannelInbound | undefined;
    channel.onInbound((ib) => {
      inbound = ib;
      turnPromise = orchestrator.runMessengerTurn({ channel, sessionStore, inbound: ib });
    });
    await channel.ingest({ vendor: 'slack' });
    const ack = await turnPromise!;
    return { ack, sends, sessionStore, broadcast, executeAiCall, inbound: inbound! };
  } finally {
    db.close();
  }
};

describe('D-160 A.8 step 6 — messenger reuses the s5 hooks over the same registry', () => {
  it('presents recall.search to direct owner chat but omits it from messenger over the same registry', async () => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const chatStore = createChatStore(db);
      chatStore.createSession({ id: SESSION, now: NOW - 1_000 });
      const registry: InternalToolRegistry = {
        list: () => [RECALL_SEARCH_TOOL_ENTRY],
        listByTier: (tier) =>
          tier === 1 ? [RECALL_SEARCH_TOOL_ENTRY] : [],
        getByName: (name) =>
          name === RECALL_SEARCH_TOOL_NAME
            ? RECALL_SEARCH_TOOL_ENTRY
            : null,
        dispatch: vi.fn(async () => ({ ok: true, result: {} }) as const),
        subscribeRefresh: () => () => {},
      };
      const executeAiCall = vi.fn<ExecuteChatAiCall>(async () => ({
        body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput,
      }));
      const orchestrator = createChatOrchestrator({
        chatStore,
        registry,
        selfSignature,
        executeAiCall,
        now: () => NOW,
      });

      await orchestrator.runTurn({
        session_id: SESSION,
        message: 'What did I say before?',
        picker_state: { current: 'self' },
      });

      const sessionStore = createInMemorySessionStore();
      const { channel } = fakeMessengerChannel({
        vendor: 'slack',
        sessionStore,
        token: 'byo-token',
        recipient: 'C-recipient',
        sessionId: SESSION,
        parsedText: 'What did I say before?',
        now: () => NOW,
      });
      let messengerTurn: Promise<ChatTurnAck> | undefined;
      channel.onInbound((inbound) => {
        messengerTurn = orchestrator.runMessengerTurn({
          channel,
          sessionStore,
          inbound,
        });
      });
      await channel.ingest({ vendor: 'slack' });
      await messengerTurn!;

      const toolNames = (callIndex: number): string[] => {
        const input = executeAiCall.mock.calls[callIndex]![1];
        const prompt = JSON.parse(String(input['llm.prompt'])) as {
          available_tools: Array<{ recipe_slug: string }>;
        };
        return prompt.available_tools.map((tool) => tool.recipe_slug);
      };
      expect(toolNames(0)).toContain(RECALL_SEARCH_TOOL_NAME);
      expect(toolNames(1)).not.toContain(RECALL_SEARCH_TOOL_NAME);

      const stamps = db.prepare(`
        SELECT recall_eligibility, COUNT(*) AS count
          FROM chat_messages
         GROUP BY recall_eligibility
         ORDER BY recall_eligibility
      `).all() as Array<{ recall_eligibility: string; count: number }>;
      expect(stamps).toEqual([
        {
          recall_eligibility:
            CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
          count: 2,
        },
        {
          recall_eligibility:
            CHAT_MESSAGE_RECALL_ELIGIBILITY.UNAUTHENTICATED_MESSENGER,
          count: 1,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('drives the scope-search → confidence-shape chain on a MESSENGER turn (the reuse)', async () => {
    const spy = spyContactSource();
    const { ack } = await runMessengerTurn({
      getScopeSearchInput: () => ({ args: { query: 'alice' }, sources: [spy.source] }),
    });
    // The producer dep threaded into the SAME `streamRegistry` the chat turn
    // uses; `runStream` drove the scope-search before-turn hook during the
    // messenger turn — so the source was queried, exactly as on a chat turn.
    expect(spy.calls()).toBe(1);
    expect(typeof ack.turn_id).toBe('string');
  });

  it('runs inert (no producer) without throwing — the hooks register + no-op', async () => {
    const { ack, executeAiCall, sends } = await runMessengerTurn();
    expect(typeof ack.turn_id).toBe('string');
    // Not a vacuous pass: the turn really ran the shared mechanics — the AI
    // call fired once and the answer was delivered over the channel — with
    // the scope-search / confidence-shape hooks registered but no-op (no
    // producer), exactly the faithful-no-op the chat path takes today.
    expect(executeAiCall).toHaveBeenCalledTimes(1);
    expect(sends.map((s) => s.text)).toEqual(['reply over messenger']);
  });

  it('drives the SAME streamRegistry instance on both a chat turn and a messenger turn', async () => {
    // The behavioral proof of "over the same registry" (N.9): ONE orchestrator
    // builds ONE `streamRegistry`; both `runTurn` (chat) and `runMessengerTurn`
    // drive it. A single scope-search producer fires once per surface, so the
    // spy's call count proves the SAME registry instance ran on BOTH — not two
    // independent registries that merely happen to carry the same hooks.
    const spy = spyContactSource();
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const chatStore = createChatStore(db);
      chatStore.createSession({ id: SESSION, now: NOW - 1_000 });
      const executeAiCall = vi.fn<ExecuteChatAiCall>(async () => ({
        body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput,
      }));
      const orchestrator = createChatOrchestrator({
        chatStore,
        registry: internalRegistry(),
        broadcast: { emit: () => {} },
        selfSignature,
        executeAiCall,
        middlewareRegistry: firstPartyRegistry(),
        getScopeSearchInput: () => ({ args: { query: 'x' }, sources: [spy.source] }),
        now: () => NOW,
      });

      // Chat turn — the scope-search hook fires once.
      await orchestrator.runTurn({
        session_id: SESSION,
        message: 'find alice',
        picker_state: { current: 'self' },
      });
      expect(spy.calls()).toBe(1);

      // Messenger turn on the SAME orchestrator → the SAME `streamRegistry`
      // drives the scope-search hook again.
      const sessionStore = createInMemorySessionStore();
      const { channel } = fakeMessengerChannel({
        vendor: 'slack',
        sessionStore,
        token: 'byo-token',
        recipient: 'C-recipient',
        sessionId: SESSION,
        parsedText: 'find bob',
        now: () => NOW,
      });
      let turnPromise: Promise<ChatTurnAck> | undefined;
      channel.onInbound((ib) => {
        turnPromise = orchestrator.runMessengerTurn({ channel, sessionStore, inbound: ib });
      });
      await channel.ingest({ vendor: 'slack' });
      await turnPromise!;
      expect(spy.calls()).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('D-160 A.8 step 6 — framework-owned delivery over the messenger channel', () => {
  it('delivers the final assistant message via the transport (out.message → deliver → send)', async () => {
    const { sends } = await runMessengerTurn({ aiResponse: 'hello from Recued' });
    expect(sends).toEqual([
      {
        recipient: 'C-recipient',
        token: 'byo-token',
        text: 'hello from Recued',
      },
    ]);
  });

  it('records the assistant turn into the shared session store, surface-tagged', async () => {
    const { sessionStore } = await runMessengerTurn({ aiResponse: 'hi there' });
    const history = sessionStore.history(SESSION);
    // ingest() recorded the user row; the framework's out.message → channel
    // deliver recorded the assistant row — both tagged `messenger-slack`
    // (one conversation, two windows).
    expect(history).toEqual([
      {
        session_id: SESSION,
        surface: 'messenger-slack' satisfies SurfaceTag,
        role: 'user',
        text: 'find alice',
        ts: NOW,
      },
      {
        session_id: SESSION,
        surface: 'messenger-slack' satisfies SurfaceTag,
        role: 'assistant',
        text: 'hi there',
        ts: NOW,
      },
    ]);
  });
});

describe('D-160 A.8 step 6 — selective projection (N.6): no chat.* leakage', () => {
  it('emits NO chat.* events to the D-121 bus on a messenger turn (no-op emit)', async () => {
    const { broadcast, sends } = await runMessengerTurn({ aiResponse: 'quiet' });
    // Guard against a vacuous pass: the turn genuinely completed + delivered
    // (one transport send) — yet produced ZERO D-121 bus events.
    expect(sends.map((s) => s.text)).toEqual(['quiet']);
    // The messenger surface renders neither token deltas nor transparency
    // notes; the rich emits route to the no-op `emit`, the generic token
    // delta is dropped by the messenger channel, and the slim finalize emits
    // no chat.message_complete. So the chat orchestrator's broadcast bus —
    // the webclient surface — sees nothing from a messenger turn this slice.
    expect(broadcast.emit).not.toHaveBeenCalled();
  });
});

describe('D-160 A.8 step 6 — PII boundary (D-163 owns_llm_egress, external-egress)', () => {
  // The pii-protect bookend runs over the SAME registry on every surface; its
  // plan's `active` flag is surface-driven: `chat` owns the LLM↔user boundary
  // (alias), a `messenger-*` surface is external-egress (pass real values).
  // This pins the documented step-6 boundary at the unit the chat lane owns —
  // `createChatStreamMiddlewares` + the surface flow through `runStream` —
  // without depending on the real nested AI-packet path.
  const planForSurface = async (surface: SurfaceTag) => {
    const streamRegistry = createMiddlewareRegistry();
    for (const mw of createChatStreamMiddlewares({
      pii: { ledgerStore: piiEgress.createSessionLedgerStore() },
      ...baseDeps,
    })) {
      streamRegistry.register(mw);
    }
    const sessionStore = createInMemorySessionStore();
    const state = new Map<string, unknown>();
    const inbound: ChannelInbound = {
      session_id: SESSION,
      surface,
      text: 'contact me',
      from: 'sender',
      source:
        surface === 'chat'
          ? { channel: 'chat', actor: 'user_self', chat_session_id: SESSION, user_id: 'u' }
          : { channel: 'messenger', actor: 'user_self', vendor: 'slack', from: 'sender' },
      dispatch_depth: 0,
      ts: NOW,
    };
    const executor: TurnExecutor = async () => ({ text: '' });
    await runStream({
      registry: streamRegistry,
      channel: recordingChannel(surface),
      sessionStore,
      inbound,
      runTurn: executor,
      state,
    });
    return readPiiEgressPlan(state);
  };

  it('is active on a chat surface (Recued owns the LLM↔user boundary)', async () => {
    const plan = await planForSurface('chat');
    expect(plan?.active).toBe(true);
  });

  it('is inactive on a messenger surface (external-egress — real values pass)', async () => {
    const plan = await planForSurface('messenger-slack');
    expect(plan?.active).toBe(false);
  });
});

describe('D-160 A.8 step 6 — robustness: no chat session required', () => {
  it('a messenger turn with no chat session defaults to local and still delivers', async () => {
    const { ack, sends } = await runMessengerTurn({
      createSession: false,
      aiResponse: 'no-session reply',
    });
    expect(typeof ack.turn_id).toBe('string');
    expect(sends).toEqual([
      { recipient: 'C-recipient', token: 'byo-token', text: 'no-session reply' },
    ]);
  });
});
