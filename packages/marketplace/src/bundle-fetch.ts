/** D-119 Phase 2 — bundle fetch + publish-time gate.
 *
 *  Companion to `client.ts`. The Phase 2 install paths talk to two
 *  kinds of remote endpoints:
 *
 *    - **Marketplace** (existing) — `fetchRecipeBySlug` returns the
 *      bare `RecipeDefinition`; ingredients resolve separately. No
 *      bundle envelope, no signature.
 *    - **Third-party URL** (new — this file) — `fetchBundleByUrl`
 *      pulls a JSON bundle from any URL the user pastes. Honors
 *      HTTP redirects (the fetch default), returns the *final* URL
 *      so the caller can derive the vault scope from the host the
 *      bundle actually came from. Falls through cleanly when the
 *      URL serves a bare recipe — `parseBundle` auto-wraps it.
 *
 *  The publish-time gate is the symmetric guard on the inbound side:
 *  marketplace uploads must be plain recipes, never bundles, so we
 *  reject any submission that carries `ingredients` / `signature` /
 *  `bundle_version` siblings.
 */

import type { RecipeBundle } from '@recued/contracts';
import { parseBundle } from '@recued/recipes';
import type { ValidationIssue } from '@recued/recipes';

// ────────────────────────────────────────────────────────────────
// fetchBundleByUrl
// ────────────────────────────────────────────────────────────────

/** Result of a successful URL fetch. `finalUrl` reflects every
 *  redirect the runtime followed (`response.url` from fetch). The
 *  caller passes it to `deriveVaultScope({ kind: 'bundle-remote',
 *  url: finalUrl, … })` so the vault scope key is anchored to the
 *  host that actually served the bundle, not a vanity-redirect URL
 *  the user happened to paste. */
export interface FetchedBundle {
  bundle: RecipeBundle;
  finalUrl: string;
}

/** Errors `fetchBundleByUrl` raises so callers can render targeted
 *  messages. The install UI maps these onto user-visible copy:
 *    - `network`        → "could not reach <host>"
 *    - `http`           → "<host> returned <status>"
 *    - `parse`          → "the URL did not return JSON we could read"
 *    - `validation`     → "JSON loaded but failed validation: <first issue>"
 */
export class BundleFetchError extends Error {
  constructor(
    public readonly kind: 'network' | 'http' | 'parse' | 'validation',
    message: string,
    public readonly details?: { status?: number; issues?: ValidationIssue[] },
  ) {
    super(message);
    this.name = 'BundleFetchError';
  }
}

/** Fetch a recipe bundle from a third-party URL. Honors HTTP
 *  redirects, parses JSON, runs `parseBundle` to validate. Falls
 *  through cleanly to bare-recipe payloads via `parseBundle`'s
 *  auto-wrapping path.
 *
 *  Always returns the *final* URL after redirects (`response.url`).
 *  Pass that into `normalizeUrlForVaultScope` / `deriveVaultScope`
 *  so the persisted vault scope reflects the host that served the
 *  bundle, not the shortener the user pasted. */
export const fetchBundleByUrl = async (
  url: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<FetchedBundle> => {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new BundleFetchError('network', `Could not reach ${url}: ${(e as Error).message ?? String(e)}`);
  }
  if (!res.ok) {
    throw new BundleFetchError('http', `Fetch failed: ${res.status} ${res.statusText}`, { status: res.status });
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new BundleFetchError('parse', 'Response was not valid JSON');
  }
  const parsed = parseBundle(json);
  if (!parsed.ok) {
    const first = parsed.issues.find((i) => i.severity === 'error');
    throw new BundleFetchError(
      'validation',
      `Bundle failed validation: [${first?.code ?? 'unknown'}] ${first?.message ?? '<no detail>'}`,
      { issues: parsed.issues },
    );
  }
  // `response.url` is the post-redirect URL on every fetch
  // implementation we target (browsers, undici / Node 20+, Cloudflare
  // Workers). Empty string only on early-rejected requests, which the
  // network/http branches above caught — but coalesce defensively.
  const finalUrl = res.url || url;
  return { bundle: parsed.recipe, finalUrl };
};

// ────────────────────────────────────────────────────────────────
// Publish-time gate
// ────────────────────────────────────────────────────────────────

/** Pure check that a marketplace publish payload is a plain recipe,
 *  not a recipe bundle. The marketplace registry expects per-slug
 *  `recipes` and `ingredients` rows; bundles bypass that and hide
 *  ingredient versions behind a recipe submission. The gate makes
 *  the invariant load-bearing on the inbound side. */
export type PublishGateResult =
  | { ok: true }
  | { ok: false; code: 'BUNDLE_NOT_PUBLISHABLE'; reason: string; field: string };

const BUNDLE_RESERVED_FIELDS = ['ingredients', 'signature', 'bundle_version'] as const;

/** Reject submissions that look like a `RecipeBundle`. The marketplace
 *  publish endpoint accepts a bare `RecipeDefinition` only — anyone
 *  publishing a bundle should split it into a recipe + per-ingredient
 *  publishes through the dedicated endpoints. */
export const assertPlainRecipeSubmission = (body: unknown): PublishGateResult => {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: true };
  }
  const obj = body as Record<string, unknown>;
  for (const field of BUNDLE_RESERVED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(obj, field) && obj[field] !== undefined) {
      return {
        ok: false,
        code: 'BUNDLE_NOT_PUBLISHABLE',
        reason: `Marketplace submissions must not carry bundle field '${field}'. Publish the recipe and each ingredient separately.`,
        field,
      };
    }
  }
  return { ok: true };
};
