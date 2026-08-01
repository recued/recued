import { describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition, ResolvedFilterDescriptor } from '@recued/contracts';

import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor, ProgressEvent } from '../types.js';

const recipe = (malformedCursor = false): RecipeDefinition => ({
  recipe_id: 'd-222-filter-output',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'D-222 filter output',
    description: 'Proves resolved filter output and complete fresh execution.',
    author: 'test',
    supported_platforms: [],
  },
  variables: {
    status: { label: 'Status', type: 'enum', options: ['open', 'closed'], default: 'open' },
    cursor: '',
    count: { label: 'Count', type: 'number', default: 25 },
    enabled: { label: 'Enabled', type: 'boolean', default: false },
    tags: { label: 'Tags', type: 'array', default: ['a'] } as never,
    nil: { label: 'Nil', type: 'future_null', default: null } as never,
    absent: { label: 'Absent', type: 'future_optional', optional: true } as never,
    unlisted: { label: 'Unlisted', type: 'text', default: 'do-not-project' },
  },
  prefetch_steps: [{ id: 'prefetch', ingredient: 'test-prefetch', input: {} }],
  steps: [
    { id: 'write', ingredient: 'test-write', input: { status: '{{config.status}}' } },
    { id: 'search', ingredient: 'test-search', input: { cursor: '{{config.cursor}}' } },
  ],
  output: {
    render: [
      { type: 'table', source: 'step.search' },
      {
        type: 'filter',
        source: 'step.search',
        label: 'Filter rows',
        fields: ['status'],
        hidden: ['cursor', 'count', 'enabled', 'tags', 'nil', 'absent'],
        submit: 'Search',
      },
    ],
  },
});

const run = async (malformedCursor = false) => {
  const calls: string[] = [];
  const progress: ProgressEvent[] = [];
  const ingredientExecutor: IngredientExecutor = vi.fn(async (slug) => {
    calls.push(slug);
    if (slug === 'test-prefetch') return { ready: true };
    if (slug === 'test-write') return { wrote: true };
    if (slug === 'test-search') {
      return {
        rows: [{ id: 'a' }],
        next_cursor: malformedCursor ? 42 : 'next-token',
        prev_cursor: 'previous-token',
      };
    }
    return null;
  });
  const ctx: ExecutionContext = {
    recipe: recipe(malformedCursor),
    stores: {
      vault: {},
      config: {
        status: 'closed',
        cursor: 'current-token',
        count: 50,
        enabled: false,
        tags: ['x', 'y'],
        nil: null,
        unlisted: 'owner-only',
      },
      context: {},
      meta: {},
      step: {},
    },
    ingredientExecutor,
    outputRecipeHash: 'stored-authored-snapshot-hash',
    onProgress: (event) => progress.push(event),
    strict: false,
  };
  const result = await executeRecipe(ctx);
  return { calls, progress, result };
};

describe('D-222 engine filter resolution', () => {
  it('projects only listed definitions and exact effective JSON values', async () => {
    const { result } = await run();
    const block = result.output.render[1]!;
    const filter = block.filter as ResolvedFilterDescriptor;

    expect(result.success).toBe(true);
    expect(filter).toMatchObject({
      recipe_hash: 'stored-authored-snapshot-hash',
      section_index: 1,
      fields: ['status'],
      hidden: ['cursor', 'count', 'enabled', 'tags', 'nil', 'absent'],
      submit: 'Search',
      paging: {
        next_cursor: 'next-token',
        prev_cursor: 'previous-token',
      },
    });
    expect(Object.keys(filter.definitions).sort()).toEqual([
      'absent', 'count', 'cursor', 'enabled', 'nil', 'status', 'tags',
    ]);
    expect(filter.values).toEqual({
      status: 'closed',
      cursor: 'current-token',
      count: 50,
      enabled: false,
      tags: ['x', 'y'],
      nil: null,
    });
    expect(filter.values).not.toHaveProperty('absent');
    expect(filter.values).not.toHaveProperty('unlisted');
  });

  it('preserves the descriptor in progressive and final output', async () => {
    const { progress, result } = await run();
    const ready = progress.filter((event) => event.type === 'render_ready');
    expect(ready.length).toBeGreaterThan(0);
    const last = ready.at(-1);
    if (last?.type !== 'render_ready') throw new Error('missing render_ready');
    expect(last.render[1]?.filter).toEqual(result.output.render[1]?.filter);
  });

  it('runs prefetch and every sequential step on every fresh invocation', async () => {
    const first = await run();
    const second = await run();
    expect(first.calls).toEqual(['test-prefetch', 'test-write', 'test-search']);
    expect(second.calls).toEqual(['test-prefetch', 'test-write', 'test-search']);
  });

  it('turns a present non-string paging cursor into a render error', async () => {
    const { result } = await run(true);
    expect(result.success).toBe(true);
    expect(result.output.render[1]?.type).toBe('filter');
    expect(result.output.render[1]?.filter).toBeUndefined();
  });
});

describe('D-222 paging — a null cursor is absent, not malformed', () => {
  /** A real API says "no next page" with `null`, not by omitting the key.
   *  Cal.com's `/v2/bookings` sends `pagination.nextCursor: null` on the last
   *  page (verified live). Treating that as a malformed cursor returned NO
   *  descriptor, so the whole filter block — every control, not just Next —
   *  vanished on the last page of any vendor-backed list.
   *
   *  It lands where an early test never reaches: the last page is the page you
   *  only get to once paging already works. */
  const withCursors = async (
    next: unknown,
    prev: unknown,
  ): Promise<ResolvedFilterDescriptor | undefined> => {
    const def = recipe();
    const ctx: ExecutionContext = {
      recipe: def,
      stores: {
        vault: {},
        config: { status: 'closed', cursor: 'current-token', count: 50, enabled: false,
          tags: ['x'], nil: null, unlisted: 'o' },
        context: {}, meta: {}, step: {},
      },
      ingredientExecutor: vi.fn(async (slug: string) => {
        if (slug === 'test-search') {
          return {
            rows: [{ id: 'a' }],
            ...(next === '__omit__' ? {} : { next_cursor: next }),
            ...(prev === '__omit__' ? {} : { prev_cursor: prev }),
          };
        }
        return slug === 'test-prefetch' ? { ready: true } : { wrote: true };
      }),
      outputRecipeHash: 'stored-authored-snapshot-hash',
      strict: false,
    };
    const result = await executeRecipe(ctx);
    return result.output.render[1]?.filter as ResolvedFilterDescriptor | undefined;
  };

  it('keeps the descriptor and offers no page controls when both are null', async () => {
    const filter = await withCursors(null, null);
    expect(filter, 'the filter block must survive the last page').toBeDefined();
    expect(filter?.paging).toBeUndefined();
    // The visible controls are still there — that is the whole point.
    expect(filter?.fields).toEqual(['status']);
  });

  it('treats null exactly like an omitted key', async () => {
    const viaNull = await withCursors(null, null);
    const viaOmit = await withCursors('__omit__', '__omit__');
    expect(viaNull?.paging).toEqual(viaOmit?.paging);
    expect(viaNull?.fields).toEqual(viaOmit?.fields);
  });

  it('still offers the boundary that IS present when the other is null', async () => {
    const filter = await withCursors('next-token', null);
    expect(filter?.paging).toEqual({ next_cursor: 'next-token' });
  });

  it('STILL refuses a coerced token — number, boolean, object', async () => {
    // The case the guard was written for, and the one this must not relax.
    for (const bad of [42, true, { token: 'x' }, ['x']]) {
      expect(await withCursors(bad, null), `${JSON.stringify(bad)} must invalidate`)
        .toBeUndefined();
    }
  });
});
