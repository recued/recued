import { describe, it, expect } from 'vitest';
import {
  PreflightRequiredSignal,
  isPreflightRequiredSignal,
} from '@recued/contracts';
import type {
  ConnectionOperationProfile,
  GatewayCallAudit,
  IngredientManifest,
  OperationRiskTier,
  OperationSpec,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

type ExecutorCall = {
  slug: string;
  input: Record<string, unknown>;
  output: Record<string, string> | undefined;
  stepOptions: unknown;
  stepMeta: unknown;
};

const allowedProfile = (): ConnectionOperationProfile => ({
  allowed_operations: ['x'],
});

const operation = (
  risk_tier: OperationRiskTier,
  extras: Partial<OperationSpec> = {},
): OperationSpec => ({
  operation_id: 'pub/cat.x',
  risk_tier,
  groups: ['g'],
  ...extras,
});

const manifestFor = (op: OperationSpec): IngredientManifest => ({
  slug: 'pub/cat',
  name: 'Catalog',
  description: '',
  author: 'pub',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: { x: op },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.example.com',
      auth: { kind: 'none' },
      executes: { x: { kind: 'rest', method: 'GET', path_template: '/x/{{id}}' } },
    },
  },
});

const makeHarness = (opts: {
  profile?: ConnectionOperationProfile | null;
  executor?: IngredientExecutor;
  result?: unknown;
  manifestGetter?: (slug: string) => IngredientManifest | null;
} = {}) => {
  const executorCalls: ExecutorCall[] = [];
  const auditCalls: GatewayCallAudit[] = [];
  const fallbackResult = opts.result ?? { ok: true };
  const ingredientExecutor: IngredientExecutor = async (
    slug,
    input,
    output,
    stepOptions,
    stepMeta,
  ) => {
    executorCalls.push({ slug, input, output, stepOptions, stepMeta });
    if (opts.executor) return opts.executor(slug, input, output, stepOptions, stepMeta);
    return fallbackResult;
  };
  const hasProfile = Object.prototype.hasOwnProperty.call(opts, 'profile');
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'r1' } as any,
    stores: {} as any,
    ingredientExecutor,
    // D-209 Slice B — contracted-dispatch source ⇒ LOW `read` ceiling ⇒ a write op
    // HOLDS for approval, so the approval-identity binding / drift guards fire.
    execution_source: {
      channel: 'chat',
      actor: 'contracted_user',
      chat_session_id: 's1',
      user_id: 'u1',
      contract_id: 'k1',
    },
    connectionProfileResolver: () => (hasProfile ? opts.profile ?? null : allowedProfile()),
    ...(opts.manifestGetter ? { manifestGetter: opts.manifestGetter } : {}),
    onGatewayCall: (event) => {
      auditCalls.push(event);
    },
  };

  return { ctx, executorCalls, auditCalls, fallbackResult };
};

const run = (
  ctx: ExecutionContext,
  manifest: IngredientManifest,
  stepMeta?: Record<string, unknown>,
  connectionName = 'primary-connection',
) => runCatalogOperation(
  ctx,
  manifest,
  'pub/cat',
  { operation: 'x', connection: 'raw-connection' },
  connectionName,
  undefined,
  undefined,
  stepMeta as any,
);

const matchingTarget = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ingredient_slug: 'pub/cat',
  operation_id: 'pub/cat.x',
  connection_name: 'primary-connection',
  ...overrides,
});

const expectCurrentPreflightSignal = (
  caught: unknown,
  current: {
    ingredient_slug: string;
    operation_id: string;
    connection_name: string;
  },
) => {
  expect(isPreflightRequiredSignal(caught)).toBe(true);
  expect(caught).toBeInstanceOf(PreflightRequiredSignal);
  expect(caught).toMatchObject({
    tool_slug: current.operation_id,
    risk_tier: 'write',
    ingredient_slug: current.ingredient_slug,
    operation_id: current.operation_id,
    connection_name: current.connection_name,
  });
};

describe('D-165 catalog op-identity binding', () => {
  it('re-asks when the resolved connection drifts from the approved identity', async () => {
    const manifest = manifestFor(operation('write'));
    const { ctx, executorCalls, auditCalls } = makeHarness();
    let caught: unknown;

    try {
      await run(
        ctx,
        manifest,
        {
          preflight_admitted: true,
          preflight_approved_target: matchingTarget({
            connection_name: 'approved-conn',
          }),
        },
        'drifted-conn',
      );
    } catch (e) {
      caught = e;
    }

    expectCurrentPreflightSignal(caught, {
      ingredient_slug: 'pub/cat',
      operation_id: 'pub/cat.x',
      connection_name: 'drifted-conn',
    });
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
    expect(auditCalls.filter((event) => event.outcome === 'success')).toHaveLength(0);
  });

  it('re-asks when the resolved operation drifts from the approved identity', async () => {
    const manifest = manifestFor(operation('write'));
    const { ctx, executorCalls, auditCalls } = makeHarness();
    let caught: unknown;

    try {
      await run(ctx, manifest, {
        preflight_admitted: true,
        preflight_approved_target: matchingTarget({
          operation_id: 'pub/cat.y',
        }),
      });
    } catch (e) {
      caught = e;
    }

    expectCurrentPreflightSignal(caught, {
      ingredient_slug: 'pub/cat',
      operation_id: 'pub/cat.x',
      connection_name: 'primary-connection',
    });
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it('fails closed when preflight_admitted has no approved target', async () => {
    const manifest = manifestFor(operation('write'));
    const { ctx, executorCalls, auditCalls } = makeHarness();
    let caught: unknown;

    try {
      await run(ctx, manifest, {
        preflight_admitted: true,
      });
    } catch (e) {
      caught = e;
    }

    expectCurrentPreflightSignal(caught, {
      ingredient_slug: 'pub/cat',
      operation_id: 'pub/cat.x',
      connection_name: 'primary-connection',
    });
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it('admits a resumed write when the full approved identity matches', async () => {
    const manifest = manifestFor(operation('write'));
    const { ctx, executorCalls, auditCalls } = makeHarness();

    await expect(run(ctx, manifest, {
      preflight_admitted: true,
      preflight_approved_target: matchingTarget(),
    })).resolves.toEqual({ ok: true });

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]).toMatchObject({
      slug: 'pub/cat',
      input: {
        method: 'GET',
        path: '/x/{{id}}',
        connection_kind: 'api',
        connection: 'primary-connection',
      },
    });
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'success',
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.x',
      risk_tier: 'write',
      connection_name: 'primary-connection',
    });
  });
});
