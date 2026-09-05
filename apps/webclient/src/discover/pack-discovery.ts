/** Discover — the `#packs` Discovery tab: browse the marketplace pack catalog +
 *  hand off installs to the existing consent flow.
 *
 *  Packs differ from recipes: a pack install carries permissions / body-grants /
 *  connection scope, so it can't be one-click. Rather than duplicate the vetted
 *  consent dialog, the Install / Update action HANDS OFF — it switches to the
 *  Installed tab and drives the packs panel's "Add a pack" resolve for the slug,
 *  which opens that dialog. The action reports `handedOff` so the card doesn't
 *  optimistically flip; the `pack_installed` broadcast → re-list → `setInstalled`
 *  flips it once the user confirms.
 *
 *  Install-state join reads installed versions from the SAME `packs.list` the
 *  Installed tab uses (no new rpc). It unions two sources `packs.list` returns:
 *  `packs[].installed` (BUNDLED corpus — recipe-bearing packs) + the
 *  `installed_versions` inventory array (EVERY installed pack, incl. a
 *  marketplace-published pack whose manifest isn't bundled on disk). So a
 *  marketplace-installed pack with a proper slug + version now reflects
 *  installed / upgrade-available here, joined against its `/catalog/packs.json`
 *  row (D-182).
 */

import {
  runDiscover,
  type DiscoverQuery,
} from './discover-model.js';
import {
  DISCOVER_PANEL_ACTION_ATTR,
  DISCOVER_PANEL_CARD_ATTR,
  DISCOVER_PANEL_PAGE_ATTR,
  DISCOVER_PANEL_SEARCH_ATTR,
  DISCOVER_PANEL_SORT_ATTR,
  DISCOVER_PANEL_STYLES,
  mountDiscoverPanel,
  type DiscoverBadge,
  type DiscoverPanelMount,
} from './discover-panel.js';
import {
  fetchPackCatalog,
  fetchPackSearch,
  type CatalogPackRow,
  type CatalogPageResult,
  type CatalogResult,
} from './catalog-client.js';
import { makeUpdateVersionResolver } from './update-versions.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import {
  readListContinuity,
  updateListContinuity,
  type ListPreviewContent,
} from '../shell/list-preview-continuity.js';

export const PACK_BROWSE_CONTINUITY_KEY = 'packs:browse';

interface PackBrowseContinuityFilter {
  readonly query: DiscoverQuery;
  readonly installedOnly: boolean;
}

/** One roster pack the union corpus + install-state join read. Only the display
 *  + join fields are used; `manifest` (present on `PackListEntry`) feeds the
 *  roster→catalog-row projection for a pack absent from the catalog. Kept
 *  structurally minimal so the caller can pass `PackListEntry` verbatim. */
export interface RosterPack {
  slug: string;
  /** Display fields — always present on a real `PackListEntry`; optional here so
   *  an install-state-only caller (the join needs just slug/version/installed)
   *  stays valid. A roster-only pack absent from the catalog projects with these
   *  (name falls back to the slug). */
  publisher?: string;
  name?: string;
  description?: string;
  version: number;
  installed: boolean;
  /** Installed at ANY version (owned), vs `installed` (owned at the disk
   *  version). True + `installed: false` = installed at a different version
   *  than the server bundle (usually the marketplace version is higher). */
  installed_any_version?: boolean;
  recipe_count?: number;
  /** D-145 PA10 — a foundation pack, auto-installed at every server boot rather
   *  than chosen. Carried so the row can SAY so: the owner who reported this saw
   *  four `Reception —` packs on a server they had installed nothing on, and the
   *  roster gave them no way to tell those from packs they picked. */
  pre_install?: boolean;
  /** The bundled manifest (bundled packs only) — its `service_kind` / `tags` /
   *  `pack_kind` project a roster-only pack into the browse corpus. */
  manifest?: {
    service_kind?: string;
    pack_kind?: string;
    tags?: ReadonlyArray<string>;
  };
}

/** `packs.list` caller. The union corpus reads `packs[]` (roster projection for
 *  a pack absent from the catalog + offline fallback) and the install-state join
 *  reads `installed` / `installed_any_version` / `installed_versions`. */
export type PackInstalledListCaller = () => Promise<{
  packs: ReadonlyArray<RosterPack>;
  installed_versions?: ReadonlyArray<{ slug: string; version: number }>;
}>;

export interface MountPackDiscoveryOptions {
  host: HTMLElement;
  document?: Document;
  /** Open a pack's `#packs/<slug>` detail — every card (body + action) opens the
   *  detail, which owns install / uninstall / grants (a pack install carries
   *  permissions so it can't be one-click). Navigate mode: no inline install. */
  onSelect: (slug: string) => void;
  /** Read-only card preview owned by the unified Packs surface. */
  onPreview?: (content: ListPreviewContent, opener: HTMLElement) => void;
  listInstalled: PackInstalledListCaller;
  /** D-259 — `packs.unrunnable`: installed packs this server's CURRENT validator
   *  would refuse. Optional; absent (or a failed read) ⇒ no "Needs update"
   *  badge, never a false one. ⚠ Read ONCE per mount alongside the roster, not
   *  per render: it is a server round-trip, and the condition only changes when
   *  a pack is installed or updated — both of which already re-list. */
  listUnrunnable?: () => Promise<{ findings: ReadonlyArray<{ slug: string }> }>;
  /** Server-side search (`/catalog/search?kind=pack`) — the browse path. When
   *  present the panel pages the catalogue from the server instead of
   *  downloading + reducing over the whole corpus; `fetchCatalog` becomes the
   *  offline / failure fallback. Injected in tests; defaults to the real
   *  endpoint (unless a corpus is injected — a self-contained test seam). */
  search?: (query: DiscoverQuery) => Promise<CatalogPageResult<CatalogPackRow>>;
  /** Resolve current catalogue versions for a bounded id set — drives BOTH the
   *  update badge (installed roster) and the pinned-row detection (a BUNDLED
   *  pack absent from the published catalogue is one the server never returns).
   *  Injected in tests; defaults to the real `/catalog/versions`. */
  fetchVersions?: (ids: readonly string[]) => Promise<
    | { status: 'ok'; versions: Map<string, number> }
    | { status: 'error'; message: string }
  >;
  fetchCatalog?: (origin?: string) => Promise<CatalogResult<CatalogPackRow>>;
  origin?: string;
  subscribe?: BroadcastSubscriber['on'];
}

/** Project a roster pack (bundled / marketplace-installed, from `packs.list`)
 *  into a browse-corpus row. Used for a pack ABSENT from the catalog — a bundle
 *  not yet seeded, or ANY installed pack when the catalog fetch fails (offline /
 *  LAN-paired), so the list never blanks to "installed packs you can't see".
 *  `download_count` / `created_at` are unknown locally (0 / '') — a roster-only
 *  row sorts last by installs, which is the honest ordering. */
export const projectRosterPackRow = (p: RosterPack): CatalogPackRow => ({
  slug: p.slug,
  publisher_id: p.publisher ?? '',
  name: p.name ?? p.slug,
  description: p.description ?? '',
  version: p.version,
  pack_kind: p.manifest?.pack_kind ?? '',
  ...(p.manifest?.service_kind !== undefined
    ? { service_kind: p.manifest.service_kind }
    : {}),
  tags: [...(p.manifest?.tags ?? [])],
  download_count: 0,
  item_count: p.recipe_count ?? 0,
  // The roster projection is a display/offline fallback, not the public
  // bundle-resolution authority. Only the marketplace catalog projects exact
  // pinned refs from its published manifest.
  recipe_refs: [],
  created_at: '',
});

/** Merge the catalog corpus with roster-projected rows for slugs the catalog
 *  doesn't carry (dedup by slug, catalog wins — it holds the canonical display
 *  + install counts + the latest version for the update badge). */
export const unionCorpus = (
  catalog: ReadonlyArray<CatalogPackRow>,
  roster: ReadonlyArray<RosterPack>,
): CatalogPackRow[] => {
  const inCatalog = new Set(catalog.map((r) => r.slug));
  const extra = roster
    .filter((p) => !inCatalog.has(p.slug))
    .map(projectRosterPackRow);
  return [...catalog, ...extra];
};

/** service_kind slug → human label for the filter chips. Unknown kinds fall
 *  through to the raw slug. */
const SERVICE_KIND_LABEL: Record<string, string> = {
  entity_platform: 'Platform',
  cli: 'CLI',
  workflow: 'Workflow',
  channel_door: 'Channel',
  reception: 'Reception',
};

// Lives in `discover-specs.ts` alongside `recipeSpec` — see the note there.
import { packSpec } from './discover-specs.js';

export { packSpec };

/** ⚠ `preInstall` IS A SLUG SET FROM THE LOCAL ROSTER, not a field on the row.
 *  The catalog does not carry `pre_install`, and once these packs are published
 *  they stop being pinned rows and arrive as ordinary catalog rows — so a badge
 *  read off the projection alone would vanish exactly when it publishes. The
 *  roster knows either way. */
/** ⚠ `unrunnable` IS ALSO A SLUG SET, AND FOR A SHARPER REASON THAN `preInstall`.
 *  It comes from `packs.unrunnable`, which RE-DERIVES the finding per call from
 *  the installed manifests — it is never stored. That is the whole point: a pack
 *  this server can no longer run is a STANDING CONDITION, true until fixed, so
 *  it must not be carried by anything that can be answered, dismissed, or go
 *  stale. D-259 previously delivered this as a durable ask; an answered ask
 *  cleared the finding while the pack stayed broken. A badge cannot. */
export const packBadges = (
  r: CatalogPackRow,
  preInstall?: ReadonlySet<string>,
  unrunnable?: ReadonlySet<string>,
): DiscoverBadge[] => {
  const out: DiscoverBadge[] = [];
  if (unrunnable?.has(r.slug) === true) {
    // First, and `danger`: it is the only badge here that says something is
    // WRONG rather than something is true. The others are provenance.
    out.push({
      label: 'Needs update',
      tone: 'danger',
      title: 'This pack no longer runs on this server — its actions fail until you update it.',
    });
  }
  if (preInstall?.has(r.slug) === true) {
    out.push({
      label: 'Included',
      tone: 'muted',
      title: 'Ships with Recued and installs itself on every server boot — you did not choose it.',
    });
  }
  if (r.publisher_certified === true) out.push({ label: '✓ Certified', tone: 'accent' });
  if (r.service_kind !== undefined) {
    out.push({ label: SERVICE_KIND_LABEL[r.service_kind] ?? r.service_kind, tone: 'muted' });
  }
  return out;
};

export const packMeta = (r: CatalogPackRow): string => {
  // Installs omitted at 0 — see `recipeMeta`: `download_count` has no writer, so
  // an unconditional chip asserted "0 installs" with nothing behind it.
  const parts = [r.publisher_id];
  if (r.download_count > 0) parts.push(`${r.download_count} install${r.download_count === 1 ? '' : 's'}`);
  parts.push(`${r.item_count} item${r.item_count === 1 ? '' : 's'}`);
  return parts.join(' · ');
};

export const mountPackDiscovery = (
  opts: MountPackDiscoveryOptions,
): {
  dispose: () => void;
  panel: DiscoverPanelMount;
  whenLoaded: () => Promise<void>;
  /** Toggle the installed-only view. Re-runs the current query, so the search
   *  box / sort / page the user already set carry across the switch. Calling it
   *  also marks the state user-owned, so the installed-first default stops
   *  re-deciding on later query runs. */
  setInstalledOnly: (on: boolean) => Promise<void>;
  /** Observe state the list decides for itself — the installed-first default,
   *  which can only be resolved once the roster has loaded. */
  onInstalledOnlyChange: (cb: (on: boolean) => void) => void;
} => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('mountPackDiscovery: no document available — pass opts.document');
  }
  ensureDiscoverStyles(doc);

  const remembered = readListContinuity<PackBrowseContinuityFilter>(
    doc,
    PACK_BROWSE_CONTINUITY_KEY,
  );
  const rememberedFilter = remembered?.filter;
  const hasRememberedFilter = rememberedFilter !== undefined
    && typeof rememberedFilter === 'object'
    && rememberedFilter !== null
    && typeof rememberedFilter.installedOnly === 'boolean'
    && typeof rememberedFilter.query === 'object'
    && rememberedFilter.query !== null;

  const browseFocusPatch = (): {
    readonly focusedId?: string;
    readonly focusKind?: string;
  } => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    if (active?.hasAttribute?.(DISCOVER_PANEL_SEARCH_ATTR) === true) {
      return { focusKind: 'search' };
    }
    if (active?.hasAttribute?.(DISCOVER_PANEL_SORT_ATTR) === true) {
      return { focusKind: 'sort' };
    }
    const page = active?.getAttribute?.(DISCOVER_PANEL_PAGE_ATTR) ?? null;
    if (page !== null) return { focusKind: 'pager', focusedId: page };
    const facet = active?.getAttribute?.('data-facet') ?? null;
    const value = active?.getAttribute?.('data-value') ?? null;
    if (facet !== null && value !== null) {
      return { focusKind: 'filter', focusedId: `${facet}\u0000${value}` };
    }
    const id = active?.getAttribute?.('data-id') ?? null;
    if (id !== null && active?.hasAttribute?.(DISCOVER_PANEL_ACTION_ATTR) === true) {
      return { focusKind: 'action', focusedId: id };
    }
    if (id !== null && active?.hasAttribute?.(DISCOVER_PANEL_CARD_ATTR) === true) {
      return { focusKind: 'card', focusedId: id };
    }
    return {};
  };

  const fetchCatalog = opts.fetchCatalog ?? ((origin?: string) => fetchPackCatalog(origin !== undefined ? { origin } : {}));

  // Server-side search is the browse path — unless a corpus is injected (a
  // self-contained test/private-mirror seam), matching the recipe surface. In
  // corpus mode `loadUnion` stays the load path and behaviour is unchanged.
  const searchFn = opts.search
    ?? (opts.fetchCatalog === undefined
      ? ((query: DiscoverQuery) =>
          fetchPackSearch(query, opts.origin !== undefined ? { origin: opts.origin } : {}))
      : undefined);
  const serverMode = searchFn !== undefined;

  // Install-state lookup — a live-read indirection over `currentLookup` so the
  // FIRST render (before any `setInstalled`) already sees the version map the
  // union load builds, and a broadcast just swaps the closure + re-renders.
  let currentLookup: (slug: string) => number | null = () => null;
  /** The `installed_versions` inventory from the last roster snapshot — the ONLY
   *  place a marketplace-installed pack (absent from `packs[]`) appears. */
  let installedInventory: ReadonlyArray<{ slug: string; version: number }> = [];
  // Last SUCCESSFUL roster — reused when a refresh's `packs.list` transiently
  // rejects (e.g. a broadcast-driven refresh racing a server hiccup) so the
  // install-state + roster-only rows keep their last-known values rather than
  // collapsing to "everything available" / dropping installed packs.
  let lastRoster: { packs: ReadonlyArray<RosterPack>; installed_versions?: ReadonlyArray<{ slug: string; version: number }> } | null = null;
  // Last-known bundled roster — the packs the server MIGHT not know about. Used
  // to detect the ones it definitely doesn't (pinned rows, below).
  let bundledRoster: ReadonlyArray<RosterPack> = [];

  /** Build the slug→installed-version map from a roster snapshot. A pack is
   *  installed when `installed` (owned at disk version) OR `installed_any_version`
   *  (owned at some other version). The AUTHORITATIVE version is the inventory
   *  (`installed_versions`) — `p.version` is the DISK BUNDLE version, which
   *  differs whenever the installed version isn't the bundle (e.g. an ADDITIVE
   *  marketplace upgrade that keeps `installed` true yet bumps the pack version).
   *  Fall back to `p.version` only with no inventory row (a foundation pack, or a
   *  best-effort write gap). A stale vendor-twin (neither installed nor owned) is
   *  skipped. Slug-keyed throughout ((slug, publisher) is a systemic follow-on).
   *
   *  KNOWN EDGE (documented, not fixed here): `recordPackInventory` is best-effort
   *  after recipes commit (`pack-install-handler.ts`), so a failed inventory write
   *  during an upgrade can leave a STALE version row → a transient phantom
   *  "update" until the next successful install — no worse than the pre-fix join,
   *  closing only via the atomic install-inventory follow-on. */
  const buildLookup = (
    packs: ReadonlyArray<RosterPack>,
    installed_versions?: ReadonlyArray<{ slug: string; version: number }>,
  ): ((slug: string) => number | null) => {
    const invBySlug = new Map((installed_versions ?? []).map((iv) => [iv.slug, iv.version] as const));
    const bundledSlugs = new Set(packs.map((p) => p.slug));
    const m = new Map<string, number>();
    for (const p of packs) {
      if (p.installed || p.installed_any_version === true) {
        m.set(p.slug, invBySlug.get(p.slug) ?? p.version);
      }
    }
    for (const iv of installed_versions ?? []) {
      if (bundledSlugs.has(iv.slug)) continue; // bundled slugs handled above
      m.set(iv.slug, iv.version);
    }
    return (slug) => m.get(slug) ?? null;
  };

  // Apply a roster snapshot: cache it, rebuild the install-state lookup, and (in
  // server mode) resolve catalogue versions for the bundled ∪ inventory slug set
  // — one bounded lookup that answers BOTH the update badge AND which bundled
  // packs the marketplace doesn't list (pinned, below). Installing a BUNDLED
  // pack doesn't grow that set, so the common case re-uses the memoised probe;
  // only a marketplace-pack install (a new inventory slug) re-probes.
  let panelRef: DiscoverPanelMount | null = null;
  const updates = serverMode
    ? makeUpdateVersionResolver({
        kind: 'pack',
        // Re-run the current query so the pinned set recomputes AND the badge
        // re-reads once versions land.
        onChange: () => void panelRef?.refresh(),
        ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
        ...(opts.fetchVersions !== undefined ? { fetchVersions: opts.fetchVersions } : {}),
      })
    : null;

  /** D-259 — installed packs the server's CURRENT validator would refuse.
   *
   *  ⚠ REFRESHED WITH THE ROSTER, NOT ONCE AT MOUNT, and awaited IN the same
   *  load so the set is populated before the first rows render. A fire-and-
   *  forget read set this after first paint, which meant the badge never
   *  appeared on the render that mattered.
   *
   *  ⛔ A FAILED READ CLEARS NOTHING. On error the previous set is KEPT rather
   *  than emptied: "I could not check" and "nothing is wrong" are different
   *  facts, and only one of them should remove a warning the owner has already
   *  seen. */
  let unrunnableSlugs: ReadonlySet<string> = new Set();
  const refreshUnrunnable = async (): Promise<void> => {
    if (opts.listUnrunnable === undefined) return;
    try {
      const res = await opts.listUnrunnable();
      unrunnableSlugs = new Set(res.findings.map((f) => f.slug));
    } catch { /* keep the last-known set — see above */ }
  };

  const applyRoster = (
    src: { packs: ReadonlyArray<RosterPack>; installed_versions?: ReadonlyArray<{ slug: string; version: number }> } | null,
  ): ReadonlyArray<RosterPack> => {
    const roster = src?.packs ?? [];
    bundledRoster = roster;
    installedInventory = src?.installed_versions ?? [];
    currentLookup = buildLookup(roster, src?.installed_versions);
    const ids = [
      ...roster.map((p) => p.slug),
      ...(src?.installed_versions ?? []).map((iv) => iv.slug),
    ];
    void updates?.resolve(ids);
    return roster;
  };

  /** Fetch the roster fresh (broadcast / return-visit path). A transient
   *  `packs.list` failure falls back to the last-known snapshot — never to an
   *  empty roster, which would regress install-state on a refresh. */
  const refreshRoster = async (): Promise<ReadonlyArray<RosterPack>> => {
    const [rosterRes] = await Promise.all([
      opts.listInstalled().catch(() => null),
      refreshUnrunnable(),
    ]);
    if (rosterRes !== null) lastRoster = rosterRes;
    return applyRoster(rosterRes ?? lastRoster);
  };

  // Load the roster once before the first server render so install-state is
  // right from the start (the panel reads `currentLookup` live); later calls
  // reuse it. A broadcast forces a fresh fetch via `refreshRoster`.
  /** "Installed only" view. The `[Installed | Discover]` tab split was retired
   *  for one unified list, and install state became a per-row badge — but nothing
   *  replaced the TAB, so on a 954-pack corpus finding your own packs meant
   *  scanning badges page by page.
   *
   *  🔑 It cannot be a facet. Browse runs in SERVER mode: the marketplace pages
   *  the rows and computes the facet counts, and the marketplace cannot know what
   *  this server has installed. So the toggle swaps the SOURCE instead — the
   *  roster `packs.list` already loads for the badges, searched by the same local
   *  engine the pinned strip uses, so search / sort / facets keep working over it. */
  let installedOnly = hasRememberedFilter
    ? rememberedFilter.installedOnly
    : false;
  /** The user pressed the toggle themselves — stop auto-deciding for them. Without
   *  this, any later re-run of the query (a `pack_installed` broadcast, a search
   *  keystroke) would re-apply the default and yank them back out of the
   *  marketplace they deliberately opened. */
  let installedOnlyUserSet = hasRememberedFilter;
  let installedOnlyDefaulted = false;
  let installedOnlyListener: ((on: boolean) => void) | null = null;
  /** 🔑 Your own packs are the DEFAULT view, not a filter you re-apply on every
   *  visit. Browsing a marketplace is occasional; reaching for a pack you already
   *  installed is daily, and making the daily case the one that costs a click had
   *  it backwards.
   *
   *  Decided here rather than at mount because it depends on the roster, and the
   *  roster is only guaranteed loaded at this point (the first search awaits it).
   *  A server with nothing installed still opens on the marketplace — defaulting
   *  to an empty list would be a worse first run than no default at all. */
  const applyInstalledFirstDefault = (): void => {
    if (installedOnlyDefaulted || installedOnlyUserSet) return;
    installedOnlyDefaulted = true;
    if (installedRosterRows().length === 0) return;
    installedOnly = true;
    installedOnlyListener?.(true);
    const query = panelRef?.getQuery();
    if (query !== undefined) {
      updateListContinuity(doc, PACK_BROWSE_CONTINUITY_KEY, {
        filter: { query, installedOnly },
      });
    }
  };
  let rosterLoad: Promise<ReadonlyArray<RosterPack>> | null = null;
  const ensureRoster = (): Promise<ReadonlyArray<RosterPack>> => {
    if (rosterLoad === null) rosterLoad = refreshRoster();
    return rosterLoad;
  };

  /** The packs this server actually HAS, as browse rows.
   *
   *  ⛔ `bundledRoster` is NOT that set. `packs.list` returns the whole bundled
   *  corpus — ~950 rows, each carrying its own `installed` flag — so handing it
   *  to the filter unchanged showed every pack on the disk and reported the
   *  corpus size as the result count. The toggle looked like it did nothing
   *  because, apart from swapping the data source, it did nothing.
   *
   *  `currentLookup` is the authority, not `p.installed`: it already unions the
   *  bundled flags (`installed` OR `installed_any_version` — owned at a
   *  DIFFERENT version still counts as owned) with the `installed_versions`
   *  inventory, and it is the same oracle that draws the per-row badges. Reusing
   *  it means the filter and the badge can never disagree.
   *
   *  Inventory-only slugs — marketplace packs absent from `packs[]` entirely —
   *  are synthesized, because they are exactly the ones a corpus scan cannot
   *  find. `RosterPack` allows the display fields to be absent; the projection
   *  falls back to the slug. */
  const installedRosterRows = (): CatalogPackRow[] => {
    const rows = bundledRoster
      .filter((p) => currentLookup(p.slug) !== null)
      .map(projectRosterPackRow);
    const listed = new Set(bundledRoster.map((p) => p.slug));
    for (const iv of installedInventory) {
      if (listed.has(iv.slug)) continue;
      rows.push(projectRosterPackRow({
        slug: iv.slug,
        version: iv.version,
        installed: true,
      }));
    }
    return rows;
  };

  /** Bundled packs the marketplace catalogue doesn't carry — projected as
   *  browse rows. A published pack's slug is present in the versions map; an
   *  absent one is unpublished, so the server search will never return it and it
   *  would silently vanish from Discover. `null` map (probe not yet landed /
   *  failed) → none yet; they pop in on the probe's `onChange` refresh. */
  /** Slugs the SERVER pre-installed. Read live off the roster so it is correct
   *  before and after those packs reach the catalog. */
  const preInstallSlugs = (): ReadonlySet<string> =>
    new Set(bundledRoster.filter((p) => p.pre_install === true).map((p) => p.slug));


  const pinnedCandidates = (): CatalogPackRow[] => {
    const map = updates?.read();
    if (map === null || map === undefined) return [];
    return bundledRoster
      .filter((p) => !map.has(p.slug))
      .map(projectRosterPackRow);
  };

  // The union load — the fallback corpus source (offline / a failed search).
  // Fetches the catalog + roster together and returns catalog ∪ roster-not-in-
  // catalog. Offline-resilient: a catalog failure degrades to the roster-only
  // corpus so a LAN-paired webclient still lists its installed packs.
  const loadUnion = async (): Promise<CatalogResult<CatalogPackRow>> => {
    const [catalogRes, rosterRes] = await Promise.all([
      fetchCatalog(opts.origin),
      opts.listInstalled().catch(() => null),
      refreshUnrunnable(),
    ]);
    if (rosterRes !== null) lastRoster = rosterRes;
    const roster = applyRoster(rosterRes ?? lastRoster);
    if (catalogRes.status === 'ok') {
      return { status: 'ok', rows: unionCorpus(catalogRes.rows, roster) };
    }
    // Catalog unreachable — fall back to the roster-only corpus (never blank).
    if (roster.length > 0) {
      return { status: 'ok', rows: roster.map(projectRosterPackRow) };
    }
    return catalogRes; // both empty/failed → surface the catalog error
  };

  const panel = mountDiscoverPanel<CatalogPackRow>({
    host: opts.host,
    document: doc,
    spec: packSpec,
    fetchCatalog: loadUnion,
    ...(searchFn !== undefined
      ? {
          search: async (query: DiscoverQuery) => {
            // Install-state must be ready before the first page renders, so the
            // roster load blocks the first search only (memoised thereafter).
            await ensureRoster();
            applyInstalledFirstDefault();
            // Installed-only — answer from the roster, never the marketplace. The
            // roster IS the complete set of installed packs, so this is exact
            // rather than "the installed ones that happen to be on this page".
            if (installedOnly) {
              const local = runDiscover(installedRosterRows(), packSpec, query);
              return {
                status: 'ok' as const,
                page: {
                  rows: local.pageRows,
                  total: local.total,
                  totalPages: local.totalPages,
                  page: local.page,
                  facets: local.facets,
                },
              };
            }
            const res = await searchFn(query);
            if (res.status !== 'ok') return { status: 'error' as const, message: res.message };
            // Pinned: the bundled-but-unpublished packs that match THIS query.
            // Run them through the SAME engine the server reproduces, over their
            // bounded set, so their search/facet behaviour matches the page.
            // Only on page 1 — they're a featured strip atop the first page of
            // results (they have no rank among catalogue rows), not a header
            // repeated on every deep page.
            const cands = res.page.page <= 1 ? pinnedCandidates() : [];
            const pinnedMatched = cands.length > 0
              ? runDiscover(cands, packSpec, query).matched
              : [];
            // Defensive dedupe: an unpublished pack should never be in the server
            // page, but never show a slug twice if that assumption ever breaks.
            const pageSlugs = new Set(res.page.rows.map((r) => r.slug));
            const pinned = pinnedMatched.filter((r) => !pageSlugs.has(r.slug));
            return { status: 'ok' as const, page: { ...res.page, pinned } };
          },
        }
      : {}),
    ...(updates !== null ? { updateVersions: () => updates.read() } : {}),
    identity: (r) => r.slug,
    catalogVersion: (r) => r.version,
    installedVersion: (slug) => currentLookup(slug),
    onSelect: opts.onSelect,
    ...(opts.onPreview !== undefined
      ? {
          onPreview: (row: CatalogPackRow, opener: HTMLElement) => {
            opts.onPreview?.({
              id: row.slug,
              eyebrow: 'Pack preview',
              title: row.name,
              summary: row.description,
              facts: [
                { label: 'Publisher', value: row.publisher_id },
                { label: 'Version', value: `v${row.version}` },
                {
                  label: 'Kind',
                  value: SERVICE_KIND_LABEL[row.service_kind ?? '']
                    ?? row.service_kind
                    ?? row.pack_kind,
                },
                {
                  label: 'Contents',
                  value: `${row.item_count} item${row.item_count === 1 ? '' : 's'}`,
                },
                {
                  label: 'Installs',
                  value: row.download_count.toLocaleString(),
                },
              ],
              primaryLabel: 'Open pack',
            }, opener);
          },
        }
      : {}),
    ...(hasRememberedFilter ? { initialQuery: rememberedFilter.query } : {}),
    onQueryChange: (query) => {
      updateListContinuity(doc, PACK_BROWSE_CONTINUITY_KEY, {
        filter: { query, installedOnly },
        ...browseFocusPatch(),
      });
    },
    title: (r) => r.name,
    description: (r) => r.description,
    badges: (r) => packBadges(r, preInstallSlugs(), unrunnableSlugs),
    metaLine: packMeta,
    filterGroups: [
      { key: 'service_kind', label: 'Kind' },
      { key: 'pack_kind', label: 'Type' },
    ],
    sortOptions: [
      { key: 'downloads', label: 'Most installed' },
      { key: 'newest', label: 'Newest' },
      { key: 'name', label: 'Name' },
    ],
    facetLabel: (key, value) =>
      key === 'service_kind' ? (SERVICE_KIND_LABEL[value] ?? value) : value,
    // Navigate mode owns every click → the detail; inline install never runs.
    install: { label: 'Install', run: async () => ({ ok: true as const, handedOff: true }) },
    copy: { searchPlaceholder: 'Search packs…', kindPlural: 'packs', pinnedLabel: 'On this server' },
  });
  panelRef = panel;

  // A pack install / uninstall (from the detail, or another device) re-fetches
  // the roster (flipping install-state, re-probing versions if the inventory
  // grew) and re-runs the browse so a newly-installed pack absent from the
  // catalog joins as a pinned row (or a fully-uninstalled one drops out).
  const onBroadcast = (): void => {
    if (serverMode) void refreshRoster();
    void panel.refresh();
  };
  const unsubs: Array<() => void> = [];
  if (opts.subscribe !== undefined) {
    unsubs.push(opts.subscribe('pack_installed', onBroadcast));
    unsubs.push(opts.subscribe('pack_uninstalled', onBroadcast));
  }

  return {
    panel,
    whenLoaded: async () => {
      await panel.whenLoaded();
      const focusKind = remembered?.focusKind;
      const focusedId = remembered?.focusedId;
      let target: HTMLElement | null = null;
      if (focusKind === 'search') {
        target = opts.host.querySelector?.(
          `[${DISCOVER_PANEL_SEARCH_ATTR}]`,
        ) as HTMLElement | null;
      } else if (focusKind === 'sort') {
        target = opts.host.querySelector?.(
          `[${DISCOVER_PANEL_SORT_ATTR}]`,
        ) as HTMLElement | null;
      } else if (focusKind === 'pager' && focusedId !== undefined) {
        target = Array.from(opts.host.querySelectorAll?.(
          `[${DISCOVER_PANEL_PAGE_ATTR}]`,
        ) ?? []).find((candidate) =>
          candidate.getAttribute(DISCOVER_PANEL_PAGE_ATTR) === focusedId,
        ) as HTMLElement | undefined ?? null;
      } else if (focusKind === 'filter' && focusedId !== undefined) {
        const [facet, value] = focusedId.split('\u0000', 2);
        target = Array.from(opts.host.querySelectorAll?.('[data-facet]') ?? [])
          .find((candidate) =>
            candidate.getAttribute('data-facet') === facet
            && candidate.getAttribute('data-value') === value,
          ) as HTMLElement | undefined ?? null;
      }
      const fallback = opts.host.querySelector?.(
        `[${DISCOVER_PANEL_SEARCH_ATTR}]`,
      ) as HTMLElement | null | undefined;
      (target ?? fallback)?.focus?.({ preventScroll: true });
    },
    /** Register for state the LIST decides on its own — today only the
     *  installed-first default, which is resolved after the roster lands and so
     *  cannot be known by the host at mount time. The host owns the toggle's
     *  appearance; this is how it learns the toggle started pressed. */
    onInstalledOnlyChange: (cb: (on: boolean) => void): void => {
      installedOnlyListener = cb;
      if (hasRememberedFilter) cb(installedOnly);
    },
    setInstalledOnly: async (on: boolean): Promise<void> => {
      installedOnlyUserSet = true;
      if (installedOnly === on) {
        updateListContinuity(doc, PACK_BROWSE_CONTINUITY_KEY, {
          filter: { query: panel.getQuery(), installedOnly },
        });
        return;
      }
      const previous = installedOnly;
      installedOnly = on;
      // The roster must be loaded before the first installed-only page, and
      // `refresh()` re-runs the CURRENT query so the user's search / sort / page
      // survive the switch.
      try {
        await ensureRoster();
        await panel.refresh();
        updateListContinuity(doc, PACK_BROWSE_CONTINUITY_KEY, {
          filter: { query: panel.getQuery(), installedOnly },
        });
      } catch (error) {
        installedOnly = previous;
        throw error;
      }
    },
    dispose: () => {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* teardown best-effort */
        }
      }
      updates?.dispose();
      panel.dispose();
    },
  };
};

const DISCOVER_STYLES_MARKER = 'data-recued-discover-panel-styles';
const ensureDiscoverStyles = (doc: Document): void => {
  if (doc.head?.querySelector?.(`style[${DISCOVER_STYLES_MARKER}]`) != null) return;
  const style = doc.createElement('style');
  style.setAttribute(DISCOVER_STYLES_MARKER, '');
  style.textContent = DISCOVER_PANEL_STYLES;
  doc.head?.appendChild?.(style);
};
