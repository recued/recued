/** D-170 #4 - `ingredient.saveAsNew` local publish.
 *
 *  Covers the draft-backed save-as-new handler, contracts registry membership,
 *  local manifest persistence for both 1x1 and catalog decompositions, and the
 *  existing draft handler slice wiring. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SERVER_RPC_METHOD_SET,
  type CompositionIngredient,
  type IngredientSaveAsNewResult,
  type PackOperationRow,
} from '@recued/contracts';

import { createDraftStore, type DraftStore } from '../ingredient-authoring/draft-store.js';
import {
  createLocalManifestStore,
  type LocalManifestStore,
} from '../ingredient-authoring/local-manifest-store.js';
import { makeIngredientDraftHandlers } from '../ingredient-authoring/draft-preview-rpc.js';
import { handleIngredientSaveAsNew } from '../ingredient-authoring/save-as-new-rpc.js';

const NOW = 1_700_000_000_000;

const readOp = (op: string, path: string, ingredient: string): PackOperationRow => ({
  op,
  ingredient,
  risk: 'read',
  approval: 'never',
  bind: { kind: 'rest', method: 'GET', path_template: path },
});

const writeOp = (op: string, path: string, ingredient: string): PackOperationRow => ({
  op,
  ingredient,
  risk: 'write',
  approval: 'ask',
  bind: { kind: 'rest', method: 'POST', path_template: path },
});

const oneByOne = (slug = 'deal-read'): CompositionIngredient => ({
  schema_version: 1,
  slug,
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug,
      kind: 'http',
      http: { base: 'https://api.acme.example', connection: 'acme' },
      entities: {
        Deal: {
          fields: [
            { field_path: 'id', type: 'string', maps_to: 'id', source_operation: 'deal.read' },
          ],
        },
      },
    },
  ],
  operations: [readOp('deal.read', '/v3/deals/{{deal_id}}', slug)],
});

const wideComposition = (slug = 'acme'): CompositionIngredient => ({
  schema_version: 1,
  slug,
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug,
      kind: 'http',
      http: { base: 'https://api.acme.example', connection: 'acme' },
      entities: {
        Deal: {
          fields: [
            { field_path: 'id', type: 'string', maps_to: 'id', source_operation: 'deal.read' },
            { field_path: 'properties.name', type: 'string', maps_to: 'name', source_operation: 'deal.read' },
          ],
        },
      },
    },
  ],
  operations: [
    readOp('deal.read', '/v3/deals/{{deal_id}}', slug),
    writeOp('deal.create', '/v3/deals', slug),
  ],
});

const invalidComposition = (): unknown => ({
  schema_version: 1,
  slug: 'broken',
  catalog_kind: 'private_byo',
  ingredients: [{ slug: 'broken', kind: 'http', http: { base: 'https://api.acme.example', connection: 'acme' } }],
  operations: [],
});

interface Env {
  db: Database.Database;
  draftStore: DraftStore;
  localManifestStore: LocalManifestStore;
}

const makeEnv = (): Env => {
  const db = new Database(':memory:');
  return {
    db,
    draftStore: createDraftStore(db, { now: () => NOW, newId: () => 'draft-1' }),
    localManifestStore: createLocalManifestStore(db),
  };
};

const seedDraft = (store: DraftStore, body: unknown, draftId = 'draft-1'): string => {
  const saved = store.save({ draft_id: draftId, body });
  if ('error' in saved) throw new Error(`seed failed: ${saved.error}`);
  return saved.draft_id;
};

const expectOk = (
  result: IngredientSaveAsNewResult,
): Extract<IngredientSaveAsNewResult, { ok: true }> => {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result;
};

describe('ingredient.saveAsNew handler', () => {
  let env: Env | undefined;

  afterEach(() => {
    env?.db.close();
    env = undefined;
  });

  it('is registered as an ingredient-prefixed server rpc method', () => {
    expect(SERVER_RPC_METHOD_SET.has('ingredient.saveAsNew')).toBe(true);
  });

  it('persists a 1x1 draft as one valid local manifest', () => {
    env = makeEnv();
    const draftId = seedDraft(env.draftStore, oneByOne());

    const result = expectOk(handleIngredientSaveAsNew(env, { draft_id: draftId }));

    expect(result.saved).toEqual({
      ingredient_id: 'deal-read',
      version: 1,
      kind: 'ingredient',
      entity_schema_count: 0,
      operation_group_count: 0,
      default_grant_count: 0,
    });
    expect(result.manifest).toMatchObject({
      slug: 'deal-read',
      input: { connection_kind: 'api', method: 'GET', path: '/v3/deals/{{deal_id}}' },
      output: { id: 'id' },
    });
    expect(env.localManifestStore.getManifest('deal-read')).toMatchObject({
      slug: 'deal-read',
      risk_tier: 'read',
    });
    expect(env.localManifestStore.getEntitySchemas('deal-read')).toEqual([]);
  });

  it('persists a wide draft as a catalog manifest with entity schemas', () => {
    env = makeEnv();
    const draftId = seedDraft(env.draftStore, wideComposition());

    const result = expectOk(handleIngredientSaveAsNew(env, { draft_id: draftId }));

    expect(result.saved).toEqual({
      ingredient_id: 'acme',
      version: 1,
      kind: 'catalog',
      entity_schema_count: 1,
      operation_group_count: 2,
      default_grant_count: 1,
    });
    expect(env.localManifestStore.getManifest('acme')).toMatchObject({
      slug: 'acme',
      operations: {
        'deal.read': { risk_tier: 'read', approval: 'never' },
        'deal.create': { risk_tier: 'write', approval: 'ask' },
      },
    });
    expect(env.localManifestStore.getEntitySchemas('acme')).toHaveLength(1);
    expect(env.localManifestStore.getEntitySchemas('acme')[0]).toMatchObject({
      ingredient_id: 'acme',
      entity_id: 'deal',
    });
  });

  it('reuses the decompose validation failure path and writes nothing', () => {
    env = makeEnv();
    const draftId = seedDraft(env.draftStore, invalidComposition());

    const result = handleIngredientSaveAsNew(env, { draft_id: draftId });

    expect(result).toMatchObject({
      ok: false,
      code: 'validation_failed',
      review: { valid: false },
    });
    if (result.ok) throw new Error('expected validation_failed');
    expect(result.issues.map((issue) => issue.code)).toContain('decompose_failed');
    expect(env.localManifestStore.slugs()).toEqual([]);
  });

  it('returns typed errors for bad args, missing drafts, and local slug conflicts', () => {
    env = makeEnv();
    const draftId = seedDraft(env.draftStore, oneByOne());

    expect(handleIngredientSaveAsNew(env, {} as never)).toMatchObject({
      ok: false,
      code: 'bad_request',
    });
    expect(handleIngredientSaveAsNew(env, { draft_id: 'missing' })).toMatchObject({
      ok: false,
      code: 'draft_not_found',
    });

    expect(handleIngredientSaveAsNew(env, { draft_id: draftId }).ok).toBe(true);
    expect(handleIngredientSaveAsNew(env, { draft_id: draftId })).toMatchObject({
      ok: false,
      code: 'slug_conflict',
    });
  });

  it('rides the existing ingredient draft handler slice when localManifestStore is wired', async () => {
    env = makeEnv();
    const draftId = seedDraft(env.draftStore, wideComposition());
    const slice = makeIngredientDraftHandlers({
      draftStore: env.draftStore,
      localManifestStore: env.localManifestStore,
    })!;

    expect(slice.methods).toContain('ingredient.saveAsNew');
    const handler = (slice.handlers as Record<string, (args: unknown, ctx: unknown) => Promise<unknown>>)[
      'ingredient.saveAsNew'
    ];
    const result = expectOk(await handler({ draft_id: draftId }, {}) as IngredientSaveAsNewResult);
    expect(result.saved).toMatchObject({ ingredient_id: 'acme', kind: 'catalog' });

    const withoutStore = makeIngredientDraftHandlers({ draftStore: env.draftStore })!;
    expect(withoutStore.methods).not.toContain('ingredient.saveAsNew');
  });
});
