/** D-202 Slice 0 — the quality-delegation store primitives
 *  (`mintQualityDelegation` / `listQualityDelegations`), exercised through the
 *  REAL contract store (real better-sqlite3 + real `contract_definition`
 *  value-shape validation — only the DB is in-memory). The mint→read→match
 *  round-trip is the load-bearing assertion: it proves the schema enum edit, the
 *  store construction discipline, and the `matchesQualityDelegation` matcher all
 *  agree on the persisted shape end-to-end. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  matchesQualityDelegation,
  type ContractDefinition,
  type ContractScope,
  type QualityDelegationMatchContext,
} from '@recued/contracts';

import {
  createContractDefinitionStore,
  QualityDelegationMintError,
  type ContractDefinitionStore,
  type MintQualityDelegationInput,
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

const makeSeqId = (): string => {
  idSeq += 1;
  return `ct_${idSeq}`;
};

const fullScope = (overrides: Partial<ContractScope> = {}): ContractScope => ({
  channels: ['chat'],
  actors: ['user_self'],
  ingredient_ids: ['mail.send'],
  operation_ids: ['mail.send'],
  ...overrides,
});

const mintInput = (
  overrides: Partial<MintQualityDelegationInput> = {},
): MintQualityDelegationInput => ({
  minted_by: 'owner:user-1',
  display_name: 'Auto-accept delivery quality',
  scope: fullScope(),
  bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
  approved_action_ref: 'suggestion-key-1',
  ...overrides,
});

const matchCtx = (
  overrides: Partial<QualityDelegationMatchContext> = {},
): QualityDelegationMatchContext => ({
  ingredient_slug: 'mail.send',
  operation_id: 'mail.send',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  ...overrides,
});

/** A non-quality row written directly, to prove the listing filters it out. */
const putRow = (def: ContractDefinition): void => {
  store.put(CONTRACT_DEFINITION_SCOPE, [def.contract_id], def);
};

beforeEach(() => {
  db = new Database(':memory:');
  idSeq = 0;
  store = createContractStore(db, { now: () => NOW });
  store.seedSchema(D165_CONTRACT_SCHEMA);
  defStore = createContractDefinitionStore(store, { now: () => NOW, newId: makeSeqId });
});

afterEach(() => {
  db.close();
});

describe('D-202 mintQualityDelegation — persisted shape', () => {
  it('mints a STANDING quality row (no grant_mode / risk_tier / max_uses / expiry)', () => {
    const def = defStore.mintQualityDelegation(mintInput());
    expect(def.grant_kind).toBe('quality_delegation');
    expect(def.bound_recipe).toEqual({ recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' });
    expect(def.approved_action_ref).toBe('suggestion-key-1');
    // Coarse (recipe, op) grain — none of the per-call authorization identity.
    expect(def.grant_mode).toBeUndefined();
    expect(def.risk_tier).toBeUndefined();
    expect(def.arg_shape_hash).toBeUndefined();
    expect(def.canonical_payload_hash).toBeUndefined();
    // Standing — no use budget, no expiry.
    expect(def.max_uses).toBeUndefined();
    expect(def.uses_remaining).toBeUndefined();
    expect(def.expiry_at).toBeUndefined();
  });

  it('round-trips: the persisted row validates AND is matched by matchesQualityDelegation', () => {
    const def = defStore.mintQualityDelegation(mintInput());
    // Re-read from the store (proves it validated through the value_shape).
    const row = store.get(CONTRACT_DEFINITION_SCOPE, [def.contract_id]);
    expect(row).not.toBeNull();
    const persisted = row!.value as ContractDefinition;
    expect(matchesQualityDelegation(persisted, matchCtx(), NOW)).toBe(true);
    // ...and NOT for a different recipe / op (coarse grain still discriminates).
    expect(matchesQualityDelegation(persisted, matchCtx({ recipe_id: 'other' }), NOW)).toBe(
      false,
    );
    expect(
      matchesQualityDelegation(persisted, matchCtx({ ingredient_slug: 'deal.update' }), NOW),
    ).toBe(false);
  });

  it('accepts an OPTIONAL future expiry (owner review cadence)', () => {
    const def = defStore.mintQualityDelegation(mintInput({ expiry_at: NOW + 60_000 }));
    expect(def.expiry_at).toBe(NOW + 60_000);
    expect(matchesQualityDelegation(def, matchCtx(), NOW)).toBe(true);
    // Past its expiry it is inert.
    expect(matchesQualityDelegation(def, matchCtx(), NOW + 120_000)).toBe(false);
  });
});

describe('D-202 mintQualityDelegation — fail-loud refusals', () => {
  it('rejects empty recipe identity', () => {
    expect(() =>
      defStore.mintQualityDelegation(
        mintInput({ bound_recipe: { recipe_id: '', recipe_hash: 'h' } }),
      ),
    ).toThrow(QualityDelegationMintError);
    expect(() =>
      defStore.mintQualityDelegation(
        mintInput({ bound_recipe: { recipe_id: 'r', recipe_hash: '' } }),
      ),
    ).toThrow(QualityDelegationMintError);
  });

  it('is OWNER-ONLY — refuses a non-[user_self] actor scope (door-widening guard)', () => {
    expect(() =>
      defStore.mintQualityDelegation(
        mintInput({ scope: fullScope({ actors: ['contracted_user'] }) }),
      ),
    ).toThrow(QualityDelegationMintError);
    expect(() =>
      defStore.mintQualityDelegation(
        mintInput({ scope: fullScope({ actors: ['user_self', 'contracted_user'] }) }),
      ),
    ).toThrow(QualityDelegationMintError);
  });

  it('refuses a wildcard (empty) ingredient axis (N.3)', () => {
    expect(() =>
      defStore.mintQualityDelegation(mintInput({ scope: fullScope({ ingredient_ids: [] }) })),
    ).toThrow(QualityDelegationMintError);
  });

  it('refuses a missing anchor and a non-future explicit expiry', () => {
    expect(() =>
      defStore.mintQualityDelegation(mintInput({ approved_action_ref: '' })),
    ).toThrow(QualityDelegationMintError);
    expect(() =>
      defStore.mintQualityDelegation(mintInput({ expiry_at: NOW - 1 })),
    ).toThrow(QualityDelegationMintError);
    expect(() =>
      defStore.mintQualityDelegation(mintInput({ expiry_at: Number.NaN })),
    ).toThrow(QualityDelegationMintError);
  });
});

describe('D-202 listQualityDelegations — filtered, global scan', () => {
  it('returns only quality rows, never delegation / session / standing', () => {
    defStore.mintQualityDelegation(mintInput({ display_name: 'Q1' }));
    defStore.mintQualityDelegation(
      mintInput({ display_name: 'Q2', bound_recipe: { recipe_id: 'r2', recipe_hash: 'h2' } }),
    );
    // A standing row + a foreign-kind row written directly — must be excluded.
    putRow({
      contract_id: 'ct_standing',
      minted_at: NOW,
      minted_by: 'owner:user-1',
      display_name: 'Standing',
      scope: fullScope(),
    });
    putRow({
      contract_id: 'ct_session',
      minted_at: NOW,
      minted_by: 'owner:user-1',
      display_name: 'Session',
      scope: fullScope(),
      grant_kind: 'session',
      channel_session_id: 's-1',
    });

    const rows = defStore.listQualityDelegations();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.grant_kind === 'quality_delegation')).toBe(true);
    expect(rows.map((r) => r.display_name).sort()).toEqual(['Q1', 'Q2']);
  });

  it('is empty when nothing is minted', () => {
    expect(defStore.listQualityDelegations()).toEqual([]);
  });
});
