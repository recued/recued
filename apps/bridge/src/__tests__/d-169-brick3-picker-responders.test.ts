/** D-169 P2 brick 3 — SW picker responders (launch + result).
 *
 *  Two SW `chrome.runtime.onMessage` branches:
 *   - `recued.bridge.side-panel.launch-picker` → inject the picker into the
 *     active tab via the injector seam; reply the inject outcome.
 *   - the picker's `recued.bridge.picker.result` (from the injected content
 *     script) → on `picked`, derive the url + create the DISARMED watch via
 *     `triggers.createElementWatch`, then push the outcome to the side panel.
 *
 *  Drives the REAL SW through the captured WS transport + captured runtime
 *  onMessage (same inline harness as the submit-answer responder test). */

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
import type {
  BridgePickerInjector,
  PickerInjectOutcome,
} from '../picker/picker-injector.js';
import { PICKER_RESULT_MESSAGE_TYPE } from '../picker/picker-protocol.js';
import type { ChromeStorageLocal } from '../storage/local-store.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import type { WsTransport, WsTransportFactory } from '../transport/ws-client.js';

const NOW = 1_800_000_000_000;
const LAUNCH = 'recued.bridge.side-panel.launch-picker';

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

const stubInjector = (
  outcome: PickerInjectOutcome,
): BridgePickerInjector & { injectIntoActiveTab: ReturnType<typeof vi.fn> } => ({
  injectIntoActiveTab: vi.fn(async () => outcome),
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

const pickerResultMessage = (
  result:
    | { status: 'picked'; selector: string; page_url: string; sample_text: string | null }
    | { status: 'cancelled' },
): unknown => ({ type: PICKER_RESULT_MESSAGE_TYPE, result });

describe('D-169 brick 3 — SW picker responders', () => {
  let factory: CapturedWsTransportFactory;
  let runtime: CapturedOnMessage;
  let pushes: unknown[];
  let sendMessage: (message: unknown) => Promise<unknown>;

  beforeEach(() => {
    factory = buildCapturedWsTransportFactory();
    runtime = buildCapturedOnMessage();
    pushes = [];
    sendMessage = (message: unknown): Promise<unknown> => {
      pushes.push(message);
      return Promise.resolve(undefined);
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rpcFrames = (): RpcRequestFrame[] =>
    factory.sentFrames().map((f) => JSON.parse(f) as RpcRequestFrame);
  const findCreateFrame = (): RpcRequestFrame | undefined =>
    rpcFrames().find((f) => f.method === 'triggers.createElementWatch');
  // Settle every still-open boot-seed rpc so the connect IIFE leaves no
  // dangling promise (the create rpc is settled explicitly in each test).
  const drainSeedRpcs = async (): Promise<void> => {
    for (const f of rpcFrames()) {
      if (f.method === 'triggers.createElementWatch') continue;
      const result =
        f.method === 'execution.recent'
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

  const bootPaired = async (
    overrides: Partial<BridgeServiceWorkerDeps> = {},
  ): ReturnType<typeof bootBridgeServiceWorker> => {
    const handle = await bootBridgeServiceWorker(
      baseDeps({
        chromeStorage: buildPairedStorage(),
        chromeRuntimeOnMessage: runtime,
        wsTransportFactory: factory,
        chromeRuntimeSendMessage: sendMessage,
        ...overrides,
      }),
    );
    await flushAsyncWork();
    return handle;
  };

  it('launch-picker calls the injector and replies its outcome', async () => {
    const injector = stubInjector({ ok: true });
    const handle = await bootPaired({ pickerInjector: injector });
    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();

    const handled = responder({ type: LAUNCH }, {}, sendResponse);
    expect(handled).toBe(true);
    await flushMicrotasks();

    expect(injector.injectIntoActiveTab).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    await handle.stop();
  });

  it('launch-picker replies picker_unavailable when no injector is wired', async () => {
    const handle = await bootPaired();
    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();

    responder({ type: LAUNCH }, {}, sendResponse);
    await flushMicrotasks();

    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      reason: 'picker_unavailable',
    });
    await handle.stop();
  });

  it('a picked result derives the url + creates the watch + pushes the outcome', async () => {
    const handle = await bootPaired({ pickerInjector: stubInjector({ ok: true }) });
    await drainSeedRpcs();
    if (factory.transport) factory.transport.sent.length = 0;

    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    responder(
      pickerResultMessage({
        status: 'picked',
        selector: '[data-test="deal-stage"]',
        page_url: 'https://app.hubspot.com/contacts/123',
        sample_text: 'Closed Won',
      }),
      {},
      sendResponse,
    );
    await flushMicrotasks();

    // The SW issued the create rpc with the leaf-wildcarded url + selector.
    const createFrame = findCreateFrame();
    expect(createFrame).toBeTruthy();
    expect(createFrame!.args).toEqual({
      url: 'https://app.hubspot.com/contacts/*',
      selector: '[data-test="deal-stage"]',
    });

    // Settle the create rpc → the responder pushes + responds.
    factory.fireMessage(
      JSON.stringify({
        type: 'rpc_result',
        request_id: createFrame!.request_id,
        result: { recipe_id: 'rec-1', created: true },
      }),
    );
    await flushMicrotasks();

    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      created: true,
      recipe_id: 'rec-1',
    });
    // The side panel got the create-outcome push for its confirmation line.
    expect(pushes).toContainEqual({
      type: 'recued.bridge.side-panel.picker-result',
      ok: true,
      created: true,
      recipe_id: 'rec-1',
      url: 'https://app.hubspot.com/contacts/*',
    });
    await handle.stop();
  });

  it('a cancelled result creates no watch', async () => {
    const handle = await bootPaired({ pickerInjector: stubInjector({ ok: true }) });
    await drainSeedRpcs();
    if (factory.transport) factory.transport.sent.length = 0;

    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    responder(pickerResultMessage({ status: 'cancelled' }), {}, sendResponse);
    await flushMicrotasks();

    expect(findCreateFrame()).toBeUndefined();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, cancelled: true });
    await handle.stop();
  });

  it('a picked result on a non-web page creates no watch (unsupported_page)', async () => {
    const handle = await bootPaired({ pickerInjector: stubInjector({ ok: true }) });
    await drainSeedRpcs();
    if (factory.transport) factory.transport.sent.length = 0;

    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    responder(
      pickerResultMessage({
        status: 'picked',
        selector: '.x',
        page_url: 'chrome://extensions/',
        sample_text: null,
      }),
      {},
      sendResponse,
    );
    await flushMicrotasks();

    expect(findCreateFrame()).toBeUndefined();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'unsupported_page' });
    expect(pushes).toContainEqual({
      type: 'recued.bridge.side-panel.picker-result',
      ok: false,
      error: 'unsupported_page',
    });
    await handle.stop();
  });

  it('a picked result while unpaired creates no watch (bridge_not_paired)', async () => {
    const handle = await bootBridgeServiceWorker(
      baseDeps({
        chromeRuntimeOnMessage: runtime,
        wsTransportFactory: factory,
        chromeRuntimeSendMessage: sendMessage,
        pickerInjector: stubInjector({ ok: true }),
      }),
    );
    await flushAsyncWork();

    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    responder(
      pickerResultMessage({
        status: 'picked',
        selector: '.x',
        page_url: 'https://app.example.com/a/1',
        sample_text: null,
      }),
      {},
      sendResponse,
    );
    await flushMicrotasks();

    expect(findCreateFrame()).toBeUndefined();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'bridge_not_paired' });
    await handle.stop();
  });
});
