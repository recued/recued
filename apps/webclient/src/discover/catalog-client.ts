/** Discover — marketplace catalog (all_meta) fetch layer.
 *
 *  The webclient's Discover surface (`#packs` / `#recipes` → the Discovery tab)
 *  browses the marketplace from a single cheap download per kind: the D-180 SSR
 *  worker's `/catalog/{packs,recipes}.json` "browse corpus" (R10/R11) — the
 *  lightweight listing columns only (no heavy recipe/manifest JSONB), CDN-cached
 *  + SWR, projected from Supabase. Fetching the whole corpus once lets the client
 *  do list / search / filter / sort / paging locally, at scale (hundreds of
 *  rows), with zero per-keystroke round-trips.
 *
 *  Role boundary: this fetches PUBLIC DISPLAY DATA directly from the apex —
 *  exactly what the worker intends ("the webclient consumes DATA, never the
 *  marketplace client lib; install routes through the server"). So this module
 *  does NOT import `@recued/marketplace` (lint boundary) and never installs
 *  anything: install still goes through the server's trusted `packs.installBySlug`
 *  / `recipe.installBySlug` rpcs, which re-fetch + re-validate. The corpus is
 *  untrusted input here, so every row is shape-validated defensively (a malformed
 *  row is dropped, never thrown).
 *
 *  Offline / paired-to-a-LAN-server: the apex fetch simply fails and Discover
 *  degrades to "couldn't reach the marketplace" — install + discovery both need
 *  the internet anyway, so this is the honest surface, not a regression.
 */

// ────────────────────────────────────────────────────────────────
// Row types — mirror the worker's projection (apps/marketplace/src/ssr/worker.ts
// `CatalogRecipe` / `CatalogPack`). Defined here (not imported) because the
// webclient can't reach into apps/marketplace; the worker projection is the
// authority and this is the read-side consumer contract.
// ────────────────────────────────────────────────────────────────

export interface CatalogRecipeRow {
  recipe_id: string;
  publisher_id: string;
  publisher_certified?: boolean;
  name: string;
  description: string;
  type: string;
  version: number;
  platforms: string[];
  tags: string[];
  download_count: number;
  rating_avg: number;
  rating_count: number;
  created_at: string;
  /** D-182 `depends_on` — the Tier-P packs this recipe hard-depends on
   *  (`<publisher>.<pack>`). Carried in the catalog (a tiny string[]) so the
   *  install deps box resolves dependencies from the already-downloaded corpus,
   *  no per-recipe body fetch. `[]` for a kernel-only recipe. */
  depends_on: string[];
  /** D-195 namespaced identity of the pack that owns installation. Its current
   *  membership is independently verified from `CatalogPackRow.recipe_refs`. */
  recipe_bundle?: string;
}

export interface CatalogPackRow {
  slug: string;
  publisher_id: string;
  publisher_certified?: boolean;
  name: string;
  description: string;
  version: number;
  pack_kind: string;
  /** The manifest's `service_kind` when declared (entity_platform / cli /
   *  workflow / channel_door / …). Absent for local/legacy packs → the "Other"
   *  bucket, matching the Installed section's kind grouping. */
  service_kind?: string;
  tags: string[];
  download_count: number;
  item_count: number;
  /** Direct pinned recipe refs projected from the existing BulkPackManifest
   *  (`recipes[]` and/or v2 recipe `contents[]`). */
  recipe_refs: Array<{ slug: string; version: number }>;
  created_at: string;
}

// ────────────────────────────────────────────────────────────────
// Fetch seam + origin resolution
// ────────────────────────────────────────────────────────────────

export type CatalogFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Resolve the marketplace apex origin the catalog lives on. Explicit override
 *  wins (tests / a self-hoster pointing at a private mirror); otherwise derive
 *  prod vs staging from the webclient's own host — `app.recued2.com` → the
 *  `recued2.com` staging apex, everything else (incl. a LAN-IP / localhost
 *  offline webclient) → the public prod apex `recued.com`. Mirrors the
 *  `probe.recued.com` default-prod pattern in `settings/reachability.ts`. */
export const resolveApexOrigin = (opts?: {
  override?: string;
  hostname?: string;
}): string => {
  if (opts?.override !== undefined && opts.override !== '') {
    return opts.override.replace(/\/+$/, '');
  }
  const host =
    opts?.hostname ??
    (globalThis as { location?: { hostname?: string } }).location?.hostname ??
    '';
  return host.includes('recued2') ? 'https://recued2.com' : 'https://recued.com';
};

// ────────────────────────────────────────────────────────────────
// Defensive row parsing — the corpus is untrusted network JSON
// ────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const recipeRefs = (value: unknown): Array<{ slug: string; version: number }> => {
  if (!Array.isArray(value)) return [];
  const refs = new Map<string, number>();
  for (const entry of value) {
    if (!isRecord(entry)) return [];
    const slug = str(entry.slug);
    const version = entry.version;
    if (
      slug === null
      || slug.length === 0
      || typeof version !== 'number'
      || !Number.isInteger(version)
      || version <= 0
      || refs.has(slug)
    ) {
      return [];
    }
    refs.set(slug, version);
  }
  return [...refs.entries()].map(([slug, version]) => ({ slug, version }));
};

/** Parse one recipe-catalog row, or `null` if the required identity/columns are
 *  missing or the wrong type (drop, don't throw — one bad row never breaks the
 *  browse). */
export const parseRecipeRow = (u: unknown): CatalogRecipeRow | null => {
  if (!isRecord(u)) return null;
  const recipe_id = str(u.recipe_id);
  const publisher_id = str(u.publisher_id);
  const name = str(u.name);
  if (recipe_id === null || publisher_id === null || name === null) return null;
  return {
    recipe_id,
    publisher_id,
    ...(typeof u.publisher_certified === 'boolean'
      ? { publisher_certified: u.publisher_certified }
      : {}),
    name,
    description: str(u.description) ?? '',
    type: str(u.type) ?? '',
    version: num(u.version),
    platforms: strArr(u.platforms),
    tags: strArr(u.tags),
    download_count: num(u.download_count),
    rating_avg: num(u.rating_avg),
    rating_count: num(u.rating_count),
    created_at: str(u.created_at) ?? '',
    depends_on: strArr(u.depends_on),
    ...(str(u.recipe_bundle) !== null
      ? { recipe_bundle: str(u.recipe_bundle) as string }
      : {}),
  };
};

/** Parse one pack-catalog row, or `null` if the required identity/columns are
 *  missing or the wrong type. */
export const parsePackRow = (u: unknown): CatalogPackRow | null => {
  if (!isRecord(u)) return null;
  const slug = str(u.slug);
  const publisher_id = str(u.publisher_id);
  const name = str(u.name);
  if (slug === null || publisher_id === null || name === null) return null;
  return {
    slug,
    publisher_id,
    ...(typeof u.publisher_certified === 'boolean'
      ? { publisher_certified: u.publisher_certified }
      : {}),
    name,
    description: str(u.description) ?? '',
    version: num(u.version),
    pack_kind: str(u.pack_kind) ?? '',
    ...(str(u.service_kind) !== null ? { service_kind: str(u.service_kind) as string } : {}),
    tags: strArr(u.tags),
    download_count: num(u.download_count),
    item_count: num(u.item_count),
    recipe_refs: recipeRefs(u.recipe_refs),
    created_at: str(u.created_at) ?? '',
  };
};

// ────────────────────────────────────────────────────────────────
// Fetch
// ────────────────────────────────────────────────────────────────

export type CatalogKind = 'recipe' | 'pack';

export type CatalogResult<Row> =
  | { status: 'ok'; rows: Row[] }
  | { status: 'error'; message: string; httpStatus?: number };

const catalogPath = (kind: CatalogKind): string =>
  kind === 'recipe' ? '/catalog/recipes.json' : '/catalog/packs.json';

interface FetchCatalogOptions {
  /** Apex origin override — else resolved from the host (prod / staging). */
  origin?: string;
  /** Injected fetch (tests / a non-browser host). Defaults to global fetch. */
  fetchFn?: CatalogFetch;
  /** AbortSignal so a route teardown / a superseding refresh can cancel. */
  signal?: AbortSignal;
}

// Freshness is delegated to the HTTP cache: the worker serves the catalog with
// `max-age=600` (+ CDN `s-maxage`/SWR), so a re-download on a return visit is
// served from the browser cache within the window and revalidated by the
// browser/CDN afterwards — no client-side `If-None-Match`/304 needed (and
// avoiding it keeps the request CORS-simple: no preflight). "Parse the version
// regularly" rides that cache; "if date modified changes" rides its revalidation.

const parseWith = <Row>(
  body: unknown,
  parse: (u: unknown) => Row | null,
): Row[] => (Array.isArray(body) ? body.map(parse).filter((r): r is Row => r !== null) : []);

/** Fetch + parse one catalog kind. Never throws — a network / CORS / parse
 *  failure resolves to an `error` result so the Discover surface can show a
 *  retry affordance and keep any last-good rows. */
const fetchCatalog = async <Row>(
  kind: CatalogKind,
  parse: (u: unknown) => Row | null,
  opts: FetchCatalogOptions = {},
): Promise<CatalogResult<Row>> => {
  const origin = resolveApexOrigin({ ...(opts.origin !== undefined ? { override: opts.origin } : {}) });
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as CatalogFetch | undefined);
  if (fetchFn === undefined) {
    return { status: 'error', message: 'No fetch available in this environment' };
  }
  // Keep the request CORS-simple (GET + `Accept` only) so no preflight is needed.
  const headers: Record<string, string> = { Accept: 'application/json' };

  let res: Response;
  try {
    res = await fetchFn(`${origin}${catalogPath(kind)}`, {
      headers,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    return {
      status: 'error',
      message: `Couldn't reach the marketplace — ${(e as Error)?.message ?? String(e)}`,
    };
  }

  if (!res.ok) {
    return {
      status: 'error',
      message: `Marketplace catalog unavailable (HTTP ${res.status})`,
      httpStatus: res.status,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: 'error', message: 'Marketplace catalog returned a malformed response' };
  }
  return { status: 'ok', rows: parseWith(body, parse) };
};

/** Download the recipe browse corpus (`/catalog/recipes.json`). */
export const fetchRecipeCatalog = (
  opts?: FetchCatalogOptions,
): Promise<CatalogResult<CatalogRecipeRow>> =>
  fetchCatalog('recipe', parseRecipeRow, opts);

/** Download the pack browse corpus (`/catalog/packs.json`). */
export const fetchPackCatalog = (
  opts?: FetchCatalogOptions,
): Promise<CatalogResult<CatalogPackRow>> => fetchCatalog('pack', parsePackRow, opts);
