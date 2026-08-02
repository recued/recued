import { describe, expect, it, vi } from 'vitest';

import { getJson, postJson } from '../http.js';

describe('transport JSON HTTP lifecycle', () => {
  it('requires native fetch to refuse redirects on credential-bearing control calls', async () => {
    const fetchImpl = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => new Response(null, {
      status: 307,
      headers: { location: 'https://collector.invalid/steal' },
    }));

    const outcome = await postJson('https://slack.com/api/chat.postMessage', {
      headers: { authorization: 'Bearer SECRET-bot-token' },
      body: '{"text":"launch"}',
      timeoutMs: 1_000,
      fetchImpl,
    });

    expect(outcome).toMatchObject({ ok: false, kind: 'http_error', status: 307 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
    });
  });

  it('cancels a length-less success body as soon as it crosses the cap', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(3));
      },
      cancel() {
        cancelled = true;
      },
    });

    const outcome = await postJson('https://api.telegram.org/botSECRET/sendMessage', {
      headers: {},
      body: '{}',
      timeoutMs: 1_000,
      maxResponseBytes: 4,
      fetchImpl: async () => new Response(body),
    });

    expect(outcome).toEqual({
      ok: false,
      kind: 'network',
      detail: 'response body exceeded 4 bytes',
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('rejects a declared oversized body and releases it unread', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel });

    const outcome = await getJson('https://graph.facebook.com/v22.0/media', {
      timeoutMs: 1_000,
      maxResponseBytes: 8,
      fetchImpl: async () => new Response(body, {
        headers: { 'content-length': '9' },
      }),
    });

    expect(outcome).toEqual({
      ok: false,
      kind: 'network',
      detail: 'response body exceeded 8 bytes',
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    // Node may pre-pull one chunk while constructing the stream, before the
    // Response consumer sees Content-Length. The reader itself never opens.
    expect(pull.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('keeps the deadline active while a success body stalls', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl: typeof fetch = async (_input, init) => {
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
      };

      const pending = postJson('https://discord.com/api/v10/channels/1/messages', {
        headers: { authorization: 'Bot SECRET-token' },
        body: '{}',
        timeoutMs: 20,
        fetchImpl,
      });
      await vi.advanceTimersByTimeAsync(20);

      await expect(pending).resolves.toEqual({
        ok: false,
        kind: 'timeout',
        detail: 'response body read timed out after 20ms',
      });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds and releases error bodies while preserving the HTTP classification', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    });

    const outcome = await postJson('https://slack.com/api/chat.postMessage', {
      headers: {},
      body: '{}',
      timeoutMs: 1_000,
      maxResponseBytes: 8,
      fetchImpl: async () => new Response(body, {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    });

    expect(outcome).toEqual({
      ok: false,
      kind: 'http_error',
      status: 500,
      detail: '500 Internal Server Error',
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('fails closed on an invalid trusted response ceiling without touching the network', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));

    const outcome = await postJson('https://slack.com/api/chat.postMessage', {
      headers: {},
      body: '{}',
      timeoutMs: 1_000,
      maxResponseBytes: 0,
      fetchImpl,
    });

    expect(outcome).toEqual({
      ok: false,
      kind: 'network',
      detail: 'response body limit must be a positive safe integer',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
