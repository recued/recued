/** D-169 P2 Slice 2 — service-worker historical-seed integration tests.
 *
 *  Drives `fetchAndSeedHistory` + the `fetch-history` responder through
 *  the captured WS transport: on (re)connect the bridge fetches the three
 *  historical-view rpcs and REPLACES the bus buffer's sections; the
 *  side-panel poll then reads the seeded slice. Covers the projection
 *  (run-anchor status mapping, link_url drop, pending-ask shape), the
 *  single-flight generation guard, the all-or-nothing failure isolation,
 *  and the mount-time `fetch-history` responder. */

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
  disconnect(info?: { code: number; reason: string }): void;
  openCalls: number;
  transport: CapturedWsTransport | null;
}
const buildCapturedWsTransportFactory = (): CapturedWsTransportFactory => {
  const obj: Partial<CapturedWsTransportFactory> = { openCalls: 0, transport: null };
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
    info: { code: number; reason: string } = { code: 1006, reason: 'test' },
  ): void => {
    const t = obj.transport;
    if (!t) throw new Error('test helper: no transport - call open() first');
    t.closedWith = { code: info.code, reason: info.reason };
    for (const h of [...t.closeHandlers]) h(info);
  };
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
  args: Record<string, unknown>;
}
const HISTORY_METHODS = [
  'execution.recent',
  'notification.recent',
  'notification.pending_asks',
];

interface HistoryPayload {
  executions?: unknown[];
  notifications?: unknown[];
  asks?: unknown[];
}
const resultFor = (method: string, payload: HistoryPayload): unknown => {
  if (method === 'execution.recent') return { executions: payload.executions ?? [] };
  if (method === 'notification.recent') return { notifications: payload.notifications ?? [] };
  return { asks: payload.asks ?? [] };
};

describe('D-169 P2 Slice 2 - service-worker historical seed', () => {
  let factory: CapturedWsTransportFactory;
  let runtime: CapturedOnMessage;

  beforeEach(() => {
    factory = buildCapturedWsTransportFactory();
    runtime = buildCapturedOnMessage();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  const rpcFrames = (): RpcRequestFrame[] =>
    factory.sentFrames().map((f) => JSON.parse(f) as RpcRequestFrame);
  const historyRequests = (): RpcRequestFrame[] =>
    rpcFrames().filter((f) => HISTORY_METHODS.includes(f.method));

  /** Reply to a specific set of history requests with method-matched
   *  results, then flush so the seed's Promise.all settles. */
  const ackHistory = async (
    requests: RpcRequestFrame[],
    payload: HistoryPayload,
  ): Promise<void> => {
    for (const req of requests) {
      factory.fireMessage(
        JSON.stringify({
          type: 'rpc_result',
          request_id: req.request_id,
          result: resultFor(req.method, payload),
        }),
      );
    }
    await flushMicrotasks();
  };

  const fetchFrames = (): {
    ok: true;
    recipe_results: unknown[];
    notifications: unknown[];
    approvals: unknown[];
  } => {
    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    const handled = responder(
      { type: 'recued.bridge.side-panel.fetch-frames' },
      {},
      sendResponse,
    );
    expect(handled).toBe(true);
    return sendResponse.mock.calls[0]![0] as {
      ok: true;
      recipe_results: unknown[];
      notifications: unknown[];
      approvals: unknown[];
    };
  };

  it('fires execution.recent + notification.recent + notification.pending_asks on connect', async () => {
    const handle = await bootPaired();
    const methods = historyRequests().map((r) => r.method);
    expect(methods).toContain('execution.recent');
    expect(methods).toContain('notification.recent');
    expect(methods).toContain('notification.pending_asks');
    expect(
      (historyRequests().find((r) => r.method === 'execution.recent')!.args as {
        limit?: number;
      }).limit,
    ).toBe(50);
    await handle.stop();
  });

  it('seeds the buffer from the rpc replies, mapping run-anchor status + dropping link_url', async () => {
    const handle = await bootPaired();
    await ackHistory(historyRequests(), {
      executions: [
        { run_id: 'r1', recipe_id: 'rec-1', status: 'succeeded', started_at: 10, duration_ms: 100 },
        { run_id: 'r2', recipe_id: 'rec-2', status: 'failed', started_at: 9, duration_ms: 200, error_category: 'RECIPE_TIMEOUT' },
        { run_id: 'r3', recipe_id: 'rec-3', status: 'awaiting_approval', started_at: 8, duration_ms: 0 },
      ],
      notifications: [
        { id: 'a-1', title: 'Hi', text: 'Body', link_url: 'https://example.test/x', fired_at: 7 },
      ],
      asks: [
        { ask_id: 'ask-1', title: 'Approve?', text: 'Pick', options: [{ id: 'y', label: 'Y' }], created_at: 6 },
      ],
    });

    const snap = fetchFrames();
    expect(snap.recipe_results).toEqual([
      { run_id: 'r1', recipe_id: 'rec-1', status: 'ok', started_at: 10, duration_ms: 100 },
      { run_id: 'r2', recipe_id: 'rec-2', status: 'error', started_at: 9, duration_ms: 200, error_category: 'RECIPE_TIMEOUT' },
      { run_id: 'r3', recipe_id: 'rec-3', status: 'paused', started_at: 8, duration_ms: 0 },
    ]);
    // link_url is dropped — the side-panel notification row has no link field.
    expect(snap.notifications).toEqual([{ id: 'a-1', title: 'Hi', text: 'Body', fired_at: 7 }]);
    expect(snap.approvals).toEqual([
      { ask_id: 'ask-1', title: 'Approve?', text: 'Pick', options: [{ id: 'y', label: 'Y' }], created_at: 6 },
    ]);
    await handle.stop();
  });

  it('generation guard: when an older seed resolves last it does not overwrite a newer seed', async () => {
    const handle = await bootPaired();
    const gen1 = historyRequests(); // connect-time seed (older)

    // Trigger a second seed via the fetch-history responder (newer).
    const responder = runtime.handlers[0]!;
    responder({ type: 'recued.bridge.side-panel.fetch-history' }, {}, vi.fn());
    await flushMicrotasks();
    const gen1Ids = new Set(gen1.map((r) => r.request_id));
    const gen2 = historyRequests().filter((r) => !gen1Ids.has(r.request_id));
    expect(gen2).toHaveLength(3);

    // Resolve the NEWER seed (gen2) first -> it applies.
    await ackHistory(gen2, {
      executions: [{ run_id: 'newest', recipe_id: 'rec-new', status: 'succeeded', started_at: 2, duration_ms: 1 }],
    });
    // Then resolve the OLDER seed (gen1) -> superseded, must be dropped.
    await ackHistory(gen1, {
      executions: [{ run_id: 'stale', recipe_id: 'rec-stale', status: 'succeeded', started_at: 1, duration_ms: 1 }],
    });

    const snap = fetchFrames();
    expect(snap.recipe_results).toEqual([
      { run_id: 'newest', recipe_id: 'rec-new', status: 'ok', started_at: 2, duration_ms: 1 },
    ]);
    await handle.stop();
  });

  it('all-or-nothing: if any history rpc rejects, the buffer is left unseeded', async () => {
    const handle = await bootPaired();
    const reqs = historyRequests();
    // Reply OK to two; reject the third with an rpc error envelope.
    const okReqs = reqs.filter((r) => r.method !== 'notification.pending_asks');
    const failReq = reqs.find((r) => r.method === 'notification.pending_asks')!;
    for (const req of okReqs) {
      factory.fireMessage(
        JSON.stringify({
          type: 'rpc_result',
          request_id: req.request_id,
          result: resultFor(req.method, {
            executions: [{ run_id: 'x', recipe_id: 'rx', status: 'succeeded', started_at: 1, duration_ms: 1 }],
            notifications: [{ id: 'n', text: 'n', fired_at: 1 }],
          }),
        }),
      );
    }
    factory.fireMessage(
      JSON.stringify({
        type: 'rpc_result',
        request_id: failReq.request_id,
        error: { code: 'not_configured', message: 'no ask store' },
      }),
    );
    await flushMicrotasks();

    // Promise.all rejected -> seed skipped -> all sections empty.
    const snap = fetchFrames();
    expect(snap.recipe_results).toEqual([]);
    expect(snap.notifications).toEqual([]);
    expect(snap.approvals).toEqual([]);
    await handle.stop();
  });

  it('fetch-history responder seeds then returns the post-seed snapshot', async () => {
    const handle = await bootPaired();
    // Drain the connect-time seed with empty results first.
    await ackHistory(historyRequests(), {});
    if (factory.transport) factory.transport.sent.length = 0;

    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    const handled = responder(
      { type: 'recued.bridge.side-panel.fetch-history' },
      {},
      sendResponse,
    );
    expect(handled).toBe(true);
    await flushMicrotasks(); // let the responder's seed fire its rpcs

    await ackHistory(historyRequests(), {
      executions: [{ run_id: 'h1', recipe_id: 'rec-h', status: 'succeeded', started_at: 3, duration_ms: 5 }],
      notifications: [{ id: 'hn', text: 'hist', fired_at: 2 }],
    });
    await flushMicrotasks();

    expect(sendResponse).toHaveBeenCalledTimes(1);
    const reply = sendResponse.mock.calls[0]![0] as {
      ok: true;
      recipe_results: unknown[];
      notifications: unknown[];
      approvals: unknown[];
    };
    expect(reply.ok).toBe(true);
    expect(reply.recipe_results).toEqual([
      { run_id: 'h1', recipe_id: 'rec-h', status: 'ok', started_at: 3, duration_ms: 5 },
    ]);
    expect(reply.notifications).toEqual([{ id: 'hn', text: 'hist', fired_at: 2 }]);
    await handle.stop();
  });
});
