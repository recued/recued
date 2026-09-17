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
 *  Spec: D-148 § A.7 + the R26.2 design
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
// ⛔ The SAME builder the contracts route uses, imported rather than copied —
// two surfaces printing a connection example for one server must not be able to
// disagree about its endpoint.
import { buildMcpClientSnippets } from '../contracts/bootstrap-contracts-route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';

// ════════════════════════════════════════════════════════════════
// Element ids — stable for DOM tests + host introspection
// ════════════════════════════════════════════════════════════════

export const EXPOSURE_PANEL_ATTR = 'data-recued-exposure-panel';
export const EXPOSURE_LAN_POSTURE_ATTR = 'data-recued-exposure-lan-posture';
export const EXPOSURE_LAN_STATE_ATTR = 'data-recued-exposure-lan-state';
export const EXPOSURE_LAN_CHECK_ATTR = 'data-recued-exposure-lan-check';
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
/** The "Connection example" button on the public-MCP card, and its modal.
 *
 *  🔑 IT LIVES HERE RATHER THAN IN `#contracts` BECAUSE THIS IS WHERE THE
 *  ENDPOINT IS DECIDED. `buildMcpClientSnippets` derives the snippet from the
 *  server URL, so the address it prints is only correct once the owner has
 *  chosen how the server is reachable — which is this panel. Shown beside the
 *  public-MCP switch, the example is the answer to "I just enabled this, now
 *  what do I paste into my agent". The contracts route keeps its own copy for
 *  the per-contract connect flow; this is the same BUILDER, not a second one. */
export const EXPOSURE_CONNECT_BTN_ATTR = 'data-recued-exposure-connect-example';
export const EXPOSURE_CONNECT_MODAL_ATTR = 'data-recued-exposure-connect-modal';
export const EXPOSURE_CONNECT_SNIPPET_ATTR = 'data-recued-exposure-connect-snippet';
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

/** D-272 — the LAN listener's bind posture, rendered as a finding.
 *
 *  ⛔ MOVED HERE FROM "CONNECT A DEVICE" ON ONE TEST: is it a PREREQUISITE for
 *  connecting a device, or a fact about what is open? Everything else on that
 *  page is a prerequisite — a certificate, a forwarded port, an address that
 *  resolves — and each one is something the reader must get right before a
 *  device can connect. This is neither: nothing downstream depends on it, and a
 *  reader can connect every device they own with it unresolved. It is a
 *  SECURITY FINDING, and this is the page that answers "what is open".
 *
 *  ⚠ It sits on a different AXIS from the path grid above it and that is the
 *  point of having both. The grid says which PATHS are served publicly; this
 *  says who can reach the listener at all. A path switched off is not reachable
 *  however the socket is bound — and a socket on a public address is reachable
 *  whatever the grid says about the paths it serves. */
export interface ExposureLanPosture {
  lanPort: number;
  publiclyRoutable: boolean;
  publicAddresses: readonly string[];
  /** ⚠ Tri-state. `null` = nobody has asked from outside; `false` = asked and
   *  refused. An unchecked box that claims the port was looked at and found
   *  shut is the mistake D-272 spent a decision on. */
  reachedFromOutside: boolean | null;
}

export const EXPOSURE_LAN_HEADING = 'What can reach your local port';

export const exposureLanNote = (posture: ExposureLanPosture): string => {
  const where = posture.publicAddresses.join(', ');
  if (!posture.publiclyRoutable) {
    // ⚠ SAID OUT LOUD RATHER THAN LEFT BLANK. "Nothing here" and "we did not
    // look" render identically as silence, and this page's whole job is to say
    // what is open — including when the answer is "only your own network".
    return `Port ${posture.lanPort} is only reachable from your own network.`;
  }
  if (posture.reachedFromOutside === true) {
    return `⛔ Port ${posture.lanPort} was reached from the internet at ${where}, `
      + 'and it is not encrypted. Block it in your firewall, or bind it to your '
      + 'local address only.';
  }
  if (posture.reachedFromOutside === false) {
    return `⚠ Port ${posture.lanPort} is open on ${where}, a public address. `
      + 'A check from outside could not get in, so something is blocking it. '
      + 'Worth knowing if that firewall changes.';
  }
  return `⚠ Port ${posture.lanPort} is also open on ${where}. That address is `
    + 'reachable from the internet, and this port is not encrypted.';
};

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
  /** D-272 — the LAN listener's bind posture, from `network.local_urls`.
   *  Fire-and-forget at mount; absent ⇒ the section does not render, which is
   *  the honest state for a server too old to report it. */
  readLanPosture?: () => Promise<Omit<ExposureLanPosture, 'reachedFromOutside'> | undefined>;
  /** Reads the standing "did outside get in on the LAN port" verdict. ⚠ PULLED
   *  at every render so a check run anywhere settles this section too — there is
   *  no second copy to go stale. */
  readLanReachedFromOutside?: (lanPort: number) => boolean | null;
  /** Runs a check from outside for the LAN port. Absent ⇒ the finding renders
   *  without a control, which is still worth saying. */
  checkLanFromOutside?: (lanPort: number) => Promise<void>;
  /** Live-refresh seam (DD#5). Production wires the bootstrap's
   *  `subscriber.on`; absent ⇒ mount-fetch + post-mutation only. */
  subscribe?: BroadcastSubscriber['on'];
  /** The paired server's URL, used to derive the MCP endpoint in the
   *  "Connection example" modal (`buildMcpClientSnippets`).
   *
   *  ⚠ OPTIONAL, AND ABSENT MEANS THE BUTTON DOES NOT RENDER — not that it
   *  renders a guessed endpoint. A snippet naming the wrong host is worse than
   *  no snippet: the owner pastes it into an agent and debugs a connection that
   *  was never going to work. The bootstrap reads it from `localStore`
   *  (`server_url`), which can genuinely be absent.
   *
   *  ⚠ A GETTER, not a value: the bootstrap reads `server_url` asynchronously
   *  while this panel mounts synchronously, so a snapshot taken at mount would
   *  be `undefined` forever. Read at RENDER time instead. */
  getServerUrl?: () => string | undefined;
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

interface ModalReturnFocusTarget {
  attr: string;
  value?: string;
  childIndex?: number;
}

interface ModalPhraseSelection {
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none' | null;
}

// The webclient is itself a `/ws` client, so ≥ 1 (DD#3).
const ASSUMED_ACTIVE_WS = 1;
let exposurePanelIdSequence = 0;

/** R26.2 Delta 2 — apex picker copy. */
const APEX_COPY: Record<
  RootApexMode,
  { label: string; subtitle: string }
> = {
  redirect: {
    label: 'Redirect to app.recued.com',
    subtitle: 'The normal choice. Safe to share, and always the newest Recued.',
  },
  serve_reception: {
    label: 'Serve Reception',
    subtitle: 'Visitors land on your Reception page. /reception has to be open.',
  },
  serve_webclient: {
    label: 'Serve the webclient',
    subtitle: "This server serves its own copy of Recued. /webclient has to be open.",
  },
  not_found: {
    label: 'Closed (404)',
    subtitle: 'Show a plain “not found” page.',
  },
};

const PANEL_COPY = {
  heading: 'Exposure & serving',
  intro:
    'Choose who can reach this server. The presets set everything at once. The list below lets you set each part on its own. The /mcp row lets AI apps in. The /reception row lets visitors in.',
  loading: 'Loading exposure state…',
  load_error:
    "Recued could not load these settings. Check your server is connected, then try again.",
  preset_legend: 'Preset',
  grid_legend: 'What each part allows',
  grid_col_path: 'Path',
  grid_col_lan: 'LAN',
  grid_col_public: 'Public',
  custom_badge: 'Custom',
  ddns_hint: 'Set up a web address first, under Settings, Server, Hostnames.',
  public_mcp_on: 'You have agreed to this. AI apps can reach /mcp from outside your network once you switch it on.',
  public_mcp_off: 'You have not agreed to this yet. To open /mcp you have to type the phrase to confirm.',
  connect_example: 'Connection example…',
  connect_modal_title: 'Connect an AI app to this server',
  connect_modal_subtitle:
    'Paste one of these into your AI app. Put a real key where the placeholder is. Keys come '
    + 'from an agreement.',
  connect_modal_note:
    'Being able to reach it is not the same as being allowed in. What the app may do is set '
    + 'by its agreement, not by this page.',
  connect_modal_close: 'Close',
  public_mcp_enable: 'Let AI apps in from outside…',
  public_mcp_revoke: 'Shut AI apps out again',
  any_public_note:
    'Something is open, so your server can be reached from the internet. Have a look at the reachability check.',
  apex_legend: 'Root URL ( / )',
  apex_help:
    'What someone sees if they just type your address. This takes effect at once.',
  apex_reception_hint: 'Open /reception in the list above first.',
  apex_webclient_hint:
    'Open /webclient in the list above first, and make sure this server has a copy of Recued to serve.',
  apex_reception_warning:
    'You have chosen Reception, but /reception is not open. People will see “not found” until you open it above.',
  apex_webclient_warning:
    'You have chosen Recued, but /webclient is not open. People will see “not found” until you open it above.',
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
  let connectExampleOpen = false;
  let wsLockoutModal: WsLockoutModalState = { kind: 'idle' };
  const modalIdBase = `recued-exposure-modal-${++exposurePanelIdSequence}`;
  let modalReturnFocus: ModalReturnFocusTarget | null = null;
  let modalPhraseSelection: ModalPhraseSelection | null = null;
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
  let lanPosture: Omit<ExposureLanPosture, 'reachedFromOutside'> | null = null;
  let checkingLan = false;

  const runLanCheck = (): void => {
    if (opts.checkLanFromOutside === undefined || lanPosture === null || checkingLan) return;
    checkingLan = true;
    render();
    void (async () => {
      try {
        await opts.checkLanFromOutside!(lanPosture!.lanPort);
      } catch {
        // ⛔ A check that could not RUN says nothing about the port. The verdict
        // stays where the reader's last real answer left it.
      } finally {
        checkingLan = false;
        render();
      }
    })();
  };

  const renderLanPosture = (): void => {
    if (lanPosture === null) return;
    const section = doc.createElement('section');
    section.className = 'exposure-lan-posture';
    section.setAttribute(EXPOSURE_LAN_POSTURE_ATTR, 'true');
    section.setAttribute(
      EXPOSURE_LAN_STATE_ATTR,
      lanPosture.publiclyRoutable ? 'public' : 'local',
    );
    const heading = doc.createElement('h4');
    heading.textContent = EXPOSURE_LAN_HEADING;
    section.appendChild(heading);
    const reached = opts.readLanReachedFromOutside?.(lanPosture.lanPort) ?? null;
    const note = doc.createElement('p');
    note.className = 'exposure-lan-note';
    note.textContent = exposureLanNote({ ...lanPosture, reachedFromOutside: reached });
    section.appendChild(note);
    // ⚠ OFFERED ONLY WHERE IT COULD TELL THE READER SOMETHING NEW. With the
    // listener on no public address there is nothing outside could reach, so a
    // check would spend five seconds confirming what the bind already proved.
    if (lanPosture.publiclyRoutable && opts.checkLanFromOutside !== undefined) {
      const button = doc.createElement('button');
      button.setAttribute('type', 'button');
      button.setAttribute(EXPOSURE_LAN_CHECK_ATTR, 'true');
      button.textContent = checkingLan
        ? 'Checking…'
        : reached !== null ? 'Check again' : 'Check from the internet';
      if (checkingLan) button.setAttribute('disabled', 'true');
      button.addEventListener('click', runLanCheck);
      section.appendChild(button);
    }
    wrapper.appendChild(section);
  };

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
    renderLanPosture();
    // Modals render last so they overlay (CSS positions them fixed).
    if (publicMcpModal.kind !== 'idle') renderPublicMcpModal();
    if (wsLockoutModal.kind !== 'idle') renderWsLockoutModal();
    if (connectExampleOpen) renderConnectExampleModal();
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
    // D-272 — the bind posture, alongside the others. ⚠ Advisory like the DDNS
    // probe: a failure leaves the section unrendered rather than blocking the
    // grid, because "we could not read the bind" is not a reason to withhold
    // the path resolution the reader came for.
    if (opts.readLanPosture !== undefined) {
      void opts.readLanPosture()
        .then((posture) => {
          if (disposed || posture === undefined) return;
          lanPosture = posture;
          render();
        })
        .catch(() => { /* section stays unrendered — see above */ });
    }
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
      modalReturnFocus = {
        attr: EXPOSURE_PRESET_ROW_ATTR,
        value: preset,
        childIndex: 0,
      };
      modalPhraseSelection = null;
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
      modalReturnFocus = {
        attr: EXPOSURE_CELL_ATTR,
        value: `${path}.${cell}`,
      };
      modalPhraseSelection = null;
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
      modalReturnFocus = {
        attr: EXPOSURE_CELL_ATTR,
        value: `${path}.${cell}`,
      };
      modalPhraseSelection = null;
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
    modalReturnFocus = { attr: EXPOSURE_PUBLIC_MCP_BTN_ATTR };
    modalPhraseSelection = null;
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
      renderClosedModalAndRestore();
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
      if (publicMcpModal.kind === 'idle') renderClosedModalAndRestore();
      else render();
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
      renderClosedModalAndRestore();
    } catch (err) {
      if (disposed) return;
      const code = networkErrorCodeOf(err);
      if (code !== null) {
        wsLockoutModal = failWsLockoutModal(wsLockoutModal, code);
      } else {
        wsLockoutModal = closeWsLockoutModal();
        actionError = errorCopyOf(err);
      }
      if (wsLockoutModal.kind === 'idle') renderClosedModalAndRestore();
      else render();
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
    renderClosedModalAndRestore();
  };

  const setModalPhrase = (
    phrase: string,
    selection: ModalPhraseSelection = {
      start: phrase.length,
      end: phrase.length,
      direction: null,
    },
  ): void => {
    modalPhraseSelection = selection;
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
    const label = doc.createElement('label');
    label.className = 'exposure-cell-target';
    const input = doc.createElement('input');
    input.setAttribute('type', 'checkbox');
    input.className = 'exposure-cell-checkbox';
    input.setAttribute(EXPOSURE_CELL_ATTR, `${path}.${cell}`);
    input.setAttribute('aria-label', `${path} ${cell}`);
    if (checked) input.checked = true;
    if (busy || disabledForDdns) {
      input.disabled = true;
      label.className += ' exposure-cell-target-disabled';
    }
    input.addEventListener('change', () => onCellClick(path, cell));
    label.appendChild(input);
    td.appendChild(label);
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
    // Rendered whenever the server URL is known, NOT only when public MCP is
    // on: the snippet is equally the answer for a LAN-only agent, and hiding it
    // behind the acknowledgement would imply MCP requires public exposure.
    const exampleUrl = opts.getServerUrl?.();
    if (exampleUrl !== undefined && exampleUrl !== '') {
      card.appendChild(makeButton(
        PANEL_COPY.connect_example,
        EXPOSURE_CONNECT_BTN_ATTR,
        'secondary',
        () => { connectExampleOpen = true; render(); },
        busy,
      ));
    }
    wrapper.appendChild(card);
  }

  /** The connection-example modal — read-only, no phrase, no mutation. It shows
   *  what to paste into an agent, derived from the SAME `buildMcpClientSnippets`
   *  the contracts route uses, so the two surfaces cannot drift into printing
   *  different endpoints for one server. */
  function renderConnectExampleModal(): void {
    const url = opts.getServerUrl?.();
    if (url === undefined || url === '') return;
    const { overlay, body, actions } = renderModalShell(
      PANEL_COPY.connect_modal_title,
      PANEL_COPY.connect_modal_subtitle,
      [PANEL_COPY.connect_modal_note],
    );
    overlay.setAttribute(EXPOSURE_CONNECT_MODAL_ATTR, '');
    for (const snippet of buildMcpClientSnippets(url)) {
      const h = doc.createElement('h5');
      h.className = 'exposure-connect-snippet-label';
      h.textContent = snippet.label;
      body.appendChild(h);
      const pre = doc.createElement('pre');
      pre.className = 'exposure-connect-snippet';
      pre.setAttribute(EXPOSURE_CONNECT_SNIPPET_ATTR, snippet.id);
      pre.textContent = snippet.body;
      body.appendChild(pre);
    }
    actions.appendChild(makeButton(
      PANEL_COPY.connect_modal_close,
      EXPOSURE_MODAL_CANCEL_ATTR,
      'secondary',
      () => { connectExampleOpen = false; render(); },
      false,
    ));
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
    overlay.setAttribute('aria-labelledby', `${modalIdBase}-title`);
    overlay.setAttribute('aria-describedby', `${modalIdBase}-description`);
    overlay.tabIndex = -1;

    const card = doc.createElement('div');
    card.className = 'exposure-modal-card';

    const h = doc.createElement('h4');
    h.className = 'exposure-modal-title';
    h.setAttribute('id', `${modalIdBase}-title`);
    h.textContent = title;
    card.appendChild(h);

    const sub = doc.createElement('p');
    sub.className = 'exposure-modal-subtitle';
    sub.setAttribute('id', `${modalIdBase}-description`);
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
  ): HTMLInputElement | null {
    if (promptText.length === 0) return null;
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
      const value = t?.value ?? '';
      setModalPhrase(value, {
        start: t?.selectionStart ?? value.length,
        end: t?.selectionEnd ?? value.length,
        direction: t?.selectionDirection ?? null,
      });
    });
    label.appendChild(input);
    body.appendChild(label);
    return input;
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
    const { overlay, body, actions } = renderModalShell(
      copy.title,
      copy.subtitle,
      copy.bullets,
    );
    const submitting = m.kind === 'submitting';
    const typed = m.kind === 'open' || m.kind === 'submitting' || m.kind === 'error'
      ? m.typed_phrase
      : '';
    const phraseInput = renderPhraseInput(
      body,
      copy.phrase_prompt,
      typed,
      submitting,
    );
    if (m.kind === 'error') renderModalError(body, m.error);

    const phraseOk = m.kind === 'open' ? m.phrase_valid : false;
    const canSubmit =
      m.mode === 'revoke'
        ? m.kind === 'open' || m.kind === 'error'
        : (m.kind === 'open' && phraseOk);

    const cancelButton = makeButton(
      copy.cancel_label,
      EXPOSURE_MODAL_CANCEL_ATTR,
      'secondary',
      cancelModal,
      submitting,
    );
    const submitButton = makeButton(
      copy.submit_label,
      EXPOSURE_MODAL_SUBMIT_ATTR,
      m.mode === 'revoke' ? 'danger' : 'primary',
      () => {
        pendingWork = submitPublicMcp();
      },
      submitting || !canSubmit,
    );
    actions.appendChild(cancelButton);
    actions.appendChild(submitButton);
    ownModalFocus(
      overlay,
      phraseInput === null
        ? [cancelButton, submitButton]
        : [phraseInput, cancelButton, submitButton],
      phraseInput ?? cancelButton,
      submitting,
    );
  }

  function renderWsLockoutModal(): void {
    const m = wsLockoutModal;
    if (m.kind === 'idle') return;
    const copy = WS_LOCKOUT_MODAL_COPY[m.flavor];
    const { overlay, body, actions } = renderModalShell(
      copy.title,
      copy.subtitle,
      copy.bullets,
    );
    const submitting = m.kind === 'submitting';
    const typed =
      m.kind === 'open' || m.kind === 'submitting' || m.kind === 'error'
        ? m.typed_phrase
        : '';
    const requiredPhrase = m.kind === 'open' ? m.required_phrase : '';
    const promptText =
      requiredPhrase.length > 0 ? `Type "${requiredPhrase}" to confirm` : 'Type the phrase to confirm';
    const phraseInput = renderPhraseInput(body, promptText, typed, submitting);
    if (m.kind === 'error') renderModalError(body, m.error);

    const canSubmit = m.kind === 'open' && m.phrase_valid;
    const cancelButton = makeButton(
      'Cancel',
      EXPOSURE_MODAL_CANCEL_ATTR,
      'secondary',
      cancelModal,
      submitting,
    );
    const submitButton = makeButton(
      'Confirm',
      EXPOSURE_MODAL_SUBMIT_ATTR,
      'danger',
      () => {
        pendingWork = submitWsLockout();
      },
      submitting || !canSubmit,
    );
    actions.appendChild(cancelButton);
    actions.appendChild(submitButton);
    ownModalFocus(
      overlay,
      phraseInput === null
        ? [cancelButton, submitButton]
        : [phraseInput, cancelButton, submitButton],
      phraseInput ?? cancelButton,
      submitting,
    );
  }

  function ownModalFocus(
    overlay: HTMLElement,
    controls: ReadonlyArray<HTMLElement>,
    initialControl: HTMLElement,
    submitting: boolean,
  ): void {
    const enabledControls = (): HTMLElement[] =>
      controls.filter((control) =>
        !(control as HTMLElement & { disabled?: boolean }).disabled,
      );
    const focusElement = (element: HTMLElement): void => {
      (element as HTMLElement & {
        focus?: (options?: FocusOptions) => void;
      }).focus?.({ preventScroll: true });
    };

    overlay.addEventListener('keydown', (event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        if (!submitting) cancelModal();
        return;
      }
      if (keyEvent.key !== 'Tab') return;

      const available = enabledControls();
      if (available.length === 0) {
        keyEvent.preventDefault?.();
        focusElement(overlay);
        return;
      }
      const active = doc.activeElement;
      const currentIndex = available.indexOf(active as HTMLElement);
      const wrapsBackward = keyEvent.shiftKey && currentIndex <= 0;
      const wrapsForward = !keyEvent.shiftKey &&
        (currentIndex < 0 || currentIndex === available.length - 1);
      if (!wrapsBackward && !wrapsForward) return;
      keyEvent.preventDefault?.();
      focusElement(
        wrapsBackward ? available[available.length - 1]! : available[0]!,
      );
    });

    if (submitting) {
      overlay.setAttribute('aria-busy', 'true');
      focusElement(overlay);
      return;
    }
    focusElement(initialControl);
    if (initialControl === controls[0] && modalPhraseSelection !== null) {
      const input = initialControl as HTMLInputElement & {
        setSelectionRange?: (
          start: number,
          end: number,
          direction?: 'forward' | 'backward' | 'none',
        ) => void;
      };
      const selection = modalPhraseSelection;
      if (selection.direction === null) {
        input.setSelectionRange?.(selection.start, selection.end);
      } else {
        input.setSelectionRange?.(
          selection.start,
          selection.end,
          selection.direction,
        );
      }
    }
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

  function renderClosedModalAndRestore(): void {
    const target = modalReturnFocus;
    modalReturnFocus = null;
    modalPhraseSelection = null;
    render();
    if (target === null) return;
    const root = findEl(target.attr, target.value);
    const focusTarget = target.childIndex === undefined
      ? root
      : ((root as unknown as { children?: ArrayLike<HTMLElement> } | null)
          ?.children?.[target.childIndex] ?? null);
    (focusTarget as (HTMLElement & {
      focus?: (options?: FocusOptions) => void;
    }) | null)?.focus?.({ preventScroll: true });
  }

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
[${EXPOSURE_PANEL_ATTR}] .exposure-cell-target {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
  min-height: 36px;
  border-radius: var(--wc-radius, 6px);
  cursor: pointer;
}
[${EXPOSURE_PANEL_ATTR}] .exposure-cell-target-disabled { cursor: not-allowed; }
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
