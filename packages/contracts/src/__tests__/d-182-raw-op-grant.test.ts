/** D-182 §8 — `grant_mode: 'raw_op'` recipe-less op-bound session-grant
 *  matcher tests. A raw-op grant is the door grant for a raw catalog op the
 *  LLM calls WITHOUT a recipe: recipe-less (no `bound_recipe`, like `'scoped'`)
 *  but with a minting dispatch (so it KEEPS `arg_shape_hash` + exact
 *  `canonical_payload_hash`, unlike `'scoped'`), op + connection bound. */

import { describe, expect, it } from 'vitest';

import {
  STDIO_MCP_TOKEN_ID,
  matchesDelegationRule,
  matchesSessionGrant,
  type ContractDefinition,
  type SessionGrantMatchContext,
} from '../index.js';

const NOW_MS = 1_800_000_000_000;

/** N.14.6 — these fixtures model a DOOR (every one of their own comments says so),
 *  so they carry what a door actually carries: a delegated `mcp_token_id` (the only
 *  field separating a door from the owner's own local client on the mcp channel) and
 *  the governing contract id, against grants bound to that contract. Before the door
 *  clause reached mcp these cases modelled a door riding an UNBOUND grant — exactly
 *  the defect N.14.6 closes, so the fixtures were pinning the bug. The owner's own
 *  client is `STDIO_MCP_TOKEN_ID`, and it alone rides unbound rows. */
const RAW_OP_DOOR_TOKEN = 'http_b17c93de5f204a68';
const RAW_OP_DOOR_CONTRACT = 'ct_door_raw_op';

const baseRawOpGrant = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_rawop_1',
  minted_at: NOW_MS - 1_000,
  minted_by: 'owner',
  display_name: 'Door raw op — task.create',
  scope: {
    channels: ['mcp'],
    actors: ['contracted_user'],
    ingredient_ids: ['task-pack-catalog'],
    operation_ids: ['task.create'],
    connection_names: ['myconn'],
  },
  grant_kind: 'session',
  grant_mode: 'raw_op',
  channel_session_id: 's',
  bound_contract_id: RAW_OP_DOOR_CONTRACT,
  risk_tier: 'write',
  arg_shape_hash: 'arg-shape-hash',
  canonical_payload_hash: 'payload-hash',
  expiry_at: NOW_MS + 60_000,
  uses_remaining: 3,
  ...overrides,
});

/** An exact recipe-BOUND grant — the contrast case (a recipe-less dispatch
 *  must NOT match it). */
const baseExactGrant = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_exact_1',
  minted_at: NOW_MS - 1_000,
  minted_by: 'owner',
  display_name: 'Exact recipe grant',
  scope: {
    channels: ['mcp'],
    actors: ['contracted_user'],
    ingredient_ids: ['task-pack-catalog'],
    operation_ids: ['task.create'],
    connection_names: ['myconn'],
  },
  grant_kind: 'session',
  grant_mode: 'exact',
  channel_session_id: 's',
  // N.14.6 — a door's grant is bound to its door contract; the ctx supplies the
  // same id. An unbound row here would model the pre-fix defect.
  bound_contract_id: RAW_OP_DOOR_CONTRACT,
  bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
  arg_shape_hash: 'arg-shape-hash',
  canonical_payload_hash: 'payload-hash',
  risk_tier: 'write',
  expiry_at: NOW_MS + 60_000,
  uses_remaining: 3,
  ...overrides,
});

/** A RECIPE-LESS door dispatch context — `recipe_id` / `recipe_hash` are
 *  deliberately absent (the raw op carries no recipe). */
const baseRawOpCtx = (
  overrides: Partial<SessionGrantMatchContext> = {},
): SessionGrantMatchContext => ({
  channel: 'mcp',
  actor: 'contracted_user',
  channel_session_id: 's',
  mcp_token_id: RAW_OP_DOOR_TOKEN,
  source_contract_id: RAW_OP_DOOR_CONTRACT,
  ingredient_slug: 'task-pack-catalog',
  operation_id: 'task.create',
  connection_name: 'myconn',
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

const withoutCtxKeys = (
  ctx: SessionGrantMatchContext,
  keys: readonly (keyof SessionGrantMatchContext)[],
): SessionGrantMatchContext => {
  const copy = { ...ctx } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as unknown as SessionGrantMatchContext;
};

const matches = (
  grant: ContractDefinition,
  ctx: SessionGrantMatchContext = baseRawOpCtx(),
): boolean => matchesSessionGrant(grant, ctx, NOW_MS);

describe('D-182 raw-op session grants', () => {
  it('matches a recipe-less dispatch with the right op + connection + identity', () => {
    const grant = baseRawOpGrant();
    // Recipe-less by construction.
    expect(grant).not.toHaveProperty('bound_recipe');
    const ctx = baseRawOpCtx();
    expect(ctx.recipe_id).toBeUndefined();
    expect(ctx.recipe_hash).toBeUndefined();
    expect(matches(grant)).toBe(true);
  });

  // ── N.14.6 — the door binding on the raw-op path ────────────────
  //
  // The raw-op mint is the LIVE `(mcp, contracted_user)` grant path: an owner's
  // `allow_session` answer to a door's held raw catalog-op call. It scopes
  // `actors: ['contracted_user']`, so the store's anonymous-requires-a-binding
  // fence never fired here and every row landed UNBOUND.

  it('THE BUG — a door never rides an UNBOUND raw-op row', () => {
    // What every raw-op grant looked like before N.14.6. Unbound, it survives a
    // rebind of the token that minted it — `updateTokenContract` moves the
    // contract while `mcp:<token>` (the session key) never moves — so the next
    // contract inherits an approval it was never given.
    expect(matches(withoutGrantKeys(baseRawOpGrant(), ['bound_contract_id']))).toBe(
      false,
    );
  });

  it('a raw-op row never follows its token to another contract', () => {
    expect(
      matches(baseRawOpGrant(), baseRawOpCtx({ source_contract_id: 'ct_door_other' })),
    ).toBe(false);
  });

  it("REGRESSION PIN — the owner's own stdio client rides its unbound raw-op row", () => {
    // The owner is `(mcp, contracted_user)` too. Only the token says otherwise,
    // and an unbound row is exactly what the owner's own client mints.
    expect(
      matches(
        withoutGrantKeys(baseRawOpGrant(), ['bound_contract_id']),
        baseRawOpCtx({
          mcp_token_id: STDIO_MCP_TOKEN_ID,
          source_contract_id: undefined,
        }),
      ),
    ).toBe(true);
  });

  it('matches a connection-less op when neither grant nor dispatch names one', () => {
    // `ai` / `entity` ops carry no connection.
    const grant = baseRawOpGrant({
      scope: {
        channels: ['mcp'],
        actors: ['contracted_user'],
        ingredient_ids: ['task-pack-catalog'],
        operation_ids: ['task.create'],
      },
    });
    const ctx = withoutCtxKeys(baseRawOpCtx(), ['connection_name']);
    expect(matches(grant, ctx)).toBe(true);
  });

  it('does NOT match a recipe-BEARING dispatch (clean recipe-less partition)', () => {
    // A raw_op grant only absorbs recipe-LESS dispatches; a dispatch carrying a
    // recipe identity must fall through to its own recipe-bound grants (or ask).
    expect(matches(baseRawOpGrant(), baseRawOpCtx({ recipe_id: 'r' }))).toBe(false);
    expect(matches(baseRawOpGrant(), baseRawOpCtx({ recipe_hash: 'h' }))).toBe(false);
    expect(
      matches(baseRawOpGrant(), baseRawOpCtx({ recipe_id: 'r', recipe_hash: 'h' })),
    ).toBe(false);
  });

  it('treats a raw_op row carrying a bound_recipe as malformed → inert', () => {
    expect(
      matches(
        baseRawOpGrant({
          bound_recipe: { recipe_id: 'r', recipe_hash: 'h' },
        }),
      ),
    ).toBe(false);
  });

  it('KEEPS the arg-shape pin (unlike scoped) — a reshaped payload re-asks', () => {
    expect(matches(baseRawOpGrant({ arg_shape_hash: 'other' }))).toBe(false);
    expect(matches(withoutGrantKeys(baseRawOpGrant(), ['arg_shape_hash']))).toBe(
      false,
    );
    expect(
      matches(baseRawOpGrant(), baseRawOpCtx({ arg_shape_hash: 'other' })),
    ).toBe(false);
  });

  it('pins the EXACT payload — a different payload re-asks', () => {
    expect(matches(baseRawOpGrant({ canonical_payload_hash: 'other' }))).toBe(
      false,
    );
    expect(
      matches(withoutGrantKeys(baseRawOpGrant(), ['canonical_payload_hash'])),
    ).toBe(false);
    expect(
      matches(baseRawOpGrant(), baseRawOpCtx({ canonical_payload_hash: 'x' })),
    ).toBe(false);
  });

  it('requires the operation axis to be explicitly bound (never a wildcard)', () => {
    const cases: ReadonlyArray<{
      name: string;
      grant?: ContractDefinition;
      ctx?: SessionGrantMatchContext;
    }> = [
      {
        name: 'ctx.operation_id absent',
        ctx: withoutCtxKeys(baseRawOpCtx(), ['operation_id']),
      },
      {
        name: 'ctx.operation_id outside scope',
        ctx: baseRawOpCtx({ operation_id: 'task.delete' }),
      },
      {
        name: 'empty operation_ids array is not a raw_op wildcard',
        grant: baseRawOpGrant({
          scope: { ...baseRawOpGrant().scope, operation_ids: [] },
        }),
      },
      {
        name: 'absent operation_ids axis is not a raw_op wildcard',
        grant: baseRawOpGrant({
          scope: {
            channels: ['mcp'],
            actors: ['contracted_user'],
            ingredient_ids: ['task-pack-catalog'],
            connection_names: ['myconn'],
          },
        }),
      },
    ];
    for (const testCase of cases) {
      expect(
        matches(testCase.grant ?? baseRawOpGrant(), testCase.ctx ?? baseRawOpCtx()),
        testCase.name,
      ).toBe(false);
    }
  });

  it('refuses a connection-bearing dispatch when the grant connection axis is a wildcard or mismatched', () => {
    // A grant minted for connection A must never absorb a call to connection B,
    // and an empty/absent connection axis is NOT a wildcard when the dispatch
    // resolves one.
    expect(
      matches(baseRawOpGrant(), baseRawOpCtx({ connection_name: 'otherconn' })),
    ).toBe(false);
    expect(
      matches(
        baseRawOpGrant({
          scope: { ...baseRawOpGrant().scope, connection_names: [] },
        }),
        baseRawOpCtx({ connection_name: 'myconn' }),
      ),
    ).toBe(false);
    expect(
      matches(
        baseRawOpGrant({
          scope: {
            channels: ['mcp'],
            actors: ['contracted_user'],
            ingredient_ids: ['task-pack-catalog'],
            operation_ids: ['task.create'],
          },
        }),
        baseRawOpCtx({ connection_name: 'myconn' }),
      ),
    ).toBe(false);
  });

  it('keeps the common gate-grant clauses fail-closed', () => {
    const cases: ReadonlyArray<{
      name: string;
      grant?: ContractDefinition;
      ctx?: SessionGrantMatchContext;
    }> = [
      {
        name: 'wrong channel_session_id',
        grant: baseRawOpGrant({ channel_session_id: 'other' }),
      },
      { name: 'revoked row', grant: baseRawOpGrant({ revoked_at: NOW_MS - 1 }) },
      { name: 'expired row', grant: baseRawOpGrant({ expiry_at: NOW_MS - 1 }) },
      {
        name: 'uses_remaining zero',
        grant: baseRawOpGrant({ uses_remaining: 0 }),
      },
      {
        name: 'missing expiry bound (bounded-by-construction)',
        grant: withoutGrantKeys(baseRawOpGrant(), ['expiry_at']),
      },
      {
        name: 'missing uses bound (bounded-by-construction)',
        grant: withoutGrantKeys(baseRawOpGrant(), ['uses_remaining']),
      },
      {
        name: 'risk_tier mismatch (grant write, ctx admin)',
        ctx: baseRawOpCtx({ risk_tier: 'admin' }),
      },
      {
        name: 'pre-lift always cannot use a read session grant',
        grant: baseRawOpGrant({ risk_tier: 'read' }),
        ctx: baseRawOpCtx({
          risk_tier: 'read',
          pre_lift_approval: 'always',
        }),
      },
      {
        name: 'ingredient not explicitly named',
        grant: baseRawOpGrant({
          scope: { ...baseRawOpGrant().scope, ingredient_ids: ['other-slug'] },
        }),
      },
      {
        name: 'ctx entity_scope set but grant entity_scope absent',
        ctx: baseRawOpCtx({ entity_scope: 'task-1' }),
      },
    ];
    for (const testCase of cases) {
      expect(
        matches(testCase.grant ?? baseRawOpGrant(), testCase.ctx ?? baseRawOpCtx()),
        testCase.name,
      ).toBe(false);
    }
  });

  it('matches a read-tier raw-op session grant for pre-lift ask', () => {
    expect(matches(
      baseRawOpGrant({ risk_tier: 'read' }),
      baseRawOpCtx({ risk_tier: 'read', pre_lift_approval: 'ask' }),
    )).toBe(true);
  });

  it('matches when both grant and dispatch carry the same entity_scope', () => {
    expect(
      matches(
        baseRawOpGrant({ entity_scope: 'task-1' }),
        baseRawOpCtx({ entity_scope: 'task-1' }),
      ),
    ).toBe(true);
  });

  it('a recipe-bound exact grant does NOT match a recipe-less dispatch', () => {
    expect(matches(baseExactGrant())).toBe(false);
  });

  it('is SESSION-ONLY — a raw_op delegation row never matches', () => {
    const rawOpDelegation = withoutGrantKeys(
      baseRawOpGrant({ grant_kind: 'delegation' }),
      ['channel_session_id'],
    );
    expect(matchesDelegationRule(rawOpDelegation, baseRawOpCtx(), NOW_MS)).toBe(
      false,
    );
    // ...and a raw_op grant_kind:'session' row is never a delegation match either.
    expect(matchesDelegationRule(baseRawOpGrant(), baseRawOpCtx(), NOW_MS)).toBe(
      false,
    );
  });
});
