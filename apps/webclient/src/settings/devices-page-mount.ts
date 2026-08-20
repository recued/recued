/** D-156 P5 — Settings → Devices page mount.
 *
 *  Mounts the restored `renderDevicesPage` renderer (P2) under the
 *  Settings → Devices section, wires `pair.list` for roster reads and
 *  `pair.revoke` for per-row revocation, and drives the inline two-
 *  stage confirm state machine described in
 *  D-156 § Behaviour rules.
 *
 *  Lifts the surface from the slice-129 `pair-mint-panel` + slice-131
 *  `devices-history-panel` that D-156 P8 will delete. The new surface
 *  is read-from-server (durable + live roster) rather than per-session
 *  mint-history — the operator's mental model is "what devices are
 *  currently paired" not "what links did I generate this session".
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — `pair.list` rows ship the contract shape
 *  (`ServerPairedDevice`) — `added_at` + `revoked_at: number | null` +
 *  optional `connected_at`. `refresh` FILTERS OUT revoked rows
 *  (`revoked_at !== null`) so the active roster only lists live devices
 *  (R30 — revoked devices drop off; they persist only in the audit log).
 *  `toDevicesPageRow` maps the survivors to `DevicesPageRow`: `paired_at`
 *  ← `added_at` (the pairing-date column) and `kind` ← `device.kind`.
 *  It no longer overloads `connected_at ?? added_at` as "last seen" — the
 *  renderer shows an Online/Offline Status; accurate last-seen-while-
 *  offline awaits the D-156 P10 contract field. `isCurrent` is resolved
 *  against an optional `currentInstanceId`; the mount HARD-guards the
 *  revoke handler against self (R30 defect #1), so self-revoke protection
 *  no longer depends on the render alone.
 *
 *  DD#2 — Two-stage confirm is single-row only. Clicking Revoke on row
 *  B while row A is confirming COLLAPSES A and OPENS B in the same
 *  render pass. Matches the TLS renew + Clear-this-browser panels
 *  from D-148 slices 110/111. The state-machine transitions live in
 *  this mount (not the renderer) so the renderer stays pure.
 *
 *  DD#3 — Roster refresh follows revoke success. The mount renders a
 *  durable success receipt as soon as `pair.revoke` resolves, then
 *  reconciles against `pair.list`; the accepted row disappears when
 *  that authoritative roster reports its `revoked_at` stamp. The
 *  delegated click path remains fire-and-forget, while the internal
 *  pipeline awaits reconciliation so it can preserve a useful focus
 *  owner across both renders. On rpc failure the mount surfaces an
 *  inline error + keeps the confirm panel expanded.
 *
 *  DD#4 — Auto-refresh on mount + live `pair.list_changed`. The mount
 *  fires `runPairList` once on construction so a cold-load Settings →
 *  Devices renders the current roster without the user clicking
 *  anything. A failure surfaces inline as "Couldn't load devices"; the
 *  user can refresh manually via a re-mount (settings route flip). When
 *  the optional `subscribe` seam is wired (production threads the
 *  bootstrap's `subscriber.on`), the mount also subscribes to the
 *  `pair.list_changed` broadcast and re-calls `runPairList` on it — so a
 *  pair / revoke on another paired client reflects here live (no
 *  single-row reducer; the server-resolved roster stays authoritative).
 *  The subscription is torn down in `dispose()`.
 *
 *  DD#5 — `dispose()` removes the host's children + detaches the
 *  delegated click listener. The renderer's HTML is owned wholesale
 *  by the mount's host element; clearing innerHTML is a clean wipe.
 *
 *  Spec: D-156
 *  § Settings → Devices page shape. */

import type { ServerPairedDevice } from '@recued/contracts';
import {
  renderDevicesPage,
  type DevicesPageRow,
  type DevicesPageState,
} from '@recued/ui-shared/account';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Rpc callers
// ════════════════════════════════════════════════════════════════

/** Returns the current paired-device roster. Production wires
 *  `() => conn('pair.list', undefined)`; tests inject a fake. */
export type PairListCaller = () => Promise<{ devices: ServerPairedDevice[] }>;

/** Revokes one device. Production wires
 *  `(args) => conn('pair.revoke', args)`; tests inject a fake.
 *  Rejection surfaces inline in the confirm panel. */
export type PairRevokeCaller = (args: {
  instance_id: string;
}) => Promise<{ ok: true }>;

// ════════════════════════════════════════════════════════════════
// Mount options + handle
// ════════════════════════════════════════════════════════════════

export interface MountDevicesPageOptions {
  /** Element the renderer mounts into. Owned wholesale — innerHTML
   *  is overwritten on every state transition. */
  host: HTMLElement;
  /** `pair.list` rpc caller. Fires once on mount + after every
   *  successful revoke. */
  runPairList: PairListCaller;
  /** `pair.revoke` rpc caller. Fires on the user's "Yes, revoke"
   *  click after the inline confirm. */
  runPairRevoke: PairRevokeCaller;
  /** Optional — the locally-known instance id for this client. When
   *  set, the matching row is pinned to the top + denied a Revoke
   *  button (self-revoke blocked per spec § Behaviour rules). When
   *  absent, every row renders a Revoke button — the renderer is the
   *  only enforcer of the self-revoke gate, so callers MUST supply
   *  this when they know it. */
  currentInstanceId?: string;
  /** Optional clock seam (tests). Defaults to `Date.now`. Threads
   *  through to the renderer's relative-time formatter. */
  now?: () => number;
  /** Optional sink fired when `pair.list` rejects. Best-effort —
   *  throws are swallowed by the mount. Defaults to no-op. */
  onListError?: (err: Error) => void;
  /** Optional broadcast-subscribe seam (`BroadcastSubscriber['on']`).
   *  Production wires the bootstrap's `subscriber.on`; tests inject a
   *  fake or omit it. When present the mount subscribes to
   *  `pair.list_changed` and re-fetches the roster on it (DD#4), and
   *  unsubscribes on `dispose()`. Absent ⇒ the mount is mount-fetch +
   *  revoke-refresh only (the pre-D-156-follow-on behaviour). */
  subscribe?: BroadcastSubscriber['on'];
}

export interface DevicesPageMount {
  /** Re-fetch the roster + re-render. Idempotent. */
  refresh(): Promise<void>;
  /** A user-confirmed revoke whose authoritative roster refresh has not
   *  settled. Initial, broadcast, and retry list reads are excluded. */
  hasInFlightWork(): boolean;
  /** Synchronous teardown — clears host + detaches the click
   *  listener. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// State machine
// ════════════════════════════════════════════════════════════════

interface MountState {
  rows: DevicesPageRow[];
  confirmingInstanceId?: string;
  revokingInstanceId?: string;
  revokeError?: string;
  revokeSucceeded?: boolean;
  listError?: string;
  listRetrying?: boolean;
  loading: boolean;
}

const LIST_ERROR_COPY =
  "Couldn't load paired devices — check your server's connection, then retry.";

const REVOKE_ERROR_COPY = (detail: string): string => {
  const trimmed = detail.trim();
  const punctuatedDetail = trimmed.length === 0
    ? ''
    : /[.!?]$/.test(trimmed)
      ? trimmed
      : `${trimmed}.`;
  const firstSentence = punctuatedDetail
    ? `Could not revoke this device: ${punctuatedDetail}`
    : 'Could not revoke this device.';
  return `${firstSentence} Try again, or revoke from a different paired device.`;
};

const toDevicesPageRow = (
  device: ServerPairedDevice,
  currentInstanceId: string | undefined,
): DevicesPageRow => ({
  instance_id: device.instance_id,
  display_name: device.display_name,
  // D-156 P10 — the real per-device kind from the durable store
  // (`ServerPairedDevice.kind`; NULL legacy rows resolve to 'webclient'
  // server-side). `PairListEntryKind` and `ClientKind` share the same
  // 'webclient' | 'bridge' | 'cli' closed list, so this is a direct map.
  kind: device.kind,
  connected: device.connected,
  // R30 — the pairing date (`added_at`, unix seconds → ms). Shown in its
  // own "Paired" column. We no longer overload `connected_at ?? added_at`
  // as "last seen": that mislabeled the pairing time for offline rows
  // (defect #2). Accurate last-seen-while-offline awaits the D-156 P10
  // contract field; until then the renderer shows an Online/Offline status.
  paired_at: (device.added_at || 0) * 1000,
  isCurrent:
    currentInstanceId !== undefined &&
    device.instance_id === currentInstanceId,
});

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

/** Render the devices roster + wire revoke. Fires `runPairList` once
 *  on mount + after every successful revoke. */
export const mountDevicesPage = (
  options: MountDevicesPageOptions,
): DevicesPageMount => {
  const { host, runPairList, runPairRevoke } = options;

  let state: MountState = {
    rows: [],
    loading: true,
  };
  let disposed = false;
  let revokeInFlight = false;

  const findAction = (
    action: string,
    instanceId?: string,
  ): HTMLElement | null => {
    if (typeof host.querySelectorAll !== 'function') return null;
    const candidates = host.querySelectorAll<HTMLElement>(
      `[data-action="${action}"]`,
    );
    for (const candidate of candidates) {
      if (
        instanceId === undefined
        || candidate.getAttribute('data-instance-id') === instanceId
      ) {
        return candidate;
      }
    }
    return null;
  };

  const focusAction = (action: string, instanceId?: string): boolean => {
    const candidate = findAction(action, instanceId);
    if (candidate === null) return false;
    candidate.focus({ preventScroll: true });
    candidate.scrollIntoView?.({ block: 'nearest' });
    return true;
  };

  const actionHasFocus = (action: string, instanceId?: string): boolean => {
    // ⛔ `?? null` IS LOAD-BEARING. `ownerDocument?.activeElement` yields
    // UNDEFINED when either is absent, and the cast claimed null-only — so the
    // `active === null` clause below passed it through and `typeof
    // active.getAttribute` threw on the very guard meant to protect the call.
    // That unhandled TypeError aborted doRevoke between the resolved revoke and
    // its roster refresh, so a revoked device stayed on the active roster.
    const active = (host.ownerDocument?.activeElement ?? null) as HTMLElement | null;
    if (active === null || typeof active.getAttribute !== 'function') {
      return false;
    }
    return active.getAttribute('data-action') === action
      && (
        instanceId === undefined
        || active.getAttribute('data-instance-id') === instanceId
      );
  };

  const focusedRevokeAction = (
    instanceId: string,
  ): 'cancel-revoke' | 'confirm-revoke' | undefined => {
    // ⛔ `?? null` IS LOAD-BEARING. `ownerDocument?.activeElement` yields
    // UNDEFINED when either is absent, and the cast claimed null-only — so the
    // `active === null` clause below passed it through and `typeof
    // active.getAttribute` threw on the very guard meant to protect the call.
    // That unhandled TypeError aborted doRevoke between the resolved revoke and
    // its roster refresh, so a revoked device stayed on the active roster.
    const active = (host.ownerDocument?.activeElement ?? null) as HTMLElement | null;
    if (active === null || typeof active.getAttribute !== 'function') {
      return undefined;
    }
    if (active.getAttribute('data-instance-id') !== instanceId) return undefined;
    const action = active.getAttribute('data-action');
    return action === 'cancel-revoke' || action === 'confirm-revoke'
      ? action
      : undefined;
  };

  const focusSuccessReceipt = (): void => {
    if (typeof host.querySelector !== 'function') return;
    const receipt = host.querySelector<HTMLElement>(
      '[data-device-revoke-success]',
    );
    if (receipt === null) return;
    receipt.focus({ preventScroll: true });
    receipt.scrollIntoView?.({ block: 'nearest' });
  };

  const focusRecoveredRoster = (): void => {
    if (focusAction('revoke-device')) return;
    if (typeof host.querySelector !== 'function') return;
    const heading = host.querySelector<HTMLElement>(
      '#account-devices .rx-section-title',
    );
    if (heading === null) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView?.({ block: 'nearest' });
  };

  const focusIsUnowned = (): boolean => {
    const doc = host.ownerDocument;
    return doc === undefined
      || doc.activeElement === null
      || doc.activeElement === doc.body;
  };

  const render = (): void => {
    if (disposed) return;
    const pageState: DevicesPageState = {
      rows: state.rows,
      ...(state.confirmingInstanceId !== undefined
        ? { confirmingInstanceId: state.confirmingInstanceId }
        : {}),
      ...(state.revokingInstanceId !== undefined
        ? { revokingInstanceId: state.revokingInstanceId }
        : {}),
      ...(state.revokeError !== undefined
        ? { revokeError: state.revokeError }
        : {}),
      ...(options.now !== undefined ? { nowMs: options.now() } : {}),
    };
    const errorBanner = state.listError
      ? `<div class="account-devices-list-error" role="alert" data-error="list">`
        + `<span class="account-devices-list-error-text">${state.listError}</span>`
        + `<button type="button" class="account-devices-action account-devices-retry" data-action="retry-list"`
        + (state.listRetrying
          ? ' aria-disabled="true" aria-busy="true">Retrying…'
          : '>Retry')
        + `</button>`
        + `</div>`
      : '';
    const loadingBanner = state.loading
      ? '<p class="account-devices-loading" role="status">Loading devices…</p>'
      : '';
    const successReceipt = state.revokeSucceeded
      ? '<p class="account-devices-revoke-success" role="status" tabindex="-1" data-device-revoke-success>'
        + 'Device revoked. It no longer has access to this server.'
        + '</p>'
      : '';
    host.innerHTML = errorBanner
      + successReceipt
      + loadingBanner
      + renderDevicesPage(pageState);
  };

  const setState = (patch: Partial<MountState>): void => {
    state = { ...state, ...patch };
    render();
  };

  // ── Roster fetch ─────────────────────────────────────────────
  const refresh = async (fromRetry = false): Promise<void> => {
    if (disposed) return;
    if (fromRetry && state.listRetrying) return;
    setState(fromRetry
      ? { loading: true, listRetrying: true }
      : { loading: true, listError: undefined, listRetrying: false });
    if (fromRetry) focusAction('retry-list');
    let response: { devices: ServerPairedDevice[] };
    try {
      response = await runPairList();
    } catch (err) {
      if (disposed) return;
      const returnToRetry = fromRetry && actionHasFocus('retry-list');
      const wrapped = err instanceof Error ? err : new Error(String(err));
      setState({
        loading: false,
        listError: LIST_ERROR_COPY,
        listRetrying: false,
      });
      if (returnToRetry) focusAction('retry-list');
      if (options.onListError) {
        try {
          options.onListError(wrapped);
        } catch {
          /* host sink failures are isolated — keep the mount alive */
        }
      }
      return;
    }
    if (disposed) return;
    const advanceFromRetry = fromRetry && actionHasFocus('retry-list');
    // R30 — revoked devices drop off the active roster (they linger only
    // in the audit log; re-pairing returns them as a fresh row).
    const rows = response.devices
      .filter((d) => d.revoked_at === null)
      .map((d) => toDevicesPageRow(d, options.currentInstanceId));
    setState({
      rows,
      loading: false,
      listError: undefined,
      listRetrying: false,
    });
    if (advanceFromRetry && focusIsUnowned()) focusRecoveredRoster();
  };

  // R30 defect #1 — self-revoke HARD guard. The renderer already omits the
  // Revoke button on the current row, but that protection is render-only + it
  // evaporates when `currentInstanceId` is undefined. This guards the ACTION
  // site: a revoke targeting our own instance is refused before any rpc, so a
  // stray click (a benign re-render race, a fake DOM in tests) can't
  // self-lockout. (A server-side reject is the defense-in-depth follow-up —
  // the substrate change is a D-156 backend item.)
  const isSelfInstance = (instanceId: string): boolean =>
    options.currentInstanceId !== undefined &&
    instanceId === options.currentInstanceId;

  // ── Revoke pipeline ──────────────────────────────────────────
  const doRevoke = async (instanceId: string): Promise<void> => {
    if (disposed || revokeInFlight) return;
    if (isSelfInstance(instanceId)) return;
    revokeInFlight = true;
    try {
      setState({
        revokingInstanceId: instanceId,
        revokeError: undefined,
        revokeSucceeded: false,
      });
      // render() replaces the initiating button. Keep the command focus owner
      // present and busy while the server decides the revoke.
      focusAction('confirm-revoke', instanceId);
      try {
        await runPairRevoke({ instance_id: instanceId });
      } catch (err) {
        if (disposed) return;
        const returnAction = focusedRevokeAction(instanceId);
        const detail = humanizeRpcError(err);
        setState({
          revokingInstanceId: undefined,
          // Keep `confirmingInstanceId` set so the user can Cancel or
          // retry from the same expanded panel (DD#3).
          revokeError: REVOKE_ERROR_COPY(detail),
        });
        if (returnAction !== undefined) focusAction(returnAction, instanceId);
        return;
      }
      if (disposed) return;
      const advanceFocus = focusedRevokeAction(instanceId) !== undefined;
      // Render the accepted receipt immediately, then let pair.list reconcile
      // the row's authoritative `revoked_at` state. The receipt survives both
      // the loading render and the completed/error roster render.
      setState({
        confirmingInstanceId: undefined,
        revokingInstanceId: undefined,
        revokeError: undefined,
        revokeSucceeded: true,
      });
      const refreshPromise = refresh();
      if (advanceFocus) focusSuccessReceipt();
      await refreshPromise;
      if (disposed) return;
      if (advanceFocus && focusIsUnowned()) focusSuccessReceipt();
    } finally {
      revokeInFlight = false;
    }
  };

  // ── Delegated click listener ─────────────────────────────────
  const onClick = (event: Event): void => {
    const target = event.target as
      | (HTMLElement & {
          closest?: (selector: string) => HTMLElement | null;
        })
      | null;
    if (!target?.closest) return;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.getAttribute('data-action');
    const instanceId = actionEl.getAttribute('data-instance-id') ?? '';
    if (action === 'retry-list') {
      // R30 — the list-error banner offers an inline Retry (was reload-only
      // with stale rows beneath). Keep the Retry control as the focusable
      // single-flight owner while `refresh()` reconciles the roster.
      if (state.listRetrying) return;
      void refresh(true);
      return;
    }
    if (action === 'revoke-device') {
      // R30 defect #1 — never open a confirm for our own instance.
      if (!instanceId || isSelfInstance(instanceId) || revokeInFlight) return;
      // DD#2 — single-row confirm. Opening a new confirm collapses any
      // existing one + clears stale error copy.
      setState({
        confirmingInstanceId: instanceId,
        revokingInstanceId: undefined,
        revokeError: undefined,
        revokeSucceeded: false,
      });
      // The whole table is replaced by render(), so the original Revoke
      // button no longer owns focus. Start the destructive alert dialog on
      // its least-destructive action instead of dropping keyboard users on
      // <body> (and requiring them to rediscover the expanded row).
      focusAction('cancel-revoke', instanceId);
      return;
    }
    if (action === 'cancel-revoke') {
      // The cancel button is disabled mid-rpc, but a defensive guard
      // here keeps the state-machine deterministic if a stray click
      // slips through (e.g. a fake DOM in tests).
      if (state.revokingInstanceId !== undefined) return;
      setState({
        confirmingInstanceId: undefined,
        revokeError: undefined,
      });
      // Cancel removes its own subtree. Return to the exact row control that
      // opened it so repeated device administration remains locally owned.
      focusAction('revoke-device', instanceId);
      return;
    }
    if (action === 'confirm-revoke') {
      // R30 defect #1 — refuse a self-targeted revoke at the handler too.
      if (!instanceId || isSelfInstance(instanceId)) return;
      if (state.revokingInstanceId !== undefined) return;
      void doRevoke(instanceId);
      return;
    }
  };

  host.addEventListener('click', onClick);
  render();
  // Fire-and-forget initial fetch (DD#4).
  void refresh();

  // DD#4 — live roster updates. Subscribe to `pair.list_changed` (pair add /
  // revoke on any paired client) and re-fetch the authoritative roster on it.
  // `refresh()` already null-guards `disposed`, so a late event delivered
  // after teardown but before the unsubscribe lands is a no-op.
  const unsubscribePairList = options.subscribe
    ? options.subscribe('pair.list_changed', () => {
        void refresh();
      })
    : undefined;

  return {
    refresh,
    hasInFlightWork: () => !disposed && revokeInFlight,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (unsubscribePairList) unsubscribePairList();
      host.removeEventListener('click', onClick);
      host.innerHTML = '';
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

/** CSS for the `renderDevicesPage` table + the mount's loading / error
 *  banners + the inline two-stage revoke confirm panel. The shared
 *  `@recued/ui-shared/account` renderer ships no stylesheet of its own
 *  (it was authored to "share a stylesheet"), so the Settings route
 *  bundles this. Token-aligned with the `--wc-*` polish layer: control
 *  radius/height, danger-ink revoke buttons, a sunk confirm panel.
 *  `--wc-*` cascade from the shell host with literal fallbacks for
 *  non-shell (test / standalone) contexts. */
export const DEVICES_PAGE_STYLES = `
.account-devices-table-scroll {
  max-width: 100%;
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.account-devices-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin-top: 4px;
}
.account-devices-th {
  text-align: left;
  font-weight: 600;
  color: var(--fg-muted);
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.account-devices-th:last-child { text-align: right; }
.account-devices-cell {
  padding: 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  color: var(--fg);
}
.account-devices-cell--name { display: flex; flex-direction: column; gap: 2px; }
.account-devices-cell--actions { text-align: right; }
.account-devices-name { font-weight: 600; }
.account-devices-kind { color: var(--fg-muted); font-size: 12px; }
.account-devices-current-badge {
  align-self: flex-start;
  margin-top: 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-weak);
  border-radius: var(--wc-radius-pill, 999px);
  padding: 1px 8px;
}
.account-devices-action-placeholder { color: var(--fg-subtle); }
.account-devices-action {
  appearance: none;
  font: inherit;
  font-size: 13px;
  min-height: var(--wc-control-h, 32px);
  padding: 0 12px;
  border-radius: var(--wc-radius, 6px);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--fg);
  cursor: pointer;
}
.account-devices-action:hover:not(:disabled):not([aria-disabled="true"]) { background: var(--surface-sunk); }
.account-devices-action:disabled,
.account-devices-action[aria-disabled="true"] { opacity: 0.55; cursor: not-allowed; }
.account-devices-action--revoke,
.account-devices-action--confirm-revoke {
  border-color: var(--danger);
  color: var(--danger);
}
.account-devices-action--revoke:hover:not(:disabled):not([aria-disabled="true"]),
.account-devices-action--confirm-revoke:hover:not(:disabled):not([aria-disabled="true"]) {
  background: var(--danger-weak);
}
.account-devices-action:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.account-devices-confirm-cell { padding: 0 10px 10px; }
.account-devices-confirm-panel {
  background: var(--surface-sunk);
  border: 1px solid var(--border);
  border-left: 3px solid var(--danger);
  border-radius: var(--wc-radius, 6px);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.account-devices-confirm-heading { margin: 0; font-weight: 600; }
.account-devices-confirm-list { margin: 0; padding-left: 18px; color: var(--fg-muted); }
.account-devices-confirm-recover { margin: 0; color: var(--fg-muted); font-size: 12px; }
.account-devices-confirm-actions { display: flex; gap: 8px; margin-top: 4px; }
.account-devices-confirm-status { margin: 0; color: var(--fg-muted); }
.account-devices-confirm-error { margin: 0; color: var(--danger); }
.account-devices-revoke-success {
  margin: 0 0 8px;
  color: var(--success, var(--fg));
  font-size: 13px;
}
.account-devices-empty {
  text-align: center;
  color: var(--fg-muted);
  padding: 16px;
}
.account-devices-loading,
.account-devices-list-error {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--fg-muted);
}
.account-devices-list-error {
  color: var(--danger);
  display: flex;
  align-items: center;
  gap: 10px;
}
.account-devices-list-error-text { flex: 1; }
.account-devices-retry { min-height: var(--wc-control-h, 28px); }
`;
