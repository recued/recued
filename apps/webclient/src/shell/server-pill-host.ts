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

import type { WebclientConnectionStatus } from '../realtime/connection-status.js';
import { humanizeRpcError } from './rpc-error-copy.js';

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
/* D-188 — the pill becomes a clickable status + control surface. The
   popover mirrors the attention popover: an absolutely-positioned frame
   anchored under the pill, near-monochrome with one accent + one danger. */
[${SERVER_PILL_HOST_ATTR}] .server-pill-anchor {
  position: relative;
  display: inline-flex;
  align-items: center;
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
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: min(248px, calc(100vw - 32px));
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
[${SERVER_PILL_HOST_ATTR}] .server-control-status {
  color: var(--fg-muted, #71717a);
  font-size: 12px;
}
[${SERVER_PILL_HOST_ATTR}] .server-control-actions { display: flex; gap: 8px; }
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
}

export interface WebclientServerPillMount {
  /** Feed a fresh heartbeat snapshot (from the bootstrap's `server_heartbeat`
   *  demux). Re-renders — shown only if currently `connected`. */
  noteSnapshot(snapshot: ServerHeartbeatSnapshot): void;
  /** Detach the status subscription + remove the pill. Idempotent. */
  dispose(): void;
}

export const mountWebclientServerPill = (
  opts: MountWebclientServerPillOptions,
): WebclientServerPillMount => {
  const runSetPaused = opts.runSetPaused;
  const runRequestRestart = opts.runRequestRestart;
  const controllable = runSetPaused !== undefined;
  let latest: ServerHeartbeatSnapshot | null = null;
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
  let error: string | null = null;

  const crashHalted = (): boolean => latest?.crash_halt_active === true;
  const paused = (): boolean => latest?.paused === true;
  // Restart only when the rpc is wired AND a supervisor will respawn the
  // process — otherwise restart = exit-and-stay-down (a footgun).
  const canRestart = (): boolean =>
    runRequestRestart !== undefined
    && SUPERVISED_MODES.has(latest?.supervisor_mode ?? '');

  // `action` + `label` are a fixed enum (no injection); every button disables
  // while a rpc is in flight so a double-click can't fire twice.
  const button = (action: string, label: string, cls = ''): string =>
    `<button type="button" class="server-control-btn${cls}" data-action="${action}"`
    + `${busy ? ' disabled aria-busy="true"' : ''}>${label}</button>`;

  const renderPopover = (): void => {
    if (disposed || popoverHost === null) return;
    if (!open || opts.status() !== 'connected' || latest === null) {
      popoverHost.innerHTML = '';
      return;
    }
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
    if (restarting) {
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
      `<div class="server-control-popover-frame" role="dialog" aria-label="Server controls">`
      + `<div class="server-control-title">Server</div>`
      + `<div class="server-control-status${detailCls}">${detail}</div>`
      + errorHtml
      + (actions ? `<div class="server-control-actions">${actions}</div>` : '')
      + `</div>`;
  };

  const closePopover = (): void => {
    if (!open) return;
    open = false;
    confirming = null;
    restarting = false;
    error = null;
    renderPopover();
  };

  const doSetPaused = async (active: boolean): Promise<void> => {
    if (busy || runSetPaused === undefined) return;
    busy = true;
    error = null;
    renderPopover();
    try {
      await runSetPaused(active);
      // Optimistic: reflect the new state immediately (the next heartbeat
      // confirms). Keep the popover OPEN so the user sees the flipped action
      // (and can undo); they close it via outside-click / Escape / re-click.
      if (latest) latest = { ...latest, paused: active };
      busy = false;
      confirming = null;
      pill.update();
      renderPopover();
    } catch (err) {
      busy = false;
      confirming = null;
      error = humanizeRpcError(err);
      renderPopover();
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
    busy = true;
    error = null;
    renderPopover();
    try {
      const res = await runRequestRestart();
      busy = false;
      confirming = null;
      if (res && res.accepted === false) {
        // The server is already draining (e.g. a restart/restore in flight).
        error = 'A restart is already in progress.';
        renderPopover();
        return;
      }
      // Drain + supervisor handoff is underway → the WS drops next. Show a
      // transient note until the disconnect hides the pill (the global status
      // announcer then owns the reconnecting signal).
      restarting = true;
      renderPopover();
    } catch (err) {
      busy = false;
      confirming = null;
      error = humanizeRpcError(err);
      renderPopover();
    }
  };

  const onPopoverClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const el = target?.closest?.('[data-action]') ?? null;
    if (!el) return;
    event.preventDefault();
    switch (el.getAttribute('data-action')) {
      case 'pause-request': confirming = 'pause'; renderPopover(); break;
      case 'pause-cancel': confirming = null; renderPopover(); break;
      case 'pause-confirm': void doSetPaused(true); break;
      case 'resume': void doSetPaused(false); break;
      case 'restart-request': confirming = 'restart'; renderPopover(); break;
      case 'restart-cancel': confirming = null; renderPopover(); break;
      case 'restart-confirm': void doRestart(); break;
      default: break;
    }
  };

  // The shared pill's onClick toggles the popover (clickable variant only).
  const onPillClick = (): void => {
    if (open) { closePopover(); return; }
    open = true;
    confirming = null;
    restarting = false;
    error = null;
    renderPopover();
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
    if (open && event.key === 'Escape') closePopover();
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
    if (status !== 'connected') { latest = null; closePopover(); }
    pill.update();
    syncHostVisibility();
    renderPopover();
  });

  return {
    noteSnapshot(snapshot) {
      if (disposed) return;
      latest = snapshot;
      pill.update();
      syncHostVisibility();
      // Reflect a heartbeat-driven pause change (e.g. paused from another
      // device, or a crash-loop) in an open popover.
      if (open) renderPopover();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
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
