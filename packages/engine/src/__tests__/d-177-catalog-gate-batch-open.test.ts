/** D-177 catalog-gate batch and open session-grant mechanics. */

import { describe, expect, it, vi } from 'vitest';
import {
  runCatalogOperation,
  type CatalogGrantCall,
  type CatalogGrantMintCall,
  type CatalogSessionGrantHooks,
  type ExecutionContext,
  type IngredientExecutor,
} from '@recued/engine';
import {
  BATCH_ARGS_PREVIEW_MAX_BYTES,
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
  OpenProjectionComputation,
  OperationRiskTier,
  OperationSpec,
  ProviderSurfaces,
  StepMeta,
} from '@recued/contracts';

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
  recipient: 'ada@example.test',
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

const openComputation = (
  overrides: Partial<OpenProjectionComputation> = {},
): OpenProjectionComputation => ({
  projection: {
    version: 1,
    args: [{ path: 'recipient', skeleton: 'ada@example.test', roots: [] }],
  },
  pinned_projection_hash: 'h_open',
  preview: {
    pinned: [{ label: 'recipient', value: '"ada@example.test"' }],
    varying: [],
  },
  ...overrides,
});

const makeGrantHooks = (opts: {
  match?: CatalogSessionGrantHooks['match'];
  consume?: CatalogSessionGrantHooks['consume'];
  mint?: CatalogSessionGrantHooks['mint'];
  claimBatchMember?: NonNullable<CatalogSessionGrantHooks['claimBatchMember']>;
  resolveOpenProjection?: NonNullable<CatalogSessionGrantHooks['resolveOpenProjection']>;
} = {}): {
  sessionGrants: CatalogSessionGrantHooks;
  match: ReturnType<typeof vi.fn<CatalogSessionGrantHooks['match']>>;
  consume: ReturnType<typeof vi.fn<CatalogSessionGrantHooks['consume']>>;
  mint: ReturnType<typeof vi.fn<CatalogSessionGrantHooks['mint']>>;
  claimBatchMember?: ReturnType<
    typeof vi.fn<NonNullable<CatalogSessionGrantHooks['claimBatchMember']>>
  >;
  resolveOpenProjection?: ReturnType<
    typeof vi.fn<NonNullable<CatalogSessionGrantHooks['resolveOpenProjection']>>
  >;
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
  const sessionGrants: CatalogSessionGrantHooks = { match, consume, mint };
  const claimBatchMember = opts.claimBatchMember !== undefined
    ? vi.fn<NonNullable<CatalogSessionGrantHooks['claimBatchMember']>>(
        opts.claimBatchMember,
      )
    : undefined;
  const resolveOpenProjection = opts.resolveOpenProjection !== undefined
    ? vi.fn<NonNullable<CatalogSessionGrantHooks['resolveOpenProjection']>>(
        opts.resolveOpenProjection,
      )
    : undefined;
  if (claimBatchMember !== undefined) {
    sessionGrants.claimBatchMember = claimBatchMember;
  }
  if (resolveOpenProjection !== undefined) {
    sessionGrants.resolveOpenProjection = resolveOpenProjection;
  }
  return {
    sessionGrants,
    match,
    consume,
    mint,
    ...(claimBatchMember !== undefined ? { claimBatchMember } : {}),
    ...(resolveOpenProjection !== undefined ? { resolveOpenProjection } : {}),
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
    // D-209 Slice B — session grants are a CONTRACTED-dispatch surface (an AI
    // acting under a door). A contracted source resolves the LOW `read` trust
    // ceiling, so a write op HOLDS for approval (the pre-condition every batch/
    // open/session-grant test here exercises). Without a source the gateway would
    // resolve the owner `admin` ceiling and the writes would relax to silent.
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

const batchResumeMeta = (overrides: Partial<StepMeta> = {}): StepMeta =>
  resumeMeta({
    preflight_session_grant: undefined,
    preflight_batch_claim: {
      contract_id: 'batch-contract-1',
      member_id: 'm1',
    },
    ...overrides,
  });

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

describe('D-177 catalog-gate batch and open modes', () => {
  it('claims a batch member at the resumed ask proceed point and dispatches without match/consume/mint', async () => {
    const args = baseArgs();
    const expectedHashes = hashesFor(args);
    const {
      sessionGrants,
      match,
      consume,
      mint,
      claimBatchMember,
    } = makeGrantHooks({ claimBatchMember: () => true });
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    await expect(run(ctx, manifest, { args, stepMeta: batchResumeMeta() }))
      .resolves.toEqual({ ok: true });

    expect(claimBatchMember).toHaveBeenCalledTimes(1);
    expect(claimBatchMember).toHaveBeenCalledWith('batch-contract-1', 'm1', {
      arg_shape_hash: expectedHashes.arg_shape_hash,
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
    });
    expect(match).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).toHaveBeenCalledTimes(1);
  });

  it('re-raises and skips dispatch when a batch member claim returns false', async () => {
    const {
      sessionGrants,
      match,
      consume,
      mint,
      claimBatchMember,
    } = makeGrantHooks({ claimBatchMember: () => false });
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    const signal = await expectPreflightRequired(
      run(ctx, manifest, { stepMeta: batchResumeMeta() }),
    );

    expect(signal.operation_id).toBe(OPERATION_ID);
    expect(claimBatchMember).toHaveBeenCalledTimes(1);
    expect(match).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).not.toHaveBeenCalled();
  });

  it('re-raises and skips dispatch when a batch marker arrives without a claim hook', async () => {
    const { sessionGrants, match, consume, mint } = makeGrantHooks();
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    await expectPreflightRequired(run(ctx, manifest, { stepMeta: batchResumeMeta() }));

    expect(match).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).not.toHaveBeenCalled();
  });

  it('re-raises and skips dispatch when a batch member claim throws', async () => {
    const {
      sessionGrants,
      match,
      consume,
      mint,
      claimBatchMember,
    } = makeGrantHooks({
      claimBatchMember: () => {
        throw new Error('claim failed');
      },
    });
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    await expectPreflightRequired(run(ctx, manifest, { stepMeta: batchResumeMeta() }));

    expect(claimBatchMember).toHaveBeenCalledTimes(1);
    expect(match).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).not.toHaveBeenCalled();
  });

  it('threads an open projection hash into match and consume for a grant-admitted dispatch', async () => {
    const args = baseArgs();
    const expectedHashes = hashesFor(args);
    const computation = openComputation();
    const {
      sessionGrants,
      match,
      consume,
      mint,
      resolveOpenProjection,
    } = makeGrantHooks({
      match: () => 'open-grant-1',
      resolveOpenProjection: () => computation,
    });
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    await expect(run(ctx, manifest, { args })).resolves.toEqual({ ok: true });

    expect(resolveOpenProjection).toHaveBeenCalledTimes(1);
    expect(match).toHaveBeenCalledTimes(1);
    expect(match).toHaveBeenCalledWith({
      ingredient_slug: SLUG,
      operation_id: OPERATION_ID,
      connection_name: CONNECTION,
      risk_tier: 'write',
      arg_shape_hash: expectedHashes.arg_shape_hash,
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
      open_pinned_projection_hash: 'h_open',
    } satisfies CatalogGrantCall);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith('open-grant-1', {
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
      pinned_projection_hash: 'h_open',
    });
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).toHaveBeenCalledTimes(1);
  });

  it('omits open fields from match and consume when the open walk returns undefined', async () => {
    const {
      sessionGrants,
      match,
      consume,
      resolveOpenProjection,
    } = makeGrantHooks({
      match: () => 'exact-grant-1',
      resolveOpenProjection: () => undefined,
    });
    const { ctx } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    await expect(run(ctx, manifest)).resolves.toEqual({ ok: true });

    expect(resolveOpenProjection).toHaveBeenCalledTimes(1);
    expect(match).toHaveBeenCalledTimes(1);
    expect(match.mock.calls[0]![0]).not.toHaveProperty('open_pinned_projection_hash');
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0]![1]).not.toHaveProperty('pinned_projection_hash');
  });

  it('computes the open projection at most once across a no-match hold and re-raise', async () => {
    const computation = openComputation();
    const {
      sessionGrants,
      match,
      consume,
      resolveOpenProjection,
    } = makeGrantHooks({
      match: () => null,
      resolveOpenProjection: () => computation,
    });
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    const signal = await expectPreflightRequired(run(ctx, manifest));

    expect(signal.open_projection_preview).toBe(computation.preview);
    expect(resolveOpenProjection).toHaveBeenCalledTimes(1);
    expect(match).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
    expect(ingredientExecutor).not.toHaveBeenCalled();
  });

  it('mints an open session grant from a resumed open marker and computed walk', async () => {
    const args = baseArgs();
    const expectedHashes = hashesFor(args);
    const computation = openComputation();
    const {
      sessionGrants,
      match,
      consume,
      mint,
      resolveOpenProjection,
    } = makeGrantHooks({ resolveOpenProjection: () => computation });
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    await expect(run(ctx, manifest, {
      args,
      stepMeta: resumeMeta({
        preflight_session_grant: {
          ttl_ms: 60_000,
          max_uses: 3,
          risk_tier: 'write',
          grant_mode: 'open',
        },
      }),
    })).resolves.toEqual({ ok: true });

    expect(resolveOpenProjection).toHaveBeenCalledTimes(1);
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
      grant_mode: 'open',
      pinned_projection_hash: 'h_open',
      open_projection: computation.projection,
    } satisfies CatalogGrantMintCall);
    expect(ingredientExecutor).toHaveBeenCalledTimes(1);
  });

  it('dispatches but skips mint when a resumed open marker has no computed walk', async () => {
    const {
      sessionGrants,
      match,
      consume,
      mint,
      resolveOpenProjection,
    } = makeGrantHooks({ resolveOpenProjection: () => undefined });
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

    expect(resolveOpenProjection).toHaveBeenCalledTimes(1);
    expect(match).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).toHaveBeenCalledTimes(1);
  });

  it('keeps exact session-grant minting unchanged when a walk hook exists but the marker is exact', async () => {
    const expectedHashes = hashesFor(baseArgs());
    const {
      sessionGrants,
      mint,
      resolveOpenProjection,
    } = makeGrantHooks({ resolveOpenProjection: () => openComputation() });
    const { ctx } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    await expect(run(ctx, manifest, { stepMeta: resumeMeta() }))
      .resolves.toEqual({ ok: true });

    expect(resolveOpenProjection).not.toHaveBeenCalled();
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
    expect(mint.mock.calls[0]![0]).not.toHaveProperty('grant_mode');
    expect(mint.mock.calls[0]![0]).not.toHaveProperty('pinned_projection_hash');
    expect(mint.mock.calls[0]![0]).not.toHaveProperty('open_projection');
  });

  it('raises fresh holds with action hashes and args_preview equal to projected args', async () => {
    const args = baseArgs({ client_ts: 222 });
    const expectedHashes = hashesFor(args);
    const { ctx, ingredientExecutor } = makeHarness();
    const manifest = manifestFor(operation('write'));

    const signal = await expectPreflightRequired(run(ctx, manifest, { args }));

    expect(signal.arg_shape_hash).toBe(expectedHashes.arg_shape_hash);
    expect(signal.canonical_payload_hash).toBe(expectedHashes.canonical_payload_hash);
    expect(signal.args_preview).toEqual(projectResolvedArgs(args));
    expect(signal.open_projection_preview).toBeUndefined();
    expect(ingredientExecutor).not.toHaveBeenCalled();
  });

  it('raises fresh holds with open_projection_preview when the open walk classifies the dispatch', async () => {
    const computation = openComputation({
      preview: {
        pinned: [{ label: 'recipient', value: '"grace@example.test"' }],
        varying: [],
      },
    });
    const { sessionGrants, match } = makeGrantHooks({
      match: () => null,
      resolveOpenProjection: () => computation,
    });
    const { ctx } = makeHarness({ catalogSessionGrants: sessionGrants });
    const manifest = manifestFor(operation('write'));

    const signal = await expectPreflightRequired(run(ctx, manifest));

    expect(match).toHaveBeenCalledTimes(1);
    expect(signal.arg_shape_hash).toEqual(expect.any(String));
    expect(signal.canonical_payload_hash).toEqual(expect.any(String));
    expect(signal.args_preview).toEqual(projectResolvedArgs(baseArgs()));
    expect(signal.open_projection_preview).toBe(computation.preview);
  });

  it('omits args_preview for oversized payloads while keeping action hashes', async () => {
    const args = baseArgs({
      note: 'x'.repeat(BATCH_ARGS_PREVIEW_MAX_BYTES + 100),
    });
    const expectedHashes = hashesFor(args);
    expect(
      new TextEncoder().encode(JSON.stringify(projectResolvedArgs(args))).length,
    ).toBeGreaterThan(BATCH_ARGS_PREVIEW_MAX_BYTES);
    const { ctx } = makeHarness();
    const manifest = manifestFor(operation('write'));

    const signal = await expectPreflightRequired(run(ctx, manifest, { args }));

    expect(signal.arg_shape_hash).toBe(expectedHashes.arg_shape_hash);
    expect(signal.canonical_payload_hash).toBe(expectedHashes.canonical_payload_hash);
    expect(signal.args_preview).toBeUndefined();
  });

  it('does not attempt a batch claim when the resumed dispatch re-evaluates to admit', async () => {
    const {
      sessionGrants,
      match,
      consume,
      mint,
      claimBatchMember,
    } = makeGrantHooks({ claimBatchMember: () => true });
    const { ctx, ingredientExecutor } = makeHarness({ catalogSessionGrants: sessionGrants });
    // D-209 Slice B — a READ op re-evaluates to admit (floor `never`, admits at
    // any ceiling) with no batch machinery. (Pre-D-209 this used a write op with
    // approval:never to force an admit; the floor clamp now holds such a write, so
    // `read` is the honest "re-evaluates to admit" case under the contracted source.)
    const manifest = manifestFor(operation('read'));

    await expect(run(ctx, manifest, { stepMeta: batchResumeMeta() }))
      .resolves.toEqual({ ok: true });

    expect(claimBatchMember).not.toHaveBeenCalled();
    expect(match).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(ingredientExecutor).toHaveBeenCalledTimes(1);
  });
});
