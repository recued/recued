/** D-148 P1 — KEY_CAPABILITIES + invariants.
 *
 *  Encodes invariants I-4, I-5, I-6, I-7 from the Must Hold table:
 *   - I-4: encryption keys never sign; signing keys never decrypt.
 *   - I-5: TLS key never leaves server (storage discipline; tested
 *          downstream in P5/P6 where TLS termination lands).
 *   - I-6: TLS independent of identity (capability separation).
 *   - I-7: publisher independent of server identity (key class
 *          separation).
 */

import { describe, it, expect } from 'vitest';
import {
  KEY_CAPABILITIES,
  KEY_CLASSES,
  KEY_OPS,
  isKeyClass,
  isKeyOp,
  isKeyCapable,
  assertKeyCapable,
  KeyCapabilityError,
  HIGH_ASSURANCE_AUDIT_KINDS,
  isHighAssuranceAuditKind,
} from '../keys.js';

describe('D-148 P1 + D-169 P0 Slice 2B — KEY_CAPABILITIES taxonomy', () => {
  it('KEY_CLASSES enumerates exactly 7 classes (D-169 P0 Slice 2B retired `bridge_token`)', () => {
    expect(KEY_CLASSES.length).toBe(7);
    expect(new Set(KEY_CLASSES).size).toBe(7);
    expect((KEY_CLASSES as ReadonlyArray<string>).includes('bridge_token')).toBe(false);
  });

  it('KEY_OPS enumerates exactly 5 ops', () => {
    expect(KEY_OPS.length).toBe(5);
    expect(new Set(KEY_OPS).size).toBe(5);
  });

  it('KEY_CAPABILITIES has an entry per key class', () => {
    for (const cls of KEY_CLASSES) {
      expect(KEY_CAPABILITIES[cls]).toBeDefined();
      expect(KEY_CAPABILITIES[cls].length).toBeGreaterThan(0);
    }
  });

  it('I-4: encryption keys never declare sign capability', () => {
    expect(KEY_CAPABILITIES.master_dek).not.toContain('sign');
    expect(KEY_CAPABILITIES.sub_dek).not.toContain('sign');
  });

  it('I-4: signing keys never declare decrypt capability', () => {
    expect(KEY_CAPABILITIES.server_identity_key).not.toContain('decrypt');
    expect(KEY_CAPABILITIES.publisher_identity_key).not.toContain('decrypt');
  });

  it('I-4: no class declares both sign and decrypt', () => {
    for (const cls of KEY_CLASSES) {
      const caps = KEY_CAPABILITIES[cls];
      const hasSign = caps.includes('sign');
      const hasDecrypt = caps.includes('decrypt');
      expect(hasSign && hasDecrypt).toBe(false);
    }
  });

  it('master_dek + sub_dek decrypt-only', () => {
    expect(KEY_CAPABILITIES.master_dek).toEqual(['decrypt']);
    expect(KEY_CAPABILITIES.sub_dek).toEqual(['decrypt']);
  });

  it('server_identity_key + publisher_identity_key sign-only', () => {
    expect(KEY_CAPABILITIES.server_identity_key).toEqual(['sign']);
    expect(KEY_CAPABILITIES.publisher_identity_key).toEqual(['sign']);
  });

  it('tls_private_key is tls_internal-only', () => {
    expect(KEY_CAPABILITIES.tls_private_key).toEqual(['tls_internal']);
  });

  it('webclient_token bearer-only (D-169 P0 Slice 2B unified both paired-client kinds under this class)', () => {
    expect(KEY_CAPABILITIES.webclient_token).toEqual(['bearer']);
  });

  it('webhook_secret hmac-only', () => {
    expect(KEY_CAPABILITIES.webhook_secret).toEqual(['hmac']);
  });
});

describe('D-148 P1 — KEY_CAPABILITIES type predicates + assertions', () => {
  it('isKeyClass accepts known classes', () => {
    expect(isKeyClass('master_dek')).toBe(true);
    expect(isKeyClass('server_identity_key')).toBe(true);
  });

  it('isKeyClass rejects unknown classes', () => {
    expect(isKeyClass('master_key')).toBe(false);
    expect(isKeyClass('')).toBe(false);
    expect(isKeyClass(null)).toBe(false);
    expect(isKeyClass(42)).toBe(false);
  });

  it('isKeyOp accepts known ops', () => {
    expect(isKeyOp('decrypt')).toBe(true);
    expect(isKeyOp('sign')).toBe(true);
    expect(isKeyOp('hmac')).toBe(true);
    expect(isKeyOp('bearer')).toBe(true);
    expect(isKeyOp('tls_internal')).toBe(true);
  });

  it('isKeyOp rejects unknown ops', () => {
    expect(isKeyOp('encrypt')).toBe(false);
    expect(isKeyOp('verify')).toBe(false);
    expect(isKeyOp(undefined)).toBe(false);
  });

  it('isKeyCapable confirms allowed ops', () => {
    expect(isKeyCapable('master_dek', 'decrypt')).toBe(true);
    expect(isKeyCapable('server_identity_key', 'sign')).toBe(true);
    expect(isKeyCapable('webhook_secret', 'hmac')).toBe(true);
  });

  it('isKeyCapable rejects forbidden ops', () => {
    expect(isKeyCapable('master_dek', 'sign')).toBe(false);
    expect(isKeyCapable('server_identity_key', 'decrypt')).toBe(false);
    expect(isKeyCapable('webclient_token', 'sign')).toBe(false);
  });

  it('assertKeyCapable allows declared ops', () => {
    expect(() => assertKeyCapable('master_dek', 'decrypt')).not.toThrow();
    expect(() => assertKeyCapable('server_identity_key', 'sign')).not.toThrow();
  });

  it('assertKeyCapable throws KeyCapabilityError for forbidden ops', () => {
    expect(() => assertKeyCapable('master_dek', 'sign')).toThrow(KeyCapabilityError);
    expect(() => assertKeyCapable('server_identity_key', 'decrypt')).toThrow(KeyCapabilityError);
    expect(() => assertKeyCapable('webclient_token', 'hmac')).toThrow(KeyCapabilityError);
  });

  it('KeyCapabilityError surfaces the key class + attempted op + allowed ops', () => {
    try {
      assertKeyCapable('master_dek', 'sign');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(KeyCapabilityError);
      const e = err as KeyCapabilityError;
      expect(e.key_class).toBe('master_dek');
      expect(e.attempted_op).toBe('sign');
      expect(e.allowed_ops).toEqual(['decrypt']);
    }
  });
});

describe('D-148 P1 — HIGH_ASSURANCE_AUDIT_KINDS', () => {
  it('includes the spec § A.2.5 closed list (W3.5 amendment swaps exposure_profile_change for the path-routed kinds)', () => {
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('key_rotation')).toBe(true);
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('exposure_path_resolution_change')).toBe(true);
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('exposure_preset_apply')).toBe(true);
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('handle_change')).toBe(true);
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('pair_revoke')).toBe(true);
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('cert_renewal')).toBe(true);
  });

  it('legacy 5-profile audit kind retired', () => {
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('exposure_profile_change')).toBe(false);
  });

  it('includes hardening-pass additions', () => {
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('passport.exported')).toBe(true);
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('public_mcp_acknowledged')).toBe(true);
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('public_mcp_revoked')).toBe(true);
  });

  it('excludes pair_mint + pair_consume — D-156 P9 retired the substrate', () => {
    // The pair-blob substrate (mint + consume) went away in D-156 P9;
    // only `pair_revoke` remains in the device-credential ledger.
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('pair_mint')).toBe(false);
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('pair_consume')).toBe(false);
    expect(isHighAssuranceAuditKind('pair_mint')).toBe(false);
    expect(isHighAssuranceAuditKind('pair_consume')).toBe(false);
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('pair_revoke')).toBe(true);
  });

  it('isHighAssuranceAuditKind matches the closed list', () => {
    expect(isHighAssuranceAuditKind('key_rotation')).toBe(true);
    expect(isHighAssuranceAuditKind('handle_change')).toBe(true);
    expect(isHighAssuranceAuditKind('memory.append')).toBe(false);
    expect(isHighAssuranceAuditKind('')).toBe(false);
  });
});
