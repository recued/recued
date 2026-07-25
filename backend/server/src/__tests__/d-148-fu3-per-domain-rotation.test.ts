/** D-148 FU3 — per-domain two-pin rotation flow.
 *
 *  Covers spec § A.6.5 line 920 + § A.6.3:
 *    - Per-domain rotation notices key on `(domain, current_fingerprint,
 *      next_fingerprint?)` so multi-domain SNI deployments rotate each
 *      cert independently.
 *    - Pinned receivers route notices to the right `PinnedDomainCert-
 *      State` row via the `domain` field in the signed payload.
 *    - Pro-managed (`pro_acme`) domains auto-rotate via ACME; BYO-
 *      uploaded (`byo_upload`) domains rotate at user-driven re-upload
 *      time. The substrate stays agnostic — caller supplies the
 *      previous + next fingerprints.
 *    - Co-exists with single-domain `PinnedCertState` during W3.x;
 *      verifier + engine are parallel paths.
 *
 *  Substrate-only; no rpc seam, no bin.ts composition. Substrate-then-
 *  wiring pattern per [[project_handover_2026_05_12_d148_fu2_landed]]
 *  + FU5.
 */

import { describe, it, expect } from 'vitest';
import {
  ed25519Sign,
  generateEd25519Keypair,
} from '../keys/index.js';
import {
  applyCertDomainRotationNotice,
  applyCertDomainRotationRevertedEvent,
  createPerDomainRotationEngine,
  DEFAULT_DOMAIN_ROTATION_NOTICE_LEAD_MS,
  signedBytesForCertDomainRotationNotice,
  signedBytesForCertDomainRotationReverted,
  verifyCertDomainRotationNotice,
  verifyCertDomainRotationRevertedEvent,
} from '../keys/rotation/index.js';
import type {
  CertDomainRotationNotice,
  CertDomainRotationRevertedEvent,
  PinnedDomainCertState,
} from '@recued/contracts';

const ONE_DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/** Build a signed per-domain rotation notice using the same canonical
 *  JSON the verifier expects. Mirrors the single-domain
 *  `buildSignedNotice` helper from d-148-phase-7-cert-overlap. */
const buildSignedDomainNotice = (
  identity: ReturnType<typeof generateEd25519Keypair>,
  domain: string,
  current: string,
  next: string,
  rotation_at: number,
): CertDomainRotationNotice => ({
  type: 'cert_domain_rotation_notice',
  domain,
  current_fingerprint: current,
  next_fingerprint: next,
  rotation_at,
  signature: ed25519Sign(
    identity,
    signedBytesForCertDomainRotationNotice({
      domain,
      current_fingerprint: current,
      next_fingerprint: next,
      rotation_at,
    }),
  ),
  signer_fingerprint: identity.public_key_fingerprint,
  emitted_at: rotation_at - 7 * ONE_DAY,
});

const buildSignedDomainRevert = (
  identity: ReturnType<typeof generateEd25519Keypair>,
  domain: string,
  reverted_to: string,
  reverted_at: number,
  reason?: string,
): CertDomainRotationRevertedEvent => {
  const sig = ed25519Sign(
    identity,
    signedBytesForCertDomainRotationReverted({
      domain,
      reverted_to_fingerprint: reverted_to,
      reverted_at,
      ...(reason !== undefined ? { reason } : {}),
    }),
  );
  return {
    type: 'cert_domain_rotation_reverted',
    domain,
    reverted_to_fingerprint: reverted_to,
    ...(reason !== undefined ? { reason } : {}),
    reverted_at,
    signature: sig,
    signer_fingerprint: identity.public_key_fingerprint,
  };
};

// ────────────────────────────────────────────────────────────────
// Verifier: signature paths
// ────────────────────────────────────────────────────────────────

describe('D-148 FU3 — per-domain rotation notice verifier', () => {
  it('valid signature verifies against the signer pubkey', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const notice = buildSignedDomainNotice(
      identity,
      'alice.recued.cloud',
      'sha256:aaaa',
      'sha256:bbbb',
      NOW + 7 * ONE_DAY,
    );
    expect(verifyCertDomainRotationNotice(notice, identity.public_key_b64)).toEqual({
      ok: true,
    });
  });

  it('tampered domain field fails signature verification', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const notice = buildSignedDomainNotice(
      identity,
      'alice.recued.cloud',
      'sha256:aaaa',
      'sha256:bbbb',
      NOW + 7 * ONE_DAY,
    );
    // Pretend an attacker rewrote the domain to point at a different
    // hostname — signature was computed over the original domain.
    notice.domain = 'evil.recued.cloud';
    const verify = verifyCertDomainRotationNotice(notice, identity.public_key_b64);
    expect(verify.ok).toBe(false);
    if (!verify.ok) {
      expect(verify.reason).toBe('signature_invalid');
    }
  });

  it('tampered next_fingerprint fails signature verification', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const notice = buildSignedDomainNotice(
      identity,
      'alice.recued.cloud',
      'sha256:aaaa',
      'sha256:bbbb',
      NOW + 7 * ONE_DAY,
    );
    notice.next_fingerprint = 'sha256:malicious';
    const verify = verifyCertDomainRotationNotice(notice, identity.public_key_b64);
    expect(verify.ok).toBe(false);
    if (!verify.ok) expect(verify.reason).toBe('signature_invalid');
  });

  it('missing signature fails with signature_missing', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const notice = buildSignedDomainNotice(
      identity,
      'alice.recued.cloud',
      'sha256:aaaa',
      'sha256:bbbb',
      NOW + 7 * ONE_DAY,
    );
    (notice as { signature?: string }).signature = undefined;
    const verify = verifyCertDomainRotationNotice(notice, identity.public_key_b64);
    expect(verify.ok).toBe(false);
    if (!verify.ok) expect(verify.reason).toBe('signature_missing');
  });

  it('empty-string signature fails with signature_malformed', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const notice = buildSignedDomainNotice(
      identity,
      'alice.recued.cloud',
      'sha256:aaaa',
      'sha256:bbbb',
      NOW + 7 * ONE_DAY,
    );
    notice.signature = '';
    const verify = verifyCertDomainRotationNotice(notice, identity.public_key_b64);
    expect(verify.ok).toBe(false);
    if (!verify.ok) expect(verify.reason).toBe('signature_malformed');
  });

  it('signer_fingerprint resolver returning null fails with signer_fingerprint_unknown', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const notice = buildSignedDomainNotice(
      identity,
      'alice.recued.cloud',
      'sha256:aaaa',
      'sha256:bbbb',
      NOW + 7 * ONE_DAY,
    );
    const verify = verifyCertDomainRotationNotice(notice, () => null);
    expect(verify.ok).toBe(false);
    if (!verify.ok) expect(verify.reason).toBe('signer_fingerprint_unknown');
  });

  it('verifier rejects a single-domain notice repackaged as per-domain (type field mismatch)', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    // Build a notice signed for the SINGLE-domain envelope (type =
    // 'cert_rotation_notice') and try to verify it as a per-domain
    // notice. The signed bytes are different — should fail.
    const single = JSON.stringify({
      current_fingerprint: 'sha256:aaaa',
      next_fingerprint: 'sha256:bbbb',
      rotation_at: NOW + 7 * ONE_DAY,
      type: 'cert_rotation_notice',
    });
    const sig = ed25519Sign(identity, single);
    const masquerade: CertDomainRotationNotice = {
      type: 'cert_domain_rotation_notice',
      domain: 'alice.recued.cloud',
      current_fingerprint: 'sha256:aaaa',
      next_fingerprint: 'sha256:bbbb',
      rotation_at: NOW + 7 * ONE_DAY,
      signature: sig,
      signer_fingerprint: identity.public_key_fingerprint,
      emitted_at: NOW,
    };
    const verify = verifyCertDomainRotationNotice(masquerade, identity.public_key_b64);
    expect(verify.ok).toBe(false);
    if (!verify.ok) expect(verify.reason).toBe('signature_invalid');
  });
});

describe('D-148 FU3 — per-domain rotation revert verifier', () => {
  it('valid signature verifies', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const event = buildSignedDomainRevert(
      identity,
      'alice.recued.cloud',
      'sha256:aaaa',
      NOW + ONE_DAY,
      'chain-misconfig',
    );
    expect(verifyCertDomainRotationRevertedEvent(event, identity.public_key_b64)).toEqual({
      ok: true,
    });
  });

  it('tampered domain field fails signature verification', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const event = buildSignedDomainRevert(
      identity,
      'alice.recued.cloud',
      'sha256:aaaa',
      NOW + ONE_DAY,
    );
    event.domain = 'evil.recued.cloud';
    const verify = verifyCertDomainRotationRevertedEvent(event, identity.public_key_b64);
    expect(verify.ok).toBe(false);
    if (!verify.ok) expect(verify.reason).toBe('signature_invalid');
  });

  it('omitted reason canonicalises to null in signed bytes', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const event = buildSignedDomainRevert(
      identity,
      'alice.recued.cloud',
      'sha256:aaaa',
      NOW + ONE_DAY,
    );
    expect(event.reason).toBeUndefined();
    expect(verifyCertDomainRotationRevertedEvent(event, identity.public_key_b64)).toEqual({
      ok: true,
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Applier: pin-state transition rules
// ────────────────────────────────────────────────────────────────

describe('D-148 FU3 — applyCertDomainRotationNotice', () => {
  const identity = generateEd25519Keypair('server_identity_key');
  const domain = 'alice.recued.cloud';

  it('happy path stages next_fingerprint onto the pinned row', () => {
    const notice = buildSignedDomainNotice(
      identity,
      domain,
      'sha256:current',
      'sha256:next',
      NOW + 7 * ONE_DAY,
    );
    const pinned: PinnedDomainCertState = {
      domain,
      current_fingerprint: 'sha256:current',
      current_valid_until: NOW + ONE_DAY,
      last_rotated_at: NOW - 30 * ONE_DAY,
    };
    const result = applyCertDomainRotationNotice({
      notice,
      pinned,
      resolver: identity.public_key_b64,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextPinned.domain).toBe(domain);
    expect(result.nextPinned.current_fingerprint).toBe('sha256:current');
    expect(result.nextPinned.next_fingerprint).toBe('sha256:next');
    expect(result.nextPinned.current_valid_until).toBe(NOW + 7 * ONE_DAY);
    expect(result.nextPinned.rotation_signed_notice).toBe(notice.signature);
    // last_rotated_at is preserved so the UI can show "rotated 30d ago"
    // even after the rotation notice persists a new next.
    expect(result.nextPinned.last_rotated_at).toBe(NOW - 30 * ONE_DAY);
  });

  it('rejects notice for a different domain (domain_mismatch)', () => {
    const notice = buildSignedDomainNotice(
      identity,
      'bob.recued.cloud',
      'sha256:current',
      'sha256:next',
      NOW + 7 * ONE_DAY,
    );
    const pinned: PinnedDomainCertState = {
      domain: 'alice.recued.cloud',
      current_fingerprint: 'sha256:current',
      current_valid_until: NOW + ONE_DAY,
    };
    const result = applyCertDomainRotationNotice({
      notice,
      pinned,
      resolver: identity.public_key_b64,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('domain_mismatch');
  });

  it('rejects notice with mismatched current_fingerprint (current_fingerprint_mismatch)', () => {
    const notice = buildSignedDomainNotice(
      identity,
      domain,
      'sha256:wrong-current',
      'sha256:next',
      NOW + 7 * ONE_DAY,
    );
    const pinned: PinnedDomainCertState = {
      domain,
      current_fingerprint: 'sha256:actual-current',
      current_valid_until: NOW + ONE_DAY,
    };
    const result = applyCertDomainRotationNotice({
      notice,
      pinned,
      resolver: identity.public_key_b64,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('current_fingerprint_mismatch');
  });

  it('rejects notice with rotation_at in the past (rotation_at_in_past)', () => {
    const notice = buildSignedDomainNotice(
      identity,
      domain,
      'sha256:current',
      'sha256:next',
      NOW - ONE_DAY,
    );
    const pinned: PinnedDomainCertState = {
      domain,
      current_fingerprint: 'sha256:current',
      current_valid_until: NOW + ONE_DAY,
    };
    const result = applyCertDomainRotationNotice({
      notice,
      pinned,
      resolver: identity.public_key_b64,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('rotation_at_in_past');
  });

  it('rejects notice with rotation_at exactly equal to now (boundary; rotation_at_in_past)', () => {
    const notice = buildSignedDomainNotice(
      identity,
      domain,
      'sha256:current',
      'sha256:next',
      NOW,
    );
    const pinned: PinnedDomainCertState = {
      domain,
      current_fingerprint: 'sha256:current',
      current_valid_until: NOW + ONE_DAY,
    };
    const result = applyCertDomainRotationNotice({
      notice,
      pinned,
      resolver: identity.public_key_b64,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('rotation_at_in_past');
  });

  it('preserves omitted last_rotated_at on successful apply', () => {
    const notice = buildSignedDomainNotice(
      identity,
      domain,
      'sha256:current',
      'sha256:next',
      NOW + 7 * ONE_DAY,
    );
    const pinned: PinnedDomainCertState = {
      domain,
      current_fingerprint: 'sha256:current',
      current_valid_until: NOW + ONE_DAY,
    };
    const result = applyCertDomainRotationNotice({
      notice,
      pinned,
      resolver: identity.public_key_b64,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextPinned.last_rotated_at).toBeUndefined();
  });

  it('signature failure short-circuits before pin-state checks', () => {
    const notice = buildSignedDomainNotice(
      identity,
      'bob.recued.cloud', // wrong domain so the row check would also fail
      'sha256:wrong-current',
      'sha256:next',
      NOW - ONE_DAY,
    );
    notice.signature = ''; // malformed; would surface signature_malformed BEFORE domain_mismatch
    const pinned: PinnedDomainCertState = {
      domain,
      current_fingerprint: 'sha256:current',
      current_valid_until: NOW + ONE_DAY,
    };
    const result = applyCertDomainRotationNotice({
      notice,
      pinned,
      resolver: identity.public_key_b64,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature_malformed');
  });
});

describe('D-148 FU3 — applyCertDomainRotationRevertedEvent', () => {
  const identity = generateEd25519Keypair('server_identity_key');
  const domain = 'alice.recued.cloud';

  it('revert to current_fingerprint (no-op during overlap) clears next', () => {
    const event = buildSignedDomainRevert(identity, domain, 'sha256:current', NOW + ONE_DAY);
    const pinned: PinnedDomainCertState = {
      domain,
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: NOW + 7 * ONE_DAY,
      rotation_signed_notice: 'prior-sig',
    };
    const result = applyCertDomainRotationRevertedEvent({
      event,
      pinned,
      resolver: identity.public_key_b64,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextPinned.current_fingerprint).toBe('sha256:current');
    expect(result.nextPinned.next_fingerprint).toBeUndefined();
    expect(result.nextPinned.rotation_signed_notice).toBeUndefined();
  });

  it('revert to next_fingerprint (post-flip) reverses the overlap', () => {
    // Receiver already flipped its pinned current → next; the revert
    // names the original next (now its current). The substrate accepts
    // because the pinned row's previous next matches the reverted-to
    // fingerprint.
    const event = buildSignedDomainRevert(identity, domain, 'sha256:also-trusted', NOW + ONE_DAY);
    const pinned: PinnedDomainCertState = {
      domain,
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:also-trusted',
      current_valid_until: NOW + 7 * ONE_DAY,
    };
    const result = applyCertDomainRotationRevertedEvent({
      event,
      pinned,
      resolver: identity.public_key_b64,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextPinned.current_fingerprint).toBe('sha256:also-trusted');
    expect(result.nextPinned.next_fingerprint).toBeUndefined();
  });

  it('revert to unknown fingerprint fails with pin_unknown_revert_target', () => {
    const event = buildSignedDomainRevert(identity, domain, 'sha256:never-seen', NOW + ONE_DAY);
    const pinned: PinnedDomainCertState = {
      domain,
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: NOW + 7 * ONE_DAY,
    };
    const result = applyCertDomainRotationRevertedEvent({
      event,
      pinned,
      resolver: identity.public_key_b64,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pin_unknown_revert_target');
  });

  it('revert event for a different domain fails with domain_mismatch', () => {
    const event = buildSignedDomainRevert(
      identity,
      'bob.recued.cloud',
      'sha256:current',
      NOW + ONE_DAY,
    );
    const pinned: PinnedDomainCertState = {
      domain,
      current_fingerprint: 'sha256:current',
      current_valid_until: NOW + ONE_DAY,
    };
    const result = applyCertDomainRotationRevertedEvent({
      event,
      pinned,
      resolver: identity.public_key_b64,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('domain_mismatch');
  });
});

// ────────────────────────────────────────────────────────────────
// Engine: stageDomainRotation + revertDomainRotation
// ────────────────────────────────────────────────────────────────

interface CapturedEffects {
  notices: CertDomainRotationNotice[];
  reverts: CertDomainRotationRevertedEvent[];
  audits: Array<{
    op: 'tls_renew';
    key_class: 'tls_private_key';
    domain: string;
    rotated_at: number;
    new_fingerprint: string;
    previous_fingerprint?: string;
    triggered_by_client_id: string;
    reason?: string;
    revert?: true;
  }>;
}

const createCapturedEffects = (): {
  effects: import('../keys/rotation/index.js').PerDomainRotationEffects;
  captured: CapturedEffects;
} => {
  const captured: CapturedEffects = { notices: [], reverts: [], audits: [] };
  return {
    captured,
    effects: {
      async broadcastCertDomainRotationNotice(notice) {
        captured.notices.push(notice);
      },
      async broadcastCertDomainRotationReverted(event) {
        captured.reverts.push(event);
      },
      async recordAudit(payload) {
        captured.audits.push(payload);
      },
    },
  };
};

describe('D-148 FU3 — createPerDomainRotationEngine.stageDomainRotation', () => {
  it('happy path emits signed notice + audit row with default 7d lead', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: 'sha256:prev',
      next_fingerprint: 'sha256:next',
      triggered_by_client_id: 'webclient-1',
      reason: 'scheduled-renewal',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.domain).toBe('alice.recued.cloud');
    expect(result.rotation_at).toBe(NOW + DEFAULT_DOMAIN_ROTATION_NOTICE_LEAD_MS);
    expect(result.notice.domain).toBe('alice.recued.cloud');
    expect(result.notice.current_fingerprint).toBe('sha256:prev');
    expect(result.notice.next_fingerprint).toBe('sha256:next');
    expect(result.notice.signer_fingerprint).toBe(identity.public_key_fingerprint);
    expect(captured.notices).toHaveLength(1);
    expect(captured.notices[0]).toEqual(result.notice);
    expect(captured.audits).toHaveLength(1);
    expect(captured.audits[0]).toMatchObject({
      op: 'tls_renew',
      key_class: 'tls_private_key',
      domain: 'alice.recued.cloud',
      new_fingerprint: 'sha256:next',
      previous_fingerprint: 'sha256:prev',
      triggered_by_client_id: 'webclient-1',
      reason: 'scheduled-renewal',
    });
    expect(captured.audits[0]?.revert).toBeUndefined();
  });

  it('emitted notice verifies against the signer pubkey', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: 'sha256:prev',
      next_fingerprint: 'sha256:next',
      triggered_by_client_id: 'webclient-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(verifyCertDomainRotationNotice(result.notice, identity.public_key_b64)).toEqual({
      ok: true,
    });
  });

  // Codex W3.FU3 P2 fold — emitting a notice with
  // `rotation_at === emitted_at` would round-trip as
  // `rotation_at_in_past` at the applier. The engine refuses
  // non-positive offsets so emitters cannot ship notices the
  // applier would deterministically reject. Tests that need a
  // tight rotation_at assertion use a small positive offset (1ms
  // is enough — the test's synthetic clock is fixed).
  it('rejects rotation_at_offset_ms=0 with invalid_rotation_offset (Codex W3.FU3 P2 fold)', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: 'sha256:prev',
      next_fingerprint: 'sha256:next',
      triggered_by_client_id: 'webclient-1',
      rotation_at_offset_ms: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('invalid_rotation_offset');
    expect(captured.notices).toHaveLength(0);
    expect(captured.audits).toHaveLength(0);
  });

  it('rejects negative rotation_at_offset_ms with invalid_rotation_offset', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: 'sha256:prev',
      next_fingerprint: 'sha256:next',
      triggered_by_client_id: 'webclient-1',
      rotation_at_offset_ms: -1000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('invalid_rotation_offset');
    expect(captured.notices).toHaveLength(0);
    expect(captured.audits).toHaveLength(0);
  });

  it('positive rotation_at_offset_ms emits a notice the applier accepts (round-trip)', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: 'sha256:prev',
      next_fingerprint: 'sha256:next',
      triggered_by_client_id: 'webclient-1',
      rotation_at_offset_ms: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rotation_at).toBe(NOW + 1);
    expect(captured.notices[0]?.rotation_at).toBe(NOW + 1);
    // Receiver applies the notice with `now = NOW` (notice's
    // rotation_at is 1ms ahead of the receiver's clock).
    const pinned: PinnedDomainCertState = {
      domain: 'alice.recued.cloud',
      current_fingerprint: 'sha256:prev',
      current_valid_until: NOW + ONE_DAY,
    };
    const apply = applyCertDomainRotationNotice({
      notice: result.notice,
      pinned,
      resolver: identity.public_key_b64,
      now: NOW,
    });
    expect(apply.ok).toBe(true);
  });

  it('rotation_notice_lead_ms engine-level override sets the default', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
      rotation_notice_lead_ms: 3 * ONE_DAY,
    });
    const result = await engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: 'sha256:prev',
      next_fingerprint: 'sha256:next',
      triggered_by_client_id: 'webclient-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rotation_at).toBe(NOW + 3 * ONE_DAY);
  });

  it('canonicalises mixed-case domain to lowercase', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.stageDomainRotation({
      domain: 'Alice.Recued.CLOUD',
      previous_fingerprint: 'sha256:prev',
      next_fingerprint: 'sha256:next',
      triggered_by_client_id: 'webclient-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.domain).toBe('alice.recued.cloud');
    expect(captured.notices[0]?.domain).toBe('alice.recued.cloud');
    expect(captured.audits[0]?.domain).toBe('alice.recued.cloud');
  });

  it('rejects empty domain with invalid_domain (no broadcast or audit)', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.stageDomainRotation({
      domain: '   ',
      previous_fingerprint: 'sha256:prev',
      next_fingerprint: 'sha256:next',
      triggered_by_client_id: 'webclient-1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('invalid_domain');
    expect(captured.notices).toHaveLength(0);
    expect(captured.audits).toHaveLength(0);
  });

  it('rejects empty fingerprint with invalid_fingerprint', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: '',
      next_fingerprint: 'sha256:next',
      triggered_by_client_id: 'webclient-1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('invalid_fingerprint');
    expect(captured.notices).toHaveLength(0);
    expect(captured.audits).toHaveLength(0);
  });

  it('rejects equal previous + next fingerprints with fingerprint_unchanged', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: 'sha256:same',
      next_fingerprint: 'sha256:same',
      triggered_by_client_id: 'webclient-1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('fingerprint_unchanged');
    expect(captured.notices).toHaveLength(0);
    expect(captured.audits).toHaveLength(0);
  });

  it('multi-domain stages remain independent (rotating one does not affect the other)', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    // Positive offset per Codex W3.FU3 P2 fold (non-positive rejects
    // with invalid_rotation_offset; tests use 1ms for tight
    // emission-side assertions).
    const a = await engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: 'sha256:a-prev',
      next_fingerprint: 'sha256:a-next',
      triggered_by_client_id: 'webclient-1',
      rotation_at_offset_ms: 1,
    });
    const b = await engine.stageDomainRotation({
      domain: 'bob.example.com',
      previous_fingerprint: 'sha256:b-prev',
      next_fingerprint: 'sha256:b-next',
      triggered_by_client_id: 'webclient-1',
      rotation_at_offset_ms: 1,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(captured.notices).toHaveLength(2);
    expect(captured.notices[0]?.domain).toBe('alice.recued.cloud');
    expect(captured.notices[1]?.domain).toBe('bob.example.com');
    // The fingerprints are domain-scoped — neither notice leaks into
    // the other's payload.
    expect(captured.notices[0]?.next_fingerprint).toBe('sha256:a-next');
    expect(captured.notices[1]?.next_fingerprint).toBe('sha256:b-next');
  });

  it('serialises concurrent rotation against the SAME domain via rotation_in_progress', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    let load_resolvers: Array<() => void> = [];
    const blockedLoad = (): Promise<typeof identity> =>
      new Promise<typeof identity>((resolve) => {
        load_resolvers.push(() => resolve(identity));
      });
    const { effects } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: blockedLoad },
      effects,
    });
    // Kick off rotation #1 — it's blocked on `load`.
    const first = engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: 'sha256:prev',
      next_fingerprint: 'sha256:next',
      triggered_by_client_id: 'webclient-1',
    });
    // While #1 is in flight, kick off #2 — it should short-circuit
    // with rotation_in_progress without waiting.
    const second = await engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: 'sha256:prev',
      next_fingerprint: 'sha256:other',
      triggered_by_client_id: 'webclient-2',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe('rotation_in_progress');
    // Unblock #1; it should still succeed.
    load_resolvers.forEach((r) => r());
    const first_result = await first;
    expect(first_result.ok).toBe(true);
  });
});

describe('D-148 FU3 — createPerDomainRotationEngine.revertDomainRotation', () => {
  it('happy path emits signed revert event + audit row (revert: true)', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW + 2 * ONE_DAY,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.revertDomainRotation({
      domain: 'alice.recued.cloud',
      reverted_to_fingerprint: 'sha256:prev',
      triggered_by_client_id: 'webclient-1',
      reason: 'chain-misconfig',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reverted_at).toBe(NOW + 2 * ONE_DAY);
    expect(result.event.domain).toBe('alice.recued.cloud');
    expect(result.event.reverted_to_fingerprint).toBe('sha256:prev');
    expect(result.event.reason).toBe('chain-misconfig');
    expect(captured.reverts).toHaveLength(1);
    expect(captured.audits).toHaveLength(1);
    expect(captured.audits[0]).toMatchObject({
      op: 'tls_renew',
      key_class: 'tls_private_key',
      domain: 'alice.recued.cloud',
      new_fingerprint: 'sha256:prev',
      revert: true,
      reason: 'chain-misconfig',
    });
  });

  it('emitted revert verifies against the signer pubkey', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.revertDomainRotation({
      domain: 'alice.recued.cloud',
      reverted_to_fingerprint: 'sha256:prev',
      triggered_by_client_id: 'webclient-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(verifyCertDomainRotationRevertedEvent(result.event, identity.public_key_b64)).toEqual({
      ok: true,
    });
  });

  it('canonicalises mixed-case domain to lowercase on revert', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.revertDomainRotation({
      domain: 'Alice.Recued.CLOUD',
      reverted_to_fingerprint: 'sha256:prev',
      triggered_by_client_id: 'webclient-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.domain).toBe('alice.recued.cloud');
    expect(captured.reverts[0]?.domain).toBe('alice.recued.cloud');
  });

  it('rejects empty domain with invalid_domain', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.revertDomainRotation({
      domain: '',
      reverted_to_fingerprint: 'sha256:prev',
      triggered_by_client_id: 'webclient-1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('invalid_domain');
    expect(captured.reverts).toHaveLength(0);
    expect(captured.audits).toHaveLength(0);
  });

  it('rejects empty reverted_to_fingerprint with invalid_fingerprint', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.revertDomainRotation({
      domain: 'alice.recued.cloud',
      reverted_to_fingerprint: '',
      triggered_by_client_id: 'webclient-1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('invalid_fingerprint');
    expect(captured.reverts).toHaveLength(0);
    expect(captured.audits).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// End-to-end: stage → applyNotice → revert → applyRevert
// ────────────────────────────────────────────────────────────────

describe('D-148 FU3 — end-to-end stage + apply + revert flow', () => {
  it('staged notice round-trips through the pin-state applier', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const stage = await engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      triggered_by_client_id: 'webclient-1',
    });
    expect(stage.ok).toBe(true);
    if (!stage.ok) return;
    const pinned: PinnedDomainCertState = {
      domain: 'alice.recued.cloud',
      current_fingerprint: 'sha256:current',
      current_valid_until: NOW + ONE_DAY,
    };
    const apply = applyCertDomainRotationNotice({
      notice: stage.notice,
      pinned,
      resolver: identity.public_key_b64,
      now: NOW,
    });
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.nextPinned.next_fingerprint).toBe('sha256:next');
    expect(apply.nextPinned.current_valid_until).toBe(stage.rotation_at);
  });

  it('revert collapses the two-pin overlap on the receiver', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW + ONE_DAY,
      server_identity: { load: async () => identity },
      effects,
    });
    // Receiver already has the next staged.
    const pinned: PinnedDomainCertState = {
      domain: 'alice.recued.cloud',
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: NOW + 7 * ONE_DAY,
      rotation_signed_notice: 'prior-sig',
    };
    const revert = await engine.revertDomainRotation({
      domain: 'alice.recued.cloud',
      reverted_to_fingerprint: 'sha256:current',
      triggered_by_client_id: 'webclient-1',
      reason: 'rollback',
    });
    expect(revert.ok).toBe(true);
    if (!revert.ok) return;
    const apply = applyCertDomainRotationRevertedEvent({
      event: revert.event,
      pinned,
      resolver: identity.public_key_b64,
    });
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.nextPinned.next_fingerprint).toBeUndefined();
    expect(apply.nextPinned.rotation_signed_notice).toBeUndefined();
    expect(apply.nextPinned.current_fingerprint).toBe('sha256:current');
  });
});

// ────────────────────────────────────────────────────────────────
// Closed-list ratchets (defends against drift)
// ────────────────────────────────────────────────────────────────

describe('D-148 FU3 — closed-list ratchets', () => {
  it('DEFAULT_DOMAIN_ROTATION_NOTICE_LEAD_MS is 7 days per spec § A.6.5', () => {
    expect(DEFAULT_DOMAIN_ROTATION_NOTICE_LEAD_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('signed-bytes builder produces lexicographically ordered JSON for the notice', () => {
    const bytes = signedBytesForCertDomainRotationNotice({
      domain: 'alice.recued.cloud',
      current_fingerprint: 'sha256:aaaa',
      next_fingerprint: 'sha256:bbbb',
      rotation_at: NOW,
    });
    // Field order is the load-bearing invariant — different field
    // order produces a different signed payload + signature mismatch.
    expect(bytes).toBe(
      JSON.stringify({
        current_fingerprint: 'sha256:aaaa',
        domain: 'alice.recued.cloud',
        next_fingerprint: 'sha256:bbbb',
        rotation_at: NOW,
        type: 'cert_domain_rotation_notice',
      }),
    );
  });

  it('signed-bytes builder canonicalises reason=undefined to null for the revert', () => {
    const bytes = signedBytesForCertDomainRotationReverted({
      domain: 'alice.recued.cloud',
      reverted_to_fingerprint: 'sha256:aaaa',
      reverted_at: NOW,
    });
    expect(bytes).toContain('"reason":null');
  });

  it('engine refuses NaN / non-finite rotation_at_offset_ms (Codex W3.FU3 P2 fold)', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { effects, captured } = createCapturedEffects();
    const engine = createPerDomainRotationEngine({
      clock: () => NOW,
      server_identity: { load: async () => identity },
      effects,
    });
    const result = await engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: 'sha256:prev',
      next_fingerprint: 'sha256:next',
      triggered_by_client_id: 'webclient-1',
      rotation_at_offset_ms: Number.NaN,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('invalid_rotation_offset');
    // Also covers Infinity — Number.isFinite rejects both.
    const inf = await engine.stageDomainRotation({
      domain: 'alice.recued.cloud',
      previous_fingerprint: 'sha256:prev',
      next_fingerprint: 'sha256:next',
      triggered_by_client_id: 'webclient-1',
      rotation_at_offset_ms: Number.POSITIVE_INFINITY,
    });
    expect(inf.ok).toBe(false);
    if (inf.ok) return;
    expect(inf.error).toBe('invalid_rotation_offset');
    expect(captured.notices).toHaveLength(0);
    expect(captured.audits).toHaveLength(0);
  });

  it('per-domain notice + revert types are distinct from single-domain', () => {
    // Compile-time + runtime distinction. The W3.2 wave-3 test asserts
    // the type string differs; this re-asserts at FU3 to catch any
    // future drift in the discriminator + at the substrate boundary.
    const notice = signedBytesForCertDomainRotationNotice({
      domain: 'alice.recued.cloud',
      current_fingerprint: 'sha256:aaaa',
      next_fingerprint: 'sha256:bbbb',
      rotation_at: NOW,
    });
    expect(notice.includes('cert_domain_rotation_notice')).toBe(true);
    expect(notice.includes('cert_rotation_notice') && !notice.includes('domain')).toBe(false);
  });
});
