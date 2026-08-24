/** The owner's two levers against the unattended hold, at the RESOLVER level.
 *
 *  ⚠⚠ THIS IS THE SECOND FILE ON THIS FACT, AND NOT THE PRIMARY ONE. The finding
 *  — that `owner_override.risk` clears an unattended hold where `approval` cannot —
 *  was already retracted, driven and committed as `539e8b1d0`, whose live proof is
 *  `backend/server/src/__tests__/fleet-money-owner-override-drive.test.ts`: the real
 *  pack, the real `(reactive, system)` channel, one variable, plus the rpc's refusal
 *  of a downgrade without `confirm_risk_downgrade`. **Read that one first — it proves
 *  the behaviour end to end; this one only pins the algebra underneath it.**
 *
 *  ⛔⛔⛔ AND THE REASON THAT MATTERS IS NOT TIDINESS. I re-derived all of it a day
 *  later without checking whether it had already landed, and `539e8b1d0` was already
 *  an ancestor of my commit. Its message names the exact trap I then fell into —
 *  *"check which resolver a probe exercises before quoting it"* — and records that it
 *  had ALREADY been repeated once on this same question. I made it the third time.
 *  ⇒ **Before writing up a correction, `git log --grep` the claim you are retracting.**
 *
 *  WHAT THIS FILE ADDS, and the only reason it survives the reconciliation:
 *    - the resolver matrix as ASSERTIONS. `539e8b1d0` carries it in its commit
 *      message as evidence, which no run re-checks.
 *    - ⚠ `risk: 'admin'` is NOT enough — still above the `read` ceiling, still holds,
 *      and nothing says why. "Lower the risk" is the wrong instruction; "below the
 *      ceiling" is the right one.
 *    - ⛔ an INVALID tier is dropped and the op keeps its own.
 *
 *  🔑 WHY THE TWO LEVERS DIFFER (the reusable part): `approval` is CLAMPED —
 *  `stricterApproval(declared, approvalFloorForRisk(risk))` raises `never` back to
 *  `ask`, so it argues with the floor and loses. `risk` is REPLACED — taken verbatim,
 *  which is what D-211 intends: *"Pack authors declare {risk_tier, approval?} on each
 *  operation. The owner may replace either value."* Moving the TIER moves the floor
 *  with it. ⇒ Re-tier below the ceiling; do not argue with the approval.
 *
 *  ⚠ `risk_tier` is a CONSEQUENCE CLASS the owner may legitimately restate, not a
 *  did-it-write fact — which is why the audit exemption is keyed on neither
 *  (`audit-exemption.ts`). The two answer different questions.
 */
import { describe, expect, it } from 'vitest';

import { resolveCatalogOperationPolicy } from '../ingredient-catalog.js';

/** A pack write op as `fleet-money` ships it: `job.update`, write-tier. */
const operations = {
  'job.update': {
    operation_id: 'job.update', risk_tier: 'write', approval: 'never',
    groups: ['fleet.write'],
  },
} as never;

/** The `(reactive, system)` cell: contract-free + unattended ⇒ the LOW `read`
 *  ceiling `resolveTrustCeiling` fails closed to. This is the posture a worker's
 *  emailed reply arrives under. */
const underUnattendedCeiling = (owner_override?: Record<string, unknown>) =>
  resolveCatalogOperationPolicy({
    operations,
    operation_id: 'job.update',
    // ⚠ NOT `null` — the wrapper derives its `source` from this, and a null
    // profile denies with `no_connection_profile` before any policy runs, which
    // reads exactly like a refusal and is not one.
    profile: { allowed_operations: ['job.update'] },
    ceiling: 'read',
    ...(owner_override ? { owner_override } : {}),
  } as never) as {
    verdict?: string; approval?: string; effective_risk_tier?: string;
  };

const shape = (o: ReturnType<typeof underUnattendedCeiling>) =>
  `${String(o.verdict)}/${String(o.approval)}/${String(o.effective_risk_tier)}`;

describe('the unattended hold, and the owner levers against it', () => {
  it('as shipped, an unattended pack write HOLDS', () => {
    expect(shape(underUnattendedCeiling())).toBe('ask/ask/write');
  });

  it('⛔ the APPROVAL lever does NOT help — the risk floor clamps it back to `ask`', () => {
    // The measurement `queue-desk-setup.md` made, and it is correct.
    expect(shape(underUnattendedCeiling({ approval: 'never' }))).toBe('ask/ask/write');
  });

  it('🔑 the RISK lever DOES — the owner re-tiers the op and it admits', () => {
    // The measurement that file missed. Not a loophole: D-211 gives the owner
    // this lever on their own data deliberately.
    expect(shape(underUnattendedCeiling({ risk: 'read' }))).toBe('admit/never/read');
  });

  it('…and the two together behave as the risk lever alone — the tier is what moved', () => {
    expect(shape(underUnattendedCeiling({ risk: 'read', approval: 'never' })))
      .toBe('admit/never/read');
  });

  it('⚠ a PARTIAL re-tier still holds — `admin` is above the `read` ceiling', () => {
    // Guards the obvious mistake: "lower the risk" is not enough, it has to go
    // BELOW the ceiling. An owner who picks `admin` gets no relief and no signal.
    expect(shape(underUnattendedCeiling({ risk: 'admin' }))).toBe('ask/ask/admin');
  });

  it('⛔ an INVALID override is dropped, never trusted — the op keeps its own tier', () => {
    // `ingredient-catalog.ts`: "Invalid hand-stored values are dropped so they
    // cannot weaken the pack operation."
    expect(shape(underUnattendedCeiling({ risk: 'not_a_tier' }))).toBe('ask/ask/write');
  });
});
