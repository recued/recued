/** D-120 Phase 4 — validator + permission gating tests.
 *
 *  Covers:
 *    - `requires` field shape (array, string entries, dedupe, unknown soft-warn)
 *    - `read_memory` permission hard error when `data.memory.*` referenced
 *      without declaring the permission
 *    - `data.audit.*` deprecation soft-warn (alias path)
 *    - Both names accepted at the validator (no `unknown_namespace` error)
 *    - Permission-only happy path (declared + referenced) is valid
 *    - `extractContextRecipeRefs` static analysis: empty / nested /
 *      cross-step output / sorted dedup
 */

import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../validate.js';
import { extractContextRecipeRefs } from '../context-recipe-refs.js';
import type { RecipeDefinition } from '@recued/contracts';

const baseRecipe = (overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'sample-recipe',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Sample Recipe',
    author: 'recued-core',
    description: 'A long enough description to skip the `description_thin` info nudge for tests.',
    supported_platforms: [],
    tags: ['memory', 'audit', 'test'],
  } as RecipeDefinition['metadata'],
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'noop',
      transform: 'count',
      input: [] as unknown,
    } as unknown as RecipeDefinition['steps'][number],
  ],
  output: { sidebar: [] },
  ...overrides,
});

const findIssue = (
  result: ReturnType<typeof validateRecipe>,
  code: string,
) => result.issues.find((i) => i.code === code);

describe('D-120 Phase 4 — `requires` field shape', () => {
  it('accepts a recipe with no `requires` field', () => {
    const r = baseRecipe();
    const result = validateRecipe(r);
    expect(findIssue(result, 'requires_shape')).toBeUndefined();
    expect(findIssue(result, 'requires_entry_shape')).toBeUndefined();
  });

  it('accepts an empty `requires` array', () => {
    const r = baseRecipe({ requires: [] });
    const result = validateRecipe(r);
    expect(findIssue(result, 'requires_shape')).toBeUndefined();
  });

  it('flags `requires` value when not an array', () => {
    const r = { ...baseRecipe(), requires: 'read_memory' as unknown as string[] };
    const result = validateRecipe(r);
    expect(findIssue(result, 'requires_shape')).toBeDefined();
  });

  it('flags non-string entries inside `requires`', () => {
    const r = baseRecipe({ requires: ['read_memory', 7 as unknown as string] });
    const result = validateRecipe(r);
    expect(findIssue(result, 'requires_entry_shape')).toBeDefined();
  });

  it('flags empty-string entries inside `requires`', () => {
    const r = baseRecipe({ requires: ['', 'read_memory'] });
    const result = validateRecipe(r);
    expect(findIssue(result, 'requires_entry_shape')).toBeDefined();
  });

  it('warns on duplicate entries inside `requires`', () => {
    const r = baseRecipe({ requires: ['read_memory', 'read_memory'] });
    const result = validateRecipe(r);
    expect(findIssue(result, 'requires_duplicate')).toBeDefined();
  });

  it('soft-warns on unknown permission slugs (forward-compat)', () => {
    const r = baseRecipe({ requires: ['read_memory', 'do_something_invented'] });
    const result = validateRecipe(r);
    const warn = findIssue(result, 'requires_unknown');
    expect(warn?.severity).toBe('warn');
    expect(warn?.message).toContain('do_something_invented');
  });
});

describe('D-120 Phase 4 — `read_memory` permission gating', () => {
  it('hard-errors when data.memory.* is referenced without `read_memory`', () => {
    const r = baseRecipe({
      steps: [
        {
          id: 'lookup',
          transform: 'count',
          input: '{{data.memory.run_42}}',
        } as unknown as RecipeDefinition['steps'][number],
      ],
    });
    const result = validateRecipe(r);
    const err = findIssue(result, 'memory_read_permission_missing');
    expect(err?.severity).toBe('error');
    expect(err?.message).toContain('read_memory');
  });

  it('hard-errors on the data.audit.* alias path too', () => {
    const r = baseRecipe({
      steps: [
        {
          id: 'lookup',
          transform: 'count',
          input: '{{data.audit.run_42}}',
        } as unknown as RecipeDefinition['steps'][number],
      ],
    });
    const result = validateRecipe(r);
    expect(findIssue(result, 'memory_read_permission_missing')).toBeDefined();
  });

  it('passes when `read_memory` is declared alongside the reference', () => {
    const r = baseRecipe({
      requires: ['read_memory'],
      steps: [
        {
          id: 'lookup',
          transform: 'count',
          input: '{{data.memory.run_42}}',
        } as unknown as RecipeDefinition['steps'][number],
      ],
    });
    const result = validateRecipe(r);
    expect(findIssue(result, 'memory_read_permission_missing')).toBeUndefined();
  });

  it('does not flag recipes that only read warehouse collections', () => {
    const r = baseRecipe({
      steps: [
        {
          id: 'lookup',
          transform: 'count',
          input: '{{data.mail.msg-42.subject}}',
        } as unknown as RecipeDefinition['steps'][number],
      ],
    });
    const result = validateRecipe(r);
    expect(findIssue(result, 'memory_read_permission_missing')).toBeUndefined();
  });

  it('fires only once per recipe even with many memory refs', () => {
    const r = baseRecipe({
      steps: [
        {
          id: 'a',
          transform: 'count',
          input: '{{data.memory.run_1}}',
        } as unknown as RecipeDefinition['steps'][number],
        {
          id: 'b',
          transform: 'count',
          input: '{{data.memory.run_2}}',
        } as unknown as RecipeDefinition['steps'][number],
        {
          id: 'c',
          transform: 'count',
          input: '{{data.audit.run_3}}',
        } as unknown as RecipeDefinition['steps'][number],
      ],
    });
    const result = validateRecipe(r);
    const matches = result.issues.filter(
      (i) => i.code === 'memory_read_permission_missing',
    );
    expect(matches).toHaveLength(1);
  });
});

describe('D-120 Phase 4 — `data.audit.*` deprecation alias', () => {
  it('emits `data_audit_deprecated` warning on audit alias use', () => {
    const r = baseRecipe({
      requires: ['read_memory'],
      steps: [
        {
          id: 'lookup',
          transform: 'count',
          input: '{{data.audit.run_42}}',
        } as unknown as RecipeDefinition['steps'][number],
      ],
    });
    const result = validateRecipe(r);
    const warn = findIssue(result, 'data_audit_deprecated');
    expect(warn?.severity).toBe('warn');
    expect(warn?.message).toContain('data.memory');
  });

  it('does NOT emit the deprecation warning on data.memory.* references', () => {
    const r = baseRecipe({
      requires: ['read_memory'],
      steps: [
        {
          id: 'lookup',
          transform: 'count',
          input: '{{data.memory.run_42}}',
        } as unknown as RecipeDefinition['steps'][number],
      ],
    });
    const result = validateRecipe(r);
    expect(findIssue(result, 'data_audit_deprecated')).toBeUndefined();
  });

  it('fires once even when the recipe has multiple data.audit.* refs', () => {
    const r = baseRecipe({
      requires: ['read_memory'],
      steps: [
        {
          id: 'a',
          transform: 'count',
          input: '{{data.audit.run_1}}',
        } as unknown as RecipeDefinition['steps'][number],
        {
          id: 'b',
          transform: 'count',
          input: '{{data.audit.run_2}}',
        } as unknown as RecipeDefinition['steps'][number],
      ],
    });
    const result = validateRecipe(r);
    const warns = result.issues.filter(
      (i) => i.code === 'data_audit_deprecated',
    );
    expect(warns).toHaveLength(1);
  });

  it('does not flag data.memory.* / data.audit.* as `unknown_namespace`', () => {
    // Pre-D-120 these refs hit the validator's unknown-namespace branch
    // because no explicit handler existed. After Phase 4 both are
    // legal sub-namespaces under `data.*`.
    const r = baseRecipe({
      requires: ['read_memory'],
      steps: [
        {
          id: 'a',
          transform: 'count',
          input: '{{data.memory.run_1}}',
        } as unknown as RecipeDefinition['steps'][number],
      ],
    });
    const result = validateRecipe(r);
    expect(findIssue(result, 'unknown_namespace')).toBeUndefined();
  });
});

describe('D-120 Phase 4 — `extractContextRecipeRefs` static analyzer', () => {
  const recipeWith = (
    refs: string[],
  ): RecipeDefinition => baseRecipe({
    steps: refs.map((ref, i) => ({
      id: `step_${i}`,
      transform: 'count',
      input: ref,
    } as unknown as RecipeDefinition['steps'][number])),
  });

  it('returns empty list for recipes with no `context.recipe.*` refs', () => {
    const r = baseRecipe();
    expect(extractContextRecipeRefs(r)).toEqual([]);
  });

  it('extracts a single step id from a basic ref', () => {
    const r = recipeWith(['{{context.recipe.pipeline_total}}']);
    expect(extractContextRecipeRefs(r)).toEqual(['pipeline_total']);
  });

  it('extracts multiple step ids and returns them sorted (stable hash)', () => {
    const r = recipeWith([
      '{{context.recipe.pipeline_score}}',
      '{{context.recipe.deal_count}}',
      '{{context.recipe.stale_count}}',
    ]);
    expect(extractContextRecipeRefs(r)).toEqual([
      'deal_count',
      'pipeline_score',
      'stale_count',
    ]);
  });

  it('dedupes the same step id referenced from multiple steps', () => {
    const r = recipeWith([
      '{{context.recipe.pipeline_total}}',
      '{{context.recipe.pipeline_total}}',
      '{{context.recipe.pipeline_total}}',
    ]);
    expect(extractContextRecipeRefs(r)).toEqual(['pipeline_total']);
  });

  it('collapses nested-field refs onto the root step id', () => {
    // `{{context.recipe.deal.amount}}` → snapshots `deal` whole; the
    // resolver walks `.amount` against the stored value at run start.
    const r = recipeWith([
      '{{context.recipe.deal.amount}}',
      '{{context.recipe.deal.stage}}',
    ]);
    expect(extractContextRecipeRefs(r)).toEqual(['deal']);
  });

  it('ignores prototype-sensitive root step ids', () => {
    const r = recipeWith([
      '{{context.recipe.__proto__.x}}',
      '{{context.recipe.constructor.y}}',
      '{{context.recipe.prototype.z}}',
      '{{context.recipe.safe.value}}',
    ]);
    expect(extractContextRecipeRefs(r)).toEqual(['safe']);
  });

  it('ignores other context.* fields (server / event / page)', () => {
    const r = recipeWith([
      '{{context.server.available}}',
      '{{context.event.payload}}',
      '{{context.caller.contract_id}}',
      '{{context.url}}',
    ]);
    expect(extractContextRecipeRefs(r)).toEqual([]);
  });

  it('walks output.sidebar source fields too', () => {
    const r = baseRecipe({
      steps: [
        {
          id: 'note',
          transform: 'count',
          input: '{{context.recipe.score_breakdown}}',
        } as unknown as RecipeDefinition['steps'][number],
      ],
      output: {
        sidebar: [
          { type: 'text', source: 'step.note' },
        ],
      },
    });
    expect(extractContextRecipeRefs(r)).toEqual(['score_breakdown']);
  });

  it('returns deterministic output across reinvocations', () => {
    const r = recipeWith([
      '{{context.recipe.b}}',
      '{{context.recipe.a}}',
      '{{context.recipe.c}}',
    ]);
    const first = extractContextRecipeRefs(r);
    const second = extractContextRecipeRefs(r);
    expect(first).toEqual(second);
  });
});
