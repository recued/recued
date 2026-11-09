/** D-156 P6 — Bridge Devices page mount.
 *
 *  Bridge-surface mirror of [[apps/webclient/src/settings/devices-page-mount]].
 *  Same `renderDevicesPage` renderer from `@recued/ui-shared/account`,
 *  same two-stage confirm state machine, same `pair.list` /
 *  `pair.revoke` rpc shape, and (since D-156 P10) the same per-device
 *  `kind` carried straight from `ServerPairedDevice.kind` — differing
 *  only in the user-facing copy on the optimistic-row labels.
 *
 *  The mount is rpc-caller-agnostic: tests inject fakes; a production
 *  host wires real callers that round-trip through the SW's WS client
 *  (a page does not hold the WS — the SW does, and the page messages it
 *  via `chrome.runtime.sendMessage`). No production host mounts it yet:
 *  it was written for the toolbar popup, which is gone (2026-10-10), so
 *  the host would be the side panel. For D-156 P6 the mount + tests ship
 *  the surface so the wiring slice is a straight import-and-call.
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — `kind` comes from `device.kind` (D-156 P10 wired the real
 *  per-device surface through the server's durable store +
 *  `ServerPairedDevice`). Both Devices surfaces render the same row
 *  shape; neither defaults a kind anymore (NULL legacy rows already
 *  resolve to `'webclient'` server-side in the paired-instances store).
 *
 *  DD#2 — Two-stage confirm is single-row only. Clicking Revoke on
 *  row B while row A is confirming COLLAPSES A and OPENS B in the
 *  same render pass. Mirrors the webclient mount + the TLS renew /
 *  Clear-this-browser panels from D-148 slices 110/111.
 *
 *  DD#3 — Roster refresh is fire-and-forget on revoke success. The
 *  mount calls `runPairList` after a successful `pair.revoke`, but
 *  the dispatch is async + the mount re-renders synchronously with
 *  the optimistic clear so the user sees the confirm panel collapse
 *  immediately. If the list rpc takes longer than the user expects,
 *  the optimistic view is still correct (the server has already
 *  accepted the revoke; the next list call will reconcile the
 *  `revoked_at` stamp). On rpc failure the mount surfaces an inline
 *  error + keeps the confirm panel expanded.
 *
 *  DD#4 — Auto-refresh on mount. The mount fires `runPairList` once
 *  on construction so a cold load renders the current roster without
 *  the user clicking anything. A failure surfaces inline as "Couldn't
 *  load devices", with a Retry (R30).
 *
 *  DD#5 — `dispose()` removes the host's children + detaches the
 *  delegated click listener. The renderer's HTML is owned wholesale
 *  by the mount's host element; clearing innerHTML is a clean wipe.
 *
 *  Spec: D-156
 *  § Settings → Devices page shape + § Browser bridge — touch lightly.
 */

import type { ServerPairedDevice } from '@recued/contracts';
// Codex 2026-05-18 P6 R1 critical fold — import the devices-page
// renderer through its dedicated subpath, NOT the `@recued/ui-shared/
// account` barrel. The barrel re-exports `recovery-check-crypto.ts`,
// which imports `@recued/storage` — a forbidden package under the
// D-148 bridge role-boundary (invariant I-8). Even though the
// role-boundary test scans source text only, a transitive pull on
// `@recued/storage` would bloat the bridge bundle with KDF + AEAD
// code paths the bridge never executes + leaks engine-tier substrate
// into the thin-actuator surface. The `./account/devices-page`
// subpath added in `packages/ui-shared/package.json` exposes just
// the renderer + types with no storage dependency.
import {
  renderDevicesPage,
  type DevicesPageRow,
  type DevicesPageState,
} from '@recued/ui-shared/account/devices-page';

// ════════════════════════════════════════════════════════════════
// Rpc callers
// ════════════════════════════════════════════════════════════════

/** Returns the current paired-device roster. Production wires a
 *  caller that messages the SW (which holds the WS to the server).
 *  Tests inject a fake. */
export type BridgePairListCaller = () => Promise<{ devices: ServerPairedDevice[] }>;

/** Revokes one device. Production wires a caller that messages the
 *  SW (which holds the WS to the server). Tests inject a fake.
 *  Rejection surfaces inline in the confirm panel. */
export type BridgePairRevokeCaller = (args: {
  instance_id: string;
}) => Promise<{ ok: true }>;

// ════════════════════════════════════════════════════════════════
// Mount options + handle
// ════════════════════════════════════════════════════════════════

export interface MountBridgeDevicesPageOptions {
  /** Element the renderer mounts into. Owned wholesale — innerHTML
   *  is overwritten on every state transition. */
  host: HTMLElement;
  /** `pair.list` rpc caller. Fires once on mount + after every
   *  successful revoke. */
  runPairList: BridgePairListCaller;
  /** `pair.revoke` rpc caller. Fires on the user's "Yes, revoke"
   *  click after the inline confirm. */
  runPairRevoke: BridgePairRevokeCaller;
  /** Optional — the locally-known instance id for this bridge. When
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
}

export interface BridgeDevicesPageMount {
  /** Re-fetch the roster + re-render. Idempotent. */
  refresh(): Promise<void>;
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
  listError?: string;
  loading: boolean;
}

const LIST_ERROR_COPY =
  "Couldn't load paired devices — check your server's connection, then retry.";

const REVOKE_ERROR_COPY = (detail: string): string =>
  `Could not revoke this device${detail ? `: ${detail}` : ''}. Try again, or revoke from a different paired device.`;

const toDevicesPageRow = (
  device: ServerPairedDevice,
  currentInstanceId: string | undefined,
): DevicesPageRow => ({
  instance_id: device.instance_id,
  display_name: device.display_name,
  // D-156 P10 — the real per-device kind from the durable store
  // (`ServerPairedDevice.kind`; NULL legacy rows resolve to 'webclient'
  // server-side). The bridge renders the full roster (webclient + bridge
  // + cli rows), so it shows each row's actual surface.
  kind: device.kind,
  connected: device.connected,
  // R30 — pairing date (`added_at`, unix seconds → ms), shown in its own
  // "Paired" column. No longer overloaded as "last seen" (that mislabeled
  // the pairing time for offline rows — defect #2). Mirrors the webclient
  // mount; revoked rows are filtered out before this map runs.
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
export const mountBridgeDevicesPage = (
  options: MountBridgeDevicesPageOptions,
): BridgeDevicesPageMount => {
  const { host, runPairList, runPairRevoke } = options;

  let state: MountState = {
    rows: [],
    loading: true,
  };
  let disposed = false;

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
        + `<button type="button" class="account-devices-action account-devices-retry" data-action="retry-list">Retry</button>`
        + `</div>`
      : '';
    const loadingBanner = state.loading
      ? '<p class="account-devices-loading" role="status">Loading devices…</p>'
      : '';
    host.innerHTML = errorBanner + loadingBanner + renderDevicesPage(pageState);
  };

  const setState = (patch: Partial<MountState>): void => {
    state = { ...state, ...patch };
    render();
  };

  // ── Roster fetch ─────────────────────────────────────────────
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    setState({ loading: true, listError: undefined });
    let response: { devices: ServerPairedDevice[] };
    try {
      response = await runPairList();
    } catch (err) {
      if (disposed) return;
      const wrapped = err instanceof Error ? err : new Error(String(err));
      setState({ loading: false, listError: LIST_ERROR_COPY });
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
    // R30 — revoked devices drop off the active roster (they linger only
    // in the audit log; re-pairing returns them as a fresh row).
    const rows = response.devices
      .filter((d) => d.revoked_at === null)
      .map((d) => toDevicesPageRow(d, options.currentInstanceId));
    setState({ rows, loading: false });
  };

  // R30 defect #1 — self-revoke HARD guard (mirrors the webclient mount).
  // The renderer omits the Revoke button on the current row, but that is
  // render-only + evaporates when `currentInstanceId` is undefined. This
  // guards the ACTION site so a stray click can't self-lockout the bridge.
  const isSelfInstance = (instanceId: string): boolean =>
    options.currentInstanceId !== undefined &&
    instanceId === options.currentInstanceId;

  // ── Revoke pipeline ──────────────────────────────────────────
  const doRevoke = async (instanceId: string): Promise<void> => {
    if (disposed) return;
    if (isSelfInstance(instanceId)) return;
    setState({
      revokingInstanceId: instanceId,
      revokeError: undefined,
    });
    try {
      await runPairRevoke({ instance_id: instanceId });
    } catch (err) {
      if (disposed) return;
      const detail = err instanceof Error ? err.message : String(err);
      setState({
        revokingInstanceId: undefined,
        // Keep `confirmingInstanceId` set so the user can Cancel or
        // retry from the same expanded panel (DD#3).
        revokeError: REVOKE_ERROR_COPY(detail),
      });
      return;
    }
    if (disposed) return;
    setState({
      confirmingInstanceId: undefined,
      revokingInstanceId: undefined,
      revokeError: undefined,
    });
    void refresh();
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
      // R30 — the list-error banner offers an inline Retry (was
      // re-mount-only). `refresh()` re-fetches + clears the error.
      void refresh();
      return;
    }
    if (action === 'revoke-device') {
      // R30 defect #1 — never open a confirm for our own instance.
      if (!instanceId || isSelfInstance(instanceId)) return;
      // DD#2 — single-row confirm.
      setState({
        confirmingInstanceId: instanceId,
        revokingInstanceId: undefined,
        revokeError: undefined,
      });
      return;
    }
    if (action === 'cancel-revoke') {
      if (state.revokingInstanceId !== undefined) return;
      setState({
        confirmingInstanceId: undefined,
        revokeError: undefined,
      });
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

  return {
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      host.removeEventListener('click', onClick);
      host.innerHTML = '';
    },
  };
};
