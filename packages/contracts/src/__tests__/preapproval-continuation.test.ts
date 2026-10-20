import { describe, expect, it } from 'vitest';
import { parsePreapprovalContinuation } from '../preapproval.js';

const request = () => ({ proposal_id: 'pap_11111111-1111-4111-8111-111111111111',
  idempotency_key: 'one-owner-preparation', activation: { kind: 'one_shot', run_at: 3000, time_zone: 'UTC' },
  decision_deadline: 2000, dispatch_deadline: 4000 });
describe('owner continuation request', () => {
  it('accepts only a locator, stable request key and an explicit execution window', () => {
    expect(parsePreapprovalContinuation(request())).toEqual(request());
  });
  it.each(['origin', 'source', 'approved', 'grant_id', 'members', 'resource_review', 'subject'])('refuses caller-supplied %s', field => {
    expect(() => parsePreapprovalContinuation({ ...request(), [field]: {} })).toThrow();
  });
  it.each([
    { activation: { kind: 'next_schedule', schedule_id: 'other-owner-rule', expected_revision: 1 } },
    { activation: { kind: 'one_shot', run_at: 1500, time_zone: 'UTC' } },
    { activation: { kind: 'one_shot', run_at: 5000, time_zone: 'UTC' } },
    { activation: { kind: 'one_shot', run_at: Infinity, time_zone: 'UTC' } },
    { activation: { kind: 'one_shot', run_at: 3000, time_zone: 'Not/A_Timezone' } },
    { proposal_id: 'an-untyped-locator' },
  ])('refuses an invalid continuation window or locator (%j)', patch => {
    expect(() => parsePreapprovalContinuation({ ...request(), ...patch })).toThrow();
  });
});
