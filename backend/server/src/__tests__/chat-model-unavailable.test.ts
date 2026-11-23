/** A chat whose model its provider does not have says so, in words the owner can act on.
 *
 *  ⛔ Before (2026-11-16), a retired model read "The AI provider failed before answering.", the
 *  same sentence as an outage, with no model named and nowhere to go, on every message. Recued
 *  keeps no list of models; the provider says it at call time (`gemini-2.5-flash`: 404 "no longer
 *  available to new users", two weeks before its shutdown date), and the turn passes that on: which
 *  model, from which provider, set where, and that Settings → AI / Models is where to choose
 *  another.
 *
 *  The model call goes through the real `executeLLM`, so the turn reads the error the executor
 *  actually builds, not one shaped here. */
import { describe, expect, it } from 'vitest';
import type { IngredientManifest, WebChatTab } from '@recued/contracts';
import { classifyProviderError, createOpenAIAdapter, createQuotaTracker, executeLLM } from '@recued/llm';
import type { LLMAdapter, LLMConfig } from '@recued/llm';
import { modelUnavailableMessage, OUTPUT_LIMIT_NO_ANSWER_MESSAGE, runChatTurn } from '../chat-turn-executor.js';

const baseInput = {
  session_id: 'retired-model',
  turn_id: 'retired-model-turn',
  picker_target: 'self' as const,
  dispatch_peer_name: null,
  available_tools: [],
  content: { chat_tail: [], user_message: 'what is on today?' },
  correction_context: [] as string[],
  model_layer: 'byok' as const,
};

const GOOGLE_RETIRED = '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash.","status":"NOT_FOUND"}}';

/** The chat's model call, as the server wires it: the real executor over `config`, whose provider
 *  answers every call with `status` and `body`. */
const callingProvider = (config: LLMConfig, status: number, body: string) => {
  const adapter: LLMAdapter = {
    provider: 'google',
    complete: async () => { throw classifyProviderError(status, body, null); },
  };
  const noTabs = async (): Promise<Set<WebChatTab>> => new Set();
  return async (manifest: IngredientManifest, input: Record<string, unknown>) => ({
    body: await executeLLM(manifest, input, { config, adapters: () => adapter, quota: createQuotaTracker(), tabProbe: noTabs }),
  });
};

const turn = async (config: LLMConfig, status: number, body: string) => {
  const events: Array<{ kind?: unknown; reason?: unknown }> = [];
  const result = await runChatTurn(baseInput, {
    executeAiCall: callingProvider(config, status, body),
    registry: undefined as never,
    dispatchTool: async () => ({ ok: true as const, result: {} }),
    emit: (event: { kind: string; event?: unknown }) => {
      if (event.kind === 'chat.transparency') events.push(event.event as { kind?: unknown });
    },
    now: () => 1_000,
  } as never);
  return { result, events };
};

describe('a chat whose model its provider does not have', () => {
  it('names the model, the provider and the slot, and where to choose another', async () => {
    const { result, events } = await turn(
      { slot_1: { provider: 'google', model: 'gemini-2.5-flash', api_key: 'AIza-secret' } }, 404, GOOGLE_RETIRED);
    expect(result.assistant_content).toBe('Google does not have the model "gemini-2.5-flash" (slot 1). It may have been '
      + 'retired or renamed, or the name may be mistyped. Choose another model in Settings → AI / Models.');
    expect(events).toContainEqual(expect.objectContaining({ kind: 'engine.decoder_unavailable', reason: 'model_unavailable' }));
    // Neither the key nor the provider's own words reach the owner's thread.
    expect(result.assistant_content).not.toContain('AIza');
    expect(result.assistant_content).not.toContain('new users');
  });

  it('calls a service by the owner\'s name for it, else by its host', async () => {
    const decommissioned = '{"error":{"message":"The model `llama3-70b-8192` has been decommissioned and is no longer supported."}}';
    const named = await turn({ slot_1: { provider: 'openai-compatible', provider_name: 'Groq', model: 'llama3-70b-8192',
      api_key: 'k', base_url: 'https://api.groq.com/openai/v1' } }, 400, decommissioned);
    expect(named.result.assistant_content).toMatch(/^Groq does not have the model "llama3-70b-8192" \(slot 1\)\./);
    const unnamed = await turn({ slot_1: { provider: 'openai-compatible', model: 'llama3-70b-8192',
      api_key: 'k', base_url: 'https://api.groq.com/openai/v1' } }, 400, decommissioned);
    expect(unnamed.result.assistant_content).toMatch(/^api\.groq\.com does not have the model/);
  });

  it('names the server an OpenAI source points at, not OpenAI', () => {
    const atGroq = { model: 'llama3-70b-8192', provider: 'openai' as const, host: 'api.groq.com',
      source: { kind: 'slot' as const, slot_key: 'slot_2' as const } };
    expect(modelUnavailableMessage(atGroq)).toMatch(/^api\.groq\.com does not have the model "llama3-70b-8192" \(slot 2\)\./);
    // With no address, an OpenAI-compatible source calls api.openai.com.
    expect(modelUnavailableMessage({ model: 'gpt-x', provider: 'openai-compatible', source: { kind: 'slot', slot_key: 'slot_1' } }))
      .toMatch(/^OpenAI does not have the model "gpt-x"/);
  });

  it('names a free-pool entry by its name', () => {
    expect(modelUnavailableMessage({ model: 'gemini-2.5-flash', provider: 'google',
      source: { kind: 'pool', entry_id: 'gemini-flash' } }))
      .toMatch(/^Google does not have the model "gemini-2\.5-flash" \(the free pool's "gemini-flash"\)\./);
  });

  it('says a model that spent its whole allowance before answering did that, and where its thinking is set', async () => {
    // As OpenAI's reasoning models end such a reply, through the real OpenAI adapter.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      model: 'gpt-6-luna', choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 900, completion_tokens: 4000, total_tokens: 4900, completion_tokens_details: { reasoning_tokens: 4000 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    try {
      const config: LLMConfig = { slot_1: { provider: 'openai', model: 'gpt-6-luna', api_key: 'k' } };
      const noTabs = async (): Promise<Set<WebChatTab>> => new Set();
      const quota = createQuotaTracker();
      const events: Array<{ kind?: unknown; reason?: unknown }> = [];
      const result = await runChatTurn(baseInput, {
        executeAiCall: async (manifest: IngredientManifest, input: Record<string, unknown>) => ({
          body: await executeLLM(manifest, input, { config, adapters: () => createOpenAIAdapter(), quota, tabProbe: noTabs }),
        }),
        registry: undefined as never,
        dispatchTool: async () => ({ ok: true as const, result: {} }),
        emit: (event: { kind: string; event?: unknown }) => {
          if (event.kind === 'chat.transparency') events.push(event.event as { kind?: unknown });
        },
        now: () => 1_000,
      } as never);
      expect(result.assistant_content).toBe(OUTPUT_LIMIT_NO_ANSWER_MESSAGE);
      expect(result.assistant_content).toContain('turn its thinking off in Settings → AI / Models');
      expect(events).toContainEqual(expect.objectContaining({ kind: 'engine.decoder_unavailable', reason: 'output_limit' }));
      // The provider billed those tokens; they count against the slot's day like an answer's.
      expect(quota.tokensToday('slot_1')).toBe(4900);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('leaves an outage an outage', async () => {
    const { result, events } = await turn(
      { slot_1: { provider: 'google', model: 'gemini-3.8-flash', api_key: 'k' } }, 400, '{"error":{"message":"bad thing"}}');
    expect(result.assistant_content).toBe('The AI provider failed before answering.');
    expect(events).toContainEqual(expect.objectContaining({ kind: 'engine.decoder_unavailable', reason: 'provider_failure' }));
  });
});
