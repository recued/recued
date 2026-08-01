/** D-169 P1.5 — webclient symmetric fix substrate tests.
 *
 *  Keeps the new race/lock/error substrate reviewable in isolation from
 *  the D-156 baseline suites. These cases are mutation tripwires for:
 *    - pair-finalize write order and strict-triple entrance guard
 *    - local-store read rejection tagging
 *    - Web Locks request shape / resolver behavior
 *    - passport.fetch stalled-handshake and transport-state races
 *    - pair-code-input host lock + preflight + post-lock lifecycle
 */

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { generateRecoveryKey } from '@recued/crypto';
import type {
  ServerPassportProjection,
  WebclientLocalStorage,
  WebclientTokenRecord,
} from '@recued/contracts';

import {
  finalizePairCodeSuccess,
  PAIR_CODE_SUCCESS_ERROR_COPY,
  PAIR_CODE_SUCCESS_LOCK_NAME,
  resolveBrowserPairFinalizeLockProvider,
  type PairFinalizeLockProvider,
} from '../auth/pair-code-success.js';
import {
  mountPairCodeInputHost,
  PAIR_CODE_INPUT_ERROR_COPY,
  PAIR_CODE_INPUT_STATUS_ID,
} from '../auth/pair-code-input-host.js';
import {
  createWebclientPairPassportInvoker,
  type PairPassportInvoker,
} from '../auth/pair-passport-invoker.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';
import type {
  WebclientLocalStore,
  WebclientProfileStore,
} from '../storage/local-store.js';
import type {
  WebclientTokenAad,
  WebclientTokenStore,
} from '../storage/token-store.js';
import type {
  WebclientWsState,
  WebclientWsTransport,
} from '../realtime/ws-client.js';

// ════════════════════════════════════════════════════════════════
// Shared fakes
// ════════════════════════════════════════════════════════════════

const FIXED_NOW = 1_700_000_000_000;
const FIXED_TOKEN_ID = 'token-id-d169-fixed';
const REAL_RECOVERY_KEY = generateRecoveryKey().mnemonic;

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const waitForEventCount = async (
  events: string[],
  count: number,
): Promise<void> => {
  for (let i = 0; i < 20 && events.length < count; i++) {
    await flushMicrotasks();
  }
};

const buildPassport = (
  overrides: {
    server_public_key?: string;
    current_handle?: string;
    cert_fingerprint?: string;
    cert_expires_at?: number;
  } = {},
): ServerPassportProjection =>
  ({
    identity: {
      server_public_key: overrides.server_public_key ?? 'PUBKEY_D169',
      current_handle: overrides.current_handle ?? 'alice',
    },
    network: {
      cert_fingerprint: overrides.cert_fingerprint ?? 'CF_D169',
      cert_expires_at: overrides.cert_expires_at ?? 2_000_000_000,
    },
  }) as unknown as ServerPassportProjection;

const existingTokenRecord = (
  token_id = 'existing-token-id',
): WebclientTokenRecord => ({
  token_id,
  ciphertext_b64: `ciphertext:${token_id}`,
  iv_b64: 'iv',
  issued_at: 1_700_000_000,
});

const buildFakeTokenStore = (): {
  store: WebclientTokenStore;
  calls: Array<{ token_id: string; bearer: string; aad: WebclientTokenAad }>;
} => {
  const calls: Array<{ token_id: string; bearer: string; aad: WebclientTokenAad }> = [];
  const store: WebclientTokenStore = {
    async wrap({ token_id, bearer, aad }) {
      calls.push({ token_id, bearer, aad });
      return {
        token_id,
        ciphertext_b64: `wrap(${bearer})`,
        iv_b64: 'iv',
        issued_at: 1_700_000_000,
      };
    },
    async unwrap() {
      throw new Error('unwrap not exercised by D-169 tests');
    },
  };
  return { store, calls };
};

const recordSetOrder = (
  localStore: WebclientLocalStore,
): { localStore: WebclientLocalStore; setOrder: string[] } => {
  const setOrder: string[] = [];
  const originalSet = localStore.set.bind(localStore);
  localStore.set = async <K extends keyof WebclientLocalStorage>(
    key: K,
    value: WebclientLocalStorage[K],
  ): Promise<void> => {
    setOrder.push(String(key));
    await originalSet(key, value);
  };
  return { localStore, setOrder };
};

const rejectGetFor = (
  localStore: WebclientLocalStore,
  failingKey: keyof WebclientLocalStorage,
): WebclientLocalStore => {
  const originalGet = localStore.get.bind(localStore);
  localStore.get = async <K extends keyof WebclientLocalStorage>(
    key: K,
  ): Promise<WebclientLocalStorage[K] | null> => {
    if (key === failingKey) {
      throw new Error(`IDB read failed for ${String(key)}`);
    }
    return originalGet(key);
  };
  return localStore;
};

const runFinalize = async (
  options: {
    localStore?: WebclientLocalStore;
    profileStore?: Pick<WebclientProfileStore, 'ensureProfile'>;
    lockProvider?: PairFinalizeLockProvider | null;
    invokePassportFetch?: PairPassportInvoker;
  } = {},
) => {
  const localStore = options.localStore ?? createInMemoryWebclientLocalStore();
  const { store: tokenStore, calls: wrapCalls } = buildFakeTokenStore();
  const invokePassportFetch =
    options.invokePassportFetch ??
    vi.fn(async () => ({ passport: buildPassport() }));
  const result = await finalizePairCodeSuccess({
    serverUrl: 'http://localhost:3001',
    bearer: 'realm-bearer-d169',
    localStore,
    ...(options.profileStore !== undefined
      ? { profileStore: options.profileStore }
      : {}),
    tokenStore,
    invokePassportFetch,
    now: () => FIXED_NOW,
    mintTokenId: () => FIXED_TOKEN_ID,
    lockProvider: options.lockProvider ?? null,
  });
  return { result, localStore, wrapCalls, invokePassportFetch };
};

const makeLockRecorder = (events: string[] = []) => {
  const request = vi.fn(
    async <T>(
      name: string,
      options: { mode: 'exclusive' },
      callback: () => Promise<T>,
    ): Promise<T> => {
      events.push('lock:request');
      expect(name).toBe(PAIR_CODE_SUCCESS_LOCK_NAME);
      expect(options).toEqual({ mode: 'exclusive' });
      events.push('lock:acquire');
      const out = await callback();
      events.push('lock:release');
      return out;
    },
  );
  return {
    provider: { request } as PairFinalizeLockProvider,
    request,
    events,
  };
};

const withNavigatorLocks = async <T>(
  locks: PairFinalizeLockProvider | undefined,
  fn: () => Promise<T> | T,
): Promise<T> => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: locks ? { locks } : {},
  });
  try {
    return await fn();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, 'navigator', original);
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  }
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════
// pair-code-success
// ════════════════════════════════════════════════════════════════

describe('D-169 pair-code-success — write order and entrance guard', () => {
  it('writes ensureProfile → clear stale token → pair_metadata → cert_pin_state → server_public_key → webclient_token', async () => {
    const store = createInMemoryWebclientLocalStore();
    const originalEnsureProfile = store.ensureProfile.bind(store);
    const originalRemove = store.remove.bind(store);
    const { localStore, setOrder } = recordSetOrder(
      store,
    );
    localStore.remove = async (key): Promise<void> => {
      setOrder.push(`remove:${key}`);
      await originalRemove(key);
    };
    const profileStore = {
      ensureProfile: async (serverUrl: string): Promise<string> => {
        setOrder.push('ensureProfile');
        return originalEnsureProfile(serverUrl);
      },
    };

    const { result } = await runFinalize({ localStore, profileStore });

    expect(result.ok).toBe(true);
    expect(setOrder).toEqual([
      'ensureProfile',
      'remove:webclient_token',
      'pair_metadata',
      'cert_pin_state',
      'server_public_key',
      'webclient_token',
    ]);
  });

  it('allows re-finalize when only webclient_token is present', async () => {
    const localStore = createInMemoryWebclientLocalStore({
      webclient_token: existingTokenRecord(),
    });
    const { result, invokePassportFetch } = await runFinalize({ localStore });

    expect(result.ok).toBe(true);
    expect(invokePassportFetch).toHaveBeenCalledTimes(1);
  });

  it('allows re-finalize when only server_url is present', async () => {
    const localStore = createInMemoryWebclientLocalStore({
      server_url: 'ws://old.example/ws',
    });
    const { result, invokePassportFetch } = await runFinalize({ localStore });

    expect(result.ok).toBe(true);
    expect(invokePassportFetch).toHaveBeenCalledTimes(1);
  });

  it('allows finalize when the strict triple is fully null', async () => {
    const localStore = createInMemoryWebclientLocalStore({
      server_url: null,
      server_public_key: null,
      webclient_token: null,
    });
    const { result, invokePassportFetch } = await runFinalize({ localStore });

    expect(result.ok).toBe(true);
    expect(invokePassportFetch).toHaveBeenCalledTimes(1);
  });

  it('returns already_paired only when server_url + server_public_key + webclient_token are all present', async () => {
    const localStore = createInMemoryWebclientLocalStore({
      server_url: 'ws://old.example/ws',
      server_public_key: 'OLD_PUBKEY',
      webclient_token: existingTokenRecord(),
    });
    const { localStore: recordingStore, setOrder } = recordSetOrder(localStore);
    const invokePassportFetch = vi.fn(async () => ({ passport: buildPassport() }));

    const { result, wrapCalls } = await runFinalize({
      localStore: recordingStore,
      invokePassportFetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('pair_code_success_already_paired');
    }
    expect(invokePassportFetch).not.toHaveBeenCalled();
    expect(wrapCalls).toHaveLength(0);
    expect(setOrder).toEqual([]);
  });
});

describe('D-169 pair-code-success — read failures and Web Locks', () => {
  it.each([
    'webclient_token',
    'server_url',
    'server_public_key',
  ] as const)(
    'tags %s read rejection as pair_code_success_persist_failed',
    async (failingKey) => {
      const localStore = rejectGetFor(
        createInMemoryWebclientLocalStore(),
        failingKey,
      );
      const invokePassportFetch = vi.fn(async () => ({ passport: buildPassport() }));

      const { result } = await runFinalize({ localStore, invokePassportFetch });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('pair_code_success_persist_failed');
        expect(result.detail).toContain(`local-store read: IDB read failed for ${failingKey}`);
      }
      expect(invokePassportFetch).not.toHaveBeenCalled();
    },
  );

  it('requests PAIR_CODE_SUCCESS_LOCK_NAME exclusively and runs the pipeline inside the callback', async () => {
    const events: string[] = [];
    const lock = makeLockRecorder(events);
    const invokePassportFetch = vi.fn(async () => {
      events.push('passport.fetch');
      return { passport: buildPassport() };
    });

    const { result } = await runFinalize({
      lockProvider: lock.provider,
      invokePassportFetch,
    });

    expect(result.ok).toBe(true);
    expect(lock.request).toHaveBeenCalledTimes(1);
    expect(lock.request.mock.calls[0]?.[0]).toBe(PAIR_CODE_SUCCESS_LOCK_NAME);
    expect(lock.request.mock.calls[0]?.[1]).toEqual({ mode: 'exclusive' });
    expect(events).toEqual([
      'lock:request',
      'lock:acquire',
      'passport.fetch',
      'lock:release',
    ]);
  });

  it('explicit lockProvider null bypasses even an available navigator.locks provider', async () => {
    const request = vi.fn(async <T>(
      _name: string,
      _options: { mode: 'exclusive' },
      callback: () => Promise<T>,
    ) => callback());
    await withNavigatorLocks({ request } as PairFinalizeLockProvider, async () => {
      const { result } = await runFinalize({ lockProvider: null });

      expect(result.ok).toBe(true);
      expect(request).not.toHaveBeenCalled();
    });
  });

  it('resolveBrowserPairFinalizeLockProvider returns null when navigator.locks is absent', async () => {
    await withNavigatorLocks(undefined, () => {
      expect(resolveBrowserPairFinalizeLockProvider()).toBeNull();
    });
  });

  it('resolveBrowserPairFinalizeLockProvider returns the stubbed navigator.locks provider', async () => {
    const locks = makeLockRecorder().provider;

    await withNavigatorLocks(locks, () => {
      expect(resolveBrowserPairFinalizeLockProvider()).toBe(locks);
    });
  });

  it('PAIR_CODE_SUCCESS_ERROR_COPY covers pair_code_success_already_paired', () => {
    expect(PAIR_CODE_SUCCESS_ERROR_COPY.pair_code_success_already_paired).toContain(
      'Another tab finished pairing',
    );
  });
});

// ════════════════════════════════════════════════════════════════
// pair-passport-invoker
// ════════════════════════════════════════════════════════════════

interface D169FakeTransport extends WebclientWsTransport {
  sent: unknown[];
  openArgs: Array<{ server_url: string; bearer: string }>;
  closeCalled: number;
  pushMessage(message: unknown): void;
  pushState(state: WebclientWsState): void;
}

const makePassportTransport = (
  options: {
    openMode?: 'resolve' | 'never' | 'reject';
    failOpen?: Error;
    stateOnSubscribe?: WebclientWsState;
  } = {},
): D169FakeTransport => {
  const sent: unknown[] = [];
  const openArgs: Array<{ server_url: string; bearer: string }> = [];
  const messageListeners = new Set<(message: unknown) => void>();
  const stateListeners = new Set<(state: WebclientWsState) => void>();
  let closeCalled = 0;

  const transport: D169FakeTransport = {
    sent,
    openArgs,
    get closeCalled() {
      return closeCalled;
    },
    async open(args) {
      openArgs.push(args);
      if (options.openMode === 'reject') {
        throw options.failOpen ?? new Error('open rejected');
      }
      if (options.openMode === 'never') {
        await new Promise(() => undefined);
        return;
      }
    },
    async close() {
      closeCalled++;
    },
    async send(message) {
      sent.push(message);
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onState(listener) {
      stateListeners.add(listener);
      if (options.stateOnSubscribe) listener(options.stateOnSubscribe);
      return () => stateListeners.delete(listener);
    },
    pushMessage(message) {
      for (const listener of [...messageListeners]) listener(message);
    },
    pushState(state) {
      for (const listener of [...stateListeners]) listener(state);
    },
  };

  return transport;
};

const invokeWithTransport = (
  transport: D169FakeTransport,
  timeout_ms = 30_000,
) =>
  createWebclientPairPassportInvoker({
    transportFactory: () => transport,
    randomId: () => 'req-d169',
    timeout_ms,
  })({ server_url: 'wss://alice.example/ws', bearer: 'realm-bearer' });

describe('D-169 pair-passport-invoker — stalled handshakes and state races', () => {
  it('times out a truly stalled open() within the configured timeout', async () => {
    vi.useFakeTimers();
    const transport = makePassportTransport({ openMode: 'never' });
    const promise = invokeWithTransport(transport, 5);
    let settled = false;
    const observed = promise.catch((err: unknown) => {
      settled = true;
      return err;
    });

    await vi.advanceTimersByTimeAsync(4);
    await flushMicrotasks();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const err = await observed;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/did not respond within 5ms/);
    expect(transport.sent).toEqual([]);
    expect(transport.closeCalled).toBe(1);
  });

  it.each(['closed', 'disconnected'] as const)(
    "rejects when transport transitions to '%s' after open and before send",
    async (state) => {
      const transport = makePassportTransport({ stateOnSubscribe: state });
      const promise = invokeWithTransport(transport);

      await expect(promise).rejects.toThrow(
        new RegExp(`WebSocket transitioned to '${state}'`),
      );
      expect(transport.sent).toEqual([]);
      expect(transport.closeCalled).toBe(1);
    },
  );

  it.each(['reconnecting', 'reauth_required'] as const)(
    "ignores intermediate '%s' transitions and still resolves the rpc_result",
    async (state) => {
      const transport = makePassportTransport({ stateOnSubscribe: state });
      const promise = invokeWithTransport(transport);
      await flushMicrotasks();

      expect(transport.sent).toHaveLength(1);
      transport.pushMessage({
        type: 'rpc_result',
        request_id: 'req-d169',
        result: { passport: buildPassport() },
      });
      await expect(promise).resolves.toEqual({ passport: buildPassport() });
      expect(transport.closeCalled).toBe(1);
    },
  );
});

describe('D-169 pair-passport-invoker — close runs in finally', () => {
  it('closes exactly once on the happy path', async () => {
    const transport = makePassportTransport();
    const promise = invokeWithTransport(transport);
    await flushMicrotasks();
    transport.pushMessage({
      type: 'rpc_result',
      request_id: 'req-d169',
      result: { passport: buildPassport() },
    });

    await expect(promise).resolves.toEqual({ passport: buildPassport() });
    expect(transport.closeCalled).toBe(1);
  });

  it('closes exactly once when open() rejects', async () => {
    const transport = makePassportTransport({
      openMode: 'reject',
      failOpen: new Error('handshake refused'),
    });

    await expect(invokeWithTransport(transport)).rejects.toThrow(/handshake refused/);
    expect(transport.sent).toEqual([]);
    expect(transport.closeCalled).toBe(1);
  });

  it('closes exactly once when the timer wins against a stalled open()', async () => {
    vi.useFakeTimers();
    const transport = makePassportTransport({ openMode: 'never' });
    const promise = invokeWithTransport(transport, 5);
    const observed = promise.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(5);
    const err = await observed;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/did not respond within 5ms/);
    expect(transport.closeCalled).toBe(1);
  });

  it('closes exactly once when a terminal state rejects pending', async () => {
    const transport = makePassportTransport({ stateOnSubscribe: 'closed' });

    await expect(invokeWithTransport(transport)).rejects.toThrow(/transitioned to 'closed'/);
    expect(transport.closeCalled).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════
// pair-code-input-host
// ════════════════════════════════════════════════════════════════

interface FakeButton {
  disabled: boolean;
  textContent: string;
}

interface FakeStatus {
  className: string;
  textContent: string;
  dataset: Record<string, string>;
}

const makeFakeSplash = () => {
  let html = '';
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  let submitBtn: FakeButton | null = null;
  let statusEl: FakeStatus | null = null;

  const decodeHtml = (s: string): string =>
    s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

  const reparse = (): void => {
    submitBtn = null;
    statusEl = null;
    const buttonMatch = html.match(
      /<button[^>]*id="webclient-pair-code-input-submit"[^>]*>([^<]*)<\/button>/,
    );
    if (buttonMatch) {
      submitBtn = {
        disabled: /<button[^>]*id="webclient-pair-code-input-submit"[^>]*\sdisabled/.test(
          html,
        ),
        textContent: decodeHtml(buttonMatch[1] ?? ''),
      };
    }
    const errorMatch = html.match(
      new RegExp(
        `<p\\s+id="${PAIR_CODE_INPUT_STATUS_ID}"[^>]*\\sdata-error="([^"]*)"[^>]*>([^<]*)</p>`,
      ),
    );
    if (html.includes(`id="${PAIR_CODE_INPUT_STATUS_ID}"`)) {
      statusEl = {
        className: errorMatch ? 'pair-code-input-error' : 'pair-code-input-status',
        textContent: errorMatch ? decodeHtml(errorMatch[2] ?? '') : '',
        dataset: errorMatch ? { error: errorMatch[1] ?? '' } : {},
      };
      (statusEl as unknown as { removeAttribute: (name: string) => void }).removeAttribute = (
        name: string,
      ) => {
        if (name === 'data-error') delete statusEl?.dataset.error;
      };
    }
  };

  const splash = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
      reparse();
    },
    addEventListener: (event: string, listener: (event: Event) => void) => {
      (listeners[event] ??= new Set()).add(listener);
    },
    removeEventListener: (event: string, listener: (event: Event) => void) => {
      listeners[event]?.delete(listener);
    },
    querySelector: (selector: string) => {
      if (selector === '#webclient-pair-code-input-submit') return submitBtn;
      if (selector === `#${PAIR_CODE_INPUT_STATUS_ID}`) return statusEl;
      return null;
    },
  } as unknown as HTMLElement;

  return {
    splash,
    getStatus: () => statusEl,
    getSubmitBtn: () => submitBtn,
  };
};

const buildPairFetch = (
  events: string[] = [],
  body: unknown = { token: 'realm-bearer-d169', serverId: 'srv-d169' },
): typeof fetch & { calls: Array<{ url: string; body: unknown }> } => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchFake = (async (
    url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    events.push('submit');
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch & { calls: typeof calls };
  fetchFake.calls = calls;
  return fetchFake;
};

const primePairForm = (
  handle: ReturnType<typeof mountPairCodeInputHost>,
): void => {
  handle.setFieldValue('serverUrl', 'http://localhost:3001');
  handle.setFieldValue('recoveryKey', REAL_RECOVERY_KEY);
  handle.setFieldValue('pairingCode', 'ABC12345');
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('D-169 pair-code-input-host — lock and preflight integration', () => {
  it('runs preflight inside the pair-finalize lock before submit POST', async () => {
    const events: string[] = [];
    const fake = makeFakeSplash();
    const lock = makeLockRecorder(events);
    const fetchFake = buildPairFetch(events);
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      lockProvider: lock.provider,
      preflightCheck: async () => {
        events.push('preflight');
        return { alreadyPaired: false };
      },
      fetch: fetchFake,
      onPaired: () => {
        events.push('onPaired');
      },
      onAfterPair: () => {
        events.push('onAfterPair');
      },
    });
    primePairForm(handle);

    await handle.submit();

    expect(lock.request).toHaveBeenCalledTimes(1);
    expect(lock.request.mock.calls[0]?.[0]).toBe(PAIR_CODE_SUCCESS_LOCK_NAME);
    expect(lock.request.mock.calls[0]?.[1]).toEqual({ mode: 'exclusive' });
    expect(events).toEqual([
      'lock:request',
      'lock:acquire',
      'preflight',
      'submit',
      'onPaired',
      'lock:release',
      'onAfterPair',
    ]);
  });

  it('preflight alreadyPaired short-circuits with pair_code_input_already_paired', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildPairFetch();
    const onPaired = vi.fn();
    const onAfterPair = vi.fn();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      lockProvider: makeLockRecorder().provider,
      preflightCheck: async () => ({ alreadyPaired: true }),
      fetch: fetchFake,
      onPaired,
      onAfterPair,
    });
    primePairForm(handle);

    await handle.submit();

    expect(fetchFake.calls).toHaveLength(0);
    expect(onPaired).not.toHaveBeenCalled();
    expect(onAfterPair).not.toHaveBeenCalled();
    expect(fake.getStatus()?.dataset.error).toBe('pair_code_input_already_paired');
    expect(fake.getStatus()?.textContent).toBe(
      'Another tab finished pairing while this form was open. Reload to use the existing pair, or clear this browser from Settings to pair a new server.',
    );
  });

  it('preflight throw renders server_unknown_error with the pre-pair failure detail', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildPairFetch();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      lockProvider: makeLockRecorder().provider,
      preflightCheck: async () => {
        throw new Error('IDB unavailable');
      },
      fetch: fetchFake,
      onPaired: () => undefined,
    });
    primePairForm(handle);

    await handle.submit();

    expect(fetchFake.calls).toHaveLength(0);
    expect(fake.getStatus()?.dataset.error).toBe(
      'pair_code_input_server_unknown_error',
    );
    expect(fake.getStatus()?.textContent).toMatch(
      /^Pre-pair check failed: IDB unavailable/,
    );
  });
});

describe('D-169 pair-code-input-host — post-submit lifecycle', () => {
  it('onPaired throw retains a local-only retry and skips onAfterPair', async () => {
    const fake = makeFakeSplash();
    const onAfterPair = vi.fn();
    const fetchFake = buildPairFetch();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      lockProvider: makeLockRecorder().provider,
      preflightCheck: async () => ({ alreadyPaired: false }),
      fetch: fetchFake,
      onPaired: async () => {
        throw new Error('bootstrap failed');
      },
      onAfterPair,
    });
    primePairForm(handle);

    await handle.submit();

    expect(fake.getStatus()?.dataset.error).toBe(
      'pair_code_input_finalize_interrupted',
    );
    expect(fake.getStatus()?.textContent).toContain(
      'Saving access here was interrupted: bootstrap failed.',
    );
    expect(fake.getStatus()?.textContent).toContain(
      'without sending another pairing request',
    );
    expect(fake.getSubmitBtn()?.textContent).toBe('Finish saving access');
    expect(fetchFake.calls).toHaveLength(1);
    expect(onAfterPair).not.toHaveBeenCalled();
  });

  it('runs onAfterPair outside the lock after onPaired resolves', async () => {
    const events: string[] = [];
    const fake = makeFakeSplash();
    const lock = makeLockRecorder(events);
    const afterDeferred = deferred();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      lockProvider: lock.provider,
      preflightCheck: async () => {
        events.push('preflight');
        return { alreadyPaired: false };
      },
      fetch: buildPairFetch(events),
      onPaired: () => {
        events.push('onPaired');
      },
      onAfterPair: async () => {
        events.push('onAfterPair:start');
        await afterDeferred.promise;
        events.push('onAfterPair:end');
      },
    });
    primePairForm(handle);

    const submitPromise = handle.submit();
    await waitForEventCount(events, 7);

    try {
      expect(events).toEqual([
        'lock:request',
        'lock:acquire',
        'preflight',
        'submit',
        'onPaired',
        'lock:release',
        'onAfterPair:start',
      ]);
    } finally {
      afterDeferred.resolve();
    }

    await submitPromise;
    expect(events.at(-1)).toBe('onAfterPair:end');
  });

  it('onAfterPair throw renders post-pair startup failure in host state', async () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      lockProvider: makeLockRecorder().provider,
      preflightCheck: async () => ({ alreadyPaired: false }),
      fetch: buildPairFetch(),
      onPaired: () => undefined,
      onAfterPair: async () => {
        throw new Error('restart failed');
      },
    });
    primePairForm(handle);

    await handle.submit();

    expect(fake.getStatus()?.dataset.error).toBe(
      'pair_code_input_server_unknown_error',
    );
    expect(fake.getStatus()?.textContent).toBe(
      'Paired, but post-pair startup failed: restart failed',
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ] as const)(
    'lockProvider %s short-circuits while submit, onPaired, and onAfterPair still run in sequence',
    async (_label, lockProvider) => {
      const events: string[] = [];
      const fake = makeFakeSplash();
      const handle = mountPairCodeInputHost({
        splashElement: fake.splash,
        ...(lockProvider === undefined ? {} : { lockProvider }),
        fetch: buildPairFetch(events),
        onPaired: () => {
          events.push('onPaired');
        },
        onAfterPair: () => {
          events.push('onAfterPair');
        },
      });
      primePairForm(handle);

      await handle.submit();

      expect(events).toEqual(['submit', 'onPaired', 'onAfterPair']);
    },
  );

  it('PAIR_CODE_INPUT_ERROR_COPY covers pair_code_input_already_paired', () => {
    expect(PAIR_CODE_INPUT_ERROR_COPY.pair_code_input_already_paired).toBe(
      'Another tab finished pairing while this form was open. Reload to use the existing pair, or clear this browser from Settings to pair a new server.',
    );
  });
});
