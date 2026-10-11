/** A step the catalog gateway cannot run says why, and fails `BAD_INPUT`.
 *
 *  Two throws: a step asking an operation that is not a Records search for
 *  `pages: "all"`, and an operation whose binding gives this server nothing to
 *  run (`no_api_binding` / `unsupported_binding_kind`). Both were plain
 *  `Error`s, which the step runner codes `NETWORK_ERROR`: an agent read "check
 *  your connection and try again" for a step that fails the same way every
 *  time, an automation retried it, and a peer read the server as unavailable.
 *  The step named something it cannot run, so the code is `BAD_INPUT`. D-313
 *  § 7 (the refusals at the same gate). */

import { describe, expect, it } from 'vitest';

import type {
  ConnectionOperationProfile,
  GatewayCallAudit,
  IngredientManifest,
  ProviderSurfaces,
  RecipeDefinition,
  StepOptions,
} from '@recued/contracts';
import { runCatalogOperation } from '../catalog-gateway.js';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext } from '../types.js';

const SLUG = 'pub/cat';

/** A catalog with one read operation `x`, bound by `surfaces`. */
const manifest = (surfaces: ProviderSurfaces): IngredientManifest => ({
  slug: SLUG,
  name: 'Catalog',
  description: '',
  author: 'pub',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: { x: { operation_id: 'pub/cat.x', risk_tier: 'read', groups: ['g'] } },
  surfaces,
});

const api = (executes: Record<string, unknown>): ProviderSurfaces => ({
  api: {
    transport: 'rest',
    default_base_url: 'https://api.example.com',
    auth: { kind: 'none' },
    executes,
  },
} as unknown as ProviderSurfaces);

const REST = api({ x: { kind: 'rest', method: 'GET', path_template: '/x' } });

const makeCtx = () => {
  const audits: GatewayCallAudit[] = [];
  const dispatched: unknown[] = [];
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'r1' } as ExecutionContext['recipe'],
    stores: {} as ExecutionContext['stores'],
    actor: 'user_self',
    ingredientExecutor: async (_slug, input) => {
      dispatched.push(input);
      return { result: { ok: true } };
    },
    connectionProfileResolver: (): ConnectionOperationProfile => ({
      allowed_operations: ['x'],
      catalog_slug: SLUG,
    }),
    onGatewayCall: (event) => {
      audits.push(event);
    },
  } as ExecutionContext;
  return { ctx, audits, dispatched };
};

/** The error a dispatch of `x` throws, or a failure if it ran. */
const thrown = async (
  ctx: ExecutionContext,
  m: IngredientManifest,
  stepOptions?: StepOptions,
): Promise<Error & { code?: unknown }> => {
  const outcome: unknown = await runCatalogOperation(
    ctx, m, SLUG, { operation: 'x', args: {} }, 'primary', undefined, stepOptions, undefined,
  ).then(() => 'dispatched', (e: unknown) => e);
  expect(outcome).toBeInstanceOf(Error);
  return outcome as Error & { code?: unknown };
};

describe('pages: "all" on an operation that is not a Records search', () => {
  it('fails BAD_INPUT before anything runs, naming the operation as Access does', async () => {
    const { ctx, audits, dispatched } = makeCtx();
    const err = await thrown(ctx, manifest(REST), { pages: 'all' });
    expect(err.message).toBe(
      `pages: "all" reads a Records search page by page, and 'pub/cat.x' is not one, so nothing ran.`,
    );
    expect(err.code).toBe('BAD_INPUT');
    expect(dispatched).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('the same operation without it runs, so the refusal is the setting, not the operation', async () => {
    const { ctx, dispatched } = makeCtx();
    await runCatalogOperation(
      ctx, manifest(REST), SLUG, { operation: 'x', args: {} }, 'primary', undefined, undefined, undefined,
    );
    expect(dispatched).toHaveLength(1);
  });
});

describe('an operation this server cannot run', () => {
  it('bound to nothing: says so, fails BAD_INPUT, audits no_api_binding', async () => {
    const { ctx, audits, dispatched } = makeCtx();
    const err = await thrown(ctx, manifest(api({})));
    expect(err.message).toBe(
      "Its pack declares 'pub/cat.x' but gives it no way to run, so nothing ran. (no_api_binding)",
    );
    expect(err.code).toBe('BAD_INPUT');
    expect(dispatched).toEqual([]);
    expect(audits[0]).toMatchObject({ outcome: 'failed', failure_mode: 'no_api_binding' });
  });

  it.each([
    ['a webhook subscription', { kind: 'webhook_subscription', event_types: ['x.created'] }],
    ['a queue subscription', { kind: 'queue_subscription', queue: 'q' }],
    ['a push channel', { kind: 'push_channel', channel: 'c' }],
    ['a GraphQL subscription', { kind: 'graphql', operation_type: 'subscription', document: 'subscription { x }' }],
  ])('bound to %s: says it delivers events, not an action', async (_label, binding) => {
    const { ctx, audits, dispatched } = makeCtx();
    const err = await thrown(ctx, manifest(api({ x: binding })));
    expect(err.message).toBe(
      "'pub/cat.x' delivers events from its service as they happen, which is not an action a step "
        + 'can run, so nothing ran. (unsupported_binding_kind)',
    );
    expect(err.code).toBe('BAD_INPUT');
    expect(dispatched).toEqual([]);
    expect(audits[0]).toMatchObject({ outcome: 'failed', failure_mode: 'unsupported_binding_kind' });
  });

  it('bound to a connector method call: says this server cannot run it as bound', async () => {
    const { ctx, audits } = makeCtx();
    const err = await thrown(ctx, manifest({
      connector: {
        runtime: {
          transport: 'stdio',
          wire_protocol: 'json_rpc',
          package_ref: 'npm:example',
          entry_point: 'example',
          expected_protocol_version: 1,
        },
        executes: { x: { kind: 'method_call', method_name: 'x' } },
      },
    } as unknown as ProviderSurfaces));
    expect(err.message).toBe(
      "This server cannot run 'pub/cat.x' the way its pack binds it, so nothing ran. "
        + '(unsupported_binding_kind)',
    );
    expect(err.code).toBe('BAD_INPUT');
    expect(audits[0]).toMatchObject({ outcome: 'failed', failure_mode: 'unsupported_binding_kind' });
  });
});

describe('through a recipe run, each reaches the step as BAD_INPUT, not NETWORK_ERROR', () => {
  const run = async (m: IngredientManifest, step: Record<string, unknown>) => {
    const recipe = {
      recipe_id: 'r1',
      version: 1,
      metadata: { name: 'r1', description: 'one catalog step', author: 'pub', supported_platforms: [] },
      variables: {},
      prefetch_steps: [],
      steps: [{ id: 'go', ingredient: SLUG, connection: 'primary', input: { operation: 'x', args: {} }, ...step }],
      output: { sidebar: [] },
    } as unknown as RecipeDefinition;
    const { ctx } = makeCtx();
    return executeRecipe({
      ...ctx,
      recipe,
      stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
      manifestGetter: (slug: string) => (slug === SLUG ? m : null),
    });
  };

  it('a step asking for every page of an operation that is not a search', async () => {
    const result = await run(manifest(REST), { pages: 'all' });
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: 'BAD_INPUT',
      message: `pages: "all" reads a Records search page by page, and 'pub/cat.x' is not one, so nothing ran.`,
    });
  });

  it('a step running an operation that delivers events', async () => {
    const result = await run(manifest(api({ x: { kind: 'webhook_subscription', event_types: ['x.created'] } })), {});
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatchObject({ code: 'BAD_INPUT' });
    expect(String(result.errors[0]?.message)).toContain('(unsupported_binding_kind)');
  });
});
