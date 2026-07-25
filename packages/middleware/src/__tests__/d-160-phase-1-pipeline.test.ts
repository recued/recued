/** D-160 P1 -- stream turn pipeline.
 *
 *  Spec: docs/d-160-spec.md sections N.2 / A.2 / N.3 / N.4 / A.4.
 */

import { describe, expect, it } from 'vitest';
import {
  createInMemorySessionStore,
  type Channel,
  type ChannelInbound,
  type ChannelOutbound,
  type SessionStateStore,
} from '@recued/chat';
import {
  createCapacity,
  createMiddlewareRegistry,
  runStream,
  type Middleware,
  type TurnExecutor,
  type TurnOutput,
} from '@recued/middleware';

type RecordingChannel = Channel & { readonly events: ChannelOutbound[] };

interface Harness {
  readonly store: SessionStateStore;
  readonly channel: RecordingChannel;
  readonly registry: ReturnType<typeof createMiddlewareRegistry>;
  readonly inbound: ChannelInbound;
  readonly mintId: () => string;
}

const chatSource = (session_id: string): ChannelInbound['source'] => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: session_id,
  user_id: 'user-1',
});

const inboundMessage = (
  session_id = 'session-1',
  text = 'hello',
): ChannelInbound => ({
  session_id,
  surface: 'chat',
  text,
  from: 'user-1',
  source: chatSource(session_id),
  // D-160 P3 — `0` = a top-level user message.
  dispatch_depth: 0,
  ts: 1716141000000,
});

const recordingChannel = (): RecordingChannel => {
  const events: ChannelOutbound[] = [];
  return {
    surface: 'chat',
    events,
    async deliver(event: ChannelOutbound): Promise<void> {
      events.push(event);
    },
    onInbound(): void {
      return undefined;
    },
  };
};

const createHarness = (text = 'hello'): Harness => {
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

const run = (
  h: Harness,
  runTurn: TurnExecutor,
  options: Partial<Parameters<typeof runStream>[0]> = {},
) =>
  runStream({
    registry: h.registry,
    channel: h.channel,
    sessionStore: h.store,
    inbound: h.inbound,
    runTurn,
    mintId: h.mintId,
    ...options,
  });

const output = (
  text: string,
  extra: Omit<TurnOutput, 'text'> = {},
): TurnOutput => ({ text, ...extra });

describe('D-160 P1 runStream basic turn loop', () => {
  it('with zero enabled middlewares runs exactly one turn and emits one message plus one done', async () => {
    const h = createHarness();
    let calls = 0;

    const summary = await run(h, async () => {
      calls += 1;
      return output('assistant answer');
    });

    expect(calls).toBe(1);
    expect(summary).toEqual({
      session_id: 'session-1',
      turns: 1,
      done_reason: 'completed',
      final_text: 'assistant answer',
      out_events: 2,
    });
    expect(h.channel.events).toEqual([
      {
        kind: 'message',
        session_id: 'session-1',
        turn_id: 'turn-0',
        text: 'assistant answer',
      },
      { kind: 'done', session_id: 'session-1', turn_id: 'turn-0' },
    ]);
  });

  it('passes session, surface, history, capacity, and interjections to runTurn', async () => {
    const h = createHarness('what changed?');

    await run(h, async (ctx) => {
      expect(ctx.session_id).toBe('session-1');
      expect(ctx.surface).toBe('chat');
      expect(ctx.turn_index).toBe(0);
      expect(ctx.turn_id).toBe('turn-0');
      expect(ctx.history).toEqual([
        {
          session_id: 'session-1',
          surface: 'chat',
          role: 'user',
          text: 'what changed?',
          ts: 1716141000000,
        },
      ]);
      expect(ctx.interjections).toEqual([]);
      expect(ctx.capacity.max_turns).toBeGreaterThan(0);
      expect(ctx.prompt.parts()).toEqual([]);
      return output('answer');
    });
  });

  it('runs config once pre-loop and prompt/update once per turn', async () => {
    const h = createHarness();
    const calls: string[] = [];
    h.registry.register({
      id: 'cadence',
      config(): void {
        calls.push('config');
      },
      prompt(ctx): void {
        calls.push(`prompt:${ctx.turn_index}`);
      },
      update(ctx): void {
        calls.push(`update:${ctx.turn_index}`);
        if (ctx.turn_index === 0) ctx.requestContinue();
      },
    });

    await run(h, async (ctx) => output(`answer ${ctx.turn_index}`));

    expect(calls).toEqual([
      'config',
      'prompt:0',
      'update:0',
      'prompt:1',
      'update:1',
    ]);
  });
});

describe('D-160 P1 runStream registry re-read cadence', () => {
  it('a middleware disabled during config stops running at the prompt hook', async () => {
    const h = createHarness();
    const calls: string[] = [];
    h.registry.register({
      id: 'first',
      config(): void {
        h.registry.disable('second');
      },
    });
    h.registry.register({
      id: 'second',
      config(): void {
        calls.push('second config');
      },
      prompt(): void {
        calls.push('second prompt');
      },
      update(): void {
        calls.push('second update');
      },
    });

    await run(h, async () => output('answer'));

    expect(calls).toEqual(['second config']);
  });

  it('a middleware disabled during prompt stops running at the update hook', async () => {
    const h = createHarness();
    const calls: string[] = [];
    h.registry.register({
      id: 'first',
      prompt(): void {
        h.registry.disable('second');
      },
    });
    h.registry.register({
      id: 'second',
      prompt(): void {
        calls.push('second prompt');
      },
      update(): void {
        calls.push('second update');
      },
    });

    await run(h, async () => output('answer'));

    expect(calls).toEqual(['second prompt']);
  });

  it('a middleware disabled during update stops running on the next turn', async () => {
    const h = createHarness();
    const calls: string[] = [];
    h.registry.register({
      id: 'driver',
      update(ctx): void {
        if (ctx.turn_index === 0) {
          ctx.requestContinue();
          h.registry.disable('second');
        }
      },
    });
    h.registry.register({
      id: 'second',
      prompt(ctx): void {
        calls.push(`second prompt:${ctx.turn_index}`);
      },
      update(ctx): void {
        calls.push(`second update:${ctx.turn_index}`);
      },
    });

    await run(h, async (ctx) => output(`answer ${ctx.turn_index}`));

    expect(calls).toEqual(['second prompt:0', 'second update:0']);
  });
});

describe('D-160 P1 runStream prompt short-circuit', () => {
  it('TurnContext.resolve skips the AI call', async () => {
    const h = createHarness();
    let runTurnCalls = 0;
    h.registry.register({
      id: 'resolver',
      prompt(ctx): void {
        ctx.resolve('resolved without ai');
      },
    });

    const summary = await run(h, async () => {
      runTurnCalls += 1;
      return output('should not run');
    });

    expect(runTurnCalls).toBe(0);
    expect(summary.final_text).toBe('resolved without ai');
  });

  it('TurnContext.resolve ends the before-turn phase for that turn', async () => {
    const h = createHarness();
    const calls: string[] = [];
    h.registry.register({
      id: 'resolver',
      prompt(ctx): void {
        calls.push('resolver');
        ctx.resolve('done');
      },
    });
    h.registry.register({
      id: 'late',
      prompt(): void {
        calls.push('late');
      },
    });

    await run(h, async () => output('should not run'));

    expect(calls).toEqual(['resolver']);
  });

  it('TurnResult.resolved_without_ai is true for a resolved turn', async () => {
    const h = createHarness();
    const flags: boolean[] = [];
    h.registry.register({
      id: 'resolver',
      prompt(ctx): void {
        ctx.resolve('done');
      },
      update(ctx): void {
        flags.push(ctx.resolved_without_ai);
      },
    });

    await run(h, async () => output('should not run'));

    expect(flags).toEqual([true]);
  });

  it('TurnResult.resolved_without_ai is false for an executor turn', async () => {
    const h = createHarness();
    const flags: boolean[] = [];
    h.registry.register({
      id: 'observer',
      update(ctx): void {
        flags.push(ctx.resolved_without_ai);
      },
    });

    await run(h, async () => output('executor answer'));

    expect(flags).toEqual([false]);
  });
});

describe('D-160 P1 runStream termination', () => {
  it('ends completed when no middleware requests another turn', async () => {
    const h = createHarness();
    h.registry.register({ id: 'observer', update(): void {} });

    const summary = await run(h, async () => output('answer'));

    expect(summary.turns).toBe(1);
    expect(summary.done_reason).toBe('completed');
  });

  it('signalDone beats requestContinue', async () => {
    const h = createHarness();
    h.registry.register({
      id: 'continue',
      update(ctx): void {
        ctx.requestContinue();
      },
    });
    h.registry.register({
      id: 'done',
      update(ctx): void {
        ctx.signalDone();
      },
    });

    const summary = await run(h, async () => output('answer'));

    expect(summary.turns).toBe(1);
    expect(summary.done_reason).toBe('completed');
  });

  it('requestContinue starts another turn when capacity remains', async () => {
    const h = createHarness();
    h.registry.register({
      id: 'driver',
      update(ctx): void {
        if (ctx.turn_index === 0) ctx.requestContinue();
      },
    });

    const summary = await run(h, async (ctx) => output(`answer ${ctx.turn_index}`), {
      capacity: { max_turns: 2 },
    });

    expect(summary.turns).toBe(2);
    expect(summary.done_reason).toBe('completed');
    expect(summary.final_text).toBe('answer 1');
  });

  it('ends capacity_exhausted when max_turns blocks the requested next turn', async () => {
    const h = createHarness();
    h.registry.register({
      id: 'driver',
      update(ctx): void {
        ctx.requestContinue();
      },
    });

    const summary = await run(h, async () => output('answer'), {
      capacity: { max_turns: 1 },
    });

    expect(summary.turns).toBe(1);
    expect(summary.done_reason).toBe('capacity_exhausted');
  });

  it('ends capacity_exhausted when token_ceiling blocks the requested next turn', async () => {
    const h = createHarness();
    h.registry.register({
      id: 'driver',
      update(ctx): void {
        ctx.requestContinue();
      },
    });

    const summary = await run(h, async () => output('answer', { tokens: 5 }), {
      capacity: { max_turns: 3, token_ceiling: 5 },
    });

    expect(summary.turns).toBe(1);
    expect(summary.done_reason).toBe('capacity_exhausted');
  });
});

describe('D-160 P1 runStream contexts', () => {
  it('clamps a config hook that widens or replaces streamCtx.capacity', async () => {
    const h = createHarness();
    const capacities: unknown[] = [];
    h.registry.register({
      id: 'widener',
      config(ctx): void {
        ctx.capacity = createCapacity({
          max_turns: 99,
          token_ceiling: 99,
          capabilities: ['mail', 'calendar'],
        });
      },
      prompt(ctx): void {
        capacities.push(ctx.capacity);
      },
      update(ctx): void {
        ctx.requestContinue();
      },
    });

    const summary = await run(h, async () => output('answer'), {
      capacity: {
        max_turns: 1,
        token_ceiling: 5,
        capabilities: ['mail'],
      },
    });

    expect(capacities).toEqual([
      { max_turns: 1, token_ceiling: 5, capabilities: ['mail'] },
    ]);
    expect(summary.done_reason).toBe('capacity_exhausted');
  });

  it('passes config-narrowed capacity to prompt and update hooks', async () => {
    const h = createHarness();
    const capacities: unknown[] = [];
    h.registry.register({
      id: 'narrower',
      config(ctx): void {
        ctx.capacity = createCapacity({
          max_turns: 2,
          token_ceiling: 50,
          capabilities: ['mail'],
        });
      },
      prompt(ctx): void {
        capacities.push({ hook: 'prompt', capacity: ctx.capacity });
      },
      update(ctx): void {
        capacities.push({ hook: 'update', capacity: ctx.capacity });
      },
    });

    await run(h, async () => output('answer'), {
      capacity: {
        max_turns: 4,
        token_ceiling: 100,
        capabilities: ['mail', 'calendar'],
      },
    });

    expect(capacities).toEqual([
      {
        hook: 'prompt',
        capacity: { max_turns: 2, token_ceiling: 50, capabilities: ['mail'] },
      },
      {
        hook: 'update',
        capacity: { max_turns: 2, token_ceiling: 50, capabilities: ['mail'] },
      },
    ]);
  });

  it('shares stream state across config, prompt, and update', async () => {
    const h = createHarness();
    const seen: unknown[] = [];
    h.registry.register({
      id: 'stateful',
      config(ctx): void {
        ctx.state.set('stateful', { count: 1 });
      },
      prompt(ctx): void {
        seen.push(ctx.state.get('stateful'));
      },
      update(ctx): void {
        seen.push(ctx.state.get('stateful'));
      },
    });

    await run(h, async () => output('answer'));

    expect(seen).toEqual([{ count: 1 }, { count: 1 }]);
  });

  it('stamps prompt contributions with the contributing middleware id', async () => {
    const h = createHarness();
    h.registry.register({
      id: 'first',
      prompt(ctx): void {
        ctx.prompt.contribute({ role: 'system', text: 'first rules' });
      },
    });
    h.registry.register({
      id: 'second',
      prompt(ctx): void {
        ctx.prompt.contribute({ role: 'context', text: 'second context' });
      },
    });

    await run(h, async (ctx) => {
      expect(ctx.prompt.parts()).toEqual([
        { source: 'first', role: 'system', text: 'first rules' },
        { source: 'second', role: 'context', text: 'second context' },
      ]);
      return output('answer');
    });
  });
});

describe('D-160 P1 runStream error path', () => {
  it('rethrows a runTurn failure after delivering a best-effort done', async () => {
    const h = createHarness();
    const failing: TurnExecutor = async () => {
      throw new Error('executor exploded');
    };

    await expect(run(h, failing)).rejects.toThrow('executor exploded');
    // The channel is not left half-open — a `done` is delivered before
    // the throw propagates, carrying the in-flight turn id.
    expect(h.channel.events).toEqual([
      { kind: 'done', session_id: 'session-1', turn_id: 'turn-0' },
    ]);
  });

  it('rethrows a config-hook failure after delivering a best-effort done', async () => {
    const h = createHarness();
    let runTurnCalls = 0;
    h.registry.register({
      id: 'broken',
      config(): void {
        throw new Error('config exploded');
      },
    });

    await expect(
      run(h, async () => {
        runTurnCalls += 1;
        return output('unreached');
      }),
    ).rejects.toThrow('config exploded');
    // The turn loop never started — no AI call — but the channel still
    // gets a terminal `done` (its turn id is freshly minted).
    expect(runTurnCalls).toBe(0);
    expect(h.channel.events.map((event) => event.kind)).toEqual(['done']);
  });

  it('rejects when a prompt hook calls resolve twice in one turn', async () => {
    const h = createHarness();
    h.registry.register({
      id: 'double-resolver',
      prompt(ctx): void {
        ctx.resolve('first');
        ctx.resolve('second');
      },
    });

    await expect(run(h, async () => output('unreached'))).rejects.toThrow(
      /resolve called twice/,
    );
  });
});
