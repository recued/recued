/** D-148 § A.4 / D-169 P1.5 NEXT-#1 — webclient pair-fallback bootstrap loop.
 *
 *  Extracted from `webclient-main.ts` so the
 *  pair → bootstrap → re-pair control loop is testable in isolation —
 *  the entry module runs `void main()` at import time, so a test that
import time, so a test that
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
 *  live surface (the fresh form / the saved-access startup recovery).
 *  The form's own
 *  listeners are still torn down first (`codeHandle.dispose()` clears
 *  the message slot's innerHTML + detaches listeners, but leaves the
 *  wrapper element) so the re-mount never doubles up listeners.
 *
 *  Spec: D-148 § A.4 (Thin Webclient);
 *  D-169 (P1.5 pair persistence). */

import {
  bootstrapWebclient,
  WEBCLIENT_SHELL_CONTENT_ATTR,
  WebclientUnpairedError,
  type WebclientHandle,
  type WebclientRecoverySnapshot,
} from '../webclient-bootstrap.js';
import {
  mountPairCodeInputHost,
  type PairCodeInputDeeplinkSeed,
  type PairCodeInputReauthReason,
  type PairCodeInputRestoreInputs,
} from '../auth/pair-code-input-host.js';
import { createBrowserRestoreOnboarding } from '../auth/restore-onboarding.js';
import {
  mountReturnToServer,
  RETURN_TO_SERVER_ATTR,
  RETURN_TO_SERVER_STYLES,
} from '../shell/return-to-server.js';
import { mountRestoreOnboardingSplash } from '../auth/restore-onboarding-splash.js';
import { startRestoreOnboarding } from '../auth/restore-onboarding-flow.js';
import { createWebclientPairPassportInvoker } from '../auth/pair-passport-invoker.js';
import { resolveDeviceDisplayName } from '../auth/device-display-name.js';
import {
  finalizePairCodeSuccess,
  PAIR_CODE_SUCCESS_ERROR_COPY,
  resolveBrowserPairFinalizeLockProvider,
  withPairFinalizeLock,
  type PairFinalizeLockProvider,
} from '../auth/pair-code-success.js';
import { createBrowserWebclientTransport } from '../realtime/browser-transport.js';
import {
  WEBCLIENT_LOCAL_KEYS,
  type WebclientLocalStore,
  type WebclientProfileStore,
} from '../storage/local-store.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import type { ReceptionStatusInput } from '../reception/spine.js';
import {
  createBrowserPairTabConvergence,
  type PairTabConvergence,
} from './pair-tab-convergence.js';
import {
  mountPostPairStartupRecovery,
  type MountPostPairStartupRecoveryOptions,
  type MountedPostPairStartupRecovery,
} from './post-pair-startup-recovery.js';
import {
  readCompleteStoredPair,
  readStoredPairState,
  sameStoredCredentialGeneration,
  type StoredPairVersion,
} from './stored-pair-state.js';
import { cleanConsumedPairEntryUrl } from './secure-access-resume.js';
import {
  mountStartupFailureTriage,
  type MountedStartupFailureTriage,
  type MountStartupFailureTriageOptions,
} from './startup-failure-triage.js';
import {
  requestStartupRecoveryReload,
  type StartupReloadRecoveryStorage,
} from './startup-reload-recovery.js';
import {
  armRecoveryReentry,
  armReplacementServerRecoveryReentry,
  armSafeStopRecoveryReentry,
  retireRecoveryReentry,
  type RecoveryReentryStorage,
} from './recovery-reentry.js';

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

/** One-shot confirmation shown by the mounted connection banner after a normal
 * pair. It confirms the durable browser-side outcome without holding the user
 * on the boot splash or stealing focus from the route they came to use. */
export const PAIR_SUCCESS_RETURN_RECEIPT_COPY =
  'This browser is paired. Your sign-in is saved here, and your page is ready.';
/** One-shot confirmation after the explicit replaced/reset-server path. It is
 * shown only after the new server passport has finalized and the replacement
 * shell has mounted, so “verified” never describes the pre-submit review. */
export const REPLACEMENT_SERVER_RETURN_RECEIPT_COPY =
  'The new link is checked and saved, and your page is ready. Nothing was brought over from the old server.';

/** One-shot confirmations for an explicit startup retry that finally opens the
 * shell. These replace pairing/reconnect receipts from the failed attempt and
 * tell the user which locally-preserved work survived the recovery. */
export const STARTUP_RECOVERY_RETURN_RECEIPT_COPY =
  'Recued started up again. Your sign-in is still saved, and your page is ready.';
export const STARTUP_RECOVERY_DRAFT_RETURN_RECEIPT_COPY =
  'Recued started up again. Your sign-in is still saved, and the Chat message you had not sent is ready.';

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

interface PairHandoffCopyOptions {
  readonly completedInAnotherTab: boolean;
  readonly reconnecting: boolean;
  readonly draftPreserved: boolean;
  readonly replacementServer?: boolean;
}

const pairHandoffCopy = (options: PairHandoffCopyOptions): string => {
  if (options.completedInAnotherTab) {
    if (!options.reconnecting) {
      return 'Another tab finished pairing this browser. Opening your page…';
    }
    return options.draftPreserved
      ? 'Another tab reconnected. Going back to the Chat message you had not sent…'
      : 'Another tab reconnected. Going back to your page…';
  }
  if (!options.reconnecting) return 'This browser is paired. Starting Recued…';
  if (options.replacementServer) {
    return 'Your server accepted the new link. Checking it really is your server, then going back to your page…';
  }
  return options.draftPreserved
    ? 'Reconnected. Going back to the Chat message you had not sent…'
    : 'Reconnected. Going back to your page…';
};

/** Own the short interval after a pair form disappears and before the exact
 * route mounts. The removed input may have held keyboard/screen-reader focus,
 * so expose and focus one polite status instead of dropping focus onto the
 * document. Return a cleanup that restores the host's prior semantics before
 * any interactive failure/recovery surface reuses it. */
const showPairHandoffStatus = (
  text: string,
  doc?: Document,
): (() => void) => {
  const el = resolveDocument(doc)?.getElementById(SPLASH_MESSAGE_ID);
  if (el === null || el === undefined) return () => undefined;
  const attributeHost = el as HTMLElement & {
    getAttribute?: (name: string) => string | null;
    setAttribute?: (name: string, value: string) => void;
    removeAttribute?: (name: string) => void;
  };
  const attributes = [
    ['role', 'status'],
    ['aria-live', 'polite'],
    ['aria-atomic', 'true'],
    ['tabindex', '-1'],
  ] as const;
  const previous = attributes.map(([name]) => [
    name,
    attributeHost.getAttribute?.(name) ?? null,
  ] as const);
  for (const [name, value] of attributes) {
    attributeHost.setAttribute?.(name, value);
  }
  el.textContent = text;
  try {
    el.focus?.({ preventScroll: true });
  } catch {
    /* best-effort focus continuity in minimal/non-DOM environments */
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [name, value] of previous) {
      if (value === null) attributeHost.removeAttribute?.(name);
      else attributeHost.setAttribute?.(name, value);
    }
  };
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

const currentHash = (deps: PairFallbackBootstrapDeps): string => {
  if (deps.currentHash !== undefined) return deps.currentHash();
  const fromDocument = deps.document?.defaultView?.location.hash;
  if (typeof fromDocument === 'string' && fromDocument.length > 0) {
    return fromDocument;
  }
  const fromGlobal = (globalThis as { location?: { hash?: string } })
    .location?.hash;
  return typeof fromGlobal === 'string' && fromGlobal.length > 0
    ? fromGlobal
    : '#chat';
};

const restoreHash = (
  hash: string,
  deps: PairFallbackBootstrapDeps,
): void => {
  if (deps.replaceHash !== undefined) {
    deps.replaceHash(hash);
    return;
  }
  const view = deps.document?.defaultView
    ?? (globalThis as unknown as Window | undefined);
  if (view?.location === undefined || view.location.hash === hash) return;
  try {
    view.history?.replaceState?.(null, '', hash);
  } catch {
    view.location.hash = hash;
  }
};

/** Pair codes and secure-handoff markers are consumed credentials/boot intent,
 * not durable page state. Scrub them as soon as the server accepts pairing, or
 * when a sibling signal/partial write proves that happened elsewhere. Preserve
 * every unrelated query byte plus the exact path/hash. */
const cleanPairEntryFromAddressBar = (
  deps: PairFallbackBootstrapDeps,
): void => {
  try {
    const view = deps.document?.defaultView
      ?? (globalThis as unknown as Window | undefined);
    const source = deps.currentUrl?.() ?? view?.location?.href;
    if (typeof source !== 'string' || source.length === 0) return;
    const cleaned = cleanConsumedPairEntryUrl(source);
    if (cleaned === source) return;
    if (deps.replaceUrl !== undefined) {
      deps.replaceUrl(cleaned);
      return;
    }
    if (typeof view?.history?.replaceState !== 'function') return;
    view.history.replaceState(view.history.state, '', cleaned);
  } catch (err) {
    // Address-bar hygiene must never turn a completed, persisted pair into a
    // false pairing failure or reload away the in-memory token key.
    console.error(
      'webclient: could not clear consumed pairing details from the address bar',
      err,
    );
  }
};

/** Move keyboard / screen-reader context from the removed pair form into the
 * exact mounted route. The shell's `<main>` survives route re-renders, unlike a
 * route heading painted during async hydration. Preserve an interactive work
 * control when the route has already claimed one intentionally. */
const focusMountedReturnRoute = (deps: PairFallbackBootstrapDeps): void => {
  const doc = resolveDocument(deps.document);
  if (doc === undefined) return;
  const contentRoot = deps.root.querySelector?.(
    `[${WEBCLIENT_SHELL_CONTENT_ATTR}]`,
  ) as HTMLElement | null;
  if (contentRoot === null || typeof contentRoot.focus !== 'function') return;
  const active = doc.activeElement;
  const activeContenteditable =
    active?.getAttribute('contenteditable') ?? null;
  if (
    active !== null
    && active !== contentRoot
    && typeof contentRoot.contains === 'function'
    && contentRoot.contains(active)
    && (
      ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)
      || (
        activeContenteditable !== null
        && activeContenteditable.toLowerCase() !== 'false'
      )
    )
  ) {
    return;
  }
  if (!contentRoot.hasAttribute('tabindex')) {
    contentRoot.setAttribute('tabindex', '-1');
  }
  try {
    contentRoot.focus({ preventScroll: true });
  } catch {
    /* detached / constrained host — the mounted route remains usable */
  }
};

// ════════════════════════════════════════════════════════════════
// Pair-fallback bootstrap loop
// ════════════════════════════════════════════════════════════════

export interface PairFallbackBootstrapDeps {
  root: HTMLElement;
  localStore: WebclientLocalStore;
  /** Roster half of the same store, forwarded to `bootstrapWebclient` so the
   *  shell can mount the server switcher. Optional: a caller without one
   *  simply gets no switcher, which is the right reading for a host that has
   *  no roster to switch between. */
  profileStore?: WebclientProfileStore;
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
  /** Safe pair-entry pre-fills threaded into the pair-code-input host: a CLI
   *  `?code=…`, and optionally a server URL derived from the live secure
   *  origin. Absent on post-pair re-entry because the code is then stale. */
  deeplinkSeed?: PairCodeInputDeeplinkSeed;
  /** In-memory context carried only from a live reauth teardown into its
   * replacement pair form and post-pair bootstrap. Never persisted. */
  reauthRecovery?: PairFallbackReauthRecovery;
  /** One-shot: a sibling made a healthy pair durable while this tab was still
   * in its cold-start check. The next bootstrap mounts the exact route without
   * claiming a second success receipt. Attempt tracking consumes it without
   * mutating this caller-owned dependency graph. */
  silentCredentialConvergence?: boolean;
  /** Hash seams for deterministic tests. Production uses the document view. */
  currentHash?: () => string;
  replaceHash?: (hash: string) => void;
  /** Full-URL seams for post-pair history cleanup. Production reads
   * `location.href` and uses `history.replaceState` (never navigation). */
  currentUrl?: () => string;
  replaceUrl?: (url: string) => void;
  /** In-memory, one-shot copy passed only to the next mounted shell's first
   * connected receipt. Consumed as soon as that shell resolves, before any
   * later retry, reload, or reauthorization cycle can reuse it. */
  postPairReceiptCopy?: string;
  /** Deterministic test seam for the post-pair startup recovery host. */
  postPairStartupRecoveryFactory?: (
    options: MountPostPairStartupRecoveryOptions,
  ) => MountedPostPairStartupRecovery;
  /** Deterministic test seam for cause-aware cold/repeated startup triage. */
  startupFailureTriageFactory?: (
    options: MountStartupFailureTriageOptions,
  ) => MountedStartupFailureTriage;
  /** Browser connectivity hint and reload seams for startup triage. */
  startupOnlineStatus?: () => boolean | null;
  startupReload?: () => void;
  /** Same-tab marker store for an intentional startup-recovery reload.
   * Production resolves sessionStorage; tests may inject or disable it. */
  startupReloadRecoveryStorage?: StartupReloadRecoveryStorage | null;
  /** Same-tab, constant-only marker for a guided reconnect that must survive
   * loss of its final document. Production resolves sessionStorage. */
  recoveryReentryStorage?: RecoveryReentryStorage | null;
  startupDiagnosticWriter?: (summary: string) => Promise<void>;
  startupDiagnosticNow?: () => Date;
  /** Browser-journey seam for inducing a failure at the application bootstrap
   * boundary after pair persistence. Production always uses the imported
   * `bootstrapWebclient`. */
  bootstrap?: typeof bootstrapWebclient;
  /** Shared pairing/recovery lock seam. Production resolves Web Locks. Passing
   * null explicitly opts out in deterministic or unsupported environments. */
  pairLockProvider?: PairFinalizeLockProvider | null;
  /** Factory for the credential-free signal/poll lifecycle that lets a stale
   * sibling pair form adopt a pair completed in another tab. Production uses
   * BroadcastChannel with focus/poll fallback; null explicitly opts out. */
  pairTabConvergenceFactory?: (() => PairTabConvergence | null) | null;
  /** Guided re-pair stall threshold passed to the pair form. Production uses
   * the host default; browser journeys can shorten it deterministically. */
  siblingTakeoverDelayMs?: number | null;
  /** Browser-journey/test seams for the recovery-owner heartbeat lease. */
  siblingRecoveryOwnerDelayMs?: number;
  recoveryOwnerHeartbeatMs?: number | null;
  /** Factory for the event/focus-driven observer used while the full shell is
   * mounted. Kept separate from the pair-form factory because long-lived tabs
   * deliberately disable polling. */
  credentialTabConvergenceFactory?: (() => PairTabConvergence | null) | null;
  /** Optional live Reception exposure status for boot callers that can
   *  resolve it before entering the pair-fallback loop. */
  initialReceptionStatus?: ReceptionStatusInput;
  /** Test seam — overrides `globalThis.document` for the splash
   *  helpers + threads into `bootstrapWebclient` / `mountPairCodeInputHost`.
   *  Production omits it. */
  document?: Document;
}

export interface PairFallbackReauthRecovery
  extends WebclientRecoverySnapshot {
  /** Why this guided pair is being shown. Omitted/live default means the
   * server rejected a previously usable credential. */
  readonly reason?: PairCodeInputReauthReason;
  /** Previously trusted local address; safe to prefill after the store wipe. */
  readonly serverUrl?: string;
  /** Rescued device identity for local-only repair. Live revocation recovery
   * omits this so a revoked instance cannot be resurrected. */
  readonly instanceId?: string;
  /** True only when this tab is returning through credentials made durable by
   * a sibling. The work snapshot still restores, but this tab must not claim
   * the other tab's pairing/reconnection receipt. */
  readonly pairCompletedInAnotherTab?: boolean;
  /** Temporary tab-close guard while no mounted route owns the rescued draft.
   * In-memory lifecycle seam only; released after the restored route mounts. */
  readonly draftGuard?: RecoveryDraftGuard;
  /** This recovery context was rebuilt from a constant prior-document marker.
   * Pair inputs and work data were deliberately not persisted with it. */
  readonly recoveryReentry?: true;
  /** The consumed constant distinguished a deliberate missing-key stop from a
   * generic interrupted recovery. No rejection detail accompanies it. */
  readonly safeStopReentry?: true;
  /** The consumed constant distinguished an administrator-confirmed replaced
   * or reset server path. Server details and recovery material remain absent. */
  readonly replacementServerReentry?: true;
}

type CredentialRecoveryCause =
  | 'session_rejected'
  | 'credentials_changed_elsewhere'
  | 'credentials_replaced_elsewhere';

interface CredentialRecoveryOptions {
  readonly cause: CredentialRecoveryCause;
  /** Called after the lock observes an already-empty store or this tab
   * attempts the rejected-generation wipe. The observer is advisory and
   * siblings always re-read durable state, so recovery survives a throw. */
  readonly onCredentialsRemoved?: () => void;
}

interface RecoveryDraftGuard {
  readonly release: () => void;
  readonly isActive: () => boolean;
}

const pairLockProviderFor = (
  deps: PairFallbackBootstrapDeps,
): PairFinalizeLockProvider | null =>
  deps.pairLockProvider !== undefined
    ? deps.pairLockProvider
    : resolveBrowserPairFinalizeLockProvider();

const pairTabConvergenceFor = (
  deps: PairFallbackBootstrapDeps,
): PairTabConvergence | null => {
  if (deps.pairTabConvergenceFactory === null) return null;
  try {
    if (deps.pairTabConvergenceFactory !== undefined) {
      return deps.pairTabConvergenceFactory();
    }
    return createBrowserPairTabConvergence({
      ...(deps.document !== undefined ? { document: deps.document } : {}),
    });
  } catch (err) {
    // Cross-tab convenience cannot block the ordinary pair form. A user can
    // still complete this tab directly if the browser signal substrate fails.
    console.error('webclient: pair-tab convergence unavailable', err);
    return null;
  }
};

const credentialTabConvergenceFor = (
  deps: PairFallbackBootstrapDeps,
): PairTabConvergence | null => {
  if (deps.credentialTabConvergenceFactory === null) return null;
  try {
    if (deps.credentialTabConvergenceFactory !== undefined) {
      return deps.credentialTabConvergenceFactory();
    }
    return createBrowserPairTabConvergence({
      ...(deps.document !== undefined ? { document: deps.document } : {}),
      pollMs: null,
    });
  } catch (err) {
    // Credential convergence improves continuity but cannot block an
    // otherwise healthy shell. Focus/reload and the server's auth rejection
    // remain safe fallbacks when this browser substrate is unavailable.
    console.error('webclient: credential-tab convergence unavailable', err);
    return null;
  }
};

/** Carry only a trusted same-origin address into the rare case where a
 * post-pair bootstrap still resolves unpaired. Pair codes are one-shot and
 * must never survive either the initiating or sibling-tab handoff. */
const buildPostPairReentry = (
  deps: PairFallbackBootstrapDeps,
): PairFallbackBootstrapDeps => {
  const reentry: PairFallbackBootstrapDeps = { ...deps };
  delete reentry.silentCredentialConvergence;
  if (
    deps.deeplinkSeed?.sameOriginResume === true
    && deps.deeplinkSeed.serverUrl !== undefined
    && deps.deeplinkSeed.serverUrl.trim().length > 0
  ) {
    reentry.deeplinkSeed = {
      serverUrl: deps.deeplinkSeed.serverUrl,
      sameOriginResume: true,
    };
  } else {
    delete reentry.deeplinkSeed;
  }
  return reentry;
};

interface StartupFailureRecoveryContext {
  readonly savedAccessVerified: boolean;
  readonly repeated: boolean;
  readonly completedInAnotherTab?: boolean;
  /** Durable generation this card was opened against. Sibling-aware triage
   * re-reads it before keeping any "pairing complete" claim on screen. */
  readonly credentialVersion?: StoredPairVersion;
  readonly reloadAttempted?: boolean;
  readonly stripPairInputs: boolean;
  readonly diagnosticServerUrl?: string | null;
}

interface StartupRecoveryCredentialSnapshot {
  readonly diagnosticServerUrl: string | null;
  readonly credentialVersion?: StoredPairVersion;
}

/** Prefer the current complete durable generation after pairing. Capture its
 * version with the diagnostic host so a later sibling signal can distinguish
 * the access this failed attempt used from a replacement generation. */
const resolveStartupRecoveryCredentialSnapshot = async (
  deps: PairFallbackBootstrapDeps,
): Promise<StartupRecoveryCredentialSnapshot> => {
  try {
    // Pair persistence spans several IndexedDB fields. Read the generation
    // under the same lock as finalization so a retry cannot capture a
    // transient mixture and then mount sibling-aware triage without a usable
    // baseline.
    const storedPair = await withPairFinalizeLock(
      pairLockProviderFor(deps),
      () => readCompleteStoredPair(deps.localStore),
    );
    if (storedPair !== null) {
      return {
        diagnosticServerUrl: storedPair.serverUrl,
        credentialVersion: storedPair.version,
      };
    }
  } catch {
    /* best-effort diagnostic context; startup recovery must still render */
  }
  return {
    diagnosticServerUrl: deps.reauthRecovery?.serverUrl
      ?? deps.deeplinkSeed?.serverUrl
      ?? null,
  };
};

/** Keep a failed paired/cold bootstrap on one non-destructive recovery card.
 * Every retry is attempt-scoped: generic catch copy stays on the card, while a
 * stale pair/reconnect receipt is replaced by a startup confirmation only if
 * that exact retry mounts the shell. */
const mountStartupFailureRecovery = (
  deps: PairFallbackBootstrapDeps,
  reentry: PairFallbackBootstrapDeps,
  failure: unknown,
  context: StartupFailureRecoveryContext,
): MountedStartupFailureTriage => {
  const splashSlot = ensureBootSplashSlot(deps.root, deps.document);
  if (splashSlot === null) {
    throw new Error('startup failure triage: splash slot unavailable');
  }
  const retryDeps: PairFallbackBootstrapDeps = context.stripPairInputs
    ? { ...buildPostPairReentry(reentry) }
    : { ...reentry };
  const siblingCredentialVersion =
    context.completedInAnotherTab === true
    && context.savedAccessVerified
      ? context.credentialVersion
      : undefined;
  if (siblingCredentialVersion !== undefined) {
    const existingRecovery = retryDeps.reauthRecovery;
    retryDeps.reauthRecovery = {
      ...(existingRecovery ?? { returnHash: currentHash(retryDeps) }),
      ...(existingRecovery?.serverUrl === undefined
        ? { serverUrl: siblingCredentialVersion.serverUrl }
        : {}),
      reason: 'startup_credentials_changed_elsewhere',
      pairCompletedInAnotherTab: true,
    };
  }
  // A startup retry must never replay a receipt that belonged to the attempt
  // that failed. A later genuine pair/reconnect lifecycle creates its own.
  delete retryDeps.postPairReceiptCopy;
  let triageHandle: MountedStartupFailureTriage;
  let credentialConvergence: PairTabConvergence | null = null;
  let unsubscribeCredentialConvergence = (): void => undefined;
  let credentialConvergenceClosed = false;
  let credentialReconcileInFlight = false;
  let credentialReconcilePending = false;
  let credentialReadFailureReported = false;
  const closeCredentialConvergence = (): void => {
    if (credentialConvergenceClosed) return;
    credentialConvergenceClosed = true;
    credentialReconcilePending = false;
    try {
      unsubscribeCredentialConvergence();
    } catch {
      /* best-effort listener teardown */
    }
    try {
      credentialConvergence?.close();
    } catch {
      /* best-effort channel teardown */
    }
    credentialConvergence = null;
  };
  const reconcileSiblingCredentialTransition = async (): Promise<void> => {
    if (
      credentialConvergenceClosed
      || siblingCredentialVersion === undefined
    ) {
      return;
    }
    if (credentialReconcileInFlight) {
      credentialReconcilePending = true;
      return;
    }
    credentialReconcileInFlight = true;
    try {
      const state = await withPairFinalizeLock(
        pairLockProviderFor(retryDeps),
        () => readStoredPairState(retryDeps.localStore),
      );
      if (credentialConvergenceClosed) return;
      if (
        state.kind === 'complete'
        && sameStoredCredentialGeneration(
          siblingCredentialVersion,
          state.pair.version,
        )
      ) {
        return;
      }
      // The durable access this card described is no longer authoritative.
      // Retire the observer before the same pair/startup loop takes ownership;
      // a verified replacement can open silently, while empty/partial state
      // becomes the guided re-pair form prepared on `retryDeps` above.
      closeCredentialConvergence();
      void triageHandle.retry();
    } catch (err) {
      // A hint is advisory. Storage uncertainty must not turn verified access
      // into a false re-pair; focus or the next signal can try the read again.
      if (!credentialReadFailureReported) {
        credentialReadFailureReported = true;
        console.error(
          'webclient: startup-recovery credential check failed',
          err,
        );
      }
    } finally {
      credentialReconcileInFlight = false;
      if (
        credentialReconcilePending
        && !credentialConvergenceClosed
      ) {
        credentialReconcilePending = false;
        void reconcileSiblingCredentialTransition();
      }
    }
  };
  const mountTriage = deps.startupFailureTriageFactory
    ?? mountStartupFailureTriage;
  const mountedTriage = mountTriage({
    splashElement: splashSlot,
    ...(deps.document !== undefined ? { document: deps.document } : {}),
    initialFailure: failure,
    savedAccessVerified: context.savedAccessVerified,
    draftPreserved: retryDeps.reauthRecovery?.chatDraft !== undefined,
    repeated: context.repeated,
    ...(context.completedInAnotherTab !== undefined
      ? { completedInAnotherTab: context.completedInAnotherTab }
      : {}),
    ...(context.reloadAttempted !== undefined
      ? { reloadAttempted: context.reloadAttempted }
      : {}),
    ...(deps.startupOnlineStatus !== undefined
      ? { online: deps.startupOnlineStatus }
      : {}),
    onReload: () => {
      requestStartupRecoveryReload({
        ...(deps.startupReloadRecoveryStorage !== undefined
          ? { storage: deps.startupReloadRecoveryStorage }
          : {}),
        ...(deps.startupReload !== undefined
          ? { reload: deps.startupReload }
          : {}),
      });
    },
    ...(deps.startupDiagnosticWriter !== undefined
      ? { diagnosticWriter: deps.startupDiagnosticWriter }
      : {}),
    ...(deps.startupDiagnosticNow !== undefined
      ? { diagnosticNow: deps.startupDiagnosticNow }
      : {}),
    ...(context.diagnosticServerUrl !== undefined
      ? { diagnosticServerUrl: context.diagnosticServerUrl }
      : {}),
    onFailure: (nextFailure, kind) => {
      console.error(
        `webclient: startup retry failed (${kind})`,
        nextFailure,
      );
    },
    onRetry: async () => {
      preservedBootstrapFailureSurfaces.add(retryDeps);
      suppressedPostPairConnectedReceipts.add(retryDeps);
      queueStartupRecoveryForNextAttempt(retryDeps);
      if (retryDeps.reauthRecovery !== undefined) {
        restoreHash(retryDeps.reauthRecovery.returnHash, retryDeps);
      }
      const outcome = await runBootstrapWithPairFallback(retryDeps);
      if (outcome.kind === 'mounted') {
        triageHandle.dispose();
        retryDeps.reauthRecovery?.draftGuard?.release();
        removeBootSplashWrapper(retryDeps.document);
        return;
      }
      if (outcome.kind === 'pair-form') {
        // Saved access genuinely disappeared while triage was open. The normal
        // guarded pair form now owns the slot; preserve it while retiring this
        // host's delegated click listener.
        triageHandle.detach();
        return;
      }
      throw outcome.error;
    },
  });
  triageHandle = {
    retry: mountedTriage.retry,
    showFailure: mountedTriage.showFailure,
    detach: () => {
      closeCredentialConvergence();
      mountedTriage.detach();
    },
    dispose: () => {
      closeCredentialConvergence();
      mountedTriage.dispose();
    },
  };
  if (siblingCredentialVersion !== undefined) {
    credentialConvergence = credentialTabConvergenceFor(retryDeps);
    if (credentialConvergence !== null) {
      try {
        unsubscribeCredentialConvergence = credentialConvergence.subscribe(
          () => {
            void reconcileSiblingCredentialTransition();
          },
        );
        // Close the subscribe-after-render race: the sibling may have changed
        // durable access between the failed attempt and listener attachment.
        void reconcileSiblingCredentialTransition();
      } catch (err) {
        console.error(
          'webclient: startup-recovery credential listener unavailable',
          err,
        );
        closeCredentialConvergence();
      }
    }
  }
  return triageHandle;
};

/** Mount the retry-only boundary after credentials are durable but the first
 * application shell did not open. Pairing fields and earlier lifecycle
 * receipts are absent; a successful explicit retry earns its own confirmation.
 */
const mountDurableCredentialStartupRecovery = (
  deps: PairFallbackBootstrapDeps,
  reentry: PairFallbackBootstrapDeps,
  completedInAnotherTab: boolean,
): void => {
  const splashSlot = ensureBootSplashSlot(deps.root, deps.document);
  if (splashSlot === null) {
    setSplashMessage(
      'Secure access is saved, but Recued could not open. Reload this tab to try startup again; you do not need to pair again.',
      deps.document,
    );
    return;
  }
  const retryDeps: PairFallbackBootstrapDeps = {
    ...buildPostPairReentry(reentry),
  };
  delete retryDeps.postPairReceiptCopy;
  let recoveryHandle: MountedPostPairStartupRecovery;
  try {
    const mountRecovery = deps.postPairStartupRecoveryFactory
      ?? mountPostPairStartupRecovery;
    recoveryHandle = mountRecovery({
      splashElement: splashSlot,
      ...(deps.document !== undefined ? { document: deps.document } : {}),
      reconnect: retryDeps.reauthRecovery !== undefined,
      draftPreserved: retryDeps.reauthRecovery?.chatDraft !== undefined,
      completedInAnotherTab,
      onRetry: async () => {
        // These controls are attempt-scoped. A later genuine reauthorization
        // using this long-lived dependency graph must regain its own receipt
        // and ordinary failure surface.
        preservedBootstrapFailureSurfaces.add(retryDeps);
        suppressedPostPairConnectedReceipts.add(retryDeps);
        queueStartupRecoveryForNextAttempt(retryDeps);
        if (retryDeps.reauthRecovery !== undefined) {
          restoreHash(retryDeps.reauthRecovery.returnHash, retryDeps);
        }
        // Capture the durable server immediately before this exact attempt so a
        // later sibling-tab credential change cannot relabel its failure.
        const credentialSnapshot =
          await resolveStartupRecoveryCredentialSnapshot(retryDeps);
        const outcome = await runBootstrapWithPairFallback(retryDeps);
        if (outcome.kind === 'mounted') {
          recoveryHandle.dispose();
          retryDeps.reauthRecovery?.draftGuard?.release();
          removeBootSplashWrapper(retryDeps.document);
          return;
        }
        if (outcome.kind === 'pair-form') {
          // The durable generation genuinely disappeared while the recovery
          // card was open. The normal guarded pair flow now owns the slot;
          // retire only this card's delegated listener, not the new form.
          recoveryHandle.detach();
          return;
        }
        try {
          mountStartupFailureRecovery(
            deps,
            retryDeps,
            outcome.error,
            {
              savedAccessVerified: true,
              repeated: true,
              completedInAnotherTab,
              ...(credentialSnapshot.credentialVersion !== undefined
                ? {
                    credentialVersion:
                      credentialSnapshot.credentialVersion,
                  }
                : {}),
              stripPairInputs: true,
              diagnosticServerUrl:
                credentialSnapshot.diagnosticServerUrl,
            },
          );
          recoveryHandle.detach();
          return;
        } catch (triageError) {
          console.error(
            'webclient: repeated startup triage unavailable',
            triageError,
          );
          throw outcome.error;
        }
      },
    });
  } catch (err) {
    setSplashMessage(
      'Secure access is saved, but Recued could not open the startup retry. Reload this tab to continue; you do not need to pair again.',
      deps.document,
    );
    console.error('webclient: post-pair startup recovery unavailable', err);
  }
};

const installRecoveryDraftGuard = (
  deps: PairFallbackBootstrapDeps,
  snapshot: WebclientRecoverySnapshot,
): RecoveryDraftGuard | undefined => {
  if (
    snapshot.chatDraft === undefined
    || (snapshot.chatDraft.replyTo === undefined
      && (snapshot.chatDraft.attachments?.length ?? 0) === 0
      && (snapshot.chatDraft.protected !== true || snapshot.chatDraft.text.trim().length === 0))
  ) {
    return undefined;
  }
  const view = deps.document?.defaultView
    ?? (globalThis as unknown as Window);
  if (
    typeof view?.addEventListener !== 'function'
    || typeof view.removeEventListener !== 'function'
  ) {
    return undefined;
  }
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    event.preventDefault();
    event.returnValue = '';
  };
  let released = false;
  view.addEventListener('beforeunload', onBeforeUnload);
  return {
    release: () => {
      if (released) return;
      released = true;
      view.removeEventListener('beforeunload', onBeforeUnload);
    },
    isActive: () => !released,
  };
};

/** The persisted address is the canonical WebSocket endpoint used by the live
 * client (`wss://host/ws`), while the pair form POSTs to an HTTP origin. Keep
 * the trusted host/port but present the form's usable spelling so reconnecting
 * does not fail on an unsupported `fetch(wss://...)` request. */
export const pairFormServerUrlFromStored = (storedUrl: string): string => {
  try {
    const parsed = new URL(storedUrl);
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    else if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    else return storedUrl;
    if (parsed.pathname.endsWith('/ws')) {
      parsed.pathname = parsed.pathname.slice(0, -3) || '/';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    // Preserve the known value if an older install stored a non-standard form;
    // the editable field and its normal validation remain the recovery path.
    return storedUrl;
  }
};

/** What `runBootstrapWithPairFallback` did with the (re-)entry. The
 *  discriminator exists so the post-pair lifecycle in `onAfterPair`
 *  can decide whether the boot splash is now safe to tear down:
 *
 *    - `mounted`   — `bootstrapWebclient` resolved; the reception route
 *                    owns `#webclient-root`. The splash can be removed.
 *    - `pair-form` — `WebclientUnpairedError`; a fresh pair-code-input
 *                    host is mounted into the splash slot. The splash
 *                    MUST stay (it hosts the live form).
 *    - `failed`    — a non-unpaired error; the splash remains available
 *                    for cause-aware startup recovery. The raw error stays
 *                    internal so a retry can update that diagnosis. */
export type BootstrapFallbackOutcome =
  | { kind: 'mounted' }
  | { kind: 'pair-form' }
  | { kind: 'failed'; error: unknown };

/** Remember which long-lived bootstrap dependency objects have already handed
 * their transient pairing receipt to a mounted shell. A WeakSet keeps the
 * one-shot lifecycle local to this module without mutating caller-owned deps
 * (which may legitimately be frozen) or retaining disposed bootstrap graphs. */
const deliveredPostPairReceipts = new WeakSet<PairFallbackBootstrapDeps>();
/** Attempt-scoped controls for the recovery card. WeakSets avoid mutating a
 * caller-owned (possibly frozen) dependency graph and, unlike boolean fields,
 * cannot leak into a later reauthorization lifecycle. */
const preservedBootstrapFailureSurfaces =
  new WeakSet<PairFallbackBootstrapDeps>();
const suppressedPostPairConnectedReceipts =
  new WeakSet<PairFallbackBootstrapDeps>();
const consumedSilentCredentialConvergences =
  new WeakSet<PairFallbackBootstrapDeps>();
/** An explicit retry owns one outcome for its exact attempt: a mounted shell
 * earns its recovery confirmation, while a failed full-page reload earns
 * repeated triage. Consume it when the attempt starts so refresh, sibling
 * convergence, or later reauthorization cannot replay either outcome. */
interface StartupRecoveryAttempt {
  readonly receiptCopy: string;
  readonly origin: 'in_place' | 'reload';
}

const startupRecoveryAttempts =
  new WeakMap<PairFallbackBootstrapDeps, StartupRecoveryAttempt>();

const startupRecoveryReceiptFor = (
  deps: PairFallbackBootstrapDeps,
): string => (
  deps.reauthRecovery?.chatDraft !== undefined
    ? STARTUP_RECOVERY_DRAFT_RETURN_RECEIPT_COPY
    : STARTUP_RECOVERY_RETURN_RECEIPT_COPY
);

/** Queue one exact recovery attempt. In-place callers use the default origin;
 * the production entrypoint labels its session-marker handoff as `reload` so
 * a second failure can acknowledge that reload without claiming success. */
export const queueStartupRecoveryForNextAttempt = (
  deps: PairFallbackBootstrapDeps,
  origin: 'in_place' | 'reload' = 'in_place',
): void => {
  startupRecoveryAttempts.set(deps, {
    receiptCopy: startupRecoveryReceiptFor(deps),
    origin,
  });
};

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
  const preserveBootstrapFailureSurface =
    preservedBootstrapFailureSurfaces.delete(deps);
  const suppressPostPairConnectedReceipt =
    suppressedPostPairConnectedReceipts.delete(deps);
  const startupRecoveryAttempt = startupRecoveryAttempts.get(deps);
  startupRecoveryAttempts.delete(deps);
  const startupRecoveryReceiptCopy = startupRecoveryAttempt?.receiptCopy;
  const startupRecoveryReloadAttempted =
    startupRecoveryAttempt?.origin === 'reload';
  const coldStartPairCompletedSilently =
    deps.silentCredentialConvergence === true
    && !consumedSilentCredentialConvergences.has(deps);
  if (coldStartPairCompletedSilently) {
    consumedSilentCredentialConvergences.add(deps);
  }
  const pairCompletedSilently =
    coldStartPairCompletedSilently
    || deps.reauthRecovery?.pairCompletedInAnotherTab === true;
  if (deps.reauthRecovery !== undefined) {
    // Recovery exists before bootstrap can classify its next failure. Arm at
    // the attempt boundary so an app-startup error or document loss before an
    // unpaired form mounts cannot collapse back into first-run pairing.
    if (deps.reauthRecovery.safeStopReentry === true) {
      armSafeStopRecoveryReentry(deps.recoveryReentryStorage);
    } else if (deps.reauthRecovery.replacementServerReentry === true) {
      armReplacementServerRecoveryReentry(deps.recoveryReentryStorage);
    } else {
      armRecoveryReentry(deps.recoveryReentryStorage);
    }
  }
  let bootstrapPairVersion: StoredPairVersion | null = null;
  let bootstrapServerProfileId: string | null = null;
  let mountedCredentialConvergence = credentialTabConvergenceFor(deps);
  let unsubscribeMountedCredentialConvergence = (): void => undefined;
  let mountedCredentialConvergenceClosed = false;
  let credentialRecoveryPromise: Promise<BootstrapFallbackOutcome> | null = null;
  let credentialRecoveryInProgress = false;
  let mountedCredentialReadFailureReported = false;
  let mountedCredentialReconcileInFlight = false;
  let mountedCredentialReconcilePending = false;
  const closeMountedCredentialConvergence = (): void => {
    if (mountedCredentialConvergenceClosed) return;
    mountedCredentialConvergenceClosed = true;
    try {
      unsubscribeMountedCredentialConvergence();
    } catch {
      /* best-effort listener teardown */
    }
    try {
      mountedCredentialConvergence?.close();
    } catch {
      /* best-effort channel teardown */
    }
    mountedCredentialConvergence = null;
  };
  const notifyCredentialStateChanged = (): void => {
    try {
      mountedCredentialConvergence?.notifyCredentialStateChanged();
    } catch (err) {
      // The durable transition already happened; sibling focus/server auth is
      // the fallback and this tab's clear/recovery must remain successful.
      console.error('webclient: credential-state signal failed', err);
    }
  };
  const notifyActiveServerProfileChanged = (): void => {
    try {
      mountedCredentialConvergence?.notifyActiveServerProfileChanged();
    } catch (err) {
      // The durable pointer remains authoritative; focus reconciliation is the
      // fallback when the immediate, detail-free sibling hint cannot post.
      console.error('webclient: active server profile signal failed', err);
    }
  };

  try {
    // Snapshot the optional receipt for this one bootstrap attempt. Once a
    // shell resolves it has owned the first-connected frame, so remember that
    // delivery before any future re-entry without mutating caller-owned deps.
    const postPairReceiptCopy = deliveredPostPairReceipts.has(deps)
      ? undefined
      : deps.postPairReceiptCopy;
    const initialConnectedReceiptCopy = startupRecoveryReceiptCopy
      ?? (pairCompletedSilently ? undefined : postPairReceiptCopy);
    // `bootstrapWebclient` can surface `reauth_required` synchronously while
    // its initial WS handshake is still resolving. At that point the new
    // handle has not returned yet, so recovering immediately would capture a
    // null handle, then install the rejected handle after the wipe. Defer the
    // recovery until the bootstrap promise settles and the handle is owned by
    // `handleRef`; the normal post-mount signal still recovers immediately.
    let bootstrapSettled = false;
    let reauthRequestedDuringBootstrap = false;
    const recoverWithSurfacing = (
      cause: CredentialRecoveryCause = 'session_rejected',
    ): Promise<BootstrapFallbackOutcome> => {
      if (credentialRecoveryPromise !== null) {
        return credentialRecoveryPromise;
      }
      // Set before constructing the async transaction: `active.dispose()` can
      // invoke `onSessionDispose` synchronously before the promise assignment
      // below completes. The observer must survive until the durable wipe has
      // been signalled to siblings.
      credentialRecoveryInProgress = true;
      credentialRecoveryPromise = (async () => {
        try {
          return await recoverFromReauthRequired(
            deps,
            bootstrapPairVersion,
            {
              cause,
              ...(cause === 'session_rejected'
                ? { onCredentialsRemoved: notifyCredentialStateChanged }
                : {}),
            },
          );
        } catch (recoverErr) {
          setSplashMessage(
            cause === 'session_rejected'
              ? 'Your server is not the one this browser knew, and Recued could not start pairing again. Reload the page to pair this browser.'
              : 'Another tab changed the saved sign-in, and Recued could not start pairing again. Reload the page to pair this browser.',
            deps.document,
          );
          console.error('webclient: credential recovery failed', recoverErr);
          return { kind: 'failed', error: recoverErr };
        } finally {
          closeMountedCredentialConvergence();
          credentialRecoveryInProgress = false;
        }
      })();
      return credentialRecoveryPromise;
    };

    const reconcileMountedCredentials = async (): Promise<void> => {
      if (
        mountedCredentialConvergenceClosed
        || credentialRecoveryPromise !== null
      ) {
        return;
      }
      if (mountedCredentialReconcileInFlight) {
        // Coalesce a hint that arrives while the initial/read-after-focus
        // reconciliation is awaiting IndexedDB. Dropping it can leave a tab
        // mounted on the generation that existed at the start of that read.
        mountedCredentialReconcilePending = true;
        return;
      }
      mountedCredentialReconcileInFlight = true;
      try {
        const reconcileActiveProfile = async (): Promise<
          'same' | 'different' | 'unavailable'
        > => {
          if (
            deps.profileStore === undefined
            || bootstrapServerProfileId === null
          ) return 'unavailable';
          const activeProfileId = await deps.profileStore.activeProfileId();
          if (
            mountedCredentialConvergenceClosed
            || credentialRecoveryPromise !== null
          ) {
            return 'unavailable';
          }
          // A profile switch changes the five-field projection by design; it
          // is not a credential replacement within the server this shell
          // booted against. Let the shell scrub source-owned route identity
          // and protect unsaved work instead of feeding the old-server draft
          // into guided re-pair recovery for the newly active server.
          if (activeProfileId !== null) {
            deps.handleRef.current?.requestServerProfileConvergence(
              activeProfileId,
            );
            return activeProfileId === bootstrapServerProfileId
              ? 'same'
              : 'different';
          }
          return 'unavailable';
        };
        if (await reconcileActiveProfile() === 'different') return;
        let state = await readStoredPairState(deps.localStore);
        // Privacy clear/manual disposal can retire the observer while an IDB
        // read is in flight. Its result no longer owns this shell and must not
        // replace the intentional clear receipt with a surprise pair form.
        if (
          mountedCredentialConvergenceClosed
          || credentialRecoveryPromise !== null
        ) {
          return;
        }
        // The active pointer can change while the five projected fields are
        // being read. Re-check before interpreting those fields; otherwise a
        // source->target race can still masquerade as same-profile credential
        // replacement and rescue source work into the target recovery path.
        if (await reconcileActiveProfile() === 'different') return;
        if (
          state.kind === 'complete'
          && bootstrapPairVersion !== null
          && !sameStoredCredentialGeneration(
            bootstrapPairVersion,
            state.pair.version,
          )
          && deps.profileStore !== undefined
          && bootstrapServerProfileId !== null
        ) {
          // A switch away and back can bracket the projected read while both
          // pointer samples say "source". Confirm once more against the now-
          // stable pointer before starting any destructive credential repair.
          state = await readStoredPairState(deps.localStore);
          if (await reconcileActiveProfile() === 'different') return;
        }
        if (state.kind !== 'complete') {
          await recoverWithSurfacing('credentials_changed_elsewhere');
          return;
        }
        if (bootstrapPairVersion === null) {
          // The pre-bootstrap version read is best-effort. A successful shell
          // plus a complete first reconciliation establishes the safe baseline.
          bootstrapPairVersion = state.pair.version;
          return;
        }
        if (
          !sameStoredCredentialGeneration(
            bootstrapPairVersion,
            state.pair.version,
          )
        ) {
          await recoverWithSurfacing('credentials_replaced_elsewhere');
        }
      } catch (err) {
        // Storage denial/transience must not tear down a usable mounted shell;
        // the next state hint or focus retries once, without log spam.
        if (!mountedCredentialReadFailureReported) {
          mountedCredentialReadFailureReported = true;
          console.error('webclient: mounted credential-state check failed', err);
        }
      } finally {
        mountedCredentialReconcileInFlight = false;
        if (
          mountedCredentialReconcilePending
          && !mountedCredentialConvergenceClosed
          && credentialRecoveryPromise === null
        ) {
          mountedCredentialReconcilePending = false;
          void reconcileMountedCredentials();
        }
      }
    };

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
    // Capture the exact encrypted credential generation this handle boots
    // with. A delayed reauth callback in another tab can run after a sibling
    // has already paired a fresh generation; recovery compares this version
    // under the same Web Lock as pairing before removing anything.
    try {
      bootstrapPairVersion = (
        await readCompleteStoredPair(deps.localStore)
      )?.version ?? null;
    } catch {
      /* best-effort — recovery falls back to the unconditional wipe */
    }
    const runWebclientBootstrap = deps.bootstrap ?? bootstrapWebclient;
    const handle = await runWebclientBootstrap({
      root: deps.root,
      localStore: deps.localStore,
      ...(deps.profileStore !== undefined
        ? { profileStore: deps.profileStore }
        : {}),
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
      // The clearing tab keeps its explicit result receipt. Notify siblings,
      // then retire this tab's observer so focus cannot turn the intentional
      // clear into an automatic recovery form underneath that receipt.
      onPrivacyCredentialsCleared: () => {
        notifyCredentialStateChanged();
        closeMountedCredentialConvergence();
      },
      // Account fires this after a durable profile rename, recency stamp, or
      // removal. The signal contains no server/profile detail; siblings re-read
      // the same-origin store. Credential generations are compared separately,
      // so a cosmetic rename refreshes Account without remounting the shell.
      onServerProfilesChanged: notifyCredentialStateChanged,
      onActiveServerProfileChanged: notifyActiveServerProfileChanged,
      onTokenRotated: (record) => {
        if (bootstrapPairVersion !== null) {
          bootstrapPairVersion = {
            ...bootstrapPairVersion,
            tokenId: record.token_id,
            ciphertext: record.ciphertext_b64,
            iv: record.iv_b64,
            issuedAt: record.issued_at,
          };
        }
        // Siblings that missed the server event re-read the durable envelope;
        // this tab advanced its baseline first, so it cannot self-remount.
        notifyCredentialStateChanged();
      },
      onSessionDispose: () => {
        // Recovery keeps the channel just long enough to signal AFTER its
        // durable wipe. Ordinary/manual disposal closes immediately.
        if (!credentialRecoveryInProgress) {
          closeMountedCredentialConvergence();
        }
      },
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
      enableReachabilityProbe: true,
      // D-156 follow-on — the Settings → Devices roster + revoke surface.
      // The bootstrap default is OFF (it predates the self-host owner-id
      // fix that let the bearer-only webclient enumerate itself via
      // `pair.list`); now that `/auth/pair` seeds `SELF_HOST_OWNER_ID` and
      // the gate resolves a verified bearer to it, the page is live, so
      // production turns it on here. Direct bootstrap tests keep the
      // opt-in default. `currentInstanceId` (above) pins "This device".
      enableDevicesPage: true,
      ...(deps.reauthRecovery !== undefined
        ? { reauthRecovery: deps.reauthRecovery }
        : {}),
      ...(startupRecoveryReceiptCopy === undefined
        && (
          pairCompletedSilently
          || suppressPostPairConnectedReceipt
        )
        ? { suppressInitialConnectedReceipt: true }
        : {}),
      ...(initialConnectedReceiptCopy !== undefined
        ? { initialConnectedReceiptCopy }
        : {}),
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
        if (!bootstrapSettled) {
          reauthRequestedDuringBootstrap = true;
          return;
        }
        // Surface a recovery failure instead of leaking an unhandled
        // rejection (finding #2b). `ensureBootSplashSlot` makes the
        // re-entry's pair-form mount robust, but a non-browser env (no
        // resolvable document) or an unexpected store error during the
        // field wipe could still reject — render it rather than strand
        // the user on a silent dead session.
        void recoverWithSurfacing('session_rejected');
      },
    });
    deps.handleRef.current = handle;
    bootstrapServerProfileId = handle.serverProfileId();
    bootstrapSettled = true;
    if (postPairReceiptCopy !== undefined) {
      deliveredPostPairReceipts.add(deps);
    }
    if (reauthRequestedDuringBootstrap) {
      return recoverWithSurfacing('session_rejected');
    }
    if (deps.reauthRecovery !== undefined) {
      // A mounted, accepted shell is the only durable end condition for this
      // tab's unresolved-recovery marker. Retire before any later reload can
      // replay reconnect framing or imply another success.
      retireRecoveryReentry(deps.recoveryReentryStorage);
    }
    if (mountedCredentialConvergence !== null) {
      try {
        unsubscribeMountedCredentialConvergence =
          mountedCredentialConvergence.subscribe((hint) => {
            if (hint === 'active_server_profile_changed') {
              // Enter the blocking boundary before the first IndexedDB read.
              // The hint intentionally carries no target/server detail; the
              // shell resolves and verifies the durable pointer itself.
              handle.requestServerProfileConvergence();
            }
            // A sibling may have changed only an INACTIVE profile. That does
            // not alter the active credential generation below, but Account
            // must still drop/rename the stale roster row without a reload.
            handle.refreshServerProfiles?.();
            void reconcileMountedCredentials();
          });
        // Close the bootstrap-to-subscribe race without adding a permanent
        // poll to the long-lived shell.
        void reconcileMountedCredentials();
      } catch (err) {
        console.error('webclient: mounted credential listener unavailable', err);
        closeMountedCredentialConvergence();
      }
    }
    // Close the persistence-before-cleanup crash gap. A refresh can arrive
    // with a complete stored pair while the prior runtime died before its
    // `onAfterPair` cleanup; once this shell mounts successfully, the code and
    // resume marker are definitively stale and can be scrubbed without reload.
    if (
      postPairReceiptCopy === undefined
      && deps.reauthRecovery === undefined
    ) {
      cleanPairEntryFromAddressBar(deps);
    }
    // An explicit startup recovery is a user-initiated context transition.
    // Return keyboard/screen-reader context to the exact mounted route, while
    // preserving any interactive control (such as a restored Chat draft) that
    // the route intentionally focused during bootstrap.
    if (
      startupRecoveryReceiptCopy !== undefined
      || pairCompletedSilently
    ) {
      focusMountedReturnRoute(deps);
    }
    // Successful bootstrap replaces the splash via `mountReceptionRoute`
    // (which appends to `#webclient-root`); the caller drops the splash
    // wrapper on the `mounted` outcome.
    return { kind: 'mounted' };
  } catch (err) {
    if (err instanceof WebclientUnpairedError) {
      // The long-lived observer was created before bootstrap so Privacy clear
      // and synchronous auth failures could signal. An unpaired boot instead
      // owns the short-lived polling form observer below.
      closeMountedCredentialConvergence();
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
      const pairLockProvider = pairLockProviderFor(deps);
      // D-151 follow-on — pin a paired instance id for this device so the
      // bearer the server issues carries `metadata.instance_id` (forwarded
      // as `instanceId` below) + `finalizePairCodeSuccess` persists it.
      // A live 4003 reauth can mean this exact instance was revoked, so that
      // path omits `reauthRecovery.instanceId` and mints a fresh identity.
      // Local-only corruption/interruption has not established revocation and
      // explicitly rescues the prior id so repair does not duplicate the
      // browser in the device roster.
      const rescuedInstanceId = deps.reauthRecovery?.instanceId;
      const instanceId =
        typeof rescuedInstanceId === 'string' && rescuedInstanceId.length > 0
          ? rescuedInstanceId
          : await resolveOrGenerateInstanceId(deps.localStore);
      // D-156 follow-on — derive a human-readable device label (e.g.
      // "Chrome on macOS") from the UA so the Devices roster row reads
      // legibly instead of the server's "unknown device" fallback. Sent
      // to `/auth/pair` as `displayName` (seeds the `paired_instances`
      // row + the issued token's `client_label`).
      const displayName = resolveDeviceDisplayName();
      // A current cold-start repair may also carry safe pair-entry context.
      // When a previously trusted server address exists, combine only the CLI
      // code with it; never let even a same-origin arrival replace stored
      // recovery authority. Live reauth drops the seed before re-entry below
      // because its old code is stale.
      const privateRecoveryReentry =
        deps.reauthRecovery?.safeStopReentry === true
        || deps.reauthRecovery?.replacementServerReentry === true;
      const seed = privateRecoveryReentry
        ? undefined
        : deps.reauthRecovery?.serverUrl !== undefined
          ? {
              serverUrl: pairFormServerUrlFromStored(
                deps.reauthRecovery.serverUrl,
              ),
              ...(deps.deeplinkSeed?.pairingCode !== undefined
                ? { pairingCode: deps.deeplinkSeed.pairingCode }
                : {}),
            }
          : deps.deeplinkSeed;
      let recoveryCheckpoint:
        | 'unresolved'
        | 'safe_stop'
        | 'replacement_server' =
          deps.reauthRecovery?.safeStopReentry === true
            ? 'safe_stop'
            : deps.reauthRecovery?.replacementServerReentry === true
              ? 'replacement_server'
              : 'unresolved';
      let replacementServerVerified = false;
      const buildCurrentPostPairReentry = (): PairFallbackBootstrapDeps => {
        const reentry = buildPostPairReentry(deps);
        if (reentry.reauthRecovery !== undefined) {
          const {
            safeStopReentry: _retiredSafeStop,
            replacementServerReentry: _retiredReplacementServer,
            ...continuedRecovery
          } = reentry.reauthRecovery;
          reentry.reauthRecovery = {
            ...continuedRecovery,
            ...(recoveryCheckpoint === 'safe_stop'
              ? { safeStopReentry: true as const }
              : {}),
            ...(recoveryCheckpoint === 'replacement_server'
              ? { replacementServerReentry: true as const }
              : {}),
          };
        }
        return reentry;
      };
      const pairTabConvergence = pairTabConvergenceFor(deps);
      let unsubscribePairTabConvergence = (): void => undefined;
      let pairTabConvergenceClosed = false;
      let siblingAdoptionInFlight = false;
      let siblingAdoptionPending = false;
      let siblingPairReadFailureReported = false;
      let pairCompletedInAnotherTab = false;
      let codeHandle: ReturnType<typeof mountPairCodeInputHost>;
      const closePairTabConvergence = (): void => {
        if (pairTabConvergenceClosed) return;
        pairTabConvergenceClosed = true;
        try {
          unsubscribePairTabConvergence();
        } catch {
          /* best-effort listener teardown */
        }
        try {
          pairTabConvergence?.close();
        } catch {
          /* best-effort channel teardown */
        }
      };
      const notifySiblingTabs = (): void => {
        try {
          pairTabConvergence?.notifyPairComplete();
        } catch (err) {
          // The five-field pair is already durable. A signal failure must not
          // turn that success into an inline pairing error.
          console.error('webclient: pair-tab completion signal failed', err);
        }
      };
      const notifyPairTransitionStarted = (): void => {
        try {
          // Signal immediately after server acceptance, before passport fetch
          // or the first local write. If this tab closes mid-finalize, sibling
          // forms have already retired the possibly-consumed one-time code.
          pairTabConvergence?.notifyPairTransitionStarted();
        } catch (err) {
          console.error(
            'webclient: pair-transition signal failed',
            err,
          );
        }
      };
      const notifyPairTakeoverStarted = (): void => {
        try {
          // The lock owner is now unambiguous, but no credential or pairing
          // result exists yet. Let failed/passive siblings yield before this
          // successor's request so they do not advertise a competing retry.
          pairTabConvergence?.notifyPairTakeoverStarted();
        } catch (err) {
          console.error(
            'webclient: pair-takeover signal failed',
            err,
          );
        }
      };
      const notifyPairTakeoverNeedsAttention = (): void => {
        try {
          // Only the ownership fact crosses tabs. The local error, pairing
          // code, recovery key, and any held response stay in the failed tab.
          pairTabConvergence?.notifyPairTakeoverNeedsAttention();
        } catch (err) {
          console.error(
            'webclient: pair-takeover recovery-owner signal failed',
            err,
          );
        }
      };
      const notifyPairRecoverySuccessorChosen = (): void => {
        try {
          // The Web Lock is the authority; this credential-free announcement
          // lets passive siblings explain where recovery moved and renew the
          // chosen successor's bounded heartbeat lease.
          pairTabConvergence?.notifyPairRecoverySuccessorChosen();
        } catch (err) {
          console.error(
            'webclient: pair recovery-successor signal failed',
            err,
          );
        }
      };
      const adoptSiblingPair = async (): Promise<void> => {
        if (pairTabConvergenceClosed) return;
        if (siblingAdoptionInFlight) {
          siblingAdoptionPending = true;
          return;
        }
        siblingAdoptionInFlight = true;
        const finishCheck = (): void => {
          siblingAdoptionInFlight = false;
          if (siblingAdoptionPending && !pairTabConvergenceClosed) {
            siblingAdoptionPending = false;
            void adoptSiblingPair();
          }
        };
        let completePairAvailable = false;
        try {
          // Poll/focus can fire while the source tab is between durable
          // writes. Read under the same lock as `/auth/pair` finalization so
          // this form sees the state before or after that transition, never a
          // transient mix that could retire the form too early.
          const pairState = await withPairFinalizeLock(
            pairLockProvider,
            () => readStoredPairState(deps.localStore),
          );
          completePairAvailable = pairState.kind === 'complete';
          if (pairState.kind === 'partial') {
            // Keep the form and every tab-local route/draft intact, but make
            // the takeover explicit instead of looking like an unrelated
            // fresh pair. The source tab may still finish its in-memory save;
            // this sibling will adopt that complete generation on the next
            // signal/poll.
            cleanPairEntryFromAddressBar(deps);
            codeHandle.showInterruptedCredentialTransition();
          }
        } catch (err) {
          // A transient IndexedDB read should leave the existing form usable;
          // the next broadcast, focus, or poll retries reconciliation.
          if (!siblingPairReadFailureReported) {
            siblingPairReadFailureReported = true;
            console.error('webclient: sibling pair-state check failed', err);
          }
        }
        if (!completePairAvailable || pairTabConvergenceClosed) {
          finishCheck();
          return;
        }

        closePairTabConvergence();
        let clearPairHandoffStatus = (): void => undefined;
        try {
          // The verified durable pair is now authoritative. Retire this stale
          // form before re-entry so an already-queued submit observes disposed
          // state and cannot consume a second one-time code.
          codeHandle.dispose();
          cleanPairEntryFromAddressBar(deps);
          clearPairHandoffStatus = showPairHandoffStatus(
            pairHandoffCopy({
              completedInAnotherTab: true,
              reconnecting: deps.reauthRecovery !== undefined,
              draftPreserved:
                deps.reauthRecovery?.chatDraft !== undefined,
            }),
            deps.document,
          );
          if (deps.reauthRecovery !== undefined) {
            restoreHash(deps.reauthRecovery.returnHash, deps);
          }
          const reentry = buildCurrentPostPairReentry();
          if (reentry.reauthRecovery !== undefined) {
            reentry.reauthRecovery = {
              ...reentry.reauthRecovery,
              pairCompletedInAnotherTab: true,
            };
          }
          // Only the tab that performed pairing owns the success receipt. This
          // sibling resumes silently at its own exact route.
          delete reentry.postPairReceiptCopy;
          preservedBootstrapFailureSurfaces.add(reentry);
          const outcome = await runBootstrapWithPairFallback(reentry);
          clearPairHandoffStatus();
          clearPairHandoffStatus = (): void => undefined;
          if (outcome.kind === 'mounted') {
            deps.reauthRecovery?.draftGuard?.release();
            removeBootSplashWrapper(deps.document);
            if (deps.reauthRecovery === undefined) {
              focusMountedReturnRoute(deps);
            }
          } else if (outcome.kind === 'failed') {
            mountDurableCredentialStartupRecovery(deps, reentry, true);
          }
        } catch (err) {
          setSplashMessage(
            deps.reauthRecovery !== undefined
              ? 'Another tab reconnected, but Recued could not open this page. Reload the page to carry on.'
              : 'Another tab finished pairing this browser, but Recued could not open this page. Reload the page to carry on.',
            deps.document,
          );
          console.error('webclient: sibling pair adoption failed', err);
        } finally {
          clearPairHandoffStatus();
          finishCheck();
        }
      };

      // The way out of an abandoned add-a-server attempt. Appended BESIDE the
      // pair form rather than inside it, so the pairing component is
      // untouched; it renders only when the roster holds a server other than
      // the attempt in progress. Without this the menu's "Add another
      // server…" would be a trap — see `shell/return-to-server.ts`.
      if (splashSlot !== null && deps.profileStore !== undefined) {
        const profileStore = deps.profileStore;
        void (async () => {
          try {
            const roster = await profileStore.listProfiles();
            // Styles inject once, marker-guarded — the splash has no style
            // pipeline of its own, and a re-mount must not stack them.
            const head = deps.document?.head;
            if (
              head !== undefined
              && head.querySelector(`style[${RETURN_TO_SERVER_ATTR}]`) === null
            ) {
              const style = deps.document!.createElement('style');
              style.setAttribute(RETURN_TO_SERVER_ATTR, '');
              style.textContent = RETURN_TO_SERVER_STYLES;
              head.appendChild(style);
            }
            mountReturnToServer({
              host: splashSlot,
              ...(deps.document !== undefined ? { document: deps.document } : {}),
              profiles: roster,
              onReturn: (id: string) => {
                void (async () => {
                  try {
                    // Switching away also drops the pending attempt, so an
                    // abandoned add leaves no ghost behind in the roster.
                    await profileStore.switchProfile(id);
                  } catch (err) {
                    console.error('webclient: return to server failed', err);
                    return;
                  }
                  const loc = (globalThis as { location?: { reload?: () => void } })
                    .location;
                  loc?.reload?.();
                })();
              },
            });
          } catch (err) {
            // A roster read failure must not take down the pair form — the
            // owner can still pair; they just do not get the shortcut back.
            console.error('webclient: return-to-server unavailable', err);
          }
        })();
      }

      const mountPairForm = () => mountPairCodeInputHost({
        ...(seed !== undefined ? { seed } : {}),
        ...(deps.reauthRecovery !== undefined
          ? {
              reauthRecovery: {
                chatDraftPreserved:
                  deps.reauthRecovery.chatDraft !== undefined,
                ...(deps.reauthRecovery.reason !== undefined
                  ? { reason: deps.reauthRecovery.reason }
                  : {}),
                ...(deps.reauthRecovery.recoveryReentry === true
                  ? { recoveryReentry: true as const }
                  : {}),
                ...(deps.reauthRecovery.safeStopReentry === true
                  ? { safeStopReentry: true as const }
                  : {}),
                ...(deps.reauthRecovery.replacementServerReentry === true
                  ? { replacementServerReentry: true as const }
                  : {}),
              },
            }
          : {}),
        ...(splashSlot !== null ? { splashElement: splashSlot } : {}),
        ...(deps.document !== undefined ? { document: deps.document } : {}),
        ...(deps.siblingTakeoverDelayMs !== undefined
          ? { siblingTakeoverDelayMs: deps.siblingTakeoverDelayMs }
          : {}),
        ...(deps.siblingRecoveryOwnerDelayMs !== undefined
          ? { siblingRecoveryOwnerDelayMs: deps.siblingRecoveryOwnerDelayMs }
          : {}),
        ...(deps.recoveryOwnerHeartbeatMs !== undefined
          ? { recoveryOwnerHeartbeatMs: deps.recoveryOwnerHeartbeatMs }
          : {}),
        instanceId,
        displayName,
        lockProvider: pairLockProvider,
        siblingTakeoverSignalsAvailable:
          pairTabConvergence?.supportsImmediateSignals === true
          && pairTabConvergence.supportsRecoverySuccessorElection,
        preflightCheck: async () => {
          // Use the same full five-field classifier as cold start. A complete
          // strict triple short-circuits as before; a partial result aborts a
          // racing sibling submit once so the host can clear a potentially
          // consumed code before any second `/auth/pair` POST.
          const pairState = await readStoredPairState(deps.localStore);
          pairCompletedInAnotherTab = pairState.kind === 'complete';
          return {
            alreadyPaired: pairCompletedInAnotherTab,
            ...(pairState.kind === 'partial'
              ? { interrupted: true }
              : {}),
          };
        },
        onPairAccepted: () => {
          // The one-time code has now been consumed. A document loss from this
          // point must enter generic interrupted recovery, never replay the
          // fresh-server review or imply that another new key should be made.
          recoveryCheckpoint = 'unresolved';
          armRecoveryReentry(deps.recoveryReentryStorage);
          cleanPairEntryFromAddressBar(deps);
          notifyPairTransitionStarted();
        },
        onRecoveryCheckpointChange: (checkpoint) => {
          recoveryCheckpoint = checkpoint;
          if (checkpoint === 'safe_stop') {
            armSafeStopRecoveryReentry(deps.recoveryReentryStorage);
          } else if (checkpoint === 'replacement_server') {
            armReplacementServerRecoveryReentry(
              deps.recoveryReentryStorage,
            );
          } else {
            armRecoveryReentry(deps.recoveryReentryStorage);
          }
        },
        onTakeoverStarted: () => {
          cleanPairEntryFromAddressBar(deps);
          notifyPairTakeoverStarted();
        },
        onTakeoverNeedsAttention: () => {
          cleanPairEntryFromAddressBar(deps);
          notifyPairTakeoverNeedsAttention();
        },
        ...(pairTabConvergence?.supportsRecoverySuccessorElection === true
          ? {
              claimRecoverySuccessor: () =>
                pairTabConvergence.claimPairRecoverySuccessor(),
              onRecoverySuccessorChosen: () => {
                cleanPairEntryFromAddressBar(deps);
                notifyPairRecoverySuccessorChosen();
              },
            }
          : {}),
        onPaired: async (paired) => {
          const result = await finalizePairCodeSuccess({
            serverUrl: paired.serverUrl,
            bearer: paired.token,
            ...(paired.token_id !== undefined ? { token_id: paired.token_id } : {}),
            ...(paired.passport !== undefined ? { passport: paired.passport } : {}),
            instanceId,
            localStore: deps.localStore,
            ...(deps.profileStore !== undefined
              ? { profileStore: deps.profileStore }
              : {}),
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
            // surface by re-throwing. The host retains `paired` in memory and
            // turns the next primary action into a local-only finalize retry;
            // no second `/auth/pair` request is sent. Throwing prevents
            // onAfterPair until the strict local triple is durable.
            throw new Error(PAIR_CODE_SUCCESS_ERROR_COPY[result.error]);
          }
          replacementServerVerified =
            paired.recoveryContext === 'fresh_replacement';
        },
        onAfterPair: async () => {
          // The host reaches this callback after this tab's `onPaired`
          // persistence resolves, or after guided-repair preflight observes a
          // complete pair written by a sibling. Either way the strict triple
          // is durable and the one-time code is no longer useful; the flag
          // below keeps receipt ownership with the tab that actually wrote it.
          notifySiblingTabs();
          closePairTabConvergence();
          cleanPairEntryFromAddressBar(deps);
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
          const clearPairHandoffStatus = showPairHandoffStatus(
            pairHandoffCopy({
              completedInAnotherTab: pairCompletedInAnotherTab,
              reconnecting: deps.reauthRecovery !== undefined,
              draftPreserved:
                deps.reauthRecovery?.chatDraft !== undefined,
              replacementServer: replacementServerVerified,
            }),
            deps.document,
          );
          if (deps.reauthRecovery !== undefined) {
            restoreHash(deps.reauthRecovery.returnHash, deps);
          }
          const reentry = buildCurrentPostPairReentry();
          if (reentry.reauthRecovery !== undefined) {
            reentry.reauthRecovery = {
              ...reentry.reauthRecovery,
              pairCompletedInAnotherTab,
            };
          }
          if (replacementServerVerified) {
            reentry.postPairReceiptCopy =
              REPLACEMENT_SERVER_RETURN_RECEIPT_COPY;
          } else if (deps.reauthRecovery === undefined) {
            reentry.postPairReceiptCopy = PAIR_SUCCESS_RETURN_RECEIPT_COPY;
          } else {
            // Guided reauthorization owns more specific draft/return copy in
            // `bootstrapWebclient`; do not let a stale generic receipt win.
            delete reentry.postPairReceiptCopy;
          }
          preservedBootstrapFailureSurfaces.add(reentry);
          let outcome: BootstrapFallbackOutcome;
          try {
            outcome = await runBootstrapWithPairFallback(reentry);
          } finally {
            // A failed retry may reuse the splash for an interactive recovery
            // card. Do not leave that form nested inside a status role.
            clearPairHandoffStatus();
          }
          // Only drop the splash wrapper once the reception route
          // actually mounted. On a re-entry pair-form (clock-skew race)
          // or a boot failure, the splash still hosts the live surface
          // (the fresh form / saved-access startup recovery) — removing it
          // would strand the user on a blank screen (the bug this fix closes).
          if (outcome.kind === 'mounted') {
            // The replacement shell now owns the route-level beforeunload
            // guard. Retire the temporary guard that protected the rescued
            // draft while the pair form had no mounted Chat route.
            deps.reauthRecovery?.draftGuard?.release();
            removeBootSplashWrapper(deps.document);
            if (
              pairCompletedInAnotherTab === false
              && deps.reauthRecovery?.chatDraft === undefined
            ) {
              // A restored draft intentionally focuses its composer, and a
              // sibling-owned pair already focused its silent return inside
              // `runBootstrapWithPairFallback`. The remaining guided re-pair
              // case has just removed the form, so move focus into the exact
              // mounted route instead of leaving it on detached DOM.
              focusMountedReturnRoute(deps);
            }
          } else if (outcome.kind === 'failed') {
            mountDurableCredentialStartupRecovery(
              deps,
              reentry,
              pairCompletedInAnotherTab,
            );
          }
        },
        // M5 S3.4 — the user chose the pair form's `Restore a backup` tab and
        // submitted. Tear down THIS pair form (its listeners on the shared
        // splash slot) so the restore splash surface owns the element cleanly,
        // then hand off to the flow controller, which builds the orchestrator +
        // mounts the progress/preview UI + drives the multi-step restore.
        onRestoreSubmit: async (firstInputs: PairCodeInputRestoreInputs) => {
          closePairTabConvergence();
          codeHandle.dispose();
          if (splashSlot === null) {
            // No surface to render the restore progress into (non-browser env)
            // — surface the failure rather than silently dropping the submit.
            setSplashMessage(
              'Recued could not start putting your backup back. There was nowhere to show it. Reload the page and try again.',
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
                  ...(deps.profileStore !== undefined
                    ? { profileStore: deps.profileStore }
                    : {}),
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
      try {
        codeHandle = mountPairForm();
      } catch (err) {
        closePairTabConvergence();
        throw err;
      }
      if (pairTabConvergence !== null) {
        try {
          unsubscribePairTabConvergence = pairTabConvergence.subscribe((hint) => {
            if (hint === 'pair_transition_started') {
              cleanPairEntryFromAddressBar(deps);
              codeHandle.showSiblingPairAccepted();
            } else if (hint === 'pair_takeover_started') {
              cleanPairEntryFromAddressBar(deps);
              codeHandle.showSiblingTakeoverStarted();
            } else if (hint === 'pair_takeover_needs_attention') {
              cleanPairEntryFromAddressBar(deps);
              codeHandle.showSiblingTakeoverNeedsAttention();
            } else if (hint === 'pair_recovery_successor_chosen') {
              cleanPairEntryFromAddressBar(deps);
              codeHandle.showSiblingRecoverySuccessorChosen();
            }
            void adoptSiblingPair();
          });
          // Close the subscribe-after-bootstrap race: another tab may have
          // finished between this tab's unpaired read and listener attachment.
          void adoptSiblingPair();
        } catch (err) {
          console.error('webclient: pair-tab listener unavailable', err);
          codeHandle.disableSiblingTakeoverCoordination();
          closePairTabConvergence();
        }
      }
      return { kind: 'pair-form' };
    }
    closeMountedCredentialConvergence();
    console.error('webclient: bootstrap failed', err);
    if (!preserveBootstrapFailureSurface) {
      try {
        const savedAccessVerified = bootstrapPairVersion !== null;
        if (savedAccessVerified) {
          // A complete durable generation proves any pair entry is consumed.
          // Scrub it before exposing Reload so recovery cannot replay a code or
          // resurface the secure-arrival marker in browser history.
          cleanPairEntryFromAddressBar(deps);
        }
        if (pairCompletedSilently) {
          // The durable pair was already verified before this attempt. Keep
          // the failure on the narrow startup-only surface: the sibling owns
          // pairing success, and this tab needs only to reopen its exact work.
          mountDurableCredentialStartupRecovery(deps, deps, true);
        } else {
          mountStartupFailureRecovery(
            deps,
            deps,
            err,
            {
              savedAccessVerified,
              repeated: startupRecoveryReloadAttempted,
              reloadAttempted: startupRecoveryReloadAttempted,
              ...(bootstrapPairVersion !== null
                ? { credentialVersion: bootstrapPairVersion }
                : {}),
              stripPairInputs: savedAccessVerified,
              diagnosticServerUrl: bootstrapPairVersion?.serverUrl ?? null,
            },
          );
        }
      } catch (triageError) {
        setSplashMessage(
          'Recued could not open startup recovery. Reload this tab to try again; no saved access was cleared.',
          deps.document,
        );
        console.error('webclient: startup triage unavailable', triageError);
      }
    }
    return { kind: 'failed', error: err };
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
  rejectedPairVersion: StoredPairVersion | null,
  options: CredentialRecoveryOptions = { cause: 'session_rejected' },
): Promise<BootstrapFallbackOutcome> => {
  // Bridge the entire teardown/wipe/re-entry transaction, including failures
  // that happen before the replacement bootstrap can arm itself.
  armRecoveryReentry(deps.recoveryReentryStorage);
  const active = deps.handleRef.current;
  const capture = active?.captureRecoverySnapshot;
  let snapshot: WebclientRecoverySnapshot = {
    returnHash: currentHash(deps),
  };
  if (typeof capture === 'function') {
    try {
      snapshot = capture.call(active);
    } catch (err) {
      // A route-level snapshot failure must never block removal of the
      // rejected bearer. The current hash still gives the user a useful
      // destination after re-pair; only the optional draft rescue degrades.
      console.error('webclient: reauth work-context capture failed', err);
    }
  }
  // Disposing the active shell removes its route-level beforeunload listener.
  // Bridge that gap before teardown so an accidental reload on the recovery
  // form cannot silently discard a protected Chat draft.
  const existingDraftGuard = deps.reauthRecovery?.draftGuard;
  const draftGuard = existingDraftGuard?.isActive() === true
    ? existingDraftGuard
    : installRecoveryDraftGuard(deps, snapshot);
  let serverUrl: string | null = rejectedPairVersion?.serverUrl ?? null;
  if (serverUrl === null) {
    try {
      serverUrl = await deps.localStore.get('server_url');
    } catch (err) {
      // Context rescue is best-effort. A storage read failure must not retain a
      // rejected bearer or block the required credential wipe.
      console.error('webclient: reauth return-context read failed', err);
    }
  }
  deps.handleRef.current = null;
  if (active) {
    try {
      await active.dispose();
    } catch (err) {
      console.error('webclient: bootstrap dispose during reauth recovery failed', err);
    }
  }
  let newerPairAvailable = false;
  let credentialStateChanged = false;
  await withPairFinalizeLock(pairLockProviderFor(deps), async () => {
    // A sibling tab may have finished a fresh pair while this tab was
    // backgrounded. Compare under the same lock that wraps `/auth/pair` +
    // persistence; if the complete credential generation changed, adopt it
    // instead of erasing it. If it also proves invalid, that bootstrap's own
    // reauth signal will return here with the new version and perform the wipe.
    try {
      const state = await readStoredPairState(deps.localStore);
      if (
        rejectedPairVersion !== null
        && state.kind === 'complete'
        && !sameStoredCredentialGeneration(
          rejectedPairVersion,
          state.pair.version,
        )
      ) {
        newerPairAvailable = true;
        return;
      }
      // A sibling already completed the durable wipe. Do not replay five
      // remove operations; the shared empty state is already authoritative.
      if (state.kind === 'empty') {
        credentialStateChanged = true;
        return;
      }
    } catch (err) {
      // The mandatory bearer removal remains the fail-safe if version
      // inspection itself is unavailable.
      console.error('webclient: reauth credential-version read failed', err);
    }
    for (const key of WEBCLIENT_LOCAL_KEYS) {
      try {
        await deps.localStore.remove(key);
      } catch (err) {
        console.error('webclient: local-store remove during reauth recovery failed', key, err);
      }
    }
    // Even if the inspection failed, the five fail-safe removals ran. A hint
    // is safe here because sibling tabs independently verify durable state.
    credentialStateChanged = true;
  });
  if (credentialStateChanged && options.onCredentialsRemoved) {
    try {
      options.onCredentialsRemoved();
    } catch (err) {
      console.error('webclient: credential-state signal failed', err);
    }
  }
  // Re-enter the pair-fallback loop. The hydrate path now sees a blank
  // store + throws `WebclientUnpairedError`, which mounts the
  // pair-code-input host. The boot-time deeplink seed is intentionally
  // dropped — a server identity rotation invalidates any cached `?code=`.
  const reentry: PairFallbackBootstrapDeps = {
    ...deps,
    reauthRecovery: {
      ...snapshot,
      ...(serverUrl !== null ? { serverUrl } : {}),
      ...(options.cause !== 'session_rejected' && !newerPairAvailable
        ? { reason: 'credentials_changed_elsewhere' as const }
        : {}),
      ...(newerPairAvailable ? { pairCompletedInAnotherTab: true } : {}),
      ...(draftGuard !== undefined ? { draftGuard } : {}),
    },
  };
  delete reentry.silentCredentialConvergence;
  delete reentry.deeplinkSeed;
  // A receipt belongs to the shell that just consumed it. If that shell later
  // needs reauthorization, its guided recovery supplies fresh contextual copy.
  delete reentry.postPairReceiptCopy;
  if (newerPairAvailable) {
    restoreHash(snapshot.returnHash, deps);
    const outcome = await runBootstrapWithPairFallback(reentry);
    if (outcome.kind === 'mounted') draftGuard?.release();
    return outcome;
  }
  return runBootstrapWithPairFallback(reentry);
};
