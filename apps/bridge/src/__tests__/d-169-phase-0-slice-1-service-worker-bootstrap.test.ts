import 'fake-indexeddb/auto';
/** D-169 P0 Slice 1 — service-worker bootstrap composition tests.
 *
 *  Covers `apps/bridge/src/boot/service-worker-bootstrap.ts`:
 *   - SW install/activate handlers fire skipWaiting + claim
 *   - Inspect-ping responder returns the typed snapshot for an
 *     unpaired bridge AND a paired bridge
 *   - Unpaired boot: WsClient not constructed; no keepalive alarm;
 *     handle reports paired:false; stop() is a no-op
 *   - Paired boot: WsClient connects via the injected factory;
 *     keepalive alarm installed
 *   - Inbound `command` envelope → dispatchBridgeCommand → result
 *     envelope sent back on the same WS
 *   - Inbound `cancel` envelope → flips cooperative-cancel signal
 *     for the matching in-flight command
 *   - Inbound `notification` envelope → chrome.notifications.create
 *   - Malformed JSON / unknown kind envelopes are dropped silently
 *   - stop() tears down WS + removes keepalive alarm
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createInMemoryIdempotencyCache, type IdempotencyCache } from '../idempotency/cache.js';
import { createIndexedDbIdempotencyCache } from '../idempotency/indexed-db-cache.js';
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
  BridgeWireEnvelope,
  WebclientTokenRecord,
} from '@recued/contracts';
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
import type {
  ChromeAlarmsApi,
  ChromeRuntimeInfoApi,
} from '../transport/keepalive.js';
import type { ChromeNotificationsApi } from '../notifications/dispatcher.js';
import { createInMemoryBridgeGrantStore } from '../permissions/grants.js';
import { createFifoQueue } from '../queue/fifo-queue.js';

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
  skipWaitingCalls: number;
  claimCalls: number;
}

const buildCapturedSwLifecycle = (): CapturedSwLifecycle => {
  const installHandlers: Array<() => void> = [];
  const activateHandlers: Array<(event: { waitUntil(p: Promise<unknown>): void }) => void> = [];
  const obj: CapturedSwLifecycle = {
    installHandlers,
    activateHandlers,
    skipWaitingCalls: 0,
    claimCalls: 0,
    onInstall(handler) {
      installHandlers.push(handler);
    },
    onActivate(handler) {
      activateHandlers.push(handler);
    },
    async skipWaiting() {
      obj.skipWaitingCalls++;
    },
    async claim() {
      obj.claimCalls++;
    },
  };
  return obj;
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

interface CapturedAlarms extends ChromeAlarmsApi {
  created: Array<{ name: string; periodInMinutes: number }>;
  cleared: string[];
  fire(name: string): void;
}

const buildCapturedAlarms = (): CapturedAlarms => {
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const obj: CapturedAlarms = {
    created: [],
    cleared: [],
    create(name, opts) {
      obj.created.push({ name, periodInMinutes: opts.periodInMinutes });
    },
    clear(name) {
      obj.cleared.push(name);
    },
    onAlarm: {
      addListener(handler) {
        alarmListeners.push(handler);
      },
    },
    fire(name) {
      for (const l of [...alarmListeners]) l({ name });
    },
  };
  return obj;
};

const stubChromeRuntimeInfo: ChromeRuntimeInfoApi = {
  async getPlatformInfo() {
    return undefined;
  },
};

interface CapturedNotifications extends ChromeNotificationsApi {
  created: Array<{ id: string; options: unknown }>;
  clicks: Array<(notification_id: string) => void>;
  closes: Array<(notification_id: string, by_user: boolean) => void>;
}

const buildCapturedNotifications = (): CapturedNotifications => {
  const clicks: CapturedNotifications['clicks'] = [];
  const closes: CapturedNotifications['closes'] = [];
  const obj: CapturedNotifications = {
    created: [],
    clicks,
    closes,
    async create(id, options) {
      obj.created.push({ id, options });
      return id;
    },
    async clear() {
      return true;
    },
    onClicked: {
      addListener(handler) {
        clicks.push(handler);
      },
    },
    onClosed: {
      addListener(handler) {
        closes.push(handler);
      },
    },
  };
  return obj;
};

interface CapturedWsTransport extends WsTransport {
  sent: string[];
  messageHandlers: Array<(payload: string) => void>;
  closeHandlers: Array<(info: { code: number; reason: string }) => void>;
  errorHandlers: Array<(err: Error) => void>;
  closedWith: { code?: number; reason?: string } | null;
}

interface CapturedWsTransportFactory extends WsTransportFactory {
  /** Test helper — fires `payload` on the connected transport (the
   *  WsClient's inbound listener observes via the same channel). */
  fireMessage(payload: string): void;
  /** Returns the live transport's outbound buffer. */
  sentFrames(): string[];
  /** Synchronization point — resolves after each successful open(). */
  openCalls: number;
  /** Latest constructed transport, if any. */
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
    if (!t) throw new Error('test helper: no transport — call open() first');
    for (const h of [...t.messageHandlers]) h(payload);
  };
  obj.sentFrames = (): string[] => obj.transport?.sent ?? [];
  return obj as CapturedWsTransportFactory;
};

const stubExecutor: BridgeActionExecutor = {
  async execute(_req: ActionExecutorRequest): Promise<ActionExecutorOutcome> {
    return { status: 'ok', outputs: { result: 'stub' } };
  },
};

/** D-169 P0 Slice 2B — minimal tokenStore stub. `wrap` echoes the
 *  bearer through a deterministic record; `unwrap` returns the
 *  original plaintext by reading from a side-channel map keyed on
 *  `token_id`. Tests that care about wrap-then-unwrap round-trip
 *  inject pre-seeded records via the constructor. */
const buildStubTokenStore = (
  initial: Record<string, string> = {},
): WebclientTokenStore => {
  const plaintextByTokenId = new Map<string, string>(Object.entries(initial));
  return {
    async wrap({ token_id, bearer, aad }) {
      if (aad.token_id !== token_id) {
        throw new Error('stub.tokenStore.wrap: aad.token_id ≠ wrap token_id');
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
        throw new Error('stub.tokenStore.unwrap: aad.token_id ≠ record.token_id');
      }
      const plaintext = plaintextByTokenId.get(record.token_id);
      if (plaintext === undefined) {
        // Fallback: decode from ciphertext_b64 directly (the stub
        // "encrypts" by base64-encoding the plaintext).
        return Buffer.from(record.ciphertext_b64, 'base64').toString('utf8');
      }
      return plaintext;
    },
  };
};

const baseDeps = (
  overrides: Partial<BridgeServiceWorkerDeps>,
): BridgeServiceWorkerDeps => {
  return {
    chromeStorage: buildInMemoryChromeStorage(),
    chromeRuntimeOnMessage: buildCapturedOnMessage(),
    swLifecycle: buildCapturedSwLifecycle(),
    wsTransportFactory: buildCapturedWsTransportFactory(),
    tokenStore: buildStubTokenStore(),
    bridgeVersion: 'test',
    defaultNotificationIconUrl: 'icons/logo.svg',
    actionExecutor: stubExecutor,
    ...overrides,
  };
};

describe('D-169 P0 Slice 1 — bootBridgeServiceWorker (unpaired)', () => {
  it('install + activate handlers fire skipWaiting + claim', async () => {
    const sw = buildCapturedSwLifecycle();
    await bootBridgeServiceWorker(baseDeps({ swLifecycle: sw }));
    expect(sw.installHandlers.length).toBe(1);
    expect(sw.activateHandlers.length).toBe(1);

    sw.installHandlers[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.skipWaitingCalls).toBe(1);

    const waitUntilArgs: Array<Promise<unknown>> = [];
    sw.activateHandlers[0]({
      waitUntil: (p) => {
        waitUntilArgs.push(p);
      },
    });
    await Promise.all(waitUntilArgs);
    expect(sw.claimCalls).toBe(1);
  });

  it('returns paired:false snapshot when storage is empty', async () => {
    const handle = await bootBridgeServiceWorker(baseDeps({}));
    expect(handle.paired).toBe(false);
    expect(handle.wsClient).toBeNull();
    expect(handle.pairSnapshot.local.server_url).toBeNull();
    expect(handle.pairSnapshot.local.webclient_token).toBeNull();
    expect(handle.pairSnapshot.local.server_public_key).toBeNull();
    expect(handle.pairSnapshot.local.pair_metadata).toBeNull();
    expect(handle.pairSnapshot.local.cert_pin_state).toBeNull();
  });

  it('registers an inspect-ping responder regardless of pair state', async () => {
    const onMessage = buildCapturedOnMessage();
    await bootBridgeServiceWorker(baseDeps({ chromeRuntimeOnMessage: onMessage }));
    expect(onMessage.handlers.length).toBe(1);

    let responded: unknown = null;
    const ret = onMessage.handlers[0](
      { type: 'recued.bridge.inspect' },
      undefined,
      (response) => {
        responded = response;
      },
    );
    expect(ret).toBe(true); // async — channel kept open

    // Wait one microtask cycle for the buildBridgeStateInspection
    // Promise chain to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(responded).not.toBeNull();
    expect((responded as { local?: { server_url?: unknown } }).local?.server_url).toBeNull();
  });

  it('ignores chrome.runtime.onMessage payloads with the wrong type', async () => {
    const onMessage = buildCapturedOnMessage();
    await bootBridgeServiceWorker(baseDeps({ chromeRuntimeOnMessage: onMessage }));
    const ret = onMessage.handlers[0]({ type: 'other' }, undefined, () => undefined);
    expect(ret).toBeUndefined(); // not async — Chrome moves on
  });

  it('does not construct the WS pipeline when unpaired', async () => {
    const factory = buildCapturedWsTransportFactory();
    const alarms = buildCapturedAlarms();
    const idempotencyForPair = vi.fn<NonNullable<BridgeServiceWorkerDeps['idempotencyForPair']>>();
    const handle = await bootBridgeServiceWorker(
      baseDeps({
        wsTransportFactory: factory,
        chromeAlarms: alarms,
        chromeRuntimeInfo: stubChromeRuntimeInfo,
        idempotencyForPair,
      }),
    );
    expect(handle.paired).toBe(false);
    expect(factory.openCalls).toBe(0);
    expect(alarms.created.length).toBe(0);
    expect(idempotencyForPair).not.toHaveBeenCalled();
  });

  it('stop() is a no-op when unpaired', async () => {
    const handle = await bootBridgeServiceWorker(baseDeps({}));
    await handle.stop();
    // Reaches here without throwing.
    expect(handle.paired).toBe(false);
  });
});

/** D-169 P0 Slice 2B — paired-storage fixture. The wrapped record is
 *  the same shape the production tokenStore.wrap() emits; the stub
 *  tokenStore in `baseDeps` decodes ciphertext_b64 ('YmVhcmVy' →
 *  'bearer') so the resolveBearer path returns the structured
 *  `${token_id}.bearer` shape without needing a real wrap call. */
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

describe('D-169 P0 Slice 1 — bootBridgeServiceWorker (paired)', () => {
  let factory: CapturedWsTransportFactory;
  let alarms: CapturedAlarms;
  let notifications: CapturedNotifications;
  let swLifecycle: CapturedSwLifecycle;

  beforeEach(() => {
    factory = buildCapturedWsTransportFactory();
    alarms = buildCapturedAlarms();
    notifications = buildCapturedNotifications();
    swLifecycle = buildCapturedSwLifecycle();
  });

  const bootPaired = async (
    overrides: Partial<BridgeServiceWorkerDeps> = {},
  ): ReturnType<typeof bootBridgeServiceWorker> => {
    const deps: BridgeServiceWorkerDeps = baseDeps({
      chromeStorage: buildPairedStorage(),
      wsTransportFactory: factory,
      chromeAlarms: alarms,
      chromeRuntimeInfo: stubChromeRuntimeInfo,
      chromeNotifications: notifications,
      swLifecycle,
      ...overrides,
    });
    const handle = await bootBridgeServiceWorker(deps);
    // The WsClient's start() returns once the loop is scheduled, but
    // open() runs as a microtask. Drain so the transport exists.
    await new Promise((r) => setTimeout(r, 0));
    // D-169 P2 Slice 1 — the bridge fires `events.subscribe` on connect.
    // Reply + reset the captured frames so the inbound-routing assertions
    // below start from a clean slate (the subscribe-on-connect behavior
    // has its own dedicated P2 bus-subscription test).
    const frames = factory.sentFrames();
    const subIdx = frames.findIndex((f) => {
      try {
        return (JSON.parse(f) as { method?: unknown }).method === 'events.subscribe';
      } catch {
        return false;
      }
    });
    if (subIdx >= 0) {
      const req = JSON.parse(frames[subIdx]) as { request_id: string };
      factory.fireMessage(
        JSON.stringify({
          type: 'rpc_result',
          request_id: req.request_id,
          result: { cursor: 0, replay_count: 0, fell_off_ring: false },
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
    }
    if (factory.transport) factory.transport.sent.length = 0;
    return handle;
  };

  it('opens a WS connection via the transport factory', async () => {
    const handle = await bootPaired();
    expect(handle.paired).toBe(true);
    expect(handle.wsClient).not.toBeNull();
    expect(factory.openCalls).toBe(1);
    expect(factory.transport).not.toBeNull();
  });

  it('installs the keepalive alarm', async () => {
    await bootPaired();
    expect(alarms.created.length).toBe(1);
    expect(alarms.created[0].name).toBe('recued.bridge.keepalive');
  });

  it('drops malformed JSON inbound frames silently', async () => {
    await bootPaired();
    factory.fireMessage('not-json');
    factory.fireMessage('{ "kind": ');
    // No throw + no outbound frame emitted.
    expect(factory.sentFrames()).toEqual([]);
  });

  it('drops envelopes with an unknown `kind` silently', async () => {
    await bootPaired();
    factory.fireMessage(JSON.stringify({ kind: 'totally-unknown' }));
    expect(factory.sentFrames()).toEqual([]);
  });

  it('forwards a notification envelope to chrome.notifications.create', async () => {
    await bootPaired();
    const envelope: BridgeWireEnvelope = {
      kind: 'notification',
      notification: {
        notification_id: 'notif-1',
        title: 'Test',
        body: 'Body',
      },
    };
    factory.fireMessage(JSON.stringify(envelope));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifications.created.length).toBe(1);
    expect(notifications.created[0].id).toBe('notif-1');
  });

  it('acknowledges managed reminders only after permission and OS creation, and opens Yours on a click', async () => {
    let permit = true; let finish!: () => void; const accepted = new Promise<void>(resolve => { finish = resolve; }); const opened: string[] = [];
    const chromeNotifications: ChromeNotificationsApi = { ...notifications, getPermissionLevel: async () => permit ? 'granted' : 'denied',
      create: async (id, options) => { await accepted; return notifications.create(id, options); } };
    const handle = await bootPaired({ chromeNotifications, openNotificationUrl: url => { opened.push(url); } });
    const notification_id = `recued-reminder-${'a'.repeat(64)}`;
    factory.fireMessage(JSON.stringify({ kind: 'notification.probe', request_id: 'probe' })); await new Promise(resolve => setTimeout(resolve, 0));
    const receipts = () => factory.sentFrames().map(frame => JSON.parse(frame)).filter(frame => frame.kind === 'notification_receipt').map(frame => frame.receipt);
    expect(receipts()).toContainEqual({ request_id: 'probe', outcome: 'ready' });
    factory.fireMessage(JSON.stringify({ kind: 'notification', receipt_request_id: 'show', notification: { notification_id, title: 'Recued reminder', body: 'Private',
      click_action: { kind: 'open_webclient', path: '/#yours/occurrences' } } }));
    await new Promise(resolve => setTimeout(resolve, 0)); expect(receipts().some(receipt => receipt.request_id === 'show')).toBe(false);
    finish(); await new Promise(resolve => setTimeout(resolve, 0)); expect(receipts()).toContainEqual({ request_id: 'show', outcome: 'displayed', notification_id });
    notifications.clicks[0]!(notification_id); expect(opened).toEqual(['https://alice.recued.cloud:8443/#yours/occurrences']);
    factory.fireMessage(JSON.stringify({ kind: 'notification.clear', request_id: 'clear', notification_id })); await new Promise(resolve => setTimeout(resolve, 0));
    expect(receipts()).toContainEqual({ request_id: 'clear', outcome: 'cleared', notification_id });
    permit = false; factory.fireMessage(JSON.stringify({ kind: 'notification', receipt_request_id: 'denied', notification: { notification_id: 'denied', title: 'Recued', body: '' } }));
    await new Promise(resolve => setTimeout(resolve, 0)); expect(receipts()).toContainEqual({ request_id: 'denied', outcome: 'denied', notification_id: 'denied' });
    expect(notifications.created).toHaveLength(1); await handle.stop();
  });

  it('dispatches a `command` envelope through the executor + sends back a `result` envelope', async () => {
    // Build a verifier-passing command. The trusting verifier means
    // we don't have to compute a real signature for this composition
    // test; verify-authority's own tests cover the real Ed25519 path.
    const command = buildCommandFixture();
    await bootPaired(buildExecutorTestDeps());
    factory.fireMessage(JSON.stringify({ kind: 'command', command }));
    // dispatchBridgeCommand resolves on the executor's promise; let
    // the microtasks settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const frames = factory.sentFrames();
    expect(frames.length).toBe(1);
    const sent = JSON.parse(frames[0]) as {
      kind: string;
      result: BridgeResult;
    };
    expect(sent.kind).toBe(BRIDGE_RESULT_ENVELOPE_KIND);
    expect(sent.result.command_id).toBe(command.command_id);
    expect(sent.result.status).toBe('ok');
  });

  it('replays a retained receipt through a fresh worker and a new command id', async () => {
    const storage = buildPairedStorage();
    const retained = createInMemoryIdempotencyCache();
    const idempotencyForPair = vi.fn(() => retained);
    const execute = vi.fn<BridgeActionExecutor['execute']>(async () => ({ status: 'ok', outputs: { result: 'original' } }));
    for (const command_id of ['first-worker', 'second-worker']) {
      factory = buildCapturedWsTransportFactory();
      const handle = await bootPaired({ ...buildExecutorTestDeps(), chromeStorage: storage,
        idempotencyForPair, actionExecutor: { execute } });
      try {
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture({ command_id }) }));
        await vi.waitFor(() => expect(factory.sentFrames().map(frame => JSON.parse(frame))).toContainEqual({
          kind: 'result', result: expect.objectContaining({ command_id, status: 'ok', outputs: { result: 'original' },
            idempotency_key_seen: command_id === 'second-worker' }),
        }));
      } finally { await handle.stop(); }
    }
    expect(execute).toHaveBeenCalledOnce();
    expect(idempotencyForPair).toHaveBeenCalledWith({ server_public_key: 'spki-base64-stub', token_id: 'tok-abc' });
  });

  describe('persistent receipt composition', () => {
    afterEach(() => vi.restoreAllMocks());

    it('boots and answers inspection with unavailable receipt storage, blocks actions, and recovers when storage returns', async () => {
      const indexedDB = new IDBFactory();
      const queue = createFifoQueue(); const complete = vi.spyOn(queue, 'complete');
      const onMessage = buildCapturedOnMessage();
      const execute = vi.fn<BridgeActionExecutor['execute']>(async () => ({ status: 'ok', outputs: { result: 'recovered' } }));
      const unavailable = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('receipt storage offline'); });
      let handle: Awaited<ReturnType<typeof bootPaired>> | undefined;
      try {
        handle = await bootPaired({ ...buildExecutorTestDeps(), queue, chromeRuntimeOnMessage: onMessage,
          actionExecutor: { execute }, idempotencyForPair: scope => createIndexedDbIdempotencyCache({ scope, indexedDB }) });
        expect(handle.paired).toBe(true);
        expect(handle.pairSnapshot.idempotency.entry_count).toBeNull();
        const inspection = await new Promise<unknown>(resolve => {
          onMessage.handlers[0]!({ type: 'recued.bridge.inspect' }, undefined, resolve);
        });
        expect(inspection).toMatchObject({ idempotency: { entry_count: null },
          local: { server_public_key: 'spki-base64-stub' } });
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture() }));
        await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
        expect(execute).not.toHaveBeenCalled();
        expect(factory.sentFrames()).toEqual([]);
        unavailable.mockRestore();
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture({ command_id: 'recovered' }) }));
        await vi.waitFor(() => expect(factory.sentFrames().map(frame => JSON.parse(frame)))
          .toContainEqual({ kind: 'result', result: expect.objectContaining({ command_id: 'recovered', status: 'ok' }) }));
        expect(execute).toHaveBeenCalledOnce();
      } finally { unavailable.mockRestore(); await handle?.stop(); }
    });

    it('selects durable receipts when an unpaired worker finishes pairing in place', async () => {
      const indexedDB = new IDBFactory();
      const idempotencyForPair = vi.fn<NonNullable<BridgeServiceWorkerDeps['idempotencyForPair']>>(
        scope => createIndexedDbIdempotencyCache({ scope, indexedDB }));
      const onMessage = buildCapturedOnMessage();
      const storage = buildInMemoryChromeStorage();
      const handle = await bootBridgeServiceWorker(baseDeps({ ...buildExecutorTestDeps(),
        chromeStorage: storage, chromeRuntimeOnMessage: onMessage, wsTransportFactory: factory,
        idempotencyForPair, fetch: async () => new Response(JSON.stringify({
          token: 'bearer', token_id: 'paired-in-place',
          passport: { identity: { server_public_key: 'paired-server', current_handle: '' }, network: {} },
        }), { status: 200 }),
      }));
      try {
        expect(handle.paired).toBe(false);
        expect(idempotencyForPair).not.toHaveBeenCalled();
        const outcome = await new Promise<unknown>(resolve => {
          onMessage.handlers[0]!({ type: 'recued.bridge.pair', op: 'start',
            input: { serverUrl: 'https://review.example', code: 'ABC12345' } }, undefined, resolve);
        });
        expect(outcome).toEqual({ ok: true, serverUrl: 'https://review.example' });
        await vi.waitFor(() => expect(factory.openCalls).toBe(1));
        expect(handle.paired).toBe(true);
        expect(idempotencyForPair).toHaveBeenCalledExactlyOnceWith({
          server_public_key: 'paired-server', token_id: 'paired-in-place',
        });
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture() }));
        await vi.waitFor(() => expect(factory.sentFrames().map(frame => JSON.parse(frame)))
          .toContainEqual({ kind: 'result', result: expect.objectContaining({ status: 'ok' }) }));
      } finally { await handle.stop(); }
      expect(await createIndexedDbIdempotencyCache({ indexedDB,
        scope: { server_public_key: 'paired-server', token_id: 'paired-in-place' },
      }).lookup('cmd-1')).not.toBeNull();
    });

    it.each<BridgeResult['status']>(['ok', 'error', 'rejected', 'cancelled', 'timeout'])(
      'replays a committed %s result after restart and a server URL move', async status => {
        const storage = buildPairedStorage();
        const indexedDB = new IDBFactory();
        const idempotencyForPair = vi.fn<NonNullable<BridgeServiceWorkerDeps['idempotencyForPair']>>(
          scope => createIndexedDbIdempotencyCache({ scope, indexedDB }));
        const execute = vi.fn<BridgeActionExecutor['execute']>(async () => ({ status,
          ...(status === 'ok' ? { outputs: { result: 'retained' } }
            : { error: { code: 'capacity_gap_permission_missing', message: 'retained failure' } }),
        }));
        let original: BridgeResult | undefined;
        for (const command_id of ['original', 'retry']) {
          factory = buildCapturedWsTransportFactory();
          const handle = await bootPaired({ ...buildExecutorTestDeps(), chromeStorage: storage,
            idempotencyForPair, actionExecutor: { execute } });
          try {
            factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture({ command_id }) }));
            await vi.waitFor(() => expect(factory.sentFrames().map(frame => JSON.parse(frame)))
              .toContainEqual({ kind: 'result', result: expect.objectContaining({ command_id, status,
                idempotency_key_seen: command_id === 'retry' }) }));
            const receipt = (JSON.parse(factory.sentFrames().find(frame => JSON.parse(frame).kind === 'result')!) as
              { result: BridgeResult }).result;
            if (command_id === 'original') original = receipt;
            else {
              expect(receipt).toEqual({ ...original, command_id: 'retry', idempotency_key_seen: true });
              expect(handle.pairSnapshot.idempotency.entry_count).toBe(1);
            }
          } finally { await handle.stop(); }
          await storage.set({ server_url: 'wss://moved.recued.cloud:8443/ws' });
        }
        expect(execute).toHaveBeenCalledOnce();
        expect(idempotencyForPair).toHaveBeenCalledTimes(2); // A new cache object per worker.
        expect(idempotencyForPair).toHaveBeenCalledWith({ server_public_key: 'spki-base64-stub', token_id: 'tok-abc' });
        const canonical = await idempotencyForPair.mock.results[1]!.value.lookup('original');
        expect(canonical?.result).toEqual(original);
      });

    it('retains each admitted command\'s scope when the reconnect uses a different token', async () => {
      const storage = buildPairedStorage();
      const indexedDB = new IDBFactory();
      const idempotencyForPair = vi.fn<NonNullable<BridgeServiceWorkerDeps['idempotencyForPair']>>(
        scope => createIndexedDbIdempotencyCache({ scope, indexedDB }));
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const execute = vi.fn<BridgeActionExecutor['execute']>(async req => {
        if (req.command.command_id === 'running-old') await blocked;
        return { status: 'ok', outputs: { result: req.command.command_id } };
      });
      const handle = await bootPaired({ ...buildExecutorTestDeps(), chromeStorage: storage,
        idempotencyForPair, actionExecutor: { execute } });
      const send = (command_id: string) => factory.fireMessage(JSON.stringify({ kind: 'command',
        command: buildCommandFixture({ command_id, idempotency_key: command_id }) }));
      try {
        send('running-old'); send('queued-old');
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        await handle.wsClient!.stop();
        await storage.set({ webclient_token: { ...PAIRED_TOKEN_RECORD, token_id: 'new-client' } });
        await handle.wsClient!.start();
        await vi.waitFor(() => expect(factory.openCalls).toBe(2));
        send('queued-new');
        release();
        await vi.waitFor(() => expect(factory.sentFrames().map(frame => JSON.parse(frame))
          .filter(frame => frame.kind === 'result')).toHaveLength(3));
        const old: IdempotencyCache = idempotencyForPair.mock.results[0]!.value;
        const fresh: IdempotencyCache = idempotencyForPair.mock.results[1]!.value;
        expect((await old.list()).map(entry => entry.command_id).sort()).toEqual(['queued-old', 'running-old']);
        expect((await fresh.list()).map(entry => entry.command_id)).toEqual(['queued-new']);
      } finally { release(); await handle.stop(); }
    });

    it('replies cancelled to the original command and replays its confirmed completion after a fresh worker starts', async () => {
      const storage = buildPairedStorage(); const indexedDB = new IDBFactory();
      const idempotencyForPair: NonNullable<BridgeServiceWorkerDeps['idempotencyForPair']> =
        scope => createIndexedDbIdempotencyCache({ scope, indexedDB });
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const observedCancels: boolean[] = [];
      const execute = vi.fn<BridgeActionExecutor['execute']>(async req => {
        await held; observedCancels.push(req.cancel.signalled);
        return { status: 'ok', outputs: { result: 'confirmed original result' } };
      });
      const first = await bootPaired({ ...buildExecutorTestDeps(), chromeStorage: storage,
        idempotencyForPair, actionExecutor: { execute } });
      try {
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture({ command_id: 'cancelled-original' }) }));
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        factory.fireMessage(JSON.stringify({ kind: 'cancel', cancel: { command_id: 'cancelled-original', reason: 'Owner cancelled' } }));
        release();
        await vi.waitFor(() => expect(factory.sentFrames().map(frame => JSON.parse(frame)))
          .toContainEqual({ kind: 'result', result: expect.objectContaining({ command_id: 'cancelled-original', status: 'cancelled' }) }));
        const replies = factory.sentFrames().map(frame => JSON.parse(frame)).filter(frame => frame.kind === 'result');
        expect(replies).toHaveLength(1);
        expect(replies[0].result.outputs).toBeUndefined();
        expect(observedCancels).toEqual([true]);
        const cache = createIndexedDbIdempotencyCache({ indexedDB,
          scope: { server_public_key: 'spki-base64-stub', token_id: 'tok-abc' } });
        expect((await cache.inspectInFlight()).count).toBe(0);
        expect((await cache.lookup('cancelled-original'))?.result).toMatchObject({ status: 'ok', outputs: { result: 'confirmed original result' } });
      } finally { release(); await first.stop(); }

      factory = buildCapturedWsTransportFactory();
      const restarted = await bootPaired({ ...buildExecutorTestDeps(), chromeStorage: storage,
        idempotencyForPair, actionExecutor: { execute } });
      try {
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture({ command_id: 'explicit-retry' }) }));
        await vi.waitFor(() => expect(factory.sentFrames().map(frame => JSON.parse(frame)))
          .toContainEqual({ kind: 'result', result: expect.objectContaining({ command_id: 'explicit-retry', status: 'ok',
            outputs: { result: 'confirmed original result' }, idempotency_key_seen: true }) }));
        expect(execute).toHaveBeenCalledOnce();
      } finally { await restarted.stop(); }
    });

    it('records a late completion in its original pair, sends one reply, and replays after reconnect and restart', async () => {
      const storage = buildPairedStorage(); const indexedDB = new IDBFactory();
      const idempotencyForPair = vi.fn<NonNullable<BridgeServiceWorkerDeps['idempotencyForPair']>>(
        scope => createIndexedDbIdempotencyCache({ scope, indexedDB }));
      let release!: (outcome: ActionExecutorOutcome) => void;
      const late = new Promise<ActionExecutorOutcome>(resolve => { release = resolve; });
      const execute = vi.fn<BridgeActionExecutor['execute']>(req => req.command.command_id === 'late-original'
        ? late : Promise.resolve({ status: 'ok', outputs: { result: 'new pair result' } }));
      const first = await bootPaired({ ...buildExecutorTestDeps(), chromeStorage: storage,
        idempotencyForPair, actionExecutor: { execute } });
      try {
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture({ command_id: 'late-original', timeout_ms: 10 }) }));
        await vi.waitFor(() => expect(factory.sentFrames().map(frame => JSON.parse(frame)))
          .toContainEqual({ kind: 'result', result: expect.objectContaining({ command_id: 'late-original', status: 'timeout' }) }));
        expect(factory.sentFrames().map(frame => JSON.parse(frame)).filter(frame => frame.kind === 'result')).toHaveLength(1);
        await first.wsClient!.stop();
        await storage.set({ webclient_token: { ...PAIRED_TOKEN_RECORD, token_id: 'new-pair' } });
        await first.wsClient!.start();
        await vi.waitFor(() => expect(factory.openCalls).toBe(2));
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture({ command_id: 'new-pair-command' }) }));
        await vi.waitFor(() => expect(factory.sentFrames().map(frame => JSON.parse(frame)))
          .toContainEqual({ kind: 'result', result: expect.objectContaining({ command_id: 'new-pair-command', status: 'ok' }) }));
        const old: IdempotencyCache = idempotencyForPair.mock.results[0]!.value;
        const fresh: IdempotencyCache = idempotencyForPair.mock.results[1]!.value;
        expect((await old.inspectInFlight()).count).toBe(1);
        release({ status: 'ok', outputs: { result: 'confirmed original result' } });
        await vi.waitFor(async () => expect((await old.inspectInFlight()).count).toBe(0));
        expect((await old.lookup('late-original'))?.result.outputs).toEqual({ result: 'confirmed original result' });
        expect((await fresh.list()).map(entry => entry.command_id)).toEqual(['new-pair-command']);
        // The captured transport reports the new socket's frames after reconnect.
        expect(factory.sentFrames().map(frame => JSON.parse(frame)).filter(frame => frame.kind === 'result')).toHaveLength(1);
      } finally { release({ status: 'cancelled' }); await first.stop(); }

      factory = buildCapturedWsTransportFactory();
      await storage.set({ webclient_token: PAIRED_TOKEN_RECORD });
      const restarted = await bootPaired({ ...buildExecutorTestDeps(), chromeStorage: storage,
        idempotencyForPair, actionExecutor: { execute } });
      try {
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture({ command_id: 'explicit-retry' }) }));
        await vi.waitFor(() => expect(factory.sentFrames().map(frame => JSON.parse(frame)))
          .toContainEqual({ kind: 'result', result: expect.objectContaining({ command_id: 'explicit-retry', status: 'ok',
            outputs: { result: 'confirmed original result' }, idempotency_key_seen: true }) }));
        expect(execute).toHaveBeenCalledTimes(2);
      } finally { await restarted.stop(); }
    });

    it('reports uncertainty after a fresh worker retries an action whose receipt could not commit', async () => {
      const storage = buildPairedStorage(); const indexedDB = new IDBFactory();
      const execute = vi.fn<BridgeActionExecutor['execute']>(async () => ({ status: 'ok', outputs: { result: 'acted' } }));
      const idempotencyForPair: NonNullable<BridgeServiceWorkerDeps['idempotencyForPair']> =
        scope => createIndexedDbIdempotencyCache({ scope, indexedDB });
      const queue = createFifoQueue(); const complete = vi.spyOn(queue, 'complete');
      const first = await bootPaired({ ...buildExecutorTestDeps(), chromeStorage: storage,
        queue, idempotencyForPair, actionExecutor: { execute } });
      const put = IDBObjectStore.prototype.put;
      const abort = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
        const request = put.call(this, value, key);
        request.addEventListener('success', () => this.transaction.abort());
        return request;
      });
      try {
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture() }));
        await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
        expect(execute).toHaveBeenCalledOnce();
        expect(factory.sentFrames()).toEqual([]);
      } finally { abort.mockRestore(); await first.stop(); }
      factory = buildCapturedWsTransportFactory();
      const restarted = await bootPaired({ ...buildExecutorTestDeps(), chromeStorage: storage,
        idempotencyForPair, actionExecutor: { execute } });
      try {
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture({ command_id: 'retry-after-restart' }) }));
        await vi.waitFor(() => expect(factory.sentFrames().map(frame => JSON.parse(frame)))
          .toContainEqual({ kind: 'result', result: expect.objectContaining({ command_id: 'retry-after-restart',
            status: 'error', error: expect.objectContaining({ code: 'delivery_uncertain' }), idempotency_key_seen: true }) }));
        expect(execute).toHaveBeenCalledOnce();
      } finally { await restarted.stop(); }
    });

    it('sends no completion for an aborted receipt write and refuses a same-worker retry', async () => {
      const indexedDB = new IDBFactory();
      const queue = createFifoQueue();
      const complete = vi.spyOn(queue, 'complete');
      const execute = vi.fn<BridgeActionExecutor['execute']>(async () => ({ status: 'ok', outputs: { result: 'acted' } }));
      const handle = await bootPaired({ ...buildExecutorTestDeps(), queue, actionExecutor: { execute },
        idempotencyForPair: scope => createIndexedDbIdempotencyCache({ scope, indexedDB }) });
      const put = IDBObjectStore.prototype.put;
      const abort = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
        const request = put.call(this, value, key);
        request.addEventListener('success', () => this.transaction.abort());
        return request;
      });
      try {
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture() }));
        await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
        abort.mockRestore();
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture({ command_id: 'retry' }) }));
        await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
        expect(execute).toHaveBeenCalledOnce();
        expect(factory.sentFrames()).toEqual([]);
      } finally { abort.mockRestore(); await handle.stop(); }
    });

    it('does not execute an action when its receipt lookup fails', async () => {
      const queue = createFifoQueue(); const complete = vi.spyOn(queue, 'complete');
      const indexedDB = new IDBFactory();
      const cache = createIndexedDbIdempotencyCache({ indexedDB,
        scope: { server_public_key: 'spki-base64-stub', token_id: 'tok-abc' } });
      const execute = vi.fn<BridgeActionExecutor['execute']>();
      const handle = await bootPaired({ ...buildExecutorTestDeps(), queue, actionExecutor: { execute },
        idempotencyForPair: () => cache });
      const fail = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('storage unavailable'); });
      try {
        factory.fireMessage(JSON.stringify({ kind: 'command', command: buildCommandFixture() }));
        await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
        expect(execute).not.toHaveBeenCalled();
        expect(factory.sentFrames()).toEqual([]);
      } finally { fail.mockRestore(); await handle.stop(); }
    });

    it('preserves an explicit cache override and never opens the production pair cache', async () => {
      const idempotencyForPair = vi.fn<NonNullable<BridgeServiceWorkerDeps['idempotencyForPair']>>();
      const handle = await bootPaired({ idempotency: createInMemoryIdempotencyCache(), idempotencyForPair });
      try { expect(idempotencyForPair).not.toHaveBeenCalled(); } finally { await handle.stop(); }
    });
  });

  it('executes bridge commands strictly FIFO and rejects overflow with queue_full', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const executor: BridgeActionExecutor = {
      async execute(req) {
        started.push(req.command.command_id);
        active++;
        maxActive = Math.max(maxActive, active);
        if (req.command.command_id === 'cmd-fifo-1') await firstBlocked;
        active--;
        return { status: 'ok', outputs: { result: req.command.command_id } };
      },
    };
    await bootPaired({
      ...buildExecutorTestDeps(),
      actionExecutor: executor,
      queue: createFifoQueue({ max_depth: 1 }),
    });
    const first = buildCommandFixture({
      command_id: 'cmd-fifo-1',
      step_id: 'step-fifo-1',
      idempotency_key: 'idem-fifo-1',
    });
    const second = buildCommandFixture({
      command_id: 'cmd-fifo-2',
      step_id: 'step-fifo-2',
      idempotency_key: 'idem-fifo-2',
    });
    const overflow = buildCommandFixture({
      command_id: 'cmd-fifo-3',
      step_id: 'step-fifo-3',
      idempotency_key: 'idem-fifo-3',
    });

    factory.fireMessage(JSON.stringify({ kind: 'command', command: first }));
    factory.fireMessage(JSON.stringify({ kind: 'command', command: second }));
    factory.fireMessage(JSON.stringify({ kind: 'command', command: overflow }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toEqual(['cmd-fifo-1']);
    const rejected = factory.sentFrames().map((frame) => JSON.parse(frame) as {
      kind: string;
      result: BridgeResult;
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].result).toMatchObject({
      command_id: 'cmd-fifo-3',
      status: 'rejected',
      error: { code: 'queue_full' },
    });

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toEqual(['cmd-fifo-1', 'cmd-fifo-2']);
    expect(maxActive).toBe(1);
    expect(
      factory.sentFrames().map((frame) =>
        (JSON.parse(frame) as { result: BridgeResult }).result.command_id,
      ),
    ).toEqual(['cmd-fifo-3', 'cmd-fifo-1', 'cmd-fifo-2']);
  });

  it('drops a queued command on cancel and returns a cancelled result', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const executor: BridgeActionExecutor = {
      async execute(req) {
        started.push(req.command.command_id);
        if (req.command.command_id === 'cmd-running') await firstBlocked;
        return { status: 'ok', outputs: { result: req.command.command_id } };
      },
    };
    await bootPaired({ ...buildExecutorTestDeps(), actionExecutor: executor });
    const running = buildCommandFixture({
      command_id: 'cmd-running',
      step_id: 'step-running',
      idempotency_key: 'idem-running',
    });
    const queued = buildCommandFixture({
      command_id: 'cmd-queued',
      step_id: 'step-queued',
      idempotency_key: 'idem-queued',
    });

    factory.fireMessage(JSON.stringify({ kind: 'command', command: running }));
    factory.fireMessage(JSON.stringify({ kind: 'command', command: queued }));
    factory.fireMessage(JSON.stringify({
      kind: 'cancel',
      cancel: { command_id: queued.command_id, reason: 'test queued cancel' },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toEqual(['cmd-running']);
    expect(JSON.parse(factory.sentFrames()[0]) as unknown).toMatchObject({
      kind: 'result',
      result: { command_id: 'cmd-queued', status: 'cancelled' },
    });

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['cmd-running']);
  });

  it('`cancel` envelope flips the in-flight cooperative-cancel signal', async () => {
    // Use a hold-then-resume executor so cancel can intercept.
    const release: { resolve: () => void } = { resolve: () => undefined };
    const blockedP = new Promise<void>((r) => {
      release.resolve = r;
    });
    const observedCancels: boolean[] = [];
    const holdingExecutor: BridgeActionExecutor = {
      async execute(req) {
        await blockedP;
        observedCancels.push(req.cancel.signalled);
        return { status: 'ok', outputs: { result: 'served' } };
      },
    };
    const command = buildCommandFixture();
    await bootPaired({ ...buildExecutorTestDeps(), actionExecutor: holdingExecutor });
    factory.fireMessage(JSON.stringify({ kind: 'command', command }));
    // Send cancel while the executor is parked.
    factory.fireMessage(
      JSON.stringify({
        kind: 'cancel',
        cancel: { command_id: command.command_id, reason: 'test' },
      }),
    );
    release.resolve();
    // Drain microtasks so the dispatcher completes.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(observedCancels).toEqual([true]);
  });

  it('stop() closes the WS + removes the keepalive alarm', async () => {
    const handle = await bootPaired();
    await handle.stop();
    expect(factory.transport?.closedWith).toEqual({ code: 1000, reason: 'bridge: shutdown' });
    expect(alarms.cleared).toContain('recued.bridge.keepalive');
  });
});

// — fixtures ───────────────────────────────────────────────────────

const buildCommandFixture = (
  overrides: Partial<BridgeCommand> = {},
): BridgeCommand => {
  // D-169 P0 Slice 2A — per-command BridgeAuthority retired (DL-1);
  // the command carries `action` + `target_domain_pattern` directly.
  // The dispatcher's grant intersection check requires a matching
  // grant which we feed via `buildExecutorTestDeps()` below.
  const ingredient = {
    publisher_id: 'pub-1',
    slug: 'slug-1',
    version: '0.0.1',
    surface_kind: 'reading' as const,
    domain_allowlist: ['*://example.com/*'],
    domain_allowlist_signature: 'sig-stub',
  };
  return {
    command_id: 'cmd-1',
    recipe_run_id: 'run-1',
    step_id: 'step-1',
    ingredient,
    action: 'read_dom',
    target_domain_pattern: '*://example.com/*',
    args: {},
    expects_output_keys: ['result'],
    timeout_ms: 5000,
    idempotency_key: 'idem-1',
    ...overrides,
  };
};

// Pre-seeded grant store so the dispatcher's two-way grant intersection
// passes. The grant matches the command fixture's
// (publisher_id, slug, version) tuple + grants the example.com origin.
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

describe('D-169 P0 Slice 1 — dispatcher integration helpers', () => {
  it('grant deps build cleanly (sanity)', () => {
    const deps = buildExecutorTestDeps();
    expect(deps.grants).toBeDefined();
  });
});
