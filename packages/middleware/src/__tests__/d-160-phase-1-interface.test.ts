/** D-160 P1 -- three-hook Middleware interface.
 *
 *  Spec: D-160 sections N.2 / A.1 and Must Hold I-5.
 */

import { describe, expect, it } from 'vitest';
import type {
  Middleware,
  StreamContext,
  TurnContext,
  TurnResult,
} from '@recued/middleware';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <
  T,
>() => T extends B ? 1 : 2
  ? true
  : false;

type HandlerKeys = Exclude<keyof Middleware, 'id'>;

const handlerKeysAreExactlyThree: Equal<
  HandlerKeys,
  'config' | 'prompt' | 'update'
> = true;

const idIsRequired: Middleware = { id: 'minimal' };

const cognitionLikeMiddleware = {
  id: 'cognition',
  config(ctx: StreamContext): void {
    ctx.state.set('cognition', { initialized: true });
  },
  prompt(ctx: TurnContext): void {
    ctx.prompt.contribute({
      role: 'context',
      text: `history entries: ${ctx.history.length}`,
    });
  },
  update(ctx: TurnResult): void {
    if (ctx.output.tool_calls && ctx.output.tool_calls.length > 0) {
      ctx.requestContinue();
    } else {
      ctx.signalDone();
    }
  },
} satisfies Middleware;

const fourthHookRejected: Middleware = {
  id: 'fourth-hook',
  config(): void {},
  prompt(): void {},
  update(): void {},
  // @ts-expect-error D-160 I-5 allows only config / prompt / update handlers.
  beforeTool(): void {},
};

describe('D-160 P1 Middleware interface', () => {
  it('has exactly config, prompt, and update handler keys plus id', () => {
    expect(handlerKeysAreExactlyThree).toBe(true);
  });

  it('allows a minimal id-only middleware because handlers are optional', () => {
    expect(idIsRequired.id).toBe('minimal');
  });

  it('accepts a real three-handler cognition-shaped object', () => {
    expect(cognitionLikeMiddleware.id).toBe('cognition');
    expect(typeof cognitionLikeMiddleware.config).toBe('function');
    expect(typeof cognitionLikeMiddleware.prompt).toBe('function');
    expect(typeof cognitionLikeMiddleware.update).toBe('function');
  });

  it('keeps the fourth-hook regression fixture compiled behind @ts-expect-error', () => {
    expect(fourthHookRejected.id).toBe('fourth-hook');
  });

  it('types config as the one-time stream lifecycle hook', () => {
    const config: NonNullable<Middleware['config']> = (ctx) => {
      ctx.state.set(ctx.session_id, ctx.capacity.max_turns);
    };

    expect(typeof config).toBe('function');
  });

  it('types prompt and update as per-turn lifecycle hooks', () => {
    const prompt: NonNullable<Middleware['prompt']> = (ctx) => {
      ctx.prompt.contribute({ role: 'system', text: ctx.turn_id });
    };
    const update: NonNullable<Middleware['update']> = (ctx) => {
      if (ctx.resolved_without_ai) ctx.signalDone();
    };

    expect(typeof prompt).toBe('function');
    expect(typeof update).toBe('function');
  });
});
