/** Account menu — the topbar's rightmost control, and where the owner goes
 *  when their server stops answering.
 *
 *  ── What it replaced ────────────────────────────────────────────────────
 *  A bare `<a>` to Settings ▸ Account, with a separate theme toggle sitting
 *  beside it. Both are absorbed here: the topbar sheds an icon, and the
 *  account glyph becomes the one "me and my server" surface.
 *
 *  ── Why the badge is the point ──────────────────────────────────────────
 *  The route-independent banner announces a sustained outage. The account
 *  control is where the owner can act: its badge repeats the active profile's
 *  state, and opening it reveals locally stored profiles even when no server
 *  answers. Connection identity and actions therefore have one owner instead
 *  of a topbar chip and a second popover telling competing stories.
 *
 *  ── Composition ─────────────────────────────────────────────────────────
 *  One scroll-bounded dialog, in the order a hand reaches for it:
 *    1. quick actions — theme and Settings;
 *    2. route-independent work and targeted server-update continuation;
 *    3. outage explanation when the current profile is unreachable;
 *    4. current-server health and pause/restart controls when connected;
 *    5. the local profile list plus identity, recency, add, and forget actions.
 *
 *  The menu owns the trigger, the badge, and open/close; the list owns rows
 *  and their confirms. Neither touches storage or the network. */

import type {
  ReleaseCheckStatus,
  WebclientServerProfile,
} from '@recued/contracts';
import type {
  ConnectionsServerUpdateTriage,
  ServerUpdateReceiptVerificationState,
} from '@recued/ui-shared';
import type { ServerUpdateTabProgress } from '../connections/credential-rotation-tab-convergence.js';
import {
  buildServerUpdateReceiptDiagnostic,
} from '../connections/server-update-receipt-verification.js';
import {
  mountProfileList,
  type ProfileListMount,
  type ServerProfileRemovalMode,
  type ServerSwitchWorkState,
} from './server-switcher.js';
import type { ServerSwitchActiveWork } from './server-switch-work-tracker.js';
import {
  isUnresolvedServerControlActionOutcome,
  SERVER_CONTROL_POPOVER_ATTR,
  type ServerControlActionOutcome,
  type ServerControlActionReceipt,
  type ServerControlCurrentStateObservation,
  type ServerControlDiagnosisHandoff,
} from './server-pill-host.js';

export const ACCOUNT_MENU_ATTR = 'data-recued-account-menu';
export const ACCOUNT_MENU_TRIGGER_ATTR = 'data-recued-account-menu-trigger';
export const ACCOUNT_MENU_BADGE_ATTR = 'data-recued-account-menu-badge';
export const ACCOUNT_MENU_POPOVER_ATTR = 'data-recued-account-menu-popover';
export const ACCOUNT_MENU_TITLE_ATTR = 'data-recued-account-menu-title';
export const ACCOUNT_MENU_CLOSE_ATTR = 'data-recued-account-menu-close';
export const ACCOUNT_MENU_QUICK_ROW_ATTR = 'data-recued-account-menu-quick';
export const ACCOUNT_MENU_THEME_SLOT_ATTR = 'data-recued-account-menu-theme-slot';
export const ACCOUNT_MENU_SETTINGS_ATTR = 'data-recued-account-menu-settings';
export const ACCOUNT_MENU_SERVERS_ROW_ATTR = 'data-recued-account-menu-servers';
export const ACCOUNT_MENU_SERVERS_DETAIL_ATTR =
  'data-recued-account-menu-servers-detail';
export const ACCOUNT_MENU_ADD_SERVER_ATTR = 'data-recued-account-menu-add-server';
export const ACCOUNT_MENU_SERVER_SLOT_ATTR = 'data-recued-account-menu-server-slot';
export const ACCOUNT_MENU_RECOVERY_ATTR = 'data-recued-account-menu-recovery';
export const ACCOUNT_MENU_RECOVERY_STEPS_ATTR = 'data-recued-account-menu-recovery-steps';
export const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR =
  'data-recued-account-menu-connection-diagnosis';
export const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ATTR =
  'data-recued-account-menu-connection-diagnosis-title';
export const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS_ATTR =
  'data-recued-account-menu-connection-diagnosis-status';
export const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR =
  'data-recued-account-menu-connection-diagnosis-receipt';
export const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS_ATTR =
  'data-recued-account-menu-connection-diagnosis-controls';
export const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR =
  'data-recued-account-menu-connection-diagnosis-reconcile';
export const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR =
  'data-recued-account-menu-connection-diagnosis-return';
export const ACCOUNT_MENU_SERVER_SLOT_DIAGNOSIS_TARGET_ATTR =
  'data-recued-account-menu-server-slot-diagnosis-target';
export const ACCOUNT_MENU_ACTIVE_WORK_ATTR = 'data-recued-account-menu-active-work';
export const ACCOUNT_MENU_ACTIVE_WORK_ITEM_ATTR =
  'data-recued-account-menu-active-work-item';
export const ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR =
  'data-recued-account-menu-active-work-return';
export const ACCOUNT_MENU_SERVER_UPDATE_ATTR =
  'data-recued-account-menu-server-update';
export const ACCOUNT_MENU_SERVER_UPDATE_STEPS_ATTR =
  'data-recued-account-menu-server-update-steps';
export const ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR =
  'data-recued-account-menu-server-update-status';
export const ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR =
  'data-recued-account-menu-server-update-open';
export const ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR =
  'data-recued-account-menu-server-update-return';
export const ACCOUNT_MENU_SERVER_UPDATE_RETRY_ATTR =
  'data-recued-account-menu-server-update-retry';
export const ACCOUNT_MENU_SERVER_UPDATE_DISMISS_ATTR =
  'data-recued-account-menu-server-update-dismiss';
export const ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_ATTR =
  'data-recued-account-menu-server-update-diagnostic';
export const ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_SUMMARY_ATTR =
  'data-recued-account-menu-server-update-diagnostic-summary';
export const ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_COPY_ATTR =
  'data-recued-account-menu-server-update-diagnostic-copy';
export const ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_STATUS_ATTR =
  'data-recued-account-menu-server-update-diagnostic-status';
export const ACCOUNT_MENU_STYLES_MARKER = 'data-recued-account-menu-styles';

const ACCOUNT_MENU_POPOVER_ID = 'recued-account-menu-popover';
const ACCOUNT_MENU_TITLE_ID = 'recued-account-menu-title';
const ACCOUNT_MENU_RECOVERY_TITLE_ID = 'recued-account-menu-recovery-title';
const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ID =
  'recued-account-menu-connection-diagnosis-title';
const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_DETAIL_ID =
  'recued-account-menu-connection-diagnosis-detail';
const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS_ID =
  'recued-account-menu-connection-diagnosis-status';
const ACCOUNT_MENU_SERVER_UPDATE_TITLE_ID =
  'recued-account-menu-server-update-title';

/** The outage explainer, moved here from the connection popover it replaced.
 *
 *  Two steps, not the previous three: the third was "Review Server settings if
 *  the server address changed", linking to a page whose every panel is driven
 *  by rpc against the server that just went away. It pointed at a door the
 *  outage itself had locked. The servers list directly below is what that step
 *  was reaching for, so the advice is now the surface. */
const RECOVERY_STEPS: ReadonlyArray<string> = [
  'Check that this device is online.',
  'Check that your Recued server is switched on.',
];
const RECOVERY_TITLE = 'Can’t reach your server';
const recoveryDetailCopy = (hasAlternateServer: boolean): string =>
  hasAlternateServer
    ? 'Recued keeps trying this server. You can wait for it to come back, or pick another saved server below.'
    : 'Recued keeps trying this server. Try the steps below. Only add another server if you really do use more than one.';
const ACCOUNT_MENU_SERVERS_TITLE_ID = 'recued-account-menu-servers-title';

export type AccountConnectionDiagnosisInterruption =
  | 'connection'
  | 'navigation'
  | 'ownership'
  | 'reload';

/** Ephemeral, privacy-safe orientation for a bounded verification handoff.
 * It is never stored and carries no error, credential, URL, or record detail. */
export interface AccountConnectionDiagnosis {
  readonly id: string;
  readonly profileId: string;
  readonly profileLabel: string;
  readonly areaLabel: string;
  /** An expired broad-area check uses the same exact active-server landing,
   * but has no saved intent or verification outcome to report afterward. */
  readonly kind?: 'expired_area_review';
  /** Required for the bounded-verification landing. An expired-area review
   * uses `kind`; an unresolved-receipt re-review uses its receipt instead. */
  readonly interruptionReason?: AccountConnectionDiagnosisInterruption;
}

export type AccountConnectionDiagnosisDisposition = 'return' | 'dismissed';

export interface AccountConnectionDiagnosisOpenOptions {
  /** Privacy-safe receipt projection to keep visible while the person compares
   * it with the exact active server. Raw RPC detail never enters this API. */
  readonly initialServerOutcome?: ServerControlActionOutcome;
  /** One-shot intent to open the live controls as soon as their fresh
   * heartbeat-backed owner is available. This only inspects; it never starts
   * or replays an action. */
  readonly reviewServerControls?: boolean;
}

const serverControlReceiptCopy = (
  receipt: ServerControlActionReceipt,
  areaLabel: string,
): string => {
  const boundary = `This answer from the server does not prove ${areaLabel}.`;
  const state = receipt.currentState === 'paused'
    ? 'work is paused'
    : receipt.currentState === 'running'
      ? 'work is running'
      : receipt.currentState === 'restarting'
        ? 'the server is restarting'
        : null;
  const stateSuffix = state === null ? '' : ` Last known state: ${state}.`;
  if (receipt.phase === 'pending') {
    const action = receipt.action === 'pause'
      ? 'Pause'
      : receipt.action === 'resume'
        ? 'Resume'
        : 'Restart';
    return `${action} asked for. Waiting for the server to answer. ${boundary}`;
  }
  if (receipt.action === 'restart' && receipt.phase === 'accepted') {
    return `Restart accepted. Waiting for the old connection to close and a new status to arrive. ${boundary}`;
  }
  if (receipt.action === 'restart' && receipt.phase === 'reconnected') {
    return `The server is answering after taking the Restart, but its status does not prove it actually started again.${stateSuffix} Check what it is doing now before you say what happened. ${boundary}`;
  }
  if (receipt.phase === 'confirmed') {
    const result = receipt.action === 'pause'
      ? 'Pause completed. The server confirmed work is paused.'
      : receipt.action === 'resume'
        ? 'Resume completed. The server confirmed work is running.'
        : 'Restarted. A new status shows the server really did start again.';
    return `${result}${receipt.action === 'restart' ? stateSuffix : ''} ${boundary}`;
  }
  if (receipt.phase === 'superseded') {
    const action = receipt.action === 'pause' ? 'Pause' : 'Resume';
    return `${action} finished, but a newer status from the server says ${state ?? 'its state changed'}. ${boundary}`;
  }
  const detail = receipt.detail?.trim();
  const detailSuffix = detail === undefined || detail.length === 0
    ? '.'
    : `: ${/[.!?…]$/.test(detail) ? detail : `${detail}.`}`;
  if (receipt.phase === 'unconfirmed') {
    const action = receipt.action === 'pause'
      ? 'Pause'
      : receipt.action === 'resume'
        ? 'Resume'
        : 'Restart';
    return `${action} did not give a clear answer${detailSuffix}${stateSuffix} Check what is happening now before trying again. ${boundary}`;
  }
  const action = receipt.action === 'pause'
    ? 'Pause'
    : receipt.action === 'resume'
      ? 'Resume'
      : 'Restart';
  const failure = receipt.action === 'restart'
    && detail?.toLowerCase().includes('already in progress')
    ? 'This request did not start a restart'
    : `${action} did not finish`;
  return `${failure}${detailSuffix}${stateSuffix} ${boundary}`;
};

/** Inline user glyph, inherited from the link this control replaced so the
 *  topbar's silhouette does not shift. */
const ACCOUNT_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';

/** Route-independent, credential-free guide opened by an unsupported safe
 * credential-replacement preflight. */
export interface AccountServerUpdateGuide {
  /** Human-readable non-secret identity, e.g. `api/github`. */
  connectionIdentity: string;
  /** Existing owner-only Settings → Updates surface. */
  updateHref: string;
  /** One-shot exact Connections address that re-runs the preflight. */
  returnHref: string;
  /** False when browser storage rejected the same-tab reload marker. */
  reloadSafe?: boolean;
  /** Restart boundary observed by the boot-scoped continuity owner. */
  phase?:
    | 'guide'
    | 'awaiting_reconnect'
    | 'ready'
    | 'checking_return'
    | 'editor_ready'
    | 'triage'
    | 'resolved_elsewhere';
  /** Memory-only proof that the exact Connections route currently owns the
   * consumed return. Absent after reload or teardown, even though the safe
   * `checking_return` phase remains resumable. */
  exactReturnActive?: true;
  /** Server-authoritative, privacy-safe evidence captured after the returned
   * server still lacks the required activity RPC. */
  serverUpdateTriage?: ConnectionsServerUpdateTriage;
  /** Profile-scoped, privacy-safe progress from the tab that owns the update
   * or rollback. Account remains a passive observer while this is present. */
  serverUpdateProgress?: ServerUpdateTabProgress;
  /** Memory-only, receipt-free recovery status for the exact progress above. */
  serverUpdateVerification?: ServerUpdateReceiptVerificationState;
}

const accountServerUpdateEvidenceCopy = (
  triage: ConnectionsServerUpdateTriage,
): string => {
  const parts: string[] = [];
  if (triage.currentVersion !== undefined) {
    parts.push(`Running ${triage.currentVersion}`);
  }
  if (triage.channel !== undefined) parts.push(`${triage.channel} channel`);
  parts.push(
    triage.checkStatus === 'unavailable'
      ? 'no signed update check'
      : `update check: ${triage.checkStatus.replaceAll('-', ' ')}`,
  );
  if (triage.baselineVersion !== undefined) {
    parts.push(`before update: ${triage.baselineVersion}`);
  }
  return parts.join(' · ');
};

const ACCOUNT_BASELINE_POSTURE_COPY: Readonly<
  Record<ReleaseCheckStatus, string>
> = {
  'update-available': 'a newer version is ready',
  'up-to-date': 'this is the newest version',
  'not-configured': 'in-place release checks are not configured',
  'stale-feed': 'this server checks for updates in an old way and misses new ones',
  'launcher-outdated': 'the launcher has to be updated first',
  replay: 'an older update was ignored',
  'fetch-failed': 'Recued knows the version it is running, but cannot reach the update service',
  'bad-signature': 'Recued knows the version it is running, but the update did not pass its checks',
};

const accountServerUpdateTriageStep = (
  triage: ConnectionsServerUpdateTriage,
): string => {
  if (triage.reason === 'update_still_available') {
    return triage.availableVersion === undefined
      ? 'This server still has an update waiting. Install it, then check that this server really does restart.'
      : `The selected server still offers ${triage.availableVersion}. Apply it and confirm that this exact server process restarts.`;
  }
  if (triage.reason === 'running_version_unchanged') {
    return 'The version did not change. Restart this server, or install it again.';
  }
  if (triage.reason === 'running_version_changed') {
    return 'The version changed, but the new feature is missing. Check that the whole update actually reached this server.';
  }
  if (triage.reason === 'launcher_update_required') {
    return 'Update the launcher that starts your server, then restart it.';
  }
  if (triage.reason === 'self_update_unavailable') {
    return 'Update this server the way you installed it. It cannot update itself from here.';
  }
  if (triage.reason === 'current_build_missing_capability') {
    return 'The update service says this is the newest version. Check the update file, and check you picked the right server.';
  }
  if (triage.checkStatus === 'bad-signature') {
    return 'Do not install from this update service. Check the server’s trusted update key and the update’s signature first.';
  }
  if (triage.checkStatus === 'replay') {
    return 'The server turned down an older update. Point it at an up-to-date update service, then check again.';
  }
  if (triage.checkStatus === 'stale-feed') {
    return 'Run the installer on this server again so it can check for updates properly, then check again.';
  }
  if (triage.checkStatus === 'fetch-failed') {
    return 'Check that this server can reach the internet, and that its update address is right.';
  }
  return 'Check you picked the right server. Then check it is reachable, and that its update settings are right.';
};

const diagnosticLine = (value: string): string => value
  .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, 240);

const diagnosticServerHost = (serverUrl: string | null | undefined): string => {
  if (serverUrl === null || serverUrl === undefined) return 'unavailable';
  try {
    return diagnosticLine(new URL(serverUrl).host) || 'unavailable';
  } catch {
    return 'unavailable';
  }
};

/** Owner-reviewed diagnostic for an administrator. It intentionally excludes
 * raw errors, URL paths/query/fragment, profile tokens, connection config,
 * credentials, and form values. */
export const buildAccountServerUpdateDiagnostic = (options: {
  connectionIdentity: string;
  profileLabel?: string | null;
  serverUrl?: string | null;
  triage: ConnectionsServerUpdateTriage;
}): string => {
  const triage = options.triage;
  return [
    'Recued server details',
    `Connection: ${diagnosticLine(options.connectionIdentity)}`,
    `Server you picked: ${diagnosticLine(options.profileLabel ?? '') || 'unnamed'}`,
    `Server host: ${diagnosticServerHost(options.serverUrl)}`,
    'Missing feature: collection.connection.credentialRotationActivity',
    `Diagnosis: ${triage.reason.replaceAll('_', ' ')}`,
    `Version running now: ${diagnosticLine(triage.currentVersion ?? '') || 'unconfirmed'}`,
    `Before update: ${diagnosticLine(triage.baselineVersion ?? '') || 'unconfirmed'}`,
    `Channel: ${triage.channel ?? 'unconfirmed'}`,
    `Update check said: ${triage.checkStatus.replaceAll('-', ' ')}`,
    `Version available: ${diagnosticLine(triage.availableVersion ?? '') || 'none reported'}`,
  ].join('\n');
};

/** Owner-reviewed recovery handoff for an unresolved update receipt. The
 * opaque receipt, raw error, URL path/query, tokens, and versions are omitted. */
export const buildAccountServerUpdateReceiptDiagnostic = (options: {
  connectionIdentity: string;
  profileLabel?: string | null;
  serverUrl?: string | null;
  verification: ServerUpdateReceiptVerificationState;
}): string => buildServerUpdateReceiptDiagnostic(options);

export interface MountAccountMenuOptions {
  /** Topbar slot the trigger + popover are appended to. */
  host: HTMLElement;
  document?: Document;
  /** Roster for the servers row. */
  profiles: ReadonlyArray<WebclientServerProfile>;
  activeProfileId: string | null;
  /** True while the ACTIVE server is unreachable — drives the badge. */
  unreachable?: boolean;
  /** True while the ACTIVE server has an authenticated live connection.
   *  Required before the profile list can offer server-side self-revoke. */
  activeConnected?: boolean;
  /** Clock seam for the profile list's relative last-connected copy. */
  now?: () => number;
  onSwitch: (
    id: string,
    reviewedWorkState: ServerSwitchWorkState,
    reviewedActiveWork?: ReadonlyArray<ServerSwitchActiveWork>,
  ) => void | Promise<void>;
  /** Reports whether the mounted route owns work that a reload would discard. */
  switchWorkState?: () => ServerSwitchWorkState;
  /** Named active actions and their source-route return addresses. */
  switchActiveWork?: () => ReadonlyArray<ServerSwitchActiveWork>;
  activeWork?: ReadonlyArray<ServerSwitchActiveWork>;
  onReturnToWork?: (href: string) => void;
  /** Re-arm a one-shot capability result as a durable exact retry
   * immediately before navigation. Other guide phases are ignored by boot. */
  onResumeServerUpdateGuide?: (guide: AccountServerUpdateGuide) => void;
  /** Retire a durable server-update continuation when the owner explicitly
   * dismisses it. Route navigation does not count as dismissal. */
  onDismissServerUpdateGuide?: (guide: AccountServerUpdateGuide) => void;
  /** Explicitly retry the exact opaque receipt against the selected server. */
  onRetryServerUpdateReceipt?: () => void;
  /** Advance a durable unresolved closure through a fresh current-state read
   * and reviewed browser-latch retirement. No update/rollback is repeated. */
  onFinishServerUpdateReceiptClosure?: () => void;
  /** Rename a locally saved profile. No server connection is required. */
  onRename?: (
    id: string,
    label: string,
  ) => string | void | Promise<string | void>;
  onRemove?: (
    id: string,
    mode: ServerProfileRemovalMode,
  ) => void | Promise<void>;
  /** Pair an ADDITIONAL server. Absent ⇒ the entry is not rendered.
   *
   *  Safe to wire only because the pair form now offers a way back: reaching
   *  it means leaving this shell, and without a return an owner who changed
   *  their mind would be stranded there with no route to the server that
   *  still works — the exact dead end this whole surface removed. */
  onAddServer?: () => void;
  /** Href for the Settings entry in the quick row. */
  settingsHref: string;
  /** Explicit clipboard handoff for the owner-reviewed safe diagnostic. When
   * absent the summary remains keyboard-focusable for manual copy. */
  serverUpdateDiagnosticWriter?: (summary: string) => Promise<void>;
  /** Called only when an open Account dialog is intentionally closed. Shell
   * disposal is not a dismissal. */
  onClose?: () => void;
  /** Reports whether an ephemeral bounded-verification diagnosis was merely
   * closed or deliberately returned to its explicit Attention outcome. */
  onConnectionDiagnosisClosed?: (
    diagnosis: AccountConnectionDiagnosis,
    disposition: AccountConnectionDiagnosisDisposition,
    serverOutcome?: ServerControlActionOutcome,
    currentState?: ServerControlCurrentStateObservation,
  ) => void;
  /** Open the real active-server status/control surface. The callback returns
   * focus to the diagnosis after Escape, outside click, or a connection drop. */
  onReviewConnectionDiagnosisServerControls?: (
    diagnosis: AccountConnectionDiagnosis,
    handoff: ServerControlDiagnosisHandoff,
  ) => 'opened' | 'unavailable';
  /** Atomically read the exact active profile's stable heartbeat state. This
   * is a separate observation from the historical action receipt. */
  onReadConnectionDiagnosisServerCurrentState?: (
    diagnosis: AccountConnectionDiagnosis,
  ) => ServerControlCurrentStateObservation | null;
}

export interface AccountMenuMount {
  isOpen(): boolean;
  /** Open and focus the account dialog from outside. The outage banner calls
   *  this, so its alert and the exact recovery surface are one gesture apart. */
  open(): void;
  /** Close for an external exact landing. Focus rests on the stable Account
   * trigger until the caller's authoritative destination is ready. Returns
   * false when a committed profile action still owns this dialog. */
  close(): boolean;
  /** Open Account and focus one exact profile without selecting it. The owner
   * still activates the row and reviews the existing switch confirmation. */
  openServerProfile(
    profileId: string,
  ): 'opened' | 'missing' | 'unavailable';
  /** Whether the exact diagnosis can take Account ownership now. A committed
   * profile mutation keeps its current controls and focus until it settles. */
  canOpenConnectionDiagnosis(profileId: string): boolean;
  /** Open an exact, non-durable connection-diagnosis landing. Merely closing
   * it never claims resolution or releases the caller's persisted bound. */
  openConnectionDiagnosis(
    diagnosis: AccountConnectionDiagnosis,
    options?: AccountConnectionDiagnosisOpenOptions,
  ): 'opened' | 'unavailable';
  /** Remove a stale diagnosis without closing Account. Focus falls back to the
   * dialog if the removed cue currently owns it. */
  clearConnectionDiagnosis(): void;
  /** Heartbeat-backed availability from the mounted server control owner.
   * The profile id binds that live socket to the diagnosis: a sibling-written
   * active pointer must never relabel this tab's still-mounted controls. */
  setConnectionDiagnosisControlAvailability(
    profileId: string | null,
    available: boolean,
  ): void;
  /** Stronger availability for closing an unresolved receipt against current
   * server state. Kept separate so an in-flight action can leave controls
   * visible while reconciliation remains disabled. */
  setConnectionDiagnosisCurrentStateAvailability(
    profileId: string | null,
    available: boolean,
  ): void;
  /** Open the persistent server-update guide and focus its heading. Closing
   * Account keeps it discoverable until a stable retry landing or dismissal. */
  openServerUpdateGuide(guide: AccountServerUpdateGuide): void;
  /** Restore or retire the guide without opening Account. Boot continuity and
   * exact retry settlement use this so a reload never forces a popover. */
  setServerUpdateGuide(guide: AccountServerUpdateGuide | null): void;
  /** The slot the caller mounts the theme toggle into. */
  themeSlot(): HTMLElement;
  /** The slot the caller mounts the server-status pill into. The pill is not
   *  a readout — it carries the D-188 pause / restart controls — so removing
   *  it from the topbar means rehoming it, not deleting it. */
  serverSlot(): HTMLElement;
  /** Update the roster and/or the reachability that drives the badge. */
  refresh(
    profiles: ReadonlyArray<WebclientServerProfile>,
    activeProfileId: string | null,
    unreachable?: boolean,
    activeConnected?: boolean,
  ): void;
  /** Update only the badge — the common case, since connection status changes
   *  far more often than the roster does. */
  setUnreachable(unreachable: boolean): void;
  /** Update the stronger authenticated-connection fact used to gate revoke. */
  setActiveConnected(connected: boolean): void;
  /** Keep route-independent work/results visible while their source route is
   * unmounted. */
  setActiveWork(work: ReadonlyArray<ServerSwitchActiveWork>): void;
  dispose(): void;
}

export const ACCOUNT_MENU_STYLES = `
[${ACCOUNT_MENU_ATTR}] { position: relative; display: inline-flex; align-items: center; }
[${ACCOUNT_MENU_ATTR}] *,
[${ACCOUNT_MENU_ATTR}] *::before,
[${ACCOUNT_MENU_ATTR}] *::after { box-sizing: border-box; }
[${ACCOUNT_MENU_TRIGGER_ATTR}] {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
[${ACCOUNT_MENU_TRIGGER_ATTR}]:hover { background: var(--recued-surface-hover, rgba(127,127,127,0.12)); }
[${ACCOUNT_MENU_TRIGGER_ATTR}]:focus-visible { outline: 2px solid var(--recued-focus, #4c8dff); outline-offset: 2px; }
[${ACCOUNT_MENU_BADGE_ATTR}] {
  position: absolute;
  top: 1px;
  right: 1px;
  display: none;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: var(--recued-danger, #b3261e);
  color: #fff;
  font-size: 9px;
  line-height: 1;
  font-weight: 700;
  /* Ring in the bar's own colour so the badge reads as attached to the glyph
     rather than floating over whatever is behind it. */
  box-shadow: 0 0 0 2px var(--recued-surface, #fff);
}
[${ACCOUNT_MENU_BADGE_ATTR}][data-state="unreachable"] { display: inline-flex; }
[${ACCOUNT_MENU_BADGE_ATTR}][data-state="working"],
[${ACCOUNT_MENU_BADGE_ATTR}][data-state="result-ready"] {
  display: inline-flex;
  background: var(--recued-accent, #147d9e);
}
[${ACCOUNT_MENU_BADGE_ATTR}][data-state="result-ready"] {
  background: var(--recued-success, #25834f);
}
[${ACCOUNT_MENU_POPOVER_ATTR}] {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 40;
  width: min(340px, calc(100vw - 16px));
  min-width: 0;
  max-height: calc(100vh - 68px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px;
  border-radius: 12px;
  border: 1px solid var(--recued-border, rgba(127,127,127,0.28));
  background: var(--recued-surface, #fff);
  box-shadow: 0 12px 32px rgba(0,0,0,0.18);
}
[${ACCOUNT_MENU_POPOVER_ATTR}][hidden] { display: none; }
[${ACCOUNT_MENU_POPOVER_ATTR}]:focus-visible {
  outline: 2px solid var(--recued-focus, #4c8dff);
  outline-offset: 2px;
}
[${ACCOUNT_MENU_TITLE_ATTR}] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 8px 6px;
}
[${ACCOUNT_MENU_TITLE_ATTR}] h2 {
  flex: 1 1 auto;
  margin: 0;
  font-size: 14px;
}
[${ACCOUNT_MENU_CLOSE_ATTR}] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin: -6px -2px -6px 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 20px;
  cursor: pointer;
}
[${ACCOUNT_MENU_CLOSE_ATTR}]:hover { background: var(--recued-surface-hover, rgba(127,127,127,0.12)); }
[${ACCOUNT_MENU_CLOSE_ATTR}]:focus-visible,
[${ACCOUNT_MENU_SETTINGS_ATTR}]:focus-visible,
[${ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR}]:focus-visible,
[${ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR}]:focus-visible,
[${ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR}]:focus-visible,
[${ACCOUNT_MENU_SERVER_UPDATE_RETRY_ATTR}]:focus-visible,
[${ACCOUNT_MENU_SERVER_UPDATE_DISMISS_ATTR}]:focus-visible,
[${ACCOUNT_MENU_ADD_SERVER_ATTR}]:focus-visible {
  outline: 2px solid var(--recued-focus, #4c8dff);
  outline-offset: 2px;
}
[${ACCOUNT_MENU_QUICK_ROW_ATTR}] {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--recued-border, rgba(127,127,127,0.2));
}
[${ACCOUNT_MENU_THEME_SLOT_ATTR}] { display: inline-flex; align-items: center; }
[${ACCOUNT_MENU_SETTINGS_ATTR}] {
  flex: 1 1 auto;
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 7px 8px;
  border-radius: 8px;
  color: inherit;
  text-decoration: none;
  font-size: 13px;
}
[${ACCOUNT_MENU_SETTINGS_ATTR}]:hover { background: var(--recued-surface-hover, rgba(127,127,127,0.12)); }
[${ACCOUNT_MENU_SERVER_SLOT_ATTR}]:not(:empty) {
  padding: 8px 6px;
  display: block;
  border-bottom: 1px solid var(--recued-border, rgba(127,127,127,0.2));
  scroll-margin-block: 12px;
}
[${ACCOUNT_MENU_SERVER_SLOT_ATTR}][hidden] { display: none; }
[${ACCOUNT_MENU_SERVER_SLOT_ATTR}][${ACCOUNT_MENU_SERVER_SLOT_DIAGNOSIS_TARGET_ATTR}] {
  border-radius: 8px;
  background: color-mix(in srgb, var(--recued-accent, #147d9e) 8%, transparent);
  outline: 2px solid color-mix(in srgb, var(--recued-accent, #147d9e) 52%, transparent);
  outline-offset: -2px;
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR}] {
  margin: 8px 0 0;
  padding: 10px 12px;
  border-left: 3px solid var(--warning, #9a6700);
  border-radius: 8px;
  background: var(--recued-surface-muted, #f6f7f9);
  background: color-mix(in srgb, var(--warning, #9a6700) 7%, var(--recued-surface, #fff));
  overflow-wrap: anywhere;
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR}][hidden] { display: none; }
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR}] h3,
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR}] p { margin: 0; }
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR}] h3 {
  color: var(--warning, #8a5a00);
  font-size: 13px;
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR}] p {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.45;
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS_ATTR}] { font-weight: 600; }
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR}] {
  padding: 8px 9px;
  border: 1px solid var(--recued-border, rgba(127,127,127,.24));
  border-radius: 7px;
  background: var(--recued-surface, #fff);
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR}][hidden] { display: none; }
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR}][data-phase="confirmed"] {
  border-color: color-mix(in srgb, var(--recued-accent, #147d9e) 45%, transparent);
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR}][data-phase="failed"],
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR}][data-phase="unconfirmed"],
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR}][data-phase="reconnected"],
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR}][data-phase="superseded"] {
  border-color: color-mix(in srgb, var(--warning, #9a6700) 48%, transparent);
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR}] .recued-account-connection-diagnosis-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 9px;
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS_ATTR}],
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR}],
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR}] {
  flex: 1 1 140px;
  min-height: 44px;
  border: 1px solid var(--recued-accent-border, rgba(63, 99, 255, .4));
  border-radius: 7px;
  padding: 6px 10px;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS_ATTR}] {
  background: transparent;
  color: var(--recued-accent, #147d9e);
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR}],
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR}] {
  background: var(--recued-accent, #3f63ff);
  color: #fff;
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR}]:not([hidden])
  + [${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR}] {
  background: transparent;
  color: var(--recued-fg-muted, #52525b);
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS_ATTR}][disabled],
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR}][disabled] {
  cursor: not-allowed;
  opacity: .7;
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR}][data-control-review="active"]
  [${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS_ATTR}][disabled] {
  opacity: 1;
  color: var(--recued-fg-muted, #52525b);
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS_ATTR}]:not([disabled]):hover {
  background: var(--recued-surface-hover, rgba(127,127,127,.12));
}
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR}]:not([disabled]):hover,
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR}]:hover { filter: brightness(.96); }
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS_ATTR}]:focus-visible,
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR}]:focus-visible,
[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR}]:focus-visible {
  outline: 2px solid var(--recued-focus, #4c8dff);
  outline-offset: 2px;
}
[${ACCOUNT_MENU_RECOVERY_ATTR}] {
  padding: 8px 6px 0;
  border-bottom: 1px solid var(--recued-border, rgba(127,127,127,0.2));
  padding-bottom: 8px;
}
[${ACCOUNT_MENU_RECOVERY_ATTR}][hidden] { display: none; }
[${ACCOUNT_MENU_RECOVERY_ATTR}] h3 {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--recued-danger, #b3261e);
}
[${ACCOUNT_MENU_RECOVERY_ATTR}] p { margin: 0 0 6px; font-size: 12px; opacity: 0.8; }
[${ACCOUNT_MENU_RECOVERY_STEPS_ATTR}] {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  opacity: 0.8;
}
[${ACCOUNT_MENU_SERVERS_ROW_ATTR}] { padding-top: 8px; }
[${ACCOUNT_MENU_ADD_SERVER_ATTR}] {
  width: 100%;
  min-height: 44px;
  margin-top: 6px;
  padding: 7px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
[${ACCOUNT_MENU_ADD_SERVER_ATTR}]:hover { background: var(--recued-surface-hover, rgba(127,127,127,0.12)); }
[${ACCOUNT_MENU_SERVERS_ROW_ATTR}] h3 {
  margin: 0 6px 6px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.7;
}
[${ACCOUNT_MENU_SERVERS_DETAIL_ATTR}] {
  margin: -2px 6px 7px;
  font-size: 11px;
  line-height: 1.4;
  opacity: 0.68;
}
[${ACCOUNT_MENU_ACTIVE_WORK_ATTR}] {
  margin: 8px 0;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--recued-accent, #147d9e) 30%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--recued-accent, #147d9e) 7%, transparent);
}
[${ACCOUNT_MENU_ACTIVE_WORK_ATTR}] h3,
[${ACCOUNT_MENU_ACTIVE_WORK_ATTR}] p { margin: 0; }
[${ACCOUNT_MENU_ACTIVE_WORK_ATTR}] h3 { font-size: 12px; }
[${ACCOUNT_MENU_ACTIVE_WORK_ATTR}] p {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.4;
  opacity: .72;
}
[${ACCOUNT_MENU_ACTIVE_WORK_ATTR}] ul {
  display: grid;
  gap: 6px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
[${ACCOUNT_MENU_ACTIVE_WORK_ITEM_ATTR}] {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-size: 11px;
  font-weight: 650;
}
[${ACCOUNT_MENU_ACTIVE_WORK_ITEM_ATTR}] > span {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
[${ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR}] {
  flex: 0 0 auto;
  min-height: 44px;
  padding: 6px 9px;
  border: 1px solid var(--recued-border, rgba(127,127,127,.28));
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}
[${ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR}]:hover {
  background: var(--recued-surface-hover, rgba(127,127,127,.12));
}
[${ACCOUNT_MENU_SERVER_UPDATE_ATTR}] {
  margin: 8px 0;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--recued-accent, #147d9e) 34%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--recued-accent, #147d9e) 8%, transparent);
}
[${ACCOUNT_MENU_SERVER_UPDATE_ATTR}][hidden] { display: none; }
[${ACCOUNT_MENU_SERVER_UPDATE_ATTR}] h3,
[${ACCOUNT_MENU_SERVER_UPDATE_ATTR}] p { margin: 0; }
[${ACCOUNT_MENU_SERVER_UPDATE_ATTR}] h3 { font-size: 12px; }
[${ACCOUNT_MENU_SERVER_UPDATE_ATTR}] p {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.45;
}
[${ACCOUNT_MENU_SERVER_UPDATE_STEPS_ATTR}] {
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 11px;
  line-height: 1.4;
}
[${ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR}] { opacity: .76; }
.recued-account-server-update-diagnostic {
  display: grid;
  gap: 6px;
  margin-top: 9px;
  padding-top: 9px;
  border-top: 1px solid color-mix(in srgb, var(--recued-accent, #147d9e) 24%, transparent);
}
.recued-account-server-update-diagnostic[hidden] { display: none; }
.recued-account-server-update-diagnostic pre {
  max-width: 100%;
  margin: 0;
  padding: 8px;
  overflow: auto;
  border-radius: 6px;
  background: var(--recued-surface-sunken, rgba(0,0,0,.06));
  font: 10px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.recued-account-server-update-diagnostic pre:focus-visible {
  outline: 2px solid var(--recued-accent, #147d9e);
  outline-offset: 2px;
}
.recued-account-server-update-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}
[${ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR}],
[${ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR}],
[${ACCOUNT_MENU_SERVER_UPDATE_RETRY_ATTR}],
[${ACCOUNT_MENU_SERVER_UPDATE_DISMISS_ATTR}],
[${ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_COPY_ATTR}] {
  min-height: 44px;
  padding: 7px 10px;
  border: 1px solid var(--recued-border, rgba(127,127,127,.28));
  border-radius: 7px;
  color: inherit;
  font: inherit;
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}
[${ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR}] {
  background: var(--recued-accent, #147d9e);
  border-color: var(--recued-accent, #147d9e);
  color: #fff;
}
[${ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR}],
[${ACCOUNT_MENU_SERVER_UPDATE_RETRY_ATTR}],
[${ACCOUNT_MENU_SERVER_UPDATE_DISMISS_ATTR}],
[${ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_COPY_ATTR}] { background: transparent; }
[${ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR}]:hover { filter: brightness(.96); }
[${ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR}]:hover,
[${ACCOUNT_MENU_SERVER_UPDATE_RETRY_ATTR}]:hover,
[${ACCOUNT_MENU_SERVER_UPDATE_DISMISS_ATTR}]:hover,
[${ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_COPY_ATTR}]:hover {
  background: var(--recued-surface-hover, rgba(127,127,127,.12));
}
@media (prefers-color-scheme: dark) {
  [${ACCOUNT_MENU_POPOVER_ATTR}] { background: var(--recued-surface, #1b1b1f); }
  [${ACCOUNT_MENU_BADGE_ATTR}] { box-shadow: 0 0 0 2px var(--recued-surface, #1b1b1f); }
  [${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR}] {
    background: color-mix(in srgb, var(--warning, #9a6700) 10%, var(--recued-surface, #1b1b1f));
  }
  [${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR}] h3 {
    color: var(--recued-warning-on-dark, #f2c15c);
  }
}
`;

const focusElement = (element: HTMLElement): void => {
  const focus = (element as { focus?: () => void }).focus;
  if (typeof focus !== 'function') return;
  try {
    focus.call(element);
  } catch {
    /* detached / fake DOM — focus restoration is best-effort */
  }
};

const nodeIsInside = (
  container: HTMLElement,
  target: EventTarget | null,
): boolean => {
  if (target === null) return false;
  const contains = (container as { contains?: (node: Node) => boolean }).contains;
  if (typeof contains !== 'function') return false;
  try {
    return contains.call(container, target as Node);
  } catch {
    return false;
  }
};

export const mountAccountMenu = (
  opts: MountAccountMenuOptions,
): AccountMenuMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountAccountMenu: no document available — pass `opts.document` for non-browser environments',
    );
  }

  let unreachable = opts.unreachable === true;
  let activeConnected = opts.activeConnected === true;
  // Current roster, tracked here rather than read back off `opts`: a badge
  // update must not re-render the list from the roster this menu was BUILT
  // with, or a switch followed by an outage would repaint the stale list.
  let profiles = opts.profiles;
  let activeId = opts.activeProfileId;
  let activeWork = opts.activeWork?.map((work) => ({ ...work })) ?? [];
  let serverUpdateGuide: AccountServerUpdateGuide | null = null;
  let serverUpdateFinishReturnRequested = false;

  const root = doc.createElement('div');
  root.setAttribute(ACCOUNT_MENU_ATTR, '');

  const trigger = doc.createElement('button');
  trigger.setAttribute('type', 'button');
  trigger.setAttribute(ACCOUNT_MENU_TRIGGER_ATTR, '');
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', ACCOUNT_MENU_POPOVER_ID);
  trigger.setAttribute('aria-expanded', 'false');
  const glyph = doc.createElement('span');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.innerHTML = ACCOUNT_ICON_SVG;
  trigger.appendChild(glyph);
  const badge = doc.createElement('span');
  badge.setAttribute(ACCOUNT_MENU_BADGE_ATTR, '');
  // Decorative: the state it announces lives in the trigger's aria-label, so
  // a screen reader hears one sentence instead of a stray "x".
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = '×';
  trigger.appendChild(badge);
  root.appendChild(trigger);

  const popover = doc.createElement('div');
  popover.setAttribute(ACCOUNT_MENU_POPOVER_ATTR, '');
  popover.setAttribute('id', ACCOUNT_MENU_POPOVER_ID);
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-modal', 'false');
  popover.setAttribute('aria-labelledby', ACCOUNT_MENU_TITLE_ID);
  popover.setAttribute('tabindex', '-1');
  popover.setAttribute('hidden', '');

  const titleRow = doc.createElement('div');
  titleRow.setAttribute(ACCOUNT_MENU_TITLE_ATTR, '');
  const title = doc.createElement('h2');
  title.setAttribute('id', ACCOUNT_MENU_TITLE_ID);
  title.textContent = 'Account & servers';
  titleRow.appendChild(title);
  const closeButton = doc.createElement('button');
  closeButton.setAttribute('type', 'button');
  closeButton.setAttribute(ACCOUNT_MENU_CLOSE_ATTR, '');
  closeButton.setAttribute('aria-label', 'Close your account and servers');
  closeButton.textContent = '×';
  titleRow.appendChild(closeButton);
  popover.appendChild(titleRow);

  // Row 1 — quick actions.
  const quickRow = doc.createElement('div');
  quickRow.setAttribute(ACCOUNT_MENU_QUICK_ROW_ATTR, '');
  const themeSlot = doc.createElement('span');
  themeSlot.setAttribute(ACCOUNT_MENU_THEME_SLOT_ATTR, '');
  quickRow.appendChild(themeSlot);
  const settingsLink = doc.createElement('a');
  settingsLink.setAttribute(ACCOUNT_MENU_SETTINGS_ATTR, '');
  settingsLink.setAttribute('href', opts.settingsHref);
  settingsLink.textContent = 'Settings';
  quickRow.appendChild(settingsLink);
  popover.appendChild(quickRow);

  // Route-independent continuation. A request can outlive the panel that
  // started it; keep its plain-language identity and exact return route in the
  // Account surface instead of making server switching the only discovery path.
  const activeWorkSection = doc.createElement('section');
  activeWorkSection.setAttribute(ACCOUNT_MENU_ACTIVE_WORK_ATTR, '');
  activeWorkSection.setAttribute('aria-labelledby', 'recued-account-active-work-title');
  activeWorkSection.setAttribute('hidden', '');
  const activeWorkTitle = doc.createElement('h3');
  activeWorkTitle.setAttribute('id', 'recued-account-active-work-title');
  activeWorkTitle.textContent = 'Work on this server';
  activeWorkSection.appendChild(activeWorkTitle);
  const activeWorkDetail = doc.createElement('p');
  activeWorkSection.appendChild(activeWorkDetail);
  const activeWorkList = doc.createElement('ul');
  activeWorkSection.appendChild(activeWorkList);
  popover.appendChild(activeWorkSection);

  // Targeted server-update detour. It lives in Account because the selected
  // profile, local server roster, and connection status are already here; the
  // guide never asks for or stores a provider credential.
  const serverUpdateSection = doc.createElement('section');
  serverUpdateSection.setAttribute(ACCOUNT_MENU_SERVER_UPDATE_ATTR, '');
  serverUpdateSection.setAttribute(
    'aria-labelledby',
    ACCOUNT_MENU_SERVER_UPDATE_TITLE_ID,
  );
  serverUpdateSection.setAttribute('hidden', '');
  const serverUpdateTitle = doc.createElement('h3');
  serverUpdateTitle.setAttribute('id', ACCOUNT_MENU_SERVER_UPDATE_TITLE_ID);
  serverUpdateTitle.setAttribute('tabindex', '-1');
  serverUpdateTitle.textContent = 'Update this server';
  serverUpdateSection.appendChild(serverUpdateTitle);
  const serverUpdateDetail = doc.createElement('p');
  serverUpdateSection.appendChild(serverUpdateDetail);
  const serverUpdateSteps = doc.createElement('ol');
  serverUpdateSteps.setAttribute(ACCOUNT_MENU_SERVER_UPDATE_STEPS_ATTR, '');
  const serverUpdateStepNodes: HTMLElement[] = [];
  for (const copy of [
    'Leave this server picked.',
    'Open Server Updates and install the update. If it cannot update itself, update it the way you installed it.',
    'Wait for this tab to reconnect, then come back here. Recued will check the server and the saved connection again.',
  ]) {
    const step = doc.createElement('li');
    step.textContent = copy;
    serverUpdateSteps.appendChild(step);
    serverUpdateStepNodes.push(step);
  }
  serverUpdateSection.appendChild(serverUpdateSteps);
  const serverUpdateStatus = doc.createElement('p');
  serverUpdateStatus.setAttribute(ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR, '');
  serverUpdateStatus.setAttribute('role', 'status');
  serverUpdateStatus.setAttribute('aria-live', 'polite');
  serverUpdateSection.appendChild(serverUpdateStatus);
  const serverUpdatePrivacy = doc.createElement('p');
  serverUpdatePrivacy.textContent =
    'This guide never keeps or sends a new key.';
  serverUpdateSection.appendChild(serverUpdatePrivacy);
  const serverUpdateActions = doc.createElement('div');
  serverUpdateActions.className = 'recued-account-server-update-actions';
  const serverUpdateOpen = doc.createElement('button');
  serverUpdateOpen.setAttribute('type', 'button');
  serverUpdateOpen.setAttribute(ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR, '');
  serverUpdateOpen.textContent = 'Open Server Updates';
  serverUpdateActions.appendChild(serverUpdateOpen);
  const serverUpdateReturn = doc.createElement('button');
  serverUpdateReturn.setAttribute('type', 'button');
  serverUpdateReturn.setAttribute(ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR, '');
  serverUpdateReturn.textContent = 'Go back and check again';
  serverUpdateActions.appendChild(serverUpdateReturn);
  const serverUpdateRetry = doc.createElement('button');
  serverUpdateRetry.setAttribute('type', 'button');
  serverUpdateRetry.setAttribute(ACCOUNT_MENU_SERVER_UPDATE_RETRY_ATTR, '');
  serverUpdateRetry.textContent = 'Check the result again';
  serverUpdateRetry.setAttribute('hidden', '');
  serverUpdateActions.appendChild(serverUpdateRetry);
  const serverUpdateDismiss = doc.createElement('button');
  serverUpdateDismiss.setAttribute('type', 'button');
  serverUpdateDismiss.setAttribute(ACCOUNT_MENU_SERVER_UPDATE_DISMISS_ATTR, '');
  serverUpdateDismiss.textContent = 'Not now';
  serverUpdateActions.appendChild(serverUpdateDismiss);
  serverUpdateSection.appendChild(serverUpdateActions);
  const serverUpdateDiagnostic = doc.createElement('section');
  serverUpdateDiagnostic.className = 'recued-account-server-update-diagnostic';
  serverUpdateDiagnostic.setAttribute(
    ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_ATTR,
    '',
  );
  serverUpdateDiagnostic.setAttribute('hidden', '');
  const serverUpdateDiagnosticPrivacy = doc.createElement('p');
  serverUpdateDiagnosticPrivacy.textContent =
    'Read this before you show it to whoever looks after this server. Recued sends nothing by itself. It shows the server’s name and address. It leaves out keys, connection settings, error details, and web addresses.';
  serverUpdateDiagnostic.appendChild(serverUpdateDiagnosticPrivacy);
  const serverUpdateDiagnosticSummary = doc.createElement('pre');
  serverUpdateDiagnosticSummary.setAttribute(
    ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_SUMMARY_ATTR,
    '',
  );
  serverUpdateDiagnosticSummary.setAttribute('tabindex', '0');
  serverUpdateDiagnosticSummary.setAttribute(
    'aria-label',
    'Server details, with nothing private in them',
  );
  serverUpdateDiagnostic.appendChild(serverUpdateDiagnosticSummary);
  const serverUpdateDiagnosticCopy = doc.createElement('button');
  serverUpdateDiagnosticCopy.setAttribute('type', 'button');
  serverUpdateDiagnosticCopy.setAttribute(
    ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_COPY_ATTR,
    '',
  );
  serverUpdateDiagnosticCopy.textContent = 'Copy the details';
  serverUpdateDiagnostic.appendChild(serverUpdateDiagnosticCopy);
  const serverUpdateDiagnosticStatus = doc.createElement('p');
  serverUpdateDiagnosticStatus.setAttribute(
    ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_STATUS_ATTR,
    '',
  );
  serverUpdateDiagnosticStatus.setAttribute('role', 'status');
  serverUpdateDiagnosticStatus.setAttribute('aria-live', 'polite');
  serverUpdateDiagnosticStatus.setAttribute('tabindex', '-1');
  serverUpdateDiagnostic.appendChild(serverUpdateDiagnosticStatus);
  serverUpdateSection.appendChild(serverUpdateDiagnostic);
  popover.appendChild(serverUpdateSection);

  // One-shot orientation from a bounded post-review verification. The stable
  // heading owns focus while the live status below changes, so reconnects do
  // not strand focus in reconstructed server-pill content.
  const connectionDiagnosis = doc.createElement('section');
  connectionDiagnosis.setAttribute(ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR, '');
  connectionDiagnosis.setAttribute(
    'aria-labelledby',
    ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ID,
  );
  connectionDiagnosis.setAttribute('hidden', '');
  const connectionDiagnosisTitle = doc.createElement('h3');
  connectionDiagnosisTitle.setAttribute(
    'id',
    ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ID,
  );
  connectionDiagnosisTitle.setAttribute(
    ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ATTR,
    '',
  );
  connectionDiagnosisTitle.setAttribute('tabindex', '-1');
  connectionDiagnosisTitle.setAttribute(
    'aria-describedby',
    `${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_DETAIL_ID} ${
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS_ID
    }`,
  );
  connectionDiagnosis.appendChild(connectionDiagnosisTitle);
  const connectionDiagnosisDetail = doc.createElement('p');
  connectionDiagnosisDetail.setAttribute(
    'id',
    ACCOUNT_MENU_CONNECTION_DIAGNOSIS_DETAIL_ID,
  );
  connectionDiagnosis.appendChild(connectionDiagnosisDetail);
  const connectionDiagnosisStatus = doc.createElement('p');
  connectionDiagnosisStatus.setAttribute(
    'id',
    ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS_ID,
  );
  connectionDiagnosisStatus.setAttribute(
    ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS_ATTR,
    '',
  );
  connectionDiagnosisStatus.setAttribute('role', 'status');
  connectionDiagnosisStatus.setAttribute('aria-live', 'polite');
  connectionDiagnosisStatus.setAttribute('aria-atomic', 'true');
  connectionDiagnosis.appendChild(connectionDiagnosisStatus);
  const connectionDiagnosisReceipt = doc.createElement('p');
  connectionDiagnosisReceipt.setAttribute(
    ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR,
    '',
  );
  connectionDiagnosisReceipt.setAttribute('role', 'status');
  connectionDiagnosisReceipt.setAttribute('aria-live', 'polite');
  connectionDiagnosisReceipt.setAttribute('aria-atomic', 'true');
  connectionDiagnosisReceipt.setAttribute('hidden', '');
  connectionDiagnosis.appendChild(connectionDiagnosisReceipt);
  const connectionDiagnosisActions = doc.createElement('div');
  connectionDiagnosisActions.className =
    'recued-account-connection-diagnosis-actions';
  const connectionDiagnosisControls = doc.createElement('button');
  connectionDiagnosisControls.setAttribute('type', 'button');
  connectionDiagnosisControls.setAttribute(
    ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS_ATTR,
    '',
  );
  connectionDiagnosisControls.textContent = 'Waiting for the server controls…';
  connectionDiagnosisControls.setAttribute('disabled', '');
  connectionDiagnosisActions.appendChild(connectionDiagnosisControls);
  const connectionDiagnosisReconcile = doc.createElement('button');
  connectionDiagnosisReconcile.setAttribute('type', 'button');
  connectionDiagnosisReconcile.setAttribute(
    ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR,
    '',
  );
  connectionDiagnosisReconcile.textContent = 'Waiting to hear how the server is doing…';
  connectionDiagnosisReconcile.setAttribute('disabled', '');
  connectionDiagnosisReconcile.setAttribute('hidden', '');
  connectionDiagnosisActions.appendChild(connectionDiagnosisReconcile);
  const connectionDiagnosisReturn = doc.createElement('button');
  connectionDiagnosisReturn.setAttribute('type', 'button');
  connectionDiagnosisReturn.setAttribute(
    ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
    '',
  );
  connectionDiagnosisReturn.textContent = 'Say what you found';
  connectionDiagnosisActions.appendChild(connectionDiagnosisReturn);
  connectionDiagnosis.appendChild(connectionDiagnosisActions);
  popover.appendChild(connectionDiagnosis);

  // Row 2a — the outage explainer. Present only while unreachable; the badge
  // says SOMETHING is wrong, and this is where it says what.
  const recovery = doc.createElement('section');
  recovery.setAttribute(ACCOUNT_MENU_RECOVERY_ATTR, '');
  recovery.setAttribute('aria-labelledby', ACCOUNT_MENU_RECOVERY_TITLE_ID);
  recovery.setAttribute('hidden', '');
  const recoveryTitle = doc.createElement('h3');
  recoveryTitle.setAttribute('id', ACCOUNT_MENU_RECOVERY_TITLE_ID);
  recoveryTitle.setAttribute('tabindex', '-1');
  recoveryTitle.textContent = RECOVERY_TITLE;
  recovery.appendChild(recoveryTitle);
  const recoveryDetail = doc.createElement('p');
  recovery.appendChild(recoveryDetail);
  const recoverySteps = doc.createElement('ol');
  recoverySteps.setAttribute(ACCOUNT_MENU_RECOVERY_STEPS_ATTR, '');
  for (const copy of RECOVERY_STEPS) {
    const step = doc.createElement('li');
    step.textContent = copy;
    recoverySteps.appendChild(step);
  }
  recovery.appendChild(recoverySteps);
  popover.appendChild(recovery);

  // Row 2 — this server: the status pill and, behind it, pause / restart.
  // Empty and zero-height while the pill hides itself (it stays quiet unless
  // connected), so an offline menu shows no hollow band.
  const serverSlot = doc.createElement('div');
  serverSlot.setAttribute(ACCOUNT_MENU_SERVER_SLOT_ATTR, '');
  serverSlot.setAttribute('role', 'group');
  serverSlot.setAttribute('aria-label', 'How this server is doing, and its controls');
  popover.appendChild(serverSlot);

  // Row 3 — servers.
  const serversRow = doc.createElement('div');
  serversRow.setAttribute(ACCOUNT_MENU_SERVERS_ROW_ATTR, '');
  const serversTitle = doc.createElement('h3');
  serversTitle.setAttribute('id', ACCOUNT_MENU_SERVERS_TITLE_ID);
  serversTitle.textContent = 'Server profiles';
  serversRow.appendChild(serversTitle);
  const serversDetail = doc.createElement('p');
  serversDetail.setAttribute(ACCOUNT_MENU_SERVERS_DETAIL_ATTR, '');
  serversDetail.textContent =
    'Names and recent use are kept only in this browser.';
  serversRow.appendChild(serversDetail);
  const addServer = doc.createElement('button');
  addServer.setAttribute('type', 'button');
  addServer.setAttribute(ACCOUNT_MENU_ADD_SERVER_ATTR, '');
  addServer.textContent = 'Add another server…';
  popover.appendChild(serversRow);
  root.appendChild(popover);
  opts.host.appendChild(root);

  let open = false;
  let disposed = false;
  let focusLeaveTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let activeConnectionDiagnosis: AccountConnectionDiagnosis | null = null;
  let connectionDiagnosisControlsAvailable = false;
  let connectionDiagnosisControlsProfileId: string | null = null;
  let connectionDiagnosisCurrentStateAvailable = false;
  let connectionDiagnosisCurrentStateProfileId: string | null = null;
  let connectionDiagnosisControlReview: {
    readonly diagnosisId: string;
    readonly phase: 'active' | 'returned';
  } | null = null;
  let connectionDiagnosisReviewMode:
    | 'bounded_verification'
    | 'expired_area_review'
    | 'unresolved_receipt' = 'bounded_verification';
  let connectionDiagnosisAutoOpenControlsId: string | null = null;
  let connectionDiagnosisControlReceipt: {
    readonly diagnosisId: string;
    readonly receipt: ServerControlActionReceipt;
  } | null = null;
  let reviewConnectionDiagnosisServerControls: () => boolean = () => false;
  let serverUpdateDiagnosticCopyInFlight = false;
  let serverUpdateDiagnosticGeneration = 0;

  const renderActiveWork = (): void => {
    const focusedElement = (
      doc as unknown as { activeElement?: HTMLElement | null }
    ).activeElement ?? null;
    const focusedWorkId = open
      && focusedElement !== null
      && nodeIsInside(activeWorkList, focusedElement)
      && focusedElement.hasAttribute(ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR)
      ? focusedElement.getAttribute('data-work-id')
      : null;
    let replacementFocus: HTMLElement | null = null;
    while (activeWorkList.firstChild !== null) {
      activeWorkList.removeChild(activeWorkList.firstChild);
    }
    if (activeWork.length === 0) {
      activeWorkSection.setAttribute('hidden', '');
      if (focusedWorkId !== null) focusElement(popover);
      return;
    }
    activeWorkSection.removeAttribute('hidden');
    const ready = activeWork.filter((work) => work.phase === 'result_ready').length;
    activeWorkDetail.textContent = ready === activeWork.length
      ? `${ready === 1 ? 'A result is' : 'Results are'} ready to look at before you leave this server.`
      : `${activeWork.length} ${activeWork.length === 1 ? 'action still needs' : 'actions still need'} this server.`;
    for (const work of activeWork) {
      const item = doc.createElement('li');
      item.setAttribute(ACCOUNT_MENU_ACTIVE_WORK_ITEM_ATTR, '');
      item.setAttribute('data-work-id', work.id);
      const label = doc.createElement('span');
      label.textContent = work.label;
      item.appendChild(label);
      if (work.returnHref !== undefined && opts.onReturnToWork !== undefined) {
        const returnHref = work.returnHref;
        const action = doc.createElement('button');
        action.setAttribute('type', 'button');
        action.setAttribute(ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR, '');
        action.setAttribute('data-work-id', work.id);
        action.textContent = work.returnLabel ?? 'Return to work';
        action.addEventListener('click', () => {
          setOpen(false, { returnFocus: true });
          opts.onReturnToWork?.(returnHref);
        });
        item.appendChild(action);
        if (work.id === focusedWorkId) replacementFocus = action;
      }
      activeWorkList.appendChild(item);
    }
    if (focusedWorkId !== null) focusElement(replacementFocus ?? popover);
  };

  const renderConnectionDiagnosis = (): void => {
    const diagnosis = activeConnectionDiagnosis;
    if (diagnosis === null) {
      connectionDiagnosis.setAttribute('hidden', '');
      connectionDiagnosis.removeAttribute('data-interruption-reason');
      connectionDiagnosis.removeAttribute('data-control-review');
      serverSlot.removeAttribute(
        ACCOUNT_MENU_SERVER_SLOT_DIAGNOSIS_TARGET_ATTR,
      );
      connectionDiagnosisTitle.textContent = '';
      connectionDiagnosisDetail.textContent = '';
      connectionDiagnosisStatus.textContent = '';
      connectionDiagnosisReceipt.textContent = '';
      connectionDiagnosisReceipt.setAttribute('hidden', '');
      connectionDiagnosisReceipt.removeAttribute('data-action');
      connectionDiagnosisReceipt.removeAttribute('data-phase');
      connectionDiagnosisControls.textContent =
        'Waiting for the server controls…';
      connectionDiagnosisControls.setAttribute('disabled', '');
      connectionDiagnosisControls.removeAttribute('aria-label');
      connectionDiagnosisReconcile.textContent =
        'Waiting to hear how the server is doing…';
      connectionDiagnosisReconcile.setAttribute('disabled', '');
      connectionDiagnosisReconcile.setAttribute('hidden', '');
      connectionDiagnosisReconcile.removeAttribute('aria-label');
      connectionDiagnosisReturn.textContent = 'Say what you found';
      connectionDiagnosisReturn.removeAttribute('aria-label');
      return;
    }
    const hydratedLabel = profiles.find(
      (profile) => profile.id === diagnosis.profileId,
    )?.label.trim();
    const profileLabel = hydratedLabel !== undefined && hydratedLabel.length > 0
      ? hydratedLabel
      : diagnosis.profileLabel;
    const unresolvedReceiptReview =
      connectionDiagnosisReviewMode === 'unresolved_receipt';
    const expiredAreaReview =
      connectionDiagnosisReviewMode === 'expired_area_review';
    const latestInterruption = diagnosis.interruptionReason === 'connection'
      ? 'The check stopped because the server connection changed.'
      : diagnosis.interruptionReason === 'navigation'
        ? 'The check stopped because this tab moved away.'
        : diagnosis.interruptionReason === 'ownership'
          ? 'The check stopped because you moved back to your work.'
          : 'The check stopped because the page reloaded.';
    connectionDiagnosis.removeAttribute('hidden');
    if (diagnosis.interruptionReason === undefined) {
      connectionDiagnosis.removeAttribute('data-interruption-reason');
    } else {
      connectionDiagnosis.setAttribute(
        'data-interruption-reason',
        diagnosis.interruptionReason,
      );
    }
    const controlReviewPhase =
      connectionDiagnosisControlReview?.diagnosisId === diagnosis.id
        ? connectionDiagnosisControlReview.phase
        : null;
    const controlsReady = connectionDiagnosisControlsAvailable
      && connectionDiagnosisControlsProfileId === diagnosis.profileId
      && activeConnected
      && !unreachable;
    const currentStateReady = unresolvedReceiptReview
      && connectionDiagnosisCurrentStateAvailable
      && connectionDiagnosisCurrentStateProfileId === diagnosis.profileId
      && activeConnected
      && !unreachable
      && !profileList.hasInFlightAction()
      && opts.onReadConnectionDiagnosisServerCurrentState !== undefined;
    const controlReceipt =
      connectionDiagnosisControlReceipt?.diagnosisId === diagnosis.id
        ? connectionDiagnosisControlReceipt.receipt
        : null;
    connectionDiagnosis.setAttribute(
      'data-control-review',
      controlReviewPhase ?? (controlsReady ? 'ready' : 'waiting'),
    );
    if (controlReviewPhase === 'active') {
      serverSlot.setAttribute(
        ACCOUNT_MENU_SERVER_SLOT_DIAGNOSIS_TARGET_ATTR,
        '',
      );
    } else {
      serverSlot.removeAttribute(
        ACCOUNT_MENU_SERVER_SLOT_DIAGNOSIS_TARGET_ATTR,
      );
    }
    const reviewInstruction = unreachable
      ? 'Use the recovery steps and current profile below.'
      : controlReviewPhase === 'active'
        ? `The exact active-server controls for ${profileLabel} are open below.`
        : controlReviewPhase === 'returned'
          ? `You are back from the active-server controls for ${profileLabel}.`
          : controlsReady
            ? 'Use Look at the server controls to inspect the exact live state without starting an action.'
            : activeConnected
              ? 'The connection is up; Recued is waiting for one fresh server status before opening its controls.'
              : 'Watch the live status here; server controls will become available after the server responds.';
    connectionDiagnosisTitle.textContent = unresolvedReceiptReview
      ? `Review ${profileLabel} again`
      : expiredAreaReview
        ? `Review ${profileLabel} for ${diagnosis.areaLabel}`
        : `Check connection to ${profileLabel}`;
    connectionDiagnosisDetail.textContent = unresolvedReceiptReview
      ? `The last server-control receipt did not settle the result. ${reviewInstruction} Compare that receipt with the current live state, or deliberately choose a corrective action. When the state is stable, “Use what the server says now” closes only this receipt uncertainty; it does not claim the earlier request succeeded or verify ${diagnosis.areaLabel}. Nothing runs automatically.`
      : expiredAreaReview
        ? `Recued stopped after two unsuccessful current ${diagnosis.areaLabel} checks. ${reviewInstruction} This review will not retry ${diagnosis.areaLabel}, restore the expired return, or replay an action. When you finish, choose one fresh current-area check or close the review.`
        : `Verification stopped after two interruptions. ${latestInterruption} ${reviewInstruction} Opening Account does not retry verification or mark it resolved.`;
    const expiredAreaReviewStatus = controlReviewPhase === 'active'
      ? `${profileLabel} controls are open. Review the live state; no ${diagnosis.areaLabel} check or server action started.`
      : unreachable
        ? `${profileLabel} cannot be reached.`
        : !activeConnected
          ? `${profileLabel} is reconnecting or still being checked. Keep this dialog open to watch the live status; ${diagnosis.areaLabel} will not retry automatically.`
          : controlReviewPhase === 'returned'
            ? `${profileLabel} is connected now. Back from its controls; connection alone does not confirm ${diagnosis.areaLabel}.`
            : controlsReady
              ? `${profileLabel} is connected now. Review its exact active-server controls if useful; connection alone does not confirm ${diagnosis.areaLabel}.`
              : `${profileLabel} is connected now. Waiting for a fresh server status before its controls can open; connection alone does not confirm ${diagnosis.areaLabel}.`;
    connectionDiagnosisStatus.textContent = expiredAreaReview
      ? expiredAreaReviewStatus
      : controlReviewPhase === 'active'
        ? unresolvedReceiptReview
          ? currentStateReady
            ? `${profileLabel} has a stable current state ready to reconcile with the last receipt. Use it below; no server action is required. ${diagnosis.areaLabel} still needs its own check.`
            : `${profileLabel} controls are open. Compare the live state with the last receipt; no server action is required.`
          : `${profileLabel} controls are open. Review the live state; no server action is required.`
        : unreachable
          ? `${profileLabel} cannot be reached. Use the recovery steps below before reporting the outcome.`
          : !activeConnected
            ? `${profileLabel} is reconnecting or still being checked. Keep this dialog open if you want to watch the status settle.`
            : controlReviewPhase === 'returned'
              ? unresolvedReceiptReview
                ? currentStateReady
                  ? `${profileLabel} has a stable current state. Use it to reconcile the historical receipt, or return the receipt unchanged. ${diagnosis.areaLabel} still needs its own check.`
                  : `${profileLabel} is connected now. Back from its controls; the current state is still settling, so the receipt remains unresolved. Connection alone does not verify ${diagnosis.areaLabel}.`
                : `${profileLabel} is connected now. Back from its controls; review any result, then report what happened. Connection alone does not verify ${diagnosis.areaLabel}.`
              : controlsReady
                ? unresolvedReceiptReview
                  ? currentStateReady
                    ? `${profileLabel} has a stable current state ready to reconcile with the last receipt. This does not verify ${diagnosis.areaLabel}.`
                    : `${profileLabel} is connected now. Review its exact active-server controls against the last receipt; wait for any server action and a fresh status to settle. Connection alone does not verify ${diagnosis.areaLabel}.`
                  : `${profileLabel} is connected now. Review its exact active-server controls, then report what happened. Connection alone does not verify ${diagnosis.areaLabel}.`
                : `${profileLabel} is connected now. Waiting for a fresh server status before its controls can open. Connection alone does not verify ${diagnosis.areaLabel}.`;
    connectionDiagnosisControls.textContent = controlReviewPhase === 'active'
      ? 'Looking at the server controls'
      : controlReviewPhase === 'returned'
        ? 'Look at the server controls again'
        : controlsReady
          ? 'Look at the server controls'
          : 'Waiting for the server controls…';
    if (controlsReady && controlReviewPhase !== 'active') {
      connectionDiagnosisControls.removeAttribute('disabled');
    } else {
      connectionDiagnosisControls.setAttribute('disabled', '');
    }
    connectionDiagnosisControls.setAttribute(
      'aria-label',
      controlsReady
        ? `Look at the server controls for ${profileLabel}`
        : `The server controls for ${profileLabel} are not ready yet`,
    );
    if (unresolvedReceiptReview) {
      connectionDiagnosisReconcile.removeAttribute('hidden');
      connectionDiagnosisReconcile.textContent = currentStateReady
        ? 'Use what the server says now'
        : 'Waiting to hear how the server is doing…';
      if (currentStateReady) {
        connectionDiagnosisReconcile.removeAttribute('disabled');
      } else {
        connectionDiagnosisReconcile.setAttribute('disabled', '');
      }
      connectionDiagnosisReconcile.setAttribute(
        'aria-label',
        currentStateReady
          ? `Use the current stable server state from ${profileLabel} to reconcile the historical receipt; the earlier action is not attributed or replayed`
          : `A settled answer from ${profileLabel} has not arrived yet`,
      );
    } else {
      connectionDiagnosisReconcile.setAttribute('hidden', '');
      connectionDiagnosisReconcile.setAttribute('disabled', '');
      connectionDiagnosisReconcile.removeAttribute('aria-label');
    }
    connectionDiagnosisReturn.setAttribute(
      'aria-label',
      unresolvedReceiptReview
        ? `Keep the historical server receipt from ${profileLabel} unresolved in Attention for ${diagnosis.areaLabel}`
        : expiredAreaReview
          ? `Finish reviewing ${profileLabel}, then choose one current ${diagnosis.areaLabel} check or close the review`
          : `Return to Attention and report the connection review outcome for ${diagnosis.areaLabel}`,
    );
    connectionDiagnosisReturn.textContent = unresolvedReceiptReview
      ? 'Leave this unanswered'
      : expiredAreaReview
        ? 'Choose: check, or close'
        : 'Say what you found';
    if (controlReceipt === null) {
      connectionDiagnosisReceipt.textContent = '';
      connectionDiagnosisReceipt.setAttribute('hidden', '');
      connectionDiagnosisReceipt.removeAttribute('data-action');
      connectionDiagnosisReceipt.removeAttribute('data-phase');
    } else {
      const receiptCopy = serverControlReceiptCopy(
        controlReceipt,
        diagnosis.areaLabel,
      );
      connectionDiagnosisReceipt.textContent = unresolvedReceiptReview
        ? `Last receipt — ${receiptCopy}`
        : receiptCopy;
      connectionDiagnosisReceipt.setAttribute(
        'data-action',
        controlReceipt.action,
      );
      connectionDiagnosisReceipt.setAttribute(
        'data-phase',
        controlReceipt.phase,
      );
      connectionDiagnosisReceipt.removeAttribute('hidden');
    }
  };

  const clearConnectionDiagnosis = (): void => {
    const diagnosisHadFocus = open
      && activeConnectionDiagnosis !== null
      && nodeIsInside(
        connectionDiagnosis,
        (doc as unknown as { activeElement?: EventTarget | null })
          .activeElement ?? null,
    );
    activeConnectionDiagnosis = null;
    connectionDiagnosisControlReview = null;
    connectionDiagnosisReviewMode = 'bounded_verification';
    connectionDiagnosisAutoOpenControlsId = null;
    connectionDiagnosisControlReceipt = null;
    renderConnectionDiagnosis();
    if (diagnosisHadFocus) focusElement(popover);
  };

  const setConnectionDiagnosisControlAvailability = (
    profileId: string | null,
    available: boolean,
  ): void => {
    if (disposed) return;
    const controlsHadFocus = open
      && (doc as unknown as { activeElement?: EventTarget | null })
        .activeElement === connectionDiagnosisControls;
    const normalizedProfileId = profileId?.trim() ?? '';
    // Store the control owner's heartbeat signal independently of Account's
    // connection projection. If the heartbeat lands first, a later
    // `setActiveConnected(true)` can reveal it instead of waiting for another
    // frame that the server-pill owner correctly deduplicates.
    const next = available
      && normalizedProfileId.length > 0
      && normalizedProfileId.length <= 256
      && opts.onReviewConnectionDiagnosisServerControls !== undefined;
    const nextProfileId = next ? normalizedProfileId : null;
    const activeReview =
      activeConnectionDiagnosis !== null
      && connectionDiagnosisControlReview?.diagnosisId
        === activeConnectionDiagnosis.id
      && connectionDiagnosisControlReview.phase === 'active';
    const activeDiagnosisControlsReady =
      activeConnectionDiagnosis !== null
      && next
      && nextProfileId === activeConnectionDiagnosis.profileId
      && activeConnected
      && !unreachable;
    if (
      next === connectionDiagnosisControlsAvailable
      && nextProfileId === connectionDiagnosisControlsProfileId
      && !activeReview
    ) return;
    connectionDiagnosisControlsAvailable = next;
    connectionDiagnosisControlsProfileId = nextProfileId;
    if (
      !activeDiagnosisControlsReady
      && activeReview
      && activeConnectionDiagnosis !== null
    ) {
      connectionDiagnosisControlReview = {
        diagnosisId: activeConnectionDiagnosis.id,
        phase: 'returned',
      };
    }
    renderConnectionDiagnosis();
    if (
      activeDiagnosisControlsReady
      && activeConnectionDiagnosis !== null
      && connectionDiagnosisAutoOpenControlsId
        === activeConnectionDiagnosis.id
      && !activeReview
    ) {
      reviewConnectionDiagnosisServerControls();
      return;
    }
    if (
      !activeDiagnosisControlsReady
      && open
      && (activeReview || controlsHadFocus)
    ) {
      focusElement(connectionDiagnosisReturn);
    }
  };

  const setConnectionDiagnosisCurrentStateAvailability = (
    profileId: string | null,
    available: boolean,
  ): void => {
    if (disposed) return;
    const reconcileHadFocus = open
      && (doc as unknown as { activeElement?: EventTarget | null })
        .activeElement === connectionDiagnosisReconcile;
    const normalizedProfileId = profileId?.trim() ?? '';
    const next = available
      && normalizedProfileId.length > 0
      && normalizedProfileId.length <= 256
      && opts.onReadConnectionDiagnosisServerCurrentState !== undefined;
    const nextProfileId = next ? normalizedProfileId : null;
    if (
      next === connectionDiagnosisCurrentStateAvailable
      && nextProfileId === connectionDiagnosisCurrentStateProfileId
    ) return;
    connectionDiagnosisCurrentStateAvailable = next;
    connectionDiagnosisCurrentStateProfileId = nextProfileId;
    renderConnectionDiagnosis();
    if (
      reconcileHadFocus
      && activeConnectionDiagnosis !== null
      && (
        !next
        || nextProfileId !== activeConnectionDiagnosis.profileId
        || !activeConnected
        || unreachable
      )
    ) focusElement(connectionDiagnosisReturn);
  };

  const renderServerUpdateGuide = (): void => {
    const guide = serverUpdateGuide;
    if (guide === null) {
      serverUpdateSection.setAttribute('hidden', '');
      return;
    }
    serverUpdateSection.removeAttribute('hidden');
    const progress = guide.serverUpdateProgress ?? null;
    const checkingReturn =
      progress === null && guide.phase === 'checking_return';
    const cleanEditorReady =
      progress === null && guide.phase === 'editor_ready';
    const exactReturnActive = guide.exactReturnActive === true;
    const guideVerification = guide.serverUpdateVerification ?? null;
    const verification =
      !checkingReturn
      && !cleanEditorReady
      && guideVerification?.phase === 'completed'
      ? guideVerification
      : progress?.phase === 'awaiting_reconnect'
        && progress.operationId !== undefined
        && guideVerification?.operation === progress.operation
        && guideVerification.startedAt === progress.startedAt
        ? guideVerification
        : null;
    const completion = verification?.phase === 'completed'
      ? verification
      : null;
    const verificationBusy = verification?.phase === 'checking'
      || verification?.phase === 'waiting'
      || verification?.phase === 'closing'
      || verification?.phase === 'checking_baseline'
      || verification?.phase === 'finishing';
    if (
      progress?.phase === 'applying'
      || (progress !== null && verification === null)
      || verificationBusy
      || exactReturnActive
    ) serverUpdateSection.setAttribute('aria-busy', 'true');
    else serverUpdateSection.removeAttribute('aria-busy');
    const triage = progress === null && guide.phase === 'triage'
      ? guide.serverUpdateTriage ?? null
      : null;
    const resolvedElsewhere =
      progress === null && guide.phase === 'resolved_elsewhere';
    const operation =
      (progress?.operation ?? verification?.operation) === 'rollback'
        ? 'rollback'
        : 'update';
    serverUpdateTitle.textContent = completion !== null
      ? 'All sorted. Back to work'
      : progress !== null
      ? progress.phase === 'applying'
        ? `Server ${operation} in progress`
        : verification?.phase === 'retryable'
          ? `Couldn’t confirm ${operation}`
          : verification?.phase === 'reviewing_closure'
            ? 'Look at closing this unanswered result'
            : verification?.phase === 'closing'
              ? 'The server is checking it is safe to close'
              : verification?.phase === 'closed'
                ? 'Closed. Now check how things are'
                : verification?.phase === 'checking_baseline'
                  ? 'Checking how the server is'
                  : verification?.phase === 'baseline_retryable'
                    ? 'Recued could not check how the server is'
                    : verification?.phase === 'baseline_confirmed'
                      ? verification.reason === 'finish_unavailable'
                        ? 'Checked. Finishing needs another go'
                        : 'Checked how the server is'
                : verification?.phase === 'finishing'
                  ? 'Finishing up'
          : verification?.phase === 'unknown'
            ? `${operation === 'update' ? 'Update' : 'Rollback'} result needs a look`
            : verification?.phase === 'waiting'
              ? `Confirming ${operation} result`
              : progress.operationId !== undefined && activeConnected
                ? `Checking ${operation} result`
                : `${operation === 'update' ? 'Update' : 'Rollback'} accepted. Waiting for the restart`
      : checkingReturn
      ? exactReturnActive
        ? 'Checking the key'
        : 'Carry on checking the key'
      : cleanEditorReady
      ? 'Carry on replacing the key'
      : resolvedElsewhere
      ? 'The key check is ready'
      : triage === null
        ? 'Update this server'
        : 'A server update needs a look';
    const activeProfile = profiles.find((profile) => profile.id === activeId);
    const activeProfileLabel = activeProfile?.label.trim()
      || activeProfile?.server_url
      || null;
    serverUpdateDetail.textContent = completion !== null
      ? `Recued has checked what is true now, and the server controls work again. It still does not know what the original ${operation} did. Go back to ${guide.connectionIdentity} for its new safety check.`
      : progress !== null
      ? verification?.phase === 'retryable'
        ? `Recued could not get a clear answer about the ${operation} after several safe checks. The controls stay paused until this server sorts it out.`
        : verification?.phase === 'reviewing_closure'
          ? `Look at this in Server Updates. Nothing changes until you cancel, or the server writes down that it could not tell.`
          : verification?.phase === 'closing'
            ? `The server is checking again, and making sure no update is running, before it writes down that it could not tell.`
            : verification?.phase === 'closed'
              ? `The selected server durably closed this receipt as unresolved. It did not claim the ${operation} succeeded or failed; confirm the state that exists now before another server change.`
              : verification?.phase === 'checking_baseline'
                ? 'Recued is reading the version running now, the update state, and what the affected connection is doing. The server controls stay paused.'
                : verification?.phase === 'baseline_retryable'
                  ? 'Recued could not read how things are now. Try again once this server is connected. Update and undo stay paused.'
                  : verification?.phase === 'baseline_confirmed'
                    ? verification.reason === 'finish_unavailable'
                      ? 'Recued still knows how the server is, but this browser could not finish tidying up. Choose Finish again. Nothing will run on the server twice.'
                      : `The selected server freshly reported its current state. Review it below; the original ${operation} result is still unknown.`
              : verification?.phase === 'finishing'
                ? 'Recued has checked how the server is. This tab is only tidying up its own note.'
        : verification?.phase === 'unknown'
          ? verification.reason === 'closure_in_flight'
            ? `The server said no, because another update is running. Wait for that to finish, then check again.`
            : verification.reason === 'closure_unavailable'
              ? `The server could not write down that it could not tell. Leave this open. If trying again still fails, use the details below.`
              : activeProfileLabel === null
                ? `Your server could not safely sort out this ${operation} result. Check you picked the right server before trying again, or before sharing the details below.`
                : `${activeProfileLabel} could not safely sort out this ${operation} result. Check this is the server you meant before trying again, or before sharing the details below.`
          : verification?.phase === 'waiting'
            ? verification.reason === 'restart_pending'
              ? `The selected server says this ${operation} is still restarting. Recued will check again by itself.`
              : `Recued could not confirm this ${operation} yet. It will try again by itself.`
            : activeProfileLabel === null
              ? `Another open Recued tab is handling this server ${operation}. This tab will observe it without sending a duplicate action.`
              : `Another open Recued tab is handling the ${operation} for ${activeProfileLabel}. This tab will observe it without sending a duplicate action.`
      : resolvedElsewhere
      ? activeProfileLabel === null
        ? `A look-only check says this server can safely check a new key for ${guide.connectionIdentity}.`
        : `A look-only check says ${activeProfileLabel} can safely check a new key for ${guide.connectionIdentity}.`
      : checkingReturn
      ? exactReturnActive
        ? `Recued is checking whether another key is already being replaced for ${guide.connectionIdentity}, then re-reading the latest saved connection. Account will not start a duplicate check while Connections owns this handoff.`
        : `The return to ${guide.connectionIdentity} stopped before Recued finished its checks. Carry on below to run those look-only checks again.`
      : cleanEditorReady
      ? `The checks passed, so Recued opened a fresh key editor for ${guide.connectionIdentity}, but that editor closed before any field changed. Resume below when you are ready to enter a replacement.`
      : triage === null
      ? activeProfileLabel === null
        ? `${guide.connectionIdentity} needs a newer Recued server before you can safely replace a key.`
        : `${guide.connectionIdentity} on ${activeProfileLabel} needs a newer Recued server before you can safely replace a key.`
      : activeProfileLabel === null
        ? `${guide.connectionIdentity} still needs a feature the server does not have, even after the update. Use the details below to fix this server.`
        : `${guide.connectionIdentity} on ${activeProfileLabel} still needs a feature the server does not have, even after the update. Use the details below to fix that server.`;
    serverUpdateStepNodes[0]!.textContent = activeProfileLabel === null
      ? 'Leave this server picked.'
      : `Keep ${activeProfileLabel} picked under Server profiles.`;
    if (completion !== null) {
      const baseline = completion.baseline;
      serverUpdateStepNodes[1]!.textContent = baseline === undefined
        ? 'This browser has tidied up. Go back to the connection to have the server check it again.'
        : `Running ${baseline.currentVersion} on the ${baseline.channel} channel. Return to ${guide.connectionIdentity}; Recued will re-read that exact connection before opening a clean editor.`;
      serverUpdateStepNodes[2]!.textContent =
        `This one-off note lives only in this tab. It does not say the original ${operation} worked or failed, and it is gone after a reload.`;
    } else if (progress !== null) {
      serverUpdateStepNodes[1]!.textContent = verification?.phase === 'retryable'
        ? 'Choose Check the result again below. Recued sends only a meaningless code to this server. It will not run the update or the undo again.'
        : verification?.phase === 'reviewing_closure'
          ? 'Go back to Server Updates to look at this, or cancel. Nothing is written down until you say so there.'
          : verification?.phase === 'closing'
            ? 'Leave this server picked while it checks again. It will not repeat or undo what you asked for.'
            : verification?.phase === 'closed'
              ? 'All the server wrote down is that it could not tell. Choose Check how the server is below before you finish.'
              : verification?.phase === 'checking_baseline'
                ? 'Leave this server picked while Recued reads the version running now, the update state, and what the connection is doing.'
                : verification?.phase === 'baseline_retryable'
                  ? 'Reconnect if you need to, then check again below. Nothing on the server will be changed.'
                  : verification?.phase === 'baseline_confirmed'
                    ? verification.reason === 'finish_unavailable'
                      ? 'Recued still knows how the server is. Try finishing up in this browser again. Nothing is sent to the server twice.'
                      : 'Look at the version, the update state, and the affected connection below, then finish.'
              : verification?.phase === 'finishing'
                ? 'Recued knows how the server is. Keep this tab open while it tidies up here.'
        : verification?.phase === 'unknown'
          ? 'Check you picked the server you meant. A different or reset server cannot answer this safely.'
          : progress.phase === 'applying'
            ? `Wait while the owner tab sends the server ${operation}. Update and rollback controls stay unavailable here.`
            : verification?.phase === 'waiting'
              ? 'Leave this server picked while Recued runs one more check. You can also try again now.'
              : progress.operationId !== undefined && activeConnected
                ? 'This tab is connected. Recued is checking what the server said about the restart. Update and undo stay switched off for now.'
                : progress.operationId !== undefined
                  ? `The server accepted the ${operation}. This tab will check the server-issued restart receipt when it reconnects.`
                  : `The server accepted the ${operation}. Each open tab now waits for and verifies its own reconnect.`;
      serverUpdateStepNodes[2]!.textContent = verification?.phase === 'closed'
        || verification?.phase === 'checking_baseline'
        || verification?.phase === 'baseline_retryable'
        || verification?.phase === 'baseline_confirmed'
        || verification?.phase === 'finishing'
        ? `This only says how things are now. It cannot prove whether the original ${operation} succeeded or failed.`
        : verification?.phase === 'reviewing_closure'
          || verification?.phase === 'closing'
          ? 'The server will not close this while an update is running, and it will never claim an unclear result worked.'
        : verification?.phase === 'unknown'
        ? verification.reason === 'unknown_receipt'
          ? 'If trying again on the right server still does not settle it, open Server Updates, or copy the details below.'
          : 'If this is the right server and trying again still does not settle it, copy the details below for whoever looks after the server.'
        : verification?.phase === 'retryable'
          ? 'If one more check still cannot settle it, make sure you picked the right server, then use the details below. The controls stay paused.'
        : progress.operationId !== undefined && activeConnected
          ? 'Once the result is clear, Recued will read this server and the saved connection again before offering the key check.'
          : 'Once this tab reconnects, Recued will read this server and the saved connection again before offering the key check.';
    } else if (checkingReturn) {
      serverUpdateStepNodes[1]!.textContent = exactReturnActive
        ? `Keep the Connections check open while Recued finishes both look-only checks for ${guide.connectionIdentity}.`
        : `Resume below to return to ${guide.connectionIdentity}; Recued will rebuild its baseline, check current replacement activity, then re-read the latest saved connection.`;
      serverUpdateStepNodes[2]!.textContent =
        'Recued carries over only which server you picked, which connection, the time, how far the safety check got, and the version before the update. It carries over no keys, nothing you typed, and no results.';
    } else if (cleanEditorReady) {
      serverUpdateStepNodes[1]!.textContent =
        `Resume below to return to ${guide.connectionIdentity}. Recued will repeat the read-only activity and latest-saved-connection checks before reopening the clean editor.`;
      serverUpdateStepNodes[2]!.textContent =
        'Only which server you picked, which connection, the time, and how far you got are kept. Nothing you typed, no keys, and no results are kept.';
    } else if (resolvedElsewhere) {
      serverUpdateStepNodes[1]!.textContent =
        'The check used only which server and connection you picked. It never read, kept, or sent a key or anything you typed.';
      serverUpdateStepNodes[2]!.textContent =
        'Carry on below when you are ready. This tab will read the server and the saved connection again before opening a fresh form.';
    } else if (triage !== null) {
      serverUpdateStepNodes[1]!.textContent = accountServerUpdateTriageStep(triage);
      serverUpdateStepNodes[2]!.textContent =
        'Once you have fixed this server, come back here. Recued will read the server and the saved connection again before opening any key form.';
    } else {
      serverUpdateStepNodes[1]!.textContent =
        'Open Server Updates and install the update. If it cannot update itself, update it the way you installed it.';
      serverUpdateStepNodes[2]!.textContent =
        'Wait for this tab to reconnect, then come back here. Recued will check the server and the saved connection again.';
    }
    serverUpdateStatus.textContent = completion !== null
      ? (() => {
          const baseline = completion.baseline;
          if (baseline === undefined) {
            return 'All sorted. The details are no longer here.';
          }
          return `Recovery finished · running ${baseline.currentVersion} · ${baseline.channel} channel · ${ACCOUNT_BASELINE_POSTURE_COPY[baseline.updateStatus]}.`;
        })()
      : verification?.phase === 'retryable'
      ? `Recued stopped checking, safely. The ${operation} result is still unclear.`
      : verification?.phase === 'reviewing_closure'
        ? 'This is waiting for you in Server Updates. The server has written nothing down yet.'
        : verification?.phase === 'closing'
          ? 'The server is deciding whether this can be closed.'
          : verification?.phase === 'closed'
            ? `The server closed this without an answer. The ${operation} result is still unclear.`
            : verification?.phase === 'checking_baseline'
              ? 'Asking the server how things are…'
              : verification?.phase === 'baseline_retryable'
                ? 'Recued does not know how the server is. Its controls stay paused.'
                : verification?.phase === 'baseline_confirmed'
                  ? (() => {
                      const baseline = verification.baseline;
                      if (baseline === undefined) {
                        return 'Recued only got part of the answer. The server controls stay paused.';
                      }
                      const affected = baseline.affectedConnection;
                      const connectionCopy = affected === undefined
                        ? 'no connection is affected'
                        : affected.activity === 'idle'
                          ? `${affected.kind}/${affected.name}: no credential verification is pending`
                          : affected.activity === 'pending'
                            ? `${affected.kind}/${affected.name}: credential verification is pending`
                            : `${affected.kind}/${affected.name}: activity will be checked again on return`;
                      const finishCopy =
                        verification.reason === 'finish_unavailable'
                          ? ' Tidying up in this browser needs another go.'
                          : '';
                      return `Running ${baseline.currentVersion} · ${baseline.channel} channel · ${ACCOUNT_BASELINE_POSTURE_COPY[baseline.updateStatus]} · ${connectionCopy}. Current state confirmed; original ${operation} result is still unknown.${finishCopy}`;
                    })()
            : verification?.phase === 'finishing'
              ? 'Finishing up…'
      : verification?.phase === 'unknown'
        ? verification.reason === 'operation_mismatch'
          ? `That result belongs to a different job. The ${operation} you expected is still unclear.`
          : verification.reason === 'closure_in_flight'
            ? 'The server said no, because an update is running.'
            : verification.reason === 'closure_unavailable'
              ? 'The server cannot close this right now, so it stays open.'
              : `This server did not know about the ${operation} receipt.`
        : verification?.phase === 'waiting'
          ? verification.reason === 'restart_pending'
            ? `The ${operation} is still waiting to restart. Recued will check again.`
            : `Recued could not check just now. It will try again.`
          : progress?.phase === 'applying'
            ? `Doing the server ${operation} in another open Recued tab…`
            : progress?.phase === 'awaiting_reconnect'
              ? activeConnected
                ? progress.operationId === undefined
                  ? `The ${operation} was accepted. Waiting to see the server restart.`
                  : `The ${operation} was accepted. Checking what the server said about restarting.`
                : `The server is restarting after the ${operation}. This tab is waiting to reconnect.`
      : resolvedElsewhere
      ? 'Checked with a look-only question to the server. This tab did not move.'
      : checkingReturn
      ? exactReturnActive
        ? 'Checking what is happening with the key, then checking the saved connection…'
        : 'Last time, this stopped before both checks finished.'
      : cleanEditorReady
      ? 'Ready to run the safety check again and reopen a fresh editor.'
      : triage !== null
      ? accountServerUpdateEvidenceCopy(triage)
      : guide.phase === 'awaiting_reconnect'
      ? activeConnected
        ? 'The update was accepted. Waiting for the server to restart.'
        : 'The server is restarting. You can go back once this tab reconnects.'
      : guide.phase === 'ready' && activeConnected && !unreachable
        ? 'The server is back. Go back to run the check.'
        : unreachable
          ? 'This tab is waiting for the server to come back.'
          : activeConnected
            ? 'This tab is connected. Once the update is done, go back to run the check.'
            : 'This tab is not sure it is connected to the server yet.';
    const receiptDiagnostic =
      verification?.phase === 'unknown'
      || verification?.phase === 'retryable'
      || verification?.phase === 'baseline_retryable'
      ? verification
      : null;
    if (triage === null && receiptDiagnostic === null) {
      serverUpdateDiagnostic.setAttribute('hidden', '');
      serverUpdateDiagnosticSummary.textContent = '';
      serverUpdateDiagnosticStatus.textContent = '';
    } else {
      serverUpdateDiagnostic.removeAttribute('hidden');
      serverUpdateDiagnosticSummary.textContent = receiptDiagnostic !== null
        ? buildAccountServerUpdateReceiptDiagnostic({
            connectionIdentity: guide.connectionIdentity,
            profileLabel: activeProfile?.label ?? null,
            serverUrl: activeProfile?.server_url ?? null,
            verification: receiptDiagnostic,
          })
        : buildAccountServerUpdateDiagnostic({
            connectionIdentity: guide.connectionIdentity,
            profileLabel: activeProfile?.label ?? null,
            serverUrl: activeProfile?.server_url ?? null,
            triage: triage!,
          });
      if (opts.serverUpdateDiagnosticWriter === undefined) {
        serverUpdateDiagnosticCopy.setAttribute('hidden', '');
        serverUpdateDiagnosticPrivacy.textContent =
          'Recued sends nothing by itself. Select the summary to copy it. It shows the server’s name and address. It leaves out keys, connection settings, error details, and web addresses.';
      } else {
        serverUpdateDiagnosticCopy.removeAttribute('hidden');
        serverUpdateDiagnosticPrivacy.textContent =
          'Read this before you show it to whoever looks after this server. Recued sends nothing by itself. It shows the server’s name and address. It leaves out keys, connection settings, error details, and web addresses.';
      }
      if (serverUpdateDiagnosticCopyInFlight) {
        serverUpdateDiagnosticCopy.setAttribute('disabled', '');
        serverUpdateDiagnosticCopy.textContent = 'Copying…';
      } else {
        serverUpdateDiagnosticCopy.removeAttribute('disabled');
        serverUpdateDiagnosticCopy.textContent = 'Copy the details';
      }
    }
    serverUpdatePrivacy.textContent = completion !== null
      ? 'This result lives only in this tab. Other tabs are told only that it is done. A reload will not bring it back.'
      : verification?.phase === 'baseline_confirmed'
      ? 'This only lives in this tab’s memory. Tabs share nothing but a meaningless progress code. No keys, addresses, typed values, versions, or error details are passed along.'
      : progress !== null
      ? 'Tabs share only a meaningless code for the server, what is being done, how far it got, when it started, and afterwards a meaningless result code. They never share keys, connection details, addresses, typed values, versions, or error details.'
      : checkingReturn
      ? guide.reloadSafe === false
        ? 'This browser could not save your place in case of a reload. Keep this tab open. Keys, typed values, and results are still never saved.'
        : 'This tab keeps only what it is working on, how far it got, the time, and the version before the update. It never keeps keys, typed values, or results.'
      : cleanEditorReady
      ? guide.reloadSafe === false
        ? 'This browser could not save your place in case of a reload. It kept no keys, typed values, or results.'
        : 'This keeps only which server you picked, which connection, the time, and how far you got. It keeps no keys, typed values, or results.'
      : resolvedElsewhere
      ? 'This is kept only in this tab and is gone after a reload. No new key or typed value was saved or sent.'
      : guide.reloadSafe === false
      ? 'This guide never keeps a new key. This browser could not save your place, so keep this tab open.'
      : 'This guide never keeps or sends a new key.';
    if (resolvedElsewhere || checkingReturn || cleanEditorReady) {
      serverUpdateOpen.setAttribute('hidden', '');
    } else serverUpdateOpen.removeAttribute('hidden');
    serverUpdateOpen.textContent = completion !== null
      ? 'See what was sorted out'
      : progress !== null
      ? verification?.phase === 'reviewing_closure'
        || verification?.phase === 'closing'
        ? 'Back to closing this'
        : verification?.phase === 'closed'
          || verification?.phase === 'checking_baseline'
          || verification?.phase === 'baseline_retryable'
          || verification?.phase === 'baseline_confirmed'
          || verification?.phase === 'finishing'
          ? 'See how the server is'
          : 'View Server Updates'
      : triage?.reason === 'update_still_available'
        ? 'Continue Server Update'
        : triage === null
          ? 'Open Server Updates'
          : 'See how the update is going';
    serverUpdateOpen.setAttribute(
      'aria-label',
      completion !== null
        ? `See the one-off result for ${guide.connectionIdentity}`
        : progress !== null
        ? `See the shared server ${operation} progress for the server used by ${guide.connectionIdentity}`
        : triage === null
        ? `Open Server Updates for the server used by ${guide.connectionIdentity}`
        : `See how the update is going on the server used by ${guide.connectionIdentity}`,
    );
    const keepRetryVisibleWhileChecking =
      verification?.phase === 'checking'
      && !serverUpdateRetry.hasAttribute('hidden');
    const showRetryReceipt = progress?.phase === 'awaiting_reconnect'
      && progress.operationId !== undefined
      && verification !== null
      && (
        verification.phase === 'waiting'
        || verification.phase === 'retryable'
        || verification.phase === 'unknown'
        || verification.phase === 'closed'
        || verification.phase === 'checking_baseline'
        || verification.phase === 'baseline_retryable'
        || verification.phase === 'baseline_confirmed'
        || verification.phase === 'finishing'
        || keepRetryVisibleWhileChecking
      );
    if (showRetryReceipt) {
      serverUpdateRetry.removeAttribute('hidden');
      const closureAdvance =
        verification.phase === 'closed'
        || verification.phase === 'checking_baseline'
        || verification.phase === 'baseline_retryable'
        || verification.phase === 'baseline_confirmed'
        || verification.phase === 'finishing';
      serverUpdateRetry.textContent = verification.phase === 'closed'
        ? activeConnected && !unreachable
          ? 'Check how the server is'
          : 'Confirm when connected'
        : verification.phase === 'checking_baseline'
          ? 'Checking how the server is…'
          : verification.phase === 'baseline_retryable'
            ? 'Check how the server is again'
            : verification.phase === 'baseline_confirmed'
              ? verification.reason === 'finish_unavailable'
                ? `Try finishing again and go back to ${guide.connectionIdentity}`
                : `Finish and go back to ${guide.connectionIdentity}`
        : verification.phase === 'finishing'
          ? 'Finishing up…'
          : activeConnected && !unreachable
            ? verification.phase === 'checking'
              ? 'Checking the result…'
              : verification.phase === 'waiting'
                ? 'Retry now'
                : 'Check the result again'
            : 'Retry when connected';
      serverUpdateRetry.setAttribute(
        'aria-label',
        verification.phase === 'closed'
          ? `Check how the server is before retiring the server-closed unresolved ${operation} receipt`
          : verification.phase === 'checking_baseline'
            ? `Asking the server how it is, after the unanswered ${operation} closure`
            : verification.phase === 'baseline_retryable'
              ? `Check how the server is again, after the unanswered ${operation} closure`
              : verification.phase === 'baseline_confirmed'
                ? verification.reason === 'finish_unavailable'
                  ? `Try tidying up in this browser again, then go back to ${guide.connectionIdentity}; no server action will repeat`
                  : `Finish and go back to ${guide.connectionIdentity} using what the server just told us. The original ${operation} result is still unknown`
          : verification.phase === 'finishing'
            ? `Finishing with the unanswered ${operation} result`
            : activeConnected && !unreachable
              ? verification.phase === 'checking'
                ? `Checking the server ${operation} receipt`
                : `Check the server ${operation} result again`
              : `Waiting to reconnect before checking the server ${operation} result again`,
      );
      const canAdvanceClosure =
        opts.onFinishServerUpdateReceiptClosure !== undefined
        && (
          verification.phase === 'baseline_confirmed'
          || (
            (
              verification.phase === 'closed'
              || verification.phase === 'baseline_retryable'
            )
            && activeConnected
            && !unreachable
          )
        );
      if (
        closureAdvance
          ? canAdvanceClosure
          : activeConnected
            && !unreachable
            && verification.phase !== 'checking'
            && opts.onRetryServerUpdateReceipt !== undefined
      ) serverUpdateRetry.removeAttribute('disabled');
      else serverUpdateRetry.setAttribute('disabled', '');
    } else {
      serverUpdateRetry.setAttribute('hidden', '');
      serverUpdateRetry.setAttribute('disabled', '');
    }
    const canReturn = opts.onReturnToWork !== undefined
      && progress === null
      && activeConnected
      && !unreachable
      && guide.phase !== 'awaiting_reconnect'
      && !exactReturnActive;
    serverUpdateReturn.textContent = exactReturnActive
      ? activeConnected && !unreachable
        ? 'Checking…'
        : 'Paused until this reconnects…'
      : canReturn
      ? completion !== null
        ? `Return to ${guide.connectionIdentity}`
        : checkingReturn
        ? 'Carry on checking'
        : cleanEditorReady
        ? 'Reopen the fresh editor'
        : resolvedElsewhere
        ? 'Continue in this tab'
        : guide.phase === 'triage'
        ? 'Check the server again'
        : guide.phase === 'ready'
        ? 'Go back and check'
        : 'Go back and check again'
      : 'Waiting for server…';
    serverUpdateReturn.setAttribute(
      'aria-label',
      exactReturnActive
        ? `The key check for ${guide.connectionIdentity} is already running under Connections`
      : canReturn
        ? completion !== null
          ? `Return to ${guide.connectionIdentity} for a fresh safety check now the server is sorted`
          : checkingReturn
          ? `Carry on the key check for ${guide.connectionIdentity}`
          : cleanEditorReady
          ? `Reopen the fresh key editor for ${guide.connectionIdentity} after running its safety check again`
          : resolvedElsewhere
          ? `Carry on checking the new key for ${guide.connectionIdentity} in this tab`
          : guide.phase === 'triage'
          ? `Check the server features again for ${guide.connectionIdentity}`
          : `Return to ${guide.connectionIdentity} and check the updated server`
        : `Waiting for the server used by ${guide.connectionIdentity} before checking again`,
    );
    serverUpdateDismiss.textContent = progress !== null
      ? 'A server change is happening'
      : exactReturnActive
        ? 'Checking'
        : resolvedElsewhere || cleanEditorReady
          ? 'Dismiss'
          : 'Not now';
    if (progress !== null || exactReturnActive) {
      serverUpdateDismiss.setAttribute('disabled', '');
    } else serverUpdateDismiss.removeAttribute('disabled');
    if (opts.onReturnToWork === undefined) {
      serverUpdateOpen.setAttribute('disabled', '');
      serverUpdateReturn.setAttribute('disabled', '');
    } else {
      serverUpdateOpen.removeAttribute('disabled');
      if (canReturn) serverUpdateReturn.removeAttribute('disabled');
      else serverUpdateReturn.setAttribute('disabled', '');
    }
  };

  const profileList: ProfileListMount = mountProfileList({
    host: serversRow,
    document: doc,
    profiles: opts.profiles,
    activeProfileId: opts.activeProfileId,
    activeUnreachable: unreachable,
    activeConnected,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.switchWorkState !== undefined
      ? { switchWorkState: opts.switchWorkState }
      : {}),
    ...(opts.switchActiveWork !== undefined
      ? { switchActiveWork: opts.switchActiveWork }
      : {}),
    ...(opts.onReturnToWork !== undefined
      ? {
          onReturnToWork: (href: string) => {
            setOpen(false, { returnFocus: true });
            opts.onReturnToWork?.(href);
          },
        }
      : {}),
    onSwitch: async (id, reviewedWorkState, reviewedActiveWork) => {
      // A failed switch stays beside its inline recovery copy. A successful
      // production switch reloads; the close below also keeps injected test
      // reload seams coherent when they return normally.
      await (reviewedActiveWork !== undefined
        ? opts.onSwitch(id, reviewedWorkState, reviewedActiveWork)
        : opts.onSwitch(id, reviewedWorkState));
      setOpen(false, { returnFocus: true });
    },
    // Clicking the row you are already on changes nothing, but the click still
    // has to feel answered — so the menu closes rather than sitting there.
    onSelectActive: () => setOpen(false, { returnFocus: true }),
    ...(opts.onRename !== undefined
      ? {
          onRename: async (id: string, label: string) => {
            const savedLabel = await opts.onRename?.(id, label);
            const committedLabel =
              typeof savedLabel === 'string' && savedLabel.trim().length > 0
                ? savedLabel.trim()
                : label;
            // The child updates its rendered copy. Keep the parent roster in
            // step too, or the next connection-status refresh will repaint the
            // old name even though durable storage already holds the new one.
            profiles = profiles.map((profile) =>
              profile.id === id
                ? { ...profile, label: committedLabel }
                : profile,
            );
            renderConnectionDiagnosis();
            return committedLabel;
          },
        }
      : {}),
    ...(opts.onRemove !== undefined
      ? {
          onRemove: async (id: string, mode: ServerProfileRemovalMode) => {
            const removedActiveProfile = id === activeId;
            await opts.onRemove?.(id, mode);
            if (removedActiveProfile) {
              // The current-server path reloads onto the roster fallback. An
              // injected reload seam may return, so close this now-invalid
              // Account surface back to its stable trigger in that case.
              setOpen(false, { returnFocus: true });
              return;
            }
            // Forgetting another profile is only a local roster edit. Keep
            // Account open and let the child advance focus from the removed
            // confirmation to the surviving, labelled profile list.
            profiles = profiles.filter((profile) => profile.id !== id);
            profileList.refresh(
              profiles,
              activeId,
              unreachable,
              activeConnected,
            );
          },
        }
      : {}),
  });
  // Keep the primary destinations before the roster-management action.
  if (opts.onAddServer !== undefined) serversRow.appendChild(addServer);

  const canOpenConnectionDiagnosis = (profileId: string): boolean => {
    const normalizedProfileId = profileId.trim();
    return !disposed
      && normalizedProfileId.length > 0
      && normalizedProfileId.length <= 256
      && !profileList.hasInFlightAction()
      && activeId === normalizedProfileId
      && profiles.some((profile) => profile.id === normalizedProfileId);
  };

  const renderBadge = (): void => {
    const recoveryHadFocus = !unreachable
      && open
      && nodeIsInside(
        recovery,
        (doc as unknown as { activeElement?: EventTarget | null }).activeElement ?? null,
      );
    const workBadgeState = activeWork.length === 0
      ? 'ok'
      : activeWork.every((work) => work.phase === 'result_ready')
        ? 'result-ready'
        : 'working';
    const guideReady = serverUpdateGuide !== null;
    const guideBadgeState =
      serverUpdateGuide?.phase === 'checking_return'
        ? serverUpdateGuide.exactReturnActive === true
          ? 'working'
          : 'result-ready'
      : serverUpdateGuide?.phase === 'editor_ready'
        ? 'result-ready'
      : serverUpdateGuide?.phase === 'resolved_elsewhere'
      || serverUpdateGuide?.serverUpdateVerification?.phase === 'retryable'
      || serverUpdateGuide?.serverUpdateVerification?.phase === 'unknown'
      || serverUpdateGuide?.serverUpdateVerification?.phase === 'reviewing_closure'
      || serverUpdateGuide?.serverUpdateVerification?.phase === 'closed'
      || serverUpdateGuide?.serverUpdateVerification?.phase === 'baseline_retryable'
      || serverUpdateGuide?.serverUpdateVerification?.phase === 'baseline_confirmed'
      || serverUpdateGuide?.serverUpdateVerification?.phase === 'completed'
      ? 'result-ready'
      : 'working';
    const combinedWorkBadgeState = guideReady
      ? guideBadgeState === 'working' || workBadgeState === 'working'
        ? 'working'
        : 'result-ready'
      : workBadgeState;
    const badgeState = unreachable
      ? 'unreachable'
      : combinedWorkBadgeState;
    badge.setAttribute('data-state', badgeState);
    badge.textContent = unreachable
      ? '×'
      : activeWork.length > 0 || guideReady
        ? '•'
        : '';
    const triggerBase = unreachable
      ? 'Your account and servers. Recued cannot reach this server'
      : 'Your account and servers';
    const activeWorkCopy = workBadgeState === 'result-ready'
      ? `${activeWork.length} ${activeWork.length === 1 ? 'result is' : 'results are'} ready on this server.`
      : `${activeWork.length} ${activeWork.length === 1 ? 'action needs' : 'actions need'} this server.`;
    const guideCopy = serverUpdateGuide === null
      ? null
      : serverUpdateGuide.phase === 'checking_return'
        ? serverUpdateGuide.exactReturnActive === true
          ? `Recued is checking the key for ${serverUpdateGuide.connectionIdentity}`
          : `The key check that was stopped can carry on for ${serverUpdateGuide.connectionIdentity}`
      : serverUpdateGuide.phase === 'editor_ready'
        ? `A fresh key editor is ready to reopen for ${serverUpdateGuide.connectionIdentity}`
      : serverUpdateGuide.serverUpdateVerification?.phase === 'unknown'
        ? `Server update result needs a look for ${serverUpdateGuide.connectionIdentity}`
        : serverUpdateGuide.serverUpdateVerification?.phase === 'retryable'
          ? `Server update receipt is ready to retry for ${serverUpdateGuide.connectionIdentity}`
        : serverUpdateGuide.serverUpdateVerification?.phase === 'reviewing_closure'
          ? `Server update receipt closure needs review for ${serverUpdateGuide.connectionIdentity}`
        : serverUpdateGuide.serverUpdateVerification?.phase === 'closed'
          ? `Current server state is ready to confirm for ${serverUpdateGuide.connectionIdentity}`
        : serverUpdateGuide.serverUpdateVerification?.phase === 'baseline_retryable'
          ? `Current server state is ready to retry for ${serverUpdateGuide.connectionIdentity}`
        : serverUpdateGuide.serverUpdateVerification?.phase === 'baseline_confirmed'
          ? serverUpdateGuide.serverUpdateVerification.reason
              === 'finish_unavailable'
            ? `Current server state is confirmed and finish is ready to retry for ${serverUpdateGuide.connectionIdentity}`
            : `Current server state is confirmed for ${serverUpdateGuide.connectionIdentity}`
        : serverUpdateGuide.serverUpdateVerification?.phase === 'completed'
          ? `Server recovery is finished and return is ready for ${serverUpdateGuide.connectionIdentity}`
      : serverUpdateGuide.serverUpdateProgress?.phase === 'applying'
        ? `A server change is in progress for ${serverUpdateGuide.connectionIdentity}`
        : serverUpdateGuide.serverUpdateProgress?.phase === 'awaiting_reconnect'
          ? `Waiting for the server restart for ${serverUpdateGuide.connectionIdentity}`
          : serverUpdateGuide.phase === 'resolved_elsewhere'
            ? `The key check is ready for ${serverUpdateGuide.connectionIdentity}`
            : serverUpdateGuide.phase === 'triage'
              ? `Server update diagnosis is ready for ${serverUpdateGuide.connectionIdentity}`
              : `Server update steps are ready for ${serverUpdateGuide.connectionIdentity}`;
    trigger.setAttribute('aria-label', [
      triggerBase,
      guideCopy,
      activeWork.length === 0 ? null : activeWorkCopy,
    ].filter((copy): copy is string => copy !== null).join('. '));
    trigger.setAttribute(
      'title',
      unreachable
        ? 'Recued cannot reach this server'
        : guideCopy !== null
          ? guideCopy
          : activeWork.length > 0
            ? activeWorkCopy.replace(/\.$/, '')
            : 'Your account and servers',
    );
    if (unreachable) recovery.removeAttribute('hidden');
    else recovery.setAttribute('hidden', '');
    // A successful reconnect can hide the exact heading the banner focused.
    // Return focus to the still-open dialog instead of stranding it in a
    // hidden subtree. Do not disturb someone already using another control.
    if (recoveryHadFocus) focusElement(popover);
    const hasAlternateServer = profiles.some(
      (profile) =>
        profile.id !== activeId
        && typeof profile.server_url === 'string'
        && profile.server_url.length > 0,
    );
    recoveryDetail.textContent = recoveryDetailCopy(hasAlternateServer);
    renderConnectionDiagnosis();
  };

  function setOpen(
    next: boolean,
    behavior?: {
      returnFocus?: boolean;
      focusContent?: boolean;
      connectionDiagnosisDisposition?: AccountConnectionDiagnosisDisposition;
      connectionDiagnosisCurrentState?: ServerControlCurrentStateObservation;
    },
  ): void {
    if (disposed) return;
    const wasOpen = open;
    open = next;
    if (!next && focusLeaveTimer !== null) {
      globalThis.clearTimeout(focusLeaveTimer);
      focusLeaveTimer = null;
    }
    trigger.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) {
      popover.removeAttribute('hidden');
      // Relative recency is presentation, not durable state. Re-render when
      // the owner opens Account so an inactive server does not keep saying
      // "5 minutes ago" after this tab has been sitting open for hours.
      profileList.refresh(profiles, activeId, unreachable, activeConnected);
    } else popover.setAttribute('hidden', '');
    if (next && behavior?.focusContent === true) {
      focusElement(
        activeConnectionDiagnosis !== null
          ? connectionDiagnosisTitle
          : serverUpdateGuide !== null
          ? serverUpdateTitle
          : unreachable
            ? recoveryTitle
            : popover,
      );
    }
    if (!next) {
      const closedDiagnosis = activeConnectionDiagnosis;
      const closedDisposition =
        behavior?.connectionDiagnosisDisposition ?? 'dismissed';
      const closedReceipt = closedDiagnosis !== null
        && closedDisposition === 'return'
        && connectionDiagnosisControlReceipt?.diagnosisId
          === closedDiagnosis.id
          ? connectionDiagnosisControlReceipt.receipt
          : null;
      // Deliberately omit `detail`: even presentation-safe RPC copy is owned
      // by the Account receipt and must not become recovery continuity state.
      const closedServerOutcome: ServerControlActionOutcome | undefined =
        closedReceipt === null
          ? undefined
          : {
              action: closedReceipt.action,
              phase: closedReceipt.phase,
              ...(closedReceipt.currentState === undefined
                ? {}
                : { currentState: closedReceipt.currentState }),
            };
      activeConnectionDiagnosis = null;
      connectionDiagnosisControlReview = null;
      connectionDiagnosisReviewMode = 'bounded_verification';
      connectionDiagnosisAutoOpenControlsId = null;
      connectionDiagnosisControlReceipt = null;
      renderConnectionDiagnosis();
      // A live "Remove?" must not survive a close and greet the next open.
      profileList.disarm();
      if (behavior?.returnFocus === true) focusElement(trigger);
      if (wasOpen) opts.onClose?.();
      if (wasOpen && closedDiagnosis !== null) {
        if (behavior?.connectionDiagnosisCurrentState !== undefined) {
          opts.onConnectionDiagnosisClosed?.(
            closedDiagnosis,
            closedDisposition,
            closedServerOutcome,
            { ...behavior.connectionDiagnosisCurrentState },
          );
        } else if (closedServerOutcome === undefined) {
          opts.onConnectionDiagnosisClosed?.(
            closedDiagnosis,
            closedDisposition,
          );
        } else {
          opts.onConnectionDiagnosisClosed?.(
            closedDiagnosis,
            closedDisposition,
            closedServerOutcome,
          );
        }
      }
    }
  }

  trigger.addEventListener('click', () => {
    if (open) {
      setOpen(false, { returnFocus: true });
      return;
    }
    setOpen(true, { focusContent: true });
  });

  closeButton.addEventListener('click', () => {
    setOpen(false, { returnFocus: true });
  });

  reviewConnectionDiagnosisServerControls = (): boolean => {
    const diagnosis = activeConnectionDiagnosis;
    if (
      diagnosis === null
      || !connectionDiagnosisControlsAvailable
      || connectionDiagnosisControlsProfileId !== diagnosis.profileId
      || !activeConnected
      || unreachable
      || profileList.hasInFlightAction()
      || opts.onReviewConnectionDiagnosisServerControls === undefined
    ) return false;
    const diagnosisId = diagnosis.id;
    // An automatic exact landing is one-shot. If the live owner rejects this
    // attempt, the visible button remains the deliberate retry boundary.
    connectionDiagnosisAutoOpenControlsId = null;
    connectionDiagnosisControlReview = {
      diagnosisId,
      phase: 'active',
    };
    renderConnectionDiagnosis();
    try {
      const scroll = (serverSlot as {
        scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
      }).scrollIntoView;
      scroll?.call(serverSlot, { block: 'nearest' });
    } catch {
      // Focus inside the real control surface remains the authoritative handoff.
    }
    let result: 'opened' | 'unavailable' = 'unavailable';
    try {
      result = opts.onReviewConnectionDiagnosisServerControls(
        diagnosis,
        {
          ownerId: diagnosisId,
          onReceipt: (receipt) => {
            if (
              disposed
              || activeConnectionDiagnosis?.id !== diagnosisId
              || connectionDiagnosisControlReview?.diagnosisId !== diagnosisId
            ) return;
            connectionDiagnosisControlReceipt = {
              diagnosisId,
              receipt: { ...receipt },
            };
            renderConnectionDiagnosis();
          },
          onReturn: () => {
            if (
              disposed
              || activeConnectionDiagnosis?.id !== diagnosisId
              || connectionDiagnosisControlReview?.diagnosisId !== diagnosisId
            ) return;
            connectionDiagnosisControlReview = {
              diagnosisId,
              phase: 'returned',
            };
            renderConnectionDiagnosis();
            if (open) {
              focusElement(
                !connectionDiagnosisReconcile.hasAttribute('hidden')
                  && !connectionDiagnosisReconcile.hasAttribute('disabled')
                  ? connectionDiagnosisReconcile
                  : connectionDiagnosisReturn,
              );
            }
          },
        },
      );
    } catch {
      result = 'unavailable';
    }
    if (result === 'opened') return true;
    if (activeConnectionDiagnosis?.id !== diagnosisId) return false;
    connectionDiagnosisControlsAvailable = false;
    connectionDiagnosisControlsProfileId = null;
    connectionDiagnosisControlReview = null;
    renderConnectionDiagnosis();
    focusElement(connectionDiagnosisTitle);
    return false;
  };

  connectionDiagnosisControls.addEventListener('click', () => {
    reviewConnectionDiagnosisServerControls();
  });

  connectionDiagnosisReconcile.addEventListener('click', () => {
    const diagnosis = activeConnectionDiagnosis;
    if (
      diagnosis === null
      || connectionDiagnosisReviewMode !== 'unresolved_receipt'
      || !connectionDiagnosisCurrentStateAvailable
      || connectionDiagnosisCurrentStateProfileId !== diagnosis.profileId
      || !activeConnected
      || unreachable
      || profileList.hasInFlightAction()
      || opts.onReadConnectionDiagnosisServerCurrentState === undefined
    ) return;
    let observation: ServerControlCurrentStateObservation | null = null;
    try {
      observation = opts.onReadConnectionDiagnosisServerCurrentState(
        diagnosis,
      );
    } catch {
      observation = null;
    }
    if (
      observation === null
      || (
        observation.state !== 'running'
        && observation.state !== 'paused'
      )
    ) {
      setConnectionDiagnosisCurrentStateAvailability(null, false);
      connectionDiagnosisStatus.textContent =
        `The current state for ${diagnosis.profileLabel} changed or is still settling. Review the live server again; the historical receipt remains unresolved.`;
      focusElement(connectionDiagnosisReturn);
      return;
    }
    setOpen(false, {
      returnFocus: true,
      connectionDiagnosisDisposition: 'return',
      connectionDiagnosisCurrentState: { ...observation },
    });
  });

  connectionDiagnosisReturn.addEventListener('click', () => {
    if (activeConnectionDiagnosis === null) return;
    if (profileList.hasInFlightAction()) {
      connectionDiagnosisStatus.textContent =
        'Finish the server profile change already in progress before reporting this review outcome.';
      return;
    }
    setOpen(false, {
      returnFocus: true,
      connectionDiagnosisDisposition: 'return',
    });
  });

  settingsLink.addEventListener('click', () => {
    setOpen(false);
  });

  addServer.addEventListener('click', () => {
    setOpen(false, { returnFocus: true });
    opts.onAddServer?.();
  });

  serverUpdateReturn.addEventListener('click', () => {
    const guide = serverUpdateGuide;
    if (
      guide === null
      || guide.serverUpdateProgress !== undefined
      || guide.exactReturnActive === true
      || opts.onReturnToWork === undefined
    ) return;
    // Navigation may be cancelled or the authoritative check may be
    // interrupted. Keep the guide until the exact retry reaches a stable
    // landing and explicitly settles it.
    if (guide.phase === 'resolved_elsewhere') {
      try {
        opts.onResumeServerUpdateGuide?.(guide);
      } catch {
        // A host bookkeeping failure cannot turn this explicit action into a
        // dead control; the exact retry route still performs its own check.
      }
    }
    setOpen(false, { returnFocus: true });
    opts.onReturnToWork(guide.returnHref);
  });

  serverUpdateOpen.addEventListener('click', () => {
    const guide = serverUpdateGuide;
    if (
      guide === null
      || guide.phase === 'checking_return'
      || guide.phase === 'editor_ready'
      || guide.exactReturnActive === true
      || opts.onReturnToWork === undefined
    ) return;
    // Keep the guide + exact return alive while Settings owns the route.
    setOpen(false, { returnFocus: true });
    opts.onReturnToWork(guide.updateHref);
  });

  serverUpdateRetry.addEventListener('click', () => {
    const verification = serverUpdateGuide?.serverUpdateVerification;
    if (
      verification === undefined
      || verification.phase === 'checking'
      || verification.phase === 'checking_baseline'
      || verification.phase === 'finishing'
    ) return;
    if (
      verification.phase === 'closed'
      || verification.phase === 'baseline_retryable'
      || verification.phase === 'baseline_confirmed'
    ) {
      if (verification.phase === 'baseline_confirmed') {
        const affected = verification.baseline?.affectedConnection;
        serverUpdateFinishReturnRequested = affected !== undefined
          && `${affected.kind}/${affected.name}`
            === serverUpdateGuide?.connectionIdentity;
      } else {
        serverUpdateFinishReturnRequested = false;
      }
      opts.onFinishServerUpdateReceiptClosure?.();
      focusElement(serverUpdateTitle);
      return;
    }
    if (!activeConnected || unreachable) return;
    opts.onRetryServerUpdateReceipt?.();
  });

  serverUpdateDiagnosticCopy.addEventListener('click', () => {
    const writer = opts.serverUpdateDiagnosticWriter;
    const guide = serverUpdateGuide;
    const summary = serverUpdateDiagnosticSummary.textContent;
    if (
      writer === undefined
      || (
        !(
          guide?.phase === 'triage'
          && guide.serverUpdateTriage !== undefined
        )
        && guide?.serverUpdateVerification?.phase !== 'unknown'
        && guide?.serverUpdateVerification?.phase !== 'retryable'
        && guide?.serverUpdateVerification?.phase !== 'baseline_retryable'
      )
      || summary.length === 0
      || serverUpdateDiagnosticCopyInFlight
    ) return;
    const generation = ++serverUpdateDiagnosticGeneration;
    serverUpdateDiagnosticCopyInFlight = true;
    serverUpdateDiagnosticStatus.textContent =
      'Copying the reviewed diagnostic…';
    renderServerUpdateGuide();
    const showCopyFailure = (): void => {
      if (disposed || generation !== serverUpdateDiagnosticGeneration) return;
      serverUpdateDiagnosticCopyInFlight = false;
      serverUpdateDiagnosticStatus.textContent =
        'Recued could not copy it. The summary is selected, so you can copy it yourself.';
      renderServerUpdateGuide();
      if (open && activeConnectionDiagnosis === null) {
        focusElement(serverUpdateDiagnosticSummary);
      }
    };
    let write: Promise<void>;
    try {
      write = writer(summary);
    } catch {
      // Clipboard implementations and host-injected writers may reject before
      // returning a promise. Recover the same way as an asynchronous denial so
      // the control never remains stuck on “Copying…”.
      showCopyFailure();
      return;
    }
    void write.then(
      () => {
        if (disposed || generation !== serverUpdateDiagnosticGeneration) return;
        serverUpdateDiagnosticCopyInFlight = false;
        serverUpdateDiagnosticStatus.textContent =
          'Safe diagnostic copied. Paste it into your support conversation when ready; nothing was sent automatically.';
        renderServerUpdateGuide();
        if (open && activeConnectionDiagnosis === null) {
          focusElement(serverUpdateDiagnosticStatus);
        }
      },
      showCopyFailure,
    );
  });

  serverUpdateDismiss.addEventListener('click', () => {
    const guide = serverUpdateGuide;
    if (
      guide === null
      || guide.serverUpdateProgress !== undefined
      || guide.exactReturnActive === true
    ) return;
    opts.onDismissServerUpdateGuide?.(guide);
    serverUpdateDiagnosticGeneration += 1;
    serverUpdateDiagnosticCopyInFlight = false;
    serverUpdateGuide = null;
    renderServerUpdateGuide();
    renderBadge();
    focusElement(popover);
  });

  const onDocumentClick = (event: Event): void => {
    if (!open) return;
    if (nodeIsInside(root, event.target)) return;
    setOpen(false);
  };
  const onDocumentFocusin = (event: FocusEvent): void => {
    if (!open) return;
    if (nodeIsInside(popover, event.target)) {
      if (focusLeaveTimer !== null) {
        globalThis.clearTimeout(focusLeaveTimer);
        focusLeaveTimer = null;
      }
      return;
    }
    if (focusLeaveTimer !== null) globalThis.clearTimeout(focusLeaveTimer);
    // A pointerdown can focus the Account trigger before its click toggles the
    // menu. Wait until that gesture completes so it closes once; a keyboard
    // Tab has no following click, so the new page control keeps ownership.
    focusLeaveTimer = globalThis.setTimeout(() => {
      focusLeaveTimer = null;
      if (
        !open
        || nodeIsInside(
          popover,
          (doc as unknown as { activeElement?: EventTarget | null })
            .activeElement ?? null,
        )
      ) return;
      setOpen(false);
    }, 0);
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (!open) return;
    if (event.key !== 'Escape' || event.isComposing) return;
    // The heartbeat-backed server controls are a nested, explicitly opened
    // surface. Let their Escape handler close back to the diagnosis outcome;
    // closing Account here in capture phase would skip that round-trip.
    const closest = (event.target as {
      closest?: (selector: string) => Element | null;
    } | null)?.closest;
    if (
      typeof closest === 'function'
      && closest.call(
        event.target,
        `[${SERVER_CONTROL_POPOVER_ATTR}]`,
      ) !== null
    ) return;
    setOpen(false, { returnFocus: true });
  };
  const docEvents = doc as unknown as {
    addEventListener?: (t: string, l: unknown, c?: boolean) => void;
    removeEventListener?: (t: string, l: unknown, c?: boolean) => void;
  };
  docEvents.addEventListener?.('click', onDocumentClick, true);
  docEvents.addEventListener?.('focusin', onDocumentFocusin, true);
  docEvents.addEventListener?.('keydown', onKeydown, true);

  renderActiveWork();
  renderServerUpdateGuide();
  renderBadge();

  return {
    isOpen: () => open,
    open: () => setOpen(true, { focusContent: true }),
    close: () => {
      if (disposed || profileList.hasInFlightAction()) return false;
      setOpen(false, { returnFocus: true });
      return true;
    },
    openServerProfile(profileId) {
      if (disposed) return 'unavailable';
      const availability = profileList.profileAvailability(profileId);
      if (availability === 'missing') {
        if (open) setOpen(false);
        return 'missing';
      }
      if (availability === 'unavailable') {
        if (open) setOpen(false);
        return 'unavailable';
      }
      setOpen(true);
      const focused = profileList.focusProfile(profileId);
      if (focused) return 'opened';
      // Do not leave two live dialogs when a profile operation temporarily
      // disables the exact row. Attention retains the reminder and explains
      // that no switch occurred.
      setOpen(false);
      return 'unavailable';
    },
    canOpenConnectionDiagnosis,
    openConnectionDiagnosis(diagnosis, options) {
      if (disposed) return 'unavailable';
      const id = diagnosis.id.trim();
      const profileId = diagnosis.profileId.trim();
      const profileLabel = diagnosis.profileLabel.trim();
      const areaLabel = diagnosis.areaLabel.trim();
      const initialServerOutcome = options?.initialServerOutcome;
      const unresolvedReceiptReview = initialServerOutcome !== undefined
        && isUnresolvedServerControlActionOutcome(initialServerOutcome);
      const expiredAreaReview = diagnosis.kind === 'expired_area_review';
      const hasValidKind = diagnosis.kind === undefined
        || expiredAreaReview;
      const hasValidInterruptionReason =
        diagnosis.interruptionReason === 'connection'
        || diagnosis.interruptionReason === 'navigation'
        || diagnosis.interruptionReason === 'ownership'
        || diagnosis.interruptionReason === 'reload';
      if (
        id.length === 0
        || id.length > 512
        || profileId.length === 0
        || profileId.length > 256
        || profileLabel.length === 0
        || profileLabel.length > 256
        || areaLabel.length === 0
        || areaLabel.length > 256
        || !hasValidKind
        || (
          !unresolvedReceiptReview
          && !expiredAreaReview
          && !hasValidInterruptionReason
        )
        || (unresolvedReceiptReview && expiredAreaReview)
        || (expiredAreaReview && diagnosis.interruptionReason !== undefined)
        || (initialServerOutcome !== undefined && !unresolvedReceiptReview)
        || !canOpenConnectionDiagnosis(profileId)
      ) return 'unavailable';
      activeConnectionDiagnosis = {
        id,
        profileId,
        profileLabel,
        areaLabel,
        ...(expiredAreaReview ? { kind: 'expired_area_review' as const } : {}),
        ...(diagnosis.interruptionReason === undefined
          ? {}
          : { interruptionReason: diagnosis.interruptionReason }),
      };
      connectionDiagnosisReviewMode = unresolvedReceiptReview
        ? 'unresolved_receipt'
        : expiredAreaReview
          ? 'expired_area_review'
          : 'bounded_verification';
      connectionDiagnosisControlReview = null;
      connectionDiagnosisControlReceipt = initialServerOutcome === undefined
        ? null
        : {
            diagnosisId: id,
            receipt: { ...initialServerOutcome },
          };
      connectionDiagnosisAutoOpenControlsId =
        unresolvedReceiptReview && options?.reviewServerControls === true
          ? id
          : null;
      renderConnectionDiagnosis();
      setOpen(true);
      focusElement(connectionDiagnosisTitle);
      if (connectionDiagnosisAutoOpenControlsId === id) {
        reviewConnectionDiagnosisServerControls();
      }
      return 'opened';
    },
    clearConnectionDiagnosis,
    setConnectionDiagnosisControlAvailability,
    setConnectionDiagnosisCurrentStateAvailability,
    openServerUpdateGuide(guide) {
      if (disposed) return;
      serverUpdateDiagnosticGeneration += 1;
      serverUpdateDiagnosticCopyInFlight = false;
      serverUpdateDiagnosticStatus.textContent = '';
      serverUpdateGuide = { ...guide };
      renderServerUpdateGuide();
      renderBadge();
      setOpen(true);
      focusElement(serverUpdateTitle);
    },
    setServerUpdateGuide(guide) {
      if (disposed) return;
      const completedReturn =
        serverUpdateFinishReturnRequested
        && guide?.phase !== 'checking_return'
        && guide?.exactReturnActive !== true
        && guide?.serverUpdateVerification?.phase === 'completed'
        && guide.serverUpdateProgress === undefined
        && guide.serverUpdateVerification.baseline?.affectedConnection
          !== undefined
        && `${
          guide.serverUpdateVerification.baseline.affectedConnection.kind
        }/${
          guide.serverUpdateVerification.baseline.affectedConnection.name
        }` === guide.connectionIdentity
        && opts.onReturnToWork !== undefined
          ? guide.returnHref
          : null;
      const guideHadFocus = guide === null
        && serverUpdateGuide !== null
        && open
        && nodeIsInside(
          serverUpdateSection,
          (doc as unknown as { activeElement?: EventTarget | null })
            .activeElement ?? null,
        );
      serverUpdateDiagnosticGeneration += 1;
      serverUpdateDiagnosticCopyInFlight = false;
      serverUpdateDiagnosticStatus.textContent = '';
      serverUpdateGuide = guide === null ? null : { ...guide };
      renderServerUpdateGuide();
      renderBadge();
      if (completedReturn !== null) {
        serverUpdateFinishReturnRequested = false;
        setOpen(false);
        try {
          opts.onReturnToWork?.(completedReturn);
        } catch {
          // The completed guide remains actionable, so an embedder that
          // rejects this automatic exact return can use the visible button.
        }
      } else if (
        guide === null
        || (
          guide.serverUpdateVerification?.phase !== 'finishing'
          && guide.serverUpdateVerification?.phase !== 'baseline_confirmed'
        )
      ) {
        serverUpdateFinishReturnRequested = false;
      }
      if (guideHadFocus) focusElement(popover);
    },
    themeSlot: () => themeSlot as unknown as HTMLElement,
    serverSlot: () => serverSlot as unknown as HTMLElement,
    refresh(nextProfiles, nextActiveId, nextUnreachable, nextActiveConnected) {
      if (disposed) return;
      const displacedDiagnosis =
        activeConnectionDiagnosis !== null
        && activeConnectionDiagnosis.profileId !== nextActiveId
          ? activeConnectionDiagnosis
          : null;
      const previousDiagnosticProfile = profiles.find(
        (profile) => profile.id === activeId,
      );
      const nextDiagnosticProfile = nextProfiles.find(
        (profile) => profile.id === nextActiveId,
      );
      if (
        activeId !== nextActiveId
        || previousDiagnosticProfile?.label !== nextDiagnosticProfile?.label
        || previousDiagnosticProfile?.server_url
          !== nextDiagnosticProfile?.server_url
      ) {
        // A roster refresh can hydrate or rename the profile while a clipboard
        // write is pending. Cancel that completion receipt before rebuilding
        // the summary so it cannot claim the newly displayed text was copied.
        serverUpdateDiagnosticGeneration += 1;
        serverUpdateDiagnosticCopyInFlight = false;
        serverUpdateDiagnosticStatus.textContent = '';
      }
      if (nextUnreachable !== undefined) unreachable = nextUnreachable;
      if (nextActiveConnected !== undefined) {
        activeConnected = nextActiveConnected;
      }
      profiles = nextProfiles;
      activeId = nextActiveId;
      if (unreachable || !activeConnected) {
        setConnectionDiagnosisControlAvailability(null, false);
        setConnectionDiagnosisCurrentStateAvailability(null, false);
      }
      if (displacedDiagnosis !== null) {
        clearConnectionDiagnosis();
        opts.onConnectionDiagnosisClosed?.(
          displacedDiagnosis,
          'dismissed',
        );
      }
      profileList.refresh(profiles, activeId, unreachable, activeConnected);
      renderServerUpdateGuide();
      renderBadge();
    },
    setUnreachable(next) {
      if (disposed || next === unreachable) return;
      unreachable = next;
      if (next) {
        setConnectionDiagnosisControlAvailability(null, false);
        setConnectionDiagnosisCurrentStateAvailability(null, false);
      }
      renderServerUpdateGuide();
      renderBadge();
      // The open menu's active row carries the same state; refreshing only the
      // badge would leave the two disagreeing while the menu is open.
      profileList.refresh(profiles, activeId, unreachable, activeConnected);
    },
    setActiveConnected(next) {
      if (disposed || next === activeConnected) return;
      activeConnected = next;
      if (!next) {
        setConnectionDiagnosisControlAvailability(null, false);
        setConnectionDiagnosisCurrentStateAvailability(null, false);
      }
      profileList.refresh(profiles, activeId, unreachable, activeConnected);
      renderServerUpdateGuide();
      renderConnectionDiagnosis();
      if (
        next
        && activeConnectionDiagnosis !== null
        && connectionDiagnosisAutoOpenControlsId
          === activeConnectionDiagnosis.id
      ) {
        reviewConnectionDiagnosisServerControls();
      }
    },
    setActiveWork(next) {
      if (disposed) return;
      activeWork = next.map((work) => ({ ...work }));
      renderActiveWork();
      renderBadge();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (focusLeaveTimer !== null) {
        globalThis.clearTimeout(focusLeaveTimer);
        focusLeaveTimer = null;
      }
      docEvents.removeEventListener?.('click', onDocumentClick, true);
      docEvents.removeEventListener?.('focusin', onDocumentFocusin, true);
      docEvents.removeEventListener?.('keydown', onKeydown, true);
      profileList.dispose();
      try {
        opts.host.removeChild(root);
      } catch {
        /* already detached (shell torn down first) — best-effort */
      }
    },
  };
};
