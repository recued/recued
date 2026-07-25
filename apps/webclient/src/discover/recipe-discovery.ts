/** Discover — the `#recipes` Discovery tab: browse the marketplace recipe
 *  catalog + install standalone recipes (with a hard-dependency consent step).
 *
 *  A recipe without `metadata.recipe_bundle` installs independently through
 *  `recipe.installBySlug`; its Tier-P `depends_on` packs still use the existing
 *  co-install consent dialog. A recipe with `recipe_bundle` instead opens the
 *  directly named pack detail/consent flow. Missing or drifted bundle packs
 *  fail closed and never fall back to installing only one recipe.
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
  fetchPackCatalog as fetchMarketplacePackCatalog,
  fetchRecipeCatalog,
  type CatalogPackRow,
  type CatalogRecipeRow,
  type CatalogResult,
} from './catalog-client.js';
import {
  mountRecipeInstallDialog,
  RECIPE_DIALOG_STYLES,
  type RecipeInstallDialogMount,
} from './recipe-install-dialog.js';
import {
  missingDeps,
  recipeRequiredPacks,
  resolveRecipeDeps,
  type DepPackInfo,
} from '../recipes/required-packs.js';
import { INSTALL_GRANT_PICKER_STYLES } from '../settings/install-grant-picker.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import {
  resolveRecipeBundleInstallPack,
  type BulkPackManifest,
  type InstallGrantSelection,
} from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

/** `recipe.installBySlug` caller (the registry result shape). */
export type RecipeInstallBySlugCaller = (slug: string) => Promise<{
  result:
    | { ok: true; recipe_id: string; version: number }
    | { ok: false; failure: { code: string; message: string; pack_slug?: string } };
}>;

/** `recipe.list` caller — only the join fields are read. */
export type RecipeInstalledListCaller = () => Promise<{
  recipes: ReadonlyArray<{ recipe_id: string; version: number }>;
}>;

/** `packs.list` caller — the deps box's dependency roster (install-state +
 *  name + permissions + type per pack). Only the read fields are typed. The
 *  full `manifest` rides along (the rpc returns it) so a connection-backed dep
 *  can derive its §7.1/§7.2 grant picker in the consent dialog. */
export type RecipePackRosterCaller = () => Promise<{
  packs: ReadonlyArray<{
    slug: string;
    publisher: string;
    name: string;
    installed: boolean;
    requires: ReadonlyArray<string>;
    manifest?: BulkPackManifest;
  }>;
}>;

/** `packs.installBySlug` caller — co-install a missing dependency pack. The
 *  dialog's {Access × Audience} pick rides as `install_scope` whenever the pack
 *  has grantable composition ops or recipe tools. */
export type RecipePackInstallCaller = (args: {
  slug: string;
  granted_permissions: ReadonlyArray<string>;
  install_scope?: InstallGrantSelection;
}) => Promise<{ result: { ok: boolean; failure?: { message?: string } } }>;

export interface MountRecipeDiscoveryOptions {
  host: HTMLElement;
  document?: Document;
  installBySlug: RecipeInstallBySlugCaller;
  listInstalled: RecipeInstalledListCaller;
  /** Deps box (owner: "combine with the consent dialog + install missing
   *  packs"). BOTH must be present to enable it — the dialog resolves the
   *  recipe's `depends_on` against this roster and co-installs the missing packs.
   *  Absent ⇒ the prior one-click install (graceful degrade / read-only host). */
  listPacks?: RecipePackRosterCaller;
  installPack?: RecipePackInstallCaller;
  /** Injected corpus fetch (tests) — defaults to the real apex download. */
  fetchCatalog?: (origin?: string) => Promise<CatalogResult<CatalogRecipeRow>>;
  /** Pack corpus companion used to verify the BulkPackManifest named by
   *  `recipe_bundle`. Failure leaves standalone installs intact but makes a
   *  bundled recipe unavailable; it never becomes a single-recipe install. */
  fetchPackCatalog?: (origin?: string) => Promise<CatalogResult<CatalogPackRow>>;
  /** Open the existing pack detail/consent flow. Defaults to `#packs/<slug>`. */
  openPack?: (slug: string) => void;
  /** Public marketplace `#recipes/install/<id>` intent. Runs once after both
   *  catalogs load; bundled recipes follow their pack just like an in-app click. */
  initialInstallRecipeId?: string;
  /** Apex origin override (tests / staging / a private mirror). */
  origin?: string;
  /** Broadcast bus — refresh the installed index on pack install/uninstall. */
  subscribe?: BroadcastSubscriber['on'];
}

/** service_kind slug → human label for the dep type badge (shared vocabulary
 *  with the pack Discover surface). */
const SERVICE_KIND_LABEL: Record<string, string> = {
  entity_platform: 'Platform',
  cli: 'CLI',
  workflow: 'Workflow',
  channel_door: 'Channel',
  reception: 'Reception',
};

export const recipeSpec: DiscoverSpec<CatalogRecipeRow> = {
  searchableText: (r) =>
    `${r.name} ${r.description} ${r.tags.join(' ')} ${r.platforms.join(' ')} ${r.publisher_id}`,
  facets: [
    { key: 'platform', values: (r) => r.platforms },
    { key: 'type', values: (r) => (r.type !== '' ? [r.type] : []) },
    { key: 'tag', values: (r) => r.tags },
  ],
  sorters: {
    downloads: byNumberDesc((r) => r.download_count, (r) => r.recipe_id),
    rating: byNumberDesc((r) => r.rating_avg, (r) => r.recipe_id),
    newest: byDateDesc((r) => r.created_at, (r) => r.recipe_id),
    name: byStringAsc((r) => r.name),
  },
};

export const recipeBadges = (r: CatalogRecipeRow): DiscoverBadge[] => {
  const out: DiscoverBadge[] = [];
  // Certified is the one signal worth the single accent; type + platforms stay
  // neutral (the near-monochrome shell reserves accent for meaning).
  if (r.publisher_certified === true) {
    out.push({ label: '✓ Certified', tone: 'accent', title: 'Published by a certified publisher' });
  }
  if (r.type !== '') out.push({ label: r.type, tone: 'muted' });
  for (const p of r.platforms.slice(0, 3)) out.push({ label: p, tone: 'muted' });
  return out;
};

export const recipeMeta = (r: CatalogRecipeRow): string => {
  const parts = [r.publisher_id, `${r.download_count} install${r.download_count === 1 ? '' : 's'}`];
  if (r.rating_count > 0) parts.push(`★ ${r.rating_avg.toFixed(1)} (${r.rating_count})`);
  return parts.join(' · ');
};

export const mountRecipeDiscovery = (
  opts: MountRecipeDiscoveryOptions,
): { dispose: () => void; panel: DiscoverPanelMount; dialog: RecipeInstallDialogMount | null } => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('mountRecipeDiscovery: no document available — pass opts.document');
  }
  ensureDiscoverStyles(doc);

  const fetchCatalog = opts.fetchCatalog
    ?? ((origin?: string) => fetchRecipeCatalog(origin !== undefined ? { origin } : {}));
  const fetchPacks = opts.fetchPackCatalog
    ?? (opts.fetchCatalog === undefined
      ? ((origin?: string) => fetchMarketplacePackCatalog(origin !== undefined ? { origin } : {}))
      // An injected recipe corpus is a self-contained test/private-mirror seam;
      // do not unexpectedly mix it with the public pack catalog.
      : async () => ({ status: 'ok' as const, rows: [] }));
  const openPack = opts.openPack
    ?? ((slug: string): void => {
      const loc = (globalThis as { location?: { hash: string } }).location;
      if (loc !== undefined) loc.hash = serializeShellRoute('packs', slug);
    });

  let recipeCatalog: CatalogRecipeRow[] = [];
  let packCatalog: CatalogPackRow[] = [];
  const initialInstallPending = opts.initialInstallRecipeId ?? null;
  const fetchBundleCatalog = async (): Promise<CatalogResult<CatalogRecipeRow>> => {
    const [recipesResult, packsResult] = await Promise.all([
      fetchCatalog(opts.origin),
      fetchPacks(opts.origin),
    ]);
    // Keep these two snapshots aligned. A pack-catalog failure makes declared
    // bundle installs unavailable; a recipe-catalog failure leaves the panel's
    // existing last-good snapshot untouched on background refresh.
    if (recipesResult.status === 'ok') {
      recipeCatalog = recipesResult.rows;
      packCatalog = packsResult.status === 'ok' ? packsResult.rows : [];
    }
    return recipesResult;
  };

  const bundleCarrier = (row: CatalogRecipeRow) =>
    resolveRecipeBundleInstallPack(row, recipeCatalog, packCatalog);

  // Installed-version index — refreshed from `recipe.list`.
  let lookup: (recipeId: string) => number | null = () => null;
  const lookupFn = (recipeId: string): number | null => lookup(recipeId);

  // Deps box state — the dependency roster (from packs.list) + the consent
  // dialog. Both stay inert unless `listPacks` + `installPack` are wired.
  let roster: DepPackInfo[] = [];
  let dialog: RecipeInstallDialogMount | null = null;

  const oneClickInstall = async (recipeId: string) => {
    const { result } = await opts.installBySlug(recipeId);
    if (result.ok) {
      void refreshInstalled();
      return { ok: true };
    }
    return { ok: false, message: result.failure.message };
  };

  const panel = mountDiscoverPanel<CatalogRecipeRow>({
    host: opts.host,
    document: doc,
    spec: recipeSpec,
    fetchCatalog: fetchBundleCatalog,
    identity: (r) => r.recipe_id,
    catalogVersion: (r) => r.version,
    installedVersion: lookupFn,
    title: (r) => r.name,
    description: (r) => r.description,
    badges: recipeBadges,
    metaLine: recipeMeta,
    filterGroups: [
      { key: 'platform', label: 'Platform' },
      { key: 'type', label: 'Type' },
      { key: 'tag', label: 'Tag' },
    ],
    sortOptions: [
      { key: 'downloads', label: 'Most installed' },
      { key: 'rating', label: 'Top rated' },
      { key: 'newest', label: 'Newest' },
      { key: 'name', label: 'Name' },
    ],
    install: {
      label: (row) => row.recipe_bundle !== undefined ? 'Install workflow' : 'Install',
      run: async (row) => {
        if (row.recipe_bundle !== undefined) {
          // The key directly names the only legal install entry. Verify that
          // current catalog membership before handing off; never bypass the
          // pack when its row is absent, duplicated, malformed, or versioned
          // behind a current declaring recipe.
          const carrier = bundleCarrier(row);
          if (carrier.status === 'resolved') {
            openPack(carrier.pack.slug);
            return { ok: true, handedOff: true };
          }
          return {
            ok: false,
            message: 'This recipe must be installed through its bundled pack, but that pack is unavailable or out of date.',
          };
        }
        // Deps box: when wired, resolve the recipe's `depends_on` and — if any
        // pack is missing — hand off to the consent dialog (which co-installs the
        // missing packs + the recipe). No deps (or not wired) → one-click.
        if (dialog !== null) {
          // depends_on rides the catalog now — resolved from the already-loaded
          // row, no per-recipe body fetch.
          const required = recipeRequiredPacks({ depends_on: row.depends_on });
          if (required.length > 0) {
            // Resolve against a FRESH roster — install-state can change out of
            // band, and this also closes the mount-time load race (a click
            // before the roster loaded would else see every dep as unknown).
            await refreshRoster();
            const resolved = resolveRecipeDeps(required, roster);
            // Only open the dialog when a dep is actually MISSING; an
            // all-installed-deps recipe stays one-click. When it opens, it
            // discloses the full dep set + co-install checkboxes for the missing.
            if (missingDeps(resolved).length > 0) {
              dialog.open(
                {
                  recipe_id: row.recipe_id,
                  name: row.name,
                  publisher_id: row.publisher_id,
                  version: row.version,
                },
                resolved,
              );
              return { ok: true, handedOff: true };
            }
          }
        }
        return oneClickInstall(row.recipe_id);
      },
    },
    // Standalone upgrade re-installs by slug; bundled update reopens its pack.
    copy: { searchPlaceholder: 'Search recipes…', kindPlural: 'recipes' },
  });

  const refreshInstalled = async (): Promise<void> => {
    try {
      const { recipes } = await opts.listInstalled();
      const m = new Map(recipes.map((r) => [r.recipe_id, r.version] as const));
      lookup = (id) => m.get(id) ?? null;
      panel.setInstalled(lookupFn);
    } catch {
      // Non-fatal — install-state stays at its last-known values.
    }
  };

  const refreshRoster = async (): Promise<void> => {
    if (opts.listPacks === undefined) return;
    try {
      const { packs } = await opts.listPacks();
      roster = packs.map((p) => ({
        slug: p.slug,
        publisher: p.publisher,
        name: p.name,
        installed: p.installed,
        requires: p.requires,
        ...(p.manifest?.service_kind !== undefined ? { service_kind: p.manifest.service_kind } : {}),
        // Carry the manifest so the dialog can derive the grant picker for a
        // connection-backed dep (§7.1/§7.2).
        ...(p.manifest !== undefined ? { manifest: p.manifest } : {}),
      }));
    } catch {
      // Non-fatal — a missing dep degrades to "install from its page".
    }
  };

  // Enable the deps box only when BOTH the roster + the pack installer are wired.
  if (opts.installPack !== undefined && opts.listPacks !== undefined) {
    ensureDialogStyles(doc);
    const installPack = opts.installPack;
    dialog = mountRecipeInstallDialog({
      host: opts.host,
      document: doc,
      installPack: async (slug, requires, installScope) => {
        const { result } = await installPack({
          slug,
          granted_permissions: requires,
          ...(installScope !== undefined ? { install_scope: installScope } : {}),
        });
        return result.ok
          ? { ok: true }
          : { ok: false, ...(result.failure?.message !== undefined ? { message: result.failure.message } : {}) };
      },
      installRecipe: async (recipeId) => {
        const { result } = await opts.installBySlug(recipeId);
        return result.ok ? { ok: true } : { ok: false, message: result.failure.message };
      },
      onInstalled: () => {
        void refreshInstalled();
        void refreshRoster();
      },
      serviceKindLabel: (k) => SERVICE_KIND_LABEL[k] ?? k,
    });
  }

  void refreshInstalled();

  if (initialInstallPending !== null) {
    const recipeId = initialInstallPending;
    void panel.whenLoaded().then(() => {
      const row = recipeCatalog.find((candidate) => candidate.recipe_id === recipeId);
      if (row?.recipe_bundle !== undefined) {
        const carrier = bundleCarrier(row);
        if (carrier.status === 'resolved') {
          // A marketplace install intent targets the complete pack even when
          // this one recipe is already present locally; card install state must
          // not swallow the handoff.
          openPack(carrier.pack.slug);
          return;
        }
      }
      return panel.clickInstall(recipeId);
    });
  }

  const unsubs: Array<() => void> = [];
  if (opts.subscribe !== undefined) {
    // Recipes can arrive via a pack install/uninstall; refresh the installed
    // index so their badges flip. (The dep roster is fetched fresh at each
    // dialog-open, so it needs no broadcast refresh.)
    unsubs.push(opts.subscribe('pack_installed', () => void refreshInstalled()));
    unsubs.push(opts.subscribe('pack_uninstalled', () => void refreshInstalled()));
  }

  return {
    panel,
    dialog,
    dispose: () => {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* teardown best-effort */
        }
      }
      if (dialog !== null) dialog.dispose();
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

const DIALOG_STYLES_MARKER = 'data-recued-recipe-dialog-styles';
const ensureDialogStyles = (doc: Document): void => {
  if (doc.head?.querySelector?.(`style[${DIALOG_STYLES_MARKER}]`) != null) return;
  const style = doc.createElement('style');
  style.setAttribute(DIALOG_STYLES_MARKER, '');
  // Join the shared {Access × Audience} grant-picker CSS — the co-install dialog
  // renders `renderInstallGrantPicker` for a connection-backed dep (§7.1/§7.2).
  style.textContent = `${RECIPE_DIALOG_STYLES}\n${INSTALL_GRANT_PICKER_STYLES}`;
  doc.head?.appendChild?.(style);
};
