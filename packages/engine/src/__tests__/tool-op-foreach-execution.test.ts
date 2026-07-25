/** §5 tool-op pack seam — brick 3 EXECUTION proof.
 *
 *  The migration of `find-company-news-hubspot` turns its `search-exa` ingredient
 *  step into a `web.search` TOOL op-step that the connection-agnostic resolver lowers
 *  to a SINGLE pass-through catalog fetch carrying `foreach` + `optional`. This test
 *  runs that resolved shape through the engine to seal the two execution-time claims
 *  the migration depends on:
 *
 *   1. `foreach` over a tool op yields one `{ ok, result, item }` envelope per
 *      iteration, and a failing call is isolated by the foreach loop itself (its
 *      envelope is `ok:false`, the run does not halt) — exactly like a foreach
 *      ingredient step. No `optional` flag is needed (it is rejected on op-steps).
 *   2. The op's observable output is the catalog envelope `{ result: <raw body> }`, so
 *      inside a foreach the articles live at `{{item.result.result.results}}` (the
 *      foreach `.result` is the op output `{ result: <body> }`; the inner `.result` is
 *      the raw Exa body; `.results` is its array). The migrated `envelopes_raw` map
 *      reads exactly this path — get the nesting wrong and every account loses its
 *      articles silently, so it is pinned here.
 */
import { describe, expect, it } from 'vitest';

import { resolveDeep } from '@recued/contracts';
import type { ExecutionContext, IngredientExecutor } from '../types.js';
import { runStep } from '../step-runner.js';

const mkCtx = (override: Partial<ExecutionContext> = {}): ExecutionContext => ({
  recipe: { id: 'r', prefetch_steps: [], steps: [], output: { sidebar: [] } } as unknown as ExecutionContext['recipe'],
  stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
  ingredientExecutor: async () => ({}),
  ...override,
});

/** Mirror the production dispatch layer's ref resolution (real adapters receive
 *  already-resolved input). */
const resolveInput = (ctx: ExecutionContext, input: Record<string, unknown>): Record<string, unknown> =>
  resolveDeep(input, ctx.stores) as Record<string, unknown>;

describe('§5 brick 3 — web.search tool op under foreach', () => {
  it('produces per-company envelopes and reads articles at {{item.result.result.results}}', async () => {
    const ctx = mkCtx();
    // The resolved tool op dispatches through the catalog ingredient; its observable
    // output is the connection-api envelope `{ result: <raw Exa body> }`. The mock
    // returns that shape (with the resolved query echoed so per-company extraction is
    // verifiable); 'Beta' throws to exercise the foreach loop's per-call isolation.
    const executor: IngredientExecutor = async (slug, input) => {
      expect(slug).toBe('exa-catalog');
      const resolved = resolveInput(ctx, input);
      const args = resolved.args as Record<string, unknown>;
      const query = String(args['body.query']);
      expect(resolved.operation).toBe('web.search');
      if (query.startsWith('Beta')) throw new Error('exa 429');
      return { result: { results: [{ title: `${query} hit`, publishedDate: '2026-06-01', url: 'https://x' }] } };
    };
    ctx.ingredientExecutor = executor;
    (ctx.stores.step as Record<string, unknown>).limited = [
      { company: 'Acme', lifecycle_stage: 'customer' },
      { company: 'Beta', lifecycle_stage: 'opportunity' },
    ];

    // The resolver's output for the migrated `searches` step (single fetch + foreach).
    const searches = await runStep({
      id: 'searches',
      ingredient: 'exa-catalog',
      connection: '{{config.exa}}',
      input: { operation: 'web.search', args: { 'body.query': '{{item.company}} company news' } },
      foreach: '{{step.limited}}',
    } as unknown as Parameters<typeof runStep>[0], ctx);

    expect(searches.error).toBeNull();
    const envelopes = searches.result as Array<{ ok: boolean; result?: unknown; item?: unknown }>;
    expect(envelopes).toHaveLength(2);
    expect(envelopes.map((e) => e.ok)).toEqual([true, false]); // Beta isolated by the foreach loop
    // Envelope shape: `.result` is the op output `{ result: <body> }`.
    expect(envelopes[0].result).toEqual({ result: { results: [{ title: 'Acme company news hit', publishedDate: '2026-06-01', url: 'https://x' }] } });

    // search_hits — keep only the ok envelopes (the migrated filter).
    const searchHits = await runStep({
      id: 'search_hits',
      transform: 'filter',
      array: '{{step.searches}}',
      field: 'ok',
      operator: 'equal',
      value: true,
    } as unknown as Parameters<typeof runStep>[0], ctx);
    expect((searchHits.result as unknown[])).toHaveLength(1);

    // envelopes_raw — the migrated map. The DOUBLE `result` is the load-bearing change.
    const envelopesRaw = await runStep({
      id: 'envelopes_raw',
      transform: 'map',
      array: '{{step.search_hits}}',
      expression: {
        company: '{{item.item.company}}',
        lifecycle_stage: '{{item.item.lifecycle_stage}}',
        articles: '{{item.result.result.results}}',
      },
    } as unknown as Parameters<typeof runStep>[0], ctx);

    expect(envelopesRaw.result).toEqual([
      {
        company: 'Acme',
        lifecycle_stage: 'customer',
        articles: [{ title: 'Acme company news hit', publishedDate: '2026-06-01', url: 'https://x' }],
      },
    ]);
  });
});
