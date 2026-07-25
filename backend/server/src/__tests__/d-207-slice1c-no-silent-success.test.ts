/** D-207 slice 1c — the silent-success-page bug.
 *
 *  THE BUG. A visitor filled in a form bound to a paired recipe, submitted, and — when the
 *  recipe could not produce what it promised — the handler fell straight through to
 *  `renderIntakeFormSuccessHtml`. They were told "thank you, we got your submission" and
 *  were NEVER ASKED TO PAY. The `catch` branch did the same, so a Stripe outage produced
 *  the identical lie. The only trace was one audit row reading `direct_checkout: 'refused'`.
 *
 *  These pin the outcomes. Exactly ONE of them may still say thank-you.
 *
 *  ⚠ D-207 slice 3c retired the `redirect` disposition entirely. The only thing that ever
 *  303'd was D-200's coordinator, and under ruling (C) the product is a `link_button`
 *  rendered INTO the page — so nothing needs one, and a recipe-produced 303 would let
 *  anonymous input steer where the owner's form sends people. */

import { describe, expect, it } from 'vitest';

// The REAL decision the handler makes — imported, not restated. A test that re-implements
// the logic it is checking proves only that the author can copy-paste.
import {
  intakeFormSubmitResponse,
  type IntakeFormPairedRunDisposition as Disposition,
} from '../ports/reception/handlers/intake-form.js';

/** D-207 slice 2c widened the decision: WHAT THE VISITOR IS TOLD now also depends
 *  on the submission's processing outcome and on whether the paired recipe
 *  renders. These slice-1c cases are all about the DISPOSITION axis, so they pin
 *  the other two at the values D-149 has always had — an accepted (`pending`)
 *  submission on a form that renders nothing — and the assertions below are
 *  unchanged by construction. Slice 2c's own axis is pinned in its own file. */
const visitorSees = (d: Disposition) => intakeFormSubmitResponse({
  disposition: d,
  processing_outcome: 'pending',
  pair_renders_response: false,
});

describe('D-207 slice 1c — a public form must never lie about what happened', () => {
  it('HELD -> success page, and that is HONEST', () => {
    // The run is parked at the D-157 gate; the submission is durable; the owner will review
    // it in the D-173 Inbox. "We got it, we'll be in touch" is TRUE.
    expect(visitorSees('held')).toEqual({ kind: 'success' });
  });

  it('REFUSED -> an ERROR page, NOT "thank you"', () => {
    // THE BUG. Pre-fix this fell through to the success page: the visitor was thanked and
    // never asked to pay, and only a coarse audit row recorded it.
    expect(visitorSees('refused')).toEqual({ kind: 'error', status: 503 });
  });

  it('UNAVAILABLE (a provider outage) -> an ERROR page, NOT "thank you"', () => {
    // The `catch` branch. A Stripe outage produced the SAME lie as a refusal.
    expect(visitorSees('unavailable')).toEqual({ kind: 'error', status: 503 });
  });

  it('an ordinary intake with NO paired recipe still succeeds — no regression', () => {
    expect(visitorSees(null)).toEqual({ kind: 'success' });
  });

  it('the ONLY outcome that may say thank-you is `held`', () => {
    const nonRedirect: Disposition[] = ['held', 'refused', 'unavailable'];
    const thanked = nonRedirect.filter((d) => visitorSees(d).kind === 'success');
    expect(thanked).toEqual(['held']);
  });
});
