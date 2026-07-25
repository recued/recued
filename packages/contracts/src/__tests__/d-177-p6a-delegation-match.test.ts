/** D-177 P6a delegation-rule match predicate tests. */

import { describe, expect, it } from 'vitest';

import {
  matchesDelegationRule,
  matchesSessionGrant,
  type ContractDefinition,
  type OpenProjection,
  type RiskTier,
  type SessionGrantMatchContext,
} from '@recued/contracts';

const NOW_MS = 1_800_000_000_000;

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

const baseDelegation = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_delegation_1',
  minted_at: NOW_MS - 1_000,
  minted_by: 'owner:user-1',
  display_name: 'Allow matching repeats',
  scope: {
    channels: ['chat'],
    actors: ['user_self'],
    ingredient_ids: ['mail.send'],
    operation_ids: ['mail.send'],
    connection_names: ['gmail-primary'],
  },
  grant_kind: 'delegation',
  grant_mode: 'exact',
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  arg_shape_hash: 'arg-shape-hash',
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
  channel_session_id: 's-1',
  ingredient_slug: 'mail.send',
  operation_id: 'mail.send',
  connection_name: 'gmail-primary',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  risk_tier: 'write',
  pre_lift_approval: 'ask',
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
): boolean => matchesDelegationRule(grant, ctx, NOW_MS);

describe('D-177 P6a matchesDelegationRule exact and open modes', () => {
  it('matches exact delegation rows across different channel sessions', () => {
    expect(matches(baseDelegation(), baseCtx({ channel_session_id: 's-1' }))).toBe(true);
    expect(matches(baseDelegation(), baseCtx({ channel_session_id: 's-2' }))).toBe(true);
  });

  it('matches open delegation rows only with a matching fire projection hash', () => {
    const grant = baseDelegation({
      grant_mode: 'open',
      pinned_projection_hash: 'projection-hash',
      open_projection: openProjection(),
    });

    expect(matches(grant, baseCtx({ open_pinned_projection_hash: 'projection-hash' })))
      .toBe(true);
    expect(matches(grant)).toBe(false);
  });
});

describe('D-177 P6a matchesDelegationRule fail-closed vocabulary', () => {
  it('refuses delegation rows carrying a channel_session_id', () => {
    expect(matches(baseDelegation({ channel_session_id: 's-1' }))).toBe(false);
  });

  it('refuses admin delegation rows even with an admin context', () => {
    expect(matches(
      baseDelegation({ risk_tier: 'admin' }),
      baseCtx({ risk_tier: 'admin' }),
    )).toBe(false);
  });

  it('refuses admin contexts against write delegation rows', () => {
    expect(matches(baseDelegation({ risk_tier: 'write' }), baseCtx({ risk_tier: 'admin' })))
      .toBe(false);
  });

  it('refuses batch delegation rows even with a matching member hash', () => {
    expect(matches(baseDelegation({
      grant_mode: 'batch',
      batch_members: [
        { member_id: 'm-1', canonical_payload_hash: 'payload-hash' },
      ],
    }))).toBe(false);
  });

  it('refuses unknown delegation grant modes', () => {
    expect(matches(baseDelegation({
      grant_mode: 'forever',
    } as unknown as Partial<ContractDefinition>))).toBe(false);
  });

  it('refuses delegation rows missing expiry_at', () => {
    expect(matches(withoutGrantKeys(baseDelegation(), ['expiry_at']))).toBe(false);
  });

  it('refuses delegation rows missing uses_remaining', () => {
    expect(matches(withoutGrantKeys(baseDelegation(), ['uses_remaining']))).toBe(false);
  });

  it('refuses delegation rows with empty or missing ingredient scope', () => {
    expect(matches(baseDelegation({
      scope: { ...baseDelegation().scope, ingredient_ids: [] },
    }))).toBe(false);
    expect(matches(baseDelegation({
      scope: { channels: ['chat'], actors: ['user_self'] },
    }))).toBe(false);
  });

  it('refuses delegation rows after bound recipe hash drift', () => {
    expect(matches(baseDelegation({
      bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'other-hash' },
    }))).toBe(false);
  });

  it('refuses delegation rows after arg_shape_hash drift', () => {
    expect(matches(baseDelegation({ arg_shape_hash: 'other-shape' }))).toBe(false);
  });

  it('refuses delegation rows when entity_scope is bound and the context is absent', () => {
    expect(matches(baseDelegation({ entity_scope: 'deal-1' }))).toBe(false);
  });

  it('refuses read and destructive context tiers', () => {
    for (const risk_tier of ['read', 'destructive'] satisfies RiskTier[]) {
      expect(matches(
        baseDelegation({ risk_tier }),
        baseCtx({ risk_tier }),
      ), risk_tier).toBe(false);
    }
  });
});

describe('D-177 P6a gate-grant kind disjointness', () => {
  it('keeps session grants and delegation rules disjoint', () => {
    const sessionGrant = baseDelegation({
      grant_kind: 'session',
      channel_session_id: 's-1',
    });
    const delegationWithSessionId = baseDelegation({ channel_session_id: 's-1' });

    expect(matchesDelegationRule(sessionGrant, baseCtx(), NOW_MS)).toBe(false);
    expect(matchesSessionGrant(delegationWithSessionId, baseCtx(), NOW_MS)).toBe(false);
  });
});
