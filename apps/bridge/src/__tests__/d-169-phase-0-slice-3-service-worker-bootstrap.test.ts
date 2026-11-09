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
import { RpcError } from '@recued/contracts';
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
  const ask = (onMessage: CapturedOnMessage, message: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      for (const handler of onMessage.handlers) {
        if (handler(message, {}, resolve) === true) return;
      }
      resolve(undefined);
    });
  const boot = async () => {
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
    }));
    await flushAsyncWork();
    return { factory, onMessage, local, session, handle };
  };
  const revokeRequest = (factory: ReturnType<typeof buildCapturedWsTransportFactory>) => factory.sentFrames()
    .map((frame) => JSON.parse(frame) as { type?: string; method?: string; request_id?: string; args?: unknown })
    .find((frame) => frame.type === 'rpc' && frame.method === 'pair.revoke');

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
