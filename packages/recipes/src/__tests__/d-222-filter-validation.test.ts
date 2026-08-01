import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import { validateRecipe } from '../validate.js';

const baseRecipe = (): RecipeDefinition => ({
  recipe_id: 'd-222-filter-validation',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'D-222 filter validation',
    description: 'Exercises the authored output filter declaration boundary.',
    author: 'test',
    supported_platforms: [],
  },
  variables: {
    status: { label: 'Status', type: 'enum', options: ['open', 'closed'], default: 'open' },
    unknown: { label: 'Future input', type: 'future_widget', default: 'x' } as never,
    cursor: '',
    secret: { label: 'Secret', type: 'secret' },
    oauth: { label: 'OAuth', type: 'oauth', provider: 'test' },
    bare: 10,
    required_compatibility: null,
  },
  prefetch_steps: [],
  steps: [{ id: 'rows', transform: 'coalesce', values: [{ rows: [] }] }],
  output: {
    render: [{
      type: 'filter',
      source: 'step.rows',
      label: 'Filter rows',
      fields: ['status', 'unknown'],
      hidden: ['cursor'],
      submit: 'Search',
    }],
  },
});

const errors = (recipe: unknown): string[] =>
  validateRecipe(recipe).issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.code);

const withSection = (section: Record<string, unknown>): RecipeDefinition => {
  const recipe = baseRecipe();
  recipe.output = { render: [section as never] };
  return recipe;
};

describe('D-222 object-form variables', () => {
  it('admits a complete labeled hint, including an unknown non-empty type', () => {
    expect(errors(baseRecipe())).toEqual([]);
  });

  it.each([
    [{ type: 'text', default: '' }, 'label'],
    [{ label: 'Query', default: '' }, 'type'],
    [{ label: ' ', type: 'text' }, 'label'],
    [{ label: 'Query', type: '' }, 'type'],
  ])('refuses a malformed object-form declaration missing %s', (declaration, field) => {
    const recipe = baseRecipe() as unknown as { variables: Record<string, unknown> };
    recipe.variables.bad = declaration;
    const issue = validateRecipe(recipe).issues.find((row) =>
      row.code === 'variable_hint_invalid' && row.path === `variables.bad.${field}`,
    );
    expect(issue).toBeDefined();
  });

  it('validates the known optional ValueHint members at runtime', () => {
    const recipe = baseRecipe() as unknown as { variables: Record<string, unknown> };
    recipe.variables.bad = {
      label: 'Bad',
      type: 'enum',
      optional: 'yes',
      options: [1],
      help: 1,
      scopes: ['ok', ''],
    };
    const paths = validateRecipe(recipe).issues
      .filter((row) => row.code === 'variable_hint_invalid')
      .map((row) => row.path);
    expect(paths).toEqual(expect.arrayContaining([
      'variables.bad.optional',
      'variables.bad.options',
      'variables.bad.help',
      'variables.bad.scopes',
    ]));
  });
});

describe('D-222 authored filter declaration', () => {
  const canonical = (): Record<string, unknown> => ({
    type: 'filter',
    source: 'step.rows',
    fields: ['status'],
    hidden: ['cursor'],
    submit: 'Search',
  });

  it('admits exactly the filter-specific authored members', () => {
    expect(errors(withSection(canonical()))).toEqual([]);
  });

  it.each([
    [{ ...canonical(), fields: 'status' }, 'filter_fields_shape'],
    [{ ...canonical(), hidden: 'cursor' }, 'filter_hidden_shape'],
    [{ ...canonical(), submit: '' }, 'filter_submit_invalid'],
    [{ ...canonical(), fields: ['status', 'status'] }, 'filter_variable_duplicate'],
    [{ ...canonical(), hidden: ['cursor', 'cursor'] }, 'filter_variable_duplicate'],
    [{ ...canonical(), fields: ['status'], hidden: ['status'] }, 'filter_fields_hidden_overlap'],
    [{ ...canonical(), fields: ['missing'] }, 'filter_variable_undeclared'],
    [{ ...canonical(), hidden: ['missing'] }, 'filter_variable_undeclared'],
    [{ ...canonical(), fields: ['bare'] }, 'filter_field_not_labeled'],
    [{ ...canonical(), fields: ['required_compatibility'] }, 'filter_field_not_labeled'],
    [{ ...canonical(), fields: ['secret'] }, 'filter_field_credential_ineligible'],
    [{ ...canonical(), fields: ['oauth'] }, 'filter_field_credential_ineligible'],
    [{ ...canonical(), hidden: ['secret'] }, 'filter_hidden_credential_ineligible'],
    [{ ...canonical(), hidden: ['oauth'] }, 'filter_hidden_credential_ineligible'],
  ])('refuses the invalid declaration %#', (section, code) => {
    expect(errors(withSection(section))).toContain(code);
  });

  it('keeps filter-only members behind the filter discriminator', () => {
    expect(errors(withSection({
      type: 'table',
      source: 'step.rows',
      fields: ['status'],
      hidden: [],
      submit: 'Search',
    }))).toContain('output_section_unknown_key');
  });
});
