/** D-148 § A.6.5 / § A.9 / slice 115 — passport-fetch verify path.
 *
 *  Covers the two primitives that close the "observed cert flipped"
 *  loop on the webclient side, finishing the WS-handshake side of the
 *  two-pin overlap protocol:
 *
 *   - `applyObservedCertFingerprintToState` — pure transition over the
 *     four states (seed / promote / idempotent / unknown) the observed
 *     cert can land in relative to the pinned `current` + staged `next`.
 *   - `verifyPassportCertAttestation` — composes Ed25519 signature
 *     verify + identity-key-replay defense + cert-fingerprint-presence
 *     gate, then delegates to the pure transition.
 *
 *  The integration (post-WS-connect `passport.fetch` rpc + persist +
 *  panel update) is a follow-on slice. This file locks the
 *  verification primitives.
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalPassportSigningPayload,
  SERVER_PASSPORT_VERSION,
  type ServerPassportSupportRedacted,
  type WebclientCertPinState,
} from '@recued/contracts';
import { bytesToBase64 } from '@recued/crypto';

import {
  applyObservedCertFingerprintToState,
  DEFAULT_PASSPORT_VERIFY_FUTURE_SKEW_MS,
  DEFAULT_PASSPORT_VERIFY_MAX_AGE_MS,
  verifyPassportCertAttestation,
} from '../realtime/cert-pin.js';

// ════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════

const ed25519Available = async (): Promise<boolean> => {
  try {
    await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
};

interface KeyFixture {
  pubkeyB64: string;
  privateKey: CryptoKey;
}

const generateEd25519Fixture = async (): Promise<KeyFixture> => {
  const kp = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  return {
    pubkeyB64: bytesToBase64(new Uint8Array(spki)),
    privateKey: kp.privateKey,
  };
};

const signCanonical = async (
  privateKey: CryptoKey,
  passport: Omit<ServerPassportSupportRedacted, 'signature'>,
): Promise<string> => {
  const transcript = new TextEncoder().encode(
    canonicalPassportSigningPayload({ ...passport, signature: '' }),
  );
  const sig = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    transcript as BufferSource,
  );
  return bytesToBase64(new Uint8Array(sig));
};

const buildPassport = (
  pubkeyB64: string,
  over?: Partial<ServerPassportSupportRedacted['network']>,
): Omit<ServerPassportSupportRedacted, 'signature'> => ({
  passport_version: SERVER_PASSPORT_VERSION,
  passport_id: 'passport-uuid-1',
  profile: 'support_redacted',
  exported_at: 1_700_000_000_000,
  exported_by_client_id: 'client-abc',
  identity: {
    server_public_key: pubkeyB64,
    server_identity_fingerprint: 'sha256:server',
    current_handle: 'alice',
  },
  network: {
    cert_fingerprint: 'sha256:current',
    cert_expires_at: 1_710_000_000_000,
    derived_preset_label: 'lan_only',
    public_mcp_acknowledged: false,
    per_path: {
      health: { resolution: { lan: true, public: false } },
      ws: { resolution: { lan: true, public: false } },
      mcp: { resolution: { lan: true, public: false } },
      llm_gateway: { resolution: { lan: true, public: false } },
      webhooks: { resolution: { lan: false, public: false } },
      reception: { resolution: { lan: false, public: false } },
      oauth: { resolution: { lan: false, public: false } },
      ask: { resolution: { lan: false, public: false } },
      webclient: { resolution: { lan: true, public: false } },
    },
    ...over,
  },
  clients: { bridge_count: 0, webclient_count: 1, cli_count: 0 },
  capabilities: {
    software_version: '0.2.0',
    os: 'linux',
    arch: 'x64',
    installed_pack_count: 0,
    connections_by_vendor: [],
  },
  recovery: {
    backup_status: 'configured',
    filevault_recovery_key_status: 'present',
  },
  key_health: {
    master_dek: { status: 'healthy' },
    sub_dek: { status: 'healthy' },
    server_identity_key: { status: 'healthy' },
    publisher_identity_key: { status: 'healthy' },
    tls_private_key: { status: 'healthy' },
    webclient_token: { status: 'healthy' },
    webhook_secret: { status: 'healthy' },
  },
});

const FIXED_NOW = 1_700_000_000_000;

// ════════════════════════════════════════════════════════════════
// applyObservedCertFingerprintToState
// ════════════════════════════════════════════════════════════════

describe('D-148 § A.6.5 — applyObservedCertFingerprintToState (pure transition)', () => {
  it('seeds when state is null (DD#2 — no prior pin)', () => {
    const result = applyObservedCertFingerprintToState(
      null,
      { observed_fingerprint: 'sha256:fresh', observed_valid_until: 9_000_000 },
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('seeded');
      expect(result.next).toEqual({
        current_fingerprint: 'sha256:fresh',
        current_valid_until: 9_000_000,
      });
    }
  });

  it('seeds when current_fingerprint is the DD#2 empty-string sentinel', () => {
    const stale: WebclientCertPinState = {
      current_fingerprint: '',
      next_fingerprint: 'sha256:was_staged',
      current_valid_until: 5_000_000,
    };
    const result = applyObservedCertFingerprintToState(
      stale,
      { observed_fingerprint: 'sha256:fresh', observed_valid_until: 9_000_000 },
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('seeded');
      // Stray staged-next from a prior rotation_notice is dropped —
      // observed IS the new baseline (DD#2: accept whatever the server
      // vouches for).
      expect(result.next.next_fingerprint).toBeUndefined();
      expect(result.next.current_fingerprint).toBe('sha256:fresh');
      expect(result.next.current_valid_until).toBe(9_000_000);
    }
  });

  it('preserves last_rotated_at on seed when prior state carried it', () => {
    const stale: WebclientCertPinState = {
      current_fingerprint: '',
      current_valid_until: 5_000_000,
      last_rotated_at: 3_000_000,
    };
    const result = applyObservedCertFingerprintToState(
      stale,
      { observed_fingerprint: 'sha256:fresh', observed_valid_until: 9_000_000 },
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('seeded');
      expect(result.next.last_rotated_at).toBe(3_000_000);
    }
  });

  it('is idempotent when observed matches pinned current (returns same ref)', () => {
    const pinned: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      current_valid_until: 8_000_000,
    };
    const result = applyObservedCertFingerprintToState(
      pinned,
      { observed_fingerprint: 'sha256:current', observed_valid_until: 9_500_000 },
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('idempotent');
      // Same-reference contract — watcher's ref-equality short-circuit
      // skips the rerender + caller can skip the persist.
      expect(result.next).toBe(pinned);
    }
  });

  it('promotes when observed matches the staged next (clears next, stamps last_rotated_at = now)', () => {
    const staged: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: 5_000_000,
    };
    const result = applyObservedCertFingerprintToState(
      staged,
      { observed_fingerprint: 'sha256:next', observed_valid_until: 9_500_000 },
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('promoted');
      expect(result.next.current_fingerprint).toBe('sha256:next');
      expect(result.next.next_fingerprint).toBeUndefined();
      expect(result.next.current_valid_until).toBe(9_500_000);
      expect(result.next.last_rotated_at).toBe(FIXED_NOW);
    }
  });

  it('rejects observed_fingerprint_unknown when prior pin exists + observed matches neither', () => {
    const staged: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: 5_000_000,
    };
    const result = applyObservedCertFingerprintToState(
      staged,
      { observed_fingerprint: 'sha256:wild', observed_valid_until: 9_500_000 },
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('observed_fingerprint_unknown');
  });

  it('rejects observed_fingerprint_unknown for an empty observed string', () => {
    const pinned: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      current_valid_until: 8_000_000,
    };
    const result = applyObservedCertFingerprintToState(
      pinned,
      { observed_fingerprint: '', observed_valid_until: 9_500_000 },
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('observed_fingerprint_unknown');
  });

  it('promotion preserves the new cert expiry, not the pre-rotation value', () => {
    // Pre-rotation: current_valid_until is rotation_at (the moment
    // current stops being authoritative). Post-promotion: current_
    // valid_until SHOULD reflect the new cert's actual expiry,
    // sourced from `observed_valid_until`.
    const staged: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: 1_701_000_000_000,
    };
    const result = applyObservedCertFingerprintToState(
      staged,
      { observed_fingerprint: 'sha256:next', observed_valid_until: 1_750_000_000_000 },
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.current_valid_until).toBe(1_750_000_000_000);
    }
  });

  it('promotion retains the prior current_fingerprint as previous_fingerprint + sets previous_valid_until to rotation_at + 7d (Codex P2 folds, slices 115 + 116a + 116b)', () => {
    // Closes the post-promotion rollback gap: a `cert.rotation_reverted`
    // event naming the OLD current must still find a trusted target
    // after passport-fetch promotes the staged-next. Retaining the
    // prior current as previous_fingerprint here + widening the revert
    // handler's match to include previous_fingerprint composes the
    // rollback path end-to-end.
    //
    // Window guard semantics (slice 116b): previous_valid_until is
    // based on the ROTATION TIME (`current.current_valid_until` =
    // `rotation_at` from the staging notice), NOT on `now`. A client
    // offline for part of the overlap would otherwise extend trust far
    // past the spec's bound.
    const ROTATION_AT = 1_701_000_000_000;
    const staged: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: ROTATION_AT, // set by staging notice
    };
    // Promote at FIXED_NOW which is BEFORE rotation_at — emulates the
    // typical "client observes new cert during overlap" path.
    const result = applyObservedCertFingerprintToState(
      staged,
      { observed_fingerprint: 'sha256:next', observed_valid_until: 9_500_000_000_000 },
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('promoted');
      expect(result.next.current_fingerprint).toBe('sha256:next');
      expect(result.next.previous_fingerprint).toBe('sha256:current');
      // ROTATION_AT + 7 days in ms — NOT now + 7 days.
      expect(result.next.previous_valid_until).toBe(
        ROTATION_AT + 7 * 24 * 60 * 60 * 1000,
      );
      expect(result.next.next_fingerprint).toBeUndefined();
    }
  });

  it('promotion-window is independent of observation time (Codex P2 slice 116b — offline catch-up scenario)', () => {
    // Client offline for part of the overlap: notice for T staged at
    // T-7d (overlap start), client comes back at T+6d, promotes. The
    // window should still end at T+7d (1 day past rotation), NOT at
    // T+13d (7 days past observation).
    const ROTATION_AT = 1_701_000_000_000;
    const observedAt = ROTATION_AT + 6 * 24 * 60 * 60 * 1000; // T+6d
    const staged: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: ROTATION_AT,
    };
    const result = applyObservedCertFingerprintToState(
      staged,
      { observed_fingerprint: 'sha256:next', observed_valid_until: 9_500_000_000_000 },
      observedAt,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Window from ROTATION_AT + 7d = T+7d. Independent of `observedAt`.
      expect(result.next.previous_valid_until).toBe(
        ROTATION_AT + 7 * 24 * 60 * 60 * 1000,
      );
      // last_rotated_at IS from observation time (it stamps the
      // moment the webclient saw the promotion).
      expect(result.next.last_rotated_at).toBe(observedAt);
    }
  });

  it('seed branch does not carry previous_fingerprint forward', () => {
    // Seeding is "starting fresh" — any prior previous_fingerprint
    // is stale infrastructure that shouldn't survive the reset.
    const stale: WebclientCertPinState = {
      current_fingerprint: '',
      previous_fingerprint: 'sha256:old',
      current_valid_until: 5_000_000,
    };
    const result = applyObservedCertFingerprintToState(
      stale,
      { observed_fingerprint: 'sha256:fresh', observed_valid_until: 9_500_000 },
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('seeded');
      expect(result.next.previous_fingerprint).toBeUndefined();
    }
  });

  it('idempotent branch preserves previous_fingerprint (same-ref contract)', () => {
    // Idempotent returns the input ref so the watcher's reference-
    // equality short-circuit fires — that contract also implies
    // `previous_fingerprint` rides along untouched.
    const pinned: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      previous_fingerprint: 'sha256:old',
      current_valid_until: 8_000_000,
    };
    const result = applyObservedCertFingerprintToState(
      pinned,
      { observed_fingerprint: 'sha256:current', observed_valid_until: 9_500_000 },
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('idempotent');
      expect(result.next).toBe(pinned);
      expect(result.next.previous_fingerprint).toBe('sha256:old');
    }
  });
});

// ════════════════════════════════════════════════════════════════
// verifyPassportCertAttestation
// ════════════════════════════════════════════════════════════════

describe('D-148 § A.6.5 / § A.9 — verifyPassportCertAttestation (verify wrapper)', () => {
  it('returns signature_invalid when the signature does not verify', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = buildPassport(key.pubkeyB64);
    // Forge the signature.
    const result = await verifyPassportCertAttestation(
      { ...passport, signature: 'AAAA' },
      key.pubkeyB64,
      null,
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature_invalid');
  });

  it('returns identity_key_mismatch when passport identity points at a different key (replay defense)', async () => {
    if (!(await ed25519Available())) return;
    // SIGNING key is keyA; identity claims keyB. The replay defense
    // catches this: signature could still verify against the pinned
    // key (= keyA), but the passport claims it was issued by keyB.
    // The mismatch flags the post-rotation passport-replay class
    // (spec § A.9 line 1290).
    const signingKey = await generateEd25519Fixture();
    const otherKey = await generateEd25519Fixture();
    const passport = buildPassport(otherKey.pubkeyB64);
    const signature = await signCanonical(signingKey.privateKey, passport);
    const result = await verifyPassportCertAttestation(
      { ...passport, signature },
      signingKey.pubkeyB64,
      null,
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('identity_key_mismatch');
  });

  it('returns cert_fingerprint_missing when passport.network.cert_fingerprint is empty', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = buildPassport(key.pubkeyB64, { cert_fingerprint: '' });
    const signature = await signCanonical(key.privateKey, passport);
    const result = await verifyPassportCertAttestation(
      { ...passport, signature },
      key.pubkeyB64,
      null,
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('cert_fingerprint_missing');
  });

  it('promotes next_fingerprint when a validly-signed passport vouches for it', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = buildPassport(key.pubkeyB64, {
      cert_fingerprint: 'sha256:next',
      cert_expires_at: 1_750_000_000_000,
    });
    const signature = await signCanonical(key.privateKey, passport);
    const staged: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: 1_701_000_000_000,
    };
    const result = await verifyPassportCertAttestation(
      { ...passport, signature },
      key.pubkeyB64,
      staged,
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('promoted');
      expect(result.next.current_fingerprint).toBe('sha256:next');
      expect(result.next.next_fingerprint).toBeUndefined();
      expect(result.next.last_rotated_at).toBe(FIXED_NOW);
    }
  });

  it('seeds when no prior pin exists and signature verifies', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = buildPassport(key.pubkeyB64, {
      cert_fingerprint: 'sha256:fresh',
      cert_expires_at: 1_750_000_000_000,
    });
    const signature = await signCanonical(key.privateKey, passport);
    const result = await verifyPassportCertAttestation(
      { ...passport, signature },
      key.pubkeyB64,
      null,
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('seeded');
      expect(result.next.current_fingerprint).toBe('sha256:fresh');
    }
  });

  it('is idempotent when passport cert matches pinned current', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = buildPassport(key.pubkeyB64, {
      cert_fingerprint: 'sha256:current',
      cert_expires_at: 1_750_000_000_000,
    });
    const signature = await signCanonical(key.privateKey, passport);
    const pinned: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      current_valid_until: 1_710_000_000_000,
    };
    const result = await verifyPassportCertAttestation(
      { ...passport, signature },
      key.pubkeyB64,
      pinned,
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe('idempotent');
      expect(result.next).toBe(pinned);
    }
  });

  it('rejects observed_fingerprint_unknown when passport cert matches neither current nor next', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = buildPassport(key.pubkeyB64, {
      cert_fingerprint: 'sha256:wild',
      cert_expires_at: 1_750_000_000_000,
    });
    const signature = await signCanonical(key.privateKey, passport);
    const staged: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: 1_701_000_000_000,
    };
    const result = await verifyPassportCertAttestation(
      { ...passport, signature },
      key.pubkeyB64,
      staged,
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('observed_fingerprint_unknown');
  });
});

// ════════════════════════════════════════════════════════════════
// Freshness window (Codex P2 fold, slice 115)
// ════════════════════════════════════════════════════════════════

describe('D-148 § A.6.5 / § A.9 — passport-fetch freshness gate', () => {
  it('rejects passport_stale when exported_at is older than the default max age', async () => {
    if (!(await ed25519Available())) return;
    // A pinned passport signed 6 minutes ago — outside the default
    // 5-minute window. The signature alone would verify; the
    // freshness gate is what stops the replay (Codex P2 fold).
    const key = await generateEd25519Fixture();
    const stalePassport = {
      ...buildPassport(key.pubkeyB64),
      exported_at: FIXED_NOW - DEFAULT_PASSPORT_VERIFY_MAX_AGE_MS - 60_000,
    };
    const signature = await signCanonical(key.privateKey, stalePassport);
    const pinned: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      current_valid_until: 1_710_000_000_000,
    };
    const result = await verifyPassportCertAttestation(
      { ...stalePassport, signature },
      key.pubkeyB64,
      pinned,
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('passport_stale');
  });

  it('rejects passport_stale when exported_at is further in the future than the skew tolerance', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const futurePassport = {
      ...buildPassport(key.pubkeyB64),
      exported_at: FIXED_NOW + DEFAULT_PASSPORT_VERIFY_FUTURE_SKEW_MS + 60_000,
    };
    const signature = await signCanonical(key.privateKey, futurePassport);
    const result = await verifyPassportCertAttestation(
      { ...futurePassport, signature },
      key.pubkeyB64,
      null,
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('passport_stale');
  });

  it('accepts a passport at the edge of the freshness window (max-age - 1ms)', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const edgePassport = {
      ...buildPassport(key.pubkeyB64),
      exported_at: FIXED_NOW - DEFAULT_PASSPORT_VERIFY_MAX_AGE_MS + 1,
    };
    const signature = await signCanonical(key.privateKey, edgePassport);
    const result = await verifyPassportCertAttestation(
      { ...edgePassport, signature },
      key.pubkeyB64,
      null,
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcome).toBe('seeded');
  });

  it('honors the maxAgeMs override (tests with skewed clocks)', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    // 1h-old passport — would fail the 5min default, passes a 2h
    // override (e.g., a test that injects a wide window).
    const olderPassport = {
      ...buildPassport(key.pubkeyB64),
      exported_at: FIXED_NOW - 60 * 60_000,
    };
    const signature = await signCanonical(key.privateKey, olderPassport);
    const result = await verifyPassportCertAttestation(
      { ...olderPassport, signature },
      key.pubkeyB64,
      null,
      FIXED_NOW,
      { maxAgeMs: 2 * 60 * 60_000 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcome).toBe('seeded');
  });
});
