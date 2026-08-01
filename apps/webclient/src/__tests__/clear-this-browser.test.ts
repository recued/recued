/** D-148 P4 — "Clear this browser" wipes only the documented surfaces. */

import { describe, expect, it, vi } from 'vitest';
import { clearThisBrowser } from '../auth/clear-this-browser.js';
import type { PairFinalizeLockProvider } from '../auth/pair-code-success.js';
import { inspectColdStartCredentials } from '../boot/cold-start-credential-repair.js';
import { WEBCLIENT_SHELL_CACHE_NAME } from '../runtime/service-worker.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';
import type { WebclientTokenStore } from '../storage/token-store.js';

// Seed + assert the REAL constant, never a copy of its current value. A literal
// here pins whatever the constant happens to say, so it stays green through
// exactly the drift that broke the wipe twice. That the constant matches the
// cache `public/sw.js` opens is asserted in
// `service-worker-cache-name-parity.test.ts`.
const SHELL_CACHE = WEBCLIENT_SHELL_CACHE_NAME;

describe('D-148 P4 — clear this browser', () => {
  it('wipes the closed-list 5 fields + sessionStorage + SW cache', async () => {
    const local_store = createInMemoryWebclientLocalStore({
      server_url: 'wss://x',
      server_public_key: 'pk',
    });
    let session_cleared = false;
    const session_storage = {
      clear: () => {
        session_cleared = true;
      },
    };
    const cache_state = new Set([SHELL_CACHE, 'unrelated.cache']);
    const cache_storage = {
      async keys() {
        return [...cache_state];
      },
      async delete(name: string) {
        const had = cache_state.has(name);
        cache_state.delete(name);
        return had;
      },
    };

    const result = await clearThisBrowser({
      local_store,
      session_storage,
      cache_storage,
    });

    expect(result.cleared_local_store).toBe(true);
    expect(result.cleared_session_storage).toBe(true);
    expect(result.cleared_sw_caches).toBe(true);
    expect(result.cleared_crypto_keys).toBe(false);
    // Codex slice-109 P2 fold — default cache name aligned with the SW's
    // actual `CACHE_NAME` in `public/sw.js`.
    expect(result.deleted_cache_names).toEqual([SHELL_CACHE]);
    expect(session_cleared).toBe(true);
    expect(cache_state.has(SHELL_CACHE)).toBe(false);
    expect(cache_state.has('unrelated.cache')).toBe(true);
    const inspect = await local_store.inspect();
    expect(inspect.server_url).toBeNull();
    expect(inspect.server_public_key).toBeNull();
  });

  it('Codex P2 fold — invokes crypto_keys_wiper + reports cleared_crypto_keys=true', async () => {
    let wiped = false;
    const result = await clearThisBrowser({
      local_store: createInMemoryWebclientLocalStore(),
      crypto_keys_wiper: async () => {
        wiped = true;
      },
      on_local_credentials_cleared: () => {
        throw new Error('advisory observer unavailable');
      },
    });
    expect(wiped).toBe(true);
    expect(result.cleared_crypto_keys).toBe(true);
    expect(result.cleared_local_store).toBe(true);
  });

  it('signals at the durable credential boundary even when later cleanup fails', async () => {
    const events: string[] = [];
    const local_store = createInMemoryWebclientLocalStore({
      server_url: 'wss://x',
      server_public_key: 'pk',
    });
    const originalClear = local_store.clear.bind(local_store);
    local_store.clear = async () => {
      events.push('local-store');
      await originalClear();
    };

    await expect(clearThisBrowser({
      local_store,
      on_local_credentials_cleared: () => {
        events.push('sibling-signal');
      },
      crypto_keys_wiper: async () => {
        events.push('crypto-key');
      },
      session_storage: {
        clear: () => {
          events.push('session-storage');
          throw new Error('session storage unavailable');
        },
      },
    })).rejects.toThrow('session storage unavailable');

    expect(events).toEqual([
      'local-store',
      'sibling-signal',
      'crypto-key',
      'session-storage',
    ]);
    expect(await local_store.inspect()).toMatchObject({
      server_url: null,
      server_public_key: null,
    });
  });

  it('holds the pair lock through key deletion, then releases before cache cleanup', async () => {
    let tail: Promise<unknown> = Promise.resolve();
    const request = vi.fn();
    const pair_lock_provider: PairFinalizeLockProvider = {
      request<T>(
        name: string,
        options: { mode: 'exclusive' },
        callback: () => Promise<T>,
      ): Promise<T> {
        request(name, options);
        const run = tail.catch(() => undefined).then(callback);
        tail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    };
    const local_store = createInMemoryWebclientLocalStore({
      server_url: 'wss://x',
      server_public_key: 'pk',
    });
    const events: string[] = [];
    const originalClear = local_store.clear.bind(local_store);
    const originalGet = local_store.get.bind(local_store);
    let arrivalRead = false;
    local_store.get = async (key) => {
      arrivalRead = true;
      return originalGet(key);
    };
    local_store.clear = async () => {
      events.push('local-clear');
      await originalClear();
    };
    let releaseKeyWipe!: () => void;
    const keyWipeStarted = new Promise<void>((resolve) => {
      releaseKeyWipe = resolve;
    });
    let announceKeyWipe!: () => void;
    const keyWipeReached = new Promise<void>((resolve) => {
      announceKeyWipe = resolve;
    });
    let releaseCache!: () => void;
    const cacheGate = new Promise<void>((resolve) => {
      releaseCache = resolve;
    });
    let announceCache!: () => void;
    const cacheReached = new Promise<void>((resolve) => {
      announceCache = resolve;
    });

    const clearPromise = clearThisBrowser({
      local_store,
      pair_lock_provider,
      on_local_credentials_cleared: () => events.push('sibling-signal'),
      crypto_keys_wiper: async () => {
        events.push('key-start');
        announceKeyWipe();
        await keyWipeStarted;
        events.push('key-finish');
      },
      cache_storage: {
        async keys() {
          events.push('cache-start');
          announceCache();
          await cacheGate;
          events.push('cache-finish');
          return [];
        },
        async delete() {
          return true;
        },
      },
    });
    await keyWipeReached;

    const arrival = inspectColdStartCredentials({
      localStore: local_store,
      tokenStore: {
        wrap: vi.fn(),
        unwrap: vi.fn(),
      } as unknown as WebclientTokenStore,
      pairLockProvider: pair_lock_provider,
      settleMs: 10_000,
    });
    await Promise.resolve();
    expect(arrivalRead).toBe(false);

    releaseKeyWipe();
    await cacheReached;
    const arrivalHealth = await arrival;

    expect(arrivalHealth).toEqual({ kind: 'continue' });
    expect(arrivalRead).toBe(true);
    expect(events).toEqual([
      'local-clear',
      'sibling-signal',
      'key-start',
      'key-finish',
      'cache-start',
    ]);
    releaseCache();
    await clearPromise;
    expect(events.at(-1)).toBe('cache-finish');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe(request.mock.calls[1]?.[0]);
  });

  it('honors custom sw_cache_names', async () => {
    const cache_state = new Set(['recued.webclient.assets', 'recued.alt-cache', 'untouched']);
    const result = await clearThisBrowser({
      local_store: createInMemoryWebclientLocalStore(),
      cache_storage: {
        async keys() {
          return [...cache_state];
        },
        async delete(name: string) {
          const had = cache_state.has(name);
          cache_state.delete(name);
          return had;
        },
      },
      sw_cache_names: ['recued.alt-cache'],
    });
    expect(result.deleted_cache_names).toEqual(['recued.alt-cache']);
    expect(cache_state.has('recued.webclient.assets')).toBe(true);
    expect(cache_state.has('untouched')).toBe(true);
  });

  it('gracefully no-ops when sessionStorage / cache surfaces are absent', async () => {
    const local_store = createInMemoryWebclientLocalStore();
    const result = await clearThisBrowser({ local_store });
    expect(result.cleared_local_store).toBe(true);
    expect(result.cleared_session_storage).toBe(true);
    expect(result.cleared_sw_caches).toBe(true);
    expect(result.deleted_cache_names).toEqual([]);
    expect(result.cleared_crypto_keys).toBe(false);
  });

  it('Codex slice-109 P2 fold — default cache name matches the SW shell cache', async () => {
    // Pre-fold the substrate defaulted to `recued.webclient.assets`, a
    // string no SW build had ever opened, so the default "Clear this
    // browser" path silently no-op'd the shell cache. This test seeds
    // BOTH names and asserts the default targets the real one.
    const cache_state = new Set([SHELL_CACHE, 'recued.webclient.assets']);
    const result = await clearThisBrowser({
      local_store: createInMemoryWebclientLocalStore(),
      cache_storage: {
        async keys() {
          return [...cache_state];
        },
        async delete(name: string) {
          const had = cache_state.has(name);
          cache_state.delete(name);
          return had;
        },
      },
    });
    expect(result.deleted_cache_names).toEqual([SHELL_CACHE]);
    // The stale-default cache name is left untouched (would be the
    // case in production too — no SW has ever opened it).
    expect(cache_state.has(SHELL_CACHE)).toBe(false);
    expect(cache_state.has('recued.webclient.assets')).toBe(true);
  });
});
