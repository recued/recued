/** D-164 P10 — deterministic prompt-cache read permission gate.
 *
 *  Pins the boundary that made prompt-cache safe to widen beyond chat:
 *  the surface scope IS the read-permission boundary. The short-circuit
 *  probes bypass per-token-gated tools and read the local warehouse directly,
 *  so every widened surface must first pass the same policy-cell judgment as
 *  an equivalent storage-read dispatch. A deny, ask, unknown surface, or
 *  throwing store defers to the normal LLM path; only an admitted cell may
 *  render warehouse data inline. The messenger e2e asserts that this seam,
 *  not the surface tag by itself, is what fires the deterministic answer.
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
  type AIOutput,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ScanFn,
} from '@recued/contracts';
import { createMiddlewareRegistry, type MiddlewareRegistry } from '@recued/middleware';
import {
  registerPromptCacheMiddleware,
  type GateDeps,
  type PrefetchDeps,
} from '@recued/middleware-prompt-cache';
import { registerFirstPartyMiddlewares } from '@recued/middleware-recued';

import {
  createPromptCacheGateDeps,
  createShortCircuitReadAuthorization,
} from '../chat-prompt-cache-gate.js';
import {
  createChatOrchestrator,
  type ChatTurnAck,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import type { ContactStore } from '../storage/contact-store.js';

const NOW = Date.UTC(2030, 0, 15, 12, 0, 0);
const SESSION = 'sess-p10';

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

const contactStore = (): ContactStore =>
  ({
    list: () => [{ email: 'pat@x.com', name: 'Pat Lee' }],
    addressSet: (email: string) => [email],
  }) as unknown as ContactStore;

const noopPrefetch: PrefetchDeps = { search: () => [] };

const firstPartyRegistryWithPromptCache = (deps: GateDeps): MiddlewareRegistry => {
  const registry = createMiddlewareRegistry();
  registerFirstPartyMiddlewares(registry);
  registerPromptCacheMiddleware(registry, deps, noopPrefetch);
  return registry;
};

// D-187 — the retired matrix contributes no row. D-211 may still return one
// actorless exact-operation owner default from this same scan seam.
const ignoredScan: ScanFn = () => [];
const globalHoldScan: ScanFn = (scope, prefix) =>
  scope === 'owner_operation'
    && prefix.join('/') === 'recued/prompt-cache-short-circuit-read/recued/prompt-cache-short-circuit-read'
    ? [{
        segments: [
          'recued/prompt-cache-short-circuit-read',
          'recued/prompt-cache-short-circuit-read',
        ],
        value: { approval: 'always' },
      }]
    : [];

interface CapturedSend {
  recipient: string;
  token: string;
  text: string;
}

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

interface MessengerHarness {
  ack: ChatTurnAck;
  sends: CapturedSend[];
  executeAiCall: ReturnType<typeof vi.fn>;
}

const runMessengerTurn = async (opts: {
  gateDeps: GateDeps;
  aiResponse?: string;
}): Promise<MessengerHarness> => {
  const db = new Database(':memory:');
  try {
    ensureChatSchema(db);
    const chatStore = createChatStore(db);
    chatStore.createSession({ id: SESSION, now: NOW - 1_000 });
    const executeAiCall = vi.fn<ExecuteChatAiCall>(async () => ({
      body: {
        response: opts.aiResponse ?? 'sentinel model path',
        events: [],
        tool_calls: [],
      } satisfies AIOutput,
    }));
    const orchestrator = createChatOrchestrator({
      chatStore,
      registry: internalRegistry(),
      broadcast: { emit: vi.fn() },
      selfSignature,
      executeAiCall,
      middlewareRegistry: firstPartyRegistryWithPromptCache(opts.gateDeps),
      now: () => NOW,
    });

    const sessionStore = createInMemorySessionStore();
    const { channel, sends } = fakeMessengerChannel({
      vendor: 'slack',
      sessionStore,
      token: 'byo-token',
      recipient: 'C-recipient',
      sessionId: SESSION,
      parsedText: "what is Pat Lee's email address?",
      now: () => NOW,
    });

    let turnPromise: Promise<ChatTurnAck> | undefined;
    channel.onInbound((inbound) => {
      turnPromise = orchestrator.runMessengerTurn({ channel, sessionStore, inbound });
    });
    await channel.ingest({ vendor: 'slack' });
    const ack = await turnPromise!;
    return { ack, sends, executeAiCall };
  } finally {
    db.close();
  }
};

describe('D-164 P10 createShortCircuitReadAuthorization unit pins', () => {
  it.each([
    ['chat'],
    ['messenger-slack'],
    ['messenger-telegram'],
  ] as const)('admits the seeded baseline %s surface', (surface) => {
    expect(createShortCircuitReadAuthorization()(surface)).toBe(true);
  });

  it('fails closed on an unknown surface string', () => {
    expect(createShortCircuitReadAuthorization()('voice-call' as never)).toBe(false);
  });

  it('fails the deterministic short-circuit closed when global owner defaults cannot be read', () => {
    const authorize = createShortCircuitReadAuthorization(() => {
      throw new Error('contract store unavailable');
    });
    expect(authorize('messenger-slack')).toBe(false);
  });

  it('D-187: a legacy messenger policy cell no longer denies owner reads', () => {
    // D-187 slice 4 — the matrix is retired; the seam authorizes an unrestricted user_self
    // read by op-risk (read → never → admit), so a retired matrix cell cannot lock
    // down the owner's own reads. D-211's separate global exact-op row is covered
    // below. The empty scan here shows the retired cell contributes nothing.
    const authorize = createShortCircuitReadAuthorization(() => ignoredScan);

    expect(authorize('messenger-slack')).toBe(true);
    expect(authorize('chat')).toBe(true);
  });

  it('applies the same global owner approval to chat and messenger short-circuit reads', () => {
    const authorize = createShortCircuitReadAuthorization(() => globalHoldScan);

    expect(authorize('chat')).toBe(false);
    expect(authorize('messenger-slack')).toBe(false);
    expect(authorize('messenger-telegram')).toBe(false);
  });

  it('always attaches the deps-level authorizer instead of relying on chat-only fallback', () => {
    const deps = createPromptCacheGateDeps(() => undefined, () => undefined);
    const authorize = deps.authorizeShortCircuitRead;

    expect(authorize).toBeDefined();
    if (!authorize) throw new Error('authorizeShortCircuitRead was not attached');
    expect(authorize('chat')).toBe(true);
    expect(authorize('messenger-slack')).toBe(true);
  });
});

describe('D-164 P10 messenger prompt-cache gate through the real orchestrator', () => {
  it('short-circuits a messenger contact read without calling the model', async () => {
    const gateDeps = createPromptCacheGateDeps(
      contactStore,
      () => undefined,
      undefined,
      undefined,
      undefined,
    );
    const { ack, sends, executeAiCall } = await runMessengerTurn({ gateDeps });

    expect(typeof ack.turn_id).toBe('string');
    expect(sends.map((s) => s.text)).toContain("Pat Lee's email address is pat@x.com.");
    expect(executeAiCall).not.toHaveBeenCalled();
  });

  it('falls through to the model when the authorization seam denies the read', async () => {
    const gateDeps = {
      ...createPromptCacheGateDeps(
        contactStore,
        () => undefined,
        undefined,
        undefined,
        undefined,
      ),
      authorizeShortCircuitRead: () => false,
    };
    const { sends, executeAiCall } = await runMessengerTurn({
      gateDeps,
      aiResponse: 'sentinel model path',
    });

    expect(executeAiCall).toHaveBeenCalledTimes(1);
    expect(sends.map((s) => s.text)).toEqual(['sentinel model path']);
  });
});
