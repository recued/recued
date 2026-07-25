/** D-137 P1.4 / D-164 P6.3 — chat orchestrator main turn + tool loop
 *  wiring.
 *
 *  Acceptance per spec § A.6.1 + § Wire A + D-164 § P6.3:
 *    - runTurn invokes the wired `executeAiCall` closure and persists
 *      the resulting `AIOutput.response` as the assistant message
 *      content
 *    - emits a single chat.token_streamed delta carrying the full
 *      response (per-token streaming lives behind a streaming
 *      adapter contract added later)
 *    - drives the tool loop via dispatch.dispatchTool for each
 *      tool_call the AI emits
 *    - persists ChatToolCall provenance entries alongside the
 *      assistant message
 *    - falls back to the empty-assistant scaffold when no
 *      `executeAiCall` is wired (substrate stays reachable without an
 *      AI provider)
 *    - chat.token_streamed never fires when the assistant content is
 *      empty (the renderer's no-token-no-delta invariant)
 *    - chat tail is captured BEFORE the current user message is
 *      appended so the AI sees the conversation cleanly (no duplicate
 *      tail-last + user_message)
 *    - D-164 P6.3 — the closure shape is a single `executeAiCall` that
 *      returns `{ body, usage? }`; only one AI call fires per main
 *      turn.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  type AIOutput,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';
import {
  createChatOrchestrator,
  type BroadcastChatEvent,
  type ChatBroadcastEmitter,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
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

/** D-137 Trio #B / D-164 P6.3 — `mkExecuteAiCall` models the
 *  cooperative tool loop over the post-P6.3 `ExecuteChatAiCall`
 *  closure shape: the FIRST call returns the supplied AIOutput (which
 *  may carry tool_calls); SUBSEQUENT calls return a synthesis-only
 *  AIOutput (same response, no more tool_calls) so the loop terminates
 *  cleanly after one round. Tests that need a longer loop should
 *  construct an executor directly with a per-call counter; tests that
 *  only check "one round of dispatch + provenance" stay unchanged
 *  because the synthesis-on-second-call shape was implicit in the
 *  prior one-shot semantics. */
const mkExecuteAiCall = (output: AIOutput): ExecuteChatAiCall => {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      return { body: output };
    }
    const synthesis: AIOutput = {
      response: output.response,
      events: [],
      tool_calls: [],
    };
    return { body: synthesis };
  };
};

let db: Database.Database;
let store: ChatStore;
let captured: BroadcastChatEvent[];
let broadcast: ChatBroadcastEmitter;

const mintCounter = (): (() => string) => {
  let n = 0;
  return () => `id-${++n}`;
};

beforeEach(() => {
  db = new Database(':memory:');
  ensureChatSchema(db);
  store = createChatStore(db);
  captured = [];
  broadcast = { emit: (event) => captured.push(event) };
});

describe('D-137 P1.4 — main-turn executor wired', () => {
  it('persists AIOutput.response as assistant content + emits one token_streamed delta', async () => {
    const catalog = [mkTool('mail.search', 1, ['mail'])];
    const aiOutput: AIOutput = {
      response: 'Found 3 messages from Peter.',
      events: [],
      tool_calls: [],
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry(catalog),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall: mkExecuteAiCall(aiOutput),
    });
    store.createSession({ id: 'sess-1', now: 1000 });

    const ack = await orchestrator.runTurn({
      session_id: 'sess-1',
      message: 'find mail from Peter',
      picker_state: { current: 'self' },
    });

    expect(ack.turn_id).toBeDefined();

    const tokenStreamed = captured.find((e) => e.kind === 'chat.token_streamed');
    expect(tokenStreamed).toBeDefined();
    if (tokenStreamed && tokenStreamed.kind === 'chat.token_streamed') {
      expect(tokenStreamed.delta).toBe('Found 3 messages from Peter.');
    }

    const complete = captured.find((e) => e.kind === 'chat.message_complete');
    expect(complete).toBeDefined();
    if (complete && complete.kind === 'chat.message_complete') {
      // event.final is typed `unknown` on the wire envelope; the chat
      // channel populates it with a ChatMessage row.
      const final = complete.final as {
        content: string;
        role: string;
        tool_calls?: unknown;
      };
      expect(final.content).toBe('Found 3 messages from Peter.');
      expect(final.role).toBe('assistant');
      // No tool calls → no provenance entries.
      expect(final.tool_calls).toBeUndefined();
    }
  });

  it('drives tool loop for each tool_call + persists ChatToolCall provenance', async () => {
    let dispatched = 0;
    const catalog = [mkTool('mail.search', 1, ['mail'])];
    const dispatchImpl = async (
      name: string,
      _args: unknown,
      ctx: ChatDispatchContext,
    ): Promise<ChatDispatchResult> => {
      dispatched += 1;
      // Channel-isolation invariant guard.
      expect(ctx.channel).toBe('internal_function_call');
      expect(ctx.session_id).toBe('sess-2');
      expect(ctx.mcp_token_id).toBeUndefined();
      expect(name).toBe('mail.search');
      return { ok: true, result: { hits: ['m1', 'm2'] } };
    };
    const aiOutput: AIOutput = {
      response: 'Searched mail for you.',
      events: [],
      tool_calls: [
        { tool: 'mail.search', args: { query: 'Peter' } },
      ],
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry(catalog, dispatchImpl),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall: mkExecuteAiCall(aiOutput),
    });
    store.createSession({ id: 'sess-2', now: 1000 });

    await orchestrator.runTurn({
      session_id: 'sess-2',
      message: 'find peter',
      picker_state: { current: 'self' },
    });

    expect(dispatched).toBe(1);
    const started = captured.find((e) => e.kind === 'chat.tool_call_started');
    const completed = captured.find((e) => e.kind === 'chat.tool_call_completed');
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    if (completed && completed.kind === 'chat.tool_call_completed') {
      expect(completed.status).toBe('ok');
      expect(completed.tier).toBe(1);
    }

    const messages = await store.listMessages('sess-2');
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls).toBeDefined();
    expect(assistant?.tool_calls?.[0]?.tool_name).toBe('mail.search');
    expect(assistant?.tool_calls?.[0]?.status).toBe('ok');
  });

  it('records tool_call error status when dispatch returns ok: false', async () => {
    const catalog = [mkTool('mail.search', 1, ['mail'])];
    const dispatchImpl = async (): Promise<ChatDispatchResult> => ({
      ok: false,
      reason: 'not_implemented',
    });
    const aiOutput: AIOutput = {
      response: '',
      events: [],
      tool_calls: [
        { tool: 'mail.search', args: {} },
      ],
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry(catalog, dispatchImpl),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall: mkExecuteAiCall(aiOutput),
    });
    store.createSession({ id: 'sess-3', now: 1000 });

    await orchestrator.runTurn({
      session_id: 'sess-3',
      message: 'find mail',
      picker_state: { current: 'self' },
    });

    const messages = await store.listMessages('sess-3');
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls?.[0]?.status).toBe('error');
    expect(assistant?.tool_calls?.[0]?.reason).toBe('not_implemented');
  });

  it('retries an EMPTY AIOutput once with output_feedback, then fails loud (no silent empty turn)', async () => {
    // Pre-recovery behavior (pinned by this test's previous incarnation):
    // an empty AIOutput shipped a SILENT empty turn — no token_streamed.
    // The args-only recovery replaces that: one feedback retry, then the
    // fail-loud message. The counting executor returns empty BOTH times
    // (the observed live mode: qwen3.7-plus re-fumbling is the worst case).
    const catalog = [mkTool('mail.search', 1, ['mail'])];
    const emptyOutput: AIOutput = {
      response: '',
      events: [],
      tool_calls: [],
    };
    const promptBodies: string[] = [];
    let calls = 0;
    const countingExecuteAiCall: ExecuteChatAiCall = async (_manifest, input) => {
      calls += 1;
      promptBodies.push(String(input['llm.prompt'] ?? ''));
      return { body: emptyOutput };
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry(catalog),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall: countingExecuteAiCall,
    });
    store.createSession({ id: 'sess-4', now: 1000 });

    await orchestrator.runTurn({
      session_id: 'sess-4',
      message: 'do nothing',
      picker_state: { current: 'self' },
    });

    // Exactly ONE retry — bounded recovery, not a loop.
    expect(calls).toBe(2);
    // The initial packet carries no output_feedback; the retry packet does.
    expect(promptBodies[0]).not.toContain('"output_feedback"');
    expect(promptBodies[1]).toContain('"output_feedback"');
    expect(promptBodies[1]).toContain('an empty AIOutput');
    // The user sees the actionable message, not a silent empty turn.
    const tokenStreamed = captured.find((e) => e.kind === 'chat.token_streamed');
    expect(tokenStreamed).toBeDefined();
    expect((tokenStreamed as { delta?: string }).delta).toContain(
      'returned an empty reply twice',
    );
  });

  it('emits transparency engine.budget_exceeded on executeAiCall throw', async () => {
    const catalog = [mkTool('mail.search', 1, ['mail'])];
    const throwingExecutor: ExecuteChatAiCall = async () => {
      throw new Error('upstream 5xx');
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry(catalog),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall: throwingExecutor,
    });
    store.createSession({ id: 'sess-5', now: 1000 });

    await orchestrator.runTurn({
      session_id: 'sess-5',
      message: 'find mail',
      picker_state: { current: 'self' },
    });

    const transparencies = captured.filter((e) => e.kind === 'chat.transparency');
    const budgetExceeded = transparencies.find((e) => {
      if (e.kind !== 'chat.transparency') return false;
      return (e.event as { kind?: string }).kind === 'engine.budget_exceeded';
    });
    expect(budgetExceeded).toBeDefined();
    // Assistant message persisted with empty content (clean retry path).
    const messages = await store.listMessages('sess-5');
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('');
  });
});

describe('D-164 P6.3 — Codex review P2 folds', () => {
  it('chat tail is captured BEFORE the user message is appended (no duplication)', async () => {
    const catalog = [mkTool('mail.search', 1, ['mail'])];
    const captured_prompts: Array<string> = [];
    const captureExecutor: ExecuteChatAiCall = async (_manifest, input) => {
      captured_prompts.push(String(input['llm.prompt']));
      return {
        body: {
          response: 'ok',
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry(catalog),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall: captureExecutor,
    });
    store.createSession({ id: 'sess-tail', now: 1000 });

    // Seed two prior turns.
    await store.appendMessage({
      id: 'prev-1',
      session_id: 'sess-tail',
      role: 'user',
      content: 'prior question',
      target_server: 'self',
      picker_at_send: {
        display_name: 'Self',
        signature: selfSignature,
      },
      model_used: { provider: 'local', model_id: 'm' },
    });
    await store.appendMessage({
      id: 'prev-2',
      session_id: 'sess-tail',
      role: 'assistant',
      content: 'prior answer',
      target_server: 'self',
      picker_at_send: {
        display_name: 'Self',
        signature: selfSignature,
      },
      model_used: { provider: 'local', model_id: 'm' },
    });

    await orchestrator.runTurn({
      session_id: 'sess-tail',
      message: 'current question',
      picker_state: { current: 'self' },
    });

    // The main-turn prompt body carries chat_tail with EXACTLY the
    // prior 2 messages — not the current one (which surfaces as
    // `user_message` in the JSON body).
    expect(captured_prompts).toHaveLength(1);
    const parsed = JSON.parse(captured_prompts[0]!) as {
      chat_tail: Array<{ role: string; content: string }>;
      user_message: string;
    };
    expect(parsed.chat_tail).toHaveLength(2);
    expect(parsed.chat_tail[0]?.content).toBe('prior question');
    expect(parsed.chat_tail[1]?.content).toBe('prior answer');
    expect(parsed.user_message).toBe('current question');
    expect(parsed.chat_tail.find((m) => m.content === 'current question')).toBeUndefined();
  });
});

describe('D-164 P6.3 — No executeAiCall (substrate-reachable fallback)', () => {
  it('persists empty-assistant message when no executor wired', async () => {
    const catalog = [mkTool('mail.search', 1, ['mail'])];
    let dispatched = 0;
    const dispatchImpl = async (): Promise<ChatDispatchResult> => {
      dispatched += 1;
      return { ok: true, result: {} };
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: mkRegistry(catalog, dispatchImpl),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
    });
    store.createSession({ id: 'sess-8', now: 1000 });

    await orchestrator.runTurn({
      session_id: 'sess-8',
      message: 'no adapter',
      picker_state: { current: 'self' },
    });

    // P1.3 behaviour preserved when no main-turn executor wired.
    expect(dispatched).toBe(0);
    const tokenStreamed = captured.find((e) => e.kind === 'chat.token_streamed');
    expect(tokenStreamed).toBeUndefined();
    const messages = await store.listMessages('sess-8');
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('');
  });
});

describe('D-160 Stage 2 — runStream flip turn resilience', () => {
  it('completes the turn (one assistant row + one message_complete) when the post-append preload read throws', async () => {
    // The Stage 2 flip warms the cache-only session store via
    // `streamSessionStore.preload(session_id)` — a `chatStore.listMessages`
    // read that fires AFTER the user message is durably appended (1b).
    // That preload is best-effort: a transient read failure there MUST NOT
    // strand the committed user row with no assistant completion (a retry
    // would otherwise duplicate the user turn). buildChatTail's read (the
    // 1st listMessages call, BEFORE the user append) keeps its own
    // fail-open/rethrow handling; this guards the new post-append read.
    let listCalls = 0;
    const flaky: ChatStore = {
      ...store,
      listMessages: async (session_id: string) => {
        listCalls += 1;
        // 1st call = buildChatTail (pre-append) succeeds; 2nd call = the
        // post-append preload — simulate a transient history-read failure.
        if (listCalls === 2) {
          throw new Error('transient history read failure');
        }
        return store.listMessages(session_id);
      },
    };
    const orchestrator = createChatOrchestrator({
      chatStore: flaky,
      registry: mkRegistry([mkTool('mail.search', 1, ['mail'])]),
      broadcast,
      selfSignature,
      mintId: mintCounter(),
      executeAiCall: mkExecuteAiCall({
        response: 'Done.',
        events: [],
        tool_calls: [],
      }),
    });
    store.createSession({ id: 'sess-flaky', now: 1000 });

    await expect(
      orchestrator.runTurn({
        session_id: 'sess-flaky',
        message: 'hi',
        picker_state: { current: 'self' },
      }),
    ).resolves.toBeDefined();

    // The committed user row is NOT stranded — the turn completed with
    // exactly one assistant row and exactly one chat.message_complete.
    const messages = await store.listMessages('sess-flaky');
    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.content).toBe('Done.');
    const completes = captured.filter((e) => e.kind === 'chat.message_complete');
    expect(completes).toHaveLength(1);
  });
});
