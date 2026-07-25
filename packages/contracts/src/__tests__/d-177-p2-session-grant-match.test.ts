/** D-177 P2 session-grant match predicate tests. */

import { describe, expect, it } from 'vitest';

import {
  matchesSessionGrant,
  type ContractDefinition,
  type RiskTier,
  type SessionGrantMatchContext,
} from '@recued/contracts';

const NOW_MS = 1_800_000_000_000;

const baseGrant = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_session_1',
  minted_at: NOW_MS - 1_000,
  minted_by: 'owner:user-1',
  display_name: 'Allow this session',
  scope: {
    channels: ['chat'],
    actors: ['user_self'],
    ingredient_ids: ['mail.send'],
    operation_ids: ['mail.send'],
    connection_names: ['gmail-primary'],
  },
  grant_kind: 'session',
  grant_mode: 'exact',
  channel_session_id: 's',
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  arg_shape_hash: 'arg-shape-hash',
  // D-177 P3 (codex HIGH fold) — the row pins the approved tier; the
  // matcher requires equality with the envelope's tier.
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  expiry_at: NOW_MS + 60_000,
  max_uses: 3,
  uses_remaining: 3,
  approved_action_ref: 'checkpoint-1',
  ...overrides,
});

const baseCtx = (
  overrides: Partial<SessionGrantMatchContext> = {},
): SessionGrantMatchContext => ({
  channel: 'chat',
  actor: 'user_self',
  channel_session_id: 's',
  ingredient_slug: 'mail.send',
  operation_id: 'mail.send',
  connection_name: 'gmail-primary',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  risk_tier: 'write',
  arg_shape_hash: 'arg-shape-hash',
  canonical_payload_hash: 'payload-hash',
  ...overrides,
});

const withoutGrantKeys = (
  grant: ContractDefinition,
  keys: readonly (keyof ContractDefinition)[],
): ContractDefinition => {
  const copy = { ...grant } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as unknown as ContractDefinition;
};

const matches = (
  grant: ContractDefinition,
  ctx: SessionGrantMatchContext = baseCtx(),
): boolean => matchesSessionGrant(grant, ctx, NOW_MS);

describe('D-177 P2 matchesSessionGrant common predicate', () => {
  it('returns true for a full exact-mode match with explicit and absent grant_mode', () => {
    expect(matches(baseGrant())).toBe(true);
    expect(matches(withoutGrantKeys(baseGrant(), ['grant_mode']))).toBe(true);
  });

  it('requires explicit session grant_kind', () => {
    expect(matches(withoutGrantKeys(baseGrant(), ['grant_kind']))).toBe(false);
    expect(matches(baseGrant({ grant_kind: 'standing' }))).toBe(false);
    expect(matches(baseGrant({ grant_kind: 'forever' } as unknown as ContractDefinition))).toBe(false);
  });

  it('requires a live row', () => {
    expect(matches(baseGrant({ revoked_at: NOW_MS - 1 }))).toBe(false);
    expect(matches(baseGrant({ expiry_at: NOW_MS - 1 }))).toBe(false);
    expect(matches(baseGrant({ uses_remaining: 0 }))).toBe(false);
  });

  it('requires session grants to be bounded by expiry and remaining uses', () => {
    expect(matches(withoutGrantKeys(baseGrant(), ['expiry_at']))).toBe(false);
    expect(matches(baseGrant({ expiry_at: null } as unknown as ContractDefinition))).toBe(false);
    expect(matches(withoutGrantKeys(baseGrant(), ['uses_remaining']))).toBe(false);
    expect(matches(baseGrant({ uses_remaining: null } as unknown as ContractDefinition))).toBe(false);
  });

  it('requires a non-empty matching channel_session_id', () => {
    expect(matches(withoutGrantKeys(baseGrant(), ['channel_session_id']))).toBe(false);
    expect(matches(baseGrant({ channel_session_id: null } as unknown as ContractDefinition))).toBe(false);
    expect(matches(baseGrant({ channel_session_id: '' }))).toBe(false);
    expect(matches(baseGrant({ channel_session_id: 'other-session' }))).toBe(false);
  });

  it('allows only write and admin risk tiers to grant-match', () => {
    for (const risk_tier of ['read', 'destructive'] satisfies RiskTier[]) {
      expect(matches(baseGrant({ risk_tier }), baseCtx({ risk_tier })), risk_tier).toBe(false);
    }
    for (const risk_tier of ['write', 'admin'] satisfies RiskTier[]) {
      expect(matches(baseGrant({ risk_tier }), baseCtx({ risk_tier })), risk_tier).toBe(true);
    }
  });

  it('requires the grant to pin the approved tier and the envelope to dispatch at exactly it', () => {
    // D-177 P3 (codex HIGH fold) — set-membership alone would let a grant
    // minted for a `write` envelope absorb a later `admin`-tier ask for the
    // same call after a manifest/policy re-classification. The grant must
    // carry the approved tier; absent or unequal fails closed.
    expect(matches(withoutGrantKeys(baseGrant(), ['risk_tier']))).toBe(false);
    expect(matches(baseGrant({ risk_tier: '' } as unknown as ContractDefinition))).toBe(false);
    expect(matches(baseGrant({ risk_tier: 'write' }), baseCtx({ risk_tier: 'admin' }))).toBe(false);
    expect(matches(baseGrant({ risk_tier: 'admin' }), baseCtx({ risk_tier: 'write' }))).toBe(false);
    expect(matches(baseGrant({ risk_tier: 'admin' }), baseCtx({ risk_tier: 'admin' }))).toBe(true);
  });

  it('requires the ingredient axis to explicitly contain the dispatched slug', () => {
    expect(matches(baseGrant({ scope: { channels: ['chat'], actors: ['user_self'] } }))).toBe(false);
    expect(matches(baseGrant({ scope: { ...baseGrant().scope, ingredient_ids: [] } }))).toBe(false);
    expect(matches(baseGrant({ scope: { ...baseGrant().scope, ingredient_ids: ['calendar.create'] } }))).toBe(false);
    expect(matches(baseGrant({ scope: { ...baseGrant().scope, ingredient_ids: ['mail.send'] } }))).toBe(true);
  });

  it('applies wildcard, restricted, absent-context, and mismatch semantics across scope axes', () => {
    expect(matches(baseGrant({
      scope: {
        channels: [],
        actors: [],
        ingredient_ids: ['mail.send'],
        operation_ids: [],
        connection_names: [],
      },
    }))).toBe(true);

    expect(matches(baseGrant({
      scope: {
        channels: ['chat'],
        actors: ['user_self'],
        ingredient_ids: ['mail.send'],
        operation_ids: ['mail.send'],
        connection_names: ['gmail-primary'],
      },
    }))).toBe(true);

    expect(matches(
      baseGrant({ scope: { ...baseGrant().scope, operation_ids: ['mail.send'] } }),
      baseCtx({ operation_id: undefined }),
    )).toBe(false);
    expect(matches(
      baseGrant({ scope: { ...baseGrant().scope, connection_names: ['gmail-primary'] } }),
      baseCtx({ connection_name: undefined }),
    )).toBe(false);
    expect(matches(baseGrant({ scope: { ...baseGrant().scope, channels: ['mcp'] } }))).toBe(false);
    expect(matches(baseGrant({ scope: { ...baseGrant().scope, actors: ['contracted_user'] } }))).toBe(false);
    expect(matches(baseGrant({ scope: { ...baseGrant().scope, operation_ids: ['mail.delete'] } }))).toBe(false);
    expect(matches(baseGrant({ scope: { ...baseGrant().scope, connection_names: ['gmail-alt'] } }))).toBe(false);
  });

  it('requires a non-empty matching bound recipe identity', () => {
    expect(matches(withoutGrantKeys(baseGrant(), ['bound_recipe']))).toBe(false);
    expect(matches(baseGrant({ bound_recipe: null } as unknown as ContractDefinition))).toBe(false);
    expect(matches(baseGrant({ bound_recipe: { recipe_id: 'other-recipe', recipe_hash: 'recipe-hash-1' } }))).toBe(false);
    expect(matches(baseGrant({ bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'other-hash' } }))).toBe(false);
    expect(matches(baseGrant({ bound_recipe: { recipe_id: '', recipe_hash: 'recipe-hash-1' } }))).toBe(false);
    expect(matches(baseGrant({ bound_recipe: { recipe_id: 'recipe-1', recipe_hash: '' } }))).toBe(false);
  });

  it('requires a non-empty matching arg_shape_hash', () => {
    expect(matches(withoutGrantKeys(baseGrant(), ['arg_shape_hash']))).toBe(false);
    expect(matches(baseGrant({ arg_shape_hash: '' }))).toBe(false);
    expect(matches(baseGrant({ arg_shape_hash: 'other-shape' }))).toBe(false);
  });

  it('matches entity_scope only when both are absent or equal', () => {
    expect(matches(baseGrant())).toBe(true);
    expect(matches(baseGrant({ entity_scope: 'deal-1' }))).toBe(false);
    expect(matches(baseGrant(), baseCtx({ entity_scope: 'deal-1' }))).toBe(false);
    expect(matches(
      baseGrant({ entity_scope: 'deal-1' }),
      baseCtx({ entity_scope: 'deal-1' }),
    )).toBe(true);
    expect(matches(baseGrant({ entity_scope: null } as unknown as ContractDefinition))).toBe(true);
  });
});

describe('D-177 P2 matchesSessionGrant per-mode predicate', () => {
  it('requires canonical_payload_hash equality for exact mode', () => {
    expect(matches(baseGrant({ canonical_payload_hash: 'other-payload' }))).toBe(false);
    expect(matches(withoutGrantKeys(baseGrant(), ['canonical_payload_hash']))).toBe(false);
    expect(matches(baseGrant({ canonical_payload_hash: '' }))).toBe(false);
  });

  it('batch mode candidate-matches an UNCONSUMED member with hash equality (P5a, N.10)', () => {
    // Live since P5a: an unconsumed member whose hash equals the
    // envelope's is a candidate match (the atomic claim is the separate
    // proceed-point consumption).
    expect(matches(baseGrant({
      grant_mode: 'batch',
      batch_members: [
        { member_id: 'm-1', canonical_payload_hash: 'payload-hash' },
      ],
    }))).toBe(true);

    // A consumed member never matches again (replay re-asks).
    expect(matches(baseGrant({
      grant_mode: 'batch',
      batch_members: [
        { member_id: 'm-1', canonical_payload_hash: 'payload-hash', consumed_at: 1 },
      ],
    }))).toBe(false);

    // No member with the envelope's hash → no match.
    expect(matches(baseGrant({
      grant_mode: 'batch',
      batch_members: [
        { member_id: 'm-1', canonical_payload_hash: 'other-payload' },
      ],
    }))).toBe(false);

    // Duplicate hashes are distinct members — one consumed leaves the
    // twin claimable.
    expect(matches(baseGrant({
      grant_mode: 'batch',
      batch_members: [
        { member_id: 'm-1', canonical_payload_hash: 'payload-hash', consumed_at: 1 },
        { member_id: 'm-2', canonical_payload_hash: 'payload-hash' },
      ],
    }))).toBe(true);

    // Absent / empty member set fails closed.
    expect(matches(baseGrant({ grant_mode: 'batch' }))).toBe(false);
    expect(matches(baseGrant({ grant_mode: 'batch', batch_members: [] }))).toBe(false);

    // A member with an empty hash is inert even against an empty
    // envelope hash (defense-in-depth — the mint refuses empty hashes).
    expect(matches(
      baseGrant({
        grant_mode: 'batch',
        batch_members: [{ member_id: 'm-1', canonical_payload_hash: '' }],
      }),
      baseCtx({ canonical_payload_hash: '' } as never),
    )).toBe(false);
  });

  it('fails closed on open and unknown modes until their machinery lands', () => {
    expect(matches(baseGrant({
      grant_mode: 'open',
      pinned_projection_hash: 'projection-hash',
      open_projection: { roots: ['config.to'] },
    }))).toBe(false);

    expect(matches(baseGrant({ grant_mode: 'forever' } as unknown as ContractDefinition))).toBe(false);
  });

  it('does not mutate the grant object', () => {
    const grant = baseGrant({
      scope: { ...baseGrant().scope },
      bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
    });
    const before = JSON.parse(JSON.stringify(grant)) as ContractDefinition;

    expect(matches(grant)).toBe(true);

    expect(grant).toEqual(before);
  });
});
