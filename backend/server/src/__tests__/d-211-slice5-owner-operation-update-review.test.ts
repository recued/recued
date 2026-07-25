/** D-211 Slice 5 — incoming pack update review for global owner rulings. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_PACK_INSTALL_PERMISSION,
  OWNER_OPERATION_SCOPE,
  type BulkPackManifest,
  type CompositionIngredient,
  type PackOperationRow,
} from '@recued/contracts';
import { decomposeComposition } from '@recued/ingredient-authoring';

import { operationSpecHash } from '../operation-spec-hash.js';
import { reviewOwnerOperationsForPackUpdate } from '../owner-operation-update-review.js';
import { resolvePackBySlug } from '../pack-install-handler.js';
import { recordPackInventory } from '../pack-inventory.js';
import type { RecipeStore } from '../recipe-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';

const NOW = 1_752_000_000_000;

const operation = (
  op: string,
  risk: PackOperationRow['risk'],
  approval: PackOperationRow['approval'],
  description?: string,
): PackOperationRow => ({
  op,
  ingredient: 'acme',
  risk,
  approval,
  bind: {
    kind: 'rest',
    method: risk === 'read' ? 'GET' : 'POST',
    path_template: `/v1/${op}`,
  },
  ...(description !== undefined ? { description } : {}),
});

const composition = (
  operations: PackOperationRow[],
): CompositionIngredient => ({
  schema_version: 1,
  slug: 'acme',
  catalog_kind: 'private_byo',
  ingredients: [{
    slug: 'acme',
    kind: 'http',
    http: { base: 'https://api.acme.example', connection: 'Acme' },
  }],
  operations,
});

const pack = (
  body: CompositionIngredient | null,
): BulkPackManifest => ({
  manifest_version: 2,
  slug: 'acme-pack',
  publisher: 'recued-core',
  name: 'Acme',
  description: 'Acme operations.',
  version: 2,
  recipes: [],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
  pack_kind: 'app_pack',
  contents: body === null ? [] : [{ type: 'composition', composition: body }],
});

const opSpecs = (body: CompositionIngredient) => {
  const catalog = decomposeComposition[1](body).catalog;
  if (catalog?.operations === undefined) throw new Error('catalog operations missing');
  return new Map(Object.values(catalog.operations).map((op) => [op.operation_id, op]));
};

describe('reviewOwnerOperationsForPackUpdate', () => {
  let db: Database.Database;
  let store: ContractStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
    recordPackInventory(store, {
      pack_slug: 'acme-pack',
      pack_version: 1,
      installed_at: NOW,
      contents: [],
      local_catalogs: [{
        ingredient_id: 'acme',
        version: 1,
        catalog_kind: 'private_byo',
      }],
    });
  });

  afterEach(() => db.close());

  it('returns changed and removed overridden operations while omitting an unchanged ruling', () => {
    const prior = composition([
      operation('deal.read', 'read', 'never'),
      operation('deal.create', 'write', 'ask', 'Create a deal.'),
      operation('deal.archive', 'admin', 'ask'),
    ]);
    const specs = opSpecs(prior);
    const put = (operationId: string, policy: Record<string, unknown>): void => {
      const spec = specs.get(operationId);
      if (spec === undefined) throw new Error(`missing ${operationId}`);
      store.put(OWNER_OPERATION_SCOPE, ['acme', operationId], {
        ...policy,
        op_hash: operationSpecHash(spec),
      });
    };
    put('recued-core/acme.deal.read', { approval: 'ask' });
    put('recued-core/acme.deal.create', { risk: 'admin' });
    put('recued-core/acme.deal.archive', { approval: 'always' });

    const incoming = composition([
      operation('deal.read', 'read', 'never'),
      operation('deal.create', 'write', 'ask', 'Create a deal with audit metadata.'),
    ]);

    expect(reviewOwnerOperationsForPackUpdate(store, pack(incoming))).toEqual([
      {
        ingredient_id: 'acme',
        operation_id: 'recued-core/acme.deal.archive',
        change: 'removed',
        owner_policy: { approval: 'always' },
      },
      {
        ingredient_id: 'acme',
        operation_id: 'recued-core/acme.deal.create',
        change: 'changed',
        owner_policy: { risk: 'admin' },
        incoming: { risk: 'write', approval: 'ask' },
      },
    ]);
  });

  it('marks a dropped ingredient removed only when no other installed pack still claims it', () => {
    const prior = composition([
      operation('deal.read', 'read', 'never'),
      operation('deal.list', 'read', 'never'),
    ]);
    const spec = opSpecs(prior).get('recued-core/acme.deal.read');
    if (spec === undefined) throw new Error('operation missing');
    store.put(OWNER_OPERATION_SCOPE, ['acme', spec.operation_id], {
      approval: 'ask',
      op_hash: operationSpecHash(spec),
    });

    recordPackInventory(store, {
      pack_slug: 'shared-pack',
      pack_version: 1,
      installed_at: NOW,
      contents: [{ type: 'ingredient', slug: 'acme', version: 1 }],
    });
    expect(reviewOwnerOperationsForPackUpdate(store, pack(null))).toEqual([]);

    store.delete('installed_pack', ['shared-pack']);
    expect(reviewOwnerOperationsForPackUpdate(store, pack(null))).toEqual([{
      ingredient_id: 'acme',
      operation_id: spec.operation_id,
      change: 'removed',
      owner_policy: { approval: 'ask' },
    }]);
  });

  it('adds the review to the marketplace manifest preview before update consent', async () => {
    const prior = composition([
      operation('deal.read', 'read', 'never', 'Read a deal.'),
      operation('deal.create', 'write', 'ask'),
    ]);
    const spec = opSpecs(prior).get('recued-core/acme.deal.read');
    if (spec === undefined) throw new Error('operation missing');
    store.put(OWNER_OPERATION_SCOPE, ['acme', spec.operation_id], {
      approval: 'ask',
      op_hash: operationSpecHash(spec),
    });
    const incoming = pack(composition([
      operation('deal.read', 'read', 'never', 'Read a deal with audit metadata.'),
      operation('deal.create', 'write', 'ask'),
    ]));
    const marketplaceFetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => incoming,
    }) as unknown as Response) as typeof globalThis.fetch;

    const resolved = await resolvePackBySlug(
      {
        recipeStore: {} as RecipeStore,
        contractStore: store,
        marketplaceFetch,
      },
      { slug: 'acme-pack' },
    );

    expect(resolved.manifest?.version).toBe(2);
    expect(resolved.owner_operation_review).toEqual([{
      ingredient_id: 'acme',
      operation_id: spec.operation_id,
      change: 'changed',
      owner_policy: { approval: 'ask' },
      incoming: { risk: 'read', approval: 'never' },
    }]);
  });

  it('compares the slug-keyed exact operation of a simple-form composition', () => {
    const prior = composition([operation('read', 'read', 'never')]);
    const ingredient = decomposeComposition[1](prior).ingredient;
    if (ingredient === undefined) throw new Error('simple ingredient missing');
    const priorSpec = {
      operation_id: ingredient.slug,
      risk_tier: ingredient.risk_tier,
    } as const;
    store.put(OWNER_OPERATION_SCOPE, ['acme', 'acme'], {
      approval: 'ask',
      op_hash: operationSpecHash(priorSpec),
    });

    const incoming = composition([operation('read', 'write', 'ask')]);
    expect(reviewOwnerOperationsForPackUpdate(store, pack(incoming))).toEqual([{
      ingredient_id: 'acme',
      operation_id: 'acme',
      change: 'changed',
      owner_policy: { approval: 'ask' },
      incoming: { risk: 'write' },
    }]);
  });
});
