/** D-210 code audit, finding 1 — the reception policy-gate WIRING.
 *
 *  `reception` was absent from all three `POLICY_GATED_*_CHANNELS` sets, so
 *  `evaluateAdmission` resolved to `undefined` for it — and the ONLY call site
 *  of `evaluatePreflightAdmission` (the D-207 `allowed_tools` allowlist AND the
 *  D-209 trust ceiling) lives inside that closure. A paired reception recipe's
 *  plain `{ingredient: …}` steps therefore dispatched with NO grant check, on
 *  an anonymous visitor's request.
 *
 *  ⛔ WHY THIS FILE EXISTS AT ALL. `d-207-slice1c-preflight-bypass-removed.test.ts`
 *  asserts `admitByOpRisk` DIRECTLY — the primitive, not the wiring — so it
 *  stayed green across the entire bypass. Every test here drives the REAL
 *  `handleExecute` with a reception-shaped `ExecutionSource`, because the thing
 *  that was broken was never the primitive: it was whether anything called it.
 *  ⇒ [[a_call_site_is_not_a_wired_seam]] · [[a_documented_deferral_becomes_a_bypass]]
 *
 *  Both live producers (`reception-recipe-runner.ts`, `reception-manage-runner.ts`)
 *  already resolved a `ContractSnapshot` and passed it; only the set entry was
 *  missing. These tests fail against the pre-fix set. */
import { describe, expect, it } from 'vitest';
import {
  type ContractSnapshot,
  type ExecutionSource,
  type IngredientManifest,
  type RecipeDefinition,
  type RecipeError,
} from '@recued/contracts';

import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

const NOW = Date.UTC(2030, 0, 15, 12, 0, 0);
const DOOR_CONTRACT_ID = 'door-contract-1';

/** The shape `reception-recipe-runner.ts:235-240` mints — actor stays
 *  `anonymous` (the truth: VISITOR-derived), authority rides `contract_id`. */
const receptionSource: ExecutionSource = {
  channel: 'reception',
  actor: 'anonymous',
  reception_id: 'endpoint-1',
  contract_id: DOOR_CONTRACT_ID,
} as ExecutionSource;

const buildManifest = (
  slug: string,
  risk_tier: IngredientManifest['risk_tier'],
): IngredientManifest => ({
  slug,
  name: slug,
  description: `D-210 F1 fixture for ${slug}`,
  author: 'test',
  kind: 'storage',
  risk_tier,
  version: 1,
  category: 'data',
  input: {},
  output: { data: 'data' },
}) as unknown as IngredientManifest;

const buildRecipe = (recipe_id: string, ingredient: string): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 60,
  metadata: {
    name: recipe_id,
    description: 'Minimal D-210 F1 policy fixture.',
    author: 'test',
    supported_platforms: ['test'],
    tags: ['test', 'policy', 'gate'],
  },
  variables: {},
  prefetch_steps: [],
  // A PLAIN `{ingredient}` step — the exact shape the bypass covered. `op:` /
  // catalog steps route through `runCatalogOperation` and always gated.
  steps: [{ id: 'call', ingredient, input: {} }],
  output: { sidebar: [] },
}) as RecipeDefinition;

const makeExecuteDeps = (
  recipe: RecipeDefinition,
  manifests: readonly IngredientManifest[],
): ExecuteHandlerDeps => {
  const registry: ManifestRegistry = createManifestRegistry('/nonexistent');
  for (const manifest of manifests) registry.register(manifest);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  return {
    recipeStore,
    executorConfig: { manifests: registry },
    baseVault: {},
    instanceId: 'server-test-1',
  };
};

/** Mirrors `buildReceptionContractSnapshot` — `allowed_tools` is the door's own
 *  stored `scope.ingredient_ids`, the SAME derivation the mint wrote its grant
 *  rows from, so the ACCESS and TOOL axes cannot disagree. */
const doorSnapshot = (allowed_tools: readonly string[]): ContractSnapshot => ({
  contract_id: DOOR_CONTRACT_ID,
  contract_version: '1',
  allowed_tools,
  approval_required: [],
  scope_restrictions: [],
  resolved_at: NOW,
});

const firstRecipeError = (errors: readonly unknown[]): RecipeError =>
  errors[0] as RecipeError;

const denialCode = (errors: readonly unknown[]): string | undefined => {
  const details = firstRecipeError(errors).details as {
    denials?: readonly { decision: { code: string } }[];
  };
  return details?.denials?.[0]?.decision.code;
};

const errorsContainCode = (errors: readonly unknown[], code: string): boolean =>
  errors.some(
    (error) =>
      typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === code,
  );

describe('D-210 F1 — reception is policy-gated', () => {
  it('DENIES a plain ingredient step absent from the door allowlist (the bypass)', async () => {
    // Pre-fix this returned success:true with the step dispatched. The A/B that
    // proved it: the identical request on `mcp` was refused, on `reception` it ran.
    const manifest = buildManifest('ungranted-write', 'write');
    const recipe = buildRecipe('reception-ungranted-write', manifest.slug);

    const result = await handleExecute(makeExecuteDeps(recipe, [manifest]), {
      recipe_id: recipe.recipe_id,
      trigger_source: 'reception',
      execution_source: receptionSource,
      // The door granted something ELSE — this step is outside its closure.
      contract_snapshot: doorSnapshot(['some-other-ingredient']),
    });

    expect(result.success).toBe(false);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(true);
    expect(denialCode(result.errors)).toBe('tool_not_in_contract');
  });

  it('DENIES every dispatch when the door is revoked — the live kill-switch', async () => {
    // `buildReceptionContractSnapshot` yields `allowed_tools: []` for a dead /
    // revoked / deleted door, and the runner's comment calls that "the live
    // kill-switch over an already-public form". That claim was FALSE until the
    // set entry landed — an empty allowlist gated nothing.
    const manifest = buildManifest('revoked-door-read', 'read');
    const recipe = buildRecipe('reception-revoked-door', manifest.slug);

    const result = await handleExecute(makeExecuteDeps(recipe, [manifest]), {
      recipe_id: recipe.recipe_id,
      trigger_source: 'reception',
      execution_source: receptionSource,
      contract_snapshot: doorSnapshot([]),
    });

    expect(result.success).toBe(false);
    expect(denialCode(result.errors)).toBe('tool_not_in_contract');
  });

  it('ADMITS a read the door actually granted — the gate narrows, it does not blanket-deny', async () => {
    // The over-denial guard. The allowlist is derived from the door's own scope,
    // so a granted op must still run; if this goes red the fix is refusing the
    // ordinary paired-recipe path rather than closing the hole.
    const manifest = buildManifest('granted-read', 'read');
    const recipe = buildRecipe('reception-granted-read', manifest.slug);

    const result = await handleExecute(makeExecuteDeps(recipe, [manifest]), {
      recipe_id: recipe.recipe_id,
      trigger_source: 'reception',
      execution_source: receptionSource,
      contract_snapshot: doorSnapshot([manifest.slug]),
    });

    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
    expect(result.steps.map((step) => step.id)).toEqual(['call']);
  });
});
