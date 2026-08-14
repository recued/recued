/** D-148 § A.4 — Settings route bootstrap (NEXT-#2 advance, slices 110 + 111 + D-156 P5).
 *
 *  Mounts the Settings surface as a sibling of the Reception route
 *  under `WebclientRouteId = 'settings'`. The route composes the
 *  per-section mounts:
 *    - Privacy — slice 110 — `mountClearThisBrowserPanel`.
 *    - Devices — D-156 P5 — `mountDevicesPage` (operator-initiated
 *      `pair.list` + `pair.revoke` rpcs). Mounted only when the
 *      bootstrap is supplied a `pairListCaller` + `pairRevokeCaller`;
 *      tests + offline boot paths that omit the callers skip the
 *      Devices section without rendering an empty placeholder.
 *    - Server  — slice 111 — `mountTlsRenewPanel` (operator-initiated
 *      `tls.renew` rpc). Mounted only when the bootstrap is supplied
 *      a `tlsRenewCaller`; tests + offline boot paths that omit the
 *      caller skip the Server section without rendering an empty
 *      placeholder.
 *  Future sections (Pro, Connections) graduate by appending additional
 *  `<section data-recued-settings-section="…">` children through the
 *  same gated-mount shape.
 *
 *  ── Two exports ────────────────────────────────────────────────────
 *    - `bootstrapSettingsRoute(opts)` — the route-bootstrap factory.
 *      Constructs the route's DOM, mounts the Privacy directory, and
 *      returns a `SettingsRoute` handle with `update()` / `dispose()`
 *      plus `clearThisBrowserPanel()` for host / test introspection.
 *    - `SETTINGS_ROUTE_*` — closed-list attribute constants for the
 *      route root + section slots, the styles marker, and the self-
 *      scoped CSS payload.
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Left-rail nav over many focused sections. The route grew from
 *  a single Privacy panel (slice 110) into a left-rail of subviews
 *  (`registerSubview` → one rail item + a `#settings/<id>` deep-link
 *  each); one section is visible at a time. Sections that assemble
 *  several sub-panels use an in-section sub-tab strip (`buildSectionTabs`,
 *  e.g. Server); Privacy itself is a single-scroll directory (R29).
 *
 *  DD#2 — Reuse the panel's `crypto_keys_wiper` seam, do not re-
 *  implement. The AES key store wiper (`wipeWebclientCryptoKeyStore`
 *  in `webclient-main.ts`) re-opens its own IDB handle; the route
 *  forwards the caller's wiper through to the panel verbatim. Tests
 *  inject a counted fake; production wires the real function via the
 *  bootstrap option.
 *
 *  DD#3 — Style injection mirrors `reception-bootstrap.ts`. One
 *  marker-guarded `<style>` tag at `<head>` carries this route's CSS
 *  + the panel's CSS bundled together (the panel exports its styles
 *  for exactly this composition). A re-bootstrap on the same document
 *  (dispose + remount across hash transitions) finds the existing
 *  marker + skips the duplicate injection.
 *
 *  DD#4 — `clearThisBrowserPanel()` accessor exposes the "This browser"
 *  wipe mount handle (the one disposable local panel the Privacy
 *  directory hosts). Tests use it to drive the click seams + observe
 *  state transitions; the host (webclient-bootstrap) uses it to wire
 *  telemetry sinks. The panel itself owns its lifecycle; the route's
 *  `dispose()` cascades through the panel's `dispose()` before removing
 *  the route root.
 *
 *  DD#5 — Children appended directly to `opts.root` in document
 *  order. The Reception route stamps `data-reception-shell` on its
 *  root + creates three slot children; this route stamps
 *  `data-recued-settings-route` on a single child of `root` so the
 *  hashchange teardown can `removeChild()` the entire settings tree
 *  cleanly without leaking attributes onto `options.root` itself
 *  (which a future Settings → some-other-route remount would then
 *  inherit).
 *
 *  Spec: D-148 § A.4.1 (Storage model — "Clear this
 *  browser" + closed-list state). */

import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import type { ReachabilityReport, RotationResult } from '@recued/contracts';

import {
  CLEAR_THIS_BROWSER_PANEL_STYLES,
  mountClearThisBrowserPanel,
  type ClearThisBrowserPanelMount,
} from './clear-this-browser-panel.js';
import {
  TLS_RENEW_PANEL_STYLES,
  mountTlsRenewPanel,
  type TlsRenewCaller,
  type TlsRenewPanelMount,
} from './tls-renew-panel.js';
import {
  TLS_CERTIFICATES_PANEL_STYLES,
  mountTlsCertificatesPanel,
  type TlsCertificatesPanelMount,
  type TlsDomainListCaller,
  type TlsDomainRemoveCaller,
  type TlsDomainUploadCaller,
} from './tls-certificates.js';
import {
  EXPOSURE_PANEL_STYLES,
  mountExposurePanel,
  type ExposureApplyPresetCaller,
  type ExposureGetCaller,
  type ExposureHasDdnsCaller,
  type ExposurePanelMount,
  type ExposureSetApexCaller,
  type ExposureSetPathResolutionCaller,
  type ExposureSetPublicMcpAckCaller,
} from './exposure-panel.js';
import {
  KEY_HEALTH_PANEL_STYLES,
  mountKeyHealthPanel,
  type KeyHealthLoader,
  type KeyRotateCaller,
  type KeyHealthPanelMount,
  type SystemStatusLoader,
} from './key-health-panel.js';
import {
  CERT_PIN_STALE_PANEL_STYLES,
  mountCertPinStalePanel,
  type CertPinStalePanelMount,
} from './cert-pin-stale-panel.js';
import {
  DEVICES_PAGE_STYLES,
  mountDevicesPage,
  type DevicesPageMount,
  type PairListCaller,
  type PairRevokeCaller,
} from './devices-page-mount.js';
import {
  NOTIFICATIONS_PANEL_STYLES,
  mountNotificationsPanel,
  type NotificationsDescribeBridgesCaller,
  type NotificationsDescribeCaller,
  type NotificationsPanelMount,
  type NotificationsSetBridgeModeCaller,
  type NotificationsSetChannelCaller,
  type NotificationsSetVerificationPhraseCaller,
} from './notifications-panel.js';
// D-187 §6 follow-on — the Packs panel, the {Access × Scope} install grant
// picker, and the install-time cli grant dialog all moved with the Packs
// surface to `packs/bootstrap-packs-route.ts`. (The roster-wide Local tools
// reachability grid moved there too and was deleted outright on 2026-07-27 —
// the by-pack ACCESS tab and `#contracts` are the two surviving axes.)
import { type ConnectionsEnrollPanelMount } from './connections-enroll-panel.js';
import { type PermissionsPanelMount } from './permissions-panel.js';
import { type ContractsPanelMount } from './contracts-panel.js';
import {
  LLM_RESULT_CACHE_CARD_STYLES,
  type LlmResultCacheCardMount,
  type LlmResultCacheClearCaller,
  type LlmResultCacheStatsCaller,
} from './llm-result-cache-card-mount.js';
import {
  TRANSPARENCY_PANEL_STYLES,
  mountTransparencyPanel,
  type TransparencyPanelMount,
  type TransparencyPrefsGetCaller,
  type TransparencyPrefsSetCaller,
} from './transparency-panel.js';
import {
  mountLearningPanel,
  LEARNING_PANEL_STYLES,
  type LearningCaseForgetCaller,
  type LearningCasesListCaller,
  type LearningDraftRecipeCaller,
  type LearningPanelMount,
  type LearningPrefsGetCaller,
  type LearningPrefsSetCaller,
} from './learning-panel.js';
import {
  AI_MODELS_PAGE_STYLES,
  mountAiModelsPage,
  type AiModelsConfigFieldSetCaller,
  type AiModelsConfigSchemaGetCaller,
  type AiModelsHousekeepingConfigReadCaller,
  type AiModelsHousekeepingConfigWriteCaller,
  type AiModelsLlmConfigGetCaller,
  type AiModelsLlmSlotSetCaller,
  type AiModelsEmbeddingsSlotSetCaller,
  type AiModelsFreePoolEntryUpsertCaller,
  type AiModelsFreePoolEntryRemoveCaller,
  type AiModelsFreePoolEntryEnabledCaller,
  type AiModelsSetChatCatalogModeCaller,
  type AiModelsLlmPromptsGetCaller,
  type AiModelsLlmPromptSetCaller,
  type AiModelsInitialView,
  type AiModelsPageMount,
  type ChatDefaultModelPrefGetCaller,
  type ChatDefaultModelPrefSetCaller,
} from './ai-models-page.js';
import {
  SELLER_PAGE_STYLES,
  mountSellerPage,
  type SellerRecipeRunCaller,
  type SellerAcknowledgeLlmGatewayPaidCaller,
  type SellerListOrdersCaller,
  type SellerMailListCaller,
  type SellerManualCustomerCloseCaller,
  type SellerManualCustomerExtendCaller,
  type SellerManualCustomerIssueCaller,
  type SellerManualCustomerReissueTokenCaller,
  type SellerManualCustomerSwapTierCaller,
  type SellerManualTierBulkAdjustCaller,
  type SellerManualTierUpsertCaller,
  type SellerCreatePassTierCaller,
  type SellerOfferStateTransitionCaller,
  type SellerOverviewCaller,
  type SellerPageMount,
  type SellerSettingsUpdateCaller,
  type SellerStripeSynchronizeCaller,
} from './seller-page.js';
import {
  mountUpdatesPage,
  UPDATES_PAGE_STYLES,
  type MountUpdatesPageOptions,
  type UpdatesPageMount,
  type UpdateCheckCaller,
  type UpdateModeGetCaller,
  type UpdateModeSetCaller,
  type UpdateApplyCaller,
  type UpdateRollbackCaller,
} from './updates-page.js';
import {
  HOUSEKEEPING_PANEL_STYLES,
  mountHousekeepingPanel,
  type HousekeepingConfigReadCaller,
  type HousekeepingConfigWriteCaller,
  type HousekeepingDismissPromotionCaller,
  type HousekeepingPanelMount,
  type HousekeepingRegistryDescribeCaller,
  type HousekeepingRunNowCaller,
  type HousekeepingStatusReadCaller,
  type HousekeepingTopicResetCaller,
  type HousekeepingTrustReadCaller,
  type HousekeepingTrustWriteCaller,
} from './housekeeping-panel-mount.js';
import {
  mountMaintenancePanel,
  type MaintenancePanelMount,
} from './maintenance-panel-mount.js';
import {
  HOSTNAMES_PANEL_STYLES,
  ddnsPauseWouldSelfDisconnect,
  mountHostnamesPanel,
  type DdnsControlContext,
  type DdnsSetEnabledCaller,
  type DdnsStatusCaller,
  type HostnamesAddCaller,
  type HostnamesGetCaller,
  type HostnamesListCaller,
  type HostnamesPanelMount,
  type HostnamesRemoveCaller,
  type HostnamesUpdateCaller,
  type HostnamesVerifyOwnershipCaller,
  type NetworkLocalUrlsCaller,
} from './hostnames.js';
import {
  mountCustomDomainsPanel,
  type CustomDomainPreflightCaller,
  type CustomDomainReadinessCaller,
  type CustomDomainsPanelMount,
} from './custom-domains.js';
import {
  REACHABILITY_PANEL_STYLES,
  mountReachabilityPanel,
  type ReachabilityExternalProbeCaller,
  type ReachabilityPanelMount,
} from './reachability.js';
import {
  ACCOUNT_BINDING_PANEL_STYLES,
  mountAccountBindingPanel,
  type AccountBindCaller,
  type AccountBindingPanelMount,
  type AccountBindingSessionCaller,
  type AccountBindingStatusCaller,
  type AccountBindingTokenMintCaller,
  type AccountSignOutCaller,
  type AccountUnbindCaller,
  type ProConvenienceStatusCaller,
} from './account-binding-panel.js';
import {
  ARCHIVE_BACKUP_PANEL_STYLES,
  mountArchiveBackupPanel,
  type ArchiveBackupPanelMount,
  type ArchiveExportCaller,
  type ArchiveImportCaller,
  type ArchivePassportExportCaller,
  type ArchiveRebindStashFn,
  type ArchiveStatusCaller,
  type ArchiveDownloadFn,
  type ArchiveUploadFn,
} from './archive-backup-panel.js';
import type { ClearThisBrowserResult } from '../auth/clear-this-browser.js';
import type { CertPinStateWatcher } from '../realtime/cert-pin-state-watcher.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import type { WebclientLocalStore } from '../storage/local-store.js';

// ════════════════════════════════════════════════════════════════
// Element + style attributes
// ════════════════════════════════════════════════════════════════

export const SETTINGS_ROUTE_ROOT_ATTR = 'data-recued-settings-route';
export const SETTINGS_ROUTE_SECTION_ATTR = 'data-recued-settings-section';
export const SETTINGS_ROUTE_STYLES_MARKER = 'data-recued-settings-route-styles';
/** The two-column subview shell — a left-rail nav + the section host.
 *  Settings graduated from a single vertical scroll of every section to
 *  a navigable subview surface (one section visible at a time): the rail
 *  carries one item per mounted section, and clicking an item activates
 *  that section while hiding the rest. Every section stays in the DOM
 *  (CSS toggles visibility off `data-active`) so deep links + the
 *  per-section host accessors keep working without a remount. */
export const SETTINGS_ROUTE_NAV_ATTR = 'data-recued-settings-nav';
/** One nav button per subview. Its value is the subview's section id so
 *  a click maps straight back to the section it reveals + tests can
 *  locate a given rail item. */
export const SETTINGS_ROUTE_NAV_ITEM_ATTR = 'data-recued-settings-nav-item';
/** The scrolling host the section children mount inside (right column). */
export const SETTINGS_ROUTE_VIEWS_ATTR = 'data-recued-settings-views';
/** `true` / `false` on a section + its rail item — the active subview.
 *  Inactive sections collapse via `display:none` (kept in the DOM).
 *  Reused for the in-section sub-tab strip (Privacy / Server) below. */
export const SETTINGS_ROUTE_ACTIVE_ATTR = 'data-active';
/** A section that is itself assembled from several sub-panels (Privacy,
 *  Server) gets an in-section sub-tab strip — the same focused-view
 *  treatment the Housekeeping / AI-Models panels grow internally. The
 *  sub-tab button + its panel both carry the tab id; switching is
 *  in-memory (all panels stay in the DOM, CSS-toggled off
 *  `SETTINGS_ROUTE_ACTIVE_ATTR`). */
export const SETTINGS_ROUTE_SUBTAB_ATTR = 'data-recued-settings-subtab';
export const SETTINGS_ROUTE_SUBTAB_PANEL_ATTR =
  'data-recued-settings-subtab-panel';
export const SETTINGS_ROUTE_CONTRACTS_LINK_ATTR =
  'data-recued-settings-contracts-link';
export const SETTINGS_ROUTE_CONNECTIONS_LINK_ATTR =
  'data-recued-settings-connections-link';
export const SETTINGS_ROUTE_DATA_LINK_ATTR = 'data-recued-settings-data-link';
/** R29 — the Privacy directory list (curated links to each control's real
 *  home) + the folded-in Transparency block. Markers so the host / tests
 *  can assert the directory shape + that Transparency lives inside Privacy
 *  rather than as a standalone rail section. */
export const SETTINGS_ROUTE_PRIVACY_DIRECTORY_ATTR =
  'data-recued-settings-privacy-directory';
export const SETTINGS_ROUTE_PRIVACY_TRANSPARENCY_ATTR =
  'data-recued-settings-privacy-transparency';
/** D-219 slice 9c — the Learning block, folded into Privacy beside
 *  Transparency. Marker so the host / tests can assert it renders there
 *  rather than as its own rail section. */
export const SETTINGS_ROUTE_PRIVACY_LEARNING_ATTR =
  'data-recued-settings-privacy-learning';

// ════════════════════════════════════════════════════════════════
// Options + handle
// ════════════════════════════════════════════════════════════════

export interface BootstrapSettingsRouteOptions {
  /** Element the route's container div is appended to. The route does
   *  NOT stamp attributes on `root` directly (DD#5); only a single
   *  child of `root` carries the route attribute. */
  root: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** Closed-list 5-field local store — forwarded to the Privacy panel. */
  localStore: WebclientLocalStore;
  /** Optional `#settings/<id>` deep-link target. When it matches a rendered
   *  `data-recued-settings-section`, the route scrolls that section into view
   *  once after mount. Unknown / absent ids are a safe no-op. */
  initialSectionId?: string | null;
  /** Optional `#settings/server/<tab>` deep-link target. The requested tab is
   *  activated when it exists; stale or unavailable ids safely fall back to
   *  the first mounted Server tab. */
  initialServerTabId?: string | null;
  /** Optional intent-specific view within AI / Models. The normal settings
   * route stays on `manage`; Chat links to the focused `chat-setup` journey. */
  initialAiModelsView?: AiModelsInitialView | null;
  /** Fired after focused Chat setup has confirmed both required writes. */
  onChatSetupComplete?: () => void;
  /** Exact Chat deep link used by focused setup's return controls. */
  chatSetupReturnHref?: string;
  /** Optional `#settings/seller/<subpage>` selection. Seller validates the
   * closed list and falls back to the Seller directory for a stale segment. */
  initialSellerSubpage?: string | null;
  /** Optional collection record selected by
   * `#settings/seller/<subpage>/detail/<item-id>`. */
  initialSellerItemId?: string | null;
  /** Optional one-based collection page selected by
   * `#settings/seller/<subpage>/page/<n>`. */
  initialSellerPage?: string | number | null;
  /** AES-GCM key store wiper — forwarded to the Privacy panel as
   *  `crypto_keys_wiper`. Production wires `wipeWebclientCryptoKeyStore`
   *  from `webclient-main.ts`; tests inject a counted fake. When
   *  omitted the panel still works but the `done` state's result row
   *  reports `cleared_crypto_keys: false`. */
  cryptoKeysWiper?: () => Promise<void>;
  /** Host lifecycle hook at the exact five-field credential-clear boundary.
   * Used for sibling-tab convergence even if later cleanup is partial. */
  onLocalCredentialsCleared?: () => void;
  /** Reload callback fired when the user clicks "Reload to re-pair"
   *  after a successful clear. Defaults to `globalThis.location.reload`
   *  inside the panel. */
  reloader?: () => void;
  /** Telemetry sink — invoked with the structured result + the
   *  `sw_unregistered` flag after a successful clear. Best-effort: a
   *  throw is swallowed by the panel. */
  onCleared?: (result: ClearThisBrowserResult, sw_unregistered: boolean) => void;
  /** R26.4 Backup & Migration Unification (M1) — `server.archive.export` rpc
   *  caller forwarded to the consolidated Backup & Recovery surface. Production
   *  wires `(args) => conn('server.archive.export', args)`; tests inject a fake.
   *  The surface mounts only when ALL THREE archive callers
   *  (`export`/`status`/`import`) are present — they are the one functional
   *  spine (recovery key is the in-flow gate; the standalone re-verify block is
   *  retired). */
  archiveExportCaller?: ArchiveExportCaller;
  /** R26.4 M1 — `server.archive.status` rpc caller (export poll). See
   *  `archiveExportCaller` for the gate. */
  archiveStatusCaller?: ArchiveStatusCaller;
  /** Boot-scoped archive continuity. A remounted Backup section calls this to
   * reattach to the same start/job without retaining recovery-key material. */
  archiveResumeExportStart?: () => Promise<{ job_id: string }> | null;
  archiveExportSettled?: (jobId?: string) => void;
  /** R26.4 M1 — `server.archive.import` rpc caller (dry-run preview + the Q2
   *  realm-gated destructive restore). See `archiveExportCaller` for the gate. */
  archiveImportCaller?: ArchiveImportCaller;
  /** R26.4 M1 — `passport.export` rpc caller forwarded to the unified surface's
   *  lightweight "Export identity passport only" action (support / audit JSON).
   *  Production wires `(args) => conn('passport.export', args)`; tests inject a
   *  fake. Optional within the surface: when omitted the action is not rendered
   *  (the backup / restore flows still work). The migration use is covered by
   *  the in-archive passport embed, so the paste-import flow is retired. */
  passportExportCaller?: ArchivePassportExportCaller;
  /** M4 — browser archive-download seam forwarded to the backup surface's
   *  export-done view (the Download-to-this-device button). Optional: omitted ⇒
   *  the export stays server-path-only. */
  archiveDownload?: ArchiveDownloadFn;
  /** M4b.2 — browser archive-upload seam forwarded to the backup surface's
   *  restore-entry view (the file picker). Optional: omitted ⇒ restore stays
   *  server-path-only. */
  archiveUpload?: ArchiveUploadFn;
  /** M5 S2b — stash-the-rebind seam forwarded to the backup surface's restore
   *  commit. A committing restore mints this driving client a fresh bearer
   *  (the swap wiped its old row); this re-wraps + persists it so the reconnect
   *  re-pairs seamlessly. Optional: omitted ⇒ the client re-pairs the old way. */
  archiveRebindStash?: ArchiveRebindStashFn;
  /** Slice 111 — `tls.renew` rpc caller forwarded to the Server
   *  section's `mountTlsRenewPanel`. Production wires
   *  `({ reason }) => conn('tls.renew', reason !== undefined ? { reason } : {})`
   *  from the bootstrap's rpc conn; tests inject a fake. When omitted
   *  the Server section is NOT rendered (gated mount; an empty
   *  placeholder would suggest a broken UI). */
  tlsRenewCaller?: TlsRenewCaller;
  /** `tls_domain.list` / `.upload` / `.remove` callers for the Certificates
   *  tab's installed-cert list + BYO upload form.
   *
   *  ⛔ List + upload are ONE gate, not two: a list with no way to add a
   *  certificate is the exact dead end this panel exists to close (a user who
   *  picks "Upload my own certificate" in Hostnames had nowhere to put the
   *  cert). `tlsDomainRemoveCaller` IS independent — a host may wire read +
   *  write without granting removal. */
  tlsDomainListCaller?: TlsDomainListCaller;
  tlsDomainUploadCaller?: TlsDomainUploadCaller;
  tlsDomainRemoveCaller?: TlsDomainRemoveCaller;
  /** Slice 111 — optional `Date.now`-compatible seam forwarded to the
   *  TLS renew panel for deterministic flip-time formatting. */
  now?: () => number;
  /** Slice 111 — invoked after a successful `tls.renew` lands in
   *  `done`. Lets the host refresh the Reachability Doctor's TLS row
   *  + emit telemetry without coupling to the panel internals. */
  onTlsRenewed?: (result: Extract<RotationResult, { ok: true }>) => void;
  /** R26.4 Delta 3 — `key.health` rpc caller forwarded to the Server
   *  section's `mountKeyHealthPanel`. Production wires
   *  `() => conn('key.health', {})`; tests inject a fake. The Key Health
   *  tab mounts only when BOTH `keyHealthLoader` + `keyRotateCaller` are
   *  present (gated mount; mirrors `tlsRenewCaller` discipline). */
  keyHealthLoader?: KeyHealthLoader;
  /** R26.4 Delta 3 — `key.rotate` rpc caller. Production wires
   *  `(req) => conn('key.rotate', req)`; tests inject a fake. See
   *  `keyHealthLoader` for the gate. */
  keyRotateCaller?: KeyRotateCaller;
  /** D-212 §7.10 — `system.status` rpc caller, forwarded to the Key
   *  Health page for its keyfile-posture card. Production wires
   *  `() => conn('system.status', undefined).status`; tests inject a fake.
   *  Independent of the Key Health gate: absent → the page mounts without
   *  the posture card, and a failed read shows on the card rather than
   *  failing the page. */
  systemStatusLoader?: SystemStatusLoader;
  /** R26.2 Delta 1 — Settings → Server → Exposure grid callers. The
   *  Exposure sub-tab mounts only when ALL FOUR are wired (read + three
   *  mutators) — a read-only grid can't toggle, and a toggle-only grid
   *  has no initial state to render. Production wires
   *  `() => conn('exposure.get', undefined)` + the three mutators; tests
   *  inject fakes. A pre-R26.2 server surfaces the rpc error inside the
   *  panel's load-error banner rather than a hard crash. */
  exposureGetCaller?: ExposureGetCaller;
  exposureApplyPresetCaller?: ExposureApplyPresetCaller;
  exposureSetPathResolutionCaller?: ExposureSetPathResolutionCaller;
  exposureSetPublicMcpAckCaller?: ExposureSetPublicMcpAckCaller;
  /** R26.2 Delta 2 — `exposure.set_apex` caller forwarded to the Exposure
   *  grid's apex (`GET /`) picker. Optional: absent ⇒ the picker is
   *  read-only (shows the current mode, radios inert). */
  exposureSetApexCaller?: ExposureSetApexCaller;
  /** R26.2 Delta 1 — optional DDNS-configured probe forwarded to the
   *  Exposure grid. Production derives it from `collection.hostname.list`
   *  (any row with `ddns_managed`). Absent ⇒ the grid treats DDNS as
   *  unconfigured (public presets render disabled with a hint). */
  exposureHasDdnsCaller?: ExposureHasDdnsCaller;
  /** Slice 113 — the cert-pin state watcher feeding the Server
   *  section's "Cert pin rotation pending" overlap panel. The watcher
   *  mirrors `WebclientLocalStore.cert_pin_state` in memory + fans
   *  out transitions via subscribe. When omitted the panel is not
   *  mounted (gated mount; mirrors `tlsRenewCaller` discipline). The
   *  bootstrap composes the watcher between the cert-pin handler +
   *  the Settings route so a `cert.rotation_notice` broadcast lands
   *  in the watcher before any Settings render reads its state. */
  certPinWatcher?: CertPinStateWatcher;
  /** D-156 P5 — `pair.list` rpc caller forwarded to the Devices
   *  section's roster mount. Production wires
   *  `() => conn('pair.list', undefined)` from the bootstrap's rpc
   *  conn; tests inject a fake. Both this AND `pairRevokeCaller` must
   *  be supplied for the Devices section to render (post-D-156 P8 the
   *  section has no other surfaces). */
  pairListCaller?: PairListCaller;
  /** D-156 P5 — `pair.revoke` rpc caller forwarded to the Devices
   *  section's new roster mount. Production wires
   *  `(args) => conn('pair.revoke', args)` from the bootstrap's rpc
   *  conn; tests inject a fake. See `pairListCaller` for the gate. */
  pairRevokeCaller?: PairRevokeCaller;
  /** D-156 P5 — the locally-known instance id for this client. When
   *  supplied, the matching row in `pair.list` results renders as
   *  "This device" + denies its own Revoke button (self-revoke
   *  blocked per spec § Behaviour rules). Optional — when absent
   *  every row renders a Revoke button (the renderer is the only
   *  enforcer of self-revoke, so the caller MUST supply this when
   *  the surface knows it). */
  currentInstanceId?: string;
  /** D-156 P5 — best-effort failure sink for the devices-page mount's
   *  `pair.list` rpc. Defaults to no-op. */
  onDevicesListError?: (err: Error) => void;
  /** D-163 Slice C — `notifications.describe` rpc caller forwarded to
   *  the Notifications section's panel. Production wires
   *  `() => conn('notifications.describe', undefined)` from the
   *  bootstrap's rpc conn; tests inject a fake. Both this AND
   *  `notificationsSetChannelCaller` must be supplied for the section
   *  to render — the panel's read-list + toggle surface depends on
   *  both. Test environments / pre-D-163-Slice-C server builds that
   *  omit either skip the section rather than mount a broken UI. */
  notificationsDescribeCaller?: NotificationsDescribeCaller;
  /** D-163 Slice C — `notifications.set_channel` rpc caller forwarded
   *  to the Notifications section's panel for per-row toggle.
   *  Production wires `(args) => conn('notifications.set_channel', args)`;
   *  tests inject a fake. See `notificationsDescribeCaller` for the
   *  gate. */
  notificationsSetChannelCaller?: NotificationsSetChannelCaller;
  /** D-169 P1 — `notifications.describe_bridges` rpc caller forwarded
   *  to the Notifications section's panel for the per-bridge sub-row
   *  group. Optional; when omitted the bridge channel row renders
   *  without a sub-row group (legacy pre-D-169 layout). Production
   *  wires `() => conn('notifications.describe_bridges', undefined)`;
   *  tests inject a fake. */
  notificationsDescribeBridgesCaller?: NotificationsDescribeBridgesCaller;
  /** D-169 P1 — `notifications.set_bridge_mode` rpc caller forwarded
   *  to the Notifications section's panel for per-bridge mode toggles.
   *  Optional; required when `notificationsDescribeBridgesCaller` is
   *  present (the panel surfaces interactive rows). */
  notificationsSetBridgeModeCaller?: NotificationsSetBridgeModeCaller;
  /** R31 — `notifications.set_verification_phrase` rpc caller forwarded
   *  to the panel for the anti-phishing phrase field. Optional; absent ⇒
   *  the phrase field renders read-only. */
  notificationsSetVerificationPhraseCaller?: NotificationsSetVerificationPhraseCaller;
  // D-187 §6 follow-on — Packs graduated out of Settings into the top-level
  // `#packs` route (`packs/bootstrap-packs-route.ts`). The packs.* +
  // cli.reachability callers + the install-time cli grant dialog moved with
  // it; the roster-wide Local tools grid was later deleted there.
  /** D-174 D14 — Settings -> AI / Models model-preference read/write.
   *  These are independently optional so tests can mount honest pending
   *  controls when a server seam is absent. */
  aiModelsDefaultModelPrefGetCaller?: ChatDefaultModelPrefGetCaller;
  aiModelsDefaultModelPrefSetCaller?: ChatDefaultModelPrefSetCaller;
  /** D-174 D14 — server LLM config read (`server.getLLMConfig`) for BYOK
   *  slots + free pool. */
  aiModelsGetLLMConfigCaller?: AiModelsLlmConfigGetCaller;
  /** D-174 R28 — field-level LLM config writes (one slot / pool entry per
   *  call) so concurrent edits don't clobber the whole config blob. */
  aiModelsSetLLMSlotCaller?: AiModelsLlmSlotSetCaller;
  aiModelsSetEmbeddingsSlotCaller?: AiModelsEmbeddingsSlotSetCaller;
  aiModelsUpsertFreePoolEntryCaller?: AiModelsFreePoolEntryUpsertCaller;
  aiModelsRemoveFreePoolEntryCaller?: AiModelsFreePoolEntryRemoveCaller;
  aiModelsSetFreePoolEntryEnabledCaller?: AiModelsFreePoolEntryEnabledCaller;
  /** Lever-2 per-slot (Phase 3) — field-level `server.setChatCatalogMode`
   *  write (one LLM source's catalog delivery mode / clear). Optional; the
   *  per-source catalog `<select>` renders only when this is wired. */
  aiModelsSetChatCatalogModeCaller?: AiModelsSetChatCatalogModeCaller;
  aiModelsGetLlmPromptsCaller?: AiModelsLlmPromptsGetCaller;
  aiModelsSetLlmPromptCaller?: AiModelsLlmPromptSetCaller;
  /** D-174 D14 — scalar config schema (`server.getConfigSchema` /
   *  `server.setConfigField`) for `llm.budget`. */
  aiModelsGetConfigSchemaCaller?: AiModelsConfigSchemaGetCaller;
  aiModelsSetConfigFieldCaller?: AiModelsConfigFieldSetCaller;
  /** D-174 D14 — housekeeping AI policy controls
   *  (`housekeeping.config.{read,write}`) for allow-BYOK-background +
   *  Pause-AI. */
  aiModelsHousekeepingConfigReadCaller?: AiModelsHousekeepingConfigReadCaller;
  aiModelsHousekeepingConfigWriteCaller?: AiModelsHousekeepingConfigWriteCaller;
  /** D-196 S2 — Settings -> Seller overview. Production wires
   *  `server.seller.getOverview`; narrowed/test hosts may omit it to hide the
   *  section. */
  sellerOverviewCaller?: SellerOverviewCaller;
  /** D-207 order-is-the-lifecycle — owner Orders view. Production wires
   *  `server.seller.listOrders`; absent hides the Orders section. */
  sellerOrdersCaller?: SellerListOrdersCaller;
  /** D-196 1d — the GENERIC `execute` rpc caller, shared with the Recipes route.
   *  The Seller page uses it to run an owner-attended recovery recipe from an
   *  order row, so a new owner action costs a recipe rather than a new rpc.
   *  Absent hides the row action. */
  recipeExecuteCaller?: SellerRecipeRunCaller;
  /** D-200 Slice 6e — owner-only outcome-offer state transition. */
  sellerOfferStateTransitionCaller?: SellerOfferStateTransitionCaller;
  /** D-196 §4.7 — send-capable mail instances for the explicit Seller
   *  sender chooser. Optional so older paired servers degrade honestly. */
  sellerMailListCaller?: SellerMailListCaller;
  /** D-196 S2 — owner-authored seller settings knobs. Optional so older
   *  paired servers can keep the Seller page read-only. */
  sellerSettingsUpdateCaller?: SellerSettingsUpdateCaller;
  /** D-196 S2 — owner-authored manual tier create/update. Optional so older
   *  paired servers can still mount the Seller section read-only. */
  sellerManualTierUpsertCaller?: SellerManualTierUpsertCaller;
  sellerCreatePassTierCaller?: SellerCreatePassTierCaller;
  /** D-196 S2 — owner-authored manual customer issue. Optional so older
   *  paired servers can still mount the Seller section without customer writes. */
  sellerManualCustomerIssueCaller?: SellerManualCustomerIssueCaller;
  /** D-196 S2 — owner-authored manual customer lifecycle updates. Optional and
   *  independently wired so paired servers can expose only supported actions. */
  sellerManualCustomerExtendCaller?: SellerManualCustomerExtendCaller;
  sellerManualCustomerSwapTierCaller?: SellerManualCustomerSwapTierCaller;
  sellerManualCustomerCloseCaller?: SellerManualCustomerCloseCaller;
  sellerManualCustomerReissueTokenCaller?: SellerManualCustomerReissueTokenCaller;
  sellerManualTierBulkAdjustCaller?: SellerManualTierBulkAdjustCaller;
  /** D-196 S4 — owner-clicked Stripe entitlement Initialize/Synchronize. */
  sellerStripeSynchronizeCaller?: SellerStripeSynchronizeCaller;
  /** D-196 §4.9 / I-7 — owner-clicked one-time paid-`llm_gateway` route-rights
   *  acknowledgment. Optional so older paired servers keep the gateway read-only. */
  sellerAcknowledgeLlmGatewayPaidCaller?: SellerAcknowledgeLlmGatewayPaidCaller;
  /** D-178 — Settings → Updates. The five `update.*` rpc callers; the section
   *  mounts when at least `updateCheckCaller` is present. */
  updateCheckCaller?: UpdateCheckCaller;
  updateModeGetCaller?: UpdateModeGetCaller;
  updateModeSetCaller?: UpdateModeSetCaller;
  updateApplyCaller?: UpdateApplyCaller;
  updateRollbackCaller?: UpdateRollbackCaller;
  /** Exact, secret-free return path from a required server update to the
   * credential-replacement preflight that requested it. */
  credentialRotationServerUpdateContinuity?:
    MountUpdatesPageOptions['credentialRotationServerUpdateContinuity'];
  serverUpdateTabConvergence?:
    MountUpdatesPageOptions['serverUpdateTabConvergence'];
  serverConnectionStatus?: MountUpdatesPageOptions['serverConnectionStatus'];
  serverUpdateReceiptVerification?:
    MountUpdatesPageOptions['serverUpdateReceiptVerification'];
  serverUpdateReceiptDiagnosticContext?:
    MountUpdatesPageOptions['serverUpdateReceiptDiagnosticContext'];
  serverUpdateReceiptDiagnosticWriter?:
    MountUpdatesPageOptions['serverUpdateReceiptDiagnosticWriter'];
  onReturnToCredentialRotationRetry?:
    MountUpdatesPageOptions['onReturnToCredentialRotationRetry'];
  /** Periodic availability re-check scheduler (returns a cancel fn) + interval.
   *  Production wires a `setInterval` wrapper; omit → check-on-mount only. */
  updatesStartPoll?: (cb: () => void, ms: number) => () => void;
  updatesPollIntervalMs?: number;
  /** D-145 PA11 — `housekeeping.cache.stats` rpc caller forwarded to
   *  the AI / Models section's "LLM result cache" card. Production wires
   *  `() => conn('housekeeping.cache.stats', undefined)` from the
   *  bootstrap's rpc conn; tests inject a fake. When omitted the card
   *  is NOT mounted (the card serves no purpose without a way to
   *  read its stats; mirrors the `tlsRenewCaller` gate discipline). */
  housekeepingCacheStatsCaller?: LlmResultCacheStatsCaller;
  /** D-145 PA11 — `housekeeping.cache.clear` rpc caller forwarded to
   *  the AI / Models section's "LLM result cache" card. Production wires
   *  `() => conn('housekeeping.cache.clear', undefined)`; tests
   *  inject a fake. Independently optional from
   *  `housekeepingCacheStatsCaller` — a stats-only mount surfaces the
   *  card read-only (Clear button hidden). */
  housekeepingCacheClearCaller?: LlmResultCacheClearCaller;
  /** D-145 § B.8.9 — Settings → Transparency panel callers (`prefs.get`
   *  / `prefs.set` pair rpc carrying the `ui.transparency.*` keys). The
   *  section mounts only when BOTH are wired — the panel serves no
   *  purpose read-only (the chat surface already renders the effective
   *  policy). */
  transparencyPrefsGetCaller?: TransparencyPrefsGetCaller;
  transparencyPrefsSetCaller?: TransparencyPrefsSetCaller;
  /** D-219 slice 9c — Settings → Learning panel callers (the same
   *  `prefs.get` / `prefs.set` pair rpc, carrying
   *  `chat.execution_case_offer`). Separate seams from the Transparency
   *  pair by the same DD#1 discipline: one panel, one caller pair, so a
   *  test can drive either in isolation. Mounts only when BOTH are
   *  wired — a read-only view of a single toggle serves no purpose. */
  learningPrefsGetCaller?: LearningPrefsGetCaller;
  /** D-219 item 2 — wired as a pair with `learningCaseForgetCaller`. */
  learningCasesListCaller?: LearningCasesListCaller;
  learningCaseForgetCaller?: LearningCaseForgetCaller;
  /** D-219 item 2b — wired as a pair with `onLearningDraftReady`. */
  learningDraftRecipeCaller?: LearningDraftRecipeCaller;
  /** ⛔ Returns FALSE when the hand-off could not be completed (no storage, a
   *  full quota) — the panel then says so instead of clearing a draft the
   *  owner just paid for. Declared `void` here once, which type-erased that
   *  contract at the one seam it crosses: the host still returned a boolean
   *  and the panel still read it, so nothing broke, but the signature said the
   *  answer was ignored. */
  onLearningDraftReady?: (draft: {
    case_id: string;
    recipe: unknown;
    request_aliased: boolean;
  }) => boolean | void;
  learningDraftConfirmation?: string;
  learningPrefsSetCaller?: LearningPrefsSetCaller;
  /** D-132/D-133 — Settings → Housekeeping trust-panel callers. The
   *  panel mounts only when the four read/write seams below are all
   *  wired (config read+write, status read, trust read); Run-now +
   *  trust write are independently optional (absent → those picks are
   *  no-ops, read-only trust view). */
  housekeepingPanelConfigReadCaller?: HousekeepingConfigReadCaller;
  housekeepingPanelConfigWriteCaller?: HousekeepingConfigWriteCaller;
  housekeepingPanelStatusReadCaller?: HousekeepingStatusReadCaller;
  housekeepingPanelTrustReadCaller?: HousekeepingTrustReadCaller;
  housekeepingPanelRunNowCaller?: HousekeepingRunNowCaller;
  /** `server.getStatus` — the per-surface storage read-out rendered on
   *  Server ▸ Maintenance. Optional; omitted → no Storage section. */
  maintenanceServerStatusCaller?: () => Promise<{
    pressure_details?: import('@recued/contracts').PressureDetails;
  }>;
  /** `server.runPressureReclaim` — the per-surface Reclaim now action.
   *  Optional; omitted → the storage rows render read-only. */
  maintenanceReclaimCaller?: (args: { surface: string; force?: boolean }) =>
    Promise<{ ran: boolean; bytes_freed: number }>;
  housekeepingPanelTrustWriteCaller?: HousekeepingTrustWriteCaller;
  /** D-132/D-133/D-136 Commit 2 — promotion banner Don't-ask-again
   *  (`housekeeping.trust.dismiss_promotion`), coverage panel
   *  (`housekeeping.registry.describe`), and the destructive topic-reset
   *  flow (`housekeeping.topic.reset`). Each surface stays gated on its
   *  caller / data feed so an unwired seam renders nothing (no dead
   *  buttons): the reset drawer section only shows when
   *  `housekeepingPanelTopicResetCaller` is wired; the coverage panel
   *  only shows when `registry.describe` populated. The promotion
   *  banner's Promote reuses the trust-write caller above. R25 removed
   *  the per-topic MCP-visibility override (exposure is per-contract in
   *  Contracts now). */
  housekeepingPanelDismissPromotionCaller?: HousekeepingDismissPromotionCaller;
  housekeepingPanelRegistryDescribeCaller?: HousekeepingRegistryDescribeCaller;
  housekeepingPanelTopicResetCaller?: HousekeepingTopicResetCaller;
  /** D-152 P6 — `collection.hostname.list` rpc caller forwarded to the
   *  Server section's Hostnames panel. Production wires
   *  `() => conn('collection.hostname.list', undefined)`. The Hostnames panel
   *  mounts only when the full registry CRUD/proof caller group is supplied:
   *  list + get + add + update + remove + verifyOwnership. */
  hostnamesListCaller?: HostnamesListCaller;
  /** D-152 P6 — `collection.hostname.get` rpc caller for row detail. Required
   *  alongside the rest of the Hostnames panel caller group. */
  hostnamesGetCaller?: HostnamesGetCaller;
  /** D-152 P6 — `collection.hostname.add` rpc caller. Required alongside the
   *  rest of the Hostnames panel caller group. */
  hostnamesAddCaller?: HostnamesAddCaller;
  /** D-152 P6 — `collection.hostname.update` rpc caller. Required alongside the
   *  rest of the Hostnames panel caller group. */
  hostnamesUpdateCaller?: HostnamesUpdateCaller;
  /** D-152 P6 — `collection.hostname.remove` rpc caller. Required alongside the
   *  rest of the Hostnames panel caller group. */
  hostnamesRemoveCaller?: HostnamesRemoveCaller;
  /** D-152 P6 — `collection.hostname.verifyOwnership` rpc caller. Required
   *  alongside the rest of the Hostnames panel caller group. */
  hostnamesVerifyOwnershipCaller?: HostnamesVerifyOwnershipCaller;
  /** D-235 P5 — Settings → Server → Domains. Independent of the hostname-CRUD
   *  bundle: checking DNS needs no write capability, so the diagnostics stay
   *  available even on a surface where the CRUD callers are gated off. */
  customDomainPreflightCaller?: CustomDomainPreflightCaller;
  customDomainReadinessCaller?: CustomDomainReadinessCaller;
  /** LAN-URL kickstart (slice 2) — `network.local_urls` rpc caller for the
   *  Hostnames panel's read-only "Reachable on your network" section. Forwarded
   *  independently of the hostname CRUD caller group (the section is a separate
   *  read); absent → the section is not rendered. */
  networkLocalUrlsCaller?: NetworkLocalUrlsCaller;
  /** R27 delta-B — Pro DDNS pause/resume rpc callers for the Hostnames panel's
   *  "Pro web address (DDNS)" control. The route composes the gate context
   *  (published / hostname / self-connected) from `accountProConvenienceStatusCaller`
   *  + `localStore`; absent (either caller, or no pro-convenience caller) → no
   *  Pro DDNS section. */
  ddnsStatusCaller?: DdnsStatusCaller;
  ddnsSetEnabledCaller?: DdnsSetEnabledCaller;
  /** M-REACH-4 — Settings → Server Reachability Doctor. The panel mounts
   *  when either an initial report or an external-probe caller is supplied.
   *  `reachabilityExternalProbeCaller` is the front-door button seam; production
   *  wires it to the free `/v1/diagnostics/probe` cloud worker. */
  reachabilityReport?: ReachabilityReport;
  reachabilityExternalProbeCaller?: ReachabilityExternalProbeCaller;
  /** D-174/D-175 — Settings -> Account binding touchpoint. These callers
   *  mount the recued.com account section when the full pair-RPC group plus
   *  the auth-Worker binding-token mint seam are supplied. A pre-D-175 server
   *  surfaces `not_configured` / unknown-method errors inside the panel. */
  accountBindingStatusCaller?: AccountBindingStatusCaller;
  accountBindCaller?: AccountBindCaller;
  accountUnbindCaller?: AccountUnbindCaller;
  accountProConvenienceStatusCaller?: ProConvenienceStatusCaller;
  accountBindingTokenMintCaller?: AccountBindingTokenMintCaller;
  accountBindingSessionCaller?: AccountBindingSessionCaller;
  accountSignOutCaller?: AccountSignOutCaller;
  accountDashboardUrl?: string;
  /** D-145 PA11 follow-on — broadcast subscription seam, forwarded to
   *  every panel that wires a live refresh. Today's consumers:
   *    - LLM result cache card → `housekeeping_cycle` filtered on
   *      `LLM_RESULT_CACHE_GC_TASK_ID` (PA11 cache card commit
   *      `8494a261`).
   *    - Notifications panel (D-169 P2 Slice 4 follow-on) →
   *      `notification.bridge_mode_changed` (splices the inline
   *      post-change modes into the matching per-bridge row; only active
   *      when the bridge-roster callers are also wired).
   *  Production wires `subscriber.on` from the bootstrap's
   *  `createBroadcastSubscriber()`; tests inject a fake. Optional —
   *  omitting keeps every consumer on its post-mutation auto-refresh
   *  cadence. Future Settings mounts can take the same handle off
   *  `opts.subscribe`. */
  subscribe?: BroadcastSubscriber['on'];
}

export interface SettingsRoute {
  /** Re-render hook. The v1 route has no per-broadcast update path;
   *  the method is a no-op so the handle satisfies the bootstrap's
   *  `{ update?, dispose }` route-handle contract uniformly. */
  update(): void;
  /** Tear down the route's DOM + every mounted section panel. Idempotent. */
  dispose(): void;
  /** User-started Settings work whose outcome is not known yet. This includes
   * multi-step local cleanup and server jobs that outlive their initial RPC. */
  hasInFlightWork(): boolean;
  /** Unsaved child-panel drafts or unsettled Settings writes that should be
   * acknowledged before the shell tears this route down. */
  hasUnsavedChanges(): boolean;
  /** Contextual copy for the shell's shared leave guard. */
  unsavedChangesPrompt(): string | null;
  /** Opts user-started Settings writes into the shell's in-flight leave
   * guard without misclassifying them as unsaved drafts. */
  inFlightWorkPrompt(): string | null;
  /** Expose the "This browser" clear-local-data panel mount for host /
   *  test introspection (DD#4). The Privacy section is a directory now;
   *  this is the one disposable local panel it hosts. */
  clearThisBrowserPanel(): ClearThisBrowserPanelMount;
  /** Slice 111 — expose the Server section's TLS renew panel mount.
   *  Returns `null` when the section was not mounted (i.e. the
   *  bootstrap omitted `tlsRenewCaller`). Tests use this to drive the
   *  TLS renew button without reaching into the route's internal DOM;
   *  hosts use it to wire telemetry sinks post-mount. */
  tlsRenewPanel(): TlsRenewPanelMount | null;
  /** Expose the Certificates tab's installed-cert list + BYO upload panel.
   *  Returns `null` when the bootstrap omitted `tlsDomainListCaller` /
   *  `tlsDomainUploadCaller`. Tests drive the upload flow through it. */
  tlsCertificatesPanel(): TlsCertificatesPanelMount | null;
  /** R26.4 Delta 3 — expose the Server section's Key Health panel mount.
   *  Returns `null` when the bootstrap omitted `keyHealthLoader` /
   *  `keyRotateCaller`. Tests drive the rotation flow through it without
   *  reaching into the route's DOM. */
  keyHealthPanel(): KeyHealthPanelMount | null;
  /** R26.2 Delta 1 — expose the Server section's Exposure grid mount.
   *  Returns `null` when the bootstrap omitted any of the four exposure
   *  callers. Tests drive the preset / grid / modal flows through it. */
  exposurePanel(): ExposurePanelMount | null;
  /** Slice 113 — expose the Server section's cert-pin overlap panel
   *  mount. Returns `null` when the bootstrap omitted
   *  `certPinWatcher`. Tests use this to read view-state without
   *  parsing DOM; hosts use it to drive `update()` against a
   *  polling timer if one is wired later. */
  certPinStalePanel(): CertPinStalePanelMount | null;
  /** D-156 P5 — expose the Devices section's roster mount. Returns
   *  `null` when the bootstrap omitted `pairListCaller` or
   *  `pairRevokeCaller`. Tests use this to drive the inline
   *  two-stage revoke + observe roster transitions; hosts use it to
   *  call `refresh()` after a server-side roster mutation lands via
   *  some future broadcast subscriber. */
  devicesPage(): DevicesPageMount | null;
  /** D-163 Slice C — expose the Notifications section's panel mount.
   *  Returns `null` when the bootstrap omitted
   *  `notificationsDescribeCaller` or `notificationsSetChannelCaller`.
   *  Tests use this to read panel state + drive the per-row toggle;
   *  hosts can use it to trigger a refresh after a
   *  `connection.notification.*` enrolment lands so the readiness state
   *  flips without forcing a reload. */
  notificationsPanel(): NotificationsPanelMount | null;
  // D-187 §6 follow-on — `packsPanel()` / `localToolsPanel()` / `cliGrantDialog()`
  // accessors moved to the `#packs` route (`PacksRoute`).
  /** D-174 P3 — legacy accessor for the former Settings Connections enrollment
   *  panel. Returns `null`; list/add/edit/delete/probe now mount under the
   *  top-level `#connections` route. */
  connectionsEnrollPanel(): ConnectionsEnrollPanelMount | null;
  /** D-174 P2.1 — legacy accessor for the former Settings permissions panel.
   *  Returns `null`; the MCP credential and override editor now mount under
   *  the top-level `#contracts` route. */
  permissionsPanel(): PermissionsPanelMount | null;
  /** D-174 P2.1 — legacy accessor for the former Settings contracts inspector.
   *  Returns `null`; the inventory now mounts under the top-level `#contracts`
   *  route. */
  contractsPanel(): ContractsPanelMount | null;
  /** D-174 D14 — expose the Settings -> AI / Models page mount. */
  aiModelsPage(): AiModelsPageMount | null;
  /** D-196 S2 — expose the Settings -> Seller overview mount. */
  sellerPage(): SellerPageMount | null;
  updatesPage(): UpdatesPageMount | null;
  /** D-145 § B.8.9 — expose the Transparency section's panel mount.
   *  Returns `null` when the bootstrap omitted either prefs caller.
   *  Tests use this to read panel state + drive the toggles; the chat
   *  surface picks the change up on its next mount via `prefs.get`. */
  transparencyPanel(): TransparencyPanelMount | null;
  /** D-219 slice 9c — expose the Learning section's panel mount. Returns
   *  `null` when the bootstrap omitted either prefs caller. */
  learningPanel(): LearningPanelMount | null;
  /** D-145 PA11 — expose the AI / Models section's "LLM result cache" card
   *  mount. Returns `null` when the bootstrap omitted
   *  `housekeepingCacheStatsCaller`. Tests use this to read snapshot
   *  state + drive the Clear flow; hosts can use it to trigger
   *  `refresh()` after a `housekeeping_cache_clear` audit broadcast
   *  lands via some future broadcast subscriber. */
  llmResultCacheCard(): LlmResultCacheCardMount | null;
  /** D-152 P6 — expose the Server section's Hostnames panel mount. Returns
   *  `null` when the bootstrap omitted any of the hostname CRUD/proof callers. */
  hostnamesPanel(): HostnamesPanelMount | null;
  /** M-REACH-4 — expose the Server section's Reachability Doctor mount. Returns
   *  `null` when neither a report nor an external probe caller was supplied. */
  reachabilityPanel(): ReachabilityPanelMount | null;
  /** D-174/D-175 — expose the Settings -> Account binding panel. Returns
   *  `null` when the bootstrap omitted the binding caller group. */
  accountBindingPanel(): AccountBindingPanelMount | null;
  /** R26.4 Backup & Migration Unification (M1) — the consolidated Backup &
   *  Recovery surface (export + restore + the standalone passport-export
   *  action), or null when the bootstrap omitted any of the three
   *  `archive*Caller`s. Tests drive every flow through this. */
  archiveBackupPanel(): ArchiveBackupPanelMount | null;
}

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

/** Self-scoped CSS for the route's root container + section headers.
 *  The Privacy panel's own styles are injected alongside this in the
 *  same marker-guarded `<style>` tag (DD#3). */
export const SETTINGS_ROUTE_STYLES = `
[${SETTINGS_ROUTE_ROOT_ATTR}] {
  padding: 24px;
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  font-size: 13px;
  color: var(--fg);
}
[${SETTINGS_ROUTE_ROOT_ATTR}] > h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--accent);
}
/* Two-column subview shell — sticky rail + scrolling section host. */
[${SETTINGS_ROUTE_ROOT_ATTR}] .settings-shell {
  display: grid;
  grid-template-columns: minmax(168px, 200px) minmax(0, 1fr);
  gap: 28px;
  align-items: start;
}
[${SETTINGS_ROUTE_NAV_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  position: sticky;
  top: 16px;
}
[${SETTINGS_ROUTE_NAV_ITEM_ATTR}] {
  box-sizing: border-box;
  min-height: 36px;
  appearance: none;
  border: 0;
  background: transparent;
  text-align: left;
  font: inherit;
  font-size: 13px;
  color: var(--muted);
  padding: 7px 10px;
  border-radius: var(--wc-radius, 6px);
  cursor: pointer;
  box-shadow: inset 2px 0 0 transparent;
  transition: background 80ms ease, color 80ms ease;
}
[${SETTINGS_ROUTE_NAV_ITEM_ATTR}]:hover {
  background: var(--surface-sunk);
  color: var(--fg);
}
[${SETTINGS_ROUTE_NAV_ITEM_ATTR}][${SETTINGS_ROUTE_ACTIVE_ATTR}="true"] {
  background: var(--surface-sunk);
  color: var(--fg);
  font-weight: 600;
  box-shadow: inset 2px 0 0 var(--accent);
}
[${SETTINGS_ROUTE_NAV_ITEM_ATTR}]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${SETTINGS_ROUTE_NAV_ITEM_ATTR}] .settings-nav-badge {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 6px;
  border-radius: 50%;
  background: var(--accent);
  vertical-align: middle;
}
[${SETTINGS_ROUTE_NAV_ITEM_ATTR}] .settings-nav-badge[hidden] {
  display: none;
}
[${SETTINGS_ROUTE_VIEWS_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
}
[${SETTINGS_ROUTE_SECTION_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
[${SETTINGS_ROUTE_SECTION_ATTR}][${SETTINGS_ROUTE_ACTIVE_ATTR}="false"] {
  display: none;
}
[${SETTINGS_ROUTE_SECTION_ATTR}] > h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
/* Mobile: rail collapses to a horizontal scroll strip above the host. */
@media (max-width: 720px) {
  [${SETTINGS_ROUTE_ROOT_ATTR}] .settings-shell {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  [${SETTINGS_ROUTE_NAV_ATTR}] {
    position: static;
    flex-direction: row;
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 4px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }
  [${SETTINGS_ROUTE_NAV_ITEM_ATTR}] {
    white-space: nowrap;
    box-shadow: none;
  }
  [${SETTINGS_ROUTE_NAV_ITEM_ATTR}][${SETTINGS_ROUTE_ACTIVE_ATTR}="true"] {
    box-shadow: inset 0 -2px 0 var(--accent);
  }
}
/* R29 — Privacy directory: framing + a card list linking out to each
   control's real home. */
.privacy-intro {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.privacy-intro p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted);
}
.privacy-directory {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.privacy-directory > li {
  margin: 0;
}
.privacy-directory a {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  text-decoration: none;
  color: inherit;
}
.privacy-directory a:hover {
  border-color: var(--accent);
  text-decoration: none;
}
.privacy-directory-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
}
.privacy-directory-detail {
  font-size: 12px;
  color: var(--muted);
}
/* In-section sub-tab strip (Privacy / Server) — underline-active, same
   language as the Housekeeping / AI-Models panel tabs. */
[${SETTINGS_ROUTE_ROOT_ATTR}] .settings-subtabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 2px;
}
[${SETTINGS_ROUTE_ROOT_ATTR}] .settings-subtab {
  box-sizing: border-box;
  min-height: 36px;
  appearance: none;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  font: inherit;
  font-size: 13px;
  color: var(--muted);
  padding: 7px 10px;
  margin: 0 0 -1px;
  cursor: pointer;
}
[${SETTINGS_ROUTE_ROOT_ATTR}] .settings-subtab:hover { color: var(--fg); }
[${SETTINGS_ROUTE_ROOT_ATTR}] .settings-subtab[${SETTINGS_ROUTE_ACTIVE_ATTR}="true"] {
  color: var(--fg);
  font-weight: 600;
  border-bottom-color: var(--accent);
}
[${SETTINGS_ROUTE_ROOT_ATTR}] .settings-subtab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
[${SETTINGS_ROUTE_ROOT_ATTR}] .settings-subtabpanel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
[${SETTINGS_ROUTE_ROOT_ATTR}] .settings-subtabpanel[${SETTINGS_ROUTE_ACTIVE_ATTR}="false"] {
  display: none;
}
`;

/** A mounted subview: its section element + the rail label to show. The
 *  `id` matches the section's `SETTINGS_ROUTE_SECTION_ATTR` value and is
 *  what the rail item + the `#settings/<id>` deep-link resolve against. */
interface SettingsSubview {
  id: string;
  label: string;
  section: HTMLElement;
  /** When true, the rail item carries a hidden badge dot the route toggles via
   *  `setSubviewBadge(id, on)` (D-178 — the "update available" indicator). */
  badgeable?: boolean;
}

// ════════════════════════════════════════════════════════════════
// bootstrapSettingsRoute
// ════════════════════════════════════════════════════════════════

/** Build the Settings route DOM, mount the Privacy panel inside it,
 *  and return the route handle. Idempotent style injection means a
 *  re-bootstrap on the same document (route flip → flip back) does
 *  not stack `<style>` tags. */
export const bootstrapSettingsRoute = (
  opts: BootstrapSettingsRouteOptions,
): SettingsRoute => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapSettingsRoute: no document available — pass `opts.document` for non-browser environments',
    );
  }

  // ── Idempotent style injection (DD#3) ────────────────────────────
  // Codex slice-110 P2 fold — `PRIMITIVE_STYLES` ships the `.rx-btn*`
  // base classes the panel's danger / primary / secondary buttons
  // depend on. Pre-fold a direct `#settings` load (e.g. bookmark)
  // never reached `bootstrapReceptionRoute`, so the buttons rendered
  // with native styling until the user manually navigated to
  // Reception first. The bundle now ships the primitives alongside
  // the route's own CSS + the panel CSS so a cold load is fully
  // styled. Order mirrors `reception-bootstrap.ts`: primitives first,
  // route override styles next, panel styles last.
  if (
    doc.head.querySelector(`style[${SETTINGS_ROUTE_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(SETTINGS_ROUTE_STYLES_MARKER, '');
    // Slice 111 — `TLS_RENEW_PANEL_STYLES` joins the bundle so a cold
    // `#settings` load renders the Server section panel fully styled.
    // Same `:empty`-marker discipline as the rest of the bundle: the
    // selectors scope to `[data-recued-tls-renew-panel]`, so the rules
    // are inert when the bootstrap omits `tlsRenewCaller` + the Server
    // section never mounts.
    // Slice 113 — `CERT_PIN_STALE_PANEL_STYLES` joins the bundle so a
    // cold `#settings` load renders the cert-pin overlap panel fully
    // styled. Selectors scope to `[data-recued-cert-pin-stale-panel]`,
    // so the rules are inert when the bootstrap omits `certPinWatcher`
    // + the panel never mounts.
    // D-163 Slice C — `NOTIFICATIONS_PANEL_STYLES` joins the bundle so
    // a cold `#settings` load renders the Notifications section fully
    // styled. Selectors scope to `[data-recued-notifications-panel]`,
    // so the rules are inert when the bootstrap omits the
    // notifications callers + the section never mounts.
    style.textContent = [
      PRIMITIVE_STYLES,
      SETTINGS_ROUTE_STYLES,
      // D-156 P5 — the Devices roster table renderer ships no CSS of its
      // own; bundle the mount's table + revoke-confirm styles so a cold
      // `#settings` load renders the Devices section carded + token-aligned
      // (selectors are `.account-devices-*`, inert when the section is
      // unmounted).
      DEVICES_PAGE_STYLES,
      CLEAR_THIS_BROWSER_PANEL_STYLES,
      TLS_RENEW_PANEL_STYLES,
      // The installed-cert list + BYO upload form. Selectors scope to
      // `[data-recued-tls-certs-panel]`, so the rules are inert when the
      // bootstrap omits the `tls_domain.*` callers + the panel never mounts.
      TLS_CERTIFICATES_PANEL_STYLES,
      // R26.2 Delta 1 — `EXPOSURE_PANEL_STYLES` joins the bundle so a cold
      // `#settings/server` load renders the Exposure grid fully styled.
      // Selectors scope to `[data-recued-exposure-panel]`, so the rules are
      // inert when the bootstrap omits the exposure callers + the sub-tab
      // never mounts.
      EXPOSURE_PANEL_STYLES,
      // R26.4 Delta 3 — `KEY_HEALTH_PANEL_STYLES` joins the bundle so a
      // cold `#settings` load renders the Server → Key Health page
      // styled. Selectors scope to `[data-recued-key-health-panel]`, so
      // the rules are inert when the bootstrap omits the key.* callers +
      // the page never mounts.
      KEY_HEALTH_PANEL_STYLES,
      CERT_PIN_STALE_PANEL_STYLES,
      NOTIFICATIONS_PANEL_STYLES,
      // D-187 §6 follow-on — PACKS_PANEL_STYLES / INSTALL_GRANT_PICKER_STYLES /
      // CLI_GRANT_DIALOG_STYLES moved to the `#packs` route bundle
      // (`PACKS_ROUTE_STYLES`). LOCAL_TOOLS_PANEL_STYLES went with them and was
      // deleted there on 2026-07-27 with its panel.
      // D-145 § B.8.9 — `TRANSPARENCY_PANEL_STYLES` joins the bundle so a
      // cold `#settings` load renders the Transparency section styled.
      // Selectors scope to `[data-recued-transparency-panel]`, so the
      // rules are inert when the bootstrap omits the prefs callers + the
      // section never mounts.
      TRANSPARENCY_PANEL_STYLES,
      // D-219 — same reasoning, and it was MISSING until a live browser run on
      // 2026-07-29 showed the Learning rows rendering as one run-together
      // unstyled sentence directly beneath the styled Transparency rows. The
      // panel had set `learning-row*` classes from the start; nothing defined
      // them. Structure-and-text render tests cannot see a missing stylesheet.
      LEARNING_PANEL_STYLES,
      // D-145 PA11 — `LLM_RESULT_CACHE_CARD_STYLES` joins the bundle
      // so a cold `#settings` load renders the cache card fully
      // styled. Selectors scope to `.housekeeping-cache-card` so the
      // rules are inert when the bootstrap omits
      // `housekeepingCacheStatsCaller` + the card never mounts.
      LLM_RESULT_CACHE_CARD_STYLES,
      AI_MODELS_PAGE_STYLES,
      SELLER_PAGE_STYLES,
      UPDATES_PAGE_STYLES,
      ACCOUNT_BINDING_PANEL_STYLES,
      // R26.4 M1 — the consolidated Backup & Recovery surface's styles join the
      // bundle so a cold `#settings/backup` load renders fully styled. Selectors
      // scope to `[data-recued-archive-backup-panel]`, inert when the archive
      // callers are omitted + the surface never mounts.
      ARCHIVE_BACKUP_PANEL_STYLES,
      // D-152 P6 — `HOSTNAMES_PANEL_STYLES` joins the bundle so a cold
      // `#settings` load renders the Server -> Hostnames panel fully styled.
      // Selectors scope to `[data-recued-hostnames-panel]`, so the rules are
      // inert when the bootstrap omits the hostname callers + the panel never
      // mounts.
      HOSTNAMES_PANEL_STYLES,
      REACHABILITY_PANEL_STYLES,
      // D-132/D-133 — `HOUSEKEEPING_PANEL_STYLES` joins the bundle so a
      // cold `#settings` load renders the Housekeeping trust panel
      // styled. Selectors scope to `.housekeeping-*` so the rules are
      // inert when the bootstrap omits the panel callers + it never mounts.
      HOUSEKEEPING_PANEL_STYLES,
    ].join('\n');
    doc.head.appendChild(style);
  }

  // ── Route root (single child of opts.root) ───────────────────────
  // No "← Back to Reception" breadcrumb: Settings is a first-class
  // workspace-rail route now, not a child of Reception, so a back link
  // up to Reception is dead weight (D-174 IA).
  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(SETTINGS_ROUTE_ROOT_ATTR, '');

  const heading = doc.createElement('h1');
  heading.textContent = 'Settings';
  routeRoot.appendChild(heading);

  // ── Subview shell: a sticky rail + the section host ───────────────
  // Sections register into `subviews` as they mount (each gated on its
  // own callers); the rail is built from that list once every section
  // has had its chance to mount, and a rail click activates one subview
  // at a time. Sections append into `viewsHost` (NOT routeRoot) so the
  // rail stays a sibling outside the scrolling column. Overlays (the cli
  // grant dialog) still mount on routeRoot so they float over the shell.
  const shell = doc.createElement('div');
  shell.className = 'settings-shell';
  const navEl = doc.createElement('nav');
  navEl.setAttribute(SETTINGS_ROUTE_NAV_ATTR, '');
  navEl.setAttribute('data-recued-scroll-rail', '');
  navEl.setAttribute('aria-label', 'Settings sections');
  const viewsHost = doc.createElement('div');
  viewsHost.setAttribute(SETTINGS_ROUTE_VIEWS_ATTR, '');
  shell.appendChild(navEl);
  shell.appendChild(viewsHost);
  routeRoot.appendChild(shell);

  const subviews: SettingsSubview[] = [];
  /** Rail-item badge dots keyed by subview id (created in the nav loop for
   *  `badgeable` subviews); `setSubviewBadge` toggles one after mount. */
  const navBadges = new Map<string, HTMLElement>();
  const setSubviewBadge = (id: string, on: boolean): void => {
    const badge = navBadges.get(id);
    if (badge === undefined) return;
    if (on) badge.removeAttribute('hidden');
    else badge.setAttribute('hidden', '');
  };
  /** Append a section into the views host + register it as a subview so
   *  the rail picks it up. `id` MUST match the section's own
   *  `SETTINGS_ROUTE_SECTION_ATTR` value (the rail item + the
   *  `#settings/<id>` deep-link both resolve against it). */
  const registerSubview = (
    id: string,
    label: string,
    section: HTMLElement,
    subOpts?: { badgeable?: boolean },
  ): void => {
    subviews.push({ id, label, section, badgeable: subOpts?.badgeable === true });
    viewsHost.appendChild(section);
  };

  /** An in-section sub-tab strip for sections the route assembles inline
   *  from several sub-panels (Privacy / Server) — the same focused-view
   *  treatment the Housekeeping / AI-Models panels grow internally.
   *  Returns the per-tab panel host so the caller mounts each sub-panel
   *  into the right one. A single-tab section skips the strip (a lone tab
   *  reads as noise) + returns one bare host; a zero-tab call returns
   *  `{}`. Switching is in-memory — all panels stay in the DOM, CSS
   *  toggles visibility off `SETTINGS_ROUTE_ACTIVE_ATTR`. */
  const buildSectionTabs = (
    section: HTMLElement,
    tabs: ReadonlyArray<{ id: string; label: string }>,
    tabListLabel: string,
    initialTabId?: string | null,
  ): Record<string, HTMLElement> => {
    const hosts: Record<string, HTMLElement> = {};
    if (tabs.length === 0) return hosts;
    if (tabs.length === 1) {
      const only = doc.createElement('div');
      section.appendChild(only);
      hosts[tabs[0]!.id] = only;
      return hosts;
    }
    const strip = doc.createElement('nav');
    strip.className = 'settings-subtabs';
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('aria-label', tabListLabel);
    strip.setAttribute('aria-orientation', 'horizontal');
    const items: Array<{ id: string; btn: HTMLElement; panel: HTMLElement }> = [];
    const activate = (id: string): void => {
      for (const it of items) {
        const active = it.id === id;
        it.btn.setAttribute(SETTINGS_ROUTE_ACTIVE_ATTR, active ? 'true' : 'false');
        it.btn.setAttribute('aria-selected', active ? 'true' : 'false');
        it.btn.setAttribute('tabindex', active ? '0' : '-1');
        it.panel.setAttribute(
          SETTINGS_ROUTE_ACTIVE_ATTR,
          active ? 'true' : 'false',
        );
      }
    };
    const sectionId = section.getAttribute(SETTINGS_ROUTE_SECTION_ATTR)
      ?? 'section';
    for (const tab of tabs) {
      const btn = doc.createElement('button');
      btn.setAttribute('type', 'button');
      btn.setAttribute('role', 'tab');
      btn.setAttribute(SETTINGS_ROUTE_SUBTAB_ATTR, tab.id);
      const tabDomId = `recued-settings-${sectionId}-${tab.id}-tab`;
      const panelDomId = `recued-settings-${sectionId}-${tab.id}-panel`;
      btn.setAttribute('id', tabDomId);
      btn.setAttribute('aria-controls', panelDomId);
      btn.className = 'settings-subtab';
      btn.textContent = tab.label;
      btn.addEventListener('click', () => activate(tab.id));
      btn.addEventListener('keydown', (event) => {
        const currentIndex = items.findIndex((item) => item.id === tab.id);
        if (currentIndex < 0) return;
        let nextIndex: number | null = null;
        if (event.key === 'ArrowRight') {
          nextIndex = (currentIndex + 1) % items.length;
        } else if (event.key === 'ArrowLeft') {
          nextIndex = (currentIndex - 1 + items.length) % items.length;
        } else if (event.key === 'Home') {
          nextIndex = 0;
        } else if (event.key === 'End') {
          nextIndex = items.length - 1;
        }
        if (nextIndex === null) return;
        event.preventDefault();
        const next = items[nextIndex]!;
        activate(next.id);
        next.btn.focus();
      });
      strip.appendChild(btn);
      const panel = doc.createElement('div');
      panel.className = 'settings-subtabpanel';
      panel.setAttribute(SETTINGS_ROUTE_SUBTAB_PANEL_ATTR, tab.id);
      panel.setAttribute('id', panelDomId);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tabDomId);
      items.push({ id: tab.id, btn, panel });
      hosts[tab.id] = panel;
    }
    section.appendChild(strip);
    for (const it of items) section.appendChild(it.panel);
    const requestedTabId = initialTabId?.trim();
    const initialTab =
      items.find((item) => item.id === requestedTabId)?.id ?? items[0]!.id;
    activate(initialTab);
    return hosts;
  };

  // ── Account section (D-174/D-175) ────────────────────────────────
  // The webclient is the paired-server touchpoint: it reads the local
  // binding state, relays the Worker-minted binding token through
  // `account.bind`, and links out to the dashboard for billing/publishing.
  let accountBinding: AccountBindingPanelMount | null = null;
  const canMountAccountBinding =
    opts.accountBindingStatusCaller !== undefined
    && opts.accountBindCaller !== undefined
    && opts.accountUnbindCaller !== undefined
    && opts.accountProConvenienceStatusCaller !== undefined
    && opts.accountBindingTokenMintCaller !== undefined;
  if (canMountAccountBinding) {
    const accountSection = doc.createElement('section');
    accountSection.setAttribute(SETTINGS_ROUTE_SECTION_ATTR, 'account');

    const accountSectionHeading = doc.createElement('h2');
    accountSectionHeading.textContent = 'Account';
    accountSection.appendChild(accountSectionHeading);

    const accountHost = doc.createElement('div');
    accountSection.appendChild(accountHost);
    accountBinding = mountAccountBindingPanel({
      host: accountHost,
      document: doc,
      runBindingStatus: opts.accountBindingStatusCaller as AccountBindingStatusCaller,
      runBind: opts.accountBindCaller as AccountBindCaller,
      runUnbind: opts.accountUnbindCaller as AccountUnbindCaller,
      runProStatus:
        opts.accountProConvenienceStatusCaller as ProConvenienceStatusCaller,
      mintBindingToken:
        opts.accountBindingTokenMintCaller as AccountBindingTokenMintCaller,
      ...(opts.accountBindingSessionCaller !== undefined
        ? { runReadSession: opts.accountBindingSessionCaller }
        : {}),
      ...(opts.accountSignOutCaller !== undefined
        ? { runSignOut: opts.accountSignOutCaller }
        : {}),
      ...(opts.accountDashboardUrl !== undefined
        ? { dashboardUrl: opts.accountDashboardUrl }
        : {}),
    });

    registerSubview('account', 'Account', accountSection);
  }

  // ── Backup & Recovery section (R26.4 — the 8th section) ───────────
  // ONE consolidated surface (M1 slice 4): the archive export/restore mini-app
  // is the spine, with the recovery key as the in-flow access gate, the
  // identity passport riding inside the archive as an opt-out export toggle,
  // and a lightweight standalone "Export identity passport only" action gated
  // on `passportExportCaller`. The surface mounts iff the three `archive*Caller`s
  // are wired (one functional unit); offline / test boot paths that omit them
  // skip the section. RETIRED here: the standalone recovery-key re-verify block
  // (the in-flow gate supersedes it) + the passport paste-import flow (the
  // in-archive embed supersedes it). The generate/enroll half of the recovery
  // key still lives at FIRST PAIR (auth/pair-code-input-host.ts), not here.
  let archiveBackup: ArchiveBackupPanelMount | null = null;
  const archiveCallersReady =
    opts.archiveExportCaller !== undefined
    && opts.archiveStatusCaller !== undefined
    && opts.archiveImportCaller !== undefined;
  if (archiveCallersReady) {
    const backupSection = doc.createElement('section');
    backupSection.setAttribute(SETTINGS_ROUTE_SECTION_ATTR, 'backup');

    const backupHeading = doc.createElement('h2');
    backupHeading.textContent = 'Backup & Recovery';
    backupSection.appendChild(backupHeading);

    const archiveHost = doc.createElement('div');
    backupSection.appendChild(archiveHost);
    archiveBackup = mountArchiveBackupPanel({
      host: archiveHost,
      document: doc,
      runExport: opts.archiveExportCaller as ArchiveExportCaller,
      runStatus: opts.archiveStatusCaller as ArchiveStatusCaller,
      runImport: opts.archiveImportCaller as ArchiveImportCaller,
      ...(opts.archiveResumeExportStart !== undefined
        ? { resumeExportStart: opts.archiveResumeExportStart }
        : {}),
      ...(opts.archiveExportSettled !== undefined
        ? { onExportSettled: opts.archiveExportSettled }
        : {}),
      ...(opts.passportExportCaller !== undefined
        ? { runPassportExport: opts.passportExportCaller }
        : {}),
      ...(opts.archiveDownload !== undefined
        ? { archiveDownload: opts.archiveDownload }
        : {}),
      ...(opts.archiveUpload !== undefined
        ? { archiveUpload: opts.archiveUpload }
        : {}),
      ...(opts.archiveRebindStash !== undefined
        ? { stashRebind: opts.archiveRebindStash }
        : {}),
    });

    registerSubview('backup', 'Backup & Recovery', backupSection);
  }

  // ── AI / Models section (D-174 D14) ──────────────────────────────
  // Consolidates the LLM controls that previously lived as an orphan
  // Chat default-model page or scattered Server/Housekeeping cards.
  // Each child control owns its own pending state when a backend seam is
  // missing; the section mounts when at least one AI/Models seam is wired.
  let aiModels: AiModelsPageMount | null = null;
  let sellerPage: SellerPageMount | null = null;
  let updatesPage: UpdatesPageMount | null = null;
  const wantsAiModelsSection =
    opts.aiModelsDefaultModelPrefGetCaller !== undefined
    || opts.aiModelsDefaultModelPrefSetCaller !== undefined
    || opts.aiModelsGetLLMConfigCaller !== undefined
    || opts.aiModelsSetLLMSlotCaller !== undefined
    || opts.aiModelsSetEmbeddingsSlotCaller !== undefined
    || opts.aiModelsUpsertFreePoolEntryCaller !== undefined
    || opts.aiModelsRemoveFreePoolEntryCaller !== undefined
    || opts.aiModelsSetFreePoolEntryEnabledCaller !== undefined
    || opts.aiModelsSetChatCatalogModeCaller !== undefined
    || opts.aiModelsGetLlmPromptsCaller !== undefined
    || opts.aiModelsSetLlmPromptCaller !== undefined
    || opts.aiModelsGetConfigSchemaCaller !== undefined
    || opts.aiModelsSetConfigFieldCaller !== undefined
    || opts.aiModelsHousekeepingConfigReadCaller !== undefined
    || opts.aiModelsHousekeepingConfigWriteCaller !== undefined
    || opts.housekeepingCacheStatsCaller !== undefined;
  if (wantsAiModelsSection) {
    const aiSection = doc.createElement('section');
    aiSection.setAttribute(SETTINGS_ROUTE_SECTION_ATTR, 'ai-models');

    const aiSectionHeading = doc.createElement('h2');
    aiSectionHeading.textContent =
      opts.initialAiModelsView === 'chat-setup' ? 'Set up Chat' : 'AI / Models';
    aiSection.appendChild(aiSectionHeading);

    const aiHost = doc.createElement('div');
    aiSection.appendChild(aiHost);
    aiModels = mountAiModelsPage({
      host: aiHost,
      document: doc,
      ...(opts.initialAiModelsView !== undefined
        && opts.initialAiModelsView !== null
        ? { initialView: opts.initialAiModelsView }
        : {}),
      ...(opts.onChatSetupComplete !== undefined
        ? { onChatSetupComplete: opts.onChatSetupComplete }
        : {}),
      ...(opts.chatSetupReturnHref !== undefined
        ? { chatSetupReturnHref: opts.chatSetupReturnHref }
        : {}),
      ...(opts.aiModelsDefaultModelPrefGetCaller !== undefined
        ? { runGetDefaultModelPref: opts.aiModelsDefaultModelPrefGetCaller }
        : {}),
      ...(opts.aiModelsDefaultModelPrefSetCaller !== undefined
        ? { runSetDefaultModelPref: opts.aiModelsDefaultModelPrefSetCaller }
        : {}),
      ...(opts.aiModelsGetLLMConfigCaller !== undefined
        ? { runGetLLMConfig: opts.aiModelsGetLLMConfigCaller }
        : {}),
      ...(opts.aiModelsSetLLMSlotCaller !== undefined
        ? { runSetLLMSlot: opts.aiModelsSetLLMSlotCaller }
        : {}),
      ...(opts.aiModelsSetEmbeddingsSlotCaller !== undefined
        ? { runSetEmbeddingsSlot: opts.aiModelsSetEmbeddingsSlotCaller }
        : {}),
      ...(opts.aiModelsUpsertFreePoolEntryCaller !== undefined
        ? { runUpsertFreePoolEntry: opts.aiModelsUpsertFreePoolEntryCaller }
        : {}),
      ...(opts.aiModelsRemoveFreePoolEntryCaller !== undefined
        ? { runRemoveFreePoolEntry: opts.aiModelsRemoveFreePoolEntryCaller }
        : {}),
      ...(opts.aiModelsSetFreePoolEntryEnabledCaller !== undefined
        ? { runSetFreePoolEntryEnabled: opts.aiModelsSetFreePoolEntryEnabledCaller }
        : {}),
      ...(opts.aiModelsSetChatCatalogModeCaller !== undefined
        ? { runSetChatCatalogMode: opts.aiModelsSetChatCatalogModeCaller }
        : {}),
      ...(opts.aiModelsGetLlmPromptsCaller !== undefined
        ? { runGetLlmPrompts: opts.aiModelsGetLlmPromptsCaller }
        : {}),
      ...(opts.aiModelsSetLlmPromptCaller !== undefined
        ? { runSetLlmPrompt: opts.aiModelsSetLlmPromptCaller }
        : {}),
      ...(opts.aiModelsGetConfigSchemaCaller !== undefined
        ? { runGetConfigSchema: opts.aiModelsGetConfigSchemaCaller }
        : {}),
      ...(opts.aiModelsSetConfigFieldCaller !== undefined
        ? { runSetConfigField: opts.aiModelsSetConfigFieldCaller }
        : {}),
      ...(opts.aiModelsHousekeepingConfigReadCaller !== undefined
        ? { runReadHousekeepingConfig: opts.aiModelsHousekeepingConfigReadCaller }
        : {}),
      ...(opts.aiModelsHousekeepingConfigWriteCaller !== undefined
        ? { runWriteHousekeepingConfig: opts.aiModelsHousekeepingConfigWriteCaller }
        : {}),
      ...(opts.housekeepingCacheStatsCaller !== undefined
        ? { runCacheStats: opts.housekeepingCacheStatsCaller }
        : {}),
      ...(opts.housekeepingCacheClearCaller !== undefined
        ? { runCacheClear: opts.housekeepingCacheClearCaller }
        : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
    });

    registerSubview('ai-models', 'AI / Models', aiSection);
  }

  // ── Seller section (D-196 S2) ───────────────────────────────────
  // Cockpit over owner-only seller RPCs. Write controls stay optional so
  // narrowed/test hosts can mount the read surface without stubbing writes.
  if (opts.sellerOverviewCaller !== undefined) {
    const sellerSection = doc.createElement('section');
    sellerSection.setAttribute(SETTINGS_ROUTE_SECTION_ATTR, 'seller');

    const sellerHeading = doc.createElement('h2');
    sellerHeading.textContent = 'Seller';
    sellerSection.appendChild(sellerHeading);

    const sellerHost = doc.createElement('div');
    sellerSection.appendChild(sellerHost);
    sellerPage = mountSellerPage({
      host: sellerHost,
      document: doc,
      ...(opts.initialSellerSubpage !== undefined
        ? { initialSubpage: opts.initialSellerSubpage }
        : {}),
      ...(opts.initialSellerItemId !== undefined
        ? { initialItemId: opts.initialSellerItemId }
        : {}),
      ...(opts.initialSellerPage !== undefined
        ? { initialPage: opts.initialSellerPage }
        : {}),
      runGetOverview: opts.sellerOverviewCaller,
      ...(opts.sellerOrdersCaller !== undefined
        ? { runListOrders: opts.sellerOrdersCaller }
        : {}),
      // D-196 1d — the GENERIC recipe runner, not a per-action seller rpc: an
      // owner action on an order costs a recipe, never a new backend method.
      ...(opts.recipeExecuteCaller !== undefined
        ? {
            runRecipe: opts.recipeExecuteCaller,
            reloadOrders: () => { void sellerPage?.refresh(); },
          }
        : {}),
      ...(opts.sellerOfferStateTransitionCaller !== undefined
        ? { runTransitionOfferState: opts.sellerOfferStateTransitionCaller }
        : {}),
      ...(opts.sellerMailListCaller !== undefined
        ? { runListMailInstances: opts.sellerMailListCaller }
        : {}),
      ...(opts.sellerSettingsUpdateCaller !== undefined
        ? { runUpdateSellerSettings: opts.sellerSettingsUpdateCaller }
        : {}),
      ...(opts.sellerManualTierUpsertCaller !== undefined
        ? { runUpsertManualTier: opts.sellerManualTierUpsertCaller }
        : {}),
      ...(opts.sellerCreatePassTierCaller !== undefined
        ? { runCreatePassTier: opts.sellerCreatePassTierCaller }
        : {}),
      ...(opts.sellerManualCustomerIssueCaller !== undefined
        ? { runIssueManualCustomer: opts.sellerManualCustomerIssueCaller }
        : {}),
      ...(opts.sellerManualCustomerExtendCaller !== undefined
        ? { runExtendManualCustomer: opts.sellerManualCustomerExtendCaller }
        : {}),
      ...(opts.sellerManualCustomerSwapTierCaller !== undefined
        ? { runSwapManualCustomerTier: opts.sellerManualCustomerSwapTierCaller }
        : {}),
      ...(opts.sellerManualCustomerCloseCaller !== undefined
        ? { runCloseManualCustomer: opts.sellerManualCustomerCloseCaller }
        : {}),
      ...(opts.sellerManualCustomerReissueTokenCaller !== undefined
        ? { runReissueManualCustomerToken: opts.sellerManualCustomerReissueTokenCaller }
        : {}),
      ...(opts.sellerManualTierBulkAdjustCaller !== undefined
        ? { runBulkAdjustManualTierCustomers: opts.sellerManualTierBulkAdjustCaller }
        : {}),
      ...(opts.sellerStripeSynchronizeCaller !== undefined
        ? { runSynchronizeStripeEntitlements: opts.sellerStripeSynchronizeCaller }
        : {}),
      ...(opts.sellerAcknowledgeLlmGatewayPaidCaller !== undefined
        ? { runAcknowledgeLlmGatewayPaid: opts.sellerAcknowledgeLlmGatewayPaidCaller }
        : {}),
    });

    registerSubview('seller', 'Seller', sellerSection);
  }

  // ── Updates section (D-178) ──────────────────────────────────────
  // Mounts when the `update.check` caller is wired. The page polls availability
  // so the rail item can badge "update available" without the page being open.
  if (opts.updateCheckCaller !== undefined) {
    const updatesSection = doc.createElement('section');
    updatesSection.setAttribute(SETTINGS_ROUTE_SECTION_ATTR, 'updates');
    const updatesHeading = doc.createElement('h2');
    updatesHeading.textContent = 'Updates';
    updatesSection.appendChild(updatesHeading);
    const updatesHost = doc.createElement('div');
    updatesSection.appendChild(updatesHost);
    updatesPage = mountUpdatesPage({
      host: updatesHost,
      document: doc,
      runCheck: opts.updateCheckCaller,
      onAvailabilityChanged: (available) => setSubviewBadge('updates', available),
      ...(opts.updateModeGetCaller !== undefined
        ? { runGetMode: opts.updateModeGetCaller }
        : {}),
      ...(opts.updateModeSetCaller !== undefined
        ? { runSetMode: opts.updateModeSetCaller }
        : {}),
      ...(opts.updateApplyCaller !== undefined
        ? { runApply: opts.updateApplyCaller }
        : {}),
      ...(opts.updateRollbackCaller !== undefined
        ? { runRollback: opts.updateRollbackCaller }
        : {}),
      ...(opts.updatesStartPoll !== undefined
        ? { startPoll: opts.updatesStartPoll }
        : {}),
      ...(opts.updatesPollIntervalMs !== undefined
        ? { pollIntervalMs: opts.updatesPollIntervalMs }
        : {}),
      ...(opts.credentialRotationServerUpdateContinuity !== undefined
        ? {
            credentialRotationServerUpdateContinuity:
              opts.credentialRotationServerUpdateContinuity,
          }
        : {}),
      ...(opts.serverUpdateTabConvergence !== undefined
        ? {
            serverUpdateTabConvergence:
              opts.serverUpdateTabConvergence,
          }
        : {}),
      ...(opts.serverConnectionStatus !== undefined
        ? { serverConnectionStatus: opts.serverConnectionStatus }
        : {}),
      ...(opts.serverUpdateReceiptVerification !== undefined
        ? {
            serverUpdateReceiptVerification:
              opts.serverUpdateReceiptVerification,
          }
        : {}),
      ...(opts.serverUpdateReceiptDiagnosticContext !== undefined
        ? {
            serverUpdateReceiptDiagnosticContext:
              opts.serverUpdateReceiptDiagnosticContext,
          }
        : {}),
      ...(opts.serverUpdateReceiptDiagnosticWriter !== undefined
        ? {
            serverUpdateReceiptDiagnosticWriter:
              opts.serverUpdateReceiptDiagnosticWriter,
          }
        : {}),
      ...(opts.onReturnToCredentialRotationRetry !== undefined
        ? {
            onReturnToCredentialRotationRetry:
              opts.onReturnToCredentialRotationRetry,
          }
        : {}),
    });
    registerSubview('updates', 'Updates', updatesSection, { badgeable: true });
  }

  // ── Transparency panel (folded into Privacy — R29) ───────────────
  // The chat thought-stream disclosure toggles (per-pair `ui.transparency.*`
  // prefs) are no longer a standalone rail section — they live as a block
  // inside the Privacy directory (mounted below, gated on both prefs
  // callers). Declared here so the Privacy block + the dispose cascade can
  // see the handle.
  let transparencyPanel: TransparencyPanelMount | null = null;
  let learningPanel: LearningPanelMount | null = null;

  // ── Housekeeping section (D-132/D-133 trust core) ────────────────
  // Per-topic AI-trust radios + pool policy + schedule + Run-now. The
  // promotion/drift banners, MCP-exposure overrides, and the destructive
  // topic-reset are deferred (left unfed / gated by the mount) to a
  // follow-on slice; the LLM-result-cache card stays in AI / Models for
  // now. Mounts only when the four read/write seams are all wired.
  let housekeepingPanel: HousekeepingPanelMount | null = null;
  const hkConfigRead = opts.housekeepingPanelConfigReadCaller;
  const hkConfigWrite = opts.housekeepingPanelConfigWriteCaller;
  const hkStatusRead = opts.housekeepingPanelStatusReadCaller;
  const hkTrustRead = opts.housekeepingPanelTrustReadCaller;
  if (hkConfigRead && hkConfigWrite && hkStatusRead && hkTrustRead) {
    const hkSection = doc.createElement('section');
    hkSection.setAttribute(SETTINGS_ROUTE_SECTION_ATTR, 'housekeeping');
    // No section-level <h2>: the housekeeping panel renders its own
    // header (title + summary + the internal tab strip), so a second
    // "Housekeeping" heading here would be a redundant double-title.
    const hkHost = doc.createElement('div');
    hkSection.appendChild(hkHost);
    registerSubview('housekeeping', 'Housekeeping', hkSection);
    housekeepingPanel = mountHousekeepingPanel({
      host: hkHost,
      runConfigRead: hkConfigRead,
      runConfigWrite: hkConfigWrite,
      runStatusRead: hkStatusRead,
      runTrustRead: hkTrustRead,
      ...(opts.housekeepingPanelRunNowCaller !== undefined
        ? { runRunNow: opts.housekeepingPanelRunNowCaller }
        : {}),
      ...(opts.housekeepingPanelTrustWriteCaller !== undefined
        ? { runTrustWrite: opts.housekeepingPanelTrustWriteCaller }
        : {}),
      ...(opts.housekeepingPanelDismissPromotionCaller !== undefined
        ? { runDismissPromotion: opts.housekeepingPanelDismissPromotionCaller }
        : {}),
      ...(opts.housekeepingPanelRegistryDescribeCaller !== undefined
        ? { runRegistryDescribe: opts.housekeepingPanelRegistryDescribeCaller }
        : {}),
      ...(opts.housekeepingPanelTopicResetCaller !== undefined
        ? { runTopicReset: opts.housekeepingPanelTopicResetCaller }
        : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
    });
  }

  // ── Work Entities section (D-145 PA11) ───────────────────────────

  // ── Privacy section (directory — R29) ─────────────────────────────
  // Recued's privacy model is architectural: your data lives on your
  // server and PII is aliased on every AI route automatically (D-191
  // retired the per-scope "egress policy" — there is nothing to configure
  // here). So Privacy is a DIRECTORY: a framing of the always-on baseline
  // + curated links to each control's real home, plus the two things that
  // genuinely live only here — the chat thought-stream disclosure
  // (Transparency, folded in) and the local browser wipe (This browser).
  const privacySection = doc.createElement('section');
  privacySection.setAttribute(SETTINGS_ROUTE_SECTION_ATTR, 'privacy');

  const sectionHeading = doc.createElement('h2');
  sectionHeading.textContent = 'Privacy';
  privacySection.appendChild(sectionHeading);

  registerSubview('privacy', 'Privacy', privacySection);
  opts.root.appendChild(routeRoot);

  // ── Framing — the always-on baseline (no toggle) ──────────────────
  const privacyIntro = doc.createElement('div');
  privacyIntro.className = 'privacy-intro';
  const introBaseline = doc.createElement('p');
  introBaseline.textContent =
    'Your data lives on your server. Before any turn reaches an AI model, '
    + 'Recued automatically aliases identifying details — names, emails, '
    + 'addresses — then swaps the real values back into the reply. There is '
    + 'no privacy switch to flip: it is how every route works.';
  const introDirectory = doc.createElement('p');
  introDirectory.textContent =
    'The controls for what AI can see and do live where you use them. '
    + 'Here is where to find each. You can pause all AI at any time from '
    + 'the pause button in the top bar.';
  privacyIntro.appendChild(introBaseline);
  privacyIntro.appendChild(introDirectory);
  privacySection.appendChild(privacyIntro);

  // ── Directory — curated links to each control's real home ─────────
  const directory = doc.createElement('ul');
  directory.className = 'privacy-directory';
  directory.setAttribute(SETTINGS_ROUTE_PRIVACY_DIRECTORY_ATTR, '');
  const addDirectoryEntry = (
    href: string,
    linkAttr: string | null,
    title: string,
    detail: string,
  ): void => {
    const item = doc.createElement('li');
    const link = doc.createElement('a');
    link.setAttribute('href', href);
    if (linkAttr !== null) link.setAttribute(linkAttr, '');
    const titleEl = doc.createElement('span');
    titleEl.className = 'privacy-directory-title';
    titleEl.textContent = title;
    const detailEl = doc.createElement('span');
    detailEl.className = 'privacy-directory-detail';
    detailEl.textContent = detail;
    link.appendChild(titleEl);
    link.appendChild(detailEl);
    item.appendChild(link);
    directory.appendChild(item);
  };
  addDirectoryEntry(
    '#contracts',
    SETTINGS_ROUTE_CONTRACTS_LINK_ATTR,
    'Contracts',
    'What each AI agent is allowed to read and do.',
  );
  addDirectoryEntry(
    '#connections',
    SETTINGS_ROUTE_CONNECTIONS_LINK_ATTR,
    'Connections',
    'The accounts and sources Recued reads from.',
  );
  addDirectoryEntry(
    '#data',
    SETTINGS_ROUTE_DATA_LINK_ATTR,
    'Data',
    'Everything Recued has stored — and a timeline for any item.',
  );
  addDirectoryEntry(
    '#settings/ai-models',
    null,
    'AI / Models',
    'Which model your turns use; override per turn in the chat picker.',
  );
  addDirectoryEntry(
    '#logs',
    null,
    'Runs',
    'A log of everything the AI has done.',
  );
  privacySection.appendChild(directory);

  // ── Transparency — chat thought-stream disclosure (folded in) ─────
  // Real per-pair config with no other home; gated on both prefs callers
  // (the same gated-mount shape it had as a standalone rail section).
  if (
    opts.transparencyPrefsGetCaller !== undefined
    && opts.transparencyPrefsSetCaller !== undefined
  ) {
    const transparencyBlock = doc.createElement('div');
    transparencyBlock.setAttribute(SETTINGS_ROUTE_PRIVACY_TRANSPARENCY_ATTR, '');
    const transparencyHeading = doc.createElement('h3');
    transparencyHeading.textContent = 'Transparency';
    transparencyBlock.appendChild(transparencyHeading);
    const transparencyHost = doc.createElement('div');
    transparencyBlock.appendChild(transparencyHost);
    privacySection.appendChild(transparencyBlock);
    transparencyPanel = mountTransparencyPanel({
      host: transparencyHost,
      document: doc,
      runPrefsGet: opts.transparencyPrefsGetCaller,
      runPrefsSet: opts.transparencyPrefsSetCaller,
    });
  }

  // ── Learning — whether Recued asks how a multi-step turn turned out ─
  // D-219 slice 9c. Sits beside Transparency because both answer "what
  // does Recued do around my turns"; this one governs the PRINCIPAL signal
  // (⚠ not the only one — an independently verified outcome is strong evidence
  // and does not run through the ask; the panel's copy says so)
  // that becomes precedent, so it is a real control rather than a
  // display preference.
  if (
    opts.learningPrefsGetCaller !== undefined
    && opts.learningPrefsSetCaller !== undefined
  ) {
    const learningBlock = doc.createElement('div');
    learningBlock.setAttribute(SETTINGS_ROUTE_PRIVACY_LEARNING_ATTR, '');
    const learningHeading = doc.createElement('h3');
    learningHeading.textContent = 'Learning';
    learningBlock.appendChild(learningHeading);
    const learningHost = doc.createElement('div');
    learningBlock.appendChild(learningHost);
    privacySection.appendChild(learningBlock);
    learningPanel = mountLearningPanel({
      host: learningHost,
      document: doc,
      runPrefsGet: opts.learningPrefsGetCaller,
      runPrefsSet: opts.learningPrefsSetCaller,
      ...(opts.learningCasesListCaller !== undefined
        && opts.learningCaseForgetCaller !== undefined
        ? {
            runCasesList: opts.learningCasesListCaller,
            runCaseForget: opts.learningCaseForgetCaller,
          }
        : {}),
      ...(opts.learningDraftRecipeCaller !== undefined
        && opts.onLearningDraftReady !== undefined
        ? {
            runDraftRecipe: opts.learningDraftRecipeCaller,
            onDraftReady: opts.onLearningDraftReady,
            ...(opts.learningDraftConfirmation !== undefined
              ? { draftConfirmation: opts.learningDraftConfirmation }
              : {}),
          }
        : {}),
    });
  }

  // ── This browser — clear local device data + crypto keys ──────────
  // Local-only, destructive (two-tap guard), no server rpc. Lives only
  // here; placed last so it sits away from the directory links.
  const thisBrowserBlock = doc.createElement('div');
  const thisBrowserHeading = doc.createElement('h3');
  thisBrowserHeading.textContent = 'This browser';
  thisBrowserBlock.appendChild(thisBrowserHeading);
  const thisBrowserHost = doc.createElement('div');
  thisBrowserBlock.appendChild(thisBrowserHost);
  privacySection.appendChild(thisBrowserBlock);
  const panel = mountClearThisBrowserPanel({
    host: thisBrowserHost,
    document: doc,
    localStore: opts.localStore,
    ...(opts.cryptoKeysWiper !== undefined
      ? { crypto_keys_wiper: opts.cryptoKeysWiper }
      : {}),
    ...(opts.onLocalCredentialsCleared !== undefined
      ? { onLocalCredentialsCleared: opts.onLocalCredentialsCleared }
      : {}),
    ...(opts.reloader !== undefined ? { reloader: opts.reloader } : {}),
    ...(opts.onCleared !== undefined ? { onCleared: opts.onCleared } : {}),
  });

  // ── Devices section (D-156 P5) ────────────────────────────────────
  // Sits between Privacy and Server in document order — the operator's
  // mental model is "this is my browser" (Privacy) → "these are my
  // other clients" (Devices) → "this is the server hosting all of
  // them" (Server). Hosts the `mountDevicesPage` roster + the inline
  // two-stage revoke state machine; gated on both `pairListCaller` +
  // `pairRevokeCaller` being wired so a test environment / unpaired
  // boot path can skip the section cleanly. (The slice-129/131
  // pair-mint + history panels lived alongside this until D-156 P8
  // deleted the legacy pair-blob substrate end-to-end.)
  let devicesPage: DevicesPageMount | null = null;
  const canMountDevicesPage =
    opts.pairListCaller !== undefined && opts.pairRevokeCaller !== undefined;
  if (canMountDevicesPage) {
    const devicesSection = doc.createElement('section');
    devicesSection.setAttribute(SETTINGS_ROUTE_SECTION_ATTR, 'devices');

    // No section-level <h2>: `renderDevicesPage` wraps its table in an
    // `rx-section` with its own "Devices" title + hint, so a second
    // heading here would be a redundant double-title (mirrors the
    // Housekeeping panel's own-header handling).
    const devicesPageHost = doc.createElement('div');
    devicesSection.appendChild(devicesPageHost);
    devicesPage = mountDevicesPage({
      host: devicesPageHost,
      // Both narrowed above by `canMountDevicesPage`.
      runPairList: opts.pairListCaller as PairListCaller,
      runPairRevoke: opts.pairRevokeCaller as PairRevokeCaller,
      ...(opts.currentInstanceId !== undefined
        ? { currentInstanceId: opts.currentInstanceId }
        : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.onDevicesListError !== undefined
        ? { onListError: opts.onDevicesListError }
        : {}),
      // D-156 follow-on — forward the broadcast subscriber so the roster
      // live-refreshes on `pair.list_changed` (pair add / revoke on another
      // paired client). Same `subscriber.on` seam the Packs / Contracts
      // panels consume.
      ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
    });

    registerSubview('devices', 'Devices', devicesSection);
  }

  // ── Packs ── moved to the `#packs` route ──────────────────────────
  // D-187 §6 follow-on — the Packs section and the install-time cli grant
  // dialog graduated out of Settings into the top-level `#packs` route
  // (`packs/bootstrap-packs-route.ts`). The install→cli-grant-dialog flow
  // binds Packs to the cli.reachability callers, so the two travel together.
  // The roster-wide Local tools grid that also moved there is now deleted.

  // ── Notifications section (D-163 Slice C) ─────────────────────────
  // Sits before Server in document order — the operator's mental model
  // is "my browser → my other clients → how I'm notified → my server".
  // Gated on BOTH callers
  // being supplied because the panel's read-list + per-row toggle
  // surface depends on both. A webclient running against a pre-Slice-C
  // server will surface the rpc `not_configured` / unknown-method error
  // inside the panel's list-error chip — the section still mounts, but
  // the chip telegraphs the version mismatch rather than a hard route
  // crash. Future surfaces (the anti-phishing verification phrase input
  // per D-158 P2b-ii, channel-specific settings per § O-2) can append
  // into the same section host under the same gate.
  let notifications: NotificationsPanelMount | null = null;
  const canMountNotifications =
    opts.notificationsDescribeCaller !== undefined
    && opts.notificationsSetChannelCaller !== undefined;
  if (canMountNotifications) {
    const notifSection = doc.createElement('section');
    notifSection.setAttribute(SETTINGS_ROUTE_SECTION_ATTR, 'notifications');

    const notifSectionHeading = doc.createElement('h2');
    notifSectionHeading.textContent = 'Approval & notifications';
    notifSection.appendChild(notifSectionHeading);

    const notifPanelHost = doc.createElement('div');
    notifSection.appendChild(notifPanelHost);
    notifications = mountNotificationsPanel({
      host: notifPanelHost,
      document: doc,
      // Both narrowed above by `canMountNotifications`.
      runDescribe: opts.notificationsDescribeCaller as NotificationsDescribeCaller,
      runSetChannel:
        opts.notificationsSetChannelCaller as NotificationsSetChannelCaller,
      // D-169 P1 — per-bridge sub-row group renders only when BOTH
      // callers are wired. The describe-bridges fetch happens alongside
      // the channel fetch; the set-bridge-mode caller drives the row
      // toggles. Pre-D-169 boots / dbless harnesses that omit either
      // skip the sub-row group (the bridge channel row still renders
      // with the channel-level toggle).
      ...(opts.notificationsDescribeBridgesCaller
        && opts.notificationsSetBridgeModeCaller
        ? {
            runDescribeBridges: opts.notificationsDescribeBridgesCaller,
            runSetBridgeMode: opts.notificationsSetBridgeModeCaller,
          }
        : {}),
      // R31 — the anti-phishing verification-phrase caller.
      ...(opts.notificationsSetVerificationPhraseCaller
        ? { runSetVerificationPhrase: opts.notificationsSetVerificationPhraseCaller }
        : {}),
      // D-169 P2 Slice 4 follow-on — live broadcast subscription off the
      // shared `subscriber.on` seam. The panel subscribes to
      // `notification.bridge_mode_changed` + splices the inline
      // post-change modes into the matching per-bridge row only when this
      // AND `runDescribeBridges` are both present, so a bridge-mode toggle
      // on another paired client (or the bridge's own surface) reflects
      // live here without a `describe_bridges` refetch. Omitting it keeps
      // the panel on the mount + retry + post-toggle-refresh cadence.
      ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
    });

    registerSubview('notifications', 'Approval & notifications', notifSection);
  }

  // R31 (delta D) — the one-way `notify` history feed was RETIRED here (not
  // graduated into `#logs`): a `notify` is ephemeral (the live toast covers
  // the moment) and an `ask` is the actionable "pending" (→ `#approvals`), so a
  // durable notify feed had no home — `#logs` is the audit of actions that
  // HAPPENED, not one-way notices. The `notification_fired` audit rows still
  // persist server-side and the Bridge side panel keeps its own notify list.

  // ── Permissions moved to Contracts (D-174 P2) ─────────────────────
  // The top-level `#contracts` route now hosts the agent door and
  // contract.override editor. Settings keeps only the Privacy link above.
  const permissions = null as PermissionsPanelMount | null;

  // ── Server section (gated on any Server-surface input) ────────────
  // Slice 111 — Server section hosts `mountTlsRenewPanel`. Slice 113
  // adds `mountCertPinStalePanel` as a sibling. The section is
  // mounted when EITHER input is supplied so a watcher-only boot
  // (cert-pin overlap visible without the operator-initiated renew
  // surface) still gets the section header. A test environment /
  // unpaired-server boot that omits BOTH inputs skips the section
  // rather than rendering an empty placeholder (which would suggest
  // a broken UI rather than an intentionally-disabled surface).
  // Future Server surfaces (Reachability Doctor, ACME status) can
  // append into the same section host under the same gate.
  let tlsRenew: TlsRenewPanelMount | null = null;
  let tlsCertificates: TlsCertificatesPanelMount | null = null;
  let certPinStale: CertPinStalePanelMount | null = null;
  let keyHealth: KeyHealthPanelMount | null = null;
  let hostnames: HostnamesPanelMount | null = null;
  let customDomains: CustomDomainsPanelMount | null = null;
  let reachability: ReachabilityPanelMount | null = null;
  let exposure: ExposurePanelMount | null = null;
  let maintenance: MaintenancePanelMount | null = null;
  // R26.2 Delta 1 — the Exposure grid needs the read + all three mutators.
  // A read-only mount renders toggles that can't dispatch; a mutator-only
  // mount has no initial state to render.
  const canMountExposure =
    opts.exposureGetCaller !== undefined
    && opts.exposureApplyPresetCaller !== undefined
    && opts.exposureSetPathResolutionCaller !== undefined
    && opts.exposureSetPublicMcpAckCaller !== undefined;
  const canMountHostnames =
    opts.hostnamesListCaller !== undefined
    && opts.hostnamesGetCaller !== undefined
    && opts.hostnamesAddCaller !== undefined
    && opts.hostnamesUpdateCaller !== undefined
    && opts.hostnamesRemoveCaller !== undefined
    && opts.hostnamesVerifyOwnershipCaller !== undefined;
  const canMountReachability =
    opts.reachabilityReport !== undefined
    || opts.reachabilityExternalProbeCaller !== undefined;
  // R26.4 Delta 3 — the Key Health page needs BOTH the read + the rotate
  // caller; a read-only mount would render actions that can't dispatch.
  const canMountKeyHealth =
    opts.keyHealthLoader !== undefined && opts.keyRotateCaller !== undefined;
  // R25 — the 11 core housekeeping tasks graduated to Server ▸ Maintenance.
  // The tab mounts whenever the housekeeping status.read seam is wired (the
  // same caller the Housekeeping panel uses); Run-now buttons render only
  // when the run-now caller is also wired.
  const canMountMaintenance =
    opts.housekeepingPanelStatusReadCaller !== undefined;
  const wantsServerSection =
    opts.tlsRenewCaller !== undefined
    || opts.certPinWatcher !== undefined
    || canMountHostnames
    || canMountReachability
    || canMountKeyHealth
    || canMountExposure
    || canMountMaintenance;
  if (wantsServerSection) {
    const serverSection = doc.createElement('section');
    serverSection.setAttribute(SETTINGS_ROUTE_SECTION_ATTR, 'server');

    const serverSectionHeading = doc.createElement('h2');
    serverSectionHeading.textContent = 'Server';
    serverSection.appendChild(serverSectionHeading);

    // Sub-tabs: Exposure / Reachability / Hostnames / Certificates / Key
    // Health — each present only when its surface mounts. Exposure leads:
    // it's the headline control (the "MCP has no UI" + reception on/off the
    // owner couldn't find), and the default tab on a cold `#settings/server`
    // load. TLS renew + cert-pin overlap share the Certificates tab (both
    // are cert lifecycle).
    const canMountTlsCertificates =
      opts.tlsDomainListCaller !== undefined
      && opts.tlsDomainUploadCaller !== undefined;
    const hasCertificates =
      opts.tlsRenewCaller !== undefined
      || opts.certPinWatcher !== undefined
      || canMountTlsCertificates;
    const serverHosts = buildSectionTabs(
      serverSection,
      [
        ...(canMountExposure ? [{ id: 'exposure', label: 'Exposure' }] : []),
        ...(canMountReachability
          ? [{ id: 'reachability', label: 'Reachability' }]
          : []),
        ...(canMountHostnames
          ? [{ id: 'hostnames', label: 'Hostnames' }]
          : []),
        ...(hasCertificates
          ? [{ id: 'certificates', label: 'Certificates' }]
          : []),
        ...(canMountKeyHealth
          ? [{ id: 'key-health', label: 'Key Health' }]
          : []),
        ...(canMountMaintenance
          ? [{ id: 'maintenance', label: 'Maintenance' }]
          : []),
      ],
      'Server sections',
      opts.initialServerTabId,
    );

    if (canMountExposure) {
      // The Exposure panel's "Connection example" needs the paired server URL,
      // but `localStore` is async and the mount is synchronous — so read it
      // fire-and-forget into a local the panel reads at RENDER time. Absent
      // (read fails, or never paired) ⇒ the button simply does not render,
      // which is the intended fail-quiet: a snippet naming a guessed host is
      // worse than no snippet.
      let exposureServerUrl: string | undefined;
      void (async () => {
        try {
          exposureServerUrl = (await opts.localStore.get('server_url')) ?? undefined;
        } catch {
          exposureServerUrl = undefined;
        }
      })();
      exposure = mountExposurePanel({
        host: serverHosts['exposure']!,
        document: doc,
        getServerUrl: () => exposureServerUrl,
        // All four narrowed above by `canMountExposure`.
        runGet: opts.exposureGetCaller as ExposureGetCaller,
        runApplyPreset: opts.exposureApplyPresetCaller as ExposureApplyPresetCaller,
        runSetPathResolution:
          opts.exposureSetPathResolutionCaller as ExposureSetPathResolutionCaller,
        runSetPublicMcpAck:
          opts.exposureSetPublicMcpAckCaller as ExposureSetPublicMcpAckCaller,
        ...(opts.exposureSetApexCaller !== undefined
          ? { runSetApex: opts.exposureSetApexCaller }
          : {}),
        ...(opts.exposureHasDdnsCaller !== undefined
          ? { runHasDdns: opts.exposureHasDdnsCaller }
          : {}),
        // Live-refresh on `exposure_changed` when the shared subscriber is
        // wired (a preset/grid change on another paired client reflects here).
        ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
      });
    }

    if (canMountReachability) {
      reachability = mountReachabilityPanel({
        host: serverHosts['reachability']!,
        ...(opts.reachabilityReport !== undefined
          ? { report: opts.reachabilityReport }
          : {}),
        ...(opts.reachabilityExternalProbeCaller !== undefined
          ? { runExternalProbe: opts.reachabilityExternalProbeCaller }
          : {}),
      });
    }

    if (canMountHostnames) {
      // R27 delta-B — compose the Pro DDNS gate context: `published` + the
      // `<handle>.recued.net` hostname from `pro_convenience.status`, and the
      // self-disconnect check from the dialed `server_url` in the local store.
      // Needs the ddns callers AND the pro-convenience caller; absent → the
      // panel gets no context caller and renders no Pro DDNS section.
      const ddnsControlContextCaller: (() => Promise<DdnsControlContext>) | undefined =
        opts.ddnsStatusCaller !== undefined
        && opts.ddnsSetEnabledCaller !== undefined
        && opts.accountProConvenienceStatusCaller !== undefined
          ? async (): Promise<DdnsControlContext> => {
              const pro = await opts.accountProConvenienceStatusCaller!();
              const ddnsHostname = pro.ddns_hostname ?? null;
              const published = pro.items.ddns.state === 'active';
              let serverUrl: string | null = null;
              try {
                serverUrl = (await opts.localStore.get('server_url')) ?? null;
              } catch {
                serverUrl = null;
              }
              return {
                published,
                ddnsHostname,
                // Fail-closed self-disconnect guard: blocks when the dialed
                // host IS the handle OR can't be proven to differ.
                blockToggle: ddnsPauseWouldSelfDisconnect(serverUrl, ddnsHostname),
              };
            }
          : undefined;
      hostnames = mountHostnamesPanel({
        host: serverHosts['hostnames']!,
        document: doc,
        runList: opts.hostnamesListCaller as HostnamesListCaller,
        runGet: opts.hostnamesGetCaller as HostnamesGetCaller,
        runAdd: opts.hostnamesAddCaller as HostnamesAddCaller,
        runUpdate: opts.hostnamesUpdateCaller as HostnamesUpdateCaller,
        runRemove: opts.hostnamesRemoveCaller as HostnamesRemoveCaller,
        runVerifyOwnership:
          opts.hostnamesVerifyOwnershipCaller as HostnamesVerifyOwnershipCaller,
        ...(opts.networkLocalUrlsCaller !== undefined
          ? { runLocalUrls: opts.networkLocalUrlsCaller }
          : {}),
        ...(opts.reachabilityExternalProbeCaller !== undefined
          ? { runExternalProbe: opts.reachabilityExternalProbeCaller }
          : {}),
        // R27 delta-B — Pro DDNS toggle (all three wired together; the context
        // caller is the composed gate above).
        ...(ddnsControlContextCaller !== undefined
          ? {
              runDdnsStatus: opts.ddnsStatusCaller as DdnsStatusCaller,
              runDdnsSetEnabled: opts.ddnsSetEnabledCaller as DdnsSetEnabledCaller,
              runDdnsControlContext: ddnsControlContextCaller,
            }
          : {}),
        // R26.4 Delta 4 — forward the shared `now` seam so the cert-expiry
        // chip's relative copy is deterministic in tests.
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });

      // D-235 P5 — the Domains flow, mounted under the same Server → Hostnames
      // host and BELOW the registry list: a user arrives here having already
      // seen their existing hostnames, and the bring-your-own-domain path is
      // the thing they came to add.
      if (opts.customDomainPreflightCaller !== undefined) {
        const domainsHost = doc.createElement('div');
        serverHosts['hostnames']!.appendChild(domainsHost);
        customDomains = mountCustomDomainsPanel({
          host: domainsHost,
          document: doc,
          runPreflight: opts.customDomainPreflightCaller,
          ...(opts.customDomainReadinessCaller !== undefined
            ? { runReadiness: opts.customDomainReadinessCaller }
            : {}),
          // ⚠ Enrolment reuses the EXISTING add caller rather than a second
          //   one — one write path, one place where a hostname row is created,
          //   so the two surfaces cannot drift into disagreeing about what an
          //   enrolment is.
          ...(opts.hostnamesAddCaller !== undefined
            ? {
                runEnrol: async (args) => {
                  const result = await opts.hostnamesAddCaller!(args);
                  return result;
                },
                onEnrolled: () => { void hostnames?.refresh?.(); },
              }
            : {}),
        });
      }
    }

    if (hasCertificates) {
      const certsHost = serverHosts['certificates']!;
      // First in the tab: the installed-cert list + the BYO upload form. It
      // leads because it is the only thing on this tab a user can be BLOCKED
      // on — renewal and pin-staleness are both about certs that already
      // exist. `onUploaded` refreshes Hostnames so the row's cert-expiry chip
      // reflects the upload without a reload.
      if (canMountTlsCertificates) {
        const certsPanelHost = doc.createElement('div');
        certsHost.appendChild(certsPanelHost);
        tlsCertificates = mountTlsCertificatesPanel({
          host: certsPanelHost,
          document: doc,
          runList: opts.tlsDomainListCaller!,
          runUpload: opts.tlsDomainUploadCaller!,
          ...(opts.tlsDomainRemoveCaller !== undefined
            ? { runRemove: opts.tlsDomainRemoveCaller }
            : {}),
          ...(opts.now !== undefined ? { now: opts.now } : {}),
          onUploaded: () => { void hostnames?.refresh?.(); },
        });
      }

      if (opts.tlsRenewCaller !== undefined) {
        const tlsPanelHost = doc.createElement('div');
        certsHost.appendChild(tlsPanelHost);
        tlsRenew = mountTlsRenewPanel({
          host: tlsPanelHost,
          document: doc,
          runRenew: opts.tlsRenewCaller,
          ...(opts.now !== undefined ? { now: opts.now } : {}),
          ...(opts.onTlsRenewed !== undefined
            ? { onRenewed: opts.onTlsRenewed }
            : {}),
        });
      }

      if (opts.certPinWatcher !== undefined) {
        const certPinHost = doc.createElement('div');
        certsHost.appendChild(certPinHost);
        certPinStale = mountCertPinStalePanel({
          host: certPinHost,
          document: doc,
          watcher: opts.certPinWatcher,
          ...(opts.now !== undefined ? { now: opts.now } : {}),
        });
      }
    }

    // R26.4 Delta 3 — Key Health + Rotation Center. Gated on both the
    // `key.health` read + `key.rotate` callers (asserted by
    // `canMountKeyHealth`). The panel self-loads on mount.
    if (canMountKeyHealth) {
      keyHealth = mountKeyHealthPanel({
        host: serverHosts['key-health']!,
        document: doc,
        loadHealth: opts.keyHealthLoader!,
        runRotate: opts.keyRotateCaller!,
        // D-212 §7.10 — the keyfile posture card renders only when the
        // host wired a `system.status` reader.
        ...(opts.systemStatusLoader !== undefined
          ? { loadSystemStatus: opts.systemStatusLoader }
          : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });
    }

    // R25 — Maintenance: the 11 core housekeeping tasks' status + Run-now,
    // graduated out of the Housekeeping config page. Reuses the shared
    // housekeeping status.read + task.run_now seams.
    if (canMountMaintenance) {
      maintenance = mountMaintenancePanel({
        host: serverHosts['maintenance']!,
        runStatusRead: opts.housekeepingPanelStatusReadCaller as HousekeepingStatusReadCaller,
        ...(opts.housekeepingPanelRunNowCaller !== undefined
          ? { runRunNow: opts.housekeepingPanelRunNowCaller }
          : {}),
        ...(opts.maintenanceServerStatusCaller !== undefined
          ? { runServerStatus: opts.maintenanceServerStatusCaller }
          : {}),
        ...(opts.maintenanceReclaimCaller !== undefined
          ? { runReclaim: opts.maintenanceReclaimCaller }
          : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
      });
    }

    registerSubview('server', 'Server', serverSection);
  }

  // ── Build the rail + activate the initial subview ─────────────────
  // One rail item per registered section, in mount order. A click
  // activates that subview (no scroll — it's already at the top); a
  // deep-link `#settings/<id>` (opts.initialSectionId) activates +
  // scroll-focuses its section for accessibility. An absent / unknown id
  // falls back to the first subview so the surface is never blank.
  //
  // The created nav-item elements are tracked in `navItems` so
  // `activateSubview` never has to read `navEl.children` — some fake
  // DOMs in the test suite don't implement a live `children` collection.
  const navItems: Array<{ id: string; el: HTMLElement }> = [];
  const activateSubview = (
    id: string,
    behaviour: { scroll: boolean },
  ): void => {
    for (const sv of subviews) {
      sv.section.setAttribute(
        SETTINGS_ROUTE_ACTIVE_ATTR,
        sv.id === id ? 'true' : 'false',
      );
    }
    for (const { id: itemId, el } of navItems) {
      const active = itemId === id;
      el.setAttribute(SETTINGS_ROUTE_ACTIVE_ATTR, active ? 'true' : 'false');
      if (active) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
    // On narrow screens the rail is a horizontal overflow strip. A deep link
    // to a later section (notably Server) otherwise activates content whose
    // only location cue remains far outside the visible strip. Keep the active
    // item in view for both deep links and in-page switches; `nearest` is a
    // no-op when it is already visible and avoids disturbing page position.
    const activeNavItem = navItems.find((item) => item.id === id)?.el;
    activeNavItem?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (behaviour.scroll) {
      const target = subviews.find((sv) => sv.id === id)?.section;
      if (target !== undefined) {
        target.setAttribute('tabindex', '-1');
        target.scrollIntoView?.({ block: 'start', inline: 'nearest' });
        target.focus?.({ preventScroll: true });
      }
    }
  };

  for (const sv of subviews) {
    const item = doc.createElement('button');
    item.setAttribute('type', 'button');
    item.setAttribute(SETTINGS_ROUTE_NAV_ITEM_ATTR, sv.id);
    item.textContent = sv.label;
    if (sv.badgeable === true) {
      // An empty dot span appended AFTER the label text node — keeps the item's
      // textContent equal to the label (tests + a11y read the label) while the
      // route toggles the dot's `hidden` attribute via `setSubviewBadge`.
      const badge = doc.createElement('span');
      badge.className = 'settings-nav-badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.setAttribute('hidden', '');
      item.appendChild(badge);
      navBadges.set(sv.id, badge);
    }
    item.addEventListener('click', () => activateSubview(sv.id, { scroll: false }));
    navEl.appendChild(item);
    navItems.push({ id: sv.id, el: item });
  }

  const requestedSectionId = opts.initialSectionId?.trim();
  const deepLinked =
    requestedSectionId !== undefined
    && requestedSectionId.length > 0
    && subviews.some((sv) => sv.id === requestedSectionId);
  const initialSubviewId = deepLinked
    ? (requestedSectionId as string)
    : (subviews[0]?.id ?? null);
  if (initialSubviewId !== null) {
    activateSubview(initialSubviewId, { scroll: deepLinked });
  }

  let disposed = false;
  return {
    update: () => {
      /* v1 has no per-broadcast update path */
    },
    hasInFlightWork: () => {
      if (disposed) return false;
      if (panel.getState() === 'busy') return true;
      if (notifications?.hasInFlightWork() === true) return true;
      if (aiModels?.hasInFlightWork() === true) return true;
      if (accountBinding?.hasInFlightWork() === true) return true;
      if (devicesPage?.hasInFlightWork() === true) return true;
      if (updatesPage?.hasInFlightWork() === true) return true;
      if (learningPanel?.hasInFlightWork() === true) return true;
      if (transparencyPanel?.hasInFlightWork() === true) return true;
      if (archiveBackup === null) return false;
      const archiveView = archiveBackup.getView();
      return archiveView === 'export-running'
        || archiveView === 'restore-uploading'
        || archiveView === 'restore-busy'
        || archiveView === 'passport-exporting'
        || archiveBackup.isDownloading();
    },
    hasUnsavedChanges: () => {
      if (disposed) return false;
      return notifications?.hasUnsavedChanges() === true
        || learningPanel?.hasUnsavedChanges() === true;
    },
    unsavedChangesPrompt: () => {
      if (disposed) return null;
      if (notifications?.hasUnsavedChanges() === true) {
        return 'Discard the unsaved notification verification phrase?';
      }
      return learningPanel?.hasUnsavedChanges() === true
        ? 'Discard the finished recipe draft?'
        : null;
    },
    inFlightWorkPrompt: () => {
      if (disposed) return null;
      if (notifications?.hasInFlightWork() === true) {
        return 'A notification setting is still updating. Leave Settings anyway?';
      }
      if (aiModels?.hasInFlightWork() === true) {
        return 'An AI model setting is still updating. Leave Settings anyway?';
      }
      if (accountBinding?.hasInFlightWork() === true) {
        return 'An account setting is still updating. Leave Settings anyway?';
      }
      if (devicesPage?.hasInFlightWork() === true) {
        return 'A device revoke is still updating. Leave Settings anyway?';
      }
      if (updatesPage?.hasInFlightWork() === true) {
        return 'A server update change is still in progress. Leave Settings anyway?';
      }
      if (transparencyPanel?.hasInFlightWork() === true) {
        return 'A transparency setting is still updating. Leave Settings anyway?';
      }
      return learningPanel?.hasInFlightWork() === true
        ? 'A learning change is still updating. Leave Settings anyway?'
        : null;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Dispose in reverse construction order so any in-flight
      // listener wired by a child panel detaches before the parent
      // section node is removed.
      if (certPinStale !== null) certPinStale.dispose();
      if (keyHealth !== null) keyHealth.dispose();
      if (tlsRenew !== null) tlsRenew.dispose();
      if (tlsCertificates !== null) tlsCertificates.dispose();
      if (hostnames !== null) hostnames.dispose();
      if (customDomains !== null) customDomains.destroy();
      if (reachability !== null) reachability.dispose();
      // R26.2 Delta 1 — the Exposure grid was constructed first in the
      // Server section; its dispose drops the `exposure_changed` broadcast
      // subscription before the section node is removed.
      if (exposure !== null) exposure.dispose();
      if (maintenance !== null) maintenance.dispose();
      if (housekeepingPanel !== null) housekeepingPanel.dispose();
      // Permissions and Connections now live on top-level routes; their legacy
      // Settings accessors remain null, so there is no Settings child mount to
      // tear down here.
      if (permissions !== null) permissions.dispose();
      if (notifications !== null) notifications.dispose();
      // D-187 §6 follow-on — Packs / Local tools / cli grant dialog dispose
      // moved to the `#packs` route.
      if (devicesPage !== null) devicesPage.dispose();
      // R29 — Privacy is a directory now: the only disposable panels it
      // hosts are the folded-in Transparency block + the local
      // clear-this-browser wipe. (The former Contracts panel moved to the
      // `#contracts` route; the egress panel was retired by D-191.)
      panel.dispose();
      if (transparencyPanel !== null) transparencyPanel.dispose();
      if (learningPanel !== null) learningPanel.dispose();
      if (updatesPage !== null) updatesPage.dispose();
      if (sellerPage !== null) sellerPage.dispose();
      if (aiModels !== null) aiModels.dispose();
      if (accountBinding !== null) accountBinding.dispose();
      if (archiveBackup !== null) archiveBackup.dispose();
      routeRoot.remove();
    },
    clearThisBrowserPanel: () => panel,
    tlsRenewPanel: () => tlsRenew,
    tlsCertificatesPanel: () => tlsCertificates,
    keyHealthPanel: () => keyHealth,
    exposurePanel: () => exposure,
    certPinStalePanel: () => certPinStale,
    devicesPage: () => devicesPage,
    notificationsPanel: () => notifications,
    connectionsEnrollPanel: () => null,
    permissionsPanel: () => permissions,
    contractsPanel: () => null,
    aiModelsPage: () => aiModels,
    sellerPage: () => sellerPage,
    updatesPage: () => updatesPage,
    transparencyPanel: () => transparencyPanel,
    learningPanel: () => learningPanel,
    llmResultCacheCard: () => aiModels?.cacheCard() ?? null,
    hostnamesPanel: () => hostnames,
    reachabilityPanel: () => reachability,
    accountBindingPanel: () => accountBinding,
    archiveBackupPanel: () => archiveBackup,
  };
};
