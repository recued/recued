/** D-157 P1 slice 2 - policy gate handling for ask verdicts.
 *
 *  `gateRecipeAgainstPolicy` is a static denial walk. An `ask` verdict
 *  means the step is admissible but needs runtime preflight approval, so
 *  it must not be collected as a policy-gate denial.
 */

import { describe, expect, it } from 'vitest';

import type {
  ExecutionSource,
  IngredientManifest,
  RecipeDefinition,
} from '@recued/contracts';

import { gateRecipeAgainstPolicy } from '../policy-gate.js';

const userSource: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'local',
  client_token_id: 'tok-test',
};

const buildManifest = (
  slug: string,
  kind: IngredientManifest['kind'],
  risk_tier: IngredientManifest['risk_tier'],
): IngredientManifest => ({
  slug,
  name: slug,
  description: `Test manifest for ${slug}`,
  author: 'test',
  kind,
  risk_tier,
  version: 1,
  category: 'data',
  input: {},
  output: { data: 'data' },
}) as unknown as IngredientManifest;

const buildRecipe = (
  overrides: Partial<RecipeDefinition> = {},
): RecipeDefinition => ({
  recipe_id: 'd-157-policy-gate-ask-test',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-157 policy gate ask test',
    description: 'Minimal recipe fixture for D-157 ask verdict coverage.',
    author: 'test',
    supported_platforms: ['test'],
    tags: ['test', 'policy', 'ask'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  ...overrides,
}) as RecipeDefinition;

const ingredientStep = (
  id: string,
  ingredient: string,
): RecipeDefinition['steps'][number] => ({ id, ingredient, input: {} });

const manifestGetter = (
  ...manifests: IngredientManifest[]
): ((slug: string) => IngredientManifest | undefined) => {
  const bySlug = new Map(manifests.map((m) => [m.slug, m]));
  return (slug) => bySlug.get(slug);
};

describe('D-157 P1 - gateRecipeAgainstPolicy ask verdicts', () => {
  it('does not collect an ask-tier user step as a denial', () => {
    const recipe = buildRecipe({
      steps: [ingredientStep('needs_approval', 'danger-storage')],
    });

    const result = gateRecipeAgainstPolicy(
      recipe,
      userSource,
      manifestGetter(buildManifest('danger-storage', 'storage', 'destructive')),
    );

    expect(result).toEqual({ admit: true, denials: [] });
  });

  it('keeps only the denied step when a recipe mixes ask (destructive) and deny (manifest-miss) outcomes', () => {
    // D-187 slice 4 — the destructive step is now an op-risk ALWAYS-ASK (it falls through
    // the static walk, which records only `deny`); the coarse kind-deny is retired, so the
    // remaining static deny is the manifest-miss fail-closed. The "ask falls through, only
    // deny is recorded" mechanic is unchanged.
    const recipe = buildRecipe({
      steps: [
        ingredientStep('needs_approval', 'danger-storage'),
        ingredientStep('denied_missing', 'unregistered-tool'),
      ],
    });

    const result = gateRecipeAgainstPolicy(
      recipe,
      userSource,
      manifestGetter(buildManifest('danger-storage', 'storage', 'destructive')),
    );

    expect(result.admit).toBe(false);
    expect(result.denials).toHaveLength(1);
    expect(result.denials.map((denial) => denial.step_id)).toEqual(['denied_missing']);
    expect(result.denials[0]).toMatchObject({
      step_id: 'denied_missing',
      ingredient: 'unregistered-tool',
      phase: 'sequential',
      decision: {
        verdict: 'deny',
        code: 'kind_not_allowed',
      },
    });
  });
});
