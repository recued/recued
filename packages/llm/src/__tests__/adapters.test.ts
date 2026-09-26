import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAnthropicAdapter,
  classifyProviderError,
  parseRetryAfter,
} from '../adapters/anthropic.js';
import { createOpenAIAdapter } from '../adapters/openai.js';
import { createGoogleAdapter } from '../adapters/google.js';
import { createDefaultRegistry } from '../adapters/index.js';
import { LLMError } from '../types.js';
import type { LLMMessage, LLMSlot } from '../types.js';

const messages: LLMMessage[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Hi' },
];

const options = { model: 'test-model', max_tokens: 100, timeout_ms: 5000 };

// Helper: install a fake fetch that records calls and returns a provided response.
const mockFetch = (response: unknown, status = 200) => {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } }),
  );
};

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Anthropic adapter', () => {
  const slot: LLMSlot = {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    api_key: 'sk-ant-test',
  };

  it('posts to /v1/messages with x-api-key header', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      content: [{ type: 'text', text: 'Hello!' }],
    }));

    const adapter = createAnthropicAdapter();
    const result = await adapter.complete(slot, messages, options);
    expect(result.text).toBe('Hello!');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init as RequestInit).headers).toMatchObject({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    });
  });

  it('splits system message into separate field', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ content: [{ type: 'text', text: 'ok' }] }));
    await createAnthropicAdapter().complete(slot, messages, options);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.system).toBe('You are helpful.');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
  });

  it('enables thinking when options.thinking=true', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ content: [{ type: 'text', text: 'ok' }] }));
    await createAnthropicAdapter().complete(slot, messages, { ...options, thinking: true });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 50 });
  });

  it('concatenates multi-block text responses', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'thinking', text: '(internal)' },
        { type: 'text', text: 'world!' },
      ],
    }));
    const result = await createAnthropicAdapter().complete(slot, messages, options);
    expect(result.text).toBe('Hello world!');
  });

  it('maps max_tokens to finish_reason length', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      content: [{ type: 'text', text: 'partial' }],
      stop_reason: 'max_tokens',
    }));
    const result = await createAnthropicAdapter().complete(slot, messages, options);
    expect(result.finish_reason).toBe('length');
  });

  it('preserves a textless provider refusal as content_filter', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      content: [],
      stop_reason: 'refusal',
    }));
    const result = await createAnthropicAdapter().complete(slot, messages, options);
    expect(result).toMatchObject({ text: '', finish_reason: 'content_filter' });
  });

  it('throws AI_RESPONSE_PARSE_FAILED when content missing', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ weird: 'response' }));
    await expect(createAnthropicAdapter().complete(slot, messages, options))
      .rejects.toThrow(LLMError);
  });

  it('throws AI_TIMEOUT on abort', async () => {
    fetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    await expect(
      createAnthropicAdapter().complete(slot, messages, { ...options, timeout_ms: 10 }),
    ).rejects.toThrow(/timed out/);
  });

  it('maps 401 to auth error', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ error: 'bad key' }, 401));
    try {
      await createAnthropicAdapter().complete(slot, messages, options);
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LLMError);
      expect((e as LLMError).code).toBe('AI_LLM_UNAVAILABLE');
      expect((e as LLMError).message).toContain('401');
    }
  });

  it('maps 429 to unavailable', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ error: 'too fast' }, 429));
    try {
      await createAnthropicAdapter().complete(slot, messages, options);
    } catch (e) {
      expect((e as LLMError).code).toBe('AI_LLM_UNAVAILABLE');
      expect((e as LLMError).message).toContain('429');
    }
  });

  it('respects base_url override', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ content: [{ type: 'text', text: 'x' }] }));
    const customSlot: LLMSlot = { ...slot, base_url: 'https://proxy.example.com/' };
    await createAnthropicAdapter().complete(customSlot, messages, options);
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.example.com/v1/messages');
  });
});

describe('OpenAI adapter', () => {
  const slot: LLMSlot = {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    api_key: 'sk-test',
  };

  it('posts to /v1/chat/completions with Bearer token', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      choices: [{ message: { content: 'Hi there' } }],
    }));
    const result = await createOpenAIAdapter().complete(slot, messages, options);
    expect(result.text).toBe('Hi there');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sk-test' });

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('test-model');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
  });

  it('handles openai-compatible with custom base_url', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ choices: [{ message: { content: 'x' } }] }));
    const compat: LLMSlot = { ...slot, base_url: 'https://api.groq.com/openai', provider: 'openai-compatible' };
    await createOpenAIAdapter('openai-compatible').complete(compat, messages, options);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('throws when choices array is empty', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ choices: [] }));
    await expect(createOpenAIAdapter().complete(slot, messages, options)).rejects.toThrow(LLMError);
  });

  it('sends response_format json_object when options.json is set', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ choices: [{ message: { content: '{}' } }] }));
    await createOpenAIAdapter().complete(slot, messages, { ...options, json: true });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('omits json_object for an ARRAY reply even when options.json is set', async () => {
    // json_object can only return an object; a D-162 batch contract is an array.
    fetchMock.mockImplementationOnce(mockFetch({ choices: [{ message: { content: '[]' } }] }));
    await createOpenAIAdapter('openai-compatible').complete(slot, messages, { ...options, json: true, json_shape: 'array' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format).toBeUndefined();
  });

  it('omits response_format when options.json is not set', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ choices: [{ message: { content: 'x' } }] }));
    await createOpenAIAdapter().complete(slot, messages, options);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format).toBeUndefined();
  });

  it('preserves an OpenAI output-limit finish reason', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
    }));
    const result = await createOpenAIAdapter().complete(slot, messages, options);
    expect(result.finish_reason).toBe('length');
  });

  it('preserves a textless provider refusal as content_filter', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      choices: [{ message: { content: null }, finish_reason: 'content_filter' }],
    }));
    const result = await createOpenAIAdapter().complete(slot, messages, options);
    expect(result).toMatchObject({ text: '', finish_reason: 'content_filter' });
  });

  it('normalizes the explicit refusal field even when finish_reason is stop', async () => {
    const refusal = 'Disallowed request details that must not escape the adapter';
    fetchMock.mockImplementationOnce(mockFetch({
      choices: [{ message: { content: null, refusal }, finish_reason: 'stop' }],
    }));
    const result = await createOpenAIAdapter().complete(slot, messages, options);
    expect(result).toMatchObject({ text: '', finish_reason: 'content_filter' });
    expect(JSON.stringify(result)).not.toContain(refusal);
  });
});

describe('Google adapter', () => {
  const slot: LLMSlot = {
    provider: 'google',
    model: 'gemini-2.5-pro',
    api_key: 'goog-test',
  };

  it('posts to /models/:model:generateContent with x-goog-api-key header', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{ content: { parts: [{ text: 'Hi from Gemini' }] } }],
    }));
    const result = await createGoogleAdapter().complete(slot, messages, options);
    expect(result.text).toBe('Hi from Gemini');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'goog-test' });
  });

  it('promotes system to system_instruction, maps assistant→model', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    }));
    const assistantMessages: LLMMessage[] = [
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Thanks' },
    ];
    await createGoogleAdapter().complete(slot, assistantMessages, options);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.system_instruction.parts[0].text).toBe('Be helpful.');
    expect(body.contents).toHaveLength(3);
    expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: 'Hi' }] });
    expect(body.contents[1]).toEqual({ role: 'model', parts: [{ text: 'Hello!' }] });
    expect(body.contents[2]).toEqual({ role: 'user', parts: [{ text: 'Thanks' }] });
  });

  it('throws when candidates missing', async () => {
    fetchMock.mockImplementationOnce(mockFetch({}));
    await expect(createGoogleAdapter().complete(slot, messages, options)).rejects.toThrow(LLMError);
  });

  it('drops `thought: true` reasoning parts and returns only the answer text', async () => {
    // Gemini 2.5+ / Gemma-4 thinking models: the reasoning parts (which here
    // even quote a DIFFERENT JSON fragment) must NOT leak into the answer, or
    // downstream JSON/tool-call parsing scans the wrong `{`.
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{
        content: {
          parts: [
            { text: 'The user wants {"tool":"WRONG"} — let me reason...', thought: true },
            { text: '\n', thought: true },
            { text: '{"tool":"contact.search","args":{"q":"acme"}}' },
          ],
        },
      }],
      usageMetadata: { promptTokenCount: 23, candidatesTokenCount: 14, totalTokenCount: 233, thoughtsTokenCount: 196 },
    }));
    const result = await createGoogleAdapter().complete(slot, messages, options);
    expect(result.text).toBe('{"tool":"contact.search","args":{"q":"acme"}}');
    // Reasoning is still ACCOUNTED for in usage even though it's dropped from text.
    expect(result.usage.reasoning_tokens).toBe(196);
  });

  it('throws a budget-hint error when the response is ALL thought parts (no answer)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{ content: { parts: [{ text: 'still thinking...', thought: true }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 210, thoughtsTokenCount: 200 },
    }));
    await expect(createGoogleAdapter().complete(slot, messages, options))
      .rejects.toThrow(/only thinking parts/);
  });

  it('sets generationConfig.responseMimeType json when options.json is set', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{ content: { parts: [{ text: '{}' }] } }],
    }));
    await createGoogleAdapter().complete(slot, messages, { ...options, json: true });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('omits responseMimeType when options.json is not set', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{ content: { parts: [{ text: 'x' }] } }],
    }));
    await createGoogleAdapter().complete(slot, messages, options);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.generationConfig.responseMimeType).toBeUndefined();
  });

  it('maps Gemini MAX_TOKENS to finish_reason length', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{
        content: { parts: [{ text: 'partial' }] },
        finishReason: 'MAX_TOKENS',
      }],
    }));
    const result = await createGoogleAdapter().complete(slot, messages, options);
    expect(result.finish_reason).toBe('length');
  });

  it('preserves a textless safety refusal as content_filter', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{ finishReason: 'SAFETY' }],
    }));
    const result = await createGoogleAdapter().complete(slot, messages, options);
    expect(result).toMatchObject({ text: '', finish_reason: 'content_filter' });
  });

  it.each([
    'SAFETY',
    'OTHER',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'IMAGE_SAFETY',
  ])('normalizes promptFeedback blockReason %s when no candidate exists', async (blockReason) => {
    fetchMock.mockImplementationOnce(mockFetch({
      promptFeedback: { blockReason },
      candidates: [],
    }));
    const result = await createGoogleAdapter().complete(slot, messages, options);
    expect(result).toMatchObject({ text: '', finish_reason: 'content_filter' });
    expect(JSON.stringify(result)).not.toContain(blockReason);
  });

  it.each([
    'IMAGE_SAFETY',
    'IMAGE_PROHIBITED_CONTENT',
    'IMAGE_RECITATION',
  ])('normalizes candidate %s as content_filter', async (finishReason) => {
    fetchMock.mockImplementationOnce(mockFetch({
      candidates: [{ finishReason }],
    }));
    const result = await createGoogleAdapter().complete(slot, messages, options);
    expect(result).toMatchObject({ text: '', finish_reason: 'content_filter' });
  });

  it('does not promote an unspecified prompt block to a refusal', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' },
      candidates: [],
    }));
    await expect(createGoogleAdapter().complete(slot, messages, options))
      .rejects.toMatchObject({ code: 'AI_RESPONSE_PARSE_FAILED' });
  });
});

describe('createDefaultRegistry', () => {
  it('returns adapters for all four provider keys', () => {
    const reg = createDefaultRegistry();
    expect(reg('anthropic').provider).toBe('anthropic');
    expect(reg('openai').provider).toBe('openai');
    expect(reg('openai-compatible').provider).toBe('openai-compatible');
    expect(reg('google').provider).toBe('google');
  });

  it('throws for unknown providers', () => {
    const reg = createDefaultRegistry();
    expect(() => reg('mystery' as 'openai')).toThrow(LLMError);
  });
});

describe('null timeout installs no setTimeout (default behavior)', () => {
  const slot: LLMSlot = {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    api_key: 'sk-ant-test',
  };

  it('succeeds without a timer when timeout_ms is null', async () => {
    fetchMock.mockImplementationOnce(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const result = await createAnthropicAdapter().complete(slot, messages, {
      model: 'test-model',
      max_tokens: 100,
      timeout_ms: null,   // ← the new default semantics
    });
    expect(result.text).toBe('ok');
  });

  it('AbortController is still passed so user/engine can cancel explicitly', async () => {
    // Even with null timeout, the signal is still installed on fetch()
    // so an explicit external abort still aborts the call. We verify by
    // checking that the fetch() init object receives a signal.
    fetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await createAnthropicAdapter().complete(slot, messages, {
      model: 'test-model',
      max_tokens: 100,
      timeout_ms: null,
    });
  });
});

describe('timeout covers body read (regression)', () => {
  const slot: LLMSlot = {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    api_key: 'sk-ant-test',
  };

  it('aborts a stalled body stream as AI_TIMEOUT, not AI_RESPONSE_PARSE_FAILED', async () => {
    // Mock a Response whose headers arrive instantly but .json() stalls
    // until the abort signal fires. Pre-fix, this was rewritten as
    // "Provider returned malformed JSON" by the inner catch — the outer
    // AbortError mapping never ran. Regression test: the AbortError must
    // propagate out of .json() so the outer handler turns it into AI_TIMEOUT.
    fetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('body aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      } as unknown as Response;
    });

    const start = Date.now();
    try {
      await createAnthropicAdapter().complete(slot, messages, {
        model: 'test-model',
        max_tokens: 100,
        timeout_ms: 150,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LLMError);
      expect((e as LLMError).code).toBe('AI_TIMEOUT');
      expect((e as LLMError).message).toContain('timed out');
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1500);
  });
});

// ────────────────────────────────────────────────────────────────
// HTTP-status → LLMError classification (feeds the executor's
// cascade re-match). Unit-tested directly so the regex / numeric
// guards don't drift silently.
// ────────────────────────────────────────────────────────────────

describe('classifyProviderError', () => {
  it('401 + 403 → retryable AI_LLM_UNAVAILABLE (auth-fail)', () => {
    for (const status of [401, 403]) {
      const e = classifyProviderError(status, 'bad key', null);
      expect(e.code).toBe('AI_LLM_UNAVAILABLE');
      expect(e.retryable).toBe(true);
      expect(e.details?.status).toBe(status);
    }
  });

  it('429 → retryable, carries retry_after_ms when provided', () => {
    const e = classifyProviderError(429, 'too many requests', 30_000);
    expect(e.code).toBe('AI_LLM_UNAVAILABLE');
    expect(e.retryable).toBe(true);
    expect(e.details?.retry_after_ms).toBe(30_000);
  });

  it('429 without Retry-After → retryable, details has no retry_after_ms', () => {
    const e = classifyProviderError(429, 'too many', null);
    expect(e.retryable).toBe(true);
    expect(e.details?.retry_after_ms).toBeUndefined();
  });

  it('5xx → retryable AI_LLM_UNAVAILABLE', () => {
    for (const status of [500, 502, 503, 504]) {
      const e = classifyProviderError(status, 'boom', null);
      expect(e.code).toBe('AI_LLM_UNAVAILABLE');
      expect(e.retryable).toBe(true);
    }
  });

  it('413 / "context too long" body → AI_TOKEN_BUDGET_EXCEEDED (NOT retryable — re-matching won\'t fix an oversized prompt)', () => {
    const a = classifyProviderError(413, 'payload too large', null);
    expect(a.code).toBe('AI_TOKEN_BUDGET_EXCEEDED');
    expect(a.retryable).toBe(false);
    // Body-based detection (some providers return 400 with a contextual message)
    const b = classifyProviderError(400, 'context length too long for model', null);
    expect(b.code).toBe('AI_TOKEN_BUDGET_EXCEEDED');
    expect(b.retryable).toBe(false);
  });

  it.each([
    'context_length_exceeded',
    "This model's maximum context length is 8192 tokens",
    'the context window was exceeded by this request',
    'prompt is too long: 210000 tokens > 200000 maximum',
    'The input token count 9000 exceeds the maximum number of tokens allowed',
    'too many input tokens for the selected model',
  ])('maps deterministic provider overflow variant %s to the token-budget error', (body) => {
    const e = classifyProviderError(400, body, null);
    expect(e.code).toBe('AI_TOKEN_BUDGET_EXCEEDED');
    expect(e.retryable).toBe(false);
  });

  it('does not mistake an invalid max_tokens parameter for input overflow', () => {
    const e = classifyProviderError(400, 'max_tokens must be a positive integer', null);
    expect(e.code).toBe('AI_LLM_UNAVAILABLE');
    expect(e.retryable).toBe(false);
  });

  it('generic 4xx → AI_LLM_UNAVAILABLE, NOT retryable', () => {
    const e = classifyProviderError(422, 'schema mismatch', null);
    expect(e.code).toBe('AI_LLM_UNAVAILABLE');
    expect(e.retryable).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('null / empty → null', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('   ')).toBeNull();
  });

  it('delta-seconds form → milliseconds', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter('  120  ')).toBe(120_000);
  });

  it('zero or negative seconds → null (no meaningful cooldown)', () => {
    expect(parseRetryAfter('0')).toBeNull();
  });

  it('HTTP-date form → future delta in ms', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).not.toBeNull();
    // ±5s tolerance for clock jitter.
    expect(ms).toBeGreaterThan(55_000);
    expect(ms).toBeLessThan(65_000);
  });

  it('past HTTP-date → null', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBeNull();
  });

  it('malformed header → null', () => {
    expect(parseRetryAfter('not a date or number')).toBeNull();
  });
});
