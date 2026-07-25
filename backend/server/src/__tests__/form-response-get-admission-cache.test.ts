import { createInMemoryStore } from '@recued/cache';
import type {
  Commit,
  ContractSnapshot,
  ExecutionSource,
  FormResponse,
  IngredientManifest,
  RecipeDefinition,
} from '@recued/contracts';
import { createCommitStore, createInMemoryCollection } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import type { OpAdmissionGate } from '../op-admission-gate.js';
import { createRecipeStore } from '../recipe-store.js';

const INGREDIENT_SLUG = 'form-response-get';
const OP_ID = 'core.data.form-response.get';

const SOURCE: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'token-1',
  contract_id: 'contract-1',
};

const RESPONSE: FormResponse = {
  _id: 'submission-1',
  _collection: 'form_response',
  submission_id: 'submission-1',
  endpoint_id: 'endpoint-1',
  form_definition_id: 'definition-1',
  definition_snapshot: { fields: [{ name: 'brief' }] },
  values: { brief: 'Private visitor answer' },
  visitor: { email: 'visitor@example.com' },
  submitted_at: 1_000,
  accepted_at: 2_000,
  origin_actor: 'anonymous',
  origin_surface: 'system',
  lifecycle_state: 'received',
  state_changed_at: 0,
  metadata: {},
};

const MANIFEST: IngredientManifest = {
  slug: INGREDIENT_SLUG,
  name: 'Fetch accepted form response',
  description: 'Fetch one accepted form response for the cache admission regression test.',
  author: 'recued',
  kind: 'storage',
  category: 'data',
  risk_tier: 'read',
  version: 1,
  input: { submission_id: null },
  output: { record: 'record' },
};

const RECIPE: RecipeDefinition = {
  recipe_id: 'form-response-cache-admission',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Form response cache admission regression',
    description: 'Ensures sensitive response reads always re-enter admission.',
    author: 'test',
    supported_platforms: ['test'],
    tags: ['test', 'form-response', 'cache'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'response',
      ingredient: INGREDIENT_SLUG,
      input: { submission_id: 'submission-1' },
    },
  ],
  output: { sidebar: [] },
};

const snapshot = (scope_restrictions: readonly string[] = []): ContractSnapshot => ({
  contract_id: 'contract-1',
  contract_version: '1',
  allowed_tools: [INGREDIENT_SLUG],
  approval_required: [],
  scope_restrictions,
  resolved_at: 1_700_000_000_000,
});

const makeHarness = () => {
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(MANIFEST);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(RECIPE);
  const formResponseGet = vi.fn(async () => ({ record: RESPONSE }));
  let opGranted = true;
  const isOpGranted = vi.fn((_source: ExecutionSource, opId: string | undefined) =>
    opGranted && opId === OP_ID,
  );
  const opAdmissionGate: OpAdmissionGate = {
    isFrozenByPause: () => false,
    isOpGranted,
  };
  const deps: ExecuteHandlerDeps = {
    recipeStore,
    executorConfig: {
      manifests,
      cacheStore: createInMemoryStore(),
      instanceId: 'pair-1',
      kernelDispatchers: { formResponseGet },
    },
    baseVault: {},
    instanceId: 'pair-1',
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    opAdmissionGate,
  };
  return {
    deps,
    formResponseGet,
    isOpGranted,
    revokeOp: () => { opGranted = false; },
  };
};

const run = (deps: ExecuteHandlerDeps, contract_snapshot: ContractSnapshot) =>
  handleExecute(deps, {
    recipe_id: RECIPE.recipe_id,
    trigger_source: 'mcp',
    execution_source: SOURCE,
    contract_snapshot,
  });

const errorMessage = (error: unknown): string =>
  error !== null
  && typeof error === 'object'
  && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error);

describe('form-response-get — L2 cache never bypasses live admission', () => {
  it('rechecks an owner-only op revoke after an authorized run warmed the caches', async () => {
    const harness = makeHarness();
    await expect(run(harness.deps, snapshot())).resolves.toMatchObject({ success: true });
    expect(harness.formResponseGet).toHaveBeenCalledOnce();

    harness.revokeOp();
    const denied = await run(harness.deps, snapshot());

    expect(denied.success).toBe(false);
    expect(denied.errors.some((error) => errorMessage(error).includes('not granted'))).toBe(true);
    expect(harness.formResponseGet).toHaveBeenCalledOnce();
    expect(harness.isOpGranted).toHaveBeenCalledTimes(2);
    expect(harness.isOpGranted).toHaveBeenLastCalledWith(SOURCE, OP_ID);
  });

  it('rechecks the data.form_response scope after an authorized cache warm', async () => {
    const harness = makeHarness();
    await expect(run(harness.deps, snapshot())).resolves.toMatchObject({ success: true });
    expect(harness.formResponseGet).toHaveBeenCalledOnce();

    const denied = await run(harness.deps, snapshot(['data.mail.*']));

    expect(denied.success).toBe(false);
    expect(
      denied.errors.some((error) => errorMessage(error).includes('scope_not_in_restrictions')),
    ).toBe(true);
    expect(harness.formResponseGet).toHaveBeenCalledOnce();
  });
});
