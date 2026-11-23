/** D-169 P0 Slice 3 - service-worker bootstrap rpc multiplex tests.
 *
 *  Exercises the bootstrap-owned inbound discriminator split between
 *  typed rpc replies and the existing BridgeWireEnvelope router. The
 *  fixtures intentionally mirror the slice-1 bootstrap composition tests:
 *  in-memory chrome storage, captured SW lifecycle hooks, a stub token
 *  store, and a captured WsTransportFactory with fireMessage/sentFrames
 *  helpers. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_RESULT_ENVELOPE_KIND,
  bootBridgeServiceWorker,
  type BridgeServiceWorkerDeps,
  type BridgeSwLifecycle,
  type ChromeRuntimeOnMessageApi,
} from '../boot/service-worker-bootstrap.js';
import type {
  BridgeCommand,
  BridgeResult,
  WebclientTokenRecord,
} from '@recued/contracts';
import { BRIDGE_DOWNLOAD_OUTPUT_KEYS, RpcError } from '@recued/contracts';
import type { WebclientTokenStore } from '../storage/token-store.js';
import type {
  ActionExecutorOutcome,
  ActionExecutorRequest,
  BridgeActionExecutor,
} from '../queue/dispatcher.js';
import type {
  WsTransport,
  WsTransportFactory,
} from '../transport/ws-client.js';
import type { ChromeStorageLocal } from '../storage/local-store.js';
import { createInMemoryBridgeGrantStore } from '../permissions/grants.js';
import { BRIDGE_PAIR_MESSAGE_TYPE } from '../pairing/worker-pairing.js';
import { BRIDGE_SIGN_IN_REFUSED_SESSION_KEY } from '../pairing/sign-in-refusal-store.js';
import * as pairCompletion from '../pairing/pair-completion.js';
import { createInMemoryIdempotencyCache } from '../idempotency/cache.js';
import { buildActionExecutor } from '../actions/executor.js';
import { fetchFile, pageFileAddress } from '../actions/page-files.js';

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const flushAsyncWork = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

type PromiseState =
  | { status: 'pending' }
  | { status: 'fulfilled'; value: unknown }
  | { status: 'rejected'; reason: unknown };

const readPromiseState = async <T>(promise: Promise<T>): Promise<PromiseState> => {
  let state: PromiseState = { status: 'pending' };
  promise.then(
    (value) => {
      state = { status: 'fulfilled', value };
    },
    (reason) => {
      state = { status: 'rejected', reason };
    },
  );
  await flushMicrotasks();
  return state;
};

const expectRejected = async <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    (value) => {
      throw new Error(`expected rejection, got ${String(value)}`);
    },
    (err: unknown) => err,
  );

const expectRpcError = (
  err: unknown,
  code: string,
  method: string,
): RpcError => {
  expect(err).toBeInstanceOf(RpcError);
  const rpc = err as RpcError;
  expect(rpc.code).toBe(code);
  expect(rpc.method).toBe(method);
  return rpc;
};

const buildInMemoryChromeStorage = (
  seed: Record<string, unknown> = {},
): ChromeStorageLocal => {
  const data = { ...seed };
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (k in data) out[k] = data[k];
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = v;
    },
    async remove(keys) {
      for (const k of keys) delete data[k];
    },
    async clear() {
      for (const k of Object.keys(data)) delete data[k];
    },
  };
};

interface CapturedSwLifecycle extends BridgeSwLifecycle {
  installHandlers: Array<() => void>;
  activateHandlers: Array<(event: { waitUntil(p: Promise<unknown>): void }) => void>;
}

const buildCapturedSwLifecycle = (): CapturedSwLifecycle => {
  const installHandlers: Array<() => void> = [];
  const activateHandlers: CapturedSwLifecycle['activateHandlers'] = [];
  return {
    installHandlers,
    activateHandlers,
    onInstall(handler) {
      installHandlers.push(handler);
    },
    onActivate(handler) {
      activateHandlers.push(handler);
    },
    async skipWaiting() {},
    async claim() {
      return undefined;
    },
  };
};

interface CapturedOnMessage extends ChromeRuntimeOnMessageApi {
  handlers: Array<(
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean | undefined>;
}

const buildCapturedOnMessage = (): CapturedOnMessage => {
  const handlers: CapturedOnMessage['handlers'] = [];
  return {
    handlers,
    addListener(handler) {
      handlers.push(handler);
    },
  };
};

interface CapturedWsTransport extends WsTransport {
  sent: string[];
  messageHandlers: Array<(payload: string) => void>;
  closeHandlers: Array<(info: { code: number; reason: string }) => void>;
  errorHandlers: Array<(err: Error) => void>;
  closedWith: { code?: number; reason?: string } | null;
}

interface CapturedWsTransportFactory extends WsTransportFactory {
  fireMessage(payload: string): void;
  sentFrames(): string[];
  disconnect(info?: { code: number; reason: string }): void;
  openCalls: number;
  transport: CapturedWsTransport | null;
}

const buildCapturedWsTransportFactory = (): CapturedWsTransportFactory => {
  const obj: Partial<CapturedWsTransportFactory> = {
    openCalls: 0,
    transport: null,
  };
  obj.open = async () => {
    obj.openCalls = (obj.openCalls ?? 0) + 1;
    const messageHandlers: CapturedWsTransport['messageHandlers'] = [];
    const closeHandlers: CapturedWsTransport['closeHandlers'] = [];
    const errorHandlers: CapturedWsTransport['errorHandlers'] = [];
    const transport: CapturedWsTransport = {
      sent: [],
      messageHandlers,
      closeHandlers,
      errorHandlers,
      closedWith: null,
      send(payload) {
        transport.sent.push(payload);
      },
      close(code, reason) {
        transport.closedWith = { code, reason };
      },
      onMessage(handler) {
        messageHandlers.push(handler);
        return () => {
          const i = messageHandlers.indexOf(handler);
          if (i >= 0) messageHandlers.splice(i, 1);
        };
      },
      onClose(handler) {
        closeHandlers.push(handler);
        return () => {
          const i = closeHandlers.indexOf(handler);
          if (i >= 0) closeHandlers.splice(i, 1);
        };
      },
      onError(handler) {
        errorHandlers.push(handler);
        return () => {
          const i = errorHandlers.indexOf(handler);
          if (i >= 0) errorHandlers.splice(i, 1);
        };
      },
    };
    obj.transport = transport;
    return transport;
  };
  obj.fireMessage = (payload: string): void => {
    const t = obj.transport;
    if (!t) throw new Error('test helper: no transport - call open() first');
    for (const h of [...t.messageHandlers]) h(payload);
  };
  obj.sentFrames = (): string[] => obj.transport?.sent ?? [];
  obj.disconnect = (
    info: { code: number; reason: string } = {
      code: 1006,
      reason: 'test disconnect',
    },
  ): void => {
    const t = obj.transport;
    if (!t) throw new Error('test helper: no transport - call open() first');
    t.closedWith = { code: info.code, reason: info.reason };
    for (const h of [...t.closeHandlers]) h(info);
  };
  return obj as CapturedWsTransportFactory;
};

const buildStubTokenStore = (
  initial: Record<string, string> = {},
): WebclientTokenStore => {
  const plaintextByTokenId = new Map<string, string>(Object.entries(initial));
  return {
    async wrap({ token_id, bearer, aad }) {
      if (aad.token_id !== token_id) {
        throw new Error('stub.tokenStore.wrap: aad.token_id != wrap token_id');
      }
      plaintextByTokenId.set(token_id, bearer);
      return {
        token_id,
        ciphertext_b64: Buffer.from(bearer).toString('base64'),
        iv_b64: 'aXY=',
        issued_at: 1_700_000_000_000,
      };
    },
    async unwrap(record, aad) {
      if (aad.token_id !== record.token_id) {
        throw new Error('stub.tokenStore.unwrap: aad.token_id != record token_id');
      }
      const plaintext = plaintextByTokenId.get(record.token_id);
      if (plaintext === undefined) {
        return Buffer.from(record.ciphertext_b64, 'base64').toString('utf8');
      }
      return plaintext;
    },
  };
};

const stubExecutor: BridgeActionExecutor = {
  async execute(_req: ActionExecutorRequest): Promise<ActionExecutorOutcome> {
    return { status: 'ok', outputs: { result: 'stub' } };
  },
};

const baseDeps = (
  overrides: Partial<BridgeServiceWorkerDeps> = {},
): BridgeServiceWorkerDeps => ({
  chromeStorage: buildInMemoryChromeStorage(),
  chromeRuntimeOnMessage: buildCapturedOnMessage(),
  swLifecycle: buildCapturedSwLifecycle(),
  wsTransportFactory: buildCapturedWsTransportFactory(),
  tokenStore: buildStubTokenStore(),
  bridgeVersion: 'test',
  defaultNotificationIconUrl: 'icons/logo.svg',
  actionExecutor: stubExecutor,
  ...overrides,
});

const PAIRED_TOKEN_RECORD: WebclientTokenRecord = {
  token_id: 'tok-abc',
  ciphertext_b64: Buffer.from('bearer').toString('base64'),
  iv_b64: 'aXY=',
  issued_at: 1_700_000_000_000,
};

const buildPairedStorage = (): ChromeStorageLocal =>
  buildInMemoryChromeStorage({
    server_url: 'wss://alice.recued.cloud:8443/ws',
    webclient_token: PAIRED_TOKEN_RECORD,
    server_public_key: 'spki-base64-stub',
    pair_metadata: null,
    cert_pin_state: null,
    chrome_permissions_state: { origins: [] },
    idempotency_cache: { store_name: 'recued.bridge.idempotency', last_flush_at: 0 },
    pending_outbox: { store_name: 'recued.bridge.outbox', depth: 0 },
  });

const buildCommandFixture = (command_id = 'cmd-1'): BridgeCommand => {
  const ingredient = {
    publisher_id: 'pub-1',
    slug: 'slug-1',
    version: '0.0.1',
    surface_kind: 'reading' as const,
    domain_allowlist: ['*://example.com/*'],
    domain_allowlist_signature: 'sig-stub',
  };
  return {
    command_id,
    recipe_run_id: 'run-1',
    step_id: 'step-1',
    ingredient,
    action: 'read_dom',
    target_domain_pattern: '*://example.com/*',
    args: {},
    expects_output_keys: ['result'],
    timeout_ms: 5000,
    idempotency_key: `idem-${command_id}`,
  };
};

const buildExecutorTestDeps = (): Partial<BridgeServiceWorkerDeps> => {
  const grants = createInMemoryBridgeGrantStore();
  void grants.put({
    publisher_id: 'pub-1',
    slug: 'slug-1',
    version: '0.0.1',
    granted_origins: ['*://example.com/*'],
    granted_at: Date.now(),
  });
  return { grants };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('D-169 P0 Slice 3 - bootBridgeServiceWorker rpc conn bootstrap', () => {
  let factory: CapturedWsTransportFactory;

  const bootPaired = async (
    overrides: Partial<BridgeServiceWorkerDeps> = {},
  ): ReturnType<typeof bootBridgeServiceWorker> => {
    const handle = await bootBridgeServiceWorker(
      baseDeps({
        chromeStorage: buildPairedStorage(),
        wsTransportFactory: factory,
        ...overrides,
      }),
    );
    await flushAsyncWork();
    // D-169 P2 Slice 1+2 — the bridge fires connect-time rpcs on every
    // (re)connect: `events.subscribe` (Slice 1 bus subscription) +
    // `execution.recent` / `notification.recent` / `notification.pending_asks`
    // (Slice 2 historical seed via `fetchAndSeedHistory`). Drain them all
    // here (reply + reset the captured frames) so each rpc-multiplex test
    // below asserts from a clean slate; the connect-time behaviors have
    // their own dedicated P2 tests.
    const connectTimeReplies: Record<string, unknown> = {
      'events.subscribe': { cursor: 0, replay_count: 0, fell_off_ring: false },
      'execution.recent': { executions: [] },
      'notification.recent': { notifications: [] },
      'notification.pending_asks': { asks: [] },
    };
    for (const f of factory.sentFrames()) {
      let parsed: { method?: unknown; request_id?: unknown };
      try {
        parsed = JSON.parse(f) as { method?: unknown; request_id?: unknown };
      } catch {
        continue;
      }
      const method = typeof parsed.method === 'string' ? parsed.method : '';
      if (method in connectTimeReplies && typeof parsed.request_id === 'string') {
        factory.fireMessage(
          JSON.stringify({
            type: 'rpc_result',
            request_id: parsed.request_id,
            result: connectTimeReplies[method],
          }),
        );
      }
    }
    await flushMicrotasks();
    if (factory.transport) factory.transport.sent.length = 0;
    return handle;
  };

  beforeEach(() => {
    factory = buildCapturedWsTransportFactory();
  });

  it('paired boot exposes rpcConn and wsClient', async () => {
    const handle = await bootPaired();

    expect(handle.paired).toBe(true);
    expect(handle.wsClient).not.toBeNull();
    expect(handle.rpcConn).not.toBeNull();
    expect(factory.openCalls).toBe(1);

    await handle.stop();
  });

  it('unpaired boot keeps rpcConn null', async () => {
    const handle = await bootBridgeServiceWorker(baseDeps({ wsTransportFactory: factory }));

    expect(handle.paired).toBe(false);
    expect(handle.wsClient).toBeNull();
    expect(handle.rpcConn).toBeNull();
    expect(factory.openCalls).toBe(0);

    await handle.stop();
  });

  it('routes inbound rpc_result frames to rpcConn', async () => {
    const handle = await bootPaired();
    expect(handle.rpcConn).not.toBeNull();

    const result = handle.rpcConn!.call('some.method' as never, undefined as never);
    await flushMicrotasks();
    const request = JSON.parse(factory.sentFrames()[0]) as {
      type: string;
      request_id: string;
    };

    factory.fireMessage(
      JSON.stringify({
        type: 'rpc_result',
        request_id: request.request_id,
        result: { ok: true },
      }),
    );

    await expect(result).resolves.toEqual({ ok: true });
    await handle.stop();
  });

  it('routes command envelopes to the bridge envelope router', async () => {
    const execute = vi.fn(async (
      _req: ActionExecutorRequest,
    ): Promise<ActionExecutorOutcome> => ({ status: 'ok', outputs: { result: 'stub' } }));
    const handle = await bootPaired({
      ...buildExecutorTestDeps(),
      actionExecutor: { execute },
    });
    const command = buildCommandFixture();

    factory.fireMessage(JSON.stringify({ kind: 'command', command }));
    await flushAsyncWork();

    expect(execute).toHaveBeenCalledTimes(1);
    const frames = factory.sentFrames();
    expect(frames.length).toBe(1);
    const sent = JSON.parse(frames[0]) as {
      kind: string;
      result: BridgeResult;
    };
    expect(sent.kind).toBe(BRIDGE_RESULT_ENVELOPE_KIND);
    expect(sent.result.command_id).toBe(command.command_id);
    expect(sent.result.status).toBe('ok');

    await handle.stop();
  });

  it('drops mixed-discriminator frames without settling rpc or dispatching command', async () => {
    const execute = vi.fn(async (
      _req: ActionExecutorRequest,
    ): Promise<ActionExecutorOutcome> => ({ status: 'ok', outputs: { result: 'stub' } }));
    const handle = await bootPaired({
      ...buildExecutorTestDeps(),
      actionExecutor: { execute },
    });
    const result = handle.rpcConn!.call('mixed.method' as never, {} as never);
    await flushMicrotasks();
    const request = JSON.parse(factory.sentFrames()[0]) as {
      request_id: string;
    };
    const baselineFrames = factory.sentFrames().length;

    factory.fireMessage(
      JSON.stringify({
        type: 'rpc_result',
        request_id: request.request_id,
        result: { should_drop: true },
        kind: 'command',
        command: buildCommandFixture('cmd-mixed'),
      }),
    );
    await flushAsyncWork();

    expect(execute).not.toHaveBeenCalled();
    expect(factory.sentFrames().length).toBe(baselineFrames);
    expect((await readPromiseState(result)).status).toBe('pending');
    expect(handle.rpcConn!.pendingCount()).toBe(1);

    factory.fireMessage(
      JSON.stringify({
        type: 'rpc_result',
        request_id: request.request_id,
        result: { ok: true },
      }),
    );
    await expect(result).resolves.toEqual({ ok: true });
    await handle.stop();
  });

  it('drops unknown frames silently', async () => {
    const execute = vi.fn(async (
      _req: ActionExecutorRequest,
    ): Promise<ActionExecutorOutcome> => ({ status: 'ok', outputs: { result: 'stub' } }));
    const handle = await bootPaired({ actionExecutor: { execute } });

    expect(() => factory.fireMessage(JSON.stringify({ foo: 'bar' }))).not.toThrow();
    await flushAsyncWork();

    expect(execute).not.toHaveBeenCalled();
    expect(factory.sentFrames()).toEqual([]);

    await handle.stop();
  });

  it('drops malformed JSON silently', async () => {
    const execute = vi.fn(async (
      _req: ActionExecutorRequest,
    ): Promise<ActionExecutorOutcome> => ({ status: 'ok', outputs: { result: 'stub' } }));
    const handle = await bootPaired({ actionExecutor: { execute } });

    expect(() => factory.fireMessage('not-json')).not.toThrow();
    expect(() => factory.fireMessage('{ "kind": ')).not.toThrow();
    await flushAsyncWork();

    expect(execute).not.toHaveBeenCalled();
    expect(factory.sentFrames()).toEqual([]);

    await handle.stop();
  });

  it('stop() disposes rpcConn before ws.stop so pending callers reject promptly', async () => {
    const handle = await bootPaired();
    const result = handle.rpcConn!.call('stop.pending' as never, {} as never);
    const rejected = expectRejected(result);

    expect(handle.rpcConn!.pendingCount()).toBe(1);
    await handle.stop();

    expectRpcError(await rejected, 'transport_disposed', 'stop.pending');
  });

  it('rejects a call from a dropped socket without replaying it and accepts new calls after reconnect', async () => {
    const handle = await bootPaired();
    const conn = handle.rpcConn!;
    const oldFrames = factory.transport!.sent;
    const lost = conn.call('lost.write' as never, {} as never);
    const rejected = expectRejected(lost);
    const request = JSON.parse(oldFrames[0]!) as { request_id: string };
    try {
      // bootPaired replied on this socket, so dropping it reconnects immediately.
      factory.disconnect();
      await flushAsyncWork();
      expect((await readPromiseState(lost)).status).toBe('rejected');
      const error = expectRpcError(await rejected, 'connection_lost', 'lost.write');
      expect(error.message).toContain('outcome is unknown');
      expect(factory.openCalls).toBe(2);
      expect(handle.rpcConn).toBe(conn);
      expect(handle.wsClient!.isConnected()).toBe(true);

      const fresh = conn.call('fresh.call' as never, {} as never);
      const currentFrames = factory.sentFrames().map(frame => JSON.parse(frame) as { method?: string; request_id: string });
      const currentRequest = currentFrames.find(frame => frame.method === 'fresh.call')!;
      factory.fireMessage(JSON.stringify({ type: 'rpc_result', request_id: request.request_id, result: 'old result' }));
      expect((await readPromiseState(fresh)).status).toBe('pending');
      factory.fireMessage(JSON.stringify({ type: 'rpc_result', request_id: currentRequest.request_id, result: 'fresh result' }));
      await expect(fresh).resolves.toBe('fresh result');
      expect(oldFrames.map(frame => (JSON.parse(frame) as { method?: string }).method)).toEqual(['lost.write']);
      expect(currentFrames.some(frame => frame.method === 'lost.write')).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  it('writes outbound rpc envelopes through ws.send', async () => {
    const handle = await bootPaired();
    const result = handle.rpcConn!.call('outbound.method' as never, undefined as never);
    await flushMicrotasks();

    const request = JSON.parse(factory.sentFrames()[0]) as {
      type: string;
      request_id: string;
      method: string;
      args: Record<string, unknown>;
    };
    expect(request).toEqual({
      type: 'rpc',
      request_id: request.request_id,
      method: 'outbound.method',
      args: {},
    });

    factory.fireMessage(
      JSON.stringify({
        type: 'rpc_result',
        request_id: request.request_id,
        result: 'ok',
      }),
    );
    await expect(result).resolves.toBe('ok');
    await handle.stop();
  });

  it('maps ws.send throws after transport disconnect to RpcError("transport")', async () => {
    const handle = await bootPaired();
    factory.disconnect();

    const result = handle.rpcConn!.call('send.closed' as never, {} as never);
    const err = expectRpcError(await expectRejected(result), 'transport', 'send.closed');

    expect(err.message).toContain('send called while disconnected');
    expect(handle.rpcConn!.pendingCount()).toBe(0);

    await handle.stop();
  });
});

describe('2026-11-03 - a sign-in the server refuses unpairs the bridge, once', () => {
  /** Ask the worker as the side panel does, and wait for its answer. */
  const ask = (onMessage: CapturedOnMessage, message: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      for (const handler of onMessage.handlers) {
        if (handler(message, {}, resolve) === true) return;
      }
      resolve(undefined);
    });

  for (const code of [4401, 4003]) {
    it(`close ${String(code)}: no more connecting, the pairing cleared but the blocked sites, and the pair form learns which server`, async () => {
      const factory = buildCapturedWsTransportFactory();
      const onMessage = buildCapturedOnMessage();
      const local = buildInMemoryChromeStorage({
        server_url: 'wss://alice.recued.cloud:8443/ws',
        webclient_token: PAIRED_TOKEN_RECORD,
        server_public_key: 'spki-base64-stub',
        pair_metadata: null,
        cert_pin_state: null,
        blocked_sites: ['bank.example'],
      });
      const session = buildInMemoryChromeStorage();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const handle = await bootBridgeServiceWorker(baseDeps({
        chromeStorage: local,
        chromeStorageSession: session,
        chromeRuntimeOnMessage: onMessage,
        wsTransportFactory: factory,
        now: () => 1_234,
      }));
      await flushAsyncWork();
      expect(handle.paired).toBe(true);
      expect(factory.openCalls).toBe(1);

      factory.disconnect({ code, reason: 'refused' });
      await flushAsyncWork();
      await flushAsyncWork();

      // Not one reconnect: it used to come back every ~40 ms, forever.
      expect(factory.openCalls).toBe(1);
      expect(handle.paired).toBe(false);
      expect(await local.get(['server_url', 'webclient_token', 'server_public_key', 'pair_metadata', 'cert_pin_state', 'blocked_sites']))
        .toEqual({ blocked_sites: ['bank.example'] });
      expect(await session.get([BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]))
        .toEqual({ [BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]: { serverUrl: 'https://alice.recued.cloud:8443', at: 1_234 } });
      expect(await ask(onMessage, { type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'status' }))
        .toEqual({ state: 'unpaired', refused: { serverUrl: 'https://alice.recued.cloud:8443' } });
      expect(warn.mock.calls.some((c) => String(c[0]).includes(`(close ${String(code)})`))).toBe(true);
      warn.mockRestore();
      await handle.stop();
    });
  }

  it('an ordinary drop after the server spoke is no refusal: it stays paired and connects again', async () => {
    const factory = buildCapturedWsTransportFactory();
    const local = buildPairedStorage();
    const handle = await bootBridgeServiceWorker(baseDeps({ chromeStorage: local, wsTransportFactory: factory }));
    await flushAsyncWork();
    factory.fireMessage(JSON.stringify({ type: 'pong' }));
    factory.disconnect({ code: 1006, reason: 'network' });
    await flushAsyncWork();
    expect(factory.openCalls).toBe(2);
    expect(handle.paired).toBe(true);
    expect((await local.get(['server_url'])).server_url).toBe('wss://alice.recued.cloud:8443/ws');
    await handle.stop();
  });
});

describe('2026-11-04 - the side panel\'s Disconnect', () => {
  const handles: Awaited<ReturnType<typeof bootBridgeServiceWorker>>[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const handle of handles.splice(0)) await handle.stop();
    vi.restoreAllMocks();
  });
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  };
  const replacement = {
    server_url: 'wss://replacement.example/ws', server_public_key: 'replacement-key',
    webclient_token: { ...PAIRED_TOKEN_RECORD, token_id: 'replacement-token' },
    pair_metadata: { instance_id: 'replacement-instance', paired_at: 2,
      server_passport_fingerprint: 'replacement-fp', server_handle_at_pair: 'replacement' },
  };
  const replacementNote = { serverUrl: 'https://replacement.example', at: 2 };
  const ask = (onMessage: CapturedOnMessage, message: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      for (const handler of onMessage.handlers) {
        if (handler(message, {}, resolve) === true) return;
      }
      resolve(undefined);
    });
  const boot = async (overrides: Partial<BridgeServiceWorkerDeps> = {}) => {
    const factory = buildCapturedWsTransportFactory();
    const onMessage = buildCapturedOnMessage();
    const local = buildInMemoryChromeStorage({
      server_url: 'wss://alice.recued.cloud:8443/ws',
      webclient_token: PAIRED_TOKEN_RECORD,
      server_public_key: 'spki-base64-stub',
      pair_metadata: { paired_at: 1, server_passport_fingerprint: 'fp', server_handle_at_pair: 'alice',
        instance_id: 'inst-bridge-1' },
      cert_pin_state: null,
      blocked_sites: ['bank.example'],
    });
    const session = buildInMemoryChromeStorage();
    const handle = await bootBridgeServiceWorker(baseDeps({
      chromeStorage: local,
      chromeStorageSession: session,
      chromeRuntimeOnMessage: onMessage,
      wsTransportFactory: factory,
      now: () => 4_321,
      ...overrides,
    }));
    handles.push(handle);
    await flushAsyncWork();
    return { factory, onMessage, local, session, handle };
  };
  const revokeRequest = (factory: ReturnType<typeof buildCapturedWsTransportFactory>) => factory.sentFrames()
    .map((frame) => JSON.parse(frame) as { type?: string; method?: string; request_id?: string; args?: unknown })
    .find((frame) => frame.type === 'rpc' && frame.method === 'pair.revoke');

  describe('cancellation of download fallback', () => {
    type Retirement = 'cancel' | 'disconnect' | 'active';
    type PageResult = 'failed' | 'lost' | 'confirmed';
    // Real worker routing, executor, fetch helper and completion cache. Page
    // injection, transport and the HTTP response are controlled adapters.
    const runDownload = async (retirement: Retirement, pageResult: PageResult) => {
      const pending = gate(), began = gate(), completed = gate();
      const address = 'https://cdn.example.net/fixture.bin';
      const bytes = new TextEncoder().encode('fixture-file');
      const data = Buffer.from(bytes).toString('base64');
      const fetched = vi.fn(async () => new Response(bytes, { headers: {
        'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture.bin"',
      } }));
      vi.stubGlobal('fetch', fetched);
      let signal: ActionExecutorRequest['cancel'] | undefined;
      let pageFetches = 0;
      const executor = buildActionExecutor({
        async findTabByUrlPattern() { return null; },
        async executeScript() { return null; },
        async captureVisibleTab() { return null; },
        async showNotification(id) { return id; },
        async blockedSites() { return []; },
        async tabUrl() { return 'https://example.com/form'; },
        async executeInDocument(_target, func) {
          if (func === pageFileAddress) return { document_id: 'DOC7', result: {
            address, cross_origin: true, url: 'https://example.com/form', title: 'Form',
          } };
          if (func !== fetchFile) throw new Error(`unexpected script ${func.name}`);
          pageFetches++;
          began.release();
          await pending.promise;
          return pageResult === 'lost' ? null : { document_id: 'DOC7', result: pageResult === 'failed'
            ? { failed: 'controlled page-side CORS refusal' }
            : { address, filename: 'fixture.bin', mime_type: 'application/octet-stream', size: bytes.length, data } };
        },
      });
      const cache = createInMemoryIdempotencyCache({ now: () => 4_321 });
      const t = await boot({ ...buildExecutorTestDeps(), idempotency: cache,
        actionExecutor: { execute(req) {
          signal = req.cancel;
          return executor.execute(req).finally(completed.release);
        } },
      });
      const command: BridgeCommand = { ...buildCommandFixture(`download-${retirement}-${pageResult}`), action: 'download_file',
        args: { page: '7:DOC7', address }, expects_output_keys: [...BRIDGE_DOWNLOAD_OUTPUT_KEYS], timeout_ms: 10_000,
      };
      try {
        t.factory.fireMessage(JSON.stringify({ kind: 'command', command }));
        await began.promise;
        expect(fetched).not.toHaveBeenCalled();
        if (retirement === 'cancel') t.factory.fireMessage(JSON.stringify({ kind: 'cancel', cancel: { command_id: command.command_id } }));
        if (retirement === 'disconnect') {
          t.factory.disconnect({ code: 1006, reason: 'offline' });
          await expect(ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' }))
            .resolves.toEqual({ ok: true, told_server: false });
        }
        expect(signal?.signalled).toBe(retirement !== 'active');
        pending.release();
        await completed.promise;
        await flushAsyncWork();
        const receipt = (await cache.lookup(command.command_id))?.result;
        const replies = t.factory.sentFrames().map(frame => JSON.parse(frame) as { kind?: string; result?: BridgeResult })
          .filter((frame): frame is { kind: 'result'; result: BridgeResult } => frame.kind === 'result'
            && frame.result?.command_id === command.command_id).map(frame => frame.result);
        return { pageFetches, workerFetches: fetched.mock.calls.length, receipt, replies, address, data };
      } finally { pending.release(); await flushAsyncWork(); await t.handle.stop(); vi.unstubAllGlobals(); }
    };

    it.each((['cancel', 'disconnect'] as const).flatMap(retirement =>
      (['failed', 'lost'] as const).map(pageResult => ({ retirement, pageResult }))))
      ('does not start fallback after $retirement with a $pageResult page result', async ({ retirement, pageResult }) => {
        const t = await runDownload(retirement, pageResult);
        expect(t.pageFetches).toBe(1);
        expect(t.workerFetches).toBe(0);
        expect(t.receipt).toMatchObject({ status: 'cancelled' });
        expect(t.receipt?.outputs).toBeUndefined();
        expect(t.replies.map(reply => reply.status)).toEqual(retirement === 'cancel' ? ['cancelled'] : []);
      });

    it.each(['failed', 'lost'] as const)('still permits active fallback for a %s page result', async pageResult => {
      const t = await runDownload('active', pageResult);
      expect(t.workerFetches).toBe(1);
      expect(t.receipt).toMatchObject({ status: 'ok', outputs: { address: t.address, data: t.data } });
      expect(t.replies).toMatchObject([{ status: 'ok', outputs: { address: t.address, data: t.data } }]);
    });

    it.each(['cancel', 'disconnect'] as const)('preserves a confirmed page result after %s without fallback', async retirement => {
      const t = await runDownload(retirement, 'confirmed');
      expect(t.workerFetches).toBe(0);
      expect(t.receipt).toMatchObject({ status: 'ok', outputs: { address: t.address, data: t.data } });
      expect(t.replies.map(reply => reply.status)).toEqual(retirement === 'cancel' ? ['cancelled'] : []);
      for (const reply of t.replies) expect(reply.outputs).toBeUndefined();
    });
  });

  describe('cancellation of reference retries', () => {
    type Action = 'click' | 'fill' | 'submit' | 'press';
    type Retirement = 'cancel' | 'disconnect';
    type Pause = 'stale' | 'rebind' | 'confirmation';
    const runRetry = async (action: Action, retirement: Retirement, pause: Pause) => {
      const pending = gate(), began = gate();
      let signal: ActionExecutorRequest['cancel'] | undefined;
      let rebinds = 0, writes = 0, applied = 0;
      const operation = { click: 'clickPageElement', fill: 'fillPageField', submit: 'submitPageForm', press: 'pressPageKey' }[action];
      const key = { click: 'clicked', fill: 'filled', submit: 'submitted', press: 'pressed' }[action];
      const outputs = { [key]: action === 'press' ? 'Enter' : true };
      const executor = buildActionExecutor({
        async findTabByUrlPattern() { return null; },
        async executeScript() { return null; },
        async captureVisibleTab() { return null; },
        async showNotification(id) { return id; },
        async executeInDocument(_target, func) {
          if (func.name === 'rebindPageRef') {
            if (++rebinds === 2 && pause === 'rebind') { began.release(); await pending.promise; }
            return { document_id: 'DOC7', result: { kept: true } };
          }
          if (func.name === 'describePageElement') return { document_id: 'DOC7', result: { outputs: {
            url: 'https://example.com/form', title: 'Form', role: action === 'fill' ? 'textbox' : 'button',
            label: 'Control', protected: false,
          } } };
          if (func.name !== operation) throw new Error(`unexpected script ${func.name}`);
          if (++writes === 1) {
            if (pause === 'stale') { began.release(); await pending.promise; }
            return { document_id: 'DOC7', result: { stale: true } };
          }
          if (pause === 'confirmation') { began.release(); await pending.promise; }
          applied++;
          return { document_id: 'DOC7', result: { outputs } };
        },
      });
      const cache = createInMemoryIdempotencyCache({ now: () => 4_321 });
      const t = await boot({ ...buildExecutorTestDeps(), idempotency: cache,
        actionExecutor: { execute(req) { signal = req.cancel; return executor.execute(req); } },
      });
      const command: BridgeCommand = { ...buildCommandFixture(`retry-${action}-${retirement}-${pause}`), action,
        args: { page: '7:DOC7', ref: 'e2', ...(action === 'fill' ? { value: 'draft' } : {}),
          ...(action === 'press' ? { key: 'Enter' } : {}) }, expects_output_keys: [key],
      };
      try {
        t.factory.fireMessage(JSON.stringify({ kind: 'command', command }));
        await began.promise;
        expect(applied).toBe(0);
        if (retirement === 'cancel') {
          t.factory.fireMessage(JSON.stringify({ kind: 'cancel', cancel: { command_id: command.command_id } }));
        } else {
          t.factory.disconnect({ code: 1006, reason: 'offline' });
          await expect(ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' }))
            .resolves.toEqual({ ok: true, told_server: false });
        }
        expect(signal?.signalled).toBe(true);
        pending.release();
        await flushAsyncWork();
        const receipt = (await cache.lookup(command.command_id))?.result;
        const replies = t.factory.sentFrames().map(frame => JSON.parse(frame) as { kind?: string; result?: BridgeResult })
          .filter((frame): frame is { kind: 'result'; result: BridgeResult } => frame.kind === 'result' && !!frame.result)
          .map(frame => frame.result);
        return { writes, rebinds, applied, outputs, receipt, replies };
      } finally { pending.release(); await flushAsyncWork(); }
    };
    const cases: Array<{ action: Action; retirement: Retirement; pause: 'stale' | 'rebind' }> =
      (['click', 'fill', 'submit', 'press'] as const).flatMap(action =>
        (['cancel', 'disconnect'] as const).map(retirement => ({ action, retirement, pause: 'rebind' as const })));
    cases.push({ action: 'click', retirement: 'cancel', pause: 'stale' });

    it.each(cases)('does not retry $action after $retirement at $pause', async ({ action, retirement, pause }) => {
      const result = await runRetry(action, retirement, pause);
      expect(result.writes).toBe(1);
      expect(result.rebinds).toBe(pause === 'stale' ? 1 : 2);
      expect(result.applied).toBe(0);
      expect(result.receipt?.status).toBe('cancelled');
      expect(result.receipt?.outputs).toBeUndefined();
      expect(result.replies.map(reply => reply.status)).toEqual(retirement === 'cancel' ? ['cancelled'] : []);
    });

    it('keeps a confirmed retry receipt when cancellation arrives during that retry', async () => {
      const result = await runRetry('click', 'cancel', 'confirmation');
      expect(result.writes).toBe(2);
      expect(result.applied).toBe(1);
      expect(result.receipt).toMatchObject({ status: 'ok', outputs: result.outputs });
      expect(result.replies).toHaveLength(1);
      expect(result.replies[0].status).toBe('cancelled');
      expect(result.replies[0].outputs).toBeUndefined();
    });
  });

  describe('cancellation while reading the site policy', () => {
    it.each([
      ['open_tab', 'cancel'], ['reviewed_fill', 'cancel'],
      ['open_tab', 'disconnect'], ['reviewed_fill', 'disconnect'],
    ] as const)('does not dispatch %s after %s', async (scenario, retirement) => {
      const pending = gate(), began = gate();
      const browserCalls: string[] = [];
      let signal: ActionExecutorRequest['cancel'] | undefined;
      const executor = buildActionExecutor({
        async blockedSites() { began.release(); await pending.promise; return []; },
        async findTabByUrlPattern() { return null; },
        async executeScript() { return null; },
        async captureVisibleTab() { return null; },
        async showNotification(id) { return id; },
        async openPage(url) {
          browserCalls.push('openPage');
          return { status: 'ok', outputs: { page: '1:DOC1', url, title: 'Opened' } };
        },
        async executeReviewedDocument() {
          browserCalls.push('executeReviewedDocument');
          return { status: 'ok', outputs: { filled: true } };
        },
      });
      const cache = createInMemoryIdempotencyCache({ now: () => 4_321 });
      const t = await boot({ ...buildExecutorTestDeps(), idempotency: cache,
        actionExecutor: { execute(req) { signal = req.cancel; return executor.execute(req); } },
      });
      const command: BridgeCommand = { ...buildCommandFixture(`policy-${scenario}-${retirement}`),
        ...(scenario === 'open_tab'
          ? { action: 'open_tab', args: { url: 'https://example.com/new' }, expects_output_keys: ['page', 'url', 'title'] }
          : { action: 'fill', args: { selector: '#name', value: 'draft' }, expects_output_keys: ['filled'],
            reviewed_document: { tab_id: 7, document_id: 'DOC7', url: 'https://example.com/form' } }),
      };
      try {
        t.factory.fireMessage(JSON.stringify({ kind: 'command', command }));
        await began.promise;
        expect(browserCalls).toEqual([]);
        if (retirement === 'cancel') {
          t.factory.fireMessage(JSON.stringify({ kind: 'cancel', cancel: { command_id: command.command_id } }));
        } else {
          t.factory.disconnect({ code: 1006, reason: 'offline' });
          await expect(ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' }))
            .resolves.toEqual({ ok: true, told_server: false });
        }
        expect(signal?.signalled).toBe(true);
        pending.release();
        await flushAsyncWork();
        expect(browserCalls).toEqual([]);
        const receipt = await cache.lookup(command.command_id);
        expect(receipt?.result.status).toBe('cancelled');
        expect(receipt?.result.outputs).toBeUndefined();
        const replies = t.factory.sentFrames().map(frame => JSON.parse(frame) as { kind?: string; result?: BridgeResult })
          .filter(frame => frame.kind === 'result').map(frame => frame.result);
        expect(replies.map(reply => reply?.status)).toEqual(retirement === 'cancel' ? ['cancelled'] : []);
      } finally { pending.release(); await flushAsyncWork(); }
    });
  });

  describe('command queue ownership after a pairing changes', () => {
    const bootCommands = (overrides: Partial<BridgeServiceWorkerDeps>) => boot({
      ...buildExecutorTestDeps(),
      fetch: async () => new Response(JSON.stringify({ token: 'replacement-bearer', token_id: replacement.webclient_token.token_id })),
      ...overrides,
    });
    const replacePair = async (t: Awaited<ReturnType<typeof boot>>, pair = replacement) => {
      t.factory.disconnect({ code: 1006, reason: 'offline before local disconnect' });
      await expect(ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' }))
        .resolves.toEqual({ ok: true, told_server: false });
      vi.spyOn(pairCompletion, 'finalizeBridgePair').mockImplementation(async () => {
        await t.local.set(pair);
        return { ok: true, server_url: pair.server_url, token_id: pair.webclient_token.token_id };
      });
      await expect(ask(t.onMessage, { type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'start',
        input: { serverUrl: new URL(pair.server_url).origin.replace(/^wss:/, 'https:'), code: '123456' } }))
        .resolves.toMatchObject({ ok: true });
      await flushAsyncWork();
    };
    const sendCommand = (t: Awaited<ReturnType<typeof boot>>, id: string) => {
      t.factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture(id) }));
    };
    const results = (frames: string[]): BridgeResult[] => frames
      .map(frame => JSON.parse(frame) as { kind?: string; result?: BridgeResult })
      .filter((frame): frame is { kind: 'result'; result: BridgeResult } => frame.kind === 'result' && !!frame.result)
      .map(frame => frame.result);

    it.each(['confirmed', 'lost'] as const)(
      'hands queued work to the active connection after the old executor is %s', async (settlement) => {
        const blocked = gate(), began = gate();
        const caches = new Map<string, ReturnType<typeof createInMemoryIdempotencyCache>>();
        const cacheFor = (token: string) => {
          let cache = caches.get(token);
          if (!cache) { cache = createInMemoryIdempotencyCache({ now: () => 4_321 }); caches.set(token, cache); }
          return cache;
        };
        const seen: string[] = [];
        let running = 0, maxRunning = 0;
        const execute = vi.fn(async (req: ActionExecutorRequest): Promise<ActionExecutorOutcome> => {
          seen.push(req.command.command_id);
          maxRunning = Math.max(maxRunning, ++running);
          try {
            if (req.command.command_id === 'old-running') {
              began.release(); await blocked.promise;
              if (settlement === 'lost') throw new Error('executor acknowledgement lost');
            }
            return { status: 'ok', outputs: { result: req.command.command_id } };
          } finally { running -= 1; }
        });
        const t = await bootCommands({ actionExecutor: { execute }, idempotencyForPair: scope => cacheFor(scope.token_id) });
        const oldSend = vi.spyOn(t.handle.wsClient!, 'send');
        try {
          sendCommand(t, 'old-running');
          await began.promise;
          sendCommand(t, 'old-pending');
          await replacePair(t);
          sendCommand(t, 'new-first');
          sendCommand(t, 'new-second');
          await flushAsyncWork();
          expect(seen).toEqual(['old-running']);

          // Admission, rather than the later wake-up, owns the receipt cache.
          await t.local.set({ webclient_token: { ...replacement.webclient_token, token_id: 'rotated-token' } });
          await t.handle.wsClient!.stop();
          await t.handle.wsClient!.start();
          await flushAsyncWork();
          blocked.release();
          await flushAsyncWork();

          expect(seen).toEqual(['old-running', 'new-first', 'new-second']);
          expect(maxRunning).toBe(1);
          expect(results(t.factory.sentFrames()).map(result => [result.command_id, result.status]))
            .toEqual([['new-first', 'ok'], ['new-second', 'ok']]);
          expect(results(oldSend.mock.calls.map(([payload]) => payload)).map(result => result.command_id))
            .not.toContain('new-first');
          for (const id of ['new-first', 'new-second']) {
            expect((await cacheFor(replacement.webclient_token.token_id).lookup(id))?.result.status).toBe('ok');
            expect(await cacheFor(PAIRED_TOKEN_RECORD.token_id).lookup(id)).toBeNull();
            expect(await cacheFor('rotated-token').lookup(id)).toBeNull();
          }
        } finally { blocked.release(); await flushAsyncWork(); }
      },
    );

    it('keeps cancellation with the active runtime after queued work is handed over', async () => {
      const oldBlocked = gate(), oldBegan = gate(), newBlocked = gate(), newBegan = gate();
      let newCancel: ActionExecutorRequest['cancel'] | undefined;
      const newCache = createInMemoryIdempotencyCache({ now: () => 4_321 });
      const oldCache = createInMemoryIdempotencyCache({ now: () => 4_321 });
      const execute = vi.fn(async (req: ActionExecutorRequest): Promise<ActionExecutorOutcome> => {
        if (req.command.command_id === 'old-running') { oldBegan.release(); await oldBlocked.promise; }
        else { newCancel = req.cancel; newBegan.release(); await newBlocked.promise; }
        return { status: 'ok', outputs: { result: 'confirmed completion' } };
      });
      const t = await bootCommands({ actionExecutor: { execute },
        idempotencyForPair: scope => scope.token_id === PAIRED_TOKEN_RECORD.token_id ? oldCache : newCache });
      try {
        sendCommand(t, 'old-running');
        await oldBegan.promise;
        await replacePair(t);
        sendCommand(t, 'new-running');
        oldBlocked.release();
        await newBegan.promise;
        expect(newCancel?.signalled).toBe(false);
        t.factory.fireMessage(JSON.stringify({ kind: 'cancel', cancel: { command_id: 'new-running' } }));
        expect(newCancel?.signalled).toBe(true);
        newBlocked.release();
        await flushAsyncWork();
        expect(results(t.factory.sentFrames())).toMatchObject([{ command_id: 'new-running', status: 'cancelled' }]);
        expect(results(t.factory.sentFrames())[0].outputs).toBeUndefined();
        expect((await newCache.lookup('new-running'))?.result).toMatchObject({ status: 'ok', outputs: { result: 'confirmed completion' } });
        expect(await oldCache.lookup('new-running')).toBeNull();
      } finally { oldBlocked.release(); newBlocked.release(); await flushAsyncWork(); }
    });

    it('hands work to the latest runtime when an intermediate pairing is also retired', async () => {
      const blocked = gate(), began = gate();
      const seen: string[] = [];
      const execute = vi.fn(async (req: ActionExecutorRequest): Promise<ActionExecutorOutcome> => {
        seen.push(req.command.command_id);
        if (req.command.command_id === 'old-running') { began.release(); await blocked.promise; }
        return { status: 'ok', outputs: { result: req.command.command_id } };
      });
      const t = await bootCommands({ actionExecutor: { execute } });
      try {
        sendCommand(t, 'old-running');
        await began.promise;
        await replacePair(t);
        sendCommand(t, 'intermediate-pending');
        await replacePair(t, { ...replacement,
          server_url: 'wss://third.example/ws', server_public_key: 'third-key',
          webclient_token: { ...replacement.webclient_token, token_id: 'third-token' },
          pair_metadata: { ...replacement.pair_metadata, instance_id: 'third-instance' },
        });
        sendCommand(t, 'latest-pending');
        await flushAsyncWork();
        expect(seen).toEqual(['old-running']);
        blocked.release();
        await flushAsyncWork();
        expect(seen).toEqual(['old-running', 'latest-pending']);
        expect(results(t.factory.sentFrames())).toMatchObject([{ command_id: 'latest-pending', status: 'ok' }]);
      } finally { blocked.release(); await flushAsyncWork(); }
    });
  });

  it('keeps replacement command receipts in their namespace after a retired bearer read completes', async () => {
    const pending = gate(), began = gate();
    const tokens = buildStubTokenStore();
    const oldCache = createInMemoryIdempotencyCache({ now: () => 4_321 });
    const newCache = createInMemoryIdempotencyCache({ now: () => 4_321 });
    const tokenStore: WebclientTokenStore = { ...tokens, async unwrap(record, aad) {
      if (record.token_id === PAIRED_TOKEN_RECORD.token_id) { began.release(); await pending.promise; }
      return tokens.unwrap(record, aad);
    } };
    const t = await boot({ ...buildExecutorTestDeps(), tokenStore,
      idempotencyForPair: scope => scope.server_public_key === replacement.server_public_key ? newCache : oldCache,
      fetch: async () => new Response(JSON.stringify({ token: 'replacement-bearer', token_id: replacement.webclient_token.token_id })),
    });
    try {
      await began.promise;
      await expect(ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' }))
        .resolves.toEqual({ ok: true, told_server: false });
      vi.spyOn(pairCompletion, 'finalizeBridgePair').mockImplementation(async () => {
        await t.local.set(replacement);
        return { ok: true, server_url: replacement.server_url, token_id: replacement.webclient_token.token_id };
      });
      await expect(ask(t.onMessage, { type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'start',
        input: { serverUrl: 'https://replacement.example', code: '123456' } })).resolves.toMatchObject({ ok: true });
      await flushAsyncWork();
      const before = buildCommandFixture('replacement-before-old-bearer');
      t.factory.fireMessage(JSON.stringify({ kind: 'command', command: before }));
      await flushAsyncWork();
      expect((await newCache.lookup(before.command_id))?.result.status).toBe('ok');
      expect(await oldCache.lookup(before.command_id)).toBeNull();
      pending.release();
      await flushAsyncWork();
      const after = buildCommandFixture('replacement-after-old-bearer');
      t.factory.fireMessage(JSON.stringify({ kind: 'command', command: after }));
      await flushAsyncWork();
      expect(t.factory.openCalls).toBe(1); // the retired transport still cannot reopen
      expect((await newCache.lookup(after.command_id))?.result.status).toBe('ok');
      expect(await oldCache.lookup(after.command_id)).toBeNull();
    } finally { pending.release(); await flushAsyncWork(); }
  });

  it('keeps the newest same-runtime credential and receipt namespace when reads overlap', async () => {
    const pending = gate(), began = gate();
    const tokens = buildStubTokenStore();
    const initialCache = createInMemoryIdempotencyCache({ now: () => 4_321 });
    const olderCache = createInMemoryIdempotencyCache({ now: () => 4_321 });
    const newestCache = createInMemoryIdempotencyCache({ now: () => 4_321 });
    const t = await boot({ ...buildExecutorTestDeps(), tokenStore: { ...tokens, async unwrap(record, aad) {
      if (record.token_id === 'older-token') { began.release(); await pending.promise; }
      return tokens.unwrap(record, aad);
    } }, idempotencyForPair: scope => scope.token_id === 'newest-token' ? newestCache
      : scope.token_id === 'older-token' ? olderCache : initialCache });
    try {
      const ws = t.handle.wsClient!;
      await ws.stop();
      await t.local.set({ webclient_token: { ...PAIRED_TOKEN_RECORD, token_id: 'older-token' } });
      await ws.start();
      await began.promise;
      await ws.stop();
      await t.local.set({ webclient_token: { ...PAIRED_TOKEN_RECORD, token_id: 'newest-token' } });
      await ws.start();
      await flushAsyncWork();
      const before = buildCommandFixture('newest-before-old-bearer');
      t.factory.fireMessage(JSON.stringify({ kind: 'command', command: before }));
      await flushAsyncWork();
      expect((await newestCache.lookup(before.command_id))?.result.status).toBe('ok');
      pending.release();
      await flushAsyncWork();
      const after = buildCommandFixture('newest-after-old-bearer');
      t.factory.fireMessage(JSON.stringify({ kind: 'command', command: after }));
      await flushAsyncWork();
      expect((await newestCache.lookup(after.command_id))?.result.status).toBe('ok');
      expect(await olderCache.lookup(after.command_id)).toBeNull();
      // The old read must not change the identity used to clear the current
      // credential, either. Exercise that through the real Disconnect path.
      t.factory.fireMessage(JSON.stringify({ type: 'pong' }));
      const answer = ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' });
      await flushAsyncWork();
      t.factory.disconnect({ code: 4003, reason: 'instance revoked' });
      await expect(answer).resolves.toEqual({ ok: true, told_server: true });
      expect(await t.local.get(['webclient_token'])).toEqual({});
    } finally { pending.release(); await flushAsyncWork(); }
  });

  it('does not initialize a receipt namespace after the runtime stops', async () => {
    const pending = gate(), began = gate();
    const tokens = buildStubTokenStore();
    const initialized: string[] = [];
    const t = await boot({ tokenStore: { ...tokens, async unwrap(record, aad) {
      if (record.token_id === 'retired-token') { began.release(); await pending.promise; }
      return tokens.unwrap(record, aad);
    } }, idempotencyForPair: scope => {
      initialized.push(scope.token_id);
      return createInMemoryIdempotencyCache({ now: () => 4_321 });
    } });
    try {
      const ws = t.handle.wsClient!;
      await ws.stop();
      await t.local.set({ webclient_token: { ...PAIRED_TOKEN_RECORD, token_id: 'retired-token' } });
      await ws.start();
      await began.promise;
      await t.handle.stop();
      pending.release();
      await flushAsyncWork();
      expect(t.handle.paired).toBe(false);
      expect(initialized).not.toContain('retired-token');
      expect(t.factory.openCalls).toBe(1);
    } finally { pending.release(); await flushAsyncWork(); }
  });

  it('shares one revoke and its confirmed receipt across concurrent panel requests', async () => {
    const t = await boot();
    t.factory.fireMessage(JSON.stringify({ type: 'pong' }));
    const first = ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' });
    const second = ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' });
    await flushAsyncWork();
    try {
      expect(t.factory.sentFrames().map(frame => JSON.parse(frame)).filter(frame => frame.method === 'pair.revoke')).toHaveLength(1);
    } finally { t.factory.disconnect({ code: 4003, reason: 'instance revoked' }); }
    await expect(second).resolves.toEqual({ ok: true, told_server: true });
    await t.local.set(replacement);
    await expect(first).resolves.toEqual({ ok: true, told_server: true });
    expect(await t.local.get(Object.keys(replacement))).toEqual(replacement);
    expect(await t.session.get([BRIDGE_SIGN_IN_REFUSED_SESSION_KEY])).toEqual({});
  });

  it('does not clear replacement credentials after an older revoke is confirmed', async () => {
    const t = await boot();
    t.factory.fireMessage(JSON.stringify({ type: 'pong' }));
    const answer = ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' });
    await flushAsyncWork();
    await t.local.set(replacement);
    await t.session.set({ [BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]: replacementNote });
    const request = revokeRequest(t.factory)!;
    t.factory.fireMessage(JSON.stringify({ type: 'rpc_result', request_id: request.request_id, result: { ok: true } }));
    await expect(answer).resolves.toEqual({ ok: true, told_server: true });
    expect(await t.local.get(Object.keys(replacement))).toEqual(replacement);
    expect(await t.session.get([BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]))
      .toEqual({ [BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]: replacementNote });
  });

  it('does not write an old disconnected note over a replacement pairing after a failed revoke', async () => {
    const t = await boot();
    t.factory.fireMessage(JSON.stringify({ type: 'pong' }));
    vi.useFakeTimers();
    const answer = ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await t.local.set(replacement);
    await t.session.set({ [BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]: replacementNote });
    const request = revokeRequest(t.factory)!;
    t.factory.fireMessage(JSON.stringify({ type: 'rpc_result', request_id: request.request_id,
      error: { code: 'offline', message: 'not delivered' } }));
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(answer).resolves.toEqual({ ok: true, told_server: false });
    expect(await t.local.get(Object.keys(replacement))).toEqual(replacement);
    expect(await t.session.get([BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]))
      .toEqual({ [BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]: replacementNote });
  });

  it('does not treat a 4401 authentication refusal as confirmation of pair.revoke', async () => {
    const t = await boot();
    t.factory.fireMessage(JSON.stringify({ type: 'pong' }));
    const answer = ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' });
    await flushAsyncWork();
    t.factory.disconnect({ code: 4401, reason: 'bearer rejected' });
    await expect(answer).resolves.toEqual({ ok: true, told_server: false });
    expect(await t.session.get([BRIDGE_SIGN_IN_REFUSED_SESSION_KEY])).toMatchObject({
      [BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]: { kind: 'disconnected', serverUrl: 'https://alice.recued.cloud:8443' },
    });
  });

  it('keeps confirmed revocation evidence when a local clear fails and is retried', async () => {
    const t = await boot();
    const remove = t.local.remove.bind(t.local);
    let failed = false;
    vi.spyOn(t.local, 'remove').mockImplementation(async keys => {
      if (!failed && keys.includes('webclient_token')) { failed = true; throw new Error('local remove failed'); }
      await remove(keys);
    });
    t.factory.fireMessage(JSON.stringify({ type: 'pong' }));
    const answer = ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' });
    await flushAsyncWork();
    t.factory.disconnect({ code: 4003, reason: 'instance revoked' });
    await expect(answer).resolves.toMatchObject({ ok: false, error: 'local remove failed' });
    await expect(ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' }))
      .resolves.toEqual({ ok: true, told_server: true });
    expect(t.factory.sentFrames().map(frame => JSON.parse(frame)).filter(frame => frame.method === 'pair.revoke')).toHaveLength(1);
    expect(await t.session.get([BRIDGE_SIGN_IN_REFUSED_SESSION_KEY])).toEqual({});
    expect(await t.local.get(['webclient_token', 'blocked_sites'])).toEqual({ blocked_sites: ['bank.example'] });
  });

  it('does not let an old sign-in refusal clear or annotate replacement credentials', async () => {
    const t = await boot();
    await t.local.set(replacement);
    await t.session.set({ [BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]: replacementNote });
    t.factory.disconnect({ code: 4003, reason: 'old instance revoked' });
    await vi.waitFor(() => { expect(t.handle.paired).toBe(false); });
    await flushAsyncWork();
    expect(await t.local.get(Object.keys(replacement))).toEqual(replacement);
    expect(await t.session.get([BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]))
      .toEqual({ [BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]: replacementNote });
  });

  it('still disconnects the current pair after its runtime reloads a rotated credential', async () => {
    const t = await boot();
    t.factory.fireMessage(JSON.stringify({ type: 'pong' }));
    await t.local.set({ webclient_token: { ...PAIRED_TOKEN_RECORD, token_id: 'rotated-token' } });
    t.factory.disconnect({ code: 1006, reason: 'reconnect with current credential' });
    await flushAsyncWork();
    expect(t.factory.openCalls).toBe(2);
    t.factory.fireMessage(JSON.stringify({ type: 'pong' }));
    const answer = ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' });
    await flushAsyncWork();
    t.factory.disconnect({ code: 4003, reason: 'instance revoked' });
    await expect(answer).resolves.toEqual({ ok: true, told_server: true });
    expect(await t.local.get(['webclient_token', 'blocked_sites'])).toEqual({ blocked_sites: ['bank.example'] });
    expect(await t.session.get([BRIDGE_SIGN_IN_REFUSED_SESSION_KEY])).toEqual({});
  });

  it('finishes teardown persistence before a replacement pairing can finalize and start', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ token: 'replacement-bearer', token_id: 'replacement-token' })));
    const t = await boot({ fetch: request });
    const removed = gate(), release = gate();
    const remove = t.local.remove.bind(t.local);
    vi.spyOn(t.local, 'remove').mockImplementation(async keys => {
      await remove(keys);
      if (keys.includes('webclient_token')) { removed.release(); await release.promise; }
    });
    const finalize = vi.spyOn(pairCompletion, 'finalizeBridgePair').mockImplementation(async () => {
      await t.local.set(replacement);
      return { ok: true, server_url: replacement.server_url, token_id: replacement.webclient_token.token_id };
    });
    t.factory.fireMessage(JSON.stringify({ type: 'pong' }));
    const disconnect = ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' });
    await flushAsyncWork();
    t.factory.disconnect({ code: 4003, reason: 'instance revoked' });
    await removed.promise;
    const pairing = ask(t.onMessage, { type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'start',
      input: { serverUrl: 'https://replacement.example', code: '123456' } });
    try {
      await flushAsyncWork();
      expect(request).toHaveBeenCalledOnce();
      expect(finalize).not.toHaveBeenCalled();
    } finally {
      release.release();
      await Promise.all([disconnect, pairing]);
    }
    expect(finalize).toHaveBeenCalledOnce();
    await expect(pairing).resolves.toMatchObject({ ok: true });
    expect(t.handle.paired).toBe(true);
    expect(t.factory.openCalls).toBe(2);
    expect(await t.local.get(Object.keys(replacement))).toEqual(replacement);
    expect(await t.session.get([BRIDGE_SIGN_IN_REFUSED_SESSION_KEY])).toEqual({});
  });

  it('asks the server to remove this bridge; the 4003 that answers is no refusal, and the pairing goes', async () => {
    const t = await boot();
    t.factory.fireMessage(JSON.stringify({ type: 'pong' }));
    const answer = ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' });
    await flushAsyncWork();
    expect(revokeRequest(t.factory)).toMatchObject({ args: { instance_id: 'inst-bridge-1' } });
    // The server takes the bridge off and closes its socket before the call's answer can come.
    t.factory.disconnect({ code: 4003, reason: 'instance revoked' });
    await expect(answer).resolves.toEqual({ ok: true, told_server: true });
    await flushAsyncWork();
    expect(t.handle.paired).toBe(false);
    expect(t.factory.openCalls).toBe(1);
    expect(await t.local.get(['server_url', 'webclient_token', 'server_public_key', 'pair_metadata', 'blocked_sites']))
      .toEqual({ blocked_sites: ['bank.example'] });
    // Nothing noted: the owner did this, and the server knows.
    expect(await t.session.get([BRIDGE_SIGN_IN_REFUSED_SESSION_KEY])).toEqual({});
    expect(await ask(t.onMessage, { type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'status' })).toEqual({ state: 'unpaired' });
    await t.handle.stop();
  });

  it('a server that answers the call is told too', async () => {
    const t = await boot();
    t.factory.fireMessage(JSON.stringify({ type: 'pong' }));
    const answer = ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' });
    await flushAsyncWork();
    const request = revokeRequest(t.factory)!;
    t.factory.fireMessage(JSON.stringify({ type: 'rpc_result', request_id: request.request_id, result: { ok: true } }));
    await expect(answer).resolves.toEqual({ ok: true, told_server: true });
    expect(t.handle.paired).toBe(false);
    await t.handle.stop();
  });

  it('a server it cannot reach is not waited for: the pairing goes, and the pair form says the server still lists it', async () => {
    const t = await boot();
    // Down before the server ever spoke: the bridge waits to connect again.
    t.factory.disconnect({ code: 1006, reason: 'network' });
    await flushAsyncWork();
    await expect(ask(t.onMessage, { type: 'recued.bridge.side-panel.disconnect' }))
      .resolves.toEqual({ ok: true, told_server: false });
    expect(revokeRequest(t.factory)).toBeUndefined();
    expect(t.handle.paired).toBe(false);
    expect(await t.local.get(['server_url', 'blocked_sites'])).toEqual({ blocked_sites: ['bank.example'] });
    expect(await ask(t.onMessage, { type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'status' }))
      .toEqual({ state: 'unpaired', disconnected: { serverUrl: 'https://alice.recued.cloud:8443' } });
    await t.handle.stop();
  });
});
