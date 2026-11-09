/** D-169 P1 — SW side-panel wiring tests.
 *
 *  Covers:
 *   - the toolbar icon opening the side panel (`boot/toolbar-icon.ts`):
 *     `setPanelBehavior({ openPanelOnActionClick: true })`, plus the
 *     `action.onClicked` → `sidePanel.open` fallback. There is no popup.
 *   - chrome.runtime.sendMessage `recued.bridge.side-panel.fetch-status`
 *     surfaces `bridge_not_paired` when SW is unpaired, and
 *     `bridge_connecting` while a stored pair's runtime comes up
 *
 *  Spec: D-169 § N.5 (amended 2026-10-10: the side panel is
 *  the only page; it pairs the bridge too). */

import { describe, it, expect, vi } from 'vitest';
import { createInMemoryIdempotencyCache } from '../idempotency/cache.js';
import { buildGrant, createInMemoryBridgeGrantStore } from '../permissions/grants.js';
import type { BridgeCommand } from '@recued/contracts';

import {
  bootBridgeServiceWorker,
  type BridgeServiceWorkerDeps,
  type ChromeRuntimeOnMessageApi,
  type BridgeSwLifecycle,
} from '../boot/service-worker-bootstrap.js';
import {
  wireToolbarIconToSidePanel,
  type ChromeActionOnClickedApi,
  type ChromeSidePanelApi,
} from '../boot/toolbar-icon.js';
import type { ChromeStorageLocal } from '../storage/local-store.js';
import type {
  ActionExecutorOutcome,
  ActionExecutorRequest,
  BridgeActionExecutor,
} from '../queue/dispatcher.js';
import type {
  WsTransport,
  WsTransportFactory,
} from '../transport/ws-client.js';
import type { WebclientTokenStore } from '../storage/token-store.js';

// ── Reusable fakes ─────────────────────────────────────────────────────

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
  onInstall: () => undefined,
  onActivate: () => undefined,
  async skipWaiting() {
    /* no-op */
  },
  async claim() {
    /* no-op */
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

interface CapturedActionOnClicked extends ChromeActionOnClickedApi {
  handlers: Array<(tab: { id?: number; windowId?: number }) => void>;
  fire(tab: { id?: number; windowId?: number }): void;
}

const buildCapturedActionOnClicked = (): CapturedActionOnClicked => {
  const handlers: CapturedActionOnClicked['handlers'] = [];
  return {
    handlers,
    addListener(handler) {
      handlers.push(handler);
    },
    fire(tab) {
      for (const h of [...handlers]) h(tab);
    },
  };
};

interface CapturedSidePanel extends ChromeSidePanelApi {
  opens: Array<{ tabId?: number; windowId?: number }>;
  behaviors: Array<{ openPanelOnActionClick: boolean }>;
}

const buildCapturedSidePanel = (): CapturedSidePanel => {
  const opens: CapturedSidePanel['opens'] = [];
  const behaviors: CapturedSidePanel['behaviors'] = [];
  return {
    opens,
    behaviors,
    open(opts) {
      const out: { tabId?: number; windowId?: number } = {};
      if (opts.tabId !== undefined) out.tabId = opts.tabId;
      if (opts.windowId !== undefined) out.windowId = opts.windowId;
      opens.push(out);
    },
    setPanelBehavior(behavior) {
      behaviors.push({ ...behavior });
    },
  };
};

const stubExecutor: BridgeActionExecutor = {
  async execute(_req: ActionExecutorRequest): Promise<ActionExecutorOutcome> {
    return { status: 'ok', outputs: { result: 'stub' } };
  },
};

const buildStubFactory = (): WsTransportFactory => ({
  async open(): Promise<WsTransport> {
    const messageHandlers: Array<(payload: string) => void> = [];
    return {
      send: () => undefined,
      close: () => undefined,
      onMessage(handler) {
        messageHandlers.push(handler);
        return () => {
          const i = messageHandlers.indexOf(handler);
          if (i >= 0) messageHandlers.splice(i, 1);
        };
      },
      onClose() {
        return () => undefined;
      },
      onError() {
        return () => undefined;
      },
    };
  },
});

const stubTokenStore: WebclientTokenStore = {
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
};

const baseDeps = (
  overrides: Partial<BridgeServiceWorkerDeps>,
): BridgeServiceWorkerDeps => ({
  chromeStorage: buildInMemoryChromeStorage(),
  chromeRuntimeOnMessage: buildCapturedOnMessage(),
  swLifecycle: buildCapturedSwLifecycle(),
  wsTransportFactory: buildStubFactory(),
  tokenStore: stubTokenStore,
  bridgeVersion: 'test',
  defaultNotificationIconUrl: 'icons/logo.svg',
  actionExecutor: stubExecutor,
  ...overrides,
});

// ── Test cases ─────────────────────────────────────────────────────────

describe('the toolbar icon opens the side panel (no popup)', () => {
  it('sets the icon to open the panel and registers one fallback listener', () => {
    const onClicked = buildCapturedActionOnClicked();
    const sidePanel = buildCapturedSidePanel();
    wireToolbarIconToSidePanel({ action: { onClicked }, sidePanel });
    expect(sidePanel.behaviors).toEqual([{ openPanelOnActionClick: true }]);
    expect(onClicked.handlers.length).toBe(1);
    expect(sidePanel.opens.length).toBe(0);
  });

  it('a click that reaches the fallback opens the panel on the clicked tab', () => {
    const onClicked = buildCapturedActionOnClicked();
    const sidePanel = buildCapturedSidePanel();
    wireToolbarIconToSidePanel({ action: { onClicked }, sidePanel });
    onClicked.fire({ id: 42, windowId: 7 });
    // `tabId` when both are present: the tab the user clicked the icon on.
    expect(sidePanel.opens).toEqual([{ tabId: 42 }]);
  });

  it('falls back to windowId when tab.id is undefined', () => {
    const onClicked = buildCapturedActionOnClicked();
    const sidePanel = buildCapturedSidePanel();
    wireToolbarIconToSidePanel({ action: { onClicked }, sidePanel });
    onClicked.fire({ windowId: 99 });
    expect(sidePanel.opens).toEqual([{ windowId: 99 }]);
  });

  it('keeps the fallback when setting the behaviour throws or rejects', async () => {
    for (const fail of [
      () => {
        throw new Error('sync');
      },
      () => Promise.reject(new Error('async')),
    ]) {
      const onClicked = buildCapturedActionOnClicked();
      const sidePanel = { ...buildCapturedSidePanel(), setPanelBehavior: fail };
      const opens: Array<{ tabId?: number; windowId?: number }> = [];
      sidePanel.open = (opts) => {
        opens.push(opts);
      };
      expect(() => wireToolbarIconToSidePanel({ action: { onClicked }, sidePanel })).not.toThrow();
      await Promise.resolve();
      onClicked.fire({ id: 5 });
      expect(opens).toEqual([{ tabId: 5 }]);
    }
  });

  it('does nothing without chrome.sidePanel', () => {
    const onClicked = buildCapturedActionOnClicked();
    wireToolbarIconToSidePanel({ action: { onClicked } });
    wireToolbarIconToSidePanel(undefined);
    expect(onClicked.handlers.length).toBe(0);
  });

});

describe('D-169 P1 — recued.bridge.side-panel.fetch-status responder', () => {
  it('returns bridge_not_paired when SW is unpaired (no rpcConn)', async () => {
    const onMessage = buildCapturedOnMessage();
    await bootBridgeServiceWorker(
      baseDeps({ chromeRuntimeOnMessage: onMessage }),
    );
    expect(onMessage.handlers.length).toBe(1);

    let responded: unknown = null;
    const ret = onMessage.handlers[0](
      { type: 'recued.bridge.side-panel.fetch-status' },
      undefined,
      (response) => {
        responded = response;
      },
    );
    expect(ret).toBe(true); // async response — channel kept open
    await new Promise((r) => setTimeout(r, 0));
    expect(responded).toEqual({ ok: false, error: 'bridge_not_paired' });
  });

  it('routes recued.bridge.inspect to the side-panel diagnostic snapshot', async () => {
    // Cross-check that the side-panel diagnostic responder shares the
    // same listener slot — `recued.bridge.inspect` continues to land
    // a BridgeStateInspection shape.
    const onMessage = buildCapturedOnMessage();
    await bootBridgeServiceWorker(
      baseDeps({ chromeRuntimeOnMessage: onMessage }),
    );
    let responded: unknown = null;
    const ret = onMessage.handlers[0](
      { type: 'recued.bridge.inspect' },
      undefined,
      (response) => {
        responded = response;
      },
    );
    expect(ret).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(responded).toMatchObject({
      idempotency: { entry_count: expect.any(Number), in_flight: { count: 0, entries: [] }, recent_confirmed: { count: 0, entries: [] } },
      grants: { count: expect.any(Number) },
    });
  });

  it('answers null when local inspection fails instead of leaving its channel open', async () => {
    const storage = buildInMemoryChromeStorage(), onMessage = buildCapturedOnMessage();
    const handle = await bootBridgeServiceWorker(baseDeps({ chromeStorage: storage, chromeRuntimeOnMessage: onMessage }));
    const fail = vi.spyOn(storage, 'get').mockRejectedValue(new Error('Storage temporarily unavailable'));
    const response = vi.fn();
    try {
      expect(onMessage.handlers[0]({ type: 'recued.bridge.inspect' }, undefined, response)).toBe(true);
      await new Promise(done => setTimeout(done, 0));
      expect(response).toHaveBeenCalledWith(null);
    } finally { fail.mockRestore(); await handle.stop(); }
  });

  it('inspects markers in the newly stored pair before that connection starts', async () => {
    const old = createInMemoryIdempotencyCache(), fresh = createInMemoryIdempotencyCache({ now: () => 700 });
    await old.claim('old-command', 'old-key'); await fresh.claim('new-command', 'new-key');
    await fresh.store('finished-new-pair', 'private-finished-key', { command_id: 'finished-new-pair', status: 'ok',
      outputs: { secret: 'private-output' }, duration_ms: 1, bridge_version: 'fixture', idempotency_key_seen: false });
    const onMessage = buildCapturedOnMessage(), storage = buildInMemoryChromeStorage();
    const factory = vi.fn((scope: { token_id: string }) => scope.token_id === 'new-token' ? fresh : old);
    const handle = await bootBridgeServiceWorker(baseDeps({ chromeStorage: storage,
      chromeRuntimeOnMessage: onMessage, idempotencyForPair: factory }));
    try {
      await storage.set({ server_url: 'wss://new.fixture.invalid/ws', server_public_key: 'new-server',
        webclient_token: { token_id: 'new-token', ciphertext_b64: 'fixture', iv_b64: 'fixture', issued_at: 1 } });
      const response = await new Promise<unknown>(resolve => {
        expect(onMessage.handlers[0]({ type: 'recued.bridge.inspect' }, undefined, resolve)).toBe(true);
      });
      expect(response).toMatchObject({ local: { server_public_key: 'new-server', webclient_token: { token_id: 'new-token' } },
        idempotency: { in_flight: { count: 1, entries: [{ command_id: 'new-command', started_at: 700 }] },
          recent_confirmed: { count: 1, entries: [{ command_id: 'finished-new-pair', status: 'ok', stored_at: 700 }] } } });
      expect(factory).toHaveBeenCalledWith({ server_public_key: 'new-server', token_id: 'new-token' });
      expect(JSON.stringify(response)).not.toContain('private-output');
      expect(JSON.stringify(response)).not.toContain('private-finished-key');
      expect(handle.paired).toBe(false); // Inspection does not reconnect or run commands.
    } finally { await handle.stop(); }
  });

  it('ignores messages with the wrong type', async () => {
    const onMessage = buildCapturedOnMessage();
    await bootBridgeServiceWorker(
      baseDeps({ chromeRuntimeOnMessage: onMessage }),
    );
    const ret = onMessage.handlers[0](
      { type: 'other.unknown' },
      undefined,
      () => undefined,
    );
    expect(ret).toBeUndefined();
  });
});

/** The first-open race a reviewer met on the real review server
 *  (2026-10-09): the panel asks for status while the paired socket is still
 *  coming up. The rpc used to fail with the transport's own "send called
 *  while disconnected", shown in red for the 30 s until the next tick. */
describe('fetch-status while the paired socket is still coming up', () => {
  const pairedStorage = (): ChromeStorageLocal =>
    buildInMemoryChromeStorage({
      server_url: 'wss://review.example/ws',
      server_public_key: 'spki-base64-stub',
      webclient_token: {
        token_id: 'tok-abc',
        ciphertext_b64: Buffer.from('bearer').toString('base64'),
        iv_b64: 'aXY=',
        issued_at: 1_700_000_000_000,
      },
    });

  const askStatus = (onMessage: CapturedOnMessage): Promise<unknown> =>
    new Promise((resolve) => {
      onMessage.handlers[0](
        { type: 'recued.bridge.side-panel.fetch-status' },
        undefined,
        resolve,
      );
    });

  it('answers bridge_connecting, then tells the panel once the socket is up', async () => {
    let openTransport: ((t: WsTransport) => void) | null = null;
    const slowFactory: WsTransportFactory = {
      open: () =>
        new Promise<WsTransport>((resolve) => {
          openTransport = resolve;
        }),
    };
    const pushed: unknown[] = [];
    const onMessage = buildCapturedOnMessage();
    await bootBridgeServiceWorker(
      baseDeps({
        chromeStorage: pairedStorage(),
        chromeRuntimeOnMessage: onMessage,
        wsTransportFactory: slowFactory,
        chromeRuntimeSendMessage: async (message) => {
          pushed.push(message);
        },
      }),
    );

    expect(await askStatus(onMessage)).toEqual({ ok: false, error: 'bridge_connecting' });
    expect(pushed).not.toContainEqual({ type: 'recued.bridge.side-panel.server-connected' });

    await vi.waitFor(() => expect(openTransport).not.toBeNull());
    openTransport!(await buildStubFactory().open({ url: 'wss://review.example/ws', auth_bearer: 'x' }));
    await vi.waitFor(() =>
      expect(pushed).toContainEqual({ type: 'recued.bridge.side-panel.server-connected' }),
    );
  });

  // The side panel switches to its paired sections the moment finalize's
  // storage writes land, and asks for status at once — before the pairing
  // session has started the runtime. A pair stored without a runtime yet is
  // a wait; answering "not paired" put a red error under a fresh pair.
  it('answers bridge_connecting for a pair stored before its runtime starts', async () => {
    const storage = buildInMemoryChromeStorage();
    const onMessage = buildCapturedOnMessage();
    await bootBridgeServiceWorker(
      baseDeps({ chromeStorage: storage, chromeRuntimeOnMessage: onMessage }),
    );
    expect(await askStatus(onMessage)).toEqual({ ok: false, error: 'bridge_not_paired' });

    const paired = pairedStorage();
    await storage.set(
      await paired.get(['server_url', 'server_public_key', 'webclient_token']),
    );
    expect(await askStatus(onMessage)).toEqual({ ok: false, error: 'bridge_connecting' });
  });
});

describe('committed command diagnostic notices', () => {
  const invalidated = { type: 'recued.bridge.side-panel.diagnostics-invalidated' };
  const ingredient: BridgeCommand['ingredient'] = { publisher_id: 'fixture', slug: 'read', version: '1',
    surface_kind: 'reading', domain_allowlist: ['https://fixture.invalid/*'], domain_allowlist_signature: 'fixture' };
  const command = (id: string): BridgeCommand => ({ command_id: id, idempotency_key: `private-key-${id}`,
    recipe_run_id: 'private-run', step_id: 'private-step', ingredient, action: 'read_dom',
    target_domain_pattern: ingredient.domain_allowlist[0]!, args: { private: 'private-args' },
    expects_output_keys: ['result'], timeout_ms: 60_000 });
  const setup = async (executor: BridgeActionExecutor, mode: 'injected' | 'paired' = 'paired',
    sendNotice: (message: unknown) => Promise<unknown> | void = () => undefined) => {
    const handlers: Array<(payload: string) => void> = [], sent: unknown[] = [], pushed: unknown[] = [];
    const cache = createInMemoryIdempotencyCache(), grants = createInMemoryBridgeGrantStore();
    await grants.put(buildGrant(ingredient, ingredient.domain_allowlist, Date.now()));
    const onMessage = buildCapturedOnMessage();
    const handle = await bootBridgeServiceWorker(baseDeps({ chromeStorage: buildInMemoryChromeStorage({
      server_url: 'wss://fixture.invalid/ws', server_public_key: 'fixture-server',
      webclient_token: { token_id: 'fixture-owner', ciphertext_b64: 'YmVhcmVy', iv_b64: 'aXY=', issued_at: 1 },
    }), chromeRuntimeOnMessage: onMessage, grants, actionExecutor: executor,
    ...(mode === 'injected' ? { idempotency: cache } : { idempotencyForPair: () => cache }),
    chromeRuntimeSendMessage: message => { pushed.push(message); return sendNotice(message); },
    wsTransportFactory: { async open() { return {
      send: payload => { sent.push(JSON.parse(payload)); }, close: () => undefined,
      onMessage: handler => { handlers.push(handler); return () => undefined; },
      onClose: () => () => undefined, onError: () => () => undefined,
    }; } },
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(handlers).toHaveLength(1);
    return { handle, cache, sent, notices: () => pushed.filter(message =>
      (message as { type?: string }).type === invalidated.type),
    fire: (id: string) => handlers[0]!(JSON.stringify({ kind: 'command', command: command(id) })),
    inspect: () => new Promise<unknown>(resolve => {
      expect(onMessage.handlers[0]!({ type: 'recued.bridge.inspect' }, undefined, resolve)).toBe(true);
    }) };
  };

  it.each(['injected', 'paired'] as const)('notifies committed admission and completion for a %s cache', async mode => {
    vi.useFakeTimers(); let release!: (value: ActionExecutorOutcome) => void;
    const executor: BridgeActionExecutor = { execute: vi.fn(() => new Promise<ActionExecutorOutcome>(done => { release = done; })) };
    const fixture = await setup(executor, mode);
    try {
      fixture.fire('original'); await vi.advanceTimersByTimeAsync(50);
      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(fixture.notices()).toEqual([invalidated]);
      expect(await fixture.inspect()).toMatchObject({ idempotency: { in_flight: { count: 1 } } });
      release({ status: 'ok', outputs: { result: 'private-output' } }); await vi.advanceTimersByTimeAsync(50);
      expect(fixture.notices()).toEqual([invalidated, invalidated]);
      expect(await fixture.inspect()).toMatchObject({ idempotency: { in_flight: { count: 0 },
        recent_confirmed: { count: 1, entries: [{ command_id: 'original', status: 'ok' }] } } });
      fixture.fire('original'); await vi.advanceTimersByTimeAsync(100);
      await fixture.inspect(); await vi.advanceTimersByTimeAsync(100);
      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(fixture.notices()).toHaveLength(2); // A replay and inspection do not cause a loop.
      expect(JSON.stringify(fixture.notices())).not.toContain('private');
    } finally { release?.({ status: 'ok' }); await fixture.handle.stop(); vi.useRealTimers(); }
  });

  it.each(['throw', 'reject', 'hang'] as const)('keeps results flowing when a diagnostic broadcast fails by %s', async mode => {
    vi.useFakeTimers(); const execute = vi.fn(stubExecutor.execute);
    const fixture = await setup({ execute }, 'paired', message => {
      if ((message as { type?: string }).type !== invalidated.type) return;
      if (mode === 'throw') throw new Error('no receiver');
      if (mode === 'reject') return Promise.reject(new Error('no receiver'));
      return new Promise(() => {});
    });
    try {
      for (let i = 0; i < 5; i++) fixture.fire(`burst-${i}`);
      await vi.advanceTimersByTimeAsync(50);
      expect(fixture.notices()).toEqual([invalidated]);
      fixture.fire('after-burst'); await vi.advanceTimersByTimeAsync(100);
      expect(execute).toHaveBeenCalledTimes(6);
      expect(fixture.sent.filter(raw => (raw as { kind?: string }).kind === 'result')).toHaveLength(6);
      expect((await fixture.cache.inspectInFlight()).count).toBe(0);
      expect(fixture.notices()).toHaveLength(mode === 'hang' ? 1 : 2);
    } finally { await fixture.handle.stop(); vi.useRealTimers(); }
  });

  it('cancels queued notices and ignores command settlement after worker stop', async () => {
    vi.useFakeTimers(); let release!: (value: ActionExecutorOutcome) => void;
    const fixture = await setup({ execute: () => new Promise(done => { release = done; }) });
    try {
      fixture.fire('late'); await vi.advanceTimersByTimeAsync(0);
      expect((await fixture.cache.inspectInFlight()).count).toBe(1);
      await fixture.handle.stop(); release({ status: 'ok', outputs: { result: 'private-output' } });
      await vi.advanceTimersByTimeAsync(100);
      expect(fixture.notices()).toEqual([]);
      expect((await fixture.cache.inspectInFlight()).count).toBe(0);
    } finally { release?.({ status: 'ok' }); await fixture.handle.stop(); vi.useRealTimers(); }
  });
});
