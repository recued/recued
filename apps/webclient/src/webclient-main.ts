/** D-148 § A.4 — webclient PWA entrypoint.
 *
 *  The production browser entry that `apps/webclient/public/index.html`
 *  loads via `<script type="module" src="./webclient-main.js">`. Until
 *  this module landed, the inline `onerror` fallback in the HTML upgraded
 *  the boot splash to a "shell not ready" message because the bundle
 *  did not exist; this is the module that turns that into a real boot.
 *
 *  The entrypoint owns the seams the bootstrap externalises:
 *
 *    1. **IndexedDB-backed local store** — opens
 *       `recued.webclient.v1` (the well-known DB name from
 *       `@recued/contracts`), creates the closed-list 5-field +
 *       AES-GCM-key object stores, and adapts the platform `IDBDatabase`
 *       to the narrow `IndexedDbKeyValue` shape the local-store factory
 *       takes. The adapter is small on purpose — the webclient's whole
 *       IDB usage is two object stores, nothing more.
 *    2. **`crypto.subtle`-backed token store** — resolves the
 *       non-extractable AES-GCM key from the `recued.webclient.token_key`
 *       object store (generates + persists on first boot), wires
 *       `crypto.subtle.encrypt` / `decrypt`, and hands the resulting
 *       store to the bootstrap. The key is `extractable: false` per spec
 *       § A.4.1 so `crypto.subtle.exportKey` raises `InvalidAccessError`.
 *    3. **Browser-WebSocket transport** — `createBrowserWebclientTransport`
 *       from the realtime module, wired against `globalThis.WebSocket`.
 *       Pair-time `server_url` + per-call `bearer` flow through the
 *       transport's URL builder.
 *    4. **Service-worker registration** — call `registerServiceWorker`
 *       from the runtime module so the handle is reachable for a future
 *       Settings → Privacy → "Clear this browser" / "Reset cache" path.
 *       The HTML's inline registration already kicked the SW off; the
 *       programmatic call is idempotent (the platform dedupes by URL).
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Unpaired UX. When `bootstrapWebclient` throws
 *  `WebclientUnpairedError`, the entrypoint mounts the pair-input
 *  host into the splash slot. The host renders a textarea + paste-
 *  and-pair button; on success it invokes the `onPaired` callback
 *  here, which disposes the host + re-enters `bootstrapWebclient`
 *  against the freshly-written 5 IDB fields. We do NOT reload — the
 *  AES-GCM token-store key is in-runtime and reload would discard
 *  it. We do NOT redirect — the user may have landed here
 *  intentionally to inspect the static shell.
 *
 *  DD#2 — Init failures upgrade the splash, not throw. A WebCrypto-less
 *  environment, an IDB-blocked-by-private-mode error, a `WebSocket`-
 *  less environment — every init failure surfaces as a visible message
 *  in the splash slot rather than a console error the user never sees.
 *  Production browsers all have the APIs; the visible-failure path
 *  exists so a misconfigured / restricted environment is loud.
 *
 *  DD#3 — The entrypoint does NOT import from `@recued/engine`,
 *  `@recued/recipes`, `@recued/storage`, `@recued/cache`,
 *  `@recued/scheduler`, or `@recued/marketplace` (the role-boundary
 *  lint asserts this for every file under `src/`). The bundle is the
 *  webclient barrel + the platform globals (WebSocket / IndexedDB /
 *  crypto.subtle / caches). Anything fatter is a role-boundary break.
 *
 *  DD#4 — `exposureProfile` boots to the empty string. The pair-blob
 *  consume flow writes the active profile into `pair_metadata`; until
 *  the consume path surfaces it, the Reception page's "current profile"
 *  affordance shows "(none)" — which is the safe view anyway.
 *
 *  Spec: docs/d-148-spec.md § A.4 (Thin Webclient). */

import {
  WEBCLIENT_INDEXED_DB_NAME,
  WEBCLIENT_OBJECT_STORES,
} from '@recued/contracts';

import type { WebclientHandle } from './webclient-bootstrap.js';
import { parsePairDeeplink } from './auth/pair-deeplink.js';
import {
  removeBootSplashWrapper,
  runBootstrapWithPairFallback,
  setSplashMessage,
} from './boot/pair-fallback-bootstrap.js';
import {
  readSecureContextEnv,
  resolveInsecureContextMessage,
} from './boot/secure-context-guard.js';
import { createBrowserWebclientTransport } from './realtime/browser-transport.js';
import { WebclientReauthRequiredError } from './realtime/ws-client.js';
import { registerServiceWorker } from './runtime/service-worker.js';
import {
  createIndexedDbWebclientLocalStore,
  type IndexedDbKeyValue,
} from './storage/local-store.js';
import {
  createWebclientTokenStore,
  WebclientTokenCorruptError,
  type WebclientTokenStore,
} from './storage/token-store.js';

// ════════════════════════════════════════════════════════════════
// Splash messaging
// ════════════════════════════════════════════════════════════════

const ROOT_ID = 'webclient-root';

// `setSplashMessage` + `removeBootSplashWrapper` live in
// `./boot/pair-fallback-bootstrap.js` (D-169 P1.5 NEXT-#1 extraction) —
// both the entry's init-failure paths below and the pair-fallback loop
// share one splash surface, and the loop needed to move out of this
// `void main()`-at-import module to be testable.

// ════════════════════════════════════════════════════════════════
// IndexedDB plumbing
// ════════════════════════════════════════════════════════════════

const [LOCAL_STORE_NAME, TOKEN_KEY_STORE_NAME] = WEBCLIENT_OBJECT_STORES;
const TOKEN_KEY_ID = 'webclient.aes_gcm_key' as const;

/** Open the webclient's IDB database, creating both documented object
 *  stores on the first run. Idempotent — `onupgradeneeded` only fires
 *  when the version changes or the DB is new. */
const openWebclientDatabase = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WEBCLIENT_INDEXED_DB_NAME, 1);
    request.onupgradeneeded = (): void => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_STORE_NAME)) {
        db.createObjectStore(LOCAL_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(TOKEN_KEY_STORE_NAME)) {
        db.createObjectStore(TOKEN_KEY_STORE_NAME);
      }
    };
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void =>
      reject(request.error ?? new Error('indexedDB.open rejected'));
    request.onblocked = (): void =>
      reject(new Error('indexedDB.open blocked by another open connection'));
  });
};

/** Wrap a single IDB operation in a fresh transaction. Each call is
 *  self-contained: open the transaction, hit the request, resolve on
 *  success / reject on error. We don't pool transactions because the
 *  webclient's IDB traffic is rare (boot + Settings → Privacy actions).
 *  The promise resolves with the request result (unknown shape — the
 *  local-store wrapper casts back to its typed shape). */
const runStoreRequest = <T = unknown>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  operate: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = operate(store);
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void =>
      reject(request.error ?? new Error('idb request rejected'));
    tx.onerror = (): void => reject(tx.error ?? new Error('idb tx rejected'));
    tx.onabort = (): void => reject(tx.error ?? new Error('idb tx aborted'));
  });
};

const buildIdbKeyValue = (db: IDBDatabase, storeName: string): IndexedDbKeyValue => ({
  async get(key) {
    const v = await runStoreRequest(db, storeName, 'readonly', (s) => s.get(key));
    return v;
  },
  async set(key, value) {
    await runStoreRequest(db, storeName, 'readwrite', (s) =>
      s.put(value as unknown as Parameters<IDBObjectStore['put']>[0], key),
    );
  },
  async delete(key) {
    await runStoreRequest(db, storeName, 'readwrite', (s) => s.delete(key));
  },
  async clear() {
    await runStoreRequest(db, storeName, 'readwrite', (s) => s.clear());
  },
  async keys() {
    const raw = await runStoreRequest<IDBValidKey[]>(db, storeName, 'readonly', (s) =>
      s.getAllKeys(),
    );
    return raw.map((k) => String(k));
  },
});

// ════════════════════════════════════════════════════════════════
// AES-GCM key resolver
// ════════════════════════════════════════════════════════════════

/** Resolve the non-extractable AES-GCM key the token store wraps the
 *  bearer with. On first boot we generate one + persist via IDB's
 *  structured clone (browsers serialise `CryptoKey` natively when
 *  `extractable: false`). Subsequent boots read the saved key back.
 *
 *  The key is `extractable: false` so `crypto.subtle.exportKey` raises
 *  `InvalidAccessError`. The plaintext bearer NEVER leaves the runtime
 *  in unwrapped form — every `unwrap` call is paired with an immediate
 *  use of the resulting bearer (per the token-store contract). */
const resolveTokenKey = async (db: IDBDatabase): Promise<CryptoKey> => {
  const existing = await runStoreRequest<CryptoKey | undefined>(
    db,
    TOKEN_KEY_STORE_NAME,
    'readonly',
    (s) => s.get(TOKEN_KEY_ID),
  );
  if (existing) return existing;
  const fresh = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  await runStoreRequest(db, TOKEN_KEY_STORE_NAME, 'readwrite', (s) =>
    s.put(fresh, TOKEN_KEY_ID),
  );
  return fresh;
};

const buildTokenStore = (db: IDBDatabase): WebclientTokenStore =>
  createWebclientTokenStore({
    resolveKey: () => resolveTokenKey(db),
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

/** Codex P2 fold — wrap `tokenStore.unwrap` so a corrupt-key /
 *  AAD-mismatch failure surfaces as `WebclientReauthRequiredError`
 *  instead of the generic `WebclientTokenCorruptError`. The ws-client
 *  only halts its reconnect loop on the reauth error (see
 *  `realtime/ws-client.ts` line 280-284); without this mapping a
 *  corrupt-key state spins forever, never reaching the user.
 *  `wrap()` is untouched — failures there are loud crashes the user
 *  doesn't need a typed signal for. */
const wrapTokenStoreWithReauthMapping = (
  underlying: WebclientTokenStore,
): WebclientTokenStore => ({
  wrap: underlying.wrap.bind(underlying),
  async unwrap(record, aad) {
    try {
      return await underlying.unwrap(record, aad);
    } catch (err) {
      if (err instanceof WebclientTokenCorruptError) {
        throw new WebclientReauthRequiredError(
          `token unwrap failed: ${err.reason}`,
        );
      }
      throw err;
    }
  },
});

/** Codex P2 fold — exposed wiper for the AES-GCM key store. The future
 *  Settings → Privacy → "Clear this browser" surface composes this
 *  alongside `clearThisBrowser`'s `crypto_keys_wiper` field so the
 *  zero-residual-state privacy contract is honored end-to-end. The
 *  function re-opens the IDB (so the caller doesn't need to thread the
 *  bootstrap's handle through) and clears the
 *  `recued.webclient.token_key` object store. */
export const wipeWebclientCryptoKeyStore = async (): Promise<void> => {
  const db = await openWebclientDatabase();
  try {
    await runStoreRequest(db, TOKEN_KEY_STORE_NAME, 'readwrite', (s) => s.clear());
  } finally {
    db.close();
  }
};

// ════════════════════════════════════════════════════════════════
// Boot
// ════════════════════════════════════════════════════════════════

const main = async (): Promise<void> => {
  // Secure-context guard (DD#2 — init failures upgrade the splash, not throw).
  // Web Crypto (`crypto.subtle`) is only available in a secure context: https,
  // or plain http on a loopback origin (localhost / 127.0.0.1). Loaded over
  // plain http on a LAN IP (http://192.168.x.x/webclient/), `crypto.subtle` is
  // undefined and every downstream call — the AES-GCM token store, the ed25519
  // server-key verify, key generation — throws a cryptic "reading 'subtle' of
  // undefined". Detect it BEFORE any of that (even before the service-worker
  // registration, which also needs a secure context) and render an actionable
  // message. Companion to the server's bare-`/` → `/webclient/` LAN redirect:
  // that makes the same-machine localhost path work (loopback is secure); a
  // load from another device over http still needs HTTPS, and this is where
  // the user learns that instead of hitting a dead splash.
  const insecureMessage = resolveInsecureContextMessage(readSecureContextEnv());
  if (insecureMessage) {
    setSplashMessage(insecureMessage);
    console.error(
      'webclient: aborting boot — Web Crypto unavailable (insecure context / no crypto.subtle)',
    );
    return;
  }

  // The HTML's inline SW registration kicks the worker off on
  // `window.load`; the programmatic call here is idempotent (platform
  // dedupes by URL) and surfaces the handle for the future
  // Settings → Privacy actions. Fire-and-forget — registration failure
  // is non-fatal.
  void registerServiceWorker();

  const root = document.getElementById(ROOT_ID);
  if (!root) {
    // No mount root means the HTML was tampered with — there's nothing
    // we can do client-side. Log + bail.
    console.error('webclient: #webclient-root not found in document');
    return;
  }

  // Open the IDB database BEFORE the bootstrap call so a private-mode
  // restriction (Firefox PB blocks IDB) surfaces as a clean splash
  // upgrade rather than a deep-stack unhandled rejection.
  let db: IDBDatabase;
  try {
    db = await openWebclientDatabase();
  } catch (err) {
    setSplashMessage(
      'IndexedDB unavailable — Recued needs persistent storage. Disable Private Browsing or grant storage access, then reload.',
    );
    console.error('webclient: IDB open failed', err);
    return;
  }

  const localStore = createIndexedDbWebclientLocalStore(
    buildIdbKeyValue(db, LOCAL_STORE_NAME),
  );
  const tokenStore = wrapTokenStoreWithReauthMapping(buildTokenStore(db));

  // Codex P2 fold — pre-unwrap the stored bearer BEFORE the bootstrap
  // mounts the route. If the unwrap fails (lost AES key, AAD mismatch,
  // ciphertext tamper), the route would otherwise mount on top of the
  // splash + the ws-client would silently spin its reconnect loop.
  // Failing fast here renders the re-pair UX cleanly instead. We swallow
  // any `WebclientUnpairedError`-equivalent state (missing fields) so
  // the bootstrap's own unpaired-error path handles the not-paired UX.
  try {
    const wt = await localStore.get('webclient_token');
    const su = await localStore.get('server_url');
    const spk = await localStore.get('server_public_key');
    if (wt && su && spk) {
      // Throws `WebclientReauthRequiredError` (mapped above) when the
      // stored ciphertext can no longer be decrypted.
      await tokenStore.unwrap(wt, {
        token_id: wt.token_id,
        server_url: su,
        server_public_key: spk,
      });
    }
  } catch (err) {
    if (err instanceof WebclientReauthRequiredError) {
      setSplashMessage(
        'Stored credentials cannot be read on this browser. Clear this browser and re-pair from your recued-server to recover.',
      );
      return;
    }
    setSplashMessage(
      'Recued failed to start while checking stored credentials. Check the browser console for details.',
    );
    console.error('webclient: bearer pre-unwrap failed', err);
    return;
  }

  let transport;
  try {
    transport = createBrowserWebclientTransport();
  } catch (err) {
    setSplashMessage(
      'This browser cannot open WebSockets. Recued requires a modern browser with WebSocket support.',
    );
    console.error('webclient: transport init failed', err);
    return;
  }

  // D-148 § A.2.1 slice 122 — production `pair.consume` invoker. The
  // factory mints a NEW transport per call (DD#7 in `browser-transport.ts`
  // — one socket per transport instance) so a consume round-trip never
  // D-156 P8 retired the re-pair overlay + the pair-consume invoker
  // along with the rest of the pair-blob substrate. The natural
  // disconnect → unpaired-state → pair-form flow handles every
  // re-pair scenario (spec § Open questions Q2). `handleRef` still
  // lives so the unpaired-error fallback can attach the active
  // bootstrap handle for inspection / future re-entry.
  const handleRef: { current: WebclientHandle | null } = { current: null };

  // D-156 P4 — boot-time deeplink parse. The CLI's `recued-server pair`
  // command prints `app.recued.com/pair?code=<8-char>`; the static
  // shell's `/pair` path is a deployment alias mapping to the same SPA
  // entry as `/` (Vercel rewrites / nginx `try_files` — the rewrite
  // lives in the deploy config, not this repo). Either path lands here;
  // we dispatch on the query alone, so the path mapping is invisible
  // to the SPA. The bootstrap's normal paired-path is unaffected:
  // parsing the deeplink is free + the seed only takes effect on the
  // `WebclientUnpairedError` fallback branch below. NOTE: only `?code=`
  // is honoured — Codex 2026-05-18 P4 critical fold dropped `?url=`
  // pre-fill (attacker-controlled URL would exfiltrate the recovery
  // key on submit).
  const deeplink = parsePairDeeplink(globalThis.location?.search ?? '');

  const outcome = await runBootstrapWithPairFallback({
    root,
    localStore,
    tokenStore,
    transport,
    handleRef,
    // § A.4.1 — the entry owns the IDB handle to the
    // `recued.webclient.token_key` object store, so it supplies the
    // AES-GCM key wiper the bootstrap threads into Settings → Privacy.
    cryptoKeysWiper: wipeWebclientCryptoKeyStore,
    ...(deeplink.active ? { deeplinkSeed: deeplink.seed } : {}),
  });
  // On a cold-start paired boot the reception route APPENDS to
  // `#webclient-root` (it does not clear it), and the boot splash is
  // `min-height:100vh` in normal flow — so a leftover splash would sit
  // on top of / above the mounted app. Drop it once the route is up.
  // On a `pair-form` (unpaired) or `failed` outcome the splash is the
  // live surface (form / error copy) and must stay. Codex 2026-05-28
  // NEXT-#1 finding #1. The post-pair re-entry path tears the splash
  // down symmetrically inside `onAfterPair`.
  if (outcome.kind === 'mounted') {
    removeBootSplashWrapper();
  }
};

void main();
