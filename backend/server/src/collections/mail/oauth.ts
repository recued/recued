/** Phase D (D-106) — shared OAuth helpers for Gmail + Graph providers.
 *
 *  Both providers use OAuth 2.0 with refresh tokens. The flow matches
 *  the spec:
 *    1. Extension captures the `code` from the provider's redirect
 *       (ext-side URL — no server-hosted callback per D-106 §OAuth).
 *    2. Extension calls `collection.mail.enrollOAuth` rpc with
 *       `{ provider, account_slug, code, redirect_uri }`.
 *    3. Server exchanges the code for `{ access_token, refresh_token,
 *       expires_in }` via the provider's token endpoint.
 *    4. Server persists in `account.{provider}.{account_slug}.{key}`.
 *    5. At runtime, providers call `getAccessToken` which either
 *       returns the stored access token (if still valid) or refreshes
 *       via the refresh token.
 *
 *  This module exposes only what the providers + rpc handler need —
 *  token exchange, token refresh, reading the current access token
 *  with automatic refresh on 401. OAuth config constants (client ids /
 *  secrets) live per-provider in their own module; this one is pure
 *  plumbing.
 *
 *  Error surface: every function throws an `OAuthError` with a
 *  provider-neutral code. Callers translate to the `account` rpc
 *  envelope.
 */

import { ResponseBodyTooLargeError } from '@recued/ingredients';
import { makeBoundedOriginHttpFetcher } from '../../bounded-origin-http-fetcher.js';

/** Prefix tag for the `account.<provider>.<slug>.*` namespace.
 *  Historically mail-only (gmail / graph); D-117 adds `gcal` for the
 *  calendar Google adapter. Microsoft Graph reuses `'graph'` across
 *  mail and calendar — the same OAuth account serves both with
 *  scope-differentiated consents. `caldav` is basic auth, not OAuth,
 *  so it does not appear here. */
export type OAuthProvider = 'gmail' | 'graph' | 'gcal';

export interface OAuthProviderConfig {
  /** The token endpoint for the provider. */
  tokenUrl: string;
  /** OAuth client id shipped with the server binary. */
  clientId: string;
  /** Optional OAuth client secret. Gmail ships one, Graph public
   *  clients can operate without one. */
  clientSecret?: string;
}

/** Per-USE credential fetch (no boot binding, no cache). PRODUCTION injects
 *  this: the adapters + enroll call it each time they need the OAuth app config
 *  for a connection — at enroll and on every token refresh — so UI-entered (or
 *  env) credentials take effect immediately and decrypt at use time (vault
 *  unlocked). `null` = no credentials configured for this provider's issuer. */
export type OAuthProviderConfigResolver = () => OAuthProviderConfig | null;

/** What a provider/adapter accepts for its OAuth config: EITHER the per-use
 *  resolver above (production) OR a static `OAuthProviderConfig` (sugar for
 *  `() => config`, used by unit tests + any caller with a fixed config).
 *  Production wiring always passes the resolver; the static form never enters
 *  the runtime path. */
export type OAuthProviderConfigSource =
  | OAuthProviderConfig
  | OAuthProviderConfigResolver;

/** Resolve a config source to a concrete config or throw — called at the
 *  refresh leaf, where a missing config means the connection genuinely can't
 *  refresh. A static config passes through; a resolver is invoked per call. */
export const requireProviderConfig = (
  source: OAuthProviderConfigSource,
): OAuthProviderConfig => {
  const cfg = typeof source === 'function' ? source() : source;
  if (!cfg) throw new Error('oauth_app_not_configured');
  return cfg;
};

/** Narrow account-store interface. Providers + the rpc handler call
 *  `get/set/delete` directly; we wrap the live `ServerAccountStore`
 *  at composition time so tests can inject an in-memory double. */
export interface OAuthAccountStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Optional flat enumeration — the production `ServerAccountStore`
   *  provides it (structurally); narrow test doubles may omit it. Used to
   *  prefix-purge an instance's keys on delete (a caldav instance's password
   *  + its `caldav.<slug>.etag.*` sync-cursors). */
  getAll?(): Promise<Record<string, string>>;
}

export type HttpFetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class OAuthError extends Error {
  readonly code:
    | 'token_exchange_failed'
    | 'token_refresh_failed'
    | 'missing_refresh_token'
    | 'invalid_response';
  readonly status: number;
  /** The token endpoint's own `error` field (RFC 6749 § 5.2) when the body
   *  carried one — `invalid_grant`, `invalid_client`, `invalid_scope`,
   *  `unsupported_grant_type`, `invalid_request`.
   *
   *  🔑 Load-bearing for classification, because the STATUS alone cannot
   *  distinguish these: RFC 6749 returns **400 for all of them**, and only
   *  `invalid_grant` means "the user's grant is gone, re-consent" — the others
   *  are our own client misconfiguration, which no amount of re-authorizing
   *  fixes. Reading the status alone turns every one of them into a futile
   *  "Needs re-auth" prompt. */
  readonly oauth_error?: string;
  constructor(
    code: OAuthError['code'],
    status: number,
    msg: string,
    oauth_error?: string,
  ) {
    super(msg);
    this.code = code;
    this.status = status;
    if (oauth_error !== undefined) this.oauth_error = oauth_error;
  }
}

const oauthTransportFailure = (
  code: 'token_exchange_failed' | 'token_refresh_failed',
  label: string,
  error: unknown,
): OAuthError => {
  if (error instanceof ResponseBodyTooLargeError) {
    return new OAuthError(
      'invalid_response',
      502,
      `${label} response exceeded the ${error.maxBytes}-byte limit`,
    );
  }
  const isAbort = error instanceof Error && error.name === 'AbortError';
  return new OAuthError(
    code,
    isAbort ? 504 : 502,
    isAbort
      ? `${label} timed out while waiting for the provider response`
      : `${label} request failed`,
  );
};

/** Pull the RFC 6749 § 5.2 `error` field out of a token-endpoint error body.
 *  Tolerant by construction: a non-JSON or JSON-but-shapeless body yields
 *  `undefined`, and the caller falls back to status-only classification. */
export const parseOAuthErrorField = (body: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const field = (parsed as { error?: unknown }).error;
    return typeof field === 'string' && field.length > 0 ? field : undefined;
  } catch {
    return undefined;
  }
};

// ────────────────────────────────────────────────────────────────
// Keys under account.{provider}.{slug}.*
// ────────────────────────────────────────────────────────────────

export const keyPrefix = (provider: OAuthProvider, slug: string): string =>
  `${provider}.${slug}`;

const accessTokenKey = (provider: OAuthProvider, slug: string): string =>
  `${keyPrefix(provider, slug)}.access_token`;
const refreshTokenKey = (provider: OAuthProvider, slug: string): string =>
  `${keyPrefix(provider, slug)}.refresh_token`;
const expiresAtKey = (provider: OAuthProvider, slug: string): string =>
  `${keyPrefix(provider, slug)}.expires_at`;
/** D-127 P4.2 — granted scopes the user actually consented to at the
 *  most recent token exchange / refresh. Persisted as a single
 *  space-separated string per OAuth 2.0 RFC 6749 § 3.3. The provider's
 *  config callback reads back via `getGrantedScopes` and passes the
 *  parsed array to `granted_scopes`; `sendCapable` flips true iff the
 *  list contains the provider-specific send scope. */
const grantedScopesKey = (provider: OAuthProvider, slug: string): string =>
  `${keyPrefix(provider, slug)}.granted_scopes`;

// ════════════════════════════════════════════════════════════════
// Granted-scope membership
//
// ⚠ An EXACT string match against the granted-scope list is wrong, and wrong in
// the silent direction. Providers do not have to echo a scope in the form it was
// requested:
//
//   · Microsoft may return a RESOURCE-QUALIFIED scope —
//     `https://graph.microsoft.com/Mail.Send` where `Mail.Send` was requested.
//   · Google requests full URIs and normally echoes them, but the leaf name is
//     the identifying part either way.
//   · Case is not guaranteed by RFC 6749 § 3.3, which defines scope tokens as
//     opaque strings.
//
// Under exact matching, any of those makes `send_capable` silently FALSE: the
// account enrolls, reads fine, and the send option simply never appears — with
// nothing anywhere saying the scope WAS granted. That is the same class of
// failure as the sync reporting this module's callers just fixed, so it gets the
// same treatment: compare what identifies a scope, not how it was spelled.
// ════════════════════════════════════════════════════════════════

/** The identifying tail of a scope string, lowercased.
 *
 *  `https://graph.microsoft.com/Mail.Send` → `mail.send`
 *  `https://www.googleapis.com/auth/gmail.send` → `gmail.send`
 *  `Mail.Send` → `mail.send`
 *
 *  Splitting on the last `/` is safe because every scope form in play puts the
 *  distinguishing name last, and the leaf names are unique within a provider's
 *  own set. */
const scopeLeaf = (scope: string): string => {
  const trimmed = scope.trim().toLowerCase();
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
};

/** Was `want` granted? Case- and resource-prefix-tolerant, and symmetric — it
 *  holds whichever side carries the prefix.
 *
 *  A false POSITIVE here is self-correcting: the provider rejects the call and
 *  the send surfaces `MAIL_SEND_AUTH_FAILED`. A false NEGATIVE is the silent
 *  one — a capability the user paid for at the consent screen, invisible with no
 *  diagnostic. So this leans permissive deliberately. */
export const grantedScopesInclude = (
  granted: readonly string[],
  want: string,
): boolean => {
  const target = scopeLeaf(want);
  if (target.length === 0) return false;
  return granted.some((g) => scopeLeaf(g) === target);
};

// ════════════════════════════════════════════════════════════════
// Shared-grant identity (Microsoft `graph`)
//
// Microsoft's mail and calendar adapters are BOTH named `graph`, so one
// `account.graph.<slug>.*` prefix serves both lanes. That sharing is the whole
// point — one consent, two lanes — but it means a slug is NOT an account: slugs
// are user-chosen names, and re-enrolling a DIFFERENT Microsoft account under a
// slug another lane is using silently re-points that lane at someone else's
// mailbox. Nothing in the prefix says whose grant it is.
//
// So the grant records WHOSE it is, and an enroll that would overwrite a grant
// another lane depends on must prove it is the same account first.
// ════════════════════════════════════════════════════════════════

/** Where the shared grant's owner identity is recorded. */
const grantIdentityKey = (provider: OAuthProvider, slug: string): string =>
  `${keyPrefix(provider, slug)}.grant_identity`;

/** Immutable-ish identity of the account behind a grant.
 *
 *  `subject` is Microsoft Graph `/me` → `id`: the directory OBJECT ID, a GUID
 *  that is stable across email/UPN changes (which is exactly why the UPN is not
 *  used — people rename, and a rename must not read as a different account).
 *  It comes from an authenticated API response, so it is the REQUIRED key.
 *
 *  `tenant` is opportunistic. Microsoft exposes it as the `tid` claim on the
 *  access token, and access tokens are documented as OPAQUE to clients — so this
 *  reads it when the token happens to be a parseable JWT and simply omits it
 *  otherwise. It is never required, and its absence never blocks a comparison;
 *  it only makes a match stricter when both sides have it. `/organization` would
 *  give it properly but needs a directory scope we deliberately do not request. */
export interface GraphGrantIdentity {
  subject: string;
  tenant?: string;
}

const GRAPH_ME_IDENTITY_URL = 'https://graph.microsoft.com/v1.0/me?$select=id';

/** Best-effort `tid` read from an access token.
 *
 *  ⚠ Access tokens are opaque by contract, so EVERY failure path here returns
 *  `undefined` rather than throwing: a format change must degrade this to
 *  subject-only matching, never break enrollment. */
const tenantFromAccessToken = (accessToken: string): string | undefined => {
  try {
    const payload = accessToken.split('.')[1];
    if (payload === undefined) return undefined;
    const json = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const claims: unknown = JSON.parse(json);
    if (typeof claims !== 'object' || claims === null) return undefined;
    const tid = (claims as { tid?: unknown }).tid;
    return typeof tid === 'string' && tid.length > 0 ? tid : undefined;
  } catch {
    return undefined;
  }
};

/** Resolve the identity behind a freshly-obtained Graph access token. Returns
 *  `null` when `/me` cannot be read — the caller decides whether an unknown
 *  identity is tolerable (it is, for a grant no other lane shares). */
export const fetchGraphGrantIdentity = async (
  accessToken: string,
  fetcher: HttpFetcher,
): Promise<GraphGrantIdentity | null> => {
  try {
    const res = await fetcher(GRAPH_ME_IDENTITY_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, unknown>;
    const subject = raw.id;
    if (typeof subject !== 'string' || subject.length === 0) return null;
    const tenant = tenantFromAccessToken(accessToken);
    return { subject, ...(tenant !== undefined ? { tenant } : {}) };
  } catch {
    return null;
  }
};

export const readGraphGrantIdentity = async (
  accountStore: OAuthAccountStore,
  slug: string,
): Promise<GraphGrantIdentity | null> => {
  const raw = await accountStore.get(grantIdentityKey('graph', slug));
  if (raw === null || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const subject = (parsed as { subject?: unknown }).subject;
    if (typeof subject !== 'string' || subject.length === 0) return null;
    const tenant = (parsed as { tenant?: unknown }).tenant;
    return {
      subject,
      ...(typeof tenant === 'string' && tenant.length > 0 ? { tenant } : {}),
    };
  } catch {
    return null;
  }
};

export const writeGraphGrantIdentity = async (
  accountStore: OAuthAccountStore,
  slug: string,
  identity: GraphGrantIdentity,
): Promise<void> => {
  await accountStore.set(grantIdentityKey('graph', slug), JSON.stringify(identity));
};

/** Do two identities describe the same account?
 *
 *  `subject` must match. `tenant` is compared only when BOTH sides carry it —
 *  one side missing it means the token wasn't parseable then or isn't now, which
 *  is not evidence of a different account and must not be treated as one. */
export const graphGrantIdentitiesMatch = (
  a: GraphGrantIdentity,
  b: GraphGrantIdentity,
): boolean => {
  if (a.subject !== b.subject) return false;
  if (a.tenant !== undefined && b.tenant !== undefined) return a.tenant === b.tenant;
  return true;
};

/** Human-readable form for an error message. Subject is a GUID, not a secret —
 *  it identifies a directory object, carries no authority, and naming it is what
 *  makes "this is a different account" checkable by the owner. */
export const describeGraphGrantIdentity = (identity: GraphGrantIdentity): string =>
  identity.tenant !== undefined
    ? `${identity.subject} (tenant ${identity.tenant})`
    : identity.subject;

/** The credential quad an enroll overwrites, captured so a rejected enroll can
 *  put it back. Also carries the identity so the restore is complete. */
export interface GraphGrantSnapshot {
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  granted_scopes: string | null;
  grant_identity: string | null;
}

export const snapshotGraphGrant = async (
  accountStore: OAuthAccountStore,
  slug: string,
): Promise<GraphGrantSnapshot> => ({
  access_token: await accountStore.get(accessTokenKey('graph', slug)),
  refresh_token: await accountStore.get(refreshTokenKey('graph', slug)),
  expires_at: await accountStore.get(expiresAtKey('graph', slug)),
  granted_scopes: await accountStore.get(grantedScopesKey('graph', slug)),
  grant_identity: await accountStore.get(grantIdentityKey('graph', slug)),
});

/** Put a snapshot back after refusing an enroll that already overwrote it.
 *
 *  ⚠ Best-effort by necessity — this runs on the failure path, and a store write
 *  can itself fail. Returns whether every key was restored so the caller can be
 *  HONEST about a partial restore instead of claiming the old grant is intact.
 *  A key that was absent before is deleted rather than left at the new value. */
export const restoreGraphGrant = async (
  accountStore: OAuthAccountStore,
  slug: string,
  snap: GraphGrantSnapshot,
): Promise<boolean> => {
  const writes: Array<[string, string | null]> = [
    [accessTokenKey('graph', slug), snap.access_token],
    [refreshTokenKey('graph', slug), snap.refresh_token],
    [expiresAtKey('graph', slug), snap.expires_at],
    [grantedScopesKey('graph', slug), snap.granted_scopes],
    [grantIdentityKey('graph', slug), snap.grant_identity],
  ];
  let complete = true;
  for (const [key, value] of writes) {
    try {
      if (value === null) await accountStore.delete(key);
      else await accountStore.set(key, value);
    } catch {
      complete = false;
    }
  }
  return complete;
};

// Refresh this many ms before expiry to avoid 401s mid-request.
const REFRESH_SKEW_MS = 60_000;

// ────────────────────────────────────────────────────────────────
// Token exchange — first enrollment
// ────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
  /** D-127 P4.2 — space-separated list of scopes the user actually
   *  granted. May be absent when the provider chooses not to echo
   *  scopes back (rare; both Gmail + Graph populate it). */
  scope?: string;
}

/** Real-`fetch` fallback in the narrow `HttpFetcher` shape.
 *
 *  Exported because production composition does NOT pass a `fetcher` into the
 *  mail / calendar enroll deps — it relies on this default. Any code path that
 *  gates itself on `deps.fetcher !== undefined` is therefore DEAD in production
 *  while looking perfectly wired in tests, so callers take this fallback instead
 *  of testing for absence. */
export const defaultHttpFetcher: HttpFetcher = makeBoundedOriginHttpFetcher({
  // Mail message bodies can legitimately exceed the ordinary 16 MiB API
  // ceiling; 32 MiB covers provider message limits while remaining finite.
  maxResponseBytes: 32 * 1024 * 1024,
});

const parseTokenResponse = (raw: unknown): TokenResponse => {
  if (!raw || typeof raw !== 'object') {
    throw new OAuthError('invalid_response', 500, 'token endpoint returned non-object');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.access_token !== 'string' || obj.access_token.length === 0) {
    throw new OAuthError('invalid_response', 500, 'token endpoint missing access_token');
  }
  if (typeof obj.expires_in !== 'number' || obj.expires_in <= 0) {
    throw new OAuthError('invalid_response', 500, 'token endpoint missing expires_in');
  }
  const out: TokenResponse = {
    access_token: obj.access_token,
    expires_in: obj.expires_in,
  };
  if (typeof obj.refresh_token === 'string' && obj.refresh_token.length > 0) {
    out.refresh_token = obj.refresh_token;
  }
  if (typeof obj.token_type === 'string') out.token_type = obj.token_type;
  // D-127 P4.2 — pass `scope` through verbatim. RFC 6749 § 3.3
  // mandates a space-separated string here; downstream
  // `parseGrantedScopes` splits and trims defensively (some
  // providers slip in commas / tabs).
  if (typeof obj.scope === 'string' && obj.scope.length > 0) out.scope = obj.scope;
  return out;
};

const readTokenResponse = async (
  response: Awaited<ReturnType<HttpFetcher>>,
  label: string,
): Promise<TokenResponse> => {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    throw new OAuthError(
      'invalid_response',
      502,
      `${label} returned malformed JSON: ${(error as Error).message}`,
    );
  }
  return parseTokenResponse(raw);
};

/** D-127 P4.2 — split the OAuth `scope` string into a deduped
 *  array. RFC 6749 § 3.3 specifies space-separated values; in the
 *  wild, providers occasionally use commas or include trailing
 *  whitespace. Empty / undefined input yields an empty array. */
export const parseGrantedScopes = (raw: string | undefined): string[] => {
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

export interface ExchangeCodeOptions {
  provider: OAuthProvider;
  slug: string;
  code: string;
  redirectUri: string;
  providerConfig: OAuthProviderConfig;
  accountStore: OAuthAccountStore;
  fetcher?: HttpFetcher;
  now?: () => number;
}

export const exchangeCodeForTokens = async (
  opts: ExchangeCodeOptions,
): Promise<{ access_token: string; expires_at: number; granted_scopes: string[] }> => {
  const fetcher = opts.fetcher ?? defaultHttpFetcher;
  const nowMs = opts.now?.() ?? Date.now();
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.providerConfig.clientId,
    redirect_uri: opts.redirectUri,
    grant_type: 'authorization_code',
  });
  if (opts.providerConfig.clientSecret) {
    body.set('client_secret', opts.providerConfig.clientSecret);
  }
  let res: Awaited<ReturnType<HttpFetcher>>;
  try {
    res = await fetcher(opts.providerConfig.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    throw oauthTransportFailure('token_exchange_failed', 'token exchange', error);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OAuthError(
      'token_exchange_failed',
      res.status,
      `token exchange failed (${res.status}): ${text.slice(0, 200)}`,
      parseOAuthErrorField(text),
    );
  }
  const parsed = await readTokenResponse(res, 'token endpoint');
  if (!parsed.refresh_token) {
    // Providers occasionally omit refresh_token on re-enrollment of an
    // already-consented account. Defensive message here so the caller
    // can explain the fix (revoke + re-auth with `prompt=consent`).
    throw new OAuthError(
      'missing_refresh_token',
      500,
      'token endpoint did not return a refresh_token — revoke access and retry with prompt=consent',
    );
  }
  const expiresAt = nowMs + parsed.expires_in * 1000;
  await opts.accountStore.set(refreshTokenKey(opts.provider, opts.slug), parsed.refresh_token);
  await opts.accountStore.set(accessTokenKey(opts.provider, opts.slug), parsed.access_token);
  await opts.accountStore.set(expiresAtKey(opts.provider, opts.slug), String(expiresAt));
  // D-127 P4.2 — persist the granted scope set so the provider's
  // `granted_scopes` config callback can read it back at construction
  // and `sendCapable` flips correctly. Stored as the raw RFC 6749
  // string; downstream `getGrantedScopes` parses on read so the
  // on-disk shape stays trivial. When the provider omits `scope`
  // (rare — both Gmail + Graph populate it) we still write the empty
  // string so the read path returns `[]` instead of "key missing".
  await opts.accountStore.set(grantedScopesKey(opts.provider, opts.slug), parsed.scope ?? '');
  return {
    access_token: parsed.access_token,
    expires_at: expiresAt,
    granted_scopes: parseGrantedScopes(parsed.scope),
  };
};

// ────────────────────────────────────────────────────────────────
// Token refresh — background + on-demand
// ────────────────────────────────────────────────────────────────

export interface RefreshTokenOptions {
  provider: OAuthProvider;
  slug: string;
  providerConfig: OAuthProviderConfig;
  accountStore: OAuthAccountStore;
  fetcher?: HttpFetcher;
  now?: () => number;
}

export const refreshAccessToken = async (
  opts: RefreshTokenOptions,
): Promise<{ access_token: string; expires_at: number; granted_scopes: string[] }> => {
  const fetcher = opts.fetcher ?? defaultHttpFetcher;
  const nowMs = opts.now?.() ?? Date.now();
  const refreshToken = await opts.accountStore.get(
    refreshTokenKey(opts.provider, opts.slug),
  );
  if (!refreshToken) {
    throw new OAuthError(
      'missing_refresh_token',
      401,
      `no refresh_token stored for ${opts.provider}:${opts.slug} — run enrollOAuth`,
    );
  }
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: opts.providerConfig.clientId,
    grant_type: 'refresh_token',
  });
  if (opts.providerConfig.clientSecret) {
    body.set('client_secret', opts.providerConfig.clientSecret);
  }
  let res: Awaited<ReturnType<HttpFetcher>>;
  try {
    res = await fetcher(opts.providerConfig.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    throw oauthTransportFailure('token_refresh_failed', 'token refresh', error);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OAuthError(
      'token_refresh_failed',
      res.status,
      `token refresh failed (${res.status}): ${text.slice(0, 200)}`,
      parseOAuthErrorField(text),
    );
  }
  const parsed = await readTokenResponse(res, 'token endpoint');
  const expiresAt = nowMs + parsed.expires_in * 1000;
  await opts.accountStore.set(accessTokenKey(opts.provider, opts.slug), parsed.access_token);
  await opts.accountStore.set(expiresAtKey(opts.provider, opts.slug), String(expiresAt));
  // Some providers rotate refresh tokens; persist a new one if given.
  if (parsed.refresh_token) {
    await opts.accountStore.set(refreshTokenKey(opts.provider, opts.slug), parsed.refresh_token);
  }
  // D-127 P4.2 — refresh responses can downgrade scopes (provider
  // revoked send permission, user trimmed consent in their account
  // settings, etc.) so we re-persist on every refresh. Skip the
  // write only when the provider omits `scope` entirely; never
  // overwrite a known-good value with empty when the field was
  // simply not echoed back. (Both Gmail + Graph echo on refresh —
  // this guard is defensive for OIDC-style providers that don't.)
  if (parsed.scope !== undefined) {
    await opts.accountStore.set(grantedScopesKey(opts.provider, opts.slug), parsed.scope);
  }
  return {
    access_token: parsed.access_token,
    expires_at: expiresAt,
    granted_scopes: parseGrantedScopes(
      parsed.scope ?? (await opts.accountStore.get(grantedScopesKey(opts.provider, opts.slug)) ?? undefined),
    ),
  };
};

// ────────────────────────────────────────────────────────────────
// Granted-scopes lookup (D-127 P4.2)
// ────────────────────────────────────────────────────────────────

/** Read the persisted granted-scope set for a provider/slug pair.
 *  The provider's `config()` callback wires this in so `sendCapable`
 *  picks up scope changes (re-enrollment with send checked, refresh
 *  that downgraded scopes, etc.) without restarting the server.
 *  Returns `[]` when nothing is stored — same behavior the providers
 *  already key on for "no granted scopes ⇒ read-only". */
export const getGrantedScopes = async (
  accountStore: OAuthAccountStore,
  provider: OAuthProvider,
  slug: string,
): Promise<string[]> => {
  const raw = await accountStore.get(grantedScopesKey(provider, slug));
  return parseGrantedScopes(raw ?? undefined);
};

export interface GetAccessTokenOptions {
  provider: OAuthProvider;
  slug: string;
  providerConfig: OAuthProviderConfig;
  accountStore: OAuthAccountStore;
  fetcher?: HttpFetcher;
  now?: () => number;
  /** Force refresh regardless of stored expires_at. Callers set this
   *  after a 401 so the next attempt gets a fresh token. */
  force?: boolean;
}

export const getAccessToken = async (
  opts: GetAccessTokenOptions,
): Promise<string> => {
  const nowMs = opts.now?.() ?? Date.now();
  if (!opts.force) {
    const accessToken = await opts.accountStore.get(
      accessTokenKey(opts.provider, opts.slug),
    );
    const expiresAtStr = await opts.accountStore.get(
      expiresAtKey(opts.provider, opts.slug),
    );
    if (accessToken && expiresAtStr) {
      const expiresAt = Number(expiresAtStr);
      if (Number.isFinite(expiresAt) && expiresAt - nowMs > REFRESH_SKEW_MS) {
        return accessToken;
      }
    }
  }
  const refreshed = await refreshAccessToken({
    provider: opts.provider,
    slug: opts.slug,
    providerConfig: opts.providerConfig,
    accountStore: opts.accountStore,
    fetcher: opts.fetcher,
    now: opts.now,
  });
  return refreshed.access_token;
};
