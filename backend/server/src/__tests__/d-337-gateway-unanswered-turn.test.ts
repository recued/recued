/** D-337 follow-up 33 — a gateway turn that produced no answer carries its cause.
 *
 *  Through the real orchestrator and chat turn (`runLlmGatewayTurn` → `runChatTurn`), the model
 *  call failing as the model layer fails it. Before, the turn threw one generic error and the
 *  gateway answered every cause with the same 502: the cause the turn recorded went out through
 *  `emit`, which the gateway's turn discards. The HTTP answer each cause gets is pinned in
 *  `llm-gateway-streaming.test.ts`. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AIOutput, InternalToolRegistry, RecuedServerSignature } from '@recued/contracts';
import { LLMError } from '@recued/llm';

import { createChatOrchestrator, type ExecuteChatAiCall } from '../chat-orchestrator.js';
import { ChatTurnUnansweredError } from '../chat-turn-executor.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const SELF: RecuedServerSignature = { server_kind: 'recued', version: '1.0.0', instance_id: 'd337-unanswered-turn' };
const RETRY_AT = 65_000;

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

/** What the gateway's turn throws when its model call fails as `executeAiCall` does. */
const gatewayTurnFailure = async (executeAiCall: ExecuteChatAiCall): Promise<unknown> => {
  const registry: InternalToolRegistry = {
    list: () => [],
    listByTier: () => [],
    getByName: () => null,
    dispatch: vi.fn(async () => ({ ok: true as const, result: {} })),
    subscribeRefresh: () => () => undefined,
  };
  const db = new Database(':memory:');
  dbs.push(db);
  ensureChatSchema(db);
  const orchestrator = createChatOrchestrator({
    chatStore: createChatStore(db), registry, selfSignature: SELF, now: () => 5_000, mintId: () => 'gateway-turn', executeAiCall,
  });
  return orchestrator.runLlmGatewayTurn!({
    session_id: 'gateway-session',
    user_id: 'customer-token',
    contract_id: 'customer-contract',
    content: { chat_tail: [], user_message: 'What can you do?' },
    allowed_tool_names: [],
    resolve_contract_snapshot: () => null,
    execute_ai_call: executeAiCall,
    model_layer: 'byok',
    model_hint: 'fast',
    model_source_id: 'slot_1',
  }).then(() => 'answered', (error: unknown) => error);
};

const throwing = (error: Error): ExecuteChatAiCall => vi.fn(async () => { throw error; });

describe('D-337 follow-up 33 — the gateway turn says why it produced no answer', () => {
  it('a source paused after a provider failure is a cooldown, with when it may be tried again', async () => {
    const failure = await gatewayTurnFailure(throwing(new LLMError('AI_LLM_UNAVAILABLE', 'No LLM source matches the request',
      { cooldown_sources: ['slot_1'], retry_at: RETRY_AT })));
    expect(failure).toBeInstanceOf(ChatTurnUnansweredError);
    expect(failure).toMatchObject({ reason: 'cooldown', retry_at: RETRY_AT });
  });

  it('no usable model is no_source', async () => {
    const failure = await gatewayTurnFailure(throwing(new LLMError('AI_LLM_UNAVAILABLE', 'No LLM source matches the request', { rejected: [] })));
    expect(failure).toMatchObject({ reason: 'no_source', retry_at: undefined });
  });

  it('a provider that failed is provider_failure, with its own retry time when it gave one', async () => {
    expect(await gatewayTurnFailure(throwing(new Error('upstream exploded'))))
      .toMatchObject({ reason: 'provider_failure', retry_at: undefined });
    expect(await gatewayTurnFailure(throwing(new LLMError('AI_LLM_UNAVAILABLE', 'rate limited', { status: 429, retry_at: RETRY_AT }))))
      .toMatchObject({ reason: 'provider_failure', retry_at: RETRY_AT });
  });

  it('an answer that cannot be read, after the turn\'s one guided retry, is invalid_output', async () => {
    const unreadable = { response: 7, events: 'none', tool_calls: 'none' } as unknown as AIOutput;
    const executeAiCall: ExecuteChatAiCall = vi.fn(async () => ({ body: unreadable }));
    const failure = await gatewayTurnFailure(executeAiCall);
    expect(failure).toMatchObject({ reason: 'invalid_output' });
    expect(executeAiCall).toHaveBeenCalledTimes(2);
  });
});
