/** D-169 P2 Slice 4 — SW `fetch-bridge-mode` responder integration tests.
 *
 *  The side panel polls THIS bridge's own mode via a
 *  `recued.bridge.side-panel.fetch-bridge-mode` runtime message; the SW
 *  proxies it to the self-scoped `notifications.my_bridge_mode` rpc and
 *  returns `{ ok: true, modes }`. Drives the REAL SW through the captured
 *  WS transport + captured runtime onMessage (same inline harness shape as
 *  the Slice-2 / Slice-3 SW tests — there is no shared harness module).
 *
 *  Coverage: the SW issues `notifications.my_bridge_mode` + relays the
 *  server's modes; the not-paired guard returns a typed error with no rpc.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebclientTokenRecord } from '@recued/contracts';
import {
  bootBridgeServiceWorker,
  type BridgeServiceWorkerDeps,
  type BridgeSwLifecycle,
  type ChromeRuntimeOnMessageApi,
} from '../boot/service-worker-bootstrap.js';
import type {
  ActionExecutorOutcome,
  ActionExecutorRequest,
  BridgeActionExecutor,
} from '../queue/dispatcher.js';
import type { ChromeStorageLocal } from '../storage/local-store.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import type { WsTransport, WsTransportFactory } from '../transport/ws-client.js';

const NOW = 1_800_000_000_000;
const FETCH_MODE = 'recued.bridge.side-panel.fetch-bridge-mode';

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
const flushAsyncWork = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const buildInMemoryChromeStorage = (
  seed: Record<string, unknown> = {},
): ChromeStorageLocal => {
  const data = { ...seed };
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in data) out[k] = data[k];
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

const buildCapturedSwLifecycle = (): BridgeSwLifecycle => ({
  onInstall() {},
  onActivate() {},
  async skipWaiting() {},
  async claim() {
    return undefined;
  },
});

interface CapturedOnMessage extends ChromeRuntimeOnMessageApi {
  handlers: Array<
    (
      message: unknown,
      sender: unknown,
      sendResponse: (response: unknown) => void,
    ) => boolean | undefined
  >;
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
  transport: CapturedWsTransport | null;
}
const buildCapturedWsTransportFactory = (): CapturedWsTransportFactory => {
  const obj: Partial<CapturedWsTransportFactory> = { transport: null };
  obj.open = async () => {
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
  return obj as CapturedWsTransportFactory;
};

const buildStubTokenStore = (): WebclientTokenStore => ({
  async wrap({ token_id, bearer }) {
    return {
      token_id,
      ciphertext_b64: Buffer.from(bearer).toString('base64'),
      iv_b64: 'aXY=',
      issued_at: 1_700_000_000_000,
    };
  },
  async unwrap(record) {
    return Buffer.from(record.ciphertext_b64, 'base64').toString('utf8');
  },
});

const stubExecutor: BridgeActionExecutor = {
  async execute(_req: ActionExecutorRequest): Promise<ActionExecutorOutcome> {
    return { status: 'ok', outputs: { result: 'stub' } };
  },
};

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
  now: () => NOW,
  ...overrides,
});

interface RpcRequestFrame {
  type: 'rpc';
  request_id: string;
  method: string;
  args?: Record<string, unknown>;
}

describe('D-169 P2 Slice 4 — SW fetch-bridge-mode responder', () => {
  let factory: CapturedWsTransportFactory;
  let runtime: CapturedOnMessage;

  beforeEach(() => {
    factory = buildCapturedWsTransportFactory();
    runtime = buildCapturedOnMessage();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rpcFrames = (): RpcRequestFrame[] =>
    factory.sentFrames().map((f) => JSON.parse(f) as RpcRequestFrame);
  const findModeFrame = (): RpcRequestFrame | undefined =>
    rpcFrames().find((f) => f.method === 'notifications.my_bridge_mode');
  // Reply to every still-open rpc (connect-time history seed + the mode
  // read) so the responder IIFEs settle and leave no dangling promise.
  const drainRpcs = async (modes: unknown = null): Promise<void> => {
    for (const f of rpcFrames()) {
      const result =
        f.method === 'notifications.my_bridge_mode'
          ? { modes }
          : f.method === 'execution.recent'
            ? { executions: [] }
            : f.method === 'notification.recent'
              ? { notifications: [] }
              : { asks: [] };
      factory.fireMessage(
        JSON.stringify({ type: 'rpc_result', request_id: f.request_id, result }),
      );
    }
    await flushMicrotasks();
  };

  const bootPaired = async (): ReturnType<typeof bootBridgeServiceWorker> => {
    const handle = await bootBridgeServiceWorker(
      baseDeps({
        chromeStorage: buildPairedStorage(),
        chromeRuntimeOnMessage: runtime,
        wsTransportFactory: factory,
      }),
    );
    await flushAsyncWork();
    return handle;
  };

  it('issues notifications.my_bridge_mode and relays the server modes', async () => {
    const handle = await bootPaired();
    expect(factory.transport).not.toBeNull();
    // Drain + clear the connect-time history seed so the mode rpc is the
    // only frame we look at next.
    await drainRpcs();
    if (factory.transport) factory.transport.sent.length = 0;

    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    const handled = responder({ type: FETCH_MODE }, {}, sendResponse);
    expect(handled).toBe(true);
    await flushMicrotasks();

    // The SW issued the self-scoped mode rpc (no args — keyed server-side).
    const frame = findModeFrame();
    expect(frame).toBeTruthy();
    expect(sendResponse).not.toHaveBeenCalled(); // not answered yet

    // Server replies with this bridge's modes → the responder relays them.
    await drainRpcs({ notification: false, approval: true });
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse.mock.calls[0]![0]).toEqual({
      ok: true,
      modes: { notification: false, approval: true },
    });
    await handle.stop();
  });

  it('relays a null modes payload (caller is not a recognised bridge)', async () => {
    const handle = await bootPaired();
    await drainRpcs();
    if (factory.transport) factory.transport.sent.length = 0;

    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    responder({ type: FETCH_MODE }, {}, sendResponse);
    await flushMicrotasks();
    await drainRpcs(null);

    expect(sendResponse).toHaveBeenCalledWith({ ok: true, modes: null });
    await handle.stop();
  });

  it('returns bridge_not_paired without issuing an rpc when unpaired', async () => {
    const handle = await bootBridgeServiceWorker(
      baseDeps({ chromeRuntimeOnMessage: runtime, wsTransportFactory: factory }),
    );
    await flushAsyncWork();

    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    const handled = responder({ type: FETCH_MODE }, {}, sendResponse);
    expect(handled).toBe(true);
    await flushMicrotasks();

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'bridge_not_paired' });
    expect(findModeFrame()).toBeUndefined();
    await handle.stop();
  });
});
