/** D-145 PB15 — closed-list ratchet on PlanStatus → FailureClass map. */

import { describe, it, expect } from 'vitest';
import {
  FAILURE_CLASS_SET,
  PLAN_STATUSES,
} from '@recued/contracts';
import {
  PLAN_STATUS_TO_FAILURE_CLASS,
  failureClassForStatus,
} from '../failure-class-map.js';

describe('D-145 PB15 — PLAN_STATUS_TO_FAILURE_CLASS', () => {
  it('has an entry for every PlanStatus', () => {
    for (const status of PLAN_STATUSES) {
      expect(status in PLAN_STATUS_TO_FAILURE_CLASS).toBe(true);
    }
    expect(Object.keys(PLAN_STATUS_TO_FAILURE_CLASS).length).toBe(PLAN_STATUSES.length);
  });

  it('maps terminal-success statuses to undefined', () => {
    expect(failureClassForStatus('completed')).toBeUndefined();
    expect(failureClassForStatus('preview_no_op')).toBeUndefined();
  });

  it('maps every halt status to a closed-list FailureClass', () => {
    for (const status of PLAN_STATUSES) {
      const klass = failureClassForStatus(status);
      if (status === 'completed' || status === 'preview_no_op') {
        expect(klass).toBeUndefined();
      } else {
        expect(klass).toBeDefined();
        expect(FAILURE_CLASS_SET.has(klass!)).toBe(true);
      }
    }
  });

  it('maps cancelled_privacy_violation → privacy', () => {
    expect(failureClassForStatus('cancelled_privacy_violation')).toBe('privacy');
  });

  it('maps cancelled_cost_ceiling → cost', () => {
    expect(failureClassForStatus('cancelled_cost_ceiling')).toBe('cost');
  });

  it('maps cancelled_malformed_ai → synthesis', () => {
    expect(failureClassForStatus('cancelled_malformed_ai')).toBe('synthesis');
  });

  it('maps cancelled_no_alternative → synthesis', () => {
    expect(failureClassForStatus('cancelled_no_alternative')).toBe('synthesis');
  });

  it('maps capacity-bucket statuses (gap / si_conflict / by_user) → capacity', () => {
    expect(failureClassForStatus('cancelled_capacity_gap')).toBe('capacity');
    expect(failureClassForStatus('cancelled_si_conflict')).toBe('capacity');
    expect(failureClassForStatus('cancelled_by_user')).toBe('capacity');
  });

  it('is frozen — cannot mutate at runtime', () => {
    expect(() => {
      // @ts-expect-error — testing immutability
      PLAN_STATUS_TO_FAILURE_CLASS.completed = 'synthesis';
    }).toThrow();
  });
});
