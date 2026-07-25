/** D-211 Slice 1 — pure-resolver coverage for the owner override REPLACE step
 *  (`owner_override` on the catalog / cli / simple-form resolvers) + the
 *  `clampToFloor` clamp (D-211 §1/§2):
 *
 *  - owner `risk` and `approval` replace the corresponding PACK operation
 *    fields; the existing profile/access/trust/tightening flow then runs;
 *  - owner `approval` REPLACES the authored default (never stricter-wins),
 *    clamped to `[floor(effective_risk), always]` — a below-floor stored value
 *    resolves fail-closed AT the floor and surfaces `approval_clamped_from`;
 *  - absent `owner_override` ⇒ behavior byte-identical to pre-D-211
 *    (regression pin);
 *  - steps 5/6 (trust-ceiling relax, profile `approval_defaults` stricter-wins)
 *    run AFTER the replace, exactly as before.
 */

import { describe, expect, it } from 'vitest';

import {
  clampToFloor,
  resolveCatalogOperationPolicy,
  resolveCliReachabilityPolicy,
  resolveSimpleFormOperationPolicy,
} from '../ingredient-catalog.js';
import type {
  ConnectionOperationProfile,
  OperationApproval,
  OperationRiskTier,
  OperationSpec,
  OwnerOverridePolicy,
} from '../ingredient-catalog.js';
import {
  OWNER_OPERATION_SCOPE,
  operationSpecHash,
  readOwnerOperationOverride,
} from '../owner-operation-override.js';
import type { ContractRowLike, ScanFn } from '../contract-dispatch.js';
import {
  admitByOpRisk,
  admitByOpRiskWithoutQualityLifts,
} from '../op-risk-admission.js';

const op = (
  risk_tier: OperationRiskTier,
  extras: Partial<OperationSpec> = {},
): OperationSpec => ({
  operation_id: 'pub/cat.x',
  risk_tier,
  groups: ['g'],
  ...extras,
});

const profile = (
  extras: Partial<ConnectionOperationProfile> = {},
): ConnectionOperationProfile => ({
  allowed_operations: ['x'],
  ...extras,
});

const resolve = (
  operation: OperationSpec,
  extras: {
    profile?: ConnectionOperationProfile | null;
    owner_override?: OwnerOverridePolicy;
  } = {},
) =>
  resolveCatalogOperationPolicy({
    operations: { x: operation },
    operation_id: 'x',
    profile: Object.prototype.hasOwnProperty.call(extras, 'profile')
      ? (extras.profile ?? null)
      : profile(),
    ...(extras.owner_override !== undefined
      ? { owner_override: extras.owner_override }
      : {}),
  });

describe('D-211 shared owner-ruling row reader', () => {
  const rows: readonly ContractRowLike[] = [
    {
      segments: ['pub/cat', 'pub/cat.x'],
      value: { risk: 'write', approval: 'never', op_hash: 'h1' },
    },
  ];
  const scan: ScanFn = (scope, prefix) =>
    scope === OWNER_OPERATION_SCOPE
      ? rows.filter((row) => prefix.every((segment, i) => row.segments[i] === segment))
      : [];

  it('reads one exact actorless operation row', () => {
    expect(readOwnerOperationOverride({
      scan,
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.x',
    })).toEqual({ risk: 'write', approval: 'never' });
  });

  it('is global across actors/contracts because neither is part of the key', () => {
    expect(readOwnerOperationOverride({
      scan,
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.x',
    })).toEqual({ risk: 'write', approval: 'never' });
    expect(readOwnerOperationOverride({
      scan,
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.other',
    })).toBeUndefined();
    expect(readOwnerOperationOverride({
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.x',
    })).toBeUndefined();
  });
});

describe('D-211 clampToFloor exactness', () => {
  it('clamps below-floor values UP to the floor and passes at/above-floor values through', () => {
    const cases: ReadonlyArray<{
      approval: OperationApproval;
      risk: OperationRiskTier;
      expected: OperationApproval;
    }> = [
      // read floor = never: everything passes through.
      { approval: 'never', risk: 'read', expected: 'never' },
      { approval: 'ask', risk: 'read', expected: 'ask' },
      { approval: 'always', risk: 'read', expected: 'always' },
      // write/admin floor = ask: `never` clamps up, ask/always pass.
      { approval: 'never', risk: 'write', expected: 'ask' },
      { approval: 'ask', risk: 'write', expected: 'ask' },
      { approval: 'always', risk: 'write', expected: 'always' },
      { approval: 'never', risk: 'admin', expected: 'ask' },
      // destructive floor = always: everything clamps to always.
      { approval: 'never', risk: 'destructive', expected: 'always' },
      { approval: 'ask', risk: 'destructive', expected: 'always' },
      { approval: 'always', risk: 'destructive', expected: 'always' },
    ];
    for (const { approval, risk, expected } of cases) {
      expect(clampToFloor(approval, risk)).toBe(expected);
    }
  });
});

describe('D-211 owner pair overlays the pack operation before prior flow', () => {
  it('the existing profile risk escalation still tightens after owner risk replaces the pack value', () => {
    // Owner changes the pack read default to write. The unchanged connection
    // profile then escalates that effective op to destructive.
    const result = resolve(op('read'), {
      profile: profile({ risk_overrides: { x: 'destructive' } }),
      owner_override: { risk: 'write' },
    });
    expect(result.effective_risk_tier).toBe('destructive');
    expect(result.approval).toBe('always');
    expect(result.verdict).toBe('ask');
  });

  it('owner risk downward on a destructive op moves the floor coherently to ask', () => {
    const result = resolve(op('destructive'), { owner_override: { risk: 'write' } });
    expect(result.effective_risk_tier).toBe('write');
    expect(result.approval).toBe('ask');
  });

  it('owner risk upward escalates the declared tier', () => {
    const result = resolve(op('read'), { owner_override: { risk: 'destructive' } });
    expect(result.effective_risk_tier).toBe('destructive');
    expect(result.approval).toBe('always');
  });
});

describe('D-211 owner approval replace + fail-closed clamp', () => {
  it('owner approval REPLACES the authored default (authored always → owner never on a read admits)', () => {
    const result = resolve(op('read', { approval: 'always' }), {
      owner_override: { approval: 'never' },
    });
    expect(result.approval).toBe('never');
    expect(result.verdict).toBe('admit');
    expect(result.approval_clamped_from).toBeUndefined();
  });

  it('a below-floor stored approval resolves AT the floor and surfaces approval_clamped_from', () => {
    // `never` on a write is below the ask floor — the write-gate refuses it,
    // so this is the hand-stored case: fail-closed at the floor + surfaced.
    const result = resolve(op('write'), { owner_override: { approval: 'never' } });
    expect(result.approval).toBe('ask');
    expect(result.verdict).toBe('ask');
    expect(result.approval_clamped_from).toBe('never');
  });

  it('a below-floor stored approval on a destructive op clamps to always', () => {
    const result = resolve(op('destructive'), { owner_override: { approval: 'ask' } });
    expect(result.approval).toBe('always');
    expect(result.approval_clamped_from).toBe('ask');
  });

  it('the profile approval_defaults stricter-wins step runs AFTER the replace, unchanged (step 6)', () => {
    // Owner silences the read, but the connection profile's per-op escalation
    // still tightens — D-211 §2 changes the BASE only; steps 5/6 stay as-is.
    const result = resolve(op('read', { approval: 'always' }), {
      profile: profile({ approval_defaults: { x: 'always' } }),
      owner_override: { approval: 'never' },
    });
    expect(result.approval).toBe('always');
    expect(result.verdict).toBe('ask');
  });

  it('owner approval has ZERO effect on the grant plane — an ungranted op stays denied', () => {
    const result = resolve(op('read'), {
      profile: profile({ allowed_operations: [] }),
      owner_override: { approval: 'never', risk: 'read' },
    });
    expect(result.verdict).toBe('deny');
    expect(result.deny_reason).toBe('operation_not_granted');
  });

  it('owner approval occupies the explicit pack-op slot before the existing provider fallback', () => {
    const result = resolveCatalogOperationPolicy({
      operations: { x: op('write') },
      operation_id: 'x',
      profile: profile(),
      default_policy: { write_default: 'deny' },
      owner_override: { approval: 'ask' },
    });
    expect(result.verdict).toBe('ask');
    expect(result.approval).toBe('ask');
    expect(result.deny_reason).toBeUndefined();
    expect(result.approval_clamped_from).toBeUndefined();
  });

  it('the provider fallback still denies when neither pack nor owner declares approval', () => {
    const result = resolveCatalogOperationPolicy({
      operations: { x: op('write') },
      operation_id: 'x',
      profile: profile(),
      default_policy: { write_default: 'deny' },
    });
    expect(result.verdict).toBe('deny');
    expect(result.deny_reason).toBe('policy_denied');
  });
});

describe('D-211 threading through all three public resolvers', () => {
  it('cli: owner never on an authored-always read admits; reachability stays the sole grant plane', () => {
    const silenced = resolveCliReachabilityPolicy({
      operations: { x: op('read', { approval: 'always' }) },
      operation_id: 'x',
      reachable: true,
      owner_override: { approval: 'never' },
    });
    expect(silenced.verdict).toBe('admit');
    expect(silenced.approval).toBe('never');

    const unreachable = resolveCliReachabilityPolicy({
      operations: { x: op('read', { approval: 'always' }) },
      operation_id: 'x',
      reachable: false,
      owner_override: { approval: 'never' },
    });
    expect(unreachable.verdict).toBe('deny');
    expect(unreachable.deny_reason).toBe('cli_reachability_disabled');
  });

  it('simple-form: owner always on a read holds it for approval', () => {
    const result = resolveSimpleFormOperationPolicy({
      slug: 'recued/core.read-thing',
      risk_tier: 'read',
      owner_override: { approval: 'always' },
    });
    expect(result.verdict).toBe('ask');
    expect(result.approval).toBe('always');
  });

  it('simple-form: offers never-ask only when that exact ruling clears every review lift', () => {
    const source = {
      channel: 'user' as const,
      actor: 'user_self' as const,
      user_id: 'u1',
      client_token_id: 'c1',
    };
    expect(admitByOpRisk({
      slug: 'ordinary-read',
      risk_tier: 'read',
      ceiling: 'admin',
      source,
      owner_override: { approval: 'always' },
    })).toMatchObject({
      verdict: 'ask',
      owner_override_offer: {
        kind: 'never_ask',
        ingredient_id: 'ordinary-read',
        operation_id: 'ordinary-read',
        op_hash: operationSpecHash({
          operation_id: 'ordinary-read',
          risk_tier: 'read',
        }),
        approval: 'never',
      },
    });
    expect(admitByOpRisk({
      slug: 'commitment-propose',
      risk_tier: 'read',
      ceiling: 'admin',
      source,
      owner_override: { approval: 'always' },
    })).not.toHaveProperty('owner_override_offer');
  });

  it('simple-form: carries a held hand-stored clamp marker to the ask decision', () => {
    expect(admitByOpRiskWithoutQualityLifts({
      slug: 'write-op',
      risk_tier: 'write',
      ceiling: 'read',
      owner_override: { approval: 'never' },
    })).toMatchObject({
      verdict: 'ask',
      approval_clamped_from: 'never',
    });
  });
});

describe('D-211 regression pin — absent owner_override is byte-identical to pre-D-211', () => {
  it('resolves identically with the key omitted and with owner_override: undefined', () => {
    const fixtures: ReadonlyArray<OperationSpec> = [
      op('read'),
      op('read', { approval: 'always' }),
      op('write'),
      op('write', { approval: 'always' }),
      op('admin'),
      op('destructive'),
    ];
    for (const operation of fixtures) {
      const bare = resolve(operation);
      const explicit = resolveCatalogOperationPolicy({
        operations: { x: operation },
        operation_id: 'x',
        profile: profile(),
      });
      expect(bare).toEqual(explicit);
      // No clamp marker ever appears on the authored path.
      expect(bare.approval_clamped_from).toBeUndefined();
    }
  });

  it('pins the exact pre-D-211 outputs for the four tiers on the authored path', () => {
    expect(resolve(op('read'))).toEqual({
      verdict: 'admit',
      operation_id: 'pub/cat.x',
      effective_risk_tier: 'read',
      operation_group: 'g',
      approval: 'never',
      authorization_provenance: { pre_lift_approval: 'never' },
      granted: true,
    });
    expect(resolve(op('write'))).toEqual({
      verdict: 'ask',
      operation_id: 'pub/cat.x',
      effective_risk_tier: 'write',
      operation_group: 'g',
      approval: 'ask',
      authorization_provenance: { pre_lift_approval: 'ask' },
      granted: true,
    });
    expect(resolve(op('destructive'))).toEqual({
      verdict: 'ask',
      operation_id: 'pub/cat.x',
      effective_risk_tier: 'destructive',
      operation_group: 'g',
      approval: 'always',
      authorization_provenance: { pre_lift_approval: 'always' },
      granted: true,
    });
    // Profile risk escalation without an owner ruling — the composed path.
    expect(
      resolve(op('read'), { profile: profile({ risk_overrides: { x: 'write' } }) }),
    ).toEqual({
      verdict: 'ask',
      operation_id: 'pub/cat.x',
      effective_risk_tier: 'write',
      operation_group: 'g',
      approval: 'ask',
      authorization_provenance: { pre_lift_approval: 'ask' },
      granted: true,
    });
  });
});
