/** Cause-aware recovery for a startup that failed after browser storage opened.
 *
 * This boundary is deliberately non-destructive. It can retry application
 * startup or reload the same URL, but it never clears saved credentials,
 * collects pairing inputs, or claims that a retry changed server data. Raw
 * platform errors are used only for conservative classification and logging;
 * they are never rendered into the boot splash. */

import { WEBCLIENT_SHELL_CACHE_NAME } from '../runtime/service-worker.js';

export const STARTUP_FAILURE_TRIAGE_ATTR =
  'data-recued-startup-failure-triage';
export const STARTUP_FAILURE_TRIAGE_ACTION_ATTR =
  'data-recued-startup-failure-triage-action';
export const STARTUP_FAILURE_TRIAGE_RELOAD_ATTR =
  'data-recued-startup-failure-triage-reload';
export const STARTUP_FAILURE_TRIAGE_STATUS_ATTR =
  'data-recued-startup-failure-triage-status';
export const STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR =
  'data-recued-startup-failure-diagnostic-action';
export const STARTUP_FAILURE_DIAGNOSTIC_ATTR =
  'data-recued-startup-failure-diagnostic';
export const STARTUP_FAILURE_DIAGNOSTIC_COPY_ATTR =
  'data-recued-startup-failure-diagnostic-copy';
export const STARTUP_FAILURE_DIAGNOSTIC_SUMMARY_ATTR =
  'data-recued-startup-failure-diagnostic-summary';
export const STARTUP_FAILURE_DIAGNOSTIC_STATUS_ATTR =
  'data-recued-startup-failure-diagnostic-status';

const STARTUP_FAILURE_TRIAGE_TITLE_ID =
  'webclient-startup-failure-triage-title';
const STARTUP_FAILURE_TRIAGE_SAFETY_ID =
  'webclient-startup-failure-triage-safety';
const STARTUP_FAILURE_TRIAGE_CONTEXT_ID =
  'webclient-startup-failure-triage-context';
const STARTUP_FAILURE_DIAGNOSTIC_TITLE_ID =
  'webclient-startup-failure-diagnostic-title';
const STARTUP_FAILURE_DIAGNOSTIC_PRIVACY_ID =
  'webclient-startup-failure-diagnostic-privacy';
const STARTUP_FAILURE_DIAGNOSTIC_PANEL_ID =
  'webclient-startup-failure-diagnostic-panel';
const STARTUP_FAILURE_TRIAGE_STYLES_MARKER =
  'data-recued-startup-failure-triage-styles';
import {
  isCertainlyBlockedServerAddress,
  isInsecureSocketFromSecurePage,
  readPageProtocol,
} from '../net/insecure-origin.js';

/** Re-exported so the boot surface and its tests keep one import site; the
 *  definitions live in `net/insecure-origin.ts` because the shell's rpc error
 *  copy asks the same question and two copies of it would drift. */
export { isInsecureSocketFromSecurePage, readPageProtocol };

const SPLASH_MESSAGE_ID = 'webclient-boot-splash-message';
const BOOT_PENDING_SELECTOR = '[data-recued-boot-pending]';

export type StartupFailureKind =
  | 'offline'
  /** The socket was refused by THIS BROWSER, not by the server: an insecure
   *  `ws://` connection attempted from a page served over `https:`. Refines
   *  `server_unreachable`, which is what the raw failure looks like — the
   *  browser reports a blocked handshake exactly like an unplugged cable
   *  (close 1006, no status, no headers), so "can't reach your server" was
   *  the one thing the client could say about a server that was running,
   *  answering, and one origin away. */
  | 'insecure_socket_blocked'
  | 'server_unreachable'
  | 'storage'
  | 'unknown';

const STARTUP_DIAGNOSTIC_PROTOCOLS = new Set([
  'http:',
  'https:',
  'ws:',
  'wss:',
]);

/** Reduce a stored server URL to support-useful host + optional port. Userinfo,
 * path, query, and fragment bytes can never cross this boundary. */
export const startupDiagnosticServerHost = (
  serverUrl: string | null | undefined,
): string | null => {
  if (typeof serverUrl !== 'string' || serverUrl.trim().length === 0) {
    return null;
  }
  try {
    const parsed = new URL(serverUrl);
    if (
      !STARTUP_DIAGNOSTIC_PROTOCOLS.has(parsed.protocol)
      || parsed.hostname.length === 0
    ) {
      return null;
    }
    return parsed.host;
  } catch {
    return null;
  }
};

export interface BuildStartupDiagnosticSummaryOptions {
  readonly kind: StartupFailureKind;
  readonly attemptCount: number;
  /** A full-page reload carries only a privacy-safe repeated bit, not a
   * durable counter, so its reconstructed count is a conservative floor. */
  readonly attemptCountIsLowerBound?: boolean;
  readonly online: boolean | null;
  readonly savedAccessVerified: boolean;
  readonly serverUrl?: string | null;
  readonly capturedAt: Date;
}

const diagnosticFailureLabel = (kind: StartupFailureKind): string => {
  switch (kind) {
    case 'offline': return 'Browser appears offline';
    case 'insecure_socket_blocked': return 'Insecure socket blocked by the browser';
    case 'server_unreachable': return 'Server unreachable';
    case 'storage': return 'Browser storage read failed';
    case 'unknown': return 'Unexpected startup failure';
  }
};

/** Produce a reviewable support summary from a closed list of non-secret
 * observations. The raw failure and page URL are intentionally not inputs. */
export const buildStartupDiagnosticSummary = (
  options: BuildStartupDiagnosticSummaryOptions,
): string => {
  const attemptCount = Number.isFinite(options.attemptCount)
    ? Math.max(1, Math.floor(options.attemptCount))
    : 1;
  const attemptCountCopy = options.attemptCountIsLowerBound === true
    ? `At least ${attemptCount}`
    : String(attemptCount);
  const networkSignal = options.online === true
    ? 'Online hint'
    : options.online === false
      ? 'Offline hint'
      : 'Unavailable';
  const capturedAt = Number.isFinite(options.capturedAt.getTime())
    ? options.capturedAt.toISOString()
    : 'Unavailable';
  const serverHost = startupDiagnosticServerHost(options.serverUrl)
    ?? 'Unavailable';
  return [
    'Recued startup diagnostic',
    `Captured: ${capturedAt}`,
    `Failure category: ${diagnosticFailureLabel(options.kind)}`,
    `Startup attempts in this tab: ${attemptCountCopy}`,
    `Browser network signal: ${networkSignal}`,
    `Saved browser access: ${options.savedAccessVerified ? 'Verified present' : 'Not verified; no local access was cleared'}`,
    `Server host: ${serverHost}`,
    `Webclient shell: ${WEBCLIENT_SHELL_CACHE_NAME}`,
    'Privacy: The server host and any port shown above are included. Raw errors, credentials, pairing codes, Chat drafts, URL paths, query parameters, and fragments are not included.',
  ].join('\n');
};

interface ErrorShape {
  readonly name: string | null;
  readonly code: string | null;
  readonly message: string;
}

const errorShape = (failure: unknown): ErrorShape => {
  if (typeof failure !== 'object' || failure === null) {
    return {
      name: null,
      code: null,
      message: typeof failure === 'string' ? failure.toLowerCase() : '',
    };
  }
  const value = failure as {
    readonly name?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
  };
  return {
    name: typeof value.name === 'string' ? value.name : null,
    code: typeof value.code === 'string' ? value.code.toLowerCase() : null,
    message: typeof value.message === 'string'
      ? value.message.toLowerCase()
      : '',
  };
};

const STORAGE_ERROR_NAMES = new Set([
  'SecurityError',
  'NotAllowedError',
  'QuotaExceededError',
  'InvalidStateError',
  'TransactionInactiveError',
  'ReadOnlyError',
  'VersionError',
]);

const STORAGE_ERROR_CODES = new Set([
  'storage_denied',
  'storage_unavailable',
  'storage_quota',
]);

const SERVER_ERROR_CODES = new Set([
  'server_offline',
  'connection_lost',
  'timeout',
  'transport',
]);

const messageIncludesAny = (
  message: string,
  needles: ReadonlyArray<string>,
): boolean => needles.some((needle) => message.includes(needle));

/** Context the classifier needs to tell a browser-blocked socket apart from a
 *  server that is genuinely not answering. Optional throughout: absent context
 *  simply leaves the verdict at `server_unreachable`, which is what it was. */
export interface StartupFailureContext {
  readonly serverUrl?: string | null;
  readonly pageProtocol?: string | null;
}

/** Conservative startup classifier. A browser-offline signal is treated as a
 * useful hint only after explicit storage failures have been ruled out. */
export const classifyStartupFailure = (
  failure: unknown,
  online: boolean | null = null,
  context: StartupFailureContext = {},
): StartupFailureKind => {
  const shape = errorShape(failure);
  if (
    (shape.name !== null && STORAGE_ERROR_NAMES.has(shape.name))
    || (shape.code !== null && STORAGE_ERROR_CODES.has(shape.code))
    || messageIncludesAny(shape.message, [
      'indexeddb',
      'browser storage',
      'object store',
      'idb request',
      'idb tx',
    ])
  ) {
    return 'storage';
  }
  if (online === false) return 'offline';
  if (
    (shape.code !== null && SERVER_ERROR_CODES.has(shape.code))
    || messageIncludesAny(shape.message, [
      'webclient.browser-transport',
      'websocket',
      'ws closed before open',
      'ws error before open',
      'server offline',
      'failed to fetch',
      'networkerror',
    ])
  ) {
    // Refine ONLY here. A storage failure or a browser that reports itself
    // offline is diagnosed on its own evidence; this narrows the one verdict
    // that was wrong — "the server did not answer" — when the browser is the
    // thing that refused to ask.
    // ⛔ Same narrowing as `isConnectionBlockedByBrowserOrigin`: only claim the
    // browser blocked it where the answer does not depend on WHICH browser —
    // a non-loopback `http://` address. Chrome permits a loopback dial from a
    // secure page, so inferring there turns every local-server failure into a
    // false accusation that reads like a diagnosis.
    return isCertainlyBlockedServerAddress(context.serverUrl, context.pageProtocol)
      ? 'insecure_socket_blocked'
      : 'server_unreachable';
  }
  return 'unknown';
};

export const readBrowserOnlineStatus = (
  doc?: Document,
): boolean | null => {
  const navigatorLike = doc?.defaultView?.navigator
    ?? (globalThis as { navigator?: Navigator }).navigator;
  return typeof navigatorLike?.onLine === 'boolean'
    ? navigatorLike.onLine
    : null;
};

interface StartupFailureCopy {
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly [string, string];
  readonly primary: string;
  readonly retryError: string;
}

const failureCopy = (kind: StartupFailureKind): StartupFailureCopy => {
  switch (kind) {
    case 'offline':
      return {
        title: 'This browser appears offline',
        summary:
          'Recued cannot finish opening while this tab has no network connection.',
        steps: [
          'Reconnect this device to Wi-Fi, Ethernet, or its mobile network.',
          'Keep this tab open, then try startup again.',
        ],
        primary: 'Try again when online',
        retryError:
          'This browser still appears offline. Reconnect it, then try again.',
      };
    case 'insecure_socket_blocked':
      return {
        title: 'This browser blocked the connection',
        summary:
          'Your server answered, but this page is served over https and the server’s '
          + 'address is not — so the browser refused to open the socket before Recued '
          + 'could ask.',
        steps: [
          'Open the webclient from the server itself — its own address, ending in '
            + '/webclient/ — which is the same origin and needs no certificate.',
          'Or give the server a domain and certificate, then pair to its https address.',
        ],
        primary: 'Try the connection again',
        retryError:
          'The browser still refused the connection. Open the webclient from the '
          + 'server’s own address instead.',
      };
    case 'server_unreachable':
      return {
        title: 'Recued can’t reach your server',
        summary:
          'The server did not answer this startup attempt, so Recued could not finish opening your page.',
        steps: [
          'Make sure your Recued server is running and reachable from this device.',
          'If you use a VPN or private network, reconnect it, then try again.',
        ],
        primary: 'Try reaching the server again',
        retryError:
          'Recued still can’t reach your server. Check its connection, then try again.',
      };
    case 'storage':
      return {
        title: 'Browser storage interrupted startup',
        summary:
          'Recued opened this site, but the browser stopped a later read of saved access or local settings.',
        steps: [
          'Make sure this site is allowed to store data and is not open in a private window.',
          'Close other Recued tabs if needed, then try again.',
        ],
        primary: 'Try browser storage again',
        retryError:
          'Browser storage still cannot finish the read. Check the site’s storage permission, then try again.',
      };
    case 'unknown':
      return {
        title: 'Recued couldn’t finish opening',
        summary:
          'This tab hit an unexpected startup problem before your page was ready.',
        steps: [
          'Keep this tab open and try startup again.',
          'If it keeps happening, reload this tab or ask your Recued administrator to check the server logs.',
        ],
        primary: 'Try opening Recued again',
        retryError:
          'Recued still couldn’t finish opening. Try again, or reload this tab if no unsent work is held here.',
      };
  }
};

const STYLES = `
.startup-failure-triage {
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
.startup-failure-triage-kicker {
  margin: 0 0 5px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.startup-failure-triage h2 {
  margin: 0;
  color: var(--fg);
  font-size: 22px;
  line-height: 1.2;
}
.startup-failure-triage-summary,
.startup-failure-triage-context {
  margin: 10px 0 0;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.55;
}
.startup-failure-triage-safe {
  margin: 16px 0;
  padding: 12px 13px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  font-size: 12.5px;
  line-height: 1.5;
}
.startup-failure-triage-safe strong {
  display: block;
  margin-bottom: 3px;
  color: var(--fg);
}
.startup-failure-triage-steps {
  margin: 12px 0 18px;
  padding-left: 20px;
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.5;
}
.startup-failure-triage-steps li + li { margin-top: 5px; }
.startup-failure-triage-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.startup-failure-triage button {
  min-height: 44px;
  border-radius: 8px;
  padding: 9px 14px;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}
.startup-failure-triage button:disabled {
  cursor: wait;
  opacity: .68;
}
.startup-failure-triage-primary {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-contrast, #fff);
}
.startup-failure-triage-secondary {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg-muted);
}
.startup-failure-triage button:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 38%, transparent);
  outline-offset: 2px;
}
.startup-failure-triage-status {
  margin: 13px 0 0;
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.45;
}
.startup-failure-triage-status.is-error {
  color: var(--danger, #b42318);
}
.startup-failure-diagnostic {
  margin: 18px 0 0;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 94%, var(--bg));
}
.startup-failure-diagnostic h3 {
  margin: 0;
  color: var(--fg);
  font-size: 15px;
  line-height: 1.3;
}
.startup-failure-diagnostic-privacy {
  margin: 7px 0 0;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.5;
}
.startup-failure-diagnostic pre {
  box-sizing: border-box;
  width: 100%;
  margin: 12px 0;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--fg);
  font: 11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  overflow-wrap: anywhere;
  user-select: text;
  white-space: pre-wrap;
}
.startup-failure-diagnostic:focus-visible,
.startup-failure-diagnostic pre:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 38%, transparent);
  outline-offset: 2px;
}
.startup-failure-diagnostic-status {
  min-height: 18px;
  margin: 8px 0 0;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.45;
}
@media (max-width: 360px) {
  .startup-failure-triage {
    width: calc(100vw - 20px);
    padding: 17px 15px;
  }
  .startup-failure-triage-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .startup-failure-triage button { width: 100%; }
  .startup-failure-diagnostic { padding: 12px; }
}
`;

type TriagePhase = 'idle' | 'busy' | 'handoff' | 'error';
type DiagnosticCopyState = 'idle' | 'copied' | 'unavailable';

export interface MountStartupFailureTriageOptions {
  readonly initialFailure: unknown;
  readonly savedAccessVerified: boolean;
  readonly draftPreserved: boolean;
  readonly repeated: boolean;
  /** Copy/control context only: another tab already made this browser's
   * secure access durable. This card owns startup recovery, never pairing. */
  readonly completedInAnotherTab?: boolean;
  /** The current failure happened immediately after this card's explicit
   * full-page reload. Used only for honest continuity copy and the repeated
   * attempt floor; no route or error detail is persisted. */
  readonly reloadAttempted?: boolean;
  readonly handoffKind?: 'opening_page' | 'startup_check_complete';
  readonly onRetry: () => Promise<void>;
  /** Called only after the ready handoff has rendered. */
  readonly onRecovered?: () => void;
  readonly onReload?: () => void;
  readonly onFailure?: (
    failure: unknown,
    kind: StartupFailureKind,
  ) => void;
  readonly online?: () => boolean | null;
  /** Stored server address; only its parsed host may enter diagnostics. */
  readonly diagnosticServerUrl?: string | null;
  /** Clipboard and clock seams. Production resolves the browser clipboard. */
  readonly diagnosticWriter?: (summary: string) => Promise<void>;
  readonly diagnosticNow?: () => Date;
  readonly splashElement?: HTMLElement;
  readonly document?: Document;
}

export interface MountedStartupFailureTriage {
  readonly retry: () => Promise<void>;
  readonly showFailure: (failure: unknown) => void;
  readonly dispose: () => void;
  /** Stop this host without clearing a pair form that replaced its markup. */
  readonly detach: () => void;
}

const resolveDocument = (doc?: Document): Document | undefined =>
  doc ?? (globalThis as { document?: Document }).document;

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const mountStartupFailureTriage = (
  options: MountStartupFailureTriageOptions,
): MountedStartupFailureTriage => {
  const doc = resolveDocument(options.document);
  const splash = options.splashElement
    ?? doc?.getElementById(SPLASH_MESSAGE_ID)
    ?? null;
  if (splash === null) {
    throw new Error('startup failure triage: splash element not found');
  }
  // The fast-refresh splash starts hidden for 160ms to avoid a Loading flash.
  // A real recovery card must be visible and focusable immediately; leaving
  // that marker in place makes the initial programmatic focus silently fail.
  (splash.closest?.(BOOT_PENDING_SELECTOR) as HTMLElement | null)
    ?.removeAttribute('data-recued-boot-pending');
  if (
    doc?.head?.querySelector?.(
      `style[${STARTUP_FAILURE_TRIAGE_STYLES_MARKER}]`,
    ) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(STARTUP_FAILURE_TRIAGE_STYLES_MARKER, '');
    style.textContent = STYLES;
    doc.head.appendChild(style);
  }

  let failure = options.initialFailure;
  let failedAttemptCount = options.repeated || options.reloadAttempted ? 2 : 1;
  let phase: TriagePhase = 'idle';
  let disposed = false;
  let focusPrimaryAfterRender = true;
  let diagnosticOpen = false;
  let diagnosticSummary = '';
  let diagnosticCopyState: DiagnosticCopyState = 'idle';
  let diagnosticCopyInFlight = false;
  let diagnosticFocusAfterRender:
    | 'title'
    | 'summary'
    | 'copy'
    | 'status'
    | null = null;
  let detachLoadFocus = (): void => undefined;
  let cancelDeferredFocus = (): void => undefined;
  const online = (): boolean | null => options.online !== undefined
    ? options.online()
    : readBrowserOnlineStatus(doc);
  // Reads after awaited browser work must not inherit TypeScript's pre-await
  // narrowing: the retry control can legitimately advance the shared phase.
  /** Context for `classifyStartupFailure`, read fresh each time: the card can
   *  outlive several retries and the page protocol is cheap to re-read. */
  const failureContext = (): StartupFailureContext => ({
    serverUrl: options.diagnosticServerUrl ?? null,
    pageProtocol: readPageProtocol(options.document),
  });

  const currentPhase = (): TriagePhase => phase;
  const refreshDiagnostic = (): void => {
    const networkSignal = online();
    let capturedAt: Date;
    try {
      capturedAt = options.diagnosticNow?.() ?? new Date();
    } catch {
      capturedAt = new Date(Number.NaN);
    }
    diagnosticSummary = buildStartupDiagnosticSummary({
      kind: classifyStartupFailure(failure, networkSignal, failureContext()),
      attemptCount: failedAttemptCount,
      attemptCountIsLowerBound: options.reloadAttempted === true,
      online: networkSignal,
      savedAccessVerified: options.savedAccessVerified,
      ...(options.diagnosticServerUrl !== undefined
        ? { serverUrl: options.diagnosticServerUrl }
        : {}),
      capturedAt,
    });
    diagnosticCopyState = 'idle';
  };
  const focusPrimary = (): void => {
    (splash.querySelector?.(
      `[${STARTUP_FAILURE_TRIAGE_ACTION_ATTR}]`,
    ) as HTMLElement | null)?.focus?.();
  };
  const view = doc?.defaultView;
  if (
    doc !== undefined
    && doc.readyState !== 'complete'
    && typeof view?.addEventListener === 'function'
  ) {
    const onLoad = (): void => {
      detachLoadFocus();
      const timer = view.setTimeout(() => {
        cancelDeferredFocus = (): void => undefined;
        if (disposed || (phase !== 'idle' && phase !== 'error')) return;
        const active = doc.activeElement;
        if (
          active !== null
          && active !== undefined
          && active !== doc.body
          && active !== doc.documentElement
        ) {
          return;
        }
        focusPrimary();
      }, 0);
      cancelDeferredFocus = () => {
        view.clearTimeout(timer);
        cancelDeferredFocus = (): void => undefined;
      };
    };
    view.addEventListener('load', onLoad, { once: true });
    detachLoadFocus = () => {
      view.removeEventListener('load', onLoad);
      detachLoadFocus = (): void => undefined;
    };
  }

  const render = (): void => {
    if (disposed) return;
    const kind = classifyStartupFailure(failure, online(), failureContext());
    const copy = failureCopy(kind);
    const busy = phase === 'busy' || phase === 'handoff';
    const repeated = failedAttemptCount >= 2;
    const retryError = options.draftPreserved && kind === 'unknown'
      ? 'Recued still couldn’t finish opening. Keep this tab open, ask your Recued administrator to check the server logs, then try startup again.'
      : copy.retryError;
    const siblingCompleted =
      options.completedInAnotherTab === true
      && options.savedAccessVerified;
    const handoffCopy = options.handoffKind === 'startup_check_complete'
      ? 'Saved access check complete. Continuing startup…'
      : 'Startup is ready. Opening your page…';
    const busyStatusCopy = siblingCompleted
      ? 'Trying this tab again with the access already saved…'
      : 'Trying startup again without changing saved access…';
    const busyPrimaryCopy = siblingCompleted
      ? 'Trying this tab…'
      : 'Trying startup…';
    const kickerCopy = siblingCompleted
      ? 'Access saved in another tab'
      : repeated
        ? 'Startup still needs attention'
        : 'Startup needs attention';
    const summaryCopy = siblingCompleted
      ? `Another tab already finished saving secure access for this browser. ${copy.summary}`
      : copy.summary;
    const status = phase === 'busy'
      ? `<p class="startup-failure-triage-status" ${STARTUP_FAILURE_TRIAGE_STATUS_ATTR} role="status" tabindex="-1">${busyStatusCopy}</p>`
      : phase === 'handoff'
        ? `<p class="startup-failure-triage-status" ${STARTUP_FAILURE_TRIAGE_STATUS_ATTR} role="status" tabindex="-1">${handoffCopy}</p>`
        : phase === 'error'
          ? `<p class="startup-failure-triage-status is-error" ${STARTUP_FAILURE_TRIAGE_STATUS_ATTR} role="alert">${retryError}</p>`
          : `<p class="startup-failure-triage-status" ${STARTUP_FAILURE_TRIAGE_STATUS_ATTR} aria-live="polite"></p>`;
    const safeTitle = siblingCompleted
      ? 'Pairing is still complete.'
      : options.savedAccessVerified
        ? 'Your saved access is still here.'
        : 'Recued has not cleared your saved access.';
    const safeDetail = siblingCompleted
      ? 'Only this tab is retrying startup. The saved access stays in place; retrying does not resend a pairing code or recovery key, clear saved access, or change data on your server.'
      : options.savedAccessVerified
        ? 'Retrying only tries to open the app. It does not clear saved access, send another pairing request, or change data on your server.'
        : 'Retrying only attempts startup again. It does not clear local access, send a pairing request, or change data on your server.';
    const context = options.draftPreserved
      ? siblingCompleted
        ? 'Your exact page and unsent Chat draft are still held in this tab. The access saved by the other tab remains ready.'
        : 'Your exact page and unsent Chat draft are still held in this tab. Keep it open while you recover startup.'
      : siblingCompleted
        ? 'The exact page you opened is still selected in this tab. The completed pairing does not need to be repeated.'
        : options.reloadAttempted
          ? 'This tab reloaded, but startup still did not finish. The exact page you opened is still selected, so you can keep recovering here.'
          : 'The exact page you opened is still selected. Retrying here keeps that route.';
    const secondStep = options.draftPreserved && kind === 'unknown'
      ? 'If it keeps happening, keep this tab open and ask your Recued administrator to check the server logs.'
      : copy.steps[1];
    const reloadButton = options.draftPreserved || siblingCompleted
      ? ''
      : `<button type="button" class="startup-failure-triage-secondary" ${STARTUP_FAILURE_TRIAGE_RELOAD_ATTR} aria-describedby="${STARTUP_FAILURE_TRIAGE_SAFETY_ID} ${STARTUP_FAILURE_TRIAGE_CONTEXT_ID}" ${busy ? 'disabled' : ''}>Reload this tab</button>`;
    const diagnosticButton = repeated
      ? `<button type="button" class="startup-failure-triage-secondary" ${STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR} aria-expanded="${diagnosticOpen}" aria-controls="${STARTUP_FAILURE_DIAGNOSTIC_PANEL_ID}" ${busy || diagnosticCopyInFlight ? 'disabled' : ''}>${diagnosticOpen ? 'Refresh safe diagnostic' : 'Review safe diagnostic'}</button>`
      : '';
    const diagnosticStatus = diagnosticCopyInFlight
      ? 'Copying the reviewed summary…'
      : diagnosticCopyState === 'copied'
        ? 'Safe diagnostic copied. Paste it into your support conversation when you’re ready; nothing was sent automatically.'
        : diagnosticCopyState === 'unavailable'
          ? 'Copy is unavailable here. The summary is focused so you can select and copy it manually.'
          : '';
    const diagnosticCopyLabel = diagnosticCopyInFlight
      ? 'Copying…'
      : diagnosticCopyState === 'copied'
        ? 'Copy diagnostic again'
        : 'Copy safe diagnostic';
    const diagnosticPanel = diagnosticOpen
      ? `
        <section class="startup-failure-diagnostic" id="${STARTUP_FAILURE_DIAGNOSTIC_PANEL_ID}" ${STARTUP_FAILURE_DIAGNOSTIC_ATTR} role="region" aria-labelledby="${STARTUP_FAILURE_DIAGNOSTIC_TITLE_ID}" aria-describedby="${STARTUP_FAILURE_DIAGNOSTIC_PRIVACY_ID}" aria-busy="${diagnosticCopyInFlight}" tabindex="-1">
          <h3 id="${STARTUP_FAILURE_DIAGNOSTIC_TITLE_ID}">Safe diagnostic summary</h3>
          <p class="startup-failure-diagnostic-privacy" id="${STARTUP_FAILURE_DIAGNOSTIC_PRIVACY_ID}">Nothing is sent automatically. Review before sharing with the person who manages your Recued server. The server host and any port are visible below; raw error text, credentials, pairing codes, Chat drafts, URL paths, query parameters, and fragments are left out.</p>
          <pre ${STARTUP_FAILURE_DIAGNOSTIC_SUMMARY_ATTR} tabindex="0" aria-label="Privacy-safe startup diagnostic summary">${escapeHtml(diagnosticSummary)}</pre>
          <button type="button" class="startup-failure-triage-secondary" ${STARTUP_FAILURE_DIAGNOSTIC_COPY_ATTR} aria-describedby="${STARTUP_FAILURE_DIAGNOSTIC_PRIVACY_ID}" ${busy || diagnosticCopyInFlight ? 'disabled' : ''}>${diagnosticCopyLabel}</button>
          <p class="startup-failure-diagnostic-status" ${STARTUP_FAILURE_DIAGNOSTIC_STATUS_ATTR} role="status" aria-live="polite" tabindex="-1">${diagnosticStatus}</p>
        </section>`
      : '';
    splash.innerHTML = `
      <section class="startup-failure-triage" ${STARTUP_FAILURE_TRIAGE_ATTR} role="region" aria-labelledby="${STARTUP_FAILURE_TRIAGE_TITLE_ID}" aria-busy="${busy}">
        <p class="startup-failure-triage-kicker">${kickerCopy}</p>
        <h2 id="${STARTUP_FAILURE_TRIAGE_TITLE_ID}">${copy.title}</h2>
        <p class="startup-failure-triage-summary">${summaryCopy}</p>
        <div class="startup-failure-triage-safe" id="${STARTUP_FAILURE_TRIAGE_SAFETY_ID}">
          <strong>${safeTitle}</strong>
          ${safeDetail}
        </div>
        <p class="startup-failure-triage-context" id="${STARTUP_FAILURE_TRIAGE_CONTEXT_ID}">${context}</p>
        <ol class="startup-failure-triage-steps">
          <li>${copy.steps[0]}</li>
          <li>${secondStep}</li>
        </ol>
        <div class="startup-failure-triage-actions">
          <button type="button" class="startup-failure-triage-primary" ${STARTUP_FAILURE_TRIAGE_ACTION_ATTR} aria-describedby="${STARTUP_FAILURE_TRIAGE_SAFETY_ID} ${STARTUP_FAILURE_TRIAGE_CONTEXT_ID}" ${busy ? 'disabled' : ''}>${busy ? busyPrimaryCopy : copy.primary}</button>
          ${diagnosticButton}
          ${reloadButton}
        </div>
        ${status}
        ${diagnosticPanel}
      </section>
    `;
    if (diagnosticFocusAfterRender !== null && !busy) {
      const selector = diagnosticFocusAfterRender === 'title'
        ? `[${STARTUP_FAILURE_DIAGNOSTIC_ATTR}]`
        : diagnosticFocusAfterRender === 'summary'
          ? `[${STARTUP_FAILURE_DIAGNOSTIC_SUMMARY_ATTR}]`
          : diagnosticFocusAfterRender === 'status'
            ? `[${STARTUP_FAILURE_DIAGNOSTIC_STATUS_ATTR}]`
            : `[${STARTUP_FAILURE_DIAGNOSTIC_COPY_ATTR}]`;
      diagnosticFocusAfterRender = null;
      (splash.querySelector?.(selector) as HTMLElement | null)?.focus?.();
    } else if (busy) {
      (splash.querySelector?.(
        `[${STARTUP_FAILURE_TRIAGE_STATUS_ATTR}]`,
      ) as HTMLElement | null)?.focus?.();
    } else if (focusPrimaryAfterRender) {
      focusPrimaryAfterRender = false;
      focusPrimary();
    }
  };

  const prepareDiagnostic = (): void => {
    if (
      disposed
      || phase === 'busy'
      || phase === 'handoff'
      || failedAttemptCount < 2
    ) {
      return;
    }
    refreshDiagnostic();
    diagnosticOpen = true;
    diagnosticFocusAfterRender = 'title';
    render();
  };

  const copyDiagnostic = async (): Promise<void> => {
    if (
      disposed
      || !diagnosticOpen
      || diagnosticSummary.length === 0
      || diagnosticCopyInFlight
      || phase === 'busy'
      || phase === 'handoff'
    ) {
      return;
    }
    diagnosticCopyInFlight = true;
    diagnosticFocusAfterRender = 'status';
    render();
    const summary = diagnosticSummary;
    let copyState: DiagnosticCopyState;
    try {
      if (options.diagnosticWriter !== undefined) {
        await options.diagnosticWriter(summary);
      } else {
        const navigatorLike = doc?.defaultView?.navigator
          ?? (globalThis as { navigator?: Navigator }).navigator;
        const clipboard = navigatorLike?.clipboard;
        if (typeof clipboard?.writeText !== 'function') {
          throw new Error('startup diagnostic clipboard unavailable');
        }
        await clipboard.writeText(summary);
      }
      copyState = 'copied';
    } catch {
      copyState = 'unavailable';
    } finally {
      diagnosticCopyInFlight = false;
    }
    const phaseAfterCopy = currentPhase();
    if (
      disposed
      || !diagnosticOpen
      || phaseAfterCopy === 'handoff'
    ) {
      return;
    }
    if (diagnosticSummary !== summary) {
      // A retry or manual refresh replaced the reviewed text while the browser
      // clipboard was pending. Never apply the old receipt to the new summary;
      // just re-enable the current controls.
      render();
      return;
    }
    diagnosticCopyState = copyState;
    diagnosticFocusAfterRender = phaseAfterCopy === 'busy'
      ? null
      : copyState === 'unavailable'
        ? 'summary'
        : 'copy';
    render();
  };

  const showFailure = (nextFailure: unknown): void => {
    if (disposed || phase === 'handoff') return;
    failure = nextFailure;
    failedAttemptCount += 1;
    phase = 'error';
    focusPrimaryAfterRender = true;
    diagnosticFocusAfterRender = null;
    if (diagnosticOpen) refreshDiagnostic();
    const kind = classifyStartupFailure(failure, online(), failureContext());
    options.onFailure?.(failure, kind);
    render();
  };

  const retry = async (): Promise<void> => {
    if (disposed || phase === 'busy' || phase === 'handoff') return;
    phase = 'busy';
    render();
    try {
      await options.onRetry();
      if (disposed) return;
      phase = 'handoff';
      render();
      options.onRecovered?.();
    } catch (nextFailure) {
      showFailure(nextFailure);
    }
  };

  const reload = (): void => {
    if (disposed || phase === 'busy' || phase === 'handoff') return;
    if (options.draftPreserved) return;
    if (options.onReload !== undefined) {
      options.onReload();
      return;
    }
    const view = doc?.defaultView
      ?? (globalThis as { location?: { reload?: () => void } });
    view?.location?.reload?.();
  };

  const onClick = (event: Event): void => {
    const target = event.target as {
      closest?: (selector: string) => unknown;
    } | null;
    if (target?.closest?.(`[${STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR}]`)) {
      event.preventDefault();
      prepareDiagnostic();
      return;
    }
    if (target?.closest?.(`[${STARTUP_FAILURE_DIAGNOSTIC_COPY_ATTR}]`)) {
      event.preventDefault();
      void copyDiagnostic();
      return;
    }
    if (target?.closest?.(`[${STARTUP_FAILURE_TRIAGE_ACTION_ATTR}]`)) {
      event.preventDefault();
      void retry();
      return;
    }
    if (target?.closest?.(`[${STARTUP_FAILURE_TRIAGE_RELOAD_ATTR}]`)) {
      event.preventDefault();
      reload();
    }
  };

  const detach = (): void => {
    if (disposed) return;
    disposed = true;
    detachLoadFocus();
    cancelDeferredFocus();
    splash.removeEventListener('click', onClick);
  };

  splash.addEventListener('click', onClick);
  render();

  return {
    retry,
    showFailure,
    detach,
    dispose: () => {
      if (disposed) return;
      detach();
      splash.innerHTML = '';
    },
  };
};

export interface RecoverStartupTaskWithTriageOptions<T> {
  readonly initialFailure: unknown;
  readonly task: () => Promise<T>;
  readonly savedAccessVerified: boolean;
  readonly draftPreserved?: boolean;
  readonly repeated?: boolean;
  readonly reloadAttempted?: boolean;
  readonly onReload?: () => void;
  readonly onFailure?: (
    failure: unknown,
    kind: StartupFailureKind,
  ) => void;
  readonly online?: () => boolean | null;
  readonly splashElement?: HTMLElement;
  readonly document?: Document;
  readonly mountHost?: (
    options: MountStartupFailureTriageOptions,
  ) => MountedStartupFailureTriage;
}

/** Pause a pre-shell startup task behind the same reusable triage card. The
 * promise resolves only after an in-place retry succeeds; failed retries stay
 * on the live card and update its reason without reloading the route. */
export const recoverStartupTaskWithTriage = <T>(
  options: RecoverStartupTaskWithTriageOptions<T>,
): Promise<T> => new Promise<T>((resolve, reject) => {
  const currentOnline = (): boolean | null => options.online !== undefined
    ? options.online()
    : readBrowserOnlineStatus(options.document);
  options.onFailure?.(
    options.initialFailure,
    classifyStartupFailure(options.initialFailure, currentOnline()),
  );
  try {
    let recovered: { readonly value: T } | null = null;
    let host!: MountedStartupFailureTriage;
    const mountHost = options.mountHost ?? mountStartupFailureTriage;
    host = mountHost({
      initialFailure: options.initialFailure,
      savedAccessVerified: options.savedAccessVerified,
      draftPreserved: options.draftPreserved ?? false,
      repeated: options.repeated ?? false,
      reloadAttempted: options.reloadAttempted ?? false,
      handoffKind: 'startup_check_complete',
      onRetry: async () => {
        recovered = { value: await options.task() };
      },
      onRecovered: () => {
        if (recovered === null) return;
        // Keep the ready handoff visible until the next startup surface takes
        // ownership, but retire this card's delegated click listener first.
        host.detach();
        resolve(recovered.value);
      },
      ...(options.onReload !== undefined
        ? { onReload: options.onReload }
        : {}),
      ...(options.onFailure !== undefined
        ? { onFailure: options.onFailure }
        : {}),
      ...(options.online !== undefined ? { online: options.online } : {}),
      ...(options.splashElement !== undefined
        ? { splashElement: options.splashElement }
        : {}),
      ...(options.document !== undefined
        ? { document: options.document }
        : {}),
    });
  } catch (error) {
    reject(error);
  }
});
