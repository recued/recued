/** D-202 task 4a.1 / D-211 Slice 3 — the pure quality-gate decision
 *  orchestrator consuming captured authorization provenance.
 *
 *  These lock the load-bearing v1 semantics the gateway ask-branch (4a.2)
 *  depends on:
 *    - the real admission path captures an owner-driven outbound send at
 *      `pre_lift_approval:'never'` before its review lift, but preserves a
 *      contracted write or owner `always` at its stricter posture (§12.1);
 *    - `resolveQualityGateDecision` composes that with a matching quality
 *      delegation + Switch A/B + whole-document into the three-conjunct verdict:
 *      only an owner send with a matching, un-paused delegation and a passing
 *      whole-document `send`s; everything else reviews. */

import { describe, expect, it } from 'vitest';

import {
  admitByOpRisk,
  admitByOpRiskWithoutQualityLifts,
  resolveQualityGateDecision,
  type AuthorizationProvenance,
  type ExecutionSource,
  type QualityGateSwitches,
} from '@recued/contracts';

// ── source fixtures ──────────────────────────────────────────────
// Owner: contract-less chat `user_self` ⇒ the `admin` trust ceiling
// (reads/writes/admin silent, only destructive asks).
const OWNER: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 's1',
  user_id: 'u1',
};
// Contracted door: a `contracted_user` with a real contract_id ⇒ the LOW
// `read` ceiling (the AI's writes surface for approval).
const DOOR: ExecutionSource = {
  channel: 'chat',
  actor: 'contracted_user',
  chat_session_id: 's1',
  user_id: 'u1',
  contract_id: 'c-door',
};

const SWITCH_A: QualityGateSwitches = { all_paused: true, quality_paused: false };
const SWITCH_B: QualityGateSwitches = { all_paused: false, quality_paused: true };
const NO_PAUSE: QualityGateSwitches = { all_paused: false, quality_paused: false };

// ════════════════════════════════════════════════════════════════
// admitByOpRiskWithoutQualityLifts — the authorization conjunct
// ════════════════════════════════════════════════════════════════

describe('D-202 admitByOpRiskWithoutQualityLifts — strips ONLY the review lifts', () => {
  it('RELAXES an owner outbound send to admit (the lift was the only ask)', () => {
    // admitByOpRisk WITH the lift asks (the review surface)…
    expect(
      admitByOpRisk({
        slug: 'mail-send',
        risk_tier: 'write',
        ceiling: 'admin',
        source: OWNER,
      }).verdict,
    ).toBe('ask');
    // …but WITHOUT the review lift the underlying authorization admits.
    expect(
      admitByOpRiskWithoutQualityLifts({
        slug: 'mail-send',
        risk_tier: 'write',
        ceiling: 'admin',
      }).verdict,
    ).toBe('admit');
  });

  it('keeps a contracted outbound send at ask — write exceeds the LOW ceiling (§12.1)', () => {
    expect(
      admitByOpRiskWithoutQualityLifts({
        slug: 'mail-send',
        risk_tier: 'write',
        ceiling: 'read',
      }).verdict,
    ).toBe('ask');
  });

  it('keeps a destructive op at ask under the owner admin ceiling (always-class)', () => {
    expect(
      admitByOpRiskWithoutQualityLifts({
        slug: 'record-delete',
        risk_tier: 'destructive',
        ceiling: 'admin',
      }).verdict,
    ).toBe('ask');
  });

  it('admits a read op regardless of ceiling (never-class)', () => {
    expect(
      admitByOpRiskWithoutQualityLifts({
        slug: 'mail-read',
        risk_tier: 'read',
        ceiling: 'read',
      }).verdict,
    ).toBe('admit');
  });
});

// ════════════════════════════════════════════════════════════════
// resolveQualityGateDecision — the composed three-conjunct verdict
// ════════════════════════════════════════════════════════════════

const gate = (o: {
  authorization_provenance?: AuthorizationProvenance;
  qualityDelegationMatches?: boolean;
  switches?: QualityGateSwitches;
  wholeDocumentPasses?: boolean;
} = {}) =>
  resolveQualityGateDecision({
    authorization_provenance: o.authorization_provenance ?? {
      pre_lift_approval: 'never',
      lift_reason: 'review_send',
    },
    qualityDelegationMatches: o.qualityDelegationMatches ?? true,
    switches: o.switches ?? NO_PAUSE,
    ...(o.wholeDocumentPasses !== undefined
      ? { wholeDocumentPasses: o.wholeDocumentPasses }
      : {}),
  });

describe('D-202 resolveQualityGateDecision — the send path', () => {
  it('SENDS an owner outbound send with a matching, un-paused delegation', () => {
    expect(gate()).toEqual({ verdict: 'send', reason: 'all_conjuncts_pass' });
  });

  it('defaults wholeDocumentPasses to true (v1 single-node placeholder)', () => {
    // No wholeDocumentPasses supplied ⇒ still sends.
    expect(gate({}).verdict).toBe('send');
  });
});

describe('D-202 resolveQualityGateDecision — quality conjunct routes to review', () => {
  it('reviews when NO quality delegation matches (behaviour-preserving)', () => {
    expect(gate({ qualityDelegationMatches: false })).toEqual({
      verdict: 'review',
      reason: 'quality_not_delegated',
    });
  });

  it('reviews under Switch B (quality axis paused) even with a match', () => {
    expect(gate({ switches: SWITCH_B })).toEqual({
      verdict: 'review',
      reason: 'quality_not_delegated',
    });
  });

  it('reviews under Switch A (both axes paused) even with a match', () => {
    expect(gate({ switches: SWITCH_A })).toEqual({
      verdict: 'review',
      reason: 'quality_not_delegated',
    });
  });

  it('reviews when the whole-document conjunct flags (§12.2 never skipped)', () => {
    expect(gate({ wholeDocumentPasses: false })).toEqual({
      verdict: 'review',
      reason: 'whole_document_flagged',
    });
  });
});

describe('D-202 resolveQualityGateDecision — authorization is independent (§12.1)', () => {
  it('reviews a CONTRACTED send despite a quality match — the AI has no send authority', () => {
    expect(gate({
      authorization_provenance: { pre_lift_approval: 'ask' },
    })).toEqual({
      verdict: 'review',
      reason: 'authorization_ask',
    });
  });

  it('reviews an owner always ruling despite a quality match', () => {
    expect(gate({
      authorization_provenance: { pre_lift_approval: 'always' },
    })).toEqual({ verdict: 'review', reason: 'authorization_ask' });
  });
});

describe('D-209 §1.7 — quality consumes captured authorization provenance', () => {
  it('sends when the real resolver captured a review-only pre-lift never', () => {
    expect(gate({
      authorization_provenance: {
        pre_lift_approval: 'never',
        lift_reason: 'review_send',
      },
    }).verdict).toBe('send');
  });

  it('preserves captured tightening and the independent kill-switches', () => {
    expect(gate({
      authorization_provenance: { pre_lift_approval: 'ask' },
    }).verdict).toBe('review');
    expect(gate({ switches: SWITCH_B }).verdict).toBe('review'); // kill-switch
    expect(gate({
      authorization_provenance: { pre_lift_approval: 'always' },
    }).verdict).toBe('review');
  });
});
