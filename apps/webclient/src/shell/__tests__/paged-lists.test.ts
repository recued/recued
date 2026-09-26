/** `paged-lists.ts` — the webclient's whole-list reads over the paged rpcs.
 *  The paging rules themselves are pinned in contracts' `list-page.test.ts`;
 *  this pins what each helper sends and how it reads each rpc's own row key. */

import { describe, expect, it } from 'vitest';
import type { ListPageRequest } from '@recued/contracts';

import { hasAnyRecipe, listAllRecipes, listAllTools } from '../paged-lists.js';

describe('listAllRecipes', () => {
  it('follows next_cursor and returns every row under `recipes`', async () => {
    const sent: ListPageRequest[] = [];
    const result = await listAllRecipes<{ recipe_id: string }>(async (request) => {
      sent.push(request);
      return request.cursor === undefined
        ? { recipes: [{ recipe_id: 'a' }], next_cursor: 'c1', total: 2 }
        : { recipes: [{ recipe_id: 'b' }], next_cursor: null, total: 2 };
    });
    expect(result).toEqual({ recipes: [{ recipe_id: 'a' }, { recipe_id: 'b' }] });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.cursor).toBe('c1');
  });

  it('takes an older server\'s whole-list answer as complete', async () => {
    let calls = 0;
    const result = await listAllRecipes(async () => {
      calls += 1;
      return { recipes: ['a', 'b', 'c'] };
    });
    expect(result).toEqual({ recipes: ['a', 'b', 'c'] });
    expect(calls).toBe(1);
  });
});

describe('listAllTools', () => {
  it('follows next_cursor and returns every tool under `catalog`', async () => {
    const tool = (name: string) => ({
      name, tier: 1 as const, description: '', topic_tags: [], classification: 'read' as const,
      concurrency_safe: true,
    });
    const result = await listAllTools(async (request) => (request.cursor === undefined
      ? { catalog: [tool('mail.search')], next_cursor: 'c1', total: 2 }
      : { catalog: [tool('calendar.search')], next_cursor: null, total: 2 }));
    expect(result.catalog.map((t) => t.name)).toEqual(['mail.search', 'calendar.search']);
  });
});

describe('hasAnyRecipe', () => {
  it('asks for ONE row and answers from total', async () => {
    const sent: ListPageRequest[] = [];
    await expect(hasAnyRecipe(async (request) => {
      sent.push(request);
      return { recipes: ['first'], next_cursor: 'c1', total: 2_369 };
    })).resolves.toBe(true);
    expect(sent).toEqual([{ limit: 1 }]);
    await expect(hasAnyRecipe(async () => ({ recipes: [], next_cursor: null, total: 0 })))
      .resolves.toBe(false);
  });

  it('falls back to the length of an older server\'s whole list, which carries no total', async () => {
    await expect(hasAnyRecipe(async () => ({ recipes: ['a', 'b'] }))).resolves.toBe(true);
    await expect(hasAnyRecipe(async () => ({ recipes: [] }))).resolves.toBe(false);
  });
});
