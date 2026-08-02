/** Webclient server-status pill host (D-109 pill, first webclient consumer).
 *
 *  Wraps the shared `mountServerPill` (`@recued/ui-shared/server-pill`) with
 *  the webclient's **B1 policy**: surface the current profile's health/uptime
 *  and pause/restart controls ONLY while the connection is `connected`. During
 *  an outage the route-independent banner and the active profile row own the
 *  down-signal. Both states now meet in the Account dialog instead of being
 *  split across two topbar controls.
 *
 *  ── Why hide instead of letting the pill show its own "offline" ──────
 *  `computePillState` has a gray "offline" state (stale heartbeat), but
 *  showing it would duplicate Account's "not reachable" state during an
 *  outage. So the pill is gated on `status() === 'connected'`: not-connected → `getSnapshot`
 *  returns null → `renderServerPill` returns '' → the host is cleared. And the
 *  cached snapshot is dropped the moment the socket leaves `connected`, so a
 *  reconnect doesn't briefly flash a STALE pill before the first fresh beat —
 *  it stays hidden until real health data returns.
 *
 *  ── v1 scope (A1) ───────────────────────────────────────────────────
 *  The server emitter sends a minimal snapshot (gated on lifecycle `running`),
 *  so in practice the pill shows green "Server · <uptime>" while connected and
 *  nothing otherwise. The busy/paused/attention states render correctly if a
 *  richer snapshot ever arrives (enriching the emitter is a separate slice). */

import type { ServerHeartbeatSnapshot } from '@recued/contracts';
import {
  mountServerPill,
  type ServerPillHandle,
} from '@recued/ui-shared/server-pill';

import {
  WEBCLIENT_HEARTBEAT_STALE_MS,
  type WebclientConnectionStatus,
} from '../realtime/connection-status.js';
import { classifyRpcError } from './rpc-error-copy.js';

/** D-188 — supervisor modes that actually RESPAWN the process on a restart
 *  handoff. `native` (bare process) + `dev` (npx tsx) do NOT — a restart there
 *  just exits and stays down — so the Restart button is hidden for them. */
const SUPERVISED_MODES: ReadonlySet<string> = new Set([
  'systemd',
  'launchd',
  'docker',
  'docker-thin',
]);

/** Minimal HTML escape for the one dynamic string the popover renders (the
 *  humanized rpc error). The action labels + status are a fixed enum. */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;'
      : ch === '<' ? '&lt;'
        : ch === '>' ? '&gt;'
          : ch === '"' ? '&quot;'
            : '&#39;',
  );

/** Marker the bootstrap guards the one-time `<head>` style injection with. */
export const SERVER_PILL_STYLES_MARKER = 'data-recued-server-pill-styles';

/** Attribute on the Account dialog's current-server host element — both the
 *  the CSS scope (the pill element itself is rendered by the shared component,
 *  so its `server-pill*` classes are scoped under THIS instead of attr'd
 *  directly, keeping them from leaking page-wide). */
export const SERVER_PILL_HOST_ATTR = 'data-recued-webclient-server-pill-host';
export const SERVER_CONTROL_POPOVER_ATTR =
  'data-recued-webclient-server-control-popover';
export const SERVER_CONTROL_TITLE_ATTR =
  'data-recued-webclient-server-control-title';
export const SERVER_CONTROL_STATUS_ATTR =
  'data-recued-webclient-server-control-status';

const SERVER_CONTROL_TITLE_ID = 'recued-webclient-server-control-title';
const SERVER_CONTROL_STATUS_ID = 'recued-webclient-server-control-status';

/** Account-dialog styles for the pill, scoped under {@link SERVER_PILL_HOST_ATTR}.
 *  Keeps the status quiet and near-monochrome; the
 *  dot is the only color signal (green = running; the others are
 *  forward-compat for a future richer snapshot). */
export const SERVER_PILL_STYLES = `
[${SERVER_PILL_HOST_ATTR}] .server-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 0 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--fg-muted);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: -0.005em;
  white-space: nowrap;
  user-select: none;
}
[${SERVER_PILL_HOST_ATTR}] .server-pill__dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex: 0 0 auto;
  background: var(--fg-subtle);
}
[${SERVER_PILL_HOST_ATTR}] .server-pill--green .server-pill__dot { background: #3f9460; }
[${SERVER_PILL_HOST_ATTR}] .server-pill--gray .server-pill__dot { background: var(--fg-subtle); }
[${SERVER_PILL_HOST_ATTR}] .server-pill--amber .server-pill__dot { background: #c79a3a; }
[${SERVER_PILL_HOST_ATTR}] .server-pill--orange .server-pill__dot { background: #c77f3a; }
[${SERVER_PILL_HOST_ATTR}] .server-pill--red .server-pill__dot { background: var(--danger); }
/* D-188 — master "Pause server" state: a neutral PAUSE glyph (two bars
   drawn with token-colored borders, so it adapts to light/dark), NOT the
   connection-offline red. The label reads in the default fg for a touch
   more presence than the quiet running state. */
[${SERVER_PILL_HOST_ATTR}] .server-pill--paused { color: var(--fg, #27272a); }
[${SERVER_PILL_HOST_ATTR}] .server-pill__glyph {
  width: 8px;
  height: 9px;
  flex: 0 0 auto;
  box-sizing: border-box;
  border-left: 2px solid var(--accent, #0e7490);
  border-right: 2px solid var(--accent, #0e7490);
}
/* D-188 — the pill becomes a clickable status + control surface. Inside the
   scroll-bounded Account dialog the controls expand inline under the pill;
   an absolute frame would be clipped at phone widths. */
[${SERVER_PILL_HOST_ATTR}] .server-pill-anchor {
  position: relative;
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: stretch;
}
[${SERVER_PILL_HOST_ATTR}] .server-pill[data-action] { cursor: pointer; }
[${SERVER_PILL_HOST_ATTR}] .server-pill[data-action]:hover {
  background: var(--surface-sunk, rgba(0, 0, 0, 0.04));
}
[${SERVER_PILL_HOST_ATTR}] .server-pill[data-action]:focus-visible,
[${SERVER_PILL_HOST_ATTR}] .server-control-btn:focus-visible {
  outline: 2px solid var(--accent, #0e7490);
  outline-offset: 2px;
}
[${SERVER_PILL_HOST_ATTR}] .server-control-popover-frame {
  position: static;
  width: 100%;
  margin-top: 8px;
  z-index: 60;
  border: 1px solid var(--border-strong, #d4d4d8);
  border-radius: 8px;
  background: var(--surface, #ffffff);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.18);
  padding: 12px;
  display: grid;
  gap: 10px;
  color: var(--fg, #27272a);
  box-sizing: border-box;
}
[${SERVER_PILL_HOST_ATTR}] .server-control-title { font-weight: 650; font-size: 12px; }
[${SERVER_PILL_HOST_ATTR}] .server-control-title:focus {
  outline: 2px solid var(--accent, #0e7490);
  outline-offset: 3px;
  border-radius: 3px;
}
[${SERVER_PILL_HOST_ATTR}] .server-control-status {
  color: var(--fg-muted, #71717a);
  font-size: 12px;
}
[${SERVER_PILL_HOST_ATTR}] .server-control-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
[${SERVER_PILL_HOST_ATTR}] .server-control-btn {
  flex: 1 1 auto;
  min-height: 44px;
  border: 1px solid var(--border-strong, #d4d4d8);
  border-radius: 8px;
  padding: 0 10px;
  background: var(--surface, #ffffff);
  color: var(--fg, #27272a);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
[${SERVER_PILL_HOST_ATTR}] .server-control-btn--pause {
  border-color: var(--accent, #0e7490);
  color: var(--accent, #0e7490);
}
[${SERVER_PILL_HOST_ATTR}] .server-control-btn--confirm {
  border-color: var(--danger, #dc2626);
  background: var(--danger, #dc2626);
  color: var(--on-danger, #ffffff);
}
[${SERVER_PILL_HOST_ATTR}] .server-control-btn--resume {
  border-color: var(--accent, #0e7490);
  background: var(--accent, #0e7490);
  color: var(--on-accent, #ffffff);
}
[${SERVER_PILL_HOST_ATTR}] .server-control-btn--restart-confirm {
  border-color: var(--accent, #0e7490);
  background: var(--accent, #0e7490);
  color: var(--on-accent, #ffffff);
}
[${SERVER_PILL_HOST_ATTR}] .server-control-btn[disabled] { cursor: wait; opacity: 0.7; }
[${SERVER_PILL_HOST_ATTR}] .server-control-error {
  color: var(--danger, #dc2626);
  font-size: 11.5px;
}
/* Crash-halt is a FAULT, not a user pause — the info line reads in danger so it
   stands apart from the neutral running/paused status copy. */
[${SERVER_PILL_HOST_ATTR}] .server-control-status--crash { color: var(--danger, #dc2626); }
`;

/** Structural guard for a wire `server_heartbeat` payload before it reaches
 *  the shared renderer. The renderer only null-guards `server_id`, so a
 *  partial frame (e.g. `{}` from a buggy/compromised server) would otherwise
 *  render a bogus "Server · 0s". Requires the two fields the renderer +
 *  severity logic actually read — `server_id` (`string | null`) and a numeric
 *  `last_seen_at`; the rest are optional ride-alongs the emitter may omit. */
export const isServerHeartbeatSnapshot = (
  value: unknown,
): value is ServerHeartbeatSnapshot => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (typeof v.server_id === 'string' || v.server_id === null) &&
    typeof v.last_seen_at === 'number'
  );
};

export interface MountWebclientServerPillOptions {
  /** Account-dialog host the pill renders into (carries the style scope attr). */
  host: HTMLElement;
  /** Current connection status — read on every re-render for the B1 gate. */
  status: () => WebclientConnectionStatus;
  /** Subscribe to status transitions (re-render to show/hide). Returns unsub. */
  onStatus: (
    listener: (status: WebclientConnectionStatus) => void,
  ) => () => void;
  /** Clock override (tests) — forwarded to the shared mount's staleness calc. */
  now?: () => number;
  /** D-188 — owner-only master-pause control. When provided, the pill becomes
   *  CLICKABLE → a server-control popover with a Pause server / Resume button
   *  (confirm-on-pause, instant resume). The contract-free resume rpc stays
   *  reachable while paused (it never routes through the op-admission gate).
   *  Absent ⇒ the pill stays a quiet, non-clickable status display
   *  (back-compat + tests that don't exercise the control). */
  runSetPaused?: (active: boolean) => Promise<unknown>;
  /** D-188 — owner-only restart control. When provided AND the server reports a
   *  respawning `supervisor_mode`, the popover shows a Restart button (drain +
   *  supervisor handoff). Gated on the supervisor because an un-supervised
   *  restart just exits the process and stays down — a footgun. The crash-halt
   *  state surfaces it as the honest recovery action. */
  runRequestRestart?: () => Promise<{ accepted: boolean }>;
  /** Reports whether a fresh heartbeat-backed control target exists. Socket
   * state alone is not sufficient because reconnect deliberately drops the
   * cached heartbeat before the next server frame. */
  onControlAvailabilityChange?: (available: boolean) => void;
  /** Reports the stronger boundary used to close an unresolved historical
   * receipt: a stable, fresh heartbeat exists and no server-control RPC is
   * still in flight. */
  onCurrentStateAvailabilityChange?: (available: boolean) => void;
}

export type ServerControlAction = 'pause' | 'resume' | 'restart';

export type ServerControlActionReceiptPhase =
  | 'pending'
  | 'accepted'
  | 'confirmed'
  | 'reconnected'
  | 'superseded'
  | 'failed'
  | 'unconfirmed';

/** Privacy-safe projection of one deliberate server-control result. This is
 * the only part of a receipt that may cross from Account back to Attention. */
export interface ServerControlActionOutcome {
  readonly action: ServerControlAction;
  readonly phase: ServerControlActionReceiptPhase;
  readonly currentState?: 'running' | 'paused' | 'restarting';
}

/** Privacy-safe projection of the server's current execution state from one
 * fresh heartbeat. This is deliberately separate from an action receipt: it
 * establishes what is true now without claiming an earlier request caused it. */
export interface ServerControlCurrentStateObservation {
  readonly state: 'running' | 'paused';
}

/** Outcomes that still need a live server re-review before the person can
 * safely treat the control request as settled. `confirmed` and `superseded`
 * already carry an authoritative current-state boundary; every other phase
 * remains indeterminate or unsuccessful. */
export const isUnresolvedServerControlActionOutcome = (
  outcome: ServerControlActionOutcome,
): boolean => outcome.phase === 'pending'
  || outcome.phase === 'accepted'
  || outcome.phase === 'reconnected'
  || outcome.phase === 'failed'
  || outcome.phase === 'unconfirmed';

/** Ephemeral, credential-free result from one deliberate server-control
 * action. It is kept only while the Account diagnosis owns the handoff. */
export interface ServerControlActionReceipt
  extends ServerControlActionOutcome {
  /** Presentation-safe, layout-bounded error copy from the shared RPC
   * classifier. */
  readonly detail?: string;
}

export interface ServerControlDiagnosisHandoff {
  /** Ephemeral diagnosis identity. Reopening the same handoff keeps its latest
   * receipt live; a different owner can never inherit it. */
  readonly ownerId: string;
  /** Receives action progress and later authoritative reconciliation, even
   * after the inline controls have returned to the diagnosis. */
  readonly onReceipt: (receipt: ServerControlActionReceipt) => void;
  /** Returns focus after Escape, outside click, or connection loss. */
  readonly onReturn: () => void;
}

export interface WebclientServerPillMount {
  /** Feed a fresh heartbeat snapshot (from the bootstrap's `server_heartbeat`
   *  demux). Re-renders — shown only if currently `connected`. */
  noteSnapshot(snapshot: ServerHeartbeatSnapshot): void;
  /** Deliberately open the real server-control surface and focus its stable
   * heading. The optional handoff receives action receipts and focus return. */
  openControls(
    handoff?: ServerControlDiagnosisHandoff,
  ): 'opened' | 'unavailable';
  /** Read the current stable heartbeat-backed execution state. Returns null
   * while stale, transitional, crash-halted, disconnected, or while an action
   * is awaiting a response or a post-action heartbeat. */
  readCurrentState(): ServerControlCurrentStateObservation | null;
  /** Close a visible control surface during parent teardown or handoff reset. */
  closeControls(): void;
  /** Detach the status subscription + remove the pill. Idempotent. */
  dispose(): void;
}

const SERVER_CONTROL_RECEIPT_DETAIL_MAX = 320;

const receiptDetail = (copy: string): string => {
  const normalized = copy.trim();
  if (normalized.length <= SERVER_CONTROL_RECEIPT_DETAIL_MAX) return normalized;
  return `${normalized.slice(0, SERVER_CONTROL_RECEIPT_DETAIL_MAX - 1).trimEnd()}…`;
};

export const mountWebclientServerPill = (
  opts: MountWebclientServerPillOptions,
): WebclientServerPillMount => {
  const runSetPaused = opts.runSetPaused;
  const runRequestRestart = opts.runRequestRestart;
  const controllable = runSetPaused !== undefined;
  let latest: ServerHeartbeatSnapshot | null = null;
  let latestReceivedAt: number | null = null;
  let disposed = false;

  // The controllable variant keeps a structural anchor mounted even before a
  // heartbeat arrives. Hide the OUTER host until there is a fresh connected
  // snapshot so Account never shows a padded, empty status band during boot or
  // an outage.
  opts.host.setAttribute('hidden', '');

  // The v1 status pill renders straight into the host — a quiet, non-clickable
  // display (the path the back-compat fake-host tests drive). The D-188
  // CONTROLLABLE variant wraps it in an anchor with a sibling popover host: the
  // shared `mountServerPill` owns its host's innerHTML, so the popover can't
  // live in the same node. Only the controllable path needs a real document.
  const anchor = controllable ? opts.host.ownerDocument.createElement('span') : null;
  const popoverHost = controllable ? opts.host.ownerDocument.createElement('div') : null;
  let pillHost: HTMLElement = opts.host;
  if (anchor !== null && popoverHost !== null) {
    anchor.className = 'server-pill-anchor';
    pillHost = opts.host.ownerDocument.createElement('span');
    anchor.appendChild(pillHost);
    anchor.appendChild(popoverHost);
    opts.host.appendChild(anchor);
  }

  // Popover state machine. `confirming` is the deliberate confirm step for the
  // significant actions (pause / restart); resume is one click. `restarting` is
  // the transient post-request note before the WS drops. `busy` gates a
  // re-entrant rpc (and disables every action button while one is in flight).
  let open = false;
  let confirming: null | 'pause' | 'restart' = null;
  let restarting = false;
  let busy = false;
  let busyAction: ServerControlAction | null = null;
  let error: string | null = null;
  let handoffReturn: (() => void) | null = null;
  let handoffReceiptObserver:
    | ((receipt: ServerControlActionReceipt) => void)
    | null = null;
  let handoffOwnerId: string | null = null;
  let handoffGeneration = 0;
  let actionReceipt: ServerControlActionReceipt | null = null;
  let restartSawDisconnect = false;
  let restartBaselineServerId: string | null = null;
  let restartBaselineUptimeS: number | null = null;
  let lastReportedControlAvailability: boolean | null = null;
  let lastReportedCurrentStateAvailability: boolean | null = null;
  let heartbeatSequence = 0;
  let currentStateRequiresHeartbeatAfter = 0;

  const crashHalted = (): boolean => latest?.crash_halt_active === true;
  const paused = (): boolean => latest?.paused === true;
  // Restart only when the rpc is wired AND a supervisor will respawn the
  // process — otherwise restart = exit-and-stay-down (a footgun).
  const canRestart = (): boolean =>
    runRequestRestart !== undefined
    && SUPERVISED_MODES.has(latest?.supervisor_mode ?? '');

  const freshHeartbeatTargetAvailable = (): boolean => {
    if (
      latest === null
      || latest.server_id === null
      || latest.server_id.trim().length === 0
      || latest.last_seen_at <= 0
      || !Number.isFinite(latest.last_seen_at)
      || latestReceivedAt === null
    ) return false;
    let currentTime: number;
    try {
      currentTime = (opts.now ?? Date.now)();
    } catch {
      return false;
    }
    const age = currentTime - latestReceivedAt;
    return Number.isFinite(currentTime)
      && age >= 0
      && age < WEBCLIENT_HEARTBEAT_STALE_MS;
  };

  const controlsAvailable = (): boolean => !disposed
    && controllable
    && opts.status() === 'connected'
    && freshHeartbeatTargetAvailable();

  const currentStateAvailable = (): boolean => {
    if (
      !controlsAvailable()
      || busy
      || restarting
      || latest === null
      || heartbeatSequence <= currentStateRequiresHeartbeatAfter
      || crashHalted()
      || (
        latest.lifecycle_state !== undefined
        && latest.lifecycle_state !== 'running'
      )
    ) return false;
    return true;
  };

  const reportControlAvailability = (): void => {
    const available = controlsAvailable();
    if (available === lastReportedControlAvailability) return;
    lastReportedControlAvailability = available;
    try {
      opts.onControlAvailabilityChange?.(available);
    } catch {
      // Presentation observers cannot affect the server-control state machine.
    }
  };

  const reportCurrentStateAvailability = (): void => {
    const available = currentStateAvailable();
    if (available === lastReportedCurrentStateAvailability) return;
    lastReportedCurrentStateAvailability = available;
    try {
      opts.onCurrentStateAvailabilityChange?.(available);
    } catch {
      // Presentation observers cannot affect the server-control state machine.
    }
  };

  const reportAvailabilities = (): void => {
    reportControlAvailability();
    reportCurrentStateAvailability();
  };

  const queryPopoverElement = (selector: string): HTMLElement | null => {
    if (popoverHost === null) return null;
    const query = (popoverHost as unknown as {
      querySelector?: (value: string) => HTMLElement | null;
    }).querySelector;
    if (typeof query !== 'function') return null;
    try {
      return query.call(popoverHost, selector);
    } catch {
      return null;
    }
  };

  const focusControlElement = (element: HTMLElement | null): void => {
    const focus = (element as { focus?: () => void } | null)?.focus;
    if (typeof focus !== 'function' || element === null) return;
    try {
      focus.call(element);
    } catch {
      // Detached and reduced fake DOMs keep focus best-effort.
    }
  };

  const focusControlTitle = (): void => {
    focusControlElement(queryPopoverElement(`[${SERVER_CONTROL_TITLE_ATTR}]`));
  };

  const focusPill = (): void => {
    const query = (pillHost as unknown as {
      querySelector?: (value: string) => HTMLElement | null;
    }).querySelector;
    if (typeof query !== 'function') return;
    try {
      focusControlElement(query.call(pillHost, '.server-pill[data-action]'));
    } catch {
      // Reduced fake DOMs do not parse the shared pill's innerHTML.
    }
  };

  const resetActionReceipt = (clearObserver: boolean): void => {
    handoffGeneration += 1;
    actionReceipt = null;
    restartSawDisconnect = false;
    restartBaselineServerId = null;
    restartBaselineUptimeS = null;
    if (clearObserver) {
      handoffReceiptObserver = null;
      handoffOwnerId = null;
    }
  };

  const publishActionReceipt = (
    receipt: ServerControlActionReceipt,
    generation: number,
  ): void => {
    if (disposed || generation !== handoffGeneration) return;
    actionReceipt = { ...receipt };
    try {
      handoffReceiptObserver?.({ ...receipt });
    } catch {
      // The diagnosis observer is presentation-only and may already be gone.
    }
  };

  const knownState = (): 'running' | 'paused' | undefined =>
    latest === null ? undefined : latest.paused === true ? 'paused' : 'running';

  const reconcileActionReceipt = (snapshot: ServerHeartbeatSnapshot): void => {
    const receipt = actionReceipt;
    if (receipt === null) return;
    const generation = handoffGeneration;
    if (
      (receipt.action === 'pause' || receipt.action === 'resume')
      && receipt.phase === 'confirmed'
      && typeof snapshot.paused === 'boolean'
    ) {
      const expectedPaused = receipt.action === 'pause';
      if (snapshot.paused !== expectedPaused) {
        publishActionReceipt({
          action: receipt.action,
          phase: 'superseded',
          currentState: snapshot.paused ? 'paused' : 'running',
        }, generation);
      }
      return;
    }
    if (
      receipt.action !== 'restart'
      || !restartSawDisconnect
      || (
        receipt.phase !== 'accepted'
        && receipt.phase !== 'reconnected'
      )
    ) return;
    const restarted =
      restartBaselineServerId !== null
      && snapshot.server_id === restartBaselineServerId
      && restartBaselineUptimeS !== null
      && typeof snapshot.uptime_s === 'number'
      && Number.isFinite(snapshot.uptime_s)
      && snapshot.uptime_s >= 0
      && snapshot.uptime_s < restartBaselineUptimeS;
    publishActionReceipt({
      action: 'restart',
      phase: restarted ? 'confirmed' : 'reconnected',
      currentState: snapshot.paused === true ? 'paused' : 'running',
    }, generation);
  };

  // `action` + `label` are a fixed enum (no injection); every button disables
  // while a rpc is in flight so a double-click can't fire twice.
  const button = (action: string, label: string, cls = ''): string =>
    `<button type="button" class="server-control-btn${cls}" data-action="${action}"`
    + `${busy ? ' disabled aria-busy="true"' : ''}>${label}</button>`;

  const renderPopover = (preferredAction?: string): void => {
    if (disposed || popoverHost === null) return;
    if (!open || opts.status() !== 'connected' || latest === null) {
      popoverHost.innerHTML = '';
      return;
    }
    const activeElement = (opts.host.ownerDocument as unknown as {
      activeElement?: EventTarget | null;
    }).activeElement ?? null;
    let focusWasInside = false;
    try {
      focusWasInside = activeElement !== null
        && popoverHost.contains(activeElement as Node);
    } catch {
      focusWasInside = false;
    }
    const focusedAction = focusWasInside
      ? (activeElement as { getAttribute?: (name: string) => string | null })
        .getAttribute?.('data-action') ?? null
      : null;
    // A restart-confirm armed under a supervisor must auto-disarm if a later
    // snapshot no longer reports one — so the gate can never go stale.
    if (confirming === 'restart' && !canRestart()) confirming = null;
    const errorHtml = error
      ? `<div class="server-control-error" role="alert">${escapeHtml(error)}</div>`
      : '';
    const restart = canRestart() ? button('restart-request', 'Restart') : '';
    let detail: string;
    let detailCls = '';
    let actions: string;
    if (busy && busyAction !== null) {
      const action = busyAction === 'pause'
        ? 'Pause'
        : busyAction === 'resume'
          ? 'Resume'
          : 'Restart';
      detail = `${action} is still awaiting a server response. Review the live status; controls stay unavailable until it settles.`;
      actions = paused()
        ? button('resume', 'Resume', ' server-control-btn--resume') + restart
        : button('pause-request', 'Pause server', ' server-control-btn--pause')
          + restart;
    } else if (restarting) {
      detail = 'Restarting — reconnecting…';
      actions = '';
    } else if (confirming === 'pause') {
      detail = 'Closes all doors + stops scheduled work. You stay connected — resume anytime.';
      actions = button('pause-cancel', 'Cancel')
        + button('pause-confirm', 'Confirm pause', ' server-control-btn--confirm');
    } else if (confirming === 'restart') {
      detail = 'Drains in-flight work, then restarts and reconnects.';
      actions = button('restart-cancel', 'Cancel')
        + button('restart-confirm', 'Confirm restart', ' server-control-btn--restart-confirm');
    } else if (crashHalted()) {
      // A SYSTEM fault, not a user pause — info + the honest recovery (logs /
      // restart), never a pause/resume-as-fix or a footgun manual clear.
      detail = 'Crash loop detected — the server restarted too many times and paused writes to '
        + 'protect your data. Check the server logs; it recovers automatically once stable, or restart it.';
      detailCls = ' server-control-status--crash';
      actions = restart;
    } else if (paused()) {
      detail = 'Execution paused — doors closed, scheduled work stopped.';
      actions = button('resume', 'Resume', ' server-control-btn--resume') + restart;
    } else {
      detail = 'Running.';
      actions = button('pause-request', 'Pause server', ' server-control-btn--pause') + restart;
    }
    popoverHost.innerHTML =
      `<div class="server-control-popover-frame" ${SERVER_CONTROL_POPOVER_ATTR}`
      + ` role="dialog" aria-labelledby="${SERVER_CONTROL_TITLE_ID}"`
      + ` aria-describedby="${SERVER_CONTROL_STATUS_ID}">`
      + `<div class="server-control-title" id="${SERVER_CONTROL_TITLE_ID}"`
      + ` ${SERVER_CONTROL_TITLE_ATTR} tabindex="-1">Active server controls</div>`
      + `<div class="server-control-status${detailCls}" id="${SERVER_CONTROL_STATUS_ID}"`
      + ` ${SERVER_CONTROL_STATUS_ATTR}>${detail}</div>`
      + errorHtml
      + (actions ? `<div class="server-control-actions">${actions}</div>` : '')
      + `</div>`;
    if (focusWasInside) {
      focusControlElement(
        (preferredAction === undefined
          ? null
          : queryPopoverElement(`[data-action="${preferredAction}"]`))
        // Reconstructed disabled buttons cannot retain DOM focus reliably.
        // During the RPC, land on the stable title; the completion render then
        // advances to the exact resulting action without falling to <body>.
        ?? (focusedAction === null || busy
          ? null
          : queryPopoverElement(`[data-action="${focusedAction}"]`))
        ?? queryPopoverElement(`[${SERVER_CONTROL_TITLE_ATTR}]`),
      );
    }
  };

  const closePopover = (): void => {
    if (!open) return;
    const returnFromHandoff = handoffReturn;
    handoffReturn = null;
    open = false;
    confirming = null;
    restarting = false;
    error = null;
    renderPopover();
    reportCurrentStateAvailability();
    try {
      returnFromHandoff?.();
    } catch {
      // The Account diagnosis may already have retired during parent teardown.
    }
  };

  const doSetPaused = async (active: boolean): Promise<void> => {
    if (busy || runSetPaused === undefined) return;
    const action: ServerControlAction = active ? 'pause' : 'resume';
    const generation = handoffGeneration;
    busy = true;
    busyAction = action;
    currentStateRequiresHeartbeatAfter = heartbeatSequence;
    error = null;
    publishActionReceipt({ action, phase: 'pending' }, generation);
    renderPopover();
    reportCurrentStateAvailability();
    try {
      await runSetPaused(active);
      busy = false;
      busyAction = null;
      currentStateRequiresHeartbeatAfter = heartbeatSequence;
      if (disposed) return;
      // The successful server response is authoritative for this request.
      // Reflect it immediately; a later heartbeat may still supersede it.
      if (latest) latest = { ...latest, paused: active };
      pill.update();
      // A retired handoff must not paint its completion, error, or focus into
      // a newer diagnosis. The global live state above still reflects a
      // successfully completed server action.
      if (generation !== handoffGeneration) {
        renderPopover();
        reportCurrentStateAvailability();
        return;
      }
      confirming = null;
      publishActionReceipt({
        action,
        phase: 'confirmed',
        currentState: active ? 'paused' : 'running',
      }, generation);
      renderPopover(active ? 'resume' : 'pause-request');
      reportCurrentStateAvailability();
    } catch (err) {
      busy = false;
      busyAction = null;
      currentStateRequiresHeartbeatAfter = heartbeatSequence;
      if (disposed) return;
      if (generation !== handoffGeneration) {
        renderPopover();
        reportCurrentStateAvailability();
        return;
      }
      confirming = null;
      const classified = classifyRpcError(err);
      error = classified.copy;
      const currentState = knownState();
      publishActionReceipt({
        action,
        phase: classified.connectionCaused || classified.suppressible
          ? 'unconfirmed'
          : 'failed',
        ...(currentState === undefined ? {} : { currentState }),
        detail: receiptDetail(classified.copy),
      }, generation);
      renderPopover(active ? 'pause-request' : 'resume');
      reportCurrentStateAvailability();
    }
  };

  const doRestart = async (): Promise<void> => {
    // Gate at the ACTION boundary, not just the render branch: a restart-confirm
    // armed under a supervisor must NOT fire if a later snapshot no longer
    // reports a respawning one (the UI is the only gate — the server handler
    // doesn't reject native/dev). `canRestart()` also covers the rpc-wired check.
    if (busy || runRequestRestart === undefined || !canRestart()) {
      if (confirming === 'restart') { confirming = null; renderPopover(); }
      return;
    }
    const generation = handoffGeneration;
    restartSawDisconnect = false;
    restartBaselineServerId =
      typeof latest?.server_id === 'string' && latest.server_id.length > 0
        ? latest.server_id
        : null;
    restartBaselineUptimeS =
      typeof latest?.uptime_s === 'number' && Number.isFinite(latest.uptime_s)
        ? latest.uptime_s
        : null;
    busy = true;
    busyAction = 'restart';
    currentStateRequiresHeartbeatAfter = heartbeatSequence;
    error = null;
    publishActionReceipt({
      action: 'restart',
      phase: 'pending',
    }, generation);
    renderPopover();
    reportCurrentStateAvailability();
    try {
      const res = await runRequestRestart();
      busy = false;
      busyAction = null;
      currentStateRequiresHeartbeatAfter = heartbeatSequence;
      if (disposed) return;
      if (generation !== handoffGeneration) {
        renderPopover();
        reportCurrentStateAvailability();
        return;
      }
      confirming = null;
      if (res && res.accepted === false) {
        // The server is already draining (e.g. a restart/restore in flight).
        error = 'A restart is already in progress.';
        const currentState = knownState();
        publishActionReceipt({
          action: 'restart',
          phase: 'failed',
          ...(currentState === undefined ? {} : { currentState }),
          detail: error,
        }, generation);
        renderPopover('restart-request');
        reportCurrentStateAvailability();
        return;
      }
      // Drain + supervisor handoff is underway → the WS drops next. Show a
      // transient note until the disconnect hides the pill (the global status
      // announcer then owns the reconnecting signal).
      restarting = true;
      publishActionReceipt({
        action: 'restart',
        phase: 'accepted',
        currentState: 'restarting',
      }, generation);
      // Usually the accepted response precedes the disconnect. Keep the
      // inverse ordering honest too: if this tab already reconnected and saw
      // a fresh heartbeat, reconcile it now instead of waiting for another.
      if (restartSawDisconnect && latest !== null) {
        reconcileActionReceipt(latest);
        if (
          actionReceipt?.action === 'restart'
          && (
            actionReceipt.phase === 'confirmed'
            || actionReceipt.phase === 'reconnected'
          )
        ) restarting = false;
      }
      renderPopover();
      reportCurrentStateAvailability();
    } catch (err) {
      busy = false;
      busyAction = null;
      currentStateRequiresHeartbeatAfter = heartbeatSequence;
      if (disposed) return;
      if (generation !== handoffGeneration) {
        renderPopover();
        reportCurrentStateAvailability();
        return;
      }
      confirming = null;
      const classified = classifyRpcError(err);
      error = classified.copy;
      const currentState = knownState();
      publishActionReceipt({
        action: 'restart',
        phase: classified.connectionCaused || classified.suppressible
          ? 'unconfirmed'
          : 'failed',
        ...(currentState === undefined ? {} : { currentState }),
        detail: receiptDetail(classified.copy),
      }, generation);
      renderPopover('restart-request');
      reportCurrentStateAvailability();
    }
  };

  const onPopoverClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const el = target?.closest?.('[data-action]') ?? null;
    if (!el) return;
    event.preventDefault();
    switch (el.getAttribute('data-action')) {
      case 'pause-request': confirming = 'pause'; renderPopover('pause-confirm'); break;
      case 'pause-cancel': confirming = null; renderPopover('pause-request'); break;
      case 'pause-confirm': void doSetPaused(true); break;
      case 'resume': void doSetPaused(false); break;
      case 'restart-request': confirming = 'restart'; renderPopover('restart-confirm'); break;
      case 'restart-cancel': confirming = null; renderPopover('restart-request'); break;
      case 'restart-confirm': void doRestart(); break;
      default: break;
    }
  };

  // The shared pill's onClick toggles the popover (clickable variant only).
  const onPillClick = (): void => {
    if (open) { closePopover(); return; }
    handoffReturn = null;
    resetActionReceipt(true);
    open = true;
    confirming = null;
    restarting = false;
    error = null;
    renderPopover();
    focusControlTitle();
  };

  // Capture-phase so it runs before the pill's bubble-phase open handler — a
  // click inside the anchor is ignored (the pill toggles it); a click outside
  // closes. At open-time `open` is still false, so this no-ops then.
  const onDocClick = (event: Event): void => {
    if (!open) return;
    const target = event.target as Node | null;
    if (target !== null && anchor !== null && anchor.contains(target)) return;
    closePopover();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!open || event.key !== 'Escape') return;
    const returnToDiagnosis = handoffReturn !== null;
    event.preventDefault();
    event.stopPropagation();
    closePopover();
    if (!returnToDiagnosis) focusPill();
  };

  const pill: ServerPillHandle = mountServerPill({
    host: pillHost,
    // B1 gate: health is only meaningful while the socket is up; otherwise the
    // banner + Account recovery copy own the down-signal, so the pill hides.
    getSnapshot: () => (opts.status() === 'connected' ? latest : null),
    clickable: controllable,
    ...(controllable ? { onClick: onPillClick } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  const syncHostVisibility = (): void => {
    if (opts.status() === 'connected' && latest !== null) {
      opts.host.removeAttribute('hidden');
    } else {
      opts.host.setAttribute('hidden', '');
    }
  };
  syncHostVisibility();
  reportAvailabilities();

  if (controllable && popoverHost !== null) {
    const doc = opts.host.ownerDocument;
    popoverHost.addEventListener('click', onPopoverClick);
    doc.addEventListener('click', onDocClick, true);
    doc.addEventListener('keydown', onKeyDown);
  }

  const unsub = opts.onStatus((status) => {
    if (disposed) return;
    // Drop the cached snapshot when leaving `connected` so a reconnect can't
    // flash a stale pill before the first fresh beat lands; also close the
    // popover (the pill is about to hide).
    if (status !== 'connected') {
      if (
        actionReceipt?.action === 'restart'
        && (
          actionReceipt.phase === 'pending'
          || actionReceipt.phase === 'accepted'
        )
      ) restartSawDisconnect = true;
      latest = null;
      latestReceivedAt = null;
      closePopover();
    }
    pill.update();
    syncHostVisibility();
    renderPopover();
    reportAvailabilities();
  });

  return {
    noteSnapshot(snapshot) {
      if (disposed) return;
      let receivedAt: number | null = null;
      try {
        const candidate = (opts.now ?? Date.now)();
        if (Number.isFinite(candidate)) receivedAt = candidate;
      } catch {
        // A broken test/embed clock cannot promote a snapshot to current.
      }
      heartbeatSequence += 1;
      latest = snapshot;
      latestReceivedAt = receivedAt;
      reconcileActionReceipt(snapshot);
      pill.update();
      syncHostVisibility();
      reportAvailabilities();
      // Reflect a heartbeat-driven pause change (e.g. paused from another
      // device, or a crash-loop) in an open popover.
      if (open) renderPopover();
    },
    openControls(handoff) {
      if (!controlsAvailable() || popoverHost === null) return 'unavailable';
      const ownerId = handoff?.ownerId.trim() ?? '';
      const sameReceiptOwner =
        ownerId.length > 0
        && ownerId === handoffOwnerId
        && actionReceipt !== null;
      if (!sameReceiptOwner) resetActionReceipt(true);
      handoffOwnerId = ownerId.length > 0 ? ownerId : null;
      handoffReturn = handoff?.onReturn ?? null;
      handoffReceiptObserver = handoff?.onReceipt ?? null;
      if (sameReceiptOwner && actionReceipt !== null) {
        try {
          handoffReceiptObserver?.({ ...actionReceipt });
        } catch {
          // Presentation observers cannot prevent the controls from opening.
        }
      }
      open = true;
      confirming = null;
      restarting = false;
      error = null;
      renderPopover();
      reportCurrentStateAvailability();
      focusControlTitle();
      return 'opened';
    },
    readCurrentState() {
      if (!currentStateAvailable() || latest === null) return null;
      return { state: latest.paused === true ? 'paused' : 'running' };
    },
    closeControls() {
      closePopover();
      handoffReturn = null;
      resetActionReceipt(true);
    },
    dispose() {
      if (disposed) return;
      handoffReturn = null;
      resetActionReceipt(true);
      disposed = true;
      reportAvailabilities();
      unsub();
      if (controllable && popoverHost !== null) {
        const doc = opts.host.ownerDocument;
        popoverHost.removeEventListener('click', onPopoverClick);
        doc.removeEventListener('click', onDocClick, true);
        doc.removeEventListener('keydown', onKeyDown);
      }
      pill.dispose();
      if (anchor !== null) {
        try { opts.host.removeChild(anchor); } catch { /* already detached */ }
      }
      opts.host.removeAttribute('hidden');
    },
  };
};
