/** D-177 P6a delegation-rule store, resolver, and overlay tests. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  validateContractWrite,
  type ContractDefinition,
  type ContractScope,
  type ExecutionSource,
  type OpenProjection,
  type SessionGrantMatchContext,
} from '@recued/contracts';

import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
  type MintContractInput,
} from '../storage/contract-definition-store.js';
import {
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';

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

const mintInput = (overrides: Partial<MintContractInput> = {}): MintContractInput => ({
  minted_by: 'user:1',
  display_name: 'Standing approval',
  scope: { channels: ['mcp'], actors: ['contracted_user'], ingredient_ids: ['safe-http'] },
  ...overrides,
});

const delegationRow = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_delegation',
  minted_at: NOW,
  minted_by: 'user:1',
  display_name: 'Delegation rule',
  scope: fullScope(),
  grant_kind: 'delegation',
  grant_mode: 'exact',
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  expiry_at: NOW + 60_000,
  max_uses: 3,
  uses_remaining: 3,
  approved_action_ref: 'checkpoint-1',
  ...overrides,
});

const sessionRow = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_session',
  minted_at: NOW,
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
  expiry_at: NOW + 60_000,
  max_uses: 3,
  uses_remaining: 3,
  approved_action_ref: 'checkpoint-1',
  ...overrides,
});

const standingRow = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_standing',
  minted_at: NOW,
  minted_by: 'user:1',
  display_name: 'Standing contract',
  scope: fullScope(),
  expiry_at: NOW + 60_000,
  max_uses: 3,
  uses_remaining: 3,
  ...overrides,
});

const matchCtx = (
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
  arg_shape_hash: 'arg-shape-hash',
  canonical_payload_hash: 'payload-hash',
  ...overrides,
});

const mcpSource = (contract_id: string): ExecutionSource => ({
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'stdio-local',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id,
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

describe('createContractDefinitionStore - delegation rows', () => {
  it('writes delegation rows through the contract_definition value shape', () => {
    const def = delegationRow({ contract_id: 'ct_delegation_put' });

    expect(validateContractWrite(
      D165_CONTRACT_SCHEMA,
      CONTRACT_DEFINITION_SCOPE,
      [def.contract_id],
      def,
    )).toEqual([]);
    putDefinition(def);

    expect(rawDefinition(def.contract_id)).toEqual(def);
    expect(defStore.listDelegationRules()).toEqual([def]);
  });

  it('filters delegation rules by kind and orders soonest expiring first', () => {
    putDefinition(delegationRow({
      contract_id: 'ct_expired',
      expiry_at: NOW - 1,
      minted_at: NOW + 50,
      uses_remaining: 1,
    }));
    putDefinition(delegationRow({
      contract_id: 'ct_revoked',
      expiry_at: NOW + 1_000,
      minted_at: NOW + 40,
      revoked_at: NOW,
      revocation_reason: 'owner disabled',
    }));
    putDefinition(delegationRow({
      contract_id: 'ct_late',
      expiry_at: NOW + 10_000,
      minted_at: NOW + 30,
    }));
    putDefinition(delegationRow({
      contract_id: 'ct_early',
      expiry_at: NOW + 10_000,
      minted_at: NOW + 10,
    }));
    putDefinition(delegationRow({
      contract_id: 'ct_early_b',
      expiry_at: NOW + 10_000,
      minted_at: NOW + 10,
    }));
    putDefinition(sessionRow({
      contract_id: 'ct_session_same_shape',
      expiry_at: NOW - 2,
    }));
    putDefinition(standingRow({
      contract_id: 'ct_standing_same_shape',
      expiry_at: NOW - 3,
    }));

    expect(defStore.listDelegationRules().map(def => def.contract_id)).toEqual([
      'ct_expired',
      'ct_revoked',
      'ct_early',
      'ct_early_b',
      'ct_late',
    ]);
  });
});

describe('createContractDefinitionStore - delegation consumption', () => {
  it('decrements exact delegation rows at the proceed point', () => {
    putDefinition(delegationRow({
      contract_id: 'ct_delegation_exact',
      max_uses: 2,
      uses_remaining: 2,
    }));

    expect(defStore.consumeSessionGrant('ct_delegation_exact')).toBe(true);

    expect(rawDefinition('ct_delegation_exact')).toEqual(expect.objectContaining({
      uses_remaining: 1,
    }));
  });

  it('requires a matching pinned projection hash before consuming open delegation rows', () => {
    putDefinition(delegationRow({
      contract_id: 'ct_delegation_open',
      grant_mode: 'open',
      pinned_projection_hash: 'projection-hash',
      open_projection: openProjection(),
      max_uses: 3,
      uses_remaining: 3,
    }));

    expect(defStore.consumeSessionGrant('ct_delegation_open')).toBe(false);
    expect(rawDefinition('ct_delegation_open')).toEqual(expect.objectContaining({
      uses_remaining: 3,
    }));
    expect(defStore.consumeSessionGrant(
      'ct_delegation_open',
      { pinned_projection_hash: 'other-projection' },
    )).toBe(false);
    expect(rawDefinition('ct_delegation_open')).toEqual(expect.objectContaining({
      uses_remaining: 3,
    }));

    expect(defStore.consumeSessionGrant(
      'ct_delegation_open',
      { pinned_projection_hash: 'projection-hash' },
    )).toBe(true);

    expect(rawDefinition('ct_delegation_open')).toEqual(expect.objectContaining({
      uses_remaining: 2,
    }));
  });

  it('refuses malformed delegation vocabulary without decrementing uses', () => {
    const cases: ReadonlyArray<{ name: string; def: ContractDefinition }> = [
      {
        name: 'channel_session_id',
        def: delegationRow({
          contract_id: 'ct_delegation_session_bound',
          channel_session_id: 's-1',
          uses_remaining: 2,
          max_uses: 2,
        }),
      },
      {
        name: 'admin risk_tier',
        def: delegationRow({
          contract_id: 'ct_delegation_admin',
          risk_tier: 'admin',
          uses_remaining: 2,
          max_uses: 2,
        }),
      },
      {
        name: 'batch grant_mode',
        def: delegationRow({
          contract_id: 'ct_delegation_batch',
          grant_mode: 'batch',
          batch_members: [
            { member_id: 'm-1', canonical_payload_hash: 'payload-hash' },
          ],
          uses_remaining: 2,
          max_uses: 2,
        }),
      },
    ];

    for (const testCase of cases) {
      putDefinition(testCase.def);
      expect(defStore.consumeSessionGrant(
        testCase.def.contract_id,
        {
          canonical_payload_hash: 'payload-hash',
          pinned_projection_hash: 'projection-hash',
        },
      ), testCase.name).toBe(false);
      expect(rawDefinition(testCase.def.contract_id), testCase.name)
        .toEqual(expect.objectContaining({ uses_remaining: 2 }));
    }

    const unknown = delegationRow({
      contract_id: 'ct_delegation_unknown_mode',
      uses_remaining: 2,
      max_uses: 2,
    });
    putDefinition(unknown);
    overwriteDefinitionUnchecked({
      ...unknown,
      grant_mode: 'forever',
    } as unknown as ContractDefinition);

    expect(defStore.consumeSessionGrant('ct_delegation_unknown_mode'), 'unknown grant_mode')
      .toBe(false);
    expect(rawDefinition('ct_delegation_unknown_mode'), 'unknown grant_mode')
      .toEqual(expect.objectContaining({ uses_remaining: 2 }));
  });

  it('keeps session-row exact consumption unchanged', () => {
    putDefinition(sessionRow({
      contract_id: 'ct_session_exact',
      max_uses: 2,
      uses_remaining: 2,
    }));

    expect(defStore.consumeSessionGrant('ct_session_exact')).toBe(true);

    expect(rawDefinition('ct_session_exact')).toEqual(expect.objectContaining({
      uses_remaining: 1,
    }));
  });

  it('refuses claimBatchMember on delegation rows', () => {
    putDefinition(delegationRow({
      contract_id: 'ct_delegation_batch_claim',
      grant_mode: 'batch',
      batch_members: [
        { member_id: 'm-1', canonical_payload_hash: 'payload-hash' },
      ],
      max_uses: 1,
      uses_remaining: 1,
    }));

    expect(defStore.claimBatchMember(
      'ct_delegation_batch_claim',
      'm-1',
      { arg_shape_hash: 'arg-shape-hash', canonical_payload_hash: 'payload-hash' },
    )).toBe(false);
    expect(rawDefinition('ct_delegation_batch_claim')).toEqual(expect.objectContaining({
      uses_remaining: 1,
    }));
  });
});

describe('createSessionGrantResolver - delegation pass', () => {
  it('returns the session grant id before a matching delegation rule', () => {
    putDefinition(delegationRow({ contract_id: 'ct_delegation_match' }));
    putDefinition(sessionRow({ contract_id: 'ct_session_match' }));
    const resolver = createSessionGrantResolver({ definitionStore: defStore, now: () => NOW });

    expect(resolver.match(matchCtx())).toBe('ct_session_match');
  });

  it('matches delegation rules across different channel sessions', () => {
    putDefinition(delegationRow({ contract_id: 'ct_delegation_cross_session' }));
    const resolver = createSessionGrantResolver({ definitionStore: defStore, now: () => NOW });

    expect(resolver.match(matchCtx({ channel_session_id: 's-1' })))
      .toBe('ct_delegation_cross_session');
    expect(resolver.match(matchCtx({ channel_session_id: 's-2' })))
      .toBe('ct_delegation_cross_session');
  });

  it('returns null when neither session grants nor delegation rules match', () => {
    putDefinition(sessionRow({
      contract_id: 'ct_session_other_payload',
      canonical_payload_hash: 'other-payload',
    }));
    putDefinition(delegationRow({
      contract_id: 'ct_delegation_other_payload',
      canonical_payload_hash: 'other-payload',
    }));
    const resolver = createSessionGrantResolver({ definitionStore: defStore, now: () => NOW });

    expect(resolver.match(matchCtx())).toBeNull();
  });
});

describe('createContractOverlayResolver - grant rows', () => {
  it('returns inert for live session-grant and delegation source contract ids', () => {
    putDefinition(sessionRow({ contract_id: 'ct_session_live' }));
    putDefinition(delegationRow({ contract_id: 'ct_delegation_live' }));
    const resolver = createContractOverlayResolver({
      definitionStore: defStore,
      now: () => NOW,
    });

    expect(resolver.shouldMeterUse(mcpSource('ct_session_live'), 'mail.send')).toBe(false);
    expect(resolver.shouldMeterUse(mcpSource('ct_delegation_live'), 'mail.send')).toBe(false);
  });

  it('still resolves active standing contracts', () => {
    const standing = defStore.mint(mintInput({ max_uses: 2 }));
    const resolver = createContractOverlayResolver({
      definitionStore: defStore,
      now: () => NOW,
    });

    expect(resolver.shouldMeterUse(mcpSource(standing.contract_id), 'safe-http')).toBe(true);
  });

  it('does not route delegation rows to overlay recordUse after inert resolve', () => {
    putDefinition(delegationRow({
      contract_id: 'ct_delegation_budget',
      max_uses: 3,
      uses_remaining: 3,
    }));
    const resolver = createContractOverlayResolver({
      definitionStore: defStore,
      now: () => NOW,
    });
    const source = mcpSource('ct_delegation_budget');
    const metered = resolver.shouldMeterUse(source, 'mail.send');

    expect(metered).toBe(false);
    if (metered) resolver.recordUse(source);

    expect(rawDefinition('ct_delegation_budget')).toEqual(expect.objectContaining({
      uses_remaining: 3,
    }));
  });
});
