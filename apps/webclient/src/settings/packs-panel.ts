/** D-145 PA10 follow-on — Settings → Packs panel (Slices A–K).
 *
 *  Surfaces the per-pair pack roster the server returns via `packs.list`
 *  (bundled resolution + the Add-a-pack marketplace path). LIST rows are
 *  the R22.1 slim shape (name + badges + version + Install/Delete); the
 *  full facts live in the `#packs/<slug>` detail's IDENTITY / ACCESS /
 *  DECLARES / ABOUT sections.
 *
 *  ── Slice K: post-success runnability disclosure notice ────────────
 *  R2 build step 4 (recipe-identity doc §1.6) — the install result's
 *  born_blocked/born_degraded (4c.2) and the uninstall result's
 *  would_disable (4c.3) are the derived-runnability disclosures the
 *  #recipes route's pack modal already renders. This panel's success
 *  paths CLOSE their affordance + refresh, so without a surviving
 *  surface the disclosure would silently drop here. Slice K renders a
 *  dismissible warn-tone notice above the list after a successful
 *  install / uninstall whose result carries disclosure blocks; the
 *  copy comes from `@recued/ui-shared` builders so this panel and the
 *  #recipes route speak the same language. Disclosure over the D-157
 *  gate, NOT enforcement — a blocked recipe stays installed and
 *  recovers when a provider binds. Lifecycle in DD#15.
 *
 *  ── Slice J: cross-pack body-grant overlap disclosure ──────────────
 *  Body-grants are additive across packs by engine design (the grant
 *  store is a set-union, see `packs-collisions.ts:31-33` for the
 *  rationale Slice C used to deliberately exclude grants from collision
 *  detection). The user's mental model often misses this: uninstall is
 *  assumed to release the grant, but if another installed pack also
 *  declares the same key, the grant stays alive. Slice J surfaces the
 *  overlap on TWO surfaces in parallel — install dialog renders an
 *  additive disclosure ("already accessible via X") under the body-
 *  grants list to reassure the user the install doesn't widen
 *  exposure; uninstall delete strip renders a sticky disclosure
 *  ("remains accessible via X") under the body-grant release list to
 *  correct the mental-model gap. Both surfaces consume the same
 *  `PackGrantOverlap` map (`packs-grant-overlap.ts:computePackGrantOverlaps`)
 *  computed once per render alongside the Slice C recipe-collision map.
 *  Today's corpus (one grant key + one declaring pack) yields zero
 *  renders, so the disclosure is latent — it lights up the moment a
 *  second pack declares the same body-grant.
 *
 *  ── Slice I: install-dialog body-grant gate parity ─────────────────
 *  Lands the same defensive symmetry as Slice G's Angle-2 MINOR fold,
 *  this time on the install dialog's DD#4 body-content callout. The
 *  callout now gates on `manifest.mcp_body_visibility_grants` array
 *  content (`grants.length > 0`) instead of the derived
 *  `body_visibility_grant_count`, so any future drift between
 *  manifest + `PackListEntry` derivation cannot surface an empty
 *  heading + empty `<ul>` on the install side either. Install +
 *  uninstall surfaces now read the same source field through the
 *  same gate.
 *
 *  ── Slice H: stale-load generation guard ───────────────────────────
 *  Closes the 304th Slice D MINOR finding. `refreshRows` increments a
 *  panel-local `loadGeneration` integer before awaiting `runList`, then
 *  re-checks `captured === loadGeneration` after the await. When two
 *  events fire in quick succession (e.g. a `pack_installed` + a
 *  `pack_uninstalled` broadcast hitting the bus together, or a manual
 *  refresh + a bus event in the same microtask), without the guard the
 *  older call's response could land AFTER the newer call's, overwriting
 *  the fresher `packs` state with stale data. With the guard, only the
 *  freshest awaited result writes — older racers drop silently. The
 *  same fix lands on the cache-card mount
 *  (`llm-result-cache-card-mount.ts`) — both surfaces share refresh
 *  shape so the fix is symmetric. See DD#14.
 *
 *  ── Slice G: symmetric uninstall body-grant disclosure ─────────────
 *  Mirrors the install dialog's DD#4 body-content callout on the
 *  Delete confirm strip so the user sees the body access they are
 *  RELEASING before clicking Confirm delete (install shows "will
 *  access", delete shows "will release"). Same source data
 *  (`manifest.mcp_body_visibility_grants`), same `<ul>` shape. Renders
 *  only when the Delete affordance is visible (`showDelete`), the
 *  manifest's grants array is non-empty (`grants.length > 0` —
 *  Slice G's Angle-2 MINOR fold gates on actual array content rather
 *  than the derived `body_visibility_grant_count` so the heading +
 *  list always appear together), and the row's confirm strip is
 *  currently armed. Slice I landed the same defensive symmetry on
 *  the install dialog's DD#4 callout. Today the closed list
 *  carries one key (`data.contact.engagements.body_content`); only
 *  `crm-commitment-tracker` declares it. Cross-pack overlap (one grant
 *  held by multiple packs) doesn't disclose anything today because
 *  the closed list + corpus is single-pack — deferred until more
 *  packs / keys land.
 *
 *  ── R22.1 / R1.3: detail re-layout + slim rows + Delta 6 ──────────
 *  The `#packs/<slug>` DETAIL view renders IDENTITY (name · badges ·
 *  slug/publisher/version · repo link · Install/Delete affordances +
 *  inline consent dialog) · ACCESS (placeholder — the by-PACK
 *  contract×op grant panel is R3; links to #contracts meanwhile) ·
 *  DECLARES (recipe/body-content counts + the connection-readiness
 *  block + the supervised-daemon controls) · ABOUT (description ·
 *  tags · cross-pack collision notice). LIST rows slimmed to name +
 *  badges + version (+ a service-kind badge on Discover rows) + the
 *  action affordances — description/counts/collision/supervision/
 *  readiness all live in the detail now. Delta 6 deleted the Slice E
 *  "Show advanced" reveal toggle: foundation packs expose Delete
 *  directly and the confirm strip's boot-time-undo warning ("This
 *  pack auto-installs at server boot…") is the safeguard.
 *
 *  ── Slice D: live broadcast subscription ──────────────────────────
 *  Optional `subscribe?: BroadcastSubscriber['on']` mount option wires
 *  the panel to the D-121 bus. When provided, the mount subscribes to
 *  `pack_installed` + `pack_uninstalled` on creation and triggers a
 *  full `refreshRows()` whenever either fires. Drives cross-tab /
 *  cross-device refresh: an install on the user's laptop webclient
 *  flips the Installed badge on the user's phone webclient + Bridge
 *  popover without a Refresh click. Dispose unsubscribes; failures
 *  in the unsubscribe call are swallowed so a teardown error never
 *  blocks dispose. Mirrors the cache card's DD#7 pattern.
 *
 *  ── Slice C: cross-pack recipe collision UI ────────────────────────
 *  When two packs in the loaded list ship the same recipe slug, the
 *  install transaction's per-slug upsert silently overwrites whichever
 *  version was already stored — the user has no surface telling them
 *  which pack actually "owns" the stored recipe. Slice C surfaces the
 *  overlap at three points:
 *    - each row gains a yellow-toned "Shares N recipes with [pack-x,
 *      pack-y]" callout when its manifest overlaps any sibling pack;
 *    - the install dialog's recipe list marks colliding entries inline
 *      with " — also in pack-x";
 *    - the install dialog renders a per-other-pack collision callout
 *      grouping the overlapping slugs ("pack-x: bar, baz") so the user
 *      knows which other pack(s) they're about to overwrite from.
 *  Detection lives in `packs-collisions.ts` — pure function over the
 *  panel's `packs` array, recomputed once per render in `renderReady`.
 *
 *  ── Slice A: list + install ────────────────────────────────────────
 *  Non-installed bundled packs expose an Install affordance that opens
 *  an inline install dialog. The dialog surfaces the manifest's
 *  `requires[]` as permission checkboxes (default-checked) + a body-
 *  content callout when `mcp_body_visibility_grants` is non-empty, then
 *  fires `packs.install` with the user-approved permission set.
 *
 *  ── Slice B: per-row Delete + two-stage confirm ────────────────────
 *  Installed non-foundation packs expose a Delete affordance: a
 *  two-stage inline confirm strip (`Delete → [Confirm delete] [Cancel]`,
 *  mirroring devices-page-mount DD#2 + SI panel Slice 1.5). On confirm,
 *  the panel fires `packs.uninstall` with `pack_slug`, then refreshes
 *  the list so the just-uninstalled pack flips back to its Install
 *  affordance. Foundation packs (`pre_install: true`) hide the Delete
 *  button — `foundation-pack-pre-install.ts` would re-install on next
 *  boot, so surfacing Delete on a foundation pack would render a
 *  destructive action the next reboot quietly undoes. ⚠ That reasoning is now
 *  enforced at the rpc instead: `packs.uninstall` REFUSES a core pack, so the
 *  "power-user scripted scenarios can still call it directly" escape this
 *  paragraph once described is closed.
 *
 *  ⛔ FOUNDATION BRANCHES ARE UNREACHABLE SINCE 2026-09-07, and the paragraph
 *  that stood here described behaviour the server no longer produces. The
 *  owner's ruling split the two kinds: a `pre_install` pack is a CORE FEATURE
 *  the server installs and the owner cannot manage, so `packs.list` never lists
 *  one, and `packs.install` / `packs.uninstall` / `packs.resolveBySlug` refuse
 *  it outright. Every row this panel can receive is an ordinary pack.
 *
 *  So the `pre_install` badge, the foundation Delete warning and the
 *  failed-auto-install retry path below are DEAD CODE, kept only because
 *  removing them touches ten test files and no behaviour. They are documented
 *  rather than left to be re-derived — a stale claim in this header is how the
 *  server's own gap doc came to assert an absence that had already been fixed.
 *  See internal design notes.
 *
 *  ── Three exports ──────────────────────────────────────────────────
 *    - `mountPacksPanel(opts)` — DOM-construction mount. Returns a
 *      handle with `dispose()` / `getState()` + test seams.
 *    - `PACKS_PANEL_STYLES` — self-scoped CSS the host injects once at
 *      boot (the Settings route bundles this alongside the other
 *      section panel styles).
 *    - `PACKS_PANEL_*` attribute constants — stable hooks for DOM-based
 *      tests.
 *
 *  ── State machine ──────────────────────────────────────────────────
 *
 *      mount ── runList resolved ──▶ ready
 *      mount ── runList threw     ──▶ error
 *      error ── click Retry       ──▶ loading ── … ──▶ ready | error
 *
 *  Per-row (install dialog substate):
 *      ready ── click Install on row r       ──▶ dialog { open, packSlug: r }
 *      dialog ── click Cancel                ──▶ closed
 *      dialog ── click Install               ──▶ installing (button aria-disabled)
 *      installing ── rpc resolved + ok=true  ──▶ refresh list + dialog closed
 *      installing ── rpc resolved + ok=false ──▶ dialog stays open + inline error
 *                                                 (failure.code drives copy)
 *      installing ── rpc threw               ──▶ dialog stays open + inline error
 *
 *  Per-row (Slice B Delete substate — independent of install dialog):
 *      ready ── click Delete on row r          ──▶ confirming { packSlug: r }
 *      confirming ── click Cancel              ──▶ closed
 *      confirming ── click Confirm delete      ──▶ deleting (button aria-disabled)
 *      deleting ── rpc resolved + ok=true      ──▶ refresh list + confirm closed
 *      deleting ── rpc resolved + ok=false     ──▶ confirm stays open + inline error
 *                                                   (failure.code drives copy)
 *      deleting ── rpc threw                   ──▶ confirm stays open + inline error
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Caller seams are narrow Promise functions, not a baked-in
 *  `Conn<ServerRpcRegistry>` reference. The route wires
 *  `() => conn('packs.list', undefined)` + `(args) => conn(
 *  'packs.install', args)` from the bootstrap's rpc conn so the panel
 *  stays agnostic. Tests inject fakes.
 *
 *  DD#2 — Single-row install dialog (mirrors devices-page-mount DD#2).
 *  Opening the dialog on row B collapses A in the same render pass.
 *  Multi-row install would race the refresh promise + create
 *  ambiguity in the "which install is in-flight" UX. v1 is single-row.
 *
 *  DD#3 — Permissions default-checked. `manifest.requires[]` represents
 *  the pack author's stated needs; the user can uncheck individual
 *  entries but the default surface assumes consent. The
 *  `BULK_PACK_INSTALL_PERMISSION` row is always rendered first +
 *  disabled (un-uncheckable) — without it the rpc rejects with
 *  `permission_denied`, so letting the user toggle it would surface a
 *  failure the dialog already prevented.
 *
 *  DD#4 — Body-content grants render as a separate read-only callout
 *  in the dialog (NOT a checkbox). The engine applies grants
 *  automatically as part of the install transaction — there is no per-
 *  grant rpc consent surface. The callout is the disclosure UX: the
 *  user sees the body keys before clicking Install, the install button
 *  remains the single consent action.
 *
 *  DD#5 — Render-on-transition rebuild. Same pattern as the Standing
 *  Instructions panel + the Conflicts panel. Every state change
 *  rebuilds the panel's inner DOM via `createElement` + new event
 *  listeners. Cleaner than incremental DOM patching for a substrate
 *  whose row count is bounded at ~10 (8 bundled packs ship today) and
 *  whose interactions are click-driven.
 *
 *  DD#6 — Per-pack permission selection is panel-local mutable state
 *  (Map keyed on pack slug). The install dialog reads from this map on
 *  every render so partial user input survives a re-render (e.g. when
 *  another pack's install resolves + the list refreshes while this
 *  dialog is open). Map entries clear on dialog close.
 *
 *  DD#7 — Errors surface inline in the dialog body, not in a toast or
 *  on the row. The error chip stays until the next successful install
 *  OR until the user clicks Cancel (closing the dialog clears it so
 *  the next open starts clean). Mirrors SI panel DD#5.
 *
 *  DD#8 — Refresh after successful install. The dialog closes + the
 *  panel re-fetches `packs.list` so the just-installed pack flips its
 *  `installed` badge without the user needing to click Refresh. Tests
 *  observe the post-install refresh via the test seam's awaited
 *  promise.
 *
 *  ── Slice B design decisions ───────────────────────────────────────
 *
 *  DD#9 — Single-row Delete confirm. Mirrors devices-page-mount DD#2 +
 *  SI Slice 1.5: opening the Delete strip on pack B collapses A's
 *  strip in the same render pass. The install dialog state is
 *  independent — a user mid-install on pack A can open the Delete
 *  strip on pack B without forcibly closing the dialog, because the
 *  two surfaces target different pack slugs (the install dialog's pack
 *  is still in flight; B's Delete is a separate operation). However,
 *  opening the install dialog on the same pack whose Delete strip is
 *  open collapses the Delete strip (one surface per row).
 *
 *  DD#10 — Cross-affordance disable, not collapse, when in-flight. A
 *  pack with an in-flight install or delete rpc disables BOTH
 *  affordances on that row (the post-rpc refresh will reconcile state
 *  cleanly); other rows' affordances stay enabled. Two parallel
 *  installs on different packs would race the refresh promise + create
 *  ambiguity in the "which install just landed" UX — so the single
 *  install in-flight invariant survives Slice B: opening any new
 *  install dialog OR Delete strip is gated on `!installing && !deleting`.
 *
 *  DD#11 (amended by Delta 6) — Foundation pack Delete disclosure.
 *  Packs with `pre_install: true` expose Delete like any installed
 *  pack; the boot loop's `foundation-pack-pre-install.ts` re-installs
 *  them on the next start, so the confirm strip renders a boot-time-
 *  undo warning above the buttons — the user reads the futility
 *  before Confirm. (The original DD#11 hid Delete behind Slice E's
 *  "Show advanced" toggle; Delta 6 deleted the toggle as vestigial —
 *  it only ever revealed this one affordance.)
 *
 *  DD#12 — Refresh after successful uninstall. Mirrors DD#8 — the
 *  confirm strip closes + the panel re-fetches `packs.list` so the
 *  just-uninstalled pack's `installed` badge flips back to the
 *  Install affordance.
 *
 *  ── Slice H design decisions ───────────────────────────────────────
 *
 *  DD#14 — Stale-load generation guard. Two-event races (e.g. a
 *  `pack_installed` broadcast immediately followed by a `pack_uninstalled`
 *  broadcast, or a manual `refresh()` overlapping a bus event) trigger
 *  back-to-back `refreshRows` calls. Without a guard, the older call's
 *  awaited `runList` rpc could resolve AFTER the newer call's, and its
 *  `packs = [...result.packs]` assignment would overwrite the fresher
 *  state. The fix: `refreshRows` increments `loadGeneration` before the
 *  await + captures the value; after the await, re-checks `captured ===
 *  loadGeneration` and drops if a newer load is in flight. Same logic
 *  guards the error path so a stale rpc throw can't paint `'error'` on
 *  top of a fresher success. The `transitionTo('loading')` paint
 *  happens BEFORE the await so the panel is always in `loading` while
 *  the freshest load is in flight; stale results never trigger state
 *  transitions, so the only painter is the freshest awaited result.
 *
 *  ── Slice K design decisions ───────────────────────────────────────
 *
 *  DD#15 — Disclosure notice lifecycle. The notice SURVIVES refreshes
 *  (the post-success auto-refresh + bus-driven `refreshRows` would
 *  otherwise wipe it the instant it appeared) and clears on exactly
 *  three events: the user clicks Dismiss; a NEW install / uninstall
 *  submit kicks off (the notice describes the LAST COMPLETED action —
 *  an in-flight action invalidates it); or the next success replaces
 *  it (a success with no disclosure blocks sets it null, so the
 *  surface is zero-noise on ordinary installs). Renders only in
 *  `'ready'` — the loading repaint hides it transiently, matching the
 *  whole-panel repaint discipline (DD#5). Gated on `result.ok`: the
 *  contract marks born_blocked / born_degraded / would_disable
 *  success-path only, and a failure render would contradict the
 *  failure copy beside it.
 *
 *  Spec: D-145 § PA10 (pack-shipped Standing Instructions
 *  + Settings UI prescription); the R22.1 detail layout is locked in
 *  the webclient-ia treemap §PACKS. */

import type {
  BulkPackInstallResultLike,
  BulkPackManifest,
  PackContentRef,
  BulkPackUninstallResultLike,
  ConnectionRequirement,
  EndpointCandidate,
  InstallAccessTier,
  InstallAudienceSelection,
  InstallGrantSelection,
  InstallScopeWho,
  MailTemplateInstallChoice,
  PackDependencyInstallScope,
  PackListEntry,
  PacksResolveResult,
  PackServiceKind,
  SellerOverview,
  ServerRecipeListEntry,
} from '@recued/contracts';
// The Use tab — the pack rendered as the app it is. The model derives the
// view / operation split (and owns why a view is safe to run on selection);
// the view is the surface over it.
import {
  hasAppSurface,
  buildPackAppIndex,
  packAppSurface,
  rosterForUsage,
  type PackAppSurface,
} from '../packs/pack-app-model.js';
import {
  mountPackAppView,
  type PackAppExecuteCaller,
  type PackAppRecordRefSearchCaller,
  type PackAppViewMount,
} from '../packs/pack-app-view.js';
import type { ResultFileReadResult } from '../recipes/recipe-result-panel.js';
// R22 — value imports for the Installed section's service_kind kind-grouping.
// D-194 2b-2 — the pack's connection requirement (interim seed) + the
// endpoint-match candidate lookup that feeds the install dialog's Connect section.
import {
  findEndpointCandidates,
  getSeededConnectionRequirements,
  isPackServiceKind,
} from '@recued/contracts';
import type { BadgeTone } from '@recued/ui-shared/primitives';
// D-182 §7.1 / D-196 — the {Access × Audience} install picker. It renders for
// any pack with connection-backed ops or recipe tools so the install rpc carries
// `install_scope`. Pure-cli packs with no recipe tools still have no grantable
// model; cli authority remains in the post-install grant dialog.
import {
  INSTALL_GRANT_ACCESS_OPTION_ATTR,
  INSTALL_GRANT_AUDIENCE_DETAIL_OPTION_ATTR,
  INSTALL_GRANT_SCOPE_OPTION_ATTR,
  installAudienceFromLegacyScope,
  resolveInstallAudienceSelection,
  type InstallAudienceOption,
  type InstallGrantPickerModel,
} from './install-grant-picker.js';
// Pre-install permission disclosure — the read-only "what installing would allow"
// projection of a resolved manifest, rendered where the owner-override matrix cannot
// exist yet. See the module header for why a blank was the wrong answer.
import { renderPackPermissionPreview } from './pack-permission-preview.js';
// D-194 2b-2 — the Connect section's pick resolver (validates an explicit pick
// against the live candidate list; falls back to the pre-selected default).
import {
  INSTALL_CONNECT_CANDIDATE_ATTR,
  INSTALL_CONNECT_CUSTOMIZE_ATTR,
  INSTALL_CONNECT_NONE_ATTR,
  resolveChosenConnection,
} from './install-connect-picker.js';
// R2 — the install/consent dialog RENDER + its attrs / copy / failure-copy /
// Access-tier clamp live in `packs-install-dialog.ts`; the dialog STATE
// MACHINE (open/close/collapse/reconcile + the permission/tier maps) stays
// HERE — see that module's header for the deliberate boundary.
import {
  ALWAYS_REQUIRED_PERMISSION,
  GRANT_OVERLAP_ALSO_VIA_PREFIX,
  PACKS_DIALOG_ATTR,
  PACKS_DIALOG_CANCEL_BTN_ATTR,
  PACKS_DIALOG_INSTALL_BTN_ATTR,
  PACKS_DIALOG_OWNER_OPERATION_REVIEW_ITEM_ATTR,
  PACKS_DIALOG_PERMISSION_ATTR,
  PACKS_DIALOG_SLUG_ATTR,
  dependencyPacksToChoose,
  installDialogGrantModel,
  installFailureCopy,
  installRefusalFromPreview,
  missingPacksFromFailure,
  missingPacksToInstallFirst,
  renderPacksInstallDialog,
  resolveDependencyAccess,
  resolveInstallDialogAccess,
  resolveInstallDialogAudience,
} from './packs-install-dialog.js';
import type { InstallMailTemplateChoice, InstallPreview, InstallWebhookChoice } from './packs-install-dialog.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
// Slice C — cross-pack recipe collision detection. Pure function over
// the panel's `packs` array; recomputed on every render (cheap: bounded
// at ~10 packs × 50 recipes). The panel threads the per-pack result into
// the detail's About notice + the install dialog's callout / markers.
import {
  computePackRecipeCollisions,
  type PackRecipeCollision,
} from './packs-collisions.js';
// Slice J — cross-pack body-grant overlap detection. Pure function over
// the panel's `packs` array; recomputed on every render (cheap: bounded
// at ~10 packs × 16 grants). Body-grants are additive across packs by
// engine design (Slice C deliberately skipped them); Slice J surfaces
// the overlap as informational disclosure: install side reassures
// "already granted via X", uninstall side corrects "remains granted via X".
import {
  computePackGrantOverlaps,
  type PackGrantOverlap,
} from './packs-grant-overlap.js';
// Supervision feature (Slice 4) — pack-detail supervised-daemon controls. The
// controller owns the `supervision.list` state + optimistic-set flow; the panel
// instantiates one, refreshes it alongside `packs.list`, and renders it per row.
import {
  createSupervisionController,
  type SupervisionController,
  type SupervisionListCaller,
  type SupervisionReachabilityCaller,
  type SupervisionSetCaller,
} from './supervision-controls.js';
// Connections readiness — pack-row scope-coverage block (read-only sibling of
// supervision): per OAuth-scoped connection the pack declares, is an enrolled
// connection scoped to cover it (reuse) or missing / under-scoped (set up /
// re-authorize)? Instantiated + refreshed + rendered + disposed like supervision.
import {
  createConnectionsReadinessController,
  type ConnectionsReadinessController,
  type ConnectionsReadinessListCaller,
} from './connections-readiness-controls.js';
// R3 — the by-PACK Access panel (contract-first nested list over the pack's
// catalog ops; the SECOND axis of the one grant matrix). Fills the detail's
// ACCESS section when its read callers are wired; the placeholder copy stays
// otherwise. Same controller lifecycle as supervision / readiness.
import {
  createPackAccessController,
  type PackAccessController,
} from './pack-access-controls.js';
import {
  createOwnerOperationController,
  type OwnerOperationController,
  type OwnerOperationDeleteCaller,
  type OwnerOperationInventoryCaller,
  type OwnerOperationListCaller,
  type OwnerOperationUpsertCaller,
} from './owner-operation-controls.js';
import type {
  GrantCatalogOperationsCaller,
  GrantCliReachabilityListCaller,
  GrantCliReachabilitySetCaller,
  GrantContractsCaller,
  GrantReadCaller,
  GrantWriteCaller,
} from '../contracts/contract-grants-panel.js';
// Slice K — shared install/uninstall runnability disclosure copy. The
// builders own the user-facing language (headlines + per-recipe detail)
// so this panel and the #recipes route's pack modal cannot drift; the
// panel renders the returned blocks via createElement/textContent.
import {
  connectionHintSetupSlug,
  installDisclosureBlocks,
  uninstallDisclosureBlocks,
  type PackDisclosureBlock,
} from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for DOM tests + host introspection
// ════════════════════════════════════════════════════════════════

export const PACKS_PANEL_ATTR = 'data-recued-packs-panel';
export const PACKS_PANEL_STATE_ATTR = 'data-recued-packs-panel-state';
export const PACKS_RETRY_BTN_ATTR = 'data-recued-packs-retry';
export const PACKS_EMPTY_ATTR = 'data-recued-packs-empty';
export const PACKS_LIST_ERROR_ATTR = 'data-recued-packs-list-error';
export const PACKS_ROW_ATTR = 'data-recued-packs-row';
export const PACKS_ROW_SLUG_ATTR = 'data-recued-packs-row-slug';
export const PACKS_ROW_INSTALL_BTN_ATTR = 'data-recued-packs-row-install';
/** Placeholder standing in for the consent dialog while the manifest loads. */
export const PACKS_DIALOG_PENDING_ATTR = 'data-recued-packs-dialog-pending';
// R22 list→detail — the row's name-as-button (LIST view opens the detail) +
// the detail view's Back-to-list control.
export const PACKS_ROW_SELECT_ATTR = 'data-recued-packs-row-select';
export const PACKS_DETAIL_BACK_ATTR = 'data-recued-packs-detail-back';
// Pack detail sub-navigation. Permissions owns the global owner replacement
// for pack-authored risk / approval defaults; Access remains the per-contract
// reachability matrix.
export const PACKS_DETAIL_TABS_ATTR = 'data-recued-packs-detail-tabs';
/** D-282 slice C — the pin-to-drawer control. Value is the STATE
 *  (`pinned` / `unpinned`) so a test pins the state rather than the label. */
export const PACKS_DETAIL_PIN_ATTR = 'data-recued-packs-detail-pin';
export const PACKS_DETAIL_TAB_ATTR = 'data-recued-packs-detail-tab';
export const PACKS_DETAIL_TAB_GROUP_ATTR = 'data-recued-packs-detail-tab-group';
export const PACKS_DETAIL_TAB_PANEL_ATTR = 'data-recued-packs-detail-tab-panel';
/** Pack-detail subviews. `use` is the pack AS AN APP (its views + actions);
 *  the other three are the control-plane surfaces, grouped behind Manage.
 *  A pack that owns no runnable recipes never reaches `use` — see
 *  `hasAppSurface`. */
export type PacksDetailTab = 'use' | 'detail' | 'permissions' | 'access';

/** The three subviews that sit behind Manage. `use` is the sibling of the
 *  whole group, not a member of it. */
const MANAGE_TABS: ReadonlyArray<PacksDetailTab> = ['detail', 'permissions', 'access'];
type PacksDetailTabGroup = 'primary' | 'manage';

const PACKS_DETAIL_TAB_PANEL_ID = 'recued-packs-detail-tab-panel';
const packsDetailTabDomId = (
  group: PacksDetailTabGroup,
  id: PacksDetailTab,
): string => `recued-packs-detail-${group}-${id}-tab`;

type PacksDeleteActionFocus = {
  kind: 'delete' | 'confirm' | 'cancel';
  slug: string;
};

type PacksInstallDialogFocus =
  | { kind: 'dialog'; slug: string }
  | { kind: 'opener'; slug: string }
  | { kind: 'submit'; slug: string }
  | { kind: 'cancel'; slug: string }
  | {
      kind: 'control';
      slug: string;
      identity: ReadonlyArray<readonly [attribute: string, value: string]>;
    };
// R22 3-section LIST — the section wrapper carries `data-section`
// (`installed` / `discover` / `add`); the Installed section's per-service_kind
// group carries `data-kind` (a PackServiceKind or `other`).
export const PACKS_SECTION_ATTR = 'data-recued-packs-section';
export const PACKS_KIND_GROUP_ATTR = 'data-recued-packs-kind-group';

/** Display label per service_kind — the detail's IDENTITY kind badge. Only a
 *  real (isPackServiceKind) kind is ever looked up; a missing key falls back to
 *  the raw kind at the call site. */
const SERVICE_KIND_LABEL: Record<string, string> = {
  entity_platform: 'Entity platforms',
  tool_function: 'Tools',
  cli: 'CLI tools',
  channel_door: 'Channels',
  ai_connection: 'Connections',
  mcp_door: 'MCP servers',
  storage: 'Storage',
  workflow: 'Workflows',
};
// R2 — the install-dialog attrs live with the extracted render in
// `packs-install-dialog.ts`; re-exported here so tests + hosts keep one
// import site for every packs attribute.
export {
  PACKS_DIALOG_ATTR,
  PACKS_DIALOG_SLUG_ATTR,
  PACKS_DIALOG_PERMISSION_ATTR,
  PACKS_DIALOG_BODY_GRANT_ATTR,
  PACKS_DIALOG_INSTALL_BTN_ATTR,
  PACKS_DIALOG_CANCEL_BTN_ATTR,
  PACKS_DIALOG_ERROR_ATTR,
  PACKS_DIALOG_COLLISION_ATTR,
  PACKS_DIALOG_COLLISION_GROUP_ATTR,
  PACKS_DIALOG_RECIPE_COLLISION_ATTR,
  PACKS_DIALOG_GRANT_OVERLAP_ATTR,
  PACKS_DIALOG_GRANT_OVERLAP_ITEM_ATTR,
  PACKS_DIALOG_OWNER_OPERATION_REVIEW_ATTR,
  PACKS_DIALOG_OWNER_OPERATION_REVIEW_ITEM_ATTR,
  PACKS_DIALOG_OPERATION_DIFF_ATTR,
  PACKS_DIALOG_OPERATION_DIFF_ITEM_ATTR,
  PACKS_DIALOG_RECORDS_REVIEW_ATTR,
  PACKS_DIALOG_RECORDS_REVIEW_CHANGE_ATTR,
  PACKS_DIALOG_RECORDS_REVIEW_DESTRUCTIVE_ATTR,
  PACKS_DIALOG_MISSING_PACKS_ATTR,
} from './packs-install-dialog.js';
// D-145 PA10 follow-on Slice B — per-row Delete affordance attributes.
export const PACKS_ROW_DELETE_BTN_ATTR = 'data-recued-packs-row-delete';
export const PACKS_ROW_DELETE_CONFIRM_BTN_ATTR =
  'data-recued-packs-row-delete-confirm';
export const PACKS_ROW_DELETE_CANCEL_BTN_ATTR =
  'data-recued-packs-row-delete-cancel';
export const PACKS_ROW_DELETE_ERROR_ATTR =
  'data-recued-packs-row-delete-error';
// D-145 PA10 follow-on Slice C — cross-pack collision attributes.
// Row-level shares-badge attached when the pack overlaps any recipe
// slug with at least one other pack in the list.
export const PACKS_ROW_COLLISION_ATTR = 'data-recued-packs-row-collision';
// R22.1 detail re-layout — the detail view's section wrappers; value is the
// section id (`identity` / `operation-defaults` / `access` / `declares` /
// `about`). The Identity section also carries the author's repo link when the
// manifest declares one.
export const PACKS_DETAIL_SECTION_ATTR = 'data-recued-packs-detail-section';
export const PACKS_DETAIL_REPO_LINK_ATTR = 'data-recued-packs-detail-repo';
// Detail-only surface — a marketplace pack whose manifest isn't bundled is
// resolved on open; these mark the transient loading + resolve-failure states.
export const PACKS_DETAIL_RESOLVING_ATTR = 'data-recued-packs-detail-resolving';
export const PACKS_DETAIL_RESOLVE_ERROR_ATTR =
  'data-recued-packs-detail-resolve-error';
export const PACKS_DETAIL_RESOLVE_RETRY_ATTR =
  'data-recued-packs-detail-resolve-retry';
/** Pack-app recipe roster state. This read is separate from `packs.list`: a
 *  failure must not silently remove the Use surface or retry in a loop. */
export const PACKS_DETAIL_RECIPES_STATUS_ATTR =
  'data-recued-packs-detail-recipes-status';
/** D-289 — the pack's declared saved-view list. */
export const PACKS_DETAIL_SAVED_VIEWS_ATTR =
  'data-recued-packs-detail-saved-views';
export const PACKS_DETAIL_RECIPES_ERROR_ATTR =
  'data-recued-packs-detail-recipes-error';
export const PACKS_DETAIL_RECIPES_RETRY_ATTR =
  'data-recued-packs-detail-recipes-retry';
// Foundation-pack Delete confirm warning. Renders in the row
// only when the row's Delete confirm strip is open AND `pre_install`
// is true; the copy spells out the boot-time re-install so the user
// sees the futility before clicking Confirm delete.
export const PACKS_ROW_DELETE_FOUNDATION_WARN_ATTR =
  'data-recued-packs-row-delete-foundation-warn';
// D-145 PA10 follow-on Slice G — symmetric uninstall body-grant
// disclosure. Mirrors the install dialog's DD#4 body-content callout
// on the Delete confirm strip so the user sees the body access they
// are RELEASING before clicking Confirm delete. Renders only when the
// row's Delete confirm strip is armed AND the manifest's grants array
// is non-empty (`grants.length > 0` — Slice G's Angle-2 MINOR fold
// gates on actual array content rather than the derived
// `body_visibility_grant_count` so the heading + list always appear
// together; Slice I landed the same defensive symmetry on the install
// dialog). Each `<li>` carries `PACKS_ROW_DELETE_BODY_GRANT_ATTR` with
// the grant key as its value (mirrors the install dialog's
// `PACKS_DIALOG_BODY_GRANT_ATTR` shape).
export const PACKS_ROW_DELETE_BODY_GRANT_LIST_ATTR =
  'data-recued-packs-row-delete-body-grant-list';
export const PACKS_ROW_DELETE_BODY_GRANT_ATTR =
  'data-recued-packs-row-delete-body-grant';
// D-145 PA10 follow-on Slice J — cross-pack body-grant overlap
// disclosure. Two surfaces, parallel shapes:
//   - Install dialog: callout under the body-grants list noting that
//     the subject pack's body-content access is ALREADY accessible via
//     each named installed pack. Reassures the user the install does
//     not widen exposure.
//   - Uninstall delete strip: callout under the body-grants list
//     noting that the subject pack's body-content access REMAINS
//     accessible via each named installed pack after uninstall.
//     Corrects the mental model that uninstall revokes the grant.
// Each per-grant `<li>` carries the grant key as its ATTR value; the
// callout container carries the per-other-pack slugs (alphabetised)
// in a flat list so DOM tests can read counterparties without walking
// children. Empty when `computePackGrantOverlaps(...).grants` is
// empty — no installed pack shares any of this pack's grants. (The
// install-dialog half of the pair lives in `packs-install-dialog.ts`.)
export const PACKS_ROW_DELETE_GRANT_OVERLAP_ATTR =
  'data-recued-packs-row-delete-grant-overlap';
export const PACKS_ROW_DELETE_GRANT_OVERLAP_ITEM_ATTR =
  'data-recued-packs-row-delete-grant-overlap-item';
// Slice K — post-success runnability disclosure notice (R2 step 4).
// The container's value is the subject pack's slug; each block carries
// its disclosure kind (`born-blocked` / `born-degraded` /
// `would-disable` / `would-degrade`); each `<li>` carries the recipe id.
export const PACKS_DISCLOSURE_ATTR = 'data-recued-packs-disclosure';
export const PACKS_DISCLOSURE_BLOCK_ATTR =
  'data-recued-packs-disclosure-block';
export const PACKS_DISCLOSURE_ITEM_ATTR =
  'data-recued-packs-disclosure-item';
export const PACKS_DISCLOSURE_DISMISS_BTN_ATTR =
  'data-recued-packs-disclosure-dismiss';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

export type PacksListCaller = () => Promise<{
  packs: ReadonlyArray<PackListEntry>;
  /** D-182 — every installed pack's version from the inventory (bundled +
   *  marketplace). A marketplace-installed pack has NO bundled manifest, so it
   *  never appears in `packs[]`; this is the only place the detail-only surface
   *  can learn a resolved marketplace pack is installed (→ show Uninstall, not
   *  Install). Optional — a dbless / older handler omits it. */
  installed_versions?: ReadonlyArray<{ slug: string; version: number }>;
}>;

export type PacksInstallCaller = (args: {
  manifest: unknown;
  granted_permissions: ReadonlyArray<string>;
  /** Exact server-produced review anchor for a bundled Records update. */
  expected_manifest_hash?: string;
  /** D-182 §7.1 / D-196 — Access × Audience for a pack with grantable ops. */
  install_scope?: InstallGrantSelection;
  /** D-194 2b-2 — the connection the owner picked in the dialog's Connect
   *  section; the install re-sources the grant + binding to it. Omitted when the
   *  pack declares no connection requirement OR the owner chose not to connect. */
  chosen_connection?: string;
  /** D-295 — one owner-chosen webhook per binding of every pack the install
   *  touches. Omitted when the preview named none (or could not say). */
  webhook_bindings?: ReadonlyArray<{ pack_slug: string; binding: string; ingress_id: string }>;
  /** D-310 — the owner's Access choice for each pack the install brings in.
   *  Omitted when the preview listed none (or predates D-310). */
  dependency_install_scopes?: ReadonlyArray<PackDependencyInstallScope>;
  /** D-315 §5.2 — which template stays on where a recipe's template reads the
   *  same mail as one already on. Omitted when the preview named none. */
  mail_template_choices?: ReadonlyArray<MailTemplateInstallChoice>;
}) => Promise<{ result: BulkPackInstallResultLike }>;

/** D-145 PA10 follow-on Slice B — `packs.uninstall` caller seam. The
 *  panel passes `pack_slug` (the row's `slug` field); the server
 *  re-resolves the bundled manifest off disk + drives the uninstall
 *  transaction. Returns the engine's typed result body so the panel can
 *  render targeted failure copy per `failure.code`. */
export type PacksUninstallCaller = (args: {
  pack_slug: string;
}) => Promise<{ result: BulkPackUninstallResultLike }>;

/** Add-a-pack (2026-07-01) — resolve a user-typed marketplace slug / URL to a
 *  manifest for the consent dialog, WITHOUT installing. The route wires this to a
 *  server rpc (`packs.resolveBySlug`): the SERVER fetches the marketplace so the
 *  manifest stays marketplace-authoritative (the webclient never fetches/trusts
 *  it — role-boundary + the "never trust a client-supplied publisher_id"
 *  invariant). The seam takes the raw input; the route parses slug-vs-URL. Non-
 *  marketplace URLs (arbitrary local JSON) are out of marketplace-first — the
 *  route surfaces them as a `failure`. Returns the `PacksResolveResult`
 *  ({ manifest } | { manifest: null, failure }). */
export type PacksResolveCaller = (input: string) => Promise<PacksResolveResult>;

/** D-247 D15 — `packs.install_preview`. Resolves the recipe refs a manifest
 *  carries into the consent disclosure + D15.1's per-recipe closure risk,
 *  WITHOUT installing. SERVER-resolved because the recipe bodies live
 *  server-side: a bulk manifest carries refs, not bodies, so the client cannot
 *  derive a closure and must not guess one.
 *
 *  ⛔ A rejection is NOT an error surface here — the dialog degrades to
 *  `resolved: false` (no disclosure, flat read tier = the pre-D-247 behaviour).
 *  That is also what a server predating D-247 produces, since it answers
 *  `packs.install_preview` with an unknown-method rejection. */
export type PacksInstallPreviewCaller = (args: {
  manifest: unknown;
  /** D-311 — the pack was resolved from the marketplace and installs by slug:
   *  the server resolves its recipes and the packs it brings in from there. */
  marketplace?: boolean;
}) => Promise<InstallPreview>;

/** D-304 — `packs.uninstall_preview`: what deleting a pack removes with its
 *  recipes. A rejection (a server predating D-304) means "no line". */
export type PacksUninstallPreviewCaller = (args: {
  pack_slug: string;
}) => Promise<{ schedules: number; automations: number; recipes_with_settings: number }>;

/** D-304 — the Delete confirmation's "also removes …" line. */
export const PACKS_ROW_DELETE_REMOVES_ATTR = 'data-recued-packs-row-delete-removes';

/** D-304 — "Also removes 2 schedules, 1 automation and the saved settings of 3
 *  recipes." `null` when nothing goes with the pack's recipes. */
export const deleteRemovesText = (
  removes: { schedules: number; automations: number; recipes_with_settings: number },
): string | null => {
  const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const parts = [
    ...(removes.schedules > 0 ? [count(removes.schedules, 'schedule', 'schedules')] : []),
    ...(removes.automations > 0 ? [count(removes.automations, 'automation', 'automations')] : []),
    ...(removes.recipes_with_settings > 0
      ? [`the saved settings of ${count(removes.recipes_with_settings, 'recipe', 'recipes')}`] : []),
  ];
  if (parts.length === 0) return null;
  const listed = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
  return `Also removes ${listed}.`;
};

/** Add-a-pack (2026-07-01) — install a resolved marketplace pack BY SLUG. The
 *  consent dialog for an added pack routes here (NOT the by-value
 *  `PacksInstallCaller`), because a marketplace pack's recipes are not bundled on
 *  the server — only `packs.installBySlug` injects the marketplace recipe
 *  resolver. Same grant handling / result shape as the by-value install. */
export type PacksInstallBySlugCaller = (args: {
  slug: string;
  granted_permissions: ReadonlyArray<string>;
  /** Exact marketplace manifest rendered by the detail consent surface. */
  expected_manifest_hash?: string;
  install_scope?: InstallGrantSelection;
  /** D-194 2b-2 — see {@link PacksInstallCaller}. */
  chosen_connection?: string;
  /** D-295 — see {@link PacksInstallCaller}. */
  webhook_bindings?: ReadonlyArray<{ pack_slug: string; binding: string; ingress_id: string }>;
  /** D-310 — see {@link PacksInstallCaller}. */
  dependency_install_scopes?: ReadonlyArray<PackDependencyInstallScope>;
  /** D-315 — see {@link PacksInstallCaller}. */
  mail_template_choices?: ReadonlyArray<MailTemplateInstallChoice>;
}) => Promise<{ result: BulkPackInstallResultLike }>;

export type PacksPanelState = 'loading' | 'ready' | 'error';

/** Slice K — the post-success runnability disclosure notice the panel
 *  renders above the list. `blocks` come verbatim from the shared
 *  `@recued/ui-shared` builders over the install / uninstall result;
 *  `action` + the pack identity anchor the copy once the dialog /
 *  confirm strip that produced it has closed. */
export interface PacksPanelDisclosure {
  action: 'installed' | 'uninstalled';
  pack_slug: string;
  pack_name: string;
  blocks: ReadonlyArray<PackDisclosureBlock>;
}

export interface MountPacksPanelOptions {
  /** Host element the panel renders into. The panel appends a single
   *  wrapper div + rebuilds its inner contents across state changes.
   *  `dispose()` drops the wrapper. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** Shell-owned scroller forwarded to generated pack views so action-result
   *  return can restore the originating list position. */
  scrollRoot?: HTMLElement;
  /** `packs.list` caller seam (DD#1). */
  runList: PacksListCaller;
  /** `packs.install` caller seam (DD#1). Optional — when omitted the
   *  panel hides the Install affordance + renders as read-only. The
   *  webclient bootstrap defaults both callers to ON for production;
   *  test harnesses can pass only `runList` to exercise the read-only
   *  surface. */
  runInstall?: PacksInstallCaller;
  /** D-145 PA10 follow-on Slice B — `packs.uninstall` caller seam
   *  (DD#1). Optional — when omitted the panel hides the per-row
   *  Delete affordance entirely. Independently optional from
   *  `runInstall`: a webclient that wants list + install but not
   *  uninstall passes `runInstall` without `runUninstall`. */
  runUninstall?: PacksUninstallCaller;
  /** D-145 PA10 follow-on Slice D — live broadcast subscription seam.
   *  When provided, the mount subscribes to `pack_installed` and
   *  `pack_uninstalled` on creation and calls `refresh()` whenever
   *  either event fires. Drives the live cross-tab / cross-device
   *  refresh: a pack install on the user's laptop webclient flips the
   *  Installed badge on the user's phone webclient + Bridge popover
   *  without the user clicking Refresh. Mirrors the cache card's DD#7
   *  pattern in `llm-result-cache-card-mount.ts`.
   *
   *  Filter rule: any event of either kind fires a full refresh.
   *  Per-slug filtering (skip when the affected slug isn't in the
   *  current list) is unnecessary because (a) the list is small (~10
   *  packs), (b) `refresh()` is idempotent (same `packs.list` response
   *  → same render), and (c) a foreign slug's install / uninstall is
   *  still interesting if the panel is mid-load against a stale
   *  snapshot.
   *
   *  Optional by design: omitting `subscribe` keeps the panel on the
   *  prior post-rpc-auto-refresh cadence (refresh fires on mount +
   *  after every successful local install / uninstall). */
  subscribe?: BroadcastSubscriber['on'];
  // ── The Use tab (pack as an app) ──────────────────────────────────
  /** `recipes.list` — the pack's own recipe BODIES, which is what the view /
   *  operation split is derived from. Absent ⇒ no pack gets a Use tab and the
   *  detail is exactly the control-plane page it was. */
  runRecipeList?: () => Promise<{ recipes: ReadonlyArray<ServerRecipeListEntry> }>;
  /** Runs a view. Absent ⇒ the Use tab still lists what the pack does but says
   *  running is unavailable, rather than rendering dead tabs. */
  runRecipeExecute?: PackAppExecuteCaller;
  /** Opens the shared Run | Schedule modal for an operation. Owned by the HOST
   *  so the one-modal-at-a-time rule holds across the whole route rather than
   *  per panel. Absent ⇒ the actions bar is omitted. */
  openRunModal?: (
    entry: ServerRecipeListEntry,
    onRan?: (result: import('@recued/contracts').ServerExecuteResponse) => void,
    prefill?: { config?: Record<string, unknown>; context?: Record<string, unknown> },
  ) => void;
  /** `data.file.read` — the authenticated owner read behind a Use-tab file
   *  card's preview / download. Absent ⇒ those controls render disabled. */
  runFileRead?: (args: { record_id: string }) => Promise<ResultFileReadResult>;
  /** Pack-owned Records inventory for editable ref cells in a Use-tab view. */
  runRecordRefSearch?: PackAppRecordRefSearchCaller;
  /** Runtime-derived view requested by
   * `#packs/<slug>/use/<recipe-id>`. Applied only to `initialSlug`. */
  initialAppViewId?: string;
  /** D-282 slice C — the packs this DEVICE has pinned to the navigation
   *  drawer, and the writer for that list. Both or neither: a Pin control with
   *  no writer is a button that reports nothing, and a list with no control is
   *  a state the owner cannot reach.
   *
   *  ⛔ A GETTER, NOT A SNAPSHOT. The list lives in the bootstrap and moves the
   *  moment the owner presses the control; a value captured at mount would
   *  leave the button reading "Pin" on a pack that is already pinned until
   *  something else happened to remount the panel. */
  pinnedApps?: () => readonly string[];
  onTogglePin?: (packSlug: string, pinned: boolean) => void;
  /** D-282 B5 — the record a lookup address named
   * (`#packs/<slug>/use/<lookup>/<target>`). Forwarded verbatim; whether it is
   * honoured is the app view's decision, taken against the installed roster. */
  initialAppViewTarget?: string;
  /** Reports generated-view navigation to the route-owned hierarchical History
   * adapter. `replace` canonicalizes a stale deep link without adding history.
   *
   * `target` names the record an open LOOKUP is showing; absent / null is the
   * browse view's own address. */
  onAppViewNavigate?: (
    packSlug: string,
    viewId: string | null,
    intent: 'auto' | 'replace',
    target?: string | null,
  ) => void;
  /** Supervision feature (Slice 4) — `supervision.list` discovery caller. When
   *  present (with `runSupervisionSet`), the panel renders the pack-detail
   *  supervised-daemon controls. Omitted ⇒ no controls (read-only host). */
  runSupervisionList?: SupervisionListCaller;
  /** Supervision feature (Slice 4) — `supervision.set` caller (enrol / flip /
   *  start / stop). Independent of install/uninstall; omitting it hides the
   *  daemon controls even when `runSupervisionList` is present. */
  runSupervisionSet?: SupervisionSetCaller;
  /** `cli.reachability.universe` caller — the binary-on-PATH readiness read.
   *  When present, a daemon row whose binary isn't on PATH shows a "not installed"
   *  badge + gates its enrol/start controls. Omitted ⇒ no readiness signal. */
  runReachabilityUniverse?: SupervisionReachabilityCaller;
  /** `collection.connection.list` caller. When present, each pack row shows a
   *  per-OAuth-scoped-connection readiness block (connected / missing scopes /
   *  not set up), resolving the pack's `required_scopes` against enrolled
   *  connections' `granted_scopes`. Omitted ⇒ no readiness block. */
  runConnectionList?: ConnectionsReadinessListCaller;
  // ── R3 — by-PACK Access panel callers (the detail's ACCESS section). The
  // panel renders when the READ trio (contracts + grant read + catalog) is
  // wired; the write callers are independently optional (absent ⇒ that op
  // family's toggles render disabled). All six mirror the #contracts route's
  // callers so the two axes of the one grant matrix read the same rpcs. ──
  /** `collection.contract.listContracts` — the door rows (self synthesized). */
  runListContracts?: GrantContractsCaller;
  /** D-196 R6 — Seller tiers used by the install audience's expanded
   *  per-tier checklist. The broad all-customers checkbox remains available
   *  when this optional read is absent. */
  runSellerOverview?: () => Promise<SellerOverview>;
  /** `contract.grant.read` — iterated once per contract row. */
  runContractGrantRead?: GrantReadCaller;
  /** `contract.grant.write` — connection-op toggles. */
  runContractGrantWrite?: GrantWriteCaller;
  /** `collection.contract.listCatalogOperations` — the shared op universe. */
  runCatalogOperations?: GrantCatalogOperationsCaller;
  /** D-211 global owner operation-default row readers/writers. These are
   * actorless and render in the pack detail, never in a contract row. */
  runOwnerOperationInventory?: OwnerOperationInventoryCaller;
  runOwnerOperationList?: OwnerOperationListCaller;
  runOwnerOperationUpsert?: OwnerOperationUpsertCaller;
  runOwnerOperationDelete?: OwnerOperationDeleteCaller;
  /** `cli.reachability.list` — cli-op effective state (global; split per
   *  principal client-side). */
  runCliReachabilityList?: GrantCliReachabilityListCaller;
  /** `cli.reachability.set` — cli-op toggles. */
  runCliReachabilitySet?: GrantCliReachabilitySetCaller;
  /** R22 list→detail — the pack slug to open in DETAIL view on mount (from the
   *  `#packs/<slug>` deep-link segment). Absent / unknown-slug ⇒ the LIST view.
   *  A slug whose pack isn't in the loaded list resolves to the list (the
   *  render guards existence, mirroring recipes/data). */
  initialSlug?: string;
  /** R22 list→detail — fired whenever the selected pack changes (a row opened,
   *  or Back to the list ⇒ `null`). The route aligns the shared hierarchical
   *  address without remounting this live panel. */
  onSelectSlug?: (slug: string | null) => void;
  /** Add-a-pack (2026-07-01) — resolve seam for the "Add a pack" section. Present
   *  WITH {@link runInstallBySlug} ⇒ the section renders. Omitting either hides it
   *  (a read-only / bundled-only host). */
  runResolvePack?: PacksResolveCaller;
  /** Add-a-pack (2026-07-01) — install-by-slug seam a resolved (added) pack's
   *  consent dialog commits to (marketplace recipes aren't bundled, so the
   *  by-value `runInstall` can't resolve them). Gated together with
   *  {@link runResolvePack}. */
  runInstallBySlug?: PacksInstallBySlugCaller;
  /** D-247 D15 — install-preview seam for the consent dialog's recipe
   *  disclosure + grant-picker tier. Absent ⇒ no disclosure and the flat read
   *  tier; the dialog is fully functional without it. */
  runInstallPreview?: PacksInstallPreviewCaller;
  /** D-304 — the Delete confirmation's "also removes …". Absent ⇒ no line. */
  runUninstallPreview?: PacksUninstallPreviewCaller;
}

export interface PacksPanelMount {
  /** Current panel state — primary surface for tests + host introspection. */
  getState(): PacksPanelState;
  /** Re-run the Use tab's open view for an external refresh signal. Pack task
   *  results refresh themselves when the owner returns. No-op when unmounted. */
  refreshAppView(): void;
  /** The Use tab's open view, or null when it isn't mounted. Test surface. */
  getActiveViewId(): string | null;
  /** Currently-rendered packs in display order. Empty when state !=
   *  `'ready'`. */
  getPacks(): ReadonlyArray<PackListEntry>;
  /** Slug of the pack whose install dialog is currently open. Null when
   *  no dialog is open. Single-row only (DD#2). */
  getDialogOpenFor(): string | null;
  /** True while the active install dialog's rpc is in flight. */
  isInstalling(): boolean;
  /** Top-level list error message. Null when state != `'error'`. */
  getListError(): string | null;
  /** Active dialog's inline error message. Null when no error is staged. */
  getDialogError(): string | null;
  /** Permission slugs the user currently has checked in the active
   *  dialog. Empty set when no dialog is open. The install rpc
   *  receives this set verbatim as `granted_permissions`. */
  getDialogPermissions(): ReadonlySet<string>;
  /** Access tier the active dialog will send as `install_scope.access`. Null
   *  when no dialog is open or its pack has no grantable model. */
  getDialogAccessTier(): InstallAccessTier | null;
  /** Legacy single-scope projection of the active Audience checklist. */
  getDialogScope(): InstallScopeWho | null;
  /** Complete D-196 checklist the active dialog will send. */
  getDialogAudience(): InstallAudienceSelection | null;
  // ── list→detail (the panel IS the detail; the surface drives selection) ──
  /** Slug of the pack shown in the detail, or null. Set via `initialSlug` /
   *  `clickSelectPack`; a slug not in the roster resolves as a marketplace pack. */
  getSelectedSlug(): string | null;
  /** Open a pack's detail (as a list-row click in the surface does). */
  clickSelectPack(slug: string): void;
  /** Return to the list (as the detail's Back link does → the surface shows the list). */
  clickBackToList(): void;
  /** True while a pack mutation or Use-tab result lifecycle still owns the
   *  active detail. Forwarded to the Packs route's shell leave guard. */
  hasInFlightWork(): boolean;
  /** True while the Use tab holds editable result rows not yet saved. */
  hasUnsavedChanges(): boolean;
  /** Host-driven refresh — re-issues `runList`. Use after a known pack
   *  mutation happened elsewhere (e.g. a future broadcast subscription
   *  lands). Slice A has no broadcast subscription; this is the only
   *  seam hosts have to recover from staleness short of a route
   *  remount. */
  refresh(): void;
  /** Initial load promise — resolves after the first `runList` settles
   *  (success → `'ready'`, failure → `'error'`). Subsequent `refresh()`
   *  calls + the post-install auto-refresh also update the tracked
   *  promise; awaiting this after either awaits the most recent load. */
  whenLoaded(): Promise<void>;
  /** Tear down the panel DOM + remove event listeners. Idempotent. */
  dispose(): void;
  /** Test-only: drive the error → loading retry transition. */
  clickRetry(): void;
  /** Test-only: drive an Install click on a specific row (opens the
   *  dialog). No-op when the row is already installed, the panel has
   *  no `runInstall` caller, or the panel isn't in `'ready'`. */
  clickInstall(slug: string): void;
  /** Test-only: drive a Cancel click on the active dialog. */
  clickCancelDialog(): void;
  /** Test-only: toggle a permission checkbox in the active dialog.
   *  Returns the new checked state. No-op when the permission is
   *  always-required (`install_bulk_pack`). */
  togglePermission(permission: string): boolean;
  /** D-182 §7.1 (inc 5b.2) — test-only: pick an Access tier in the active
   *  dialog's grant picker (`read` / `write` / `all`). No-op when no dialog is
   *  open, an install is in flight, the pack has no grantable model, or the
   *  tier isn't offered for this pack. */
  clickAccessOption(tier: InstallAccessTier): void;
  /** D-310 — test-only: pick an Access tier for one pack the active dialog's
   *  install brings in. Same guards as the radio. */
  clickDependencyAccessOption(packSlug: string, tier: InstallAccessTier): void;
  /** D-310 — what the active dialog's install will send for the packs it brings
   *  in (`dependency_install_scopes`), or null when it sends none. */
  getDialogDependencyScopes(): ReadonlyArray<PackDependencyInstallScope> | null;
  /** D-182 §7.2 / D-196 — test-only: pick a Scope in the active dialog's grant
   *  picker. No-op when no dialog is open, an install is in flight, or the pack
   *  has no grantable model. */
  clickScopeOption(scope: InstallScopeWho): void;
  /** Test-only: drive the dialog's Install click. Awaits the in-flight
   *  rpc + the follow-up refresh. */
  clickConfirmInstall(): Promise<void>;
  // ── Slice B test seams + introspection ─────────────────────────────
  /** D-145 PA10 follow-on Slice B — slug of the pack whose Delete
   *  confirm strip is open. Null when no confirm strip is open.
   *  Single-row only (DD#9). */
  getConfirmingDeleteFor(): string | null;
  /** True while the active Delete confirm strip's rpc is in flight. */
  isDeleting(): boolean;
  /** Active Delete strip's inline error message. Null when no error is
   *  staged. */
  getDeleteError(): string | null;
  /** Test-only: drive a Delete click on a specific row (opens the
   *  confirm strip). No-op when the row is not installed, the panel
   *  has no `runUninstall` caller, OR the panel isn't in `'ready'`.
   *  Foundation packs are deletable directly (Delta 6) — the confirm
   *  strip carries the boot-time-undo warning. */
  clickDelete(slug: string): void;
  /** Test-only: drive a Cancel click on the active Delete confirm
   *  strip. */
  clickCancelDelete(): void;
  /** Test-only: drive the active Delete confirm strip's Confirm click.
   *  Awaits the in-flight rpc + the follow-up refresh. */
  clickConfirmDelete(): Promise<void>;
  /** D-145 PA10 follow-on Slice C — per-pack recipe collision facts.
   *  Returns a Map keyed on every loaded pack slug; entries with
   *  `recipes.length === 0` represent packs with no overlap. The map is
   *  recomputed on every render so callers always observe a fresh
   *  snapshot. Empty Map when state != `'ready'`. The returned value is
   *  a defensive copy — mutating it does not affect the panel. */
  getCollisions(): Map<string, PackRecipeCollision>;
  /** D-145 PA10 follow-on Slice J — per-pack body-grant overlap facts.
   *  Returns a Map keyed on every loaded pack slug; entries with
   *  `grants.length === 0` represent packs with no overlap (either no
   *  body-grants declared OR none shared with another INSTALLED pack).
   *  Recomputed on demand. Empty Map when state != `'ready'`.
   *  Defensive shallow copy — mutating it does not affect the panel. */
  getGrantOverlaps(): Map<string, PackGrantOverlap>;
  // ── Slice K test seams + introspection ─────────────────────────────
  /** Slice K — the post-success runnability disclosure notice currently
   *  staged (rendered above the list while in `'ready'`), or null. Set
   *  after a successful install whose result carries born_blocked /
   *  born_degraded (4c.2) or a successful uninstall whose result
   *  carries would_disable (4c.3). Survives refreshes; cleared per
   *  DD#15. Defensive copy. */
  getDisclosure(): PacksPanelDisclosure | null;
  /** Test-only: click the disclosure notice's Dismiss button. No-op
   *  when no notice is rendered. */
  clickDismissDisclosure(): void;
}

// ════════════════════════════════════════════════════════════════
// Copy
// ════════════════════════════════════════════════════════════════

const COPY = {
  loading: 'Loading packs…',
  error_heading: 'Recued could not load your Packs.',
  retry_label: 'Retry',
  retrying_label: 'Retrying…',
  install_label: 'Install',
  /** An update that moves the pack's RECIPES at the same pack version — "v1→v1"
   *  would say nothing changes, and it is not an install. */
  update_recipes_label: '↑ Update recipes',
  /** Install, while this pack's manifest is still being fetched. */
  install_preparing_label: 'Preparing…',
  /** Shown where the consent dialog will appear, when Install was pressed
   *  before the manifest finished loading. */
  dialog_pending_label: 'Loading…',
  cancel_label: 'Cancel',
  installed_badge: 'Installed',
  foundation_badge: 'Foundation',
  detail_back_label: '← Packs',
  detail_tabs_label: 'Pack sections',
  detail_use_tab_label: 'Use',
  detail_manage_tab_label: 'Manage',
  // D-282 slice C. ⚠ "this device" is in the hint because the pref is stored
  // per paired instance: the laptop and the counter tablet pin different
  // things, and an owner who pinned on one and looked on the other would
  // otherwise read it as a bug.
  detail_pin_label: 'Pin',
  detail_unpin_label: 'Unpin',
  detail_pin_hint: 'Put this app in the navigation menu on this device',
  detail_unpin_hint: 'Take this app out of the navigation menu on this device',
  detail_manage_tabs_label: 'Pack management sections',
  detail_tab_label: 'Detail',
  detail_permissions_tab_label: 'Permissions',
  detail_access_tab_label: 'Access',
  detail_operation_defaults_label: 'What it may do, to start with',
  /** ⚠ The not-installed heading. "Operation defaults" names something that does not
   *  exist yet for an uninstalled pack — there are no defaults to set — so it
   *  contradicted the first line under it ("Not installed — nothing is granted yet").
   *  A section heading that disagrees with its own body is how a reader decides one of
   *  the two is stale. */
  detail_permission_preview_label: 'Before you install',
  detail_operation_defaults_empty: 'There is nothing to change here for this Pack.',
  /** ⛔ THE IN-FLIGHT STATE NEEDS ITS OWN WORDS, because the empty one is a
   *  CLAIM. `packs.list` no longer forwards `manifest` for ANY pack (it was
   *  17.7 MB and the socket dropped it — see `PackListEntry.manifest`), so an
   *  installed pack's detail now paints once before `ensureDetailResolved`
   *  lands. Reusing "There is nothing to change here" for that window states
   *  something FALSE about a pack that has plenty to change, and states it
   *  confidently, which is the failure mode worth avoiding: a reader who
   *  believes an empty answer stops looking, while a reader who sees "loading"
   *  waits. The window is a local disk read, but the sentence outlives it in
   *  whoever read it. */
  detail_operation_defaults_loading: 'Loading this Pack’s operations…',
  detail_operation_defaults_unavailable: 'This server cannot show what it may do to start with.',
  recipes_label: 'recipes',
  body_grants_label: 'body content',
  publisher_prefix: 'by ',
  // Slice B — Delete affordance + two-stage confirm strip.
  delete_label: 'Delete',
  delete_confirm_label: 'Confirm delete',
  deleting_label: 'Deleting…',
  foundation_delete_warning:
    '⚠ This pack auto-installs at server boot — uninstalling will undo on next start.',
  // R22.1 detail re-layout — section headings + Identity/Access copy.
  detail_access_label: 'Access',
  detail_declares_label: 'Declares',
  detail_about_label: 'About',
  detail_repo_label: 'Repository ↗',
  detail_resolving_label: 'Loading pack…',
  detail_resolve_error_retry_label: 'Try again',
  detail_unavailable_label: 'This server does not have that Pack.',
  detail_recipes_loading_label: 'Loading what this Pack can do…',
  // D-289 — pack-shipped saved Data views.
  saved_views_label: 'saved views',
  saved_view_label: 'saved view',
  detail_saved_views_note: 'These appear in Data under “From packs”. The Pack sets their name and settings; you can hide one there.',
  detail_recipes_error_prefix: 'Recued could not load what this Pack can do.',
  detail_access_placeholder:
    'One day you will manage this Pack’s access here. For now, it is set per agreement:',
  detail_access_contracts_label: 'Open Contracts →',
  // Slice G — symmetric uninstall body-grant disclosure. Mirrors the
  // install dialog's body-grants callout (now in `packs-install-dialog.ts`)
  // so the install + delete surfaces read parallel: install says "will
  // access", delete says "will release". The grant-key list rendered below
  // the label is the raw closed-list slug from
  // `pack.manifest.mcp_body_visibility_grants`.
  delete_body_grants_label:
    'This Pack will stop being able to read:',
  // Slice C — cross-pack collision copy (the detail About notice; the
  // install dialog's callout copy lives with the extracted dialog).
  row_collision_prefix: '⚠ Shares ',
  row_collision_recipes_singular: ' recipe with ',
  row_collision_recipes_plural: ' recipes with ',
  // Slice J — uninstall-side overlap copy ("remains accessible" — sticky
  // framing; the install side's additive copy lives with the dialog). The
  // per-grant `<li>` suffix is the shared GRANT_OVERLAP_ALSO_VIA_PREFIX so
  // the two surfaces cannot drift.
  delete_grant_overlap_heading:
    'Other Packs you have installed can still read this afterwards:',
  // Slice K — post-success runnability disclosure notice. The block
  // headlines + per-recipe detail come from the shared
  // `@recued/ui-shared` builders; only the notice chrome is panel copy.
  disclosure_installed_prefix: 'Installed ',
  disclosure_uninstalled_prefix: 'Uninstalled ',
  disclosure_dismiss_label: 'Dismiss',
  // Fallback message when a marketplace pack's detail resolve fails without a
  // specific reason (the detail's `ensureDetailResolved` path).
  add_generic_error: 'Recued could not find that Pack.',
} as const;

/** Slice B — failure-code → copy mapping for `packs.uninstall`. The
 *  install-side map lives with the extracted dialog
 *  (`packs-install-dialog.ts` → {@link installFailureCopy}). The
 *  closed-list `BulkPackUninstallResultLike['failure']['code']` keeps the
 *  surface narrow; the exhaustive Record
 *  forces a copy decision when the engine grows a new code. */
const UNINSTALL_FAILURE_COPY: Record<
  NonNullable<BulkPackUninstallResultLike['failure']>['code'],
  string
> = {
  not_found:
    'Recued did not remove it: your server cannot find it.',
  webhook_cleanup_required:
    'Recued cannot remove this yet. It has to stay so it can tidy up with the other service first, and Recued has no proof that has happened.',
  unexpected:
    'Recued did not remove it: something went wrong.',
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

/** Mount the panel into `opts.host`. Kicks off the initial `runList`
 *  call; the panel renders `loading` until it resolves. */
export const mountPacksPanel = (
  opts: MountPacksPanelOptions,
): PacksPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountPacksPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  // ── State ────────────────────────────────────────────────────────
  let state: PacksPanelState = 'loading';
  let disposed = false;
  let packs: PackListEntry[] = [];
  let listError: string | null = null;
  /** An owner-triggered Retry keeps the error surface mounted while its list
   *  read settles, so the initiating control remains a visible keyboard anchor. */
  let listRetrying = false;
  /** Most-recent `runList` promise, exposed via `whenLoaded()`. Updated
   *  on initial mount + on every `refresh()` / Retry / post-install
   *  auto-refresh — callers await the most recent load. */
  let pendingListPromise: Promise<void> = Promise.resolve();
  /** Slice H — monotonic generation counter for `refreshRows`. Each
   *  kickoff captures the post-increment value; the post-await guard
   *  drops the result if a newer kickoff has occurred (DD#14). The
   *  counter is panel-local so concurrent mounts don't interfere. */
  let loadGeneration = 0;
  /** Slug of the pack whose install dialog is open. Single-row (DD#2). */
  let dialogOpenFor: string | null = null;
  /** True while the dialog's `packs.install` rpc is in flight. */
  let installing = false;
  /** The last failed submit's copy, and the packs its refusal said to install
   *  first (`failure.missing_packs`), which the dialog offers under it. ONE
   *  value, so every one of the places that clears the error clears the offer
   *  with it — an offer left behind would sit under someone else's error. */
  let dialogError: { text: string; missingPacks: readonly string[] } | null = null;
  /** Per-pack permission selections. The active dialog's permission
   *  set lives at `dialogPermissions.get(dialogOpenFor)`. Map entries
   *  clear on dialog close (DD#6). */
  const dialogPermissions = new Map<string, Set<string>>();
  /** D-182 §7.1 (inc 5b.2) — per-pack Access-tier selection for the install
   *  grant picker. Only set for a connection-backed pack (a non-null grant
   *  model); absent ⇒ `read` (the picker's default) on first render. Keyed by
   *  slug like `dialogPermissions`, cleared on dialog close. */
  const dialogGrantAccess = new Map<string, InstallAccessTier>();
  /** D-196 R6 — per-pack independent audience checklist. Absent ⇒ owner-only. */
  const dialogGrantAudience = new Map<string, InstallAudienceSelection>();
  let customerTierOptions: InstallAudienceOption[] = [];
  let contractAudienceOptions: InstallAudienceOption[] = [];
  /** D-294 — a customer contract's display label, for the customers an update's
   *  carried-over audience names one by one. */
  let customerLabelByContract = new Map<string, string>();
  /** D-194 2b-2 — the owner's EXPLICIT connection pick for the Connect section.
   *  Presence (`has`) means the owner touched the picker; the value is their
   *  choice (a connection name, or `undefined` = "don't connect now"). ABSENT ⇒
   *  untouched → the render/submit fall back to `defaultChosenConnection` computed
   *  fresh from the (async-loaded) candidate list, so a pre-select appears once
   *  the connection list loads without clobbering an explicit later choice. */
  const dialogChosenConnection = new Map<string, string | undefined>();
  /** D-295 — the owner's webhook picks for the open dialog: choice key → ingress. */
  const dialogWebhookPicks = new Map<string, Map<string, string>>();
  /** D-315 §5.2 — the owner's keep choice for each template a recipe brings
   *  that meets one already on: choice key → which stays on. Absent ⇒ the recipe's. */
  const dialogMailTemplateKeep = new Map<string, Map<string, 'recipe' | 'existing'>>();
  /** D-310 — the owner's Access pick for each pack the open dialog's install
   *  brings in: pack slug → (brought-in pack slug → tier). Absent ⇒ Read only. */
  const dialogDependencyAccess = new Map<string, Map<string, InstallAccessTier>>();
  /** D-194 2b-2 — whether the Connect section's "Use a different account" list is
   *  expanded for a slug. Cleared on dialog close alongside the picks. */
  const dialogConnectExpanded = new Set<string>();
  /** Clear ALL per-dialog picks for a slug — the single reset point so the
   *  Access + Scope + Connect state share one lifecycle (a slug left in one map
   *  but not another would render a stale pick on a later reopen). */
  const clearDialogGrantPicks = (slug: string): void => {
    dialogGrantAccess.delete(slug);
    dialogGrantAudience.delete(slug);
    dialogChosenConnection.delete(slug);
    dialogConnectExpanded.delete(slug);
    dialogWebhookPicks.delete(slug);
    dialogMailTemplateKeep.delete(slug);
    dialogDependencyAccess.delete(slug);
  };
  /** D-247 D15 — the server-resolved install preview, cached against the
   *  MANIFEST OBJECT it was derived from rather than the slug alone. A detail
   *  resolve or a list refresh can replace a pack's manifest, and a disclosure
   *  describing the PREVIOUS one is a consent surface reading a stale input —
   *  the exact class of defect D-247 kept producing. Identity comparison makes
   *  the invalidation automatic instead of a second place to remember.
   *
   *  ⛔ NOT cleared by `clearDialogGrantPicks`: this is derived from the
   *  manifest, not an owner pick, so it survives a close/reopen of the same
   *  unchanged pack. */
  const dialogInstallPreview = new Map<
    string,
    { readonly manifest: unknown; readonly preview: InstallPreview }
  >();
  /** Slug whose `packs.install_preview` is in flight (single-dialog, DD#2). */
  let installPreviewInFlight: string | null = null;
  /** The preview for a slug, but ONLY when it was derived from the manifest now
   *  on screen. A mismatch reads as absent, which the dialog renders as the
   *  pre-D-247 surface — never as a disclosure about a different manifest. */
  const installPreviewFor = (
    slug: string,
    manifest: unknown,
  ): InstallPreview | undefined => {
    const entry = dialogInstallPreview.get(slug);
    return entry !== undefined && entry.manifest === manifest
      ? entry.preview
      : undefined;
  };
  /** Idempotent + guarded, mirroring `ensureDetailResolved`: at most one call
   *  per (slug, manifest), re-renders when it lands.
   *
   *  ⛔ A rejection is CACHED as `resolved: false`, not surfaced as an error and
   *  not retried on every render. The disclosure is additive — a host that
   *  cannot answer (no seam wired, or a server predating D-247, which rejects
   *  the method as unknown) must render the dialog it always rendered, not an
   *  error on a consent surface that is otherwise fine. */
  const ensureInstallPreview = (slug: string, manifest: unknown): void => {
    const run = opts.runInstallPreview;
    if (run === undefined) return;
    if (installPreviewFor(slug, manifest) !== undefined) return;
    if (installPreviewInFlight === slug) return;
    installPreviewInFlight = slug;
    void (async () => {
      let preview: InstallPreview;
      try {
        // D-311 — a pack resolved from the marketplace installs by slug, from the
        // marketplace; its preview must resolve from there too, or on a deployed
        // server (which bundles only its foundation packs) it lists nothing it brings in.
        preview = await run({ manifest, ...(pendingAddEntry?.slug === slug ? { marketplace: true } : {}) });
      } catch {
        preview = { resolved: false, will_enable: [], hidden_count: 0 };
      }
      if (installPreviewInFlight === slug) installPreviewInFlight = null;
      if (disposed) return;
      dialogInstallPreview.set(slug, { manifest, preview });
      // D-305 — the dialog usually opens before this lands (it is what asks). What
      // the packs it brings in need joins the selection now, default-checked like
      // the pack's own.
      if (dialogOpenFor === slug) {
        const selection = dialogPermissions.get(slug);
        for (const dependency of preview.dependency_requires ?? []) selection?.add(dependency.permission);
      }
      render();
    })();
  };
  /** In-flight install promise — lets `clickConfirmInstall` await the
   *  same rpc the dialog's Install button fires. */
  let pendingInstallPromise: Promise<void> | null = null;
  /** Semantic owner for the inline consent region. Every selection mutates host
   *  state and rebuilds the dialog, so focus must follow an identity rather than
   *  a short-lived node. */
  let pendingInstallDialogFocus: PacksInstallDialogFocus | null = null;
  // ── Slice B state ────────────────────────────────────────────────
  /** Slug of the pack whose Delete confirm strip is open. Single-row
   *  invariant (DD#9) — opening B's strip collapses A's. */
  let confirmingDeleteFor: string | null = null;
  /** True while the active Delete confirm strip's `packs.uninstall`
   *  rpc is in flight. */
  let deleting = false;
  /** Active Delete strip's inline error message. Cleared on Cancel +
   *  on the next successful uninstall. Per-pack rather than per-row
   *  because only one Delete strip is open at a time (DD#9), so a
   *  single string is enough. */
  let deleteError: string | null = null;
  /** D-304 — what the open Delete confirmation removes with the pack, once known. */
  let deleteRemoves: { slug: string; text: string } | null = null;
  /** In-flight uninstall promise — lets `clickConfirmDelete` await the
   *  same rpc the Confirm button fires. */
  let pendingUninstallPromise: Promise<void> | null = null;
  /** Semantic keyboard owner across the Delete strip's whole-panel repaints.
   *  The actual button node is replaced at every transition, so retaining the
   *  node would leave focus on detached DOM. The descriptor also survives the
   *  loading paint during a successful refresh, then resolves to Install. */
  let pendingDeleteActionFocus: PacksDeleteActionFocus | null = null;
  // ── Slice K state ────────────────────────────────────────────────
  /** Post-success runnability disclosure notice. Survives refreshes;
   *  cleared on dismiss / the next submit kickoff / replaced by the
   *  next success (DD#15). */
  let disclosure: PacksPanelDisclosure | null = null;
  // ── R22 list→detail state ────────────────────────────────────────
  /** Slug shown in DETAIL view; null ⇒ LIST view. Seeded from the deep-link
   *  segment (`initialSlug`); a slug whose pack isn't in the loaded list is
   *  tolerated — `renderReady` falls back to the list until it appears (and
   *  clears a slug that's gone after a refresh, mirroring recipes/data). */
  let selectedSlug: string | null = opts.initialSlug ?? null;
  /** Active pack-detail subview. Controller-driven re-renders preserve it.
   *
   *  ⚠ This is the LAST EXPLICIT choice, not necessarily what is shown — see
   *  `effectiveDetailTab`. A pack that owns runnable recipes opens on Use, and
   *  whether it does is only known once `recipes.list` has answered, which is
   *  after the first paint. */
  let activeDetailTab: PacksDetailTab = 'detail';
  let pendingDetailTabFocus: {
    group: PacksDetailTabGroup;
    id: PacksDetailTab;
  } | null = null;
  /** True once the user has actually picked a tab, which suppresses the
   *  open-on-Use default. Without it, the async recipe load would yank someone
   *  out of Access and into Use the moment the list arrived. */
  let detailTabPinned = false;
  // ── Use tab state ────────────────────────────────────────────────
  /** Installed recipe bodies. `null` = not loaded yet; distinct from `[]`,
   *  which is a real answer meaning this server has none. A failed read stays
   *  explicit in `recipesError` so it cannot masquerade as either state. */
  let installedRecipes: ReadonlyArray<ServerRecipeListEntry> | null = null;
  let recipesLoading = false;
  let recipesError: string | null = null;
  /** Generation guard for a recipe read invalidated by a concurrent pack
   *  mutation/refresh. An older response must not repopulate the new roster. */
  let recipeLoadGeneration = 0;
  /** Sticky across a failed `packs.list` refresh: the mutation already landed,
   *  so the later list Retry must still invalidate and reload recipe bodies. */
  let recipeRefreshPending = false;
  let appView: PackAppViewMount | null = null;
  /** Slug the mounted app view belongs to, so a pack switch tears it down
   *  instead of leaving one pack's views over another pack's page. */
  let appViewSlug: string | null = null;
  /** A route-hydrated generated view belongs to the first mount of its exact
   * pack only. A later roster rebuild must preserve live app state, not replay
   * the original deep-link selection. */
  let initialAppViewPending = opts.initialAppViewId !== undefined;

  /** Memoised app surface.
   *
   *  ⛔ THIS CACHE IS NOT AN OPTIMISATION, it is what makes the Use tab usable.
   *  Classifying a recipe resolves every Tier-P op it names against the whole
   *  installed roster, and that index is rebuilt per call — so one 18-recipe
   *  pack costs ~932k op visits across the ~26k operations the shipped corpus
   *  declares. The panel repaints wholesale on every controller event (DD#5),
   *  which would pay that on each one.
   *
   *  Keyed on IDENTITY of the three inputs, so it is observationally pure: a
   *  hit returns exactly what a recompute would. `packs` is replaced wholesale
   *  by `refreshRows`, and `installedRecipes` is assigned once, so an install /
   *  uninstall invalidates this by construction rather than by remembering to. */
  let surfaceMemo: {
    pack: PackListEntry;
    installed: ReadonlyArray<ServerRecipeListEntry>;
    packs: ReadonlyArray<PackListEntry>;
    value: PackAppSurface;
  } | null = null;

  /** Drop every value derived from `recipe.list`. Pack install/uninstall changes
   *  that inventory, and the mounted app view closes over the old entries, so
   *  both the classifier memo and the child mount must be rebuilt together. */
  const invalidateRecipeRoster = (): void => {
    recipeLoadGeneration += 1;
    installedRecipes = null;
    recipesLoading = false;
    recipesError = null;
    surfaceMemo = null;
    appView?.dispose();
    appView = null;
    appViewSlug = null;
  };

  /** A pack with nothing to open: what a pack that is not installed has. */
  const NO_APP: PackAppSurface = { views: [], lookups: [], operations: [], automations: [], missing: [] };

  /** The pack's app, or null while it cannot be classified yet.
   *
   *  ⛔ NOT ANSWERED UNTIL BOTH HALVES ARE IN HAND: the installed recipes AND
   *  the manifest, which `packs.list` never sends, so `ensureDetailResolved`
   *  backfills it. Classifying without it answered "this pack ships nothing",
   *  and the deep-link collapse below took that for an answer. Measured on a
   *  booted server: a reloaded `#packs/rental-book/use/show-building/<id>` was
   *  discarded at 3.3 s, the manifest landed at 8.3 s, and the Use tab opened on
   *  its first view.
   *
   *  ⛔ AND NO APP FOR A PACK THAT IS NOT INSTALLED, at any version. A source
   *  checkout lists every bundled recipe in `recipe.list`, installed or not, so an
   *  uninstalled pack classified as an app: its Use tab opened first and ran its
   *  first view, which was refused for the pack itself, "This recipe needs a pack
   *  you don't have installed yet" with a "Get federated-projects" link to the
   *  page it was on, under the real Install button (found driving D-310 REV 3,
   *  2026-09-26). A deployed server lists only what is installed, so it never
   *  showed there. That answer needs neither half above, so it is given at once,
   *  as an EMPTY surface rather than null: a `#packs/<slug>/use/<view>` link to a
   *  pack not installed collapses to its detail instead of waiting. */
  const appSurfaceFor = (pack: PackListEntry): PackAppSurface | null => {
    if (pack.installed !== true && pack.installed_any_version !== true) return NO_APP;
    const manifest = pack.manifest;
    if (installedRecipes === null || manifest === undefined) return null;
    if (
      surfaceMemo !== null
      && surfaceMemo.pack === pack
      && surfaceMemo.installed === installedRecipes
      && surfaceMemo.packs === packs
    ) {
      return surfaceMemo.value;
    }
    // D-266 follow-up — the index is built here, inside the SAME memo that
    // already guarded the classification, so the panel's cost is unchanged:
    // one build per (pack, installed, packs) miss, exactly as before.
    const value = packAppSurface(
      { ...pack, manifest }, buildPackAppIndex(installedRecipes, rosterForUsage(packs)),
    );
    surfaceMemo = { pack, installed: installedRecipes, packs, value };
    return value;
  };

  /** What the detail actually shows. Defaults to Use for a pack that has one,
   *  falls back to Detail otherwise, and never strands the user on a Use tab
   *  that has just stopped existing (an uninstall mid-visit). */
  const effectiveDetailTab = (surface: PackAppSurface | null): PacksDetailTab => {
    const canUse = surface !== null && hasAppSurface(surface);
    if (!detailTabPinned) return canUse ? 'use' : 'detail';
    return activeDetailTab === 'use' && !canUse ? 'detail' : activeDetailTab;
  };

  /** Start the recipe-body read. A retry keeps its error/action surface mounted
   *  while busy, so keyboard ownership survives the whole-panel repaint and a
   *  duplicate activation cannot start another request. */
  const loadRecipes = (retry = false): void => {
    if (installedRecipes !== null || recipesLoading) return;
    const run = opts.runRecipeList;
    if (run === undefined) return;
    const captured = ++recipeLoadGeneration;
    recipesLoading = true;
    if (retry) render();
    void run()
      .then((res) => {
        if (disposed || captured !== recipeLoadGeneration) return;
        installedRecipes = res.recipes;
        recipesError = null;
      })
      .catch((err) => {
        if (disposed || captured !== recipeLoadGeneration) return;
        recipesError = humanizeRpcError(err);
      })
      .finally(() => {
        if (disposed || captured !== recipeLoadGeneration) return;
        recipesLoading = false;
        render();
      });
  };

  /** Load recipe bodies once, on first need. A recorded failure is terminal
   *  until the person retries; otherwise the failure repaint calls this again
   *  and creates an unbounded `recipe.list` request/repaint loop. */
  const ensureRecipesLoaded = (): void => {
    if (recipesError !== null) return;
    loadRecipes();
  };

  /** The resolved-but-not-yet-installed marketplace pack, projected from its
   *  fetched manifest (a pack absent from `packs[]`, opened in the detail via
   *  `ensureDetailResolved`). Held OUTSIDE `packs` (which `refreshRows`
   *  overwrites); the detail / consent dialog / submit read it, and its install
   *  routes to `runInstallBySlug`. Cleared on navigation (each detail = one
   *  resolved pack); KEPT across install so the detail flips to Uninstall (its
   *  `installed` re-derives from `rosterInstalledSet`). */
  let pendingAddEntry: PackListEntry | null = null;
  /** Review anchor paired with `pendingAddEntry`; never reused across slugs. */
  let pendingAddManifestHash: string | null = null;

  const canInstall = opts.runInstall !== undefined;
  const canDelete = opts.runUninstall !== undefined;
  /** A marketplace pack (resolved into the detail) installs by slug — the gate
   *  for its Install affordance, distinct from a bundled pack's `runInstall`. */
  const canAdd =
    opts.runResolvePack !== undefined && opts.runInstallBySlug !== undefined;
  /** Slugs that are installed at ANY version — packs[]'s installed entries UNION
   *  the `installed_versions` inventory (the ONLY place a marketplace-installed
   *  pack, absent from `packs[]`, shows up). Rebuilt on every list load; the
   *  detail derives a resolved marketplace pack's installed-state from it. */
  let rosterInstalledSet = new Set<string>();
  /** Exact installed versions when the inventory supplies them. A resolved
   * marketplace pack uses this to distinguish "already current" from "an older
   * version is installed"; the latter must keep the Update review actionable. */
  let rosterInstalledVersions = new Map<string, number>();
  // ── Detail-only marketplace resolve sub-state ────────────────────
  /** Slug whose `runResolvePack` is in flight (detail-only, not-in-roster). */
  let detailResolving: string | null = null;
  /** A resolve failure for a specific slug — surfaced in the detail, and gates
   *  re-resolve so a failed slug doesn't loop on every render. */
  let detailResolveError: { slug: string; message: string } | null = null;

  /** Resolve a slug to its pack, consulting the transient pending entry FIRST so
   *  the pack the user is consenting to (Add-a-pack, or a detail-only resolved
   *  marketplace pack) wins over a same-slug loaded entry. Used by the dialog /
   *  submit / grant-picker / refresh-reconciliation lookups; every other lookup
   *  that must ignore the pending entry (delete) keeps `packs.find`.
   *
   *  The pending entry is projected `installed: false`, but a detail-only
   *  marketplace pack the user JUST installed IS installed (it lands in
   *  `installed_versions`, never in `packs[]`) — so re-derive `installed` from
   *  the roster set here, keeping the detail's Install↔Uninstall affordance
   *  correct across an install/uninstall without a re-resolve. */
  const findPackBySlug = (slug: string): PackListEntry | undefined => {
    if (pendingAddEntry?.slug === slug) {
      const installedVersion = rosterInstalledVersions.get(slug);
      if (installedVersion !== undefined) {
        return {
          ...pendingAddEntry,
          // A newer installed version also satisfies this preview; never turn an
          // older marketplace response into a downgrade-shaped Update action.
          installed: installedVersion >= pendingAddEntry.version,
          installed_any_version: true,
        };
      }
      return rosterInstalledSet.has(slug)
        ? { ...pendingAddEntry, installed: true, installed_any_version: true }
        : pendingAddEntry;
    }
    return packs.find((p) => p.slug === slug);
  };

  /** Client-side projection of a resolved manifest into a `PackListEntry` —
   *  mirrors the server's `projectManifest` (pack-list-handler.ts) but always
   *  `installed: false` (Add-a-pack resolves packs the user hasn't installed).
   *  Held as `pendingAddEntry`, never merged into `packs`. */
  const projectAddedManifest = (
    manifest: BulkPackManifest,
    ownerOperationReview?: PackListEntry['owner_operation_review'],
    recordsReview?: PackListEntry['records_review'],
    manifestReviewHash?: string,
    operationDiff?: PackListEntry['operation_diff'],
    currentAccess?: PackListEntry['current_access'],
    currentAudience?: PackListEntry['current_audience'],
    currentConnection?: PackListEntry['current_connection'],
  ): PackListEntry => ({
    slug: manifest.slug,
    publisher: manifest.publisher,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    pre_install: manifest.pre_install === true,
    installed: false,
    requires: [...manifest.requires],
    recipe_count: manifest.recipes.length,
    recipe_refs: manifest.recipes.map((r) => ({ slug: r.slug, version: r.version })),
    body_visibility_grant_keys: [...(manifest.mcp_body_visibility_grants ?? [])],
    ...(typeof manifest.service_kind === 'string' ? { service_kind: manifest.service_kind } : {}),
    ...(typeof manifest.repo === 'string' ? { repo: manifest.repo } : {}),
    body_visibility_grant_count: manifest.mcp_body_visibility_grants?.length ?? 0,
    manifest,
    ...(ownerOperationReview !== undefined && ownerOperationReview.length > 0
      ? { owner_operation_review: ownerOperationReview }
      : {}),
    ...(recordsReview !== undefined ? { records_review: recordsReview } : {}),
    ...(manifestReviewHash !== undefined
      ? { manifest_review_hash: manifestReviewHash }
      : {}),
    ...(operationDiff !== undefined ? { operation_diff: operationDiff } : {}),
    ...(currentAccess !== undefined ? { current_access: currentAccess } : {}),
    ...(currentAudience !== undefined ? { current_audience: currentAudience } : {}),
    ...(currentConnection !== undefined ? { current_connection: currentConnection } : {}),
  });

  /** Detail-only — resolve a marketplace pack whose manifest isn't bundled (so
   *  it's absent from `packs[]`) into a full `PackListEntry` so its `#packs/<slug>`
   *  detail renders at full fidelity + installs via the by-slug path. Idempotent
   *  + guarded: no-op when not detail-only, no resolve caller, already in the
   *  roster, already resolved (pending), in flight, or already errored for this
   *  slug unless the owner explicitly retries (so a failure doesn't loop on
   *  every render). Re-renders on completion. */
  const ensureDetailResolved = (slug: string, retry = false): void => {
    if (opts.runResolvePack === undefined) return;
    // ⛔ Was `packs.some(...)` — skip anything already listed. That held while
    // `packs.list` forwarded EVERY manifest; it now forwards NONE, installed or
    // not (see `PackListEntry.manifest` — this comment said "installed only" for a
    // while, which hid that an installed pack's Use tab waits on this too). Every
    // listed pack arrives without one, and its detail, install consent and app
    // surface need it — so resolve it. `packs.resolveBySlug` reads the server's
    // own bundled copy first, so this is a local read, not a marketplace round-trip.
    const listed = packs.find((p) => p.slug === slug);
    if (listed !== undefined && listed.manifest !== undefined) return;
    if (pendingAddEntry?.slug === slug) return;
    if (detailResolving === slug) return;
    if (detailResolveError?.slug === slug && !retry) return;
    detailResolving = slug;
    const resolve = opts.runResolvePack;
    void (async () => {
      try {
        const result = await resolve(slug);
        if (disposed) return;
        if (selectedSlug !== slug) return; // navigated away mid-resolve
        if (result.manifest === null) {
          pendingAddManifestHash = null;
          detailResolveError = {
            slug,
            message: result.failure?.message ?? COPY.add_generic_error,
          };
        } else if (packs.some((p) => p.slug === slug)) {
          // ⛔ A LISTED pack backfills its own row — it must NOT become a
          // `pendingAddEntry`. That flag is what routes an install to
          // `packs.installBySlug` (the marketplace resolver), and a pack the
          // roster already carries installs BY VALUE through `packs.install`.
          // Promoting it here would silently reroute every bundled / community
          // pack's install onto the marketplace path. All that is actually
          // missing is the manifest `packs.list` stopped forwarding, so put
          // exactly that back and leave every other field the list computed.
          const resolved = result.manifest;
          const reviewHash = result.manifest_review_hash;
          packs = packs.map((p) => (
            p.slug === slug
              ? {
                  ...p,
                  manifest: resolved,
                  ...(reviewHash !== undefined
                    ? { manifest_review_hash: reviewHash }
                    : {}),
                }
              : p
          ));
          detailResolveError = null;
        } else {
          pendingAddEntry = projectAddedManifest(
            result.manifest,
            result.owner_operation_review,
            result.records_review,
            result.manifest_review_hash,
            result.operation_diff,
            result.current_access,
            result.current_audience,
            result.current_connection,
          );
          pendingAddManifestHash = result.manifest_review_hash ?? null;
          detailResolveError = null;
        }
      } catch (err) {
        if (!disposed && selectedSlug === slug) {
          detailResolveError = { slug, message: humanizeRpcError(err) };
        }
      } finally {
        if (detailResolving === slug) detailResolving = null;
        if (!disposed) render();
      }
    })();
  };

  // Supervision feature (Slice 4) — one controller for the pack-detail daemon
  // controls. Refreshed alongside packs.list; re-renders the panel on change.
  // renderForPack returns null when a pack ships no supervisable daemon op (or
  // no set caller), so the row is unchanged for non-daemon packs.
  const supervision: SupervisionController = createSupervisionController({
    document: doc,
    ...(opts.runSupervisionList ? { runList: opts.runSupervisionList } : {}),
    ...(opts.runSupervisionSet ? { runSet: opts.runSupervisionSet } : {}),
    ...(opts.runReachabilityUniverse
      ? { runReachabilityUniverse: opts.runReachabilityUniverse }
      : {}),
    // Reuse the panel's D-121 subscriber so a daemon state change on the server
    // re-lists the controls live (the same `subscribe` packs.* uses).
    ...(opts.subscribe ? { subscribe: opts.subscribe } : {}),
    onChange: () => transitionTo(state, true),
  });

  // Connections readiness — read-only; loaded alongside packs.list, rendered
  // per row. renderForPack returns null for a pack with no scope-bearing
  // connection, so non-vendor packs are unchanged.
  const connectionsReadiness: ConnectionsReadinessController =
    createConnectionsReadinessController({
      document: doc,
      ...(opts.runConnectionList ? { runConnectionList: opts.runConnectionList } : {}),
    });

  // R3 — the by-PACK Access controller (the detail's ACCESS section). Loaded
  // alongside packs.list; renderForPack returns null for a pack with no
  // catalog ops (the placeholder copy stays).
  const packAccess: PackAccessController = createPackAccessController({
    document: doc,
    ...(opts.runListContracts ? { runListContracts: opts.runListContracts } : {}),
    ...(opts.runContractGrantRead ? { runGrantRead: opts.runContractGrantRead } : {}),
    ...(opts.runContractGrantWrite ? { runGrantWrite: opts.runContractGrantWrite } : {}),
    ...(opts.runCatalogOperations ? { runCatalogOperations: opts.runCatalogOperations } : {}),
    ...(opts.runCliReachabilityList
      ? { runCliReachabilityList: opts.runCliReachabilityList }
      : {}),
    ...(opts.runCliReachabilitySet
      ? { runCliReachabilitySet: opts.runCliReachabilitySet }
      : {}),
    ...(opts.subscribe ? { subscribe: opts.subscribe } : {}),
    onChange: () => transitionTo(state, true),
  });

  // D-211 — pack-authored operation defaults plus the owner's global
  // replacement. Deliberately separate from the per-contract Access matrix.
  const ownerOperations: OwnerOperationController = createOwnerOperationController({
    document: doc,
    ...(opts.runOwnerOperationInventory
      ? { runOperations: opts.runOwnerOperationInventory }
      : {}),
    ...(opts.runOwnerOperationList
      ? { runListOverrides: opts.runOwnerOperationList }
      : {}),
    ...(opts.runOwnerOperationUpsert
      ? { runUpsertOverride: opts.runOwnerOperationUpsert }
      : {}),
    ...(opts.runOwnerOperationDelete
      ? { runDeleteOverride: opts.runOwnerOperationDelete }
      : {}),
    onChange: () => transitionTo(state, true),
  });

  const refreshInstallAudienceOptions = async (): Promise<void> => {
    const [seller, contracts] = await Promise.allSettled([
      opts.runSellerOverview?.() ?? Promise.resolve(undefined),
      opts.runListContracts?.() ?? Promise.resolve(undefined),
    ]);
    if (disposed) return;
    if (seller.status === 'fulfilled' && seller.value !== undefined) {
      customerTierOptions = seller.value.tiers
        .filter((tier) => tier.active)
        .map((tier) => ({
          id: tier.tier_id,
          label: `${tier.display_name} (${tier.entitlement_key})`,
        }));
      customerLabelByContract = new Map(seller.value.customers.map((customer) => [
        customer.contract_id,
        customer.email ?? customer.source_customer_id,
      ]));
    }
    if (contracts.status === 'fulfilled' && contracts.value !== undefined) {
      contractAudienceOptions = contracts.value.contracts
        .filter((contract) =>
          contract.lifecycle_state === 'active'
          && (contract.grant_kind === undefined || contract.grant_kind === 'standing'))
        .map((contract) => ({
          id: contract.contract_id,
          label: contract.display_name,
        }));
    }
  };

  // ── Wrapper ──────────────────────────────────────────────────────
  const wrapper = doc.createElement('div');
  wrapper.setAttribute(PACKS_PANEL_ATTR, '');
  wrapper.setAttribute(PACKS_PANEL_STATE_ATTR, state);
  wrapper.className = 'packs-panel';
  opts.host.appendChild(wrapper);

  // Same walker shape as the panel test harnesses: real DOMs expose
  // `children`; reduced fixtures may expose `childList` instead.
  const findPanelElement = (
    matches: (element: HTMLElement) => boolean,
  ): HTMLElement | null => {
    const walk = (node: HTMLElement): HTMLElement | null => {
      if (matches(node)) return node;
      const kids =
        (node as unknown as { children?: ArrayLike<HTMLElement> }).children
        ?? (node as unknown as { childList?: ArrayLike<HTMLElement> }).childList;
      if (!kids) return null;
      const length = (kids as { length: number }).length;
      for (let i = 0; i < length; i += 1) {
        const hit = walk(kids[i] as HTMLElement);
        if (hit) return hit;
      }
      return null;
    };
    return walk(wrapper as HTMLElement);
  };

  const findBtn = (
    attr: string,
    attrValue?: string,
  ): HTMLButtonElement | null => {
    const found = findPanelElement((element) =>
      typeof element.hasAttribute === 'function'
      && element.hasAttribute(attr)
      && element.tagName === 'BUTTON'
      && (attrValue === undefined || element.getAttribute(attr) === attrValue));
    return found as HTMLButtonElement | null;
  };

  const findDetailTab = (
    group: PacksDetailTabGroup,
    id: PacksDetailTab,
  ): HTMLButtonElement | null => {
    const found = findPanelElement((element) =>
      element.tagName === 'BUTTON'
      && element.getAttribute?.(PACKS_DETAIL_TAB_ATTR) === id
      && element.getAttribute?.(PACKS_DETAIL_TAB_GROUP_ATTR) === group);
    return found as HTMLButtonElement | null;
  };

  const findSelectedDetailTab = (): HTMLButtonElement | null => {
    const found = findPanelElement((element) =>
      element.tagName === 'BUTTON'
      && element.hasAttribute?.(PACKS_DETAIL_TAB_ATTR)
      && element.getAttribute?.('aria-selected') === 'true');
    return found as HTMLButtonElement | null;
  };

  const focusPanelElement = (element: HTMLElement | null): void => {
    if (element === null) return;
    try {
      element.focus?.({ preventScroll: true });
    } catch {
      // Reduced/fake DOMs keep focus restoration best-effort.
    }
  };

  const deleteActionFocusFrom = (
    element: HTMLElement,
  ): PacksDeleteActionFocus | null => {
    const candidates: ReadonlyArray<{
      attr: string;
      kind: PacksDeleteActionFocus['kind'];
    }> = [
      { attr: PACKS_ROW_DELETE_BTN_ATTR, kind: 'delete' },
      { attr: PACKS_ROW_DELETE_CONFIRM_BTN_ATTR, kind: 'confirm' },
      { attr: PACKS_ROW_DELETE_CANCEL_BTN_ATTR, kind: 'cancel' },
    ];
    for (const candidate of candidates) {
      const slug = element.getAttribute?.(candidate.attr);
      if (slug !== null) return { kind: candidate.kind, slug };
    }
    return null;
  };

  /** Resolve an action descriptor to the best current replacement. Confirm may
   *  become Install after success or Delete after a refresh that kept the pack
   *  installed. A failed post-action relist hands ownership to Retry; Back is
   *  the final fallback when the detail vanished. */
  const restoreDeleteActionFocus = (
    focus: PacksDeleteActionFocus,
  ): boolean => {
    const exact = focus.kind === 'delete'
      ? findBtn(PACKS_ROW_DELETE_BTN_ATTR, focus.slug)
      : focus.kind === 'confirm'
        ? findBtn(PACKS_ROW_DELETE_CONFIRM_BTN_ATTR, focus.slug)
        : findBtn(PACKS_ROW_DELETE_CANCEL_BTN_ATTR, focus.slug);
    const target = exact
      ?? findBtn(PACKS_ROW_INSTALL_BTN_ATTR, focus.slug)
      ?? findBtn(PACKS_ROW_DELETE_BTN_ATTR, focus.slug)
      ?? findBtn(PACKS_ROW_DELETE_CONFIRM_BTN_ATTR, focus.slug)
      ?? findBtn(PACKS_RETRY_BTN_ATTR)
      ?? findBtn(PACKS_DETAIL_BACK_ATTR);
    if (target === null || target.disabled) return false;
    focusPanelElement(target);
    return true;
  };

  const findInstallDialog = (slug: string): HTMLElement | null =>
    findPanelElement((element) =>
      element.hasAttribute?.(PACKS_DIALOG_ATTR)
      && element.getAttribute?.(PACKS_DIALOG_SLUG_ATTR) === slug);

  const installControlIdentityFrom = (
    element: HTMLElement,
  ): ReadonlyArray<readonly [string, string]> | null => {
    const candidates: ReadonlyArray<{
      attribute: string;
      qualifiers: ReadonlyArray<string>;
    }> = [
      { attribute: PACKS_DIALOG_PERMISSION_ATTR, qualifiers: [] },
      {
        attribute: INSTALL_GRANT_ACCESS_OPTION_ATTR,
        qualifiers: ['data-access'],
      },
      {
        attribute: INSTALL_GRANT_SCOPE_OPTION_ATTR,
        qualifiers: ['data-scope'],
      },
      {
        attribute: INSTALL_GRANT_AUDIENCE_DETAIL_OPTION_ATTR,
        qualifiers: ['data-audience-kind', 'data-audience-id'],
      },
      { attribute: INSTALL_CONNECT_CANDIDATE_ATTR, qualifiers: [] },
      { attribute: INSTALL_CONNECT_NONE_ATTR, qualifiers: [] },
      { attribute: INSTALL_CONNECT_CUSTOMIZE_ATTR, qualifiers: [] },
    ];
    for (const candidate of candidates) {
      if (!element.hasAttribute?.(candidate.attribute)) continue;
      const identity: Array<readonly [string, string]> = [[
        candidate.attribute,
        element.getAttribute(candidate.attribute) ?? '',
      ]];
      for (const qualifier of candidate.qualifiers) {
        const value = element.getAttribute(qualifier);
        if (value !== null) identity.push([qualifier, value]);
      }
      return identity;
    }
    return null;
  };

  const installDialogFocusFrom = (
    element: HTMLElement,
  ): PacksInstallDialogFocus | null => {
    const openerSlug = element.getAttribute?.(PACKS_ROW_INSTALL_BTN_ATTR);
    if (openerSlug !== null) return { kind: 'opener', slug: openerSlug };
    const dialog = findPanelElement((candidate) =>
      candidate.hasAttribute?.(PACKS_DIALOG_ATTR)
      && candidate.contains(element));
    const slug = dialog?.getAttribute?.(PACKS_DIALOG_SLUG_ATTR) ?? null;
    if (slug === null) return null;
    if (element.hasAttribute?.(PACKS_DIALOG_ATTR)) {
      return { kind: 'dialog', slug };
    }
    if (element.hasAttribute?.(PACKS_DIALOG_INSTALL_BTN_ATTR)) {
      return { kind: 'submit', slug };
    }
    if (element.hasAttribute?.(PACKS_DIALOG_CANCEL_BTN_ATTR)) {
      return { kind: 'cancel', slug };
    }
    const identity = installControlIdentityFrom(element);
    return identity === null
      ? { kind: 'dialog', slug }
      : { kind: 'control', slug, identity };
  };

  const restoreInstallDialogFocus = (
    focus: PacksInstallDialogFocus,
  ): boolean => {
    // A successful install normally replaces the dialog with Delete. If the
    // mandatory relist fails instead, Retry is the only actionable successor.
    const dialog = findInstallDialog(focus.slug);
    let candidates: ReadonlyArray<HTMLElement | null>;
    if (focus.kind === 'opener') {
      candidates = [
        findBtn(PACKS_ROW_INSTALL_BTN_ATTR, focus.slug),
        dialog,
        findBtn(PACKS_ROW_DELETE_BTN_ATTR, focus.slug),
        findBtn(PACKS_RETRY_BTN_ATTR),
        findBtn(PACKS_DETAIL_BACK_ATTR),
      ];
    } else if (focus.kind === 'dialog') {
      candidates = [
        dialog,
        findBtn(PACKS_ROW_INSTALL_BTN_ATTR, focus.slug),
        findBtn(PACKS_ROW_DELETE_BTN_ATTR, focus.slug),
        findBtn(PACKS_RETRY_BTN_ATTR),
        findBtn(PACKS_DETAIL_BACK_ATTR),
      ];
    } else if (focus.kind === 'submit') {
      candidates = [
        findBtn(PACKS_DIALOG_INSTALL_BTN_ATTR),
        findBtn(PACKS_ROW_DELETE_BTN_ATTR, focus.slug),
        findBtn(PACKS_ROW_INSTALL_BTN_ATTR, focus.slug),
        findBtn(PACKS_RETRY_BTN_ATTR),
        findBtn(PACKS_DETAIL_BACK_ATTR),
      ];
    } else if (focus.kind === 'cancel') {
      candidates = [
        findBtn(PACKS_DIALOG_CANCEL_BTN_ATTR),
        findBtn(PACKS_ROW_INSTALL_BTN_ATTR, focus.slug),
        dialog,
        findBtn(PACKS_ROW_DELETE_BTN_ATTR, focus.slug),
        findBtn(PACKS_RETRY_BTN_ATTR),
        findBtn(PACKS_DETAIL_BACK_ATTR),
      ];
    } else {
      const exact = findPanelElement((element) =>
        focus.identity.every(([attribute, value]) =>
          element.getAttribute?.(attribute) === value));
      const expandedConnectionChoice = focus.identity[0]?.[0]
        === INSTALL_CONNECT_CUSTOMIZE_ATTR
        ? findPanelElement((element) =>
            element.hasAttribute?.(INSTALL_CONNECT_CANDIDATE_ATTR)
            || element.hasAttribute?.(INSTALL_CONNECT_NONE_ATTR))
        : null;
      candidates = [
        exact,
        expandedConnectionChoice,
        dialog,
        findBtn(PACKS_ROW_INSTALL_BTN_ATTR, focus.slug),
        findBtn(PACKS_ROW_DELETE_BTN_ATTR, focus.slug),
        findBtn(PACKS_RETRY_BTN_ATTR),
        findBtn(PACKS_DETAIL_BACK_ATTR),
      ];
    }
    const target = candidates.find((candidate) => candidate !== null) ?? null;
    if (target === null || (target as HTMLButtonElement).disabled === true) {
      return false;
    }
    focusPanelElement(target);
    return true;
  };

  // ── Transitions ──────────────────────────────────────────────────
  // `force = true` re-renders even when state is unchanged; rpc paths
  // use this when row state mutates without a state transition (post-
  // install refresh). The same-state short-circuit prevents the initial
  // mount from double-painting `loading` when both the pre-kickoff
  // `render()` and `refreshRows`' `transitionTo` paint into the same
  // wrapper.
  const transitionTo = (
    next: PacksPanelState,
    force = false,
  ): void => {
    if (disposed) return;
    if (!force && state === next) return;
    state = next;
    wrapper.setAttribute(PACKS_PANEL_STATE_ATTR, state);
    render();
  };

  const refreshRows = (options: {
    preserveErrorSurface?: boolean;
    refreshRecipes?: boolean;
  } = {}): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (options.refreshRecipes === true) recipeRefreshPending = true;
    if (listRetrying && options.preserveErrorSurface !== true) {
      return pendingListPromise;
    }
    // Slice H — capture this load's generation BEFORE the await
    // (DD#14). Both the success + error branches re-check the captured
    // value against the latest `loadGeneration` after the await; a
    // mismatch means a newer load has been kicked off + this one is
    // stale, so drop the result silently. The pre-increment + capture
    // is the only place the counter mutates.
    const captured = ++loadGeneration;
    if (options.preserveErrorSurface !== true) {
      listError = null;
      transitionTo('loading');
    }
    const promise = (async () => {
      try {
        // Load packs + the supervision discovery list + the enrolled-connection
        // list + the access matrix in parallel so the ready-render below
        // includes the daemon controls + the readiness block + the ACCESS
        // panel in one paint.
        const [result] = await Promise.all([
          opts.runList(),
          supervision.refresh(),
          connectionsReadiness.refresh(),
          packAccess.refresh(),
          ownerOperations.refresh(),
          refreshInstallAudienceOptions(),
        ]);
        if (disposed) return;
        if (captured !== loadGeneration) return; // newer load in flight (DD#14)
        if (recipeRefreshPending) {
          invalidateRecipeRoster();
          recipeRefreshPending = false;
        }
        packs = [...result.packs];
        // Roster installed-set — packs[]'s installed entries UNION the
        // `installed_versions` inventory. The inventory is the ONLY signal a
        // marketplace pack (absent from `packs[]`) is installed, which the
        // detail-only surface needs to flip a resolved pack Install→Uninstall.
        rosterInstalledSet = new Set<string>([
          ...packs.filter((p) => p.installed || p.installed_any_version === true).map((p) => p.slug),
          ...(result.installed_versions ?? []).map((iv) => iv.slug),
        ]);
        rosterInstalledVersions = new Map(
          (result.installed_versions ?? []).map((iv) => [iv.slug, iv.version]),
        );
        // Older/dbless list handlers may omit the inventory array. Exact
        // installed pack rows still provide a safe version fact.
        for (const pack of packs) {
          if (pack.installed && !rosterInstalledVersions.has(pack.slug)) {
            rosterInstalledVersions.set(pack.slug, pack.version);
          }
        }
        // Codex review fold (MAJOR 2) — reconcile dialog state against
        // the refreshed list. Two cases close the dialog automatically:
        //   - the pack the user was about to install vanished server-
        //     side (rare; would require a pack-file delete + immediate
        //     refresh — but Slice A's post-install auto-refresh path
        //     reuses `refreshRows` so the close-on-disappear branch
        //     guards every refresh symmetrically), AND
        //   - the pack is now installed (the open dialog would surface
        //     an Install affordance the rpc would reject; this case is
        //     load-bearing — the post-install success path sets
        //     `dialogOpenFor = null` BEFORE awaiting refreshRows so
        //     the branch is normally inert there, but a refresh
        //     triggered by another tab installing the same pack while
        //     this tab's dialog was open lands here).
        // The map cleanup mirrors closeDialog so a re-open later starts
        // from defaults.
        if (dialogOpenFor !== null) {
          // Reconciliation is the ONE lookup that must prefer the AUTHORITATIVE
          // refreshed roster over the pending Add entry (submit / grant-picker
          // are pending-first). Two cases close the dialog:
          //   - the refreshed roster says this slug is installed (installed in
          //     another tab / by a bus event while the dialog was open) — a
          //     `findPackBySlug` (pending-first) lookup would MASK that behind
          //     `pendingAddEntry.installed === false` and let a stale by-slug
          //     install fire; consult `packs` directly so the installed row wins;
          //   - the slug is gone from the roster AND it isn't a pending Add (a
          //     pending Add legitimately isn't in `packs` yet — don't close it
          //     just for being absent, or a bus-refresh would nuke the in-progress
          //     consent).
          const rosterRow = packs.find((p) => p.slug === dialogOpenFor);
          const pendingVersion =
            pendingAddEntry !== null && pendingAddEntry.slug === dialogOpenFor
              ? pendingAddEntry.version
              : undefined;
          const isPendingAdd = pendingVersion !== undefined;
          // A resolved marketplace pack (pending Add, absent from `packs[]`)
          // installed elsewhere lands in the inventory set, not `packs[]` — close
          // its stale install dialog too, so the detail flips to Uninstall.
          const pendingInstalledVersion = rosterInstalledVersions.get(dialogOpenFor);
          const pendingNowInstalled = pendingVersion !== undefined && (
            pendingInstalledVersion !== undefined
              ? pendingInstalledVersion >= pendingVersion
              : rosterInstalledSet.has(dialogOpenFor)
          );
          if (
            rosterRow?.installed
            || pendingNowInstalled
            || (rosterRow === undefined && !isPendingAdd)
          ) {
            dialogPermissions.delete(dialogOpenFor);
            clearDialogGrantPicks(dialogOpenFor);
            if (isPendingAdd) {
              pendingAddEntry = null;
              pendingAddManifestHash = null;
            }
            dialogOpenFor = null;
            dialogError = null;
          }
        }
        // Slice B — symmetric reconciliation for the Delete confirm
        // strip. Two cases close it on refresh:
        //   - the pack vanished server-side (a concurrent uninstall +
        //     a marketplace removal happened in the same window — rare
        //     but possible);
        //   - the pack is now uninstalled (a concurrent uninstall from
        //     another tab; this strip would surface a Delete button the
        //     rpc would 404 with `not_found`). The post-uninstall
        //     success path sets `confirmingDeleteFor = null` BEFORE
        //     awaiting refreshRows so this branch is normally inert
        //     there, but it catches the concurrent-tab case.
        if (confirmingDeleteFor !== null) {
          // "Still installed" spans BOTH sources — a bundled pack's `packs[]`
          // row AND the inventory set (a marketplace pack the detail is deleting
          // never appears in `packs[]`). Without the inventory check, any
          // concurrent broadcast refresh would spuriously close a marketplace
          // pack's confirm strip (it's never a `packs[]` row).
          const rosterRow = packs.find((p) => p.slug === confirmingDeleteFor);
          const stillInstalled =
            rosterRow?.installed === true || rosterInstalledSet.has(confirmingDeleteFor);
          if (!stillInstalled) {
            confirmingDeleteFor = null;
            deleteError = null;
          }
        }
        transitionTo('ready');
      } catch (err) {
        if (disposed) return;
        if (captured !== loadGeneration) return; // newer load in flight (DD#14)
        listError = humanizeRpcError(err);
        transitionTo('error');
      }
    })();
    pendingListPromise = promise;
    return promise;
  };

  // ── Dialog transitions ──────────────────────────────────────────

  const closeDialog = (): void => {
    if (installing) return; // do not interrupt an in-flight install
    if (dialogOpenFor === null) return;
    // Codex review fold (Major) — clear the per-pack permission map
    // entry on close. Otherwise a user who opens → unchecks → cancels
    // → re-opens would see their stale unchecked state, which is a
    // subtle bug because the default-checked invariant is the
    // assumed-consent UX. The map entry is recreated fresh on the next
    // openDialog().
    const slug = dialogOpenFor;
    dialogPermissions.delete(slug);
    // D-182 §7.1 (inc 5b.2) — drop the per-pack Access selection on close for
    // the same reason: a re-open should start fresh at the picker's `read`
    // default, not a stale higher tier the user picked then cancelled.
    clearDialogGrantPicks(slug);
    // KEEP a resolved marketplace `pendingAddEntry` on cancel — it IS the detail
    // the user is still viewing; discarding it would force a needless (and
    // possibly failing) re-resolve on the very next render. It's cleared on
    // navigation (selectPack), not on dialog cancel.
    dialogOpenFor = null;
    dialogError = null;
    pendingInstallPromise = null;
    pendingInstallDialogFocus = { kind: 'opener', slug };
    if (!disposed) render();
  };

  // R22 list→detail — open a pack's DETAIL view (`slug`) or return to the LIST
  // (`null`). Leaving a pack collapses any open install dialog / delete strip so
  // stale per-pack state can't paint on the newly-selected pack (mirrors
  // openDialog's single-mode-at-a-time collapse). Blocked mid-rpc so the
  // single-rpc-at-a-time invariant (DD#10) — whose submit handlers assume the
  // targeted row/dialog stays mounted — holds. Notifies the host so it can
  // align the `#packs/<slug>` address without a remount.
  const selectPack = (slug: string | null): void => {
    if (installing || deleting) return;
    if (slug === selectedSlug) return;
    if (appView?.hasInFlightWork() === true) {
      const confirm = doc.defaultView?.confirm;
      if (
        typeof confirm === 'function'
        && !confirm.call(
          doc.defaultView,
          'Something is still happening. Leave anyway?',
        )
      ) return;
    }
    if (appView?.hasUnsavedChanges() === true) {
      const confirm = doc.defaultView?.confirm;
      if (
        typeof confirm === 'function'
        && !confirm.call(
          doc.defaultView,
          'You have changes you have not saved. Leave anyway?',
        )
      ) return;
    }
    if (dialogOpenFor !== null) {
      dialogPermissions.delete(dialogOpenFor);
      clearDialogGrantPicks(dialogOpenFor);
      dialogOpenFor = null;
      dialogError = null;
      pendingInstallPromise = null;
    }
    if (confirmingDeleteFor !== null) {
      confirmingDeleteFor = null;
      deleteError = null;
      pendingUninstallPromise = null;
    }
    // Each detail is one resolved marketplace pack; navigating away discards the
    // resolved entry + any resolve error so the next slug resolves fresh (and a
    // previously-failed slug retries on re-visit). An in-flight resolve
    // self-cancels via its `selectedSlug !== slug` guard.
    pendingAddEntry = null;
    pendingAddManifestHash = null;
    detailResolveError = null;
    initialAppViewPending = false;
    selectedSlug = slug;
    activeDetailTab = 'detail';
    detailTabPinned = false;
    pendingDetailTabFocus = null;
    pendingDeleteActionFocus = null;
    pendingInstallDialogFocus = null;
    // Kick the recipe read as the detail opens, so the Use tab is usually
    // resolved by first paint rather than appearing a beat later.
    ensureRecipesLoaded();
    opts.onSelectSlug?.(slug);
    if (!disposed) render();
  };

  const openDialog = (slug: string): void => {
    if (state !== 'ready') return;
    if (installing) return;
    // Slice B — block opening the install dialog while a Delete is
    // mid-rpc. The Delete strip's button is `aria-disabled` during the rpc
    // (DD#10), but the test seam can still drive `clickInstall` so the
    // gate is enforced here too.
    if (deleting) return;
    // Pending-first lookup so a detail-only resolved marketplace pack (absent
    // from `packs[]`) opens its dialog too. Its install routes by slug, so gate
    // on `canAdd` for the added path and `canInstall` for a loaded pack.
    const target = findPackBySlug(slug);
    if (!target) return;
    if (target.installed) return;
    const isAdded = pendingAddEntry?.slug === slug;
    if (isAdded ? !canAdd : !canInstall) return;
    // Single-row dialog (DD#2). Opening B on top of A would race the
    // permission map state; we mirror devices-page-mount's collapse-
    // first invariant. Clear the collapsed dialog's grant + Connect picks in
    // lockstep with its permissions (D-194 2b-2 lifecycle symmetry) so no stale
    // pick survives to a later reopen.
    if (dialogOpenFor !== null && dialogOpenFor !== slug) {
      dialogPermissions.delete(dialogOpenFor);
      clearDialogGrantPicks(dialogOpenFor);
    }
    // Codex MAJOR 1 fold — single-mode-at-a-time across affordances.
    // Opening an install dialog implies the user pivoted away from
    // ANY in-progress Delete decision; collapse any open Delete strip
    // regardless of slug. Without this gate, a Delete confirm strip
    // on pack A could stay open + armed while an install dialog opens
    // on pack B, letting the user fire `packs.uninstall(A)` while
    // simultaneously inspecting an install-dialog for B — incoherent
    // UX + breaks the single-rpc-at-a-time invariant (DD#10) the
    // submit handlers depend on.
    if (confirmingDeleteFor !== null) {
      confirmingDeleteFor = null;
      deleteError = null;
      pendingUninstallPromise = null;
    }
    dialogOpenFor = slug;
    dialogError = null;
    pendingInstallPromise = null;
    // Seed permission selections from manifest.requires[]: every entry
    // default-checked (DD#3). The always-required ALWAYS_REQUIRED_PERMISSION
    // stays in the set even if the user un-toggles other entries via
    // togglePermission's no-op guard.
    const seed = new Set<string>(target.requires);
    // D-305 — and what the packs it brings in need, default-checked the same way:
    // the install refuses without them. Only when the preview is already in hand;
    // otherwise they join when it lands (`ensureInstallPreview`).
    for (const dependency of installPreviewFor(slug, target.manifest)?.dependency_requires ?? []) {
      seed.add(dependency.permission);
    }
    seed.add(ALWAYS_REQUIRED_PERMISSION);
    dialogPermissions.set(slug, seed);
    // D-182 §7.1/§7.2 — authoritative reset of BOTH grant-picker picks (Access +
    // Scope) on every open, so a prior selection cannot survive ANY close path
    // (cancel, a refresh that closed the dialog, or a successful reinstall of the
    // same slug) — the picker always starts fresh at its defaults (Codex 5b.2 MED).
    // `closeDialog` + the success path also clear them; this is the belt-and-
    // suspenders that covers the paths that bypass `closeDialog`.
    clearDialogGrantPicks(slug);
    pendingDeleteActionFocus = null;
    pendingInstallDialogFocus = { kind: 'dialog', slug };
    render();
  };

  const togglePermissionInternal = (permission: string): boolean => {
    if (dialogOpenFor === null) return false;
    if (installing) return false;
    // ALWAYS_REQUIRED_PERMISSION is rendered non-interactive (DD#3) but
    // a programmatic test caller could reach this path. Refuse the
    // toggle so the invariant holds across surfaces.
    if (permission === ALWAYS_REQUIRED_PERMISSION) return true;
    const selection = dialogPermissions.get(dialogOpenFor);
    if (!selection) return false;
    if (selection.has(permission)) {
      selection.delete(permission);
      render();
      return false;
    }
    selection.add(permission);
    render();
    return true;
  };

  /** D-182 §7.1 (inc 5b.2) — the connection-backed grant model for the open
   *  dialog's pack, or `null` when none is open / the pack is not
   *  connection-backed. Recomputed on demand (cheap: bounded composition). */
  const grantModelFor = (pack: PackListEntry): InstallGrantPickerModel | null =>
    // No manifest ⇒ not installed and not yet resolved; there is no grant model
    // to compute rather than an empty one.
    // ⛔ The dialog's OWN model — with the preview's per-recipe risk — so a tier
    // the dialog offers is a tier this panel accepts and sends.
    pack.manifest === undefined
      ? null
      : installDialogGrantModel(pack.manifest, installPreviewFor(pack.slug, pack.manifest));

  /** D-182 §7.1 (inc 5b.2) — the Access tier the install rpc will send for a
   *  connection-backed pack. The clamp itself lives with the dialog module
   *  ({@link resolveInstallDialogAccess}); this reads the panel's pick map. */
  const grantAccessFor = (
    slug: string,
    model: InstallGrantPickerModel,
  ): InstallAccessTier =>
    resolveInstallDialogAccess(dialogGrantAccess.get(slug) ?? updateStartAccess(slug, model), model);

  /** ⛔ AN UPDATE STARTS AT THE ACCESS THE PACK HOLDS NOW (`current_access`),
   *  never the fresh-install default. An update REPLACES the pack's grants, so
   *  starting at "Read only" quietly took a "Read + write" pack's writes away the
   *  moment the owner pressed Update. Clamped to a tier this update offers — and
   *  only ever DOWN from the current one, never above it. */
  const updateStartAccess = (
    slug: string,
    model: InstallGrantPickerModel | null,
  ): InstallAccessTier | undefined => {
    const pack = findPackBySlug(slug);
    if (pack === undefined || model === null) return undefined;
    if (pack.installed_any_version !== true || pack.installed) return undefined;
    if (pack.current_access === undefined) return undefined;
    const order: readonly InstallAccessTier[] = ['read', 'write', 'all'];
    const ceiling = order.indexOf(pack.current_access);
    return [...model.accessOptions]
      .filter((tier) => order.indexOf(tier) <= ceiling)
      .sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
  };

  /** D-182 §7.1 (inc 5b.2) — record the owner's Access-tier pick + re-render.
   *  Validates the tier is one the open pack actually offers (the radio only
   *  renders offered tiers, so this guards the programmatic / test path). */
  const setGrantAccessInternal = (tier: InstallAccessTier): void => {
    if (dialogOpenFor === null) return;
    if (installing) return;
    const pack = findPackBySlug(dialogOpenFor);
    if (!pack) return;
    const model = grantModelFor(pack);
    if (model === null) return; // no grantable op/tool → no picker
    if (!model.accessOptions.includes(tier)) return; // tier not offered here
    dialogGrantAccess.set(dialogOpenFor, tier);
    render();
  };

  const grantAudienceFor = (slug: string): InstallAudienceSelection =>
    resolveInstallDialogAudience(dialogGrantAudience.get(slug) ?? updateStartAudience(slug));

  /** D-310 — pick an Access tier for one pack the open dialog's install brings
   *  in. Only a pack the list offers a choice for, and only a tier it offers. */
  const setDependencyAccessInternal = (packSlug: string, tier: InstallAccessTier): void => {
    if (dialogOpenFor === null || installing) return;
    const pack = findPackBySlug(dialogOpenFor);
    if (pack === undefined || pack.manifest === undefined) return;
    const target = dependencyPacksToChoose(installPreviewFor(pack.slug, pack.manifest))
      .find((dependency) => dependency.pack_slug === packSlug);
    if (target === undefined || !target.access_options.includes(tier)) return;
    const picks = dialogDependencyAccess.get(dialogOpenFor) ?? new Map<string, InstallAccessTier>();
    picks.set(packSlug, tier);
    dialogDependencyAccess.set(dialogOpenFor, picks);
    render();
  };

  /** D-310 — what the install sends for the packs it brings in: each one the list
   *  offers a choice for, at the owner's pick (else Read only), shared with the
   *  people this pack is. `undefined` when the preview listed none, which is also
   *  what a server that predates D-310 produces: it would ignore the field. */
  const dependencyInstallScopesFor = (
    pack: PackListEntry,
  ): PackDependencyInstallScope[] | undefined => {
    if (pack.manifest === undefined) return undefined;
    const choose = dependencyPacksToChoose(installPreviewFor(pack.slug, pack.manifest));
    if (choose.length === 0) return undefined;
    const picks = dialogDependencyAccess.get(pack.slug);
    return choose.map((dependency) => ({
      pack_slug: dependency.pack_slug,
      install_scope: {
        access: resolveDependencyAccess(picks?.get(dependency.pack_slug), dependency),
        audience: grantAudienceFor(pack.slug),
      },
    }));
  };

  /** ⛔ D-294 — AN UPDATE STARTS AT WHO MAY USE THE PACK NOW (`current_audience`),
   *  never the fresh-install "only you". An update REPLACES the pack's share, so
   *  starting at "only you" withdrew it from every customer and agreement it had
   *  the moment the owner pressed Update. */
  const updateStartAudience = (slug: string): InstallAudienceSelection | undefined => {
    const pack = findPackBySlug(slug);
    if (pack === undefined) return undefined;
    if (pack.installed_any_version !== true || pack.installed) return undefined;
    return pack.current_audience;
  };

  /** The customers an update's carried-over audience names one by one — shown
   *  under "All customers" so they can be seen and unticked (a customer is
   *  otherwise chosen only through its package). Known customers ONLY: an
   *  agreement already appears under "Choose particular agreements", and an id
   *  neither list knows is never guessed into one. */
  const carriedCustomerOptions = (slug: string): InstallAudienceOption[] =>
    (updateStartAudience(slug)?.contract_ids ?? []).flatMap((id) => {
      const label = customerLabelByContract.get(id);
      return label === undefined ? [] : [{ id, label }];
    });

  /** D-196 R6 — record the complete independent checklist + re-render. */
  const setGrantAudienceInternal = (audience: InstallAudienceSelection): void => {
    if (dialogOpenFor === null) return;
    if (installing) return;
    const pack = findPackBySlug(dialogOpenFor);
    if (!pack) return;
    if (grantModelFor(pack) === null) return;
    dialogGrantAudience.set(
      dialogOpenFor,
      resolveInstallAudienceSelection(audience),
    );
    render();
  };

  const setGrantScopeInternal = (scope: InstallScopeWho): void => {
    setGrantAudienceInternal(installAudienceFromLegacyScope(scope));
  };

  /** D-194 2b-2 / D-192 — the (single, v1) connection this pack needs. Read from
   *  the pack's OWN manifest (`connection_requirements[]`, forwarded on the list
   *  entry), so a pack that declares one — e.g. Dynamics — is recognized with no
   *  code edit; falls back to the interim compile-time seed
   *  (`getSeededConnectionRequirements`, still the home for onedrive until the
   *  D-166 seed→manifest migration). undefined ⇒ the pack declares none → the
   *  dialog renders no Connect section. */
  const dialogConnectionRequirement = (
    slug: string,
  ): ConnectionRequirement | undefined => {
    // The manifest is authoritative WHEN THE FIELD IS PRESENT — even an explicit
    // `[]` means "this pack declares no connection" (→ no Connect section), NOT
    // "fall through to the seed". Only a MISSING field (a not-yet-migrated pack
    // like onedrive) defers to the interim compile-time seed.
    // Projected on the row (see PackListEntry); reaching through `manifest`
    // for a scalar is what kept the 36 KB field on every list entry.
    const manifestReqs = findPackBySlug(slug)?.connection_requirements;
    return manifestReqs !== undefined
      ? manifestReqs[0]
      : getSeededConnectionRequirements(slug)[0];
  };

  /** D-194 2b-2 — the existing api connections whose endpoint matches the
   *  requirement (`findEndpointCandidates`, step 2a), read from the readiness
   *  controller's cached list (null before it loads → empty). Recomputed per
   *  render so a reuse candidate appears the moment the connection list resolves. */
  const dialogConnectionCandidates = (
    requirement: ConnectionRequirement | undefined,
  ): EndpointCandidate[] =>
    requirement === undefined
      ? []
      : findEndpointCandidates(requirement, connectionsReadiness.connections() ?? []);

  /** D-194 2b-2 — the connection the install will bind to. Shared by the render
   *  (the picker's `chosen`) + submit (the rpc's `chosen_connection`) so the two
   *  can never disagree — including when the async candidate list drops an
   *  explicitly-picked connection after the pick (`resolveChosenConnection`
   *  re-validates against the CURRENT candidates + falls back to the default). */
  const effectiveChosenConnection = (
    slug: string,
    candidates: readonly EndpointCandidate[],
  ): string | undefined =>
    resolveChosenConnection(
      { touched: dialogChosenConnection.has(slug), pick: dialogChosenConnection.get(slug) },
      candidates,
      updateStartConnection(slug),
    );

  /** ⛔ D-294 — AN UPDATE STARTS AT THE ACCOUNT THE PACK USES NOW
   *  (`current_connection`), not the first matching one by name: an update
   *  re-binds, so an owner with two accounts of one vendor was silently moved. */
  const updateStartConnection = (slug: string): string | undefined => {
    const pack = findPackBySlug(slug);
    if (pack === undefined) return undefined;
    if (pack.installed_any_version !== true || pack.installed) return undefined;
    return pack.current_connection;
  };

  /** D-194 2b-2 — record the owner's connection pick (a name, or undefined =
   *  "don't connect now") + re-render. */
  const pickConnectionInternal = (name: string | undefined): void => {
    if (dialogOpenFor === null) return;
    if (installing) return;
    dialogChosenConnection.set(dialogOpenFor, name);
    render();
  };

  /** D-194 2b-2 — toggle the Connect section's collapsed/expanded reuse list. */
  const toggleConnectExpandedInternal = (): void => {
    if (dialogOpenFor === null) return;
    if (installing) return;
    if (dialogConnectExpanded.has(dialogOpenFor)) {
      dialogConnectExpanded.delete(dialogOpenFor);
    } else {
      dialogConnectExpanded.add(dialogOpenFor);
    }
    render();
  };

  /** D-295 — the webhooks the open install needs chosen, from the install
   *  preview, each with the pick it will send: the owner's own (while it still
   *  fits), else the one in use now (an update keeps it), else the only one
   *  that fits. `undefined` when the preview named none, could not say, or has
   *  not answered. */
  const webhookChoicesFor = (
    pack: PackListEntry & { manifest: BulkPackManifest },
  ): InstallWebhookChoice[] | undefined => {
    const plan = installPreviewFor(pack.slug, pack.manifest)?.webhook_plan;
    if (plan === undefined || plan.length === 0) return undefined;
    const picks = dialogWebhookPicks.get(pack.slug);
    return plan.map((entry) => {
      const key = `${entry.pack_slug}\u0000${entry.binding}`;
      const fits = (id: string | undefined): id is string =>
        id !== undefined && entry.candidates.some((candidate) => candidate.ingress_id === id);
      const own = picks?.get(key);
      const pick = fits(own)
        ? own
        : entry.current?.fits === true && fits(entry.current.ingress_id)
          ? entry.current.ingress_id
          : entry.candidates.length === 1
            ? entry.candidates[0]!.ingress_id
            : undefined;
      return { key, entry, pick };
    });
  };

  /** D-295 — the pack declares webhooks and the preview has not answered: the
   *  dialog says so and holds Install, rather than let it be refused. */
  const webhooksLoadingFor = (pack: PackListEntry & { manifest: BulkPackManifest }): boolean =>
    (pack.manifest.webhook_requirements?.length ?? 0) > 0
    && opts.runInstallPreview !== undefined
    && installPreviewFor(pack.slug, pack.manifest) === undefined;

  /** D-305 — the pack brings other packs in with it and the preview has not said
   *  what they need: the dialog holds Install, since the install would refuse. */
  const dependenciesLoadingFor = (pack: PackListEntry & { manifest: BulkPackManifest }): boolean =>
    (pack.manifest.dependencies?.length ?? 0) > 0
    && opts.runInstallPreview !== undefined
    && installPreviewFor(pack.slug, pack.manifest) === undefined;

  /** D-315 §5.2 — the templates the open install's recipes bring, from the
   *  preview, each with which stays on where it meets one already on: the
   *  owner's choice, else the recipe's (the one its author tested). */
  const mailTemplateChoicesFor = (
    pack: PackListEntry & { manifest: BulkPackManifest },
  ): InstallMailTemplateChoice[] | undefined => {
    const entries = installPreviewFor(pack.slug, pack.manifest)?.mail_templates;
    if (entries === undefined || entries.length === 0) return undefined;
    const keeps = dialogMailTemplateKeep.get(pack.slug);
    return entries.map((entry) => {
      const key = `${entry.recipe_id}\u0000${entry.variable}`;
      return { key, entry, keep: keeps?.get(key) ?? 'recipe' };
    });
  };

  const pickMailTemplateInternal = (key: string, keep: 'recipe' | 'existing'): void => {
    if (dialogOpenFor === null || installing) return;
    const keeps = dialogMailTemplateKeep.get(dialogOpenFor) ?? new Map<string, 'recipe' | 'existing'>();
    keeps.set(key, keep);
    dialogMailTemplateKeep.set(dialogOpenFor, keeps);
    render();
  };

  const pickWebhookInternal = (key: string, ingressId: string): void => {
    if (dialogOpenFor === null || installing) return;
    const picks = dialogWebhookPicks.get(dialogOpenFor) ?? new Map<string, string>();
    picks.set(key, ingressId);
    dialogWebhookPicks.set(dialogOpenFor, picks);
    render();
  };

  const submitInstall = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (dialogOpenFor === null) return Promise.resolve();
    if (installing) {
      return pendingInstallPromise ?? Promise.resolve();
    }
    // Codex MAJOR 1 fold (defensive belt-and-suspenders) — refuse to
    // fire while a Delete operation is staged on any row. `openDialog`
    // already collapses any open Delete strip, so this guard catches
    // only the pathological test-seam case where Confirm install is
    // driven against a `dialogOpenFor` that survived a stale Delete
    // state. Single-rpc-at-a-time per DD#10.
    if (confirmingDeleteFor !== null || deleting) return Promise.resolve();
    // Snapshot the slug at submit-time so the inner async block can
    // reference it without a TypeScript non-null assertion against the
    // mutable outer `dialogOpenFor`. The outer reference can flip to
    // `null` on the success path inside the same async block; without
    // the snapshot the map delete would race the assignment.
    const submittingSlug = dialogOpenFor;
    const target = findPackBySlug(submittingSlug);
    if (!target) return Promise.resolve();
    // Add-a-pack: a RESOLVED (added) pack installs BY SLUG (its recipes aren't
    // bundled — only `installBySlug` injects the marketplace resolver); a loaded
    // (bundled / discover) pack installs BY VALUE. The capability gate follows the
    // path so a host wiring only Add (runInstallBySlug, no runInstall) still works.
    const isAdded =
      pendingAddEntry !== null && pendingAddEntry.slug === submittingSlug;
    if (isAdded) {
      if (opts.runInstallBySlug === undefined) return Promise.resolve();
    } else if (!canInstall) {
      return Promise.resolve();
    }
    const selection = dialogPermissions.get(submittingSlug);
    const granted = selection ? [...selection] : [];
    // D-182 §7.1 / D-196 — send Access plus the independent Audience checklist
    // for every pack with grantable composition ops or recipe tools.
    const grantModel = grantModelFor(target);
    const installScope: InstallGrantSelection | undefined =
      grantModel !== null
        ? {
            access: grantAccessFor(submittingSlug, grantModel),
            audience: grantAudienceFor(submittingSlug),
          }
        : undefined;
    // D-194 2b-2 — the owner's Connect pick (explicit, else the pre-selected
    // default). Undefined ⇒ the pack declares no connection OR the owner chose not
    // to connect → omit `chosen_connection` so the install keeps the authored
    // literal (connect is optional). Same resolver the render uses, so the rpc
    // binds exactly the connection the dialog showed.
    const chosenConnection = effectiveChosenConnection(
      submittingSlug,
      dialogConnectionCandidates(dialogConnectionRequirement(submittingSlug)),
    );
    // D-295 — one webhook per binding the preview named. A choice still open
    // holds the install (the server would refuse it anyway).
    const webhookChoices = target.manifest !== undefined
      ? webhookChoicesFor(target as PackListEntry & { manifest: BulkPackManifest })
      : undefined;
    if (webhookChoices?.some((choice) => choice.pick === undefined)
      || (target.manifest !== undefined
        && webhooksLoadingFor(target as PackListEntry & { manifest: BulkPackManifest }))
      || (target.manifest !== undefined
        && dependenciesLoadingFor(target as PackListEntry & { manifest: BulkPackManifest }))
      // A pack it needs and does not bring in: the install would refuse, and the
      // dialog says which (the button is held there too).
      || missingPacksToInstallFirst(installPreviewFor(submittingSlug, target.manifest)).length > 0
      // D-311 § 5 — nor what the install would refuse before writing anything.
      || installRefusalFromPreview(installPreviewFor(submittingSlug, target.manifest)) !== null) {
      return Promise.resolve();
    }
    const webhookBindings = webhookChoices?.map((choice) => ({
      pack_slug: choice.entry.pack_slug,
      binding: choice.entry.binding,
      ingress_id: choice.pick!,
    }));
    const dependencyScopes = dependencyInstallScopesFor(target);
    // D-315 §5.2 — the owner's answer for each template that meets one already on.
    const mailTemplateChoices = (target.manifest !== undefined
      ? mailTemplateChoicesFor(target as PackListEntry & { manifest: BulkPackManifest }) ?? []
      : [])
      .filter((choice) => choice.entry.twin !== undefined)
      .map((choice) => ({ recipe_id: choice.entry.recipe_id, variable: choice.entry.variable, keep: choice.keep }));
    installing = true;
    dialogError = null;
    pendingInstallDialogFocus = { kind: 'submit', slug: submittingSlug };
    // Slice K — a new action invalidates the previous action's notice
    // (DD#15: the notice describes the LAST COMPLETED action).
    disclosure = null;
    render();
    const promise = (async () => {
      try {
        // Route by path: added pack → installBySlug(slug); loaded pack →
        // install(manifest). Both share the grant handling + result shape.
        const response = isAdded
          ? await (opts.runInstallBySlug as PacksInstallBySlugCaller)({
              slug: target.slug,
              granted_permissions: granted,
              ...(pendingAddManifestHash !== null
                ? { expected_manifest_hash: pendingAddManifestHash }
                : {}),
              ...(installScope !== undefined ? { install_scope: installScope } : {}),
              ...(chosenConnection !== undefined
                ? { chosen_connection: chosenConnection }
                : {}),
              ...(webhookBindings !== undefined ? { webhook_bindings: webhookBindings } : {}),
              ...(dependencyScopes !== undefined ? { dependency_install_scopes: dependencyScopes } : {}),
              ...(mailTemplateChoices.length > 0 ? { mail_template_choices: mailTemplateChoices } : {}),
            })
          : await (opts.runInstall as PacksInstallCaller)({
              manifest: target.manifest,
              granted_permissions: granted,
              ...(target.manifest_review_hash !== undefined
                ? { expected_manifest_hash: target.manifest_review_hash }
                : {}),
              ...(installScope !== undefined ? { install_scope: installScope } : {}),
              ...(chosenConnection !== undefined
                ? { chosen_connection: chosenConnection }
                : {}),
              ...(webhookBindings !== undefined ? { webhook_bindings: webhookBindings } : {}),
              ...(dependencyScopes !== undefined ? { dependency_install_scopes: dependencyScopes } : {}),
              ...(mailTemplateChoices.length > 0 ? { mail_template_choices: mailTemplateChoices } : {}),
            });
        if (disposed) return;
        if (!response.result.ok) {
          const failureCode = response.result.failure?.code;
          const failureDetail = response.result.failure?.message;
          if (isAdded && failureCode === 'review_stale') {
            // The server fetched a different marketplace artifact than the one
            // this consent dialog rendered. Discard every value derived from
            // that preview and return to the detail retry state; reopening the
            // same in-memory dialog would only resubmit the stale hash forever.
            dialogPermissions.delete(submittingSlug);
            clearDialogGrantPicks(submittingSlug);
            pendingAddEntry = null;
            pendingAddManifestHash = null;
            dialogOpenFor = null;
            dialogError = null;
            detailResolveError = {
              slug: submittingSlug,
              message: installFailureCopy(failureCode, failureDetail),
            };
            return;
          }
          // Engine-side `ok: false` outcome — surface the failure code via
          // the dialog module's exhaustive copy map (unknown / missing
          // codes fall back defensively there — Codex MINOR 4 fold). The
          // dialog stays open so the user can adjust permissions + retry,
          // or cancel.
          dialogError = {
            text: installFailureCopy(failureCode, failureDetail),
            missingPacks: missingPacksFromFailure(response.result.failure),
          };
          return;
        }
        // Successful install — close the dialog + refresh the list so
        // the just-installed pack flips its `installed` badge. Use
        // `submittingSlug` instead of `dialogOpenFor!` so the cleanup
        // doesn't depend on the mutable outer reference still pointing
        // at the right pack.
        dialogPermissions.delete(submittingSlug);
        // D-182 §7.1/§7.2 — release BOTH grant-picker picks on success too
        // (parallel to the permission-set cleanup), so a reinstall of the same
        // slug starts at the defaults rather than the prior picks.
        clearDialogGrantPicks(submittingSlug);
        dialogOpenFor = null;
        dialogError = null;
        // KEEP the resolved marketplace entry after install — a marketplace pack
        // never lands in `packs[]`, so it's the detail's only manifest source;
        // its `installed` re-derives from `rosterInstalledSet` (→ flips to
        // Uninstall) without paying a re-resolve. Cleared on navigation.
        // Slice K — stage the born-blocked/-degraded disclosure (4c.2)
        // BEFORE awaiting the refresh so the post-refresh ready render
        // paints it. Empty blocks ⇒ null (zero-noise on ordinary
        // installs; also clears a stale prior notice — DD#15).
        const installBlocks = installDisclosureBlocks(response.result);
        disclosure =
          installBlocks.length > 0
            ? {
                action: 'installed',
                pack_slug: target.slug,
                pack_name: target.name,
                blocks: installBlocks,
              }
            : null;
        await refreshRows({ refreshRecipes: true });
      } catch (err) {
        if (disposed) return;
        dialogError = { text: humanizeRpcError(err), missingPacks: [] };
      } finally {
        installing = false;
        pendingInstallPromise = null;
        if (!disposed) render();
      }
    })();
    pendingInstallPromise = promise;
    return promise;
  };

  // ── Slice B — Delete transitions ─────────────────────────────────

  const openDeleteConfirm = (slug: string): void => {
    if (!canDelete) return;
    if (state !== 'ready') return;
    // Disallow opening a Delete strip while ANY install / uninstall
    // rpc is in flight (DD#10). The single-rpc-at-a-time invariant
    // keeps the post-rpc refresh deterministic.
    if (installing || deleting) return;
    // Pending-first lookup so a detail-only resolved marketplace pack (installed,
    // present only in `installed_versions` — never in `packs[]`) is uninstallable
    // from its detail. `findPackBySlug` re-derives `installed` from the roster set.
    const target = findPackBySlug(slug);
    if (!target) return;
    // Only installed packs are uninstallable. Defensive: the renderer
    // hides the Delete button on non-installed rows, but a programmatic
    // test caller could drive clickDelete on an installed pack that
    // just got refreshed away.
    if (!target.installed) return;
    // Delta 6 (R22.1) — foundation packs expose Delete DIRECTLY; the
    // confirm strip carries the boot-time-undo warning ("auto-installs
    // at server boot") so the user reads the futility before Confirm.
    // The prior "Show advanced" reveal toggle (Slice E) only ever
    // gated this one affordance and was deleted as vestigial.
    // Single-row Delete confirm (DD#9). Opening B's strip collapses A's
    // strip in the same render pass — same shape as the install dialog
    // (DD#2) + SI Slice 1.5 + devices-page-mount DD#2.
    if (confirmingDeleteFor !== null && confirmingDeleteFor !== slug) {
      // Collapsing A — clear any stale error on A so a re-open later
      // starts clean. The new error chip belongs to B.
      deleteError = null;
    }
    // Codex MAJOR 1 fold — single-mode-at-a-time across affordances.
    // Opening a Delete strip collapses ANY open install dialog
    // (regardless of slug). The same-slug case is logically
    // unreachable in steady state (an installed pack has no install
    // affordance), but a refresh-during-dialog race can transiently
    // leave a stale dialog open; the cross-slug case is the real one
    // — without this gate, a user could open an install dialog on
    // pack B, then open a Delete strip on pack A, ending up with
    // BOTH surfaces armed simultaneously + the single-rpc-at-a-time
    // invariant (DD#10) at risk.
    if (dialogOpenFor !== null) {
      dialogPermissions.delete(dialogOpenFor);
      clearDialogGrantPicks(dialogOpenFor); // D-194 2b-2 — clear grant + Connect picks in lockstep
      dialogOpenFor = null;
      dialogError = null;
      pendingInstallPromise = null;
    }
    confirmingDeleteFor = slug;
    deleteError = null;
    deleteRemoves = null;
    pendingUninstallPromise = null;
    pendingDeleteActionFocus = { kind: 'confirm', slug };
    pendingInstallDialogFocus = null;
    render();
    // D-304 — say what goes with the pack's recipes, once the server has counted.
    const preview = opts.runUninstallPreview;
    if (preview !== undefined) {
      void preview({ pack_slug: slug }).then((removes) => {
        if (disposed || confirmingDeleteFor !== slug) return;
        const text = deleteRemovesText(removes);
        if (text === null) return;
        deleteRemoves = { slug, text };
        render();
      }, () => { /* a server predating D-304: no line */ });
    }
  };

  const cancelDeleteConfirm = (slug: string): void => {
    // Mid-rpc Cancel is a no-op — the renderer disables the Cancel
    // button during the rpc, but the test seam can still drive a click
    // (matches the SI Slice 1.5 pattern).
    if (deleting) return;
    if (confirmingDeleteFor !== slug) return;
    confirmingDeleteFor = null;
    deleteError = null;
    pendingUninstallPromise = null;
    pendingDeleteActionFocus = { kind: 'delete', slug };
    render();
  };

  const submitUninstall = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (!canDelete) return Promise.resolve();
    if (confirmingDeleteFor === null) return Promise.resolve();
    if (deleting) {
      return pendingUninstallPromise ?? Promise.resolve();
    }
    // Codex MAJOR 1 fold (defensive belt-and-suspenders) — refuse to
    // fire while an install dialog is open or an install rpc is in
    // flight. `openDeleteConfirm` already collapses any open install
    // dialog before arming the strip, so this guard catches only the
    // pathological test-seam case where Confirm delete is driven
    // against a `confirmingDeleteFor` that survived a stale dialog
    // state. Single-rpc-at-a-time per DD#10.
    if (dialogOpenFor !== null || installing) return Promise.resolve();
    // Snapshot the slug so the inner async block can reference it
    // after the success path nulls the outer reference (same pattern
    // as submitInstall's `submittingSlug`).
    const slug = confirmingDeleteFor;
    // Pending-first lookup so a detail-only marketplace pack (present only in
    // `installed_versions`, never in `packs[]`) uninstalls too — the rpc only
    // needs `pack_slug`, so `target` is just for the name / disclosure.
    const target = findPackBySlug(slug);
    if (!target) return Promise.resolve();
    deleting = true;
    deleteError = null;
    pendingDeleteActionFocus = { kind: 'confirm', slug };
    // Slice K — a new action invalidates the previous action's notice
    // (DD#15).
    disclosure = null;
    render();
    const rpc = opts.runUninstall as PacksUninstallCaller;
    const promise = (async () => {
      try {
        const response = await rpc({ pack_slug: slug });
        if (disposed) return;
        if (!response.result.ok) {
          // Engine-side `ok: false` outcome — surface the failure code
          // via the exhaustive copy map. Strip stays open so the user
          // can Cancel or retry. Same defensive unknown-code fallback
          // as the install path (server version skew).
          const code = response.result.failure?.code;
          if (code !== undefined) {
            const known =
              UNINSTALL_FAILURE_COPY[
                code as keyof typeof UNINSTALL_FAILURE_COPY
              ];
            deleteError =
              known !== undefined
                ? known
                : `Recued did not remove it: ${code}.`;
          } else {
            deleteError = 'Recued did not remove it, and does not know why.';
          }
          return;
        }
        // Successful uninstall — close the strip + refresh the list
        // so the just-uninstalled pack flips its `installed` badge back
        // off. DD#12 mirrors the install path's DD#8 refresh.
        confirmingDeleteFor = null;
        deleteError = null;
        // Slice K — stage the "disables N recipes" disclosure (4c.3)
        // BEFORE awaiting the refresh, same shape as the install path.
        const uninstallBlocks = uninstallDisclosureBlocks(response.result);
        disclosure =
          uninstallBlocks.length > 0
            ? {
                action: 'uninstalled',
                pack_slug: slug,
                pack_name: target.name,
                blocks: uninstallBlocks,
              }
            : null;
        await refreshRows({ refreshRecipes: true });
      } catch (err) {
        if (disposed) return;
        deleteError = humanizeRpcError(err);
      } finally {
        deleting = false;
        pendingUninstallPromise = null;
        if (!disposed) render();
      }
    })();
    pendingUninstallPromise = promise;
    return promise;
  };

  // ── Render ───────────────────────────────────────────────────────

  const clearChildren = (): void => {
    while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
  };

  /** Local DOM badge builder. Mirrors the SI panel's `makeBadge`: the
   *  ui-shared `badge()` returns HTML; the fake-DOM test harness reads
   *  `createElement` output. Same `rx-badge-${tone}` class shape so the
   *  shared STATUS_STYLES paint the chips identically. */
  const makeBadge = (label: string, tone: BadgeTone): HTMLSpanElement => {
    const span = doc.createElement('span');
    span.className = `rx-badge rx-badge-${tone}`;
    span.textContent = label;
    return span;
  };

  const renderLoading = (): void => {
    const status = doc.createElement('p');
    status.className = 'packs-status';
    status.setAttribute('role', 'status');
    status.textContent = COPY.loading;
    wrapper.appendChild(status);
  };

  const renderError = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'packs-title packs-title-error';
    heading.textContent = COPY.error_heading;

    const detail = doc.createElement('p');
    detail.className = 'packs-error';
    detail.setAttribute(PACKS_LIST_ERROR_ATTR, '');
    detail.setAttribute('role', 'alert');
    detail.textContent = listError ?? 'Unknown error.';

    const actions = doc.createElement('div');
    actions.className = 'packs-actions';
    const retry = doc.createElement('button');
    retry.type = 'button';
    retry.setAttribute(PACKS_RETRY_BTN_ATTR, '');
    retry.className = 'rx-btn rx-btn-secondary rx-btn-sm';
    retry.textContent = listRetrying ? COPY.retrying_label : COPY.retry_label;
    if (listRetrying) {
      retry.setAttribute('aria-disabled', 'true');
      retry.setAttribute('aria-busy', 'true');
    }
    retry.addEventListener('click', () => {
      if (listRetrying) return;
      listRetrying = true;
      render();
      void refreshRows({ preserveErrorSurface: true }).finally(() => {
        listRetrying = false;
        if (!disposed) render();
      });
    });
    actions.appendChild(retry);

    wrapper.appendChild(heading);
    wrapper.appendChild(detail);
    wrapper.appendChild(actions);
  };

  // R2 — thin adapter over the extracted render: the panel supplies its
  // state snapshot + transition callbacks; `packs-install-dialog.ts` owns
  // the DOM shape. State reads stay one-directional (props in, callbacks
  // out) so the panel remains the dialog state's single writer.
  const renderDialog = (
    // ⛔ RESOLVED pack — it must carry a manifest. `packs.list` forwards one only
    // for installed packs, so the dialog for a Discover row renders from the
    // entry `ensureDetailResolved` produced. The caller proves it, because the
    // consent surface cannot honestly render without it.
    pack: PackListEntry & { manifest: BulkPackManifest },
    collision: PackRecipeCollision | undefined,
    grantOverlap: PackGrantOverlap | undefined,
  ): HTMLElement => {
    // D-194 2b-2 — resolve the pack's connection requirement + its endpoint-match
    // candidates once, then derive the effective pick (explicit choice, else the
    // pre-selected default). All three feed the dialog's Connect section.
    const connectionRequirement = dialogConnectionRequirement(pack.slug);
    const connectionCandidates = dialogConnectionCandidates(connectionRequirement);
    // D-223 — a pack that declares hints but no descriptor still needs a way in.
    // Only consulted when there is no requirement: a descriptor already provides
    // the Connect section, and a hint must never add adoption to it.
    const connectionHintSetup = connectionHintSetupSlug(
      findPackBySlug(pack.slug)?.connection_hints,
      connectionRequirement !== undefined,
    );
    // D-247 D15 — resolve the recipe disclosure for THIS manifest. Idempotent;
    // re-renders when it lands. Fired here rather than in `openDialog` because
    // the manifest can still be in flight at open time (`ensureDetailResolved`
    // backfills it), and the preview is a function of the manifest, not of the
    // open event.
    ensureInstallPreview(pack.slug, pack.manifest);
    const installPreview = installPreviewFor(pack.slug, pack.manifest);
    return renderPacksInstallDialog({
      document: doc,
      pack,
      ...(installPreview !== undefined ? { installPreview } : {}),
      ...(dependenciesLoadingFor(pack) ? { permissionsLoading: true } : {}),
      ...(dialogDependencyAccess.has(pack.slug)
        ? { dependencyAccessPicks: dialogDependencyAccess.get(pack.slug)! }
        : {}),
      onPickDependencyAccess: (packSlug, tier) => setDependencyAccessInternal(packSlug, tier),
      collision,
      grantOverlap,
      selection: dialogPermissions.get(pack.slug) ?? new Set<string>(),
      accessPick: dialogGrantAccess.get(pack.slug) ?? updateStartAccess(pack.slug, grantModelFor(pack)),
      audiencePick: dialogGrantAudience.get(pack.slug) ?? updateStartAudience(pack.slug),
      customerTierOptions,
      contractOptions: contractAudienceOptions,
      customerContractOptions: carriedCustomerOptions(pack.slug),
      connectionRequirement,
      connectionCandidates,
      connectionHintSetup,
      chosenConnection: effectiveChosenConnection(pack.slug, connectionCandidates),
      connectExpanded: dialogConnectExpanded.has(pack.slug),
      installing,
      deleting,
      error: dialogError?.text ?? null,
      ...(dialogError !== null && dialogError.missingPacks.length > 0
        ? { errorMissingPacks: dialogError.missingPacks }
        : {}),
      onTogglePermission: (permission) => {
        togglePermissionInternal(permission);
      },
      onPickAccess: (tier) => setGrantAccessInternal(tier),
      onPickAudience: (audience) => setGrantAudienceInternal(audience),
      onPickConnection: (name) => pickConnectionInternal(name),
      onToggleConnectExpanded: () => toggleConnectExpandedInternal(),
      ...((): { webhookChoices?: InstallWebhookChoice[]; webhooksLoading?: boolean } => {
        const choices = webhookChoicesFor(pack);
        return {
          ...(choices !== undefined ? { webhookChoices: choices } : {}),
          ...(webhooksLoadingFor(pack) ? { webhooksLoading: true } : {}),
        };
      })(),
      onPickWebhook: (key, ingressId) => pickWebhookInternal(key, ingressId),
      ...((): { mailTemplates?: InstallMailTemplateChoice[] } => {
        const choices = mailTemplateChoicesFor(pack);
        return choices !== undefined ? { mailTemplates: choices } : {};
      })(),
      onPickMailTemplate: (key, keep) => pickMailTemplateInternal(key, keep),
      ...((): { mailFactSources?: InstallPreview['mail_fact_sources'] } => {
        const sources = installPreviewFor(pack.slug, pack.manifest)?.mail_fact_sources;
        return sources !== undefined && sources.length > 0 ? { mailFactSources: sources } : {};
      })(),
      onSubmit: () => {
        void submitInstall();
      },
      onCancel: () => closeDialog(),
    });
  };

  /** Slice C — the cross-pack recipe-collision notice ("⚠ Shares N recipes
   *  with pack-x"). Plain `<p>` (not a Badge primitive) because the message
   *  reads as a sentence + carries an inline list of other pack slugs. R22.1
   *  moved it OFF the list row into the detail's ABOUT section — the install
   *  DIALOG keeps its own collision callout, so the consent surface is
   *  unchanged. Returns null when the pack overlaps nothing. */
  const renderCollisionNotice = (
    collision: PackRecipeCollision | undefined,
  ): HTMLElement | null => {
    if (collision === undefined || collision.recipes.length === 0) return null;
    const collisionP = doc.createElement('p');
    collisionP.setAttribute(PACKS_ROW_COLLISION_ATTR, '');
    collisionP.className = 'packs-row-collision';
    const count = collision.recipes.length;
    const suffix =
      count === 1
        ? COPY.row_collision_recipes_singular
        : COPY.row_collision_recipes_plural;
    collisionP.textContent =
      `${COPY.row_collision_prefix}${count}${suffix}`
      + collision.otherPackSlugs.join(', ');
    return collisionP;
  };

  /** The Install / Delete affordances + the delete-flow disclosures that
   *  must stay glued to the confirm strip wherever it renders (the
   *  foundation boot-undo warning · the Slice G body-grant release list ·
   *  the Slice J grant-overlap notice). Shared by the LIST row and the
   *  detail's IDENTITY section (R22.1) so the two surfaces cannot drift. */
  const appendPackActions = (
    item: HTMLElement,
    pack: PackListEntry,
    grantOverlap: PackGrantOverlap | undefined,
  ): void => {
    // ── Install OR Delete affordance ───────────────────────────────
    // Install surfaces on non-installed packs (Slice A); Delete surfaces
    // on installed packs (Slice B) — INCLUDING foundation packs since
    // Delta 6 deleted the "Show advanced" reveal toggle: the confirm
    // strip's boot-undo warning is the disclosure now. A pack is in
    // exactly one state at a time (`installed` is a derived boolean), so
    // the two affordances never collide on the same row. The footer
    // paints even when only one of the two callers is wired, because
    // either one alone is a legitimate read-only-ish surface (read +
    // install, or read + delete).
    // A resolved marketplace pack (pending entry, absent from `packs[]`) installs
    // via the by-slug path, so its Install affordance gates on `canAdd`, not
    // `canInstall` (a host may wire only the by-slug seam).
    const isAddedPack = pendingAddEntry?.slug === pack.slug;
    const showInstall = (isAddedPack ? canAdd : canInstall) && !pack.installed;
    const showDelete = canDelete && pack.installed;
    // Foundation Delete warning. Renders above the footer when the
    // confirm strip is armed on a foundation pack so the user reads
    // the boot-time-undo disclosure before the Confirm button — since
    // Delta 6 this warning IS the foundation-delete safeguard (it
    // replaced the "Show advanced" reveal toggle). `role='alert'`
    // cues screen readers when the warning enters the DOM.
    const showFoundationWarning =
      showDelete
      && pack.pre_install
      && confirmingDeleteFor === pack.slug;
    if (showFoundationWarning) {
      const warn = doc.createElement('p');
      warn.setAttribute(PACKS_ROW_DELETE_FOUNDATION_WARN_ATTR, '');
      warn.setAttribute('role', 'alert');
      warn.className = 'packs-row-delete-foundation-warn';
      warn.textContent = COPY.foundation_delete_warning;
      item.appendChild(warn);
    }
    // Slice G — symmetric body-grant disclosure on the Delete confirm
    // strip. Mirrors the install dialog's DD#4 callout: install shows
    // what body access the user is GRANTING, delete shows what body
    // access the user is RELEASING. Renders only when (a) the Delete
    // affordance is wired + visible for this row (`showDelete`), (b)
    // the manifest's grants array is non-empty, and (c) the row's
    // confirm strip is currently armed. Reading the array length
    // directly (rather than `body_visibility_grant_count`) closes
    // codex's Angle-2 MINOR: if the server ever produces an
    // inconsistent state where `count > 0` but the array is absent
    // or empty (e.g., a future field drift between manifest +
    // PackListEntry derivation), the install dialog's count-based
    // gate would render an empty heading; this surface gates on the
    // actual content so the heading + list always appear together.
    // D-304 — what goes with the pack's recipes: their schedules, automations and
    // saved settings. Only once the server has counted, and only when something does.
    if (showDelete && confirmingDeleteFor === pack.slug && deleteRemoves?.slug === pack.slug) {
      const removes = doc.createElement('p');
      removes.className = 'packs-row-delete-removes';
      removes.setAttribute(PACKS_ROW_DELETE_REMOVES_ATTR, pack.slug);
      // It arrives after the confirmation opened, so a screen reader is told.
      removes.setAttribute('role', 'status');
      removes.textContent = deleteRemoves.text;
      item.appendChild(removes);
    }
    const grants = pack.body_visibility_grant_keys;
    const showDeleteBodyGrants =
      showDelete && grants.length > 0 && confirmingDeleteFor === pack.slug;
    if (showDeleteBodyGrants) {
      const grantsHeading = doc.createElement('p');
      grantsHeading.className = 'packs-row-delete-body-heading';
      grantsHeading.textContent = COPY.delete_body_grants_label;
      item.appendChild(grantsHeading);
      const grantsList = doc.createElement('ul');
      grantsList.setAttribute(PACKS_ROW_DELETE_BODY_GRANT_LIST_ATTR, '');
      grantsList.className = 'packs-row-delete-body-list';
      for (const key of grants) {
        const li = doc.createElement('li');
        li.setAttribute(PACKS_ROW_DELETE_BODY_GRANT_ATTR, key);
        li.textContent = key;
        grantsList.appendChild(li);
      }
      item.appendChild(grantsList);
    }
    // Slice J — cross-pack body-grant overlap disclosure (uninstall
    // side). Renders directly under the Slice G body-grant release
    // list, gated identically (`showDelete` AND confirm strip armed
    // for this row) PLUS a non-empty `overlapGrants` array. Corrects
    // the most common mental-model gap: "uninstalling A releases the
    // grant" is false when another installed pack B also declares
    // the key (the engine's grant store is a set-union, so B keeps
    // the grant alive). Same `entry.grantKey + " — also via "
    // + entry.otherPackSlugs.join(', ')` formatting as the install
    // surface so both reads parallel. Gate on the actual array
    // length (Slice I/G defensive symmetry).
    const deleteOverlapGrants = grantOverlap?.grants ?? [];
    const showDeleteGrantOverlap =
      showDelete
      && deleteOverlapGrants.length > 0
      && confirmingDeleteFor === pack.slug;
    if (showDeleteGrantOverlap) {
      const overlapSection = doc.createElement('section');
      overlapSection.setAttribute(PACKS_ROW_DELETE_GRANT_OVERLAP_ATTR, '');
      overlapSection.className = 'packs-row-delete-grant-overlap';
      const overlapHeading = doc.createElement('p');
      overlapHeading.className = 'packs-row-delete-grant-overlap-heading';
      overlapHeading.textContent = COPY.delete_grant_overlap_heading;
      overlapSection.appendChild(overlapHeading);
      const overlapList = doc.createElement('ul');
      overlapList.className = 'packs-row-delete-grant-overlap-list';
      for (const entry of deleteOverlapGrants) {
        const li = doc.createElement('li');
        li.setAttribute(
          PACKS_ROW_DELETE_GRANT_OVERLAP_ITEM_ATTR,
          entry.grantKey,
        );
        li.textContent =
          `${entry.grantKey}${GRANT_OVERLAP_ALSO_VIA_PREFIX}${entry.otherPackSlugs.join(', ')}`;
        overlapList.appendChild(li);
      }
      overlapSection.appendChild(overlapList);
      item.appendChild(overlapSection);
    }
    if (showInstall || showDelete) {
      const footer = doc.createElement('footer');
      footer.className = 'packs-row-footer';

      if (showInstall) {
        // Install button — surfaces when the panel has a runInstall
        // caller AND the pack is not already installed. Codex review
        // fold (MINOR 7) — foundation packs that failed to auto-install
        // at boot surface as `pre_install: true` + `installed: false`,
        // so the gate uses `installed` alone (foundation packs whose
        // boot install failed surface the Install button so the user
        // can retry from the UI). Disabled while ANY install dialog is
        // open, an install is in flight, OR Slice B's Delete rpc is
        // mid-flight (single-rpc-at-a-time per DD#10).
        const installBtn = doc.createElement('button');
        installBtn.type = 'button';
        installBtn.setAttribute(PACKS_ROW_INSTALL_BTN_ATTR, pack.slug);
        installBtn.className = 'rx-btn rx-btn-primary rx-btn-sm packs-row-install';
        // An uninstalled pack's manifest is fetched on detail render, and the
        // consent dialog cannot open until it lands. Say so on the button rather
        // than letting the click land on nothing and the popup appear later out
        // of nowhere — that gap is indistinguishable from the button being
        // broken, which is exactly how it was reported.
        const resolvingThis = detailResolving === pack.slug;
        /** ⛔⛔ AN AVAILABLE UPDATE IS NOT AN INSTALL, AND THE LIST ALREADY SAID SO.
         *  The browse row renders "↑ Update v2→v3" while this footer said "Install" for
         *  the same pack — two surfaces disagreeing about what the button does, which
         *  reads as the detail being wrong (or worse, as a fresh install that would
         *  discard the owner's existing configuration).
         *
         *  🔑 THE CAUSE IS UPSTREAM AND DELIBERATE: `findPackBySlug` sets
         *  `installed: installedVersion >= pendingAddEntry.version` so that a NEWER
         *  installed version can never be presented as a downgrade-shaped "Update".
         *  That guard is right, but it also makes the genuine update case (older
         *  installed, newer in the marketplace) fall through to `showInstall` — and this
         *  footer had no update wording to fall into. `installed_any_version` is the
         *  field that already knows the difference; only the LABEL was missing.
         *
         *  ⚠ The click is unchanged — installing the newer version IS the update — so
         *  this is a truthfulness fix, not a behaviour change. Wording is duplicated from
         *  `discover-panel`'s row on purpose: the two surfaces must read identically, and
         *  a shared helper across the browse/detail boundary is a bigger refactor than
         *  this defect justifies. */
        const installedVersion = rosterInstalledVersions.get(pack.slug);
        const isUpdate =
          pack.installed_any_version === true
          && !pack.installed
          && installedVersion !== undefined
          && installedVersion < pack.version;
        /** ⛔ THE SAME FALL-THROUGH, ONE CASE OVER. Installed at THIS version yet
         *  not current means the pack's recipes moved without a pack version bump
         *  — a records pack's list now offers that as an update review (D-292's
         *  importers reached no existing owner until it did), and a recipe-bearing
         *  pack has always read it that way. The dialog already said "Update"; the
         *  button said "Install". */
        const isRecipeUpdate =
          pack.installed_any_version === true
          && !pack.installed
          && installedVersion !== undefined
          && installedVersion === pack.version;
        installBtn.textContent = resolvingThis
          ? COPY.install_preparing_label
          : isUpdate
            ? `↑ Update v${installedVersion}→v${pack.version}`
            : isRecipeUpdate
              ? COPY.update_recipes_label
              : COPY.install_label;
        // ⚠ NOT disabled while resolving. Disabling it swallowed the click —
        // press Install during the fetch and nothing happened, the label flipped
        // back, and you had to press again. `openDialog` does not need the
        // manifest to record the intent, so the click is allowed to LAND: it
        // sets `dialogOpenFor` now and the dialog paints its loading state,
        // then fills in the moment the manifest arrives.
        if (resolvingThis) installBtn.setAttribute('aria-busy', 'true');
        if (dialogOpenFor !== null || installing || deleting) {
          installBtn.disabled = true;
        }
        installBtn.addEventListener('click', () => {
          openDialog(pack.slug);
        });
        footer.appendChild(installBtn);
      }

      if (showDelete) {
        // Slice B — three visual states keyed off `confirmingDeleteFor`
        // + `deleting` (mirrors SI Slice 1.5's per-row Delete strip):
        //   default:    [Delete]
        //   confirming: [Confirm delete] [Cancel]
        //   in-flight:  [Deleting…] (aria-disabled) [Cancel] (aria-disabled)
        const isInFlightForThis =
          deleting && confirmingDeleteFor === pack.slug;
        const isConfirmingThis = confirmingDeleteFor === pack.slug;
        if (!isConfirmingThis) {
          const delBtn = doc.createElement('button');
          delBtn.type = 'button';
          delBtn.setAttribute(PACKS_ROW_DELETE_BTN_ATTR, pack.slug);
          delBtn.className = 'rx-btn rx-btn-secondary rx-btn-sm packs-row-delete';
          delBtn.textContent = COPY.delete_label;
          // Disabled while ANY install dialog is open, an install is
          // in flight, OR a Delete is mid-flight on a DIFFERENT row.
          // The single-rpc-at-a-time invariant (DD#10) keeps the panel
          // coherent across affordances.
          if (dialogOpenFor !== null || installing || deleting) {
            delBtn.disabled = true;
          }
          delBtn.addEventListener('click', () => {
            openDeleteConfirm(pack.slug);
          });
          footer.appendChild(delBtn);
        } else {
          // Confirming OR in-flight on this row — render the confirm
          // strip. Uses `rx-btn-danger` outlined-danger primitive
          // (same as SI Slice 1.5 + devices-page-mount confirm) so the
          // destructive intent reads visually distinct from the
          // benign Cancel.
          const confirmBtn = doc.createElement('button');
          confirmBtn.type = 'button';
          confirmBtn.setAttribute(
            PACKS_ROW_DELETE_CONFIRM_BTN_ATTR,
            pack.slug,
          );
          confirmBtn.className =
            'rx-btn rx-btn-danger rx-btn-sm packs-row-delete-confirm';
          confirmBtn.textContent = isInFlightForThis
            ? COPY.deleting_label
            : COPY.delete_confirm_label;
          if (isInFlightForThis) {
            // Keep the activated confirmation as the keyboard anchor. The
            // submit state guard owns re-entry while these attributes expose
            // the lock without removing the button from the focus order.
            confirmBtn.setAttribute('aria-disabled', 'true');
            confirmBtn.setAttribute('aria-busy', 'true');
          }
          confirmBtn.addEventListener('click', () => {
            void submitUninstall();
          });
          footer.appendChild(confirmBtn);

          const cancelBtn = doc.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.setAttribute(
            PACKS_ROW_DELETE_CANCEL_BTN_ATTR,
            pack.slug,
          );
          cancelBtn.className =
            'rx-btn rx-btn-secondary rx-btn-sm packs-row-delete-cancel';
          cancelBtn.textContent = COPY.cancel_label;
          if (isInFlightForThis) cancelBtn.setAttribute('aria-disabled', 'true');
          cancelBtn.addEventListener('click', () => {
            cancelDeleteConfirm(pack.slug);
          });
          footer.appendChild(cancelBtn);

          if (deleteError !== null) {
            const errBox = doc.createElement('span');
            errBox.setAttribute(PACKS_ROW_DELETE_ERROR_ATTR, '');
            errBox.setAttribute('role', 'alert');
            errBox.className = 'packs-row-delete-error';
            errBox.textContent = deleteError;
            footer.appendChild(errBox);
          }
        }
      }

      item.appendChild(footer);
    }
  };

  // Slice K — the post-success runnability disclosure notice. Warn-tone
  // callout: heading line anchoring the pack ("Installed <name>.") + a
  // Dismiss button, then one block per disclosure kind with the shared
  // headline + a per-recipe list. All text lands via `textContent`
  // (DD#5 createElement discipline — no markup injection).
  const renderDisclosureNotice = (
    notice: PacksPanelDisclosure,
  ): HTMLElement => {
    const box = doc.createElement('div');
    box.setAttribute(PACKS_DISCLOSURE_ATTR, notice.pack_slug);
    box.className = 'packs-disclosure';
    const head = doc.createElement('div');
    head.className = 'packs-disclosure-head';
    const title = doc.createElement('span');
    title.className = 'packs-disclosure-title';
    title.textContent = `${
      notice.action === 'installed'
        ? COPY.disclosure_installed_prefix
        : COPY.disclosure_uninstalled_prefix
    }${notice.pack_name}.`;
    head.appendChild(title);
    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.setAttribute(PACKS_DISCLOSURE_DISMISS_BTN_ATTR, '');
    dismiss.className =
      'rx-btn rx-btn-secondary rx-btn-sm packs-disclosure-dismiss';
    dismiss.textContent = COPY.disclosure_dismiss_label;
    dismiss.addEventListener('click', () => {
      if (disposed) return;
      const dismissedSlug = notice.pack_slug;
      disclosure = null;
      render();
      // The notice is transient DOM. Without an explicit successor its
      // focused Dismiss button is removed by render() and keyboard ownership
      // falls all the way back to <body>. Return to the action for the pack
      // whose outcome was dismissed; an inventory refresh may have removed
      // that row, so keep stable detail controls as ordered fallbacks.
      focusPanelElement(
        findBtn(PACKS_ROW_INSTALL_BTN_ATTR, dismissedSlug)
          ?? findSelectedDetailTab()
          ?? findBtn(PACKS_DETAIL_BACK_ATTR),
      );
    });
    head.appendChild(dismiss);
    box.appendChild(head);
    for (const block of notice.blocks) {
      const blockEl = doc.createElement('div');
      blockEl.setAttribute(PACKS_DISCLOSURE_BLOCK_ATTR, block.kind);
      blockEl.className = 'packs-disclosure-block';
      const headline = doc.createElement('p');
      headline.className = 'packs-disclosure-headline';
      headline.textContent = block.headline;
      blockEl.appendChild(headline);
      const list = doc.createElement('ul');
      list.className = 'packs-disclosure-list';
      for (const item of block.items) {
        const li = doc.createElement('li');
        li.setAttribute(PACKS_DISCLOSURE_ITEM_ATTR, item.recipe_id);
        li.textContent =
          item.detail.length > 0
            ? `${item.recipe_id} — ${item.detail}`
            : item.recipe_id;
        list.appendChild(li);
      }
      blockEl.appendChild(list);
      box.appendChild(blockEl);
    }
    return box;
  };

  // R22.1 + D-211 follow-on — the DETAIL view (`#packs/<slug>`) keeps Identity
  // and its actions fixed, then splits the potentially-long content into:
  //   DETAIL       declared capacity / readiness + descriptive metadata;
  //   PERMISSIONS  global owner risk / approval replacements for pack ops;
  //   ACCESS       the per-contract operation reachability matrix.
  // Detail-only surface — the Back button + a transient body. Shared by the
  // resolve loading / error placeholders so a marketplace pack still has a Back
  // affordance while its manifest is being fetched (or after it failed).
  const appendDetailBack = (): void => {
    const back = doc.createElement('button');
    back.type = 'button';
    back.setAttribute(PACKS_DETAIL_BACK_ATTR, '');
    back.className = 'rx-btn rx-btn-secondary rx-btn-sm packs-detail-back';
    back.textContent = COPY.detail_back_label;
    back.addEventListener('click', () => selectPack(null));
    wrapper.appendChild(back);
  };

  /** Detail-only — the transient "resolving a marketplace pack" placeholder. */
  const renderDetailLoading = (slug: string): void => {
    appendDetailBack();
    const note = doc.createElement('p');
    note.setAttribute(PACKS_DETAIL_RESOLVING_ATTR, slug);
    note.className = 'packs-detail-note';
    note.textContent = COPY.detail_resolving_label;
    wrapper.appendChild(note);
  };

  /** Detail-only — a non-roster slug that CANNOT be resolved (no `runResolvePack`
   *  wired, e.g. a partial host or a server without the resolve rpc): a TERMINAL
   *  "unavailable" state with Back, not an endless spinner (nothing would ever
   *  complete the loading placeholder). No retry — retry can't help without a
   *  resolver. Reuses the resolve-error hook (both are terminal non-loading). */
  const renderDetailUnavailable = (slug: string): void => {
    appendDetailBack();
    const note = doc.createElement('p');
    note.setAttribute(PACKS_DETAIL_RESOLVE_ERROR_ATTR, slug);
    note.setAttribute('role', 'alert');
    note.className = 'packs-detail-note';
    note.textContent = COPY.detail_unavailable_label;
    wrapper.appendChild(note);
  };

  /** Detail-only — a resolve failure (unresolved / fetch / validation / version)
   *  with the reason + a retry (clearing the error re-arms `ensureDetailResolved`). */
  const renderDetailResolveError = (slug: string, message: string): void => {
    appendDetailBack();
    const err = doc.createElement('p');
    err.setAttribute(PACKS_DETAIL_RESOLVE_ERROR_ATTR, slug);
    err.setAttribute('role', 'alert');
    err.className = 'packs-add-error';
    err.textContent = message;
    wrapper.appendChild(err);
    const retry = doc.createElement('button');
    retry.type = 'button';
    retry.setAttribute(PACKS_DETAIL_RESOLVE_RETRY_ATTR, slug);
    retry.className =
      'rx-btn rx-btn-secondary rx-btn-sm packs-detail-resolve-retry';
    const retrying = detailResolving === slug;
    retry.textContent = retrying
      ? COPY.retrying_label
      : COPY.detail_resolve_error_retry_label;
    if (retrying) {
      retry.setAttribute('aria-disabled', 'true');
      retry.setAttribute('aria-busy', 'true');
    }
    retry.addEventListener('click', () => {
      if (detailResolving === slug) return;
      ensureDetailResolved(slug, true);
      render();
    });
    wrapper.appendChild(retry);
  };

  /** The pack roster and its installed recipe bodies are independent reads.
   *  Keep the latter visible while unresolved: otherwise a failure looks like
   *  a capability-only pack whose Use surface simply does not exist. */
  const renderRecipesLoadState = (): void => {
    if (opts.runRecipeList === undefined || installedRecipes !== null) return;
    const box = doc.createElement('div');
    box.className = 'packs-detail-recipes-state';
    if (recipesError === null) {
      const status = doc.createElement('p');
      status.setAttribute(PACKS_DETAIL_RECIPES_STATUS_ATTR, '');
      status.setAttribute('role', 'status');
      status.className = 'packs-detail-note';
      status.textContent = COPY.detail_recipes_loading_label;
      box.appendChild(status);
    } else {
      const error = doc.createElement('p');
      error.setAttribute(PACKS_DETAIL_RECIPES_ERROR_ATTR, '');
      error.setAttribute('role', 'alert');
      error.className = 'packs-add-error';
      error.textContent = `${COPY.detail_recipes_error_prefix} ${recipesError}`;
      box.appendChild(error);

      const retry = doc.createElement('button');
      retry.type = 'button';
      retry.setAttribute(PACKS_DETAIL_RECIPES_RETRY_ATTR, '');
      retry.className = 'rx-btn rx-btn-secondary rx-btn-sm';
      retry.textContent = recipesLoading ? COPY.retrying_label : COPY.retry_label;
      if (recipesLoading) {
        retry.setAttribute('aria-disabled', 'true');
        retry.setAttribute('aria-busy', 'true');
      }
      retry.addEventListener('click', () => {
        if (recipesLoading) return;
        loadRecipes(true);
      });
      box.appendChild(retry);
    }
    wrapper.appendChild(box);
  };

  const renderDetail = (pack: PackListEntry): void => {
    const back = doc.createElement('button');
    back.type = 'button';
    back.setAttribute(PACKS_DETAIL_BACK_ATTR, '');
    back.className = 'rx-btn rx-btn-secondary rx-btn-sm packs-detail-back';
    back.textContent = COPY.detail_back_label;
    back.addEventListener('click', () => selectPack(null));
    wrapper.appendChild(back);
    // Keep a post-action disclosure notice visible in the detail too (DD#15).
    if (disclosure !== null) {
      wrapper.appendChild(renderDisclosureNotice(disclosure));
    }
    const collision = computePackRecipeCollisions(packs).get(pack.slug);
    const grantOverlap = computePackGrantOverlaps(packs).get(pack.slug);

    const makeDetailSection = (
      id: string,
      label: string | null,
    ): HTMLElement => {
      const el = doc.createElement('section');
      el.setAttribute(PACKS_DETAIL_SECTION_ATTR, id);
      el.className = 'packs-detail-section';
      if (label !== null) {
        const heading = doc.createElement('h3');
        heading.className = 'packs-detail-heading';
        heading.textContent = label;
        el.appendChild(heading);
      }
      return el;
    };

    // ── IDENTITY — control-plane facts + the action affordances ──
    const identity = makeDetailSection('identity', null);
    const header = doc.createElement('header');
    header.className = 'packs-detail-header';
    const name = doc.createElement('h2');
    name.className = 'packs-detail-name';
    name.textContent = pack.name;
    header.appendChild(name);
    if (pack.pre_install) {
      header.appendChild(makeBadge(COPY.foundation_badge, 'accent'));
    }
    if (pack.installed) {
      header.appendChild(makeBadge(COPY.installed_badge, 'ok'));
    }
    const kind = pack.service_kind;
    if (isPackServiceKind(kind)) {
      header.appendChild(makeBadge(SERVICE_KIND_LABEL[kind] ?? kind, 'neutral'));
    }
    identity.appendChild(header);
    const facts = doc.createElement('p');
    facts.className = 'packs-detail-facts';
    facts.textContent =
      `${pack.slug} · ${COPY.publisher_prefix}${pack.publisher} · v${pack.version}`;
    identity.appendChild(facts);
    // Repo link — issues / support route to the author's repo (the
    // marketplace hosts no issue tracking); absent on most bundled packs.
    const repo = pack.repo;
    if (typeof repo === 'string' && repo.length > 0) {
      const repoLink = doc.createElement('a');
      repoLink.setAttribute(PACKS_DETAIL_REPO_LINK_ATTR, '');
      repoLink.className = 'rx-link packs-detail-repo';
      repoLink.setAttribute('href', repo);
      repoLink.setAttribute('target', '_blank');
      repoLink.setAttribute('rel', 'noopener noreferrer');
      repoLink.textContent = COPY.detail_repo_label;
      identity.appendChild(repoLink);
    }
    appendPackActions(identity, pack, grantOverlap);
    wrapper.appendChild(identity);
    // Inline consent dialog directly under the Install affordance.
    //
    // ⛔ Gated on the manifest, not just on `dialogOpenFor`. An uninstalled pack
    // arrives from `packs.list` without one and `ensureDetailResolved` fills it
    // in asynchronously; rendering consent from a half-resolved entry would show
    // an install dialog listing no recipes, no grants and no permissions — a
    // consent surface that under-states what the user is agreeing to. Absent ⇒
    // render nothing this pass; the resolve completing re-renders.
    if (dialogOpenFor === pack.slug && pack.manifest === undefined
      && detailResolving === pack.slug) {
      // Clicked Install while the manifest was still in flight. The intent is
      // recorded (`dialogOpenFor`), so stand in for the consent surface rather
      // than rendering nothing — an empty gap here is what made the click look
      // lost. The next render, with the manifest, replaces this with the dialog.
      const waiting = doc.createElement('p');
      waiting.setAttribute(PACKS_DIALOG_PENDING_ATTR, pack.slug);
      waiting.className = 'packs-detail-note';
      waiting.textContent = COPY.dialog_pending_label;
      wrapper.appendChild(waiting);
    }
    if (dialogOpenFor === pack.slug && pack.manifest !== undefined) {
      wrapper.appendChild(
        renderDialog({ ...pack, manifest: pack.manifest }, collision, grantOverlap),
      );
    }

    renderRecipesLoadState();

    // ── Tabs ─────────────────────────────────────────────────────────
    // A pack that gives you something to DO leads with it; its control-plane
    // surfaces group behind Manage. A capability pack has no Use tab, so its
    // strip stays exactly the three it always had.
    const appSurface = appSurfaceFor(pack);
    const showUse = appSurface !== null && hasAppSurface(appSurface);
    const shownTab = effectiveDetailTab(appSurface);

    const makeTabButton = (
      id: PacksDetailTab,
      label: string,
      selected: boolean,
      group: PacksDetailTabGroup,
      order: ReadonlyArray<PacksDetailTab>,
      onPick: (next: PacksDetailTab) => void,
    ): HTMLButtonElement => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.setAttribute(PACKS_DETAIL_TAB_ATTR, id);
      button.setAttribute(PACKS_DETAIL_TAB_GROUP_ATTR, group);
      button.setAttribute('role', 'tab');
      button.setAttribute('id', packsDetailTabDomId(group, id));
      button.setAttribute('aria-controls', PACKS_DETAIL_TAB_PANEL_ID);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
      button.textContent = label;
      const activate = (next: PacksDetailTab): void => {
        if (next === id && selected) {
          focusPanelElement(button);
          return;
        }
        pendingDetailTabFocus = { group, id: next };
        onPick(next);
      };
      button.addEventListener('click', () => activate(id));
      button.addEventListener('keydown', (event) => {
        const currentIndex = order.indexOf(id);
        if (currentIndex < 0) return;
        let nextIndex: number;
        if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = order.length - 1;
        else if (event.key === 'ArrowRight') {
          nextIndex = (currentIndex + 1) % order.length;
        } else if (event.key === 'ArrowLeft') {
          nextIndex = (currentIndex - 1 + order.length) % order.length;
        } else {
          return;
        }
        event.preventDefault();
        activate(order[nextIndex]!);
      });
      return button;
    };

    if (showUse) {
      const primaryTabs: ReadonlyArray<PacksDetailTab> = ['use', 'detail'];
      const pickPrimaryTab = (next: PacksDetailTab): void => {
        if (next === 'use') {
          if (shownTab === 'use') return;
          activeDetailTab = 'use';
        } else {
          if (shownTab !== 'use') return;
          activeDetailTab = MANAGE_TABS.includes(activeDetailTab)
            ? activeDetailTab
            : 'detail';
        }
        detailTabPinned = true;
        render();
        // The generated view is a real child address. Manage collapses that
        // child; returning to Use restores the already-mounted active view.
        // Both are sideways/closing moves, so they replace the current entry.
        opts.onAppViewNavigate?.(
          pack.slug,
          next === 'use' ? appView?.activeViewId() ?? null : null,
          'replace',
        );
      };
      const topStrip = doc.createElement('nav');
      topStrip.setAttribute(PACKS_DETAIL_TABS_ATTR, '');
      topStrip.setAttribute('data-recued-scroll-rail', '');
      topStrip.setAttribute('role', 'tablist');
      topStrip.setAttribute('aria-label', COPY.detail_tabs_label);
      topStrip.appendChild(makeTabButton(
        'use', COPY.detail_use_tab_label, shownTab === 'use',
        'primary', primaryTabs, pickPrimaryTab,
      ));
      // Manage re-enters the group at whichever member was last open, so
      // Use → Manage → Use → Manage returns you to Access, not to Detail.
      topStrip.appendChild(makeTabButton(
        'detail', COPY.detail_manage_tab_label, shownTab !== 'use',
        'primary', primaryTabs, pickPrimaryTab,
      ));
      // D-282 slice C — pin this app to the navigation drawer.
      //
      // ⛔ ONLY WHERE THERE IS AN APP TO OPEN. The control lives inside the
      // `showUse` branch, so a capability pack (`adyen-checkout`, `ripgrep` —
      // ops for other recipes to call, nothing to open) never offers one. A
      // pinned seat whose pack has no app surface would land the owner on a
      // management page they did not ask for.
      if (opts.onTogglePin !== undefined) {
        const pinned = (opts.pinnedApps?.() ?? []).includes(pack.slug);
        const pin = doc.createElement('button');
        pin.setAttribute('type', 'button');
        pin.setAttribute(PACKS_DETAIL_PIN_ATTR, pinned ? 'pinned' : 'unpinned');
        pin.className = 'packs-detail-pin';
        pin.textContent = pinned ? COPY.detail_unpin_label : COPY.detail_pin_label;
        pin.setAttribute('aria-pressed', String(pinned));
        pin.setAttribute(
          'title',
          pinned ? COPY.detail_unpin_hint : COPY.detail_pin_hint,
        );
        pin.addEventListener('click', () => {
          opts.onTogglePin?.(pack.slug, !pinned);
          // The writer updates its list synchronously (optimistic, then
          // authoritative), so repainting here reads the new state back through
          // the getter — no second copy of the pin list on this side.
          //
          // ⚠ NOT PROVEN BY A TEST, and said rather than implied: the panel
          // repaints on several other signals, so removing this line leaves the
          // suite green. It is here because the flip must not DEPEND on one of
          // those happening to fire.
          render();
        });
        topStrip.appendChild(pin);
      }
      wrapper.appendChild(topStrip);
    }

    // The management strip: the whole strip when there is no Use tab, the
    // second level when Manage is open.
    if (!showUse || shownTab !== 'use') {
      const tabStrip = doc.createElement('nav');
      tabStrip.setAttribute(PACKS_DETAIL_TABS_ATTR, '');
      tabStrip.setAttribute('data-recued-scroll-rail', '');
      tabStrip.setAttribute('role', 'tablist');
      tabStrip.setAttribute(
        'aria-label',
        showUse ? COPY.detail_manage_tabs_label : COPY.detail_tabs_label,
      );
      if (showUse) tabStrip.className = 'packs-detail-tabs-nested';
      const manageTabs: ReadonlyArray<{ id: PacksDetailTab; label: string }> = [
        { id: 'detail', label: COPY.detail_tab_label },
        { id: 'permissions', label: COPY.detail_permissions_tab_label },
        { id: 'access', label: COPY.detail_access_tab_label },
      ];
      const manageTabOrder = manageTabs.map((tab) => tab.id);
      const pickManageTab = (next: PacksDetailTab): void => {
        if (shownTab === next) return;
        activeDetailTab = next;
        detailTabPinned = true;
        render();
      };
      for (const tab of manageTabs) {
        tabStrip.appendChild(makeTabButton(
          tab.id, tab.label, shownTab === tab.id,
          'manage', manageTabOrder, pickManageTab,
        ));
      }
      wrapper.appendChild(tabStrip);
    }

    const tabPanel = doc.createElement('div');
    tabPanel.setAttribute(PACKS_DETAIL_TAB_PANEL_ATTR, shownTab);
    tabPanel.setAttribute('id', PACKS_DETAIL_TAB_PANEL_ID);
    tabPanel.setAttribute('role', 'tabpanel');
    tabPanel.setAttribute(
      'aria-labelledby',
      shownTab === 'use'
        ? packsDetailTabDomId('primary', 'use')
        : showUse
          ? `${packsDetailTabDomId('primary', 'detail')} `
            + packsDetailTabDomId('manage', shownTab)
          : packsDetailTabDomId('manage', shownTab),
    );
    tabPanel.className = 'packs-detail-tab-panel';

    if (shownTab === 'use') {
      // The app view owns its own DOM + run lifecycle, so it is MOUNTED rather
      // than re-rendered with the panel: a whole-panel repaint mid-run would
      // otherwise discard the result the person is reading. Remounted only when
      // the pack changes.
      if (appViewSlug !== pack.slug && appView !== null) {
        appView.dispose();
        appView = null;
      }
      if (appView === null && appSurface !== null) {
        appViewSlug = pack.slug;
        const requestedInitialView = initialAppViewPending
          && pack.slug === opts.initialSlug
          ? opts.initialAppViewId
          : undefined;
        // The target rides the SAME one-shot gate as the view id — a record
        // from the mounted address, never re-applied on a later repaint.
        const requestedInitialTarget = requestedInitialView === undefined
          ? undefined
          : opts.initialAppViewTarget;
        if (requestedInitialView !== undefined) initialAppViewPending = false;
        appView = mountPackAppView({
          host: tabPanel,
          document: doc,
          ...(opts.scrollRoot !== undefined ? { scrollRoot: opts.scrollRoot } : {}),
          pack,
          surface: appSurface,
          ...(opts.runRecipeExecute !== undefined
            ? { execute: opts.runRecipeExecute }
            : {}),
          ...(opts.openRunModal !== undefined
            ? { openRunModal: opts.openRunModal }
            : {}),
          // The result panel validates every row action against this roster.
          // Non-null by construction here: the Use tab only renders once the
          // surface resolved, which requires the recipes to have loaded.
          ...(installedRecipes !== null ? { installedRecipes } : {}),
          ...(opts.runFileRead !== undefined ? { fileRead: opts.runFileRead } : {}),
          ...(opts.runRecordRefSearch !== undefined
            ? { recordRefSearchCaller: opts.runRecordRefSearch }
            : {}),
          ...(requestedInitialView !== undefined
            ? { initialViewId: requestedInitialView }
            : {}),
          ...(requestedInitialTarget !== undefined
            ? { initialTarget: requestedInitialTarget }
            : {}),
          ...(opts.onAppViewNavigate !== undefined
            ? {
                onSelectView: (viewId: string) => {
                  opts.onAppViewNavigate?.(pack.slug, viewId, 'auto');
                },
                // D-282 B5 — a detail is a place. Opening one pushes its own
                // address; closing it puts the view's back, so Back means
                // "return to the list" rather than "leave the pack".
                onOpenLookup: (open) => {
                  opts.onAppViewNavigate?.(
                    pack.slug,
                    open === null ? appView?.activeViewId() ?? null : open.recipe_id,
                    'auto',
                    open === null ? null : open.target,
                  );
                },
              }
            : {}),
        });
        if (requestedInitialView === undefined) {
          // A Business Pack opens directly on its first projected view. Keep
          // the URL truthful without adding a second Back step after the pack
          // detail was opened from the list.
          opts.onAppViewNavigate?.(
            pack.slug,
            appView.activeViewId(),
            'replace',
          );
        } else if (
          // ⛔ A LOOKUP ADDRESS IS NEVER A TAB, so the plain "requested view is
          // not what opened" test rewrites every one of them away before the
          // record has even loaded. The mount reports whether it ACCEPTED the
          // address; only a refusal — a stale bookmark — is canonicalized.
          appView.hydratedLookup() === null
          && appView.activeViewId() !== requestedInitialView
        ) {
          opts.onAppViewNavigate?.(
            pack.slug,
            appView.activeViewId(),
            'replace',
          );
        }
      } else if (appView !== null) {
        // Same pack, panel repainted around it — re-adopt the existing node.
        appView.adopt(tabPanel);
      }
    } else if (shownTab === 'permissions') {
      // D-211 global owner replacements. They are pack-wide defaults shared by
      // every contract, so Permissions is deliberately separate from Access.
      /** ⛔⛔⛔ THE NOT-INSTALLED CASE IS DECIDED BY `installed`, NOT BY WHETHER THE
       *  OWNER-OVERRIDE MATRIX HAPPENED TO RETURN NULL. My first version asked
       *  `renderForPack(pack)` first and only previewed when it returned null — and it
       *  does NOT return null for a resolved-but-uninstalled pack: `matchedNothing` is
       *  true (the manifest declares operation ingredients, none are installed), which
       *  SKIPS its early return and renders "Install this pack to set owner defaults for
       *  its operations." So the preview never appeared in the product.
       *
       *  ⛔⛔ AND THE TEST PASSED ANYWAY, through a path production never takes: the test
       *  host wires no owner-operation callers, so `renderForPack` hit `if (!enabled)
       *  return null` and the preview rendered. A green integration test proved the
       *  branch worked under a condition the real panel never has. The owner found it in
       *  a browser. ⇒ Ask the question that actually decides it — is this pack installed?
       *  — instead of inferring it from another component's return value. */
      const preview = pack.installed || pack.manifest === undefined
        ? null
        : renderPackPermissionPreview({ document: doc, manifest: pack.manifest });
      /** The heading follows the CONTENT, so the section can never announce owner
       *  defaults over a pre-install disclosure. */
      const defaults = makeDetailSection(
        'operation-defaults',
        preview !== null
          ? COPY.detail_permission_preview_label
          : COPY.detail_operation_defaults_label,
      );
      if (preview !== null) {
        defaults.appendChild(preview);
      } else {
        const operationDefaults = ownerOperations.renderForPack(pack);
        if (operationDefaults !== null) {
          defaults.appendChild(operationDefaults);
        } else {
          const note = doc.createElement('p');
          note.className = 'packs-detail-note';
          // Order matters: "this server cannot show it" is true whether or not
          // the manifest has arrived, so it answers first; only a CAPABLE server
          // with the manifest still in flight is a loading state.
          note.textContent = !ownerOperations.enabled
            ? COPY.detail_operation_defaults_unavailable
            : pack.manifest === undefined
              ? COPY.detail_operation_defaults_loading
              : COPY.detail_operation_defaults_empty;
          defaults.appendChild(note);
        }
      }
      tabPanel.appendChild(defaults);
    } else if (shownTab === 'access') {
      // R3 by-PACK contract×op panel (contract-first nested list; the second
      // axis of the one grant matrix). Falls back when access isn't wired or
      // the pack ships no catalog operations.
      const access = makeDetailSection('access', COPY.detail_access_label);
      const accessPanel = packAccess.renderForPack(pack);
      if (accessPanel !== null) {
        access.appendChild(accessPanel);
      } else {
        const accessNote = doc.createElement('p');
        accessNote.className = 'packs-detail-note';
        accessNote.textContent = COPY.detail_access_placeholder;
        access.appendChild(accessNote);
        const contractsLink = doc.createElement('a');
        contractsLink.className = 'rx-link packs-detail-access-link';
        contractsLink.setAttribute('href', '#contracts');
        contractsLink.textContent = COPY.detail_access_contracts_label;
        access.appendChild(contractsLink);
      }
      tabPanel.appendChild(access);
    } else {
      // DETAIL — declared capacity, readiness, and descriptive metadata.
      const declares = makeDetailSection('declares', COPY.detail_declares_label);
      const counts = doc.createElement('p');
      counts.className = 'packs-detail-counts';
      const parts: string[] = [`${pack.recipe_count} ${COPY.recipes_label}`];
      if (pack.body_visibility_grant_count > 0) {
        parts.push(
          `${pack.body_visibility_grant_count} ${COPY.body_grants_label}`,
        );
      }
      // D-289 — saved views the pack ships. READ-ONLY here: this surface
      // answers "what did this Pack add?", and the only control that applies
      // to a pack view (Hide) belongs where the owner reads it, in Data.
      //
      // ⚠ Read off the manifest, which `packs.list` never sends — the detail
      // backfills it via `ensureDetailResolved` → `packs.resolveBySlug`, so
      // this is empty until that lands and fills in when it does, exactly
      // like the other manifest-backed readers in this section.
      const declaredViews = ((pack.manifest as BulkPackManifest | undefined)?.contents ?? [])
        .filter((content): content is Extract<PackContentRef, { type: 'saved_view' }> =>
          content.type === 'saved_view');
      if (declaredViews.length > 0) {
        parts.push(`${declaredViews.length} ${declaredViews.length === 1
          ? COPY.saved_view_label : COPY.saved_views_label}`);
      }
      counts.textContent = parts.join(' · ');
      declares.appendChild(counts);
      if (declaredViews.length > 0) {
        const list = doc.createElement('ul');
        list.className = 'packs-detail-saved-views';
        list.setAttribute(PACKS_DETAIL_SAVED_VIEWS_ATTR, '');
        for (const view of declaredViews) {
          const row = doc.createElement('li');
          // textContent, not innerHTML — a pack author names these.
          row.textContent = view.name;
          list.appendChild(row);
        }
        declares.appendChild(list);
        const note = doc.createElement('p');
        note.className = 'packs-detail-note';
        note.textContent = COPY.detail_saved_views_note;
        declares.appendChild(note);
      }
      // Connections readiness — per declared connection, enrolled + scope
      // coverage (null when the pack binds no connection).
      const connSection = connectionsReadiness.renderForPack(pack);
      if (connSection) declares.appendChild(connSection);
      // Supervision — the pack's supervised-daemon controls (null when it
      // ships no `detached.supervision` op or no set caller).
      const supSection = supervision.renderForPack(pack);
      if (supSection) declares.appendChild(supSection);
      tabPanel.appendChild(declares);

      const about = makeDetailSection('about', COPY.detail_about_label);
      const desc = doc.createElement('p');
      desc.className = 'packs-detail-desc';
      desc.textContent = pack.description;
      about.appendChild(desc);
      // Unresolved Discover pack ⇒ no tags yet; `ensureDetailResolved` fills the
      // manifest in and the About section re-renders with them.
      const tags = pack.tags ?? [];
      if (tags.length > 0) {
        const tagsP = doc.createElement('p');
        tagsP.className = 'packs-detail-tags';
        tagsP.textContent = tags.join(' · ');
        about.appendChild(tagsP);
      }
      const collisionNotice = renderCollisionNotice(collision);
      if (collisionNotice) about.appendChild(collisionNotice);
      tabPanel.appendChild(about);
    }

    // A generated-view deep link can outlive the dynamically classified
    // surface (recipe removed, pack changed, or no read-only view remains).
    // Once classification has answered, collapse that stale child to the
    // pack detail rather than showing Manage under a URL that promises Use.
    if (
      initialAppViewPending
      && pack.slug === opts.initialSlug
      && appSurface !== null
      && !showUse
    ) {
      initialAppViewPending = false;
      opts.onAppViewNavigate?.(pack.slug, null, 'replace');
    }
    wrapper.appendChild(tabPanel);
  };

  // The packs panel is the `#packs/<slug>` DETAIL (the browse list is the
  // discover panel beside it, via `mountPacksSurface`). It renders ONLY the
  // selected pack's detail — no list / grouping / Add-a-pack sections. A slug
  // NOT in the roster is a marketplace pack whose manifest isn't bundled:
  // resolve it (full-fidelity detail + by-slug install). No slug → nothing
  // (the surface hides this host).
  const renderReady = (): void => {
    if (selectedSlug === null) return;
    // ⚠ HERE, not only in `selectPack`. A deep-link (`#packs/<slug>`, the normal
    // way this surface is reached) seeds `selectedSlug` at construction and
    // never goes through `selectPack` — wiring the recipe read only there meant
    // a linked or refreshed pack detail silently had no Use tab at all, while
    // reaching the same pack by clicking did. Idempotent + self-guarding.
    ensureRecipesLoaded();
    const detailPack = findPackBySlug(selectedSlug);
    if (detailPack !== undefined) {
      // ⛔ A listed pack can be found and STILL be missing its manifest —
      // `packs.list` forwards one for installed packs only. Every consent
      // surface below is gated on it, so without this the Install button
      // renders, opens nothing, and reports nothing: `openDialog` sets
      // `dialogOpenFor`, the dialog's own `pack.manifest !== undefined` guard
      // renders nothing "this pass", and the resolve that was supposed to
      // complete and re-render never started, because this early return is
      // above the only `ensureDetailResolved` call. `ensureDetailResolved`
      // already knew about this case; nothing routed the case to it.
      //
      // ⛔ And a resolve that FAILS has to say so here. The not-found branch
      // below owns `renderDetailResolveError`, but a listed pack never reaches
      // it — so a failed resolve left the detail rendering normally with an
      // Install button that could not open, `ensureDetailResolved` refusing to
      // retry (it early-returns on a recorded error), and nothing anywhere
      // saying why. Same silence as the bug above, one layer down: the first
      // version of this fix turned "always broken" into "broken only when the
      // resolve fails", which is harder to find, not easier.
      if (detailPack.manifest === undefined) {
        if (detailResolveError?.slug === selectedSlug) {
          renderDetailResolveError(selectedSlug, detailResolveError.message);
          return;
        }
        ensureDetailResolved(selectedSlug);
      }
      renderDetail(detailPack);
      return;
    }
    if (detailResolveError?.slug === selectedSlug) {
      renderDetailResolveError(selectedSlug, detailResolveError.message);
      return;
    }
    // No resolver wired → a non-roster slug can never resolve. Show a terminal
    // "unavailable" state (with Back) rather than an endless "Loading pack…"
    // (ensureDetailResolved would no-op, leaving the spinner forever). Prod
    // always wires the resolver; this guards a partial/older host + a
    // deep-linked-then-uninstalled slug.
    if (opts.runResolvePack === undefined) {
      renderDetailUnavailable(selectedSlug);
      return;
    }
    ensureDetailResolved(selectedSlug); // idempotent; re-renders on completion
    renderDetailLoading(selectedSlug);
  };

  const render = (): void => {
    if (disposed) return;
    const activeElement = (
      doc as unknown as { activeElement?: HTMLElement | null }
    ).activeElement ?? null;
    let activeOwned = false;
    let restoreListRetry = false;
    let restoreRecipesRetry = false;
    let restoreDetailResolveRetry = false;
    let restoreDetailBack = false;
    let restoreDetailTab = pendingDetailTabFocus;
    let restoreDeleteAction = pendingDeleteActionFocus;
    let restoreInstallDialog = pendingInstallDialogFocus;
    pendingDetailTabFocus = null;
    if (activeElement !== null) {
      try {
        activeOwned = wrapper.contains(activeElement);
      } catch {
        activeOwned = false;
      }
      restoreDetailBack = activeOwned
        && activeElement.hasAttribute(PACKS_DETAIL_BACK_ATTR);
      restoreListRetry = activeOwned
        && activeElement.hasAttribute(PACKS_RETRY_BTN_ATTR);
      restoreRecipesRetry = activeOwned
        && activeElement.hasAttribute(PACKS_DETAIL_RECIPES_RETRY_ATTR);
      restoreDetailResolveRetry = activeOwned
        && activeElement.hasAttribute(PACKS_DETAIL_RESOLVE_RETRY_ATTR);
      if (activeOwned && restoreDetailTab === null) {
        const id = activeElement.getAttribute(PACKS_DETAIL_TAB_ATTR);
        const group = activeElement.getAttribute(PACKS_DETAIL_TAB_GROUP_ATTR);
        if (
          (group === 'primary' || group === 'manage')
          && (id === 'use' || id === 'detail' || id === 'permissions' || id === 'access')
        ) {
          restoreDetailTab = { group, id };
        }
      }
      if (activeOwned && restoreDeleteAction === null) {
        restoreDeleteAction = deleteActionFocusFrom(activeElement);
      }
      if (activeOwned && restoreInstallDialog === null) {
        restoreInstallDialog = installDialogFocusFrom(activeElement);
      }
    }
    clearChildren();
    switch (state) {
      case 'loading':
        renderLoading();
        break;
      case 'ready':
        renderReady();
        break;
      case 'error':
        renderError();
        break;
    }
    if (restoreListRetry) {
      focusPanelElement(
        findBtn(PACKS_RETRY_BTN_ATTR)
          ?? findBtn(PACKS_DETAIL_BACK_ATTR)
          ?? findSelectedDetailTab(),
      );
    } else if (restoreRecipesRetry) {
      focusPanelElement(
        findBtn(PACKS_DETAIL_RECIPES_RETRY_ATTR)
          ?? findDetailTab('primary', 'use')
          ?? findSelectedDetailTab()
          ?? findBtn(PACKS_DETAIL_BACK_ATTR),
      );
    } else if (restoreDetailResolveRetry) {
      focusPanelElement(
        findBtn(PACKS_DETAIL_RESOLVE_RETRY_ATTR)
          ?? (selectedSlug === null
            ? null
            : findBtn(PACKS_ROW_INSTALL_BTN_ATTR, selectedSlug))
          ?? findSelectedDetailTab()
          ?? findBtn(PACKS_DETAIL_BACK_ATTR),
      );
    } else if (restoreInstallDialog !== null) {
      pendingInstallDialogFocus = restoreInstallDialogFocus(restoreInstallDialog)
        ? null
        : restoreInstallDialog;
    } else if (restoreDeleteAction !== null) {
      pendingDeleteActionFocus = restoreDeleteActionFocus(restoreDeleteAction)
        ? null
        : restoreDeleteAction;
    } else if (restoreDetailBack) {
      focusPanelElement(findBtn(PACKS_DETAIL_BACK_ATTR));
    } else if (restoreDetailTab !== null) {
      focusPanelElement(
        findDetailTab(restoreDetailTab.group, restoreDetailTab.id)
          ?? findSelectedDetailTab(),
      );
    }
  };

  // ── Broadcast subscription (Slice D) ────────────────────────────
  // Subscribe to `pack_installed` + `pack_uninstalled` so the panel
  // refreshes on the bus instead of polling. Either kind triggers a
  // full `refreshRows()` — `refreshRows` is idempotent, and the list
  // is small enough that selective per-slug invalidation isn't worth
  // the surface-area cost. Failures land in `state.error` via the
  // normal `refreshRows` catch, never propagate up the broadcast
  // dispatch loop.
  //
  // Mirrors the cache card's DD#7 pattern in
  // `llm-result-cache-card-mount.ts`: subscribe at creation,
  // unsubscribe in `dispose()`. Tracked in a shared array so the
  // dispose path can iterate without per-kind variables ballooning.
  const broadcastUnsubscribers: Array<() => void> = [];
  if (opts.subscribe) {
    broadcastUnsubscribers.push(
      opts.subscribe('pack_installed', () => {
        if (disposed) return;
        // A preview that named a pack to install first holds Install, and the pack
        // that just installed may be that one (from another tab, or the AI). Drop
        // it, so the dialog asks again rather than stay held on a stale answer.
        for (const [slug, entry] of dialogInstallPreview) {
          if (missingPacksToInstallFirst(entry.preview).length > 0) dialogInstallPreview.delete(slug);
        }
        void refreshRows({ refreshRecipes: true });
      }),
    );
    broadcastUnsubscribers.push(
      opts.subscribe('pack_uninstalled', () => {
        if (disposed) return;
        void refreshRows({ refreshRecipes: true });
      }),
    );
  }

  // Initial paint — `refreshRows()` triggers `transitionTo('loading')`
  // which short-circuits (state already === 'loading'), so the explicit
  // `render()` is the only painter of the initial loading state.
  render();
  void refreshRows();

  return {
    getState: () => state,
    refreshAppView: () => appView?.refresh(),
    getActiveViewId: () => appView?.activeViewId() ?? null,
    // Codex review fold (MINOR 5) — return defensive copies so a test
    // caller / host that mutates the returned value cannot corrupt
    // panel state behind the renderer. `packs` is a Map-key in
    // refresh logic + the dialog reconciliation pass, so an external
    // splice would silently desync the dialog state.
    getPacks: () => [...packs],
    // Slice C — recompute on demand (cheap) + return a defensive copy
    // so external mutation cannot corrupt panel state. Mirrors the
    // `getPacks` defensive-copy stance (MINOR 5 fold). The map's
    // VALUE entries are read-only by type, so a shallow copy is enough.
    getCollisions: () => {
      if (state !== 'ready') return new Map<string, PackRecipeCollision>();
      return new Map(computePackRecipeCollisions(packs));
    },
    // Slice J — same defensive-copy + recompute-on-demand pattern as
    // getCollisions. Map values are ReadonlyArray-shaped so a shallow
    // copy is enough.
    getGrantOverlaps: () => {
      if (state !== 'ready') return new Map<string, PackGrantOverlap>();
      return new Map(computePackGrantOverlaps(packs));
    },
    // Slice K — defensive deep-ish copy (blocks + items re-created) so
    // an external mutation cannot corrupt the staged notice behind the
    // renderer. Mirrors the getPacks / getCollisions stance.
    getDisclosure: () =>
      disclosure === null
        ? null
        : {
            ...disclosure,
            blocks: disclosure.blocks.map((block) => ({
              ...block,
              items: block.items.map((item) => ({ ...item })),
            })),
          },
    getDialogOpenFor: () => dialogOpenFor,
    isInstalling: () => installing,
    getListError: () => listError,
    getDialogError: () => dialogError?.text ?? null,
    getDialogPermissions: () => {
      if (dialogOpenFor === null) return new Set<string>();
      // Defensive copy — togglePermission is the single writer; a
      // caller mutating the returned set would race the next render
      // against the stale snapshot.
      const live = dialogPermissions.get(dialogOpenFor);
      return live ? new Set(live) : new Set<string>();
    },
    getDialogAccessTier: () => {
      if (dialogOpenFor === null) return null;
      const pack = findPackBySlug(dialogOpenFor);
      if (!pack) return null;
      const model = grantModelFor(pack);
      if (model === null) return null;
      return grantAccessFor(dialogOpenFor, model);
    },
    getDialogScope: () => {
      if (dialogOpenFor === null) return null;
      const pack = findPackBySlug(dialogOpenFor);
      if (!pack) return null;
      if (grantModelFor(pack) === null) return null;
      const audience = grantAudienceFor(dialogOpenFor);
      if (audience.all_customers && audience.all_other_contracts) return 'all_contracts';
      if (audience.all_customers) return 'all_customers';
      if (audience.all_other_contracts) return 'all_other_contracts';
      return 'owner';
    },
    getDialogAudience: () => {
      if (dialogOpenFor === null) return null;
      const pack = findPackBySlug(dialogOpenFor);
      if (!pack || grantModelFor(pack) === null) return null;
      return grantAudienceFor(dialogOpenFor);
    },
    // ── list→detail (the panel IS the detail; the surface drives selection) ──
    getSelectedSlug: () => selectedSlug,
    clickSelectPack: (slug: string) => selectPack(slug),
    clickBackToList: () => selectPack(null),
    hasInFlightWork: () =>
      installing
      || deleting
      || appView?.hasInFlightWork() === true,
    hasUnsavedChanges: () => appView?.hasUnsavedChanges() === true,
    refresh: () => {
      // Slice A — no defer-while-dialog-open invariant (mirroring SI
      // panel Major #3 would suppress refresh while the dialog is
      // open). The dialog's permission map is keyed on slug, not on
      // any specific list snapshot, so a refresh that drops the open
      // pack's row would naturally close the dialog on the next
      // render. Pack disappearance during refresh is extremely rare
      // (would require a server-side pack file delete + immediate
      // refresh), so the lost-input cost is acceptable + matches the
      // Devices panel pattern. The recipe roster follows the same refresh so
      // its Use classification cannot outlive the pack snapshot.
      void refreshRows({ refreshRecipes: true });
    },
    whenLoaded: () => pendingListPromise,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      supervision.dispose();
      connectionsReadiness.dispose();
      packAccess.dispose();
      ownerOperations.dispose();
      // The Use tab's app view holds its own listener + in-flight run token;
      // disposing it is what stops a late run painting into a removed tree.
      if (appView !== null) {
        appView.dispose();
        appView = null;
        appViewSlug = null;
      }
      // Slice D — drop broadcast subscriptions BEFORE detaching the
      // wrapper so any in-flight event listener can't try to render
      // into a removed DOM tree. Each unsubscribe call is wrapped
      // because the broadcast subscriber owns its own teardown — a
      // throw on our side shouldn't stop us from disposing the rest.
      for (const unsub of broadcastUnsubscribers) {
        try {
          unsub();
        } catch {
          /* swallow per-handle teardown failures */
        }
      }
      broadcastUnsubscribers.length = 0;
      try {
        opts.host.removeChild(wrapper);
      } catch {
        wrapper.remove();
      }
    },
    clickRetry: () => {
      const b = findBtn(PACKS_RETRY_BTN_ATTR);
      if (b && !b.disabled) b.click();
    },
    clickInstall: (slug) => {
      const b = findBtn(PACKS_ROW_INSTALL_BTN_ATTR, slug);
      if (b && !b.disabled) b.click();
    },
    clickCancelDialog: () => {
      const b = findBtn(PACKS_DIALOG_CANCEL_BTN_ATTR);
      if (b && !b.disabled) b.click();
    },
    togglePermission: (permission) => togglePermissionInternal(permission),
    clickAccessOption: (tier) => setGrantAccessInternal(tier),
    clickDependencyAccessOption: (packSlug, tier) => setDependencyAccessInternal(packSlug, tier),
    getDialogDependencyScopes: () => {
      if (dialogOpenFor === null) return null;
      const pack = findPackBySlug(dialogOpenFor);
      return pack === undefined ? null : dependencyInstallScopesFor(pack) ?? null;
    },
    clickScopeOption: (scope) => setGrantScopeInternal(scope),
    clickConfirmInstall: async () => {
      const b = findBtn(PACKS_DIALOG_INSTALL_BTN_ATTR);
      if (!b || b.disabled) return;
      b.click();
      // `submitInstall` set `pendingInstallPromise` BEFORE awaiting
      // the rpc; the click handler's fire-and-forget `void submitInstall()`
      // means the test seam needs to grab the promise via the
      // closure-private ref. The simpler path is to just call
      // `submitInstall()` directly — the click already kicked off
      // the same work, so awaiting a second call just returns the
      // existing in-flight promise via the `installing` re-entry
      // guard.
      if (pendingInstallPromise) await pendingInstallPromise;
    },
    // ── Slice B introspection + seams ──────────────────────────────
    getConfirmingDeleteFor: () => confirmingDeleteFor,
    isDeleting: () => deleting,
    getDeleteError: () => deleteError,
    clickDelete: (slug) => {
      const b = findBtn(PACKS_ROW_DELETE_BTN_ATTR, slug);
      if (b && !b.disabled) b.click();
    },
    clickCancelDelete: () => {
      const b = findBtn(PACKS_ROW_DELETE_CANCEL_BTN_ATTR);
      if (b && !b.disabled) b.click();
    },
    clickConfirmDelete: async () => {
      const b = findBtn(PACKS_ROW_DELETE_CONFIRM_BTN_ATTR);
      if (!b || b.disabled) return;
      b.click();
      // Same wait-on-shared-promise pattern as clickConfirmInstall:
      // submitUninstall set `pendingUninstallPromise` before awaiting
      // the rpc, so we just await the shared promise here.
      if (pendingUninstallPromise) await pendingUninstallPromise;
    },
    // ── Slice K seam ────────────────────────────────────────────────
    clickDismissDisclosure: () => {
      const b = findBtn(PACKS_DISCLOSURE_DISMISS_BTN_ATTR);
      if (b && !b.disabled) b.click();
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

export const PACKS_PANEL_STYLES = `
[${PACKS_PANEL_ATTR}] {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  color: var(--fg);
  font-size: 13px;
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.035);
}
[${PACKS_PANEL_ATTR}] > * { min-width: 0; max-width: 100%; }
[${PACKS_PANEL_ATTR}] .packs-status {
  margin: 0;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-title-error {
  color: var(--danger);
}
[${PACKS_PANEL_ATTR}] .packs-error {
  margin: 0;
  padding: 6px 8px;
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  word-break: break-all;
}
[${PACKS_PANEL_ATTR}] .packs-actions {
  display: flex;
  min-width: 0;
  max-width: 100%;
  gap: 8px;
  flex-wrap: wrap;
}
[${PACKS_PANEL_ATTR}] .packs-empty {
  margin: 0;
  padding: 16px;
  background: var(--surface-sunk);
  border: 1px dashed var(--border-strong);
  border-radius: 11px;
  line-height: 1.5;
}
[${PACKS_PANEL_ATTR}] .packs-empty-body {
  display: block;
  margin-top: 4px;
  color: var(--fg-muted);
}
[${PACKS_PANEL_ATTR}] .packs-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
[${PACKS_PANEL_ATTR}] .packs-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 15px;
  background: var(--surface-sunk);
  border: 1px solid var(--border);
  border-radius: 11px;
}
[${PACKS_PANEL_ATTR}] .packs-row-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
[${PACKS_PANEL_ATTR}] .packs-row-name {
  font-weight: 600;
}
[${PACKS_PANEL_ATTR}] .packs-row-version {
  color: var(--fg-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
/* Pack detail tabs keep the long global-default and contract-access lists out
   of the compact Detail summary. */
[${PACKS_PANEL_ATTR}] [${PACKS_DETAIL_TABS_ATTR}] {
  display: flex;
  min-width: 0;
  max-width: 100%;
  gap: 4px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
}
/* D-282 slice C — the pin control rides the tab strip's right edge. Not a tab:
   it navigates nowhere and carries no tablist role, so it is pushed away from
   the tabs rather than sitting among them. */
[${PACKS_PANEL_ATTR}] .packs-detail-pin {
  appearance: none;
  box-sizing: border-box;
  min-height: 36px;
  flex: 0 0 auto;
  margin-left: auto;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  align-self: center;
  background: none;
  color: var(--fg-muted);
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}
[${PACKS_PANEL_ATTR}] .packs-detail-pin:hover {
  border-color: var(--border-strong);
  color: var(--fg);
}
[${PACKS_PANEL_ATTR}] .packs-detail-pin[aria-pressed="true"] {
  border-color: var(--accent);
  color: var(--fg);
}
[${PACKS_PANEL_ATTR}] .packs-detail-pin:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-weak);
}
[${PACKS_PANEL_ATTR}] [${PACKS_DETAIL_TAB_ATTR}] {
  appearance: none;
  box-sizing: border-box;
  min-height: 36px;
  flex: 0 0 auto;
  padding: 8px 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--fg-muted);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
[${PACKS_PANEL_ATTR}] [${PACKS_DETAIL_TAB_ATTR}][aria-selected="true"] {
  border-bottom-color: var(--accent);
  color: var(--fg);
}
[${PACKS_PANEL_ATTR}] [${PACKS_DETAIL_TAB_ATTR}]:focus-visible {
  border-radius: 6px 6px 0 0;
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
[${PACKS_PANEL_ATTR}] [${PACKS_DETAIL_TAB_PANEL_ATTR}] {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-direction: column;
  gap: 16px;
}
/* R22.1 detail sections — Identity leads borderless; sections within a tab
   use the tab divider, while subsequent Detail sections keep a hairline. */
[${PACKS_PANEL_ATTR}] .packs-detail-section {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
[${PACKS_PANEL_ATTR}] .packs-detail-section > * { min-width: 0; max-width: 100%; }
[${PACKS_PANEL_ATTR}] .packs-detail-section[${PACKS_DETAIL_SECTION_ATTR}="identity"] {
  border-top: none;
  padding-top: 0;
}
[${PACKS_PANEL_ATTR}] [${PACKS_DETAIL_TAB_PANEL_ATTR}] > .packs-detail-section:first-child {
  border-top: none;
  padding-top: 0;
}
[${PACKS_PANEL_ATTR}] .packs-detail-heading {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
[${PACKS_PANEL_ATTR}] .packs-detail-header {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
[${PACKS_PANEL_ATTR}] .packs-detail-name {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-detail-facts,
[${PACKS_PANEL_ATTR}] .packs-detail-counts,
[${PACKS_PANEL_ATTR}] .packs-detail-tags,
[${PACKS_PANEL_ATTR}] .packs-detail-note {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  line-height: 1.45;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-detail-counts {
  font-variant-numeric: tabular-nums;
}
/* D-289 — the declared saved-view names. Sized from this panel's own scale,
   not fresh literals: an unstyled class inside a styled surface renders flush
   and as bullet points beside neighbours that do not. */
[${PACKS_PANEL_ATTR}] .packs-detail-saved-views {
  list-style: none;
  margin: 6px 0 4px;
  padding: 0;
  display: grid;
  gap: 4px;
  min-width: 0;
}
[${PACKS_PANEL_ATTR}] .packs-detail-saved-views > li {
  min-width: 0;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-detail-desc {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-detail-repo,
[${PACKS_PANEL_ATTR}] .packs-detail-access-link {
  font-size: 12px;
}
[${PACKS_PANEL_ATTR}] .packs-detail-access-link {
  box-sizing: border-box;
  display: inline-flex;
  width: fit-content;
  min-height: 36px;
  align-items: center;
  align-self: flex-start;
  padding: 4px;
  border-radius: 6px;
}
[${PACKS_PANEL_ATTR}] .packs-detail-access-link:hover {
  background: var(--accent-weak);
}
[${PACKS_PANEL_ATTR}] .packs-detail-recipes-state {
  box-sizing: border-box;
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-sunk);
}
[${PACKS_PANEL_ATTR}] .packs-detail-recipes-state .packs-add-error {
  flex: 1 1 260px;
  margin: 0;
  line-height: 1.45;
}
[${PACKS_PANEL_ATTR}] [${PACKS_DETAIL_RECIPES_RETRY_ATTR}][aria-disabled="true"] {
  cursor: wait;
  opacity: .65;
}
[${PACKS_PANEL_ATTR}] .packs-row-footer {
  box-sizing: border-box;
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 8px;
}
[${PACKS_PANEL_ATTR}] .packs-row-footer > .rx-btn {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  min-height: 40px;
  flex: 0 0 auto;
}
[${PACKS_PANEL_ATTR}] [${PACKS_ROW_DELETE_CONFIRM_BTN_ATTR}][aria-disabled="true"],
[${PACKS_PANEL_ATTR}] [${PACKS_ROW_DELETE_CANCEL_BTN_ATTR}][aria-disabled="true"] {
  cursor: wait;
  opacity: .65;
}
[${PACKS_PANEL_ATTR}] [${PACKS_DIALOG_INSTALL_BTN_ATTR}][aria-disabled="true"],
[${PACKS_PANEL_ATTR}] [${PACKS_DIALOG_CANCEL_BTN_ATTR}][aria-disabled="true"] {
  cursor: wait;
  opacity: .65;
}
[${PACKS_PANEL_ATTR}] [${PACKS_DIALOG_ATTR}] {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  flex-direction: column;
  gap: 10px;
  padding: clamp(18px, 3vw, 26px);
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: 14px;
  box-shadow: 0 14px 36px rgba(24, 24, 27, 0.07);
}
[${PACKS_PANEL_ATTR}] [${PACKS_DIALOG_ATTR}] > * {
  min-width: 0;
  max-width: 100%;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-eyebrow {
  margin: 0;
  color: var(--accent);
  font-size: 11px;
  font-weight: 750;
  text-transform: uppercase;
  letter-spacing: 0.09em;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-heading {
  margin: 0;
  font-size: 21px;
  font-weight: 720;
  line-height: 1.2;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-intro {
  max-width: min(66ch, 100%);
  margin: 0 0 6px;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-summary {
  margin: 0;
  font-weight: 650;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-list {
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-list > li {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-sunk);
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-perms-heading,
[${PACKS_PANEL_ATTR}] .packs-dialog-body-heading {
  margin-top: 8px;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-perm-list {
  display: grid;
  min-width: 0;
  max-width: 100%;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-body-list {
  box-sizing: border-box;
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 6px;
  margin: 0;
  padding: 12px 12px 12px 30px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-si-list {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-si-row {
  min-width: 0;
  max-width: 100%;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-si-scope {
  margin-bottom: 2px;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-si-id {
  color: var(--fg-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 11px;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-si-label {
  font-weight: 600;
  color: var(--fg-muted);
}
[${PACKS_PANEL_ATTR}] .packs-dialog-perm-row {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  list-style: none;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-perm-row label {
  box-sizing: border-box;
  display: flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-sunk);
  cursor: pointer;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-perm-row label:has(input:checked) {
  border-color: var(--accent);
  background: var(--accent-weak);
}
[${PACKS_PANEL_ATTR}] .packs-dialog-perm-row label:has(input:disabled) {
  cursor: default;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-perm-row input {
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  margin: 0;
  accent-color: var(--accent);
}
[${PACKS_PANEL_ATTR}] .packs-dialog-perm-label {
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  word-break: break-word;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-perm-note {
  color: var(--fg-muted);
  font-size: 11px;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-deps {
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 8px;
  margin-top: 8px;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-deps-intro {
  margin: 0;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.5;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-dep-list {
  display: grid;
  min-width: 0;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-dep {
  box-sizing: border-box;
  display: grid;
  min-width: 0;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
}
[${PACKS_PANEL_ATTR}] .packs-dialog-dep-name {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-dep-note {
  margin: 0;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.45;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-dep-access {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-dep-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-dep-option input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--accent);
}
/* D-295 webhooks and D-315 mail templates share these: each choice on its own
   row, its hints quieter than the question. */
[${PACKS_PANEL_ATTR}] .packs-dialog-webhook {
  margin: 8px 0 12px;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-webhook-what,
[${PACKS_PANEL_ATTR}] .packs-dialog-webhooks-intro,
[${PACKS_PANEL_ATTR}] .packs-dialog-webhooks-hint {
  margin: 4px 0;
  line-height: 1.45;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-webhooks-hint {
  color: var(--fg-muted);
  font-size: 12px;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-webhook-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-height: 36px;
  padding: 6px 0;
  cursor: pointer;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-webhook-option input {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 2px 0 0;
  accent-color: var(--accent);
}
[${PACKS_PANEL_ATTR}] .packs-dialog-dep-needs {
  margin: 0;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.45;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-dep-needs-short {
  padding: 7px 9px;
  border-left: 3px solid var(--warn);
  border-radius: 6px;
  background: var(--warn-bg);
  color: var(--fg);
}
[${PACKS_PANEL_ATTR}] .packs-dialog-error {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--danger);
  background: var(--danger-weak);
  color: var(--danger);
  border-radius: 9px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  word-break: break-all;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-warning {
  margin: 0;
  padding: 10px 12px;
  background: var(--warn-bg);
  color: var(--fg);
  border: 1px solid var(--warn);
  border-left: 3px solid var(--warn);
  border-radius: 9px;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
/* The packs an install needs and does not bring in: the warning's look, with a
   "Get <pack>" link each. The links are anchors dressed as buttons. */
[${PACKS_PANEL_ATTR}] .packs-dialog-missing {
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  background: var(--warn-bg);
  color: var(--fg);
  border: 1px solid var(--warn);
  border-left: 3px solid var(--warn);
  border-radius: 9px;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-missing-lead {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-missing-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-missing-link {
  box-sizing: border-box;
  max-width: 100%;
  text-decoration: none;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-actions {
  display: flex;
  min-width: 0;
  max-width: 100%;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-top: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
[${PACKS_PANEL_ATTR}] .packs-dialog-actions .rx-btn {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  min-height: 40px;
  padding-inline: 16px;
  border-radius: 9px;
}
/* Both shared pickers are grid children of the pack consent surface. Bound
   their tracks here so catalog operation ids and account labels stay local. */
[${PACKS_PANEL_ATTR}] [${PACKS_DIALOG_ATTR}] :is(
  [data-recued-install-grant-picker], [data-recued-install-connect]
) { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; }
[${PACKS_PANEL_ATTR}] [${PACKS_DIALOG_ATTR}] [data-recued-install-grant-picker] :is(
  .igp-access-list, .igp-access-row, .igp-access-label,
  .igp-scope, .igp-scope-list, .igp-scope-row, .igp-scope-label
),
[${PACKS_PANEL_ATTR}] [${PACKS_DIALOG_ATTR}] [data-recued-install-connect] :is(
  .packs-dialog-connect-list, .packs-dialog-connect-row,
  .packs-dialog-connect-row label, .packs-dialog-connect-option-label
) { min-width: 0; max-width: 100%; }
[${PACKS_PANEL_ATTR}] [${PACKS_DIALOG_ATTR}] [data-recued-install-grant-picker] .igp-access-list {
  grid-template-columns: repeat(auto-fit, minmax(min(176px, 100%), 1fr));
}
[${PACKS_PANEL_ATTR}] [${PACKS_DIALOG_ATTR}] [data-recued-install-connect] :is(
  .packs-dialog-connect-heading, .packs-dialog-connect-empty,
  .packs-dialog-connect-hint, .packs-dialog-connect-summary,
  .packs-dialog-connect-option-label
) { overflow-wrap: anywhere; }
[${PACKS_PANEL_ATTR}] .packs-row-delete-error {
  box-sizing: border-box;
  display: inline-block;
  min-width: 0;
  max-width: 100%;
  flex: 1 1 100%;
  padding: 4px 6px;
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 11px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-row-collision {
  margin: 0;
  padding: 4px 8px;
  background: var(--warn-bg);
  color: var(--warn);
  border-left: 3px solid var(--warn);
  border-radius: 3px;
  font-size: 12px;
  line-height: 1.45;
  word-break: break-word;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-grant-overlap {
  display: grid;
  gap: 5px;
  padding: 12px;
  border: 1px solid var(--accent);
  border-left: 3px solid var(--accent);
  border-radius: 9px;
  background: var(--accent-weak);
}
[${PACKS_PANEL_ATTR}] .packs-dialog-grant-overlap-heading {
  color: var(--fg);
  font-size: 12px;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-grant-overlap-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
  color: var(--fg-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 11px;
  line-height: 1.5;
  word-break: break-word;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-owner-operation-review {
  display: grid;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--warn);
  border-left: 3px solid var(--warn);
  border-radius: 9px;
  background: var(--warn-bg);
}
[${PACKS_PANEL_ATTR}] .packs-dialog-owner-operation-review-heading,
[${PACKS_PANEL_ATTR}] .packs-dialog-owner-operation-review-intro,
[${PACKS_PANEL_ATTR}] .packs-dialog-owner-operation-review-removed {
  margin: 0;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-owner-operation-review-intro,
[${PACKS_PANEL_ATTR}] .packs-dialog-owner-operation-review-removed {
  color: var(--fg-muted);
  font-size: 11px;
  line-height: 1.5;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-owner-operation-review-list {
  display: grid;
  gap: 5px;
  max-height: 240px;
  overflow: auto;
  margin: 0;
  padding-left: 18px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 11px;
  line-height: 1.5;
}
[${PACKS_DIALOG_OWNER_OPERATION_REVIEW_ITEM_ATTR}][data-change="removed"] {
  color: var(--warn);
}
[${PACKS_PANEL_ATTR}] .packs-dialog-collision {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  background: var(--warn-bg);
  color: var(--fg);
  border: 1px solid var(--warn);
  border-left: 3px solid var(--warn);
  border-radius: 9px;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-collision-heading {
  margin: 0;
  font-weight: 600;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-collision-list {
  margin: 0;
  padding-left: 18px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-collision-group {
  word-break: break-word;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-collision-followup {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  opacity: 0.85;
}
[${PACKS_PANEL_ATTR}] .packs-dialog-recipe-collision {
  color: var(--warn);
}
/* D-304 — what goes with the pack's recipes reads as part of the confirmation, the
 * same way the foundation warning does, not as the pack's own description. */
[${PACKS_PANEL_ATTR}] .packs-row-delete-foundation-warn,
[${PACKS_PANEL_ATTR}] .packs-row-delete-removes {
  margin: 0;
  padding: 6px 8px;
  background: var(--warn-bg);
  color: var(--warn);
  border-left: 3px solid var(--warn);
  border-radius: 3px;
  font-size: 12px;
  line-height: 1.45;
  word-break: break-word;
}
[${PACKS_PANEL_ATTR}] .packs-row-delete-body-heading {
  margin: 0;
  font-weight: 600;
  font-size: 12px;
  color: var(--fg);
}
[${PACKS_PANEL_ATTR}] .packs-row-delete-body-list {
  margin: 0;
  padding-left: 18px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  color: var(--fg-muted);
  word-break: break-all;
}
[${PACKS_PANEL_ATTR}] .packs-disclosure {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: var(--warn-bg);
  color: var(--warn);
  border-left: 3px solid var(--warn);
  border-radius: 3px;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-disclosure > * {
  min-width: 0;
  max-width: 100%;
}
[${PACKS_PANEL_ATTR}] .packs-disclosure-head {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
[${PACKS_PANEL_ATTR}] .packs-disclosure-title {
  min-width: 0;
  max-width: 100%;
  flex: 1 1 140px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-disclosure-dismiss {
  box-sizing: border-box;
  min-height: 36px;
  max-width: 100%;
  flex: 0 0 auto;
  margin-left: auto;
}
[${PACKS_PANEL_ATTR}] .packs-disclosure-block {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  font-size: 12px;
  line-height: 1.45;
}
[${PACKS_PANEL_ATTR}] .packs-disclosure-headline {
  margin: 0;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-disclosure-list {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  margin: 2px 0 0;
  padding-left: 18px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] .packs-disclosure-list > li {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
/* Add-a-pack (2026-07-01) — the "Add a pack" section. */
[${PACKS_PANEL_ATTR}] .packs-add-form {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  flex-wrap: wrap;
}
[${PACKS_PANEL_ATTR}] .packs-add-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 260px;
  font-size: 12px;
  color: var(--muted, #667085);
}
[${PACKS_PANEL_ATTR}] .packs-add-input {
  padding: 6px 8px;
  border: 1px solid var(--border, #d0d5dd);
  border-radius: 6px;
  background: var(--surface, #fff);
  color: var(--fg, #101828);
  font-size: 13px;
}
[${PACKS_PANEL_ATTR}] .packs-add-error {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  margin: 6px 0 0;
  color: var(--danger, #b42318);
  font-size: 12px;
  overflow-wrap: anywhere;
}
[${PACKS_PANEL_ATTR}] [${PACKS_DETAIL_RESOLVE_RETRY_ATTR}].packs-detail-resolve-retry {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  min-height: 36px;
}
[${PACKS_PANEL_ATTR}] .packs-add-marketplace-link {
  display: inline-block;
  margin-top: 6px;
  font-size: 12px;
}
[${PACKS_PANEL_ATTR}] .packs-add-resolved {
  margin: 10px 0 0;
  font-size: 13px;
  font-weight: 600;
}
@media (max-width: 640px) {
  [${PACKS_PANEL_ATTR}] { padding: 14px; border-radius: 12px; }
  [${PACKS_PANEL_ATTR}] [${PACKS_DETAIL_TAB_ATTR}] { min-height: 44px; }
  [${PACKS_PANEL_ATTR}] .packs-detail-access-link { min-height: 44px; }
  [${PACKS_PANEL_ATTR}] [${PACKS_DISCLOSURE_DISMISS_BTN_ATTR}].packs-disclosure-dismiss.rx-btn {
    min-height: 44px;
  }
  [${PACKS_PANEL_ATTR}] [${PACKS_DETAIL_RESOLVE_RETRY_ATTR}].packs-detail-resolve-retry.rx-btn {
    min-height: 44px;
  }
  [${PACKS_PANEL_ATTR}] [${PACKS_DIALOG_ATTR}] { padding: 16px 14px; border-radius: 12px; }
  [${PACKS_PANEL_ATTR}] .packs-dialog-heading { font-size: 19px; }
  [${PACKS_PANEL_ATTR}] .packs-dialog-perm-list { grid-template-columns: 1fr; }
  [${PACKS_PANEL_ATTR}] .packs-dialog-actions .rx-btn { flex: 1 1 auto; }
  [${PACKS_PANEL_ATTR}] .packs-dialog-missing-link { min-height: 44px; }
  [${PACKS_PANEL_ATTR}] [${PACKS_DIALOG_ATTR}] [data-recued-install-grant-picker] :is(
    .igp-access-list, .igp-scope-list
  ) { grid-template-columns: minmax(0, 1fr); }
}
`;
