/** D-177 P6c staged-trust accept-mint pure tests. */

import { describe, expect, it } from 'vitest';

import {
  DELEGATION_RULE_MAX_USES,
  DELEGATION_RULE_TTL_MS,
  DELEGATION_SUGGEST_LOOKBACK_MS,
  delegationRuleMintPlanFromSnapshot,
  delegationRuleSuggestionKeyHash,
  deriveDelegationRuleSuggestionKey,
  type ContractDefinition,
  type ContractScope,
  type DelegationRuleSuggestionSnapshot,
  type OpenProjection,
} from '@recued/contracts';

const NOW = 1_800_200_000_000;

const openProjection = (): OpenProjection => ({
  version: 1,
  args: [
    {
      path: 'to',
      skeleton: '{{config.to}}',
      roots: [
        {
          ref: 'config.to',
          origin: 'config',
          pinned: 'approved@example.test',
        },
      ],
      derived_pinned: 'approved@example.test',
    },
  ],
});

const baseSnapshot = (
  overrides: Partial<DelegationRuleSuggestionSnapshot> = {},
): DelegationRuleSuggestionSnapshot => ({
  channel: 'chat',
  actor: 'user_self',
  ingredient_id: 'mail.send',
  operation_id: 'mail.send',
  connection_name: 'gmail-primary',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  entity_scope: 'deal-1',
  grant_mode: 'exact',
  canonical_payload_hash: 'payload-hash',
  ...overrides,
});

const withoutSnapshotKeys = (
  snapshot: DelegationRuleSuggestionSnapshot,
  keys: readonly (keyof DelegationRuleSuggestionSnapshot)[],
): DelegationRuleSuggestionSnapshot => {
  const copy = { ...snapshot } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as unknown as DelegationRuleSuggestionSnapshot;
};

const ruleFromSnapshot = (
  snapshot: DelegationRuleSuggestionSnapshot,
): ContractDefinition => {
  const key_hash = delegationRuleSuggestionKeyHash(snapshot);
  const plan = delegationRuleMintPlanFromSnapshot(snapshot);
  expect(plan).not.toBeUndefined();
  if (plan === undefined) throw new Error('expected snapshot to mint');

  return {
    contract_id: `ct_rule_${snapshot.grant_mode}`,
    minted_at: NOW,
    minted_by: 'owner',
    display_name: 'Delegation rule',
    scope: plan.scope,
    grant_kind: 'delegation',
    grant_mode: plan.grant_mode,
    bound_recipe: {
      recipe_id: plan.recipe_id,
      recipe_hash: plan.recipe_hash,
    },
    arg_shape_hash: plan.arg_shape_hash,
    risk_tier: plan.risk_tier,
    ...(plan.entity_scope !== undefined ? { entity_scope: plan.entity_scope } : {}),
    ...(plan.canonical_payload_hash !== undefined
      ? { canonical_payload_hash: plan.canonical_payload_hash }
      : {}),
    ...(plan.pinned_projection_hash !== undefined
      ? { pinned_projection_hash: plan.pinned_projection_hash }
      : {}),
    ...(plan.open_projection !== undefined
      ? { open_projection: plan.open_projection }
      : {}),
    expiry_at: NOW + DELEGATION_RULE_TTL_MS,
    max_uses: DELEGATION_RULE_MAX_USES,
    uses_remaining: DELEGATION_RULE_MAX_USES,
    approved_action_ref: key_hash,
  };
};

describe('D-177 P6c delegationRuleMintPlanFromSnapshot', () => {
  it('projects exact-mode snapshots into bounded delegation-rule fields', () => {
    const plan = delegationRuleMintPlanFromSnapshot(baseSnapshot());

    expect(plan).toEqual({
      scope: {
        channels: ['chat'],
        actors: ['user_self'],
        ingredient_ids: ['mail.send'],
        operation_ids: ['mail.send'],
        connection_names: ['gmail-primary'],
      },
      grant_mode: 'exact',
      recipe_id: 'recipe-1',
      recipe_hash: 'recipe-hash-1',
      arg_shape_hash: 'arg-shape-hash',
      risk_tier: 'write',
      canonical_payload_hash: 'payload-hash',
      entity_scope: 'deal-1',
    });

    const absentOptional = delegationRuleMintPlanFromSnapshot(baseSnapshot({
      operation_id: undefined,
      connection_name: undefined,
      entity_scope: undefined,
    }));

    expect(absentOptional).toEqual({
      scope: {
        channels: ['chat'],
        actors: ['user_self'],
        ingredient_ids: ['mail.send'],
      },
      grant_mode: 'exact',
      recipe_id: 'recipe-1',
      recipe_hash: 'recipe-hash-1',
      arg_shape_hash: 'arg-shape-hash',
      risk_tier: 'write',
      canonical_payload_hash: 'payload-hash',
    });
    expect(absentOptional?.scope).not.toHaveProperty('operation_ids');
    expect(absentOptional?.scope).not.toHaveProperty('connection_names');
    expect(absentOptional).not.toHaveProperty('entity_scope');
  });

  it('projects open-mode snapshots with the pinned projection identity', () => {
    const projection = openProjection();
    const plan = delegationRuleMintPlanFromSnapshot(baseSnapshot({
      grant_mode: 'open',
      canonical_payload_hash: undefined,
      pinned_projection_hash: 'projection-hash',
      open_projection: projection,
    }));

    expect(plan).toEqual({
      scope: {
        channels: ['chat'],
        actors: ['user_self'],
        ingredient_ids: ['mail.send'],
        operation_ids: ['mail.send'],
        connection_names: ['gmail-primary'],
      },
      grant_mode: 'open',
      recipe_id: 'recipe-1',
      recipe_hash: 'recipe-hash-1',
      arg_shape_hash: 'arg-shape-hash',
      risk_tier: 'write',
      pinned_projection_hash: 'projection-hash',
      open_projection: projection,
      entity_scope: 'deal-1',
    });
  });

  it('fails closed on malformed snapshots', () => {
    const malformedOpenProjection = { version: 1, args: [] };
    const cases: ReadonlyArray<{
      name: string;
      snapshot: DelegationRuleSuggestionSnapshot;
    }> = [
      { name: 'empty channel', snapshot: baseSnapshot({ channel: '' }) },
      { name: 'empty actor', snapshot: baseSnapshot({ actor: '' }) },
      {
        // STAGED-TRUST OWNER-ONLY (defense in depth vs a hand-shaped suggestion row):
        // a contracted_user snapshot must NOT mint — a door-scoped delegation rule would
        // match every door (scope-bound matching).
        name: 'contracted_user (door) actor — staged-trust owner-only',
        snapshot: baseSnapshot({ actor: 'contracted_user' }),
      },
      { name: 'empty ingredient_id', snapshot: baseSnapshot({ ingredient_id: '' }) },
      { name: 'empty recipe_id', snapshot: baseSnapshot({ recipe_id: '' }) },
      { name: 'empty recipe_hash', snapshot: baseSnapshot({ recipe_hash: '' }) },
      { name: 'empty arg_shape_hash', snapshot: baseSnapshot({ arg_shape_hash: '' }) },
      { name: 'empty operation_id', snapshot: baseSnapshot({ operation_id: '' }) },
      { name: 'empty connection_name', snapshot: baseSnapshot({ connection_name: '' }) },
      { name: 'empty entity_scope', snapshot: baseSnapshot({ entity_scope: '' }) },
      { name: 'admin risk tier', snapshot: baseSnapshot({ risk_tier: 'admin' }) },
      { name: 'read risk tier', snapshot: baseSnapshot({ risk_tier: 'read' }) },
      {
        name: 'destructive risk tier',
        snapshot: baseSnapshot({ risk_tier: 'destructive' }),
      },
      {
        name: 'unknown risk tier',
        snapshot: baseSnapshot({
          risk_tier: 'future' as unknown as DelegationRuleSuggestionSnapshot['risk_tier'],
        }),
      },
      {
        name: 'batch grant mode',
        snapshot: baseSnapshot({
          grant_mode: 'batch' as unknown as DelegationRuleSuggestionSnapshot['grant_mode'],
        }),
      },
      {
        name: 'unknown grant mode',
        snapshot: baseSnapshot({
          grant_mode: 'forever' as unknown as DelegationRuleSuggestionSnapshot['grant_mode'],
        }),
      },
      {
        name: 'absent grant mode',
        snapshot: withoutSnapshotKeys(baseSnapshot(), ['grant_mode']),
      },
      {
        name: 'exact without canonical_payload_hash',
        snapshot: withoutSnapshotKeys(baseSnapshot(), ['canonical_payload_hash']),
      },
      {
        name: 'exact with empty canonical_payload_hash',
        snapshot: baseSnapshot({ canonical_payload_hash: '' }),
      },
      {
        name: 'open without pinned_projection_hash',
        snapshot: baseSnapshot({
          grant_mode: 'open',
          canonical_payload_hash: undefined,
          open_projection: openProjection(),
        }),
      },
      {
        name: 'open with malformed open_projection',
        snapshot: baseSnapshot({
          grant_mode: 'open',
          canonical_payload_hash: undefined,
          pinned_projection_hash: 'projection-hash',
          open_projection: malformedOpenProjection,
        }),
      },
    ];

    for (const testCase of cases) {
      expect(
        delegationRuleMintPlanFromSnapshot(testCase.snapshot),
        testCase.name,
      ).toBeUndefined();
    }
  });
});

describe('D-177 P6c delegation-rule bounds constants', () => {
  it('pins TTL and max-use ceilings', () => {
    expect(DELEGATION_RULE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(DELEGATION_RULE_TTL_MS).toBe(DELEGATION_SUGGEST_LOOKBACK_MS);
    expect(DELEGATION_RULE_MAX_USES).toBe(100);
  });
});

describe('D-177 P6c delegation-rule suppression key round trip', () => {
  it.each([
    ['exact', baseSnapshot()],
    [
      'open',
      baseSnapshot({
        grant_mode: 'open',
        canonical_payload_hash: undefined,
        pinned_projection_hash: 'projection-hash',
        open_projection: openProjection(),
      }),
    ],
  ] as const)('keeps the same suggestion key after %s rule minting', (_mode, snapshot) => {
    const sessionGrant: ContractDefinition = {
      contract_id: `ct_session_${snapshot.grant_mode}`,
      minted_at: NOW - 1_000,
      minted_by: 'user:1',
      display_name: 'Session grant',
      scope: {
        channels: [snapshot.channel],
        actors: [snapshot.actor],
        ingredient_ids: [snapshot.ingredient_id],
        ...(snapshot.operation_id !== undefined
          ? { operation_ids: [snapshot.operation_id] }
          : {}),
        ...(snapshot.connection_name !== undefined
          ? { connection_names: [snapshot.connection_name] }
          : {}),
      } satisfies ContractScope,
      grant_kind: 'session',
      grant_mode: snapshot.grant_mode,
      channel_session_id: 's-1',
      bound_recipe: {
        recipe_id: snapshot.recipe_id,
        recipe_hash: snapshot.recipe_hash,
      },
      arg_shape_hash: snapshot.arg_shape_hash,
      risk_tier: snapshot.risk_tier,
      ...(snapshot.entity_scope !== undefined
        ? { entity_scope: snapshot.entity_scope }
        : {}),
      ...(snapshot.canonical_payload_hash !== undefined
        ? { canonical_payload_hash: snapshot.canonical_payload_hash }
        : {}),
      ...(snapshot.pinned_projection_hash !== undefined
        ? { pinned_projection_hash: snapshot.pinned_projection_hash }
        : {}),
      ...(snapshot.open_projection !== undefined
        ? { open_projection: snapshot.open_projection }
        : {}),
      expiry_at: NOW + 60_000,
      max_uses: 3,
      uses_remaining: 2,
      approved_action_ref: 'checkpoint-1',
    };
    const derived = deriveDelegationRuleSuggestionKey(sessionGrant);
    expect(derived).toEqual(snapshot);
    if (derived === undefined) throw new Error('expected session grant key');
    const keyHash = delegationRuleSuggestionKeyHash(derived);

    const rule = ruleFromSnapshot(snapshot);

    expect(rule.grant_kind).toBe('delegation');
    expect(rule.grant_mode).toBe(snapshot.grant_mode);
    expect(rule).not.toHaveProperty('channel_session_id');
    expect(rule.approved_action_ref).toBe(keyHash);
    const derivedFromRule = deriveDelegationRuleSuggestionKey(rule);
    expect(derivedFromRule).toEqual(snapshot);
    if (derivedFromRule === undefined) throw new Error('expected delegation rule key');
    expect(delegationRuleSuggestionKeyHash(derivedFromRule)).toBe(keyHash);
  });
});
