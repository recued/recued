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

import { extractBulkPackRecipeRefs } from '@recued/contracts';
import { cloudApexOrigin } from '../cloud-apex.js';

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
  /** Last publish / meta-edit time — the `updated` sorter's key, falling back to
   *  `created_at`. Optional because the catalog projection omits it on rows
   *  written before the column was selected. */
  updated_at?: string;
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
  /** See `CatalogRecipeRow.updated_at`. */
  updated_at?: string;
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
 *  the apex fixed at BUILD time (`cloud-apex.ts`), so a LAN-IP / localhost
 *  offline webclient still reaches the public apex `recued.com`. Mirrors the
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
  // ⛔ Was `host.includes(<mirror>) ? <mirror apex> : <product apex>`. The apex
  // is build configuration now (see `cloud-apex.ts`); `host` stays for callers.
  void host;
  return cloudApexOrigin();
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
    ...(str(u.updated_at) !== null ? { updated_at: str(u.updated_at) as string } : {}),
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
    ...(str(u.updated_at) !== null ? { updated_at: str(u.updated_at) as string } : {}),
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

// ────────────────────────────────────────────────────────────────
// Server-side search (`/catalog/search`) — the paged answer
// ────────────────────────────────────────────────────────────────

/** One page of server-computed Discover results. Deliberately the same shape
 *  `runDiscover` produces (minus `matched`, which only exists because the local
 *  engine holds the whole corpus) so the panel renders either identically. */
export interface CatalogPage<Row> {
  rows: Row[];
  total: number;
  totalPages: number;
  page: number;
  facets: Record<string, Array<{ value: string; count: number }>>;
}

export type CatalogPageResult<Row> =
  | { status: 'ok'; page: CatalogPage<Row> }
  | { status: 'error'; message: string; httpStatus?: number };

/** The query the endpoint takes. Structurally `DiscoverQuery` (discover-model),
 *  restated here so the fetch layer keeps no dependency on the engine — the two
 *  are proven equivalent by differential, not by sharing a type. */
export interface CatalogSearchQuery {
  search: string;
  filters: Record<string, readonly string[]>;
  sort: string;
  page: number;
  perPage: number;
}

/** ⚠ The wire shape is the one `scripts/verify-discover-parity.mjs` proved
 *  against the live corpus — `f.<facet>=a,b`, comma-joined. The endpoint also
 *  accepts repeated `f.<facet>` params, but only this form has been shown
 *  equal to `runDiscover` end-to-end, so it is the form the client sends.
 *  (A facet VALUE containing a comma would be split by the endpoint; no value
 *  in the live catalogue contains one, and that is a property of the vocabulary
 *  — tags / platforms / kind slugs — not an assumption about user input.) */
export const catalogSearchParams = (
  kind: CatalogKind,
  query: CatalogSearchQuery,
): URLSearchParams => {
  const p = new URLSearchParams({
    kind,
    q: query.search,
    sort: query.sort,
    page: String(query.page),
    per_page: String(query.perPage),
  });
  for (const [key, values] of Object.entries(query.filters)) {
    if (values.length > 0) p.set(`f.${key}`, values.join(','));
  }
  return p;
};

const facetsOf = (u: unknown): Record<string, Array<{ value: string; count: number }>> => {
  if (!isRecord(u)) return {};
  const out: Record<string, Array<{ value: string; count: number }>> = {};
  for (const [key, raw] of Object.entries(u)) {
    if (!Array.isArray(raw)) continue;
    const vals: Array<{ value: string; count: number }> = [];
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const value = str(entry.value);
      if (value === null || typeof entry.count !== 'number') continue;
      vals.push({ value, count: entry.count });
    }
    out[key] = vals;
  }
  return out;
};

/** Ask the server for ONE page of Discover results.
 *
 *  Same defensive posture as the corpus download: the response is untrusted
 *  network JSON, a malformed row is dropped rather than thrown, and a network /
 *  CORS / HTTP failure resolves to an `error` result so the panel can show a
 *  retry (and, while the corpus is still shipped, degrade to searching it). */
const fetchSearch = async <Row>(
  kind: CatalogKind,
  parse: (u: unknown) => Row | null,
  query: CatalogSearchQuery,
  opts: FetchCatalogOptions = {},
): Promise<CatalogPageResult<Row>> => {
  const origin = resolveApexOrigin({ ...(opts.origin !== undefined ? { override: opts.origin } : {}) });
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as CatalogFetch | undefined);
  if (fetchFn === undefined) {
    return { status: 'error', message: 'No fetch available in this environment' };
  }

  let res: Response;
  try {
    res = await fetchFn(`${origin}/catalog/search?${catalogSearchParams(kind, query)}`, {
      headers: { Accept: 'application/json' },
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
      message: `Marketplace search unavailable (HTTP ${res.status})`,
      httpStatus: res.status,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: 'error', message: 'Marketplace search returned a malformed response' };
  }
  if (!isRecord(body)) {
    return { status: 'error', message: 'Marketplace search returned a malformed response' };
  }

  const rows = parseWith(body.rows, parse);
  // `total` is what the pager and the "N results" copy assert, so a missing or
  // non-numeric one is a malformed response, not a zero.
  if (typeof body.total !== 'number' || typeof body.totalPages !== 'number') {
    return { status: 'error', message: 'Marketplace search returned a malformed response' };
  }
  return {
    status: 'ok',
    page: {
      rows,
      total: body.total,
      totalPages: Math.max(1, body.totalPages),
      page: typeof body.page === 'number' ? body.page : query.page,
      facets: facetsOf(body.facets),
    },
  };
};

/** One page of recipe search results (`/catalog/search?kind=recipe`). */
export const fetchRecipeSearch = (
  query: CatalogSearchQuery,
  opts?: FetchCatalogOptions,
): Promise<CatalogPageResult<CatalogRecipeRow>> =>
  fetchSearch('recipe', parseRecipeRow, query, opts);

/** One page of pack search results (`/catalog/search?kind=pack`). */
export const fetchPackSearch = (
  query: CatalogSearchQuery,
  opts?: FetchCatalogOptions,
): Promise<CatalogPageResult<CatalogPackRow>> =>
  fetchSearch('pack', parsePackRow, query, opts);

// ────────────────────────────────────────────────────────────────
// Bounded version lookup (`/catalog/versions`)
// ────────────────────────────────────────────────────────────────

/** Matches the endpoint's own cap. Over it the server 400s rather than
 *  truncating (a short map would read as "no update available"), so the client
 *  chunks instead of trusting one oversized request. */
const VERSIONS_CHUNK = 200;

/** Current catalogue versions for a BOUNDED id set — the installed roster.
 *
 *  This is what lets Discover keep saying "N updates available" once it pages
 *  from the server and no longer holds the corpus to reduce over. Failure is
 *  reported, never silently answered with an empty map: an empty map is
 *  indistinguishable from "nothing has an update", so the badge would quietly
 *  go dark on every error. */
export const fetchCatalogVersions = async (
  kind: CatalogKind,
  ids: readonly string[],
  opts: FetchCatalogOptions = {},
): Promise<
  | { status: 'ok'; versions: Map<string, number> }
  | { status: 'error'; message: string }
> => {
  const unique = [...new Set(ids.filter((id) => id !== ''))].sort();
  const versions = new Map<string, number>();
  if (unique.length === 0) return { status: 'ok', versions };

  const origin = resolveApexOrigin({ ...(opts.origin !== undefined ? { override: opts.origin } : {}) });
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as CatalogFetch | undefined);
  if (fetchFn === undefined) {
    return { status: 'error', message: 'No fetch available in this environment' };
  }

  for (let i = 0; i < unique.length; i += VERSIONS_CHUNK) {
    const chunk = unique.slice(i, i + VERSIONS_CHUNK);
    const p = new URLSearchParams({ kind, ids: chunk.join(',') });
    let res: Response;
    try {
      res = await fetchFn(`${origin}/catalog/versions?${p}`, {
        headers: { Accept: 'application/json' },
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      return {
        status: 'error',
        message: `Couldn't reach the marketplace — ${(e as Error)?.message ?? String(e)}`,
      };
    }
    if (!res.ok) {
      return { status: 'error', message: `Marketplace version lookup unavailable (HTTP ${res.status})` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { status: 'error', message: 'Marketplace version lookup returned a malformed response' };
    }
    const map = isRecord(body) && isRecord(body.versions) ? body.versions : null;
    if (map === null) {
      return { status: 'error', message: 'Marketplace version lookup returned a malformed response' };
    }
    for (const [id, v] of Object.entries(map)) {
      if (typeof v === 'number' && Number.isFinite(v)) versions.set(id, v);
    }
  }
  return { status: 'ok', versions };
};

// ────────────────────────────────────────────────────────────────
// Per-pack membership (the install artifact, not the meta catalog)
// ────────────────────────────────────────────────────────────────

/** Fetch ONE pack's recipe membership from `/packs/<slug>.json`.
 *
 *  `recipe_refs` is pack MEMBERSHIP, and the add-a-pack model puts membership in
 *  the per-pack install artifact — `all_meta_*` is list, search and version. It
 *  rode in the meta catalog anyway, and that one field was the only reason the
 *  catalog's server-side read had to touch every pack manifest: 97 KB emitted,
 *  empty on 665 of 927 rows, and read for exactly ONE pack per install — the
 *  resolved carrier.
 *
 *  So it is fetched here instead, per carrier, on demand. There are 56 distinct
 *  carriers across 382 bundled recipes, so eagerly loading them would be 56
 *  round-trips; a reader only ever needs the one they are looking at.
 *
 *  ⚠ The SAME validator the worker ran, from the same package — not a
 *  reimplementation. `extractBulkPackRecipeRefs` is fail-closed: a malformed or
 *  conflicting manifest yields `null`, which surfaces here as `[]`, which makes
 *  bundle resolution refuse. That is the behaviour the projection had.
 *
 *  Never throws — a network / CORS / parse failure resolves to `[]`, so the
 *  caller degrades to "no bundle offer" rather than breaking the page. */
export const fetchPackRecipeRefs = async (
  slug: string,
  opts: FetchCatalogOptions = {},
): Promise<Array<{ slug: string; version: number }>> => {
  const origin = resolveApexOrigin({ ...(opts.origin !== undefined ? { override: opts.origin } : {}) });
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as CatalogFetch | undefined);
  if (fetchFn === undefined) return [];
  try {
    const res = await fetchFn(`${origin}/packs/${encodeURIComponent(slug)}.json`, {
      headers: { Accept: 'application/json' },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    if (!res.ok) return [];
    const manifest = (await res.json()) as unknown;
    // Identity guard, as the projection applied it: a manifest that does not
    // name the pack it was served for cannot speak for its membership.
    const m = manifest as { slug?: unknown } | null;
    if (m === null || typeof m !== 'object' || m.slug !== slug) return [];
    return extractBulkPackRecipeRefs(manifest) ?? [];
  } catch {
    return [];
  }
};
