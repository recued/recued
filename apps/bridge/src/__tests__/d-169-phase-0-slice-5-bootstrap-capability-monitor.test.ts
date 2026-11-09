/** D-169 P0 Slice 5 - service-worker capability monitor wiring.
 *
 *  Focused bootstrap coverage for the chrome.permissions monitor:
 *  construction requires both dependencies, onConnected fires an
 *  immediate profile push, and teardown stops the monitor before
 *  disposing the rpc connection.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCapabilityProfile, WebclientTokenRecord } from '@recued/contracts';
import {
  bootBridgeServiceWorker,
  type BridgeServiceWorkerDeps,
  type BridgeSwLifecycle,
  type ChromeRuntimeOnMessageApi,
} from '../boot/service-worker-bootstrap.js';
import type { ChromeStorageLocal } from '../storage/local-store.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import type {
  ActionExecutorOutcome,
  ActionExecutorRequest,
  BridgeActionExecutor,
} from '../queue/dispatcher.js';
import type { WsTransport, WsTransportFactory } from '../transport/ws-client.js';
import type {
  BridgeCapabilityProfileSnapshot,
  ChromePermissionsApi,
  ChromePermissionsSnapshot,
} from '../permissions/profile-monitor.js';

type PermissionHandler = (perms: ChromePermissionsSnapshot) => void;

const flushAsyncWork = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const waitFor = async (assertion: () => void): Promise<void> => {
  let lastErr: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastErr = err;
      await flushAsyncWork();
    }
  }
  throw lastErr;
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
  openCalls: number;
  transport: CapturedWsTransport | null;
  sentFrames(): string[];
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
  obj.sentFrames = (): string[] => obj.transport?.sent ?? [];
  return obj as CapturedWsTransportFactory;
};

const buildChromePermissions = (
  initial: ChromePermissionsSnapshot = {},
) => {
  let current = initial;
  const addedHandlers: PermissionHandler[] = [];
  const removedHandlers: PermissionHandler[] = [];
  return {
    getAll: vi.fn(async () => current),
    onAdded: {
      addListener(handler: PermissionHandler) {
        addedHandlers.push(handler);
      },
      removeListener(handler: PermissionHandler) {
        const i = addedHandlers.indexOf(handler);
        if (i >= 0) addedHandlers.splice(i, 1);
      },
    },
    onRemoved: {
      addListener(handler: PermissionHandler) {
        removedHandlers.push(handler);
      },
      removeListener(handler: PermissionHandler) {
        const i = removedHandlers.indexOf(handler);
        if (i >= 0) removedHandlers.splice(i, 1);
      },
    },
    addedHandlers,
    removedHandlers,
    setSnapshot(next: ChromePermissionsSnapshot) {
      current = next;
    },
  } satisfies ChromePermissionsApi & {
    addedHandlers: PermissionHandler[];
    removedHandlers: PermissionHandler[];
    setSnapshot(next: ChromePermissionsSnapshot): void;
  };
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

const profileSnapshot = (
  overrides: Partial<BridgeCapabilityProfileSnapshot> = {},
): BridgeCapabilityProfileSnapshot => ({
  software_version: '1.2.3',
  chrome_version: '126.0.6478.0',
  offscreen_supported: true,
  alarms_supported: true,
  ...overrides,
});

const bootPaired = async (
  overrides: Partial<BridgeServiceWorkerDeps> = {},
) => {
  const handle = await bootBridgeServiceWorker(baseDeps({
    chromeStorage: buildPairedStorage(),
    ...overrides,
  }));
  await flushAsyncWork();
  return handle;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('D-169 P0 Slice 5 - bootstrap capability monitor', () => {
  it('wires the monitor only when both chromePermissions and capabilityProfileSnapshot are provided', async () => {
    const chromePermissions = buildChromePermissions({
      permissions: ['storage'],
      origins: ['*://example.com/*'],
    });
    const withBoth = await bootPaired({
      chromePermissions,
      capabilityProfileSnapshot: () => profileSnapshot(),
    });

    expect(withBoth.capabilityMonitor).not.toBeNull();
    expect(chromePermissions.addedHandlers).toHaveLength(1);
    expect(chromePermissions.removedHandlers).toHaveLength(1);
    await withBoth.stop();

    const permissionsOnly = buildChromePermissions();
    const withoutSnapshot = await bootPaired({ chromePermissions: permissionsOnly });
    expect(withoutSnapshot.capabilityMonitor).toBeNull();
    expect(permissionsOnly.addedHandlers).toHaveLength(0);
    expect(permissionsOnly.removedHandlers).toHaveLength(0);
    await withoutSnapshot.stop();

    const withoutPermissions = await bootPaired({
      capabilityProfileSnapshot: () => profileSnapshot(),
    });
    expect(withoutPermissions.capabilityMonitor).toBeNull();
    await withoutPermissions.stop();
  });

  it('pushes the capability profile when WsClient onConnected fires', async () => {
    const factory = buildCapturedWsTransportFactory();
    const chromePermissions = buildChromePermissions({
      permissions: ['storage', 'tabs'],
      origins: ['*://app.hubspot.com/*'],
    });
    const handle = await bootPaired({
      wsTransportFactory: factory,
      chromePermissions,
      capabilityProfileSnapshot: () => profileSnapshot({ user_agent: 'Chrome/test' }),
    });

    await waitFor(() => {
      const frame = factory.sentFrames()
        .map((payload) => JSON.parse(payload) as {
          type?: string;
          method?: string;
          args?: { profile?: BridgeCapabilityProfile };
        })
        .find((parsed) => parsed.method === 'bridge.capabilityProfile.push');
      expect(frame).toBeDefined();
      expect(frame).toMatchObject({
        type: 'rpc',
        method: 'bridge.capabilityProfile.push',
        args: {
          profile: {
            software_version: '1.2.3',
            chrome_version: '126.0.6478.0',
            permissions_granted: ['storage', 'tabs'],
            granted_origins: ['*://app.hubspot.com/*'],
            offscreen_supported: true,
            alarms_supported: true,
            user_agent: 'Chrome/test',
          },
        },
      });
    });
    await handle.stop();
  });

  it('stops the monitor before disposing the rpc connection', async () => {
    const chromePermissions = buildChromePermissions({
      permissions: ['storage'],
      origins: ['*://example.com/*'],
    });
    const handle = await bootPaired({
      chromePermissions,
      capabilityProfileSnapshot: () => profileSnapshot(),
    });
    expect(handle.capabilityMonitor).not.toBeNull();
    expect(handle.rpcConn).not.toBeNull();

    const monitorStop = vi.spyOn(handle.capabilityMonitor!, 'stop');
    const rpcDispose = vi.spyOn(handle.rpcConn!, 'dispose');

    await handle.stop();

    expect(monitorStop).toHaveBeenCalledTimes(1);
    expect(rpcDispose).toHaveBeenCalledTimes(1);
    expect(monitorStop.mock.invocationCallOrder[0])
      .toBeLessThan(rpcDispose.mock.invocationCallOrder[0]);
  });
});
