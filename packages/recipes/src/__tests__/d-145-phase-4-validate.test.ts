/** D-145 PA4 — Codex P2 fold: recipe-validator scope set widened with
 *  the four work-entity scopes (`task` / `note` / `commitment` /
 *  `project`).
 *
 *  Pre-fold the validator's `SHAPE_A_DATA_SCOPES` only carried `mail` /
 *  `contact` / `calendar` / `file`, so a recipe referencing a
 *  work-entity enrichment ref triggered the "Shape A interpretation"
 *  fallback path which fails to match the topic against any registered
 *  scope. PA9 producers will register against `task` / `note` /
 *  `commitment` / `project`; this test guards the substrate side. */

import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../validate.js';
import type { RecipeDefinition } from '@recued/contracts';

const base: RecipeDefinition = {
  recipe_id: 'd-145-p4-validate',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-145 P4 validate',
    description: 'Recipe under test for the D-145 PA4 enrichment scope widening.',
    author: 'recued',
    supported_platforms: ['gmail'],
    tags: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'noop', transform: 'concat', values: ['ok'] }],
  output: { sidebar: [{ type: 'summary', source: 'step.noop' }] },
};

const codes = (result: { issues: Array<{ code: string }> }): string[] =>
  result.issues.map((i) => i.code);

const recipeWithRef = (ref: string): RecipeDefinition => ({
  ...base,
  steps: [{ id: 's', transform: 'concat', values: [`prefix-${ref}`] }],
});

describe('D-145 PA4 — work-entity enrichment scope widening', () => {
  it('does NOT raise enrichment_scope_unsupported on a `data.enrichment.task.<id>` bag-form ref', () => {
    const recipe = recipeWithRef('{{data.enrichment.task.task_abc123}}');
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('does NOT raise enrichment_scope_unsupported on a `data.enrichment.note.<id>` ref', () => {
    const recipe = recipeWithRef('{{data.enrichment.note.note_abc123}}');
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('does NOT raise enrichment_scope_unsupported on a `data.enrichment.commitment.<id>` ref', () => {
    const recipe = recipeWithRef('{{data.enrichment.commitment.commit_abc123}}');
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });

  it('does NOT raise enrichment_scope_unsupported on a `data.enrichment.project.<id>` ref', () => {
    const recipe = recipeWithRef('{{data.enrichment.project.proj_abc123}}');
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('enrichment_scope_unsupported');
  });
});
