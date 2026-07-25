/** D-177 P2 session-grant store and resolver tests. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  validateContractWrite,
  type ContractDefinition,
  type ContractScope,
  type SessionGrantMatchContext,
} from '@recued/contracts';

import { createSessionGrantResolver } from '../session-grant-resolver.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  SessionGrantMintError,
  createContractDefinitionStore,
  type ContractDefinitionStore,
  type MintContractInput,
  type MintSessionGrantInput,
} from '../storage/contract-definition-store.js';

const NOW = 1_700_000_000_000;

let db: Database.Database;
let store: ContractStore;
let defStore: ContractDefinitionStore;
let idSeq: number;
let storeNow: number;
let defNow: number;

const makeSeqId = (): string => {
  idSeq += 1;
  return `ct_${idSeq}`;
};

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

const mintInput = (overrides: Partial<MintContractInput> = {}): MintContractInput => ({
  minted_by: 'user:1',
  display_name: 'Standing approval',
  scope: { channels: ['chat'], actors: ['user_self'] },
  ...overrides,
});

const mintSessionInput = (
  overrides: Partial<MintSessionGrantInput> = {},
): MintSessionGrantInput => ({
  minted_by: 'user:1',
  display_name: 'Allow this session',
  scope: fullScope(),
  channel_session_id: 's',
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  arg_shape_hash: 'arg-shape-hash',
  // D-177 P3 (codex HIGH fold) — the mint pins the approved tier.
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  entity_scope: 'deal-1',
  approved_action_ref: 'checkpoint-1',
  expiry_at: NOW + 60_000,
  max_uses: 3,
  ...overrides,
});

const rawDefinition = (contract_id: string): ContractDefinition => {
  const row = store.get(CONTRACT_DEFINITION_SCOPE, [contract_id]);
  expect(row).not.toBeNull();
  return row!.value as ContractDefinition;
};

const putDefinition = (def: ContractDefinition): void => {
  store.put(CONTRACT_DEFINITION_SCOPE, [def.contract_id], def);
};

const overwriteDefinitionUnchecked = (def: ContractDefinition): void => {
  db.prepare(
    'UPDATE contract_store SET value_inline = ?, written_at = ? WHERE scope = ? AND seg_key = ?',
  ).run(JSON.stringify(def), storeNow, CONTRACT_DEFINITION_SCOPE, def.contract_id);
};

const sessionRow = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_direct',
  minted_at: NOW,
  minted_by: 'user:1',
  display_name: 'Direct session grant',
  scope: fullScope(),
  grant_kind: 'session',
  grant_mode: 'exact',
  channel_session_id: 's',
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  arg_shape_hash: 'arg-shape-hash',
  // D-177 P3 (codex HIGH fold) — session rows pin the approved tier; the
  // matcher requires equality with the envelope's tier.
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  entity_scope: 'deal-1',
  expiry_at: NOW + 60_000,
  max_uses: 3,
  uses_remaining: 3,
  ...overrides,
});

const scopedSessionRow = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_scoped',
  minted_at: NOW,
  minted_by: 'user:1',
  display_name: 'Scoped session grant',
  scope: {
    ingredient_ids: ['mail.send'],
    operation_ids: ['mail.send'],
    connection_names: ['gmail-primary'],
  },
  grant_kind: 'session',
  grant_mode: 'scoped',
  scoped_source: 'forwarded_item_sender',
  channel_session_id: 's',
  risk_tier: 'write',
  expiry_at: NOW + 60_000,
  uses_remaining: 3,
  ...overrides,
});

const scopedConsumeCall = (overrides: Partial<{
  destination_emails: ReadonlyArray<string>;
  scoped_sender_candidates: ReadonlyArray<{ readonly email: string; readonly contributed_at: number }>;
}> = {}) => ({
  destination_emails: ['sender@example.com'],
  scoped_sender_candidates: [
    { email: 'sender@example.com', contributed_at: NOW },
  ],
  ...overrides,
});

const malformedMintInput = (
  mutate: (value: Record<string, unknown>) => void,
): MintSessionGrantInput => {
  const value = mintSessionInput() as unknown as Record<string, unknown>;
  mutate(value);
  return value as unknown as MintSessionGrantInput;
};

const matchCtx = (
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
  entity_scope: 'deal-1',
  ...overrides,
});

beforeEach(() => {
  db = new Database(':memory:');
  storeNow = NOW;
  defNow = NOW;
  idSeq = 0;
  store = createContractStore(db, { now: () => storeNow });
  store.seedSchema(D165_CONTRACT_SCHEMA);
  defStore = createContractDefinitionStore(store, { now: () => defNow, newId: makeSeqId });
});

afterEach(() => {
  db.close();
});

describe('createContractDefinitionStore - mintSessionGrant', () => {
  it('persists a bounded exact session grant and stamps the default mode explicitly', () => {
    const def = defStore.mintSessionGrant(mintSessionInput());

    expect(def).toEqual(expect.objectContaining({
      contract_id: 'ct_1',
      minted_at: NOW,
      grant_kind: 'session',
      grant_mode: 'exact',
      uses_remaining: 3,
      max_uses: 3,
    }));
    expect(defStore.get(def.contract_id)).toEqual(def);
    expect(defStore.list()).toContainEqual(def);
    expect(defStore.listSessionGrants('s')).toEqual([def]);
    expect(rawDefinition(def.contract_id)).toEqual(def);
  });

  it('round-trips through the contract_definition value shape including nested session fields', () => {
    const def = defStore.mintSessionGrant(mintSessionInput({
      bound_recipe: {
        recipe_id: 'recipe-roundtrip',
        recipe_hash: 'recipe-hash-roundtrip',
      },
      batch_members: [
        { member_id: 'm-1', canonical_payload_hash: 'payload-hash-1' },
      ],
      grant_mode: 'batch',
      canonical_payload_hash: undefined,
      entity_scope: 'account-1',
    }));

    expect(validateContractWrite(
      D165_CONTRACT_SCHEMA,
      CONTRACT_DEFINITION_SCOPE,
      [def.contract_id],
      def,
    )).toEqual([]);
    expect(defStore.get(def.contract_id)).toEqual(def);
  });

  it('rejects malformed session grant mints with SessionGrantMintError', () => {
    const cases: ReadonlyArray<{ name: string; input: MintSessionGrantInput }> = [
      { name: 'empty channel_session_id', input: mintSessionInput({ channel_session_id: '' }) },
      {
        name: 'empty bound_recipe.recipe_id',
        input: mintSessionInput({ bound_recipe: { recipe_id: '', recipe_hash: 'recipe-hash-1' } }),
      },
      {
        name: 'empty bound_recipe.recipe_hash',
        input: mintSessionInput({ bound_recipe: { recipe_id: 'recipe-1', recipe_hash: '' } }),
      },
      { name: 'empty arg_shape_hash', input: mintSessionInput({ arg_shape_hash: '' }) },
      {
        name: 'scope.ingredient_ids absent',
        input: mintSessionInput({ scope: { channels: ['chat'], actors: ['user_self'] } }),
      },
      {
        name: 'scope.ingredient_ids empty',
        input: mintSessionInput({ scope: fullScope({ ingredient_ids: [] }) }),
      },
      {
        name: 'expiry_at missing',
        input: malformedMintInput((value) => {
          delete value.expiry_at;
        }),
      },
      { name: 'expiry_at in the past', input: mintSessionInput({ expiry_at: NOW - 1 }) },
      { name: 'expiry_at equal to now', input: mintSessionInput({ expiry_at: NOW }) },
      { name: 'expiry_at NaN', input: mintSessionInput({ expiry_at: Number.NaN }) },
      { name: 'max_uses zero', input: mintSessionInput({ max_uses: 0 }) },
      { name: 'max_uses negative', input: mintSessionInput({ max_uses: -1 }) },
      { name: 'max_uses non-integer', input: mintSessionInput({ max_uses: 1.5 }) },
      {
        name: 'exact without canonical_payload_hash',
        input: malformedMintInput((value) => {
          delete value.canonical_payload_hash;
        }),
      },
      { name: 'exact with empty canonical_payload_hash', input: mintSessionInput({ canonical_payload_hash: '' }) },
      { name: 'batch without members', input: mintSessionInput({ grant_mode: 'batch' }) },
      {
        name: 'batch with empty members',
        input: mintSessionInput({ grant_mode: 'batch', batch_members: [] }),
      },
      {
        name: 'batch member with empty member_id',
        input: mintSessionInput({
          grant_mode: 'batch',
          batch_members: [{ member_id: '', canonical_payload_hash: 'payload-hash' }],
        }),
      },
      {
        name: 'batch member with empty hash',
        input: mintSessionInput({
          grant_mode: 'batch',
          batch_members: [{ member_id: 'm-1', canonical_payload_hash: '' }],
        }),
      },
      {
        name: 'open without pinned_projection_hash',
        input: mintSessionInput({ grant_mode: 'open', open_projection: { roots: [] } }),
      },
      {
        name: 'open with empty pinned_projection_hash',
        input: mintSessionInput({
          grant_mode: 'open',
          pinned_projection_hash: '',
          open_projection: { roots: [] },
        }),
      },
      {
        name: 'open without open_projection',
        input: mintSessionInput({ grant_mode: 'open', pinned_projection_hash: 'projection-hash' }),
      },
    ];

    for (const testCase of cases) {
      expect(
        () => defStore.mintSessionGrant(testCase.input),
        testCase.name,
      ).toThrow(SessionGrantMintError);
    }
    expect(store.scan(CONTRACT_DEFINITION_SCOPE)).toHaveLength(0);
  });

  it('leaves standing mint unaffected and without grant_kind', () => {
    const standing = defStore.mint(mintInput({ max_uses: 2 }));
    const value = rawDefinition(standing.contract_id) as unknown as Record<string, unknown>;

    expect(standing).toEqual(expect.objectContaining({
      contract_id: 'ct_1',
      uses_remaining: 2,
    }));
    expect(value).not.toHaveProperty('grant_kind');
    expect(defStore.listSessionGrants('s')).toEqual([]);
  });
});

describe('createContractDefinitionStore - listSessionGrants', () => {
  it('filters to session rows for the channel session and orders by expiry, minted_at, then id', () => {
    putDefinition(sessionRow({
      contract_id: 'ct_expired',
      expiry_at: NOW - 1,
      minted_at: NOW + 50,
      uses_remaining: 1,
    }));
    putDefinition(sessionRow({
      contract_id: 'ct_revoked',
      expiry_at: NOW + 1_000,
      minted_at: NOW + 40,
      revoked_at: NOW,
      revocation_reason: 'owner disabled',
    }));
    putDefinition(sessionRow({
      contract_id: 'ct_late',
      expiry_at: NOW + 10_000,
      minted_at: NOW + 30,
    }));
    putDefinition(sessionRow({
      contract_id: 'ct_early',
      expiry_at: NOW + 10_000,
      minted_at: NOW + 10,
    }));
    putDefinition(sessionRow({
      contract_id: 'ct_early_b',
      expiry_at: NOW + 10_000,
      minted_at: NOW + 10,
    }));
    putDefinition(sessionRow({
      contract_id: 'ct_other_session',
      channel_session_id: 'other-session',
      expiry_at: NOW,
    }));
    putDefinition({
      ...sessionRow({
        contract_id: 'ct_standing_same_session',
        channel_session_id: 's',
      }),
      grant_kind: undefined,
    } as unknown as ContractDefinition);

    expect(defStore.listSessionGrants('s').map(def => def.contract_id)).toEqual([
      'ct_expired',
      'ct_revoked',
      'ct_early',
      'ct_early_b',
      'ct_late',
    ]);
  });
});

describe('createContractDefinitionStore - consumeSessionGrant', () => {
  it('decrements bounded session grants, persists each consume, and fails closed on inert rows', () => {
    const grant = defStore.mintSessionGrant(mintSessionInput({ max_uses: 3 }));

    expect(defStore.consumeSessionGrant(grant.contract_id)).toBe(true);
    expect(rawDefinition(grant.contract_id)).toEqual(expect.objectContaining({ uses_remaining: 2 }));
    expect(defStore.consumeSessionGrant(grant.contract_id)).toBe(true);
    expect(rawDefinition(grant.contract_id)).toEqual(expect.objectContaining({ uses_remaining: 1 }));
    expect(defStore.consumeSessionGrant(grant.contract_id)).toBe(true);
    expect(rawDefinition(grant.contract_id)).toEqual(expect.objectContaining({ uses_remaining: 0 }));
    expect(defStore.consumeSessionGrant(grant.contract_id)).toBe(false);

    expect(defStore.consumeSessionGrant('ct_missing')).toBe(false);

    const standing = defStore.mint(mintInput({ max_uses: 1 }));
    expect(defStore.consumeSessionGrant(standing.contract_id)).toBe(false);
    expect(rawDefinition(standing.contract_id)).toEqual(expect.objectContaining({ uses_remaining: 1 }));

    const revoked = defStore.mintSessionGrant(mintSessionInput({ max_uses: 1 }));
    defStore.revoke(revoked.contract_id, 'kill switch');
    expect(defStore.consumeSessionGrant(revoked.contract_id)).toBe(false);
    expect(rawDefinition(revoked.contract_id)).toEqual(expect.objectContaining({ uses_remaining: 1 }));

    putDefinition(sessionRow({
      contract_id: 'ct_expired',
      expiry_at: NOW - 1,
      uses_remaining: 1,
    }));
    expect(defStore.consumeSessionGrant('ct_expired')).toBe(false);
    expect(rawDefinition('ct_expired')).toEqual(expect.objectContaining({ uses_remaining: 1 }));

    putDefinition(sessionRow({
      contract_id: 'ct_null_uses',
      uses_remaining: null,
    } as unknown as ContractDefinition));
    expect(defStore.consumeSessionGrant('ct_null_uses')).toBe(false);
    expect(rawDefinition('ct_null_uses')).toEqual(expect.objectContaining({ uses_remaining: null }));

    const stripped = sessionRow({ contract_id: 'ct_absent_uses' }) as unknown as Record<string, unknown>;
    delete stripped.uses_remaining;
    putDefinition(stripped as unknown as ContractDefinition);
    expect(defStore.consumeSessionGrant('ct_absent_uses')).toBe(false);
    expect(rawDefinition('ct_absent_uses')).not.toHaveProperty('uses_remaining');
  });
});

describe('createContractDefinitionStore - scoped grant consume arm', () => {
  it('decrements a scoped row only when the consume call proves containment', () => {
    putDefinition(scopedSessionRow());

    expect(defStore.consumeSessionGrant('ct_scoped', scopedConsumeCall())).toBe(true);
    expect(rawDefinition('ct_scoped')).toEqual(expect.objectContaining({
      uses_remaining: 2,
    }));
  });

  it('refuses missing fields and out-of-window containment without consuming a use', () => {
    putDefinition(scopedSessionRow({ contract_id: 'ct_missing_fields' }));
    expect(defStore.consumeSessionGrant('ct_missing_fields', {
      destination_emails: ['sender@example.com'],
    })).toBe(false);
    expect(rawDefinition('ct_missing_fields')).toEqual(expect.objectContaining({
      uses_remaining: 3,
    }));

    putDefinition(scopedSessionRow({ contract_id: 'ct_out_of_window' }));
    expect(defStore.consumeSessionGrant('ct_out_of_window', scopedConsumeCall({
      scoped_sender_candidates: [
        { email: 'sender@example.com', contributed_at: NOW - 1 },
      ],
    }))).toBe(false);
    expect(rawDefinition('ct_out_of_window')).toEqual(expect.objectContaining({
      uses_remaining: 3,
    }));
  });

  it('refuses an undefined consume call without consuming a use', () => {
    putDefinition(scopedSessionRow());

    expect(defStore.consumeSessionGrant('ct_scoped')).toBe(false);
    expect(rawDefinition('ct_scoped')).toEqual(expect.objectContaining({
      uses_remaining: 3,
    }));
  });

  it('refuses an unknown grant_mode instead of falling through to exact consumption', () => {
    const row = scopedSessionRow({
      contract_id: 'ct_future_mode',
    });
    putDefinition(row);
    overwriteDefinitionUnchecked({
      ...row,
      grant_mode: 'future_mode',
    } as unknown as ContractDefinition);

    expect(defStore.consumeSessionGrant('ct_future_mode')).toBe(false);
    expect(rawDefinition('ct_future_mode')).toEqual(expect.objectContaining({
      uses_remaining: 3,
    }));
  });
});

describe('createSessionGrantResolver', () => {
  it('returns the soonest-expiring matching grant id among several candidates', () => {
    putDefinition(sessionRow({
      contract_id: 'ct_nonmatching_soon',
      expiry_at: NOW + 1_000,
      canonical_payload_hash: 'other-payload',
    }));
    putDefinition(sessionRow({
      contract_id: 'ct_matching_late',
      expiry_at: NOW + 10_000,
    }));
    putDefinition(sessionRow({
      contract_id: 'ct_matching_soon',
      expiry_at: NOW + 2_000,
    }));
    const resolver = createSessionGrantResolver({ definitionStore: defStore, now: () => NOW });

    expect(resolver.match(matchCtx())).toBe('ct_matching_soon');
  });

  it('returns null when no grants match the envelope', () => {
    defStore.mintSessionGrant(mintSessionInput({ canonical_payload_hash: 'other-payload' }));
    const resolver = createSessionGrantResolver({ definitionStore: defStore, now: () => NOW });

    expect(resolver.match(matchCtx())).toBeNull();
  });

  it('delegates consumption and fails after exhaustion', () => {
    const grant = defStore.mintSessionGrant(mintSessionInput({ max_uses: 1 }));
    const resolver = createSessionGrantResolver({ definitionStore: defStore, now: () => NOW });

    expect(resolver.consume(grant.contract_id)).toBe(true);
    expect(resolver.consume(grant.contract_id)).toBe(false);
  });

  it('fails consumption after a revoke between match and consume', () => {
    const grant = defStore.mintSessionGrant(mintSessionInput({ max_uses: 1 }));
    const resolver = createSessionGrantResolver({ definitionStore: defStore, now: () => NOW });

    expect(resolver.match(matchCtx())).toBe(grant.contract_id);
    defStore.revoke(grant.contract_id, 'revoked after match');

    expect(resolver.consume(grant.contract_id)).toBe(false);
  });
});
