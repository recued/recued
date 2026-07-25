/** D-187 policy-matrix retirement — SLICE 3 contract tests.
 *
 *  Stands up + PROVES the replacement APPROVAL resolver that slice 4 wires onto
 *  the 4 matrix chokepoints (off `lookupPolicy` / `admitWithPolicyMatrix`). Two
 *  pure pieces, both keyed on the OP-RISK tier (the op-catalog `effective_risk_tier`
 *  / the simple-form manifest `risk_tier`) rather than the wrapper's static
 *  `risk_tier` the matrix gated on:
 *
 *   - `resolveSimpleFormOperationPolicy` — the op-risk + approval BASE for a
 *     simple-form ingredient (one ingredient = one op → op-risk = manifest
 *     risk_tier). The same `baseApprovalOrDeny` algebra `resolveCatalogOperationPolicy`
 *     runs, so the two dispatch forms share ONE op-risk approval model (the
 *     unification this slice proves).
 *   - `applyTrustCeiling` — op-risk × STAGE-TRUST: RELAX an `ask`-class op at or
 *     below the trust ceiling to admit (trust REMOVES a per-call approval, never
 *     adds — the opposite of `projectToResolution`). The locked model (owner,
 *     2026-06-23): contract-less = trust-ceiling authority (default `admin`,
 *     behavior-preserving); contracted = the contract's `max_risk_without_approval`
 *     (defaults low → an AI's writes surface for approval).
 *
 *  COVERAGE PROOF (the slice's named deliverable — "ensure every ingredient dispatch
 *  resolves an op-risk"): every `OperationRiskTier` resolves through the simple-form
 *  resolver to `effective_risk_tier === that tier`; combined with the catalog path's
 *  `resolveCatalogOperationPolicy`, the two forms cover every ingredient dispatch.
 *  (Transforms + guards carry no risk_tier and never reach the gate — non-ingredient,
 *  by construction.) Substrate only — NOT wired at the chokepoints (that is slice 4),
 *  so no admission/approval behavior changes here. */

import { describe, expect, it } from 'vitest';

import {
  applyTrustCeiling,
  resolveCatalogOperationPolicy,
  resolveSimpleFormOperationPolicy,
  RISK_TIERS,
  type CatalogOperationResolution,
  type OperationApproval,
  type OperationRiskTier,
  type OperationSpec,
  type ProviderDefaultPolicy,
  type TrustCeiling,
} from '@recued/contracts';

/** The coverage universe is the canonical `RISK_TIERS` ladder (contracts) — its
 *  own completeness ratchet means a 6th tier breaks the source of truth, and
 *  these totality loops then cover it automatically. */
const ALL_RISK_TIERS = RISK_TIERS;

const ALL_CEILINGS = ['none', 'read', 'write', 'admin'] as const satisfies
  readonly TrustCeiling[];

const simple = (
  risk_tier: OperationRiskTier,
  default_policy?: ProviderDefaultPolicy,
): CatalogOperationResolution =>
  resolveSimpleFormOperationPolicy({
    slug: 'annotation-create',
    risk_tier,
    ...(default_policy ? { default_policy } : {}),
  });

// ════════════════════════════════════════════════════════════════
// resolveSimpleFormOperationPolicy — the simple-form op-risk base
// ════════════════════════════════════════════════════════════════

describe('resolveSimpleFormOperationPolicy — op-risk base (slice 3)', () => {
  it('derives effective_risk_tier from the manifest risk_tier verbatim (one ingredient = one op)', () => {
    for (const tier of ALL_RISK_TIERS) {
      expect(simple(tier).effective_risk_tier).toBe(tier);
    }
  });

  it('is APPROVAL-only — always granted (access is the separate op-admission gate, Layer 1)', () => {
    for (const tier of ALL_RISK_TIERS) {
      const r = simple(tier);
      expect(r.granted).toBe(true);
      expect(r.deny_reason).toBeUndefined();
      // No catalog operation → no group attribution.
      expect(r.operation_group).toBeNull();
      // The slug IS the synthetic operation id (audit attribution).
      expect(r.operation_id).toBe('annotation-create');
    }
  });

  it('maps op-risk → the standard approval / verdict default (baseApprovalOrDeny)', () => {
    const expected: Record<OperationRiskTier, { approval: OperationApproval; verdict: string }> = {
      read: { approval: 'never', verdict: 'admit' },
      write: { approval: 'ask', verdict: 'ask' },
      admin: { approval: 'ask', verdict: 'ask' },
      destructive: { approval: 'always', verdict: 'ask' },
    };
    for (const tier of ALL_RISK_TIERS) {
      const r = simple(tier);
      expect(r.approval).toBe(expected[tier].approval);
      expect(r.verdict).toBe(expected[tier].verdict);
    }
  });

  it('runs the SAME approval algebra as the catalog path (the unification this slice proves)', () => {
    // A degenerate single-op catalog with op-risk R + a granting profile must yield
    // the IDENTICAL approval/verdict/effective_risk_tier as the simple-form resolver
    // for the same R — they are one op-risk model, two dispatch forms.
    for (const tier of ALL_RISK_TIERS) {
      const catalogOp: OperationSpec = { operation_id: 'x', risk_tier: tier };
      const catalog = resolveCatalogOperationPolicy({
        operations: { x: catalogOp },
        operation_id: 'x',
        profile: { allowed_operations: ['x'] },
      });
      const simpleForm = simple(tier);
      expect(simpleForm.approval).toBe(catalog.approval);
      expect(simpleForm.verdict).toBe(catalog.verdict);
      expect(simpleForm.effective_risk_tier).toBe(catalog.effective_risk_tier);
    }
  });

  it('emits the lone deny it can — policy_denied from a deny-class default_policy', () => {
    // The kernel manifests carry no default_policy, but the resolver mirrors the
    // catalog path: a write under a `write_default: 'deny'` provider policy denies.
    const denied = simple('write', { write_default: 'deny' });
    expect(denied.verdict).toBe('deny');
    expect(denied.deny_reason).toBe('policy_denied');
    // read under the same policy is unaffected (deny is per-tier).
    expect(simple('read', { write_default: 'deny' }).verdict).toBe('admit');
  });
});

// ════════════════════════════════════════════════════════════════
// applyTrustCeiling — op-risk × stage-trust (RELAX, never escalate)
// ════════════════════════════════════════════════════════════════

describe('applyTrustCeiling — op-risk × stage-trust (slice 3)', () => {
  const verdictAt = (tier: OperationRiskTier, ceiling: TrustCeiling): string =>
    applyTrustCeiling(simple(tier), ceiling).verdict;

  it('ceiling=admin (the contract-less owner default) is BEHAVIOR-PRESERVING — only destructive asks', () => {
    expect(verdictAt('read', 'admin')).toBe('admit');
    expect(verdictAt('write', 'admin')).toBe('admit'); // relaxed (was ask)
    expect(verdictAt('admin', 'admin')).toBe('admit'); // relaxed (was ask)
    expect(verdictAt('destructive', 'admin')).toBe('ask'); // always-floor — never relaxes
  });

  it('a LOW ceiling (contracted AI default) surfaces writes for approval — A-ish', () => {
    // ceiling=read: only reads run un-approved; write/admin/destructive ask.
    expect(verdictAt('read', 'read')).toBe('admit');
    expect(verdictAt('write', 'read')).toBe('ask');
    expect(verdictAt('admin', 'read')).toBe('ask');
    expect(verdictAt('destructive', 'read')).toBe('ask');
  });

  it('ceiling=write relaxes write but not admin', () => {
    expect(verdictAt('write', 'write')).toBe('admit'); // relaxed
    expect(verdictAt('admin', 'write')).toBe('ask'); // above ceiling — kept ask
  });

  it('ceiling=none relaxes nothing an ask-op wants, but reads still admit (never-base)', () => {
    expect(verdictAt('read', 'none')).toBe('admit'); // never base — unchanged
    expect(verdictAt('write', 'none')).toBe('ask');
    expect(verdictAt('admin', 'none')).toBe('ask');
    expect(verdictAt('destructive', 'none')).toBe('ask');
  });

  it('a relaxed ask-op collapses approval → never + verdict → admit, preserving effective_risk_tier', () => {
    const relaxed = applyTrustCeiling(simple('write'), 'admin');
    expect(relaxed.verdict).toBe('admit');
    expect(relaxed.approval).toBe('never');
    expect(relaxed.effective_risk_tier).toBe('write'); // audit signal preserved
    expect(relaxed.granted).toBe(true);
  });

  it('never relaxes an always-floor (destructive / author always-ask) at ANY ceiling', () => {
    for (const ceiling of ALL_CEILINGS) {
      expect(verdictAt('destructive', ceiling)).toBe('ask');
    }
  });

  it('leaves a never-base (read) admitting at every ceiling', () => {
    for (const ceiling of ALL_CEILINGS) {
      expect(verdictAt('read', ceiling)).toBe('admit');
    }
  });

  it('leaves a deny untouched at every ceiling (deny is maximal — trust never loosens it)', () => {
    const denied = simple('write', { write_default: 'deny' });
    for (const ceiling of ALL_CEILINGS) {
      const out = applyTrustCeiling(denied, ceiling);
      expect(out.verdict).toBe('deny');
      expect(out.deny_reason).toBe('policy_denied');
    }
  });

  it('FAILS CLOSED on a malformed ceiling — never relaxes an ask-op to admit (codex finding-1 regression)', () => {
    // The ceiling is persisted trust DATA; a future / cast / corrupted value must keep
    // the base `ask` (fail closed), never fall through to admit via an undefined rank.
    const bogus = 'superuser' as unknown as TrustCeiling;
    expect(applyTrustCeiling(simple('write'), bogus).verdict).toBe('ask');
    expect(applyTrustCeiling(simple('admin'), bogus).verdict).toBe('ask');
    // a read (never-base) still admits — it was never gated by the ceiling at all.
    expect(applyTrustCeiling(simple('read'), bogus).verdict).toBe('admit');
  });

  it('is pure — never mutates the base resolution', () => {
    const base = simple('write');
    const snapshot = JSON.stringify(base);
    applyTrustCeiling(base, 'admin');
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('is MONOTONIC in trust — a higher ceiling never adds approval (relax-only)', () => {
    // For each tier, as the ceiling climbs none→read→write→admin the verdict only
    // ever moves ask→admit, never admit→ask.
    for (const tier of ALL_RISK_TIERS) {
      let sawAdmit = false;
      for (const ceiling of ALL_CEILINGS) {
        const v = verdictAt(tier, ceiling);
        if (v === 'admit') sawAdmit = true;
        // once admitted at a lower ceiling, a higher ceiling must not regress to ask
        if (sawAdmit) expect(v).toBe('admit');
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════
// Coverage — resolver TOTALITY (the necessary condition)
// ════════════════════════════════════════════════════════════════
//
// This proves the resolvers are total over the risk enum — NOT that every real
// ingredient dispatch routes through them. The sufficiency half (walking the actual
// 147-manifest dispatch set via the engine's `isCatalogForm` branch) lives in
// `packages/ingredients/src/__tests__/d-187-slice3-op-risk-dispatch-coverage.test.ts`,
// which has fs access to `community/ingredients/`. Together: totality (here) + the
// real sweep (there) = "every ingredient dispatch resolves an op-risk".

describe('op-risk resolver totality (slice 3 — necessary condition)', () => {
  it('the simple-form resolver is TOTAL over the closed OperationRiskTier enum', () => {
    // No risk tier falls through to an undefined op-risk — the gap the matrix
    // retirement must not open when the chokepoints rewire off the wrapper risk_tier.
    for (const tier of ALL_RISK_TIERS) {
      const r = simple(tier);
      expect(r.effective_risk_tier).toBe(tier);
      expect(r.verdict === 'admit' || r.verdict === 'ask').toBe(true);
    }
  });

  it('both dispatch forms resolve an op-risk for the same tier (the two-path cover)', () => {
    // Simple-form (manifest risk_tier) AND catalog-form (effective_risk_tier) both
    // yield a non-empty op-risk — together they span every ingredient dispatch.
    for (const tier of ALL_RISK_TIERS) {
      expect(simple(tier).effective_risk_tier).toBe(tier);
      const catalog = resolveCatalogOperationPolicy({
        operations: { x: { operation_id: 'x', risk_tier: tier } },
        operation_id: 'x',
        profile: { allowed_operations: ['x'] },
      });
      expect(catalog.effective_risk_tier).toBe(tier);
    }
  });
});
