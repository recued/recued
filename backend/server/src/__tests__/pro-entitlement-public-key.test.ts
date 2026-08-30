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

/** ⛔⛔ THESE USED TO BE `cloudBaseUrl` ARGUMENTS, AND THAT PARAMETER DID NOTHING.
 *  Several cases here iterated base URLs and asserted the production key came back for
 *  every one — true only because the option was ignored, while reading as though the
 *  host selected the key. The option is deleted; what selects is `cloudApex` (+ the
 *  override), and these now say so. */
const PROD_APEX = 'recued.com';
const MIRROR_APEX = 'mirror.example';

/** Import the base64 SPKI DER exactly as `verifyClaimEnvelope` would need to.
 *  Throws on anything that is not a real Ed25519 public key. */
const importSpki = (b64: string) =>
  createPublicKey({
    key: Buffer.from(b64, 'base64'),
    format: 'der',
    type: 'spki',
  });

describe('resolveProEntitlementPublicKey', () => {
  it('never resolves empty for the shipped apex — a missing key fails closed silently', () => {
    for (const cloudApex of [PROD_APEX, undefined]) {
      expect(resolveProEntitlementPublicKey({ cloudApex })).toBeTruthy();
    }
  });

  it('the shipped constant is an importable Ed25519 SPKI key, not just a non-empty string', () => {
    // ⚠ ONE constant, not two — a mirror supplies its own via the override, so there is
    // no second embedded key to iterate over.
    const key = importSpki(resolveProEntitlementPublicKey({ cloudApex: PROD_APEX }));
    expect(key.asymmetricKeyType).toBe('ed25519');
  });

  it('ships exactly ONE trust anchor — a mirror supplies its own', () => {
    // Was "the two keys are distinct". There is no second key in source now:
    // a mirror's signer is `RECUED_PRO_ENTITLEMENT_PUBLIC_KEY_B64`, so the
    // operator's environment identity is not embedded in what self-hosters read.
    const prod = resolveProEntitlementPublicKey({});
    expect(prod).toMatch(/^MCowBQYDK2Vw/); // Ed25519 SPKI DER, base64
    expect(resolveProEntitlementPublicKey({ override: 'OTHER' })).toBe('OTHER');
  });

  it('an absent apex defaults to production', () => {
    // ⛔ AND AN UNKNOWN APEX DOES NOT — it refuses (next case). The old version of this
    // asserted that `example.invalid` and even `'not a url'` resolved to production,
    // which sounded like a safe default and was really the parameter being discarded.
    expect(resolveProEntitlementPublicKey({})).toBe(
      resolveProEntitlementPublicKey({ cloudApex: PROD_APEX }),
    );
  });

  it('⛔⛔ a configured apex with NO key override REFUSES rather than mis-verifying', () => {
    // The apex and the trust anchor are one decision. A mirror mints from its
    // own Worker but would verify with the prod key, so every claim fails —
    // closed, but silently and a long way from the cause. There used to be a
    // second hardcoded key kept in step by a host sniff; with both now
    // configuration, the pairing is enforced instead of assumed.
    expect(() => resolveProEntitlementPublicKey({ cloudApex: MIRROR_APEX })).toThrow(
      /RECUED_PRO_ENTITLEMENT_PUBLIC_KEY_B64/,
    );
    // …and supplying the pair is fine.
    expect(
      resolveProEntitlementPublicKey({ cloudApex: MIRROR_APEX, override: 'KEY' }),
    ).toBe('KEY');
  });

  it('⛔ PASSING A CLOUD BASE URL IS NOW A COMPILE ERROR, not a silent no-op', () => {
    // @ts-expect-error — `cloudBaseUrl` was removed precisely so this cannot compile.
    // Six call sites were passing it as though it selected the environment, including
    // both live-drive tools and the entitlement checker's own negative control.
    expect(() => resolveProEntitlementPublicKey({ cloudBaseUrl: 'https://api.mirror.example' }))
      .not.toThrow();
  });

  it('an explicit override wins, so a private deployment can point at its own signer', () => {
    const other = resolveProEntitlementPublicKey({ cloudApex: MIRROR_APEX, override: 'MIRROR_KEY' });
    expect(
      resolveProEntitlementPublicKey({ override: other, cloudApex: PROD_APEX }),
    ).toBe(other);
  });

  it('a blank / whitespace override is ignored rather than resolving to empty', () => {
    const prod = resolveProEntitlementPublicKey({ cloudApex: PROD_APEX });
    expect(resolveProEntitlementPublicKey({ override: '', cloudApex: PROD_APEX })).toBe(prod);
    expect(resolveProEntitlementPublicKey({ override: '   ', cloudApex: PROD_APEX })).toBe(prod);
  });
});
