/** D-169 P0 Slice 1 — Browser Bridge service-worker bundle entry.
 *
 *  esbuild's input for `apps/bridge/build/service-worker.js`. Chrome
 *  loads this as the MV3 background service worker via the manifest's
 *  `background.service_worker` field (`type: 'module'`).
 *
 *  Mirrors the webclient pattern of `webclient-main.ts` (side-effecty
 *  bundler entry) over `webclient-bootstrap.ts` (pure composition):
 *  this file binds `globalThis.chrome` + the production
 *  `WsTransportFactory` into the deps shape `bootBridgeServiceWorker`
 *  takes, then invokes it once at module load.
 *
 *  Tests do NOT import this file — its top-level side effects
 *  reference `globalThis.chrome` which is undefined in node. The
 *  testable surface lives in `service-worker-bootstrap.ts`; the build
 *  artefact lives here.
 *
 *  Slice 1 wires the SW boot through `dispatchBridgeCommand` +
 *  `buildActionExecutor` against the existing typed modules; the
 *  chrome.* → `BridgeBrowserApi` adapter is inlined below because
 *  the spec doesn't carve a separate file for it.
 */

import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { describeOpenBridgeDocuments, executeReviewedBridgeDocument } from '../actions/reviewed-document.js';
import { chromePageCapture } from '../actions/page-capture.js';
import { executeInChromeDocument, listChromeFrames } from '../actions/page-inspect.js';
import { chromePageTabs } from '../actions/page-tabs.js';
import { captureMatchedVisibleTab } from '../actions/capture-matched-tab.js';
import { createInMemoryBridgeGrantStore } from '../permissions/grants.js';
import { createKernelSiteGrantStore, readBlockedSites } from '../permissions/site-grants.js';
import {
  createPickerInjector,
  type PickerInjectorChromeApi,
} from '../picker/picker-injector.js';
import { bootBridgeServiceWorker } from './service-worker-bootstrap.js';
import { createSwMessageQueue } from './sw-message-queue.js';
import { wireToolbarIconToSidePanel } from './toolbar-icon.js';
import { wireKeepSignedIn, type KeepSignedInChrome } from '../keep-signed-in.js';
import { bridgeCommandActivity } from '../queue/dispatcher.js';
import { createBrowserBridgeTransportFactory } from './ws-transport-factory.js';
import { createIndexedDbIdempotencyCache, BRIDGE_RECEIPT_STORE_NAME } from '../idempotency/indexed-db-cache.js';
import { BRIDGE_VERSION } from '../index.js';
import {
  createWebclientTokenStore,
  type WebclientTokenStore,
} from '../storage/token-store.js';

/** Default OS-notification icon: a raster image, which Chrome requires (`notifications/icon.ts`). */
import { DEFAULT_NOTIFICATION_ICON_PATH } from '../notifications/icon.js';

/** D-169 P0 Slice 2B — IndexedDB constants for the bridge's
 *  non-extractable AES-GCM key (the substrate that wraps the
 *  `webclient_token` record). Distinct from `WEBCLIENT_INDEXED_DB_NAME`
 *  so the bridge + webclient don't fight over the same DB inside the
 *  extension origin sandbox. */
const BRIDGE_INDEXED_DB_NAME = 'recued.bridge.v1' as const;
const BRIDGE_TOKEN_KEY_STORE_NAME = 'recued.bridge.token_key' as const;
const BRIDGE_TOKEN_KEY_ID = 'bridge.aes_gcm_key' as const;

/** Open the bridge's IndexedDB. Creates the token-key object store on
 *  first install. */
const openBridgeIdb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(BRIDGE_INDEXED_DB_NAME, 1);
    request.onerror = () =>
      reject(
        request.error ??
          new Error('bridge.service-worker-entry: IDB open failed'),
      );
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BRIDGE_TOKEN_KEY_STORE_NAME)) {
        db.createObjectStore(BRIDGE_TOKEN_KEY_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });

/** Codex 2026-05-27 MINOR (Angle 5) fold — txn-complete-aware helper
 *  pinned on `tx.oncomplete` rather than `req.onsuccess`. Under MV3
 *  the SW can be killed between request success + transaction commit;
 *  awaiting commit guarantees the write actually landed when the
 *  promise resolves. Matches the IDB-spec invariant that observers
 *  should rely on `oncomplete` for durability. */
const runStoreRequest = <T = unknown>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  body: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = body(tx.objectStore(storeName));
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    req.onerror = () =>
      reject(req.error ?? new Error(`bridge.idb: ${storeName} request failed`));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () =>
      reject(tx.error ?? new Error(`bridge.idb: ${storeName} txn failed`));
    tx.onabort = () =>
      reject(tx.error ?? new Error(`bridge.idb: ${storeName} txn aborted`));
  });

/** Codex 2026-05-27 MINOR (Angle 5) fold — module-cached resolution
 *  promise. The first call kicks off the read-or-generate-and-persist
 *  pipeline; concurrent + subsequent calls await the same in-flight
 *  promise so within-context callers cannot race their way to two
 *  divergent CryptoKeys. (Cross-context races — SW + offscreen-doc
 *  hitting first-boot in lockstep — would still be possible in
 *  principle but the bridge SW is the only first-boot writer in
 *  practice; the put would land second and overwrite, the next
 *  read on the loser side returns the winner's key on the next
 *  resolve call. The single-CryptoKey-per-bridge-lifetime invariant
 *  is intact under any same-context concurrency.) */
let bridgeTokenKeyPromise: Promise<CryptoKey> | null = null;

/** Resolve the non-extractable AES-GCM key the token store wraps the
 *  bearer with. On first boot we generate one + persist via IDB's
 *  structured clone (browsers serialise `CryptoKey` natively when
 *  `extractable: false`). Subsequent boots read the saved key back —
 *  mirrors webclient-main.ts:resolveTokenKey verbatim modulo the
 *  bridge-scoped constants. The module-cached promise above
 *  serialises concurrent calls. */
const resolveBridgeTokenKey = (db: IDBDatabase): Promise<CryptoKey> => {
  if (bridgeTokenKeyPromise) return bridgeTokenKeyPromise;
  bridgeTokenKeyPromise = (async () => {
    const existing = await runStoreRequest<CryptoKey | undefined>(
      db,
      BRIDGE_TOKEN_KEY_STORE_NAME,
      'readonly',
      (s) => s.get(BRIDGE_TOKEN_KEY_ID),
    );
    if (existing) return existing;
    const fresh = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    // Awaiting txn-complete (not request-success) ensures the key
    // has actually been persisted before any later wrap/unwrap call
    // observes it — see the `runStoreRequest` fold above.
    await runStoreRequest(db, BRIDGE_TOKEN_KEY_STORE_NAME, 'readwrite', (s) =>
      s.put(fresh, BRIDGE_TOKEN_KEY_ID),
    );
    return fresh;
  })().catch((err) => {
    // Don't poison the cache — a transient IDB error on first boot
    // should let the next reconnect attempt retry from scratch.
    bridgeTokenKeyPromise = null;
    throw err;
  });
  return bridgeTokenKeyPromise;
};

/** Build the WebCrypto-backed `WebclientTokenStore` for the bridge SW.
 *  The IDB handle is captured by closure so every wrap/unwrap call
 *  reuses the same DB connection across SW lifetime. */
const buildBridgeTokenStore = (db: IDBDatabase): WebclientTokenStore =>
  createWebclientTokenStore({
    resolveKey: () => resolveBridgeTokenKey(db),
    async encrypt({ key, iv, plaintext, additional_data }) {
      const buf = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: iv as BufferSource,
          additionalData: additional_data as BufferSource,
        },
        key as CryptoKey,
        plaintext as BufferSource,
      );
      return new Uint8Array(buf);
    },
    async decrypt({ key, iv, ciphertext, additional_data }) {
      const buf = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv as BufferSource,
          additionalData: additional_data as BufferSource,
        },
        key as CryptoKey,
        ciphertext as BufferSource,
      );
      return new Uint8Array(buf);
    },
  });

/** Bind chrome.tabs / chrome.scripting / chrome.notifications into the
 *  `BridgeBrowserApi` shape `buildActionExecutor` consumes. */
const buildChromeBrowserApi = (): BridgeBrowserApi => {
  const c = (globalThis as { chrome?: ChromeRuntimeBinding }).chrome;
  if (!c) {
    throw new Error('bridge.service-worker-entry: globalThis.chrome unavailable');
  }
  return {
    executeReviewedDocument: (document, action, args) => executeReviewedBridgeDocument(c.scripting, document, action, args),
    executeInDocument: executeInChromeDocument(c.scripting),
    // D-335 slice R — a tab's frames, for an inspection to name each from another site as a page.
    listFrames: listChromeFrames(c.scripting),
    ...chromePageTabs(c.tabs, c.scripting),
    // D-335 slice H — screenshots: the tab is brought forward for the capture,
    // then the owner's tab is put back.
    pageCapture: chromePageCapture(c, executeInChromeDocument(c.scripting)),
    // D-335 slice G — the owner's list of sites Recued must never use, as the
    // side panel keeps it, and the address a page's tab shows to check it.
    blockedSites: () => readBlockedSites(c.storage.local),
    async tabUrl(tab_id) {
      try {
        const tab = await c.tabs.get(tab_id);
        return typeof tab.url === 'string' && tab.url !== '' ? tab.url : null;
      } catch {
        return null;
      }
    },
    async findTabByUrlPattern(pattern) {
      const tabs = await c.tabs.query({ url: pattern });
      const first = tabs?.[0];
      if (!first || typeof first.id !== 'number' || typeof first.url !== 'string') {
        return null;
      }
      return {
        tab_id: first.id,
        url: first.url,
        window_id: typeof first.windowId === 'number' ? first.windowId : -1,
      };
    },
    async executeScript(tab_id, fn, args) {
      const results = await c.scripting.executeScript({
        target: { tabId: tab_id },
        func: fn,
        args: args.value === undefined ? [args.selector] : [args.selector, args.value],
      });
      return results?.[0]?.result;
    },
    captureVisibleTab(args) {
      // F1 — confine the screenshot to the matched tab (see helper).
      return captureMatchedVisibleTab(c.tabs, args);
    },
    async showNotification(notification_id, options) {
      return c.notifications.create(notification_id, {
        type: 'basic',
        title: options.title,
        message: options.message,
        iconUrl: options.iconUrl,
      });
    },
  };
};

/** D-169 P2 brick 3 — bind chrome.tabs / chrome.scripting into the picker
 *  injector's `PickerInjectorChromeApi`: query the active tab + inject the
 *  bundled `picker/picker.js` classic script. */
const buildChromePickerApi = (): PickerInjectorChromeApi => {
  const c = (globalThis as { chrome?: ChromeRuntimeBinding }).chrome;
  if (!c) {
    throw new Error('bridge.service-worker-entry: globalThis.chrome unavailable');
  }
  return {
    async queryActiveTab() {
      const tabs = await c.tabs.query({ active: true, currentWindow: true });
      const first = tabs?.[0];
      if (!first || typeof first.id !== 'number') return null;
      return {
        id: first.id,
        url: typeof first.url === 'string' ? first.url : undefined,
      };
    },
    async injectFile(tab_id, file) {
      await c.scripting.executeScript({ target: { tabId: tab_id }, files: [file] });
    },
  };
};

interface ChromeRuntimeBinding {
  runtime: {
    getURL?(path: string): string;
    getPlatformInfo(): Promise<unknown>;
    getManifest?(): { version?: string };
    /** D-169 P2 Slice 4 — push a one-shot message to extension pages
     *  (the side panel). Optional: absent in non-SW / older contexts. */
    sendMessage?(message: unknown): Promise<unknown>;
    /** Restarts the extension; the pairing session calls it after a pair. */
    reload?(): void;
    onMessage: {
      addListener(
        handler: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: unknown) => void,
        ) => boolean | undefined,
      ): void;
    };
  };
  storage: {
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string[]): Promise<void>;
      clear(): Promise<void>;
    };
    /** Holds an accepted-but-unfinished pairing for the pairing session. */
    session?: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string[]): Promise<void>;
    };
  };
  alarms: {
    create(name: string, opts: { periodInMinutes: number }): void;
    clear(name: string): void;
    onAlarm: { addListener(handler: (alarm: { name: string }) => void): void };
  };
  tabs: {
    // `{url}` for a notification's link; `{url, active: false}` for a page a
    // step opens (D-335 slice C), whose id `get` then follows until it loads.
    create(opts: { url: string; active?: boolean }): Promise<{ id?: number }>;
    // `windowId` and `active` for a screenshot (D-335 slice H), which brings a
    // background tab forward in its own window and then puts the owner's back.
    get(tabId: number): Promise<{ id?: number; status?: string; url?: string; windowId: number; active: boolean }>;
    remove(tabId: number): Promise<void>;
    onUpdated?: { addListener(handler: (tabId: number, changeInfo: { url?: string }) => void): void };
    onRemoved?: { addListener(handler: () => void): void };
    onReplaced?: { addListener(handler: () => void): void };
    // `{url}` for the action executor's tab lookup; `{active, currentWindow}`
    // for the brick-3 picker injector's active-tab query; `{active, windowId,
    // url}` for the F1 matched-tab screenshot confirm. `url` also takes an
    // ARRAY — chrome matches any of the patterns — which is how the reviewed-
    // document inventory asks only for tabs inside the granted origins.
    query(opts: {
      url?: string | string[];
      active?: boolean;
      currentWindow?: boolean;
      windowId?: number;
    }): Promise<Array<{ id?: number; url?: string; windowId?: number }>>;
    // F1 — activate the matched tab before captureVisibleTab so the capture
    // targets the granted tab, not whatever is foregrounded in its window.
    // D-335 slice X — `{url}` loads an address in a tab a step names.
    update(tabId: number, opts: { active?: boolean; url?: string }): Promise<unknown>;
    // D-335 slice X — a tab's reload (its back is the page's own `history.back()`).
    reload(tabId: number): Promise<void>;
    captureVisibleTab(windowId: number | undefined, opts: { format: string }): Promise<string>;
  };
  scripting: {
    // `{func, args}` for the action executor's inline DOM reads; `{files}`
    // for the brick-3 picker injector's classic-script inject.
    executeScript(
      opts:
        | {
            target: { tabId: number; documentIds?: string[] };
            func: (...args: any[]) => unknown;
            args: ReadonlyArray<unknown>;
          }
        | { target: { tabId: number }; files: ReadonlyArray<string> },
    ): Promise<Array<{ documentId?: string; result: unknown }>>;
  };
  // D-335 slice H — a minimized window draws nothing a screenshot could take.
  windows: {
    get(windowId: number): Promise<{ state?: string }>;
  };
  notifications: {
    getPermissionLevel(): Promise<'granted' | 'denied'>;
    create(notification_id: string, options: unknown): Promise<string>;
    clear(notification_id: string): Promise<boolean>;
    onClicked: { addListener(handler: (notification_id: string) => void): void };
    onClosed: {
      addListener(handler: (notification_id: string, by_user: boolean) => void): void;
    };
  };
  permissions?: {
    getAll(): Promise<{ permissions?: string[]; origins?: string[] }>;
    // D-335 slice H — whether the owner turned on "Allow screenshots".
    contains(permissions: { origins: string[] }): Promise<boolean>;
    onAdded: {
      addListener(handler: (perms: { permissions?: string[]; origins?: string[] }) => void): void;
      removeListener(handler: (perms: { permissions?: string[]; origins?: string[] }) => void): void;
    };
    onRemoved: {
      addListener(handler: (perms: { permissions?: string[]; origins?: string[] }) => void): void;
      removeListener(handler: (perms: { permissions?: string[]; origins?: string[] }) => void): void;
    };
  };
  action?: {
    onClicked: {
      addListener(handler: (tab: { id?: number; windowId?: number }) => void): void;
    };
  };
  sidePanel?: {
    open(opts: { tabId?: number; windowId?: number }): Promise<void> | void;
    setPanelBehavior?(behavior: { openPanelOnActionClick: boolean }): Promise<void> | void;
  };
}

interface BridgeSelfBinding {
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: unknown) => void,
  ): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<unknown> };
}

declare const self: BridgeSelfBinding;

/** D-169 P1.5 Codex 2026-05-28 HIGH #3 / #4 / #6 / #10 folds — the
 *  cold-start `chrome.runtime.onMessage` shim lives in
 *  `./sw-message-queue.ts`. Constructed at module load so the sync
 *  shim listener subscribes BEFORE the async `bridgeServiceWorkerMain`
 *  runs; the `proxy` drops into the bootstrap as
 *  `chromeRuntimeOnMessage`; the entry calls `proxy.drainQueuedMessages()`
 *  after `bootBridgeServiceWorker` resolves; the boot-failure catch arm
 *  flushes via `failQueuedAfterBootRejection`. See `sw-message-queue.ts`
 *  for the full invariant set. */
const chromeAtModuleLoad = (globalThis as { chrome?: ChromeRuntimeBinding })
  .chrome;
const swMessageQueueHandle = createSwMessageQueue({
  chromeRuntimeOnMessage: chromeAtModuleLoad?.runtime.onMessage,
});

// The toolbar icon opens the side panel, the bridge's only page — the pair
// form while unpaired, the live panel once paired. Wired here, before the
// first `await`, so a click that wakes this worker finds its listener
// (`toolbar-icon.ts`).
wireToolbarIconToSidePanel(chromeAtModuleLoad);

// D-347 follow-up 19 — Keep signed in: its timer, wired here too, before the first `await`, so an alarm that
// wakes this worker finds its listener. It needs no server, so it runs paired or not.
wireKeepSignedIn((globalThis as { chrome?: KeepSignedInChrome }).chrome, () => bridgeCommandActivity);

/** Production main — invoked once when the bundle loads. Builds the
 *  chrome.* adapters + invokes bootBridgeServiceWorker. Errors are
 *  swallowed because there's no surface to report them on; a paired
 *  WS that can't connect will surface via the keepalive ticker's
 *  `runKeepaliveTick` reconnect attempts. */
const bridgeServiceWorkerMain = async (): Promise<void> => {
  const c = (globalThis as { chrome?: ChromeRuntimeBinding }).chrome;
  if (!c) {
    // No chrome.* — not a real SW context. Likely a test that
    // accidentally imported this module instead of the bootstrap.
    return;
  }
  const iconUrl = c.runtime.getURL
    ? c.runtime.getURL(DEFAULT_NOTIFICATION_ICON_PATH)
    : DEFAULT_NOTIFICATION_ICON_PATH;

  const swLifecycle = {
    onInstall(handler: () => void): void {
      self.addEventListener('install', () => handler());
    },
    onActivate(handler: (event: { waitUntil(p: Promise<unknown>): void }) => void): void {
      self.addEventListener('activate', (event) => {
        handler(event as { waitUntil(p: Promise<unknown>): void });
      });
    },
    skipWaiting(): Promise<void> {
      return self.skipWaiting();
    },
    claim(): Promise<unknown> {
      return self.clients.claim();
    },
  };

  // D-169 P0 Slice 2B — IDB-backed AES-GCM key store + WebCrypto
  // tokenStore. Construction here happens BEFORE bootBridgeServiceWorker
  // so the SW's first `resolveBearer` invocation already has a hot
  // tokenStore + DB handle.
  const idb = await openBridgeIdb();
  const tokenStore = buildBridgeTokenStore(idb);

  // D-169 P0 — chrome.permissions adapter for the capability monitor.
  // Omitted when the API isn't available (offscreen-document contexts
  // / older Chrome / test SW); the bootstrap silently skips wiring the
  // monitor in that case.
  const chromePermissions = c.permissions;
  // D-169 P0 — Chrome major-version best-effort detection. `userAgent`
  // is unset in vanilla SW globals on some Chrome versions; the
  // `navigator.userAgentData` path lands the structured "Chromium 124"
  // brand under MV3 with a strict-origin context. We avoid an async
  // `getHighEntropyValues` call because the monitor pulls the snapshot
  // synchronously on every push. Falling back to `'unknown'` keeps the
  // profile well-formed when nothing fires.
  const detectChromeVersion = (): string => {
    const nav = (globalThis as { navigator?: { userAgent?: string; userAgentData?: { brands?: Array<{ brand: string; version: string }> } } }).navigator;
    if (!nav) return 'unknown';
    const brands = nav.userAgentData?.brands;
    if (brands) {
      for (const b of brands) {
        if (b.brand === 'Chromium' || b.brand === 'Google Chrome') {
          return b.version;
        }
      }
    }
    if (typeof nav.userAgent === 'string') {
      const m = nav.userAgent.match(/Chrome\/(\d+)/);
      if (m) return m[1];
    }
    return 'unknown';
  };
  const userAgent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  const offscreenSupported = typeof (globalThis as { chrome?: { offscreen?: unknown } }).chrome?.offscreen !== 'undefined';
  const alarmsSupported = typeof c.alarms !== 'undefined';

  const boot = await bootBridgeServiceWorker({
    chromeStorage: c.storage.local,
    // D-169 P1.5 — route through the module-load shim so a side panel
    // pairing message that arrives during the SW cold-start (between
    // module load + this `bootBridgeServiceWorker` call's listener
    // registration) is queued + drained rather than dropped.
    chromeRuntimeOnMessage: swMessageQueueHandle.proxy,
    chromeAlarms: c.alarms,
    chromeRuntimeInfo: { getPlatformInfo: () => c.runtime.getPlatformInfo() },
    // D-169 P2 Slice 4 — `chrome.runtime.sendMessage` so the bus
    // subscriber can push a `bridge-mode-invalidated` signal to the side
    // panel on a per-bridge mode change (and on reconnect).
    chromeRuntimeSendMessage: (message) => c.runtime.sendMessage?.(message),
    chromeNotifications: c.notifications,
    openNotificationUrl: url => c.tabs.create({ url }),
    ...(chromePermissions ? { chromePermissions } : {}),
    ...(c.runtime.reload
      ? { chromeRuntimeReload: () => c.runtime.reload?.() }
      : {}),
    ...(c.storage.session
      ? { chromeStorageSession: c.storage.session }
      : {}),
    ...(chromePermissions
      ? {
          capabilityProfileSnapshot: async ({ granted_origins }) => ({
            software_version: BRIDGE_VERSION,
            chrome_version: detectChromeVersion(),
            offscreen_supported: offscreenSupported,
            alarms_supported: alarmsSupported,
            dom_documents: { version: 1 as const,
              documents: await describeOpenBridgeDocuments(c.tabs, c.scripting, granted_origins) },
            ...(typeof userAgent === 'string' ? { user_agent: userAgent } : {}),
          }),
        }
      : {}),
    swLifecycle,
    // D-335 slice G — a Recued kernel DOM step runs on the sites Chrome has
    // granted this extension (the side panel's "Allow every site"); without
    // this the store was empty and every page command was refused.
    grants: createKernelSiteGrantStore({
      grantedOrigins: async () => (await chromePermissions?.getAll())?.origins ?? [],
      fallback: createInMemoryBridgeGrantStore(),
    }),
    wsTransportFactory: createBrowserBridgeTransportFactory(),
    tokenStore,
    idempotencyForPair: scope => createIndexedDbIdempotencyCache({
      scope,
      onStored: committed_at => c.storage.local.set({
        idempotency_cache: { store_name: BRIDGE_RECEIPT_STORE_NAME, last_flush_at: committed_at },
      }),
    }),
    bridgeVersion: BRIDGE_VERSION,
    defaultNotificationIconUrl: iconUrl,
    actionExecutor: buildActionExecutor(buildChromeBrowserApi()),
    // D-169 P2 brick 3 — the "Watch this element" picker injector.
    pickerInjector: createPickerInjector(buildChromePickerApi()),
  });

  // Refresh metadata after navigation/closure as well as reconnect and host
  // permission changes. These are SW lifetime listeners, not polling jobs.
  //
  // ⚠ `onUpdated` IS NOT A NAVIGATION EVENT. It fires repeatedly through one
  // page load — loading, then title, then favicon, then complete — and only a
  // URL change can alter the document inventory. Rebuilding on all of them re-
  // queried and re-injected for nothing several times per navigation. Removal
  // and replacement have their own events, so they still refresh unconditionally.
  const documentChanged = () => { void boot.capabilityMonitor?.pushNow(); };
  c.tabs.onUpdated?.addListener((_tabId, changeInfo) => {
    if (changeInfo?.url !== undefined) documentChanged();
  });
  c.tabs.onRemoved?.addListener(documentChanged);
  c.tabs.onReplaced?.addListener(documentChanged);

  // D-169 P1.5 Codex HIGH #4 fold — drain the cold-start message queue
  // AFTER bootBridgeServiceWorker resolves so the bootstrap's handle is
  // fully wired (paired-path: `rpcConnForSidePanel` assigned; unpaired-
  // path: hydration complete). A queued pairing op runs against the
  // fully-built pairing session and tokenStore; a queued
  // `side-panel.fetch-status` for a paired bridge sees the live rpc
  // conn instead of an as-yet-null one.
  swMessageQueueHandle.proxy.drainQueuedMessages();
};

void bridgeServiceWorkerMain().catch((err) => {
  // Codex HIGH #10 fold — boot rejected mid-flight. Flush any message
  // queued during the SW cold-start window with a structured failure
  // response so the side panel surfaces user-actionable copy rather than
  // Chrome's generic channel-closed timeout. A pairing queued here never
  // reached `/auth/pair`, so its code is still good.
  swMessageQueueHandle.failQueuedAfterBootRejection(err);
});
