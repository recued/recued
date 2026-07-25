/** D-166 contract_definition lifecycle store tests. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  contractLifecycleState,
  isContractActive,
  type ContractDefinition,
  type ContractScope,
} from '@recued/contracts';

import {
  ContractWriteInvalidError,
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
  type MintContractInput,
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

const mintInput = (overrides: Partial<MintContractInput> = {}): MintContractInput => ({
  minted_by: 'user:1',
  display_name: 'Deal read approval',
  scope: { channels: ['chat'], actors: ['user'] },
  ...overrides,
});

const rawDefinition = (contract_id: string): ContractDefinition => {
  const row = store.get(CONTRACT_DEFINITION_SCOPE, [contract_id]);
  expect(row).not.toBeNull();
  return row!.value as ContractDefinition;
};

beforeEach(() => {
  db = new Database(':memory:');
  storeNow = NOW;
  defNow = NOW;
  idSeq = 0;
  store = createContractStore(db, { now: () => storeNow });
  defStore = createContractDefinitionStore(store, { now: () => defNow, newId: makeSeqId });
});

afterEach(() => {
  db.close();
});

describe('createContractDefinitionStore - mint', () => {
  it('generates a contract_id, stamps minted_at, and round-trips through both stores', () => {
    const def = defStore.mint(mintInput());

    const expected: ContractDefinition = {
      contract_id: 'ct_1',
      minted_at: NOW,
      minted_by: 'user:1',
      display_name: 'Deal read approval',
      scope: { channels: ['chat'], actors: ['user'] },
    };

    expect(def).toEqual(expected);
    expect(defStore.get('ct_1')).toEqual(expected);
    expect(store.get(CONTRACT_DEFINITION_SCOPE, ['ct_1'])?.value).toEqual(expected);
  });

  it('seeds max_uses and uses_remaining to the full bounded counter', () => {
    const def = defStore.mint(mintInput({ max_uses: 3 }));

    expect(def).toEqual(expect.objectContaining({
      max_uses: 3,
      uses_remaining: 3,
    }));
    expect(rawDefinition(def.contract_id)).toEqual(expect.objectContaining({
      max_uses: 3,
      uses_remaining: 3,
    }));
  });

  it('omits max_uses and uses_remaining entirely for unbounded contracts', () => {
    const def = defStore.mint(mintInput());
    const value = rawDefinition(def.contract_id) as unknown as Record<string, unknown>;

    expect('max_uses' in value).toBe(false);
    expect('uses_remaining' in value).toBe(false);
  });

  it('persists expiry_at and approved_actions_template when supplied', () => {
    const approvedActions = {
      actions: [
        {
          ingredient_id: 'hubspot/deal-reader',
          operation_id: 'hubspot/deal-reader.read_deals',
        },
      ],
    };

    const def = defStore.mint(mintInput({
      approved_actions_template: approvedActions,
      expiry_at: NOW + 60_000,
    }));

    expect(def).toEqual(expect.objectContaining({
      approved_actions_template: approvedActions,
      expiry_at: NOW + 60_000,
    }));
    expect(defStore.get(def.contract_id)).toEqual(expect.objectContaining({
      approved_actions_template: approvedActions,
      expiry_at: NOW + 60_000,
    }));
    expect(rawDefinition(def.contract_id)).toEqual(expect.objectContaining({
      approved_actions_template: approvedActions,
      expiry_at: NOW + 60_000,
    }));
  });

  it('accepts wildcard and populated scopes and round-trips them intact', () => {
    const wildcard = defStore.mint(mintInput({
      display_name: 'Wildcard approval',
      scope: {},
    }));
    const populatedScope: ContractScope = { channels: ['chat'], actors: ['user'] };
    const populated = defStore.mint(mintInput({
      display_name: 'Scoped approval',
      scope: populatedScope,
    }));

    expect(wildcard.scope).toEqual({});
    expect(defStore.get(wildcard.contract_id)?.scope).toEqual({});
    expect(rawDefinition(wildcard.contract_id).scope).toEqual({});
    expect(populated.scope).toEqual(populatedScope);
    expect(defStore.get(populated.contract_id)?.scope).toEqual(populatedScope);
    expect(rawDefinition(populated.contract_id).scope).toEqual(populatedScope);
  });

  it('routes minted rows through contract_definition value-shape validation', () => {
    expect(() => {
      defStore.mint(mintInput({
        scope: { channels: [123] } as unknown as ContractScope,
      }));
    }).toThrow(ContractWriteInvalidError);

    expect(store.scan(CONTRACT_DEFINITION_SCOPE)).toHaveLength(0);
  });
});

describe('createContractDefinitionStore - get', () => {
  it('returns null for an absent id', () => {
    expect(defStore.get('ct_missing')).toBeNull();
  });
});

describe('createContractDefinitionStore - list', () => {
  it('returns every minted contract', () => {
    const first = defStore.mint(mintInput({ display_name: 'First' }));
    const second = defStore.mint(mintInput({ display_name: 'Second' }));
    const third = defStore.mint(mintInput({ display_name: 'Third' }));

    expect(defStore.list()).toEqual([first, second, third]);
  });

  it('orders distinct minted_at values newest first', () => {
    const orderingDb = new Database(':memory:');
    let orderingStoreNow = NOW;
    let orderingDefNow = NOW;
    let orderingIdSeq = 0;
    const orderingStore = createContractStore(orderingDb, { now: () => orderingStoreNow });
    const orderingDefStore = createContractDefinitionStore(orderingStore, {
      now: () => {
        orderingDefNow += 1;
        return orderingDefNow;
      },
      newId: () => {
        orderingIdSeq += 1;
        return `ct_${orderingIdSeq}`;
      },
    });

    try {
      orderingStoreNow = NOW + 1;
      const oldest = orderingDefStore.mint(mintInput({ display_name: 'Oldest' }));
      orderingStoreNow = NOW + 2;
      const middle = orderingDefStore.mint(mintInput({ display_name: 'Middle' }));
      orderingStoreNow = NOW + 3;
      const newest = orderingDefStore.mint(mintInput({ display_name: 'Newest' }));

      expect(orderingDefStore.list().map(def => def.minted_at)).toEqual([
        newest.minted_at,
        middle.minted_at,
        oldest.minted_at,
      ]);
      expect(orderingDefStore.list().map(def => def.contract_id)).toEqual([
        newest.contract_id,
        middle.contract_id,
        oldest.contract_id,
      ]);
    } finally {
      orderingDb.close();
    }
  });

  it('orders equal minted_at values by contract_id ascending', () => {
    defStore.mint(mintInput({ display_name: 'First' }));
    defStore.mint(mintInput({ display_name: 'Second' }));
    defStore.mint(mintInput({ display_name: 'Third' }));

    expect(defStore.list().map(def => def.minted_at)).toEqual([NOW, NOW, NOW]);
    expect(defStore.list().map(def => def.contract_id)).toEqual(['ct_1', 'ct_2', 'ct_3']);
  });
});

describe('createContractDefinitionStore - recordUse', () => {
  it('decrements bounded contracts and persists each updated counter', () => {
    const def = defStore.mint(mintInput({ max_uses: 3 }));

    const first = defStore.recordUse(def.contract_id);
    expect(first).toEqual(expect.objectContaining({ uses_remaining: 2 }));
    expect(rawDefinition(def.contract_id)).toEqual(expect.objectContaining({ uses_remaining: 2 }));

    const second = defStore.recordUse(def.contract_id);
    expect(second).toEqual(expect.objectContaining({ uses_remaining: 1 }));
    expect(rawDefinition(def.contract_id)).toEqual(expect.objectContaining({ uses_remaining: 1 }));

    const third = defStore.recordUse(def.contract_id);
    expect(third).toEqual(expect.objectContaining({ uses_remaining: 0 }));
    expect(rawDefinition(def.contract_id)).toEqual(expect.objectContaining({ uses_remaining: 0 }));
  });

  it('exhausts at zero and treats further uses as an idempotent no-op', () => {
    const def = defStore.mint(mintInput({ max_uses: 1 }));

    const updated = defStore.recordUse(def.contract_id);
    expect(updated).toEqual(expect.objectContaining({ uses_remaining: 0 }));
    expect(isContractActive(updated!, NOW)).toBe(false);
    expect(contractLifecycleState(updated!, NOW)).toBe('exhausted');

    const rowAfterExhaustion = store.get(CONTRACT_DEFINITION_SCOPE, [def.contract_id]);
    storeNow = NOW + 1;
    const noOp = defStore.recordUse(def.contract_id);

    expect(noOp).toEqual(expect.objectContaining({ uses_remaining: 0 }));
    expect(store.get(CONTRACT_DEFINITION_SCOPE, [def.contract_id])).toEqual(rowAfterExhaustion);
  });

  it('leaves unbounded contracts unchanged with uses_remaining absent', () => {
    const def = defStore.mint(mintInput());
    const rowBeforeUse = store.get(CONTRACT_DEFINITION_SCOPE, [def.contract_id]);

    storeNow = NOW + 1;
    const updated = defStore.recordUse(def.contract_id);
    const value = rawDefinition(def.contract_id) as unknown as Record<string, unknown>;

    expect(updated).toEqual(def);
    expect('uses_remaining' in (updated as unknown as Record<string, unknown>)).toBe(false);
    expect('uses_remaining' in value).toBe(false);
    expect(store.get(CONTRACT_DEFINITION_SCOPE, [def.contract_id])).toEqual(rowBeforeUse);
  });

  it('returns null for an absent id', () => {
    expect(defStore.recordUse('ct_missing')).toBeNull();
  });

  it('treats null uses_remaining as unbounded and preserves the null row value', () => {
    const contract_id = 'ct_null_uses';
    store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], {
      contract_id,
      minted_at: NOW,
      minted_by: 'u',
      display_name: 'd',
      scope: {},
      uses_remaining: null,
    });
    const rowBeforeUse = store.get(CONTRACT_DEFINITION_SCOPE, [contract_id]);

    storeNow = NOW + 1;
    const updated = defStore.recordUse(contract_id);
    const persisted = store.get(CONTRACT_DEFINITION_SCOPE, [contract_id])?.value as Record<string, unknown>;

    expect(updated).toEqual(expect.objectContaining({ uses_remaining: null }));
    expect(persisted.uses_remaining).toBeNull();
    expect(persisted.uses_remaining).not.toBe(0);
    expect(store.get(CONTRACT_DEFINITION_SCOPE, [contract_id])).toEqual(rowBeforeUse);
  });
});

describe('createContractDefinitionStore - revoke', () => {
  it('stamps revocation provenance, returns inactive state, and persists it', () => {
    const def = defStore.mint(mintInput());

    const updated = defStore.revoke(def.contract_id, 'user disabled');

    expect(updated).toEqual(expect.objectContaining({
      revoked_at: NOW,
      revocation_reason: 'user disabled',
    }));
    expect(isContractActive(updated!, NOW)).toBe(false);
    expect(contractLifecycleState(updated!, NOW)).toBe('revoked');
    expect(rawDefinition(def.contract_id)).toEqual(updated);
  });

  it('preserves the first revocation timestamp and reason on repeated revoke', () => {
    const def = defStore.mint(mintInput());

    defNow = NOW + 1;
    const first = defStore.revoke(def.contract_id, 'first');
    const rowAfterFirstRevoke = store.get(CONTRACT_DEFINITION_SCOPE, [def.contract_id]);

    defNow = NOW + 2;
    storeNow = NOW + 3;
    const second = defStore.revoke(def.contract_id, 'second');

    expect(first).toEqual(expect.objectContaining({
      revoked_at: NOW + 1,
      revocation_reason: 'first',
    }));
    expect(second).toEqual(first);
    expect(rawDefinition(def.contract_id)).toEqual(expect.objectContaining({
      revoked_at: NOW + 1,
      revocation_reason: 'first',
    }));
    expect(store.get(CONTRACT_DEFINITION_SCOPE, [def.contract_id])).toEqual(rowAfterFirstRevoke);
  });

  it('returns null for an absent id', () => {
    expect(defStore.revoke('ct_missing', 'cleanup')).toBeNull();
  });

  it('treats null revoked_at as not yet revoked and stamps a real revocation', () => {
    const contract_id = 'ct_null_revoked';
    store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], {
      contract_id,
      minted_at: NOW,
      minted_by: 'u',
      display_name: 'd',
      scope: {},
      revoked_at: null,
    });

    const updated = defStore.revoke(contract_id, 'r');

    expect(updated).toEqual(expect.objectContaining({
      revoked_at: NOW,
      revocation_reason: 'r',
    }));
    expect(rawDefinition(contract_id)).toEqual(expect.objectContaining({
      revoked_at: NOW,
      revocation_reason: 'r',
    }));
  });
});

describe('createContractDefinitionStore - lifecycle integration', () => {
  it('feeds expired rows into the pure lifecycle helpers', () => {
    const def = defStore.mint(mintInput({ expiry_at: NOW - 1 }));

    expect(isContractActive(def, NOW)).toBe(false);
    expect(contractLifecycleState(def, NOW)).toBe('expired');
  });

  it('feeds active rows into the pure lifecycle helpers', () => {
    const def = defStore.mint(mintInput());

    expect(isContractActive(def, NOW)).toBe(true);
    expect(contractLifecycleState(def, NOW)).toBe('active');
  });
});
