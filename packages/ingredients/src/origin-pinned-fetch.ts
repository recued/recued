/** SSRF hardening — origin-pinned redirect following.
 *
 *  Every outbound `connection.*` data-plane call is bound to its
 *  enrolled endpoint origin (the api handler's `base_url`, the mcp
 *  handler's `endpoint`, an OAuth `token_endpoint`). The api handler
 *  enforces that pin on the INITIAL URL (the cross-origin guard) — but
 *  `fetch`'s default `redirect: 'follow'` silently defeats it: a `302
 *  Location: http://169.254.169.254/…` (cloud metadata) or any internal
 *  host returned by a compromised / open-redirect / malicious enrolled
 *  endpoint is followed automatically, and the response body flows back
 *  to the recipe (SSRF read + exfil). Worse, undici strips
 *  `Authorization` / `Cookie` on a cross-origin redirect but NOT custom
 *  header / query auth (`auth.type` `header` / `query` — e.g.
 *  `X-Api-Key`), so those credentials ride along to the attacker host.
 *
 *  This wrapper follows redirects MANUALLY with `redirect: 'manual'`
 *  (Node/undici returns the real 3xx + `Location`; the browser's opaque
 *  redirect never reaches the server runtime), honoring SAME-origin
 *  redirects (trailing-slash 301s, http→https on the same host) up to a
 *  small hop cap and REFUSING the first cross-origin hop with
 *  `CrossOriginRedirectError` — before the cross-origin request is ever
 *  issued, so no credential leaves the box and no internal request is
 *  made. Localhost / LAN / RFC1918 INITIAL targets stay allowed (the
 *  product intentionally talks to local LLMs + self-hosted APIs); only a
 *  redirect that CHANGES origin is refused. */

import { discardResponseBody } from './bounded-response-body.js';

/** Thrown when an enrolled endpoint redirects to a different origin, or
 *  loops past the same-origin hop cap. The caller maps it to its own
 *  ingredient error code (api → `URL_REF_INVALID`; refresh →
 *  `TOKEN_REFRESH_FAILED`). */
export class CrossOriginRedirectError extends Error {
  constructor(
    public readonly pinnedOrigin: string,
    public readonly attemptedOrigin: string,
  ) {
    super(
      `redirect refused: enrolled origin '${pinnedOrigin}' redirected to `
      + `'${attemptedOrigin}'`,
    );
    this.name = 'CrossOriginRedirectError';
  }
}

/** Thrown when a SAME-origin redirect chain exceeds the hop cap. Kept
 *  distinct from `CrossOriginRedirectError` so callers don't mislabel a
 *  misbehaving-but-same-origin endpoint as a cross-origin security
 *  refusal: callers leave this UNCAUGHT so it falls through to their
 *  normal network-failure handling (read → NETWORK_ERROR; write →
 *  ACTION_DELIVERY_UNCERTAIN — a looped 307/308 write may have committed
 *  at one hop despite never returning 2xx). */
export class RedirectLimitError extends Error {
  constructor(
    public readonly pinnedOrigin: string,
    public readonly maxHops: number,
  ) {
    super(`too many same-origin redirects from '${pinnedOrigin}' (cap ${maxHops})`);
    this.name = 'RedirectLimitError';
  }
}

const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Bounded same-origin redirect chain. APIs that legitimately redirect
 *  do so once or twice (canonicalization); 5 same-origin hops is well
 *  past any honest endpoint and bounds a same-origin redirect loop. */
const MAX_SAME_ORIGIN_HOPS = 5;

/** Fetch `url` (init applied) while pinning every redirect hop to
 *  `pinnedOrigin`. Same-origin 3xx are followed (re-issuing `init`
 *  verbatim — safe, the credentials are returning to the same trusted
 *  origin); the first cross-origin 3xx throws `CrossOriginRedirectError`.
 *  A 3xx with no / unparseable `Location` is returned as-is so the
 *  caller's status classifier handles it. */
export const fetchOriginPinned = async (
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  pinnedOrigin: string,
): Promise<Response> => {
  let currentUrl = url;
  let currentInit: RequestInit = init;
  for (let hop = 0; hop < MAX_SAME_ORIGIN_HOPS; hop += 1) {
    const response = await fetchImpl(currentUrl, { ...currentInit, redirect: 'manual' });
    if (!REDIRECT_STATUS.has(response.status)) return response;

    const location = response.headers.get('location');
    if (location === null || location === '') return response;

    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      // Unparseable Location — don't follow; let the caller classify
      // the raw 3xx (it surfaces as a NETWORK_ERROR downstream).
      return response;
    }

    if (next.origin !== pinnedOrigin) {
      discardResponseBody(response);
      throw new CrossOriginRedirectError(pinnedOrigin, next.origin);
    }
    // The redirect response itself is not returned to a caller. Release its
    // body before opening the next hop so a 3xx with an endless payload cannot
    // retain one socket per hop until garbage collection.
    discardResponseBody(response);
    currentUrl = next.toString();
    // RFC 9110 §15.4.4 — a 303 See Other turns the next request into a
    // GET with no body. 301/302/307/308 keep method + body (safe here:
    // same origin, string body reusable). Without this a 303 would
    // re-POST the body to the same-origin target a browser would GET.
    if (response.status === 303) {
      currentInit = { ...currentInit, method: 'GET', body: undefined };
    }
  }
  // Exhausted the same-origin hop budget — distinct from a cross-origin
  // refusal so callers route it through normal network-failure handling.
  throw new RedirectLimitError(pinnedOrigin, MAX_SAME_ORIGIN_HOPS);
};
