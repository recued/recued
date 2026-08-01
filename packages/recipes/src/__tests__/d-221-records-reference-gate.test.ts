import { describe, expect, it } from 'vitest';

import type { RecipeDefinition } from '@recued/contracts';
import { validateRecipe } from '../validate.js';

const recipe = (value: string): RecipeDefinition => ({
  recipe_id: 'records-ref-probe',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Records ref probe',
    description: 'Proves Records cannot be read through the generic recipe namespace.',
    author: 'recued-core',
    supported_platforms: [],
    tags: ['records', 'reference', 'gate'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'value', transform: 'coalesce', values: [value, null] } as never],
  output: { render: [] },
});

describe('D-221 Records is not a recipe data namespace', () => {
  it('rejects every data.records subpath while leaving ordinary data collections alone', () => {
    const rejected = validateRecipe(recipe('{{data.records.publisher.pack.job.1}}'));
    expect(rejected.valid).toBe(false);
    expect(rejected.issues.map((issue) => issue.code)).toContain('records_data_ref_forbidden');

    const ordinary = validateRecipe(recipe('{{data.contact.person_1.name}}'));
    expect(ordinary.issues.map((issue) => issue.code)).not.toContain('records_data_ref_forbidden');
  });
});
