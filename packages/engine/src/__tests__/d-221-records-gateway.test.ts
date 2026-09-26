import { describe, expect, it, vi } from 'vitest';
import {
  RECORDS_MAX_SEARCH_ROWS,
  type IngredientManifest,
  type RecordsExecutionBinding,
  type RecordsSchemaSnapshot,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type { ExecutionContext } from '../types.js';

const owner = { publisher: 'verified-publisher', pack_slug: 'job-status-board' };
const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    job: {
      kind: 'job',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'title', slot: 's1', kind: 'string', required: true },
      ],
    },
  },
};
const binding: RecordsExecutionBinding = {
  kind: 'core.records',
  action: 'get',
  entity: 'job',
  owner,
  pack_version: 2,
  storage_schema_hash: 'a'.repeat(64),
  declaration_hash: 'b'.repeat(64),
  operation_digest: 'c'.repeat(64),
};
const manifest: IngredientManifest = {
  slug: 'job-status-board',
  name: 'Job Status Board',
  description: 'Records canary',
  author: owner.publisher,
  kind: 'storage',
  version: 2,
  category: 'data',
  risk_tier: 'read',
  input: { operation: null, args: null },
  output: { result: 'result' },
  operations: {
    'job.get': {
      operation_id: `${owner.publisher}.${owner.pack_slug}.job.get`,
      risk_tier: 'read',
      approval: 'never',
      groups: ['job.read'],
    },
  },
  operation_groups: {
    'job.read': {
      group_id: 'job.read',
      operations: ['job.get'],
      risk_floor: 'read',
    },
  },
  surfaces: { records: { executes: { 'job.get': binding }, schema } },
};

const context = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  stores: {} as ExecutionContext['stores'],
  ingredientExecutor: vi.fn(async () => {
    throw new Error('Records must not enter an adapter');
  }),
  execution_source: {
    channel: 'chat',
    actor: 'user_self',
    chat_session_id: 'chat-1',
    user_id: 'user-1',
    turn_id: 'turn-1',
  },
  recordsReachabilityResolver: () => true,
  recordsOperationExecutor: vi.fn(async ({ binding: received, args, principal }) => ({
    owner: received.owner,
    args,
    principal,
  })),
  ...overrides,
});

describe('D-221 Records catalog gateway', () => {
  it('keeps ordinary catalog policy/audit but dispatches to the local executor', async () => {
    const ctx = context();
    const result = await runCatalogOperation(
      ctx,
      manifest,
      manifest.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    );
    expect(result).toEqual({ owner, args: { id: 'job-1' }, principal: 'user_self' });
    expect(ctx.recordsOperationExecutor).toHaveBeenCalledOnce();
    expect(ctx.ingredientExecutor).not.toHaveBeenCalled();
  });

  it('fails closed without the Records reachability grant or local executor', async () => {
    await expect(runCatalogOperation(
      context({ recordsReachabilityResolver: () => false }),
      manifest,
      manifest.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow(/not granted|denied|disabled/i);

    await expect(runCatalogOperation(
      context({ recordsOperationExecutor: undefined }),
      manifest,
      manifest.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow(/no_records_executor/);
  });

  it('derives the contracted principal and rejects an unstamped surface', async () => {
    const seen: Array<string | null> = [];
    const ctx = context({
      execution_source: {
        channel: 'mcp',
        actor: 'contracted_user',
        contract_id: 'contract-live',
        mcp_token_id: 'token-1',
        agent_id: 'agent-1',
        tool_call_id: 'call-1',
      },
      recordsReachabilityResolver: (principal) => {
        seen.push(principal);
        return principal === 'contract-live';
      },
    });
    await runCatalogOperation(
      ctx,
      manifest,
      manifest.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    );
    expect(seen).toEqual(['contract-live']);

    const unstamped: IngredientManifest = structuredClone(manifest);
    unstamped.surfaces!.records!.executes['job.get'] = {
      kind: 'core.records',
      action: 'get',
      entity: 'job',
    };
    await expect(runCatalogOperation(
      ctx,
      unstamped,
      unstamped.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow(/not granted|denied|disabled/i);
  });

  it('treats host-owned reactive work as owner authority but not an anonymous contract-less fire', async () => {
    const reactive = context({
      execution_source: {
        channel: 'reactive',
        actor: 'system',
        event_kind: 'records.outbox',
        source_recipe: 'notify-job-progress',
      },
    });
    await expect(runCatalogOperation(
      reactive,
      manifest,
      manifest.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    )).resolves.toMatchObject({ principal: 'user_self' });

    const seen: Array<string | null> = [];
    const anonymous = context({
      execution_source: {
        channel: 'webhook',
        actor: 'anonymous',
        vendor: 'example',
        webhook_secret_id: 'hook-1',
      },
      recordsReachabilityResolver: (principal) => {
        seen.push(principal);
        return principal !== null;
      },
    });
    await expect(runCatalogOperation(
      anonymous,
      manifest,
      manifest.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow(/not granted|denied|disabled/i);
    expect(seen).toEqual([null]);
  });
});

/** ⛔⛔ `pages: "all"` — a search read page by page.
 *  The store answers 200 rows at most and a recipe has no loop to follow
 *  `next_cursor`, so the month-end closer's "this month's lines" at
 *  `limit: 200` stopped at line 200 without a word (2026-09-24 audit). A step
 *  asks for every page by name; every other search is one call, because other
 *  recipes rely on the one-page ceiling (owner decision, 2026-09-25). */
describe('D-221 Records search, pages: "all"', () => {
  const searchBinding: RecordsExecutionBinding = { ...binding, action: 'search' };
  const searchManifest: IngredientManifest = {
    ...manifest,
    operations: {
      ...manifest.operations,
      'job.search': {
        operation_id: `${owner.publisher}.${owner.pack_slug}.job.search`,
        risk_tier: 'read',
        approval: 'never',
        groups: ['job.read'],
      },
    },
    operation_groups: {
      'job.read': { group_id: 'job.read', operations: ['job.get', 'job.search'], risk_floor: 'read' },
    },
    surfaces: { records: { executes: { 'job.get': binding, 'job.search': searchBinding }, schema } },
  };

  /** A store that answers a page at a time, as the real one does: at most 200,
   *  refusing more, with `next_cursor` only while rows are left. `overlap`
   *  starts each later page that many rows early, the way a row written between
   *  two pages can shift the boundary. */
  const pagedStore = (total: number, overlap = 0) => {
    const rows = Array.from({ length: total }, (_, i) => ({ id: `job-${String(i).padStart(4, '0')}` }));
    const calls: Array<Record<string, unknown>> = [];
    const executor = vi.fn(async ({ args }: { args: Record<string, unknown> }) => {
      calls.push(args);
      const limit = (args.limit as number | undefined) ?? 50;
      if (limit > 200) throw new Error('records_invalid: limit must be an integer in 1..200');
      const at = typeof args.cursor === 'string' && args.cursor !== ''
        ? Math.max(0, Number(args.cursor.slice(1)) - overlap)
        : 0;
      const page = rows.slice(at, at + limit);
      const end = at + page.length;
      return {
        records: page,
        ...(end < rows.length ? { next_cursor: `c${end}` } : {}),
        ...(at > 0 ? { prev_cursor: `p${at}` } : {}),
      };
    });
    return { rows, calls, executor };
  };

  const ALL = { pages: 'all' } as const;
  const run = (
    ctx: ExecutionContext,
    operation: string,
    args: Record<string, unknown>,
    stepOptions?: { pages: 'all' },
  ) => runCatalogOperation(
    ctx,
    searchManifest,
    searchManifest.slug,
    { operation, args },
    '',
    undefined,
    stepOptions,
    undefined,
  ) as Promise<{ records: Array<{ id: string }>; next_cursor?: string }>;

  it('without it, a search reaches the store once, as authored, ceiling and all', async () => {
    const store = pagedStore(500);
    const ctx = context({ recordsOperationExecutor: store.executor });
    const result = await run(ctx, 'job.search', { limit: 200 });
    expect(store.calls).toEqual([{ limit: 200 }]);
    expect(result.records).toHaveLength(200);
    expect(result.next_cursor).toBe('c200');
    // The one-page ceiling other recipes rely on still refuses a larger page.
    await expect(run(ctx, 'job.search', { limit: 201 })).rejects.toThrow(/1\.\.200/);
  });

  it('⛔ reads every page, in order, and says nothing is left', async () => {
    const store = pagedStore(450);
    const result = await run(context({ recordsOperationExecutor: store.executor }), 'job.search', {
      filters: { title: 'x' },
      limit: 200,
    }, ALL);
    expect(result.records).toEqual(store.rows);
    expect(result.next_cursor).toBeUndefined();
    expect(store.calls.map((call) => [call.cursor, call.limit])).toEqual([
      [undefined, 200], ['c200', 200], ['c400', 200],
    ]);
    // Every page is the same query: only the cursor moves.
    for (const call of store.calls) expect(call.filters).toEqual({ title: 'x' });
  });

  it('⛔ stops at RECORDS_MAX_SEARCH_ROWS, sizing the last page to it, and `next_cursor` says rows are left', async () => {
    const store = pagedStore(1_500);
    const result = await run(context({ recordsOperationExecutor: store.executor }), 'job.search', { limit: 150 }, ALL);
    expect(RECORDS_MAX_SEARCH_ROWS).toBe(1_000);
    expect(result.records).toEqual(store.rows.slice(0, 1_000));
    expect(store.calls.map((call) => call.limit)).toEqual([150, 150, 150, 150, 150, 150, 100]);
    // The cursor sits right after the last row returned, so following it misses nothing.
    expect(result.next_cursor).toBe('c1000');
  });

  it('with no limit, reads the most a page holds at a time', async () => {
    const store = pagedStore(250);
    const result = await run(context({ recordsOperationExecutor: store.executor }), 'job.search', {}, ALL);
    expect(result.records).toHaveLength(250);
    expect(store.calls.map((call) => call.limit)).toEqual([200, 200]);
  });

  it('keeps a row seen on two pages once', async () => {
    const store = pagedStore(450, 3);
    const result = await run(context({ recordsOperationExecutor: store.executor }), 'job.search', { limit: 200 }, ALL);
    expect(result.records.map((r) => r.id)).toEqual(store.rows.map((r) => r.id));
  });

  it('⛔ is refused on anything but a search, before anything runs', async () => {
    const store = pagedStore(10);
    await expect(run(context({ recordsOperationExecutor: store.executor }), 'job.get', { id: 'job-1' }, ALL))
      .rejects.toThrow(/pages: "all" reads a Records search page by page, and '.*job\.get' is not one/);
    expect(store.calls).toEqual([]);
  });

  it('⛔ fails rather than loops when a page adds no new row', async () => {
    const calls: unknown[] = [];
    const stuck = vi.fn(async ({ args }: { args: Record<string, unknown> }) => {
      calls.push(args);
      return { records: [{ id: 'job-0000' }], next_cursor: `c${calls.length}` };
    });
    await expect(run(context({ recordsOperationExecutor: stuck }), 'job.search', { limit: 200 }, ALL))
      .rejects.toThrow(/a page added no new row/);
    expect(calls).toHaveLength(2);
  });
});
