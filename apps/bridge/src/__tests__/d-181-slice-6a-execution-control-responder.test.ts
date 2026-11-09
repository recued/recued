/** D-181 slice 6a — SW active-executions responder integration tests.
 *
 *  The side panel pulls the live active list (`fetch-active` → `execution.active`
 *  rpc) and routes kill / cancel / promote (`execution-{kill,cancel,promote}` →
 *  the matching `execution.*` rpc). Drives the REAL SW through the captured WS
 *  transport + captured runtime onMessage (same inline harness as the Slice-3
 *  submit-answer test).
 *
 *  Coverage: each responder issues the right rpc with the card's args and
 *  forwards the verdict; the not-paired guard (no rpc); the malformed-payload
 *  guard (no rpc). Server-side auth (the bridge-approval gate) is the
 *  execution-control-handler's concern — exercised in its own slice-4 test. */

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
const FETCH_ACTIVE = 'recued.bridge.side-panel.fetch-active';
const KILL = 'recued.bridge.side-panel.execution-kill';
const CANCEL = 'recued.bridge.side-panel.execution-cancel';
const PROMOTE = 'recued.bridge.side-panel.execution-promote';

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
  args: Record<string, unknown>;
}

describe('D-181 slice 6a — SW execution-control responders', () => {
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
  const findFrame = (method: string): RpcRequestFrame | undefined =>
    rpcFrames().find((f) => f.method === method);
  // Reply to every still-open rpc so each responder's IIFE settles and leaves
  // no dangling promise. Each method gets a plausible result shape.
  const drainRpcs = async (): Promise<void> => {
    for (const f of rpcFrames()) {
      const result =
        f.method === 'execution.active'
          ? { entries: [{ entry_kind: 'run', run_id: 'run-1', recipe_id: 'r' }], lanes: [{ lane: 'local-heavy', capacity: 2, in_use: 1, queued: 0, oldest_wait_ms: 0 }] }
          : f.method === 'execution.kill'
            ? { status: 'killed' }
            : f.method === 'execution.cancel'
              ? { status: 'cancelled_before_dispatch' }
              : f.method === 'execution.promote'
                ? { status: 'promoted' }
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
    // Drain + clear the connect-time history seed so per-test assertions count
    // only the post-message rpcs.
    await drainRpcs();
    if (factory.transport) factory.transport.sent.length = 0;
    return handle;
  };

  const callResponder = async (
    message: Record<string, unknown>,
  ): Promise<{ sendResponse: ReturnType<typeof vi.fn>; handled: boolean | undefined }> => {
    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    const handled = responder(message, {}, sendResponse);
    await flushMicrotasks();
    return { sendResponse, handled };
  };

  it('fetch-active issues execution.active and forwards entries + lanes', async () => {
    const handle = await bootPaired();
    const { sendResponse, handled } = await callResponder({ type: FETCH_ACTIVE });
    expect(handled).toBe(true);

    const frame = findFrame('execution.active');
    expect(frame).toBeTruthy();
    expect(frame!.args).toEqual({});

    await drainRpcs();
    expect(sendResponse).toHaveBeenCalledTimes(1);
    const reply = sendResponse.mock.calls[0]![0] as {
      ok: boolean;
      entries?: unknown[];
      lanes?: unknown[];
    };
    expect(reply.ok).toBe(true);
    expect(reply.entries).toHaveLength(1);
    expect(reply.lanes).toHaveLength(1);
    await handle.stop();
  });

  it('execution-kill issues execution.kill with the run_id + forwards the verdict', async () => {
    const handle = await bootPaired();
    const { sendResponse } = await callResponder({ type: KILL, run_id: 'run-9' });

    const frame = findFrame('execution.kill');
    expect(frame).toBeTruthy();
    expect(frame!.args).toEqual({ run_id: 'run-9' });

    await drainRpcs();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, status: 'killed' });
    await handle.stop();
  });

  it('execution-cancel issues execution.cancel with the queued_call_id', async () => {
    const handle = await bootPaired();
    const { sendResponse } = await callResponder({ type: CANCEL, queued_call_id: 'qc-3' });

    const frame = findFrame('execution.cancel');
    expect(frame).toBeTruthy();
    expect(frame!.args).toEqual({ queued_call_id: 'qc-3' });

    await drainRpcs();
    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      status: 'cancelled_before_dispatch',
    });
    await handle.stop();
  });

  it('execution-promote issues execution.promote with the queued_call_id', async () => {
    const handle = await bootPaired();
    const { sendResponse } = await callResponder({ type: PROMOTE, queued_call_id: 'qc-3' });

    const frame = findFrame('execution.promote');
    expect(frame).toBeTruthy();
    expect(frame!.args).toEqual({ queued_call_id: 'qc-3' });

    await drainRpcs();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, status: 'promoted' });
    await handle.stop();
  });

  it('returns bridge_not_paired without issuing an rpc when unpaired', async () => {
    const handle = await bootBridgeServiceWorker(
      baseDeps({ chromeRuntimeOnMessage: runtime, wsTransportFactory: factory }),
    );
    await flushAsyncWork();

    const { sendResponse } = await callResponder({ type: KILL, run_id: 'run-9' });
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'bridge_not_paired' });
    expect(findFrame('execution.kill')).toBeUndefined();
    await handle.stop();
  });

  it('rejects a malformed mutator payload without issuing an rpc', async () => {
    const handle = await bootPaired();
    const { sendResponse } = await callResponder({ type: KILL, run_id: '' });

    const reply = sendResponse.mock.calls[0]![0] as { ok: boolean; error?: string };
    expect(reply.ok).toBe(false);
    expect(findFrame('execution.kill')).toBeUndefined();

    await drainRpcs();
    await handle.stop();
  });
});
