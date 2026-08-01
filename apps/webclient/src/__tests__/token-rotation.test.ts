/** D-148 § A.4.4 — `token.rotated` broadcast handler acceptance.
 *
 *  Drives `createTokenRotationHandler` through deterministic fakes for
 *  every seam — `WebclientLocalStore` carries pair context, fake
 *  `WebclientTokenStore` records `wrap` calls + returns a synthetic
 *  ciphertext, fake `BroadcastSubscriber` lets the test fire arbitrary
 *  events, fake `WebclientWsClient` records `applyRotatedBearer` calls.
 *
 *  Acceptance surface:
 *
 *    - Happy path: target_token_id matches → wrap with fresh AAD →
 *      persist to local store → applyRotatedBearer called.
 *    - Sibling client: target_token_id mismatch → no wrap, no persist,
 *      no applyRotatedBearer.
 *    - Pre-pair: webclient_token absent → no-op.
 *    - Pair context incomplete: server_url null → onError(stage:
 *      read_pair_context), no wrap, no persist.
 *    - Wrap failure: throws → onError(stage: wrap), no persist, no
 *      applyRotatedBearer.
 *    - Persist failure: throws → onError(stage: persist), no
 *      applyRotatedBearer.
 *    - Dispose: tears down subscription. Subsequent events ignored.
 *    - issued_at: persisted record uses the event's server-side
 *      issued_at, not the wrap-time clock.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  WebclientLocalKey,
  WebclientLocalStorage,
  WebclientTokenRecord,
} from '@recued/contracts';
import type { WebclientLocalStore } from '../storage/local-store.js';
import type {
  WebclientTokenAad,
  WebclientTokenStore,
} from '../storage/token-store.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import type { WebclientWsClient } from '../realtime/ws-client.js';
import {
  createTokenRotationHandler,
  type TokenRotationFailureContext,
} from '../realtime/token-rotation.js';

// ──────────────────────────────────────────────────────────────────
// Fake local store — Partial<WebclientLocalStorage>.
// ──────────────────────────────────────────────────────────────────

const buildLocalStore = (
  initial: Partial<WebclientLocalStorage>,
): WebclientLocalStore => {
  const data: Partial<WebclientLocalStorage> = { ...initial };
  return {
    async get<K extends WebclientLocalKey>(key: K) {
      return (data[key] ?? null) as WebclientLocalStorage[K] | null;
    },
    async set<K extends WebclientLocalKey>(key: K, value: WebclientLocalStorage[K]) {
      (data as Record<string, unknown>)[key] = value;
    },
    async remove(key) {
      delete data[key];
    },
    async inspect() {
      return {
        server_url: data.server_url ?? null,
        webclient_token: data.webclient_token ?? null,
        server_public_key: data.server_public_key ?? null,
        pair_metadata: data.pair_metadata ?? null,
        cert_pin_state: data.cert_pin_state ?? null,
      };
    },
    async clear() {
      for (const k of Object.keys(data)) delete (data as Record<string, unknown>)[k];
    },
  };
};

// ──────────────────────────────────────────────────────────────────
// Fake token store — records every wrap; unwrap is unused here.
// ──────────────────────────────────────────────────────────────────

interface FakeTokenStoreControls {
  store: WebclientTokenStore;
  wrapCalls(): Array<{ token_id: string; bearer: string; aad: WebclientTokenAad }>;
  failNextWrap(err: Error): void;
}

const buildTokenStore = (): FakeTokenStoreControls => {
  const calls: Array<{ token_id: string; bearer: string; aad: WebclientTokenAad }> = [];
  let pendingFailure: Error | null = null;
  return {
    store: {
      async wrap({ token_id, bearer, aad }) {
        if (pendingFailure) {
          const err = pendingFailure;
          pendingFailure = null;
          throw err;
        }
        calls.push({ token_id, bearer, aad });
        return {
          token_id,
          ciphertext_b64: `ct-${token_id}`,
          iv_b64: `iv-${token_id}`,
          issued_at: 0, // overridden by the handler with event.issued_at.
        };
      },
      async unwrap() {
        throw new Error('not used in these tests');
      },
    },
    wrapCalls: () => calls.slice(),
    failNextWrap: (err) => {
      pendingFailure = err;
    },
  };
};

// ──────────────────────────────────────────────────────────────────
// Fake broadcast subscriber — minimal `on`-only surface.
// ──────────────────────────────────────────────────────────────────

interface FakeSubscriberControls {
  subscriber: BroadcastSubscriber;
  fire(event: unknown): void;
  listenerCount(): number;
}

const buildSubscriber = (): FakeSubscriberControls => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const subscriber: BroadcastSubscriber = {
    on(kind, listener) {
      let set = listeners.get(kind);
      if (!set) {
        set = new Set();
        listeners.set(kind, set);
      }
      set.add(listener as unknown as (event: unknown) => void);
      return () => {
        set?.delete(listener as unknown as (event: unknown) => void);
      };
    },
    onAny() {
      return () => undefined;
    },
    dispatch(message) {
      if (!message || typeof message !== 'object') return;
      const kind = (message as { kind?: unknown }).kind;
      if (typeof kind !== 'string') return;
      const set = listeners.get(kind);
      if (!set) return;
      for (const l of [...set]) l(message);
    },
    size() {
      let total = 0;
      for (const s of listeners.values()) total += s.size;
      return total;
    },
  };
  return {
    subscriber,
    fire: (event) => subscriber.dispatch(event),
    listenerCount: () => {
      let total = 0;
      for (const s of listeners.values()) total += s.size;
      return total;
    },
  };
};

// ──────────────────────────────────────────────────────────────────
// Fake ws-client — only `applyRotatedBearer` is consumed.
// ──────────────────────────────────────────────────────────────────

interface FakeWsControls {
  ws: Pick<WebclientWsClient, 'applyRotatedBearer'>;
  applyCount(): number;
  /** Hook the apply call so a test can run assertions inside the
   *  rotation flow (e.g. observe that `localStore.set` ran first). */
  setApplyHook(fn: () => Promise<void> | void): void;
}

const buildWs = (): FakeWsControls => {
  let applies = 0;
  let hook: (() => Promise<void> | void) | null = null;
  return {
    ws: {
      applyRotatedBearer: () => {
        applies += 1;
        if (hook) void hook();
      },
    },
    applyCount: () => applies,
    setApplyHook: (fn) => {
      hook = fn;
    },
  };
};

// ──────────────────────────────────────────────────────────────────
// Common fixtures
// ──────────────────────────────────────────────────────────────────

const STORED_TOKEN: WebclientTokenRecord = {
  token_id: 'tok-old',
  ciphertext_b64: 'old-ct',
  iv_b64: 'old-iv',
  issued_at: 1_700_000_000_000,
};

const PAIRED: Partial<WebclientLocalStorage> = {
  server_url: 'wss://alice.recued.cloud:8443/ws',
  server_public_key: 'spki-base64',
  webclient_token: STORED_TOKEN,
};

const targetEvent = (
  overrides: Partial<{
    target_token_id: string;
    new_token_id: string;
    bearer: string;
    issued_at: number;
    cursor: number;
  }> = {},
) => ({
  kind: 'token.rotated' as const,
  target_token_id: overrides.target_token_id ?? 'tok-old',
  new_token_id: overrides.new_token_id ?? 'tok-new',
  bearer: overrides.bearer ?? 'fresh-bearer-plaintext',
  issued_at: overrides.issued_at ?? 1_700_000_999_999,
  cursor: overrides.cursor ?? 42,
});

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

// ══════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4.4 — createTokenRotationHandler', () => {
  it('happy path: matching target_token_id → wrap with fresh AAD → persist → applyRotatedBearer', async () => {
    const localStore = buildLocalStore(PAIRED);
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const onRotated = vi.fn();
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
      onRotated,
    });

    subscriberControls.fire(targetEvent());
    await flush();

    const wrapCalls = tokenControls.wrapCalls();
    expect(wrapCalls.length).toBe(1);
    expect(wrapCalls[0]).toMatchObject({
      token_id: 'tok-new',
      bearer: 'fresh-bearer-plaintext',
      aad: {
        token_id: 'tok-new',
        server_url: 'wss://alice.recued.cloud:8443/ws',
        server_public_key: 'spki-base64',
      },
    });

    const persisted = await localStore.get('webclient_token');
    expect(persisted).toEqual({
      token_id: 'tok-new',
      ciphertext_b64: 'ct-tok-new',
      iv_b64: 'iv-tok-new',
      issued_at: 1_700_000_999_999, // server's issued_at, not wrap-time
    });

    expect(wsControls.applyCount()).toBe(1);
    expect(onRotated).toHaveBeenCalledWith({
      token_id: 'tok-new',
      ciphertext_b64: 'ct-tok-new',
      iv_b64: 'iv-tok-new',
      issued_at: 1_700_000_999_999,
    });
    handler.dispose();
  });

  it('keeps a durable rotation successful when its advisory observer throws', async () => {
    const localStore = buildLocalStore(PAIRED);
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
      onRotated: () => {
        throw new Error('observer unavailable');
      },
    });

    subscriberControls.fire(targetEvent());
    await flush();

    expect((await localStore.get('webclient_token'))?.token_id).toBe('tok-new');
    expect(wsControls.applyCount()).toBe(1);
    handler.dispose();
  });

  it('persisted record uses event.issued_at, not the wrap-time clock', async () => {
    const localStore = buildLocalStore(PAIRED);
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
    });

    subscriberControls.fire(targetEvent({ issued_at: 1_700_000_777_777 }));
    await flush();

    const persisted = await localStore.get('webclient_token');
    expect(persisted?.issued_at).toBe(1_700_000_777_777);
    handler.dispose();
  });

  it('sibling client: target_token_id mismatch → no wrap, no persist, no applyRotatedBearer', async () => {
    const localStore = buildLocalStore(PAIRED);
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const onError = vi.fn();
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
      onError,
    });

    // Event targets a DIFFERENT client (laptop's token_id; this client
    // is the user's phone).
    subscriberControls.fire(targetEvent({ target_token_id: 'tok-other-client' }));
    await flush();

    expect(tokenControls.wrapCalls().length).toBe(0);
    const persisted = await localStore.get('webclient_token');
    expect(persisted).toEqual(STORED_TOKEN); // unchanged
    expect(wsControls.applyCount()).toBe(0);
    expect(onError).not.toHaveBeenCalled();
    handler.dispose();
  });

  it('pre-pair: webclient_token absent → no-op', async () => {
    const localStore = buildLocalStore({
      ...PAIRED,
      webclient_token: null,
    });
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const onError = vi.fn();
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
      onError,
    });

    subscriberControls.fire(targetEvent());
    await flush();

    expect(tokenControls.wrapCalls().length).toBe(0);
    expect(wsControls.applyCount()).toBe(0);
    expect(onError).not.toHaveBeenCalled();
    handler.dispose();
  });

  it('pair context incomplete: server_url null → onError(read_pair_context) + bail', async () => {
    const localStore = buildLocalStore({
      ...PAIRED,
      server_url: null,
    });
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const onError = vi.fn();
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
      onError,
    });

    subscriberControls.fire(targetEvent());
    await flush();

    expect(tokenControls.wrapCalls().length).toBe(0);
    expect(wsControls.applyCount()).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    const [err, ctx] = onError.mock.calls[0]!;
    expect((err as Error).message).toMatch(/pair context incomplete/);
    expect((ctx as TokenRotationFailureContext).stage).toBe('read_pair_context');
    handler.dispose();
  });

  it('pair context incomplete: server_public_key null → onError(read_pair_context) + bail', async () => {
    const localStore = buildLocalStore({
      ...PAIRED,
      server_public_key: null,
    });
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const onError = vi.fn();
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
      onError,
    });

    subscriberControls.fire(targetEvent());
    await flush();

    expect(tokenControls.wrapCalls().length).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(
      (onError.mock.calls[0]![1] as TokenRotationFailureContext).stage,
    ).toBe('read_pair_context');
    handler.dispose();
  });

  it('local store read failure → onError(read_pair_context), no wrap', async () => {
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const onError = vi.fn();
    const failingStore: WebclientLocalStore = {
      async get() {
        throw new Error('idb-read-blew-up');
      },
      async set() {},
      async remove() {},
      async inspect() {
        return {
          server_url: null,
          webclient_token: null,
          server_public_key: null,
          pair_metadata: null,
          cert_pin_state: null,
        };
      },
      async clear() {},
    };
    const handler = createTokenRotationHandler({
      localStore: failingStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
      onError,
    });

    subscriberControls.fire(targetEvent());
    await flush();

    expect(tokenControls.wrapCalls().length).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(
      (onError.mock.calls[0]![1] as TokenRotationFailureContext).stage,
    ).toBe('read_pair_context');
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(/idb-read-blew-up/);
    handler.dispose();
  });

  it('wrap failure → onError(wrap), no persist, no applyRotatedBearer', async () => {
    const localStore = buildLocalStore(PAIRED);
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const onError = vi.fn();
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
      onError,
    });

    tokenControls.failNextWrap(new Error('AES key unavailable'));

    subscriberControls.fire(targetEvent());
    await flush();

    const persisted = await localStore.get('webclient_token');
    expect(persisted).toEqual(STORED_TOKEN); // unchanged
    expect(wsControls.applyCount()).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(
      (onError.mock.calls[0]![1] as TokenRotationFailureContext).stage,
    ).toBe('wrap');
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(/AES key unavailable/);
    handler.dispose();
  });

  it('persist failure → onError(persist), no applyRotatedBearer', async () => {
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const onError = vi.fn();
    const localStore: WebclientLocalStore = {
      async get<K extends WebclientLocalKey>(key: K) {
        if (key === 'webclient_token') return STORED_TOKEN as WebclientLocalStorage[K];
        if (key === 'server_url')
          return 'wss://alice.recued.cloud:8443/ws' as WebclientLocalStorage[K];
        if (key === 'server_public_key') return 'spki-base64' as WebclientLocalStorage[K];
        return null;
      },
      async set(key) {
        if (key === 'webclient_token') throw new Error('idb-write-blew-up');
      },
      async remove() {},
      async inspect() {
        return {
          server_url: 'wss://alice.recued.cloud:8443/ws',
          webclient_token: STORED_TOKEN,
          server_public_key: 'spki-base64',
          pair_metadata: null,
          cert_pin_state: null,
        };
      },
      async clear() {},
    };
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
      onError,
    });

    subscriberControls.fire(targetEvent());
    await flush();

    expect(tokenControls.wrapCalls().length).toBe(1); // wrap completed
    expect(wsControls.applyCount()).toBe(0); // but apply was not called
    expect(onError).toHaveBeenCalledTimes(1);
    expect(
      (onError.mock.calls[0]![1] as TokenRotationFailureContext).stage,
    ).toBe('persist');
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(/idb-write-blew-up/);
    handler.dispose();
  });

  it('onError callback throwing does not crash the dispatch loop', async () => {
    const localStore = buildLocalStore(PAIRED);
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const onError = vi.fn(() => {
      throw new Error('onError-itself-blew-up');
    });
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
      onError,
    });

    tokenControls.failNextWrap(new Error('wrap-failure'));
    subscriberControls.fire(targetEvent());
    await flush();

    // The handler's own try/catch around onError swallows the throw —
    // a subsequent valid event still processes.
    subscriberControls.fire(targetEvent());
    await flush();

    expect(tokenControls.wrapCalls().length).toBe(1); // second event succeeded
    expect(wsControls.applyCount()).toBe(1);
    handler.dispose();
  });

  it('dispose: detaches subscription so subsequent events are ignored', async () => {
    const localStore = buildLocalStore(PAIRED);
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
    });
    expect(subscriberControls.listenerCount()).toBe(1);

    handler.dispose();
    expect(subscriberControls.listenerCount()).toBe(0);

    subscriberControls.fire(targetEvent());
    await flush();
    expect(tokenControls.wrapCalls().length).toBe(0);
    expect(wsControls.applyCount()).toBe(0);
  });

  it('dispose is idempotent', () => {
    const localStore = buildLocalStore(PAIRED);
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
    });
    handler.dispose();
    handler.dispose();
    expect(subscriberControls.listenerCount()).toBe(0);
  });

  it('without onError supplied, failure paths still no-op cleanly', async () => {
    const localStore = buildLocalStore({
      ...PAIRED,
      server_url: null,
    });
    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
    });

    subscriberControls.fire(targetEvent());
    await flush();

    expect(tokenControls.wrapCalls().length).toBe(0);
    expect(wsControls.applyCount()).toBe(0);
    handler.dispose();
  });

  it('Codex P2 fold — serializes back-to-back rotations (chain prevents stored-read race)', async () => {
    // Two events fire BEFORE the first persist completes. Without
    // serialization, both async tasks read the OLD stored.token_id
    // and the second event matches if its target was the OLD id;
    // when the second event's target is the FIRST event's NEW id,
    // the unserialized version drops it (sibling mismatch). With
    // serialization, the chain forces the second task to read the
    // freshly-persisted token_id.
    let setBlock: ((v: void) => void) | null = null;
    const setPause = new Promise<void>((resolve) => {
      setBlock = resolve;
    });
    let pauseConsumed = false;
    const data: Partial<WebclientLocalStorage> = { ...PAIRED };
    const localStore: WebclientLocalStore = {
      async get<K extends WebclientLocalKey>(key: K) {
        return (data[key] ?? null) as WebclientLocalStorage[K] | null;
      },
      async set<K extends WebclientLocalKey>(key: K, value: WebclientLocalStorage[K]) {
        if (key === 'webclient_token' && !pauseConsumed) {
          pauseConsumed = true;
          await setPause;
        }
        (data as Record<string, unknown>)[key] = value;
      },
      async remove(key) {
        delete data[key];
      },
      async inspect() {
        return {
          server_url: data.server_url ?? null,
          webclient_token: data.webclient_token ?? null,
          server_public_key: data.server_public_key ?? null,
          pair_metadata: data.pair_metadata ?? null,
          cert_pin_state: data.cert_pin_state ?? null,
        };
      },
      async clear() {
        for (const k of Object.keys(data)) delete (data as Record<string, unknown>)[k];
      },
    };

    const tokenControls = buildTokenStore();
    const subscriberControls = buildSubscriber();
    const wsControls = buildWs();
    const handler = createTokenRotationHandler({
      localStore,
      tokenStore: tokenControls.store,
      subscriber: subscriberControls.subscriber,
      ws: wsControls.ws,
    });

    // Event 1: OLD → tok-new-1. Event 2: tok-new-1 → tok-new-2 (the
    // server rotated twice). With the serialized chain, event 2 sees
    // the post-event-1 stored token_id (tok-new-1) and matches.
    subscriberControls.fire(
      targetEvent({ target_token_id: 'tok-old', new_token_id: 'tok-new-1' }),
    );
    subscriberControls.fire(
      targetEvent({ target_token_id: 'tok-new-1', new_token_id: 'tok-new-2' }),
    );

    // Both async tasks are queued; the first is parked inside set().
    // Release the gate; both tasks complete in order.
    setBlock!();
    await flush();
    await flush();

    const wrapCalls = tokenControls.wrapCalls();
    expect(wrapCalls.map((c) => c.token_id)).toEqual(['tok-new-1', 'tok-new-2']);
    expect((await localStore.get('webclient_token'))?.token_id).toBe('tok-new-2');
    expect(wsControls.applyCount()).toBe(2);
    handler.dispose();
  });
});
