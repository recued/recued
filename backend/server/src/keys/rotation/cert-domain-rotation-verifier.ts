/** D-148 § A.6.5 (multi-domain extension; FU3) — verifier for the
 *  per-domain `cert_domain_rotation_notice` + `cert_domain_rotation_reverted`
 *  events.
 *
 *  Mirror of `cert-rotation-verifier.ts` scoped per-domain. The
 *  signed payload includes `domain` so receivers can route the notice
 *  to the right `PinnedDomainCertState` row + reject notices whose
 *  domain doesn't match the row they're applied to. Per spec § A.6.5
 *  line 920: "PinnedCertState keys on (domain, current_fingerprint,
 *  next_fingerprint?); clients pin per-domain cert chains and accept
 *  rotation notices scoped per-domain."
 *
 *  The single-domain `cert-rotation-verifier.ts` substrate stays in
 *  place for the legacy cluster-pin flow; per-domain notices co-exist
 *  during W3.x while the multi-domain SNI substrate (W3.6 store +
 *  this FU3 rotation flow) lands.
 */

import { ed25519Verify } from '../index.js';
import type {
  CertDomainRotationNotice,
  CertDomainRotationRevertedEvent,
  PinnedDomainCertState,
} from '@recued/contracts';

/** Closed-list verification result. Mirrors the single-domain
 *  `CertRotationVerifyResult` shape with the same five rejection
 *  reasons. */
export type CertDomainRotationVerifyResult =
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

/** Resolver shape — either a literal pubkey string (single pinned
 *  identity) or a function (`signer_fingerprint` → pubkey) so the
 *  receiver can look up the right key in its rotation history when
 *  the server identity has rotated since pairing. Mirror of
 *  `cert-rotation-verifier.PublicKeyResolver`. */
export type PublicKeyResolver =
  | string
  | ((fingerprint: string) => string | null | undefined);

const verifyAgainstResolver = (
  resolver: PublicKeyResolver,
  signer_fingerprint: string,
  signature: string | undefined,
  signed_bytes: string,
): CertDomainRotationVerifyResult => {
  if (!signature || typeof signature !== 'string') {
    return { ok: false, reason: signature === '' ? 'signature_malformed' : 'signature_missing' };
  }
  let pub: string | null = null;
  if (typeof resolver === 'string') {
    pub = resolver;
  } else if (typeof resolver === 'function') {
    pub = resolver(signer_fingerprint) ?? null;
    if (!pub) return { ok: false, reason: 'signer_fingerprint_unknown' };
  }
  if (typeof pub !== 'string' || pub.length === 0) {
    return { ok: false, reason: 'public_key_malformed' };
  }
  const ok = ed25519Verify(pub, signed_bytes, signature);
  return ok ? { ok: true } : { ok: false, reason: 'signature_invalid' };
};

/** Canonical JSON of the unsigned `CertDomainRotationNotice` payload.
 *  Sender + verifier MUST produce the same byte sequence. The five
 *  primary fields participate in the signature (`type`, `domain`,
 *  `current_fingerprint`, `next_fingerprint`, `rotation_at`);
 *  `signature` + `signer_fingerprint` + `emitted_at` are not in the
 *  signed bytes. */
export const signedBytesForCertDomainRotationNotice = (
  notice: Pick<
    CertDomainRotationNotice,
    'domain' | 'current_fingerprint' | 'next_fingerprint' | 'rotation_at'
  >,
): string =>
  JSON.stringify({
    current_fingerprint: notice.current_fingerprint,
    domain: notice.domain,
    next_fingerprint: notice.next_fingerprint,
    rotation_at: notice.rotation_at,
    type: 'cert_domain_rotation_notice',
  });

/** Canonical JSON of the unsigned `CertDomainRotationRevertedEvent`
 *  payload. Four fields commit to the signature (`type`, `domain`,
 *  `reverted_to_fingerprint`, `reverted_at`, optional `reason`). */
export const signedBytesForCertDomainRotationReverted = (
  event: Pick<
    CertDomainRotationRevertedEvent,
    'domain' | 'reverted_to_fingerprint' | 'reverted_at' | 'reason'
  >,
): string =>
  JSON.stringify({
    domain: event.domain,
    reason: event.reason ?? null,
    reverted_at: event.reverted_at,
    reverted_to_fingerprint: event.reverted_to_fingerprint,
    type: 'cert_domain_rotation_reverted',
  });

/** Verify a `cert_domain_rotation_notice` event's signature against
 *  the receiver's pinned `server_public_key`. Forged notices fail +
 *  are ignored at the call site (caller treats `ok: false` as
 *  "discard"). */
export const verifyCertDomainRotationNotice = (
  notice: CertDomainRotationNotice,
  resolver: PublicKeyResolver,
): CertDomainRotationVerifyResult =>
  verifyAgainstResolver(
    resolver,
    notice.signer_fingerprint,
    notice.signature,
    signedBytesForCertDomainRotationNotice(notice),
  );

/** Verify a `cert_domain_rotation_reverted` event's signature. */
export const verifyCertDomainRotationRevertedEvent = (
  event: CertDomainRotationRevertedEvent,
  resolver: PublicKeyResolver,
): CertDomainRotationVerifyResult =>
  verifyAgainstResolver(
    resolver,
    event.signer_fingerprint,
    event.signature,
    signedBytesForCertDomainRotationReverted(event),
  );

/** Combined verification + per-domain pin-state transition result.
 *  Mirror of `CertRotationApplyResult` with the per-domain
 *  `domain_mismatch` reason — fires when the notice's `domain`
 *  doesn't match the pinned row's `domain` (caller routed the notice
 *  to the wrong row). */
export type CertDomainRotationApplyResult =
  | { ok: true; nextPinned: PinnedDomainCertState }
  | {
      ok: false;
      reason:
        | 'signature_missing'
        | 'signature_malformed'
        | 'signature_invalid'
        | 'public_key_malformed'
        | 'signer_fingerprint_unknown'
        | 'domain_mismatch'
        | 'current_fingerprint_mismatch'
        | 'rotation_at_in_past'
        | 'pin_unknown_revert_target';
    };

/** Apply a signed `cert_domain_rotation_notice` to a pinned-domain
 *  cert state. Combines signature verification with pin-state
 *  transition rules per spec § A.6.5:
 *
 *   - Signature MUST verify against the receiver's pinned identity
 *     (or rotation-aware resolver).
 *   - `notice.domain` MUST match `pinned.domain` — defends against
 *     a misrouted notice landing in the wrong row.
 *   - `notice.current_fingerprint` MUST match `pinned.current_fingerprint`
 *     (otherwise the notice is for a different rotation lineage on
 *     the same domain).
 *   - `notice.rotation_at` MUST be in the future relative to `now`
 *     (otherwise the activation has already happened + the notice is
 *     stale).
 *
 *  Returns the next pinned state on success — caller persists. The
 *  `last_rotated_at` slot is preserved from the prior row so the UI
 *  can render rotation history continuously across notices. */
export const applyCertDomainRotationNotice = (args: {
  notice: CertDomainRotationNotice;
  pinned: PinnedDomainCertState;
  resolver: PublicKeyResolver;
  now: number;
}): CertDomainRotationApplyResult => {
  const verify = verifyCertDomainRotationNotice(args.notice, args.resolver);
  if (!verify.ok) return { ok: false, reason: verify.reason };
  if (args.notice.domain !== args.pinned.domain) {
    return { ok: false, reason: 'domain_mismatch' };
  }
  if (args.notice.current_fingerprint !== args.pinned.current_fingerprint) {
    return { ok: false, reason: 'current_fingerprint_mismatch' };
  }
  if (args.notice.rotation_at <= args.now) {
    return { ok: false, reason: 'rotation_at_in_past' };
  }
  return {
    ok: true,
    nextPinned: {
      domain: args.pinned.domain,
      current_fingerprint: args.pinned.current_fingerprint,
      next_fingerprint: args.notice.next_fingerprint,
      current_valid_until: args.notice.rotation_at,
      rotation_signed_notice: args.notice.signature,
      ...(args.pinned.last_rotated_at !== undefined
        ? { last_rotated_at: args.pinned.last_rotated_at }
        : {}),
    },
  };
};

/** Apply a signed `cert_domain_rotation_reverted` event to a
 *  pinned-domain cert state. Combines signature verification with
 *  pin-state rules:
 *
 *   - Signature MUST verify.
 *   - `event.domain` MUST match `pinned.domain`.
 *   - `event.reverted_to_fingerprint` MUST match either the pinned
 *     `current_fingerprint` (no-op revert during overlap) OR the
 *     pinned `next_fingerprint` (revert AFTER the receiver already
 *     flipped to next, back to the pre-rotation pin). Mirrors the
 *     single-domain `applyCertRotationRevertedEvent` discipline.
 *
 *  On success: collapses the two-pin overlap back to single-pin on
 *  `reverted_to_fingerprint`. The receiver no longer accepts the
 *  abandoned rotation target. */
export const applyCertDomainRotationRevertedEvent = (args: {
  event: CertDomainRotationRevertedEvent;
  pinned: PinnedDomainCertState;
  resolver: PublicKeyResolver;
}): CertDomainRotationApplyResult => {
  const verify = verifyCertDomainRotationRevertedEvent(args.event, args.resolver);
  if (!verify.ok) return { ok: false, reason: verify.reason };
  if (args.event.domain !== args.pinned.domain) {
    return { ok: false, reason: 'domain_mismatch' };
  }
  const matchesCurrent =
    args.event.reverted_to_fingerprint === args.pinned.current_fingerprint;
  const matchesNext =
    args.pinned.next_fingerprint !== undefined &&
    args.event.reverted_to_fingerprint === args.pinned.next_fingerprint;
  if (!matchesCurrent && !matchesNext) {
    return { ok: false, reason: 'pin_unknown_revert_target' };
  }
  return {
    ok: true,
    nextPinned: {
      domain: args.pinned.domain,
      current_fingerprint: args.event.reverted_to_fingerprint,
      current_valid_until: args.event.reverted_at,
      ...(args.pinned.last_rotated_at !== undefined
        ? { last_rotated_at: args.pinned.last_rotated_at }
        : {}),
    },
  };
};
