/** Webclient route-independent connection callout and status announcer.
 *
 *  Connection identity, details, and actions live in Account -> Server
 *  profiles. This module deliberately keeps only what must survive every route:
 *  a sustained-outage banner, a direct handoff to that Account surface, a
 *  polite restoration or reconciled-context receipt, and a visually hidden
 *  live announcer for short reconnecting/stalled transitions. The transport
 *  retries by itself, so no fake manual retry is offered here.
 *
 *  `createElement` + `textContent` only — no `innerHTML`, so the mount remains
 *  usable under the webclient's node-env fake DOM. Styles are exported for the
 *  bootstrap's one-time, marker-guarded injection. */

import type { WebclientConnectionStatus } from '../realtime/connection-status.js';

export const CONNECTION_INDICATOR_ATTR =
  'data-recued-connection-indicator';
export const CONNECTION_BANNER_ATTR = 'data-recued-connection-banner';
export const CONNECTION_BANNER_ACTION_ATTR =
  'data-recued-connection-banner-action';
export const CONNECTION_STATUS_ANNOUNCER_ATTR =
  'data-recued-connection-status-announcer';
/** `<head>` `<style>` marker — injected once, marker-guarded. */
export const CONNECTION_INDICATOR_STYLES_MARKER =
  'data-recued-connection-indicator-styles';

export const CONNECTION_RESTORED_RECEIPT_MS = 5_000;
export const CONNECTION_ATTENTION_RECEIPT_MS = 10_000;

/** All that survives of the per-status view model: whether this status shows
 *  the outage banner. The chip's copy (`chipText` / `statusLabel` / `title` /
 *  `detail`) and its recovery steps left with the chip and the popover — the
 *  account menu owns that wording now. Keeping the fields here would read as
 *  live copy nobody renders. */
interface ConnectionPresentation {
  readonly showOfflineBanner: boolean;
}

const PRESENTATION: Record<WebclientConnectionStatus, ConnectionPresentation> = {
  connecting: { showOfflineBanner: false },
  connected: { showOfflineBanner: false },
  // `reconnecting` / `stalled` stay quiet on purpose: both self-heal, and the
  // whole point of the grace window is to ride out a blip without alarming.
  reconnecting: { showOfflineBanner: false },
  stalled: { showOfflineBanner: false },
  offline: { showOfflineBanner: true },
};

export const CONNECTION_INDICATOR_STYLES = `
[${CONNECTION_INDICATOR_ATTR}] { display: contents; }
[${CONNECTION_STATUS_ANNOUNCER_ATTR}] {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
[${CONNECTION_BANNER_ATTR}] {
  position: fixed;
  inset-inline: 0;
  bottom: 0;
  z-index: 70;
  box-sizing: border-box;
  display: none;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 14px max(8px, env(safe-area-inset-bottom));
  font-size: 13px;
}
[${CONNECTION_BANNER_ATTR}][data-state="offline"],
[${CONNECTION_BANNER_ATTR}][data-state="restored"],
[${CONNECTION_BANNER_ATTR}][data-state="attention"] { display: flex; }
[${CONNECTION_BANNER_ATTR}][data-state="offline"] {
  background: var(--recued-danger-surface, #fdeceb);
  color: var(--recued-danger, #b3261e);
}
[${CONNECTION_BANNER_ATTR}][data-state="restored"] {
  background: var(--recued-ok-surface, #e8f5ec);
  color: var(--recued-ok, #2f6b45);
}
[${CONNECTION_BANNER_ATTR}][data-state="attention"] {
  background: var(--surface-sunk, #fff4e5);
  color: var(--fg, #6b4100);
  border-top: 1px solid var(--border-strong, #d4d4d8);
}
[${CONNECTION_BANNER_ATTR}] > span {
  flex: 1 1 20rem;
  min-width: 0;
}
[${CONNECTION_BANNER_ACTION_ATTR}] {
  flex: 0 0 auto;
  margin-left: auto;
  min-height: 44px;
  padding: 7px 12px;
  border-radius: 999px;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
[${CONNECTION_BANNER_ACTION_ATTR}]:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
[${CONNECTION_BANNER_ACTION_ATTR}][hidden] { display: none; }
@media (prefers-color-scheme: dark) {
  [${CONNECTION_BANNER_ATTR}][data-state="offline"] {
    background: var(--recued-danger-surface, #3b1f1d);
  }
  [${CONNECTION_BANNER_ATTR}][data-state="restored"] {
    background: var(--recued-ok-surface, #1e3527);
  }
  :root:not([data-theme]) [${CONNECTION_BANNER_ATTR}][data-state="attention"] {
    background: var(--surface-sunk, #242428);
    color: var(--fg, #e4e4e7);
  }
}
:root[data-theme="dark"] [${CONNECTION_BANNER_ATTR}][data-state="attention"] {
  background: var(--surface-sunk, #242428);
  color: var(--fg, #e4e4e7);
}
@media (max-width: 520px) {
  [${CONNECTION_BANNER_ACTION_ATTR}] {
    width: 100%;
    margin-left: 0;
  }
}
`;

export interface ConnectionReceiptAction {
  readonly label: string;
  readonly onSelect: () => void;
}

export interface ConnectedReceiptPayload {
  readonly copy: string;
  readonly action?: ConnectionReceiptAction;
  readonly tone?: 'success' | 'attention';
}

export interface ConnectedReceipt extends ConnectedReceiptPayload {
  /** A freshness-neutral replacement when the primary receipt cannot be
   * shown until a later connected transition. Omitting it declines delayed
   * delivery rather than replaying potentially stale copy. */
  readonly afterReconnect?: ConnectedReceiptPayload;
}

export interface MountConnectionIndicatorOptions {
  /** Visually hidden live-status host. Kept separate from the banner so short
   *  reconnecting transitions remain screen-reader-visible without a callout. */
  statusHost: HTMLElement;
  /** App-root element the outage/restoration banner is appended to. */
  bannerHost: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** Current connection status — read once for the initial render. */
  status: () => WebclientConnectionStatus;
  /** Subscribe to status transitions. Returns an unsubscribe fn. */
  onStatus: (listener: (status: WebclientConnectionStatus) => void) => () => void;
  /** What the banner's "Review server profiles" does. Production opens the
   *  Account dialog, which carries the explanation and profiles. Absent ⇒ the
   *  action button never renders, because a button that does nothing is worse
   *  than no button. */
  onRecoveryAction?: () => void;
  /** Stable shell control to receive focus when a status transition retires a
   * focused banner action. Explicit actions and pagehide own their own handoff. */
  focusAfterActionRetires?: () => HTMLElement | null;
  /** Restoration receipt lifetime. Defaults to five seconds. */
  restoredReceiptMs?: number;
  /** Reconciled attention receipt lifetime. Defaults to ten seconds so its
   * corrective copy remains readable. */
  attentionReceiptMs?: number;
  /** Show one restoration receipt on the first connected frame. Used after
   * in-process pairing or startup recovery, whose new controller has no prior
   * outage state. */
  receiptOnFirstConnected?: boolean;
  /** Optional copy for every ordinary restored receipt. */
  restoredReceiptCopy?: string;
  /** One-shot copy for `receiptOnFirstConnected`; later outages return to the
   * ordinary restored copy so a stale re-pair message is never repeated. */
  firstConnectedReceiptCopy?: string;
  /** Optional one-shot action paired with the first-connected receipt. Later
   * reconnect receipts never inherit it. */
  firstConnectedReceiptAction?: ConnectionReceiptAction;
  /** Timer seams for deterministic tests. */
  setTimer?: (handler: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ConnectionIndicatorMount {
  /** Present a later one-shot receipt after a route-owned reconciliation. If
   * still connecting/offline, only its explicit freshness-neutral
   * `afterReconnect` replacement may wait for the next connected transition. */
  showConnectedReceipt(receipt: ConnectedReceipt): boolean;
  /** Tear down subscription, timers, listeners, and nodes. Idempotent. */
  dispose(): void;
}

export const mountConnectionIndicator = (
  opts: MountConnectionIndicatorOptions,
): ConnectionIndicatorMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountConnectionIndicator: no document available — pass `opts.document` for non-browser environments',
    );
  }

  const setTimer = opts.setTimer
    ?? ((handler: () => void, delayMs: number): unknown =>
      globalThis.setTimeout(handler, delayMs));
  const clearTimer = opts.clearTimer
    ?? ((handle: unknown): void =>
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  const restoredReceiptMs =
    opts.restoredReceiptMs ?? CONNECTION_RESTORED_RECEIPT_MS;
  const attentionReceiptMs =
    opts.attentionReceiptMs ?? CONNECTION_ATTENTION_RECEIPT_MS;
  const restoredReceiptCopy =
    opts.restoredReceiptCopy ?? 'Back online. Your server is reachable again.';

  // The topbar chip + its recovery popover were REMOVED. The account menu's
  // badge is the signal now, and that menu carries the explanation and the
  // remedy (switch server) in one place — the popover's own third step used
  // to point at Settings pages the outage made unreachable.
  //
  // What did NOT go: this announcer, and the banner below. A badge is a colour
  // cue; without an aria-live region a screen reader learns nothing about the
  // transitions the badge is silent for.
  const indicator = doc.createElement('div');
  indicator.setAttribute(CONNECTION_INDICATOR_ATTR, '');
  const statusAnnouncer = doc.createElement('span');
  statusAnnouncer.setAttribute(CONNECTION_STATUS_ANNOUNCER_ATTR, '');
  statusAnnouncer.setAttribute('role', 'status');
  statusAnnouncer.setAttribute('aria-live', 'polite');
  statusAnnouncer.setAttribute('aria-atomic', 'true');
  indicator.appendChild(statusAnnouncer);
  opts.statusHost.appendChild(indicator);

  // ── Route-independent outage + restoration banner ─────────────────
  const banner = doc.createElement('div');
  banner.setAttribute(CONNECTION_BANNER_ATTR, '');
  banner.setAttribute('aria-atomic', 'true');
  const bannerText = doc.createElement('span');
  banner.appendChild(bannerText);
  const bannerAction = doc.createElement('button');
  bannerAction.setAttribute('type', 'button');
  bannerAction.setAttribute(CONNECTION_BANNER_ACTION_ATTR, '');
  bannerAction.textContent = 'Review server profiles';
  banner.appendChild(bannerAction);
  opts.bannerHost.appendChild(banner);

  let currentStatus = opts.status();
  let receiptTimer: unknown = null;
  let receiptAction: MountConnectionIndicatorOptions[
    'firstConnectedReceiptAction'
  ] = undefined;
  let pendingConnectedReceipt: ConnectedReceiptPayload | null = null;
  let visitRetired = false;
  let disposed = false;

  const cancelReceipt = (): void => {
    if (receiptTimer === null) return;
    clearTimer(receiptTimer);
    receiptTimer = null;
  };

  const renderBanner = (
    state: 'ok' | 'offline' | 'restored' | 'attention',
    action?: MountConnectionIndicatorOptions['firstConnectedReceiptAction'],
    behavior?: { preserveActionFocus?: boolean },
  ): void => {
    const actionHadFocus = doc.activeElement === bannerAction;
    receiptAction = state === 'restored' || state === 'attention'
      ? action
      : undefined;
    banner.setAttribute('data-state', state);
    if (state === 'offline') {
      banner.setAttribute('role', 'alert');
      banner.setAttribute('aria-live', 'assertive');
      bannerText.textContent =
        'Can’t reach the current server. Recued will keep trying.';
      bannerAction.textContent = 'Review server profiles';
      if (opts.onRecoveryAction === undefined) {
        bannerAction.setAttribute('hidden', '');
      } else {
        bannerAction.removeAttribute('hidden');
      }
      return;
    }
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    if (
      (state === 'restored' || state === 'attention')
      && action !== undefined
    ) {
      bannerAction.textContent = action.label;
      bannerAction.removeAttribute('hidden');
    } else {
      bannerAction.setAttribute('hidden', '');
    }
    bannerText.textContent = state === 'restored' || state === 'attention'
      ? restoredReceiptCopy
      : '';
    if (
      actionHadFocus
      && bannerAction.hasAttribute('hidden')
      && behavior?.preserveActionFocus !== false
    ) {
      const fallback = opts.focusAfterActionRetires?.() ?? null;
      if (
        fallback !== null
        && fallback.isConnected !== false
        && !fallback.hasAttribute('hidden')
      ) {
        try {
          fallback.focus({ preventScroll: true });
        } catch {
          // A concurrently detached shell is already yielding focus ownership.
        }
      }
    }
  };

  const showRestoredReceipt = (
    copy = restoredReceiptCopy,
    action?: MountConnectionIndicatorOptions['firstConnectedReceiptAction'],
    tone: ConnectedReceipt['tone'] = 'success',
  ): void => {
    cancelReceipt();
    renderBanner(tone === 'attention' ? 'attention' : 'restored', action);
    bannerText.textContent = copy;
    const receiptMs = tone === 'attention'
      ? attentionReceiptMs
      : restoredReceiptMs;
    if (receiptMs <= 0) return;
    receiptTimer = setTimer(() => {
      receiptTimer = null;
      if (disposed || currentStatus !== 'connected') return;
      renderBanner('ok');
    }, receiptMs);
  };

  const render = (
    status: WebclientConnectionStatus,
    behavior?: {
      restored?: boolean;
      receiptCopy?: string;
      receiptAction?: MountConnectionIndicatorOptions[
        'firstConnectedReceiptAction'
      ];
      receiptTone?: ConnectedReceipt['tone'];
    },
  ): void => {
    const view = PRESENTATION[status];
    currentStatus = status;
    statusAnnouncer.textContent = status === 'reconnecting'
      ? 'Connection interrupted. Recued is reconnecting automatically.'
      : status === 'stalled'
        ? 'Your server is not responding. Recued is waiting for it to recover.'
        : status === 'connecting'
          ? 'Connecting to your server.'
          : '';
    if (behavior?.restored === true) {
      showRestoredReceipt(
        behavior.receiptCopy,
        behavior.receiptAction,
        behavior.receiptTone,
      );
    } else {
      cancelReceipt();
      renderBanner(view.showOfflineBanner ? 'offline' : 'ok');
    }
  };

  // Offline hands off to Account. A recovery-arrival receipt instead dismisses
  // itself before returning focus to the exact safe area, so double clicks,
  // timer expiry, and browser-history restoration cannot replay the handoff.
  bannerAction.addEventListener('click', () => {
    if (
      (
        banner.getAttribute('data-state') === 'restored'
        || banner.getAttribute('data-state') === 'attention'
      )
      && receiptAction !== undefined
    ) {
      const action = receiptAction;
      cancelReceipt();
      renderBanner('ok', undefined, { preserveActionFocus: false });
      action.onSelect();
      return;
    }
    if (banner.getAttribute('data-state') === 'offline') {
      opts.onRecoveryAction?.();
    }
  });

  let firstConnectedReceiptPending = opts.receiptOnFirstConnected === true;
  const initialRestored =
    currentStatus === 'connected' && firstConnectedReceiptPending;
  if (initialRestored) firstConnectedReceiptPending = false;
  render(currentStatus, {
    restored: initialRestored,
    ...(initialRestored && opts.firstConnectedReceiptCopy !== undefined
      ? { receiptCopy: opts.firstConnectedReceiptCopy }
      : {}),
    ...(initialRestored && opts.firstConnectedReceiptAction !== undefined
      ? { receiptAction: opts.firstConnectedReceiptAction }
      : {}),
  });
  // A restoration/context banner is transient to this visible visit. Retire
  // it before the document enters browser history / BFCache so returning with
  // Back or Forward cannot replay a pairing, reconnection, or return receipt.
  const pageEvents = doc.defaultView as unknown as {
    addEventListener?: (type: string, listener: (event: Event) => void) => void;
    removeEventListener?: (type: string, listener: (event: Event) => void) => void;
  } | null;
  const onPageHide = (): void => {
    // A late route read must not resurrect an arrival receipt after this page
    // has entered browser history/BFCache. A future bootstrap gets a fresh
    // mount; this visit has already consumed its one-shot marker.
    visitRetired = true;
    firstConnectedReceiptPending = false;
    pendingConnectedReceipt = null;
    if (
      banner.getAttribute('data-state') !== 'restored'
      && banner.getAttribute('data-state') !== 'attention'
    ) return;
    cancelReceipt();
    renderBanner('ok', undefined, { preserveActionFocus: false });
  };
  pageEvents?.addEventListener?.('pagehide', onPageHide);
  let sustainedInterruptionSeen =
    currentStatus === 'stalled' || currentStatus === 'offline';
  const unsub = opts.onStatus((status) => {
    if (status === 'stalled' || status === 'offline') {
      sustainedInterruptionSeen = true;
    }
    const firstConnectedReceipt =
      status === 'connected' && firstConnectedReceiptPending;
    const queuedConnectedReceipt = status === 'connected'
      ? pendingConnectedReceipt
      : null;
    const restored =
      status === 'connected'
      && (
        sustainedInterruptionSeen
        || firstConnectedReceipt
        || queuedConnectedReceipt !== null
      );
    if (status === 'connected') {
      sustainedInterruptionSeen = false;
      firstConnectedReceiptPending = false;
      pendingConnectedReceipt = null;
    }
    render(status, {
      restored,
      ...(queuedConnectedReceipt !== null
        ? { receiptCopy: queuedConnectedReceipt.copy }
        : firstConnectedReceipt && opts.firstConnectedReceiptCopy !== undefined
        ? { receiptCopy: opts.firstConnectedReceiptCopy }
        : {}),
      ...(queuedConnectedReceipt?.action !== undefined
        ? { receiptAction: queuedConnectedReceipt.action }
        : firstConnectedReceipt && opts.firstConnectedReceiptAction !== undefined
        ? { receiptAction: opts.firstConnectedReceiptAction }
        : {}),
      ...(queuedConnectedReceipt?.tone !== undefined
        ? { receiptTone: queuedConnectedReceipt.tone }
        : {}),
    });
  });

  return {
    showConnectedReceipt(receipt) {
      if (
        disposed
        || visitRetired
        || receipt.copy.trim().length === 0
      ) return false;
      const safeReceipt: ConnectedReceiptPayload = {
        copy: receipt.copy,
        ...(receipt.action !== undefined ? { action: receipt.action } : {}),
        ...(receipt.tone !== undefined ? { tone: receipt.tone } : {}),
      };
      if (currentStatus === 'connected') {
        showRestoredReceipt(
          safeReceipt.copy,
          safeReceipt.action,
          safeReceipt.tone,
        );
      } else {
        const delayed = receipt.afterReconnect;
        if (delayed === undefined || delayed.copy.trim().length === 0) {
          return false;
        }
        pendingConnectedReceipt = {
          copy: delayed.copy,
          ...(delayed.action !== undefined ? { action: delayed.action } : {}),
          ...(delayed.tone !== undefined ? { tone: delayed.tone } : {}),
        };
      }
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingConnectedReceipt = null;
      cancelReceipt();
      unsub();
      pageEvents?.removeEventListener?.('pagehide', onPageHide);
      try {
        opts.statusHost.removeChild(indicator);
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
