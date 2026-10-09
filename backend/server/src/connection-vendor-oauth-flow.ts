/** D-148 § A.12 / D-165 enroll-host #1 — vendor OAuth-start substrate.
 *
 *  The partner to `connection-vendor-oauth.ts` (which exchanges the
 *  code AFTER it comes back). This module owns the BEFORE half:
 *
 *    1. Mint a signed, short-lived `state` token — Ed25519 over the
 *       `{ server_url, flow_id, ts }` payload via the server identity
 *       key. The D-148 § A.12 static callback page verifies this same
 *       signature (against the public half the webclient caches in
 *       `app.recued.com` sessionStorage) before forwarding the code,
 *       so a forged state can never redirect the code to an attacker's
 *       server_url.
 *    2. Build the vendor authorize URL the user's browser is sent to,
 *       with the signed state embedded.
 *    3. Hold the pending flow (vendor + BYO client creds + the chosen
 *       redirect_uri + sandbox flag) in a TTL'd, consume-once store
 *       keyed by `flow_id`, so `/oauth/complete` (slice 2) can resolve
 *       the exchange inputs when the code arrives.
 *
 *  No connection record is written here, and no IO happens in the pure
 *  `startVendorOAuth` builder — the rpc handler supplies the clock, the
 *  flow_id, and the server-identity signer, and owns `flowStore.put` +
 *  the public-key half of the response. Tokens never touch the cloud
 *  (D-148 I-18): the exchange runs on the user-server in slice 2.
 *
 *  Spec: D-148 § A.12 + `project-d165-vendor-oauth-popup-scope`. */

import { createHash, timingSafeEqual } from 'node:crypto';
import { randomBytes, base64ToBytes, bytesToBase64 } from '@recued/crypto';
import {
  buildVendorAuthorizeUrl,
  OAUTH_STATE_TOKEN_REPLAY_WINDOW_MS,
  type ConnectionVendorProvider,
  type OauthStateTokenPayload,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// base64url helpers
//
// The `state` token rides in the OAuth `state` query parameter and is
// echoed back by the provider, so it MUST be URL-safe end-to-end — a
// `+` in standard base64 is silently turned into a space by some
// query parsers. base64url (no padding) survives every hop. The
// static callback page decodes with the same alphabet
// (`b64urlToBytes`). The server-identity public key is NOT url-encoded
// here — it travels via the rpc response + a same-origin sessionStorage
// write, never through a URL, and the page's `b64urlToBytes` accepts
// standard base64 anyway.
// ────────────────────────────────────────────────────────────────

const b64StdToUrl = (std: string): string =>
  std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64UrlToStd = (url: string): string => {
  const s = url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (s.length % 4)) % 4;
  return s + '='.repeat(pad);
};

/** Encode bytes as base64url without padding. */
export const b64UrlEncode = (bytes: Uint8Array): string => b64StdToUrl(bytesToBase64(bytes));

/** Decode a base64url (padded or not) string back to bytes. */
export const b64UrlDecode = (s: string): Uint8Array => base64ToBytes(b64UrlToStd(s));

/** Default flow-id generator — 18 CSPRNG bytes → 24 url-safe chars.
 *  Injectable so tests pin a deterministic id. */
export const defaultFlowId = (): string => b64UrlEncode(randomBytes(18));

/** Default claim-secret generator — 32 CSPRNG bytes → 256 bits of entropy
 *  (matching the reception bearer-secret strength). The owner-binding
 *  nonce for the result-claim rpc; injectable so tests pin a deterministic
 *  value. Distinct from `flow_id`: the flow_id is broadcast (so any client
 *  can SEE the completion), the claim_secret is not (only the originator
 *  can CLAIM). */
export const defaultClaimSecret = (): string => b64UrlEncode(randomBytes(32));

/** Default PKCE `code_verifier` — 32 CSPRNG bytes → 43 url-safe chars, a
 *  valid RFC 7636 verifier (43-128 chars). Injectable so tests pin it.
 *  Only minted/used for providers that declare `oauth.supports_pkce`. */
export const defaultCodeVerifier = (): string => b64UrlEncode(randomBytes(32));

/** Derive the PKCE S256 `code_challenge` from a verifier:
 *  `base64url(sha256(code_verifier))`. The provider checks this against the
 *  verifier sent at token exchange, binding the code to THIS flow. */
export const deriveCodeChallenge = (code_verifier: string): string =>
  b64UrlEncode(createHash('sha256').update(code_verifier, 'utf8').digest());

/** Constant-time equality for the claim secret. `timingSafeEqual` requires
 *  equal-length buffers and throws otherwise, so the length pre-check is
 *  the cheap guard; the secret is fixed-length CSPRNG output, so length
 *  is not itself sensitive. Empty/mismatched-length → false. */
const claimSecretsMatch = (stored: string, submitted: string): boolean => {
  if (typeof submitted !== 'string' || submitted.length === 0) return false;
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(submitted, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

// ────────────────────────────────────────────────────────────────
// Pending-flow store (in-memory, TTL'd, consume-once)
// ────────────────────────────────────────────────────────────────

/** The pending-flow record stashed at OAuth-start and consumed by
 *  `/oauth/complete` (slice 2). Carries exactly the inputs the
 *  code-exchange (`completeVendorOAuth`) needs — no access/refresh
 *  token ever lives here. */
export interface VendorOAuthFlowRecord {
  flow_id: string;
  vendor: string;
  client_id: string;
  client_secret?: string;
  /** The redirect_uri the user registered with their BYO vendor app —
   *  threaded verbatim into the token exchange (OAuth requires the
   *  exchange `redirect_uri` to match the authorize-request value). */
  redirect_uri: string;
  sandbox: boolean;
  created_at: number;
  /** D-165 slice 3 — owner-binding nonce. Minted at OAuth-start and
   *  returned ONLY on the start rpc response (to the originating client).
   *  `/oauth/complete` copies it verbatim into the result-store entry, and
   *  `takeVendorOAuthResult` requires a constant-time match before handing
   *  the credential over. The completion broadcast carries only `flow_id`
   *  (it reaches every paired client of the same user), so this secret —
   *  held only by the dialog that started the flow — is what stops any
   *  OTHER paired client from claiming the refresh token off that
   *  broadcast. NEVER appears in any response except the originating start
   *  rpc, and never on the bus. */
  claim_secret: string;
  /** PKCE `code_verifier` (RFC 7636) — present ONLY for providers that
   *  declare `oauth.supports_pkce`. Minted at OAuth-start (the `code_challenge`
   *  derived from it rides the authorize URL) and sent verbatim at token
   *  exchange so the provider binds the code to THIS flow. Never leaves the
   *  server (server-side secret, like `claim_secret`); absent ⇒ the vendor
   *  doesn't do PKCE and the exchange sends none. */
  code_verifier?: string;
  /** R14 — form-supplied token endpoint for a generic (non-registry) vendor.
   *  Present ONLY on the form-supplied OAuth path; `/oauth/complete` reads it
   *  to synthesize the provider for the token exchange instead of resolving
   *  `vendor` against the registry. Absent ⇒ a registered vendor (resolve via
   *  `getVendorProvider(vendor)`). */
  token_endpoint?: string;
  /** R14 — form-supplied requested scopes, persisted alongside
   *  `token_endpoint` for the generic path. Carried for completeness — the
   *  exchange derives `granted_scopes` from the token response, not from these
   *  requested scopes (RFC 6749 § 3.3). */
  scopes?: ReadonlyArray<string>;
}

export interface VendorOAuthFlowStore {
  put(record: VendorOAuthFlowRecord): void;
  /** Consume-once: return the record and remove it. A flow_id is
   *  exchangeable exactly once. Returns null when absent or expired
   *  (expired entries are removed on access either way). */
  take(flow_id: string): VendorOAuthFlowRecord | null;
  /** Non-consuming read; expired → null (and swept). */
  peek(flow_id: string): VendorOAuthFlowRecord | null;
  /** Drop every expired entry. Cheap to call on an idle timer. */
  sweepExpired(): void;
  size(): number;
}

export interface CreateVendorOAuthFlowStoreOptions {
  now?: () => number;
  ttlMs?: number;
  /** Hard cap on live pending flows — defends against a burst of
   *  OAuth-starts within a single TTL window. Oldest-out on overflow.
   *  Defaults to `DEFAULT_MAX_PENDING_FLOWS`. */
  maxFlows?: number;
}

/** TTL slack above the signed-state replay window: a state the cloud
 *  page accepts is ≤ window old, but the POST round-trip + clock skew
 *  mean the server-side flow lookup lands slightly later. One extra
 *  minute keeps a just-valid flow findable. The authoritative
 *  freshness gate stays the signed `ts` window checked in
 *  `/oauth/complete` (slice 2); this TTL is only a memory bound. */
export const VENDOR_OAUTH_FLOW_TTL_MS = OAUTH_STATE_TOKEN_REPLAY_WINDOW_MS + 60_000;

/** Default hard cap on concurrently-pending OAuth flows. A single
 *  human-identity server starts these one at a time; 256 is already far
 *  beyond any honest concurrency and bounds a pathological burst. */
export const DEFAULT_MAX_PENDING_FLOWS = 256;

export const createVendorOAuthFlowStore = (
  opts: CreateVendorOAuthFlowStoreOptions = {},
): VendorOAuthFlowStore => {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? VENDOR_OAUTH_FLOW_TTL_MS;
  const maxFlows = opts.maxFlows ?? DEFAULT_MAX_PENDING_FLOWS;
  const flows = new Map<string, VendorOAuthFlowRecord>();
  const isExpired = (r: VendorOAuthFlowRecord): boolean => now() - r.created_at > ttlMs;
  const dropExpired = (): void => {
    for (const [id, r] of flows) {
      if (isExpired(r)) flows.delete(id);
    }
  };
  return {
    put: (record) => {
      // Evict-on-write: drop expired entries so abandoned starts (and
      // the BYO client_secret they carry) never accumulate even when no
      // external sweeper runs, then cap live flows oldest-out against a
      // burst within one TTL window. Map iterates in insertion order.
      dropExpired();
      flows.set(record.flow_id, record);
      while (flows.size > maxFlows) {
        const oldest = flows.keys().next().value;
        if (oldest === undefined) break;
        flows.delete(oldest);
      }
    },
    take: (flow_id) => {
      const r = flows.get(flow_id);
      if (!r) return null;
      flows.delete(flow_id);
      return isExpired(r) ? null : r;
    },
    peek: (flow_id) => {
      const r = flows.get(flow_id);
      if (!r) return null;
      if (isExpired(r)) {
        flows.delete(flow_id);
        return null;
      }
      return r;
    },
    sweepExpired: dropExpired,
    size: () => flows.size,
  };
};

// ────────────────────────────────────────────────────────────────
// Completed-exchange result store (in-memory, TTL'd, consume-once)
//
// `/oauth/complete` (slice 2) stashes the exchanged credential here keyed
// by flow_id; the enrollment dialog claims it ONCE — via a point-to-point
// rpc fired on a completion bus event — to patch the form before Save.
// Mirrors the pending-flow store's consume-once + TTL + evict-on-write
// discipline: the value is a secret (refresh_token), so it must never be
// read twice and must not linger. (Structural twin of the flow store; the
// value type differs.)
// ────────────────────────────────────────────────────────────────

/** The exchanged credential surfaced to the enrollment dialog. */
export interface VendorOAuthResult {
  refresh_token: string;
  granted_scopes: string[];
  instance_url?: string;
}

export interface VendorOAuthResultStore {
  put(
    flow_id: string,
    result: VendorOAuthResult,
    claim_secret: string,
    created_at: number,
  ): void;
  /** Consume-once + owner-bound (D-165 slice 3). Returns the result ONLY
   *  when `claim_secret` matches the value stored at `put` (constant-time).
   *  On match: consume + return. On mismatch: DO NOT consume — so the
   *  legitimate originating dialog can still claim after a wrong/racing
   *  client probes — → null. Absent / expired → null (expired removed). */
  take(flow_id: string, claim_secret: string): VendorOAuthResult | null;
  /** Non-consuming, secret-free read. Sweep + test helper — NOT a claim
   *  path (the refresh token is handed out only by the secret-gated `take`).
   *  expired → null (and swept). */
  peek(flow_id: string): VendorOAuthResult | null;
  sweepExpired(): void;
  size(): number;
}

export interface CreateVendorOAuthResultStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

/** How long a completed result waits for the dialog to claim it.
 *  Consume-once means typical residency is seconds (the dialog fetches on
 *  the completion bus event); the TTL is only the abandoned-flow bound. */
export const VENDOR_OAUTH_RESULT_TTL_MS = 10 * 60_000;

export const createVendorOAuthResultStore = (
  opts: CreateVendorOAuthResultStoreOptions = {},
): VendorOAuthResultStore => {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? VENDOR_OAUTH_RESULT_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_PENDING_FLOWS;
  const entries = new Map<
    string,
    { result: VendorOAuthResult; claim_secret: string; created_at: number }
  >();
  const isExpired = (e: { created_at: number }): boolean => now() - e.created_at > ttlMs;
  const dropExpired = (): void => {
    for (const [id, e] of entries) {
      if (isExpired(e)) entries.delete(id);
    }
  };
  return {
    put: (flow_id, result, claim_secret, created_at) => {
      dropExpired();
      entries.set(flow_id, { result, claim_secret, created_at });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    take: (flow_id, claim_secret) => {
      const e = entries.get(flow_id);
      if (!e) return null;
      if (isExpired(e)) {
        entries.delete(flow_id);
        return null;
      }
      // Owner-binding gate: a non-matching secret leaves the entry in place
      // so the legitimate dialog (which holds the secret) can still claim.
      // Only a correct secret consumes + returns the credential.
      if (!claimSecretsMatch(e.claim_secret, claim_secret)) return null;
      entries.delete(flow_id);
      return e.result;
    },
    peek: (flow_id) => {
      const e = entries.get(flow_id);
      if (!e) return null;
      if (isExpired(e)) {
        entries.delete(flow_id);
        return null;
      }
      return e.result;
    },
    sweepExpired: dropExpired,
    size: () => entries.size,
  };
};

// ────────────────────────────────────────────────────────────────
// State-token codec
// ────────────────────────────────────────────────────────────────

/** Encode + sign the OAuth `state` token. Wire form (D-148 § A.12):
 *  `<base64url(payload-json-bytes)>.<base64url(ed25519-sig)>`.
 *
 *  The signature is over the exact JSON payload BYTES, not the base64
 *  text — the static-JS callback verifies the same bytes after
 *  base64url-decoding `parts[0]`. Field order is fixed by the object
 *  literal so the encoded bytes are stable. */
export const encodeOauthStateToken = (
  payload: OauthStateTokenPayload,
  sign: (bytes: Uint8Array) => string,
): string => {
  const json = JSON.stringify({
    server_url: payload.server_url,
    flow_id: payload.flow_id,
    ts: payload.ts,
    ...(payload.provider !== undefined ? { provider: payload.provider } : {}),
  });
  const payloadBytes = new TextEncoder().encode(json);
  const sigStd = sign(payloadBytes);
  return `${b64UrlEncode(payloadBytes)}.${b64StdToUrl(sigStd)}`;
};

export interface DecodedOauthStateToken {
  payload: OauthStateTokenPayload;
  /** The exact bytes the signature is over — feed to `ed25519Verify`. */
  payload_bytes: Uint8Array;
  /** Standard-base64 signature, ready for `ed25519Verify`. */
  signature_b64: string;
}

/** Parse (NOT verify) a state token. Returns null on any structural
 *  malformation. Signature + replay-window + flow-lookup verification
 *  is `/oauth/complete`'s job (slice 2); this is the shared parser it
 *  and the test-suite use. */
export const decodeOauthStateToken = (state: string): DecodedOauthStateToken | null => {
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let payloadBytes: Uint8Array;
  let parsed: unknown;
  try {
    payloadBytes = b64UrlDecode(parts[0]);
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).server_url !== 'string' ||
    typeof (parsed as Record<string, unknown>).flow_id !== 'string' ||
    typeof (parsed as Record<string, unknown>).ts !== 'number'
  ) {
    return null;
  }
  let signature_b64: string;
  try {
    signature_b64 = bytesToBase64(b64UrlDecode(parts[1]));
  } catch {
    return null;
  }
  return {
    payload: parsed as OauthStateTokenPayload,
    payload_bytes: payloadBytes,
    signature_b64,
  };
};

// ────────────────────────────────────────────────────────────────
// Start orchestrator (the authorize-URL builder is `@recued/contracts`'
// `buildVendorAuthorizeUrl`, shared with the loopback dance the browser
// drives itself)
// ────────────────────────────────────────────────────────────────

export interface StartVendorOAuthOptions {
  provider: ConnectionVendorProvider;
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
  sandbox: boolean;
  server_url: string;
  flow_id: string;
  /** Owner-binding nonce stamped into the flow record. The handler mints
   *  it (`defaultClaimSecret`) and returns it only on the start rpc
   *  response — kept out of the builder's purity contract like `flow_id`. */
  claim_secret: string;
  /** PKCE `code_verifier`, minted by the handler (`defaultCodeVerifier`).
   *  Used ONLY when `provider.oauth.supports_pkce` — `startVendorOAuth`
   *  derives the challenge for the authorize URL + stamps the verifier into
   *  the record; for non-PKCE vendors it's ignored (no challenge, no record
   *  field). Kept out of the purity contract like `flow_id`/`claim_secret`. */
  code_verifier: string;
  now: number;
  /** Server-identity signer — `identity.signWithServerIdentity`. */
  sign: (bytes: Uint8Array) => string;
}

export interface StartVendorOAuthResult {
  authorize_url: string;
  state: string;
  record: VendorOAuthFlowRecord;
}

/** Pure OAuth-start: mint the signed state, build the authorize URL,
 *  and return the flow record the caller persists. No IO — the handler
 *  supplies the clock, flow_id, and signer, and owns `store.put` + the
 *  public-key half of the response. */
export const startVendorOAuth = (opts: StartVendorOAuthOptions): StartVendorOAuthResult => {
  const state = encodeOauthStateToken(
    {
      server_url: opts.server_url,
      flow_id: opts.flow_id,
      ts: opts.now,
      provider: opts.provider.vendor,
    },
    opts.sign,
  );
  // PKCE only for providers that declare support (HubSpot doesn't implement
  // it, so sending the params there would be rejected). When on, the challenge
  // rides the authorize URL and the verifier is stamped into the flow record
  // for the token exchange; the two together bind the code to THIS flow.
  const usePkce = opts.provider.oauth.supports_pkce === true;
  const code_challenge = usePkce ? deriveCodeChallenge(opts.code_verifier) : undefined;
  const authorize_url = buildVendorAuthorizeUrl({
    provider: opts.provider,
    client_id: opts.client_id,
    redirect_uri: opts.redirect_uri,
    sandbox: opts.sandbox,
    state,
    ...(code_challenge !== undefined ? { code_challenge } : {}),
  });
  const record: VendorOAuthFlowRecord = {
    flow_id: opts.flow_id,
    vendor: opts.provider.vendor,
    client_id: opts.client_id,
    ...(opts.client_secret !== undefined ? { client_secret: opts.client_secret } : {}),
    redirect_uri: opts.redirect_uri,
    sandbox: opts.sandbox,
    created_at: opts.now,
    claim_secret: opts.claim_secret,
    ...(usePkce ? { code_verifier: opts.code_verifier } : {}),
  };
  return { authorize_url, state, record };
};
