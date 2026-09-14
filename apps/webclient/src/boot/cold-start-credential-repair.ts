/** Guided cold-start recovery for damaged local access state.
 *
 * This is intentionally distinct from Settings' broad "Clear this browser":
 * the owner has not entered the app, and only the local access record plus its
 * associated AES key need replacing. Server data, session history, and cached
 * assets are outside the repair's write set. */

import type { WebclientHandle } from '../webclient-bootstrap.js';
import {
  resolveBrowserPairFinalizeLockProvider,
  withPairFinalizeLock,
  type PairFinalizeLockProvider,
} from '../auth/pair-code-success.js';
import type { PairTabConvergence } from './pair-tab-convergence.js';
import { cleanConsumedPairEntryUrl } from './secure-access-resume.js';
import { WebclientReauthRequiredError } from '../realtime/ws-client.js';
import type { WebclientLocalStore } from '../storage/local-store.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import {
  pairFormServerUrlFromStored,
  removeBootSplashWrapper,
  runBootstrapWithPairFallback,
  setSplashMessage,
  type BootstrapFallbackOutcome,
  type PairFallbackBootstrapDeps,
} from './pair-fallback-bootstrap.js';
import {
  readCompleteStoredPair,
  readStoredPairState,
  sameStoredPairVersion,
  type CompleteStoredPair,
  type PartialStoredPair,
} from './stored-pair-state.js';
import {
  armRecoveryReentry,
  armReplacementServerRecoveryReentry,
  armSafeStopRecoveryReentry,
  type RecoveryReentryStorage,
} from './recovery-reentry.js';

export const COLD_START_CREDENTIAL_REPAIR_ATTR =
  'data-recued-cold-start-credential-repair';
export const COLD_START_CREDENTIAL_REPAIR_ACTION_ATTR =
  'data-recued-cold-start-credential-repair-action';
export const COLD_START_CREDENTIAL_RELOAD_ACTION_ATTR =
  'data-recued-cold-start-credential-reload-action';
export const COLD_START_CREDENTIAL_REPAIR_STATUS_ATTR =
  'data-recued-cold-start-credential-repair-status';
const COLD_START_CREDENTIAL_REPAIR_TITLE_ID =
  'webclient-cold-start-credential-repair-title';
const COLD_START_CREDENTIAL_REPAIR_CONSEQUENCE_ID =
  'webclient-cold-start-credential-repair-consequence';
const COLD_START_CREDENTIAL_REPAIR_CONTEXT_ID =
  'webclient-cold-start-credential-repair-context';
const COLD_START_CREDENTIAL_REPAIR_MATERIAL_ID =
  'webclient-cold-start-credential-repair-material';
const COLD_START_CREDENTIAL_REPAIR_STYLES_MARKER =
  'data-recued-cold-start-credential-repair-styles';
const SPLASH_MESSAGE_ID = 'webclient-boot-splash-message';

export const COLD_START_CREDENTIAL_REPAIR_ERROR_COPY =
  'Recued could not finish clearing what this browser had saved. Nothing on your server changed. Try again. If it keeps failing, reload the page.';
export const COLD_START_CREDENTIAL_HANDOFF_ERROR_COPY =
  'What this browser had saved is now cleared. Recued could not start signing in again. Reload the page to carry on.';
export const COLD_START_CREDENTIAL_CHECK_COPY =
  'Checking your saved sign-in…';
export const COLD_START_CREDENTIAL_SETTLE_MS = 240;

/** Give a potentially long cross-tab lock wait one quiet accessible status.
 * The message node later hosts the full pair form, so ARIA is temporary and
 * restored before bootstrap chooses its next surface. */
export const announceColdStartCredentialCheck = (
  doc?: Document,
): ((outcome?: 'complete' | 'error') => void) => {
  const resolvedDocument = doc
    ?? (globalThis as { document?: Document }).document;
  const message = resolvedDocument?.getElementById(SPLASH_MESSAGE_ID);
  if (message === null || message === undefined) {
    setSplashMessage(COLD_START_CREDENTIAL_CHECK_COPY, doc);
    return () => undefined;
  }
  const priorRole = message.getAttribute('role');
  const priorLive = message.getAttribute('aria-live');
  const priorAtomic = message.getAttribute('aria-atomic');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  message.setAttribute('aria-atomic', 'true');
  // Establish the live region before changing its text so assistive
  // technology reliably announces a lock wait that outlives the hidden splash.
  setSplashMessage(COLD_START_CREDENTIAL_CHECK_COPY, doc);
  return (outcome = 'complete') => {
    const restore = (name: string, value: string | null): void => {
      if (value === null) message.removeAttribute(name);
      else message.setAttribute(name, value);
    };
    restore('role', priorRole);
    restore('aria-live', priorLive);
    restore('aria-atomic', priorAtomic);
    if (outcome === 'error') {
      // The caller invokes this before replacing the checking copy. Keeping an
      // assertive live region on the persistent failure surface makes that
      // actionable boot error audible as well as visible.
      message.setAttribute('role', 'alert');
      message.setAttribute('aria-live', 'assertive');
      message.setAttribute('aria-atomic', 'true');
    }
  };
};

const STYLES = `
.cold-start-credential-repair {
  box-sizing: border-box;
  width: min(560px, calc(100vw - 32px));
  padding: 22px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  color: var(--fg);
  box-shadow: 0 16px 40px color-mix(in srgb, var(--fg) 10%, transparent);
  text-align: left;
}
.cold-start-credential-repair-kicker {
  margin: 0 0 5px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.cold-start-credential-repair h2 {
  margin: 0;
  color: var(--fg);
  font-size: 22px;
  line-height: 1.2;
}
.cold-start-credential-repair-summary,
.cold-start-credential-repair-context {
  margin: 10px 0 0;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.55;
}
.cold-start-credential-repair-safe {
  margin: 16px 0;
  padding: 12px 13px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  font-size: 12.5px;
  line-height: 1.5;
}
.cold-start-credential-repair-safe strong {
  display: block;
  margin-bottom: 3px;
  color: var(--fg);
}
.cold-start-credential-repair-material {
  margin: 0 0 16px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-sunk);
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.5;
}
.cold-start-credential-repair-material strong {
  display: block;
  margin-bottom: 3px;
  color: var(--fg);
}
.cold-start-credential-repair-server {
  margin: 0 0 16px;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.45;
}
.cold-start-credential-repair-server code,
.cold-start-credential-repair-server span {
  display: block;
  margin-top: 4px;
  color: var(--fg);
  overflow-wrap: anywhere;
}
.cold-start-credential-repair-steps {
  margin: 0 0 18px;
  padding-left: 20px;
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.5;
}
.cold-start-credential-repair-steps li + li { margin-top: 5px; }
.cold-start-credential-repair-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.cold-start-credential-repair button {
  min-height: 44px;
  border-radius: 8px;
  padding: 9px 14px;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}
.cold-start-credential-repair-primary {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-contrast, #fff);
}
.cold-start-credential-repair-secondary {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg-muted);
}
.cold-start-credential-repair button:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 38%, transparent);
  outline-offset: 2px;
}
.cold-start-credential-repair-status {
  margin: 14px 0 0;
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.45;
}
.cold-start-credential-repair-status.is-error { color: var(--danger, #b42318); }
@media (max-width: 360px) {
  .cold-start-credential-repair {
    width: calc(100vw - 20px);
    padding: 17px 15px;
  }
  .cold-start-credential-repair-actions { align-items: stretch; flex-direction: column; }
  .cold-start-credential-repair button { width: 100%; }
}
`;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export type ColdStartCredentialHealth =
  | {
      readonly kind: 'continue';
      /** The locked inspection verified a complete, decryptable pair. Omitted
       * only for a genuinely empty first-run store. A consumed recovery-entry
       * marker uses this distinction to resume pairing only when access is
       * still absent, never after a closed sibling already completed it. */
      readonly healthyPairAvailable?: true;
      /** A healthy generation became durable in a sibling while this tab was
       * still inspecting damaged startup state. The shell may mount, but this
       * tab must stay silent and return focus to the preserved route. */
      readonly pairCompletedInAnotherTab?: true;
    }
  | {
      readonly kind: 'partial';
      readonly partial: PartialStoredPair;
    }
  | {
      readonly kind: 'unreadable';
      readonly pair: CompleteStoredPair;
    };

type ColdStartCredentialInspection =
  | { readonly kind: 'empty' }
  | { readonly kind: 'healthy'; readonly pair: CompleteStoredPair }
  | Exclude<ColdStartCredentialHealth, { readonly kind: 'continue' }>;

/** Preflight local access before any route mounts. Five null fields are a true
 * first run. Residue without the strict triple is an interrupted write; a
 * typed decrypt failure is an unreadable complete record. Storage/platform
 * errors stay loud to the caller. */
export const inspectColdStartCredentials = async (options: {
  readonly localStore: WebclientLocalStore;
  readonly tokenStore: WebclientTokenStore;
  /** Stabilizes the five-field read against another tab finalizing pairing. */
  readonly pairLockProvider?: PairFinalizeLockProvider | null;
  /** Short-lived, credential-free startup observer. When the first stable
   * read still looks damaged, a signal (or the bounded grace below) earns one
   * final locked read before recovery UI is allowed to render. */
  readonly credentialConvergence?: Pick<PairTabConvergence, 'subscribe'> | null;
  /** Explicit opt-in grace. Omitted callers keep the immediate diagnostic
   * behavior; production supplies the exported 240ms startup budget. */
  readonly settleMs?: number;
}): Promise<ColdStartCredentialHealth> => {
  const pairLockProvider = options.pairLockProvider !== undefined
    ? options.pairLockProvider
    : resolveBrowserPairFinalizeLockProvider();
  const inspectOnce = (): Promise<ColdStartCredentialInspection> =>
    withPairFinalizeLock(
      pairLockProvider,
      async (): Promise<ColdStartCredentialInspection> => {
        const stored = await readStoredPairState(options.localStore);
        if (stored.kind === 'empty') return { kind: 'empty' };
        if (stored.kind === 'partial') {
          return { kind: 'partial', partial: stored.partial };
        }
        const pair = stored.pair;
        try {
          await options.tokenStore.unwrap(pair.token, {
            token_id: pair.token.token_id,
            server_url: pair.serverUrl,
            server_public_key: pair.serverPublicKey,
          });
          return { kind: 'healthy', pair };
        } catch (err) {
          if (err instanceof WebclientReauthRequiredError) {
            return { kind: 'unreadable', pair };
          }
          throw err;
        }
      },
    );

  // Subscribe before the first read so a completion hint that lands while
  // IndexedDB is resolving is not lost. The hint is advisory only: both paths
  // below re-read the durable five-field store under the pair-finalize lock.
  let hinted = false;
  let pairCompletionHinted = false;
  let wake: (() => void) | null = null;
  let unsubscribe = (): void => undefined;
  try {
    unsubscribe = options.credentialConvergence?.subscribe((hint) => {
      hinted = true;
      if (hint === 'pair_complete') pairCompletionHinted = true;
      wake?.();
    }) ?? unsubscribe;
  } catch {
    // The bounded locked recheck below remains available without messaging.
  }
  try {
    const first = await inspectOnce();
    const settleMs = Math.max(0, options.settleMs ?? 0);
    if (first.kind === 'empty') return { kind: 'continue' };
    if (first.kind === 'healthy') {
      return pairCompletionHinted
        ? {
            kind: 'continue',
            healthyPairAvailable: true,
            pairCompletedInAnotherTab: true,
          }
        : { kind: 'continue', healthyPairAvailable: true };
    }
    if (settleMs === 0) return first;

    if (!hinted) {
      await new Promise<void>((resolve) => {
        let settled = false;
        let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          if (timeout !== null) globalThis.clearTimeout(timeout);
          wake = null;
          resolve();
        };
        wake = finish;
        timeout = globalThis.setTimeout(finish, settleMs);
        // A signal can race between the outer `if` and assigning `wake`.
        if (hinted) finish();
      });
    }

    const final = await inspectOnce();
    if (final.kind === 'empty') return { kind: 'continue' };
    if (final.kind !== 'healthy') return final;
    const completedInAnotherTab =
      pairCompletionHinted
      || first.kind === 'partial'
      || (
        first.kind === 'unreadable'
        && !sameStoredPairVersion(first.pair.version, final.pair.version)
      );
    return completedInAnotherTab
      ? {
          kind: 'continue',
          healthyPairAvailable: true,
          pairCompletedInAnotherTab: true,
        }
      : { kind: 'continue', healthyPairAvailable: true };
  } finally {
    wake = null;
    try {
      unsubscribe();
    } catch {
      // Observer teardown cannot replace a durable credential diagnosis.
    }
  }
};

type RepairPhase = 'idle' | 'busy' | 'handoff' | 'error';
export type ColdStartCredentialRepairReason = 'unreadable' | 'partial';

interface ColdStartCredentialRepairCopy {
  readonly kicker: string;
  readonly title: string;
  readonly summary: string;
  readonly consequence: string;
  readonly firstStep: string;
  readonly primary: string;
  readonly primaryBusy: string;
  readonly busyStatus: string;
}

const repairCopy = (
  reason: ColdStartCredentialRepairReason,
  recoveryReentry = false,
  safeStopReentry = false,
  replacementServerReentry = false,
): ColdStartCredentialRepairCopy => {
  if (replacementServerReentry) {
    return {
      kicker: 'Fresh-server verification resumed',
      title: 'Repair local access, then verify the current server',
      summary:
        'The server owner confirmed that the prior server was replaced or reset. The exact page is still selected, but the current server address, fresh pairing code, generated recovery key, and review choice were not restored.',
      consequence: reason === 'partial'
        ? 'This removes only this browser’s incomplete access record and encryption key. It does not restore data from the previous server or change data already on the current server.'
        : 'This removes only this browser’s unreadable access record and encryption key. It does not restore data from the previous server or change data already on the current server.',
      firstStep:
        'Clear the damaged local access, then enter the current server address and a fresh code from its terminal. Recued will keep the recovery key step hidden until you review that server.',
      primary: 'Clear local access and verify current server',
      primaryBusy: 'Preparing server verification…',
      busyStatus: 'Clearing damaged local access before server verification…',
    };
  }
  if (safeStopReentry) {
    return {
      kicker: 'Recovery is still paused',
      title: 'Repair local access, then return to the safe stop',
      summary:
        'This tab reopened after recovery was deliberately stopped for a server-owner check. The exact page is still selected, but no server address, pairing code, recovery key, rejection history, diagnostic, or Chat draft was restored.',
      consequence: reason === 'partial'
        ? 'This removes only this browser’s incomplete access record and encryption key. Connections, Chat history, and other work stored on your server stay unchanged.'
        : 'This removes only this browser’s unreadable access record and encryption key. Connections, Chat history, and other work stored on your server stay unchanged.',
      firstStep:
        'Clear the damaged local access to reopen the paused owner-outcome checkpoint. Recued will not send a pairing request until you explicitly continue there.',
      primary: 'Clear local access and return to safe stop',
      primaryBusy: 'Preparing the safe stop…',
      busyStatus: 'Clearing damaged local access before reopening the safe stop…',
    };
  }
  if (recoveryReentry) {
    return {
      kicker: 'Recovery resumed',
      title: 'Continue recovering this browser',
      summary:
        'This tab reopened while browser recovery was unfinished. You do not need to wait for the earlier page. The exact page you were returning to is still selected, but pairing codes and recovery keys were not restored.',
      consequence: reason === 'partial'
        ? 'This removes only this browser’s incomplete access record and encryption key. Connections, Chat history, and other work stored on your server stay unchanged.'
        : 'This removes only this browser’s unreadable access record and encryption key. Connections, Chat history, and other work stored on your server stay unchanged.',
      firstStep: reason === 'partial'
        ? 'Clear the incomplete local setup, then enter your recovery key again. Use a fresh pairing code only if the server asks for one.'
        : 'Clear the unreadable local access, then enter your recovery key again. Use a fresh pairing code only if the server asks for one.',
      primary: 'Carry on here',
      primaryBusy: 'Preparing secure reconnect…',
      busyStatus: 'Preparing a clean secure reconnect in this tab…',
    };
  }
  return reason === 'partial'
    ? {
        kicker: 'Browser setup was interrupted',
        title: 'Finish reconnecting this browser',
        summary:
          'Recued found an incomplete saved sign-in on this browser. A previous setup may have stopped before every local access detail was saved. If another tab is still finishing that save, this page will continue automatically.',
        consequence:
          'This removes only this browser’s incomplete access record and encryption key. Connections, Chat history, and other work stored on your server stay unchanged.',
        firstStep: 'Keep this page open if another tab is still saving. Otherwise, clear the incomplete local setup and create a fresh browser key.',
        primary: 'Clear incomplete setup and reconnect',
        primaryBusy: 'Clearing incomplete setup…',
        busyStatus: 'Clearing only this browser’s incomplete setup…',
      }
    : {
        kicker: 'Browser access needs repair',
        title: 'Reconnect this browser',
        summary:
          'Recued can no longer unlock the saved sign-in on this browser. Browser storage may have been cleared, changed, or damaged. If another tab is reconnecting now, keep this page open and it will continue automatically when that access is ready.',
        consequence:
          'This removes only this browser’s unreadable access record and encryption key. Connections, Chat history, and other work stored on your server stay unchanged.',
        firstStep: 'Keep this page open if another tab is reconnecting. Otherwise, clear the unreadable local access and create a fresh browser key.',
        primary: 'Clear local access and reconnect',
        primaryBusy: 'Repairing local access…',
        busyStatus: 'Clearing only this browser’s unreadable access…',
      };
};

export interface MountColdStartCredentialRepairHostOptions {
  readonly reason: ColdStartCredentialRepairReason;
  readonly serverUrl: string | null;
  readonly onRepair: () => Promise<void>;
  readonly onReload?: () => void;
  /** This document follows the card's explicit full-page reload. The value is
   * held only in memory after a constant session marker is consumed. */
  readonly reloadAttempted?: boolean;
  /** This surface was restored from an unresolved prior recovery document.
   * Pair inputs stayed ephemeral; the URL alone preserves the exact route. */
  readonly recoveryReentry?: true;
  /** The prior document was deliberately paused for an owner check. No prior
   * server value or diagnostic may be rendered by this repair surface. */
  readonly safeStopReentry?: true;
  /** The owner confirmed a replaced/reset server and the prior document had
   * begun its fresh-server path. All server and recovery inputs remain absent. */
  readonly replacementServerReentry?: true;
  readonly splashElement?: HTMLElement;
  readonly document?: Document;
}

export interface MountedColdStartCredentialRepairHost {
  readonly repair: () => Promise<void>;
  readonly dispose: () => void;
}

const resolveDocument = (doc?: Document): Document | undefined =>
  doc ?? (globalThis as { document?: Document }).document;

export const mountColdStartCredentialRepairHost = (
  options: MountColdStartCredentialRepairHostOptions,
): MountedColdStartCredentialRepairHost => {
  const doc = resolveDocument(options.document);
  const splash = options.splashElement
    ?? doc?.getElementById(SPLASH_MESSAGE_ID)
    ?? null;
  if (splash === null) {
    throw new Error('cold-start credential repair: splash element not found');
  }
  if (
    doc?.head?.querySelector?.(
      `style[${COLD_START_CREDENTIAL_REPAIR_STYLES_MARKER}]`,
    ) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(COLD_START_CREDENTIAL_REPAIR_STYLES_MARKER, '');
    style.textContent = STYLES;
    doc.head.appendChild(style);
  }

  let disposed = false;
  let phase: RepairPhase = 'idle';
  let focusRepairAfterRender = true;
  const privateReentry =
    options.safeStopReentry === true
    || options.replacementServerReentry === true;
  const displayServerUrl = privateReentry
    ? null
    : options.serverUrl === null
      ? null
      : pairFormServerUrlFromStored(options.serverUrl);
  const copy = repairCopy(
    options.reason,
    options.recoveryReentry === true,
    options.safeStopReentry === true,
    options.replacementServerReentry === true,
  );

  const render = (): void => {
    if (disposed) return;
    const busy = phase === 'busy' || phase === 'handoff';
    const status = phase === 'busy'
      ? `<p class="cold-start-credential-repair-status" ${COLD_START_CREDENTIAL_REPAIR_STATUS_ATTR} role="status" tabindex="-1">${escapeHtml(copy.busyStatus)}</p>`
      : phase === 'handoff'
        ? `<p class="cold-start-credential-repair-status" ${COLD_START_CREDENTIAL_REPAIR_STATUS_ATTR} role="status" tabindex="-1">Local access cleared. Opening the secure reconnect…</p>`
        : phase === 'error'
          ? `<p class="cold-start-credential-repair-status is-error" ${COLD_START_CREDENTIAL_REPAIR_STATUS_ATTR} role="alert">${escapeHtml(COLD_START_CREDENTIAL_REPAIR_ERROR_COPY)}</p>`
          : `<p class="cold-start-credential-repair-status" ${COLD_START_CREDENTIAL_REPAIR_STATUS_ATTR} aria-live="polite"></p>`;
    const serverContext = displayServerUrl === null
      ? options.safeStopReentry === true
        ? '<p class="cold-start-credential-repair-server">Saved server address:<span>Not restored — the owner-outcome checkpoint remains paused.</span></p>'
        : options.replacementServerReentry === true
          ? '<p class="cold-start-credential-repair-server">Current server address:<span>Not restored — enter it again before verification.</span></p>'
        : '<p class="cold-start-credential-repair-server">Saved server address:<span>Not available — enter it again in the secure reconnect.</span></p>'
      : `<p class="cold-start-credential-repair-server">Previously connected server:<code>${escapeHtml(displayServerUrl)}</code></p>`;
    const reloadContinuity =
      options.reloadAttempted === true
      && options.recoveryReentry !== true;
    const continuity = reloadContinuity
      ? `<p class="cold-start-credential-repair-context" id="${COLD_START_CREDENTIAL_REPAIR_CONTEXT_ID}">This tab reloaded, but this browser’s saved sign-in still needs fixing. The page you opened is still chosen, so you can keep trying here.</p>`
      : '';
    const materialCheckpoint = options.safeStopReentry === true
      ? `<div class="cold-start-credential-repair-material" id="${COLD_START_CREDENTIAL_REPAIR_MATERIAL_ID}">
          <strong>The owner checkpoint stays paused.</strong>
          <span>Continue only after the server owner confirms that the original key was found or that the server changed. No prior address, key, code, or diagnostic is available here.</span>
        </div>`
      : options.replacementServerReentry === true
        ? `<div class="cold-start-credential-repair-material" id="${COLD_START_CREDENTIAL_REPAIR_MATERIAL_ID}">
            <strong>Current-server details must be entered again.</strong>
            <span>Use a fresh code shown by <code>recued pair</code> on the current server. Recued will verify its signed identity only after pairing succeeds; no old-server key or address is carried forward.</span>
          </div>`
      : options.recoveryReentry === true
        ? `<div class="cold-start-credential-repair-material" id="${COLD_START_CREDENTIAL_REPAIR_MATERIAL_ID}">
            <strong>Have the existing recovery key ready.</strong>
            <span>Recued cannot show or replace those 24 words, and a fresh pairing code is not a substitute. If you cannot find your saved copy, stop here before clearing local access.</span>
          </div>`
        : '';
    const repairDescriptionIds = [
      COLD_START_CREDENTIAL_REPAIR_CONSEQUENCE_ID,
      ...(reloadContinuity ? [COLD_START_CREDENTIAL_REPAIR_CONTEXT_ID] : []),
      ...(options.recoveryReentry === true
        || options.safeStopReentry === true
        || options.replacementServerReentry === true
        ? [COLD_START_CREDENTIAL_REPAIR_MATERIAL_ID]
        : []),
    ].join(' ');
    const reloadDescription = reloadContinuity
      ? `aria-describedby="${COLD_START_CREDENTIAL_REPAIR_CONTEXT_ID}"`
      : '';
    splash.innerHTML = `
      <section class="cold-start-credential-repair" ${COLD_START_CREDENTIAL_REPAIR_ATTR} role="region" aria-labelledby="${COLD_START_CREDENTIAL_REPAIR_TITLE_ID}">
        <p class="cold-start-credential-repair-kicker">${escapeHtml(copy.kicker)}</p>
        <h2 id="${COLD_START_CREDENTIAL_REPAIR_TITLE_ID}">${escapeHtml(copy.title)}</h2>
        <p class="cold-start-credential-repair-summary">${escapeHtml(copy.summary)}</p>
        ${continuity}
        <div class="cold-start-credential-repair-safe">
          <strong>Your server data is not being cleared.</strong>
          <span id="${COLD_START_CREDENTIAL_REPAIR_CONSEQUENCE_ID}">${escapeHtml(copy.consequence)}</span>
        </div>
        ${serverContext}
        ${materialCheckpoint}
        <ol class="cold-start-credential-repair-steps">
          <li>${escapeHtml(copy.firstStep)}</li>
          ${options.safeStopReentry === true
            ? `<li>At the paused checkpoint, choose only what the server owner confirmed: the original key was found, or the server changed or was reset.</li>
              <li>If the current server has no usable recovery key, leave recovery stopped. Your exact page remains selected until a secure reconnect succeeds.</li>`
            : options.replacementServerReentry === true
              ? `<li>Look at this server’s address, and the warning about what you might lose, before you make a new recovery key.</li>
                <li>After its signed identity is verified and access is saved, Recued returns to the exact page still selected in this tab.</li>`
            : `<li>Enter your existing 24-word recovery key. Run <code>recued pair</code> only if the server asks for a pairing code.</li>
              <li>Return to the page you opened after the secure reconnect.</li>`}
        </ol>
        <div class="cold-start-credential-repair-actions">
          <button type="button" class="cold-start-credential-repair-primary" ${COLD_START_CREDENTIAL_REPAIR_ACTION_ATTR} aria-describedby="${repairDescriptionIds}" ${busy ? 'aria-disabled="true"' : ''}>${escapeHtml(busy ? copy.primaryBusy : copy.primary)}</button>
          <button type="button" class="cold-start-credential-repair-secondary" ${COLD_START_CREDENTIAL_RELOAD_ACTION_ATTR} ${reloadDescription} ${busy ? 'aria-disabled="true"' : ''}>Reload and try again</button>
        </div>
        ${status}
      </section>
    `;
    if (phase === 'busy' || phase === 'handoff') {
      (splash.querySelector?.(
        `[${COLD_START_CREDENTIAL_REPAIR_STATUS_ATTR}]`,
      ) as HTMLElement | null)?.focus?.();
    } else if (focusRepairAfterRender) {
      focusRepairAfterRender = false;
      (splash.querySelector?.(
        `[${COLD_START_CREDENTIAL_REPAIR_ACTION_ATTR}]`,
      ) as HTMLElement | null)?.focus?.();
    }
  };

  const repair = async (): Promise<void> => {
    if (disposed || phase === 'busy' || phase === 'handoff') return;
    phase = 'busy';
    render();
    try {
      await options.onRepair();
      if (disposed) return;
      phase = 'handoff';
      render();
    } catch {
      if (disposed) return;
      phase = 'error';
      focusRepairAfterRender = true;
      render();
    }
  };

  const onClick = (event: Event): void => {
    const target = event.target as { closest?: (selector: string) => unknown } | null;
    if (target?.closest?.(`[${COLD_START_CREDENTIAL_REPAIR_ACTION_ATTR}]`)) {
      event.preventDefault();
      void repair();
      return;
    }
    if (target?.closest?.(`[${COLD_START_CREDENTIAL_RELOAD_ACTION_ATTR}]`)) {
      event.preventDefault();
      if (phase === 'busy' || phase === 'handoff') return;
      options.onReload?.();
    }
  };
  splash.addEventListener('click', onClick);
  render();

  return {
    repair,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      splash.removeEventListener('click', onClick);
      splash.innerHTML = '';
    },
  };
};

export interface StartColdStartCredentialRepairOptions {
  readonly root: HTMLElement;
  readonly localStore: WebclientLocalStore;
  /** Forwarded to the bootstrap so a repaired boot lands with the switcher
   *  mounted. Repair is exactly when an owner may want a different server. */
  readonly profileStore?: PairFallbackBootstrapDeps['profileStore'];
  readonly tokenStore: WebclientTokenStore;
  readonly transport: PairFallbackBootstrapDeps['transport'];
  readonly handleRef: { current: WebclientHandle | null };
  readonly cryptoKeysWiper: () => Promise<void>;
  /** Atomically clears the five-field credential store in production. */
  readonly credentialStoreWiper: () => Promise<void>;
  /** Best-effort signal after the unusable local generation is durably gone.
   * Active sibling tabs then stop using the stale in-memory session too. */
  readonly onCredentialsRemoved?: () => void;
  /** Credential-free hints while the repair surface is open. A sibling that
   * finishes the interrupted write becomes authoritative after a locked
   * complete-state read, and this tab returns to work without clearing it. */
  readonly credentialConvergence?: PairTabConvergence | null;
  readonly target:
    | {
        readonly kind: 'unreadable';
        readonly pair: CompleteStoredPair;
      }
    | {
        readonly kind: 'partial';
        readonly partial: PartialStoredPair;
      };
  readonly returnHash: string;
  /** Safe pair-entry seed: CLI code and/or the live secure arrival origin. */
  readonly deeplinkSeed?: PairFallbackBootstrapDeps['deeplinkSeed'];
  readonly pairLockProvider?: PairFinalizeLockProvider | null;
  readonly document?: Document;
  readonly reload?: () => void;
  /** True only in the next document after this recovery card explicitly
   * requested a reload. Used for honest, one-shot continuity copy. */
  readonly reloadAttempted?: boolean;
  /** True only when a constant same-tab marker proved this document replaced
   * an unresolved recovery document. */
  readonly recoveryReentry?: true;
  /** The constant marker distinguished a deliberate missing-key safe stop.
   * Pairing inputs and the previous diagnostic still remain absent. */
  readonly safeStopReentry?: true;
  /** The constant marker distinguished an administrator-confirmed replacement
   * server flow. No address, code, generated key, or review choice survived. */
  readonly replacementServerReentry?: true;
  /** Same-tab marker seam. Defaults to browser sessionStorage. */
  readonly recoveryReentryStorage?: RecoveryReentryStorage | null;
  readonly replaceHash?: (hash: string) => void;
  /** Address-bar seams for scrubbing a consumed pair code when a sibling's
   * completed transition is adopted without entering this tab's pair form. */
  readonly currentUrl?: () => string;
  readonly replaceUrl?: (url: string) => void;
  /** Test seams for the post-clear handoff. */
  readonly runBootstrap?: (
    deps: PairFallbackBootstrapDeps,
  ) => Promise<BootstrapFallbackOutcome>;
  readonly removeSplash?: (doc?: Document) => void;
  readonly onRepairError?: (error: unknown) => void;
  readonly onHandoffError?: (error: unknown) => void;
}

const restoreReturnHash = (
  hash: string,
  options: StartColdStartCredentialRepairOptions,
): void => {
  if (options.replaceHash !== undefined) {
    options.replaceHash(hash);
    return;
  }
  const view = options.document?.defaultView
    ?? (globalThis as unknown as Window);
  if (view?.location === undefined || view.location.hash === hash) return;
  try {
    view.history?.replaceState?.(null, '', hash);
  } catch {
    view.location.hash = hash;
  }
};

const cleanAdoptedPairEntry = (
  options: StartColdStartCredentialRepairOptions,
): void => {
  try {
    const view = options.document?.defaultView
      ?? (globalThis as unknown as Window);
    const source = options.currentUrl?.() ?? view?.location?.href;
    if (typeof source !== 'string' || source.length === 0) return;
    const cleaned = cleanConsumedPairEntryUrl(source);
    if (cleaned === source) return;
    if (options.replaceUrl !== undefined) {
      options.replaceUrl(cleaned);
      return;
    }
    view?.history?.replaceState?.(view.history.state, '', cleaned);
  } catch {
    // The complete durable pair still wins. URL hygiene is best-effort and a
    // reload will re-enter paired boot even if history replacement is denied.
  }
};

/** Mount the explicit repair choice and, only after the owner confirms it,
 * clear the damaged local access generation under the pairing lock.
 * A newer complete generation written by another tab is adopted untouched. */
export const startColdStartCredentialRepair = (
  options: StartColdStartCredentialRepairOptions,
): MountedColdStartCredentialRepairHost => {
  if (
    options.recoveryReentry === true
    || options.safeStopReentry === true
    || options.replacementServerReentry === true
  ) {
    // Enforce the secret boundary at this reusable layer too. Production
    // already scrubs before cold inspection, while direct integrations still
    // must not leave an old code/resume marker visible or seedable.
    cleanAdoptedPairEntry(options);
  }
  const pairLockProvider = options.pairLockProvider !== undefined
    ? options.pairLockProvider
    : resolveBrowserPairFinalizeLockProvider();
  const runBootstrap = options.runBootstrap ?? runBootstrapWithPairFallback;
  const removeSplash = options.removeSplash ?? removeBootSplashWrapper;
  const rejectedPair = options.target.kind === 'unreadable'
    ? options.target.pair
    : null;
  const priorServerUrl = options.target.kind === 'unreadable'
    ? options.target.pair.serverUrl
    : options.target.partial.serverUrl;
  const priorInstanceId = options.target.kind === 'unreadable'
    ? options.target.pair.instanceId
    : options.target.partial.instanceId;
  let host: MountedColdStartCredentialRepairHost;
  let handoffStarted = false;
  let convergenceClosed = false;
  let reconcileInFlight = false;
  let reconcilePending = false;
  let unsubscribeConvergence = (): void => undefined;
  const closeConvergence = (): void => {
    if (convergenceClosed) return;
    convergenceClosed = true;
    try {
      unsubscribeConvergence();
    } catch {
      /* best-effort listener teardown */
    }
    try {
      options.credentialConvergence?.close();
    } catch {
      /* best-effort channel teardown */
    }
  };
  const isAdoptablePair = (currentPair: CompleteStoredPair | null):
    currentPair is CompleteStoredPair =>
    currentPair !== null
    && (
      rejectedPair === null
      || !sameStoredPairVersion(rejectedPair.version, currentPair.version)
    );
  const handoff = async (
    adoptedPair: CompleteStoredPair | null,
  ): Promise<void> => {
    if (handoffStarted) return;
    handoffStarted = true;
    closeConvergence();
    const trustedServerUrl = adoptedPair?.serverUrl
      ?? (
        options.safeStopReentry === true
        || options.replacementServerReentry === true
          ? null
          : priorServerUrl
      );
    const trustedInstanceId = adoptedPair?.instanceId
      ?? (
        options.safeStopReentry === true
        || options.replacementServerReentry === true
          ? null
          : priorInstanceId
      );
    host.dispose();
    if (adoptedPair !== null) cleanAdoptedPairEntry(options);
    setSplashMessage(
      adoptedPair === null
        ? options.target.kind === 'partial'
          ? 'Incomplete setup cleared — opening the secure reconnect…'
          : 'Local access cleared — opening the secure reconnect…'
        : 'Access finished saving in another tab — returning to your work…',
      options.document,
    );
    const returnHash = options.returnHash || '#chat';
    restoreReturnHash(returnHash, options);
    try {
      const outcome = await runBootstrap({
        root: options.root,
        localStore: options.localStore,
        ...(options.profileStore !== undefined
          ? { profileStore: options.profileStore }
          : {}),
        tokenStore: options.tokenStore,
        transport: options.transport,
        handleRef: options.handleRef,
        cryptoKeysWiper: options.cryptoKeysWiper,
        ...(options.recoveryReentryStorage !== undefined
          ? { recoveryReentryStorage: options.recoveryReentryStorage }
          : {}),
        pairLockProvider,
        reauthRecovery: {
          reason: options.target.kind === 'partial'
            ? 'local_credentials_incomplete'
            : 'local_credentials_unreadable',
          returnHash,
          ...(options.recoveryReentry === true
            ? { recoveryReentry: true as const }
            : {}),
          ...(options.safeStopReentry === true
            ? { safeStopReentry: true as const }
            : {}),
          ...(options.replacementServerReentry === true
            ? { replacementServerReentry: true as const }
            : {}),
          ...(trustedServerUrl !== null
            ? { serverUrl: trustedServerUrl }
            : {}),
          ...(trustedInstanceId !== null
            ? { instanceId: trustedInstanceId }
            : {}),
          ...(adoptedPair !== null
            ? { pairCompletedInAnotherTab: true }
            : {}),
        },
        ...(adoptedPair === null
          && options.recoveryReentry !== true
          && options.safeStopReentry !== true
          && options.replacementServerReentry !== true
          && options.deeplinkSeed !== undefined
          ? { deeplinkSeed: options.deeplinkSeed }
          : {}),
        ...(options.replaceHash !== undefined
          ? { replaceHash: options.replaceHash }
          : {}),
        ...(options.document !== undefined
          ? { document: options.document }
          : {}),
      });
      if (outcome.kind === 'mounted') removeSplash(options.document);
    } catch (error) {
      setSplashMessage(
        COLD_START_CREDENTIAL_HANDOFF_ERROR_COPY,
        options.document,
      );
      options.onHandoffError?.(error);
    }
  };
  host = mountColdStartCredentialRepairHost({
    reason: options.target.kind,
    serverUrl: priorServerUrl,
    ...(options.reloadAttempted !== undefined
      ? { reloadAttempted: options.reloadAttempted }
      : {}),
    ...(options.recoveryReentry === true
      ? { recoveryReentry: true as const }
      : {}),
    ...(options.safeStopReentry === true
      ? { safeStopReentry: true as const }
      : {}),
    ...(options.replacementServerReentry === true
      ? { replacementServerReentry: true as const }
      : {}),
    ...(options.document !== undefined ? { document: options.document } : {}),
    onReload: options.reload ?? (() => {
      (globalThis as { location?: { reload?: () => void } }).location?.reload?.();
    }),
    onRepair: async () => {
      // The explicit choice begins recovery before either local wipe. Keep the
      // constant marker across a crash in this transaction; a successful
      // replacement shell retires it through pair fallback.
      if (options.safeStopReentry === true) {
        armSafeStopRecoveryReentry(options.recoveryReentryStorage);
      } else if (options.replacementServerReentry === true) {
        armReplacementServerRecoveryReentry(options.recoveryReentryStorage);
      } else {
        armRecoveryReentry(options.recoveryReentryStorage);
      }
      // The lock arbitration below owns the clear/adopt decision. Keep the
      // observer alive until handoff so a failed local clear can still be
      // rescued by a sibling completion without another user action.
      let newerPair: CompleteStoredPair | null = null;
      let credentialsRemoved = false;
      try {
        await withPairFinalizeLock(pairLockProvider, async () => {
          const currentPair = await readCompleteStoredPair(options.localStore);
          if (isAdoptablePair(currentPair)) {
            newerPair = currentPair;
            return;
          }
          // Wipe the unusable key first. If this fails, the stored diagnosis
          // remains available after reload. Production's credential-store
          // wipe is one committed IDB transaction; only then can the repair
          // safely enter pairing.
          await options.cryptoKeysWiper();
          await options.credentialStoreWiper();
          credentialsRemoved = true;
        });
      } catch (error) {
        options.onRepairError?.(error);
        throw error;
      }
      if (credentialsRemoved && options.onCredentialsRemoved) {
        try {
          options.onCredentialsRemoved();
        } catch {
          // The damaged generation is already gone. A sibling can still
          // reconcile on focus or its own server-auth failure.
        }
      }

      // Assignment happens inside the lock callback, which TypeScript's
      // control-flow analysis cannot observe after `await`.
      const adoptedPair = newerPair as CompleteStoredPair | null;
      await handoff(adoptedPair);
    },
  });

  const reconcileCompletedTransition = async (): Promise<void> => {
    if (handoffStarted || convergenceClosed) return;
    if (reconcileInFlight) {
      // Do not drop a completion hint that lands during the immediate
      // subscribe-race read; re-run once against the newest durable state.
      reconcilePending = true;
      return;
    }
    reconcileInFlight = true;
    try {
      const currentPair = await withPairFinalizeLock(
        pairLockProvider,
        () => readCompleteStoredPair(options.localStore),
      );
      if (isAdoptablePair(currentPair)) await handoff(currentPair);
    } catch {
      // A transient read leaves the explicit repair choice usable. The next
      // broadcast, focus, or poll retries reconciliation.
    } finally {
      reconcileInFlight = false;
      if (reconcilePending && !handoffStarted && !convergenceClosed) {
        reconcilePending = false;
        void reconcileCompletedTransition();
      }
    }
  };
  if (options.credentialConvergence !== undefined
      && options.credentialConvergence !== null) {
    try {
      unsubscribeConvergence = options.credentialConvergence.subscribe(() => {
        void reconcileCompletedTransition();
      });
      // Close the subscribe-after-diagnosis race: the source may have
      // completed between the bounded startup inspection and this mount.
      void reconcileCompletedTransition();
    } catch {
      closeConvergence();
    }
  }

  return {
    repair: host.repair,
    dispose: () => {
      closeConvergence();
      host.dispose();
    },
  };
};
