/** D-177 N.14 — door-scoped staged trust: the `bound_contract_id` binding's
 *  asymmetric matcher clauses, the `(reception, anonymous)` seed, and the
 *  `door_submission` projection class. */

import { describe, expect, it } from 'vitest';

import {
  CONTRACT_LESS_TRUST_CEILING,
  DELEGATION_SUGGEST_LOOKBACK_MS,
  RECEPTION_SESSION_GRANT_DEFAULTS,
  SESSION_GRANT_DEFAULT_SEEDS,
  STDIO_MCP_TOKEN_ID,
  isDoorMatchContext,
  resolveTrustCeiling,
  delegationRuleMintPlanFromSnapshot,
  delegationRuleSuggestionKeyHash,
  deriveDelegationRuleSuggestionKey,
  evaluateDelegationRuleSuggestionGroup,
  matchesDelegationRule,
  matchesSessionGrant,
  resolveSessionGrantOffer,
  seededSessionGrantDefaults,
  type ContractDefinition,
  type SessionGrantMatchContext,
} from '@recued/contracts';

import {
  computeOpenProjection,
  isOpenProjectionRefusal,
  isWellFormedOpenProjection,
  type ComputeOpenProjectionArgs,
  type OpenProjectionComputation,
} from '../open-projection.js';

const NOW_MS = 1_800_000_000_000;
const DOOR_A = 'ct_door_reception_a';
const DOOR_B = 'ct_door_reception_b';
const DOOR_A_SESSION = 'reception:endpoint-a';

// ── Matcher fixtures ─────────────────────────────────────────────

const doorSessionGrant = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_session_door_1',
  minted_at: NOW_MS - 1_000,
  minted_by: 'owner:user-1',
  display_name: 'Allow for this form',
  scope: {
    channels: ['reception'],
    actors: ['anonymous'],
    ingredient_ids: ['mail.send'],
    operation_ids: ['mail.send'],
    connection_names: ['gmail-primary'],
  },
  grant_kind: 'session',
  grant_mode: 'exact',
  channel_session_id: DOOR_A_SESSION,
  bound_contract_id: DOOR_A,
  bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  expiry_at: NOW_MS + 60_000,
  max_uses: 20,
  uses_remaining: 20,
  approved_action_ref: 'run-1',
  ...overrides,
});

const doorCtx = (
  overrides: Partial<SessionGrantMatchContext> = {},
): SessionGrantMatchContext => ({
  channel: 'reception',
  actor: 'anonymous',
  channel_session_id: DOOR_A_SESSION,
  source_contract_id: DOOR_A,
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

const ownerGrant = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_session_owner_1',
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
  channel_session_id: 'chat:s-1',
  bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  expiry_at: NOW_MS + 60_000,
  max_uses: 5,
  uses_remaining: 5,
  approved_action_ref: 'run-1',
  ...overrides,
});

const ownerCtx = (
  overrides: Partial<SessionGrantMatchContext> = {},
): SessionGrantMatchContext => ({
  channel: 'chat',
  actor: 'user_self',
  channel_session_id: 'chat:s-1',
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

describe('N.14 door binding — session variant', () => {
  it('a bound door grant matches the fire that supplies its door id', () => {
    expect(matchesSessionGrant(doorSessionGrant(), doorCtx(), NOW_MS)).toBe(true);
  });

  it("a bound grant never matches another door's fire", () => {
    expect(
      matchesSessionGrant(
        doorSessionGrant(),
        doorCtx({
          source_contract_id: DOOR_B,
          channel_session_id: DOOR_A_SESSION,
        }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it('a bound grant never matches a ctx that supplies no door id', () => {
    const ctx = doorCtx();
    const { source_contract_id: _dropped, ...rest } = ctx;
    expect(matchesSessionGrant(doorSessionGrant(), rest, NOW_MS)).toBe(false);
  });

  it('an anonymous ctx never matches an UNBOUND grant (clause 2)', () => {
    const unbound = doorSessionGrant();
    const { bound_contract_id: _dropped, ...rest } = unbound;
    expect(
      matchesSessionGrant(rest as ContractDefinition, doorCtx(), NOW_MS),
    ).toBe(false);
  });

  it('an empty-string binding is malformed — inert', () => {
    expect(
      matchesSessionGrant(
        doorSessionGrant({ bound_contract_id: '' }),
        doorCtx({ source_contract_id: '' }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it('a bound grant is inert against an owner ctx (no source id supplied)', () => {
    expect(
      matchesSessionGrant(
        ownerGrant({ bound_contract_id: DOOR_A }),
        ownerCtx(),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it('REGRESSION PIN — unbound owner grants keep matching owner contexts', () => {
    expect(matchesSessionGrant(ownerGrant(), ownerCtx(), NOW_MS)).toBe(true);
  });
});

// ── N.14.6 — the mcp door ────────────────────────────────────────
//
// ⚠ READ THIS BEFORE WRITING AN "mcp door A vs door B" TEST — it passes without
// the fix and proves nothing. The tier-1 session key is `mcp:<mcp_token_id>`
// (`commit-identity.ts`) and every inbound bearer gets its own token, so two
// distinct doors are ALREADY partitioned: door A's grant is not even in door B's
// listing, and the session clause above rejects it regardless of any binding.
//
// The LIVE vector is one token whose CONTRACT MOVED. `updateTokenContract`
// (D-171 slice 3) rebinds a token in place and deliberately keeps the bearer
// working across the rebind, so `mcp_token_id` — and therefore the session key —
// is STABLE while `contract_id` moves A → B. Contract B then inherits every
// session grant the owner approved for contract A. That is what these pin.
describe('N.14.6 door binding — the mcp door', () => {
  const MCP_DOOR_TOKEN = 'http_9f2c1d4e8a6b3c50';
  const MCP_DOOR_SESSION = `mcp:${MCP_DOOR_TOKEN}`;
  const CONTRACT_A = 'ct_door_mcp_a';
  const CONTRACT_B = 'ct_door_mcp_b';

  const mcpGrant = (
    overrides: Partial<ContractDefinition> = {},
  ): ContractDefinition => ({
    ...ownerGrant(),
    contract_id: 'ct_session_mcp_1',
    scope: {
      channels: ['mcp'],
      actors: ['contracted_user'],
      ingredient_ids: ['mail.send'],
      operation_ids: ['mail.send'],
      connection_names: ['gmail-primary'],
    },
    channel_session_id: MCP_DOOR_SESSION,
    ...overrides,
  });

  const mcpCtx = (
    overrides: Partial<SessionGrantMatchContext> = {},
  ): SessionGrantMatchContext => ({
    ...ownerCtx(),
    channel: 'mcp',
    actor: 'contracted_user',
    channel_session_id: MCP_DOOR_SESSION,
    mcp_token_id: MCP_DOOR_TOKEN,
    source_contract_id: CONTRACT_A,
    ...overrides,
  });

  it('what the STAMP buys — a bound grant refuses the rebound token (clause 1)', () => {
    // ⚠ This passes WITHOUT N.14.6's matcher change and is NOT the fix's proof —
    // mutation-verified. Clause 1 was always general: any grant CARRYING a binding
    // already required ctx equality. It is here to document what the mint-side
    // stamp is FOR, because clause 1 is inert until something stamps mcp rows —
    // and nothing did (see the next test, which is where the bug actually lived).
    const granted = mcpGrant({ bound_contract_id: CONTRACT_A });
    expect(matchesSessionGrant(granted, mcpCtx(), NOW_MS)).toBe(true);
    // The owner rebinds the SAME token to contract B. Same bearer, same token,
    // same session key — only the contract moved. The grant must not follow.
    expect(
      matchesSessionGrant(granted, mcpCtx({ source_contract_id: CONTRACT_B }), NOW_MS),
    ).toBe(false);
  });

  it('THE BUG — an UNBOUND mcp grant is inert against a door', () => {
    // This is the fix's real proof (mutation-verified: reverting clause 2 to its
    // actor keying turns this red). EVERY mcp mint landed unbound — the mint scopes
    // `actors: ['contracted_user']`, so the store's anonymous-requires-a-binding
    // fence never fired — which left clause 1 with nothing to compare and clause 2
    // looking only for `anonymous`. Both no-opped, and the row matched. A rebind
    // then handed contract B every grant the owner approved for contract A.
    expect(matchesSessionGrant(mcpGrant(), mcpCtx(), NOW_MS)).toBe(false);
  });

  it('REGRESSION PIN — the owner\'s own stdio client still rides its unbound grants', () => {
    // The whole hazard of this clause: the mcp channel forces the OWNER to
    // `contracted_user` + a `contract_id` too. Classify by actor and the owner's
    // own local client stops matching its own grants.
    const ownerToken = STDIO_MCP_TOKEN_ID;
    const ownerSession = `mcp:${ownerToken}`;
    expect(
      matchesSessionGrant(
        mcpGrant({ channel_session_id: ownerSession }),
        mcpCtx({
          channel_session_id: ownerSession,
          mcp_token_id: ownerToken,
          source_contract_id: undefined,
        }),
        NOW_MS,
      ),
    ).toBe(true);
  });

  it('FAIL-CLOSED — an mcp ctx that supplies no token id is treated as a door', () => {
    // The owner PROVES ownership with the sentinel; absence is never a pass.
    // A caller that forgets the supply breaks the owner's client loudly rather
    // than handing a door the owner's authority silently.
    expect(
      matchesSessionGrant(mcpGrant(), mcpCtx({ mcp_token_id: undefined }), NOW_MS),
    ).toBe(false);
  });

  it('an owner-shaped ctx CARRYING a contract id still rides an unbound grant', () => {
    // The reason this clause keys on a CLASSIFIED source and not on
    // `source_contract_id !== undefined`. A self-restricted `user_self` carries a
    // contract_id (`commits.ts` — "during work hours, no destructive tools") and is
    // the OWNER, not a door; so does the owner's contracted chat. Presence-keying
    // would read either as a door and strip it of its own unbound grants — the
    // regression v1 deferred this whole clause to avoid.
    //
    // ⚠ Mutation-derived: swapping the clause to `ctx.source_contract_id !== undefined`
    // passed every OTHER test in this file. Nothing drove a contract-carrying
    // non-door through the matcher, so the comment claimed a property the suite
    // never checked. This is that check — do not delete it.
    expect(
      matchesSessionGrant(
        ownerGrant(),
        ownerCtx({ source_contract_id: 'ct_self_restriction' }),
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      matchesSessionGrant(
        ownerGrant({ scope: { ...ownerGrant().scope, actors: ['contracted_user'] } }),
        ownerCtx({ actor: 'contracted_user', source_contract_id: 'ct_owner_chat' }),
        NOW_MS,
      ),
    ).toBe(true);
  });

  it('the door classifier holds the line at the owner-shaped non-doors', () => {
    // A self-restricted `user_self` and a contracted chat BOTH carry a
    // contract_id. Presence-keying this clause would strip them of their
    // grants — which is why it keys on a classified source instead.
    expect(isDoorMatchContext({ channel: 'reception', actor: 'anonymous' })).toBe(true);
    expect(
      isDoorMatchContext({ channel: 'mcp', actor: 'contracted_user', mcp_token_id: 'http_x' }),
    ).toBe(true);
    expect(
      isDoorMatchContext({
        channel: 'mcp',
        actor: 'contracted_user',
        mcp_token_id: STDIO_MCP_TOKEN_ID,
      }),
    ).toBe(false);
    expect(isDoorMatchContext({ channel: 'chat', actor: 'user_self' })).toBe(false);
    expect(isDoorMatchContext({ channel: 'chat', actor: 'contracted_user' })).toBe(false);
  });

  it('⚠ TRIPWIRE — `(chat, contracted_user)` stays UNSEEDED, or llm_gateway needs a door signal', () => {
    // The `llm_gateway` door dispatches `(chat, contracted_user)` with a
    // contract_id (`chat-orchestrator.ts` `runLlmGatewayTurn`) and is NOT
    // classified as a door by `isDoorMatchContext` — deliberately, because it
    // cannot hold a session grant at all:
    //   1. its cell is unseeded ⇒ `allow_session` is never offered, so no grant
    //      is ever minted for it; and
    //   2. its session id carries a per-request randomUUID ⇒ the tier-1 key
    //      never repeats, so a grant could not match a second call anyway.
    //
    // Seeding this ONE cell removes reason 1 and hands llm_gateway the ability to
    // hold grants while it still reads as not-a-door — creating the mcp defect on
    // the chat channel. There is no other signal on that source to catch it with
    // (its own token lives behind a `chat_session_id` string prefix, which is a
    // naming convention, not a discriminator). So this cell's absence is
    // load-bearing, and nothing else in the tree says so.
    //
    // If you are here because you seeded it: give llm_gateway a first-class door
    // signal on `ExecutionSource` and an arm in `isDoorMatchContext` FIRST.
    expect(seededSessionGrantDefaults('chat', 'contracted_user')).toBeUndefined();
    expect(resolveSessionGrantOffer({
      channel: 'chat',
      actor: 'contracted_user',
      risk_tier: 'write',
    })).toBeUndefined();
    // The cells that ARE seeded — the exact list, so a new one is a deliberate edit.
    expect(SESSION_GRANT_DEFAULT_SEEDS.map(({ channel, actor }) => `${channel}:${actor}`))
      .toEqual([
        'chat:user_self',
        'messenger:user_self',
        'mcp:contracted_user',
        'reception:anonymous',
      ]);
  });

  it('the trust axis and the grant axis classify the same dispatch identically', () => {
    // Both ask "is this mcp dispatch the owner or a door?" of the same field.
    // They were one inlined `!==` apart; this pins that they answer as one.
    for (const token of [STDIO_MCP_TOKEN_ID, 'http_9f2c1d4e8a6b3c50', 'tok_other']) {
      const source = {
        channel: 'mcp' as const,
        actor: 'contracted_user' as const,
        agent_id: 'a',
        tool_call_id: 't',
        mcp_token_id: token,
        contract_id: token,
      };
      const grantAxisSaysDoor = isDoorMatchContext({
        channel: 'mcp',
        actor: 'contracted_user',
        mcp_token_id: token,
      });
      // `contract-less admin` is the ceiling the trust axis gives the OWNER;
      // anything else means it classified a delegated door.
      const trustAxisSaysDoor = resolveTrustCeiling(source) !== CONTRACT_LESS_TRUST_CEILING;
      expect(trustAxisSaysDoor, token).toBe(grantAxisSaysDoor);
    }
  });
});

describe('N.14 door binding — delegation variant', () => {
  const doorRule = (
    overrides: Partial<ContractDefinition> = {},
  ): ContractDefinition =>
    doorSessionGrant({
      contract_id: 'ct_delegation_door_1',
      grant_kind: 'delegation',
      channel_session_id: undefined,
      max_uses: 100,
      uses_remaining: 100,
      ...overrides,
    });

  // A delegation row must carry NO channel_session_id — build it clean.
  const cleanRule = (overrides: Partial<ContractDefinition> = {}): ContractDefinition => {
    const { channel_session_id: _dropped, ...rest } = doorRule(overrides);
    return rest as ContractDefinition;
  };

  it('a bound door rule admits fires on its door across differing payloads only per its mode', () => {
    expect(matchesDelegationRule(cleanRule(), doorCtx(), NOW_MS)).toBe(true);
  });

  it("a bound door rule never matches another door's fire", () => {
    expect(
      matchesDelegationRule(cleanRule(), doorCtx({ source_contract_id: DOOR_B }), NOW_MS),
    ).toBe(false);
  });

  it('an anonymous ctx never matches an unbound delegation rule (clause 2)', () => {
    const unbound = cleanRule();
    const { bound_contract_id: _dropped, ...rest } = unbound;
    expect(
      matchesDelegationRule(rest as ContractDefinition, doorCtx(), NOW_MS),
    ).toBe(false);
  });

  it('REGRESSION PIN — an unbound owner delegation rule keeps matching owner contexts', () => {
    const rule = cleanRule({
      scope: {
        channels: ['chat'],
        actors: ['user_self'],
        ingredient_ids: ['mail.send'],
        operation_ids: ['mail.send'],
        connection_names: ['gmail-primary'],
      },
    });
    const { bound_contract_id: _dropped, ...unbound } = rule;
    expect(
      matchesDelegationRule(
        unbound as ContractDefinition,
        ownerCtx({ channel_session_id: 'chat:s-other' }),
        NOW_MS,
      ),
    ).toBe(true);
  });
});

describe('N.14 (reception, anonymous) seed', () => {
  it('the cell is seeded with the door-scaled defaults', () => {
    expect(seededSessionGrantDefaults('reception', 'anonymous')).toBe(
      RECEPTION_SESSION_GRANT_DEFAULTS,
    );
    expect(RECEPTION_SESSION_GRANT_DEFAULTS).toEqual({
      ttl_ms: 86_400_000,
      max_uses: 20,
      grantable_risk_tiers: ['write'],
    });
  });

  it('offers allow-for-this-form on a write hold, and only write', () => {
    expect(
      resolveSessionGrantOffer({
        channel: 'reception',
        actor: 'anonymous',
        risk_tier: 'write',
      }),
    ).toEqual({ ttl_ms: 86_400_000, max_uses: 20, risk_tier: 'write' });
    expect(
      resolveSessionGrantOffer({
        channel: 'reception',
        actor: 'anonymous',
        risk_tier: 'admin',
      }),
    ).toBeUndefined();
  });

  it('NEGATIVE PIN — the webhook door cell stays unseeded (no offer)', () => {
    expect(seededSessionGrantDefaults('webhook', 'anonymous')).toBeUndefined();
    expect(
      resolveSessionGrantOffer({
        channel: 'webhook',
        actor: 'anonymous',
        risk_tier: 'write',
      }),
    ).toBeUndefined();
  });
});

// ── The learner on door keys (s3) ────────────────────────────────

describe('N.14 learner — door key derivation', () => {
  const consumed = (row: ContractDefinition): ContractDefinition => ({
    ...row,
    uses_remaining: (row.uses_remaining ?? 1) - 1,
  });

  it('derives a door key carrying the binding from a door session row', () => {
    const key = deriveDelegationRuleSuggestionKey(consumed(doorSessionGrant()));
    expect(key).toMatchObject({
      channel: 'reception',
      actor: 'anonymous',
      bound_contract_id: DOOR_A,
      ingredient_id: 'mail.send',
      grant_mode: 'exact',
    });
  });

  it('keys on the DOOR — two doors never pool', () => {
    const a = deriveDelegationRuleSuggestionKey(consumed(doorSessionGrant()));
    const b = deriveDelegationRuleSuggestionKey(
      consumed(
        doorSessionGrant({
          bound_contract_id: DOOR_B,
          channel_session_id: 'reception:endpoint-b',
        }),
      ),
    );
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(delegationRuleSuggestionKeyHash(a!)).not.toBe(
      delegationRuleSuggestionKeyHash(b!),
    );
  });

  it('FAIL-CLOSED — anonymous without binding, non-reception, owner-with-binding, contracted_user all derive nothing', () => {
    const unbound = doorSessionGrant();
    const { bound_contract_id: _dropped, ...rest } = unbound;
    expect(
      deriveDelegationRuleSuggestionKey(rest as ContractDefinition),
    ).toBeUndefined();
    expect(
      deriveDelegationRuleSuggestionKey(
        doorSessionGrant({
          scope: { ...doorSessionGrant().scope, channels: ['webhook'] },
        }),
      ),
    ).toBeUndefined();
    expect(
      deriveDelegationRuleSuggestionKey(
        ownerGrant({ bound_contract_id: DOOR_A }),
      ),
    ).toBeUndefined();
    expect(
      deriveDelegationRuleSuggestionKey(
        ownerGrant({
          scope: { ...ownerGrant().scope, actors: ['contracted_user'] },
        }),
      ),
    ).toBeUndefined();
  });

  it('REGRESSION PIN — owner rows still derive keys, without a binding', () => {
    const key = deriveDelegationRuleSuggestionKey(consumed(ownerGrant()));
    expect(key).toMatchObject({ channel: 'chat', actor: 'user_self' });
    expect(key).not.toHaveProperty('bound_contract_id');
  });
});

describe('N.14 learner — door evidence counts rows, not sessions', () => {
  const doorRow = (i: number): ContractDefinition =>
    doorSessionGrant({
      contract_id: `ct_session_door_${i}`,
      minted_at: NOW_MS - i * 1_000,
      max_uses: 20,
      uses_remaining: 19,
    });

  it('three door rows on ONE shared session id qualify (the door adaptation)', () => {
    const verdict = evaluateDelegationRuleSuggestionGroup(
      [doorRow(1), doorRow(2), doorRow(3)],
      NOW_MS,
    );
    expect(verdict.qualifies).toBe(true);
    if (!verdict.qualifies) return;
    expect(verdict.evidence.row_count).toBe(3);
    expect(verdict.evidence.distinct_session_count).toBe(1);
  });

  it('REGRESSION PIN — three OWNER rows on one session id still do NOT qualify', () => {
    const ownerRow = (i: number): ContractDefinition =>
      ownerGrant({
        contract_id: `ct_session_owner_${i}`,
        minted_at: NOW_MS - i * 1_000,
        uses_remaining: 4,
      });
    expect(
      evaluateDelegationRuleSuggestionGroup(
        [ownerRow(1), ownerRow(2), ownerRow(3)],
        NOW_MS,
      ).qualifies,
    ).toBe(false);
  });

  it('door rows keep every other floor — revocation poisons, stale rows age out', () => {
    expect(
      evaluateDelegationRuleSuggestionGroup(
        [doorRow(1), doorRow(2), { ...doorRow(3), revoked_at: NOW_MS - 1 }],
        NOW_MS,
      ).qualifies,
    ).toBe(false);
    expect(
      evaluateDelegationRuleSuggestionGroup(
        [
          doorRow(1),
          doorRow(2),
          {
            ...doorRow(3),
            minted_at: NOW_MS - DELEGATION_SUGGEST_LOOKBACK_MS - 1,
          },
        ],
        NOW_MS,
      ).qualifies,
    ).toBe(false);
  });
});

describe('N.14 learner — door mint plan', () => {
  const doorKey = () =>
    deriveDelegationRuleSuggestionKey(
      doorSessionGrant({ max_uses: 20, uses_remaining: 19 }),
    );

  it('a door snapshot plans a door-bound anonymous rule', () => {
    const key = doorKey();
    expect(key).toBeDefined();
    const plan = delegationRuleMintPlanFromSnapshot(key!);
    expect(plan).toBeDefined();
    expect(plan!.bound_contract_id).toBe(DOOR_A);
    expect(plan!.scope.actors).toEqual(['anonymous']);
    expect(plan!.scope.channels).toEqual(['reception']);
  });

  it('FAIL-CLOSED — a hand-shaped owner snapshot carrying a binding never mints', () => {
    const key = doorKey()!;
    expect(
      delegationRuleMintPlanFromSnapshot({ ...key, actor: 'user_self' }),
    ).toBeUndefined();
    const { bound_contract_id: _dropped, ...unbound } = key;
    expect(delegationRuleMintPlanFromSnapshot(unbound)).toBeUndefined();
  });
});

// ── door_submission projection class ─────────────────────────────

type FixtureStore = Record<string, unknown>;

const lookupRef = (store: FixtureStore, ref: string): unknown => {
  const normalized = ref.replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').trim();
  let current: unknown = store;
  for (const segment of normalized.split('.')) {
    if (
      current === null
      || typeof current !== 'object'
      || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const resolveValue = (store: FixtureStore, value: unknown): unknown => {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([^}]+)\s*\}\}$/);
    if (whole !== null) return lookupRef(store, whole[1]!);
    return value.replace(/\{\{([^}]+)\}\}/g, (_match, ref: string) =>
      String(lookupRef(store, ref)));
  }
  return value;
};

const computeDoor = (args: {
  readonly store: FixtureStore;
  readonly mergedArgs: Record<string, unknown>;
  readonly doorSubmissionTrusted?: boolean;
  readonly eventContextTrusted?: boolean;
}): OpenProjectionComputation | { refused: string } => {
  const input: ComputeOpenProjectionArgs = {
    mergedArgs: args.mergedArgs,
    authorityPaths: ['to'],
    steps: [],
    ...(args.doorSubmissionTrusted !== undefined
      ? { doorSubmissionTrusted: args.doorSubmissionTrusted }
      : {}),
    ...(args.eventContextTrusted !== undefined
      ? { eventContextTrusted: args.eventContextTrusted }
      : {}),
    resolveRootValue: (ref) => lookupRef(args.store, ref),
    resolveArgValue: (unresolvedValue) => resolveValue(args.store, unresolvedValue),
    getIngredientKind: () => undefined,
  };
  return computeOpenProjection(input);
};

const submissionStore = (email: string): FixtureStore => ({
  context: {
    reception_submission: { email },
    reception_order: { order_id: 'ord-1' },
  },
  config: { template: 'thanks' },
});

describe('N.14 door_submission projection class', () => {
  const submissionArgs = { to: '{{context.reception_submission.email}}' };

  it('classifies submission roots as door_submission (riding) when trusted', () => {
    const result = computeDoor({
      store: submissionStore('visitor-1@example.test'),
      mergedArgs: submissionArgs,
      doorSubmissionTrusted: true,
    });
    expect(isOpenProjectionRefusal(result)).toBe(false);
    if (isOpenProjectionRefusal(result)) return;
    expect(result.projection.args[0]?.roots).toEqual([
      { ref: 'context.reception_submission.email', origin: 'door_submission' },
    ]);
    expect(isWellFormedOpenProjection(result.projection)).toBe(true);
  });

  it('THE LOAD-BEARING PROPERTY — the hash is stable across visitor-varying fires', () => {
    const a = computeDoor({
      store: submissionStore('visitor-1@example.test'),
      mergedArgs: submissionArgs,
      doorSubmissionTrusted: true,
    });
    const b = computeDoor({
      store: submissionStore('visitor-2@example.test'),
      mergedArgs: submissionArgs,
      doorSubmissionTrusted: true,
    });
    expect(isOpenProjectionRefusal(a)).toBe(false);
    expect(isOpenProjectionRefusal(b)).toBe(false);
    if (isOpenProjectionRefusal(a) || isOpenProjectionRefusal(b)) return;
    expect(a.pinned_projection_hash).toBe(b.pinned_projection_hash);
  });

  it('CONTROL — a pinned config root changing DOES change the hash', () => {
    const args = { to: '{{config.template}}' };
    const a = computeDoor({
      store: submissionStore('v@example.test'),
      mergedArgs: args,
      doorSubmissionTrusted: true,
    });
    const store2 = submissionStore('v@example.test');
    (store2.config as Record<string, unknown>).template = 'edited';
    const b = computeDoor({
      store: store2,
      mergedArgs: args,
      doorSubmissionTrusted: true,
    });
    if (isOpenProjectionRefusal(a) || isOpenProjectionRefusal(b)) {
      throw new Error('expected projections');
    }
    expect(a.pinned_projection_hash).not.toBe(b.pinned_projection_hash);
  });

  it('refuses submission roots when the flag is absent (pre-N.14 behavior verbatim)', () => {
    const result = computeDoor({
      store: submissionStore('v@example.test'),
      mergedArgs: submissionArgs,
    });
    expect(isOpenProjectionRefusal(result)).toBe(true);
    if (!isOpenProjectionRefusal(result)) return;
    expect(result.refused).toContain('untrusted_door_submission');
  });

  it('eventContextTrusted alone does NOT trust submission roots (independent flags)', () => {
    const result = computeDoor({
      store: submissionStore('v@example.test'),
      mergedArgs: submissionArgs,
      eventContextTrusted: true,
    });
    expect(isOpenProjectionRefusal(result)).toBe(true);
  });

  it('reception_order roots classify under the same flag', () => {
    const result = computeDoor({
      store: submissionStore('v@example.test'),
      mergedArgs: { to: '{{context.reception_order.order_id}}' },
      doorSubmissionTrusted: true,
    });
    expect(isOpenProjectionRefusal(result)).toBe(false);
    if (isOpenProjectionRefusal(result)) return;
    expect(result.projection.args[0]?.roots[0]?.origin).toBe('door_submission');
  });

  it('other context roots still refuse even with the door flag set', () => {
    const result = computeDoor({
      store: { context: { tabs: ['x'] } },
      mergedArgs: { to: '{{context.tabs}}' },
      doorSubmissionTrusted: true,
    });
    expect(isOpenProjectionRefusal(result)).toBe(true);
    if (!isOpenProjectionRefusal(result)) return;
    expect(result.refused).toContain('unclassified_context_root');
  });
});
