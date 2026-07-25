/** Marketplace types.
 *
 *  This package is the interface between the extension and the web store
 *  where users browse, install, and publish recipes. It is intentionally
 *  thin: types + pluggable interfaces + pure helpers. Network transport
 *  lives in a later layer that implements `MarketplaceClient`.
 *
 *  The marketplace knows about two distinct shapes:
 *    - `MarketplaceListing` — what the store serves (metadata + optional
 *      recipe body). Listings are what search returns and what install
 *      consumes.
 *    - `InstalledRecipe` — what the extension tracks locally for each
 *      recipe the user has installed. Includes the installed recipe
 *      body (immutable until an explicit update) plus upstream check
 *      state so we can detect when an update is available.
 *
 *  A published recipe is immutable per version — if the publisher pushes
 *  a new version, it's a NEW listing with a higher `version` number. The
 *  extension never silently replaces installed recipes; users get
 *  prompted to accept updates.
 */

import type { RecipeDefinition } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Listing
// ────────────────────────────────────────────────────────────────

/** One published recipe entry in the marketplace. This is what the web
 *  store serves per recipe; search results return an array of these. */
export interface MarketplaceListing {
  recipe_id: string;
  /** Publisher scope — distinct publishers can publish recipes with the
   *  same recipe_id (forks). Install operations must track both together. */
  publisher_id: string;
  /** Monotonic integer. The publisher increments this on each update;
   *  the extension treats each version as an independent immutable unit. */
  version: number;
  /** Canonical hash (FNV-1a) of the recipe body. Used to detect whether
   *  the local install matches upstream byte-for-byte, and to detect
   *  local edits (fork). */
  recipe_hash: string;
  /** Copied from metadata.name. Stored at the listing level so search
   *  can filter without decompressing the recipe body. */
  name: string;
  /** Copied from metadata.description. */
  description: string;
  /** Copied from metadata.supported_platforms. */
  platforms: string[];
  /** Copied from metadata.tags. */
  tags: string[];
  /** Copied from metadata.author. */
  author: string;
  /** Epoch ms — when this version was first published. */
  published_at: number;
  /** Epoch ms — last time the listing metadata was touched (rating,
   *  download count, etc.). The recipe body itself is immutable. */
  updated_at: number;
  /** Number of installs across all users. Ballpark — the marketplace
   *  doesn't track exact counts for privacy. */
  download_count: number;
  /** Aggregated user feedback. `count === 0` means no ratings yet. */
  rating: {
    /** 0-5. Reported as 0 when `count === 0`. */
    average: number;
    count: number;
  };
  /** From metadata.variant_group. Links platform-specific variants so
   *  the user can discover cross-platform siblings. */
  variant_group: string | null;
  /** From metadata.fork_of. Populated when this listing is a fork of
   *  another published recipe. */
  fork_of: {
    recipe_id: string;
    publisher_id: string;
    version: number;
  } | null;
  /** The full recipe body. May be null in search results (the store can
   *  omit it to save bandwidth); a dedicated fetch returns the full
   *  listing with `recipe` populated. */
  recipe: RecipeDefinition | null;
  /** Content signature for integrity verification. Optional for now —
   *  populated when the signing layer is built. */
  signature: string | null;
}

// ────────────────────────────────────────────────────────────────
// Local install state
// ────────────────────────────────────────────────────────────────

/** What the extension persists about each installed recipe. */
export interface InstalledRecipe {
  recipe_id: string;
  publisher_id: string;
  /** The version the user installed. Does NOT change on silent update —
   *  users accept updates explicitly. */
  installed_version: number;
  /** Hash of the recipe as installed. Used to detect local edits (if
   *  the user forks via Kitchen, this stays the original hash until
   *  save; after save, the recipe is considered a local fork). */
  installed_hash: string;
  /** Epoch ms of the install. */
  installed_at: number;
  /** Snapshot of the recipe at install time. Immutable per install —
   *  upstream updates do not rewrite this field; the user accepts via a
   *  new install operation. */
  recipe: RecipeDefinition;
  /** Whether this recipe should auto-run on matching trigger pages.
   *  Set via "Install & Run" at install time; changeable in settings. */
  auto_run: boolean;
  /** Last time the extension checked the marketplace for an update to
   *  this recipe. Null if never checked since install. */
  last_checked_at: number | null;
  /** Upstream version observed at the last check. */
  upstream_version: number | null;
  /** Upstream hash observed at the last check. */
  upstream_hash: string | null;
}

/** Derived from comparing an `InstalledRecipe` to a fresh
 *  `MarketplaceListing`. */
export type UpdateStatus =
  | {
      /** Local install matches upstream — nothing to do. */
      state: 'current';
    }
  | {
      /** Upstream has a newer version than what's installed. */
      state: 'update_available';
      from: { version: number; hash: string };
      to: { version: number; hash: string };
    }
  | {
      /** The local copy has been edited; its hash no longer matches the
       *  published version the user installed. The user has effectively
       *  forked; we do not offer silent updates. */
      state: 'locally_forked';
      local_hash: string;
      upstream_hash: string;
    }
  | {
      /** Never checked upstream (or upstream is unreachable). */
      state: 'upstream_unknown';
    };

// ────────────────────────────────────────────────────────────────
// Search
// ────────────────────────────────────────────────────────────────

export type SortOrder = 'newest' | 'oldest' | 'popular' | 'rating' | 'updated';

/** Query sent to the marketplace search endpoint, or applied client-side
 *  over a cached listing set for offline search. */
export interface SearchQuery {
  /** Fuzzy text match against listing name + description. Case-insensitive. */
  text?: string;
  /** Must-have tags. A listing must include ALL specified tags. */
  tags?: string[];
  /** Must-have platforms. A listing must support AT LEAST ONE of the
   *  platforms. Omit to match any. */
  platforms?: string[];
  /** Filter by specific author (exact match). */
  author?: string;
  /** Minimum average rating. Listings with no ratings (count === 0) are
   *  included unless explicitly excluded. */
  min_rating?: number;
  /** Sort order. Default is 'popular'. */
  sort?: SortOrder;
  /** Max results to return. Default depends on the client. */
  limit?: number;
  /** Skip first N results (pagination). */
  offset?: number;
}

export interface SearchResult {
  listings: MarketplaceListing[];
  /** Total matching listings (may be larger than `listings.length`
   *  if pagination is in play). */
  total: number;
  /** Echo of the query for the UI. */
  query: SearchQuery;
}

// ────────────────────────────────────────────────────────────────
// Pluggable interfaces
// ────────────────────────────────────────────────────────────────

/** The marketplace transport. Concrete implementations talk to the web
 *  store via HTTP; tests use in-memory or fixture-backed impls. */
export interface MarketplaceClient {
  /** Search listings. Returns a paginated `SearchResult`. */
  search(query: SearchQuery): Promise<SearchResult>;
  /** Fetch one listing with the recipe body populated. Version defaults
   *  to the latest. */
  fetchListing(recipe_id: string, version?: number): Promise<MarketplaceListing>;
  /** Check the current upstream state for an installed recipe (lighter
   *  than fetchListing — skips the recipe body). */
  checkUpdate(recipe_id: string): Promise<{ version: number; hash: string } | null>;
  /** Publish a new version. The recipe must be valid — callers are
   *  expected to run parseRecipe before calling this. Returns the created
   *  listing. */
  publish(recipe: RecipeDefinition, opts: PublishOptions): Promise<MarketplaceListing>;
  /** Record an anonymous install event. Fire-and-forget. */
  recordInstall(recipe_id: string, publisher_id: string, version: number): Promise<void>;
  /** Submit a rating (1-5). The client may throttle or dedupe. */
  submitRating(recipe_id: string, publisher_id: string, version: number, rating: number): Promise<void>;
}

export interface PublishOptions {
  /** Required — identifies the publisher scope. Publishers can publish
   *  multiple recipes; each gets its own recipe_id. */
  publisher_id: string;
  /** Explicit version bump. Must be strictly greater than the previous
   *  published version for this recipe_id + publisher_id pair. */
  version: number;
  /** Optional notes about this release for the marketplace changelog. */
  release_notes?: string;
}

/** The local registry of installed recipes. Persistence-pluggable so the
 *  extension can back it with IndexedDB while tests use in-memory. */
export interface InstallRegistry {
  listInstalled(): Promise<InstalledRecipe[]>;
  getInstalled(recipe_id: string, publisher_id: string): Promise<InstalledRecipe | null>;
  /** Record a new install or replace a prior install with a newer version. */
  markInstalled(record: InstalledRecipe): Promise<void>;
  /** Delete an installed recipe from the registry. Idempotent. */
  markUninstalled(recipe_id: string, publisher_id: string): Promise<void>;
  /** Update the upstream check state for an installed recipe without
   *  changing the installed version. */
  recordUpstreamCheck(
    recipe_id: string,
    publisher_id: string,
    upstream: { version: number; hash: string },
    checked_at: number,
  ): Promise<void>;
  /** Total number of installed recipes. */
  size(): Promise<number>;
}
