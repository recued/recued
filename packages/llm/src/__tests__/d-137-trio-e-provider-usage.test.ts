/** D-137 Trio #E — provider-adapter usage extraction.
 *
 *  Each provider exposes a different shape for cache + reasoning
 *  telemetry. The adapter's `extractUsage` must:
 *    - always populate `input_tokens` / `output_tokens` / `total_tokens`
 *      (every provider response carries these);
 *    - populate `cache_read_input_tokens` when the provider echoes
 *      it (Anthropic / Gemini / OpenAI all do under different
 *      field names);
 *    - populate `cache_write_input_tokens` only for Anthropic (the
 *      sole provider that surfaces a cache-create surcharge per
 *      call);
 *    - populate `reasoning_tokens` for OpenAI o1 family + Gemini
 *      thinking models (Anthropic does NOT surface a separate
 *      count; thinking output rolls up into `output_tokens`);
 *    - stamp `model_id` from `slot.model` so report-time rollups
 *      can group per-model.
 *
 *  Absent fields must stay UNDEFINED on the report (not `0`) so
 *  consumers can distinguish "we don't know" from "measured zero". */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { createOpenAIAdapter } from '../adapters/openai.js';
import { createGoogleAdapter } from '../adapters/google.js';
import type { LLMMessage, LLMSlot } from '../types.js';

const messages: LLMMessage[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Hi' },
];
// Codex Trio #E P2 fold #1 — adapters record `options.model` (what
// was actually requested) not `slot.model` (the slot baseline), so
// the test exercises the seam where caller can override the model.
const options = { model: 'requested-model', max_tokens: 100, timeout_ms: 5000 };

const mockFetch = (response: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(response), {
    status,
    headers: { 'content-type': 'application/json' },
  }));

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Codex Trio #E P2 fold #1 — model_id records options.model not slot.model', () => {
  it('Anthropic records the per-call options.model, not slot.model', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const slot: LLMSlot = { provider: 'anthropic', model: 'slot-default', api_key: 'k' };
    const result = await createAnthropicAdapter().complete(
      slot,
      messages,
      { ...options, model: 'override-call' },
    );
    expect(result.usage.model_id).toBe('override-call');
  });

  it('OpenAI records the per-call options.model, not slot.model', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
    const slot: LLMSlot = { provider: 'openai', model: 'slot-default', api_key: 'k' };
    const result = await createOpenAIAdapter().complete(
      slot,
      messages,
      { ...options, model: 'override-call' },
    );
    expect(result.usage.model_id).toBe('override-call');
  });

  it('Google records the per-call options.model, not slot.model', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }));
    const slot: LLMSlot = { provider: 'google', model: 'slot-default', api_key: 'k' };
    const result = await createGoogleAdapter().complete(
      slot,
      messages,
      { ...options, model: 'override-call' },
    );
    expect(result.usage.model_id).toBe('override-call');
  });
});

describe('Anthropic adapter — Trio #E usage extraction', () => {
  const slot: LLMSlot = {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    api_key: 'sk-ant-test',
  };

  it('populates input/output/total + model_id when no cache hints present', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    }));
    const result = await createAnthropicAdapter().complete(slot, messages, options);
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(50);
    expect(result.usage.total_tokens).toBe(150);
    expect(result.usage.model_id).toBe('requested-model');
    expect(result.usage.cache_read_input_tokens).toBeUndefined();
    expect(result.usage.cache_write_input_tokens).toBeUndefined();
  });

  it('normalises cache_read into input_tokens (cache ⊂ input contract; Codex P2 fold #2)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 80,
        output_tokens: 50,
        cache_read_input_tokens: 200,
      },
    }));
    const result = await createAnthropicAdapter().complete(slot, messages, options);
    expect(result.usage.cache_read_input_tokens).toBe(200);
    // Anthropic API echoes input_tokens as non-cached only; the
    // adapter normalises to (non_cached + cache_read + cache_write).
    expect(result.usage.input_tokens).toBe(80 + 200);
    // Contract invariant: total = input + output (cache is a subset of input).
    expect(result.usage.total_tokens).toBe(80 + 200 + 50);
  });

  it('normalises cache_creation into input_tokens (Codex P2 fold #2)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 80,
        output_tokens: 50,
        cache_creation_input_tokens: 30,
      },
    }));
    const result = await createAnthropicAdapter().complete(slot, messages, options);
    expect(result.usage.cache_write_input_tokens).toBe(30);
    expect(result.usage.input_tokens).toBe(80 + 30);
    expect(result.usage.total_tokens).toBe(80 + 30 + 50);
  });

  it('normalises BOTH cache_read + cache_creation into input_tokens', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 80,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 30,
      },
    }));
    const result = await createAnthropicAdapter().complete(slot, messages, options);
    expect(result.usage.input_tokens).toBe(80 + 200 + 30);
    expect(result.usage.total_tokens).toBe(80 + 200 + 30 + 50);
  });

  it('leaves reasoning_tokens undefined (Anthropic rolls thinking into output)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    }));
    const result = await createAnthropicAdapter().complete(slot, messages, options);
    expect(result.usage.reasoning_tokens).toBeUndefined();
  });
});

describe('OpenAI adapter — Trio #E usage extraction', () => {
  const slot: LLMSlot = {
    provider: 'openai',
    model: 'gpt-4o-mini',
    api_key: 'sk-test',
  };

  it('populates input/output/total + model_id when no detail blocks present', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 },
    }));
    const result = await createOpenAIAdapter().complete(slot, messages, options);
    expect(result.usage.input_tokens).toBe(70);
    expect(result.usage.output_tokens).toBe(30);
    expect(result.usage.total_tokens).toBe(100);
    expect(result.usage.model_id).toBe('requested-model');
  });

  it('captures cache_read_input_tokens from prompt_tokens_details.cached_tokens', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      choices: [{ message: { content: 'hi' } }],
      usage: {
        prompt_tokens: 70,
        completion_tokens: 30,
        total_tokens: 100,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    }));
    const result = await createOpenAIAdapter().complete(slot, messages, options);
    expect(result.usage.cache_read_input_tokens).toBe(20);
  });

  it('captures reasoning_tokens from completion_tokens_details (o1 family)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      choices: [{ message: { content: 'hi' } }],
      usage: {
        prompt_tokens: 70,
        completion_tokens: 130,
        total_tokens: 200,
        completion_tokens_details: { reasoning_tokens: 100 },
      },
    }));
    const result = await createOpenAIAdapter().complete(slot, messages, options);
    expect(result.usage.reasoning_tokens).toBe(100);
    // completion_tokens includes reasoning; consumers subtract for non-thinking output
    expect(result.usage.output_tokens).toBe(130);
  });

  it('leaves cache_write_input_tokens undefined (OpenAI has no cache-create surcharge)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      choices: [{ message: { content: 'hi' } }],
      usage: {
        prompt_tokens: 70,
        completion_tokens: 30,
        total_tokens: 100,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    }));
    const result = await createOpenAIAdapter().complete(slot, messages, options);
    expect(result.usage.cache_write_input_tokens).toBeUndefined();
  });
});

describe('Google adapter — Trio #E usage extraction', () => {
  const slot: LLMSlot = {
    provider: 'google',
    model: 'gemini-2.5-pro',
    api_key: 'goog-test',
  };

  it('populates input/output/total + model_id when no cache / thinking', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: {
        promptTokenCount: 60,
        candidatesTokenCount: 40,
        totalTokenCount: 100,
      },
    }));
    const result = await createGoogleAdapter().complete(slot, messages, options);
    expect(result.usage.input_tokens).toBe(60);
    expect(result.usage.output_tokens).toBe(40);
    expect(result.usage.total_tokens).toBe(100);
    expect(result.usage.model_id).toBe('requested-model');
  });

  it('captures cache_read_input_tokens from cachedContentTokenCount', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: {
        promptTokenCount: 60,
        candidatesTokenCount: 40,
        totalTokenCount: 100,
        cachedContentTokenCount: 30,
      },
    }));
    const result = await createGoogleAdapter().complete(slot, messages, options);
    expect(result.usage.cache_read_input_tokens).toBe(30);
  });

  it('captures reasoning_tokens from thoughtsTokenCount (thinking models)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: {
        promptTokenCount: 60,
        candidatesTokenCount: 90,
        totalTokenCount: 150,
        thoughtsTokenCount: 50,
      },
    }));
    const result = await createGoogleAdapter().complete(slot, messages, options);
    expect(result.usage.reasoning_tokens).toBe(50);
  });

  it('leaves cache_write_input_tokens undefined (Gemini caches are pre-created)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: {
        promptTokenCount: 60,
        candidatesTokenCount: 40,
        totalTokenCount: 100,
        cachedContentTokenCount: 30,
      },
    }));
    const result = await createGoogleAdapter().complete(slot, messages, options);
    expect(result.usage.cache_write_input_tokens).toBeUndefined();
  });
});
