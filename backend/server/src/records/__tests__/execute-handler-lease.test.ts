import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  IngredientManifest,
  RecipeDefinition,
  RecordsExecutionBinding,
  RecordsPackRef,
  RecordsSchemaSnapshot,
} from '@recued/contracts';

import { handleExecute } from '../../execute-handler.js';
import { KERNEL_MANIFESTS } from '../../kernel-manifests.js';
import { createManifestRegistry } from '../../manifest-loader.js';
import { createRecipeStore } from '../../recipe-store.js';
import { createContractGrantStore } from '../../storage/contract-grant-store.js';
import { createContractScanFn, createContractStore } from '../../storage/contract-store.js';
import { createRecordsStore } from '../store.js';

const OWNER: RecordsPackRef = {
  publisher: 'publisher-a.example',
  pack_slug: 'records-a',
};

const SCHEMA: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    job: {
      kind: 'job',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'title', slot: 's1', kind: 'string', required: true },
      ],
    },
  },
};

const GET_BINDING: RecordsExecutionBinding = {
  kind: 'core.records',
  action: 'get',
  entity: 'job',
  owner: OWNER,
  pack_version: 1,
  storage_schema_hash: 'a'.repeat(64),
  declaration_hash: 'b'.repeat(64),
  operation_digest: 'c'.repeat(64),
};

const recordsManifest: IngredientManifest = {
  slug: 'records-a-catalog',
  name: 'Pack A Records',
  description: 'Cross-pack lease fixture',
  author: OWNER.publisher,
  kind: 'storage',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  input: { operation: null, args: null },
  output: { result: 'result' },
  operations: {
    'job.get': {
      operation_id: `${OWNER.publisher}.${OWNER.pack_slug}.job.get`,
      risk_tier: 'read',
      approval: 'never',
      groups: ['job.read'],
    },
  },
  operation_groups: {
    'job.read': {
      group_id: 'job.read',
      operations: ['job.get'],
      risk_floor: 'read',
    },
  },
  surfaces: { records: { executes: { 'job.get': GET_BINDING }, schema: SCHEMA } },
};

const recipe: RecipeDefinition = {
  recipe_id: 'pack-b-read-then-effect',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Pack B read then effect',
    description: 'Wait in an earlier step before touching Pack A Records.',
    author: 'publisher-b.example',
    supported_platforms: ['server'],
    tags: ['records', 'cross-pack'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'effect_gate', ingredient: 'shared-read', input: { key: 'data.shared.effect-gate' } },
    {
      id: 'read_pack_a',
      ingredient: recordsManifest.slug,
      input: { operation: 'job.get', args: { id: 'job-1' } },
    },
  ],
  output: { sidebar: [] },
};

describe('D-221 production execute-handler namespace lease', () => {
  const dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('pre-acquires Pack A before a Pack B run enters an earlier step and holds the fence until run end', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const recordsStore = createRecordsStore(db);
    recordsStore.installNamespace({
      owner: OWNER,
      version: 1,
      storage_schema_hash: GET_BINDING.storage_schema_hash,
      declaration_hash: GET_BINDING.declaration_hash,
      artifact_digest: 'artifact-a-v1',
      schema: SCHEMA,
      bindings: { 'job.get': GET_BINDING },
    });

    const recipeStore = createRecipeStore('/nonexistent', db);
    recipeStore.save(recipe, 'publisher-b.example', 'inline', 1_800_000_000_000, 'pack-b');
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(structuredClone(KERNEL_MANIFESTS.find((entry) => entry.slug === 'shared-read')!));
    manifests.register(recordsManifest);
    const contractStore = createContractStore(db);
    createContractGrantStore(contractStore).grantPackGroup(
      recordsManifest.slug,
      recordsManifest.slug,
      recordsManifest.slug,
      'job.read',
    );

    let enterGate!: () => void;
    let releaseGate!: () => void;
    const entered = new Promise<void>((resolve) => { enterGate = resolve; });
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const execution = handleExecute({
      recipeStore,
      recordsStore,
      executorConfig: {
        manifests,
        kernelDispatchers: {
          read: async ({ key }) => {
            enterGate();
            await gate;
            return { found: false, key };
          },
        },
      },
      contractScan: createContractScanFn(contractStore),
      baseVault: {},
      instanceId: 'records-lease-test',
    }, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'manual',
      execution_source: {
        channel: 'chat',
        actor: 'user_self',
        chat_session_id: 'chat-lease-test',
        user_id: 'owner',
      },
    });

    await Promise.race([
      entered,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('first step did not start')), 1_000)),
    ]);
    const namespace = recordsStore.getNamespace(OWNER)!;
    const fence = recordsStore.fenceNamespace({
      owner: OWNER,
      expected_activation_generation: namespace.activation_generation,
    });
    await expect(recordsStore.waitForNamespaceQuiescence({ ...fence, timeout_ms: 0 }))
      .resolves.toMatchObject({
        drained: false,
        blockers: [{
          recipe_id: recipe.recipe_id,
          caller_pack: 'pack-b',
        }],
      });

    releaseGate();
    const result = await execution;
    expect(result.success).toBe(true);
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'read_pack_a', skipped: false, error: null }),
    ]));
    await expect(recordsStore.waitForNamespaceQuiescence({ ...fence, timeout_ms: 50 }))
      .resolves.toEqual({ drained: true, blockers: [] });
    recordsStore.releaseNamespaceFence(fence);
  });

  it('re-checks the installed operation-group grant and denies a live revoke', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const recordsStore = createRecordsStore(db);
    recordsStore.installNamespace({
      owner: OWNER,
      version: 1,
      storage_schema_hash: GET_BINDING.storage_schema_hash,
      declaration_hash: GET_BINDING.declaration_hash,
      artifact_digest: 'artifact-a-v1',
      schema: SCHEMA,
      bindings: { 'job.get': GET_BINDING },
    });
    const readOnlyRecipe: RecipeDefinition = {
      ...recipe,
      recipe_id: 'pack-b-read-records-only',
      steps: [recipe.steps[1]!],
    };
    const recipeStore = createRecipeStore('/nonexistent', db);
    recipeStore.save(readOnlyRecipe, 'publisher-b.example', 'inline', 1_800_000_000_000, 'pack-b');
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(recordsManifest);
    const contractStore = createContractStore(db);
    const grants = createContractGrantStore(contractStore);
    grants.grantPackGroup(
      recordsManifest.slug,
      recordsManifest.slug,
      recordsManifest.slug,
      'job.read',
    );
    grants.removePackGroups(recordsManifest.slug);
    const execute = vi.spyOn(recordsStore, 'execute');

    const result = await handleExecute({
      recipeStore,
      recordsStore,
      contractScan: createContractScanFn(contractStore),
      executorConfig: { manifests, kernelDispatchers: {} },
      baseVault: {},
      instanceId: 'records-grant-revoke-test',
    }, {
      recipe_id: readOnlyRecipe.recipe_id,
      trigger_source: 'manual',
      execution_source: {
        channel: 'chat',
        actor: 'user_self',
        chat_session_id: 'chat-records-grant-revoke-test',
        user_id: 'owner',
      },
    });

    expect(result.success).toBe(false);
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'read_pack_a',
        error: expect.objectContaining({
          message: expect.stringContaining('operation_not_granted'),
        }),
      }),
    ]));
    expect(execute).not.toHaveBeenCalled();
  });

  it('retires the live-run registration when the namespace lease refuses', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const recordsStore = createRecordsStore(db);
    recordsStore.installNamespace({
      owner: OWNER,
      version: 1,
      storage_schema_hash: GET_BINDING.storage_schema_hash,
      declaration_hash: GET_BINDING.declaration_hash,
      artifact_digest: 'artifact-a-v1',
      schema: SCHEMA,
      bindings: { 'job.get': GET_BINDING },
    });
    const recipeStore = createRecipeStore('/nonexistent', db);
    recipeStore.save(recipe, 'publisher-b.example', 'inline', 1_800_000_000_000, 'pack-b');
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(structuredClone(KERNEL_MANIFESTS.find((entry) => entry.slug === 'shared-read')!));
    manifests.register(recordsManifest);
    const namespace = recordsStore.getNamespace(OWNER)!;
    const fence = recordsStore.fenceNamespace({
      owner: OWNER,
      expected_activation_generation: namespace.activation_generation,
    });
    const registerRun = vi.fn();
    const completeRun = vi.fn();

    await expect(handleExecute({
      recipeStore,
      recordsStore,
      inFlightRegistry: {
        runningTwin: () => null,
        claimRunningTwin: () => ({ leader: true }),
        settleRunningTwin: () => {},
        registerRun,
        completeRun,
      } as never,
      executorConfig: { manifests, kernelDispatchers: {} },
      baseVault: {},
      instanceId: 'records-lease-refusal-test',
    }, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'manual',
      execution_source: {
        channel: 'chat',
        actor: 'user_self',
        chat_session_id: 'chat-lease-refusal-test',
        user_id: 'owner',
      },
    })).rejects.toMatchObject({
      code: 'execution_error',
      message: expect.stringContaining('fenced'),
    });

    expect(registerRun).toHaveBeenCalledTimes(1);
    expect(completeRun).toHaveBeenCalledTimes(1);
    expect(completeRun).toHaveBeenCalledWith(expect.any(String));
    recordsStore.releaseNamespaceFence(fence);
  });
});
