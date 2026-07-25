/** D-177 P5b matchesSessionGrant open-mode tests. */

import { describe, expect, it } from 'vitest';

import type { ContractDefinition } from '../contract-definition.js';
import type { OpenProjection } from '../open-projection.js';
import {
  matchesSessionGrant,
  type SessionGrantMatchContext,
} from '../session-grant.js';

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

const baseGrant = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_session_open_1',
  minted_at: NOW_MS - 1_000,
  minted_by: 'owner:user-1',
  display_name: 'Allow open session',
  scope: {
    channels: ['chat'],
    actors: ['user_self'],
    ingredient_ids: ['mail.send'],
    operation_ids: ['mail.send'],
    connection_names: ['gmail-primary'],
  },
  grant_kind: 'session',
  grant_mode: 'open',
  channel_session_id: 's',
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  pinned_projection_hash: 'projection-hash',
  open_projection: openProjection(),
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
  open_pinned_projection_hash: 'projection-hash',
  ...overrides,
});

const matches = (
  grant: ContractDefinition,
  ctx: SessionGrantMatchContext = baseCtx(),
): boolean => matchesSessionGrant(grant, ctx, NOW_MS);

describe('D-177 P5b matchesSessionGrant open arm', () => {
  it('matches when the fire projection hash equals the row hash and the stored projection is well formed', () => {
    expect(matches(baseGrant())).toBe(true);
  });

  it('fails closed when the fire projection hash is absent', () => {
    const { open_pinned_projection_hash: _omitted, ...ctx } = baseCtx();

    expect(matches(baseGrant(), ctx)).toBe(false);
  });

  it('fails closed when the fire projection hash differs', () => {
    expect(matches(baseGrant(), baseCtx({ open_pinned_projection_hash: 'drifted-hash' })))
      .toBe(false);
  });

  it('fails closed when the stored open_projection is malformed even if the hash matches', () => {
    expect(matches(baseGrant({ open_projection: { version: 1, args: [] } }))).toBe(false);
  });

  it('still requires the common predicate before the open arm can match', () => {
    expect(matches(baseGrant(), baseCtx({ channel_session_id: 'other-session' })))
      .toBe(false);
    expect(matches(baseGrant({ expiry_at: NOW_MS - 1 }))).toBe(false);
    expect(matches(baseGrant({ arg_shape_hash: 'other-shape' }))).toBe(false);
  });

  it('does not let an open context field affect exact-mode grants', () => {
    const exactGrant = baseGrant({
      grant_mode: 'exact',
      pinned_projection_hash: undefined,
      open_projection: undefined,
    });

    expect(matches(exactGrant, baseCtx({ open_pinned_projection_hash: 'projection-hash' })))
      .toBe(true);
    expect(matches(
      exactGrant,
      baseCtx({
        canonical_payload_hash: 'other-payload',
        open_pinned_projection_hash: 'projection-hash',
      }),
    )).toBe(false);
  });
});
