/** D-214 §4–§10 contract shapes.
 *
 *  A types-only module has exactly two things a test can hold: the closed
 *  vocabularies (which rot by SUBSET — a copied list that dropped a member
 *  typechecks fine) and the invariants the doc comments assert but the compiler
 *  cannot. Both are covered here; nothing else in this file is worth a test.
 */

import { describe, expect, it } from 'vitest';
import {
  EXECUTION_CASE_MIN_CALLS_NEGATIVE,
  EXECUTION_CASE_MIN_CALLS_POSITIVE,
  EXECUTION_CASE_RECURRENCE_FLOOR,
  EXECUTION_CASE_CARD_NOTICE,
  EXECUTION_CASE_FEEDBACK_KINDS,
  CASE_INTERVENTION_ASSIGNMENTS,
  CASE_INTERVENTION_ROLES,
  FLOW_BASES,
  OUTCOME_AUTHORIZATIONS,
  OUTCOME_AUTHORIZATION_SEVERITY,
  OUTCOME_CLAIMS,
  OUTCOME_EXECUTIONS,
  OUTCOME_FEEDBACKS,
  OUTCOME_VERIFICATIONS,
  REQUEST_ROUTES,
  RUNTIME_COMPOSITION_ROUTE_KINDS,
  STEP_APPROVAL_BOUNDARIES,
  STEP_DISPOSITIONS,
  STEP_VERIFICATION_BOUNDARIES,
  SUPERSEDED_REASONS,
  isFlowBasis,
  isExecutionCaseFeedbackKind,
  isCaseInterventionAssignment,
  isCaseInterventionRole,
  isOutcomeAuthorization,
  isOutcomeClaim,
  isOutcomeExecution,
  isOutcomeFeedback,
  isOutcomeVerification,
  isRequestRoute,
  isRuntimeCompositionRouteKind,
  isStepApprovalBoundary,
  isStepDisposition,
  isStepVerificationBoundary,
  isSupersededReason,
} from '../execution-case.js';
import { isReservedLocalRpc } from '../mcp-tool-catalog.js';

/** Every closed vocabulary paired with its guard. Adding a vocabulary without
 *  adding it here is the failure this table exists to make noisy. */
const VOCABULARIES: ReadonlyArray<{
  name: string;
  values: ReadonlyArray<string>;
  guard: (value: unknown) => boolean;
}> = [
  { name: 'OutcomeClaim', values: OUTCOME_CLAIMS, guard: isOutcomeClaim },
  { name: 'RequestRoute', values: REQUEST_ROUTES, guard: isRequestRoute },
  {
    name: 'StepDisposition',
    values: STEP_DISPOSITIONS,
    guard: isStepDisposition,
  },
  {
    name: 'StepApprovalBoundary',
    values: STEP_APPROVAL_BOUNDARIES,
    guard: isStepApprovalBoundary,
  },
  {
    name: 'StepVerificationBoundary',
    values: STEP_VERIFICATION_BOUNDARIES,
    guard: isStepVerificationBoundary,
  },
  { name: 'FlowBasis', values: FLOW_BASES, guard: isFlowBasis },
  {
    name: 'OutcomeAuthorization',
    values: OUTCOME_AUTHORIZATIONS,
    guard: isOutcomeAuthorization,
  },
  {
    name: 'OutcomeExecution',
    values: OUTCOME_EXECUTIONS,
    guard: isOutcomeExecution,
  },
  {
    name: 'OutcomeVerification',
    values: OUTCOME_VERIFICATIONS,
    guard: isOutcomeVerification,
  },
  {
    name: 'OutcomeFeedback',
    values: OUTCOME_FEEDBACKS,
    guard: isOutcomeFeedback,
  },
  {
    name: 'SupersededReason',
    values: SUPERSEDED_REASONS,
    guard: isSupersededReason,
  },
  {
    name: 'ExecutionCaseFeedbackKind',
    values: EXECUTION_CASE_FEEDBACK_KINDS,
    guard: isExecutionCaseFeedbackKind,
  },
  {
    name: 'CaseInterventionRole',
    values: CASE_INTERVENTION_ROLES,
    guard: isCaseInterventionRole,
  },
  {
    name: 'CaseInterventionAssignment',
    values: CASE_INTERVENTION_ASSIGNMENTS,
    guard: isCaseInterventionAssignment,
  },
  {
    name: 'RuntimeCompositionRouteKind',
    values: RUNTIME_COMPOSITION_ROUTE_KINDS,
    guard: isRuntimeCompositionRouteKind,
  },
];

describe('D-214 closed vocabularies', () => {
  it.each(VOCABULARIES)('$name — guard admits every member', ({ values, guard }) => {
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(guard(value)).toBe(true);
  });

  it.each(VOCABULARIES)('$name — guard rejects non-members', ({ guard }) => {
    for (const value of ['', 'nope', 'Allowed', 0, 1, null, undefined, {}, []]) {
      expect(guard(value)).toBe(false);
    }
  });

  it.each(VOCABULARIES)('$name — no duplicate members', ({ values }) => {
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('D-214 §7 authorization severity ordering', () => {
  /** ⛔ The one that matters. `OUTCOME_AUTHORIZATION_SEVERITY` is a hand-ordered
   *  copy of the same union, so a member dropped from it still TYPECHECKS —
   *  the array is assignable either way. A missing member would silently lose
   *  that verdict in §7's strongest-negative-wins fold, which is a
   *  deterministic part of the contract (§8.3), not a helper's private detail. */
  it('ranks exactly the OutcomeAuthorization members — no member may be dropped', () => {
    expect([...OUTCOME_AUTHORIZATION_SEVERITY].sort()).toEqual(
      [...OUTCOME_AUTHORIZATIONS].sort(),
    );
    expect(OUTCOME_AUTHORIZATION_SEVERITY.length).toBe(
      OUTCOME_AUTHORIZATIONS.length,
    );
  });

  it('orders strongest-negative first, per the §7 fold table', () => {
    expect([...OUTCOME_AUTHORIZATION_SEVERITY]).toEqual([
      'denied',
      'expired',
      'dismissed',
      'allowed',
      'not_required',
    ]);
  });
});

describe('D-214 admission constants', () => {
  /** B.1 — the third consistent use of the project's established floor. Pinned
   *  because the spec forbids re-deriving it, not because 3 is magic. */
  it('sets the recurrence floor to the established value of 3', () => {
    expect(EXECUTION_CASE_RECURRENCE_FLOOR).toBe(3);
  });

  /** ⚠ B.12 / acceptance #49 was REVERSED by D-219 slice 7, and this ratchet
   *  did its job on the way: it was written to stop a build "tidying these to
   *  one shared constant", which is precisely what slice 7 does — deliberately,
   *  and with the old rule and reasoning preserved beside the constants rather
   *  than overwritten.
   *
   *  WAS: positives gated at 2, negatives free at 1, because "choosing the wrong
   *  single tool is exactly what users correct" and a single-call negative was
   *  "the cheapest evidence D-214 collects".
   *
   *  WHY IT NO LONGER HOLDS: slices 2–4 excluded every negative the system
   *  observed about itself, so that evidence mostly cannot occur; nine of the
   *  eleven Tier-1 primitives are retrieval, where there is no lesson; and the
   *  one real single-call lesson — which recipe to run — lives in an argument no
   *  case records. Candidacy is now uniform: a case is for a PROCEDURE worth
   *  short-circuiting, and one call is not a procedure.
   *
   *  The ratchet still ratchets — it now pins the equality, so a future split
   *  back into two floors has to be deliberate too. */
  it('requires MORE THAN ONE call in both directions', () => {
    expect(EXECUTION_CASE_MIN_CALLS_POSITIVE).toBe(2);
    expect(EXECUTION_CASE_MIN_CALLS_NEGATIVE).toBe(2);
    expect(EXECUTION_CASE_MIN_CALLS_NEGATIVE).toBe(
      EXECUTION_CASE_MIN_CALLS_POSITIVE,
    );
  });
});

describe('D-214 §9.2 card notice', () => {
  /** The sentence is the thing that keeps a card advisory rather than
   *  instructive (acceptance #13/#23). Both halves must survive an edit. */
  it('states historical-only AND not-current-permission', () => {
    expect(EXECUTION_CASE_CARD_NOTICE).toContain('Historical evidence only');
    expect(EXECUTION_CASE_CARD_NOTICE).toContain('Judge applicability');
    expect(EXECUTION_CASE_CARD_NOTICE).toContain('current permission');
    expect(EXECUTION_CASE_CARD_NOTICE).toContain('user instruction');
  });
});

describe('D-214 §6.2 flow basis', () => {
  /** A6 defined `flow_basis: "authorized"`; A14 made it unreachable, because a
   *  flow authorized but never executed forms no case at all — permission
   *  without an operational outcome is not evidence. Re-adding the member is a
   *  spec reversal, so it should break a test rather than pass review. */
  it('has no "authorized" member — A14 retired it', () => {
    expect(isFlowBasis('authorized')).toBe(false);
    expect([...FLOW_BASES]).toEqual(['proposed', 'executed']);
  });
});

describe('D-214 owner RPC channel isolation', () => {
  it('keeps feedback lifecycle and aggregate diagnostics off the MCP surface', () => {
    expect(isReservedLocalRpc('chat.execution.feedback')).toBe(true);
    expect(isReservedLocalRpc('chat.execution.feedback.retract')).toBe(true);
    expect(isReservedLocalRpc('chat.execution.diagnostics')).toBe(true);
  });
});
