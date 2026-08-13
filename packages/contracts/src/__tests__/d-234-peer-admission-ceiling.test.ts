/** D-234 § 234.1 — the receiver's ceiling.
 *
 *  The sender's half (`callback_op`) is already on the wire; this is the other
 *  side of the floor/ceiling. Pure resolution only — the wiring proof lives in
 *  the semi-live test, because a resolver tested alone says nothing about
 *  whether anything calls it.
 */
import { describe, expect, it } from 'vitest';
import {
  EXCHANGE_ADMISSION_WILDCARD,
  resolveExchangeAdmission,
} from '../connection.js';

const RECIPE = 'peer-apply-project-update';

describe('D-234 § 234.1 — the receiver decides whether it will answer', () => {
  it('⚠ absent config is `auto_accept` — fail-OPEN, and that is the point', () => {
    /** ⛔ THE ONE FENCE IN THIS FEATURE THAT MUST NOT FAIL CLOSED. This gate
     *  runs on a peer the owner ALREADY admitted through a contract, a grant and
     *  an installed recipe. Defaulting to refuse would silently break every
     *  exchange working today — D-232's own two-server drive included — the
     *  moment it shipped. The fences that fail closed are upstream, where
     *  admission is actually decided. */
    expect(resolveExchangeAdmission(undefined, RECIPE)).toBe('auto_accept');
    expect(resolveExchangeAdmission(null, RECIPE)).toBe('auto_accept');
    expect(resolveExchangeAdmission({}, RECIPE)).toBe('auto_accept');
  });

  it('✅ refuses exactly what the owner named', () => {
    expect(resolveExchangeAdmission({ [RECIPE]: 'refuse' }, RECIPE)).toBe('refuse');
  });

  it('✅✅ MOST SPECIFIC WINS — a per-recipe entry overrides the peer-wide default', () => {
    /** ⛔⛔ GRANULARITY IS THE PROTECTIVE HALF, NOT A CONVENIENCE. The sender's
     *  floor is peer-supplied — they can always claim to be waiting by sending
     *  `callback_op`. That is harmless ONLY because the ceiling answers
     *  per-recipe. A single global "willing" would let a peer set it on
     *  everything and turn the owner's attention into their queue. */
    const config = { [EXCHANGE_ADMISSION_WILDCARD]: 'refuse', [RECIPE]: 'auto_accept' };
    expect(resolveExchangeAdmission(config, RECIPE)).toBe('auto_accept');
    expect(resolveExchangeAdmission(config, 'some-other-recipe')).toBe('refuse');
  });

  it('✅ the wildcard alone sets a peer-wide default', () => {
    expect(resolveExchangeAdmission({ [EXCHANGE_ADMISSION_WILDCARD]: 'refuse' }, RECIPE))
      .toBe('refuse');
  });

  it("✅ 'ask' is a real state — per-message judgment, never learned", () => {
    /** The owner answers once, against the CONTENT of one message
     *  (`peerAdmissionIdentity`), and the approval is consumed on use. Promoting
     *  it to `auto_accept` for the peer would be learning the answer, which is
     *  the exact thing an entry ask gates. */
    expect(resolveExchangeAdmission({ [RECIPE]: 'ask' }, RECIPE)).toBe('ask');
    expect(resolveExchangeAdmission({ '*': 'ask' }, RECIPE)).toBe('ask');
  });

  it('⛔ an UNKNOWN value degrades to `auto_accept`, never to a refusal', () => {
    /** A config written against a future version must land somewhere
     *  predictable, and "silently refuse a peer" is not it — that would be a
     *  denial nobody chose, indistinguishable at the far side from a fault. */
    expect(resolveExchangeAdmission({ [RECIPE]: 'nonsense' }, RECIPE)).toBe('auto_accept');
    expect(resolveExchangeAdmission({ [RECIPE]: 'ASK' }, RECIPE)).toBe('auto_accept');
  });

  it('⛔ a non-object declaration cannot refuse anyone', () => {
    // A malformed record says nothing about willingness; it must not become the
    // place a peer starts getting turned away.
    for (const bad of ['refuse', 42, true, ['refuse']]) {
      expect(resolveExchangeAdmission(bad, RECIPE), JSON.stringify(bad)).toBe('auto_accept');
    }
  });
});
