/** D-268 — {@link classifyAutomationFailure} behaviour.
 *
 *  Each block names the failure it guards, because a disposition that comes out
 *  right for the wrong reason is a bug that only shows up months later on a
 *  different code. */

import { describe, expect, it } from 'vitest';

import {
  classifyAutomationFailure,
  ENVIRONMENT_RETRY_POLICY,
} from '../automation-failure-policy.js';
import { ERROR_ATTRIBUTION } from '../errors.js';

describe('D-268 classifyAutomationFailure', () => {
  describe('`conditional` — the guard that would disarm working automations', () => {
    // The recipe DECIDED not to act and was right to. Counting these toward a
    // breaker switches off the automations that are behaving correctly, and it
    // looks exactly like the feature working.
    const conditionalCodes = Object.entries(ERROR_ATTRIBUTION)
      .filter(([, a]) => a === 'conditional')
      .map(([code]) => code);

    it('has conditional codes to test (positive control)', () => {
      expect(conditionalCodes.length).toBeGreaterThan(0);
    });

    it('every `conditional` code is NOT a failure at all', () => {
      for (const code of conditionalCodes) {
        expect(classifyAutomationFailure({ code })).toEqual({ kind: 'not_a_failure' });
      }
    });
  });

  describe('a fault that will not heal stops at the first failure', () => {
    it('a revoked token does not un-revoke itself', () => {
      expect(classifyAutomationFailure({ code: 'OAUTH_REVOKED' })).toEqual({
        kind: 'failure', stop: 'first_failure', basis: 'environment_permanent',
      });
    });

    it('the motivating case of the whole entry — an expired refresh', () => {
      expect(classifyAutomationFailure({ code: 'TOKEN_REFRESH_FAILED' })).toEqual({
        kind: 'failure', stop: 'first_failure', basis: 'environment_permanent',
      });
    });

    it('a `choice` fault repeats identically, so one occurrence is all the evidence there is', () => {
      expect(classifyAutomationFailure({ code: 'CONNECTION_NOT_FOUND' })).toEqual({
        kind: 'failure', stop: 'first_failure', basis: 'attribution_choice',
      });
    });

    it('an `owner` refusal waits on a person, not on a clock', () => {
      expect(classifyAutomationFailure({ code: 'RECIPE_POLICY_DENIED' })).toEqual({
        kind: 'failure', stop: 'first_failure', basis: 'attribution_owner',
      });
    });

    it('⛔ uncertain delivery stops — not because a retry would fail, but because it might succeed TWICE', () => {
      expect(classifyAutomationFailure({ code: 'ACTION_DELIVERY_UNCERTAIN' })).toEqual({
        kind: 'failure', stop: 'first_failure', basis: 'environment_permanent',
      });
    });
  });

  describe('a transient fault earns the breaker — the only retry the system has', () => {
    // `packages/engine/src/types.ts`: "Zero-retry policy: the user decides when
    // to re-run, manually." There is no step-level retry, so without this bucket
    // Recued would retry nothing at all.
    it.each(['NETWORK_ERROR', 'API_RATE_LIMITED', 'API_SERVER_ERROR', 'STEP_TIMEOUT'])(
      '%s runs to the breaker',
      (code) => {
        expect(classifyAutomationFailure({ code })).toEqual({
          kind: 'failure', stop: 'breaker', basis: 'environment_transient',
        });
      },
    );

    it('an AI refusal is about the CONTENT, which does not change between ticks', () => {
      expect(classifyAutomationFailure({ code: 'AI_MODEL_REFUSED' })).toEqual({
        kind: 'failure', stop: 'first_failure', basis: 'environment_permanent',
      });
    });
  });

  describe('total refusal — the success-shaped failure', () => {
    it('with no error code, it runs to the breaker rather than stopping at one', () => {
      // The run is a SUCCESS by the engine's contract and the problem is
      // inferred from two integers. An inferred signal must not be treated as
      // more decisive than a direct one.
      expect(classifyAutomationFailure({ total_refusal: true })).toEqual({
        kind: 'failure', stop: 'breaker', basis: 'total_refusal',
      });
    });

    it('⛔ the DIRECT evidence wins — a code present alongside it decides instead', () => {
      expect(classifyAutomationFailure({ code: 'OAUTH_REVOKED', total_refusal: true })).toEqual({
        kind: 'failure', stop: 'first_failure', basis: 'environment_permanent',
      });
    });

    it('and a `conditional` code still wins, so a refusal cannot resurrect a non-failure', () => {
      const conditional = Object.entries(ERROR_ATTRIBUTION)
        .find(([, a]) => a === 'conditional')?.[0];
      expect(conditional).toBeDefined();
      expect(classifyAutomationFailure({ code: conditional, total_refusal: true }))
        .toEqual({ kind: 'not_a_failure' });
    });
  });

  describe('unknown input fails closed', () => {
    it('a code this build does not know stops at the first failure', () => {
      expect(classifyAutomationFailure({ code: 'SOME_CODE_FROM_A_NEWER_BUILD' })).toEqual({
        kind: 'failure', stop: 'first_failure', basis: 'unclassified' });
    });

    it('no code and no refusal — a raw Error thrown from an adapter', () => {
      expect(classifyAutomationFailure({})).toEqual({
        kind: 'failure', stop: 'first_failure', basis: 'unclassified' });
    });

    it('an empty-string code is treated as absent, not as a lookup miss', () => {
      expect(classifyAutomationFailure({ code: '', total_refusal: true })).toEqual({
        kind: 'failure', stop: 'breaker', basis: 'total_refusal' });
    });
  });

  describe('⛔ the table actually discriminates', () => {
    it('both stop points are reachable from real codes', () => {
      // Guards the collapse this module warns about: if every classification
      // returned the same stop point, every test above could still be rewritten
      // to pass while the feature did nothing.
      const stops = new Set(
        Object.keys(ENVIRONMENT_RETRY_POLICY).map((code) => {
          const d = classifyAutomationFailure({ code });
          return d.kind === 'failure' ? d.stop : 'not_a_failure';
        }),
      );
      expect([...stops].sort()).toEqual(['breaker', 'first_failure']);
    });
  });
});
