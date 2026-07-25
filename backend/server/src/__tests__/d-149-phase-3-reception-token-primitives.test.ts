/** D-149 P3 § A.18 + § A.16 — token + IP-hash primitive ratchets.
 *
 *  Acceptance per spec § A.18 / § A.16 / § Must Hold I-10:
 *
 *    - Bearer secret = 32-byte CSPRNG output ⇒ 256 bits of entropy.
 *    - Endpoint_id = 16-byte CSPRNG output ⇒ 128 bits of entropy.
 *    - HMAC-SHA256 storage; constant-time verify.
 *    - Source-IP hash endpoint-scoped by default — same IP at different
 *      endpoints produces different hashes.
 *    - Server-wide hash + per-endpoint hash diverge by construction.
 *    - Pepper derivation is deterministic from a master DEK.
 */

import { describe, expect, it } from 'vitest';
import {
  RECEPTION_PEPPER_BYTE_LENGTH,
  computeBearerHmac,
  deriveReceptionPepper,
  hashSourceIpEndpointScoped,
  hashSourceIpServerWide,
} from '../ports/reception/server-secret-pepper.js';
import {
  BEARER_SECRET_BYTE_LENGTH,
  ENDPOINT_ID_BYTE_LENGTH,
  buildShareUrl,
  generateBearerSecret,
  generateEndpointId,
  verifyBearerSecret,
} from '../ports/reception/token-primitives.js';

const TEST_MASTER_DEK = Buffer.alloc(32, 0xAA);

describe('D-149 P3 § A.18.1 — bearer_secret generation', () => {
  it('generates a 256-bit secret (43-char base64url after padding strip)', () => {
    const secret = generateBearerSecret();
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThanOrEqual(43);
    // base64url-decodes to BEARER_SECRET_BYTE_LENGTH bytes.
    const decoded = Buffer.from(secret, 'base64url');
    expect(decoded.length).toBe(BEARER_SECRET_BYTE_LENGTH);
  });

  it('two consecutive generators produce different secrets', () => {
    const a = generateBearerSecret();
    const b = generateBearerSecret();
    expect(a).not.toBe(b);
  });
});

describe('D-149 P3 § A.18.1 — endpoint_id generation', () => {
  it('generates a 128-bit opaque uuid (22-char base64url)', () => {
    const id = generateEndpointId();
    expect(typeof id).toBe('string');
    const decoded = Buffer.from(id, 'base64url');
    expect(decoded.length).toBe(ENDPOINT_ID_BYTE_LENGTH);
  });
});

describe('D-149 P3 § A.18.2 — HMAC-keyed bearer storage + constant-time verify', () => {
  const pepper = deriveReceptionPepper(TEST_MASTER_DEK);
  it('computeBearerHmac returns a 32-byte HMAC-SHA256', () => {
    const hmac = computeBearerHmac('hello-world', pepper);
    expect(hmac.length).toBe(32);
  });

  it('verifyBearerSecret accepts the correct bearer', () => {
    const secret = generateBearerSecret();
    const hmac = computeBearerHmac(secret, pepper);
    const ok = verifyBearerSecret({ submitted_secret: secret, stored_hmac: hmac, pepper });
    expect(ok).toBe(true);
  });

  it('verifyBearerSecret rejects a wrong bearer (Must Hold I-10)', () => {
    const secret = generateBearerSecret();
    const hmac = computeBearerHmac(secret, pepper);
    const ok = verifyBearerSecret({
      submitted_secret: 'wrong-secret',
      stored_hmac: hmac,
      pepper,
    });
    expect(ok).toBe(false);
  });

  it('verifyBearerSecret rejects empty / malformed input rather than throwing', () => {
    const pepper2 = deriveReceptionPepper(TEST_MASTER_DEK);
    expect(verifyBearerSecret({ submitted_secret: '', stored_hmac: Buffer.alloc(32), pepper: pepper2 })).toBe(false);
    expect(
      verifyBearerSecret({
        submitted_secret: 'x',
        stored_hmac: Buffer.alloc(31),
        pepper: pepper2,
      }),
    ).toBe(false);
  });
});

describe('D-149 P3 § A.16.1 — source-IP hash discipline', () => {
  const pepper = deriveReceptionPepper(TEST_MASTER_DEK);

  it('endpoint-scoped hash is deterministic per (ip, endpoint_id, pepper)', () => {
    const h1 = hashSourceIpEndpointScoped('203.0.113.5', 'endpoint-A', pepper);
    const h2 = hashSourceIpEndpointScoped('203.0.113.5', 'endpoint-A', pepper);
    expect(h1).toBe(h2);
  });

  it('same visitor at different endpoints produces different hashes (I-9)', () => {
    const hA = hashSourceIpEndpointScoped('203.0.113.5', 'endpoint-A', pepper);
    const hB = hashSourceIpEndpointScoped('203.0.113.5', 'endpoint-B', pepper);
    expect(hA).not.toBe(hB);
  });

  it('server-wide hash diverges from endpoint-scoped (I-9)', () => {
    const hScoped = hashSourceIpEndpointScoped('203.0.113.5', 'endpoint-A', pepper);
    const hWide = hashSourceIpServerWide('203.0.113.5', pepper);
    expect(hScoped).not.toBe(hWide);
  });

  it('server-wide hash is deterministic per (ip, pepper)', () => {
    const h1 = hashSourceIpServerWide('203.0.113.5', pepper);
    const h2 = hashSourceIpServerWide('203.0.113.5', pepper);
    expect(h1).toBe(h2);
  });

  it('pepper rotation flips every hash (I-8 rotation)', () => {
    const pepper2 = deriveReceptionPepper(Buffer.alloc(32, 0x55));
    expect(hashSourceIpEndpointScoped('203.0.113.5', 'endpoint-A', pepper2)).not.toBe(
      hashSourceIpEndpointScoped('203.0.113.5', 'endpoint-A', pepper),
    );
  });
});

describe('D-149 P3 § A.16.2 — pepper derivation', () => {
  it('pepper is 32 bytes', () => {
    const pepper = deriveReceptionPepper(TEST_MASTER_DEK);
    expect(pepper.length).toBe(RECEPTION_PEPPER_BYTE_LENGTH);
  });

  it('same master_dek → same pepper (deterministic)', () => {
    const a = deriveReceptionPepper(TEST_MASTER_DEK);
    const b = deriveReceptionPepper(TEST_MASTER_DEK);
    expect(a.equals(b)).toBe(true);
  });

  it('different master_deks → different peppers', () => {
    const a = deriveReceptionPepper(TEST_MASTER_DEK);
    const b = deriveReceptionPepper(Buffer.alloc(32, 0x55));
    expect(a.equals(b)).toBe(false);
  });

  it('non-32-byte master_dek throws', () => {
    expect(() => deriveReceptionPepper(Buffer.alloc(16))).toThrow();
  });
});

describe('D-149 P3 § A.18.1 — share URL builder per kind', () => {
  it('scheduling_link URL carries ?t=<bearer>', () => {
    const url = buildShareUrl({
      base_url: 'https://alice.recued.cloud',
      kind: 'scheduling_link',
      endpoint_id: 'abc123',
      bearer_secret: 'secret-xyz',
    });
    expect(url).toContain('/reception/scheduling/abc123');
    expect(url).toContain('?t=secret-xyz');
  });

  it('Codex P8 P1 fold — approval_link URL carries ?t=<bearer> like other link-style kinds', () => {
    // Pre-fold: spec § A.18.3 line 1465 + § A.5.5 envision a second
    // `single_use_secret` paste-in-form pattern layered on top of the
    // bearer. Without that substrate-side column the bearer in the URL
    // is the ONLY auth gate; omitting `?t=` from the URL meant the
    // dispatcher 401'd every share-URL visitor before the GET render
    // could fire. Until the substrate gains a separate single_use_secret
    // column, approval_link follows the same bearer-in-URL pattern as
    // drop / intake / scheduling / status; the soft-trust envelope is
    // preserved by the single-use `consumed_at` flip + require_email_match.
    const url = buildShareUrl({
      base_url: 'https://alice.recued.cloud',
      kind: 'approval_link',
      endpoint_id: 'abc123',
      bearer_secret: 'secret-xyz',
    });
    expect(url).toContain('/reception/approve/abc123');
    expect(url).toContain('?t=secret-xyz');
  });

  it('reception_page URL is the bare /reception/ singleton path', () => {
    const url = buildShareUrl({
      base_url: 'https://alice.recued.cloud',
      kind: 'reception_page',
      endpoint_id: 'unused',
      bearer_secret: 'secret-xyz',
    });
    expect(url).toContain('/reception/?');
    expect(url).toContain('secret-xyz');
  });
});
