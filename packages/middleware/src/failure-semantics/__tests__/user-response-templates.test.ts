/** D-145 PB15 — user_response template closed-list ratchet. */

import { describe, it, expect } from 'vitest';
import { PLAN_STATUSES } from '@recued/contracts';
import {
  USER_RESPONSE_TEMPLATES,
  userResponseForStatus,
  type HaltPlanStatus,
} from '../user-response-templates.js';

const HALT_STATUSES: HaltPlanStatus[] = PLAN_STATUSES.filter(
  (s): s is HaltPlanStatus => s !== 'completed' && s !== 'preview_no_op',
);

describe('D-145 PB15 — USER_RESPONSE_TEMPLATES', () => {
  it('has a template for every halt PlanStatus', () => {
    for (const status of HALT_STATUSES) {
      expect(USER_RESPONSE_TEMPLATES[status]).toBeDefined();
      expect(USER_RESPONSE_TEMPLATES[status].length).toBeGreaterThan(0);
    }
    expect(Object.keys(USER_RESPONSE_TEMPLATES).length).toBe(HALT_STATUSES.length);
  });

  it('every template is truthful + actionable (contains user-facing verb)', () => {
    // Heuristic: each template MUST mention either "you" / "I" / "your" /
    // "retry" / etc. Engine never silently fails.
    const ACTIONABLE_TOKENS = ['you', 'I', 'You', 'retry', 'rephrase', 'check', 'adjust'];
    for (const status of HALT_STATUSES) {
      const copy = USER_RESPONSE_TEMPLATES[status];
      const hasActionableToken = ACTIONABLE_TOKENS.some((tok) => copy.includes(tok));
      expect(hasActionableToken).toBe(true);
    }
  });

  it('userResponseForStatus returns the template for a halt status', () => {
    expect(userResponseForStatus('cancelled_privacy_violation')).toBe(
      USER_RESPONSE_TEMPLATES.cancelled_privacy_violation,
    );
  });

  it('cancelled_cost_ceiling mentions budget', () => {
    expect(USER_RESPONSE_TEMPLATES.cancelled_cost_ceiling).toMatch(/budget/i);
  });

  it('cancelled_si_conflict mentions Standing Instructions', () => {
    expect(USER_RESPONSE_TEMPLATES.cancelled_si_conflict).toMatch(/Standing Instructions/i);
  });

  it('cancelled_privacy_violation mentions privacy', () => {
    expect(USER_RESPONSE_TEMPLATES.cancelled_privacy_violation).toMatch(/privacy/i);
  });
});
