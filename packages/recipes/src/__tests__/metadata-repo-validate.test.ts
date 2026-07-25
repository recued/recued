/** v3 `metadata.repo` — structural validation.
 *
 *  Optional author's source-repo URL; https-only when present. Entered
 *  at publish time (marketplace publish flow), display-only in Kitchen.
 */

import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { validateRecipe } from '../validate.js';

const baseRecipe = (metadataOverrides: Record<string, unknown> = {}): RecipeDefinition => ({
  recipe_id: 'sample-recipe',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Sample Recipe',
    author: 'recued-core',
    description: 'A long enough description to skip the `description_thin` info nudge for tests.',
    supported_platforms: [],
    tags: ['memory', 'audit', 'test'],
    ...metadataOverrides,
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
});

const findIssue = (
  result: ReturnType<typeof validateRecipe>,
  code: string,
) => result.issues.find((i) => i.code === code);

describe('v3 — metadata.repo validation', () => {
  it('accepts a recipe without repo', () => {
    const result = validateRecipe(baseRecipe());
    expect(findIssue(result, 'repo_invalid')).toBeUndefined();
  });

  it('accepts an https repo URL', () => {
    const result = validateRecipe(
      baseRecipe({ repo: 'https://github.com/recued/sample-recipe' }),
    );
    expect(findIssue(result, 'repo_invalid')).toBeUndefined();
  });

  it('rejects an http repo URL', () => {
    const result = validateRecipe(
      baseRecipe({ repo: 'http://github.com/recued/sample-recipe' }),
    );
    expect(findIssue(result, 'repo_invalid')).toBeDefined();
  });

  it('rejects a non-URL repo value', () => {
    const result = validateRecipe(baseRecipe({ repo: 'not a url' }));
    expect(findIssue(result, 'repo_invalid')).toBeDefined();
  });
});
