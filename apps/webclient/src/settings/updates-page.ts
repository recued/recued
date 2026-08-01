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
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const UPDATES_PAGE_ATTR = 'data-recued-updates-page';
export const UPDATES_PAGE_STATE_ATTR = 'data-recued-updates-page-state';
export const UPDATES_VERSION_ATTR = 'data-recued-updates-version';
export const UPDATES_CHECK_BTN_ATTR = 'data-recued-updates-check';
export const UPDATES_STATUS_ATTR = 'data-recued-updates-status';
export const UPDATES_ERROR_ATTR = 'data-recued-updates-error';
export const UPDATES_AVAILABLE_ATTR = 'data-recued-updates-available';
export const UPDATES_APPLY_BTN_ATTR = 'data-recued-updates-apply';
export const UPDATES_FORCE_APPLY_BTN_ATTR = 'data-recued-updates-force-apply';
export const UPDATES_APPLY_RESULT_ATTR = 'data-recued-updates-apply-result';
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
export type UpdateApplyCaller = (args: { force?: boolean }) => Promise<UpdateApplyResponse>;
export type UpdateRollbackCaller = () => Promise<UpdateRollbackResponse>;

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
  applyResult: UpdateApplyResponse | null;
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
  dispose: () => void;
}

const CHECK_STATUS_COPY: Readonly<Record<ReleaseCheckStatus, string>> = {
  'update-available': '',
  'up-to-date': "You're on the latest version.",
  'not-configured': "Automatic updates aren't configured on this server yet.",
  'stale-feed': 'The release feed is past its freshness window — not acting on it.',
  'launcher-outdated': 'The launcher is too old to apply updates; update the launcher first.',
  replay: 'The release feed served an older manifest than this server has already seen (ignored).',
  'fetch-failed': "Couldn't reach the release feed.",
  'bad-signature': 'The release manifest failed signature verification.',
};

const BASELINE_POSTURE_COPY: Readonly<Record<ReleaseCheckStatus, string>> = {
  'update-available': 'A newer release is available now.',
  'up-to-date': 'The release feed reports this version is current.',
  'not-configured': 'In-place release checks are not configured on this server.',
  'stale-feed': 'The release feed is stale, so Recued will not act on it.',
  'launcher-outdated': 'The launcher must be updated before an in-place update.',
  replay: 'The server ignored an older release manifest.',
  'fetch-failed': 'The running version is confirmed, but the release feed is unreachable.',
  'bad-signature': 'The running version is confirmed, but the release manifest was rejected.',
};

const APPLY_STATUS_COPY: Readonly<Record<UpdateApplyResponse['status'], string>> = {
  restarting: 'Updating now — the server will restart and be briefly unavailable.',
  deferred: "The server is busy, so the update did not start. Try again once it's idle.",
  busy: 'Another update is already in progress.',
  'major-blocked': 'This is a major update — review the notes, then confirm below to proceed.',
  'insufficient-storage': 'Not enough free disk space on the server to apply this update.',
  'download-failed': 'Downloading the update failed.',
  'verify-failed': 'The downloaded update failed signature verification.',
  'stage-failed': 'Staging the update failed.',
  'not-applicable': 'This install updates via its image or package, not in place.',
  'not-available': 'No installable update is available right now.',
  'not-configured': "Automatic updates aren't configured on this server yet.",
};

const ROLLBACK_STATUS_COPY: Readonly<Record<UpdateRollbackResponse['status'], string>> = {
  'rolled-back': 'Rolled back to the previous version — the server is restarting.',
  refused: 'Rollback refused.',
  busy: 'An update is in progress; rollback is unavailable right now.',
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
    applyResult: null,
    applyError: null,
    mode: null,
    modeBusy: false,
    modeError: null,
    rollbackBusy: false,
    rollbackResult: null,
    rollbackError: null,
  };
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
    text: 'Finish credential replacement',
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
    text: 'Return and check now',
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
      'aria-label': 'Authoritative current server state',
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
    text: 'Retry receipt check',
    className: 'rx-btn rx-btn-secondary',
    attrs: { type: 'button', [UPDATES_RECEIPT_RETRY_ATTR]: '' },
  });
  receiptRecoveryRetry.addEventListener('click', () => {
    opts.serverUpdateReceiptVerification?.retry();
  });
  receiptRecoveryEl.appendChild(receiptRecoveryRetry);
  const receiptClosureReviewButton = make('button', {
    text: 'Review server closure',
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
  const checkBtn = make('button', {
    text: 'Check for updates',
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
  modeBlock.appendChild(make('label', { text: 'When updates are available' }));
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
    if (isUpdateMode(v)) void doSetMode(v);
  });
  modeBlock.appendChild(modeSelect);
  const modeNoteEl = make('p', { attrs: { [UPDATES_MODE_NOTE_ATTR]: '' } });
  modeBlock.appendChild(modeNoteEl);

  const rollbackBlock = make('div');
  rollbackBlock.appendChild(
    make('p', {
      text: 'If a recent update caused problems, you can return to the previous version (the pre-update database snapshot is restored).',
    }),
  );
  const rollbackBtn = make('button', {
    text: 'Roll back to previous version',
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
  root.appendChild(checkBtn);
  root.appendChild(statusEl);
  root.appendChild(errorEl);
  root.appendChild(availableEl);
  root.appendChild(applyResultEl);
  root.appendChild(modeBlock);
  root.appendChild(rollbackBlock);
  host.appendChild(root);

  let disposed = false;
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
        'Copy was unavailable. The summary is focused so you can select and copy it manually.';
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
      tabProgressTitleEl.textContent =
        exactVerification?.phase === 'checking_baseline'
          ? 'Confirming current server state'
          : exactVerification?.phase === 'baseline_retryable'
            ? 'Current server state not confirmed'
            : exactVerification?.phase === 'baseline_confirmed'
              ? exactVerification.reason === 'finish_unavailable'
                ? 'Current state confirmed — finish needs retry'
                : 'Current server state confirmed'
              : exactVerification?.phase === 'closed'
                ? 'Closure recorded — current state required'
                : exactVerification?.phase === 'finishing'
                  ? 'Finishing receipt recovery'
        : exactVerification?.phase === 'retryable'
          || exactVerification?.phase === 'unknown'
          ? `${progress.operation === 'update' ? 'Update' : 'Rollback'} result unconfirmed`
          : checkingReceipt
            ? `Checking ${progress.operation === 'update' ? 'update' : 'rollback'} result`
            : `${progress.operation === 'update' ? 'Update' : 'Rollback'} accepted — waiting for restart`;
      tabProgressStatusEl.textContent =
        progress.operationId === undefined
          ? `The server accepted the ${operation}. Keep this tab open; it will verify its own reconnect before enabling server controls again.`
          : exactVerification?.phase === 'waiting'
            ? `The exact receipt is not confirmed yet. Recued will retry automatically; use the recovery controls below if you want to check now.`
            : exactVerification?.phase === 'retryable'
              ? `Automatic receipt checks stopped safely. Use the recovery controls below; the ${operation} itself will not be repeated.`
            : exactVerification?.phase === 'unknown'
              ? `The paired server could not safely resolve the receipt. Confirm the selected profile and use the recovery handoff below.`
              : exactVerification?.phase === 'closed'
                ? 'The unresolved receipt is durably closed. Confirm the server state that exists now before another update or rollback can start.'
                : exactVerification?.phase === 'checking_baseline'
                  ? 'Recued is reading the running version, release posture, and affected connection where applicable. The original outcome remains unknown.'
                  : exactVerification?.phase === 'baseline_retryable'
                    ? 'The current-state read failed safely. Use the recovery controls below to retry; server changes remain unavailable.'
                    : exactVerification?.phase === 'baseline_confirmed'
                      ? exactVerification.reason === 'finish_unavailable'
                        ? 'The current-state baseline remains confirmed, but this browser could not retire the exact recovery latch. Retry Finish recovery below; no server action will be repeated.'
                        : 'A fresh current-state baseline is ready to review below. The original update or rollback outcome remains unknown.'
                      : exactVerification?.phase === 'finishing'
                        ? 'The reviewed baseline is confirmed. Recued is retiring only this browser recovery latch.'
              : checkingReceipt
                  ? `This tab is connected and is checking the server-issued restart receipt before enabling server controls again.`
                  : `The server accepted the ${operation}. This tab will check the server-issued restart receipt after reconnect or reload before enabling server controls again.`;
    }
    tabProgressPrivacyEl.textContent =
      'Tabs share only an opaque ID for the selected server profile, the '
      + 'operation, phase, and start time. Credentials, connection details, '
      + 'endpoints, form values, versions, and raw errors stay out of the '
      + 'handoff; an accepted action adds only an opaque server receipt.';
    return progress;
  };

  const renderAvailable = (): void => {
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
    if (a.notes_url.length > 0) {
      const link = make('a', { text: 'Release notes' });
      link.setAttribute('href', a.notes_url);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      availableEl.appendChild(link);
    }
    const applyBtn = make('button', {
      text: state.applying
        ? 'Updating…'
        : readServerUpdateProgress() !== null
          ? 'Update already in progress'
          : 'Update now',
      attrs: { type: 'button', [UPDATES_APPLY_BTN_ATTR]: '' },
    });
    setDisabled(
      applyBtn,
      state.applying
        || readServerUpdateProgress() !== null
        || opts.runApply === undefined,
    );
    applyBtn.addEventListener('click', () => void doApply(false));
    availableEl.appendChild(applyBtn);
    // The server refuses a major bump until forced; surface an explicit confirm.
    if (state.applyResult?.status === 'major-blocked') {
      const forceBtn = make('button', {
        text: 'Update anyway (major)',
        attrs: { type: 'button', [UPDATES_FORCE_APPLY_BTN_ATTR]: '' },
      });
      setDisabled(
        forceBtn,
        state.applying || readServerUpdateProgress() !== null,
      );
      forceBtn.addEventListener('click', () => void doApply(true));
      availableEl.appendChild(forceBtn);
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
          ? 'Confirming current server state'
          : exactVerification?.phase === 'baseline_retryable'
            ? 'Current server state not confirmed'
            : exactVerification?.phase === 'baseline_confirmed'
              ? exactVerification.reason === 'finish_unavailable'
                ? 'Current state confirmed — finish needs retry'
                : 'Current server state confirmed'
              : exactVerification?.phase === 'closed'
                ? 'Closure recorded — confirm current state'
        : exactVerification?.phase === 'retryable'
          ? 'Server result is not confirmed'
          : exactVerification?.phase === 'unknown'
            ? 'Server receipt needs attention'
            : exactVerification?.phase === 'waiting'
              ? 'Confirming the server result'
              : checkingReceipt
                ? 'Checking the server restart'
                : 'Waiting for the server to restart'
      : resolvedElsewhere
      ? 'Credential check is ready'
      : checkingReturn
      ? exactReturnActive
        ? 'Credential check underway'
        : 'Resume credential check'
      : cleanEditorReady
      ? 'Resume credential replacement'
      : 'Finish credential replacement';
    credentialRetryIdentityEl.textContent = `${marker.kind}/${marker.name}`;
    const durable =
      opts.credentialRotationServerUpdateContinuity?.isDurable() === true;
    credentialRetryPrivacyEl.textContent = progress !== null
      ? 'Tabs share only an opaque ID for the selected server profile, the '
        + 'operation, phase, and start time. This exact retry remains in this '
        + 'tab; credentials, connection details, endpoints, form values, '
        + 'versions, and raw errors stay out of the handoff. After acceptance, '
        + 'only an opaque server receipt is added so a reload can verify the '
        + 'exact outcome.'
      : resolvedElsewhere
      ? 'This one-time confirmation is kept only in this tab and will not '
        + 'replay after reload. No replacement credential, form value, or '
        + 'server configuration was stored or sent.'
      : checkingReturn
      ? durable
        ? 'The interrupted return stores only the selected-profile ID, exact '
          + 'connection identity, recovery timestamp, safe preflight phase, '
          + 'and any privacy-safe pre-update version evidence. Credentials, '
          + 'form values, current-state baselines, and the one-shot completion '
          + 'receipt are not stored or replayed.'
        : 'This browser could not save the interrupted return for reload. Keep '
          + 'this tab open; credentials, form values, current-state baselines, '
          + 'and the one-shot completion receipt are still not stored or replayed.'
      : cleanEditorReady
      ? durable
        ? 'The clean-editor handoff stores only the selected-profile ID, exact '
          + 'connection identity, recovery timestamp, and ready-to-enter phase. '
          + 'Credentials, field values, current-state baselines, and the '
          + 'server-recovery receipt are not stored or replayed.'
        : 'This browser could not save the clean-editor return for reload. No '
          + 'credential, field value, current-state baseline, or recovery '
          + 'receipt was stored.'
      : durable
      ? 'Reload recovery stores only an opaque selected-profile ID, the '
        + 'connection identity, a recovery timestamp, and privacy-safe server '
        + 'version/update evidence in this tab. Replacement credentials, form '
        + 'values, raw errors, and server configuration are never stored here.'
      : 'This browser could not save the latest reload recovery. Keep this tab '
        + 'open; replacement credentials, form values, raw errors, and server '
        + 'configuration are still never stored here.';
    const retainedCopy = durable
      ? 'The exact retry remains saved.'
      : 'Keep this tab open; reload recovery is unavailable.';
    const connection: WebclientConnectionStatus | null =
      opts.serverConnectionStatus?.status() ?? null;
    const connected = connection === 'connected';

    if (progress?.phase === 'applying') {
      credentialRetryStatusEl.textContent =
        `An open Recued tab is applying the server ${progressOperationCopy(progress.operation)}. `
        + 'This exact credential retry stays saved; no duplicate server action '
        + 'will be sent from this tab.';
      credentialRetryReturn.textContent = 'Update in progress…';
    } else if (progress?.phase === 'awaiting_reconnect') {
      credentialRetryStatusEl.textContent =
        exactVerification?.phase === 'checking_baseline'
          ? `Recued is reading this server’s current version and release posture before returning to ${marker.kind}/${marker.name}. The original ${progressOperationCopy(progress.operation)} outcome remains unknown.`
          : exactVerification?.phase === 'baseline_retryable'
            ? 'The current-state read failed safely. Retry it in the receipt recovery below; this credential handoff and every server-change control remain paused.'
            : exactVerification?.phase === 'baseline_confirmed'
              ? exactVerification.reason === 'finish_unavailable'
                ? `The server baseline remains confirmed, but this browser could not retire the exact recovery latch. Retry Finish recovery below before returning to ${marker.kind}/${marker.name}; no server action will repeat.`
                : `A fresh server baseline is ready to review below, including the current activity state for ${marker.kind}/${marker.name}. The original ${progressOperationCopy(progress.operation)} outcome remains unknown.`
              : exactVerification?.phase === 'closed'
                ? 'The server closed the unresolved receipt. Confirm its current version, release posture, and this connection’s activity before returning to credential replacement.'
        : exactVerification?.phase === 'waiting'
          ? exactVerification.reason === 'restart_pending'
            ? `The server is still finishing the ${progressOperationCopy(progress.operation)} restart. Recued will check the exact receipt again automatically; this credential retry stays saved.`
            : `The receipt check was temporarily unavailable. Recued will retry automatically; this credential retry stays saved.`
          : exactVerification?.phase === 'retryable'
            ? `Several safe checks could not confirm the server ${progressOperationCopy(progress.operation)}. Use the receipt recovery below; this credential retry and all server controls remain paused.`
            : exactVerification?.phase === 'unknown'
              ? `The paired server could not safely resolve the ${progressOperationCopy(progress.operation)} receipt. Confirm the selected profile and use the recovery handoff below.`
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
        ? `Connections is checking current credential activity for ${marker.kind}/${marker.name}, then re-reading the latest saved connection. This page will not start a duplicate check.`
        : `The exact return for ${marker.kind}/${marker.name} was interrupted before both authoritative reads finished. Resume to rebuild the baseline and rerun the read-only preflight.`;
      credentialRetryReturn.textContent = exactReturnActive
        ? 'Check underway…'
        : connected
          ? 'Resume exact check'
          : 'Resume when connected';
    } else if (cleanEditorReady) {
      credentialRetryStatusEl.textContent = connected
        ? `The safe checks opened a clean editor for ${marker.kind}/${marker.name}, but it closed before any field changed. Resume to repeat the read-only safety check and reopen it.`
        : `The untouched clean editor for ${marker.kind}/${marker.name} is saved as a target-only handoff. Reconnect to repeat the safety check; no field value will be restored.`;
      credentialRetryReturn.textContent = connected
        ? 'Resume clean editor'
        : 'Resume when connected';
    } else if (resolvedElsewhere) {
      credentialRetryStatusEl.textContent = connected
        ? 'A fresh, read-only check confirmed this server can safely check the credential replacement. This tab stayed on Server Updates and did not open a credential form. Continue here when ready to re-read the exact server and saved connection.'
        : 'A fresh check confirmed support, but this tab cannot reach the selected server now. Keep this tab open to continue after reconnecting.';
      credentialRetryReturn.textContent = connected
        ? 'Continue in this tab'
        : 'Waiting for server…';
    } else if (marker.phase === 'triage') {
      credentialRetryStatusEl.textContent = connected
        ? 'The returned server still lacks the safe preflight. After correcting this exact server, run the capability check again; the earlier diagnosis remains available in Account.'
        : `The diagnosis is saved, but this tab cannot reach the selected server now. ${retainedCopy}`;
      credentialRetryReturn.textContent = connected
        ? 'Check server again'
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
        ? 'Server reconnected. Return to run a fresh, authoritative credential check.'
        : `The server reconnected once, but this tab cannot reach it now. ${retainedCopy}`;
      credentialRetryReturn.textContent = connected
        ? 'Return and check'
        : 'Waiting for server…';
    } else {
      credentialRetryStatusEl.textContent = connected
        ? 'Update or restart this server, then return here to run the authoritative check.'
        : connection === null
          ? `This tab cannot confirm the server connection yet. ${retainedCopy}`
          : `Waiting for this server to reconnect. ${retainedCopy}`;
      credentialRetryReturn.textContent = connected
        ? 'Return and check now'
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
        ? `The exact credential check for ${marker.kind}/${marker.name} is already underway in Connections`
      : canReturn
        ? checkingReturn
          ? `Resume the interrupted exact credential check for ${marker.kind}/${marker.name}`
          : cleanEditorReady
          ? `Resume the clean credential editor for ${marker.kind}/${marker.name} after repeating its safety check`
          : resolvedElsewhere
          ? `Continue the credential replacement check for ${marker.kind}/${marker.name} in this tab`
          : marker.phase === 'triage'
          ? `Check the server capability again for ${marker.kind}/${marker.name}`
          : `Return to ${marker.kind}/${marker.name} and check the updated server`
        : `Waiting for the server used by ${marker.kind}/${marker.name} before checking again`,
    );
    credentialRetryDismiss.textContent = progress !== null
      ? 'Update in progress'
      : exactReturnActive
        ? 'Check underway'
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
      || (verification.phase === 'checking' && !receiptRecoveryExposed)
    ) {
      if (verification === null) receiptRecoveryExposed = false;
      setHidden(receiptRecoveryEl, true);
      receiptRecoveryEl.removeAttribute('data-phase');
      receiptRecoveryEl.removeAttribute('aria-busy');
      receiptRecoveryTitleEl.textContent = '';
      receiptRecoveryStatusEl.textContent = '';
      receiptRecoveryPrivacyEl.textContent = '';
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
          ? `The paired server says this ${operation} is still finishing its restart. Recued will check the exact receipt again automatically.`
          : `The receipt check was temporarily unavailable. Recued will retry automatically; the ${operation} will not be sent again.`;
    } else if (verification.phase === 'retryable') {
      receiptRecoveryTitleEl.textContent = `Couldn’t confirm ${operation}`;
      receiptRecoveryStatusEl.textContent =
        `Several safe checks could not confirm the exact ${operation} receipt. Automatic retries stopped; server controls remain paused until the paired server resolves it.`;
    } else if (verification.phase === 'reviewing_closure') {
      receiptRecoveryTitleEl.textContent = 'Review unresolved receipt closure';
      receiptRecoveryStatusEl.textContent =
        `Review what the selected server will prove and record before retiring this unresolved ${operation} receipt. Controls remain paused.`;
    } else if (verification.phase === 'closing') {
      receiptRecoveryTitleEl.textContent = 'Server is checking safe closure';
      receiptRecoveryStatusEl.textContent =
        'The selected server is re-checking the exact receipt, verifying no '
        + 'release transition is active, and preparing a durable unresolved closure.';
    } else if (verification.phase === 'closed') {
      receiptRecoveryTitleEl.textContent =
        'Closure recorded — confirm current state';
      receiptRecoveryStatusEl.textContent =
        `The selected server durably closed this recovery as unresolved. It did not claim the ${operation} succeeded or failed. Confirm what the server reports now before another update or rollback can start.`;
    } else if (verification.phase === 'checking_baseline') {
      receiptRecoveryTitleEl.textContent = 'Confirming current server state';
      receiptRecoveryStatusEl.textContent =
        'Recued is freshly reading the running version, release posture, and '
        + 'affected connection activity where applicable. It is not inferring '
        + `the unresolved ${operation} outcome.`;
    } else if (verification.phase === 'baseline_retryable') {
      receiptRecoveryTitleEl.textContent =
        'Current server state is not confirmed';
      receiptRecoveryStatusEl.textContent =
        'The fresh current-state read was unavailable. No update or rollback '
        + 'can start until you reconnect if needed and retry this baseline.';
    } else if (verification.phase === 'baseline_confirmed') {
      if (verification.reason === 'finish_unavailable') {
        receiptRecoveryTitleEl.textContent =
          'Current state confirmed — finish needs retry';
        receiptRecoveryStatusEl.textContent = reviewedTarget === null
          ? 'The baseline below remains confirmed, but this browser could not '
            + 'retire the exact recovery latch. Retry Finish recovery; this does '
            + 'not contact the server or repeat the update or rollback.'
          : 'The baseline below remains confirmed, but this browser could not '
            + `retire the exact recovery latch. Retry finish and return to ${reviewedTarget.kind}/${reviewedTarget.name}; this does not contact the server or repeat the update or rollback.`;
      } else {
        receiptRecoveryTitleEl.textContent = 'Current server state confirmed';
        receiptRecoveryStatusEl.textContent = reviewedTarget === null
          ? 'The selected server freshly reported the state below. Review it, '
            + 'then finish recovery to make server-change controls available again.'
          : 'The selected server freshly reported the state below. Review it, '
            + `then finish recovery and continue to ${reviewedTarget.kind}/${reviewedTarget.name} for its fresh exact preflight.`;
      }
    } else if (verification.phase === 'finishing') {
      receiptRecoveryTitleEl.textContent = 'Finishing receipt recovery';
      receiptRecoveryStatusEl.textContent =
        'The reviewed baseline is confirmed. Recued is retiring only the '
        + 'browser recovery latch; the server-side unresolved closure remains durable.';
    } else if (verification.phase === 'completed') {
      receiptRecoveryTitleEl.textContent = 'Recovery finished';
      receiptRecoveryStatusEl.textContent = completionTarget === null
        ? 'The reviewed current-state baseline is confirmed and server-change '
          + 'controls are available again.'
        : `The reviewed baseline is confirmed and server-change controls are available again. Return to ${completionTarget.kind}/${completionTarget.name} for its fresh, exact preflight.`;
    } else {
      receiptRecoveryTitleEl.textContent =
        `${verification.operation === 'update' ? 'Update' : 'Rollback'} receipt needs attention`;
      receiptRecoveryStatusEl.textContent =
        verification.reason === 'operation_mismatch'
          ? `The paired server resolved this receipt as a different action than the expected ${operation}. Confirm the selected server profile before retrying.`
          : verification.reason === 'closure_in_flight'
            ? `The server refused to close this receipt because another release transition is active. Wait for that server change to settle, then retry the receipt check.`
            : verification.reason === 'closure_unavailable'
              ? `The selected server could not record an authoritative closure. The receipt remains open; retry the check or share the safe diagnostic with the server administrator.`
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
        ? 'This one-shot confirmation exists only in this tab and will not '
          + 'replay after reload or in sibling tabs. The baseline describes '
          + `current state—not whether the original ${operation} succeeded.`
        : 'The baseline is memory-only and describes current state—not history. '
          + `It does not repeat, undo, or infer the ${operation}; the opaque receipt, `
          + 'credentials, endpoints, and raw errors remain excluded.'
      : 'Retry checks only the existing opaque receipt; it never repeats the '
        + `${operation}. The receipt and raw server or transport errors are not `
        + 'shown, copied, or stored in this recovery view.';
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
            : `${affected.kind}/${affected.name}: current credential activity could not be read; the exact return flow will check again.`;
      receiptBaselineBoundaryEl.textContent =
        `Confirmed current state only. The original ${operation} outcome remains unknown.`;
    }
    const showRetry =
      verification.phase === 'waiting'
      || verification.phase === 'retryable'
      || verification.phase === 'unknown'
      || verification.phase === 'checking';
    setHidden(receiptRecoveryRetry, !showRetry);
    receiptRecoveryRetry.textContent = connected
      ? verification.phase === 'checking'
        ? 'Checking receipt…'
        : verification.phase === 'waiting'
          ? 'Retry now'
          : 'Retry receipt check'
      : 'Retry when connected';
    receiptRecoveryRetry.setAttribute(
      'aria-label',
      connected
        ? verification.phase === 'checking'
          ? `Checking the exact server ${operation} receipt`
          : `Retry the exact server ${operation} receipt check`
        : `Waiting to reconnect before retrying the exact server ${operation} receipt check`,
    );
    setDisabled(
      receiptRecoveryRetry,
      verification.phase === 'checking'
        || !connected
        || opts.serverUpdateReceiptVerification === undefined,
    );
    const canReviewClosure =
      verification.phase === 'unknown'
      && verification.reason === 'unknown_receipt';
    setHidden(receiptClosureReviewButton, !canReviewClosure);
    setDisabled(
      receiptClosureReviewButton,
      !connected || opts.serverUpdateReceiptVerification === undefined,
    );
    receiptClosureReviewButton.setAttribute(
      'aria-label',
      connected
        ? `Review server-authoritative closure for the unresolved ${operation} receipt`
        : `Waiting to reconnect before reviewing closure for the unresolved ${operation} receipt`,
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
        ? 'Confirming current state…'
        : verification.phase === 'baseline_retryable'
          ? 'Retry current-state check'
        : verification.phase === 'baseline_confirmed'
            ? verification.reason === 'finish_unavailable'
              ? reviewedTarget === null
                ? 'Retry finish recovery'
                : `Retry finish and return to ${reviewedTarget.kind}/${reviewedTarget.name}`
              : reviewedTarget === null
                ? 'Finish recovery'
                : `Finish and return to ${reviewedTarget.kind}/${reviewedTarget.name}`
            : verification.phase === 'completed'
              ? completionTarget === null
                ? 'Dismiss confirmation'
                : `Return to ${completionTarget.kind}/${completionTarget.name}`
            : verification.phase === 'finishing'
              ? 'Finishing recovery…'
              : connected
                ? 'Confirm current server state'
                : 'Confirm when connected';
    receiptClosureFinish.setAttribute(
      'aria-label',
      verification.phase === 'checking_baseline'
        ? `Reading the authoritative current server state after the unresolved ${operation} closure`
        : verification.phase === 'baseline_retryable'
          ? `Retry the authoritative current-state check after the unresolved ${operation} closure`
        : verification.phase === 'baseline_confirmed'
            ? verification.reason === 'finish_unavailable'
              ? reviewedTarget === null
                ? `Retry retiring the exact browser recovery latch using the reviewed current-state baseline; no server action will repeat`
                : `Retry retiring the exact browser recovery latch, then return to the exact affected connection; no server action will repeat`
              : reviewedTarget === null
                ? `Finish recovery using the reviewed current-state baseline; the original ${operation} outcome remains unknown`
                : `Finish recovery and return to the exact affected connection; the original ${operation} outcome remains unknown`
            : verification.phase === 'completed'
              ? completionTarget === null
                ? 'Dismiss the one-shot current-state recovery confirmation'
                : `Return to the exact affected connection after the reviewed current-state recovery`
            : verification.phase === 'finishing'
        ? `Finishing the server-closed unresolved ${operation} receipt recovery`
              : `Confirm current server state before retiring the server-closed unresolved ${operation} receipt`,
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
      + 'receipt, URL path, credentials, versions, and raw errors are excluded.';
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

    setDisabled(
      checkBtn,
      state.phase === 'checking'
        || tabProgress !== null
        || opts.runCheck === undefined,
    );
    checkBtn.textContent = state.phase === 'checking'
      ? 'Checking…'
      : tabProgress !== null
        ? 'Waiting for server…'
        : 'Check for updates';

    if (state.phase === 'checking') statusEl.textContent = 'Checking…';
    else if (state.check !== null && state.check.status !== 'update-available') {
      const base = CHECK_STATUS_COPY[state.check.status];
      statusEl.textContent =
        state.check.detail !== undefined && state.check.detail.length > 0
          ? `${base} (${state.check.detail})`
          : base;
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
    } else {
      setHidden(applyResultEl, true);
      applyResultEl.textContent = '';
    }

    if (state.mode !== null) {
      setHidden(modeBlock, false);
      modeSelect.value = state.mode.mode;
      setDisabled(
        modeSelect,
        state.mode.env_locked
          || state.modeBusy
          || tabProgress !== null
          || opts.runSetMode === undefined,
      );
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
      state.rollbackBusy
        || state.applying
        || tabProgress !== null
        || opts.runRollback === undefined,
    );
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
      state.check = res;
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
        state.applyError = UPDATE_OWNER_CONFLICT_COPY;
        render();
        return;
      }
      const joinedProgress = await opts.serverUpdateTabConvergence
        .reconcileServerUpdateProgress();
      if (joinedProgress !== null) {
        lease.release();
        render();
        return;
      }
    }
    const retryMarker =
      opts.credentialRotationServerUpdateContinuity?.read() ?? null;
    state.applying = true;
    state.applyError = null;
    opts.serverUpdateTabConvergence?.notifyServerUpdateProgress({
      phase: 'applying',
      operation: 'update',
    });
    const ownedProgress =
      opts.serverUpdateTabConvergence?.readServerUpdateProgress() ?? null;
    render();
    try {
      state.applyResult = await opts.runApply(force ? { force: true } : {});
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
      } else {
        await clearServerUpdateProgress(ownedProgress);
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
      state.applyError = humanizeRpcError(err);
      await clearServerUpdateProgress(ownedProgress);
    } finally {
      state.applying = false;
      lease?.release();
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
    state.modeBusy = true;
    state.modeError = null;
    render();
    try {
      state.mode = await opts.runSetMode({ mode });
    } catch (err) {
      state.modeError = humanizeRpcError(err);
    }
    if (disposed) return;
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
        state.rollbackError = ROLLBACK_OWNER_CONFLICT_COPY;
        render();
        return;
      }
      const joinedProgress = await opts.serverUpdateTabConvergence
        .reconcileServerUpdateProgress();
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
    opts.serverUpdateTabConvergence?.notifyServerUpdateProgress({
      phase: 'applying',
      operation: 'rollback',
    });
    const ownedProgress =
      opts.serverUpdateTabConvergence?.readServerUpdateProgress() ?? null;
    render();
    try {
      state.rollbackResult = await opts.runRollback();
      if (
        retryMarker !== null
        && state.rollbackResult.status === 'rolled-back'
      ) {
        opts.credentialRotationServerUpdateContinuity?.markAwaitingReconnect({
          kind: retryMarker.kind,
          name: retryMarker.name,
        }, state.check?.current_version);
      }
      if (state.rollbackResult.status === 'rolled-back') {
        opts.serverUpdateTabConvergence?.notifyServerUpdateProgress({
          phase: 'awaiting_reconnect',
          operation: 'rollback',
          ...(state.rollbackResult.operation_id !== undefined
            ? { operationId: state.rollbackResult.operation_id }
            : {}),
        });
      } else {
        await clearServerUpdateProgress(ownedProgress);
      }
    } catch (err) {
      state.rollbackError = humanizeRpcError(err);
      await clearServerUpdateProgress(ownedProgress);
    } finally {
      state.rollbackBusy = false;
      lease?.release();
    }
    if (disposed) return;
    render();
  }

  const detachCredentialRetry =
    opts.credentialRotationServerUpdateContinuity?.subscribe(() => render())
    ?? (() => undefined);
  const detachServerStatus =
    opts.serverConnectionStatus?.onStatus(() => render())
    ?? (() => undefined);
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
      render();
      if (
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
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (cancelPoll !== null) cancelPoll();
      detachServerStatus();
      detachReceiptVerification();
      detachCredentialRetry();
      detachServerUpdateTabs();
      root.remove();
    },
  };
};
