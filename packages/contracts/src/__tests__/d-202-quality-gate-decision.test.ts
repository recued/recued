/** D-202 task 4a.1 — the pure quality-gate decision orchestrator + the
 *  authorization conjunct it re-derives.
 *
 *  These lock the load-bearing v1 semantics the gateway ask-branch (4a.2)
 *  depends on:
 *    - `admitByOpRiskWithoutQualityLifts` RELAXES an owner-driven outbound send
 *      to `admit` (the lifted `ask` was purely the AI-output review) but keeps a
 *      contracted AI's write / a destructive op at `ask` (§12.1 — quality can
 *      never grant authority);
 *    - `resolveQualityGateDecision` composes that with a matching quality
 *      delegation + Switch A/B + whole-document into the three-conjunct verdict:
 *      only an owner send with a matching, un-paused delegation and a passing
 *      whole-document `send`s; everything else reviews. */

import { describe, expect, it } from 'vitest';

import {
  admitByOpRisk,
  admitByOpRiskWithoutQualityLifts,
  resolveQualityGateDecision,
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
  slug?: string;
  risk_tier?: 'read' | 'write' | 'admin' | 'destructive';
  source?: ExecutionSource;
  qualityDelegationMatches?: boolean;
  switches?: QualityGateSwitches;
  wholeDocumentPasses?: boolean;
} = {}) =>
  resolveQualityGateDecision({
    slug: o.slug ?? 'mail-send',
    risk_tier: o.risk_tier ?? 'write',
    source: o.source ?? OWNER,
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
    // Door ⇒ read ceiling ⇒ write outbound send stays ask ⇒ authorization_ask.
    expect(gate({ source: DOOR })).toEqual({
      verdict: 'review',
      reason: 'authorization_ask',
    });
  });

  it('reviews a DESTRUCTIVE op despite a quality match — quality never auto-runs it', () => {
    expect(
      gate({ slug: 'record-delete', risk_tier: 'destructive' }),
    ).toEqual({ verdict: 'review', reason: 'authorization_ask' });
  });
});

// D-202 review Finding 1 — the authorization conjunct is an args-BLIND op-risk
// recompute. `resolveQualityGateDecision` takes NO resolved args, so a spec §1
// authorization value-bound ("amount > $X → review") is INVISIBLE to it: only
// op-risk (slug × risk_tier), the trust ceiling (source), the delegation match,
// and the kill-switch gate the verdict. Sound TODAY because op-risk+lift is the
// admission's sole `ask` source. When value-bounds land they MUST NOT surface as
// a plain `evaluateAdmission` ask — the authz conjunct must instead re-run the
// real admission with the review lift suppressed, or a value-bound-tripped send
// with a quality delegation would wrongly skip (§12.1). This pins the current
// bounded contract so the limitation is executable, not merely documented.
describe('D-202 resolveQualityGateDecision — Finding 1: authorization is args-blind', () => {
  it('sends an owner outbound send with no payload channel by which a value-bound could gate it', () => {
    expect(gate({ slug: 'mail-send', risk_tier: 'write', source: OWNER }).verdict).toBe(
      'send',
    );
  });

  it('every knob that DOES gate the send is authorization/kill-switch, never payload', () => {
    expect(gate({ source: DOOR }).verdict).toBe('review'); // trust ceiling
    expect(gate({ switches: SWITCH_B }).verdict).toBe('review'); // kill-switch
    expect(gate({ slug: 'record-delete', risk_tier: 'destructive' }).verdict).toBe(
      'review',
    ); // op-risk tier
  });
});
