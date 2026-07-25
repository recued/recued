/** D-182 Slice 4 — "read ops in prefetch": a lowered Tier-P / kernel op-step in
 *  `prefetch_steps` dispatches through the D-165 catalog gateway, end to end.
 *
 *  The prefetch runner's default path is `invokeGoverned` (lane.ts), which
 *  DELIBERATELY bypasses the catalog gateway — so a catalog-form prefetch step
 *  (`{ ingredient: <catalog>, input: { operation, args } }`, the shape the op-step
 *  lowering emits for a Tier-P vendor raw read) must take the SAME
 *  `isCatalogForm → runCatalogOperation` branch the sequential step-runner does.
 *  These tests prove:
 *    - a lowered catalog-form prefetch step resolves its connection ref + folds the
 *      operation's REST binding + audits (the gateway path, not the bypass);
 *    - `lowerOpStepRecipe` lowers an authored Tier-P prefetch op-step into that
 *      shape, and the runner then dispatches it (the full author→lower→run chain);
 *    - the `merge_query` custom-prop union flows through a prefetch read;
 *    - a simple-form prefetch step still routes through the plain executor path;
 *    - an un-lowered `PrefetchOpStep` reaching the runner fails loud (never a
 *      silent slug-less dispatch). */

import { describe, it, expect } from 'vitest';
import type { GatewayCallAudit, IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { lowerOpStepRecipe, type PackOpResolution } from '@recued/recipes';
import { runPrefetch } from '../prefetch.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

/** Catalog-form HubSpot-shaped manifest. `deal.read` carries a `static_query`
 *  property set whose `properties` key is `merge_query`-extensible (D-182 CRM
 *  Tier-P decision-b). */
const catalogManifest: IngredientManifest = {
  slug: 'hubspot-catalog',
  name: 'HubSpot (catalog)',
  description: '',
  author: 'recued-core',
  kind: 'connection',
  category: 'data',
  risk_tier: 'read',
  input: { operation: null, args: null },
  output: { result: 'result' },
  operations: {
    'deal.read': {
      operation_id: 'recued-core/hubspot.deal.read',
      risk_tier: 'read',
      groups: ['recued-core/hubspot.deals.read'],
    },
  },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.hubapi.com',
      auth: { kind: 'none' },
      executes: {
        'deal.read': {
          kind: 'rest',
          method: 'GET',
          path_template: '/crm/v3/objects/deals/{{deal_id}}',
          static_query: { properties: 'dealname,amount' },
          merge_query: ['properties'],
        },
      },
    },
  },
} as unknown as IngredientManifest;

const makeCtx = (
  prefetchSteps: RecipeDefinition['prefetch_steps'],
  opts: { allowed: string[] } = { allowed: ['deal.read'] },
): {
  ctx: ExecutionContext;
  executorCalls: Array<{ slug: string; input: Record<string, unknown> }>;
  auditCalls: GatewayCallAudit[];
} => {
  const executorCalls: Array<{ slug: string; input: Record<string, unknown> }> = [];
  const auditCalls: GatewayCallAudit[] = [];
  const ingredientExecutor: IngredientExecutor = async (slug, input) => {
    executorCalls.push({ slug, input: input as Record<string, unknown> });
    return { ok: true, slug };
  };
  const ctx = {
    recipe: { recipe_id: 'r1', prefetch_steps: prefetchSteps, steps: [] } as unknown as RecipeDefinition,
    stores: { config: { hs: 'my-hubspot' }, step: {} } as unknown as ExecutionContext['stores'],
    ingredientExecutor,
    manifestGetter: (slug: string) => (slug === 'hubspot-catalog' ? catalogManifest : null),
    connectionProfileResolver: () => ({ allowed_operations: opts.allowed }),
    onGatewayCall: (e: GatewayCallAudit) => {
      auditCalls.push(e);
    },
  } as unknown as ExecutionContext;
  return { ctx, executorCalls, auditCalls };
};

describe('D-182 Slice 4 — read ops in prefetch dispatch through the catalog gateway', () => {
  it('a lowered catalog-form prefetch step routes through the gateway (resolved connection + folded binding + audit)', async () => {
    const { ctx, executorCalls, auditCalls } = makeCtx([
      {
        id: 'deal',
        ingredient: 'hubspot-catalog',
        connection: '{{config.hs}}',
        input: { operation: 'deal.read', args: { deal_id: '7' } },
      },
    ]);

    const logs = await runPrefetch(ctx);

    expect(logs).toHaveLength(1);
    expect(logs[0].error).toBeNull();
    expect(logs[0].result).toEqual({ ok: true, slug: 'hubspot-catalog' });
    // Dispatched under the CATALOG slug with the RESOLVED connection (not the raw
    // '{{config.hs}}' ref) + the binding's method/path folded in — the gateway
    // path, NOT the invokeGoverned bypass (which would pass `{operation,args}` raw).
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].slug).toBe('hubspot-catalog');
    expect(executorCalls[0].input).toMatchObject({
      deal_id: '7',
      method: 'GET',
      path: '/crm/v3/objects/deals/{{deal_id}}',
      connection_kind: 'api',
      connection: 'my-hubspot',
    });
    expect(auditCalls[0]).toMatchObject({
      outcome: 'success',
      ingredient_id: 'hubspot-catalog',
      operation_id: 'recued-core/hubspot.deal.read',
      connection_name: 'my-hubspot',
      risk_tier: 'read',
    });
    // The prefetch result is stored under the step id for downstream refs.
    expect((ctx.stores.step as Record<string, unknown>).deal).toEqual({ ok: true, slug: 'hubspot-catalog' });
  });

  it('resolves {{ref}} VALUES inside the op args object before dispatch', async () => {
    const { ctx, executorCalls } = makeCtx([
      {
        id: 'deal',
        ingredient: 'hubspot-catalog',
        connection: '{{config.hs}}',
        input: { operation: 'deal.read', args: { deal_id: '{{config.target}}' } },
      },
    ]);
    (ctx.stores.config as Record<string, unknown>).target = '42';

    const logs = await runPrefetch(ctx);

    expect(logs[0].error).toBeNull();
    expect(executorCalls[0].input.deal_id).toBe('42');
  });

  it('end-to-end: lowerOpStepRecipe lowers a Tier-P prefetch op-step, then the runner dispatches it', async () => {
    const PACKS: PackOpResolution = new Map([
      ['recued-core.hubspot', { catalog_slug: 'hubspot-catalog', operations: new Set(['deal.read']) }],
    ]);
    const authored = {
      recipe_id: 'find-deal',
      version: 1,
      ttl: 300,
      metadata: { name: 'x', description: '', author: 'recued-core', supported_platforms: [] },
      variables: {},
      prefetch_steps: [
        {
          id: 'deal',
          op: 'recued-core.hubspot.deal.read',
          connection: '{{config.hs}}',
          args: { deal_id: '7' },
        },
      ],
      steps: [],
      output: { sidebar: [] },
    } as unknown as RecipeDefinition;

    const lowered = lowerOpStepRecipe(authored, PACKS);
    // Lowered to a concrete catalog-form PrefetchStep (no `op`, an `ingredient`).
    expect(lowered.prefetch_steps[0]).toEqual({
      id: 'deal',
      ingredient: 'hubspot-catalog',
      connection: '{{config.hs}}',
      input: { operation: 'deal.read', args: { deal_id: '7' } },
    });

    const { ctx, executorCalls } = makeCtx(lowered.prefetch_steps);
    const logs = await runPrefetch(ctx);
    expect(logs[0].error).toBeNull();
    expect(executorCalls[0].slug).toBe('hubspot-catalog');
    expect(executorCalls[0].input).toMatchObject({ method: 'GET', connection: 'my-hubspot' });
  });

  it('the merge_query custom-prop union flows through a prefetch read', async () => {
    const { ctx, executorCalls } = makeCtx([
      {
        id: 'deal',
        ingredient: 'hubspot-catalog',
        connection: '{{config.hs}}',
        // The recipe requests an extra custom property on top of the static set.
        input: { operation: 'deal.read', args: { deal_id: '7', 'query.properties': 'hoa_document_text' } },
      },
    ]);

    const logs = await runPrefetch(ctx);

    expect(logs[0].error).toBeNull();
    // static defaults first, the recipe extra appended (deduped) — the call target
    // stays locked but the property set extends.
    expect(executorCalls[0].input['query.properties']).toBe('dealname,amount,hoa_document_text');
  });

  it('a simple-form prefetch step still routes through the plain executor path (no gateway)', async () => {
    const { ctx, executorCalls, auditCalls } = makeCtx([
      { id: 'mail', ingredient: 'mail-get', input: { id: 'm1' } },
    ]);

    const logs = await runPrefetch(ctx);

    expect(logs[0].error).toBeNull();
    expect(executorCalls[0].slug).toBe('mail-get');
    // Plain dispatch — raw input passed straight to the executor, no gateway audit.
    expect(executorCalls[0].input).toEqual({ id: 'm1' });
    expect(auditCalls).toHaveLength(0);
  });

  it('an un-lowered PrefetchOpStep reaching the runner fails loud (never a silent slug-less dispatch)', async () => {
    const { ctx, executorCalls } = makeCtx([
      // A raw op-step that was NOT lowered (a bug upstream) — the runner must error it.
      { id: 'oops', op: 'recued-core.hubspot.deal.read', args: { deal_id: '7' } } as never,
    ]);

    const logs = await runPrefetch(ctx);

    expect(logs[0].error).not.toBeNull();
    expect(logs[0].error?.message).toMatch(/un-lowered/);
    expect(executorCalls).toHaveLength(0);
  });
});
