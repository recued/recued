/** D-166 Slice 4d.2 — `mergeRoleResults` (per-role field ownership; resolves the
 *  4b deferred P2) + `projectToResolution` (tighten a base CatalogOperationResolution
 *  with the merged canonical policy) + the `validateRoleOwnership` ratchet. All
 *  pure — no storage, no backend. */
import { describe, it, expect } from 'vitest';

import {
  ROLE_OWNED_FIELDS,
  mergeRoleResults,
  projectToResolution,
  validateRoleOwnership,
  composeForRole,
  type RoleComposition,
  type ScanFn,
} from '../contract-dispatch.js';
import { D165_CONTRACT_SCHEMA } from '../contract-schema.js';
import type { MergeConflict } from '../contract-merge.js';
import type { CatalogOperationResolution } from '../ingredient-catalog.js';

const policy = (
  p: Record<string, unknown>,
  conflicts: MergeConflict[] = [],
): RoleComposition => ({ kind: 'policy', policy: p, conflicts });

describe('validateRoleOwnership (D-166 Slice 4d.2 ratchet)', () => {
  it('is consistent: disjoint, lattice-valid, and covers every projection target', () => {
    expect(validateRoleOwnership()).toEqual([]);
  });

  it('every owned field is a real canonical lattice field (spot-check the map)', () => {
    // D-187 — the matrix's per-cell owned fields (approval_tier / allowed_risk_tiers /
    // allowed_kinds / denied_ingredient_ids) were dropped with the policy matrix;
    // each role now owns only its surviving canonical fields.
    expect(ROLE_OWNED_FIELDS.approval_composition).toEqual(['approval']);
    expect(ROLE_OWNED_FIELDS.risk_override).toEqual(['max_risk_without_approval']);
    expect(ROLE_OWNED_FIELDS.timeout_override).toEqual(['timeout_ms']);
    expect(ROLE_OWNED_FIELDS.cache_ttl_override).toEqual(['cache_ttl_ms']);
    expect(ROLE_OWNED_FIELDS.grant_resolution).toContain('allowed');
    expect(ROLE_OWNED_FIELDS.grant_resolution).not.toContain('allowed_kinds');
    expect(ROLE_OWNED_FIELDS.grant_resolution).not.toContain('denied_ingredient_ids');
  });
});

describe('mergeRoleResults (per-role field ownership)', () => {
  it('takes each field from its OWNING role and drops the same field where it leaked', () => {
    // `approval` leaks into grant_resolution's composition (via the grant scope)
    // but is OWNED by approval_composition — the owner's value must win.
    const merged = mergeRoleResults({
      grant_resolution: policy({ allowed: true, approval: 'never', risk_tier: 'write' }),
      approval_composition: policy({ approval: 'always' }),
      risk_override: policy({ max_risk_without_approval: 'read' }),
    });
    expect(merged.policy).toEqual({
      allowed: true,
      risk_tier: 'write',
      approval: 'always', // from approval_composition, NOT grant_resolution's leak
      max_risk_without_approval: 'read',
    });
  });

  it('drops fields a role does not own (timeout leaking into approval_composition)', () => {
    const merged = mergeRoleResults({
      approval_composition: policy({ approval: 'ask', timeout_ms: 5000 }),
      timeout_override: policy({ timeout_ms: 1000 }),
    });
    // approval_composition contributes only `approval`; `timeout_ms` is taken
    // from its owner (timeout_override).
    expect(merged.policy).toEqual({ approval: 'ask', timeout_ms: 1000 });
  });

  it('skips inventory compositions and absent roles', () => {
    const merged = mergeRoleResults({
      ingredient_inventory: { kind: 'inventory', rows: [{ segments: ['x'], value: { a: 1 } }] },
      approval_composition: policy({ approval: 'ask' }),
    });
    expect(merged.policy).toEqual({ approval: 'ask' });
    expect(merged.conflicts).toEqual([]);
  });

  it('unions + dedups conflicts across roles', () => {
    const conflict = {
      kind: 'value' as const,
      merge_precedence: 30,
      field: 'approval',
      rules: ['union' as const],
      values: ['ask', 'always'],
    };
    // The same conflict surfaces in two roles the scope applies_to — collapsed to one.
    const merged = mergeRoleResults({
      grant_resolution: policy({ allowed: true }, [conflict]),
      approval_composition: policy({ approval: 'ask' }, [conflict]),
    });
    expect(merged.conflicts).toEqual([conflict]);
  });

  it('composes end-to-end from composeForRole over the real schema (override only)', () => {
    // One user override denying a specific operation, resolved through composeForRole
    // for each policy role, then merged. Mirrors the 4d.4 dispatch path.
    const rows: Record<string, Array<{ segments: string[]; value: Record<string, unknown> }>> = {
      override: [
        {
          segments: ['contracted_user', 'deal-reader-hubspot', 'read_deals'],
          value: { denied: true, approval: 'always' },
        },
      ],
    };
    const scan: ScanFn = (scope, prefix) =>
      (rows[scope] ?? []).filter((r) =>
        prefix.every((seg, i) => r.segments[i] === seg),
      );
    const context = {
      actor: 'contracted_user',
      ingredient_id: 'deal-reader-hubspot',
      operation_id: 'read_deals',
    };
    const ck = D165_CONTRACT_SCHEMA.composite_keys;
    const merged = mergeRoleResults({
      grant_resolution: composeForRole(ck, 'grant_resolution', context, scan),
      approval_composition: composeForRole(ck, 'approval_composition', context, scan),
      risk_override: composeForRole(ck, 'risk_override', context, scan),
    });
    // denied:true → allowed:false; legacy actor-scoped approval tightens too.
    expect(merged.policy).toEqual({ allowed: false, approval: 'always' });
  });
});

describe('projectToResolution (tighten a base resolution)', () => {
  const baseAdmit: CatalogOperationResolution = {
    verdict: 'admit',
    operation_id: 'deal-reader-hubspot.read_deals',
    effective_risk_tier: 'read',
    operation_group: 'deals',
    approval: 'never',
    authorization_provenance: { pre_lift_approval: 'never' },
    granted: true,
  };

  it('returns an already-deny base unchanged (preserves its deny_reason)', () => {
    const baseDeny: CatalogOperationResolution = {
      ...baseAdmit,
      verdict: 'deny',
      granted: false,
      deny_reason: 'operation_not_granted',
    };
    // Even a deny-flag + approval escalation can't loosen — deny stays deny.
    expect(projectToResolution({ allowed: false, approval: 'always' }, baseDeny)).toBe(baseDeny);
  });

  it('deny-flag (allowed:false) forces deny with operation_not_granted', () => {
    const out = projectToResolution({ allowed: false }, baseAdmit);
    expect(out.verdict).toBe('deny');
    expect(out.granted).toBe(false);
    expect(out.deny_reason).toBe('operation_not_granted');
  });

  it('escalates approval and flips admit → ask', () => {
    const out = projectToResolution({ approval: 'ask' }, baseAdmit);
    expect(out.approval).toBe('ask');
    expect(out.verdict).toBe('ask');
  });

  it('never downgrades a stricter base approval', () => {
    const baseAlways: CatalogOperationResolution = { ...baseAdmit, verdict: 'ask', approval: 'always' };
    const out = projectToResolution({ approval: 'ask' }, baseAlways);
    expect(out).toBe(baseAlways); // no change → same reference
  });

  it('max_risk_without_approval ceiling forces approval when effective risk exceeds it', () => {
    const baseAdminAdmit: CatalogOperationResolution = {
      ...baseAdmit,
      effective_risk_tier: 'admin',
    };
    // ceiling 'write' < effective 'admin' → must ask.
    const out = projectToResolution({ max_risk_without_approval: 'write' }, baseAdminAdmit);
    expect(out.approval).toBe('ask');
    expect(out.verdict).toBe('ask');
  });

  it('ceiling at or above the effective risk does not force approval', () => {
    // ceiling 'admin' ≥ effective 'admin' → no escalation; unchanged.
    const baseAdminAdmit: CatalogOperationResolution = { ...baseAdmit, effective_risk_tier: 'admin' };
    expect(projectToResolution({ max_risk_without_approval: 'admin' }, baseAdminAdmit)).toBe(
      baseAdminAdmit,
    );
  });

  it('ceiling none forces approval even for a read', () => {
    const out = projectToResolution({ max_risk_without_approval: 'none' }, baseAdmit);
    expect(out.approval).toBe('ask');
    expect(out.verdict).toBe('ask');
  });

  it('ignores timeout_ms / cache_ttl_ms (no resolution slot — Invariants 6/7)', () => {
    expect(projectToResolution({ timeout_ms: 1000, cache_ttl_ms: 5000 }, baseAdmit)).toBe(baseAdmit);
  });

  it('an empty canonical policy leaves the base untouched', () => {
    expect(projectToResolution({}, baseAdmit)).toBe(baseAdmit);
  });
});

// D-166 P2 policy_matrix composition (baseline vs contract overlay) was pinned
// here; D-187 retired the policy_matrix scope. The generic composition algebra
// (composeForRole / stricter_wins / optional_tail_match) stays covered by the
// override + grant scopes above.
