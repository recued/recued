/** D-119 Phase 2 — `parseBundle` typed validator.
 *
 *  Covers:
 *    - top-level shape (object / non-object / array)
 *    - bundle_version recognition (1 / unknown)
 *    - signature shape gate (without crypto verify — that's Phase 1's
 *      `verifyBundleSignature`, tested separately)
 *    - recipe inner-validation pass-through with prefixed paths
 *    - ingredients inner-validation pass-through with `[idx]` paths
 *    - bare-recipe auto-wrap (back-compat with legacy URL-paste flow)
 */

import { describe, it, expect } from 'vitest';

import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { parseBundle } from '../parse-bundle.js';

const validRecipe: RecipeDefinition = {
  recipe_id: 'detect-deal-risk-hubspot',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Detect Deal Risk',
    description: 'Flag deals at risk of slipping.',
    author: 'recued-core',
    supported_platforms: ['hubspot'],
    tags: ['hubspot', 'sales', 'crm'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'noop', transform: 'to_list', input: 'x' } as unknown as RecipeDefinition['steps'][number],
  ],
  output: { sidebar: [] },
};

const validIngredient: IngredientManifest = {
  slug: 'deal-reader-hubspot',
  name: 'Deal Reader (HubSpot)',
  description: 'Reads deals from HubSpot.',
  author: 'recued-core',
  kind: 'http',
  category: 'data',
  risk_tier: 'read',
  input: { url: 'https://api.hubapi.com/crm/v3/objects/deals' },
  output: { 'deals': 'results' },
};

describe('parseBundle — top-level shape', () => {
  it('rejects null', () => {
    const r = parseBundle(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].code).toBe('bundle_not_object');
  });

  it('rejects an array (not an object)', () => {
    const r = parseBundle([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].code).toBe('bundle_not_object');
  });

  it('rejects a primitive', () => {
    const r = parseBundle(42);
    expect(r.ok).toBe(false);
  });

  it('accepts a wrapped bundle with just `recipe`', () => {
    const r = parseBundle({ recipe: validRecipe });
    expect(r.ok).toBe(true);
  });

  it('accepts a fully-populated wrapped bundle', () => {
    const r = parseBundle({
      bundle_version: 1,
      recipe: validRecipe,
      ingredients: [validIngredient],
    });
    expect(r.ok).toBe(true);
  });

  it('normalizes wrapped bundles to own envelope fields only', () => {
    const input = Object.create({
      bundle_version: 99,
      ingredients: ['inherited'],
      signature: { algorithm: '', publisher_pubkey: '', signature: '' },
    }) as Record<string, unknown>;
    input.recipe = validRecipe;

    const r = parseBundle(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.prototype.hasOwnProperty.call(r.recipe, 'recipe')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(r.recipe, 'bundle_version')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r.recipe, 'ingredients')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r.recipe, 'signature')).toBe(false);
    }
  });
});

describe('parseBundle — bundle_version', () => {
  it('rejects an unknown bundle_version', () => {
    const r = parseBundle({ bundle_version: 99, recipe: validRecipe });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.issues.map((i) => i.code);
      expect(codes).toContain('bundle_version_unknown');
    }
  });

  it('accepts an absent bundle_version', () => {
    const r = parseBundle({ recipe: validRecipe });
    expect(r.ok).toBe(true);
  });
});

describe('parseBundle — signature structural shape', () => {
  it('rejects a signature missing algorithm / pubkey / signature', () => {
    const r = parseBundle({
      recipe: validRecipe,
      signature: { algorithm: '', publisher_pubkey: '', signature: '' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.issues.map((i) => i.code);
      expect(codes).toContain('signature_algorithm_required');
      expect(codes).toContain('signature_pubkey_required');
      expect(codes).toContain('signature_value_required');
    }
  });

  it('accepts a signature with all three fields', () => {
    const r = parseBundle({
      recipe: validRecipe,
      signature: { algorithm: 'ed25519', publisher_pubkey: 'AAAA', signature: 'BBBB' },
    });
    expect(r.ok).toBe(true);
  });
});

describe('parseBundle — recipe pass-through', () => {
  it('forwards recipe-validator errors with `recipe.` path prefix', () => {
    const broken = { ...validRecipe, recipe_id: '' };
    const r = parseBundle({ recipe: broken });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const recipePathIssue = r.issues.find((i) => i.path.startsWith('recipe.'));
      expect(recipePathIssue).toBeTruthy();
    }
  });

  it('rejects when recipe field is missing entirely', () => {
    const r = parseBundle({ ingredients: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.issues.map((i) => i.code);
      expect(codes).toContain('bundle_recipe_required');
    }
  });

  it('rejects inherited recipe fields', () => {
    const r = parseBundle(Object.create({ recipe: validRecipe }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.issues.map((i) => i.code);
      expect(codes).toContain('bundle_recipe_required');
    }
  });
});

describe('parseBundle — ingredients pass-through', () => {
  it('rejects ingredients that are not an array', () => {
    const r = parseBundle({ recipe: validRecipe, ingredients: 'not-an-array' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.issues.map((i) => i.code);
      expect(codes).toContain('ingredients_not_array');
    }
  });

  it('forwards ingredient-validator errors with `ingredients[idx].` path prefix', () => {
    const broken = { ...validIngredient, slug: '' };
    const r = parseBundle({ recipe: validRecipe, ingredients: [validIngredient, broken] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const path = r.issues.find((i) => i.path.startsWith('ingredients[1]'))?.path;
      expect(path).toBeDefined();
      expect(path).toMatch(/^ingredients\[1\]/);
    }
  });

  it('accepts an empty ingredients array', () => {
    const r = parseBundle({ recipe: validRecipe, ingredients: [] });
    expect(r.ok).toBe(true);
  });
});

describe('parseBundle — bare-recipe auto-wrap', () => {
  it('wraps a bare RecipeDefinition (back-compat with legacy URL-paste flow)', () => {
    const r = parseBundle(validRecipe);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recipe.recipe).toEqual(validRecipe);
  });

  it('rejects inherited bare-recipe marker fields', () => {
    const r = parseBundle(Object.create({ recipe_id: validRecipe.recipe_id, steps: validRecipe.steps }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.issues.map((i) => i.code);
      expect(codes).toContain('bundle_recipe_required');
    }
  });

  it('rejects a non-recipe non-bundle object', () => {
    const r = parseBundle({ name: 'not-a-recipe', version: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.issues.map((i) => i.code);
      expect(codes).toContain('bundle_recipe_required');
    }
  });
});
