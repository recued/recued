/** D-187 §6 follow-on — top-level Packs route.
 *
 *  Promotes the installed-packs surface out of Settings into its own
 *  `#packs` route (the drawer's `packs` seat graduates from a disabled
 *  "Soon" stub to a real link). Mirrors `connections/bootstrap-connections-route.ts`
 *  (D-174 P3): the panels still physically live under `settings/` — this route
 *  imports + composes them and supplies workspace chrome + caller forwarding.
 *
 *  Hosts two sections + one overlay:
 *   - the packs browse → detail surface (`mountPacksSurface`, D-182): the unified
 *     list over the catalog ∪ installed roster → the `#packs/<slug>` detail
 *     (install / uninstall / grants). Sits directly under the route's "Packs"
 *     heading — no redundant subheading (it fronts the whole browse corpus, not
 *     just installed packs).
 *   - "Local tools" — `mountLocalToolsPanel`, the per-tool contract × risk
 *     reachability grid (D-182 §7.2). It sits with Packs because the tools a
 *     pack installs are this grid's rows.
 *   - The install-time cli grant dialog (`mountCliGrantDialog`, D-182 §7.1) —
 *     idle until a pack install adds a local-binary tool, then pops a
 *     fail-closed reachability grant over the Packs section. `runInstallWithGrant`
 *     wraps the Packs install caller to fire it, which is WHY Packs + Local
 *     tools travel together (the dialog reads/writes the same reachability cells
 *     the Local tools grid edits).
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

import {
  PACKS_PANEL_STYLES,
  mountPacksPanel,
  type PacksInstallBySlugCaller,
  type PacksInstallCaller,
  type PacksListCaller,
  type PacksPanelMount,
  type PacksResolveCaller,
  type PacksUninstallCaller,
} from '../settings/packs-panel.js';
import type {
  SupervisionListCaller,
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
// R3 — the contract-grant callers the Access panel needs beyond the
// local-tools trio (cli list/set are structurally identical rpcs, reused
// below; the contracts list has a dedicated option because the local-tools
// copy is gated on a DIFFERENT feature flag).
import type {
  GrantCatalogOperationsCaller,
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
import {
  LOCAL_TOOLS_PANEL_STYLES,
  mountLocalToolsPanel,
  type LocalToolsContractsCaller,
  type LocalToolsListCaller,
  type LocalToolsPanelMount,
  type LocalToolsSetCaller,
  type LocalToolsUniverseCaller,
} from '../settings/local-tools-panel.js';
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
export const PACKS_ROUTE_LOCAL_TOOLS_SECTION_ATTR =
  'data-recued-packs-route-local-tools';
export const PACKS_ROUTE_UNAVAILABLE_ATTR =
  'data-recued-packs-route-unavailable';

const PACKS_ROUTE_CHROME_STYLES = `
[${PACKS_ROUTE_HOST_ATTR}] {
  /* Inherit the shell's light/dark tokens instead of hard-pinning light
     values, which would leave inner --surface-sunk elements dark-on-dark
     in dark mode (mirrors the connections route's visual-UX fix). */
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: clamp(18px, 3vw, 30px);
  color: var(--fg);
}
[${PACKS_ROUTE_HOST_ATTR}] .packs-route-header {
  display: grid;
  gap: 6px;
  margin-bottom: 22px;
}
[${PACKS_ROUTE_HOST_ATTR}] .packs-route-title {
  margin: 0;
}
[${PACKS_ROUTE_HOST_ATTR}] .packs-route-subtitle {
  max-width: 660px;
  margin: 0;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.55;
}
[${PACKS_ROUTE_HOST_ATTR}] .packs-route-section {
  display: grid;
  gap: 14px;
  margin: 18px 0;
}
[${PACKS_ROUTE_HOST_ATTR}] .packs-route-section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
[${PACKS_ROUTE_UNAVAILABLE_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--surface-subtle);
  color: var(--muted);
  font-size: 13px;
}
[${PACKS_ROUTE_LOCAL_TOOLS_SECTION_ATTR}] {
  margin-top: 28px;
  padding-top: 22px;
  border-top: 1px solid var(--border);
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
  LOCAL_TOOLS_PANEL_STYLES,
  CLI_GRANT_DIALOG_STYLES,
  CONNECTIONS_READINESS_STYLES,
  PACK_ACCESS_STYLES,
  // The unified surface (list↔detail toggle) + its browse-list panel styles.
  PACKS_SURFACE_STYLES,
  DISCOVER_PANEL_STYLES,
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
  localToolsUniverseCaller?: LocalToolsUniverseCaller;
  localToolsListCaller?: LocalToolsListCaller;
  localToolsSetCaller?: LocalToolsSetCaller;
  localToolsContractsCaller?: LocalToolsContractsCaller;
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
  /** `collection.contract.listContracts` — the Access panel's contract rows.
   *  Dedicated (rather than only riding {@link localToolsContractsCaller})
   *  because the local-tools copy gates on a DIFFERENT feature flag — a host
   *  with contracts enabled but local-tools disabled must still get the
   *  Access panel. Falls back to the local-tools caller when absent. */
  accessContractsCaller?: GrantContractsCaller;
  /** D-196 R6 — Seller tiers for the expanded install audience checklist. */
  sellerOverviewCaller?: () => Promise<import('@recued/contracts').SellerOverview>;
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
  localToolsPanel(): LocalToolsPanelMount | null;
  cliGrantDialog(): CliGrantDialogMount | null;
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
    const syncPacksHash = (slug: string | null): void => {
      const history = doc.defaultView?.history;
      if (history?.replaceState === undefined) return;
      const nextHash = serializeShellRoute('packs', slug ?? undefined);
      try {
        history.replaceState(null, '', nextHash);
      } catch {
        // URL unchanged → do NOT desync the router's activeHash from it.
        return;
      }
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
          ...(opts.contractGrantReadCaller !== undefined
            ? { runContractGrantRead: opts.contractGrantReadCaller }
            : {}),
          ...(opts.contractGrantWriteCaller !== undefined
            ? { runContractGrantWrite: opts.contractGrantWriteCaller }
            : {}),
          ...(opts.catalogOperationsCaller !== undefined
            ? { runCatalogOperations: opts.catalogOperationsCaller }
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

  // ── Local tools section ──────────────────────────────────────────────
  // The per-tool contract × risk reachability grid — which contracts may
  // trigger recipes that shell out to a local binary (whisper / ffmpeg /
  // magick / docling), and at what risk tier. Gated on the universe + list +
  // set trio; the contract-rows caller is independently optional (absent ⇒
  // Owner-only rows). `subscribe` keeps the contract rows live.
  const localToolsSection = doc.createElement('section');
  localToolsSection.className = 'packs-route-section';
  localToolsSection.setAttribute(PACKS_ROUTE_LOCAL_TOOLS_SECTION_ATTR, '');
  const localToolsHeading = doc.createElement('h2');
  localToolsHeading.className = 'packs-route-section-title';
  localToolsHeading.textContent = 'Local tools';
  localToolsSection.appendChild(localToolsHeading);

  let localTools: LocalToolsPanelMount | null = null;
  if (
    opts.localToolsUniverseCaller !== undefined
    && opts.localToolsListCaller !== undefined
    && opts.localToolsSetCaller !== undefined
  ) {
    const localToolsHost = doc.createElement('div');
    localToolsSection.appendChild(localToolsHost);
    localTools = mountLocalToolsPanel({
      host: localToolsHost,
      document: doc,
      runUniverse: opts.localToolsUniverseCaller,
      runList: opts.localToolsListCaller,
      runSet: opts.localToolsSetCaller,
      ...(opts.localToolsContractsCaller !== undefined
        ? { runListContracts: opts.localToolsContractsCaller }
        : {}),
      ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
    });
  } else {
    appendUnavailable(
      doc,
      localToolsSection,
      'Local tool reachability is not available on this server yet.',
    );
  }
  routeRoot.appendChild(localToolsSection);

  opts.root.appendChild(routeRoot);

  let disposed = false;
  return {
    packsPanel: () => packs,
    localToolsPanel: () => localTools,
    cliGrantDialog: () => cliGrantDialog,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Reverse of construction: Local tools → Packs surface → cli grant dialog.
      // The surface owns BOTH the browse list + the detail panel, so disposing it
      // tears both down (don't also dispose `packs` — double-dispose).
      if (localTools !== null) localTools.dispose();
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
