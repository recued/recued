import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_PERMISSION_FAILURE_MESSAGE,
  presentAutomationFailure,
} from '../automation-failure.js';

describe('presentAutomationFailure', () => {
  it.each([
    [
      'static recipe gate',
      "D-153 P2.C gateRecipeAgainstPolicy: a source carrying a contract_id (actor 'system') requires a ContractSnapshot — the producer must resolve it before dispatch.",
    ],
    [
      'per-action preflight gate',
      "D-157 P1 evaluatePreflightAdmission: a source carrying a contract_id (actor 'system') requires a ContractSnapshot — the host must resolve it before dispatch.",
    ],
  ])('redacts the %s invariant without discarding its diagnostic', (_name, internal) => {
    expect(presentAutomationFailure(new Error(internal))).toEqual({
      userMessage: AUTOMATION_PERMISSION_FAILURE_MESSAGE,
      internalMessage: internal,
      redacted: true,
    });
  });

  it('passes an ordinary execution failure through unchanged', () => {
    expect(presentAutomationFailure(new Error('calendar connection unavailable'))).toEqual({
      userMessage: 'calendar connection unavailable',
      internalMessage: 'calendar connection unavailable',
      redacted: false,
    });
  });
});
