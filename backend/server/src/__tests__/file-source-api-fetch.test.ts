import { describe, expect, it, vi } from 'vitest';

import { ResponseBodyTooLargeError } from '@recued/ingredients';

import {
  FILE_SOURCE_API_TIMEOUT_MS,
  fetchFileSourceApi,
} from '../file-source-adapters/http-json.js';
import type { FileFetch } from '../file-source-adapters/index.js';

describe('file-source provider API fetch lifecycle', () => {
  it('refuses a cross-origin redirect before forwarding bearer auth', async () => {
    const fetchSpy = vi.fn(async (
      _url: Parameters<FileFetch>[0],
      _init: Parameters<FileFetch>[1],
    ) => new Response(null, {
      status: 307,
      headers: { location: 'https://collector.invalid/steal' },
    }));
    const fetchImpl = fetchSpy as unknown as FileFetch;

    await expect(fetchFileSourceApi(
      fetchImpl,
      'https://api.provider.example/list',
      {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: '{"cursor":"c"}',
      },
    )).rejects.toThrow(/redirect refused/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'manual',
    });
  });

  it('turns a same-origin 303 into a body-less GET', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl: FileFetch = async (url, init) => {
      calls.push({
        url,
        method: init.method,
        ...(typeof init.body === 'string' ? { body: init.body } : {}),
      });
      if (calls.length === 1) {
        return new Response(null, {
          status: 303,
          headers: { location: '/result' },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const response = await fetchFileSourceApi(
      fetchImpl,
      'https://api.provider.example/start',
      { method: 'POST', headers: {}, body: 'secret request' },
    );

    expect(await response.json()).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        url: 'https://api.provider.example/start',
        method: 'POST',
        body: 'secret request',
      },
      { url: 'https://api.provider.example/result', method: 'GET' },
    ]);
  });

  it('stops a length-less oversized stream at the configured byte ceiling', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(3));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as FileFetch;

    await expect(fetchFileSourceApi(
      fetchImpl,
      'https://api.provider.example/list',
      { method: 'GET', headers: {} },
      { maxResponseBytes: 4 },
    )).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('keeps its abortable deadline active while the body stalls', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl: FileFetch = async (_url, init) => {
        signal = init.signal;
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
        return new Response(body, { status: 200 });
      };
      const pending = fetchFileSourceApi(
        fetchImpl,
        'https://api.provider.example/list',
        { method: 'GET', headers: {} },
      );
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      await vi.advanceTimersByTimeAsync(FILE_SOURCE_API_TIMEOUT_MS);
      await rejected;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves Box-sized integer cursors in text mode without calling json()', async () => {
    let jsonCalled = false;
    const raw = '{"next_stream_position":1152921504606846977,"entries":[]}';
    const fetchImpl: FileFetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => raw,
      json: async () => {
        jsonCalled = true;
        return JSON.parse(raw) as unknown;
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const response = await fetchFileSourceApi(
      fetchImpl,
      'https://api.box.com/2.0/events',
      { method: 'GET', headers: {} },
      { responseMode: 'text' },
    );

    expect(await response.text()).toBe(raw);
    expect(jsonCalled).toBe(false);
  });
});
