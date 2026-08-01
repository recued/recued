import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type {
  BulkPackManifest,
  IngredientManifest,
  RecipeDefinition,
  RecordsExecutionBinding,
  RecordsSchemaSnapshot,
} from '@recued/contracts';
import {
  canonicalHash,
  recordsCatalogSlug,
  type CompositionIngredient,
} from '@recued/ingredient-authoring';

import { createLocalManifestStore } from '../../ingredient-authoring/local-manifest-store.js';
import { createRecipeStore } from '../../recipe-store.js';
import { handlePacksUninstall } from '../../pack-uninstall-handler.js';
import { getInstalledPack, recordPackInventory } from '../../pack-inventory.js';
import { createContractStore } from '../../storage/contract-store.js';
import {
  installRecordsPackAtomic,
  uninstallRecordsPackAtomic,
  recordsRuntimeCanaryIssue,
  RecordsPackInstallError,
} from '../install-coordinator.js';
import {
  recordsNamespaceReviewDigest,
  recordsOwnerPolicyDigest,
  recordsRoutePlanDigest,
} from '../review-fence.js';
import { createRecordsStore } from '../store.js';

const composition = (slot = 's1'): CompositionIngredient => ({
  schema_version: 1,
  slug: 'job-status-board',
  ingredients: [{
    slug: 'job-status-board-records',
    kind: 'storage',
    entities: {
      job: {
        fields: [
          { maps_to: 'id', field_path: 'pk', type: 'string', source_operation: 'job.get', pii: 'external_id' },
          { maps_to: 'title', field_path: slot, type: 'string', source_operation: 'job.get', pii: 'content' },
        ],
      },
    },
  }],
  operations: [
    {
      op: 'job.create', ingredient: 'job-status-board-records', risk: 'write', approval: 'never',
      args: [{ key: 'id', type: 'string' }, { key: 'values', type: 'object', required: true }],
      bind: { kind: 'core.records', action: 'create', entity: 'job' },
    },
    {
      op: 'job.get', ingredient: 'job-status-board-records', risk: 'read', approval: 'never',
      args: [{ key: 'id', type: 'string', required: true, affects_target: true }],
      bind: { kind: 'core.records', action: 'get', entity: 'job' },
    },
  ],
} as unknown as CompositionIngredient);

/** The same composition with a natural_key on `job.create`. A keyed create
 *  derives its own id, so it must not declare an `id` arg. Crucially the SLOT is
 *  unchanged, so `storage_schema_hash` is IDENTICAL across the bump — which is
 *  what makes the schema-unchanged sweep look eligible for a rekey. */
const keyedComposition = (slot = 's1'): CompositionIngredient => {
  const value = composition(slot) as unknown as {
    operations: Array<{ op: string; args: unknown; bind: Record<string, unknown> }>;
  };
  const create = value.operations.find((row) => row.op === 'job.create')!;
  create.args = [{ key: 'values', type: 'object', required: true }];
  create.bind.natural_key = ['title'];
  return value as unknown as CompositionIngredient;
};

const manifest = (publisher: string, version = 1): BulkPackManifest => ({
  manifest_version: 2,
  slug: 'job-status-board',
  publisher,
  name: 'Job Status Board',
  description: 'A local durable board backed by the core Records substrate.',
  version,
  recipes: [],
  requires: ['install_bulk_pack'],
  tags: ['records', 'jobs', 'board'],
  contents: [],
  pack_kind: 'app_pack',
  service_kind: 'storage',
} as unknown as BulkPackManifest);

const businessRecipe = (
  id: string,
  publisher: string,
  catalog: string,
  version = 1,
): RecipeDefinition => ({
  recipe_id: id,
  version,
  ttl: 0,
  chat_exposed: false,
  metadata: {
    name: 'Create a job',
    description: 'Creates one local job through the installed Records pack operation.',
    author: publisher,
    supported_platforms: [],
    tags: ['records', 'job', 'test'],
    recipe_bundle: `${publisher}/job-status-board`,
  },
  variables: {},
  prefetch_steps: [],
  steps: [{
    id: 'create',
    ingredient: catalog,
    input: { operation: 'job.create', args: { id: 'example', values: { title: 'Example' } } },
  }],
  output: { render: [] },
} as unknown as RecipeDefinition);

const canary = (publisher: string): unknown => ({
  recipe_id: 'job-status-board-require-records-runtime',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Records runtime compatibility canary',
    description: 'Installer-only compatibility probe for the Records substrate.',
    author: publisher,
    supported_platforms: [],
    recipe_bundle: `${publisher}/job-status-board`,
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'require-runtime', op: 'core.records.require-runtime', args: {} }],
  output: { render: [] },
  chat_exposed: false,
});

const harness = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const manifests = new Map<string, IngredientManifest>();
  return {
    db,
    recipeStore: createRecipeStore('/definitely-not-a-d221-recipe-dir', db),
    recordsStore: createRecordsStore(db, { now: () => 1_000, id: () => 'row-1' }),
    localManifestStore: createLocalManifestStore(db),
    contractStore: createContractStore(db, { now: () => 1_000 }),
    now: () => 1_000,
    registry: {
      get: (slug: string) => manifests.get(slug) ?? null,
      register: (value: IngredientManifest) => { manifests.set(value.slug, value); },
      unregister: (slug: string) => manifests.delete(slug),
    },
  };
};

describe('D-221 Records atomic pack install coordinator', () => {
  it('accepts only the exact inert compatibility canary', () => {
    const body = canary('publisher-a');
    const ref = { slug: 'job-status-board-require-records-runtime', version: 1, visible: false };
    expect(recordsRuntimeCanaryIssue(ref, body, 'publisher-a/job-status-board')).toBeNull();
    expect(recordsRuntimeCanaryIssue(ref, {
      ...(body as Record<string, unknown>),
      auto_run: { interval_ms: 1_000 },
    }, 'publisher-a/job-status-board')).toContain('closed inert recipe shape');
    const dynamic = structuredClone(body) as { steps: Array<{ args: Record<string, unknown> }> };
    dynamic.steps[0]!.args.value = '{{config.elevate}}';
    expect(recordsRuntimeCanaryIssue(ref, dynamic, 'publisher-a/job-status-board')).toContain('exact literal');
    let getterCalls = 0;
    const accessor = { ...(body as Record<string, unknown>) };
    Object.defineProperty(accessor, 'steps', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return (body as { steps: unknown[] }).steps;
      },
    });
    expect(recordsRuntimeCanaryIssue(ref, accessor, 'publisher-a/job-status-board')).toContain('accessor-backed');
    expect(getterCalls).toBe(0);
  });

  it('keeps same-slug publishers in distinct catalog, inventory, recipe and row namespaces', async () => {
    const h = harness();
    const catalogA = await recordsCatalogSlug({ publisher: 'publisher-a', pack_slug: 'job-status-board' });
    const catalogB = await recordsCatalogSlug({ publisher: 'publisher-b', pack_slug: 'job-status-board' });
    const install = async (publisher: string, catalog: string, recipeId: string) =>
      installRecordsPackAtomic(h, {
        manifest: manifest(publisher),
        composition: composition(),
        verified_publisher: publisher,
        recipes: [{ recipe: businessRecipe(recipeId, publisher, catalog), publisher_id: publisher, version: 1 }],
        install_scope: { access: 'read', scope: 'owner' },
      });

    await install('publisher-a', catalogA, 'create-job-a');
    await install('publisher-b', catalogB, 'create-job-b');
    expect(catalogA).not.toBe(catalogB);
    expect(h.localManifestStore.getManifest(catalogA)?.author).toBe('publisher-a');
    expect(h.localManifestStore.getManifest(catalogB)?.author).toBe('publisher-b');
    expect(h.contractStore.get('installed_pack', [catalogA])).not.toBeNull();
    expect(h.contractStore.get('installed_pack', [catalogB])).not.toBeNull();
    expect(h.recipeStore.getStored('create-job-a')?.pack_slug).toBe(catalogA);
    expect(h.recipeStore.getStored('create-job-b')?.pack_slug).toBe(catalogB);

    const manifestA = h.localManifestStore.getManifest(catalogA)!;
    const createA = manifestA.surfaces!.records!.executes['job.create'] as RecordsExecutionBinding;
    const getB = h.localManifestStore.getManifest(catalogB)!.surfaces!.records!.executes['job.get'] as RecordsExecutionBinding;
    h.recordsStore.execute({ binding: createA, principal: 'owner', args: { id: 'job-1', values: { title: 'A' } } });
    expect(h.recordsStore.execute({ binding: getB, principal: 'owner', args: { id: 'job-1' } }))
      .toEqual({ record: null });
    h.db.close();
  });

  it('preflights global recipe collisions before any second namespace is written', async () => {
    const h = harness();
    const catalogA = await recordsCatalogSlug({ publisher: 'publisher-a', pack_slug: 'job-status-board' });
    const catalogB = await recordsCatalogSlug({ publisher: 'publisher-b', pack_slug: 'job-status-board' });
    await installRecordsPackAtomic(h, {
      manifest: manifest('publisher-a'),
      composition: composition(),
      verified_publisher: 'publisher-a',
      recipes: [{ recipe: businessRecipe('global-job-action', 'publisher-a', catalogA), publisher_id: 'publisher-a', version: 1 }],
    });
    await expect(installRecordsPackAtomic(h, {
      manifest: manifest('publisher-b'),
      composition: composition(),
      verified_publisher: 'publisher-b',
      recipes: [{ recipe: businessRecipe('global-job-action', 'publisher-b', catalogB), publisher_id: 'publisher-b', version: 1 }],
    })).rejects.toMatchObject({ code: 'validator_rejected' } satisfies Partial<RecordsPackInstallError>);
    expect(h.recordsStore.getNamespace({ publisher: 'publisher-b', pack_slug: 'job-status-board' })).toBeNull();
    expect(h.localManifestStore.getManifest(catalogB)).toBeNull();
    expect(h.contractStore.get('installed_pack', [catalogB])).toBeNull();
    h.db.close();
  });

  it('adopts only a publisher-verified legacy public-pack recipe/inventory owner', async () => {
    const h = harness();
    const publisher = 'publisher-a';
    const catalog = await recordsCatalogSlug({ publisher, pack_slug: 'job-status-board' });
    h.recipeStore.save(
      businessRecipe('create-job', publisher, catalog, 1),
      publisher,
      'pair-sync',
      900,
      'job-status-board',
    );
    recordPackInventory(h.contractStore, {
      pack_slug: 'job-status-board',
      publisher,
      pack_version: 1,
      contents: [],
      installed_at: 900,
    });

    await installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 2),
      composition: composition(),
      verified_publisher: publisher,
      recipes: [{
        recipe: businessRecipe('create-job', publisher, catalog, 2),
        publisher_id: publisher,
        version: 2,
      }],
    });
    expect(h.recipeStore.getStored('create-job')).toMatchObject({
      pack_slug: catalog,
      version: 2,
    });
    expect(getInstalledPack(h.contractStore, 'job-status-board')).toBeNull();
    expect(getInstalledPack(h.contractStore, catalog)).toMatchObject({
      publisher,
      version: 2,
    });
    h.db.close();
  });

  it('rolls recipe/catalog/inventory writes back when readiness promotion refuses', async () => {
    const h = harness();
    const publisher = 'publisher-a';
    const catalog = await recordsCatalogSlug({ publisher, pack_slug: 'job-status-board' });
    await installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 1),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 1), publisher_id: publisher, version: 1 }],
    });
    const create = h.localManifestStore.getManifest(catalog)!.surfaces!.records!.executes['job.create'] as RecordsExecutionBinding;
    h.recordsStore.execute({ binding: create, principal: 'owner', args: { id: 'job-1', values: { title: 'kept' } } });

    await expect(installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 2),
      composition: composition('s2'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 2), publisher_id: publisher, version: 2 }],
    })).rejects.toMatchObject({ code: 'validator_rejected' } satisfies Partial<RecordsPackInstallError>);
    expect(h.recipeStore.getStored('create-job')?.version).toBe(1);
    expect(h.localManifestStore.getManifest(catalog)?.version).toBe(1);
    expect(h.localManifestStore.getManifest(catalog, 2)).toBeNull();
    expect(h.recordsStore.getNamespace({ publisher, pack_slug: 'job-status-board' })?.state)
      .toMatchObject({ state: 'ready', version: 1 });
    expect((h.contractStore.get('installed_pack', [catalog])?.value as { version: string }).version).toBe('1');
    h.db.close();
  });

  it('executes mapping and quota preflight in rollback before acquiring the migration lock', async () => {
    const h = harness();
    const publisher = 'publisher-a';
    const owner = { publisher, pack_slug: 'job-status-board' };
    const catalog = await recordsCatalogSlug(owner);
    await installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 1),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 1), publisher_id: publisher, version: 1 }],
    });
    const create = h.localManifestStore.getManifest(catalog)!.surfaces!.records!.executes['job.create'] as RecordsExecutionBinding;
    h.recordsStore.execute({ binding: create, principal: 'owner', args: { id: 'job-1', values: { title: 'kept' } } });
    const badArgs = {
      kind: 'job',
      from_v: 1,
      new_v: 2,
      field_mapping: [{ op: 'move' as const, from: 'missing', to: 'title' }],
    };
    const finalArgs = { from_v: 1, new_v: 2 };
    await expect(installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 2),
      composition: composition('s2'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 2), publisher_id: publisher, version: 2 }],
      migration_plans: [{
        recipe_id: 'bad-migration',
        recipe_version: 1,
        recipe_digest: 'e'.repeat(64),
        from_v: 1,
        new_v: 2,
        steps: [{
          id: 'bad-move',
          op: 'core.records.migrate',
          args: badArgs,
          args_hash: await canonicalHash(badArgs),
        }],
        finalizer: {
          id: 'finalize',
          op: 'core.records.finalize-migration',
          args: finalArgs,
          args_hash: await canonicalHash(finalArgs),
        },
      }],
    })).rejects.toThrow(/preflight refused.*source 'missing'/);
    expect(h.recordsStore.getNamespace(owner)?.state).toMatchObject({ state: 'ready', version: 1 });
    expect(h.recordsStore.getMigration(owner)).toBeNull();
    expect(h.recordsStore.ownerGet(owner, 'job', 'job-1')).toMatchObject({ title: 'kept' });
    h.db.close();
  });

  it('runs a classified hidden migration through durable receipts before atomically promoting v2 code', async () => {
    const h = harness();
    const publisher = 'publisher-a';
    const owner = { publisher, pack_slug: 'job-status-board' };
    const catalog = await recordsCatalogSlug(owner);
    await installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 1),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 1), publisher_id: publisher, version: 1 }],
    });
    const create = h.localManifestStore.getManifest(catalog)!.surfaces!.records!.executes['job.create'] as RecordsExecutionBinding;
    h.recordsStore.execute({ binding: create, principal: 'owner', args: { id: 'job-1', values: { title: 'kept' } } });

    const migrateArgs = {
      kind: 'job',
      from_v: 1,
      new_v: 2,
      field_mapping: [{ op: 'move' as const, from: 'title', to: 'title' }],
    };
    const finalizeArgs = { from_v: 1, new_v: 2 };
    const recipeDigest = 'd'.repeat(64);
    await installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 2),
      composition: composition('s2'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 2), publisher_id: publisher, version: 2 }],
      migration_plans: [{
        recipe_id: 'migrate-v1-v2',
        recipe_version: 1,
        recipe_digest: recipeDigest,
        from_v: 1,
        new_v: 2,
        steps: [{
          id: 'move-title-slot',
          op: 'core.records.migrate',
          args: migrateArgs,
          args_hash: await canonicalHash(migrateArgs),
        }],
        finalizer: {
          id: 'finalize-v2',
          op: 'core.records.finalize-migration',
          args: finalizeArgs,
          args_hash: await canonicalHash(finalizeArgs),
        },
      }],
    });

    const namespace = h.recordsStore.getNamespace(owner)!;
    expect(namespace.state).toMatchObject({ state: 'ready', version: 2 });
    expect(namespace.quota).toMatchObject({ row_count: 1, data_generation: 2, outbox_count: 0 });
    const v2Catalog = h.localManifestStore.getManifest(catalog)!;
    const get = v2Catalog.surfaces!.records!.executes['job.get'] as RecordsExecutionBinding;
    expect(h.recordsStore.execute({ binding: get, principal: 'owner', args: { id: 'job-1' } }))
      .toMatchObject({ record: { id: 'job-1', title: 'kept', _record: { version: 2, revision: 1 } } });
    expect(h.recipeStore.getStored('create-job')?.version).toBe(2);
    expect(h.recordsStore.getMigration(owner)).toMatchObject({ status: 'complete', target_version: 2 });
    h.db.close();
  });

  it('refuses an upgrade before mutation when a foreign pack still holds the namespace lease', async () => {
    const h = harness();
    const publisher = 'publisher-a';
    const owner = { publisher, pack_slug: 'job-status-board' };
    const catalog = await recordsCatalogSlug(owner);
    await installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 1),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 1), publisher_id: publisher, version: 1 }],
    });
    const v1Catalog = h.localManifestStore.getManifest(catalog)!;
    const create = v1Catalog.surfaces!.records!.executes['job.create'] as RecordsExecutionBinding;
    const get = v1Catalog.surfaces!.records!.executes['job.get'] as RecordsExecutionBinding;
    h.recordsStore.execute({ binding: create, principal: 'owner', args: { id: 'job-1', values: { title: 'kept' } } });
    const foreignLease = h.recordsStore.acquireExecutionLease({
      lease_id: 'pack-b-run',
      recipe_id: 'pack-b-read-then-send',
      caller_pack: 'publisher-b/automation',
      targets: [{ binding: get }],
    });

    await expect(installRecordsPackAtomic({ ...h, quiescence_timeout_ms: 0 }, {
      manifest: manifest(publisher, 2),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 2), publisher_id: publisher, version: 2 }],
    })).rejects.toThrow(/publisher-b\/automation/);
    expect(h.recordsStore.getNamespace(owner)?.state).toMatchObject({ state: 'ready', version: 1 });
    expect(h.recipeStore.getStored('create-job')?.version).toBe(1);

    foreignLease.release();
    await installRecordsPackAtomic({ ...h, quiescence_timeout_ms: 10 }, {
      manifest: manifest(publisher, 2),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 2), publisher_id: publisher, version: 2 }],
    });
    expect(h.recordsStore.getNamespace(owner)?.state).toMatchObject({ state: 'ready', version: 2 });
    h.db.close();
  });

  it('also drains an empty namespace before replacing its activation', async () => {
    const h = harness();
    const publisher = 'publisher-a';
    const owner = { publisher, pack_slug: 'job-status-board' };
    const catalog = await recordsCatalogSlug(owner);
    await installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 1),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 1), publisher_id: publisher, version: 1 }],
    });
    const get = h.localManifestStore.getManifest(catalog)!
      .surfaces!.records!.executes['job.get'] as RecordsExecutionBinding;
    const lease = h.recordsStore.acquireExecutionLease({
      lease_id: 'empty-pack-b-run',
      recipe_id: 'pack-b-read-then-send',
      caller_pack: 'publisher-b/automation',
      targets: [{ binding: get }],
    });

    await expect(installRecordsPackAtomic({ ...h, quiescence_timeout_ms: 0 }, {
      manifest: manifest(publisher, 2),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 2), publisher_id: publisher, version: 2 }],
    })).rejects.toThrow(/publisher-b\/automation/);
    expect(h.recordsStore.getNamespace(owner)?.state).toMatchObject({ state: 'ready', version: 1 });
    expect(h.recordsStore.getNamespace(owner)?.quota.row_count).toBe(0);
    expect(h.recipeStore.getStored('create-job')?.version).toBe(1);

    lease.release();
    await installRecordsPackAtomic({ ...h, quiescence_timeout_ms: 10 }, {
      manifest: manifest(publisher, 2),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 2), publisher_id: publisher, version: 2 }],
    });
    expect(h.recordsStore.getNamespace(owner)?.state).toMatchObject({ state: 'ready', version: 2 });
    h.db.close();
  });

  it('binds update approval to the exact recomputed target artifact body', async () => {
    const h = harness();
    const publisher = 'publisher-a';
    const owner = { publisher, pack_slug: 'job-status-board' };
    const catalog = await recordsCatalogSlug(owner);
    await installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 1),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{
        recipe: businessRecipe('create-job', publisher, catalog, 1),
        publisher_id: publisher,
        version: 1,
      }],
    });
    const current = h.recordsStore.getNamespace(owner)!;
    const ownerPolicy = {
      retention: h.recordsStore.getRetention(owner),
      global_quota: h.recordsStore.getGlobalQuota(),
    };
    const reviewedButNotInstalledArtifact = 'f'.repeat(64);
    const routePlanDigest = recordsRoutePlanDigest({
      owner,
      current_version: 1,
      target_version: 2,
      current_artifact_digest: current.artifact_digest,
      target_artifact_digest: reviewedButNotInstalledArtifact,
      target_storage_schema_hash: current.state.state === 'ready'
        ? current.state.storage_schema_hash
        : '',
      migration_plans: [],
      migration_artifacts: [],
      pending_event_disposition: 'drain_or_explicit_retire',
    });

    await expect(installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 2),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{
        recipe: businessRecipe('create-job', publisher, catalog, 2),
        publisher_id: publisher,
        version: 2,
      }],
      review_source_recipes: [{
        recipe: businessRecipe('create-job', publisher, catalog, 2),
        publisher_id: publisher,
        version: 2,
      }],
      review_fence: {
        owner,
        current_snapshot_digest: recordsNamespaceReviewDigest(current),
        owner_policy_digest: recordsOwnerPolicyDigest(ownerPolicy),
        target_version: 2,
        target_artifact_digest: reviewedButNotInstalledArtifact,
        route_plan_digest: routePlanDigest,
        pending_event_disposition: 'drain_or_explicit_retire',
      },
    })).rejects.toThrow(/review target is stale/);
    expect(h.recordsStore.getNamespace(owner)?.state).toMatchObject({ state: 'ready', version: 1 });
    expect(h.recipeStore.getStored('create-job')?.version).toBe(1);
    h.db.close();
  });

  it('pins an intermediate artifact and runs a skipped v1->v2->v3 route under one outer lock', async () => {
    const h = harness();
    const publisher = 'publisher-a';
    const owner = { publisher, pack_slug: 'job-status-board' };
    const catalog = await recordsCatalogSlug(owner);
    await installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 1),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 1), publisher_id: publisher, version: 1 }],
    });
    const create = h.localManifestStore.getManifest(catalog)!.surfaces!.records!.executes['job.create'] as RecordsExecutionBinding;
    h.recordsStore.execute({ binding: create, principal: 'owner', args: { id: 'job-1', values: { title: 'kept' } } });

    const schemaV2: RecordsSchemaSnapshot = {
      decimal_scale: 4,
      entities: {
        job: {
          kind: 'job',
          fields: [
            { key: 'id', slot: 'pk', kind: 'id', required: true, privacy: 'external_id' },
            { key: 'title', slot: 's2', kind: 'string', required: true, privacy: 'content' },
          ],
        },
      },
    };
    const edge = async (from_v: number, new_v: number, digestChar: string) => {
      const args = {
        kind: 'job', from_v, new_v,
        field_mapping: [{ op: 'move' as const, from: 'title', to: 'title' }],
      };
      const final = { from_v, new_v };
      return {
        recipe_id: `migrate-${from_v}-${new_v}`,
        recipe_version: 1,
        recipe_digest: digestChar.repeat(64),
        from_v,
        new_v,
        steps: [{ id: `move-${from_v}-${new_v}`, op: 'core.records.migrate' as const, args, args_hash: await canonicalHash(args) }],
        finalizer: { id: `finalize-${from_v}-${new_v}`, op: 'core.records.finalize-migration' as const, args: final, args_hash: await canonicalHash(final) },
      };
    };
    const v1v2 = await edge(1, 2, '1');
    const v2v3 = await edge(2, 3, '2');
    await installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 3),
      composition: composition('s3'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 3), publisher_id: publisher, version: 3 }],
      migration_plans: [v2v3],
      migration_artifacts: [{
        owner,
        version: 2,
        artifact_digest: 'artifact-v2',
        storage_schema_hash: '2'.repeat(64),
        declaration_hash: '3'.repeat(64),
        schema: schemaV2,
        migration_plans: [v1v2],
      }],
    });
    expect(h.recordsStore.getNamespace(owner)?.state).toMatchObject({ state: 'ready', version: 3 });
    expect(h.recordsStore.ownerGet(owner, 'job', 'job-1')).toMatchObject({
      title: 'kept',
      _record: { version: 3, revision: 2 },
    });
    expect(h.recordsStore.getMigration(owner)).toMatchObject({ status: 'complete', target_version: 3 });
    h.db.close();
  });

  it('accepts downgrade authority only from the installed source artifact', async () => {
    const makePlan = async (from_v: number, new_v: number, digestChar: string) => {
      const args = {
        kind: 'job', from_v, new_v,
        field_mapping: [{ op: 'move' as const, from: 'title', to: 'title' }],
      };
      const final = { from_v, new_v };
      return {
        recipe_id: `migrate-${from_v}-${new_v}`,
        recipe_version: 1,
        recipe_digest: digestChar.repeat(64),
        from_v,
        new_v,
        steps: [{ id: `move-${from_v}-${new_v}`, op: 'core.records.migrate' as const, args, args_hash: await canonicalHash(args) }],
        finalizer: { id: `finalize-${from_v}-${new_v}`, op: 'core.records.finalize-migration' as const, args: final, args_hash: await canonicalHash(final) },
      };
    };
    const forward = await makePlan(1, 2, '4');
    const reverse = await makePlan(2, 1, '5');
    const prepareV2 = async (withReverse: boolean) => {
      const h = harness();
      const publisher = 'publisher-a';
      const owner = { publisher, pack_slug: 'job-status-board' };
      const catalog = await recordsCatalogSlug(owner);
      await installRecordsPackAtomic(h, {
        manifest: manifest(publisher, 1), composition: composition('s1'), verified_publisher: publisher,
        recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 1), publisher_id: publisher, version: 1 }],
      });
      const create = h.localManifestStore.getManifest(catalog)!.surfaces!.records!.executes['job.create'] as RecordsExecutionBinding;
      h.recordsStore.execute({ binding: create, principal: 'owner', args: { id: 'job-1', values: { title: 'kept' } } });
      await installRecordsPackAtomic(h, {
        manifest: manifest(publisher, 2), composition: composition('s2'), verified_publisher: publisher,
        recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 2), publisher_id: publisher, version: 2 }],
        migration_plans: withReverse ? [forward, reverse] : [forward],
      });
      return { h, publisher, owner, catalog };
    };

    const rejected = await prepareV2(false);
    await expect(installRecordsPackAtomic(rejected.h, {
      manifest: manifest(rejected.publisher, 1),
      composition: composition('s1'),
      verified_publisher: rejected.publisher,
      recipes: [{ recipe: businessRecipe('create-job', rejected.publisher, rejected.catalog, 1), publisher_id: rejected.publisher, version: 1 }],
      // A mutable old target cannot grant itself reverse authority.
      migration_plans: [reverse],
    })).rejects.toThrow(/target Records artifact v1 cannot authorize migration edge 2->1/);
    expect(rejected.h.recordsStore.getNamespace(rejected.owner)?.state).toMatchObject({ state: 'ready', version: 2 });
    rejected.h.db.close();

    const admitted = await prepareV2(true);
    await installRecordsPackAtomic(admitted.h, {
      manifest: manifest(admitted.publisher, 1),
      composition: composition('s1'),
      verified_publisher: admitted.publisher,
      recipes: [{ recipe: businessRecipe('create-job', admitted.publisher, admitted.catalog, 1), publisher_id: admitted.publisher, version: 1 }],
      migration_plans: [],
    });
    expect(admitted.h.recordsStore.getNamespace(admitted.owner)?.state).toMatchObject({ state: 'ready', version: 1 });
    expect(admitted.h.recordsStore.ownerGet(admitted.owner, 'job', 'job-1')).toMatchObject({
      title: 'kept',
      _record: { version: 1, revision: 2 },
    });
    admitted.h.db.close();
  });

  it('uninstalls by full ref with retain as the default and never touches a same-slug publisher', async () => {
    const h = harness();
    const ownerA = { publisher: 'publisher-a', pack_slug: 'job-status-board' };
    const ownerB = { publisher: 'publisher-b', pack_slug: 'job-status-board' };
    const catalogA = await recordsCatalogSlug(ownerA);
    const catalogB = await recordsCatalogSlug(ownerB);
    for (const [owner, catalog, recipeId] of [
      [ownerA, catalogA, 'create-a'],
      [ownerB, catalogB, 'create-b'],
    ] as const) {
      await installRecordsPackAtomic(h, {
        manifest: manifest(owner.publisher),
        composition: composition(),
        verified_publisher: owner.publisher,
        recipes: [{ recipe: businessRecipe(recipeId, owner.publisher, catalog), publisher_id: owner.publisher, version: 1 }],
      });
      const create = h.localManifestStore.getManifest(catalog)!.surfaces!.records!.executes['job.create'] as RecordsExecutionBinding;
      h.recordsStore.execute({ binding: create, principal: 'owner', args: { id: 'job-1', values: { title: owner.publisher } } });
    }

    const removed = await uninstallRecordsPackAtomic(h, { owner: ownerA });
    expect(removed).toMatchObject({
      owner: ownerA,
      internal_pack_id: catalogA,
      disposition: 'retain',
      removed_recipes: ['create-a'],
      retired_events: [expect.any(String)],
    });
    expect(h.recordsStore.getNamespace(ownerA)?.state.state).toBe('orphaned');
    expect(h.recordsStore.ownerGet(ownerA, 'job', 'job-1')).toMatchObject({ title: 'publisher-a' });
    expect(h.recordsStore.listOutbox(ownerA, 'pending')).toEqual([]);
    expect(h.recordsStore.listOutbox(ownerA, 'dead_letter')).toHaveLength(1);
    expect(h.localManifestStore.getManifest(catalogA)).toBeNull();
    expect(h.contractStore.get('installed_pack', [catalogA])).toBeNull();
    expect(h.recipeStore.getStored('create-a')).toBeNull();

    expect(h.recordsStore.getNamespace(ownerB)?.state.state).toBe('ready');
    expect(h.recordsStore.ownerGet(ownerB, 'job', 'job-1')).toMatchObject({ title: 'publisher-b' });
    expect(h.localManifestStore.getManifest(catalogB)).not.toBeNull();
    expect(h.recipeStore.getStored('create-b')).not.toBeNull();
    h.db.close();
  });

  it('exports before orphaning and requires the exact full-ref purge confirmation', async () => {
    const h = harness();
    const owner = { publisher: 'publisher-a', pack_slug: 'job-status-board' };
    const catalog = await recordsCatalogSlug(owner);
    await installRecordsPackAtomic(h, {
      manifest: manifest(owner.publisher),
      composition: composition(),
      verified_publisher: owner.publisher,
      recipes: [{ recipe: businessRecipe('create-job', owner.publisher, catalog), publisher_id: owner.publisher, version: 1 }],
    });
    const create = h.localManifestStore.getManifest(catalog)!.surfaces!.records!.executes['job.create'] as RecordsExecutionBinding;
    h.recordsStore.execute({ binding: create, principal: 'owner', args: { id: 'job-1', values: { title: 'kept' } } });
    const result = await uninstallRecordsPackAtomic(h, { owner, disposition: 'export' });
    expect(result.export?.records.job).toEqual([expect.objectContaining({ id: 'job-1', title: 'kept' })]);
    expect(h.recordsStore.getNamespace(owner)?.state.state).toBe('orphaned');

    await expect(uninstallRecordsPackAtomic(h, {
      owner,
      disposition: 'purge',
      confirmation: 'job-status-board',
    })).rejects.toMatchObject({ code: 'validator_rejected' });
    expect(h.recordsStore.ownerGet(owner, 'job', 'job-1')).not.toBeNull();
    await uninstallRecordsPackAtomic(h, {
      owner,
      disposition: 'purge',
      confirmation: 'publisher-a/job-status-board',
    });
    expect(h.recordsStore.getNamespace(owner)).toBeNull();
    h.db.close();
  });

  it('routes the public packs.uninstall RPC into the full-ref Records coordinator', async () => {
    const h = harness();
    const owner = { publisher: 'publisher-a', pack_slug: 'job-status-board' };
    const catalog = await recordsCatalogSlug(owner);
    await installRecordsPackAtomic(h, {
      manifest: manifest(owner.publisher),
      composition: composition(),
      verified_publisher: owner.publisher,
      recipes: [{ recipe: businessRecipe('create-job', owner.publisher, catalog), publisher_id: owner.publisher, version: 1 }],
    });
    const response = await handlePacksUninstall({
      recipeStore: h.recipeStore,
      recordsStore: h.recordsStore,
      localManifestStore: h.localManifestStore,
      contractStore: h.contractStore,
      registry: h.registry,
    }, {
      pack_slug: owner.pack_slug,
      publisher: owner.publisher,
    });
    expect(response.result).toMatchObject({
      ok: true,
      removed: { recipes: ['create-job'] },
      records: { owner, disposition: 'retain' },
    });
    expect(h.recordsStore.getNamespace(owner)?.state.state).toBe('orphaned');
    h.db.close();
  });
  it('refuses a natural_key change at a schema-unchanged bump, because the sweep would rekey nothing', async () => {
    // A natural key projects no field, so `storage_schema_hash` is identical
    // across this bump and the durable schema-unchanged sweep is eligible. The
    // sweep advances each row's version and leaves its `pk` alone, so every
    // existing row would end up at an id the new key does not derive — and the
    // next create of that same tuple would seat a SECOND row, defeating the one
    // invariant `natural_key` exists to state.
    const h = harness();
    const publisher = 'publisher-a';
    const owner = { publisher, pack_slug: 'job-status-board' };
    const catalog = await recordsCatalogSlug(owner);
    await installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 1),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 1), publisher_id: publisher, version: 1 }],
    });
    const create = h.localManifestStore.getManifest(catalog)!
      .surfaces!.records!.executes['job.create'] as RecordsExecutionBinding;
    h.recordsStore.execute({
      binding: create,
      principal: 'owner',
      args: { id: 'legacy-id', values: { title: 'kept' } },
    });

    await expect(installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 2),
      composition: keyedComposition('s1'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 2), publisher_id: publisher, version: 2 }],
    })).rejects.toThrow(/natural_key changed on populated job/);
    // Refused BEFORE mutation: still ready at v1, row untouched at its old id.
    expect(h.recordsStore.getNamespace(owner)?.state).toMatchObject({ state: 'ready', version: 1 });
    expect(h.recordsStore.getNamespace(owner)?.quota.row_count).toBe(1);

    // The permitting case: the identical bump with the key UNCHANGED still takes
    // the schema-unchanged sweep. Without this the refusal above is
    // indistinguishable from refusing schema-unchanged bumps altogether.
    await installRecordsPackAtomic(h, {
      manifest: manifest(publisher, 2),
      composition: composition('s1'),
      verified_publisher: publisher,
      recipes: [{ recipe: businessRecipe('create-job', publisher, catalog, 2), publisher_id: publisher, version: 2 }],
    });
    expect(h.recordsStore.getNamespace(owner)?.state).toMatchObject({ state: 'ready', version: 2 });
    expect(h.recordsStore.getNamespace(owner)?.quota.row_count).toBe(1);
    h.db.close();
  });
});
