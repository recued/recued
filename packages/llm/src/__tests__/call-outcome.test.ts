/** How a source's calls end, kept beside it (`QuotaTracker.recordCallOutcome`), and the model that
 *  actually answered.
 *
 *  ⛔ Before (2026-11-16): a background call that failed left a line in a run log and nothing else,
 *  so a retired model could fail every unattended call for days unseen; a reply that ran out of room
 *  before answering was billed and counted nowhere; and a provider that answered with another model
 *  than the one asked for (Google routes `gemini-2.5-flash` to `gemini-3.5-flash-lite` from
 *  2026-12-01) went unrecorded, since Recued kept only the model it asked for.
 *
 *  These run the real executor and the real OpenAI adapter against a fake provider. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IngredientManifest, WebChatTab } from '@recued/contracts';

import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { createGoogleAdapter } from '../adapters/google.js';
import { createOpenAIAdapter } from '../adapters/openai.js';
import { answeredByAnotherModel } from '../call-outcome.js';
import { executeLLM } from '../executor.js';
import { createQuotaTracker } from '../quota.js';
import type { LLMSlot, TokenUsage } from '../types.js';

describe('a model that answered under another name, or another model', () => {
  it('is the same model under a dated or versioned name', () => {
    for (const [asked, answered] of [
      ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'],
      ['gemini-3.8-flash', 'gemini-3.8-flash'],
      ['gemini-3.8-flash', 'models/gemini-3.8-flash-001'],
      ['llama3.2', 'llama3.2:latest'],
      ['llama3.2', 'llama3.2:3b'],
      ['claude-3-5-sonnet', 'claude-3-5-sonnet@20241022'],
      ['gpt-4.1-mini-2025-04-14', 'gpt-4.1-mini'],
      ['GPT-4.1-mini', 'gpt-4.1-mini'],
    ]) expect([asked, answered, answeredByAnotherModel(asked!, answered!)]).toEqual([asked, answered, false]);
  });

  it('is another model when the name goes on as a word, not a version', () => {
    for (const [asked, answered] of [
      ['gemini-2.5-flash', 'gemini-3.5-flash-lite'],
      // ⚠ A prefix alone is not enough.
      ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
      ['gpt-4.1', 'gpt-4.1-mini'],
      ['gemini-flash-latest', 'gemini-3.8-flash'],
    ]) expect([asked, answered, answeredByAnotherModel(asked!, answered!)]).toEqual([asked, answered, true]);
  });
});

describe('each adapter records the model the provider says answered', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const answering = (body: unknown) => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body),
      { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  };
  const options = { model: 'asked-model', max_tokens: 100, timeout_ms: null };
  const message = [{ role: 'user' as const, content: 'hi' }];

  it('OpenAI and Anthropic by `model`, Gemini by `modelVersion`; model_id stays what was asked', async () => {
    answering({ model: 'gpt-4.1-mini-2025-04-14', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    const openai = await createOpenAIAdapter().complete({ provider: 'openai', model: 'x', api_key: 'k' }, message, options);
    answering({ model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    const anthropic = await createAnthropicAdapter().complete({ provider: 'anthropic', model: 'x', api_key: 'k' }, message, options);
    answering({ modelVersion: 'gemini-3.5-flash-lite', candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
    const google = await createGoogleAdapter().complete({ provider: 'google', model: 'x', api_key: 'k' }, message, options);
    expect([openai, anthropic, google].map((r) => [r.usage.model_id, r.usage.answered_model])).toEqual([
      ['asked-model', 'gpt-4.1-mini-2025-04-14'],
      ['asked-model', 'claude-sonnet-4-6'],
      ['asked-model', 'gemini-3.5-flash-lite'],
    ]);
  });

  it('records nothing when the provider names no model', async () => {
    answering({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    const result = await createOpenAIAdapter().complete({ provider: 'openai', model: 'x', api_key: 'k' }, message, options);
    expect(result.usage.answered_model).toBeUndefined();
  });
});

describe('a source\'s last call', () => {
  const manifest: IngredientManifest = { slug: 'ai-prompt', name: 'Prompt', description: '', author: 'recued', kind: 'ai',
    category: 'ai', risk_tier: 'read', input: {}, output: {} };
  const noTabs = async (): Promise<Set<WebChatTab>> => new Set();
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const provider = (status: number, body: unknown) => {
    globalThis.fetch = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  };
  const slot: LLMSlot = { provider: 'openai', model: 'gpt-4.1-mini', api_key: 'k' };
  const run = (quota = createQuotaTracker(), extra: Partial<Parameters<typeof executeLLM>[2]> = {}) =>
    executeLLM(manifest, { 'llm.prompt': 'q' }, { config: { slot_1: slot }, adapters: () => createOpenAIAdapter(), quota,
      tabProbe: noTabs, ...extra }).then(() => quota, () => quota);
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

  it('says it answered, with no swap for the same model under a dated name', async () => {
    provider(200, { model: 'gpt-4.1-mini-2025-04-14', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage });
    const last = (await run()).lastCall!('slot_1');
    expect(last).toMatchObject({ model: 'gpt-4.1-mini', result: 'answered' });
    expect(last?.answered_by).toBeUndefined();
    expect(typeof last?.at).toBe('number');
  });

  it('names the model that answered when it was another one', async () => {
    provider(200, { model: 'gpt-6-luna', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage });
    expect((await run()).lastCall!('slot_1')).toMatchObject({ result: 'answered', answered_by: 'gpt-6-luna' });
  });

  it('says how it failed, in Test connection\'s words', async () => {
    provider(404, '{"error":{"message":"The model `gpt-4.1-mini` does not exist or you do not have access to it."}}');
    expect((await run()).lastCall!('slot_1')?.result).toBe('model_missing');
    provider(401, '{"error":"bad key"}');
    expect((await run()).lastCall!('slot_1')?.result).toBe('auth');
  });

  it('says a reply ran out of room before answering, and counts what it spent', async () => {
    provider(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 900, completion_tokens: 4000, total_tokens: 4900, completion_tokens_details: { reasoning_tokens: 4000 } } });
    const metered: TokenUsage[] = [];
    const quota = await run(createQuotaTracker(), { onTokenUsage: (u) => metered.push(u) });
    expect(quota.lastCall!('slot_1')?.result).toBe('output_limit');
    expect(metered).toEqual([expect.objectContaining({ total_tokens: 4900, attribution: { kind: 'slot', slot_key: 'slot_1' } })]);
    expect(quota.tokensToday('slot_1')).toBe(4900);
  });

  it('keeps nothing when the call never reached the provider', async () => {
    provider(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage });
    const quota = await run(createQuotaTracker(), { beforeComplete: async () => { throw new Error('not reviewed'); } });
    expect(quota.lastCall!('slot_1')).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('outlives a restart: it rides the persisted snapshot, and is not reset at midnight', async () => {
    provider(404, '{"error":{"message":"The model `gpt-4.1-mini` does not exist."}}');
    const quota = await run();
    const restored = createQuotaTracker(JSON.parse(JSON.stringify(quota.snapshot())));
    expect(restored.lastCall!('slot_1')).toEqual(quota.lastCall!('slot_1'));
    // A later day's write clears the daily counters, and keeps the last call.
    restored.recordUsage('slot_2', 1, Date.parse('2099-01-01T00:00:00Z'));
    expect(restored.lastCall!('slot_1')?.result).toBe('model_missing');
  });
});
