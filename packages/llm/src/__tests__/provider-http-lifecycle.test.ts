import { afterEach, describe, expect, it, vi } from 'vitest';

import { callProvider } from '../adapters/anthropic.js';
import { createOpenAITranscriptionAdapter } from '../adapters/transcription.js';
import {
  LLM_PROVIDER_RESPONSE_MAX_BYTES,
  LLMProviderResponseTooLargeError,
  readBoundedProviderText,
} from '../provider-http.js';
import type { LLMSlot } from '../types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe('LLM provider HTTP lifecycle', () => {
  it('refuses provider redirects instead of replaying BYOK credentials', async () => {
    const fetchSpy = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => new Response('{"error":"redirect"}', {
      status: 307,
      headers: { location: 'https://collector.invalid/steal' },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(callProvider(
      'https://generativelanguage.googleapis.com/v1beta/models/model:generateContent',
      { 'x-goog-api-key': 'SECRET-google-key', 'content-type': 'application/json' },
      { contents: [{ parts: [{ text: 'private prompt' }] }] },
      1_000,
    )).rejects.toMatchObject({ code: 'AI_LLM_UNAVAILABLE' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
    });
  });

  it('cancels a length-less response when it crosses the byte ceiling', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(3));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readBoundedProviderText(new Response(body), 4))
      .rejects.toBeInstanceOf(LLMProviderResponseTooLargeError);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('maps a declared oversized success envelope to a typed parse failure', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    globalThis.fetch = vi.fn(async () => new Response(body, {
      headers: {
        'content-length': String(LLM_PROVIDER_RESPONSE_MAX_BYTES + 1),
      },
    })) as unknown as typeof fetch;

    await expect(callProvider(
      'https://api.openai.com/v1/chat/completions',
      { authorization: 'Bearer SECRET-openai-key' },
      { messages: [] },
      1_000,
    )).rejects.toMatchObject({
      code: 'AI_RESPONSE_PARSE_FAILED',
      message: expect.stringContaining('exceeded'),
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it('keeps an opted-in deadline active while the response body stalls', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = (): void => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            controller.error(error);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch;

    const pending = callProvider(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': 'SECRET-anthropic-key' },
      { messages: [] },
      20,
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20);

    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it('applies the same no-redirect policy to multipart transcription', async () => {
    const fetchSpy = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response('{"text":"hello"}', {
      headers: { 'content-type': 'application/json' },
    }));
    const adapter = createOpenAITranscriptionAdapter(
      'openai',
      fetchSpy as unknown as typeof fetch,
    );
    const slot: LLMSlot = {
      provider: 'openai',
      model: 'gpt',
      api_key: 'SECRET-openai-key',
      modalities: { audio: true },
    };

    await expect(adapter.transcribe(
      slot,
      { audio: new Uint8Array([1, 2, 3]), mime_type: 'audio/wav' },
      { model: 'whisper-1', timeout_ms: 1_000 },
    )).resolves.toMatchObject({ text: 'hello' });

    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
    });
  });
});
