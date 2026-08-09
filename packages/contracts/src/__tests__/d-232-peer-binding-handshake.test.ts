/** D-232 § 27 — the handshake catches the one mistake enroll cannot. */
import { describe, expect, it } from 'vitest';
import { diagnosePeerBinding } from '../connection.js';

describe('D-232 § 27 — peer binding diagnosis', () => {
  it('⛔⛔ a BACKWARDS binding reports `unmatched`, and names what did call', () => {
    /** THE WHOLE POINT. Both directions are non-empty, unique, well-formed
     *  strings — nothing LOCAL distinguishes them, which is why enroll-time
     *  validation structurally cannot catch this. The peer settles it by
     *  CALLING, and the id they present is the operator's fix, so it is named
     *  rather than merely flagged. */
    const out = diagnosePeerBinding('tok_bob_minted_for_alice', ['tok_alice_minted_for_bob']);
    expect(out).toEqual({ status: 'unmatched', heard: ['tok_alice_minted_for_bob'] });
  });

  it('the right way round is `confirmed`', () => {
    expect(diagnosePeerBinding('tok_x', ['tok_x', 'tok_y'])).toEqual({ status: 'confirmed' });
  });

  it('⚠ NO CALLERS YET is `unheard`, never `unmatched`', () => {
    /** A freshly enrolled peer has not spoken. Reporting a problem there would
     *  fire on the normal case, and an alarm that cries wolf on every enrolment
     *  is one everybody mutes — which would cost us the real signal above. */
    expect(diagnosePeerBinding('tok_x', [])).toEqual({ status: 'unheard' });
  });

  it('no binding declared ⇒ no diagnosis at all', () => {
    // An ordinary mcp connection is not a peer and must not grow a verdict.
    expect(diagnosePeerBinding(undefined, ['tok_x'])).toBeUndefined();
    expect(diagnosePeerBinding('   ', ['tok_x'])).toBeUndefined();
  });

  it('caps the named callers — a busy server must not dump every contract', () => {
    const many = Array.from({ length: 12 }, (_, i) => `tok_${String(i)}`);
    const out = diagnosePeerBinding('tok_absent', many);
    expect(out?.status).toBe('unmatched');
    expect(out?.heard).toHaveLength(5);
    expect(out?.heard?.[0]).toBe('tok_0'); // newest-first order preserved
  });
});
