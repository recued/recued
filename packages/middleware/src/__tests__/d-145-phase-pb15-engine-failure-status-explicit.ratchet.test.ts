/** D-145 PB15 — `engine-failure-status-explicit` ratchet.
 *
 *  Pins the substrate-level invariant from § B.15.11: every halt path
 *  produces an explicit `PlanStatus` + matching `FailureClass`. The
 *  ratchet asserts:
 *
 *    1. Every `PlanStatus` has an entry in
 *       `PLAN_STATUS_TO_FAILURE_CLASS`.
 *    2. Every halt status has a non-empty `user_response` template.
 *    3. Every halt status's mapped `FailureClass` is in the closed
 *       `FAILURE_CLASSES` set.
 *    4. Terminal-success statuses (`completed`, `preview_no_op`) map
 *       to `undefined` (no failure_class).
 *    5. The closed list count is exactly 9 (per § B.15.11 summary).
 *
 *  Drift requires substrate D-spec change. */

import { describe, it, expect } from 'vitest';
import {
  FAILURE_CLASS_SET,
  PLAN_STATUSES,
} from '@recued/contracts';
import {
  PLAN_STATUS_TO_FAILURE_CLASS,
  USER_RESPONSE_TEMPLATES,
  type HaltPlanStatus,
} from '../failure-semantics/index.js';

describe('D-145 PB15 — engine-failure-status-explicit.ratchet', () => {
  it('PLAN_STATUSES has exactly 9 entries per § B.15.11 closed list', () => {
    expect(PLAN_STATUSES.length).toBe(9);
  });

  it('every PlanStatus has a failure-class mapping (no silent drift)', () => {
    for (const status of PLAN_STATUSES) {
      expect(status in PLAN_STATUS_TO_FAILURE_CLASS).toBe(true);
    }
  });

  it('every halt status maps to a closed-list FailureClass (no off-list values)', () => {
    for (const status of PLAN_STATUSES) {
      const klass = PLAN_STATUS_TO_FAILURE_CLASS[status];
      if (status === 'completed' || status === 'preview_no_op') {
        expect(klass).toBeUndefined();
      } else {
        expect(klass).toBeDefined();
        expect(FAILURE_CLASS_SET.has(klass!)).toBe(true);
      }
    }
  });

  it('every halt status has a non-empty user_response template', () => {
    const haltStatuses: HaltPlanStatus[] = PLAN_STATUSES.filter(
      (s): s is HaltPlanStatus => s !== 'completed' && s !== 'preview_no_op',
    );
    for (const status of haltStatuses) {
      const copy = USER_RESPONSE_TEMPLATES[status];
      expect(typeof copy).toBe('string');
      expect(copy.length).toBeGreaterThan(20);
    }
  });

  it('PLAN_STATUS_TO_FAILURE_CLASS keys exactly match PLAN_STATUSES (no surplus)', () => {
    const mapKeys = Object.keys(PLAN_STATUS_TO_FAILURE_CLASS).sort();
    const expectedKeys = [...PLAN_STATUSES].sort();
    expect(mapKeys).toEqual(expectedKeys);
  });

  it('USER_RESPONSE_TEMPLATES keys exactly match halt statuses (no surplus)', () => {
    const templateKeys = Object.keys(USER_RESPONSE_TEMPLATES).sort();
    const expectedKeys = PLAN_STATUSES.filter(
      (s) => s !== 'completed' && s !== 'preview_no_op',
    ).sort();
    expect(templateKeys).toEqual(expectedKeys);
  });
});
