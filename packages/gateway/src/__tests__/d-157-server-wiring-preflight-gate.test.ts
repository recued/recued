/** D-157 server-wiring - preflight gate signal detail forwarding. */

import {
  PreflightRequiredSignal,
  isPreflightRequiredSignal,
} from '@recued/contracts';
import type { AdmissionDecision } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import { raiseOnAsk } from '../preflight-gate.js';

const askDecision = (
  overrides: Partial<Extract<AdmissionDecision, { verdict: 'ask' }>> = {},
): AdmissionDecision => ({
  verdict: 'ask',
  risk_tier: 'admin',
  detail: 'admin tier requires approval',
  ...overrides,
} as AdmissionDecision);

const captureThrow = (fn: () => void): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected function to throw');
};

describe('raiseOnAsk structured signal details', () => {
  it('throws a PreflightRequiredSignal whose fields match the decision', () => {
    const thrown = captureThrow(() =>
      raiseOnAsk(askDecision(), { slug: 'crm.admin-update' }));

    expect(thrown).toBeInstanceOf(PreflightRequiredSignal);
    expect(isPreflightRequiredSignal(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      tool_slug: 'crm.admin-update',
      risk_tier: 'admin',
      reason: 'admin tier requires approval',
    });
    expect((thrown as Error).message).toContain('crm.admin-update');
    expect((thrown as Error).message).toContain("risk_tier='admin'");
    expect((thrown as Error).message).toContain('admin tier requires approval');
  });

  it('leaves signal fields undefined when detail fields are missing', () => {
    const incomplete = {
      verdict: 'ask',
    } as AdmissionDecision;

    const thrown = captureThrow(() =>
      raiseOnAsk(incomplete, { slug: 'legacy-tool' }));

    expect(thrown).toBeInstanceOf(PreflightRequiredSignal);
    expect((thrown as PreflightRequiredSignal).tool_slug).toBe('legacy-tool');
    expect((thrown as PreflightRequiredSignal).risk_tier).toBeUndefined();
    expect((thrown as PreflightRequiredSignal).reason).toBeUndefined();
  });

  it('does not throw for admit or deny decisions', () => {
    expect(() =>
      raiseOnAsk({ verdict: 'admit' }, { slug: 'read-tool' })).not.toThrow();
    expect(() =>
      raiseOnAsk({
        verdict: 'deny',
        code: 'tool_not_in_contract',
        detail: 'destructive tier is denied',
      }, { slug: 'danger-tool' })).not.toThrow();
  });
});
