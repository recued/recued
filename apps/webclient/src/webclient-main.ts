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
 *  environment, unavailable persistent storage, a `WebSocket`-less
 *  environment — every init failure surfaces visibly rather than only in
 *  the console. Persistent-storage failures get a reason-aware live retry;
 *  other restricted environments retain actionable failure copy.
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
 *  Spec: D-148 § A.4 (Thin Webclient). */

import type { WebclientHandle } from './webclient-bootstrap.js';
import { parsePairEntryHandoff } from './boot/secure-access-resume.js';
import {
  armRecoveryReentry,
  armReplacementServerRecoveryReentry,
  armSafeStopRecoveryReentry,
  consumeRecoveryReentryState,
  retireRecoveryReentry,
  scrubRecoveryReentryAddress,
} from './boot/recovery-reentry.js';
import {
  queueStartupRecoveryForNextAttempt,
  removeBootSplashWrapper,
  runBootstrapWithPairFallback,
  setSplashMessage,
  type PairFallbackBootstrapDeps,
} from './boot/pair-fallback-bootstrap.js';
import {
  COLD_START_CREDENTIAL_SETTLE_MS,
  announceColdStartCredentialCheck,
  inspectColdStartCredentials,
  startColdStartCredentialRepair,
  type ColdStartCredentialHealth,
} from './boot/cold-start-credential-repair.js';
import { createBrowserPairTabConvergence } from './boot/pair-tab-convergence.js';
import {
  readSecureContextEnv,
  resolveSecureContextIssue,
} from './boot/secure-context-guard.js';
import { mountSecureAccessHandoff } from './boot/secure-access-handoff.js';
import {
  closeAbandonedPersistentStorageOpen,
  openPersistentStorageWithRecovery,
  openWebclientDatabase,
  WEBCLIENT_LOCAL_STORE_NAME,
  WEBCLIENT_TOKEN_KEY_STORE_NAME,
} from './boot/persistent-storage-startup.js';
import { recoverStartupTaskWithTriage } from './boot/startup-failure-triage.js';
import {
  consumeStartupReloadRecovery,
  requestStartupRecoveryReload,
} from './boot/startup-reload-recovery.js';
import { createBrowserWebclientTransport } from './realtime/browser-transport.js';
import { WebclientReauthRequiredError } from './realtime/ws-client.js';
import { registerServiceWorker } from './runtime/service-worker.js';
import {
  buildIndexedDbKeyValue,
  runIndexedDbStoreRequest,
} from './storage/indexed-db-key-value.js';
import { createIndexedDbWebclientLocalStore } from './storage/local-store.js';
import {
  createWebclientTokenStore,
  WebclientTokenCorruptError,
  type WebclientTokenStore,
} from './storage/token-store.js';

// ════════════════════════════════════════════════════════════════
// Splash messaging
// ════════════════════════════════════════════════════════════════

const ROOT_ID = 'webclient-root';

/** Broadcast a credential-free hint from a pre-shell repair. Pair fallback
 * owns a persistent observer once the shell mounts; cold-start repair has no
 * shell yet, so this short-lived channel posts once and immediately retires. */
const notifySiblingCredentialsRemoved = (): void => {
  const convergence = createBrowserPairTabConvergence({ pollMs: null });
  if (convergence === null) return;
  try {
    convergence.notifyCredentialStateChanged();
  } finally {
    convergence.close();
  }
};

// `setSplashMessage` + `removeBootSplashWrapper` live in
// `./boot/pair-fallback-bootstrap.js` (D-169 P1.5 NEXT-#1 extraction) —
// both the entry's init-failure paths below and the pair-fallback loop
// share one splash surface, and the loop needed to move out of this
// `void main()`-at-import module to be testable.

// ════════════════════════════════════════════════════════════════
// IndexedDB plumbing
// ════════════════════════════════════════════════════════════════

const TOKEN_KEY_ID = 'webclient.aes_gcm_key' as const;

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
  const existing = await runIndexedDbStoreRequest<CryptoKey | undefined>(
    db,
    WEBCLIENT_TOKEN_KEY_STORE_NAME,
    'readonly',
    (s) => s.get(TOKEN_KEY_ID),
  );
  if (existing) return existing;
  const fresh = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  await runIndexedDbStoreRequest(
    db,
    WEBCLIENT_TOKEN_KEY_STORE_NAME,
    'readwrite',
    (s) => s.put(fresh, TOKEN_KEY_ID),
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
  let db: IDBDatabase;
  try {
    db = await openWebclientDatabase();
  } catch (error) {
    closeAbandonedPersistentStorageOpen(error);
    throw error;
  }
  try {
    await runIndexedDbStoreRequest(
      db,
      WEBCLIENT_TOKEN_KEY_STORE_NAME,
      'readwrite',
      (s) => s.clear(),
    );
  } finally {
    db.close();
  }
};

// ════════════════════════════════════════════════════════════════
// Boot
// ════════════════════════════════════════════════════════════════

const main = async (): Promise<void> => {
  // Consume before any early-returning startup guard. Only this next document
  // may claim the explicit reload; a storage, credential, or environment
  // failure retires it instead of leaking success into a later ordinary load.
  const startupReloadRecoveryRequested =
    consumeStartupReloadRecovery();

  // Secure-context guard (DD#2 — init failures upgrade the splash, not throw).
  // Web Crypto (`crypto.subtle`) is only available in a secure context: https,
  // or plain http on a loopback origin (localhost / 127.0.0.1). Loaded over
  // plain http on a LAN IP (http://192.168.x.x/webclient/), `crypto.subtle` is
  // undefined and every downstream call — the AES-GCM token store, the ed25519
  // server-key verify, key generation — throws a cryptic "reading 'subtle' of
  // undefined". Detect it BEFORE any of that (even before the service-worker
  // registration, which also needs a secure context) and render an actionable
  // handoff. Companion to the server's bare-`/` → `/webclient/` LAN redirect:
  // that makes the same-machine localhost path work (loopback is secure); a
  // load from another device over http still needs HTTPS. Keep the exact path,
  // pairing query, and hash intact across either route instead of leaving the
  // owner to reconstruct them from a dead splash.
  const secureContextIssue = resolveSecureContextIssue(
    readSecureContextEnv(),
  );
  if (secureContextIssue) {
    try {
      mountSecureAccessHandoff({
        issue: secureContextIssue,
        location: window.location,
        document,
      });
    } catch (error) {
      setSplashMessage(secureContextIssue.message);
      console.error('webclient: secure-access handoff mount failed', error);
    }
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

  // Open IDB BEFORE bootstrap. A blocked upgrade, storage denial, quota
  // failure, or unknown platform error becomes an actionable live recovery
  // surface. A successful in-place retry resumes this exact boot and route.
  let db: IDBDatabase;
  try {
    db = await openPersistentStorageWithRecovery({
      openStorage: openWebclientDatabase,
      document,
      reloadAttempted: startupReloadRecoveryRequested,
      reload: () => requestStartupRecoveryReload(),
      onFailure: (error, kind) => {
        console.error(`webclient: IDB open failed (${kind})`, error);
      },
    });
  } catch (err) {
    setSplashMessage(
      'Recued could not open browser-storage recovery. Reload this tab and try again.',
    );
    console.error('webclient: persistent-storage recovery mount failed', err);
    return;
  }

  const localKeyValue = buildIndexedDbKeyValue(
    db,
    WEBCLIENT_LOCAL_STORE_NAME,
  );
  const localStore = createIndexedDbWebclientLocalStore(localKeyValue);
  const tokenStore = wrapTokenStoreWithReauthMapping(buildTokenStore(db));

  // Consume only after persistent storage opens: a storage/secure-context
  // failure must not erase the last recovery document's continuity. The
  // marker contains no context; the live URL below remains the exact-route
  // authority, and every old pairing input is retired before inspection.
  const recoveryReentryState = consumeRecoveryReentryState();
  const recoveryReentryRequested = recoveryReentryState !== null;
  const safeStopReentryRequested = recoveryReentryState === 'safe_stop';
  const replacementServerReentryRequested =
    recoveryReentryState === 'replacement_server';
  if (recoveryReentryRequested) {
    scrubRecoveryReentryAddress({ document });
    // Keep continuity live while credential inspection or its startup triage
    // is pending. A verified healthy pair below is the only reason to retire.
    if (safeStopReentryRequested) {
      armSafeStopRecoveryReentry();
    } else if (replacementServerReentryRequested) {
      armReplacementServerRecoveryReentry();
    } else {
      armRecoveryReentry();
    }
  }

  // Inspect the full five-field record BEFORE a route mounts. Only an entirely
  // empty store is first run. Interrupted partial writes and typed local
  // decrypt failures become explicit, context-preserving repair choices below.
  const inspectCredentialsAtColdStart = async (
    announce: boolean,
  ): Promise<ColdStartCredentialHealth> => {
    const credentialConvergence = createBrowserPairTabConvergence({
      pollMs: null,
    });
    const stopAnnouncement = announce
      ? announceColdStartCredentialCheck()
      : (): void => undefined;
    try {
      return await inspectColdStartCredentials({
        localStore,
        tokenStore,
        credentialConvergence,
        settleMs: COLD_START_CREDENTIAL_SETTLE_MS,
      });
    } finally {
      stopAnnouncement();
      credentialConvergence?.close();
    }
  };

  let credentialHealth: ColdStartCredentialHealth;
  try {
    credentialHealth = await inspectCredentialsAtColdStart(true);
  } catch (initialFailure) {
    try {
      credentialHealth = await recoverStartupTaskWithTriage({
        initialFailure,
        task: () => inspectCredentialsAtColdStart(false),
        savedAccessVerified: false,
        repeated: startupReloadRecoveryRequested,
        reloadAttempted: startupReloadRecoveryRequested,
        document,
        onReload: () => requestStartupRecoveryReload(),
        onFailure: (failure, kind) => {
          console.error(
            `webclient: saved-access check failed (${kind})`,
            failure,
          );
        },
      });
    } catch (triageError) {
      setSplashMessage(
        'Recued could not open startup recovery. Reload this tab to try again; no saved access was cleared.',
      );
      console.error(
        'webclient: saved-access check recovery unavailable',
        triageError,
      );
      return;
    }
  }

  const healthyPairAvailable =
    credentialHealth.kind === 'continue'
    && credentialHealth.healthyPairAvailable === true;
  const recoveryReentryUnresolved =
    recoveryReentryRequested
    && !healthyPairAvailable;
  if (
    recoveryReentryRequested
    && healthyPairAvailable
  ) {
    // A sibling may have completed while this document was closed. Durable
    // healthy access wins silently and prevents reconnect framing or receipts.
    retireRecoveryReentry();
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

  // Boot-time pair-entry parse. The CLI's safe `?code=` is retained, while an
  // insecure-context handoff may also resume with the destination page's own
  // HTTPS/loopback origin. Query-supplied server URLs remain ignored. Parse
  // before cold repair so either safe seed survives that guided handoff too.
  const pairEntry = parsePairEntryHandoff(
    globalThis.location?.href ?? '',
  );

  if (credentialHealth.kind !== 'continue') {
    // The bounded startup observer is intentionally short-lived. Keep a fresh
    // poll/focus-capable observer with the explicit repair surface so a source
    // tab that finishes its interrupted save can dismiss this stale diagnosis
    // without making the user clear or re-pair anything here.
    const repairCredentialConvergence =
      createBrowserPairTabConvergence();
    try {
      // True when the repair has at most the one profile to remove — the
      // point at which a whole-store wipe and a profile-scoped one are the
      // same act. Read BEFORE anything is removed, so both wipers agree.
      const repairWouldEmptyRoster = async (): Promise<boolean> => {
        try {
          return (await localStore.listProfiles()).length <= 1;
        } catch {
          // A roster read that fails is itself a broken store; fall back to
          // the historic whole-store wipe rather than leaving a half-repaired
          // browser that cannot pair.
          return true;
        }
      };
      startColdStartCredentialRepair({
        root,
        localStore,
        profileStore: localStore,
        tokenStore,
        transport,
        handleRef,
        // PROFILE-SCOPED repair wipes.
        //
        // Cold-start repair fires when the ACTIVE server's stored generation
        // is partial or unreadable. The unscoped wipes below it are correct
        // for a browser paired to one server and destructive for a browser
        // paired to several: `localKeyValue.clear()` takes the whole roster,
        // and the AES-GCM key is ONE per origin (`TOKEN_KEY_ID`) wrapping
        // every profile's bearer — so wiping it while other profiles still
        // hold tokens would leave them undecryptable. One broken server must
        // not cost the owner the servers that still work.
        //
        // So both wipes stay whole-store ONLY when this repair would empty
        // the roster anyway (the single-server case, i.e. every install that
        // predates profiles); otherwise the repair drops just the active
        // profile and leaves the key alone.
        cryptoKeysWiper: async () => {
          if (await repairWouldEmptyRoster()) await wipeWebclientCryptoKeyStore();
        },
        credentialStoreWiper: async () => {
          if (await repairWouldEmptyRoster()) {
            await localKeyValue.clear();
            return;
          }
          const activeId = await localStore.activeProfileId();
          if (activeId !== null) await localStore.removeProfile(activeId);
        },
        onCredentialsRemoved: notifySiblingCredentialsRemoved,
        credentialConvergence: repairCredentialConvergence,
        target: credentialHealth.kind === 'unreadable'
          ? { kind: 'unreadable', pair: credentialHealth.pair }
          : { kind: 'partial', partial: credentialHealth.partial },
        returnHash: globalThis.location?.hash || '#chat',
        reloadAttempted: startupReloadRecoveryRequested,
        ...(recoveryReentryUnresolved
          ? { recoveryReentry: true as const }
          : {}),
        ...(recoveryReentryUnresolved && safeStopReentryRequested
          ? { safeStopReentry: true as const }
          : {}),
        ...(recoveryReentryUnresolved && replacementServerReentryRequested
          ? { replacementServerReentry: true as const }
          : {}),
        reload: () => requestStartupRecoveryReload(),
        ...(pairEntry.active && !recoveryReentryRequested
          ? { deeplinkSeed: pairEntry.seed }
          : {}),
        document,
        onRepairError: (error) => {
          console.error('webclient: cold-start local-access reset failed', error);
        },
        onHandoffError: (error) => {
          console.error('webclient: cold-start credential repair handoff failed', error);
        },
      });
    } catch (err) {
      repairCredentialConvergence?.close();
      setSplashMessage(
        'Recued could not open the local-access repair. Reload and try again.',
      );
      console.error('webclient: cold-start credential repair mount failed', err);
    }
    return;
  }

  const bootstrapDeps: PairFallbackBootstrapDeps = {
    root,
    localStore,
    // Same object, both surfaces: `createIndexedDbWebclientLocalStore` returns
    // a `WebclientProfileAwareStore`. The five-key half is what the rest of
    // the boot speaks; the roster half is what lets the shell mount the server
    // switcher — the one server control that keeps working when the paired
    // server does not answer.
    profileStore: localStore,
    tokenStore,
    transport,
    handleRef,
    // § A.4.1 — the entry owns the IDB handle to the
    // `recued.webclient.token_key` object store, so it supplies the
    // AES-GCM key wiper the bootstrap threads into Settings → Privacy.
    cryptoKeysWiper: wipeWebclientCryptoKeyStore,
    ...(pairEntry.active && !recoveryReentryRequested
      ? { deeplinkSeed: pairEntry.seed }
      : {}),
    ...(recoveryReentryUnresolved
      ? {
          reauthRecovery: {
            returnHash: globalThis.location?.hash || '#chat',
            recoveryReentry: true as const,
            ...(safeStopReentryRequested
              ? { safeStopReentry: true as const }
              : {}),
            ...(replacementServerReentryRequested
              ? { replacementServerReentry: true as const }
              : {}),
          },
        }
      : {}),
    ...(credentialHealth.pairCompletedInAnotherTab === true
      ? { silentCredentialConvergence: true }
      : {}),
  };
  if (
    startupReloadRecoveryRequested
    && credentialHealth.pairCompletedInAnotherTab !== true
  ) {
    queueStartupRecoveryForNextAttempt(bootstrapDeps, 'reload');
  }
  const outcome = await runBootstrapWithPairFallback(bootstrapDeps);
  // On a cold-start paired boot the reception route APPENDS to
  // `#webclient-root` (it does not clear it), and the boot splash is
  // `min-height:100vh` in normal flow — so a leftover splash would sit
  // on top of / above the mounted app. Drop it once the route is up.
  // On a `pair-form` (unpaired) or `failed` outcome the splash is the
  // live surface (form / startup recovery) and must stay. Codex 2026-05-28
  // NEXT-#1 finding #1. The post-pair re-entry path tears the splash
  // down symmetrically inside `onAfterPair`.
  if (outcome.kind === 'mounted') {
    removeBootSplashWrapper();
  }
};

void main();
