/** D-177 catalog-gate session-grant loop tests. */

import { describe, expect, it, vi } from 'vitest';
import {
  PreflightRequiredSignal,
  canonicalArgHash,
  isPreflightRequiredSignal,
  projectResolvedArgs,
} from '@recued/contracts';
import type {
  ApiExecutionBinding,
  ArgHashes,
  ConnectionOperationProfile,
  GatewayCallAudit,
  IngredientManifest,
  OperationRiskTier,
  OperationSpec,
  ProviderSurfaces,
  StepMeta,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type {
  CatalogGrantCall,
  CatalogGrantMintCall,
  CatalogSessionGrantHooks,
  ExecutionContext,
  IngredientExecutor,
} from '../types.js';

const SLUG = 'pub/cat';
const SHORT_OP = 'x';
const OPERATION_ID = 'pub/cat.x';
const CONNECTION = 'primary-connection';

type ExecutorCall = {
  slug: string;
  input: Record<string, unknown>;
  output: Record<string, string> | undefined;
  stepOptions: unknown;
  stepMeta: unknown;
};

const allowedProfile = (): ConnectionOperationProfile => ({
  allowed_operations: [SHORT_OP],
});

const operation = (
  risk_tier: OperationRiskTier,
  extras: Partial<OperationSpec> = {},
): OperationSpec => ({
  operation_id: OPERATION_ID,
  risk_tier,
  groups: ['g'],
  ...extras,
});

const restBinding = (extras: Partial<ApiExecutionBinding> = {}): ApiExecutionBinding => ({
  kind: 'rest',
  method: 'POST',
  path_template: '/x/{{id}}',
  ...extras,
} as ApiExecutionBinding);

const surfacesWith = (binding: ApiExecutionBinding): ProviderSurfaces => ({
  api: {
    transport: 'rest',
    default_base_url: 'https://api.example.test',
    auth: { kind: 'none' },
    executes: { [SHORT_OP]: binding },
  },
});

const manifestFor = (
  op: OperationSpec,
  binding: ApiExecutionBinding = restBinding(),
): IngredientManifest => ({
  slug: SLUG,
  name: 'Catalog',
  description: '',
  author: 'pub',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: { [SHORT_OP]: op },
  surfaces: surfacesWith(binding),
});

const baseArgs = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '42',
  'body.name': 'Ada',
  nested: { count: 1 },
  client_ts: 111,
  ...overrides,
});

const hashesFor = (
  args: Record<string, unknown>,
  excludePaths: readonly string[] = [],
): ArgHashes => canonicalArgHash(
  projectResolvedArgs(args),
  excludePaths.length > 0 ? { excludePaths } : {},
);

const makeGrantHooks = (opts: {
  match?: CatalogSessionGrantHooks['match'];
  consume?: CatalogSessionGrantHooks['consume'];
  mint?: CatalogSessionGrantHooks['mint'];
} = {}): {
  sessionGrants: CatalogSessionGrantHooks;
  match: ReturnType<typeof vi.fn<CatalogSessionGrantHooks['match']>>;
  consume: ReturnType<typeof vi.fn<CatalogSessionGrantHooks['consume']>>;
  mint: ReturnType<typeof vi.fn<CatalogSessionGrantHooks['mint']>>;
} => {
  const match = vi.fn<CatalogSessionGrantHooks['match']>(
    opts.match ?? (() => 'grant-1'),
  );
  const consume = vi.fn<CatalogSessionGrantHooks['consume']>(
    opts.consume ?? (() => true),
  );
  const mint = vi.fn<CatalogSessionGrantHooks['mint']>(
    opts.mint ?? (() => undefined),
  );
  return {
    sessionGrants: { match, consume, mint },
    match,
    consume,
    mint,
  };
};

const makeHarness = (opts: {
  profile?: ConnectionOperationProfile | null;
  result?: unknown;
  catalogSessionGrants?: CatalogSessionGrantHooks;
} = {}): {
  ctx: ExecutionContext;
  executorCalls: ExecutorCall[];
  auditCalls: GatewayCallAudit[];
  ingredientExecutor: ReturnType<typeof vi.fn<IngredientExecutor>>;
} => {
  const executorCalls: ExecutorCall[] = [];
  const auditCalls: GatewayCallAudit[] = [];
  const fallbackResult = opts.result ?? { ok: true };
  const ingredientExecutor = vi.fn<IngredientExecutor>().mockImplementation(
    async (slug, input, output, stepOptions, stepMeta) => {
      executorCalls.push({ slug, input, output, stepOptions, stepMeta });
      return fallbackResult;
    },
  );
  const hasProfile = Object.prototype.hasOwnProperty.call(opts, 'profile');
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'r1' } as never,
    stores: {} as never,
    ingredientExecutor,
    // D-209 Slice B — session grants are a CONTRACTED-dispatch surface; a contracted
    // source resolves the LOW `read` trust ceiling so a write op HOLDS for approval
    // (the pre-condition these grant tests exercise). Absent, the gateway would resolve
    // the owner `admin` ceiling and relax the writes to silent.
    execution_source: {
      channel: 'chat',
      actor: 'contracted_user',
      chat_session_id: 's1',
      user_id: 'u1',
      contract_id: 'k1',
    },
    connectionProfileResolver: () => (hasProfile ? opts.profile ?? null : allowedProfile()),
    ...(opts.catalogSessionGrants !== undefined
      ? { catalogSessionGrants: opts.catalogSessionGrants }
      : {}),
    onGatewayCall: (event) => {
      auditCalls.push(event);
    },
  };

  return { ctx, executorCalls, auditCalls, ingredientExecutor };
};

const run = (
  ctx: ExecutionContext,
  manifest: IngredientManifest,
  opts: {
    args?: Record<string, unknown>;
    stepMeta?: StepMeta;
    connectionName?: string;
  } = {},
): Promise<unknown> => runCatalogOperation(
  ctx,
  manifest,
  SLUG,
  {
    operation: SHORT_OP,
    args: opts.args ?? baseArgs(),
    connection: 'raw-connection',
  },
  opts.connectionName ?? CONNECTION,
  undefined,
  undefined,
  opts.stepMeta,
);

const resumeMeta = (overrides: Partial<StepMeta> = {}): StepMeta => ({
  step_id: 'step-1',
  preflight_admitted: true,
  preflight_approved_target: {
    ingredient_slug: SLUG,
    operation_id: OPERATION_ID,
    connection_name: CONNECTION,
  },
  preflight_session_grant: {
    ttl_ms: 60_000,
    max_uses: 3,
    risk_tier: 'write',
  },
  ...overrides,
} as StepMeta);

const expectPreflightRequired = async (
  promise: Promise<unknown>,
): Promise<PreflightRequiredSignal> => {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(PreflightRequiredSignal);
  expect(isPreflightRequiredSignal(thrown)).toBe(true);
  return thrown as PreflightRequiredSignal;
};

describe('D-177 catalog-gate session-grant loop', () => {
  it('Scenario 1 - match admits a write ask, dispatches, and consumes at the proceed point', async () => {
    const args = baseArgs();
    const expectedHashes = hashesFor(args);
    const { sessionGrants, match, consume, mint } = makeGrantHooks();
    const { ctx, executorCalls, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    await expect(run(ctx, manifest, { args })).resolves.toEqual({ ok: true });

    expect(match).toHaveBeenCalledTimes(1);
    expect(match).toHaveBeenCalledWith({
      ingredient_slug: SLUG,
      operation_id: OPERATION_ID,
      connection_name: CONNECTION,
      risk_tier: 'write',
      arg_shape_hash: expectedHashes.arg_shape_hash,
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
    } satisfies CatalogGrantCall);
    expect(match.mock.calls[0]![0].arg_shape_hash).toEqual(expect.any(String));
    expect(match.mock.calls[0]![0].canonical_payload_hash).toEqual(expect.any(String));
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith('grant-1', {
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
    });
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).toHaveBeenCalledTimes(1);
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].slug).toBe(SLUG);
  });

  it('Scenario 2 - no matching grant holds with operation identity and does not consume', async () => {
    const { sessionGrants, match, consume, mint } = makeGrantHooks({
      match: () => null,
    });
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    const signal = await expectPreflightRequired(run(ctx, manifest));

    expect(signal.operation_id).toBe(OPERATION_ID);
    expect(signal.ingredient_slug).toBe(SLUG);
    expect(signal.connection_name).toBe(CONNECTION);
    expect(match).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).not.toHaveBeenCalled();
  });

  it('Scenario 3 - failed consume re-holds fail-closed before dispatch', async () => {
    const args = baseArgs();
    const expectedHashes = hashesFor(args);
    const { sessionGrants, match, consume, mint } = makeGrantHooks({
      consume: () => false,
    });
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    const signal = await expectPreflightRequired(run(ctx, manifest, { args }));

    expect(signal.operation_id).toBe(OPERATION_ID);
    expect(match).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith('grant-1', {
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
    });
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).not.toHaveBeenCalled();
  });

  it('Scenario 4 - resumed exact allow_session dispatch mints once from the catalog envelope', async () => {
    const args = baseArgs();
    const expectedHashes = hashesFor(args);
    const { sessionGrants, match, consume, mint } = makeGrantHooks({
      match: () => null,
    });
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    await expect(run(ctx, manifest, { args, stepMeta: resumeMeta() }))
      .resolves.toEqual({ ok: true });

    expect(match).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith({
      ingredient_slug: SLUG,
      operation_id: OPERATION_ID,
      connection_name: CONNECTION,
      risk_tier: 'write',
      arg_shape_hash: expectedHashes.arg_shape_hash,
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
      ttl_ms: 60_000,
      max_uses: 3,
    } satisfies CatalogGrantMintCall);
    expect(ingredientExecutor).toHaveBeenCalledTimes(1);
  });

  it('Scenario 4A - resumed open marker without a walk hook dispatches but does not mint', async () => {
    // The batch/open slice made the catalog gate open-capable, but an open
    // mint requires the host's `resolveOpenProjection` hook AND a successful
    // walk; this harness wires neither — fail closed, no mint (the
    // hook-present open mint is pinned in the backend slice tests).
    const { sessionGrants, match, consume, mint } = makeGrantHooks();
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    await expect(run(ctx, manifest, {
      stepMeta: resumeMeta({
        preflight_session_grant: {
          ttl_ms: 60_000,
          max_uses: 3,
          risk_tier: 'write',
          grant_mode: 'open',
        },
      }),
    })).resolves.toEqual({ ok: true });

    expect(match).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).toHaveBeenCalledTimes(1);
  });

  it('Scenario 4B - resumed tier-drift marker dispatches but does not mint', async () => {
    const { sessionGrants, match, consume, mint } = makeGrantHooks();
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    await expect(run(ctx, manifest, {
      stepMeta: resumeMeta({
        preflight_session_grant: {
          ttl_ms: 60_000,
          max_uses: 3,
          risk_tier: 'admin',
        },
      }),
    })).resolves.toEqual({ ok: true });

    expect(match).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).toHaveBeenCalledTimes(1);
  });

  it('Scenario 5 - a read-tier op that HOLDS is non-grantable and never consults grants', async () => {
    const { sessionGrants, match, consume, mint } = makeGrantHooks();
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    // D-209 Slice B — force the read to HOLD via approval:'always' (an author-tightened
    // read the ceiling never relaxes). A read declaring approval:'ask' would instead
    // RELAX to admit at the contracted `read` ceiling (risk read ≤ read), so 'always' is
    // the holding read under Slice B. The point stands: even when a read holds, it is
    // NON-grantable — session grants gate write+ tiers, so match/consume/mint are never
    // consulted for a read.
    const manifest = manifestFor(operation('read', { approval: 'always' }));

    const signal = await expectPreflightRequired(run(ctx, manifest));

    expect(signal.risk_tier).toBe('read');
    expect(match).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).not.toHaveBeenCalled();
  });

  it('Scenario 6 - match and mint use self-consistent hashes and honor hash_exclude_args', async () => {
    const args = baseArgs({ client_ts: 111 });
    const changedExcludedArg = baseArgs({ client_ts: 222 });
    const expectedHashes = hashesFor(args, ['client_ts']);
    const { sessionGrants, match, consume, mint } = makeGrantHooks();
    const { ctx } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write', {
      hash_exclude_args: ['client_ts'],
    }));

    await expect(run(ctx, manifest, { args })).resolves.toEqual({ ok: true });
    await expect(run(ctx, manifest, { args, stepMeta: resumeMeta() }))
      .resolves.toEqual({ ok: true });
    await expect(run(ctx, manifest, { args: changedExcludedArg }))
      .resolves.toEqual({ ok: true });

    expect(match).toHaveBeenCalledTimes(2);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(mint).toHaveBeenCalledTimes(1);

    const matchCall = match.mock.calls[0]![0];
    const mintCall = mint.mock.calls[0]![0];
    expect({
      arg_shape_hash: matchCall.arg_shape_hash,
      canonical_payload_hash: matchCall.canonical_payload_hash,
    }).toEqual({
      arg_shape_hash: mintCall.arg_shape_hash,
      canonical_payload_hash: mintCall.canonical_payload_hash,
    });
    expect({
      arg_shape_hash: mintCall.arg_shape_hash,
      canonical_payload_hash: mintCall.canonical_payload_hash,
    }).toEqual(expectedHashes);
    expect(match.mock.calls[1]![0].canonical_payload_hash)
      .toBe(matchCall.canonical_payload_hash);
  });

  it('Scenario 7 - absent catalogSessionGrants seam preserves the existing hold behavior', async () => {
    const { ctx, ingredientExecutor } = makeHarness();
    const manifest = manifestFor(operation('write'));

    expect(ctx.catalogSessionGrants).toBeUndefined();
    const signal = await expectPreflightRequired(run(ctx, manifest));

    expect(signal.operation_id).toBe(OPERATION_ID);
    expect(ingredientExecutor).not.toHaveBeenCalled();
  });
});
