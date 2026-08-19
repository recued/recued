/** D-148 — substrate-wide constants.
 *
 *  Cert rotation overlap, ACME renewal cadence, and reachability
 *  probe limits. Centralized here so spec callouts +
 *  test fixtures + runtime callers share one source.
 */

/** D-148 § A.6.5 — staging lead time for cert rotation. Server emits
 *  the signed `cert.rotation_notice` at `T - CERT_ROTATION_NOTICE_LEAD_TIME_MS`
 *  before rotating; clients receive the notice and persist
 *  `next_fingerprint`. 7 days gives offline clients (laptops asleep
 *  over a long weekend, phones in airplane mode) a realistic window
 *  to come online before the rotation. */
export const CERT_ROTATION_NOTICE_LEAD_TIME_MS = 7 * 24 * 60 * 60 * 1000;

/** D-148 § A.6.5 — overlap window after rotation during which both
 *  the previous and next cert fingerprints are accepted at handshake.
 *  An offline client that missed the rotation notice but reconnects
 *  during overlap presents the previous fingerprint; the server's
 *  current fingerprint matches the client's persisted `next` (which
 *  it learns post-fact via state.snapshot) → handshake succeeds
 *  without re-pair. After overlap expires, clients still pinned to
 *  the previous fingerprint fail with `cert_pin_stale` + admin-token
 *  re-pair prompt. */
export const CERT_ROTATION_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

/** D-148 § A.5.4 — kick off cert renewal when current cert is within
 *  this window of expiry.
 *
 *  ⛔⛔ THE ORIGINAL RATIONALE HERE WAS "ACME-issued certs from Let's
 *  Encrypt are 90-day certs; 30 days is the standard cadence." THAT
 *  PREMISE IS FALSE AS OF 2026-08-17 and the value is now a CEILING that
 *  happens to be safe, not a derivation that is correct. Corrected on
 *  measured evidence (invention round 9, T5-4 — arithmetic driven, not
 *  estimated):
 *
 *    cert life │ renews at │ overlap as % of life
 *      200 d   │  day 170  │    3.5 %   ← CA/B cap since 2026-03-15
 *       47 d   │  day  17  │   14.9 %   ← CA/B cap from 2029-03-15
 *        6 d   │  day −24  │  116.7 %   ← Let's Encrypt short-lived, GA TODAY
 *
 *  🔑 The published CA/Browser step-downs (398 → 200 → 100 → 47 days) are
 *  NOT the hazard: a 30-day lead simply renews earlier as a fraction of
 *  life and stays correct all the way down to 47 days. **Short-lived
 *  certificates are the hazard, and they are available now.** At a 6-day
 *  lifetime the renewal instant is 24 days in the PAST at issuance, so
 *  `valid_until - now > threshold` is never true and the renewal path is
 *  eligible from the moment the cert is minted — bounded only by
 *  `RENEWAL_COOLDOWN_MS` (6 h) on the housekeeping path and by
 *  `inFlight`/backoff on the D-235 custom-domain path, neither of which is
 *  a correct answer, only a survivable one. And
 *  `CERT_ROTATION_OVERLAP_MS` (7 d) then EXCEEDS THE WHOLE CERTIFICATE
 *  LIFETIME: a client pinned to the previous fingerprint is still nominally
 *  "inside overlap" after the NEXT certificate has itself expired.
 *
 *  ⛔ AND YET THIS IS NOT BROKEN TODAY — CHECK REACHABILITY BEFORE COSTING A
 *  FIX. Let's Encrypt's 6-day certs require explicitly requesting the
 *  `shortlived` PROFILE. This tree requests NO acme profile at all (zero
 *  matches across `packages/server-network/src/acme-client.ts` and
 *  `backend/api/src/routes/acme.ts`), so it takes the CA default — still ~90
 *  days — where a 30-day lead and a 7-day overlap are CORRECT, not merely
 *  survivable. The hazard above is conditional on a request we do not make.
 *
 *  🔑 AND THE INPUT IS NOT MISSING EITHER. An earlier draft of this note
 *  claimed a lifetime-aware lead time "needs a persisted `valid_from` on the
 *  cert row first". **That was wrong and is retracted.** The certificate
 *  itself is already stored — `cert_pem_encrypted BLOB NOT NULL`
 *  (`backend/server/src/storage/hostname-registry.ts:103`) — and an X.509
 *  cert carries `notBefore`. Lifetime is already in hand; it is simply not
 *  parsed out. A `valid_from` column would CACHE a fact we hold, not supply a
 *  missing one, and is worth adding only if something reads it on a hot path.
 *
 *  ⇒ THE TRIPWIRE, which is the whole point of this note: **the day anyone
 *  adds a profile request to the ACME order, the same change must derive the
 *  lead time and the rotation overlap from the cert's own lifetime** — parse
 *  `notBefore`, then `min(CERT_RENEWAL_LEAD_TIME_MS, floor(lifetime / 3))`
 *  and clamp `CERT_ROTATION_OVERLAP_MS` the same way. Until then this stays a
 *  fixed ceiling and is correct for every lifetime at or above ~90 days. */

export const CERT_RENEWAL_LEAD_TIME_MS = 30 * 24 * 60 * 60 * 1000;

/** D-148 § A.5.4 — hard expiry warning surfaced at user level. At
 *  this point reachability degraded, sources_degraded flag set. */
export const CERT_RENEWAL_USER_WARNING_LEAD_TIME_MS = 7 * 24 * 60 * 60 * 1000;

/** D-148 § A.5.2 — DDNS update replay window. Cloud Worker rejects
 *  POSTs whose `timestamp` is older than `now - DDNS_UPDATE_REPLAY_WINDOW_MS`. */
export const DDNS_UPDATE_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** D-148 § A.5.2 spec-canonical name — server-side DDNS poll
 *  interval. Server detects public IP every interval; only POSTs to
 *  the cloud when changed. */
export const DDNS_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

/** Compatibility alias preserving the prior name; matches
 *  `DDNS_UPDATE_INTERVAL_MS`. */
export const DDNS_POLL_INTERVAL_MS = DDNS_UPDATE_INTERVAL_MS;

/** D-148 § A.5.6 — handle subscription grace period. Pro lapse →
 *  handle continues resolving for this window; after window expires
 *  handle releases to public pool. Spec-canonical name. */
export const HANDLE_GRACE_PERIOD_MS = 60 * 24 * 60 * 60 * 1000;

/** Days form of the grace window for UI / config surfaces. */
export const HANDLE_SUBSCRIPTION_GRACE_DAYS = 60;

/** Compatibility alias preserving the prior name. */
export const HANDLE_SUBSCRIPTION_GRACE_MS = HANDLE_GRACE_PERIOD_MS;

/** D-148 § A.5.1 — handle-change soft-redirect window. Old handle's
 *  DDNS continues resolving with a temporary redirect to the new
 *  handle for this window. Best-effort transition, not security-
 *  load-bearing. Spec-canonical name. */
export const HANDLE_OLD_REDIRECT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Compatibility alias preserving the prior name. */
export const HANDLE_CHANGE_REDIRECT_WINDOW_MS = HANDLE_OLD_REDIRECT_WINDOW_MS;

/** D-148 § A.4.2 — webclient state snapshot cache TTL. Reused on
 *  reload before refetching unless explicitly invalidated. */
export const WEBCLIENT_STATE_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

/** D-148 § A.6.5 — TLS warning thresholds for reachability doctor
 *  recommendations (`tls_renewal_imminent` vs `tls_renewal_overdue`). */
export const TLS_RENEWAL_IMMINENT_DAYS = 14;
export const TLS_RENEWAL_OVERDUE_DAYS = 7;

/** D-148 § A.3.3 — bridge keepalive WS ping cadence (server side).
 *  Server pings the bridge every 25 seconds because Chrome's MV3
 *  service-worker idle timeout is 30 seconds. */
export const BRIDGE_KEEPALIVE_INTERVAL_MS = 25 * 1000;

/** D-148 § A.3.3 — `chrome.alarms` keepalive period (bridge side).
 *  Period is in minutes per the Chrome API; 0.5 minutes = 30 seconds. */
export const BRIDGE_ALARMS_PERIOD_MIN = 0.5;

/** D-148 § A.6.2 — webhook port body cap. Inbound POST > this size
 *  rejects with HTTP 413. Webhook bodies are typically tiny JSON;
 *  10 MB is a generous ceiling. */
export const WEBHOOK_BODY_MAX_BYTES = 10 * 1024 * 1024;

/** D-148 § A.6.2 — global webhook rate limit (server-wide protect-
 *  against-burst cap). Per-vendor limits apply on top of this. */
export const WEBHOOK_GLOBAL_RATE_LIMIT_RPS = 1000;

/** D-148 § A.6.1 — WS rate limit per token. Authenticated client
 *  rpcs are capped at this rate. */
export const WS_PER_TOKEN_RATE_LIMIT_RPS = 100;

/** D-148 § A.6.3 — MCP rate limit per token. AI-agent clients are
 *  rate-limited per the per-pair MCP visibility token. */
export const MCP_PER_TOKEN_RATE_LIMIT_RPM = 60;
