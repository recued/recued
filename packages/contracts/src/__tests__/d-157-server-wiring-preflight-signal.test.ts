/** D-157 server-wiring - PreflightRequiredSignal structured details. */

import { describe, expect, it } from 'vitest';

import {
  PREFLIGHT_REQUIRED_SIGNAL_NAME,
  PreflightRequiredSignal,
  isPreflightRequiredSignal,
} from '../preflight-signal.js';

describe('PreflightRequiredSignal structured details', () => {
  it('sets tool_slug, risk_tier, and reason when supplied', () => {
    const signal = new PreflightRequiredSignal(
      'approval required',
      {
        tool_slug: 'mail.send',
        risk_tier: 'write',
        reason: 'write tier requires user approval',
      },
    );

    expect(signal.name).toBe(PREFLIGHT_REQUIRED_SIGNAL_NAME);
    expect(signal.message).toBe('approval required');
    expect(signal.tool_slug).toBe('mail.send');
    expect(signal.risk_tier).toBe('write');
    expect(signal.reason).toBe('write tier requires user approval');
  });

  it('leaves structured fields undefined when details are absent', () => {
    const signal = new PreflightRequiredSignal('legacy pause');

    expect(signal.tool_slug).toBeUndefined();
    expect(signal.risk_tier).toBeUndefined();
    expect(signal.reason).toBeUndefined();
  });

  it('isPreflightRequiredSignal recognises the widened class', () => {
    const signal = new PreflightRequiredSignal('approval required', {
      tool_slug: 'crm.update',
      risk_tier: 'admin',
      reason: 'admin write needs approval',
    });

    expect(isPreflightRequiredSignal(signal)).toBe(true);
  });

  it('isPreflightRequiredSignal recognises the legacy bare shape', () => {
    const legacyShape = {
      name: PREFLIGHT_REQUIRED_SIGNAL_NAME,
      message: 'preflight approval required',
    };

    expect(isPreflightRequiredSignal(legacyShape)).toBe(true);
  });

  it('does not treat non-matching errors as preflight signals', () => {
    expect(isPreflightRequiredSignal(new Error('boom'))).toBe(false);
    expect(isPreflightRequiredSignal({ name: 'OtherSignal' })).toBe(false);
    expect(isPreflightRequiredSignal(null)).toBe(false);
  });
});
