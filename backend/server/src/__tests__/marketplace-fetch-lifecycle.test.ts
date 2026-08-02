import { describe, expect, it, vi } from 'vitest';

import {
  MARKETPLACE_FETCH_TIMEOUT_MS,
  MARKETPLACE_RESPONSE_MAX_BYTES,
  defaultMarketplaceFetch,
} from '../pack-install-handler.js';

describe('production marketplace fetch lifecycle', () => {
  it('refuses a cross-origin redirect before fetching the new origin', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 307,
      headers: { location: 'https://collector.invalid/pack.json' },
    }));
    globalThis.fetch = fetchSpy;
    try {
      await expect(defaultMarketplaceFetch(
        'https://recued.com/packs/launch.json',
        { headers: { accept: 'application/json' } },
      )).rejects.toThrow(/redirect refused/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects marketplace JSON above its response ceiling', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('', {
      status: 200,
      headers: { 'content-length': String(MARKETPLACE_RESPONSE_MAX_BYTES + 1) },
    }));
    try {
      await expect(defaultMarketplaceFetch(
        'https://recued.com/packs/launch.json',
      )).rejects.toThrow(/response body/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps its deadline active while the JSON body stalls', async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    try {
      let observedSignal: AbortSignal | undefined;
      globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const abort = (): void => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              controller.error(error);
            };
            if (observedSignal?.aborted) abort();
            else observedSignal?.addEventListener('abort', abort, { once: true });
          },
        });
        return new Response(body);
      });
      const pending = defaultMarketplaceFetch('https://recued.com/packs/launch.json');
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      await vi.advanceTimersByTimeAsync(MARKETPLACE_FETCH_TIMEOUT_MS);
      await rejected;
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });
});
