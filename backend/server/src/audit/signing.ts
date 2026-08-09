/** D-148 § A.2.5 — high-assurance audit signing.
 *
 *  Audit rows whose `action` is in `HIGH_ASSURANCE_AUDIT_KINDS`
 *  carry an Ed25519 signature over the canonical-JSON of the row
 *  minus the signature field, signed with the server's
 *  `server_identity_key`. This module is the substrate-side
 *  primitive: a wrapper around `AuditLogStore` that stamps the
 *  signature at emit time + a verifier callable at read time.
 *
 *  Why a wrapper. The D-120 `AuditLogStore` is shared between the
 *  extension + server + cloud surfaces. The signing path is
 *  server-only because only the server holds `server_identity_key`.
 *  Wrapping keeps the AuditLogStore contract clean — non-server
 *  surfaces continue to call `logActivity` without needing to
 *  carry a signing key + the wrapper is a one-line wiring change
 *  at the server's audit-log construction site.
 *
 *  Canonical-JSON discipline matches the pair-blob substrate so
 *  one canonicalizer covers both surfaces. Sender + verifier MUST
 *  produce the same byte sequence under the signature — diverging
 *  here would be invisible at write time and only fail at verify.
 *
 *  The verifier returns boolean + a reason. Callers that read
 *  audit rows for compliance / replay defense must treat
 *  `requires_signature` rows missing or failing verification as
 *  tampered + surface them in the Settings → Audit panel.
 */

import { isHighAssuranceAuditKind } from '@recued/contracts';
import type { ActivityEntry, AppendOptions, AuditLogStore } from '@recued/storage';
import {
  ed25519Sign,
  ed25519Verify,
  type Ed25519Keypair,
} from '../keys/index.js';
import { canonicalJSONStringify } from '@recued/crypto';

// ────────────────────────────────────────────────────────────────
// Sign / verify primitives
// ────────────────────────────────────────────────────────────────

/** Strip both `signature` AND `signer_fingerprint` from an entry to
 *  produce the byte sequence the signature commits to. The
 *  fingerprint travels alongside the signature so the verifier can
 *  look up the right public key from a rotation-history store, but
 *  it must NOT be in the canonical bytes the signature signs over —
 *  otherwise the signing path would be circular (signature commits
 *  to a fingerprint of the key that's about to sign). Stripping both
 *  keeps the signed bytes stable while letting the verifier pin the
 *  signer at read time. */
const stripSignatureFields = (entry: ActivityEntry): ActivityEntry => {
  if (entry.signature === undefined && entry.signer_fingerprint === undefined) {
    return entry;
  }
  const { signature: _signature, signer_fingerprint: _fingerprint, ...rest } = entry;
  return rest as ActivityEntry;
};

/** Sign an `ActivityEntry`. The caller is responsible for choosing
 *  WHEN to sign (typically only when the action is in
 *  HIGH_ASSURANCE_AUDIT_KINDS); this primitive operates on any
 *  shape so callers can layer policy as needed. The signer's public-
 *  key fingerprint is recorded on the row so the verifier (after
 *  rotation) can look up the correct public key from a key-history
 *  store. */
export const signActivityEntry = (
  entry: ActivityEntry,
  server_identity: Ed25519Keypair,
): ActivityEntry => {
  const stripped = stripSignatureFields(entry);
  const sig = ed25519Sign(server_identity, canonicalJSONStringify(stripped));
  return {
    ...stripped,
    signature: sig,
    signer_fingerprint: server_identity.public_key_fingerprint,
  };
};

export type ActivityVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'signature_missing'
        | 'signature_malformed'
        | 'signature_invalid'
        | 'public_key_malformed'
        | 'signer_fingerprint_unknown';
    };

/** Public-key resolver for verification. Given a fingerprint
 *  (`sha256:<hex>`) returns the matching base64 SPKI DER public key
 *  or null when no key in the rotation history matches. The audit
 *  path's read-time verifier wires this against the server's key
 *  history so pre-rotation rows continue to verify after a server
 *  identity rotation lands. */
export type PublicKeyResolver =
  | string
  | ((fingerprint: string) => string | null | undefined);

/** Verify an `ActivityEntry`'s signature. Accepts either:
 *
 *   - A string base64 SPKI DER (single-key path, matches D-148 P2's
 *     simple rotation-naive flow + every test fixture).
 *   - A `(fingerprint) => string | null` resolver (rotation-aware
 *     path, looks the right key up by `entry.signer_fingerprint`).
 *
 *  Returns ok-false rather than throwing so callers can route every
 *  failure mode through the same handling. The closed reason
 *  taxonomy distinguishes signature-shape errors from key-lookup
 *  errors so downstream surfaces (Settings → Audit panel) can render
 *  appropriate context. */
export const verifyActivityEntry = (
  entry: ActivityEntry,
  resolver: PublicKeyResolver,
): ActivityVerifyResult => {
  if (entry.signature === undefined) {
    return { ok: false, reason: 'signature_missing' };
  }
  if (typeof entry.signature !== 'string' || entry.signature.length === 0) {
    return { ok: false, reason: 'signature_malformed' };
  }

  // Resolve the public key. String resolver = single-key path; fn
  // resolver = rotation-aware path (lookup keyed on
  // `entry.signer_fingerprint`).
  let server_public_key_b64: string | null = null;
  if (typeof resolver === 'string') {
    server_public_key_b64 = resolver;
  } else if (typeof resolver === 'function') {
    if (entry.signer_fingerprint === undefined) {
      // Backwards-compatible: rows signed before fingerprint
      // recording landed have no fingerprint; the resolver path
      // can't disambiguate. Caller should fall back to the
      // single-key resolver in that case; here we surface the
      // ambiguity as fingerprint-unknown.
      return { ok: false, reason: 'signer_fingerprint_unknown' };
    }
    server_public_key_b64 = resolver(entry.signer_fingerprint) ?? null;
    if (!server_public_key_b64) {
      return { ok: false, reason: 'signer_fingerprint_unknown' };
    }
  }
  if (typeof server_public_key_b64 !== 'string' || server_public_key_b64.length === 0) {
    return { ok: false, reason: 'public_key_malformed' };
  }

  const stripped = stripSignatureFields(entry);
  const sig_ok = ed25519Verify(
    server_public_key_b64,
    canonicalJSONStringify(stripped),
    entry.signature,
  );
  return sig_ok ? { ok: true } : { ok: false, reason: 'signature_invalid' };
};

/** True iff the row's action is in HIGH_ASSURANCE_AUDIT_KINDS *and*
 *  the row is missing a signature OR the signature fails verify
 *  against the supplied public key. Use at read time when the
 *  caller wants a single boolean for "this row is suspicious". */
export const isActivityEntryTampered = (
  entry: ActivityEntry,
  resolver: PublicKeyResolver,
): boolean => {
  if (!isHighAssuranceAuditKind(entry.action)) return false;
  return !verifyActivityEntry(entry, resolver).ok;
};

// ────────────────────────────────────────────────────────────────
// AuditLogStore wrapper
// ────────────────────────────────────────────────────────────────

export interface SigningAuditLogOptions {
  /** Identity provider — called on every signed write to fetch
   *  the current server_identity_key. Called per-write (not
   *  cached at construction) so post-rotation writes use the new
   *  key automatically. */
  getServerIdentity: () => Ed25519Keypair;
  /** Optional override of the "should this action be signed"
   *  predicate. Default: `isHighAssuranceAuditKind`. Tests pass a
   *  narrower predicate to exercise non-canonical configurations. */
  shouldSign?: (action: string) => boolean;
}

/** Wrap an existing `AuditLogStore` so `logActivity` calls auto-
 *  sign rows whose action is in `HIGH_ASSURANCE_AUDIT_KINDS`. All
 *  other methods pass through unchanged. */
export const createSigningAuditLog = (
  underlying: AuditLogStore,
  options: SigningAuditLogOptions,
): AuditLogStore => {
  const shouldSign = options.shouldSign ?? isHighAssuranceAuditKind;
  return {
    append: (entry, opts) => underlying.append(entry, opts),
    listRecent: (limit, opts) => underlying.listRecent(limit, opts),
    listWindow: (query) => underlying.listWindow(query),
    listByRecipe: (recipe_id, limit) => underlying.listByRecipe(recipe_id, limit),
    listByChannelSession: (id, limit, axis) =>
      underlying.listByChannelSession(id, limit, axis),
    listByCognitionSession: (id, limit, axis) =>
      underlying.listByCognitionSession(id, limit, axis),
    listByCorrelation: (id, limit, axis) =>
      underlying.listByCorrelation(id, limit, axis),
    // D-215 slice 2 — read-only pass-throughs like every sibling here.
    // ⚠ This decorator is EXHAUSTIVE by construction: `AuditLogStore` is
    // an interface, so a store method added without a line here fails to
    // compile rather than silently reaching the signing path unwrapped.
    listByExchangeRef: (exchange_ref, limit, axis) =>
      underlying.listByExchangeRef(exchange_ref, limit, axis),
    listPendingExchangeRefs: (limit) => underlying.listPendingExchangeRefs(limit),
    listInboundContractIds: (limit) => underlying.listInboundContractIds(limit),
    listByPeerContract: (contract_id, limit, axis) =>
      underlying.listByPeerContract(contract_id, limit, axis),
    listByDish: (dish_id, limit, axis) =>
      underlying.listByDish(dish_id, limit, axis),
    latestByDishes: (dish_ids) => underlying.latestByDishes(dish_ids),
    get: (run_id) => underlying.get(run_id),
    clearOlderThan: (cutoff_ms) => underlying.clearOlderThan(cutoff_ms),
    clearByRecipe: (recipe_id) => underlying.clearByRecipe(recipe_id),
    exportAll: () => underlying.exportAll(),
    size: () => underlying.size(),
    clearAll: () => underlying.clearAll(),
    listActivities: (limit) => underlying.listActivities(limit),
    exportActivities: () => underlying.exportActivities(),
    clearOldestActivities: (limit) => underlying.clearOldestActivities(limit),
    clearOldestEntries: (limit) => underlying.clearOldestEntries(limit),
    countReserveEntries: () => underlying.countReserveEntries(),
    countReserveActivities: () => underlying.countReserveActivities(),
    lastSuccessfulBridgeDispatch: (bridge_id, target_pattern) =>
      underlying.lastSuccessfulBridgeDispatch(bridge_id, target_pattern),
    async logActivity(entry: ActivityEntry, opts?: AppendOptions): Promise<void> {
      if (!shouldSign(entry.action)) {
        return underlying.logActivity(entry, opts);
      }
      // High-assurance rows pin `reserve: true` BEFORE signing, so
      // the signed bytes and the stored bytes stay identical: the
      // underlying store also auto-classifies from RESERVE_ACTIONS,
      // and signing an un-pinned row would leave the stored copy
      // carrying a `reserve: true` the signature never committed to,
      // breaking verify.
      //
      // ⚠ This comment used to claim RESERVE_ACTIONS "includes every
      // HIGH_ASSURANCE_AUDIT_KINDS entry". It does not — 19 of 37 are
      // absent (all of D-149's reception kinds), measured 2026-07-23.
      // The weaker true rule is the one that matters and it is the one
      // this line enforces: the PIN is what makes a high-assurance row
      // reserve-class, because the store resolves `entry.reserve`
      // ahead of auto-classification. Membership in RESERVE_ACTIONS is
      // belt-and-braces for rows written WITHOUT this wrapper.
      // Codex P1 #1 fold: signActivityEntry stamps the signer's
      // public-key fingerprint alongside the signature so post-
      // rotation verification with a key-history resolver can find
      // the right key for rows signed by retired identities.
      const pinned: ActivityEntry = { ...entry, reserve: true };
      const signed = signActivityEntry(pinned, options.getServerIdentity());
      return underlying.logActivity(signed, opts);
    },
  };
};
