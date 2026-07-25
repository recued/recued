/** D-207 slice 1c — the `preflight_admitted` bypass, and why removing it is the fix.
 *
 *  THE CHAIN. `preflight_admitted` is the RESUME marker: the gateway converts an `'ask'`
 *  verdict to ADMIT when it is set and the approved target names the same slug
 *  (commit-gateway: "an 'ask' verdict is admitted: the upstream approval is the
 *  authoritative signal for THIS gate's call"). `runGatedCatalogOperation` SYNTHESIZES the
 *  matching `preflight_approved_target` from the request, so the guard always matched.
 *
 *  D-200's Stripe provider passed it unconditionally on the create, for an ANONYMOUS
 *  public dispatch. Net effect: a stranger's `checkout.session.create` was admitted past
 *  the ask — and that also DEFEATED slice 1a. 1a pins an anonymous actor to the contracted
 *  `read` ceiling so a write ASKS; this flag re-admitted it on the one live path that
 *  actually constructs an anonymous source.
 *
 *  These pin the two halves so the bypass cannot come back:
 *    1. the source's admission verdict is `ask` (1a working), and
 *    2. the provider no longer carries the flag that would convert it to admit. */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { admitByOpRisk, resolveTrustCeiling } from '@recued/contracts';
import type { ExecutionSource, RiskTier } from '@recued/contracts';

/** The exact source `paid-document-direct-checkout-stripe-provider.ts` constructs. */
const ANON_RECEPTION: ExecutionSource = {
  channel: 'reception',
  actor: 'anonymous',
  reception_id: 'sub_1',
};

describe('D-207 slice 1c — an anonymous Stripe create must SURFACE, not fire silently', () => {
  it('the verdict for the create is ASK — slice 1a holds', () => {
    // `checkout.session.create` is an external-io WRITE.
    const decision = admitByOpRisk({
      slug: 'stripe',
      risk_tier: 'write' satisfies RiskTier,
      ceiling: resolveTrustCeiling(ANON_RECEPTION),
      source: ANON_RECEPTION,
    });
    expect(decision.verdict).toBe('ask');
  });

  it('the provider that carried the bypass no longer exists at all', () => {
    // A source-level pin, deliberately. The bypass was one word in D-200's Stripe
    // provider; slice 1c removed the word, and 3d·6 deleted the provider (and the
    // coordinator that would have consumed it) outright. Pin the ABSENCE of the
    // file: the bypass cannot come back on a path that no longer exists.
    expect(existsSync(
      'backend/server/src/paid-document-direct-checkout-stripe-provider.ts',
    )).toBe(false);
    expect(existsSync(
      'backend/server/src/paid-document-direct-checkout-provider-coordinator.ts',
    )).toBe(false);
  });

  it('the ONLY way past that ask is an owner-minted grant, never a code flag', () => {
    // Documented as an executable expectation: an anonymous write is never `admit` at the
    // op-risk layer, whatever the caller believes it pre-approved by binding a pair.
    for (const tier of ['write', 'admin'] satisfies RiskTier[]) {
      const d = admitByOpRisk({
        slug: 'stripe',
        risk_tier: tier,
        ceiling: resolveTrustCeiling(ANON_RECEPTION),
        source: ANON_RECEPTION,
      });
      expect(d.verdict).not.toBe('admit');
    }
  });
});
