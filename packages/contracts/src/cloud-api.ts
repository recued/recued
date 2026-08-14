/** D-148 § A.5.2 / § A.5.3 / § A.5.5 / § A.12 — Recued Cloud API
 *  shapes for the P5 surface (DDNS update, CSR-only ACME, reachability
 *  probe, OAuth callback state token). The cloud Workers + the
 *  server-side adapters share these wire types so the signed payload
 *  bytes stay byte-identical across boundaries.
 *
 *  Every signed call here uses `server_identity_key` per § A.8 — the
 *  cloud verifies signatures against the publisher's pinned public
 *  key (registered at Pro subscription start). Replay defense is a
 *  per-endpoint timestamp window.
 */

import { CUSTOM_DOMAIN_MAX_PER_SERVER } from './custom-domain.js';

// ────────────────────────────────────────────────────────────────
// § A.5.2 — DDNS update API
// ────────────────────────────────────────────────────────────────

/** Wire shape posted to `POST /v1/ddns/update`. The signature covers
 *  the canonical-JSON serialization of `{ publisher_id, handle,
 *  ip_v4, ip_v6, timestamp }` (the same field set, signed bytes). */
export interface DdnsUpdateRequest {
  publisher_id: string;
  handle: string;
  ip_v4: string;
  ip_v6?: string;
  signature: string;
  timestamp: number;
}

export interface DdnsUpdateResponse {
  ddns_record_updated_at: number;
  ttl: number;
  /** Empty unless the cloud noticed a misconfig (e.g., handle was
   *  released during grace; user should renew). */
  warnings: string[];
  /** True when the cloud short-circuited because the IP didn't
   *  change vs the prior recorded IP for this publisher. The DNS
   *  record is unchanged. */
  unchanged?: boolean;
}

/** Closed list of error codes the DDNS endpoint can return. Per
 *  D-148 P10 § A.14 (Codex P10 P2 #2 fold), unknown publisher
 *  collapses into `ddns_signature_invalid` — the registered-vs-
 *  unregistered distinction never surfaces to unauthenticated
 *  callers. */
export type DdnsErrorCode =
  | 'ddns_signature_invalid'
  | 'ddns_handle_mismatch'
  | 'ddns_replay_window_exceeded'
  | 'ddns_replay_duplicate'
  | 'ddns_subscription_lapsed'
  | 'ddns_rate_limited'
  | 'ddns_validation_error';

/** D-148 § A.5.2 — per-publisher rate limit. The cloud accepts one
 *  POST per `DDNS_UPDATE_INTERVAL_MS` window per publisher; bursts
 *  are absorbed up to this many tokens. */
export const DDNS_UPDATE_RATE_LIMIT_PER_HOUR = 24;

// ────────────────────────────────────────────────────────────────
// R27 delta-B — user-initiated DDNS pause/resume (Pro tier)
// ────────────────────────────────────────────────────────────────

/** Wire shape posted to `POST /v1/ddns/pause`. The user toggles whether their
 *  `<handle>.<zone>` DDNS record is published. ORTHOGONAL to the subscription:
 *  it sets `HostnameRow.user_paused` (publish iff `active && !user_paused`),
 *  leaving the billing lifecycle untouched — a renewal can't re-open a pause.
 *  Publisher-signed exactly like `/v1/ddns/update`: the signature covers the
 *  canonical-JSON of `{ publisher_id, handle, paused, timestamp }`. Requires an
 *  active Pro subscription (a lapsed handle is already parked). */
export interface DdnsPauseRequest {
  publisher_id: string;
  handle: string;
  /** `true` = pause (pull records); `false` = resume (republish if active). */
  paused: boolean;
  signature: string;
  timestamp: number;
}

export interface DdnsPauseResponse {
  /** The canonical handle the action targeted. */
  handle: string;
  /** The effective `user_paused` state after applying. */
  paused: boolean;
  /** Cloud-clock epoch-ms the action was processed at. */
  at: number;
}

/** Closed list of error codes the DDNS pause endpoint can return. Mirrors the
 *  `/v1/ddns/update` auth discipline — unknown publisher collapses into
 *  `ddns_pause_signature_invalid` so registration can't be probed. */
export type DdnsPauseErrorCode =
  | 'ddns_pause_validation_error'
  | 'ddns_pause_signature_invalid'
  | 'ddns_pause_handle_mismatch'
  | 'ddns_pause_subscription_lapsed'
  | 'ddns_pause_replay_window_exceeded'
  | 'ddns_pause_replay_duplicate'
  | 'ddns_pause_rate_limited'
  /** A concurrent desired-state write bumped the row version mid-apply
   *  (`dns_lifecycle_cas_conflict`) — retryable. */
  | 'ddns_pause_conflict';

/** R27 delta-B — replay-window for the signed pause request (5 min, matching
 *  the ACME / handle-governance / operator windows). */
export const DDNS_PAUSE_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** R27 delta-B — modest per-publisher flood guard on pause/resume toggles. */
export const DDNS_PAUSE_RATE_LIMIT_PER_HOUR = 12;

// ────────────────────────────────────────────────────────────────
// § A.5.3 — CSR-only ACME flow
// ────────────────────────────────────────────────────────────────

/** Wire shape posted to `POST /v1/acme/issue-cert`. The signature
 *  covers the canonical-JSON serialization of `{ publisher_id,
 *  handle, csr_pem, timestamp }`. The cloud Worker NEVER receives
 *  a `PRIVATE KEY` — only the CSR (which carries the *public* key
 *  half + the user-server's signature over the CSR body).
 *
 *  `domain` (D-176) is the full Pro DDNS FQDN the cert is for
 *  (`<handle><zone.suffix>`, e.g. `alice.recued.net`). The server holds
 *  it on the `tls_domains` row and passes it verbatim so the cloud
 *  orders + validates the EXACT host instead of re-deriving it from
 *  `handle` + a hardcoded zone suffix (the round-trip that pinned the
 *  whole path to `.recued.cloud`). It is deliberately NOT in the signed
 *  field set: the signed CSR already commits to the domain (it IS the
 *  CN/SAN), and the cloud cross-checks `domain` against the CSR
 *  (`validateCsr`) AND against the authenticated handle
 *  (`resolveProDdnsHost(domain).handle === authority.handle`), so a
 *  tampered `domain` either matches the signed CSR (a no-op) or is
 *  rejected. The cloud requires it to resolve to an ENABLED `DDNS_ZONES`
 *  entry whose handle matches the publisher's reserved handle. */
export interface AcmeIssueCertRequest {
  publisher_id: string;
  handle: string;
  /** Full Pro DDNS FQDN, e.g. `alice.recued.net`. See the interface
   *  doc — committed by the signed CSR, cross-checked by the cloud. */
  domain: string;
  csr_pem: string;
  signature: string;
  timestamp: number;
}

export interface AcmeIssueCertResponse {
  cert_pem: string;
  issuer_chain_pem: string;
  expires_at: number;
  /** Recommended renewal time (typically `expires_at - 30d`). */
  renewal_recommended_at: number;
  /** D-152 § A.17 — the CA in the multi-CA helper's ordered list that
   *  issued this cert (e.g. `'zerossl'`). Lets the server record + log
   *  the issuer so a CA swap is observable before the rotation announce.
   *  Absent when the cloud runs the legacy single-CA path. */
  issuing_ca?: string;
}

/** Closed list of error codes the ACME endpoint can return. Per
 *  D-148 P10 § A.14 (Codex P10 P2 #2 fold), unknown publisher
 *  collapses into `acme_signature_invalid` — same auth-before-data-
 *  access discipline as DDNS. */
export type AcmeErrorCode =
  | 'acme_signature_invalid'
  | 'acme_handle_mismatch'
  | 'acme_replay_window_exceeded'
  /** Exact-replay of an already-processed signed request (same
   *  `timestamp` seen inside the replay window). Mirrors
   *  `ddns_replay_duplicate` — the window check rejects STALE requests;
   *  this rejects a re-POST of a still-fresh one. Distinct from
   *  `acme_replay_window_exceeded` (clock-skew / stale) so the caller can
   *  tell "already issued" from "retry with a fresh timestamp". */
  | 'acme_replay_duplicate'
  | 'acme_csr_malformed'
  | 'acme_csr_handle_mismatch'
  | 'acme_csr_contains_private_key'
  | 'acme_subscription_lapsed'
  | 'acme_rate_limited'
  | 'acme_ca_unavailable'
  /** D-176 — `domain` did not resolve to an ENABLED `DDNS_ZONES` entry
   *  (wrong / disabled zone suffix, bare apex, or a multi-label prefix).
   *  Distinct from `acme_handle_mismatch`, which is a valid Pro DDNS
   *  host whose handle belongs to a DIFFERENT publisher. */
  | 'acme_domain_invalid'
  /** D-176 Phase 2 — `domain` is a valid enabled-zone host carrying the
   *  authenticated publisher's own handle, but in a DIFFERENT zone than
   *  the one the publisher is bound to (`authority.zone`). With a single
   *  enabled zone this never fires (a handle resolves to exactly one
   *  host); it becomes load-bearing the moment a SECOND zone is enabled,
   *  where `<handle>.recued.net` and `<handle>.recued.cloud` would both
   *  carry the same handle — only the bound one may issue. */
  | 'acme_zone_mismatch'
  /** D-235 § 8.3 — `domain` is outside the fleet's zones (a bring-your-own
   *  domain) and its `_acme-challenge` CNAME does not point at the
   *  authenticated publisher's own challenge name. Covers both "points
   *  somewhere else" (including at ANOTHER handle's — the case this gate
   *  exists to refuse) and "no CNAME at all"; the response MESSAGE names
   *  which, the code stays coarse because a caller branches the same way on
   *  both. ⛔ This is the boundary: the server-side eligibility gate runs on
   *  the user's own machine and is local policy only. */
  | 'acme_delegation_unauthorized'
  /** D-235 § 8.3 — the delegation lookup itself failed (SERVFAIL, timeout, a
   *  non-200 from the resolver). ⚠ DELIBERATELY NOT `unauthorized`: we learned
   *  nothing about the user's zone, so telling them their record is wrong
   *  would be a lie, and 503 invites the retry that will settle it. Failing
   *  CLOSED either way — an unresolved delegation never issues. */
  | 'acme_delegation_unresolved'
  | 'acme_validation_error';

/** D-148 § A.5.3 — Let's Encrypt rate-limit ceiling per publisher
 *  per ACME helper. Real LE limit is 50 certs/registered-domain/wk
 *  but cloud rate-limits at a tighter ceiling so a single
 *  publisher can't burn the per-domain pool.
 *
 *  ⚠ THE CEILING COUNTS ATTEMPTS, NOT ISSUANCES — `checkRate` runs before the
 *  CA call, so a server in a retry loop burns it. That is the point: the
 *  enrollment backoff tops out hourly, which is ~22 attempts a day, so this
 *  ceiling (not the backoff) is what stops a misconfigured server from
 *  hammering the CA.
 *
 *  D-235 raised it from a flat 8, because the demand changed shape rather than
 *  the protection weakening. Before D-235 a server needed exactly ONE
 *  certificate, so 8 was 8× headroom. Now it needs one for the Pro DDNS host
 *  plus up to `CUSTOM_DOMAIN_MAX_PER_SERVER` custom domains — six — and a
 *  first-day enrolment of all of them left two attempts for the whole rest of
 *  the day. Derived from the cap rather than picked so the two cannot drift:
 *  ×2 permits one complete re-attempt after a transient bad day and still hard-
 *  stops a retry loop far below the fleet's shared budget (LE allows ~2,400 new
 *  orders/account/day; one publisher at this ceiling is well under 1% of it).
 *
 *  🔑 Raising this does NOT relax the protection D-148 wrote it for. That
 *  protection is `recued.net`'s shared 50-certs-per-registered-domain-per-week
 *  pool, and per D-235 § 4.2 a custom domain does not touch it — it lands in
 *  its OWNER'S bucket. The extra headroom is spent entirely on names that
 *  contend with nothing.
 *
 *  ⚠ Cloud-enforced only; no server reads it, so changing it is a one-sided
 *  deploy with no ordering hazard. */
export const ACME_ISSUE_CERT_RATE_LIMIT_PER_DAY =
  (1 + CUSTOM_DOMAIN_MAX_PER_SERVER) * 2;

/** D-148 § A.5.3 — replay-window for the signed ACME request. */
export const ACME_REPLAY_WINDOW_MS = 5 * 60 * 1000;

// ────────────────────────────────────────────────────────────────
// § A.5.5 — Reachability probe (already shaped in reachability.ts;
// the request envelope shipped here adds a method discriminator
// for the worker router)
// ────────────────────────────────────────────────────────────────

/** Closed list of error codes the reachability probe can return. */
export type ReachabilityErrorCode =
  | 'reachability_validation_error'
  | 'reachability_hostname_invalid'
  | 'reachability_rate_limited';

// ────────────────────────────────────────────────────────────────
// § A.12 — OAuth callback state token
// ────────────────────────────────────────────────────────────────

/** D-148 § A.12 — payload of the OAuth `state` token. The cloud
 *  Worker that serves the static page does NOT verify or read this;
 *  it's the client-side static-JS callback that decodes + verifies.
 *  Encoded here as canonical JSON so the wire bytes are stable.
 *
 *  `server_url` is the URL the static-JS callback POSTs `{ code,
 *  state }` to. `flow_id` is the one-time-per-OAuth-start
 *  identifier the user-server uses to look up its stored PKCE
 *  verifier. `ts` is the issuance timestamp used for short-window
 *  replay defense (60s typical). */
export interface OauthStateTokenPayload {
  server_url: string;
  flow_id: string;
  ts: number;
  /** Optional provider hint (e.g., 'slack', 'google'). The
   *  user-server doesn't strictly need this — flow_id resolves
   *  the provider — but having it in-band makes telemetry +
   *  error messages easier. */
  provider?: string;
}

/** D-148 § A.12 — wire form of the encoded state token. The static
 *  JS receives `state = <base64url-canonical-json>.<base64-sig>`.
 *  Decode side splits on the dot, verifies the signature against
 *  the publisher's `server_identity_key` (fetched once from the
 *  user-server's JWKS during OAuth-start), then parses the JSON. */
export interface OauthStateTokenWire {
  payload_b64: string;
  signature_b64: string;
}

/** D-148 § A.12 — replay-window for the signed `state` token. The
 *  static-JS callback rejects state tokens older than this. */
export const OAUTH_STATE_TOKEN_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** D-148 § A.12 — closed list of static-JS callback error codes. */
export type OauthCallbackErrorCode =
  | 'oauth_state_missing'
  | 'oauth_state_signature_invalid'
  | 'oauth_state_replay_window_exceeded'
  | 'oauth_state_malformed'
  | 'oauth_code_missing'
  | 'oauth_server_url_missing';

/** D-148 § A.12 — canonical cloud OAuth callback URL. The static-JS
 *  page (`backend/api/src/routes/oauth-callback.ts`) is served here; it
 *  verifies the signed `state` and forwards the authorization `code` to
 *  the user-server's `/oauth/complete`. This is one of the two
 *  redirect-URI choices a user registers with their BYO vendor OAuth app
 *  — the cloud-relayed path, used when the user-server has no publicly
 *  reachable HTTPS URL. Tokens never touch the cloud (I-18): the page
 *  only relays the opaque code. */
export const OAUTH_CLOUD_CALLBACK_URL = 'https://app.recued.com/oauth-callback' as const;

/** D-148 § A.12 — the redirect-URI choices a user may register with
 *  their BYO vendor OAuth app (HubSpot / Salesforce Connected App).
 *  Two paths, both exchanging the code on the user-server (I-18):
 *
 *    1. `OAUTH_CLOUD_CALLBACK_URL` — the cloud static page relays the
 *       code to `<server_url>/oauth/complete`. Works behind NAT /
 *       dynamic IP; the only requirement is the browser can reach the
 *       user-server (it already does, for the paired webclient WS).
 *    2. `<server_url>/oauth/complete` — the provider redirects straight
 *       to the user-server. No cloud hop; available only when the server
 *       has a stable public HTTPS URL (Pro DDNS+ACME, or a BYO domain).
 *
 *  `server_url` is the user-server's configured public base URL; the
 *  signed `state` carries it either way so the cloud page knows where to
 *  forward. The OAuth-start rpc validates the user's chosen
 *  `redirect_uri` against this list (the authorization code can only
 *  land on a Recued-completable endpoint); the webclient picker and the
 *  copy-paste hint a user pastes into their vendor app render from it.
 *  Both choices require a canonical HTTPS origin for `server_url` (the
 *  cloud path also POSTs the code to `<server_url>/oauth/complete`); a
 *  non-canonical / non-HTTPS value yields NO choices. */
export const vendorOAuthRedirectChoices = (server_url: string): string[] => {
  const origin = canonicalizeServerPublicUrl(server_url);
  return origin ? [OAUTH_CLOUD_CALLBACK_URL, `${origin}/oauth/complete`] : [];
};

/** D-148 § A.12 — canonicalize the user-server's configured public base
 *  URL to a clean HTTPS origin (`https://host[:port]`), or null when it
 *  is unusable. This is a security control, not cosmetics: the origin is
 *  signed into the OAuth `state` and the cloud callback page POSTs the
 *  authorization code to `<origin>/oauth/complete`, so a stray trailing
 *  slash (`//oauth/complete`), an `http:` scheme, embedded credentials,
 *  or a path / query / fragment must never reach that construction.
 *  Rejects (→ null): non-parseable input, non-`https:` scheme, any
 *  userinfo, and any non-root path / search / hash. Returns `url.origin`
 *  (no trailing slash) so callers concatenate `/oauth/complete` safely.
 *  Idempotent — re-canonicalizing an origin returns the same origin. */
export const canonicalizeServerPublicUrl = (raw: string): string | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return null;
  return url.origin;
};

// ────────────────────────────────────────────────────────────────
// D-176 Terms §14 — operator abuse-hold action (INTERNAL, operator-only)
// ────────────────────────────────────────────────────────────────

/** The two operator abuse actions. `hold` → `onDisabled` (a sticky
 *  DNS-publication hold that outranks entitlement and is never lifted by a
 *  subscription `activate`); `release` → `onReEnabled` (lifts the hold +
 *  re-converges to the CURRENT entitlement: republish if still Pro, else
 *  park `suspended`). Deliberately NOT members of `DnsLifecycleOp` — the
 *  subscription lifecycle queue must never be able to abuse-hold a handle. */
export type OperatorAbuseAction = 'hold' | 'release';

/** Closed enumeration of `OperatorAbuseAction`, kept in lockstep with the
 *  union above so the route's `operator_action_unknown` path is reachable. */
export const OPERATOR_ABUSE_ACTIONS: ReadonlyArray<OperatorAbuseAction> = [
  'hold',
  'release',
] as const;

/** Wire shape posted to `POST /v1/ops/abuse` — Recued staff acting on a
 *  substantiated abuse report. NOT a publisher path: it is authenticated by
 *  an OPERATOR Ed25519 signature over the canonical-JSON of `{ action,
 *  handle, reason?, nonce, timestamp }`, verified against the pinned
 *  `OPERATOR_ABUSE_PUBLIC_KEY` Worker secret (only the PUBLIC half lives in
 *  the Worker, so an env leak can't forge an action). The signed `reason`
 *  cannot be swapped post-signing. Replay-windowed + nonce-ledgered like the
 *  handle-governance routes. Distinct from the PUBLIC
 *  `/v1/ddns/handle/abuse-report` intake (the anonymous report queue): this
 *  is the act-on-it surface. */
export interface OperatorAbuseRequest {
  action: OperatorAbuseAction;
  /** The Pro DDNS handle to hold / release (canonical, case-insensitive). */
  handle: string;
  /** Operator justification (the abuse-ticket reference) recorded on the
   *  durable audit row. Signed so it can't be tampered post-signing; meaningful
   *  for `hold`. */
  reason?: string;
  signature: string;
  nonce: string;
  timestamp: number;
}

export interface OperatorAbuseResponse {
  action: OperatorAbuseAction;
  /** The canonical (lower-cased) handle the action targeted. */
  handle: string;
  /** True iff a state-changing hold/release was actually applied AND audited.
   *  False is a clean no-op: the handle had no desired row (`hold`), or it was
   *  not currently `disabled` (`release`). */
  applied: boolean;
  /** Operator-clock epoch-ms the action was processed at. */
  at: number;
}

/** Closed list of error codes the operator abuse endpoint can return. */
export type OperatorAbuseErrorCode =
  /** `OPERATOR_ABUSE_PUBLIC_KEY` is unset — the endpoint is inert (fail-closed)
   *  until the operator pubkey is deployed. */
  | 'operator_not_configured'
  | 'operator_validation_error'
  | 'operator_action_unknown'
  | 'operator_signature_invalid'
  | 'operator_replay_window_exceeded'
  | 'operator_replay_duplicate'
  | 'operator_rate_limited'
  /** A concurrent desired-state write bumped the row's version mid-apply
   *  (`dns_lifecycle_cas_conflict`) — retryable. */
  | 'operator_conflict';

/** D-176 — replay-window for the signed operator abuse request (5 min,
 *  matching the ACME / handle-governance windows). */
export const OPERATOR_ABUSE_REPLAY_WINDOW_MS = 5 * 60 * 1000;

// ────────────────────────────────────────────────────────────────
// § A.14 / § Cloud Logging Contract — log allowlist for Workers
// ────────────────────────────────────────────────────────────────

/** D-148 § Cloud Logging Contract — closed-list of fields any cloud
 *  Worker can structured-log on a request. Anything outside this
 *  set must NOT enter the log stream. The DDNS / ACME / reachability
 *  / OAuth callback / marketplace Workers each compose
 *  their log lines from a subset of these.
 *
 *  Notably absent: `code`, `state`, `csr_pem`, `cert_pem`, `body`,
 *  `headers.authorization`, query-string, fragment. Worker code
 *  audit: the helper that writes these lines must enumerate the
 *  closed list rather than spread an arbitrary object. */
export const CLOUD_LOG_ALLOWED_FIELDS: ReadonlyArray<string> = [
  'method',
  'status',
  'response_size_bytes',
  'duration_ms',
  'path_family',
  'publisher_id_hash',
  'rate_limit_decision',
  'error_code',
  'request_id',
] as const;

export type CloudLogField = (typeof CLOUD_LOG_ALLOWED_FIELDS)[number];

/** Closed list of cloud path families. The Worker's log line carries
 *  ONLY the family, never the full path (which could include query
 *  string in OAuth-callback ingress). § A.14 + § Cloud Logging
 *  Contract enforce.
 *
 *  The first six are the D-148-narrowed PUBLIC cloud surface. `/v1/ops/*`
 *  (D-176 Terms §14) is a distinct INTERNAL operator-only family — it is
 *  NOT a publisher-facing endpoint and is never advertised in an exposure
 *  preset; it appears here solely so its handler can compose an allowlisted
 *  log line. Adding it does not widen the public surface. */
export type CloudPathFamily =
  | '/v1/ddns/*'
  | '/v1/acme/*'
  | '/v1/reachability/*'
  | '/v1/diagnostics/*'
  | '/oauth-callback*'
  | '/v1/marketplace/*'
  | '/v1/ops/*';

export const CLOUD_PATH_FAMILIES: ReadonlyArray<CloudPathFamily> = [
  '/v1/ddns/*',
  '/v1/acme/*',
  '/v1/reachability/*',
  '/v1/diagnostics/*',
  '/oauth-callback*',
  '/v1/marketplace/*',
  '/v1/ops/*',
] as const;

/** D-148 A.14 + D-152 P1 - narrowed cloud-family predicate. */
export const isCloudPathFamily = (f: string): f is CloudPathFamily =>
  (CLOUD_PATH_FAMILIES as ReadonlyArray<string>).includes(f);

// ────────────────────────────────────────────────────────────────
// § A.5.4 — sources_degraded code for cert renewal failures
// ────────────────────────────────────────────────────────────────

/** D-148 § A.5.4 — coverage degradation code emitted when the
 *  cert-renewal task fails. Reachability Doctor surfaces this. */
export const CERT_RENEWAL_OVERDUE_DEGRADED_REASON = 'cert_renewal_overdue' as const;
