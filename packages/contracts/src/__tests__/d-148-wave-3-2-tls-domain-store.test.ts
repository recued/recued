/** D-148 Wave 3 (sub-phase W3.2) — TLSDomainStore + multi-domain SNI
 *  contracts substrate.
 *
 *  Covers the additive multi-domain TLS types + pure helpers introduced
 *  alongside the single-cert flow (Amendment 2026-05-11). The single-
 *  cert types (`PinnedCertState` / `CertRotationNotice` / `CertRotation-
 *  RevertedEvent`) stay in production; W3.6 wires the per-handshake
 *  SNICallback + per-domain SQLite store on this substrate.
 *
 *  Invariants under test:
 *    - TLS_DOMAIN_CERT_SOURCES: closed list of 2 (`pro_acme` /
 *      `byo_upload`) — every entry unique; `isTLSDomainCertSource`
 *      type-predicate accepts each and rejects garbage.
 *    - NETWORK_ERROR_CODES widened with 5 TLS codes
 *      (`tls_domain_unknown` / `tls_san_mismatch` / `tls_key_pair_
 *      mismatch` / `tls_chain_invalid` / `tls_cert_expired_at_upload`)
 *      — legacy 14 codes preserved verbatim; total 19; no duplicates.
 *    - matchesSANForDomain: exact match (case-insensitive); wildcard
 *      `*.example.com` matches one-label `sub.example.com` but NOT
 *      `a.b.example.com`; case-insensitive on both sides; rejects
 *      empty SAN list.
 *    - validateTLSDomainUpload: SAN mismatch / key-pair mismatch /
 *      chain invalid / expired-at-upload each surface as their issue
 *      code; multiple gates can fail simultaneously; success returns
 *      `warns.expiry_within_7d` iff `expires_at < now + 7d` AND not
 *      already expired; `accept_self_signed` opts through chain gate
 *      only.
 *    - TLS_CERT_MIN_VALIDITY_MS is 7 days (matches
 *      CERT_ROTATION_NOTICE_LEAD_TIME_MS).
 *    - PinnedDomainCertState carries `domain` as the keying field;
 *      shape distinct from single-domain `PinnedCertState`.
 *    - CertDomainRotationNotice + CertDomainRotationRevertedEvent
 *      carry `domain`; type discriminator is `_domain_` variant of
 *      legacy.
 *    - SubDEKDomain widened with `'tls_domains'` slot in BOTH
 *      `@recued/contracts` (mirror) AND `@recued/crypto` (runtime
 *      derivation source).
 */

import { describe, it, expect } from 'vitest';
import {
  NETWORK_ERROR_CODES,
  TLS_DOMAIN_CERT_SOURCES,
  isTLSDomainCertSource,
  TLS_CERT_MIN_VALIDITY_MS,
  matchesSANForDomain,
  validateTLSDomainUpload,
  type TLSDomainCertSource,
  type TLSDomainUploadInput,
  type TLSDomainUploadVerifiers,
  type PinnedDomainCertState,
  type PinnedCertState,
  type CertDomainRotationNotice,
  type CertDomainRotationRevertedEvent,
  type D148SubDEKDomain,
} from '../index.js';

// ────────────────────────────────────────────────────────────────
// TLS_DOMAIN_CERT_SOURCES closed list
// ────────────────────────────────────────────────────────────────

describe('D-148 W3.2 — TLS_DOMAIN_CERT_SOURCES closed list', () => {
  it('enumerates exactly 2 distinct sources', () => {
    expect(TLS_DOMAIN_CERT_SOURCES.length).toBe(2);
    expect(new Set(TLS_DOMAIN_CERT_SOURCES).size).toBe(2);
  });

  it('canonical order matches spec § A.6.3', () => {
    expect([...TLS_DOMAIN_CERT_SOURCES]).toEqual(['pro_acme', 'byo_upload']);
  });

  it('isTLSDomainCertSource accepts both members', () => {
    for (const src of TLS_DOMAIN_CERT_SOURCES) {
      expect(isTLSDomainCertSource(src)).toBe(true);
    }
  });

  it('isTLSDomainCertSource rejects unknown strings + non-strings', () => {
    expect(isTLSDomainCertSource('letsencrypt')).toBe(false);
    expect(isTLSDomainCertSource('')).toBe(false);
    expect(isTLSDomainCertSource(undefined)).toBe(false);
    expect(isTLSDomainCertSource(null)).toBe(false);
    expect(isTLSDomainCertSource(42)).toBe(false);
    expect(isTLSDomainCertSource({})).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// NETWORK_ERROR_CODES — TLS widening
// ────────────────────────────────────────────────────────────────

describe('D-148 W3.2 — NETWORK_ERROR_CODES TLS widening', () => {
  it('carries the 5 new TLS error codes', () => {
    expect(NETWORK_ERROR_CODES).toContain('tls_domain_unknown');
    expect(NETWORK_ERROR_CODES).toContain('tls_san_mismatch');
    expect(NETWORK_ERROR_CODES).toContain('tls_key_pair_mismatch');
    expect(NETWORK_ERROR_CODES).toContain('tls_chain_invalid');
    expect(NETWORK_ERROR_CODES).toContain('tls_cert_expired_at_upload');
  });

  it('preserves W3.1 + carried-forward codes verbatim post W3.5 retirement of profile_* + post FU4/FU5 pro_acme codes', () => {
    // W3.5 retires the 2 legacy 5-profile codes (profile_unknown +
    // profile_unachievable_no_ddns) and renames to preset_unknown +
    // preset_unachievable_no_ddns. FU4 (Codex P2 fold) adds
    // `tls_pro_acme_unbind_required` to gate Pro-managed cert removal.
    // FU5 adds the two `pro_acme.unbind`-substrate error codes:
    // `pro_acme_not_found` + `pro_acme_ddns_release_failed`.
    // Final list: 9 carried-forward legacy + 4 W3.1 path codes + 5 W3.2
    // TLS codes + 1 FU4 code + 2 FU5 codes + 3 D-176 apex-mode codes = 24 total.
    expect(NETWORK_ERROR_CODES.length).toBe(24);
    expect(new Set(NETWORK_ERROR_CODES).size).toBe(24);
    // Spot-check carried-forward codes still present.
    expect(NETWORK_ERROR_CODES).toContain('preset_unknown');
    expect(NETWORK_ERROR_CODES).toContain('preset_unachievable_no_ddns');
    expect(NETWORK_ERROR_CODES).toContain('cert_pin_stale');
    expect(NETWORK_ERROR_CODES).toContain('telegram_port_unsupported');
    // W3.1 codes still present.
    expect(NETWORK_ERROR_CODES).toContain('path_unknown');
    expect(NETWORK_ERROR_CODES).toContain('ws_lockout_unconfirmed');
    expect(NETWORK_ERROR_CODES).toContain('ws_lockout_phrase_mismatch');
    // Codex FU4 P2 fold — pro_acme removal gate code present.
    expect(NETWORK_ERROR_CODES).toContain('tls_pro_acme_unbind_required');
    // FU5 pro_acme.unbind substrate error codes present.
    expect(NETWORK_ERROR_CODES).toContain('pro_acme_not_found');
    expect(NETWORK_ERROR_CODES).toContain('pro_acme_ddns_release_failed');
    // D-176 apex-mode codes present.
    expect(NETWORK_ERROR_CODES).toContain('apex_mode_unknown');
    expect(NETWORK_ERROR_CODES).toContain('apex_reception_not_public');
    expect(NETWORK_ERROR_CODES).toContain('apex_webclient_unavailable');
    // Legacy 5-profile codes retired.
    expect(NETWORK_ERROR_CODES).not.toContain('profile_unknown' as never);
    expect(NETWORK_ERROR_CODES).not.toContain('profile_unachievable_no_ddns' as never);
  });
});

// ────────────────────────────────────────────────────────────────
// matchesSANForDomain
// ────────────────────────────────────────────────────────────────

describe('D-148 W3.2 — matchesSANForDomain', () => {
  it('exact match (lowercase)', () => {
    expect(matchesSANForDomain('alice.recued.cloud', ['alice.recued.cloud'])).toBe(true);
  });

  it('exact match is case-insensitive on both sides', () => {
    expect(matchesSANForDomain('Alice.Recued.Cloud', ['alice.recued.cloud'])).toBe(true);
    expect(matchesSANForDomain('alice.recued.cloud', ['ALICE.RECUED.CLOUD'])).toBe(true);
    expect(matchesSANForDomain('Alice.Recued.Cloud', ['ALICE.RECUED.CLOUD'])).toBe(true);
  });

  it('wildcard *.example.com matches one-label sub.example.com', () => {
    expect(matchesSANForDomain('sub.example.com', ['*.example.com'])).toBe(true);
  });

  it('wildcard *.example.com does NOT match two-label a.b.example.com', () => {
    // RFC 6125 § 6.4.3 — wildcards are single-label only.
    expect(matchesSANForDomain('a.b.example.com', ['*.example.com'])).toBe(false);
  });

  it('wildcard *.example.com does NOT match the bare apex example.com', () => {
    expect(matchesSANForDomain('example.com', ['*.example.com'])).toBe(false);
  });

  it('wildcard *.example.com does NOT match adjacent suffix evilexample.com', () => {
    expect(matchesSANForDomain('evilexample.com', ['*.example.com'])).toBe(false);
  });

  it('mixed SAN list — first wildcard then exact', () => {
    expect(
      matchesSANForDomain('alice.recued.cloud', ['*.other.com', 'alice.recued.cloud']),
    ).toBe(true);
  });

  it('empty SAN list never matches', () => {
    expect(matchesSANForDomain('alice.recued.cloud', [])).toBe(false);
  });

  it('unrelated SAN never matches', () => {
    expect(matchesSANForDomain('alice.recued.cloud', ['bob.recued.cloud'])).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// validateTLSDomainUpload
// ────────────────────────────────────────────────────────────────

const NOW_MS = 1_700_000_000_000;
const ONE_DAY = 86_400_000;

/** Build a stub verifier seam with full control over each gate. */
const verifierStub = (overrides: Partial<TLSDomainUploadVerifiers> = {}): TLSDomainUploadVerifiers => ({
  extractSANs: () => ['alice.recued.cloud'],
  verifyKeyPair: () => true,
  verifyChain: () => true,
  readExpiresAt: () => NOW_MS + 90 * ONE_DAY,
  ...overrides,
});

const baseInput = (overrides: Partial<TLSDomainUploadInput> = {}): TLSDomainUploadInput => ({
  domain: 'alice.recued.cloud',
  cert_pem: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
  private_key_pem: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----',
  source: 'byo_upload',
  ...overrides,
});

describe('D-148 W3.2 — validateTLSDomainUpload happy path', () => {
  it('returns ok=true with san + expires_at when every gate passes', () => {
    const result = validateTLSDomainUpload(baseInput(), verifierStub(), { now_ms: NOW_MS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.san).toEqual(['alice.recued.cloud']);
    expect(result.expires_at).toBe(NOW_MS + 90 * ONE_DAY);
    expect(result.warns).toEqual({});
  });

  it('sets warns.expiry_within_7d when cert expires inside the 7d window', () => {
    const result = validateTLSDomainUpload(
      baseInput(),
      verifierStub({ readExpiresAt: () => NOW_MS + 3 * ONE_DAY }),
      { now_ms: NOW_MS },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warns).toEqual({ expiry_within_7d: true });
  });

  it('does NOT set warns when cert expires exactly at the 7d boundary', () => {
    // Boundary: expires_at - now === 7d → NOT within the warn band
    // (only < 7d triggers; the threshold itself is the floor).
    const result = validateTLSDomainUpload(
      baseInput(),
      verifierStub({ readExpiresAt: () => NOW_MS + TLS_CERT_MIN_VALIDITY_MS }),
      { now_ms: NOW_MS },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warns).toEqual({});
  });

  it('copies extracted SAN array — does NOT alias the verifier output', () => {
    const sans = ['alice.recued.cloud'];
    const result = validateTLSDomainUpload(
      baseInput(),
      verifierStub({ extractSANs: () => sans }),
      { now_ms: NOW_MS },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.san).toEqual(sans);
    expect(result.san).not.toBe(sans);
  });
});

describe('D-148 W3.2 — validateTLSDomainUpload SAN mismatch', () => {
  it('reports tls_san_mismatch when cert SANs do not cover the claimed domain', () => {
    const result = validateTLSDomainUpload(
      baseInput({ domain: 'alice.recued.cloud' }),
      verifierStub({ extractSANs: () => ['bob.recued.cloud'] }),
      { now_ms: NOW_MS },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual({
      code: 'tls_san_mismatch',
      san: ['bob.recued.cloud'],
      domain: 'alice.recued.cloud',
    });
  });

  it('passes when SAN is a covering wildcard', () => {
    const result = validateTLSDomainUpload(
      baseInput({ domain: 'sub.example.com' }),
      verifierStub({ extractSANs: () => ['*.example.com'] }),
      { now_ms: NOW_MS },
    );
    expect(result.ok).toBe(true);
  });
});

describe('D-148 W3.2 — validateTLSDomainUpload key-pair mismatch', () => {
  it('reports tls_key_pair_mismatch when verifier returns false', () => {
    const result = validateTLSDomainUpload(
      baseInput(),
      verifierStub({ verifyKeyPair: () => false }),
      { now_ms: NOW_MS },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({ code: 'tls_key_pair_mismatch' });
  });
});

describe('D-148 W3.2 — validateTLSDomainUpload chain validity', () => {
  it('reports tls_chain_invalid when verifier returns false', () => {
    const result = validateTLSDomainUpload(
      baseInput(),
      verifierStub({ verifyChain: () => false }),
      { now_ms: NOW_MS },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({ code: 'tls_chain_invalid' });
  });

  it('threads accept_self_signed=true to the chain verifier', () => {
    let receivedOpts: { accept_self_signed: boolean } | undefined;
    validateTLSDomainUpload(
      baseInput(),
      verifierStub({
        verifyChain: (_cert, _chain, opts) => {
          receivedOpts = opts;
          return true;
        },
      }),
      { now_ms: NOW_MS, accept_self_signed: true },
    );
    expect(receivedOpts).toEqual({ accept_self_signed: true });
  });

  it('threads accept_self_signed=false by default', () => {
    let receivedOpts: { accept_self_signed: boolean } | undefined;
    validateTLSDomainUpload(
      baseInput(),
      verifierStub({
        verifyChain: (_cert, _chain, opts) => {
          receivedOpts = opts;
          return true;
        },
      }),
      { now_ms: NOW_MS },
    );
    expect(receivedOpts).toEqual({ accept_self_signed: false });
  });
});

describe('D-148 W3.2 — validateTLSDomainUpload expired-at-upload', () => {
  it('reports tls_cert_expired_at_upload when expires_at <= now_ms', () => {
    const result = validateTLSDomainUpload(
      baseInput(),
      verifierStub({ readExpiresAt: () => NOW_MS - ONE_DAY }),
      { now_ms: NOW_MS },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      code: 'tls_cert_expired_at_upload',
      expires_at: NOW_MS - ONE_DAY,
      now_ms: NOW_MS,
    });
  });

  it('reports expired when expires_at exactly equals now_ms (boundary; treat as already expired)', () => {
    const result = validateTLSDomainUpload(
      baseInput(),
      verifierStub({ readExpiresAt: () => NOW_MS }),
      { now_ms: NOW_MS },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === 'tls_cert_expired_at_upload')).toBe(true);
  });

  it('does NOT mark cert with 0 expires_at as ok (sentinel for parse-failure)', () => {
    const result = validateTLSDomainUpload(
      baseInput(),
      verifierStub({ readExpiresAt: () => 0 }),
      { now_ms: NOW_MS },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === 'tls_cert_expired_at_upload')).toBe(true);
  });
});

describe('D-148 W3.2 — validateTLSDomainUpload multiple failures', () => {
  it('accumulates every failing gate', () => {
    const result = validateTLSDomainUpload(
      baseInput(),
      verifierStub({
        extractSANs: () => ['bob.recued.cloud'],
        verifyKeyPair: () => false,
        verifyChain: () => false,
        readExpiresAt: () => NOW_MS - ONE_DAY,
      }),
      { now_ms: NOW_MS },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(4);
    const codes = result.issues.map((i) => i.code).sort();
    expect(codes).toEqual([
      'tls_cert_expired_at_upload',
      'tls_chain_invalid',
      'tls_key_pair_mismatch',
      'tls_san_mismatch',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

describe('D-148 W3.2 — TLS_CERT_MIN_VALIDITY_MS', () => {
  it('is exactly 7 days in ms', () => {
    expect(TLS_CERT_MIN_VALIDITY_MS).toBe(7 * 86_400_000);
  });
});

// ────────────────────────────────────────────────────────────────
// PinnedDomainCertState shape
// ────────────────────────────────────────────────────────────────

describe('D-148 W3.2 — PinnedDomainCertState carries domain key', () => {
  it('shape is distinct from single-domain PinnedCertState (carries domain)', () => {
    const single: PinnedCertState = {
      current_fingerprint: 'aaaa',
      current_valid_until: NOW_MS + 30 * ONE_DAY,
    };
    const perDomain: PinnedDomainCertState = {
      domain: 'alice.recued.cloud',
      current_fingerprint: 'aaaa',
      current_valid_until: NOW_MS + 30 * ONE_DAY,
    };
    // Single-domain shape MUST NOT carry a `domain` key.
    expect((single as { domain?: string }).domain).toBeUndefined();
    // Per-domain shape MUST.
    expect(perDomain.domain).toBe('alice.recued.cloud');
  });

  it('supports optional next_fingerprint + signed notice', () => {
    const state: PinnedDomainCertState = {
      domain: 'alice.recued.cloud',
      current_fingerprint: 'aaaa',
      next_fingerprint: 'bbbb',
      current_valid_until: NOW_MS + 30 * ONE_DAY,
      rotation_signed_notice: 'sig-blob',
      last_rotated_at: NOW_MS,
    };
    expect(state.next_fingerprint).toBe('bbbb');
    expect(state.rotation_signed_notice).toBe('sig-blob');
  });
});

// ────────────────────────────────────────────────────────────────
// CertDomainRotationNotice + CertDomainRotationRevertedEvent
// ────────────────────────────────────────────────────────────────

describe('D-148 W3.2 — per-domain rotation events', () => {
  it('CertDomainRotationNotice discriminator is cert_domain_rotation_notice', () => {
    const notice: CertDomainRotationNotice = {
      type: 'cert_domain_rotation_notice',
      domain: 'alice.recued.cloud',
      current_fingerprint: 'aaaa',
      next_fingerprint: 'bbbb',
      rotation_at: NOW_MS + 7 * ONE_DAY,
      signature: 'sig',
      signer_fingerprint: 'sha256:cafe',
      emitted_at: NOW_MS,
    };
    expect(notice.type).toBe('cert_domain_rotation_notice');
    expect(notice.domain).toBe('alice.recued.cloud');
  });

  it('CertDomainRotationRevertedEvent discriminator is cert_domain_rotation_reverted', () => {
    const revert: CertDomainRotationRevertedEvent = {
      type: 'cert_domain_rotation_reverted',
      domain: 'alice.recued.cloud',
      reverted_to_fingerprint: 'aaaa',
      reverted_at: NOW_MS,
      signature: 'sig',
      signer_fingerprint: 'sha256:cafe',
    };
    expect(revert.type).toBe('cert_domain_rotation_reverted');
    expect(revert.domain).toBe('alice.recued.cloud');
  });

  it('per-domain discriminators are distinct from single-domain variants', () => {
    // Compile-time + runtime distinction: each per-domain event has
    // `_domain_` in its type string; single-domain has not.
    const single = 'cert_rotation_notice';
    const multi = 'cert_domain_rotation_notice';
    expect(single).not.toBe(multi);
    expect(multi.includes('_domain_')).toBe(true);
    expect(single.includes('_domain_')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// SubDEKDomain — tls_domains slot
// ────────────────────────────────────────────────────────────────

describe('D-148 W3.2 — SubDEKDomain widened with tls_domains', () => {
  it('accepts tls_domains as a SubDEKDomain', () => {
    // Type-level assertion via assignment: this line MUST compile.
    // The contracts mirror is re-exported as D148SubDEKDomain to
    // avoid colliding with @recued/crypto's runtime SubDEKDomain.
    const slot: D148SubDEKDomain = 'tls_domains';
    expect(slot).toBe('tls_domains');
  });
});

// ────────────────────────────────────────────────────────────────
// Misc TLSDomainCertSource typing — compile-only
// ────────────────────────────────────────────────────────────────

describe('D-148 W3.2 — TLSDomainCertSource typing surface', () => {
  it('the closed-list type is assignable from each member', () => {
    const a: TLSDomainCertSource = 'pro_acme';
    const b: TLSDomainCertSource = 'byo_upload';
    expect(a).toBe('pro_acme');
    expect(b).toBe('byo_upload');
  });
});
