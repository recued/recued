/** The viewback runner's `uses_ai` is derived from the recipe that actually ran.
 *
 *  ⛔⛔ WHY THIS FILE EXISTS SEPARATELY FROM THE ROUTE SUITE. The route suite
 *  injects a synthetic `runLookupRecipe`, so it proves the HANDLER's branch and
 *  never the runner's derivation — severing `uses_ai: cost.profile.uses_ai` in
 *  the runner leaves all 28 of its tests green. That is two stubs from opposite
 *  sides of one boundary with the join untested, and this door has already been
 *  bitten by exactly that: `createReceptionLookupRecipeRunner` once existed only
 *  at its own declaration while every viewback silently rendered the substrate
 *  status — typechecked, tested, unreachable.
 *
 *  So this drives the REAL runner. Its only variable between the two cases is
 *  the recipe's op.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import {
  createReceptionLookupRecipeRunner,
  type ReceptionLookupRecipeRunnerDeps,
} from '../reception-lookup-recipe-runner.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ReceptionLookupRecipePairStore } from '../storage/reception-lookup-recipe-pair-store.js';

const NOW = (): number => 1_700_000_000_000;
const CONTRACT_ID = 'door_lookup_1';

/** The runner imports `handleExecute` directly, so spy at the module boundary —
 *  same seam the submit-runner suite uses. */
vi.mock('../execute-handler.js', async (orig) => {
  const actual = await orig<typeof import('../execute-handler.js')>();
  return {
    ...actual,
    handleExecute: async () => ({
      success: true,
      output: { render: [{ type: 'text', data: 'ok' }] },
      errors: [],
      steps: [],
    }),
  };
});

const recipeWithOp = (op: string): RecipeDefinition => ({
  recipe_id: 'viewback',
  prefetch_steps: [],
  steps: [{ id: 'show', op }],
  trigger_steps: [],
  output: { render: [] },
} as unknown as RecipeDefinition);

const harness = (op: string): ReceptionLookupRecipeRunnerDeps => {
  const def = {
    contract_id: CONTRACT_ID,
    door_type: 'reception',
    scope: { operation_ids: [op], ingredient_ids: [] },
    // allow_ai TRUE so an AI recipe is admitted and the run reaches the outcome.
    // A door that refuses is already covered by the policy tests; what is under
    // test here is what the COMPLETED outcome reports.
    door_execution_policy: { max_steps: 64, allow_ai: true },
  } as unknown as never;
  return {
    executeDeps: {} as never,
    lookupPairStore: {
      findByEndpoint: () => ({
        endpoint_id: 'ep1',
        recipe_id: 'viewback',
        contract_id: CONTRACT_ID,
      }),
    } as unknown as ReceptionLookupRecipePairStore,
    definitionStore: {
      get: (id: string) => (id === CONTRACT_ID ? def : null),
    } as unknown as ContractDefinitionStore,
    resolveConfig: () => ({}),
    resolveRecipe: () => recipeWithOp(op),
    now: NOW,
  };
};

const runFor = async (op: string) =>
  createReceptionLookupRecipeRunner(harness(op)).run({
    endpoint_id: 'ep1',
    record_id: 'rec-1',
    record: { reference_id: 'sub-1', state: 'received' },
  });

describe('viewback runner — uses_ai on the completed outcome', () => {
  it('⛔ TRUE for a viewback recipe that runs a core.ai.* step', async () => {
    const outcome = await runFor('core.ai.summarize');
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.uses_ai).toBe(true);
  });

  it('FALSE for an otherwise identical recipe with a non-AI step', async () => {
    const outcome = await runFor('core.crm.contact.get');
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.uses_ai).toBe(false);
  });
});
