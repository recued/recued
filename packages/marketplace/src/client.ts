/** Marketplace HTTP client — shared between extension and server.
 *
 *  Fetches recipes and ingredients from the Recued marketplace Worker
 *  at marketplace.recued.com (or marketplace.recued2.com on staging).
 *  The Worker handles Supabase auth server-side with the service key, so
 *  clients carry no credentials and can be loaded on any origin.
 *
 *  URL is configured via the build-time define `__RECUED_MARKETPLACE_URL__`
 *  in esbuild. If undefined (tests, server, dev tools), falls back to
 *  production. The extension's scripts/build-extension.mjs sets this
 *  based on --env=production|staging.
 *
 *  All functions accept an optional `fetchFn` so callers can inject
 *  their own fetch (extension service worker, test mocks, etc.).
 */

import type { RecipeDefinition } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

// Build-time define. Extension esbuild injects this; server/tests fall
// back to production. Derived from the single __RECUED_DOMAIN__ knob.
declare const __RECUED_DOMAIN__: string;
const DOMAIN = typeof __RECUED_DOMAIN__ !== 'undefined' ? __RECUED_DOMAIN__ : 'recued.com';
export const MARKETPLACE_URL = `https://marketplace.${DOMAIN}`;

// Apex origin (`https://recued.com`). Serves the per-slug, CDN-cached,
// KV-mirrored install-manifest JSON at `/packs/<slug>.json` + `/recipes/<slug>.json`
// (D-180 SSR / Add-a-pack, 2026-07-01). The install fetchers read from HERE — not
// the raw DB-hitting `MARKETPLACE_URL/v1/marketplace/*` worker — so an install pulls
// the trusted, abuse-resistant static artifact. Discovery / update-check paths
// (`listRecipes`, `checkUpstream`, …) stay on the DB worker.
export const MARKETPLACE_APEX_URL = `https://${DOMAIN}`;

// Kept for backward compat — the auth module still uses these for
// Supabase sign-in/out. Marketplace reads go through the Worker.
export const SUPABASE_URL = 'https://zzremnbtteclikewrlbr.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_1Fcs9ugXnly0RUT84rFRKw_FX4MjbKi';

const jsonHeaders = { 'Accept': 'application/json' };

/** Unwrap the Worker's `{ data, meta }` envelope. */
interface Envelope<T> {
  data: T;
  meta: { request_id: string; timestamp: string };
}

/** Unwrap the paginated list envelope. */
interface ListEnvelope<T> {
  data: T[];
  meta: {
    request_id: string;
    timestamp: string;
    pagination?: {
      page: number;
      per_page: number;
      total_items: number;
      total_pages: number;
      has_next: boolean;
    };
  };
}

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface MarketplaceRecipeResult {
  recipe_id: string;
  publisher_id: string;
  version: number;
  recipe_hash: string;
  recipe: RecipeDefinition;
}

// ────────────────────────────────────────────────────────────────
// Fetch by slug
// ────────────────────────────────────────────────────────────────

/** Fetch a recipe by its marketplace slug (recipe_id) from the apex
 *  `/recipes/<slug>.json` install artifact. Returns the full recipe row or
 *  null if not found (404 or an empty body).
 *
 *  Shape: the apex serves a BARE `{ recipe_id, publisher_id, version, recipe }`
 *  (a static-style file). The legacy DB worker wrapped the same row in a
 *  `{ data, meta }` envelope. We accept EITHER by SHAPE — top-level `recipe_id`
 *  ⇒ bare, else `.data` — mirroring `fetchBulkPackByUrl`, so a future endpoint
 *  swap or a mixed deploy never mis-reads the payload.
 *
 *  `recipe_hash` note: the apex `.json` omits it (unused by the pack-install
 *  resolver — see `pack-install-handler.ts`, which keys on `recipe_id` /
 *  `recipe`). `MarketplaceRecipeResult.recipe_hash` is typed non-optional, so we
 *  default it to `''`. The DB-worker `checkUpstream` still carries the real hash. */
export const fetchRecipeBySlug = async (
  slug: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<MarketplaceRecipeResult | null> => {
  const url = `${MARKETPLACE_APEX_URL}/recipes/${encodeURIComponent(slug)}.json`;
  const res = await fetchFn(url, { headers: jsonHeaders });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Marketplace fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as Record<string, unknown> | null;
  const raw =
    body !== null && typeof body === 'object' && 'recipe_id' in body
      ? body
      : ((body?.data as Record<string, unknown> | null | undefined) ?? null);
  if (raw == null) return null;
  return {
    ...(raw as unknown as MarketplaceRecipeResult),
    recipe_hash: (raw.recipe_hash as string | undefined) ?? '',
  };
};

// ────────────────────────────────────────────────────────────────
// Fetch by URL
// ────────────────────────────────────────────────────────────────

/** Fetch a recipe from a direct URL (any endpoint returning JSON). */
export const fetchRecipeByUrl = async (
  url: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<RecipeDefinition> => {
  const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }
  const parsed = await res.json() as RecipeDefinition;
  if (!parsed.recipe_id || !parsed.steps) {
    throw new Error('URL did not return a valid recipe (missing recipe_id or steps)');
  }
  return parsed;
};

// ────────────────────────────────────────────────────────────────
// Ingredient lookup — author verification
// ────────────────────────────────────────────────────────────────

/** Fetch the canonical (slug, author) pair for a marketplace-published
 *  ingredient. Used by the install-time author-verification check to
 *  prevent vault scope impersonation via hand-crafted ingredient JSON.
 *
 *  Returns:
 *    - `{ author }` when the slug is published on the marketplace.
 *    - `null` when slug isn't found OR the marketplace is unreachable.
 *
 *  Callers treat `null` as "unverified" — the caller should downgrade
 *  the ingredient's vault scope to `'local'` rather than trusting the
 *  claimed author. Never throws: network errors fold into `null` so
 *  offline installs always proceed, just with downgraded scope. */
export const lookupIngredient = async (
  slug: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ author: string } | null> => {
  try {
    const url = `${MARKETPLACE_URL}/v1/marketplace/ingredients/${encodeURIComponent(slug)}`;
    const res = await fetchFn(url, { headers: jsonHeaders });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const body = await res.json() as Envelope<{ author?: unknown }>;
    const author = body.data?.author;
    if (typeof author !== 'string' || !author) return null;
    return { author };
  } catch {
    // Network error, DNS failure, timeout — treat as unverified so the
    // extension still installs (downgraded to local scope).
    return null;
  }
};

// ────────────────────────────────────────────────────────────────
// Check upstream version
// ────────────────────────────────────────────────────────────────

/** Check the latest upstream version for a recipe slug.
 *  Returns {version, hash} or null if the recipe doesn't exist. */
export const checkUpstream = async (
  slug: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ version: number; hash: string } | null> => {
  const url = `${MARKETPLACE_URL}/v1/marketplace/recipes/${encodeURIComponent(slug)}`;
  const res = await fetchFn(url, { headers: jsonHeaders });
  if (!res.ok) return null;
  const body = await res.json() as Envelope<{ version: number; recipe_hash: string }>;
  if (!body.data) return null;
  return { version: body.data.version, hash: body.data.recipe_hash };
};

// ────────────────────────────────────────────────────────────────
// Input parsing
// ────────────────────────────────────────────────────────────────

/** Parse user input (slug, marketplace URL, or direct URL) into a
 *  normalized form. Handles all marketplace URL patterns:
 *  - "deal-risk-hubspot"                                    → { slug }
 *  - "recued.com/marketplace/recipes/deal-risk-hubspot"     → { slug }
 *  - "https://recued.com/marketplace/recipes/deal-risk"     → { slug }
 *  - "https://example.com/my-recipe.json"                   → { url }
 */
export const resolveRecipeInput = (
  input: string,
): { slug: string } | { url: string } | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Marketplace URL: recued.com/marketplace/recipes/{id} or legacy /recipe/{id}
  const webUrlMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:app\.)?recued2?\.com(?:\/marketplace)?\/recipes?\/([a-z0-9][a-z0-9-]*[a-z0-9])$/i,
  );
  if (webUrlMatch) return { slug: webUrlMatch[1] };

  // Full URL → pass through
  if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };

  // Bare slug: alphanumeric + hyphens
  if (/^[a-z0-9][a-z0-9-]*[a-z0-9]$/i.test(trimmed)) return { slug: trimmed };

  // Contains dots → URL
  if (trimmed.includes('.')) return { url: trimmed.startsWith('http') ? trimmed : `https://${trimmed}` };

  // Single word → slug
  return { slug: trimmed };
};

// ────────────────────────────────────────────────────────────────
// Suggestions
// ────────────────────────────────────────────────────────────────

/** Full marketplace recipe row returned by `/v1/marketplace/recipes`. Callers
 *  destructure what they need — the Worker always returns the
 *  complete shape so one type covers every consumer. */
export interface MarketplaceRecipeRow {
  recipe_id: string;
  name: string;
  description: string;
  tags: string[];
  platforms: string[];
  download_count: number;
  /** Present when the recipe is part of a cross-platform family. */
  variant_group?: string;
}

/** Pagination metadata surfaced on list responses. */
export interface MarketplacePagination {
  page: number;
  per_page: number;
  total_items: number;
  total_pages: number;
  has_next: boolean;
}

/** Typed parameters for `listRecipes`. Each field maps to a query
 *  string key; `undefined`/empty values are omitted so the URL stays
 *  clean. Array fields are serialised comma-separated, matching the
 *  Worker's expectations.
 *
 *  `platforms` + `platform` coexist because the Worker accepts both:
 *  the plural form filters by any-of overlap, the singular is a
 *  shortcut. Callers use whichever matches their intent. */
export interface ListRecipesParams {
  /** Any-of platform filter. `['hubspot','salesforce']` → `?platforms=hubspot,salesforce`. */
  platforms?: string[];
  /** Single-platform convenience (legacy helper for `fetchSuggestions`). */
  platform?: string;
  /** Explicit recipe_id set — used by the install page to fetch
   *  browsed-boost rows. */
  recipeIds?: string[];
  /** Free-text tag filter (any-of). */
  tags?: string[];
  /** Page size (Worker caps at 100). */
  perPage?: number;
  /** 1-based page number. */
  page?: number;
}

/** Assemble a URLSearchParams from the typed list params, omitting
 *  empty fields. Kept as its own function so handlers that want to
 *  inspect the final URL for logging can reuse it. */
const toSearchParams = (params: ListRecipesParams): URLSearchParams => {
  const sp = new URLSearchParams();
  if (params.platforms && params.platforms.length > 0) {
    sp.set('platforms', params.platforms.join(','));
  }
  if (params.platform) sp.set('platform', params.platform);
  if (params.recipeIds && params.recipeIds.length > 0) {
    sp.set('recipe_ids', params.recipeIds.join(','));
  }
  if (params.tags && params.tags.length > 0) sp.set('tags', params.tags.join(','));
  if (params.perPage !== undefined) sp.set('per_page', String(params.perPage));
  if (params.page !== undefined) sp.set('page', String(params.page));
  return sp;
};

/** List published recipes, paginated. Single entry point for every
 *  caller that scans the marketplace (sidebar suggestions, install
 *  starter pack, browsed-boost fetch). Returns an empty list on
 *  non-2xx responses so callers can degrade gracefully; callers that
 *  need to distinguish network errors from empty results can check
 *  the returned `pagination` (absent on failure). */
export const listRecipes = async (
  params: ListRecipesParams = {},
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ rows: MarketplaceRecipeRow[]; pagination?: MarketplacePagination }> => {
  const sp = toSearchParams(params);
  const url = `${MARKETPLACE_URL}/v1/marketplace/recipes${sp.toString() ? `?${sp}` : ''}`;
  const res = await fetchFn(url, { headers: jsonHeaders });
  if (!res.ok) return { rows: [] };
  const body = await res.json() as ListEnvelope<MarketplaceRecipeRow>;
  return {
    rows: body.data ?? [],
    pagination: body.meta?.pagination,
  };
};

/** D-116 Phase 5 — list reactive-recipe templates from `/v1/marketplace/templates`.
 *  The Worker filters by `template:reactive:<vertical>` tag + the
 *  authorised `recued-core` publisher; this client just forwards the
 *  optional vertical filter.
 *
 *  Empty list on non-2xx (consistent with `listRecipes`). Templates
 *  are public and don't paginate today (max 50 rows per the Worker),
 *  so we return just `{ rows }` without pagination metadata. */
export interface ListTemplatesParams {
  /** Filter by template vertical (e.g. `mail`, `calendar`, `webhook`,
   *  `cross-tool`). Omit to return all templates. */
  vertical?: string;
}

export const listTemplates = async (
  params: ListTemplatesParams = {},
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ rows: MarketplaceRecipeRow[] }> => {
  const sp = new URLSearchParams();
  if (params.vertical) sp.set('vertical', params.vertical);
  const url = `${MARKETPLACE_URL}/v1/marketplace/templates${sp.toString() ? `?${sp}` : ''}`;
  const res = await fetchFn(url, { headers: jsonHeaders });
  if (!res.ok) return { rows: [] };
  const body = await res.json() as ListEnvelope<MarketplaceRecipeRow>;
  return { rows: body.data ?? [] };
};

/** Lightweight recipe summary for suggestions/search. Subset of
 *  `MarketplaceRecipeRow` preserved for backward compat. */
export type RecipeSuggestion = Pick<
  MarketplaceRecipeRow,
  'recipe_id' | 'name' | 'description' | 'tags'
>;

/** Fetch published recipes by platform, ordered by download count.
 *  Thin wrapper over `listRecipes` for existing callers. */
export const fetchSuggestions = async (
  platform?: string,
  limit = 20,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<RecipeSuggestion[]> => {
  const { rows } = await listRecipes({ platform, perPage: limit }, fetchFn);
  return rows;
};
