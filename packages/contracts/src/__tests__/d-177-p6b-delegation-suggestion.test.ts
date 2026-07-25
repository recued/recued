/** D-177 P6b delegation-rule suggestion learner pure tests. */

import { describe, expect, it } from 'vitest';

import {
  DELEGATION_SUGGEST_LOOKBACK_MS,
  DELEGATION_SUGGEST_SAMPLE_CONTRACT_IDS_MAX,
  delegationRuleSuggestionKeyHash,
  deriveDelegationRuleSuggestionKey,
  evaluateDelegationRuleSuggestionGroup,
  type ContractDefinition,
  type ContractScope,
  type DelegationRuleSuggestionEvidence,
  type DelegationRuleSuggestionKey,
  type OpenProjection,
} from '@recued/contracts';

const NOW = 1_800_000_000_000;

const fullScope = (
  overrides: Partial<ContractScope> = {},
): ContractScope => ({
  channels: ['chat'],
  actors: ['user_self'],
  ingredient_ids: ['mail.send'],
  operation_ids: ['mail.send'],
  connection_names: ['gmail-primary'],
  ...overrides,
});

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

const sessionRow = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_session_1',
  minted_at: NOW - 1_000,
  minted_by: 'user:1',
  display_name: 'Session grant',
  scope: fullScope(),
  grant_kind: 'session',
  grant_mode: 'exact',
  channel_session_id: 's-1',
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  entity_scope: 'deal-1',
  expiry_at: NOW + 60_000,
  max_uses: 3,
  uses_remaining: 2,
  approved_action_ref: 'checkpoint-1',
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

const expectQualifies = (
  rows: ReadonlyArray<ContractDefinition>,
): DelegationRuleSuggestionEvidence => {
  const result = evaluateDelegationRuleSuggestionGroup(rows, NOW);
  expect(result.qualifies).toBe(true);
  if (!result.qualifies) throw new Error('expected group to qualify');
  return result.evidence;
};

const expectDisqualifies = (rows: ReadonlyArray<ContractDefinition>): void => {
  expect(evaluateDelegationRuleSuggestionGroup(rows, NOW).qualifies).toBe(false);
};

const consumedRow = (
  contract_id: string,
  channel_session_id: string,
  minted_at: number,
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition =>
  sessionRow({
    contract_id,
    channel_session_id,
    minted_at,
    max_uses: 3,
    uses_remaining: 2,
    ...overrides,
  });

describe('D-177 P6b deriveDelegationRuleSuggestionKey', () => {
  it('derives exact keys with present and absent optional axes', () => {
    expect(deriveDelegationRuleSuggestionKey(sessionRow())).toEqual({
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
    });

    const absentOptional = deriveDelegationRuleSuggestionKey(sessionRow({
      scope: fullScope({ operation_ids: undefined, connection_names: undefined }),
      entity_scope: undefined,
    }));

    expect(absentOptional).toEqual({
      channel: 'chat',
      actor: 'user_self',
      ingredient_id: 'mail.send',
      recipe_id: 'recipe-1',
      recipe_hash: 'recipe-hash-1',
      arg_shape_hash: 'arg-shape-hash',
      risk_tier: 'write',
      grant_mode: 'exact',
      canonical_payload_hash: 'payload-hash',
    });
    expect(absentOptional).not.toHaveProperty('operation_id');
    expect(absentOptional).not.toHaveProperty('connection_name');
    expect(absentOptional).not.toHaveProperty('entity_scope');
  });

  it('derives open keys only with a pinned hash and well-formed stored projection', () => {
    const projection = openProjection();
    const snapshot = deriveDelegationRuleSuggestionKey(sessionRow({
      grant_mode: 'open',
      canonical_payload_hash: undefined,
      pinned_projection_hash: 'projection-hash',
      open_projection: projection,
    }));

    expect(snapshot).toEqual({
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
      grant_mode: 'open',
      pinned_projection_hash: 'projection-hash',
      open_projection: projection,
    });

    expect(deriveDelegationRuleSuggestionKey(sessionRow({
      grant_mode: 'open',
      canonical_payload_hash: undefined,
      open_projection: projection,
    }))).toBeUndefined();
    expect(deriveDelegationRuleSuggestionKey(sessionRow({
      grant_mode: 'open',
      canonical_payload_hash: undefined,
      pinned_projection_hash: 'projection-hash',
      open_projection: { version: 1, args: [] },
    }))).toBeUndefined();
  });

  it('fails closed on underivable row shapes', () => {
    const malformedOpenProjection = { version: 1, args: [] };
    const cases: ReadonlyArray<{ name: string; row: ContractDefinition }> = [
      { name: 'standing row without grant_kind', row: withoutGrantKeys(sessionRow(), ['grant_kind']) },
      {
        name: 'unknown grant_kind',
        row: {
          ...sessionRow(),
          grant_kind: 'future' as unknown as ContractDefinition['grant_kind'],
        },
      },
      { name: 'absent grant_mode', row: withoutGrantKeys(sessionRow(), ['grant_mode']) },
      {
        name: 'batch mode',
        row: sessionRow({
          grant_mode: 'batch',
          canonical_payload_hash: undefined,
          batch_members: [{ member_id: 'm-1', canonical_payload_hash: 'payload-hash' }],
        }),
      },
      {
        name: 'unknown grant_mode',
        row: {
          ...sessionRow(),
          grant_mode: 'forever' as unknown as ContractDefinition['grant_mode'],
        },
      },
      { name: 'missing channel_session_id', row: withoutGrantKeys(sessionRow(), ['channel_session_id']) },
      { name: 'empty channel_session_id', row: sessionRow({ channel_session_id: '' }) },
      {
        name: 'delegation row carrying channel_session_id',
        row: sessionRow({ grant_kind: 'delegation' }),
      },
      { name: 'multi-valued channels', row: sessionRow({ scope: fullScope({ channels: ['chat', 'mcp'] }) }) },
      { name: 'multi-valued actors', row: sessionRow({ scope: fullScope({ actors: ['user_self', 'agent'] }) }) },
      {
        name: 'contracted_user (door) actor — staged-trust is owner-only',
        row: sessionRow({ scope: fullScope({ actors: ['contracted_user'] }) }),
      },
      // Edge shapes must NOT be silently coerced to the owner (codex): an empty
      // actors axis derives no key (rejected by the single-value required-axis check
      // BEFORE the owner gate — never treated as user_self).
      { name: 'empty actors', row: sessionRow({ scope: fullScope({ actors: [] }) }) },
      {
        name: 'multi-valued ingredient_ids',
        row: sessionRow({ scope: fullScope({ ingredient_ids: ['mail.send', 'slack.send'] }) }),
      },
      { name: 'empty ingredient_ids', row: sessionRow({ scope: fullScope({ ingredient_ids: [] }) }) },
      {
        name: 'multi-valued operation_ids',
        row: sessionRow({ scope: fullScope({ operation_ids: ['mail.send', 'mail.forward'] }) }),
      },
      {
        name: 'multi-valued connection_names',
        row: sessionRow({ scope: fullScope({ connection_names: ['gmail-primary', 'gmail-alt'] }) }),
      },
      { name: 'missing bound_recipe', row: withoutGrantKeys(sessionRow(), ['bound_recipe']) },
      {
        name: 'empty recipe_id',
        row: sessionRow({ bound_recipe: { recipe_id: '', recipe_hash: 'recipe-hash-1' } }),
      },
      {
        name: 'empty recipe_hash',
        row: sessionRow({ bound_recipe: { recipe_id: 'recipe-1', recipe_hash: '' } }),
      },
      { name: 'empty arg_shape_hash', row: sessionRow({ arg_shape_hash: '' }) },
      { name: 'admin risk tier', row: sessionRow({ risk_tier: 'admin' }) },
      { name: 'missing risk tier', row: withoutGrantKeys(sessionRow(), ['risk_tier']) },
      {
        name: 'exact mode missing canonical_payload_hash',
        row: withoutGrantKeys(sessionRow(), ['canonical_payload_hash']),
      },
      {
        name: 'open mode missing pinned_projection_hash',
        row: sessionRow({
          grant_mode: 'open',
          canonical_payload_hash: undefined,
          open_projection: openProjection(),
        }),
      },
      {
        name: 'open mode malformed open_projection',
        row: sessionRow({
          grant_mode: 'open',
          canonical_payload_hash: undefined,
          pinned_projection_hash: 'projection-hash',
          open_projection: malformedOpenProjection,
        }),
      },
    ];

    for (const testCase of cases) {
      expect(deriveDelegationRuleSuggestionKey(testCase.row), testCase.name).toBeUndefined();
    }
  });

  it('STAGED-TRUST IS OWNER-ONLY: a contracted_user (door) grant derives no key; user_self does, on any owner channel', () => {
    // A door's session grant must NEVER feed the learner: a delegation rule the learner
    // would suggest is scope-bound (matched on channel × actor × ingredient × op, not a
    // contract id), so a `contracted_user`-scoped rule would match EVERY door — the
    // privilege-creep this gate prevents. Every door (incl. the owner's own raw-MCP
    // bearer) dispatches as `contracted_user`; the owner is the only `user_self`.
    expect(
      deriveDelegationRuleSuggestionKey(sessionRow({ scope: fullScope({ actors: ['contracted_user'] }) })),
    ).toBeUndefined();
    // The owner (user_self) DOES derive — and on EVERY owner channel (chat / messenger;
    // mcp_chat resolves to chat), since the gate is actor-only, not channel-restricted.
    expect(deriveDelegationRuleSuggestionKey(sessionRow())).not.toBeUndefined(); // chat
    expect(
      deriveDelegationRuleSuggestionKey(sessionRow({ scope: fullScope({ channels: ['messenger'] }) })),
    ).not.toBeUndefined();
  });
});

describe('D-177 P6b delegationRuleSuggestionKeyHash', () => {
  it('hashes equal keys equally regardless of construction order', () => {
    const derived = deriveDelegationRuleSuggestionKey(sessionRow());
    expect(derived).not.toBeUndefined();
    if (derived === undefined) throw new Error('expected derivable key');

    const rebuilt: DelegationRuleSuggestionKey = {
      grant_mode: 'exact',
      canonical_payload_hash: 'payload-hash',
      risk_tier: 'write',
      arg_shape_hash: 'arg-shape-hash',
      recipe_hash: 'recipe-hash-1',
      recipe_id: 'recipe-1',
      entity_scope: 'deal-1',
      connection_name: 'gmail-primary',
      operation_id: 'mail.send',
      ingredient_id: 'mail.send',
      actor: 'user_self',
      channel: 'chat',
    };

    expect(delegationRuleSuggestionKeyHash(rebuilt))
      .toBe(delegationRuleSuggestionKeyHash(derived));
  });

  it('changes when any authority-bearing field changes', () => {
    const base = deriveDelegationRuleSuggestionKey(sessionRow());
    expect(base).not.toBeUndefined();
    if (base === undefined) throw new Error('expected derivable key');
    const baseHash = delegationRuleSuggestionKeyHash(base);
    const variants: ReadonlyArray<[string, DelegationRuleSuggestionKey]> = [
      ['channel', { ...base, channel: 'mcp' }],
      ['actor', { ...base, actor: 'contracted_user' }],
      ['ingredient_id', { ...base, ingredient_id: 'slack.send' }],
      ['operation_id', { ...base, operation_id: 'mail.forward' }],
      ['connection_name', { ...base, connection_name: 'gmail-alt' }],
      ['recipe_id', { ...base, recipe_id: 'recipe-2' }],
      ['recipe_hash', { ...base, recipe_hash: 'recipe-hash-2' }],
      ['arg_shape_hash', { ...base, arg_shape_hash: 'arg-shape-2' }],
      ['risk_tier', { ...base, risk_tier: 'admin' }],
      ['entity_scope', { ...base, entity_scope: 'deal-2' }],
      ['grant_mode', {
        ...base,
        grant_mode: 'open',
        canonical_payload_hash: undefined,
        pinned_projection_hash: 'projection-hash',
      }],
      ['payload hash', { ...base, canonical_payload_hash: 'payload-hash-2' }],
    ];

    for (const [name, variant] of variants) {
      expect(delegationRuleSuggestionKeyHash(variant), name).not.toBe(baseHash);
    }
  });

  it('distinguishes absent optional axes from present optional axes', () => {
    const absent = deriveDelegationRuleSuggestionKey(sessionRow({
      scope: fullScope({ operation_ids: undefined, connection_names: undefined }),
      entity_scope: undefined,
    }));
    expect(absent).not.toBeUndefined();
    if (absent === undefined) throw new Error('expected derivable key');

    expect(delegationRuleSuggestionKeyHash({ ...absent, operation_id: 'mail.send' }))
      .not.toBe(delegationRuleSuggestionKeyHash(absent));
    expect(delegationRuleSuggestionKeyHash({ ...absent, connection_name: 'gmail-primary' }))
      .not.toBe(delegationRuleSuggestionKeyHash(absent));
    expect(delegationRuleSuggestionKeyHash({ ...absent, entity_scope: 'deal-1' }))
      .not.toBe(delegationRuleSuggestionKeyHash(absent));
  });
});

describe('D-177 P6b evaluateDelegationRuleSuggestionGroup', () => {
  it('qualifies exactly three consumed rows across three sessions within the window', () => {
    const evidence = expectQualifies([
      consumedRow('ct_1', 's-1', NOW - 3_000),
      consumedRow('ct_2', 's-2', NOW - 2_000),
      consumedRow('ct_3', 's-3', NOW - 1_000),
    ]);

    expect(evidence).toEqual({
      row_count: 3,
      distinct_session_count: 3,
      consumed_uses: 3,
      sample_contract_ids: ['ct_3', 'ct_2', 'ct_1'],
      first_minted_at: NOW - 3_000,
      last_minted_at: NOW - 1_000,
    });
  });

  it('disqualifies groups below the row and distinct-session thresholds', () => {
    expectDisqualifies([
      consumedRow('ct_1', 's-1', NOW - 2_000),
      consumedRow('ct_2', 's-2', NOW - 1_000),
    ]);
    expectDisqualifies([
      consumedRow('ct_1', 's-1', NOW - 3_000),
      consumedRow('ct_2', 's-1', NOW - 2_000),
      consumedRow('ct_3', 's-2', NOW - 1_000),
    ]);
  });

  it('lets any revoked row poison the group regardless of window or consumption', () => {
    expectDisqualifies([
      consumedRow('ct_1', 's-1', NOW - 3_000),
      consumedRow('ct_2', 's-2', NOW - 2_000),
      consumedRow('ct_3', 's-3', NOW - 1_000),
      consumedRow('ct_revoked_old', 's-4', NOW - DELEGATION_SUGGEST_LOOKBACK_MS - 1, {
        uses_remaining: 3,
        revoked_at: NOW - 500,
        revocation_reason: 'owner disabled',
      }),
    ]);
  });

  it('disqualifies all-unconsumed and out-of-window rows', () => {
    expectDisqualifies([
      consumedRow('ct_1', 's-1', NOW - 3_000, { uses_remaining: 3 }),
      consumedRow('ct_2', 's-2', NOW - 2_000, { uses_remaining: 3 }),
      consumedRow('ct_3', 's-3', NOW - 1_000, { uses_remaining: 3 }),
    ]);
    expectDisqualifies([
      consumedRow('ct_1', 's-1', NOW - DELEGATION_SUGGEST_LOOKBACK_MS - 3_000),
      consumedRow('ct_2', 's-2', NOW - DELEGATION_SUGGEST_LOOKBACK_MS - 2_000),
      consumedRow('ct_3', 's-3', NOW - DELEGATION_SUGGEST_LOOKBACK_MS - 1_000),
    ]);
  });

  it.each([
    ['negative remaining', { max_uses: 3, uses_remaining: -1 }],
    ['remaining above max', { max_uses: 3, uses_remaining: 4 }],
    ['non-integer max', { max_uses: 3.5, uses_remaining: 2 }],
    ['non-integer remaining', { max_uses: 3, uses_remaining: 1.5 }],
    ['zero max', { max_uses: 0, uses_remaining: 0 }],
  ])('does not count malformed consumed bounds: %s', (_name, overrides) => {
    expectDisqualifies([
      consumedRow('ct_1', 's-1', NOW - 3_000),
      consumedRow('ct_2', 's-2', NOW - 2_000),
      consumedRow('ct_bad', 's-3', NOW - 1_000, overrides),
    ]);
  });

  it('records evidence over qualifying rows only and caps newest-first samples', () => {
    const rows = [
      consumedRow('ct_1', 's-1', NOW - 6_000, { max_uses: 5, uses_remaining: 4 }),
      consumedRow('ct_2', 's-2', NOW - 5_000, { max_uses: 5, uses_remaining: 3 }),
      consumedRow('ct_3', 's-3', NOW - 4_000, { max_uses: 5, uses_remaining: 2 }),
      consumedRow('ct_4', 's-4', NOW - 3_000, { max_uses: 5, uses_remaining: 1 }),
      consumedRow('ct_5', 's-5', NOW - 2_000, { max_uses: 5, uses_remaining: 0 }),
      consumedRow('ct_6', 's-6', NOW - 1_000, { max_uses: 5, uses_remaining: 4 }),
    ];

    expect(expectQualifies(rows)).toEqual({
      row_count: 6,
      distinct_session_count: 6,
      consumed_uses: 16,
      sample_contract_ids: ['ct_6', 'ct_5', 'ct_4', 'ct_3', 'ct_2'],
      first_minted_at: NOW - 6_000,
      last_minted_at: NOW - 1_000,
    });
    expect(expectQualifies(rows).sample_contract_ids)
      .toHaveLength(DELEGATION_SUGGEST_SAMPLE_CONTRACT_IDS_MAX);
  });

  it('excludes unconsumed and out-of-window rows from evidence without disqualifying', () => {
    const evidence = expectQualifies([
      consumedRow('ct_1', 's-1', NOW - 3_000),
      consumedRow('ct_2', 's-2', NOW - 2_000),
      consumedRow('ct_3', 's-3', NOW - 1_000),
      consumedRow('ct_unconsumed', 's-4', NOW - 500, { uses_remaining: 3 }),
      consumedRow('ct_old', 's-5', NOW - DELEGATION_SUGGEST_LOOKBACK_MS - 1),
    ]);

    expect(evidence).toEqual({
      row_count: 3,
      distinct_session_count: 3,
      consumed_uses: 3,
      sample_contract_ids: ['ct_3', 'ct_2', 'ct_1'],
      first_minted_at: NOW - 3_000,
      last_minted_at: NOW - 1_000,
    });
  });
});
