/** D-178 — Settings → Updates page.
 *
 *  Frontend surface over the already-built `update.*` server rpcs (check /
 *  mode / set_mode / apply / rollback). The page:
 *    - checks for a new release (`update.check`) on mount + on demand, and on a
 *      periodic poll so the rail item can show an "update available" badge
 *      without the user opening this page (no push channel exists — D-178 has no
 *      update broadcast, so availability is poll-driven);
 *    - renders the available release (version, migration/major/urgent flags,
 *      notes link) and applies it (`update.apply`), with a confirm step for a
 *      major bump (the server returns `major-blocked` until `force`);
 *    - exposes the auto/notify/off apply-mode toggle (`update.mode` /
 *      `update.set_mode`), locked when the server pins it via env;
 *    - offers an in-place rollback (`update.rollback`).
 *
 *  DOM-only (vanilla), driven by injected rpc callers so it unit-tests against
 *  the webclient's fake `Document`. Every control is gated: an absent caller
 *  renders a degraded-but-honest surface rather than a broken button.
 */

import type {
  ReleaseCheckResponse,
  ReleaseCheckStatus,
  UpdateApplyResponse,
  UpdateMode,
  UpdateModeStatus,
  UpdateRollbackResponse,
  UpdateRollbackArgs,
  UpdateApplyArgs,
} from '@recued/contracts';
import type {
  ServerUpdateReceiptVerificationState,
} from '@recued/ui-shared';

import type {
  CredentialRotationServerUpdateContinuity,
  CredentialRotationServerUpdateTarget,
} from '../connections/credential-rotation-server-update-continuity.js';
import type {
  CredentialRotationOwnershipLease,
  CredentialRotationTabConvergence,
  ServerUpdateOperation,
  ServerUpdateTabProgress,
} from '../connections/credential-rotation-tab-convergence.js';
import {
  buildServerUpdateReceiptDiagnostic,
  type ServerUpdateReceiptVerificationController,
} from '../connections/server-update-receipt-verification.js';
import type {
  WebclientConnectionStatus,
  WebclientConnectionStatusController,
} from '../realtime/connection-status.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { WEBCLIENT_SHELL_CACHE_NAME } from '../runtime/service-worker.js';

export const UPDATES_PAGE_ATTR = 'data-recued-updates-page';
export const UPDATES_PAGE_STATE_ATTR = 'data-recued-updates-page-state';
export const UPDATES_VERSION_ATTR = 'data-recued-updates-version';
/** The web app build this browser is running, beside the server's version. */
export const UPDATES_WEBAPP_VERSION_ATTR = 'data-recued-updates-webapp-version';
export const UPDATES_CHECK_BTN_ATTR = 'data-recued-updates-check';
export const UPDATES_STATUS_ATTR = 'data-recued-updates-status';
export const UPDATES_ERROR_ATTR = 'data-recued-updates-error';
export const UPDATES_AVAILABLE_ATTR = 'data-recued-updates-available';
export const UPDATES_APPLY_BTN_ATTR = 'data-recued-updates-apply';
export const UPDATES_FORCE_APPLY_BTN_ATTR = 'data-recued-updates-force-apply';
export const UPDATES_APPLY_RESULT_ATTR = 'data-recued-updates-apply-result';
/** On the Update button once the first click has turned it into "Confirm update". */
export const UPDATES_APPLY_CONFIRM_ATTR = 'data-recued-updates-apply-confirm';
/** The Cancel beside "Confirm update": back to "Update to <version>", nothing sent. */
export const UPDATES_APPLY_CANCEL_ATTR = 'data-recued-updates-apply-cancel';
export const UPDATES_MODE_SELECT_ATTR = 'data-recued-updates-mode';
export const UPDATES_MODE_NOTE_ATTR = 'data-recued-updates-mode-note';
export const UPDATES_ROLLBACK_BTN_ATTR = 'data-recued-updates-rollback';
export const UPDATES_ROLLBACK_RESULT_ATTR = 'data-recued-updates-rollback-result';
export const UPDATES_CREDENTIAL_RETRY_ATTR =
  'data-recued-updates-credential-retry';
export const UPDATES_CREDENTIAL_RETRY_IDENTITY_ATTR =
  'data-recued-updates-credential-retry-identity';
export const UPDATES_CREDENTIAL_RETRY_STATUS_ATTR =
  'data-recued-updates-credential-retry-status';
export const UPDATES_CREDENTIAL_RETRY_PRIVACY_ATTR =
  'data-recued-updates-credential-retry-privacy';
export const UPDATES_CREDENTIAL_RETRY_RETURN_ATTR =
  'data-recued-updates-credential-retry-return';
export const UPDATES_CREDENTIAL_RETRY_DISMISS_ATTR =
  'data-recued-updates-credential-retry-dismiss';
export const UPDATES_TAB_PROGRESS_ATTR =
  'data-recued-updates-tab-progress';
export const UPDATES_TAB_PROGRESS_STATUS_ATTR =
  'data-recued-updates-tab-progress-status';
export const UPDATES_TAB_PROGRESS_PRIVACY_ATTR =
  'data-recued-updates-tab-progress-privacy';
/** ⛔⛔ THE PHASES THAT NEED NOBODY — the NORMAL path, where Recued is confirming
 *  the operation and retrying on its own. The receipt-recovery panel is hidden
 *  for exactly these; every other phase shows it.
 *
 *  The panel used to appear at `waiting`, so an ordinary update surfaced a panel
 *  about "receipts" and the machinery for a rare case colonised the common one.
 *  Reported 2026-08-31.
 *
 *  🔑 A LIST OF WHAT TO HIDE, NOT WHAT TO SHOW, AND THAT DIRECTION IS THE POINT.
 *  Listing the problem phases meant any phase added to the verification
 *  controller later defaulted to HIDDEN — I wrote that version first and it
 *  stranded `reviewing_closure` and `closing`, i.e. the owner mid-recovery with
 *  the panel gone. Inverted, a new phase defaults to VISIBLE: showing a step
 *  nobody needs is noise, hiding one they do is a dead end.
 *
 *  ⚠ One definition, two consumers (this panel and the progress banner). */
const RECEIPT_SELF_RESOLVING_PHASES: ReadonlySet<string> = new Set([
  'checking',
  'waiting',
]);

export const UPDATES_RECEIPT_RECOVERY_ATTR =
  'data-recued-updates-receipt-recovery';
export const UPDATES_RECEIPT_RETRY_ATTR =
  'data-recued-updates-receipt-retry';
export const UPDATES_RECEIPT_CLOSURE_REVIEW_ATTR =
  'data-recued-updates-receipt-closure-review';
export const UPDATES_RECEIPT_CLOSURE_REVIEW_BUTTON_ATTR =
  'data-recued-updates-receipt-closure-review-button';
export const UPDATES_RECEIPT_CLOSURE_CONFIRM_ATTR =
  'data-recued-updates-receipt-closure-confirm';
export const UPDATES_RECEIPT_CLOSURE_CANCEL_ATTR =
  'data-recued-updates-receipt-closure-cancel';
export const UPDATES_RECEIPT_CLOSURE_FINISH_ATTR =
  'data-recued-updates-receipt-closure-finish';
export const UPDATES_RECEIPT_BASELINE_ATTR =
  'data-recued-updates-receipt-baseline';
export const UPDATES_RECEIPT_DIAGNOSTIC_ATTR =
  'data-recued-updates-receipt-diagnostic';
export const UPDATES_RECEIPT_DIAGNOSTIC_COPY_ATTR =
  'data-recued-updates-receipt-diagnostic-copy';
export const UPDATES_RECEIPT_DIAGNOSTIC_STATUS_ATTR =
  'data-recued-updates-receipt-diagnostic-status';

export const UPDATES_PAGE_STYLES = `
[${UPDATES_PAGE_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
[${UPDATES_VERSION_ATTR}]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
[${UPDATES_PAGE_ATTR}] > p,
[${UPDATES_PAGE_ATTR}] > div > p {
  margin: 0;
  line-height: 1.5;
}
[${UPDATES_CREDENTIAL_RETRY_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 10px;
  background: var(--surface-sunk);
}
[${UPDATES_CREDENTIAL_RETRY_ATTR}][hidden] { display: none; }
[${UPDATES_CREDENTIAL_RETRY_ATTR}] h3,
[${UPDATES_CREDENTIAL_RETRY_ATTR}] p { margin: 0; }
[${UPDATES_CREDENTIAL_RETRY_ATTR}] h3 {
  font-size: 14px;
  font-weight: 650;
}
[${UPDATES_CREDENTIAL_RETRY_IDENTITY_ATTR}] {
  width: fit-content;
  max-width: 100%;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--surface-raised, var(--surface));
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
[${UPDATES_CREDENTIAL_RETRY_STATUS_ATTR}] { color: var(--fg); }
[${UPDATES_CREDENTIAL_RETRY_ATTR}] .updates-credential-retry-privacy {
  color: var(--muted);
  font-size: 12px;
}
[${UPDATES_CREDENTIAL_RETRY_ATTR}] .updates-credential-retry-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
[${UPDATES_TAB_PROGRESS_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 10px;
  background: var(--surface-sunk);
}
[${UPDATES_TAB_PROGRESS_ATTR}][hidden] { display: none; }
[${UPDATES_TAB_PROGRESS_ATTR}] strong,
[${UPDATES_TAB_PROGRESS_ATTR}] p { margin: 0; }
[${UPDATES_TAB_PROGRESS_PRIVACY_ATTR}] {
  color: var(--muted);
  font-size: 12px;
}
[${UPDATES_RECEIPT_RECOVERY_ATTR}] {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 10px;
  background: var(--surface-sunk);
}
[${UPDATES_RECEIPT_RECOVERY_ATTR}][hidden],
[${UPDATES_RECEIPT_CLOSURE_REVIEW_ATTR}][hidden],
[${UPDATES_RECEIPT_BASELINE_ATTR}][hidden],
[${UPDATES_RECEIPT_DIAGNOSTIC_ATTR}][hidden] { display: none; }
[${UPDATES_RECEIPT_RECOVERY_ATTR}] p,
[${UPDATES_RECEIPT_RECOVERY_ATTR}] pre { margin: 0; }
[${UPDATES_RECEIPT_RECOVERY_ATTR}] pre {
  max-width: 100%;
  padding: 8px;
  overflow: auto;
  border-radius: 6px;
  background: var(--surface-raised, var(--surface));
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
[${UPDATES_RECEIPT_RECOVERY_ATTR}] pre:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
[${UPDATES_RECEIPT_RETRY_ATTR}],
[${UPDATES_RECEIPT_CLOSURE_REVIEW_BUTTON_ATTR}],
[${UPDATES_RECEIPT_CLOSURE_CONFIRM_ATTR}],
[${UPDATES_RECEIPT_CLOSURE_CANCEL_ATTR}],
[${UPDATES_RECEIPT_CLOSURE_FINISH_ATTR}],
[${UPDATES_RECEIPT_DIAGNOSTIC_COPY_ATTR}] {
  min-height: 44px;
  width: fit-content;
}
[${UPDATES_RECEIPT_CLOSURE_REVIEW_ATTR}] {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-raised, var(--surface));
}
[${UPDATES_RECEIPT_BASELINE_ATTR}] {
  display: grid;
  gap: 5px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-raised, var(--surface));
}
[${UPDATES_RECEIPT_BASELINE_ATTR}] strong,
[${UPDATES_RECEIPT_BASELINE_ATTR}] p {
  margin: 0;
  overflow-wrap: anywhere;
}
[${UPDATES_RECEIPT_CLOSURE_REVIEW_ATTR}] .updates-receipt-closure-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
`;

/** Default availability re-check cadence (6h — matches the server's stable
 *  housekeeping check). Injectable via `pollIntervalMs`. */
export const UPDATES_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateCheckCaller = () => Promise<ReleaseCheckResponse>;
export type UpdateModeGetCaller = () => Promise<UpdateModeStatus>;
export type UpdateModeSetCaller = (args: { mode: UpdateMode }) => Promise<UpdateModeStatus>;
/** ⛔ THE ARGS TYPE IS THE CONTRACT'S, NOT A HAND-WRITTEN SUBSET. It read
 *  `{ force?: boolean }` while the call site was already passing
 *  `expected_release_identity` and `confirm_rollout` — which compiled only
 *  because both go in through SPREADS, and TypeScript skips excess-property
 *  checking on those. So the port silently stopped describing the call years
 *  before anything noticed; the first DIRECT property added to that literal is
 *  what surfaced it. */
export type UpdateApplyCaller = (args: UpdateApplyArgs) => Promise<UpdateApplyResponse>;
export type UpdateRollbackCaller = (args: UpdateRollbackArgs) => Promise<UpdateRollbackResponse>;

interface UpdateProgressEvent {
  phase: string;
  status?: UpdateApplyResponse['status'];
  detail?: string;
  to_version?: string;
  /** On the terminal emit; binds this global event to one accepted operation. */
  operation_id?: string;
}

export interface MountUpdatesPageOptions {
  host: HTMLElement;
  document?: Document;
  runCheck?: UpdateCheckCaller;
  runGetMode?: UpdateModeGetCaller;
  runSetMode?: UpdateModeSetCaller;
  runApply?: UpdateApplyCaller;
  runRollback?: UpdateRollbackCaller;
  /** Fires whenever the check outcome's availability changes — the route wires
   *  this to the "Updates" rail badge. Best-effort (a throw is swallowed). */
  onAvailabilityChanged?: (available: boolean) => void;
  /** Periodic re-check scheduler (returns a cancel fn). Omit → no auto-poll (the
   *  page still checks once on mount + on the Check button). Tests inject a
   *  controllable fake; production wires a `setInterval` wrapper. */
  startPoll?: (cb: () => void, ms: number) => () => void;
  pollIntervalMs?: number;
  /** Secret-free boot-scoped continuation from unsupported rotation preflight
   * through server update/restart and back to the exact authoritative retry. */
  credentialRotationServerUpdateContinuity?: Pick<
    CredentialRotationServerUpdateContinuity,
    | 'read'
    | 'isDurable'
    | 'recordServerCheck'
    | 'markAwaitingReconnect'
    | 'resumeResolvedRetry'
    | 'retire'
    | 'subscribe'
  >;
  /** Profile-scoped browser ownership + privacy-safe progress. One tab invokes
   * update/rollback; sibling tabs observe until their own reconnect proves the
   * restart boundary. */
  serverUpdateTabConvergence?: Pick<
    CredentialRotationTabConvergence,
    | 'supportsServerUpdateOwnership'
    | 'claimServerUpdateOwnership'
    | 'readServerUpdateProgress'
    | 'notifyServerUpdateProgress'
    | 'clearServerUpdateProgress'
    | 'reconcileServerUpdateProgress'
    | 'subscribe'
  >;
  serverConnectionStatus?: Pick<
    WebclientConnectionStatusController,
    'status' | 'onStatus'
  >;
  /** Boot-owned exact receipt verifier. It exposes no receipt or raw error. */
  /** D-257 — live phases for a run the server accepted with `applying`.
   *
   *  ⛔ WITHOUT THIS THE PAGE NEVER LEARNS THE OUTCOME. `update.apply` no longer
   *  waits for the work — it downloads ~144 MB, which outlasted the 30s per-call
   *  timeout and made every real update report a failure the server then went on
   *  to complete. The rpc answers `applying` and the result arrives here.
   *
   *  ⚠ Optional, and the page must still handle a TERMINAL status coming straight
   *  back from the rpc: an OLD server blocks and answers the old way, and the
   *  hosted webclient meets old servers constantly. */
  updateProgress?: {
    subscribe: (cb: (event: UpdateProgressEvent) => void) => () => void;
  };
  serverUpdateReceiptVerification?: Pick<
    ServerUpdateReceiptVerificationController,
    | 'read'
    | 'retry'
    | 'reviewClosure'
    | 'cancelClosureReview'
    | 'closeUnresolved'
    | 'finishClosure'
    | 'dismissCompletion'
    | 'subscribe'
  >;
  /** Owner-visible identity used only in the reviewable safe diagnostic. */
  serverUpdateReceiptDiagnosticContext?: {
    serverUrl?: string | null;
    profileLabel?: string | null;
  };
  serverUpdateReceiptDiagnosticWriter?: (summary: string) => Promise<void>;
  onReturnToCredentialRotationRetry?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
}

export type UpdatesCheckPhase = 'idle' | 'checking' | 'checked' | 'error';

export interface UpdatesPageState {
  phase: UpdatesCheckPhase;
  check: ReleaseCheckResponse | null;
  checkError: string | null;
  applying: boolean;
  /** The owner pressed "Update to <version>" and the button now asks "Confirm
   *  update". Consumed by the apply it confirms, and reset by a check that finds
   *  a different release, so consent never carries over to another version. */
  confirmArmed: boolean;
  applyResult: UpdateApplyResponse | null;
  /** How the last update from this page ended, once a check after it could
   *  say ("Updated to 26.9.28."). Replaces the in-flight apply message. */
  updateOutcome: string | null;
  /** D-257 — the latest ledger phase of a run the server accepted, so the page
   *  can say something true while a multi-minute apply is in flight rather than
   *  sitting on one static line. `null` until a phase arrives; irrelevant once
   *  `applyResult` lands. */
  applyPhase: string | null;
  applyError: string | null;
  mode: UpdateModeStatus | null;
  modeBusy: boolean;
  modeError: string | null;
  rollbackBusy: boolean;
  rollbackResult: UpdateRollbackResponse | null;
  rollbackError: string | null;
}

export interface UpdatesPageMount {
  /** Run a check now (mount + Check button + poll all route through this). */
  refresh: () => Promise<void>;
  getState: () => UpdatesPageState;
  /** User-started writes whose authoritative outcome is not known yet.
   * Availability and mode reads are deliberately excluded. */
  hasInFlightWork: () => boolean;
  dispose: () => void;
}

const CHECK_STATUS_COPY: Readonly<Record<ReleaseCheckStatus, string>> = {
  'update-available': '',
  'up-to-date': "You're on the latest version.",
  'not-configured': 'This server is not set up to update itself yet.',
  // ⛔ LEGACY — only a server old enough to still gate on `expires_at` can
  // produce this; the freshness gate was removed 2026-09-01. Say what is
  // actionable (update that server) rather than teaching a retired concept.
  'stale-feed': 'This server checks for updates in an old way that ignores the current list. Run the installer on it again.',
  'launcher-outdated': 'The launcher is too old to install updates. Update the launcher first.',
  replay: 'The update list was older than one this server has already seen, so Recued ignored it.',
  'fetch-failed': "Couldn't reach the release feed.",
  'bad-signature': 'Recued could not check who signed the update.',
};

const BASELINE_POSTURE_COPY: Readonly<Record<ReleaseCheckStatus, string>> = {
  'update-available': 'A newer version is ready now.',
  'up-to-date': 'The update list says this version is the newest.',
  'not-configured': 'This server is not set up to check for updates by itself.',
  'stale-feed': 'This server checks for updates in an old way that ignores the current list.',
  'launcher-outdated': 'The launcher has to be updated first.',
  replay: 'The server ignored an older update list.',
  'fetch-failed': 'The running version is confirmed, but Recued cannot reach the update service.',
  'bad-signature': 'Recued is sure which version is running, but it would not take the update list.',
};

const APPLY_STATUS_COPY: Readonly<Record<UpdateApplyResponse['status'], string>> = {
  applying: 'Downloading and verifying the update — this takes a few minutes. You can leave this page.',
  restarting: 'Updating now. The server will restart and be away for a moment.',
  deferred: "The server is busy, so the update did not start. Try again once it's idle.",
  busy: 'Another update is already in progress.',
  'major-blocked': 'This is a major update — review the notes, then confirm below to proceed.',
  'insufficient-storage': 'Not enough free disk space on the server to apply this update.',
  'download-failed': 'Downloading the update failed.',
  'verify-failed': 'Recued could not check who signed the update it downloaded.',
  'stage-failed': 'Staging the update failed.',
  'not-applicable': 'This install updates via its image or package, not in place.',
  // ⛔ NOT AN ERROR — the offer changed under the card. The server refused rather
  // than spending a confirmation the owner gave for a different version.
  'review-stale': 'A newer release was published while you were reading. Reviewing it now — '
    + 'confirm again to install it.',
  'not-available': 'No installable update is available right now.',
  'not-configured': 'This server is not set up to update itself yet.',
};

const ROLLBACK_STATUS_COPY: Readonly<Record<UpdateRollbackResponse['status'], string>> = {
  'rolled-back': 'Rolled back to the previous version — the server is restarting.',
  refused: 'Rollback refused.',
  busy: 'An update is happening, so you cannot go back right now.',
  'not-configured': "This install can't roll back in place.",
  'not-applicable': 'This install updates via its image or package, not in place.',
};

const MODE_OPTION_LABEL: Readonly<Record<UpdateMode, string>> = {
  auto: 'Automatic — install eligible updates when the server is idle',
  notify: 'Notify only — tell me, but I apply manually',
  off: "Off — don't check or apply",
};

const MODE_SHORT: Readonly<Record<UpdateMode, string>> = {
  auto: 'Automatic',
  notify: 'Notify only',
  off: 'Off',
};

const UPDATE_OWNER_CONFLICT_COPY =
  'Another Recued tab owns the server update action. This tab will follow '
  + 'its progress instead of sending a duplicate request.';
const ROLLBACK_OWNER_CONFLICT_COPY =
  'Another Recued tab owns the server change. This tab will follow its '
  + 'progress instead of sending a duplicate rollback.';

const isUpdateMode = (v: string): v is UpdateMode =>
  v === 'auto' || v === 'notify' || v === 'off';

export const mountUpdatesPage = (opts: MountUpdatesPageOptions): UpdatesPageMount => {
  const doc = opts.document ?? globalThis.document;
  if (doc === undefined) throw new Error('mountUpdatesPage: no document available');
  const { host } = opts;

  const state: UpdatesPageState = {
    phase: 'idle',
    check: null,
    checkError: null,
    applying: false,
    confirmArmed: false,
    applyResult: null,
    updateOutcome: null,
    applyPhase: null,
    applyError: null,
    mode: null,
    modeBusy: false,
    modeError: null,
    rollbackBusy: false,
    rollbackResult: null,
    rollbackError: null,
  };
  let pendingMode: UpdateMode | null = null;
  let queuedPostRestartCheck = false;

  const make = (
    tag: string,
    spec?: { text?: string; className?: string; attrs?: Record<string, string> },
  ): HTMLElement => {
    const node = doc.createElement(tag);
    if (spec?.text !== undefined) node.textContent = spec.text;
    if (spec?.className !== undefined) node.className = spec.className;
    if (spec?.attrs !== undefined) {
      for (const [k, v] of Object.entries(spec.attrs)) node.setAttribute(k, v);
    }
    return node;
  };
  const clear = (node: HTMLElement): void => {
    let child: ChildNode | null;
    while ((child = node.firstChild) !== null) node.removeChild(child);
  };
  const setDisabled = (node: HTMLElement, on: boolean): void => {
    if (on) node.setAttribute('disabled', '');
    else node.removeAttribute('disabled');
  };
  const setHidden = (node: HTMLElement, on: boolean): void => {
    if (on) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
  };
  const focusElement = (node: HTMLElement): void => {
    try {
      (node as HTMLElement & { focus?: () => void }).focus?.();
    } catch {
      // Focus is a usability handoff; constrained DOM hosts may omit it.
    }
  };

  // ── skeleton (built once; render() updates it from state) ────────────
  const root = make('div', { attrs: { [UPDATES_PAGE_ATTR]: '' } });
  const credentialRetryEl = make('section', {
    attrs: { [UPDATES_CREDENTIAL_RETRY_ATTR]: '' },
  });
  const credentialRetryTitleEl = make('h3', {
    text: 'Finish swapping the key',
  });
  credentialRetryEl.appendChild(credentialRetryTitleEl);
  const credentialRetryIdentityEl = make('p', {
    attrs: { [UPDATES_CREDENTIAL_RETRY_IDENTITY_ATTR]: '' },
  });
  credentialRetryEl.appendChild(credentialRetryIdentityEl);
  const credentialRetryStatusEl = make('p', {
    attrs: {
      [UPDATES_CREDENTIAL_RETRY_STATUS_ATTR]: '',
      role: 'status',
      'aria-live': 'polite',
    },
  });
  credentialRetryEl.appendChild(credentialRetryStatusEl);
  const credentialRetryPrivacyEl = make('p', {
    className: 'updates-credential-retry-privacy',
    attrs: { [UPDATES_CREDENTIAL_RETRY_PRIVACY_ATTR]: '' },
  });
  credentialRetryEl.appendChild(credentialRetryPrivacyEl);
  const credentialRetryActions = make('div', {
    className: 'updates-credential-retry-actions',
  });
  const credentialRetryReturn = make('button', {
    text: 'Go back and check now',
    className: 'rx-btn rx-btn-primary',
    attrs: { type: 'button', [UPDATES_CREDENTIAL_RETRY_RETURN_ATTR]: '' },
  });
  credentialRetryReturn.addEventListener('click', () => {
    const marker = opts.credentialRotationServerUpdateContinuity?.read() ?? null;
    if (
      marker === null
      || marker.serverUpdateProgress !== undefined
      || marker.exactReturnActive === true
      || (
        opts.serverUpdateTabConvergence?.readServerUpdateProgress() ?? null
      ) !== null
      || opts.onReturnToCredentialRotationRetry === undefined
    ) {
      return;
    }
    const target = {
      kind: marker.kind,
      name: marker.name,
    };
    if (marker.phase === 'resolved_elsewhere') {
      opts.credentialRotationServerUpdateContinuity
        ?.resumeResolvedRetry(target);
    }
    opts.onReturnToCredentialRotationRetry(target);
  });
  credentialRetryActions.appendChild(credentialRetryReturn);
  const credentialRetryDismiss = make('button', {
    text: 'Not now',
    className: 'rx-btn rx-btn-secondary',
    attrs: { type: 'button', [UPDATES_CREDENTIAL_RETRY_DISMISS_ATTR]: '' },
  });
  credentialRetryDismiss.addEventListener('click', () => {
    const marker = opts.credentialRotationServerUpdateContinuity?.read() ?? null;
    if (
      marker === null
      || marker.serverUpdateProgress !== undefined
      || marker.exactReturnActive === true
      || (
        opts.serverUpdateTabConvergence?.readServerUpdateProgress() ?? null
      ) !== null
    ) return;
    opts.credentialRotationServerUpdateContinuity?.retire({
      kind: marker.kind,
      name: marker.name,
    });
    // Retirement synchronously hides this card. The update check may still be
    // disabled/in flight, so focus the stable version summary instead of
    // guessing at a control that may reject focus.
    focusElement(versionEl);
  });
  credentialRetryActions.appendChild(credentialRetryDismiss);
  credentialRetryEl.appendChild(credentialRetryActions);
  setHidden(credentialRetryEl, true);
  const tabProgressEl = make('section', {
    attrs: {
      [UPDATES_TAB_PROGRESS_ATTR]: '',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
      'aria-busy': 'true',
    },
  });
  const tabProgressTitleEl = make('strong');
  tabProgressEl.appendChild(tabProgressTitleEl);
  const tabProgressStatusEl = make('p', {
    attrs: { [UPDATES_TAB_PROGRESS_STATUS_ATTR]: '' },
  });
  tabProgressEl.appendChild(tabProgressStatusEl);
  const tabProgressPrivacyEl = make('p', {
    attrs: { [UPDATES_TAB_PROGRESS_PRIVACY_ATTR]: '' },
  });
  tabProgressEl.appendChild(tabProgressPrivacyEl);
  setHidden(tabProgressEl, true);
  const receiptRecoveryEl = make('section', {
    attrs: {
      [UPDATES_RECEIPT_RECOVERY_ATTR]: '',
      'aria-labelledby': 'recued-updates-receipt-recovery-title',
    },
  });
  const receiptRecoveryTitleEl = make('strong', {
    attrs: { id: 'recued-updates-receipt-recovery-title' },
  });
  receiptRecoveryEl.appendChild(receiptRecoveryTitleEl);
  const receiptRecoveryStatusEl = make('p');
  receiptRecoveryStatusEl.setAttribute('role', 'status');
  receiptRecoveryStatusEl.setAttribute('aria-live', 'polite');
  receiptRecoveryStatusEl.setAttribute('aria-atomic', 'true');
  receiptRecoveryEl.appendChild(receiptRecoveryStatusEl);
  const receiptRecoveryPrivacyEl = make('p', {
    className: 'updates-credential-retry-privacy',
  });
  receiptRecoveryEl.appendChild(receiptRecoveryPrivacyEl);
  const receiptBaselineEl = make('section', {
    attrs: {
      [UPDATES_RECEIPT_BASELINE_ATTR]: '',
      'aria-label': 'What your server says is true now',
    },
  });
  receiptBaselineEl.appendChild(make('strong', {
    text: 'Current server state',
  }));
  const receiptBaselineVersionEl = make('p');
  receiptBaselineEl.appendChild(receiptBaselineVersionEl);
  const receiptBaselinePostureEl = make('p');
  receiptBaselineEl.appendChild(receiptBaselinePostureEl);
  const receiptBaselineConnectionEl = make('p');
  receiptBaselineEl.appendChild(receiptBaselineConnectionEl);
  const receiptBaselineBoundaryEl = make('p', {
    className: 'updates-credential-retry-privacy',
  });
  receiptBaselineEl.appendChild(receiptBaselineBoundaryEl);
  receiptRecoveryEl.appendChild(receiptBaselineEl);
  setHidden(receiptBaselineEl, true);
  const receiptRecoveryRetry = make('button', {
    text: 'Check the result again',
    className: 'rx-btn rx-btn-secondary',
    attrs: { type: 'button', [UPDATES_RECEIPT_RETRY_ATTR]: '' },
  });
  receiptRecoveryRetry.addEventListener('click', () => {
    opts.serverUpdateReceiptVerification?.retry();
  });
  receiptRecoveryEl.appendChild(receiptRecoveryRetry);
  const receiptClosureReviewButton = make('button', {
    text: 'See how the server finished',
    className: 'rx-btn rx-btn-secondary',
    attrs: {
      type: 'button',
      [UPDATES_RECEIPT_CLOSURE_REVIEW_BUTTON_ATTR]: '',
    },
  });
  receiptClosureReviewButton.addEventListener('click', () => {
    opts.serverUpdateReceiptVerification?.reviewClosure();
    focusElement(receiptClosureReviewTitle);
  });
  receiptRecoveryEl.appendChild(receiptClosureReviewButton);
  const receiptClosureReview = make('section', {
    attrs: {
      [UPDATES_RECEIPT_CLOSURE_REVIEW_ATTR]: '',
      'aria-labelledby': 'recued-updates-receipt-closure-title',
    },
  });
  const receiptClosureReviewTitle = make('strong', {
    text: 'Close recovery as unresolved?',
    attrs: {
      id: 'recued-updates-receipt-closure-title',
      tabindex: '-1',
    },
  });
  receiptClosureReview.appendChild(receiptClosureReviewTitle);
  receiptClosureReview.appendChild(make('p', {
    text:
      'The selected server will re-check this exact receipt and refuse while '
      + 'any server update is active. If it is still unknown, the server will '
      + 'record only that recovery was closed unresolved—not that the update '
      + 'or rollback succeeded.',
  }));
  receiptClosureReview.appendChild(make('p', {
    text:
      'This does not repeat or undo the action. Afterward, verify the current '
      + 'server version and affected state before starting another server change.',
    className: 'updates-credential-retry-privacy',
  }));
  const receiptClosureActions = make('div', {
    className: 'updates-receipt-closure-actions',
  });
  const receiptClosureConfirm = make('button', {
    text: 'Ask server to close recovery',
    className: 'rx-btn rx-btn-primary',
    attrs: {
      type: 'button',
      [UPDATES_RECEIPT_CLOSURE_CONFIRM_ATTR]: '',
    },
  });
  receiptClosureConfirm.addEventListener('click', () => {
    opts.serverUpdateReceiptVerification?.closeUnresolved();
  });
  receiptClosureActions.appendChild(receiptClosureConfirm);
  const receiptClosureCancel = make('button', {
    text: 'Keep receipt open',
    className: 'rx-btn rx-btn-secondary',
    attrs: {
      type: 'button',
      [UPDATES_RECEIPT_CLOSURE_CANCEL_ATTR]: '',
    },
  });
  receiptClosureCancel.addEventListener('click', () => {
    opts.serverUpdateReceiptVerification?.cancelClosureReview();
    focusElement(receiptClosureReviewButton);
  });
  receiptClosureActions.appendChild(receiptClosureCancel);
  receiptClosureReview.appendChild(receiptClosureActions);
  receiptRecoveryEl.appendChild(receiptClosureReview);
  setHidden(receiptClosureReview, true);
  const receiptClosureFinish = make('button', {
    text: 'Finish recovery',
    className: 'rx-btn rx-btn-primary',
    attrs: {
      type: 'button',
      [UPDATES_RECEIPT_CLOSURE_FINISH_ATTR]: '',
    },
  });
  receiptClosureFinish.addEventListener('click', () => {
    const verification = opts.serverUpdateReceiptVerification?.read() ?? null;
    if (verification?.phase === 'completed') {
      const target = exactCompletionTarget(verification);
      if (
        target !== null
        && opts.onReturnToCredentialRotationRetry !== undefined
      ) {
        opts.onReturnToCredentialRotationRetry(target);
        return;
      }
      receiptCompletionDismissRequested = true;
      opts.serverUpdateReceiptVerification?.dismissCompletion();
      return;
    }
    receiptFinishReturnTarget =
      verification?.phase === 'baseline_confirmed'
        ? exactCompletionTarget(verification)
        : null;
    opts.serverUpdateReceiptVerification?.finishClosure();
  });
  receiptRecoveryEl.appendChild(receiptClosureFinish);
  setHidden(receiptClosureFinish, true);
  const receiptDiagnosticEl = make('section', {
    attrs: { [UPDATES_RECEIPT_DIAGNOSTIC_ATTR]: '' },
  });
  const receiptDiagnosticPrivacyEl = make('p');
  receiptDiagnosticEl.appendChild(receiptDiagnosticPrivacyEl);
  const receiptDiagnosticSummaryEl = make('pre', {
    attrs: {
      tabindex: '0',
      'aria-label': 'Privacy-safe server update receipt diagnostic',
    },
  });
  receiptDiagnosticEl.appendChild(receiptDiagnosticSummaryEl);
  const receiptDiagnosticCopy = make('button', {
    text: 'Copy safe diagnostic',
    className: 'rx-btn rx-btn-secondary',
    attrs: {
      type: 'button',
      [UPDATES_RECEIPT_DIAGNOSTIC_COPY_ATTR]: '',
    },
  });
  receiptDiagnosticEl.appendChild(receiptDiagnosticCopy);
  const receiptDiagnosticStatusEl = make('p', {
    attrs: {
      [UPDATES_RECEIPT_DIAGNOSTIC_STATUS_ATTR]: '',
      role: 'status',
      'aria-live': 'polite',
      tabindex: '-1',
    },
  });
  receiptDiagnosticEl.appendChild(receiptDiagnosticStatusEl);
  receiptRecoveryEl.appendChild(receiptDiagnosticEl);
  setHidden(receiptDiagnosticEl, true);
  setHidden(receiptRecoveryEl, true);
  const versionEl = make('p', {
    attrs: { [UPDATES_VERSION_ATTR]: '', tabindex: '-1' },
  });
  // ⛔ THE PAGE SAID WHICH SERVER, NEVER WHICH APP. Checking whether a browser had
  // picked up a web app deploy meant opening DevTools and reading
  // `caches.keys()` (asked 2026-09-28). The service-worker cache name IS the
  // build — it moves on every deploy — so show it as the web app's version.
  const webAppVersionEl = make('p', {
    text: `Web app ${WEBCLIENT_SHELL_CACHE_NAME.replace('webclient-shell-', '')} (this browser)`,
    attrs: { [UPDATES_WEBAPP_VERSION_ATTR]: '' },
  });
  const checkBtn = make('button', {
    text: 'Check for updates',
    className: 'rx-btn rx-btn-secondary',
    attrs: { type: 'button', [UPDATES_CHECK_BTN_ATTR]: '' },
  });
  checkBtn.addEventListener('click', () => void doCheck());
  const statusEl = make('p', { attrs: { [UPDATES_STATUS_ATTR]: '' } });
  const errorEl = make('p', { attrs: { [UPDATES_ERROR_ATTR]: '' } });
  setHidden(errorEl, true);
  const availableEl = make('div', { attrs: { [UPDATES_AVAILABLE_ATTR]: '' } });
  setHidden(availableEl, true);
  const applyResultEl = make('p', { attrs: { [UPDATES_APPLY_RESULT_ATTR]: '' } });
  setHidden(applyResultEl, true);

  const modeBlock = make('div');
  setHidden(modeBlock, true);
  const modeLabel = make('label', { text: 'When updates are available' });
  const modeSelect = doc.createElement('select') as HTMLSelectElement;
  modeSelect.setAttribute(UPDATES_MODE_SELECT_ATTR, '');
  for (const m of ['auto', 'notify', 'off'] as const) {
    const opt = doc.createElement('option') as HTMLOptionElement;
    opt.value = m;
    opt.textContent = MODE_OPTION_LABEL[m];
    modeSelect.appendChild(opt);
  }
  modeSelect.addEventListener('change', () => {
    const v = modeSelect.value;
    if (
      state.modeBusy
      || readServerUpdateProgress() !== null
      || state.mode?.env_locked === true
      || opts.runSetMode === undefined
    ) {
      modeSelect.value = pendingMode ?? state.mode?.mode ?? '';
      return;
    }
    if (isUpdateMode(v)) void doSetMode(v);
  });
  modeLabel.appendChild(modeSelect);
  modeBlock.appendChild(modeLabel);
  const modeNoteEl = make('p', { attrs: { [UPDATES_MODE_NOTE_ATTR]: '' } });
  modeBlock.appendChild(modeNoteEl);

  const rollbackBlock = make('div');
  rollbackBlock.appendChild(
    make('p', {
      // ⛔ CONDITIONAL, NOT A PROMISE. This said the snapshot "is restored" flatly,
      // regardless of whether the applied release migrated anything or whether a
      // snapshot exists at all — and a snapshot-restoring rollback is REFUSED
      // from here anyway (it cannot replace the database file under a live
      // server; that one is a stopped-server CLI operation). Promising it on the
      // surface that cannot do it is the worst of both.
      text: 'If a recent update caused problems, you can return to the previous version. '
        + 'If that update migrated the database, restoring its pre-update snapshot has to be '
        + 'done with the server stopped: recued update rollback.',
    }),
  );
  const rollbackBtn = make('button', {
    text: 'Roll back to previous version',
    className: 'rx-btn rx-btn-danger',
    attrs: { type: 'button', [UPDATES_ROLLBACK_BTN_ATTR]: '' },
  });
  rollbackBtn.addEventListener('click', () => void doRollback());
  rollbackBlock.appendChild(rollbackBtn);
  const rollbackResultEl = make('p', { attrs: { [UPDATES_ROLLBACK_RESULT_ATTR]: '' } });
  setHidden(rollbackResultEl, true);
  rollbackBlock.appendChild(rollbackResultEl);

  root.appendChild(credentialRetryEl);
  root.appendChild(tabProgressEl);
  root.appendChild(receiptRecoveryEl);
  root.appendChild(versionEl);
  root.appendChild(webAppVersionEl);
  root.appendChild(checkBtn);
  root.appendChild(statusEl);
  root.appendChild(errorEl);
  root.appendChild(availableEl);
  root.appendChild(applyResultEl);
  root.appendChild(modeBlock);
  root.appendChild(rollbackBlock);
  host.appendChild(root);

  let disposed = false;
  /** Held across an ASYNC apply. The rpc returns `applying` and the run is still
   *  going, so the ownership lease must outlive the call that started it and be
   *  released by the terminal `update.progress` emit instead. */
  let pendingApplyLease: CredentialRotationOwnershipLease | null = null;
  /** Rollback can restart the server before its rpc reply arrives. Disposal must
   * therefore own this lease from dispatch onward, just as it owns apply's. */
  let pendingRollbackLease: CredentialRotationOwnershipLease | null = null;
  /** The shared-progress lineage this page owns across an ASYNC apply. Captured
   *  when the apply starts and cleared by the terminal `update.progress` event —
   *  which is the only place that knows the run is over. */
  let pendingApplyProgress: ServerUpdateTabProgress | null = null;
  /** The release the running apply installs, so a reconnect can tell whether
   *  it landed without a receipt (see `confirmUpdateLanded`). */
  let applyingToVersion: string | null = null;
  /** True only between dispatch and the apply rpc reply. Progress is parked
   * before dispatch so disposal can own it; it can no longer double as this
   * ordering sentinel for a terminal that beats acceptance. */
  let applyAcceptancePending = false;
  /** An older async server may mint its own id and emit the terminal before its
   * rpc reply tells us that id. Hold one mismatch only across that response
   * window; the reply either binds it to this run or proves it belongs elsewhere. */
  let deferredUpdateTerminal: UpdateProgressEvent | null = null;
  let receiptDiagnosticCopyInFlight = false;
  let receiptDiagnosticGeneration = 0;
  let receiptDiagnosticKey: string | null = null;
  let receiptRecoveryExposed = false;
  let receiptFinishReturnTarget:
    CredentialRotationServerUpdateTarget | null = null;
  let receiptCompletionDismissRequested = false;

  receiptDiagnosticCopy.addEventListener('click', () => {
    const verification = opts.serverUpdateReceiptVerification?.read() ?? null;
    const writer = opts.serverUpdateReceiptDiagnosticWriter;
    const summary = receiptDiagnosticSummaryEl.textContent;
    if (
      disposed
      || (
        verification?.phase !== 'unknown'
        && verification?.phase !== 'retryable'
        && verification?.phase !== 'baseline_retryable'
      )
      || writer === undefined
      || summary.length === 0
      || receiptDiagnosticCopyInFlight
    ) return;
    const generation = ++receiptDiagnosticGeneration;
    receiptDiagnosticCopyInFlight = true;
    receiptDiagnosticStatusEl.textContent =
      'Copying the reviewed diagnostic…';
    render();
    const showFailure = (): void => {
      if (disposed || generation !== receiptDiagnosticGeneration) return;
      receiptDiagnosticCopyInFlight = false;
      receiptDiagnosticStatusEl.textContent =
        'Recued could not copy it. The summary is selected, so you can copy it yourself.';
      render();
      focusElement(receiptDiagnosticSummaryEl);
    };
    let write: Promise<void>;
    try {
      write = writer(summary);
    } catch {
      showFailure();
      return;
    }
    void write.then(
      () => {
        if (disposed || generation !== receiptDiagnosticGeneration) return;
        receiptDiagnosticCopyInFlight = false;
        receiptDiagnosticStatusEl.textContent =
          'Safe diagnostic copied. Nothing was sent automatically.';
        render();
        focusElement(receiptDiagnosticStatusEl);
      },
      showFailure,
    );
  });

  const readServerUpdateProgress = (): ServerUpdateTabProgress | null =>
    opts.serverUpdateTabConvergence?.readServerUpdateProgress()
    ?? opts.credentialRotationServerUpdateContinuity
      ?.read()?.serverUpdateProgress
    ?? null;
  let lastObservedServerUpdateProgress = readServerUpdateProgress();

  const exactCompletionTarget = (
    verification: ServerUpdateReceiptVerificationState,
  ): CredentialRotationServerUpdateTarget | null => {
    if (opts.onReturnToCredentialRotationRetry === undefined) return null;
    const affected = verification.baseline?.affectedConnection;
    const marker =
      opts.credentialRotationServerUpdateContinuity?.read() ?? null;
    if (
      affected === undefined
      || marker === null
      || marker.kind !== affected.kind
      || marker.name !== affected.name
      || (
        verification.phase === 'completed'
        && (
          marker.phase !== 'ready'
          || marker.serverUpdateVerification?.phase !== 'completed'
        )
      )
    ) return null;
    return { kind: affected.kind, name: affected.name };
  };

  const clearServerUpdateProgress = async (
    expected: ServerUpdateTabProgress | null,
  ): Promise<void> => {
    const convergence = opts.serverUpdateTabConvergence;
    if (convergence !== undefined && expected !== null) {
      await convergence.clearServerUpdateProgress(expected);
    }
  };

  /** Return the current shared latch only when it is still the exact applying
   * lineage this route created. A route-disposal reply may refine that lineage,
   * but it must never recreate one bootstrap cleared or overwrite a successor. */
  const exactOwnedApplyingProgress = (
    owned: ServerUpdateTabProgress | null,
  ): ServerUpdateTabProgress | null => {
    const current = readServerUpdateProgress();
    return current !== null
      && owned !== null
      && current.phase === 'applying'
      && current.operation === owned.operation
      && current.startedAt === owned.startedAt
      && current.operationId === owned.operationId
      ? current
      : null;
  };

  const progressOperationCopy = (
    operation: ServerUpdateOperation,
  ): string => operation === 'update' ? 'update' : 'rollback';

  const renderTabProgress = (): ServerUpdateTabProgress | null => {
    const progress = readServerUpdateProgress();
    const targetedRetry =
      opts.credentialRotationServerUpdateContinuity?.read() ?? null;
    if (progress === null || targetedRetry !== null) {
      setHidden(tabProgressEl, true);
      tabProgressEl.removeAttribute('data-phase');
      tabProgressEl.removeAttribute('data-operation');
      tabProgressTitleEl.textContent = '';
      tabProgressStatusEl.textContent = '';
      tabProgressPrivacyEl.textContent = '';
      // The exact retry card absorbs presentation, but the page remains busy:
      // Check/mode/rollback must not merely look actionable while their
      // scripted handlers are correctly refusing the same shared operation.
      return progress;
    }
    const operation = progressOperationCopy(progress.operation);
    setHidden(tabProgressEl, false);
    tabProgressEl.setAttribute('data-phase', progress.phase);
    tabProgressEl.setAttribute('data-operation', progress.operation);
    if (progress.phase === 'applying') {
      tabProgressEl.setAttribute('aria-busy', 'true');
      tabProgressTitleEl.textContent =
        `${progress.operation === 'update' ? 'Server update' : 'Server rollback'} in progress`;
      tabProgressStatusEl.textContent = state.applying || state.rollbackBusy
        ? `This tab is applying the server ${operation}. Other open Recued tabs will follow its progress without sending a duplicate request.`
        : `An open Recued tab is applying this ${operation}. This tab will wait instead of sending a duplicate request.`;
    } else {
      const verification = opts.serverUpdateReceiptVerification?.read() ?? null;
      const exactVerification =
        verification?.operation === progress.operation
        && verification.startedAt === progress.startedAt
          ? verification
          : null;
      const checkingReceipt = progress.operationId !== undefined
        && opts.serverConnectionStatus?.status() === 'connected'
        && (
          exactVerification === null
          || exactVerification.phase === 'checking'
        );
      if (
        exactVerification?.phase === 'retryable'
        || exactVerification?.phase === 'unknown'
        || exactVerification?.phase === 'baseline_retryable'
        || exactVerification?.phase === 'baseline_confirmed'
        || exactVerification?.phase === 'closed'
      ) tabProgressEl.setAttribute('aria-busy', 'false');
      else tabProgressEl.setAttribute('aria-busy', 'true');
      // ⛔⛔ ONE USER-FACING STATE PER OUTCOME, NOT ONE PER INTERNAL PHASE. This
      // was a nested ternary over eleven receipt/baseline phases, and it narrated
      // vocabulary no owner has: "the exact receipt", "a fresh current-state
      // baseline", "retiring only this browser recovery latch", "durably closed".
      // Reported 2026-08-31 — the owner watched it say nothing was needed while
      // nothing progressed, beside three greyed buttons, and could not tell what
      // to do. The machinery below is unchanged and still correct; it simply
      // stopped being the thing the screen is about.
      //
      // 🔑 Three states, because three is what an owner can act on: it is
      // working, it is checking, or it needs you. Everything finer is why the
      // recovery controls exist — those still render, and they carry their own
      // labels for the case where one is actually needed.
      const needsAttention = exactVerification !== null
        && !RECEIPT_SELF_RESOLVING_PHASES.has(exactVerification.phase);
      const opLabel = progress.operation === 'update' ? 'Update' : 'Rollback';

      tabProgressTitleEl.textContent = needsAttention
        ? `${opLabel} needs attention`
        : checkingReceipt
          ? `Confirming the ${operation}`
          : `${opLabel} in progress`;

      tabProgressStatusEl.textContent = needsAttention
        ? `Recued could not confirm how this ${operation} finished. It was not repeated, `
          + 'and nothing else can start until it is resolved — use the controls below.'
        : checkingReceipt
          ? `Reconnected. Checking that the ${operation} finished before re-enabling server controls.`
          : `The server is applying the ${operation} and will restart itself. Keep this tab `
            + 'open — it reconnects on its own, and this can take a few minutes.';
    }
    tabProgressPrivacyEl.textContent =
      'Tabs pass each other only a meaningless id for the server you picked, '
      + 'what is happening, how far it has got, and when it started. Keys, '
      + 'connection details, addresses, what you typed, version numbers and '
      + 'raw errors are never passed on. If you say yes to something, only a '
      + 'meaningless receipt from your server is added.';
    return progress;
  };

  const renderAvailable = (): void => {
    const active = (doc as Document & { activeElement?: Element | null })
      .activeElement;
    const restoreApplyFocus =
      active?.hasAttribute?.(UPDATES_APPLY_BTN_ATTR) === true;
    const restoreForceApplyFocus =
      active?.hasAttribute?.(UPDATES_FORCE_APPLY_BTN_ATTR) === true;
    clear(availableEl);
    // The "available" card reflects the LATEST authoritative signal, not just the
    // last stored check: hide it when the most recent check FAILED (phase
    // 'error') or when an apply proved the update is no longer installable —
    // otherwise a cleared rail badge could disagree with a still-visible "Update
    // now" card (Codex F1/F2).
    const applyProvedNoUpdate =
      state.applyResult !== null
      && (state.applyResult.status === 'not-available'
        || state.applyResult.status === 'not-applicable'
        || state.applyResult.status === 'not-configured');
    const a =
      state.phase !== 'error' && !applyProvedNoUpdate && state.check?.status === 'update-available'
        ? state.check.available
        : undefined;
    if (a === undefined) {
      setHidden(availableEl, true);
      if (restoreApplyFocus || restoreForceApplyFocus) focusElement(versionEl);
      return;
    }
    setHidden(availableEl, false);
    availableEl.appendChild(make('p', { text: `Version ${a.version} is available.` }));
    if (a.below_min_supported) {
      availableEl.appendChild(
        make('p', { text: '⚠ Your version is below the minimum supported — updating is urgent.' }),
      );
    }
    if (a.migration) {
      availableEl.appendChild(
        make('p', {
          text: 'This release migrates the database on first boot (a snapshot is taken first, so it can be rolled back).',
        }),
      );
    }
    if (a.is_major) {
      availableEl.appendChild(make('p', { text: 'This is a major version update.' }));
    }
    const docker = state.check?.docker;
    if (docker) {
      availableEl.appendChild(make('p', {
        text: docker.artifact === 'docker-baked'
          ? 'This server is updated by recreating it from the signed image digest:'
          : 'Signed recovery image for this release:',
      }));
      const pullRef = make('code', { text: docker.pull_ref });
      pullRef.setAttribute('data-update-docker-pull-ref', '');
      availableEl.appendChild(pullRef);
    }
    if (a.notes_url.length > 0) {
      const link = make('a', { text: 'Release notes' });
      link.setAttribute('href', a.notes_url);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      availableEl.appendChild(link);
    }
    // A baked container cannot apply a host registry image in-place. The exact
    // digest above is the action; rendering a disabled "Update now" control
    // makes that delegated path look broken rather than intentionally external.
    if (docker?.artifact === 'docker-baked') {
      if (restoreApplyFocus || restoreForceApplyFocus) focusElement(versionEl);
      return;
    }
    // ⛔ EVERY UPDATE ASKS ONCE, IN THE SAME WORDS: Update to <version> →
    // Confirm update → Updating…. A release this server had not been offered
    // yet used to say "Update now — install early?" under a paragraph about
    // staged rollout (0%) and cohorts, while any other release installed on one
    // click. The owner, 2026-09-28: "no one built an app with that message or
    // flow". The confirm click is still the consent the server needs for such a
    // release (`confirm_rollout`, sent from doApply); it just is not narrated.
    const armed = state.confirmArmed && !state.applying;
    const applyBtn = make('button', {
      text: state.applying
        ? 'Updating…'
        : readServerUpdateProgress() !== null
          ? 'Update already in progress'
          : armed
            ? 'Confirm update'
            : `Update to ${a.version}`,
      className: 'rx-btn rx-btn-primary',
      attrs: { type: 'button', [UPDATES_APPLY_BTN_ATTR]: '' },
    });
    if (armed) applyBtn.setAttribute(UPDATES_APPLY_CONFIRM_ATTR, '');
    const localApplyPending = state.applying;
    const serverActionElsewhere =
      !localApplyPending && readServerUpdateProgress() !== null;
    setDisabled(
      applyBtn,
      serverActionElsewhere
        || opts.runApply === undefined,
    );
    if (localApplyPending) {
      applyBtn.setAttribute('aria-disabled', 'true');
      applyBtn.setAttribute('aria-busy', 'true');
    }
    applyBtn.addEventListener('click', () => {
      // "Updating…" is only aria-disabled (it keeps focus), so it still takes
      // clicks. One of those must not arm the NEXT update while this one runs,
      // or the button comes back as "Confirm update" instead of starting over.
      if (state.applying) return;
      if (!state.confirmArmed) {
        // Ask, do not apply. Re-render so the button says what the next click
        // will do rather than silently changing meaning.
        state.confirmArmed = true;
        render();
        return;
      }
      void doApply(false);
    });
    availableEl.appendChild(applyBtn);
    if (armed && !serverActionElsewhere) {
      const cancelBtn = make('button', {
        text: 'Cancel',
        className: 'rx-btn',
        attrs: { type: 'button', [UPDATES_APPLY_CANCEL_ATTR]: '' },
      });
      cancelBtn.addEventListener('click', () => {
        state.confirmArmed = false;
        render();
      });
      availableEl.appendChild(cancelBtn);
    }
    // The server refuses a major bump until forced; surface an explicit confirm.
    let forceBtn: HTMLElement | null = null;
    if (state.applyResult?.status === 'major-blocked') {
      forceBtn = make('button', {
        text: 'Update anyway (major)',
        className: 'rx-btn rx-btn-danger',
        attrs: { type: 'button', [UPDATES_FORCE_APPLY_BTN_ATTR]: '' },
      });
      setDisabled(
        forceBtn,
        serverActionElsewhere,
      );
      if (localApplyPending) {
        forceBtn.setAttribute('aria-disabled', 'true');
        forceBtn.setAttribute('aria-busy', 'true');
      }
      forceBtn.addEventListener('click', () => void doApply(true));
      availableEl.appendChild(forceBtn);
    }
    if (restoreApplyFocus) focusElement(applyBtn);
    else if (restoreForceApplyFocus) {
      // A terminal force result removes its one-shot control. Return to the
      // ordinary action when it remains available instead of dropping focus
      // into the document body during the rebuild.
      if (forceBtn !== null) focusElement(forceBtn);
      else if (!applyBtn.hasAttribute('disabled')) focusElement(applyBtn);
      else focusElement(versionEl);
    }
  };

  const renderCredentialRetry = (): void => {
    const marker = opts.credentialRotationServerUpdateContinuity?.read() ?? null;
    if (marker === null) {
      setHidden(credentialRetryEl, true);
      credentialRetryEl.removeAttribute('data-phase');
      credentialRetryEl.removeAttribute('aria-busy');
      credentialRetryIdentityEl.textContent = '';
      credentialRetryStatusEl.textContent = '';
      return;
    }
    if (
      marker.serverUpdateVerification?.phase === 'completed'
      && exactCompletionTarget(marker.serverUpdateVerification) !== null
    ) {
      // The completion receipt owns the exact next action. Keeping the older
      // generic retry card beside it would offer the same route twice with
      // weaker context.
      setHidden(credentialRetryEl, true);
      credentialRetryEl.removeAttribute('data-phase');
      credentialRetryEl.removeAttribute('aria-busy');
      credentialRetryIdentityEl.textContent = '';
      credentialRetryStatusEl.textContent = '';
      return;
    }

    setHidden(credentialRetryEl, false);
    credentialRetryEl.setAttribute('data-phase', marker.phase);
    const resolvedElsewhere = marker.phase === 'resolved_elsewhere';
    const checkingReturn = marker.phase === 'checking_return';
    const cleanEditorReady = marker.phase === 'editor_ready';
    const exactReturnActive = marker.exactReturnActive === true;
    const progress = marker.serverUpdateProgress ?? readServerUpdateProgress();
    const verification = opts.serverUpdateReceiptVerification?.read() ?? null;
    const exactVerification = progress?.phase === 'awaiting_reconnect'
      && verification?.operation === progress.operation
      && verification.startedAt === progress.startedAt
      ? verification
      : null;
    if (exactReturnActive) {
      credentialRetryEl.setAttribute('aria-busy', 'true');
    } else if (
      progress === null
      || exactVerification?.phase === 'retryable'
      || exactVerification?.phase === 'unknown'
      || exactVerification?.phase === 'closed'
      || exactVerification?.phase === 'baseline_retryable'
      || exactVerification?.phase === 'baseline_confirmed'
    ) credentialRetryEl.removeAttribute('aria-busy');
    else credentialRetryEl.setAttribute('aria-busy', 'true');
    const checkingReceipt = progress?.phase === 'awaiting_reconnect'
      && progress.operationId !== undefined
      && opts.serverConnectionStatus?.status() === 'connected'
      && (
        exactVerification === null
        || exactVerification.phase === 'checking'
      );
    credentialRetryTitleEl.textContent = progress !== null
      ? progress.phase === 'applying'
        ? 'Server change is in progress'
        : exactVerification?.phase === 'checking_baseline'
          ? 'Checking how the server is'
          : exactVerification?.phase === 'baseline_retryable'
            ? 'Recued could not check how the server is'
            : exactVerification?.phase === 'baseline_confirmed'
              ? exactVerification.reason === 'finish_unavailable'
                ? 'Checked. Finishing needs another go'
                : 'Checked how the server is'
              : exactVerification?.phase === 'closed'
                ? 'Closed. Now check how things are'
        : exactVerification?.phase === 'retryable'
          ? 'Server did not give a clear answer'
          : exactVerification?.phase === 'unknown'
            ? 'Server result needs a look'
            : exactVerification?.phase === 'waiting'
              ? 'Confirming the server result'
              : checkingReceipt
                ? 'Checking the server restart'
                : 'Waiting for the server to restart'
      : resolvedElsewhere
      ? 'The key check is ready'
      : checkingReturn
      ? exactReturnActive
        ? 'Checking the key'
        : 'Carry on checking the key'
      : cleanEditorReady
      ? 'Carry on replacing the key'
      : 'Finish swapping the key';
    credentialRetryIdentityEl.textContent = `${marker.kind}/${marker.name}`;
    const durable =
      opts.credentialRotationServerUpdateContinuity?.isDurable() === true;
    credentialRetryPrivacyEl.textContent = progress !== null
      ? 'Tabs pass each other only a meaningless id for the server you picked, '
        + 'what is happening, how far it has got, and when it started. This '
        + 'try stays in this tab. Keys, connection details, addresses, what '
        + 'you typed, version numbers and raw errors are never passed on. '
        + 'Once you say yes, only a meaningless receipt from your server is '
        + 'added, so a reload can check what really happened.'
      : resolvedElsewhere
      ? 'This is kept only in this tab and is gone after a '
        + 'reload. No new key, typed value, or server setting was saved or sent.'
      : checkingReturn
      ? durable
        ? 'Coming back here keeps only the id of the server you picked, which '
          + 'connection it was, the time, how far the safety check got, and '
          + 'which version was running before. Keys, what you typed, what was '
          + 'true before, and the one-time finish receipt are not kept, and '
          + 'are never done again.'
        : 'This browser could not save your place for a reload. Keep this tab '
          + 'open. Keys, what you typed, what was true before, and the '
          + 'one-time finish receipt are still not kept, and never done again.'
      : cleanEditorReady
      ? durable
        ? 'This keeps only the id of the server you picked, which connection '
          + 'it was, the time, and that a blank form is ready. Keys, what you '
          + 'typed, what was true before, and the receipt from your server '
          + 'are not kept, and are never done again.'
        : 'This browser could not save your place for a reload. No key, '
          + 'nothing you typed, nothing about what was true before, and no '
          + 'receipt was kept.'
      : durable
      ? 'For a reload, this tab keeps only a meaningless id for the server you '
        + 'picked, which connection it was, the time, and safe notes about the '
        + 'server version and update. New keys, what you typed, raw errors and '
        + 'server settings are never kept here.'
      : 'This browser could not save your place for a reload. Keep this tab '
        + 'open. New keys, what you typed, raw errors and server settings are '
        + 'still never kept here.';
    const retainedCopy = durable
      ? 'The exact retry remains saved.'
      : 'Keep this tab open. Nothing is saved for a reload.';
    const connection: WebclientConnectionStatus | null =
      opts.serverConnectionStatus?.status() ?? null;
    const connected = connection === 'connected';

    if (progress?.phase === 'applying') {
      credentialRetryStatusEl.textContent =
        `An open Recued tab is applying the server ${progressOperationCopy(progress.operation)}. `
        + 'Your try stays saved, and Recued will not do the same thing twice '
        + 'will be sent from this tab.';
      credentialRetryReturn.textContent = 'Update in progress…';
    } else if (progress?.phase === 'awaiting_reconnect') {
      credentialRetryStatusEl.textContent =
        exactVerification?.phase === 'checking_baseline'
          ? `Recued is reading this server’s current version and release posture before returning to ${marker.kind}/${marker.name}. The original ${progressOperationCopy(progress.operation)} result is still unknown.`
          : exactVerification?.phase === 'baseline_retryable'
            ? 'Recued could not read what is true now, and nothing was changed. Try again below. Swapping the key, and everything that changes the server, stays paused.'
            : exactVerification?.phase === 'baseline_confirmed'
              ? exactVerification.reason === 'finish_unavailable'
                ? `Recued still knows how the server is, but this browser could not finish tidying up. Choose Finish below before you go back to ${marker.kind}/${marker.name}; no server action will repeat.`
                : `A fresh server baseline is ready to review below, including the current activity state for ${marker.kind}/${marker.name}. The original ${progressOperationCopy(progress.operation)} result is still unknown.`
              : exactVerification?.phase === 'closed'
                ? 'The server finished the receipt that was left open. Check its version, whether it wants updating, and what this connection has been doing, before you go back to swapping the key.'
        : exactVerification?.phase === 'waiting'
          ? exactVerification.reason === 'restart_pending'
            ? `The server is still finishing the ${progressOperationCopy(progress.operation)} restart. Recued will check that exact receipt again by itself, and your try stays saved.`
            : `Recued could not get the answer just now. It will try again by itself, and your try stays saved.`
          : exactVerification?.phase === 'retryable'
            ? `Several safe checks could not confirm the server ${progressOperationCopy(progress.operation)}. Use the result below; this credential retry and all server controls remain paused.`
            : exactVerification?.phase === 'unknown'
              ? `The paired server could not safely resolve the ${progressOperationCopy(progress.operation)} receipt. Check you picked the right server, then use the hand-over below.`
              : connected
                ? progress.operationId === undefined
                  ? `The server ${progressOperationCopy(progress.operation)} was accepted. Waiting to observe the restart before checking this connection again.`
                  : `This tab is connected and is checking the server-issued restart receipt before checking this connection again.`
                : progress.operationId === undefined
                  ? `The server is restarting after the ${progressOperationCopy(progress.operation)}. This tab will verify its own reconnect before checking this connection again.`
                  : `The server is restarting after the ${progressOperationCopy(progress.operation)}. This tab will check the server-issued restart receipt when it reconnects.`;
      credentialRetryReturn.textContent = connected
        ? 'Waiting for restart…'
        : 'Waiting for server…';
    } else if (checkingReturn) {
      credentialRetryStatusEl.textContent = exactReturnActive
        ? `Connections is checking what this key has been doing for ${marker.kind}/${marker.name}, then re-reading the latest saved connection. This page will not start a duplicate check.`
        : `The return to ${marker.kind}/${marker.name} stopped before Recued finished its checks. Carry on to run those look-only checks again.`;
      credentialRetryReturn.textContent = exactReturnActive
        ? 'Checking…'
        : connected
          ? 'Carry on checking'
          : 'Resume when connected';
    } else if (cleanEditorReady) {
      credentialRetryStatusEl.textContent = connected
        ? `The safe checks opened a clean editor for ${marker.kind}/${marker.name}, but it closed before any field changed. Resume to repeat the read-only safety check and reopen it.`
        : `The untouched clean editor for ${marker.kind}/${marker.name} is saved only as where to go back to. Reconnect to run the safety check again. Nothing you typed comes back.`;
      credentialRetryReturn.textContent = connected
        ? 'Reopen the fresh editor'
        : 'Resume when connected';
    } else if (resolvedElsewhere) {
      credentialRetryStatusEl.textContent = connected
        ? 'A look-only check says this server can safely check your new key. This tab stayed on Server Updates and did not open a form for keys. Carry on here when you are ready to read that exact server and saved connection again.'
        : 'A fresh check confirmed support, but this tab cannot reach the selected server now. Keep this tab open to continue after reconnecting.';
      credentialRetryReturn.textContent = connected
        ? 'Continue in this tab'
        : 'Waiting for server…';
    } else if (marker.phase === 'triage') {
      credentialRetryStatusEl.textContent = connected
        ? 'The server you came back to still cannot do the safety check. Once you have sorted out that exact server, run the check again. What Recued worked out before is still in Account.'
        : `The diagnosis is saved, but this tab cannot reach the selected server now. ${retainedCopy}`;
      credentialRetryReturn.textContent = connected
        ? 'Check the server again'
        : 'Waiting for server…';
    } else if (marker.phase === 'awaiting_reconnect') {
      credentialRetryStatusEl.textContent = connected
        ? 'The update was accepted. Waiting for this server to restart before retrying.'
        : 'The server is restarting. The exact retry will unlock when this tab reconnects.';
      credentialRetryReturn.textContent = connected
        ? 'Waiting for restart…'
        : 'Waiting for server…';
    } else if (marker.phase === 'ready') {
      credentialRetryStatusEl.textContent = connected
        ? 'The server is back. Go back to run the key check.'
        : `The server reconnected once, but this tab cannot reach it now. ${retainedCopy}`;
      credentialRetryReturn.textContent = connected
        ? 'Go back and check'
        : 'Waiting for server…';
    } else {
      credentialRetryStatusEl.textContent = connected
        ? 'Update or restart this server, then come back and let it check for itself.'
        : connection === null
          ? `This tab cannot confirm the server connection yet. ${retainedCopy}`
          : `Waiting for this server to reconnect. ${retainedCopy}`;
      credentialRetryReturn.textContent = connected
        ? 'Go back and check now'
        : 'Waiting for server…';
    }

    const canReturn = connected
      && progress === null
      && marker.phase !== 'awaiting_reconnect'
      && !exactReturnActive
      && opts.onReturnToCredentialRotationRetry !== undefined;
    setDisabled(credentialRetryReturn, !canReturn);
    credentialRetryReturn.setAttribute(
      'aria-label',
      exactReturnActive
        ? `The key check for ${marker.kind}/${marker.name} is already running under Connections`
      : canReturn
        ? checkingReturn
          ? `Carry on the key check for ${marker.kind}/${marker.name}`
          : cleanEditorReady
          ? `Reopen the fresh key editor for ${marker.kind}/${marker.name} after running its safety check again`
          : resolvedElsewhere
          ? `Carry on checking the new key for ${marker.kind}/${marker.name} in this tab`
          : marker.phase === 'triage'
          ? `Check the server features again for ${marker.kind}/${marker.name}`
          : `Return to ${marker.kind}/${marker.name} and check the updated server`
        : `Waiting for the server used by ${marker.kind}/${marker.name} before checking again`,
    );
    credentialRetryDismiss.textContent = progress !== null
      ? 'Update in progress'
      : exactReturnActive
        ? 'Checking'
        : resolvedElsewhere
        ? 'Dismiss'
        : 'Not now';
    setDisabled(
      credentialRetryDismiss,
      progress !== null || exactReturnActive,
    );
  };

  const renderReceiptRecovery = (): void => {
    const verification = opts.serverUpdateReceiptVerification?.read() ?? null;
    if (
      verification === null
      || RECEIPT_SELF_RESOLVING_PHASES.has(verification.phase)
    ) {
      if (verification === null) receiptRecoveryExposed = false;
      setHidden(receiptRecoveryEl, true);
      // ⚠ `data-phase` DESCRIBES STATE, NOT VISIBILITY — keep it accurate while
      // the panel is hidden. It is how the latch is observed (a restored receipt
      // must stay pinned across a reconnect), and clearing it on the normal path
      // made "no panel" indistinguishable from "no receipt". Only a genuinely
      // absent verification clears it.
      if (verification === null) {
        receiptRecoveryEl.removeAttribute('data-phase');
        receiptRecoveryEl.removeAttribute('aria-busy');
      } else {
        receiptRecoveryEl.setAttribute('data-phase', verification.phase);
        // Inert on a hidden node, but it is the state marker the latch is read
        // through; `hidden` is what says "do not show this", not these two.
        receiptRecoveryEl.setAttribute('aria-busy', 'true');
      }
      receiptRecoveryTitleEl.textContent = '';
      receiptRecoveryStatusEl.textContent = '';
      receiptRecoveryPrivacyEl.textContent = '';
      // ⚠ The retry too. The early return skips the block that normally decides
      // this button's visibility, so without it the control keeps whatever state
      // the last problem-phase render left — invisible only because its container
      // is hidden. Reset every child on the way out, not all-but-one.
      setHidden(receiptRecoveryRetry, true);
      setHidden(receiptClosureReviewButton, true);
      setHidden(receiptClosureReview, true);
      setHidden(receiptClosureFinish, true);
      setHidden(receiptBaselineEl, true);
      receiptBaselineVersionEl.textContent = '';
      receiptBaselinePostureEl.textContent = '';
      receiptBaselineConnectionEl.textContent = '';
      receiptBaselineBoundaryEl.textContent = '';
      setHidden(receiptDiagnosticEl, true);
      receiptDiagnosticSummaryEl.textContent = '';
      if (receiptDiagnosticKey !== null) {
        receiptDiagnosticGeneration += 1;
        receiptDiagnosticCopyInFlight = false;
        receiptDiagnosticStatusEl.textContent = '';
        receiptDiagnosticKey = null;
      }
      return;
    }
    if (verification.phase !== 'checking') receiptRecoveryExposed = true;
    setHidden(receiptRecoveryEl, false);
    receiptRecoveryEl.setAttribute('data-phase', verification.phase);
    if (
      verification.phase === 'checking'
      || verification.phase === 'waiting'
      || verification.phase === 'closing'
      || verification.phase === 'checking_baseline'
      || verification.phase === 'finishing'
    ) {
      receiptRecoveryEl.setAttribute('aria-busy', 'true');
    } else {
      receiptRecoveryEl.removeAttribute('aria-busy');
    }
    const operation = progressOperationCopy(verification.operation);
    const connected = opts.serverConnectionStatus?.status() === 'connected';
    const reviewedTarget =
      verification.phase === 'baseline_confirmed'
      || verification.phase === 'completed'
        ? exactCompletionTarget(verification)
        : null;
    const completionTarget = verification.phase === 'completed'
      ? reviewedTarget
      : null;
    if (verification.phase === 'checking') {
      receiptRecoveryTitleEl.textContent = `Checking ${operation} receipt`;
      receiptRecoveryStatusEl.textContent =
        `Recued is checking the existing opaque receipt. It will not send the ${operation} again.`;
    } else if (verification.phase === 'waiting') {
      receiptRecoveryTitleEl.textContent = `Confirming ${operation} result`;
      receiptRecoveryStatusEl.textContent =
        verification.reason === 'restart_pending'
          ? `The paired server says this ${operation} is still finishing its restart. Recued will check that exact receipt again by itself.`
          : `Recued could not get the answer just now. It will try again by itself, and the ${operation} will not be sent twice.`;
    } else if (verification.phase === 'retryable') {
      receiptRecoveryTitleEl.textContent = `Couldn’t confirm ${operation}`;
      receiptRecoveryStatusEl.textContent =
        `Several safe checks could not confirm the exact ${operation} receipt. Automatic retries stopped; server controls remain paused until the paired server resolves it.`;
    } else if (verification.phase === 'reviewing_closure') {
      receiptRecoveryTitleEl.textContent = 'Look at closing this unanswered result';
      receiptRecoveryStatusEl.textContent =
        `Review what the selected server will prove and record before retiring this unresolved ${operation} receipt. Controls remain paused.`;
    } else if (verification.phase === 'closing') {
      receiptRecoveryTitleEl.textContent = 'The server is checking it is safe to close';
      receiptRecoveryStatusEl.textContent =
        'The server you picked is checking that exact receipt again, checking '
        + 'that no update is under way, and getting ready to remember that this was left open.';
    } else if (verification.phase === 'closed') {
      receiptRecoveryTitleEl.textContent =
        'Closed. Now check how things are';
      receiptRecoveryStatusEl.textContent =
        `The selected server durably closed this recovery as unresolved. It did not claim the ${operation} succeeded or failed. Confirm what the server reports now before another update or rollback can start.`;
    } else if (verification.phase === 'checking_baseline') {
      receiptRecoveryTitleEl.textContent = 'Checking how the server is';
      receiptRecoveryStatusEl.textContent =
        'Recued is freshly reading the running version, release posture, and '
        + 'affected connection activity where applicable. It is not inferring '
        + `the unresolved ${operation} outcome.`;
    } else if (verification.phase === 'baseline_retryable') {
      receiptRecoveryTitleEl.textContent =
        'Current server state is not confirmed';
      receiptRecoveryStatusEl.textContent =
        'Recued could not read what is true now. No update, and no going back, '
        + 'can start until you reconnect if needed and retry this baseline.';
    } else if (verification.phase === 'baseline_confirmed') {
      if (verification.reason === 'finish_unavailable') {
        receiptRecoveryTitleEl.textContent =
          'Checked. Finishing needs another go';
        receiptRecoveryStatusEl.textContent = reviewedTarget === null
          ? 'The baseline below remains confirmed, but this browser could not '
            + 'finish tidying up. Choose Finish again; this does '
            + 'not contact the server or repeat the update or rollback.'
          : 'The baseline below remains confirmed, but this browser could not '
            + `finish tidying up. Try finishing again and go back to ${reviewedTarget.kind}/${reviewedTarget.name}; this does not contact the server or repeat the update or rollback.`;
      } else {
        receiptRecoveryTitleEl.textContent = 'Checked how the server is';
        receiptRecoveryStatusEl.textContent = reviewedTarget === null
          ? 'The selected server freshly reported the state below. Review it, '
            + 'then finish recovery to make server-change controls available again.'
          : 'The selected server freshly reported the state below. Review it, '
            + `then finish recovery and continue to ${reviewedTarget.kind}/${reviewedTarget.name} for its new safety check.`;
      }
    } else if (verification.phase === 'finishing') {
      receiptRecoveryTitleEl.textContent = 'Finishing up';
      receiptRecoveryStatusEl.textContent =
        'Recued has checked how the server is. It is only tidying up in this '
        + 'browser. What the server wrote down stays written down.';
    } else if (verification.phase === 'completed') {
      receiptRecoveryTitleEl.textContent = 'All sorted';
      receiptRecoveryStatusEl.textContent = completionTarget === null
        ? 'Recued has checked how the server is, and its controls work '
          + 'again.'
        : `Recued has checked how the server is, and its controls work again. Go back to ${completionTarget.kind}/${completionTarget.name} for its new safety check.`;
    } else {
      receiptRecoveryTitleEl.textContent =
        `${verification.operation === 'update' ? 'Update' : 'Rollback'} result needs a look`;
      receiptRecoveryStatusEl.textContent =
        verification.reason === 'operation_mismatch'
          ? `The paired server resolved this receipt as a different action than the expected ${operation}. Confirm the selected server profile before retrying.`
          : verification.reason === 'closure_in_flight'
            ? `The server refused to close this receipt because another release transition is active. Wait for that server change to settle, then retry the result again.`
            : verification.reason === 'closure_unavailable'
              ? `The server you picked could not write down that this is finished. The receipt is still open. Try the check again, or send the safe summary to whoever looks after the server.`
              : `The paired server did not recognize this ${operation} receipt. Confirm the selected server profile before retrying.`;
    }
    const closureRecorded =
      verification.phase === 'closed'
      || verification.phase === 'checking_baseline'
      || verification.phase === 'baseline_retryable'
      || verification.phase === 'baseline_confirmed'
      || verification.phase === 'finishing'
      || verification.phase === 'completed';
    receiptRecoveryPrivacyEl.textContent = closureRecorded
      ? verification.phase === 'completed'
        ? 'This one-off note lives only in this tab. It is gone after a reload, '
          + 'and other tabs never see it. It says how things are now, '
          + `not whether the original ${operation} worked.`
        : 'This lives only in this tab’s memory and says how things are now, not what happened. '
          + `It does not repeat, undo, or guess at the ${operation}. The result code, `
          + 'keys, addresses, and error details are all left out.'
      : 'Trying again only checks the code Recued already has. It never repeats the '
        + `${operation}. That code, and any error details, are not `
        + 'shown, copied, or saved here.';
    const baseline =
      verification.phase === 'baseline_confirmed'
      || verification.phase === 'completed'
      ? verification.baseline
      : undefined;
    setHidden(receiptBaselineEl, baseline === undefined);
    if (baseline === undefined) {
      receiptBaselineVersionEl.textContent = '';
      receiptBaselinePostureEl.textContent = '';
      receiptBaselineConnectionEl.textContent = '';
      receiptBaselineBoundaryEl.textContent = '';
    } else {
      receiptBaselineVersionEl.textContent =
        `Running ${baseline.currentVersion} · ${baseline.channel} channel`;
      receiptBaselinePostureEl.textContent =
        `Release posture: ${BASELINE_POSTURE_COPY[baseline.updateStatus]}`;
      const affected = baseline.affectedConnection;
      receiptBaselineConnectionEl.textContent = affected === undefined
        ? 'Affected connection: none linked to this recovery.'
        : affected.activity === 'idle'
          ? `${affected.kind}/${affected.name}: no credential verification is pending now.`
          : affected.activity === 'pending'
            ? `${affected.kind}/${affected.name}: credential verification is pending now.`
            : `${affected.kind}/${affected.name}: Recued could not read what this key has been doing. It will check again when you come back.`;
      receiptBaselineBoundaryEl.textContent =
        `Confirmed current state only. The original ${operation} result is still unknown.`;
    }
    // ⛔⛔ A CONTROL THAT CANNOT ACT IS NOT INFORMATION, IT IS FURNITURE. This
    // used to SHOW the retry while disabled, relabelled "Retry when connected",
    // and it showed during `waiting`/`checking` — i.e. while the panel's own text
    // promises "Recued will retry automatically". So an owner watching an update
    // saw buttons that contradicted the sentence above them and could not be
    // pressed. Reported 2026-08-31 with the server actually gone, where neither
    // the automatic retry nor the manual one could ever have succeeded.
    //
    // 🔑 SHOW IT ONLY WHEN IT IS THE WAY FORWARD:
    //   · `waiting` / `checking` — automatic retry is RUNNING. The text says so;
    //     a manual button adds nothing and denies it.
    //   · disconnected — nothing can act, automatic or manual. The status line
    //     already says the server has to come back first.
    //   · `retryable` / `unknown` — automatic retry has STOPPED. Here a manual
    //     retry is the only way forward, so here is where the button belongs.
    const showRetry = connected
      && (verification.phase === 'retryable' || verification.phase === 'unknown');
    setHidden(receiptRecoveryRetry, !showRetry);
    receiptRecoveryRetry.textContent = connected
      ? verification.phase === 'checking'
        ? 'Checking the result…'
        : verification.phase === 'waiting'
          ? 'Retry now'
          : 'Check the result again'
      : 'Retry when connected';
    receiptRecoveryRetry.setAttribute(
      'aria-label',
      connected
        ? verification.phase === 'checking'
          ? `Checking the server ${operation} receipt`
          : `Check the server ${operation} result again`
        : `Waiting to reconnect before checking the server ${operation} result again`,
    );
    setDisabled(
      receiptRecoveryRetry,
      verification.phase === 'checking'
        || !connected
        || opts.serverUpdateReceiptVerification === undefined,
    );
    // Same rule: reviewing a closure requires asking the server, so offering it
    // while disconnected is a button that can only decline.
    const canReviewClosure = connected
      && verification.phase === 'unknown'
      && verification.reason === 'unknown_receipt';
    setHidden(receiptClosureReviewButton, !canReviewClosure);
    setDisabled(
      receiptClosureReviewButton,
      !connected || opts.serverUpdateReceiptVerification === undefined,
    );
    receiptClosureReviewButton.setAttribute(
      'aria-label',
      connected
        ? `See how the server finished the open ${operation} receipt`
        : `Waiting to reconnect before looking at the open ${operation} receipt`,
    );
    const reviewingClosure = verification.phase === 'reviewing_closure';
    setHidden(receiptClosureReview, !reviewingClosure);
    setDisabled(
      receiptClosureConfirm,
      !connected || opts.serverUpdateReceiptVerification === undefined,
    );
    const showFinish =
      verification.phase === 'closed'
      || verification.phase === 'checking_baseline'
      || verification.phase === 'baseline_retryable'
      || verification.phase === 'baseline_confirmed'
      || verification.phase === 'finishing'
      || verification.phase === 'completed';
    setHidden(receiptClosureFinish, !showFinish);
    setDisabled(
      receiptClosureFinish,
      verification.phase === 'checking_baseline'
        || verification.phase === 'finishing'
        || (
          (
            verification.phase === 'closed'
            || verification.phase === 'baseline_retryable'
          )
          && !connected
        )
        || opts.serverUpdateReceiptVerification === undefined,
    );
    receiptClosureFinish.textContent =
      verification.phase === 'checking_baseline'
        ? 'Checking how the server is…'
        : verification.phase === 'baseline_retryable'
          ? 'Check how the server is again'
        : verification.phase === 'baseline_confirmed'
            ? verification.reason === 'finish_unavailable'
              ? reviewedTarget === null
                ? 'Retry finish recovery'
                : `Try finishing again and go back to ${reviewedTarget.kind}/${reviewedTarget.name}`
              : reviewedTarget === null
                ? 'Finish recovery'
                : `Finish and go back to ${reviewedTarget.kind}/${reviewedTarget.name}`
            : verification.phase === 'completed'
              ? completionTarget === null
                ? 'Dismiss confirmation'
                : `Return to ${completionTarget.kind}/${completionTarget.name}`
            : verification.phase === 'finishing'
              ? 'Finishing up…'
              : connected
                ? 'Check how the server is'
                : 'Confirm when connected';
    receiptClosureFinish.setAttribute(
      'aria-label',
      verification.phase === 'checking_baseline'
        ? `Asking the server how it is, after the unanswered ${operation} closure`
        : verification.phase === 'baseline_retryable'
          ? `Check how the server is again, after the unanswered ${operation} closure`
        : verification.phase === 'baseline_confirmed'
            ? verification.reason === 'finish_unavailable'
              ? reviewedTarget === null
                ? `Retry retiring the exact browser recovery latch using the reviewed current-state baseline; no server action will repeat`
                : `Try tidying up in this browser again, then go back to the exact affected connection; no server action will repeat`
              : reviewedTarget === null
                ? `Finish recovery using what the server just told us. The original ${operation} result is still unknown`
                : `Finish and go back to the exact affected connection; the original ${operation} result is still unknown`
            : verification.phase === 'completed'
              ? completionTarget === null
                ? 'Dismiss the one-shot current-state recovery confirmation'
                : `Return to the exact affected connection after the reviewed current-state recovery`
            : verification.phase === 'finishing'
        ? `Finishing with the unanswered ${operation} result`
              : `Check how the server is before retiring the server-closed unresolved ${operation} receipt`,
    );

    if (
      verification.phase !== 'unknown'
      && verification.phase !== 'retryable'
      && verification.phase !== 'baseline_retryable'
    ) {
      setHidden(receiptDiagnosticEl, true);
      receiptDiagnosticSummaryEl.textContent = '';
      if (receiptDiagnosticKey !== null) {
        receiptDiagnosticGeneration += 1;
        receiptDiagnosticCopyInFlight = false;
        receiptDiagnosticStatusEl.textContent = '';
        receiptDiagnosticKey = null;
      }
      return;
    }
    setHidden(receiptDiagnosticEl, false);
    receiptDiagnosticPrivacyEl.textContent =
      'Review this privacy-safe summary before sharing it with the person who '
      + 'manages this server. Nothing is sent automatically; the opaque '
      + 'receipt, web address, keys, version numbers and raw errors are left out.';
    const nextDiagnosticKey = [
      verification.operation,
      verification.startedAt,
      verification.reason,
    ].join(':');
    if (receiptDiagnosticKey !== nextDiagnosticKey) {
      receiptDiagnosticGeneration += 1;
      receiptDiagnosticCopyInFlight = false;
      receiptDiagnosticStatusEl.textContent = '';
      receiptDiagnosticKey = nextDiagnosticKey;
    }
    receiptDiagnosticSummaryEl.textContent =
      buildServerUpdateReceiptDiagnostic({
        ...opts.serverUpdateReceiptDiagnosticContext,
        verification,
      });
    if (opts.serverUpdateReceiptDiagnosticWriter === undefined) {
      setHidden(receiptDiagnosticCopy, true);
    } else {
      setHidden(receiptDiagnosticCopy, false);
      setDisabled(receiptDiagnosticCopy, receiptDiagnosticCopyInFlight);
      receiptDiagnosticCopy.textContent = receiptDiagnosticCopyInFlight
        ? 'Copying…'
        : 'Copy safe diagnostic';
    }
  };

  const render = (): void => {
    if (disposed) return;
    root.setAttribute(UPDATES_PAGE_STATE_ATTR, state.phase);

    const tabProgress = renderTabProgress();
    renderCredentialRetry();
    renderReceiptRecovery();

    versionEl.textContent =
      state.check !== null
        ? `Current version ${state.check.current_version} · ${state.check.channel} channel`
        : 'Current version —';

    const checkBusy = state.phase === 'checking';
    // A manually initiated check owns this stable button for the full read.
    // Keep it focusable while the state guard rejects duplicate clicks; native
    // disablement is reserved for a genuinely unavailable/superseded command.
    setDisabled(
      checkBtn,
      !checkBusy && (tabProgress !== null || opts.runCheck === undefined),
    );
    if (checkBusy) {
      checkBtn.setAttribute('aria-disabled', 'true');
      checkBtn.setAttribute('aria-busy', 'true');
    } else {
      checkBtn.removeAttribute('aria-disabled');
      checkBtn.removeAttribute('aria-busy');
    }
    checkBtn.textContent = state.phase === 'checking'
      ? 'Checking…'
      : tabProgress !== null
        ? 'Waiting for server…'
        : 'Check for updates';

    if (state.phase === 'checking') statusEl.textContent = 'Checking…';
    else if (state.check !== null && state.check.status !== 'update-available') {
      const base = CHECK_STATUS_COPY[state.check.status];
      const diagnostic =
        state.check.detail !== undefined && state.check.detail.length > 0
          ? `${base} (${state.check.detail})`
          : base;
      statusEl.textContent = state.check.docker
        ? `${diagnostic} Recreate with ${state.check.docker.pull_ref}.`
        : diagnostic;
    } else statusEl.textContent = '';

    if (state.checkError !== null) {
      setHidden(errorEl, false);
      errorEl.textContent = state.checkError;
    } else {
      setHidden(errorEl, true);
      errorEl.textContent = '';
    }

    renderAvailable();

    if (state.applyError !== null) {
      setHidden(applyResultEl, false);
      applyResultEl.textContent = state.applyError;
    } else if (state.applyResult !== null) {
      setHidden(applyResultEl, false);
      const base = APPLY_STATUS_COPY[state.applyResult.status];
      applyResultEl.textContent =
        state.applyResult.detail !== undefined && state.applyResult.detail.length > 0
          ? `${base} (${state.applyResult.detail})`
          : base;
    } else if (state.updateOutcome !== null) {
      setHidden(applyResultEl, false);
      applyResultEl.textContent = state.updateOutcome;
    } else {
      setHidden(applyResultEl, true);
      applyResultEl.textContent = '';
    }

    if (state.mode !== null) {
      setHidden(modeBlock, false);
      modeSelect.value = state.modeBusy && pendingMode !== null
        ? pendingMode
        : state.mode.mode;
      setDisabled(
        modeSelect,
        state.mode.env_locked
          || (!state.modeBusy && tabProgress !== null)
          || opts.runSetMode === undefined,
      );
      if (state.modeBusy) {
        modeSelect.setAttribute('aria-disabled', 'true');
        modeSelect.setAttribute('aria-busy', 'true');
      } else {
        modeSelect.removeAttribute('aria-disabled');
        modeSelect.removeAttribute('aria-busy');
      }
      const notes: string[] = [];
      if (state.mode.env_locked) notes.push('Locked by RECUED_SELF_UPDATE on the server.');
      else notes.push(`Default for the ${MODE_SHORT[state.mode.channel_default]} setting on this channel.`);
      if (state.modeError !== null) notes.push(state.modeError);
      modeNoteEl.textContent = notes.join(' ');
    } else {
      setHidden(modeBlock, true);
    }

    setDisabled(
      rollbackBtn,
      state.applying
        || (!state.rollbackBusy && tabProgress !== null)
        || opts.runRollback === undefined,
    );
    if (state.rollbackBusy) {
      rollbackBtn.setAttribute('aria-disabled', 'true');
      rollbackBtn.setAttribute('aria-busy', 'true');
    } else {
      rollbackBtn.removeAttribute('aria-disabled');
      rollbackBtn.removeAttribute('aria-busy');
    }
    rollbackBtn.textContent = state.rollbackBusy
      ? 'Rolling back…'
      : 'Roll back to previous version';
    if (state.rollbackError !== null) {
      setHidden(rollbackResultEl, false);
      rollbackResultEl.textContent = state.rollbackError;
    } else if (state.rollbackResult !== null) {
      setHidden(rollbackResultEl, false);
      const base = ROLLBACK_STATUS_COPY[state.rollbackResult.status];
      const snap =
        state.rollbackResult.status === 'rolled-back' && state.rollbackResult.restored_snapshot === true
          ? ' The database was restored to its pre-update snapshot.'
          : '';
      const detail =
        state.rollbackResult.detail !== undefined && state.rollbackResult.detail.length > 0
          ? ` (${state.rollbackResult.detail})`
          : '';
      rollbackResultEl.textContent = `${base}${snap}${detail}`;
    } else {
      setHidden(rollbackResultEl, true);
      rollbackResultEl.textContent = '';
    }
  };

  const signalAvailability = (available: boolean): void => {
    try {
      opts.onAvailabilityChanged?.(available);
    } catch {
      /* best-effort — the badge is cosmetic */
    }
  };

  async function doCheck(queueIfBusy = false): Promise<void> {
    if (disposed || readServerUpdateProgress() !== null) return;
    if (state.phase === 'checking') {
      if (queueIfBusy) queuedPostRestartCheck = true;
      return;
    }
    if (queueIfBusy) queuedPostRestartCheck = false;
    if (opts.runCheck === undefined) {
      state.phase = 'checked';
      render();
      return;
    }
    state.phase = 'checking';
    state.checkError = null;
    render();
    try {
      const res = await opts.runCheck();
      if (disposed) return;
      // A new check is a new decision: consent given for the previous
      // release must not carry over to this one.
      if (state.check?.available?.version !== res.available?.version) {
        state.confirmArmed = false;
      }
      state.check = res;
      // ⛔ THE UPDATE'S OWN MESSAGE OUTLIVED IT. `applyResult` was set by the
      // apply and never reset, so after an update finished the page showed the
      // new version under "Updating now. The server will restart and be away for
      // a moment." for as long as it stayed open (reported 2026-09-29). With the
      // shared record in use, a check can only run once nothing is on it — after
      // the restart was verified — so this check is the run's answer: replace the
      // in-flight message with how it went. Without the record (a page mounted
      // on its own) a poll could land before the restart, so leave it.
      const inFlightResult = state.applyResult?.status === 'restarting'
        || state.applyResult?.status === 'applying';
      if (
        inFlightResult
        && !state.applying
        && opts.serverUpdateTabConvergence !== undefined
        && readServerUpdateProgress() === null
      ) {
        const target = state.applyResult?.to_version ?? applyingToVersion;
        state.applyResult = null;
        state.updateOutcome = target === null
          ? `The server now runs ${res.current_version}.`
          : res.current_version === target
            ? `Updated to ${target}.`
            : `The server is still on ${res.current_version}. The update to ${target} did not take effect.`;
      }
      const retryMarker =
        opts.credentialRotationServerUpdateContinuity?.read() ?? null;
      if (retryMarker !== null) {
        opts.credentialRotationServerUpdateContinuity?.recordServerCheck(
          { kind: retryMarker.kind, name: retryMarker.name },
          res,
        );
      }
      state.phase = 'checked';
      state.checkError = null;
      signalAvailability(res.status === 'update-available');
    } catch (err) {
      if (disposed) return;
      state.phase = 'error';
      state.checkError = humanizeRpcError(err);
      signalAvailability(false);
    }
    render();
    if (
      queuedPostRestartCheck
      && !disposed
      && readServerUpdateProgress() === null
    ) {
      queuedPostRestartCheck = false;
      void doCheck();
    }
  }

  async function doApply(force: boolean): Promise<void> {
    if (
      disposed
      || opts.runApply === undefined
      || state.applying
      || state.rollbackBusy
      || readServerUpdateProgress() !== null
    ) return;
    let lease: CredentialRotationOwnershipLease | null = null;
    if (
      opts.serverUpdateTabConvergence?.supportsServerUpdateOwnership === true
    ) {
      lease =
        await opts.serverUpdateTabConvergence.claimServerUpdateOwnership();
      if (disposed) {
        lease?.release();
        return;
      }
      if (lease === null) {
        await opts.serverUpdateTabConvergence
          .reconcileServerUpdateProgress();
        if (disposed) return;
        state.applyError = UPDATE_OWNER_CONFLICT_COPY;
        render();
        return;
      }
      const joinedProgress = await opts.serverUpdateTabConvergence
        .reconcileServerUpdateProgress();
      if (disposed) {
        lease.release();
        return;
      }
      if (joinedProgress !== null) {
        lease.release();
        render();
        return;
      }
    }
    const retryMarker =
      opts.credentialRotationServerUpdateContinuity?.read() ?? null;
    // The confirm is used up by the apply it confirms: whatever this run's
    // outcome, the next attempt starts again from "Update to <version>".
    const ownerConfirmed = state.confirmArmed;
    state.confirmArmed = false;
    state.updateOutcome = null;
    applyingToVersion = state.check?.available?.version ?? null;
    state.applying = true;
    state.applyError = null;
    // ⛔⛔ THE RECEIPT IS MINTED AND LATCHED BEFORE THE REQUEST LEAVES. The server
    // reserves an operation id before it starts work, so a caller that goes away
    // can still ask `update.operation_status` — but that id travelled only on the
    // REPLY. A socket lost between acceptance and the reply left the update
    // running and this tab holding an ID-LESS latch, which the catch below then
    // cleared: the one case the reservation exists for was the one it could not
    // serve. Naming the run before sending it is what makes an uncertain delivery
    // recoverable.
    const requestedOperationId = crypto.randomUUID();
    opts.serverUpdateTabConvergence?.notifyServerUpdateProgress({
      phase: 'applying',
      operation: 'update',
      operationId: requestedOperationId,
    });
    let ownedProgress =
      opts.serverUpdateTabConvergence?.readServerUpdateProgress() ?? null;
    // ⛔ OWNERSHIP MUST OUTLIVE THE ROUTE FROM THE MOMENT THE REQUEST CAN LEAVE.
    // Parking only after the rpc answered left the lease in this local variable
    // while `dispose()` could see only `pendingApplyLease`. Navigating away in
    // that window therefore leaked the Web Lock until the tab closed. Transfer
    // both pieces before the await; terminal handling and disposal now address
    // the same ownership object regardless of reply timing.
    pendingApplyLease = lease;
    lease = null;
    pendingApplyProgress = ownedProgress;
    applyAcceptancePending = true;
    render();
    try {
      // ⛔⛔ SAY WHICH RELEASE THIS "YES" IS FOR. The server re-fetches the feed
      // and resolves again, so an unbound confirmation — `force` above all, which
      // means "I have read the notes for this MAJOR version" — could answer for a
      // release published between the card being rendered and the click.
      //
      // ⚠ ECHOED, NOT REBUILT: the identity uses the INSTALL's channel and an
      // `edge` install can resolve to a stable release, so assembling it from
      // what this card shows would mismatch. An older server omits the field, we
      // then send no binding, and the apply behaves exactly as it did before.
      const reviewed = state.check?.available?.release_identity;
      const accepted = await opts.runApply({
        ...(force ? { force: true } : {}),
        // ⛔⛔ THE BINDING AND THE CLAIM TRAVEL AS A PAIR. `strict` says "I bound
        // this apply — refuse me if I ever stop", so sending it WITHOUT
        // `expected_release_identity` asks the server to refuse a request that is
        // already missing what it promises. That is a self-refusal, and a gate
        // that can block an owner's update is exactly what this whole area has
        // been avoiding. A server new enough to enforce `strict` always returns
        // `release_identity` on `update-available`, so the pair is present
        // whenever it matters; an older server omits it AND ignores the flag.
        ...(reviewed === undefined ? {} : { expected_release_identity: reviewed, strict: true }),
        // The audit half of "explicit, CONFIRMED, audited": the owner confirmed
        // this update (or, for `force`, answered the major-version question
        // after confirming it), and a release this server has not been offered
        // yet needs that consent on the wire — a strict apply is refused
        // without it.
        ...(state.check?.available?.in_rollout_cohort === false && (force || ownerConfirmed)
          ? { confirm_rollout: true }
          : {}),
        // ⚠ An older server drops this and mints its own; the reply is still
        // authoritative, which is why the latch is re-stamped from it below.
        operation_id: requestedOperationId,
      });
      applyAcceptancePending = false;
      if (disposed) {
        // The bootstrap owns terminal convergence after this route goes away.
        // A late rpc reply may refine the receipt only while our exact applying
        // lineage still exists; it may never recreate a latch the bootstrap
        // cleared or regress `awaiting_reconnect` back to `applying`.
        const current = exactOwnedApplyingProgress(ownedProgress);
        if (current !== null) {
          if (accepted.status === 'applying') {
            opts.serverUpdateTabConvergence?.notifyServerUpdateProgress({
              phase: 'applying',
              operation: 'update',
              ...(accepted.operation_id === undefined
                ? {}
                : { operationId: accepted.operation_id }),
            });
          } else if (accepted.status === 'restarting') {
            opts.serverUpdateTabConvergence?.notifyServerUpdateProgress({
              phase: 'awaiting_reconnect',
              operation: 'update',
              ...(accepted.operation_id === undefined
                ? {}
                : { operationId: accepted.operation_id }),
            });
          } else {
            await clearServerUpdateProgress(current);
          }
        }
        return;
      }
      // ⛔⛔⛔ A TERMINAL CAN LAND BEFORE THIS ANSWER DOES, and this used to
      // overwrite it. The handler starts the run and only THEN returns
      // `applying`, so a refusal `runApply` reaches immediately — `busy`,
      // `deferred`, `insufficient-storage` — resolves into the broadcast while the
      // rpc reply is still being dispatched. Probed against the real handler:
      // `["emit:busy", "rpc:applying"]`. The bus handler below then correctly
      // ended the run, and the line here put `applying` back over the top of it:
      // the button stayed on "Updating…", the ownership lease was parked for a
      // terminal that had already been and gone, and the refusal was never shown.
      //
      // 🔑 THE FIX IS ORDER-INDEPENDENCE, NOT ORDERING. The acceptance and the
      // outcome travel on two different channels; nothing can promise which
      // arrives first, and a server-side reordering would only move the race. So:
      // whichever ENDS the run wins, and `state.applying` is exactly the record of
      // whether one already has.
      state.applyResult = state.applying ? accepted : (state.applyResult ?? accepted);
      // ⛔⛔ THE RECEIPT GOES INTO THE DURABLE LATCH IMMEDIATELY, NOT ONLY AT THE
      // END. `applying` returns at once and the run continues for minutes; the
      // operation id used to reach this tab only on the TERMINAL bus event, so
      // leaving the page before then left a latch that named no operation and
      // nothing that could ever ask what became of it. With the id on the latch,
      // the run is answerable by `update.operation_status` from any later tab.
      // ⛔ THE REPLY'S ID WINS. It equals the one we sent on a current server and
      // DIFFERS on one too old to read the field — where ours names nothing, and
      // taking the server's is the difference between a receipt and a guess.
      if (state.applyResult.status === 'applying') {
        // ⛔⛔ AND AN `applying` WITH NO RECEIPT MEANS THE SERVER IS TOO OLD TO
        // HAVE READ OURS — so ours names NOTHING there and must come back OFF the
        // latch. Keeping it would be worse than the bug being fixed: a later tab
        // would resolve a receipt the server never issued, get `unknown`, and be
        // walked through the closure flow for an update that is running fine.
        // Dropping it restores exactly the receipt-free latch that shipped before.
        opts.serverUpdateTabConvergence?.notifyServerUpdateProgress({
          phase: 'applying',
          operation: 'update',
          ...(state.applyResult.operation_id === undefined
            ? {}
            : { operationId: state.applyResult.operation_id }),
        });
        ownedProgress =
          opts.serverUpdateTabConvergence?.readServerUpdateProgress() ?? ownedProgress;
        // The reply can replace a caller-minted id with the receipt minted by an
        // older server. Move the parked lineage at the same time so a terminal
        // that arrived before this reply is compared with the authoritative id,
        // not the provisional one.
        pendingApplyProgress = ownedProgress;
        const deferredTerminal = deferredUpdateTerminal;
        deferredUpdateTerminal = null;
        if (
          deferredTerminal?.operation_id !== undefined
          && state.applyResult.operation_id !== undefined
          && deferredTerminal.operation_id === state.applyResult.operation_id
        ) handleUpdateProgress(deferredTerminal);
      }
      if (
        retryMarker !== null
        && state.applyResult.status === 'restarting'
      ) {
        opts.credentialRotationServerUpdateContinuity?.markAwaitingReconnect({
          kind: retryMarker.kind,
          name: retryMarker.name,
        }, state.check?.current_version);
      }
      if (state.applyResult.status === 'restarting') {
        opts.serverUpdateTabConvergence?.notifyServerUpdateProgress({
          phase: 'awaiting_reconnect',
          operation: 'update',
          ...(state.applyResult.operation_id !== undefined
            ? { operationId: state.applyResult.operation_id }
            : {}),
        });
      } else if (state.applyResult.status !== 'applying') {
        await clearServerUpdateProgress(ownedProgress);
      }
      // ⛔ THE CONFIRMATIONS DIE WITH THE RELEASE THEY WERE GIVEN FOR. A stale
      // review means the offer changed under the card; re-arming would carry a
      // major-bump "yes" onto a version nobody has read the notes for, which is
      // the whole reason the server refused. Re-check so the card shows what is
      // actually offered, and make the owner say it again.
      if (state.applyResult.status === 'review-stale') {
        state.confirmArmed = false;
        void doCheck();
      }
      // An apply that proves nothing is installable reconciles the rail badge —
      // otherwise it stays lit against a card the result contradicts (Codex F2).
      if (
        state.applyResult.status === 'not-available'
        || state.applyResult.status === 'not-applicable'
        || state.applyResult.status === 'not-configured'
      ) {
        signalAvailability(false);
      }
    } catch (err) {
      applyAcceptancePending = false;
      state.applyError = humanizeRpcError(err);
      // ⛔⛔ A THROW IS NOT PROOF THE APPLY DID NOT START. This cleared the latch
      // unconditionally, which is correct for a refusal the server actually
      // answered and WRONG for a socket that dropped after it accepted: the work
      // is running and the receipt naming it has just been thrown away.
      //
      // 🔑 AND THE DISTINCTION ALREADY HAS A NAME. `classifyRpcError` mints
      // `in_doubt` for exactly this — "dispatched but the connection dropped
      // before its reply; its outcome is unknown" — alongside `unresponsive`, a
      // timeout that may equally have been dispatched. Keeping the receipt in
      // those two costs at most one `update.operation_status` that answers
      // `unknown`; discarding it costs the only handle on a running update.
      // Every other kind is an answer the server actually gave, so no run began
      // and the latch is ours to drop.
      const failure = classifyRpcError(err);
      if (failure.kind !== 'in_doubt' && failure.kind !== 'unresponsive') {
        await clearServerUpdateProgress(ownedProgress);
      }
    } finally {
      applyAcceptancePending = false;
      // ⛔ `applying` IS NOT A TERMINAL STATUS — STAY PENDING. D-257 made the
      // apply asynchronous: the rpc accepts and returns immediately, and the real
      // outcome arrives on `update.progress`. Clearing here re-enabled the button
      // over a run that was still going, so a second apply could be started on top
      // of the first and a failure never appeared at all. The bus handler below
      // releases both. An OLD server still answers terminally in the rpc, and that
      // path is unchanged.
      if (state.applyResult?.status !== 'applying') {
        state.applying = false;
        pendingApplyLease?.release();
        pendingApplyLease = null;
      } else {
        pendingApplyProgress = ownedProgress;
      }
    }
    if (disposed) return;
    render();
  }

  async function doGetMode(): Promise<void> {
    if (disposed || opts.runGetMode === undefined) return;
    try {
      const res = await opts.runGetMode();
      if (disposed) return;
      state.mode = res;
      state.modeError = null;
    } catch {
      /* leave mode unset — the toggle stays hidden rather than mislead */
    }
    render();
  }

  async function doSetMode(mode: UpdateMode): Promise<void> {
    if (
      disposed
      || opts.runSetMode === undefined
      || state.modeBusy
      || readServerUpdateProgress() !== null
    ) return;
    pendingMode = mode;
    state.modeBusy = true;
    state.modeError = null;
    render();
    try {
      state.mode = await opts.runSetMode({ mode });
    } catch (err) {
      state.modeError = humanizeRpcError(err);
    }
    if (disposed) return;
    pendingMode = null;
    state.modeBusy = false;
    render();
  }

  async function doRollback(): Promise<void> {
    if (
      disposed
      || opts.runRollback === undefined
      || state.rollbackBusy
      || state.applying
      || readServerUpdateProgress() !== null
    ) return;
    let lease: CredentialRotationOwnershipLease | null = null;
    if (
      opts.serverUpdateTabConvergence?.supportsServerUpdateOwnership === true
    ) {
      lease =
        await opts.serverUpdateTabConvergence.claimServerUpdateOwnership();
      if (disposed) {
        lease?.release();
        return;
      }
      if (lease === null) {
        await opts.serverUpdateTabConvergence
          .reconcileServerUpdateProgress();
        if (disposed) return;
        state.rollbackError = ROLLBACK_OWNER_CONFLICT_COPY;
        render();
        return;
      }
      const joinedProgress = await opts.serverUpdateTabConvergence
        .reconcileServerUpdateProgress();
      if (disposed) {
        lease.release();
        return;
      }
      if (joinedProgress !== null) {
        lease.release();
        render();
        return;
      }
    }
    const retryMarker =
      opts.credentialRotationServerUpdateContinuity?.read() ?? null;
    state.rollbackBusy = true;
    state.rollbackError = null;
    state.rollbackResult = null;
    // Rollback restarts synchronously inside the rpc, so the connection can
    // disappear after the server accepted the swap but before its reply arrives.
    // Reserve and latch the receipt before dispatch, exactly as apply does.
    const requestedOperationId = crypto.randomUUID();
    opts.serverUpdateTabConvergence?.notifyServerUpdateProgress({
      phase: 'applying',
      operation: 'rollback',
      operationId: requestedOperationId,
    });
    const ownedProgress =
      opts.serverUpdateTabConvergence?.readServerUpdateProgress() ?? null;
    // The request below may restart the server and never answer. Transfer the
    // lease out of this stack frame before dispatch so route disposal can release
    // it immediately instead of waiting for a reply that may never exist.
    pendingRollbackLease = lease;
    lease = null;
    render();
    try {
      const rollbackResult = await opts.runRollback({
        operation_id: requestedOperationId,
      });
      if (disposed) {
        // Bootstrap or a sibling tab owns convergence after route disposal. A
        // late reply may advance only this route's exact applying lineage; it
        // cannot mint progress over a cleared latch or a newer operation.
        const current = exactOwnedApplyingProgress(ownedProgress);
        if (current !== null) {
          if (rollbackResult.status === 'rolled-back') {
            opts.serverUpdateTabConvergence?.notifyServerUpdateProgress({
              phase: 'awaiting_reconnect',
              operation: 'rollback',
              ...(rollbackResult.operation_id === undefined
                ? {}
                : { operationId: rollbackResult.operation_id }),
            });
          } else {
            await clearServerUpdateProgress(current);
          }
        }
        return;
      }
      state.rollbackResult = rollbackResult;
      if (
        retryMarker !== null
        && rollbackResult.status === 'rolled-back'
      ) {
        opts.credentialRotationServerUpdateContinuity?.markAwaitingReconnect({
          kind: retryMarker.kind,
          name: retryMarker.name,
        }, state.check?.current_version);
      }
      if (rollbackResult.status === 'rolled-back') {
        opts.serverUpdateTabConvergence?.notifyServerUpdateProgress({
          phase: 'awaiting_reconnect',
          operation: 'rollback',
          ...(rollbackResult.operation_id !== undefined
            ? { operationId: rollbackResult.operation_id }
            : {}),
        });
      } else {
        await clearServerUpdateProgress(ownedProgress);
      }
    } catch (err) {
      state.rollbackError = humanizeRpcError(err);
      const failure = classifyRpcError(err);
      if (failure.kind !== 'in_doubt' && failure.kind !== 'unresponsive') {
        await clearServerUpdateProgress(ownedProgress);
      }
    } finally {
      state.rollbackBusy = false;
      pendingRollbackLease?.release();
      pendingRollbackLease = null;
    }
    if (disposed) return;
    render();
  }

  const detachCredentialRetry =
    opts.credentialRotationServerUpdateContinuity?.subscribe(() => render())
    ?? (() => undefined);
  /** ⛔ AND IF NOTHING SETTLES THE RECORD EITHER. The bootstrap's receipt check
   *  is what normally clears it after the restart; this is the check that needs
   *  no receipt at all. When this tab reconnects while the page still says
   *  "Updating…", ask the server its version directly — `doCheck` stands down
   *  while any update is on record. If it now runs the release being installed,
   *  the update landed: retire this page's record, and the tab-record handler
   *  ends the run and re-reads the card. */
  const confirmUpdateLanded = async (): Promise<void> => {
    const owned = pendingApplyProgress;
    const target = applyingToVersion;
    if (opts.runCheck === undefined || owned === null || target === null) return;
    let res: ReleaseCheckResponse;
    try {
      res = await opts.runCheck();
    } catch {
      return;
    }
    if (disposed || !state.applying || pendingApplyProgress !== owned) return;
    if (res.current_version !== target) return;
    await clearServerUpdateProgress(owned);
    if (disposed || !state.applying) return;
    // No shared record answered for it (a page mounted without tab
    // convergence, or a record that moved on): the version already said the
    // update landed, so end the run here.
    state.applying = false;
    pendingApplyLease?.release();
    pendingApplyLease = null;
    pendingApplyProgress = null;
    render();
    void doCheck(true);
  };
  let lastConnectionStatus = opts.serverConnectionStatus?.status() ?? null;
  const detachServerStatus =
    opts.serverConnectionStatus?.onStatus((next) => {
      const reconnected = lastConnectionStatus !== 'connected' && next === 'connected';
      lastConnectionStatus = next;
      render();
      if (reconnected && state.applying && !applyAcceptancePending) {
        void confirmUpdateLanded();
      }
    })
    ?? (() => undefined);
  /** D-257 — the apply's OUTCOME. The rpc answers `applying`; the terminal emit
   *  carries the status the rpc used to return, plus the `operation_id` the
   *  result again needs after the restart-forced reconnect.
   *
   *  ⛔ THIS SUBSCRIPTION IS THE POINT. The option was declared here and built in
   *  the bootstrap, but the settings route never forwarded it — so nothing ever
   *  called `subscribe`, and a handler nobody wires is dead exactly like a
  *  broadcast kind nobody names. */
  function handleUpdateProgress(event: UpdateProgressEvent): void {
    if (disposed) return;
    // Non-terminal phases are ledger transitions; only the emit carrying a
    // status ends the run.
    if (event.status === undefined) return;
    const ownedProgress = pendingApplyProgress ?? readServerUpdateProgress();
    // `update.progress` is server-global. A busy/refused operation from another
    // client can finish while this page owns a different accepted apply. When
    // both sides carry receipts, only the exact operation may end this page's
    // state; absent ids retain compatibility with older servers.
    if (
      event.operation_id !== undefined
      && ownedProgress?.operationId !== undefined
      && event.operation_id !== ownedProgress.operationId
    ) {
      if (applyAcceptancePending && state.applying) deferredUpdateTerminal = event;
      return;
    }
    deferredUpdateTerminal = null;
    state.applyResult = {
      status: event.status,
      ...(event.to_version === undefined ? {} : { to_version: event.to_version }),
      ...(event.operation_id === undefined ? {} : { operation_id: event.operation_id }),
    } as typeof state.applyResult;
    if (event.detail !== undefined && event.status !== 'restarting') {
      state.applyError = event.detail;
    }
    state.applying = false;
    pendingApplyLease?.release();
    pendingApplyLease = null;
    if (event.status === 'restarting') {
      // ⚠ THE BOOTSTRAP WRITES THIS TOO, and deliberately: it subscribes at a
      // scope that outlives every route, which is the only reason a terminal
      // arriving after the owner leaves Updates still advances the latch. Both
      // writes carry identical content, so the second is a no-op — this one
      // stays because the page is also mounted standalone (its own suite has no
      // bootstrap), and because the in-route path should not depend on
      // subscription ORDER to leave the latch correct.
      opts.serverUpdateTabConvergence?.notifyServerUpdateProgress({
        phase: 'awaiting_reconnect',
        operation: 'update',
        ...(event.operation_id === undefined
          ? {}
          : { operationId: event.operation_id }),
      });
    } else {
      // ⛔ `null` MEANT "DO NOTHING". `clearServerUpdateProgress` ignores a null
      // expected value by design — it clears only a lineage it can prove is its
      // own — so this call released nothing and the shared progress stayed
      // latched until some later reconciliation or a tab shutdown. The apply
      // captured the owned lineage; the terminal event has to clear THAT.
      void clearServerUpdateProgress(ownedProgress);
      pendingApplyProgress = null;
    }
    render();
  }
  const detachUpdateProgress =
    opts.updateProgress?.subscribe(handleUpdateProgress) ?? (() => {});

  const detachReceiptVerification =
    opts.serverUpdateReceiptVerification?.subscribe((next) => {
      if (next?.phase === 'completed' && next.baseline !== undefined) {
        state.check = {
          status: next.baseline.updateStatus,
          current_version: next.baseline.currentVersion,
          channel: next.baseline.channel,
        };
        state.phase = 'checked';
        state.checkError = null;
        signalAvailability(next.baseline.updateStatus === 'update-available');
      }
      render();
      if (
        next?.phase === 'completed'
        && receiptFinishReturnTarget !== null
      ) {
        const pendingTarget = receiptFinishReturnTarget;
        const completedTarget = exactCompletionTarget(next);
        receiptFinishReturnTarget = null;
        if (
          completedTarget?.kind === pendingTarget.kind
          && completedTarget.name === pendingTarget.name
        ) {
          try {
            opts.onReturnToCredentialRotationRetry?.(pendingTarget);
          } catch {
            // The one-shot completion remains visible and its explicit Return
            // action can retry a constrained router without replaying finish.
          }
        }
      } else if (
        next !== null
        && next.phase !== 'finishing'
        && next.phase !== 'baseline_confirmed'
      ) {
        receiptFinishReturnTarget = null;
      }
      if (receiptCompletionDismissRequested && next === null) {
        receiptCompletionDismissRequested = false;
        focusElement(versionEl);
      }
    })
    ?? (() => undefined);
  const detachServerUpdateTabs =
    opts.serverUpdateTabConvergence?.subscribe((hint) => {
      if (hint.type !== 'server_update_progress') return;
      const previousProgress = lastObservedServerUpdateProgress;
      lastObservedServerUpdateProgress = hint.progress;
      if (state.applyError === UPDATE_OWNER_CONFLICT_COPY) {
        state.applyError = null;
      }
      if (state.rollbackError === ROLLBACK_OWNER_CONFLICT_COPY) {
        state.rollbackError = null;
      }
      // ⛔⛔ THE TERMINAL THAT NEVER CAME. The final `update.progress` goes out
      // just before the server restarts to finish the update, and it can die with
      // the old process. The bootstrap still learns the outcome — it asks the NEW
      // server about this run's receipt and settles the shared record — but
      // `state.applying` is this page's own, and nothing reset it: the button said
      // "Updating…" for 25 minutes over an update a new tab showed as done
      // (26.9.2 → 26.9.26, reported 2026-09-28). So follow the shared record for
      // the run this page owns. Not while the apply rpc is still unanswered: that
      // window rewrites the record itself.
      //
      // ⚠ ONLY TWO MOVES COUNT: the record CLEARED, or THIS run's record moved to
      // `awaiting_reconnect`. A changed operation id is not one — the page itself
      // re-stamps the record with the reply's id (an older server mints its own, or
      // none), and treating that as "another run" ended an apply that was running.
      const owned = pendingApplyProgress;
      const pendingOnRecord = state.applying && !applyAcceptancePending && owned !== null;
      const ownedRunRestarting =
        pendingOnRecord && hint.progress !== null
        && hint.progress.phase === 'awaiting_reconnect'
        && hint.progress.operation === owned!.operation
        && hint.progress.operationId === owned!.operationId;
      const ownedRunMoved = ownedRunRestarting || (pendingOnRecord && hint.progress === null);
      if (ownedRunMoved) {
        state.applying = false;
        pendingApplyLease?.release();
        pendingApplyLease = null;
        if (ownedRunRestarting) {
          // What the page's own terminal handler does for `restarting`: the
          // reconnect check now owns the record.
          state.applyResult = {
            status: 'restarting',
            ...(owned!.operationId === undefined ? {} : { operation_id: owned!.operationId }),
          } as typeof state.applyResult;
        } else {
          // Settled: read the version, which is the one thing that says how it
          // went.
          pendingApplyProgress = null;
        }
      }
      render();
      if (ownedRunMoved && !ownedRunRestarting) {
        void doCheck(true);
      } else if (
        previousProgress?.phase === 'awaiting_reconnect'
        && hint.progress === null
      ) {
        // This tab just proved its own restart boundary. Refresh the displayed
        // version once so "waiting" lands on a useful confirmed outcome instead
        // of leaving the pre-restart availability card stale.
        void doCheck(true);
      }
    }) ?? (() => undefined);

  render();
  void doCheck();
  void doGetMode();

  let cancelPoll: (() => void) | null = null;
  if (opts.startPoll !== undefined) {
    cancelPoll = opts.startPoll(
      () => void doCheck(),
      opts.pollIntervalMs ?? UPDATES_POLL_INTERVAL_MS,
    );
  }

  return {
    refresh: () => doCheck(),
    getState: () => state,
    hasInFlightWork: () =>
      !disposed && (state.applying || state.modeBusy || state.rollbackBusy),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // ⛔ RELEASE WHAT WE STILL HOLD. An async apply parks its ownership lease
      // here until the terminal bus event arrives; if the route is disposed
      // first — the owner navigates away mid-update — that lease was never
      // released, and convergence then saw its OWN held lock and could not
      // reconcile it, blocking sibling tabs until a later sweep or a tab close.
      pendingApplyLease?.release();
      pendingApplyLease = null;
      pendingRollbackLease?.release();
      pendingRollbackLease = null;
      // ⛔⛔ BUT DO NOT DISCARD A RUN THAT IS STILL GOING. This cleared the latch
      // unconditionally, and the card above says "You can leave this page" — so
      // taking that invitation deleted the only pointer to an update still in
      // progress, for every tab, along with any failure it was about to report.
      // A latch carrying a receipt is answerable by whoever asks the server next;
      // one without a receipt is the pre-D-257 shape that nothing can advance
      // once its owner is gone, so that one is still retired here.
      if (pendingApplyProgress?.operationId === undefined) {
        void clearServerUpdateProgress(pendingApplyProgress);
      }
      pendingApplyProgress = null;
      if (cancelPoll !== null) cancelPoll();
      detachServerStatus();
      detachUpdateProgress();
      detachReceiptVerification();
      detachCredentialRetry();
      detachServerUpdateTabs();
      root.remove();
    },
  };
};
