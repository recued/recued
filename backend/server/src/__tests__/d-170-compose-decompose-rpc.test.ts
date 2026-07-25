/** D-170 #2 - `ingredient.compose.decompose` rpc surface.
 *
 *  Covers the draft-backed handler, contracts registry membership, and the
 *  existing ingredient draft handler slice so the method rides
 *  `ingredientDraftDeps` instead of a second dependency family. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SERVER_RPC_METHOD_SET,
  type CompositionDecomposeResult,
  type CompositionIngredient,
  type PackOperationRow,
} from '@recued/contracts';

import { handleCompositionDecompose } from '../ingredient-authoring/compose-decompose-rpc.js';
import { makeIngredientDraftHandlers } from '../ingredient-authoring/draft-preview-rpc.js';
import { createDraftStore, type DraftStore } from '../ingredient-authoring/draft-store.js';

const NOW = 1_700_000_000_000;

const readOp = (op: string, path: string): PackOperationRow => ({
  op,
  ingredient: 'hubspot',
  risk: 'read',
  approval: 'never',
  bind: { kind: 'rest', method: 'GET', path_template: path },
});

const writeOp = (op: string, path: string): PackOperationRow => ({
  op,
  ingredient: 'hubspot',
  risk: 'write',
  approval: 'ask',
  bind: { kind: 'rest', method: 'POST', path_template: path },
});

const composition = (): CompositionIngredient => ({
  schema_version: 1,
  slug: 'hubspot',
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug: 'hubspot',
      kind: 'http',
      http: { base: 'https://api.hubapi.com', connection: 'HubSpot' },
      entities: {
        Deal: {
          fields: [
            { field_path: 'id', type: 'string', maps_to: 'id', source_operation: 'deal.read' },
            { field_path: 'properties.dealname', type: 'string', maps_to: 'name', pii: 'content', source_operation: 'deal.read' },
            { field_path: 'properties.amount', type: 'number', maps_to: 'amount', optional: true, source_operation: 'deal.read' },
          ],
        },
      },
    },
  ],
  operations: [
    readOp('deal.read', '/crm/v3/objects/deals/{{deal_id}}'),
    writeOp('deal.create', '/crm/v3/objects/deals'),
  ],
});

const freshStore = (db: Database.Database): DraftStore =>
  createDraftStore(db, {
    now: () => NOW,
    newId: () => 'draft-1',
  });

const seedDraft = (store: DraftStore, body: unknown, draftId = 'draft-1'): string => {
  const saved = store.save({ draft_id: draftId, body });
  if ('error' in saved) throw new Error(`seed failed: ${saved.error}`);
  return saved.draft_id;
};

const expectOk = (
  result: CompositionDecomposeResult,
): Extract<CompositionDecomposeResult, { ok: true }> => {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result;
};

describe('ingredient.compose.decompose handler', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('is registered as an ingredient-prefixed server rpc method', () => {
    expect(SERVER_RPC_METHOD_SET.has('ingredient.compose.decompose')).toBe(true);
  });

  it('returns decomposed catalog artifacts, schemas, grants, and the review view', () => {
    db = new Database(':memory:');
    const store = freshStore(db);
    const draftId = seedDraft(store, composition());

    const result = expectOk(handleCompositionDecompose({ draftStore: store }, { draft_id: draftId }));

    expect(result.artifacts.ingredient).toBeUndefined();
    expect(result.artifacts.catalog).toMatchObject({
      slug: 'hubspot',
      operations: {
        'deal.read': { risk_tier: 'read', approval: 'never' },
        'deal.create': { risk_tier: 'write', approval: 'ask' },
      },
    });
    expect(result.artifacts.entity_schemas).toHaveLength(1);
    expect(result.artifacts.operation_groups).toHaveLength(2);
    expect(result.artifacts.default_grants).toEqual([
      { type: 'operation_group', ingredient_id: 'hubspot', group_id: 'hubspot.deal.read' },
    ]);
    expect(result.review).toMatchObject({
      valid: true,
      summary: {
        catalog_slug: 'hubspot',
        artifact_shape: 'multi',
        counts: {
          compositions: 1,
          operation_families: 2,
          entity_fields: 3,
          pii_fields: 1,
          compiled_outputs: 5,
        },
      },
      operation_families: [
        { key: 'deal.create', risk_tier: 'write', approval_mapping: 'ask' },
        { key: 'deal.read', risk_tier: 'read', approval_mapping: 'never' },
      ],
      field_privacy: [{ path: 'properties.dealname', privacy_kind: 'content' }],
    });
  });

  it('rejects invalid draft bodies through the validator', () => {
    db = new Database(':memory:');
    const store = freshStore(db);
    const draftId = seedDraft(store, {
      schema_version: 1,
      slug: 'broken',
      ingredients: [{ slug: 'broken', kind: 'http', http: { base: 'https://api.example.com' } }],
      operations: [],
    });

    const result = handleCompositionDecompose({ draftStore: store }, { draft_id: draftId });

    expect(result).toMatchObject({
      ok: false,
      code: 'validation_failed',
      review: { valid: false },
    });
    if (result.ok) throw new Error('expected validation_failed');
    expect(result.issues.map((issue) => issue.code)).toContain('decompose_failed');
  });

  it('returns typed errors for missing and unknown draft ids', () => {
    db = new Database(':memory:');
    const store = freshStore(db);

    expect(handleCompositionDecompose({ draftStore: store }, {} as never)).toMatchObject({
      ok: false,
      code: 'bad_request',
    });
    expect(handleCompositionDecompose({ draftStore: store }, { draft_id: 'missing' })).toMatchObject({
      ok: false,
      code: 'draft_not_found',
    });
  });

  it('is folded into the existing ingredient draft handler slice', async () => {
    db = new Database(':memory:');
    const store = freshStore(db);
    const draftId = seedDraft(store, composition());
    const slice = makeIngredientDraftHandlers({ draftStore: store });

    expect(slice?.methods).toContain('ingredient.compose.decompose');
    const result = await slice!.handlers['ingredient.compose.decompose']({ draft_id: draftId }, {} as never);
    expect(result).toMatchObject({
      ok: true,
      artifacts: { catalog: { slug: 'hubspot' } },
      review: { valid: true },
    });
  });

});
