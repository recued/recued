/** D-166 Slice 4d.4 - catalog gateway override tightening.
 *
 *  Proves `runCatalogOperation` tightens the D-165 connection-profile floor with
 *  actor-keyed `contract.override` rows: override rows can force deny or escalate
 *  approval, but absent scan/actor/no matching row preserves the base floor and
 *  an already-denied floor keeps its structural deny reason.
 */

import { describe, expect, it } from 'vitest';
import { isPreflightRequiredSignal } from '@recued/contracts';
import type {
  ApiExecutionBinding,
  ConnectionOperationProfile,
  ContractRowLike,
  GatewayCallAudit,
  IngredientManifest,
  OperationRiskTier,
  OperationSpec,
  PreflightRequiredSignal,
  ProviderSurfaces,
  ScanFn,
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

type ScanCall = {
  scope: string;
  prefixSegments: readonly string[];
};

type OverrideValue = Readonly<{
  denied?: boolean;
  approval?: 'never' | 'ask' | 'always';
  max_risk_without_approval?: 'none' | 'read' | 'write' | 'admin';
  timeout_ms?: number;
  cache_ttl_ms?: number;
}>;

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

const restBinding = (extras: Partial<ApiExecutionBinding> = {}): ApiExecutionBinding => ({
  kind: 'rest',
  method: 'GET',
  path_template: '/x/{{id}}',
  ...extras,
} as ApiExecutionBinding);

const surfacesWith = (binding: ApiExecutionBinding | undefined): ProviderSurfaces => ({
  api: {
    transport: 'rest',
    default_base_url: 'https://api.example.com',
    auth: { kind: 'none' },
    executes: binding ? { x: binding } : {},
  },
});

const manifestFor = (
  op: OperationSpec,
  binding: ApiExecutionBinding | null = restBinding(),
): IngredientManifest => ({
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
  surfaces: surfacesWith(binding ?? undefined),
});

const overrideRow = (
  segments: readonly string[],
  value: OverrideValue,
): ContractRowLike => ({ segments, value });

const deniedOverride = (operationId?: string): ContractRowLike =>
  overrideRow(
    operationId === undefined
      ? ['user_self', 'pub/cat']
      : ['user_self', 'pub/cat', operationId],
    { denied: true },
  );

const makeContractScan = (
  rows: readonly ContractRowLike[],
  calls: ScanCall[],
): ScanFn => {
  return (scope, prefixSegments) => {
    calls.push({ scope, prefixSegments: [...prefixSegments] });
    if (scope !== 'override') return [];
    return rows.filter(
      (row) =>
        prefixSegments.length <= row.segments.length
        && prefixSegments.every((seg, i) => row.segments[i] === seg),
    );
  };
};

const makeHarness = (opts: {
  profile?: ConnectionOperationProfile | null;
  executor?: IngredientExecutor;
  result?: unknown;
  actor?: ExecutionContext['actor'];
  overrideRows?: readonly ContractRowLike[];
  withContractScan?: boolean;
} = {}) => {
  const executorCalls: ExecutorCall[] = [];
  const auditCalls: GatewayCallAudit[] = [];
  const scanCalls: ScanCall[] = [];
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
  const withContractScan =
    opts.withContractScan
    ?? Object.prototype.hasOwnProperty.call(opts, 'overrideRows');
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'r1' } as any,
    stores: {} as any,
    ingredientExecutor,
    connectionProfileResolver: () => (hasProfile ? opts.profile ?? null : allowedProfile()),
    onGatewayCall: (event) => {
      auditCalls.push(event);
    },
  };

  if (opts.actor !== undefined) ctx.actor = opts.actor;
  if (withContractScan) {
    ctx.contractScan = makeContractScan(opts.overrideRows ?? [], scanCalls);
  }

  return { ctx, executorCalls, auditCalls, scanCalls, fallbackResult };
};

const run = (
  ctx: ExecutionContext,
  manifest: IngredientManifest,
  stepMeta?: Record<string, unknown>,
) => runCatalogOperation(
  ctx,
  manifest,
  'pub/cat',
  { operation: 'x', connection: 'raw-connection' },
  'primary-connection',
  undefined,
  undefined,
  stepMeta as any,
);

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return undefined;
  } catch (e) {
    return e;
  }
};

const expectSuccessfulRead = async (
  ctx: ExecutionContext,
  manifest: IngredientManifest,
  fallbackResult: unknown,
  executorCalls: readonly ExecutorCall[],
  auditCalls: readonly GatewayCallAudit[],
) => {
  await expect(run(ctx, manifest)).resolves.toBe(fallbackResult);
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
    risk_tier: 'read',
    connection_name: 'primary-connection',
  });
};

describe('D-166 Slice 4d.4 catalog override tightening', () => {
  it('tightens admitted reads to deny when a match-all override sets denied:true', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls, auditCalls } = makeHarness({
      actor: 'user_self',
      overrideRows: [deniedOverride()],
    });

    const caught = await captureRejection(run(ctx, manifest));

    expect(caught).toBeInstanceOf(Error);
    expect(isPreflightRequiredSignal(caught)).toBe(false);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.x',
      risk_tier: 'read',
      failure_mode: 'operation_not_granted',
    });
  });

  it('tightens admitted reads to ask when a match-all override sets approval:always', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls, auditCalls } = makeHarness({
      actor: 'user_self',
      overrideRows: [
        overrideRow(['user_self', 'pub/cat'], { approval: 'always' }),
      ],
    });

    const caught = await captureRejection(run(ctx, manifest));

    expect(isPreflightRequiredSignal(caught)).toBe(true);
    expect((caught as PreflightRequiredSignal).tool_slug).toBe('pub/cat.x');
    expect((caught as PreflightRequiredSignal).risk_tier).toBe('read');
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it('tightens admitted reads to ask when a match-all override sets max_risk_without_approval:none', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls, auditCalls } = makeHarness({
      actor: 'user_self',
      overrideRows: [
        overrideRow(['user_self', 'pub/cat'], { max_risk_without_approval: 'none' }),
      ],
    });

    const caught = await captureRejection(run(ctx, manifest));

    expect(isPreflightRequiredSignal(caught)).toBe(true);
    expect((caught as PreflightRequiredSignal).tool_slug).toBe('pub/cat.x');
    expect((caught as PreflightRequiredSignal).risk_tier).toBe('read');
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it('preserves the admitted read floor when the override scan is empty', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls, auditCalls, fallbackResult } = makeHarness({
      actor: 'user_self',
      overrideRows: [],
    });

    await expectSuccessfulRead(ctx, manifest, fallbackResult, executorCalls, auditCalls);
  });

  it('preserves the admitted read floor when ctx.contractScan is absent even if a denied row exists in the harness', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls, auditCalls, fallbackResult } = makeHarness({
      actor: 'user_self',
      overrideRows: [deniedOverride()],
      withContractScan: false,
    });

    await expectSuccessfulRead(ctx, manifest, fallbackResult, executorCalls, auditCalls);
  });

  it('preserves the admitted read floor when ctx.actor is absent even if contractScan has a denied row', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls, auditCalls, fallbackResult } = makeHarness({
      overrideRows: [deniedOverride()],
    });

    await expectSuccessfulRead(ctx, manifest, fallbackResult, executorCalls, auditCalls);
  });

  it('does not scan overrides or overwrite the structural deny reason when the base floor already denies', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls, auditCalls, scanCalls } = makeHarness({
      profile: null,
      actor: 'user_self',
      overrideRows: [deniedOverride()],
    });

    const caught = await captureRejection(run(ctx, manifest));

    expect(caught).toBeInstanceOf(Error);
    expect(isPreflightRequiredSignal(caught)).toBe(false);
    expect(scanCalls).toHaveLength(0);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.x',
      risk_tier: 'read',
      failure_mode: 'no_connection_profile',
    });
  });

  it('drops sibling op-specific override rows for a different operation', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls, auditCalls, fallbackResult } = makeHarness({
      actor: 'user_self',
      overrideRows: [deniedOverride('pub/cat.y')],
    });

    await expectSuccessfulRead(ctx, manifest, fallbackResult, executorCalls, auditCalls);
  });

  it('applies an op-specific denied override row for the dispatched operation', async () => {
    const manifest = manifestFor(operation('read'));
    const { ctx, executorCalls, auditCalls } = makeHarness({
      actor: 'user_self',
      overrideRows: [deniedOverride('pub/cat.x')],
    });

    const caught = await captureRejection(run(ctx, manifest));

    expect(caught).toBeInstanceOf(Error);
    expect(isPreflightRequiredSignal(caught)).toBe(false);
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      outcome: 'failed',
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.x',
      risk_tier: 'read',
      failure_mode: 'operation_not_granted',
    });
  });

  it('does not loosen a base ask floor when an override sets approval:never', async () => {
    const manifest = manifestFor(operation('write'));
    // D-209 Slice B — dispatch as a CONTRACTED door (LOW `read` ceiling) so the
    // write does NOT relax on owner trust. This ISOLATES the override-tightening
    // property under test: an override:never cannot loosen the write below its `ask`
    // floor (stricter-wins). Under the owner `admin` ceiling the write would relax to
    // admit regardless of the override, hiding the property.
    const { ctx, executorCalls, auditCalls } = makeHarness({
      actor: 'contracted_user',
      overrideRows: [
        overrideRow(['contracted_user', 'pub/cat'], { approval: 'never' }),
      ],
    });
    const contractedCtx: ExecutionContext = {
      ...ctx,
      execution_source: {
        channel: 'chat',
        actor: 'contracted_user',
        chat_session_id: 's1',
        user_id: 'u1',
        contract_id: 'k1',
      },
    };

    const caught = await captureRejection(run(contractedCtx, manifest));

    expect(isPreflightRequiredSignal(caught)).toBe(true);
    expect((caught as PreflightRequiredSignal).tool_slug).toBe('pub/cat.x');
    expect((caught as PreflightRequiredSignal).risk_tier).toBe('write');
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });
});
