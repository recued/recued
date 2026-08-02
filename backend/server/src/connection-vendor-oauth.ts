/** D-129 Phase 1.2 — vendor OAuth code-exchange + scope introspection
 *  helpers, owning the wire format for the `completeVendorOAuth` rpc.
 *
 *  Two responsibilities:
 *    1. POST `code` + `client_id` (+ `client_secret` when required) to
 *       the vendor's `oauth.token_endpoint` and parse the response.
 *    2. When the vendor declares an `oauth.access_token_introspect_url`
 *       (HubSpot deviates from RFC 6749 § 3.3 by NOT echoing `scope` on
 *       the token-exchange response), GET the introspection endpoint
 *       with the freshly-minted access token to read the granted-scope
 *       set.
 *
 *  The rpc handler in `connection-handler.ts` composes these helpers
 *  and surfaces `{ refresh_token, granted_scopes }` to the enrollment
 *  dialog. No connection record is written here — the caller follows
 *  up with `collection.connection.enroll` once the user clicks Save,
 *  so a half-completed OAuth dance never leaves a phantom row behind.
 *
 *  Spec: D-129 § A.1 + P1.1 close memo step 6. */

import {
  isValidOAuthEndpointUrl,
  resolveVendorOAuthEndpoints,
  resolveVendorOAuthRuntimeBase,
  type ConnectionVendorProvider,
} from '@recued/contracts';
import {
  CrossOriginRedirectError,
  RedirectLimitError,
  ResponseBodyTooLargeError,
} from '@recued/ingredients';
import { makeBoundedOriginHttpFetcher } from './bounded-origin-http-fetcher.js';

/** Narrow http fetcher matching `collections/mail/oauth.ts` so tests
 *  can inject a fake without faking every `Response` method. */
export type HttpFetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Stable error code surface for the P1.2 helpers. The rpc handler
 *  translates each into an `RpcError` with `bad_request` (caller
 *  fixable: bad code, missing client_secret, vendor declined scope)
 *  vs `not_configured` (server-side: vendor returned malformed body). */
export type VendorOAuthErrorCode =
  | 'token_exchange_failed'
  | 'token_response_invalid'
  | 'missing_refresh_token'
  | 'introspect_failed';

export class VendorOAuthError extends Error {
  readonly code: VendorOAuthErrorCode;
  readonly status: number;
  constructor(code: VendorOAuthErrorCode, status: number, msg: string) {
    super(msg);
    this.name = 'VendorOAuthError';
    this.code = code;
    this.status = status;
  }
}

/** Production fetcher for the vendor token + introspection endpoints —
 *  native `fetch`, but redirects are followed MANUALLY and pinned to the
 *  requested URL's OWN origin (SSRF hardening, mirrors `connection-api`'s
 *  `refreshOAuth2`).
 *
 *  These endpoints are registry-pinned (a known vendor host from
 *  `ConnectionVendorProvider.oauth`), so the risk is low — but `fetch`'s
 *  default `redirect: 'follow'` would silently follow a server-driven
 *  `3xx Location: http://169.254.169.254/…` (cloud metadata) or any
 *  internal host returned by a compromised / open-redirect vendor
 *  endpoint, re-issuing the request — with the auth `code` + `client_secret`
 *  (token exchange) or the freshly-minted access token (introspection) —
 *  to the attacker host. Pinning to the call's own origin refuses the
 *  first cross-origin hop BEFORE that request leaves the box; same-origin
 *  redirects (the vendor's own trailing-slash / http→https canonicalization)
 *  are still honored.
 *
 *  Exported as a factory so tests can inject a native-`fetch` fake that
 *  returns real `Response` objects to exercise the redirect pin. The
 *  global `fetch` is resolved LAZILY per call (not captured at factory
 *  build) so the production `defaultFetcher` honors a test that stubs
 *  `globalThis.fetch` — proving the default path is pinned, not just the
 *  injected one. */
export const makeOriginPinnedFetcher = (
  fetchImpl?: typeof fetch,
): HttpFetcher => makeBoundedOriginHttpFetcher({
  ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  maxResponseBytes: 1024 * 1024,
});

const defaultFetcher: HttpFetcher = makeOriginPinnedFetcher();

interface VendorTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  /** Optional per RFC 6749 § 3.3 — vendors that follow spec echo the
   *  granted scopes back here. HubSpot omits this field; granted
   *  scopes for HubSpot come from the introspection endpoint instead. */
  scope?: string;
  /** Retained for the provider-declared runtime-base decoder. Keeping the raw
   * object (rather than opportunistically copying URL-looking fields) lets the
   * registry decide whether `instance_url` / `api_domain` has any authority. */
  raw: Readonly<Record<string, unknown>>;
}

const parseTokenResponse = (raw: unknown): VendorTokenResponse => {
  if (!raw || typeof raw !== 'object') {
    throw new VendorOAuthError(
      'token_response_invalid',
      500,
      'token endpoint returned non-object',
    );
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.access_token !== 'string' || obj.access_token.length === 0) {
    throw new VendorOAuthError(
      'token_response_invalid',
      500,
      'token endpoint missing access_token',
    );
  }
  const out: VendorTokenResponse = { access_token: obj.access_token, raw: obj };
  if (typeof obj.refresh_token === 'string' && obj.refresh_token.length > 0) {
    out.refresh_token = obj.refresh_token;
  }
  if (typeof obj.expires_in === 'number') out.expires_in = obj.expires_in;
  if (typeof obj.token_type === 'string') out.token_type = obj.token_type;
  if (typeof obj.scope === 'string' && obj.scope.length > 0) out.scope = obj.scope;
  return out;
};

const basicClientAuthHeader = (clientId: string, clientSecret: string): string =>
  `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;

/** Split an RFC 6749 § 3.3 `scope` string into a deduped string[].
 *  Handles space + comma separators (some providers use commas) and
 *  trims defensively. Empty / undefined input yields `[]`. */
export const parseScopeString = (raw: string | undefined): string[] => {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const v = part.trim();
    if (v.length === 0) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
};

/** Parse the granted-scope set from an introspection-endpoint response
 *  body. HubSpot's shape: `{ scopes: string[] }`. Future vendors that
 *  need introspection but use a different shape can extend this with
 *  per-vendor branches; today the only consumer is HubSpot. */
const parseIntrospectScopes = (raw: unknown): string[] => {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.scopes)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of obj.scopes) {
    if (typeof s !== 'string') continue;
    const v = s.trim();
    if (v.length === 0) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
};

export interface CompleteVendorOAuthOptions {
  provider: ConnectionVendorProvider;
  code: string;
  redirect_uri: string;
  client_id: string;
  client_secret?: string;
  /** D-130 — sandbox-mode flag. When `true` and the provider
   *  declares sandbox URLs, the code-exchange POSTs to
   *  `provider.oauth.sandbox_token_endpoint` instead of the
   *  production `token_endpoint`. Vendors with no sandbox split
   *  ignore the flag (HubSpot stays on production regardless).
   *  Defaults to `false` (production) when omitted. */
  sandbox?: boolean;
  /** PKCE `code_verifier` (RFC 7636). Present only for `supports_pkce`
   *  providers — sent as `code_verifier` in the token-exchange body so the
   *  provider binds the code to the flow whose `code_challenge` it was issued
   *  against. Absent ⇒ no PKCE param (HubSpot + the refresh path). */
  code_verifier?: string;
  fetcher?: HttpFetcher;
}

/** End-to-end: exchange the auth code for tokens, then resolve the
 *  granted scopes from either the token response (RFC-compliant
 *  vendors) or the introspection endpoint (HubSpot). Returns
 *  `{ refresh_token, granted_scopes, instance_url? }` — the access token
 *  is intentionally not surfaced (it expires in ~30min and the caller
 *  re-mints via the connection adapter's refresh path on first use).
 *
 *  D-130 P5 surfaces `instance_url` on the return shape — Salesforce
 *  emits it on every token / refresh response and Recued persists it
 *  to `connection.config.base_url` so subsequent REST + SOQL + CometD
 *  long-poll calls land at the right per-org host. Vendors without an
 *  instance_url field (HubSpot) leave the property `undefined`; the
 *  rpc handler skips the persistence step in that case.
 *
 *  Throws `VendorOAuthError` on any failure path; the rpc handler
 *  translates into `RpcError` for wire transport. Introspection
 *  failures are logged but not fatal — a missing-scopes scenario
 *  surfaces as `granted_scopes: []` so the dialog can warn the user
 *  to re-grant rather than blocking enrollment outright. */
export const completeVendorOAuth = async (
  opts: CompleteVendorOAuthOptions,
): Promise<{ refresh_token: string; granted_scopes: string[]; instance_url?: string }> => {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const { token_endpoint } = resolveVendorOAuthEndpoints(opts.provider, {
    sandbox: opts.sandbox,
  });
  if (!isValidOAuthEndpointUrl(token_endpoint)) {
    throw new VendorOAuthError(
      'token_exchange_failed',
      400,
      'token exchange refused: provider token endpoint must be a complete HTTPS URL with no embedded username or password and no URL fragment',
    );
  }

  const body = new URLSearchParams({
    code: opts.code,
    redirect_uri: opts.redirect_uri,
    grant_type: 'authorization_code',
  });
  const tokenAuthStyle = opts.provider.oauth.token_auth_style ?? 'body';
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (opts.client_secret && tokenAuthStyle === 'basic') {
    headers.Authorization = basicClientAuthHeader(opts.client_id, opts.client_secret);
  } else {
    body.set('client_id', opts.client_id);
    if (opts.client_secret) {
      body.set('client_secret', opts.client_secret);
    }
  }
  // PKCE: prove possession of the verifier whose challenge rode the authorize
  // URL — binds this code to the flow the user actually started.
  if (opts.code_verifier) {
    body.set('code_verifier', opts.code_verifier);
  }

  let tokenRes: Awaited<ReturnType<HttpFetcher>>;
  try {
    tokenRes = await fetcher(token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
  } catch (e) {
    // SSRF: a server-driven redirect off the token endpoint's origin was
    // refused by the origin-pinned fetcher BEFORE the `code` + client_secret
    // left the box. Surface as a clean exchange failure (the rpc handler
    // maps VendorOAuthError → bad_request) rather than an unmapped throw.
    if (e instanceof CrossOriginRedirectError || e instanceof RedirectLimitError) {
      throw new VendorOAuthError(
        'token_exchange_failed',
        502,
        `token exchange refused: ${e.message} — credentials not sent to the redirect target`,
      );
    }
    if (e instanceof ResponseBodyTooLargeError) {
      throw new VendorOAuthError(
        'token_response_invalid',
        502,
        `token endpoint response exceeded the ${e.maxBytes}-byte limit`,
      );
    }
    const isAbort = e instanceof Error && e.name === 'AbortError';
    throw new VendorOAuthError(
      'token_exchange_failed',
      isAbort ? 504 : 502,
      isAbort
        ? 'token exchange timed out while waiting for the vendor response'
        : `token exchange failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new VendorOAuthError(
      'token_exchange_failed',
      tokenRes.status,
      `token exchange failed (${tokenRes.status}): ${text.slice(0, 200)}`,
    );
  }
  let tokenBody: unknown;
  try {
    tokenBody = await tokenRes.json();
  } catch (e) {
    throw new VendorOAuthError(
      'token_response_invalid',
      502,
      `token endpoint returned malformed JSON: ${(e as Error).message}`,
    );
  }
  const parsed = parseTokenResponse(tokenBody);
  if (!parsed.refresh_token) {
    throw new VendorOAuthError(
      'missing_refresh_token',
      500,
      'token endpoint did not return a refresh_token — revoke access and retry with prompt=consent',
    );
  }

  let granted_scopes: string[] = [];
  if (parsed.scope) {
    granted_scopes = parseScopeString(parsed.scope);
  } else if (opts.provider.oauth.access_token_introspect_url) {
    granted_scopes = await introspectGrantedScopes(
      opts.provider.oauth.access_token_introspect_url,
      parsed.access_token,
      fetcher,
    );
  }

  // A token response can name the API host that will receive the bearer token
  // minted beside it. That is credential-destination authority, so only a
  // provider-declared field is honored, and it must resolve to an allowlisted
  // HTTPS origin. Providers such as QuickBooks compose their base from trusted
  // registry constants instead; an unexpected response field stays inert.
  const runtimeBase = resolveVendorOAuthRuntimeBase(opts.provider, parsed.raw);
  if (runtimeBase.status === 'missing') {
    throw new VendorOAuthError(
      'token_response_invalid',
      502,
      `token endpoint response missing required ${runtimeBase.field}`,
    );
  }
  if (runtimeBase.status === 'invalid') {
    throw new VendorOAuthError(
      'token_response_invalid',
      502,
      `token endpoint returned invalid ${runtimeBase.field}: ${runtimeBase.reason}`,
    );
  }

  return {
    refresh_token: parsed.refresh_token,
    granted_scopes,
    ...(runtimeBase.status === 'valid' ? { instance_url: runtimeBase.base_url } : {}),
  };
};

/** Read the granted-scope set from the vendor's access-token
 *  introspection endpoint. HubSpot's URL pattern is
 *  `<base>/<access_token>` — the access token is path-positional and
 *  serves both as the resource id and the bearer credential.
 *
 *  Soft-failure semantics: a 4xx / 5xx response, malformed JSON, or
 *  a missing `scopes` field all return `[]`. The token exchange
 *  already succeeded; the user has a valid refresh token, just no
 *  visibility into which scopes the vendor actually granted. The
 *  enrollment dialog surfaces this as a "scope verification failed —
 *  reconcilers may register conservatively" warning. */
const introspectGrantedScopes = async (
  introspect_url: string,
  access_token: string,
  fetcher: HttpFetcher,
): Promise<string[]> => {
  // The access token is itself a credential and becomes path material below.
  // Keep introspection's documented soft-failure semantics, but never call an
  // unsafe endpoint even if a restored/provider object bypassed registry checks.
  if (!isValidOAuthEndpointUrl(introspect_url)) return [];
  const url = `${introspect_url}/${encodeURIComponent(access_token)}`;
  let res: Awaited<ReturnType<HttpFetcher>>;
  try {
    res = await fetcher(url, { method: 'GET' });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  return parseIntrospectScopes(body);
};
