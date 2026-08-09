/** D-137 args-only AIOutput recovery — empty-output guards, prompt
 *  feedback placement, and orchestrator recovery paths.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  partitionPriorToolCalls,
  type AIOutput,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ChatPriorToolCall,
  type ChatTailMessage,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type TokenUsageReport,
  type ToolEntry,
} from '@recued/contracts';
import {
  createChatOrchestrator,
  type BroadcastChatEvent,
  type ChatBroadcastEmitter,
  type ChatMainTurnTool,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import {
  buildEmptyAiOutputFeedback,
  composeChatMainTurnPromptParts,
  isEmptyChatAiOutput,
} from '../chat-turn-executor.js';
import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

const emptyOutput: AIOutput = {
  response: '',
  events: [],
  tool_calls: [],
};

const mkTool = (
  name: string,
  tier: 1 | 2 | 3,
  tags: ReadonlyArray<string>,
): ToolEntry => ({
  name,
  tier,
  description: `desc for ${name}`,
  arg_schema: { type: 'object' },
  topic_tags: tags,
  classification: 'read',
  concurrency_safe: tier === 1,
});

const mkRegistry = (
  catalog: ReadonlyArray<ToolEntry>,
  dispatchImpl?: (name: string, args: unknown, ctx: ChatDispatchContext) => Promise<ChatDispatchResult>,
): InternalToolRegistry => ({
  list: () => catalog,
  listByTier: (tier) => catalog.filter((e) => e.tier === tier),
  getByName: (name) => catalog.find((e) => e.name === name) ?? null,
  dispatch: dispatchImpl
    ?? (async () => ({ ok: false, reason: 'not_implemented' })),
  subscribeRefresh: () => () => undefined,
});

const mintCounter = (): (() => string) => {
  let n = 0;
  return () => `id-${++n}`;
};

let db: Database.Database;
let store: ChatStore;
let captured: BroadcastChatEvent[];
let broadcast: ChatBroadcastEmitter;

beforeEach(() => {
  db = new Database(':memory:');
  ensureChatSchema(db);
  store = createChatStore(db);
  captured = [];
  broadcast = { emit: (event) => captured.push(event) };
});

const tool = (slug: string): ChatMainTurnTool => ({
  recipe_slug: slug,
  args_schema: { type: 'object', properties: { text: { type: 'string' } } },
  description: `desc for ${slug}`,
});

const priorCall = (tool_name: string): ChatPriorToolCall => ({
  tool_name,
  tier: 1,
  args: { query: tool_name },
  status: 'ok',
  result: { detail: tool_name },
  detail: tool_name,
  started_at: 0,
  completed_at: 1,
});

const TAIL: ChatTailMessage[] = [{ role: 'user', content: 'earlier' }];

interface Packet {
  readonly available_tools: ReadonlyArray<ChatMainTurnTool>;
  readonly content: { chat_tail: ReadonlyArray<ChatTailMessage>; user_message: string };
  readonly correction_context?: readonly string[];
  readonly prefetch_context?: readonly string[];
  readonly current_date?: string;
  readonly prior_tool_calls?: ReadonlyArray<ChatPriorToolCall>;
  readonly output_feedback?: string;
}

const legacyBody = (p: Packet): string => {
  const { prior, recall } = partitionPriorToolCalls(p.prior_tool_calls ?? []);
  return JSON.stringify({
    available_tools: p.available_tools,
    commitment_context: [] as const,
    ...(p.correction_context && p.correction_context.length > 0
      ? { correction_context: p.correction_context }
      : {}),
    ...(p.prefetch_context && p.prefetch_context.length > 0
      ? { prefetch_context: p.prefetch_context }
      : {}),
    chat_tail: p.content.chat_tail,
    ...(p.current_date ? { current_date: p.current_date } : {}),
    user_message: p.content.user_message,
    ...(recall.length > 0 ? { recall_context: recall } : {}),
    ...(prior.length > 0 ? { prior_tool_calls: prior } : {}),
    ...(p.output_feedback ? { output_feedback: p.output_feedback } : {}),
  });
};

const tailJson = (p: Packet): string => {
  const { prior, recall } = partitionPriorToolCalls(p.prior_tool_calls ?? []);
  return JSON.stringify({
    ...(p.correction_context && p.correction_context.length > 0
      ? { correction_context: p.correction_context }
      : {}),
    ...(p.prefetch_context && p.prefetch_context.length > 0
      ? { prefetch_context: p.prefetch_context }
      : {}),
    chat_tail: p.content.chat_tail,
    ...(p.current_date ? { current_date: p.current_date } : {}),
    user_message: p.content.user_message,
    ...(recall.length > 0 ? { recall_context: recall } : {}),
    ...(prior.length > 0 ? { prior_tool_calls: prior } : {}),
    ...(p.output_feedback ? { output_feedback: p.output_feedback } : {}),
  });
};

const parsePrompt = (promptBody: string): Record<string, unknown> =>
  JSON.parse(promptBody) as Record<string, unknown>;

const tokenUsage = (
  input_tokens: number,
  output_tokens: number,
  /** Provider calls the aggregate covers. Omitted when building an INPUT
   *  report (a single provider result carries no count of its own); passed
   *  when asserting an AGGREGATE, where the count is part of the contract. */
  provider_calls?: number,
): TokenUsageReport => ({
  input_tokens,
  output_tokens,
  total_tokens: input_tokens + output_tokens,
  ...(provider_calls !== undefined ? { provider_calls } : {}),
});

describe('isEmptyChatAiOutput', () => {
  it('classifies fully-empty output as empty', () => {
    expect(isEmptyChatAiOutput(emptyOutput)).toBe(true);
  });

  it('classifies whitespace-only response with no events or tools as empty', () => {
    expect(isEmptyChatAiOutput({
      response: ' \n\t',
      events: [],
      tool_calls: [],
    })).toBe(true);
  });

  it('does not classify events-only output as empty', () => {
    expect(isEmptyChatAiOutput({
      response: '',
      events: [{ kind: 'extraction.test', payload: { id: 'evt-1' } }],
      tool_calls: [],
    } as unknown as AIOutput)).toBe(false);
  });

  it('does not classify tool-calls-only output as empty', () => {
    expect(isEmptyChatAiOutput({
      response: '',
      events: [],
      tool_calls: [{ tool: 'mail.search', args: { query: 'Peter' } }],
    })).toBe(false);
  });

  it('does not classify response-only output as empty', () => {
    expect(isEmptyChatAiOutput({
      response: 'Done.',
      events: [],
      tool_calls: [],
    })).toBe(false);
  });
});

describe('buildEmptyAiOutputFeedback', () => {
  it('names stray keys without echoing stray values', () => {
    const output = {
      response: '',
      events: [],
      tool_calls: [],
      query: 'x',
      limit: 1,
      source: 'Northwind',
    } as unknown as AIOutput;

    const feedback = buildEmptyAiOutputFeedback(output);

    expect(feedback).toContain('"query"');
    expect(feedback).toContain('"limit"');
    expect(feedback).not.toContain('"x"');
    expect(feedback).not.toMatch(/\b1\b/);
    expect(feedback).not.toContain('Northwind');
  });

  it('describes pure-empty output as an empty AIOutput', () => {
    expect(buildEmptyAiOutputFeedback(emptyOutput)).toContain('empty AIOutput');
  });

  it('ends with tool-call or response re-emission instructions', () => {
    const feedback = buildEmptyAiOutputFeedback(emptyOutput);

    expect(feedback).toContain('tool_calls');
    expect(feedback).toContain('response');
    expect(feedback.endsWith('Emit AIOutput JSON only.')).toBe(true);
  });
});

describe('composeChatMainTurnPromptParts — output_feedback tail placement', () => {
  const basePacket: Packet = {
    available_tools: [tool('contact.search')],
    content: { chat_tail: TAIL, user_message: 'what is X?' },
    correction_context: ['be brief'],
    prefetch_context: ['verify: Alice'],
    current_date: 'Tuesday 2026-06-09 12:00 (UTC+00:00)',
    prior_tool_calls: [priorCall('contact.search')],
  };

  it('serializes output_feedback as the last key in the per-turn tail', () => {
    const packet: Packet = {
      ...basePacket,
      output_feedback: 'Your previous output was empty.',
    };
    const parts = composeChatMainTurnPromptParts(packet);
    const rawTail = `{${parts.body.slice(parts.cacheable_prefix.length + 1)}`;
    const tail = JSON.parse(rawTail) as Record<string, unknown>;

    expect(Object.keys(tail)).toEqual([
      'correction_context',
      'prefetch_context',
      'chat_tail',
      'current_date',
      'user_message',
      'prior_tool_calls',
      'output_feedback',
    ]);
    expect(tail.output_feedback).toBe('Your previous output was empty.');
  });

  it('omits output_feedback from the tail JSON when absent', () => {
    const parts = composeChatMainTurnPromptParts(basePacket);
    const rawTail = `{${parts.body.slice(parts.cacheable_prefix.length + 1)}`;
    const tail = JSON.parse(rawTail) as Record<string, unknown>;

    expect('output_feedback' in tail).toBe(false);
  });

  it('treats an empty output_feedback string as absent', () => {
    const parts = composeChatMainTurnPromptParts({
      ...basePacket,
      output_feedback: '',
    });
    const body = parsePrompt(parts.body);

    expect('output_feedback' in body).toBe(false);
  });

  it('keeps the cacheable prefix unchanged when output_feedback is present', () => {
    const withoutFeedback = composeChatMainTurnPromptParts(basePacket);
    const withFeedback = composeChatMainTurnPromptParts({
      ...basePacket,
      output_feedback: 'retry with AIOutput JSON',
    });

    expect(withFeedback.cacheable_prefix).toBe(withoutFeedback.cacheable_prefix);
    expect(withFeedback.cacheable_prefix).not.toContain('output_feedback');
  });

  it('keeps body as cacheable_prefix plus per-turn tail with output_feedback present', () => {
    const packet: Packet = {
      ...basePacket,
      output_feedback: 'retry with AIOutput JSON',
    };
    const parts = composeChatMainTurnPromptParts(packet);

    expect(parts.body.startsWith(parts.cacheable_prefix)).toBe(true);
    expect(parts.body).toBe(legacyBody(packet));
    expect(parts.body).toBe(`${parts.cacheable_prefix},${tailJson(packet).slice(1)}`);
  });

  it('keeps body byte-identical to the legacy packet when output_feedback is absent', () => {
    const parts = composeChatMainTurnPromptParts(basePacket);

    expect(parts.body).toBe(legacyBody(basePacket));
    expect(parts.body).toBe(`${parts.cacheable_prefix},${tailJson(basePacket).slice(1)}`);
  });
});

describe('D-137 args-only AIOutput recovery — orchestrator paths', () => {
  it('recovers an initial empty output when retry returns a response-only output', async () => {
    const catalog = [mkTool('mail.search', 1, ['mail'])];
    const outputs: AIOutput[] = [
      emptyOutput,
      { response: 'Recovered answer.', events: [], tool_calls: [] },
    ];
    const usages = [tokenUsage(10, 1), tokenUsage(20, 2)];
    const promptBodies: string[] = [];
    let calls = 0;
    const executeAiCall: ExecuteChatAiCall = async (_manifest, input) => {
      promptBodies.push(String(input['llm.prompt'] ?? ''));
      const body = outputs[calls]!;
      const usage = usages[calls]!;
      calls += 1;
      return { body, usage };
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry(catalog),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall,
    });
    store.createSession({ id: 'sess-recover-response', now: 1000 });

    const ack = await orchestrator.runTurn({
      session_id: 'sess-recover-response',
      message: 'answer directly',
      picker_state: { current: 'self' },
    });

    expect(calls).toBe(2);
    expect(promptBodies[0]).not.toContain('"output_feedback"');
    expect(promptBodies[1]).toContain('"output_feedback"');
    expect(parsePrompt(promptBodies[1]!).prior_tool_calls).toBeUndefined();
    const tokenStreamed = captured.find((e) => e.kind === 'chat.token_streamed');
    expect((tokenStreamed as { delta?: string } | undefined)?.delta).toBe('Recovered answer.');
    const messages = await store.listMessages('sess-recover-response');
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('Recovered answer.');
    // ⚠ `2` is checked against the FIXTURE — `usages` above holds two reports
    // (the initial call and the retry) — not pasted from the observed output.
    expect(ack.total_usage).toEqual(tokenUsage(30, 3, 2));
  });

  it('recovers an initial empty output when retry returns tool_calls, then synthesizes', async () => {
    let dispatched = 0;
    const catalog = [mkTool('mail.search', 1, ['mail'])];
    const dispatchImpl = async (
      name: string,
      _args: unknown,
      ctx: ChatDispatchContext,
    ): Promise<ChatDispatchResult> => {
      dispatched += 1;
      expect(ctx.channel).toBe('internal_function_call');
      expect(ctx.session_id).toBe('sess-recover-tools');
      expect(name).toBe('mail.search');
      return { ok: true, result: { hits: ['m1'] } };
    };
    const outputs: AIOutput[] = [
      emptyOutput,
      {
        response: '',
        events: [],
        tool_calls: [{ tool: 'mail.search', args: { query: 'Peter' } }],
      },
      {
        response: 'Found one message from Peter.',
        events: [],
        tool_calls: [],
      },
    ];
    let calls = 0;
    const executeAiCall: ExecuteChatAiCall = async () => {
      const body = outputs[calls]!;
      calls += 1;
      return { body };
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry(catalog, dispatchImpl),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall,
    });
    store.createSession({ id: 'sess-recover-tools', now: 1000 });

    await orchestrator.runTurn({
      session_id: 'sess-recover-tools',
      message: 'find peter',
      picker_state: { current: 'self' },
    });

    expect(calls).toBe(3);
    expect(dispatched).toBe(1);
    const tokenStreamed = captured.find((e) => e.kind === 'chat.token_streamed');
    expect((tokenStreamed as { delta?: string } | undefined)?.delta).toBe(
      'Found one message from Peter.',
    );
    const messages = await store.listMessages('sess-recover-tools');
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('Found one message from Peter.');
    expect(assistant?.tool_calls?.[0]?.tool_name).toBe('mail.search');
    expect(assistant?.tool_calls?.[0]?.status).toBe('ok');
  });

  it('ships the fail-loud message when the retry call throws', async () => {
    let calls = 0;
    const executeAiCall: ExecuteChatAiCall = async () => {
      calls += 1;
      if (calls === 1) {
        return { body: emptyOutput };
      }
      throw new Error('upstream 5xx');
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry([mkTool('mail.search', 1, ['mail'])]),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall,
    });
    store.createSession({ id: 'sess-retry-throws', now: 1000 });

    await expect(
      orchestrator.runTurn({
        session_id: 'sess-retry-throws',
        message: 'do something',
        picker_state: { current: 'self' },
      }),
    ).resolves.toBeDefined();

    expect(calls).toBe(2);
    const tokenStreamed = captured.find((e) => e.kind === 'chat.token_streamed');
    expect((tokenStreamed as { delta?: string } | undefined)?.delta).toContain(
      'returned an empty reply twice',
    );
    const messages = await store.listMessages('sess-retry-throws');
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toContain('returned an empty reply twice');
  });

  it('does not retry a non-empty initial response and sends no output_feedback', async () => {
    const promptBodies: string[] = [];
    let calls = 0;
    const executeAiCall: ExecuteChatAiCall = async (_manifest, input) => {
      calls += 1;
      promptBodies.push(String(input['llm.prompt'] ?? ''));
      return {
        body: {
          response: 'Already non-empty.',
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry([mkTool('mail.search', 1, ['mail'])]),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall,
    });
    store.createSession({ id: 'sess-no-retry', now: 1000 });

    await orchestrator.runTurn({
      session_id: 'sess-no-retry',
      message: 'say hi',
      picker_state: { current: 'self' },
    });

    expect(calls).toBe(1);
    expect(promptBodies).toHaveLength(1);
    expect('output_feedback' in parsePrompt(promptBodies[0]!)).toBe(false);
  });

  it('includes the recovery retry in loop-abort total_calls accounting', async () => {
    let dispatched = 0;
    let calls = 0;
    const dispatchImpl = async (): Promise<ChatDispatchResult> => {
      dispatched += 1;
      return { ok: true, result: { hits: ['m1'] } };
    };
    const executeAiCall: ExecuteChatAiCall = async () => {
      calls += 1;
      if (calls === 1) {
        return { body: emptyOutput };
      }
      if (calls === 2) {
        return {
          body: {
            response: '',
            events: [],
            tool_calls: [{ tool: 'mail.search', args: { query: 'Peter' } }],
          } satisfies AIOutput,
        };
      }
      throw new Error('loop reinvoke failed');
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry([mkTool('mail.search', 1, ['mail'])], dispatchImpl),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall,
    });
    store.createSession({ id: 'sess-total-calls', now: 1000 });

    await orchestrator.runTurn({
      session_id: 'sess-total-calls',
      message: 'find peter',
      picker_state: { current: 'self' },
    });

    expect(calls).toBe(3);
    expect(dispatched).toBe(1);
    const budgetExceeded = captured.find((e) => {
      if (e.kind !== 'chat.transparency') return false;
      return (e.event as { kind?: string }).kind === 'engine.budget_exceeded';
    });
    expect(budgetExceeded).toBeDefined();
    if (budgetExceeded?.kind === 'chat.transparency') {
      expect((budgetExceeded.event as { total_calls?: number }).total_calls).toBe(3);
    }
  });
});

describe('loop-final empty recovery', () => {
  type ScriptStep = AIOutput | Error;

  const toolOutput = (query: string): AIOutput => ({
    response: '',
    events: [],
    tool_calls: [{ tool: 'mail.search', args: { query } }],
  });

  const synthesisOutput = (response: string): AIOutput => ({
    response,
    events: [],
    tool_calls: [],
  });

  const runScriptedTurn = async (
    sessionId: string,
    script: ReadonlyArray<ScriptStep>,
  ): Promise<{
    readonly calls: number;
    readonly dispatches: number;
    readonly promptBodies: readonly string[];
    readonly assistant: Awaited<ReturnType<ChatStore['listMessages']>>[number] | undefined;
  }> => {
    const promptBodies: string[] = [];
    let calls = 0;
    let dispatches = 0;
    const executeAiCall: ExecuteChatAiCall = async (_manifest, input) => {
      promptBodies.push(String(input['llm.prompt'] ?? ''));
      const step = script[calls];
      calls += 1;
      if (step === undefined) {
        throw new Error(`missing scripted AI output at call ${calls}`);
      }
      if (step instanceof Error) {
        throw step;
      }
      return { body: step };
    };
    const dispatchImpl = async (
      name: string,
      args: unknown,
      ctx: ChatDispatchContext,
    ): Promise<ChatDispatchResult> => {
      dispatches += 1;
      expect(name).toBe('mail.search');
      expect(ctx.session_id).toBe(sessionId);
      return {
        ok: true,
        result: { hits: [`hit-${dispatches}`], args },
      };
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry([mkTool('mail.search', 1, ['mail'])], dispatchImpl),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall,
    });
    store.createSession({ id: sessionId, now: 1000 });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'find peter',
      picker_state: { current: 'self' },
    });

    const messages = await store.listMessages(sessionId);
    return {
      calls,
      dispatches,
      promptBodies,
      assistant: messages.find((m) => m.role === 'assistant'),
    };
  };

  const packetAt = (
    promptBodies: readonly string[],
    index: number,
  ): {
    readonly prior_tool_calls?: ReadonlyArray<ChatPriorToolCall>;
    readonly output_feedback?: string;
  } => parsePrompt(promptBodies[index]!) as {
    readonly prior_tool_calls?: ReadonlyArray<ChatPriorToolCall>;
    readonly output_feedback?: string;
  };

  const streamedDelta = (): string | undefined =>
    (captured.find((e) => e.kind === 'chat.token_streamed') as
      | { delta?: string }
      | undefined)?.delta;

  const budgetExceeded = (): { total_calls?: number } | undefined => {
    const event = captured.find((e) => {
      if (e.kind !== 'chat.transparency') return false;
      return (e.event as { kind?: string }).kind === 'engine.budget_exceeded';
    });
    return event?.kind === 'chat.transparency'
      ? event.event as { total_calls?: number }
      : undefined;
  };

  it('recovers an empty loop-final synthesis with one tool_loop feedback retry', async () => {
    const result = await runScriptedTurn('sess-loop-final-recover', [
      toolOutput('Peter'),
      emptyOutput,
      synthesisOutput('Found Peter.'),
    ]);

    expect(result.calls).toBe(3);
    expect(result.dispatches).toBe(1);
    expect(streamedDelta()).toBe('Found Peter.');
    expect(result.assistant?.content).toBe('Found Peter.');

    const first = packetAt(result.promptBodies, 0);
    const second = packetAt(result.promptBodies, 1);
    const third = packetAt(result.promptBodies, 2);
    expect(first.output_feedback).toBeUndefined();
    expect(second.output_feedback).toBeUndefined();
    expect(result.promptBodies[2]).toContain('"output_feedback"');
    expect(result.promptBodies[2]).toContain('"prior_tool_calls"');
    expect(third.output_feedback).toBeDefined();
    expect(third.output_feedback).toContain(
      'Your earlier tool calls and their results are in "prior_tool_calls"',
    );
    expect(third.output_feedback).toContain('synthesize your answer from them');
    expect(third.prior_tool_calls).toEqual(second.prior_tool_calls);
    expect(third.prior_tool_calls).toHaveLength(1);
  });

  it('ships the fail-loud message when loop-final synthesis decodes empty twice', async () => {
    const result = await runScriptedTurn('sess-loop-final-double-empty', [
      toolOutput('Peter'),
      emptyOutput,
      emptyOutput,
    ]);

    expect(result.calls).toBe(3);
    expect(result.dispatches).toBe(1);
    expect(streamedDelta()).toContain('returned an empty reply twice');
    expect(result.assistant?.content).toContain('returned an empty reply twice');
    expect(result.assistant?.tool_calls?.[0]).toMatchObject({
      tool_name: 'mail.search',
      status: 'ok',
    });
  });

  it('lets a loop-final retry return more tool calls and continue the loop', async () => {
    const result = await runScriptedTurn('sess-loop-final-continues', [
      toolOutput('first'),
      emptyOutput,
      toolOutput('second'),
      synthesisOutput('Found both.'),
    ]);

    expect(result.calls).toBe(4);
    expect(result.dispatches).toBe(2);
    expect(streamedDelta()).toBe('Found both.');
    expect(result.assistant?.content).toBe('Found both.');
  });

  it('keeps initial and loop-final empty recovery budgets separate', async () => {
    const result = await runScriptedTurn('sess-loop-final-two-sites', [
      emptyOutput,
      toolOutput('Peter'),
      emptyOutput,
      synthesisOutput('Recovered from both sites.'),
    ]);

    expect(result.calls).toBe(4);
    expect(result.dispatches).toBe(1);
    expect(streamedDelta()).toBe('Recovered from both sites.');
    expect(result.assistant?.content).toBe('Recovered from both sites.');

    const initialRetry = packetAt(result.promptBodies, 1);
    const loopRetry = packetAt(result.promptBodies, 3);
    expect(initialRetry.output_feedback).toContain('no tool ran');
    expect(initialRetry.output_feedback).not.toContain(
      'synthesize your answer from them',
    );
    expect(initialRetry.prior_tool_calls).toBeUndefined();
    expect(loopRetry.output_feedback).toContain(
      'Your earlier tool calls and their results are in "prior_tool_calls"',
    );
    expect(loopRetry.output_feedback).toContain('synthesize your answer from them');
    expect(loopRetry.output_feedback).not.toContain('no tool ran');
    expect(loopRetry.prior_tool_calls).toHaveLength(1);
  });

  it('does not retry a second loop-final empty after the loop recovery budget is consumed', async () => {
    const result = await runScriptedTurn('sess-loop-final-budget-consumed', [
      toolOutput('first'),
      emptyOutput,
      toolOutput('second'),
      emptyOutput,
    ]);

    expect(result.calls).toBe(4);
    expect(result.dispatches).toBe(2);
    expect(streamedDelta()).toContain('returned an empty reply twice');
    expect(result.assistant?.content).toContain('returned an empty reply twice');
  });

  it('ships the fail-loud message when the loop-final retry throws', async () => {
    await expect(
      runScriptedTurn('sess-loop-final-retry-throws', [
        toolOutput('Peter'),
        emptyOutput,
        new Error('retry failed'),
      ]),
    ).resolves.toMatchObject({
      calls: 3,
      dispatches: 1,
    });
    expect(streamedDelta()).toContain('returned an empty reply twice');
    const messages = await store.listMessages('sess-loop-final-retry-throws');
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toContain('returned an empty reply twice');
  });

  it('includes both recovery sites in loop-abort total_calls accounting', async () => {
    const result = await runScriptedTurn('sess-loop-final-total-calls', [
      emptyOutput,
      toolOutput('first'),
      emptyOutput,
      toolOutput('second'),
      new Error('loop reinvoke failed'),
    ]);

    expect(result.calls).toBe(5);
    expect(result.dispatches).toBe(2);
    expect(budgetExceeded()).toMatchObject({ total_calls: 5 });
  });

  it('builds site-specific empty-output feedback for initial and tool_loop sites', () => {
    const strayOutput = {
      response: '',
      events: [],
      tool_calls: [],
      query: 'Peter',
      limit: 1,
    } as unknown as AIOutput;

    const implicitInitial = buildEmptyAiOutputFeedback(strayOutput);
    const explicitInitial = buildEmptyAiOutputFeedback(strayOutput, 'initial');
    const toolLoop = buildEmptyAiOutputFeedback(strayOutput, 'tool_loop');

    expect(implicitInitial).toBe(explicitInitial);
    expect(explicitInitial).toContain('no tool ran');
    expect(explicitInitial).not.toContain('synthesize your answer from them');
    expect(toolLoop).toContain(
      'Your earlier tool calls and their results are in "prior_tool_calls"',
    );
    expect(toolLoop).toContain('synthesize your answer from them');
    expect(toolLoop).not.toContain('no tool ran');
    expect(explicitInitial.endsWith('Emit AIOutput JSON only.')).toBe(true);
    expect(toolLoop.endsWith('Emit AIOutput JSON only.')).toBe(true);
    for (const feedback of [explicitInitial, toolLoop]) {
      expect(feedback).toContain('"query"');
      expect(feedback).toContain('"limit"');
      expect(feedback).toContain('but no "tool_calls" and no "response"');
      expect(feedback).not.toContain('Peter');
      expect(feedback).not.toMatch(/\b1\b/);
    }
  });
});

describe('a tool call with NO NAME halts the turn instead of crashing it', () => {
  // ⛔ THE LIVE CRASH, post-wiring. Measured on qwen3.7-plus during
  // substrate-bench task 155: the model emitted a `tool_calls` entry with no
  // `tool` key. `validateAIOutput` only checked that `tool_calls` was an
  // ARRAY, so the entry passed the gate, reached `resolveConcurrencySafe` →
  // `registry.getByName(undefined)`, and threw inside
  // `topicOfEnrichmentToolName`'s `name.startsWith(...)` — killing the turn
  // ("turn failed after accept") and losing 2 of 34 roots at random.
  //
  // A unit assertion on `validateAIOutput` alone would not prove this fixed:
  // the issue has to actually REACH the failed-output branch and stop the
  // dispatch. That is why this runs the real orchestrator.
  it('never reaches tool dispatch, and never throws', async () => {
    const catalog = [mkTool('mail.search', 1, ['mail'])];
    const namelessCall = {
      response: '',
      events: [],
      // The exact shape observed: args, no name.
      tool_calls: [{ args: { query: 'Wren', limit: 5 } }],
    } as unknown as AIOutput;
    let calls = 0;
    const executeAiCall: ExecuteChatAiCall = async () => {
      calls += 1;
      return { body: namelessCall, usage: tokenUsage(10, 1) };
    };
    const dispatched: string[] = [];
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry(catalog, async (name) => {
        dispatched.push(name);
        return { ok: false, reason: 'not_implemented' };
      }),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall,
    });
    store.createSession({ id: 'sess-nameless-tool', now: 1000 });

    // The whole point: this used to throw out of runTurn.
    await expect(orchestrator.runTurn({
      session_id: 'sess-nameless-tool',
      message: 'email someone-else@bench.test the canary',
      picker_state: { current: 'self' },
    })).resolves.toBeDefined();

    // NON-VACUITY: the provider really was called, so the malformed output was
    // produced and travelled — this is not a test of a path never taken.
    expect(calls).toBeGreaterThan(0);
    // And the nameless call never became a dispatch.
    expect(dispatched).toEqual([]);
  });
});
