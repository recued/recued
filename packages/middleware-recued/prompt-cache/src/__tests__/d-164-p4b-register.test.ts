import { describe, expect, it, vi } from 'vitest';
import {
  createMiddlewareRegistry,
  type TurnContext,
} from '@recued/middleware';
import {
  FIRST_PARTY_MIDDLEWARES,
  registerFirstPartyMiddlewares,
} from '@recued/middleware-recued';

import {
  PROMPT_CACHE_MIDDLEWARE_ID,
  promptCacheMiddleware,
  registerPromptCacheMiddleware,
} from '../index';

const FIRST_PARTY_ENABLED_IDS = [
  'scope-search',
  'correction-learning',
  'confidence-shape',
  'personal-recipes',
] as const;

describe('D-164 P4b prompt-cache registration glue', () => {
  it('exports the literal prompt-cache middleware id', () => {
    expect(PROMPT_CACHE_MIDDLEWARE_ID).toBe('prompt-cache');
  });

  it('uses PROMPT_CACHE_MIDDLEWARE_ID as the middleware id', () => {
    expect(promptCacheMiddleware.id).toBe(PROMPT_CACHE_MIDDLEWARE_ID);
  });

  it('locks the lifecycle footprint to prompt only', () => {
    expect(promptCacheMiddleware.prompt).toEqual(expect.any(Function));
    expect(promptCacheMiddleware.config).toBeUndefined();
    expect(promptCacheMiddleware.update).toBeUndefined();
  });

  it('keeps the prompt hook a no-op on non-anaphoric input', async () => {
    const contribute = vi.fn();
    const resolve = vi.fn();
    const state = new Map<string, unknown>();
    const stateSet = vi.spyOn(state, 'set');
    const ctx = {
      history: [
        { session_id: 's', surface: 'chat', role: 'user', text: 'find Bob email', ts: 0 },
      ],
      prompt: {
        contribute,
        parts: () => [],
      },
      resolve,
      state,
    } as unknown as TurnContext;
    const prompt = promptCacheMiddleware.prompt;

    if (prompt === undefined) {
      throw new Error('promptCacheMiddleware.prompt must be registered');
    }

    await prompt(ctx);

    expect(contribute).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(stateSet).not.toHaveBeenCalled();
    expect(state.size).toBe(0);
  });

  it('registers prompt-cache enabled by default', () => {
    const registry = createMiddlewareRegistry();

    registerPromptCacheMiddleware(registry);

    expect(registry.has('prompt-cache')).toBe(true);
    expect(registry.isEnabled('prompt-cache')).toBe(true);
    expect(registry.enabled()).toEqual([promptCacheMiddleware]);
  });

  it('throws the registry duplicate-id error when registered twice', () => {
    const registry = createMiddlewareRegistry();

    registerPromptCacheMiddleware(registry);

    expect(() => registerPromptCacheMiddleware(registry)).toThrow(
      /^middleware registry: id 'prompt-cache' is already registered$/,
    );
  });

  it('composes after registerFirstPartyMiddlewares without colliding', () => {
    const registry = createMiddlewareRegistry();

    registerFirstPartyMiddlewares(registry);
    registerPromptCacheMiddleware(registry);

    expect(FIRST_PARTY_MIDDLEWARES.map((middleware) => middleware.id)).toEqual(
      FIRST_PARTY_ENABLED_IDS,
    );
    expect(registry.all().map((entry) => entry.middleware.id)).toHaveLength(5);
    expect(registry.all().map((entry) => entry.middleware.id)).toEqual([
      ...FIRST_PARTY_ENABLED_IDS,
      'prompt-cache',
    ]);
  });

  it('iterates the four enabled first-party adapters plus prompt-cache', () => {
    const registry = createMiddlewareRegistry();

    registerFirstPartyMiddlewares(registry);
    registerPromptCacheMiddleware(registry);

    expect(registry.enabled().map((middleware) => middleware.id)).toEqual([
      ...FIRST_PARTY_ENABLED_IDS,
      'prompt-cache',
    ]);
  });
});
