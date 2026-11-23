/** A model its provider does not have — retired, renamed or mistyped — fails a call with what failed
 *  named on the error (`details.model_unavailable`): the model, the provider as the owner knows it,
 *  and where the owner set it. Recued keeps no list of models; the provider says so at call time, and
 *  whatever shows the failure can then send the owner to choose another. Before, the same failure
 *  read "The AI provider failed before answering.", like an outage. */
import { describe, expect, it, vi } from 'vitest';
import type { IngredientManifest, WebChatTab } from '@recued/contracts';

import { classifyProviderError } from '../adapters/anthropic.js';
import { executeLLM } from '../executor.js';
import { createQuotaTracker } from '../quota.js';
import { LLMError } from '../types.js';
import type { LLMAdapter, LLMConfig, LLMSlot } from '../types.js';

const manifest: IngredientManifest = { slug: 'ai-prompt', name: 'Prompt', description: '', author: 'recued', kind: 'ai',
  category: 'ai', risk_tier: 'read', input: {}, output: {} };
const noTabs = async (): Promise<Set<WebChatTab>> => new Set();

/** An adapter whose provider answers every call with `status` and `body`. */
const refusing = (status: number, body: string) => {
  const tried: string[] = [];
  const adapter: LLMAdapter = {
    provider: 'openai-compatible',
    complete: vi.fn(async (slot: LLMSlot) => {
      tried.push(slot.model);
      throw classifyProviderError(status, body, null);
    }),
  };
  return { adapter, tried };
};
const failure = async (config: LLMConfig, adapter: LLMAdapter): Promise<LLMError> => {
  const error = await executeLLM(manifest, { 'llm.prompt': 'q' },
    { config, adapters: () => adapter, quota: createQuotaTracker(), tabProbe: noTabs }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(LLMError);
  return error as LLMError;
};

const GOOGLE_RETIRED = '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users.","status":"NOT_FOUND"}}';
const GROQ_DECOMMISSIONED = '{"error":{"message":"The model `llama3-70b-8192` has been decommissioned and is no longer supported.","code":"model_decommissioned"}}';

describe('a model its provider does not have', () => {
  it('names the model, its provider and the slot it was set in, and no key', async () => {
    const { adapter } = refusing(404, GOOGLE_RETIRED);
    const error = await failure({ slot_1: { provider: 'google', model: 'gemini-2.5-flash', api_key: 'AIza-secret' } }, adapter);
    expect(error.details?.model_unavailable).toEqual({
      model: 'gemini-2.5-flash', provider: 'google', source: { kind: 'slot', slot_key: 'slot_1' } });
    // The provider's own answer is kept as it was, for the log.
    expect(error.details?.status).toBe(404);
    expect(JSON.stringify(error.details)).not.toContain('AIza-secret');
  });

  it('names the owner\'s name for the service, and only the host of its address', async () => {
    const { adapter } = refusing(400, GROQ_DECOMMISSIONED);
    const error = await failure({ slot_1: { provider: 'openai-compatible', provider_name: 'Groq', model: 'llama3-70b-8192',
      api_key: 'gsk_secret', base_url: 'https://api.groq.com/openai/v1?token=abc' } }, adapter);
    expect(error.details?.model_unavailable).toEqual({ model: 'llama3-70b-8192', provider: 'openai-compatible',
      provider_name: 'Groq', host: 'api.groq.com', source: { kind: 'slot', slot_key: 'slot_1' } });
    expect(JSON.stringify(error.details?.model_unavailable)).not.toContain('token=abc');
  });

  it('names a free-pool entry by its name', async () => {
    const { adapter } = refusing(404, GOOGLE_RETIRED);
    const error = await failure({ slot_1: null, free_pool: [{ id: 'gemini-flash', type: 'api', provider: 'google',
      model: 'gemini-2.5-flash', api_key: 'k', speed: 'fast', supports_json: true, enabled: true }] } as unknown as LLMConfig, adapter);
    expect(error.details?.model_unavailable).toMatchObject({ source: { kind: 'pool', entry_id: 'gemini-flash' } });
  });

  it('tries nothing in its place: the owner chose that model', async () => {
    // The free pool is tried first; its model is gone, and slot 1 could have answered.
    const { adapter, tried } = refusing(404, GOOGLE_RETIRED);
    await failure({
      slot_1: { provider: 'google', model: 'gemini-3.8-flash', api_key: 'k' },
      free_pool: [{ id: 'gemini-flash', type: 'api', provider: 'google', model: 'gemini-2.5-flash', api_key: 'k',
        speed: 'fast', supports_json: true, enabled: true }],
    } as unknown as LLMConfig, adapter);
    expect(tried).toEqual(['gemini-2.5-flash']);
  });

  it('leaves every other failure as it was', async () => {
    const { adapter } = refusing(400, '{"error":{"message":"bad thing"}}');
    const error = await failure({ slot_1: { provider: 'google', model: 'gemini-3.8-flash', api_key: 'k' } }, adapter);
    expect(error.details?.model_unavailable).toBeUndefined();
  });
});
