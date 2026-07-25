/** D-160 P2 -- first-party middleware registration and runStream wiring. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createInMemorySessionStore,
  type Channel,
  type ChannelInbound,
  type ChannelOutbound,
  type SessionStateStore,
} from '@recued/chat';
import {
  createMiddlewareRegistry,
  runStream,
  type Middleware,
  type MiddlewareRegistry,
  type TurnContext,
  type TurnExecutor,
} from '@recued/middleware';

import {
  FIRST_PARTY_MIDDLEWARES,
  registerFirstPartyMiddlewares,
} from '../index.js';
import {
  CONFIDENCE_SHAPE_RESULT_STATE_KEY,
  confidenceShapeMiddleware,
} from '../confidence-shape/middleware.js';
import { correctionLearningMiddleware } from '../correction-learning/middleware.js';
import { personalRecipesMiddleware } from '../personal-recipes/middleware.js';
import { scopeSearchMiddleware } from '../scope-search/middleware.js';

type RecordingChannel = Channel & { readonly events: ChannelOutbound[] };

interface Harness {
  readonly store: SessionStateStore;
  readonly channel: RecordingChannel;
  readonly registry: MiddlewareRegistry;
  readonly inbound: ChannelInbound;
  readonly mintId: () => string;
}

const ENABLED_IDS = [
  'scope-search',
  'correction-learning',
  'confidence-shape',
  'personal-recipes',
] as const;

const INDEX_PATH = fileURLToPath(new URL('../index.ts', import.meta.url));
const COGNITION_DIR = fileURLToPath(new URL('../cognition/', import.meta.url));
const TWO_STAGE_DIR = fileURLToPath(new URL('../two-stage/', import.meta.url));

const chatSource = (session_id: string): ChannelInbound['source'] => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: session_id,
  user_id: 'user-1',
});

const inboundMessage = (
  session_id = 'session-1',
  text = 'please email Bob about travel',
): ChannelInbound => ({
  session_id,
  surface: 'chat',
  text,
  from: 'user-1',
  source: chatSource(session_id),
  // D-160 P3 — `0` = a top-level user message.
  dispatch_depth: 0,
  ts: 1_716_320_000_000,
});

const recordingChannel = (): RecordingChannel => {
  const events: ChannelOutbound[] = [];
  return {
    surface: 'chat',
    events,
    async deliver(event: ChannelOutbound): Promise<void> {
      events.push(event);
    },
    onInbound(): void {},
  };
};

const createHarness = (text = 'please email Bob about travel'): Harness => {
  const store = createInMemorySessionStore();
  const inbound = inboundMessage('session-1', text);
  store.append({
    session_id: inbound.session_id,
    surface: inbound.surface,
    role: 'user',
    text: inbound.text,
    ts: inbound.ts,
  });
  let nextTurn = 0;
  return {
    store,
    inbound,
    channel: recordingChannel(),
    registry: createMiddlewareRegistry(),
    mintId: () => `turn-${nextTurn++}`,
  };
};

const run = (h: Harness, runTurn: TurnExecutor) =>
  runStream({
    registry: h.registry,
    channel: h.channel,
    sessionStore: h.store,
    inbound: h.inbound,
    runTurn,
    mintId: h.mintId,
  });

const spyPrompt = (middleware: Middleware) =>
  vi.spyOn(
    middleware as { prompt: NonNullable<Middleware['prompt']> },
    'prompt',
  );

const spyUpdate = (middleware: Middleware) =>
  vi.spyOn(
    middleware as { update: NonNullable<Middleware['update']> },
    'update',
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('D-160 P2 registerFirstPartyMiddlewares', () => {
  it('pins FIRST_PARTY_MIDDLEWARES as the readonly four-adapter enabled tuple', () => {
    expect(FIRST_PARTY_MIDDLEWARES).toHaveLength(4);
    expect(FIRST_PARTY_MIDDLEWARES.map((mw) => mw.id)).toEqual(ENABLED_IDS);
  });

  it('registers exactly the four first-party adapters (D-164 P6d retired cognition; P6.5 retired two-stage)', () => {
    const registry = createMiddlewareRegistry();

    registerFirstPartyMiddlewares(registry);

    expect(registry.all().map((entry) => entry.middleware.id)).toEqual(ENABLED_IDS);
  });

  it('registers all four adapters enabled', () => {
    const registry = createMiddlewareRegistry();

    registerFirstPartyMiddlewares(registry);

    for (const id of ENABLED_IDS) {
      expect(registry.isEnabled(id)).toBe(true);
    }
  });

  it('enabled() order equals the FIRST_PARTY_MIDDLEWARES tuple order', () => {
    const registry = createMiddlewareRegistry();

    registerFirstPartyMiddlewares(registry);

    expect(registry.enabled().map((mw) => mw.id)).toEqual(
      FIRST_PARTY_MIDDLEWARES.map((mw) => mw.id),
    );
  });
});

describe('D-164 P6.5 two-stage substrate absent', () => {
  it('source-ratchet: index has no two-stage import', () => {
    const src = readFileSync(INDEX_PATH, 'utf8');

    expect(/^import\s+.*\s+from\s+['"]\.\/two-stage/m.test(src)).toBe(false);
  });

  it('source-ratchet: index has no two-stage namespace export', () => {
    const src = readFileSync(INDEX_PATH, 'utf8');

    expect(/^export\s+\*\s+as\s+twoStage\b/m.test(src)).toBe(false);
  });

  it('source-ratchet: index has no twoStageMiddleware symbol', () => {
    const src = readFileSync(INDEX_PATH, 'utf8');

    expect(/\btwoStageMiddleware\b/.test(src)).toBe(false);
  });

  it('keeps the retired two-stage directory absent', () => {
    expect(existsSync(TWO_STAGE_DIR)).toBe(false);
  });

  it('keeps FIRST_PARTY_MIDDLEWARES free of the retired two-stage id', () => {
    expect(FIRST_PARTY_MIDDLEWARES.some((mw) => mw.id === 'two-stage')).toBe(false);
  });

  it('registerFirstPartyMiddlewares does not register two-stage', () => {
    const registry = createMiddlewareRegistry();

    registerFirstPartyMiddlewares(registry);

    expect(
      registry.all().some((entry) => entry.middleware.id === 'two-stage'),
    ).toBe(false);
  });
});

describe('D-164 P6.5 prompt-cache supersession boundary', () => {
  it('keeps FIRST_PARTY_MIDDLEWARES free of the prompt-cache id (registered separately from `wire-chat-orchestrator.ts`)', () => {
    expect(FIRST_PARTY_MIDDLEWARES.some((mw) => mw.id === 'prompt-cache')).toBe(false);
  });

  it('source-ratchet: middleware-recued/src does not import @recued/middleware-prompt-cache (separation of concerns; cross-direction test lives in prompt-cache/src/__tests__)', () => {
    const src = readFileSync(INDEX_PATH, 'utf8');

    // Anchor on `from '@recued/middleware-prompt-cache'` so doc comments
    // that name the package (e.g., the supersession note in the file
    // banner) do not false-positive — only actual import/re-export
    // statements should fail this assertion.
    expect(
      /from\s+['"]@recued\/middleware-prompt-cache(?:\/[^'"]*)?['"]/.test(src),
    ).toBe(false);
  });
});

describe('D-164 P6d cognition substrate absent', () => {
  it('source-ratchet: index has no cognition import', () => {
    const src = readFileSync(INDEX_PATH, 'utf8');

    expect(/^import\s+.*\s+from\s+['"]\.\/cognition/m.test(src)).toBe(false);
  });

  it('source-ratchet: index has no cognition namespace export', () => {
    const src = readFileSync(INDEX_PATH, 'utf8');

    expect(/^export\s+\*\s+as\s+cognition\b/m.test(src)).toBe(false);
  });

  it('source-ratchet: index has no cognitionMiddleware symbol', () => {
    const src = readFileSync(INDEX_PATH, 'utf8');

    expect(/cognitionMiddleware/.test(src)).toBe(false);
  });

  it('source-ratchet: index has no COGNITION_MIDDLEWARE_DEFAULT_ENABLED symbol', () => {
    const src = readFileSync(INDEX_PATH, 'utf8');

    expect(/COGNITION_MIDDLEWARE_DEFAULT_ENABLED/.test(src)).toBe(false);
  });

  it('keeps the retired cognition directory absent', () => {
    expect(existsSync(COGNITION_DIR)).toBe(false);
  });

  it('keeps FIRST_PARTY_MIDDLEWARES free of the retired cognition id', () => {
    expect(FIRST_PARTY_MIDDLEWARES.some((mw) => mw.id === 'cognition')).toBe(false);
  });

  it('registerFirstPartyMiddlewares does not register cognition', () => {
    const registry = createMiddlewareRegistry();

    registerFirstPartyMiddlewares(registry);

    expect(
      registry.all().some((entry) => entry.middleware.id === 'cognition'),
    ).toBe(false);
  });
});

describe('D-160 P2 first-party runStream integration', () => {
  it('runs the four enabled hooks end-to-end', async () => {
    const scopeSearchPrompt = spyPrompt(scopeSearchMiddleware);
    const correctionPrompt = spyPrompt(correctionLearningMiddleware);
    const confidenceUpdate = spyUpdate(confidenceShapeMiddleware);
    const personalRecipesUpdate = spyUpdate(personalRecipesMiddleware);
    const h = createHarness();
    let capturedTurn: TurnContext | undefined;

    registerFirstPartyMiddlewares(h.registry);
    const summary = await run(h, async (ctx) => {
      capturedTurn = ctx;
      return { text: 'assistant answer' };
    });

    expect(summary).toMatchObject({
      session_id: 'session-1',
      turns: 1,
      done_reason: 'completed',
      final_text: 'assistant answer',
    });
    expect(scopeSearchPrompt).toHaveBeenCalledTimes(1);
    expect(correctionPrompt).toHaveBeenCalledTimes(1);
    expect(confidenceUpdate).toHaveBeenCalledTimes(1);
    expect(personalRecipesUpdate).toHaveBeenCalledTimes(1);

    expect(capturedTurn).toBeDefined();
    expect(capturedTurn?.state.get(CONFIDENCE_SHAPE_RESULT_STATE_KEY)).toEqual({
      pattern: 4,
      measures: {
        candidate_count: 0,
        top_score: null,
        top_margin: null,
        mean_score: null,
      },
    });
  });
});
