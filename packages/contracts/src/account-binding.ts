/** D-175 P5 — recued.com account ↔ server binding contract.
 *
 *  The binding flow (ratified session model, see `docs/d-175-spec.md`
 *  "Account-binding protocol"):
 *
 *    1. The webclient (`app.recued.com`) detects the recued.com session
 *       (shared `__Host-` cookie via `/v1/auth/session`, no re-login).
 *    2. The auth Worker mints a short-lived, single-purpose **binding
 *       token** (claims: account id, publisher handle, iat, expiry,
 *       nonce, intended server identity, purpose `account_bind`).
 *    3. The webclient **relays just that token** to its paired server
 *       over the existing pair-RPC channel (`account.bind`). JS never
 *       reads the session cookie — only this narrow token crosses.
 *    4. The paired server **exchanges** the token with the Worker
 *       (`AccountBindingExchangeRequest`): the Worker verifies the
 *       token + account session + nonce + expiry + the server-identity
 *       proof, records account↔server ownership, and returns the
 *       **server-scoped account credential**
 *       (`AccountBindingExchangeSuccess`).
 *    5. The server **stores** that credential locally as identity-root
 *       material. It is what drives Pro conveniences (DDNS/ACME)
 *       server-side with no browser session.
 *
 *  This module is the SHARED contract surface — the request/response
 *  shapes both the server (exchange caller) and the Worker (exchange
 *  endpoint, a later cloud slice) speak, plus the pair-RPC request /
 *  response types and the secret-free binding summary the webclient /
 *  dashboard render. The SECRET-bearing stored record
 *  (`server_scoped_credential`) never appears in any contract type —
 *  it lives only in the server's identity store; only the secret-free
 *  `AccountBindingSummary` projection crosses the wire.
 *
 *  Cardinality (D-175 D10): one account can own many servers; one
 *  server has exactly one owning account at a time. On a given server
 *  that means a single binding slot — a bind from a different account
 *  is a CONFLICT that requires explicit, audited confirmation (no
 *  silent rebind). Order-independence: a bind completes whenever an
 *  authenticated account and a paired server coexist, regardless of
 *  which came first; the server imposes no "must have paired first"
 *  precondition.
 */

// ────────────────────────────────────────────────────────────────
// Exchange contract — server ↔ auth Worker
// ────────────────────────────────────────────────────────────────

/** The canonical claim object the server signs with its
 *  `server_identity_key` to prove control of the identity at exchange
 *  time. Serialized via canonical JSON; the resulting bytes are the
 *  `proof_payload`, the signature over them is `proof_signature`.
 *
 *  Binding the opaque `binding_token` into the signed payload prevents
 *  a captured proof from being replayed against a different token;
 *  `signed_at` gives the Worker a freshness bound. */
export interface AccountBindingProofClaims {
  /** The opaque binding token this proof authorizes the exchange of. */
  binding_token: string;
  /** `sha256:<hex>` fingerprint of the server_identity_key public half
   *  the proof is signed under. */
  server_fingerprint: string;
  /** Fixed discriminator so a proof minted for binding can never be
   *  mistaken for any other signing context. */
  purpose: 'account_bind_exchange';
  /** Unix-ms when the proof was signed. Freshness bound for the
   *  Worker. */
  signed_at: number;
}

/** Server → Worker binding-exchange request. The token is opaque to
 *  the server (only the Worker can decode + verify its claims); the
 *  server contributes the server-identity proof so the Worker can bind
 *  ownership to a verified server identity.
 *
 *  Rebind gating lives at the WORKER, not after the fact on the server:
 *  the server tells the Worker who currently owns it
 *  (`current_owner_account_id`) plus whether the user has confirmed a
 *  rebind (`confirm_rebind`). When the token authenticates a DIFFERENT
 *  account and `confirm_rebind` is not `true`, the Worker MUST return
 *  `AccountBindingExchangeConflict` WITHOUT recording ownership or
 *  consuming the token's nonce — so an unconfirmed conflict never
 *  mutates cloud state (the same token can then be re-sent with
 *  `confirm_rebind: true`). This is the "current-owner data before the
 *  write" boundary; the server cannot apply it after exchange because
 *  the exchange itself is the cloud-side ownership write. */
export interface AccountBindingExchangeRequest {
  /** The single-purpose binding token relayed from the webclient. */
  binding_token: string;
  /** `sha256:<hex>` of the server_identity_key public half. */
  server_fingerprint: string;
  /** SPKI-DER base64 of the server_identity_key public half — the
   *  Worker verifies `proof_signature` against this AND checks its
   *  fingerprint equals `server_fingerprint`. */
  server_public_key_b64: string;
  /** Canonical-JSON serialization of `AccountBindingProofClaims`. */
  proof_payload: string;
  /** Ed25519 signature (base64) over `proof_payload`. */
  proof_signature: string;
  /** The account that currently owns this server locally (the server's
   *  identity-store binding slot), or absent when unbound. The Worker
   *  compares it to the token's account to detect a rebind. */
  current_owner_account_id?: string;
  /** Explicit user confirmation to displace `current_owner_account_id`.
   *  Strict — only `true` authorizes the Worker to commit a rebind. */
  confirm_rebind: boolean;
}

/** Worker → server exchange success. Carries the server-scoped account
 *  credential — the one piece of secret material; the server persists
 *  it locally and never returns it over any rpc. */
export interface AccountBindingExchangeSuccess {
  ok: true;
  /** recued.com account id that now owns this server. */
  account_id: string;
  /** Publisher handle when the account has reserved one. */
  publisher_handle?: string;
  /** SECRET — the server-scoped account credential. Stored locally as
   *  identity-root material; drives Pro cloud conveniences server-side.
   *  Never crosses an `account.*` rpc response. */
  server_scoped_credential: string;
  /** Unix-ms the credential was issued. */
  credential_issued_at: number;
  /** Unix-ms the credential expires, when bounded. Absent = no
   *  server-known expiry (the cloud may still rotate it). */
  credential_expires_at?: number;
}

/** Closed list of exchange failure reasons.
 *
 *  Worker-side rejections: `token_expired` (past expiry),
 *  `token_invalid` (malformed / unknown / wrong purpose),
 *  `nonce_reused` (single-use token already redeemed), `proof_invalid`
 *  (signature fails verify / payload mismatch), `server_identity_mismatch`
 *  (token's intended server identity ≠ the proving server),
 *  `account_not_authenticated` (the account session backing the token
 *  is no longer valid).
 *
 *  Server-side / transport: `exchange_unavailable` (no Worker endpoint
 *  configured, or the call failed at the network layer), `internal`
 *  (unexpected Worker error). */
export type AccountBindingExchangeErrorCode =
  | 'token_expired'
  | 'token_invalid'
  | 'nonce_reused'
  | 'proof_invalid'
  | 'server_identity_mismatch'
  | 'account_not_authenticated'
  | 'exchange_unavailable'
  | 'internal';

/** Worker → server: the token authenticates a DIFFERENT account than
 *  the server's current owner and the user has not confirmed a rebind.
 *  The Worker returns this WITHOUT committing ownership or consuming the
 *  token nonce — the server surfaces the conflict and the user re-sends
 *  with `confirm_rebind: true`. Carries no credential. */
export interface AccountBindingExchangeConflict {
  ok: false;
  conflict: true;
  /** The account that currently owns this server (echoed from the
   *  request / the Worker's authoritative ownership map). */
  current_owner: { account_id: string; publisher_handle?: string };
  /** The account the relayed token authenticates — would displace the
   *  current owner on a confirmed rebind. */
  incoming: { account_id: string; publisher_handle?: string };
}

/** Worker → server exchange failure (or a locally-synthesized failure
 *  when the exchange could not be attempted). */
export interface AccountBindingExchangeFailure {
  ok: false;
  conflict?: false;
  code: AccountBindingExchangeErrorCode;
  /** Optional human-readable detail. NEVER carries token bytes or
   *  session material. */
  message?: string;
}

/** Discriminated exchange outcome. Callers branch on `ok`, then on
 *  `conflict` to separate the rebind-needs-confirmation case from a
 *  hard failure. */
export type AccountBindingExchangeOutcome =
  | AccountBindingExchangeSuccess
  | AccountBindingExchangeConflict
  | AccountBindingExchangeFailure;

// ────────────────────────────────────────────────────────────────
// Binding state — secret-free projection
// ────────────────────────────────────────────────────────────────

/** Secret-free view of the server's current binding. This is the only
 *  shape that crosses the wire — `server_scoped_credential` is
 *  deliberately absent. */
export interface AccountBindingSummary {
  /** recued.com account id that owns this server. */
  account_id: string;
  /** Publisher handle when present. */
  publisher_handle?: string;
  /** `sha256:<hex>` of the server identity the binding is anchored to. */
  server_fingerprint: string;
  /** Unix-ms the binding was first established. Preserved across an
   *  in-place credential refresh (same account re-binds). */
  bound_at: number;
  /** Unix-ms of the most recent confirmed rebind (different account
   *  took over). Absent until a rebind happens. */
  rebound_at?: number;
  /** Unix-ms the stored credential expires, when bounded. */
  credential_expires_at?: number;
}

/** Coarse binding state for status surfaces. `conflict` is a transient
 *  outcome of a bind attempt (surfaced in `AccountBindResult`), not a
 *  persisted state — `account.bindingStatus` only ever reports the
 *  durable `bound` / `unbound`. */
export type AccountBindingStatus = 'unbound' | 'bound';

// ────────────────────────────────────────────────────────────────
// Bound-servers read — the auth Worker's account-scoped projection
// (the seam the dashboard Account page consumes; D-175 P5 Worker half)
// ────────────────────────────────────────────────────────────────

/** D-175 P5 — secret-free projection of one cloud-side binding-audit
 *  row. The auth Worker keeps the authoritative account↔server ownership
 *  ledger (who owned which server, when, and the contention/expiry
 *  signals); this is the per-row shape the bound-servers read returns to
 *  the dashboard. NEVER carries `server_scoped_credential` or any token /
 *  session material.
 *
 *  Worker-side note: the Worker records only AUTHENTICATED outcomes
 *  (bind / rebind / conflict, plus failures that survive proof + token
 *  decryption — `account_bind_exchange_failed` with a `reason`). Forged
 *  proofs are rejected without a ledger row (no trustworthy account to
 *  attribute, and an unauthenticated audit write would be a storage-DoS
 *  vector); the relaying server still records every failed exchange in
 *  its own local signed ledger. */
export interface AccountBindingAuditEntry {
  /** Which binding lifecycle event this row records. */
  action: AccountBindingAuditAction;
  /** The account the event concerns — the owner for a bind/rebind, the
   *  incoming account for a conflict, the token's account for a failed
   *  exchange. */
  account_id: string;
  /** `sha256:<hex>` of the server identity the event concerns. */
  server_fingerprint: string;
  /** Unix-ms the event occurred (cloud clock). */
  at: number;
  /** For a confirmed rebind / a conflict: the account that was (or would
   *  be) displaced. */
  previous_account_id?: string;
  /** For `account_bind_exchange_failed`: the closed-list reason. */
  reason?: AccountBindingExchangeErrorCode;
}

/** D-175 P5 — the auth Worker's bound-servers read response (the seam
 *  the dashboard Account page consumes). Lists the servers an account
 *  currently owns — one secret-free `AccountBindingSummary` per server,
 *  newest binding first — plus a recent account-scoped binding-audit
 *  projection. The Worker owns + freezes this shape; the dashboard
 *  renders it. Never carries `server_scoped_credential`. */
export interface AccountBindingServersResponse {
  /** The account's currently-owned servers, newest binding first. */
  servers: AccountBindingSummary[];
  /** Recent binding-audit rows for the account, newest first. */
  audit: AccountBindingAuditEntry[];
}

// ────────────────────────────────────────────────────────────────
// Pair-RPC request / response (account.bind / unbind / bindingStatus)
// ────────────────────────────────────────────────────────────────

/** `account.bind` request — the webclient relays the binding token it
 *  minted over the pair channel. */
export interface AccountBindRelayRequest {
  /** The single-purpose binding token. Opaque to the server. */
  binding_token: string;
  /** Explicit confirmation to overwrite a DIFFERENT account's existing
   *  binding. Absent / false → a different-owner bind returns
   *  `conflict` WITHOUT storing (D-175 D10: no silent rebind). The UI
   *  re-mints a fresh token and re-relays with this set after the user
   *  confirms. */
  confirm_rebind?: boolean;
}

/** `account.bind` result.
 *
 *  - `bound` — newly bound (server had no owner) or an idempotent
 *    credential refresh by the SAME account.
 *  - `rebound` — a different account took ownership under explicit
 *    `confirm_rebind`. `previous_account_id` records who was displaced.
 *  - `conflict` — a different account attempted to bind WITHOUT
 *    confirmation. Nothing was stored; the caller surfaces the
 *    confirm UI from `current_owner` + `incoming`. */
export type AccountBindResult =
  | { outcome: 'bound'; binding: AccountBindingSummary }
  | {
      outcome: 'rebound';
      binding: AccountBindingSummary;
      previous_account_id: string;
    }
  | {
      outcome: 'conflict';
      current_owner: AccountBindingSummary;
      incoming: { account_id: string; publisher_handle?: string };
    };

/** `account.bindingStatus` response — secret-free current binding. */
export interface AccountBindingStatusResponse {
  status: AccountBindingStatus;
  binding: AccountBindingSummary | null;
}

/** `account.unbind` result. */
export type AccountUnbindResult =
  | { outcome: 'unbound'; previous: AccountBindingSummary }
  | { outcome: 'not_bound' };

/** Dashboard credential-rotate result — the binding survives with a
 *  bumped `credential_issued_at`; the server's old scoped credential is
 *  refused at the entitlement mint until a re-pair issues a fresh one. */
export type AccountRotateCredentialResult =
  | { outcome: 'rotated'; server: AccountBindingSummary }
  | { outcome: 'not_bound' };

// ────────────────────────────────────────────────────────────────
// Audit action kinds
// ────────────────────────────────────────────────────────────────

/** D-175 P5 — the binding audit action kinds. All are HIGH-ASSURANCE
 *  (Ed25519-signed with `server_identity_key`) AND reserve-class
 *  (survive retention pruning): identity-root coordination events form
 *  a non-repudiable ledger of who owned this server, when, and whether
 *  an exchange ever failed (the attack-trail signal).
 *
 *  These strings are mirrored into `HIGH_ASSURANCE_AUDIT_KINDS`
 *  (`keys.ts`) so the signing wrapper auto-signs them, and into
 *  `RESERVE_ACTIONS` (`@recued/storage` `audit.ts`) so they escape
 *  pruning — matching how `pair_revoke` / `key_rotation` are declared
 *  inline in both. A contract-side test asserts every action here is
 *  present in `HIGH_ASSURANCE_AUDIT_KINDS`. */
export const ACCOUNT_BINDING_AUDIT_ACTIONS = [
  /** Server bound to an account (fresh bind or same-account refresh). */
  'account_bind',
  /** A different account took ownership under explicit confirmation. */
  'account_rebind',
  /** Binding cleared — the server no longer has an owning account. */
  'account_unbind',
  /** A different account attempted to bind without confirmation;
   *  nothing stored (the ownership-contention forensic signal). */
  'account_bind_conflict',
  /** The Worker exchange failed (expired / invalid token, bad proof,
   *  unauthenticated account, unreachable Worker). `detail.reason`
   *  carries the `AccountBindingExchangeErrorCode`. */
  'account_bind_exchange_failed',
  /** The owner revoked the server's scoped credential from the dashboard
   *  (binding kept; re-pair issues the replacement). Cloud-DO-originated
   *  — appears in the dashboard binding audit feed. */
  'credential_rotate',
] as const;

/** One of the D-175 P5 binding audit action kinds. */
export type AccountBindingAuditAction =
  (typeof ACCOUNT_BINDING_AUDIT_ACTIONS)[number];
