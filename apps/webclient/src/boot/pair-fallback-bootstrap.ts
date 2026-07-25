/** D-148 § A.4 / D-169 P1.5 NEXT-#1 — webclient pair-fallback bootstrap loop.
 *
 *  Extracted from `webclient-main.ts` so the
 *  pair → bootstrap → re-pair control loop is testable in isolation —
 *  the entry module runs `void main()` at import time, so a test that
 *  imports it would auto-boot the PWA. Mirrors the bridge's
 *  `apps/bridge/src/boot/` extraction discipline (the cold-start shim
 *  + service-worker bootstrap moved out of the entry for the same
 *  reason).
 *
 *  ── The teardown-timing fix (Codex 2026-05-28 P5 finding A) ─────────
 *
 *  The pre-fix `onAfterPair` ran `codeHandle.dispose()` +
 *  `removeBootSplashWrapper()` BEFORE `await runBootstrapWithPairFallback`.
 *  If the re-entry bootstrap then failed (a non-`WebclientUnpairedError`
 *  throw) or threw `WebclientUnpairedError` again (clock-skew race),
 *  the splash wrapper was already gone — so the failure copy written by
 *  `setSplashMessage`, and the re-mounted pair form's slot lookup, both
 *  targeted a detached / missing element. The user saw a blank screen
 *  and could only recover by reloading.
 *
 *  The fix makes `runBootstrapWithPairFallback` return a typed
 *  `BootstrapFallbackOutcome` and defers `removeBootSplashWrapper()`
 *  until the re-entry actually reached the reception route
 *  (`outcome.kind === 'mounted'`). On a re-entry pair-form or a boot
 *  failure the splash WRAPPER stays in the tree so it can host the
 *  live surface (the fresh form / the error copy). The form's own
 *  listeners are still torn down first (`codeHandle.dispose()` clears
 *  the message slot's innerHTML + detaches listeners, but leaves the
 *  wrapper element) so the re-mount never doubles up listeners.
 *
 *  Spec: D-148 § A.4 (Thin Webclient);
 *  D-169 (P1.5 pair persistence). */

import {
  bootstrapWebclient,
  WebclientUnpairedError,
  type WebclientHandle,
} from '../webclient-bootstrap.js';
import {
  mountPairCodeInputHost,
  type PairCodeInputDeeplinkSeed,
  type PairCodeInputRestoreInputs,
} from '../auth/pair-code-input-host.js';
import { createBrowserRestoreOnboarding } from '../auth/restore-onboarding.js';
import { mountRestoreOnboardingSplash } from '../auth/restore-onboarding-splash.js';
import { startRestoreOnboarding } from '../auth/restore-onboarding-flow.js';
import { createWebclientPairPassportInvoker } from '../auth/pair-passport-invoker.js';
import { resolveDeviceDisplayName } from '../auth/device-display-name.js';
import {
  finalizePairCodeSuccess,
  PAIR_CODE_SUCCESS_ERROR_COPY,
  resolveBrowserPairFinalizeLockProvider,
} from '../auth/pair-code-success.js';
import { createBrowserWebclientTransport } from '../realtime/browser-transport.js';
import {
  WEBCLIENT_LOCAL_KEYS,
  type WebclientLocalStore,
} from '../storage/local-store.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import type { ReceptionStatusInput } from '../settings/reception.js';

// ════════════════════════════════════════════════════════════════
// Splash messaging
// ════════════════════════════════════════════════════════════════

/** The boot-splash inner message element. The boot HTML ships with a
 *  fixed structure (`<div id="webclient-boot-splash-message">…</div>`
 *  inside `<div id="webclient-boot-splash">`); every init / pairing
 *  path updates the same element so the user sees one consistent
 *  surface. */
const SPLASH_MESSAGE_ID = 'webclient-boot-splash-message';
/** The boot-splash wrapper — the block `removeBootSplashWrapper` drops
 *  once the paired UI is the new tenant of `#webclient-root`. */
const SPLASH_WRAPPER_ID = 'webclient-boot-splash';

const resolveDocument = (doc?: Document): Document | undefined =>
  doc ?? (globalThis as { document?: Document }).document;

/** Replace the boot-splash inner message. Idempotent + null-safe: a
 *  missing splash element (already torn down, or a non-browser env) is
 *  a silent no-op. `doc` is a test seam — production omits it and the
 *  resolver falls back to `globalThis.document`. */
export const setSplashMessage = (text: string, doc?: Document): void => {
  const el = resolveDocument(doc)?.getElementById(SPLASH_MESSAGE_ID);
  if (el) el.textContent = text;
};

/** Drop the `#webclient-boot-splash` block from the DOM. Called once
 *  the pair flow has handed off to a successfully-mounted bootstrap —
 *  the splash served its purpose (loading message + pair-input form
 *  host) and the paired UI is the new tenant of `#webclient-root`.
 *  Idempotent + null-safe. `doc` is a test seam (see `setSplashMessage`). */
export const removeBootSplashWrapper = (doc?: Document): void => {
  const wrapper = resolveDocument(doc)?.getElementById(SPLASH_WRAPPER_ID);
  if (wrapper && wrapper.parentNode) {
    wrapper.parentNode.removeChild(wrapper);
  }
};

/** Resolve the host slot the pair-code-input form renders into.
 *
 *  The boot HTML ships one `#webclient-boot-splash > #...-message`
 *  block, and `removeBootSplashWrapper` drops it once a bootstrap
 *  reaches the reception route. That makes the slot a *one-time* boot
 *  element — but the pair form needs a slot on EVERY unpaired entry,
 *  including the re-pair triggered by `recoverFromReauthRequired`
 *  AFTER a successful mount already removed the splash. Without this
 *  helper, that re-entry would hand `mountPairCodeInputHost` a missing
 *  slot and the host would throw (stranding the user — and, because
 *  the reauth recovery fires via `void recoverFromReauthRequired(...)`,
 *  as an unhandled rejection). Codex 2026-05-28 P-(NEXT-#1) finding #2.
 *
 *  Returns the existing message element when the splash is present;
 *  otherwise re-creates the `#webclient-boot-splash >
 *  (.brand + #...-message)` structure under `#webclient-root` and
 *  returns the fresh message element. Returns `null` only when no
 *  document is resolvable (a non-browser env) — the caller then lets
 *  `mountPairCodeInputHost` fall back to its own `globalThis.document`
 *  lookup (which throws, caught + surfaced as a `failed` outcome). */
const ensureBootSplashSlot = (
  root: HTMLElement,
  docSeam?: Document,
): HTMLElement | null => {
  const doc = resolveDocument(docSeam);
  if (!doc) return null;
  const existing = doc.getElementById(SPLASH_MESSAGE_ID);
  if (existing) return existing;
  // The splash was torn down by a prior successful mount — rebuild the
  // boot-HTML structure so the form has somewhere to render. Mirrors
  // `apps/webclient/public/index.html`'s `#webclient-boot-splash` block.
  const wrapper = doc.createElement('div');
  wrapper.id = SPLASH_WRAPPER_ID;
  wrapper.className = 'webclient-boot-splash';
  const brand = doc.createElement('div');
  brand.className = 'webclient-boot-splash-brand';
  brand.textContent = 'Recued';
  const message = doc.createElement('div');
  message.id = SPLASH_MESSAGE_ID;
  wrapper.appendChild(brand);
  wrapper.appendChild(message);
  root.appendChild(wrapper);
  return message;
};

// ════════════════════════════════════════════════════════════════
// Pair-fallback bootstrap loop
// ════════════════════════════════════════════════════════════════

export interface PairFallbackBootstrapDeps {
  root: HTMLElement;
  localStore: WebclientLocalStore;
  tokenStore: WebclientTokenStore;
  transport: ReturnType<typeof createBrowserWebclientTransport>;
  handleRef: { current: WebclientHandle | null };
  /** § A.4.1 — AES-GCM key store wiper, threaded through to the
   *  bootstrap's Settings → Privacy "Clear this browser" panel. The
   *  entry module (`webclient-main`) owns the IDB handle, so the wiper
   *  is supplied as a dep rather than imported here — keeping this
   *  module free of the IDB plumbing (and free of a `webclient-main`
   *  import that would cycle). */
  cryptoKeysWiper: () => Promise<void>;
  /** D-156 P4 — deeplink pre-fills threaded into the pair-code-input
   *  host's `seed` option when present. Absent on the post-pair
   *  re-entry path (boot-time `?code=…` is stale after a successful
   *  pair). */
  deeplinkSeed?: PairCodeInputDeeplinkSeed;
  /** Optional live Reception exposure status for boot callers that can
   *  resolve it before entering the pair-fallback loop. */
  initialReceptionStatus?: ReceptionStatusInput;
  /** Test seam — overrides `globalThis.document` for the splash
   *  helpers + threads into `bootstrapWebclient` / `mountPairCodeInputHost`.
   *  Production omits it. */
  document?: Document;
}

/** What `runBootstrapWithPairFallback` did with the (re-)entry. The
 *  discriminator exists so the post-pair lifecycle in `onAfterPair`
 *  can decide whether the boot splash is now safe to tear down:
 *
 *    - `mounted`   — `bootstrapWebclient` resolved; the reception route
 *                    owns `#webclient-root`. The splash can be removed.
 *    - `pair-form` — `WebclientUnpairedError`; a fresh pair-code-input
 *                    host is mounted into the splash slot. The splash
 *                    MUST stay (it hosts the live form).
 *    - `failed`    — a non-unpaired error; the splash was upgraded to
 *                    failure copy. The splash MUST stay (it hosts the
 *                    live error message). */
export type BootstrapFallbackOutcome =
  | { kind: 'mounted' }
  | { kind: 'pair-form' }
  | { kind: 'failed' };

/** Try `bootstrapWebclient`; on `WebclientUnpairedError`, mount the
 *  pair-input host + retry once the user completes the pair flow. The
 *  retry happens IN-PROCESS (no reload) so the AES-GCM token-store
 *  key the bootstrap depends on persists across the pair transition.
 *
 *  Returns a `BootstrapFallbackOutcome` so the caller's `onAfterPair`
 *  lifecycle can sequence the splash teardown against the actual boot
 *  result (the D-169 P1.5 NEXT-#1 fix — see module header).
 *
 *  Codex P3 (historical) — recursive re-entry into this function isn't
 *  a risk: the second `bootstrapWebclient` call is the SAME store +
 *  transport instance the user just paired against, and a successful
 *  pair populated all 5 IDB fields so the second try doesn't throw
 *  `WebclientUnpairedError` again. If it does (e.g. a clock-skew race),
 *  the host re-mounts cleanly into the still-present splash slot. */
/** D-151 follow-on — resolve the paired instance id used for this pair.
 *  Reused from a prior `pair_metadata.instance_id` when present (a
 *  corruption-recovery re-pair keeps the same device identity), else
 *  freshly generated. Sent to `POST /auth/pair` as `instanceId` so the
 *  server stamps the issued token's `metadata.instance_id` + seeds the
 *  roster row, and persisted back into `pair_metadata` by
 *  `finalizePairCodeSuccess`. Without it the webclient connects bearer-
 *  only with a null `WsClient.instance_id` and every instance-gated rpc
 *  (`reception.*`, `collection.hostname.*`, …) rejects it as an
 *  "unregistered connection". The `localStore` read is best-effort — a
 *  read failure just falls through to a fresh id. */
const resolveOrGenerateInstanceId = async (
  localStore: WebclientLocalStore,
): Promise<string> => {
  try {
    const meta = await localStore.get('pair_metadata');
    const existing = meta?.instance_id;
    if (typeof existing === 'string' && existing.length > 0) return existing;
  } catch {
    /* best-effort — fall through to a fresh id */
  }
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  return `webclient-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
};

export const runBootstrapWithPairFallback = async (
  deps: PairFallbackBootstrapDeps,
): Promise<BootstrapFallbackOutcome> => {
  try {
    // D-151 follow-on — surface this device's pinned instance id (persisted
    // into `pair_metadata.instance_id` at pair time) so the Devices roster
    // renders the matching row as "This device" + blocks self-revoke.
    // Read-only (NOT resolve-or-generate): on an unpaired boot there is no
    // pair_metadata, so this is undefined and `bootstrapWebclient` throws
    // `WebclientUnpairedError` → the pair form mounts below; the post-pair
    // re-entry reads the freshly-persisted value. Best-effort — a store
    // read failure must not block boot.
    let currentInstanceId: string | undefined;
    try {
      const meta = await deps.localStore.get('pair_metadata');
      if (typeof meta?.instance_id === 'string' && meta.instance_id.length > 0) {
        currentInstanceId = meta.instance_id;
      }
    } catch {
      /* best-effort — leave currentInstanceId undefined */
    }
    const handle = await bootstrapWebclient({
      root: deps.root,
      localStore: deps.localStore,
      tokenStore: deps.tokenStore,
      transport: deps.transport,
      ...(currentInstanceId !== undefined ? { currentInstanceId } : {}),
      // The pair flow does not yet thread the active exposure profile
      // through `pair_metadata`. The Reception page renders "(none)"
      // until a non-empty value lands.
      exposureProfile: '',
      // § A.4.1 slice 110 — Settings → Privacy panel composition. The
      // entry module owns the IDB handle to the
      // `recued.webclient.token_key` object store; threading its wiper
      // here ensures the AES-GCM key is wiped end-to-end alongside the
      // closed-list 5 fields.
      cryptoKeysWiper: deps.cryptoKeysWiper,
      ...(deps.initialReceptionStatus !== undefined
        ? { initialReceptionStatus: deps.initialReceptionStatus }
        : {}),
      // § A.6.5 + § A.9 — passport-fetch verify path is default-on
      // (slice 128 flipped the bootstrap default from `=== true` to
      // `!== false`). Production keeps the explicit `true` here as
      // belt-and-suspenders.
      enablePassportFetchVerify: true,
      // M-REACH-4 — production Settings → Server gets the Reachability
      // Doctor external-probe front-door. Direct bootstrap tests keep this
      // opt-in so their Server-section shape does not change implicitly.
      enableReachabilityDoctor: true,
      // D-156 follow-on — the Settings → Devices roster + revoke surface.
      // The bootstrap default is OFF (it predates the self-host owner-id
      // fix that let the bearer-only webclient enumerate itself via
      // `pair.list`); now that `/auth/pair` seeds `SELF_HOST_OWNER_ID` and
      // the gate resolves a verified bearer to it, the page is live, so
      // production turns it on here. Direct bootstrap tests keep the
      // opt-in default. `currentInstanceId` (above) pins "This device".
      enableDevicesPage: true,
      ...(deps.document !== undefined ? { document: deps.document } : {}),
      // D-156 P8 Codex P1 fold — the bootstrap funnels the
      // `pair_required`-replacement signals (ws `reauth_required` +
      // passport-fetch MITM) through this callback. Wipe-and-remount:
      // dispose the active handle → clear the 5 IDB fields → re-enter
      // the pair-fallback loop. The freshly-cleared store throws
      // `WebclientUnpairedError` on the next hydrate, which mounts the
      // pair-code-input host below. Fire-once is guarded inside the
      // bootstrap.
      onReauthRequired: () => {
        // Surface a recovery failure instead of leaking an unhandled
        // rejection (finding #2b). `ensureBootSplashSlot` makes the
        // re-entry's pair-form mount robust, but a non-browser env (no
        // resolvable document) or an unexpected store error during the
        // field wipe could still reject — render it rather than strand
        // the user on a silent dead session.
        recoverFromReauthRequired(deps).catch((recoverErr) => {
          setSplashMessage(
            'Recued could not restart pairing after a server identity change. Reload to re-pair.',
            deps.document,
          );
          console.error('webclient: reauth recovery failed', recoverErr);
        });
      },
    });
    deps.handleRef.current = handle;
    // Successful bootstrap replaces the splash via `mountReceptionRoute`
    // (which appends to `#webclient-root`); the caller drops the splash
    // wrapper on the `mounted` outcome.
    return { kind: 'mounted' };
  } catch (err) {
    if (err instanceof WebclientUnpairedError) {
      // D-156 P8 — the only pair surface. `deeplinkSeed` pre-fills the
      // Pairing-code field when the user landed via the CLI's
      // `app.recued.com/pair?code=…` link.
      //
      // Codex 2026-05-28 trust-boundary fold — wire the cross-tab
      // single-flight lock at the host so the `/auth/pair` POST itself
      // is serialised across tabs. `finalizePairCodeSuccess` below
      // receives `lockProvider: null` because the host has already
      // acquired the lock (Web Locks queue same-name requests, so a
      // second acquire from inside would deadlock). The pre-flight
      // callback reads the strict triple so a paired-by-now-because-
      // tab-A-won state short-circuits BEFORE the `/auth/pair` POST
      // consumes a one-shot pair code on server B.
      //
      // P2-narrowed: `onAfterPair` runs OUTSIDE the lock so a queued
      // tab's preflight isn't blocked on this tab's
      // `runBootstrapWithPairFallback` (which awaits the full app
      // boot — DB hydrate + WS handshake + reception probe etc.). The
      // queued tab only needs `webclient_token` populated to short-
      // circuit; that happens inside `onPaired` before this lock
      // releases.
      // Resolve (or rebuild) the host slot BEFORE mounting. A re-pair
      // whose prior successful mount already removed the splash still
      // needs a surface to render into (finding #2a — see
      // `ensureBootSplashSlot`). On the common first-boot unpaired path
      // the boot-HTML splash is present and this returns it unchanged.
      const splashSlot = ensureBootSplashSlot(deps.root, deps.document);
      const pairLockProvider = resolveBrowserPairFinalizeLockProvider();
      // D-151 follow-on — pin a paired instance id for this device so the
      // bearer the server issues carries `metadata.instance_id` (forwarded
      // as `instanceId` below) + `finalizePairCodeSuccess` persists it.
      const instanceId = await resolveOrGenerateInstanceId(deps.localStore);
      // D-156 follow-on — derive a human-readable device label (e.g.
      // "Chrome on macOS") from the UA so the Devices roster row reads
      // legibly instead of the server's "unknown device" fallback. Sent
      // to `/auth/pair` as `displayName` (seeds the `paired_instances`
      // row + the issued token's `client_label`).
      const displayName = resolveDeviceDisplayName();
      const codeHandle = mountPairCodeInputHost({
        ...(deps.deeplinkSeed !== undefined ? { seed: deps.deeplinkSeed } : {}),
        ...(splashSlot !== null ? { splashElement: splashSlot } : {}),
        ...(deps.document !== undefined ? { document: deps.document } : {}),
        instanceId,
        displayName,
        lockProvider: pairLockProvider,
        preflightCheck: async () => {
          // Codex 2026-05-28 P5 finding B fold — match `hydratePairState`'s
          // strict triple (server_url + server_public_key +
          // webclient_token all non-null). Checking webclient_token
          // alone would lock the user out of a corruption-recovery
          // path where one of the other strict fields is missing —
          // the bootstrap mounts the pair form for that partial state,
          // but the host's preflight would still reject as already
          // paired. Stay symmetric with the inner
          // `finalizePairCodeSuccess` guard, which uses the same shape.
          const [token, url, key] = await Promise.all([
            deps.localStore.get('webclient_token'),
            deps.localStore.get('server_url'),
            deps.localStore.get('server_public_key'),
          ]);
          return {
            alreadyPaired: token !== null && url !== null && key !== null,
          };
        },
        onPaired: async (paired) => {
          const result = await finalizePairCodeSuccess({
            serverUrl: paired.serverUrl,
            bearer: paired.token,
            ...(paired.token_id !== undefined ? { token_id: paired.token_id } : {}),
            ...(paired.passport !== undefined ? { passport: paired.passport } : {}),
            instanceId,
            localStore: deps.localStore,
            tokenStore: deps.tokenStore,
            invokePassportFetch: createWebclientPairPassportInvoker({
              transportFactory: () => createBrowserWebclientTransport(),
            }),
            // The host already holds the pair-finalize lock — passing
            // null avoids the re-entrant deadlock that Web Locks would
            // otherwise queue forever (same-name same-mode requests
            // wait for the outer to release).
            lockProvider: null,
          });
          if (!result.ok) {
            // Surface the failure copy back into the host's status
            // surface by re-throwing — the host's onPaired catch arm
            // renders "Paired, but startup failed: …" inline + leaves
            // the form mounted so the user can retry. Throwing PREVENTS
            // onAfterPair from running (intentional — a failed finalize
            // means no paired state to bootstrap against).
            throw new Error(PAIR_CODE_SUCCESS_ERROR_COPY[result.error]);
          }
        },
        onAfterPair: async () => {
          // D-169 P1.5 NEXT-#1 — teardown timing fix (module header).
          //
          // Tear down THIS form first (clears the message slot's
          // innerHTML + detaches its listeners) so the re-entry below
          // never doubles up listeners on the shared splash element.
          // `dispose()` does NOT remove the splash WRAPPER — only its
          // contents — so the slot survives for the re-entry to render
          // into.
          codeHandle.dispose();
          // Transitional copy for the window between form teardown and
          // reception mount (the bootstrap awaits the WS handshake +
          // reception probe). Without it the user stares at an empty
          // splash box for the duration of the boot.
          setSplashMessage('Pairing complete — starting Recued…', deps.document);
          const outcome = await runBootstrapWithPairFallback(deps);
          // Only drop the splash wrapper once the reception route
          // actually mounted. On a re-entry pair-form (clock-skew race)
          // or a boot failure, the splash still hosts the live surface
          // (the fresh form / the failure copy) — removing it would
          // strand the user on a blank screen (the bug this fix closes).
          if (outcome.kind === 'mounted') {
            removeBootSplashWrapper(deps.document);
          }
        },
        // M5 S3.4 — the user chose the pair form's `Restore a backup` tab and
        // submitted. Tear down THIS pair form (its listeners on the shared
        // splash slot) so the restore splash surface owns the element cleanly,
        // then hand off to the flow controller, which builds the orchestrator +
        // mounts the progress/preview UI + drives the multi-step restore.
        onRestoreSubmit: async (firstInputs: PairCodeInputRestoreInputs) => {
          codeHandle.dispose();
          if (splashSlot === null) {
            // No surface to render the restore progress into (non-browser env)
            // — surface the failure rather than silently dropping the submit.
            setSplashMessage(
              'Could not start the restore — no display surface available. Reload and try again.',
              deps.document,
            );
            return;
          }
          const slot = splashSlot;
          startRestoreOnboarding(
            {
              splashElement: slot,
              buildOnboarding: (onRestored) =>
                createBrowserRestoreOnboarding({
                  localStore: deps.localStore,
                  tokenStore: deps.tokenStore,
                  instanceId,
                  onRestored,
                }),
              mountSplash: (args) =>
                mountRestoreOnboardingSplash({
                  ...args,
                  ...(deps.document !== undefined ? { document: deps.document } : {}),
                }),
              // A bounce re-mounts the collect form restore-ONLY (no
              // enter/generate tabs) — mid-restore the server is already
              // code-paired + an archive staged, so a normal pair is incoherent
              // and would reach this no-op `onPaired`. restoreOnly keeps it
              // unreachable; the only ways forward are fix-and-resubmit or
              // reload.
              mountRestoreCollectForm: (cf) =>
                mountPairCodeInputHost({
                  splashElement: slot,
                  ...(deps.document !== undefined ? { document: deps.document } : {}),
                  instanceId,
                  displayName,
                  onPaired: async () => {},
                  onRestoreSubmit: cf.onRestoreSubmit,
                  initialRecoveryMode: 'restore',
                  restoreOnly: true,
                  restoreSeedFile: cf.seedFile,
                  seed: {
                    serverUrl: cf.seedInputs.serverUrl,
                    pairingCode: cf.seedInputs.code,
                  },
                  restoreNotice: { message: cf.message, focus: cf.focus },
                }),
              reBootstrap: () => runBootstrapWithPairFallback(deps),
              onReload: () => {
                const loc = (globalThis as { location?: { reload?: () => void } })
                  .location;
                loc?.reload?.();
              },
              dropSplash: () => removeBootSplashWrapper(deps.document),
            },
            firstInputs,
          );
        },
      });
      return { kind: 'pair-form' };
    }
    setSplashMessage(
      'Recued failed to start. Check the browser console for details, or contact your server admin.',
      deps.document,
    );
    console.error('webclient: bootstrap failed', err);
    return { kind: 'failed' };
  }
};

/** D-156 P8 Codex P1 fold — handle the bootstrap's `onReauthRequired`
 *  signal. Dispose the active handle, wipe the 5 IDB fields so the
 *  next hydrate throws `WebclientUnpairedError`, then re-enter the
 *  pair-fallback loop. The pair form mounts on top of the freshly-
 *  cleared splash, the user re-pairs, and the natural success-path
 *  re-populates the 5 fields against the rotated server identity.
 *
 *  The reception route's slot DOM remains until the next bootstrap's
 *  unpaired-error fallback mounts the pair-code-input host — the
 *  bootstrap dispose tears down the reception shell + slots, leaving
 *  `#webclient-root` empty for the pair form. */
const recoverFromReauthRequired = async (
  deps: PairFallbackBootstrapDeps,
): Promise<void> => {
  const active = deps.handleRef.current;
  deps.handleRef.current = null;
  if (active) {
    try {
      await active.dispose();
    } catch (err) {
      console.error('webclient: bootstrap dispose during reauth recovery failed', err);
    }
  }
  for (const key of WEBCLIENT_LOCAL_KEYS) {
    try {
      await deps.localStore.remove(key);
    } catch (err) {
      console.error('webclient: local-store remove during reauth recovery failed', key, err);
    }
  }
  // Re-enter the pair-fallback loop. The hydrate path now sees a blank
  // store + throws `WebclientUnpairedError`, which mounts the
  // pair-code-input host. The boot-time deeplink seed is intentionally
  // dropped — a server identity rotation invalidates any cached `?code=`.
  const reentry = { ...deps };
  delete reentry.deeplinkSeed;
  await runBootstrapWithPairFallback(reentry);
};
