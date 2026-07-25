/** D-164 P4g-2 — bundle manifest fetcher (HTTP + parser).
 *
 *  Adds the recued.com fetch leg to the bundle pool. The fetcher is
 *  an injected seam (`BundleFetcher` interface) so the production
 *  path uses HTTPS + `globalThis.fetch`, tests use synthetic
 *  responses, and offline / cached paths (P4g-3 on-disk store) plug
 *  in later without touching the bundle pool or the load helper.
 *
 *  Manifest schema (P4g-2 scope — single shape, no version field
 *  beyond `version: string`):
 *    ```json
 *    {
 *      "version": "2026-05-25-001",
 *      "entries": [
 *        { "template": { ...RenderTemplate }, "locale": "en" },
 *        ...
 *      ]
 *    }
 *    ```
 *  Each entry's `template.template_hash` is verified by the pool's
 *  `createBundlePool` at registration time (P4g-1): the per-template
 *  content-addressing IS the integrity model — an attacker swapping
 *  bodies would have to keep `(body, locale, slot_grammar) → hash`
 *  consistent, which they can't fake without computing real hashes.
 *
 *  Manifest-level integrity (the top-level JSON envelope) relies on
 *  **TLS as the trust layer** in P4g-2. An attacker who can MITM the
 *  HTTPS connection can swap one valid manifest for another valid
 *  manifest (with consistent per-template hashes). Defending against
 *  that requires a signed manifest (recued.com's signing key) +
 *  client-side signature verification — out of scope for this slice;
 *  earmarked for a follow-on if the threat model demands it. The
 *  pinned-public-key / cert-pinning route is the lighter alternative
 *  if TLS-CA trust isn't acceptable.
 *
 *  Error handling: every failure path throws `BundleFetchError` with
 *  a `reason` discriminator (`network_error` / `http_error` /
 *  `parse_error` / `schema_invalid`). Callers (boot path) decide
 *  whether to retry, fall back to on-disk cache (P4g-3), or fail
 *  the boot. The error carries `detail` strings whose caller-
 *  supplied content is JSON.stringify'd (same log-forgery defense
 *  as `BundlePoolError`).
 *
 *  See: D-164
 *  § 1 templates/bundle / § 3 the deterministic gate (bundle path:
 *  recued.com hash-pinned, content-addressed, verifiable). */

import type { BundleEntryInput } from './validate.js';

/** Top-level manifest shape recued.com publishes. The `version` is
 *  opaque to the fetcher (passed through to callers for diagnostics
 *  + future cache-invalidation logic); the `entries` carry the real
 *  payload that flows into `createBundlePool`. */
export interface BundleManifest {
  readonly version: string;
  readonly entries: ReadonlyArray<BundleEntryInput>;
}

/** Subset of the Fetch API the fetcher relies on. Mirrors `globalThis.fetch`
 *  for production wiring; tests inject a synthetic implementation. */
export type HttpClient = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/** Public interface every fetcher implementation satisfies. The
 *  shape stays minimal so on-disk / signed / streaming variants can
 *  fit the same seam later without contract churn. */
export interface BundleFetcher {
  /** Fetch the latest manifest. Throws `BundleFetchError` on any
   *  failure; never returns a partial / null manifest. */
  fetchManifest(): Promise<BundleManifest>;
}

/** Discriminator for `BundleFetchError.reason`.
 *
 *  - `network_error` — upstream transport failure (rejected fetch,
 *    DNS resolution miss, missing fetch implementation).
 *  - `http_error` — upstream responded with a non-2xx status.
 *  - `parse_error` — response or cache body wasn't valid JSON.
 *  - `schema_invalid` — JSON parsed but didn't match the manifest
 *    shape contract.
 *  - `disk_error` — local filesystem operation failed (read, write,
 *    rename, mkdir). Used by the on-disk store (`./store.ts`); the
 *    fetcher itself never produces this reason.
 *  - `cache_empty` — `createStoreBackedFetcher` saw a store with no
 *    cached manifest (cold boot before the first poller tick lands).
 *    Distinct from `network_error` so callers can branch on "the
 *    upstream didn't run yet" vs "the upstream actually failed." */
export type BundleFetchErrorReason =
  | 'network_error'
  | 'http_error'
  | 'parse_error'
  | 'schema_invalid'
  | 'disk_error'
  | 'cache_empty';

/** Thrown by any fetcher path that can't produce a valid manifest.
 *  Carries the structured reason + a free-form detail (caller-
 *  supplied values JSON.stringify'd so newlines / control chars
 *  can't forge extra log lines). `status` is present only for
 *  `http_error` (`fetch` resolved with a non-2xx response). */
export class BundleFetchError extends Error {
  readonly reason: BundleFetchErrorReason;
  readonly detail: string;
  declare readonly status?: number;

  constructor(opts: {
    readonly reason: BundleFetchErrorReason;
    readonly detail: string;
    readonly status?: number;
  }) {
    super(`bundle fetch ${opts.reason}: ${opts.detail}`);
    this.name = 'BundleFetchError';
    this.reason = opts.reason;
    this.detail = opts.detail;
    if (opts.status !== undefined) {
      this.status = opts.status;
    }
  }
}

// ── Manifest parser ──────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isString = (value: unknown): value is string => typeof value === 'string';

/** Parse a raw JSON value into a typed `BundleManifest`. Pure /
 *  synchronous. Throws `BundleFetchError` with `reason: 'schema_invalid'`
 *  on any shape mismatch — the error's `detail` names the offending
 *  field path so boot logs can pinpoint the bad row.
 *
 *  Shallow validation only: top-level `{version, entries}` shape,
 *  per-entry `{template: object, locale: string}` shape. The deep
 *  per-template validation (kind / action_class / hash) is the
 *  bundle pool's job (`validateBundleEntry`). This parser single-
 *  throws on the first manifest-shape violation; callers only reach
 *  pool aggregate validation after every entry clears the shallow
 *  boundary. */
export const parseBundleManifest = (raw: unknown): BundleManifest => {
  if (!isObject(raw)) {
    throw new BundleFetchError({
      reason: 'schema_invalid',
      detail: `manifest root must be an object, got ${typeof raw}`,
    });
  }
  if (!isString(raw['version']) || raw['version'].length === 0) {
    throw new BundleFetchError({
      reason: 'schema_invalid',
      detail: `manifest.version must be a non-empty string, got ${JSON.stringify(raw['version'])}`,
    });
  }
  const entriesRaw = raw['entries'];
  if (!Array.isArray(entriesRaw)) {
    throw new BundleFetchError({
      reason: 'schema_invalid',
      detail: `manifest.entries must be an array, got ${typeof entriesRaw}`,
    });
  }
  const entries: BundleEntryInput[] = [];
  entriesRaw.forEach((entry, index) => {
    if (!isObject(entry)) {
      throw new BundleFetchError({
        reason: 'schema_invalid',
        detail: `manifest.entries[${index}] must be an object, got ${typeof entry}`,
      });
    }
    // Snapshot the two property reads in a try/catch — JSON.parse
    // output is always plain data, but a direct parser call could
    // pass an object whose `template` / `locale` are throwing
    // accessors. Re-thrown as `schema_invalid` so the parser's
    // contract ("throws only BundleFetchError") holds for all
    // callers, not just the HTTP path.
    let templateRaw: unknown;
    let localeRaw: unknown;
    try {
      templateRaw = entry['template'];
      localeRaw = entry['locale'];
    } catch (err) {
      throw new BundleFetchError({
        reason: 'schema_invalid',
        detail: `manifest.entries[${index}]: property access threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (!isObject(templateRaw)) {
      throw new BundleFetchError({
        reason: 'schema_invalid',
        detail: `manifest.entries[${index}].template must be an object, got ${typeof templateRaw}`,
      });
    }
    if (!isString(localeRaw) || localeRaw.length === 0) {
      throw new BundleFetchError({
        reason: 'schema_invalid',
        detail: `manifest.entries[${index}].locale must be a non-empty string, got ${JSON.stringify(localeRaw)}`,
      });
    }
    // The template's full shape is the bundle pool's responsibility;
    // here we hand it through as the union `Template` and let
    // `validateBundleEntry` deep-check kind / fields / hash. The
    // `unknown` hop is required because the strict structural-types
    // check rejects the direct cast from `Record<string, unknown>`.
    entries.push({
      template: templateRaw as unknown as BundleEntryInput['template'],
      locale: localeRaw,
    });
  });
  return {
    version: raw['version'],
    entries,
  };
};

// ── HTTP fetcher ─────────────────────────────────────────────────

export interface CreateHttpBundleFetcherOptions {
  /** Manifest URL — absolute HTTPS URL of the recued.com manifest endpoint. */
  readonly url: string;
  /** Injectable HTTP client. Defaults to `globalThis.fetch`. Tests
   *  pass a synthetic implementation; production omits this. */
  readonly httpClient?: HttpClient;
}

/** Resolve the HTTP client at fetcher-construction time. Pulling
 *  `globalThis.fetch` here (rather than at call time) lets a test
 *  that monkeys with the global between fetches see the change only
 *  for fresh fetchers — explicit injection is the test path. */
const resolveHttpClient = (httpClient?: HttpClient): HttpClient => {
  if (httpClient !== undefined) return httpClient;
  const global = globalThis.fetch;
  if (typeof global !== 'function') {
    throw new BundleFetchError({
      reason: 'network_error',
      detail: 'no fetch implementation available — pass httpClient explicitly',
    });
  }
  return global;
};

/** Parse + validate the manifest URL at construction time. HTTPS-only
 *  per the design's TLS-as-integrity-layer assumption (an http://
 *  fetcher would silently drop the integrity guarantee). Returns the
 *  canonical `.href` form for downstream `fetch` calls so any URL
 *  normalisation the spec applies happens once, here. */
const parseManifestUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new BundleFetchError({
      reason: 'network_error',
      detail: `invalid manifest URL ${JSON.stringify(raw)}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (url.protocol !== 'https:') {
    throw new BundleFetchError({
      reason: 'network_error',
      detail: `manifest URL must use https:, got ${JSON.stringify(url.protocol)}`,
    });
  }
  return url.href;
};

/** Build an HTTPS-backed `BundleFetcher`. The fetcher is stateless;
 *  every `fetchManifest` call issues a fresh GET (caching belongs in
 *  P4g-3's on-disk store + poller, not here). The manifest URL is
 *  validated + canonicalised at construction so misconfiguration
 *  fails the boot fast rather than at first request. */
export const createHttpBundleFetcher = (
  options: CreateHttpBundleFetcherOptions,
): BundleFetcher => {
  const url = parseManifestUrl(options.url);
  const httpClient = resolveHttpClient(options.httpClient);
  return {
    async fetchManifest(): Promise<BundleManifest> {
      let response: Response;
      try {
        response = await httpClient(url);
      } catch (err) {
        throw new BundleFetchError({
          reason: 'network_error',
          detail: `GET ${JSON.stringify(url)}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      if (!response.ok) {
        throw new BundleFetchError({
          reason: 'http_error',
          detail: `GET ${JSON.stringify(url)} returned ${response.status} ${JSON.stringify(response.statusText)}`,
          status: response.status,
        });
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch (err) {
        throw new BundleFetchError({
          reason: 'parse_error',
          detail: `manifest body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return parseBundleManifest(json);
    },
  };
};
