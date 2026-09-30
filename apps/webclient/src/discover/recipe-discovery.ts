/** Discover — the `#recipes` Discovery tab: browse the marketplace recipe
 *  catalog + install standalone recipes (with a hard-dependency consent step).
 *
 *  A recipe without `metadata.recipe_bundle` installs independently through
 *  `recipe.installBySlug`; its Tier-P `depends_on` packs still use the existing
 *  co-install consent dialog. A recipe with `recipe_bundle` instead opens the
 *  directly named pack detail/consent flow. Missing or drifted bundle packs
 *  fail closed and never fall back to installing only one recipe.
 */

import type { DiscoverQuery } from './discover-model.js';
import { makeUpdateVersionResolver } from './update-versions.js';
import {
  DISCOVER_PANEL_STYLES,
  mountDiscoverPanel,
  type DiscoverBadge,
  type DiscoverPanelMount,
} from './discover-panel.js';
import {
  fetchCatalogVersions,
  fetchPackCatalog as fetchMarketplacePackCatalog,
  fetchPackRecipeRefs,
  fetchRecipeCatalog,
  fetchRecipeSearch,
  type CatalogPackRow,
  type CatalogPageResult,
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
  type MailTemplateInstallOutcome,
} from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

/** `recipe.installBySlug` caller (the registry result shape). */
export type RecipeInstallBySlugCaller = (slug: string) => Promise<{
  result:
    | { ok: true; recipe_id: string; version: number; mail_templates?: readonly MailTemplateInstallOutcome[] }
    | { ok: false; failure: { code: string; message: string; pack_slug?: string } };
}>;

/** D-315 §5.2 — what a recipe installed on its own did with the templates it
 *  brings, said once it is installed: there is no dialog on this path to ask
 *  first. `undefined` when it brings none. */
export const mailTemplateInstallNotice = (
  outcomes: readonly MailTemplateInstallOutcome[] | undefined,
): string | undefined => {
  const lines = (outcomes ?? []).flatMap((outcome) => {
    if (outcome.action === 'unchanged') return [];
    const verb = outcome.action === 'created' ? 'Added' : 'Updated';
    if (outcome.switched_off !== undefined) {
      return [`${verb} the mail template “${outcome.name}”. Your “${outcome.switched_off.name}” read the same mail, and is off now: switch it back in Data → Mail facts → Templates.`];
    }
    if (!outcome.active && outcome.uses !== undefined) {
      return [`${verb} the mail template “${outcome.name}”, off: your “${outcome.uses.name}” already reads that mail, and the Recipe uses it.`];
    }
    return [`${verb} the mail template “${outcome.name}”; its AI is off.`];
  });
  return lines.length > 0 ? lines.join(' ') : undefined;
};

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
  /** Server-side search (`/catalog/search?kind=recipe`) — the browse path. When
   *  present the panel asks the server for one page per interaction instead of
   *  downloading + reducing over the whole corpus. Injected in tests; defaults
   *  to the real endpoint. `fetchCatalog` becomes the failure fallback. */
  search?: (query: DiscoverQuery) => Promise<CatalogPageResult<CatalogRecipeRow>>;
  /** Resolve current catalogue versions for a bounded id set (the installed
   *  roster) — drives the "N updates available" badge once the corpus isn't
   *  held. Injected in tests; defaults to the real `/catalog/versions`. */
  fetchVersions?: (ids: readonly string[]) => Promise<
    | { status: 'ok'; versions: Map<string, number> }
    | { status: 'error'; message: string }
  >;
  /** Injected corpus fetch (tests) — defaults to the real apex download. In
   *  server-search mode this is the FALLBACK (a failed search), not the load
   *  path; it also lazily backs bundle resolution. */
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

// ⚠ `searchableText` is mirrored field-for-field by `recipes.searchable`
// (migration 029/030) so the server can be proven equal to `runDiscover` by
// differential. Changing it without changing that generated column turns the
// differential red — which is the intended coupling, not an accident. The spec
// itself lives in `discover-specs.ts` (DOM-free, so the differential imports
// the real thing rather than a mirror); re-exported here for its callers.
import { recipeSpec } from './discover-specs.js';

export { recipeSpec };

export const recipeBadges = (r: CatalogRecipeRow): DiscoverBadge[] => {
  const out: DiscoverBadge[] = [];
  // Certified is the one signal worth the single accent; platforms stay neutral
  // (the near-monochrome shell reserves accent for meaning). No `type` badge:
  // the column was dropped in migration 002, so `r.type` is always `''` — the
  // badge could never render (removed with the dead facet).
  if (r.publisher_certified === true) {
    out.push({ label: '✓ Certified', tone: 'accent', title: 'From a checked publisher' });
  }
  for (const p of r.platforms.slice(0, 3)) out.push({ label: p, tone: 'muted' });
  return out;
};

export const recipeMeta = (r: CatalogRecipeRow): string => {
  // Installs are omitted at 0, same as the rating below: nothing writes
  // `download_count` today (the increment RPCs have no callers), so an
  // unconditional chip rendered "0 installs" — a popularity claim with no
  // backing. Omit rather than assert; it returns when the counter gets a writer.
  const parts = [r.publisher_id];
  if (r.download_count > 0) parts.push(`${r.download_count} install${r.download_count === 1 ? '' : 's'}`);
  if (r.rating_count > 0) parts.push(`★ ${r.rating_avg.toFixed(1)} (${r.rating_count})`);
  return parts.join(' · ');
};

export const mountRecipeDiscovery = (
  opts: MountRecipeDiscoveryOptions,
): {
  dispose: () => void;
  panel: DiscoverPanelMount;
  dialog: RecipeInstallDialogMount | null;
  /** Return-visit refresh — re-run the current query + re-read roster versions. */
  refresh: () => void;
} => {
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

  // Server-side search is the browse path — UNLESS a corpus is injected, which
  // is a self-contained test / private-mirror seam that must not silently start
  // hitting the public endpoint (mirrors the `fetchPacks` rule below). So:
  // `opts.search` wins; else the real endpoint in production; else corpus mode
  // when `fetchCatalog` was injected.
  const searchFn = opts.search
    ?? (opts.fetchCatalog === undefined
      ? ((query: DiscoverQuery) =>
          fetchRecipeSearch(query, opts.origin !== undefined ? { origin: opts.origin } : {}))
      : undefined);
  const serverMode = searchFn !== undefined;

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

  /** Bundle resolution reads the WHOLE recipe + pack catalogue (to find sibling
   *  recipes sharing a bundle key and verify the carrier pack). Server search
   *  never downloads that, so in server mode the corpus is fetched LAZILY —
   *  once, on the first bundled-recipe install (or a deep-link install intent),
   *  not eagerly on every browse. In corpus mode it is already loaded, so this
   *  is a no-op. A failure is not memoised, so the next install retries. */
  let bundleCorpusLoad: Promise<void> | null = null;
  const ensureBundleCorpus = (): Promise<void> => {
    if (recipeCatalog.length > 0) return Promise.resolve();
    if (bundleCorpusLoad === null) {
      bundleCorpusLoad = fetchBundleCatalog().then((r) => {
        if (r.status !== 'ok') bundleCorpusLoad = null;
      });
    }
    return bundleCorpusLoad;
  };

  /** Carrier membership, topped up from the per-pack install artifact.
   *
   *  `recipe_refs` is pack MEMBERSHIP and lives in `/packs/<slug>.json`, not in
   *  the meta catalog — carrying it in the meta was the only reason that
   *  catalog's server-side read had to touch all 927 manifests. There are 56
   *  distinct carriers across 382 bundled recipes, so they are fetched ONE at a
   *  time, when a reader actually acts on a bundled recipe, and cached for the
   *  life of the panel. */
  const carrierRefs = new Map<string, Array<{ slug: string; version: number }>>();

  const bundleCarrierAsync = async (row: CatalogRecipeRow) => {
    // Server mode holds no corpus until an install needs one — load it now.
    await ensureBundleCorpus();
    // Cheap pass first: it also decides WHICH pack we would need refs for, and
    // returns `none` for the cases that never reach a carrier at all.
    const parsed = resolveRecipeBundleInstallPack(row, recipeCatalog, packCatalog);
    if (parsed.status === 'resolved') return parsed;

    const key = row.recipe_bundle;
    if (key === undefined) return parsed;
    const slug = key.slice(key.indexOf('/') + 1);
    const candidate = packCatalog.find((p) => p.slug === slug);
    if (candidate === undefined) return parsed;

    if (!carrierRefs.has(slug)) {
      carrierRefs.set(slug, await fetchPackRecipeRefs(slug, opts.origin !== undefined ? { origin: opts.origin } : {}));
    }
    const refs = carrierRefs.get(slug) ?? [];
    if (refs.length === 0) return parsed;
    // Re-run the SAME resolver against a catalog whose carrier now carries its
    // real membership — the ambiguity and identity checks still apply.
    return resolveRecipeBundleInstallPack(
      row,
      recipeCatalog,
      packCatalog.map((p) => (p.slug === slug ? { ...p, recipe_refs: refs } : p)),
    );
  };

  // Installed-version index — refreshed from `recipe.list`.
  let lookup: (recipeId: string) => number | null = () => null;
  const lookupFn = (recipeId: string): number | null => lookup(recipeId);

  // "N updates available" — server mode can't reduce it out of the corpus (it
  // holds one page), so it is a lookup over the installed roster's catalogue
  // versions. `onChange` re-renders via `setInstalled` (same lookup, so it just
  // repaints and the badge re-reads the freshly-resolved map).
  let panelRef: DiscoverPanelMount | null = null;
  const updates = serverMode
    ? makeUpdateVersionResolver({
        kind: 'recipe',
        onChange: () => panelRef?.setInstalled(lookupFn),
        ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
        ...(opts.fetchVersions !== undefined ? { fetchVersions: opts.fetchVersions } : {}),
      })
    : null;

  // Deps box state — the dependency roster (from packs.list) + the consent
  // dialog. Both stay inert unless `listPacks` + `installPack` are wired.
  let roster: DepPackInfo[] = [];
  let dialog: RecipeInstallDialogMount | null = null;

  const oneClickInstall = async (recipeId: string) => {
    const { result } = await opts.installBySlug(recipeId);
    if (result.ok) {
      void refreshInstalled();
      const notice = mailTemplateInstallNotice(result.mail_templates);
      return { ok: true, ...(notice !== undefined ? { notice } : {}) };
    }
    return { ok: false, message: result.failure.message };
  };

  /** The install flow for one recipe row — bundled recipes hand off to their
   *  pack's consent flow; standalone recipes with missing deps open the deps
   *  dialog; the rest install one-click. Extracted so the deep-link intent can
   *  drive it for a recipe that isn't on the current server page (where the
   *  panel's own click path — which resolves the row from the visible page —
   *  couldn't find it). */
  const runRecipeInstall = async (
    row: CatalogRecipeRow,
  ): Promise<{ ok: boolean; message?: string; handedOff?: boolean }> => {
    if (row.recipe_bundle !== undefined) {
      // The key directly names the only legal install entry. Verify that
      // current catalog membership before handing off; never bypass the pack
      // when its row is absent, duplicated, malformed, or versioned behind a
      // current declaring recipe.
      const carrier = await bundleCarrierAsync(row);
      if (carrier.status === 'resolved') {
        openPack(carrier.pack.slug);
        return { ok: true, handedOff: true };
      }
      return {
        ok: false,
        message: 'This Recipe comes as part of a Pack, and that Pack is missing or out of date.',
      };
    }
    // Deps box: when wired, resolve the recipe's `depends_on` and — if any pack
    // is missing — hand off to the consent dialog (which co-installs the missing
    // packs + the recipe). No deps (or not wired) → one-click.
    if (dialog !== null) {
      // depends_on rides the catalog now — resolved from the already-loaded row,
      // no per-recipe body fetch.
      const required = recipeRequiredPacks({ depends_on: row.depends_on });
      if (required.length > 0) {
        // Resolve against a FRESH roster — install-state can change out of band,
        // and this also closes the mount-time load race (a click before the
        // roster loaded would else see every dep as unknown).
        await refreshRoster();
        const resolved = resolveRecipeDeps(required, roster);
        // Only open the dialog when a dep is actually MISSING; an
        // all-installed-deps recipe stays one-click. When it opens, it discloses
        // the full dep set + co-install checkboxes for the missing.
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
  };

  const panel = mountDiscoverPanel<CatalogRecipeRow>({
    host: opts.host,
    document: doc,
    spec: recipeSpec,
    fetchCatalog: fetchBundleCatalog,
    ...(searchFn !== undefined
      ? {
          search: async (query: DiscoverQuery) => {
            const res = await searchFn(query);
            return res.status === 'ok'
              ? { status: 'ok' as const, page: res.page }
              : { status: 'error' as const, message: res.message };
          },
        }
      : {}),
    ...(updates !== null ? { updateVersions: () => updates.read() } : {}),
    identity: (r) => r.recipe_id,
    catalogVersion: (r) => r.version,
    installedVersion: lookupFn,
    title: (r) => r.name,
    description: (r) => r.description,
    badges: recipeBadges,
    metaLine: recipeMeta,
    // No `type` filter group — the column was dropped in migration 002 and is
    // absent from the catalog payload, so the facet never produced a value.
    filterGroups: [
      { key: 'platform', label: 'Platform' },
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
      run: runRecipeInstall,
    },
    // Standalone upgrade re-installs by slug; bundled update reopens its pack.
    copy: { searchPlaceholder: 'Search Recipes…', kindPlural: 'recipes' },
  });
  panelRef = panel;

  const refreshInstalled = async (forceVersions = false): Promise<void> => {
    try {
      const { recipes } = await opts.listInstalled();
      const m = new Map(recipes.map((r) => [r.recipe_id, r.version] as const));
      lookup = (id) => m.get(id) ?? null;
      panel.setInstalled(lookupFn);
      // Resolve the roster's catalogue versions for the update badge (server
      // mode only). Bounded to the installed ids, memoised by id-set.
      void updates?.resolve([...m.keys()], forceVersions ? { force: true } : {});
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
      // The browse panel repaints its busy action once the handoff returns, so
      // the DOM node the focus trap originally saw is detached before this
      // dialog closes. Resolve the current action/card receipt by recipe id.
      returnFocus: (recipeId) => {
        panel.focusAction(recipeId);
      },
      serviceKindLabel: (k) => SERVICE_KIND_LABEL[k] ?? k,
    });
  }

  void refreshInstalled();

  if (initialInstallPending !== null) {
    const recipeId = initialInstallPending;
    void panel.whenLoaded().then(async () => {
      // Server mode holds no corpus after browse — load it so the intent can
      // resolve a recipe that isn't on the current page.
      await ensureBundleCorpus();
      const row = recipeCatalog.find((candidate) => candidate.recipe_id === recipeId);
      // Drive the install directly (not through `panel.clickInstall`, which
      // resolves the row from the VISIBLE page — the deep-linked recipe usually
      // isn't on it). `runRecipeInstall` targets the complete pack even when the
      // recipe is already present locally, so the intent isn't swallowed by
      // card install state.
      if (row !== undefined) {
        await runRecipeInstall(row);
        return;
      }
      // Unknown to the corpus (or corpus fetch failed) — fall back to the panel,
      // which can still act if the row happens to be on the page.
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
    /** A return visit to Discover — re-run the current query AND force-refresh
     *  the roster's catalogue versions, so an upgrade published upstream since
     *  the last visit (no local install/uninstall to trigger a broadcast) still
     *  lights the badge. Corpus mode's old re-download noticed this for free; in
     *  server mode the version lookup is what carries that guarantee. */
    refresh: () => {
      void panel.refresh();
      void refreshInstalled(true);
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
