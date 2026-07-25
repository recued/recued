/** R26.2 Delta 1 — Settings → Server → Exposure grid mount.
 *
 *  The "MCP server has no UI" + "where is the reception on/off?" surface.
 *  Mounts the preset radios + the per-path `lan × public` grid + the
 *  public-MCP acknowledgement card, driving the three `exposure.*`
 *  mutators behind the two confirm-phrase gates:
 *    - `/mcp.public` → the public-MCP acknowledgement modal
 *      (`public-mcp-modal.ts`).
 *    - `/ws` going fully off → the `/ws` lockout modal
 *      (`ws-lockout-modal.ts`).
 *
 *  The page-model + dispatch builders + both modal state machines all
 *  shipped earlier (W3.8) as pure modules; this is the DOM host that
 *  binds them — the missing render layer the design called a "contained
 *  surface build". Mirrors `mountTlsRenewPanel` / `mountDevicesPage`:
 *  createElement render-on-transition, rpc callers as injected seams, a
 *  handle with `getState()` / `refresh()` / `dispose()` + test drivers.
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Initial state comes from `exposure.get` (R26.2 Delta 1's read
 *  rpc), not a broadcast. The `exposure_changed` broadcast only fires on
 *  a transition (boot `reapply()` is audit-only), so a freshly-loaded
 *  panel would have nothing to render without the read. `refresh()`
 *  fires `runGet` on mount + on the load-error retry; the broadcast then
 *  applies live edits on top (DD#5).
 *
 *  DD#2 — `has_ddns` is sourced out-of-band via an optional `runHasDdns`
 *  seam (the bootstrap derives it from `collection.hostname.list` —
 *  any row with `ddns_managed`). It is NOT on `ExposureState`. When the
 *  seam is absent the panel defaults to `false`: public presets render
 *  disabled with a "configure DDNS first" hint — the safe default (a
 *  public bind with no public address resolves nowhere).
 *
 *  DD#3 — The webclient is itself a `/ws` client, so the `/ws` lockout
 *  active-client count is always ≥ 1 from its vantage. There is no
 *  first-class live-count source on the client (no presence rpc), so the
 *  modal opens with `active_ws_connections: 1` + `caller_channel:
 *  'webclient_over_ws'` → the `disconnect webclients` phrase + the
 *  "sawing the branch you sit on" flavor. The server is authoritative on
 *  submit; a count mismatch surfaces as the lockout error code + the
 *  user re-confirms.
 *
 *  DD#4 — Enabling `/mcp.public` is a two-rpc chain behind ONE gesture.
 *  Flipping `/mcp.public` on requires a well-formed acknowledgement
 *  first (the server rejects the bare path-set with
 *  `public_mcp_not_acknowledged`). So a click on the `/mcp` public cell
 *  while unacknowledged opens the ack modal with `pendingPathAfterAck`
 *  set; on ack success the panel chains the `set_path_resolution` that
 *  actually flips the bit. Acknowledging from the standalone card sets
 *  no pending path (it only records the ack).
 *
 *  DD#5 — Live refresh via the `exposure_changed` broadcast. The event
 *  carries the FULL `public_mcp_acknowledgement` object (unlike the
 *  reduced `state.snapshot` shape), so the panel rebuilds its state from
 *  it directly — remapping the event's `changed_at` to the state's
 *  `last_changed_at`. The subscription is torn down in `dispose()`.
 *
 *  DD#6 — Modal rpc errors keep the modal open in its error state ONLY
 *  when the rejection code is a `NetworkErrorCode` (the substrate gate
 *  failures — e.g. a phrase mismatch). A transport/unknown error closes
 *  the modal + surfaces the humanized message in the inline action
 *  banner — a dropped socket isn't a phrase problem.
 *
 *  Spec: docs/d-148-spec.md § A.7 + the R26.2 design
 *  (`handover_webclient_ia_implementation.md` § Exposure & Serving). */

import {
  ROOT_APEX_MODES,
  type ExposurePreset,
  type ExposureState,
  type NetworkErrorCode,
  type PathResolution,
  type PathRole,
  type RootApexMode,
} from '@recued/contracts';

import {
  EXPOSURE_ERROR_COPY,
  buildExposurePageModel,
  buildPathResolutionDispatch,
  buildPresetDispatch,
  projectCellToggle,
  projectPathWsLockout,
  projectRequiresPublicMcpAck,
  type ExposureDispatch,
  type ExposurePageModel,
} from './exposure-surface.js';
import {
  PUBLIC_MCP_MODAL_COPY,
  closePublicMcpModal,
  failPublicMcpModal,
  isPublicMcpAcknowledgementActive,
  openPublicMcpModal,
  submitPublicMcpModal,
  typePublicMcpPhrase,
  type PublicMcpModalState,
} from './public-mcp-modal.js';
import {
  WS_LOCKOUT_MODAL_COPY,
  closeWsLockoutModal,
  failWsLockoutModal,
  openWsLockoutModal,
  submitWsLockoutModal,
  typeWsLockoutPhrase,
  type WsLockoutModalState,
} from './ws-lockout-modal.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';

// ════════════════════════════════════════════════════════════════
// Element ids — stable for DOM tests + host introspection
// ════════════════════════════════════════════════════════════════

export const EXPOSURE_PANEL_ATTR = 'data-recued-exposure-panel';
export const EXPOSURE_PRESET_ROW_ATTR = 'data-recued-exposure-preset';
export const EXPOSURE_PATH_ROW_ATTR = 'data-recued-exposure-path';
export const EXPOSURE_CELL_ATTR = 'data-recued-exposure-cell';
export const EXPOSURE_PUBLIC_MCP_BTN_ATTR = 'data-recued-exposure-public-mcp';
export const EXPOSURE_PRESET_LABEL_ATTR = 'data-recued-exposure-preset-label';
export const EXPOSURE_ACTION_ERROR_ATTR = 'data-recued-exposure-action-error';
export const EXPOSURE_APEX_ROW_ATTR = 'data-recued-exposure-apex';
export const EXPOSURE_APEX_WARNING_ATTR = 'data-recued-exposure-apex-warning';
export const EXPOSURE_LOAD_ERROR_ATTR = 'data-recued-exposure-load-error';
export const EXPOSURE_RETRY_BTN_ATTR = 'data-recued-exposure-retry';
export const EXPOSURE_MODAL_ATTR = 'data-recued-exposure-modal';
export const EXPOSURE_MODAL_PHRASE_ATTR = 'data-recued-exposure-modal-phrase';
export const EXPOSURE_MODAL_SUBMIT_ATTR = 'data-recued-exposure-modal-submit';
export const EXPOSURE_MODAL_CANCEL_ATTR = 'data-recued-exposure-modal-cancel';

// ════════════════════════════════════════════════════════════════
// Rpc caller seams
// ════════════════════════════════════════════════════════════════

/** Read the current `ExposureState` + the apex (`GET /`) mode. Production
 *  wires `() => conn('exposure.get', undefined)`; tests inject a fake. */
export type ExposureGetCaller = () => Promise<{
  state: ExposureState;
  apex_mode: RootApexMode;
}>;

/** R26.2 Delta 2 — set the apex (`GET /`) serving mode. Production wires
 *  `(req) => conn('exposure.set_apex', req)`; tests inject a fake. The
 *  server cross-validates against the live resolution (rejects
 *  `serve_reception` unless `/reception` is public, `serve_webclient` until
 *  the bundle ships). */
export type ExposureSetApexCaller = (req: {
  apex_mode: RootApexMode;
}) => Promise<{ apex_mode: RootApexMode }>;

/** The two mutators that can drain `/ws` clients echo the drain count;
 *  the public-MCP ack mutator always returns 0. One shape for all. */
export interface ExposureMutationResponse {
  state: ExposureState;
  clients_disconnected: number;
}

export type ExposureApplyPresetCaller = (req: {
  preset: ExposurePreset;
  lockout_confirmation_phrase?: string;
  reason?: string;
}) => Promise<ExposureMutationResponse>;

export type ExposureSetPathResolutionCaller = (req: {
  path: PathRole;
  resolution: PathResolution;
  lockout_confirmation_phrase?: string;
  reason?: string;
}) => Promise<ExposureMutationResponse>;

export type ExposureSetPublicMcpAckCaller = (req: {
  acknowledge: boolean;
  free_text_confirmation?: string;
  reason?: string;
}) => Promise<ExposureMutationResponse>;

/** Resolves whether DDNS is configured (any hostname row with
 *  `ddns_managed`). Optional — absent ⇒ `has_ddns: false` (DD#2). */
export type ExposureHasDdnsCaller = () => Promise<boolean>;

// ════════════════════════════════════════════════════════════════
// Options + handle
// ════════════════════════════════════════════════════════════════

export interface MountExposurePanelOptions {
  host: HTMLElement;
  document?: Document;
  /** Cold-load read (DD#1). Fired on mount + load-error retry. */
  runGet: ExposureGetCaller;
  runApplyPreset: ExposureApplyPresetCaller;
  runSetPathResolution: ExposureSetPathResolutionCaller;
  runSetPublicMcpAck: ExposureSetPublicMcpAckCaller;
  /** R26.2 Delta 2 — apex (`GET /`) mode setter. Optional: absent ⇒ the
   *  apex picker renders read-only (shows the current mode, no radios
   *  interactive). */
  runSetApex?: ExposureSetApexCaller;
  /** DDNS-configured probe (DD#2). Fired alongside `runGet`. */
  runHasDdns?: ExposureHasDdnsCaller;
  /** Live-refresh seam (DD#5). Production wires the bootstrap's
   *  `subscriber.on`; absent ⇒ mount-fetch + post-mutation only. */
  subscribe?: BroadcastSubscriber['on'];
}

/** A flat snapshot of the mount's internal state — the primary surface
 *  for tests + host introspection. */
export interface ExposurePanelStateView {
  state: ExposureState | null;
  hasDdns: boolean;
  /** R26.2 Delta 2 — current apex (`GET /`) mode. Null until `runGet`. */
  apexMode: RootApexMode | null;
  busy: boolean;
  loadError: string | null;
  actionError: string | null;
  publicMcpModal: PublicMcpModalState;
  wsLockoutModal: WsLockoutModalState;
  /** Null until the first `runGet` resolves. */
  model: ExposurePageModel | null;
}

export interface ExposurePanelMount {
  getState(): ExposurePanelStateView;
  refresh(): Promise<void>;
  dispose(): void;
  // ── Test drivers ──────────────────────────────────────────────
  clickPreset(preset: ExposurePreset): void;
  clickCell(path: PathRole, cell: 'lan' | 'public'): void;
  clickManagePublicMcp(): void;
  setModalPhrase(phrase: string): void;
  submitModal(): Promise<void>;
  cancelModal(): void;
  /** R26.2 Delta 2 — pick an apex (`GET /`) mode. */
  clickApex(mode: RootApexMode): void;
  /** Await the most recent in-flight rpc round-trip (preset / cell /
   *  modal submit / apex). Resolves immediately when nothing is pending. */
  settle(): Promise<void>;
}

// The webclient is itself a `/ws` client, so ≥ 1 (DD#3).
const ASSUMED_ACTIVE_WS = 1;

/** R26.2 Delta 2 — apex picker copy. */
const APEX_COPY: Record<
  RootApexMode,
  { label: string; subtitle: string }
> = {
  redirect: {
    label: 'Redirect to app.recued.com',
    subtitle: 'Default — safe for public, always the newest webclient.',
  },
  serve_reception: {
    label: 'Serve Reception',
    subtitle: 'Anonymous visitor intake at the root. Needs /reception public.',
  },
  serve_webclient: {
    label: 'Serve the webclient',
    subtitle: "This server's own embedded webclient at the root. Needs /webclient public.",
  },
  not_found: {
    label: 'Closed (404)',
    subtitle: 'Return a generic 404 at the root.',
  },
};

const PANEL_COPY = {
  heading: 'Exposure & serving',
  intro:
    'Choose who reaches this server. Presets snap the whole grid; the per-path grid below is the fine control — the /mcp row enables AI-agent ingress, the /reception row opens anonymous visitor intake.',
  loading: 'Loading exposure state…',
  load_error:
    "Couldn't load the exposure state. Check your server's connection and retry.",
  preset_legend: 'Preset',
  grid_legend: 'Per-path access',
  grid_col_path: 'Path',
  grid_col_lan: 'LAN',
  grid_col_public: 'Public',
  custom_badge: 'Custom',
  ddns_hint: 'Configure DDNS first (Settings → Server → Hostnames).',
  public_mcp_on: 'Public MCP is acknowledged — AI agents can reach /mcp from outside the LAN once the /mcp public bit is on.',
  public_mcp_off: 'Public MCP is not acknowledged. Enabling /mcp public requires typing the confirmation phrase.',
  public_mcp_enable: 'Enable public MCP…',
  public_mcp_revoke: 'Revoke public MCP',
  any_public_note:
    'At least one path is public — your server is reachable from the Internet. Review the Reachability Doctor.',
  apex_legend: 'Root URL ( / )',
  apex_help:
    'What a visitor sees at the bare root of your public address. Takes effect immediately.',
  apex_reception_hint: 'Enable the /reception public bit in the grid above first.',
  apex_webclient_hint:
    'Enable the /webclient public bit in the grid above first (and deploy a webclient bundle).',
  apex_reception_warning:
    'Reception is set to serve at the root but /reception is not public — the root returns 404 until you enable it above.',
  apex_webclient_warning:
    'The webclient is set to serve at the root but /webclient is not public — the root returns 404 until you enable it above.',
} as const;

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountExposurePanel = (
  opts: MountExposurePanelOptions,
): ExposurePanelMount => {
  const docMaybe =
    opts.document ?? (globalThis as { document?: Document }).document;
  if (docMaybe === undefined) {
    throw new Error(
      'mountExposurePanel: no document available — pass `opts.document` for non-browser environments',
    );
  }
  // Explicit non-optional binding: the render helpers below are hoisted
  // `function` declarations, and TS won't carry the `=== undefined` throw's
  // narrowing into a hoisted function's body (it could, in theory, run
  // before the guard). Pinning the type here keeps every `doc.*` site clean.
  const doc: Document = docMaybe;

  // ── State ────────────────────────────────────────────────────────
  let state: ExposureState | null = null;
  let hasDdns = false;
  // R26.2 Delta 2 — last-known apex (`GET /`) mode. Set on each `runGet` +
  // after a successful `runSetApex`. Not broadcast (apex changes are rare +
  // owner-only); a grid `exposure_changed` re-derives only the consistency
  // gate, not the apex value.
  let apexMode: RootApexMode | null = null;
  let busy = false;
  let loadError: string | null = null;
  let actionError: string | null = null;
  let publicMcpModal: PublicMcpModalState = { kind: 'idle' };
  let wsLockoutModal: WsLockoutModalState = { kind: 'idle' };
  // DD#4 — set when the ack modal was opened in order to then enable a
  // specific path (the `/mcp` public bit). Cleared on resolve.
  let pendingPathAfterAck: { path: PathRole; resolution: PathResolution } | null =
    null;
  let disposed = false;
  // Test seam — surfaces the in-flight rpc promise (direct action OR modal
  // submit) so a driver can await the round-trip (the click handler itself
  // is sync).
  let pendingWork: Promise<void> | null = null;

  const wrapper = doc.createElement('div');
  wrapper.setAttribute(EXPOSURE_PANEL_ATTR, '');
  wrapper.className = 'exposure-panel';
  opts.host.appendChild(wrapper);

  // ── Model derivation ─────────────────────────────────────────────
  const currentModel = (): ExposurePageModel | null =>
    state === null ? null : buildExposurePageModel({ state, has_ddns: hasDdns });

  // ── Error mapping ────────────────────────────────────────────────
  // EXPOSURE_ERROR_COPY is keyed by every NetworkErrorCode, so a hit on
  // the err.code means it's a substrate gate failure (a NetworkErrorCode);
  // a miss means transport/unknown. Structural `err.code` read (not
  // `instanceof RpcError`) mirrors the archive / key-health panels — it
  // survives a cross-package class-identity mismatch.
  const networkErrorCodeOf = (err: unknown): NetworkErrorCode | null => {
    const code = (err as { code?: unknown } | null)?.code;
    if (
      typeof code === 'string' &&
      Object.prototype.hasOwnProperty.call(EXPOSURE_ERROR_COPY, code)
    ) {
      return code as NetworkErrorCode;
    }
    return null;
  };

  const errorCopyOf = (err: unknown): string => {
    const code = networkErrorCodeOf(err);
    return code !== null ? EXPOSURE_ERROR_COPY[code] : humanizeRpcError(err);
  };

  // ── Render driver ────────────────────────────────────────────────
  const render = (): void => {
    if (disposed) return;
    clearChildren(wrapper);
    const model = currentModel();

    if (loadError !== null) {
      renderLoadError();
      return;
    }
    if (model === null) {
      const loading = doc.createElement('p');
      loading.className = 'exposure-loading';
      loading.setAttribute('role', 'status');
      loading.textContent = PANEL_COPY.loading;
      wrapper.appendChild(loading);
      return;
    }

    renderHeader(model);
    if (actionError !== null) renderActionError();
    renderPresets(model);
    renderGrid(model);
    renderPublicMcpCard(model);
    renderApexPicker(model);
    // Modals render last so they overlay (CSS positions them fixed).
    if (publicMcpModal.kind !== 'idle') renderPublicMcpModal();
    if (wsLockoutModal.kind !== 'idle') renderWsLockoutModal();
  };

  const setBusy = (next: boolean): void => {
    busy = next;
    render();
  };

  // ── Initial / live state application ─────────────────────────────
  // Monotonic guard (Codex R26.2 fold) — never let an OLDER state clobber a
  // newer one. The cold-load read (`exposure.get`), every `exposure_changed`
  // broadcast, and every mutation response all carry `last_changed_at` from
  // the same server clock. Without this, a broadcast that lands mid-`refresh`
  // (after `runGet` resolved its now-stale snapshot but before the render)
  // would be overwritten by the older read. A mutation response is always the
  // newest server transition at return time, so the `>=` admits it; a genuinely
  // newer concurrent broadcast correctly supersedes an in-flight older response.
  const applyNewState = (next: ExposureState): void => {
    if (disposed) return;
    if (state !== null && next.last_changed_at < state.last_changed_at) return;
    state = next;
    render();
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    loadError = null;
    // Fire both reads concurrently; the grid only needs `state`, the
    // DDNS gate is advisory copy so a failed DDNS probe degrades to
    // `has_ddns: false` rather than blocking the whole panel.
    const ddnsPromise = opts.runHasDdns
      ? opts.runHasDdns().catch(() => false)
      : Promise.resolve(false);
    let got: { state: ExposureState; apex_mode: RootApexMode };
    try {
      got = await opts.runGet();
    } catch (err) {
      if (disposed) return;
      loadError = PANEL_COPY.load_error;
      // Surface the humanized detail in console-less envs via the banner
      // copy; the static copy already covers the user-facing message.
      void err;
      render();
      return;
    }
    if (disposed) return;
    hasDdns = await ddnsPromise;
    if (disposed) return;
    apexMode = got.apex_mode;
    // `applyNewState` runs the monotonic guard so a broadcast that landed
    // during the read window isn't clobbered; render unconditionally
    // afterwards so the freshly-resolved `hasDdns` + the cleared loading /
    // load-error state always paint, even when the read was a stale no-op.
    applyNewState(got.state);
    render();
  };

  // ── Dispatch firing (non-modal direct actions) ───────────────────
  const fireDirect = async (dispatch: ExposureDispatch): Promise<void> => {
    if (disposed || busy) return;
    actionError = null;
    setBusy(true);
    try {
      const resp = await fireDispatch(dispatch);
      if (disposed) return;
      applyNewState(resp.state);
    } catch (err) {
      if (disposed) return;
      actionError = errorCopyOf(err);
    } finally {
      if (!disposed) setBusy(false);
    }
  };

  /** Route a dispatch to the matching rpc caller. Shared by direct
   *  actions + both modal submit paths. */
  const fireDispatch = (
    dispatch: ExposureDispatch,
  ): Promise<ExposureMutationResponse> => {
    if (dispatch.op === 'exposure.apply_preset') {
      return opts.runApplyPreset({
        preset: dispatch.preset,
        ...(dispatch.lockout_confirmation_phrase !== undefined
          ? { lockout_confirmation_phrase: dispatch.lockout_confirmation_phrase }
          : {}),
        ...(dispatch.reason !== undefined ? { reason: dispatch.reason } : {}),
      });
    }
    if (dispatch.op === 'exposure.set_path_resolution') {
      return opts.runSetPathResolution({
        path: dispatch.path,
        resolution: dispatch.resolution,
        ...(dispatch.lockout_confirmation_phrase !== undefined
          ? { lockout_confirmation_phrase: dispatch.lockout_confirmation_phrase }
          : {}),
        ...(dispatch.reason !== undefined ? { reason: dispatch.reason } : {}),
      });
    }
    return opts.runSetPublicMcpAck({
      acknowledge: dispatch.acknowledge,
      ...(dispatch.free_text_confirmation !== undefined
        ? { free_text_confirmation: dispatch.free_text_confirmation }
        : {}),
      ...(dispatch.reason !== undefined ? { reason: dispatch.reason } : {}),
    });
  };

  // ── Preset interaction ───────────────────────────────────────────
  const onPresetClick = (preset: ExposurePreset): void => {
    if (busy) return;
    const model = currentModel();
    if (model === null) return;
    const row = model.preset_rows.find((r) => r.preset === preset);
    if (row === undefined || row.is_current || row.requires_ddns) return;
    if (row.triggers_ws_lockout) {
      wsLockoutModal = openWsLockoutModal({
        trigger: { kind: 'preset', preset },
        caller_channel: 'webclient_over_ws',
        active_ws_connections: ASSUMED_ACTIVE_WS,
      });
      actionError = null;
      render();
      return;
    }
    pendingWork = fireDirect(buildPresetDispatch({ preset }));
  };

  // ── Cell interaction ─────────────────────────────────────────────
  const onCellClick = (path: PathRole, cell: 'lan' | 'public'): void => {
    if (busy || state === null) return;
    const current = state.resolution;
    const nextResolution = projectCellToggle({
      current_resolution: current,
      path,
      cell,
    });
    const nextForPath = nextResolution[path];

    // DD#4 — enabling /mcp.public requires the ack gate first.
    const needsAck = projectRequiresPublicMcpAck({
      path,
      next_resolution: nextForPath,
      current_resolution: current,
      acknowledgement: state.public_mcp_acknowledgement,
    });
    if (needsAck) {
      pendingPathAfterAck = { path, resolution: nextForPath };
      publicMcpModal = openPublicMcpModal('acknowledge');
      actionError = null;
      render();
      return;
    }

    // /ws going fully off → the lockout gate.
    const lockout = projectPathWsLockout({
      path,
      next_resolution: nextForPath,
      current_resolution: current,
      active_ws_connections: ASSUMED_ACTIVE_WS,
    });
    if (lockout !== null) {
      wsLockoutModal = openWsLockoutModal({
        trigger: { kind: 'path', resolution: nextForPath },
        caller_channel: 'webclient_over_ws',
        active_ws_connections: ASSUMED_ACTIVE_WS,
      });
      actionError = null;
      render();
      return;
    }

    pendingWork = fireDirect(
      buildPathResolutionDispatch({ path, resolution: nextForPath }),
    );
  };

  // ── Public-MCP card button ───────────────────────────────────────
  const onManagePublicMcpClick = (): void => {
    if (busy || state === null) return;
    const active = isPublicMcpAcknowledgementActive(
      state.public_mcp_acknowledgement,
    );
    pendingPathAfterAck = null; // standalone card — record the ack only.
    publicMcpModal = openPublicMcpModal(active ? 'revoke' : 'acknowledge');
    actionError = null;
    render();
  };

  // ── Apex (`GET /`) picker (R26.2 Delta 2) ────────────────────────
  const onApexSelect = (mode: RootApexMode): void => {
    if (busy || mode === apexMode) return;
    const setApex = opts.runSetApex;
    if (!setApex) return;
    actionError = null;
    setBusy(true);
    pendingWork = (async () => {
      try {
        const resp = await setApex({ apex_mode: mode });
        if (disposed) return;
        apexMode = resp.apex_mode;
      } catch (err) {
        if (disposed) return;
        // The server rejects an inconsistent pick (e.g.
        // apex_reception_not_public) — surface its remediation copy inline +
        // re-render so the radio snaps back to the persisted mode.
        actionError = errorCopyOf(err);
      } finally {
        if (!disposed) setBusy(false);
      }
    })();
  };

  // ── Public-MCP modal submit ──────────────────────────────────────
  const submitPublicMcp = async (): Promise<void> => {
    const outcome = submitPublicMcpModal(publicMcpModal);
    if (!outcome.ok) {
      // Local guard (phrase missing / mismatch) — the submit button is
      // disabled in that state, so this is defensive; re-render to keep
      // the modal honest.
      render();
      return;
    }
    publicMcpModal = outcome.next;
    render();
    try {
      const resp = await fireDispatch(outcome.dispatch);
      if (disposed) return;
      // DD#4 — chain the path-set that actually flips /mcp.public on.
      // Codex R26.2 fold — keep `pendingPathAfterAck` set until the CHAINED
      // path-set succeeds. If the ack lands but the path-set rejects with a
      // substrate code, the modal re-opens in its error state and a retry must
      // re-run the enable (re-acking is idempotent server-side) — clearing the
      // pending path here would degrade the retry to "ack only", silently
      // breaking the modal's "acknowledge + enable" promise.
      const pending = pendingPathAfterAck;
      if (pending !== null) {
        const chained = await opts.runSetPathResolution({
          path: pending.path,
          resolution: pending.resolution,
        });
        if (disposed) return;
        pendingPathAfterAck = null;
        applyNewState(chained.state);
      } else {
        applyNewState(resp.state);
      }
      publicMcpModal = closePublicMcpModal();
      render();
    } catch (err) {
      if (disposed) return;
      const code = networkErrorCodeOf(err);
      if (code !== null) {
        // Substrate gate failure (ack OR chained path-set) — keep the modal
        // open + `pendingPathAfterAck` intact so the retry re-attempts the
        // full enable.
        publicMcpModal = failPublicMcpModal(publicMcpModal, code);
      } else {
        // DD#6 — transport error: abandon the chain, close the modal, surface
        // inline. A blind retry of a non-idempotent write isn't safe here.
        pendingPathAfterAck = null;
        publicMcpModal = closePublicMcpModal();
        actionError = errorCopyOf(err);
      }
      render();
    }
  };

  // ── /ws lockout modal submit ─────────────────────────────────────
  const submitWsLockout = async (): Promise<void> => {
    const outcome = submitWsLockoutModal(wsLockoutModal);
    if (!outcome.ok) {
      render();
      return;
    }
    wsLockoutModal = outcome.next;
    render();
    try {
      const resp = await fireDispatch(outcome.dispatch);
      if (disposed) return;
      applyNewState(resp.state);
      wsLockoutModal = closeWsLockoutModal();
      render();
    } catch (err) {
      if (disposed) return;
      const code = networkErrorCodeOf(err);
      if (code !== null) {
        wsLockoutModal = failWsLockoutModal(wsLockoutModal, code);
      } else {
        wsLockoutModal = closeWsLockoutModal();
        actionError = errorCopyOf(err);
      }
      render();
    }
  };

  const cancelModal = (): void => {
    if (publicMcpModal.kind !== 'idle') {
      publicMcpModal = closePublicMcpModal();
      pendingPathAfterAck = null;
    }
    if (wsLockoutModal.kind !== 'idle') {
      wsLockoutModal = closeWsLockoutModal();
    }
    render();
  };

  const setModalPhrase = (phrase: string): void => {
    if (publicMcpModal.kind !== 'idle') {
      publicMcpModal = typePublicMcpPhrase(publicMcpModal, phrase);
    } else if (wsLockoutModal.kind !== 'idle') {
      wsLockoutModal = typeWsLockoutPhrase(wsLockoutModal, phrase);
    }
    render();
  };

  // ════════════════════════════════════════════════════════════════
  // Render helpers
  // ════════════════════════════════════════════════════════════════

  function renderLoadError(): void {
    const box = doc.createElement('div');
    box.className = 'exposure-load-error';
    box.setAttribute(EXPOSURE_LOAD_ERROR_ATTR, '');
    box.setAttribute('role', 'alert');
    const msg = doc.createElement('p');
    msg.className = 'exposure-load-error-msg';
    msg.textContent = loadError ?? PANEL_COPY.load_error;
    box.appendChild(msg);
    const retry = makeButton('Retry', EXPOSURE_RETRY_BTN_ATTR, 'secondary', () => {
      void refresh();
    });
    box.appendChild(retry);
    wrapper.appendChild(box);
  }

  function renderHeader(model: ExposurePageModel): void {
    const heading = doc.createElement('h3');
    heading.className = 'exposure-title';
    heading.textContent = PANEL_COPY.heading;
    wrapper.appendChild(heading);

    const intro = doc.createElement('p');
    intro.className = 'exposure-help';
    intro.textContent = PANEL_COPY.intro;
    wrapper.appendChild(intro);

    if (model.any_public) {
      const note = doc.createElement('p');
      note.className = 'exposure-public-note';
      note.setAttribute('role', 'note');
      note.textContent = PANEL_COPY.any_public_note;
      wrapper.appendChild(note);
    }
  }

  function renderActionError(): void {
    const box = doc.createElement('p');
    box.className = 'exposure-action-error';
    box.setAttribute(EXPOSURE_ACTION_ERROR_ATTR, '');
    box.setAttribute('role', 'alert');
    box.textContent = actionError ?? '';
    wrapper.appendChild(box);
  }

  function renderPresets(model: ExposurePageModel): void {
    const fieldset = doc.createElement('fieldset');
    fieldset.className = 'exposure-presets';
    const legend = doc.createElement('legend');
    legend.className = 'exposure-legend';
    const legendText = doc.createElement('span');
    legendText.textContent = PANEL_COPY.preset_legend;
    legend.appendChild(legendText);
    if (model.derived_preset_label === 'custom') {
      const badge = doc.createElement('span');
      badge.className = 'exposure-custom-badge';
      badge.setAttribute(EXPOSURE_PRESET_LABEL_ATTR, 'custom');
      badge.textContent = PANEL_COPY.custom_badge;
      legend.appendChild(badge);
    }
    fieldset.appendChild(legend);

    for (const row of model.preset_rows) {
      const label = doc.createElement('label');
      label.className = 'exposure-preset-row';
      label.setAttribute(EXPOSURE_PRESET_ROW_ATTR, row.preset);
      if (row.is_current) label.setAttribute('data-current', 'true');
      if (row.requires_ddns) label.setAttribute('data-disabled', 'true');

      const input = doc.createElement('input');
      input.setAttribute('type', 'radio');
      input.setAttribute('name', 'exposure-preset');
      input.className = 'exposure-preset-radio';
      if (row.is_current) input.checked = true;
      if (busy || row.requires_ddns) input.disabled = true;
      input.addEventListener('change', () => onPresetClick(row.preset));

      const body = doc.createElement('span');
      body.className = 'exposure-preset-body';
      const title = doc.createElement('span');
      title.className = 'exposure-preset-name';
      title.textContent = row.label;
      const subtitle = doc.createElement('span');
      subtitle.className = 'exposure-preset-subtitle';
      subtitle.textContent = row.subtitle;
      const desc = doc.createElement('span');
      desc.className = 'exposure-preset-desc';
      desc.textContent = row.description;
      body.appendChild(title);
      body.appendChild(subtitle);
      body.appendChild(desc);
      if (row.requires_ddns) {
        const hint = doc.createElement('span');
        hint.className = 'exposure-hint';
        hint.textContent = PANEL_COPY.ddns_hint;
        body.appendChild(hint);
      }

      label.appendChild(input);
      label.appendChild(body);
      fieldset.appendChild(label);
    }
    wrapper.appendChild(fieldset);
  }

  function renderGrid(model: ExposurePageModel): void {
    const section = doc.createElement('div');
    section.className = 'exposure-grid';
    const legend = doc.createElement('p');
    legend.className = 'exposure-legend';
    legend.textContent = PANEL_COPY.grid_legend;
    section.appendChild(legend);

    const table = doc.createElement('table');
    table.className = 'exposure-grid-table';
    const thead = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    for (const text of [
      PANEL_COPY.grid_col_path,
      PANEL_COPY.grid_col_lan,
      PANEL_COPY.grid_col_public,
    ]) {
      const th = doc.createElement('th');
      th.textContent = text;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = doc.createElement('tbody');
    for (const row of model.path_rows) {
      const tr = doc.createElement('tr');
      tr.setAttribute(EXPOSURE_PATH_ROW_ATTR, row.path);

      const pathCell = doc.createElement('td');
      pathCell.className = 'exposure-grid-path';
      const pathName = doc.createElement('span');
      pathName.className = 'exposure-grid-path-name';
      pathName.textContent = row.label;
      const pathSub = doc.createElement('span');
      pathSub.className = 'exposure-grid-path-subtitle';
      pathSub.textContent = row.subtitle;
      pathCell.appendChild(pathName);
      pathCell.appendChild(pathSub);
      tr.appendChild(pathCell);

      tr.appendChild(renderCell(row.path, 'lan', row.resolution.lan, false));
      // The public cell is disabled (with a hint) when DDNS is missing —
      // a public bind with no public address resolves nowhere (DD#2).
      // The /mcp + /ws gate hints ride on the row but don't disable the
      // cell; the gate fires on click.
      tr.appendChild(
        renderCell(
          row.path,
          'public',
          row.resolution.public,
          row.requires_ddns_for_public && !row.resolution.public,
        ),
      );
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    wrapper.appendChild(section);
  }

  function renderCell(
    path: PathRole,
    cell: 'lan' | 'public',
    checked: boolean,
    disabledForDdns: boolean,
  ): HTMLElement {
    const td = doc.createElement('td');
    td.className = 'exposure-grid-cell';
    const input = doc.createElement('input');
    input.setAttribute('type', 'checkbox');
    input.className = 'exposure-cell-checkbox';
    input.setAttribute(EXPOSURE_CELL_ATTR, `${path}.${cell}`);
    input.setAttribute('aria-label', `${path} ${cell}`);
    if (checked) input.checked = true;
    if (busy || disabledForDdns) input.disabled = true;
    input.addEventListener('change', () => onCellClick(path, cell));
    td.appendChild(input);
    if (disabledForDdns) {
      const hint = doc.createElement('span');
      hint.className = 'exposure-hint exposure-hint-inline';
      hint.textContent = PANEL_COPY.ddns_hint;
      td.appendChild(hint);
    }
    return td;
  }

  function renderPublicMcpCard(model: ExposurePageModel): void {
    const active = isPublicMcpAcknowledgementActive(
      model.public_mcp_acknowledgement,
    );
    const card = doc.createElement('div');
    card.className = 'exposure-public-mcp-card';
    if (active) card.setAttribute('data-acknowledged', 'true');

    const text = doc.createElement('p');
    text.className = 'exposure-public-mcp-text';
    text.textContent = active ? PANEL_COPY.public_mcp_on : PANEL_COPY.public_mcp_off;
    card.appendChild(text);

    const btn = makeButton(
      active ? PANEL_COPY.public_mcp_revoke : PANEL_COPY.public_mcp_enable,
      EXPOSURE_PUBLIC_MCP_BTN_ATTR,
      active ? 'danger' : 'secondary',
      onManagePublicMcpClick,
      busy,
    );
    card.appendChild(btn);
    wrapper.appendChild(card);
  }

  function renderApexPicker(model: ExposurePageModel): void {
    const receptionPublic =
      model.path_rows.find((r) => r.path === 'reception')?.resolution.public ===
      true;
    // R26.2 Delta 3 — serve_webclient is gated on /webclient public, parallel
    // to serve_reception. (The bundle-present half can't be known client-side;
    // the server re-checks + rejects with apex_webclient_unavailable, surfaced
    // via the error copy.)
    const webclientPublic =
      model.path_rows.find((r) => r.path === 'webclient')?.resolution.public ===
      true;
    const interactive = opts.runSetApex !== undefined;

    const fieldset = doc.createElement('fieldset');
    fieldset.className = 'exposure-apex';
    const legend = doc.createElement('legend');
    legend.className = 'exposure-legend';
    legend.textContent = PANEL_COPY.apex_legend;
    fieldset.appendChild(legend);

    const help = doc.createElement('p');
    help.className = 'exposure-help';
    help.textContent = PANEL_COPY.apex_help;
    fieldset.appendChild(help);

    for (const mode of ROOT_APEX_MODES) {
      const gateDisabled =
        (mode === 'serve_reception' && !receptionPublic) ||
        (mode === 'serve_webclient' && !webclientPublic); // R26.2 Delta 3
      const isCurrent = apexMode === mode;

      const label = doc.createElement('label');
      label.className = 'exposure-apex-row';
      label.setAttribute(EXPOSURE_APEX_ROW_ATTR, mode);
      if (isCurrent) label.setAttribute('data-current', 'true');
      if (gateDisabled) label.setAttribute('data-disabled', 'true');

      const input = doc.createElement('input');
      input.setAttribute('type', 'radio');
      input.setAttribute('name', 'exposure-apex');
      input.className = 'exposure-apex-radio';
      if (isCurrent) input.checked = true;
      if (busy || !interactive || gateDisabled) input.disabled = true;
      input.addEventListener('change', () => onApexSelect(mode));

      const body = doc.createElement('span');
      body.className = 'exposure-apex-body';
      const title = doc.createElement('span');
      title.className = 'exposure-apex-name';
      title.textContent = APEX_COPY[mode].label;
      const subtitle = doc.createElement('span');
      subtitle.className = 'exposure-apex-subtitle';
      subtitle.textContent = APEX_COPY[mode].subtitle;
      body.appendChild(title);
      body.appendChild(subtitle);
      if (mode === 'serve_reception' && !receptionPublic) {
        const hint = doc.createElement('span');
        hint.className = 'exposure-hint';
        hint.textContent = PANEL_COPY.apex_reception_hint;
        body.appendChild(hint);
      }
      if (mode === 'serve_webclient' && !webclientPublic) {
        const hint = doc.createElement('span');
        hint.className = 'exposure-hint';
        hint.textContent = PANEL_COPY.apex_webclient_hint;
        body.appendChild(hint);
      }

      label.appendChild(input);
      label.appendChild(body);
      fieldset.appendChild(label);
    }

    // Drift warning — the persisted apex is serve_reception but /reception
    // was turned off in the grid since (the root handler now 404s).
    if (apexMode === 'serve_reception' && !receptionPublic) {
      const warn = doc.createElement('p');
      warn.className = 'exposure-apex-warning';
      warn.setAttribute(EXPOSURE_APEX_WARNING_ATTR, '');
      warn.setAttribute('role', 'alert');
      warn.textContent = PANEL_COPY.apex_reception_warning;
      fieldset.appendChild(warn);
    }
    // R26.2 Delta 3 — same drift warning for serve_webclient: the persisted
    // apex is serve_webclient but /webclient was turned off in the grid since
    // (the root handler now 404s).
    if (apexMode === 'serve_webclient' && !webclientPublic) {
      const warn = doc.createElement('p');
      warn.className = 'exposure-apex-warning';
      warn.setAttribute(EXPOSURE_APEX_WARNING_ATTR, '');
      warn.setAttribute('role', 'alert');
      warn.textContent = PANEL_COPY.apex_webclient_warning;
      fieldset.appendChild(warn);
    }

    wrapper.appendChild(fieldset);
  }

  // ── Modal rendering ──────────────────────────────────────────────
  function renderModalShell(
    title: string,
    subtitle: string,
    bullets: ReadonlyArray<string>,
  ): { overlay: HTMLElement; body: HTMLElement; actions: HTMLElement } {
    const overlay = doc.createElement('div');
    overlay.className = 'exposure-modal-overlay';
    overlay.setAttribute(EXPOSURE_MODAL_ATTR, '');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const card = doc.createElement('div');
    card.className = 'exposure-modal-card';

    const h = doc.createElement('h4');
    h.className = 'exposure-modal-title';
    h.textContent = title;
    card.appendChild(h);

    const sub = doc.createElement('p');
    sub.className = 'exposure-modal-subtitle';
    sub.textContent = subtitle;
    card.appendChild(sub);

    if (bullets.length > 0) {
      const ul = doc.createElement('ul');
      ul.className = 'exposure-modal-bullets';
      for (const b of bullets) {
        const li = doc.createElement('li');
        li.textContent = b;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    const body = doc.createElement('div');
    body.className = 'exposure-modal-body';
    card.appendChild(body);

    const actions = doc.createElement('div');
    actions.className = 'exposure-modal-actions';
    card.appendChild(actions);

    overlay.appendChild(card);
    wrapper.appendChild(overlay);
    return { overlay, body, actions };
  }

  function renderPhraseInput(
    body: HTMLElement,
    promptText: string,
    typed: string,
    submitting: boolean,
  ): void {
    if (promptText.length === 0) return;
    const label = doc.createElement('label');
    label.className = 'exposure-modal-phrase-label';
    label.textContent = promptText;
    const input = doc.createElement('input');
    input.setAttribute('type', 'text');
    input.className = 'exposure-modal-phrase-input';
    input.setAttribute(EXPOSURE_MODAL_PHRASE_ATTR, '');
    input.setAttribute('autocomplete', 'off');
    input.value = typed;
    if (submitting) input.disabled = true;
    input.addEventListener('input', (event) => {
      const t = event.target as HTMLInputElement | null;
      setModalPhrase(t?.value ?? '');
    });
    label.appendChild(input);
    body.appendChild(label);
  }

  function renderModalError(body: HTMLElement, code: NetworkErrorCode): void {
    const err = doc.createElement('p');
    err.className = 'exposure-modal-error';
    err.setAttribute('role', 'alert');
    err.textContent = EXPOSURE_ERROR_COPY[code];
    body.appendChild(err);
  }

  function renderPublicMcpModal(): void {
    const m = publicMcpModal;
    if (m.kind === 'idle') return;
    const copy = PUBLIC_MCP_MODAL_COPY[m.mode];
    const { body, actions } = renderModalShell(
      copy.title,
      copy.subtitle,
      copy.bullets,
    );
    const submitting = m.kind === 'submitting';
    const typed = m.kind === 'open' || m.kind === 'submitting' || m.kind === 'error'
      ? m.typed_phrase
      : '';
    renderPhraseInput(body, copy.phrase_prompt, typed, submitting);
    if (m.kind === 'error') renderModalError(body, m.error);

    const phraseOk = m.kind === 'open' ? m.phrase_valid : false;
    const canSubmit =
      m.mode === 'revoke'
        ? m.kind === 'open' || m.kind === 'error'
        : (m.kind === 'open' && phraseOk);

    actions.appendChild(
      makeButton(copy.cancel_label, EXPOSURE_MODAL_CANCEL_ATTR, 'secondary', cancelModal, submitting),
    );
    actions.appendChild(
      makeButton(
        copy.submit_label,
        EXPOSURE_MODAL_SUBMIT_ATTR,
        m.mode === 'revoke' ? 'danger' : 'primary',
        () => {
          pendingWork = submitPublicMcp();
        },
        submitting || !canSubmit,
      ),
    );
  }

  function renderWsLockoutModal(): void {
    const m = wsLockoutModal;
    if (m.kind === 'idle') return;
    const copy = WS_LOCKOUT_MODAL_COPY[m.flavor];
    const { body, actions } = renderModalShell(copy.title, copy.subtitle, copy.bullets);
    const submitting = m.kind === 'submitting';
    const typed =
      m.kind === 'open' || m.kind === 'submitting' || m.kind === 'error'
        ? m.typed_phrase
        : '';
    const requiredPhrase = m.kind === 'open' ? m.required_phrase : '';
    const promptText =
      requiredPhrase.length > 0 ? `Type "${requiredPhrase}" to confirm` : 'Type the confirmation phrase to continue';
    renderPhraseInput(body, promptText, typed, submitting);
    if (m.kind === 'error') renderModalError(body, m.error);

    const canSubmit = m.kind === 'open' && m.phrase_valid;
    actions.appendChild(
      makeButton('Cancel', EXPOSURE_MODAL_CANCEL_ATTR, 'secondary', cancelModal, submitting),
    );
    actions.appendChild(
      makeButton(
        'Confirm',
        EXPOSURE_MODAL_SUBMIT_ATTR,
        'danger',
        () => {
          pendingWork = submitWsLockout();
        },
        submitting || !canSubmit,
      ),
    );
  }

  // ── DOM helpers ──────────────────────────────────────────────────
  function clearChildren(el: HTMLElement): void {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function makeButton(
    label: string,
    attr: string,
    variant: 'danger' | 'primary' | 'secondary',
    onClick: () => void,
    disabledFlag = false,
  ): HTMLButtonElement {
    const btn = doc.createElement('button');
    btn.setAttribute(attr, '');
    btn.type = 'button';
    btn.textContent = label;
    btn.className = `rx-btn rx-btn-${variant} rx-btn-sm exposure-btn`;
    if (disabledFlag) btn.disabled = true;
    btn.addEventListener('click', onClick);
    return btn;
  }

  // Walk the wrapper tree by attribute — prefers `children`, falls back
  // to `childList` so the bootstrap-test fake DOM composes through.
  const findEl = (attr: string, value?: string): HTMLElement | null => {
    const walk = (node: HTMLElement): HTMLElement | null => {
      if (
        typeof node.getAttribute === 'function' &&
        node.hasAttribute?.(attr) &&
        (value === undefined || node.getAttribute(attr) === value)
      ) {
        return node;
      }
      const kids =
        (node as unknown as { children?: ArrayLike<HTMLElement> }).children ??
        (node as unknown as { childList?: ArrayLike<HTMLElement> }).childList;
      if (!kids) return null;
      const length = (kids as { length: number }).length;
      for (let i = 0; i < length; i += 1) {
        const hit = walk(kids[i] as HTMLElement);
        if (hit) return hit;
      }
      return null;
    };
    return walk(wrapper);
  };

  // ── Live refresh subscription (DD#5) ─────────────────────────────
  const unsubscribe = opts.subscribe
    ? opts.subscribe('exposure_changed', (event) => {
        if (disposed) return;
        applyNewState({
          resolution: event.resolution,
          derived_preset_label: event.derived_preset_label,
          public_mcp_acknowledgement: event.public_mcp_acknowledgement,
          last_changed_at: event.changed_at,
          changed_by_client_id: event.changed_by_client_id,
        });
      })
    : undefined;

  // Initial paint + fetch.
  render();
  void refresh();

  return {
    getState: () => ({
      state,
      hasDdns,
      apexMode,
      busy,
      loadError,
      actionError,
      publicMcpModal,
      wsLockoutModal,
      model: currentModel(),
    }),
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (unsubscribe) unsubscribe();
      try {
        opts.host.removeChild(wrapper);
      } catch {
        wrapper.remove?.();
      }
    },
    clickPreset: (preset) => {
      const el = findEl(EXPOSURE_PRESET_ROW_ATTR, preset);
      const input = el
        ? ((el as unknown as { children?: ArrayLike<HTMLElement> }).children?.[0] as
            | (HTMLInputElement & { disabled?: boolean })
            | undefined)
        : undefined;
      // The label's first child is the radio; click it when enabled.
      if (input && !input.disabled) input.click?.();
      else onPresetClick(preset);
    },
    clickCell: (path, cell) => {
      const input = findEl(EXPOSURE_CELL_ATTR, `${path}.${cell}`) as
        | (HTMLInputElement & { disabled?: boolean })
        | null;
      if (input && !input.disabled) input.click?.();
    },
    clickManagePublicMcp: () => {
      const btn = findEl(EXPOSURE_PUBLIC_MCP_BTN_ATTR) as
        | (HTMLButtonElement & { disabled?: boolean })
        | null;
      if (btn && !btn.disabled) btn.click?.();
    },
    clickApex: (mode) => {
      const el = findEl(EXPOSURE_APEX_ROW_ATTR, mode);
      const input = el
        ? ((el as unknown as { children?: ArrayLike<HTMLElement> }).children?.[0] as
            | (HTMLInputElement & { disabled?: boolean })
            | undefined)
        : undefined;
      if (input && !input.disabled) input.click?.();
    },
    setModalPhrase,
    submitModal: async () => {
      const btn = findEl(EXPOSURE_MODAL_SUBMIT_ATTR) as
        | (HTMLButtonElement & { disabled?: boolean })
        | null;
      if (btn && !btn.disabled) btn.click?.();
      const pending = pendingWork;
      if (pending) await pending;
    },
    cancelModal,
    settle: async () => {
      const pending = pendingWork;
      if (pending) await pending;
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

export const EXPOSURE_PANEL_STYLES = `
[${EXPOSURE_PANEL_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-size: 13px;
  color: var(--fg);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-help,
[${EXPOSURE_PANEL_ATTR}] .exposure-public-note {
  margin: 0;
  line-height: 1.45;
  color: var(--fg-muted);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-public-note {
  padding: 8px 10px;
  background: var(--surface-sunk);
  border-radius: var(--wc-radius, 6px);
  color: var(--fg);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-loading {
  margin: 0;
  color: var(--fg-muted);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-load-error {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  padding: 12px;
  border: 1px solid var(--danger);
  border-radius: var(--wc-radius, 6px);
  background: var(--danger-weak);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-load-error-msg { margin: 0; color: var(--danger); }
[${EXPOSURE_PANEL_ATTR}] .exposure-action-error {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--wc-radius, 6px);
  background: var(--danger-weak);
  color: var(--danger);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-legend {
  margin: 0;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-custom-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-weak);
  border-radius: var(--wc-radius-pill, 999px);
  padding: 1px 8px;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-presets {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-preset-row {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 10px;
  align-items: start;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 6px);
  cursor: pointer;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-preset-row[data-current="true"] {
  border-color: var(--accent);
  box-shadow: inset 2px 0 0 var(--accent);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-preset-row[data-disabled="true"] {
  opacity: 0.6;
  cursor: not-allowed;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-preset-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-preset-name { font-weight: 600; }
[${EXPOSURE_PANEL_ATTR}] .exposure-preset-subtitle { color: var(--fg-muted); }
[${EXPOSURE_PANEL_ATTR}] .exposure-preset-desc { color: var(--fg-muted); font-size: 12px; line-height: 1.4; }
[${EXPOSURE_PANEL_ATTR}] .exposure-hint { color: var(--danger); font-size: 12px; }
[${EXPOSURE_PANEL_ATTR}] .exposure-hint-inline { display: block; margin-top: 2px; }
[${EXPOSURE_PANEL_ATTR}] .exposure-grid { display: flex; flex-direction: column; gap: 8px; }
[${EXPOSURE_PANEL_ATTR}] .exposure-grid-table {
  width: 100%;
  border-collapse: collapse;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-grid-table th {
  text-align: left;
  font-weight: 600;
  color: var(--fg-muted);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-grid-table th:not(:first-child) {
  text-align: center;
  width: 72px;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-grid-cell {
  text-align: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-grid-path {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-grid-path-name { font-weight: 600; }
[${EXPOSURE_PANEL_ATTR}] .exposure-grid-path-subtitle { color: var(--fg-muted); font-size: 12px; }
[${EXPOSURE_PANEL_ATTR}] .exposure-cell-checkbox { width: 16px; height: 16px; cursor: pointer; }
[${EXPOSURE_PANEL_ATTR}] .exposure-cell-checkbox:disabled { cursor: not-allowed; }
[${EXPOSURE_PANEL_ATTR}] .exposure-public-mcp-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 6px);
  background: var(--surface-sunk);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-public-mcp-card[data-acknowledged="true"] {
  border-color: var(--accent);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-public-mcp-text { margin: 0; color: var(--fg-muted); }
[${EXPOSURE_PANEL_ATTR}] .exposure-apex {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-apex-row {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 10px;
  align-items: start;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--wc-radius, 6px);
  cursor: pointer;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-apex-row[data-current="true"] {
  border-color: var(--accent);
  box-shadow: inset 2px 0 0 var(--accent);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-apex-row[data-disabled="true"] {
  opacity: 0.6;
  cursor: not-allowed;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-apex-body { display: flex; flex-direction: column; gap: 2px; }
[${EXPOSURE_PANEL_ATTR}] .exposure-apex-name { font-weight: 600; }
[${EXPOSURE_PANEL_ATTR}] .exposure-apex-subtitle { color: var(--fg-muted); font-size: 12px; line-height: 1.4; }
[${EXPOSURE_PANEL_ATTR}] .exposure-apex-warning {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--wc-radius, 6px);
  background: var(--danger-weak);
  color: var(--danger);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-modal-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  z-index: 1000;
  padding: 24px;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-modal-card {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  max-width: 460px;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-modal-title { margin: 0; font-size: 15px; font-weight: 600; }
[${EXPOSURE_PANEL_ATTR}] .exposure-modal-subtitle { margin: 0; color: var(--fg-muted); line-height: 1.45; }
[${EXPOSURE_PANEL_ATTR}] .exposure-modal-bullets { margin: 0; padding-left: 18px; color: var(--fg-muted); display: flex; flex-direction: column; gap: 4px; }
[${EXPOSURE_PANEL_ATTR}] .exposure-modal-body { display: flex; flex-direction: column; gap: 8px; }
[${EXPOSURE_PANEL_ATTR}] .exposure-modal-phrase-label { display: flex; flex-direction: column; gap: 4px; font-weight: 600; }
[${EXPOSURE_PANEL_ATTR}] .exposure-modal-phrase-input {
  font: inherit;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--wc-radius, 6px);
  background: var(--surface);
  color: var(--fg);
}
[${EXPOSURE_PANEL_ATTR}] .exposure-modal-error { margin: 0; color: var(--danger); }
[${EXPOSURE_PANEL_ATTR}] .exposure-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
`;
