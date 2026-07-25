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

import type {
  FetchedRemoteBundle,
  RedirectResolvedBundleUrl,
} from '@recued/contracts';
import { parseBundle } from '@recued/recipes';
import type { ValidationIssue } from '@recued/recipes';

// ────────────────────────────────────────────────────────────────
// fetchBundleByUrl
// ────────────────────────────────────────────────────────────────

/** Result of a successful URL fetch. `finalUrl` is opaque proof minted from
 *  `Response.url` after redirect processing; the install planner accepts the
 *  bundle and this URL together so vault scope cannot accidentally fall back
 *  to the vanity URL the user pasted. */
export type FetchedBundle = FetchedRemoteBundle;

/** Errors `fetchBundleByUrl` raises so callers can render targeted
 *  messages. The install UI maps these onto user-visible copy:
 *    - `network`        → "could not reach <host>"
 *    - `http`           → "<host> returned <status>"
 *    - `parse`          → "the URL did not return JSON we could read"
 *    - `validation`     → "JSON loaded but failed validation: <first issue>"
 *    - `redirect`       → "the response did not expose a usable final URL"
 */
export class BundleFetchError extends Error {
  constructor(
    public readonly kind: 'network' | 'http' | 'parse' | 'validation' | 'redirect',
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
 *  Always returns the *final* URL after redirects (`response.url`) bound to
 *  the parsed bundle. Pass the complete `FetchedBundle` to
 *  `planBundleInstall`; its remote-input branch derives vault scope from that
 *  final URL, not the shortener the user pasted. */
export const fetchBundleByUrl = async (
  url: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<FetchedBundle> => {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { Accept: 'application/json' },
      redirect: 'follow',
    });
  } catch (e) {
    throw new BundleFetchError('network', `Could not reach ${url}: ${(e as Error).message ?? String(e)}`);
  }
  if (!res.ok) {
    throw new BundleFetchError('http', `Fetch failed: ${res.status} ${res.statusText}`, { status: res.status });
  }
  const finalUrl = redirectResolvedBundleUrl(res.url);
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
  return { bundle: parsed.recipe, finalUrl };
};

/** Validate and brand the URL reported by the fetch response. Falling back to
 *  the request URL here would silently restore the redirect-scoping bug: the
 *  request URL says where lookup started, not which host served the bytes. */
const redirectResolvedBundleUrl = (value: string): RedirectResolvedBundleUrl => {
  if (value.length === 0) {
    throw new BundleFetchError(
      'redirect',
      'Bundle response did not expose its final URL after redirects',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BundleFetchError('redirect', 'Bundle response exposed an invalid final URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BundleFetchError(
      'redirect',
      `Bundle response used unsupported final URL protocol '${parsed.protocol}'`,
    );
  }
  return value as RedirectResolvedBundleUrl;
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
