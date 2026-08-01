import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  EntitySchemaIngredientInput,
  IngredientManifest,
  RecipeDefinition,
  RecordsExecutionBinding,
  RecordsSchemaSnapshot,
} from '@recued/contracts';
import { canonicalHash, recordsCatalogSlug } from '@recued/ingredient-authoring';

import { createLocalManifestStore } from '../../ingredient-authoring/local-manifest-store.js';
import { recordPackInventory } from '../../pack-inventory.js';
import { createRecipeStore } from '../../recipe-store.js';
import { createContractGrantStore } from '../../storage/contract-grant-store.js';
import { createContractStore } from '../../storage/contract-store.js';
import {
  assertRecordsRestoreCoherence,
  createRecordsStore,
  RECORDS_TABLES,
} from '../store.js';

const owner = { publisher: 'publisher-a', pack_slug: 'restore-pack' } as const;
const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    item: {
      kind: 'item',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'title', slot: 's1', kind: 'string', required: true },
      ],
    },
  },
};
const binding: RecordsExecutionBinding = {
  kind: 'core.records',
  action: 'create',
  entity: 'item',
  owner,
  pack_version: 1,
  storage_schema_hash: 'a'.repeat(64),
  declaration_hash: 'b'.repeat(64),
  operation_digest: 'c'.repeat(64),
};

const installCoherentCheckpoint = async (db: Database.Database) => {
  const catalogId = await recordsCatalogSlug(owner);
  const manifest: IngredientManifest = {
    slug: catalogId,
    name: 'Restore Pack Records',
    description: 'Restore-coherence fixture',
    author: owner.publisher,
    kind: 'storage',
    version: 1,
    category: 'action',
    risk_tier: 'write',
    input: { operation: null, args: null },
    output: { result: 'result' },
    operations: {
      create: {
        operation_id: `${owner.publisher}.${owner.pack_slug}.item.create`,
        risk_tier: 'write',
        approval: 'ask',
        groups: ['item.write'],
      },
    },
    operation_groups: {
      'item.write': {
        group_id: 'item.write',
        operations: ['create'],
        risk_floor: 'write',
      },
    },
    surfaces: { records: { executes: { create: binding }, schema } },
  };
  const recipe: RecipeDefinition = {
    recipe_id: 'restore-pack-create-item',
    version: 1,
    ttl: 60,
    metadata: {
      name: 'Create restore item',
      description: 'Restore fixture business recipe',
      author: owner.publisher,
      supported_platforms: ['server'],
      recipe_bundle: `${owner.publisher}/${owner.pack_slug}`,
    },
    variables: {},
    prefetch_steps: [],
    steps: [{
      id: 'create',
      ingredient: catalogId,
      input: { operation: 'create', args: { values: { title: 'kept' } } },
    }],
    output: { sidebar: [] },
  };
  const entitySchemas: EntitySchemaIngredientInput[] = [];
  const artifactDigest = await canonicalHash({
    owner,
    version: 1,
    catalog: manifest,
    schemas: entitySchemas,
    recipes: { [recipe.recipe_id]: await canonicalHash(recipe) },
    migration_plans: [],
  });
  const store = createRecordsStore(db, { now: () => 1_000, id: () => 'item-1' });
  createLocalManifestStore(db).put({ manifest, entity_schemas: entitySchemas });
  createRecipeStore('/nonexistent', db).save(
    recipe,
    owner.publisher,
    'pair-sync',
    1_000,
    catalogId,
  );
  const contractStore = createContractStore(db);
  createContractGrantStore(contractStore).grantPackGroup(
    catalogId,
    catalogId,
    catalogId,
    'item.write',
  );
  recordPackInventory(contractStore, {
    pack_slug: catalogId,
    publisher: owner.publisher,
    pack_version: 1,
    contents: [],
    local_catalogs: [{ ingredient_id: catalogId, version: 1, catalog_kind: 'private_byo' }],
    installed_at: 1_000,
  });
  store.installNamespace({
    owner,
    version: 1,
    storage_schema_hash: binding.storage_schema_hash,
    declaration_hash: binding.declaration_hash,
    artifact_digest: artifactDigest,
    schema,
    bindings: { create: binding },
  });
  return { store, catalogId, contractStore };
};

describe('D-221 staged restore coherence', () => {
  const dbs: Database.Database[] = [];
  const database = (): Database.Database => {
    const db = new Database(':memory:');
    dbs.push(db);
    return db;
  };
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('accepts a pre-Records archive and a complete generation-pinned checkpoint', async () => {
    expect(() => assertRecordsRestoreCoherence(database())).not.toThrow();

    const db = database();
    const { store } = await installCoherentCheckpoint(db);
    store.execute({
      binding,
      principal: 'owner',
      args: { id: 'item-1', values: { title: 'kept' } },
    });
    expect(() => assertRecordsRestoreCoherence(db)).not.toThrow();
  });

  it('refuses runnable rows without exact catalog, inventory, recipe, and grant truth', async () => {
    const missingCatalog = database();
    await installCoherentCheckpoint(missingCatalog);
    missingCatalog.exec('DELETE FROM local_manifest');
    expect(() => assertRecordsRestoreCoherence(missingCatalog)).toThrow(/catalog snapshot/);

    const changedRecipe = database();
    await installCoherentCheckpoint(changedRecipe);
    changedRecipe.exec(`UPDATE recipes SET recipe_json = replace(recipe_json, 'kept', 'changed')`);
    expect(() => assertRecordsRestoreCoherence(changedRecipe)).toThrow(/recipe .*divergent provenance|pinned artifact bodies/);

    const missingInventory = database();
    await installCoherentCheckpoint(missingInventory);
    missingInventory.exec(`DELETE FROM contract_store WHERE scope='installed_pack'`);
    expect(() => assertRecordsRestoreCoherence(missingInventory)).toThrow(/inventory/);

    const unknownGrant = database();
    const fixture = await installCoherentCheckpoint(unknownGrant);
    createContractGrantStore(fixture.contractStore).grantPackGroup(
      fixture.catalogId,
      fixture.catalogId,
      fixture.catalogId,
      'item.undeclared',
    );
    expect(() => assertRecordsRestoreCoherence(unknownGrant)).toThrow(/grant truth/);
  });

  it('refuses partial tables, orphaned rows, and accounting drift before swap', () => {
    const partial = database();
    createRecordsStore(partial);
    partial.pragma('foreign_keys = OFF');
    partial.exec(`DROP TABLE ${RECORDS_TABLES.migration_steps}`);
    expect(() => assertRecordsRestoreCoherence(partial)).toThrow(/incomplete Records checkpoint/);

    const orphan = database();
    const orphanStore = createRecordsStore(orphan, { now: () => 1_000 });
    orphanStore.installNamespace({
      owner,
      version: 1,
      storage_schema_hash: binding.storage_schema_hash,
      declaration_hash: binding.declaration_hash,
      artifact_digest: 'artifact-1',
      schema,
      bindings: { create: binding },
    });
    orphanStore.execute({ binding, principal: 'owner', args: { id: 'item-1', values: { title: 'kept' } } });
    orphan.exec(`DELETE FROM ${RECORDS_TABLES.namespaces}`);
    expect(() => assertRecordsRestoreCoherence(orphan)).toThrow(/namespace orphan/);

    const drift = database();
    const driftStore = createRecordsStore(drift, { now: () => 1_000 });
    driftStore.installNamespace({
      owner,
      version: 1,
      storage_schema_hash: binding.storage_schema_hash,
      declaration_hash: binding.declaration_hash,
      artifact_digest: 'artifact-1',
      schema,
      bindings: { create: binding },
    });
    drift.exec(`UPDATE ${RECORDS_TABLES.namespaces} SET row_count=1`);
    expect(() => assertRecordsRestoreCoherence(drift)).toThrow(/accounting/);
  });
});
