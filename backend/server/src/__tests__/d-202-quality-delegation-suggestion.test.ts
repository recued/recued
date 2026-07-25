/** D-202 Task 5B — the quality-delegation suggest→accept + governance rpc,
 *  exercised through the REAL `makeContractHandlers` slice over a real
 *  better-sqlite3 contract store (only the DB is in-memory). Verifies the
 *  accept→mint (kind/scope/bound_recipe/anchor), at-least-once idempotence,
 *  optional-ttl, dismiss (permanent), snapshot↔key integrity, and the
 *  list/revoke governance surface (incl. the non-quality-kind refusal). */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  RpcError,
  qualityDelegationSuggestionKeyHash,
  type ContractDefinition,
  type ContractDefinitionView,
  type IngredientManifest,
  type QualityDelegationSuggestionRow,
  type QualityDelegationSuggestionSnapshot,
} from '@recued/contracts';

import {
  makeContractHandlers,
  type ContractBroadcastEvent,
} from '../contract-handler.js';
import {
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';
import {
  createQualityDelegationSuggestionStore,
  type QualityDelegationSuggestionStore,
} from '../storage/quality-delegation-suggestion-store.js';
import type { WsClient } from '../ws-server.js';

const NOW = 1_800_300_000_000;
const CLIENT = {} as WsClient;

type ContractHandlers = NonNullable<ReturnType<typeof makeContractHandlers>>['handlers'];

let db: Database.Database;
let store: ContractStore;
let suggestionStore: QualityDelegationSuggestionStore;
let handlers: ContractHandlers;
let broadcasts: ContractBroadcastEvent[];
let idSeq: number;
let now: number;

const getManifest = (_slug: string): IngredientManifest | null => null;
const listManifests = (): IngredientManifest[] => [];
const makeSeqId = (): string => {
  idSeq += 1;
  return `ct_${String(idSeq).padStart(3, '0')}`;
};

const baseSnapshot = (
  overrides: Partial<QualityDelegationSuggestionSnapshot> = {},
): QualityDelegationSuggestionSnapshot => ({
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  ingredient_id: 'deliver-doc',
  operation_id: 'deliver-doc.send',
  ...overrides,
});

const seedSuggestion = (
  snapshot: QualityDelegationSuggestionSnapshot = baseSnapshot(),
): string => {
  const key_hash = qualityDelegationSuggestionKeyHash(snapshot);
  suggestionStore.upsertOpen({
    key_hash,
    snapshot,
    evidence: {
      approve_count: 4,
      distinct_session_count: 2,
      sample_refs: ['sig-a', 'sig-b'],
      first_at: NOW - 5_000,
      last_at: NOW,
    },
  });
  return key_hash;
};

const call = <T,>(method: keyof ContractHandlers, args: unknown): Promise<T> =>
  handlers[method](args as never, CLIENT) as Promise<T>;

beforeEach(() => {
  db = new Database(':memory:');
  now = NOW;
  idSeq = 0;
  broadcasts = [];
  store = createContractStore(db, { now: () => now });
  store.seedSchema(D165_CONTRACT_SCHEMA);
  suggestionStore = createQualityDelegationSuggestionStore(store, { now: () => now });
  const slice = makeContractHandlers({
    store,
    now: () => now,
    newContractId: makeSeqId,
    getManifest,
    listManifests,
    broadcast: (e) => broadcasts.push(e),
  });
  handlers = slice!.handlers;
});

afterEach(() => {
  db.close();
});

describe('D-202 accept → mint', () => {
  it('mints a quality_delegation from the snapshot + flips the suggestion', async () => {
    const key_hash = seedSuggestion();
    const res = await call<{
      grant: ContractDefinitionView;
      suggestion: QualityDelegationSuggestionRow;
    }>('collection.contract.acceptQualityDelegationSuggestion', { key_hash });

    expect(res.grant.grant_kind).toBe('quality_delegation');
    expect(res.grant.bound_recipe).toEqual({ recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' });
    expect(res.grant.scope.actors).toEqual(['user_self']); // owner-provenance stamp
    expect(res.grant.scope.ingredient_ids).toEqual(['deliver-doc']);
    expect(res.grant.scope.operation_ids).toEqual(['deliver-doc.send']);
    expect(res.grant.approved_action_ref).toBe(key_hash);
    // Standing by default — no expiry, no use budget.
    expect(res.grant.expiry_at).toBeUndefined();
    expect(res.grant.max_uses).toBeUndefined();
    expect(res.suggestion.state).toBe('accepted');
    // The grant lifecycle broadcast fired (the active-grants list re-lists).
    expect(
      broadcasts.some(
        (e) => e.kind === 'contract.contract_definition_changed' && e.op === 'mint',
      ),
    ).toBe(true);

    // ...and it now appears in the governance listing.
    const list = await call<{ contracts: ContractDefinitionView[] }>(
      'collection.contract.listQualityDelegations',
      undefined,
    );
    expect(list.contracts).toHaveLength(1);
    expect(list.contracts[0].contract_id).toBe(res.grant.contract_id);
  });

  it('is idempotent across at-least-once retries (returns the twin, no second mint)', async () => {
    const key_hash = seedSuggestion();
    const first = await call<{ grant: ContractDefinitionView }>(
      'collection.contract.acceptQualityDelegationSuggestion',
      { key_hash },
    );
    const second = await call<{ grant: ContractDefinitionView }>(
      'collection.contract.acceptQualityDelegationSuggestion',
      { key_hash },
    );
    expect(second.grant.contract_id).toBe(first.grant.contract_id);
    const list = await call<{ contracts: ContractDefinitionView[] }>(
      'collection.contract.listQualityDelegations',
      undefined,
    );
    expect(list.contracts).toHaveLength(1); // no twin minted
  });

  it('applies an OPTIONAL ttl_ms as a self-expiry (no ceiling)', async () => {
    const key_hash = seedSuggestion();
    const res = await call<{ grant: ContractDefinitionView }>(
      'collection.contract.acceptQualityDelegationSuggestion',
      { key_hash, ttl_ms: 60_000 },
    );
    expect(res.grant.expiry_at).toBe(NOW + 60_000);
  });

  it('refuses a dismissed key, and a snapshot↔key mismatch (malformed row)', async () => {
    const dismissedKey = seedSuggestion(baseSnapshot({ recipe_id: 'r-dismiss' }));
    await call('collection.contract.dismissQualityDelegationSuggestion', {
      key_hash: dismissedKey,
    });
    await expect(
      call('collection.contract.acceptQualityDelegationSuggestion', { key_hash: dismissedKey }),
    ).rejects.toBeInstanceOf(RpcError);

    // Hand-shaped row: key_hash does not derive from the snapshot.
    const snapshot = baseSnapshot({ recipe_id: 'r-forged' });
    const forgedKey = 'not-the-real-hash';
    suggestionStore.upsertOpen({
      key_hash: forgedKey,
      snapshot,
      evidence: {
        approve_count: 1,
        distinct_session_count: 1,
        sample_refs: [],
        first_at: NOW,
        last_at: NOW,
      },
    });
    await expect(
      call('collection.contract.acceptQualityDelegationSuggestion', { key_hash: forgedKey }),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

describe('D-202 dismiss', () => {
  it('dismisses an open suggestion (per-key permanent)', async () => {
    const key_hash = seedSuggestion();
    const res = await call<{ suggestion: QualityDelegationSuggestionRow }>(
      'collection.contract.dismissQualityDelegationSuggestion',
      { key_hash },
    );
    expect(res.suggestion.state).toBe('dismissed');
    // Re-dismiss is idempotent.
    const again = await call<{ suggestion: QualityDelegationSuggestionRow }>(
      'collection.contract.dismissQualityDelegationSuggestion',
      { key_hash },
    );
    expect(again.suggestion.state).toBe('dismissed');
  });
});

describe('D-202 list + revoke governance', () => {
  it('revokes a minted quality delegation, and refuses a non-quality id', async () => {
    const key_hash = seedSuggestion();
    const { grant } = await call<{ grant: ContractDefinitionView }>(
      'collection.contract.acceptQualityDelegationSuggestion',
      { key_hash },
    );

    const revoked = await call<ContractDefinitionView>(
      'collection.contract.revokeQualityDelegation',
      { contract_id: grant.contract_id },
    );
    expect(revoked.lifecycle_state).toBe('revoked');
    expect(
      broadcasts.some(
        (e) => e.kind === 'contract.contract_definition_changed' && e.op === 'revoke',
      ),
    ).toBe(true);

    // A standing (non-quality) row must NOT be revocable through this rpc.
    const standing: ContractDefinition = {
      contract_id: 'ct_standing',
      minted_at: NOW,
      minted_by: 'owner',
      display_name: 'Standing',
      scope: { actors: ['user_self'] },
    };
    store.put(CONTRACT_DEFINITION_SCOPE, [standing.contract_id], standing);
    await expect(
      call('collection.contract.revokeQualityDelegation', { contract_id: 'ct_standing' }),
    ).rejects.toBeInstanceOf(RpcError);
  });
});
