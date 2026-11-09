/** D-169 P2 Slice 1 - service-worker bus subscription integration tests. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRIDGE_LOCAL_STORAGE_FIELDS, type WebclientTokenRecord } from '@recued/contracts';
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
import type { ChromeNotificationsApi } from '../notifications/dispatcher.js';
import { BRIDGE_DEFAULT_SUBSCRIPTIONS } from '../realtime/subscriber.js';
import type { ChromeStorageLocal } from '../storage/local-store.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import type {
  WsTransport,
  WsTransportFactory,
} from '../transport/ws-client.js';

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
  now: () => NOW,
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

interface RpcRequestFrame {
  type: 'rpc';
  request_id: string;
  method: string;
  args: Record<string, unknown>;
}

const rpcFrames = (factory: CapturedWsTransportFactory): RpcRequestFrame[] =>
  factory.sentFrames().map((frame) => JSON.parse(frame) as RpcRequestFrame);

const subscribeRequests = (
  factory: CapturedWsTransportFactory,
): RpcRequestFrame[] => rpcFrames(factory).filter((f) => f.method === 'events.subscribe');

const ackSubscribeRequests = async (
  factory: CapturedWsTransportFactory,
): Promise<void> => {
  for (const request of subscribeRequests(factory)) {
    factory.fireMessage(
      JSON.stringify({
        type: 'rpc_result',
        request_id: request.request_id,
        result: { cursor: 0, replay_count: 0, fell_off_ring: false },
      }),
    );
  }
  await flushMicrotasks();
};

interface FetchFramesResponse {
  ok: true;
  recipe_results: unknown[];
  notifications: unknown[];
  approvals: unknown[];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('D-169 P2 Slice 1 - service-worker bus subscription', () => {
  let factory: CapturedWsTransportFactory;
  let runtime: CapturedOnMessage;

  beforeEach(() => {
    factory = buildCapturedWsTransportFactory();
    runtime = buildCapturedOnMessage();
  });

  const bootPaired = async (
    overrides: Partial<BridgeServiceWorkerDeps> = {},
  ): ReturnType<typeof bootBridgeServiceWorker> => {
    const handle = await bootBridgeServiceWorker(
      baseDeps({
        chromeStorage: buildPairedStorage(),
        chromeRuntimeOnMessage: runtime,
        wsTransportFactory: factory,
        ...overrides,
      }),
    );
    await flushAsyncWork();
    return handle;
  };

  const clearSentFrames = (): void => {
    if (factory.transport) factory.transport.sent.length = 0;
  };

  const fetchFrames = (): FetchFramesResponse => {
    const responder = runtime.handlers[0];
    if (!responder) throw new Error('test helper: no runtime onMessage handler');
    const sendResponse = vi.fn();
    const handled = responder(
      { type: 'recued.bridge.side-panel.fetch-frames' },
      {},
      sendResponse,
    );

    expect(handled).toBe(true);
    expect(sendResponse).toHaveBeenCalledTimes(1);
    return sendResponse.mock.calls[0]![0] as FetchFramesResponse;
  };

  it('sends events.subscribe with the bridge default kinds on paired connect', async () => {
    const handle = await bootPaired();

    const requests = subscribeRequests(factory);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.args).toEqual({
      kinds: [...BRIDGE_DEFAULT_SUBSCRIPTIONS],
    });

    await ackSubscribeRequests(factory);
    await handle.stop();
  });

  it('feeds inbound notification.notify server_event frames into the side-panel fetch responder', async () => {
    const handle = await bootPaired();
    await ackSubscribeRequests(factory);
    clearSentFrames();

    factory.fireMessage(
      JSON.stringify({
        type: 'server_event',
        event: {
          kind: 'notification.notify',
          title: 'T',
          text: 'B',
          cursor: 1,
        },
      }),
    );

    expect(fetchFrames()).toEqual({
      ok: true,
      recipe_results: [],
      notifications: [
        {
          id: 'notify:1',
          title: 'T',
          text: 'B',
          fired_at: NOW,
        },
      ],
      approvals: [],
    });

    await handle.stop();
  });

  it('drops server_event frames whose inner event kind is unknown', async () => {
    const handle = await bootPaired();
    await ackSubscribeRequests(factory);
    clearSentFrames();

    factory.fireMessage(
      JSON.stringify({
        type: 'server_event',
        event: { kind: 'not-a-kind', cursor: 2 },
      }),
    );

    expect(fetchFrames()).toEqual({
      ok: true,
      recipe_results: [],
      notifications: [],
      approvals: [],
    });

    await handle.stop();
  });

  it('applies notification.ask and notification.ask_closed into an empty approvals fetch', async () => {
    const handle = await bootPaired();
    await ackSubscribeRequests(factory);
    clearSentFrames();

    factory.fireMessage(
      JSON.stringify({
        type: 'server_event',
        event: {
          kind: 'notification.ask',
          ask_id: 'ask-1',
          title: 'Approve?',
          text: 'Choose one',
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
          cursor: 3,
        },
      }),
    );
    expect(fetchFrames().approvals).toEqual([
      {
        ask_id: 'ask-1',
        title: 'Approve?',
        text: 'Choose one',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
        created_at: NOW,
      },
    ]);

    factory.fireMessage(
      JSON.stringify({
        type: 'server_event',
        event: {
          kind: 'notification.ask_closed',
          ask_id: 'ask-1',
          cursor: 4,
        },
      }),
    );

    expect(fetchFrames().approvals).toEqual([]);
    await handle.stop();
  });

  // ⛔ A server from before 2026-10-10 refuses the WHOLE call for one kind it
  // does not send; the Bridge used to log it and get no events until the next
  // reconnect, which asked for the same list again.
  it('an older server refuses one kind it does not send: the Bridge asks again without it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = await bootPaired();
    const first = subscribeRequests(factory);
    expect(first).toHaveLength(1);
    // The frame such a server sends, as captured on the wire
    // (`notification.bridge_mode_changed` arrived 2026-05-29).
    factory.fireMessage(JSON.stringify({
      type: 'rpc_result',
      request_id: first[0]!.request_id,
      error: { code: 'bad_request', message: "events.subscribe: unknown kind 'notification.bridge_mode_changed' (not in BROADCAST_EVENT_KIND_SET)" },
    }));
    await flushAsyncWork();

    const requests = subscribeRequests(factory);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.args).toEqual({
      kinds: BRIDGE_DEFAULT_SUBSCRIPTIONS.filter((k) => k !== 'notification.bridge_mode_changed'),
    });
    factory.fireMessage(JSON.stringify({
      type: 'rpc_result',
      request_id: requests[1]!.request_id,
      result: { cursor: 0, replay_count: 0, fell_off_ring: false },
    }));
    await flushAsyncWork();
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      'bridge.service-worker-bootstrap: this server does not send notification.bridge_mode_changed',
    ]);
    await handle.stop();
  });

  it('fires events.subscribe again after reconnect', async () => {
    const handle = await bootPaired();
    await ackSubscribeRequests(factory);
    clearSentFrames();

    factory.disconnect();
    await flushAsyncWork();

    expect(factory.openCalls).toBe(2);
    const requests = subscribeRequests(factory);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.args).toEqual({
      kinds: [...BRIDGE_DEFAULT_SUBSCRIPTIONS],
    });

    await ackSubscribeRequests(factory);
    await handle.stop();
  });

  describe('D-169 P2 Slice 4 — bridge-mode-changed push to the side panel', () => {
    const BRIDGE_MODE_EVENT = JSON.stringify({
      type: 'server_event',
      event: {
        kind: 'notification.bridge_mode_changed',
        client_token_id: 'tok-abc',
        modes: { notification: true, approval: false },
        cursor: 1,
      },
    });
    const INVALIDATION_MESSAGE = {
      type: 'recued.bridge.side-panel.bridge-mode-invalidated',
    };

    it('pushes a bridge-mode-invalidated message when a notification.bridge_mode_changed event arrives', async () => {
      const chromeRuntimeSendMessage = vi.fn(() => Promise.resolve(undefined));
      const handle = await bootPaired({ chromeRuntimeSendMessage });
      await ackSubscribeRequests(factory);
      // The initial paired connect already fired one push via onConnected;
      // isolate the event-driven push.
      chromeRuntimeSendMessage.mockClear();

      factory.fireMessage(BRIDGE_MODE_EVENT);
      await flushMicrotasks();

      expect(chromeRuntimeSendMessage).toHaveBeenCalledTimes(1);
      expect(chromeRuntimeSendMessage).toHaveBeenCalledWith(INVALIDATION_MESSAGE);

      await handle.stop();
    });

    it('does NOT push for an unrelated event kind', async () => {
      const chromeRuntimeSendMessage = vi.fn(() => Promise.resolve(undefined));
      const handle = await bootPaired({ chromeRuntimeSendMessage });
      await ackSubscribeRequests(factory);
      chromeRuntimeSendMessage.mockClear();

      factory.fireMessage(
        JSON.stringify({
          type: 'server_event',
          event: { kind: 'notification.notify', title: 'T', text: 'B', cursor: 2 },
        }),
      );
      await flushMicrotasks();

      expect(chromeRuntimeSendMessage).not.toHaveBeenCalled();
      await handle.stop();
    });

    it('pushes on the initial paired connect and again on every reconnect (onConnected)', async () => {
      const chromeRuntimeSendMessage = vi.fn(() => Promise.resolve(undefined));
      const handle = await bootPaired({ chromeRuntimeSendMessage });
      await ackSubscribeRequests(factory);

      // Initial connect fired at least one push (covers a panel opened
      // before the first mode change + re-pair to a new server).
      expect(chromeRuntimeSendMessage).toHaveBeenCalledWith(INVALIDATION_MESSAGE);

      chromeRuntimeSendMessage.mockClear();
      factory.disconnect();
      await flushAsyncWork();

      expect(factory.openCalls).toBe(2);
      expect(chromeRuntimeSendMessage).toHaveBeenCalledWith(INVALIDATION_MESSAGE);

      await ackSubscribeRequests(factory);
      await handle.stop();
    });

    it('swallows a rejecting sendMessage (side panel closed = no receiver)', async () => {
      const chromeRuntimeSendMessage = vi.fn(() =>
        Promise.reject(new Error('Could not establish connection')),
      );
      const handle = await bootPaired({ chromeRuntimeSendMessage });
      await ackSubscribeRequests(factory);
      chromeRuntimeSendMessage.mockClear();

      factory.fireMessage(BRIDGE_MODE_EVENT);
      await flushMicrotasks();

      // The rejection is swallowed — the push was attempted and the live
      // view still serves (no crash from the unhandled rejection).
      expect(chromeRuntimeSendMessage).toHaveBeenCalledWith(INVALIDATION_MESSAGE);
      expect(fetchFrames().ok).toBe(true);

      await handle.stop();
    });

    it('no-ops when no chromeRuntimeSendMessage dep is wired', async () => {
      const handle = await bootPaired();
      await ackSubscribeRequests(factory);

      // No push dep — the event must process without throwing.
      expect(() => factory.fireMessage(BRIDGE_MODE_EVENT)).not.toThrow();
      await flushMicrotasks();
      expect(fetchFrames().ok).toBe(true);

      await handle.stop();
    });
  });

  // An approval on the bus, as an OS notification when this Bridge's Notify switch is on
  // (`approval-notices.ts`). Before, a Bridge only listed it in its side panel: the block's own
  // Bridge channel was never wired to one.
  describe('a pending approval as an OS notification', () => {
    const ASK = 'ask-6f1c2c1e-9a5b-4b8e-8f0e-1d2c3b4a5f60';
    const MODE_CHANGED = JSON.stringify({
      type: 'server_event',
      event: { kind: 'notification.bridge_mode_changed', client_token_id: 'tok-abc', modes: { notification: true, approval: false }, cursor: 9 },
    });
    const osNotifications = () => {
      const created: Array<{ id: string; title: string; message: string }> = [];
      const cleared: string[] = [];
      const api: ChromeNotificationsApi = {
        async create(id, options) { created.push({ id, title: options.title, message: options.message }); return id; },
        async clear(id) { cleared.push(id); return true; },
        onClicked: { addListener() {} },
        onClosed: { addListener() {} },
      };
      return { api, created, cleared };
    };
    const askEvent = (cursor: number): string => JSON.stringify({
      type: 'server_event',
      event: {
        kind: 'notification.ask', ask_id: ASK, title: 'Approve: Remove a calendar event — cannot be undone',
        text: '"Dentist" is waiting for your approval.',
        options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }], cursor,
      },
    });
    /** Answer the Bridge's reads of its own switches, as the server would. */
    const answerModeReads = async (notification: boolean): Promise<number> => {
      const reads = rpcFrames(factory).filter((f) => f.method === 'notifications.my_bridge_mode');
      for (const read of reads) {
        factory.fireMessage(JSON.stringify({
          type: 'rpc_result', request_id: read.request_id,
          result: { modes: { notification, approval: false } },
        }));
      }
      await flushAsyncWork();
      return reads.length;
    };

    it('shows it once while Notify is on, with its title, and clears it once it closes', async () => {
      const os = osNotifications();
      // What it keeps of each approval shown goes in a field the Bridge declares (its inspection,
      // its privacy answers and its store's clear read that list), never a key of its own.
      const stored = buildPairedStorage();
      const written: string[] = [];
      const set = stored.set.bind(stored);
      stored.set = async (items) => { written.push(...Object.keys(items)); await set(items); };
      const handle = await bootPaired({ chromeNotifications: os.api, chromeStorage: stored });
      await ackSubscribeRequests(factory);
      clearSentFrames();

      factory.fireMessage(askEvent(1));
      await flushAsyncWork();
      expect(await answerModeReads(true)).toBe(1);
      // Its title, and a fixed line: never its text, which names the event, on a lock screen.
      expect(os.created).toEqual([{ id: `recued-approval-${ASK}`, title: 'Approve: Remove a calendar event — cannot be undone',
        message: 'Waiting for your approval. Click to open it in Recued.' }]);

      // Sent again, as a restart's sweep sends every open approval: not shown again.
      factory.fireMessage(askEvent(2));
      await flushAsyncWork();
      expect(os.created).toHaveLength(1);
      expect(written).toContain('approval_notices_shown');
      expect(written.filter((key) => !BRIDGE_LOCAL_STORAGE_FIELDS.includes(key))).toEqual([]);

      factory.fireMessage(JSON.stringify({ type: 'server_event', event: { kind: 'notification.ask_closed', ask_id: ASK, cursor: 3 } }));
      await flushAsyncWork();
      expect(os.cleared).toEqual([`recued-approval-${ASK}`]);
      await handle.stop();
    });

    it('shows nothing while Notify is off, and reads the switch again once it changes', async () => {
      const os = osNotifications();
      const handle = await bootPaired({ chromeNotifications: os.api });
      await ackSubscribeRequests(factory);
      clearSentFrames();

      factory.fireMessage(askEvent(1));
      await flushAsyncWork();
      await answerModeReads(false);
      expect(os.created).toEqual([]);

      // The owner turns Notify on in Settings.
      clearSentFrames();
      factory.fireMessage(MODE_CHANGED);
      factory.fireMessage(askEvent(2));
      await flushAsyncWork();
      expect(await answerModeReads(true)).toBe(1);
      expect(os.created.map((n) => n.id)).toEqual([`recued-approval-${ASK}`]);
      await handle.stop();
    });

    it('reads the switch again after a reconnect: it may have changed while away', async () => {
      const os = osNotifications();
      const handle = await bootPaired({ chromeNotifications: os.api });
      await ackSubscribeRequests(factory);
      clearSentFrames();
      factory.fireMessage(askEvent(1));
      await flushAsyncWork();
      await answerModeReads(false);
      expect(os.created).toEqual([]);

      // Notify turned on while the Bridge was away, so it heard no mode change.
      factory.disconnect();
      await flushAsyncWork();
      await ackSubscribeRequests(factory);
      clearSentFrames();
      factory.fireMessage(askEvent(2));
      await flushAsyncWork();
      expect(await answerModeReads(true)).toBe(1);
      expect(os.created.map((n) => n.id)).toEqual([`recued-approval-${ASK}`]);
      await handle.stop();
    });
  });
});
