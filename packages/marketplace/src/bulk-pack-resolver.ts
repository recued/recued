/** D-122 Phase 4 — bulk-pack manifest resolver.
 *
 *  Companion to `client.ts` for bulk-install packs. Two responsibilities:
 *
 *  1. **Fetch by slug** — `fetchBulkPackBySlug` pulls the apex install artifact
 *     `${MARKETPLACE_APEX_URL}/packs/<slug>.json` (the CDN-cached, KV-mirrored
 *     static manifest — NOT the raw DB worker) and reads it bare-or-enveloped by
 *     shape. Returns `null` on 404 so callers can render "pack not found"
 *     without try/catch on a normal flow path.
 *  2. **Resolve constituent recipes** — `resolveBulkPack` expands a
 *     parsed manifest into concrete `MarketplaceRecipeResult` entries
 *     by calling `fetchRecipeBySlug` for each slug. Surfaces per-recipe
 *     resolution failures (404, version drift) on the result so the
 *     dialog can render "this pack references a recipe that no longer
 *     exists" before the user clicks install.
 *
 *  Validation lives in `parseBulkPackManifest` from `@recued/contracts`.
 *  The atomic install transaction lives in `@recued/engine`. This file
 *  is the network-boundary layer.
 */

import {
  BULK_PACK_MANIFEST_VERSION_V2,
  parseBulkPackManifest,
  type BulkPackIssue,
  type BulkPackManifest,
} from '@recued/contracts';
import {
  fetchRecipeBySlug,
  manifestFetchHeaders,
  MARKETPLACE_APEX_URL,
  type ManifestFetchOptions,
  type MarketplaceRecipeResult,
} from './client.js';

/** Errors `fetchBulkPackBySlug` raises so install paths can render
 *  targeted messages.
 *
 *    - `network`    → could not reach marketplace
 *    - `http`       → non-404 HTTP error from Worker
 *    - `parse`      → response was not JSON
 *    - `validation` → JSON parsed but failed pack validation
 *    - `version`    → manifest_version newer than runtime understands
 *
 *  `validation` is split out from `version` so the install dialog can
 *  emit a "your extension is too old, update to install this pack"
 *  copy distinct from generic schema failures. */
export class BulkPackFetchError extends Error {
  constructor(
    public readonly kind: 'network' | 'http' | 'parse' | 'validation' | 'version',
    message: string,
    public readonly details?: { status?: number; issues?: BulkPackIssue[] },
  ) {
    super(message);
    this.name = 'BulkPackFetchError';
  }
}

/** Fetch a bulk-pack manifest from the marketplace by slug.
 *  Returns the parsed manifest on success, `null` on 404, throws
 *  `BulkPackFetchError` on every other failure. */
export const fetchBulkPackBySlug = async (
  slug: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  opts: ManifestFetchOptions = {},
): Promise<BulkPackManifest | null> => {
  const url = `${MARKETPLACE_APEX_URL}/packs/${encodeURIComponent(slug)}.json`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers: manifestFetchHeaders(opts.install === true) });
  } catch (e) {
    throw new BulkPackFetchError(
      'network',
      `Could not reach marketplace: ${(e as Error).message ?? String(e)}`,
    );
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new BulkPackFetchError(
      'http',
      `Marketplace fetch failed: ${res.status} ${res.statusText}`,
      { status: res.status },
    );
  }
  let json: unknown;
  try {
    const body = (await res.json()) as Record<string, unknown> | null;
    // The apex serves a BARE manifest; the legacy DB worker wrapped it in
    // `{ data, meta }`. Disambiguate by SHAPE (top-level `manifest_version`),
    // not field presence — identical to `fetchBulkPackByUrl` below — so a bare
    // manifest carrying its own top-level `data` field is never mis-unwrapped.
    json =
      body !== null && typeof body === 'object' && 'manifest_version' in body
        ? body
        : (body?.data ?? body);
  } catch {
    throw new BulkPackFetchError('parse', 'Marketplace response was not valid JSON');
  }
  // Front-run the parser with a version check so we can emit the
  // dedicated "extension too old" error when a future-versioned pack
  // shows up. The parser would also reject this, but its error code
  // (`pack_version_unsupported`) reads as a schema failure rather than
  // an upgrade prompt. D-165 — v1 + v2 are both supported; only a version
  // STRICTLY NEWER than the current max (v2) is an upgrade-prompt case.
  const manifestVersion =
    json != null && typeof json === 'object'
      ? (json as { manifest_version?: unknown }).manifest_version
      : undefined;
  if (typeof manifestVersion === 'number' && manifestVersion > BULK_PACK_MANIFEST_VERSION_V2) {
    throw new BulkPackFetchError(
      'version',
      `Pack manifest_version ${manifestVersion} is newer than this runtime supports (max ${BULK_PACK_MANIFEST_VERSION_V2}). Update Recued to install this pack.`,
    );
  }
  const parsed = parseBulkPackManifest(json);
  if (!parsed.ok) {
    const first = parsed.issues.find((i) => i.severity === 'error');
    throw new BulkPackFetchError(
      'validation',
      first?.message ?? 'Pack manifest failed validation',
      { issues: parsed.issues },
    );
  }
  return parsed.manifest;
};

/** Fetch a bulk-pack manifest from a DIRECT URL — an unofficial pack the user
 *  pastes into Add-a-pack (a raw GitHub link, a self-hosted file, etc.). The
 *  network-boundary twin of {@link fetchBulkPackBySlug}: same validation +
 *  `BulkPackFetchError` contract (`network` / `http` / `parse` / `version` /
 *  `validation`), mirroring `fetchRecipeByUrl` in `client.ts`. Two differences
 *  from the slug fetch:
 *
 *    1. **No 404 → `null`.** The slug path returns `null` on 404 so an install
 *       UI can render "not found" on a normal flow. A user-typed URL that 404s
 *       is a wrong URL — a hard `http` error worth surfacing, not a silent
 *       miss — so this always resolves a manifest or throws.
 *    2. **Bare OR enveloped body.** A direct file returns the manifest bare;
 *       a marketplace-style endpoint wraps it in `{ data, meta }`. We
 *       disambiguate by SHAPE (top-level `manifest_version`), not field
 *       presence — see the unwrap below — so a bare manifest carrying an
 *       unrelated top-level `data` field is never mis-read as an envelope.
 *
 *  SSRF NOTE: like `fetchRecipeByUrl`, this is a network-boundary helper, NOT
 *  an SSRF gate. The intended caller is the WEBCLIENT Add-a-pack paste field —
 *  a browser fetch from the user's own machine (the parsed manifest, not the
 *  URL, is what reaches the `packs.install` server rpc). This codebase guards
 *  SSRF per-site, not via one shared fetch: any FUTURE server-side caller that
 *  fetches a user-supplied URL MUST apply its own guard at the call site (e.g.
 *  `isPrivateOrLocalHost`, as `ask-landing-answer-link.ts` does) or inject a
 *  guarded `fetchFn`. This helper does not gate the URL itself. */
export const fetchBulkPackByUrl = async (
  url: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<BulkPackManifest> => {
  let res: Response;
  try {
    // Never marked: this is a local/side-loaded import from a user-supplied URL,
    // not an apex marketplace install, and the target is not ours to signal to.
    res = await fetchFn(url, { headers: manifestFetchHeaders(false) });
  } catch (e) {
    throw new BulkPackFetchError(
      'network',
      `Could not reach ${url}: ${(e as Error).message ?? String(e)}`,
    );
  }
  if (!res.ok) {
    throw new BulkPackFetchError(
      'http',
      `Fetch failed: ${res.status} ${res.statusText}`,
      { status: res.status },
    );
  }
  let json: unknown;
  try {
    const body = (await res.json()) as Record<string, unknown> | null;
    // Disambiguate a BARE manifest from a marketplace `{ data, meta }` envelope
    // by SHAPE, not field presence: every manifest carries a top-level
    // `manifest_version` (required on both v1 + v2) while the envelope nests it
    // under `data`. `parseBulkPackManifest` ignores unknown top-level fields, so
    // a `body?.data ?? body` coalesce would mis-unwrap a valid bare manifest
    // that happened to carry its own top-level `data` field — this shape gate
    // does not.
    json =
      body !== null && typeof body === 'object' && 'manifest_version' in body
        ? body
        : (body?.data ?? body);
  } catch {
    throw new BulkPackFetchError('parse', `Response from ${url} was not valid JSON`);
  }
  // Mirror the slug fetch's front-run version check so a future-versioned pack
  // gets the dedicated "update Recued" message rather than a generic schema
  // failure (D-165 — only STRICTLY newer than the current max v2).
  const manifestVersion =
    json != null && typeof json === 'object'
      ? (json as { manifest_version?: unknown }).manifest_version
      : undefined;
  if (typeof manifestVersion === 'number' && manifestVersion > BULK_PACK_MANIFEST_VERSION_V2) {
    throw new BulkPackFetchError(
      'version',
      `Pack manifest_version ${manifestVersion} is newer than this runtime supports (max ${BULK_PACK_MANIFEST_VERSION_V2}). Update Recued to install this pack.`,
    );
  }
  const parsed = parseBulkPackManifest(json);
  if (!parsed.ok) {
    const first = parsed.issues.find((i) => i.severity === 'error');
    throw new BulkPackFetchError(
      'validation',
      first?.message ?? 'Pack manifest failed validation',
      { issues: parsed.issues },
    );
  }
  return parsed.manifest;
};

/** Per-recipe resolution outcome inside `resolveBulkPack`. */
export interface ResolvedPackRecipe {
  slug: string;
  /** The version pinned in the pack manifest. */
  pinned_version: number;
  /** The full recipe row the marketplace returned, or `null` if the
   *  recipe could not be fetched (404, network, or version drift). */
  recipe: MarketplaceRecipeResult | null;
  /** Resolution-failure cause when `recipe === null`.
   *
   *  - `'not_found'` — slug is not in the marketplace
   *  - `'version_drift'` — slug exists but at a different version than
   *    the pack pinned. The dialog can still proceed (user accepts the
   *    new version) but should warn first
   *  - `'fetch_error'` — network or HTTP error; install can't proceed */
  failure?: 'not_found' | 'version_drift' | 'fetch_error';
  /** When `failure === 'fetch_error'`, the underlying error message. */
  error_message?: string;
}

/** Resolution result — one entry per `manifest.recipes[]` slug. */
export interface BulkPackResolution {
  manifest: BulkPackManifest;
  recipes: ResolvedPackRecipe[];
  /** True if every recipe resolved cleanly (no `failure`). The atomic
   *  install transaction refuses to start otherwise. */
  ready: boolean;
}

/** Expand a parsed manifest into resolved recipe rows. Calls
 *  `fetchRecipeBySlug` for each entry; collects per-recipe outcomes
 *  rather than failing fast so the dialog can show the user every
 *  blocker at once. */
export const resolveBulkPack = async (
  manifest: BulkPackManifest,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<BulkPackResolution> => {
  const resolved: ResolvedPackRecipe[] = await Promise.all(
    manifest.recipes.map(async ({ slug, version }): Promise<ResolvedPackRecipe> => {
      try {
        const row = await fetchRecipeBySlug(slug, fetchFn);
        if (row == null) {
          return { slug, pinned_version: version, recipe: null, failure: 'not_found' };
        }
        if (row.version !== version) {
          return {
            slug,
            pinned_version: version,
            recipe: row,
            failure: 'version_drift',
          };
        }
        return { slug, pinned_version: version, recipe: row };
      } catch (e) {
        return {
          slug,
          pinned_version: version,
          recipe: null,
          failure: 'fetch_error',
          error_message: (e as Error).message ?? String(e),
        };
      }
    }),
  );
  const ready = resolved.every((r) => r.failure == null);
  return { manifest, recipes: resolved, ready };
};
