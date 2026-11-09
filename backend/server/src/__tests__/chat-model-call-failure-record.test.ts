/** D-347 follow-up (2026-11-08) — why a model call failed is kept: logged at every site, carried on the
 *  turn's result and written on its audit row, while the saved answer still says only that the provider
 *  failed. A head-to-head run ended "The AI provider failed before answering." and nothing recorded why:
 *  only the tool loop's reinvoke logged its error. Through the REAL orchestrator and chat store, the
 *  model a stub. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { LLMError } from '@recued/llm';

import { createChatOrchestrator } from '../chat-orchestrator.js';
import { failureDetailForRecord, isFastNetworkFailure, NETWORK_RETRY_FAST_MS } from '../chat-turn-executor.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const tool = (name: string): ToolEntry => ({ name, tier: 1, description: `${name} for the test.`,
  arg_schema: { type: 'object', properties: {}, additionalProperties: false }, topic_tags: ['fixture'],
  concurrency_safe: true, classification: 'read' });

describe('failureDetailForRecord', () => {
  it('keeps the error on one line, without an address query, a bearer token or a key', () => {
    const kept = failureDetailForRecord('LLM server error (503): {"error":"overloaded"}\n'
      + '  at https://api.example.com/v1beta/models/x:generate?key=AIzaSyA-not-a-real-key-123456#part'
      + ' with Bearer abc.def.ghi and sk-proj-ABCDEFGH12345678 and gsk_ABCDEFGHIJ1234567890');
    expect(kept).toBe('LLM server error (503): {"error":"overloaded"} at https://api.example.com/v1beta/models/x:generate'
      + ' with Bearer [redacted] and sk-[redacted] and gsk_[redacted]');
  });

  it('leaves words that only contain a key prefix, and caps the length at 300', () => {
    expect(failureDetailForRecord('the task-1234567890 and risk-assessment-12345678 are words'))
      .toBe('the task-1234567890 and risk-assessment-12345678 are words');
    expect(failureDetailForRecord(`LLM call failed: ${'x'.repeat(1000)}`)).toHaveLength(300);
  });
});

describe('a failed model call, recorded beside the turn', () => {
  let db: InstanceType<typeof Database>;
  let warnings: string[];
  let rows: Array<{ action: string; target: string; detail?: string }>;
  beforeEach(() => {
    db = new Database(':memory:');
    warnings = [];
    rows = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  const orchestratorWith = (executeAiCall: (input: Record<string, unknown>) => Promise<unknown>) => {
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 's1' });
    const catalog = [tool('fixture.read')];
    const registry: InternalToolRegistry = { list: () => catalog, listByTier: () => catalog,
      getByName: (name) => catalog.find((t) => t.name === name) ?? null, subscribeRefresh: () => () => {},
      dispatch: async (name) => ({ ok: true, result: { from: name } }) };
    const orchestrator = createChatOrchestrator({ chatStore: store, registry,
      selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'local' }, broadcast: { emit: () => {} },
      auditLog: { logActivity: async (row: { action: string; target: string; detail?: string }) => { rows.push(row); } } as never,
      executeAiCall: async (_manifest, input) => await executeAiCall(input as Record<string, unknown>) as never });
    return { store, orchestrator };
  };
  /** The assistant's `chat_message_sent` row, parsed. */
  const assistantRow = (): Record<string, unknown> => {
    const row = rows.find((r) => r.action === 'chat_message_sent' && r.detail?.includes('"role":"assistant"'));
    expect(row).toBeDefined();
    return JSON.parse(row!.detail!) as Record<string, unknown>;
  };
  const failureLines = () => warnings.filter((w) => w.includes('[chat] model call failed'));

  it('a first call that fails: logged with the turn, on the audit row, and not in the answer', async () => {
    const { store, orchestrator } = orchestratorWith(async () => {
      throw new Error('LLM server error (503): upstream overloaded');
    });
    const ack = await orchestrator.runTurn({ session_id: 's1', message: 'Look it up.', picker_state: { current: 'self' } } as never);
    expect(failureLines()).toEqual([
      `[chat] model call failed — turn ${ack.turn_id}, initial, reason provider_failure: LLM server error (503): upstream overloaded`,
    ]);
    expect(assistantRow().model_call_failed).toEqual({ reason: 'provider_failure', site: 'initial',
      detail: 'LLM server error (503): upstream overloaded' });
    const answer = (await store.listMessages('s1')).find((m) => m.role === 'assistant');
    expect(answer?.content).toBe('The AI provider failed before answering.');
  });

  it('a reinvoke that fails in the tool loop: logged once, with its round', async () => {
    let calls = 0;
    const { orchestrator } = orchestratorWith(async () => {
      calls += 1;
      if (calls === 1) return { body: { response: '', events: [], tool_calls: [{ tool: 'fixture.read', args: {} }] } };
      throw new Error('LLM call timed out after 120000ms');
    });
    const ack = await orchestrator.runTurn({ session_id: 's1', message: 'Read it.', picker_state: { current: 'self' } } as never);
    const lines = failureLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^\\[chat\\] model call failed — turn ${ack.turn_id}, tool_loop round \\d+, `
      + 'reason provider_failure: LLM call timed out after 120000ms$'));
    expect(warnings.filter((w) => w.includes('reinvoke FAILED'))).toEqual([]);
    expect(assistantRow().model_call_failed).toEqual({ reason: 'provider_failure', site: 'tool_loop',
      detail: 'LLM call timed out after 120000ms' });
  });

  it('a turn whose calls all answered records no failure', async () => {
    const { orchestrator } = orchestratorWith(async () => ({ body: { response: 'Done.', events: [], tool_calls: [] } }));
    await orchestrator.runTurn({ session_id: 's1', message: 'Hello.', picker_state: { current: 'self' } } as never);
    expect(failureLines()).toEqual([]);
    expect(assistantRow()).not.toHaveProperty('model_call_failed');
  });

  // D-347 follow-up (2026-11-08) — a call that failed fast before any answer came back is tried once more
  // after a second; one with an answer (a 5xx), a timeout and anything else end the turn as before.
  const network = () => new LLMError('AI_LLM_UNAVAILABLE', 'LLM call failed: fetch failed (UND_ERR_SOCKET: other side closed)');
  const retryLines = () => warnings.filter((w) => w.includes('trying once more'));

  it('a network failure, then an answer: the turn answers, and the line says it was tried again', async () => {
    let calls = 0;
    const { store, orchestrator } = orchestratorWith(async () => {
      calls += 1;
      if (calls === 1) throw network();
      return { body: { response: 'Done.', events: [], tool_calls: [] } };
    });
    const ack = await orchestrator.runTurn({ session_id: 's1', message: 'Hello.', picker_state: { current: 'self' } } as never);
    expect(calls).toBe(2);
    expect((await store.listMessages('s1')).find((m) => m.role === 'assistant')?.content).toBe('Done.');
    expect(retryLines()).toEqual([`[chat] model call failed before any answer, trying once more — turn ${ack.turn_id}: `
      + 'LLM call failed: fetch failed (UND_ERR_SOCKET: other side closed)']);
    expect(failureLines().filter((w) => !w.includes('trying once more'))).toEqual([]);
    expect(assistantRow()).not.toHaveProperty('model_call_failed');
  });

  it('a network failure twice: tried once more only, and the turn fails as before', async () => {
    let calls = 0;
    const { store, orchestrator } = orchestratorWith(async () => { calls += 1; throw network(); });
    await orchestrator.runTurn({ session_id: 's1', message: 'Hello.', picker_state: { current: 'self' } } as never);
    expect(calls).toBe(2);
    expect(retryLines()).toHaveLength(1);
    expect((await store.listMessages('s1')).find((m) => m.role === 'assistant')?.content).toBe('The AI provider failed before answering.');
    expect(assistantRow().model_call_failed).toMatchObject({ reason: 'provider_failure', site: 'initial',
      detail: 'LLM call failed: fetch failed (UND_ERR_SOCKET: other side closed)' });
  });

  it.each([
    ['a 5xx, which pauses the source', () => new LLMError('AI_LLM_UNAVAILABLE', 'LLM server error (503): busy', { status: 503 }, true)],
    ['a timeout', () => new LLMError('AI_TIMEOUT', 'LLM call timed out after 120000ms')],
    ['an error not from the provider layer', () => new Error('upstream 5xx')],
  ])('%s is not tried again', async (_name, failure) => {
    let calls = 0;
    const { orchestrator } = orchestratorWith(async () => { calls += 1; throw failure(); });
    await orchestrator.runTurn({ session_id: 's1', message: 'Hello.', picker_state: { current: 'self' } } as never);
    expect(calls).toBe(1);
    expect(retryLines()).toEqual([]);
  });

  it('a network failure that took longer than a fast one is not tried again', () => {
    expect(isFastNetworkFailure(network(), NETWORK_RETRY_FAST_MS)).toBe(true);
    expect(isFastNetworkFailure(network(), NETWORK_RETRY_FAST_MS + 1)).toBe(false);
  });
});
