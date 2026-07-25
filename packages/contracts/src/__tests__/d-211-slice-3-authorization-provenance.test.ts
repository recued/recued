/** D-211 Slice 3 — D-209 §1.7 authorization provenance ordering. */

import { describe, expect, it } from 'vitest';

import {
  admitByOpRisk,
  projectToResolution,
  resolveCatalogOperationPolicy,
  type ExecutionSource,
} from '@recued/contracts';

const OWNER: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'owner-1',
};

describe('D-211 Slice 3 authorization provenance', () => {
  it('captures review-only owner send authorization after trust relax, before the send lift', () => {
    const decision = admitByOpRisk({
      slug: 'mail-send',
      risk_tier: 'write',
      ceiling: 'admin',
      source: OWNER,
    });

    expect(decision.verdict).toBe('ask');
    expect(decision.authorization_provenance).toEqual({
      pre_lift_approval: 'never',
      lift_reason: 'review_send',
    });
  });

  it('preserves an owner always ruling instead of misclassifying it as a review lift', () => {
    const decision = admitByOpRisk({
      slug: 'mail-send',
      risk_tier: 'write',
      ceiling: 'admin',
      source: OWNER,
      owner_override: { approval: 'always' },
    });

    expect(decision.verdict).toBe('ask');
    expect(decision.authorization_provenance).toEqual({
      pre_lift_approval: 'always',
    });
  });

  it('captures source-profile tightening after trust relaxation', () => {
    const resolution = resolveCatalogOperationPolicy({
      operations: {
        statement: {
          operation_id: 'statement.send',
          risk_tier: 'write',
          approval: 'ask',
        },
      },
      operation_id: 'statement',
      profile: {
        allowed_operations: ['statement'],
        approval_defaults: { statement: 'always' },
      },
      ceiling: 'admin',
    });

    expect(resolution.approval).toBe('always');
    expect(resolution.authorization_provenance).toEqual({
      pre_lift_approval: 'always',
    });
  });

  it('updates provenance when legacy actor-scoped tightening runs last', () => {
    const relaxed = resolveCatalogOperationPolicy({
      operations: {
        statement: {
          operation_id: 'statement.send',
          risk_tier: 'write',
          approval: 'ask',
        },
      },
      operation_id: 'statement',
      profile: { allowed_operations: ['statement'] },
      ceiling: 'admin',
    });
    expect(relaxed.authorization_provenance.pre_lift_approval).toBe('never');

    const tightened = projectToResolution({ approval: 'always' }, relaxed);
    expect(tightened.approval).toBe('always');
    expect(tightened.authorization_provenance).toEqual({
      pre_lift_approval: 'always',
    });
  });
});
