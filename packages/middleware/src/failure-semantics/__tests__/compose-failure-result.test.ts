/** D-145 PB15 — composeFailureResult substrate tests. */

import { describe, it, expect } from 'vitest';
import { composeFailureResult } from '../compose-failure-result.js';
import { USER_RESPONSE_TEMPLATES } from '../user-response-templates.js';

describe('D-145 PB15 — composeFailureResult', () => {
  it('returns the template verbatim when no detail / override', () => {
    const result = composeFailureResult({ status: 'cancelled_privacy_violation' });
    expect(result.status).toBe('cancelled_privacy_violation');
    expect(result.failure_class).toBe('privacy');
    expect(result.user_response).toBe(USER_RESPONSE_TEMPLATES.cancelled_privacy_violation);
  });

  it('appends detail with a single space separator', () => {
    const result = composeFailureResult({
      status: 'cancelled_capacity_gap',
      detail: '(bridge_online_lost_post_dry_run)',
    });
    expect(result.user_response).toMatch(/ \(bridge_online_lost_post_dry_run\)$/);
  });

  it('ignores empty-string detail (does not append a trailing space)', () => {
    const result = composeFailureResult({
      status: 'cancelled_capacity_gap',
      detail: '',
    });
    expect(result.user_response).toBe(USER_RESPONSE_TEMPLATES.cancelled_capacity_gap);
  });

  it('uses override_user_response when set', () => {
    const result = composeFailureResult({
      status: 'cancelled_no_alternative',
      override_user_response: 'Custom message',
    });
    expect(result.user_response).toBe('Custom message');
  });

  it('throws on empty override_user_response (engine never silently fails)', () => {
    expect(() =>
      composeFailureResult({
        status: 'cancelled_no_alternative',
        override_user_response: '',
      }),
    ).toThrow(/never silently fails/);
  });

  it('throws on terminal-success status (composeFailureResult is halt-only)', () => {
    expect(() =>
      composeFailureResult({
        // @ts-expect-error — testing runtime guard
        status: 'completed',
      }),
    ).toThrow(/terminal-success/);
  });

  it('stamps correct failure_class for each halt path', () => {
    expect(composeFailureResult({ status: 'cancelled_by_user' }).failure_class).toBe('capacity');
    expect(composeFailureResult({ status: 'cancelled_cost_ceiling' }).failure_class).toBe('cost');
    expect(composeFailureResult({ status: 'cancelled_privacy_violation' }).failure_class).toBe(
      'privacy',
    );
    expect(composeFailureResult({ status: 'cancelled_malformed_ai' }).failure_class).toBe(
      'synthesis',
    );
  });
});
