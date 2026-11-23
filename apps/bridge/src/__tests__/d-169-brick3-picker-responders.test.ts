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
import { PICKER_SESSION_TTL_MS } from '../picker/picker-sessions.js';
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
const DOCUMENT = { tab_id: 7, document_id: 'document-7', page_url: 'https://app.hubspot.com/contacts/123' };
const SENDER = { tab: { id: 7 }, frameId: 0, documentId: DOCUMENT.document_id, url: DOCUMENT.page_url };

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
  injectIntoActiveTab: vi.fn(async launch => {
    if (outcome.ok) launch.bind(DOCUMENT);
    return outcome;
  }),
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
  launch_id = 'unmatched',
): unknown => ({ type: PICKER_RESULT_MESSAGE_TYPE, launch_id, result });

describe('D-169 brick 3 — SW picker responders', () => {
  let factory: CapturedWsTransportFactory;
  let runtime: CapturedOnMessage;
  let pushes: unknown[];
  let sendMessage: (message: unknown) => Promise<unknown>;
  let handles: Awaited<ReturnType<typeof bootBridgeServiceWorker>>[];

  beforeEach(() => {
    factory = buildCapturedWsTransportFactory();
    handles = [];
    runtime = buildCapturedOnMessage();
    pushes = [];
    sendMessage = (message: unknown): Promise<unknown> => {
      pushes.push(message);
      return Promise.resolve(undefined);
    };
  });
  afterEach(async () => {
    for (const handle of handles) await handle.stop();
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
    handles.push(handle);
    return handle;
  };
  const launchPicker = async (): Promise<string> => {
    const response = vi.fn();
    runtime.handlers[0]!({ type: LAUNCH }, {}, response);
    await flushMicrotasks();
    const reply = response.mock.calls[0]?.[0] as { ok: boolean; launch_id: string };
    expect(reply?.ok).toBe(true);
    expect(reply.launch_id).toBeTruthy();
    return reply.launch_id;
  };
  const picked = { status: 'picked' as const, selector: '[data-test="deal-stage"]',
    page_url: DOCUMENT.page_url, sample_text: 'Closed Won' };
  const pickerPushes = () => pushes.filter(p => (p as { type?: string }).type === 'recued.bridge.side-panel.picker-result');

  it('rejects a result without a preceding launch', async () => {
    await bootPaired();
    await drainSeedRpcs();
    const response = vi.fn();
    runtime.handlers[0]!(pickerResultMessage(picked, 'unsolicited'), SENDER, response);
    await flushMicrotasks();
    expect(findCreateFrame()).toBeUndefined();
    expect(response).toHaveBeenCalledWith({ ok: false, error: 'picker_session_invalid' });
    expect(pickerPushes()).toEqual([]);
  });

  it('requires matching tab, top frame, document, sender URL and launch ID without consuming a valid launch', async () => {
    await bootPaired({ pickerInjector: stubInjector({ ok: true }) });
    const launch_id = await launchPicker();
    const responder = runtime.handlers[0]!;
    for (const sender of [{}, { ...SENDER, tab: { id: 8 } }, { ...SENDER, frameId: 1 },
      { ...SENDER, documentId: 'same-url-new-document' }, { ...SENDER, url: 'https://other.example/' }]) {
      const response = vi.fn();
      responder(pickerResultMessage(picked, launch_id), sender, response);
      expect(response).toHaveBeenCalledWith({ ok: false, error: 'picker_session_invalid' });
    }
    responder(pickerResultMessage(picked, 'wrong-launch'), SENDER, vi.fn());
    expect(findCreateFrame()).toBeUndefined();
    responder(pickerResultMessage(picked, launch_id), SENDER, vi.fn());
    expect(findCreateFrame()).toBeDefined();
  });

  it('consumes before awaiting the RPC, and cannot replay a failed creation', async () => {
    await bootPaired({ pickerInjector: stubInjector({ ok: true }) });
    const launch_id = await launchPicker();
    const responder = runtime.handlers[0]!;
    const response = vi.fn();
    responder(pickerResultMessage(picked, launch_id), SENDER, response);
    responder(pickerResultMessage(picked, launch_id), SENDER, response);
    expect(rpcFrames().filter(f => f.method === 'triggers.createElementWatch')).toHaveLength(1);
    const frame = findCreateFrame()!;
    factory.fireMessage(JSON.stringify({ type: 'rpc_result', request_id: frame.request_id,
      error: { code: 'failed', message: 'creation failed' } }));
    await flushMicrotasks();
    expect(response).toHaveBeenLastCalledWith({ ok: false, error: 'creation failed' });
    responder(pickerResultMessage(picked, launch_id), SENDER, response);
    expect(rpcFrames().filter(f => f.method === 'triggers.createElementWatch')).toHaveLength(1);
    expect(response).toHaveBeenLastCalledWith({ ok: false, error: 'picker_session_invalid' });
  });

  it('expires unused launches and reports expiry only for the matching document', async () => {
    let clock = NOW;
    await bootPaired({ pickerInjector: stubInjector({ ok: true }), now: () => clock });
    const launch_id = await launchPicker();
    clock += PICKER_SESSION_TTL_MS;
    const response = vi.fn();
    runtime.handlers[0]!(pickerResultMessage(picked, launch_id), SENDER, response);
    expect(findCreateFrame()).toBeUndefined();
    expect(response).toHaveBeenCalledWith({ ok: false, error: 'picker_session_expired' });
    expect(pickerPushes()).toEqual([{ type: 'recued.bridge.side-panel.picker-result', launch_id,
      ok: false, error: 'picker_session_expired' }]);
  });

  it('retires on same-tab navigation and suppresses an already-dispatched result after a new launch', async () => {
    const handle = await bootPaired({ pickerInjector: stubInjector({ ok: true }) });
    const retired = await launchPicker();
    handle.retirePickerForTab(7);
    runtime.handlers[0]!(pickerResultMessage(picked, retired), SENDER, vi.fn());
    expect(findCreateFrame()).toBeUndefined();
    const first = await launchPicker();
    handle.retirePickerForTab(8); // another tab does not retire this bound document
    runtime.handlers[0]!(pickerResultMessage(picked, first), SENDER, vi.fn());
    const frame = findCreateFrame()!;
    expect(frame).toBeDefined();
    const next = await launchPicker();
    expect(next).not.toBe(first);
    factory.fireMessage(JSON.stringify({ type: 'rpc_result', request_id: frame.request_id,
      result: { recipe_id: 'old-watch', created: true } }));
    await flushMicrotasks();
    expect(pickerPushes()).toEqual([]);
  });

  it('retires a launch during preparation, and refuses overlapping injections', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const injector: BridgePickerInjector = { async injectIntoActiveTab(launch) {
      await pending;
      launch.bind(DOCUMENT);
      return { ok: true };
    } };
    const handle = await bootPaired({ pickerInjector: injector });
    const first = vi.fn(), second = vi.fn();
    runtime.handlers[0]!({ type: LAUNCH }, {}, first);
    runtime.handlers[0]!({ type: LAUNCH }, {}, second);
    expect(second).toHaveBeenCalledWith({ ok: false, reason: 'picker_busy' });
    handle.retirePickerForTab(7);
    finish();
    await flushMicrotasks();
    expect(first).toHaveBeenCalledWith({ ok: false, reason: 'picker_session_invalid' });
    expect(findCreateFrame()).toBeUndefined();
  });

  it('retires the pairing before an old RPC completion can publish panel feedback', async () => {
    const handle = await bootPaired({ pickerInjector: stubInjector({ ok: true }) });
    const launch_id = await launchPicker();
    runtime.handlers[0]!(pickerResultMessage(picked, launch_id), SENDER, vi.fn());
    expect(findCreateFrame()).toBeDefined();
    await handle.stop();
    await flushMicrotasks();
    expect(pickerPushes()).toEqual([]);
  });

  it('launch-picker calls the injector and replies its outcome', async () => {
    const injector = stubInjector({ ok: true });
    const handle = await bootPaired({ pickerInjector: injector });
    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();

    const handled = responder({ type: LAUNCH }, {}, sendResponse);
    expect(handled).toBe(true);
    await flushMicrotasks();

    expect(injector.injectIntoActiveTab).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, launch_id: expect.any(String) });
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
    const launch_id = await launchPicker();
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
      }, launch_id),
      SENDER,
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
      launch_id,
      ok: true,
      created: true,
      recipe_id: 'rec-1',
      url: 'https://app.hubspot.com/contacts/*',
    });
    await handle.stop();
  });

  it('a cancelled result creates no watch', async () => {
    const handle = await bootPaired({ pickerInjector: stubInjector({ ok: true }) });
    const launch_id = await launchPicker();
    await drainSeedRpcs();
    if (factory.transport) factory.transport.sent.length = 0;

    const responder = runtime.handlers[0]!;
    const sendResponse = vi.fn();
    responder(pickerResultMessage({ status: 'cancelled' }, launch_id), SENDER, sendResponse);
    await flushMicrotasks();

    expect(findCreateFrame()).toBeUndefined();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, cancelled: true });
    responder(pickerResultMessage(picked, launch_id), SENDER, sendResponse);
    expect(findCreateFrame()).toBeUndefined();
    expect(sendResponse).toHaveBeenLastCalledWith({ ok: false, error: 'picker_session_invalid' });
    await handle.stop();
  });

  it('rejects a result claiming a URL other than its launch document', async () => {
    const handle = await bootPaired({ pickerInjector: stubInjector({ ok: true }) });
    const launch_id = await launchPicker();
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
      }, launch_id),
      SENDER,
      sendResponse,
    );
    await flushMicrotasks();

    expect(findCreateFrame()).toBeUndefined();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'picker_session_invalid' });
    expect(pushes.some(p => (p as { type?: string }).type === 'recued.bridge.side-panel.picker-result')).toBe(false);
    await handle.stop();
  });

  it('an unpaired worker cannot launch or accept a picker result', async () => {
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
    responder({ type: LAUNCH }, {}, sendResponse);
    await flushMicrotasks();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, reason: 'bridge_not_paired' });
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
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'picker_session_invalid' });
    await handle.stop();
  });
});
