/** D-323 — the server's own copy of the marketplace catalogue, for the offers
 *  chat makes when nothing installed can do what the owner asked.
 *
 *  🔑 THE WORDS NEVER LEAVE THE SERVER (ruling P1). The server downloads the
 *  public `/catalog/packs.json` and `/catalog/recipes.json`, the same files for
 *  every server, with no query string, and searches them itself. recued.com sees
 *  a download, never what the owner asked for. (`/catalog/search` would see the
 *  words: that is how the web app's Discover searches, migration 029.)
 *
 *  ⛔ THE ROWS ARE OUTSIDE CONTENT. A name and tags are the publisher's words,
 *  and they reach the model. Each row is shape-checked and a bad one is dropped
 *  (as `catalog-client.ts` does in the web app); every string is length-capped,
 *  so a row cannot carry a page of text into the prompt. They gain no power from
 *  what they say: an offer is a link the owner presses, and the install still
 *  goes through the consent dialog.
 *
 *  Freshness follows the CDN's `max-age` (4 hours today), within bounds. A
 *  failed download keeps the last good copy and waits before trying again; with
 *  no copy at all (an offline or LAN-only server), there are no offers and chat
 *  answers as it did before D-323. */

import { MARKETPLACE_APEX_URL } from '@recued/marketplace';

/** A recipe as the catalogue lists it: the fields an offer needs. */
export interface CatalogueRecipeRow {
  readonly recipe_id: string;
  readonly name: string;
  readonly tags: ReadonlyArray<string>;
  readonly publisher_id: string;
  readonly publisher_certified: boolean;
  /** `<publisher>/<pack>`: the pack that installs it. Absent: it installs alone. */
  readonly recipe_bundle?: string;
}

/** A pack as the catalogue lists it. */
export interface CataloguePackRow {
  readonly slug: string;
  readonly name: string;
  readonly tags: ReadonlyArray<string>;
  readonly publisher_id: string;
  readonly publisher_certified: boolean;
}

export interface MarketplaceCatalogueSnapshot {
  readonly packs: ReadonlyArray<CataloguePackRow>;
  readonly recipes: ReadonlyArray<CatalogueRecipeRow>;
  /** Epoch ms of the download. */
  readonly fetched_at: number;
}

/** The longest name, slug or tag kept. Real ones are far shorter (the longest
 *  shipped name is under 100 characters); the cap is what a hostile row meets. */
export const CATALOGUE_TEXT_MAX = 160;
/** The most tags kept from one row. */
export const CATALOGUE_TAGS_MAX = 24;

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, CATALOGUE_TEXT_MAX);
};

const tags = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(text).filter((tag): tag is string => tag !== null).slice(0, CATALOGUE_TAGS_MAX)
    : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The pack rows a `/catalog/packs.json` body holds; a row that is not one is
 *  dropped. A body that is not a list holds none. */
export const parseCataloguePacks = (body: unknown): CataloguePackRow[] => {
  if (!Array.isArray(body)) return [];
  const rows: CataloguePackRow[] = [];
  for (const row of body) {
    if (!isRecord(row)) continue;
    const slug = typeof row.slug === 'string' && SLUG_RE.test(row.slug) ? row.slug : null;
    const name = text(row.name);
    const publisher = text(row.publisher_id);
    if (slug === null || name === null || publisher === null) continue;
    rows.push({
      slug,
      name,
      tags: tags(row.tags),
      publisher_id: publisher,
      publisher_certified: row.publisher_certified === true,
    });
  }
  return rows;
};

/** The recipe rows a `/catalog/recipes.json` body holds. */
export const parseCatalogueRecipes = (body: unknown): CatalogueRecipeRow[] => {
  if (!Array.isArray(body)) return [];
  const rows: CatalogueRecipeRow[] = [];
  for (const row of body) {
    if (!isRecord(row)) continue;
    const id = typeof row.recipe_id === 'string' && SLUG_RE.test(row.recipe_id) ? row.recipe_id : null;
    const name = text(row.name);
    const publisher = text(row.publisher_id);
    if (id === null || name === null || publisher === null) continue;
    const bundle = text(row.recipe_bundle);
    rows.push({
      recipe_id: id,
      name,
      tags: tags(row.tags),
      publisher_id: publisher,
      publisher_certified: row.publisher_certified === true,
      ...(bundle !== null ? { recipe_bundle: bundle } : {}),
    });
  }
  return rows;
};

/** How long a copy stays fresh when the CDN says nothing usable. */
export const CATALOGUE_DEFAULT_MAX_AGE_MS = 4 * 60 * 60 * 1000;
/** Bounds on the CDN's `max-age`: never fetched more than every 10 minutes,
 *  never kept unrefreshed past a day. */
export const CATALOGUE_MIN_MAX_AGE_MS = 10 * 60 * 1000;
export const CATALOGUE_MAX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** After a failed download, wait this long before the next try. */
export const CATALOGUE_RETRY_AFTER_MS = 10 * 60 * 1000;

/** The freshness a `Cache-Control` header gives, within bounds. */
export const catalogueMaxAgeMs = (cacheControl: string | null): number => {
  const match = cacheControl === null ? null : /(?:^|[,\s])max-age=(\d+)/.exec(cacheControl);
  const ms = match === null ? CATALOGUE_DEFAULT_MAX_AGE_MS : Number(match[1]) * 1000;
  if (!Number.isFinite(ms)) return CATALOGUE_DEFAULT_MAX_AGE_MS;
  return Math.min(CATALOGUE_MAX_MAX_AGE_MS, Math.max(CATALOGUE_MIN_MAX_AGE_MS, ms));
};

/** The response shape the catalogue needs: the bounded marketplace fetch's. */
export interface CatalogueResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type CatalogueFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<CatalogueResponse>;

export interface MarketplaceCatalogueOptions {
  /** The bounded marketplace fetch (`defaultMarketplaceFetch`): a deadline, a
   *  byte ceiling, redirects pinned to the origin. */
  readonly fetch: CatalogueFetch;
  /** The marketplace's origin. Defaults to the apex the install path reads. */
  readonly origin?: string;
  readonly now?: () => number;
  /** A failed download, said once per failure (the caller logs it). */
  readonly onError?: (error: unknown) => void;
}

export interface MarketplaceCatalogue {
  /** The copy held now, or `null` before the first download succeeds. Never
   *  waits. */
  current(): MarketplaceCatalogueSnapshot | null;
  /** Start a download in the background when the copy is missing or stale, and
   *  no download is running or waiting out a failure. Never waits. */
  ensureFresh(): void;
  /** Download now, unless one is running; settles when it ends. */
  refresh(): Promise<void>;
  /** The copy, waiting up to `waitMs` for the first download when there is
   *  none yet; a copy held is returned at once (and refreshed in the
   *  background when stale). Never waits while a failed download is being
   *  waited out, so an offline server is not slowed. */
  ready(waitMs: number): Promise<MarketplaceCatalogueSnapshot | null>;
}

/** The catalogue the offers search. One per server. */
export const createMarketplaceCatalogue = (
  options: MarketplaceCatalogueOptions,
): MarketplaceCatalogue => {
  const origin = (options.origin ?? MARKETPLACE_APEX_URL).replace(/\/+$/, '');
  const now = options.now ?? Date.now;
  let snapshot: MarketplaceCatalogueSnapshot | null = null;
  let freshUntil = 0;
  let retryAfter = 0;
  let inFlight: Promise<void> | null = null;

  // ⛔ No query string and nothing about the owner: the same two GETs from every
  // server. That is the whole privacy claim of ruling P1, so it is kept literal.
  const get = async (path: string): Promise<{ body: unknown; maxAge: number }> => {
    const response = await options.fetch(`${origin}${path}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`marketplace catalogue ${path}: HTTP ${String(response.status)}`);
    return { body: await response.json(), maxAge: catalogueMaxAgeMs(response.headers.get('cache-control')) };
  };

  const download = async (): Promise<void> => {
    try {
      const [packs, recipes] = await Promise.all([get('/catalog/packs.json'), get('/catalog/recipes.json')]);
      const parsedPacks = parseCataloguePacks(packs.body);
      const parsedRecipes = parseCatalogueRecipes(recipes.body);
      // An empty answer is not a catalogue: keep the copy held, as for a failure.
      if (parsedPacks.length === 0 && parsedRecipes.length === 0) {
        throw new Error('marketplace catalogue: both lists were empty');
      }
      const at = now();
      snapshot = { packs: parsedPacks, recipes: parsedRecipes, fetched_at: at };
      freshUntil = at + Math.min(packs.maxAge, recipes.maxAge);
      retryAfter = 0;
    } catch (error) {
      retryAfter = now() + CATALOGUE_RETRY_AFTER_MS;
      options.onError?.(error);
    }
  };

  const refresh = (): Promise<void> => {
    if (inFlight === null) {
      inFlight = download().finally(() => { inFlight = null; });
    }
    return inFlight;
  };

  const ensureFresh = (): void => {
    const at = now();
    if (inFlight !== null || at < retryAfter) return;
    if (snapshot !== null && at < freshUntil) return;
    void refresh();
  };

  return {
    current: () => snapshot,
    ensureFresh,
    refresh,
    ready: async (waitMs) => {
      if (snapshot !== null) {
        ensureFresh();
        return snapshot;
      }
      if (inFlight === null && now() < retryAfter) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
        // A wait must not keep a stopping server alive.
        (timer as { unref?: () => void }).unref?.();
      });
      await Promise.race([refresh(), waited]);
      clearTimeout(timer);
      return snapshot;
    },
  };
};
