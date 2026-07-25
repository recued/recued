/** Webclient connection indicator — the topbar status chip + the
 *  offline banner, both bound to one `connection-status` controller.
 *
 *  ── Why it exists ───────────────────────────────────────────────────
 *  The webclient used to look "logged in" whenever IndexedDB held pair
 *  state, regardless of whether the paired server was actually
 *  reachable. This surface makes the LIVE connection visible:
 *
 *    - a small **chip** in the topbar (calm dot when connected, an
 *      accent "Reconnecting…" while a blip rides out, a danger "Offline"
 *      on a sustained outage), and
 *    - a route-independent **banner** at the app root that appears ONLY
 *      while `offline` — the unmissable "can't reach your server" signal.
 *
 *  Both render from the same `status()` / `onStatus()` seam so they can
 *  never disagree, and both follow the near-monochrome design system
 *  (D-174: one accent + one danger) — connected is intentionally the
 *  quietest state (a muted dot, no text) so the chrome only draws the
 *  eye when something is wrong.
 *
 *  ── Render model ────────────────────────────────────────────────────
 *  `createElement` + `textContent` only — no `innerHTML`, so this mounts
 *  cleanly under the node-env fake DOM the webclient tests use. A
 *  `data-state` attribute carries the status for CSS + as the stable
 *  test hook. The exported `CONNECTION_INDICATOR_STYLES` are injected
 *  once into `<head>` by the bootstrap (marker-guarded so a re-bootstrap
 *  on the same document doesn't stack them) — the same mount-creates-
 *  nodes / bootstrap-injects-styles split the notify toasts use, which
 *  keeps this mount touching only `createElement`. */

import type { WebclientConnectionStatus } from '../realtime/connection-status.js';

export const CONNECTION_CHIP_ATTR = 'data-recued-connection-chip';
export const CONNECTION_BANNER_ATTR = 'data-recued-connection-banner';
/** `<head>` `<style>` marker — injected once, marker-guarded. */
export const CONNECTION_INDICATOR_STYLES_MARKER =
  'data-recued-connection-indicator-styles';

/** Per-status presentation. `chipText` is empty for `connected` so the
 *  happy path is a bare dot; the chip's `aria-label` always carries the
 *  full state for screen readers. `showBanner` is the offline-only gate. */
const PRESENTATION: Record<
  WebclientConnectionStatus,
  { chipText: string; ariaLabel: string; showBanner: boolean }
> = {
  connecting: {
    chipText: 'Connecting…',
    ariaLabel: 'Connecting to your server',
    showBanner: false,
  },
  connected: {
    chipText: '',
    ariaLabel: 'Connected to your server',
    showBanner: false,
  },
  reconnecting: {
    chipText: 'Reconnecting…',
    ariaLabel: 'Reconnecting to your server',
    showBanner: false,
  },
  // Half-open server (socket up, not answering). Deliberately presented
  // IDENTICALLY to `reconnecting` — it auto-recovers on the next heartbeat,
  // so there is nothing for the user to do. The rpc layer fast-fails it
  // (see rpc-conn) without surfacing a scary "act now" state or the red
  // offline banner; the calm chip is the only ambient signal.
  stalled: {
    chipText: 'Reconnecting…',
    ariaLabel: 'Reconnecting to your server',
    showBanner: false,
  },
  offline: {
    chipText: 'Offline',
    ariaLabel: 'Your server is unreachable',
    showBanner: true,
  },
};

export const CONNECTION_INDICATOR_STYLES = `
[${CONNECTION_CHIP_ATTR}] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid transparent;
  color: var(--fg-muted);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: -0.005em;
  white-space: nowrap;
  user-select: none;
}
[${CONNECTION_CHIP_ATTR}] .recued-connection-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex: 0 0 auto;
  background: var(--fg-subtle);
}
[${CONNECTION_CHIP_ATTR}] .recued-connection-label:empty {
  display: none;
}
/* Connected — the quietest state: a muted dot, no label, no border. */
[${CONNECTION_CHIP_ATTR}][data-state="connected"] .recued-connection-dot {
  background: var(--fg-subtle);
}
/* Connecting / reconnecting / stalled — accent (active/working) + a gentle
   pulse. The stalled (half-open server) state shares this calm treatment. */
[${CONNECTION_CHIP_ATTR}][data-state="connecting"],
[${CONNECTION_CHIP_ATTR}][data-state="reconnecting"],
[${CONNECTION_CHIP_ATTR}][data-state="stalled"] {
  color: var(--fg-muted);
}
[${CONNECTION_CHIP_ATTR}][data-state="connecting"] .recued-connection-dot,
[${CONNECTION_CHIP_ATTR}][data-state="reconnecting"] .recued-connection-dot,
[${CONNECTION_CHIP_ATTR}][data-state="stalled"] .recued-connection-dot {
  background: var(--accent);
  animation: recued-connection-pulse 1.4s ease-in-out infinite;
}
/* Offline — the one danger state: a red dot + a danger-tinted pill. */
[${CONNECTION_CHIP_ATTR}][data-state="offline"] {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--danger-bg);
}
[${CONNECTION_CHIP_ATTR}][data-state="offline"] .recued-connection-dot {
  background: var(--danger);
}
@keyframes recued-connection-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  [${CONNECTION_CHIP_ATTR}] .recued-connection-dot { animation: none; }
}
/* The offline banner — fixed at the top of the viewport, above the shell
   chrome but below modals/prompts (z 50, matching the retired re-pair
   banner). Hidden unless data-state="offline". */
[${CONNECTION_BANNER_ATTR}] {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 50;
  display: none;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--danger);
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
  text-align: center;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
}
[${CONNECTION_BANNER_ATTR}][data-state="offline"] {
  display: flex;
}
`;

export interface MountConnectionIndicatorOptions {
  /** Topbar slot the chip is appended to (created by the shell). */
  chipHost: HTMLElement;
  /** App-root element the offline banner is appended to (route-
   *  independent, survives route swaps — same posture as the toasts). */
  bannerHost: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** Current connection status — read once for the initial render. */
  status: () => WebclientConnectionStatus;
  /** Subscribe to status transitions. Returns an unsubscribe fn. */
  onStatus: (listener: (status: WebclientConnectionStatus) => void) => () => void;
}

export interface ConnectionIndicatorMount {
  /** Tear down: drop the subscription + remove both nodes. Idempotent. */
  dispose(): void;
}

export const mountConnectionIndicator = (
  opts: MountConnectionIndicatorOptions,
): ConnectionIndicatorMount => {
  const doc =
    opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountConnectionIndicator: no document available — pass `opts.document` for non-browser environments',
    );
  }

  // Styles live in `<head>` and are injected by the bootstrap (guarded by
  // `CONNECTION_INDICATOR_STYLES_MARKER`), the same split the notify toasts
  // use — so this mount only ever touches `createElement` and stays trivial
  // to drive under the node-env fake DOM.

  // ── Chip ────────────────────────────────────────────────────────────
  const chip = doc.createElement('span');
  chip.setAttribute(CONNECTION_CHIP_ATTR, '');
  chip.setAttribute('role', 'status');
  chip.setAttribute('aria-live', 'polite');
  const dot = doc.createElement('span');
  dot.className = 'recued-connection-dot';
  dot.setAttribute('aria-hidden', 'true');
  const label = doc.createElement('span');
  label.className = 'recued-connection-label';
  chip.appendChild(dot);
  chip.appendChild(label);
  opts.chipHost.appendChild(chip);

  // ── Offline banner ──────────────────────────────────────────────────
  const banner = doc.createElement('div');
  banner.setAttribute(CONNECTION_BANNER_ATTR, '');
  banner.setAttribute('role', 'alert');
  const bannerText = doc.createElement('span');
  bannerText.textContent =
    'Can’t reach your server. Retrying to reconnect…';
  banner.appendChild(bannerText);
  opts.bannerHost.appendChild(banner);

  const render = (status: WebclientConnectionStatus): void => {
    const view = PRESENTATION[status];
    chip.setAttribute('data-state', status);
    chip.setAttribute('aria-label', view.ariaLabel);
    chip.setAttribute('title', view.ariaLabel);
    label.textContent = view.chipText;
    banner.setAttribute('data-state', view.showBanner ? 'offline' : 'ok');
  };

  render(opts.status());
  const unsub = opts.onStatus((status) => render(status));

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsub();
      try {
        opts.chipHost.removeChild(chip);
      } catch {
        /* already detached (shell torn down first) — best-effort */
      }
      try {
        opts.bannerHost.removeChild(banner);
      } catch {
        /* already detached — best-effort */
      }
    },
  };
};
