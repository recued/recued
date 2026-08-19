import { describe, expect, it } from 'vitest';
import {
  EXECUTION_CASE_UNDISPATCHED_REASONS,
  isExecutionCaseGatewayDenialReason,
  isExecutionCaseUndispatchedReason,
} from '../execution-case-vocabulary.js';
import { flowActivitiesFailed } from '../execution-case-compiler.js';

/** D-219 — a call the engine REFUSED TO SEND is not a broken flow.
 *
 *  Found on bench 181: `open-rental-contract` was refused for
 *  `unit_id = "<pending from add-unit>"` (an angle placeholder the grounding gate
 *  caught), the activity recorded `status: 'error', reason: 'invalid_args'`, and
 *  the compiler's `failed` predicate turned that into `execution_failure` — which
 *  slice 3 excludes outright. So the substrate doing exactly its job destroyed
 *  the observation. */
describe('D-219 — undispatched refusals are not execution failures', () => {
  it('classifies the grounding refusal reason', () => {
    expect(isExecutionCaseUndispatchedReason('invalid_args')).toBe(true);
  });

  it('⛔ does NOT classify a reason meaning the call RAN and failed', () => {
    // The scoping guard. Widening this set to "errors we would rather ignore"
    // would silently stop filing real breakages as negative evidence.
    for (const reason of ['provider_failure', 'timeout', 'run_cancelled', undefined]) {
      expect(isExecutionCaseUndispatchedReason(reason), String(reason)).toBe(false);
    }
  });

  it('⛔ stays DISJOINT from the gateway-denial vocabulary', () => {
    // The two exclusions mean different things — a denial is the owner's
    // judgement about a moment, a non-dispatch is a malformed emission. A reason
    // in both sets would make the compiler's branch order decide the meaning.
    for (const reason of EXECUTION_CASE_UNDISPATCHED_REASONS) {
      expect(isExecutionCaseGatewayDenialReason(reason), reason).toBe(false);
    }
  });
});

describe('D-219 — the `failed` predicate itself', () => {
  // ⚠ These exist because mutating the predicate IN PLACE left 474 tests green:
  // the classifier was covered and the WIRING was not. A predicate reachable
  // only through the full compiler is a predicate no test reaches.
  it('a refused-before-dispatch call does NOT make the flow failed', () => {
    expect(flowActivitiesFailed([
      { status: 'ok' },
      { status: 'error', reason: 'invalid_args' },
    ])).toBe(false);
  });

  it('⛔ a call that RAN and errored still does', () => {
    expect(flowActivitiesFailed([
      { status: 'ok' },
      { status: 'error', reason: 'provider_failure' },
    ])).toBe(true);
  });

  it('⛔ an errored activity with NO reason still does — absence is not an excuse', () => {
    expect(flowActivitiesFailed([{ status: 'error' }])).toBe(true);
  });

  it('⛔ a failed COMMIT counts even when the dispatch reason was undispatched', () => {
    // `recipe_status` is unconditional: the recipe ran and its commit failed,
    // which is a real breakage whatever the dispatch reason said.
    expect(flowActivitiesFailed([
      { status: 'error', reason: 'invalid_args', recipe_status: 'failed' },
    ])).toBe(true);
  });

  it('a clean flow is not failed', () => {
    expect(flowActivitiesFailed([{ status: 'ok' }, { status: 'ok' }])).toBe(false);
  });
});
