/** D-145 PB15 — approval decision mapping tests. */

import { describe, it, expect } from 'vitest';
import { mapApprovalDecision } from '../approval-mapping.js';

describe('D-145 PB15 — mapApprovalDecision', () => {
  it('approved → continue', () => {
    const result = mapApprovalDecision('approved');
    expect(result.kind).toBe('continue');
  });

  it('declined → halt cancelled_by_user with denied halt_kind', () => {
    const result = mapApprovalDecision('declined');
    expect(result.kind).toBe('halt');
    if (result.kind === 'halt') {
      expect(result.halt_kind).toBe('denied');
      expect(result.result.status).toBe('cancelled_by_user');
      expect(result.result.failure_class).toBe('capacity');
      expect(result.result.user_response).toMatch(/approval_denied/);
    }
  });

  it('cancelled → halt cancelled_by_user with cancelled halt_kind', () => {
    const result = mapApprovalDecision('cancelled');
    expect(result.kind).toBe('halt');
    if (result.kind === 'halt') {
      expect(result.halt_kind).toBe('cancelled');
      expect(result.result.status).toBe('cancelled_by_user');
      expect(result.result.user_response).toMatch(/approval_cancelled/);
    }
  });

  it('timeout → halt cancelled_by_user with expired halt_kind + approval_unavailable detail', () => {
    const result = mapApprovalDecision('timeout');
    expect(result.kind).toBe('halt');
    if (result.kind === 'halt') {
      expect(result.halt_kind).toBe('expired');
      expect(result.result.user_response).toMatch(/approval_unavailable/);
    }
  });

  it('halt user_response is truthful + actionable', () => {
    const result = mapApprovalDecision('declined');
    if (result.kind === 'halt') {
      // Template wording + detail clause concatenation.
      expect(result.result.user_response.length).toBeGreaterThan(20);
      expect(result.result.user_response).toMatch(/proceed|approval/i);
    }
  });

  it('throws on off-list decision', () => {
    expect(() =>
      // @ts-expect-error — testing runtime guard
      mapApprovalDecision('bogus'),
    ).toThrow(/unknown ApprovalDecision/);
  });
});
