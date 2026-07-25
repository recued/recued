import { describe, it, expect } from 'vitest';
import { parseRecipe, issuesBySeverity } from '../parse.js';
import type { RecipeDefinition } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const validRecipe: RecipeDefinition = {
  recipe_id: 'test-recipe-hubspot',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Test Recipe',
    description: 'A minimal valid recipe used for the parser tests.',
    author: 'recued-core',
    supported_platforms: ['hubspot'],
    variant_group: 'test-recipe',
    tags: ['test', 'parser', 'fixture'],
  },
  variables: { threshold: 7 },
  prefetch_steps: [
    { id: 'deal', ingredient: 'deal-reader-hubspot', input: {} },
  ],
  steps: [
    { id: 's1', transform: 'template', template: '{{step.deal}}' },
  ],
  output: {
    sidebar: [{ type: 'summary', source: 'step.s1' }],
  },
} as RecipeDefinition;

// ────────────────────────────────────────────────────────────────

describe('parseRecipe — success path', () => {
  it('valid recipe → ok: true with narrowed type', () => {
    const result = parseRecipe(validRecipe);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Type narrowing works — accessing RecipeDefinition fields compiles
      expect(result.recipe.recipe_id).toBe('test-recipe-hubspot');
      expect(result.recipe.metadata.name).toBe('Test Recipe');
    }
  });

  it('returned recipe is the same reference as input (no cloning)', () => {
    const result = parseRecipe(validRecipe);
    if (result.ok) expect(result.recipe).toBe(validRecipe);
  });

  it('preserves canonical output.render without reintroducing output.sidebar', () => {
    const render = [{ type: 'summary' as const, source: 'step.s1' }];
    const recipe = {
      ...validRecipe,
      output: { render },
    } as unknown as RecipeDefinition;

    const result = parseRecipe(recipe);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recipe).toBe(recipe);
      expect(result.recipe.output.render).toBe(render);
      expect(result.recipe.output.sidebar).toBeUndefined();
    }
  });

  it('normalizes legacy output.sidebar into canonical output.render', () => {
    const sidebar = [{ type: 'summary' as const, source: 'step.s1' }];
    const recipe = {
      ...validRecipe,
      output: { sidebar },
    };

    const result = parseRecipe(recipe);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recipe.output.render).toBe(sidebar);
      expect(result.recipe.output.sidebar).toBeUndefined();
    }
  });

  it('uses output.render when both render and sidebar are authored', () => {
    const render = [{ type: 'summary' as const, source: 'step.s1' }];
    const sidebar = [{ type: 'summary' as const, source: 'step.missing' }];
    const recipe = {
      ...validRecipe,
      output: { render, sidebar },
    } as unknown as RecipeDefinition;

    const result = parseRecipe(recipe);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issues.some((i) => i.code === 'output_sidebar_ignored')).toBe(true);
      expect(result.recipe.output.render).toBe(render);
      expect(result.recipe.output.sidebar).toBeUndefined();
    }
  });

  it('issues on success contain only warn + info, never error', () => {
    const result = parseRecipe(validRecipe);
    if (result.ok) {
      const errors = result.issues.filter((i) => i.severity === 'error');
      expect(errors).toEqual([]);
    }
  });

  it('surfaces warnings and info alongside the parsed recipe', () => {
    // This recipe has an unused variable → should produce an info/warn
    const withUnusedVar = {
      ...validRecipe,
      variables: { threshold: 7, unused_var: 42 },
    };
    const result = parseRecipe(withUnusedVar);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issues.some((i) => i.code === 'unused_variable')).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────

describe('parseRecipe — failure path', () => {
  it('null input → ok: false with errors', () => {
    const result = parseRecipe(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.severity === 'error')).toBe(true);
    }
  });

  it('array input → ok: false', () => {
    const result = parseRecipe([]);
    expect(result.ok).toBe(false);
  });

  it('empty object → ok: false with multiple missing-field errors', () => {
    const result = parseRecipe({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((i) => i.code);
      expect(codes).toContain('recipe_id_required');
      expect(codes).toContain('version_invalid');
    }
  });

  it('inherited top-level fields → ok: false', () => {
    const inherited = Object.create(validRecipe);

    const result = parseRecipe(inherited);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'inherited_field' && i.path === 'recipe_id')).toBe(true);
    }
  });

  it('non-enumerable inherited top-level fields → ok: false', () => {
    const proto = {};
    Object.defineProperty(proto, 'recipe_id', {
      value: validRecipe.recipe_id,
      enumerable: false,
    });
    const inherited = { ...validRecipe } as Record<string, unknown>;
    delete inherited.recipe_id;
    Object.setPrototypeOf(inherited, proto);

    const result = parseRecipe(inherited);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'inherited_field' && i.path === 'recipe_id')).toBe(true);
    }
  });

  it('inherited step fields → ok: false', () => {
    const inheritedStep = Object.create({ id: 's1', transform: 'template', template: 'x' });

    const result = parseRecipe({
      ...validRecipe,
      prefetch_steps: [],
      steps: [inheritedStep],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'inherited_field' && i.path === 'steps[0].id')).toBe(true);
      expect(result.issues.some((i) => i.code === 'inherited_field' && i.path === 'steps[0].transform')).toBe(true);
    }
  });

  it('inherited sparse array step entries → ok: false', () => {
    const steps = new Array(1);
    const proto = Object.create(Array.prototype);
    Object.defineProperty(proto, '0', {
      value: { id: 's1', transform: 'template', template: 'x' },
      enumerable: false,
    });
    Object.setPrototypeOf(steps, proto);

    const result = parseRecipe({
      ...validRecipe,
      prefetch_steps: [],
      steps,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'inherited_field' && i.path === 'steps[0]')).toBe(true);
    }
  });

  it('cyclic recipe-shaped input → ok: false instead of throwing', () => {
    const cyclic = {
      ...validRecipe,
      metadata: { ...validRecipe.metadata },
    } as Record<string, unknown>;
    (cyclic.metadata as Record<string, unknown>).self = cyclic;

    let result: ReturnType<typeof parseRecipe> | undefined;
    expect(() => {
      result = parseRecipe(cyclic);
    }).not.toThrow();

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.issues.some((i) => i.code === 'cyclic_reference' && i.path === 'metadata.self')).toBe(true);
    }
  });

  it('recipe with bad recipe_id → ok: false', () => {
    const result = parseRecipe({
      ...validRecipe,
      recipe_id: 'Bad Name',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'recipe_id_has_whitespace')).toBe(true);
    }
  });

  it('forward step reference → ok: false', () => {
    const result = parseRecipe({
      ...validRecipe,
      steps: [
        { id: 's1', transform: 'template', template: '{{step.later}}' },
        { id: 'later', transform: 'template', template: 'x' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'forward_step_ref')).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Discriminated union narrows correctly
// ────────────────────────────────────────────────────────────────

describe('parseRecipe — discriminated union narrowing', () => {
  it('`result.recipe` is only accessible inside the ok branch', () => {
    const result = parseRecipe(validRecipe);
    // This is primarily a TypeScript compile-time check. At runtime we
    // just verify the branching works.
    if (result.ok) {
      // @ts-expect-no-error — .recipe available
      expect(result.recipe).toBeDefined();
    } else {
      // @ts-expect-no-error — .issues available, .recipe is not
      expect('recipe' in result).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// issuesBySeverity helper
// ────────────────────────────────────────────────────────────────

describe('issuesBySeverity', () => {
  it('filters by error severity on failure result', () => {
    const result = parseRecipe({});
    const errors = issuesBySeverity(result, 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((i) => i.severity === 'error')).toBe(true);
  });

  it('filters warn and info on success result', () => {
    const result = parseRecipe({
      ...validRecipe,
      variables: { threshold: 7, unused: 1 },
    });
    if (result.ok) {
      const warns = issuesBySeverity(result, 'warn');
      const infos = issuesBySeverity(result, 'info');
      // unused_variable is a warn; there may be other infos
      expect(warns.concat(infos).some((i) => i.code === 'unused_variable')).toBe(true);
    }
  });

  it('returns empty array when no issues match', () => {
    const result = parseRecipe(validRecipe);
    if (result.ok) {
      const errors = issuesBySeverity(result, 'error');
      expect(errors).toEqual([]);
    }
  });
});
