/** D-175 P8 — Pro convenience status contract (server-side).
 *
 *  The secret-free read surface the webclient's Settings → Account
 *  "Pro convenience bundle" consumes over the pair channel
 *  (`pro_convenience.status`). It reports, per convenience item
 *  (`<handle>.<ddns_domain>` DDNS · ACME cert · reserved handle), the
 *  state the server resolved from THREE inputs:
 *
 *    1. The recued.com account binding (D-175 P5 `server_scoped_credential`
 *       stored as identity-root material) — bound vs unbound.
 *    2. The Pro entitlement the server resolves OFF that binding credential
 *       (D-175 spec auth-architecture §, `:588-593`: "authenticated
 *       stateless — Ed25519 sig + a signed entitlement claim with TTL, no
 *       per-request DB"). This is the load-bearing gate.
 *    3. A reachability proof (`:636-637`: DDNS/ACME issuance waits for the
 *       server binding AND a reachability proof).
 *
 *  Pro stays friction-reduction only (`:697-698`): a Free account that
 *  binds renders `inactive-free`, never a capability gate.
 *
 *  Secret invariant. This shape NEVER carries `server_scoped_credential`
 *  nor the entitlement claim token — only coarse states + the already-
 *  secret-free `account_id` / `publisher_handle` (mirrors
 *  `AccountBindingSummary`) and the public `<handle>.<ddns_domain>`
 *  hostname. `pro_convenience.` is in `MCP_RESERVED_RPC_PREFIXES`: an
 *  MCP-channel agent must never read the Pro provisioning posture.
 *
 *  Consumer note. The dashboard (`dashboard.recued.com`, D-175 P3)
 *  computes its OWN convenience strip client-side from the account plan
 *  + binding status it reads off the auth Worker — it does NOT call this
 *  pair-RPC. This shape is the SERVER's vantage, read by the paired
 *  webclient (`:591`: "The webclient reads tier/plan from its paired
 *  server (pair-RPC)").
 */

/** Per-convenience-item state.
 *
 *  - `active` — provisioned + healthy.
 *  - `error` — provisioning attempted + failed (e.g. an expired cert), or
 *    the entitlement claim could not be verified (fail-closed).
 *  - `awaiting-server` — no account binding yet; the binding is the
 *    prerequisite for every convenience.
 *  - `awaiting-reachability` — bound + entitled, but no reachability proof
 *    yet (`:636-637`).
 *  - `inactive-free` — bound to a Free account; conveniences are Pro-only
 *    (friction-reduction, never a capability gate).
 *  - `pending` — the server cannot yet determine entitlement because the
 *    cloud endpoint that mints the signed Pro entitlement claim off the
 *    binding credential is not available yet (D-175 P8 typed seam — see
 *    the server-side `ProEntitlementSource`). Distinct from the five
 *    operational states; a bound server collapses out of `pending` into
 *    one of them once that cloud primitive lands. NEVER a fabricated
 *    success — a `pending` item is honestly "not yet provisionable".
 */
export const PRO_CONVENIENCE_ITEM_STATES = [
  'active',
  'error',
  'awaiting-server',
  'awaiting-reachability',
  'inactive-free',
  'pending',
] as const;

export type ProConvenienceItemState = (typeof PRO_CONVENIENCE_ITEM_STATES)[number];

/** Coarse entitlement signal the server resolved off the binding
 *  credential — the top-level gate the per-item states derive from.
 *
 *  - `entitled` — a verified, unexpired Pro entitlement claim.
 *  - `not_entitled` — bound, but the account is Free.
 *  - `unbound` — no account binding (→ every item `awaiting-server`).
 *  - `pending` — the cloud entitlement-mint endpoint is not available yet
 *    (the D-175 P8 typed seam; see `PRO_CONVENIENCE_ITEM_STATES.pending`).
 *  - `unavailable` — a transient failure resolving / verifying the claim
 *    (network, or an expired/invalid claim); the server fails closed.
 */
export const PRO_CONVENIENCE_ENTITLEMENTS = [
  'entitled',
  'not_entitled',
  'unbound',
  'pending',
  'unavailable',
] as const;

export type ProConvenienceEntitlement =
  (typeof PRO_CONVENIENCE_ENTITLEMENTS)[number];

/** Closed-list detail code accompanying a non-`active` item state. A
 *  display hint only — the renderer maps it to copy; never carries
 *  secret material. */
export const PRO_CONVENIENCE_DETAIL_CODES = [
  /** `pending` — the cloud entitlement-mint endpoint is not available yet
   *  (the D-175 P8 typed seam). */
  'entitlement_endpoint_pending',
  /** `error` — resolving / verifying the entitlement claim failed
   *  transiently, or the claim was expired/invalid (fail-closed). */
  'entitlement_unavailable',
  /** `awaiting-server` — no account binding. */
  'no_binding',
  /** `awaiting-reachability` — bound + entitled, no reachability proof. */
  'not_reachable',
  /** `inactive-free` — bound to a Free account. */
  'free_account',
  /** `error` — the ACME cert for the handle domain has expired. */
  'cert_expired',
  /** `pending` — entitled + reachable, but this item has not been
   *  provisioned yet (provisioning actuation pending — see the P8 server
   *  module header). */
  'not_provisioned',
] as const;

export type ProConvenienceDetailCode =
  (typeof PRO_CONVENIENCE_DETAIL_CODES)[number];

/** The three Pro convenience items reported per the spec
 *  (`:331-332`): the `<handle>.<ddns_domain>` DDNS record, the ACME cert,
 *  and the reserved handle. */
export interface ProConvenienceItem {
  state: ProConvenienceItemState;
  /** Closed-list display hint for a non-`active` state. */
  detail?: ProConvenienceDetailCode;
  /** ACME item only — cert expiry (unix-ms) when `active`. */
  expires_at?: number;
}

/** `pro_convenience.status` response — SECRET-FREE.
 *
 *  NEVER carries `server_scoped_credential` or the entitlement claim
 *  token (mirrors `manager.summarize()` dropping the credential). */
export interface ProConvenienceStatusResponse {
  /** Top-level entitlement gate the per-item states derive from. */
  entitlement: ProConvenienceEntitlement;
  /** The bound recued.com account id (secret-free; mirrors
   *  `AccountBindingSummary.account_id`). Absent when unbound. */
  account_id?: string;
  /** The bound account's publisher handle, when reserved (secret-free). */
  publisher_handle?: string;
  /** The `<handle>.<ddns_domain>` the conveniences target, when a handle
   *  is known. Public hostname; never secret. */
  ddns_hostname?: string;
  /** Per-item convenience state. */
  items: {
    handle: ProConvenienceItem;
    ddns: ProConvenienceItem;
    acme: ProConvenienceItem;
  };
}

/** The closed list of `pro_convenience.*` rpc method names. Mirrors the
 *  `account.*` / `pro_acme.*` registration discipline; the dispatcher
 *  known-method set + the MCP-reserved ratchet assert against it. */
export const PRO_CONVENIENCE_RPC_METHODS = ['pro_convenience.status'] as const;

export type ProConvenienceRpcMethod =
  (typeof PRO_CONVENIENCE_RPC_METHODS)[number];

/** D-175 P8b — signed Pro entitlement claim payload.
 *
 *  This is the JSON payload inside the auth-Worker-minted Ed25519
 *  entitlement envelope. The envelope itself is a bearer-like server/cloud
 *  credential and must never appear in `pro_convenience.status`; this type
 *  names only the signed claims so both Worker and server verify the same
 *  semantics.
 *
 *  Ownership-only semantics (owner-ratified). The mint proves the presenting
 *  server is the CURRENT bound owner of `account_id`; it does NOT decide
 *  paid vs free. `entitlement_tier: 'pro'` is therefore asserted
 *  OPTIMISTICALLY — the authoritative Pro gate is the cloud DDNS/ACME
 *  `subscription_active` flag, enforced downstream when the server actuates.
 *  `pro_convenience.status` is correspondingly optimistic (a bound Free
 *  account renders entitled but its conveniences never provision). */
export const PRO_ENTITLEMENT_CLAIM_PURPOSE = 'pro_entitlement_claim' as const;

export const PRO_ENTITLEMENT_TIERS = ['pro'] as const;

export type ProEntitlementTier = (typeof PRO_ENTITLEMENT_TIERS)[number];

export interface ProEntitlementClaim {
  v: 1;
  purpose: typeof PRO_ENTITLEMENT_CLAIM_PURPOSE;
  /** recued.com account id that owns the presenting server credential. */
  account_id: string;
  /** Asserted tier — always `'pro'` under the ownership-only mint (optimistic;
   *  see the header). Real paid/free enforcement is the downstream cloud
   *  `subscription_active` gate, not this field. */
  entitlement_tier: ProEntitlementTier;
  /** `sha256:<hex>` server identity fingerprint the claim is bound to. */
  server_fingerprint: string;
  /** Unix-ms issued-at. */
  iat: number;
  /** Unix-ms expiry. Verification fails closed after this time. */
  exp: number;
}
