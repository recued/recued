/** The server's trust anchor for `proent.v1` claims.
 *
 *  `resolveProEntitlementPublicKey` ships the auth-Worker's signing PUBLIC half
 *  as a constant, because `resolveClaim` returns null when it has no key and
 *  that fails closed SILENTLY (entitlement `unavailable` → no reserve, no DDNS,
 *  no ACME, no error). A constant that is merely PRESENT is not enough — a
 *  truncated or mangled paste would ship exactly that silent failure. So the
 *  load-bearing assertions here are that each constant is a genuinely importable
 *  Ed25519 SPKI key and that the two environments' keys are distinct.
 *
 *  What this file CANNOT check is that a constant matches the secret currently
 *  deployed to its Worker (the private half is not in the repo). That pairing is
 *  proven live by `backend/server/src/dev/pro-entitlement-live-check.ts`, which
 *  binds a real server and verifies a real minted claim against the constant.
 */

import { describe, expect, it } from 'vitest';
import { createPublicKey } from 'node:crypto';

import { resolveProEntitlementPublicKey } from '../pro-convenience/entitlement-source.js';

const PROD_CLOUD = 'https://api.recued.com';
const STAGING_CLOUD = 'https://api.recued2.com';

/** Import the base64 SPKI DER exactly as `verifyClaimEnvelope` would need to.
 *  Throws on anything that is not a real Ed25519 public key. */
const importSpki = (b64: string) =>
  createPublicKey({
    key: Buffer.from(b64, 'base64'),
    format: 'der',
    type: 'spki',
  });

describe('resolveProEntitlementPublicKey', () => {
  it('never resolves empty — a missing key fails closed silently', () => {
    for (const cloudBaseUrl of [PROD_CLOUD, STAGING_CLOUD, undefined]) {
      expect(resolveProEntitlementPublicKey({ cloudBaseUrl })).toBeTruthy();
    }
  });

  it('both constants are importable Ed25519 SPKI keys, not just non-empty strings', () => {
    for (const cloudBaseUrl of [PROD_CLOUD, STAGING_CLOUD]) {
      const key = importSpki(resolveProEntitlementPublicKey({ cloudBaseUrl }));
      expect(key.asymmetricKeyType).toBe('ed25519');
    }
  });

  it('selects per environment, and the two keys are distinct', () => {
    const prod = resolveProEntitlementPublicKey({ cloudBaseUrl: PROD_CLOUD });
    const staging = resolveProEntitlementPublicKey({ cloudBaseUrl: STAGING_CLOUD });
    expect(staging).not.toBe(prod);
  });

  it('defaults to production for an unknown / absent cloud host', () => {
    const prod = resolveProEntitlementPublicKey({ cloudBaseUrl: PROD_CLOUD });
    expect(resolveProEntitlementPublicKey({})).toBe(prod);
    expect(resolveProEntitlementPublicKey({ cloudBaseUrl: 'https://example.invalid' })).toBe(prod);
    expect(resolveProEntitlementPublicKey({ cloudBaseUrl: 'not a url' })).toBe(prod);
  });

  it('switches on the recued2 host the same way the mint URL does', () => {
    const staging = resolveProEntitlementPublicKey({ cloudBaseUrl: STAGING_CLOUD });
    // Any *.recued2.com cloud host, not just the api subdomain — the key a
    // server verifies with must always belong to the Worker it minted from.
    expect(resolveProEntitlementPublicKey({ cloudBaseUrl: 'https://cloud.recued2.com' })).toBe(staging);
  });

  it('an explicit override wins, so a private deployment can point at its own signer', () => {
    const other = resolveProEntitlementPublicKey({ cloudBaseUrl: STAGING_CLOUD });
    expect(
      resolveProEntitlementPublicKey({ override: other, cloudBaseUrl: PROD_CLOUD }),
    ).toBe(other);
  });

  it('a blank / whitespace override is ignored rather than resolving to empty', () => {
    const prod = resolveProEntitlementPublicKey({ cloudBaseUrl: PROD_CLOUD });
    expect(resolveProEntitlementPublicKey({ override: '', cloudBaseUrl: PROD_CLOUD })).toBe(prod);
    expect(resolveProEntitlementPublicKey({ override: '   ', cloudBaseUrl: PROD_CLOUD })).toBe(prod);
  });
});
