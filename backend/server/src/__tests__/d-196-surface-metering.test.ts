/** D-196 R5 direct-MCP surface classification + D-162 multiplicity. */

import { describe, expect, it, vi } from 'vitest';
import type {
  ContractSnapshot,
  ExecutionSource,
  IngredientManifest,
  RecipeDefinition,
} from '@recued/contracts';

import {
  _testing as executeTesting,
  handleExecute,
  type ExecuteHandlerDeps,
} from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

const resolvedBatch = (count: number): Record<string, unknown> => ({
  'llm.id_field': 'id',
  'llm.data': Array.from({ length: count }, (_, index) => ({ id: index })),
});

describe('D-162 customer-controlled direct-MCP multiplicity', () => {
  it('charges N-1 extra units when caller config supplies a batch of N', () => {
    expect(executeTesting.customerControlledD162ExtraUnits({
      slug: 'ai-classify',
      resolvedInput: resolvedBatch(4),
      customerControlled: true,
    })).toBe(3);
  });

  it('does not charge seller-authored step fan-out inside one stored recipe tool', () => {
    expect(executeTesting.customerControlledD162ExtraUnits({
      slug: 'ai-classify',
      resolvedInput: resolvedBatch(4),
      customerControlled: false,
    })).toBe(0);
  });

  it('treats a customer-supplied inline recipe batch as customer-controlled', () => {
    expect(executeTesting.customerControlledD162ExtraUnits({
      slug: 'core-ai-summarize',
      resolvedInput: resolvedBatch(3),
      customerControlled: true,
    })).toBe(2);
  });

  it('does not add units for non-batch, single-element, or non-batch-capable calls', () => {
    expect(executeTesting.customerControlledD162ExtraUnits({
      slug: 'ai-classify',
      resolvedInput: { 'llm.data': [{ id: 1 }] },
      customerControlled: true,
    })).toBe(0);
    expect(executeTesting.customerControlledD162ExtraUnits({
      slug: 'ai-classify',
      resolvedInput: resolvedBatch(1),
      customerControlled: true,
    })).toBe(0);
    expect(executeTesting.customerControlledD162ExtraUnits({
      slug: 'ai-compare',
      resolvedInput: resolvedBatch(5),
      customerControlled: true,
    })).toBe(0);
  });

  const recipeWith = (steps: RecipeDefinition['steps']): RecipeDefinition => ({
    recipe_id: 'd196-batch-provenance',
    version: 1,
    ttl: 60,
    metadata: {
      name: 'D-196 batch provenance',
      description: 'fixture',
      author: 'test',
      supported_platforms: ['test'],
    },
    variables: {},
    prefetch_steps: [],
    steps,
    output: { sidebar: [] },
  });

  const controlsBatch = (
    recipe: RecipeDefinition,
    mergedArgs: Record<string, unknown>,
    keys: ReadonlySet<string>,
  ): boolean => executeTesting.customerControlsD162Batch({
    recipe,
    mergedArgs,
    callerRootKeys: {
      config: keys,
      context: new Set(),
      vault: new Set(),
    },
    getIngredientKind: (slug) => {
      if (slug === 'fetch-records') return 'http';
      if (slug === 'ai-producer') return 'ai';
      return undefined;
    },
    getIngredientManifestInput: () => undefined,
  });

  it('follows caller config through a transform-produced step value', () => {
    const recipe = recipeWith([{
      id: 'derive',
      transform: 'coalesce',
      values: ['{{config.payload.records}}'],
    }]);

    expect(controlsBatch(
      recipe,
      { 'llm.data': '{{step.derive.result}}' },
      new Set(['payload']),
    )).toBe(true);
  });

  it('recognizes a caller-supplied context root on a stored recipe', () => {
    const recipe = recipeWith([]);
    expect(executeTesting.customerControlsD162Batch({
      recipe,
      mergedArgs: { 'llm.data': '{{context.records}}' },
      callerRootKeys: {
        config: new Set(),
        context: new Set(['records']),
        vault: new Set(),
      },
      getIngredientKind: () => undefined,
      getIngredientManifestInput: () => undefined,
    })).toBe(true);
  });

  it('keeps seller literals and IO-produced arrays seller-controlled', () => {
    const literal = recipeWith([{
      id: 'derive',
      transform: 'coalesce',
      values: [[{ id: 1 }, { id: 2 }]],
    }]);
    expect(controlsBatch(
      literal,
      { 'llm.data': '{{step.derive.result}}' },
      new Set(['query']),
    )).toBe(false);

    const io = recipeWith([{
      id: 'fetch',
      ingredient: 'fetch-records',
      input: { query: '{{config.query}}' },
    }]);
    expect(controlsBatch(
      io,
      { 'llm.data': '{{step.fetch.result.records}}' },
      new Set(['query']),
    )).toBe(false);
  });

  it('treats caller-sized foreach output as customer-controlled across an IO boundary', () => {
    const recipe = recipeWith([{
      id: 'fetch-each',
      foreach: '{{config.records}}',
      ingredient: 'fetch-records',
      input: { id: '{{item.id}}' },
    }]);

    expect(controlsBatch(
      recipe,
      { 'llm.data': '{{step.fetch-each}}' },
      new Set(['records']),
    )).toBe(true);
  });

  it('keeps caller lineage through an AI producer even when approval projection would refuse', () => {
    const recipe = recipeWith([{
      id: 'derive-ai',
      ingredient: 'ai-producer',
      input: {
        'llm.data': '{{config.payload.records}}',
        'llm.allow_search': true,
      },
    }]);

    expect(controlsBatch(
      recipe,
      { 'llm.data': '{{step.derive-ai.result}}' },
      new Set(['payload']),
    )).toBe(true);
  });

  it('preserves N=0 at the real dispatch boundary without a commit substrate', async () => {
    const manifest = {
      slug: 'ai-classify',
      name: 'AI classify',
      description: 'Empty batch fixture',
      author: 'recued-core',
      kind: 'ai',
      risk_tier: 'read',
      version: 1,
      category: 'ai',
      input: {},
      output: { result: 'result' },
    } as unknown as IngredientManifest;
    const recipe: RecipeDefinition = {
      ...recipeWith([{
        id: 'classify',
        ingredient: 'ai-classify',
        input: {
          'llm.id_field': 'id',
          'llm.data': '{{config.records}}',
          'llm.categories': ['keep'],
        },
      }]),
      variables: { records: ['placeholder'] },
    };
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(manifest);
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register(recipe);
    let hasReservation = false;
    const reserveOnce = vi.fn(() => {
      hasReservation = true;
      return { admitted: true as const };
    });
    const markZeroUnitReservation = vi.fn(() => {
      hasReservation = true;
      return { admitted: true as const };
    });
    const customerUsage: NonNullable<ExecuteHandlerDeps['customerUsage']> = {
      reserve: vi.fn(() => ({ admitted: true as const })),
      reserveOnce,
      markZeroUnitReservation,
      hasReservationKey: () => hasReservation,
      commit: vi.fn(),
      release: vi.fn(),
      denialMessage: () => undefined,
    };
    const executionSource: ExecutionSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'tool-call-1',
      mcp_token_id: 'token-1',
      contract_id: 'contract-1',
    };
    const contractSnapshot: ContractSnapshot = {
      contract_id: 'contract-1',
      contract_version: '1',
      allowed_tools: ['ai-classify'],
      approval_required: [],
      scope_restrictions: [],
      resolved_at: 1,
    };

    const result = await handleExecute({
      recipeStore,
      executorConfig: {
        manifests,
        // The empty-batch path short-circuits before adapter selection/network.
        llmConfig: { slot_1: { provider: 'openai', model: 'unused' } } as never,
      },
      baseVault: {},
      customerUsage,
      // commitStore intentionally absent — exercises the narrow fallback.
    }, {
      recipe_id: recipe.recipe_id,
      config: { records: [] },
      trigger_source: 'mcp',
      execution_source: executionSource,
      contract_snapshot: contractSnapshot,
    });

    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ success: true });
    expect(markZeroUnitReservation).toHaveBeenCalledTimes(1);
    expect(reserveOnce).not.toHaveBeenCalled();
    expect(customerUsage.reserve).not.toHaveBeenCalled();
  });
});
