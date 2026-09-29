/** D-177 catalog batch/open handler wiring tests. */

import {
  hashForeachCheckpointSource,
  type Checkpoint,
  type ExecutionSource,
  type IngredientManifest,
  type OpenProjection,
  type RecipeDefinition,
  type RecipeStep,
} from '@recued/contracts';
import type {
  CatalogGrantCall,
  CatalogGrantMintCall,
  ExecutionContext,
  ExecutionResult,
} from '@recued/engine';
import {
  ALLOW_SESSION_ASK_OPTION,
  type PreflightNotifier,
} from '@recued/gateway';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
  type CommitStore,
} from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeRecipeMock = vi.hoisted(() => vi.fn());

vi.mock('@recued/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/engine')>();
  return {
    ...actual,
    executeRecipe: executeRecipeMock,
  };
});

import {
  _testing as executeHandlerTesting,
  handleExecute,
  type ExecuteHandlerDeps,
} from '../execute-handler.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import type {
  BatchApprovalCoordinator,
  RegisterHoldResult,
} from '../batch-approval.js';
import type { SessionGrantResolver } from '../session-grant-resolver.js';

const TOOL_SLUG = 'mail.send';
const STEP_ID = 'gated_step';
const CATALOG_SLUG = 'pub/catalog';
const CATALOG_OPERATION_ID = 'pub/catalog.send';
const CONNECTION = 'gmail-primary';

const chatSource: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
  turn_id: 'turn-1',
};

const buildManifest = (
  overrides: Partial<IngredientManifest> = {},
): IngredientManifest =>
  ({
    slug: TOOL_SLUG,
    name: 'Mail Send',
    description: 'Write-tier fixture for D-177 catalog tests.',
    author: 'test',
    kind: 'http',
    category: 'action',
    risk_tier: 'write',
    version: 1,
    input: {
      method: 'POST',
      url: 'https://example.test/send',
    },
    output: { ok: 'ok' },
    ...overrides,
  }) as IngredientManifest;

const buildCatalogManifest = (
  overrides: Partial<IngredientManifest> = {},
): IngredientManifest =>
  ({
    slug: CATALOG_SLUG,
    name: 'Catalog Mail',
    description: 'Catalog-form fixture for D-177 catalog tests.',
    author: 'test',
    kind: 'connection',
    category: 'action',
    risk_tier: 'read',
    version: 1,
    input: {},
    output: {},
    operations: {
      [CATALOG_OPERATION_ID]: {
        operation_id: CATALOG_OPERATION_ID,
        risk_tier: 'write',
        groups: ['send'],
        authority_args: ['recipient'],
      },
    },
    surfaces: {
      api: {
        transport: 'rest',
        default_base_url: 'https://api.example.test',
        auth: { kind: 'none' },
        executes: {},
      },
    },
    ...overrides,
  }) as IngredientManifest;

const buildRecipe = (
  recipe_id = 'd-177-catalog-batch-open',
): RecipeDefinition =>
  ({
    recipe_id,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipe_id,
      description: 'Minimal recipe fixture for D-177 catalog tests.',
      author: 'test',
      supported_platforms: ['test'],
      tags: ['test', 'session-grant'],
    },
    variables: {},
    prefetch_steps: [],
    steps: [
      {
        id: STEP_ID,
        ingredient: TOOL_SLUG,
        input: { body: { message: 'requires approval' } },
      } as unknown as RecipeStep,
    ],
    output: { sidebar: [] },
  }) as RecipeDefinition;

const successResult = (recipe_id: string): ExecutionResult => ({
  recipe_id,
  recipe_hash: `hash-${recipe_id}`,
  success: true,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 12,
  validation_issues: [],
});

const pausedResult = (
  recipe_id: string,
  awaitingOverrides: Partial<NonNullable<ExecutionResult['awaiting_approval']>> = {},
): ExecutionResult => ({
  recipe_id,
  recipe_hash: `hash-${recipe_id}`,
  success: false,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 7,
  validation_issues: [],
  awaiting_approval: {
    gated_step_id: STEP_ID,
    step_state: { prepared: true },
    tool_slug: TOOL_SLUG,
    risk_tier: 'write',
    reason: 'write tier requires approval',
    authorization_provenance: { pre_lift_approval: 'ask' },
    ...awaitingOverrides,
  },
});

const catalogHold = (
  overrides: Partial<NonNullable<ExecutionResult['awaiting_approval']>> = {},
): Partial<NonNullable<ExecutionResult['awaiting_approval']>> => ({
  tool_slug: CATALOG_OPERATION_ID,
  ingredient_slug: CATALOG_SLUG,
  operation_id: CATALOG_OPERATION_ID,
  connection_name: CONNECTION,
  risk_tier: 'write',
  reason: 'approve catalog write',
  arg_shape_hash: 'arg-shape-1',
  canonical_payload_hash: 'payload-1',
  args_preview: { recipient: 'a@b.c', note: 'x' },
  ...overrides,
});

const commitStore = (): CommitStore & {
  writePending: ReturnType<typeof vi.fn>;
  recordOutcome: ReturnType<typeof vi.fn>;
} => ({
  writePending: vi.fn().mockResolvedValue(undefined),
  recordOutcome: vi.fn().mockResolvedValue(undefined),
}) as unknown as CommitStore & {
  writePending: ReturnType<typeof vi.fn>;
  recordOutcome: ReturnType<typeof vi.fn>;
};

const checkpointStore = (): CheckpointStore & {
  written: Map<string, Checkpoint>;
  write: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} => {
  const written = new Map<string, Checkpoint>();
  const store = {
    written,
    write: vi.fn(async (cp: Checkpoint) => {
      written.set(cp.checkpoint_id, cp);
    }),
    get: vi.fn(async (checkpoint_id: string) => written.get(checkpoint_id) ?? null),
    listByRun: vi.fn(async (run_id: string) =>
      [...written.values()].filter((cp) => cp.run_id === run_id),
    ),
    setArgOverrides: vi.fn().mockImplementation(async (checkpoint_id: string, patch) => {
      const existing = written.get(checkpoint_id);
      if (!existing) throw new Error(`checkpoint ${checkpoint_id} not found`);
      const patched = { ...existing, ...patch };
      written.set(checkpoint_id, patched);
      return patched;
    }),
    delete: vi.fn(async (checkpoint_id: string) => {
      written.delete(checkpoint_id);
    }),
    list: vi.fn(async () => [...written.values()]),
    size: vi.fn(async () => written.size),
  };
  return store as unknown as CheckpointStore & typeof store;
};

const notifier = (): PreflightNotifier & {
  ask: ReturnType<typeof vi.fn>;
  registerAskHandler: ReturnType<typeof vi.fn>;
} => ({
  ask: vi.fn().mockResolvedValue({ ask_id: 'ask-test-1' }),
  registerAskHandler: vi.fn(),
}) as unknown as PreflightNotifier & {
  ask: ReturnType<typeof vi.fn>;
  registerAskHandler: ReturnType<typeof vi.fn>;
};

const auditLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const latestAuditEntry = async (log: AuditLogStore): Promise<AuditEntry> => {
  const [entry] = await log.listRecent(10);
  if (!entry) throw new Error('missing audit entry');
  return entry;
};

type FakeSessionGrantResolver = SessionGrantResolver & {
  match: ReturnType<typeof vi.fn<SessionGrantResolver['match']>>;
  consume: ReturnType<typeof vi.fn<SessionGrantResolver['consume']>>;
  claimBatchMember: ReturnType<typeof vi.fn<SessionGrantResolver['claimBatchMember']>>;
  mintBatch: ReturnType<typeof vi.fn<SessionGrantResolver['mintBatch']>>;
  mintRawOp: ReturnType<typeof vi.fn<SessionGrantResolver['mintRawOp']>>;
  mint: ReturnType<typeof vi.fn<SessionGrantResolver['mint']>>;
};

const fakeSessionGrantResolver = (): FakeSessionGrantResolver => ({
  match: vi.fn<SessionGrantResolver['match']>(() => null),
  consume: vi.fn<SessionGrantResolver['consume']>(() => true),
  claimBatchMember: vi.fn<SessionGrantResolver['claimBatchMember']>(() => false),
  mintBatch: vi.fn<SessionGrantResolver['mintBatch']>(() => 'batch-grant-1'),
  mintRawOp: vi.fn<SessionGrantResolver['mintRawOp']>(() => undefined),
  mint: vi.fn<SessionGrantResolver['mint']>(() => undefined),
});

type FakeBatchApprovals = BatchApprovalCoordinator & {
  registerHold: ReturnType<typeof vi.fn<BatchApprovalCoordinator['registerHold']>>;
};

const fakeBatchApprovals = (
  result: RegisterHoldResult = {
    kind: 'registered',
    ask_id: 'batch-ask-1',
    approval_ref: 'batch-1',
  },
): FakeBatchApprovals => ({
  registerHold: vi.fn<BatchApprovalCoordinator['registerHold']>(
    async () => result,
  ),
  reconcileOpenBatch: vi.fn<BatchApprovalCoordinator['reconcileOpenBatch']>(
    async () => ({ kind: 'not_open' as const }),
  ),
  hooks: {
    handleAnswer: vi.fn(async () => 'handled' as const),
  },
});

const makeDeps = (
  recipe: RecipeDefinition,
  overrides: Partial<ExecuteHandlerDeps> = {},
  manifests: readonly IngredientManifest[] = [buildManifest()],
): ExecuteHandlerDeps => {
  const registry: ManifestRegistry = createManifestRegistry('/nonexistent');
  for (const manifest of manifests) registry.register(manifest);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  return {
    recipeStore,
    executorConfig: { manifests: registry },
    baseVault: {},
    instanceId: 'server-test-1',
    commitStore: commitStore(),
    ...overrides,
  };
};

const runAndCaptureEngineContext = async (
  recipe: RecipeDefinition,
  opts: {
    deps?: Partial<ExecuteHandlerDeps>;
    manifests?: readonly IngredientManifest[];
  } = {},
): Promise<ExecutionContext> => {
  executeRecipeMock.mockResolvedValueOnce(successResult(recipe.recipe_id));

  await handleExecute(
    makeDeps(recipe, opts.deps, opts.manifests),
    {
      recipe_id: recipe.recipe_id,
      trigger_source: 'manual',
      execution_source: chatSource,
    },
  );

  expect(executeRecipeMock).toHaveBeenCalledTimes(1);
  return executeRecipeMock.mock.calls[0]![0] as ExecutionContext;
};

beforeEach(() => {
  executeRecipeMock.mockReset();
  executeHandlerTesting.correlationTracker.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleExecute D-177 catalog session-grant closures', () => {
  it('forwards open match and mint fields with run-level identity', async () => {
    const resolver = fakeSessionGrantResolver();
    resolver.match.mockReturnValue('open-grant-1');
    const recipe = buildRecipe('catalog-closure-open-fields');
    const ctx = await runAndCaptureEngineContext(recipe, {
      deps: { sessionGrantResolver: resolver },
    });
    const openProjection: OpenProjection = {
      version: 1,
      args: [{ path: 'recipient', skeleton: 'a@b.c', roots: [] }],
    };
    const matchCall: CatalogGrantCall = {
      ingredient_slug: CATALOG_SLUG,
      operation_id: CATALOG_OPERATION_ID,
      connection_name: CONNECTION,
      risk_tier: 'write',
      pre_lift_approval: 'ask',
      arg_shape_hash: 'arg-shape-1',
      canonical_payload_hash: 'payload-1',
      open_pinned_projection_hash: 'h_open',
    };

    expect(ctx.catalogSessionGrants?.match(matchCall)).toBe('open-grant-1');
    expect(resolver.match).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'chat',
      actor: 'user_self',
      channel_session_id: 'chat:chat-1',
      ingredient_slug: CATALOG_SLUG,
      operation_id: CATALOG_OPERATION_ID,
      connection_name: CONNECTION,
      recipe_id: recipe.recipe_id,
      recipe_hash: expect.any(String),
      risk_tier: 'write',
      arg_shape_hash: 'arg-shape-1',
      canonical_payload_hash: 'payload-1',
      open_pinned_projection_hash: 'h_open',
    }));

    const mintCall: CatalogGrantMintCall = {
      ...matchCall,
      ttl_ms: 60_000,
      max_uses: 3,
      grant_mode: 'open',
      pinned_projection_hash: 'h_open',
      open_projection: openProjection,
    };
    ctx.catalogSessionGrants?.mint(mintCall);

    expect(resolver.mint).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'chat',
      actor: 'user_self',
      channel_session_id: 'chat:chat-1',
      ingredient_slug: CATALOG_SLUG,
      operation_id: CATALOG_OPERATION_ID,
      connection_name: CONNECTION,
      recipe_id: recipe.recipe_id,
      recipe_hash: expect.any(String),
      risk_tier: 'write',
      arg_shape_hash: 'arg-shape-1',
      canonical_payload_hash: 'payload-1',
      ttl_ms: 60_000,
      max_uses: 3,
      approved_action_ref: expect.any(String),
      grant_mode: 'open',
      pinned_projection_hash: 'h_open',
      open_projection: openProjection,
    }));
  });

  it('memoizes successful catalog batch-member claims by contract and member', async () => {
    const resolver = fakeSessionGrantResolver();
    resolver.claimBatchMember.mockReturnValue(true);
    const recipe = buildRecipe('catalog-claim-memo-true');
    const ctx = await runAndCaptureEngineContext(recipe, {
      deps: { sessionGrantResolver: resolver },
    });
    const claimCall = { arg_shape_hash: 'shape-1', canonical_payload_hash: 'payload-1' };

    expect(ctx.catalogSessionGrants?.claimBatchMember?.('batch-1', 'm1', claimCall))
      .toBe(true);
    expect(ctx.catalogSessionGrants?.claimBatchMember?.('batch-1', 'm1', {
      arg_shape_hash: 'shape-2',
      canonical_payload_hash: 'payload-2',
    })).toBe(true);

    expect(resolver.claimBatchMember).toHaveBeenCalledTimes(1);
    expect(resolver.claimBatchMember).toHaveBeenCalledWith('batch-1', 'm1', claimCall);
  });

  it('does not memoize failed catalog batch-member claims', async () => {
    const resolver = fakeSessionGrantResolver();
    resolver.claimBatchMember.mockReturnValue(false);
    const recipe = buildRecipe('catalog-claim-memo-false');
    const ctx = await runAndCaptureEngineContext(recipe, {
      deps: { sessionGrantResolver: resolver },
    });
    const claimCall = { arg_shape_hash: 'shape-1', canonical_payload_hash: 'payload-1' };

    expect(ctx.catalogSessionGrants?.claimBatchMember?.('batch-1', 'm1', claimCall))
      .toBe(false);
    expect(ctx.catalogSessionGrants?.claimBatchMember?.('batch-1', 'm1', claimCall))
      .toBe(false);

    expect(resolver.claimBatchMember).toHaveBeenCalledTimes(2);
  });

  it('resolves catalog open projections for ops that declare authority_args', async () => {
    const resolver = fakeSessionGrantResolver();
    const recipe = buildRecipe('catalog-open-projection-host-walk');
    const ctx = await runAndCaptureEngineContext(recipe, {
      deps: { sessionGrantResolver: resolver },
      manifests: [buildManifest(), buildCatalogManifest()],
    });

    const result = ctx.catalogSessionGrants?.resolveOpenProjection?.({
      ingredient_slug: CATALOG_SLUG,
      operation_id: CATALOG_OPERATION_ID,
      args: { recipient: 'a@b.c', note: 'x' },
    });

    expect(result?.pinned_projection_hash).toEqual(expect.any(String));
    expect(result?.projection).toMatchObject({
      version: 1,
      args: [
        {
          path: 'recipient',
          skeleton: 'a@b.c',
          roots: [],
        },
      ],
    });
    expect(result?.preview.pinned).toEqual([
      { label: 'recipient', value: '"a@b.c"' },
    ]);
  });

  it('returns undefined for catalog open walks without op opt-in or without a known slug', async () => {
    const resolver = fakeSessionGrantResolver();
    const noAuthorityCatalog = buildCatalogManifest({
      operations: {
        [CATALOG_OPERATION_ID]: {
          operation_id: CATALOG_OPERATION_ID,
          risk_tier: 'write',
          groups: ['send'],
        },
      },
    });
    const recipe = buildRecipe('catalog-open-projection-refusals');
    const ctx = await runAndCaptureEngineContext(recipe, {
      deps: { sessionGrantResolver: resolver },
      manifests: [buildManifest(), noAuthorityCatalog],
    });

    expect(ctx.catalogSessionGrants?.resolveOpenProjection?.({
      ingredient_slug: CATALOG_SLUG,
      operation_id: CATALOG_OPERATION_ID,
      args: { recipient: 'a@b.c' },
    })).toBeUndefined();
    expect(ctx.catalogSessionGrants?.resolveOpenProjection?.({
      ingredient_slug: 'missing/catalog',
      operation_id: CATALOG_OPERATION_ID,
      args: { recipient: 'a@b.c' },
    })).toBeUndefined();
  });
});

describe('handleExecute — a held foreach raises its own ask, listing every call', () => {
  /** Found live: a foreach mail-out held on its first recipient was registered
   *  as a ONE-member batch, so the ask named that recipient alone — and the
   *  approval then ran the whole list (the engine approves "the remaining
   *  same-target aggregate"). A batch member is one call; this hold is several. */
  it('does not batch a hold that covers a foreach\'s remaining items, and lists them all', async () => {
    const people = [{ email: 'a@b.c' }, { email: 'd@e.f' }, { email: 'g@h.i' }];
    const recipe = {
      ...buildRecipe('catalog-foreach-cover'),
      steps: [{
        id: STEP_ID,
        ingredient: CATALOG_SLUG,
        connection: CONNECTION,
        foreach: '{{context.people}}',
        input: { operation: CATALOG_OPERATION_ID, args: { recipient: '{{item.email}}', note: 'x' } },
      } as unknown as RecipeStep],
    } as RecipeDefinition;
    const checkpoints = checkpointStore();
    const notes = notifier();
    const batchApprovals = fakeBatchApprovals();
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id, catalogHold({
      args_preview: { recipient: 'a@b.c', note: 'x' },
      foreach_progress: {
        step_id: STEP_ID,
        next_index: 0,
        source_length: people.length,
        source_hash: hashForeachCheckpointSource(people),
        results: [],
      },
    })));

    await handleExecute(
      makeDeps(recipe, {
        auditLog: auditLog(),
        checkpointStore: checkpoints,
        preflightNotifier: notes,
        sessionGrantResolver: fakeSessionGrantResolver(),
        batchApprovals,
      }, [buildManifest(), buildCatalogManifest()]),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'manual',
        execution_source: chatSource,
        context: { people },
      },
    );

    expect(batchApprovals.registerHold).not.toHaveBeenCalled();
    expect(notes.ask).toHaveBeenCalledTimes(1);
    const [message] = notes.ask.mock.calls[0]!;
    for (const email of ['a@b.c', 'd@e.f', 'g@h.i']) expect(message.text).toContain(email);
    expect(message.text.trimEnd().endsWith('Approve all 3?')).toBe(true);
    const [written] = [...checkpoints.written.values()];
    expect(written?.preflight_context?.foreach_cover?.total).toBe(3);
  });
});

describe('handleExecute D-177 catalog hold offer site', () => {
  it('registers catalog holds with the batch coordinator and uses the returned ask id', async () => {
    const recipe = buildRecipe('catalog-batch-offer-site');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const notes = notifier();
    const resolver = fakeSessionGrantResolver();
    const batchApprovals = fakeBatchApprovals();
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id, catalogHold()));

    await handleExecute(
      makeDeps(recipe, {
        auditLog: log,
        checkpointStore: checkpoints,
        preflightNotifier: notes,
        sessionGrantResolver: resolver,
        batchApprovals,
      }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'manual',
        execution_source: chatSource,
      },
    );

    expect(batchApprovals.registerHold).toHaveBeenCalledTimes(1);
    expect(batchApprovals.registerHold).toHaveBeenCalledWith(expect.objectContaining({
      source: chatSource,
      run_id: expect.any(String),
      correlation_id: expect.any(String),
      channel_session_id: 'chat:chat-1',
      ingredient_slug: CATALOG_SLUG,
      operation_id: CATALOG_OPERATION_ID,
      connection_name: CONNECTION,
      risk_tier: 'write',
      recipe_id: recipe.recipe_id,
      recipe_hash: `hash-${recipe.recipe_id}`,
      arg_shape_hash: 'arg-shape-1',
      canonical_payload_hash: 'payload-1',
      args_preview: { recipient: 'a@b.c', note: 'x' },
      session_grant_offer: {
        ttl_ms: 3_600_000,
        max_uses: 5,
        risk_tier: 'write',
      },
    }));
    expect(notes.ask).not.toHaveBeenCalled();
    expect((await latestAuditEntry(log)).ask_id).toBe('batch-ask-1');
  });

  it('falls back to the per-hold ask when no batch coordinator is wired', async () => {
    const recipe = buildRecipe('catalog-no-batch-fallback');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const notes = notifier();
    const resolver = fakeSessionGrantResolver();
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id, catalogHold()));

    await handleExecute(
      makeDeps(recipe, {
        auditLog: log,
        checkpointStore: checkpoints,
        preflightNotifier: notes,
        sessionGrantResolver: resolver,
      }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'manual',
        execution_source: chatSource,
      },
    );

    expect(notes.ask).toHaveBeenCalledTimes(1);
    const [, options, handler] = notes.ask.mock.calls[0]!;
    expect(options.map((option: { id: string }) => option.id)).toEqual([
      'approve',
      'allow_session',
      'deny',
    ]);
    expect(options[1]).toBe(ALLOW_SESSION_ASK_OPTION);
    expect(handler.payload).toMatchObject({
      recipe_id: recipe.recipe_id,
      gated_step_id: STEP_ID,
      tool_slug: CATALOG_OPERATION_ID,
      risk_tier: 'write',
      session_grant: {
        ttl_ms: 3_600_000,
        max_uses: 5,
        risk_tier: 'write',
      },
    });
    expect(handler.payload).not.toHaveProperty('batch');
  });

  it('upgrades a catalog fallback ask to an open session-grant offer when the hold carries an open preview', async () => {
    const recipe = buildRecipe('catalog-open-fallback-offer');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const notes = notifier();
    const resolver = fakeSessionGrantResolver();
    const openPreview = {
      pinned: [{ label: 'recipient', value: '"a@b.c"' }],
      varying: [],
    };
    executeRecipeMock.mockResolvedValueOnce(
      pausedResult(recipe.recipe_id, catalogHold({ open_projection_preview: openPreview })),
    );

    await handleExecute(
      makeDeps(recipe, {
        auditLog: log,
        checkpointStore: checkpoints,
        preflightNotifier: notes,
        sessionGrantResolver: resolver,
      }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'manual',
        execution_source: chatSource,
      },
    );

    expect(notes.ask).toHaveBeenCalledTimes(1);
    const [message, options, handler] = notes.ask.mock.calls[0]!;
    expect(options.map((option: { id: string }) => option.id)).toEqual([
      'approve',
      'allow_session',
      'deny',
    ]);
    expect(handler.payload).toMatchObject({
      session_grant: {
        ttl_ms: 3_600_000,
        max_uses: 5,
        risk_tier: 'write',
        grant_mode: 'open',
      },
    });
    expect(message.text).toContain("'Allow this session' auto-approves");
    expect(message.text).toContain('pinned  recipient = "a@b.c"');
  });
});
