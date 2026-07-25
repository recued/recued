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
  byDateDesc,
  byNumberDesc,
  byStringAsc,
  type DiscoverSpec,
} from './discover-model.js';
import {
  DISCOVER_PANEL_STYLES,
  mountDiscoverPanel,
  type DiscoverBadge,
  type DiscoverPanelMount,
} from './discover-panel.js';
import {
  fetchPackCatalog,
  type CatalogPackRow,
  type CatalogResult,
} from './catalog-client.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';

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
  listInstalled: PackInstalledListCaller;
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

export const packSpec: DiscoverSpec<CatalogPackRow> = {
  searchableText: (r) =>
    `${r.name} ${r.description} ${r.tags.join(' ')} ${r.publisher_id} ${r.service_kind ?? ''}`,
  facets: [
    { key: 'service_kind', values: (r) => (r.service_kind !== undefined ? [r.service_kind] : []) },
    { key: 'pack_kind', values: (r) => (r.pack_kind !== '' ? [r.pack_kind] : []) },
    { key: 'tag', values: (r) => r.tags },
  ],
  sorters: {
    downloads: byNumberDesc((r) => r.download_count, (r) => r.slug),
    newest: byDateDesc((r) => r.created_at, (r) => r.slug),
    name: byStringAsc((r) => r.name),
  },
};

export const packBadges = (r: CatalogPackRow): DiscoverBadge[] => {
  const out: DiscoverBadge[] = [];
  if (r.publisher_certified === true) out.push({ label: '✓ Certified', tone: 'accent' });
  if (r.service_kind !== undefined) {
    out.push({ label: SERVICE_KIND_LABEL[r.service_kind] ?? r.service_kind, tone: 'muted' });
  }
  return out;
};

export const packMeta = (r: CatalogPackRow): string => {
  const parts = [r.publisher_id, `${r.download_count} install${r.download_count === 1 ? '' : 's'}`];
  parts.push(`${r.item_count} item${r.item_count === 1 ? '' : 's'}`);
  return parts.join(' · ');
};

export const mountPackDiscovery = (
  opts: MountPackDiscoveryOptions,
): { dispose: () => void; panel: DiscoverPanelMount } => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('mountPackDiscovery: no document available — pass opts.document');
  }
  ensureDiscoverStyles(doc);

  const fetchCatalog = opts.fetchCatalog ?? ((origin?: string) => fetchPackCatalog(origin !== undefined ? { origin } : {}));

  // Install-state lookup — a live-read indirection over `currentLookup` so the
  // FIRST render (before any `setInstalled`) already sees the version map the
  // union load builds, and a broadcast just swaps the closure + re-renders.
  let currentLookup: (slug: string) => number | null = () => null;
  // Last SUCCESSFUL roster — reused when a refresh's `packs.list` transiently
  // rejects (e.g. a broadcast-driven refresh racing a server hiccup) so the
  // install-state + roster-only rows keep their last-known values rather than
  // collapsing to "everything available" / dropping installed packs.
  let lastRoster: { packs: ReadonlyArray<RosterPack>; installed_versions?: ReadonlyArray<{ slug: string; version: number }> } | null = null;

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

  // The union load — the SINGLE corpus source the panel fetches on load /
  // refresh. Fetches the catalog + the roster together, rebuilds the install
  // lookup, and returns catalog ∪ roster-not-in-catalog. Offline-resilient: a
  // catalog fetch failure degrades to the roster-only corpus (status 'ok') so a
  // LAN-paired / offline webclient still lists the packs it has installed rather
  // than blanking to an error. Both failing surfaces the catalog error.
  const loadUnion = async (): Promise<CatalogResult<CatalogPackRow>> => {
    const [catalogRes, rosterRes] = await Promise.all([
      fetchCatalog(opts.origin),
      opts.listInstalled().catch(() => null),
    ]);
    // A successful roster fetch updates the last-known snapshot; a transient
    // failure falls back to it (never to an empty roster — that would regress
    // install-state on a refresh, showing installed packs as "Install").
    if (rosterRes !== null) lastRoster = rosterRes;
    const rosterSource = rosterRes ?? lastRoster;
    const roster = rosterSource?.packs ?? [];
    currentLookup = buildLookup(roster, rosterSource?.installed_versions);
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
    identity: (r) => r.slug,
    catalogVersion: (r) => r.version,
    installedVersion: (slug) => currentLookup(slug),
    onSelect: opts.onSelect,
    title: (r) => r.name,
    description: (r) => r.description,
    badges: packBadges,
    metaLine: packMeta,
    filterGroups: [
      { key: 'service_kind', label: 'Kind' },
      { key: 'pack_kind', label: 'Type' },
      { key: 'tag', label: 'Tag' },
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
    copy: { searchPlaceholder: 'Search packs…', kindPlural: 'packs' },
  });

  // A pack install / uninstall (from the detail, or another device) re-runs the
  // union — its badges flip AND a newly-installed pack absent from the catalog
  // joins the corpus (or a fully-uninstalled roster-only one drops out).
  const unsubs: Array<() => void> = [];
  if (opts.subscribe !== undefined) {
    unsubs.push(opts.subscribe('pack_installed', () => void panel.refresh()));
    unsubs.push(opts.subscribe('pack_uninstalled', () => void panel.refresh()));
  }

  return {
    panel,
    dispose: () => {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* teardown best-effort */
        }
      }
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
