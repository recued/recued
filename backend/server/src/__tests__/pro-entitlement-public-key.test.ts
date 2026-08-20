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
const STAGING_CLOUD = 'https://api.mirror.example';

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

  it('ships exactly ONE trust anchor — a mirror supplies its own', () => {
    // Was "the two keys are distinct". There is no second key in source now:
    // a mirror's signer is `RECUED_PRO_ENTITLEMENT_PUBLIC_KEY_B64`, so the
    // operator's environment identity is not embedded in what self-hosters read.
    const prod = resolveProEntitlementPublicKey({});
    expect(prod).toMatch(/^MCowBQYDK2Vw/); // Ed25519 SPKI DER, base64
    expect(resolveProEntitlementPublicKey({ override: 'OTHER' })).toBe('OTHER');
  });

  it('defaults to production for an unknown / absent cloud host', () => {
    const prod = resolveProEntitlementPublicKey({ cloudBaseUrl: PROD_CLOUD });
    expect(resolveProEntitlementPublicKey({})).toBe(prod);
    expect(resolveProEntitlementPublicKey({ cloudBaseUrl: 'https://example.invalid' })).toBe(prod);
    expect(resolveProEntitlementPublicKey({ cloudBaseUrl: 'not a url' })).toBe(prod);
  });

  it('⛔⛔ a configured apex with NO key override REFUSES rather than mis-verifying', () => {
    // The apex and the trust anchor are one decision. A mirror mints from its
    // own Worker but would verify with the prod key, so every claim fails —
    // closed, but silently and a long way from the cause. There used to be a
    // second hardcoded key kept in step by a host sniff; with both now
    // configuration, the pairing is enforced instead of assumed.
    expect(() => resolveProEntitlementPublicKey({ cloudApex: 'mirror.example' })).toThrow(
      /RECUED_PRO_ENTITLEMENT_PUBLIC_KEY_B64/,
    );
    // …and supplying the pair is fine.
    expect(
      resolveProEntitlementPublicKey({ cloudApex: 'mirror.example', override: 'KEY' }),
    ).toBe('KEY');
  });

  it('the cloud host no longer selects a key — only the apex + override do', () => {
    const prod = resolveProEntitlementPublicKey({});
    expect(resolveProEntitlementPublicKey({ cloudBaseUrl: 'https://cloud.mirror.example' })).toBe(prod);
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
