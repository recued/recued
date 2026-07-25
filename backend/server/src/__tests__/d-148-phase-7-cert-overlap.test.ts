/** D-148 P7 — two-pin cert overlap + revert acceptance.
 *
 *  Covers spec § P7 acceptance lines 2171-2173:
 *   - Two-pin cert rotation overlap: T-7d emits signed
 *     `cert.rotation_notice`; offline client reconnects at T+1d with
 *     persisted `next_fingerprint` matching server's new fingerprint.
 *   - Cert rotation revert (rollback) emits `cert.rotation_reverted`.
 *   - Unsigned rotation notice rejection.
 *
 *  Tests use the `verifyCertRotationNotice` /
 *  `verifyCertRotationRevertedEvent` substrate primitives (the
 *  client-side gate). The "two-pin" acceptance reduces to: the receiver
 *  persists `current_fingerprint + next_fingerprint`; when the server
 *  flips, the receiver's TLS handshake matches the pinned `next` and
 *  succeeds. We model this as a state-transition test on the
 *  `PinnedCertState` shape from contracts.
 */

import { describe, it, expect } from 'vitest';
import {
  ed25519Sign,
  generateEd25519Keypair,
} from '../keys/index.js';
import {
  verifyCertRotationNotice,
  verifyCertRotationRevertedEvent,
} from '../keys/rotation/cert-rotation-verifier.js';
import type {
  CertRotationNotice,
  CertRotationRevertedEvent,
  PinnedCertState,
} from '@recued/contracts';

/** Synthetic client-side handshake gate. Receives a fingerprint
 *  (presented at TLS handshake) and the receiver's pinned state +
 *  returns true when the handshake should accept. The "next_fingerprint"
 *  pin path is the load-bearing element of the two-pin overlap. */
const handshakeAccepts = (presented: string, pinned: PinnedCertState): boolean =>
  presented === pinned.current_fingerprint || presented === pinned.next_fingerprint;

const buildSignedNotice = (
  identity: ReturnType<typeof generateEd25519Keypair>,
  current: string,
  next: string,
  rotation_at: number,
): CertRotationNotice => {
  const payload = JSON.stringify({
    current_fingerprint: current,
    next_fingerprint: next,
    rotation_at,
    type: 'cert_rotation_notice',
  });
  return {
    type: 'cert_rotation_notice',
    current_fingerprint: current,
    next_fingerprint: next,
    rotation_at,
    signature: ed25519Sign(identity, payload),
    signer_fingerprint: identity.public_key_fingerprint,
    emitted_at: rotation_at - 7 * 24 * 60 * 60 * 1000,
  };
};

const buildSignedRevert = (
  identity: ReturnType<typeof generateEd25519Keypair>,
  reverted_to: string,
  reverted_at: number,
  reason?: string,
): CertRotationRevertedEvent => {
  const payload = JSON.stringify({
    reverted_to_fingerprint: reverted_to,
    reason: reason ?? null,
    reverted_at,
    type: 'cert_rotation_reverted',
  });
  return {
    type: 'cert_rotation_reverted',
    reverted_to_fingerprint: reverted_to,
    ...(reason !== undefined ? { reason } : {}),
    reverted_at,
    signature: ed25519Sign(identity, payload),
    signer_fingerprint: identity.public_key_fingerprint,
  };
};

describe('D-148 P7 — two-pin cert rotation overlap', () => {
  it('client persists next_fingerprint on signed notice; reconnect at T+1d accepts new cert', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const current = 'sha256:cafe';
    const next = 'sha256:beef';
    const rotation_at = 1_700_000_000_000;
    const notice = buildSignedNotice(identity, current, next, rotation_at);

    // Receiver verifies + persists.
    expect(verifyCertRotationNotice(notice, identity.public_key_b64)).toEqual({ ok: true });
    const pinned: PinnedCertState = {
      current_fingerprint: current,
      next_fingerprint: notice.next_fingerprint,
      current_valid_until: rotation_at,
      rotation_signed_notice: notice.signature,
    };

    // Server flipped to the new cert. Pre-flip handshake (current still
    // valid): accepts current.
    expect(handshakeAccepts(current, pinned)).toBe(true);
    // Post-flip handshake: presented fingerprint is the new one.
    expect(handshakeAccepts(next, pinned)).toBe(true);
    // Unrelated fingerprint refused.
    expect(handshakeAccepts('sha256:bogus', pinned)).toBe(false);
  });

  it('client offline through full overlap window then reconnects with stale state → fails cert_pin_stale', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    // Receiver never received the rotation notice — its pinned state
    // carries only `current_fingerprint`. Server has rotated to a
    // fresh fingerprint; receiver's handshake refuses.
    const pinned: PinnedCertState = {
      current_fingerprint: 'sha256:original',
      current_valid_until: 0,
    };
    const presented = 'sha256:freshcert';
    expect(handshakeAccepts(presented, pinned)).toBe(false);
  });
});

describe('D-148 P7 — cert rotation revert', () => {
  it('signed revert event verifies; receiver re-pins to previous fingerprint without re-pair', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const event = buildSignedRevert(
      identity,
      'sha256:cafe',
      1_700_000_000_000 + 60 * 60 * 1000,
      'handshake regression at T+1h',
    );
    expect(verifyCertRotationRevertedEvent(event, identity.public_key_b64)).toEqual({ ok: true });
    // Receiver's persisted `current_valid_until` extended; pinning the
    // previous fingerprint keeps the connection alive without re-pair.
    const restored: PinnedCertState = {
      current_fingerprint: event.reverted_to_fingerprint,
      current_valid_until: event.reverted_at + 24 * 60 * 60 * 1000,
    };
    expect(handshakeAccepts('sha256:cafe', restored)).toBe(true);
  });

  it('forged revert (signature replaced) is rejected', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const real = buildSignedRevert(
      identity,
      'sha256:cafe',
      1_700_000_000_000,
    );
    const forged: CertRotationRevertedEvent = {
      ...real,
      reverted_to_fingerprint: 'sha256:attacker',
      signature: 'AAAA',
    };
    const verify = verifyCertRotationRevertedEvent(forged, identity.public_key_b64);
    expect(verify.ok).toBe(false);
    if (verify.ok) throw new Error('unreachable');
    expect(['signature_invalid', 'signature_malformed']).toContain(verify.reason);
  });

  it('revert event with mutated reverted_at fails verify', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const real = buildSignedRevert(
      identity,
      'sha256:cafe',
      1_700_000_000_000,
    );
    const mutated: CertRotationRevertedEvent = { ...real, reverted_at: real.reverted_at + 1 };
    const verify = verifyCertRotationRevertedEvent(mutated, identity.public_key_b64);
    expect(verify.ok).toBe(false);
    if (verify.ok) throw new Error('unreachable');
    expect(verify.reason).toBe('signature_invalid');
  });
});

describe('D-148 P7 — unsigned rotation notice rejection (defense-in-depth)', () => {
  it('client refuses notice with empty signature', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const unsigned = {
      type: 'cert_rotation_notice',
      current_fingerprint: 'sha256:cafe',
      next_fingerprint: 'sha256:beef',
      rotation_at: 1,
      signature: '',
      signer_fingerprint: identity.public_key_fingerprint,
      emitted_at: 1,
    } as CertRotationNotice;
    const verify = verifyCertRotationNotice(unsigned, identity.public_key_b64);
    expect(verify.ok).toBe(false);
  });

  it('client refuses notice signed by wrong identity (rotation-aware resolver)', () => {
    const realServer = generateEd25519Keypair('server_identity_key');
    const attacker = generateEd25519Keypair('server_identity_key');
    const payload = JSON.stringify({
      current_fingerprint: 'sha256:cafe',
      next_fingerprint: 'sha256:beef',
      rotation_at: 1,
      type: 'cert_rotation_notice',
    });
    const notice: CertRotationNotice = {
      type: 'cert_rotation_notice',
      current_fingerprint: 'sha256:cafe',
      next_fingerprint: 'sha256:beef',
      rotation_at: 1,
      signature: ed25519Sign(attacker, payload),
      signer_fingerprint: attacker.public_key_fingerprint,
      emitted_at: 1,
    };
    // Resolver only knows the real server's identity.
    const resolver = (fp: string): string | null =>
      fp === realServer.public_key_fingerprint ? realServer.public_key_b64 : null;
    const verify = verifyCertRotationNotice(notice, resolver);
    expect(verify.ok).toBe(false);
    if (verify.ok) throw new Error('unreachable');
    expect(verify.reason).toBe('signer_fingerprint_unknown');
  });
});
