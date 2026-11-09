/** D-169 P2 Slice 3 — SW `submit-answer` responder integration tests.
 *
 *  The side panel's approval card round-trips a chosen option to the SW via
 *  a `recued.bridge.side-panel.submit-answer` runtime message; the SW
 *  funnels it into the server `notification.submitAnswer` rpc (I-11), then
 *  re-seeds history so the answered ask drops out. Drives the REAL SW
 *  through the captured WS transport + captured runtime onMessage (same
 *  inline harness shape as the Slice-2 historical-seed test).
 *
 *  Coverage: I-11 (the SW issues `notification.submitAnswer` with the
 *  card's args), the not-paired guard (no rpc), and the malformed-payload
 *  guard (no rpc). */

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
const SUBMIT = 'recued.bridge.side-panel.submit-answer';

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

describe('D-169 P2 Slice 3 — SW submit-answer responder', () => {
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
  const findSubmitFrame = (): RpcRequestFrame | undefined =>
    rpcFrames().find((f) => f.method === 'notification.submitAnswer');
  // Reply to every still-open history/submit rpc so the responder's IIFE
  // settles and leaves no dangling promise.
  const drainRpcs = async (): Promise<void> => {
    for (const f of rpcFrames()) {
      const result =
        f.method === 'notification.submitAnswer'
          ? { ok: true }
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

  it('issues notification.submitAnswer, then always responds + re-seeds (I-11)', async () => {
    const handle = await bootPaired();
    // Sanity: the harness connected (transport opened) + the connect-time
    // history seed fired, so the rpc conn can actually send.
    expect(factory.transport).not.toBeNull();
    expect(rpcFrames().map((f) => f.method)).toContain('notification.pending_asks');
    // Drain + clear the connect-time seed so the re-seed assertion below
    // counts only the post-submit history rpcs, not the boot seed.
    await drainRpcs();
    if (factory.transport) factory.transport.sent.length = 0;

    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    const handled = responder(
      { type: SUBMIT, ask_id: 'ask-9', option_id: 'send' },
      {},
      sendResponse,
    );
    // Returns true to keep the message channel open for the async sendResponse.
    expect(handled).toBe(true);
    await flushMicrotasks();

    // I-11: the SW issued the standard notification.submitAnswer rpc.
    const submitFrame = findSubmitFrame();
    expect(submitFrame).toBeTruthy();
    expect(submitFrame!.args).toEqual({ ask_id: 'ask-9', option_id: 'send' });
    // Not answered yet → no response, and no re-seed before the submit settles.
    expect(sendResponse).not.toHaveBeenCalled();

    // Settle the submit rpc → the responder re-seeds history (the 3 reads)
    // then responds. Codex LOW-2: assert BOTH the re-seed fired AND the
    // success response landed, not just that the submit rpc was issued.
    await drainRpcs();
    await flushMicrotasks();
    const postSubmitMethods = rpcFrames().map((f) => f.method);
    expect(postSubmitMethods).toContain('execution.recent');
    expect(postSubmitMethods).toContain('notification.recent');
    expect(postSubmitMethods).toContain('notification.pending_asks');
    // Settle the re-seed reads so the responder's IIFE resolves + responds.
    await drainRpcs();
    await flushMicrotasks();
    expect(sendResponse).toHaveBeenCalledTimes(1);
    const reply = sendResponse.mock.calls[0]![0] as {
      ok: boolean;
      recipe_results?: unknown[];
      notifications?: unknown[];
      approvals?: unknown[];
    };
    expect(reply.ok).toBe(true);
    // The success reply carries the post-seed snapshot (the 3 sections).
    expect(reply.recipe_results).toBeDefined();
    expect(reply.notifications).toBeDefined();
    expect(reply.approvals).toBeDefined();
    await handle.stop();
  });

  it('returns bridge_not_paired without issuing an rpc when unpaired', async () => {
    const handle = await bootBridgeServiceWorker(
      baseDeps({ chromeRuntimeOnMessage: runtime, wsTransportFactory: factory }),
    );
    await flushAsyncWork();

    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    const handled = responder(
      { type: SUBMIT, ask_id: 'ask-9', option_id: 'send' },
      {},
      sendResponse,
    );
    expect(handled).toBe(true);
    await flushMicrotasks();

    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: 'bridge_not_paired',
    });
    expect(findSubmitFrame()).toBeUndefined();
    await handle.stop();
  });

  it('rejects a malformed payload without issuing an rpc', async () => {
    const handle = await bootPaired();
    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    responder({ type: SUBMIT, ask_id: '', option_id: 'send' }, {}, sendResponse);
    await flushMicrotasks();

    const reply = sendResponse.mock.calls[0]![0] as {
      ok: boolean;
      error?: string;
    };
    expect(reply.ok).toBe(false);
    expect(findSubmitFrame()).toBeUndefined();

    await drainRpcs();
    await handle.stop();
  });
});
