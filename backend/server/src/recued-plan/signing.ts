/** D-145 PB2 — high-assurance RecuedPlan signing.
 *
 *  Plans whose `audit_policy.high_assurance: true` carry an Ed25519
 *  signature over the canonical-JSON of the plan minus the signature
 *  field, signed with the server's `server_identity_key`. This module
 *  is the substrate-side primitive: a wrapper around
 *  `RecuedPlanStore` that stamps the signature at append time + a
 *  verifier callable at read time.
 *
 *  Why a wrapper. The store is shared across in-memory / IDB / SQLite
 *  backings; signing is server-only because only the server holds
 *  `server_identity_key`. Wrapping keeps the store contract clean —
 *  non-server surfaces continue to call `append` without needing to
 *  carry a signing key + the wrapper is a one-line wiring change at
 *  the server's plan-store construction site.
 *
 *  Canonical-JSON discipline matches the pair-blob + audit-signing
 *  surfaces so one canonicalizer covers all three. Sender + verifier
 *  MUST produce the same byte sequence under the signature — diverging
 *  here would be invisible at write time and only fail at verify.
 *
 *  The verifier returns boolean + a reason. Callers that read plans
 *  for compliance / replay defense must treat
 *  `audit_policy.high_assurance: true` rows missing or failing
 *  verification as tampered + surface them in the Settings → Audit
 *  panel.
 *
 *  The implementation deliberately mirrors `audit/signing.ts` row-for-
 *  row to keep operational semantics consistent (rotation-aware
 *  resolver, fingerprint stamping, redact-before-sign discipline). */

import {
  REDACTED_USER_REQUEST_MARKER,
  redactUserRequest,
  stripPlanSignatureFields,
  type RecuedPlan,
} from '@recued/contracts';
import type { RecuedPlanStore, RecuedPlanListOptions } from '@recued/storage';
import {
  ed25519Sign,
  ed25519Verify,
  type Ed25519Keypair,
} from '../keys/index.js';
import { canonicalJSONStringify } from '@recued/crypto';

// ────────────────────────────────────────────────────────────────
// Sign / verify primitives
// ────────────────────────────────────────────────────────────────

/** Sign a `RecuedPlan`. The caller is responsible for choosing
 *  WHEN to sign (typically only when `audit_policy.high_assurance:
 *  true`); this primitive operates on any plan shape so callers can
 *  layer policy as needed. The signer's public-key fingerprint is
 *  recorded on the plan so the verifier (after rotation) can look up
 *  the correct public key from a key-history store.
 *
 *  Pure function — never mutates input. § B.5.5 redact-before-sign
 *  discipline is enforced HERE (not just at the store wrapper) so
 *  direct callers of `signRecuedPlan` can't bypass redaction —
 *  Codex P2 fold #1 from the PB2 review. When
 *  `audit_policy.redact_user_request: true` and `user_request` is
 *  not yet the marker, the input is redacted BEFORE the bytes hash
 *  so the signature commits to the redacted shape. Post-hoc
 *  redaction would invalidate the signature. */
export const signRecuedPlan = (
  plan: RecuedPlan,
  server_identity: Ed25519Keypair,
): RecuedPlan => {
  // Redact-before-sign per § B.5.5. The store wrapper applies the
  // same discipline upstream, but a direct caller of this
  // primitive (PB3 orchestrator's manual-write path / Dry Run
  // commit replay / one-shot test fixtures) must not be able to
  // bypass it. The substrate-level rule is "any signature ever
  // produced commits to redacted bytes."
  const redacted =
    plan.audit_policy.redact_user_request
    && plan.user_request !== REDACTED_USER_REQUEST_MARKER
      ? redactUserRequest(plan)
      : plan;
  const stripped = stripPlanSignatureFields(redacted);
  const sig = ed25519Sign(server_identity, canonicalJSONStringify(stripped));
  return {
    ...stripped,
    signature: sig,
    signer_fingerprint: server_identity.public_key_fingerprint,
  };
};

export type RecuedPlanVerifyResult =
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
 *  or null when no key in the rotation history matches. The plan
 *  read path's verifier wires this against the server's key history
 *  so pre-rotation plans continue to verify after a server identity
 *  rotation lands. Same shape as the audit-signing path's resolver. */
export type PlanPublicKeyResolver =
  | string
  | ((fingerprint: string) => string | null | undefined);

/** Verify a `RecuedPlan`'s signature. Returns ok-false rather than
 *  throwing so callers can route every failure mode through the same
 *  handling. The closed reason taxonomy distinguishes signature-shape
 *  errors from key-lookup errors so downstream surfaces (Settings →
 *  Audit panel, Plan Replay UI) can render appropriate context. */
export const verifyRecuedPlan = (
  plan: RecuedPlan,
  resolver: PlanPublicKeyResolver,
): RecuedPlanVerifyResult => {
  if (plan.signature === undefined) {
    return { ok: false, reason: 'signature_missing' };
  }
  if (typeof plan.signature !== 'string' || plan.signature.length === 0) {
    return { ok: false, reason: 'signature_malformed' };
  }

  let server_public_key_b64: string | null = null;
  if (typeof resolver === 'string') {
    server_public_key_b64 = resolver;
  } else if (typeof resolver === 'function') {
    if (plan.signer_fingerprint === undefined) {
      return { ok: false, reason: 'signer_fingerprint_unknown' };
    }
    server_public_key_b64 = resolver(plan.signer_fingerprint) ?? null;
    if (!server_public_key_b64) {
      return { ok: false, reason: 'signer_fingerprint_unknown' };
    }
  }
  if (typeof server_public_key_b64 !== 'string' || server_public_key_b64.length === 0) {
    return { ok: false, reason: 'public_key_malformed' };
  }

  const stripped = stripPlanSignatureFields(plan);
  const sig_ok = ed25519Verify(
    server_public_key_b64,
    canonicalJSONStringify(stripped),
    plan.signature,
  );
  return sig_ok ? { ok: true } : { ok: false, reason: 'signature_invalid' };
};

/** True iff the plan declares `audit_policy.high_assurance: true`
 *  AND the signature is missing OR fails verify against the supplied
 *  public key. Use at read time when the caller wants a single
 *  boolean for "this plan is suspicious". */
export const isRecuedPlanTampered = (
  plan: RecuedPlan,
  resolver: PlanPublicKeyResolver,
): boolean => {
  if (!plan.audit_policy.high_assurance) return false;
  return !verifyRecuedPlan(plan, resolver).ok;
};

// ────────────────────────────────────────────────────────────────
// RecuedPlanStore wrapper
// ────────────────────────────────────────────────────────────────

export interface SigningRecuedPlanStoreOptions {
  /** Identity provider — called on every signed write to fetch the
   *  current server_identity_key. Called per-write (not cached at
   *  construction) so post-rotation writes use the new key
   *  automatically. */
  getServerIdentity: () => Ed25519Keypair;
  /** Optional override of the "should this plan be signed" predicate.
   *  Default: `(plan) => plan.audit_policy.high_assurance`. Tests pass
   *  a narrower predicate to exercise non-canonical configurations. */
  shouldSign?: (plan: RecuedPlan) => boolean;
}

const defaultShouldSign = (plan: RecuedPlan): boolean =>
  plan.audit_policy.high_assurance;

/** Wrap an existing `RecuedPlanStore` so `append` calls auto-sign
 *  plans whose `audit_policy.high_assurance: true`. Redaction
 *  (`redact_user_request: true`) is applied BEFORE signing so the
 *  signature commits to the stored bytes — post-hoc redaction would
 *  invalidate the signature.
 *
 *  Read-time verification is caller-responsibility (matches the
 *  existing `createSigningAuditLog` pattern at `audit/signing.ts:188`).
 *  `get` / `list` pass through without auto-verifying — callers that
 *  need a trust signal call `verifyRecuedPlan` (or the
 *  `isRecuedPlanTampered` helper) per-row at read time. PB3 wires
 *  verification at the orchestrator's replay + Dry Run preview sites
 *  where the trust gate is load-bearing. (Codex P1 #2 from the PB2
 *  review — design choice surfaced as P3 documentation.) */
export const createSigningRecuedPlanStore = (
  underlying: RecuedPlanStore,
  options: SigningRecuedPlanStoreOptions,
): RecuedPlanStore => {
  const shouldSign = options.shouldSign ?? defaultShouldSign;
  return {
    async append(plan: RecuedPlan): Promise<void> {
      // signRecuedPlan handles the redact-before-sign discipline
      // internally per § B.5.5. The wrapper additionally applies
      // redaction to the non-signing path so plans persist redacted
      // even when high_assurance: false.
      const redacted =
        plan.audit_policy.redact_user_request
        && plan.user_request !== REDACTED_USER_REQUEST_MARKER
          ? redactUserRequest(plan)
          : plan;
      if (!shouldSign(redacted)) {
        return underlying.append(redacted);
      }
      const signed = signRecuedPlan(redacted, options.getServerIdentity());
      return underlying.append(signed);
    },
    get: (plan_id: string) => underlying.get(plan_id),
    list: (opts?: RecuedPlanListOptions) => underlying.list(opts),
    size: () => underlying.size(),
    delete: (plan_id: string) => underlying.delete(plan_id),
    clearOlderThan: (cutoff_ms: number) => underlying.clearOlderThan(cutoff_ms),
    clearAll: () => underlying.clearAll(),
  };
};
