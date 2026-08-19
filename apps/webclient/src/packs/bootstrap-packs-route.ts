/** D-187 §6 follow-on — top-level Packs route.
 *
 *  Promotes the installed-packs surface out of Settings into its own
 *  `#packs` route (the drawer's `packs` seat graduates from a disabled
 *  "Soon" stub to a real link). Mirrors `connections/bootstrap-connections-route.ts`
 *  (D-174 P3): the panels still physically live under `settings/` — this route
 *  imports + composes them and supplies workspace chrome + caller forwarding.
 *
 *  Hosts one section + one overlay:
 *   - the packs browse → detail surface (`mountPacksSurface`, D-182): the unified
 *     list over the catalog ∪ installed roster → the `#packs/<slug>` detail
 *     (install / uninstall / grants). Sits directly under the route's "Packs"
 *     heading — no redundant subheading (it fronts the whole browse corpus, not
 *     just installed packs).
 *   - The install-time cli grant dialog (`mountCliGrantDialog`, D-182 §7.1) —
 *     idle until a pack install adds a local-binary tool, then pops a
 *     fail-closed reachability grant over the Packs section. `runInstallWithGrant`
 *     wraps the Packs install caller to fire it.
 *
 *  ── The retired "Local tools" section (2026-07-27) ────────────────────
 *  This route used to append a SECOND section: the roster-wide cli reachability
 *  grid (`mountLocalToolsPanel`, D-182 §7.2) — every installed cli tool × every
 *  contract. It was appended unconditionally, and the list↔detail toggle happens
 *  INSIDE the surface, so it also rendered under `#packs/<slug>` — where it read
 *  as that pack's local tools while actually showing the whole roster (an http
 *  pack like `adyen-management-accounts` ships no cli op, so nothing in it
 *  referred to the pack on screen). Both axes of the grant matrix already exist
 *  and are pack-honest, so the grid was a strictly wider duplicate:
 *    - `#packs/<slug>` → ACCESS (`pack-access-controls.ts`) — ONE pack's ops ×
 *      every contract, cli ops included (routed to `cli.reachability.set`).
 *    - `#contracts/<id>` (`contract-grants-panel.ts`) — ONE contract × every
 *      entry, cli ops included.
 *  ⚠ The four `cli.reachability.*` / contracts callers below did NOT go with it —
 *  three surviving consumers on the pack detail read them (ACCESS's cli toggles,
 *  ACCESS's contract rows, and the supervised-daemon "not installed" gate). Do
 *  NOT "disable local tools" by dropping them: that silently makes ACCESS's cli
 *  op toggles inert (`pack-access-controls.ts` returns early with no writer) and
 *  ungates daemon Start/Auto for a binary that isn't on PATH.
 */

import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';

import { serializeShellRoute } from '../shell/route.js';

// Unified `#packs` surface (retires the [Installed | Discover] tab split): the
// browse list (discover panel over the catalog ∪ roster union) → the detail
// (the packs panel in detail-only mode). Both mount here.
import {
  PACKS_SURFACE_STYLES,
  mountPacksSurface,
  type PacksSurfaceMount,
} from './packs-surface.js';
import { mountPackDiscovery } from '../discover/pack-discovery.js';
import { DISCOVER_PANEL_STYLES } from '../discover/discover-panel.js';
// The Use tab's surface styles — inert until a recipe-owning pack's detail
// renders one.
import {
  PACK_APP_STYLES,
  type PackAppExecuteCaller,
  type PackAppRecordRefSearchCaller,
} from './pack-app-view.js';
// The result panel's OWN stylesheet — scoped to `RECIPE_RESULT_HOST_ATTR`, not
// to the recipes route, which is what lets a view's output render here at all.
import { RECIPE_RESULT_PANEL_STYLES } from '../recipes/recipe-result-panel.js';

import {
  PACKS_PANEL_STYLES,
  mountPacksPanel,
  type PacksInstallBySlugCaller,
  type PacksInstallPreviewCaller,
  type PacksInstallCaller,
  type PacksListCaller,
  type PacksPanelMount,
  type PacksResolveCaller,
  type PacksUninstallCaller,
} from '../settings/packs-panel.js';
import type {
  SupervisionListCaller,
  SupervisionReachabilityCaller,
  SupervisionSetCaller,
} from '../settings/supervision-controls.js';
// Connections readiness — pack-row scope-coverage block + its scoped styles.
import {
  CONNECTIONS_READINESS_STYLES,
  type ConnectionsReadinessListCaller,
} from '../settings/connections-readiness-controls.js';
// R3 — the by-PACK Access panel's scoped styles (the panel itself mounts
// inside the packs panel's detail ACCESS section).
import { PACK_ACCESS_STYLES } from '../settings/pack-access-controls.js';
import {
  OWNER_OPERATION_STYLES,
  type OwnerOperationDeleteCaller,
  type OwnerOperationInventoryCaller,
  type OwnerOperationListCaller,
  type OwnerOperationUpsertCaller,
} from '../settings/owner-operation-controls.js';
// R3 — the contract-grant callers the Access panel needs, including the cli
// reachability list/set pair (the SAME `cli.reachability.*` rpcs the retired
// roster-wide grid used) and the contracts list, which has a dedicated option
// because the fallback copy is gated on a DIFFERENT feature flag.
import type {
  GrantCatalogOperationsCaller,
  GrantCliReachabilityListCaller,
  GrantCliReachabilitySetCaller,
  GrantContractsCaller,
  GrantReadCaller,
  GrantWriteCaller,
} from '../contracts/contract-grants-panel.js';
// D-182 §7.1 (inc 5b.2) — the {Access × Scope} install grant picker renders
// inside the Packs install dialog for a connection-backed pack; its styles join
// the route bundle (scoped under `[data-recued-install-grant-picker]`, inert
// until the picker renders).
import { INSTALL_GRANT_PICKER_STYLES } from '../settings/install-grant-picker.js';
import { INSTALL_CONNECT_PICKER_STYLES } from '../settings/install-connect-picker.js';
// D-182 §7.1 (increment 5) — the install-time cli grant dialog. Wraps the
// Packs section's install caller so a pack that adds a local-binary (cli) tool
// surfaces a fail-closed grant dialog after install (install → dialog → confirm).
import {
  CLI_GRANT_DIALOG_STYLES,
  mountCliGrantDialog,
  type CliGrantDialogMount,
} from '../settings/cli-grant-dialog.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';

export const PACKS_ROUTE_STYLES_MARKER = 'data-recued-packs-route-styles';
export const PACKS_ROUTE_HOST_ATTR = 'data-recued-packs-route';
export const PACKS_ROUTE_HEADING_ATTR = 'data-recued-packs-route-heading';
export const PACKS_ROUTE_PACKS_SECTION_ATTR =
  'data-recued-packs-route-packs';
export const PACKS_ROUTE_UNAVAILABLE_ATTR =
  'data-recued-packs-route-unavailable';

const PACKS_ROUTE_CHROME_STYLES = `
[${PACKS_ROUTE_HOST_ATTR}] {
  /* Inherit the shell's light/dark tokens instead of hard-pinning light
     values, which would leave inner --surface-sunk elements dark-on-dark
     in dark mode (mirrors the connections route's visual-UX fix). */
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: clamp(18px, 3vw, 30px);
  color: var(--fg);
}
[${PACKS_ROUTE_HOST_ATTR}] > * { min-width: 0; max-width: 100%; }
[${PACKS_ROUTE_HOST_ATTR}] .packs-route-header {
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 6px;
  margin-bottom: 22px;
}
[${PACKS_ROUTE_HOST_ATTR}] .packs-route-title {
  margin: 0;
  overflow-wrap: anywhere;
}
[${PACKS_ROUTE_HOST_ATTR}] .packs-route-subtitle {
  min-width: 0;
  max-width: min(660px, 100%);
  margin: 0;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
[${PACKS_ROUTE_HOST_ATTR}] .packs-route-section {
  display: grid;
  min-width: 0;
  max-width: 100%;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
  margin: 18px 0;
}
[${PACKS_ROUTE_HOST_ATTR}] .packs-route-section > * {
  min-width: 0;
  max-width: 100%;
}
[${PACKS_ROUTE_HOST_ATTR}] .packs-route-section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
[${PACKS_ROUTE_UNAVAILABLE_ATTR}] {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--surface-subtle);
  color: var(--muted);
  font-size: 13px;
  overflow-wrap: anywhere;
}
@media (max-width: 720px) {
  [${PACKS_ROUTE_HOST_ATTR}] {
    padding: 18px 14px 28px;
  }
}
`;

export const PACKS_ROUTE_STYLES = [
  PRIMITIVE_STYLES,
  PACKS_PANEL_STYLES,
  INSTALL_GRANT_PICKER_STYLES,
  INSTALL_CONNECT_PICKER_STYLES,
  CLI_GRANT_DIALOG_STYLES,
  CONNECTIONS_READINESS_STYLES,
  PACK_ACCESS_STYLES,
  OWNER_OPERATION_STYLES,
  // The unified surface (list↔detail toggle) + its browse-list panel styles.
  PACKS_SURFACE_STYLES,
  DISCOVER_PANEL_STYLES,
  PACK_APP_STYLES,
  RECIPE_RESULT_PANEL_STYLES,
  PACKS_ROUTE_CHROME_STYLES,
].join('\n');

export interface BootstrapPacksRouteOptions {
  root: HTMLElement;
  document?: Document;
  packsListCaller?: PacksListCaller;
  packsInstallCaller?: PacksInstallCaller;
  packsUninstallCaller?: PacksUninstallCaller;
  /** Add-a-pack (2026-07-01) — resolve (server rpc) + install-by-slug callers for
   *  the "Add a pack" section. Both forwarded into `mountPacksPanel`; the section
   *  renders only when BOTH are present. */
  packsResolveCaller?: PacksResolveCaller;
  packsInstallBySlugCaller?: PacksInstallBySlugCaller;
  /** D-247 D15 — `packs.install_preview`, feeding the install dialog's recipe
   *  disclosure + the grant picker's per-recipe tier. Optional: absent ⇒ the
   *  dialog renders its pre-D-247 surface. */
  packsInstallPreviewCaller?: PacksInstallPreviewCaller;
  // ── The `cli.reachability.*` trio + its contracts list ──────────────
  // Named for the local-tools CONCEPT (cli binaries), not the retired
  // roster-wide section: each one is read by a surviving pack-detail consumer.
  /** `cli.reachability.universe` — the supervised-daemon rows' binary-on-PATH
   *  gate ("not installed" ⇒ Start/Auto disabled). */
  localToolsUniverseCaller?: SupervisionReachabilityCaller;
  /** `cli.reachability.list` — the effective state of the ACCESS panel's cli op
   *  toggles (fail-closed allowlist, not `contract_grant`). */
  localToolsListCaller?: GrantCliReachabilityListCaller;
  /** `cli.reachability.set` — the ACCESS panel's cli op writes. Absent ⇒ those
   *  toggles render inert, so do not drop this to "turn off local tools". */
  localToolsSetCaller?: GrantCliReachabilitySetCaller;
  /** `collection.contract.listContracts` — fallback source for the ACCESS
   *  panel's contract rows (see {@link accessContractsCaller}). */
  localToolsContractsCaller?: GrantContractsCaller;
  /** Supervision feature (Slice 4) — `supervision.{list,set}` callers for the
   *  pack-detail daemon controls. Both forwarded into `mountPacksPanel`. */
  supervisionListCaller?: SupervisionListCaller;
  supervisionSetCaller?: SupervisionSetCaller;
  /** `collection.connection.list` caller — lights up the per-pack connection
   *  scope-readiness block. Forwarded into `mountPacksPanel`. */
  connectionsListCaller?: ConnectionsReadinessListCaller;
  // ── R3 — by-PACK Access panel callers. Together with the local-tools trio
  // (contracts list + cli list/set, reused — structurally identical rpcs),
  // these light up the detail's ACCESS section. ──
  /** `contract.grant.read` — iterated per contract row by the Access panel. */
  contractGrantReadCaller?: GrantReadCaller;
  /** `contract.grant.write` — the Access panel's connection-op toggles. */
  contractGrantWriteCaller?: GrantWriteCaller;
  /** `collection.contract.listCatalogOperations` — the shared op universe. */
  catalogOperationsCaller?: GrantCatalogOperationsCaller;
  /** D-211 actorless owner operation-default replacements. */
  ownerOperationInventoryCaller?: OwnerOperationInventoryCaller;
  ownerOperationListCaller?: OwnerOperationListCaller;
  ownerOperationUpsertCaller?: OwnerOperationUpsertCaller;
  ownerOperationDeleteCaller?: OwnerOperationDeleteCaller;
  /** `collection.contract.listContracts` — the Access panel's contract rows.
   *  Dedicated (rather than only riding {@link localToolsContractsCaller})
   *  because the local-tools copy gates on a DIFFERENT feature flag — a host
   *  with contracts enabled but local-tools disabled must still get the
   *  Access panel. Falls back to the local-tools caller when absent. */
  accessContractsCaller?: GrantContractsCaller;
  /** D-196 R6 — Seller tiers for the expanded install audience checklist. */
  sellerOverviewCaller?: () => Promise<import('@recued/contracts').SellerOverview>;
  // ── The Use tab (pack as an app) ──────────────────────────────────
  /** `recipes.list` — the pack's own recipe bodies, which the view / operation
   *  split is derived from. Absent ⇒ no pack gets a Use tab. */
  recipesListCaller?: () => Promise<{
    recipes: ReadonlyArray<import('@recued/contracts').ServerRecipeListEntry>;
  }>;
  /** `execute` — runs a view. Same caller the recipes route uses. */
  recipeExecuteCaller?: PackAppExecuteCaller;
  /** `data.file.read` — authenticated owner file read for the Use tab's file
   *  cards. The SAME caller the recipes route uses, so a file opens on
   *  identical terms wherever it is rendered. */
  fileReadCaller?: (args: { record_id: string }) => Promise<
    import('../recipes/recipe-result-panel.js').ResultFileReadResult
  >;
  /** Pack-owned Records inventory for ref-valued editable result cells. */
  recordRefSearchCaller?: PackAppRecordRefSearchCaller;
  /** Opens the shared Run | Schedule modal for a pack operation. Owned HERE
   *  rather than in the panel so one-modal-at-a-time holds for the route. */
  openRunModal?: (
    entry: import('@recued/contracts').ServerRecipeListEntry,
    onRan?: (result: import('@recued/contracts').ServerExecuteResponse) => void,
    /** A row action's `config` / `context`, so "Open" on a row opens the target
     *  recipe already filled with that row's id. */
    prefill?: { config?: Record<string, unknown>; context?: Record<string, unknown> },
  ) => void;
  /** R22 list→detail — the `#packs/<slug>` deep-link segment. Opens that pack's
   *  DETAIL view on mount; the panel resyncs the hash as the selection changes
   *  (via `replaceState`, so in-page navigation never remounts). */
  initialPackSlug?: string;
  /** R22 list→detail — called with the new `#packs/<slug>` (or bare `#packs`)
   *  hash AFTER a successful in-page `replaceState`. The shell router uses it to
   *  keep its cached `activeHash` in lockstep with the in-page selection, so a
   *  later hashchange to the PREVIOUSLY-shown slug isn't dropped as a same-hash
   *  no-op. (Closes the R16 replaceState-doesn't-fire-hashchange desync; recipes/
   *  data share the gap — a uniform shell fix is a separate follow-up.) */
  onHashSync?: (hash: string) => void;
  subscribe?: BroadcastSubscriber['on'];
}

export interface PacksRoute {
  packsPanel(): PacksPanelMount | null;
  cliGrantDialog(): CliGrantDialogMount | null;
  whenLoaded(): Promise<void>;
  hasInFlightWork(): boolean;
  inFlightWorkPrompt(): string | null;
  hasUnsavedChanges(): boolean;
  unsavedChangesPrompt(): string | null;
  getRecoveryContextFreshness(): 'current' | 'unavailable';
  /** Re-read the roster while preserving only the broad Packs landing. */
  retryRecoveryContext?(): Promise<void>;
  dispose(): void;
}

const appendUnavailable = (
  doc: Document,
  host: HTMLElement,
  text: string,
): void => {
  const unavailable = doc.createElement('div');
  unavailable.setAttribute(PACKS_ROUTE_UNAVAILABLE_ATTR, '');
  unavailable.textContent = text;
  host.appendChild(unavailable);
};

/** Add-a-pack (2026-07-01) — parse the "Add a pack" input into a marketplace
 *  slug or a direct URL. Mirrors `resolveRecipeInput` (marketplace client) but
 *  for the `/packs/` route + lives HERE so the webclient never imports
 *  `@recued/marketplace` (role-boundary lint). Recognises:
 *    - `pack-slug`                                   → `{ slug }`
 *    - `recued.com/packs/pack-slug[.json]`           → `{ slug }`
 *    - `https://recued.com/marketplace/packs/slug`   → `{ slug }`
 *    - `https://example.com/pack.json`               → `{ url }` (local import — deferred)
 *  Empty / unparseable → `null`. Pure + exported for unit tests. */
export const resolvePackInput = (
  input: string,
): { slug: string } | { url: string } | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Marketplace pack URL (apex root or legacy /marketplace prefix) → slug.
  const webUrl = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?recued2?\.com(?:\/marketplace)?\/packs\/([a-z0-9][a-z0-9-]*[a-z0-9])(?:\.json)?$/i,
  );
  if (webUrl) return { slug: webUrl[1] };
  // Any other full URL → pass through (an arbitrary/local JSON — the local-import
  // path is deferred, so the resolve caller surfaces it as an unsupported failure).
  if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };
  // Bare slug (alphanumeric + hyphens).
  if (/^[a-z0-9][a-z0-9-]*[a-z0-9]$/i.test(trimmed)) return { slug: trimmed };
  // Contains a dot but no scheme → treat as a URL.
  if (trimmed.includes('.')) return { url: `https://${trimmed}` };
  // Single short token → slug.
  return { slug: trimmed };
};

export const bootstrapPacksRoute = (
  opts: BootstrapPacksRouteOptions,
): PacksRoute => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapPacksRoute: no document available - pass `opts.document` for non-browser environments',
    );
  }

  if (doc.head.querySelector(`style[${PACKS_ROUTE_STYLES_MARKER}]`) === null) {
    const style = doc.createElement('style');
    style.setAttribute(PACKS_ROUTE_STYLES_MARKER, '');
    style.textContent = PACKS_ROUTE_STYLES;
    doc.head.appendChild(style);
  }

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(PACKS_ROUTE_HOST_ATTR, '');

  const header = doc.createElement('header');
  header.className = 'packs-route-header';
  const heading = doc.createElement('h1');
  heading.className = 'packs-route-title';
  heading.setAttribute(PACKS_ROUTE_HEADING_ATTR, '');
  heading.textContent = 'Packs';
  header.appendChild(heading);
  const subtitle = doc.createElement('p');
  subtitle.className = 'packs-route-subtitle';
  subtitle.textContent =
    'Install capabilities, review their access, and keep local tools ready.';
  header.appendChild(subtitle);
  routeRoot.appendChild(header);

  // ── The install-time cli grant dialog ────────────────────────────────
  // Mounted (on the route root, floats over the Packs section) only when
  // installs can happen AND the cli.reachability universe + set callers are
  // wired — the dialog reads the universe to diff new tools and writes the
  // owner's reachability cells. Idle until an install adds a cli tool; mounting
  // just registers the overlay controller.
  let cliGrantDialog: CliGrantDialogMount | null = null;
  if (
    opts.packsInstallCaller !== undefined
    && opts.localToolsUniverseCaller !== undefined
    && opts.localToolsSetCaller !== undefined
  ) {
    cliGrantDialog = mountCliGrantDialog({
      host: routeRoot,
      document: doc,
      runUniverse: opts.localToolsUniverseCaller,
      runSet: opts.localToolsSetCaller,
    });
  }

  // The install caller the Packs panel actually runs: when the cli grant dialog
  // is wired, snapshot the cli universe alongside the install, run it, then (on
  // success) pop the dialog for any cli tool the install added. The snapshot is
  // kicked off CONCURRENTLY (not awaited before the install) so a hung/slow
  // universe read can never stall the install itself nor delay the caller's
  // return — the dialog just won't open. Fired via `.then` after success, so the
  // Packs panel closes + refreshes immediately and the overlay floats
  // independently. `snapshot()` swallows its own errors (resolves null), so
  // `beforeP` never rejects. When the dialog isn't wired, the raw caller passes
  // through. `const` locals (not the `opts.*` properties) so the narrowing
  // carries into the closure.
  const rawInstallCaller = opts.packsInstallCaller;
  const grantDialog = cliGrantDialog;
  const runInstallWithGrant: PacksInstallCaller | undefined =
    rawInstallCaller !== undefined && grantDialog !== null
      ? async (args) => {
          const beforeP = grantDialog.snapshot();
          const res = await rawInstallCaller(args);
          if (res.result.ok) {
            void beforeP.then((before) => {
              if (before !== null) void grantDialog.openForNewTools(before);
            });
          }
          return res;
        }
      : opts.packsInstallCaller;

  // Add-a-pack (2026-07-01) — the same cli-grant-after-install wrap for the
  // install-BY-SLUG path, so a marketplace pack that adds a local-binary tool
  // pops the reachability grant dialog exactly like a bundled install does.
  const rawInstallBySlugCaller = opts.packsInstallBySlugCaller;
  const runInstallBySlugWithGrant: PacksInstallBySlugCaller | undefined =
    rawInstallBySlugCaller !== undefined && grantDialog !== null
      ? async (args) => {
          const beforeP = grantDialog.snapshot();
          const res = await rawInstallBySlugCaller(args);
          if (res.result.ok) {
            void beforeP.then((before) => {
              if (before !== null) void grantDialog.openForNewTools(before);
            });
          }
          return res;
        }
      : opts.packsInstallBySlugCaller;

  // ── Packs section (browse → detail) ──────────────────────────────────
  // No subheading — the route's "Packs" heading sits directly above, and this
  // now fronts the whole browse corpus (catalog ∪ installed roster), so an
  // "Installed packs" title would read both redundant AND inaccurate.
  const packsSection = doc.createElement('section');
  packsSection.className = 'packs-route-section';
  packsSection.setAttribute(PACKS_ROUTE_PACKS_SECTION_ATTR, '');

  let packs: PacksPanelMount | null = null;
  let packsSurface: PacksSurfaceMount | null = null;
  if (opts.packsListCaller !== undefined) {
    const packsListCaller = opts.packsListCaller;
    const packsHost = doc.createElement('div');
    packsSection.appendChild(packsHost);
    // R22 list→detail — mirror the recipes/data hash-sync: on an in-page
    // selection change the surface calls back here + we `replaceState` the
    // `#packs/<slug>` (or bare `#packs`) hash so the URL is addressable WITHOUT
    // a remount (a link/refresh to a different slug still remounts via
    // `initialPackSlug`). Non-fatal on failure — addressability degrades to
    // in-page-only.
    /** ⛔⛔ OPENING A DETAIL IS A PLACE, SO IT PUSHES. `replaceState` for the whole
     *  list→detail transition OVERWROTE the `#packs` entry, so the native Back button
     *  skipped the list entirely and landed a level above it — the route the owner
     *  came from, not the one they could see.
     *  🔑 `pushState` emits no `hashchange` either, so the reason `replaceState` was
     *  chosen here — in-page navigation must never remount — is fully preserved. The
     *  only difference is that Back now has somewhere to go.
     *  ⚠ Only ENTERING a detail pushes. Closing one back to the bare list replaces, or
     *  a list→detail→list round trip would leave two entries and Back would bounce the
     *  owner into the detail they just closed. */
    let syncedPackSlug: string | null = null;
    const syncPacksHash = (slug: string | null): void => {
      const history = doc.defaultView?.history;
      if (history?.replaceState === undefined) return;
      const nextHash = serializeShellRoute('packs', slug ?? undefined);
      const entering = slug !== null && syncedPackSlug === null;
      try {
        if (entering && typeof history.pushState === 'function') {
          history.pushState(null, '', nextHash);
        } else {
          history.replaceState(null, '', nextHash);
        }
      } catch {
        // URL unchanged → do NOT desync the router's activeHash from it.
        return;
      }
      syncedPackSlug = slug;
      // The URL changed in-page without a hashchange event; tell the router so
      // its cached activeHash tracks the live selection.
      opts.onHashSync?.(nextHash);
    };
    // Unified surface: the browse list (discover, union corpus) → the detail
    // (packs panel, detail-only). A row opens the detail; the detail's install /
    // uninstall / grants live in the panel; the two children stay mounted across
    // the toggle so browse state survives.
    packsSurface = mountPacksSurface({
      root: packsHost,
      document: doc,
      // The shell main owns route scrolling; list/detail are nested below it.
      // Name it explicitly so a deep browse position can survive the detail.
      scrollRoot: opts.root,
      mountList: (host, onSelect) =>
        mountPackDiscovery({
          host,
          document: doc,
          onSelect,
          listInstalled: packsListCaller,
          ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
        }),
      mountDetail: (host, onSelectSlug) => {
        packs = mountPacksPanel({
          host,
          document: doc,
          runList: packsListCaller,
          onSelectSlug,
          ...(opts.initialPackSlug !== undefined
            ? { initialSlug: opts.initialPackSlug }
            : {}),
          ...(runInstallWithGrant !== undefined
            ? { runInstall: runInstallWithGrant }
            : {}),
          ...(opts.packsUninstallCaller !== undefined
            ? { runUninstall: opts.packsUninstallCaller }
            : {}),
          ...(opts.supervisionListCaller !== undefined
            ? { runSupervisionList: opts.supervisionListCaller }
            : {}),
          ...(opts.supervisionSetCaller !== undefined
            ? { runSupervisionSet: opts.supervisionSetCaller }
            : {}),
          // Reuse the Local-tools reachability universe caller so a daemon row
          // can show "not installed" + gate Start/Auto when its binary isn't on PATH.
          ...(opts.localToolsUniverseCaller !== undefined
            ? { runReachabilityUniverse: opts.localToolsUniverseCaller }
            : {}),
          ...(opts.connectionsListCaller !== undefined
            ? { runConnectionList: opts.connectionsListCaller }
            : {}),
          // R3 — by-PACK Access. The contracts list prefers the dedicated caller
          // (its flag family matches grant read/write/catalog) and falls back to
          // the local-tools copy; cli list/set REUSE the local-tools callers
          // (same rpcs); the grant read/write + catalog callers are new.
          ...(opts.accessContractsCaller !== undefined
            || opts.localToolsContractsCaller !== undefined
            ? {
                runListContracts:
                  opts.accessContractsCaller ?? opts.localToolsContractsCaller,
              }
            : {}),
          ...(opts.sellerOverviewCaller !== undefined
            ? { runSellerOverview: opts.sellerOverviewCaller }
            : {}),
          // ── Use tab ──
          ...(opts.recipesListCaller !== undefined
            ? { runRecipeList: opts.recipesListCaller }
            : {}),
          ...(opts.recipeExecuteCaller !== undefined
            ? { runRecipeExecute: opts.recipeExecuteCaller }
            : {}),
          ...(opts.fileReadCaller !== undefined
            ? { runFileRead: opts.fileReadCaller }
            : {}),
          ...(opts.recordRefSearchCaller !== undefined
            ? { runRecordRefSearch: opts.recordRefSearchCaller }
            : {}),
          // The app view owns the result lifecycle: a task's returned output
          // replaces the launcher with a receipt/detail, and returning from a
          // successful write refreshes the open browse view.
          ...(opts.openRunModal !== undefined
            ? { openRunModal: opts.openRunModal }
            : {}),
          ...(opts.contractGrantReadCaller !== undefined
            ? { runContractGrantRead: opts.contractGrantReadCaller }
            : {}),
          ...(opts.contractGrantWriteCaller !== undefined
            ? { runContractGrantWrite: opts.contractGrantWriteCaller }
            : {}),
          ...(opts.catalogOperationsCaller !== undefined
            ? { runCatalogOperations: opts.catalogOperationsCaller }
            : {}),
          ...(opts.ownerOperationInventoryCaller !== undefined
            ? { runOwnerOperationInventory: opts.ownerOperationInventoryCaller }
            : {}),
          ...(opts.ownerOperationListCaller !== undefined
            ? { runOwnerOperationList: opts.ownerOperationListCaller }
            : {}),
          ...(opts.ownerOperationUpsertCaller !== undefined
            ? { runOwnerOperationUpsert: opts.ownerOperationUpsertCaller }
            : {}),
          ...(opts.ownerOperationDeleteCaller !== undefined
            ? { runOwnerOperationDelete: opts.ownerOperationDeleteCaller }
            : {}),
          ...(opts.localToolsListCaller !== undefined
            ? { runCliReachabilityList: opts.localToolsListCaller }
            : {}),
          ...(opts.localToolsSetCaller !== undefined
            ? { runCliReachabilitySet: opts.localToolsSetCaller }
            : {}),
          // Resolve + install-by-slug (grant-wrapped) — a detail for a
          // marketplace pack (not bundled) resolves via these + installs by slug.
          ...(opts.packsResolveCaller !== undefined
            ? { runResolvePack: opts.packsResolveCaller }
            : {}),
          ...(opts.packsInstallPreviewCaller !== undefined
            ? { runInstallPreview: opts.packsInstallPreviewCaller }
            : {}),
          ...(runInstallBySlugWithGrant !== undefined
            ? { runInstallBySlug: runInstallBySlugWithGrant }
            : {}),
          ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
        });
        return packs;
      },
      ...(opts.initialPackSlug !== undefined
        ? { initialSlug: opts.initialPackSlug }
        : {}),
      onNavigate: syncPacksHash,
      // The Add-by-slug/URL affordance needs a resolve-capable host.
      enableAdd: opts.packsResolveCaller !== undefined,
    });
  } else {
    appendUnavailable(
      doc,
      packsSection,
      'Installing packs is not available on this server yet.',
    );
  }
  routeRoot.appendChild(packsSection);

  // No second section — the roster-wide "Local tools" grid is retired (header
  // note). Per-pack cli reachability lives in the detail's ACCESS section; the
  // per-contract view lives on `#contracts`.
  opts.root.appendChild(routeRoot);

  let disposed = false;
  return {
    packsPanel: () => packs,
    cliGrantDialog: () => cliGrantDialog,
    whenLoaded: () => packs?.whenLoaded() ?? Promise.resolve(),
    hasInFlightWork: () => packs?.hasInFlightWork() === true,
    inFlightWorkPrompt: () => packs?.hasInFlightWork() === true
      ? 'A pack action is still in progress. Leave Packs anyway?'
      : null,
    hasUnsavedChanges: () => packs?.hasUnsavedChanges() === true,
    unsavedChangesPrompt: () => packs?.hasUnsavedChanges() === true
      ? 'This pack result has unsaved table changes. Leave Packs anyway?'
      : null,
    getRecoveryContextFreshness: () =>
      packs !== null && packs.getListError() === null
        ? 'current'
        : 'unavailable',
    ...(packs !== null
      ? {
          retryRecoveryContext: async (): Promise<void> => {
            packs?.refresh();
            await packs?.whenLoaded();
          },
        }
      : {}),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Reverse of construction: Packs surface → cli grant dialog. The surface
      // owns BOTH the browse list + the detail panel, so disposing it tears both
      // down (don't also dispose `packs` — double-dispose).
      if (packsSurface !== null) packsSurface.dispose();
      if (cliGrantDialog !== null) cliGrantDialog.dispose();
      try {
        opts.root.removeChild(routeRoot);
      } catch {
        routeRoot.remove();
      }
    },
  };
};
