/** D-177 N.11 rule-5 scoped session-grant matcher tests. */

import { describe, expect, it } from 'vitest';

import {
  SCOPED_STRUCTURAL_AUTHORITY_PATHS,
  extractScopedDestinationEmails,
  matchesDelegationRule,
  matchesSessionGrant,
  scopedContainmentAdmits,
  type ContractDefinition,
  type SessionGrantMatchContext,
} from '@recued/contracts';

const NOW_MS = 1_800_000_000_000;

const baseScopedGrant = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_scoped_1',
  minted_at: NOW_MS - 1_000,
  minted_by: 'owner:user-1',
  display_name: 'Allow scoped senders',
  scope: {
    ingredient_ids: ['some-slug'],
    operation_ids: ['mail.send'],
    connection_names: ['myconn'],
  },
  grant_kind: 'session',
  grant_mode: 'scoped',
  scoped_source: 'forwarded_item_sender',
  channel_session_id: 's',
  risk_tier: 'write',
  expiry_at: NOW_MS + 60_000,
  uses_remaining: 3,
  ...overrides,
});

const baseExactGrant = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_exact_1',
  minted_at: NOW_MS - 1_000,
  minted_by: 'owner:user-1',
  display_name: 'Allow exact send',
  scope: {
    ingredient_ids: ['some-slug'],
    operation_ids: ['mail.send'],
    connection_names: ['myconn'],
  },
  grant_kind: 'session',
  grant_mode: 'exact',
  channel_session_id: 's',
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  arg_shape_hash: 'arg-shape-hash',
  canonical_payload_hash: 'payload-hash',
  risk_tier: 'write',
  expiry_at: NOW_MS + 60_000,
  uses_remaining: 3,
  ...overrides,
});

const baseCtx = (
  overrides: Partial<SessionGrantMatchContext> = {},
): SessionGrantMatchContext => ({
  channel: 'chat',
  actor: 'user_self',
  channel_session_id: 's',
  ingredient_slug: 'some-slug',
  operation_id: 'mail.send',
  connection_name: 'myconn',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  risk_tier: 'write',
  pre_lift_approval: 'ask',
  arg_shape_hash: 'arg-shape-hash',
  canonical_payload_hash: 'payload-hash',
  destination_emails: ['sender@example.com'],
  scoped_sender_candidates: [
    { email: 'sender@example.com', contributed_at: NOW_MS },
  ],
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
  ctx: SessionGrantMatchContext = baseCtx(),
): boolean => matchesSessionGrant(grant, ctx, NOW_MS);

const extract = (
  args: Record<string, unknown>,
  authorityPaths: readonly string[],
): string[] | undefined => extractScopedDestinationEmails(args, authorityPaths);

const containment = (
  grant: ContractDefinition,
  ctx: SessionGrantMatchContext = baseCtx(),
): boolean => scopedContainmentAdmits(grant, ctx);

describe('D-177 rule-5 scoped destination extraction', () => {
  it('extracts a happy single string arg', () => {
    expect(extract({ to: 'ada@example.com' }, ['to'])).toEqual([
      'ada@example.com',
    ]);
  });

  it('extracts array destinations element-wise', () => {
    expect(extract({
      to: ['ada@example.com', '<GRACE@example.COM>'],
    }, ['to'])).toEqual(['ada@example.com', 'grace@example.com']);
  });

  it('dedupes canonicalized angle-bracket and case variants', () => {
    expect(extract({
      to: ['<Ada@Example.COM>', 'ada@example.com', '<ada@example.com>'],
    }, ['to'])).toEqual(['ada@example.com']);
  });

  it('skips structural connection-selector authority paths', () => {
    expect(extract({
      connection: 'gmail-primary',
      connection_kind: 'mail',
      to: 'ada@example.com',
    }, [...SCOPED_STRUCTURAL_AUTHORITY_PATHS, 'to'])).toEqual([
      'ada@example.com',
    ]);
  });

  it('skips absent, null, empty-string, and empty-array authority values', () => {
    expect(extract({
      nullish: null,
      empty: '',
      emptyArray: [],
      to: 'ada@example.com',
    }, ['missing', 'nullish', 'empty', 'emptyArray', 'to'])).toEqual([
      'ada@example.com',
    ]);
  });

  it('reads flat dotted keys as own properties', () => {
    expect(extract({ 'body.cc': 'cc@example.com' }, ['body.cc'])).toEqual([
      'cc@example.com',
    ]);
  });

  it('collects both nested and flat dotted readings when both are present', () => {
    expect(extract({
      body: { cc: 'nested@example.com' },
      'body.cc': 'flat@example.com',
    }, ['body.cc'])).toEqual(['nested@example.com', 'flat@example.com']);
  });

  it('fails closed when a nested dotted path hits an array intermediate', () => {
    expect(extract({ body: [] }, ['body.cc'])).toBeUndefined();
  });

  it('fails closed on a non-string array element', () => {
    expect(extract({
      to: ['ada@example.com', 42],
    }, ['to'])).toBeUndefined();
  });

  it('fails closed on URL or opaque-id authority values', () => {
    expect(extract({ url: 'https://example.test/send' }, ['url']))
      .toBeUndefined();
    expect(extract({ id: 'msg_123' }, ['id'])).toBeUndefined();
  });

  it('returns undefined when no email destinations are found', () => {
    expect(extract({
      nullish: null,
      empty: '',
      emptyArray: [],
    }, ['missing', 'nullish', 'empty', 'emptyArray'])).toBeUndefined();
  });

  it('includes an email-shaped message id path-insensitively', () => {
    expect(extract({
      in_reply_to: 'CAO12345@example.mail',
    }, ['in_reply_to'])).toEqual(['cao12345@example.mail']);
  });
});

describe('D-177 rule-5 scoped session grants', () => {
  it('matches when every destination equals an in-window forwarded-sender candidate', () => {
    const grant = baseScopedGrant();

    expect(grant).not.toHaveProperty('bound_recipe');
    expect(grant).not.toHaveProperty('arg_shape_hash');
    expect(matches(grant)).toBe(true);
    expect(containment(grant)).toBe(true);
  });

  it('fails closed across the scoped containment matrix', () => {
    const cases: ReadonlyArray<{
      name: string;
      grant?: ContractDefinition;
      ctx?: SessionGrantMatchContext;
    }> = [
      {
        name: 'scoped_source missing',
        grant: withoutGrantKeys(baseScopedGrant(), ['scoped_source']),
      },
      {
        name: 'scoped_source off enum',
        grant: baseScopedGrant({
          scoped_source: 'body_text_sender',
        } as unknown as Partial<ContractDefinition>),
      },
      {
        name: 'destination_emails absent',
        ctx: withoutCtxKeys(baseCtx(), ['destination_emails']),
      },
      {
        name: 'destination_emails empty',
        ctx: baseCtx({ destination_emails: [] }),
      },
      {
        name: 'scoped_sender_candidates absent',
        ctx: withoutCtxKeys(baseCtx(), ['scoped_sender_candidates']),
      },
      {
        name: 'destination not covered by any candidate',
        ctx: baseCtx({
          destination_emails: ['sender@example.com'],
          scoped_sender_candidates: [
            { email: 'other@example.com', contributed_at: NOW_MS },
          ],
        }),
      },
      {
        name: 'substring or superstring candidate is not an exact match',
        ctx: baseCtx({
          destination_emails: ['a@b.com'],
          scoped_sender_candidates: [
            { email: 'aa@b.com', contributed_at: NOW_MS },
          ],
        }),
      },
      {
        name: 'candidate before minted_at is out of window',
        ctx: baseCtx({
          scoped_sender_candidates: [
            { email: 'sender@example.com', contributed_at: NOW_MS - 1_001 },
          ],
        }),
      },
      {
        name: 'candidate after expiry_at is out of window',
        ctx: baseCtx({
          scoped_sender_candidates: [
            { email: 'sender@example.com', contributed_at: NOW_MS + 60_001 },
          ],
        }),
      },
      {
        name: 'one uncovered destination rejects the whole array',
        ctx: baseCtx({
          destination_emails: ['sender@example.com', 'uncovered@example.com'],
          scoped_sender_candidates: [
            { email: 'sender@example.com', contributed_at: NOW_MS },
          ],
        }),
      },
      {
        name: 'empty-string destination',
        ctx: baseCtx({ destination_emails: [''] }),
      },
    ];

    for (const testCase of cases) {
      const grant = testCase.grant ?? baseScopedGrant();
      const ctx = testCase.ctx ?? baseCtx();
      expect(matches(grant, ctx), testCase.name).toBe(false);
      expect(containment(grant, ctx), `${testCase.name} containment`).toBe(false);
    }
  });

  it('requires operation and connection axes to be explicitly bound for scoped mode', () => {
    const cases: ReadonlyArray<{
      name: string;
      grant?: ContractDefinition;
      ctx?: SessionGrantMatchContext;
    }> = [
      {
        name: 'ctx.operation_id absent',
        ctx: withoutCtxKeys(baseCtx(), ['operation_id']),
      },
      {
        name: 'ctx.operation_id outside scope',
        ctx: baseCtx({ operation_id: 'mail.archive' }),
      },
      {
        name: 'ctx.connection_name absent',
        ctx: withoutCtxKeys(baseCtx(), ['connection_name']),
      },
      {
        name: 'ctx.connection_name outside scope',
        ctx: baseCtx({ connection_name: 'otherconn' }),
      },
      {
        name: 'empty operation_ids array is not a scoped wildcard',
        grant: baseScopedGrant({
          scope: { ...baseScopedGrant().scope, operation_ids: [] },
        }),
      },
      {
        name: 'empty connection_names array is not a scoped wildcard',
        grant: baseScopedGrant({
          scope: { ...baseScopedGrant().scope, connection_names: [] },
        }),
      },
    ];

    for (const testCase of cases) {
      expect(
        matches(testCase.grant ?? baseScopedGrant(), testCase.ctx ?? baseCtx()),
        testCase.name,
      ).toBe(false);
    }
  });

  it('does not admit a scoped delegation row through matchesDelegationRule', () => {
    const scopedDelegation = withoutGrantKeys(
      baseScopedGrant({ grant_kind: 'delegation' }),
      ['channel_session_id'],
    );

    expect(matchesDelegationRule(scopedDelegation, baseCtx(), NOW_MS)).toBe(false);
  });

  it('keeps common session-grant clauses fail-closed for scoped rows', () => {
    const cases: ReadonlyArray<{
      name: string;
      grant?: ContractDefinition;
      ctx?: SessionGrantMatchContext;
    }> = [
      {
        name: 'wrong channel_session_id',
        grant: baseScopedGrant({ channel_session_id: 'other-session' }),
      },
      {
        name: 'revoked row',
        grant: baseScopedGrant({ revoked_at: NOW_MS - 1 }),
      },
      {
        name: 'expired row',
        grant: baseScopedGrant({ expiry_at: NOW_MS - 1 }),
      },
      {
        name: 'uses_remaining zero',
        grant: baseScopedGrant({ uses_remaining: 0 }),
      },
      {
        name: 'risk_tier mismatch',
        grant: baseScopedGrant({ risk_tier: 'read' }),
      },
      {
        name: 'ctx entity_scope set but grant entity_scope absent',
        ctx: baseCtx({ entity_scope: 'deal-1' }),
      },
    ];

    for (const testCase of cases) {
      expect(
        matches(testCase.grant ?? baseScopedGrant(), testCase.ctx ?? baseCtx()),
        testCase.name,
      ).toBe(false);
    }
  });

  it('keeps exact-mode bindings and unknown-mode fail-closed after scoped clauses moved', () => {
    expect(matches(withoutGrantKeys(baseExactGrant(), ['bound_recipe']))).toBe(false);
    expect(matches(withoutGrantKeys(baseExactGrant(), ['arg_shape_hash']))).toBe(false);
    expect(
      matches(baseExactGrant({
        grant_mode: 'future_mode',
      } as unknown as Partial<ContractDefinition>)),
    ).toBe(false);
  });
});
