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
  constructor(
    code: OAuthError['code'],
    status: number,
    msg: string,
  ) {
    super(msg);
    this.code = code;
    this.status = status;
  }
}

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

const defaultFetcher: HttpFetcher = async (url, init) => {
  // Node 20+ ships fetch globally; we wrap Response in the narrow
  // shape so tests can provide a matching fake without also faking
  // every `Response` method.
  const res = await fetch(url, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  });
  return {
    status: res.status,
    ok: res.ok,
    json: () => res.json(),
    text: () => res.text(),
  };
};

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
  const fetcher = opts.fetcher ?? defaultFetcher;
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
  const res = await fetcher(opts.providerConfig.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OAuthError(
      'token_exchange_failed',
      res.status,
      `token exchange failed (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  const raw = await res.json();
  const parsed = parseTokenResponse(raw);
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
  const fetcher = opts.fetcher ?? defaultFetcher;
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
  const res = await fetcher(opts.providerConfig.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OAuthError(
      'token_refresh_failed',
      res.status,
      `token refresh failed (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  const raw = await res.json();
  const parsed = parseTokenResponse(raw);
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
