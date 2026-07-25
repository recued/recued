/** D-166 / D-187 slice 5: the server policy static walk (`gateRecipeAgainstPolicy`).
 *
 *  The `(channel × actor)` policy_matrix baseline + the `scan` param it read are
 *  RETIRED (slice 4 moved approval to op-risk × stage-trust; slice 5 deleted the dead
 *  `scan` / overlay-cell args). The static walk now denies only on a missing manifest;
 *  a read op admits for an owner/automation (contract-less) source. This case pins that
 *  admit. The former "a seeded baseline cell tightens / an overlay row is ignored" cases
 *  are gone — there is no scan param to seed a tightening cell through, so the guarantee
 *  is now structural. */

import { describe, expect, it } from 'vitest';

import type {
  ExecutionSource,
  IngredientManifest,
  RecipeDefinition,
} from '@recued/contracts';

import { gateRecipeAgainstPolicy } from '../policy-gate.js';

const scheduleSource: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 9 * * *',
  source_recipe: 'daily-briefing',
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
}) as IngredientManifest;

const buildRecipe = (
  overrides: Partial<RecipeDefinition> = {},
): RecipeDefinition => ({
  recipe_id: 'd-166-policy-gate-matrix-overlay-test',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-166 policy gate matrix overlay test',
    description: 'Minimal recipe fixture for D-166 policy_matrix overlay coverage.',
    author: 'test',
    supported_platforms: ['test'],
    tags: ['test', 'policy', 'gate', 'd-166'],
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

describe('D-187 slice 5: gateRecipeAgainstPolicy static walk (matrix baseline retired)', () => {
  it('admits a schedule/system recipe without a scan (in-code baseline fallback) when the baseline allows the tool', () => {
    const recipe = buildRecipe({
      steps: [ingredientStep('read_http', 'safe-http')],
    });
    const manifest = buildManifest('safe-http', 'http', 'read');

    const result = gateRecipeAgainstPolicy(
      recipe,
      scheduleSource,
      manifestGetter(manifest),
    );

    expect(result).toEqual({ admit: true, denials: [] });
  });
});
