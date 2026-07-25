/** D-148 § A.6.5 / § P7 — verifier for `cert_rotation_notice` events.
 *
 *  Webclients + bridges receive `cert_rotation_notice` broadcasts on
 *  TLS rotation. The notice carries a signed payload identifying the
 *  outgoing + incoming fingerprint pair. The receiver MUST verify
 *  the signature against its pinned `server_public_key` (or against
 *  a key-history resolver when the server identity has rotated since
 *  pairing). Forged notices fail verification + are ignored.
 *
 *  Two-pin overlap: the receiver persists `next_fingerprint` in its
 *  pinned-cert state. When the server flips to the new cert, the
 *  receiver's TLS handshake matches against the pinned `next` rather
 *  than refusing the connection.
 *
 *  Revert path: server may emit `cert_rotation_reverted` if a rotation
 *  fails post-bind. Receivers accept the previous fingerprint without
 *  re-pair.
 */

import { ed25519Verify } from '../index.js';
import type { CertRotationNotice, CertRotationRevertedEvent } from '@recued/contracts';

/** Closed-list verification result. Mirrors the audit-row verifier. */
export type CertRotationVerifyResult =
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

export type PublicKeyResolver =
  | string
  | ((fingerprint: string) => string | null | undefined);

const verifyAgainstResolver = (
  resolver: PublicKeyResolver,
  signer_fingerprint: string,
  signature: string | undefined,
  signed_bytes: string,
): CertRotationVerifyResult => {
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

/** Canonical literal-order JSON of the unsigned `CertRotationNotice`
 *  payload. Sender + verifier MUST produce the same byte sequence —
 *  the rotation engine signs this, the broadcast bus carries the
 *  signature, the receiver verifies against the same bytes. Four
 *  primary fields participate in the signature (`type`,
 *  `current_fingerprint`, `next_fingerprint`, `rotation_at`); the
 *  signature + signer_fingerprint + emitted_at are NOT in the signed
 *  bytes (signer_fingerprint travels in cleartext for the receiver's
 *  resolver, emitted_at is informational).
 *
 *  Field order intentionally matches the historical `JSON.stringify`
 *  call in `RotationEngine.renewTls` (alphabetical-by-key with `type`
 *  last) — D-148 § A.6.5 webclient consumer cert-pin handler relies
 *  on byte-for-byte equality with this transcript. */
export const signedBytesForCertRotationNotice = (
  notice: Pick<
    CertRotationNotice,
    'current_fingerprint' | 'next_fingerprint' | 'rotation_at'
  >,
): string =>
  JSON.stringify({
    current_fingerprint: notice.current_fingerprint,
    next_fingerprint: notice.next_fingerprint,
    rotation_at: notice.rotation_at,
    type: 'cert_rotation_notice',
  });

/** Canonical literal-order JSON of the unsigned
 *  `CertRotationRevertedEvent` payload. Four fields commit to the
 *  signature (`type`, `reverted_to_fingerprint`, `reason` — coerced
 *  to null when absent for stable transcript, `reverted_at`). */
export const signedBytesForCertRotationReverted = (
  event: Pick<CertRotationRevertedEvent, 'reverted_to_fingerprint' | 'reverted_at' | 'reason'>,
): string =>
  JSON.stringify({
    reverted_to_fingerprint: event.reverted_to_fingerprint,
    reason: event.reason ?? null,
    reverted_at: event.reverted_at,
    type: 'cert_rotation_reverted',
  });

/** Verify a `cert_rotation_notice` event. The signed payload covers
 *  the four primary fields (`type`, `current_fingerprint`,
 *  `next_fingerprint`, `rotation_at`); the signature + signer
 *  fingerprint + emitted_at are not in the signed bytes. */
export const verifyCertRotationNotice = (
  notice: CertRotationNotice,
  resolver: PublicKeyResolver,
): CertRotationVerifyResult =>
  verifyAgainstResolver(
    resolver,
    notice.signer_fingerprint,
    notice.signature,
    signedBytesForCertRotationNotice(notice),
  );

/** Verify a `cert_rotation_reverted` event. The signed payload covers
 *  the rolled-back fingerprint + reason + reverted_at. */
export const verifyCertRotationRevertedEvent = (
  event: CertRotationRevertedEvent,
  resolver: PublicKeyResolver,
): CertRotationVerifyResult =>
  verifyAgainstResolver(
    resolver,
    event.signer_fingerprint,
    event.signature,
    signedBytesForCertRotationReverted(event),
  );

// ────────────────────────────────────────────────────────────────
// Codex P2 #8 fold — state-aware notice/revert application
// ────────────────────────────────────────────────────────────────

/** Per-application closed list of rejection reasons that combine
 *  signature failure + pin-state transition rules. The substrate
 *  prefers ONE entry-point so callers don't have to chain
 *  `verifyCertRotationNotice` with their own `currentFingerprint`
 *  match check + monotonic-time check + overlap-validity check. */
export type CertRotationApplyResult =
  | { ok: true; nextPinned: import('@recued/contracts').PinnedCertState }
  | {
      ok: false;
      reason:
        | 'signature_missing'
        | 'signature_malformed'
        | 'signature_invalid'
        | 'public_key_malformed'
        | 'signer_fingerprint_unknown'
        | 'current_fingerprint_mismatch'
        | 'rotation_at_in_past'
        | 'overlap_window_expired'
        | 'pin_unknown_revert_target';
    };

/** Apply a signed `cert_rotation_notice` to a pinned-cert state.
 *  Combines signature verification with pin-state transition rules
 *  per spec § A.6.5:
 *
 *   - Signature MUST verify against the receiver's pinned identity
 *     (or rotation-aware resolver).
 *   - `current_fingerprint` in the notice MUST match the pinned
 *     `current_fingerprint` (otherwise the notice is for a different
 *     rotation lineage).
 *   - `rotation_at` MUST be in the future relative to `now`
 *     (otherwise the activation has already happened + the notice
 *     is stale).
 *
 *  Returns the next pinned state on success — caller persists. */
export const applyCertRotationNotice = (args: {
  notice: import('@recued/contracts').CertRotationNotice;
  pinned: import('@recued/contracts').PinnedCertState;
  resolver: PublicKeyResolver;
  now: number;
}): CertRotationApplyResult => {
  const verify = verifyCertRotationNotice(args.notice, args.resolver);
  if (!verify.ok) return { ok: false, reason: verify.reason };
  if (args.notice.current_fingerprint !== args.pinned.current_fingerprint) {
    return { ok: false, reason: 'current_fingerprint_mismatch' };
  }
  if (args.notice.rotation_at <= args.now) {
    return { ok: false, reason: 'rotation_at_in_past' };
  }
  return {
    ok: true,
    nextPinned: {
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

/** Apply a signed `cert_rotation_reverted` event to a pinned-cert
 *  state. Combines signature verification with pin-state rules:
 *
 *   - Signature MUST verify.
 *   - `reverted_to_fingerprint` MUST match either the pinned
 *     `current_fingerprint` (no-op revert) OR — relevant when the
 *     revert lands AFTER an activation flip — a previous fingerprint
 *     the receiver still trusts (carried in `pinned.next_fingerprint`
 *     during overlap, or as a known-recent-pin in caller-supplied
 *     state). The substrate accepts either current or next; receivers
 *     that have flipped to `next` and now need to revert to the
 *     previous-`current` should pin both pre-flip + post-flip pin
 *     state; this substrate stays simple by accepting both).
 *
 *  Returns the next pinned state — typically reverts `current` to the
 *  reverted_to fingerprint + clears `next_fingerprint`. */
export const applyCertRotationRevertedEvent = (args: {
  event: import('@recued/contracts').CertRotationRevertedEvent;
  pinned: import('@recued/contracts').PinnedCertState;
  resolver: PublicKeyResolver;
}): CertRotationApplyResult => {
  const verify = verifyCertRotationRevertedEvent(args.event, args.resolver);
  if (!verify.ok) return { ok: false, reason: verify.reason };
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
      current_fingerprint: args.event.reverted_to_fingerprint,
      // Revert clears any staged next_fingerprint so the receiver
      // doesn't accept the abandoned rotation target.
      current_valid_until: args.event.reverted_at,
      ...(args.pinned.last_rotated_at !== undefined
        ? { last_rotated_at: args.pinned.last_rotated_at }
        : {}),
    },
  };
};
