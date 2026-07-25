/** D-209 #1 W3 — the webhook door's policy-gate WIRING.
 *
 *  Found by tracing the "SUSPECTED, not traced" note left on the D-210 audit's
 *  finding 1. `webhook` was absent from all three `POLICY_GATED_*_CHANNELS` sets,
 *  exactly as `reception` was, so `evaluateAdmission` resolved to `undefined` and
 *  the ONLY call site of `evaluatePreflightAdmission` — the D-207 `allowed_tools`
 *  allowlist AND the D-209 trust ceiling — never ran for a webhook dispatch.
 *
 *  The producer already did its half: `webhook-recipe-runner.ts` resolves a
 *  `ContractSnapshot` via `buildWebhookContractSnapshot` and passes it to
 *  `handleExecute`, with a comment asserting behaviour that never executed —
 *  "a contract-bearing source with no snapshot THROWS at the policy/preflight
 *  gates". Same shape, same wrong assumption, second public door.
 *  ⇒ [[a_documented_deferral_becomes_a_bypass]] · [[a_call_site_is_not_a_wired_seam]]
 *
 *  Every test drives the REAL `handleExecute`, because what was broken was never
 *  the primitive — it was whether anything called it. */
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
const DOOR_CONTRACT_ID = 'webhook-door-1';

/** The shape `webhook-recipe-runner.ts` dispatches — `anonymous`, carrying the
 *  claimed trigger row's stamped door contract. */
const webhookSource: ExecutionSource = {
  channel: 'webhook',
  actor: 'anonymous',
  vendor: 'stripe',
  webhook_secret_id: 'ingress-1',
  contract_id: DOOR_CONTRACT_ID,
} as ExecutionSource;

const buildManifest = (
  slug: string,
  risk_tier: IngredientManifest['risk_tier'],
): IngredientManifest => ({
  slug,
  name: slug,
  description: `D-209 W3 fixture for ${slug}`,
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
    description: 'Minimal D-209 W3 policy fixture.',
    author: 'test',
    supported_platforms: ['test'],
    tags: ['test', 'policy', 'gate'],
  },
  variables: {},
  prefetch_steps: [],
  // A PLAIN `{ingredient}` step — the shape the bypass covered. `op:` / catalog
  // steps route through `runCatalogOperation` and always gated.
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

/** Mirrors `buildWebhookContractSnapshot` — `allowed_tools` is the door's derived
 *  tool closure, so ACCESS and TOOL cannot disagree. */
const doorSnapshot = (allowed_tools: readonly string[]): ContractSnapshot => ({
  contract_id: DOOR_CONTRACT_ID,
  contract_version: '1',
  allowed_tools,
  approval_required: [],
  scope_restrictions: [],
  resolved_at: NOW,
});

const denialCode = (errors: readonly unknown[]): string | undefined => {
  const details = (errors[0] as RecipeError).details as {
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

describe('D-209 W3 — webhook is policy-gated', () => {
  it('DENIES a plain ingredient step absent from the door allowlist (the bypass)', async () => {
    // Pre-fix this returned success:true with the step dispatched — a vendor's
    // POST driving an ungranted write on the owner's warehouse.
    const manifest = buildManifest('ungranted-write', 'write');
    const recipe = buildRecipe('webhook-ungranted-write', manifest.slug);

    const result = await handleExecute(makeExecuteDeps(recipe, [manifest]), {
      recipe_id: recipe.recipe_id,
      trigger_source: 'webhook',
      execution_source: webhookSource,
      contract_snapshot: doorSnapshot(['some-other-ingredient']),
    });

    expect(result.success).toBe(false);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(true);
    expect(denialCode(result.errors)).toBe('tool_not_in_contract');
  });

  it('DENIES every dispatch when the door is revoked — the live kill-switch', async () => {
    // `buildWebhookContractSnapshot` yields `allowed_tools: []` for a dead door.
    // That kill-switch was inert until the channel was gated.
    const manifest = buildManifest('revoked-door-read', 'read');
    const recipe = buildRecipe('webhook-revoked-door', manifest.slug);

    const result = await handleExecute(makeExecuteDeps(recipe, [manifest]), {
      recipe_id: recipe.recipe_id,
      trigger_source: 'webhook',
      execution_source: webhookSource,
      contract_snapshot: doorSnapshot([]),
    });

    expect(result.success).toBe(false);
    expect(denialCode(result.errors)).toBe('tool_not_in_contract');
  });

  it('ADMITS a read the door actually granted — the gate narrows, it does not blanket-deny', async () => {
    // Over-denial guard: if this goes red the fix is refusing the ordinary
    // webhook path rather than closing the hole.
    const manifest = buildManifest('granted-read', 'read');
    const recipe = buildRecipe('webhook-granted-read', manifest.slug);

    const result = await handleExecute(makeExecuteDeps(recipe, [manifest]), {
      recipe_id: recipe.recipe_id,
      trigger_source: 'webhook',
      execution_source: webhookSource,
      contract_snapshot: doorSnapshot([manifest.slug]),
    });

    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
    expect(result.steps.map((step) => step.id)).toEqual(['call']);
  });

  it('a DOOR-LESS webhook source does not throw for a missing snapshot', async () => {
    // ⛔ The safety property that made gating this channel safe to land. The
    // runner builds a snapshot only when the source carries a `contract_id`; an
    // unstamped trigger row (pre-mint crash window, legacy row) carries none.
    // `evaluatePreflightAdmission` throws only when `executionSourceHasContract`,
    // so a door-less source cannot be broken by the gate turning on.
    const manifest = buildManifest('doorless-read', 'read');
    const recipe = buildRecipe('webhook-doorless', manifest.slug);
    const { contract_id: _omitted, ...doorless } = webhookSource as ExecutionSource & {
      contract_id?: string;
    };

    const result = await handleExecute(makeExecuteDeps(recipe, [manifest]), {
      recipe_id: recipe.recipe_id,
      trigger_source: 'webhook',
      execution_source: doorless as ExecutionSource,
    });

    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });
});
