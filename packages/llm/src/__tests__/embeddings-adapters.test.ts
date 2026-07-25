import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createOpenAIEmbeddingsAdapter,
  createGoogleEmbeddingsAdapter,
  createAnthropicEmbeddingsAdapter,
  createDefaultEmbeddingsRegistry,
} from '../embeddings/adapters/index.js';
import { LLMError } from '../types.js';
import type { LLMSlot } from '../types.js';

const mockFetch = (response: unknown, status = 200) =>
  vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// D-174 R28 Slice C — an embeddings slot's `model` field IS the embeddings
// model. (Adapters read `options.model` per call, not the slot field, so the
// dispatched model is whatever `baseOptions(...)` passes.)
const openAISlot: LLMSlot = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  api_key: 'sk-test',
};

const googleSlot: LLMSlot = {
  provider: 'google',
  model: 'text-embedding-004',
  api_key: 'goog-key',
};

const baseOptions = (model: string) => ({
  model,
  timeout_ms: 5_000,
});

// ────────────────────────────────────────────────────────────────
// OpenAI embeddings adapter
// ────────────────────────────────────────────────────────────────

describe('OpenAI embeddings adapter', () => {
  it('posts to /v1/embeddings with Bearer auth and the requested model', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 7, total_tokens: 7 },
    }));
    const adapter = createOpenAIEmbeddingsAdapter('openai');
    const result = await adapter.embed(
      openAISlot,
      { input: 'hello world' },
      baseOptions('text-embedding-3-small'),
    );
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.dimensions).toBe(3);
    expect(result.model).toBe('text-embedding-3-small');
    expect(result.usage.input_tokens).toBe(7);
    expect(result.usage.total_tokens).toBe(7);
    expect(result.usage.output_tokens).toBe(0);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect((init as RequestInit).headers).toMatchObject({
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    });
  });

  it('forwards the optional dimensions parameter when set', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      data: [{ embedding: [0.1] }],
      model: 'text-embedding-3-large',
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }));
    const adapter = createOpenAIEmbeddingsAdapter('openai');
    await adapter.embed(
      openAISlot,
      { input: 'x' },
      { ...baseOptions('text-embedding-3-large'), dimensions: 1024 },
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.dimensions).toBe(1024);
    expect(body.model).toBe('text-embedding-3-large');
    expect(body.encoding_format).toBe('float');
    expect(body.input).toBe('x');
  });

  it('omits dimensions when not provided', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      data: [{ embedding: [0.5] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }));
    const adapter = createOpenAIEmbeddingsAdapter('openai');
    await adapter.embed(openAISlot, { input: 'y' }, baseOptions('text-embedding-3-small'));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect('dimensions' in body).toBe(false);
  });

  it('honors slot.base_url for openai-compatible endpoints', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      data: [{ embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }));
    const adapter = createOpenAIEmbeddingsAdapter('openai-compatible');
    await adapter.embed(
      { ...openAISlot, provider: 'openai-compatible', base_url: 'https://api.mistral.ai' },
      { input: 'hi' },
      baseOptions('mistral-embed'),
    );
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.mistral.ai/v1/embeddings');
  });

  it('falls back to the requested model when response.model is missing', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      data: [{ embedding: [0.5, 0.5] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }));
    const adapter = createOpenAIEmbeddingsAdapter('openai');
    const result = await adapter.embed(
      openAISlot,
      { input: 'x' },
      baseOptions('text-embedding-3-small'),
    );
    expect(result.model).toBe('text-embedding-3-small');
  });

  it('throws AI_RESPONSE_PARSE_FAILED when data is missing', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ usage: { prompt_tokens: 0 } }));
    const adapter = createOpenAIEmbeddingsAdapter('openai');
    await expect(
      adapter.embed(openAISlot, { input: 'x' }, baseOptions('text-embedding-3-small')),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE_PARSE_FAILED' });
  });

  it('throws AI_RESPONSE_PARSE_FAILED when embedding is empty array', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      data: [{ embedding: [] }],
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }));
    const adapter = createOpenAIEmbeddingsAdapter('openai');
    await expect(
      adapter.embed(openAISlot, { input: 'x' }, baseOptions('text-embedding-3-small')),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE_PARSE_FAILED' });
  });

  it('throws AI_RESPONSE_PARSE_FAILED when vector contains non-finite numbers', async () => {
    // Defensive: some openai-compatible servers emit "NaN" / Infinity
    // under odd configs. Surface these clearly rather than letting the
    // storage layer choke later.
    fetchMock.mockImplementationOnce(mockFetch({
      data: [{ embedding: [0.1, Number.NaN, 0.3] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }));
    const adapter = createOpenAIEmbeddingsAdapter('openai');
    await expect(
      adapter.embed(openAISlot, { input: 'x' }, baseOptions('text-embedding-3-small')),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE_PARSE_FAILED' });
  });

  it('classifies 401 as retryable AI_LLM_UNAVAILABLE', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ error: { message: 'invalid api key' } }, 401));
    const adapter = createOpenAIEmbeddingsAdapter('openai');
    try {
      await adapter.embed(openAISlot, { input: 'x' }, baseOptions('text-embedding-3-small'));
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LLMError);
      const err = e as LLMError;
      expect(err.code).toBe('AI_LLM_UNAVAILABLE');
      expect(err.retryable).toBe(true);
      expect(err.details?.status).toBe(401);
    }
  });

  it('classifies 429 with Retry-After as retryable + carries retry_after_ms', async () => {
    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '15' },
      }),
    );
    const adapter = createOpenAIEmbeddingsAdapter('openai');
    try {
      await adapter.embed(openAISlot, { input: 'x' }, baseOptions('text-embedding-3-small'));
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LLMError);
      const err = e as LLMError;
      expect(err.code).toBe('AI_LLM_UNAVAILABLE');
      expect(err.retryable).toBe(true);
      expect(err.details?.retry_after_ms).toBe(15_000);
    }
  });

  it('classifies 5xx as retryable AI_LLM_UNAVAILABLE', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ error: 'server fail' }, 503));
    const adapter = createOpenAIEmbeddingsAdapter('openai');
    try {
      await adapter.embed(openAISlot, { input: 'x' }, baseOptions('text-embedding-3-small'));
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as LLMError;
      expect(err.code).toBe('AI_LLM_UNAVAILABLE');
      expect(err.retryable).toBe(true);
    }
  });

  it('classifies 413 as non-retryable AI_TOKEN_BUDGET_EXCEEDED', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ error: 'too long' }, 413));
    const adapter = createOpenAIEmbeddingsAdapter('openai');
    try {
      await adapter.embed(
        openAISlot,
        { input: 'x'.repeat(100000) },
        baseOptions('text-embedding-3-small'),
      );
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as LLMError;
      expect(err.code).toBe('AI_TOKEN_BUDGET_EXCEEDED');
      expect(err.retryable).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Google Gemini embeddings adapter
// ────────────────────────────────────────────────────────────────

describe('Google Gemini embeddings adapter', () => {
  it('posts to embedContent with x-goog-api-key header', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      embedding: { values: [0.1, 0.2, 0.3] },
    }));
    const adapter = createGoogleEmbeddingsAdapter();
    const result = await adapter.embed(
      googleSlot,
      { input: 'hello world' },
      baseOptions('text-embedding-004'),
    );
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.dimensions).toBe(3);
    expect(result.model).toBe('text-embedding-004');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent',
    );
    expect((init as RequestInit).headers).toMatchObject({
      'x-goog-api-key': 'goog-key',
      'content-type': 'application/json',
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ content: { parts: [{ text: 'hello world' }] } });
  });

  it('estimates token usage from input length / 4', async () => {
    // "hello world" is 11 chars → ceil(11/4) = 3
    fetchMock.mockImplementationOnce(mockFetch({
      embedding: { values: [0.1, 0.2] },
    }));
    const adapter = createGoogleEmbeddingsAdapter();
    const result = await adapter.embed(
      googleSlot,
      { input: 'hello world' },
      baseOptions('text-embedding-004'),
    );
    expect(result.usage.input_tokens).toBe(3);
    expect(result.usage.total_tokens).toBe(3);
    expect(result.usage.output_tokens).toBe(0);
  });

  it('does NOT forward the dimensions hint (Gemini does not support it)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      embedding: { values: [0.1, 0.2, 0.3] },
    }));
    const adapter = createGoogleEmbeddingsAdapter();
    await adapter.embed(
      googleSlot,
      { input: 'x' },
      { ...baseOptions('text-embedding-004'), dimensions: 256 },
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // Body should ONLY have content; no dimensions field anywhere.
    expect(Object.keys(body)).toEqual(['content']);
  });

  it('throws AI_RESPONSE_PARSE_FAILED when embedding.values is missing', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ embedding: {} }));
    const adapter = createGoogleEmbeddingsAdapter();
    await expect(
      adapter.embed(googleSlot, { input: 'x' }, baseOptions('text-embedding-004')),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE_PARSE_FAILED' });
  });

  it('URL-encodes the model name (defensive for unusual model strings)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      embedding: { values: [0.1] },
    }));
    const adapter = createGoogleEmbeddingsAdapter();
    await adapter.embed(googleSlot, { input: 'x' }, baseOptions('text-embed/v1'));
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('text-embed%2Fv1');
  });

  it('honors slot.base_url for endpoint override', async () => {
    fetchMock.mockImplementationOnce(mockFetch({
      embedding: { values: [0.1] },
    }));
    const adapter = createGoogleEmbeddingsAdapter();
    await adapter.embed(
      { ...googleSlot, base_url: 'https://proxy.example.com' },
      { input: 'x' },
      baseOptions('text-embedding-004'),
    );
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://proxy.example.com/v1beta/models/text-embedding-004:embedContent',
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Anthropic embeddings stub — no public model
// ────────────────────────────────────────────────────────────────

describe('Anthropic embeddings stub', () => {
  it('throws AI_LLM_UNAVAILABLE with a clear remediation message', async () => {
    const adapter = createAnthropicEmbeddingsAdapter();
    try {
      await adapter.embed(
        { provider: 'anthropic', model: 'claude-opus-4-7', api_key: 'sk-ant' },
        { input: 'x' },
        baseOptions('whatever'),
      );
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as LLMError;
      expect(err.code).toBe('AI_LLM_UNAVAILABLE');
      expect(err.message.toLowerCase()).toContain('anthropic');
      // Steers the user toward the actual remediation rather than
      // surfacing as opaque "no adapter registered".
      expect(err.message.toLowerCase()).toMatch(/openai|google|mistral/);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Default embeddings registry
// ────────────────────────────────────────────────────────────────

describe('createDefaultEmbeddingsRegistry', () => {
  it('returns adapters for openai / openai-compatible / google / anthropic', () => {
    const registry = createDefaultEmbeddingsRegistry();
    expect(registry('openai').provider).toBe('openai');
    expect(registry('openai-compatible').provider).toBe('openai-compatible');
    expect(registry('google').provider).toBe('google');
    expect(registry('anthropic').provider).toBe('anthropic');
  });

  it('throws AI_LLM_UNAVAILABLE for unsupported keys', async () => {
    // The registry must fail loudly so misrouted calls don't silently fall through.
    const registry = createDefaultEmbeddingsRegistry();
    expect(() => registry('unsupported' as never)).toThrow(LLMError);
  });
});
